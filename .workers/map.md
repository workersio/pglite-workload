# Map — PGlite workload harness

Static evidence index. Not a queue: no owners, no claims, no priorities.

## Target

| Fact | Value |
|------|-------|
| Target repo | `electric-sql/pglite` (fork: `workersio/pglite-workload`) |
| Pinned ref | `1a4cce1ab9ad5e13cbef9072ea005046f153ad9b` (main, 2026-07-10) |
| System under test | `@electric-sql/pglite` 0.5.4 — WASM Postgres, single-connection, embeddable |
| SUT delivery | vendored npm tarball → extracted to `.workers/vendor/pglite` by `.workers/build.sh` (offline, no monorepo toolchain) |
| wio project | `kn75132e9yw801hsybeayv40w58a86e1` ("pglite-workload", prod, ready) |
| wio branch | `main` |
| Runtime | node scripts on the alpine-node image driving the extracted package |

## Reality notes

- PGlite is a full Postgres compiled to WASM, run **single-connection,
  single-threaded** in-process. No client/server, no wire protocol between the
  app and the DB. Concurrency defects are therefore about *interleaving of
  async JS calls into one DB*, transaction state, and persistence — not
  multi-client races.
- Persistence backends: in-memory (default), IndexedDB (browser),
  filesystem/`dataDir` (node), and OPFS. Durability promises live on the
  persistent backends; the durability question is "does an acked write survive
  a reload of the same dataDir?"
- `db.query`/`db.exec` are serialized internally through a single queue;
  `db.transaction(fn)` gives an interactive tx with a callback. Reentrancy and
  the interplay of `transaction`, `exec` (multi-statement), and prepared
  statements are prime interleaving surfaces.
- Live queries, extensions (pgvector, pgmq recently added — d4fb8ec), and the
  `/dump`+`loadDataDir` snapshot path are additional promise surfaces.

## Areas

| Key | Title | Focus | Status |
|-----|-------|-------|--------|
| transactions | Transactions | tx blocks, rollback, atomicity, single-conn state machine | active |
| live-queries | Live Queries | subscriptions, incremental diffs, subscriber lifecycle | active |
| durability | Durability & Persistence | acked write survives reopen/crash (memory + nodefs) | active |
| query-exec | Query & Exec Semantics | multi-statement atomicity, post-error recovery, param/type fidelity | active |
| concurrency | Concurrency & Teardown | close races, in-flight settling, buffer bounds | active |
| notify | LISTEN / NOTIFY | delivery to exactly the emit-time listener set | active |
| snapshot | Snapshot (dump/loadDataDir) | faithful round-trip of DB state | active |
| extensions | Extensions & Sync | bundled extensions + pglite-sync apply path | active |

## Module reconciliation (breadth floor, 2026-07-10)

`packages/pglite/src/` modules, each inside an area's loci or explicitly parked:

- `base.ts`, `pglite.ts` — transactions / query-exec / concurrency (core).
- `types.ts`, `errors.ts`, `templating.ts`, `parse.ts` — query-exec.
- `fs/*` (base, nodefs, memoryfs, index, tarUtils) — durability / snapshot.
  `fs/idbfs.ts`, `fs/opfs-ahp.ts` — **parked: unreachable-in-guest** (browser
  backends; no recipe vendored — a browser recipe would unlock them).
- `live/*` — live-queries. `worker/index.ts` — **parked: needs-harness**
  (worker-thread RPC; a second concurrency surface, standing candidate).
- `extensionUtils.ts`, `contrib/` — extensions.
- `argsParser.ts` — config resolution (start-param parsing); NOT parked — a
  durability/exec workload must exercise real start-param resolution, not a
  hard-pinned config (producer.md breadth floor). Tracked under query-exec/durability.
- `initdb.ts`, `initdbModFactory.ts` — durability (startup/reload path).
- `index.ts` — **parked: re-exports only**. `interface.ts`, `definitions/` —
  **parked: type declarations only**. `postgresMod.ts` — **parked: vendored
  WASM glue**. `polyfills/` — **parked: environment shims**. `utils.ts`,
  `extensionUtils.ts` helpers — covered transitively.

No module is in neither state; breadth floor satisfied for this refresh.

## Promoted findings

| Key | Severity | Class | Upstream | Status |
|-----|----------|-------|----------|--------|
| live-subscriber-isolation | correctness (3) | live-query subscriber teardown | pending dossier | RED confirmed — `unsubscribe(cb)` removes ALL subscribers + tears down state; all 3 variants (query/changes/incrementalQuery). `runs/live-subscriber-isolation-unsub-one.md` |
| tx-closed-handle | correctness / data-integrity (3) | tx handle writes after end | pending dossier | RED confirmed — `tx.sql` never guards + `closed` never set on throw; retained handle persists writes on auto-commit after rollback/throw. `runs/tx-closed-handle.md` |
| _(1 more source-confirmed candidate in flight: notify-quoted-unlisten)_ | | | | |
