---
key: notify
title: LISTEN / NOTIFY
description: Notification delivery to exactly the listeners subscribed at emit time, including tx-scope and channel casing.
order: 60
---
# LISTEN / NOTIFY

`db.listen(channel, cb)` registers a JS callback and runs SQL `LISTEN`; NOTIFY
fires each listener via `queueMicrotask` (`pglite.ts:1100-1112`). Channel names
pass through `toPostgresName` (`pglite-utils/src/utils.ts:134`), which is **not
idempotent** for quoted (case-sensitive) names.

Code loci: `packages/pglite/src/pglite.ts` (listen 1166-1197, notify dispatch
1100-1112, unlisten 1212-1256), `pglite-utils/src/utils.ts:134` (`toPostgresName`).

Harvested vs open: `notify.test.ts` is the suite's most exhaustive file for
channel case-sensitivity, but only on lowercase-channel disposer paths. Open
corridors: unsubscribe disposer double-normalizing a quoted channel (deletes
wrong key → spurious delivery after unsubscribe), LISTEN registered inside a
rolled-back transaction leaving a phantom JS listener, and delivery to a
callback removed between NOTIFY and its queued microtask. Lower severity
(correctness) than the transaction/durability corridors.
