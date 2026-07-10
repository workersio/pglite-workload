# Run: notify-quoted-unlisten — FINDING (red)

- explorations: `notify-quoted-unlisten-baseline` (green), `notify-quoted-unlisten-quoted` (finding)
- promise: `notify-quoted-unlisten` (area notify)
- target commit: `1a4cce1` (`@electric-sql/pglite` 0.5.4, vendored runtime)
- harness: local node v22 draft against `.workers/vendor/pglite`. wio official: pending (batch).
- command: `node .workers/workloads/notify_quoted_unlisten.mjs --case {baseline,quoted}`

## Verdict: FINDING — correctness (severity 2)

The disposer returned by `db.listen(channel, cb)` fails to unsubscribe a
case-sensitive (quoted) channel: after calling it, a NOTIFY on that channel
still fires the supposedly-removed callback.

### Invariant results
```
# baseline (lowercase, control)
INVARIANT s0 delivery_while_subscribed        PASS
INVARIANT u1 no_delivery_after_unsubscribe    PASS       # lowercase disposer works
#   ORACLE_SELFTEST=1 -> u1 FAIL (red path proven)

# quoted (channel '"MyChannel"')
INVARIANT s0 delivery_while_subscribed        PASS fired 1 (channel MyChannel)
INVARIANT u1 no_delivery_after_unsubscribe    FAIL fired 1 after unsubscribe (want 0)
```

### Root cause (source-confirmed)
`packages/pglite/src/pglite.ts` — `#listen` stores the callback under
`pgChannel = toPostgresName(channel)` and the returned disposer passes that
**already-normalized** `pgChannel` back into `unlisten`, which normalizes it
**again**. `toPostgresName` (`packages/pglite-utils/src/utils.ts:134`) is not
idempotent for quoted names: `'"MyChannel"'` → `MyChannel` (first pass, case
preserved) → `mychannel` (second pass, no quotes → lowercased). So both the JS
registry delete and the `UNLISTEN` SQL target `mychannel`, leaving the real
`MyChannel` listener live. NOTIFY on the case-sensitive channel keeps firing the
disposed callback — spurious delivery plus a listener/registry leak.

### Impact
Any consumer using a case-sensitive (quoted) LISTEN channel — legal Postgres and
used when channel names carry mixed case — cannot unsubscribe via the documented
`const unsub = await db.listen(...); await unsub()` path. The callback keeps
firing and the subscription leaks. Uncovered: `notify.test.ts` exercises the
disposer only on lowercase channels.

### Fix shape (for the maintainer dossier)
Make the disposer pass the ORIGINAL user channel (not the pre-normalized
`pgChannel`) into `unlisten`, or make `toPostgresName` idempotent. Normalize
exactly once on the listen→unlisten round-trip.

### Replay
Deterministic — re-run the commands above; not seed-dependent.
