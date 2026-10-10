import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { createFileKnowledgeStore } from "../src/knowledge/store.ts";
import { createM07Controller } from "../src/m07/controller.ts";
import { goalLineageFile, localLineageHash, missionLineageFile,
	readLocalDispatchLineage, recordLocalDispatchLineage,
	type LocalDispatchLineageV1 } from "../src/m07/local-dispatch-lineage.ts";
import { createLocalM07Adapter, createLocalM07Adapters, LOCAL_M07_EXECUTE_SCOPE,
	LOCAL_M07_MISSION_BINDING_PREFIX, LOCAL_M07_REASON_SCOPE } from "../src/m07/local-m07-adapter.ts";
import type { LocalObjectiveFrozenEvidence } from "../src/m07/local-original-objective.ts";
import { createOriginalObjective } from "../src/m07/objective-progress.ts";
import type { M07Controller } from "../src/m07/types.ts";
import { FakeSessionRunner, type FakeReplyFn } from "../src/runner/fake.ts";
import type { StageContext } from "../src/stages/context.ts";
import { runM04 } from "../src/stages/m04.ts";
import { Workspace } from "../src/workspace.ts";

async function fixture(t: TestContext, reply?: FakeReplyFn, withBaseline = true) {
	const root = await mkdtemp(path.join(tmpdir(), "local-m07-adapter-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const ws = new Workspace(root);
	await mkdir(ws.rawDir, { recursive: true });
	await writeFile(ws.problemFile, "User's original local problem\n");
	await writeFile(path.join(ws.rawDir, "material.md"), "Frozen local material\n");
	const snapshotRoot = path.join(root, "host-snapshot");
	await mkdir(snapshotRoot);
	const evidenceFile = path.join(snapshotRoot, "original-problem.txt");
	await writeFile(evidenceFile, "User's original local problem\n");
	const contract = createOriginalObjective({ goal: "Answer the complete local problem",
		goalSource: "verbatim-private-input", inputNames: ["original-problem.txt"],
		obligations: [{ id: "original-check", description: "Provide evidence for the original claim" }],
		closure: "open-ended" });
	const contractFile = path.join(snapshotRoot, "original-objective.json");
	await writeFile(contractFile, JSON.stringify(contract));
	const frozen = { contractFile, evidenceRoot: snapshotRoot,
		evidence: [{ name: "original-problem.txt", file: evidenceFile }],
		capabilities: [{ scope: LOCAL_M07_REASON_SCOPE, available: true,
			description: "Read-only local M07 research", limits: [] }],
		selectedArtifacts: [], unresolvedOperationIds: [] } as LocalObjectiveFrozenEvidence;
	const store = createFileKnowledgeStore(ws.knowledgeDir);
	await store.init();
	if (withBaseline) {
		const baseline = await ws.startRun("M04", []);
		await ws.finishRun(baseline, "completed");
	}
	const runner = new FakeSessionRunner(reply ?? (({ spec }) =>
		spec.label === "M04-research" ? "Read the frozen checkpoint; no knowledge proposal." :
		"Unverified local research report. The original check remains open."));
	const ctx: StageContext = { ws, store, runner,
		config: { roles: { execution: "fake/execution", reviewer: "fake/reviewer",
			research: "fake/research" }, concurrency: 1, tools: {} } };
	const controller = createM07Controller(ctx);
	const task = { objective: "Investigate the original claim", addresses: ["original-check"],
		adapterScope: LOCAL_M07_REASON_SCOPE };
	return { root, ws, ctx, runner, controller, frozen, contract, task };
}

test("built-in local M07 keeps a reason report unaccepted and gives M04 a fresh frozen checkpoint", async t => {
	const f = await fixture(t);
	const adapter = createLocalM07Adapter();
	assert.equal(adapter.scope, LOCAL_M07_REASON_SCOPE);
	const result = await adapter.advance({ ctx: f.ctx, controller: f.controller,
		runM04, contract: f.contract, frozen: f.frozen, task: f.task });
	assert.deepEqual(result.acceptedTaskIds, []);
	assert.equal(result.outcome, "partial");
	assert.equal(result.selectedTaskId, undefined);
	const goal = await f.controller.status(result.runId);
	assert.equal(goal.problemRelation,
		`${LOCAL_M07_MISSION_BINDING_PREFIX}${f.contract.id}\n${f.contract.goal}`);
	assert.equal(goal.tasks.length, 1);
	assert.equal(goal.tasks[0].mode, "reason");
	assert.deepEqual(goal.tasks[0].checks, [f.contract.obligations[0].description]);
	assert.equal(goal.tasks[0].status, "rejected");
	assert.deepEqual(goal.tasks[0].review?.checks.map(check => check.result), ["not_run"]);
	assert.equal(goal.checkpoints?.length, 1);
	const checkpoint = goal.checkpoints![0];
	assert.match(await readFile(checkpoint.feedbackPath, "utf8"), /original claim|original local problem/i);
	const snapshot = JSON.parse(await readFile(checkpoint.goalSnapshotPath, "utf8"));
	assert.equal(snapshot.tasks[0].review.artifacts.length, 1);
	assert.match(await readFile(snapshot.tasks[0].reportPath, "utf8"), /Unverified local research report/);
	const m04 = await f.ws.latestRun("M04");
	assert.equal(m04?.status, "completed");
	assert.equal(m04?.outputs.some(item => item.label === "M07 处理来源"), true);
	const spec = f.runner.created.find(item => item.label === "M04-research");
	assert.ok(spec);
	assert.equal(spec.tools.kind, "read-dir");
	if (spec.tools.kind === "read-dir") assert.equal(spec.tools.root, checkpoint.rootDir);
});

test("failed reason task is checkpointed as UNKNOWN and never dispatched to M04", async t => {
	const f = await fixture(t, ({ spec }) => {
		if (spec.label.startsWith("M07-")) throw new Error("uncertain provider boundary");
		return "No scientific proposal";
	});
	const adapter = createLocalM07Adapter();
	const result = await adapter.advance({ ctx: f.ctx, controller: f.controller,
		runM04, contract: f.contract, frozen: f.frozen, task: f.task });
	assert.equal(result.outcome, "unknown");
	assert.deepEqual(result.acceptedTaskIds, []);
	assert.deepEqual(result.unresolvedOperationRefs, [`${result.runId}/T001`]);
	const goal = await f.controller.status(result.runId);
	assert.equal(goal.tasks[0].status, "failed");
	assert.equal(goal.checkpoints?.length, 1);
	assert.match(goal.checkpoints![0].feedbackStatus, /^(complete|indexed)$/);
	assert.equal(path.basename(goal.checkpoints![0].feedbackPath), "m04-feedback.md");
	assert.match(await readFile(goal.checkpoints![0].feedbackPath, "utf8"), /M07|目标/);
	assert.equal(f.runner.created.some(spec => spec.label === "M04-research"), false);
	const held = { ...f.frozen, unresolvedOperationIds: result.unresolvedOperationRefs };
	await assert.rejects(adapter.advance({ ctx: f.ctx, controller: f.controller,
		runM04, contract: f.contract, frozen: held, task: f.task }), /reconciled operations/);
	assert.equal((await f.ws.listRuns("M07")).length, 1);
});

test("workspace material drift prevents M04 judgment on a mismatched checkpoint", async t => {
	let rawFile = "";
	const f = await fixture(t, async ({ spec }) => {
		if (spec.label.startsWith("M07-")) {
			await writeFile(rawFile, "Changed after the reason task began\n");
			return "A partial report";
		}
		return "No proposal";
	});
	rawFile = path.join(f.ws.rawDir, "material.md");
	await assert.rejects(createLocalM07Adapter().advance({ ctx: f.ctx, controller: f.controller,
		runM04, contract: f.contract, frozen: f.frozen, task: f.task }), /checkpoint changed the frozen workspace materials/);
	assert.equal(f.runner.created.some(spec => spec.label === "M04-research"), false);
});

test("execute scope needs host availability, then delegates an actual writable M07 task", async t => {
	let executionGrantObserved = false;
	const f = await fixture(t, async ({ spec }) => {
		if (spec.label.startsWith("M07-")) {
			executionGrantObserved = spec.tools.kind === "execution";
			if (spec.tools.kind === "execution") {
				await mkdir(path.join(spec.tools.root, "deliverable"));
				await writeFile(path.join(spec.tools.root, "deliverable", "result.txt"),
					"Unverified local candidate\n");
			}
			return "Unverified candidate report";
		}
		return "No knowledge proposal";
	});
	const [reason, execute] = createLocalM07Adapters();
	assert.equal(reason.scope, LOCAL_M07_REASON_SCOPE);
	assert.equal(execute.scope, LOCAL_M07_EXECUTE_SCOPE);
	const task = { ...f.task, adapterScope: LOCAL_M07_EXECUTE_SCOPE };
	await assert.rejects(execute.advance({ ctx: f.ctx, controller: f.controller,
		runM04, contract: f.contract, frozen: f.frozen, task }), /task-root-bash opt-in/);
	assert.equal((await f.ws.listRuns("M07")).length, 0);
	// A forged or stale capability must not override the current workspace policy.
	const frozen = { ...f.frozen, capabilities: [...f.frozen.capabilities,
		{ scope: LOCAL_M07_EXECUTE_SCOPE, available: true,
			description: "Synthetic task-root tools with bash, not an OS sandbox", limits: [] }] };
	await assert.rejects(execute.advance({ ctx: f.ctx, controller: f.controller,
		runM04, contract: f.contract, frozen, task }), /task-root-bash opt-in/);
	assert.equal((await f.ws.listRuns("M07")).length, 0);
	f.ctx.config.localMission = { execution: "task-root-bash" };
	await assert.rejects(execute.advance({ ctx: f.ctx, controller: f.controller,
		runM04, contract: f.contract, frozen: f.frozen, task }), /trusted local capability/);
	assert.equal((await f.ws.listRuns("M07")).length, 0);
	const result = await execute.advance({ ctx: f.ctx, controller: f.controller,
		runM04, contract: f.contract, frozen, task });
	assert.equal(executionGrantObserved, true);
	assert.equal(result.outcome, "partial");
	assert.deepEqual(result.acceptedTaskIds, []);
	assert.equal(result.selectedTaskId, undefined);
	const goal = await f.controller.status(result.runId);
	assert.equal(goal.tasks[0].mode, "execute");
	assert.deepEqual(goal.tasks[0].expectedOutputs, ["deliverable"]);
	assert.equal(goal.tasks[0].status, "rejected");
	assert.equal(goal.tasks[0].review?.checks[0].result, "not_run");
	assert.equal(goal.checkpoints?.length, 1);
	const frozenGoal = JSON.parse(await readFile(goal.checkpoints![0].goalSnapshotPath, "utf8"));
	assert.equal(frozenGoal.tasks[0].review.artifacts.length >= 2, true);
});

test("first local task is explicitly exploratory until M04 creates a formal baseline", async t => {
	const f = await fixture(t, undefined, false);
	const result = await createLocalM07Adapter().advance({ ctx: f.ctx,
		controller: f.controller, runM04, contract: f.contract,
		frozen: f.frozen, task: f.task });
	assert.equal(result.outcome, "partial");
	const goal = await f.controller.status(result.runId);
	assert.equal(goal.exploratory, true);
	assert.equal(goal.formalBaseline, false);
	assert.equal((await f.ws.latestRun("M04"))?.status, "completed");
});

test("failed execute prompt holds the exact task and M07 operation for reconciliation", async t => {
	const f = await fixture(t, ({ spec }) => {
		if (spec.label.startsWith("M07-")) throw new Error("execute outcome unavailable");
		return "No proposal";
	});
	const execute = createLocalM07Adapter("execute");
	const frozen = { ...f.frozen, capabilities: [...f.frozen.capabilities,
		{ scope: LOCAL_M07_EXECUTE_SCOPE, available: true,
			description: "Synthetic task-root tools with bash, not an OS sandbox", limits: [] }] };
	f.ctx.config.localMission = { execution: "task-root-bash" };
	const result = await execute.advance({ ctx: f.ctx, controller: f.controller,
		runM04, contract: f.contract, frozen,
		task: { ...f.task, adapterScope: LOCAL_M07_EXECUTE_SCOPE } });
	assert.equal(result.outcome, "unknown");
	assert.deepEqual(result.unresolvedOperationRefs,
		[`${result.runId}/T001`, `${result.runId}/O001`]);
	assert.equal(f.runner.created.some(spec => spec.label === "M04-research"), false);
	const checkpoint = (await f.controller.status(result.runId)).checkpoints?.[0];
	assert.ok(checkpoint);
	assert.match(checkpoint.feedbackStatus, /^(complete|indexed)$/);
	assert.equal(path.basename(checkpoint.feedbackPath), "m04-feedback.md");
	assert.match(await readFile(checkpoint.feedbackPath, "utf8"), /M07|目标/);
});

test("execute rechecks workspace policy immediately before task delegation", async t => {
	const f = await fixture(t);
	f.ctx.config.localMission = { execution: "task-root-bash" };
	const frozen = { ...f.frozen, capabilities: [...f.frozen.capabilities,
		{ scope: LOCAL_M07_EXECUTE_SCOPE, available: true,
			description: "Synthetic task-root tools with bash, not an OS sandbox", limits: [] }] };
	const controller: M07Controller = { ...f.controller,
		begin: async (input, options) => {
			const goal = await f.controller.begin(input, options);
			delete f.ctx.config.localMission;
			return goal;
		} };
	await assert.rejects(createLocalM07Adapter("execute").advance({ ctx: f.ctx,
		controller, runM04, contract: f.contract, frozen,
		task: { ...f.task, adapterScope: LOCAL_M07_EXECUTE_SCOPE } }), /task-root-bash opt-in/);
	assert.equal((await f.ws.listRuns("M07")).length, 1);
	assert.equal(f.runner.created.some(spec => spec.label.startsWith("M07-")), false);
});

test("lineage hook runs after durable task allocation and before any runner session", async t => {
	const f = await fixture(t);
	f.ctx.config.localMission = { execution: "task-root-bash" };
	const frozen = { ...f.frozen, capabilities: [...f.frozen.capabilities,
		{ scope: LOCAL_M07_EXECUTE_SCOPE, available: true,
			description: "Synthetic task-root tools", limits: [] }] };
	let called = 0;
	await assert.rejects(createLocalM07Adapter("execute").advance({ ctx: f.ctx,
		controller: f.controller, runM04, contract: f.contract, frozen,
		task: { ...f.task, adapterScope: LOCAL_M07_EXECUTE_SCOPE },
		recordDispatchLineage: async (runId, taskId) => {
			called++;
			const persisted = await f.controller.status(runId);
			assert.equal(persisted.tasks.length, 1);
			assert.equal(persisted.tasks[0].taskId, taskId);
			assert.equal(persisted.tasks[0].status, "running");
			assert.equal(persisted.tasks[0].session, undefined);
			assert.deepEqual(persisted.executionState?.operations.map(operation =>
				({ taskId: operation.taskId, status: operation.status })),
				[{ taskId, status: "prepared" }]);
			throw new Error("synthetic lineage failure");
		} }), /synthetic lineage failure/);
	assert.equal(called, 1);
	assert.equal(f.runner.created.length, 0);
});

test("partial lineage write stops dispatch and retry completes the same edge once", async t => {
	const f = await fixture(t);
	const missionRoot = path.join(f.root, "synthetic-mission");
	const intentId = "synthetic-intent";
	let lineage: LocalDispatchLineageV1 | undefined;
	let m07Dir = "";
	await assert.rejects(createLocalM07Adapter().advance({ ctx: f.ctx,
		controller: f.controller, runM04, contract: f.contract, frozen: f.frozen,
		task: f.task, recordDispatchLineage: async (runId, taskId) => {
			m07Dir = f.ws.runDir("M07", runId);
			const task = (await f.controller.status(runId)).tasks.find(item => item.taskId === taskId)!;
			const owner = { hostId: "synthetic-host", bootId: "synthetic-boot",
				pid: 1, processStartToken: "synthetic-start" };
			lineage = { version: 1, kind: "local-mission-m07-dispatch-lineage",
				missionId: f.contract.id, intentId,
				oldAttempt: { version: 1, missionId: f.contract.id, attemptId: "A001",
					predecessorAttemptId: null, codeRevision: "synthetic", process: owner },
				intentCheckpoint: { sequence: 1, sha256: "a".repeat(64) },
				m07RunId: runId, taskId, assessorTaskSha256: "b".repeat(64),
				m07TaskInputsSha256: localLineageHash(JSON.stringify(task.inputs)),
				m07TaskChecksSha256: localLineageHash(JSON.stringify(task.checks)),
				m07Owner: owner };
			await mkdir(goalLineageFile(m07Dir));
			await recordLocalDispatchLineage({ missionRoot, m07Dir, lineage });
		} }), /EISDIR|directory/);
	assert.equal(f.runner.created.length, 0);
	assert.ok(lineage);
	const firstBytes = await readFile(missionLineageFile(missionRoot, intentId));
	await rm(goalLineageFile(m07Dir), { recursive: true });
	await recordLocalDispatchLineage({ missionRoot, m07Dir, lineage });
	await recordLocalDispatchLineage({ missionRoot, m07Dir, lineage });
	assert((await readFile(missionLineageFile(missionRoot, intentId))).equals(firstBytes));
	assert.equal((await readLocalDispatchLineage({ missionRoot, m07Dir, intentId })).lineage.taskId,
		lineage.taskId);
	assert.equal((await readdir(path.join(missionRoot, "dispatch-links"))).length, 2);
});
