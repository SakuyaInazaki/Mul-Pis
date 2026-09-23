import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import test, { type TestContext } from "node:test";
import { GenerationStore, type M07WorkflowStrategyV1 } from "../src/improvement/generation.ts";
import { advanceKnowledgeEpochInLock, transitionMethodKnowledgeDependenciesInLock } from "../src/improvement/knowledge-epoch.ts";
import { createFileKnowledgeStore } from "../src/knowledge/store.ts";
import type { KnowledgeRef, ProposalBatch } from "../src/knowledge/types.ts";
import { createM07Controller } from "../src/m07/controller.ts";
import { FakeSessionRunner } from "../src/runner/fake.ts";
import type { StageContext } from "../src/stages/context.ts";
import { Workspace } from "../src/workspace.ts";

async function fixture(t: TestContext, artifact: M07WorkflowStrategyV1 | { version: 1; kind: "cpu-numerical-prompt"; body: string } = { version: 1, kind: "m07-workflow-prompt", slot: "research-check", body: "先做独立复算并报告未执行检查。" }) {
	const root = await mkdtemp(path.join(tmpdir(), "pre-rsi-epoch-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const ws = new Workspace(root);
	await mkdir(path.dirname(ws.problemFile), { recursive: true });
	await writeFile(ws.problemFile, "固定研究问题\n");
	const knowledge = createFileKnowledgeStore(ws.knowledgeDir);
	await knowledge.init();
	const generations = new GenerationStore(root);
	const first = await publish(ws, knowledge, [{ op: "create", type: "E", title: "初始证据", body: "初始观测", usageDecision: "adopted" }]);
	const h = await generations.writeStrategy({ versionId: "H0", kind: "executor", artifact, origin: "human-seed", applicability: ["M07"], limitations: [], state: "manual-active" });
	const i = await generations.writeStrategy({ versionId: "I0", kind: "improver", artifact: { version: 1, kind: "diagnostic-improver-prompt", body: "依据证据提出有限修改。" }, origin: "human-seed", applicability: ["M07"], limitations: [], state: "manual-active" });
	const bundle = await generations.writeBundle({ bundleId: "bundle-0", parents: [], executorVersionId: h.versionId, improverVersionId: i.versionId, knowledgeSnapshot: first.snapshotId, environmentVersion: "m07-workflow/v1", modelConfig: { improver: "fake/improver", research: "fake/research" }, protocolVersion: "research-protocol/v1", allowedCapabilities: ["no-tools-model"], state: "manual-active" });
	await generations.activate(bundle.bundleId, undefined, "human-seed", "seed");
	const runner = new FakeSessionRunner(({ spec }) => `${spec.label} returned`);
	const ctx: StageContext = { ws, store: knowledge, runner, config: { roles: { execution: "fake/execution", reviewer: "fake/reviewer", research: "fake/research" }, concurrency: 1, tools: {} } };
	return { root, ws, knowledge, generations, bundle, runner, ctx, first };
}

async function publish(ws: Workspace, store: ReturnType<typeof createFileKnowledgeStore>, ops: ProposalBatch["ops"]) {
	const run = await ws.startRun("M04", [{ label: "原问题", path: ws.problemFile }]);
	const receipt = await store.submitProposal({ stage: "M04", runId: run.runId, ops });
	assert.equal(receipt.structurallyValid, true, receipt.issues.map((issue) => issue.message).join("; "));
	const merged = await store.merge(receipt.proposalId);
	await ws.writeOutput(run, "merge.json", JSON.stringify(merged, null, 2), "合入结果");
	await ws.finishRun(run, "completed");
	return { runId: run.runId, snapshotId: merged.snapshot.id };
}

const goal = { goal: "检验固定问题", problemRelation: "直接关联", constraints: ["不可改变定义"], successCriteria: ["必须独立复算"], plan: "先局部实验后检查" };

test("explicit M04 epoch advances K between campaigns without rewriting H/I or the old bundle", async (t) => {
	const f = await fixture(t);
	const second = await publish(f.ws, f.knowledge, [{ op: "create", type: "E", title: "后续反馈", body: "新增观测", usageDecision: "adopted" }]);
	const result = await advanceKnowledgeEpochInLock({ workspaceRoot: f.root, generationStore: f.generations, m04RunId: second.runId, expectedActiveBundleId: f.bundle.bundleId });
	assert.equal(result.fromSnapshot, f.first.snapshotId);
	assert.equal(result.toSnapshot, second.snapshotId);
	assert.equal(result.bundle.executorVersionId, "H0");
	assert.equal(result.bundle.improverVersionId, "I0");
	assert.equal((await f.generations.readBundle(f.bundle.bundleId)).knowledgeSnapshot, f.first.snapshotId);
	assert.equal((await f.generations.active())?.pointer.provenance, "knowledge-epoch-advance");
	await assert.rejects(advanceKnowledgeEpochInLock({ workspaceRoot: f.root, generationStore: f.generations, m04RunId: second.runId, expectedActiveBundleId: f.bundle.bundleId }), /active generation changed/);
});

test("knowledge epoch refuses a newly limited necessary premise and preserves active pointer", async (t) => {
	const f = await fixture(t);
	const ref: KnowledgeRef = { storeId: await f.knowledge.storeId(), recordId: "E001", version: 1 };
	const h = await f.generations.readStrategy("H0");
	const dependent = await f.generations.writeStrategy({ versionId: "H-required", kind: "executor", artifact: h.artifact, parentVersionId: h.versionId, origin: "human-seed", applicability: h.applicability, limitations: [], requiredKnowledgeRefs: [ref], state: "manual-active" });
	const bound = await f.generations.writeBundle({ ...f.bundle, bundleId: "bundle-required", parents: [f.bundle.bundleId], executorVersionId: dependent.versionId });
	const prior = (await f.generations.active())!;
	await f.generations.activate(bound.bundleId, prior.pointer, "external-manual-unverified", "bound");
	const limited = await publish(f.ws, f.knowledge, [{ op: "limit", target: "E001", kind: "needs_recheck", reason: "需复核", authority: "review" }]);
	await assert.rejects(advanceKnowledgeEpochInLock({ workspaceRoot: f.root, generationStore: f.generations, m04RunId: limited.runId, expectedActiveBundleId: bound.bundleId }), /necessary knowledge|unavailable/i);
	assert.equal((await f.generations.active())?.bundle.bundleId, bound.bundleId);
});

test("external necessary refs need exact explicit store registration during epoch advance", async (t) => {
	const f = await fixture(t);
	const foreignRoot = await mkdtemp(path.join(tmpdir(), "pre-rsi-foreign-knowledge-"));
	t.after(() => rm(foreignRoot, { recursive: true, force: true }));
	const foreign = createFileKnowledgeStore(path.join(foreignRoot, "knowledge"));
	await foreign.init();
	const receipt = await foreign.submitProposal({ stage: "M04", runId: "foreign", ops: [{ op: "create", type: "E", title: "外部已登记事实", body: "有界引用", usageDecision: "adopted" }] });
	await foreign.merge(receipt.proposalId);
	const foreignId = await foreign.storeId();
	const ref: KnowledgeRef = { storeId: foreignId, recordId: "E001", version: 1 };
	const original = await f.generations.readStrategy("H0");
	const dependent = await f.generations.writeStrategy({ versionId: "H-foreign", kind: "executor", artifact: original.artifact, parentVersionId: "H0", origin: "human-seed", applicability: original.applicability, limitations: [], requiredKnowledgeRefs: [ref], state: "manual-active" });
	const bound = await f.generations.writeBundle({ bundleId: "bundle-foreign", parents: [f.bundle.bundleId], executorVersionId: dependent.versionId, improverVersionId: "I0", knowledgeSnapshot: f.first.snapshotId, environmentVersion: f.bundle.environmentVersion, modelConfig: f.bundle.modelConfig, protocolVersion: f.bundle.protocolVersion, allowedCapabilities: f.bundle.allowedCapabilities, state: "manual-active" });
	await f.generations.activate(bound.bundleId, (await f.generations.active())!.pointer, "external-manual-unverified", "foreign-bound");
	const second = await publish(f.ws, f.knowledge, [{ op: "create", type: "E", title: "本地更新", body: "新观测", usageDecision: "adopted" }]);
	await assert.rejects(advanceKnowledgeEpochInLock({ workspaceRoot: f.root, generationStore: f.generations, m04RunId: second.runId, expectedActiveBundleId: bound.bundleId }), /not registered/);
	const registered = new Map([[foreignId, foreign]]);
	const advanced = await advanceKnowledgeEpochInLock({ workspaceRoot: f.root, generationStore: f.generations, m04RunId: second.runId, expectedActiveBundleId: bound.bundleId, registeredExperienceStores: registered });
	assert.equal(advanced.toSnapshot, second.snapshotId);
});

test("M07 explicitly freezes a workflow H and sends its body in the actual task; CPU H is rejected", async (t) => {
	const f = await fixture(t);
	const controller = createM07Controller(f.ctx);
	const begun = await controller.begin({ ...goal, workflowMethodVersionId: "H0" });
	assert.equal(begun.workflowMethod?.artifact.slot, "research-check");
	const task = await controller.delegate(begun.runId, { objective: "执行核查", inputs: [], expectedOutputs: [], checks: ["必须独立复算"], mode: "reason" });
	assert.equal(task.status, "returned");
	const sent = [...f.runner.sessions.values()].at(-1)!.transcript[0]!.text;
	assert.match(sent, /先做独立复算并报告未执行检查/);
	assert.match(sent, /不可改变定义/);
	assert.match(sent, /必须独立复算/);
	assert.equal(f.runner.created.at(-1)?.methodBinding?.versionId, "H0");
	const saved = JSON.parse(await readFile(path.join(f.ws.runDir("M07", begun.runId), "goal.json"), "utf8"));
	assert.equal(saved.workflowMethod.artifact.body, "先做独立复算并报告未执行检查。");

	const cpu = await fixture(t, { version: 1, kind: "cpu-numerical-prompt", body: "Choose a visible hypothesis." });
	await assert.rejects(createM07Controller(cpu.ctx).begin({ ...goal, workflowMethodVersionId: "H0" }), /not an admitted or manually bound M07 workflow method/);
});

test("M07 evidence-handoff slot reaches the task and M04 feedback without changing fixed evidence fields", async (t) => {
	const f = await fixture(t, { version: 1, kind: "m07-workflow-prompt", slot: "evidence-handoff", body: "交接时写清未执行项和条件。" });
	const controller = createM07Controller(f.ctx);
	const begun = await controller.begin({ ...goal, workflowMethodVersionId: "H0" });
	await controller.delegate(begun.runId, { objective: "整理证据", inputs: [], expectedOutputs: [], checks: ["必须独立复算"], mode: "reason" });
	const sent = [...f.runner.sessions.values()].at(-1)!.transcript[0]!.text;
	assert.match(sent, /交接时写清未执行项和条件/);
	const closed = await controller.interrupt(begun.runId, { reason: "受控停止", returnPath: "M04" });
	const feedback = await readFile(closed.feedbackPath!, "utf8");
	assert.match(feedback, /冻结的证据交接方法/);
	assert.match(feedback, /交接时写清未执行项和条件/);
	assert.match(feedback, /必须独立复算/);
});

test("M07 keeps the begun method body after pointer change and blocks a new task after a live limit", async (t) => {
	const f = await fixture(t);
	const ref: KnowledgeRef = { storeId: await f.knowledge.storeId(), recordId: "E001", version: 1 };
	const original = await f.generations.readStrategy("H0");
	const dependent = await f.generations.writeStrategy({ versionId: "H-live", kind: "executor", artifact: original.artifact, parentVersionId: "H0", origin: "human-seed", applicability: original.applicability, limitations: [], requiredKnowledgeRefs: [ref], state: "manual-active" });
	const bound = await f.generations.writeBundle({ bundleId: "bundle-live", parents: [f.bundle.bundleId], executorVersionId: dependent.versionId, improverVersionId: "I0", knowledgeSnapshot: f.first.snapshotId, environmentVersion: f.bundle.environmentVersion, modelConfig: f.bundle.modelConfig, protocolVersion: f.bundle.protocolVersion, allowedCapabilities: f.bundle.allowedCapabilities, state: "manual-active" });
	await f.generations.activate(bound.bundleId, (await f.generations.active())!.pointer, "external-manual-unverified", "live-bound");
	const controller = createM07Controller(f.ctx);
	const begun = await controller.begin({ ...goal, workflowMethodVersionId: dependent.versionId });
	const later = await f.generations.writeStrategy({ versionId: "H-later", kind: "executor", artifact: { version: 1, kind: "m07-workflow-prompt", slot: "research-check", body: "另一份后来的方法正文" }, origin: "human-seed", applicability: ["M07"], limitations: [], state: "manual-active" });
	const laterBundle = await f.generations.writeBundle({ bundleId: "bundle-later", parents: [bound.bundleId], executorVersionId: later.versionId, improverVersionId: "I0", knowledgeSnapshot: bound.knowledgeSnapshot, environmentVersion: bound.environmentVersion, modelConfig: bound.modelConfig, protocolVersion: bound.protocolVersion, allowedCapabilities: bound.allowedCapabilities, state: "manual-active" });
	await f.generations.activate(laterBundle.bundleId, (await f.generations.active())!.pointer, "external-manual-unverified", "later");
	await controller.delegate(begun.runId, { objective: "检查冻结内容", inputs: [], expectedOutputs: [], checks: ["必须独立复算"], mode: "reason" });
	const sent = [...f.runner.sessions.values()].at(-1)!.transcript[0]!.text;
	assert.match(sent, /先做独立复算并报告未执行检查/);
	assert.doesNotMatch(sent, /另一份后来的方法正文/);
	const before = f.runner.created.length;
	await publish(f.ws, f.knowledge, [{ op: "limit", target: "E001", kind: "withdrawn", reason: "原证据撤回", authority: "review" }]);
	await assert.rejects(controller.delegate(begun.runId, { objective: "不得越过停用", inputs: [], expectedOutputs: [], checks: ["必须独立复算"], mode: "reason" }), /snapshot changed|unavailable/);
	assert.equal(f.runner.created.length, before);
});

test("necessary premise discharge needs an exact adopted M04 D, registered E evidence and revalidation; old restriction stays live", async (t) => {
	const f = await fixture(t);
	const storeId = await f.knowledge.storeId();
	const oldRef: KnowledgeRef = { storeId, recordId: "E001", version: 1 };
	const oldH = await f.generations.readStrategy("H0");
	const dependent = await f.generations.writeStrategy({ versionId: "H-dependent", kind: "executor", artifact: oldH.artifact, parentVersionId: "H0", origin: "human-seed", applicability: oldH.applicability, limitations: [], requiredKnowledgeRefs: [oldRef], state: "manual-active" });
	const bundle = await f.generations.writeBundle({ bundleId: "bundle-dependent", parents: [f.bundle.bundleId], executorVersionId: dependent.versionId, improverVersionId: "I0", knowledgeSnapshot: f.first.snapshotId, environmentVersion: f.bundle.environmentVersion, modelConfig: f.bundle.modelConfig, protocolVersion: f.bundle.protocolVersion, allowedCapabilities: f.bundle.allowedCapabilities, state: "manual-active" });
	await f.generations.activate(bundle.bundleId, (await f.generations.active())!.pointer, "external-manual-unverified", "dependent");
	const nextRef: KnowledgeRef = { storeId, recordId: "E002", version: 1 };
	const revalidationRef: KnowledgeRef = { storeId, recordId: "E003", version: 1 };
	const decisionRef: KnowledgeRef = { storeId, recordId: "D001", version: 1 };
	const decision = await publish(f.ws, f.knowledge, [
		{ op: "create", type: "E", title: "替代依据", body: "新证据记录", usageDecision: "adopted" },
		{ op: "create", type: "E", title: "方法复验", body: "复验记录", usageDecision: "adopted", fields: { methodRevalidation: { version: 1, methodVersionId: dependent.versionId, result: "passed" } } },
		{ op: "create", type: "D", title: "必要前提替换决定", body: "决定只解除精确旧引用", usageDecision: "adopted", fields: { methodDependencyTransition: { version: 1, methodVersionId: dependent.versionId, remove: [oldRef], add: [nextRef], evidenceRefs: [nextRef], revalidationRef } } },
		{ op: "limit", target: "E001", kind: "needs_recheck", reason: "旧数据已失效", authority: "review" },
	]);
	await assert.rejects(transitionMethodKnowledgeDependenciesInLock({ workspaceRoot: f.root, generationStore: f.generations, m04RunId: decision.runId, expectedActiveBundleId: bundle.bundleId, methodVersionId: dependent.versionId, decisionRef: { ...decisionRef, version: 2 } }), /adopted usable M04 D|unavailable/);
	assert.equal((await f.generations.active())?.bundle.bundleId, bundle.bundleId);
	const result = await transitionMethodKnowledgeDependenciesInLock({ workspaceRoot: f.root, generationStore: f.generations, m04RunId: decision.runId, expectedActiveBundleId: bundle.bundleId, methodVersionId: dependent.versionId, decisionRef });
	const revised = await f.generations.readStrategy(result.newMethodVersionId);
	assert.deepEqual(revised.requiredKnowledgeRefs, [nextRef]);
	assert.equal(revised.parentVersionId, dependent.versionId);
	assert.deepEqual(revised.dependencyTransition?.removedRefs, [oldRef]);
	assert.deepEqual((await f.generations.readStrategy(dependent.versionId)).requiredKnowledgeRefs, [oldRef]);
	assert.equal((await f.knowledge.availability("E001", 1)).availability, "needs_recheck");
	assert.equal(result.pointer.provenance, "method-dependency-transition");
});
