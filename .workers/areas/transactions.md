---
key: transactions
title: Transactions
description: Interactive transaction blocks, rollback, atomicity, and the single-connection state machine.
order: 10
---
# Transactions

PGlite exposes `db.transaction(fn)` — an interactive tx with a `tx` handle
(`query`, `exec`, `sql`, `rollback`), committed when the callback resolves and
auto-rolled-back when it rejects. All of it runs over one connection guarded by
a non-reentrant `async-mutex` (`base.ts` `#transactionMutex`, `pglite.ts:96`).

Code loci: `packages/pglite/src/base.ts` (`transaction` 453-528, `tx` methods
467-510, `#inTransaction` sync gate 325-327/374-376), `pglite.ts:1285`
(`_runExclusiveTransaction`), `pglite.ts:1123` (`isInTransaction`).

Harvested vs open: the authors' suite has exactly one happy-path tx test
(`basic.test.ts:440-500`) with an explicit rollback. No test covers: reuse of a
closed `tx` handle, reentrancy (a query on the parent handle inside a callback),
manual `BEGIN`/`COMMIT` via `exec` desyncing the JS `#inTransaction` flag, or
abort-state recovery. Two source-confirmed defects live here (see promises
`tx-closed-handle` and the reentrancy corridor).
