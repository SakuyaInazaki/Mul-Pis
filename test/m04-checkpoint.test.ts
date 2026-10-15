import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { createFileKnowledgeStore } from "../src/knowledge/store.ts";
import { createM07Controller } from "../src/m07/controller.ts";
import { FakeSessionRunner } from "../src/runner/fake.ts";
import type { StageContext } from "../src/stages/context.ts";
import { runM04 } from "../src/stages/m04.ts";
import { Workspace } from "../src/workspace.ts";

const begin = { goal: "检验局部结果", problemRelation: "为原问题提供证据", constraints: ["保留原边界"], successCriteria: ["形成可读证据"], plan: "先做探查" };

async function fixture(t: TestContext) {
	const root = await realpath(await mkdtemp(path.join(tmpdir(), "m04-checkpoint-")));
	t.after(() => rm(root, { recursive: true, force: true }));
	const ws = new Workspace(root);
	await mkdir(ws.rawDir, { recursive: true });
	await writeFile(ws.problemFile, "原问题版本一\n");
	await writeFile(path.join(ws.rawDir, "scope.md"), "原范围版本一\n");
	const store = createFileKnowledgeStore(ws.knowledgeDir); await store.init();
	const baseline = await ws.startRun("M04", [{ label: "原问题", path: ws.problemFile }]); await ws.finishRun(baseline, "completed");
	const runner = new FakeSessionRunner(({ spec }) => spec.label === "M04-research" ? "已处理 checkpoint；不推断全文已读。" : "task report version one");
	const ctx: StageContext = { ws, store, runner, config: { roles: { execution: "fake/execution", reviewer: "fake/reviewer", research: "fake/research" }, concurrency: 1, tools: {} } };
	return { root, ws, runner, ctx, controller: createM07Controller(ctx) };
}

test("active M07 checkpoint gives M04 only its frozen feedback, problem, and evidence directory", async (t) => {
	const f = await fixture(t);
	const goal = await f.controller.begin(begin);
	const task = await f.controller.delegate(goal.runId, { objective: "形成证据", inputs: [], expectedOutputs: [], checks: ["报告存在"], mode: "reason" });
	await f.controller.review(goal.runId, { taskId: task.taskId, artifacts: [task.reportPath!], checks: [{ criterion: "报告存在", result: "passed", evidence: [task.reportPath!] }] });
	const checkpoint = await f.controller.checkpoint(goal.runId);
	await writeFile(f.ws.problemFile, "后来改写的问题\n");
	await writeFile(path.join(f.ws.rawDir, "scope.md"), "后来改写的范围\n");
	await f.controller.plan(goal.runId, "后来改写的计划");
	await f.controller.delegate(goal.runId, { objective: "checkpoint 之后的新任务", inputs: [], expectedOutputs: [], checks: ["以后核验"], mode: "reason" });
	await assert.rejects(runM04(f.ctx, { feedback: { kind: "M07", runId: goal.runId } }), /尚未结束/);
	const result = await runM04(f.ctx, { feedback: { kind: "M07Checkpoint", runId: goal.runId, checkpointId: checkpoint.id } });
	assert.equal(result.record.status, "completed");
	assert.equal((await f.controller.status(goal.runId)).lifecycle, "active");
	const spec = f.runner.created.findLast((item) => item.label === "M04-research")!;
	assert.equal(spec.tools.kind, "read-dir");
	if (spec.tools.kind === "read-dir") assert.deepEqual({ root: spec.tools.root, name: spec.tools.toolName }, { root: checkpoint.rootDir, name: "m07_evidence_read" });
	const prompt = [...f.runner.sessions.values()].findLast((item) => item.spec.label === "M04-research")!.transcript[0].text;
	assert.match(prompt, /原问题版本一/);
	assert.match(prompt, /原范围版本一/);
	assert.doesNotMatch(prompt, /后来改写的问题|后来改写的范围|后来改写的计划|checkpoint 之后的新任务/);
	const source = JSON.parse(await readFile(result.record.outputs.find((item) => item.label === "M07 处理来源")!.path, "utf8"));
	assert.deepEqual({ runId: source.m07RunId, checkpointId: source.checkpointId, rootDir: source.rootDir }, { runId: goal.runId, checkpointId: checkpoint.id, rootDir: checkpoint.rootDir });
	assert.equal(source.goalSnapshotPath, checkpoint.goalSnapshotPath);
});

test("M04 requires the selected checkpoint's independent report in full alongside caller-selected evidence", async (t) => {
	const f = await fixture(t);
	const goal = await f.controller.begin(begin);
	const candidate = await f.controller.delegate(goal.runId, { objective: "形成候选", inputs: [], expectedOutputs: [], checks: ["报告可核查"], mode: "reason", requireIndependentCheck: true });
	const check = await f.controller.delegate(goal.runId, { objective: "独立核查候选", inputs: [candidate.reportPath!], expectedOutputs: [], checks: ["检查已完成"], mode: "check", parentTaskId: candidate.taskId });
	await writeFile(check.reportPath!, "独立检查发现决定性反证。\n结论应保留为未知。\n");
	await f.controller.review(goal.runId, { taskId: candidate.taskId, artifacts: [candidate.reportPath!],
		checks: [{ criterion: "报告可核查", result: "passed", evidence: [candidate.reportPath!] }],
		independentCheck: { taskId: check.taskId, report: check.reportPath!, disposition: "保留独立检查发现。" } });
	const checkpoint = await f.controller.checkpoint(goal.runId, { taskIds: [candidate.taskId] });
	const frozen = JSON.parse(await readFile(checkpoint.goalSnapshotPath, "utf8"));
	const selected = frozen.tasks.find((task: { taskId: string }) => task.taskId === candidate.taskId);
	const report = path.relative(checkpoint.rootDir, selected.review.independentCheck.report);
	const callerPath = path.relative(checkpoint.rootDir, selected.review.frozenReportPath);
	const manifest = JSON.parse(await readFile(checkpoint.manifestPath, "utf8"));
	assert.ok(manifest.files.some((file: { relativePath: string }) => file.relativePath === report));
	assert.ok(!frozen.checkpointScope.selectedTaskIds.includes(check.taskId), "the check task itself need not be selected");
	const fake = new FakeSessionRunner(({ spec, turnIndex, message }) => {
		if (spec.label !== "M04-research") return "task report version one";
		if (turnIndex === 1) {
			assert.ok(message.includes(report), "the independent report is in the first full-read instruction");
			return { text: "暂定采用候选。", readReturns: [{ toolName: "m07_evidence_read", status: "returned", path: callerPath,
				requested: {}, returned: { kind: "text", startLine: 1, endLine: 1, truncated: false }, at: new Date().toISOString() }] };
		}
		assert.ok(message.includes(report), "missing independent report is requested again");
		return { text: "独立反证阻止采用；没有知识提案。", readReturns: [{ toolName: "m07_evidence_read", status: "returned", path: report,
			requested: {}, returned: { kind: "text", startLine: 1, endLine: 2, truncated: false }, at: new Date().toISOString() }] };
	});
	f.ctx.runner = fake;
	const result = await runM04(f.ctx, { feedback: { kind: "M07Checkpoint", runId: goal.runId, checkpointId: checkpoint.id },
		requiredM07ReadPaths: [callerPath] });
	assert.equal(result.record.status, "completed");
	assert.equal(result.proposalId, undefined);
	const session = [...fake.sessions.values()].find((item) => item.spec.label === "M04-research")!;
	assert.equal(session.turns, 2);
	assert.deepEqual(session.readReturns.map((event) => event.path), [callerPath, report]);
});
