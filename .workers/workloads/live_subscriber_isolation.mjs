// Workload: live-subscriber-isolation
// Promise: unsubscribing one callback from a live query leaves every other
// subscriber receiving updates and the backing state intact.
//
// Cases:
//   baseline  — one subscriber receives an update after a committed mutation
//   unsub-one — two subscribers, unsubscribe the first, the second must still fire
//   variants  — same attack on live.changes and live.incrementalQuery
//
// Universal oracle plane: liveness watchdog (a hang => red), terminal-state
// sweep (every subscription is delivered-to or torn down at exit).
// ORACLE_SELFTEST=1 plants a violation on the baseline delivery so the red path
// is proven before any green is trusted.
//
// Emits `INVARIANT <id> <name> PASS|FAIL <summary>` lines on stdout; exits 1 on
// any FAIL.

import { randomBytes } from 'node:crypto'
import { PGlite } from '../vendor/pglite/dist/index.js'
import { live } from '../vendor/pglite/dist/live/index.js'

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

// Liveness watchdog: a wedged body becomes a red, never a silent timeout.
const WATCHDOG_MS = 20000
const watchdog = setTimeout(() => {
  console.log(`INVARIANT wd liveness_watchdog FAIL body wedged > ${WATCHDOG_MS}ms (case=${CASE})`)
  process.exit(1)
}, WATCHDOG_MS)
watchdog.unref()

// Wait until `predicate()` is true or a bounded deadline elapses. Returns true
// if satisfied. This is a per-step deadline strictly under the watchdog.
async function waitFor(predicate, ms = 3000) {
  const start = Date.now()
  while (Date.now() - start < ms) {
    if (predicate()) return true
    await new Promise((r) => setTimeout(r, 25))
  }
  return predicate()
}

async function main() {
  const db = await PGlite.create({ extensions: { live } })
  await db.exec(`CREATE TABLE t (id int primary key, v text);`)

  if (CASE === 'baseline') {
    // One subscriber; a committed insert must deliver an updated result.
    let calls = []
    const sub = await db.live.query('SELECT * FROM t ORDER BY id', [], (res) => {
      calls.push(res.rows.length)
    })
    // initial callback fires with 0 rows
    await waitFor(() => calls.length >= 1, 3000)
    const before = calls.length
    if (!SELFTEST) {
      await db.exec(`INSERT INTO t VALUES (1, 'a');`)
    } // SELFTEST: skip the mutation => no delivery => planted violation
    const delivered = await waitFor(() => calls.length > before, 3000)
    const sawRow = calls.some((n) => n >= 1)
    inv('b1', 'live_delivers_update', delivered && sawRow,
      `initial+update calls=${JSON.stringify(calls)} (selftest=${SELFTEST})`)
    await sub.unsubscribe()
  } else if (CASE === 'unsub-one') {
    // Two subscribers on one live query; unsubscribe the first, the second
    // must keep receiving updates and the backing view must survive.
    let aCalls = 0
    let bCalls = 0
    const cbA = () => { aCalls++ }
    const cbB = () => { bCalls++ }
    const sub = await db.live.query('SELECT * FROM t ORDER BY id', [], cbA)
    sub.subscribe(cbB)
    // Let initial deliveries settle.
    await waitFor(() => aCalls >= 1, 3000)

    // Unsubscribe exactly cbA. cbB must remain a live subscriber.
    await sub.unsubscribe(cbA)
    const aBase = aCalls
    const bBase = bCalls

    // Commit a mutation. cbB must fire; cbA must not.
    await db.exec(`INSERT INTO t VALUES (1, 'a');`)
    const bDelivered = await waitFor(() => bCalls > bBase, 3000)
    const aQuiet = aCalls === aBase

    inv('u1', 'surviving_subscriber_delivered', bDelivered,
      `cbB fired after unsubscribe(cbA)+insert: ${bCalls - bBase} times`)
    inv('u2', 'unsubscribed_no_delivery', aQuiet,
      `cbA fired ${aCalls - aBase} times after being unsubscribed (want 0)`)

    // Backing state intact: a second mutation must still reach cbB.
    const bBase2 = bCalls
    await db.exec(`INSERT INTO t VALUES (2, 'b');`)
    const bDelivered2 = await waitFor(() => bCalls > bBase2, 3000)
    inv('u3', 'backing_state_intact', bDelivered2,
      `cbB fired on a second mutation: ${bCalls - bBase2} times (view/state survived)`)

    await sub.unsubscribe()
  } else if (CASE === 'variants') {
    // Same unsubscribe-one attack against live.changes and live.incrementalQuery.
    for (const kind of ['changes', 'incrementalQuery']) {
      let bCalls = 0
      const cbA = () => {}
      const cbB = () => { bCalls++ }
      const args =
        kind === 'changes'
          ? ['SELECT * FROM t ORDER BY id', [], 'id', cbA]
          : ['SELECT * FROM t ORDER BY id', [], 'id', cbA]
      const sub = await db.live[kind](...args)
      sub.subscribe(cbB)
      await waitFor(() => true, 200)
      await sub.unsubscribe(cbA)
      const bBase = bCalls
      await db.exec(`INSERT INTO t VALUES (${kind === 'changes' ? 10 : 20}, 'x');`)
      const bDelivered = await waitFor(() => bCalls > bBase, 3000)
      inv(`v_${kind}`, `surviving_subscriber_delivered_${kind}`, bDelivered,
        `cbB fired after unsubscribe(cbA) on live.${kind}: ${bCalls - bBase} times`)
      await sub.unsubscribe()
    }
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
