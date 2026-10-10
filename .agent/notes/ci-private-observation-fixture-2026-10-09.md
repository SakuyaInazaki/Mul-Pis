# Private evaluator observation fixture repair

## Evidence and change

The public Offline workflow regression run 37939973717, job 113851567043,
tested commit 14931936b5cd519c71706a04bc9e8dd87093708c. Typecheck passed;
Node tests reported 1451 passed and 1 failed out of 1452. The failure was
`default assessor can pass a bounded task check while the original open-ended obligation remains unresolved`
in `test/local-mission-workflow.test.ts`, with
`HarnessError: evaluator output file is not private` from
`src/m07/local-evaluator-run.ts:370`. The subsequent Python commands did not
run after the Node failure, and the synthetic Node 24 live observer artifact
step was skipped.

The fixture created `observation-bounded.txt` without an explicit file mode.
It now creates that output with mode `0o600`, matching the existing private
evaluator output contract and another fixture in the same test file.
No production privacy guard, evaluator behavior, or scientific acceptance
condition is changed. A restrictive local umask could explain the earlier
reported local pass, but that environment difference is an inference, not
established by the CI log.

## Verification

- Under explicit umask `022`, the complete local mission workflow test file
  passed 5/5 tests after the fix.
- Python offline suites passed: transport 21, browser task 4, browser artifacts
  9 (34 total).
- Local runtime is Node 24.19.0; the failed CI run used Node 24.21.0.
- Typecheck passed, followed by all 1452 Node tests passing, with zero failures,
  cancellations, or skips. Exact commands, under explicit umask `022`, were
  `CI=true npm --offline --no-update-notifier run typecheck` and
  `CI=true npm --offline --no-update-notifier test`. Existing local dependencies
  were reused without installation. The Node suite took 433.6 seconds.
- An earlier aggregate invocation was interrupted after learning that another
  invocation had been denied for unintended registry access; neither earlier
  invocation is counted as a pass. Read-only inspection of installed npm's
  `cli/entry.js` and `cli/update-notifier.js` found an asynchronous npm metadata
  request even for script commands. The corrected invocation explicitly
  disables that notifier and requires offline dependency access while running
  the same repository scripts. No network permission was expanded.
- The synthetic artifact upload path requires GitHub Actions runtime and has
  not been rerun locally. Publication and fresh CI verification remain pending.

Only the fixture and this reviewed source-only change note belong to this
batch. No private runs, authentication data, or local dependency files are
included.
