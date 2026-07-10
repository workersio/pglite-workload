---
key: durability
title: Durability & Persistence
description: Committed writes surviving reopen/crash across the memory and filesystem backends.
order: 30
---
# Durability & Persistence

PGlite persists to a `dataDir` (memory://, a node filesystem path/file://,
idb:// browser, opfs-ahp:// browser). Startup runs Postgres `--single` with the
**checkpointer and background workers disabled** (CHANGELOG 0.4.3/0.4.4) and
**fsync off** (`pglite.ts:150` `-F`), so crash recovery does not rest on WAL
replay — durability is a VFS-flush property. `relaxedDurability` makes the
post-query flush fire-and-forget (`pglite.ts:1132-1150`).

Code loci: `packages/pglite/src/fs/` (nodefs `syncToFs` noop `base.ts:62-64`,
idbfs/opfs async), `pglite.ts` (`#init` reload 295-619, `syncToFs` 1132-1150,
`close` sync 787-833), `initdb.ts`/`initdbModFactory.ts` (startup/reload).

Reachable in a Node/alpine guest: **memory:// and nodefs (file://) only**.
idb:// and opfs-ahp:// are browser-only — parked:unreachable-in-guest (no recipe
vendored). Crash (kill -9 + reopen) is reachable via a child-process harness
(`.workers/lib/crashclock.py`).

Harvested vs open: no durability/reopen/crash test in the suite; no
`relaxedDurability` test anywhere. Open corridors: acked-commit-survives-reopen,
crash-mid-write, commit-not-synced-before-resolve, same-dataDir-opened-twice.
