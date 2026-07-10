# Run: tx-closed-handle — FINDING (red)

- explorations: `tx-closed-handle-sql-after-rollback`, `tx-closed-handle-after-throw`
- promise: `tx-closed-handle` (area transactions)
- target commit: `1a4cce1` (`@electric-sql/pglite` 0.5.4, vendored runtime)
- harness: local node v22 draft against `.workers/vendor/pglite`. wio official: pending (batch).
- command: `node .workers/workloads/tx_closed_handle.mjs --case {sql-after-rollback,after-throw}`

## Verdict: FINDING — data integrity / correctness (severity 3)

A retained transaction handle keeps writing to the live **auto-commit**
connection after the transaction has ended — silently, with no error — so a
write a caller believes is inside a rolled-back transaction is instead persisted.

### Invariant results
```
# baseline (anti-vacuity)
INVARIANT b1 tx_query_works_inside PASS
INVARIANT b2 closed_handle_query_rejects PASS           # tx.query IS guarded after commit
#   ORACLE_SELFTEST=1 -> b2 FAIL (red path proven)

# sql-after-rollback
INVARIANT r1 tx_sql_after_rollback_rejects FAIL rejected=false
INVARIANT r2 leaked_write_not_persisted   FAIL rows id=99: 1 (want 0)

# after-throw (broader hole)
INVARIANT t1 tx_query_after_throw_rejects FAIL rejected=false
INVARIANT t2 tx_exec_after_throw_rejects  FAIL rejected=false
INVARIANT t3 tx_sql_after_throw_rejects   FAIL rejected=false
INVARIANT t4 no_leaked_writes_persisted   FAIL persisted [96,97,98] (want none)
```

### Root cause (source-confirmed)
Two distinct gaps in `packages/pglite/src/base.ts`:
1. **`tx.sql` never guards.** `tx.query` (:473), `tx.exec` (:490), `tx.rollback`
   (:494), `tx.listen` (:504) all call `checkClosed()`; `tx.sql` (:476-485) goes
   straight to `#runQuery`. So `tx.sql` on a committed/rolled-back handle runs on
   auto-commit. (Confirmed by the sql-after-rollback red: id=99 persisted.)
2. **The throw path never sets `closed`.** When the callback throws, the wrapper
   runs `ROLLBACK` (base.ts:516-519) but never sets `closed = true`. So after a
   *thrown* transaction, `checkClosed()` still passes and `tx.query`, `tx.exec`,
   and `tx.sql` ALL execute on auto-commit — ids 96/97/98 persisted. This is the
   broader variant: the entire handle stays live after a failed transaction.

### Impact
A very common footgun: a transaction whose body throws (or is explicitly rolled
back) is expected to leave no trace, but a subsequent use of the retained handle
persists data outside any transaction. Data-integrity violation, no error raised.
Zero existing coverage (the suite's only tx test is a single happy-path insert +
explicit rollback; `tx.sql` appears nowhere in the tests).

### Fix shape (for the maintainer dossier)
(1) `tx.sql` must call `checkClosed()` like its siblings. (2) The catch/rollback
path in `transaction()` must set `closed = true` (as the commit path does).

### Replay
Deterministic — re-run the commands above; not seed-dependent. Official wio
replay-confirmation to be filled by the batched official run.
