# Workflow critical fixes: M09 partial closure and M07 interrupt/archive

- Date: 2026-09-20
- Scope: implementation and tests for the two blocking issues found in the XPUOJ trial.
- M09: `SessionGate.status` now accepts `partial` in addition to `checked | needs_fix | blocked`.
- M09: `partial` is only accepted when the paired M04 `m08-disposition` status is `partial`; it must keep a non-empty real `unresolved` array.
- M09: `checked` still requires empty `unresolved`; `nonBlockingLimitations` remains a separate caller-confirmed list.
- M09: gate `scope` now accepts the same included set in any order and canonicalizes it back to the included order.
- M09: the organizer prompt no longer points at the delivery copy as if it were readable inside the organizer root.
- M07: added `research_goal action="interrupt"` plus `reason`.
- M07: interrupt marks every running task as `failed` with `executionFailure`, closes the goal as `blocked`, writes the M07 feedback package, and marks the M07 run failed.
- M07: interrupt is archival only; it does not auto-rerun, claim completion, or silently replace task state.
- Tests: added M07 interrupt archival test and M09 partial-closure/fail-closed test.
- Verification: `npm run typecheck` passed; full `npm test` passed 123 tests.

- Files touched: src/stages/m09.ts, src/m07/types.ts, src/m07/controller.ts, src/pi/service.ts, src/pi/extension.ts, test/m07.test.ts, test/m09.test.ts, docs/implementation/design.md, docs/research/workflow-foundation.md, README.md.
- README runtime-status sentence updated to record the 2026-09-20 real-model trial and the two critical fixes without claiming full M01–M09 pass or self-improvement.
