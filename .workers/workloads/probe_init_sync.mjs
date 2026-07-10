// Probe (sync-init shim): test whether pre-compiling the WASM modules
// synchronously and passing the FS bundle as a Blob sidesteps the guest wedge.
//
// Diagnosis (triage 2026-07-10): PGlite.create() wedges in the deterministic
// sim because init hits two genuinely event-loop-blocked ops that the sim does
// not pump:
//   1. WebAssembly.instantiate(buffer, imports)  — async WASM *compile*
//   2. fs.readFile(...) for pglite.wasm and pglite.data (async libuv fs)
// PGlite exposes injection options that skip both:
//   - pgliteWasmModule / initdbWasmModule : a pre-compiled WebAssembly.Module,
//       so instantiateWasm() takes the `if (module)` branch — instantiation of
//       an already-compiled module resolves on a microtask, not a libuv task.
//   - fsBundle : a Blob, so getFsBundle() is skipped and .arrayBuffer() is a
//       microtask.
// If this probe reaches MARK e_created in the sim, the blocker is resolvable at
// the workload level and all guest verdicts unblock. If it still wedges, the
// gap is deeper (microtask/WASM-instantiate itself unserviced) → escalate to
// formal (wio).
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const PGLITE_BASE = process.env.PGLITE_BASE || new URL('../vendor/pglite/dist/', import.meta.url).href
console.log('MARK a_start base=' + PGLITE_BASE)

const WATCHDOG_MS = 90000
const wd = setTimeout(() => {
  console.log(`INVARIANT wd liveness_watchdog FAIL wedged > ${WATCHDOG_MS}ms`)
  process.exit(1)
}, WATCHDOG_MS)
wd.unref()

const artifact = (name) => fileURLToPath(new URL(name, PGLITE_BASE))

try {
  console.log('MARK b_import')
  const mod = await import(new URL('index.js', PGLITE_BASE).href)
  console.log('MARK c_imported keys=' + Object.keys(mod).join(','))
  const { PGlite } = mod

  // Synchronous artifact load + compile — no async fs, no async compile.
  console.log('MARK c1_read_wasm')
  const pgliteWasmBytes = readFileSync(artifact('pglite.wasm'))
  const initdbWasmBytes = readFileSync(artifact('initdb.wasm'))
  const fsDataBytes = readFileSync(artifact('pglite.data'))
  console.log(`MARK c2_read_done pglite=${pgliteWasmBytes.length} initdb=${initdbWasmBytes.length} data=${fsDataBytes.length}`)

  console.log('MARK c3_compile')
  const pgliteWasmModule = new WebAssembly.Module(pgliteWasmBytes)
  const initdbWasmModule = new WebAssembly.Module(initdbWasmBytes)
  const fsBundle = new Blob([fsDataBytes])
  console.log('MARK c4_compiled')

  console.log('MARK d_before_create')
  const db = await PGlite.create({ pgliteWasmModule, initdbWasmModule, fsBundle })
  console.log('MARK e_created')
  const r = await db.query('select 1 as one')
  console.log('MARK f_queried rows=' + JSON.stringify(r.rows))
  await db.close()
  console.log('MARK g_closed')
  console.log('INVARIANT probe pglite_init_sync PASS created+queried+closed')
  clearTimeout(wd)
  console.log('RESULT=PASS')
  process.exit(0)
} catch (e) {
  console.log('INVARIANT probe pglite_init_sync FAIL ' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e))
  clearTimeout(wd)
  console.log('RESULT=FAIL')
  process.exit(1)
}
