# Accepted M07 review within the first mission step

An accepted M07 task previously returned `m04-review-pending` from the dispatching `mission.step` before starting its first M04 review. A completed review then needed another call before host selection. This changed the existing default mission step behavior for finite objectives and recovered accepted tasks.

The dispatch path still records the pending checkpoint before entering M04. It now advances that checkpoint within the same step. When the new M04 run completes, the host verifies its checkpoint inputs and source, reads the required evidence, and makes its normal selection decision in that call. A failed M04 run with a settled no-proposal transaction remains pending so a later call can reconcile and retry it. Abort and unresolved transaction errors remain visible to the caller with the pending checkpoint retained. Returned-task recovery follows the same continuation after committing its recovery checkpoint. Neither path reruns the assessor, M07 builder, or host evaluator.

Offline coverage checks the pending checkpoint at M04 provider entry, one-step finite selection, the failed-review hold, and returned-task recovery. This change does not alter the scientific criteria for M04 adoption or objective fulfillment.

The frozen starting revision `12d5e686499d04e8020ed964a0ae9876f99f02cb` completed its full offline Node suite with 1,507 passes, 21 failures, and no skips. The failures centered on the new accepted-task step timing: normal default mission steps stopped before first M04 and selection. Repair work also exposed a cached predecessor writer after V4 recovery and a V4 receipt that tried to pin the mutable live M07 goal indefinitely. The recovery path now retains a frozen historical goal, binds the later M04 transition to its exact completed run and read evidence, and verifies successor checkpoints after parsing the authenticated history.

The pending-merge fixture now locates the running M04 run by status. Choosing the first listed M04 ID was order dependent when a completed formal baseline already existed.

Verification on the isolated change: `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` passed. Direct offline Node execution of `test/local-mission-workflow.test.ts`, `test/local-mission-evaluator.test.ts`, and `test/local-mission-evaluator-recovery-integration.test.ts` passed 82 of 82 tests, with no failures or skips. The full repository suite remains to be rerun after integration with other concurrent changes.
