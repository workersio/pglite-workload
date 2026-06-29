import type { PGlite } from '@electric-sql/pglite'

import type { InvalidationEntry } from '../fs/dirty-tracker.js'
import type { CommitManifest, PageImageOperation } from '../pageserver/types.js'
import type { ReplicaInvalidator } from './tailer.js'

const fieldsPerRange = 7

const forkNumbers = {
  main: 0,
  fsm: 1,
  vm: 2,
  init: 3,
} as const

interface NativeInvalidationModule {
  HEAPU32: Uint32Array
  _malloc: (size: number) => number
  _free: (ptr: number) => void
  _pgl_invalidate_remote_pages?: (
    rangesPtr: number,
    rangesLength: number,
    invalidateSystemCaches: boolean,
    invalidateSmgr: boolean,
    remoteNextXidLow: number,
    remoteNextXidHigh: number,
  ) => number
}

interface NativeInvalidationInput {
  ranges: NativeRange[]
  invalidateSystemCaches: boolean
  invalidateSmgr: boolean
}

interface NativeRange {
  spcOid: number
  dbOid: number
  relNumber: number
  forkNumber: number
  firstBlock: number
  blockCount: number
  relationSizeChanged: boolean
}

export class PGliteNativeInvalidator implements ReplicaInvalidator {
  readonly getDb: () => PGlite | undefined

  #handledLsns = new Set<string>()

  constructor(getDb: () => PGlite | undefined) {
    this.getDb = getDb
  }

  invalidate(manifest: CommitManifest): void {
    const input = nativeInvalidationInput(manifest)
    if (
      input.ranges.length === 0 &&
      !input.invalidateSystemCaches &&
      !input.invalidateSmgr
    ) {
      this.#handledLsns.add(manifest.lsn)
      return
    }

    const nativeModule = pgliteNativeInvalidationModule(this.getDb())
    if (!nativeModule?._pgl_invalidate_remote_pages) return

    const rangeWords = packRanges(input.ranges)
    const remoteNextXid = remoteNextXidWords(manifest)
    const rangesPtr =
      rangeWords.length > 0 ? nativeModule._malloc(rangeWords.byteLength) : 0
    try {
      if (rangesPtr !== 0) {
        nativeModule.HEAPU32.set(rangeWords, rangesPtr >>> 2)
      }
      const result = nativeModule._pgl_invalidate_remote_pages(
        rangesPtr,
        input.ranges.length,
        input.invalidateSystemCaches,
        input.invalidateSmgr,
        remoteNextXid.low,
        remoteNextXid.high,
      )
      if (result < 0) {
        throw new Error(`Native PGlite invalidation failed with ${result}`)
      }
      this.#handledLsns.add(manifest.lsn)
    } finally {
      if (rangesPtr !== 0) nativeModule._free(rangesPtr)
    }
  }

  didHandle(manifest: CommitManifest): boolean {
    const handled = this.#handledLsns.has(manifest.lsn)
    this.#handledLsns.delete(manifest.lsn)
    return handled
  }
}

export function hasPGliteNativeInvalidation(db: PGlite | undefined): boolean {
  return (
    pgliteNativeInvalidationModule(db)?._pgl_invalidate_remote_pages !==
    undefined
  )
}

function pgliteNativeInvalidationModule(
  db: PGlite | undefined,
): NativeInvalidationModule | undefined {
  if (!db) return undefined
  const module = db.Module as unknown
  if (!isNativeInvalidationModule(module)) return undefined
  return module
}

function isNativeInvalidationModule(
  module: unknown,
): module is NativeInvalidationModule {
  if (!module || typeof module !== 'object') return false
  const candidate = module as Partial<NativeInvalidationModule>
  return (
    candidate.HEAPU32 instanceof Uint32Array &&
    typeof candidate._malloc === 'function' &&
    typeof candidate._free === 'function'
  )
}

function nativeInvalidationInput(
  manifest: CommitManifest,
): NativeInvalidationInput {
  const ranges = new Map<string, NativeRange>()
  let invalidateSystemCaches = false
  let invalidateSmgr = false

  for (const invalidation of manifestInvalidations(manifest)) {
    if (invalidation.kind === 'system-cache') {
      invalidateSystemCaches = true
      continue
    }
    if (invalidation.kind === 'metadata') {
      invalidateSystemCaches = true
      invalidateSmgr = true
      continue
    }
    if (invalidation.kind === 'whole-file') {
      invalidateSmgr = true
      continue
    }

    const range = nativeRange(invalidation)
    if (!range) continue

    const key = [
      range.spcOid,
      range.dbOid,
      range.relNumber,
      range.forkNumber,
    ].join('/')
    const existing = ranges.get(key)
    if (!existing) {
      ranges.set(key, range)
      continue
    }

    existing.firstBlock = Math.min(existing.firstBlock, range.firstBlock)
    existing.blockCount = 0
    existing.relationSizeChanged =
      existing.relationSizeChanged || range.relationSizeChanged
  }

  return {
    ranges: [...ranges.values()],
    invalidateSystemCaches,
    invalidateSmgr,
  }
}

function manifestInvalidations(manifest: CommitManifest): InvalidationEntry[] {
  const fromPages = manifest.operations.flatMap((operation) =>
    operation.type === 'page' ? pageInvalidation(operation) : [],
  )
  return [...manifest.invalidations, ...fromPages]
}

function pageInvalidation(operation: PageImageOperation): InvalidationEntry[] {
  return operation.invalidation ? [operation.invalidation] : []
}

function nativeRange(invalidation: InvalidationEntry): NativeRange | undefined {
  if (
    invalidation.spcOid === undefined ||
    invalidation.dbOid === undefined ||
    invalidation.relNumber === undefined ||
    invalidation.fork === undefined ||
    invalidation.firstBlock === undefined
  ) {
    return undefined
  }

  return {
    spcOid: invalidation.spcOid,
    dbOid: invalidation.dbOid,
    relNumber: invalidation.relNumber,
    forkNumber: forkNumbers[invalidation.fork],
    firstBlock: invalidation.firstBlock,
    blockCount: invalidation.blockCount ?? 0,
    relationSizeChanged: invalidation.relationSizeChanged === true,
  }
}

function packRanges(ranges: NativeRange[]): Uint32Array {
  const words = new Uint32Array(ranges.length * fieldsPerRange)
  for (const [index, range] of ranges.entries()) {
    const offset = index * fieldsPerRange
    words[offset] = range.spcOid
    words[offset + 1] = range.dbOid
    words[offset + 2] = range.relNumber
    words[offset + 3] = range.forkNumber
    words[offset + 4] = range.firstBlock
    words[offset + 5] = range.blockCount
    words[offset + 6] = range.relationSizeChanged ? 1 : 0
  }
  return words
}

function remoteNextXidWords(manifest: CommitManifest): {
  low: number
  high: number
} {
  const nextFullXid = manifest.transactionState?.nextFullXid
  if (!nextFullXid) return { low: 0, high: 0 }

  const value = BigInt(nextFullXid)
  return {
    low: Number(value & 0xffffffffn),
    high: Number((value >> 32n) & 0xffffffffn),
  }
}
