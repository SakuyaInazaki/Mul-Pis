# Workflow method campaign deadline and Pi route

## Changes

- The explicit M07 evidence-handoff campaign now caps each M07/M04 prompt at the smaller of its per-prompt timeout and remaining campaign wall time. The shared bounded I request also recomputes remaining wall time at the provider boundary, after setup and reservation. A hanging prompt requests an abort and leaves its provider usage ineligible for admission.
- Observed usage is checked against the wall clock after a turn returns, and the campaign rechecks wall time and necessary live references immediately before active-pointer promotion, including after writing the admitted method and bundle. An incomplete arm stops further paired-arm work.
- The Pi method-improvement tool has an explicit `workflow-run` action, separate from the CPU `run` action. It reads the caller's workflow plan and returns a bounded summary. The M07 delegation tool also exposes the optional approved-plan, explicitly versioned resource inputs, bounded execution-loop, and lesson-delta fields; the extension does not discover resources globally.
- An optional workflow I experience plan now selects only caller-pinned, applicable knowledge refs under explicit record and character caps. The selected nonempty pack is frozen across I decisions and rechecked for live availability before each new I request. A proposed H records consulted I refs and inherited necessary scientific refs. Omitted refs still mean no experience pack; this does not change the local handoff evaluator or imply general RSI.
- The campaign also freezes the local knowledge CURRENT snapshot and live limits, and rechecks them before each I request and immediately before active-pointer promotion, including when no experience refs were selected. A mid-campaign M04 merge therefore makes the run inconclusive rather than promoting against an old knowledge epoch.
- Offline regression cases cover a nonreturning arm, a final turn that exhausts wall time, a bounded I prompt with setup-time clock consumption, a fake-clock expiry between protected evaluation and active-pointer promotion, and Pi workflow action dispatch.

## Verification and limits

- Node syntax checks and `git diff --check` passed for the edited files. Focused offline tests passed (36/36) across the workflow budget, workflow evidence-handoff, and Pi extension suites. Workflow I experience tests cover frozen pack delivery, consulted refs, malformed plans, unavailable refs, a withdrawn ref before a second I request, and a no-ref local epoch change between decisions.
- `npm run typecheck` passed after the local project dependencies became available. No real model or network call was made by this change batch.
- The watchdog bounds controller acceptance and requests SDK abort; it cannot guarantee that an unresponsive remote provider physically stops immediately or that the SDK's internal tool turn stops at an exact provider-call count.
