import * as nodeFs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { PGlite } from '@electric-sql/pglite'
import type { Results } from '@electric-sql/pglite'
import type { FilesystemQueryHooks } from '@electric-sql/pglite/basefs'
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
import {
  createDurablePrimary,
  type DurablePrimary,
} from '../src/primary/durable-primary.js'
import type { CommitSummary } from '../src/primary/durable-primary-fs.js'
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
      await durablePrimaryExec(
        primary,
        'CREATE TABLE native_no_restart (id int primary key, value text)',
      )
      await durablePrimaryQuery(
        primary,
        "INSERT INTO native_no_restart VALUES (1, 'one')",
      )

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
      expect(replica).toBeInstanceOf(PGlite)
      expect(hasPGliteNativeInvalidation(replica)).toBe(true)

      const insert = await durablePrimaryQuery(
        primary,
        "INSERT INTO native_no_restart VALUES (2, 'two')",
      )
      const manifest = pageServer.store.getCommit(
        'native-no-restart-demo',
        insert.commit!.lsn,
      )
      expect(manifest?.replicaApplyMode).toBe('live-invalidate')

      const originalReplica = replica

      await replica.durable.catchUpOnce()
      const rows = await replica.query<{ id: number; value: string }>(
        'SELECT id, value FROM native_no_restart ORDER BY id',
      )

      expect(rows.rows).toEqual([
        { id: 1, value: 'one' },
        { id: 2, value: 'two' },
      ])
      expect(replica.durable.appliedLsn).toBe(insert.commit?.lsn)
      expect(replica).toBe(originalReplica)
      expect(replica.closed).toBe(false)
    } finally {
      await replica?.close()
      await primary?.close()
    }
  })

  it('blocks live apply and invalidation while a replica query is active', async () => {
    const pageServer = createPageServer({ rootDir: pageServerDir })
    const fetch = honoFetch(pageServer.app)
    const invalidator = {
      invalidate: vi.fn<() => void>(),
    }
    let primary: Awaited<ReturnType<typeof createDurablePrimary>> | undefined
    let replica: DurableReplica | undefined

    try {
      primary = await createDurablePrimary({
        dataDir: path.join(rootDir, 'active-query-primary'),
        timelineId: 'active-query-demo',
        pageServerUrl: 'http://pages.local',
        streamUrl: `${started!.url}/timelines/active-query-demo`,
        producerId: 'primary-active-query',
        fetch,
      })
      await durablePrimaryExec(
        primary,
        'CREATE TABLE active_query (id int primary key, value text)',
      )
      await durablePrimaryQuery(
        primary,
        "INSERT INTO active_query VALUES (1, 'one')",
      )

      replica = await createDurableReplica({
        dataDir: path.join(rootDir, 'active-query-replica'),
        timelineId: 'active-query-demo',
        pageServerUrl: 'http://pages.local',
        streamUrl: `${started!.url}/timelines/active-query-demo`,
        producerId: 'replica-active-query',
        fetch,
        pageServerRootDir: pageServerDir,
        invalidator,
        autoCatchUp: true,
      })
      const initialLsn = replica.durable.appliedLsn
      const hold = holdReplicaQuery(replica, 'active_query')
      const activeQuery = replica.query<{ count: number }>(
        'SELECT count(*)::int AS count FROM active_query',
      )
      await hold.entered

      const insert = await durablePrimaryQuery(
        primary,
        "INSERT INTO active_query VALUES (2, 'two')",
      )
      const catchUp = replica.durable.catchUpOnce()

      await waitFor(() => replica!.durable.tailer.journal.readPending())
      expect(replica.durable.appliedLsn).toBe(initialLsn)
      expect(invalidator.invalidate).not.toHaveBeenCalled()
      expect(await settlesWithin(catchUp, 20)).toBe(false)

      hold.release()
      await activeQuery
      await catchUp

      expect(invalidator.invalidate).toHaveBeenCalledTimes(1)
      expect(replica.durable.appliedLsn).toBe(insert.commit?.lsn)
      expect(replica.durable.tailer.journal.readPending()).toBeUndefined()
    } finally {
      await replica?.close()
      await primary?.close()
    }
  })

  it('fails closed when native invalidation disappears after opening a replica', async () => {
    const pageServer = createPageServer({ rootDir: pageServerDir })
    const fetch = honoFetch(pageServer.app)
    let primary: Awaited<ReturnType<typeof createDurablePrimary>> | undefined
    let replica: DurableReplica | undefined

    try {
      primary = await createDurablePrimary({
        dataDir: path.join(rootDir, 'missing-native-primary'),
        timelineId: 'missing-native-demo',
        pageServerUrl: 'http://pages.local',
        streamUrl: `${started!.url}/timelines/missing-native-demo`,
        producerId: 'primary-missing-native',
        fetch,
      })
      await durablePrimaryExec(
        primary,
        'CREATE TABLE missing_native (id int primary key, value text)',
      )
      await durablePrimaryQuery(
        primary,
        "INSERT INTO missing_native VALUES (1, 'one')",
      )

      replica = await createDurableReplica({
        dataDir: path.join(rootDir, 'missing-native-replica'),
        timelineId: 'missing-native-demo',
        pageServerUrl: 'http://pages.local',
        streamUrl: `${started!.url}/timelines/missing-native-demo`,
        producerId: 'replica-missing-native',
        fetch,
        pageServerRootDir: pageServerDir,
        autoCatchUp: true,
      })
      expect(hasPGliteNativeInvalidation(replica)).toBe(true)
      const initialLsn = replica.durable.appliedLsn
      const nativeModule =
        replica.Module as unknown as NativeInvalidationRuntime
      const originalInvalidate = nativeModule._pgl_invalidate_remote_pages
      nativeModule._pgl_invalidate_remote_pages = undefined
      try {
        expect(hasPGliteNativeInvalidation(replica)).toBe(false)
        const insert = await durablePrimaryQuery(
          primary,
          "INSERT INTO missing_native VALUES (2, 'two')",
        )

        await expect(replica.durable.catchUpOnce()).rejects.toThrow(
          `Native PGlite invalidation hook is unavailable for commit ${insert.commit?.lsn}`,
        )
        expect(replica.durable.appliedLsn).toBe(initialLsn)
        expect(replica.durable.tailer.journal.readPending()).toBeDefined()
      } finally {
        nativeModule._pgl_invalidate_remote_pages = originalInvalidate
      }
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
      await durablePrimaryExec(
        primary,
        'CREATE TABLE e2e_test (id int primary key, value text)',
      )
      const insert = await durablePrimaryQuery<{ value: string }>(
        primary,
        "INSERT INTO e2e_test VALUES (1, 'one') RETURNING value",
      )
      expect(insert.result.rows).toEqual([{ value: 'one' }])

      const streamRead = await primary.durable.timeline.readCommitEvents({
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
      )
      expect(direct.rows).toEqual([{ id: 1, value: 'one' }])

      const secondInsert = await durablePrimaryQuery<{ value: string }>(
        primary,
        "INSERT INTO e2e_test VALUES (2, 'two') RETURNING value",
      )
      await replica.durable.catchUpOnce()

      const afterLiveApply = await replica.query<{ id: number; value: string }>(
        'SELECT id, value FROM e2e_test ORDER BY id',
      )
      expect(afterLiveApply.rows).toEqual([
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

  it('does not advance visible replica LSN for live DDL that requires a restart', async () => {
    const pageServer = createPageServer({ rootDir: pageServerDir })
    const fetch = honoFetch(pageServer.app)
    let primary: Awaited<ReturnType<typeof createDurablePrimary>> | undefined
    let replica: DurableReplica | undefined

    try {
      primary = await createDurablePrimary({
        dataDir: path.join(rootDir, 'live-ddl-primary'),
        timelineId: 'live-ddl-demo',
        pageServerUrl: 'http://pages.local',
        streamUrl: `${started!.url}/timelines/live-ddl-demo`,
        producerId: 'primary-live-ddl',
        fetch,
      })
      await durablePrimaryExec(
        primary,
        'CREATE TABLE live_ddl_seed (id int primary key, value text)',
      )
      await durablePrimaryQuery(
        primary,
        "INSERT INTO live_ddl_seed VALUES (1, 'one')",
      )

      replica = await createDurableReplica({
        dataDir: path.join(rootDir, 'live-ddl-replica'),
        timelineId: 'live-ddl-demo',
        pageServerUrl: 'http://pages.local',
        streamUrl: `${started!.url}/timelines/live-ddl-demo`,
        producerId: 'replica-live-ddl',
        fetch,
        pageServerRootDir: pageServerDir,
        autoCatchUp: true,
      })
      const initialLsn = replica.durable.appliedLsn
      const ddl = await durablePrimaryExec(primary, 'TRUNCATE live_ddl_seed')
      const manifest = pageServer.store.getCommit(
        'live-ddl-demo',
        ddl.commit!.lsn,
      )

      expect(manifest?.replicaApplyMode).toBe('restart-replica')
      await expect(replica.durable.catchUpOnce()).rejects.toThrow(
        'requires restartReplica callback',
      )
      expect(replica.durable.appliedLsn).toBe(initialLsn)
      expect(replica.durable.tailer.journal.readPending()).toBeDefined()

      const rows = await replica.query<{ id: number; value: string }>(
        'SELECT id, value FROM live_ddl_seed ORDER BY id',
      )
      expect(rows.rows).toEqual([{ id: 1, value: 'one' }])
    } finally {
      await replica?.close()
      await primary?.close()
    }
  })
})

async function durablePrimaryQuery<T = { [key: string]: unknown }>(
  primary: DurablePrimary,
  sql: string,
  params?: unknown[],
): Promise<{ result: Results<T>; commit?: CommitSummary }> {
  const before = primary.durable.commitSerial
  const result = await primary.query<T>(sql, params)
  return {
    result,
    commit: primary.durable.commitAfter(before),
  }
}

async function durablePrimaryExec(
  primary: DurablePrimary,
  sql: string,
): Promise<{ result: Results[]; commit?: CommitSummary }> {
  const before = primary.durable.commitSerial
  const result = await primary.exec(sql)
  return {
    result,
    commit: primary.durable.commitAfter(before),
  }
}

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

interface HeldReplicaQuery {
  entered: Promise<void>
  release: () => void
}

function holdReplicaQuery(
  replica: DurableReplica,
  sqlFragment: string,
): HeldReplicaQuery {
  const previous = replica.durable.fs.queryHooks
  let enteredResolve: () => void = () => undefined
  const entered = new Promise<void>((resolve) => {
    enteredResolve = resolve
  })
  let release: () => void = () => undefined
  const released = new Promise<void>((resolve) => {
    release = resolve
  })
  let held = false

  replica.durable.fs.queryHooks = composeQueryHook(
    previous,
    async () => {
      if (!held) {
        held = true
        enteredResolve()
        await released
      }
    },
    sqlFragment,
  )

  return { entered, release }
}

function composeQueryHook(
  previous: FilesystemQueryHooks | undefined,
  beforeOperation: () => Promise<void>,
  sqlFragment: string,
): FilesystemQueryHooks {
  return {
    aroundQuery: async (context, operation) => {
      const next = async () => {
        if (context.sql?.includes(sqlFragment)) {
          await beforeOperation()
        }
        return await operation()
      }
      if (previous?.aroundQuery) {
        return await previous.aroundQuery(context, next)
      }
      return await next()
    },
  }
}

async function waitFor<T>(
  read: () => T | undefined,
  timeoutMs = 1_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = read()
    if (value !== undefined) return value
    if (Date.now() > deadline) {
      throw new Error('Timed out waiting for test condition')
    }
    await delay(5)
  }
}

async function settlesWithin(
  promise: Promise<unknown>,
  timeoutMs: number,
): Promise<boolean> {
  return await Promise.race([
    promise.then(
      () => true,
      () => true,
    ),
    delay(timeoutMs).then(() => false),
  ])
}

async function delay(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms))
}

interface NativeInvalidationRuntime {
  _pgl_invalidate_remote_pages?: (
    rangesPtr: number,
    rangesLength: number,
    invalidateSystemCaches: boolean,
    invalidateSmgr: boolean,
    remoteNextXidLow: number,
    remoteNextXidHigh: number,
  ) => number
}
