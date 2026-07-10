# Loop state
- rails: { loops: 100, workloads: 250 }   # from /goal args or defaults — safety rails, not targets
- counters: { episodes: 5, producer: 1, executor: 3, workloads: 9 }
- no-new-info: { streak: 0, K: 5 }
- in-flight unit: none
- re-entry: none
- last-scanned-sha: 1a4cce1ab9ad5e13cbef9072ea005046f153ad9b
- target-head-sha: 1a4cce1ab9ad5e13cbef9072ea005046f153ad9b
- re-plan triggers: >
    guest-integration-blocker — PGlite.create() wedges in the deterministic sim
    (emscripten async WASM init never resolves; all official guest runs fail into
    the liveness watchdog). Blocks official publication of every exploration.
    Investigation leads in runs/executor-notes.md §OPEN BLOCKER. This is a
    harness/product-integration issue, NOT a spec deficiency — the 3 findings hold
    on local reproduction. A producer/triage episode should resolve or escalate it
    (likely a wio-side MessageChannel scheduling gap → file against formal) before
    executor episodes can earn guest verdicts.
- publish-pending: []   # all 8 fired official runs at fixed HEAD 56bd84e, but guest verdicts blocked (see re-plan trigger); page rows exist, verdicts are watchdog-FAIL not real oracle results
- last episode summary: >
    Episode 5 (executor publication + guest integration). Fixed the vendored-import
    setup blocker (_run.sh extracts tarball to /tmp; workloads resolve via
    PGLITE_BASE). Pushed to fork, re-prepared image (56bd84e), published all 8
    officials (3 findings + baselines) via publish.py (transient convex 503s
    cleared on retry). BUT guest runs now wedge in PGlite.create() — emscripten
    WASM async init never resolves in the deterministic sim; every run is
    watchdog-FAIL, not a real verdict. Recorded as an OPEN BLOCKER + re-plan
    trigger with investigation leads. The 3 confirmed findings (live sev3,
    tx-closed sev3, notify sev2) stand on local reproduction with replayable
    invariant evidence in runs/. NEXT (dispatcher row 4 → producer/triage): resolve
    or escalate the guest-init blocker; meanwhile ready explorations
    (tx-atomicity-recovery reentrant-hang, exec-batch reporting, durable baseline)
    can be built + locally reproduced. Coverage NOT exhausted — not a FLEET-STOP.
