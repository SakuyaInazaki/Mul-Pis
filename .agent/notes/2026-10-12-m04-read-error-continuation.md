# M04 read-error continuation, 2026-10-12

Target for removal: `src/stages/m04.ts` classified any new `m07_evidence_read` error as unrecoverable unless it was a narrowly matching EOF overshoot for a file still reported missing. It threw even when the model could correct a wrong filename or generic read error in the same read-only session, and even when all required frozen M07 files had already been returned completely. The deleted branch and its prior tests remain recoverable in Git history.

This branch made a tool error into an M04 termination condition independent of the host's actual read coverage. The necessary boundary is the frozen required-file set and `m07ReadGaps`: failed reads supply no coverage, missing lines receive the host's actual ranges for same-session repair, and complete required returns allow judgment to proceed. Frozen source binding checks, aborts, read-tool confinement, and later proposal and merge validation remain in place.

The existing read-error regressions were rewritten to assert correction without premature proposal merge, host actual line-count guidance after an incorrect EOF report, and completion after a surplus failed read when required evidence is complete. Tests are offline fake-session tests; no model or network request is made.

Verification: the three rewritten tests failed against the old branch with `m04.m07-evidence` before a repair turn. After removal they passed (3/3). The complete `test/m04-required-m07-reads.test.ts` passed (46/46), and `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` passed.
