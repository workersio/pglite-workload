import type { PGlite } from '@electric-sql/pglite'
import { PGlite as RealPGlite } from '@electric-sql/pglite'
import { describe, expect, it } from 'vitest'

import { getPGliteWalInsertLsn } from '../src/primary/native-wal-lsn.js'
import { parseLsn } from '../src/shared/lsn.js'

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

  it('reads the native WAL insert LSN from a real PGlite instance', async () => {
    const db = await RealPGlite.create({ dataDir: 'memory://' })
    try {
      await db.exec('CREATE TABLE native_lsn_test (id int primary key)')
      await db.query('INSERT INTO native_lsn_test VALUES (1)')
      await db.exec('CHECKPOINT')

      const lsn = getPGliteWalInsertLsn(db)

      if (lsn === undefined) {
        throw new Error('Expected native WAL insert LSN export')
      }
      expect(lsn).toMatch(/^[0-9A-F]+\/[0-9A-F]{8}$/)
      expect(parseLsn(lsn)).toBeGreaterThan(0n)
    } finally {
      await db.close()
    }
  })
})

function fakePGlite(module: object): PGlite {
  return { Module: module } as PGlite
}
