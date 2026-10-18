import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { createFileKnowledgeStore } from "../src/knowledge/store.ts";
import { createM07Controller } from "../src/m07/controller.ts";
import { readProjectionEvents, replayability } from "../src/improvement/observations.ts";

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




test("delegate is fresh and returned is not accepted; retry is a new retained task", async (t) => {
	const f = await fixture(t); const goal = await f.controller.begin(begin);
	const input = path.join(f.root, "input.cu"); await writeFile(input, "fixed input\n");
	const header = path.join(f.root, "input.cuh"); await writeFile(header, "CUDA-HEADER-MARKER\n");
	const first = await f.controller.delegate(goal.runId, { objective: "运行局部实验", inputs: [input, header], expectedOutputs: ["result.txt"], checks: ["结果文件存在且口径正确"], mode: "execute" });
	const executionMessage = [...f.runner.sessions.values()].at(-1)!.transcript[0].text;
	assert.match(executionMessage, /先做本地可完成的语法、类型、编译与兼容性预检/);
	assert.match(executionMessage, /M05\/M06→M04/);
	assert.match(executionMessage, /fixed input/);
	assert.match(executionMessage, /inputs\/001-input\.cu/);
	assert.match(executionMessage, /inputs\/002-input\.cuh/);
	assert.match(executionMessage, /CUDA-HEADER-MARKER/, "CUDA source and header text are exposed under the ordinary input budget");
	assert.ok(executionMessage.indexOf("【外部执行与可消耗资源】") < executionMessage.indexOf("【本任务】"),
		"stable execution controls precede changing task material");
	assert.equal(first.status, "returned");
	assert.equal(f.runner.created.at(-1)?.tools.kind, "execution");
	assert.equal(first.inputCopies.length, 2);
	assert.ok(first.inputCopies.every(copy => copy.mediaType === "text"));
	await assert.rejects(f.controller.finish(goal.runId, { outcome: "fulfilled", summary: "不能成立", returnPath: "M08", goalChecks: begin.successCriteria.map((criterion) => ({ criterion, result: "not_run", evidence: [] })) }), /fulfilled/);
	const retried = await f.controller.delegate(goal.runId, { objective: "运行局部实验", inputs: [input, header], expectedOutputs: ["result.txt"], checks: ["结果文件存在且口径正确"], mode: "execute", parentTaskId: first.taskId, supersedesTaskId: first.taskId });
	assert.notEqual(retried.taskId, first.taskId);
	const retryMessage = [...f.runner.sessions.values()].at(-1)!.transcript[0].text;
	assert.equal(retryMessage.split("【本任务创建时的目标计划】")[0], executionMessage.split("【本任务创建时的目标计划】")[0],
		"new task paths and operation IDs do not break the reusable control prefix");
	assert.equal((await f.controller.status(goal.runId)).tasks.length, 2);
});

test("prompt capacity defers whole inputs and a failed pre-dispatch retry archives its old work", async (t) => {
	const f = await fixture(t);
	await activateBudget(f.root, { version: 1, maxPromptChars: 12_000, maxInlineFileChars: 11_000, maxAggregateInlineChars: 11_000, maxFeedbackChars: 4_000, overflowMode: "manifest-and-defer" });
	const goal = await f.controller.begin(begin);
	const oldInput = path.join(f.root, "old.txt");
	const nextInput = path.join(f.root, "next.txt");
	const lateInput = path.join(f.root, "late.txt");
	await writeFile(oldInput, "old-only-input\n");
	await writeFile(nextInput, "NEXT-UNIQUE-" + "x".repeat(10_900));
	await writeFile(lateInput, "LATE-UNIQUE-" + "y".repeat(2_000));
	await assert.rejects(f.controller.delegate(goal.runId, { objective: "unlaunchable " + "z".repeat(15_000), inputs: [oldInput], expectedOutputs: [], checks: ["recorded"], mode: "reason" }), /prompt 预算/);
	assert.equal((await f.controller.status(goal.runId)).tasks.length, 0);
	const task = await f.controller.delegate(goal.runId, { objective: "read the frozen input", inputs: [nextInput, lateInput], expectedOutputs: [], checks: ["recorded"], mode: "reason" });
	assert.equal(task.taskId, "T001");
	const message = await readFile(path.join(f.ws.runDir("M07", goal.runId), "tasks", "T001", "message.md"), "utf8");
	assert.match(message, /next\.txt/);
	assert.match(message, /已显示字符 无（0 字符）/);
	assert.doesNotMatch(message, /NEXT-UNIQUE-/);
	assert.doesNotMatch(message, /LATE-UNIQUE-/);
	assert.deepEqual(await readdir(path.join(task.workDir, "inputs")), ["001-next.txt", "002-late.txt"]);
	const archiveRoot = path.join(f.ws.runDir("M07", goal.runId), "undispatched-task-attempts");
	const archived = (await readdir(archiveRoot)).find((name) => /^T001-[0-9a-f-]+$/.test(name));
	assert.ok(archived);
	assert.equal(await readFile(path.join(archiveRoot, archived, "work", "inputs", "001-old.txt"), "utf8"), "old-only-input\n");
	assert.equal(JSON.parse(await readFile(path.join(archiveRoot, `${archived}.json`), "utf8")).status, "not-dispatched");
	const event = (await readProjectionEvents(f.ws, goal.runId)).findLast((entry) => entry.purpose === "task-message" && entry.projectionStatus === "materialized");
	assert.ok(event);
	assert.equal(event.materials[0].decision, "deferred");
	assert.equal(event.materials[1].decision, "deferred", "the later file must not be silently re-inlined after the larger file is omitted");
	assert.deepEqual(event.taskPromptDeferredOrdinals, [0, 1]);
	assert.equal(replayability(event).replayable, true);
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














test("fresh host recovery after reboot permits explicit baseline refresh without accepting live or unknown old owners", async (t) => {
	const f = await fixture(t);
	const goal = await f.controller.begin(begin);
	const frozenBaseline = goal.m04BaselineRunId;
	const suspended = await f.controller.hostSuspend(goal.runId, { reasonKind: "provider-error", sourceEventId: "after-m04" });
	const laterM04 = await f.ws.startRun("M04", [{ label: "later analysis", path: f.ws.problemFile }]);
	await f.ws.finishRun(laterM04, "completed");
	const old = suspended.executionState!.attempts[0].runDescriptor;
	const next = { ...old, instanceId: "new-after-m04", attemptId: "A002",
		process: { ...old.process, bootId: "next-boot", pid: old.process.pid + 1, processStartToken: "new-birth-after-m04" } };
	let oldStatus: "alive" | "unknown" | "dead" = "alive";
	const controller = createM07Controller(f.ctx, { probeProcess: async (identity) =>
		identity.pid === old.process.pid ? { status: oldStatus, identityMatch: oldStatus === "alive", reason: "old boot probe" } :
		{ status: "alive", identityMatch: true, reason: "new host" } });
	await assert.rejects(controller.hostRecover(goal.runId, { expectedAttemptId: "A001", runDescriptor: next }), /拒绝并行恢复/);
	oldStatus = "unknown";
	await assert.rejects(controller.hostRecover(goal.runId, { expectedAttemptId: "A001", runDescriptor: next }), /拒绝并行恢复/);
	oldStatus = "dead";
	await assert.rejects(controller.hostRecover(goal.runId, { expectedAttemptId: "A001", runDescriptor: { ...next,
		process: { ...next.process, hostId: "other-host" } } }), /拒绝并行恢复/);
	const recovered = await controller.hostRecover(goal.runId, { expectedAttemptId: "A001", runDescriptor: next });
	assert.equal(recovered.executionState?.activeAttemptId, "A002");
	assert.equal(recovered.m04BaselineRunId, frozenBaseline, "recovery must not silently advance the scientific baseline");
	assert.deepEqual(recovered.successCriteria, goal.successCriteria);
	await assert.rejects(controller.delegate(goal.runId, { objective: "execute before refresh", inputs: [],
		expectedOutputs: ["result.txt"], checks: ["check"], mode: "execute" }),
		(error: unknown) => error instanceof HarnessError && error.code === "m07.baseline");
	const refreshed = await controller.plan(goal.runId, goal.plan, { refreshBaseline: true });
	assert.equal(refreshed.m04BaselineRunId, laterM04.runId);
	const task = await controller.delegate(goal.runId, { objective: "execute after refresh", inputs: [],
		expectedOutputs: ["result.txt"], checks: ["check"], mode: "execute" });
	assert.equal(task.status, "returned");
});

test("lost execute response requires structured external query before another execute", async (t) => {
	const f = await fixture(t);
	const goal = await f.controller.begin(begin);
	const task = await f.controller.delegate(goal.runId, { objective: "执行远端动作", inputs: [], expectedOutputs: ["response.txt"], checks: ["远端查询"], mode: "execute" });
	const statePath = path.join(f.ws.runDir("M07", goal.runId), "goal.json");
	const raw = JSON.parse(await readFile(statePath, "utf8"));
	raw.tasks[0].status = "running";
	raw.executionState.operations[0].status = "issued";
	await writeFile(statePath, JSON.stringify(raw));
	const suspended = await f.controller.hostSuspend(goal.runId, { reasonKind: "session-shutdown" });
	assert.equal(suspended.tasks[0].status, "unknown");
	assert.equal(suspended.executionState?.operations[0].status, "unknown");
	const old = suspended.executionState!.attempts[0].runDescriptor;
	const next = { ...old, instanceId: "new-instance", attemptId: "A002", process: { ...old.process, pid: old.process.pid + 1, processStartToken: "new-birth" } };
	const controller = createM07Controller(f.ctx, { probeProcess: async (identity) => identity.pid === old.process.pid ? { status: "dead", identityMatch: false, reason: "old process exited" } : { status: "alive", identityMatch: true, reason: "new" } });
	await controller.hostRecover(goal.runId, { expectedAttemptId: "A001", runDescriptor: next });
	await assert.rejects(controller.delegate(goal.runId, { objective: "重复远端动作", inputs: [], expectedOutputs: ["again.txt"], checks: ["check"], mode: "execute" }), /副作用状态未知/);
	const check = await controller.delegate(goal.runId, { objective: "只读核查状态", inputs: [], expectedOutputs: [], checks: ["read"], mode: "check" });
	assert.equal(check.status, "returned");
	const operationId = suspended.executionState!.operations[0].id;
	const evidence = path.join(f.root, "external-query.json");
	await writeFile(evidence, JSON.stringify({ version: 1, operationId, observationMethod: "external-query", observedStatus: "unknown", observedAt: new Date().toISOString() }));
	assert.equal((await controller.hostReconcileOperation(goal.runId, { operationId, evidencePath: evidence })).executionState?.operations[0].status, "unknown");
	await assert.rejects(controller.delegate(goal.runId, { objective: "仍不可重复", inputs: [], expectedOutputs: ["again.txt"], checks: ["check"], mode: "execute" }), /副作用状态未知/);
	await writeFile(evidence, JSON.stringify({ version: 1, operationId, observationMethod: "external-query", observedStatus: "confirmed", observedAt: new Date().toISOString(), externalId: "remote-123" }));
	const reconciled = await controller.hostReconcileOperation(goal.runId, { operationId, evidencePath: evidence });
	assert.equal(reconciled.executionState?.operations[0].status, "confirmed");
	assert.equal(reconciled.tasks.find((item) => item.taskId === task.taskId)?.status, "failed", "old task remains unaccepted and is not replayed");
	const nextTask = await controller.delegate(goal.runId, { objective: "新的独立工作", inputs: [], expectedOutputs: ["new.txt"], checks: ["check"], mode: "execute" });
	assert.equal(nextTask.taskId, "T003");
});




test("independent check receives every artifact added from expected outputs", async (t) => {
	const f = await fixture(t); const goal = await f.controller.begin(begin);
	const task = await f.controller.delegate(goal.runId, { objective: "提交结果与源码", inputs: [], expectedOutputs: ["candidate"], checks: ["结果与源码可核查"], mode: "execute", requireIndependentCheck: true });
	assert.ok(task.reportPath);
	const receipt = path.join(task.workDir, "candidate", "receipt.json");
	const candidate = path.join(task.workDir, "candidate", "kernel", "src.py");
	await mkdir(path.dirname(candidate), { recursive: true });
	await writeFile(receipt, '{"correct":true}\n');
	await writeFile(candidate, "def candidate(): return 1\n");
	const reportOnly = await f.controller.delegate(goal.runId, { objective: "独立检查报告与顶层回执", inputs: [task.reportPath, receipt], expectedOutputs: [], checks: ["报告已核查"], mode: "check", parentTaskId: task.taskId });
	assert.ok(reportOnly.reportPath);
	const reviewInput = { taskId: task.taskId, artifacts: [task.reportPath], checks: [{ criterion: "结果与源码可核查", result: "passed" as const, evidence: [task.reportPath] }] };
	await assert.rejects(f.controller.review(goal.runId, { ...reviewInput, independentCheck: { taskId: reportOnly.taskId, report: reportOnly.reportPath, disposition: "仅检查报告与顶层回执。" } }), /独立 check 未取得当前提交版本的成果/);
	const completeCheck = await f.controller.delegate(goal.runId, { objective: "独立检查报告、回执与源码", inputs: [task.reportPath, receipt, candidate], expectedOutputs: [], checks: ["报告与源码已核查"], mode: "check", parentTaskId: task.taskId });
	assert.ok(completeCheck.reportPath);
	const accepted = await f.controller.review(goal.runId, { ...reviewInput, independentCheck: { taskId: completeCheck.taskId, report: completeCheck.reportPath, disposition: "报告与源码版本均已接收，保留检查范围限制。" } });
	assert.equal(accepted.status, "accepted");
	for (const source of [receipt, candidate]) {
		const canonical = await realpath(source);
		const artifact = accepted.review?.artifacts.find((item) => item.sourcePath === canonical);
		assert.ok(artifact);
		assert.deepEqual(await readFile(artifact.path), await readFile(source));
	}
});





test("same-obligation retry keeps history but fulfills only from the current accepted candidate", async (t) => {
	const f = await fixture(t); const goal = await f.controller.begin(begin);
	const spec = { objective: "同一研究义务", inputs: [] as string[], expectedOutputs: [] as string[], checks: ["义务完成"], mode: "reason" as const };
	const first = await f.controller.delegate(goal.runId, spec); assert.ok(first.reportPath);
	await f.controller.review(goal.runId, { taskId: first.taskId, artifacts: [first.reportPath], checks: [{ criterion: "义务完成", result: "failed", evidence: [first.reportPath] }], failures: ["首轮失败"] });
	const second = await f.controller.delegate(goal.runId, { ...spec, supersedesTaskId: first.taskId }); assert.ok(second.reportPath);
	await f.controller.review(goal.runId, { taskId: second.taskId, artifacts: [second.reportPath], checks: [{ criterion: "义务完成", result: "failed", evidence: [second.reportPath] }], failures: ["二轮失败"] });
	const third = await f.controller.delegate(goal.runId, { ...spec, supersedesTaskId: second.taskId }); assert.ok(third.reportPath);
	const previousAccepted = await f.controller.review(goal.runId, { taskId: third.taskId, artifacts: [third.reportPath], checks: [{ criterion: "义务完成", result: "passed", evidence: [third.reportPath] }] });
	const fourth = await f.controller.delegate(goal.runId, { ...spec, supersedesTaskId: third.taskId }); assert.ok(fourth.reportPath);
	const currentAccepted = await f.controller.review(goal.runId, { taskId: fourth.taskId, artifacts: [fourth.reportPath], checks: [{ criterion: "义务完成", result: "passed", evidence: [fourth.reportPath] }] });
	const finishWith = (evidence: string) => f.controller.finish(goal.runId, { outcome: "fulfilled", summary: "当前候选完成同一义务", returnPath: "M08", goalChecks: begin.successCriteria.map((criterion) => ({ criterion, result: "passed" as const, evidence: [evidence] })) });
	await assert.rejects(finishWith(previousAccepted.review!.artifacts[0].path), /目标验收证据不来自当前有效且已接受任务/);
	const done = await finishWith(currentAccepted.review!.artifacts[0].path);
	assert.deepEqual(done.tasks.map((item) => item.status), ["rejected", "rejected", "accepted", "accepted"]);
	assert.deepEqual(done.tasks.slice(0, 2).map((item) => item.review?.failures), [["首轮失败"], ["二轮失败"]]);
});
