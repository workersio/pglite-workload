# Loop state
- rails: { loops: 100, workloads: 250 }   # from /goal args or defaults — safety rails, not targets
- counters: { episodes: 4, producer: 1, executor: 3, workloads: 9 }
- no-new-info: { streak: 0, K: 5 }
- in-flight unit: none
- re-entry: notify-quoted-unlisten-quoted → switch — confirmed finding (quoted red, baseline green). registry-parity rung stays planned. L→5 (red); no same-[path pglite-utils:toPostgresName] sibling in backlog → no inherit. Remaining ready work (tx-atomicity-recovery, exec, durable baseline) plus the wio official publication of 3 held findings outrank deepening here. Streak reset (finding).
- last-scanned-sha: 1a4cce1ab9ad5e13cbef9072ea005046f153ad9b
- target-head-sha: 1a4cce1ab9ad5e13cbef9072ea005046f153ad9b
- re-plan triggers: none
- publish-pending: [live-subscriber-isolation-baseline, live-subscriber-isolation-unsub-one, live-subscriber-isolation-variants, tx-closed-handle-baseline, tx-closed-handle-sql-after-rollback, tx-closed-handle-after-throw, notify-quoted-unlisten-baseline, notify-quoted-unlisten-quoted]
- last episode summary: >
    Episode 4 (executor → notify-quoted-unlisten). Built
    workloads/notify_quoted_unlisten.mjs. Local node draft vs vendored 0.5.4:
    baseline GREEN (lowercase disposer works; selftest FAILs, anti-vacuity);
    quoted RED — after unsub() on channel '"MyChannel"', pg_notify still fires the
    callback (toPostgresName double-normalize → UNLISTEN targets wrong lowercase
    name). CONFIRMED FINDING (correctness, sev 2). Test-reviewer (emulated): KEEP.
    THREE confirmed findings now held (live sev3, tx-closed sev3, notify sev2), all
    published: pending. Next: publish the 3 findings officially via wio
    (commit+push → projects prepare → publish.py official runs), then continue
    executor on tx-atomicity-recovery (reentrant-hang hypothesis).
