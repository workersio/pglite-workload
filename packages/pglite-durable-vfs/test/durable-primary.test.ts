import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { PGlite } from '@electric-sql/pglite'
import type { Results, Transaction } from '@electric-sql/pglite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { DurableTimeline } from '../src/durable/timeline-stream.js'
import { startDurableStreamTestServer } from '../src/durable/durable-server.js'
import { createPageServer } from '../src/pageserver/app.js'
import {
  PageServerHttpClient,
  type PageServerApi,
} from '../src/pageserver/client.js'
import type {
  CommitManifest,
  CommitRequest,
  CommitResult,
} from '../src/pageserver/types.js'
import { createPrimaryApp } from '../src/primary/app.js'
import {
  createDurablePrimary,
  type DurablePrimary,
} from '../src/primary/durable-primary.js'
import {
  DurablePrimaryFS,
  type CommitSummary,
} from '../src/primary/durable-primary-fs.js'
import { LazyPrimaryFS } from '../src/primary/lazy-primary-fs.js'
import { ReplicaPageIndex } from '../src/replica/page-index.js'
import { DiskPageResolver } from '../src/replica/page-resolver.js'
import { sha256Json } from '../src/shared/hash.js'
import { PAGE_SIZE } from '../src/shared/constants.js'

describe('DurablePrimary', () => {
  let rootDir: string
  let pageServerDir: string
  let streamDir: string
  let started:
    | Awaited<ReturnType<typeof startDurableStreamTestServer>>
    | undefined
  let primary: DurablePrimary | undefined

  beforeEach(async () => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pglite-primary-'))
    pageServerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pglite-pages-'))
    streamDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pglite-stream-'))
    started = await startDurableStreamTestServer({
      port: 0,
      dataDir: streamDir,
    })
  })

  afterEach(async () => {
    await primary?.close()
    primary = undefined
    await started?.stop()
    fs.rmSync(rootDir, { recursive: true, force: true })
    fs.rmSync(pageServerDir, { recursive: true, force: true })
    fs.rmSync(streamDir, { recursive: true, force: true })
  })

  it('publishes query commits to the page server and durable stream', async () => {
    const pageServer = createPageServer({ rootDir: pageServerDir })
    primary = await createDurablePrimary({
      dataDir: path.join(rootDir, 'pgdata'),
      timelineId: 'demo',
      pageServerUrl: 'http://pages.local',
      streamUrl: `${started!.url}/timelines/demo`,
      producerId: 'primary-test',
      fetch: honoFetch(pageServer.app),
    })

    expect(primary).toBeInstanceOf(PGlite)

    const create = await durableExec(
      primary,
      'CREATE TABLE test (id int primary key, value text)',
    )
    const insert = await durableQuery<{ value: string }>(
      primary,
      "INSERT INTO test VALUES (1, 'one') RETURNING value",
    )

    expect(create.commit).toBeDefined()
    expect(insert.result.rows).toEqual([{ value: 'one' }])
    expect(insert.commit).toMatchObject({
      timelineId: 'demo',
    })
    expect(insert.commit?.previousLsn).toBeDefined()
    expect(insert.commit?.previousLsn).toBe(create.commit?.lsn)
    expect(
      pageServer.store.getCommit('demo', insert.commit!.lsn)
        ?.logicalStatements?.[0]?.sql,
    ).toContain('INSERT INTO test')
    expect(pageServer.store.getHead('demo')?.lsn).toBe(insert.commit?.lsn)

    const streamRead = await primary.durable.timeline.readCommitEvents({
      offset: '-1',
    })
    const event = streamRead.events.find(
      (commit) =>
        commit.commitId === insert.commit?.lsn ||
        commit.lsn === insert.commit?.lsn,
    )
    expect(event).toMatchObject({
      timelineId: 'demo',
      lsn: insert.commit?.lsn,
    })
    expect(event?.manifestHash).toBeDefined()
  })

  it('flushes and publishes transaction commits before returning', async () => {
    const pageServer = createPageServer({ rootDir: pageServerDir })
    primary = await createDurablePrimary({
      dataDir: path.join(rootDir, 'pgdata'),
      timelineId: 'tx-demo',
      pageServerUrl: 'http://pages.local',
      streamUrl: `${started!.url}/timelines/tx-demo`,
      producerId: 'primary-test',
      fetch: honoFetch(pageServer.app),
    })
    await durableExec(primary, 'CREATE TABLE tx_test (id int primary key)')

    const tx = await durableTransaction(primary, async (transaction) => {
      await transaction.query('INSERT INTO tx_test VALUES (1)')
      return 'committed'
    })

    expect(tx).toMatchObject({
      result: 'committed',
      commit: { timelineId: 'tx-demo' },
    })
    expect(pageServer.store.getHead('tx-demo')?.lsn).toBe(tx.commit?.lsn)
  })

  it('exposes primary query and status Hono endpoints', async () => {
    const pageServer = createPageServer({ rootDir: pageServerDir })
    primary = await createDurablePrimary({
      dataDir: path.join(rootDir, 'pgdata'),
      timelineId: 'api-demo',
      pageServerUrl: 'http://pages.local',
      streamUrl: `${started!.url}/timelines/api-demo`,
      producerId: 'primary-test',
      fetch: honoFetch(pageServer.app),
    })
    await durableExec(primary, 'CREATE TABLE api_test (value text)')
    const app = createPrimaryApp({ primary })

    const response = await app.request('/v1/primary/query', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sql: 'INSERT INTO api_test VALUES ($1) RETURNING value',
        params: ['from-api'],
      }),
    })
    const body = (await response.json()) as {
      result: { rows: Array<{ value: string }> }
      commit?: { lsn: string }
    }
    const status = await app.request('/v1/primary/status')

    expect(response.status).toBe(200)
    expect(body.result.rows).toEqual([{ value: 'from-api' }])
    expect(body.commit?.lsn).toBeDefined()
    expect((await status.json()) as { currentLsn?: string }).toMatchObject({
      currentLsn: body.commit?.lsn,
    })
  })

  it('keeps a pending commit journal and retries after publish failure', async () => {
    const timeline = await DurableTimeline.create({
      streamUrl: `${started!.url}/timelines/retry-demo`,
      producerId: 'primary-test',
    })
    const pageServer = new FlakyPageServer()
    const dataDir = path.join(rootDir, 'retry-pgdata')
    const journalDir = path.join(rootDir, 'retry-journal')
    const fs = new DurablePrimaryFS(dataDir, {
      timelineId: 'retry-demo',
      pageServer,
      timeline,
      journalDir,
    })
    fs.setPgWalLsnReader(() => '0/0000002A')
    fs.mkdir('/base/5', { recursive: true })
    fs.writeFile('/base/5/16384', new Uint8Array(PAGE_SIZE).fill(7))

    pageServer.failNext = true
    await expect(fs.syncToFs()).rejects.toThrow('synthetic commit failure')
    expect(fs.journal.readPending()).toBeDefined()

    await fs.syncToFs()

    expect(fs.journal.readPending()).toBeUndefined()
    expect(fs.lastCommit).toMatchObject({
      timelineId: 'retry-demo',
      pgWalLsn: '0/0000002A',
      pageCount: 1,
    })
    expect(pageServer.requests.at(-1)?.manifest.pgWalLsn).toBe('0/0000002A')
    expect(pageServer.requests).toHaveLength(2)
  })

  it('retries stream append after page server commit replay', async () => {
    const pageServer = createPageServer({ rootDir: pageServerDir })
    const pageServerClient = new PageServerHttpClient({
      baseUrl: 'http://pages.local',
      fetch: honoFetch(pageServer.app),
    })
    const timeline = await DurableTimeline.create({
      streamUrl: `${started!.url}/timelines/stream-retry-demo`,
      producerId: 'primary-test',
    })
    const fs = new DurablePrimaryFS(path.join(rootDir, 'stream-retry-pgdata'), {
      timelineId: 'stream-retry-demo',
      pageServer: pageServerClient,
      timeline,
      journalDir: path.join(rootDir, 'stream-retry-journal'),
    })
    const originalAppend =
      timeline.appendCommitEventWithProducerState.bind(timeline)
    timeline.appendCommitEventWithProducerState = async () => {
      timeline.appendCommitEventWithProducerState = originalAppend
      throw new Error('synthetic stream failure')
    }

    fs.mkdir('/base/5', { recursive: true })
    fs.writeFile('/base/5/16384', new Uint8Array(PAGE_SIZE).fill(8))

    await expect(fs.syncToFs()).rejects.toThrow('synthetic stream failure')
    expect(pageServer.store.getHead('stream-retry-demo')?.lsn).toBe(
      fs.journal.readPending()?.lsn,
    )
    expect((await timeline.readCommitEvents({ offset: '-1' })).events).toEqual(
      [],
    )

    await fs.syncToFs()

    const streamRead = await timeline.readCommitEvents({ offset: '-1' })
    expect(streamRead.events.map((event) => event.lsn)).toEqual([
      fs.lastCommit?.lsn,
    ])
    expect(fs.journal.readPending()).toBeUndefined()
  })

  it('does not duplicate stream events when completion fails after append', async () => {
    const pageServer = createPageServer({ rootDir: pageServerDir })
    const pageServerClient = new PageServerHttpClient({
      baseUrl: 'http://pages.local',
      fetch: honoFetch(pageServer.app),
    })
    const timeline = await DurableTimeline.create({
      streamUrl: `${started!.url}/timelines/completion-retry-demo`,
      producerId: 'primary-test',
    })
    const fs = new DurablePrimaryFS(
      path.join(rootDir, 'completion-retry-pgdata'),
      {
        timelineId: 'completion-retry-demo',
        pageServer: pageServerClient,
        timeline,
        journalDir: path.join(rootDir, 'completion-retry-journal'),
      },
    )

    fs.mkdir('/base/5', { recursive: true })
    fs.writeFile('/base/5/16384', new Uint8Array(PAGE_SIZE).fill(9))
    await fs.syncToFs()

    const firstLsn = fs.lastCommit?.lsn
    const firstOffset = fs.lastCommit?.durableOffset
    expect(fs.journal.readCompleted()?.append.afterFlush.nextSeq).toBe(1)

    const originalMarkComplete = fs.journal.markComplete.bind(fs.journal)
    fs.journal.markComplete = () => {
      fs.journal.markComplete = originalMarkComplete
      throw new Error('synthetic journal failure')
    }

    fs.writeFile('/base/5/24576', new Uint8Array(PAGE_SIZE).fill(10))

    await expect(fs.syncToFs()).rejects.toThrow('synthetic journal failure')
    const firstRead = await timeline.readCommitEvents({ offset: '-1' })
    expect(firstRead.events).toHaveLength(2)
    expect(fs.journal.readPending()).toBeDefined()

    await fs.syncToFs()
    const secondLsn = fs.lastCommit?.lsn
    expect(fs.lastCommit?.durableOffset).not.toBe(firstOffset)

    fs.writeFile('/base/5/32768', new Uint8Array(PAGE_SIZE).fill(11))
    await fs.syncToFs()

    const streamRead = await timeline.readCommitEvents({ offset: '-1' })
    expect(streamRead.events.map((event) => event.lsn)).toEqual([
      firstLsn,
      secondLsn,
      fs.lastCommit?.lsn,
    ])
    expect(new Set(streamRead.events.map((event) => event.commitId)).size).toBe(
      3,
    )
    expect(fs.journal.readCompleted()?.append.afterFlush.nextSeq).toBe(3)
  })

  it('starts a lazy primary from the latest pageserver head', async () => {
    const pageServer = createPageServer({ rootDir: pageServerDir })
    const fetch = honoFetch(pageServer.app)
    primary = await createDurablePrimary({
      dataDir: path.join(rootDir, 'seed-pgdata'),
      timelineId: 'lazy-primary-demo',
      pageServerUrl: 'http://pages.local',
      streamUrl: `${started!.url}/timelines/lazy-primary-demo`,
      producerId: 'primary-seed',
      fetch,
    })
    await durableExec(
      primary,
      'CREATE TABLE lazy_test (id int primary key, value text)',
    )
    const seed = await durableQuery<{ value: string }>(
      primary,
      "INSERT INTO lazy_test VALUES (1, 'seed') RETURNING value",
    )
    await primary.close()
    primary = undefined

    primary = await createDurablePrimary({
      dataDir: path.join(rootDir, 'lazy-pgdata'),
      timelineId: 'lazy-primary-demo',
      pageServerUrl: 'http://pages.local',
      pageServerRootDir: pageServerDir,
      streamUrl: `${started!.url}/timelines/lazy-primary-demo`,
      producerId: 'primary-lazy',
      fetch,
      fsMode: 'lazy',
    })

    const read = await primary.query<{ value: string }>(
      'SELECT value FROM lazy_test ORDER BY id',
    )
    const beforeInsertLsn = primary.durable.currentLsn
    const inserted = await durableQuery<{ value: string }>(
      primary,
      "INSERT INTO lazy_test VALUES (2, 'lazy') RETURNING value",
    )

    expect(seed.commit?.lsn).toBeDefined()
    expect(read.rows).toEqual([{ value: 'seed' }])
    expect(inserted.result.rows).toEqual([{ value: 'lazy' }])
    expect(inserted.commit?.previousLsn).toBe(beforeInsertLsn)
    expect(pageServer.store.getHead('lazy-primary-demo')?.lsn).toBe(
      inserted.commit?.lsn,
    )
  })

  it('recovers a pending lazy primary overlay before opening PGlite', async () => {
    const pageServer = createPageServer({ rootDir: pageServerDir })
    const pageServerClient = new PageServerHttpClient({
      baseUrl: 'http://pages.local',
      fetch: honoFetch(pageServer.app),
    })
    const timeline = await DurableTimeline.create({
      streamUrl: `${started!.url}/timelines/lazy-retry-demo`,
      producerId: 'lazy-primary-test',
    })
    const head = await pageServerClient.createTimeline('lazy-retry-demo')
    const dataDir = path.join(rootDir, 'lazy-retry-pgdata')
    const journalDir = path.join(rootDir, 'lazy-retry-journal')
    const lazyFs = new LazyPrimaryFS(dataDir, {
      timelineId: 'lazy-retry-demo',
      pageServer: pageServerClient,
      timeline,
      resolver: new DiskPageResolver(pageServer.store),
      index: new ReplicaPageIndex('lazy-retry-demo'),
      head,
      journalDir,
    })
    const originalCommit = pageServerClient.commit.bind(pageServerClient)
    pageServerClient.commit = async (request) => {
      pageServerClient.commit = originalCommit
      throw new Error(
        `synthetic lazy commit failure for ${request.manifest.lsn}`,
      )
    }

    lazyFs.mkdir('/base/5', { recursive: true })
    lazyFs.writeFile('/base/5/16384', new Uint8Array(PAGE_SIZE).fill(12))
    await expect(lazyFs.syncToFs()).rejects.toThrow(
      'synthetic lazy commit failure',
    )
    expect(lazyFs.journal.readPending()).toBeDefined()
    await lazyFs.closeFs()

    const recovered = new LazyPrimaryFS(dataDir, {
      timelineId: 'lazy-retry-demo',
      pageServer: pageServerClient,
      timeline,
      resolver: new DiskPageResolver(pageServer.store),
      index: new ReplicaPageIndex('lazy-retry-demo'),
      head,
      journalDir,
    })
    await recovered.recoverPendingOverlay()
    recovered.resetLocalCache({ materializeVisibleRemoteState: false })

    expect(recovered.journal.readPending()).toBeUndefined()
    expect(recovered.currentLsn).toBeDefined()
    expect(pageServer.store.getHead('lazy-retry-demo')?.lsn).toBe(
      recovered.currentLsn,
    )
    expect(fs.existsSync(path.join(dataDir, 'base/5/16384'))).toBe(false)
    await recovered.closeFs()
  })
})

async function durableQuery<T>(
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

async function durableExec(
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

async function durableTransaction<T>(
  primary: DurablePrimary,
  callback: (transaction: Transaction) => Promise<T>,
): Promise<{ result: T; commit?: CommitSummary }> {
  const before = primary.durable.commitSerial
  const result = await primary.transaction(callback)
  return {
    result,
    commit: primary.durable.commitAfter(before),
  }
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

class FlakyPageServer implements PageServerApi {
  failNext = false

  requests: CommitRequest[] = []

  async createTimeline(timelineId: string) {
    return { timelineId }
  }

  async getHead(_timelineId: string) {
    return undefined
  }

  async getCommit(): Promise<CommitManifest | undefined> {
    throw new Error('getCommit is not implemented for FlakyPageServer')
  }

  async getPageBytes(): Promise<Uint8Array | undefined> {
    throw new Error('getPageBytes is not implemented for FlakyPageServer')
  }

  async getFileBytes(): Promise<Uint8Array | undefined> {
    throw new Error('getFileBytes is not implemented for FlakyPageServer')
  }

  async commit(request: CommitRequest): Promise<CommitResult> {
    this.requests.push(request)
    if (this.failNext) {
      this.failNext = false
      throw new Error('synthetic commit failure')
    }
    const manifestHash = sha256Json(request.manifest)
    return {
      status: this.requests.length === 1 ? 'created' : 'replayed',
      manifestHash,
      head: {
        timelineId: request.manifest.timelineId,
        lsn: request.manifest.lsn,
        commitId: request.manifest.commitId,
        manifestHash,
      },
    }
  }

  commitUrl(timelineId: string, lsn: string): string {
    return `http://pages.local/v1/timelines/${timelineId}/commits/${encodeURIComponent(
      lsn,
    )}`
  }
}
