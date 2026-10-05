# Private workflow evidence archive

## Change

- Preserve bounded per-round candidate source and host verification summaries in the private return, with structured reviewer feedback and explicit missing or invalid states.
- Exclude raw builder and reviewer reports, session transcripts, process arguments, stdout and stderr, and credential-like content from the archive. Preserve strictly validated eight-row original-baseline and candidate independent timings and numeric host comparisons so the selected measurement remains inspectable.
- Export all actual published records sourced to the M04 run, including candidate and negative outcomes, plus targets of limits published in the same snapshot, their required pinned and relation dependencies, store limit history, and the published snapshot into a fixed bounded private file. If any required content is unavailable, unsafe, cyclic, or over budget, mark the export incomplete. Live-usable adopted M07 executor experience references with satisfied dependencies may be considered for explicit follow-on selection; the authoritative provider checks required tags and context at selection time.
- Keep the external archive untrusted for automatic adoption or execution. Any later restore requires an explicit provenance and live-limit check.

## Verification

Synthetic offline tests cover multi-round evidence, bounded trusted measurements, malformed measurement rejection, private-data exclusion, valid adopted experience with a dependency, candidate and negative M04 outcomes, limit-only M04 outcomes, and incomplete-export behavior. Type checking passes. No real model or network call is part of these tests.

The existing manual private campaign entrypoint now uses the original staged three-file input at runtime, keeps one 21 CNY / 32-provider-call campaign guard, runs the bounded M07 builder and fresh reviewer, performs a host-owned independent finite/mutation/timing check in isolated compilation/execution, calls the existing M04 adjudicator, and attempts one fresh M07 continuation with explicit prior artifact inputs. Only live, applicable, evidence-read M04 adopted references are pinned for trusted experience selection; no-adoption continuation uses prior artifacts only. The encrypted status distinguishes first-goal, M04, follow-on, knowledge export, selected candidate, loaded experience, and measured comparison. The canonical candidate is promoted only from an accepted, independently checked goal; rejected/worse follow-on work remains separately indexed. Prefixed flat manifests are display indexes, not default archive-loader inputs. The private transport allowlist contains only these bounded outputs.

Offline checks: full `npm test` 384/384; `npm run typecheck`; transport tests 7/7. A private local baseline smoke on the exact staged original input contract derived nine supported runtime cases, detected the two target functions, and compiled/ran the independent checker successfully. These checks do not imply a new provider campaign was run or that any particular optimized candidate passed this new workflow.
