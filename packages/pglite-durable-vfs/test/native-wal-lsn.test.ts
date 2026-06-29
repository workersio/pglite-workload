import type { PGlite } from '@electric-sql/pglite'
import { describe, expect, it } from 'vitest'

import { getPGliteWalInsertLsn } from '../src/primary/native-wal-lsn.js'

describe('getPGliteWalInsertLsn', () => {
  it('formats low and high native LSN words', () => {
    const db = fakePGlite({
      _pgl_current_wal_insert_lsn_low: () => 0x89abcdef,
      _pgl_current_wal_insert_lsn_high: () => 0x12,
    })

    expect(getPGliteWalInsertLsn(db)).toBe('12/89ABCDEF')
  })

  it('returns undefined when the native exports are unavailable', () => {
    expect(getPGliteWalInsertLsn(fakePGlite({}))).toBeUndefined()
    expect(getPGliteWalInsertLsn(undefined)).toBeUndefined()
  })
})

function fakePGlite(module: object): PGlite {
  return { Module: module } as PGlite
}
