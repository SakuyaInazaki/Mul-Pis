import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { main } from "../src/cli.ts";
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
const task = { objective: "交接固定证据", inputs: [], expectedOutputs: [], checks: ["报告包含核查结果"], mode: "reason" as const };
const caseOf = (split: "development" | "admission", id: string, marker: string) => ({ version: 1, split, cases: [{ id, goal: { ...goal, plan: `${goal.plan} ${id}` }, task: { ...task, objective: `${task.objective} ${id}` }, checks: [{ criterion: task.checks[0], contains: [marker], forbids: ["伪造证据"] }] }] });
const limits = { maxProviderCalls: 40, maxInputTokens: 2_000_000, maxOutputTokens: 100_000, maxSdkEstimatedCost: 10, maxProbeCalls: 0, maxCpuMillis: 100_000, maxWallMillis: 120_000 };

async function fixture(t: import("node:test").TestContext, responder?: (ctx: FakeReplyContext) => string, viaCli = false) {
	const parent = await mkdtemp(path.join(os.tmpdir(), "pre-rsi-workflow-"));
	t.after(() => rm(parent, { recursive: true, force: true }));
	const root = path.join(parent, "source");
	const ws = new Workspace(root);
	await import("node:fs/promises").then(({ mkdir }) => mkdir(path.dirname(ws.problemFile), { recursive: true }));
	await writeFile(ws.problemFile, "固定原问题和证据材料。\n");
	await writeFile(ws.configFile, JSON.stringify({ roles: { default: "fake/default", execution: "fake/execution", reviewer: "fake/reviewer", improver: "fake/improver", research: "fake/research" }, concurrency: 1, tools: {} }));
	const knowledge = createFileKnowledgeStore(ws.knowledgeDir); await knowledge.init();
	const initial = await ws.startRun("M04", [{ label: "原问题", path: ws.problemFile }], (await knowledge.current())?.id);
	await ws.finishRun(initial, "completed");
	const gen = new GenerationStore(root);
	const seed = { version: 1 as const, executor: { version: 1 as const, kind: "m07-workflow-prompt" as const, slot: "evidence-handoff" as const, body: "列出原始证据、限制和未执行项。" }, improver: { version: 1 as const, kind: "diagnostic-improver-prompt" as const, body: "依据开发反馈提出一个可检验的证据交接改进。" }, applicability: ["M07"] };
	if (viaCli) { await writeFile(path.join(root, "methods.json"), JSON.stringify(seed)); assert.equal(await main(["improve", "research", "bootstrap", "--workspace", root, "--methods", path.join(root, "methods.json")]), 0); }
	else await new ResearchImprovementService({ workspaceRoot: root, runner: new FakeSessionRunner(() => "unused") }).bootstrap(seed);
	const bundle = (await gen.active())!.bundle;
	assert.equal(bundle.environmentVersion, "m07-workflow/v1");
	assert.deepEqual(bundle.allowedCapabilities, ["m07-evidence-read", "no-tools-model"]);
	const runner = new FakeSessionRunner((ctx) => ({ text: responder ? responder(ctx) : ctx.spec.role === "research" ? "已按冻结包处理。" : "原材料报告，尚缺开发标记。", usage }));
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
	return { parent, root, ws, gen, runner, plan, begun, bundle };
}

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
	assert.equal(result.status, "promoted", result.stopReason);
	assert.equal(result.developmentArms.length, 2);
	assert.equal(result.protectedArms.length, 4);
	assert.ok(result.selectionReceiptPath && result.protectedOpenedAt);
	assert.ok(result.promotedMethodVersionId);
	assert.equal((await f.gen.active())?.bundle.executorVersionId, result.promotedMethodVersionId);
	assert.equal((await f.gen.active())?.bundle.improverVersionId, f.bundle.improverVersionId);
	assert.equal(await readFile(path.join(f.ws.runDir("M07", f.begun.runId), "goal.json"), "utf8"), sourceM07, "existing goal must not be hot-swapped");
});

test("no winner, including an explicit null selection, performs no protected G work", async (t) => {
	const f = await fixture(t, (ctx) => ctx.spec.role === "improver" ? JSON.stringify({ kind: "stop", reason: "开发材料不足", selectedCandidateId: null }) : ctx.spec.role === "research" ? "处理开发证据" : "原始报告");
	const before = (await f.gen.active())!.bundle.bundleId;
	const result = await new ResearchImprovementService({ workspaceRoot: f.root, runner: f.runner }).runWorkflow({ ...f.plan, maxDecisions: 1 });
	assert.equal(result.outcome, "completed-no-candidate");
	assert.equal(result.protectedArms.length, 0);
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
	assert.equal(run.status, "research-only", run.stopReason);
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
	assert.equal(result.status, "inconclusive", output.at(-1));
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
	const second = await service.runWorkflow({ ...f.plan, maxDecisions: 2, experimentRoot: path.join(f.parent, "arms-second"), metaEpisodeRunIds: [first.runId] });
	assert.equal(second.outcome, "completed-no-candidate", second.stopReason);
	assert.equal(second.protectedArms.length, 0);
});
