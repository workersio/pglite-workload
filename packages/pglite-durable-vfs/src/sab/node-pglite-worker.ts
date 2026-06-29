import { Worker } from 'node:worker_threads'

import type { PGliteOptions, Results } from '@electric-sql/pglite'

import type { SharedPGliteRuntimeOptions } from './shared-pglite-memory.js'

export type NodePGliteWorkerPGliteOptions = Omit<
  PGliteOptions,
  | 'extensions'
  | 'fs'
  | 'fsBundle'
  | 'icuDataDir'
  | 'initdbWasmModule'
  | 'loadDataDir'
  | 'parsers'
  | 'pgliteModFactory'
  | 'pgliteWasmModule'
  | 'serializers'
  | 'wasmMemory'
>

export interface NodePGliteWorkerOptions {
  pgliteOptions?: NodePGliteWorkerPGliteOptions
  sharedRuntime?: SharedPGliteRuntimeOptions
}

export interface NodePGliteWorkerStatus {
  usesSharedMemory: boolean
}

interface WorkerInitData {
  pgliteOptions?: NodePGliteWorkerPGliteOptions
  sharedRuntime?: SerializedSharedRuntimeOptions
}

interface SerializedSharedRuntimeOptions {
  wasmPath: string
  modulePath?: string
  dataPath?: string
  initialBytes?: number
  maximumBytes?: number
}

type WorkerRequest =
  | { type: 'query'; sql: string; params?: unknown[] }
  | { type: 'exec'; sql: string }
  | { type: 'status' }
  | { type: 'close' }

type WorkerMessage = WorkerRequest & { id: number }

type WorkerResponse =
  | { type: 'ready' }
  | { type: 'response'; id: number; result: unknown }
  | { type: 'error'; id: number; error: SerializedError }
  | { type: 'init-error'; error: SerializedError }

interface PendingCall<T> {
  resolve: (value: T) => void
  reject: (error: Error) => void
}

interface SerializedError {
  name?: string
  message: string
  stack?: string
}

export class NodePGliteWorker {
  readonly ready: Promise<void>

  #worker: Worker
  #nextId = 0
  #closed = false
  #pending = new Map<number, PendingCall<unknown>>()

  constructor(options: NodePGliteWorkerOptions = {}) {
    this.#worker = new Worker(NODE_PGLITE_WORKER_SOURCE, {
      eval: true,
      workerData: serializeWorkerInitData(options),
    })
    this.ready = new Promise<void>((resolve, reject) => {
      const handleMessage = (message: WorkerResponse) => {
        if (message.type === 'ready') {
          this.#worker.off('message', handleMessage)
          resolve()
        } else if (message.type === 'init-error') {
          this.#worker.off('message', handleMessage)
          reject(deserializeError(message.error))
        }
      }
      this.#worker.on('message', handleMessage)
      this.#worker.once('error', reject)
    })
    this.#worker.on('message', (message: WorkerResponse) => {
      this.handleWorkerMessage(message)
    })
    this.#worker.on('error', (error) => {
      this.rejectPending(error)
    })
    this.#worker.on('exit', (code) => {
      if (!this.#closed && code !== 0) {
        this.rejectPending(
          new Error(`Node PGlite worker exited with code ${code}`),
        )
      }
    })
  }

  static async create(
    options: NodePGliteWorkerOptions = {},
  ): Promise<NodePGliteWorker> {
    const worker = new NodePGliteWorker(options)
    await worker.ready
    return worker
  }

  async query<T>(sql: string, params?: unknown[]): Promise<Results<T>> {
    await this.ready
    return await this.call<Results<T>>({ type: 'query', sql, params })
  }

  async exec(sql: string): Promise<Results[]> {
    await this.ready
    return await this.call<Results[]>({ type: 'exec', sql })
  }

  async status(): Promise<NodePGliteWorkerStatus> {
    await this.ready
    return await this.call<NodePGliteWorkerStatus>({ type: 'status' })
  }

  async close(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    try {
      await this.call<void>({ type: 'close' })
    } finally {
      await this.#worker.terminate()
    }
  }

  private async call<T>(request: WorkerRequest): Promise<T> {
    if (this.#closed && request.type !== 'close') {
      throw new Error('Node PGlite worker is closed')
    }
    const id = (this.#nextId += 1)
    const message: WorkerMessage = { ...request, id }
    return await new Promise<T>((resolve, reject) => {
      this.#pending.set(id, {
        resolve: resolve as PendingCall<unknown>['resolve'],
        reject,
      })
      this.#worker.postMessage(message)
    })
  }

  private handleWorkerMessage(message: WorkerResponse): void {
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

function serializeWorkerInitData(
  options: NodePGliteWorkerOptions,
): WorkerInitData {
  return {
    pgliteOptions: options.pgliteOptions,
    sharedRuntime: options.sharedRuntime
      ? {
          wasmPath: options.sharedRuntime.wasmPath.toString(),
          modulePath: options.sharedRuntime.modulePath?.toString(),
          dataPath: options.sharedRuntime.dataPath?.toString(),
          initialBytes: options.sharedRuntime.initialBytes,
          maximumBytes: options.sharedRuntime.maximumBytes,
        }
      : undefined,
  }
}

function deserializeError(error: SerializedError): Error {
  const deserialized = new Error(error.message)
  deserialized.name = error.name ?? 'Error'
  deserialized.stack = error.stack
  return deserialized
}

export const NODE_PGLITE_WORKER_SOURCE = String.raw`
const { readFile } = require('node:fs/promises')
const { basename, dirname, extname, join, resolve } = require('node:path')
const { parentPort, workerData } = require('node:worker_threads')
const { fileURLToPath, pathToFileURL } = require('node:url')

const WASM_PAGE_BYTES = 64 * 1024
const DEFAULT_SHARED_PGLITE_MEMORY_BYTES = 256 * 1024 * 1024

let db

void init()

async function init() {
  try {
    const { PGlite } = await import('@electric-sql/pglite')
    const pgliteOptions = { ...(workerData.pgliteOptions ?? {}) }
    if (workerData.sharedRuntime) {
      Object.assign(
        pgliteOptions,
        await loadSharedPGliteRuntimeOptions(workerData.sharedRuntime),
      )
    }
    db = await PGlite.create(pgliteOptions)
    parentPort.postMessage({ type: 'ready' })
    parentPort.on('message', (message) => {
      void handleMessage(message)
    })
  } catch (error) {
    parentPort.postMessage({ type: 'init-error', error: serializeError(error) })
  }
}

async function handleMessage(message) {
  try {
    switch (message.type) {
      case 'query':
        parentPort.postMessage({
          type: 'response',
          id: message.id,
          result: await db.query(message.sql, message.params),
        })
        return
      case 'exec':
        parentPort.postMessage({
          type: 'response',
          id: message.id,
          result: await db.exec(message.sql),
        })
        return
      case 'status':
        parentPort.postMessage({
          type: 'response',
          id: message.id,
          result: {
            usesSharedMemory:
              typeof SharedArrayBuffer !== 'undefined' &&
              db.Module.HEAPU8.buffer instanceof SharedArrayBuffer,
          },
        })
        return
      case 'close':
        await db.close()
        parentPort.postMessage({
          type: 'response',
          id: message.id,
          result: undefined,
        })
        parentPort.close()
        return
      default:
        throw new Error('Unknown Node PGlite worker message type')
    }
  } catch (error) {
    parentPort.postMessage({
      type: 'error',
      id: message.id,
      error: serializeError(error),
    })
  }
}

async function loadSharedPGliteRuntimeOptions({
  wasmPath,
  modulePath,
  dataPath,
  initialBytes,
  maximumBytes,
}) {
  const resolvedModulePath = modulePath ?? siblingArtifactPath(wasmPath, '.js')
  const resolvedDataPath = dataPath ?? siblingArtifactPath(wasmPath, '.data')
  const [wasmBytes, dataBytes, pgliteModFactory] = await Promise.all([
    readFile(filePath(wasmPath)),
    readFile(filePath(resolvedDataPath)),
    loadPGliteModFactory(resolvedModulePath),
  ])
  return {
    fsBundle: new Blob([new Uint8Array(dataBytes)]),
    pgliteModFactory,
    pgliteWasmModule: await WebAssembly.compile(wasmBytes),
    wasmMemory: createSharedPGliteMemory({ initialBytes, maximumBytes }),
  }
}

async function loadPGliteModFactory(modulePath) {
  const moduleNamespace = await import(moduleSpecifier(modulePath))
  const factory = moduleNamespace.default
  if (typeof factory !== 'function') {
    throw new Error('Shared PGlite module must export a default factory')
  }
  return factory
}

function siblingArtifactPath(path, extension) {
  const sourcePath = filePath(path)
  return join(
    dirname(sourcePath),
    basename(sourcePath, extname(sourcePath)) + extension,
  )
}

function moduleSpecifier(path) {
  return pathToFileURL(filePath(path)).href
}

function filePath(path) {
  if (path instanceof URL) {
    assertFileUrl(path)
    return fileURLToPath(path)
  }
  if (path.startsWith('file:')) {
    const url = new URL(path)
    assertFileUrl(url)
    return fileURLToPath(url)
  }
  return resolve(path)
}

function assertFileUrl(url) {
  if (url.protocol !== 'file:') {
    throw new Error(
      'Shared PGlite runtime artifact paths must be filesystem paths or file URLs',
    )
  }
}

function createSharedPGliteMemory({ initialBytes, maximumBytes } = {}) {
  const initial = wasmPageCount(
    initialBytes ?? DEFAULT_SHARED_PGLITE_MEMORY_BYTES,
    'initialBytes',
  )
  const maximum = wasmPageCount(maximumBytes ?? initial * WASM_PAGE_BYTES, 'maximumBytes')
  if (maximum < initial) {
    throw new Error('maximumBytes must be greater than or equal to initialBytes')
  }
  return new WebAssembly.Memory({ initial, maximum, shared: true })
}

function wasmPageCount(bytes, name) {
  if (!Number.isSafeInteger(bytes) || bytes <= 0) {
    throw new Error(name + ' must be a positive integer byte count')
  }
  if (bytes % WASM_PAGE_BYTES !== 0) {
    throw new Error(name + ' must be a multiple of ' + WASM_PAGE_BYTES)
  }
  return bytes / WASM_PAGE_BYTES
}

function serializeError(error) {
  return {
    name: error?.name,
    message: error?.message ?? String(error),
    stack: error?.stack,
  }
}
`
