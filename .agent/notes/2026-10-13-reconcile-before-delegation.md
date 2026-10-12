# Return confirmed reconciliation before a new execution delegation

This batch changes `src/pi/service.ts` and `test/pi-operation-reconcile.test.ts`. Before editing, exact copies of both files were saved under `.agent/private/2026-10-13-reconcile-before-publication/` with their repository-relative paths. The copies permit recovery of the pre-change source and test. No deletion was required.

The service previously reconciled an unknown external operation inside a new `execute` delegation and immediately dispatched that new task even when the host confirmed the earlier operation had occurred. The new control path returns a `HarnessError` containing the confirmed operation ID, old task ID, and frozen receipt path before creating another execution task. The caller can inspect those facts and make a fresh decision. A `not-issued` reconciliation still permits the pending delegation; an unresolved `unknown` remains blocked by the existing controller gate.

The regression test checks that confirmation creates no new task or execution session in that call, that a later explicit delegation can proceed, and that `not-issued` continues directly. This is a general external-operation recovery rule; it does not encode any experiment-specific objective or result.
