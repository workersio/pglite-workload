import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { PGlite } from '@electric-sql/pglite'
import { Hono } from 'hono'

import { startDurableStreamTestServer } from '../durable/durable-server.js'
import { createPageServer } from '../pageserver/app.js'
import { createDurablePrimary } from '../primary/durable-primary.js'
import type { DurablePrimary } from '../primary/durable-primary.js'
import type { CommitSummary } from '../primary/durable-primary-fs.js'
import {
  createDurableReplica,
  type DurableReplica,
} from '../replica/durable-replica.js'
import { LazyReplicaFS } from '../replica/lazy-replica-fs.js'
import { DiskPageResolver } from '../replica/page-resolver.js'
import { compareLsn } from '../shared/lsn.js'

export interface DurableVfsDemoOptions {
  timelineId?: string
  replicaId?: string
  rootDir?: string
  insertIntervalMs?: number
  autoStartWrites?: boolean
  cleanupRoot?: boolean
}

export interface DurableVfsDemo {
  app: Hono
  rootDir: string
  timelineId: string
  replicaId: string
  primary: DurablePrimary
  replica: DurableReplica
  close: () => Promise<void>
}

interface QueryBody {
  sql: string
  params?: unknown[]
  waitForLsn?: string
  waitTimeoutMs?: number
}

interface ExecBody {
  sql: string
  waitForLsn?: string
  waitTimeoutMs?: number
}

interface WaitForLsnBody {
  lsn: string
  timeoutMs?: number
}

interface MaterializeBody {
  lsn: string
  limit?: number
}

interface DemoRow {
  id: string
  payload: string
  inserted_at: string
}

const DEFAULT_INSERT_INTERVAL_MS = 2000
const MIN_INSERT_INTERVAL_MS = 10
const MAX_INSERT_INTERVAL_MS = 60_000
const DEFAULT_REPLICA_WAIT_TIMEOUT_MS = 5000
const MAX_REPLICA_WAIT_TIMEOUT_MS = 60_000

export async function createDurableVfsDemo({
  timelineId = 'demo',
  replicaId = 'replica-1',
  rootDir,
  insertIntervalMs = DEFAULT_INSERT_INTERVAL_MS,
  autoStartWrites = true,
  cleanupRoot,
}: DurableVfsDemoOptions = {}): Promise<DurableVfsDemo> {
  const resolvedInsertIntervalMs = normalizeIntervalMs(insertIntervalMs)
  const generatedRootDir =
    rootDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'pglite-durable-demo-'))
  const resolvedRootDir = path.resolve(generatedRootDir)
  const removeRootOnClose = cleanupRoot ?? rootDir === undefined
  const pageServerDir = path.join(resolvedRootDir, 'pages')
  const streamDir = path.join(resolvedRootDir, 'stream')

  const startedStream = await startDurableStreamTestServer({
    port: 0,
    dataDir: streamDir,
  })
  const pageServer = createPageServer({ rootDir: pageServerDir })
  const pageFetch: typeof globalThis.fetch = honoFetch(pageServer.app)
  const streamUrl = `${startedStream.url}/timelines/${timelineId}`

  const primary = await createDurablePrimary({
    dataDir: path.join(resolvedRootDir, 'primary'),
    timelineId,
    pageServerUrl: 'http://pages.local',
    streamUrl,
    producerId: 'demo-primary',
    fetch: pageFetch,
  })

  await primary.exec(`
    CREATE TABLE IF NOT EXISTS demo_events (
      id bigserial PRIMARY KEY,
      payload text NOT NULL,
      inserted_at timestamptz NOT NULL DEFAULT now()
    )
  `)
  const seed = await primary.query<{ id: string }>(
    "INSERT INTO demo_events (payload) VALUES ('seed') RETURNING id",
  )
  primary.restartAfterCommit = false

  const replica = await createDurableReplica({
    dataDir: path.join(resolvedRootDir, 'replica'),
    timelineId,
    pageServerUrl: 'http://pages.local',
    streamUrl,
    producerId: 'demo-replica',
    fetch: pageFetch,
    pageServerRootDir: pageServerDir,
    autoCatchUp: true,
  })
  await replica.startLive()
  await replica.query('SELECT 1', undefined, { waitForLsn: seed.commit?.lsn })

  let replicaPaused = false
  let writesActive = autoStartWrites
  let insertCount = Number.parseInt(seed.result.rows[0]?.id ?? '0', 10)
  let lastInsertLsn = seed.commit?.lsn
  let latestPrimaryCommitLsn = seed.commit?.lsn
  let lastInsertError: string | undefined
  let primaryQueue: Promise<unknown> = Promise.resolve()
  let autoInsertPending = false
  let closed = false

  const app = new Hono()

  app.get('/', (context) =>
    context.json({
      name: 'pglite durable VFS demo',
      endpoints: [
        'GET /health',
        'GET /v1/status',
        'GET /v1/rows?limit=20',
        'POST /v1/insert {"payload":"manual"}',
        'POST /v1/primary/query {"sql":"select 1","params":[]}',
        'POST /v1/primary/exec {"sql":"vacuum"}',
        `POST /v1/replicas/${replicaId}/query {"sql":"select count(*) from demo_events"}`,
        `POST /v1/replicas/${replicaId}/wait-for-lsn {"lsn":"0/00000040"}`,
        `POST /v1/replicas/${replicaId}/pause`,
        `POST /v1/replicas/${replicaId}/resume`,
        `GET /v1/replicas/${replicaId}/status`,
        'POST /v1/demo/start-writes',
        'POST /v1/demo/stop-writes',
        'POST /v1/demo/reset',
        'GET /v1/time-travel?lsn=0/00000040&limit=20',
        `POST /v1/timelines/${timelineId}/materialize {"lsn":"0/00000040","limit":20}`,
      ],
    }),
  )

  app.get('/health', (context) => context.json({ ok: true }))

  app.get('/v1/status', async (context) => {
    try {
      return context.json(await demoStatus())
    } catch (error) {
      return jsonError(context, error)
    }
  })

  app.get('/v1/rows', async (context) => {
    try {
      const limit = parseLimit(context.req.query('limit'))
      if (!replicaPaused && latestPrimaryCommitLsn) {
        await waitForReplicaLsn(latestPrimaryCommitLsn)
      }
      const rows = await replica.query<DemoRow>(
        `SELECT id::text, payload, inserted_at::text
         FROM demo_events
         ORDER BY demo_events.id DESC
         LIMIT $1`,
        [limit],
      )
      return context.json({ rows: rows.result.rows, status: rows.status })
    } catch (error) {
      return jsonError(context, error)
    }
  })

  app.post('/v1/insert', async (context) => {
    try {
      const body = await readJsonBody(context.req.raw)
      const insert = await insertDemoRow(insertPayload(body))
      return context.json(insert)
    } catch (error) {
      return jsonError(context, error)
    }
  })

  app.post('/v1/primary/query', async (context) => {
    const body = await readJsonBody(context.req.raw)
    if (!isQueryBody(body)) {
      return context.json({ error: 'Expected { sql, params? }' }, 400)
    }
    try {
      const result = await runPrimary(() =>
        primary.query(body.sql, body.params),
      )
      await rememberPrimaryResult(result)
      return context.json(result)
    } catch (error) {
      return jsonError(context, error)
    }
  })

  app.post('/v1/primary/exec', async (context) => {
    const body = await readJsonBody(context.req.raw)
    if (!isExecBody(body)) {
      return context.json({ error: 'Expected { sql }' }, 400)
    }
    try {
      const result = await runPrimary(() => primary.exec(body.sql))
      await rememberPrimaryResult(result)
      return context.json(result)
    } catch (error) {
      return jsonError(context, error)
    }
  })

  app.get('/v1/primary/status', (context) => context.json(primary.status()))

  app.post('/v1/replicas/:replicaId/query', async (context) => {
    const replicaRoute = assertReplicaRoute(context.req.param('replicaId'))
    if (replicaRoute) return context.json(replicaRoute, 404)

    const body = await readJsonBody(context.req.raw)
    if (!isQueryBody(body)) {
      return context.json(
        { error: 'Expected { sql, params?, waitForLsn? }' },
        400,
      )
    }
    try {
      if (body.waitForLsn) {
        await waitForReplicaLsn(
          body.waitForLsn,
          parseReplicaWaitTimeout(body.waitTimeoutMs),
        )
      }
      return context.json(await replica.query(body.sql, body.params))
    } catch (error) {
      return jsonError(context, error)
    }
  })

  app.post('/v1/replicas/:replicaId/exec', async (context) => {
    const replicaRoute = assertReplicaRoute(context.req.param('replicaId'))
    if (replicaRoute) return context.json(replicaRoute, 404)

    const body = await readJsonBody(context.req.raw)
    if (!isExecBody(body)) {
      return context.json({ error: 'Expected { sql, waitForLsn? }' }, 400)
    }
    try {
      if (body.waitForLsn) {
        await waitForReplicaLsn(
          body.waitForLsn,
          parseReplicaWaitTimeout(body.waitTimeoutMs),
        )
      }
      return context.json(await replica.exec(body.sql))
    } catch (error) {
      return jsonError(context, error)
    }
  })

  app.post('/v1/replicas/:replicaId/wait-for-lsn', async (context) => {
    const replicaRoute = assertReplicaRoute(context.req.param('replicaId'))
    if (replicaRoute) return context.json(replicaRoute, 404)

    const body = await readJsonBody(context.req.raw)
    if (!isWaitForLsnBody(body)) {
      return context.json({ error: 'Expected { lsn }' }, 400)
    }
    try {
      await waitForReplicaLsn(body.lsn, parseReplicaWaitTimeout(body.timeoutMs))
      return context.json({ status: replica.status() })
    } catch (error) {
      return jsonError(context, error)
    }
  })

  app.post('/v1/replicas/:replicaId/pause', (context) => {
    const replicaRoute = assertReplicaRoute(context.req.param('replicaId'))
    if (replicaRoute) return context.json(replicaRoute, 404)

    replica.stopLive()
    replicaPaused = true
    return context.json({
      replicaId,
      paused: replicaPaused,
      status: replica.status(),
    })
  })

  app.post('/v1/replicas/:replicaId/resume', async (context) => {
    const replicaRoute = assertReplicaRoute(context.req.param('replicaId'))
    if (replicaRoute) return context.json(replicaRoute, 404)

    try {
      await resumeReplica()
      return context.json({
        replicaId,
        paused: replicaPaused,
        status: replica.status(),
      })
    } catch (error) {
      return jsonError(context, error)
    }
  })

  app.get('/v1/replicas/:replicaId/status', (context) => {
    const replicaRoute = assertReplicaRoute(context.req.param('replicaId'))
    if (replicaRoute) return context.json(replicaRoute, 404)

    return context.json({
      replicaId,
      paused: replicaPaused,
      status: replica.status(),
    })
  })

  app.post('/v1/demo/start-writes', (context) => {
    writesActive = true
    return context.json({ writesActive })
  })

  app.post('/v1/demo/stop-writes', (context) => {
    writesActive = false
    return context.json({ writesActive })
  })

  app.post('/v1/demo/reset', async (context) => {
    try {
      writesActive = false
      const truncate = await runPrimary(() =>
        primary.exec('TRUNCATE demo_events RESTART IDENTITY'),
      )
      rememberPrimaryCommit(truncate.commit)
      insertCount = 0
      const seedInsert = await insertDemoRow('seed')
      if (!replicaPaused && seedInsert.commitLsn) {
        await waitForReplicaLsn(seedInsert.commitLsn)
      }
      return context.json({
        truncateLsn: truncate.commit?.lsn,
        seed: seedInsert,
        status: await demoStatus(),
      })
    } catch (error) {
      return jsonError(context, error)
    }
  })

  app.get('/v1/time-travel', async (context) => {
    try {
      const lsn = context.req.query('lsn')
      if (!lsn)
        return context.json({ error: 'Missing lsn query parameter' }, 400)
      const limit = parseLimit(context.req.query('limit'))
      return context.json(await materializeAtLsn(lsn, limit))
    } catch (error) {
      return jsonError(context, error)
    }
  })

  app.post('/v1/timelines/:timelineId/materialize', async (context) => {
    if (context.req.param('timelineId') !== timelineId) {
      return context.json(
        { error: `Unknown timeline ${context.req.param('timelineId')}` },
        404,
      )
    }

    const body = await readJsonBody(context.req.raw)
    if (!isMaterializeBody(body)) {
      return context.json({ error: 'Expected { lsn, limit? }' }, 400)
    }
    try {
      return context.json(
        await materializeAtLsn(body.lsn, parseLimit(body.limit)),
      )
    } catch (error) {
      return jsonError(context, error)
    }
  })

  // Back-compatible short aliases used by early smoke scripts.
  app.post('/v1/pause', (context) => {
    writesActive = false
    return context.json({ writesActive })
  })
  app.post('/v1/resume', (context) => {
    writesActive = true
    return context.json({ writesActive })
  })

  const insertTimer = setInterval(() => {
    if (!writesActive || autoInsertPending) return
    autoInsertPending = true
    void insertDemoRow(`auto-${Date.now()}`)
      .catch((error: unknown) => {
        lastInsertError = error instanceof Error ? error.message : String(error)
      })
      .finally(() => {
        autoInsertPending = false
      })
  }, resolvedInsertIntervalMs)

  async function insertDemoRow(payload: string): Promise<{
    row: { id: string; payload: string }
    commitLsn?: string
    commit?: CommitSummary
  }> {
    const inserted = await runPrimary(() =>
      primary.query<{ id: string; payload: string }>(
        'INSERT INTO demo_events (payload) VALUES ($1) RETURNING id::text, payload',
        [payload],
      ),
    )
    const row = inserted.result.rows[0] ?? {
      id: String(insertCount + 1),
      payload,
    }
    insertCount = Number.parseInt(row.id, 10)
    rememberPrimaryCommit(inserted.commit)
    lastInsertLsn = inserted.commit?.lsn ?? lastInsertLsn
    lastInsertError = undefined
    console.log(
      `primary committed lsn=${inserted.commit?.lsn ?? 'none'} rows=${insertCount} pages=${inserted.commit?.pageCount ?? 0} files=${inserted.commit?.fileCount ?? 0}`,
    )
    return {
      row,
      commitLsn: inserted.commit?.lsn,
      commit: inserted.commit,
    }
  }

  async function runPrimary<T>(callback: () => Promise<T>): Promise<T> {
    const run = primaryQueue.then(callback, callback)
    primaryQueue = run.catch(() => undefined)
    return await run
  }

  async function rememberPrimaryResult<T extends { commit?: CommitSummary }>(
    result: T,
  ): Promise<void> {
    rememberPrimaryCommit(result.commit)
    if (result.commit?.lsn) {
      await refreshInsertCount()
    }
  }

  function rememberPrimaryCommit(commit: CommitSummary | undefined): void {
    if (commit?.lsn) latestPrimaryCommitLsn = commit.lsn
  }

  async function refreshInsertCount(): Promise<void> {
    try {
      const count = await runPrimary(() =>
        primary.query<{ count: string }>(
          'SELECT count(*)::text AS count FROM demo_events',
        ),
      )
      insertCount = Number.parseInt(
        count.result.rows[0]?.count ?? String(insertCount),
        10,
      )
      lastInsertError = undefined
    } catch (error) {
      lastInsertError = errorMessage(error)
    }
  }

  async function resumeReplica(): Promise<void> {
    await replica.catchUpOnce()
    await replica.startLive()
    replicaPaused = false
  }

  async function waitForReplicaLsn(
    lsn: string,
    timeoutMs = DEFAULT_REPLICA_WAIT_TIMEOUT_MS,
  ): Promise<void> {
    const appliedLsn = replica.status().appliedLsn
    if (appliedLsn && compareLsn(appliedLsn, lsn) >= 0) return
    if (replicaPaused) {
      throw new HttpError('Replica is paused', 409)
    }

    const controller = new AbortController()
    const timer = setTimeout(() => {
      controller.abort(
        new HttpError(`Timed out waiting for replica LSN ${lsn}`, 504),
      )
    }, timeoutMs)
    try {
      await replica.tailer.waitForLsn(lsn, { signal: controller.signal })
    } finally {
      clearTimeout(timer)
    }
  }

  async function demoStatus(): Promise<Record<string, unknown>> {
    const [primaryRows, replicaRows] = await Promise.all([
      runPrimary(() =>
        primary.query<{ count: string }>('SELECT count(*) FROM demo_events'),
      ),
      replica.query<{ count: string }>('SELECT count(*) FROM demo_events'),
    ])
    const primaryStatus = primary.status()
    const replicaStatus = replica.status()
    return {
      rootDir: resolvedRootDir,
      timelineId,
      replicaId,
      streamUrl,
      writes: {
        active: writesActive,
        intervalMs: resolvedInsertIntervalMs,
        pending: autoInsertPending,
      },
      replicaPaused,
      insertCount,
      lastInsertLsn,
      latestPrimaryCommitLsn,
      lastInsertError,
      primary: primaryStatus,
      replica: replicaStatus,
      lag: replicaLag(primaryStatus.currentLsn, replicaStatus.appliedLsn),
      rows: {
        primary: Number.parseInt(primaryRows.result.rows[0]?.count ?? '0', 10),
        replica: Number.parseInt(replicaRows.result.rows[0]?.count ?? '0', 10),
      },
    }
  }

  async function materializeAtLsn(
    lsn: string,
    limit: number,
  ): Promise<{
    requestedLsn: string
    materializedLsn: string
    lsn: string
    rows: DemoRow[]
    cache: unknown
  }> {
    const read = await primary.timeline.readCommitEvents({ offset: '-1' })
    const headLsn = read.events.at(-1)?.lsn
    if (!headLsn) {
      throw new HttpError(`Timeline ${timelineId} has no commits`, 404)
    }
    if (compareLsn(lsn, headLsn) > 0) {
      throw new HttpError(
        `Requested LSN ${lsn} is after timeline head ${headLsn}`,
        400,
      )
    }

    const fsRoot = fs.mkdtempSync(path.join(resolvedRootDir, 'time-travel-'))
    let db: PGlite | undefined
    try {
      const resolver = new DiskPageResolver(pageServerDir)
      const replicaFs = new LazyReplicaFS(fsRoot, {
        timelineId,
        resolver,
      })
      let materializedLsn: string | undefined

      for (const event of read.events) {
        if (compareLsn(event.lsn, lsn) > 0) break
        const manifest = pageServer.store.getCommit(event.timelineId, event.lsn)
        if (!manifest) throw new Error(`Missing manifest for ${event.lsn}`)
        replicaFs.applyManifest(manifest)
        materializedLsn = event.lsn
      }
      if (!materializedLsn) {
        throw new HttpError(
          `Requested LSN ${lsn} is before the first timeline commit`,
          400,
        )
      }

      replicaFs.prepareForRecovery()
      replicaFs.setRecoveryWrites(true)
      try {
        db = await PGlite.create({ fs: replicaFs })
      } finally {
        replicaFs.setRecoveryWrites(false)
      }
      const rows = await db.query<DemoRow>(
        `SELECT id::text, payload, inserted_at::text
         FROM demo_events
         ORDER BY demo_events.id DESC
         LIMIT $1`,
        [limit],
      )
      return {
        requestedLsn: lsn,
        materializedLsn,
        lsn: materializedLsn,
        rows: rows.rows,
        cache: replicaFs.cacheStats,
      }
    } finally {
      if (db && !db.closed) await db.close()
      fs.rmSync(fsRoot, { recursive: true, force: true })
    }
  }

  async function close(): Promise<void> {
    if (closed) return
    closed = true
    clearInterval(insertTimer)
    replica.stopLive()
    await replica.close()
    await primary.close()
    await startedStream.stop()
    if (removeRootOnClose) {
      fs.rmSync(resolvedRootDir, { recursive: true, force: true })
    }
  }

  function assertReplicaRoute(
    routeReplicaId: string,
  ): { error: string } | undefined {
    if (routeReplicaId === replicaId) return undefined
    return { error: `Unknown replica ${routeReplicaId}` }
  }

  return {
    app,
    rootDir: resolvedRootDir,
    timelineId,
    replicaId,
    primary,
    replica,
    close,
  }
}

function replicaLag(
  primaryLsn: string | undefined,
  replicaLsn: string | undefined,
) {
  if (!primaryLsn || !replicaLsn) {
    return { primaryLsn, replicaLsn, caughtUp: primaryLsn === replicaLsn }
  }
  return {
    primaryLsn,
    replicaLsn,
    caughtUp: compareLsn(replicaLsn, primaryLsn) >= 0,
  }
}

function insertPayload(body: Record<string, unknown>): string {
  return typeof body.payload === 'string'
    ? body.payload
    : `manual-${Date.now()}`
}

function isQueryBody(value: unknown): value is QueryBody {
  if (!isRecord(value) || typeof value.sql !== 'string') return false
  if (value.params !== undefined && !Array.isArray(value.params)) return false
  if (value.waitForLsn !== undefined && typeof value.waitForLsn !== 'string') {
    return false
  }
  return (
    value.waitTimeoutMs === undefined || typeof value.waitTimeoutMs === 'number'
  )
}

function isExecBody(value: unknown): value is ExecBody {
  if (!isRecord(value) || typeof value.sql !== 'string') return false
  if (value.waitForLsn !== undefined && typeof value.waitForLsn !== 'string') {
    return false
  }
  return (
    value.waitTimeoutMs === undefined || typeof value.waitTimeoutMs === 'number'
  )
}

function isWaitForLsnBody(value: unknown): value is WaitForLsnBody {
  return (
    isRecord(value) &&
    typeof value.lsn === 'string' &&
    (value.timeoutMs === undefined || typeof value.timeoutMs === 'number')
  )
}

function isMaterializeBody(value: unknown): value is MaterializeBody {
  if (!isRecord(value) || typeof value.lsn !== 'string') return false
  return value.limit === undefined || typeof value.limit === 'number'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseLimit(value: string | number | undefined): number {
  const parsed =
    typeof value === 'number' ? value : Number.parseInt(value ?? '20', 10)
  if (!Number.isFinite(parsed)) return 20
  return Math.min(Math.max(parsed, 1), 100)
}

function parseReplicaWaitTimeout(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return DEFAULT_REPLICA_WAIT_TIMEOUT_MS
  }
  return Math.min(Math.max(Math.trunc(value), 1), MAX_REPLICA_WAIT_TIMEOUT_MS)
}

function normalizeIntervalMs(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_INSERT_INTERVAL_MS
  return Math.min(
    Math.max(Math.trunc(value), MIN_INSERT_INTERVAL_MS),
    MAX_INSERT_INTERVAL_MS,
  )
}

async function readJsonBody(
  request: Request,
): Promise<Record<string, unknown>> {
  if (
    request.headers.get('content-type')?.includes('application/json') !== true
  ) {
    return {}
  }
  const body = (await request.json()) as unknown
  return isRecord(body) ? body : {}
}

function jsonError(
  context: { json: (value: unknown, status?: number) => Response },
  error: unknown,
): Response {
  return context.json(
    { error: errorMessage(error) },
    error instanceof HttpError ? error.status : 500,
  )
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error'
}

class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
  }
}

interface HonoRequester {
  request(input: string, init?: RequestInit): Response | Promise<Response>
}

function honoFetch(app: HonoRequester): typeof globalThis.fetch {
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
