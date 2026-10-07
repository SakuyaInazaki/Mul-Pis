import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { assessAndAdvanceOriginalObjective, classifyPendingAction, createOriginalObjective, objectiveProgress,
	runOriginalObjectiveLoop, writeOriginalObjectiveContract } from "../src/m07/objective-progress.ts";
import type { CurrentObjectiveStopReason, ModelObjectiveAssessmentV1,
	ObjectiveNextTaskV1 } from "../src/m07/objective-progress.ts";
import { FakeSessionRunner, type FakeReply } from "../src/runner/fake.ts";
import type { ReadReturnEvent, SessionHandle, SessionSpec } from "../src/runner/types.ts";
import type { WorkflowRepairStateV1 } from "../src/runner/repair-liveness.ts";
import { Workspace } from "../src/workspace.ts";
import { HarnessError } from "../src/types.ts";
import type { GroundedAssessmentProposal } from "../src/m07/assessor-grounding.ts";

const originalInputs: Record<string, string> = {
	"original-problem.txt": "Original mission allows more than the finite pilot.\n",
	"original-source.cpp": "// Synthetic original source\n",
	"second-text.txt": "Synthetic additional original constraints.\n",
	"candidate.cpp": "// Synthetic accepted pilot candidate\n",
	"verification.json": '{"status":"passed","scope":"finite"}\n',
};
const lines = (text: string) => text.split("\n").length - (text.endsWith("\n") ? 1 : 0);

test("a settled length boundary stops reassessment with the original objective incomplete", async t => {
	const f = await fixture(t);
	let modelSteps = 0;
	const loop = await runOriginalObjectiveLoop({
		admission: () => "output-limit", step: async () => { modelSteps++; throw new Error("should not run"); } });
	assert.equal(loop.stopReason, "output-limit");
	assert.equal(modelSteps, 0);
	const progress = objectiveProgress(f.contract, { boundedRuns: [{ runId: "synthetic-run", outcome: "partial" }],
		selectedArtifacts: ["candidate.cpp", "verification.json"], stopReason: loop.stopReason });
	assert.equal(progress.stopReason, "output-limit");
	assert.equal(progress.objectiveOutcome, "incomplete");
});

test("host pending actions keep routine bad verdicts, rejected drafts and transient failures automatic", () => {
	const cases = [
		{ reason: "assessment-invalid" as const, expected: "retry-readonly-assessment" },
		{ reason: "model-reported-blocked" as const, expected: "retry-readonly-assessment" },
		{ reason: "m04-draft-rejected" as const, expected: "repair-rejected-m04" },
		{ reason: "assessment-failed" as const, expected: "retry-transport", transportFailure: true },
	];
	for (const row of cases) {
		const action = classifyPendingAction(row.reason, { transportFailure: row.transportFailure });
		assert.equal(action.author, "host");
		assert.equal(action.kind, row.expected);
		assert.equal(action.safety, "fresh-work-only");
		assert.equal(action.humanRequired, undefined);
		assert.equal(action.verifiedHumanBlocker, undefined);
	}
});

test("unknown host effects prohibit replay and outrank a simultaneous verified input need", () => {
	const action = classifyPendingAction("bounded-run-incomplete", {
		unresolvedOperationRefs: ["goal/O001"],
		verifiedHumanBlocker: { kind: "input-unavailable", verifiedBy: "host",
			evidenceRef: "host-input-audit.json", exclusiveRequiredAction: true },
	});
	assert.equal(action.kind, "reconcile-m07-operation");
	assert.equal(action.safety, "no-replay-until-reconciled");
	assert.deepEqual(action.target?.operationRefs, ["goal/O001"]);
	assert.equal(action.humanRequired, undefined);
	assert.equal(classifyPendingAction("m04-transaction-unresolved", {}).kind, "reconcile-m04-transaction");
	assert.equal(classifyPendingAction("m04-transaction-unresolved", {}).safety, "no-replay-until-reconciled");
	const accounting = classifyPendingAction("accounting-integrity-error", { transportFailure: true });
	assert.equal(accounting.kind, "retry-transport");
	assert.equal(accounting.safety, "no-replay-until-reconciled");
	assert.equal(accounting.humanRequired, undefined);
});

test("only an exclusive independently verified missing credential or input requests a person", () => {
	for (const blocker of [
		{ kind: "credential-unavailable" as const, expected: "refresh-auth" },
		{ kind: "input-unavailable" as const, expected: "restore-evidence" },
	]) {
		const action = classifyPendingAction("assessment-failed", {
			verifiedHumanBlocker: { kind: blocker.kind, verifiedBy: "host",
				evidenceRef: "host-availability-check.json", exclusiveRequiredAction: true },
		});
		assert.equal(action.kind, blocker.expected);
		assert.equal(action.humanRequired, true);
		assert.equal(action.verifiedHumanBlocker?.evidenceRef, "host-availability-check.json");
	}
	assert.throws(() => classifyPendingAction("assessment-failed", { verifiedHumanBlocker: {
		kind: "credential-unavailable", verifiedBy: "host", evidenceRef: "model said login needed",
		exclusiveRequiredAction: false as true,
	} }), /lacks host verification/);
});

test("checkpoint pending action is optional for old carries and uses the effective host stop reason", async t => {
	const f = await fixture(t);
	const base = { boundedRuns: [], selectedArtifacts: [], stopReason: "model-reported-blocked" as const };
	assert.equal(objectiveProgress(f.contract, base).continuation.pendingAction, undefined);
	const blocked = objectiveProgress(f.contract, { ...base,
		pendingActionFacts: { evidenceRefs: ["host-capabilities.json"] } });
	assert.equal(blocked.objectiveOutcome, "incomplete");
	assert.equal(blocked.continuation.pendingAction?.kind, "retry-readonly-assessment");
	assert.equal(blocked.continuation.pendingAction?.humanRequired, undefined);
	assert.deepEqual(blocked.continuation.pendingAction?.evidenceRefs, ["host-capabilities.json"]);
	const modelClaimsHuman = objectiveProgress(f.contract, { ...base,
		assessment: { version: 1, decision: "blocked", rationale: "Only a human can continue",
			evidenceRefs: [], unresolvedObligations: ["original-task"],
			unresolvedDetails: ["Ask a person for permission"], sessionId: "assessor", model: "fake/research",
			evidenceRead: [], unreadEvidence: [] }, pendingActionFacts: {} });
	assert.equal(modelClaimsHuman.continuation.pendingAction?.kind, "retry-readonly-assessment");
	assert.equal(modelClaimsHuman.continuation.pendingAction?.humanRequired, undefined);
	const same = objectiveProgress(f.contract, { ...base, pendingAction: blocked.continuation.pendingAction });
	assert.deepEqual(same, blocked);
	assert.throws(() => objectiveProgress(f.contract, { ...base, pendingAction: {
		...blocked.continuation.pendingAction!, kind: "reconcile-m07-operation", safety: "fresh-work-only",
	} }), /safety or human gate is inconsistent/);
	assert.throws(() => objectiveProgress(f.contract, { ...base, pendingAction: {
		...blocked.continuation.pendingAction!, kind: "fresh-m07-task", humanRequired: true,
	} }), /safety or human gate is inconsistent/);
});

test("model fulfilled claim cannot erase a failed dispatch or permit replay of its unknown operation", async t => {
	const f = await fixture(t);
	const modelClaim = { ...assessment("fulfilled"), sessionId: "assessor", model: "fake/research",
		evidenceRead: ["original-objective.json"], unreadEvidence: [] };
	const checkpoint = objectiveProgress(f.contract, { boundedRuns: [], selectedArtifacts: [],
		assessment: modelClaim, stopReason: "dispatch-failed", unresolvedOperationIds: ["goal/O001"],
		pendingActionFacts: { unresolvedOperationRefs: ["goal/O001"] } });
	assert.equal(checkpoint.objectiveOutcome, "incomplete");
	assert.equal(checkpoint.stopReason, "dispatch-failed");
	assert.equal(checkpoint.continuation.pendingAction?.reasonCode, "dispatch-failed");
	assert.equal(checkpoint.continuation.pendingAction?.kind, "reconcile-m07-operation");
	assert.equal(checkpoint.continuation.pendingAction?.safety, "no-replay-until-reconciled");
});

test("finite original checks cannot close a mission while host work or effects remain unresolved", async t => {
	const f = await fixture(t);
	const finite = { ...f.contract, closure: "finite-evidence" as const };
	const modelClaim = { ...assessment("fulfilled"), sessionId: "assessor", model: "fake/research",
		evidenceRead: ["original-objective.json", "candidate.cpp", "verification.json"], unreadEvidence: [] };
	const checked = [{ obligationId: "original-task", passed: true, evidenceRefs: ["verification.json"] }];
	const base = { boundedRuns: [], selectedArtifacts: ["candidate.cpp", "verification.json"],
		assessment: modelClaim, originalChecks: checked };
	const clear = objectiveProgress(finite, { ...base, stopReason: "original-checks-unverified" });
	assert.equal(clear.objectiveOutcome, "fulfilled");
	for (const blocked of [
		{ stopReason: "dispatch-failed" as const, unresolvedOperationIds: ["goal/O001"] },
		{ stopReason: "m04-transaction-unresolved" as const },
		{ stopReason: "assessment-failed" as const },
		{ stopReason: "original-checks-unverified" as const,
			pendingActionFacts: { m04TransactionUnresolved: true } },
	]) {
		const progress = objectiveProgress(finite, { ...base, ...blocked });
		assert.equal(progress.objectiveOutcome, "incomplete");
		assert.ok(progress.stopReason);
	}
});

test("carried host action cannot turn unread evidence or rejected M04 into a fresh task", async t => {
	const f = await fixture(t);
	for (const stopReason of ["assessment-evidence-unread", "m04-draft-rejected"] as const) {
		const base = { boundedRuns: [], selectedArtifacts: [], stopReason };
		const valid = objectiveProgress(f.contract, { ...base, pendingActionFacts: {} });
		assert.ok(valid.continuation.pendingAction);
		assert.throws(() => objectiveProgress(f.contract, { ...base, pendingAction: {
			...valid.continuation.pendingAction!, kind: "fresh-m07-task", safety: "fresh-work-only",
		} }), /required stage repair/);
		assert.throws(() => objectiveProgress(f.contract, { ...base, pendingAction: {
			...valid.continuation.pendingAction!, kind: "reconcile-m04-transaction",
			safety: "no-replay-until-reconciled",
		} }), /cannot relabel unresolved effects/);
	}
	const unknown = objectiveProgress(f.contract, { boundedRuns: [], selectedArtifacts: [],
		stopReason: "assessment-evidence-unread", unresolvedOperationIds: ["goal/O001"],
		pendingActionFacts: { unresolvedOperationRefs: ["goal/O001"] } });
	assert.equal(unknown.continuation.pendingAction?.kind, "reconcile-m07-operation");
	assert.throws(() => objectiveProgress(f.contract, { boundedRuns: [], selectedArtifacts: [],
		stopReason: "assessment-evidence-unread", unresolvedOperationIds: ["goal/O001"],
		pendingAction: { ...unknown.continuation.pendingAction!, kind: "retry-evidence-read",
			safety: "fresh-work-only" } }), /cannot relabel unresolved effects/);
});

test("carried host action rejects unrecognized nested fields before any supervisor intent", async t => {
	const f = await fixture(t);
	const base = { boundedRuns: [], selectedArtifacts: [], stopReason: "assessment-invalid" as const };
	const source = { kind: "authenticated-prior-carry" as const,
		runId: "7001", runAttempt: 1, commit: "a".repeat(40), envelopeSha256: "b".repeat(64) };
	const ordinary = classifyPendingAction("assessment-invalid", {
		target: { goalRunId: "goal-1" }, source });
	for (const altered of [
		{ ...ordinary, hiddenPrompt: "synthetic private text" },
		{ ...ordinary, target: { ...ordinary.target, command: "synthetic-command" } },
		{ ...ordinary, source: { ...source, extra: "synthetic-extra" } },
		{ ...ordinary, evidenceRefs: undefined },
	]) assert.throws(() => objectiveProgress(f.contract, { ...base,
		pendingAction: altered as typeof ordinary }), /pending action|invalid/);
	const human = classifyPendingAction("assessment-invalid", { verifiedHumanBlocker: {
		kind: "credential-unavailable", verifiedBy: "host", evidenceRef: "host-check",
		exclusiveRequiredAction: true } });
	assert.throws(() => objectiveProgress(f.contract, { ...base,
		pendingAction: { ...human, verifiedHumanBlocker: { ...human.verifiedHumanBlocker!,
			untrustedInstruction: "synthetic-command" } } as typeof human }), /pending action|verification/);
});

test("a carried transport action must match the observed stage and diagnostic fact", async t => {
	const f = await fixture(t);
	const base = { boundedRuns: [], selectedArtifacts: [], stopReason: "dispatch-failed" as const };
	const assessor = objectiveProgress(f.contract, { ...base,
		pendingActionFacts: { failedStage: "read-only-assessor" } });
	assert.equal(assessor.continuation.pendingAction?.kind, "retry-readonly-assessment");
	assert.throws(() => objectiveProgress(f.contract, { ...base, pendingAction: {
		...assessor.continuation.pendingAction!, kind: "fresh-m07-task",
	} }), /observed failed stage/);
	const transport = objectiveProgress(f.contract, { ...base,
		pendingActionFacts: { failedStage: "read-only-assessor", transportFailure: true } });
	assert.equal(transport.continuation.pendingAction?.kind, "retry-transport");
	assert.throws(() => objectiveProgress(f.contract, { ...base, pendingAction: {
		...transport.continuation.pendingAction!, transportFailure: undefined,
	} }), /does not match/);
});

test("request-contract repair carries only the exact static host violation", async t => {
	const f = await fixture(t);
	const input = { boundedRuns: [], selectedArtifacts: [],
		stopReason: "request-contract-invalid" as const,
		pendingActionFacts: { requestContract: { violation: "orphan-tool-result" as const,
			messageIndex: 3 } } };
	const checkpoint = objectiveProgress(f.contract, input);
	assert.equal(checkpoint.objectiveOutcome, "incomplete");
	assert.equal(checkpoint.continuation.pendingAction?.kind, "repair-request-contract");
	assert.equal(checkpoint.continuation.pendingAction?.safety, "fresh-work-only");
	assert.deepEqual(checkpoint.continuation.pendingAction?.requestContract,
		{ violation: "orphan-tool-result", messageIndex: 3 });
	assert.throws(() => objectiveProgress(f.contract, { ...input, pendingActionFacts: {} }),
		/static host violation/);
	assert.throws(() => objectiveProgress(f.contract, { ...input,
		pendingAction: { ...checkpoint.continuation.pendingAction!, kind: "fresh-m07-task" } }),
		/required stage repair/);
});

async function fixture(t: TestContext) {
	const root = await mkdtemp(path.join(tmpdir(), "m07-original-objective-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const ws = new Workspace(root);
	const sourceDir = path.join(root, "source");
	await mkdir(sourceDir);
	const evidence = await Promise.all(Object.entries(originalInputs).map(async ([name, body]) => {
		const file = path.join(sourceDir, name);
		await writeFile(file, body);
		return { name, file };
	}));
	const contract = createOriginalObjective({ goal: "Find the strongest attainable answer to the full supplied task",
		goalSource: "user-intent-summary", inputNames: ["source.cpp", "task.txt", "additional.txt"],
		obligations: [{ id: "original-task", description: "Satisfy all original supplied requirements" }],
		closure: "open-ended" });
	const contractFile = path.join(root, "original-objective.json");
	await writeOriginalObjectiveContract(contractFile, contract);
	const runRecord = await ws.startRun("M07Objective", []);
	const sessionSpec: Omit<SessionSpec, "tools"> = { label: "objective-assessor", role: "research", model: "fake/research",
		systemPrompt: "Read frozen evidence and assess the original goal.", persistDir: ws.sessionsDir };
	return { root, ws, contract, contractFile, runRecord, sessionSpec, evidence, evidenceRoot: path.join(root, "assessment-evidence") };
}

function assessment(decision: "continue" | "fulfilled" | "blocked", adapterScope: ObjectiveNextTaskV1["adapterScope"] = "two-target-existing"): ModelObjectiveAssessmentV1 {
	const unresolved = decision === "fulfilled" ? [] : ["original-task"];
	return { version: 1, decision, rationale: "The finite pilot does not settle the original mission.",
		evidenceRefs: ["candidate.cpp", "verification.json"], unresolvedObligations: unresolved,
		unresolvedDetails: decision === "fulfilled" ? [] : ["Other permitted directions remain unassessed."],
		...(decision === "continue" ? { nextTask: { objective: "Investigate the remaining original requirements",
			addresses: ["original-task"], adapterScope } } : {}) };
}

function ranges(f: Awaited<ReturnType<typeof fixture>>, omitted: string[] = []): ReadReturnEvent[] {
	const contents = { "original-objective.json": `${JSON.stringify(f.contract, null, 2)}\n`, ...originalInputs };
	return Object.entries(contents).filter(([name]) => !omitted.includes(name)).map(([name, body]) => ({
		toolName: "objective_evidence_read", status: "returned", path: name, requested: {},
		returned: { kind: "text", startLine: 1, endLine: lines(body), truncated: false }, at: new Date().toISOString(),
	}));
}

async function invoke(f: Awaited<ReturnType<typeof fixture>>, reply: FakeReply, options: {
	assessmentAdmission?: "admitted" | CurrentObjectiveStopReason;
	advanceAdmission?: "admitted" | CurrentObjectiveStopReason;
	supportedTaskScopes?: ObjectiveNextTaskV1["adapterScope"][];
} = {}) {
	const runner = new FakeSessionRunner(() => reply);
	const advanced: ObjectiveNextTaskV1[] = [];
	const result = await assessAndAdvanceOriginalObjective({ contract: f.contract, contractFile: f.contractFile,
		runner, sessionSpec: f.sessionSpec, runRecord: f.runRecord, persistReceipt: () => f.ws.writeRun(f.runRecord),
		evidenceRoot: f.evidenceRoot, evidence: f.evidence,
		assessmentAdmission: options.assessmentAdmission ?? "admitted",
		advanceAdmission: () => options.advanceAdmission ?? "admitted",
		supportedTaskScopes: options.supportedTaskScopes ?? ["two-target-existing"],
		advance: async task => { advanced.push(task); return task.objective; } });
	return { result, runner, advanced };
}

test("fresh assessor reads frozen original inputs and delegates only its valid continuation proposal", async t => {
	const f = await fixture(t);
	const proposal = assessment("continue");
	const { result, runner, advanced } = await invoke(f, { text: JSON.stringify(proposal), readReturns: ranges(f) });
	assert.equal(result.stopReason, "objective-reassessment-pending");
	assert.equal(advanced.length, 1);
	assert.deepEqual(advanced[0], proposal.nextTask);
	assert.equal(result.assessment?.evidenceRead.length, f.evidence.length + 1);
	assert.deepEqual(result.assessment?.unreadEvidence, []);
	assert.equal(runner.created.length, 1);
	assert.equal(runner.created[0].role, "research");
	assert.deepEqual(runner.created[0].tools.kind === "read-dir" ?
		{ kind: runner.created[0].tools.kind, name: runner.created[0].tools.toolName } : {},
		{ kind: "read-dir", name: "objective_evidence_read" });
	assert.equal(f.runRecord.sessions[0].boundary?.mode, "fresh");
	assert.equal(f.runRecord.sessions[0].boundary?.intent, "independent-judgment");
	assert.equal((await f.ws.readRun("M07Objective", f.runRecord.runId)).sessions.length, 1);
	assert.equal((await readFile(f.contractFile, "utf8")), `${JSON.stringify(f.contract, null, 2)}\n`);
});

const groundingKinds = {
	"original-problem.txt": "supplied-task" as const,
	"original-source.cpp": "supplied-task" as const,
	"second-text.txt": "supplied-task" as const,
	"candidate.cpp": "selected-evidence" as const,
	"verification.json": "selected-evidence" as const,
};

function groundedReply(f: Awaited<ReturnType<typeof fixture>>, decision: "continue" | "blocked",
	classification: "explicit-requirement" | "optional-method") {
	const base = assessment(decision);
	const claim = base.unresolvedDetails[0]!;
	const issue = classification === "explicit-requirement" ? {
		id: "strategy-gap", claim, status: "open" as const, classification,
		implication: "The requested strategy still needs support.",
		sourceRefs: [{ sourceId: "current-user-overrides", startLine: 1, endLine: 1 }],
	} : {
		id: "method-limit", claim, status: "open" as const, classification,
		implication: "A suggested method remains unavailable.",
		optionalBasis: "The supplied material presents it as a possible method.",
		sourceRefs: [{ sourceId: "original-problem.txt", startLine: 1, endLine: 1 }],
	};
	const groundedAssessment: GroundedAssessmentProposal = {
		version: 1, kind: "grounded-assessment-proposal", contractId: f.contract.id,
		missionStatus: "open", issues: [issue], legacyOpenDetails: ["Preserved old detail"],
		...(decision === "continue" ? { nextTask: {
			obligationIds: ["original-task"], addresses: ["strategy-gap"], adapterScope: "two-target-existing",
			decisionChangingHypothesis: "A new comparison could change the strategy recommendation.",
			expectedEvidence: "A correctness result and measured comparison.",
			sourceRefs: [{ sourceId: "current-user-overrides", startLine: 1, endLine: 1 }],
		} } : {}),
		deliverableReady: { status: "proposed", ready: false, rationale: "Evidence remains incomplete.",
			evidenceRefs: [{ sourceId: "verification.json", startLine: 1, endLine: 1 }],
			remainingIssueIds: [issue.id] },
	};
	return { ...base, groundedAssessment };
}

test("grounded live proposal needs full frozen reads before its decision-changing task dispatches", async t => {
	const f = await fixture(t);
	let turns = 0, dispatched = 0;
	const runner = new FakeSessionRunner(({ message }) => {
		turns++;
		if (turns === 1) assert.match(message, /groundedAssessment|Grounded assessment/);
		return { text: JSON.stringify(groundedReply(f, "continue", "explicit-requirement")),
			readReturns: turns === 1 ? ranges(f, ["second-text.txt"]) : ranges(f, ["original-objective.json",
				"original-problem.txt", "original-source.cpp", "candidate.cpp", "verification.json"]) };
	});
	const result = await assessAndAdvanceOriginalObjective({ ...f, runner,
		userOverrides: ["Deliver the strongest supported strategy"],
		groundingPolicy: { require: true, sourceKinds: groundingKinds,
			legacyOpenDetails: ["Preserved old detail"] },
		capabilities: [{ scope: "two-target-existing", available: true, description: "Synthetic runner", limits: [] }],
		persistReceipt: () => f.ws.writeRun(f.runRecord), assessmentAdmission: "admitted",
		advanceAdmission: () => "admitted", supportedTaskScopes: ["two-target-existing"],
		advance: async () => { dispatched++; return "advanced"; } });
	assert.equal(turns, 2);
	assert.equal(dispatched, 1);
	assert.equal(result.stopReason, "objective-reassessment-pending");
	assert.deepEqual(result.assessment?.unreadEvidence, []);
	assert.equal(result.assessment?.groundedAssessment?.missionStatus, "open");
});

test("an optional method alone cannot force repeated work despite a generic available adapter", async t => {
	const f = await fixture(t);
	let turns = 0, dispatched = 0;
	const runner = new FakeSessionRunner(() => {
		turns++;
		return { text: JSON.stringify(groundedReply(f, "blocked", "optional-method")), readReturns: ranges(f) };
	});
	const result = await assessAndAdvanceOriginalObjective({ ...f, runner,
		userOverrides: ["Deliver the strongest supported strategy"],
		groundingPolicy: { require: true, sourceKinds: groundingKinds,
			legacyOpenDetails: ["Preserved old detail"] },
		capabilities: [{ scope: "two-target-existing", available: true, description: "Synthetic runner", limits: [] }],
		persistReceipt: () => f.ws.writeRun(f.runRecord), assessmentAdmission: "admitted",
		advanceAdmission: () => "admitted", supportedTaskScopes: ["two-target-existing"],
		advance: async () => { dispatched++; } });
	assert.equal(turns, 1);
	assert.equal(dispatched, 0);
	assert.equal(result.stopReason, "model-reported-blocked");
	assert.equal(objectiveProgress(f.contract, { boundedRuns: [], selectedArtifacts: [],
		assessment: result.assessment, stopReason: result.stopReason }).objectiveOutcome, "incomplete");
});

test("a previous verification issue can resolve from frozen evidence without closing the open mission", async t => {
	const f = await fixture(t);
	const verdict = assessment("fulfilled");
	verdict.groundedAssessment = {
		version: 1, kind: "grounded-assessment-proposal", contractId: f.contract.id,
		missionStatus: "open", legacyOpenDetails: ["Preserved old detail"],
		issues: [{ id: "prior-check", claim: "Verify the previous claim", status: "resolved",
			classification: "necessary-verification", claimAtRisk: "The earlier recommendation is correct.",
			implication: "The claim now has a check.",
			sourceRefs: [{ sourceId: "original-problem.txt", startLine: 1, endLine: 1 }],
			resolution: { explanation: "A selected result supplies the required check.",
				evidenceRefs: [{ sourceId: "verification.json", startLine: 1, endLine: 1 }] } }],
		deliverableReady: { status: "proposed", ready: true,
			rationale: "The current selected result supports a deliverable recommendation.",
			evidenceRefs: [{ sourceId: "verification.json", startLine: 1, endLine: 1 }],
			remainingIssueIds: [] },
	};
	let dispatched = 0;
	const runner = new FakeSessionRunner(() => ({ text: JSON.stringify(verdict), readReturns: ranges(f) }));
	const previousIssue = { ...verdict.groundedAssessment.issues[0]!, status: "open" as const,
		resolution: undefined };
	const result = await assessAndAdvanceOriginalObjective({ ...f, runner,
		userOverrides: ["Deliver the strongest supported strategy"],
		groundingPolicy: { require: true, sourceKinds: groundingKinds,
			legacyOpenDetails: ["Preserved old detail"], previousIssues: [previousIssue],
			newEvidenceSourceIds: ["verification.json"] },
		capabilities: [{ scope: "two-target-existing", available: true, description: "Synthetic runner", limits: [] }],
		persistReceipt: () => f.ws.writeRun(f.runRecord), assessmentAdmission: "admitted",
		advanceAdmission: () => "admitted", supportedTaskScopes: ["two-target-existing"],
		advance: async () => { dispatched++; } });
	assert.equal(dispatched, 0);
	assert.equal(result.stopReason, "model-closure-unverified");
	assert.equal(result.assessment?.groundedAssessment?.issues[0]?.status, "resolved");
	assert.equal(objectiveProgress(f.contract, { boundedRuns: [], selectedArtifacts: [],
		assessment: result.assessment, stopReason: result.stopReason }).objectiveOutcome, "incomplete");
});

async function addHistoryEvidence(f: Awaited<ReturnType<typeof fixture>>, partCount = 1) {
	const indexName = "prior-research-history-index.json";
	const partNames = Array.from({ length: partCount }, (_, i) => `prior-history-part-${i + 1}.txt`);
	const indexFile = path.join(f.root, indexName);
	await writeFile(indexFile, `${JSON.stringify({ parts: partNames })}\n`);
	f.evidence.push({ name: indexName, file: indexFile });
	for (const name of partNames) {
		const file = path.join(f.root, name);
		await writeFile(file, `${"x".repeat(700_000)}\n`);
		f.evidence.push({ name, file });
	}
	const indexRead: ReadReturnEvent = { toolName: "objective_evidence_read", status: "returned",
		path: indexName, requested: {}, returned: { kind: "text", startLine: 1, endLine: 1,
			truncated: false }, at: new Date().toISOString() };
	return { indexName, partNames, indexRead,
		access: Object.fromEntries(partNames.map(name => [name, "retrievable" as const])) };
}

test("large retained history stays frozen and retrievable without an aggregate read requirement", async t => {
	const f = await fixture(t);
	const history = await addHistoryEvidence(f, 3);
	let dispatched = 0;
	const runner = new FakeSessionRunner(({ message }) => {
		assert.match(message, /Additional frozen history is retrievable on demand/);
		assert.ok(!message.includes(history.partNames[2]!));
		return { text: JSON.stringify(assessment("continue")),
			readReturns: [...ranges(f), history.indexRead] };
	});
	const result = await assessAndAdvanceOriginalObjective({ ...f, runner,
		evidenceAccess: history.access,
		evidenceRequirements: { requiredNames: ["original-problem.txt", "candidate.cpp", "verification.json",
			history.indexName] },
		persistReceipt: () => f.ws.writeRun(f.runRecord), assessmentAdmission: "admitted",
		advanceAdmission: () => "admitted", supportedTaskScopes: ["two-target-existing"],
		advance: async () => { dispatched++; } });
	assert.equal(result.stopReason, "objective-reassessment-pending");
	assert.equal(dispatched, 1);
	assert.deepEqual(result.assessment?.unreadEvidence, []);
	assert.ok(!result.assessment?.evidenceRead.includes(history.partNames[0]!));
	for (const name of history.partNames)
		assert.equal((await readFile(path.join(f.evidenceRoot, name))).length, 700_001);
});

test("citing a retrievable whole file requires its complete current-session read", async t => {
	const f = await fixture(t);
	const history = await addHistoryEvidence(f);
	let turns = 0, dispatched = 0;
	const partRead: ReadReturnEvent = { toolName: "objective_evidence_read", status: "returned",
		path: history.partNames[0]!, requested: {}, returned: { kind: "text", startLine: 1,
			endLine: 1, truncated: false }, at: new Date().toISOString() };
	const modelReply = { ...assessment("continue"),
		evidenceRefs: ["candidate.cpp", "verification.json", history.partNames[0]!] };
	const runner = new FakeSessionRunner(() => ({ text: JSON.stringify(modelReply),
		readReturns: ++turns === 1 ? [...ranges(f), history.indexRead] : [partRead] }));
	const result = await assessAndAdvanceOriginalObjective({ ...f, runner,
		evidenceAccess: history.access, persistReceipt: () => f.ws.writeRun(f.runRecord),
		assessmentAdmission: "admitted", advanceAdmission: () => "admitted",
		supportedTaskScopes: ["two-target-existing"], advance: async () => { dispatched++; } });
	assert.equal(turns, 2);
	assert.equal(dispatched, 1);
	assert.deepEqual(result.assessment?.unreadEvidence, []);
});

test("a retrievable grounded span requires its exact returned lines", async t => {
	const f = await fixture(t);
	const history = await addHistoryEvidence(f);
	const part = history.partNames[0]!;
	await writeFile(path.join(f.root, part), "first\nsecond\nthird\n");
	const verdict = groundedReply(f, "continue", "explicit-requirement");
	verdict.groundedAssessment!.issues[0] = {
		id: "strategy-gap", claim: verdict.unresolvedDetails[0]!, status: "open",
		classification: "necessary-verification", claimAtRisk: "The strategy recommendation is correct.",
		implication: "Historical evidence could change the recommendation.",
		sourceRefs: [{ sourceId: part, startLine: 3, endLine: 3 }],
	};
	let turns = 0, dispatched = 0;
	const runner = new FakeSessionRunner(() => ({ text: JSON.stringify(verdict),
		readReturns: ++turns === 1 ? [...ranges(f), history.indexRead,
			{ toolName: "objective_evidence_read", status: "returned", path: part, requested: {},
				returned: { kind: "text", startLine: 3, endLine: 3, truncated: true },
				at: new Date().toISOString() } as ReadReturnEvent] :
			[{ toolName: "objective_evidence_read", status: "returned", path: part, requested: {},
				returned: { kind: "text", startLine: 3, endLine: 3, truncated: false },
				at: new Date().toISOString() } as ReadReturnEvent] }));
	const result = await assessAndAdvanceOriginalObjective({ ...f, runner,
		userOverrides: ["Deliver the strongest supported strategy"],
		groundingPolicy: { require: true,
			sourceKinds: { ...groundingKinds, [history.indexName]: "selected-evidence", [part]: "selected-evidence" },
			legacyOpenDetails: ["Preserved old detail"] },
		evidenceAccess: history.access,
		capabilities: [{ scope: "two-target-existing", available: true, description: "Synthetic runner", limits: [] }],
		persistReceipt: () => f.ws.writeRun(f.runRecord), assessmentAdmission: "admitted",
		advanceAdmission: () => "admitted", supportedTaskScopes: ["two-target-existing"],
		advance: async () => { dispatched++; } });
	assert.equal(turns, 2);
	assert.equal(dispatched, 1);
	assert.deepEqual(result.assessment?.unreadEvidence, []);
	assert.ok(!result.assessment?.evidenceRead.includes(part), "span coverage does not pretend full-file coverage");
});

test("fresh assessor context must reread mandatory files even when history is retrievable", async t => {
	const f = await fixture(t);
	const history = await addHistoryEvidence(f);
	let calls = 0, dispatched = 0;
	const runner = new FakeSessionRunner(() => {
		calls++;
		if (calls <= 2) return { text: "invalid JSON", readReturns: calls === 1 ?
			[...ranges(f), history.indexRead] : [] };
		return { text: JSON.stringify(assessment("continue")), readReturns: calls === 3 ? [] :
			[...ranges(f), history.indexRead] };
	});
	const result = await assessAndAdvanceOriginalObjective({ ...f, runner,
		evidenceAccess: history.access, persistReceipt: () => f.ws.writeRun(f.runRecord),
		assessmentAdmission: "admitted", advanceAdmission: () => "admitted",
		supportedTaskScopes: ["two-target-existing"], advance: async () => { dispatched++; } });
	assert.equal(runner.created.length, 2);
	assert.equal(calls, 4);
	assert.equal(dispatched, 1);
	assert.equal(result.stopReason, "objective-reassessment-pending");
});

async function addPriorGroundingIndex(f: Awaited<ReturnType<typeof fixture>>,
	legacyOpenDetails: string[], previousIssues: GroundedAssessmentProposal["issues"]) {
	const indexName = "prior-grounding-index.json";
	const parts: Array<{ name: string; text: string }> = [];
	const legacyLocators = legacyOpenDetails.map((value, n) => {
		const name = `prior-grounding-legacy-${n + 1}.jsonl`;
		parts.push({ name, text: `${JSON.stringify({ kind: "legacy-detail", value })}\n` });
		return { partName: name, line: 1 };
	});
	const issueLocators = previousIssues.map((value, n) => {
		const name = `prior-grounding-issue-${n + 1}.jsonl`;
		parts.push({ name, text: `${JSON.stringify({ kind: "issue", value })}\n` });
		return { id: value.id, partName: name, line: 1 };
	});
	const index = { version: 1, kind: "prior-grounding-index", parts: parts.map(item => item.name),
		legacyLocators, issueLocators };
	const indexFile = path.join(f.root, indexName);
	await writeFile(indexFile, `${JSON.stringify(index)}\n`);
	f.evidence.push({ name: indexName, file: indexFile });
	for (const part of parts) {
		const file = path.join(f.root, part.name);
		await writeFile(file, part.text);
		f.evidence.push({ name: part.name, file });
	}
	const indexRead: ReadReturnEvent = { toolName: "objective_evidence_read", status: "returned",
		path: indexName, requested: {}, returned: { kind: "text", startLine: 1,
			endLine: 1, truncated: false }, at: new Date().toISOString() };
	return { indexName, parts, indexRead, issueLocators,
		access: Object.fromEntries(parts.map(item => [item.name, "retrievable" as const])),
		sourceKinds: { ...groundingKinds, [indexName]: "selected-evidence" as const,
			...Object.fromEntries(parts.map(item => [item.name, "selected-evidence" as const])) },
		priorGroundingIndex: { indexName, partNames: parts.map(item => item.name) } };
}

const deltaReply = (decision: "blocked" | "fulfilled", resolution?: {
	id: string; priorRef: { sourceId: string; startLine: number; endLine: number } }) => ({
	version: 1, decision, rationale: "Synthetic bounded assessment",
	evidenceRefs: ["candidate.cpp", "verification.json"],
	unresolvedObligations: decision === "blocked" ? ["original-task"] : [],
	groundedAssessmentDelta: { version: 1, kind: "grounded-assessment-delta",
		newIssues: [], resolutions: resolution ? [{ ...resolution,
			explanation: "A new frozen result checks the prior claim.",
			evidenceRefs: [{ sourceId: "verification.json", startLine: 1, endLine: 1 }] }] : [] },
});

test("indexed prior grounding stays out of prompt and omitted issues remain open", async t => {
	const f = await fixture(t);
	const legacy = ["L".repeat(700_000)];
	const issues: GroundedAssessmentProposal["issues"] = [{ id: "old-method",
		claim: "C".repeat(700_000), status: "open", classification: "optional-method",
		optionalBasis: "A historical source called it optional.", implication: "No new task is forced.",
		sourceRefs: [{ sourceId: "original-problem.txt", startLine: 1, endLine: 1 }] }];
	const prior = await addPriorGroundingIndex(f, legacy, issues);
	let dispatched = 0;
	const runner = new FakeSessionRunner(({ message }) => {
		assert.ok(!message.includes("L".repeat(50)));
		assert.ok(!message.includes("C".repeat(50)));
		assert.ok(!message.includes(prior.parts[0]!.name), "part names come from the required index");
		return { text: JSON.stringify(deltaReply("blocked")),
			readReturns: [...ranges(f), prior.indexRead] };
	});
	const result = await assessAndAdvanceOriginalObjective({ ...f, runner,
		evidenceAccess: prior.access, userOverrides: ["Deliver the strongest supported strategy"],
		groundingPolicy: { require: true, sourceKinds: prior.sourceKinds,
			legacyOpenDetails: legacy, previousIssues: issues,
			priorGroundingIndex: prior.priorGroundingIndex },
		capabilities: [{ scope: "two-target-existing", available: true, description: "Synthetic", limits: [] }],
		persistReceipt: () => f.ws.writeRun(f.runRecord), assessmentAdmission: "admitted",
		advanceAdmission: () => "admitted", supportedTaskScopes: ["two-target-existing"],
		advance: async () => { dispatched++; } });
	assert.equal(dispatched, 0);
	assert.equal(result.stopReason, "model-reported-blocked");
	assert.deepEqual(result.assessment?.groundedAssessment?.issues, issues);
	assert.deepEqual(result.assessment?.groundedAssessment?.legacyOpenDetails, legacy);
	assert.deepEqual(result.assessment?.unreadEvidence, []);
});

test("missing or tampered prior grounding part is rejected before an assessor prompt", async t => {
	const f = await fixture(t);
	const legacy = ["authenticated old detail"];
	const prior = await addPriorGroundingIndex(f, legacy, []);
	const runner = new FakeSessionRunner(() => { throw new Error("assessor must not start"); });
	await writeFile(path.join(f.root, prior.parts[0]!.name),
		`${JSON.stringify({ kind: "legacy-detail", value: "tampered" })}\n`);
	const base = { ...f, runner, evidenceAccess: prior.access,
		groundingPolicy: { require: true as const, sourceKinds: prior.sourceKinds,
			legacyOpenDetails: legacy, previousIssues: [],
			priorGroundingIndex: prior.priorGroundingIndex },
		persistReceipt: () => f.ws.writeRun(f.runRecord), assessmentAdmission: "admitted" as const,
		advanceAdmission: () => "admitted" as const, supportedTaskScopes: ["two-target-existing"],
		advance: async () => { throw new Error("must not dispatch"); } };
	await assert.rejects(assessAndAdvanceOriginalObjective(base), /partition differs/);
	assert.equal(runner.created.length, 0);
	await rm(path.join(f.root, prior.parts[0]!.name));
	await assert.rejects(assessAndAdvanceOriginalObjective(base));
	assert.equal(runner.created.length, 0);
});

test("indexed prior resolution needs its old line and new evidence returned in this session", async t => {
	const f = await fixture(t);
	const issues: GroundedAssessmentProposal["issues"] = [{ id: "old-check",
		claim: "A previous claim needs verification.", status: "open",
		classification: "necessary-verification", claimAtRisk: "The proposed recommendation is correct.",
		implication: "Verification could change the recommendation.",
		sourceRefs: [{ sourceId: "original-problem.txt", startLine: 1, endLine: 1 }] }];
	const prior = await addPriorGroundingIndex(f, [], issues);
	const oldPart = prior.issueLocators[0]!.partName;
	const resolved = deltaReply("fulfilled", { id: "old-check",
		priorRef: { sourceId: oldPart, startLine: 1, endLine: 1 } });
	let prompts = 0;
	const missingRunner = new FakeSessionRunner(() => {
		prompts++;
		if (prompts > 1) throw new Error("synthetic transport failure after missing prior line");
		return { text: JSON.stringify(resolved), readReturns: [...ranges(f), prior.indexRead] };
	});
	const common = { ...f, evidenceAccess: prior.access,
		userOverrides: ["Deliver the strongest supported strategy"],
		groundingPolicy: { require: true as const, sourceKinds: prior.sourceKinds,
			legacyOpenDetails: [], previousIssues: issues, newEvidenceSourceIds: ["verification.json"],
			priorGroundingIndex: prior.priorGroundingIndex },
		capabilities: [{ scope: "two-target-existing", available: true, description: "Synthetic", limits: [] }],
		persistReceipt: () => f.ws.writeRun(f.runRecord), assessmentAdmission: "admitted" as const,
		advanceAdmission: () => "admitted" as const,
		supportedTaskScopes: ["two-target-existing"], advance: async () => {
			throw new Error("must not dispatch"); } };
	const missing = await assessAndAdvanceOriginalObjective({ ...common, runner: missingRunner });
	assert.equal(missing.stopReason, "assessment-failed");
	assert.ok(missing.assessment?.unreadEvidence.includes(oldPart));
	const validRunner = new FakeSessionRunner(() => ({ text: JSON.stringify(resolved),
		readReturns: [...ranges(f), prior.indexRead,
			{ toolName: "objective_evidence_read", status: "returned", path: oldPart, requested: {},
				returned: { kind: "text", startLine: 1, endLine: 1, truncated: false },
				at: new Date().toISOString() } as ReadReturnEvent] }));
	const valid = await assessAndAdvanceOriginalObjective({ ...common, runner: validRunner,
		evidenceRoot: path.join(f.root, "second-assessment-evidence") });
	assert.equal(valid.stopReason, "model-closure-unverified");
	assert.equal(valid.assessment?.groundedAssessment?.issues[0]?.status, "resolved");
	assert.equal(objectiveProgress(f.contract, { boundedRuns: [], selectedArtifacts: [],
		assessment: valid.assessment, stopReason: valid.stopReason }).objectiveOutcome, "incomplete");
});

test("assessment may cite the required frozen original-objective contract", async t => {
	const f = await fixture(t);
	const proposal = { ...assessment("continue"),
		evidenceRefs: ["original-objective.json", "candidate.cpp", "verification.json"] };
	const { result, advanced } = await invoke(f,
		{ text: JSON.stringify(proposal), readReturns: ranges(f) });
	assert.equal(result.stopReason, "objective-reassessment-pending");
	assert.equal(advanced.length, 1);
	assert.deepEqual(result.assessment?.evidenceRefs, proposal.evidenceRefs);
});

test("assessment parsing has no workflow-chosen raw response byte cap", async t => {
	const f = await fixture(t);
	const { result, advanced } = await invoke(f, {
		text: JSON.stringify(assessment("continue")) + " ".repeat(33_000), readReturns: ranges(f),
	});
	assert.equal(result.stopReason, "objective-reassessment-pending");
	assert.equal(advanced.length, 1);
});

test("original-objective assessment retains more than 16 files and 12 obligations or capability facts", async t => {
	const f = await fixture(t);
	const extras = await Promise.all(Array.from({ length: 12 }, async (_, index) => {
		const name = `extra-${String(index + 1).padStart(3, "0")}.txt`;
		const file = path.join(f.root, "source", name);
		await writeFile(file, `Evidence ${index + 1}\n`);
		return { name, file };
	}));
	const evidence = [...f.evidence, ...extras];
	const obligationIds = Array.from({ length: 13 }, (_, index) => `obligation-${index + 1}`);
	const overrides = Array.from({ length: 13 }, (_, index) => `User constraint ${index + 1}`);
	const contract = createOriginalObjective({ goal: `Original goal ${"G".repeat(4_100)}`, goalSource: "user-intent-summary",
		inputNames: evidence.map(item => item.name), userOverrides: overrides,
		obligations: obligationIds.map(id => ({ id, description: `Keep ${id}` })), closure: "open-ended" });
	await writeFile(f.contractFile, `${JSON.stringify(contract, null, 2)}\n`);
	const facts = [{ scope: "two-target-existing", available: true, description: "Observed capability",
		limits: Array.from({ length: 13 }, (_, index) => `Real host fact ${index + 1}`) }];
	const response: ModelObjectiveAssessmentV1 = { version: 1, decision: "continue", rationale: "R".repeat(4_100),
		evidenceRefs: evidence.map(item => item.name), unresolvedObligations: obligationIds,
		unresolvedDetails: obligationIds.map(id => `${id}: ${"D".repeat(810)}`),
		nextTask: { objective: "Continue every remaining obligation", addresses: obligationIds, adapterScope: "two-target-existing" } };
	const reads = await Promise.all([{ name: "original-objective.json", file: f.contractFile }, ...evidence].map(async item => {
		const body = await readFile(item.file, "utf8");
		return { toolName: "objective_evidence_read", status: "returned" as const, path: item.name, requested: {},
			returned: { kind: "text" as const, startLine: 1, endLine: lines(body), truncated: false }, at: new Date().toISOString() };
	}));
	const runner = new FakeSessionRunner(() => ({ text: JSON.stringify(response), readReturns: reads }));
	const result = await assessAndAdvanceOriginalObjective({ contract, contractFile: f.contractFile, runner,
		sessionSpec: f.sessionSpec, runRecord: f.runRecord, persistReceipt: () => f.ws.writeRun(f.runRecord),
		evidenceRoot: f.evidenceRoot, evidence, capabilities: facts, userOverrides: overrides,
		assessmentAdmission: "admitted", advanceAdmission: () => "admitted", supportedTaskScopes: ["two-target-existing"],
		advance: async task => task.objective });
	assert.equal(result.stopReason, "objective-reassessment-pending");
	assert.equal(result.assessment?.evidenceRead.length, evidence.length + 1);
	assert.deepEqual(result.assessment?.unresolvedObligations, obligationIds);
});

test("objective assessor freezes more than 1 MB combined individually bounded evidence", async t => {
	const f = await fixture(t);
	const extras = await Promise.all(["carry-control.json", "checkpoint-control.json"].map(async name => {
		const file = path.join(f.root, "source", name);
		await writeFile(file, `${"x".repeat(99)}\n`.repeat(5_500));
		return { name, file };
	}));
	const evidence = [...f.evidence, ...extras];
	const reads = [...ranges(f), ...extras.flatMap(item => Array.from({ length: 55 }, (_, page) => ({
		toolName: "objective_evidence_read", status: "returned" as const, path: item.name,
		requested: { offset: page * 100 + 1, limit: 100 },
		returned: { kind: "text" as const, startLine: page * 100 + 1, endLine: (page + 1) * 100,
			truncated: page < 54 }, at: new Date().toISOString(),
	})))];
	const runner = new FakeSessionRunner(() => ({ text: JSON.stringify(assessment("continue")), readReturns: reads }));
	const result = await assessAndAdvanceOriginalObjective({ ...f, evidence, runner,
		persistReceipt: () => f.ws.writeRun(f.runRecord), assessmentAdmission: "admitted",
		advanceAdmission: () => "admitted", supportedTaskScopes: ["two-target-existing"],
		advance: async task => task.objective });
	assert.equal(result.stopReason, "objective-reassessment-pending");
	assert.deepEqual(result.assessment?.unreadEvidence, []);
	assert.equal(result.assessment?.evidenceRead.length, evidence.length + 1);
	assert.equal(runner.created.length, 1);
});

test("objective assessor still rejects a single evidence file over 1 MB", async t => {
	const f = await fixture(t);
	const file = path.join(f.root, "source", "oversize-control.json");
	await writeFile(file, "x".repeat(1_000_001));
	const runner = new FakeSessionRunner(() => "must not dispatch");
	await assert.rejects(assessAndAdvanceOriginalObjective({ ...f,
		evidence: [...f.evidence, { name: "oversize-control.json", file }], runner,
		persistReceipt: () => f.ws.writeRun(f.runRecord), assessmentAdmission: "admitted",
		advanceAdmission: () => "admitted", supportedTaskScopes: ["two-target-existing"],
		advance: async task => task.objective }), /bounded regular file/);
	assert.equal(runner.created.length, 0);
});

test("accepted finite pilot and even a model fulfilled claim cannot close an open original mission", async t => {
	const f = await fixture(t);
	const { result, advanced } = await invoke(f, { text: JSON.stringify(assessment("fulfilled")), readReturns: ranges(f) });
	assert.equal(result.stopReason, "model-closure-unverified");
	assert.equal(advanced.length, 0);
	const progress = objectiveProgress(f.contract, { boundedRuns: [{ runId: "pilot", outcome: "fulfilled", selectedTaskId: "T001" }],
		selectedArtifacts: ["candidate.cpp", "verification.json"], assessment: result.assessment,
		stopReason: result.stopReason });
	assert.equal(progress.objectiveOutcome, "incomplete");
	assert.equal(progress.stopReason, "model-closure-unverified");
	assert.deepEqual(progress.continuation.unresolvedObligations, ["original-task"]);
});

test("blocked assessment cannot launch more execution", async t => {
	const f = await fixture(t);
	const { result, advanced } = await invoke(f,
		{ text: JSON.stringify(assessment("blocked")), readReturns: ranges(f) });
	assert.equal(result.stopReason, "model-reported-blocked");
	assert.equal(advanced.length, 0);
});

test("complete evidence with repeated malformed assessments gets same-session schema feedback then valid dispatch", async t => {
	const f = await fixture(t);
	let admissionCalls = 0;
	const runner = new FakeSessionRunner(({ turnIndex, message }) => {
		if (turnIndex === 1) return { text: "not JSON", readReturns: ranges(f) };
		if (turnIndex === 2) {
			assert.match(message, /assessment is not strict JSON/);
			assert.match(message, /frozen evidence was already returned in full/);
			return { text: JSON.stringify({ ...assessment("continue"),
				nextTask: { ...assessment("continue").nextTask, adapterScope: ["two-target-existing"] } }) };
		}
		assert.equal(turnIndex, 3);
		assert.match(message, /next task does not address unresolved original obligations/);
		return { text: JSON.stringify(assessment("continue")) };
	});
	const advanced: ObjectiveNextTaskV1[] = [];
	const result = await assessAndAdvanceOriginalObjective({ ...f, runner,
		persistReceipt: () => f.ws.writeRun(f.runRecord), assessmentAdmission: "admitted",
		advanceAdmission: () => { admissionCalls++; return "admitted"; },
		supportedTaskScopes: ["two-target-existing"], advance: async task => { advanced.push(task); } });
	assert.equal(result.stopReason, "objective-reassessment-pending");
	assert.equal(result.assessment?.proposalHistory?.length, 1);
	assert.equal(advanced.length, 1);
	assert.equal(admissionCalls, 3);
	assert.equal(runner.created.length, 1);
	const carried = objectiveProgress(f.contract, { boundedRuns: [{ runId: "selected-goal",
		outcome: "fulfilled", selectedTaskId: "T001" }],
		selectedArtifacts: ["candidate.cpp", "verification.json", "workflow-archive.json"],
		assessment: result.assessment, stopReason: result.stopReason, nextTaskDispatched: true });
	assert.equal(carried.objectiveOutcome, "incomplete");
	assert.deepEqual(carried.selectedArtifacts,
		["candidate.cpp", "verification.json", "workflow-archive.json"]);
});

test("invalid fully read assessment obeys real admission before retry and never dispatches", async t => {
	const f = await fixture(t);
	const runner = new FakeSessionRunner(() => ({ text: "not JSON", readReturns: ranges(f) }));
	let dispatched = false;
	const result = await assessAndAdvanceOriginalObjective({ ...f, runner,
		persistReceipt: () => f.ws.writeRun(f.runRecord), assessmentAdmission: "admitted",
		advanceAdmission: () => "output-limit", supportedTaskScopes: ["two-target-existing"],
		advance: async () => { dispatched = true; } });
	assert.equal(result.stopReason, "output-limit");
	assert.equal(dispatched, false);
	assert.equal([...runner.sessions.values()][0].turns, 1);
});

test("repeated invalid assessment class survives wording changes and repairs in a fresh context", async t => {
	const f = await fixture(t);
	const repairs: WorkflowRepairStateV1[] = [];
	let calls = 0, dispatches = 0;
	const runner = new FakeSessionRunner(({ turnIndex, message, userMessages }) => {
		calls++;
		if (calls < 3) return { text: calls === 1 ? "not JSON" : "  still not JSON  ",
			readReturns: calls === 1 ? ranges(f) : [] };
		assert.equal(turnIndex, 1);
		assert.equal(userMessages.length, 1);
		assert.equal(repairs.at(-1)?.strategy, "fresh-context", "repair receipt precedes provider prompt");
		assert.match(message, /complete original-objective\.json and every listed file/);
		assert.doesNotMatch(message, /not JSON|failed host validation/);
		return { text: JSON.stringify(assessment("continue")), readReturns: ranges(f) };
	});
	const result = await assessAndAdvanceOriginalObjective({ ...f, runner,
		persistReceipt: () => f.ws.writeRun(f.runRecord), assessmentAdmission: "admitted", advanceAdmission: () => "admitted",
		supportedTaskScopes: ["two-target-existing"], recordRepairState: async state => { repairs.push(state); },
		advance: async () => { dispatches++; } });
	assert.equal(result.stopReason, "objective-reassessment-pending");
	assert.equal(dispatches, 1);
	assert.equal(runner.created.length, 2);
	assert.equal(repairs[0].responseFingerprint, repairs[1].responseFingerprint);
	assert.equal(repairs[0].evidenceFingerprint, repairs[1].evidenceFingerprint);
	assert.ok(repairs.every(item => !JSON.stringify(item).includes("not JSON")));
});

test("fresh assessor cannot dispatch using its predecessor's full read proof", async t => {
	const f = await fixture(t);
	let calls = 0, dispatches = 0;
	const runner = new FakeSessionRunner(({ turnIndex, message }) => {
		calls++;
		if (calls < 3) return { text: "not JSON", readReturns: calls === 1 ? ranges(f) : [] };
		if (calls === 3) {
			assert.equal(turnIndex, 1);
			return { text: JSON.stringify(assessment("continue")),
				readReturns: ranges(f).filter(item => item.path === "candidate.cpp") };
		}
		assert.equal(calls, 4);
		assert.equal(dispatches, 0);
		assert.match(message, /Unread or incomplete files: original-objective\.json/);
		return { text: JSON.stringify(assessment("continue")),
			readReturns: ranges(f).filter(item => item.path !== "candidate.cpp") };
	});
	const result = await assessAndAdvanceOriginalObjective({ ...f, runner,
		persistReceipt: () => f.ws.writeRun(f.runRecord), assessmentAdmission: "admitted", advanceAdmission: () => "admitted",
		supportedTaskScopes: ["two-target-existing"], advance: async () => { dispatches++; } });
	assert.equal(result.stopReason, "objective-reassessment-pending");
	assert.equal(dispatches, 1);
	assert.equal(runner.created.length, 2);
	assert.deepEqual(result.assessment?.unreadEvidence, []);
	assert.equal(result.assessment?.evidenceRead.length, f.evidence.length + 1);
});

test("unavailable fresh assessor handoff leaves a typed workflow repair open without a human gate", async t => {
	for (const unavailable of ["fresh-factory", "frozen-input"] as const) {
		const f = await fixture(t);
		const repairs: WorkflowRepairStateV1[] = [];
		let calls = 0, creations = 0, dispatches = 0;
		const runner = new FakeSessionRunner(async () => {
			calls++;
			if (calls === 2 && unavailable === "frozen-input")
				await rm(path.join(f.evidenceRoot, "second-text.txt"));
			return { text: "not JSON", readReturns: calls === 1 ? ranges(f) : [] };
		});
		const create = runner.create.bind(runner);
		runner.create = async spec => {
			creations++;
			if (creations === 2 && unavailable === "fresh-factory")
				throw new HarnessError("context.capability", "synthetic fresh read-only grant unavailable");
			return create(spec);
		};
		const result = await assessAndAdvanceOriginalObjective({ ...f, runner,
			persistReceipt: () => f.ws.writeRun(f.runRecord), assessmentAdmission: "admitted", advanceAdmission: () => "admitted",
			supportedTaskScopes: ["two-target-existing"], recordRepairState: async state => { repairs.push(state); },
			advance: async () => { dispatches++; } });
		assert.equal(result.stopReason, "workflow-repair-needed");
		assert.equal(dispatches, 0);
		assert.equal(calls, 2);
		assert.equal(repairs.at(-1)?.strategy, "workflow-repair-needed");
		const checkpoint = objectiveProgress(f.contract, { boundedRuns: [], selectedArtifacts: [],
			assessment: result.assessment, stopReason: result.stopReason, pendingActionFacts: {} });
		assert.equal(checkpoint.objectiveOutcome, "incomplete");
		assert.equal(checkpoint.continuation.pendingAction?.kind, "repair-workflow-state");
		assert.equal(checkpoint.continuation.pendingAction?.humanRequired, undefined);
		assert.equal(checkpoint.continuation.pendingAction?.verifiedHumanBlocker, undefined);
	}
});

test("transient fresh assessor creation failure stays retryable and does not exhaust model repair", async t => {
	const f = await fixture(t);
	const repairs: WorkflowRepairStateV1[] = [];
	let calls = 0, creations = 0, dispatches = 0;
	const runner = new FakeSessionRunner(() => {
		calls++;
		return { text: "not JSON", readReturns: calls === 1 ? ranges(f) : [] };
	});
	const create = runner.create.bind(runner);
	runner.create = async spec => {
		creations++;
		if (creations === 2) throw new Error("synthetic transient local I/O failure");
		return create(spec);
	};
	const result = await assessAndAdvanceOriginalObjective({ ...f, runner,
		persistReceipt: () => f.ws.writeRun(f.runRecord), assessmentAdmission: "admitted", advanceAdmission: () => "admitted",
		supportedTaskScopes: ["two-target-existing"], recordRepairState: async state => { repairs.push(state); },
		advance: async () => { dispatches++; } });
	assert.equal(result.stopReason, "assessment-failed");
	assert.equal(calls, 2, "failed fresh creation must not replay a provider prompt");
	assert.equal(creations, 2, "the assessor must not blindly retry unknown creation failure");
	assert.equal(dispatches, 0);
	assert.equal(repairs.at(-1)?.failure, "context-handoff-unavailable");
	assert.equal(repairs.at(-1)?.strategy, "fresh-context");
	assert.ok(repairs.every(state => state.strategy !== "workflow-repair-needed"));
	const checkpoint = objectiveProgress(f.contract, { boundedRuns: [], selectedArtifacts: [],
		assessment: result.assessment, stopReason: result.stopReason,
		pendingActionFacts: { failedStage: "read-only-assessor" } });
	assert.equal(checkpoint.objectiveOutcome, "incomplete");
	assert.equal(checkpoint.continuation.pendingAction?.kind, "retry-readonly-assessment");
	assert.equal(checkpoint.continuation.pendingAction?.humanRequired, undefined);
});

test("transient fresh-boundary persistence failure does not authorize another prompt or exhaust repair", async t => {
	const f = await fixture(t);
	const repairs: WorkflowRepairStateV1[] = [];
	let calls = 0;
	const runner = new FakeSessionRunner(() => {
		calls++;
		return { text: "not JSON", readReturns: ranges(f) };
	});
	const result = await assessAndAdvanceOriginalObjective({ ...f, runner,
		persistReceipt: async () => {
			if (f.runRecord.sessions.length === 2) throw Object.assign(new Error("synthetic transient receipt failure"), { code: "EIO" });
			await f.ws.writeRun(f.runRecord);
		}, assessmentAdmission: "admitted", advanceAdmission: () => "admitted",
		supportedTaskScopes: ["two-target-existing"], recordRepairState: async state => { repairs.push(state); },
		advance: async () => { throw new Error("must not dispatch"); } });
	assert.equal(result.stopReason, "assessment-failed");
	assert.equal(calls, 2);
	assert.equal(runner.created.length, 2);
	assert.equal([...runner.sessions.values()][1].turns, 0);
	assert.equal([...runner.sessions.values()][1].disposed, true);
	assert.equal(repairs.at(-1)?.failure, "context-handoff-unavailable");
	assert.ok(repairs.every(state => state.strategy !== "workflow-repair-needed"));
});

test("a runner that reuses the old session cannot authorize a fresh assessment prompt", async t => {
	const f = await fixture(t);
	let calls = 0;
	const runner = new FakeSessionRunner(() => {
		calls++;
		return { text: "not JSON", readReturns: ranges(f) };
	});
	const create = runner.create.bind(runner);
	let first: SessionHandle | undefined;
	runner.create = async spec => first ??= await create(spec);
	const result = await assessAndAdvanceOriginalObjective({ ...f, runner,
		persistReceipt: () => f.ws.writeRun(f.runRecord), assessmentAdmission: "admitted", advanceAdmission: () => "admitted",
		supportedTaskScopes: ["two-target-existing"], advance: async () => { throw new Error("must not dispatch"); } });
	assert.equal(result.stopReason, "workflow-repair-needed");
	assert.equal(calls, 2, "the reused handle must never receive another prompt");
	assert.equal(runner.created.length, 1);
});

test("fresh repair keeps the frozen goal, model, capability facts and user overrides", async t => {
	const f = await fixture(t);
	const initialGoal = f.contract.goal;
	const capabilities = [{ scope: "two-target-existing", available: true, description: "Original CPU executor", limits: ["CPU only"] }];
	const overrides = ["Original user override"];
	let calls = 0;
	const runner = new FakeSessionRunner(({ spec, message }) => {
		calls++;
		if (calls < 3) return { text: "not JSON", readReturns: ranges(f) };
		assert.equal(spec.model, "fake/research");
		assert.ok(message.includes(initialGoal));
		assert.match(message, /Original CPU executor|Original user override/);
		assert.doesNotMatch(message, /Mutated/);
		return { text: JSON.stringify(assessment("continue")), readReturns: ranges(f) };
	});
	const result = await assessAndAdvanceOriginalObjective({ ...f, runner, capabilities, userOverrides: overrides,
		persistReceipt: () => f.ws.writeRun(f.runRecord), assessmentAdmission: "admitted", advanceAdmission: () => "admitted",
		supportedTaskScopes: ["two-target-existing"], recordRepairState: async state => {
			if (state.strategy === "same-session-feedback") {
				f.contract.goal = "Mutated goal";
				f.sessionSpec.model = "fake/mutated";
				capabilities[0].available = false;
				capabilities[0].description = "Mutated executor";
				overrides[0] = "Mutated override";
			}
		}, advance: async () => "continued" });
	assert.equal(result.stopReason, "objective-reassessment-pending");
	assert.equal(result.advanced, "continued");
	assert.equal(runner.created.length, 2);
});

test("repeated unchanged unread evidence replaces context and requires every frozen file again", async t => {
	const f = await fixture(t);
	let dispatched = 0, recorded = 0;
	let calls = 0;
	const repairs: WorkflowRepairStateV1[] = [];
	const runner = new FakeSessionRunner(({ turnIndex, message }) => {
		calls++;
		if (calls === 1) return { text: JSON.stringify(assessment("blocked")), readReturns: ranges(f, ["second-text.txt"]) };
		assert.match(message, /second-text\.txt/);
		if (calls === 2) {
			assert.match(message, /reassess the unchanged original objective/);
			return { text: JSON.stringify(assessment("blocked")), readReturns: [] };
		}
		assert.equal(calls, 3);
		assert.equal(turnIndex, 1);
		assert.match(message, /Original objective \(unchanged\)/);
		assert.doesNotMatch(message, /previous assessment|last repair turn/);
		return { text: JSON.stringify(assessment("continue")), readReturns: ranges(f) };
	});
	const result = await assessAndAdvanceOriginalObjective({ ...f, runner,
		persistReceipt: () => f.ws.writeRun(f.runRecord), assessmentAdmission: "admitted", advanceAdmission: () => "admitted",
		supportedTaskScopes: ["two-target-existing"], recordRepairState: async state => { repairs.push(state); }, recordAssessment: async value => {
			recorded++;
			if (recorded === 1) assert.deepEqual(value.unreadEvidence, ["second-text.txt"]);
		}, advance: async () => { dispatched++; } });
	assert.equal(result.stopReason, "objective-reassessment-pending");
	assert.equal(result.assessment?.decision, "continue");
	assert.deepEqual(result.assessment?.unreadEvidence, []);
	assert.equal(result.assessment?.proposalHistory?.length, 3);
	assert.equal(recorded, 3);
	assert.equal(dispatched, 1);
	assert.equal(runner.created.length, 2);
	assert.deepEqual(repairs.map(item => item.strategy), ["same-session-feedback", "fresh-context"]);
	assert.deepEqual(repairs.map(item => item.sessionGeneration), [1, 2]);
	assert.equal([...runner.sessions.values()][0].disposed, true);
	assert.equal([...runner.sessions.values()][1].transcript.length, 2);
});

test("a read tool error receives the correct frozen path and range, then continues in the same session", async t => {
	const f = await fixture(t);
	let dispatched = 0;
	const runner = new FakeSessionRunner(({ turnIndex, message }) => {
		if (turnIndex === 1) return { text: JSON.stringify(assessment("continue")),
			readReturns: [...ranges(f, ["second-text.txt"]), { toolName: "objective_evidence_read",
				status: "error", path: "<unresolved>", requested: { offset: 2, limit: 10 },
				returned: { kind: "unknown" }, at: new Date().toISOString() }] };
		assert.match(message, /objective_evidence_read path="second-text\.txt" offset=1 limit=1/);
		assert.match(message, /host verified that frozen file is still available/);
		return { text: JSON.stringify(assessment("continue")),
			readReturns: ranges(f).filter(item => item.path === "second-text.txt") };
	});
	const result = await assessAndAdvanceOriginalObjective({ ...f, runner,
		persistReceipt: () => f.ws.writeRun(f.runRecord), assessmentAdmission: "admitted",
		advanceAdmission: () => "admitted", supportedTaskScopes: ["two-target-existing"],
		advance: async () => { dispatched++; } });
	assert.equal(result.stopReason, "objective-reassessment-pending");
	assert.deepEqual(result.assessment?.unreadEvidence, []);
	assert.equal([...runner.sessions.values()][0].turns, 2);
	assert.equal(runner.created.length, 1);
	assert.equal(dispatched, 1);
});

test("host-inaccessible frozen evidence suspends assessment and preserves the provisional verdict", async t => {
	const f = await fixture(t);
	let dispatched = false;
	const runner = new FakeSessionRunner(async () => {
		await rm(path.join(f.evidenceRoot, "second-text.txt"));
		return { text: JSON.stringify(assessment("fulfilled")),
			readReturns: [...ranges(f, ["second-text.txt"]), { toolName: "objective_evidence_read",
				status: "error", path: "<unresolved>", requested: { offset: 1, limit: 1 },
				returned: { kind: "unknown" }, at: new Date().toISOString() }] };
	});
	const result = await assessAndAdvanceOriginalObjective({ ...f, runner,
		persistReceipt: () => f.ws.writeRun(f.runRecord), assessmentAdmission: "admitted",
		advanceAdmission: () => "admitted", supportedTaskScopes: ["two-target-existing"],
		advance: async () => { dispatched = true; } });
	assert.equal(result.stopReason, "assessment-evidence-suspended");
	assert.equal(result.assessment?.decision, "fulfilled");
	assert.deepEqual(result.assessment?.unreadEvidence, ["second-text.txt"]);
	const checkpoint = objectiveProgress(f.contract, { boundedRuns: [], selectedArtifacts: [],
		assessment: result.assessment, stopReason: result.stopReason });
	assert.equal(checkpoint.objectiveOutcome, "incomplete");
	assert.equal(checkpoint.stopReason, "assessment-evidence-suspended");
	assert.equal([...runner.sessions.values()][0].turns, 1);
	assert.equal(dispatched, false);
});

test("malformed provisional assessment still repairs unread evidence before judging", async t => {
	const f = await fixture(t);
	let dispatched = 0;
	const runner = new FakeSessionRunner(({ turnIndex, message }) => {
		if (turnIndex === 1) return { text: "not JSON", readReturns: ranges(f, ["second-text.txt"]) };
		assert.match(message, /failed the required strict JSON schema/);
		return { text: JSON.stringify(assessment("continue")),
			readReturns: ranges(f).filter(item => item.path === "second-text.txt") };
	});
	const result = await assessAndAdvanceOriginalObjective({ ...f, runner,
		persistReceipt: () => f.ws.writeRun(f.runRecord), assessmentAdmission: "admitted",
		advanceAdmission: () => "admitted", supportedTaskScopes: ["two-target-existing"],
		advance: async () => { dispatched++; } });
	assert.equal(result.stopReason, "objective-reassessment-pending");
	assert.deepEqual(result.assessment?.unreadEvidence, []);
	assert.equal(dispatched, 1);
	assert.equal([...runner.sessions.values()][0].turns, 2);
});

test("unread-evidence repair preserves a physical output boundary before another assessor prompt", async t => {
	const f = await fixture(t);
	let dispatched = false;
	const runner = new FakeSessionRunner(() => ({ text: JSON.stringify(assessment("continue")),
		readReturns: ranges(f, ["second-text.txt"]) }));
	const result = await assessAndAdvanceOriginalObjective({ ...f, runner,
		persistReceipt: () => f.ws.writeRun(f.runRecord), assessmentAdmission: "admitted",
		advanceAdmission: () => "output-limit", supportedTaskScopes: ["two-target-existing"],
		advance: async () => { dispatched = true; } });
	assert.equal(result.stopReason, "output-limit");
	assert.deepEqual(result.assessment?.unreadEvidence, ["second-text.txt"]);
	assert.equal([...runner.sessions.values()][0].turns, 1);
	assert.equal(dispatched, false);
});

test("paginated objective evidence needs its final untruncated page before dispatch", async t => {
	const f = await fixture(t);
	await writeFile(f.evidence.find(item => item.name === "second-text.txt")!.file, "first line\nsecond line\nthird line\n");
	let dispatched = 0;
	const runner = new FakeSessionRunner(({ turnIndex, message }) => {
		if (turnIndex > 1) assert.match(message, /second-text\.txt/);
		const readReturns: ReadReturnEvent[] = turnIndex === 1 ? ranges(f, ["second-text.txt"]) : [{
			toolName: "objective_evidence_read", status: "returned", path: "second-text.txt", requested: {},
			returned: { kind: "text", startLine: turnIndex === 2 ? 1 : 3,
				endLine: turnIndex === 2 ? 2 : 3, truncated: turnIndex === 2 }, at: new Date().toISOString(),
		}];
		return { text: JSON.stringify(assessment("continue")), readReturns };
	});
	const result = await assessAndAdvanceOriginalObjective({ ...f, runner,
		persistReceipt: () => f.ws.writeRun(f.runRecord), assessmentAdmission: "admitted", advanceAdmission: () => "admitted",
		supportedTaskScopes: ["two-target-existing"], advance: async () => { dispatched++; } });
	assert.equal(result.stopReason, "objective-reassessment-pending");
	assert.equal(dispatched, 1);
	assert.equal([...runner.sessions.values()][0].turns, 3);
	assert.deepEqual(result.assessment?.unreadEvidence, []);
});

test("finite objective closure still requires original checks and complete selected evidence", async t => {
	const f = await fixture(t);
	const finite = createOriginalObjective({ goal: "Satisfy a finite synthetic acceptance target",
		goalSource: "user-intent-summary", inputNames: ["task.txt"],
		obligations: [{ id: "original-task", description: "Pass the exact original acceptance target" }],
		closure: "finite-evidence" });
	const checked = [{ obligationId: "original-task", passed: true,
		evidenceRefs: ["candidate.cpp", "verification.json"] }];
	const accepted = { ...assessment("fulfilled"), sessionId: "fresh-session", model: "fake/research",
		evidenceRead: ["original-objective.json", "candidate.cpp", "verification.json"], unreadEvidence: [] };
	const input = { boundedRuns: [{ runId: f.runRecord.runId, outcome: "fulfilled", selectedTaskId: "T001" }],
		selectedArtifacts: ["candidate.cpp", "verification.json"], assessment: accepted,
		stopReason: "original-checks-unverified" as const, originalChecks: checked };
	assert.equal(objectiveProgress(finite, { ...input, originalChecks: [] }).objectiveOutcome, "incomplete");
	assert.equal(objectiveProgress(finite, { ...input, assessment: { ...accepted,
		unreadEvidence: ["verification.json"], evidenceRead: ["original-objective.json", "candidate.cpp"] } }).objectiveOutcome, "incomplete");
	const fulfilled = objectiveProgress(finite, { ...input, pendingActionFacts: {} });
	assert.equal(fulfilled.objectiveOutcome, "fulfilled");
	assert.equal(fulfilled.continuation.pendingAction, undefined);
});

test("missing original input and changed frozen contract reject before a prompt or delegation", async t => {
	const missing = await fixture(t);
	await rm(missing.evidence.find(item => item.name === "second-text.txt")!.file);
	const runner = new FakeSessionRunner(() => ({ text: JSON.stringify(assessment("continue")), readReturns: ranges(missing) }));
	let delegated = false;
	const call = () => assessAndAdvanceOriginalObjective({ contract: missing.contract, contractFile: missing.contractFile,
		runner, sessionSpec: missing.sessionSpec, runRecord: missing.runRecord,
		persistReceipt: () => missing.ws.writeRun(missing.runRecord), evidenceRoot: missing.evidenceRoot,
		evidence: missing.evidence, assessmentAdmission: "admitted", advanceAdmission: () => "admitted",
		supportedTaskScopes: ["two-target-existing"], advance: async () => { delegated = true; } });
	await assert.rejects(call());
	assert.equal(runner.created.length, 0);
	assert.equal(delegated, false);
	const changed = await fixture(t);
	changed.contract.goal = "Silently narrowed goal";
	const changedRunner = new FakeSessionRunner(() => ({ text: JSON.stringify(assessment("continue")), readReturns: ranges(changed) }));
	await assert.rejects(assessAndAdvanceOriginalObjective({ contract: changed.contract, contractFile: changed.contractFile,
		runner: changedRunner, sessionSpec: changed.sessionSpec, runRecord: changed.runRecord,
		persistReceipt: () => changed.ws.writeRun(changed.runRecord), evidenceRoot: changed.evidenceRoot,
		evidence: changed.evidence, assessmentAdmission: "admitted", advanceAdmission: () => "admitted",
		supportedTaskScopes: ["two-target-existing"], advance: async () => { delegated = true; } }), /changed after freezing/);
	assert.equal(changedRunner.created.length, 0);
});

test("real host interruption and unsupported adapter scope retain model proposal without execution", async t => {
	for (const boundary of ["cancelled", "accounting-integrity-error"] as const) {
		const f = await fixture(t);
		const reply = { text: JSON.stringify(assessment("continue")), readReturns: ranges(f) };
		const before = await invoke(f, reply, { assessmentAdmission: boundary });
		assert.equal(before.result.stopReason, boundary);
		assert.equal(before.runner.created.length, 0);
		assert.equal(before.advanced.length, 0);
	}
	for (const boundary of ["cancelled", "accounting-integrity-error"] as const) {
		const f = await fixture(t);
		const after = await invoke(f, { text: JSON.stringify(assessment("continue")), readReturns: ranges(f) },
			{ advanceAdmission: boundary });
		assert.equal(after.result.stopReason, boundary);
		assert.deepEqual(after.result.assessment?.nextTask, assessment("continue").nextTask);
		assert.equal(after.advanced.length, 0);
	}
	const f = await fixture(t);
	const outside = assessment("continue", "outside-current-adapter");
	const unsupported = await invoke(f, { text: JSON.stringify(outside), readReturns: ranges(f) });
	assert.equal(unsupported.result.stopReason, "next-task-needs-capability");
	assert.deepEqual(unsupported.result.assessment?.nextTask, outside.nextTask);
	assert.equal(unsupported.advanced.length, 0);
});

test("a stale quota callback cannot halt a new original-objective assessment or dispatch", async t => {
	const f = await fixture(t);
	const runner = new FakeSessionRunner(() => ({ text: JSON.stringify(assessment("continue")),
		readReturns: ranges(f) }));
	let dispatched = 0;
	const result = await assessAndAdvanceOriginalObjective({ ...f, runner,
		persistReceipt: () => f.ws.writeRun(f.runRecord),
		assessmentAdmission: "time-boundary" as never,
		advanceAdmission: () => "provider-call-limit" as never,
		supportedTaskScopes: ["two-target-existing"],
		advance: async () => { dispatched++; return "synthetic-goal"; } });
	assert.equal(result.stopReason, "objective-reassessment-pending");
	assert.equal(dispatched, 1);
	let stepped = 0;
	const loop = await runOriginalObjectiveLoop({ admission: () => "budget-boundary" as never,
		step: async () => { stepped++; return { advanced: false,
			stopReason: "model-closure-unverified" as const }; } });
	assert.equal(stepped, 1);
	assert.equal(loop.stopReason, "model-closure-unverified");
	await assert.rejects(runOriginalObjectiveLoop({ admission: () => "admitted",
		step: async () => ({ advanced: false, stopReason: "no-progress" as never }) }),
		/retired quota boundary/);
});

test("an original objective can advance through multiple fresh assessed child attempts until a real boundary", async t => {
	const f = await fixture(t);
	let assessorCalls = 0;
	const runner = new FakeSessionRunner(() => {
		assessorCalls++;
		return { text: JSON.stringify({ ...assessment("continue"),
			nextTask: { objective: `Model-proposed bounded investigation ${assessorCalls}`,
				addresses: ["original-task"], adapterScope: "two-target-existing" } }),
			readReturns: ranges(f) };
	});
	const candidate = f.evidence.find(item => item.name === "candidate.cpp")!.file;
	const boundedRuns: Array<{ runId: string; outcome: string }> = [];
	const operatorCancellation = new AbortController();
	let dispatched = 0, terminalReason: string | undefined;
	for (let iteration = 1; ; iteration++) {
		const runRecord = iteration === 1 ? f.runRecord : await f.ws.startRun("M07Objective", []);
		const step = await assessAndAdvanceOriginalObjective({ contract: f.contract, contractFile: f.contractFile,
			runner, sessionSpec: { ...f.sessionSpec, label: `objective-assessor-${iteration}` }, runRecord,
			persistReceipt: () => f.ws.writeRun(runRecord), evidenceRoot: path.join(f.root, `assessment-evidence-${iteration}`),
			evidence: f.evidence, assessmentAdmission: operatorCancellation.signal.aborted ? "cancelled" : "admitted",
			advanceAdmission: () => "admitted", supportedTaskScopes: ["two-target-existing"],
			advance: async task => {
				dispatched++;
				assert.equal(task.objective, `Model-proposed bounded investigation ${dispatched}`);
				boundedRuns.push({ runId: `bounded-${dispatched}`, outcome: "fulfilled" });
				await writeFile(candidate, `// Synthetic child candidate ${dispatched}\n`);
				if (dispatched === 2) operatorCancellation.abort();
				return `bounded-${dispatched}`;
			} });
		if (!step.advanced) { terminalReason = step.stopReason; break; }
		assert.equal(step.stopReason, "objective-reassessment-pending");
		assert.equal(step.assessment?.decision, "continue");
	}
	assert.equal(assessorCalls, 2);
	assert.equal(dispatched, 2);
	assert.equal(runner.created.length, 2);
	assert(runner.created.every(spec => spec.tools.kind === "read-dir" && spec.role === "research"));
	assert.equal(await readFile(path.join(f.root, "assessment-evidence-1", "candidate.cpp"), "utf8"),
		originalInputs["candidate.cpp"]);
	assert.equal(await readFile(path.join(f.root, "assessment-evidence-2", "candidate.cpp"), "utf8"),
		"// Synthetic child candidate 1\n");
	assert.equal(terminalReason, "cancelled");
	const progress = objectiveProgress(f.contract, { boundedRuns, selectedArtifacts: ["candidate.cpp"],
		stopReason: "cancelled" });
	assert.equal(progress.contract.id, f.contract.id);
	assert.equal(progress.objectiveOutcome, "incomplete");
	assert.equal(progress.boundedRuns.length, 2);
});

test("the reusable objective loop refreshes evidence until an explicit cancellation", async () => {
	let latestEvidence = "initial", attempted = 0, admissions = 0;
	const operatorCancellation = new AbortController();
	const result = await runOriginalObjectiveLoop({
		admission: () => { admissions++; return operatorCancellation.signal.aborted ? "cancelled" : "admitted"; },
		step: async iteration => {
			attempted++;
			assert.equal(latestEvidence, iteration === 1 ? "initial" : "candidate-1");
			latestEvidence = `candidate-${iteration}`;
			if (iteration === 2) operatorCancellation.abort();
			return { advanced: true, stopReason: "objective-reassessment-pending", evidenceRefs: [latestEvidence] };
		} });
	assert.equal(attempted, 2);
	assert.equal(admissions, 3);
	assert.equal(latestEvidence, "candidate-2");
	assert.equal(result.stopReason, "cancelled");
	assert.deepEqual(result.steps.map(step => step.evidenceRefs), [["candidate-1"], ["candidate-2"]]);
});

test("the reusable objective loop returns an incomplete no-advance stage to the supervisor", async () => {
	for (const reason of ["model-reported-blocked", "model-closure-unverified",
		"assessment-invalid", "assessment-evidence-unread", "next-task-needs-capability",
		"assessment-evidence-suspended"] as const) {
		let calls = 0;
		const result = await runOriginalObjectiveLoop({ admission: () => "admitted",
			step: async () => { calls++; return { advanced: false, stopReason: reason, evidenceRefs: ["observed"] }; } });
		assert.equal(calls, 1, reason);
		assert.equal(result.stopReason, reason);
		assert.deepEqual(result.steps.map(step => step.evidenceRefs), [["observed"]]);
	}
	const operatorCancellation = new AbortController();
	const extended = await runOriginalObjectiveLoop({
		admission: () => operatorCancellation.signal.aborted ? "cancelled" : "admitted",
		step: async iteration => {
			if (iteration === 71) operatorCancellation.abort();
			return { advanced: true, stopReason: "objective-reassessment-pending",
				evidenceRefs: [`candidate-${iteration}`] };
		} });
	assert.equal(extended.stopReason, "cancelled");
	assert.equal(extended.steps.length, 71);
});

const availableCapabilities = [
	{ scope: "two-target-existing" as const, available: true, description: "Two existing bodies", limits: ["CPU only"] },
	{ scope: "registered-csr-experiment" as const, available: true, description: "Registered model-authored experiments", limits: ["Observed CPU capacity"] },
	{ scope: "outside-current-adapter" as const, available: false, description: "Unimplemented executor", limits: ["No verified executor"] },
];

test("unsupported model proposal replans in the same session and retains blocked work alongside feasible work", async t => {
	const f = await fixture(t);
	const blocked = { ...assessment("continue", "outside-current-adapter"),
		nextTask: { objective: "Inspect an optional unavailable instrument", addresses: ["original-task"], adapterScope: "outside-current-adapter" as const } };
	const feasible = { ...assessment("continue", "registered-csr-experiment"), unresolvedDetails: ["Evaluate feasible CPU alternatives"] };
	const runner = new FakeSessionRunner(({ turnIndex, message }) => {
		if (turnIndex === 2) assert.match(message, /Choose another feasible pending part/);
		return { text: JSON.stringify(turnIndex === 1 ? blocked : feasible), readReturns: turnIndex === 1 ? ranges(f) : [] };
	});
	let dispatched = 0;
	const result = await assessAndAdvanceOriginalObjective({ ...f, runner,
		persistReceipt: () => f.ws.writeRun(f.runRecord), assessmentAdmission: "admitted", advanceAdmission: () => "admitted",
		supportedTaskScopes: ["two-target-existing", "registered-csr-experiment"], capabilities: availableCapabilities,
		advance: async proposal => { dispatched++; assert.equal(proposal.adapterScope, "registered-csr-experiment"); return proposal; } });
	assert.equal(runner.created.length, 1, "capability replanning must keep the same frozen evidence and live assessment session");
	assert.equal(dispatched, 1);
	assert.equal(result.assessment?.proposalHistory?.length, 2);
	assert.deepEqual(result.assessment?.blockedProposals, [blocked.nextTask]);
	const checkpoint = objectiveProgress(f.contract, { boundedRuns: [], selectedArtifacts: [], assessment: result.assessment,
		stopReason: result.stopReason, nextTaskDispatched: true });
	assert.equal(checkpoint.objectiveOutcome, "incomplete");
	assert.ok(checkpoint.continuation.unresolvedDetails.includes(blocked.nextTask.objective));
	assert.deepEqual(checkpoint.continuation.blockedProposals, [blocked.nextTask]);
});

test("repeated blocked verdicts use a fresh assessor before dispatching a feasible task", async t => {
	const f = await fixture(t);
	let prompts = 0, dispatches = 0;
	const runner = new FakeSessionRunner(({ message, turnIndex, userMessages }) => {
		prompts++;
		if (prompts === 2) {
			assert.match(message, /Reassess every remaining requirement/);
			assert.match(message, /original-task: Satisfy all original supplied requirements/);
		}
		if (prompts === 3) {
			assert.equal(turnIndex, 1);
			assert.equal(userMessages.length, 1);
			assert.match(message, /Original objective \(unchanged\)/);
			assert.doesNotMatch(message, /blocked verdict remains provisional/);
		}
		return { text: JSON.stringify(assessment(prompts === 3 ? "continue" : "blocked")),
			readReturns: prompts === 2 ? [] : ranges(f) };
	});
	const result = await assessAndAdvanceOriginalObjective({ ...f, runner,
		persistReceipt: () => f.ws.writeRun(f.runRecord), assessmentAdmission: "admitted", advanceAdmission: () => "admitted",
		supportedTaskScopes: ["two-target-existing"], capabilities: availableCapabilities,
		advance: async () => { dispatches++; } });
	assert.equal(prompts, 3);
	assert.equal(dispatches, 1);
	assert.equal(runner.created.length, 2);
	assert.equal(result.assessment?.proposalHistory?.length, 3);
	assert.equal(result.stopReason, "objective-reassessment-pending");
});

test("transport failure after a blocked assessment retains its prior checkpoint without dispatch", async t => {
	const f = await fixture(t);
	let recorded = 0;
	const runner = new FakeSessionRunner(({ turnIndex }) => {
		if (turnIndex === 1) return { text: JSON.stringify(assessment("blocked")), readReturns: ranges(f) };
		throw new Error("synthetic provider transport failure");
	});
	const result = await assessAndAdvanceOriginalObjective({ ...f, runner,
		persistReceipt: () => f.ws.writeRun(f.runRecord), assessmentAdmission: "admitted", advanceAdmission: () => "admitted",
		supportedTaskScopes: ["two-target-existing"], capabilities: availableCapabilities,
		recordAssessment: async () => { recorded++; },
		advance: async () => { throw new Error("must not dispatch"); } });
	assert.equal(result.stopReason, "assessment-failed");
	assert.equal(result.assessment?.decision, "blocked");
	assert.equal(recorded, 1);
	assert.equal(runner.created.length, 1);
	assert.equal([...runner.sessions.values()][0].turns, 2);
});

test("repeated unsupported proposals replace context before a feasible task is chosen", async t => {
	const f = await fixture(t);
	let calls = 0;
	const runner = new FakeSessionRunner(({ message, turnIndex }) => {
		calls++;
		if (calls === 3) {
			assert.equal(turnIndex, 1);
			assert.match(message, /Original objective \(unchanged\)/);
		}
		return { text: JSON.stringify(assessment("continue", calls < 3 ? "registered-csr-experiment" : "two-target-existing")), readReturns: ranges(f) };
	});
	let dispatched = false;
	const result = await assessAndAdvanceOriginalObjective({ ...f, runner,
		persistReceipt: () => f.ws.writeRun(f.runRecord), assessmentAdmission: "admitted", advanceAdmission: () => "admitted",
		supportedTaskScopes: ["two-target-existing", "registered-csr-experiment"], capabilities: availableCapabilities.slice(0, 1),
		advance: async task => { assert.equal(task.adapterScope, "two-target-existing"); dispatched = true; } });
	assert.equal(dispatched, true);
	assert.equal(calls, 3);
	assert.equal(runner.created.length, 2);
	assert.equal(result.stopReason, "objective-reassessment-pending");
	assert.equal(result.assessment?.proposalHistory?.length, 3);
	assert.equal(objectiveProgress(f.contract, { boundedRuns: [], selectedArtifacts: [], assessment: result.assessment,
		stopReason: result.stopReason }).objectiveOutcome, "incomplete");
});

test("unchanged unsupported proposal after fresh reread remains repair-needed with no executable next task", async t => {
	const f = await fixture(t);
	const repairs: WorkflowRepairStateV1[] = [];
	let calls = 0, dispatches = 0;
	const runner = new FakeSessionRunner(() => {
		calls++;
		const proposal = assessment("continue", "outside-current-adapter");
		proposal.rationale = `Changed rationale ${calls} does not supply a capability`;
		if (calls === 2) proposal.nextTask!.objective = "Different prose still requests the same unavailable adapter";
		return { text: JSON.stringify(proposal, null, calls === 2 ? 2 : undefined), readReturns: ranges(f) };
	});
	const result = await assessAndAdvanceOriginalObjective({ ...f, runner,
		persistReceipt: () => f.ws.writeRun(f.runRecord), assessmentAdmission: "admitted", advanceAdmission: () => "admitted",
		supportedTaskScopes: ["two-target-existing"], capabilities: availableCapabilities,
		recordRepairState: async state => { repairs.push(state); }, advance: async () => { dispatches++; } });
	assert.equal(result.stopReason, "workflow-repair-needed");
	assert.equal(calls, 3);
	assert.equal(runner.created.length, 2);
	assert.equal(dispatches, 0);
	assert.deepEqual(repairs.map(item => item.strategy),
		["same-session-feedback", "fresh-context", "workflow-repair-needed"]);
	assert.equal(repairs[0].responseFingerprint, repairs[1].responseFingerprint);
	assert.equal(repairs[1].evidenceFingerprint, repairs[2].evidenceFingerprint);
	assert.equal(result.assessment?.proposalHistory?.length, 3);
	assert.ok(result.assessment?.nextTask, "stale proposal remains available as assessment context");
	const checkpoint = objectiveProgress(f.contract, { boundedRuns: [], selectedArtifacts: [],
		assessment: result.assessment, stopReason: result.stopReason, pendingActionFacts: {} });
	assert.equal(checkpoint.objectiveOutcome, "incomplete");
	assert.equal(checkpoint.continuation.nextTask, undefined);
	assert.equal(checkpoint.continuation.pendingAction?.kind, "repair-workflow-state");
	assert.equal(checkpoint.continuation.pendingAction?.humanRequired, undefined);
	assert.throws(() => objectiveProgress(f.contract, { boundedRuns: [], selectedArtifacts: [],
		stopReason: result.stopReason, pendingAction: { ...checkpoint.continuation.pendingAction!, kind: "fresh-m07-task" } }),
		/required stage repair/);
	assert.throws(() => objectiveProgress(f.contract, { boundedRuns: [], selectedArtifacts: [],
		stopReason: result.stopReason, pendingAction: { ...checkpoint.continuation.pendingAction!, humanRequired: true,
			verifiedHumanBlocker: { kind: "input-unavailable", verifiedBy: "host", evidenceRef: "host-check", exclusiveRequiredAction: true } } }),
		/workflow repair|human gate/);
});

test("a changed addressed obligation permits its own fresh repair strategy without a session quota", async t => {
	const f = await fixture(t);
	f.contract = { ...f.contract, obligations: [...f.contract.obligations,
		{ id: "second-task", description: "Resolve a second independently open requirement" }] };
	await writeFile(f.contractFile, `${JSON.stringify(f.contract, null, 2)}\n`);
	const repairs: WorkflowRepairStateV1[] = [];
	let calls = 0, dispatches = 0;
	const runner = new FakeSessionRunner(({ turnIndex }) => {
		calls++;
		const proposal = assessment("continue", calls === 5 ? "two-target-existing" : "outside-current-adapter");
		proposal.unresolvedObligations = ["original-task", "second-task"];
		proposal.nextTask!.addresses = [calls < 3 ? "original-task" : "second-task"];
		if (calls === 3 || calls === 5) assert.equal(turnIndex, 1);
		return { text: JSON.stringify(proposal), readReturns: ranges(f) };
	});
	const result = await assessAndAdvanceOriginalObjective({ ...f, runner,
		persistReceipt: () => f.ws.writeRun(f.runRecord), assessmentAdmission: "admitted", advanceAdmission: () => "admitted",
		supportedTaskScopes: ["two-target-existing"], capabilities: availableCapabilities,
		recordRepairState: async state => { repairs.push(state); }, advance: async () => { dispatches++; } });
	assert.equal(result.stopReason, "objective-reassessment-pending");
	assert.equal(dispatches, 1);
	assert.equal(runner.created.length, 3);
	assert.deepEqual(repairs.map(item => item.strategy),
		["same-session-feedback", "fresh-context", "same-session-feedback", "fresh-context"]);
	assert.deepEqual(repairs.map(item => item.sessionGeneration), [1, 2, 2, 3]);
	assert.notEqual(repairs[1].planFingerprint, repairs[2].planFingerprint);
});

test("cycling unsupported host states receives a fresh strategy even without adjacent identical replies", async t => {
	const f = await fixture(t);
	const repairs: WorkflowRepairStateV1[] = [];
	let calls = 0;
	const runner = new FakeSessionRunner(({ turnIndex }) => {
		calls++;
		if (calls === 4) assert.equal(turnIndex, 1);
		const scope = calls === 2 ? "registered-csr-experiment" : "outside-current-adapter";
		return { text: JSON.stringify(assessment("continue", scope)), readReturns: ranges(f) };
	});
	const result = await assessAndAdvanceOriginalObjective({ ...f, runner,
		persistReceipt: () => f.ws.writeRun(f.runRecord), assessmentAdmission: "admitted", advanceAdmission: () => "admitted",
		supportedTaskScopes: ["two-target-existing"], capabilities: availableCapabilities.slice(0, 1),
		recordRepairState: async state => { repairs.push(state); }, advance: async () => { throw new Error("must not dispatch"); } });
	assert.equal(result.stopReason, "workflow-repair-needed");
	assert.equal(calls, 4);
	assert.equal(runner.created.length, 2);
	assert.deepEqual(repairs.map(item => item.strategy),
		["same-session-feedback", "same-session-feedback", "fresh-context", "workflow-repair-needed"]);
});

test("current user override accompanies an unchanged legacy frozen contract", async t => {
	const f = await fixture(t);
	const frozen = await readFile(f.contractFile, "utf8");
	assert.equal(f.contract.userOverrides, undefined);
	const override = "Deliver source and machine-readable evidence only; omit prose deliverables.";
	const runner = new FakeSessionRunner(({ message }) => {
		assert.match(message, /User overrides \(higher priority than supplied task material\)/);
		assert.ok(message.includes(override));
		return { text: JSON.stringify(assessment("continue")), readReturns: ranges(f) };
	});
	await assessAndAdvanceOriginalObjective({ ...f, runner,
		persistReceipt: () => f.ws.writeRun(f.runRecord), assessmentAdmission: "admitted", advanceAdmission: () => "admitted",
		supportedTaskScopes: ["two-target-existing"], capabilities: availableCapabilities, userOverrides: [override],
		advance: async () => {} });
	assert.equal(await readFile(f.contractFile, "utf8"), frozen);
	assert.equal(await readFile(path.join(f.evidenceRoot, "original-objective.json"), "utf8"), frozen);
});

test("objective core dispatches an unrelated adapter and caller-owned artifact names without task-shape changes", async t => {
	const f = await fixture(t);
	const evidence = [{ name: "suite-contract.json", file: f.evidence[0].file },
		{ name: "candidate-module.py", file: f.evidence[1].file },
		{ name: "external-evaluator-result.json", file: f.evidence[4].file }];
	const content = { "original-objective.json": `${JSON.stringify(f.contract, null, 2)}\n`,
		"suite-contract.json": originalInputs["original-problem.txt"], "candidate-module.py": originalInputs["original-source.cpp"],
		"external-evaluator-result.json": originalInputs["verification.json"] };
	const proposal = { ...assessment("continue", "external-evaluator.v2"),
		evidenceRefs: ["candidate-module.py", "external-evaluator-result.json"] };
	const runner = new FakeSessionRunner(({ message }) => {
		assert.doesNotMatch(message, /candidate\.cpp|verification\.json|two-target|registered-csr/);
		return { text: JSON.stringify(proposal), readReturns: Object.entries(content).map(([name, body]) => ({
			toolName: "objective_evidence_read", status: "returned", path: name, requested: {},
			returned: { kind: "text", startLine: 1, endLine: lines(body), truncated: false }, at: new Date().toISOString(),
		})) };
	});
	let received: unknown;
	const result = await assessAndAdvanceOriginalObjective({ ...f, evidence, runner,
		evidenceRequirements: { requiredNames: evidence.map(item => item.name), instructions: "Use the external evaluator contract and its native result schema." },
		persistReceipt: () => f.ws.writeRun(f.runRecord), assessmentAdmission: "admitted", advanceAdmission: () => "admitted",
		supportedTaskScopes: ["external-evaluator.v2"], capabilities: [{ scope: "external-evaluator.v2", available: true,
			description: "Existing evaluator supplied by the caller", limits: ["Native evaluator contract controls acceptance"] }],
		advance: async task => { received = task; return "evaluated"; } });
	assert.equal(result.advanced, "evaluated");
	assert.deepEqual(received, proposal.nextTask);
	assert.equal(result.stopReason, "objective-reassessment-pending");
});
