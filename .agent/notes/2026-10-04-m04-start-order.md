# M04 start-order ambiguity (2026-10-04)

An offline regression exposed that sequential M04 runs could receive the same millisecond `startedAt`. Run IDs include a random suffix, so sorting equal-time records by directory order could select an older completed baseline instead of a newer failed run. Completion time is also insufficient to prove creation order in that tie.

`Workspace.startRun` now serializes same-process allocations for a workspace/stage and assigns a persisted `startSequence` after inspecting existing records. `startedAt` continues to report the actual wall-clock time. The sequence gives newly created runs an explicit order across sequential process restarts. Legacy records that have a tied or newer timestamp than the maximum-sequence candidate cause M07 formal-baseline selection to fail closed instead of choosing a random candidate. Duplicate maximum sequences from a simultaneous multi-process allocation also fail closed; this does not add a distributed multi-process lock for simultaneous stage starts.

New regressions cover persisted sequential/concurrent-in-process allocation, forced same-time sequenced records, and ambiguous legacy M04 records. Typecheck, the M07 test file (43 tests), and the full offline suite (356 tests) passed. No model call or lab run was made for this change.
