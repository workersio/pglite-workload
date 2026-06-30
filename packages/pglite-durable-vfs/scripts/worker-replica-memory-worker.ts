import process from 'node:process'
import v8 from 'node:v8'
import { parentPort, workerData } from 'node:worker_threads'

import type { Results } from '@electric-sql/pglite'

import type { DurableReplicaOptions } from '../src/replica/durable-replica.js'

interface ReplicaWorkerData {
  workerId: number
  distIndexUrl: string
  dataDir: string
  timelineId: string
  pageServerUrl: string
  streamUrl: string
  pageServerRootDir?: string
  producerId: string
  initialMemoryBytes?: number
  startParams?: string[]
  wasmModule?: WebAssembly.Module
  fsBundle?: SharedArrayBuffer
  readOnlyFsBundle?: boolean
}

type WorkerRequest =
  | { id: number; type: 'status'; collectGarbage?: boolean }
  | { id: number; type: 'close' }

type WorkerResponse =
  | { type: 'ready'; status: ReplicaWorkerStatus }
  | { type: 'progress'; workerId: number; stage: string }
  | { type: 'response'; id: number; result: ReplicaWorkerStatus | undefined }
  | { type: 'error'; id: number; error: SerializedError }
  | { type: 'init-error'; error: SerializedError }

export interface ReplicaWorkerStatus {
  workerId: number
  rows: number
  payloadBytes: number
  elapsedMs: number
  memory: {
    heapUsed: number
    heapTotal: number
    external: number
    arrayBuffers: number
    v8UsedHeap: number
    v8TotalHeap: number
    wasmHeapBytes: number
  }
}

interface SerializedError {
  name?: string
  message: string
  stack?: string
}

interface ReplicaLike {
  query<T>(sql: string): Promise<Results<T>>
  close(): Promise<void>
  Module: {
    HEAPU8: {
      buffer: ArrayBufferLike
    }
  }
}

let replica: ReplicaLike | undefined
let readyStatus: ReplicaWorkerStatus | undefined
const data = workerData as ReplicaWorkerData

void start()

async function start(): Promise<void> {
  try {
    const startTime = performance.now()
    progress('loading-dist')
    const { createDurableReplica } = (await import(
      data.distIndexUrl
    )) as unknown as {
      createDurableReplica: (
        options: DurableReplicaOptions,
      ) => Promise<ReplicaLike>
    }
    progress('creating-replica')
    replica = await createDurableReplica({
      dataDir: data.dataDir,
      timelineId: data.timelineId,
      pageServerUrl: data.pageServerUrl,
      streamUrl: data.streamUrl,
      pageServerRootDir: data.pageServerRootDir,
      producerId: data.producerId,
      autoCatchUp: true,
      pgliteOptions: {
        initialMemory: data.initialMemoryBytes,
        fsBundle: data.fsBundle,
        pgliteWasmModule: data.wasmModule,
        readOnlyFsBundle: data.readOnlyFsBundle,
        startParams: data.startParams,
      },
    })
    progress('replica-open')
    const result = await replica.query<{
      rows: number
      payload_bytes: number
    }>(
      'SELECT count(*)::int AS rows, sum(length(payload))::int AS payload_bytes FROM bench_items',
    )
    progress('validation-query-complete')
    const row = singleRow(result)
    progress('collecting-ready-status')
    readyStatus = status({
      rows: row.rows,
      payloadBytes: row.payload_bytes,
      elapsedMs: performance.now() - startTime,
    })
    progress('ready-status-collected')
    parentPort?.on('message', (message: WorkerRequest) => {
      void handleRequest(message)
    })
    parentPort?.postMessage({
      type: 'ready',
      status: readyStatus,
    } satisfies WorkerResponse)
    progress('ready-posted')
  } catch (error) {
    parentPort?.postMessage({
      type: 'init-error',
      error: serializeError(error),
    } satisfies WorkerResponse)
  }
}

function progress(stage: string): void {
  parentPort?.postMessage({
    type: 'progress',
    workerId: data.workerId,
    stage,
  } satisfies WorkerResponse)
}

async function handleRequest(message: WorkerRequest): Promise<void> {
  try {
    switch (message.type) {
      case 'status':
        progress('status-request')
        if (message.collectGarbage) collectGarbage()
        parentPort?.postMessage({
          type: 'response',
          id: message.id,
          result: status({
            rows: readyStatus?.rows ?? 0,
            payloadBytes: readyStatus?.payloadBytes ?? 0,
            elapsedMs: readyStatus?.elapsedMs ?? 0,
          }),
        } satisfies WorkerResponse)
        progress('status-response')
        return
      case 'close':
        await replica?.close()
        replica = undefined
        parentPort?.postMessage({
          type: 'response',
          id: message.id,
          result: undefined,
        } satisfies WorkerResponse)
        parentPort?.close()
        return
    }
  } catch (error) {
    parentPort?.postMessage({
      type: 'error',
      id: message.id,
      error: serializeError(error),
    } satisfies WorkerResponse)
  }
}

function status({
  rows,
  payloadBytes,
  elapsedMs,
}: {
  rows: number
  payloadBytes: number
  elapsedMs: number
}): ReplicaWorkerStatus {
  const memory = process.memoryUsage()
  const heap = v8.getHeapStatistics()
  return {
    workerId: data.workerId,
    rows,
    payloadBytes,
    elapsedMs,
    memory: {
      heapUsed: memory.heapUsed,
      heapTotal: memory.heapTotal,
      external: memory.external,
      arrayBuffers: memory.arrayBuffers,
      v8UsedHeap: heap.used_heap_size,
      v8TotalHeap: heap.total_heap_size,
      wasmHeapBytes: replica?.Module.HEAPU8.buffer.byteLength ?? 0,
    },
  }
}

function singleRow<T>(result: Results<T>): T {
  const row = result.rows[0]
  if (!row) throw new Error('Expected replica benchmark query to return a row')
  return row
}

function collectGarbage(): void {
  ;(globalThis as typeof globalThis & { gc?: () => void }).gc?.()
}

function serializeError(error: unknown): SerializedError {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    }
  }
  return { message: String(error) }
}
