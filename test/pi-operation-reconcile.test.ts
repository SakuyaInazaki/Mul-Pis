import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { ResearchService } from "../src/pi/service.ts";
import { FakeSessionRunner } from "../src/runner/fake.ts";
import type { CurrentGoal, TaskSpecInput } from "../src/m07/types.ts";

const execute: TaskSpecInput = { objective: "one authorized external action", inputs: [],
	expectedOutputs: ["result.txt"], checks: ["observe result"], mode: "execute" };

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

test("not-issued host reconciliation permits the same execute delegation", async (t) => {
	const f = await failedGoal(t);
	const receipt = path.join(f.root, "not-issued-receipt.json");
	const runner = new FakeSessionRunner(async ({ spec }) => {
		if (spec.tools.kind === "execution") await writeFile(path.join(spec.tools.root, "result.txt"), "new work\n");
		return "completed";
	});
	const service = new ResearchService({ defaultWorkspace: f.root, runnerFactory: () => runner,
		operationReconciler: async (request) => {
			await writeFile(receipt, JSON.stringify({ version: 1, operationId: request.operation.id,
				observationMethod: "external-query", observedStatus: "not-issued",
				observedAt: new Date().toISOString() }));
			return receipt;
		} });
	const next = await service.delegate(f.goalRunId, execute, f.root) as { status: string; taskId: string };
	assert.equal(next.status, "returned");
	assert.equal(next.taskId, "T002");
	assert.equal(runner.created.filter((spec) => spec.tools.kind === "execution").length, 1);
	const settled = await service.goalStatus(f.goalRunId, f.root) as CurrentGoal;
	assert.equal(settled.executionState!.operations[0].status, "not-issued");
	assert.equal(settled.executionState!.operations[1].status, "response-received");
});

test("host callback errors and mismatched receipts leave the operation unresolved", async (t) => {
	const f = await failedGoal(t);
	const throwing = new ResearchService({ defaultWorkspace: f.root,
		operationReconciler: async () => { throw new Error("query unavailable"); } });
	await assert.rejects(throwing.reconcileOperation(f.goalRunId, f.operation.id, f.root), /query unavailable/);
	const receipt = path.join(f.root, "wrong-operation.json");
	await writeFile(receipt, JSON.stringify({ version: 1, operationId: "O999",
		observationMethod: "external-query", observedStatus: "confirmed",
		observedAt: new Date().toISOString(), externalId: "remote-id" }));
	const wrong = new ResearchService({ defaultWorkspace: f.root,
		operationReconciler: async () => receipt });
	await assert.rejects(wrong.reconcileOperation(f.goalRunId, f.operation.id, f.root), /operationId|对账回执/);
	assert.equal((await wrong.goalStatus(f.goalRunId, f.root) as CurrentGoal).executionState!.operations[0].status, "unknown");
});
