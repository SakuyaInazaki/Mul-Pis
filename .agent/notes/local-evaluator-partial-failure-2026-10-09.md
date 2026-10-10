# Local evaluator interruption recovery

A model task can return before its trusted host evaluator finishes. An evaluator error or a crash while publishing its receipt previously left a mission dispatch intent with no bounded-run entry. A resumed mission held that intent without replaying the model task, but could not continue even when the evaluator's effects had settled.

This batch records an evaluator attempt before entry, its exact frozen inputs, its returned result, and its terminal host review in private, versioned files. A returned result can be finalized after restart without repeating the model or evaluator. A trusted evaluator may reconcile an opaque entered attempt using a bound operation and process proof; unresolved effects still hold. If a host write fails before the evaluator enters, an exact private orphan can become negative M07 feedback with no evaluator or M04 call. Ordinary M07 review and M04 read coverage remain required before any scientific selection.

Mission-wide recovery claims serialize a restarted owner through M04 and the reviewed successor checkpoint. The V4 checkpoint binds the old intent, M07 task and feedback, evaluator journal, owner chain, and any settled M04 evidence. Dead-owner takeover handles incomplete evaluator and checkpoint writes while preserving old bytes and rejecting live, foreign, or uncertain owners.

Offline tests cover returned-result recovery, partial observations, half-written pre-entry records, pending and settled child processes, two competing owner processes, a further dead recovery owner, and crashes before and after atomic successor publication. These tests exercise synthetic fixtures; they do not establish recovery of any private historical run or scientific correctness of a candidate.
