import * as nodeFs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  DurableTimeline,
  commitEventFromManifest,
} from '../src/durable/timeline-stream.js'
import { startDurableStreamTestServer } from '../src/durable/durable-server.js'
import { isDurableTimelinePath } from '../src/fs/path-classifier.js'
import { createPageServer } from '../src/pageserver/app.js'
import { PageServerHttpClient } from '../src/pageserver/client.js'
import { DiskCommitStore } from '../src/pageserver/commit-store.js'
import { createDurablePrimary } from '../src/primary/durable-primary.js'
import { createReplicaApp } from '../src/replica/app.js'
import {
  createDurableReplica,
  type DurableReplica,
} from '../src/replica/durable-replica.js'
import { hasPGliteNativeInvalidation } from '../src/replica/native-invalidator.js'
import type {
  CommitManifest,
  CommitOperation,
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

  it('resolves exact page versions without relying on a stale store index', () => {
    const store = new DiskCommitStore(pageServerDir)
    const first = commitPage(store, {
      timelineId: 'resolver-demo',
      lsn: '0/00000010',
      fill: 1,
    })
    const resolver = new DiskPageResolver(pageServerDir)

    const firstPage = first.operations.find(
      (operation) => operation.type === 'page',
    )
    if (!firstPage || firstPage.type !== 'page') {
      throw new Error('Expected first page operation')
    }
    expect(
      resolver.getPageBytes({
        timelineId: first.timelineId,
        lsn: first.lsn,
        path: firstPage.path,
        pageNo: firstPage.pageNo,
        pageSize: firstPage.pageSize,
        sha256: firstPage.sha256,
        byteLength: firstPage.byteLength,
        fileSize: firstPage.fileSize,
      })?.[0],
    ).toBe(1)

    const second = commitPage(store, {
      timelineId: 'resolver-demo',
      lsn: '0/00000020',
      previousLsn: first.lsn,
      fill: 2,
    })
    const secondPage = second.operations.find(
      (operation) => operation.type === 'page',
    )
    if (!secondPage || secondPage.type !== 'page') {
      throw new Error('Expected second page operation')
    }

    expect(
      resolver.getPageBytes({
        timelineId: second.timelineId,
        lsn: second.lsn,
        path: secondPage.path,
        pageNo: secondPage.pageNo,
        pageSize: secondPage.pageSize,
        sha256: secondPage.sha256,
        byteLength: secondPage.byteLength,
        fileSize: secondPage.fileSize,
      })?.[0],
    ).toBe(2)
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

  it('rejects restart-replica commits without a restart callback during live apply', async () => {
    const pageServer = createPageServer({ rootDir: pageServerDir })
    const client = new PageServerHttpClient({
      baseUrl: 'http://pages.local',
      fetch: honoFetch(pageServer.app),
    })
    const timeline = await DurableTimeline.create({
      streamUrl: `${started!.url}/timelines/restart-missing-demo`,
      producerId: 'replica-test',
    })
    const manifest = commitPage(pageServer.store, {
      timelineId: 'restart-missing-demo',
      lsn: '0/00000010',
      fill: 6,
      replicaApplyMode: 'restart-replica',
    })
    await timeline.appendCommitEvent(
      commitEventFromManifest(manifest, {
        manifestUrl: client.commitUrl(manifest.timelineId, manifest.lsn),
        manifestHash: sha256Json(manifest),
      }),
    )

    const replicaFs = new LazyReplicaFS(
      path.join(rootDir, 'restart-missing-pgdata'),
      {
        timelineId: 'restart-missing-demo',
        resolver: new DiskPageResolver(pageServer.store),
      },
    )
    const journal = new ReplicaApplyJournal(
      path.join(rootDir, 'restart-missing-journal'),
    )
    const tailer = new ReplicaTailer({
      fs: replicaFs,
      timeline,
      pageServer: client,
      journal,
    })

    await expect(tailer.catchUpOnce()).rejects.toThrow(
      'requires restartReplica callback',
    )
    expect(replicaFs.appliedLsn).toBeUndefined()
    expect(journal.readPending()).toBeDefined()
  })

  it('keeps the replica open for primary DML commits handled by the native hook', async () => {
    const pageServer = createPageServer({ rootDir: pageServerDir })
    const fetch = honoFetch(pageServer.app)
    let primary: Awaited<ReturnType<typeof createDurablePrimary>> | undefined
    let replica: DurableReplica | undefined

    try {
      primary = await createDurablePrimary({
        dataDir: path.join(rootDir, 'native-no-restart-primary'),
        timelineId: 'native-no-restart-demo',
        pageServerUrl: 'http://pages.local',
        streamUrl: `${started!.url}/timelines/native-no-restart-demo`,
        producerId: 'primary-native-no-restart',
        fetch,
      })
      await primary.exec(
        'CREATE TABLE native_no_restart (id int primary key, value text)',
      )
      await primary.query("INSERT INTO native_no_restart VALUES (1, 'one')")

      replica = await createDurableReplica({
        dataDir: path.join(rootDir, 'native-no-restart-pgdata'),
        timelineId: 'native-no-restart-demo',
        pageServerUrl: 'http://pages.local',
        streamUrl: `${started!.url}/timelines/native-no-restart-demo`,
        producerId: 'replica-native-no-restart',
        fetch,
        pageServerRootDir: pageServerDir,
        autoCatchUp: true,
      })
      expect(hasPGliteNativeInvalidation(replica.db)).toBe(true)

      primary.restartAfterCommit = false
      const insert = await primary.query(
        "INSERT INTO native_no_restart VALUES (2, 'two')",
      )
      const manifest = pageServer.store.getCommit(
        'native-no-restart-demo',
        insert.commit!.lsn,
      )
      expect(manifest?.replicaApplyMode).toBe('live-invalidate')

      const replaceDb = vi.spyOn(replica, 'replaceDb')

      await replica.catchUpOnce()
      const rows = await replica.query<{ id: number; value: string }>(
        'SELECT id, value FROM native_no_restart ORDER BY id',
        undefined,
        { waitForLsn: insert.commit?.lsn },
      )

      expect(rows.result.rows).toEqual([
        { id: 1, value: 'one' },
        { id: 2, value: 'two' },
      ])
      expect(replica.appliedLsn).toBe(insert.commit?.lsn)
      expect(replaceDb).not.toHaveBeenCalled()
    } finally {
      await replica?.close()
      await primary?.close()
    }
  })

  it('rehydrates the lazy page index from completed journal state after restart', async () => {
    const pageServer = createPageServer({ rootDir: pageServerDir })
    const client = new PageServerHttpClient({
      baseUrl: 'http://pages.local',
      fetch: honoFetch(pageServer.app),
    })
    const timeline = await DurableTimeline.create({
      streamUrl: `${started!.url}/timelines/rehydrate-demo`,
      producerId: 'replica-test',
    })
    const first = commitPage(pageServer.store, {
      timelineId: 'rehydrate-demo',
      lsn: '0/00000010',
      fill: 7,
    })
    const second = commitPage(pageServer.store, {
      timelineId: 'rehydrate-demo',
      lsn: '0/00000020',
      previousLsn: first.lsn,
      fill: 8,
    })
    for (const manifest of [first, second]) {
      await timeline.appendCommitEvent(
        commitEventFromManifest(manifest, {
          manifestUrl: client.commitUrl(manifest.timelineId, manifest.lsn),
          manifestHash: sha256Json(manifest),
        }),
      )
    }

    const journalDir = path.join(rootDir, 'rehydrate-journal')
    const originalFs = new LazyReplicaFS(
      path.join(rootDir, 'rehydrate-original-pgdata'),
      {
        timelineId: 'rehydrate-demo',
        resolver: new DiskPageResolver(pageServer.store),
      },
    )
    const originalTailer = new ReplicaTailer({
      fs: originalFs,
      timeline,
      pageServer: client,
      journal: new ReplicaApplyJournal(journalDir),
    })
    await originalTailer.catchUpOnce()
    expect(originalFs.appliedLsn).toBe(second.lsn)

    const restoredFs = new LazyReplicaFS(
      path.join(rootDir, 'rehydrate-restored-pgdata'),
      {
        timelineId: 'rehydrate-demo',
        resolver: new DiskPageResolver(pageServer.store),
      },
    )
    const restoredTailer = new ReplicaTailer({
      fs: restoredFs,
      timeline,
      pageServer: client,
      journal: new ReplicaApplyJournal(journalDir),
    })

    await restoredTailer.catchUpOnce()
    await restoredTailer.waitForLsn(second.lsn)

    expect(restoredFs.appliedLsn).toBe(second.lsn)
    const fd = restoredFs.open(RELATION_PATH, 'r')
    const buffer = new Uint8Array(PAGE_SIZE)
    restoredFs.read(fd, buffer, 0, PAGE_SIZE, 0)
    expect(buffer[0]).toBe(8)
    restoredFs.close(fd)
  })

  it('boots a durable replica lazily and serves queries through the replica app', async () => {
    const pageServer = createPageServer({ rootDir: pageServerDir })
    const fetch = honoFetch(pageServer.app)
    let primary: Awaited<ReturnType<typeof createDurablePrimary>> | undefined
    let replica: DurableReplica | undefined

    try {
      primary = await createDurablePrimary({
        dataDir: path.join(rootDir, 'e2e-primary'),
        timelineId: 'e2e-demo',
        pageServerUrl: 'http://pages.local',
        streamUrl: `${started!.url}/timelines/e2e-demo`,
        producerId: 'primary-e2e',
        fetch,
      })
      await primary.exec(
        'CREATE TABLE e2e_test (id int primary key, value text)',
      )
      const insert = await primary.query<{ value: string }>(
        "INSERT INTO e2e_test VALUES (1, 'one') RETURNING value",
      )

      const streamRead = await primary.timeline.readCommitEvents({
        offset: '-1',
      })
      const manifests = streamRead.events.map((event) =>
        pageServer.store.getCommit(event.timelineId, event.lsn),
      )
      expect(manifests.some((manifest) => manifest === undefined)).toBe(false)
      expect(
        manifests.flatMap(
          (manifest) =>
            manifest?.operations.flatMap((operation) =>
              nonDurableOperationPaths(operation),
            ) ?? [],
        ),
      ).toEqual([])

      replica = await createDurableReplica({
        dataDir: path.join(rootDir, 'e2e-replica'),
        timelineId: 'e2e-demo',
        pageServerUrl: 'http://pages.local',
        streamUrl: `${started!.url}/timelines/e2e-demo`,
        producerId: 'replica-e2e',
        fetch,
        pageServerRootDir: pageServerDir,
        autoCatchUp: true,
      })

      const direct = await replica.query<{ id: number; value: string }>(
        'SELECT id, value FROM e2e_test ORDER BY id',
        undefined,
        { waitForLsn: insert.commit?.lsn },
      )
      expect(direct.result.rows).toEqual([{ id: 1, value: 'one' }])

      const secondInsert = await primary.query<{ value: string }>(
        "INSERT INTO e2e_test VALUES (2, 'two') RETURNING value",
      )
      await replica.catchUpOnce()

      const afterLiveApply = await replica.query<{ id: number; value: string }>(
        'SELECT id, value FROM e2e_test ORDER BY id',
        undefined,
        { waitForLsn: secondInsert.commit?.lsn },
      )
      expect(afterLiveApply.result.rows).toEqual([
        { id: 1, value: 'one' },
        { id: 2, value: 'two' },
      ])

      const app = createReplicaApp({ replica })
      const response = await app.request('/v1/replica/query', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          sql: 'SELECT value FROM e2e_test WHERE id = $1',
          params: [2],
          waitForLsn: secondInsert.commit?.lsn,
        }),
      })
      const body = (await response.json()) as {
        result: { rows: Array<{ value: string }> }
      }

      expect(response.status).toBe(200)
      expect(body.result.rows).toEqual([{ value: 'two' }])
    } finally {
      await replica?.close()
      await primary?.close()
    }
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

function nonDurableOperationPaths(operation: CommitOperation): string[] {
  if (operation.type === 'rename') {
    return [operation.from, operation.to].filter(
      (filePath) => !isDurableTimelinePath(filePath),
    )
  }
  if ('path' in operation && !isDurableTimelinePath(operation.path)) {
    return [operation.path]
  }
  return []
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
