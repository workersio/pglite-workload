import { Hono } from 'hono'

import type { DurableReplica } from './durable-replica.js'

export interface ReplicaAppOptions {
  replica: DurableReplica
}

interface QueryBody {
  sql: string
  params?: unknown[]
  waitForLsn?: string
}

interface ExecBody {
  sql: string
  waitForLsn?: string
}

export function createReplicaApp({ replica }: ReplicaAppOptions): Hono {
  const app = new Hono()

  app.post('/v1/replica/query', async (context) => {
    const body = await context.req.json<unknown>()
    if (!isQueryBody(body)) {
      return context.json(
        { error: 'Expected { sql, params?, waitForLsn? }' },
        400,
      )
    }
    try {
      if (body.waitForLsn) await replica.durable.waitForLsn(body.waitForLsn)
      const result = await replica.query(body.sql, body.params)
      return context.json(
        { result, status: replica.durable.status() },
      )
    } catch (error) {
      return context.json({ error: errorMessage(error) }, 500)
    }
  })

  app.post('/v1/replica/exec', async (context) => {
    const body = await context.req.json<unknown>()
    if (!isExecBody(body)) {
      return context.json({ error: 'Expected { sql, waitForLsn? }' }, 400)
    }
    try {
      if (body.waitForLsn) await replica.durable.waitForLsn(body.waitForLsn)
      const result = await replica.exec(body.sql)
      return context.json(
        { result, status: replica.durable.status() },
      )
    } catch (error) {
      return context.json({ error: errorMessage(error) }, 500)
    }
  })

  app.post('/v1/replica/catch-up', async (context) => {
    try {
      return context.json(await replica.durable.catchUpOnce())
    } catch (error) {
      return context.json({ error: errorMessage(error) }, 500)
    }
  })

  app.get('/v1/replica/status', (context) =>
    context.json(replica.durable.status()),
  )

  return app
}

function isQueryBody(value: unknown): value is QueryBody {
  if (!isRecord(value) || typeof value.sql !== 'string') return false
  if (value.params !== undefined && !Array.isArray(value.params)) return false
  return value.waitForLsn === undefined || typeof value.waitForLsn === 'string'
}

function isExecBody(value: unknown): value is ExecBody {
  if (!isRecord(value) || typeof value.sql !== 'string') return false
  return value.waitForLsn === undefined || typeof value.waitForLsn === 'string'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error'
}
