import type { PGlite } from '@electric-sql/pglite'
import { describe, expect, it } from 'vitest'

import { PGliteNativeInvalidator } from '../src/replica/native-invalidator.js'
import type { CommitManifest } from '../src/pageserver/types.js'

describe('PGliteNativeInvalidator', () => {
  it('packs relation ranges and calls the native invalidation hook', () => {
    const native = new FakeNativeModule()
    const manifest = baseManifest({
      transactionState: { nextFullXid: String(0x100000002n) },
      invalidations: [
        {
          kind: 'relation-range',
          path: '/base/5/123',
          spcOid: 1663,
          dbOid: 5,
          relNumber: 123,
          fork: 'vm',
          firstBlock: 4,
          blockCount: 2,
          relationSizeChanged: true,
        },
        { kind: 'system-cache', path: '/global/1262' },
      ],
    })
    const invalidator = new PGliteNativeInvalidator(() =>
      fakePGlite(native.module),
    )

    invalidator.invalidate(manifest)

    expect(native.calls).toEqual([
      {
        ranges: [1663, 5, 123, 2, 4, 2, 1],
        rangesLength: 1,
        invalidateSystemCaches: true,
        invalidateSmgr: false,
        remoteNextXidLow: 2,
        remoteNextXidHigh: 1,
      },
    ])
    expect(native.freedPointers).toEqual([native.lastPointer])
    expect(invalidator.didHandle(manifest)).toBe(true)
    expect(invalidator.didHandle(manifest)).toBe(false)
  })

  it('keeps non-contiguous relation ranges separate', () => {
    const native = new FakeNativeModule()
    const manifest = baseManifest({
      invalidations: [
        relationRange({ firstBlock: 1 }),
        relationRange({ firstBlock: 5 }),
      ],
    })
    const invalidator = new PGliteNativeInvalidator(() =>
      fakePGlite(native.module),
    )

    invalidator.invalidate(manifest)

    expect(native.calls[0]?.ranges).toEqual([
      1663, 5, 123, 0, 1, 1, 0, 1663, 5, 123, 0, 5, 1, 0,
    ])
    expect(native.calls[0]?.rangesLength).toBe(2)
  })

  it('merges adjacent relation ranges without widening to the whole fork', () => {
    const native = new FakeNativeModule()
    const manifest = baseManifest({
      invalidations: [
        relationRange({ firstBlock: 1 }),
        relationRange({ firstBlock: 2 }),
        relationRange({ firstBlock: 3 }),
      ],
    })
    const invalidator = new PGliteNativeInvalidator(() =>
      fakePGlite(native.module),
    )

    invalidator.invalidate(manifest)

    expect(native.calls[0]?.ranges).toEqual([1663, 5, 123, 0, 1, 3, 0])
    expect(native.calls[0]?.rangesLength).toBe(1)
  })

  it('targets relcache invalidation for relation metadata changes', () => {
    const native = new FakeNativeModule({ relationCacheResult: 1 })
    const manifest = baseManifest({
      invalidations: [
        {
          kind: 'metadata',
          path: '/base/5/123',
          spcOid: 1663,
          dbOid: 5,
          relNumber: 123,
          fork: 'main',
          firstBlock: 0,
          blockCount: 0,
          relationSizeChanged: true,
        },
      ],
    })
    const invalidator = new PGliteNativeInvalidator(() =>
      fakePGlite(native.module),
    )

    invalidator.invalidate(manifest)

    expect(native.relationCacheCalls).toEqual([
      { spcOid: 1663, dbOid: 5, relNumber: 123 },
    ])
    expect(native.calls[0]).toMatchObject({
      ranges: [1663, 5, 123, 0, 0, 0, 1],
      invalidateSystemCaches: false,
      invalidateSmgr: false,
    })
  })

  it('falls back to broad system cache invalidation when targeted relcache misses', () => {
    const native = new FakeNativeModule({ relationCacheResult: 0 })
    const manifest = baseManifest({
      invalidations: [
        {
          kind: 'metadata',
          path: '/base/5/123',
          spcOid: 1663,
          dbOid: 5,
          relNumber: 123,
          fork: 'main',
          firstBlock: 0,
          blockCount: 0,
        },
      ],
    })
    const invalidator = new PGliteNativeInvalidator(() =>
      fakePGlite(native.module),
    )

    invalidator.invalidate(manifest)

    expect(native.calls[0]?.invalidateSystemCaches).toBe(true)
  })

  it('fails closed when relation invalidations need a missing native hook', () => {
    const manifest = baseManifest({
      invalidations: [
        {
          kind: 'relation-range',
          path: '/base/5/123',
          spcOid: 1663,
          dbOid: 5,
          relNumber: 123,
          fork: 'main',
          firstBlock: 0,
        },
      ],
    })
    const invalidator = new PGliteNativeInvalidator(() =>
      fakePGlite(new FakeNativeModule({ exposeHook: false }).module),
    )

    expect(() => invalidator.invalidate(manifest)).toThrow(
      'Native PGlite invalidation hook is unavailable for commit 0/00000010',
    )
    expect(invalidator.didHandle(manifest)).toBe(false)
  })

  it('claims no-op manifests without requiring a native hook', () => {
    const manifest = baseManifest()
    const invalidator = new PGliteNativeInvalidator(() => undefined)

    invalidator.invalidate(manifest)

    expect(invalidator.didHandle(manifest)).toBe(true)
  })

  it('throws when the native hook reports an error', () => {
    const native = new FakeNativeModule({ result: -3 })
    const manifest = baseManifest({
      invalidations: [
        {
          kind: 'relation-range',
          path: '/base/5/123',
          spcOid: 1663,
          dbOid: 5,
          relNumber: 123,
          fork: 'main',
          firstBlock: 0,
        },
      ],
    })
    const invalidator = new PGliteNativeInvalidator(() =>
      fakePGlite(native.module),
    )

    expect(() => invalidator.invalidate(manifest)).toThrow(
      'Native PGlite invalidation failed with -3',
    )
    expect(native.freedPointers).toEqual([native.lastPointer])
  })
})

function relationRange({
  firstBlock,
}: {
  firstBlock: number
}): CommitManifest['invalidations'][number] {
  return {
    kind: 'relation-range',
    path: '/base/5/123',
    spcOid: 1663,
    dbOid: 5,
    relNumber: 123,
    fork: 'main',
    firstBlock,
    blockCount: 1,
  }
}

function baseManifest(overrides: Partial<CommitManifest> = {}): CommitManifest {
  return {
    version: 1,
    timelineId: 'native-demo',
    lsn: '0/00000010',
    commitId: 'commit-1',
    createdAt: new Date(0).toISOString(),
    replicaApplyMode: 'live-invalidate',
    operations: [],
    invalidations: [],
    stats: {
      pageCount: 0,
      fileCount: 0,
      metadataCount: 0,
      invalidationCount: 0,
      byteCount: 0,
    },
    ...overrides,
  }
}

function fakePGlite(module: NativeModuleFixture): PGlite {
  return { Module: module } as unknown as PGlite
}

interface NativeInvalidationCall {
  ranges: number[]
  rangesLength: number
  invalidateSystemCaches: boolean
  invalidateSmgr: boolean
  remoteNextXidLow: number
  remoteNextXidHigh: number
}

interface NativeModuleFixture {
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

class FakeNativeModule {
  readonly calls: NativeInvalidationCall[] = []

  readonly relationCacheCalls: NativeRelationCacheCall[] = []

  readonly freedPointers: number[] = []

  readonly module: NativeModuleFixture

  readonly lastPointer = 8

  constructor({
    exposeHook = true,
    result,
    relationCacheResult,
  }: {
    exposeHook?: boolean
    result?: number
    relationCacheResult?: number
  } = {}) {
    this.module = {
      HEAPU32: new Uint32Array(64),
      _malloc: () => this.lastPointer,
      _free: (ptr) => {
        this.freedPointers.push(ptr)
      },
    }
    if (exposeHook) {
      this.module._pgl_invalidate_remote_pages = (
        rangesPtr,
        rangesLength,
        invalidateSystemCaches,
        invalidateSmgr,
        remoteNextXidLow,
        remoteNextXidHigh,
      ) => {
        const rangeStart = rangesPtr >>> 2
        const rangeEnd = rangeStart + rangesLength * 7
        this.calls.push({
          ranges: [...this.module.HEAPU32.slice(rangeStart, rangeEnd)],
          rangesLength,
          invalidateSystemCaches,
          invalidateSmgr,
          remoteNextXidLow,
          remoteNextXidHigh,
        })
        return result ?? rangesLength
      }
    }
    if (relationCacheResult !== undefined) {
      this.module._pgl_invalidate_remote_relation_cache = (
        spcOid,
        dbOid,
        relNumber,
      ) => {
        this.relationCacheCalls.push({ spcOid, dbOid, relNumber })
        return relationCacheResult
      }
    }
  }
}

interface NativeRelationCacheCall {
  spcOid: number
  dbOid: number
  relNumber: number
}
