import { describe, expect, it } from 'vitest'

import { compareLsn, parseLsn } from '../src/shared/lsn.js'

describe('LSN utilities', () => {
  it('compares LSNs within and across high parts', () => {
    expect(compareLsn('0/00000010', '0/00000020')).toBeLessThan(0)
    expect(compareLsn('1/00000000', '0/FFFFFFFF')).toBeGreaterThan(0)
    expect(compareLsn('0/00000010', '0/00000010')).toBe(0)
  })

  it('rejects invalid LSNs', () => {
    expect(() => parseLsn('not-an-lsn')).toThrow(/Invalid LSN/)
  })
})
