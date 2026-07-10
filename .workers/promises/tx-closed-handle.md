---
key: tx-closed-handle
area: transactions
title: Closed transaction handle rejects
claim: >-
  Once a transaction is committed or rolled back, any further use of its tx
  handle throws instead of silently running on the live auto-commit connection.
status: active
provenance: >-
  packages/pglite/src/base.ts:467-510 (checkClosed on query/exec/rollback/listen
  but not on sql); docs/docs/api.md:255-266
explorations:
  - key: tx-closed-handle-baseline
    title: Closed handle baseline
    description: >-
      Inside a transaction callback tx.query and tx.sql both run; after the
      callback commits, tx.query rejects with "Transaction is closed". Proves
      the oracle observes the guarded path.
    status: done
    result: green
    reason: null
    workload: workloads/tx_closed_handle.mjs
    command: sh .workers/workloads/_run.sh .workers/workloads/tx_closed_handle.mjs --case baseline
    faults: []
    depth: 6
    replay: {harness: local-node, case: baseline, note: "green; FAILs under ORACLE_SELFTEST=1"}
    freshness: new-current
    reported: null
    published: nd7erq81fy3qxgcfwnx1r76v0h8a90d5
  - key: tx-closed-handle-sql-after-rollback
    title: tx.sql after rollback must reject
    description: >-
      Retain the tx handle, call tx.rollback(), then invoke tx.sql on it. The
      call must reject with "Transaction is closed"; the write it carries must
      not be persisted to the auto-commit connection.
    status: done
    result: finding
    reason: null
    workload: workloads/tx_closed_handle.mjs
    command: sh .workers/workloads/_run.sh .workers/workloads/tx_closed_handle.mjs --case sql-after-rollback
    faults: []
    depth: 8
    replay: {harness: local-node, case: sql-after-rollback, note: "tx.sql persisted id=99 on auto-commit"}
    freshness: new-current
    reported: null
    published: nd717g68xesk4t7kzmqfp7ad8s8a92cf
  - key: tx-closed-handle-after-throw
    title: Every method rejects after a thrown transaction
    description: >-
      When a transaction callback throws, base.ts runs ROLLBACK but never sets
      closed=true — so a retained handle's tx.query, tx.exec AND tx.sql all pass
      checkClosed() and run on the auto-commit connection. Assert every retained
      method rejects after a thrown transaction and none of its writes persist.
    status: done
    result: finding
    reason: null
    workload: workloads/tx_closed_handle.mjs
    command: sh .workers/workloads/_run.sh .workers/workloads/tx_closed_handle.mjs --case after-throw
    faults: []
    depth: 10
    replay: {harness: local-node, case: after-throw, note: "query+exec+sql all persisted [96,97,98]; closed never set on throw"}
    freshness: new-current
    reported: null
    published: nd7edyksj5n7s8f5657svmhbcd8a9g3a
  - key: tx-closed-handle-sql-after-commit
    title: tx.sql after commit must reject
    description: >-
      The same escape via the commit path — retain the handle past a normally
      committed callback, then tx.sql a write; it must reject, not persist.
    status: planned
    result: null
    reason: null
    workload: workloads/tx_closed_handle.mjs
    command: sh .workers/workloads/_run.sh .workers/workloads/tx_closed_handle.mjs --case sql-after-commit
    faults: []
    depth: 8
    replay: null
    freshness: new-current
    reported: null
    published: null
---
# Closed transaction handle rejects

## Claim & provenance
`db.transaction(fn)` passes a `tx` handle whose methods must stop working once
the transaction ends — the code comments its intent ("we throw an error if it's
used again", `base.ts:459`). `tx.query` (`:473`), `tx.exec` (`:490`),
`tx.rollback` (`:494`), and `tx.listen` (`:504`) all call `checkClosed()`.

## Adversarial model
`tx.sql` (`base.ts:476-485`) is the one method that does **not** call
`checkClosed()` — it goes straight to `#runQuery`. So a retained `tx` handle,
used after the transaction has committed or rolled back, silently executes
`tx.sql\`…\`` on the live **auto-commit** connection. A user who believes their
write landed inside a since-rolled-back transaction instead gets a *persisted*
write, with no error — a data-integrity violation. The asymmetry against the
four sibling methods proves it is an oversight, not design.

**Wider hole (strategy-critic, source-verified):** the callback-**throw** path
(`base.ts:516-519`) runs `ROLLBACK` but never sets `closed = true`. So after a
*thrown* transaction, a retained handle's `tx.query`, `tx.exec`, AND `tx.sql`
all pass `checkClosed()` and run on the auto-commit connection — the leak is not
`tx.sql`-only; the `after-throw` rung attacks this stronger variant.

## Oracle
`tx-closed-handle-rejects`: after `tx.rollback()` (or after a committed
callback), `tx.sql\`INSERT …\`` must reject with a "Transaction is closed"
error, and a follow-up top-level `SELECT` must show the row absent. FAIL if the
call resolves or the row is present. Baseline anti-vacuity: `tx.query` after
commit is already guarded and must reject — proving the oracle can see the
"rejects" outcome before we assert `tx.sql` fails to.

## Workload plan
`workloads/tx_closed_handle.mjs` on an in-memory PGlite. Cases: `baseline`
(guarded path observable), `sql-after-rollback` (the red), `sql-after-commit`
(the same escape via commit). Deterministic, no faults. Seeds vary the write
payload and interleave a concurrent top-level query to confirm the leaked write
hits the shared connection. Universal plane: terminal-state sweep (every started
tx reaches committed or rolled-back), liveness watchdog on each await.
