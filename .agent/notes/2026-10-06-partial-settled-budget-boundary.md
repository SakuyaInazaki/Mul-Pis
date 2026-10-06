# Partial-settled campaign stop and checkpoint identity

A bounded execution can receive and settle one or more provider responses, then have a later request in the same Pi tool loop refused locally by the campaign ceiling before transport. The model task has not returned a completed report, but calling the whole operation not-issued would erase the earlier effects, while classifying those settled effects as unknown would contradict the host's request ledger.

The runner now certifies this narrow local-stop case only when earlier requests in that same prompt have settled and the rejected request never reached transport. M07 records an incomplete failed task with a distinct partial-settled operation state and controller-owned receipt. Other prompt failures, aborts, and uncertain transport remain unknown. The private archive retains the receipt's bounded status and count without adopting a candidate or claiming task completion.

Continuation checkpoints now use qualified goal/operation references once. A legacy checkpoint containing both a bare ID and its uniquely evidenced qualified counterpart can be read through a narrow compatibility view while preserving the authenticated original bytes and all genuine unknown operations. Missing or ambiguous unknowns fail closed.

Offline tests cover the local-stop evidence, archive, and checkpoint normalization. This change neither raises the mission spending ceiling nor releases an existing unknown provider reservation.
