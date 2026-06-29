import { Worker } from 'node:worker_threads'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { FileVersion, PageVersion } from '../src/pageserver/types.js'
import { SabPageResolver } from '../src/sab/sab-page-resolver.js'
import { sha256Bytes } from '../src/shared/hash.js'
import { PAGE_SIZE } from '../src/shared/constants.js'

describe('SAB page resolver', () => {
  let resolver: SabPageResolver | undefined
  let staticServer: StaticPageServer | undefined

  afterEach(async () => {
    await resolver?.close()
    resolver = undefined
    await staticServer?.close()
    staticServer = undefined
  })

  it('fetches a missing page into shared memory and validates its hash', async () => {
    const bytes = new Uint8Array(PAGE_SIZE).fill(7)
    const page = pageVersion('sab-demo', '0/00000010', bytes)
    staticServer = await startStaticPageServer([routeForPage(page, bytes)])
    resolver = new SabPageResolver({ pageServerUrl: staticServer.baseUrl })

    const resolvedBytes = resolver.getPageBytes(page)

    expect(resolvedBytes?.byteLength).toBe(PAGE_SIZE)
    expect(resolvedBytes?.[0]).toBe(7)
  })

  it('copies a missing page directly into a shared target memory', async () => {
    const bytes = new Uint8Array(PAGE_SIZE).fill(9)
    const page = pageVersion('sab-copy-demo', '0/00000010', bytes)
    const memory = new WebAssembly.Memory({
      initial: 1,
      maximum: 1,
      shared: true,
    } as WebAssembly.MemoryDescriptor & { shared: true })
    staticServer = await startStaticPageServer([routeForPage(page, bytes)])
    resolver = new SabPageResolver({
      pageServerUrl: staticServer.baseUrl,
      targetMemory: memory,
    })

    expect(resolver.copyPageBytes(page, 32)).toBe(true)

    const copied = new Uint8Array(memory.buffer, 32, PAGE_SIZE)
    expect(copied[0]).toBe(9)
    expect(copied[PAGE_SIZE - 1]).toBe(9)
  })

  it('persists fetched objects to an optional local cache', async () => {
    const bytes = new Uint8Array(PAGE_SIZE).fill(2)
    const page = pageVersion('sab-cache-demo', '0/00000010', bytes)
    const cacheDir = await mkdtemp(join(tmpdir(), 'pglite-sab-cache-'))
    staticServer = await startStaticPageServer([routeForPage(page, bytes)])
    resolver = new SabPageResolver({
      pageServerUrl: staticServer.baseUrl,
      cacheDir,
    })
    expect(resolver.getPageBytes(page)?.[0]).toBe(2)
    await resolver.close()
    resolver = undefined
    await staticServer.close()
    staticServer = undefined

    resolver = new SabPageResolver({
      pageServerUrl: 'http://127.0.0.1:1',
      cacheDir,
    })

    expect(resolver.getPageBytes(page)?.[0]).toBe(2)
    await rm(cacheDir, { recursive: true, force: true })
  })

  it('returns undefined for a missing remote page', async () => {
    staticServer = await startStaticPageServer([])
    resolver = new SabPageResolver({ pageServerUrl: staticServer.baseUrl })

    const bytes = resolver.getPageBytes(
      pageVersion('missing-demo', '0/00000010', new Uint8Array(PAGE_SIZE)),
    )

    expect(bytes).toBeUndefined()
  })

  it('rejects short reads', async () => {
    const actual = new Uint8Array(16).fill(3)
    const page = pageVersion('short-demo', '0/00000010', actual)
    staticServer = await startStaticPageServer([routeForPage(page, actual)])
    resolver = new SabPageResolver({ pageServerUrl: staticServer.baseUrl })

    expect(() =>
      resolver?.getPageBytes({ ...page, byteLength: actual.byteLength + 1 }),
    ).toThrow('Short read')
  })

  it('rejects hash mismatches', async () => {
    const bytes = new Uint8Array(PAGE_SIZE).fill(4)
    const page = pageVersion('hash-demo', '0/00000010', bytes)
    staticServer = await startStaticPageServer([routeForPage(page, bytes)])
    resolver = new SabPageResolver({ pageServerUrl: staticServer.baseUrl })

    expect(() =>
      resolver?.getPageBytes({
        ...page,
        sha256: sha256Bytes(new Uint8Array(PAGE_SIZE).fill(5)),
      }),
    ).toThrow('Hash mismatch')
  })

  it('rejects responses larger than the shared transfer buffer', async () => {
    const bytes = new Uint8Array(PAGE_SIZE).fill(6)
    const page = pageVersion('too-large-demo', '0/00000010', bytes)
    staticServer = await startStaticPageServer([routeForPage(page, bytes)])
    resolver = new SabPageResolver({
      pageServerUrl: staticServer.baseUrl,
      maxBytes: 16,
    })

    expect(() => resolver?.getPageBytes(page)).toThrow(
      'larger than the shared buffer',
    )
  })

  it('times out and can be recreated for a later request', async () => {
    const bytes = new Uint8Array(PAGE_SIZE).fill(8)
    const page = pageVersion('timeout-demo', '0/00000010', bytes)
    staticServer = await startStaticPageServer([routeForPage(page, bytes)])
    resolver = new SabPageResolver({
      pageServerUrl: 'http://10.255.255.1',
      timeoutMs: 1,
    })

    expect(() => resolver?.getPageBytes(page)).toThrow('Timed out')
    await resolver.close()
    resolver = new SabPageResolver({ pageServerUrl: staticServer.baseUrl })

    expect(resolver.getPageBytes(page)?.[0]).toBe(8)
  })

  it('continues serving requests after an explicit worker restart', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4])
    const file = fileVersion('restart-demo', '0/00000010', bytes)
    staticServer = await startStaticPageServer([routeForFile(file, bytes)])
    resolver = new SabPageResolver({ pageServerUrl: staticServer.baseUrl })

    resolver.restartWorker()

    expect([...resolver.getFileBytes(file)!]).toEqual([1, 2, 3, 4])
  })
})

interface StaticPageServer {
  baseUrl: string
  close: () => Promise<void>
}

interface StaticRoute {
  key: string
  bytesBase64: string
}

async function startStaticPageServer(
  routes: StaticRoute[],
): Promise<StaticPageServer> {
  const worker = new Worker(STATIC_PAGE_SERVER_SOURCE, {
    eval: true,
    workerData: {
      routes: Object.fromEntries(
        routes.map((route) => [route.key, route.bytesBase64]),
      ),
    },
  })
  const baseUrl = await new Promise<string>((resolve, reject) => {
    worker.once('message', (message: { port?: number }) => {
      if (message.port) resolve(`http://127.0.0.1:${message.port}`)
    })
    worker.once('error', reject)
  })
  return {
    baseUrl,
    close: async () => {
      await worker.terminate()
    },
  }
}

function pageVersion(
  timelineId: string,
  lsn: string,
  bytes: Uint8Array,
): PageVersion {
  return {
    timelineId,
    lsn,
    path: '/base/5/16384',
    pageNo: 0,
    pageSize: PAGE_SIZE,
    fileSize: bytes.byteLength,
    sha256: sha256Bytes(bytes),
    byteLength: bytes.byteLength,
  }
}

function fileVersion(
  timelineId: string,
  lsn: string,
  bytes: Uint8Array,
): FileVersion {
  return {
    timelineId,
    lsn,
    path: '/global/pg_control',
    fileSize: bytes.byteLength,
    sha256: sha256Bytes(bytes),
    byteLength: bytes.byteLength,
  }
}

function routeForPage(version: PageVersion, bytes: Uint8Array): StaticRoute {
  return {
    key: `/v1/timelines/${version.timelineId}/pages${version.path}?lsn=${version.lsn}&pageNo=${version.pageNo}`,
    bytesBase64: Buffer.from(bytes).toString('base64'),
  }
}

function routeForFile(version: FileVersion, bytes: Uint8Array): StaticRoute {
  return {
    key: `/v1/timelines/${version.timelineId}/files${version.path}?lsn=${version.lsn}`,
    bytesBase64: Buffer.from(bytes).toString('base64'),
  }
}

const STATIC_PAGE_SERVER_SOURCE = String.raw`
const http = require('node:http')
const { parentPort, workerData } = require('node:worker_threads')

const routes = workerData.routes
const server = http.createServer((request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1')
  const key = routeKey(url)
  const body = routes[key]
  if (!body) {
    response.writeHead(404)
    response.end()
    return
  }
  response.writeHead(200, { 'content-type': 'application/octet-stream' })
  response.end(Buffer.from(body, 'base64'))
})

server.listen(0, '127.0.0.1', () => {
  parentPort.postMessage({ port: server.address().port })
})

function routeKey(url) {
  if (url.pathname.includes('/pages/')) {
    return url.pathname + '?lsn=' + url.searchParams.get('lsn') + '&pageNo=' + url.searchParams.get('pageNo')
  }
  return url.pathname + '?lsn=' + url.searchParams.get('lsn')
}
`
