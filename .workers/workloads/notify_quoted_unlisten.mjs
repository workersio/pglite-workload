// Workload: notify-quoted-unlisten
// Promise: the disposer returned by db.listen(channel, cb) removes exactly that
// listener, so a NOTIFY after unsubscribe is not delivered — for any channel
// name, including case-sensitive quoted ones.
//
// Cases:
//   baseline — lowercase channel: unsubscribe via disposer, NOTIFY, no delivery
//   quoted   — case-sensitive quoted channel: same, must not deliver (bug: it does)
//
// Universal plane: liveness watchdog; terminal-state sweep. ORACLE_SELFTEST=1
// skips the unsubscribe on baseline so the "no delivery after unsubscribe"
// oracle is proven able to FAIL.

import { randomBytes } from 'node:crypto'
import { loadPGlite } from './_pglite.mjs'
const { createPGlite } = await loadPGlite()

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

async function settle(ms = 400) {
  // Let queued notification microtasks/callbacks run.
  const start = Date.now()
  while (Date.now() - start < ms) await new Promise((r) => setTimeout(r, 25))
}

async function main() {
  const db = await createPGlite()

  // listenArg is what the user passes to db.listen; notifyName is the exact
  // (case-sensitive) channel string pg_notify targets.
  const { listenArg, notifyName } =
    CASE === 'quoted'
      ? { listenArg: '"MyChannel"', notifyName: 'MyChannel' }
      : { listenArg: 'testchan', notifyName: 'testchan' }

  let fires = 0
  const unsub = await db.listen(listenArg, () => { fires++ })

  // Sanity: while subscribed, a NOTIFY must reach the callback (anti-vacuity
  // that the channel wiring works at all).
  await db.query(`SELECT pg_notify($1, 'x')`, [notifyName])
  await settle()
  const deliveredWhileSubscribed = fires > 0
  inv('s0', 'delivery_while_subscribed', deliveredWhileSubscribed,
    `callback fired ${fires} times while subscribed (channel ${notifyName})`)

  // Unsubscribe via the returned disposer, then NOTIFY again — must NOT deliver.
  if (!SELFTEST) {
    await unsub()
  } // SELFTEST: skip unsubscribe => a later fire => planted violation

  const base = fires
  await db.query(`SELECT pg_notify($1, 'y')`, [notifyName])
  await settle()
  const firedAfterUnsub = fires - base
  inv('u1', 'no_delivery_after_unsubscribe', firedAfterUnsub === 0,
    `callback fired ${firedAfterUnsub} times after unsubscribe (want 0; selftest=${SELFTEST})`)

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
