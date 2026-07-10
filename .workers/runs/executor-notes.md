# Executor playbook — pglite guest reality

Environment quirks and setup traps learned by executor episodes. Read before
building a workload; append what you learn.

## Guest environment (wio alpine-node image)
- Node present (**v20.15.1** in guest; box has v22 — do not rely on v22-only APIs).
- Workspace is the **committed git tree** at `/workspace` (pushed HEAD). Runs do
  NOT see `build.sh` output — anything gitignored is absent in the guest.
- Evidence channel: stdout `INVARIANT <id> <name> PASS|FAIL <summary>` lines.
  A red is an emitted `INVARIANT … FAIL`, not a nonzero exit. An exit-1 with no
  invariant lines shows as `state: failed` (crash/setup), NOT a violation.

## The vendored-pglite trap (SOLVED)
`.workers/vendor/node_modules/@electric-sql/pglite` is **gitignored**, and the
convenience symlink `.workers/vendor/pglite` is an **absolute host path**. So in
the guest, `import '../vendor/pglite/dist/index.js'` fails with
`ERR_MODULE_NOT_FOUND` (`state: failed`, not a real verdict — first publish of
the 8 officials hit exactly this).

**Fix (in place):** `.workers/workloads/_run.sh` extracts the committed npm
tarball into `/tmp/pglite` on first use and exports `PGLITE_BASE`. Every workload
resolves the dist via:
```js
const PGLITE_BASE = process.env.PGLITE_BASE || new URL('../vendor/pglite/dist/', import.meta.url).href
const { PGlite } = await import(new URL('index.js', PGLITE_BASE).href)
```
So: **command is `sh .workers/workloads/_run.sh .workers/workloads/<file>.mjs --case <case>`**,
never bare `node …`. Local runs still work (PGLITE_BASE unset → local vendored
symlink). `/tmp` is writable in-guest; `/workspace` writability is untested —
_run.sh avoids it by extracting to /tmp.

## OPEN BLOCKER #2 (2026-07-10): LISTEN/NOTIFY + live-query setup wedges in the sim
After the init blocker was resolved, the 10 officials ran with REAL init. The
tx/query-exec workloads produce clean guest verdicts, but **every notify and
live-query workload wedges at the 20s liveness watchdog** — including the
BASELINE (anti-vacuity control), e.g. `live-subscriber-isolation-baseline` and
`notify-quoted-unlisten-baseline` both `state: failed`, invariant
`wd liveness_watchdog FAIL body wedged > 20000ms (case=baseline)`.

**Localized:** plain `db.query`/`db.exec` work in-guest (probe + tx-family
prove it). The hang is at the subscription SETUP await:
- `await db.listen(channel, cb)` (notify_quoted_unlisten.mjs:57)
- `await db.live.query(sql, [], cb)` (live_subscriber_isolation.mjs:66)
The workload's own bounded helpers (`settle()`, `waitFor()`) use `setTimeout`
polling, which DOES fire in the sim (so they are not the cause; the wedge is
strictly before them). So PGlite's LISTEN/live subsystem setup depends on an
async event the deterministic sim does not deliver — same root class as the
init wedge, but internal to the runtime and NOT bypassable with an injection
option.

**Impact:** anti-vacuity is broken IN-GUEST for the `notify-quoted-unlisten`
and `live-subscriber-isolation` promises — their baselines can't go green in
the sim, so their attack-case guest reds are watchdog-wedges, not trustworthy
oracle results. **Both findings stand on LOCAL reproduction** (local baseline
green, selftest red, attack red — solid, deterministic). Only the guest
*publication* of these two is affected; the tx-family findings are unaffected.

**Next-session leads (cheapest first):**
1. Coarse MARK-probe around `db.listen()` / `db.live.query()` under a 60s
   watchdog to confirm setup (not delivery) is the exact hang and time it.
2. Inspect PGlite's notify/live setup path (`pglite.ts #listen`, `live/index.ts`)
   for a `MessageChannel`/`setImmediate`/`queueMicrotask` await the sim skips —
   if it is a `setTimeout(0)` it should fire, so the culprit is a non-timer
   async primitive.
3. If unshimmable at the workload level, this is a wio sim-integration gap
   (the sim must pump PGlite's async event delivery) → candidate escalation to
   formal, distinct from the (resolved) init blocker.

## RESOLVED BLOCKER (2026-07-10): PGlite WASM init wedges in the deterministic sim
**FIX: sync-init shim.** Init wedged on two event-loop-blocked ops the sim does
not pump: (1) `WebAssembly.instantiate(buffer, imports)` async *compile*, and
(2) async `fs.readFile` for `pglite.wasm`/`pglite.data`. Both have microtask-only
alternatives the sim DOES service, reachable via PGlite injection options:
`pgliteWasmModule` + `initdbWasmModule` (pre-compiled `new WebAssembly.Module(bytes)`)
and `fsBundle` (a `Blob`, skips `getFsBundle`'s async read). Factored into
`.workers/workloads/_pglite.mjs` (`loadPGlite()` → `createPGlite(opts)`); every
workload must create the DB through it, never bare `PGlite.create()`.

**Proof:** `probe_init_sync.mjs` official run `01KX5ZJDFVD51Y1QBJTCAFE4WM`
(exploration `nd752z7qrew5vktsdy0dznandn8a85g1`, HEAD 4393d42) → `state: succeeded`,
`INVARIANT probe pglite_init_sync PASS created+queried+closed`, exit 0, at
vtime ~976s. NOT a wio product bug — no escalation to formal needed.

### (historical) original blocker analysis
## OPEN BLOCKER: PGlite WASM init wedges in the deterministic sim
After the import fix, every guest run reaches `SEED=`/`CASE=` (printed before
`PGlite.create()`) and then **wedges** — the liveness watchdog fires at 20s and
virtual time fast-forwards to it (VTIME jumps ~96s), meaning the process went
**idle** with only the watchdog timer pending. So `PGlite.create()` returns a
promise that never resolves in the sim: PGlite's emscripten async init is
waiting on an event the deterministic simulator does not deliver (suspected
`MessageChannel`/`setImmediate`/microtask-scheduling path used by emscripten's
async WASM instantiation). Locally (real node) the same call resolves in <1s.

This blocks ALL official guest verdicts — every run shows `state: failed` with
`INVARIANT wd liveness_watchdog FAIL`, NOT the real oracle result. The three
findings stand on **local** reproduction (strong, replayable, deterministic);
the guest publication is parked on this blocker.

**Probe result (2026-07-10, run 01KX5YSEWYF6DJZT965XD5JCMC):** `probe_init.mjs`
with `--mem 2048 --timeout 120` prints `MARK d_before_create` then wedges — the
hang is precisely inside `PGlite.create()`, and it is NOT memory- or
timeout-bound. Import resolves fine (`c_imported`). So emscripten's async WASM/
data init inside create() never completes in the sim. Strongly points to a
simulator scheduling gap (async `fs` callback / MessageChannel / setImmediate not
serviced) → escalate to formal (wio) as a product-integration bug, unless a
PGlite eager/sync-init or CJS path sidesteps it.

Next-session leads to try (cheapest first):
1. A minimal probe workload: `PGlite.create()` then print a MARK — confirm
   create() is the exact hang point and time it under a longer watchdog (60s+).
2. Bump `--mem` (WASM may need >1024 MiB) and/or `--timeout`; raise the workload
   watchdog above the sim's init cost.
3. Check whether PGlite exposes a sync/eager init or a way to avoid the
   MessageChannel path in node; try `import '.../dist/index.cjs'` (CJS build) in
   case the ESM async path differs.
4. If it is a simulator scheduling gap (MessageChannel not serviced), that is a
   wio-side integration issue to file against the product (formal), not a pglite
   bug — record as such.

## Oracle plane conventions used here (node workloads)
- Liveness watchdog: `setTimeout(...).unref()` → emits `INVARIANT wd
  liveness_watchdog FAIL` and `process.exit(1)` on wedge.
- ORACLE_SELFTEST=1 plants one violation (skip the mutation / check a live
  handle) so the red path is proven before any green is trusted.
- Anti-vacuity: each promise's baseline case must be green (and its selftest red)
  before the attack case's negative assertions are trusted.
