// Probe: characterize where PGlite init hangs in the deterministic sim.
// Prints coarse progress marks around create()/first query with a long watchdog.
const PGLITE_BASE = process.env.PGLITE_BASE || new URL('../vendor/pglite/dist/', import.meta.url).href
console.log('MARK a_start base=' + PGLITE_BASE)

const WATCHDOG_MS = 90000
const wd = setTimeout(() => {
  console.log(`INVARIANT wd liveness_watchdog FAIL wedged > ${WATCHDOG_MS}ms`)
  process.exit(1)
}, WATCHDOG_MS)
wd.unref()

try {
  console.log('MARK b_import')
  const mod = await import(new URL('index.js', PGLITE_BASE).href)
  console.log('MARK c_imported keys=' + Object.keys(mod).join(','))
  const { PGlite } = mod
  console.log('MARK d_before_create')
  const db = await PGlite.create()
  console.log('MARK e_created')
  const r = await db.query('select 1 as one')
  console.log('MARK f_queried rows=' + JSON.stringify(r.rows))
  await db.close()
  console.log('MARK g_closed')
  console.log('INVARIANT probe pglite_init PASS created+queried+closed')
  clearTimeout(wd)
  console.log('RESULT=PASS')
  process.exit(0)
} catch (e) {
  console.log('INVARIANT probe pglite_init FAIL ' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e))
  clearTimeout(wd)
  console.log('RESULT=FAIL')
  process.exit(1)
}
