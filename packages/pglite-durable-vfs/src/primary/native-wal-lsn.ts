import type { PGlite } from '@electric-sql/pglite'

import { formatLsn } from '../shared/lsn.js'

interface NativeWalLsnModule {
  _pgl_current_wal_insert_lsn_low?: () => number
  _pgl_current_wal_insert_lsn_high?: () => number
}

export function getPGliteWalInsertLsn(
  db: PGlite | undefined,
): string | undefined {
  const module = pgliteNativeWalLsnModule(db)
  if (!module) return undefined

  const low = module._pgl_current_wal_insert_lsn_low() >>> 0
  const high = module._pgl_current_wal_insert_lsn_high() >>> 0
  return formatLsn((BigInt(high) << 32n) | BigInt(low))
}

function pgliteNativeWalLsnModule(
  db: PGlite | undefined,
): Required<NativeWalLsnModule> | undefined {
  if (!db) return undefined
  const module = db.Module as unknown
  if (!module || typeof module !== 'object') return undefined

  const candidate = module as NativeWalLsnModule
  if (
    typeof candidate._pgl_current_wal_insert_lsn_low !== 'function' ||
    typeof candidate._pgl_current_wal_insert_lsn_high !== 'function'
  ) {
    return undefined
  }
  return candidate as Required<NativeWalLsnModule>
}
