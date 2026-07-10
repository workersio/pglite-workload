// Workload: tx-atomicity-recovery
// Promise: a transaction that rejects leaves none of its writes and returns the
// single connection immediately usable; a query on the PARENT handle during a
// transaction never hangs forever.
//
// Cases:
//   baseline  — a throwing tx rolls back and the connection stays usable
//   reentrant — a parent-handle query inside a tx callback must settle, not hang
//
// Universal plane: liveness watchdog; the reentrant oracle is itself a bounded
// deadline. ORACLE_SELFTEST=1 plants a violation on baseline (a persisted row).

import { randomBytes } from 'node:crypto'
const PGLITE_BASE = process.env.PGLITE_BASE || new URL('../vendor/pglite/dist/', import.meta.url).href
const { PGlite } = await import(new URL('index.js', PGLITE_BASE).href)

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

async function main() {
  const db = await PGlite.create()
  await db.exec(`CREATE TABLE t (id int primary key, v text);`)

  if (CASE === 'baseline') {
    let threw = false
    try {
      await db.transaction(async (tx) => {
        await tx.query(`INSERT INTO t VALUES (1, 'a')`)
        throw new Error('boom')
      })
    } catch { threw = true }
    if (SELFTEST) {
      // Plant a violation: persist the row the rollback should have removed.
      await db.query(`INSERT INTO t VALUES (1, 'a') ON CONFLICT DO NOTHING`)
    }
    const rows = await db.query(`SELECT * FROM t WHERE id = 1`)
    inv('b1', 'rollback_on_throw', rows.rows.length === 0,
      `rows after throwing tx: ${rows.rows.length} (want 0; threw=${threw}, selftest=${SELFTEST})`)
    const ok = await db.query(`SELECT 1 as x`)
    inv('b2', 'connection_usable_after_abort', ok.rows[0].x === 1,
      `post-abort query returned ${ok.rows[0].x}`)
  } else if (CASE === 'reentrant') {
    // The common mistake: `await db.query(...)` (parent handle) inside a tx
    // callback. The transaction holds the non-reentrant mutex, so this can
    // deadlock. Bound it: if it doesn't settle, that IS the availability bug.
    const RE_DEADLINE = 4000
    let outcome
    try {
      await db.transaction(async () => {
        outcome = await Promise.race([
          db.query(`SELECT 1`).then(() => 'resolved', () => 'rejected'),
          new Promise((r) => setTimeout(() => r('timeout'), RE_DEADLINE)),
        ])
        if (outcome === 'timeout') throw new Error('reentrant call did not settle')
      })
    } catch { /* we may throw to escape a detected hang */ }
    inv('re1', 'no_reentrant_hang', outcome !== 'timeout',
      `parent-handle query inside tx settled as: ${outcome} (deadline ${RE_DEADLINE}ms)`)
  } else {
    console.log(`INVARIANT setup case_unknown FAIL unknown case ${CASE}`)
    failed = true
  }

  await db.close().catch(() => {})
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
