// Probe: localize which PGlite operation wedges in the deterministic sim.
// The sync-init shim makes create()+a single query()+close() pass (probe_init_sync),
// but the tx baseline (exec + transaction + more queries) wedges at the watchdog.
// This walks a sequence of op types with a MARK before each so the guest log
// shows the exact last-completed op before the wedge.
import { loadPGlite } from './_pglite.mjs'

const WATCHDOG_MS = 60000
const wd = setTimeout(() => {
  console.log(`INVARIANT wd liveness_watchdog FAIL wedged > ${WATCHDOG_MS}ms`)
  process.exit(1)
}, WATCHDOG_MS)
wd.unref()

// Emit each completed step as an INVARIANT PASS so it shows in the parsed
// `invariants` array (guest stdout.log is not always retrievable). The last
// PASS step before the watchdog FAIL localizes the wedge.
async function step(name, fn) {
  const r = await fn()
  console.log(`INVARIANT step_${name} step_completed PASS ${name} ok`)
  return r
}

try {
  const { createPGlite } = await loadPGlite()
  const db = await step('create', () => createPGlite())
  await step('query1_select', async () => (await db.query('select 1 as a')).rows)
  await step('query2_select', async () => (await db.query('select 2 as b')).rows)
  await step('exec_create_table', () => db.exec('CREATE TABLE t (id int primary key, v text);'))
  await step('query_insert', async () => (await db.query("INSERT INTO t VALUES (1,'a')")).affectedRows)
  await step('query_select_rows', async () => (await db.query('SELECT * FROM t')).rows)
  await step('transaction', async () => {
    let threw = false
    try {
      await db.transaction(async (tx) => {
        await tx.query("INSERT INTO t VALUES (2,'b')")
        throw new Error('boom')
      })
    } catch { threw = true }
    return { threw }
  })
  await step('query_after_tx', async () => (await db.query('SELECT * FROM t')).rows)
  await step('close', () => db.close())
  console.log('INVARIANT probe pglite_ops PASS all ops completed')
  clearTimeout(wd)
  console.log('RESULT=PASS')
  process.exit(0)
} catch (e) {
  console.log('INVARIANT probe pglite_ops FAIL ' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e))
  clearTimeout(wd)
  console.log('RESULT=FAIL')
  process.exit(1)
}
