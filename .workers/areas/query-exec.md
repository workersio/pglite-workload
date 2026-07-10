---
key: query-exec
title: Query & Exec Semantics
description: Multi-statement exec ordering/atomicity, post-error recovery, parameter binding, and type round-trips.
order: 40
---
# Query & Exec Semantics

`db.query(sql, params)` (extended protocol, bound params) and `db.exec(multi)`
(simple protocol, one result per statement). The protocol loop keeps processing
batched messages after a per-statement longjmp, saving only the first error
(`pglite.ts:927-949`), and start params set `exit_on_error=false`
(`pglite.ts:156`). Parameter serialization is chosen by server-inferred OID with
a `param.toString()` fallback when the type is unknown (`base.ts:279-290`).
Type (de)serialization lives in `types.ts`.

Code loci: `packages/pglite/src/pglite.ts` (protocol loop 894-1090), `base.ts`
(`#runQuery` 254-331, `#runExec`/simple path 340-385, param bind 279-290),
`types.ts`, `errors.ts`, `templating.ts`, `parse.ts`.

Harvested vs open: type round-trip and NOTIFY casing are heavily tested; the
authors fear serialization edges (4 discrete recent type fixes: bigint arrays,
untyped params, nulls-in-arrays, boolean coercion). Open corridors: mid-batch
`exec` failure atomicity + post-error recovery (untested), OID-inference
`toString()` fallback fidelity, and property round-trips over
nested-array/null/bigint-magnitude combinations.
