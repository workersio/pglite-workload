import * as nodeFs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  DurableTimeline,
  commitEventFromManifest,
} from '../src/durable/timeline-stream.js'
import { startDurableStreamTestServer } from '../src/durable/durable-server.js'
import { createPageServer } from '../src/pageserver/app.js'
import { PageServerHttpClient } from '../src/pageserver/client.js'
import { DiskCommitStore } from '../src/pageserver/commit-store.js'
import type {
  CommitManifest,
  CommitRequest,
  ReplicaApplyMode,
} from '../src/pageserver/types.js'
import { sha256Bytes, sha256Json } from '../src/shared/hash.js'
import { PAGE_SIZE } from '../src/shared/constants.js'
import { LazyReplicaFS } from '../src/replica/lazy-replica-fs.js'
import {
  CountingPageResolver,
  DiskPageResolver,
} from '../src/replica/page-resolver.js'
import { ReplicaApplyJournal } from '../src/replica/apply-journal.js'
import { ReplicaTailer } from '../src/replica/tailer.js'

const RELATION_PATH = '/base/5/16384'

describe('durable replica phase 5', () => {
  let rootDir: string
  let pageServerDir: string
  let streamDir: string
  let started:
    | Awaited<ReturnType<typeof startDurableStreamTestServer>>
    | undefined

  beforeEach(async () => {
    rootDir = nodeFs.mkdtempSync(path.join(os.tmpdir(), 'pglite-replica-'))
    pageServerDir = nodeFs.mkdtempSync(path.join(os.tmpdir(), 'pglite-pages-'))
    streamDir = nodeFs.mkdtempSync(path.join(os.tmpdir(), 'pglite-stream-'))
    started = await startDurableStreamTestServer({
      port: 0,
      dataDir: streamDir,
    })
  })

  afterEach(async () => {
    await started?.stop()
    nodeFs.rmSync(rootDir, { recursive: true, force: true })
    nodeFs.rmSync(pageServerDir, { recursive: true, force: true })
    nodeFs.rmSync(streamDir, { recursive: true, force: true })
  })

  it('loads relation pages lazily and invalidates cached pages on apply', () => {
    const store = new DiskCommitStore(pageServerDir)
    const first = commitPage(store, {
      timelineId: 'lazy-demo',
      lsn: '0/00000010',
      fill: 1,
    })
    const second = commitPage(store, {
      timelineId: 'lazy-demo',
      lsn: '0/00000020',
      previousLsn: first.lsn,
      fill: 2,
    })
    const resolver = new CountingPageResolver(new DiskPageResolver(store))
    const replicaFs = new LazyReplicaFS(path.join(rootDir, 'pgdata'), {
      timelineId: 'lazy-demo',
      resolver,
    })

    replicaFs.applyManifest(first)
    expect(replicaFs.lstat(RELATION_PATH).size).toBe(PAGE_SIZE)
    expect(resolver.pageFetches).toBe(0)

    const fd = replicaFs.open(RELATION_PATH, 'r')
    const buffer = new Uint8Array(PAGE_SIZE)
    expect(replicaFs.read(fd, buffer, 0, PAGE_SIZE, 0)).toBe(PAGE_SIZE)
    expect(buffer[0]).toBe(1)
    expect(resolver.pageFetches).toBe(1)

    expect(replicaFs.read(fd, buffer, 0, PAGE_SIZE, 0)).toBe(PAGE_SIZE)
    expect(resolver.pageFetches).toBe(1)

    replicaFs.applyManifest(second)
    expect(replicaFs.read(fd, buffer, 0, PAGE_SIZE, 0)).toBe(PAGE_SIZE)
    expect(buffer[0]).toBe(2)
    expect(resolver.pageFetches).toBe(2)
    replicaFs.close(fd)
  })

  it('tails commit events, updates indexes without fetching bytes, and waits for LSN', async () => {
    const pageServer = createPageServer({ rootDir: pageServerDir })
    const client = new PageServerHttpClient({
      baseUrl: 'http://pages.local',
      fetch: honoFetch(pageServer.app),
    })
    const timeline = await DurableTimeline.create({
      streamUrl: `${started!.url}/timelines/tail-demo`,
      producerId: 'replica-test',
    })
    const manifest = commitPage(pageServer.store, {
      timelineId: 'tail-demo',
      lsn: '0/00000010',
      fill: 3,
    })
    await timeline.appendCommitEvent(
      commitEventFromManifest(manifest, {
        manifestUrl: client.commitUrl(manifest.timelineId, manifest.lsn),
        manifestHash: sha256Json(manifest),
      }),
    )

    const resolver = new CountingPageResolver(
      new DiskPageResolver(pageServer.store),
    )
    const replicaFs = new LazyReplicaFS(path.join(rootDir, 'tail-pgdata'), {
      timelineId: 'tail-demo',
      resolver,
    })
    const tailer = new ReplicaTailer({
      fs: replicaFs,
      timeline,
      pageServer: client,
      journal: new ReplicaApplyJournal(path.join(rootDir, 'tail-journal')),
    })
    const wait = tailer.waitForLsn(manifest.lsn)

    await tailer.catchUpOnce()
    await wait

    expect(replicaFs.appliedLsn).toBe(manifest.lsn)
    expect(resolver.pageFetches).toBe(0)

    const fd = replicaFs.open(RELATION_PATH, 'r')
    const buffer = new Uint8Array(PAGE_SIZE)
    replicaFs.read(fd, buffer, 0, PAGE_SIZE, 0)
    expect(buffer[0]).toBe(3)
    expect(resolver.pageFetches).toBe(1)
    replicaFs.close(fd)
  })

  it('replays pending apply journal idempotently after invalidation failure', async () => {
    const pageServer = createPageServer({ rootDir: pageServerDir })
    const client = new PageServerHttpClient({
      baseUrl: 'http://pages.local',
      fetch: honoFetch(pageServer.app),
    })
    const timeline = await DurableTimeline.create({
      streamUrl: `${started!.url}/timelines/retry-apply-demo`,
      producerId: 'replica-test',
    })
    const manifest = commitPage(pageServer.store, {
      timelineId: 'retry-apply-demo',
      lsn: '0/00000010',
      fill: 4,
    })
    await timeline.appendCommitEvent(
      commitEventFromManifest(manifest, {
        manifestUrl: client.commitUrl(manifest.timelineId, manifest.lsn),
        manifestHash: sha256Json(manifest),
      }),
    )

    const replicaFs = new LazyReplicaFS(path.join(rootDir, 'retry-pgdata'), {
      timelineId: 'retry-apply-demo',
      resolver: new DiskPageResolver(pageServer.store),
    })
    const journal = new ReplicaApplyJournal(path.join(rootDir, 'retry-journal'))
    const invalidator = {
      invalidate: vi.fn<() => void>(() => {
        throw new Error('synthetic invalidation failure')
      }),
    }
    const tailer = new ReplicaTailer({
      fs: replicaFs,
      timeline,
      pageServer: client,
      journal,
      invalidator,
    })

    await expect(tailer.catchUpOnce()).rejects.toThrow(
      'synthetic invalidation failure',
    )
    expect(journal.readPending()).toBeDefined()
    expect(replicaFs.appliedLsn).toBeUndefined()

    invalidator.invalidate.mockImplementation(() => undefined)
    await tailer.catchUpOnce()

    expect(replicaFs.appliedLsn).toBe(manifest.lsn)
    expect(journal.readPending()).toBeUndefined()
    expect(invalidator.invalidate).toHaveBeenCalledTimes(2)
  })

  it('uses the restart callback for restart-replica commits', async () => {
    const pageServer = createPageServer({ rootDir: pageServerDir })
    const client = new PageServerHttpClient({
      baseUrl: 'http://pages.local',
      fetch: honoFetch(pageServer.app),
    })
    const timeline = await DurableTimeline.create({
      streamUrl: `${started!.url}/timelines/restart-demo`,
      producerId: 'replica-test',
    })
    const manifest = commitPage(pageServer.store, {
      timelineId: 'restart-demo',
      lsn: '0/00000010',
      fill: 5,
      replicaApplyMode: 'restart-replica',
    })
    await timeline.appendCommitEvent(
      commitEventFromManifest(manifest, {
        manifestUrl: client.commitUrl(manifest.timelineId, manifest.lsn),
        manifestHash: sha256Json(manifest),
      }),
    )

    const restartReplica = vi.fn()
    const replicaFs = new LazyReplicaFS(path.join(rootDir, 'restart-pgdata'), {
      timelineId: 'restart-demo',
      resolver: new DiskPageResolver(pageServer.store),
    })
    const tailer = new ReplicaTailer({
      fs: replicaFs,
      timeline,
      pageServer: client,
      journal: new ReplicaApplyJournal(path.join(rootDir, 'restart-journal')),
      restartReplica,
    })

    await tailer.catchUpOnce()

    expect(restartReplica).toHaveBeenCalledWith(manifest)
    expect(replicaFs.appliedLsn).toBe(manifest.lsn)
  })
})

function commitPage(
  store: DiskCommitStore,
  {
    timelineId,
    lsn,
    previousLsn,
    fill,
    replicaApplyMode = 'live-invalidate',
  }: {
    timelineId: string
    lsn: string
    previousLsn?: string
    fill: number
    replicaApplyMode?: ReplicaApplyMode
  },
): CommitManifest {
  const bytes = new Uint8Array(PAGE_SIZE).fill(fill)
  const sha256 = sha256Bytes(bytes)
  const manifest: CommitManifest = {
    version: 1,
    timelineId,
    lsn,
    previousLsn,
    commitId: `commit-${lsn.replace('/', '-')}`,
    createdAt: new Date().toISOString(),
    replicaApplyMode,
    operations: [
      {
        type: 'page',
        path: RELATION_PATH,
        pageNo: 0,
        pageSize: PAGE_SIZE,
        fileSize: PAGE_SIZE,
        sha256,
        byteLength: PAGE_SIZE,
        invalidation: {
          kind: 'relation-range',
          path: RELATION_PATH,
          spcOid: 1663,
          dbOid: 5,
          relNumber: 16384,
          fork: 'main',
          firstBlock: 0,
          blockCount: 1,
          relationSizeChanged: false,
        },
      },
    ],
    invalidations: [
      {
        kind: 'relation-range',
        path: RELATION_PATH,
        spcOid: 1663,
        dbOid: 5,
        relNumber: 16384,
        fork: 'main',
        firstBlock: 0,
        blockCount: 1,
        relationSizeChanged: false,
      },
    ],
    stats: {
      pageCount: 1,
      fileCount: 0,
      metadataCount: 0,
      invalidationCount: 1,
      byteCount: PAGE_SIZE,
    },
  }
  const request: CommitRequest = {
    manifest,
    objects: [
      {
        sha256,
        bytesBase64: Buffer.from(bytes).toString('base64'),
      },
    ],
  }
  store.commit(request)
  return manifest
}

function honoFetch(
  app: ReturnType<typeof createPageServer>['app'],
): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    return await app.request(`${url.pathname}${url.search}`, {
      method: request.method,
      headers: request.headers,
      body: init?.body,
    })
  }
}
