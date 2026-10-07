import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { classifyPendingAction, type PendingActionV1 } from "../src/m07/objective-progress.ts";
import { dispatchPlannedResume, pendingActionIdentity, planMissionContinuation,
	type FreshIndependentWorkEvidenceV1, type MissionStatusV1,
	type SupervisorSnapshot } from "../src/runner/mission-supervisor.ts";
import type { VerifiedWorkflowRepairPlanV1 } from "../src/runner/mission-host-adapter.ts";
import { readReviewedInterruptedSourceCapability,
	type InterruptedSourceReviewReceiptV1 } from "../src/runner/interrupted-source-review.ts";

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

function interruptedSnapshot(priorReason: "bounded-run-incomplete" | "accounting-integrity-error" |
	"m04-transaction-unresolved" | "workflow-repair-needed" = "bounded-run-incomplete") {
	const refs = ["old-goal/O001"];
	const prior = classifyPendingAction(priorReason, { unresolvedOperationRefs: refs });
	const base = snapshot(prior, { unresolved: refs });
	const interruptedSource = { runId: "7003", runAttempt: 1, commit: "d".repeat(40) };
	const gap = { version: 1 as const, kind: "host-verified-terminal-interruption" as const,
		source: interruptedSource, priorCarrySource: source,
		priorCarryEnvelopeSha256: "c".repeat(64), resultArtifactId: "9103",
		resultArchiveSha256: "e".repeat(64), accounting: "unquantified" as const,
		effects: "unknown-unreconciled" as const, terminationOrigin: "unknown" as const };
	const action = classifyPendingAction("execution-interrupted", { unresolvedOperationRefs: refs });
	const currentInterruptionAction = { version: 1 as const,
		kind: "current-host-interruption-action" as const, source: interruptedSource,
		priorCarryEnvelopeSha256: gap.priorCarryEnvelopeSha256,
		priorCheckpointSha256: "f".repeat(64),
		resultArchiveSha256: gap.resultArchiveSha256, action };
	return { ...base, terminalCarry: { ...base.terminalCarry!, checkpointSha256: "f".repeat(64) },
		terminalInterruption: gap, currentInterruptionAction,
		freshLaunchContract: { version: 1 as const, kind: "verified-fresh-launch-contract" as const,
			source: interruptedSource, envelopeSha256: "c".repeat(64), selectedTupleSha256: tuple,
			pendingActionSha256: pendingActionIdentity(action), testedSourceCommit: "b".repeat(40),
			testedTree: "c".repeat(40), requiresRuntimeAttestationBeforeModel: true as const,
			mode: "fresh-work-only" as const } };
}

async function reviewedSource(t: TestContext, state: ReturnType<typeof interruptedSnapshot>,
	otherSource?: NonNullable<SupervisorSnapshot["terminalInterruption"]>["source"]) {
	const gap = { ...state.terminalInterruption!,
		...(otherSource ? { source: otherSource } : {}) };
	const sourceTree = "9".repeat(40);
	const roles = ["m07-local-tool-confinement", "read-only-model-sessions",
		"fresh-workspace-store", "host-execution-confinement",
		"encrypted-output-provider"] as const;
	const codeEvidenceRefs = roles.map((role, index) => ({ role,
		path: `src/review/role${index}.ts`, symbol: `codeSymbol${index}` }));
	const testEvidenceRefs = roles.map((role, index) => ({ role,
		path: `test/role${index}.test.ts`, name: `testName${index}` }));
	const receipt: InterruptedSourceReviewReceiptV1 = {
		version: 1, kind: "host-reviewed-interrupted-source-capability",
		prior: { source: gap.source, sourceTree, priorCarrySource: gap.priorCarrySource,
			priorCarryEnvelopeSha256: gap.priorCarryEnvelopeSha256,
			priorCheckpointSha256: state.terminalCarry!.checkpointSha256!,
			resultArtifactId: gap.resultArtifactId, resultArchiveSha256: gap.resultArchiveSha256 },
		review: { kind: "operator-code-review", conclusion: "approved-for-fresh-only-execution",
			codeEvidenceRefs, testEvidenceRefs },
		grant: { mode: "fresh-only-confined-effects", oldResultUse: "untrusted-no-replay-no-adoption",
			m07Tools: "factory-confined-local", modelSessions: "read-only",
			state: "fresh-workspace-empty-store-no-resume", outputTransport: "encrypted-fixed",
			providerInference: "fixed-configured-provider" }
	};
	const dir = await mkdtemp(path.join(os.tmpdir(), "supervisor-review-"));
	t.after(async () => rm(dir, { recursive: true, force: true }));
	const file = path.join(dir, "receipt.json");
	await writeFile(file, JSON.stringify(receipt), { mode: 0o600 });
	return readReviewedInterruptedSourceCapability({ privateReceiptFile: file,
		interruption: gap, interruptedSourceTree: sourceTree,
		priorCheckpointSha256: state.terminalCarry!.checkpointSha256!,
		readImmutableSourceFile: async (commit, filePath) => {
			assert.equal(commit, gap.source.commit);
			const code = codeEvidenceRefs.find(ref => ref.path === filePath);
			const test = testEvidenceRefs.find(ref => ref.path === filePath);
			return new TextEncoder().encode(code?.symbol ?? test?.name ?? "");
		} });
}

test("no-carry interruption gets a reviewed new action and an idempotent whole-run UNKNOWN quarantine", async t => {
	const unreviewed = interruptedSnapshot();
	assert.deepEqual(planMissionContinuation(unreviewed),
		{ kind: "wait", reason: "interruption-source-review-required" });
	const state = { ...unreviewed, interruptedSourceReview: await reviewedSource(t, unreviewed) };
	const decision = planMissionContinuation(state);
	assert.equal(decision.kind, "dispatch");
	if (decision.kind !== "dispatch") return;
	assert.equal(decision.intent.source.runId, "7003");
	assert.equal(decision.intent.actionKind, "reconcile-interrupted-run");
	assert.equal(decision.intent.pendingAction.reasonCode, "execution-interrupted");
	assert.equal(decision.intent.actionProvenance?.kind, "current-host-interruption");
	assert.equal(decision.intent.interruptedSourceReview?.source.commit,
			state.terminalInterruption!.source.commit);
	assert.equal(decision.intent.interruptedSourceReview?.receiptSha256,
			state.interruptedSourceReview.receiptSha256);
	assert.notEqual(state.interruptedSourceReview.source.commit,
			state.freshLaunchContract.testedSourceCommit);
	assert.equal(decision.intent.m04TransactionQuarantined, true);
	assert.deepEqual(decision.intent.quarantinedOperationRefs, ["old-goal/O001"]);
	assert.deepEqual(planMissionContinuation({ ...state, dispatchRecord: {
		state: "reserved", idempotencyKey: decision.intent.idempotencyKey } }),
		{ kind: "wait", reason: "dispatch-reserved", idempotencyKey: decision.intent.idempotencyKey });
	assert.deepEqual(planMissionContinuation({ ...state, freshLaunchContract: undefined }),
		{ kind: "wait", reason: "quarantined-operation-needs-reconciliation" });
	assert.throws(() => planMissionContinuation({ ...state,
		terminalInterruption: { ...state.terminalInterruption!, resultArchiveSha256: "0".repeat(64) } }),
		/lacks host provenance|changed the safety class/);
	assert.deepEqual(planMissionContinuation({ ...state, cancellationEvent: { version: 1,
		kind: "host-verified-cancellation-origin", source: state.terminalInterruption!.source,
		envelopeSha256: "c".repeat(64), evidenceRef: "verified-user-stop",
		origin: "explicit-user-request" } }), { kind: "wait", reason: "user-cancelled" });
});

test("an interruption review must retain its live brand, exact source and fixed grant", async t => {
	const base = interruptedSnapshot();
	const reviewed = await reviewedSource(t, base);
	assert.throws(() => planMissionContinuation({ ...base,
		interruptedSourceReview: structuredClone(reviewed) }), /not verified/);
	assert.throws(() => planMissionContinuation({ ...base,
		interruptedSourceReview: { ...reviewed } }), /not verified/);
	assert.throws(() => planMissionContinuation({ ...base,
		interruptedSourceReview: { ...reviewed, grant: { ...reviewed.grant,
			modelSessions: "read-only" } } }), /not verified/);
	const other = await reviewedSource(t, base, { ...base.terminalInterruption!.source,
		runId: "7004" });
	assert.throws(() => planMissionContinuation({ ...base, interruptedSourceReview: other }),
		/not verified for the terminal source/);
	assert.deepEqual(planMissionContinuation({ ...base, cancellationEvent: { version: 1,
		kind: "host-verified-cancellation-origin", source: base.terminalInterruption!.source,
		envelopeSha256: "c".repeat(64), evidenceRef: "verified-user-stop",
		origin: "explicit-user-request" } }), { kind: "wait", reason: "user-cancelled" });
});

test("an interruption does not erase earlier accounting, repair, or M04 blockers", async t => {
	assert.deepEqual(planMissionContinuation(interruptedSnapshot("accounting-integrity-error")),
		{ kind: "wait", reason: "accounting-chain-needs-reconciliation" });
	assert.deepEqual(planMissionContinuation(interruptedSnapshot("workflow-repair-needed")),
		{ kind: "wait", reason: "workflow-repair-plan-required" });
	const unreviewed = interruptedSnapshot("m04-transaction-unresolved");
	const state = { ...unreviewed, interruptedSourceReview: await reviewedSource(t, unreviewed) };
	const decision = planMissionContinuation(state);
	assert.equal(decision.kind, "dispatch");
	if (decision.kind === "dispatch") assert.equal(decision.intent.m04TransactionQuarantined, true);
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

test("inherited unknown operations cannot bypass a simultaneous workflow repair plan", () => {
	const unresolved = ["old-goal/O001"];
	const action = classifyPendingAction("workflow-repair-needed", {
		unresolvedOperationRefs: unresolved, failedStage: "objective-assessment",
		evidenceRefs: ["repair-state.json"] });
	assert.equal(action.kind, "reconcile-m07-operation");
	const state = snapshot(action, { unresolved, fresh: freshFor(action) });
	assert.deepEqual(planMissionContinuation(state),
		{ kind: "wait", reason: "workflow-repair-plan-required" });
	assert.throws(() => planMissionContinuation({ ...state,
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
