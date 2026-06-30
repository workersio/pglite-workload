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
  _pgl_invalidate_remote_relation_cache?: (
    spcOid: number,
    dbOid: number,
    relNumber: number,
  ) => number
}

interface NativeInvalidationInput {
  ranges: NativeRange[]
  invalidateSystemCaches: boolean
  invalidateSmgr: boolean
  relationCacheInvalidations: NativeRelation[]
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

type NativeRelation = Pick<NativeRange, 'spcOid' | 'dbOid' | 'relNumber'>

export class PGliteNativeInvalidator implements ReplicaInvalidator {
  readonly getDb: () => PGlite | undefined

  #lastHandledLsn?: string

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
      this.markHandled(manifest)
      return
    }

    const nativeModule = pgliteNativeInvalidationModule(this.getDb())
    if (!nativeModule?._pgl_invalidate_remote_pages) {
      throw new Error(
        `Native PGlite invalidation hook is unavailable for commit ${manifest.lsn}`,
      )
    }

    let invalidateSystemCaches = input.invalidateSystemCaches
    for (const relation of input.relationCacheInvalidations) {
      const result = nativeModule._pgl_invalidate_remote_relation_cache?.(
        relation.spcOid,
        relation.dbOid,
        relation.relNumber,
      )
      if (result === undefined || result === 0) {
        invalidateSystemCaches = true
        continue
      }
      if (result < 0) {
        throw new Error(
          `Native PGlite relcache invalidation failed with ${result}`,
        )
      }
    }

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
        invalidateSystemCaches,
        input.invalidateSmgr,
        remoteNextXid.low,
        remoteNextXid.high,
      )
      if (result < 0) {
        throw new Error(`Native PGlite invalidation failed with ${result}`)
      }
      this.markHandled(manifest)
    } finally {
      if (rangesPtr !== 0) nativeModule._free(rangesPtr)
    }
  }

  didHandle(manifest: CommitManifest): boolean {
    const handled = this.#lastHandledLsn === manifest.lsn
    if (handled) this.#lastHandledLsn = undefined
    return handled
  }

  private markHandled(manifest: CommitManifest): void {
    this.#lastHandledLsn = manifest.lsn
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
  const ranges = new Map<string, NativeRange[]>()
  const relationCacheInvalidations = new Map<string, NativeRelation>()
  let invalidateSystemCaches = false
  let invalidateSmgr = false

  for (const invalidation of manifestInvalidations(manifest)) {
    if (invalidation.kind === 'system-cache') {
      invalidateSystemCaches = true
      continue
    }
    if (invalidation.kind === 'metadata') {
      const range = nativeRange(invalidation)
      if (!range) {
        invalidateSystemCaches = true
        invalidateSmgr = true
        continue
      }
      addNativeRange(ranges, { ...range, relationSizeChanged: true })
      relationCacheInvalidations.set(nativeRelationKey(range), {
        spcOid: range.spcOid,
        dbOid: range.dbOid,
        relNumber: range.relNumber,
      })
      continue
    }
    if (invalidation.kind === 'whole-file') {
      invalidateSmgr = true
      continue
    }

    const range = nativeRange(invalidation)
    if (!range) continue
    addNativeRange(ranges, range)
  }

  return {
    ranges: [...ranges.values()].flat(),
    invalidateSystemCaches,
    invalidateSmgr,
    relationCacheInvalidations: [...relationCacheInvalidations.values()],
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

function addNativeRange(
  ranges: Map<string, NativeRange[]>,
  range: NativeRange,
): void {
  const key = nativeRangeKey(range)
  const existing = ranges.get(key) ?? []
  const merged: NativeRange[] = []
  let next = { ...range }

  for (const current of existing) {
    if (!nativeRangesCanMerge(current, next)) {
      merged.push(current)
      continue
    }
    next = mergeNativeRanges(current, next)
  }

  merged.push(next)
  merged.sort((left, right) => left.firstBlock - right.firstBlock)
  ranges.set(key, merged)
}

function nativeRangesCanMerge(left: NativeRange, right: NativeRange): boolean {
  const leftEnd = nativeRangeEnd(left)
  const rightEnd = nativeRangeEnd(right)
  return left.firstBlock <= rightEnd && right.firstBlock <= leftEnd
}

function mergeNativeRanges(left: NativeRange, right: NativeRange): NativeRange {
  const firstBlock = Math.min(left.firstBlock, right.firstBlock)
  const end = Math.max(nativeRangeEnd(left), nativeRangeEnd(right))
  return {
    ...left,
    firstBlock,
    blockCount:
      end === Number.POSITIVE_INFINITY ? 0 : Math.max(0, end - firstBlock),
    relationSizeChanged: left.relationSizeChanged || right.relationSizeChanged,
  }
}

function nativeRangeEnd(range: NativeRange): number {
  return range.blockCount === 0
    ? Number.POSITIVE_INFINITY
    : range.firstBlock + range.blockCount
}

function nativeRangeKey(range: NativeRange): string {
  return [range.spcOid, range.dbOid, range.relNumber, range.forkNumber].join(
    '/',
  )
}

function nativeRelationKey(relation: NativeRelation): string {
  return [relation.spcOid, relation.dbOid, relation.relNumber].join('/')
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
