import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { DiskCommitStore } from '../src/pageserver/commit-store.js'
import { DiskObjectStore } from '../src/pageserver/object-store.js'
import type {
  CommitManifest,
  FileImageOperation,
  PageImageOperation,
} from '../src/pageserver/types.js'
import { encodeLsn } from '../src/pageserver/disk-utils.js'

describe('DiskObjectStore', () => {
  let rootDir: string

  beforeEach(() => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pglite-objects-'))
  })

  afterEach(() => {
    fs.rmSync(rootDir, { recursive: true, force: true })
  })

  it('deduplicates objects by SHA-256', () => {
    const store = new DiskObjectStore(rootDir)
    const first = store.putBytes(new Uint8Array([1, 2, 3]))
    const second = store.putBytes(new Uint8Array([1, 2, 3]))

    expect(second.sha256).toBe(first.sha256)
    expect(second.path).toBe(first.path)
    expect(store.getBytes(first.sha256)).toEqual(new Uint8Array([1, 2, 3]))
  })
})

describe('DiskCommitStore', () => {
  let rootDir: string
  let store: DiskCommitStore

  beforeEach(() => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pglite-commits-'))
    store = new DiskCommitStore(rootDir)
  })

  afterEach(() => {
    fs.rmSync(rootDir, { recursive: true, force: true })
  })

  it('round trips commits and page lookup at LSN', () => {
    const firstPage = store.objectStore.putBytes(new Uint8Array([1]))
    const secondPage = store.objectStore.putBytes(new Uint8Array([2]))

    store.commit({
      manifest: manifest({
        lsn: '0/00000010',
        page: pageOperation(firstPage.sha256, firstPage.byteLength),
      }),
    })
    store.commit({
      manifest: manifest({
        lsn: '0/00000020',
        previousLsn: '0/00000010',
        commitId: 'commit-2',
        page: pageOperation(secondPage.sha256, secondPage.byteLength),
      }),
    })

    expect(
      store.getPageBytes('demo', '/base/5/16384', 0, '0/00000010'),
    ).toEqual(new Uint8Array([1]))
    expect(
      store.getPageBytes('demo', '/base/5/16384', 0, '0/00000030'),
    ).toEqual(new Uint8Array([2]))
    expect(store.getPageBytes('demo', '/base/5/16384', 1, '0/00000030')).toBe(
      undefined,
    )
  })

  it('round trips whole-file lookup at LSN', () => {
    const object = store.objectStore.putBytes(new Uint8Array([9, 8, 7]))
    const file: FileImageOperation = {
      type: 'file',
      path: '/global/pg_control',
      fileSize: 3,
      sha256: object.sha256,
      byteLength: object.byteLength,
    }

    store.commit({
      manifest: manifest({
        lsn: '0/00000010',
        file,
      }),
    })

    expect(
      store.getFileBytes('demo', '/global/pg_control', '0/00000010'),
    ).toEqual(new Uint8Array([9, 8, 7]))
  })

  it('promotes commits atomically and writes rebuildable indexes', () => {
    const object = store.objectStore.putBytes(new Uint8Array([1]))

    const result = store.commit({
      manifest: manifest({
        lsn: '0/00000010',
        page: pageOperation(object.sha256, object.byteLength),
      }),
    })

    const timelineDir = path.join(
      rootDir,
      'timelines',
      Buffer.from('demo').toString('base64url'),
    )
    expect(result.status).toBe('created')
    expect(
      fs.existsSync(
        path.join(timelineDir, 'commits', `${encodeLsn('0/00000010')}.json`),
      ),
    ).toBe(true)
    expect(fs.readdirSync(path.join(timelineDir, 'page-index'))).toHaveLength(1)
    expect(fs.existsSync(path.join(timelineDir, 'staging', 'commit-1'))).toBe(
      false,
    )
    expect(store.getHead('demo')).toMatchObject({
      timelineId: 'demo',
      lsn: '0/00000010',
      commitId: 'commit-1',
    })
  })

  it('rebuilds page indexes from commit manifests', () => {
    const object = store.objectStore.putBytes(new Uint8Array([1]))
    store.commit({
      manifest: manifest({
        lsn: '0/00000010',
        page: pageOperation(object.sha256, object.byteLength),
      }),
    })

    const timelineDir = path.join(
      rootDir,
      'timelines',
      Buffer.from('demo').toString('base64url'),
    )
    fs.rmSync(path.join(timelineDir, 'page-index'), {
      recursive: true,
      force: true,
    })

    const restartedStore = new DiskCommitStore(rootDir)
    expect(
      restartedStore.getPageBytes('demo', '/base/5/16384', 0, '0/00000020'),
    ).toEqual(new Uint8Array([1]))
  })

  it('is idempotent by commit id and manifest hash', () => {
    const object = store.objectStore.putBytes(new Uint8Array([1]))
    const request = {
      manifest: manifest({
        lsn: '0/00000010',
        page: pageOperation(object.sha256, object.byteLength),
      }),
    }

    expect(store.commit(request).status).toBe('created')
    expect(store.commit(request).status).toBe('replayed')
  })

  it('rejects the same LSN with different content', () => {
    const first = store.objectStore.putBytes(new Uint8Array([1]))
    const second = store.objectStore.putBytes(new Uint8Array([2]))

    store.commit({
      manifest: manifest({
        lsn: '0/00000010',
        page: pageOperation(first.sha256, first.byteLength),
      }),
    })

    expect(() =>
      store.commit({
        manifest: manifest({
          lsn: '0/00000010',
          commitId: 'different',
          page: pageOperation(second.sha256, second.byteLength),
        }),
      }),
    ).toThrow(/Commit conflict/)
  })
})

function manifest({
  lsn,
  previousLsn,
  commitId = 'commit-1',
  page,
  file,
}: {
  lsn: string
  previousLsn?: string
  commitId?: string
  page?: PageImageOperation
  file?: FileImageOperation
}): CommitManifest {
  const operations = [page, file].filter(
    (operation): operation is PageImageOperation | FileImageOperation =>
      operation !== undefined,
  )

  return {
    version: 1,
    timelineId: 'demo',
    lsn,
    previousLsn,
    commitId,
    createdAt: '2026-01-01T00:00:00.000Z',
    replicaApplyMode: 'live-invalidate',
    operations,
    invalidations: [],
    stats: {
      pageCount: page ? 1 : 0,
      fileCount: file ? 1 : 0,
      metadataCount: 0,
      invalidationCount: 0,
      byteCount: operations.reduce(
        (total, operation) => total + operation.byteLength,
        0,
      ),
    },
  }
}

function pageOperation(sha256: string, byteLength: number): PageImageOperation {
  return {
    type: 'page',
    path: '/base/5/16384',
    pageNo: 0,
    pageSize: 8192,
    fileSize: 8192,
    sha256,
    byteLength,
  }
}
