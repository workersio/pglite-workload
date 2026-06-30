import { Hono } from 'hono'

import type {
  DurableExecResult,
  DurablePrimary,
  DurableQueryResult,
} from './durable-primary.js'

export interface PrimaryAppOptions {
  primary: DurablePrimary
}

interface QueryBody {
  sql: string
  params?: unknown[]
}

interface ExecBody {
  sql: string
}

export function createPrimaryApp({ primary }: PrimaryAppOptions): Hono {
  const app = new Hono()

  app.post('/v1/primary/query', async (context) => {
    const body = await context.req.json<unknown>()
    if (!isQueryBody(body)) {
      return context.json({ error: 'Expected { sql, params? }' }, 400)
    }
    try {
      const before = primary.durable.commitSerial
      const result = await primary.query(body.sql, body.params)
      return context.json({
        result,
        commit: primary.durable.commitAfter(before),
      } satisfies DurableQueryResult<unknown>)
    } catch (error) {
      return context.json({ error: errorMessage(error) }, 500)
    }
  })

  app.post('/v1/primary/exec', async (context) => {
    const body = await context.req.json<unknown>()
    if (!isExecBody(body)) {
      return context.json({ error: 'Expected { sql }' }, 400)
    }
    try {
      const before = primary.durable.commitSerial
      const result = await primary.exec(body.sql)
      return context.json({
        result,
        commit: primary.durable.commitAfter(before),
      } satisfies DurableExecResult)
    } catch (error) {
      return context.json({ error: errorMessage(error) }, 500)
    }
  })

  app.get('/v1/primary/status', (context) =>
    context.json(primary.durable.status()),
  )

  return app
}

function isQueryBody(value: unknown): value is QueryBody {
  if (!isRecord(value) || typeof value.sql !== 'string') return false
  return value.params === undefined || Array.isArray(value.params)
}

function isExecBody(value: unknown): value is ExecBody {
  return isRecord(value) && typeof value.sql === 'string'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error'
}
