import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { assessLocalOperationReconciliation, assessRemoteReadResultAvailability } from "../src/m07/local-reconciliation.ts";
import { summarizeGoalExecution } from "../src/m07/status.ts";
import type { CurrentGoal } from "../src/m07/types.ts";

function goalFixture(reportPath: string, frozenReportPath: string): CurrentGoal {
	return {
		runId: "run", lifecycle: "active",
		tasks: [{ taskId: "T001", mode: "execute", sideEffectClass: "local-only", status: "accepted", returnedAt: "2026-09-26T00:00:00Z", workDir: path.dirname(reportPath), reportPath, review: { frozenReportPath } }],
		executionState: { version: 1, activeAttemptId: "A001", attempts: [], operations: [{ version: 1, id: "O001", taskId: "T001", sideEffectClass: "local-only", status: "unknown", issuedAt: "2026-09-26T00:00:00Z" }] },
	} as unknown as CurrentGoal;
}

test("local reconciliation accepts matching returned and frozen reports without certifying remote effects", async (t) => {
	const runDir = await mkdtemp(path.join(tmpdir(), "pre-rsi-local-reconcile-"));
	t.after(() => rm(runDir, { recursive: true, force: true }));
	const taskDir = path.join(runDir, "tasks", "T001");
	await mkdir(taskDir, { recursive: true });
	const reportPath = path.join(taskDir, "report.md");
	const frozenReportPath = path.join(taskDir, "review.md");
	await writeFile(reportPath, "returned local result\n");
	await writeFile(frozenReportPath, "returned local result\n");
	const goal = goalFixture(reportPath, frozenReportPath);
	const result = await assessLocalOperationReconciliation(goal, "O001", runDir);
	assert.equal(result.eligible, true);
	if (result.eligible) {
		assert.equal(result.restoredStatus, "response-received");
		assert.equal(result.auditIssue, "ledger-missing");
	}
	assert.equal(goal.executionState?.operations[0].status, "unknown", "assessment is read-only");
	await writeFile(frozenReportPath, "different result\n");
	assert.match((await assessLocalOperationReconciliation(goal, "O001", runDir)).reason, /differs/);
});

test("local reconciliation rejects unknown reported actions and evidence outside the run", async (t) => {
	const runDir = await mkdtemp(path.join(tmpdir(), "pre-rsi-local-reconcile-"));
	t.after(() => rm(runDir, { recursive: true, force: true }));
	const taskDir = path.join(runDir, "tasks", "T001");
	await mkdir(taskDir, { recursive: true });
	const reportPath = path.join(taskDir, "report.md");
	const frozenReportPath = path.join(taskDir, "review.md");
	await writeFile(reportPath, "report\n");
	await writeFile(frozenReportPath, "report\n");
	const goal = goalFixture(reportPath, frozenReportPath);
	goal.executionState!.actions = [{ version: 1, id: "A", taskId: "T001", operationId: "O001", actionId: "write", sideEffect: "remote-write", status: "unknown", boundary: "unknown", issuedAt: "2026-09-26T00:00:00Z" }];
	assert.match((await assessLocalOperationReconciliation(goal, "O001", runDir)).reason, /remote action/);
	goal.executionState!.actions = [];
	const taskLedger = path.join(taskDir, "m07-actions.json");
	await writeFile(taskLedger, JSON.stringify({ version: 1, actions: [{ actionId: "unrecorded", sideEffect: "remote-write" }] }));
	assert.match((await assessLocalOperationReconciliation(goal, "O001", runDir)).reason, /ledger declares remote actions/);
	await rm(taskLedger);
	const outside = path.join(path.dirname(runDir), "outside-review.md");
	await writeFile(outside, "report\n");
	t.after(() => rm(outside, { force: true }));
	goal.tasks[0].review!.frozenReportPath = outside;
	assert.match((await assessLocalOperationReconciliation(goal, "O001", runDir)).reason, /outside/);
});

test("unknown operation summary separates local, read, write, and unclassified, including action overrides", () => {
	const goal = goalFixture("report", "review");
	goal.executionState!.operations.push(
		{ version: 1, id: "O002", taskId: "T002", sideEffectClass: "remote-read", status: "unknown", issuedAt: "now" },
		{ version: 1, id: "O003", taskId: "T003", sideEffectClass: "remote-write", status: "unknown", issuedAt: "now" },
		{ version: 1, id: "O004", taskId: "T004", status: "unknown", issuedAt: "now" },
	);
	let summary = summarizeGoalExecution(goal);
	assert.deepEqual(summary.unresolvedLocalOperationIds, ["O001"]);
	assert.deepEqual(summary.unresolvedReadOperationIds, ["O002"]);
	assert.deepEqual(summary.unresolvedWriteOperationIds, ["O003"]);
	assert.deepEqual(summary.unresolvedUnclassifiedOperationIds, ["O004"]);
	goal.executionState!.actions = [{ version: 1, id: "A", taskId: "T001", operationId: "O001", actionId: "write", sideEffect: "remote-write", status: "unknown", boundary: "unknown", issuedAt: "now" }];
	summary = summarizeGoalExecution(goal);
	assert.deepEqual(summary.unresolvedWriteOperationIds, ["O001", "O003"]);
	assert.deepEqual(summary.unresolvedLocalOperationIds, []);
	goal.executionState!.actions[0].operationId = "O003";
	goal.executionState!.actions[0].sideEffect = "remote-read";
	assert.deepEqual(summarizeGoalExecution(goal).unresolvedWriteOperationIds, ["O003"], "declared write remains a write with unknown read action");
});

test("lost remote-read result can be marked unavailable without asserting issuance", () => {
	const goal = goalFixture("report", "review");
	goal.executionState!.operations[0].sideEffectClass = "remote-read";
	goal.tasks[0].sideEffectClass = "remote-read";
	goal.tasks[0].status = "failed";
	goal.tasks[0].executionFailure = "response lost";
	delete goal.tasks[0].reportPath;
	delete goal.tasks[0].review;
	const result = assessRemoteReadResultAvailability(goal, "O001");
	assert.equal(result.eligible, true);
	if (result.eligible) assert.equal(result.resultAvailability, "unavailable");
	assert.equal(goal.executionState!.operations[0].status, "unknown");
	goal.executionState!.actions = [{ version: 1, id: "A", taskId: "T001", operationId: "O001", actionId: "write", sideEffect: "remote-write", status: "unknown", boundary: "unknown", issuedAt: "now" }];
	assert.match(assessRemoteReadResultAvailability(goal, "O001").reason, /remote write/);
});
