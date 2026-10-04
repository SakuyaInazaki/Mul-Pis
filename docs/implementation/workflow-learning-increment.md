# Bounded workflow and learning increment

This change keeps M07 as the task and acceptance controller, M04 as the sole knowledge-adoption path, and the existing workflow improvement evaluator as a local mechanism experiment. It does not replace Mul-Pis with Humanize, KDA, or Compound Engineering.

## Task execution

An M07 execute task may opt in to `executionLoop: {maxRounds, deadlineAt}`. It uses one live builder handle for at most eight turns and creates a fresh read-only reviewer after each builder turn. The reviewer sees a bounded copy of that round's work directory and returns a structured `ready`, `revise`, `replan`, or `blocked` recommendation. Only `revise` can cause another builder turn in the same task. `ready` is not task acceptance: normal M07 review still checks the original obligations, frozen evidence, and any required independent check task. Changed or newly supplied task evidence after the ready snapshot, a non-ready stop, invalid reviewer reply, or expired deadline cannot be accepted. Builder turns have separate operation receipts; an issued turn with an uncertain response blocks further execution until the existing host reconciliation path resolves it. No execution session is resumed after process restart.

`planInput` must be one declared text input. `resourceInputs` bind at most twelve declared text inputs with explicit IDs and versions, for example a fixed upstream technical reference. They are copied into this task only; Pi's global skill, extension, and prompt-template discovery stays disabled. The controller compares the guide/resource copies after builder turns. This is an application-level consistency check, not an OS sandbox: the execution grant still includes bash under the host process permissions, so a hostile builder could temporarily alter and restore a file during one turn. Such a task must not be used as a protected-evaluation security boundary.

The resource ID and version are caller-supplied labels, not independently attested upstream identities. The loop is bounded by rounds and wall time, but it has no artifact-based no-progress detector; a fresh reviewer may ask for repeated repair until those bounds stop the task.

`lessonDeltaOutput` identifies an expected JSON task artifact. It allows `none`, `propose`, `amend`, or `contradict`; a non-none candidate needs an observation, applicability, and local evidence paths. The controller bounds the file, checks path confinement and evidence existence, and freezes it with the final review. It remains a candidate in the M07 checkpoint/feedback package for M04 to judge. A superseding task is the explicit place to bind a new guide or reference version after feedback; it retains the original task obligations and does not rewrite earlier round history. It cannot directly merge a knowledge record or revise the task plan. `none` is a legitimate result.

## Knowledge and limits

M04, M06, and M07 select bounded relevant knowledge rather than inserting every record until a fixed character cutoff. Required records, necessary premises, and linked negative warnings are checked as a group; live limits are checked again against the published snapshot. M07's general retrieval excludes method-experience records, which still require explicit pinned references through the existing ExperienceProvider. Relevance and loading do not establish faithful use, scientific truth, or causal benefit.

Workflow improvement's explicit Pi route and wall deadline controls are offline-engineering validated only. No real DeepSeek turn, CPU lab task, GPU benchmark, or end-to-end RSI gain was run in this change batch. Existing acceptance checks remain local mechanism checks rather than scientific-performance or general RSI claims.

## Mechanism attribution

- M07's same-builder/fresh-reviewer/plan-feedback shape was informed by [Humanize1 at `4ac8dd415cc1df16f71990bda7070e93af69287f`](https://github.com/humanfia/humanize1-flow/tree/4ac8dd415cc1df16f71990bda7070e93af69287f). The implementation here is new TypeScript code; no upstream source was copied.
- Explicit task-scoped references and obligation-first task contracts were informed by [KDA at `ef6ce617693ef0782b3ecb9f37e39bbf10226a90`](https://github.com/NVlabs/kda/tree/ef6ce617693ef0782b3ecb9f37e39bbf10226a90). No KDA runner, prompt text, KernelWiki data, or NCU helper was imported.
- Relevance-first selection was informed by [Compound Engineering's learning retrieval at `9af474a70e7f2a844338519ad9e92aafbd92d4fb`](https://github.com/EveryInc/compound-engineering-plugin/tree/9af474a70e7f2a844338519ad9e92aafbd92d4fb) and [KernelWiki's query tooling at `76d27b56f804e7e7295d4c570e1e5d7eef4b0a75`](https://github.com/mit-han-lab/KernelWiki/tree/76d27b56f804e7e7295d4c570e1e5d7eef4b0a75). The selector is original code operating on the existing C/K/E/J/Q/D/X store, without an embedding service or new authority database.
