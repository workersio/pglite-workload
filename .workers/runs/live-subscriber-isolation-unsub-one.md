# Run: live-subscriber-isolation-unsub-one — FINDING (red)

- exploration: `live-subscriber-isolation-unsub-one`
- promise: `live-subscriber-isolation` (area live-queries)
- target commit: `1a4cce1` (`@electric-sql/pglite` 0.5.4, vendored runtime)
- harness: local node v22 draft against `.workers/vendor/pglite` (the published
  0.5.4 dist — the exact bytes that ship). wio official run: pending (batch).
- command: `node .workers/workloads/live_subscriber_isolation.mjs --case unsub-one`
- seed: bug is deterministic (not seed-dependent); representative SEED=431957136

## Verdict: FINDING — correctness (severity 3)

`unsubscribe(callback)` on a live query with more than one subscriber removes
**every** subscriber and tears down the query's backing state, instead of
removing just the named callback.

### Invariant results
```
INVARIANT u1 surviving_subscriber_delivered FAIL cbB fired after unsubscribe(cbA)+insert: 0 times
INVARIANT u2 unsubscribed_no_delivery PASS cbA fired 0 times after being unsubscribed (want 0)
INVARIANT u3 backing_state_intact FAIL cbB fired on a second mutation: 0 times (view/state survived)
RESULT=FAIL
```

Anti-vacuity proven before trusting the red:
- `--case baseline` → `INVARIANT b1 live_delivers_update PASS` (oracle observes delivery).
- `ORACLE_SELFTEST=1 --case baseline` → `INVARIANT b1 … FAIL` (planted violation
  drives the red path — the oracle can go red).

### Root cause (source-confirmed)
`packages/pglite/src/live/index.ts` — the selective-unsubscribe filter is
`callbacks.filter((cb) => cb !== cb)`: the inner arrow parameter shadows the
outer, so the predicate is always `false`, the filter returns `[]`, and the
`length === 0` guard then fires full teardown (DROP VIEW / DROP TABLE state1/2 /
DEALLOCATE diff). Verbatim in the vendored 0.5.4 dist (`dist/live/index.js`) in
all three variants: `live.query` (`d.filter(n=>n!==n)`), `live.changes`
(`_.filter(i=>i!==i)`), `live.incrementalQuery` (`_.filter(r=>r!==r)`). One
`unsubscribe(cb)` call therefore silently kills every co-subscriber and destroys
the live query's incremental state.

### Impact
Any consumer that shares a live query across multiple subscribers (the documented
multi-consumer pattern) and unsubscribes one of them silently loses all live
updates — no error, no callback. Latent since #374 (2024-10-14); zero test
coverage (every `unsubscribe()` in `tests/live.test.ts` passes no argument, so
only the empty-set teardown branch is exercised).

### Fix shape (for the eventual maintainer dossier)
`callbacks.filter((cb) => cb !== callback)` — bind the predicate to the outer
`callback` parameter; applies identically to all three variants.

### Replay
Deterministic — re-run the command above; the red does not depend on the seed.
Official wio replay-confirmation (run id) to be filled by the batched official run.
