---
key: live-queries
title: Live Queries
description: The @electric-sql/pglite/live extension — subscriptions, incremental diffs, and subscriber lifecycle.
order: 20
---
# Live Queries

`live.query`, `live.changes`, `live.incrementalQuery` watch the tables a query
depends on and re-run / diff on committed mutation. Each returns a subscription
with `subscribe`/`unsubscribe` and a shared callback set; the last unsubscribe
tears down backing views/state tables and DEALLOCATEs prepared diff statements.

Code loci: `packages/pglite/src/live/index.ts` (subscriber set + teardown
243/506/666, incremental double-buffer + debounce 434-489).

Harvested vs open: `tests/live.test.ts` (~74 assertions) tests subscribe-after-
creation and a single-subscriber unsubscribe race, but every `unsubscribe()`
call passes NO argument — the selective-unsubscribe branch is never exercised.
Source-confirmed defect: `callbacks.filter((callback) => callback !== callback)`
(`:506`) shadows the param, always evaluates false, and removes ALL subscribers
+ tears down state. Zero coverage; identical in three variants. See promise
`live-subscriber-isolation`.
