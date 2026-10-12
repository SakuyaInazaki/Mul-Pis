# Workflow repair publication and review record

This publication updates the existing workflow repair review branch. It includes reusable source, offline tests, implementation documentation and reviewed general change notes. Experiment workspaces, account material, original runtime logs and private adapters are outside this publication. Existing private records remain unchanged. The previous README was retained locally before adding the review entry; no source history was deleted or rewritten.

## Changes and reasons

| Area | Resulting behavior | Main implementation and regression |
|---|---|---|
| Continuous goal execution | New execute delegations automatically enter the existing execution/review/repair loop. Builder return and negative results do not satisfy the original goal. Reviewed forks retain the same obligations. | `src/m07/controller.ts`, `test/m07-execution-loop.test.ts`, `test/m07-reviewed-successor-goal.test.ts` |
| External-operation reconciliation | A configured read-only host observer can provide a receipt for an unknown operation. Model input cannot choose the receipt or result. Newly confirmed execution is returned to the caller before another execute task is created; not-issued can proceed and unknown remains unresolved. | `src/pi/service.ts`, `src/pi/extension.ts`, `test/pi-operation-reconcile.test.ts`, `test/pi-operation-reconcile-extension.test.ts` |
| Fresh host recovery | Recovery preserves the frozen goal and method while allowing the new host to explicitly refresh an intervening M04 baseline before further execution. | `src/m07/controller.ts`, `test/m07.test.ts` |
| Knowledge status | Render question status, closure/version context, replacement references and live restrictions; recognize resolved questions without rewriting original records. | `src/knowledge/pack.ts`, `src/knowledge/retrieval.ts`, `test/knowledge/pack-views.test.ts`, `test/knowledge/retrieval.test.ts` |
| New-session compaction | New ordinary sessions use the native 200k trigger with recorded settings. Resumes retain their recorded policy; existing sessions and controlled strict-request sessions keep their settings. | `src/runner/compaction.ts`, `src/runner/pi.ts`, `test/runner/compaction.test.ts`, `test/runner/pi.test.ts` |
| Evidence and model context | Correctable M04 reads can continue; successful required reads are not invalidated by an unrelated failed read. Objective checks retain current obligations while older material remains retrievable. Required evidence is not rejected by the former arbitrary path-count check. | `src/stages/m04.ts`, `src/m07/objective-progress.ts`, `src/workflow-archive/m07-private.ts`, relevant M04/M07/archive tests |
| Runtime compatibility | Canonicalize new workspace paths, share process identity checks across platforms, preserve transcript stream typing and use compatible no-cache HTTP headers. Platform-specific tests state their actual prerequisites. | `src/m07/local-mission.ts`, `src/runner/mission-resume-journal.ts`, provider metadata readers and portability tests |
| Documentation | The review entry describes current code. Repeated unchanged rounds produce feedback rather than a fixed-count stop. Historical publication permissions no longer read as current blanket authorization. | `README.md`, `AGENTS.md`, `docs/implementation/`, `docs/github-push-policy.md` |

## Validation

Verification was run after the final source and test changes were frozen, using the installed dependencies and no real model or network calls:

- TypeScript: `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` passed.
- Node: `node --test --test-concurrency=1 'test/**/*.test.ts'` completed with 1,580 tests: 1,564 passed, zero failed and 16 skipped. Fifteen skipped cases require Linux-specific process or compiled-checker behavior; one requires a local research PDF fixture. Runtime was 394.84 seconds.
- Python transport: `python3 -m unittest discover -s test -p '*_test.py' -v` passed 22 tests.
- Python acquisition/browser: `PYTHONPATH=tools/py python3 -m unittest discover -s tools/py -p 'test_*.py' -v` passed 13 tests.
- The final reconciliation regression separately passed seven tests. The five improvement-related test files passed 80 offline tests during the preceding capability audit and are included in the full suite above.
- `git diff --cached --check` passed. The prospective public tree contains 636 files, with no tracked active workspace, private/telemetry/improvement tree, dependency checkout, symlink or nested Git directory. Added credential-related code uses runtime variables or an explicitly synthetic test key, not account credentials.

The initial full Node run was interrupted only to freeze the final reconciliation fix; its diagnostic log was retained locally. The counts above come from the subsequent complete run. Live research sessions were not restarted for this publication.

## Capability and research interpretation

The executable workflow includes persistent goals, real task sessions, independent review/repair and the existing M04 knowledge path. Local observations include successive autonomous task completions and knowledge updates. This source publication does not include the original private experiment records; those observations should be distinguished from the reproducible offline regressions shipped here. Full M01–M09 real-run acceptance, unattended recovery across every provider/process failure and causal knowledge benefit remain separate validation questions.

The existing improvement code versions strategy parameters and data-only H/I methods, with development evaluation, paired admission, activation and rollback. The M07 adapter currently permits reason/check tasks and a local evidence-handoff comparison. Its admission is not a full GPU execution benchmark. H is frozen when a new M07 goal begins; later tasks inside that same goal do not hot-swap it. Workflow source/architecture candidate execution and demonstrated multi-generation improvement remain future work. See `docs/implementation/rsi.md`, `src/improvement/workflow-types.ts` and `test/workflow-evidence-handoff.test.ts`.

This publication also includes the final reconciliation fix described in `2026-10-13-reconcile-before-delegation.md`. Publishing the code does not reload the already running research process.
