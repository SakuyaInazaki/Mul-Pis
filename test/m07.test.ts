import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { createFileKnowledgeStore } from "../src/knowledge/store.ts";
import { createM07Controller } from "../src/m07/controller.ts";
import { readProjectionEvents, replayability } from "../src/improvement/observations.ts";
import { FakeSessionRunner } from "../src/runner/fake.ts";
import { PiSessionRunner } from "../src/runner/pi.ts";
import { createAgentSession, type CreateAgentSessionOptions, type ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
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

async function activateBudget(root: string, policy: Record<string, unknown>, versionId = "test-budget"): Promise<void> {
	const improvement = path.join(root, ".agent", "improvement");
	await mkdir(path.join(improvement, "versions", versionId), { recursive: true });
	await writeFile(path.join(improvement, "versions", versionId, "policy.json"), JSON.stringify(policy));
	await writeFile(path.join(improvement, "active.json"), JSON.stringify({ version: 1, versionId, promotedAt: "2026-09-23T00:00:00Z", runId: "test" }));
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

test("M07 loads only explicitly selected pinned experience and does not claim it was faithfully used", async (t) => {
	const f = await fixture(t, false);
	const storeId = await f.store.storeId();
	const evidence = await f.store.submitProposal({ stage: "M04", runId: "feedback", ops: [
		{ op: "create", type: "E", title: "实际观察", body: "只在已知条件下成立", usageDecision: "adopted" },
		{ op: "create", type: "X", title: "当前情境", body: "数值局部检查", usageDecision: "adopted" },
	] });
	await f.store.merge(evidence.proposalId);
	const method = await f.store.submitProposal({ stage: "M04", runId: "feedback", ops: [{ op: "create", type: "K", title: "条件性检查方法", body: "先复核测量范围，再提出解释", usageDecision: "adopted", scope: ["X001"], fields: { experience: { version: 1, targetKind: "executor", applicableStages: ["M07"], requiredTags: ["numeric"], excludedTags: [], requiredRefs: [{ storeId, recordId: "E001", version: 1 }, { storeId, recordId: "X001", version: 1 }] } } }] });
	const merged = await f.store.merge(method.proposalId);
	const baseline = await f.ws.startRun("M04", [{ label: "反馈", path: f.ws.problemFile }], merged.snapshot.id);
	await f.ws.writeOutput(baseline, "merge.json", JSON.stringify(merged), "合入结果");
	await f.ws.finishRun(baseline, "completed");
	const goal = await f.controller.begin(begin);
	const methodRef = { storeId, recordId: "K001", version: 1 };
	const contextRef = { storeId, recordId: "X001", version: 1 };
	const task = await f.controller.delegate(goal.runId, { objective: "执行条件性核查", inputs: [], expectedOutputs: [], checks: ["范围已核对"], mode: "reason", experienceRefs: [methodRef], experienceContextRefs: [contextRef], experienceTags: ["numeric"] });
	const sent = [...f.runner.sessions.values()].at(-1)!.transcript[0].text;
	assert.match(sent, /条件性检查方法/);
	assert.match(sent, /实际观察/);
	assert.equal(task.experienceSelection?.status, "ready");
	assert.ok(task.experienceSelection?.loadedAt);
	assert.equal(task.experienceSelection?.invocationStatus, "unknown");
	assert.equal(task.experienceSelection?.faithfulUse, "unknown");
	assert.equal(task.experienceSelection?.causalBenefit, "unknown");
	await assert.rejects(f.controller.delegate(goal.runId, { objective: "不能绕开适用性检查", inputs: [], expectedOutputs: [], checks: ["范围已核对"], mode: "reason", knowledgeIds: ["K001@1"] }), /必须通过固定 storeId/);
	const limited = await f.store.submitProposal({ stage: "M04", runId: "withdraw", ops: [{ op: "limit", target: "E001", kind: "withdrawn", reason: "数据被撤回", authority: "reviewer" }] });
	await f.store.merge(limited.proposalId);
	await assert.rejects(f.controller.delegate(goal.runId, { objective: "不得重用失效经验", inputs: [], expectedOutputs: [], checks: ["范围已核对"], mode: "reason", experienceRefs: [methodRef], experienceContextRefs: [contextRef], experienceTags: ["numeric"] }), /显式方法经验不可装载/);
	assert.equal((await f.controller.status(goal.runId)).tasks[0].experienceSelection?.status, "ready", "the earlier task history is not hot-rewritten");
});

test("latest incomplete or failed M04 blocks formal baseline instead of falling back", async (t) => {
	const f = await fixture(t);
	const failed = await f.ws.startRun("M04", [{ label: "新处理", path: f.ws.problemFile }]);
	failed.failures.push("知识提案未合入");
	await f.ws.finishRun(failed, "failed");
	await assert.rejects(f.controller.begin(begin), /\u6700\u65b0 M04.*failed|\u4e0d得回退/);
	const exploratory = await f.controller.begin({ ...begin, exploratory: true });
	assert.equal(exploratory.formalBaseline, false);
	assert.equal(exploratory.m04BaselineRunId, undefined);
});

test("completed M04 with an unmerged proposal is not a formal baseline", async (t) => {
	const f = await fixture(t, false);
	const run = await f.ws.startRun("M04", [{ label: "原问题", path: f.ws.problemFile }]);
	const proposal = path.join(f.ws.runDir("M04", run.runId), "proposal.json"); await writeFile(proposal, "{}\n");
	run.outputs.push({ label: "知识提案", path: proposal });
	await f.ws.finishRun(run, "completed");
	await assert.rejects(f.controller.begin(begin), /未成功合入/);
});

test("formal goals reject fulfilled on a failed latest M04 but can return blocked or partial evidence", async (t) => {
	const f = await fixture(t); const goal = await f.controller.begin(begin);
	const newer = await f.ws.startRun("M04", [{ label: "新处理", path: f.ws.problemFile }]);
	newer.failures.push("新限制尚未完整合入"); await f.ws.finishRun(newer, "failed");
	await assert.rejects(f.controller.delegate(goal.runId, { objective: "不得基于旧正式基线继续", inputs: [], expectedOutputs: [], checks: ["基线有效"], mode: "reason" }), /最新 M04/);
	await assert.rejects(f.controller.finish(goal.runId, { outcome: "fulfilled", summary: "不得绕过", returnPath: "M08", goalChecks: begin.successCriteria.map((criterion) => ({ criterion, result: "passed", evidence: [] })) }), /最新 M04/);
	const blocked = await f.controller.finish(goal.runId, { outcome: "blocked", summary: "新 M04 失败，如实回流", returnPath: "M04", goalChecks: begin.successCriteria.map((criterion) => ({ criterion, result: "not_run", evidence: [] })) });
	assert.equal(blocked.formalBaseline, false); assert.equal(blocked.exploratory, true);
	assert.match(blocked.limitations.at(-1)!, /原正式基线已失效/);
	assert.match(await readFile(blocked.feedbackPath!, "utf8"), /原目标完成/);

	const p = await fixture(t); const partialGoal = await p.controller.begin(begin);
	const failed = await p.ws.startRun("M04", [{ label: "新失败", path: p.ws.problemFile }]); failed.failures.push("未合入"); await p.ws.finishRun(failed, "failed");
	const partial = await p.controller.finish(partialGoal.runId, { outcome: "partial", summary: "仅保留局部记录", returnPath: "M04", goalChecks: begin.successCriteria.map((criterion) => ({ criterion, result: "not_run", evidence: [] })) });
	assert.equal(partial.outcome, "partial"); assert.equal(partial.formalBaseline, false);
	assert.match(partial.limitations.at(-1)!, /不表示原目标完成/);
});

test("delegate is fresh and returned is not accepted; retry is a new retained task", async (t) => {
	const f = await fixture(t); const goal = await f.controller.begin(begin);
	const input = path.join(f.root, "input.txt"); await writeFile(input, "fixed input\n");
	const first = await f.controller.delegate(goal.runId, { objective: "运行局部实验", inputs: [input], expectedOutputs: ["result.txt"], checks: ["结果文件存在且口径正确"], mode: "execute" });
	const executionMessage = [...f.runner.sessions.values()].at(-1)!.transcript[0].text;
	assert.match(executionMessage, /先做本地可完成的语法、类型、编译与兼容性预检/);
	assert.match(executionMessage, /M05\/M06→M04/);
	assert.match(executionMessage, /fixed input/);
	assert.match(executionMessage, /inputs\/001-input\.txt/);
	assert.equal(first.status, "returned");
	assert.equal(f.runner.created.at(-1)?.tools.kind, "execution");
	assert.equal(first.inputCopies.length, 1);
	await assert.rejects(f.controller.finish(goal.runId, { outcome: "fulfilled", summary: "不能成立", returnPath: "M08", goalChecks: begin.successCriteria.map((criterion) => ({ criterion, result: "not_run", evidence: [] })) }), /fulfilled/);
	const retried = await f.controller.delegate(goal.runId, { objective: "运行局部实验", inputs: [input], expectedOutputs: ["result.txt"], checks: ["结果文件存在且口径正确"], mode: "execute", parentTaskId: first.taskId, supersedesTaskId: first.taskId });
	assert.notEqual(retried.taskId, first.taskId);
	assert.equal((await f.controller.status(goal.runId)).tasks.length, 2);
});

test("large M07 input is preserved for bounded on-demand reading without hiding a tail counterexample", async (t) => {
	const f = await fixture(t);
	await activateBudget(f.root, { version: 1, maxPromptChars: 8_000, maxInlineFileChars: 1_000, maxAggregateInlineChars: 4_000, maxFeedbackChars: 4_000, overflowMode: "manifest-and-defer" });
	const goal = await f.controller.begin(begin);
	const input = path.join(f.root, "large-input.md");
	await writeFile(input, `${"ordinary evidence\n".repeat(100)}TAIL-COUNTEREXAMPLE-UNIQUE\n`);
	const task = await f.controller.delegate(goal.runId, { objective: "核对输入中的反例", inputs: [input], expectedOutputs: [], checks: ["反例已定位"], mode: "reason" });
	const sent = [...f.runner.sessions.values()].at(-1)!.transcript[0].text;
	assert.doesNotMatch(sent, /TAIL-COUNTEREXAMPLE-UNIQUE/);
	assert.match(sent, /已显示字符 无（0 字符）/);
	assert.match(sent, /未显示字符 1–/);
	assert.equal(f.runner.created.at(-1)?.tools.kind, "read-dir");
	assert.match(sent, new RegExp(`inputs/${path.basename(task.inputCopies[0].copy).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
	assert.equal(await readFile(task.inputCopies[0].copy, "utf8"), await readFile(input, "utf8"));
});

test("a goal freezes its budget policy while only a new goal inherits a later active version", async (t) => {
	const f = await fixture(t);
	const strict = { version: 1, maxPromptChars: 8_000, maxInlineFileChars: 1_000, maxAggregateInlineChars: 4_000, maxFeedbackChars: 4_000, overflowMode: "manifest-and-defer" };
	const roomy = { ...strict, maxInlineFileChars: 2_000 };
	await activateBudget(f.root, strict, "budget-strict");
	const oldGoal = await f.controller.begin(begin);
	assert.equal(oldGoal.budgetPolicyVersionId, "budget-strict");
	assert.deepEqual(oldGoal.budgetPolicy, strict);

	await activateBudget(f.root, roomy, "budget-roomy");
	const input = path.join(f.root, "between-limits.md");
	await writeFile(input, `${"z".repeat(1_500)}TAIL-FROZEN-POLICY\n`);
	await f.controller.delegate(oldGoal.runId, { objective: "旧目标继续", inputs: [input], expectedOutputs: [], checks: ["范围明确"], mode: "reason" });
	const oldMessage = [...f.runner.sessions.values()].findLast((item) => item.spec.label === "M07-T001")!.transcript[0].text;
	assert.doesNotMatch(oldMessage, /TAIL-FROZEN-POLICY/);
	assert.match(oldMessage, /budget-strict/);

	const newGoal = await f.controller.begin(begin);
	assert.equal(newGoal.budgetPolicyVersionId, "budget-roomy");
	await f.controller.delegate(newGoal.runId, { objective: "新目标继承新策略", inputs: [input], expectedOutputs: [], checks: ["范围明确"], mode: "reason" });
	const newMessage = [...f.runner.sessions.values()].findLast((item) => item.spec.label === "M07-T001")!.transcript[0].text;
	assert.match(newMessage, /TAIL-FROZEN-POLICY/);
	assert.match(newMessage, /budget-roomy/);

	await activateBudget(f.root, strict, "budget-strict");
	const persistedNew = await f.controller.status(newGoal.runId);
	assert.equal(persistedNew.budgetPolicyVersionId, "budget-roomy", "rollback must not rewrite an existing goal snapshot");
	assert.deepEqual(persistedNew.budgetPolicy, roomy);
});

test("M07 projection events use ordered UTF-16 decisions and preserve measured bytes", async (t) => {
	const f = await fixture(t);
	await activateBudget(f.root, { version: 1, maxPromptChars: 8_000, maxInlineFileChars: 1_000, maxAggregateInlineChars: 4_000, maxFeedbackChars: 4_000, overflowMode: "manifest-and-defer" });
	const goal = await f.controller.begin(begin);
	const inputs = ["中文".repeat(450), "a".repeat(1_100), "😀".repeat(600)];
	const files = await Promise.all(inputs.map(async (content, index) => {
		const file = path.join(f.root, `mixed-${index}.txt`);
		await writeFile(file, content);
		return file;
	}));
	const task = await f.controller.delegate(goal.runId, { objective: "核对混合编码", inputs: files, expectedOutputs: [], checks: ["长度已核对"], mode: "reason" });
	const [event] = await readProjectionEvents(f.ws, goal.runId);
	assert.equal(event.purpose, "task-message");
	assert.equal(event.taskId, task.taskId);
	assert.equal(event.policyVersionId, "test-budget");
	assert.equal(event.deliveryStatus, "submitted");
	assert.deepEqual(event.materials.map((item) => item.ordinal), [0, 1, 2]);
	assert.deepEqual(event.materials.map((item) => item.utf16CodeUnits), [900, 1_100, 1_200]);
	assert.deepEqual(event.materials.map((item) => item.utf8Bytes), [2_700, 1_100, 2_400]);
	assert.deepEqual(event.materials.map((item) => item.decision), ["inline", "deferred", "deferred"]);
	assert.equal(replayability(event).replayable, true);
	const snapshot = path.join(f.ws.runDir("M07", goal.runId), event.materials[0].snapshotPath!);
	await writeFile(files[0], "源文件已改变");
	assert.equal(await readFile(snapshot, "utf8"), inputs[0]);
	await rm(snapshot);
	const [missing] = await readProjectionEvents(f.ws, goal.runId);
	assert.equal(missing.materials[0].availability, "missing");
	assert.equal(replayability(missing).replayable, false);
});

test("M07 projection calls remain separate across delegates and feedback consumption", async (t) => {
	const f = await fixture(t);
	const goal = await f.controller.begin(begin);
	const input = path.join(f.root, "task-only.txt");
	await writeFile(input, "任务独有输入，不在 M07 stage inputs 中。");
	for (let index = 0; index < 2; index++) await f.controller.delegate(goal.runId, { objective: `第 ${index + 1} 项`, inputs: [input], expectedOutputs: [], checks: ["已检查"], mode: "reason" });
	const done = await f.controller.finish(goal.runId, { outcome: "partial", summary: "待处理", returnPath: "M04", goalChecks: begin.successCriteria.map((criterion) => ({ criterion, result: "not_run", evidence: [] })) });
	let events = await readProjectionEvents(f.ws, goal.runId);
	assert.deepEqual(events.map((item) => [item.callOrdinal, item.purpose, item.taskId]), [[1, "task-message", "T001"], [2, "task-message", "T002"], [3, "feedback", undefined]]);
	assert.deepEqual(events.map((item) => item.deliveryStatus), ["submitted", "submitted", "not-submitted"]);
	assert.equal(events[0].materials[0].role, "task-input");
	assert.equal(events[1].materials[0].role, "task-input");
	assert.equal((await f.ws.readRun("M07", goal.runId)).inputs.length, 1);
	assert.equal(events[2].projectionStatus, "materialized");
	assert.equal(replayability(events[2]).replayable, true);
	await runM04(f.ctx, { feedback: { kind: "M07", runId: goal.runId }, freshSession: true });
	events = await readProjectionEvents(f.ws, goal.runId);
	assert.equal(events[2].deliveryStatus, "assembled-for-m04");
	assert.equal(events[2].assembledBy?.stage, "M04");
	assert.equal(done.feedbackPath && events[2].outputPath, "m04-feedback.md");
});

test("a rejected projection is recorded without pretending it reached the model", async (t) => {
	const f = await fixture(t);
	await activateBudget(f.root, { version: 1, maxPromptChars: 8_000, maxInlineFileChars: 1_000, maxAggregateInlineChars: 4_000, maxFeedbackChars: 4_000, overflowMode: "manifest-and-fail" });
	const goal = await f.controller.begin(begin);
	const input = path.join(f.root, "over-limit.txt");
	await writeFile(input, "x".repeat(1_001));
	await assert.rejects(f.controller.delegate(goal.runId, { objective: "检查长度", inputs: [input], expectedOutputs: [], checks: ["已检查"], mode: "reason" }), (error: unknown) => error instanceof HarnessError && error.code === "context.budget");
	const [event] = await readProjectionEvents(f.ws, goal.runId);
	assert.equal(event.projectionStatus, "budget-failed");
	assert.equal(event.deliveryStatus, "not-submitted");
	assert.equal(event.materials[0].decision, "deferred");
	assert.equal(event.materials[0].reason, "single-file-limit");
	assert.equal(replayability(event).replayable, false);
	assert.equal((await f.controller.status(goal.runId)).tasks.length, 0);
});

test("measurement snapshot caps leave task inputs intact and mark unreplayable events", async (t) => {
	const f = await fixture(t);
	const controller = createM07Controller(f.ctx, { projectionSnapshotLimits: { perMaterialBytes: 16, perCallBytes: 16, perRunBytes: 24 } });
	const goal = await controller.begin(begin);
	const files = await Promise.all(["A".repeat(12), "B".repeat(12), "C".repeat(20)].map(async (content, index) => {
		const file = path.join(f.root, `cap-${index}.txt`);
		await writeFile(file, content);
		return file;
	}));
	await controller.delegate(goal.runId, { objective: "同调用额度", inputs: files, expectedOutputs: [], checks: ["完整"], mode: "reason" });
	await controller.delegate(goal.runId, { objective: "累计额度内", inputs: [files[0]], expectedOutputs: [], checks: ["完整"], mode: "reason" });
	await controller.delegate(goal.runId, { objective: "累计额度外", inputs: [files[1]], expectedOutputs: [], checks: ["完整"], mode: "reason" });
	const events = await readProjectionEvents(f.ws, goal.runId);
	assert.deepEqual(events[0].materials.map((item) => item.snapshotStatus), ["captured", "budget-exceeded", "budget-exceeded"]);
	assert.deepEqual(events[0].materials.map((item) => item.captureReason), [undefined, "per-call", "per-material"]);
	assert.equal(events[1].materials[0].snapshotStatus, "captured");
	assert.equal(events[2].materials[0].captureReason, "per-run");
	assert.equal(events[0].captureBudget.usedCallBytes, 12);
	assert.equal(events[2].captureBudget.usedRunBytesAtStart, 24);
	assert.equal(replayability(events[0]).replayable, false);
	assert.equal(replayability(events[1]).replayable, true);
	assert.equal(replayability(events[2]).replayable, false);
	const sent = [...f.runner.sessions.values()][0].transcript[0].text;
	assert.match(sent, /BBBBBBBBBBBB/);
	assert.match(sent, /CCCCCCCCCCCCCCCCCCCC/);
});

test("legacy M07 goals remain viewable but cannot silently adopt the current active policy", async (t) => {
	const f = await fixture(t);
	const goal = await f.controller.begin(begin);
	const goalPath = path.join(f.ws.runDir("M07", goal.runId), "goal.json");
	const legacy = JSON.parse(await readFile(goalPath, "utf8"));
	delete legacy.budgetPolicy; delete legacy.budgetPolicyVersionId; delete legacy.budgetPolicyFrozenAt;
	await writeFile(goalPath, JSON.stringify(legacy));
	assert.equal((await f.controller.status(goal.runId)).runId, goal.runId);
	await assert.rejects(f.controller.delegate(goal.runId, { objective: "不得静默继续", inputs: [], expectedOutputs: [], checks: ["x"], mode: "reason" }), (error: unknown) => error instanceof HarnessError && error.code === "m07.policy-legacy");
	const interrupted = await f.controller.interrupt(goal.runId, { reason: "旧目标需要硬停止", returnPath: "user" });
	assert.equal(interrupted.lifecycle, "finished");
	assert.equal(interrupted.outcome, "blocked");
	assert.match(interrupted.limitations.at(-1) ?? "", /未套用当前 active policy/);
	const feedback = await readFile(interrupted.feedbackPath!, "utf8");
	assert.match(feedback, /legacy 受控中断反馈包/);
	assert.match(feedback, /不读取、不内联、不截断证据正文/);
	assert.match(feedback, /不能作为证据完整性或科学结论证明/);
	assert.equal((await f.ws.readRun("M07", goal.runId)).status, "failed");
});

test("M07 feedback manifests oversized frozen evidence and M04 records access without claiming full coverage", async (t) => {
	const f = await fixture(t);
	await activateBudget(f.root, { version: 1, maxPromptChars: 8_000, maxInlineFileChars: 1_000, maxAggregateInlineChars: 4_000, maxFeedbackChars: 4_000, overflowMode: "manifest-and-defer" });
	const goal = await f.controller.begin(begin);
	const task = await f.controller.delegate(goal.runId, { objective: "产生长证据", inputs: [], expectedOutputs: [], checks: ["证据存在"], mode: "reason" });
	const artifact = path.join(task.workDir, "long-evidence.md");
	await writeFile(artifact, `${"evidence body\n".repeat(100)}TAIL-REFUTATION-UNIQUE\n`);
	const reviewed = await f.controller.review(goal.runId, { taskId: task.taskId, artifacts: [artifact], checks: [{ criterion: "证据存在", result: "passed", evidence: [artifact] }] });
	const done = await f.controller.finish(goal.runId, { outcome: "partial", summary: "证据需研究会话按需读取", returnPath: "M04", goalChecks: begin.successCriteria.map((criterion) => ({ criterion, result: "not_run", evidence: [] })) });
	const feedback = await readFile(done.feedbackPath!, "utf8");
	assert.doesNotMatch(feedback, /TAIL-REFUTATION-UNIQUE/);
	assert.match(feedback, /已显示字符 无（0 字符）/);
	const frozenEvidence = reviewed.review!.artifacts.find((item) => item.sourcePath?.endsWith("long-evidence.md"));
	assert.ok(frozenEvidence);
	const evidenceRelative = path.relative(f.ws.runDir("M07", goal.runId), frozenEvidence.path);
	const m04Runner = new FakeSessionRunner(({ spec }) => spec.label === "M04-research" ? { text: "只做了局部访问；不声称完整核验。", reads: [evidenceRelative] } : "unused");
	f.ctx.runner = m04Runner;
	const m04 = await runM04(f.ctx, { feedback: { kind: "M07", runId: goal.runId }, freshSession: true });
	const spec = m04Runner.created.findLast((item) => item.label === "M04-research")!;
	assert.equal(spec.tools.kind, "read-dir");
	if (spec.tools.kind === "read-dir") {
		assert.equal(spec.tools.toolName, "m07_evidence_read");
		assert.equal(spec.tools.root, f.ws.runDir("M07", goal.runId));
	}
	const sent = [...m04Runner.sessions.values()].findLast((item) => item.spec.label === "M04-research")!.transcript[0].text;
	assert.doesNotMatch(sent, /TAIL-REFUTATION-UNIQUE/);
	assert.match(sent, /不能证明读取了全文/);
	assert.match(sent, /当前项目状态（局部知识包/);
	const coveragePath = m04.record.outputs.find((item) => item.label === "M07 回流证据实际访问范围")!.path;
	const coverage = JSON.parse(await readFile(coveragePath, "utf8")) as { filesAccessed: string[]; completeness: string; semantics: string };
	assert.deepEqual(coverage.filesAccessed, [evidenceRelative]);
	assert.equal(coverage.completeness, "unknown");
	assert.match(coverage.semantics, /不证明已读全文/);
});

test("failed M04 retains material ranges returned before the model error", async (t) => {
	const f = await fixture(t);
	const goal = await f.controller.begin(begin);
	await f.controller.delegate(goal.runId, { objective: "生成反馈", inputs: [], expectedOutputs: [], checks: ["完成"], mode: "reason" });
	await f.controller.finish(goal.runId, { outcome: "partial", summary: "交回 M04", returnPath: "M04", goalChecks: begin.successCriteria.map((criterion) => ({ criterion, result: "not_run", evidence: [] })) });
	const fake = new FakeSessionRunner(() => ({ text: "unused", reads: ["tasks/T001/report.md"], stopReason: "error" }));
	const originalCreate = fake.create.bind(fake);
	fake.create = async (spec) => {
		const handle = await originalCreate(spec);
		return { ...handle, readReturnEvents: () => [{ toolName: "m07_evidence_read", path: "tasks/T001/report.md", status: "returned" as const, requested: { offset: 2, limit: 1 }, returned: { startLine: 2, endLine: 2, truncated: true, kind: "text" as const }, at: "2026-09-23T00:00:00Z" }] };
	};
	f.ctx.runner = fake;
	await assert.rejects(runM04(f.ctx, { feedback: { kind: "M07", runId: goal.runId }, freshSession: true }));
	const ids = await f.ws.listRuns("M04");
	const failed = (await Promise.all(ids.map((id) => f.ws.readRun("M04", id)))).find((run) => run.status === "failed");
	assert.ok(failed);
	assert.equal(failed.status, "failed");
	const coverageRef = failed.outputs.find((item) => item.label === "M07 回流证据实际访问范围");
	assert.ok(coverageRef);
	const coverage = JSON.parse(await readFile(coverageRef.path, "utf8"));
	assert.equal(coverage.promptOutcome, "failed");
	assert.deepEqual(coverage.filesAccessed, ["tasks/T001/report.md"]);
	assert.deepEqual(coverage.returnedRanges[0].returned, { startLine: 2, endLine: 2, truncated: true, kind: "text" });
});

test("oversized feedback control facts produce a bounded index while frozen evidence remains recoverable", async (t) => {
	const f = await fixture(t);
	await activateBudget(f.root, { version: 1, maxPromptChars: 8_000, maxInlineFileChars: 1_000, maxAggregateInlineChars: 4_000, maxFeedbackChars: 4_000, overflowMode: "manifest-and-defer" });
	const goal = await f.controller.begin(begin);
	const task = await f.controller.delegate(goal.runId, { objective: `保留控制事实 ${"x".repeat(3_200)}`, inputs: [], expectedOutputs: [], checks: ["事实已记录"], mode: "reason" });
	assert.ok(task.reportPath);
	const reviewed = await f.controller.review(goal.runId, { taskId: task.taskId, artifacts: [task.reportPath], checks: [{ criterion: "事实已记录", result: "passed", evidence: [task.reportPath] }] });
	const frozen = reviewed.review!.frozenReportPath;
	const finished = await f.controller.finish(goal.runId, { outcome: "partial", summary: "控制事实不能截断", returnPath: "M04", goalChecks: begin.successCriteria.map((criterion) => ({ criterion, result: "not_run", evidence: [] })) });
	assert.equal(finished.feedbackStatus, "indexed");
	assert.equal(finished.lifecycle, "finished");
	const index = await readFile(finished.feedbackPath!, "utf8");
	assert.ok(index.length <= 4_000);
	assert.match(index, /m07_evidence_read.*goal\.json/);
	assert.match(index, /不代表 M04 已读完整记录/);
	assert.match(await readFile(path.join(f.ws.runDir("M07", goal.runId), "goal.json"), "utf8"), /x{3200}/);
	assert.match(await readFile(frozen, "utf8"), /M07-T001 returned/);
	const run = await f.ws.readRun("M07", goal.runId);
	assert.equal(run.status, "completed");
	assert.ok(run.outputs.some((item) => item.label === "M07 实际执行反馈包"));
});

test("active checkpoint freezes reviewed evidence and problem inputs without closing the goal", async (t) => {
	const f = await fixture(t);
	await mkdir(f.ws.rawDir, { recursive: true });
	const raw = path.join(f.ws.rawDir, "measurement.md");
	await writeFile(raw, "frozen raw observation\n");
	const goal = await f.controller.begin(begin, { executionContract: "continuous" });
	const task = await f.controller.delegate(goal.runId, { objective: "负结果也必须回流", inputs: [], expectedOutputs: [], checks: ["检查已记录"], mode: "reason" });
	const artifact = path.join(task.workDir, "observation.md");
	await writeFile(artifact, "FROZEN_NEGATIVE_RESULT\n");
	const reviewed = await f.controller.review(goal.runId, { taskId: task.taskId, artifacts: [artifact], checks: [{ criterion: "检查已记录", result: "failed", evidence: [artifact] }] });
	assert.equal(reviewed.status, "rejected");
	const checkpoint = await f.controller.checkpoint(goal.runId);
	assert.equal(checkpoint.id, "C001");
	assert.equal((await f.controller.status(goal.runId)).lifecycle, "active");
	assert.equal((await f.ws.readRun("M07", goal.runId)).status, "running");
	assert.equal((await f.controller.status(goal.runId)).checkpoints?.[0]?.id, checkpoint.id);
	const manifest = JSON.parse(await readFile(checkpoint.manifestPath, "utf8"));
	assert.equal(manifest.problemFile, "problem.md");
	assert.deepEqual(manifest.rawFiles, [{ name: "measurement.md", relativePath: path.join("raw", "measurement.md") }]);
	const fixedArtifact = manifest.files.find((item: { sourceRelativePath: string }) => item.sourceRelativePath.endsWith("review-snapshot/002-observation.md"));
	assert.ok(fixedArtifact);
	await writeFile(artifact, "LATER_CHANGED\n");
	await writeFile(raw, "LATER_RAW\n");
	await writeFile(f.ws.problemFile, "LATER_PROBLEM\n");
	assert.equal(await readFile(path.join(checkpoint.rootDir, fixedArtifact.relativePath), "utf8"), "FROZEN_NEGATIVE_RESULT\n");
	assert.equal(await readFile(path.join(checkpoint.rootDir, "raw", "measurement.md"), "utf8"), "frozen raw observation\n");
	assert.equal(await readFile(path.join(checkpoint.rootDir, "problem.md"), "utf8"), "研究问题：机制 A 是否成立？\n");
	const feedback = await readFile(checkpoint.feedbackPath, "utf8");
	assert.match(feedback, /非终态开发 checkpoint/);
	assert.doesNotMatch(feedback, /LATER_CHANGED|LATER_RAW|LATER_PROBLEM/);
	assert.ok(feedback.length <= goal.budgetPolicy!.maxFeedbackChars);
	const frozenGoal = JSON.parse(await readFile(checkpoint.goalSnapshotPath, "utf8"));
	assert.equal(frozenGoal.lifecycle, "active");
	assert.equal(frozenGoal.tasks[0].workDir, "");
	assert.equal(frozenGoal.tasks[0].review.artifacts[0].sourcePath, undefined);
});

test("checkpoint refuses a running task and baseline refresh requires matching M04 consumption", async (t) => {
	const f = await fixture(t);
	const goal = await f.controller.begin(begin, { executionContract: "continuous" });
	const statePath = path.join(f.ws.runDir("M07", goal.runId), "goal.json");
	const running = JSON.parse(await readFile(statePath, "utf8"));
	running.tasks.push({ taskId: "T001", status: "running", toolLog: [] });
	await writeFile(statePath, JSON.stringify(running));
	await assert.rejects(f.controller.checkpoint(goal.runId), (error: unknown) => error instanceof HarnessError && error.code === "m07.checkpoint");
	await writeFile(statePath, JSON.stringify(goal));
	const checkpoint = await f.controller.checkpoint(goal.runId);
	await assert.rejects(f.controller.plan(goal.runId, "继续原目标", { refreshBaseline: true }), /checkpointId/);
	const wrong = await f.ws.startRun("M04", [{ label: "other", path: f.ws.problemFile }]);
	await f.ws.finishRun(wrong, "completed");
	await assert.rejects(f.controller.plan(goal.runId, "继续原目标", { refreshBaseline: true, checkpointId: checkpoint.id, m04RunId: wrong.runId }), /checkpoint/);
	const m04 = await runM04(f.ctx, { feedback: { kind: "M07Checkpoint", runId: goal.runId, checkpointId: checkpoint.id }, freshSession: true });
	await assert.rejects(f.controller.plan(goal.runId, "继续原目标", { refreshBaseline: true, checkpointId: "C999", m04RunId: m04.record.runId }), /checkpoint/);
	const resumed = await f.controller.plan(goal.runId, "继续原目标", { refreshBaseline: true, checkpointId: checkpoint.id, m04RunId: m04.record.runId });
	assert.equal(resumed.lifecycle, "active");
	assert.equal(resumed.m04BaselineRunId, m04.record.runId);
	assert.deepEqual(resumed.successCriteria, begin.successCriteria);
});

test("failed checkpoint attempt remains untouched and retry uses a new directory", async (t) => {
	const f = await fixture(t);
	await mkdir(f.ws.rawDir, { recursive: true });
	const raw = path.join(f.ws.rawDir, "oversized.md");
	await writeFile(raw, "");
	await truncate(raw, 8 * 1024 * 1024 + 1);
	const goal = await f.controller.begin(begin, { executionContract: "continuous" });
	await assert.rejects(f.controller.checkpoint(goal.runId), (error: unknown) => error instanceof HarnessError && error.code === "m07.checkpoint" && /局部冻结材料/.test(error.message));
	const orphan = path.join(f.ws.runDir("M07", goal.runId), "checkpoints", "C001");
	const preserved = await readFile(path.join(orphan, "problem.md"), "utf8");
	assert.equal((await f.controller.status(goal.runId)).lifecycle, "active");
	assert.equal((await f.controller.status(goal.runId)).checkpoints?.length ?? 0, 0);
	await writeFile(raw, "bounded raw observation\n");
	const checkpoint = await f.controller.checkpoint(goal.runId);
	assert.equal(checkpoint.id, "C002");
	assert.equal(await readFile(path.join(orphan, "problem.md"), "utf8"), preserved);
	await assert.rejects(readFile(path.join(orphan, "manifest.json"), "utf8"), { code: "ENOENT" });
	assert.equal(await readFile(path.join(checkpoint.rootDir, "raw", "oversized.md"), "utf8"), "bounded raw observation\n");
	assert.deepEqual((await f.controller.status(goal.runId)).checkpoints?.map((item) => item.id), ["C002"]);
	assert.equal((await f.ws.readRun("M07", goal.runId)).status, "running");
});

test("checkpoint taskIds freezes only the selected review batch and rejects invalid scopes", async (t) => {
	const f = await fixture(t);
	const goal = await f.controller.begin(begin, { executionContract: "continuous" });
	const first = await f.controller.delegate(goal.runId, { objective: "旧批证据", inputs: [], expectedOutputs: [], checks: ["旧批检查"], mode: "reason" });
	const firstReview = await f.controller.review(goal.runId, { taskId: first.taskId, artifacts: [first.reportPath!], checks: [{ criterion: "旧批检查", result: "passed", evidence: [first.reportPath!] }] });
	const second = await f.controller.delegate(goal.runId, { objective: "本批负结果", inputs: [], expectedOutputs: [], checks: ["本批检查"], mode: "reason" });
	const secondReview = await f.controller.review(goal.runId, { taskId: second.taskId, artifacts: [second.reportPath!], checks: [{ criterion: "本批检查", result: "failed", evidence: [second.reportPath!] }] });
	for (const taskIds of [[], [first.taskId, first.taskId], ["T999"]]) await assert.rejects(f.controller.checkpoint(goal.runId, { taskIds }), (error: unknown) => error instanceof HarnessError && error.code === "m07.checkpoint");
	const checkpoint = await f.controller.checkpoint(goal.runId, { taskIds: [second.taskId] });
	assert.equal(checkpoint.id, "C001");
	const manifest = JSON.parse(await readFile(checkpoint.manifestPath, "utf8"));
	assert.deepEqual(manifest.selectedTaskIds, [second.taskId]);
	assert.deepEqual(manifest.omittedTaskIds, [first.taskId]);
	assert.ok(manifest.files.some((item: { sourceRelativePath: string }) => item.sourceRelativePath.endsWith(path.basename(secondReview.review!.frozenReportPath))));
	assert.ok(!manifest.files.some((item: { sourceRelativePath: string }) => item.sourceRelativePath.includes(`/${first.taskId}/review-snapshot/`)));
	const snapshot = JSON.parse(await readFile(checkpoint.goalSnapshotPath, "utf8"));
	assert.equal(snapshot.tasks[0].status, firstReview.status);
	assert.equal(snapshot.tasks[0].review, undefined);
	assert.equal(snapshot.tasks[0].reportPath, undefined);
	assert.equal(snapshot.tasks[1].status, secondReview.status);
	assert.ok(snapshot.tasks[1].review?.frozenReportPath.startsWith(checkpoint.rootDir));
	assert.deepEqual(snapshot.checkpointScope, { selectedTaskIds: [second.taskId], omittedTaskIds: [first.taskId] });
	assert.match(await readFile(checkpoint.feedbackPath, "utf8"), /未选任务 1：T001/);
	assert.equal((await f.controller.status(goal.runId)).tasks[0].review?.frozenReportPath, firstReview.review?.frozenReportPath);
});

test("fulfilled goal with long real task tool log keeps its hard checks and indexes the complete log", async (t) => {
	const f = await fixture(t);
	await activateBudget(f.root, { version: 1, maxPromptChars: 8_000, maxInlineFileChars: 1_000, maxAggregateInlineChars: 4_000, maxFeedbackChars: 4_000, overflowMode: "manifest-and-defer" });
	const originalCreate = f.runner.create.bind(f.runner);
	f.runner.create = async (spec) => {
		const handle = await originalCreate(spec);
		return { ...handle, toolLog: () => [{ name: "bounded-check", args: { note: "Z".repeat(6_000) }, ok: true, at: "2026-09-23T00:00:00Z" }] };
	};
	const goal = await f.controller.begin(begin);
	const task = await f.controller.delegate(goal.runId, { objective: "核查两项要求", inputs: [], expectedOutputs: [], checks: ["可定位证据"], mode: "reason" });
	await f.controller.review(goal.runId, { taskId: task.taskId, artifacts: [task.reportPath!], checks: [{ criterion: "可定位证据", result: "passed", evidence: [task.reportPath!] }] });
	const finished = await f.controller.finish(goal.runId, { outcome: "fulfilled", summary: "已完成原目标硬检查", returnPath: "M04", goalChecks: begin.successCriteria.map((criterion) => ({ criterion, result: "passed", evidence: [task.reportPath!] })) });
	assert.equal(finished.outcome, "fulfilled");
	assert.equal(finished.feedbackStatus, "indexed");
	assert.ok((await readFile(finished.feedbackPath!, "utf8")).length <= 4_000);
	assert.match(await readFile(path.join(f.ws.runDir("M07", goal.runId), "goal.json"), "utf8"), /Z{6000}/);
	assert.equal((await f.ws.readRun("M07", goal.runId)).status, "completed");
	await runM04(f.ctx, { feedback: { kind: "M07", runId: goal.runId }, freshSession: true });
	const m04 = await f.ws.latestCompletedRun("M04");
	const coverage = m04!.outputs.find((item) => item.label === "M07 回流证据实际访问范围");
	assert.ok(coverage);
	assert.equal(JSON.parse(await readFile(coverage.path, "utf8")).completeness, "unknown");
	const m04Spec = f.runner.created.at(-1)!;
	assert.equal(m04Spec.tools.kind, "read-dir");
	if (m04Spec.tools.kind !== "read-dir") throw new Error("M04 did not grant its M07 read tool");
	assert.equal(m04Spec.tools.toolName, "m07_evidence_read");
	assert.equal(m04Spec.tools.root, f.ws.runDir("M07", goal.runId));
	const model = { id: "offline-model", name: "Offline model", api: "anthropic-messages", provider: "offline", baseUrl: "https://invalid.example", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 10_000, maxTokens: 1_000 } as Model<"anthropic-messages">;
	let readTool: NonNullable<CreateAgentSessionOptions["customTools"]>[number] | undefined;
	const runner = new PiSessionRunner({
		modelRuntime: { getModels: () => [model] } as unknown as ModelRuntime,
		createSession: (async (options: CreateAgentSessionOptions = {}) => {
			readTool = options.customTools?.find((tool) => tool.name === "m07_evidence_read");
			const manager = options.sessionManager!;
			return { session: { sessionId: manager.getSessionId(), sessionFile: manager.getSessionFile(), messages: [], getActiveToolNames: () => [...(options.tools ?? [])], prompt: async () => undefined, abort: async () => undefined, dispose: () => undefined } } as unknown as Awaited<ReturnType<typeof createAgentSession>>;
		}) as typeof createAgentSession,
	});
	const handle = await runner.create({ ...m04Spec, model: "offline/offline-model", persistDir: path.join(f.root, "offline-read-test") });
	assert.ok(readTool);
	const sourceLines = (await readFile(path.join(f.ws.runDir("M07", goal.runId), "goal.json"), "utf8")).split("\n");
	const logLine = sourceLines.findIndex((line) => line.includes("Z".repeat(100))) + 1;
	assert.ok(logLine > 1);
	const first = await readTool.execute("page-one", { path: "goal.json", offset: logLine - 1, limit: 1 }, undefined, undefined, undefined as never);
	const second = await readTool.execute("page-two", { path: "goal.json", offset: logLine, limit: 1 }, undefined, undefined, undefined as never);
	assert.doesNotMatch((first.content[0] as { text: string }).text, /Z{100}/);
	assert.match((second.content[0] as { text: string }).text, /Z{6000}/);
	assert.deepEqual(handle.readReturnEvents().map((event) => ({ path: event.path, start: event.returned.startLine, end: event.returned.endLine })), [
		{ path: "goal.json", start: logLine - 1, end: logLine - 1 },
		{ path: "goal.json", start: logLine, end: logLine },
	]);
	handle.dispose();
});

test("interrupt with oversized feedback closes goal and run with only bounded control facts", async (t) => {
	const f = await fixture(t);
	await activateBudget(f.root, { version: 1, maxPromptChars: 8_000, maxInlineFileChars: 1_000, maxAggregateInlineChars: 4_000, maxFeedbackChars: 4_000, overflowMode: "manifest-and-defer" });
	const goal = await f.controller.begin({ ...begin, goal: `真实长目标 ${"Q".repeat(5_000)}` });
	const interrupted = await f.controller.interrupt(goal.runId, { reason: "host shutdown", returnPath: "user" });
	assert.equal(interrupted.lifecycle, "finished");
	assert.equal(interrupted.outcome, "blocked");
	assert.equal(interrupted.feedbackStatus, "control-facts-only");
	const index = await readFile(interrupted.feedbackPath!, "utf8");
	assert.ok(index.length <= 4_000);
	assert.match(index, /不是完整 M07 科学证据交接/);
	assert.match(await readFile(path.join(f.ws.runDir("M07", goal.runId), "goal.json"), "utf8"), /Q{5000}/);
	const run = await f.ws.readRun("M07", goal.runId);
	assert.equal(run.status, "failed");
	assert.match(run.failures.join("\n"), /反馈生成失败/);
});

test("interrupt records repair-required when even bounded feedback cannot be written", async (t) => {
	const f = await fixture(t);
	const goal = await f.controller.begin(begin);
	await mkdir(path.join(f.ws.runDir("M07", goal.runId), "m04-feedback.md"));
	const interrupted = await f.controller.interrupt(goal.runId, { reason: "host shutdown", returnPath: "user" });
	assert.equal(interrupted.feedbackStatus, "failed");
	assert.equal(interrupted.feedbackPath, undefined);
	assert.equal(interrupted.feedbackError?.code, "m07.archive-repair-required");
	assert.equal((await f.controller.status(goal.runId)).lifecycle, "finished");
	const run = await f.ws.readRun("M07", goal.runId);
	assert.equal(run.status, "failed");
	assert.ok(!run.outputs.some((item) => item.label === "M07 实际执行反馈包"));
	assert.match(run.failures.join("\n"), /无反馈包，交接需修复/);
});

test("continuous goal refuses model-declared hard stops and only host lifecycle creates a stop receipt", async (t) => {
	const f = await fixture(t);
	const goal = await f.controller.begin(begin, { executionContract: "continuous" });
	assert.equal((await f.controller.status(goal.runId)).executionContract?.mode, "continuous");
	await assert.rejects(f.controller.finish(goal.runId, { outcome: "blocked", summary: "smem 太小，当前候选失败", returnPath: "user", limitations: ["stopReason=dependency_unavailable"], goalChecks: begin.successCriteria.map((criterion) => ({ criterion, result: "not_run", evidence: [] })) }), (error: unknown) => error instanceof HarnessError && error.code === "m07.continuous");
	await assert.rejects(f.controller.interrupt(goal.runId, { reason: "模型自称 user_stopped" }), (error: unknown) => error instanceof HarnessError && error.code === "m07.continuous");
	assert.equal((await f.controller.status(goal.runId)).lifecycle, "active");
	assert.equal((await f.ws.readRun("M07", goal.runId)).status, "running");
	await assert.rejects(f.controller.hostInterrupt(goal.runId, { reasonKind: "unknown" as never }), /未知宿主停止事件/);
	const archived = await f.controller.hostInterrupt(goal.runId, { reasonKind: "provider-error", sourceEventId: "session-1" });
	assert.equal(archived.lifecycle, "finished");
	assert.equal(archived.outcome, "blocked");
	assert.equal(archived.hostStopReceipt?.goalRunId, goal.runId);
	assert.equal(archived.hostStopReceipt?.reasonKind, "provider-error");
	assert.equal(archived.hostStopReceipt?.source, "pi-host");
	assert.ok(archived.hostStopReceipt?.id);
	assert.equal((await f.ws.readRun("M07", goal.runId)).status, "failed");
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
	await assert.rejects(f.controller.delegate(goal.runId, { objective: "动态文件名", inputs: [], expectedOutputs: ["raw/detail-<sid>.json"], checks: ["x"], mode: "execute" }), /动态文件名请声明其父目录/);
	assert.equal((await f.controller.status(goal.runId)).tasks.length, 0, "无效声明在创建任务前被拒绝");
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
	await assert.rejects(f.controller.delegate(goal.runId, { objective: "固定义务", inputs: [input], expectedOutputs: ["out.txt"], checks: ["输出检查"], mode: "reason", requireIndependentCheck: false, supersedesTaskId: original.taskId }), /supersedes 只能替代/);
	const other = path.join(f.root, "other.txt"); await writeFile(other, "v1\n");
	await assert.rejects(f.controller.delegate(goal.runId, { objective: "固定义务", inputs: [other], expectedOutputs: ["out.txt"], checks: ["输出检查"], mode: "execute", requireIndependentCheck: true, supersedesTaskId: original.taskId }), /supersedes 只能替代/);
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

test("interrupt archives a goal with unknown-running task as failed, never fulfilled", async (t) => {
	const f = await fixture(t); const goal = await f.controller.begin(begin);
	const task = await f.controller.delegate(goal.runId, { objective: "长期任务", inputs: [], expectedOutputs: [], checks: ["任务完成"], mode: "reason" });
	assert.equal(task.status, "returned");
	const goalPath = path.join(f.ws.runDir("M07", goal.runId), "goal.json");
	const raw = JSON.parse(await readFile(goalPath, "utf8")); raw.tasks[0].status = "running"; await writeFile(goalPath, JSON.stringify(raw));
	const interrupted = await f.controller.interrupt(goal.runId, { reason: "host shutdown", returnPath: "user" });
	assert.equal(interrupted.lifecycle, "finished"); assert.equal(interrupted.outcome, "blocked");
	assert.equal(interrupted.tasks[0].status, "failed"); assert.match(interrupted.tasks[0].executionFailure ?? "", /host shutdown/);
	const run = await f.ws.readRun("M07", goal.runId); assert.equal(run.status, "failed");
	assert.ok(run.failures.some((failure) => failure.includes("受控中断归档")));
	await assert.rejects(f.controller.plan(goal.runId, "重跑"), /已结束/);
});


test("review auto-freezes declared expected outputs", async (t) => {
	const f = await fixture(t);
	const goal = await f.controller.begin(begin);
	const task = await f.controller.delegate(goal.runId, { objective: "produce outputs", inputs: [], expectedOutputs: ["result.txt", "raw/"], checks: ["outputs exist"], mode: "execute" });
	await mkdir(path.join(task.workDir, "raw"), { recursive: true });
	await writeFile(path.join(task.workDir, "result.txt"), "result\n");
	await writeFile(path.join(task.workDir, "raw", "evidence.txt"), "evidence\n");
	const note = path.join(task.workDir, "note.md");
	await writeFile(note, "note\n");
	const reviewed = await f.controller.review(goal.runId, { taskId: task.taskId, artifacts: [note], checks: [{ criterion: "outputs exist", result: "passed", evidence: [note] }] });
	assert.equal(reviewed.status, "accepted");
	const sources = (reviewed.review?.artifacts ?? []).map((item) => item.sourcePath).filter((source): source is string => typeof source === "string");
	assert.ok(sources.some((source) => source.endsWith("result.txt")));
	assert.ok(sources.some((source) => source.endsWith("evidence.txt")));
});

test("supersede can upgrade a check obligation to execute", async (t) => {
const f = await fixture(t);
const goal = await f.controller.begin(begin);
const first = await f.controller.delegate(goal.runId, { objective: "read only", inputs: [], expectedOutputs: [], checks: ["x"], mode: "check" });
const retried = await f.controller.delegate(goal.runId, { objective: "read only", inputs: [], expectedOutputs: [], checks: ["x"], mode: "execute", supersedesTaskId: first.taskId });
assert.equal(retried.mode, "execute");
assert.equal(retried.supersedesTaskId, first.taskId);
});

test("check mode rejects declared output files", async (t) => {
const f = await fixture(t);
const goal = await f.controller.begin(begin);
await assert.rejects(
f.controller.delegate(goal.runId, { objective: "read only", inputs: [], expectedOutputs: ["report.md"], checks: ["x"], mode: "check" }),
/不能声明 expectedOutputs/,
);
});
