/** One explicit M07 evidence-handoff experiment. No CPU case or evaluator is used here. */
import { randomBytes } from "node:crypto";
import { cp, lstat, mkdir, readFile, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { SharedBudget } from "../experiments/budget.ts";
import type { BudgetLease } from "../experiments/contracts.ts";
import { createFileKnowledgeStore } from "../knowledge/store.ts";
import { createExperienceProvider, verifyRequiredKnowledge } from "../knowledge/experience-index.ts";
import { createM07Controller, latestFormalBaseline } from "../m07/controller.ts";
import type { SessionHandle, SessionRunner, SessionSpec, UsageSummary } from "../runner/types.ts";
import { runM04 } from "../stages/m04.ts";
import type { StageContext } from "../stages/context.ts";
import { HarnessError } from "../types.ts";
import { nowIso, Workspace, writeFileAtomic } from "../workspace.ts";
import { GenerationStore, isM07WorkflowStrategy, type M07WorkflowStrategyV1, type StrategyRecordV1, validateStrategy } from "./generation.ts";
import { buildWorkflowMetaEpisode, loadWorkflowMetaEpisode, metaEpisodeForModel } from "./meta-episode.ts";
import { validateResearchHypothesis, type ResearchHypothesisV1 } from "./policy-host.ts";
import { runBoundedModelStep } from "./research-model.ts";
import { validateWorkflowCaseSet, type WorkflowArmReceiptV1, type WorkflowCaseSetV1, type WorkflowEvidenceHandoffPlanV1, type WorkflowRunV1 } from "./workflow-types.ts";

type Action = { kind: "inspect"; object: "method" | "development-feedback" | "meta-episode"; id: string; start: number; maxChars: number } |
	{ kind: "propose"; target: "executor"; body: string; hypothesis: ResearchHypothesisV1 } |
	{ kind: "evaluate-development"; candidateId: string } |
	{ kind: "stop"; reason: string; selectedCandidateId?: string };
type Source = { id: string; text: string; m07RunId: string; m04RunId: string };
/** One workflow-only contract. The CPU improver contract uses a different inspect shape. */
const WORKFLOW_ACTION_CONTRACT = [
	'{"kind":"inspect","object":"method|development-feedback|meta-episode","id":"registered-id","start":0,"maxChars":1000}',
	'{"kind":"propose","target":"executor","body":"evidence-handoff H body","hypothesis":{"claim":"...","predictedObservation":"...","falsifier":"...","applicability":["M07"],"motivatingEvidenceIds":["visible-development-id"]}}',
	'{"kind":"evaluate-development","candidateId":"registered-candidate-id"}',
	'{"kind":"stop","reason":"...","selectedCandidateId":"optional-registered-candidate-id"}',
].join("; ");
export function workflowImproverSystemPrompt(body: string): string {
	return `You are the versioned M07 evidence-handoff improver. Return exactly one JSON object using one of these four workflow-only action forms: ${WORKFLOW_ACTION_CONTRACT}. Inspect fields are top-level; no nested read object or probe action exists here. Candidate text may change only the evidence-handoff H body and cannot change goals, checks, tools, protected G, or budget. Cite only visible frozen development evidence or registered development MetaEpisode IDs. A hypothesis is a testable claim, not an established fact.\n\nLoaded improver strategy (versioned data-only method):\n${body}`;
}
export function workflowDecisionPrompt(view: unknown): string {
	return `Choose one action under the workflow-only system contract. On the final decision, stop with a supported candidate or stop without one. The controller does not choose a candidate for you.\n${JSON.stringify(view)}`;
}
const id = () => `${new Date().toISOString().replace(/[-:.]/g, "")}-${randomBytes(3).toString("hex")}`;
const relativeSafe = (file: string) => !!file && !path.isAbsolute(file) && file.split(/[\\/]/).every((part) => part !== "" && part !== "." && part !== "..");
const nested = (a: string, b: string) => a === b || b.startsWith(`${a}${path.sep}`);
const uniqueRefs = <T extends { storeId: string; recordId: string; version: number }>(refs: T[]): T[] => [...new Map(refs.map((ref) => [`${ref.storeId}/${ref.recordId}@${ref.version}`, ref])).values()];
const uniqueRequirements = (refs: StrategyRecordV1["requiredExperienceRefs"]): StrategyRecordV1["requiredExperienceRefs"] => [...new Map(refs.map((item) => [`${item.targetKind}:${item.ref.storeId}/${item.ref.recordId}@${item.ref.version}`, item])).values()];

export function validateWorkflowAction(input: unknown, visible: { sourceId: string; metaIds: string[]; methodIds: string[]; candidateIds: string[]; readbackRemaining: number }): Action {
	if (!input || typeof input !== "object" || Array.isArray(input)) throw new HarnessError("improvement.workflow-action", "I must return one JSON action");
	const v = input as Record<string, unknown>;
	if (v.kind === "inspect" && Object.keys(v).sort().join(",") === "id,kind,maxChars,object,start" && ["method", "development-feedback", "meta-episode"].includes(String(v.object)) && typeof v.id === "string" && (v.object === "method" ? visible.methodIds.includes(v.id) : v.object === "meta-episode" ? visible.metaIds.includes(v.id) : v.id === visible.sourceId) && Number.isSafeInteger(v.start) && (v.start as number) >= 0 && Number.isSafeInteger(v.maxChars) && (v.maxChars as number) > 0 && (v.maxChars as number) <= 4_000 && visible.readbackRemaining > 0)
		return v as unknown as Action;
	if (v.kind === "propose" && Object.keys(v).sort().join(",") === "body,hypothesis,kind,target" && v.target === "executor" && typeof v.body === "string" && v.body.trim() && v.body.length <= 4_000) {
		const hypothesis = validateResearchHypothesis(v.hypothesis);
		if (hypothesis.motivatingEvidenceIds.some((ref) => ref !== visible.sourceId && !visible.metaIds.includes(ref))) throw new HarnessError("improvement.workflow-action", "candidate cites unavailable development evidence");
		return { kind: "propose", target: "executor", body: v.body.trim(), hypothesis };
	}
	if (v.kind === "evaluate-development" && Object.keys(v).sort().join(",") === "candidateId,kind" && typeof v.candidateId === "string" && visible.candidateIds.includes(v.candidateId)) return v as Action;
	if (v.kind === "stop" && Object.keys(v).every((key) => ["kind", "reason", "selectedCandidateId"].includes(key)) && typeof v.reason === "string" && v.reason.trim() && v.reason.length <= 500 && (v.selectedCandidateId === undefined || v.selectedCandidateId === null || typeof v.selectedCandidateId === "string" && visible.candidateIds.includes(v.selectedCandidateId))) return { kind: "stop", reason: v.reason.trim(), ...(typeof v.selectedCandidateId === "string" ? { selectedCandidateId: v.selectedCandidateId } : {}) };
	throw new HarnessError("improvement.workflow-action", "workflow I action is outside the fixed inspect/propose/evaluate/stop contract");
}

async function boundedJson(file: string, maxBytes: number): Promise<unknown> {
	if ((await stat(file)).size > maxBytes) throw new HarnessError("improvement.workflow-input", "frozen input exceeds the controller read limit");
	return JSON.parse(await readFile(file, "utf8"));
}
async function loadCases(file: string, split: WorkflowCaseSetV1["split"]): Promise<WorkflowCaseSetV1> {
	return validateWorkflowCaseSet(await boundedJson(file, 128_000), split);
}

async function loadSource(ws: Workspace, plan: WorkflowEvidenceHandoffPlanV1): Promise<Source> {
	const { m07RunId, checkpointId, m04RunId } = plan.developmentSource;
	const m04 = await ws.readRun("M04", m04RunId);
	if (m04.status !== "completed" || m04.failures.length) throw new HarnessError("improvement.workflow-source", "development M04 did not complete cleanly");
	const sourceRef = m04.outputs.find((x) => x.label === "M07 处理来源");
	const processed = m04.outputs.find((x) => x.label === "处理结果");
	if (!sourceRef || !processed) throw new HarnessError("improvement.workflow-source", "M04 lacks registered M07 source or processing output");
	for (const file of [sourceRef.path, processed.path]) if (!nested(await realpath(ws.runDir("M04", m04RunId)), await realpath(file))) throw new HarnessError("improvement.workflow-source", "M04 source output escapes its run directory");
	const binding = await boundedJson(sourceRef.path, 16_000) as Record<string, unknown>;
	if (binding.m07RunId !== m07RunId || binding.checkpointId !== checkpointId || binding.rootDir !== path.join(ws.runDir("M07", m07RunId), "checkpoints", checkpointId)) throw new HarnessError("improvement.workflow-source", "M04 is not bound to the caller's frozen M07 checkpoint");
	if (await realpath(binding.rootDir as string) !== await realpath(path.join(ws.runDir("M07", m07RunId), "checkpoints", checkpointId))) throw new HarnessError("improvement.workflow-source", "checkpoint root is not the exact frozen directory");
	const checkpoint = await boundedJson(path.join(binding.rootDir as string, "manifest.json"), 128_000) as Record<string, unknown>;
	const goal = await boundedJson(path.join(binding.rootDir as string, "goal.json"), 256_000) as Record<string, unknown>;
	if (checkpoint.m07RunId !== m07RunId || checkpoint.checkpointId !== checkpointId || goal.runId !== m07RunId || !Array.isArray(goal.tasks)) throw new HarnessError("improvement.workflow-source", "frozen development checkpoint identities differ");
	const processing = await readFile(processed.path, "utf8");
	if (Buffer.byteLength(processing, "utf8") > 32_000) throw new HarnessError("improvement.workflow-source", "M04 processing output exceeds bounded development handoff");
	const tasks = (goal.tasks as Array<Record<string, unknown>>).map((task) => ({ taskId: task.taskId, objective: task.objective, status: task.status, checks: (task.review as Record<string, unknown> | undefined)?.checks, failures: (task.review as Record<string, unknown> | undefined)?.failures, unexecuted: (task.review as Record<string, unknown> | undefined)?.unexecuted }));
	const text = JSON.stringify({ m07RunId, checkpointId, m04RunId, tasks, processing: processing.slice(0, 8_000) });
	if (text.length > 16_000) throw new HarnessError("improvement.workflow-source", "development handoff exceeds fixed I context limit");
	return { id: `development:${m07RunId}:${checkpointId}`, text, m07RunId, m04RunId };
}

async function assertPlainTree(root: string): Promise<void> {
	const walk = async (dir: string, depth: number): Promise<void> => {
		if (depth > 12) throw new HarnessError("improvement.workflow-copy", "template tree is too deep");
		for (const entry of await readdir(dir, { withFileTypes: true })) {
			const file = path.join(dir, entry.name);
			const info = await lstat(file);
			if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())) throw new HarnessError("improvement.workflow-copy", "template contains a link or non-file entry");
			if (info.isDirectory()) await walk(file, depth + 1);
			else if (info.size > 8 * 1024 * 1024) throw new HarnessError("improvement.workflow-copy", "template file exceeds 8 MiB");
		}
	};
	await walk(root, 0);
}
async function seedArm(source: Workspace, targetRoot: string, bundle: NonNullable<Awaited<ReturnType<GenerationStore["active"]>>>["bundle"], h: StrategyRecordV1, i: StrategyRecordV1, caseInput: WorkflowCaseSetV1["cases"][number], baselineRunId?: string): Promise<StageContext> {
	const target = new Workspace(targetRoot);
	await mkdir(target.root);
	const copy = async (from: string, to: string): Promise<void> => { await assertPlainTree(from); await cp(from, to, { recursive: true, errorOnExist: true, force: false, dereference: false }); };
	for (const file of [source.problemFile, source.configFile]) {
		const info = await lstat(file);
		if (!info.isFile() || info.isSymbolicLink() || !nested(await realpath(source.root), await realpath(file))) throw new HarnessError("improvement.workflow-copy", "problem/config source must be a confined regular file");
	}
	await mkdir(path.dirname(target.problemFile), { recursive: true });
	await cp(source.problemFile, target.problemFile, { errorOnExist: true, force: false });
	await cp(source.configFile, target.configFile, { errorOnExist: true, force: false });
	try { await copy(source.rawDir, target.rawDir); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
	for (const item of caseInput.task.inputs) {
		if (!relativeSafe(item)) throw new HarnessError("improvement.workflow-copy", "task input is not an exact relative file");
		const from = path.join(source.root, item), to = path.join(target.root, item);
		const info = await lstat(from);
		if (!info.isFile() || info.isSymbolicLink() || info.size > 8 * 1024 * 1024 || !nested(await realpath(source.root), await realpath(from))) throw new HarnessError("improvement.workflow-copy", "task input is not a bounded source file");
		if (item === "problem/problem.md" || item.startsWith("problem/raw/")) continue;
		await mkdir(path.dirname(to), { recursive: true }); await cp(from, to, { errorOnExist: true, force: false });
	}
	const knowledgeInfo = await lstat(source.knowledgeDir);
	if (!knowledgeInfo.isDirectory()) throw new HarnessError("improvement.workflow-copy", "source knowledge store is unavailable");
	await mkdir(target.agentDir, { recursive: true });
	await copy(source.knowledgeDir, target.knowledgeDir);
	const baseline = baselineRunId ? await source.readRun("M04", baselineRunId) : await source.latestCompletedRun("M04");
	if (!baseline || baseline.status !== "completed" || baseline.failures.length) throw new HarnessError("improvement.workflow-copy", "source requires the exact clean formal M04 baseline");
	const baselineDir = source.runDir("M04", baseline.runId);
	await copy(baselineDir, target.runDir("M04", baseline.runId));
	const remap = (v: unknown): unknown => typeof v === "string" && nested(source.root, v) ? path.join(target.root, path.relative(source.root, v)) : Array.isArray(v) ? v.map(remap) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, value]) => [k, remap(value)])) : v;
	const runFile = path.join(target.runDir("M04", baseline.runId), "run.json");
	await writeFileAtomic(runFile, `${JSON.stringify(remap(await boundedJson(runFile, 256_000)), null, 2)}\n`);
	const gen = new GenerationStore(target.root);
	for (const record of [h, i]) await gen.writeStrategy({ versionId: record.versionId, kind: record.kind, artifact: record.artifact, parentVersionId: record.parentVersionId, origin: record.origin, applicability: record.applicability, limitations: record.limitations, sourceExperienceRefs: record.sourceExperienceRefs, requiredExperienceRefs: record.requiredExperienceRefs, requiredKnowledgeRefs: record.requiredKnowledgeRefs, state: "manual-active" });
	const armBundle = await gen.writeBundle({ bundleId: bundle.bundleId, parents: [], executorVersionId: h.versionId, improverVersionId: i.versionId, knowledgeSnapshot: bundle.knowledgeSnapshot, environmentVersion: "m07-workflow/v1", modelConfig: bundle.modelConfig, protocolVersion: bundle.protocolVersion, allowedCapabilities: bundle.allowedCapabilities, state: "manual-active" });
	await gen.activate(armBundle.bundleId, undefined, "external-manual-unverified", `isolated-arm-${id()}`);
	const store = createFileKnowledgeStore(target.knowledgeDir); await store.init();
	return { ws: target, store, runner: undefined as unknown as SessionRunner, config: await target.loadConfig() };
}

/** Freeze only explicitly named case inputs. An admission input is copied after selection. */
async function freezeCaseInputs(source: Workspace, target: Workspace, cases: WorkflowCaseSetV1["cases"]): Promise<void> {
	for (const item of new Set(cases.flatMap((c) => c.task.inputs))) {
		if (!relativeSafe(item)) throw new HarnessError("improvement.workflow-copy", "case input is not a confined relative file");
		const from = path.join(source.root, item), to = path.join(target.root, item);
		const info = await lstat(from);
		if (!info.isFile() || info.isSymbolicLink() || info.size > 8 * 1024 * 1024 || !nested(await realpath(source.root), await realpath(from))) throw new HarnessError("improvement.workflow-copy", "case input is not a bounded source file");
		if (await stat(to).catch(() => undefined)) continue;
		await mkdir(path.dirname(to), { recursive: true }); await cp(from, to, { errorOnExist: true, force: false });
	}
}

/** G's controller-only case file cannot be copied into a model-visible workspace. */
async function protectAdmissionInputs(source: Workspace, plan: WorkflowEvidenceHandoffPlanV1, development: WorkflowCaseSetV1, admission?: WorkflowCaseSetV1): Promise<void> {
	if (!plan.admissionCaseSetPath) return;
	const caseFile = await realpath(path.resolve(source.root, plan.admissionCaseSetPath!));
	const copiedRoots = [source.problemFile, source.configFile, source.rawDir, source.knowledgeDir, source.runDir("M04", plan.developmentSource.m04RunId)];
	const allInputs = [...development.cases, ...(admission?.cases ?? [])].flatMap((item) => item.task.inputs.map((file) => path.resolve(source.root, file)));
	for (const item of [...copiedRoots, ...allInputs]) {
		const resolved = await realpath(item).catch(() => undefined);
		if (resolved && nested(resolved, caseFile)) throw new HarnessError("improvement.workflow-g", "protected case file overlaps material copied into a model-visible arm");
	}
}

export function createWorkflowMeteredRunner(base: SessionRunner, budget: SharedBudget, lease: BudgetLease, events: UsageSummary[]): SessionRunner {
	const wrap = (handle: SessionHandle, spec: SessionSpec): SessionHandle => ({ ...handle, prompt: async (message) => {
		const reservation = budget.reserveObservedTurn(lease);
		let settled = false;
		try {
			const turn = await handle.prompt(message);
			const usage = turn.usage ?? handle.usageSummary();
			budget.settleObservedTurn(reservation, usage); settled = true; events.push(usage);
			if (!usage.complete || !usage.costComplete || usage.reportedEvents < 1 || budget.status(lease).settlement !== "settled") throw new HarnessError("improvement.workflow-usage", "M07/M04 provider use is incomplete or over the reserved serial turn envelope");
			return turn;
		} catch (error) { if (!settled) budget.markObservedTurnUnknown(reservation); throw error; }
	}, setRunContext: handle.setRunContext?.bind(handle), transcript: handle.transcript.bind(handle), readCoverage: handle.readCoverage.bind(handle), readReturnEvents: handle.readReturnEvents.bind(handle), usageEvents: handle.usageEvents.bind(handle), usageSummary: handle.usageSummary.bind(handle), abort: handle.abort.bind(handle), toolLog: handle.toolLog.bind(handle), dispose: handle.dispose.bind(handle) });
	return { create: async (spec) => wrap(await base.create(spec), spec), resume: async (ref) => { const handle = await base.resume(ref); const spec = JSON.parse(await readFile(ref.specFile!, "utf8")) as SessionSpec; return wrap(handle, spec); }, estimateMaxSdkCost: base.estimateMaxSdkCost?.bind(base) };
}

async function executeArm(args: { source: Workspace; root: string; bundle: NonNullable<Awaited<ReturnType<GenerationStore["active"]>>>["bundle"]; h: StrategyRecordV1; i: StrategyRecordV1; caseInput: WorkflowCaseSetV1["cases"][number]; arm: WorkflowArmReceiptV1["arm"]; runner: SessionRunner; budget: SharedBudget; lease: BudgetLease }): Promise<WorkflowArmReceiptV1> {
	const receipt: WorkflowArmReceiptV1 = { caseId: args.caseInput.id, arm: args.arm, methodVersionId: args.h.versionId, workspaceRoot: args.root, checkResults: [], usage: { providerCalls: 0, inputTokens: 0, outputTokens: 0, sdkEstimatedCost: 0, complete: false }, status: "inconclusive" };
	const events: UsageSummary[] = [];
	try {
		const ctx = await seedArm(args.source, args.root, args.bundle, args.h, args.i, args.caseInput);
		ctx.runner = createWorkflowMeteredRunner(args.runner, args.budget, args.lease, events);
		const controller = createM07Controller(ctx);
		const goal = await controller.begin({ ...args.caseInput.goal, workflowMethodVersionId: args.h.versionId });
		receipt.m07RunId = goal.runId;
		const task = await controller.delegate(goal.runId, args.caseInput.task);
		if (task.status !== "returned" || !task.reportPath) throw new HarnessError("improvement.workflow-arm", "M07 task did not return an evidence report");
		const report = await readFile(task.reportPath, "utf8");
		if (report.length > 100_000) throw new HarnessError("improvement.workflow-arm", "M07 report exceeds fixed check limit");
		receipt.checkResults = args.caseInput.checks.map((check) => ({ criterion: check.criterion, passed: check.contains.every((text) => report.includes(text)) && check.forbids.every((text) => !report.includes(text)) }));
		await controller.review(goal.runId, { taskId: task.taskId, artifacts: [task.reportPath], checks: receipt.checkResults.map((check) => ({ criterion: check.criterion, result: check.passed ? "passed" : "failed", evidence: [task.reportPath!] })) });
		const checkpoint = await controller.checkpoint(goal.runId, { taskIds: [task.taskId] });
		const m04 = await runM04(ctx, { feedback: { kind: "M07Checkpoint", runId: goal.runId, checkpointId: checkpoint.id }, freshSession: true, purpose: "隔离工作流方法开发：仅处理本臂冻结的 M07 证据" });
		receipt.m04RunId = m04.record.runId;
		const sourceRecord = m04.record.outputs.find((x) => x.label === "M07 处理来源");
		const messageRecord = m04.record.outputs.find((x) => x.label === "发送给研究会话的完整消息");
		const coverageRecord = m04.record.outputs.find((x) => x.label === "M07 回流证据实际访问范围");
		if (!sourceRecord || !messageRecord || !coverageRecord) throw new HarnessError("improvement.workflow-arm", "M04 lacks the registered source, message or access record");
		const binding = await boundedJson(sourceRecord.path, 16_000) as Record<string, unknown>;
		if (binding.m07RunId !== goal.runId || binding.checkpointId !== checkpoint.id || binding.rootDir !== checkpoint.rootDir) throw new HarnessError("improvement.workflow-arm", "M04 source does not resolve the exact M07 checkpoint");
		const frozenGoal = await boundedJson(checkpoint.goalSnapshotPath, 256_000) as { workflowMethod?: { versionId?: string }; tasks?: Array<{ taskId?: string; reportPath?: string }> };
		if (frozenGoal.workflowMethod?.versionId !== args.h.versionId) throw new HarnessError("improvement.workflow-arm", "M04 did not receive the intended frozen H version");
		const frozenReportPath = frozenGoal.tasks?.find((x) => x.taskId === task.taskId)?.reportPath;
		if (!frozenReportPath || !nested(await realpath(checkpoint.rootDir), await realpath(frozenReportPath))) throw new HarnessError("improvement.workflow-arm", "frozen report path is outside the checkpoint");
		if ((await readFile(frozenReportPath, "utf8")) !== report) throw new HarnessError("improvement.workflow-arm", "frozen report differs from the task return");
		receipt.frozenReportPath = frozenReportPath;
		const m04Message = await readFile(messageRecord.path, "utf8");
		const coverage = await boundedJson(coverageRecord.path, 128_000) as { promptOutcome?: string; returnedRanges?: Array<{ path?: string; status?: string; returned?: { startLine?: number; endLine?: number; truncated?: boolean; kind?: string } }> };
		const relativeReport = path.relative(checkpoint.rootDir, frozenReportPath);
		const totalLines = report.split(/\r?\n/).length;
		const spans = (coverage.returnedRanges ?? []).filter((x) => x.path === relativeReport && x.status === "returned" && x.returned?.kind === "text" && !x.returned.truncated).map((x) => ({ start: x.returned!.startLine ?? 0, end: x.returned!.endLine ?? 0 })).sort((a, b) => a.start - b.start);
		let covered = 0; for (const span of spans) if (span.start <= covered + 1) covered = Math.max(covered, span.end);
		receipt.reportDeliveredToM04 = coverage.promptOutcome === "returned" && (m04Message.includes(report) || covered >= totalLines);
		if (!receipt.reportDeliveredToM04) throw new HarnessError("improvement.workflow-arm", "M04 did not receive the complete frozen report through inline text or recorded read ranges");
		const savedGoal = await controller.status(goal.runId);
		receipt.feedbackStatus = savedGoal.checkpoints?.find((x) => x.id === checkpoint.id)?.feedbackStatus;
		if (m04.record.status !== "completed" || m04.record.failures.length || !["complete"].includes(String(receipt.feedbackStatus))) throw new HarnessError("improvement.workflow-arm", "M04 or full evidence handoff is incomplete");
		if (args.budget.status(args.lease).settlement !== "settled") throw new HarnessError("improvement.workflow-usage", "arm resource use is not settled");
		receipt.status = "complete";
	} catch (error) { receipt.reason = (error as Error).message; }
	receipt.usage = { providerCalls: events.reduce((n, x) => n + x.reportedEvents, 0), inputTokens: events.reduce((n, x) => n + x.input + x.cacheRead + x.cacheWrite, 0), outputTokens: events.reduce((n, x) => n + x.output, 0), sdkEstimatedCost: events.reduce((n, x) => n + x.cost, 0), complete: events.length >= 2 && events.every((x) => x.complete && x.costComplete && x.reportedEvents >= 1) && args.budget.status(args.lease).settlement === "settled" };
	if (!receipt.usage.complete) { receipt.status = "inconclusive"; receipt.reason ??= "complete M07/M04 usage is unavailable"; }
	return receipt;
}

export async function runWorkflowEvidenceHandoff(args: { ws: Workspace; store: GenerationStore; runner: SessionRunner; plan: WorkflowEvidenceHandoffPlanV1 }): Promise<WorkflowRunV1> {
	const { ws, store, runner, plan } = args;
	const active = await store.active();
	if (!active) throw new HarnessError("improvement.workflow", "explicit workflow H/I bundle is required");
	const h = await store.readStrategy(active.bundle.executorVersionId), i = await store.readStrategy(active.bundle.improverVersionId);
	if (active.bundle.environmentVersion !== "m07-workflow/v1" || !active.bundle.allowedCapabilities.includes("m07-evidence-read") || active.bundle.allowedCapabilities.includes("cpu-probe") || !isM07WorkflowStrategy(h.artifact) || h.artifact.slot !== "evidence-handoff" || i.artifact.kind !== "diagnostic-improver-prompt") throw new HarnessError("improvement.workflow", "active bundle must contain evidence-handoff H and diagnostic I");
	const verifyLive = async (records: StrategyRecordV1[]) => {
		const refs = uniqueRefs(records.flatMap((record) => [...record.requiredKnowledgeRefs, ...record.requiredExperienceRefs.map((item) => item.ref)]));
		await verifyRequiredKnowledge(ws.root, refs, active.bundle.knowledgeSnapshot);
		const knowledge = createFileKnowledgeStore(ws.knowledgeDir); await knowledge.init();
		const provider = createExperienceProvider(knowledge);
		const iRefs = uniqueRefs(records.flatMap((record) => record.requiredExperienceRefs.filter((item) => item.targetKind === "improver").map((item) => item.ref)));
		if (iRefs.length) {
			const selected = await provider.select({ targetKind: "improver", applicability: { stage: "method-research", tags: ["m07-evidence-handoff"] }, requestedRefs: iRefs, expectedSnapshotId: active.bundle.knowledgeSnapshot, maxRecords: 100, maxChars: 100_000 });
			if (selected.status !== "ready" || selected.selected.length !== iRefs.length) throw new HarnessError("improvement.workflow", "necessary improver experience is unavailable");
		}
	};
	await verifyLive([h, i]);
	const root = path.resolve(ws.root, plan.experimentRoot), sourceRoot = await realpath(ws.root);
	let existing = root;
	while (!(await stat(existing).catch(() => undefined))) existing = path.dirname(existing);
	for (let ancestor = path.dirname(root); ancestor !== path.dirname(ancestor); ancestor = path.dirname(ancestor)) {
		if (await stat(path.join(ancestor, ".workflow-experiment-root.json")).catch(() => undefined)) throw new HarnessError("improvement.workflow-root", "experiment root overlaps an earlier workflow study");
	}
	const physicalRoot = path.join(await realpath(existing), path.relative(existing, root));
	if (nested(physicalRoot, sourceRoot) || nested(sourceRoot, physicalRoot)) throw new HarnessError("improvement.workflow-root", "experiment root must be disjoint from the live workspace");
	const runId = id(), dir = path.join(store.root, "workflow-runs", runId), budget = new SharedBudget(runId, plan.budget);
	const run: WorkflowRunV1 = { version: 1, kind: "m07-evidence-handoff/v1", evidenceScope: "local-handoff-mechanism", scientificBenefit: "unverified", runId, startedAt: nowIso(), status: "running", baselineBundleId: active.bundle.bundleId, baselineExecutorVersionId: h.versionId, improverVersionId: i.versionId, knowledgeSnapshot: active.bundle.knowledgeSnapshot, developmentSource: plan.developmentSource, decisions: [], candidates: [], developmentArms: [], protectedArms: [] };
	await mkdir(dir, { recursive: true });
	const save = async () => { run.budgetAtEnd = budget.status(); await writeFileAtomic(path.join(dir, "run.json"), `${JSON.stringify(run, null, 2)}\n`); };
	await save();
	try {
		const source = await loadSource(ws, plan);
		const currentKnowledge = createFileKnowledgeStore(ws.knowledgeDir); await currentKnowledge.init();
		const formal = await latestFormalBaseline({ ws, store: currentKnowledge, runner, config: await ws.loadConfig() });
		const currentSnapshot = (await currentKnowledge.current())?.id;
		if (!formal || formal.knowledgeSnapshot !== active.bundle.knowledgeSnapshot || currentSnapshot !== active.bundle.knowledgeSnapshot) throw new HarnessError("improvement.workflow-baseline", "frozen H/K and the current formal M04 baseline must share one knowledge epoch before I starts");
		const development = await loadCases(path.resolve(ws.root, plan.developmentCaseSetPath), "development");
		await protectAdmissionInputs(ws, plan, development);
		const priorEpisodes = await Promise.all((plan.metaEpisodeRunIds ?? []).map((priorId) => loadWorkflowMetaEpisode(store.root, ws.root, priorId, store)));
		await mkdir(root); // exclusive: caller receives an error before any arm can overwrite a previous study
		await writeFileAtomic(path.join(root, ".workflow-experiment-root.json"), `${JSON.stringify({ version: 1, runId, sourceWorkspace: ws.root })}\n`);
		const template = (await seedArm(ws, path.join(root, "template"), active.bundle, h, i, development.cases[0]!, formal.run.runId)).ws;
		await freezeCaseInputs(ws, template, development.cases);
		const freezeDevelopment = async (terminal: "selected" | "no-winner" | "inconclusive") => {
			run.developmentBudgetAtSelection = budget.status();
			run.metaEpisodeIds = [`meta:${runId}`];
			await save();
			const episode = buildWorkflowMetaEpisode(run, active.bundle, ws.root, terminal);
			const content = `${JSON.stringify(episode, null, 2)}\n`;
			if (Buffer.byteLength(content, "utf8") > 120_000) throw new HarnessError("improvement.meta-episode", "workflow development episode exceeds fixed size");
			await writeFileAtomic(path.join(dir, "meta-episode.development.json"), content);
		};
		const candidates = new Map<string, StrategyRecordV1>();
		let lastActionResult: unknown;
		let inspectCount = 0, readbackChars = 0;
		for (let index = 0; index < plan.maxDecisions; index++) {
			await verifyLive([h, i]);
			const view = { version: 1, environment: "m07-evidence-handoff/v1", target: "executor", current: { bundleId: active.bundle.bundleId, executorVersionId: h.versionId, improverVersionId: i.versionId, slot: "evidence-handoff" },
				methods: { executor: { versionId: h.versionId, body: h.artifact.body }, improver: { versionId: i.versionId, body: i.artifact.body }, candidates: [...candidates.values()].map((c) => ({ versionId: c.versionId, developmentStatus: run.candidates.find((item) => item.versionId === c.versionId)?.developmentStatus })) },
				developmentSource: { id: source.id, m07RunId: source.m07RunId, m04RunId: source.m04RunId, excerpt: source.text.slice(0, 4_000), totalChars: source.text.length },
				metaEpisodes: priorEpisodes.map((episode) => ({ id: episode.id, runId: episode.runId, terminal: episode.terminal, decisionKinds: episode.decisions.map((d) => d.kind ?? "none"), candidateOutcomes: episode.candidates.map((c) => ({ id: c.id, claim: c.hypothesis.claim, developmentStatus: c.developmentStatus })), feedbackIds: episode.feedbackIndex.map((f) => f.id), sdkEstimatedCost: episode.usage.sdkEstimatedCost })),
				feedback: run.developmentArms.slice(-plan.maxFeedbackItems).map((arm) => ({ caseId: arm.caseId, arm: arm.arm, methodVersionId: arm.methodVersionId, status: arm.status, checkResults: arm.checkResults, reason: arm.reason })),
				budget: budget.status(), remainingActions: { decisions: plan.maxDecisions - index, candidates: plan.maxCandidates - candidates.size, inspections: plan.maxInspectActions - inspectCount, readbackChars: plan.maxReadbackChars - readbackChars, finalDecision: index === plan.maxDecisions - 1 }, lastActionResult };
			const decision = { index: index + 1, improverVersionId: i.versionId, outcome: "proposing" } as WorkflowRunV1["decisions"][number]; run.decisions.push(decision); await save();
			const step = await runBoundedModelStep({ runner, budget, lease: budget.root, spec: { label: `I-workflow-${runId}-${index}`, role: "improver", model: active.bundle.modelConfig.improver, systemPrompt: workflowImproverSystemPrompt(i.artifact.body), persistDir: ws.sessionsDir, methodBinding: { versionId: i.versionId } },
				message: workflowDecisionPrompt(view), timeoutMs: plan.perPromptTimeoutMs });
			decision.sessionId = step.sessionId;
			const action = validateWorkflowAction(JSON.parse(step.text), { sourceId: source.id, metaIds: priorEpisodes.map((e) => e.id), methodIds: [h.versionId, i.versionId, ...candidates.keys()], candidateIds: [...candidates.keys()], readbackRemaining: plan.maxReadbackChars - readbackChars });
			decision.action = action.kind; decision.outcome = "executed";
			if (action.kind === "inspect") {
				if (++inspectCount > plan.maxInspectActions) throw new HarnessError("improvement.workflow-inspect", "inspect count exhausted");
				const content = action.object === "development-feedback" ? source.text : action.object === "meta-episode" ? JSON.stringify(metaEpisodeForModel(priorEpisodes.find((e) => e.id === action.id)!)) : action.id === h.versionId ? h.artifact.body : action.id === i.versionId ? i.artifact.body : candidates.get(action.id)!.artifact.body;
				const text = content.slice(action.start, action.start + Math.min(action.maxChars, plan.maxReadbackChars - readbackChars));
				if (!text) throw new HarnessError("improvement.workflow-inspect", "requested read range is empty");
				readbackChars += text.length; lastActionResult = { kind: "inspect", id: action.id, start: action.start, end: action.start + text.length, totalChars: content.length, text }; await save(); continue;
			}
			if (action.kind === "propose") {
				if (candidates.size >= plan.maxCandidates || action.body === h.artifact.body || [...candidates.values()].some((c) => c.artifact.body === action.body)) { lastActionResult = { kind: "propose", outcome: "rejected", reason: "unchanged, repeated or over candidate cap" }; await save(); continue; }
				const artifact = validateStrategy("executor", { version: 1, kind: "m07-workflow-prompt", slot: "evidence-handoff", body: action.body }) as M07WorkflowStrategyV1;
				const candidate = await store.writeStrategy({ versionId: store.newId("H-agent"), kind: "executor", artifact, parentVersionId: h.versionId, origin: "agent-generated", applicability: action.hypothesis.applicability, limitations: [], sourceExperienceRefs: [], requiredExperienceRefs: uniqueRequirements([...h.requiredExperienceRefs, ...i.requiredExperienceRefs]), requiredKnowledgeRefs: uniqueRefs([...h.requiredKnowledgeRefs, ...i.requiredKnowledgeRefs]), state: "research-only" });
				candidates.set(candidate.versionId, candidate); run.candidates.push({ versionId: candidate.versionId, parentVersionId: h.versionId, producedByImproverVersionId: i.versionId, developmentStatus: "untested", hypothesis: action.hypothesis }); decision.candidateVersionId = candidate.versionId; lastActionResult = { kind: "propose", outcome: "executed", candidateId: candidate.versionId }; await save(); continue;
			}
			if (action.kind === "evaluate-development") {
				const candidate = run.candidates.find((c) => c.versionId === action.candidateId)!;
				if (candidate.developmentStatus !== "untested") { lastActionResult = { kind: "evaluate-development", outcome: "rejected", reason: "candidate already evaluated" }; continue; }
				const candidateRecord = candidates.get(action.candidateId)!;
				await verifyLive([h, i, candidateRecord]);
				let gain = false, complete = true, regression = false;
				for (const item of development.cases) {
					const receipts: WorkflowArmReceiptV1[] = [];
					for (const [arm, method] of [["baseline", h], ["candidate", candidateRecord]] as const) {
						const receipt = await executeArm({ source: template, root: path.join(root, `development-${candidate.versionId}-${item.id}-${arm}`), bundle: active.bundle, h: method, i, caseInput: item, arm, runner, budget, lease: budget.root });
						run.developmentArms.push(receipt); receipts.push(receipt); await save();
					}
					if (receipts.some((x) => x.status !== "complete" || !x.usage.complete)) { complete = false; break; }
					for (let n = 0; n < item.checks.length; n++) { const before = receipts[0]!.checkResults[n]!.passed, after = receipts[1]!.checkResults[n]!.passed; if (!before && after) gain = true; if (before && !after) regression = true; }
				}
				candidate.developmentStatus = !complete ? "inconclusive" : regression || !gain ? "rejected" : "supported";
				lastActionResult = { kind: "evaluate-development", candidateId: candidate.versionId, developmentStatus: candidate.developmentStatus }; await save(); continue;
			}
			if (!action.selectedCandidateId) { await freezeDevelopment("no-winner"); run.status = "research-only"; run.outcome = "completed-no-candidate"; run.stopReason = action.reason; return run; }
			const selected = run.candidates.find((c) => c.versionId === action.selectedCandidateId)!;
			if (selected.developmentStatus !== "supported") { await freezeDevelopment("inconclusive"); run.status = "inconclusive"; run.outcome = "search-incomplete"; run.stopReason = "selected H lacks complete development support"; return run; }
			run.selectedCandidateId = selected.versionId;
			await freezeDevelopment("selected");
			run.selectionReceiptPath = path.join(dir, "selection-before-g.json");
			await writeFileAtomic(run.selectionReceiptPath, `${JSON.stringify({ version: 1, candidateId: selected.versionId, selectedAt: nowIso(), I: i.versionId, H0: h.versionId, K: active.bundle.knowledgeSnapshot }, null, 2)}\n`);
			await save();
			if (!plan.admissionCaseSetPath) { run.status = "research-only"; run.stopReason = "no caller-frozen protected G set"; return run; }
			const admission = await loadCases(path.resolve(ws.root, plan.admissionCaseSetPath), "admission");
			if (admission.cases.some((a) => development.cases.some((d) => a.id === d.id || JSON.stringify({ ...a, id: "" }) === JSON.stringify({ ...d, id: "" })))) throw new HarnessError("improvement.workflow-g", "development and protected cases overlap");
			await protectAdmissionInputs(ws, plan, development, admission);
			await freezeCaseInputs(ws, template, admission.cases);
			run.protectedOpenedAt = nowIso(); await save();
			const candidateRecord = candidates.get(selected.versionId)!;
			await verifyLive([h, i, candidateRecord]);
			for (let repeat = 0; repeat < plan.admissionRepetitions; repeat++) for (const item of admission.cases) {
				const receipts: WorkflowArmReceiptV1[] = [];
				const order = repeat % 2 === 0 ? [["baseline", h], ["candidate", candidateRecord]] as const : [["candidate", candidateRecord], ["baseline", h]] as const;
				for (const [arm, method] of order) { const receipt = await executeArm({ source: template, root: path.join(root, `protected-${repeat}-${item.id}-${arm}`), bundle: active.bundle, h: method, i, caseInput: item, arm, runner, budget, lease: budget.root }); run.protectedArms.push(receipt); receipts.push(receipt); await save(); }
				if (receipts.some((r) => r.status !== "complete" || !r.usage.complete)) { run.status = "inconclusive"; run.outcome = "search-incomplete"; run.stopReason = "protected arm or usage incomplete"; return run; }
				const before = receipts.find((r) => r.arm === "baseline")!, after = receipts.find((r) => r.arm === "candidate")!;
				if (after.checkResults.some((r) => !r.passed) || !before.checkResults.some((r) => !r.passed)) { run.status = "rejected"; run.outcome = "candidate-rejected"; run.stopReason = "protected G found no strict gain or incomplete candidate checks"; return run; }
			}
			if (budget.status().settlement !== "settled") { run.status = "inconclusive"; run.stopReason = "campaign budget is not settled"; return run; }
			await verifyLive([h, i, candidateRecord]);
			const current = await store.active();
			if (current?.pointer.bundleId !== active.pointer.bundleId || current.pointer.runId !== active.pointer.runId) { run.status = "inconclusive"; run.stopReason = "active generation changed during isolated evaluation"; return run; }
			const admitted = await store.writeStrategy({ versionId: store.newId("H-admitted"), kind: "executor", artifact: candidateRecord.artifact, parentVersionId: candidateRecord.versionId, origin: "agent-generated", applicability: candidateRecord.applicability, limitations: candidateRecord.limitations, sourceExperienceRefs: candidateRecord.sourceExperienceRefs, requiredExperienceRefs: candidateRecord.requiredExperienceRefs, requiredKnowledgeRefs: candidateRecord.requiredKnowledgeRefs, state: "admitted" });
			const next = await store.writeBundle({ bundleId: store.newId("bundle"), parents: [active.bundle.bundleId], executorVersionId: admitted.versionId, improverVersionId: i.versionId, knowledgeSnapshot: active.bundle.knowledgeSnapshot, environmentVersion: "m07-workflow/v1", modelConfig: active.bundle.modelConfig, protocolVersion: active.bundle.protocolVersion, allowedCapabilities: active.bundle.allowedCapabilities, state: "admitted" });
			await store.activate(next.bundleId, active.pointer, "local-workflow-handoff-admission", runId);
			run.promotedMethodVersionId = admitted.versionId; run.status = "promoted"; run.outcome = "promoted"; run.stopReason = "local evidence-handoff mechanism checks passed in paired isolated arms; scientific benefit remains unverified"; return run;
		}
		await freezeDevelopment("inconclusive"); run.status = "inconclusive"; run.outcome = "search-incomplete"; run.stopReason = "I exhausted decisions without an explicit terminal choice"; return run;
	} catch (error) { run.status = error instanceof HarnessError && ["improvement.budget", "improvement.usage", "improvement.timeout", "improvement.workflow-usage"].includes(error.code) ? "inconclusive" : "failed"; run.outcome = "search-incomplete"; run.stopReason = (error as Error).message; return run; }
	finally { run.finishedAt = nowIso(); await save(); }
}
