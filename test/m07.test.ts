import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { createFileKnowledgeStore } from "../src/knowledge/store.ts";
import { createM07Controller } from "../src/m07/controller.ts";
import { FakeSessionRunner } from "../src/runner/fake.ts";
import type { StageContext } from "../src/stages/context.ts";
import { runM04 } from "../src/stages/m04.ts";
import { HarnessError, type HarnessConfig } from "../src/types.ts";
import { Workspace } from "../src/workspace.ts";

async function fixture(t: TestContext, withM04 = true, config?: HarnessConfig) {
	const root = await mkdtemp(path.join(tmpdir(), "pre-rsi-m07-"));
	t.after(async () => rm(root, { recursive: true, force: true }));
	const ws = new Workspace(root);
	await mkdir(path.join(root, "problem"), { recursive: true });
	await writeFile(ws.problemFile, "研究问题：机制 A 是否成立？\n");
	const store = createFileKnowledgeStore(ws.knowledgeDir); await store.init();
	if (withM04) { const baseline = await ws.startRun("M04", [{ label: "原问题", path: ws.problemFile }]); await ws.finishRun(baseline, "completed"); }
	const runner = new FakeSessionRunner(({ spec }) => spec.label === "M04-research" ? "已按实际材料处理；没有知识变更。" : `${spec.label} returned；会话返回不表示通过。`);
	const ctx: StageContext = { ws, store, runner, config: config ?? { roles: { execution: "fake/execution", reviewer: "fake/reviewer", research: "fake/research" }, concurrency: 1, tools: {} } };
	return { root, ws, store, runner, ctx, controller: createM07Controller(ctx) };
}

const begin = { goal: "检验机制 A", problemRelation: "直接回答原问题的必要部分", constraints: ["不得改变机制 A 的定义"], successCriteria: ["给出可定位证据", "执行既定检查"], plan: "先做最小区分实验，再独立检查。" };

test("begin freezes problem and baseline; exploratory must be explicit without M04", async (t) => {
	const formal = await fixture(t);
	const goal = await formal.controller.begin(begin);
	assert.equal(goal.formalBaseline, true);
	assert.ok(goal.m04BaselineRunId);
	assert.equal(await readFile(goal.problemSnapshotPath, "utf8"), "研究问题：机制 A 是否成立？\n");
	await writeFile(formal.ws.problemFile, "后来改写的问题\n");
	assert.equal((await formal.controller.status(goal.runId)).goal, begin.goal);

	const exploratory = await fixture(t, false);
	await assert.rejects(exploratory.controller.begin(begin), (e: unknown) => e instanceof HarnessError && e.code === "m07.baseline");
	const allowed = await exploratory.controller.begin({ ...begin, exploratory: true });
	assert.equal(allowed.formalBaseline, false);
});

test("delegate is fresh and returned is not accepted; retry is a new retained task", async (t) => {
	const f = await fixture(t); const goal = await f.controller.begin(begin);
	const input = path.join(f.root, "input.txt"); await writeFile(input, "fixed input\n");
	const first = await f.controller.delegate(goal.runId, { objective: "运行局部实验", inputs: [input], expectedOutputs: ["result.txt"], checks: ["结果文件存在且口径正确"], mode: "execute" });
	assert.equal(first.status, "returned");
	assert.equal(f.runner.created.at(-1)?.tools.kind, "execution");
	assert.equal(first.inputCopies.length, 1);
	await assert.rejects(f.controller.finish(goal.runId, { outcome: "fulfilled", summary: "不能成立", returnPath: "M08", goalChecks: begin.successCriteria.map((criterion) => ({ criterion, result: "not_run", evidence: [] })) }), /fulfilled/);
	const retried = await f.controller.delegate(goal.runId, { objective: "运行局部实验", inputs: [input], expectedOutputs: ["result.txt"], checks: ["结果文件存在且口径正确"], mode: "execute", parentTaskId: first.taskId, supersedesTaskId: first.taskId });
	assert.notEqual(retried.taskId, first.taskId);
	assert.equal((await f.controller.status(goal.runId)).tasks.length, 2);
});

test("review rejects fake completion and requires a relevant independent check report", async (t) => {
	const f = await fixture(t); const goal = await f.controller.begin(begin);
	const source = path.join(f.root, "source.txt"); await writeFile(source, "input\n");
	const task = await f.controller.delegate(goal.runId, { objective: "形成重要结果", inputs: [source], expectedOutputs: ["result.md"], checks: ["关键数值通过"], mode: "reason", requireIndependentCheck: true });
	await assert.rejects(f.controller.review(goal.runId, { taskId: task.taskId, artifacts: [], checks: [{ criterion: "关键数值通过", result: "passed", evidence: [] }] }), /空 artifacts/);
	const artifact = path.join(task.workDir, "result.md"); await writeFile(artifact, "actual result\n");
	const checker = await f.controller.delegate(goal.runId, { objective: "独立核对重要结果", inputs: [artifact], expectedOutputs: [], checks: ["核对报告已返回"], mode: "check", parentTaskId: task.taskId });
	await assert.rejects(f.controller.review(goal.runId, { taskId: task.taskId, artifacts: [artifact], checks: [{ criterion: "关键数值通过", result: "passed", evidence: [artifact] }] }), /独立检查/);
	assert.ok(checker.reportPath);
	const accepted = await f.controller.review(goal.runId, { taskId: task.taskId, artifacts: [artifact], checks: [{ criterion: "关键数值通过", result: "passed", evidence: [artifact] }], independentCheck: { taskId: checker.taskId, report: checker.reportPath, disposition: "核对报告未发现冲突；保留其有限覆盖。" } });
	assert.equal(accepted.status, "accepted", JSON.stringify(accepted.review));
	assert.equal((await f.controller.status(goal.runId)).tasks.find((x) => x.taskId === checker.taskId)?.status, "returned", "check return itself is not promoted to accepted");
});

test("decision and partial finish preserve failures, original criteria, and recovery is read-only", async (t) => {
	const f = await fixture(t); const goal = await f.controller.begin(begin);
	const task = await f.controller.delegate(goal.runId, { objective: "尝试构造反例", inputs: [], expectedOutputs: [], checks: ["反例已复核"], mode: "reason" });
	assert.ok(task.reportPath);
	await f.controller.review(goal.runId, { taskId: task.taskId, artifacts: [task.reportPath], checks: [{ criterion: "反例已复核", result: "not_run", evidence: [] }], failures: ["构造失败"], unexecuted: ["独立复核"], limitations: ["只覆盖一个参数区间"] });
	await f.controller.decision(goal.runId, { action: "request", question: "是否扩大资源预算？", relatedTaskIds: [task.taskId] });
	const done = await f.controller.finish(goal.runId, { outcome: "partial", summary: "保留明确失败与局部结果", returnPath: "user", limitations: ["未满足总体成功要求"], goalChecks: begin.successCriteria.map((criterion) => ({ criterion, result: "not_run", evidence: [] })) });
	assert.equal(done.tasks[0].status, "rejected"); assert.deepEqual(done.successCriteria, begin.successCriteria); assert.equal(done.decisions[0].status, "open");
	const restored = await createM07Controller(f.ctx).status(goal.runId); assert.equal(restored.lifecycle, "finished"); assert.equal(restored.tasks.length, 1);
	await assert.rejects(f.controller.plan(goal.runId, "偷偷重跑"), /已结束/);
});

test("missing role model fails before a model call and M07 feedback gives M04 actual text", async (t) => {
	const f = await fixture(t, true, { roles: { research: "fake/research" }, concurrency: 1, tools: {} }); const goal = await f.controller.begin(begin);
	const failed = await f.controller.delegate(goal.runId, { objective: "无模型任务", inputs: [], expectedOutputs: [], checks: ["任务返回"], mode: "reason" });
	assert.equal(failed.status, "failed"); assert.match(failed.executionFailure ?? "", /没有配置模型/);

	const g = await fixture(t); const g0 = await g.controller.begin(begin); const task = await g.controller.delegate(g0.runId, { objective: "产生文本证据", inputs: [], expectedOutputs: [], checks: ["证据存在"], mode: "reason" }); const artifact = path.join(task.workDir, "evidence.md"); await writeFile(artifact, "EVIDENCE-CONTENT-UNIQUE\n"); await g.controller.review(g0.runId, { taskId: task.taskId, artifacts: [artifact], checks: [{ criterion: "证据存在", result: "passed", evidence: [artifact] }] }); await g.controller.finish(g0.runId, { outcome: "fulfilled", summary: "本目标要求已覆盖", returnPath: "M04", goalChecks: begin.successCriteria.map((criterion) => ({ criterion, result: "passed", evidence: [artifact] })) });
	const m04 = await runM04(g.ctx, { feedback: { kind: "M07", runId: g0.runId }, freshSession: true });
	assert.equal(m04.record.status, "completed");
	const message = await readFile(m04.record.outputs.find((o) => o.label === "发送给研究会话的完整消息")!.path, "utf8");
	assert.match(message, /EVIDENCE-CONTENT-UNIQUE/);
});

test("blocked M07 still supplies its complete failure evidence package to M04", async (t) => {
	const f = await fixture(t); const goal = await f.controller.begin(begin);
	const task = await f.controller.delegate(goal.runId, { objective: "失败但有信息的实验", inputs: [], expectedOutputs: [], checks: ["实验完成"], mode: "reason" });
	assert.ok(task.reportPath);
	await f.controller.review(goal.runId, { taskId: task.taskId, artifacts: [task.reportPath], checks: [{ criterion: "实验完成", result: "failed", evidence: [task.reportPath] }], failures: ["观察到结构性失败"] });
	await f.controller.finish(goal.runId, { outcome: "blocked", summary: "结构性失败需要研究判断", returnPath: "M04", goalChecks: begin.successCriteria.map((criterion) => ({ criterion, result: "failed", evidence: [task.reportPath!] })) });
	assert.equal((await f.ws.readRun("M07", goal.runId)).status, "failed");
	const m04 = await runM04(f.ctx, { feedback: { kind: "M07", runId: goal.runId }, freshSession: true });
	assert.equal(m04.record.status, "completed");
	assert.match(await readFile(m04.record.outputs.find((o) => o.label === "发送给研究会话的完整消息")!.path, "utf8"), /观察到结构性失败/);
});

test("task declarations are bounded and independent checking is tied to immutable bytes", async (t) => {
	const f = await fixture(t); const goal = await f.controller.begin(begin);
	await assert.rejects(f.controller.delegate(goal.runId, { objective: "bad", inputs: [], expectedOutputs: [], checks: ["x"], mode: "execute" }), /预期产物/);
	await assert.rejects(f.controller.delegate(goal.runId, { objective: "bad", inputs: [], expectedOutputs: [], checks: ["x", " x "], mode: "reason" }), /不能重复/);
	const task = await f.controller.delegate(goal.runId, { objective: "重要推导", inputs: [], expectedOutputs: [], checks: ["版本经独立检查"], mode: "reason", requireIndependentCheck: true }); assert.ok(task.reportPath);
	const checker = await f.controller.delegate(goal.runId, { objective: "检查重要推导", inputs: [task.reportPath], expectedOutputs: [], checks: ["检查完成"], mode: "check", parentTaskId: task.taskId }); assert.ok(checker.reportPath);
	await writeFile(task.reportPath, "被检查后修改的版本\n");
	await assert.rejects(f.controller.review(goal.runId, { taskId: task.taskId, artifacts: [task.reportPath], checks: [{ criterion: "版本经独立检查", result: "passed", evidence: [task.reportPath] }], independentCheck: { taskId: checker.taskId, report: checker.reportPath, disposition: "声称已处理" } }), /当前提交版本/);
});

test("an accepted same-obligation retry chain can fulfill without erasing old failures", async (t) => {
	const f = await fixture(t); const goal = await f.controller.begin(begin);
	const spec = { objective: "同一研究义务", inputs: [] as string[], expectedOutputs: [] as string[], checks: ["义务完成"], mode: "reason" as const };
	const first = await f.controller.delegate(goal.runId, spec); assert.ok(first.reportPath);
	await f.controller.review(goal.runId, { taskId: first.taskId, artifacts: [first.reportPath], checks: [{ criterion: "义务完成", result: "failed", evidence: [first.reportPath] }], failures: ["首轮失败"] });
	const second = await f.controller.delegate(goal.runId, { ...spec, supersedesTaskId: first.taskId }); assert.ok(second.reportPath);
	await f.controller.review(goal.runId, { taskId: second.taskId, artifacts: [second.reportPath], checks: [{ criterion: "义务完成", result: "failed", evidence: [second.reportPath] }], failures: ["二轮失败"] });
	const third = await f.controller.delegate(goal.runId, { ...spec, supersedesTaskId: second.taskId }); assert.ok(third.reportPath);
	const accepted = await f.controller.review(goal.runId, { taskId: third.taskId, artifacts: [third.reportPath], checks: [{ criterion: "义务完成", result: "passed", evidence: [third.reportPath] }] });
	const done = await f.controller.finish(goal.runId, { outcome: "fulfilled", summary: "第三轮完成同一义务", returnPath: "M08", goalChecks: begin.successCriteria.map((criterion) => ({ criterion, result: "passed", evidence: [accepted.review!.artifacts[0].path] })) });
	assert.deepEqual(done.tasks.map((item) => item.status), ["rejected", "rejected", "accepted"]);
});

test("supersedes cannot downgrade mode, independent checking, or fixed inputs", async (t) => {
	const f = await fixture(t); const goal = await f.controller.begin(begin); const input = path.join(f.root, "fixed.txt"); await writeFile(input, "v1\n");
	const original = await f.controller.delegate(goal.runId, { objective: "固定义务", inputs: [input], expectedOutputs: ["out.txt"], checks: ["输出检查"], mode: "execute", requireIndependentCheck: true });
	await assert.rejects(f.controller.delegate(goal.runId, { objective: "固定义务", inputs: [input], expectedOutputs: ["out.txt"], checks: ["输出检查"], mode: "reason", requireIndependentCheck: false, supersedesTaskId: original.taskId }), /完全相同/);
	const other = path.join(f.root, "other.txt"); await writeFile(other, "v1\n");
	await assert.rejects(f.controller.delegate(goal.runId, { objective: "固定义务", inputs: [other], expectedOutputs: ["out.txt"], checks: ["输出检查"], mode: "execute", requireIndependentCheck: true, supersedesTaskId: original.taskId }), /完全相同/);
});

test("review and independent reports remain frozen when live reports change or disappear", async (t) => {
	const f = await fixture(t); const goal = await f.controller.begin(begin);
	const task = await f.controller.delegate(goal.runId, { objective: "冻结重要报告", inputs: [], expectedOutputs: [], checks: ["独立检查"], mode: "reason", requireIndependentCheck: true }); assert.ok(task.reportPath);
	const originalTaskReport = await readFile(task.reportPath, "utf8");
	const checker = await f.controller.delegate(goal.runId, { objective: "独立检查冻结报告", inputs: [task.reportPath], expectedOutputs: [], checks: ["报告已检查"], mode: "check", parentTaskId: task.taskId }); assert.ok(checker.reportPath);
	const originalCheckReport = await readFile(checker.reportPath, "utf8");
	await f.controller.review(goal.runId, { taskId: task.taskId, artifacts: [task.reportPath], checks: [{ criterion: "独立检查", result: "passed", evidence: [task.reportPath] }], independentCheck: { taskId: checker.taskId, report: checker.reportPath, disposition: "按该固定版本检查，未把返回本身当作判真。" } });
	await writeFile(task.reportPath, "MUTATED-LIVE-TASK\n"); await rm(checker.reportPath);
	const done = await f.controller.finish(goal.runId, { outcome: "partial", summary: "只验证反馈冻结", returnPath: "M04", goalChecks: begin.successCriteria.map((criterion) => ({ criterion, result: "not_run", evidence: [] })) });
	const feedback = await readFile(done.feedbackPath!, "utf8");
	assert.match(feedback, new RegExp(originalTaskReport.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
	assert.match(feedback, new RegExp(originalCheckReport.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
	assert.doesNotMatch(feedback, /MUTATED-LIVE-TASK/);
});
