---
key: snapshot
title: Snapshot (dump / loadDataDir)
description: dumpDataDir → loadDataDir is a faithful round-trip of the database state.
order: 70
---
# Snapshot (dump / loadDataDir)

`dumpDataDir(compression)` produces a tarball of PGDATA; `PGlite.create({
loadDataDir})` reconstructs the database from it. Compression is
`'none' | 'gzip' | 'auto'` and depends on an ambient compression API.

Code loci: `packages/pglite/src/pglite.ts` (dumpDataDir), `fs/tarUtils.ts`
(tar pack/unpack), `fs/index.ts` (loadDataDir option resolution).

Reachable in a Node/alpine guest: yes.

Harvested vs open: `dump.test.js`/`clone.test.js` exist for happy-path round
trips. Open corridors: round-trip identity of sequence next-values and index
behaviour, dumping with in-flight/uncommitted state, `gzip` when the env lacks a
compression API (must throw, not silently corrupt), and reload into an instance
with a different username/database. Data-loss class on the restore side.
