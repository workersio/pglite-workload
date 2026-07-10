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

## Oracle plane conventions used here (node workloads)
- Liveness watchdog: `setTimeout(...).unref()` → emits `INVARIANT wd
  liveness_watchdog FAIL` and `process.exit(1)` on wedge.
- ORACLE_SELFTEST=1 plants one violation (skip the mutation / check a live
  handle) so the red path is proven before any green is trusted.
- Anti-vacuity: each promise's baseline case must be green (and its selftest red)
  before the attack case's negative assertions are trusted.
