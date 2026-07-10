// Shared PGlite loader for guest workloads.
//
// Why this exists: PGlite.create() with default options wedges in the wio
// deterministic sim. Init hits two genuinely event-loop-blocked ops the sim
// does not pump:
//   1. WebAssembly.instantiate(buffer, imports) — async WASM *compile*
//   2. fs.readFile(...) for pglite.wasm / pglite.data — async libuv fs
// Both have microtask-only alternatives that the sim DOES service, reachable
// through PGlite's injection options:
//   - pgliteWasmModule / initdbWasmModule : a pre-compiled WebAssembly.Module
//       (compiled synchronously here via `new WebAssembly.Module(bytes)`), so
//       instantiateWasm() takes the already-compiled branch.
//   - fsBundle : a Blob, so getFsBundle()'s async readFile is skipped.
// Confirmed unblocking the guest via probe_init_sync.mjs (see executor-notes
// §OPEN BLOCKER → RESOLVED).
//
// Usage in a workload:
//   import { loadPGlite } from './_pglite.mjs'
//   const { PGlite, createPGlite, PGLITE_BASE } = await loadPGlite()
//   const db = await createPGlite()                    // or ({ extensions: { live } })
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export const PGLITE_BASE =
  process.env.PGLITE_BASE || new URL('../vendor/pglite/dist/', import.meta.url).href

const artifact = (name) => fileURLToPath(new URL(name, PGLITE_BASE))

let _cache = null

// Load the pglite module + pre-build the sync-init injections once per process.
export async function loadPGlite() {
  if (_cache) return _cache
  const mod = await import(new URL('index.js', PGLITE_BASE).href)
  const { PGlite } = mod

  const pgliteWasmModule = new WebAssembly.Module(readFileSync(artifact('pglite.wasm')))
  const initdbWasmModule = new WebAssembly.Module(readFileSync(artifact('initdb.wasm')))
  const fsBundle = new Blob([readFileSync(artifact('pglite.data'))])
  const syncInit = { pgliteWasmModule, initdbWasmModule, fsBundle }

  // createPGlite(extraOpts) merges the sync-init injections with caller options.
  const createPGlite = (extraOpts = {}) => PGlite.create({ ...syncInit, ...extraOpts })

  _cache = { PGlite, mod, createPGlite, syncInit, PGLITE_BASE }
  return _cache
}

// Convenience: load a submodule (e.g. 'live/index.js') from the same base.
export async function loadSub(rel) {
  return import(new URL(rel, PGLITE_BASE).href)
}
