---
key: notify-quoted-unlisten
area: notify
title: Unsubscribing a listener stops its notifications
claim: >-
  The disposer returned by db.listen(channel, cb) removes exactly that listener,
  so a NOTIFY after unsubscribe is not delivered to it — for any channel name,
  including case-sensitive quoted ones.
status: active
provenance: >-
  packages/pglite/src/pglite.ts:1179-1197 (#listen stores toPostgresName, disposer
  re-passes it), :1217 (#unlisten normalizes again); pglite-utils/src/utils.ts:134
explorations:
  - key: notify-quoted-unlisten-baseline
    title: Lowercase unlisten baseline
    description: >-
      listen on a plain lowercase channel, unsubscribe via the returned disposer,
      then NOTIFY — the callback must not fire. Proves the oracle observes a
      working unsubscribe on the already-tested path.
    status: done
    guest: blocked  # BLOCKER #2: LISTEN/NOTIFY delivery unserviced in the sim (db.listen setup wedges); stands on local repro
    result: green
    reason: null
    workload: workloads/notify_quoted_unlisten.mjs
    command: sh .workers/workloads/_run.sh .workers/workloads/notify_quoted_unlisten.mjs --case baseline
    faults: []
    depth: 6
    replay: {harness: local-node, case: baseline, note: "green; FAILs under ORACLE_SELFTEST=1"}
    freshness: new-current
    reported: null
    published: nd74y6n5zjfnd056pa5zgajaf18a8ctb
  - key: notify-quoted-unlisten-quoted
    title: Quoted-channel unsubscribe must stop delivery
    description: >-
      listen on a case-sensitive quoted channel (e.g. "MyChannel"), call the
      returned disposer, then NOTIFY that channel. The callback must NOT fire.
      Source shows the disposer targets the wrong (re-lowercased) name, so the
      listener stays live — expected red.
    status: done
    guest: blocked  # BLOCKER #2: LISTEN/NOTIFY delivery unserviced in the sim (db.listen setup wedges); stands on local repro
    result: finding
    reason: null
    workload: workloads/notify_quoted_unlisten.mjs
    command: sh .workers/workloads/_run.sh .workers/workloads/notify_quoted_unlisten.mjs --case quoted
    faults: []
    depth: 8
    replay: {harness: local-node, case: quoted, note: "callback fired after unsubscribe on quoted channel MyChannel"}
    freshness: new-current
    reported: null
    published: nd7exrcsq348jehptmy7b7rm398a88bd
  - key: notify-quoted-unlisten-registry-parity
    title: JS registry parity with pg_listening_channels
    description: >-
      After the quoted-channel unsubscribe, assert the JS listener registry and
      Postgres pg_listening_channels agree (no phantom SQL LISTEN left behind by
      the wrong-key UNLISTEN).
    status: planned
    result: null
    reason: null
    workload: workloads/notify_quoted_unlisten.mjs
    command: sh .workers/workloads/_run.sh .workers/workloads/notify_quoted_unlisten.mjs --case registry-parity
    faults: []
    depth: 8
    replay: null
    freshness: new-current
    reported: null
    published: null
---
# Unsubscribing a listener stops its notifications

## Claim & provenance
`const unsub = await db.listen(channel, cb); await unsub()` is the documented way
to stop receiving notifications. `#listen` (`pglite.ts:1179`) stores the callback
under `pgChannel = toPostgresName(channel)` and returns a disposer that calls
`unlisten(pgChannel, cb)` (`:1194-1197`).

## Adversarial model
The disposer passes the **already-normalized** `pgChannel` into `#unlisten`, which
normalizes it **again** (`pglite.ts:1217`). `toPostgresName`
(`pglite-utils/src/utils.ts:134`) is **not idempotent** for quoted names: for
`"MyChannel"` the first pass yields `MyChannel` (quotes preserved case) and the
second pass — seeing no quotes — lowercases it to `mychannel`. So both the JS
registry delete (`:1228`) and the `UNLISTEN ${channel}` SQL (`:1220`) target the
wrong key, leaving the original listener live: NOTIFY on the case-sensitive
channel still fires the supposedly-disposed callback (spurious delivery + leak).
`notify.test.ts` exercises the disposer only on lowercase channels, so this is
uncovered. Confirmed by strategy-critic against source.

## Oracle
`notify-unlisten-exact`: after `unsub()`, a NOTIFY on the same (quoted) channel
must NOT invoke the callback within a bounded liveness deadline; and the JS
registry must match `pg_listening_channels`. FAIL if the callback fires after
unsubscribe. Baseline (lowercase) proves the oracle can see a *successful*
unsubscribe before the quoted case's negative assertion is trusted.

## Workload plan
`workloads/notify_quoted_unlisten.mjs`, in-memory PGlite. Cases: `baseline`
(lowercase, control), `quoted` (the red), `registry-parity` (planned). Seeds vary
the channel-name casing/quoting and the number of listeners on the channel.
Universal plane: liveness watchdog bounding the "did it fire?" observation
window; terminal-state sweep that every registered listener is either delivered
or cleanly removed at exit.
