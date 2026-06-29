import { serve } from '@hono/node-server'

import { createDurableVfsDemo } from './app.js'

const port = readIntegerEnv('PORT', 0, 0, 65_535)
const rootDir = process.env.PGLITE_DURABLE_DEMO_DIR
const demo = await createDurableVfsDemo({
  timelineId: process.env.PGLITE_DURABLE_DEMO_TIMELINE ?? 'demo',
  rootDir,
  insertIntervalMs: readIntegerEnv(
    'PGLITE_DURABLE_DEMO_INTERVAL_MS',
    2000,
    10,
    60_000,
  ),
  cleanupRoot: rootDir === undefined,
})

const server = serve(
  {
    fetch: demo.app.fetch,
    port,
  },
  (info) => {
    console.log(
      `pglite durable VFS demo listening on http://localhost:${info.port}`,
    )
    console.log(`data dir: ${demo.rootDir}`)
  },
)

process.once('SIGINT', () => {
  void shutdown()
})
process.once('SIGTERM', () => {
  void shutdown()
})

async function shutdown(): Promise<void> {
  server.close()
  await demo.close()
}

function readIntegerEnv(
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const parsed = Number.parseInt(process.env[name] ?? '', 10)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(Math.max(parsed, min), max)
}
