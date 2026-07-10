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

| Key | Title | Promises | Status |
|-----|-------|----------|--------|
| _(empty — first producer episode fills this)_ | | | |

## Promoted findings

| Key | Severity | Class | Upstream | Status |
|-----|----------|-------|----------|--------|
| _(none yet)_ | | | | |
