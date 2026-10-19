# Integration: describe background candidate runs and the experiment arm in AGENTS.md

## Why

W4's second round let `candidate_run` and `candidate_sweep` return before their execution finishes, but only when the host enables it. The host still executes one candidate at a time and drains every background run before the prompt stops.
The same round added the `PRE_RSI_EXPERIMENT_ARM` topology knob.
AGENTS.md still said that M07–M09 run synchronously and implement no detached jobs, which no longer described the code.

## Change

- Replaced that sentence. Background runs are now described as host-enabled and drained before the prompt ends, with still no jobs that outlive the prompt and no process-restart replay.
- Added one sentence after the harness receipt description: `PRE_RSI_EXPERIMENT_ARM` is a comparison knob, recorded per session, that changes no acceptance rule.

## Verification

Both statements were checked against `src/m07/candidate-runner.ts` (background registration, drain, refusal when not enabled) and `src/runner/experiment-arm.ts`. This is a documentation-only change.

## Follow-up after W4 round three

W4 then folded `candidate_sweep` into `candidate_run`, which runs a sweep when the call declares a parameter domain. The AGENTS.md sentence now names only `candidate_run`. No other tracked file outside the notes still uses the retired names `candidate_sweep`, `candidate_list`, `candidate_read` or `candidate_checkout`.
