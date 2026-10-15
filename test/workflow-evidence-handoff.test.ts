import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { GenerationStore } from "../src/improvement/generation.ts";
import { ResearchImprovementService } from "../src/improvement/research-service.ts";
import type { WorkflowEvidenceHandoffPlanV1 } from "../src/improvement/workflow-types.ts";
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
	}, false, seedBody);
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

async function fixture(t: import("node:test").TestContext, responder?: (ctx: FakeReplyContext) => string | Promise<string>, withExperience = false, executorBody = "列出原始证据、限制和未执行项。") {
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
	await new ResearchImprovementService({ workspaceRoot: root, runner: new FakeSessionRunner(() => "unused") }).bootstrap(seed);
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

test("workflow A/A calibration executes two fresh same-method arms without I, G, or promotion", async (t) => {
	const f = await fixture(t, (ctx) => {
		if (ctx.spec.role === "improver") throw new Error("calibration must not call I");
		return ctx.spec.role === "research" ? "已读冻结报告。" : "同一方法返回的报告没有通过固定检查。";
	});
	await writeFile(path.join(f.root, "admission.json"), "invalid protected G on purpose");
	const pointerBefore = await readFile(path.join(f.gen.root, "active.json"), "utf8");
	const currentBefore = await readFile(path.join(f.ws.knowledgeDir, "CURRENT"), "utf8");
	const before = f.runner.created.length;
	const service = new ResearchImprovementService({ workspaceRoot: f.root, runner: f.runner });
	const result = await service.calibrateWorkflow({ version: 1, kind: "m07-evidence-handoff-aa/v1", caseSetPath: "development.json", experimentRoot: path.join(f.parent, "calibration"), baseline: "active-h", repetitions: 2 });
	assert.equal(result.status, "complete", result.stopReason ?? "");
	assert.equal(result.pairs.length, 2);
	assert.deepEqual(result.pairs.map((pair) => pair.executionOrder), [["A", "A2"], ["A2", "A"]]);
	assert.ok(result.pairs.every((pair) => pair.differences.length === 0));
	const arms = result.pairs.flatMap((pair) => [pair.armA, pair.armA2]);
	assert.equal(new Set(arms.map((arm) => arm.m07RunId)).size, 4);
	assert.equal(new Set(arms.map((arm) => arm.m04RunId)).size, 4);
	assert.equal(new Set(arms.map((arm) => arm.workspaceRoot)).size, 4);
	assert.ok(arms.every((arm) => arm.status === "complete" && arm.checkResults[0]?.passed === false));
	assert.ok(arms.every((arm) => arm.methodVersionId === f.bundle.executorVersionId && arm.methodBinding?.kind === "injected-h"));
	assert.ok(f.runner.created.slice(before).every((spec) => spec.role !== "improver"));
	assert.equal(await readFile(path.join(f.gen.root, "active.json"), "utf8"), pointerBefore);
	assert.equal(await readFile(path.join(f.ws.knowledgeDir, "CURRENT"), "utf8"), currentBefore);
	assert.equal(result.scientificBenefit, "unverified");
	const retained = path.join(f.gen.root, "workflow-calibrations", result.runId);
	assert.equal(JSON.parse(await readFile(path.join(retained, "plan.json"), "utf8")).caseSetPath, "development.json");
	assert.equal(JSON.parse(await readFile(path.join(retained, "development-cases.json"), "utf8")).split, "development");
	assert.equal(JSON.parse(await readFile(path.join(retained, "arm-0-dev-a-A.json"), "utf8")).m07RunId, result.pairs[0]!.armA.m07RunId);
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
	}, true);
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


test("protected evaluation preserves live knowledge withdrawal", async (t) => {
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
				const proposal = await f.knowledge.submitProposal({ stage: "M04", runId: "live-update",
					ops: [{ op: "limit", target: "K001", kind: "withdrawn", reason: "离线撤回验证", authority: "test-review" }] });
				assert.equal(proposal.structurallyValid, true);
				await f.knowledge.merge(proposal.proposalId);
			}
		}
		if (!ctx.message.includes("逐项列出冻结证据来源")) return "原始报告";
		return ctx.message.includes("holdout-b") ? "保护证据完整" : "开发证据完整";
	}, true);
	const before = (await f.gen.active())!.bundle.bundleId;
	const run = await new ResearchImprovementService({ workspaceRoot: f.root, runner: f.runner }).runWorkflow({ ...f.plan, experienceRefs: [f.experienceRef!], experienceMaxRecords: 1, experienceMaxChars: 2_000 });
	assert.equal((await f.gen.active())!.bundle.bundleId, before);
	assert.equal(run.status, "inconclusive", run.stopReason ?? "");
	assert.equal(protectedCalls, 1, "withdrawal blocks the following M04 and every later arm");
	assert.equal(run.protectedArms[0]?.m04RunId, undefined);
	assert.match(run.protectedArms[0]?.reason ?? "", /live limits|experience/);
});

async function retainedBytes(root: string): Promise<Record<string, string>> {
	const result: Record<string, string> = {};
	for (const name of (await readdir(root, { recursive: true })).sort()) {
		const file = path.join(root, name);
		if ((await stat(file)).isFile()) result[name] = (await readFile(file)).toString("base64");
	}
	return result;
}

test("independent research source freezes development history and owns I, candidates and activation", async (t) => {
	const candidateBody = "INDEPENDENT_CANDIDATE_HANDOFF";
	let researchStarted = false, targetRoot = "";
	const f = await fixture(t, (ctx) => {
		if (ctx.spec.role === "improver") {
			assert.ok(ctx.spec.persistDir.startsWith(`${targetRoot}${path.sep}`));
			assert.equal(ctx.message.includes("LATER_PRODUCTION"), false);
			assert.equal(ctx.message.includes("PROTECTED_INPUT"), false);
			const view = JSON.parse(ctx.message.slice(ctx.message.indexOf("\n") + 1));
			assert.equal(view.current.bundleId, f.bundle.bundleId);
			assert.match(view.experience.markdown, /先读取可见证据/);
			const index = Number(ctx.spec.label.split("-").at(-1));
			if (index === 0) return JSON.stringify({ kind: "inspect", object: "development-feedback", id: view.developmentSource.id, start: 0, maxChars: 4000 });
			if (index === 1) {
				assert.match(view.lastActionResult.text, /已按冻结包处理/);
				return JSON.stringify({ kind: "propose", target: "executor", body: candidateBody, hypothesis: { claim: "证据交接可核验", predictedObservation: "固定检查通过", falsifier: "固定检查失败", applicability: ["M07"], motivatingEvidenceIds: [view.developmentSource.id] } });
			}
			if (index === 2) return JSON.stringify({ kind: "evaluate-development", candidateId: view.methods.candidates[0].versionId });
			return JSON.stringify({ kind: "stop", reason: "选择已验证的候选", selectedCandidateId: view.methods.candidates[0].versionId });
		}
		if (ctx.spec.role === "research") return "已按冻结包处理。";
		if (researchStarted) assert.equal(ctx.message.includes("LATER_PRODUCTION"), false);
		return ctx.message.includes(candidateBody) ? ctx.message.includes("holdout-b") ? "保护证据完整" : "开发证据完整" : "原始报告";
	}, true);
	targetRoot = path.join(f.parent, "research-source");
	const development = caseOf("development", "dev-a", "开发证据完整");
	development.cases[0]!.task.inputs = ["development-input.txt"];
	await writeFile(path.join(f.root, "development.json"), JSON.stringify(development));
	await writeFile(path.join(f.root, "development-input.txt"), "FROZEN_DEVELOPMENT");
	const admission = caseOf("admission", "holdout-b", "保护证据完整");
	admission.cases[0]!.task.inputs = ["holdout.txt"];
	await writeFile(path.join(f.root, "admission.json"), JSON.stringify(admission));
	await writeFile(path.join(f.root, "holdout.txt"), "PROTECTED_INPUT");
	const config = await f.ws.loadConfig();
	config.tools.braveApiKey = "test-only-placeholder";
	await writeFile(f.ws.configFile, JSON.stringify(config));
	// A later formal baseline is distinct from the processed historical development source.
	const ctx: StageContext = { ws: f.ws, store: f.knowledge, runner: f.runner, config: await f.ws.loadConfig() };
	const laterCheckpoint = await createM07Controller(ctx).checkpoint(f.begun.runId, { taskIds: ["T001"] });
	const formal = (await runM04(ctx, { feedback: { kind: "M07Checkpoint", runId: f.begun.runId, checkpointId: laterCheckpoint.id }, freshSession: true })).record;
	await mkdir(path.join(f.ws.agentDir, "private"), { recursive: true });
	await writeFile(path.join(f.ws.agentDir, "private", "not-research-input.txt"), "DO_NOT_COPY");
	const beforePrepare = await retainedBytes(f.root);
	const service = new ResearchImprovementService({ workspaceRoot: f.root, runner: f.runner });
	const prepared = await service.prepareWorkflowSource({ ...f.plan, experienceRefs: [f.experienceRef!], experienceMaxRecords: 1, experienceMaxChars: 4000 }, targetRoot);
	assert.deepEqual(await retainedBytes(f.root), beforePrepare, "preparation must leave every production file unchanged");
	const frozenWs = new Workspace(targetRoot), frozenGen = new GenerationStore(targetRoot);
	assert.equal(prepared.formalM04RunId, formal.runId);
	assert.equal((await frozenWs.loadConfig()).tools.braveApiKey, undefined);
	assert.equal((await createFileKnowledgeStore(frozenWs.knowledgeDir).storeId()), await f.knowledge.storeId());
	assert.deepEqual(await readFile(path.join(frozenGen.root, "strategies", `${f.bundle.executorVersionId}.json`)), await readFile(path.join(f.gen.root, "strategies", `${f.bundle.executorVersionId}.json`)));
	assert.equal(await stat(path.join(frozenWs.agentDir, "private")).catch(() => undefined), undefined);
	assert.equal(await stat(frozenWs.sessionsDir).catch(() => undefined), undefined);
	assert.equal(await stat(path.join(frozenWs.runDir("M07", f.begun.runId), "goal.json")).catch(() => undefined), undefined);
	const originalM04 = await f.ws.readRun("M04", f.plan.developmentSource.m04RunId);
	const copiedM04 = await frozenWs.readRun("M04", f.plan.developmentSource.m04RunId);
	assert.deepEqual(copiedM04.sessions, []);
	const sourceProcessing = originalM04.outputs.find(item => item.label === "处理结果")!.path;
	const frozenProcessing = copiedM04.outputs.find(item => item.label === "处理结果")!.path;
	assert.deepEqual(await readFile(sourceProcessing), await readFile(frozenProcessing));
	const sourceBinding = JSON.parse(await readFile(copiedM04.outputs.find(item => item.label === "M07 处理来源")!.path, "utf8"));
	assert.ok(sourceBinding.rootDir.startsWith(`${targetRoot}${path.sep}`));
	assert.ok(await stat(sourceBinding.goalSnapshotPath));
	const formalM04 = await frozenWs.readRun("M04", formal.runId);
	const formalBinding = JSON.parse(await readFile(formalM04.outputs.find(item => item.label === "M07 处理来源")!.path, "utf8"));
	assert.notEqual(formalBinding.rootDir, sourceBinding.rootDir);
	assert.ok(formalBinding.rootDir.startsWith(`${targetRoot}${path.sep}`));
	for (const file of [formalBinding.goalSnapshotPath, formalBinding.manifestPath, formalBinding.feedbackBundlePath]) assert.ok(await stat(file));
	await assert.rejects(service.prepareWorkflowSource(f.plan, targetRoot), /EEXIST/);

	// Production changes after preparation cannot enter the frozen research sessions.
	await writeFile(f.ws.configFile, JSON.stringify({ ...config, roles: { default: "fake/LATER_PRODUCTION" } }));
	await writeFile(path.join(f.root, "development-input.txt"), "LATER_PRODUCTION");
	await writeFile(path.join(f.root, "admission.json"), "invalid later production case set");
	const proposal = await f.knowledge.submitProposal({ stage: "M04", runId: "later-production", ops: [{ op: "create", type: "K", title: "LATER_PRODUCTION", body: "LATER_PRODUCTION", usageDecision: "adopted" }] });
	await f.knowledge.merge(proposal.proposalId);
	const beforeResearch = await retainedBytes(f.root);
	const oldPointer = await readFile(path.join(f.gen.root, "active.json"), "utf8");
	researchStarted = true;
	const createdBefore = f.runner.created.length;
	const run = await new ResearchImprovementService({ workspaceRoot: targetRoot, runner: f.runner }).runWorkflow(prepared.plan);
	assert.equal(run.status, "promoted", run.stopReason ?? "");
	assert.equal(run.knowledgeSnapshot, f.bundle.knowledgeSnapshot);
	assert.notEqual((await f.knowledge.current())?.id, run.knowledgeSnapshot);
	assert.equal(await readFile(path.join(f.gen.root, "active.json"), "utf8"), oldPointer);
	assert.deepEqual(await retainedBytes(f.root), beforeResearch, "research must never write through to production");
	assert.notEqual((await frozenGen.active())!.bundle.bundleId, f.bundle.bundleId);
	assert.ok(f.runner.created.slice(createdBefore).every(spec => !spec.persistDir.startsWith(`${f.root}${path.sep}`) && spec.model !== "fake/LATER_PRODUCTION"));
	assert.ok(await frozenGen.readStrategy(run.selectedCandidateId!));
	assert.equal(await stat(path.join(f.gen.root, "strategies", `${run.selectedCandidateId}.json`)).catch(() => undefined), undefined);
	assert.equal(await stat(path.join(run.sourceWorkspace!, "holdout.txt")).catch(() => undefined), undefined);
});
