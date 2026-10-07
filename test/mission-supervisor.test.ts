import assert from "node:assert/strict";
import test from "node:test";
import { classifyPendingAction, type PendingActionV1 } from "../src/m07/objective-progress.ts";
import { dispatchPlannedResume, pendingActionIdentity, planMissionContinuation,
	type FreshIndependentWorkEvidenceV1, type MissionStatusV1,
	type SupervisorSnapshot } from "../src/runner/mission-supervisor.ts";
import type { VerifiedWorkflowRepairPlanV1 } from "../src/runner/mission-host-adapter.ts";

const tuple = "a".repeat(64);
const source = { runId: "7002", runAttempt: 1, commit: "b".repeat(40) };
const freshFor = (action: PendingActionV1): FreshIndependentWorkEvidenceV1 => ({
	version: 1, kind: "host-verified-fresh-independent-work", source,
	envelopeSha256: "c".repeat(64), selectedTupleSha256: tuple,
	pendingActionSha256: pendingActionIdentity(action),
	isolatedWorkspace: true, emptyStore: true, noPriorSessionResume: true,
	confinedGrants: true, nextTaskDependency: "independent",
});

function snapshot(action: PendingActionV1 = classifyPendingAction("assessment-failed"),
	options: { unresolved?: string[]; fresh?: FreshIndependentWorkEvidenceV1;
		record?: SupervisorSnapshot["dispatchRecord"] } = {}): SupervisorSnapshot {
	const status: MissionStatusV1 = {
		version: 1, kind: "host-redacted-mission-status", contractId: "original-contract",
		objectiveOutcome: "incomplete", stopReason: action.reasonCode,
		selectedTupleSha256: tuple, unresolvedOperationRefs: options.unresolved ?? [],
		pendingAction: action,
	};
	return { status, pendingAction: action, dispatchRecord: options.record ?? { state: "not-requested" },
		terminalCarry: { version: 1, kind: "host-verified-terminal-carry", source,
			envelopeSha256: "c".repeat(64), contractId: status.contractId,
			selectedTupleSha256: tuple, pendingActionSha256: pendingActionIdentity(action),
			terminal: { runStatus: "completed", jobStatus: "completed", providerStepStatus: "completed" } },
		...(options.fresh ? { freshIndependentWork: options.fresh } : {}) };
}

test("transient provider error plans a fresh retry after authenticated terminal carry", () => {
	const action = classifyPendingAction("dispatch-failed", { transportFailure: true });
	const result = planMissionContinuation(snapshot(action));
	assert.equal(result.kind, "dispatch");
	if (result.kind !== "dispatch") return;
	assert.equal(result.intent.actionKind, "retry-transport");
	assert.equal(result.intent.boundary, "new-isolated-workspace-no-prior-session-resume");
	assert.deepEqual(result.intent.quarantinedOperationRefs, []);
});

test("workflow repair requires a live host brand rather than a serialized assertion", () => {
	const action = classifyPendingAction("workflow-repair-needed", {
		failedStage: "m04-judgment", evidenceRefs: ["repair-state.json"] });
	const repair = snapshot(action);
	assert.deepEqual(planMissionContinuation(repair),
		{ kind: "wait", reason: "workflow-repair-plan-required" });
	assert.throws(() => planMissionContinuation({ ...repair,
		workflowRepairPlan: { version: 1, kind: "host-reviewed-workflow-repair-plan" } as VerifiedWorkflowRepairPlanV1 }),
		/not host verified/);
});

test("an unsettled accounting chain cannot fund another run through fresh-work evidence", () => {
	const action = classifyPendingAction("accounting-integrity-error");
	assert.deepEqual(planMissionContinuation(snapshot(action, { fresh: freshFor(action) })),
		{ kind: "wait", reason: "accounting-chain-needs-reconciliation" });
});

test("a model blocked verdict does not become a human gate", () => {
	const action = classifyPendingAction("model-reported-blocked");
	assert.equal(action.humanRequired, undefined);
	assert.equal(planMissionContinuation(snapshot(action)).kind, "dispatch");
});

test("missing terminal carry and missing host pending action cannot dispatch", () => {
	const ordinary = snapshot();
	assert.deepEqual(planMissionContinuation({ ...ordinary, terminalCarry: undefined }),
		{ kind: "wait", reason: "terminal-carry-unverified" });
	const noAction = { ...ordinary, pendingAction: undefined,
		status: { ...ordinary.status, pendingAction: undefined } };
	assert.deepEqual(planMissionContinuation(noAction),
		{ kind: "restore-evidence", evidenceRefs: [] });
});

test("unavailable evidence requests automatic restoration without asking a human", () => {
	const action = classifyPendingAction("assessment-evidence-suspended", {
		evidenceRefs: ["selected-verification.json"] });
	assert.deepEqual(planMissionContinuation(snapshot(action)),
		{ kind: "restore-evidence", evidenceRefs: ["selected-verification.json"] });
});

test("a real exclusive credential blocker needs verified host evidence", () => {
	const blocker = { kind: "credential-unavailable" as const, verifiedBy: "host" as const,
		evidenceRef: "credential-check", exclusiveRequiredAction: true as const };
	const action = classifyPendingAction("assessment-failed", { verifiedHumanBlocker: blocker });
	assert.deepEqual(planMissionContinuation(snapshot(action)),
		{ kind: "exclusive-external-input", blocker });
	const unverified = { ...action, verifiedHumanBlocker: undefined } as PendingActionV1;
	assert.throws(() => pendingActionIdentity(unverified), /inconsistent|does not match/);
});

test("unknown M07 operation permits independent fresh work and carries the quarantine", () => {
	const old = ["old-goal/O001", "older-goal/O002"];
	const action = classifyPendingAction("bounded-run-incomplete", { unresolvedOperationRefs: old });
	const result = planMissionContinuation(snapshot(action, { unresolved: old, fresh: freshFor(action) }));
	assert.equal(result.kind, "dispatch");
	if (result.kind !== "dispatch") return;
	assert.deepEqual(result.intent.quarantinedOperationRefs, old);
	assert.equal(result.intent.actionKind, "reconcile-m07-operation");
});

test("unknown M07 operation cannot replay a dependent task or use an unverified workspace", () => {
	const old = ["old-goal/O001"];
	const action = classifyPendingAction("bounded-run-incomplete", { unresolvedOperationRefs: old });
	const fresh = freshFor(action);
	assert.deepEqual(planMissionContinuation(snapshot(action, { unresolved: old })),
		{ kind: "wait", reason: "quarantined-operation-needs-reconciliation" });
	for (const bad of [
		{ ...fresh, nextTaskDependency: "dependent" as const },
		{ ...fresh, nextTaskDependency: "unknown" as const },
		{ ...fresh, isolatedWorkspace: false as true },
		{ ...fresh, confinedGrants: false as true },
		{ ...fresh, selectedTupleSha256: "d".repeat(64) },
	]) assert.deepEqual(planMissionContinuation(snapshot(action, { unresolved: old, fresh: bad })),
		{ kind: "wait", reason: "quarantined-operation-needs-reconciliation" });
});

test("a forged fresh action cannot erase UNKNOWN M07 operation refs", () => {
	const action = classifyPendingAction("bounded-run-incomplete");
	assert.throws(() => planMissionContinuation(snapshot(action,
		{ unresolved: ["old-goal/O001"], fresh: freshFor(action) })), /missing from quarantine/);
});

test("an action cannot invent unknown operation references absent from the authenticated status", () => {
	const action = classifyPendingAction("bounded-run-incomplete", {
		unresolvedOperationRefs: ["phantom-goal/O001"] });
	assert.throws(() => planMissionContinuation(snapshot(action, { fresh: freshFor(action) })),
		/missing from quarantine/);
});

test("cancellation requires verified origin and never launches from an inferred actor", () => {
	const ordinary = snapshot();
	const cancelled = { ...ordinary, pendingAction: undefined,
		status: { ...ordinary.status, stopReason: "cancelled" as const,
			pendingAction: undefined },
		terminalCarry: { ...ordinary.terminalCarry!, pendingActionSha256: null } };
	assert.deepEqual(planMissionContinuation(cancelled),
		{ kind: "wait", reason: "cancellation-origin-unverified" });
	const event = { version: 1 as const, kind: "host-verified-cancellation-origin" as const,
		source, envelopeSha256: "c".repeat(64), evidenceRef: "host-action-event",
		origin: "explicit-user-request" as const };
	assert.deepEqual(planMissionContinuation({ ...cancelled, cancellationEvent: event }),
		{ kind: "wait", reason: "user-cancelled" });
	assert.deepEqual(planMissionContinuation({ ...cancelled,
		cancellationEvent: { ...event, origin: "platform-interruption" } }),
		{ kind: "wait", reason: "execution-interrupted" });
	assert.throws(() => planMissionContinuation({ ...cancelled,
		cancellationEvent: { ...event, envelopeSha256: "d".repeat(64) } }), /does not bind/);
});

test("a terminal run cannot dispatch a same-session read repair into a fresh process", () => {
	const action = classifyPendingAction("assessment-evidence-unread", { liveReadOnlySession: true });
	assert.equal(action.safety, "same-session-read-only");
	assert.deepEqual(planMissionContinuation(snapshot(action)),
		{ kind: "wait", reason: "terminal-action-needs-reclassification" });
});

test("fulfilled status waits for an uncertain prior dispatch before reporting completion", () => {
	const ordinary = snapshot();
	const completed = { ...ordinary, pendingAction: undefined,
		status: { ...ordinary.status, objectiveOutcome: "fulfilled" as const,
			stopReason: null, pendingAction: undefined },
		terminalCarry: { ...ordinary.terminalCarry!, pendingActionSha256: null } };
	assert.deepEqual(planMissionContinuation(completed),
		{ kind: "complete", contractId: "original-contract" });
	for (const state of ["reserved", "delivery-unknown"] as const) {
		const key = "e".repeat(64);
		assert.deepEqual(planMissionContinuation({ ...completed,
			dispatchRecord: { state, idempotencyKey: key } }),
			{ kind: "wait", reason: state === "reserved" ? "dispatch-reserved" :
				"dispatch-delivery-unknown", idempotencyKey: key });
	}
	assert.deepEqual(planMissionContinuation({ ...completed,
		dispatchRecord: { state: "acknowledged", idempotencyKey: "e".repeat(64),
			successorRunId: "8003" } }),
		{ kind: "wait", reason: "successor-request-accepted", idempotencyKey: "e".repeat(64),
			successorRunId: "8003" });
});

test("unknown M04 transaction permits only isolated new work", () => {
	const action = classifyPendingAction("m04-transaction-unresolved", { m04TransactionUnresolved: true });
	assert.deepEqual(planMissionContinuation(snapshot(action)),
		{ kind: "wait", reason: "quarantined-operation-needs-reconciliation" });
	const result = planMissionContinuation(snapshot(action, { fresh: freshFor(action) }));
	assert.equal(result.kind, "dispatch");
	if (result.kind === "dispatch") {
		assert.equal(result.intent.m04TransactionQuarantined, true);
		assert.deepEqual(result.intent.quarantinedOperationRefs, []);
	}
});

test("the same action cannot be dispatched twice after durable acknowledgment", () => {
	const first = planMissionContinuation(snapshot());
	assert.equal(first.kind, "dispatch");
	if (first.kind !== "dispatch") return;
	const again = planMissionContinuation(snapshot(undefined, { record: {
		state: "acknowledged", idempotencyKey: first.intent.idempotencyKey,
		successorRunId: "8003" } }));
	assert.deepEqual(again, { kind: "wait", reason: "successor-request-accepted",
		idempotencyKey: first.intent.idempotencyKey, successorRunId: "8003" });
	assert.throws(() => planMissionContinuation(snapshot(undefined, { record: {
		state: "acknowledged", idempotencyKey: first.intent.idempotencyKey,
		successorRunId: "forged" } })), /record identity/);
});

test("action identity is stable across JSON key order", () => {
	const first = classifyPendingAction("dispatch-failed", { transportFailure: true,
		evidenceRefs: ["receipt-a"] });
	const reordered = { evidenceRefs: ["receipt-a"], reasonCode: first.reasonCode,
		kind: first.kind, author: first.author, version: first.version, safety: first.safety,
		transportFailure: true as const };
	assert.equal(pendingActionIdentity(first), pendingActionIdentity(reordered));
});

test("crash after reservation or uncertain trigger delivery never resends blindly", async () => {
	const first = planMissionContinuation(snapshot());
	assert.equal(first.kind, "dispatch");
	if (first.kind !== "dispatch") return;
	let called = 0;
	const reserved = await dispatchPlannedResume(first, async () => snapshot(undefined, {
		record: { state: "reserved", idempotencyKey: first.intent.idempotencyKey } }),
		async () => { called++; throw Error("should not call"); });
	assert.equal(called, 0);
	assert.equal(reserved.kind, "wait");
	const unknown = await dispatchPlannedResume(first, async () => snapshot(), async () => {
		called++; throw Error("connection lost after request");
	});
	assert.deepEqual(unknown, { kind: "wait", reason: "dispatch-delivery-unknown",
		idempotencyKey: first.intent.idempotencyKey });
	assert.equal(called, 1);
	assert.deepEqual(planMissionContinuation(snapshot(undefined, { record: {
		state: "delivery-unknown", idempotencyKey: first.intent.idempotencyKey } })), unknown);
});

test("a verified trigger acknowledgment carries the durable action identity", async () => {
	const planned = planMissionContinuation(snapshot());
	assert.equal(planned.kind, "dispatch");
	if (planned.kind !== "dispatch") return;
	let invoked = 0;
	const result = await dispatchPlannedResume(planned, async () => snapshot(), async intent => {
		invoked++;
		assert.equal(intent.idempotencyKey, planned.intent.idempotencyKey);
		return { state: "acknowledged", idempotencyKey: intent.idempotencyKey,
			successorRunId: "8003" };
	});
	assert.equal(invoked, 1);
	assert.deepEqual(result, { kind: "wait", reason: "successor-request-accepted",
		idempotencyKey: planned.intent.idempotencyKey, successorRunId: "8003" });
});

test("the trigger rechecks exact pending action and terminal source before dispatch", async () => {
	const first = planMissionContinuation(snapshot());
	assert.equal(first.kind, "dispatch");
	if (first.kind !== "dispatch") return;
	let called = 0;
	await assert.rejects(dispatchPlannedResume(first, async () => snapshot(
		classifyPendingAction("model-reported-blocked")), async () => {
		called++; return { state: "acknowledged", idempotencyKey: first.intent.idempotencyKey,
			successorRunId: "8003" };
	}), /changed before dispatch/);
	assert.equal(called, 0);
	const tampered = snapshot();
	assert.throws(() => planMissionContinuation({ ...tampered, terminalCarry: {
		...tampered.terminalCarry!, envelopeSha256: "bad" } }), /does not bind/);
});
