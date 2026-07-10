---
key: exec-batch-atomicity
area: query-exec
title: exec multi-statement batch is ordered and all-or-nothing on error
claim: >-
  db.exec runs its statements in order and, when a statement fails mid-batch,
  aborts the implicit transaction so no earlier statement's effect persists and
  the connection stays usable.
status: active
provenance: >-
  packages/pglite/src/pglite.ts:927-949 (loop continues after per-statement
  longjmp, keeps first error); pglite.ts:156 (exit_on_error=false); docs/docs/api.md:210-247
explorations:
  - key: exec-batch-atomicity-baseline
    title: Ordered multi-statement baseline
    description: >-
      exec of several successful statements returns one result object per
      statement in order and applies them all. Proves the oracle sees ordering
      and per-statement results.
    status: ready
    result: null
    reason: null
    workload: workloads/exec_batch_atomicity.mjs
    command: node .workers/workloads/exec_batch_atomicity.mjs --case baseline
    faults: []
    depth: 6
    replay: null
    freshness: new-current
    reported: null
    published: null
  - key: exec-batch-atomicity-midfail
    title: Partial-failure error identity and result-array contract
    description: >-
      exec('INSERT a; SELECT 1/0; INSERT b') — the raised error must identify the
      FAILING statement (not the first or a stale one), and the returned/absent
      result-array shape must match the documented one-per-statement contract for
      the partial-failure case. All-or-nothing is protected by the implicit
      transaction (expected green) and is the anti-vacuity control, not the target.
    status: ready
    result: null
    reason: null
    workload: workloads/exec_batch_atomicity.mjs
    command: node .workers/workloads/exec_batch_atomicity.mjs --case midfail
    faults: []
    depth: 10
    replay: null
    freshness: new-current
    reported: null
    published: null
  - key: exec-batch-atomicity-recovery
    title: Connection healthy after a failed batch
    description: >-
      After a failing exec (parser-reset path, pglite.ts:1040), a subsequent
      simple query and a subsequent exec both return correct results — no
      protocol desync, no poisoned state.
    status: planned
    result: null
    reason: null
    workload: workloads/exec_batch_atomicity.mjs
    command: node .workers/workloads/exec_batch_atomicity.mjs --case recovery
    faults: []
    depth: 10
    replay: null
    freshness: new-current
    reported: null
    published: null
---
# exec multi-statement batch is ordered and all-or-nothing on error

## Claim & provenance
`db.exec(multiStatement)` uses the simple-query protocol and returns one result
object per statement (docs/docs/api.md:210-247). A multi-statement simple query
runs in an **implicit transaction** in Postgres, so a mid-batch error should
roll the whole batch back.

## Adversarial model
The protocol loop deliberately **keeps processing batched messages after a
per-statement longjmp** and stores only the *first* error
(`pglite.ts:927-949`, `#currentQuery.databaseError` `:1086-1089`), with start
params setting `exit_on_error=false` (`pglite.ts:156`) and rebuilding the parser
on throw (`pglite.ts:1040`).

**Strategy-critic correction (source-verified):** a multi-statement simple query
runs in ONE implicit transaction, so on a mid-batch error Postgres aborts it and
discards the rest — `INSERT a; 1/0; INSERT b` leaves *neither* row regardless of
the loop, and `exit_on_error=false` governs process exit, not rollback. So
**all-or-nothing is expected green** and is only the anti-vacuity control here.
The genuinely uncertain surface the hand-rolled loop creates is the
**partial-failure reporting contract**: which statement's error is raised (the
loop keeps only the *first* `databaseError`), and whether the returned result
array is truncated / one-per-statement as documented — plus post-error protocol
recovery (parser rebuilt at `pglite.ts:1040`). Only single-statement errors are
tested (`basic.test.ts:434`); the partial-failure reporting contract is untested.

## Oracle
`exec-partial-failure-reporting`: after `INSERT a; <failing>; INSERT b`, assert
(1) exec rejected with the error of the **actually-failing** statement (not the
first, not a stale one), (2) the returned/absent result-array shape matches the
documented one-per-statement contract for the partial-failure case, (3) a
subsequent query AND exec both succeed with correct results (no protocol desync).
All-or-nothing (neither `a` nor `b` visible) is asserted as the **anti-vacuity
control** — it must hold; a run where it fails means the harness, not the
guarantee, is wrong. A green here is weak evidence; the target is a divergence in
the reporting/recovery contract.

## Workload plan
`workloads/exec_batch_atomicity.mjs`, in-memory PGlite. Cases: `baseline`,
`midfail` (error-identity/result-array reporting), `recovery` (post-error
health). Seeds vary the
failing statement's position in the batch (first / middle / last) and the error
class (constraint violation, division-by-zero, type error). Universal plane:
terminal-state sweep on connection health after each batch; liveness watchdog on
each exec.
