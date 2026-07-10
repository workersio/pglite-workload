# Loop state
- rails: { loops: 100, workloads: 250 }   # from /goal args or defaults — safety rails, not targets
- counters: { episodes: 3, producer: 1, executor: 2, workloads: 6 }
- no-new-info: { streak: 0, K: 5 }
- in-flight unit: none
- re-entry: tx-closed-handle-after-throw → switch — confirmed finding (sql-after-rollback + after-throw red, baseline green). Corridor falsified; sql-after-commit rung stays planned (same defect, low marginal value). L→5 (red); no same-[path base.ts:transaction] sibling in backlog → no inherit. Next confirmed red (notify-quoted-unlisten) outranks deepening here. Streak reset (finding).
- last-scanned-sha: 1a4cce1ab9ad5e13cbef9072ea005046f153ad9b
- target-head-sha: 1a4cce1ab9ad5e13cbef9072ea005046f153ad9b
- re-plan triggers: none
- publish-pending: [live-subscriber-isolation-baseline, live-subscriber-isolation-unsub-one, live-subscriber-isolation-variants, tx-closed-handle-baseline, tx-closed-handle-sql-after-rollback, tx-closed-handle-after-throw]
- last episode summary: >
    Episode 3 (executor → tx-closed-handle). Built workloads/tx_closed_handle.mjs.
    Local node draft vs vendored 0.5.4: baseline GREEN (selftest FAILs, anti-vacuity);
    sql-after-rollback RED (tx.sql persists id=99 on auto-commit — no checkClosed);
    after-throw RED and BROADER than predicted — tx.query+exec+sql ALL persist
    [96,97,98] because the throw/rollback path never sets closed=true. CONFIRMED
    FINDING (data-integrity, sev 3). Test-reviewer (emulated): KEEP. wio official:
    pending (batch). Two confirmed findings now held (live + tx-closed). Next:
    dispatcher row 5 → executor on notify-quoted-unlisten (3rd confirmed red).
