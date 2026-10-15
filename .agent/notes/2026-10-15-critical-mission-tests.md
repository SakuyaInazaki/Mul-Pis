# Critical mission test selection — 2026-10-15

## Decision before deletion

This is a second, more substantial test-only reduction requested after the previous cleanup. The target is the assigned `test/local*.test.ts`, `test/mission*.test.ts`, `test/ledger-continuation.test.ts`, and named mission/carry/control/evidence tests. No production file, public documentation, configuration, original user material, or other agent's test scope is a target. Existing changes in this worktree, especially the earlier edits to `test/incremental-private-checkpoint.test.ts`, must be preserved where a retained test still needs them.

Delete entire low-level or overlapping suites: `local-evaluator-attempt-journal`, `local-evaluator-two-owner-race`, `local-m07-adapter`, `local-material-bundle`, `local-mission-assessor-transport`, `local-mission-config`, `local-mission-host-evaluator-recovery`, `local-mission-host`, `local-mission-live-execute-m04`, `local-mission-longevity`, `local-original-objective`, `local-v4-to-v6-history`, `mission-state`, `mission-supervisor`, `live-control-frame`, `signed-mission-ledger`, `unobserved-control-source-review`, `interrupted-source-review`, `research-decision-view`, `research-history-locator`, `confined-campaign-evidence-read`, `periodic-prefix-private-diagnostic`, `emergency-carry`, and `prior-objective-checkpoint-evidence` (all paths under `test/` and ending `.test.ts`). These suites primarily test mocked substate, historic schema combinations, field permutations, or standalone codecs. Their key externally observable paths are exercised by retained integration tests below. The earlier deleted `local-mission-restart` and `incremental-prefix-sidecar-codec` remain deleted.

In surviving suites, remove all but the specified functional cases:

- `local-mission-evaluator`: finite objective completion after evaluator/M07/M04; open-ended reviewed incumbents; full M04 read required; fresh-process completion; real CLI start/run/resume; fresh CLI unknown-effect hold.
- `local-mission-evaluator-recovery-integration`: published knowledge plus dead recovery owner; fresh process V4 returned-evaluator recovery; opaque throw remains unknown until reconciled; two-process recovery race.
- `local-interrupted-reconcile`: exact dead-process successor review; failed M04 becomes negative history; default mission chooses distinct task after negative feedback.
- `local-mission-unissued-assessment`: admitted assessment/task reused without paid replay; killed owner permits one new-process issue.
- `local-mission-workflow`: authored input and bounded reason result reopen; live failed M04 yields frozen feedback and distinct work; bounded pass does not close open-ended obligation.
- `local-mission-published-revisions`: default next assessment reads rejected feedback and committed revision history.
- `local-mission-material-workflow`: declared binary original and text projection survive host; altered projection/index blocks reassessment.
- `local-mission-cli`: separate start/resume processes; real Pi CLI invocations retain one auth-held mission.
- `mission-resume-journal`: reservation survives restart; crash/unknown delivery cannot cause duplicate update.
- `mission-host-adapter`: authenticated connector bridge; repeated request preserves reservation; linked unknown old control; authenticated multipart carry reconstruction.
- `ledger-continuation`: authenticated terminal carry; restored history across emergency carry; signed seed/cumulative ceiling; terminal missing-carry remains unknown; accepted selection stays authenticated across wrappers.
- `assessor-grounding`: traceable proposal; prior issue resolves only with cited evidence; live task source binding.
- `final-carry-upload`: current encrypted chunks before sealed manifest; missing or ambiguous part never publishes root manifest.
- `objective-checkpoint-store`: multipart exact UTF-8 reconstruction; altered/missing/symlinked parts rejected.
- `read-live-control-frame`: authenticated CLI read; wrong source or tampered ciphertext writes no private result.
- `incremental-private-checkpoint`: initial sealed prefix; atomic RSA wrapper round trip; altered prefix/wrong key rejected.
- `live-control-actions-smoke`: authenticated committed prefix and status round trip.

All named files are tracked, so deleted tests and helpers can be restored from `HEAD` with Git after reviewing this change. This note is written before any deletion. The selection is based on real workflow boundaries, not a numeric case target. Retained integration tests are the representative replacement coverage for the removed unit/state matrices. I will record the final counts and static inspection below. No test or typecheck will run in this delegated work.

## Final static cleanup

Remove `test/fixtures/local-evaluator-reopen-process.ts`: no remaining repository source references after the corresponding historical recovery tests were removed. Recoverable from Git HEAD. Normalize extra EOF blank lines in the edited test files. No production changes are part of this cleanup.

## Completion

The recorded deletions and dead-code cleanup are complete, including the orphan reopen-process fixture. The retained mission suites passed in the consolidated full Node run. No test/typecheck was run during this delegated editing phase. Final all-area counts and the one unrelated observer import correction are recorded in `2026-10-15-critical-runtime-tests.md`.
