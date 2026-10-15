import assert from "node:assert/strict";
import { mkdtemp, realpath, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { offlineChecks } from "../scripts/manual-private-campaign.ts";
import { createFileKnowledgeStore } from "../src/knowledge/store.ts";
import { createM07Controller } from "../src/m07/controller.ts";
import { FakeSessionRunner } from "../src/runner/fake.ts";
import type { StageContext } from "../src/stages/context.ts";
import { Workspace } from "../src/workspace.ts";

async function fixture(t: TestContext, unsafeFile = false, pauseExecution?: () => Promise<void>) {
	const root = await realpath(await mkdtemp(path.join(tmpdir(), "m07-branches-")));
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
	const scratch = f.runner.created.filter(spec => spec.tools.kind === "execution")
		.map(spec => spec.tools.kind === "execution" ? spec.tools.tempDir : undefined);
	assert.equal(new Set(scratch).size,3);
	assert.ok(scratch.every(dir => dir && !dir.startsWith(parent.workDir)));
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
