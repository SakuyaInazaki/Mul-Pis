import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import test, { type TestContext } from "node:test";
import { assessAndAdvanceOriginalObjective, classifyPendingAction, createOriginalObjective, objectiveProgress,
	runOriginalObjectiveLoop, writeObjectiveProgress,
	writeOriginalObjectiveContract } from "../src/m07/objective-progress.ts";
import { readObjectiveCheckpointFile } from "../src/m07/objective-checkpoint-store.ts";
import type { CurrentObjectiveStopReason, ModelObjectiveAssessmentV1,
	ObjectiveNextTaskV1 } from "../src/m07/objective-progress.ts";
import { FakeSessionRunner, type FakeReply } from "../src/runner/fake.ts";
import type { ReadReturnEvent, SessionHandle, SessionSpec } from "../src/runner/types.ts";
import type { WorkflowRepairStateV1 } from "../src/runner/repair-liveness.ts";
import { Workspace } from "../src/workspace.ts";
import { HarnessError } from "../src/types.ts";
import type { GroundedAssessmentProposal } from "../src/m07/assessor-grounding.ts";
import { offlineChecks } from "../scripts/manual-private-campaign.ts";

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

test("historical accepted grounded checkpoint reopens byte-exact without a new source binding", async t => {
	const f = await fixture(t);
	const span = { sourceId: "prior-research-history.json", startLine: 1, endLine: 1 };
	const settledIssue = { id: "settled", claim: "A historical claim was resolved",
		status: "resolved" as const, classification: "necessary-verification" as const,
		sourceRefs: [span], implication: "Retained as authenticated prior state",
		claimAtRisk: "A prior claim", resolution: { explanation: "Previously accepted",
			evidenceRefs: [span] } };
	const openIssue = { id: "pending", claim: "An original obligation remains open",
		status: "open" as const, classification: "explicit-requirement" as const,
		sourceRefs: [{ sourceId: "original-problem.txt", startLine: 1, endLine: 1 }],
		implication: "A later bounded task may change the result" };
	const oldTask = { objective: "Continue the original goal", obligationIds: ["original-task"],
		addresses: ["pending"], adapterScope: "two-target-existing",
		decisionChangingHypothesis: "More evidence may change the answer",
		expectedEvidence: "A bounded check", sourceRefs: openIssue.sourceRefs };
	const priorAssessment = { ...assessment("continue"), unresolvedDetails: [openIssue.claim],
		groundedAssessment: { version: 1 as const, kind: "grounded-assessment-proposal" as const,
			contractId: f.contract.id, missionStatus: "open" as const,
			issues: [settledIssue, openIssue], legacyOpenDetails: [], nextTask: oldTask },
		sessionId: "old-assessor", model: "fake/research", evidenceRead: [], unreadEvidence: [] };
	const progress = objectiveProgress(f.contract, { boundedRuns: [], selectedArtifacts: [],
		assessment: priorAssessment, stopReason: "assessment-validation-pending" });
	const file = path.join(f.root, "objective-checkpoint.json");
	await writeObjectiveProgress(file, progress);
	const exact = `${JSON.stringify(progress, null, 2)}\n`;
	assert.equal(await readObjectiveCheckpointFile(file), exact);
	const reopened = JSON.parse(await readObjectiveCheckpointFile(file));
	assert.deepEqual(reopened.assessment.groundedAssessment.issues[0], settledIssue);
	assert.equal(reopened.assessment.groundedAssessment.nextTask.sourceBinding, undefined);
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

test("missing chosen attempt gets same-session correction while missing selected baseline suspends", async t => {
	const f = await fixture(t);
	const reply = assessment("continue");
	let prompts = 0, prepares = 0, dispatches = 0;
	const messages: string[] = [];
	const runner = new FakeSessionRunner(({ message }) => { prompts++; messages.push(message);
		return { text: JSON.stringify(reply), ...(prompts === 1 ? { readReturns: ranges(f) } : {}) }; });
	const base = { ...f, runner, persistReceipt: () => f.ws.writeRun(f.runRecord),
		assessmentAdmission: "admitted" as const, advanceAdmission: () => "admitted" as const,
		supportedTaskScopes: ["two-target-existing"],
		advance: async () => { dispatches++; } };
	const corrected = await assessAndAdvanceOriginalObjective({ ...base,
		prepareNextTask: async () => ({ status: ++prepares === 1 ? "missing" : "ready" }) });
	assert.equal(corrected.stopReason, "objective-reassessment-pending");
	assert.equal(prompts, 2);
	assert.equal(runner.created.length, 1);
	assert.equal(dispatches, 1);
	assert.match(messages[1]!, /cannot be dispatched/);
	const suspended = await fixture(t);
	let secondPrompts = 0, secondDispatches = 0;
	const second = new FakeSessionRunner(() => { secondPrompts++;
		return { text: JSON.stringify(reply), readReturns: ranges(suspended) }; });
	const result = await assessAndAdvanceOriginalObjective({ ...suspended, runner: second,
		persistReceipt: () => suspended.ws.writeRun(suspended.runRecord),
		assessmentAdmission: "admitted", advanceAdmission: () => "admitted",
		supportedTaskScopes: ["two-target-existing"],
		prepareNextTask: async () => ({ status: "selected-evidence-unavailable" }),
		advance: async () => { secondDispatches++; } });
	assert.equal(result.stopReason, "assessment-evidence-suspended");
	assert.equal(secondPrompts, 1);
	assert.equal(secondDispatches, 0);
	const unresolved = Array.from({ length: 5 }, (_, index) => `goal/O00${index + 1}`);
	const checkpoint = objectiveProgress(suspended.contract, { boundedRuns: [], selectedArtifacts: [],
		stopReason: result.stopReason, unresolvedOperationIds: unresolved,
		pendingActionFacts: { unresolvedOperationRefs: unresolved } });
	assert.deepEqual(checkpoint.continuation.pendingAction?.target?.operationRefs, unresolved);
	assert.equal(checkpoint.continuation.pendingAction?.safety, "no-replay-until-reconciled");
});

test("essential task-source diagnostic sink failure prevents another paid assessor turn", async t => {
	const f = await fixture(t);
	let prompts = 0, dispatches = 0;
	const runner = new FakeSessionRunner(() => { prompts++;
		return { text: JSON.stringify(assessment("continue")), readReturns: ranges(f) }; });
	await assert.rejects(assessAndAdvanceOriginalObjective({ ...f, runner,
		persistReceipt: () => f.ws.writeRun(f.runRecord), assessmentAdmission: "admitted",
		advanceAdmission: () => "admitted", supportedTaskScopes: ["two-target-existing"],
		prepareNextTask: async () => {
			await offlineChecks.writeTaskSourceDiagnostic(f.root, 1, 1,
				"selected-verification.json", "a".repeat(64),
				{ status: "io-error", cause: "os", errno: "EACCES" },
				async () => { throw Object.assign(new Error("private path detail"), { code: "ENOSPC" }); });
			return { status: "ready" };
		},
		advance: async () => { dispatches++; } }), error =>
			error instanceof Error && error.message.includes("writerErrno=ENOSPC") &&
			!error.message.includes("private path detail"));
	assert.equal(prompts, 1);
	assert.equal(dispatches, 0);
});

test("many archived attempts stay on demand while chosen unselected source, feedback and catalog part need full read", async t => {
	const f = await fixture(t);
	const hash = (text: string) => createHash("sha256").update(text).digest("hex");
	const selected = { kind: "selected" as const, sourceSha256: hash(originalInputs["candidate.cpp"]!) };
	const attempts: Array<{ kind: "unselected-attempt"; attemptId: string; sourceSha256: string;
		planSha256: string }> = [];
	const attemptEvidence: Record<string, { source: string; verification: string; archive: string;
		plan: string; catalogPart: string; catalogLine?: number; catalogRowSha256?: string }> = {};
	const bodies: Record<string, string> = {};
	for (let i = 1; i <= 25; i++) {
		const id = `R${i}:T1`, prefix = `task-attempt-${i}`;
		const names = { source: `${prefix}-source.cpp`, verification: `${prefix}-verification.json`,
			archive: `${prefix}-archive.json`, plan: `${prefix}-plan.json`,
			catalogPart: "task-source-binding-part-1.jsonl" };
		attemptEvidence[id] = names;
		bodies[names.source] = `// attempt ${i} line 1\n// attempt ${i} line 2\n`;
		bodies[names.verification] = `{"passed":true,"attempt":${i}}\n{"feedback":"bounded"}\n`;
		bodies[names.archive] = `{"task":"${id}","status":"accepted"}\n`;
		bodies[names.plan] = `{"plan":"${id}"}\n{"scope":"bounded"}\n`;
		attempts.push({ kind: "unselected-attempt", attemptId: id,
			sourceSha256: hash(bodies[names.source]!), planSha256: hash(bodies[names.plan]!) });
	}
	const catalogRows = attempts.map((item, index) => {
		const named = attemptEvidence[item.attemptId]!;
		const row = JSON.stringify({ sourceBinding: item, evidenceNames: {
			source: named.source, verification: named.verification,
			archive: named.archive, plan: named.plan },
			authority: "unselected-development-evidence" });
		named.catalogLine = index + 1;
		named.catalogRowSha256 = hash(row);
		return row;
	});
	bodies["task-source-binding-part-1.jsonl"] = catalogRows.join("\n") + "\n";
	bodies["task-source-bindings.json"] = JSON.stringify({ version: 1,
		kind: "task-source-bindings-index", scope: "current-run-host-archive-only", selected,
		parts: [{ name: "task-source-binding-part-1.jsonl", firstAttemptId: "R1:T1",
			lastAttemptId: "R25:T1" }],
		attemptLocator: Object.fromEntries(attempts.map(item => [item.attemptId,
			{ part: attemptEvidence[item.attemptId]!.catalogPart,
				line: attemptEvidence[item.attemptId]!.catalogLine,
				rowSha256: attemptEvidence[item.attemptId]!.catalogRowSha256 }])) }) + "\n";
	for (const [name, body] of Object.entries(bodies)) {
		const file = path.join(f.root, "source", name);
		await writeFile(file, body);
		f.evidence.push({ name, file });
	}
	const chosen = attempts[23]!;
	const names = attemptEvidence[chosen.attemptId]!;
	const sourceRefs = ["original-problem.txt", names.source, names.verification, names.archive]
		.map(sourceId => ({ sourceId, startLine: 1, endLine: 1 }));
	sourceRefs.push({ sourceId: names.catalogPart, startLine: names.catalogLine!,
		endLine: names.catalogLine! });
	const reply = { version: 1, decision: "continue", rationale: "An unselected attempt warrants a fresh check.",
		evidenceRefs: ["candidate.cpp", "verification.json"],
		unresolvedObligations: ["original-task"], unresolvedDetails: ["The original objective remains open."],
		groundedAssessment: { version: 1, kind: "grounded-assessment-proposal",
			contractId: f.contract.id, missionStatus: "open",
			legacyOpenDetails: [], issues: [{ id: "open-check", claim: "The original objective remains open.",
				status: "open", classification: "explicit-requirement",
				sourceRefs: [{ sourceId: "original-problem.txt", startLine: 1, endLine: 1 }],
				implication: "More evidence may change the result." }],
			nextTask: { objective: "Extend the exact frozen unselected attempt", obligationIds: ["original-task"],
				addresses: ["open-check"], adapterScope: "two-target-existing",
				decisionChangingHypothesis: "The revision could improve the selected result.",
				expectedEvidence: "Fresh independent comparison", sourceRefs, sourceBinding: chosen } } };
	const fullRead = (name: string): ReadReturnEvent => ({ toolName: "objective_evidence_read",
		status: "returned", path: name, requested: {}, returned: { kind: "text", startLine: 1,
			endLine: lines(bodies[name]!), truncated: false }, at: new Date().toISOString() });
	const requests: string[] = [];
	const runner = new FakeSessionRunner(({ message }) => {
		requests.push(message);
		return { text: JSON.stringify(reply), readReturns: requests.length === 1 ?
			[...ranges(f), fullRead("task-source-bindings.json"),
				fullRead(names.source), fullRead(names.verification), fullRead(names.archive),
				fullRead(names.plan)] :
			[{ toolName: "objective_evidence_read", status: "returned",
				path: names.catalogPart, requested: {}, returned: { kind: "text",
					startLine: names.catalogLine, endLine: names.catalogLine,
					truncated: false }, at: new Date().toISOString() }] };
	});
	let delegated = 0;
	const staged = path.join(f.root, "chosen-task-input.cpp");
	const result = await assessAndAdvanceOriginalObjective({ ...f, runner,
		evidenceAccess: Object.fromEntries(Object.keys(bodies).map(name => [name,
			name === "task-source-bindings.json" ? "required" : "retrievable"])) as Record<string, "required" | "retrievable">,
		groundingPolicy: { require: true, legacyOpenDetails: [], previousIssues: [],
			sourceKinds: Object.fromEntries(f.evidence.map(item => [item.name,
				item.name === "task-source-bindings.json" || item.name === names.catalogPart ? "host-control" :
				item.name.startsWith("task-attempt-") ? "unselected-evidence" :
				["candidate.cpp", "verification.json"].includes(item.name) ? "selected-evidence" :
				"supplied-task"])),
			taskSourceBindings: { selected, attempts, attemptEvidence,
				catalogSha256: hash(bodies["task-source-bindings.json"]!) } },
		capabilities: [{ scope: "two-target-existing", available: true,
			description: "Synthetic bounded adapter", limits: [] }],
		persistReceipt: () => f.ws.writeRun(f.runRecord), assessmentAdmission: "admitted",
		advanceAdmission: () => "admitted", supportedTaskScopes: ["two-target-existing"],
		prepareNextTask: async task => {
			assert.deepEqual(task.sourceBinding, chosen);
			await writeFile(staged, await readFile(path.join(f.evidenceRoot, names.source)));
			assert.equal(hash((await readFile(staged)).toString()), chosen.sourceSha256);
			return { status: "ready" };
		},
		advance: async task => { delegated++;
			assert.deepEqual(task.sourceBinding, chosen);
			assert.deepEqual(await readFile(staged), Buffer.from(bodies[names.source]!));
			assert.deepEqual(await readFile(path.join(f.root, "source", "candidate.cpp")),
				Buffer.from(originalInputs["candidate.cpp"]!));
		} });
	assert.equal(result.stopReason, "objective-reassessment-pending");
	assert.equal(delegated, 1);
	assert.equal(requests.length, 2);
	assert.match(requests[1]!, /task-source-binding-part-1\.jsonl/);
	assert.doesNotMatch(requests[1]!, new RegExp(`${names.plan.replaceAll(".", "\\.")}: objective_evidence_read`),
		"the chosen plan was fully read; only its catalog row needs correction");
	assert.ok(!result.assessment?.evidenceRead.includes("task-attempt-1-source.cpp"),
		"unselected alternatives stay retrievable without forced reading");
});

test("production source catalog admits zero and one attempt but rejects spoofed locator before a prompt", async t => {
	for (const count of [0, 1]) {
		const f = await fixture(t);
		const hash = (bytes: string) => createHash("sha256").update(bytes).digest("hex");
		const selected = { kind: "selected" as const,
			sourceSha256: hash(originalInputs["candidate.cpp"]!) };
		const attempts: Array<{ binding: { kind: "unselected-attempt"; attemptId: string;
			sourceSha256: string; planSha256: string }; source: { file: string; sha256: string };
			verification: { file: string; sha256: string }; archive: { file: string; sha256: string };
			plan: { file: string; sha256: string } }> = [];
		const evidenceNames: Record<string, { source: string; verification: string;
			archive: string; plan: string; catalogPart?: string;
			catalogLine?: number; catalogRowSha256?: string }> = {};
		if (count) {
			const files = { source: ["task-attempt-1-source.cpp", "// unselected\n"],
				verification: ["task-attempt-1-verification.json", "{\"passed\":true}\n"],
				archive: ["task-attempt-1-archive.json", "{\"review\":\"accepted\"}\n"],
				plan: ["task-attempt-1-plan.json", "{\"case\":1}\n"] } as const;
			const paths: Record<string, { file: string; sha256: string }> = {};
			for (const [kind, [name, body]] of Object.entries(files)) {
				const file = path.join(f.root, "source", name);
				await writeFile(file, body);
				f.evidence.push({ name, file });
				paths[kind] = { file, sha256: hash(body) };
			}
			const binding = { kind: "unselected-attempt" as const, attemptId: "R1:T1",
				sourceSha256: paths.source!.sha256, planSha256: paths.plan!.sha256 };
			attempts.push({ binding, source: paths.source!, verification: paths.verification!,
				archive: paths.archive!, plan: paths.plan! });
			evidenceNames[binding.attemptId] = {
				source: files.source[0], verification: files.verification[0],
				archive: files.archive[0], plan: files.plan[0] };
		}
		const dir = path.join(f.root, "catalog");
		await mkdir(dir);
		const catalog = await offlineChecks.writeTaskSourceCatalog(dir, selected, attempts,
			evidenceNames);
		for (const item of catalog.evidence) f.evidence.push(item);
		for (const [id, locator] of Object.entries(catalog.attemptLocator))
			Object.assign(evidenceNames[id]!, { catalogPart: locator.part,
				catalogLine: locator.line, catalogRowSha256: locator.rowSha256 });
		const index = JSON.parse(await readFile(catalog.evidence[0]!.file, "utf8"));
		assert.equal(index.kind, "task-source-bindings-index");
		assert.equal(index.parts.length, count);
		let prompts = 0;
		const run = async (evidence: typeof evidenceNames) => {
			const runner = new FakeSessionRunner(() => { prompts++;
				return { text: "invalid", readReturns: [...ranges(f), {
					toolName: "objective_evidence_read", status: "returned",
					path: "task-source-bindings.json", requested: {},
					returned: { kind: "text", startLine: 1, endLine: 1, truncated: false },
					at: new Date().toISOString() }] }; });
			return assessAndAdvanceOriginalObjective({ ...f, runner,
				evidenceAccess: Object.fromEntries(catalog.evidence.slice(1).map(item =>
					[item.name, "retrievable" as const])),
				groundingPolicy: { require: true, legacyOpenDetails: [], previousIssues: [],
					sourceKinds: Object.fromEntries(f.evidence.map(item => [item.name,
						item.name === "task-source-bindings.json" || item.name.includes("binding-part") ?
							"host-control" : item.name.startsWith("task-attempt-") ?
							"unselected-evidence" : ["candidate.cpp", "verification.json"].includes(item.name) ?
							"selected-evidence" : "supplied-task"])),
					taskSourceBindings: { selected, attempts: attempts.map(item => item.binding),
						attemptEvidence: evidence,
						catalogSha256: hash(await readFile(catalog.evidence[0]!.file, "utf8")) } },
				persistReceipt: () => f.ws.writeRun(f.runRecord), assessmentAdmission: "admitted",
				advanceAdmission: () => "cancelled", supportedTaskScopes: ["two-target-existing"],
				advance: async () => { throw new Error("invalid reply cannot dispatch"); } });
		};
		assert.equal((await run(evidenceNames)).stopReason, "cancelled");
		assert.equal(prompts, 1);
		if (count) {
			const spoof = structuredClone(evidenceNames);
			spoof["R1:T1"]!.catalogPart = "task-source-binding-part-999.jsonl";
			await assert.rejects(run(spoof), /catalog locator differs/);
			assert.equal(prompts, 1, "spoofed part is rejected before a paid assessor prompt");
		}
	}
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
			objective: base.nextTask!.objective,
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

test("a prior 84-character grounded issue ID survives indexed assessment and read repair", async t => {
	const f = await fixture(t);
	const issueId = `issue-${"a".repeat(78)}`;
	assert.equal(issueId.length, 84);
	const issue: GroundedAssessmentProposal["issues"][number] = {
		id: issueId, claim: "An original requirement still needs an independent check.",
		status: "open", classification: "explicit-requirement",
		implication: "A new check can change the selected answer.",
		sourceRefs: [{ sourceId: "original-problem.txt", startLine: 1, endLine: 1 }] };
	const prior = await addPriorGroundingIndex(f, [], [issue]);
	const nextTask = { objective: "Run a synthetic independent check", obligationIds: ["original-task"],
		addresses: [issueId], adapterScope: "two-target-existing",
		decisionChangingHypothesis: "The new check could change candidate selection.",
		expectedEvidence: "Independent machine check",
		sourceRefs: [{ sourceId: "original-problem.txt", startLine: 1, endLine: 1 }] };
	const reply = { version: 1, decision: "continue", rationale: "Continue the original requirement",
		evidenceRefs: ["candidate.cpp", "verification.json"], unresolvedObligations: ["original-task"],
		groundedAssessmentDelta: { version: 1, kind: "grounded-assessment-delta",
			newIssues: [], resolutions: [], nextTask } };
	let prompts = 0;
	const dispatched: ObjectiveNextTaskV1[] = [];
	const exceptions: Array<{ stage: string; error: unknown }> = [];
	const runner = new FakeSessionRunner(({ message }) => {
		prompts++;
		assert.equal(dispatched.length, 0, "unread selected evidence cannot authorize dispatch");
		if (prompts === 1) return { text: JSON.stringify(reply),
			readReturns: [...ranges(f, ["verification.json"]), prior.indexRead] };
		assert.match(message, /verification\.json/);
		return { text: JSON.stringify(reply),
			readReturns: ranges(f).filter(item => item.path === "verification.json") };
	});
	const result = await assessAndAdvanceOriginalObjective({ ...f, runner,
		evidenceAccess: prior.access,
		groundingPolicy: { require: true, sourceKinds: prior.sourceKinds,
			legacyOpenDetails: [], previousIssues: [issue],
			priorGroundingIndex: prior.priorGroundingIndex },
		capabilities: [{ scope: "two-target-existing", available: true,
			description: "Synthetic independent check", limits: [] }],
		recordException: (stage, error) => { exceptions.push({ stage, error }); },
		persistReceipt: () => f.ws.writeRun(f.runRecord), assessmentAdmission: "admitted",
		advanceAdmission: () => "admitted", supportedTaskScopes: ["two-target-existing"],
		advance: async task => { dispatched.push(task); } });
	assert.equal(result.stopReason, "objective-reassessment-pending");
	assert.equal(prompts, 2);
	assert.equal(runner.created.length, 1);
	assert.deepEqual(exceptions, []);
	assert.deepEqual(dispatched, [{ objective: nextTask.objective,
		addresses: nextTask.obligationIds, adapterScope: nextTask.adapterScope }]);
	assert.deepEqual(result.assessment?.groundedAssessment?.issues, [issue]);
	assert.deepEqual(result.assessment?.groundedAssessment?.nextTask?.addresses, [issueId]);
	assert.deepEqual(result.assessment?.unreadEvidence, []);
	assert.deepEqual(result.assessment?.evidenceRead,
		["original-objective.json", ...f.evidence.map(item => item.name)].filter(name =>
			!prior.parts.some(part => part.name === name)));
});

test("oversize or forbidden prior issue IDs fail input validation without a session", async t => {
	for (const issueId of ["a".repeat(129), "issue with spaces"]) {
		const f = await fixture(t);
		let prompts = 0;
		const runner = new FakeSessionRunner(() => { prompts++; throw new Error("model must not run"); });
		const exceptions: Array<{ stage: string; error: unknown }> = [];
		await assert.rejects(assessAndAdvanceOriginalObjective({ ...f, runner,
			groundingPolicy: { require: true, sourceKinds: groundingKinds,
				legacyOpenDetails: [], previousIssues: [{ id: issueId,
					claim: "Synthetic prior issue", status: "open", classification: "explicit-requirement",
					implication: "Synthetic consequence", sourceRefs: [
						{ sourceId: "original-problem.txt", startLine: 1, endLine: 1 }] }] },
			recordException: (stage, error) => { exceptions.push({ stage, error }); },
			persistReceipt: () => f.ws.writeRun(f.runRecord), assessmentAdmission: "admitted",
			advanceAdmission: () => "admitted", supportedTaskScopes: ["two-target-existing"],
			advance: async () => { throw new Error("task must not dispatch"); } }),
			/assessor grounding policy is invalid/);
		assert.equal(runner.created.length, 0);
		assert.equal(prompts, 0);
		assert.equal(exceptions.length, 1);
		assert.equal(exceptions[0]?.stage, "input-validation");
	}
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

test("indexed assessor repairs an old-schema response with the same grounded delta contract", async t => {
	const f = await fixture(t);
	const issues: GroundedAssessmentProposal["issues"] = [{ id: "prior-check",
		claim: "A prior finding still needs validation.", status: "open",
		classification: "necessary-verification", claimAtRisk: "A recommendation is supported.",
		implication: "A new check can change which result is selected.",
		sourceRefs: [{ sourceId: "original-problem.txt", startLine: 1, endLine: 1 }] }];
	const prior = await addPriorGroundingIndex(f, [], issues);
	const oldSchema = { ...assessment("continue"),
		unresolvedDetails: [issues[0]!.claim] };
	const corrected = { version: 1, decision: "continue", rationale: "Synthetic checked plan",
		evidenceRefs: ["candidate.cpp", "verification.json"],
		unresolvedObligations: ["original-task"],
		nextTask: { objective: "Run a synthetic independent check", addresses: ["original-task"],
			adapterScope: "two-target-existing" },
		groundedAssessmentDelta: { version: 1, kind: "grounded-assessment-delta",
			newIssues: [], resolutions: [], nextTask: { objective: "Run a synthetic independent check",
				obligationIds: ["original-task"],
				addresses: ["prior-check"], adapterScope: "two-target-existing",
				decisionChangingHypothesis: "The new check could change candidate selection.",
				expectedEvidence: "Independent machine check", sourceRefs: [
					{ sourceId: "original-problem.txt", startLine: 1, endLine: 1 }] } } };
	const diagnostics: Array<{ sessionId: string; generation: number; attempt: number;
		rawResponse: string; validation: { code: string; path: string; message: string } }> = [];
	let prompts = 0, dispatched = 0;
	const runner = new FakeSessionRunner(({ message }) => {
		prompts++;
		if (prompts === 1) return { text: JSON.stringify(oldSchema),
			readReturns: [...ranges(f), prior.indexRead] };
		assert.equal(diagnostics.length, 1, "invalid reply was retained before another prompt");
		assert.match(message, /groundedAssessmentDelta/);
		assert.match(message, /decisionChangingHypothesis/);
		assert.match(message, /Omit top-level unresolvedDetails/);
		return { text: JSON.stringify(corrected) };
	});
	const result = await assessAndAdvanceOriginalObjective({ ...f, runner,
		evidenceAccess: prior.access, groundingPolicy: { require: true,
			sourceKinds: prior.sourceKinds, legacyOpenDetails: [], previousIssues: issues,
			priorGroundingIndex: prior.priorGroundingIndex },
		capabilities: [{ scope: "two-target-existing", available: true,
			description: "Synthetic confined adapter", limits: [] }],
		recordValidationFailure: async value => { diagnostics.push(value); },
		persistReceipt: () => f.ws.writeRun(f.runRecord), assessmentAdmission: "admitted",
		advanceAdmission: () => "admitted", supportedTaskScopes: ["two-target-existing"],
		advance: async () => { dispatched++; } });
	assert.equal(result.stopReason, "objective-reassessment-pending");
	assert.equal(dispatched, 1);
	assert.equal(prompts, 2);
	assert.equal(runner.created.length, 1);
	assert.deepEqual(result.assessment?.unreadEvidence, []);
	assert.equal(diagnostics[0].validation.path, "$.groundedAssessmentDelta");
	assert.equal(diagnostics[0].validation.code, "m07.objective-assessment");
	assert.equal(diagnostics[0].rawResponse, JSON.stringify(oldSchema));
	assert.equal(diagnostics[0].generation, 1);
	assert.equal(diagnostics[0].attempt, 1);
});

test("indexed assessor repairs grounded task mirrors, deliverable schema and evidence type before canonical dispatch", async t => {
	const f = await fixture(t);
	const issue: GroundedAssessmentProposal["issues"][number] = {
		id: "prior-check", claim: "An independent result could change the selected answer.", status: "open",
		classification: "necessary-verification", claimAtRisk: "The selected answer is supported.",
		implication: "An independent check can change the recommendation.",
		sourceRefs: [{ sourceId: "original-problem.txt", startLine: 1, endLine: 1 }] };
	const prior = await addPriorGroundingIndex(f, [], [issue]);
	const canonicalTask: ObjectiveNextTaskV1 = { objective: "Run the independent synthetic check",
		addresses: ["original-task"], adapterScope: "two-target-existing" };
	const corrected = { version: 1, decision: "continue", rationale: "The prior check remains open.",
		evidenceRefs: ["candidate.cpp", "verification.json"],
		unresolvedObligations: ["original-task"],
		nextTask: { objective: canonicalTask.objective },
		groundedAssessmentDelta: { version: 1, kind: "grounded-assessment-delta",
			newIssues: [], resolutions: [],
			nextTask: { objective: canonicalTask.objective,
				obligationIds: ["original-task"], addresses: [issue.id],
				adapterScope: "two-target-existing",
				decisionChangingHypothesis: "An independent check could select a different answer.",
				expectedEvidence: "Independent synthetic result",
				sourceRefs: issue.sourceRefs },
			deliverableReady: { status: "proposed", ready: false,
				rationale: "The necessary verification remains open.",
				evidenceRefs: [{ sourceId: "verification.json", startLine: 1, endLine: 1 }],
				remainingIssueIds: [issue.id] } } };
	const wrongAddresses = { ...corrected, nextTask: {
		...corrected.nextTask, addresses: [issue.id] } };
	const wrongScope = { ...corrected, nextTask: {
		...corrected.nextTask, addresses: ["original-task"], adapterScope: "outside-current-adapter" } };
	const bareReadiness = { ...corrected, groundedAssessmentDelta: {
		...corrected.groundedAssessmentDelta, deliverableReady: true } };
	const spanAtTopLevel = { ...corrected, evidenceRefs: [
		{ sourceId: "verification.json", startLine: 1, endLine: 1 }] };
	const replies = [wrongAddresses, wrongScope, bareReadiness, spanAtTopLevel, corrected];
	const expectedPaths = ["$.nextTask.addresses", "$.nextTask.adapterScope",
		"$.groundedAssessmentDelta.deliverableReady", "$.evidenceRefs"];
	const diagnostics: Array<{ generation: number; attempt: number; rawResponse: string;
		validation: { code: string; path: string; detail?: string };
		coverage: readonly { sourceId: string; required: boolean; complete: boolean }[] }> = [];
	const dispatched: ObjectiveNextTaskV1[] = [];
	let prompts = 0;
	const part = prior.issueLocators[0]!;
	const partRead: ReadReturnEvent = { toolName: "objective_evidence_read", status: "returned",
		path: part.partName, requested: {}, returned: { kind: "text", startLine: part.line,
			endLine: part.line, truncated: false }, at: new Date().toISOString() };
	const runner = new FakeSessionRunner(({ message }) => {
		assert.equal(diagnostics.length, prompts, "each rejected reply is recorded before repair");
		assert.equal(dispatched.length, 0, "no invalid proposal dispatches");
		if (prompts === 0) {
			assert.match(message, /write ONE task in groundedAssessment\.nextTask or groundedAssessmentDelta\.nextTask/);
			assert.match(message, /obligationIds:\[original obligation ID strings\]/);
			assert.match(message, /addresses:\[OPEN grounded issue ID strings\]/);
			assert.match(message, /Omit top-level nextTask; the host derives its full task record/);
			assert.match(message, /Optional deliverableReady is an OBJECT \{status:'proposed',ready:boolean,rationale:string,evidenceRefs:/);
			assert.match(message, /Top-level evidenceRefs is an array of exact frozen FILE NAME STRINGS/);
		} else {
			assert.ok(message.includes(`Rejected field path: ${expectedPaths[prompts - 1]}.`));
		}
		if (prompts === 3) {
			assert.match(message, /deliverableReady must be an optional object with status proposed, ready boolean, rationale, span evidenceRefs and all remaining open issue IDs/);
		}
		if (prompts === 4) {
			assert.match(message, /Top-level evidenceRefs must be unique exact frozen file name strings; grounded citation fields use span objects/);
		}
		const reply = replies[prompts++]!;
		return { text: JSON.stringify(reply),
			...(prompts === 1 ? { readReturns: [...ranges(f), prior.indexRead, partRead] } : {}) };
	});
	const result = await assessAndAdvanceOriginalObjective({ ...f, runner,
		evidenceAccess: prior.access,
		groundingPolicy: { require: true, sourceKinds: prior.sourceKinds,
			legacyOpenDetails: [], previousIssues: [issue],
			priorGroundingIndex: prior.priorGroundingIndex },
		capabilities: [{ scope: "two-target-existing", available: true,
			description: "Synthetic independent check", limits: [] }],
		recordValidationFailure: async item => { diagnostics.push(item); },
		persistReceipt: () => f.ws.writeRun(f.runRecord), assessmentAdmission: "admitted",
		advanceAdmission: () => "admitted", supportedTaskScopes: ["two-target-existing"],
		advance: async task => { dispatched.push(task); } });
	assert.equal(result.stopReason, "objective-reassessment-pending");
	assert.equal(prompts, replies.length);
	assert.equal(runner.created.length, 1, "all repairs stay in the same read-only session");
	assert.deepEqual(diagnostics.map(item => item.validation.path), expectedPaths);
	assert.deepEqual(diagnostics.map(item => item.rawResponse),
		replies.slice(0, -1).map(item => JSON.stringify(item)));
	assert.ok(diagnostics.every(item => item.validation.code === "m07.objective-assessment" &&
		item.generation === 1));
	assert.deepEqual(diagnostics.map(item => item.attempt), [1, 2, 3, 4]);
	assert.ok(diagnostics.every(item => item.coverage.filter(source => source.required)
		.every(source => source.complete)), "required frozen evidence was returned before repair");
	assert.match(diagnostics[0]!.validation.detail ?? "", /Top-level addresses.*obligationIds/);
	assert.deepEqual(dispatched, [canonicalTask]);
	assert.deepEqual(result.assessment?.nextTask, canonicalTask);
	assert.deepEqual(result.assessment?.unreadEvidence, []);
	assert.deepEqual(result.assessment?.groundedAssessment?.issues, [issue]);
	assert.deepEqual(result.assessment?.groundedAssessment?.deliverableReady,
		corrected.groundedAssessmentDelta.deliverableReady);
});

test("indexed assessor repairs canonical grounded task fields before dispatching its objective", async t => {
	const cases = [
		{ name: "conflicting legacy objective", path: "$.nextTask.objective", reason: "legacy mirror",
			alter: (reply: any) => { reply.nextTask = { objective: "Run a conflicting synthetic task" }; } },
		{ name: "unknown grounded field", path: "/groundedAssessmentDelta/nextTask",
			reason: "unsupported field", alter: (reply: any) => {
				reply.groundedAssessmentDelta.nextTask.unsupportedInstruction = "synthetic extra"; } },
		{ name: "empty grounded objective", path: "/groundedAssessmentDelta/nextTask/objective",
			reason: "objective must be nonempty text", alter: (reply: any) => {
				reply.groundedAssessmentDelta.nextTask.objective = "  "; } },
		{ name: "empty scope", path: "/groundedAssessmentDelta/nextTask/adapterScope",
			reason: "registered scope ID", alter: (reply: any) => {
				reply.groundedAssessmentDelta.nextTask.adapterScope = ""; } },
		{ name: "unavailable scope", path: "/groundedAssessmentDelta/nextTask/adapterScope",
			reason: "unavailable registered scope", alter: (reply: any) => {
				reply.groundedAssessmentDelta.nextTask.adapterScope = "host.unavailable.synthetic"; } },
		{ name: "empty hypothesis", path: "/groundedAssessmentDelta/nextTask/decisionChangingHypothesis",
			reason: "nonempty text", alter: (reply: any) => {
				reply.groundedAssessmentDelta.nextTask.decisionChangingHypothesis = "  "; } },
	];
	for (const scenario of cases) await t.test(scenario.name, async child => {
		const f = await fixture(child);
		const issue: GroundedAssessmentProposal["issues"][number] = {
			id: "prior-check", claim: "An independent result could change the selected answer.", status: "open",
			classification: "necessary-verification", claimAtRisk: "The selected answer is supported.",
			implication: "An independent check can change the recommendation.",
			sourceRefs: [{ sourceId: "original-problem.txt", startLine: 1, endLine: 1 }] };
		const prior = await addPriorGroundingIndex(f, [], [issue]);
		const canonical = { version: 1, decision: "continue", rationale: "The prior check remains open.",
			evidenceRefs: ["candidate.cpp", "verification.json"], unresolvedObligations: ["original-task"],
			groundedAssessmentDelta: { version: 1, kind: "grounded-assessment-delta",
				newIssues: [], resolutions: [], nextTask: {
					objective: "Run the independent synthetic check", obligationIds: ["original-task"],
					addresses: [issue.id], adapterScope: "two-target-existing",
					decisionChangingHypothesis: "An independent check could select a different answer.",
					expectedEvidence: "Independent synthetic result", sourceRefs: issue.sourceRefs } } };
		const invalid = structuredClone(canonical);
		scenario.alter(invalid);
		const diagnostics: Array<{ generation: number; attempt: number; rawResponse: string;
			validation: { code: string; path: string; detail?: string };
			coverage: readonly { sourceId: string; required: boolean; complete: boolean }[] }> = [];
		const dispatched: ObjectiveNextTaskV1[] = [];
		const locator = prior.issueLocators[0]!;
		const partRead: ReadReturnEvent = { toolName: "objective_evidence_read", status: "returned",
			path: locator.partName, requested: {}, returned: { kind: "text", startLine: locator.line,
				endLine: locator.line, truncated: false }, at: new Date().toISOString() };
		const requests: string[] = [];
		const recordedBeforePrompt: number[] = [];
		const dispatchedBeforePrompt: number[] = [];
		const runner = new FakeSessionRunner(({ message }) => {
			requests.push(message);
			recordedBeforePrompt.push(diagnostics.length);
			dispatchedBeforePrompt.push(dispatched.length);
			return requests.length === 1 ? { text: JSON.stringify(invalid),
				readReturns: [...ranges(f), prior.indexRead, partRead] } :
				{ text: JSON.stringify(canonical) };
		});
		const result = await assessAndAdvanceOriginalObjective({ ...f, runner,
			evidenceAccess: prior.access,
			groundingPolicy: { require: true, sourceKinds: prior.sourceKinds,
				legacyOpenDetails: [], previousIssues: [issue],
				priorGroundingIndex: prior.priorGroundingIndex },
			capabilities: [{ scope: "two-target-existing", available: true,
				description: "Synthetic independent check", limits: [] },
				{ scope: "host.unavailable.synthetic", available: false,
					description: "Synthetic unavailable adapter", limits: [] }],
			recordValidationFailure: async item => { diagnostics.push(item); },
			persistReceipt: () => f.ws.writeRun(f.runRecord), assessmentAdmission: "admitted",
			advanceAdmission: () => "admitted", supportedTaskScopes: ["two-target-existing"],
			advance: async task => { dispatched.push(task); } });
		assert.equal(result.stopReason, "objective-reassessment-pending");
		assert.equal(runner.created.length, 1, "the correction stays in the same read-only session");
		assert.deepEqual(recordedBeforePrompt, [0, 1]);
		assert.deepEqual(dispatchedBeforePrompt, [0, 0], "invalid replies cannot dispatch a task");
		assert.equal(diagnostics.length, 1);
		assert.equal(diagnostics[0]!.validation.code, "m07.objective-assessment");
		assert.equal(diagnostics[0]!.validation.path, scenario.path);
		assert.ok((diagnostics[0]!.validation.detail ?? "").includes(scenario.reason));
		assert.equal(diagnostics[0]!.rawResponse, JSON.stringify(invalid));
		assert.equal(diagnostics[0]!.generation, 1);
		assert.equal(diagnostics[0]!.attempt, 1);
		assert.ok(diagnostics[0]!.coverage.filter(source => source.required)
			.every(source => source.complete), "rejection follows complete current-session reads");
		assert.ok(requests[1]!.includes(`Rejected field path: ${scenario.path}.`));
		assert.ok(requests[1]!.includes(scenario.reason));
		assert.deepEqual(dispatched, [{ objective: canonical.groundedAssessmentDelta.nextTask.objective,
			addresses: ["original-task"], adapterScope: "two-target-existing" }]);
		assert.deepEqual(result.assessment?.nextTask, dispatched[0]);
		assert.deepEqual(result.assessment?.unreadEvidence, []);
	});
});

test("distinct grounded field repairs keep a live assessor session and its read proof", async t => {
	const f = await fixture(t);
	const issue: GroundedAssessmentProposal["issues"][number] = {
		id: "prior-check", claim: "An independent result could change the selected answer.", status: "open",
		classification: "necessary-verification", claimAtRisk: "The selected answer is supported.",
		implication: "An independent check can change the recommendation.",
		sourceRefs: [{ sourceId: "original-problem.txt", startLine: 1, endLine: 1 }] };
	const prior = await addPriorGroundingIndex(f, [], [issue]);
	const canonical = { version: 1, decision: "continue", rationale: "The prior check remains open.",
		evidenceRefs: ["candidate.cpp", "verification.json"], unresolvedObligations: ["original-task"],
		groundedAssessmentDelta: { version: 1, kind: "grounded-assessment-delta",
			newIssues: [], resolutions: [], nextTask: {
				objective: "Run the independent synthetic check", obligationIds: ["original-task"],
				addresses: [issue.id], adapterScope: "two-target-existing",
				decisionChangingHypothesis: "An independent check could select a different answer.",
				expectedEvidence: "Independent synthetic result", sourceRefs: issue.sourceRefs } } };
	const extraField = { ...canonical, groundedAssessmentDelta: {
		...canonical.groundedAssessmentDelta, nextTask: {
			...canonical.groundedAssessmentDelta.nextTask, unsupportedInstruction: "synthetic extra" } } };
	const emptyScope = { ...canonical, groundedAssessmentDelta: {
		...canonical.groundedAssessmentDelta, nextTask: {
			...canonical.groundedAssessmentDelta.nextTask, adapterScope: "" } } };
	const replies = [extraField, emptyScope, canonical];
	const diagnostics: Array<{ generation: number; attempt: number; rawResponse: string;
		validation: { code: string; path: string; detail?: string };
		coverage: readonly { sourceId: string; required: boolean; complete: boolean }[] }> = [];
	const dispatched: ObjectiveNextTaskV1[] = [];
	const locator = prior.issueLocators[0]!;
	const partRead: ReadReturnEvent = { toolName: "objective_evidence_read", status: "returned",
		path: locator.partName, requested: {}, returned: { kind: "text", startLine: locator.line,
			endLine: locator.line, truncated: false }, at: new Date().toISOString() };
	const requests: string[] = [];
	const recordedBeforePrompt: number[] = [];
	const dispatchedBeforePrompt: number[] = [];
	const runner = new FakeSessionRunner(({ message }) => {
		requests.push(message);
		recordedBeforePrompt.push(diagnostics.length);
		dispatchedBeforePrompt.push(dispatched.length);
		return { text: JSON.stringify(replies[requests.length - 1]!),
			...(requests.length === 1 ? { readReturns: [...ranges(f), prior.indexRead, partRead] } : {}) };
	});
	const result = await assessAndAdvanceOriginalObjective({ ...f, runner,
		evidenceAccess: prior.access,
		groundingPolicy: { require: true, sourceKinds: prior.sourceKinds,
			legacyOpenDetails: [], previousIssues: [issue],
			priorGroundingIndex: prior.priorGroundingIndex },
		capabilities: [{ scope: "two-target-existing", available: true,
			description: "Synthetic independent check", limits: [] }],
		recordValidationFailure: async item => { diagnostics.push(item); },
		persistReceipt: () => f.ws.writeRun(f.runRecord), assessmentAdmission: "admitted",
		advanceAdmission: () => "admitted", supportedTaskScopes: ["two-target-existing"],
		advance: async task => { dispatched.push(task); } });
	assert.equal(result.stopReason, "objective-reassessment-pending");
	assert.equal(runner.created.length, 1, "different field repairs stay in the live session");
	assert.equal(requests.length, 3);
	assert.deepEqual(recordedBeforePrompt, [0, 1, 2], "each rejection is recorded before repair");
	assert.deepEqual(dispatchedBeforePrompt, [0, 0, 0], "no invalid task dispatches");
	assert.deepEqual(diagnostics.map(item => item.validation.path), [
		"/groundedAssessmentDelta/nextTask", "/groundedAssessmentDelta/nextTask/adapterScope"]);
	assert.deepEqual(diagnostics.map(item => item.validation.detail), [
		"grounded nextTask has an unsupported field",
		"grounded nextTask adapterScope must be a registered scope ID"]);
	assert.ok(requests[1]!.includes("Rejected field path: /groundedAssessmentDelta/nextTask."));
	assert.ok(requests[1]!.includes("grounded nextTask has an unsupported field"));
	assert.ok(requests[2]!.includes("Rejected field path: /groundedAssessmentDelta/nextTask/adapterScope."));
	assert.ok(requests[2]!.includes("grounded nextTask adapterScope must be a registered scope ID"));
	assert.deepEqual(diagnostics.map(item => item.rawResponse),
		replies.slice(0, 2).map(item => JSON.stringify(item)));
	assert.deepEqual(diagnostics.map(item => item.generation), [1, 1]);
	assert.deepEqual(diagnostics.map(item => item.attempt), [1, 2]);
	assert.ok(diagnostics.every(item => item.validation.code === "m07.objective-assessment" &&
		item.coverage.filter(source => source.required).every(source => source.complete)),
	"both corrections retain complete current-session read proof");
	assert.deepEqual(dispatched, [{ objective: canonical.groundedAssessmentDelta.nextTask.objective,
		addresses: ["original-task"], adapterScope: "two-target-existing" }]);
	assert.deepEqual(result.assessment?.nextTask, dispatched[0]);
	assert.deepEqual(result.assessment?.unreadEvidence, []);
});

test("indexed assessor accepts a matching legacy top-level task mirror", async t => {
	const f = await fixture(t);
	const issue: GroundedAssessmentProposal["issues"][number] = {
		id: "prior-check", claim: "An independent result could change the selected answer.", status: "open",
		classification: "necessary-verification", claimAtRisk: "The selected answer is supported.",
		implication: "An independent check can change the recommendation.",
		sourceRefs: [{ sourceId: "original-problem.txt", startLine: 1, endLine: 1 }] };
	const prior = await addPriorGroundingIndex(f, [], [issue]);
	const nextTask: ObjectiveNextTaskV1 = { objective: "Run the independent synthetic check",
		addresses: ["original-task"], adapterScope: "two-target-existing" };
	const reply = { version: 1, decision: "continue", rationale: "The prior check remains open.",
		evidenceRefs: ["candidate.cpp", "verification.json"], unresolvedObligations: ["original-task"],
		nextTask, groundedAssessmentDelta: { version: 1, kind: "grounded-assessment-delta",
			newIssues: [], resolutions: [], nextTask: {
				objective: nextTask.objective, obligationIds: ["original-task"],
				addresses: [issue.id], adapterScope: nextTask.adapterScope,
				decisionChangingHypothesis: "An independent check could select a different answer.",
				expectedEvidence: "Independent synthetic result", sourceRefs: issue.sourceRefs } } };
	const locator = prior.issueLocators[0]!;
	const partRead: ReadReturnEvent = { toolName: "objective_evidence_read", status: "returned",
		path: locator.partName, requested: {}, returned: { kind: "text", startLine: locator.line,
			endLine: locator.line, truncated: false }, at: new Date().toISOString() };
	const diagnostics: string[] = [];
	const dispatched: ObjectiveNextTaskV1[] = [];
	const runner = new FakeSessionRunner(() => ({ text: JSON.stringify(reply),
		readReturns: [...ranges(f), prior.indexRead, partRead] }));
	const result = await assessAndAdvanceOriginalObjective({ ...f, runner,
		evidenceAccess: prior.access,
		groundingPolicy: { require: true, sourceKinds: prior.sourceKinds,
			legacyOpenDetails: [], previousIssues: [issue],
			priorGroundingIndex: prior.priorGroundingIndex },
		capabilities: [{ scope: "two-target-existing", available: true,
			description: "Synthetic independent check", limits: [] }],
		recordValidationFailure: async item => { diagnostics.push(item.validation.path); },
		persistReceipt: () => f.ws.writeRun(f.runRecord), assessmentAdmission: "admitted",
		advanceAdmission: () => "admitted", supportedTaskScopes: ["two-target-existing"],
		advance: async task => { dispatched.push(task); } });
	assert.equal(result.stopReason, "objective-reassessment-pending");
	assert.equal(runner.created.length, 1);
	assert.deepEqual(diagnostics, []);
	assert.deepEqual(dispatched, [nextTask]);
	assert.deepEqual(result.assessment?.nextTask, nextTask);
	assert.deepEqual(result.assessment?.unreadEvidence, []);
});

test("indexed prior citations get exact nested span feedback before a valid correction", async t => {
	const f = await fixture(t);
	const priorIssue: GroundedAssessmentProposal["issues"][number] = {
		id: "prior-check", claim: "A prior result needs an independent check", status: "open",
		classification: "necessary-verification", claimAtRisk: "The result is correct",
		sourceRefs: [{ sourceId: "original-problem.txt", startLine: 1, endLine: 1 }],
		implication: "A new result may settle the claim." };
	const prior = await addPriorGroundingIndex(f, [], [priorIssue]);
	const locator = prior.issueLocators[0]!;
	const priorRef = { sourceId: locator.partName, startLine: locator.line, endLine: locator.line };
	const correct = deltaReply("fulfilled", { id: priorIssue.id, priorRef });
	const invalidPrior = structuredClone(correct) as any;
	invalidPrior.groundedAssessmentDelta.resolutions[0].priorRef = `${locator.partName}:${locator.line}`;
	const invalidEvidence = structuredClone(correct) as any;
	invalidEvidence.groundedAssessmentDelta.resolutions[0].evidenceRefs = ["verification.json:1"];
	const partRead: ReadReturnEvent = { toolName: "objective_evidence_read", status: "returned",
		path: locator.partName, requested: {}, returned: { kind: "text", startLine: locator.line,
			endLine: locator.line, truncated: false }, at: new Date().toISOString() };
	const diagnostics: Array<{ validation: { path: string; detail?: string } }> = [];
	let prompts = 0, dispatches = 0;
	const runner = new FakeSessionRunner(({ message }) => {
		prompts++;
		if (prompts === 1) {
			assert.match(message, /priorRef:\{sourceId,startLine,endLine\}/);
			assert.match(message, /Do not use a 'part:line' string/);
			return { text: JSON.stringify(invalidPrior),
				readReturns: [...ranges(f), prior.indexRead, partRead] };
		}
		if (prompts === 2) {
			assert.equal(diagnostics.length, 1);
			assert.match(message, /groundedAssessmentDelta\/resolutions\/0\/priorRef/);
			assert.match(message, /actual \{\"type\":\"string\"/);
			assert.match(message, /"sourceId":"prior-grounding-issue-1.jsonl"/);
			assert(!message.includes(`${locator.partName}:${locator.line}`),
				"feedback uses host locators without replaying model-authored shorthand");
			return { text: JSON.stringify(invalidEvidence) };
		}
		assert.equal(diagnostics.length, 2);
		assert.match(message, /groundedAssessmentDelta\/resolutions\/0\/evidenceRefs\/0/);
		return { text: JSON.stringify(correct) };
	});
	const result = await assessAndAdvanceOriginalObjective({ ...f, runner,
		evidenceAccess: prior.access,
		groundingPolicy: { require: true, sourceKinds: prior.sourceKinds,
			legacyOpenDetails: [], previousIssues: [priorIssue],
			newEvidenceSourceIds: ["verification.json"],
			priorGroundingIndex: prior.priorGroundingIndex },
		capabilities: [{ scope: "two-target-existing", available: true,
			description: "Synthetic adapter", limits: [] }],
		recordValidationFailure: async diagnostic => { diagnostics.push(diagnostic); },
		persistReceipt: () => f.ws.writeRun(f.runRecord), assessmentAdmission: "admitted",
		advanceAdmission: () => "admitted", supportedTaskScopes: ["two-target-existing"],
		advance: async () => { dispatches++; } });
	assert.equal(prompts, 3);
	assert.equal(dispatches, 0);
	assert.equal(result.stopReason, "model-closure-unverified");
	assert.equal(diagnostics[0]!.validation.path,
		"/groundedAssessmentDelta/resolutions/0/priorRef");
	assert.match(diagnostics[0]!.validation.detail ?? "", /"startLine":1,"endLine":1/);
	assert.equal(diagnostics[1]!.validation.path,
		"/groundedAssessmentDelta/resolutions/0/evidenceRefs/0");
});

test("indexed physical-gap feedback names the exact scope, field and host row before dispatch", async t => {
	const f = await fixture(t);
	const prior = await addPriorGroundingIndex(f, [], []);
	const scope = "host.unavailable.observation-1";
	const hostName = "host-capabilities.json";
	const hostText = `{\n  "unavailableCapabilities": [\n    {"scope":"${scope}","available":false}\n  ]\n}\n`;
	const hostFile = path.join(f.root, hostName);
	await writeFile(hostFile, hostText);
	f.evidence.push({ name: hostName, file: hostFile });
	const hostRow = { sourceId: hostName, startLine: 3, endLine: 3 };
	const requiredRead: ReadReturnEvent = { toolName: "objective_evidence_read", status: "returned",
		path: hostName, requested: {}, returned: { kind: "text", startLine: 1,
			endLine: 5, truncated: false }, at: new Date().toISOString() };
	const necessary = { id: "verify-result", claim: "Check a proposed result", status: "open" as const,
		classification: "necessary-verification" as const, claimAtRisk: "The proposed result is correct.",
		sourceRefs: [{ sourceId: "original-problem.txt", startLine: 1, endLine: 1 }],
		implication: "A check may change selection." };
	const physical = { id: "unavailable-observation", claim: "One host observation is unavailable",
		status: "open" as const, classification: "physical-capability-gap" as const,
		sourceRefs: [hostRow], implication: "Do not infer an unmeasured value.",
		blockedScope: scope, capabilityRef: hostRow };
	const corrected = { version: 1, decision: "continue", rationale: "Choose a feasible check.",
		evidenceRefs: ["candidate.cpp", "verification.json"],
		unresolvedObligations: ["original-task"],
		nextTask: { objective: "Run a synthetic independent check", addresses: ["original-task"],
			adapterScope: "two-target-existing" },
		groundedAssessmentDelta: { version: 1, kind: "grounded-assessment-delta",
			newIssues: [necessary, physical], resolutions: [],
			nextTask: { objective: "Run a synthetic independent check",
				obligationIds: ["original-task"], addresses: [necessary.id],
				adapterScope: "two-target-existing",
				decisionChangingHypothesis: "The new check could change selection.",
				expectedEvidence: "An independent result", sourceRefs: necessary.sourceRefs } } };
	const invalid = structuredClone(corrected);
	invalid.groundedAssessmentDelta.newIssues[1] = { ...physical,
		blockedScope: "a descriptive unavailable device" };
	const diagnostics: Array<{ validation: { path: string; detail?: string } }> = [];
	let prompts = 0, dispatched = 0;
	const runner = new FakeSessionRunner(({ message }) => {
		prompts++;
		if (prompts === 1) {
			assert.match(message, /blockedScope must be ONE exact unavailable registered scope ID/);
			assert.match(message, /status:'open'\|'resolved'/);
			assert.match(message, /host\.unavailable\.observation-1/);
			return { text: JSON.stringify(invalid), readReturns: [...ranges(f), prior.indexRead, requiredRead] };
		}
		assert.equal(diagnostics.length, 1, "private validator capture precedes correction");
		assert.match(message, /Rejected field path: \$\.groundedAssessmentDelta\.newIssues/);
		assert.match(message, /physical gap needs an unavailable registered capability/);
		return { text: JSON.stringify(corrected) };
	});
	const result = await assessAndAdvanceOriginalObjective({ ...f, runner,
		evidenceAccess: prior.access,
		groundingPolicy: { require: true, sourceKinds: { ...prior.sourceKinds,
			[hostName]: "host-capability" }, legacyOpenDetails: [], previousIssues: [],
			priorGroundingIndex: prior.priorGroundingIndex,
			capabilityLocators: { [scope]: hostRow } },
		capabilities: [{ scope: "two-target-existing", available: true,
			description: "Synthetic adapter", limits: [] },
			{ scope, available: false, description: "Synthetic unavailable observation", limits: [] }],
		recordValidationFailure: async item => { diagnostics.push(item); },
		persistReceipt: () => f.ws.writeRun(f.runRecord), assessmentAdmission: "admitted",
		advanceAdmission: () => "admitted", supportedTaskScopes: ["two-target-existing"],
		advance: async () => { dispatched++; } });
	assert.equal(prompts, 2);
	assert.equal(dispatched, 1);
	assert.equal(result.stopReason, "objective-reassessment-pending");
	assert.equal(diagnostics[0]!.validation.path, "$.groundedAssessmentDelta.newIssues");
});

test("indexed assessor retains a precise nested validator path before correction", async t => {
	const f = await fixture(t);
	const prior = await addPriorGroundingIndex(f, [], []);
	const corrected = deltaReply("fulfilled");
	const invalid = { ...corrected, groundedAssessmentDelta: {
		...corrected.groundedAssessmentDelta, nextTask: { objective: "Synthetic ungrounded task",
			obligationIds: ["original-task"],
			addresses: ["new-issue"], adapterScope: "two-target-existing",
			expectedEvidence: "Synthetic result", sourceRefs: [
				{ sourceId: "original-problem.txt", startLine: 1, endLine: 1 }] } } };
	const diagnostics: Array<{ validation: { path: string; detail?: string }; rawResponse: string }> = [];
	let prompts = 0;
	const runner = new FakeSessionRunner(() => {
		prompts++;
		return prompts === 1 ? { text: JSON.stringify(invalid),
			readReturns: [...ranges(f), prior.indexRead] } :
			{ text: JSON.stringify(corrected) };
	});
	const result = await assessAndAdvanceOriginalObjective({ ...f, runner,
		evidenceAccess: prior.access, groundingPolicy: { require: true,
			sourceKinds: prior.sourceKinds, legacyOpenDetails: [], previousIssues: [],
			priorGroundingIndex: prior.priorGroundingIndex },
		capabilities: [{ scope: "two-target-existing", available: true,
			description: "Synthetic confined adapter", limits: [] }],
		recordValidationFailure: async item => { diagnostics.push(item); },
		persistReceipt: () => f.ws.writeRun(f.runRecord), assessmentAdmission: "admitted",
		advanceAdmission: () => "admitted", supportedTaskScopes: ["two-target-existing"],
		advance: async () => { throw new Error("invalid assessor response must not dispatch"); } });
	assert.equal(result.stopReason, "model-closure-unverified");
	assert.equal(prompts, 2);
	assert.equal(diagnostics.length, 1);
	assert.equal(diagnostics[0].validation.path, "/groundedAssessmentDelta/nextTask/addresses");
	assert.equal(diagnostics[0].validation.detail,
		"grounded nextTask addresses must be OPEN grounded issue IDs");
	assert.equal(diagnostics[0].rawResponse, JSON.stringify(invalid));
});

test("a failed private rejection write prevents another assessor prompt or task dispatch", async t => {
	const f = await fixture(t);
	let prompts = 0, dispatches = 0, writes = 0;
	const runner = new FakeSessionRunner(() => {
		prompts++;
		return { text: "not JSON", readReturns: ranges(f) };
	});
	await assert.rejects(assessAndAdvanceOriginalObjective({ ...f, runner,
		persistReceipt: () => f.ws.writeRun(f.runRecord), assessmentAdmission: "admitted",
		advanceAdmission: () => "admitted", supportedTaskScopes: ["two-target-existing"],
		recordValidationFailure: async item => {
			writes++;
			assert.equal(item.validation.path, "$");
			throw new Error("synthetic private diagnostic storage failure");
		}, advance: async () => { dispatches++; } }),
		/synthetic private diagnostic storage failure/);
	assert.equal(prompts, 1);
	assert.equal(writes, 1);
	assert.equal(dispatches, 0);
});

test("missing or tampered prior grounding part is rejected before an assessor prompt", async t => {
	const f = await fixture(t);
	const legacy = ["authenticated old detail"];
	const prior = await addPriorGroundingIndex(f, legacy, []);
	let prompts = 0;
	const runner = new FakeSessionRunner(() => { prompts++; throw new Error("assessor must not start"); });
	const exceptions: Array<{ stage: string; error: unknown }> = [];
	await writeFile(path.join(f.root, prior.parts[0]!.name),
		`${JSON.stringify({ kind: "legacy-detail", value: "tampered" })}\n`);
	const base = { ...f, runner, evidenceAccess: prior.access,
		recordException: (stage: string, error: unknown) => { exceptions.push({ stage, error }); },
		groundingPolicy: { require: true as const, sourceKinds: prior.sourceKinds,
			legacyOpenDetails: legacy, previousIssues: [],
			priorGroundingIndex: prior.priorGroundingIndex },
		persistReceipt: () => f.ws.writeRun(f.runRecord), assessmentAdmission: "admitted" as const,
		advanceAdmission: () => "admitted" as const, supportedTaskScopes: ["two-target-existing"],
		advance: async () => { throw new Error("must not dispatch"); } };
	await assert.rejects(assessAndAdvanceOriginalObjective(base), /partition differs/);
	assert.equal(runner.created.length, 0);
	assert.equal(exceptions.length, 1);
	assert.equal(exceptions[0]?.stage, "prior-index");
	assert.match((exceptions[0]?.error as Error).message, /partition differs/);
	await rm(path.join(f.root, prior.parts[0]!.name));
	await assert.rejects(assessAndAdvanceOriginalObjective(base));
	assert.equal(runner.created.length, 0);
	assert.equal(prompts, 0);
	assert.equal(exceptions.length, 2);
	assert.equal(exceptions[1]?.stage, "evidence-scan");
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
	let prompts = 0;
	const runner = new FakeSessionRunner(() => { prompts++; return "must not dispatch"; });
	const exceptions: Array<{ stage: string; error: unknown }> = [];
	await assert.rejects(assessAndAdvanceOriginalObjective({ ...f,
		evidence: [...f.evidence, { name: "oversize-control.json", file }], runner,
		recordException: (stage, error) => { exceptions.push({ stage, error }); },
		persistReceipt: () => f.ws.writeRun(f.runRecord), assessmentAdmission: "admitted",
		advanceAdmission: () => "admitted", supportedTaskScopes: ["two-target-existing"],
		advance: async task => task.objective }), /bounded regular file/);
	assert.equal(runner.created.length, 0);
	assert.equal(prompts, 0);
	assert.equal(exceptions.length, 1);
	assert.equal(exceptions[0]?.stage, "evidence-scan");
	assert.match((exceptions[0]?.error as Error).message, /bounded regular file/);
});

test("missing and invalid UTF-8 evidence report evidence-scan before session creation", async t => {
	for (const invalidContent of [undefined, Buffer.from([0xff, 0xfe])]) {
		const f = await fixture(t);
		const file = f.evidence.find(item => item.name === "second-text.txt")!.file;
		if (invalidContent) await writeFile(file, invalidContent);
		else await rm(file);
		let prompts = 0;
		const runner = new FakeSessionRunner(() => { prompts++; throw new Error("model must not run"); });
		const exceptions: Array<{ stage: string; error: unknown }> = [];
		const call = assessAndAdvanceOriginalObjective({ ...f, runner,
			recordException: (stage, error) => { exceptions.push({ stage, error }); },
			persistReceipt: () => f.ws.writeRun(f.runRecord), assessmentAdmission: "admitted",
			advanceAdmission: () => "admitted", supportedTaskScopes: ["two-target-existing"],
			advance: async () => { throw new Error("task must not dispatch"); } });
		await assert.rejects(call, invalidContent ? /valid UTF-8 text/ : /ENOENT/);
		assert.equal(runner.created.length, 0);
		assert.equal(prompts, 0);
		assert.equal(exceptions.length, 1);
		assert.equal(exceptions[0]?.stage, "evidence-scan");
	}
});

test("occupied frozen-copy destination reports before session creation", async t => {
	const f = await fixture(t);
	await writeFile(f.evidenceRoot, "occupied");
	let prompts = 0;
	const runner = new FakeSessionRunner(() => { prompts++; throw new Error("model must not run"); });
	const exceptions: Array<{ stage: string; error: unknown }> = [];
	await assert.rejects(assessAndAdvanceOriginalObjective({ ...f, runner,
		recordException: (stage, error) => { exceptions.push({ stage, error }); },
		persistReceipt: () => f.ws.writeRun(f.runRecord), assessmentAdmission: "admitted",
		advanceAdmission: () => "admitted", supportedTaskScopes: ["two-target-existing"],
		advance: async () => { throw new Error("task must not dispatch"); } }), /EEXIST/);
	assert.equal(runner.created.length, 0);
	assert.equal(prompts, 0);
	assert.equal(exceptions.length, 1);
	assert.equal(exceptions[0]?.stage, "frozen-copy");
});

test("an exception recorder failure cannot mask the initiating evidence error", async t => {
	const f = await fixture(t);
	const file = path.join(f.root, "source", "oversize-control.json");
	await writeFile(file, "x".repeat(1_000_001));
	const runner = new FakeSessionRunner(() => { throw new Error("model must not run"); });
	let initiatingError: unknown;
	await assert.rejects(assessAndAdvanceOriginalObjective({ ...f, runner,
		evidence: [...f.evidence, { name: "oversize-control.json", file }],
		recordException: (_stage, error) => {
			initiatingError = error;
			throw new Error("synthetic recorder failure");
		},
		persistReceipt: () => f.ws.writeRun(f.runRecord), assessmentAdmission: "admitted",
		advanceAdmission: () => "admitted", supportedTaskScopes: ["two-target-existing"],
		advance: async () => { throw new Error("task must not dispatch"); } }), error => {
		assert.strictEqual(error, initiatingError);
		assert.match((error as Error).message, /bounded regular file/);
		return true;
	});
	assert.equal(runner.created.length, 0);
});

test("prompt failure reports its stage after session creation and a provider attempt", async t => {
	const f = await fixture(t);
	const providerError = new Error("synthetic provider failure");
	let prompts = 0;
	const runner = new FakeSessionRunner(() => { prompts++; throw providerError; });
	const exceptions: Array<{ stage: string; error: unknown }> = [];
	const result = await assessAndAdvanceOriginalObjective({ ...f, runner,
		recordException: (stage, error) => { exceptions.push({ stage, error }); },
		persistReceipt: () => f.ws.writeRun(f.runRecord), assessmentAdmission: "admitted",
		advanceAdmission: () => "admitted", supportedTaskScopes: ["two-target-existing"],
		advance: async () => { throw new Error("task must not dispatch"); } });
	assert.equal(result.stopReason, "assessment-failed");
	assert.equal(runner.created.length, 1);
	assert.equal(prompts, 1);
	assert.deepEqual(exceptions, [{ stage: "prompt", error: providerError }]);
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
