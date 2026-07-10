# Loop state
- rails: { loops: 100, workloads: 250 }   # from /goal args or defaults — safety rails, not targets
- counters: { episodes: 6, producer: 1, executor: 4, workloads: 12 }
- no-new-info: { streak: 0, K: 5 }
- in-flight unit: none
- re-entry: tx-atomicity-recovery-reentrant → switch — confirmed finding (reentrant deadlock red, baseline green). aborted-state rung stays planned (overlaps exec-recovery). L→5 (red). Remaining ready work (exec-batch reporting, durable baseline) is lower value than resolving the guest-init blocker. Streak reset (finding).
- last-scanned-sha: 1a4cce1ab9ad5e13cbef9072ea005046f153ad9b
- target-head-sha: 1a4cce1ab9ad5e13cbef9072ea005046f153ad9b
- re-plan triggers: >
    guest-integration-blocker (OPEN) — PGlite.create() wedges in the deterministic
    sim; probe confirmed the hang is inside create() and NOT mem/timeout-bound
    (--mem 2048 --timeout 120 unchanged). All official guest verdicts blocked.
    Leads + escalation path in runs/executor-notes.md §OPEN BLOCKER. A triage
    episode should escalate to formal (wio) or find a PGlite eager/sync-init path.
- publish-pending: []   # 8 officials fired at HEAD 56bd84e; guest verdicts are watchdog-FAIL (blocker), not real oracle results. tx-atomicity-recovery not yet published (blocked).
- FINDINGS (local reproduction, replayable; guest publication blocked):
    1. live-subscriber-isolation — correctness sev3 — unsubscribe(cb) removes ALL subscribers + tears down state (3 variants). runs/live-subscriber-isolation-unsub-one.md
    2. tx-closed-handle — data-integrity sev3 — retained tx handle writes on auto-commit after rollback/throw (tx.sql unguarded + closed never set on throw). runs/tx-closed-handle.md
    3. notify-quoted-unlisten — correctness sev2 — quoted-channel disposer double-normalizes; callback fires after unsubscribe. runs/notify-quoted-unlisten.md
    4. tx-atomicity-recovery — availability sev2 — parent-handle db.query inside a tx deadlocks the instance. runs/tx-atomicity-recovery-reentrant.md
- last episode summary: >
    Episode 6 (executor → tx-atomicity-recovery, local). Built
    tx_atomicity_recovery.mjs. baseline GREEN (selftest FAILs); reentrant RED —
    parent-handle db.query inside a transaction callback deadlocks (non-reentrant
    mutex), the common await-db-vs-await-tx footgun. 4th CONFIRMED FINDING
    (availability sev2). Also this session: characterized the guest-init blocker
    with a probe (hang is inside PGlite.create(), not mem/timeout). NEXT SESSION
    (dispatcher row 4 → triage the guest-init blocker): escalate to formal or find
    a sync-init path; then the 4 findings' officials unblock and executor resumes on
    the remaining ready explorations (exec-batch-atomicity-{baseline,midfail},
    durable-reopen-baseline). Coverage NOT exhausted — not a FLEET-STOP.
