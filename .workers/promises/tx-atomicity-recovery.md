---
key: tx-atomicity-recovery
area: transactions
title: Transaction aborts cleanly and the connection recovers
claim: >-
  A transaction that rejects leaves none of its writes and returns the single
  connection immediately usable; a query issued on the parent handle during a
  transaction never hangs forever.
status: active
provenance: >-
  packages/pglite/src/base.ts:453-528 (transaction, rollback); pglite.ts:96,1285
  (non-reentrant #transactionMutex); docs/docs/api.md:255-266
explorations:
  - key: tx-atomicity-recovery-baseline
    title: Rollback-on-throw baseline
    description: >-
      A transaction callback inserts a row then throws; the row must be absent
      afterward and the next top-level query must succeed. Proves the oracle
      sees both the atomicity and the recovery invariants.
    status: done
    result: green
    reason: null
    workload: workloads/tx_atomicity_recovery.mjs
    command: sh .workers/workloads/_run.sh .workers/workloads/tx_atomicity_recovery.mjs --case baseline
    faults: []
    depth: 8
    replay: {harness: local-node, case: baseline, note: "green; FAILs under ORACLE_SELFTEST=1"}
    freshness: new-current
    reported: null
    published: nd786ywbbyfdq4e7ptsqjmk2mn8a9ra0
  - key: tx-atomicity-recovery-reentrant
    title: Reentrant parent-handle call must not hang
    description: >-
      Inside a transaction callback, issue a query on the PARENT db handle (the
      common `await db.query` instead of `await tx.query` mistake). It must
      resolve or reject within a bounded deadline, never block forever on the
      non-reentrant mutex.
    status: done
    result: finding
    reason: null
    workload: workloads/tx_atomicity_recovery.mjs
    command: sh .workers/workloads/_run.sh .workers/workloads/tx_atomicity_recovery.mjs --case reentrant
    faults: []
    depth: 10
    replay: {harness: local-node, case: reentrant, note: "parent-handle db.query inside tx deadlocks (timeout at 4s)"}
    freshness: new-current
    reported: null
    published: nd7b99strg4mdke8qpkzzd76gx8a9bhx
  - key: tx-atomicity-recovery-aborted-state
    title: Recovery after in-transaction statement error
    description: >-
      A statement inside a transaction errors (leaving PG's "current transaction
      is aborted" state); the workload must be able to roll back and the
      connection be usable, with no wedged instance.
    status: planned
    result: null
    reason: null
    workload: workloads/tx_atomicity_recovery.mjs
    command: sh .workers/workloads/_run.sh .workers/workloads/tx_atomicity_recovery.mjs --case aborted-state
    faults: []
    depth: 10
    replay: null
    freshness: new-current
    reported: null
    published: null
---
# Transaction aborts cleanly and the connection recovers

## Claim & provenance
`db.transaction(cb)` commits on resolve and is "automatically rolled back if the
promise is rejected" (docs/docs/api.md:255-266). Because PGlite is a **single
connection** guarded by a non-reentrant `async-mutex` (`pglite.ts:96`,
`_runExclusiveTransaction` `pglite.ts:1285`), a mishandled abort or a reentrant
call wedges the whole instance, not one session.

## Adversarial model
Two failure modes, separable:
1. **Atomicity + recovery** — a callback that throws must leave none of its
   writes and must not poison the connection ("current transaction is aborted"
   surviving into the next top-level query).
2. **Reentrancy hang** — `db.query`/`db.exec`/`db.transaction` on the *parent*
   handle inside a callback routes through `_runExclusiveTransaction`
   (`base.ts:201/242/455`), whose mutex is already held by the enclosing
   transaction and is non-reentrant. The realistic user mistake `await
   db.query(...)` (instead of `await tx.query(...)`) can therefore block
   forever — an availability defect with zero existing coverage.

## Oracle
`tx-abort-atomic-and-recover`: after a throwing/rolled-back transaction, the
inserted row is absent AND a subsequent `SELECT 1` succeeds. `no-reentrant-hang`:
a parent-handle call inside a callback settles (resolve or reject) before a
bounded `liveness_watchdog` deadline; blocking past the deadline is a FAIL, not a
timeout artifact. Baseline proves the oracle can observe rollback + recovery.

## Workload plan
`workloads/tx_atomicity_recovery.mjs`, in-memory PGlite. Cases: `baseline`,
`reentrant` (the hang attack, guarded by an explicit deadline), `aborted-state`
(mid-tx statement error then recovery). Seeds vary which op reenters and the
delay before it. Universal plane: liveness watchdog is the primary oracle for
the reentrant case; terminal-state sweep asserts every started transaction
reaches a terminal state before exit.
