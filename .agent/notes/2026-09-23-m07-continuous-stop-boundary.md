# M07 continuous stop boundary

The explicit Pi continuation host now freezes a `continuous` execution contract as a controller-side begin option. It is not read from model-supplied goal parameters. Legacy/bounded goals keep their previous partial/M04 behavior.

For a continuous goal, `finish(partial|blocked)` and ordinary `interrupt` fail even if model text, limitations, task stdout, or a self-written JSON file says `dependency_unavailable`, `resource_exhausted`, or `user_stopped`. A separate service `hostInterrupt` call can close the goal on an observed host lifecycle event. The controller generates a run-bound stop receipt with a limited reason kind (`request-aborted`, `provider-error`, `session-shutdown`, `no-progress`) and a local identifier; it does not accept a model receipt. Request abort is not called an explicit user stop. A negative scientific/task result and an individual tool failure do not mint a goal-wide dependency witness.

The current `ToolCallRecord.ok` tracks whether a wrapper threw; it does not by itself prove a Bash/custom tool's semantic outcome or an unavailable external dependency. No platform/permission/resource hard-stop adapter has been registered in this batch. Thus no model-proposed `dependency_unavailable` path is accepted for continuous goals.

Validation: `npm run typecheck` passed; `node --test test/m07.test.ts test/pi-lifecycle.test.ts` passed 35/35. No live model, network, historical run mutation, or platform submission was performed.

The separate nonterminal checkpoint and exact M04 source-binding implementation is recorded in `2026-09-23-m07-nonterminal-checkpoint.md`. This stop-boundary patch alone is not a science feedback loop.
