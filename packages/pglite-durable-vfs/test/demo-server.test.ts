import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createDurableVfsDemo, type DurableVfsDemo } from '../src/demo/app.js'

describe('phase 6 demo server', () => {
  let rootDir: string
  let demo: DurableVfsDemo | undefined

  beforeEach(() => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pglite-demo-'))
  })

  afterEach(async () => {
    await demo?.close()
    demo = undefined
    fs.rmSync(rootDir, { recursive: true, force: true })
  })

  it('exposes the scripted demo APIs for live replica, pause/resume, and time travel', async () => {
    demo = await createDurableVfsDemo({
      rootDir,
      insertIntervalMs: 50,
      autoStartWrites: false,
      cleanupRoot: false,
    })

    const health = await requestJson<{ ok: boolean }>('/health')
    const initialStatus = await requestJson<DemoStatus>('/v1/status')
    const seedLsn = initialStatus.lastInsertLsn
    expect(health.ok).toBe(true)
    expect(seedLsn).toBeDefined()
    expect(initialStatus.rows).toEqual({ primary: 1, replica: 1 })
    expect(initialStatus.replica.cache).toMatchObject({
      pageFetches: expect.any(Number),
      fileFetches: expect.any(Number),
      cacheHits: expect.any(Number),
      invalidations: expect.any(Number),
    })

    const manual = await postJson<InsertResponse>('/v1/insert', {
      payload: 'phase6-manual',
    })
    const rowsAfterManual = await requestJson<RowsResponse>('/v1/rows?limit=5')
    expect(rowsAfterManual.rows.map((row) => row.payload)).toContain(
      'phase6-manual',
    )
    expect(manual.commitLsn).toBeDefined()

    const paused = await postJson<ReplicaPauseResponse>(
      '/v1/replicas/replica-1/pause',
    )
    expect(paused.paused).toBe(true)

    const pausedInsert = await postJson<PrimaryQueryResponse>(
      '/v1/primary/query',
      {
        sql: 'INSERT INTO demo_events (payload) VALUES ($1) RETURNING id::text, payload',
        params: ['phase6-paused'],
      },
    )
    const staleReplica = await postJson<ReplicaQueryResponse>(
      '/v1/replicas/replica-1/query',
      {
        sql: 'SELECT payload FROM demo_events ORDER BY id',
      },
    )
    expect(staleReplica.result.rows.map((row) => row.payload)).not.toContain(
      'phase6-paused',
    )

    const resumed = await postJson<ReplicaPauseResponse>(
      '/v1/replicas/replica-1/resume',
    )
    expect(resumed.paused).toBe(false)
    const pausedLsn = pausedInsert.commit?.lsn
    expect(pausedLsn).toBeDefined()
    const pausedStatus = await requestJson<DemoStatus>('/v1/status')
    expect(pausedStatus.latestPrimaryCommitLsn).toBe(pausedLsn)
    expect(pausedStatus.insertCount).toBe(3)
    const rowsAfterResume = await requestJson<RowsResponse>('/v1/rows?limit=5')
    expect(rowsAfterResume.rows.map((row) => row.payload)).toContain(
      'phase6-paused',
    )
    await postJson('/v1/replicas/replica-1/wait-for-lsn', { lsn: pausedLsn })
    const caughtUpReplica = await postJson<ReplicaQueryResponse>(
      '/v1/replicas/replica-1/query',
      {
        sql: 'SELECT payload FROM demo_events ORDER BY id',
      },
    )
    expect(caughtUpReplica.result.rows.map((row) => row.payload)).toContain(
      'phase6-paused',
    )

    const timeTravel = await postJson<RowsResponse>(
      '/v1/timelines/demo/materialize',
      {
        lsn: seedLsn,
        limit: 20,
      },
    )
    expect(timeTravel.rows.map((row) => row.payload)).toEqual(['seed'])

    await postJson('/v1/demo/start-writes')
    await waitFor(async () => {
      const status = await requestJson<DemoStatus>('/v1/status')
      return status.rows.primary > 3
    })
    const stopped = await postJson<{ writesActive: boolean }>(
      '/v1/demo/stop-writes',
    )
    expect(stopped.writesActive).toBe(false)
  })

  it('bounds replica wait requests instead of hanging', async () => {
    demo = await createDurableVfsDemo({
      rootDir,
      autoStartWrites: false,
      cleanupRoot: false,
    })

    await postJson('/v1/replicas/replica-1/pause')
    const pausedWait = await rawPostJson(
      '/v1/replicas/replica-1/wait-for-lsn',
      {
        lsn: 'F/FFFFFFFF',
        timeoutMs: 10,
      },
    )
    expect(pausedWait.status).toBe(409)

    await postJson('/v1/replicas/replica-1/resume')
    const timedOutWait = await rawPostJson(
      '/v1/replicas/replica-1/wait-for-lsn',
      {
        lsn: 'F/FFFFFFFF',
        timeoutMs: 10,
      },
    )
    expect(timedOutWait.status).toBe(504)
  })

  it('rejects future time-travel LSNs', async () => {
    demo = await createDurableVfsDemo({
      rootDir,
      autoStartWrites: false,
      cleanupRoot: false,
    })

    const response = await rawPostJson('/v1/timelines/demo/materialize', {
      lsn: 'F/FFFFFFFF',
      limit: 5,
    })
    expect(response.status).toBe(400)
  })

  it('normalizes invalid insert intervals', async () => {
    demo = await createDurableVfsDemo({
      rootDir,
      insertIntervalMs: Number.NaN,
      autoStartWrites: false,
      cleanupRoot: false,
    })

    const status = await requestJson<DemoStatus>('/v1/status')
    expect(status.writes.intervalMs).toBe(2000)
  })

  async function requestJson<T>(pathName: string): Promise<T> {
    if (!demo) throw new Error('Demo not initialized')
    const response = await demo.app.request(pathName)
    expect(response.status).toBe(200)
    return (await response.json()) as T
  }

  async function postJson<T = unknown>(
    pathName: string,
    body?: unknown,
  ): Promise<T> {
    const response = await rawPostJson(pathName, body)
    expect(response.status).toBe(200)
    return (await response.json()) as T
  }

  async function rawPostJson(
    pathName: string,
    body?: unknown,
  ): Promise<Response> {
    if (!demo) throw new Error('Demo not initialized')
    return await demo.app.request(pathName, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  }
})

async function waitFor(
  predicate: () => Promise<boolean>,
  timeoutMs = 5000,
): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('Timed out waiting for predicate')
}

interface DemoStatus {
  lastInsertLsn?: string
  latestPrimaryCommitLsn?: string
  insertCount: number
  writes: {
    intervalMs: number
  }
  replica: {
    cache: {
      pageFetches: number
      fileFetches: number
      cacheHits: number
      invalidations: number
    }
  }
  rows: {
    primary: number
    replica: number
  }
}

interface InsertResponse {
  commitLsn?: string
}

interface PrimaryQueryResponse {
  commit?: {
    lsn: string
  }
}

interface ReplicaPauseResponse {
  paused: boolean
}

interface ReplicaQueryResponse {
  result: {
    rows: Array<{ payload: string }>
  }
}

interface RowsResponse {
  rows: Array<{ payload: string }>
}
