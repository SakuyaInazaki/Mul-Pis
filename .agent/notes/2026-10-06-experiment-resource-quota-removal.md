# Experiment resource quota removal

Date: 2026-10-06

## Authorized change

The user requested removal of workflow time and count limits while retaining file-size safeguards. This change removes aggregate campaign token, provider-call, probe-call, CPU-duration, and elapsed-wall-time enforcement from the experiment ledger. It retains explicit monetary ceilings and fail-closed usage settlement.

## Implementation

- BudgetLimits accepts historical time/count/token fields as optional legacy metadata. Active BudgetStatus limits and remaining fields expose only SDK-estimated monetary cost.
- Provider/input/output/probe/CPU usage continues to be observed at root and descendant leases. Input reservation estimates do not cap usage. Provider-call accounting uses reported events when a prompt contains multiple calls; incomplete records retain observed finite fields and block further paid requests.
- Tool-using turn reservations contain only reservation and lease identities; there is no reserved token or call envelope.
- Phase preflight allocates and checks monetary ceilings only. It no longer derives protected call ceilings or imposes fixed replicate/case/probe upper-count limits.
- CPU branch lifecycle and pause/close semantics remain. They cannot expire because elapsed time passed.
- The CPU environment retains caller-selected per-case measurement allowances and the finite hypothesis-domain schema used by its controller. Its physical action-record byte bound, identity validation, finite coordinates, and persistence/in-flight checks remain.
- Removed redundant explanation/reason character limits, the fixed exported executor episode action limit, and synthetic workflow timeout health checks. Historical timeout status types remain readable.

## Offline verification

- Experiment local-environment and review-regression tests pass (22 tests total).
- Tests exercise zero-valued legacy ceilings, unrestricted observed calls/tokens/CPU totals, cost-only live status, retained per-case probe exhaustion, file-byte rejection, unknown-usage blocking, phase monetary overflow, and dormant/closed branch lifecycle.
- Typechecking initially found callers still using removed resource remaining fields in other concurrently edited modules; these were reported to the coordinating implementation task.
- No models, network requests, paid calls, private evidence publication, commits, or pushes were performed.
