// Probe: localize the LISTEN/NOTIFY wedge in the sim (BLOCKER #2).
// Reliable init is in place (_pglite.mjs sync-instantiate); the notify + live
// baselines still wedge post-init. Source says delivery is queueMicrotask and
// #listen is a plain exec — both should work in-sim — so localize the exact op.
// Uses writeSync fd-1 marks (survive an abrupt watchdog exit).
import { loadPGlite } from './_pglite.mjs'
import { writeSync } from 'node:fs'
const emit = (s) => writeSync(1, s + '\n')

const WATCHDOG_MS = 45000
const wd = setTimeout(() => { emit(`INVARIANT wd liveness_watchdog FAIL wedged > ${WATCHDOG_MS}ms`); process.exit(1) }, WATCHDOG_MS)
wd.unref()

async function step(name, fn) {
  emit(`INVARIANT step_${name} m PASS reached`)
  const r = await fn()
  emit(`INVARIANT done_${name} m PASS done`)
  return r
}

try {
  const { createPGlite } = await loadPGlite()
  const db = await step('create', () => createPGlite())
  let fires = 0
  const unsub = await step('listen', () => db.listen('testchan', () => { fires++ }))
  await step('pg_notify', async () => (await db.query(`SELECT pg_notify('testchan','x')`)).rows)
  // BLOCKER #2 probe: notification delivery is queueMicrotask (pglite.ts:1105),
  // and after the LISTEN/NOTIFY path a setTimeout never fires (macrotask
  // starvation). So drain MICROTASKS instead of using a timer.
  await step('settle_microtask', async () => { for (let i = 0; i < 100; i++) await Promise.resolve() })
  emit(`INVARIANT deliver fires_after_notify ${fires > 0 ? 'PASS' : 'FAIL'} fires=${fires}`)
  await step('unlisten', () => unsub())
  await step('close', () => db.close())
  emit('INVARIANT probe pglite_listen PASS all ops completed')
  clearTimeout(wd); emit('RESULT=PASS'); process.exit(0)
} catch (e) {
  emit('INVARIANT probe pglite_listen FAIL ' + (e && e.stack ? e.stack.split('\n').slice(0, 2).join(' | ') : e))
  clearTimeout(wd); emit('RESULT=FAIL'); process.exit(1)
}
