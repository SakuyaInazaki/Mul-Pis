import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { offlineChecks } from "../scripts/manual-private-campaign.ts";
import { createFileKnowledgeStore } from "../src/knowledge/store.ts";
import { createM07Controller } from "../src/m07/controller.ts";
import { FakeSessionRunner } from "../src/runner/fake.ts";
import type { StageContext } from "../src/stages/context.ts";
import { Workspace } from "../src/workspace.ts";

async function fixture(t: TestContext, unsafeFile = false, pauseExecution?: () => Promise<void>, extraFiles = 0) {
	const root = await mkdtemp(path.join(tmpdir(), "m07-branches-"));
	t.after(async () => rm(root, { recursive: true, force: true }));
	const ws = new Workspace(root);
	await mkdir(path.dirname(ws.problemFile), { recursive: true });
	await writeFile(ws.problemFile, "Frozen question\n");
	const store = createFileKnowledgeStore(ws.knowledgeDir);
	await store.init();
	const baseline = await ws.startRun("M04", []);
	await ws.finishRun(baseline, "completed");
	const runner = new FakeSessionRunner(async ({ spec, turnIndex }) => {
		if (spec.tools.kind === "execution") {
			if (pauseExecution) await pauseExecution();
			const candidate = path.join(spec.tools.root, "candidate.txt");
			if (turnIndex === 1) {
				await writeFile(candidate, "seed\n");
				for (let index = 0; index < extraFiles; index++)
					await writeFile(path.join(spec.tools.root, `evidence-${String(index).padStart(4, "0")}.txt`), "x\n");
			}
			else await writeFile(candidate, `${spec.label}\n`);
			if (unsafeFile) await writeFile(path.join(spec.tools.root, ".env"), "PRIVATE=not-for-branch\n");
		}
		return `${spec.label} report`;
	});
	const ctx: StageContext = { ws, store, runner, config: { roles: { execution: "fake/execution", reviewer: "fake/reviewer" }, concurrency: 1, tools: {} } };
	const controller = createM07Controller(ctx);
	const goal = await controller.begin({ goal: "Compare candidates", problemRelation: "Direct experiment", constraints: ["Keep the question fixed"], successCriteria: ["Candidate checked"], plan: "Run two frozen branches" });
	return { root, ws, store, runner, controller, goal };
}

const taskSpec = { objective: "Implement candidate", inputs: [], expectedOutputs: ["candidate.txt"], checks: ["Candidate file checked"], mode: "execute" as const };

test("M07 can load and fork a frozen branch with more than 1,000 small files", async t => {
	const f = await fixture(t, false, undefined, 1_001);
	const parent = await f.controller.delegate(f.goal.runId, taskSpec);
	assert.equal(parent.status, "returned", parent.executionFailure ?? "parent failed");
	assert.ok(parent.branchSource, parent.branchUnavailableReason ?? "branch checkpoint unavailable");
	const manifest = JSON.parse(await readFile(parent.branchSource!.manifestPath, "utf8"));
	assert.ok(manifest.files.length > 1_000);
	const context = { mode: "fork" as const, parentRunId: f.goal.runId, parentTaskId: parent.taskId,
		checkpointId: parent.branchSource!.checkpoint.id };
	const child = await f.controller.delegate(f.goal.runId, { ...taskSpec, context });
	assert.equal(child.status, "returned", child.executionFailure ?? "fork failed");
	assert.equal(await readFile(path.join(child.workDir, "evidence-1000.txt"), "utf8"), "x\n");
});

test("M07 retains more than twelve explicit versioned resource inputs", async t => {
	const f = await fixture(t);
	const inputs = Array.from({ length: 13 }, (_, index) => `resource-${String(index).padStart(2, "0")}.md`);
	for (const name of inputs) await writeFile(path.join(f.root, name), `${name}\n`);
	const resources = inputs.map((input, index) => ({ id: `resource-${index}`, version: "v1", input }));
	const task = await f.controller.delegate(f.goal.runId, { ...taskSpec, inputs, resourceInputs: resources });
	assert.equal(task.status, "returned", task.executionFailure ?? "task failed");
	assert.equal(task.resourceInputs?.length, 13);
	assert.equal(task.inputCopies.length, 13);
});

test("M07 opens two real fake-runner histories from one frozen task leaf with private work roots", async (t) => {
	const f = await fixture(t);
	const parent = await f.controller.delegate(f.goal.runId, taskSpec);
	assert.equal(parent.status, "returned", parent.executionFailure ?? "parent failed");
	assert.ok(parent.branchSource, parent.branchUnavailableReason ?? "branch checkpoint unavailable");
	const context = { mode: "fork" as const, parentRunId: f.goal.runId, parentTaskId: parent.taskId, checkpointId: parent.branchSource!.checkpoint.id };
	const first = await f.controller.delegate(f.goal.runId, { ...taskSpec, context });
	const second = await f.controller.delegate(f.goal.runId, { ...taskSpec, context });
	assert.equal(first.status, "returned", first.executionFailure ?? "first fork failed");
	assert.equal(second.status, "returned", second.executionFailure ?? "second fork failed");
	assert.notEqual(first.session?.id, second.session?.id);
	assert.notEqual(first.session?.file, second.session?.file);
	assert.notEqual(first.workDir, second.workDir);
	assert.notEqual(first.workDir, parent.workDir);
	assert.ok(first.session?.lineageFile);
	assert.ok(second.session?.lineageFile);
	const firstLineage = JSON.parse(await readFile(first.session!.lineageFile!, "utf8"));
	assert.equal(firstLineage.checkpoint.id, context.checkpointId);
	assert.equal(firstLineage.parent.sessionId, parent.session!.id);
	assert.equal(firstLineage.evidenceBindings[0].status, "frozen-copy");
	const lineageSummary = await offlineChecks.contextLineageSummary(first.session?.lineageFile,
		parent.branchSource!.checkpoint, first.session?.id, first.session?.model,
		parent.branchSource!.problemSnapshotCopy, "fake/execution");
	assert.equal(lineageSummary.state, "verified", JSON.stringify(lineageSummary.driverChecks));
	assert.equal(lineageSummary.evidenceBindingCount, 2);
	const parentHistory = await readFile(parent.session!.file!, "utf8");
	const firstHistory = await readFile(first.session!.file!, "utf8");
	const secondHistory = await readFile(second.session!.file!, "utf8");
	assert.ok(firstHistory.startsWith(parentHistory));
	assert.ok(secondHistory.startsWith(parentHistory));
	assert.match(firstHistory, /Frozen competitive branch/);
	assert.doesNotMatch(parentHistory, /Frozen competitive branch/);
	assert.notEqual(await readFile(path.join(first.workDir, "candidate.txt"), "utf8"), await readFile(path.join(second.workDir, "candidate.txt"), "utf8"));
	assert.equal(await readFile(path.join(parent.workDir, "candidate.txt"), "utf8"), "seed\n");
	const mapping = JSON.parse(await readFile(path.join(first.workDir, "branch-evidence-map.json"), "utf8"));
	assert.equal(mapping.parentTaskId, parent.taskId);
	assert.ok(mapping.files.some((item: { historicalPath: string; childPath: string }) => item.historicalPath === path.join(parent.workDir, "candidate.txt") && item.childPath === path.join(first.workDir, "candidate.txt")));
	const run = await f.ws.readRun("M07", f.goal.runId);
	assert.deepEqual(run.sessions.map((item) => item.boundary?.mode), ["fresh", "fork", "fork"]);
});

test("M07 fork keeps canonical frozen identity for relative inputs, plan and versioned resources", async t => {
	const f = await fixture(t);
	const guide = path.join(f.root, "guide.md"), alternative = path.join(f.root, "alternative.md");
	await writeFile(guide, "frozen guide\n"); await writeFile(alternative, "other frozen guide\n");
	const spec = { ...taskSpec, inputs: ["guide.md", "alternative.md"], planInput: "guide.md",
		resourceInputs: [{ id: "guide", version: "v1", input: "guide.md" }] };
	const parent = await f.controller.delegate(f.goal.runId, spec);
	assert.equal(parent.status, "returned", parent.executionFailure ?? "parent failed");
	assert.ok(parent.branchSource, parent.branchUnavailableReason ?? "checkpoint unavailable");
	assert.equal(parent.inputCopies[0].source, guide);
	assert.equal(parent.planInput, guide);
	assert.equal(parent.resourceInputs?.[0].input, guide);
	const context = { mode: "fork" as const, parentRunId: f.goal.runId, parentTaskId: parent.taskId,
		checkpointId: parent.branchSource!.checkpoint.id };
	await assert.rejects(f.controller.delegate(f.goal.runId, { ...spec, inputs: [...spec.inputs].reverse(), context }),
		/retain the parent's objective, inputs/);
	await assert.rejects(f.controller.delegate(f.goal.runId, { ...spec, planInput: "not-declared.md", context }),
		/frozen declared inputs/);
	await assert.rejects(f.controller.delegate(f.goal.runId, { ...spec,
		resourceInputs: [{ id: "guide", version: "v1", input: "alternative.md" }], context }),
		/frozen knowledge applicability, plan, resources/);
	await assert.rejects(f.controller.delegate(f.goal.runId, { ...spec,
		resourceInputs: [{ id: "guide", version: "v2", input: "guide.md" }], context }),
		/frozen knowledge applicability, plan, resources/);
	await writeFile(guide, "changed after checkpoint\n");
	const child = await f.controller.delegate(f.goal.runId, { ...spec, context });
	assert.equal(child.status, "returned", child.executionFailure ?? "fork failed");
	assert.deepEqual(child.inputCopies.map(item => item.source), parent.inputCopies.map(item => item.source));
	assert.equal(child.planInput, parent.planInput);
	assert.deepEqual(child.resourceInputs, parent.resourceInputs);
	assert.equal(await readFile(child.inputCopies[0].copy, "utf8"), "frozen guide\n");
});

test("M07 candidate lesson prompt requires pinned priorRef only for adopted-record amendments", async t => {
	const f = await fixture(t);
	await f.controller.delegate(f.goal.runId, { ...taskSpec,
		expectedOutputs: ["candidate.txt", "lesson-delta.json"], lessonDeltaOutput: "lesson-delta.json" });
	const execution = [...f.runner.sessions.values()].find(item => item.spec.role === "execution");
	const message = execution?.transcript[0]?.text ?? "";
	assert.match(message, /priorRef/);
	assert.match(message, /storeId.*recordId.*version/);
	assert.match(message, /amend.*contradict/);
	assert.match(message, /propose/);
});

test("M07 branch candidates remain review-gated and selection cannot bypass original checks", async (t) => {
	const f = await fixture(t);
	const parent = await f.controller.delegate(f.goal.runId, taskSpec);
	await f.controller.review(f.goal.runId, { taskId: parent.taskId, checks: [{ criterion: taskSpec.checks[0], result: "failed", evidence: [] }], artifacts: [path.join(parent.workDir, "candidate.txt")] });
	const context = { mode: "fork" as const, parentRunId: f.goal.runId, parentTaskId: parent.taskId, checkpointId: parent.branchSource!.checkpoint.id };
	await assert.rejects(f.controller.delegate(f.goal.runId, { ...taskSpec, checks: ["weakened"], context }), /retain the parent's objective/);
	await assert.rejects(f.controller.delegate(f.goal.runId, { ...taskSpec, experienceTags: ["different-applicability"], context }), /frozen knowledge applicability/);
	await assert.rejects(f.controller.delegate(f.goal.runId, { ...taskSpec, experienceContextRefs: [{ storeId: "different", recordId: "X001", version: 1 }], context }), /frozen knowledge applicability/);
	await assert.rejects(f.controller.delegate(f.goal.runId, { ...taskSpec, context: { ...context, checkpointId: "wrong" } }), /settled, frozen/);
	const accepted = await f.controller.delegate(f.goal.runId, { ...taskSpec, context });
	const rejected = await f.controller.delegate(f.goal.runId, { ...taskSpec, context });
	await assert.rejects(f.controller.selectBranch(f.goal.runId, { parentTaskId: parent.taskId, selectedTaskId: accepted.taskId, rationale: "looks best" }), /every returned candidate must receive ordinary M07 review/);
	const reviewed = await f.controller.review(f.goal.runId, { taskId: accepted.taskId, checks: [{ criterion: taskSpec.checks[0], result: "passed", evidence: [path.join(accepted.workDir, "candidate.txt")] }], artifacts: [path.join(accepted.workDir, "candidate.txt")] });
	await f.controller.review(f.goal.runId, { taskId: rejected.taskId, checks: [{ criterion: taskSpec.checks[0], result: "failed", evidence: [] }], artifacts: [path.join(rejected.workDir, "candidate.txt")] });
	await assert.rejects(f.controller.selectBranch(f.goal.runId, { parentTaskId: parent.taskId, selectedTaskId: rejected.taskId, rationale: "invalid" }), /reviewed and accepted/);
	await f.controller.selectBranch(f.goal.runId, { parentTaskId: parent.taskId, selectedTaskId: accepted.taskId, rationale: "Only candidate meeting the frozen check" });
	const liveGoalPath = path.join(f.ws.runDir("M07", f.goal.runId), "goal.json");
	const liveGoal = JSON.parse(await readFile(liveGoalPath, "utf8"));
	liveGoal.tasks.find((item: { taskId: string }) => item.taskId === rejected.taskId).toolLog.push({ name: "write", args: { content: "private-omitted-tool-secret" }, ok: false, at: new Date().toISOString() });
	liveGoal.tasks.find((item: { taskId: string }) => item.taskId === rejected.taskId).branchUnavailableReason = "private-omitted-reason-secret";
	await writeFile(liveGoalPath, JSON.stringify(liveGoal));
	const checkpoint = await f.controller.checkpoint(f.goal.runId, { taskIds: [accepted.taskId] });
	const frozenBytes = await readFile(checkpoint.goalSnapshotPath, "utf8");
	const frozenGoal = JSON.parse(frozenBytes);
	assert.doesNotMatch(frozenBytes, /private-omitted-tool-secret|private-omitted-reason-secret/);
	assert.match(await readFile(liveGoalPath, "utf8"), /private-omitted-tool-secret/);
	assert.ok(frozenGoal.tasks.every((item: { branchSource?: unknown; executionRounds?: unknown }) => item.branchSource === undefined && item.executionRounds === undefined));
	const frozenComparison = frozenGoal.branchSelections[0].candidates;
	assert.deepEqual(frozenComparison.find((item: { taskId: string }) => item.taskId === accepted.taskId).checks, [{ criterion: taskSpec.checks[0], result: "passed" }]);
	assert.ok(frozenComparison.every((item: { frozenReportPath?: unknown; failure?: unknown }) => item.frozenReportPath === undefined && item.failure === undefined));
	const completed = await f.controller.finish(f.goal.runId, { outcome: "fulfilled", summary: "One checked candidate selected", returnPath: "M04", goalChecks: [{ criterion: "Candidate checked", result: "passed", evidence: [reviewed.review!.frozenReportPath] }] });
	assert.equal(completed.outcome, "fulfilled");
	assert.equal(completed.tasks.find((item) => item.taskId === rejected.taskId)?.status, "rejected");
});

test("M07 serializes competing delegates and refuses to copy auth-like evidence", async (t) => {
	const f = await fixture(t);
	const parent = await f.controller.delegate(f.goal.runId, taskSpec);
	const context = { mode: "fork" as const, parentRunId: f.goal.runId, parentTaskId: parent.taskId, checkpointId: parent.branchSource!.checkpoint.id };
	const [first, second] = await Promise.all([
		f.controller.delegate(f.goal.runId, { ...taskSpec, context }),
		f.controller.delegate(f.goal.runId, { ...taskSpec, context }),
	]);
	assert.deepEqual([first.taskId, second.taskId], ["T002", "T003"]);
	assert.notEqual(first.session?.id, second.session?.id);
	const unsafe = await fixture(t, true);
	const source = await unsafe.controller.delegate(unsafe.goal.runId, taskSpec);
	assert.equal(source.status, "returned");
	assert.equal(source.branchSource, undefined);
	assert.match(source.branchUnavailableReason ?? "", /auth\/session-like source/);
});

test("M07 branches copy frozen evidence rather than later parent edits, and unsupported checkpoint leaves ordinary task usable", async (t) => {
	const f = await fixture(t);
	const parent = await f.controller.delegate(f.goal.runId, taskSpec);
	assert.ok(parent.branchSource);
	await writeFile(path.join(parent.workDir, "candidate.txt"), "later parent edit\n");
	const context = { mode: "fork" as const, parentRunId: f.goal.runId, parentTaskId: parent.taskId, checkpointId: parent.branchSource!.checkpoint.id };
	const child = await f.controller.delegate(f.goal.runId, { ...taskSpec, context });
	assert.equal(child.status, "returned", child.executionFailure ?? "fork failed");
	assert.equal(await readFile(path.join(parent.branchSource!.workSnapshotRoot, "candidate.txt"), "utf8"), "seed\n");
	assert.equal(await readFile(path.join(parent.workDir, "candidate.txt"), "utf8"), "later parent edit\n");
	const noCheckpoint = await fixture(t);
	Object.defineProperty(noCheckpoint.runner, "checkpoint", { value: undefined });
	const ordinary = await noCheckpoint.controller.delegate(noCheckpoint.goal.runId, taskSpec);
	assert.equal(ordinary.status, "returned");
	assert.equal(ordinary.branchSource, undefined);
	assert.match(ordinary.branchUnavailableReason ?? "", /no stable checkpoint capability/);
});

test("M07 can select the ordinarily reviewed original over a worse branch", async (t) => {
	const f = await fixture(t);
	const parent = await f.controller.delegate(f.goal.runId, taskSpec);
	const context = { mode: "fork" as const, parentRunId: f.goal.runId, parentTaskId: parent.taskId, checkpointId: parent.branchSource!.checkpoint.id };
	const child = await f.controller.delegate(f.goal.runId, { ...taskSpec, context });
	const original = await f.controller.review(f.goal.runId, { taskId: parent.taskId, checks: [{ criterion: taskSpec.checks[0], result: "passed", evidence: [path.join(parent.workDir, "candidate.txt")] }], artifacts: [path.join(parent.workDir, "candidate.txt")] });
	await f.controller.review(f.goal.runId, { taskId: child.taskId, checks: [{ criterion: taskSpec.checks[0], result: "passed", evidence: [path.join(child.workDir, "candidate.txt")] }], artifacts: [path.join(child.workDir, "candidate.txt")] });
	const selected = await f.controller.selectBranch(f.goal.runId, { parentTaskId: parent.taskId, selectedTaskId: parent.taskId, rationale: "Original verified candidate had the better observed outcome" });
	assert.equal(selected.branchSelections?.[0].selectedTaskId, parent.taskId);
	assert.deepEqual(selected.branchSelections?.[0].candidates.map((item) => item.taskId), [parent.taskId, child.taskId]);
	const finished = await f.controller.finish(f.goal.runId, { outcome: "fulfilled", summary: "Reviewed original remains best", returnPath: "M04", goalChecks: [{ criterion: "Candidate checked", result: "passed", evidence: [original.review!.frozenReportPath] }] });
	assert.equal(finished.outcome, "fulfilled");
});

test("M07 cannot select or finish while a losing branch has unresolved execution", async (t) => {
	const f = await fixture(t);
	const parent = await f.controller.delegate(f.goal.runId, taskSpec);
	const context = { mode: "fork" as const, parentRunId: f.goal.runId, parentTaskId: parent.taskId, checkpointId: parent.branchSource!.checkpoint.id };
	const child = await f.controller.delegate(f.goal.runId, { ...taskSpec, context });
	const original = await f.controller.review(f.goal.runId, { taskId: parent.taskId, checks: [{ criterion: taskSpec.checks[0], result: "passed", evidence: [path.join(parent.workDir, "candidate.txt")] }], artifacts: [path.join(parent.workDir, "candidate.txt")] });
	await f.controller.review(f.goal.runId, { taskId: child.taskId, checks: [{ criterion: taskSpec.checks[0], result: "failed", evidence: [] }], artifacts: [path.join(child.workDir, "candidate.txt")] });
	const statePath = path.join(f.ws.runDir("M07", f.goal.runId), "goal.json");
	const state = JSON.parse(await readFile(statePath, "utf8"));
	const childState = state.tasks.find((item: { taskId: string }) => item.taskId === child.taskId);
	childState.status = "unknown";
	state.executionState.operations.find((item: { taskId: string }) => item.taskId === child.taskId).status = "unknown";
	await writeFile(statePath, JSON.stringify(state));
	await assert.rejects(f.controller.selectBranch(f.goal.runId, { parentTaskId: parent.taskId, selectedTaskId: parent.taskId, rationale: "original wins" }), /unresolved external operations/);
	state.branchSelections = [{ version: 1, parentTaskId: parent.taskId, selectedTaskId: parent.taskId, rationale: "original wins", selectedAt: new Date().toISOString(), candidates: [] }];
	await writeFile(statePath, JSON.stringify(state));
	await assert.rejects(f.controller.finish(f.goal.runId, { outcome: "fulfilled", summary: "cannot hide unknown", returnPath: "M04", goalChecks: [{ criterion: "Candidate checked", result: "passed", evidence: [original.review!.frozenReportPath] }] }), /状态未知|未知结果/);
});

test("M07 requires ordinary review of the original candidate before comparison", async (t) => {
	const f = await fixture(t);
	const parent = await f.controller.delegate(f.goal.runId, taskSpec);
	const context = { mode: "fork" as const, parentRunId: f.goal.runId, parentTaskId: parent.taskId, checkpointId: parent.branchSource!.checkpoint.id };
	const child = await f.controller.delegate(f.goal.runId, { ...taskSpec, context });
	await f.controller.review(f.goal.runId, { taskId: child.taskId, checks: [{ criterion: taskSpec.checks[0], result: "passed", evidence: [path.join(child.workDir, "candidate.txt")] }], artifacts: [path.join(child.workDir, "candidate.txt")] });
	await assert.rejects(f.controller.selectBranch(f.goal.runId, { parentTaskId: parent.taskId, selectedTaskId: child.taskId, rationale: "reviewed child" }), /original task must receive ordinary M07 review/);
});

test("M07 interrupt waits for in-flight delegate before writing terminal state", async (t) => {
	let entered!: () => void;
	let release!: () => void;
	const started = new Promise<void>((resolve) => { entered = resolve; });
	const held = new Promise<void>((resolve) => { release = resolve; });
	const f = await fixture(t, false, async () => { entered(); await held; });
	const delegation = f.controller.delegate(f.goal.runId, taskSpec);
	await started;
	const stopping = f.controller.interrupt(f.goal.runId, { reason: "controlled stop", returnPath: "user" });
	release();
	const returned = await delegation;
	assert.equal(returned.status, "returned");
	const terminal = await stopping;
	assert.equal(terminal.lifecycle, "finished");
	assert.equal(terminal.outcome, "blocked");
	assert.equal((await f.controller.status(f.goal.runId)).lifecycle, "finished");
});
