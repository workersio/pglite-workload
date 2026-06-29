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

  it('does not claim native handling when relation invalidations need a missing hook', () => {
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

    invalidator.invalidate(manifest)

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
}

class FakeNativeModule {
  readonly calls: NativeInvalidationCall[] = []

  readonly freedPointers: number[] = []

  readonly module: NativeModuleFixture

  readonly lastPointer = 8

  constructor({
    exposeHook = true,
    result,
  }: { exposeHook?: boolean; result?: number } = {}) {
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
  }
}
