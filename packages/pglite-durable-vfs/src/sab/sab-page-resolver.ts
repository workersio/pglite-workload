import { Worker } from 'node:worker_threads'

import type { FileVersion, PageVersion } from '../pageserver/types.js'
import type { PageResolver } from '../replica/page-resolver.js'
import {
  SAB_BYTE_LENGTH_INDEX,
  SAB_REQUEST_ID_INDEX,
  SAB_STATE_DONE,
  SAB_STATE_ERROR,
  SAB_STATE_INDEX,
  SAB_STATE_PENDING,
  SAB_STATUS_FETCH_ERROR,
  SAB_STATUS_HASH_MISMATCH,
  SAB_STATUS_INDEX,
  SAB_STATUS_NOT_FOUND,
  SAB_STATUS_OK,
  SAB_STATUS_SHORT_READ,
  SAB_STATUS_TOO_LARGE,
  createSabControlBlock,
  type SabControlBlock,
} from './sab-control-block.js'
import { SAB_FETCH_WORKER_SOURCE } from './sab-fetch-worker.js'

export interface SabPageResolverOptions {
  pageServerUrl: string
  maxBytes?: number
  timeoutMs?: number
  cacheDir?: string
  targetMemory?: WebAssembly.Memory
}

type ResolverRequest =
  | { kind: 'page'; version: PageVersion; targetOffset?: number }
  | { kind: 'file'; version: FileVersion; targetOffset?: number }

const DEFAULT_MAX_BYTES = 16 * 1024 * 1024
const DEFAULT_TIMEOUT_MS = 5000

export class SabPageResolver implements PageResolver {
  readonly pageServerUrl: string
  readonly maxBytes: number
  readonly timeoutMs: number
  readonly cacheDir?: string

  #block: SabControlBlock
  #worker: Worker
  #targetBuffer?: SharedArrayBuffer
  #requestId = 0
  #busy = false
  #closed = false

  constructor({
    pageServerUrl,
    maxBytes = DEFAULT_MAX_BYTES,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    cacheDir,
    targetMemory,
  }: SabPageResolverOptions) {
    this.pageServerUrl = pageServerUrl
    this.maxBytes = maxBytes
    this.timeoutMs = timeoutMs
    this.cacheDir = cacheDir
    this.#block = createSabControlBlock(maxBytes)
    this.#targetBuffer = targetBufferFromMemory(targetMemory)
    this.#worker = this.createWorker()
  }

  getPageBytes(version: PageVersion): Uint8Array | undefined {
    return this.requestBytes({ kind: 'page', version })
  }

  getFileBytes(version: FileVersion): Uint8Array | undefined {
    return this.requestBytes({ kind: 'file', version })
  }

  copyPageBytes(version: PageVersion, targetOffset: number): boolean {
    return this.copyBytes({ kind: 'page', version, targetOffset })
  }

  copyFileBytes(version: FileVersion, targetOffset: number): boolean {
    return this.copyBytes({ kind: 'file', version, targetOffset })
  }

  restartWorker(): void {
    void this.#worker.terminate()
    this.#worker = this.createWorker()
  }

  async close(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    await this.#worker.terminate()
  }

  private requestBytes(request: ResolverRequest): Uint8Array | undefined {
    const result = this.dispatchRequest(request)
    return result === true ? undefined : result
  }

  private copyBytes(request: ResolverRequest): boolean {
    if (!this.#targetBuffer) {
      throw new Error(
        'SAB page resolver direct copy requires a shared targetMemory',
      )
    }
    return this.dispatchRequest(request) === true
  }

  private dispatchRequest(
    request: ResolverRequest,
  ): Uint8Array | true | undefined {
    if (this.#closed) throw new Error('SAB page resolver is closed')
    if (this.#busy) throw new Error('SAB page resolver request already active')
    if (request.targetOffset !== undefined) {
      assertTargetOffset(request.targetOffset)
    }
    this.#busy = true
    const requestId = (this.#requestId += 1)
    const control = this.#block.control
    Atomics.store(control, SAB_STATUS_INDEX, SAB_STATUS_OK)
    Atomics.store(control, SAB_BYTE_LENGTH_INDEX, 0)
    Atomics.store(control, SAB_REQUEST_ID_INDEX, requestId)
    Atomics.store(control, SAB_STATE_INDEX, SAB_STATE_PENDING)

    this.#worker.postMessage({ ...request, requestId })
    try {
      const waitResult = Atomics.wait(
        control,
        SAB_STATE_INDEX,
        SAB_STATE_PENDING,
        this.timeoutMs,
      )
      if (waitResult === 'timed-out') {
        this.restartWorker()
        throw new Error(`Timed out waiting for SAB page resolver request`)
      }

      const completedRequestId = Atomics.load(control, SAB_REQUEST_ID_INDEX)
      if (completedRequestId !== requestId) {
        throw new Error(
          `SAB page resolver completed request ${completedRequestId}, expected ${requestId}`,
        )
      }

      const state = Atomics.load(control, SAB_STATE_INDEX)
      const status = Atomics.load(control, SAB_STATUS_INDEX)
      const byteLength = Atomics.load(control, SAB_BYTE_LENGTH_INDEX)
      Atomics.store(control, SAB_STATE_INDEX, 0)

      if (state === SAB_STATE_DONE && status === SAB_STATUS_OK) {
        if (request.targetOffset !== undefined) return true
        return new Uint8Array(this.#block.data.slice(0, byteLength))
      }
      if (state !== SAB_STATE_ERROR) {
        throw new Error(`Unexpected SAB resolver state ${state}`)
      }
      if (status === SAB_STATUS_NOT_FOUND) return undefined
      throw new Error(errorMessage(status, request, byteLength))
    } finally {
      this.#busy = false
    }
  }

  private createWorker(): Worker {
    return new Worker(SAB_FETCH_WORKER_SOURCE, {
      eval: true,
      workerData: {
        controlBuffer: this.#block.controlBuffer,
        dataBuffer: this.#block.dataBuffer,
        targetBuffer: this.#targetBuffer,
        cacheDir: this.cacheDir,
        pageServerUrl: this.pageServerUrl,
      },
    })
  }
}

function errorMessage(
  status: number,
  request: ResolverRequest,
  byteLength: number,
): string {
  const target =
    request.kind === 'page'
      ? `${request.version.path} block ${request.version.pageNo}`
      : request.version.path
  switch (status) {
    case SAB_STATUS_SHORT_READ:
      return `Short read for ${target}: got ${byteLength}, expected ${request.version.byteLength}`
    case SAB_STATUS_HASH_MISMATCH:
      return `Hash mismatch for ${target}`
    case SAB_STATUS_TOO_LARGE:
      return `SAB response for ${target} is ${byteLength} bytes, larger than the shared buffer`
    case SAB_STATUS_FETCH_ERROR:
      return `Failed to fetch ${target}`
    default:
      return `SAB resolver failed for ${target} with status ${status}`
  }
}

function targetBufferFromMemory(
  memory: WebAssembly.Memory | undefined,
): SharedArrayBuffer | undefined {
  if (!memory) return undefined
  if (
    typeof SharedArrayBuffer === 'undefined' ||
    !(memory.buffer instanceof SharedArrayBuffer)
  ) {
    throw new Error('SAB page resolver targetMemory must be shared')
  }
  return memory.buffer
}

function assertTargetOffset(targetOffset: number): void {
  if (!Number.isSafeInteger(targetOffset) || targetOffset < 0) {
    throw new Error('targetOffset must be a non-negative safe integer')
  }
}
