/** Parent-owned paired source confirmation. Protected cases never enter candidate selection. */
import { randomBytes } from "node:crypto";
import { lstat, mkdir, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { SharedBudget } from "../experiments/budget.ts";
import type { BudgetStatus } from "../experiments/contracts.ts";
import type { LoadedSourceV1 } from "../runtime/loaded-source.ts";
import type { SessionRunner } from "../runner/types.ts";
import { HarnessError } from "../types.ts";
import { nowIso, Workspace, writeFileAtomic } from "../workspace.ts";
import { GenerationStore, isSourceStrategy, type ActiveGenerationPointerV1, type GenerationBundleV1, type StrategyRecordV1 } from "./generation.ts";
import { assertFirstWorkflowSourceAllowlist, executeWorkflowSourceArmV2, type WorkflowSourceArmOptions, type WorkflowSourceArmReceipt } from "./workflow-source-arm.ts";
import type { WorkflowTrustedEvaluatorV2 } from "./workflow-result-evaluator.ts";
import { validateWorkflowCaseV2, type WorkflowCaseV2, type WorkflowOutcomeV2 } from "./workflow-types.ts";
import type { SourceCandidateReceipt } from "./source-candidate.ts";
import type { WorkflowSourceSearchReceipt } from "./workflow-source-search.ts";

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const newId = () => `source-confirm-${new Date().toISOString().replace(/[-:.]/g, "")}-${randomBytes(3).toString("hex")}`;
export interface WorkflowSourceDecisionDeclarationV2 { id: string; parameters: Record<string, unknown> }
export interface WorkflowSourceSelectionV2 {
	version: 2; kind: "workflow-source-selection/v2"; developmentRunId: string; candidateVersionId: string;
	candidateReceiptPath: string; searchSelectionPath: string; reason: string; developmentCaseIds: string[];
}
export interface WorkflowSourceConfirmationPlanV2 {
	version: 2; kind: "workflow-source-confirmation/v2"; baselineBundleId: string;
	formalRunId: string; sources: { baseline: LoadedSourceV1; candidate: LoadedSourceV1 };
	experimentRoot: string; admissionCaseSetPath: string; repetitions: number;
	selection: WorkflowSourceSelectionV2; decisionRule: WorkflowSourceDecisionDeclarationV2;
}
export interface WorkflowSourcePairV2 {
	caseId: string; repetition: number; executionOrder: ["baseline", "candidate"] | ["candidate", "baseline"];
	baseline?: { receipt: WorkflowSourceArmReceipt; outcome: WorkflowOutcomeV2; parentLedger: { before: BudgetStatus; after: BudgetStatus } };
	candidate?: { receipt: WorkflowSourceArmReceipt; outcome: WorkflowOutcomeV2; parentLedger: { before: BudgetStatus; after: BudgetStatus } };
}
export interface WorkflowSourceDecisionV2 {
	status: "supported" | "rejected" | "inconclusive";
	quality: { reason: string; evidence: string[] };
	cost: { reason: string; evidence: string[] };
	reason: string;
}
export type WorkflowSourceDeciderV2 = (input: { declaration: WorkflowSourceDecisionDeclarationV2; pairs: readonly WorkflowSourcePairV2[] }) => Promise<WorkflowSourceDecisionV2>;
export interface WorkflowSourceConfirmationRunV2 {
	version: 2; kind: "workflow-source-confirmation/v2"; runId: string; status: "running" | "complete" | "inconclusive" | "failed";
	startedAt: string; finishedAt?: string; baselinePointer: ActiveGenerationPointerV1; baselineBundle: GenerationBundleV1;
	plan: WorkflowSourceConfirmationPlanV2; selectionFrozenAt: string; protectedOpenedAt?: string;
	pairs: WorkflowSourcePairV2[]; partialPair?: WorkflowSourcePairV2; decision?: WorkflowSourceDecisionV2;
	/** M07/M04 execution provider ledger only; external trusted evaluation resources are accounted separately by the caller. */
	usageScope: "execution-provider-only"; usageAtEnd?: unknown; reason?: string;
}

function validatePlan(input: unknown): WorkflowSourceConfirmationPlanV2 {
	if (!input || typeof input !== "object" || Array.isArray(input)) throw new HarnessError("improvement.source-confirmation", "confirmation plan must be an object");
	const p = input as Record<string, unknown>, s = p.selection as Record<string, unknown> | undefined,
		d = p.decisionRule as Record<string, unknown> | undefined, sources = p.sources as Record<string, unknown> | undefined;
	if (p.version !== 2 || p.kind !== "workflow-source-confirmation/v2" || Object.keys(p).sort().join(",") !== "admissionCaseSetPath,baselineBundleId,decisionRule,experimentRoot,formalRunId,kind,repetitions,selection,sources,version" ||
		![p.baselineBundleId, p.formalRunId].every((x) => typeof x === "string" && ID.test(x)) ||
		typeof p.experimentRoot !== "string" || !path.isAbsolute(p.experimentRoot) || typeof p.admissionCaseSetPath !== "string" || !p.admissionCaseSetPath ||
		!Number.isSafeInteger(p.repetitions) || (p.repetitions as number) < 2 || (p.repetitions as number) % 2 !== 0 ||
		!sources || Object.keys(sources).sort().join(",") !== "baseline,candidate" ||
		!s || s.version !== 2 || s.kind !== "workflow-source-selection/v2" || ![s.developmentRunId, s.candidateVersionId].every((x) => typeof x === "string" && ID.test(x)) ||
		typeof s.candidateReceiptPath !== "string" || !path.isAbsolute(s.candidateReceiptPath) || typeof s.searchSelectionPath !== "string" || !path.isAbsolute(s.searchSelectionPath) || typeof s.reason !== "string" || !s.reason.trim() ||
		!Array.isArray(s.developmentCaseIds) || !s.developmentCaseIds.every((x) => typeof x === "string" && ID.test(x)) ||
		!d || typeof d.id !== "string" || !ID.test(d.id) || !d.parameters || typeof d.parameters !== "object" || Array.isArray(d.parameters))
		throw new HarnessError("improvement.source-confirmation", "confirmation needs fixed sources, prior selection, admission cases, even paired repetitions, and a declared decision rule");
	for (const value of Object.values(sources)) {
		const source = value as Record<string, unknown>;
		if (!source || Object.keys(source).sort().join(",") !== "sourceCommit,sourceRoot" || typeof source.sourceRoot !== "string" || !path.isAbsolute(source.sourceRoot) || typeof source.sourceCommit !== "string" || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(source.sourceCommit)) throw new HarnessError("improvement.source-confirmation", "sources must be prepared full-commit bindings");
	}
	return input as WorkflowSourceConfirmationPlanV2;
}
function validDecision(value: unknown): value is WorkflowSourceDecisionV2 {
	if (!value || typeof value !== "object") return false;
	const d = value as Record<string, unknown>;
	const section = (x: unknown) => !!x && typeof x === "object" && typeof (x as { reason?: unknown }).reason === "string" &&
		Array.isArray((x as { evidence?: unknown }).evidence) && (x as { evidence: unknown[] }).evidence.every((item) => typeof item === "string");
	return ["supported", "rejected", "inconclusive"].includes(String(d.status)) && typeof d.reason === "string" && !!d.reason.trim() && section(d.quality) && section(d.cost);
}
async function candidateSelection(plan: WorkflowSourceConfirmationPlanV2, store: GenerationStore, active: { bundle: GenerationBundleV1; h: StrategyRecordV1; i: StrategyRecordV1 }): Promise<{ candidate: StrategyRecordV1; receiptText: string; searchText: string; selectionText: string; evaluationReceiptText: string }> {
	const candidate = await store.readStrategy(plan.selection.candidateVersionId);
	if (candidate.kind !== "executor" || !isSourceStrategy(candidate.artifact) || candidate.artifact.kind !== "source-executor" ||
		candidate.artifact.sourceRoot !== plan.sources.candidate.sourceRoot || candidate.artifact.sourceCommit !== plan.sources.candidate.sourceCommit ||
		candidate.origin !== "agent-generated" || candidate.state !== "research-only")
		throw new HarnessError("improvement.source-confirmation", "selected candidate is not the exact research-only source executor");
	if (active.i.artifact.kind !== "source-improver") throw new HarnessError("improvement.source-confirmation", "protected source confirmation requires a source-backed I search");
	const info = await lstat(plan.selection.candidateReceiptPath);
	if (!info.isFile() || info.isSymbolicLink() || info.size > 4 * 1024 * 1024) throw new HarnessError("improvement.source-confirmation", "model candidate receipt is unavailable");
	const receiptText = await readFile(plan.selection.candidateReceiptPath, "utf8");
	const receipt = JSON.parse(receiptText) as SourceCandidateReceipt;
	if (receipt.status !== "committed" || receipt.engineeringStatus !== "passed" || !receipt.session ||
		receipt.parentCommit !== plan.sources.baseline.sourceCommit || receipt.sourceCommit !== plan.sources.candidate.sourceCommit || receipt.snapshot?.sourceRoot !== plan.sources.candidate.sourceRoot ||
		receipt.changedFiles.length !== 1 || receipt.changedFiles[0] !== "src/m07/feedback.ts")
		throw new HarnessError("improvement.source-confirmation", "selection lacks a checked model-generated source candidate receipt");
	const selectionInfo = await lstat(plan.selection.searchSelectionPath);
	if (!selectionInfo.isFile() || selectionInfo.isSymbolicLink() || selectionInfo.size > 4 * 1024 * 1024 || !plan.selection.searchSelectionPath.endsWith(".selection.json"))
		throw new HarnessError("improvement.source-confirmation", "immutable source-search selection receipt is unavailable");
	const selectionText = await readFile(plan.selection.searchSelectionPath, "utf8");
	const selection = JSON.parse(selectionText) as Record<string, unknown>;
	const searchPath = plan.selection.searchSelectionPath.slice(0, -".selection.json".length), searchInfo = await lstat(searchPath);
	if (!searchInfo.isFile() || searchInfo.isSymbolicLink() || searchInfo.size > 4 * 1024 * 1024) throw new HarnessError("improvement.source-confirmation", "source search run is unavailable");
	const searchText = await readFile(searchPath, "utf8"), search = JSON.parse(searchText) as WorkflowSourceSearchReceipt;
	const picked = search.candidates.find(item => item.id === selection.selectedCandidateId);
	const evaluated = search.evaluations.find(item => item.candidateId === selection.selectedCandidateId);
	const stopped = search.actions.at(-1);
	if (selection.version !== 1 || selection.status !== "selected" || selection.runId !== plan.selection.developmentRunId ||
		selection.runId !== search.runId || search.status !== "selected" || search.selectionReceiptPath !== plan.selection.searchSelectionPath ||
		plan.selection.reason !== search.reason || typeof selection.frozenAt !== "string" || !selection.frozenAt ||
		search.selectedCandidateId !== selection.selectedCandidateId || search.improverVersionId !== active.i.versionId ||
		selection.improverVersionId !== active.i.versionId ||
		JSON.stringify(search.source) !== JSON.stringify({ sourceRoot: active.i.artifact.sourceRoot, sourceCommit: active.i.artifact.sourceCommit }) ||
		JSON.stringify(selection.source) !== JSON.stringify(search.source) ||
		search.baseline.bundleId !== active.bundle.bundleId || search.baseline.executorVersionId !== active.h.versionId ||
		JSON.stringify(search.baseline.executorSource) !== JSON.stringify(plan.sources.baseline) ||
		JSON.stringify(selection.baseline) !== JSON.stringify(search.baseline) ||
		JSON.stringify(selection.developmentIds) !== JSON.stringify(plan.selection.developmentCaseIds) ||
		JSON.stringify(search.developmentIds) !== JSON.stringify(plan.selection.developmentCaseIds) ||
		JSON.stringify(selection.candidates) !== JSON.stringify(search.candidates) || JSON.stringify(selection.evaluations) !== JSON.stringify(search.evaluations) ||
		JSON.stringify(selection.actions) !== JSON.stringify(search.actions) ||
		JSON.stringify(selection.modelSessions) !== JSON.stringify(search.modelSessions) || JSON.stringify(selection.usage) !== JSON.stringify(search.usage) ||
		JSON.stringify(selection.inspectedDevelopmentIds) !== JSON.stringify(search.state.inspectedDevelopment.map(item => item.id)) ||
		!picked || picked.status !== "ready" || picked.receiptPath !== plan.selection.candidateReceiptPath ||
		picked.sourceRoot !== plan.sources.candidate.sourceRoot || picked.sourceCommit !== plan.sources.candidate.sourceCommit ||
		!evaluated || evaluated.status !== "preferred" || selection.developmentEvaluationReceiptPath !== evaluated.receiptPath ||
		selection.candidateReceiptPath !== picked.receiptPath ||
		stopped?.outcome !== "completed" || stopped.action.kind !== "stop" || stopped.action.candidateId !== picked.id ||
		search.usage.usageUnknown || !search.usage.costComplete ||
		search.modelSessions.some(item => item.status !== "returned" || !item.usage?.costComplete || !item.usage.complete))
		throw new HarnessError("improvement.source-confirmation", "selected candidate lacks a matching completed source I development search and evaluation");
	const evaluationInfo = await lstat(evaluated.receiptPath);
	if (!evaluationInfo.isFile() || evaluationInfo.isSymbolicLink() || evaluationInfo.size > 4 * 1024 * 1024)
		throw new HarnessError("improvement.source-confirmation", "selected candidate's development evaluation receipt is unavailable");
	return { candidate, receiptText, searchText, selectionText, evaluationReceiptText: await readFile(evaluated.receiptPath, "utf8") };
}
function incompleteArm(caseId: string, arm: "baseline" | "candidate", workspaceRoot: string, methodVersionId: string, source: LoadedSourceV1, reason: string,
	before: BudgetStatus, after: BudgetStatus): { receipt: WorkflowSourceArmReceipt; outcome: WorkflowOutcomeV2; parentLedger: { before: BudgetStatus; after: BudgetStatus } } {
	const receipt: WorkflowSourceArmReceipt = { protocolVersion: 2, loadedSource: source, childPid: 0, caseId, arm, methodVersionId, workspaceRoot,
		checkResults: [], usage: { providerCalls: Math.max(0, after.committed.providerCalls - before.committed.providerCalls),
			inputTokens: Math.max(0, after.committed.inputTokens - before.committed.inputTokens), outputTokens: Math.max(0, after.committed.outputTokens - before.committed.outputTokens),
			sdkEstimatedCost: Math.max(0, after.committed.sdkEstimatedCost - before.committed.sdkEstimatedCost), complete: false, costComplete: false },
		status: "inconclusive", reason: `${reason}; parent ledger ${after.usageUnknown ? "contains unknown usage" : "retains observed usage"}` };
	return { receipt, outcome: { version: 2, caseId, executionComplete: false, checked: false, quality: [], cost: receipt.usage, reason }, parentLedger: { before, after } };
}

export async function runWorkflowSourceConfirmation(args: { workspace: Workspace; store: GenerationStore; runner: SessionRunner;
	planInput: unknown; evaluator: WorkflowTrustedEvaluatorV2; decider: WorkflowSourceDeciderV2;
	sourceRunnerOptions: Pick<WorkflowSourceArmOptions, "runnerKind" | "fakeReplyModule">;
	beforePrompt: () => Promise<void> }): Promise<WorkflowSourceConfirmationRunV2> {
	const plan = validatePlan(args.planInput), active = await args.store.active();
	if (!active || active.bundle.bundleId !== plan.baselineBundleId) throw new HarnessError("improvement.source-confirmation", "active bundle differs from the declared baseline");
	const [h, i] = await Promise.all([args.store.readStrategy(active.bundle.executorVersionId), args.store.readStrategy(active.bundle.improverVersionId)]);
	if (active.bundle.environmentVersion !== "m07-workflow/v1" ||
		!(h.artifact.kind === "m07-workflow-prompt" || h.artifact.kind === "source-executor") ||
		!(i.artifact.kind === "diagnostic-improver-prompt" || i.artifact.kind === "source-improver") ||
		(h.artifact.kind === "source-executor" && (h.artifact.sourceRoot !== plan.sources.baseline.sourceRoot || h.artifact.sourceCommit !== plan.sources.baseline.sourceCommit)))
		throw new HarnessError("improvement.source-confirmation", "confirmation baseline must bind the active workflow H and I");
	const { candidate, receiptText, searchText, selectionText, evaluationReceiptText } = await candidateSelection(plan, args.store, { bundle: active.bundle, h, i });
	if (candidate.parentVersionId !== h.versionId) throw new HarnessError("improvement.source-confirmation", "candidate does not descend from the selected baseline H");
	await assertFirstWorkflowSourceAllowlist(plan.sources.baseline, plan.sources.candidate);
	const knowledge = await args.workspace.readRun("M04", plan.formalRunId);
	if (knowledge.status !== "completed" || knowledge.failures.length) throw new HarnessError("improvement.source-confirmation", "formal M04 baseline is not complete");
	const experimentRoot = path.resolve(plan.experimentRoot), workspaceRoot = await realpath(args.workspace.root);
	if (experimentRoot === workspaceRoot || experimentRoot.startsWith(`${workspaceRoot}${path.sep}`) || workspaceRoot.startsWith(`${experimentRoot}${path.sep}`))
		throw new HarnessError("improvement.source-confirmation", "experiment root must be independent of the source workspace");
	if (await lstat(experimentRoot).catch(() => undefined)) throw new HarnessError("improvement.source-confirmation", "experiment root already exists");
	const runId = newId(), dir = path.join(args.store.root, "source-confirmations", runId), budget = new SharedBudget(runId, {});
	const run: WorkflowSourceConfirmationRunV2 = { version: 2, kind: "workflow-source-confirmation/v2", runId, status: "running", startedAt: nowIso(),
		baselinePointer: active.pointer, baselineBundle: active.bundle, plan, selectionFrozenAt: nowIso(), pairs: [], usageScope: "execution-provider-only" };
	await mkdir(dir, { recursive: true });
	await mkdir(experimentRoot);
	const save = async () => { run.usageAtEnd = budget.status(); await writeFileAtomic(path.join(dir, "run.json"), `${JSON.stringify(run, null, 2)}\n`); };
	// The decision declaration and selection are on disk before private admission data is opened.
	await writeFileAtomic(path.join(dir, "plan.json"), `${JSON.stringify(plan, null, 2)}\n`);
	await writeFileAtomic(path.join(dir, "selection.json"), `${JSON.stringify({ ...plan.selection, frozenAt: run.selectionFrozenAt, candidateSource: plan.sources.candidate }, null, 2)}\n`);
	await writeFileAtomic(path.join(dir, "candidate-receipt.private.json"), receiptText);
	await writeFileAtomic(path.join(dir, "source-search.private.json"), searchText);
	await writeFileAtomic(path.join(dir, "source-selection.private.json"), selectionText);
	await writeFileAtomic(path.join(dir, "development-evaluation.private.json"), evaluationReceiptText);
	await save();
	try {
		const file = await realpath(path.resolve(args.workspace.root, plan.admissionCaseSetPath)), info = await stat(file);
		if (file === workspaceRoot || file.startsWith(`${workspaceRoot}${path.sep}`)) throw new Error("private G case set must be outside the copied source workspace");
		if (!info.isFile() || info.size > 2_000_000) throw new Error("admission case set is absent or too large");
		const raw = JSON.parse(await readFile(file, "utf8")) as { version?: number; split?: string; cases?: unknown[] };
		if (raw.version !== 2 || raw.split !== "admission" || !Array.isArray(raw.cases) || raw.cases.length < 1) throw new Error("invalid v2 admission cases");
		const cases = raw.cases.map(validateWorkflowCaseV2);
		const ids = cases.map((item) => item.visible.id);
		if (new Set(ids).size !== ids.length || ids.some((id) => plan.selection.developmentCaseIds.includes(id))) throw new Error("admission cases overlap or repeat development identifiers");
		await writeFileAtomic(path.join(dir, "admission-cases.private.json"), `${JSON.stringify(raw, null, 2)}\n`);
		run.protectedOpenedAt = nowIso(); await save();
		for (let repetition = 0; repetition < plan.repetitions; repetition++) for (const item of cases) {
			const order: WorkflowSourcePairV2["executionOrder"] = repetition % 2 === 0 ? ["baseline", "candidate"] : ["candidate", "baseline"];
			const pair: WorkflowSourcePairV2 = { caseId: item.visible.id, repetition, executionOrder: order };
			run.partialPair = pair; await save();
			for (const arm of order) {
				const armRoot = path.join(experimentRoot, `${repetition}-${item.visible.id}-${arm}`);
				const ledgerBefore = budget.status();
				try {
					await args.beforePrompt();
					const result = await executeWorkflowSourceArmV2(plan.sources[arm], { sourceWorkspaceRoot: args.workspace.root, root: armRoot,
						bundle: active.bundle, h, i, caseInput: item, arm, builtinBaseline: false, formalRunId: plan.formalRunId },
						{ ...args.sourceRunnerOptions, budget, lease: budget.root, beforePrompt: args.beforePrompt, evaluator: args.evaluator, baselineSource: plan.sources.baseline });
					pair[arm] = { ...result, parentLedger: { before: ledgerBefore, after: budget.status() } };
				} catch (error) { pair[arm] = incompleteArm(item.visible.id, arm, armRoot, h.versionId, plan.sources[arm], (error as Error).message, ledgerBefore, budget.status()); }
				await save();
			}
			run.pairs.push(pair); delete run.partialPair; await save();
		}
		const complete = run.pairs.length === cases.length * plan.repetitions && run.pairs.every((pair) =>
			[pair.baseline, pair.candidate].every((item) => item?.outcome.executionComplete && item.outcome.checked && item.receipt.usage.costComplete));
		if (!complete) { run.status = "inconclusive"; run.reason = "a paired arm or observable cost is incomplete"; return run; }
		const decision = await args.decider({ declaration: plan.decisionRule, pairs: run.pairs });
		if (!validDecision(decision)) throw new Error("trusted decision rule returned an invalid quality/cost decision");
		run.decision = decision;
		run.status = "complete";
		return run;
	} catch (error) { run.status = "failed"; run.reason = (error as Error).message; return run; }
	finally { run.finishedAt = nowIso(); await save(); }
}

export async function readConfirmedSourceRun(store: GenerationStore, runId: string): Promise<WorkflowSourceConfirmationRunV2> {
	if (!ID.test(runId)) throw new HarnessError("improvement.source-confirmation", "invalid confirmation run ID");
	const dir = path.join(store.root, "source-confirmations", runId);
	const [runText, planText, selectionText, candidateText, searchText, sourceSelectionText, developmentEvaluationText] = await Promise.all(
		["run.json", "plan.json", "selection.json", "candidate-receipt.private.json", "source-search.private.json", "source-selection.private.json", "development-evaluation.private.json"]
			.map((file) => readFile(path.join(dir, file), "utf8")));
	const run = JSON.parse(runText) as WorkflowSourceConfirmationRunV2;
	const plan = validatePlan(JSON.parse(planText));
	const selection = JSON.parse(selectionText) as WorkflowSourceSelectionV2 & { frozenAt?: string; candidateSource?: LoadedSourceV1 };
	if (run.version !== 2 || run.kind !== "workflow-source-confirmation/v2" || run.runId !== runId || run.usageScope !== "execution-provider-only" ||
		JSON.stringify(run.plan) !== JSON.stringify(plan) || JSON.stringify(selection.candidateSource) !== JSON.stringify(plan.sources.candidate) ||
		JSON.stringify({ ...selection, frozenAt: undefined, candidateSource: undefined }) !== JSON.stringify({ ...plan.selection, frozenAt: undefined, candidateSource: undefined }) ||
		selection.frozenAt !== run.selectionFrozenAt || !run.protectedOpenedAt || run.selectionFrozenAt > run.protectedOpenedAt)
		throw new HarnessError("improvement.source-confirmation", "confirmation selection or plan differs from its pre-admission freeze");
	const candidate = JSON.parse(candidateText) as SourceCandidateReceipt;
	const search = JSON.parse(searchText) as WorkflowSourceSearchReceipt;
	const sourceSelection = JSON.parse(sourceSelectionText) as Record<string, unknown>;
	const selected = search.candidates.find(item => item.id === sourceSelection.selectedCandidateId);
	const evaluated = search.evaluations.find(item => item.candidateId === sourceSelection.selectedCandidateId);
	if (sourceSelection.status !== "selected" || search.status !== "selected" || search.runId !== plan.selection.developmentRunId ||
		sourceSelection.runId !== search.runId || search.selectedCandidateId !== sourceSelection.selectedCandidateId ||
		search.baseline.bundleId !== plan.baselineBundleId ||
		JSON.stringify(search.baseline.executorSource) !== JSON.stringify(plan.sources.baseline) ||
		JSON.stringify(search.source) !== JSON.stringify(sourceSelection.source) ||
		!selected || selected.status !== "ready" || selected.receiptPath !== plan.selection.candidateReceiptPath ||
		selected.sourceRoot !== plan.sources.candidate.sourceRoot || selected.sourceCommit !== plan.sources.candidate.sourceCommit ||
		!evaluated || evaluated.status !== "preferred" || sourceSelection.developmentEvaluationReceiptPath !== evaluated.receiptPath ||
		!developmentEvaluationText.trim() ||
		search.usage.usageUnknown || !search.usage.costComplete)
		throw new HarnessError("improvement.source-confirmation", "frozen search selection no longer identifies the evaluated candidate");
	if (candidate.status !== "committed" || candidate.engineeringStatus !== "passed" || !candidate.session ||
		candidate.parentCommit !== plan.sources.baseline.sourceCommit || candidate.sourceCommit !== plan.sources.candidate.sourceCommit || candidate.snapshot?.sourceRoot !== plan.sources.candidate.sourceRoot ||
		candidate.changedFiles.length !== 1 || candidate.changedFiles[0] !== "src/m07/feedback.ts")
		throw new HarnessError("improvement.source-confirmation", "frozen model candidate receipt is incomplete or mismatched");
	return run;
}

/** Recompute structural completeness from the frozen protected set before any pointer write. */
export async function assertCompleteSourceConfirmation(store: GenerationStore, run: WorkflowSourceConfirmationRunV2): Promise<void> {
	if (run.status !== "complete" || run.decision?.status !== "supported" || !run.finishedAt || !run.protectedOpenedAt)
		throw new HarnessError("improvement.source-admission", "source confirmation has no supported final decision");
	const file = path.join(store.root, "source-confirmations", run.runId, "admission-cases.private.json");
	const frozen = JSON.parse(await readFile(file, "utf8")) as { version?: number; split?: string; cases?: unknown[] };
	if (frozen.version !== 2 || frozen.split !== "admission" || !Array.isArray(frozen.cases) || !frozen.cases.length)
		throw new HarnessError("improvement.source-admission", "frozen protected cases are unavailable");
	const cases = frozen.cases.map(validateWorkflowCaseV2), caseIds = cases.map((item) => item.visible.id);
	if (new Set(caseIds).size !== caseIds.length || run.pairs.length !== caseIds.length * run.plan.repetitions || run.partialPair)
		throw new HarnessError("improvement.source-admission", "confirmation has missing or duplicate pairs");
	const workspaces = new Set<string>(), processes = new Set<number>();
	for (let repetition = 0; repetition < run.plan.repetitions; repetition++) for (let index = 0; index < caseIds.length; index++) {
		const pair = run.pairs[repetition * caseIds.length + index];
		const order = repetition % 2 === 0 ? ["baseline", "candidate"] : ["candidate", "baseline"];
		if (!pair || pair.repetition !== repetition || pair.caseId !== caseIds[index] || JSON.stringify(pair.executionOrder) !== JSON.stringify(order))
			throw new HarnessError("improvement.source-admission", "pair identity or AB/BA order differs from the frozen plan");
		for (const arm of ["baseline", "candidate"] as const) {
			const item = pair[arm], receipt = item?.receipt;
			if (!item || !receipt || receipt.protocolVersion !== 2 || receipt.arm !== arm || receipt.caseId !== pair.caseId ||
				item.outcome.version !== 2 || item.outcome.caseId !== pair.caseId || !item.outcome.executionComplete || !item.outcome.checked ||
				receipt.status !== "complete" || !receipt.usage.complete || !receipt.usage.costComplete ||
				receipt.loadedSource.sourceRoot !== run.plan.sources[arm].sourceRoot || receipt.loadedSource.sourceCommit !== run.plan.sources[arm].sourceCommit ||
				!Number.isSafeInteger(receipt.childPid) || receipt.childPid <= 0 || workspaces.has(receipt.workspaceRoot) || processes.has(receipt.childPid))
				throw new HarnessError("improvement.source-admission", "confirmation contains an incomplete or source-mismatched arm");
			workspaces.add(receipt.workspaceRoot); processes.add(receipt.childPid);
		}
	}
}
