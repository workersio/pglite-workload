import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Worker } from 'node:worker_threads'

import { serve, type ServerType } from '@hono/node-server'
import { PGlite } from '@electric-sql/pglite'

import type { ReplicaWorkerStatus } from './worker-replica-memory-worker.js'
import { startDurableStreamTestServer } from '../src/durable/durable-server.js'
import { createPageServer } from '../src/pageserver/app.js'
import { createDurablePrimary } from '../src/primary/durable-primary.js'

type ResolverMode = 'disk' | 'sab'

interface BenchmarkOptions {
  help?: boolean
  replicas: number
  step: number
  rows: number
  payloadBytes: number
  settleMs: number
  initialMemoryMb: number
  workerTimeoutMs: number
  shareWasm: boolean
  shareFsBundle: boolean
  readOnlyFsBundle: boolean
  resolver: ResolverMode
  lowMemoryPostgres: boolean
  verbose: boolean
  keep: boolean
  jsonPath?: string
  rootDir?: string
}

interface WorkerInit {
  workerId: number
  distIndexUrl: string
  dataDir: string
  timelineId: string
  pageServerUrl: string
  streamUrl: string
  pageServerRootDir?: string
  producerId: string
  initialMemoryBytes: number
  startParams?: string[]
  wasmModule?: WebAssembly.Module
  fsBundle?: SharedArrayBuffer
  readOnlyFsBundle: boolean
  verbose: boolean
  timeoutMs: number
}

interface StartedPageServer {
  url: string
  server: ServerType
}

type WorkerRequest =
  | { type: 'status'; collectGarbage?: boolean }
  | { type: 'close' }

type WorkerWireRequest = WorkerRequest & { id: number }

type WorkerWireResponse =
  | { type: 'ready'; status: ReplicaWorkerStatus }
  | { type: 'progress'; workerId: number; stage: string }
  | { type: 'response'; id: number; result?: ReplicaWorkerStatus }
  | { type: 'error'; id: number; error: SerializedError }
  | { type: 'init-error'; error: SerializedError }

interface SerializedError {
  name?: string
  message: string
  stack?: string
}

interface PendingCall<T> {
  resolve: (value: T) => void
  reject: (error: Error) => void
}

interface MemorySnapshot {
  replicas: number
  rssBytes: number
  rssDeltaBytes: number
  rssPerReplicaBytes: number
  mainHeapUsedBytes: number
  mainExternalBytes: number
  mainArrayBuffersBytes: number
  workerV8UsedBytes: number
  workerWasmHeapBytes: number
  avgWorkerReadyMs: number
}

interface BenchmarkResult {
  options: BenchmarkOptions
  startedAt: string
  seed: {
    rows: number
    payloadBytes: number
    timelineId: string
  }
  snapshots: MemorySnapshot[]
}

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
)
const repoRoot = path.resolve(packageRoot, '../..')
const workerUrl = pathToFileURL(
  path.join(packageRoot, 'dist/bench/worker-replica-memory-worker.js'),
)
const distIndexUrl = pathToFileURL(path.join(packageRoot, 'dist/index.js')).href
const lowMemoryPostgresSettings = [
  '-c',
  'shared_buffers=8MB',
  '-c',
  'work_mem=512kB',
  '-c',
  'maintenance_work_mem=8MB',
  '-c',
  'temp_buffers=1MB',
  '-c',
  'wal_buffers=512kB',
  '-c',
  'autovacuum=off',
] as const

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2))
  if (options.help) return
  const startedAt = new Date().toISOString()
  const timelineId = `worker-replica-bench-${Date.now().toString(36)}`
  const rootDir =
    options.rootDir ??
    (await mkdtemp(path.join(tmpdir(), 'pglite-worker-replica-bench-')))
  const pageServerDir = path.join(rootDir, 'pages')
  const streamDir = path.join(rootDir, 'stream')
  const initialMemoryBytes = mb(options.initialMemoryMb)
  const startParams = postgresStartParams(options)

  let pageServer: StartedPageServer | undefined
  let streamServer:
    | Awaited<ReturnType<typeof startDurableStreamTestServer>>
    | undefined
  let primary: Awaited<ReturnType<typeof createDurablePrimary>> | undefined
  const workers: ReplicaWorkerHandle[] = []
  const snapshots: MemorySnapshot[] = []

  try {
    printPlan(rootDir, options)
    pageServer = await startPageHttpServer(pageServerDir)
    streamServer = await startDurableStreamTestServer({
      port: 0,
      dataDir: streamDir,
    })

    const wasmModule = options.shareWasm
      ? await compilePGliteWasmModule()
      : undefined
    const fsBundle = options.shareFsBundle
      ? await loadSharedPGliteFsBundle()
      : undefined

    primary = await createDurablePrimary({
      dataDir: path.join(rootDir, 'primary'),
      timelineId,
      pageServerUrl: pageServer.url,
      streamUrl: `${streamServer.url}/timelines/${timelineId}`,
      producerId: 'worker-replica-bench-primary',
      pgliteOptions: {
        fsBundle,
        startParams,
        readOnlyFsBundle: options.readOnlyFsBundle,
      },
    })
    await seedPrimary(primary, options)
    await primary.close()
    primary = undefined

    await delay(options.settleMs)
    snapshots.push(await snapshot(0, workers, 0))
    printHeader()
    printSnapshot(snapshots[0])

    for (let nextWorkerId = 1; nextWorkerId <= options.replicas; ) {
      const batch: ReplicaWorkerHandle[] = []
      const batchEnd = Math.min(
        options.replicas,
        nextWorkerId + options.step - 1,
      )
      for (; nextWorkerId <= batchEnd; nextWorkerId += 1) {
        const worker = new ReplicaWorkerHandle({
          workerId: nextWorkerId,
          distIndexUrl,
          dataDir: path.join(rootDir, `replica-${nextWorkerId}`),
          timelineId,
          pageServerUrl: pageServer.url,
          streamUrl: `${streamServer.url}/timelines/${timelineId}`,
          pageServerRootDir:
            options.resolver === 'disk' ? pageServerDir : undefined,
          producerId: `worker-replica-bench-${nextWorkerId}`,
          initialMemoryBytes,
          startParams,
          wasmModule,
          fsBundle,
          readOnlyFsBundle: options.readOnlyFsBundle,
          verbose: options.verbose,
          timeoutMs: options.workerTimeoutMs,
        })
        workers.push(worker)
        batch.push(worker)
      }

      const ready = await Promise.all(batch.map((worker) => worker.ready))
      await delay(options.settleMs)
      const current = await snapshot(
        workers.length,
        workers,
        averageReady(ready),
        snapshots[0].rssBytes,
      )
      snapshots.push(current)
      printSnapshot(current)
    }

    if (options.jsonPath) {
      const result: BenchmarkResult = {
        options,
        startedAt,
        seed: {
          rows: options.rows,
          payloadBytes: options.payloadBytes,
          timelineId,
        },
        snapshots,
      }
      await writeFile(options.jsonPath, `${JSON.stringify(result, null, 2)}\n`)
      console.log(`\nwrote ${options.jsonPath}`)
    }
  } finally {
    await Promise.allSettled(
      [...workers].reverse().map((worker) => worker.close()),
    )
    await primary?.close()
    if (pageServer) await closeServer(pageServer.server)
    await streamServer?.stop()
    if (!options.keep && !options.rootDir) {
      await rm(rootDir, { recursive: true, force: true })
    } else {
      console.log(`kept benchmark data at ${rootDir}`)
    }
  }
}

class ReplicaWorkerHandle {
  readonly ready: Promise<ReplicaWorkerStatus>

  #worker: Worker
  #nextId = 0
  #closed = false
  #lastProgress = 'created'
  #lastStatus?: ReplicaWorkerStatus
  #pending = new Map<number, PendingCall<ReplicaWorkerStatus | undefined>>()

  constructor(init: WorkerInit) {
    this.#worker = new Worker(workerUrl, {
      workerData: init,
      execArgv: workerExecArgv(),
    })
    this.ready = new Promise<ReplicaWorkerStatus>((resolve, reject) => {
      let settled = false
      const timeout = setTimeout(() => {
        settled = true
        reject(
          new Error(
            `Replica worker ${init.workerId} timed out after ${init.timeoutMs}ms; last progress=${this.#lastProgress}`,
          ),
        )
      }, init.timeoutMs)
      const onMessage = (message: WorkerWireResponse) => {
        if (message.type === 'ready') {
          settled = true
          this.#lastStatus = message.status
          clearTimeout(timeout)
          this.#worker.off('message', onMessage)
          resolve(message.status)
          return
        }
        if (message.type === 'init-error') {
          settled = true
          clearTimeout(timeout)
          this.#worker.off('message', onMessage)
          reject(deserializeError(message.error))
        }
      }
      this.#worker.on('message', onMessage)
      this.#worker.once('error', reject)
      this.#worker.once('exit', (code) => {
        if (settled) return
        clearTimeout(timeout)
        reject(
          new Error(
            `Replica worker ${init.workerId} exited with code ${code} before ready; last progress=${this.#lastProgress}`,
          ),
        )
      })
    })
    this.#worker.on('message', (message: WorkerWireResponse) => {
      if (message.type === 'progress') {
        this.#lastProgress = message.stage
        if (init.verbose) {
          console.error(`worker ${message.workerId}: ${message.stage}`)
        }
        return
      }
      this.handleMessage(message)
    })
    this.#worker.on('error', (error) => {
      this.rejectPending(error)
    })
    this.#worker.on('exit', (code) => {
      if (!this.#closed) {
        this.rejectPending(new Error(`Replica worker exited with code ${code}`))
      }
    })
  }

  async status(collectGarbage: boolean): Promise<ReplicaWorkerStatus> {
    void collectGarbage
    if (!this.#lastStatus) throw new Error('Replica worker is not ready')
    return this.#lastStatus
  }

  async close(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    try {
      await Promise.race([this.call({ type: 'close' }), delay(1_000)])
    } finally {
      await this.#worker.terminate()
    }
  }

  private async call(
    request: WorkerRequest,
  ): Promise<ReplicaWorkerStatus | undefined> {
    const id = (this.#nextId += 1)
    const message: WorkerWireRequest = { ...request, id }
    return await new Promise<ReplicaWorkerStatus | undefined>(
      (resolve, reject) => {
        this.#pending.set(id, { resolve, reject })
        this.#worker.postMessage(message)
      },
    )
  }

  private handleMessage(message: WorkerWireResponse): void {
    if (message.type !== 'response' && message.type !== 'error') return
    const pending = this.#pending.get(message.id)
    if (!pending) return
    this.#pending.delete(message.id)
    if (message.type === 'response') {
      pending.resolve(message.result)
    } else {
      pending.reject(deserializeError(message.error))
    }
  }

  private rejectPending(error: Error): void {
    for (const pending of this.#pending.values()) {
      pending.reject(error)
    }
    this.#pending.clear()
  }
}

function workerExecArgv(): string[] {
  const args = process.execArgv
  const filtered: string[] = []
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    const next = args[index + 1]
    if ((arg === '--import' || arg === '--loader') && next === 'tsx') {
      index += 1
      continue
    }
    if (arg === '--import=tsx' || arg === '--loader=tsx') {
      continue
    }
    if (arg === '--expose-gc') {
      continue
    }
    filtered.push(arg)
  }
  return filtered
}

async function startPageHttpServer(
  rootDir: string,
): Promise<StartedPageServer> {
  const pageServer = createPageServer({ rootDir })
  let server: ServerType | undefined
  const url = await new Promise<string>((resolve) => {
    server = serve(
      {
        fetch: pageServer.app.fetch,
        hostname: '127.0.0.1',
        port: 0,
      },
      (info) => {
        resolve(`http://127.0.0.1:${info.port}`)
      },
    )
  })
  if (!server) throw new Error('Page server did not start')
  return { url, server }
}

async function closeServer(server: ServerType): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error?: Error) => {
      if (error) reject(error)
      else resolve()
    })
  })
}

async function seedPrimary(
  db: Awaited<ReturnType<typeof createDurablePrimary>>,
  opts: BenchmarkOptions,
): Promise<void> {
  await db.exec(`
    CREATE TABLE bench_items (
      id int primary key,
      payload text not null
    );
  `)
  await db.exec(`
    INSERT INTO bench_items
    SELECT i, repeat('x', ${opts.payloadBytes})
    FROM generate_series(1, ${opts.rows}) AS i;
  `)
}

async function compilePGliteWasmModule(): Promise<WebAssembly.Module> {
  const wasmPath = path.join(repoRoot, 'packages/pglite/release/pglite.wasm')
  if (!existsSync(wasmPath)) {
    throw new Error(`Missing PGlite WASM artifact at ${wasmPath}`)
  }
  return await WebAssembly.compile(await readFile(wasmPath))
}

async function loadSharedPGliteFsBundle(): Promise<SharedArrayBuffer> {
  const dataPath = path.join(repoRoot, 'packages/pglite/release/pglite.data')
  if (!existsSync(dataPath)) {
    throw new Error(`Missing PGlite data artifact at ${dataPath}`)
  }
  const bytes = await readFile(dataPath)
  const shared = new SharedArrayBuffer(bytes.byteLength)
  new Uint8Array(shared).set(bytes)
  return shared
}

async function snapshot(
  replicas: number,
  workerHandles: ReplicaWorkerHandle[],
  avgWorkerReadyMs: number,
  baselineRssBytes?: number,
): Promise<MemorySnapshot> {
  const statuses = await Promise.all(
    workerHandles.map((worker) => worker.status(true)),
  )
  collectGarbage()
  const memory = process.memoryUsage()
  const baseline = baselineRssBytes ?? memory.rss
  const rssDeltaBytes = memory.rss - baseline
  return {
    replicas,
    rssBytes: memory.rss,
    rssDeltaBytes,
    rssPerReplicaBytes: replicas > 0 ? rssDeltaBytes / replicas : 0,
    mainHeapUsedBytes: memory.heapUsed,
    mainExternalBytes: memory.external,
    mainArrayBuffersBytes: memory.arrayBuffers,
    workerV8UsedBytes: sum(statuses, (status) => status.memory.v8UsedHeap),
    workerWasmHeapBytes: sum(statuses, (status) => status.memory.wasmHeapBytes),
    avgWorkerReadyMs,
  }
}

function printPlan(rootDir: string, opts: BenchmarkOptions): void {
  console.log('PGlite durable replica worker memory benchmark')
  console.log(`root: ${rootDir}`)
  console.log(
    `replicas=${opts.replicas} step=${opts.step} rows=${opts.rows} payloadBytes=${opts.payloadBytes}`,
  )
  console.log(
    `resolver=${opts.resolver} shareWasm=${opts.shareWasm} shareFsBundle=${opts.shareFsBundle} readOnlyFsBundle=${opts.readOnlyFsBundle} initialMemoryMb=${opts.initialMemoryMb} lowMemoryPostgres=${opts.lowMemoryPostgres}`,
  )
  console.log('')
}

function printHeader(): void {
  console.log(
    [
      'replicas',
      'rss',
      'rssDelta',
      'rss/replica',
      'mainHeap',
      'workerV8',
      'workerWasm',
      'readyMs',
    ].join('\t'),
  )
}

function printSnapshot(snapshot: MemorySnapshot): void {
  console.log(
    [
      snapshot.replicas.toString(),
      formatBytes(snapshot.rssBytes),
      formatBytes(snapshot.rssDeltaBytes),
      formatBytes(snapshot.rssPerReplicaBytes),
      formatBytes(snapshot.mainHeapUsedBytes),
      formatBytes(snapshot.workerV8UsedBytes),
      formatBytes(snapshot.workerWasmHeapBytes),
      snapshot.avgWorkerReadyMs.toFixed(0),
    ].join('\t'),
  )
}

function parseOptions(argv: string[]): BenchmarkOptions {
  const opts: BenchmarkOptions = {
    replicas: 8,
    step: 1,
    rows: 1_000,
    payloadBytes: 256,
    settleMs: 100,
    initialMemoryMb: 128,
    workerTimeoutMs: 120_000,
    shareWasm: true,
    shareFsBundle: true,
    readOnlyFsBundle: true,
    resolver: 'disk',
    lowMemoryPostgres: false,
    verbose: false,
    keep: false,
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    switch (arg) {
      case '--':
        break
      case '--help':
      case '-h':
        printUsage()
        opts.help = true
        return opts
      case '--replicas':
        opts.replicas = positiveInteger(readValue(argv, ++index, arg), arg)
        break
      case '--step':
        opts.step = positiveInteger(readValue(argv, ++index, arg), arg)
        break
      case '--rows':
        opts.rows = positiveInteger(readValue(argv, ++index, arg), arg)
        break
      case '--payload-bytes':
        opts.payloadBytes = nonNegativeInteger(
          readValue(argv, ++index, arg),
          arg,
        )
        break
      case '--settle-ms':
        opts.settleMs = nonNegativeInteger(readValue(argv, ++index, arg), arg)
        break
      case '--initial-memory-mb':
        opts.initialMemoryMb = positiveInteger(
          readValue(argv, ++index, arg),
          arg,
        )
        break
      case '--worker-timeout-ms':
        opts.workerTimeoutMs = positiveInteger(
          readValue(argv, ++index, arg),
          arg,
        )
        break
      case '--resolver':
        opts.resolver = resolverMode(readValue(argv, ++index, arg))
        break
      case '--low-memory-postgres':
        opts.lowMemoryPostgres = true
        break
      case '--json':
        opts.jsonPath = readValue(argv, ++index, arg)
        break
      case '--root-dir':
        opts.rootDir = readValue(argv, ++index, arg)
        opts.keep = true
        break
      case '--keep':
        opts.keep = true
        break
      case '--verbose':
        opts.verbose = true
        break
      case '--share-wasm':
        opts.shareWasm = true
        break
      case '--no-share-wasm':
        opts.shareWasm = false
        break
      case '--share-fs-bundle':
        opts.shareFsBundle = true
        break
      case '--no-share-fs-bundle':
        opts.shareFsBundle = false
        break
      case '--read-only-fs-bundle':
        opts.readOnlyFsBundle = true
        break
      case '--no-read-only-fs-bundle':
        opts.readOnlyFsBundle = false
        break
      default:
        throw new Error(`Unknown option ${arg}`)
    }
  }

  if (opts.step > opts.replicas) opts.step = opts.replicas
  if (opts.shareFsBundle && !opts.readOnlyFsBundle) {
    throw new Error('--share-fs-bundle requires --read-only-fs-bundle')
  }
  return opts
}

function printUsage(): void {
  console.log(`
Usage:
  pnpm --filter @electric-sql/pglite-durable-vfs bench:worker-replicas -- [options]

Options:
  --replicas <n>          Number of replica workers to start. Default: 8
  --step <n>              Workers to add before each measurement. Default: 1
  --rows <n>              Rows seeded into the primary database. Default: 1000
  --payload-bytes <n>     Text payload bytes per row. Default: 256
  --initial-memory-mb <n> Initial WASM memory per replica. Default: 128
  --worker-timeout-ms <n> Worker startup timeout. Default: 120000
  --resolver <disk|sab>   Page resolver mode. Default: disk
  --low-memory-postgres   Use small Postgres memory settings for every PGlite
  --settle-ms <n>         Delay before each measurement. Default: 100
  --share-wasm            Compile pglite.wasm once in parent and clone the module. Default
  --no-share-wasm         Let each worker use the package default WASM loading path
  --share-fs-bundle       Load pglite.data once into a SharedArrayBuffer and share it. Default
  --no-share-fs-bundle    Let each worker use the package default data loading path
  --read-only-fs-bundle   Mark package data files read-only inside each PGlite. Default
  --no-read-only-fs-bundle
                          Leave package data files writable
  --json <path>           Write snapshots as JSON
  --root-dir <path>       Use and keep a specific benchmark directory
  --keep                  Keep temporary benchmark data
  --verbose               Print worker startup progress
`)
}

function readValue(argv: string[], index: number, flag: string): string {
  const value = argv[index]
  if (!value || value.startsWith('--')) {
    throw new Error(`${flag} requires a value`)
  }
  return value
}

function positiveInteger(value: string, flag: string): number {
  const parsed = Number.parseInt(value, 10)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive integer`)
  }
  return parsed
}

function nonNegativeInteger(value: string, flag: string): number {
  const parsed = Number.parseInt(value, 10)
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${flag} must be a non-negative integer`)
  }
  return parsed
}

function resolverMode(value: string): ResolverMode {
  if (value === 'disk' || value === 'sab') return value
  throw new Error('--resolver must be disk or sab')
}

function postgresStartParams(opts: BenchmarkOptions): string[] | undefined {
  if (!opts.lowMemoryPostgres) return undefined
  return [...PGlite.defaultStartParams, ...lowMemoryPostgresSettings]
}

function averageReady(statuses: ReplicaWorkerStatus[]): number {
  if (statuses.length === 0) return 0
  return sum(statuses, (status) => status.elapsedMs) / statuses.length
}

function sum<T>(values: T[], read: (value: T) => number): number {
  return values.reduce((total, value) => total + read(value), 0)
}

function collectGarbage(): void {
  ;(globalThis as typeof globalThis & { gc?: () => void }).gc?.()
}

async function delay(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms))
}

function mb(value: number): number {
  return value * 1024 * 1024
}

function formatBytes(bytes: number): string {
  const sign = bytes < 0 ? '-' : ''
  const absolute = Math.abs(bytes)
  if (absolute < 1024) return `${sign}${absolute.toFixed(0)} B`
  const kib = absolute / 1024
  if (kib < 1024) return `${sign}${kib.toFixed(1)} KiB`
  const mib = kib / 1024
  if (mib < 1024) return `${sign}${mib.toFixed(1)} MiB`
  return `${sign}${(mib / 1024).toFixed(2)} GiB`
}

function deserializeError(error: SerializedError): Error {
  const deserialized = new Error(error.message)
  deserialized.name = error.name ?? 'Error'
  deserialized.stack = error.stack
  return deserialized
}

await main()
