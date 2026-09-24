# M07 projection observations

Recorded the M07 task-message and feedback projection calls as private, ordered events with frozen policy identity, separate UTF-8 byte and UTF-16 code-unit counts, inline/defer decisions, and controller-owned material copies. Missing or unreadable copies are explicitly unsuitable for replay. Text is counted as a stream; only a potential inline prefix is retained in memory. Feedback generation and M04 prompt assembly have separate delivery states. M04 also records actual read-return ranges provided by the runner, while preserving the distinction between saved, returned, used, and independently verified evidence.

The goal freezes its method version at begin and passes it into new task sessions. No workflow source, third-party code, or research material was changed. The projection events contain private run material references and remain outside public release artifacts.

Added fixed per-material, per-call, and per-run snapshot disk limits; measurement copies that exceed them are explicitly unreplayable while the original task input remains available. M04 now persists returned ranges even when the research prompt later fails. Updated the existing implementation documents, entry README, project rules, and Git ignore patterns to match this batch without adding a separate handoff report.

Targeted verification: `node --test test/m07.test.ts` passed 27 tests. Final repository-wide verification belongs to integration after concurrent runner and improvement edits settle.

Final documentation clarifies historical hypothesis/parameter/failure-summary consumption, experiment-obligation deduplication, normal no-winner outcomes, the case-set schema entry and explicit export/bind flags. It separates campaign-controlled calls from child runner sidecars and the best-effort Pi main-session telemetry ledger; none is a complete project or provider invoice.

Final integration verification for that batch: local TypeScript 5.9.3 typecheck and `git diff --check` passed. The complete suite had 183 tests: 180 passed in the default sandbox; three dashboard server tests needed loopback listen permission and then passed 3/3 when rerun with that permission. No real model or network call was part of those tests.
