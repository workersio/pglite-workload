# Loop state
- rails: { loops: 100, workloads: 250 }   # from /goal args or defaults — safety rails, not targets
- counters: { episodes: 1, producer: 1, executor: 0, workloads: 0 }
- no-new-info: { streak: 0, K: 5 }
- in-flight unit: none
- re-entry: none
- last-scanned-sha: 1a4cce1ab9ad5e13cbef9072ea005046f153ad9b
- target-head-sha: 1a4cce1ab9ad5e13cbef9072ea005046f153ad9b
- re-plan triggers: none
- publish-pending: []
- last episode summary: >
    Episode 1 (producer, cartographer). Init-scaffolded .workers/ (map, backlog,
    loop-state, publish.py → pglite project kn75132e9yw…, lib+recipes copied).
    5 scouts fanned out → 8 areas, module-reconciliation breadth floor satisfied.
    Backlog seeded (12 active, top 288). Promoted 6 promises / 12 ready
    explorations, gated by strategy-critic (REDO → applied): live-subscriber-isolation,
    tx-closed-handle (+after-throw hole), tx-atomicity-recovery, exec-batch-atomicity
    (reframed to error-identity reporting — all-or-nothing is expected-green),
    notify-quoted-unlisten (counter-promoted), durable-reopen (downscoped to
    clean-close roundtrip; crash rungs parked as not-Node-reproducible, ladder-floor
    certified). THREE source-confirmed reds queued: live shadow-unsubscribe,
    tx.sql/throw closed-handle escape, quoted-channel unlisten. Next: dispatcher
    row 5 → executor on oldest ready baseline.
