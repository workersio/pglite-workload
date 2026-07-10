---
key: durable-reopen
area: durability
title: Acked writes survive reopening the dataDir
claim: >-
  A committed write on a filesystem dataDir is present after the PGlite instance
  is torn down and a fresh instance is opened over the same dataDir.
status: active
provenance: >-
  packages/pglite/src/fs/nodefs.ts; pglite.ts:150 (-F fsync off), :787-833 (close
  syncs), :1132-1150 (syncToFs); CHANGELOG 0.4.3/0.4.4 (checkpointer + bg workers off)
explorations:
  - key: durable-reopen-baseline
    title: Reopen-after-close baseline
    description: >-
      Write N rows to a nodefs dataDir, call close(), open a fresh PGlite over
      the same dataDir, and assert exactly those N rows (and sequence
      next-values) are present. Proves the oracle observes persistence.
    status: ready
    result: null
    reason: null
    workload: workloads/durable_reopen.mjs
    command: node .workers/workloads/durable_reopen.mjs --case baseline
    faults: []
    depth: 8
    replay: null
    freshness: new-current
    reported: null
    published: null
  - key: durable-reopen-commit-then-abrupt-exit
    title: Committed write survives abrupt exit (no clean close)
    description: >-
      In a child process, COMMIT a write to a nodefs dataDir and then exit the
      process abruptly WITHOUT calling close() (kill after the commit returns).
      Reopen the dataDir in the parent and assert the committed row is present —
      the disabled-checkpointer + fsync-off + commit-not-synced-before-resolve
      window.
    status: planned
    result: null
    reason: >-
      Not Node-reproducible via process kill: nodefs mounts emscripten NODEFS
      (synchronous pass-through to host FS, fs/nodefs.ts:26-28), so committed
      rows hit real files at write time and a SIGKILL preserves the OS page
      cache — reopening in the same OS still sees the row. fsync-off loses data
      only across an OS crash / power loss, which process termination cannot
      simulate. Needs a host-side write-interception / page-cache-drop fault
      injector before it can produce a real red (else it is an expected-green trap).
    workload: workloads/durable_reopen.mjs
    command: node .workers/workloads/durable_reopen.mjs --case abrupt-exit
    faults: [crash-after-commit]
    depth: 12
    replay: null
    freshness: new-current
    reported: null
    published: null
  - key: durable-reopen-crash-mid-write
    title: No torn state after crash mid-write
    description: >-
      Kill the child at seed-swept points across a write burst (crashclock
      timing space); every reopen must yield a consistent prefix of committed
      rows — never a torn heap/index or an unreadable PGDATA.
    status: planned
    result: null
    reason: null
    workload: workloads/durable_reopen.mjs
    command: node .workers/workloads/durable_reopen.mjs --case crash-mid-write
    faults: [crash-timing-sweep]
    depth: 16
    replay: null
    freshness: new-current
    reported: null
    published: null
---
# Acked writes survive reopening the dataDir

## Claim & provenance
PGlite persists to a `dataDir`; the docs promise data written to a filesystem
dataDir is durable across instances. But startup disables the Postgres
**checkpointer** and **background workers** (CHANGELOG 0.4.3/0.4.4) and runs with
**fsync off** (`pglite.ts:150` `-F`), so crash recovery is not WAL-replay — it is
a VFS-flush property. nodefs `syncToFs` is a noop (`fs/base.ts:62-64`), relying on
NODEFS pass-through + OS page cache. A committed `transaction()` does not sync at
commit (`base.ts:512-519`, `#inTransaction` still true) — the flush waits for the
next top-level query or `close()`.

## Adversarial model
- **Baseline** — clean `close()` (which does sync, `pglite.ts:799`) then reopen:
  the write must survive. This is the floor the durability claim rests on.
- **Abrupt exit** — a commit returns to the caller, then the process dies before
  a subsequent query or `close()` triggers the flush. With fsync off and the
  commit itself not syncing, this is the concrete loss window. Modeled by
  killing a child process right after the commit's promise resolves.
- **Crash mid-write** — kills swept across a write burst (declared timing space,
  `.workers/lib/crashclock.py` semantics) must always reopen to a consistent
  committed prefix, never a torn/unreadable PGDATA.

## Oracle
`durable-reopen`: reopen the same dataDir and assert the set of committed rows
(and sequence next-values, index usability via an indexed lookup) equals what was
acked before teardown. A lost acked row is a data-loss FAIL. A reopen that throws
/ cannot recover PGDATA is also a FAIL (availability). `durawatch`-style delayed
re-observation: re-read on a short ladder after reopen to catch delayed erasure.
Baseline (clean close) must be green for the abrupt-exit red to be trusted.

## Ladder-floor certification (strategy-critic, 2026-07-10)
In a **Node/alpine guest** this promise's distinct fault models collapse toward
one reproducible rung. NODEFS is a synchronous pass-through to the host FS
(`fs/nodefs.ts:26-28`), so a process kill preserves the OS page cache and both
the abrupt-exit and crash-mid-write rungs are **expected-green traps** unless a
host-side page-cache-drop / torn-write injector is added (parked as producible
work with a recorded reason on each entry). The real durability moving parts live
in the async backends (`fs/idbfs.ts:46`, `fs/opfs-ahp.ts:114`) where `syncToFs`
is not a noop — those are **parked: unreachable-in-guest** pending a browser
recipe. So the covered surface here is certified as the clean-close roundtrip
(baseline) until one of those capabilities lands; the floor's missing rungs are
tracked as planned+blocked, not silently dropped.

## Workload plan
`workloads/durable_reopen.mjs` on a nodefs dataDir under a temp dir. The
abrupt-exit and crash cases spawn a child node process that opens the dataDir,
writes/commits, and is killed by the parent per a declared timing space; the
parent reopens and runs the oracle. Seeds sweep row count, commit boundary, and
kill point. memory:// dataDir is used only as an oracle-sanity control (nothing
survives it by design). Universal plane: acked-durability watch (manifest each
acked write, re-observe on a delay ladder), declared fault timing (kills at
seed-swept points, never magic sleeps), terminal-state sweep on reopen.
