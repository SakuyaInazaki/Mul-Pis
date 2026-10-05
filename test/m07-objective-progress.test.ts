import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { assessAndAdvanceOriginalObjective, createOriginalObjective, objectiveProgress,
	runOriginalObjectiveLoop, writeOriginalObjectiveContract } from "../src/m07/objective-progress.ts";
import type { ModelObjectiveAssessmentV1, ObjectiveNextTaskV1 } from "../src/m07/objective-progress.ts";
import { FakeSessionRunner, type FakeReply } from "../src/runner/fake.ts";
import type { ReadReturnEvent, SessionSpec } from "../src/runner/types.ts";
import { Workspace } from "../src/workspace.ts";

const originalInputs: Record<string, string> = {
	"original-problem.txt": "Original mission allows more than the finite pilot.\n",
	"original-source.cpp": "// Synthetic original source\n",
	"second-text.txt": "Synthetic additional original constraints.\n",
	"candidate.cpp": "// Synthetic accepted pilot candidate\n",
	"verification.json": '{"status":"passed","scope":"finite"}\n',
};
const lines = (text: string) => text.split("\n").length - (text.endsWith("\n") ? 1 : 0);

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
	assessmentAdmission?: "admitted" | "budget-boundary" | "time-boundary";
	advanceAdmission?: "admitted" | "budget-boundary" | "time-boundary";
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

test("blocked, malformed and missing-read assessments cannot launch more execution", async t => {
	for (const kind of ["blocked", "malformed", "malformed-scope", "unread"] as const) {
		const f = await fixture(t);
		const text = kind === "malformed" ? JSON.stringify({ ...assessment("continue"), decision: ["continue"] }) :
			kind === "malformed-scope" ? JSON.stringify({ ...assessment("continue"),
				nextTask: { ...assessment("continue").nextTask, adapterScope: ["two-target-existing"] } }) :
				JSON.stringify(assessment(kind === "blocked" ? "blocked" : "continue"));
		const { result, advanced } = await invoke(f, { text,
			readReturns: ranges(f, kind === "unread" ? ["second-text.txt"] : []) });
		assert.equal(result.stopReason, kind === "blocked" ? "model-reported-blocked" :
			kind === "malformed" || kind === "malformed-scope" ? "assessment-invalid" : "assessment-evidence-unread");
		assert.equal(advanced.length, 0);
		if (kind === "unread") assert.deepEqual(result.assessment?.unreadEvidence, ["second-text.txt"]);
	}
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
	assert.equal(objectiveProgress(finite, input).objectiveOutcome, "fulfilled");
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

test("budget, time and unsupported adapter scope retain model proposal without execution", async t => {
	for (const boundary of ["budget-boundary", "time-boundary"] as const) {
		const f = await fixture(t);
		const reply = { text: JSON.stringify(assessment("continue")), readReturns: ranges(f) };
		const before = await invoke(f, reply, { assessmentAdmission: boundary });
		assert.equal(before.result.stopReason, boundary);
		assert.equal(before.runner.created.length, 0);
		assert.equal(before.advanced.length, 0);
	}
	for (const boundary of ["budget-boundary", "time-boundary"] as const) {
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
	let dispatched = 0, terminalReason: string | undefined;
	for (let iteration = 1; iteration <= 3; iteration++) {
		const runRecord = iteration === 1 ? f.runRecord : await f.ws.startRun("M07Objective", []);
		const step = await assessAndAdvanceOriginalObjective({ contract: f.contract, contractFile: f.contractFile,
			runner, sessionSpec: { ...f.sessionSpec, label: `objective-assessor-${iteration}` }, runRecord,
			persistReceipt: () => f.ws.writeRun(runRecord), evidenceRoot: path.join(f.root, `assessment-evidence-${iteration}`),
			evidence: f.evidence, assessmentAdmission: iteration <= 2 ? "admitted" : "budget-boundary",
			advanceAdmission: () => "admitted", supportedTaskScopes: ["two-target-existing"],
			advance: async task => {
				dispatched++;
				assert.equal(task.objective, `Model-proposed bounded investigation ${dispatched}`);
				boundedRuns.push({ runId: `bounded-${dispatched}`, outcome: "fulfilled" });
				await writeFile(candidate, `// Synthetic child candidate ${dispatched}\n`);
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
	assert.equal(terminalReason, "budget-boundary");
	const progress = objectiveProgress(f.contract, { boundedRuns, selectedArtifacts: ["candidate.cpp"],
		stopReason: "budget-boundary" });
	assert.equal(progress.contract.id, f.contract.id);
	assert.equal(progress.objectiveOutcome, "incomplete");
	assert.equal(progress.boundedRuns.length, 2);
});

test("the reusable objective loop refreshes evidence after each child and stops only at admission", async () => {
	let latestEvidence = "initial", attempted = 0, admissions = 0;
	const result = await runOriginalObjectiveLoop({ maxIterations: 8,
		admission: () => { admissions++; return admissions <= 2 ? "admitted" : "budget-boundary"; },
		step: async iteration => {
			attempted++;
			assert.equal(latestEvidence, iteration === 1 ? "initial" : "candidate-1");
			latestEvidence = `candidate-${iteration}`;
			return { advanced: true, stopReason: "objective-reassessment-pending", evidenceRefs: [latestEvidence] };
		} });
	assert.equal(attempted, 2);
	assert.equal(admissions, 3);
	assert.equal(latestEvidence, "candidate-2");
	assert.equal(result.stopReason, "budget-boundary");
	assert.deepEqual(result.steps.map(step => step.evidenceRefs), [["candidate-1"], ["candidate-2"]]);
});

test("the reusable objective loop never repeats a terminal no-advance assessment", async () => {
	for (const reason of ["model-reported-blocked", "model-closure-unverified",
		"assessment-invalid", "assessment-evidence-unread", "next-task-needs-capability", "no-progress"] as const) {
		let calls = 0;
		const result = await runOriginalObjectiveLoop({ maxIterations: 64, admission: () => "admitted",
			step: async () => { calls++; return { advanced: false, stopReason: reason, evidenceRefs: ["observed"] }; } });
		assert.equal(calls, 1, reason);
		assert.equal(result.stopReason, reason);
		assert.deepEqual(result.steps.map(step => step.evidenceRefs), [["observed"]]);
	}
	const capacity = await runOriginalObjectiveLoop({ maxIterations: 2, admission: () => "admitted",
		step: async iteration => ({ advanced: true, stopReason: "objective-reassessment-pending",
			evidenceRefs: [`candidate-${iteration}`] }) });
	assert.equal(capacity.stopReason, "artifact-capacity-boundary");
	assert.equal(capacity.steps.length, 2);
});
