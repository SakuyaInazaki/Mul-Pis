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

test("independent new-goal checkpoint retains quarantined historical operation IDs", () => {
	const contract = createOriginalObjective({ goal: "Continue a synthetic task", goalSource: "user-intent-summary",
		inputNames: ["synthetic.txt"], obligations: [{ id: "original", description: "Satisfy synthetic task" }],
		closure: "open-ended" });
	const progress = offlineChecks.campaignObjectiveProgress(contract, ["prior-run/O002"], {
		boundedRuns: [{ runId: "prior-run", outcome: "active", unresolvedOperationIds: ["prior-run/O002"] },
			{ runId: "fresh-run", outcome: "partial" }],
		selectedArtifacts: ["candidate.cpp", "verification.json", "workflow-archive.json"],
		stopReason: "bounded-run-incomplete" });
	assert.deepEqual(progress.continuation.unresolvedOperationIds, ["prior-run/O002"]);
	assert.equal(progress.continuation.requiresOperationReconciliation, true);
	assert.equal(progress.boundedRuns[0].outcome, "active");
	const later = offlineChecks.campaignObjectiveProgress(contract, progress.continuation.unresolvedOperationIds, {
		boundedRuns: progress.boundedRuns, selectedArtifacts: progress.selectedArtifacts,
		unresolvedOperationIds: ["fresh-run/O003"], stopReason: "bounded-run-incomplete" });
	assert.deepEqual(later.continuation.unresolvedOperationIds, ["prior-run/O002", "fresh-run/O003"]);
});

test("a duplicate bare operation ID normalizes only against its unique qualified unknown", () => {
	const contract = createOriginalObjective({ goal: "Continue a synthetic task", goalSource: "user-intent-summary",
		inputNames: ["synthetic.txt"], obligations: [{ id: "original", description: "Satisfy synthetic task" }],
		closure: "open-ended" });
	const raw = objectiveProgress(contract, { boundedRuns: [
		{ runId: "old-run", outcome: "active", unresolvedOperationIds: ["O002"] },
		{ runId: "new-run", outcome: "active", unresolvedOperationIds: ["O001"] }],
		selectedArtifacts: [], unresolvedOperationIds: ["old-run/O002", "O001", "new-run/O001"],
		stopReason: "bounded-run-incomplete" });
	assert.deepEqual(offlineChecks.canonicalUnresolvedOperationRefs(raw), ["old-run/O002", "new-run/O001"]);
	const missing = { ...raw, continuation: { ...raw.continuation,
		unresolvedOperationIds: ["old-run/O002", "O001"] } };
	assert.throws(() => offlineChecks.canonicalUnresolvedOperationRefs(missing), /bare operation lacks one active, qualified historical origin/);
	const ambiguous = { ...raw, boundedRuns: [...raw.boundedRuns,
		{ runId: "another-run", outcome: "active", unresolvedOperationIds: ["O001"] }],
		continuation: { ...raw.continuation,
			unresolvedOperationIds: [...raw.continuation.unresolvedOperationIds, "another-run/O001"] } };
	assert.throws(() => offlineChecks.canonicalUnresolvedOperationRefs(ambiguous), /bare operation lacks one active, qualified historical origin/);
});

test("failed initial task is checkpointed before finish and keeps selected prior artifacts", async t => {
	const root = await mkdtemp(path.join(tmpdir(), "m07-failed-first-task-"));
	t.after(async () => rm(root, { recursive: true, force: true }));
	const ws = new Workspace(path.join(root, "workspace"));
	const runId = "R001";
	const taskDir = path.join(root, "task");
	const outputDir = path.join(root, "output");
	await mkdir(taskDir, { recursive: true });
	await mkdir(outputDir);
	await mkdir(ws.runDir("M07", runId), { recursive: true });
	await writeFile(path.join(taskDir, "candidate.cpp"), "// unverified attempted source\n");
	await writeFile(path.join(taskDir, "experiment-plan.json"), JSON.stringify({ registeredStrategies: ["synthetic"] }));
	await writeFile(path.join(taskDir, "verification.json"), JSON.stringify({ version: 1, status: "failed",
		sourceShape: { ok: false, reason: "synthetic source gate", targetCount: 0,
			diagnostic: { kind: "csr-validation-diagnostic", phase: "source-validation", ruleId: "synthetic-rule",
				disposition: "rejected-source", source: { name: "candidate.cpp", line: 1, column: 1 },
				compilationStatus: "not_run", correctnessStatus: "not_run", measurementStatus: "not_run" } },
		compile: { success: false }, independent: { status: "not_run" },
		registeredExperiment: { status: "not_run", reason: "synthetic source gate",
			threadPolicy: { threadsMeaning: "requested-default-and-openmp-cap", actualThreads: "not_observed",
				description: "Synthetic requested thread policy" } },
		hostFeedback: { version: 1, kind: "execution-result-feedback", status: "failed",
			measurementMetric: "not_run", timingInterpretation: "No registered candidate timing was run",
			diagnostics: [{ phase: "source-boundary", detail: { kind: "csr-validation-diagnostic",
				ruleId: "synthetic-rule", source: { name: "candidate.cpp", line: 1, column: 1 } } }] } }));
	await writeFile(path.join(ws.runDir("M07", runId), "goal.json"), JSON.stringify({ runId,
		lifecycle: "active", tasks: [{ taskId: "T001", mode: "execute", status: "failed", workDir: taskDir,
			loopStopReason: "deadline", executionRounds: [] }],
		executionState: { operations: [{ id: "O001", taskId: "T001", status: "unknown" }] },
		branchSelections: [] }));
	const contract = createOriginalObjective({ goal: "Finish synthetic original objective", goalSource: "user-intent-summary",
		inputNames: ["synthetic.txt"], obligations: [{ id: "original", description: "Satisfy synthetic task" }],
		closure: "open-ended" });
	await writeOriginalObjectiveContract(path.join(outputDir, "original-objective.json"), contract);
	const prior = objectiveProgress(contract, { boundedRuns: [{ runId: "R000", outcome: "fulfilled",
		selectedTaskId: "T001" }, { runId: "R-OLD", outcome: "active", unresolvedOperationIds: ["O002"] }],
		selectedArtifacts: ["candidate.cpp", "verification.json", "workflow-archive.json"],
		unresolvedOperationIds: ["R-OLD/O002"],
		stopReason: "bounded-run-incomplete" });
	await writeObjectiveProgress(path.join(outputDir, "objective-checkpoint.json"), prior);
	const boundary = await offlineChecks.preserveUnsettledGoalCheckpoint({ ws, runId, outputDir, contract });
	assert.equal(boundary.checkpoint.objectiveOutcome, "incomplete");
	assert.deepEqual(boundary.unresolvedOperationIds, ["O001"]);
	assert.deepEqual(boundary.checkpoint.continuation.unresolvedOperationIds, ["R-OLD/O002", "R001/O001"]);
	assert.deepEqual(boundary.checkpoint.selectedArtifacts, prior.selectedArtifacts);
	assert.equal(boundary.checkpoint.continuation.requiresOperationReconciliation, true);
	assert.equal(boundary.checkpoint.boundedRuns.find(item => item.runId === runId)?.outcome, "active");
	assert.equal(await readFile(path.join(outputDir, "candidate.cpp"), "utf8"), "// unverified attempted source\n");
	assert.equal((JSON.parse(await readFile(path.join(outputDir, "workflow-archive.json"), "utf8")) as
		{ controllerEvidence: { reviewStatus: string } }).controllerEvidence.reviewStatus, "unreviewed");
	const archivedVerification = JSON.parse(await readFile(path.join(outputDir, "verification.json"), "utf8"));
	assert.equal(archivedVerification.hostFeedback.measurementMetric, "not_run");
	assert.equal(archivedVerification.hostFeedback.diagnostics[0].detail.ruleId, "synthetic-rule");
	assert.equal(archivedVerification.sourceShape.diagnostic.ruleId, "synthetic-rule");
	assert.equal(archivedVerification.sourceShape.diagnostic.source.line, 1);
	assert.equal(archivedVerification.registeredExperiment.threadPolicy.actualThreads, "not_observed");
	await offlineChecks.salvageObjectiveCheckpoint(ws, outputDir, undefined, false);
	const salvaged = JSON.parse(await readFile(path.join(outputDir, "objective-checkpoint.json"), "utf8")) as typeof boundary.checkpoint;
	assert.ok(salvaged.availableArtifacts.includes("experiment-plan.json"));
	assert.equal(salvaged.continuation.requiresOperationReconciliation, true);
	assert.deepEqual(salvaged.continuation.unresolvedOperationIds, ["R-OLD/O002", "R001/O001"]);
});

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
	assert.deepEqual(boundary.checkpoint.continuation.unresolvedOperationIds,
		boundary.unresolvedOperationIds.map(id => `${goal.runId}/${id}`));
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

test("salvage keeps a finalized model proposal when only branch artifact names are newly visible", async t => {
	const root = await mkdtemp(path.join(tmpdir(), "m07-finalized-proposal-"));
	t.after(async () => rm(root, { recursive: true, force: true }));
	const ws = new Workspace(path.join(root, "workspace"));
	const run = await ws.startRun("M07", []);
	await writeFile(path.join(ws.runDir("M07", run.runId), "goal.json"), JSON.stringify({
		runId: run.runId, lifecycle: "finished", outcome: "fulfilled", tasks: [],
		executionState: { operations: [] }, branchSelections: [],
	}));
	const outputDir = path.join(root, "private-output");
	await mkdir(outputDir);
	const contract = createOriginalObjective({ goal: "Continue the original synthetic task", goalSource: "user-intent-summary",
		inputNames: ["original.txt"], obligations: [{ id: "original", description: "Meet original requirements" }],
		closure: "open-ended" });
	await writeOriginalObjectiveContract(path.join(outputDir, "original-objective.json"), contract);
	await writeFile(path.join(outputDir, "candidate.cpp"), "// synthetic accepted source\n");
	const nextTask = { objective: "Measure a feasible new synthetic strategy", addresses: ["original"],
		adapterScope: "outside-current-adapter" as const };
	const assessment = { version: 1 as const, decision: "continue" as const,
		rationale: "The bounded pilot did not close the original task", evidenceRefs: ["candidate.cpp"],
		unresolvedObligations: ["original"], unresolvedDetails: ["Feasible experiments remain"], nextTask,
		sessionId: "synthetic-assessor", model: "fake/research",
		evidenceRead: ["original-objective.json", "original-problem.txt", "original-input-1.txt", "candidate.cpp"],
		unreadEvidence: [] };
	const prior = objectiveProgress(contract, { boundedRuns: [{ runId: run.runId, outcome: "fulfilled" }],
		selectedArtifacts: ["candidate.cpp"], assessment,
		assessmentHistory: [{ iteration: 1, assessment, stopReason: "next-task-needs-capability", advanced: false }],
		stopReason: "next-task-needs-capability" });
	await writeObjectiveProgress(path.join(outputDir, "objective-checkpoint.json"), prior);
	await writeFile(path.join(outputDir, "branch-child-candidate.cpp"), "// synthetic alternate source\n");
	await offlineChecks.salvageObjectiveCheckpoint(ws, outputDir, undefined, false);
	const checkpoint = JSON.parse(await readFile(path.join(outputDir, "objective-checkpoint.json"), "utf8")) as typeof prior;
	assert.equal(checkpoint.objectiveOutcome, "incomplete");
	assert.equal(checkpoint.stopReason, "next-task-needs-capability");
	assert.deepEqual(checkpoint.assessmentHistory, prior.assessmentHistory);
	assert.deepEqual(checkpoint.continuation.nextTask, nextTask);
	assert.deepEqual(checkpoint.selectedArtifacts, ["candidate.cpp"]);
	assert.ok(checkpoint.availableArtifacts.includes("branch-child-candidate.cpp"));
});
