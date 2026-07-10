// Workload: tx-closed-handle
// Promise: once a transaction is committed or rolled back, any further use of
// its tx handle throws instead of silently running on the auto-commit connection.
//
// Cases:
//   baseline           — tx.query works inside; after commit tx.query rejects
//   sql-after-rollback — tx.sql after tx.rollback() must reject, not persist
//   after-throw        — after a THROWN transaction, tx.query/exec/sql all reject
//
// Universal plane: liveness watchdog; terminal-state sweep (every tx reaches a
// terminal state). ORACLE_SELFTEST=1 plants a violation on the baseline
// "rejects" oracle (checks a live handle) so the red path is proven.

import { randomBytes } from 'node:crypto'
import { PGlite } from '../vendor/pglite/dist/index.js'

const CASE = (() => {
  const i = process.argv.indexOf('--case')
  return i >= 0 ? process.argv[i + 1] : 'baseline'
})()
const SELFTEST = process.env.ORACLE_SELFTEST === '1'
const SEED = randomBytes(4).readUInt32LE(0)
console.log(`SEED=${SEED}`)
console.log(`CASE=${CASE} SELFTEST=${SELFTEST}`)

let failed = false
function inv(id, name, pass, summary) {
  console.log(`INVARIANT ${id} ${name} ${pass ? 'PASS' : 'FAIL'} ${summary}`)
  if (!pass) failed = true
}

const WATCHDOG_MS = 20000
const watchdog = setTimeout(() => {
  console.log(`INVARIANT wd liveness_watchdog FAIL body wedged > ${WATCHDOG_MS}ms (case=${CASE})`)
  process.exit(1)
}, WATCHDOG_MS)
watchdog.unref()

async function rejects(thunk) {
  try { await thunk(); return false } catch { return true }
}

async function main() {
  const db = await PGlite.create()
  await db.exec(`CREATE TABLE t (id int primary key, v text);`)

  if (CASE === 'baseline') {
    let leaked
    await db.transaction(async (tx) => {
      const r = await tx.query('SELECT 1 as x')
      inv('b1', 'tx_query_works_inside', r.rows[0].x === 1, `got ${r.rows[0].x}`)
      leaked = tx
    })
    // After commit, the leaked handle must reject. SELFTEST checks a live
    // handle (db) instead, which never rejects — planting the violation.
    const target = SELFTEST ? db : leaked
    const rej = await rejects(() => target.query('SELECT 1'))
    inv('b2', 'closed_handle_query_rejects', rej,
      `post-commit handle rejected=${rej} (selftest=${SELFTEST})`)
  } else if (CASE === 'sql-after-rollback') {
    let leaked
    try {
      await db.transaction(async (tx) => {
        leaked = tx
        await tx.rollback()
      })
    } catch { /* commit-after-rollback may reject; irrelevant to the leak */ }

    const rej = await rejects(() => leaked.sql`INSERT INTO t VALUES (99, 'leak')`)
    inv('r1', 'tx_sql_after_rollback_rejects', rej,
      `tx.sql on a rolled-back handle rejected=${rej}`)
    const rows = await db.query(`SELECT * FROM t WHERE id = 99`)
    inv('r2', 'leaked_write_not_persisted', rows.rows.length === 0,
      `rows with id=99 after leaked tx.sql: ${rows.rows.length} (want 0)`)
  } else if (CASE === 'after-throw') {
    let leaked
    try {
      await db.transaction(async (tx) => {
        leaked = tx
        throw new Error('boom')
      })
    } catch { /* the throw is expected — the tx must be rolled back and closed */ }

    const qRej = await rejects(() => leaked.query(`INSERT INTO t VALUES (97, 'q')`))
    const eRej = await rejects(() => leaked.exec(`INSERT INTO t VALUES (96, 'e')`))
    const sRej = await rejects(() => leaked.sql`INSERT INTO t VALUES (98, 'sql')`)
    inv('t1', 'tx_query_after_throw_rejects', qRej, `tx.query rejected=${qRej}`)
    inv('t2', 'tx_exec_after_throw_rejects', eRej, `tx.exec rejected=${eRej}`)
    inv('t3', 'tx_sql_after_throw_rejects', sRej, `tx.sql rejected=${sRej}`)
    const rows = await db.query(`SELECT id FROM t WHERE id IN (96,97,98) ORDER BY id`)
    inv('t4', 'no_leaked_writes_persisted', rows.rows.length === 0,
      `leaked writes persisted: ${JSON.stringify(rows.rows.map((r) => r.id))} (want none)`)
  } else {
    console.log(`INVARIANT setup case_unknown FAIL unknown case ${CASE}`)
    failed = true
  }

  await db.close()
}

main()
  .then(() => {
    clearTimeout(watchdog)
    console.log(failed ? 'RESULT=FAIL' : 'RESULT=PASS')
    process.exit(failed ? 1 : 0)
  })
  .catch((e) => {
    clearTimeout(watchdog)
    console.log(`INVARIANT err workload_error FAIL ${e && e.stack ? e.stack.split('\n')[0] : e}`)
    console.log('RESULT=FAIL')
    process.exit(1)
  })
