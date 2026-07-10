---
key: extensions
title: Extensions & Sync
description: Bundled Postgres extensions (pgvector, pgmq, …) and the pglite-sync replication apply path.
order: 80
---
# Extensions & Sync

PGlite ships a matrix of extension sub-packages (pgvector, pgmq, age, postgis,
pg_ivm, uuidv7, …) loaded via `extensionUtils.ts`, plus `pglite-sync` — an
Electric replication client whose `apply.ts` writes an incoming change stream
into local tables.

Code loci: `packages/pglite/src/extensionUtils.ts`, `packages/pglite/src/contrib`,
`packages/pglite-sync/src/apply.ts` (move-in upsert 29-49, LSN filtering,
column-name quoting).

Reachable in a Node/alpine guest: bundled extensions load in-process (yes);
`pglite-sync` apply is drivable directly (`applyMessageToTable`) without a live
Electric server.

Harvested vs open: extension packages are the suite's most saturated happy-path
area. Open corridors concentrate in `pglite-sync` (two recent correctness fixes:
move-in LSN filtering, `json_to_recordset` column quoting) — apply a batch mixing
move-in + LSN + reserved/mixed-case columns and assert the local table equals the
source. Lower rank for the first batch (needs sync harness); parked otherwise.
