# Reviewed recovery after a failed local M04 judgment

## Cause

The existing interrupted local dispatch review accepted only one specific transport error with a before-send witness. A rejected M07 task with a formal evaluator receipt and a failed, no-proposal M04 judgment could remain held even after its ordinary lifecycle and scoped effects had been reviewed. A generic recovery must retain the negative scientific history and cannot infer a successful task or knowledge adoption from a returned transport call.

## Change

Added a separate V6 host review for an exactly committed MISSION-to-M07 lineage and one rejected task. It checks the old process identity and death, returned M07 operation, task and tool-result census, formal evaluator receipt, complete feedback checkpoint, failed M04 run and ordered session hashes, exact no-proposal transaction, absence of a pending merge, and a scoped effects declaration authenticated by trusted host code. The provider scope is inference only, without hosted jobs or tools; request completion and billing may remain unknown. That authentication runs before preparation and again under the exclusive successor commit lock. Unknown or changed mutating effects leave the original checkpoint held.

The existing atomic successor writer records the V6 review and one partial, unselected bounded run. The original objective stays incomplete. The old builder, evaluator, and M04 sessions are not replayed. Default mission continuation uses the retained negative feedback for a fresh assessment and may dispatch a distinct task. Earlier review receipt versions and their historical bytes remain unchanged. Prior reviewed running dispatches are recognized through their version-specific host evidence, including pinned V2 stage bytes and the existing V3/V5 host validators.

## Verification

Offline TypeScript typecheck and 87 focused local reconciliation tests passed. An earlier related run of 139 tests passed with private file creation mode; full testing of the final combined source is separate. Synthetic coverage includes mixed formal check results, multiple M04 sessions, a transcript beyond the control-file byte bound, consecutive reviewed dispatches after V2, V3, V5, and V6 predecessors, subsequent unrelated records, fresh default mission assessment and distinct dispatch, malformed or changed evidence, a live old owner, a pending merge, both atomic crash windows, idempotent retry, and concurrent claimants. No real mission, model, network request, or publication was run.

## Limits

The effects declaration is not self-authenticating. A trusted same-host reviewer must independently establish the scoped tool, child-process, background-work, provider mode, and knowledge-write disposition. A missing or uncertain mutating-effect observation blocks V6 recovery. Inference-only requests may leave fee and response accounting unknown; the historical M04 transcript hash alone does not prove their settlement. The review records a safe fresh-work boundary, not scientific acceptance, complete OS isolation, or a proof about unrelated future work. The public API requires a host authentication callback; no CLI option accepts an unauthenticated declaration as recovery authority. Arbitrary shell operations without trusted process observations remain held.
