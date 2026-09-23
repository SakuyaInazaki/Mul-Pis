import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
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

test("checkpoint M04 rejects unregistered IDs, traversal, and a symlink replacing a frozen file", async (t) => {
	const f = await fixture(t);
	const goal = await f.controller.begin(begin);
	const checkpoint = await f.controller.checkpoint(goal.runId);
	await assert.rejects(runM04(f.ctx, { feedback: { kind: "M07Checkpoint", runId: goal.runId, checkpointId: "../C001" } }), /标识非法/);
	await assert.rejects(runM04(f.ctx, { feedback: { kind: "M07Checkpoint", runId: goal.runId, checkpointId: "C999" } }), /未由该目标唯一登记|无法按固定记录读取/);
	const originalManifest = await readFile(checkpoint.manifestPath, "utf8");
	const escaped = JSON.parse(originalManifest);
	escaped.files[0].relativePath = "../goal.json";
	await writeFile(checkpoint.manifestPath, JSON.stringify(escaped));
	await assert.rejects(runM04(f.ctx, { feedback: { kind: "M07Checkpoint", runId: goal.runId, checkpointId: checkpoint.id } }), /证据清单字段非法/);
	await writeFile(checkpoint.manifestPath, originalManifest);
	await rm(checkpoint.manifestPath);
	await symlink(path.join(f.ws.runDir("M07", goal.runId), "goal.json"), checkpoint.manifestPath);
	await assert.rejects(runM04(f.ctx, { feedback: { kind: "M07Checkpoint", runId: goal.runId, checkpointId: checkpoint.id } }), /固定路径非法/);
});

test("oversized checkpoint feedback indexes its own frozen goal and remains consumable by M04", async (t) => {
	const f = await fixture(t);
	const policyDir = path.join(f.root, ".agent", "improvement");
	await mkdir(path.join(policyDir, "versions", "checkpoint-budget"), { recursive: true });
	await writeFile(path.join(policyDir, "versions", "checkpoint-budget", "policy.json"), JSON.stringify({ version: 1, maxPromptChars: 8_000, maxInlineFileChars: 1_000, maxAggregateInlineChars: 4_000, maxFeedbackChars: 4_000, overflowMode: "manifest-and-defer" }));
	await writeFile(path.join(policyDir, "active.json"), JSON.stringify({ version: 1, versionId: "checkpoint-budget", promotedAt: new Date().toISOString(), runId: "fixture" }));
	const goal = await f.controller.begin(begin);
	const task = await f.controller.delegate(goal.runId, { objective: "保留负结果与限制", inputs: [], expectedOutputs: [], checks: ["报告存在"], mode: "reason" });
	await f.controller.review(goal.runId, { taskId: task.taskId, artifacts: [task.reportPath!], checks: [{ criterion: "报告存在", result: "passed", evidence: [task.reportPath!] }], limitations: ["L".repeat(5_000)] });
	const checkpoint = await f.controller.checkpoint(goal.runId);
	assert.equal(checkpoint.feedbackStatus, "indexed");
	const index = await readFile(checkpoint.feedbackPath, "utf8");
	assert.match(index, /goal\.json/);
	assert.ok(!index.includes(f.ws.runDir("M07", goal.runId)), "index must not grant the live run directory");
	assert.match(await readFile(checkpoint.goalSnapshotPath, "utf8"), /L{100}/);
	const result = await runM04(f.ctx, { feedback: { kind: "M07Checkpoint", runId: goal.runId, checkpointId: checkpoint.id } });
	assert.equal(result.record.status, "completed");
	assert.equal(f.runner.created.findLast((item) => item.label === "M04-research")?.tools.kind, "read-dir");
});

test("selected-task checkpoint exposes only that review evidence and tells M04 what was omitted", async (t) => {
	const f = await fixture(t);
	const goal = await f.controller.begin(begin);
	const selected = await f.controller.delegate(goal.runId, { objective: "本批证据", inputs: [], expectedOutputs: [], checks: ["本批报告"], mode: "reason" });
	await f.controller.review(goal.runId, { taskId: selected.taskId, artifacts: [selected.reportPath!], checks: [{ criterion: "本批报告", result: "passed", evidence: [selected.reportPath!] }] });
	const omitted = await f.controller.delegate(goal.runId, { objective: "历史证据", inputs: [], expectedOutputs: [], checks: ["历史报告"], mode: "reason" });
	const omittedReviewed = await f.controller.review(goal.runId, { taskId: omitted.taskId, artifacts: [omitted.reportPath!], checks: [{ criterion: "历史报告", result: "passed", evidence: [omitted.reportPath!] }] });
	const checkpoint = await f.controller.checkpoint(goal.runId, { taskIds: [selected.taskId] });
	const manifest = JSON.parse(await readFile(checkpoint.manifestPath, "utf8"));
	assert.deepEqual(manifest.selectedTaskIds, [selected.taskId]);
	assert.deepEqual(manifest.omittedTaskIds, [omitted.taskId]);
	assert.ok(manifest.files.some((item: { relativePath: string }) => item.relativePath.includes(`/${selected.taskId}/`)));
	assert.ok(manifest.files.every((item: { relativePath: string }) => !item.relativePath.includes(`/${omitted.taskId}/`)));
	const frozenGoal = JSON.parse(await readFile(checkpoint.goalSnapshotPath, "utf8"));
	assert.equal(frozenGoal.tasks.find((item: { taskId: string }) => item.taskId === omitted.taskId).status, "accepted");
	assert.equal(frozenGoal.tasks.find((item: { taskId: string }) => item.taskId === omitted.taskId).review, undefined);
	assert.equal(frozenGoal.tasks.find((item: { taskId: string }) => item.taskId === omitted.taskId).reportPath, undefined);
	const liveOmitted = (await f.controller.status(goal.runId)).tasks.find((item) => item.taskId === omitted.taskId)!;
	assert.equal(liveOmitted.status, "accepted");
	assert.equal(liveOmitted.review?.frozenReportPath, omittedReviewed.review!.frozenReportPath);
	assert.equal(liveOmitted.reportPath, omittedReviewed.reportPath);
	const result = await runM04(f.ctx, { feedback: { kind: "M07Checkpoint", runId: goal.runId, checkpointId: checkpoint.id } });
	const source = JSON.parse(await readFile(result.record.outputs.find((item) => item.label === "M07 处理来源")!.path, "utf8"));
	assert.deepEqual({ selected: source.selectedTaskIds, omitted: source.omittedTaskIds }, { selected: [selected.taskId], omitted: [omitted.taskId] });
	const session = [...f.runner.sessions.values()].findLast((item) => item.spec.label === "M04-research")!;
	assert.equal(session.spec.tools.kind, "read-dir");
	if (session.spec.tools.kind === "read-dir") assert.equal(session.spec.tools.root, checkpoint.rootDir);
	assert.match(session.transcript[0].text, /省略任务 1 项|未选任务 1/);
	assert.match(session.transcript[0].text, /未提供的证据/);
	assert.ok(!session.transcript[0].text.includes(omittedReviewed.review!.frozenReportPath));
});
