import { describe, expect, it } from 'vitest'

import { DEFAULT_TABLESPACE_OID, RELSEG_SIZE } from '../src/shared/constants.js'
import {
  classifyPgPath,
  isDurableTimelinePath,
  normalizePgPath,
} from '../src/fs/path-classifier.js'

describe('path classifier', () => {
  it('normalizes postgres paths', () => {
    expect(normalizePgPath('base/5/../5/16384')).toBe('/base/5/16384')
    expect(normalizePgPath('/base//5/./16384')).toBe('/base/5/16384')
  })

  it('classifies default tablespace relation files', () => {
    const classified = classifyPgPath('/base/5/16384')

    expect(classified.kind).toBe('relation')
    if (classified.kind !== 'relation') throw new Error('expected relation')
    expect(classified.tablespaceOid).toBe(DEFAULT_TABLESPACE_OID)
    expect(classified.databaseOid).toBe(5)
    expect(classified.relNumber).toBe(16384)
    expect(classified.fork).toBe('main')
    expect(classified.firstBlock).toBe(0)
  })

  it('classifies relation forks and segments', () => {
    const classified = classifyPgPath('/base/5/16384_fsm.2')

    expect(classified.kind).toBe('relation')
    if (classified.kind !== 'relation') throw new Error('expected relation')
    expect(classified.fork).toBe('fsm')
    expect(classified.segment).toBe(2)
    expect(classified.firstBlock).toBe(2 * RELSEG_SIZE)
  })

  it('classifies global and tablespace relation files', () => {
    const global = classifyPgPath('/global/1262')
    const tablespace = classifyPgPath('/pg_tblspc/999/PG_18_202506022/5/16384')

    expect(global.kind).toBe('relation')
    expect(tablespace.kind).toBe('relation')
    if (tablespace.kind !== 'relation') throw new Error('expected relation')
    expect(tablespace.tablespaceOid).toBe(999)
    expect(tablespace.databaseOid).toBe(5)
  })

  it('classifies control, wal, and temporary paths', () => {
    expect(classifyPgPath('/global/pg_control').kind).toBe('control')
    expect(classifyPgPath('/pg_wal/000000010000000000000001').kind).toBe('wal')
    expect(classifyPgPath('/base/5/pgsql_tmp/pgsql_tmp123').kind).toBe('temp')
  })

  it('excludes replica-local runtime paths from the durable timeline', () => {
    expect(isDurableTimelinePath('/postmaster.pid')).toBe(false)
    expect(isDurableTimelinePath('/postmaster.opts')).toBe(false)
    expect(isDurableTimelinePath('/pg_dynshmem')).toBe(false)
    expect(isDurableTimelinePath('/pg_dynshmem/mmap.1')).toBe(false)
    expect(isDurableTimelinePath('/pg_notify')).toBe(false)
    expect(isDurableTimelinePath('/pg_notify/0000')).toBe(false)
    expect(isDurableTimelinePath('/pg_replslot/demo/state')).toBe(false)
    expect(isDurableTimelinePath('/base/5/pg_internal.init')).toBe(false)
    expect(isDurableTimelinePath('/base/5/pg_internal.init.42')).toBe(false)
    expect(isDurableTimelinePath('/base/5/16384')).toBe(true)
    expect(isDurableTimelinePath('/global/pg_control')).toBe(true)
  })
})
