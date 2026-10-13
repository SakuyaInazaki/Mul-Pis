import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { main } from "../src/cli.ts";
import { GenerationStore } from "../src/improvement/generation.ts";
import { ResearchImprovementService } from "../src/improvement/research-service.ts";
import { validateWorkflowPlan, type WorkflowEvidenceHandoffPlanV1 } from "../src/improvement/workflow-types.ts";
import { createFileKnowledgeStore } from "../src/knowledge/store.ts";
import { createM07Controller } from "../src/m07/controller.ts";
import { FakeSessionRunner, type FakeReplyContext } from "../src/runner/fake.ts";
import { runM04 } from "../src/stages/m04.ts";
import type { StageContext } from "../src/stages/context.ts";
import { Workspace } from "../src/workspace.ts";

const usage = { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 120, cost: 0.001 };
const goal = { goal: "核对一个固定材料的证据交接", problemRelation: "直接关联", constraints: ["原问题不变"], successCriteria: ["保留原始证据与未执行项"], plan: "单项证据交接", exploratory: false };
const task = { objective: "交接固定证据", inputs: [] as string[], expectedOutputs: [], checks: ["报告包含核查结果"], mode: "reason" as const };
const caseOf = (split: "development" | "admission", id: string, marker: string) => ({ version: 1, split, cases: [{ id, goal: { ...goal, plan: `${goal.plan} ${id}` }, task: { ...task, objective: `${task.objective} ${id}` }, checks: [{ criterion: task.checks[0], contains: [marker], forbids: ["伪造证据"] }] }] });
const limits = { maxProviderCalls: 40, maxInputTokens: 2_000_000, maxSdkEstimatedCost: 10, maxProbeCalls: 0, maxCpuMillis: 100_000, maxWallMillis: 120_000 };

test("workflow plan accepts omitted monetary references", () => {
	const p = { version: 1, kind: "m07-evidence-handoff/v1", developmentSource: { m07RunId: "m07", checkpointId: "C001", m04RunId: "m04" }, developmentCaseSetPath: "development.json", experimentRoot: "arms", maxFeedbackItems: 1, admissionRepetitions: 2 };
	assert.deepEqual(validateWorkflowPlan(p).budget, {});
	assert.throws(() => validateWorkflowPlan({ ...p, budget: { maxSdkEstimatedCost: Number.POSITIVE_INFINITY } }), /budget/);
	assert.equal(validateWorkflowPlan({ ...p, baseline: "builtin" }).baseline, "builtin");
	assert.throws(() => validateWorkflowPlan({ ...p, baseline: "unknown" }), /baseline/);
});

test("builtin comparison runs a real M07/M04 arm without injecting its proposal-seed H", async (t) => {
	const seedBody = "UNIQUE_PROPOSAL_SEED_H_BODY_NEVER_IN_BUILTIN_ARM";
	const candidateBody = "CANDIDATE_H_FOR_EVIDENCE_HANDOFF";
	let builtinMessages = 0, candidateMessages = 0;
	const f = await fixture(t, (ctx) => {
		if (ctx.spec.role === "improver") {
			const view = JSON.parse(ctx.message.slice(ctx.message.indexOf("\n") + 1));
			assert.equal(view.current.comparisonBaseline, "builtin");
			assert.equal(view.current.executorVersionId, "builtin-default");
			assert.equal(view.current.proposalSeedHVersionId, f.bundle.executorVersionId);
			assert.equal(view.current.baselineWorkflowHInjected, false);
			assert.equal(view.methods.executor.role, "proposal-seed-only");
			const index = Number(ctx.spec.label.split("-").at(-1));
			if (index === 0) return JSON.stringify({ kind: "propose", target: "executor", body: candidateBody, hypothesis: { claim: "交接字段可核对", predictedObservation: "检查通过", falsifier: "检查失败", applicability: ["M07"], motivatingEvidenceIds: [view.developmentSource.id] } });
			if (index === 1) return JSON.stringify({ kind: "evaluate-development", candidateId: view.methods.candidates[0].versionId });
			return JSON.stringify({ kind: "stop", reason: "选择开发候选", selectedCandidateId: view.methods.candidates[0].versionId });
		}
		if (ctx.spec.role === "research") return "已处理冻结证据报告。";
		if (ctx.spec.persistDir.includes(`${path.sep}arms${path.sep}`) && ctx.spec.label.startsWith("M07-") && ctx.spec.role === "execution") {
			assert.equal(ctx.message.includes(seedBody), false);
			if (ctx.message.includes(candidateBody)) candidateMessages++;
			else { builtinMessages++; assert.equal(ctx.message.includes("冻结的 M07 方法："), false); }
		}
		return ctx.message.includes(candidateBody) ? ctx.message.includes("holdout-b") ? "保护证据完整" : "开发证据完整" : "原始报告";
	}, false, false, seedBody);
	const improvement = path.join(f.ws.agentDir, "improvement");
	const policy = { version: 1, maxPromptChars: 180_000, maxInlineFileChars: 30_000, maxAggregateInlineChars: 120_000, maxFeedbackChars: 140_000, overflowMode: "manifest-and-defer" };
	await mkdir(path.join(improvement, "versions", "test-policy"), { recursive: true });
	await writeFile(path.join(improvement, "versions", "test-policy", "policy.json"), JSON.stringify(policy));
	await writeFile(path.join(improvement, "active.json"), JSON.stringify({ version: 1, versionId: "test-policy", promotedAt: new Date().toISOString(), runId: "test-policy-run" }));
	const currentK = (await f.knowledge.current())?.id;
	const formal = await f.ws.startRun("M04", [{ label: "原问题", path: f.ws.problemFile }], currentK);
	await f.ws.finishRun(formal, "completed");
	const run = await new ResearchImprovementService({ workspaceRoot: f.root, runner: f.runner }).runWorkflow({ ...f.plan, baseline: "builtin" });
	assert.equal(run.status, "promoted", run.stopReason ?? "");
	assert.equal(run.comparisonBaseline, "builtin");
	assert.equal(run.baselineExecutorVersionId, "builtin-default");
	assert.equal(run.proposalSeedHVersionId, f.bundle.executorVersionId);
	assert.ok(builtinMessages >= 3 && candidateMessages >= 3);
	for (const arm of [...run.developmentArms, ...run.protectedArms]) {
		const stored = await readFile(path.join(new Workspace(arm.workspaceRoot).runDir("M07", arm.m07RunId!), "goal.json"), "utf8");
		const savedGoal = JSON.parse(stored);
		assert.deepEqual(savedGoal.budgetPolicy, policy);
		assert.equal(savedGoal.budgetPolicyVersionId, "test-policy");
		if (arm.arm === "baseline") {
			assert.deepEqual(arm.methodBinding, { kind: "builtin" });
			assert.equal(arm.methodVersionId, "builtin-default");
			assert.equal(savedGoal.workflowMethod, undefined);
		} else {
			assert.deepEqual(arm.methodBinding, { kind: "injected-h", versionId: arm.methodVersionId });
			assert.equal(savedGoal.workflowMethod.versionId, arm.methodVersionId);
		}
	}
	const selection = JSON.parse(await readFile(run.selectionReceiptPath!, "utf8"));
	assert.equal(selection.comparisonBaseline, "builtin");
	assert.equal(selection.proposalSeedHVersionId, f.bundle.executorVersionId);
	assert.equal(selection.H0, undefined);
	const episode = JSON.parse(await readFile(path.join(f.gen.root, "workflow-runs", run.runId, "meta-episode.development.json"), "utf8"));
	assert.equal(episode.current.executorVersionId, "builtin-default");
	assert.equal(episode.current.proposalSeedHVersionId, f.bundle.executorVersionId);
	assert.deepEqual(episode.workflowDevelopmentArms.find((arm: { arm: string }) => arm.arm === "baseline").methodBinding, { kind: "builtin" });
});

test("builtin comparison accepts ordinary prompt text matching a short proposal-seed H body", async (t) => {
	const candidateBody = "列出可核查的开发证据。";
	const f = await fixture(t, (ctx) => {
		if (ctx.spec.role === "improver") {
			const view = JSON.parse(ctx.message.slice(ctx.message.indexOf("\n") + 1));
			const index = Number(ctx.spec.label.split("-").at(-1));
			if (index === 0) return JSON.stringify({ kind: "propose", target: "executor", body: candidateBody, hypothesis: { claim: "证据可核查", predictedObservation: "开发检查通过", falsifier: "开发检查失败", applicability: ["M07"], motivatingEvidenceIds: [view.developmentSource.id] } });
			if (index === 1) return JSON.stringify({ kind: "evaluate-development", candidateId: view.methods.candidates[0].versionId });
			return JSON.stringify({ kind: "stop", reason: "选择开发候选", selectedCandidateId: view.methods.candidates[0].versionId });
		}
		if (ctx.spec.role === "research") return "已处理冻结证据。";
		return ctx.message.includes(candidateBody) ? "开发证据完整" : "原始报告";
	}, false, false, "M07");
	const run = await new ResearchImprovementService({ workspaceRoot: f.root, runner: f.runner }).runWorkflow({ ...f.plan, baseline: "builtin", admissionCaseSetPath: undefined });
	assert.equal(run.status, "research-only", run.stopReason ?? "");
	assert.equal(run.developmentArms.length, 2);
	assert.ok(run.developmentArms.every((arm) => arm.status === "complete"), JSON.stringify(run.developmentArms.map((arm) => arm.reason)));
});

for (const protectedPolicyFile of [".agent/improvement/active.json", ".agent/improvement/versions/test-policy/policy.json"]) test(`protected G input cannot overlap copied ${protectedPolicyFile}`, async (t) => {
	const f = await fixture(t);
	const improvement = path.join(f.ws.agentDir, "improvement");
	await mkdir(path.join(improvement, "versions", "test-policy"), { recursive: true });
	await writeFile(path.join(improvement, "versions", "test-policy", "policy.json"), JSON.stringify({ version: 1, maxPromptChars: 180_000, maxInlineFileChars: 30_000, maxAggregateInlineChars: 120_000, maxFeedbackChars: 140_000, overflowMode: "manifest-and-defer" }));
	await writeFile(path.join(improvement, "active.json"), JSON.stringify({ version: 1, versionId: "test-policy", promotedAt: new Date().toISOString(), runId: "test-policy-run" }));
	const admission = caseOf("admission", "holdout-b", "保护证据完整");
	admission.cases[0]!.task.inputs = [protectedPolicyFile];
	await writeFile(path.join(f.root, "admission.json"), JSON.stringify(admission));
	const before = f.runner.created.length;
	const run = await new ResearchImprovementService({ workspaceRoot: f.root, runner: f.runner }).runWorkflow({ ...f.plan, baseline: "builtin" });
	assert.equal(run.status, "failed");
	assert.match(run.stopReason ?? "", /protected input.*overlaps/);
	assert.equal(f.runner.created.length, before);
});

async function fixture(t: import("node:test").TestContext, responder?: (ctx: FakeReplyContext) => string | Promise<string>, viaCli = false, withExperience = false, executorBody = "列出原始证据、限制和未执行项。") {
	const parent = await mkdtemp(path.join(os.tmpdir(), "pre-rsi-workflow-"));
	t.after(() => rm(parent, { recursive: true, force: true }));
	const root = path.join(parent, "source");
	const ws = new Workspace(root);
	await import("node:fs/promises").then(({ mkdir }) => mkdir(path.dirname(ws.problemFile), { recursive: true }));
	await writeFile(ws.problemFile, "固定原问题和证据材料。\n");
	await writeFile(ws.configFile, JSON.stringify({ roles: { default: "fake/default", execution: "fake/execution", reviewer: "fake/reviewer", improver: "fake/improver", research: "fake/research" }, concurrency: 1, tools: {} }));
	const knowledge = createFileKnowledgeStore(ws.knowledgeDir); await knowledge.init();
	let experienceRef: { storeId: string; recordId: string; version: number } | undefined;
	if (withExperience) {
		const proposal = await knowledge.submitProposal({ stage: "M04", runId: "workflow-experience-seed", ops: [{ op: "create", type: "K", title: "工作流交接经验", body: "先读取可见证据，再记录限制与未执行项。", usageDecision: "adopted", fields: { experience: { version: 1, targetKind: "improver", applicableStages: ["method-research"], requiredTags: ["m07-evidence-handoff"], excludedTags: [], requiredRefs: [] } } }] });
		assert.equal(proposal.structurallyValid, true);
		await knowledge.merge(proposal.proposalId);
		experienceRef = { storeId: await knowledge.storeId(), recordId: "K001", version: 1 };
	}
	const initial = await ws.startRun("M04", [{ label: "原问题", path: ws.problemFile }], (await knowledge.current())?.id);
	await ws.finishRun(initial, "completed");
	const gen = new GenerationStore(root);
	const seed = { version: 1 as const, executor: { version: 1 as const, kind: "m07-workflow-prompt" as const, slot: "evidence-handoff" as const, body: executorBody }, improver: { version: 1 as const, kind: "diagnostic-improver-prompt" as const, body: "依据开发反馈提出一个可检验的证据交接改进。" }, applicability: ["M07"] };
	if (viaCli) { await writeFile(path.join(root, "methods.json"), JSON.stringify(seed)); assert.equal(await main(["improve", "research", "bootstrap", "--workspace", root, "--methods", path.join(root, "methods.json")]), 0); }
	else await new ResearchImprovementService({ workspaceRoot: root, runner: new FakeSessionRunner(() => "unused") }).bootstrap(seed);
	const bundle = (await gen.active())!.bundle;
	assert.equal(bundle.environmentVersion, "m07-workflow/v1");
	assert.deepEqual(bundle.allowedCapabilities, ["m07-evidence-read", "no-tools-model"]);
	const runner = new FakeSessionRunner(async (ctx) => ({ text: responder ? await responder(ctx) : ctx.spec.role === "research" ? "已按冻结包处理。" : "原材料报告，尚缺开发标记。", usage }));
	const ctx: StageContext = { ws, store: knowledge, runner, config: await ws.loadConfig() };
	const controller = createM07Controller(ctx);
	const begun = await controller.begin({ ...goal, workflowMethodVersionId: bundle.executorVersionId });
	const delegated = await controller.delegate(begun.runId, task);
	assert.equal(delegated.status, "returned");
	await controller.review(begun.runId, { taskId: delegated.taskId, checks: [{ criterion: task.checks[0], result: "passed", evidence: [delegated.reportPath!] }], artifacts: [delegated.reportPath!] });
	const checkpoint = await controller.checkpoint(begun.runId, { taskIds: [delegated.taskId] });
	const processed = await runM04(ctx, { feedback: { kind: "M07Checkpoint", runId: begun.runId, checkpointId: checkpoint.id }, freshSession: true });
	const plan: WorkflowEvidenceHandoffPlanV1 = { version: 1, kind: "m07-evidence-handoff/v1", developmentSource: { m07RunId: begun.runId, checkpointId: checkpoint.id, m04RunId: processed.record.runId }, developmentCaseSetPath: "development.json", admissionCaseSetPath: "admission.json", experimentRoot: path.join(parent, "arms"), maxDecisions: 3, maxCandidates: 1, maxInspectActions: 1, maxReadbackChars: 4_000, maxFeedbackItems: 8, perPromptTimeoutMs: 30_000, budget: limits, admissionRepetitions: 2 };
	await writeFile(path.join(root, "development.json"), JSON.stringify(caseOf("development", "dev-a", "开发证据完整")));
	await writeFile(path.join(root, "admission.json"), JSON.stringify(caseOf("admission", "holdout-b", "保护证据完整")));
	return { parent, root, ws, gen, runner, plan, begun, bundle, knowledge, experienceRef };
}

test("workflow I can repeatedly inspect past the old cumulative readback limit", async (t) => {
	let reads = 0;
	const f = await fixture(t, (ctx) => {
		if (ctx.spec.role !== "improver") return "offline source";
		const view = JSON.parse(ctx.message.slice(ctx.message.indexOf("\n") + 1));
		assert.equal("remainingActions" in view, false);
		return JSON.stringify(reads++ < 11
			? { kind: "inspect", object: "method", id: view.current.executorVersionId, start: 0, maxChars: 4_000 }
			: { kind: "stop", reason: "eleven full method reads observed" });
	}, false, false, "x".repeat(4_000));
	const formal = await f.ws.startRun("M04", [{ label: "原问题", path: f.ws.problemFile }], (await f.knowledge.current())?.id);
	await f.ws.finishRun(formal, "completed");
	const run = await new ResearchImprovementService({ workspaceRoot: f.root, runner: f.runner }).runWorkflow({ ...f.plan, maxReadbackChars: 1, maxInspectActions: 1 });
	assert.equal(run.outcome, "completed-no-candidate", run.stopReason ?? "");
	assert.equal(run.decisions.filter((decision) => decision.action === "inspect").length, 11);
	assert.equal(run.inspectionReadbackBytesObserved, 44_000);
	assert.equal(reads, 12);
});

test("explicit workflow adapter runs frozen M07/M04 arms, checks G after selection, and activates only a new H", async (t) => {
	let proposed = false;
	const f = await fixture(t, (ctx) => {
		if (ctx.spec.role === "improver") {
			const index = Number(ctx.spec.label.split("-").at(-1));
			const view = JSON.parse(ctx.message.slice(ctx.message.indexOf("\n") + 1));
			assert.equal(view.environment, "m07-evidence-handoff/v1");
			assert.equal(ctx.message.includes("保护证据完整"), false, "protected G text must not reach I");
			if (index === 0) { proposed = true; return JSON.stringify({ kind: "propose", target: "executor", body: "将冻结证据、限制和未执行项分栏列出，并逐项绑定来源。", hypothesis: { claim: "明确证据交接字段会改善可核查性", predictedObservation: "固定检查能定位证据", falsifier: "独立检查仍找不到证据", applicability: ["M07"], motivatingEvidenceIds: [view.developmentSource.id] } }); }
			if (index === 1) return JSON.stringify({ kind: "evaluate-development", candidateId: view.methods.candidates[0].versionId });
			return JSON.stringify({ kind: "stop", reason: "独立评价", selectedCandidateId: view.methods.candidates[0].versionId });
		}
		if (ctx.spec.role === "research") return "已按冻结 M07 证据包处理。";
		if (!ctx.message.includes("将冻结证据、限制和未执行项分栏列出")) return "原材料报告，尚缺固定标记。";
		return ctx.message.includes("holdout-b") ? "保护证据完整；来源、限制和未执行项均列出。" : "开发证据完整；来源、限制和未执行项均列出。";
	});
	// The development handoff is historical; fresh arms must use the later formal M04 at the frozen K.
	const currentK = (await createFileKnowledgeStore(f.ws.knowledgeDir).current())?.id;
	const laterFormal = await f.ws.startRun("M04", [{ label: "原问题", path: f.ws.problemFile }], currentK);
	await f.ws.finishRun(laterFormal, "completed");
	const sourceM07 = await readFile(path.join(f.ws.runDir("M07", f.begun.runId), "goal.json"), "utf8");
	const result = await new ResearchImprovementService({ workspaceRoot: f.root, runner: f.runner }).runWorkflow(f.plan);
	assert.equal(proposed, true);
	assert.equal(result.status, "promoted", result.stopReason ?? "");
	assert.equal(result.developmentArms.length, 2);
	assert.equal(result.protectedArms.length, 4);
	assert.ok(result.selectionReceiptPath && result.protectedOpenedAt);
	assert.ok(result.promotedMethodVersionId);
	assert.equal((await f.gen.active())?.bundle.executorVersionId, result.promotedMethodVersionId);
	assert.equal((await f.gen.active())?.bundle.improverVersionId, f.bundle.improverVersionId);
	assert.equal(await readFile(path.join(f.ws.runDir("M07", f.begun.runId), "goal.json"), "utf8"), sourceM07, "existing goal must not be hot-swapped");
});

test("workflow promotion is not blocked by a legacy wall-time quota after G", async (t) => {
	const f = await fixture(t, (ctx) => {
		if (ctx.spec.role === "improver") {
			const index = Number(ctx.spec.label.split("-").at(-1));
			const view = JSON.parse(ctx.message.slice(ctx.message.indexOf("\n") + 1));
			if (index === 0) return JSON.stringify({ kind: "propose", target: "executor", body: "将冻结证据、限制和未执行项分栏列出，并逐项绑定来源。", hypothesis: { claim: "交接字段可复查", predictedObservation: "固定检查通过", falsifier: "检查失败", applicability: ["M07"], motivatingEvidenceIds: [view.developmentSource.id] } });
			if (index === 1) return JSON.stringify({ kind: "evaluate-development", candidateId: view.methods.candidates[0].versionId });
			return JSON.stringify({ kind: "stop", reason: "选择开发候选", selectedCandidateId: view.methods.candidates[0].versionId });
		}
		if (ctx.spec.role === "research") return "已按冻结 M07 证据包处理。";
		return ctx.message.includes("将冻结证据、限制和未执行项分栏列出") ? ctx.message.includes("holdout-b") ? "保护证据完整；来源、限制和未执行项均列出。" : "开发证据完整；来源、限制和未执行项均列出。" : "原材料报告，尚缺固定标记。";
	});
	const currentK = (await createFileKnowledgeStore(f.ws.knowledgeDir).current())?.id;
	const formal = await f.ws.startRun("M04", [{ label: "原问题", path: f.ws.problemFile }], currentK);
	await f.ws.finishRun(formal, "completed");
	const before = (await f.gen.active())!.bundle.bundleId;
	let now = Date.now(), admittedBundleWritten = false;
	t.mock.method(Date, "now", () => now);
	const writeBundle = GenerationStore.prototype.writeBundle;
	t.mock.method(GenerationStore.prototype, "writeBundle", async function(this: GenerationStore, input: Parameters<GenerationStore["writeBundle"]>[0]) {
		const bundle = await writeBundle.call(this, input);
		if (input.state === "admitted") { admittedBundleWritten = true; now += limits.maxWallMillis + 1; }
		return bundle;
	});
	const run = await new ResearchImprovementService({ workspaceRoot: f.root, runner: f.runner }).runWorkflow(f.plan);
	assert.equal(admittedBundleWritten, true, run.stopReason ?? "");
	assert.equal(run.status, "promoted");
	assert.notEqual((await f.gen.active())!.bundle.bundleId, before);
});

test("no winner, including an explicit null selection, performs no protected G work", async (t) => {
	const f = await fixture(t, (ctx) => ctx.spec.role === "improver" ? JSON.stringify({ kind: "stop", reason: "开发材料不足", selectedCandidateId: null }) : ctx.spec.role === "research" ? "处理开发证据" : "原始报告");
	const before = (await f.gen.active())!.bundle.bundleId;
	const result = await new ResearchImprovementService({ workspaceRoot: f.root, runner: f.runner }).runWorkflow({ ...f.plan, maxDecisions: 1 });
	assert.equal(result.outcome, "completed-no-candidate");
	assert.equal(result.protectedArms.length, 0);
	assert.equal((await f.gen.active())!.bundle.bundleId, before);
});

test("workflow I receives one explicit frozen experience pack and records consulted refs on H", async (t) => {
	const packs: string[] = [];
	const f = await fixture(t, (ctx) => {
		if (ctx.spec.role !== "improver") return ctx.spec.role === "research" ? "处理冻结证据" : "原始报告";
		const view = JSON.parse(ctx.message.slice(ctx.message.indexOf("\n") + 1));
		packs.push(JSON.stringify(view.experience));
		assert.match(view.experience.markdown, /先读取可见证据/);
		const index = Number(ctx.spec.label.split("-").at(-1));
		return index === 0 ? JSON.stringify({ kind: "propose", target: "executor", body: "在交接中逐项引用冻结证据与限制。", hypothesis: { claim: "交接更完整", predictedObservation: "固定检查通过", falsifier: "固定检查失败", applicability: ["M07"], motivatingEvidenceIds: [view.developmentSource.id] } }) : JSON.stringify({ kind: "stop", reason: "保留开发候选", selectedCandidateId: view.methods.candidates[0].versionId });
	}, false, true);
	const formal = await f.ws.startRun("M04", [{ label: "原问题", path: f.ws.problemFile }], (await f.knowledge.current())?.id);
	await f.ws.finishRun(formal, "completed");
	const run = await new ResearchImprovementService({ workspaceRoot: f.root, runner: f.runner }).runWorkflow({ ...f.plan, admissionCaseSetPath: undefined, maxDecisions: 2, experienceRefs: [f.experienceRef!], experienceMaxRecords: 1, experienceMaxChars: 2_000 });
	assert.equal(run.status, "inconclusive", run.stopReason ?? "");
	assert.equal(packs.length, 2);
	assert.equal(new Set(packs).size, 1, "both I decisions see the same frozen pack");
	assert.equal(run.candidates.length, 1);
	const candidate = await f.gen.readStrategy(run.candidates[0]!.versionId);
	assert.deepEqual(candidate.sourceExperienceRefs, [{ targetKind: "improver", ref: f.experienceRef }]);
	assert.equal(run.protectedArms.length, 0);
});

test("workflow I selection fails closed before a call when unavailable or changed", async (t) => {
	let calls = 0;
	let withdraw = false;
	const f = await fixture(t, async (ctx) => {
		if (ctx.spec.role !== "improver") return ctx.spec.role === "research" ? "处理冻结证据" : "原始报告";
		calls++;
		if (withdraw) {
			const proposal = await f.knowledge.submitProposal({ stage: "M04", runId: "withdraw-workflow-experience", ops: [{ op: "limit", target: "K001", kind: "withdrawn", reason: "离线回归撤回", authority: "test-review" }] });
			assert.equal(proposal.structurallyValid, true);
			await f.knowledge.merge(proposal.proposalId);
		}
		return JSON.stringify({ kind: "inspect", object: "method", id: JSON.parse(ctx.message.slice(ctx.message.indexOf("\n") + 1)).current.executorVersionId, start: 0, maxChars: 20 });
	}, false, true);
	const formal = await f.ws.startRun("M04", [{ label: "原问题", path: f.ws.problemFile }], (await f.knowledge.current())?.id);
	await f.ws.finishRun(formal, "completed");
	const plan = { ...f.plan, maxDecisions: 2, experienceRefs: [f.experienceRef!], experienceMaxRecords: 1, experienceMaxChars: 2_000 };
	const unavailable = await new ResearchImprovementService({ workspaceRoot: f.root, runner: f.runner }).runWorkflow({ ...plan, experimentRoot: path.join(f.parent, "unavailable-arms"), experienceRefs: [{ ...f.experienceRef!, recordId: "K999" }] });
	assert.equal(unavailable.status, "inconclusive");
	assert.equal(unavailable.decisions.length, 0);
	assert.equal(calls, 0);
	withdraw = true;
	const changed = await new ResearchImprovementService({ workspaceRoot: f.root, runner: f.runner }).runWorkflow({ ...plan, experimentRoot: path.join(f.parent, "changed-arms") });
	assert.equal(changed.status, "inconclusive", changed.stopReason ?? "");
	assert.match(changed.stopReason ?? "", /experience|knowledge epoch|live limits/);
	assert.equal(calls, 1, "withdrawal blocks the next I request");
});

test("workflow I experience plan requires exact pinned refs and positive bounds", async (t) => {
	const f = await fixture(t);
	assert.throws(() => validateWorkflowPlan({ ...f.plan, experienceRefs: [{ storeId: "unregistered", recordId: "K001", version: 1 }], experienceMaxRecords: 1, experienceMaxChars: 2_000 }), /experienceRefs/);
	const ref = { storeId: await f.knowledge.storeId(), recordId: "K001", version: 1 };
	assert.throws(() => validateWorkflowPlan({ ...f.plan, experienceRefs: [ref], experienceMaxRecords: 0, experienceMaxChars: 2_000 }), /experience/);
	assert.throws(() => validateWorkflowPlan({ ...f.plan, experienceRefs: [ref, ref], experienceMaxRecords: 2, experienceMaxChars: 2_000 }), /experienceRefs/);
});

test("workflow research keeps its frozen K when unrelated live knowledge advances", async (t) => {
	let calls = 0;
	const f = await fixture(t, async (ctx) => {
		if (ctx.spec.role !== "improver") return ctx.spec.role === "research" ? "处理冻结证据" : "原始报告";
		calls++;
		if (calls === 1) {
			const proposal = await f.knowledge.submitProposal({ stage: "M04", runId: "workflow-epoch-change", ops: [{ op: "create", type: "K", title: "新知识版本", body: "离线测试更新", usageDecision: "candidate" }] });
			assert.equal(proposal.structurallyValid, true);
			await f.knowledge.merge(proposal.proposalId);
		}
		const view = JSON.parse(ctx.message.slice(ctx.message.indexOf("\n") + 1));
		assert.deepEqual(view.experience, { markdown: "", refs: [] });
		return JSON.stringify(calls === 1 ? { kind: "inspect", object: "method", id: view.current.executorVersionId, start: 0, maxChars: 20 } : { kind: "stop", reason: "frozen research source inspected" });
	});
	const formal = await f.ws.startRun("M04", [{ label: "原问题", path: f.ws.problemFile }], (await f.knowledge.current())?.id);
	await f.ws.finishRun(formal, "completed");
	const before = (await f.gen.active())!.bundle.bundleId;
	const run = await new ResearchImprovementService({ workspaceRoot: f.root, runner: f.runner }).runWorkflow({ ...f.plan, maxDecisions: 2 });
	assert.equal(run.status, "research-only", run.stopReason ?? "");
	assert.equal(calls, 2);
	assert.equal((await createFileKnowledgeStore(path.join(f.plan.experimentRoot, "template", ".agent", "knowledge")).current())?.id, f.bundle.knowledgeSnapshot);
	assert.notEqual((await f.knowledge.current())?.id, f.bundle.knowledgeSnapshot);
	assert.equal((await f.gen.active())!.bundle.bundleId, before);
});

test("missing current formal M04/K match stops before an I provider call", async (t) => {
	const f = await fixture(t);
	const wrongEpoch = await f.ws.startRun("M04", [{ label: "原问题", path: f.ws.problemFile }], "different-knowledge-epoch");
	await f.ws.finishRun(wrongEpoch, "completed");
	const before = f.runner.created.length;
	const run = await new ResearchImprovementService({ workspaceRoot: f.root, runner: f.runner }).runWorkflow(f.plan);
	assert.equal(run.status, "failed");
	assert.match(run.stopReason!, /current formal M04 baseline/);
	assert.equal(run.decisions.length, 0);
	assert.equal(run.budgetAtEnd && (run.budgetAtEnd as { committed: { providerCalls: number } }).committed.providerCalls, 0);
	assert.equal(f.runner.created.length, before);
});

test("selected development H remains research-only when independent G is absent", async (t) => {
	const f = await fixture(t, (ctx) => {
		if (ctx.spec.role === "improver") {
			const index = Number(ctx.spec.label.split("-").at(-1));
			const view = JSON.parse(ctx.message.slice(ctx.message.indexOf("\n") + 1));
			if (index === 0) return JSON.stringify({ kind: "propose", target: "executor", body: "将冻结证据、限制和未执行项分栏列出，并逐项绑定来源。", hypothesis: { claim: "交接字段可复查", predictedObservation: "固定开发检查通过", falsifier: "检查失败", applicability: ["M07"], motivatingEvidenceIds: [view.developmentSource.id] } });
			if (index === 1) return JSON.stringify({ kind: "evaluate-development", candidateId: view.methods.candidates[0].versionId });
			return JSON.stringify({ kind: "stop", reason: "开发阶段选择", selectedCandidateId: view.methods.candidates[0].versionId });
		}
		if (ctx.spec.role === "research") return "处理冻结证据";
		return ctx.message.includes("将冻结证据、限制和未执行项分栏列出") ? "开发证据完整；来源、限制和未执行项。" : "原始报告";
	});
	const before = (await f.gen.active())!.bundle.bundleId;
	const run = await new ResearchImprovementService({ workspaceRoot: f.root, runner: f.runner }).runWorkflow({ ...f.plan, admissionCaseSetPath: undefined });
	assert.equal(run.status, "research-only", run.stopReason ?? "");
	assert.ok(run.selectedCandidateId);
	assert.equal(run.protectedArms.length, 0);
	assert.equal((await f.gen.active())!.bundle.bundleId, before);
	assert.equal(run.scientificBenefit, "unverified");
});

test("ordinary M07 begin and delegation do not call I or change the active H", async (t) => {
	const f = await fixture(t);
	const before = (await f.gen.active())!.bundle.bundleId;
	const improverBefore = f.runner.created.filter((spec) => spec.role === "improver").length;
	const controller = createM07Controller({ ws: f.ws, store: createFileKnowledgeStore(f.ws.knowledgeDir), runner: f.runner, config: await f.ws.loadConfig() });
	const begun = await controller.begin(goal);
	const delegated = await controller.delegate(begun.runId, task);
	assert.equal(delegated.status, "returned");
	assert.equal(begun.workflowMethod, undefined);
	assert.equal(f.runner.created.filter((spec) => spec.role === "improver").length, improverBefore);
	assert.equal((await f.gen.active())!.bundle.bundleId, before);
});

test("workflow adapter rejects an overlapping experiment root before model calls", async (t) => {
	const f = await fixture(t);
	const before = f.runner.created.length;
	await assert.rejects(new ResearchImprovementService({ workspaceRoot: f.root, runner: f.runner }).runWorkflow({ ...f.plan, experimentRoot: path.join(f.root, "arms") }), /disjoint/);
	assert.equal(f.runner.created.length, before);
});

test("protected G file inside pre-copied raw material is rejected before I can inspect it", async (t) => {
	const f = await fixture(t);
	await mkdir(f.ws.rawDir, { recursive: true });
	await writeFile(path.join(f.ws.rawDir, "protected.json"), JSON.stringify(caseOf("admission", "holdout-b", "保护证据完整")));
	const before = f.runner.created.length;
	const run = await new ResearchImprovementService({ workspaceRoot: f.root, runner: f.runner }).runWorkflow({ ...f.plan, admissionCaseSetPath: "problem/raw/protected.json" });
	assert.equal(run.status, "failed");
	assert.match(run.stopReason!, /protected case file overlaps/);
	assert.equal(f.runner.created.length, before);
});

test("workflow development source retains processing beyond the former 8,000-character clip", async (t) => {
	let inspected = false;
	const marker = "COMPLETE_PROCESSING_TAIL_VISIBLE";
	const f = await fixture(t, (ctx) => {
		if (ctx.spec.role !== "improver") return "offline source";
		const view = JSON.parse(ctx.message.slice(ctx.message.indexOf("\n") + 1));
		if (!view.lastActionResult) {
			assert.ok(view.developmentSource.totalChars > 8_000);
			assert.ok(view.developmentSource.totalUtf8Bytes >= view.developmentSource.totalChars);
			return JSON.stringify({ kind: "inspect", object: "development-feedback", id: view.developmentSource.id, start: view.developmentSource.totalChars - 500, maxChars: 500 });
		}
		assert.match(view.lastActionResult.text, /COMPLETE_PROCESSING_TAIL_VISIBLE/);
		inspected = true;
		return JSON.stringify({ kind: "stop", reason: "full registered processing inspected" });
	});
	const m04 = await f.ws.readRun("M04", f.plan.developmentSource.m04RunId);
	const processed = m04.outputs.find((item) => item.label === "处理结果")!;
	await writeFile(processed.path, `${"A".repeat(9_000)}${marker}`);
	const run = await new ResearchImprovementService({ workspaceRoot: f.root, runner: f.runner }).runWorkflow(f.plan);
	assert.equal(run.outcome, "completed-no-candidate", run.stopReason ?? "");
	assert.equal(inspected, true);
});

test("isolated workflow copy accepts a plain tree deeper than twelve directories", async (t) => {
	const f = await fixture(t, (ctx) => ctx.spec.role === "improver" ? JSON.stringify({ kind: "stop", reason: "plain source copy inspected" }) : "offline source");
	const levels = Array.from({ length: 14 }, (_, index) => `level-${index}`);
	const nestedDir = path.join(f.ws.rawDir, ...levels);
	await mkdir(nestedDir, { recursive: true });
	await writeFile(path.join(nestedDir, "source.txt"), "deep but ordinary frozen evidence");
	const run = await new ResearchImprovementService({ workspaceRoot: f.root, runner: f.runner }).runWorkflow(f.plan);
	assert.equal(run.outcome, "completed-no-candidate", run.stopReason ?? "");
	assert.equal(await readFile(path.join(f.plan.experimentRoot, "template", "problem", "raw", ...levels, "source.txt"), "utf8"), "deep but ordinary frozen evidence");
});

test("problem/config symlinks cannot seed an isolated workflow arm", async (t) => {
	const f = await fixture(t);
	const source = await readFile(f.ws.problemFile, "utf8");
	await rm(f.ws.problemFile);
	await writeFile(path.join(f.root, "problem-copy.md"), source);
	await symlink(path.join(f.root, "problem-copy.md"), f.ws.problemFile);
	const before = f.runner.created.length;
	const run = await new ResearchImprovementService({ workspaceRoot: f.root, runner: f.runner }).runWorkflow(f.plan);
	assert.equal(run.status, "failed");
	assert.match(run.stopReason!, /confined regular file/);
	assert.equal(f.runner.created.length, before);
});

test("public CLI bootstrap feeds the explicit workflow entry and fails closed on fake usage", async (t) => {
	const f = await fixture(t, undefined, true);
	const planFile = path.join(f.root, "workflow-plan.json");
	await writeFile(planFile, JSON.stringify({ ...f.plan, maxDecisions: 1 }));
	const output: string[] = [];
	const original = console.log;
	console.log = (...values: unknown[]) => { output.push(values.map(String).join(" ")); };
	try { assert.equal(await main(["improve", "research", "workflow", "run", "--workspace", f.root, "--plan", planFile, "--runner", "fake"]), 0); }
	finally { console.log = original; }
	const result = JSON.parse(output.at(-1)!) as { status: string; outcome: string; protectedArms: unknown[] };
	assert.equal(result.status, "inconclusive", output.at(-1) ?? "");
	assert.equal(result.outcome, "search-incomplete");
	assert.equal(result.protectedArms.length, 0);
});

test("later workflow I can inspect a same-workspace development MetaEpisode without G", async (t) => {
	let priorRunId = "";
	const f = await fixture(t, (ctx) => {
		if (ctx.spec.role !== "improver") return "offline source";
		const view = JSON.parse(ctx.message.slice(ctx.message.indexOf("\n") + 1));
		if (!priorRunId) return JSON.stringify({ kind: "stop", reason: "first development pass" });
		assert.equal(view.metaEpisodes.length, 1);
		assert.equal(view.metaEpisodes[0].runId, priorRunId);
		assert.equal(ctx.message.includes("保护证据完整"), false);
		if (view.lastActionResult === undefined) return JSON.stringify({ kind: "inspect", object: "meta-episode", id: view.metaEpisodes[0].id, start: 0, maxChars: 1000 });
		assert.equal(view.lastActionResult.kind, "inspect");
		assert.match(view.lastActionResult.text, /"terminal":"no-winner"/);
		return JSON.stringify({ kind: "stop", reason: "prior episode readback available" });
	});
	const service = new ResearchImprovementService({ workspaceRoot: f.root, runner: f.runner });
	const first = await service.runWorkflow({ ...f.plan, maxDecisions: 1 });
	assert.equal(first.outcome, "completed-no-candidate");
	priorRunId = first.runId;
	// A pre-baseline-selector episode has no comparison or proposal-seed fields.
	const firstDir = path.join(f.gen.root, "workflow-runs", first.runId);
	const oldRun = JSON.parse(await readFile(path.join(firstDir, "run.json"), "utf8"));
	delete oldRun.comparisonBaseline;
	delete oldRun.proposalSeedHVersionId;
	await writeFile(path.join(firstDir, "run.json"), JSON.stringify(oldRun));
	const oldEpisode = JSON.parse(await readFile(path.join(firstDir, "meta-episode.development.json"), "utf8"));
	delete oldEpisode.current.comparisonBaseline;
	delete oldEpisode.current.proposalSeedHVersionId;
	delete oldEpisode.current.baselineWorkflowHInjected;
	await writeFile(path.join(firstDir, "meta-episode.development.json"), JSON.stringify(oldEpisode));
	const second = await service.runWorkflow({ ...f.plan, maxDecisions: 2, experimentRoot: path.join(f.parent, "arms-second"), metaEpisodeRunIds: [first.runId] });
	assert.equal(second.outcome, "completed-no-candidate", second.stopReason ?? "");
	assert.equal(second.protectedArms.length, 0);
});


test("protected cases and input bytes are fixed before I and hidden during development", async (t) => {
	let selected = false;
	const f = await fixture(t, async (ctx) => {
		if (ctx.spec.role === "improver") {
			const view = JSON.parse(ctx.message.slice(ctx.message.indexOf("\n") + 1));
			assert.equal(ctx.message.includes("ORIGINAL_HOLDOUT"), false);
			assert.equal(ctx.message.includes("保护证据完整"), false);
			await assert.rejects(readFile(path.join(f.plan.experimentRoot, "template", "holdout.txt")));
			const index = Number(ctx.spec.label.split("-").at(-1));
			if (index === 0) {
				await writeFile(path.join(f.root, "admission.json"), JSON.stringify(caseOf("admission", "changed-case", "CHANGED_CHECK")));
				await writeFile(path.join(f.root, "holdout.txt"), "CHANGED_INPUT");
				return JSON.stringify({ kind: "propose", target: "executor", body: "逐项列出冻结证据来源。", hypothesis: { claim: "可复查", predictedObservation: "检查通过", falsifier: "证据缺失", applicability: ["M07"], motivatingEvidenceIds: [view.developmentSource.id] } });
			}
			if (index === 1) return JSON.stringify({ kind: "evaluate-development", candidateId: view.methods.candidates[0].versionId });
			selected = true;
			return JSON.stringify({ kind: "stop", reason: "选择候选", selectedCandidateId: view.methods.candidates[0].versionId });
		}
		if (ctx.spec.role === "research") return "处理冻结报告";
		if (!ctx.message.includes("逐项列出冻结证据来源")) return "原始报告";
		if (ctx.message.includes("holdout-b")) {
			assert.equal(selected, true);
			assert.match(ctx.message, /ORIGINAL_HOLDOUT/);
			assert.equal(ctx.message.includes("CHANGED_INPUT"), false);
			return "保护证据完整";
		}
		return "开发证据完整";
	});
	const admission = caseOf("admission", "holdout-b", "保护证据完整");
	admission.cases[0]!.task.inputs = ["holdout.txt"];
	await writeFile(path.join(f.root, "admission.json"), JSON.stringify(admission));
	await writeFile(path.join(f.root, "holdout.txt"), "ORIGINAL_HOLDOUT");
	const run = await new ResearchImprovementService({ workspaceRoot: f.root, runner: f.runner }).runWorkflow(f.plan);
	assert.equal(run.status, "promoted", run.stopReason ?? "");
	assert.ok(run.protectedArms.every((arm) => arm.caseId === "holdout-b"));
});

test("protected input colliding with an arm-generated file is never silently replaced", async (t) => {
	const candidateBody = "逐项核对证据来源。";
	const f = await fixture(t, (ctx) => {
		if (ctx.spec.role === "improver") {
			const view = JSON.parse(ctx.message.slice(ctx.message.indexOf("\n") + 1));
			const index = Number(ctx.spec.label.split("-").at(-1));
			if (index === 0) return JSON.stringify({ kind: "propose", target: "executor", body: candidateBody, hypothesis: { claim: "来源可核查", predictedObservation: "开发检查通过", falsifier: "来源缺失", applicability: ["M07"], motivatingEvidenceIds: [view.developmentSource.id] } });
			if (index === 1) return JSON.stringify({ kind: "evaluate-development", candidateId: view.methods.candidates[0].versionId });
			return JSON.stringify({ kind: "stop", reason: "选择开发候选", selectedCandidateId: view.methods.candidates[0].versionId });
		}
		if (ctx.spec.role === "research") return "处理冻结报告";
		return ctx.message.includes(candidateBody) ? ctx.message.includes("holdout-b") ? "保护证据完整" : "开发证据完整" : "原始报告";
	});
	const admission = caseOf("admission", "holdout-b", "保护证据完整");
	admission.cases[0]!.task.inputs = [path.relative(f.root, path.join(f.gen.root, "active.json"))];
	await writeFile(path.join(f.root, "admission.json"), JSON.stringify(admission));
	const run = await new ResearchImprovementService({ workspaceRoot: f.root, runner: f.runner }).runWorkflow(f.plan);
	assert.equal(run.status, "inconclusive", run.stopReason ?? "");
	assert.equal(run.protectedArms[0]?.status, "inconclusive");
	assert.match(run.protectedArms[0]?.reason ?? "", /frozen input.*collides/);
	assert.equal(run.protectedArms[0]?.m07RunId, undefined, "do not execute with substituted protected bytes");
});

test("protected inputs cannot also be development inputs", async (t) => {
	const f = await fixture(t);
	const development = caseOf("development", "dev-a", "开发证据完整");
	const admission = caseOf("admission", "holdout-b", "保护证据完整");
	development.cases[0]!.task.inputs = ["shared.txt"];
	admission.cases[0]!.task.inputs = ["shared.txt"];
	await writeFile(path.join(f.root, "shared.txt"), "protected material");
	await writeFile(path.join(f.root, "development.json"), JSON.stringify(development));
	await writeFile(path.join(f.root, "admission.json"), JSON.stringify(admission));
	const before = f.runner.created.length;
	const run = await new ResearchImprovementService({ workspaceRoot: f.root, runner: f.runner }).runWorkflow(f.plan);
	assert.equal(run.status, "failed");
	assert.match(run.stopReason!, /protected.*overlap/);
	assert.equal(f.runner.created.length, before);
});


for (const change of ["growth", "withdrawal"] as const) test(`protected evaluation preserves live knowledge ${change}`, async (t) => {
	let changed = false;
	let protectedCalls = 0;
	const f = await fixture(t, async (ctx) => {
		if (ctx.spec.role === "improver") {
			const view = JSON.parse(ctx.message.slice(ctx.message.indexOf("\n") + 1));
			const index = Number(ctx.spec.label.split("-").at(-1));
			if (index === 0) return JSON.stringify({ kind: "propose", target: "executor", body: "逐项列出冻结证据来源。", hypothesis: { claim: "可复查", predictedObservation: "检查通过", falsifier: "证据缺失", applicability: ["M07"], motivatingEvidenceIds: [view.developmentSource.id] } });
			if (index === 1) return JSON.stringify({ kind: "evaluate-development", candidateId: view.methods.candidates[0].versionId });
			return JSON.stringify({ kind: "stop", reason: "选择候选", selectedCandidateId: view.methods.candidates[0].versionId });
		}
		if (ctx.spec.role === "research") return "处理冻结报告";
		if (ctx.message.includes("holdout-b")) {
			protectedCalls++;
			if (!changed) {
				changed = true;
				const proposal = await f.knowledge.submitProposal({ stage: "M04", runId: "live-update", ops: change === "growth"
					? [{ op: "create", type: "K", title: "无关新知识", body: "继续积累", usageDecision: "candidate" }]
					: [{ op: "limit", target: "K001", kind: "withdrawn", reason: "离线撤回验证", authority: "test-review" }] });
				assert.equal(proposal.structurallyValid, true);
				await f.knowledge.merge(proposal.proposalId);
			}
		}
		if (!ctx.message.includes("逐项列出冻结证据来源")) return "原始报告";
		return ctx.message.includes("holdout-b") ? "保护证据完整" : "开发证据完整";
	}, false, true);
	const before = (await f.gen.active())!.bundle.bundleId;
	const run = await new ResearchImprovementService({ workspaceRoot: f.root, runner: f.runner }).runWorkflow({ ...f.plan, experienceRefs: [f.experienceRef!], experienceMaxRecords: 1, experienceMaxChars: 2_000 });
	assert.equal((await f.gen.active())!.bundle.bundleId, before);
	if (change === "growth") {
		assert.equal(run.status, "research-only", run.stopReason ?? "");
		assert.equal(run.outcome, "candidate-supported");
		assert.equal(run.protectedArms.length, 4);
		assert.ok(run.protectedArms.every((arm) => arm.status === "complete"));
	} else {
		assert.equal(run.status, "inconclusive", run.stopReason ?? "");
		assert.equal(protectedCalls, 1, "withdrawal blocks the following M04 and every later arm");
		assert.equal(run.protectedArms[0]?.m04RunId, undefined);
		assert.match(run.protectedArms[0]?.reason ?? "", /live limits|experience/);
	}
});


test("a source knowledge transaction cannot be copied into a runnable experiment", async (t) => {
	const f = await fixture(t, (ctx) => ctx.spec.role === "improver" ? JSON.stringify({ kind: "stop", reason: "source inspected" }) : "原始材料");
	const proposal = await f.knowledge.submitProposal({ stage: "M04", runId: "interrupted-source-merge", ops: [{ op: "create", type: "K", title: "未发布知识", body: "事务尚未提交", usageDecision: "candidate" }] });
	const writer = createFileKnowledgeStore(f.ws.knowledgeDir, { afterPhase: async (phase) => { if (phase === "prepared") throw new Error("simulated interruption before CURRENT publication"); } });
	await assert.rejects(writer.merge(proposal.proposalId), /simulated interruption/);
	const before = f.runner.created.length;
	const run = await new ResearchImprovementService({ workspaceRoot: f.root, runner: f.runner }).runWorkflow(f.plan);
	assert.equal(run.status, "inconclusive", run.stopReason ?? "");
	assert.match(run.stopReason!, /unfinished knowledge merge/);
	assert.equal(f.runner.created.length, before, "no model starts with a copied pending transaction");
	assert.equal((await f.knowledge.current())?.id, f.bundle.knowledgeSnapshot);
});
