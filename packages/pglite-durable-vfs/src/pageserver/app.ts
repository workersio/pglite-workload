import { Hono } from 'hono'

import { DiskCommitStore } from './commit-store.js'
import type { CommitRequest } from './types.js'

export interface PageServerOptions {
  rootDir: string
}

export interface PageServer {
  app: Hono
  store: DiskCommitStore
}

export function createPageServer({ rootDir }: PageServerOptions): PageServer {
  const app = new Hono()
  const store = new DiskCommitStore(rootDir)

  app.get('/health', (context) => context.json({ ok: true }))

  app.post('/v1/timelines', async (context) => {
    const body = await context.req.json<{ timelineId: string }>()
    return context.json(store.createTimeline(body.timelineId), 201)
  })

  app.get('/v1/timelines/:timelineId', (context) => {
    const timeline = store.getTimeline(context.req.param('timelineId'))
    if (!timeline) return context.json({ error: 'Timeline not found' }, 404)
    return context.json(timeline)
  })

  app.get('/v1/timelines/:timelineId/head', (context) => {
    const head = store.getHead(context.req.param('timelineId'))
    if (!head) return context.json({ error: 'Timeline not found' }, 404)
    return context.json(head)
  })

  app.post('/v1/timelines/:timelineId/commits', async (context) => {
    const timelineId = context.req.param('timelineId')
    const request = await context.req.json<CommitRequest>()
    if (request.manifest.timelineId !== timelineId) {
      return context.json({ error: 'Timeline mismatch' }, 400)
    }
    try {
      const result = store.commit(request)
      return context.json(result, result.status === 'created' ? 201 : 200)
    } catch (error) {
      return context.json({ error: errorMessage(error) }, 409)
    }
  })

  app.get('/v1/timelines/:timelineId/commits/:lsn', (context) => {
    const commit = store.getCommit(
      context.req.param('timelineId'),
      context.req.param('lsn'),
    )
    if (!commit) return context.json({ error: 'Commit not found' }, 404)
    return context.json(commit)
  })

  app.get('/v1/timelines/:timelineId/pages/*', (context) => {
    const timelineId = context.req.param('timelineId')
    const filePath = trailingPath(context.req.path, 'pages')
    const lsn = context.req.query('lsn')
    const pageNo = Number.parseInt(context.req.query('pageNo') ?? '', 10)
    if (!lsn || !Number.isInteger(pageNo)) {
      return context.json({ error: 'lsn and pageNo are required' }, 400)
    }
    const bytes = store.getPageBytes(timelineId, filePath, pageNo, lsn)
    if (!bytes) return context.json({ error: 'Page not found' }, 404)
    return new Response(bytes)
  })

  app.get('/v1/timelines/:timelineId/files/*', (context) => {
    const timelineId = context.req.param('timelineId')
    const filePath = trailingPath(context.req.path, 'files')
    const lsn = context.req.query('lsn')
    if (!lsn) return context.json({ error: 'lsn is required' }, 400)
    const bytes = store.getFileBytes(timelineId, filePath, lsn)
    if (!bytes) return context.json({ error: 'File not found' }, 404)
    return new Response(bytes)
  })

  app.get('/v1/timelines/:timelineId/objects/:sha256', (context) => {
    try {
      return new Response(
        store.objectStore.getBytes(context.req.param('sha256')),
      )
    } catch {
      return context.json({ error: 'Object not found' }, 404)
    }
  })

  return { app, store }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error'
}

function trailingPath(requestPath: string, marker: 'pages' | 'files'): string {
  const markerText = `/${marker}/`
  const markerIndex = requestPath.indexOf(markerText)
  if (markerIndex === -1) return '/'
  return `/${requestPath.slice(markerIndex + markerText.length)}`
}
