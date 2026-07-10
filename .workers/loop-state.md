# Loop state
- rails: { loops: 100, workloads: 250 }   # from /goal args or defaults — safety rails, not targets
- counters: { episodes: 8, producer: 1, executor: 4, triage: 2, workloads: 16 }
- no-new-info: { streak: 0, K: 5 }
- in-flight unit: none
- re-entry: tx-atomicity-recovery-reentrant → switch — confirmed finding (reentrant deadlock red, baseline green). aborted-state rung stays planned (overlaps exec-recovery). L→5 (red). Remaining ready work (exec-batch reporting, durable baseline) is lower value than resolving the guest-init blocker. Streak reset (finding).
- last-scanned-sha: 1a4cce1ab9ad5e13cbef9072ea005046f153ad9b
- target-head-sha: 1a4cce1ab9ad5e13cbef9072ea005046f153ad9b
- re-plan triggers: []   # BLOCKER #2 RESOLVED 2026-07-10 (episode 9): LISTEN/NOTIFY starves the sim macrotask queue; notify+live wait via microtask drain instead of setTimeout (delivery is queueMicrotask). Baselines green in-guest. All 4 findings guest-capable. (Init blocker #1 also resolved: sync-init shim + sync-instantiate patch.)
- publish-pending: []   # DONE. 5 tx-family officials published serially at HEAD 0a59e2c, GUEST-VERIFIED (commit 68cfa67): tx-atomicity-recovery-baseline 8/8 succeeded (b1/b2 PASS); tx-atomicity-recovery-reentrant 10/10 failed (wd watchdog-red, case=reentrant); tx-closed-handle-baseline 6/6 succeeded; tx-closed-handle-sql-after-rollback 8/8 failed (r1/r2); tx-closed-handle-after-throw 10/10 failed (t1-t4). notify/live guest:blocked (BLOCKER #2), local-only.
- FINDINGS (all replayable; all guest-capable after BLOCKER #1+#2 fixes):
    1. live-subscriber-isolation — correctness sev3 — unsubscribe(cb) removes ALL subscribers + tears down state (3 variants). runs/live-subscriber-isolation-unsub-one.md — GUEST baseline green (b1 PASS); attack re-publish in flight.
    2. tx-closed-handle — data-integrity sev3 — retained tx handle writes on auto-commit after rollback/throw (tx.sql unguarded + closed never set on throw). runs/tx-closed-handle.md — GUEST-CONFIRMED (baseline green + sql-after-rollback/after-throw reds).
    3. notify-quoted-unlisten — correctness sev2 — quoted-channel disposer double-normalizes; callback fires after unsubscribe. runs/notify-quoted-unlisten.md — GUEST baseline green (s0/u1 PASS); attack re-publish in flight.
    4. tx-atomicity-recovery — availability sev2 — parent-handle db.query inside a tx deadlocks the instance. runs/tx-atomicity-recovery-reentrant.md — GUEST-CONFIRMED (baseline green + reentrant watchdog-red).
- last episode summary: >
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
