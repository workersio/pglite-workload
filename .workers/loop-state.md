# Loop state
- rails: { loops: 100, workloads: 250 }   # from /goal args or defaults — safety rails, not targets
- counters: { episodes: 7, producer: 1, executor: 4, triage: 1, workloads: 13 }
- no-new-info: { streak: 0, K: 5 }
- in-flight unit: none
- re-entry: tx-atomicity-recovery-reentrant → switch — confirmed finding (reentrant deadlock red, baseline green). aborted-state rung stays planned (overlaps exec-recovery). L→5 (red). Remaining ready work (exec-batch reporting, durable baseline) is lower value than resolving the guest-init blocker. Streak reset (finding).
- last-scanned-sha: 1a4cce1ab9ad5e13cbef9072ea005046f153ad9b
- target-head-sha: 1a4cce1ab9ad5e13cbef9072ea005046f153ad9b
- re-plan triggers: >
    guest-notify-live-blocker (OPEN, BLOCKER #2) — LISTEN/NOTIFY (`db.listen`) and
    live-query (`db.live.query`) SETUP wedge at the 20s liveness watchdog in the sim,
    baseline included; anti-vacuity broken in-guest for notify-quoted-unlisten +
    live-subscriber-isolation. Not workload-shimmable. Leads + escalation path in
    runs/executor-notes.md §OPEN BLOCKER #2. (init blocker #1 RESOLVED via sync-init shim.)
- publish-pending: >
    10 officials fired at HEAD 74463d5 (ids in promises/*.md, commit 08c3d20) but the
    88-workload batch THRASHED the 16-slot worker (worker_terminated interruptions) and
    was CANCELLED. Two problems surfaced: (a) BLOCKER #2 — notify + live workloads wedge
    at the liveness watchdog even at BASELINE (async LISTEN/live setup not serviced by the
    sim; see executor-notes §OPEN BLOCKER #2); (b) tx-family verdicts came back as
    watchdog-wedges too, but under heavy thrash — UNTRUSTWORTHY. Re-verifying the tx-family
    with CLEAN isolated depth-1 drafts (no contention) before any re-publish. Officials must
    be RE-RUN in small batches (≤2 explorations) to avoid the thrash. All 4 findings remain
    solid on LOCAL reproduction regardless.
- FINDINGS (local reproduction, replayable; guest publication blocked):
    1. live-subscriber-isolation — correctness sev3 — unsubscribe(cb) removes ALL subscribers + tears down state (3 variants). runs/live-subscriber-isolation-unsub-one.md
    2. tx-closed-handle — data-integrity sev3 — retained tx handle writes on auto-commit after rollback/throw (tx.sql unguarded + closed never set on throw). runs/tx-closed-handle.md
    3. notify-quoted-unlisten — correctness sev2 — quoted-channel disposer double-normalizes; callback fires after unsubscribe. runs/notify-quoted-unlisten.md
    4. tx-atomicity-recovery — availability sev2 — parent-handle db.query inside a tx deadlocks the instance. runs/tx-atomicity-recovery-reentrant.md
- last episode summary: >
    Episode 7 (triage → guest-init blocker, RESOLVED). Diagnosed the wedge:
    PGlite.create() hits two event-loop-blocked ops the deterministic sim does
    not pump — WebAssembly.instantiate(buffer) async *compile* and async
    fs.readFile for pglite.wasm/pglite.data. Both have microtask-only
    alternatives reachable via PGlite injection options (pgliteWasmModule +
    initdbWasmModule pre-compiled Modules, fsBundle Blob). Factored into
    .workers/workloads/_pglite.mjs; proven by probe_init_sync guest run
    (INVARIANT pglite_init_sync PASS, exit 0). Retrofitted all 4 finding
    workloads through the helper (baseline green + selftest red preserved,
    attacks still red locally). Hardened tx_atomicity_recovery: after the
    reentrant deadlock the instance LIVELOCKS the JS event loop (macrotasks
    starve) — emit verdict + process.exit synchronously; race the tx from
    outside for a precise re1 (guest still falls back to the pre-armed liveness
    watchdog, a valid availability red). publish.py now runs officials at
    mem 2048 / timeout 120. Fired 10 officials with REAL guest verdicts.
    NEXT CYCLE (dispatcher row 5 → ready explorations): verify the 10 official
    verdicts landed (4 green / 6 red), update the map's guest-reality note +
    promoted-findings table, then executor on the remaining ready explorations
    (exec-batch-atomicity-{baseline,midfail}, durable-reopen-baseline).
    Coverage NOT exhausted — not a FLEET-STOP.
