# Loop state
- rails: { loops: 100, workloads: 250 }   # from /goal args or defaults — safety rails, not targets
- counters: { episodes: 9, producer: 1, executor: 4, triage: 3, workloads: 20 }
- no-new-info: { streak: 0, K: 5 }
- in-flight unit: none
- re-entry: tx-atomicity-recovery-reentrant → switch — confirmed finding (reentrant deadlock red, baseline green). aborted-state rung stays planned (overlaps exec-recovery). L→5 (red). Remaining ready work (exec-batch reporting, durable baseline) is lower value than resolving the guest-init blocker. Streak reset (finding).
- last-scanned-sha: 1a4cce1ab9ad5e13cbef9072ea005046f153ad9b
- target-head-sha: 1a4cce1ab9ad5e13cbef9072ea005046f153ad9b
- re-plan triggers: []   # BLOCKER #2 RESOLVED 2026-07-10 (episode 9): LISTEN/NOTIFY starves the sim macrotask queue; notify+live wait via microtask drain instead of setTimeout (delivery is queueMicrotask). Baselines green in-guest. All 4 findings guest-capable. (Init blocker #1 also resolved: sync-init shim + sync-instantiate patch.)
- publish-pending: []   # DONE. All 10 officials published serially at HEAD 9416ccb, GUEST-VERIFIED (published ids in promises/*.md, commit 241c1b3). Clean matrix: 4 baselines green (live 8/8, notify 6/6, tx-atomicity 8/8, tx-closed 6/6); 6 attacks red with real oracle evidence.
- FINDINGS (all replayable; ALL GUEST-CONFIRMED — baseline green + attack red in the sim):
    1. live-subscriber-isolation — correctness sev3 — unsubscribe(cb) removes ALL subscribers + tears down state (3 variants). runs/live-subscriber-isolation-unsub-one.md — GUEST-CONFIRMED (baseline b1 PASS; unsub-one u1/u3 FAIL 12/12; variants v_changes/v_incrementalQuery FAIL 12/12).
    2. tx-closed-handle — data-integrity sev3 — retained tx handle writes on auto-commit after rollback/throw. runs/tx-closed-handle.md — GUEST-CONFIRMED (baseline green; sql-after-rollback r1/r2; after-throw t1-t4).
    3. notify-quoted-unlisten — correctness sev2 — quoted-channel disposer double-normalizes; callback fires after unsubscribe. runs/notify-quoted-unlisten.md — GUEST-CONFIRMED (baseline s0/u1 PASS; quoted u1 FAIL 8/8).
    4. tx-atomicity-recovery — availability sev2 — parent-handle db.query inside a tx deadlocks the instance. runs/tx-atomicity-recovery-reentrant.md — GUEST-CONFIRMED (baseline green; reentrant watchdog-red 10/10).
- last episode summary: >
    Episode 9 (triage #3 → BLOCKER #2 resolved; ALL 4 findings guest-confirmed).
    probe_listen (writeSync marks) localized BLOCKER #2 precisely: db.listen +
    pg_notify both complete in-guest; the wedge is the NEXT setTimeout — the
    LISTEN/NOTIFY path starves the sim's MACROTASK queue (timers die) while
    microtask ops and queueMicrotask delivery (pglite.ts:1105) still run. Fix:
    notify + live workloads wait via a bounded MICROTASK drain (await
    Promise.resolve()) instead of settle()/waitFor() setTimeout. In-guest:
    notify + live baselines green, attacks red (real oracles). Removed
    guest:blocked; re-published ALL 10 officials serially → clean matrix, all 4
    findings GUEST-CONFIRMED. Reusable technique for event-driven WASM products
    in the sim: force synchronous WebAssembly.instantiate + drain microtasks
    (never setTimeout) for notification/live waits.
    NEXT CYCLE (dispatcher row 5 → ready explorations, now guest-capable): the
    ready set is exec-batch-atomicity-{baseline,midfail} + durable-reopen-baseline
    (pure query/durability); backlog top is inflight-close-crash (score 288,
    un-attacked). Coverage NOT exhausted — not a FLEET-STOP.
    ---- prior ----
    Episode 8 (triage #2 → guest execution made RELIABLE + 2 findings guest-confirmed).
    (1) Init blocker fully resolved: the sync-init shim alone was flaky (probe_ops
    wedged at createPGlite even with pre-compiled Modules) — the async
    WebAssembly.instantiate(module,imports) TASK is serviced unreliably by the sim.
    Added a global monkeypatch in _pglite.mjs making instantiation fully SYNCHRONOUS
    (new WebAssembly.Instance). probe_ops then succeeded through
    create/query/exec/transaction in-guest. (2) Learned the guest-time model: the
    unref'd liveness watchdog fires only on a true idle-wedge, NOT on virtualMs (a
    healthy run reaches vms ~870s); use fs.writeSync for guest evidence (abrupt
    process.exit drops buffered stdout). (3) BLOCKER #2 discovered: LISTEN/NOTIFY +
    live-query SETUP wedges post-init and is NOT workload-shimmable → notify + live
    marked guest:blocked, local-only. (4) publish.py hardened: skips guest:blocked,
    publishes SERIALLY (drain between batches — the 88-workload batch had thrashed
    the worker), retries OCC/503. (5) Published the 5 guest-capable tx-family
    officials serially and VERIFIED clean verdicts (baselines green, attacks red).
    Net: tx-atomicity-recovery + tx-closed-handle are GUEST-CONFIRMED; the other two
    stand on local repro pending BLOCKER #2.
    NEXT CYCLE (dispatcher: BLOCKER #2 trigger is set → row 4 producer/triage OR
    row 5 ready explorations). Ready & now guest-capable: exec-batch-atomicity-
    {baseline,midfail}, durable-reopen-baseline (pure query/durability, no
    LISTEN/live). Coverage NOT exhausted — not a FLEET-STOP.
