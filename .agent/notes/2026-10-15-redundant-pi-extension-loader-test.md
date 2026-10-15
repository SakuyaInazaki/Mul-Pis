# Pi extension loader test cleanup

Target for removal: the `Pi DefaultResourceLoader loads the inline extension without prompting or network` test in `test/pi-extension.test.ts`.

Reason: the adjacent `Pi DefaultResourceLoader loads the actual extensions/research.ts entrypoint` test uses the same loader reload and extension inspection path, checks the same zero-error, one-extension and nine-tool outcomes, and additionally loads the production entrypoint. The inline factory case supplies no distinct assertion. Other registration and routing tests remain.

Recoverability: the deleted test is tracked in Git and can be restored from its previous revision. No source code or other test is removed in this batch.

The final experience-forwarding test also repeated a basic execute call and its expectedOutputs assertion. The earlier `research_delegate passes approved plan, versioned resources, bounded loop, and lesson output to M07` test already checks that complete task forwarding through the same tool. Following renewed user authorization and the permission-mode change, remove only the duplicate call and its two assertions; retain the distinct pinned experience, context and tag forwarding assertions, and rename the test accordingly. These lines remain recoverable in Git. The earlier automatic review rejected this deletion before the permission-mode change; no alternate execution path was used.

Verification: `node --test --test-concurrency=1 test/pi-extension.test.ts` passed all 20 remaining tests when run with macOS process identity access. The ordinary sandbox run passed 17 and blocked three unrelated integration cases at `sysctl -n kern.boottime`; the elevated offline run resolved that environment restriction. `git diff --check` passed.

Additional approved cleanup targets:

- `test/manual-private-campaign.test.ts`: remove `production campaign forwards the live carry archive digest to its downloader`. It only matches a regular expression against `scripts/manual-private-campaign.ts` source; it never invokes the campaign or downloader and therefore never verified runtime forwarding. Other signed-ledger and campaign behavior tests remain.
- `test/manual-private-campaign.test.ts`: remove `both private original-objective assessor stages persist validation failures`. It only counts textual callback fragments in the same source file; it never executes either stage or observes persistence. Other diagnostic and assessor behavior tests remain.
- `test/pi-extension.test.ts`: remove only the assertion that `research_method_improve` prompt guidelines omit two fee-ceiling phrases. The enclosing A/A calibration test still invokes the tool and checks dispatch, signal forwarding, summarized pair outcomes and missing-plan rejection. The text assertion adds no behavioral coverage.

The A/A calibration test title was shortened to match its remaining route and no-search assertions.

All removed lines are tracked in Git and recoverable from the prior revision. No runtime source or other tests are removed.

After the expanded cleanup, `node --test --test-concurrency=1 test/pi-extension.test.ts test/manual-private-campaign.test.ts` passed all 95 remaining cases with macOS process identity access. Only the test title changed after that run; its body did not change.
`node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` and `git diff --check` also passed.

Further cleanup in this same change batch, recorded before deletion and now completed:

- In `test/pi-extension.test.ts`, remove the first registration test's nine-tool enumeration because the real `extensions/research.ts` loader test checks the identical list through Pi's actual resource loader. Keep command registration and inert workspace checks. Remove the A/A tool schema's `workflow-calibrate` text match because the next execute call and captured service call prove routing. Replace two exact Chinese progress-message assertions with one assertion that the actual progress callback fired; the M01 and M04 outcomes remain checked.
- In `test/manual-private-campaign.test.ts`, move the GitHub workflow's `timeout-minutes:` check into the existing workflow gate test, then remove the separate `new campaign has no host time, call-count, iteration or round quota` test. Its remaining assertions only scan script source for old names and one literal `until-ready` fragment; they do not execute quota handling. In the native-CNY profile test, remove two source-text `indexOf` ordering checks and their dedicated file read; keep the mocked provider calls and observed budget assertions.

These exact tests and assertions are Git tracked and recoverable. Across this note's changes, four whole tests were removed: the inline Pi loader case, two script-source regex cases, and the no-quota script-source regex case after its sole distinct GitHub workflow timeout check moved into the existing workflow gate test. Eight script-source assertions and four schema, prompt or progress-wording assertions were removed. One assertion that the real progress callback fired replaced the two exact progress-message checks. The duplicate registration tool list and duplicate expectedOutputs forwarding checks were also removed while their stronger checks remained.

The current user direction is to run one combined test pass after the wider change batch. The 95-case run and typecheck recorded above preceded this further cleanup; no tests or typecheck were run after it.
