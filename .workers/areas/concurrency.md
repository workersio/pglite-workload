---
key: concurrency
title: Concurrency & Teardown
description: Async JS calls interleaving into one WASM DB — close races, in-flight-query settling, buffer bounds.
order: 50
---
# Concurrency & Teardown

PGlite is single-connection/single-threaded, but the JS API is async: multiple
`query`/`exec`/`transaction`/`close` promises can be launched without awaiting.
Internally a `#queryMutex`/`#transactionMutex` (`async-mutex`) serializes work,
but `close()` acquires **neither** — it force-exits the WASM runtime
(`pglite.ts:787-833`), so a query mid-`#runQuery` (six awaited protocol steps,
`base.ts:254-331`) can call into a torn-down module.

Code loci: `packages/pglite/src/pglite.ts` (`close` 787-833, mutexes 95-98,
protocol 894-1090), `base.ts` (mutex layering 192-245), `worker/index.ts`
(worker RPC — a second concurrency surface, currently parked pending harness).

Reachable in a Node/alpine guest: yes — `Promise.all([db.query(slow), db.close()])`.

Harvested vs open: the only `close()` tests are strictly sequential. Open
corridors: close-races-in-flight-query (crash/hang), unbounded receive-buffer
growth (`pglite.ts:736-746`, MAX_BUFFER_SIZE clamp looks dead), and the
worker-thread RPC close/race layer (parked).
