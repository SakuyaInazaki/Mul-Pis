import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { ResearchService } from "../src/pi/service.ts";
import { FakeSessionRunner } from "../src/runner/fake.ts";
import type { CurrentGoal, TaskSpecInput } from "../src/m07/types.ts";

const execute: TaskSpecInput = { objective: "one authorized external action", inputs: [],
	expectedOutputs: ["result.txt"], checks: ["observe result"], mode: "execute",
	subjectProfile: { operatorCategory: "norm-reduce" as const, implementationSpace: "handwritten-low-level" as const, rationale: "test fixture", baselineStrength: "none" as const } };

async function failedGoal(t: TestContext) {
	const root = await mkdtemp(path.join(tmpdir(), "pre-rsi-host-reconcile-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	await mkdir(path.join(root, "problem"), { recursive: true });
	await writeFile(path.join(root, "problem", "problem.md"), "General bounded question\n");
	await writeFile(path.join(root, "research.config.json"), JSON.stringify({
		roles: { execution: "fake/execution", reviewer: "fake/reviewer" }, concurrency: 1, tools: {},
	}));
	let issued = 0;
	const failing = new ResearchService({ defaultWorkspace: root,
		runnerFactory: () => new FakeSessionRunner(({ spec }) => {
			if (spec.tools.kind === "execution") { issued++; throw new Error("lost response"); }
			return "read-only check";
		}) });
	await failing.init(root);
	const goal = await failing.goalAction("begin", root, { goal: "General goal", problemRelation: "direct",
		constraints: ["preserve objective"], successCriteria: ["observed result"],
		plan: "make one bounded attempt", exploratory: true }) as CurrentGoal;
	const first = await failing.delegate(goal.runId, execute, root) as { status: string };
	assert.equal(first.status, "failed");
	const persisted = await failing.goalStatus(goal.runId, root) as CurrentGoal;
	const operation = persisted.executionState!.operations[0];
	assert.equal(operation.status, "unknown");
	return { root, goalRunId: goal.runId, operation, getIssued: () => issued, failing };
}

test("host reconciliation is unavailable by default, and status or read-only work cannot clear unknown", async (t) => {
	const f = await failedGoal(t);
	await assert.rejects(f.failing.reconcileOperation(f.goalRunId, f.operation.id, f.root),
		/error|对账能力|reconcile/i);
	const status = await f.failing.goalStatus(f.goalRunId, f.root) as CurrentGoal;
	assert.equal(status.executionState!.operations[0].status, "unknown");
	const check = await f.failing.delegate(f.goalRunId, { objective: "inspect", inputs: [],
		expectedOutputs: [], checks: ["read"], mode: "check" }, f.root) as { status: string };
	assert.equal(check.status, "returned");
	assert.equal(f.getIssued(), 1);
	await assert.rejects(f.failing.delegate(f.goalRunId, execute, f.root), /副作用状态未知/);
	assert.equal(f.getIssued(), 1);
});

test("confirmed host reconciliation returns before a new execute task; wrong or failed observations preserve the gate", async (t) => {
	const f = await failedGoal(t);
	const receipt = path.join(f.root, "host-query-receipt.json");
	let observations = 0;
	let observedStatus: "unknown" | "confirmed" = "unknown";
	const successfulRunner = new FakeSessionRunner(async ({ spec }) => {
		if (spec.tools.kind === "execution") await writeFile(path.join(spec.tools.root, "result.txt"), "new work\n");
		return "completed";
	});
	const service = new ResearchService({ defaultWorkspace: f.root,
		runnerFactory: () => successfulRunner,
		operationReconciler: async (request) => {
			observations++;
			assert.equal(request.workspace, f.root);
			assert.equal(request.runId, f.goalRunId);
			assert.equal(request.operation.id, f.operation.id);
			assert.equal(request.task.taskId, f.operation.taskId);
			await writeFile(receipt, JSON.stringify({ version: 1, operationId: request.operation.id,
				observationMethod: "external-query", observedStatus,
				observedAt: new Date().toISOString(),
				...(observedStatus === "confirmed" ? { externalId: "independent-remote-id" } : {}) }));
			return receipt;
		} });
	await service.goalStatus(f.goalRunId, f.root);
	const readOnly = await service.delegate(f.goalRunId, { objective: "inspect", inputs: [],
		expectedOutputs: [], checks: ["read"], mode: "check" }, f.root);
	assert.ok(readOnly);
	assert.equal(observations, 0);
	await assert.rejects(service.delegate(f.goalRunId, execute, f.root), /副作用状态未知/);
	assert.equal(observations, 1);
	assert.equal(f.getIssued(), 1);
	observedStatus = "confirmed";
	const before = await service.goalStatus(f.goalRunId, f.root) as CurrentGoal;
	const sessionCount = successfulRunner.created.length;
	await assert.rejects(service.delegate(f.goalRunId, execute, f.root), (error: unknown) => {
		assert.equal((error as { code?: string }).code, "m07.operation-confirmed");
		assert.match(String(error), new RegExp(f.operation.id));
		assert.match(String(error), new RegExp(f.operation.taskId));
		assert.match(String(error), /operation-receipts/);
		return true;
	});
	assert.equal(successfulRunner.created.length, sessionCount, "confirmed reconciliation must not issue an execution session");
	const reconciled = await service.goalStatus(f.goalRunId, f.root) as CurrentGoal;
	assert.equal(reconciled.tasks.length, before.tasks.length, "confirmed reconciliation must not create a task");
	assert.equal(reconciled.executionState!.operations.length, before.executionState!.operations.length);
	assert.equal(reconciled.executionState!.operations[0].status, "confirmed");
	assert.match(await readFile(reconciled.executionState!.operations[0].evidencePath!, "utf8"), /independent-remote-id/);
	const next = await service.delegate(f.goalRunId, execute, f.root) as { status: string; taskId: string };
	assert.equal(next.status, "returned");
	assert.equal(next.taskId, "T003");
	assert.equal(observations, 2);
	assert.equal(f.getIssued(), 1, "original lost-response action was not replayed");
	const settled = await service.goalStatus(f.goalRunId, f.root) as CurrentGoal;
	assert.equal(settled.executionState!.operations[0].status, "confirmed");
	assert.equal(settled.tasks[0].status, "failed");
	assert.match(await readFile(settled.executionState!.operations[0].evidencePath!, "utf8"), /independent-remote-id/);
});

test("configured candidate feedback is available through ordinary service delegation", async t => {
	const root = await mkdtemp(path.join(tmpdir(), "operator-host-feedback-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	await mkdir(path.join(root, "problem"), { recursive: true });
	await writeFile(path.join(root, "problem", "problem.md"), "Optimize an operator\n");
	await writeFile(path.join(root, "research.config.json"), JSON.stringify({
		roles: { execution: "fake/execution", reviewer: "fake/reviewer" }, concurrency: 1, tools: {} }));
	let actualTools: string[] = [];
	const runner = new FakeSessionRunner(async ({ spec }) => {
		if (spec.tools.kind === "execution") {
			actualTools = spec.tools.extraTools?.map(tool => tool.name) ?? [];
			await writeFile(path.join(spec.tools.root, "result.txt"), "evidence");
		}
		return "done";
	});
	const service = new ResearchService({ defaultWorkspace: root, runnerFactory: () => runner,
		candidateVerifier: { id: "host:configured", version: "1", async verifyTask() {
			throw new Error("an empty episode must not run an evaluation");
		} } });
	await service.init(root);
	const status = await service.status(root);
	assert.equal(status.candidateFeedback?.configured, true);
	const goal = await service.goalAction("begin", root, { goal: "Optimize", problemRelation: "direct",
		constraints: ["Preserve the original operator semantics"], successCriteria: ["original target"], plan: "explore", exploratory: true }) as CurrentGoal;
	const task = await service.delegate(goal.runId, execute, root) as CurrentGoal["tasks"][number];
	assert.equal(task.status, "returned");
	assert.deepEqual(task.executionLoop, { mode: "candidate-episode" });
	for (const name of ["candidate_evaluate", "candidate_list", "candidate_read", "candidate_checkout", "knowledge_select", "knowledge_read"])
		assert.ok(actualTools.includes(name), `${name} must reach the real execution grant`);
	assert.equal(runner.created.length, 1, "ordinary feedback episodes do not launch a report reviewer after every experiment");
});

test("host task admission rejects an off-subject delegate before task files or runner and admits the current subject", async t => {
	const root = await mkdtemp(path.join(tmpdir(), "operator-task-admission-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	await mkdir(path.join(root, "problem"), { recursive: true });
	await writeFile(path.join(root, "problem", "problem.md"), "Optimize the authorized subject\n");
	await writeFile(path.join(root, "research.config.json"), JSON.stringify({
		roles: { execution: "fake/execution", reviewer: "fake/reviewer" }, concurrency: 1, tools: {} }));
	const runner = new FakeSessionRunner(async ({ spec }) => {
		if (spec.tools.kind === "execution") await writeFile(path.join(spec.tools.root, "result.txt"), "evidence");
		return "done";
	});
	const admitted: string[] = [];
	const service = new ResearchService({ defaultWorkspace: root, runnerFactory: () => runner,
		taskAdmission: async ({ goal, task, workspace }) => {
			assert.equal(workspace, root);
			assert.equal(goal.lifecycle, "active");
			admitted.push(task.subjectId ?? "missing");
			if (task.subjectId !== "subject:current") throw new Error("subject outside the authorized current scope");
		} });
	await service.init(root);
	assert.equal((await service.status(root)).taskAdmissionConfigured, true);
	const goal = await service.goalAction("begin", root, { goal: "Optimize", problemRelation: "direct",
		constraints: ["Work on the current subject"], successCriteria: ["original target"],
		plan: "evaluate the current subject", exploratory: true }) as CurrentGoal;
	await assert.rejects(service.delegate(goal.runId, { ...execute, subjectId: "subject:other" }, root),
		/subject outside the authorized current scope/);
	assert.deepEqual(admitted, ["subject:other"]);
	assert.equal(runner.created.length, 0);
	assert.equal((await service.goalStatus(goal.runId, root) as CurrentGoal).tasks.length, 0);
	await assert.rejects(stat(path.join(root, "stages", "M07", goal.runId, "tasks", "T001")), { code: "ENOENT" });
	const task = await service.delegate(goal.runId, { ...execute, subjectId: "subject:current" }, root) as CurrentGoal["tasks"][number];
	assert.equal(task.status, "returned");
	assert.equal(task.taskId, "T001");
	assert.equal(task.subjectId, "subject:current");
	assert.equal(runner.created.length, 1);
});
