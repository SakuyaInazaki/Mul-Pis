# Search state: event log, candidate relations, warm start

M07 control state is written as whole files that each save overwrites. That is enough to resume a goal, but
not enough to answer what the search did: a crash loses a round of structure rather than the last write,
nothing can be reconstructed independently of the writer, and two processes writing at once rely on their own
locks rather than on the shape of the data.

`src/m07/search-state/` adds the other half: an append-only log, the state it rebuilds, and a cross-run query
over the goals that already finished.

## The log

Every participant appends single JSON lines to `stages/M07/<runId>/search-events.jsonl` and never rewrites
them. There is no global sequence and no lock on the shared file: each writer stamps its own monotonic
sequence, and readers sort by `(timestamp, writer, sequence)`, which is a total order that two processes can
produce independently. A line is bounded (8 KiB) so one event is always one write; fields are clipped
individually and the whole line is trimmed as a backstop.

Event kinds: `task-started`, `task-finished`, `candidate-submitted`, `candidate-stage`, `candidate-evaluated`,
`verdict`, `stall`, `budget`, `background-queued`, `background-settled`, `context-compacted`,
`episode-restarted`, `warm-start`. An event may carry:

- `round` — budget and stall counters are expressed in rounds. A token or wall-clock figure stops being
  comparable the moment the model or the machine changes.
- `candidate` — `{ id, parentId, subjectId, score, isBuggy, pathRef, stage, status }`. This is the relation
  table: `pathRef` points at the durable journal or observation, so the log stays small and the evidence stays
  where it was written.
- `verdict` — the host's deterministic decision (`accept` / `keep` / `reject` / `revert`).
- `platform` — chip and toolchain, because a measurement only means something on the machine that produced it.

Reading is tolerant by contract: a crash-truncated final line, or a line of a foreign shape, is counted in
`skipped` and never guessed at.

## The state

`rebuildSearchState(runId, events)` folds the ordered events into candidates, tasks, counters, rounds, stalls
and the platforms seen. It is pure, so the same log always produces the same state: a console can redraw the
whole tree, a restarted process can continue from the log alone, and an audit can be repeated without the
writer being present. Events belonging to another run in the same file are ignored rather than merged.

Queries on top of it: `candidateAncestors`, `candidateSiblings`, `candidateChildren`, `bestCandidates` and
`searchStateSummary`. Only candidates that carry a host-decided score are ranked — an unscored candidate is
unknown, not average — and candidates the host marked buggy are excluded unless asked for.

## Warm start across runs

`collectWarmStartLeads({ m07Dir, subjectId, platform, … })` scans recent run directories, reads each
`goal.json`, and uses the existing archive functions to find the best verified candidate per work object and
metric. It returns leads: the candidate reference, the metric that made it best, and the exact paths to its
frozen observation, sources and work directory.

Three rules keep a lead from becoming a false result:

- A lead from another chip or toolchain, or from a run that never recorded its platform, is marked
  `comparable: false` and dropped unless `includeIncomparable` is set. `describeWarmStartLeads` spells this
  out in the text the model reads.
- The scan is bounded (25 runs, 8 leads by default) and ordered newest-first, so a warm start cannot become a
  new source of latency.
- An unreadable or foreign run directory is counted in `skippedRuns`, never fatal.

The main session reaches this through `research_status` with `priorRuns`, which is the point where a planner
decides what the next task should start from.

## Background candidate runs

`candidate_run` (which also runs a declared parameter sweep) accepts `background: true` and `collect: true` when the host enables
them (`backgroundRuns` in `createCandidateExecutionTools`). A background submission returns at once, so the
model keeps working while the host executes; the host still runs candidates one at a time, so no backend
gains concurrency it was not written for. `collect` reports the job and returns its result once finished, and
after a restart it falls back to reading the durable journal — collecting never starts anything.

Because a background run outlives the tool call that started it, the host receives a drain function and awaits
it before the prompt can stop. Without that, the controller would be reasoning about operations nobody is
waiting for.

Queue and settle events go into the same log, so `searchStateSummary(...).background.outstanding` answers
"did anything stay unfinished" after a crash.

## The host evaluation pool

Generation happens in the model session and evaluation happens in the host, so the two are joined by a
bounded queue (`src/m07/evaluation-queue.ts`) rather than by one pipeline. Concurrency defaults to one,
because a device measured by two processes at once produces numbers that cannot be compared; raising it is a
fidelity decision for whoever knows the machine. Capacity defaults to eight, and a full queue refuses the
submission instead of growing — that refusal is the backpressure signal, delivered at submission time so a
caller that will not wait can do something else.

The queue reports what the backlog looks like: accepted, refused, completed and failed counts, how many are
running and waiting, the deepest the queue has been (the compile backlog in one number) and how long
submissions waited. Background submissions and the collect listing carry those statistics.

## Tool-call accounting

`summarizeToolCalls` (exposed as `SessionHandle.toolUsage()`) reports per-tool call counts, failure counts by
class, and how many file changes reached an evaluation before the next change. A run that edits for a long
time without measuring is not searching, and that is otherwise invisible in a transcript.

## Orchestration arm

`PRE_RSI_EXPERIMENT_ARM` selects `multi-role` (default) or `single-agent`, and the value is recorded in each
session's harness receipt. This module only resolves and records the choice; what a control arm does
differently belongs to the search layer that owns the loop.
