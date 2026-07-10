---
key: live-subscriber-isolation
area: live-queries
title: Live-query subscribers are isolated
claim: >-
  Unsubscribing one callback from a live query leaves every other subscriber
  receiving updates and the query's backing state intact.
status: active
provenance: >-
  packages/pglite/src/live/index.ts:506 (also :243, :666); docs/docs/live-queries.md
explorations:
  - key: live-subscriber-isolation-baseline
    title: Live subscriber baseline
    description: >-
      One subscriber on a live.query; a committed mutation fires its callback
      with the updated result. Proves the oracle observes delivery at all.
    status: done
    result: green
    reason: null
    workload: workloads/live_subscriber_isolation.mjs
    command: node .workers/workloads/live_subscriber_isolation.mjs --case baseline
    faults: []
    depth: 8
    replay: {harness: local-node, case: baseline, note: "green; also FAILs under ORACLE_SELFTEST=1"}
    freshness: new-current
    reported: null
    published: nd72s3vvtmsxes9j359qjgb3m18a9ggd
  - key: live-subscriber-isolation-unsub-one
    title: Unsubscribe one leaves others live
    description: >-
      Two callbacks subscribed to one live.query; unsubscribe the first, then
      commit a mutation. The second callback must still fire and the backing
      view/state tables must still exist; the first must not fire.
    status: done
    result: finding
    reason: null
    workload: workloads/live_subscriber_isolation.mjs
    command: node .workers/workloads/live_subscriber_isolation.mjs --case unsub-one
    faults: []
    depth: 12
    replay: {harness: local-node, case: unsub-one, seed: 431957136, note: "deterministic red; not seed-dependent"}
    freshness: new-current
    reported: null
    published: nd752vrsm692sxaz8q7xx8zrc58a8svg
  - key: live-subscriber-isolation-variants
    title: Isolation across live.changes and incrementalQuery
    description: >-
      Same unsubscribe-one attack on live.changes and live.incrementalQuery
      (the two other subscriber-set copies), asserting incremental state
      (state1/state2, diff prepared statements) is not DEALLOCATEd.
    status: done
    result: finding
    reason: null
    workload: workloads/live_subscriber_isolation.mjs
    command: node .workers/workloads/live_subscriber_isolation.mjs --case variants
    faults: []
    depth: 12
    replay: {harness: local-node, case: variants, note: "both live.changes and live.incrementalQuery red"}
    freshness: new-current
    reported: null
    published: nd768022sz6d78gvrnc93weggd8a9c1k
---
# Live-query subscribers are isolated

## Claim & provenance
`live.query`/`live.changes`/`live.incrementalQuery` (`@electric-sql/pglite/live`)
return a subscription whose `subscribe(cb)` adds and `unsubscribe(cb)` removes a
single callback; only when the callback set empties does the machinery tear down
its backing view/state tables and DEALLOCATE its diff statements. The documented
contract (docs/docs/live-queries.md) is that multiple consumers can share one
live query.

## Adversarial model
Source inspection (`live/index.ts:506`, duplicated at `:243` and `:666`) shows
the selective-unsubscribe filter is
`callbacks = callbacks.filter((callback) => callback !== callback)` — the inner
arrow parameter **shadows** the outer `callback`, so the predicate is always
`false`, the filter returns `[]`, and `callbacks.length === 0` (`:510`) then
fires full teardown (`DROP VIEW` / `DROP TABLE state1/state2` / `DEALLOCATE
diff1/diff2`, `:514-520`). Every surviving subscriber silently stops receiving
updates and the backing state is destroyed. Latent since #374 (2024-10-14);
zero test coverage (every `unsubscribe()` in `tests/live.test.ts` passes no
argument, exercising only the empty-set branch).

## Oracle
`live-subscriber-isolation`: after `unsubscribe(cbA)`, commit a mutation to a
watched table and assert (cross-boundary, on a bounded liveness deadline):
(1) cbB fired with the post-mutation result; (2) cbA did NOT fire; (3) the live
query's backing view/state still exists (a follow-up mutation still delivers to
cbB — i.e. the query was not torn down). A hang waiting for cbB is a
`liveness_watchdog` FAIL. Anti-vacuity: the baseline case must show a callback
firing at all before the attack's negative assertions are trusted.

## Workload plan
`workloads/live_subscriber_isolation.mjs`, importing `PGlite` from the vendored
`.workers/vendor/pglite/dist/index.js` and `live` from `.../dist/live/index.js`.
Cases: `baseline` (one subscriber, one mutation), `unsub-one` (two subscribers,
unsubscribe first, mutate, re-mutate), `variants` (repeat over live.changes and
live.incrementalQuery). Deterministic; no fault injection needed — the defect is
in the JS callback set. Seeds vary mutation order/timing to widen the interleave
of unsubscribe vs the debounced refresh. Universal plane: liveness watchdog on
every awaited delivery; terminal-state sweep that every subscription is either
delivered-to or explicitly torn down at exit.
