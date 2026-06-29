import { describe, expect, it } from 'vitest'

import {
  compareLsn,
  formatLsn,
  incrementLsn,
  parseLsn,
} from '../src/shared/lsn.js'

describe('LSN utilities', () => {
  it('compares LSNs within and across high parts', () => {
    expect(compareLsn('0/00000010', '0/00000020')).toBeLessThan(0)
    expect(compareLsn('1/00000000', '0/FFFFFFFF')).toBeGreaterThan(0)
    expect(compareLsn('0/00000010', '0/00000010')).toBe(0)
  })

  it('rejects invalid LSNs', () => {
    expect(() => parseLsn('not-an-lsn')).toThrow(/Invalid LSN/)
  })

  it('formats and increments LSN values', () => {
    expect(formatLsn(0x100000010n)).toBe('1/00000010')
    expect(incrementLsn(undefined)).toBe('0/00000010')
    expect(incrementLsn('0/FFFFFFF0')).toBe('1/00000000')
  })
})
