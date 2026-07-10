# Backlog

Ranked candidate pool (spec-format §Backlog). Producer is the only writer.
Score = L·I·O·N·R/C (each factor 1–5). Only L is evidence-corrected.

- active: 12
- areas: { concurrency: 3, query-exec: 2, durability: 3, snapshot: 1, notify: 1, extensions: 1, live-queries: 1 }
- top-score: 288
- threshold: 20

## Active (sorted by score, descending)

| score | candidate | area | L·I·O·N·R/C | provenance | source | notes |
|-------|-----------|------|-------------|------------|--------|-------|
| 288 | inflight-close-crash — `close()` force-exits the WASM runtime without acquiring the query/transaction mutex, so a query mid-protocol calls into a torn-down module | concurrency | 4·3·4·4·3/2 | "pglite.ts:787-833 close; base.ts:254-331 six-await #runQuery" | scout-runtime | [path: pglite.ts:close] |
| 216 | serialization-roundtrip — bigint-array magnitude split, embedded-bigint json lossy, array NULL case mismatch (serializer lowercase vs parser uppercase) break insert→select equality | query-exec | 3·3·4·3·4/2 | "types.ts:90-102 bigint, :110-112 json, :275/:326 null case" | scout-commits | [path: types.ts] |
| 180 | same-datadir-twice — two PGlite instances on one file:// dataDir have no lock/postmaster.pid guard; interleaved writes can corrupt PGDATA | durability | 3·5·3·4·3/3 | "fs/nodefs.ts:11-38 mkdir+mount, no lock" | scout-runtime | [path: fs/nodefs] |
| 144 | commit-not-synced-before-resolve — `transaction()` commits with `#inTransaction` still true so no syncToFs runs for the commit; divergence is observable but the data-loss payoff is not Node-reproducible via process kill | durability | 3·2·4·4·3/2 | "base.ts:512-519 COMMIT; base.ts:374/325 sync gate" | scout-api | [path: base.ts:sync-gate] feedback 2026-07-10: I 4→2 crash-window not Node-reproducible (NODEFS page-cache; strategy-critic) |
| 144 | dump-roundtrip-identity — dumpDataDir→loadDataDir must reproduce sequence next-values, indexes, and gzip-unavailable must throw not corrupt | snapshot | 2·4·3·3·4/2 | "pglite.ts dumpDataDir; fs/tarUtils.ts; api.md:325-339" | scout-docs | [path: fs/tarUtils] |
| 144 | param-oid-fallback-fidelity — when PG cannot infer a param type, serialization falls back to `param.toString()`, degrading objects/Dates/Buffers to lossy strings | query-exec | 2·3·4·3·4/2 | "base.ts:279-290 oid=dataTypeIDs[i] else toString()" | scout-api | [path: base.ts:bind] |
| 108 | inTransaction-desync-manual-begin — `exec('BEGIN')` leaves JS `#inTransaction=false`, so per-statement syncToFs fires mid-transaction, diverging from `isInTransaction()`; state divergence real, data-loss not Node-reproducible | durability | 3·2·3·4·3/2 | "base.ts:43/457; base.ts:325-327/374-376; pglite.ts:1123" | scout-tests | [path: base.ts:sync-gate] feedback 2026-07-10: I 4→2 crash-window not Node-reproducible (strategy-critic) |
| 108 | worker-rpc-concurrency — the worker-thread RPC layer is a SECOND concurrency surface with real cross-thread interleaving (unlike the single-connection async interleave); close/race across the RPC boundary is unmapped | concurrency | 3·3·3·4·3/3 | "packages/pglite/src/worker/index.ts" | critic | [path: worker/index.ts] skip 2026-07-10: needs worker-thread harness (parked needs-harness in map) |
| 108 | listen-in-rolled-back-tx — LISTEN registered inside a transaction that rolls back leaves a phantom JS listener (registry ≠ pg_listening_channels) | notify | 3·2·3·3·4/2 | "pglite.ts:1174-1197 #listen via tx; base.ts:493-526 rollback" | scout-runtime | [path: pglite.ts:listen] |
| 81 | pglite-sync-apply — applying a batch mixing move-in + LSN filtering + reserved/mixed-case columns must yield a local table equal to source | extensions | 3·3·3·3·3/3 | "pglite-sync/src/apply.ts:29-49 move-in; #883 LSN, #954 quoting" | scout-commits | [path: pglite-sync/apply.ts] |
| 81 | live-incremental-diff-correctness — live.incrementalQuery's state1/state2 double-buffer + debounced RESET path must reproduce the exact result set under mutation bursts (distinct from the subscriber-isolation teardown bug) | live-queries | 3·3·3·3·3/3 | "live/index.ts:434-489 debounce/stateSwitch/RESET" | critic | [path: live/index.ts:incremental] |
| 36 | recv-buffer-unbounded — the MAX_BUFFER_SIZE clamp is dead code (newSize computed from unclamped requiredSize); a >1GB result over-allocates → OOM | concurrency | 2·2·3·3·3/3 | "pglite.ts:736-746" | scout-runtime | [path: pglite.ts:buffer] |

## Archive

_(none)_
