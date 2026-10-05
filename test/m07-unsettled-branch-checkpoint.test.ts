import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { offlineChecks } from "../scripts/manual-private-campaign.ts";
import { createFileKnowledgeStore } from "../src/knowledge/store.ts";
import { createM07Controller } from "../src/m07/controller.ts";
import { createOriginalObjective, objectiveProgress, writeObjectiveProgress, writeOriginalObjectiveContract } from "../src/m07/objective-progress.ts";
import { FakeSessionRunner } from "../src/runner/fake.ts";
import type { StageContext } from "../src/stages/context.ts";
import { HarnessError } from "../src/types.ts";
import { Workspace } from "../src/workspace.ts";

test("failed fork prompt leaves parent evidence intact but cannot select across unknown operation", async t => {
	const root = await mkdtemp(path.join(tmpdir(), "m07-failed-fork-"));
	t.after(async () => rm(root, { recursive: true, force: true }));
	const ws = new Workspace(root);
	await mkdir(path.dirname(ws.problemFile), { recursive: true });
	await writeFile(ws.problemFile, "Generic bounded task\n");
	const store = createFileKnowledgeStore(ws.knowledgeDir);
	await store.init();
	const baseline = await ws.startRun("M04", []);
	await ws.finishRun(baseline, "completed");
	const runner = new FakeSessionRunner(async ({ spec }) => {
		if (spec.tools.kind === "execution") {
			await writeFile(path.join(spec.tools.root, "candidate.cpp"), spec.label.includes("T002") ? "// child partial\n" : "// parent verified\n");
			await writeFile(path.join(spec.tools.root, "verification.json"), JSON.stringify({ status: "passed" }));
			if (spec.label.includes("T002")) throw new HarnessError("runner.model", "provider result was unavailable after a partial prompt");
		}
		return "bounded report";
	});
	const controller = createM07Controller({ ws, store, runner, config: {
		roles: { execution: "fake/execution", reviewer: "fake/reviewer" }, concurrency: 1, tools: {},
	} } as StageContext);
	const goal = await controller.begin({ goal: "Evaluate bounded candidates", problemRelation: "Generic task",
		constraints: ["Keep the task fixed"], successCriteria: ["Candidate checked"], plan: "Compare two candidates" });
	const spec = { objective: "Produce candidate", inputs: [], expectedOutputs: ["candidate.cpp", "verification.json"],
		checks: ["Candidate checked"], mode: "execute" as const };
	const parent = await controller.delegate(goal.runId, spec);
	assert.equal(parent.status, "returned");
	assert.ok(parent.branchSource, parent.branchUnavailableReason ?? "missing checkpoint");
	const reviewed = await controller.review(goal.runId, { taskId: parent.taskId,
		checks: [{ criterion: spec.checks[0], result: "passed", evidence: [path.join(parent.workDir, "candidate.cpp")] }],
		artifacts: [path.join(parent.workDir, "candidate.cpp"), path.join(parent.workDir, "verification.json")] });
	assert.equal(reviewed.status, "accepted");
	const child = await controller.delegate(goal.runId, { ...spec, context: { mode: "fork", parentRunId: goal.runId,
		parentTaskId: parent.taskId, checkpointId: parent.branchSource.checkpoint.id } });
	assert.equal(child.status, "failed");
	const persisted = await controller.status(goal.runId);
	assert.equal(persisted.tasks.find(item => item.taskId === parent.taskId)?.status, "accepted");
	assert.equal(persisted.tasks.find(item => item.taskId === parent.taskId)?.review?.frozenReportPath,
		reviewed.review?.frozenReportPath);
	assert.equal(persisted.executionState?.operations.find(item => item.taskId === child.taskId)?.status, "unknown");
	assert.deepEqual(persisted.branchSelections ?? [], []);
	await assert.rejects(controller.selectBranch(goal.runId, { parentTaskId: parent.taskId,
		selectedTaskId: parent.taskId, rationale: "Parent is reviewed" }), /unresolved external operations/);

	const outputDir = path.join(root, "private-output");
	await mkdir(outputDir);
	const contract = createOriginalObjective({ goal: "Address the full generic original problem", goalSource: "user-intent-summary",
		inputNames: ["original.txt"], obligations: [{ id: "original", description: "Meet the original requirements" }],
		closure: "open-ended" });
	await writeOriginalObjectiveContract(path.join(outputDir, "original-objective.json"), contract);
	const boundary = await offlineChecks.preserveUnsettledBranchCheckpoint({ ws, runId: goal.runId,
		outputDir, contract });
	assert.equal(boundary.checkpoint.objectiveOutcome, "incomplete");
	assert.equal(boundary.checkpoint.stopReason, "bounded-run-incomplete");
	assert.deepEqual(boundary.acceptedTaskIds, [parent.taskId]);
	assert.deepEqual(boundary.unresolvedOperationIds, persisted.executionState?.operations
		.filter(item => item.status === "unknown").map(item => item.id));
	assert.equal(boundary.checkpoint.continuation.requiresOperationReconciliation, true);
	assert.deepEqual(boundary.checkpoint.continuation.unresolvedOperationIds, boundary.unresolvedOperationIds);
	assert.equal(boundary.checkpoint.continuation.mode, "reconcile-operations-before-new-run");
	assert.deepEqual(boundary.checkpoint.selectedArtifacts, []);
	assert.deepEqual((await controller.status(goal.runId)).branchSelections ?? [], []);
	assert.ok(boundary.checkpoint.availableArtifacts.includes("candidate.cpp"));
	assert.equal((JSON.parse(await readFile(path.join(outputDir, "objective-checkpoint.json"), "utf8")) as typeof boundary.checkpoint)
		.stopReason, "bounded-run-incomplete");
	assert.equal(await readFile(path.join(outputDir, "candidate.cpp"), "utf8"), "// parent verified\n");
	assert.equal(await readFile(path.join(outputDir, "branch-child-candidate.cpp"), "utf8"), "// child partial\n");
	const archivedParent = JSON.parse(await readFile(path.join(outputDir, "workflow-archive.json"), "utf8")) as
		{ taskId: string; taskStatus: string; controllerEvidence: { reviewStatus: string } };
	assert.equal(archivedParent.taskId, parent.taskId);
	assert.equal(archivedParent.taskStatus, "accepted");
	assert.equal(archivedParent.controllerEvidence.reviewStatus, "accepted");
	const capped = await offlineChecks.preserveUnsettledBranchCheckpoint({ ws, runId: goal.runId,
		outputDir, contract, budgetStopReason: "total-cny-ceiling" });
	assert.equal(capped.checkpoint.stopReason, "budget-boundary");
	const pricing = await offlineChecks.preserveUnsettledBranchCheckpoint({ ws, runId: goal.runId,
		outputDir, contract, budgetStopReason: "price-assumption-invalid" });
	assert.equal(pricing.checkpoint.stopReason, "accounting-integrity-error");
	await rm(path.join(outputDir, "branch-child-candidate.cpp"));
	await rm(path.join(outputDir, "workflow-branch-child-archive.json"));
	await offlineChecks.preserveUnsettledBranchCheckpoint({ ws, runId: goal.runId, outputDir, contract });
	assert.equal(await readFile(path.join(outputDir, "candidate.cpp"), "utf8"), "// parent verified\n");
	assert.equal(await readFile(path.join(outputDir, "branch-child-candidate.cpp"), "utf8"), "// child partial\n");
	const later = await controller.begin({ goal: "Continue the unchanged original task", problemRelation: "Generic task",
		constraints: ["Keep the task fixed"], successCriteria: ["Candidate checked"], plan: "Try another bounded candidate" });
	await offlineChecks.salvageObjectiveCheckpoint(ws, outputDir, undefined, false);
	const salvaged = JSON.parse(await readFile(path.join(outputDir, "objective-checkpoint.json"), "utf8")) as typeof boundary.checkpoint;
	assert.deepEqual(salvaged.boundedRuns.map(item => item.runId).sort(), [goal.runId, later.runId].sort());
	assert.equal(salvaged.objectiveOutcome, "incomplete");
	assert.equal(salvaged.continuation.requiresOperationReconciliation, true);
	await offlineChecks.salvageObjectiveCheckpoint(ws, outputDir, undefined, true);
	const timedOut = JSON.parse(await readFile(path.join(outputDir, "objective-checkpoint.json"), "utf8")) as typeof boundary.checkpoint;
	assert.equal(timedOut.stopReason, "time-boundary");
	assert.equal(timedOut.continuation.requiresOperationReconciliation, true);
});

test("terminal timeout replaces a stale reassessment checkpoint after a completed bounded run", async t => {
	const root = await mkdtemp(path.join(tmpdir(), "m07-stale-boundary-"));
	t.after(async () => rm(root, { recursive: true, force: true }));
	const ws = new Workspace(path.join(root, "workspace"));
	const run = await ws.startRun("M07", []);
	await writeFile(path.join(ws.runDir("M07", run.runId), "goal.json"), JSON.stringify({
		runId: run.runId, lifecycle: "finished", outcome: "fulfilled", tasks: [],
		executionState: { operations: [] }, branchSelections: [],
	}));
	const outputDir = path.join(root, "private-output");
	await mkdir(outputDir);
	const contract = createOriginalObjective({ goal: "Address the complete original problem", goalSource: "user-intent-summary",
		inputNames: ["original.txt"], obligations: [{ id: "original", description: "Meet original requirements" }],
		closure: "open-ended" });
	await writeOriginalObjectiveContract(path.join(outputDir, "original-objective.json"), contract);
	await writeObjectiveProgress(path.join(outputDir, "objective-checkpoint.json"), objectiveProgress(contract, {
		boundedRuns: [{ runId: run.runId, outcome: "fulfilled" }], selectedArtifacts: [],
		stopReason: "objective-reassessment-pending",
	}));
	await offlineChecks.salvageObjectiveCheckpoint(ws, outputDir, undefined, true);
	const checkpoint = JSON.parse(await readFile(path.join(outputDir, "objective-checkpoint.json"), "utf8")) as
		{ stopReason: string; objectiveOutcome: string; boundedRuns: Array<{ runId: string }> };
	assert.equal(checkpoint.stopReason, "time-boundary");
	assert.equal(checkpoint.objectiveOutcome, "incomplete");
	assert.deepEqual(checkpoint.boundedRuns.map(item => item.runId), [run.runId]);
});
