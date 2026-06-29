import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { DurableTimeline } from '../src/durable/timeline-stream.js'
import { startDurableStreamTestServer } from '../src/durable/durable-server.js'
import { createPageServer } from '../src/pageserver/app.js'
import {
  PageServerHttpClient,
  type PageServerApi,
} from '../src/pageserver/client.js'
import type { CommitRequest, CommitResult } from '../src/pageserver/types.js'
import { createPrimaryApp } from '../src/primary/app.js'
import {
  DurablePrimary,
  createDurablePrimary,
} from '../src/primary/durable-primary.js'
import { DurablePrimaryFS } from '../src/primary/durable-primary-fs.js'
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

    const create = await primary.exec(
      'CREATE TABLE test (id int primary key, value text)',
    )
    const insert = await primary.query<{ value: string }>(
      "INSERT INTO test VALUES (1, 'one') RETURNING value",
    )

    expect(create.commit).toBeDefined()
    expect(insert.result.rows).toEqual([{ value: 'one' }])
    expect(insert.commit).toMatchObject({
      timelineId: 'demo',
      previousLsn: create.commit?.lsn,
    })
    expect(pageServer.store.getHead('demo')?.lsn).toBe(insert.commit?.lsn)

    const streamRead = await primary.timeline.readCommitEvents({ offset: '-1' })
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
    await primary.exec('CREATE TABLE tx_test (id int primary key)')

    const tx = await primary.transaction(async (transaction) => {
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
    await primary.exec('CREATE TABLE api_test (value text)')
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
    fs.mkdir('/base/5', { recursive: true })
    fs.writeFile('/base/5/16384', new Uint8Array(PAGE_SIZE).fill(7))

    pageServer.failNext = true
    await expect(fs.syncToFs()).rejects.toThrow('synthetic commit failure')
    expect(fs.journal.readPending()).toBeDefined()

    await fs.syncToFs()

    expect(fs.journal.readPending()).toBeUndefined()
    expect(fs.lastCommit).toMatchObject({
      timelineId: 'retry-demo',
      pageCount: 1,
    })
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
})

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
