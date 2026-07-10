# Run: tx-atomicity-recovery-reentrant — FINDING (red)

- explorations: `tx-atomicity-recovery-baseline` (green), `tx-atomicity-recovery-reentrant` (finding)
- promise: `tx-atomicity-recovery` (area transactions)
- target commit: `1a4cce1` (`@electric-sql/pglite` 0.5.4, vendored runtime)
- harness: local node v22 draft against `.workers/vendor/pglite`. wio official: blocked (guest-init blocker — see executor-notes §OPEN BLOCKER).
- command: `node .workers/workloads/tx_atomicity_recovery.mjs --case {baseline,reentrant}`

## Verdict: FINDING — availability (severity 2)

Issuing a query on the **parent** `db` handle from inside a `db.transaction()`
callback deadlocks the entire instance forever — the promise never settles.

### Invariant results
```
# baseline (anti-vacuity)
INVARIANT b1 rollback_on_throw               PASS rows=0
INVARIANT b2 connection_usable_after_abort   PASS
#   ORACLE_SELFTEST=1 -> b1 FAIL (red path proven)

# reentrant
INVARIANT re1 no_reentrant_hang  FAIL parent-handle query inside tx settled as: timeout (deadline 4000ms)
```

### Root cause (source-confirmed by strategy-critic)
PGlite is a single connection guarded by a **non-reentrant** `async-mutex`
(`pglite.ts:96` `#transactionMutex`; `_runExclusiveTransaction` `pglite.ts:1285`).
`db.query`/`db.exec`/`db.transaction` all wrap in `_runExclusiveTransaction`
(`base.ts:201/242/455`), and `db.transaction` holds that mutex for the whole
callback. So a parent-handle `db.query(...)` inside the callback waits on the
mutex the enclosing transaction already holds → deadlock. (The `tx.*` methods
route only through `#queryMutex` and are correct; the hang is specific to the
parent handle.)

### Impact
The realistic, easy user mistake `await db.query(...)` instead of
`await tx.query(...)` inside a transaction callback silently wedges the whole
PGlite instance — no error, no timeout, just a hang. Availability defect; zero
existing coverage (all suite tx tests are sequential and use `tx.*`).

### Fix shape (for the maintainer dossier)
Detect reentrancy on the transaction mutex and reject the parent-handle call with
a clear error (e.g. "cannot use the parent connection inside a transaction; use
the tx handle"), instead of blocking on a non-reentrant lock.

### Replay
Deterministic — re-run the command; the hang is caught by the workload's bounded
4s reentrancy deadline (and the 20s liveness watchdog backstop).
