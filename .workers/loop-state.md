# Loop state
- rails: { loops: 100, workloads: 250 }   # from /goal args or defaults — safety rails, not targets
- counters: { episodes: 2, producer: 1, executor: 1, workloads: 3 }
- no-new-info: { streak: 0, K: 5 }
- in-flight unit: none
- re-entry: live-subscriber-isolation-unsub-one → stop — confirmed finding across all 3 rungs (baseline green + unsub-one/variants red); corridor fully falsified, remaining work is the maintainer dossier (separate funnel step), no more attack surface here. L→5 (red, corridor promoted so row deleted); no same-[path]-tag sibling in backlog (live/index.ts:subscribe vs live/index.ts:incremental differ) → no inherit. Streak reset (finding added information).
- last-scanned-sha: 1a4cce1ab9ad5e13cbef9072ea005046f153ad9b
- target-head-sha: 1a4cce1ab9ad5e13cbef9072ea005046f153ad9b
- re-plan triggers: none
- publish-pending: [live-subscriber-isolation-baseline, live-subscriber-isolation-unsub-one, live-subscriber-isolation-variants]
- last episode summary: >
    Episode 2 (executor → live-subscriber-isolation). Built
    workloads/live_subscriber_isolation.mjs (universal plane: liveness watchdog +
    ORACLE_SELFTEST red-proof). Local node v22 draft vs vendored 0.5.4 dist:
    baseline GREEN (selftest FAILs, anti-vacuity proven); unsub-one RED
    (surviving_subscriber_delivered + backing_state_intact FAIL); variants RED
    (live.changes + live.incrementalQuery). CONFIRMED FINDING (correctness, sev 3):
    unsubscribe(cb) removes ALL subscribers + tears down state — the
    `filter(n=>n!==n)` shadow bug, verbatim in all 3 vendored variants. Test-reviewer
    (emulated): KEEP. wio official runs: pending (batch prepare). Next: dispatcher
    row 5 → executor on tx-closed-handle (next confirmed red).
