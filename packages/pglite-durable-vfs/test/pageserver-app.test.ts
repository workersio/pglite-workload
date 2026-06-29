import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createPageServer } from '../src/pageserver/app.js'
import type { CommitManifest } from '../src/pageserver/types.js'
import { sha256Bytes } from '../src/shared/hash.js'

describe('page server app', () => {
  let rootDir: string

  beforeEach(() => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pglite-pageserver-'))
  })

  afterEach(() => {
    fs.rmSync(rootDir, { recursive: true, force: true })
  })

  it('creates timelines, commits objects, and serves pages', async () => {
    const { app } = createPageServer({ rootDir })
    const bytes = new Uint8Array([42])
    const sha256 = sha256Bytes(bytes)

    const createResponse = await app.request('/v1/timelines', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ timelineId: 'demo' }),
    })
    expect(createResponse.status).toBe(201)

    const commitResponse = await app.request('/v1/timelines/demo/commits', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        manifest: manifest(sha256, bytes.byteLength),
        objects: [
          {
            sha256,
            bytesBase64: Buffer.from(bytes).toString('base64'),
          },
        ],
      }),
    })
    expect(commitResponse.status).toBe(201)

    const pageResponse = await app.request(
      '/v1/timelines/demo/pages/base/5/16384?lsn=0/00000010&pageNo=0',
    )
    expect(pageResponse.status).toBe(200)
    expect(new Uint8Array(await pageResponse.arrayBuffer())).toEqual(bytes)

    const missingResponse = await app.request(
      '/v1/timelines/demo/pages/base/5/16384?lsn=0/00000010&pageNo=1',
    )
    expect(missingResponse.status).toBe(404)
  })
})

function manifest(sha256: string, byteLength: number): CommitManifest {
  return {
    version: 1,
    timelineId: 'demo',
    lsn: '0/00000010',
    commitId: 'commit-1',
    createdAt: '2026-01-01T00:00:00.000Z',
    replicaApplyMode: 'live-invalidate',
    operations: [
      {
        type: 'page',
        path: '/base/5/16384',
        pageNo: 0,
        pageSize: 8192,
        fileSize: 8192,
        sha256,
        byteLength,
      },
    ],
    invalidations: [],
    stats: {
      pageCount: 1,
      fileCount: 0,
      metadataCount: 0,
      invalidationCount: 0,
      byteCount: byteLength,
    },
  }
}
