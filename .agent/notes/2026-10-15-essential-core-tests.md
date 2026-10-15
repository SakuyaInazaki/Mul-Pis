# Essential core test follow-up (2026-10-15)

Deletion scope recorded before editing. All targets are test cases in the assigned core group. Git contains the original tracked files and makes each deletion recoverable through the file history or `git diff`; no production, public documentation, runner configuration, or skip rule changes are planned. No tests or typecheck will run in this batch.

The following exact cases will be deleted because a named retained test exercises the same critical observable contract:

| Deletion target | Retained behavior check |
| --- | --- |
| `test/m07.test.ts`: `active checkpoint freezes reviewed evidence and problem inputs without closing the goal` | `test/m04-checkpoint.test.ts`: `active M07 checkpoint gives M04 only its frozen feedback, problem, and evidence directory` exercises checkpoint creation and actual downstream consumption. |
| `test/m07.test.ts`: `fulfilled goal with long real task tool log keeps its hard checks and indexes the complete log` | `test/m07.test.ts`: `M07 feedback manifests oversized frozen evidence and M04 records access without claiming full coverage` covers long indexed feedback; `test/m07-objective-progress.test.ts`: `finite objective closure still requires original checks and complete selected evidence` covers completion. |
| `test/m07.test.ts`: `review rejects fake completion and requires a relevant independent check report` | `test/m07.test.ts`: `independent check receives every artifact added from expected outputs` exercises rejection of a report-only check and acceptance only after the actual source is in the independent check. |
| `test/m07-objective-progress.test.ts`: `finite original checks cannot close a mission while host work or effects remain unresolved` | `finite objective closure still requires original checks and complete selected evidence` and `test/local-mission-evaluator.test.ts`: `default host completes a finite exact-file objective only after evaluator, M07 and full M04 review` retain the positive and negative closure conditions. |
| `test/m07-objective-progress.test.ts`: `paginated objective evidence needs its final untruncated page before dispatch` | `grounded live proposal needs full frozen reads before its decision-changing task dispatches` and `test/m04-required-m07-reads.test.ts`: `M04 replaces unchanged missing-page repair with fresh judgment and redoes full read proof` exercise complete-read gating and incomplete pages. |
| `test/m07-objective-progress.test.ts`: `an original objective can advance through multiple fresh assessed child attempts until a real boundary` | `test/local-mission-evaluator.test.ts`: `fresh CLI resumes dispatch one settled M07/M04 at a time and hold on unknown effects` runs two fresh accepted M07/M04 rounds and verifies the first is not replayed. |
| `test/m04-required-m07-reads.test.ts`: `M04 repairs a typed EOF overshoot in the same session and requires the actual missing lines` | `M04 replaces unchanged missing-page repair with fresh judgment and redoes full read proof` retains the missing-page refusal and complete fresh read; the EOF wording is a lower-level repair variant. |
| `test/m04-checkpoint.test.ts`: `checkpoint M04 rejects unregistered IDs, traversal, and a symlink replacing a frozen file` | `active M07 checkpoint gives M04 only its frozen feedback, problem, and evidence directory` retains actual frozen-root consumption; `test/context-boundary.test.ts` retains runner identity checks. This removes a path-guard permutation, not the checkpoint path. |
| `test/m07-dispatch-lock-recovery.test.ts`: `an active dispatch publishes complete owner bytes before entering its body` | `an orphan preparation cannot seize a goal; a published dead owner needs explicit recovery` keeps the live safety decision; owner-byte shape is internal. |
| `test/knowledge/retrieval.test.ts`: `withdrawn limits remain visible and experience cannot enter M07 generic packs` | `test/knowledge/store.test.ts`: `withdrawal disables pinned older versions and propagates through dependency chains` plus `test/knowledge/experience.test.ts`: `bounded selection keeps pinned evidence, argument and context together; live withdrawal blocks reuse` retain withdrawal's real effects. |

Delete these files in full, including their now-unneeded fixtures/imports:

| File | Existing replacement |
| --- | --- |
| `test/m07-reviewed-successor-goal.test.ts` | `test/local-mission-evaluator.test.ts` exercises a repaired later bounded attempt and final reviewed closure; `test/m07.test.ts` retains the accepted same-obligation retry chain. |
| `test/m07-unsettled-branch-checkpoint.test.ts` | `test/m07-context-branches.test.ts` retains branch creation and review-gated selection; `test/m07.test.ts` retains unknown-operation reconciliation and ordinary checkpoint/feedback. |
| `test/m07-failed-baseline.test.ts` | `test/local-mission-workflow.test.ts` retains failed no-proposal M04 feedback → fresh bounded work; `test/archived-m07-import.test.ts` retains a throwing M04 becoming UNKNOWN and refusing retry; `test/m04-required-m07-reads.test.ts` retains incomplete-read refusal and fresh full-read judgment. |
| `test/knowledge/experience-validation.test.ts` | `test/knowledge/experience.test.ts` retains real pinned dependency/version applicability and withdrawal; `test/knowledge/store.test.ts` retains persistence and serial merge. Malformed field-shape validation is a lower-level input permutation. |

The retained set continues to cover M01–M09 stage paths, objective continuation, source independent check, full M04 reading, knowledge versions and limits, source-version comparison, and unknown-effect no-replay through other files. This pass will remove cases, not hide them in loops, wrappers, or skip settings.

Final cleanup removes imports made unused by the above deletions: `symlink` in m04-checkpoint; `readFile` and `stat` in m07-dispatch-lock-recovery; `readFile` in m07-objective-progress; `PiSessionRunner`, `createAgentSession`, `CreateAgentSessionOptions`, `ModelRuntime`, and `Model` in m07.test. The main agent owns the final static audit and unified validation.
