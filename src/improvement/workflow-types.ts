import path from "node:path";
import type { LoadedSourceV1 } from "../runtime/loaded-source.ts";
import type { BudgetLimits } from "../experiments/contracts.ts";
import { isKnowledgeRef } from "../knowledge/experience-index.ts";
import type { KnowledgeRef } from "../knowledge/types.ts";
import type { BeginGoalInput, TaskSpecInput } from "../m07/types.ts";
import { HarnessError } from "../types.ts";

/** A deliberately separate M07 protocol. CPU cases and their evaluator never enter this path. */
export interface WorkflowCheckV1 {
	criterion: string;
	/** Literal observations in the frozen report. They are controller checks, not model instructions. */
	contains: string[];
	forbids: string[];
}
export interface WorkflowCaseV1 {
	id: string;
	goal: Omit<BeginGoalInput, "workflowMethodVersionId">;
	task: TaskSpecInput;
	checks: WorkflowCheckV1[];
}
export interface WorkflowCaseSetV1 { version: 1; split: "development" | "admission"; cases: WorkflowCaseV1[] }
/** Only this projection may cross the source-arm IPC boundary in v2. */
export interface WorkflowVisibleCaseV2 {
	id: string;
	goal: Omit<BeginGoalInput, "workflowMethodVersionId">;
	/** Checks in this task are mechanically verifiable delivery obligations. Scientific G is external. */
	task: TaskSpecInput;
	/** Model-visible source paths. The adapter freezes these input copies as review artifacts. */
	requiredEvidence: string[];
}
/** The controller owns this object. Its evaluator input is never sent to an arm. */
export interface WorkflowCaseV2 {
	version: 2;
	visible: WorkflowVisibleCaseV2;
	evaluation: { groundTruth: unknown };
}
export interface WorkflowQualityCheckV2 {
	criterion: string;
	passed: boolean | null;
	evidence: string[];
	reason: string;
}
export interface WorkflowOutcomeV2 {
	version: 2;
	caseId: string;
	executionComplete: boolean;
	checked: boolean;
	quality: WorkflowQualityCheckV2[];
	/** Observed execution provider use only; parent semantic evaluator resources are not included. */
	cost: WorkflowArmReceiptV1["usage"];
	reason?: string;
}
export interface WorkflowCalibrationPlanV1 {
	version: 1;
	kind: "m07-evidence-handoff-aa/v1";
	caseSetPath: string;
	experimentRoot: string;
	baseline: "active-h" | "builtin";
	/** Caller-declared sample size: each repetition executes one fresh A/A pair per case. */
	repetitions: number;
}
/** Same frozen method and data, two explicitly reviewed source versions; observation only. */
export interface WorkflowSourceComparisonPlanV1 extends Omit<WorkflowCalibrationPlanV1, "kind"> {
	kind: "m07-source-comparison/v1";
	sources: { baseline: LoadedSourceV1; candidate: LoadedSourceV1 };
}
export interface WorkflowEvidenceHandoffPlanV1 {
	version: 1;
	kind: "m07-evidence-handoff/v1";
	/** Comparison arm only; omission preserves the historical injected-H baseline. */
	baseline?: "active-h" | "builtin";
	/** A completed real M07 checkpoint and the M04 run that processed it. */
	developmentSource: { m07RunId: string; checkpointId: string; m04RunId: string };
	developmentCaseSetPath: string;
	/** Omission leaves an inspectable research-only run. The controller freezes G before search; model-visible evaluation starts only after selection. */
	admissionCaseSetPath?: string;
	/** Must not exist and must be disjoint from the live workspace. Never cleaned automatically. */
	experimentRoot: string;
	/** Legacy execution quotas; ignored by current runs. */
	maxDecisions?: number;
	maxCandidates?: number;
	maxInspectActions?: number;
	/** Legacy cumulative readback quota, accepted only for historical plan decoding. */
	maxReadbackChars?: number;
	maxFeedbackItems: number;
	perPromptTimeoutMs?: number;
	budget: BudgetLimits;
	/** At least two paired, fresh protected executions are needed for admission. */
	admissionRepetitions: number;
	/** Prior same-workspace development episodes. Protected results are excluded. */
	metaEpisodeRunIds?: string[];
	/** Explicit pinned I experience; omitted means no experience pack. Never selected by search. */
	experienceRefs?: KnowledgeRef[];
	experienceMaxRecords?: number;
	experienceMaxChars?: number;
}
export interface WorkflowArmReceiptV1 {
	protocolVersion?: 1 | 2;
	loadedSource?: LoadedSourceV1;
	childPid?: number;
	caseId: string;
	arm: "baseline" | "candidate";
	methodVersionId: string;
	/** The actual M07 method binding; builtin means no workflow H was injected. */
	methodBinding?: { kind: "builtin" } | { kind: "injected-h"; versionId: string } | { kind: "source-h"; versionId: string; sourceCommit: string };
	workspaceRoot: string;
	m07RunId?: string;
	m04RunId?: string;
	frozenReportPath?: string;
	reportDeliveredToM04?: boolean;
	feedbackStatus?: string;
	checkpointId?: string;
	knowledgeBeforeSnapshot?: string;
	knowledgeAfterSnapshot?: string;
	checkResults: Array<{ criterion: string; passed: boolean }>;
	usage: { providerCalls: number; inputTokens: number; outputTokens: number; sdkEstimatedCost: number; complete: boolean; costComplete?: boolean };
	status: "complete" | "inconclusive";
	reason?: string;
}
export type WorkflowCalibrationArmV1 = Omit<WorkflowArmReceiptV1, "arm"> & { arm: "A" | "A2" };
export interface WorkflowCalibrationRunV1 {
	version: 1;
	kind: "m07-evidence-handoff-aa/v1" | "m07-source-comparison/v1";
	evidenceScope: "local-handoff-calibration" | "local-source-handoff-observation";
	sources?: WorkflowSourceComparisonPlanV1["sources"];
	scientificBenefit: "unverified";
	runId: string;
	startedAt: string;
	finishedAt?: string;
	status: "running" | "complete" | "inconclusive" | "failed";
	baseline: "active-h" | "builtin";
	baselineBundleId: string;
	methodVersionId: string;
	knowledgeSnapshot?: string;
	formalM04RunId?: string;
	sourceWorkspace?: string;
	pairs: Array<{ caseId: string; repetition: number; executionOrder: ["A", "A2"] | ["A2", "A"]; armA: WorkflowCalibrationArmV1; armA2: WorkflowCalibrationArmV1; differences: Array<{ criterion: string; aPassed: boolean; a2Passed: boolean }> }>;
	partialPair?: { caseId: string; repetition: number; executionOrder: ["A", "A2"] | ["A2", "A"]; armA?: WorkflowCalibrationArmV1; armA2?: WorkflowCalibrationArmV1 };
	budgetAtEnd?: unknown;
	stopReason?: string;
}
export interface WorkflowRunV1 {
	version: 1;
	kind: "m07-evidence-handoff/v1";
	/** Mechanical local handoff evidence only; scientific benefit remains unverified. */
	evidenceScope: "local-handoff-mechanism";
	scientificBenefit: "unverified";
	runId: string;
	startedAt: string;
	finishedAt?: string;
	status: "running" | "research-only" | "rejected" | "inconclusive" | "promoted" | "failed";
	outcome?: "completed-no-candidate" | "candidate-supported" | "candidate-rejected" | "promoted" | "search-incomplete" | "provider-failed";
	baselineBundleId: string;
	/** The actual comparison arm: an H version for active-h, or the builtin-default sentinel. */
	baselineExecutorVersionId: string;
	/** Omission on old runs means active-h. */
	comparisonBaseline?: "active-h" | "builtin";
	proposalSeedHVersionId?: string;
	improverVersionId: string;
	knowledgeSnapshot?: string;
	developmentSource: WorkflowEvidenceHandoffPlanV1["developmentSource"];
	decisions: Array<{ index: number; improverVersionId: string; sessionId?: string; action?: string; candidateVersionId?: string; outcome: string }>;
	/** Observed UTF-8 bytes returned by successful inspect actions; never a spending limit. */
	inspectionReadbackBytesObserved?: number;
	candidates: Array<{ versionId: string; parentVersionId: string; producedByImproverVersionId: string; developmentStatus: "untested" | "supported" | "rejected" | "inconclusive"; hypothesis: unknown }>;
	developmentArms: WorkflowArmReceiptV1[];
	protectedArms: WorkflowArmReceiptV1[];
	selectedCandidateId?: string;
	promotedMethodVersionId?: string;
	selectionReceiptPath?: string;
	protectedOpenedAt?: string;
	protectedFrozenAt?: string;
	sourceWorkspace?: string;
	stopReason?: string;
	budgetAtEnd?: unknown;
	developmentBudgetAtSelection?: unknown;
	metaEpisodeIds?: string[];
}

const safeId = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
export function validateWorkflowCalibrationPlan(input: unknown): WorkflowCalibrationPlanV1 {
	if (!input || typeof input !== "object" || Array.isArray(input)) throw new HarnessError("improvement.workflow-calibration", "calibration plan must be an object");
	const p = input as Record<string, unknown>;
	if (Object.keys(p).sort().join(",") !== "baseline,caseSetPath,experimentRoot,kind,repetitions,version" || p.version !== 1 || p.kind !== "m07-evidence-handoff-aa/v1" || !["active-h", "builtin"].includes(String(p.baseline)) ||
		typeof p.caseSetPath !== "string" || !p.caseSetPath.trim() || p.caseSetPath.length > 500 || typeof p.experimentRoot !== "string" || !p.experimentRoot.trim() || p.experimentRoot.length > 500 ||
		!Number.isSafeInteger(p.repetitions) || (p.repetitions as number) < 2 || (p.repetitions as number) % 2 !== 0) throw new HarnessError("improvement.workflow-calibration", "calibration requires a development case path, isolated root, baseline, and caller-declared even repetitions");
	return p as unknown as WorkflowCalibrationPlanV1;
}
export function validateWorkflowSourceComparisonPlan(input: unknown): WorkflowSourceComparisonPlanV1 {
	if (!input || typeof input !== "object" || Array.isArray(input)) throw new HarnessError("improvement.workflow-source-comparison", "source comparison plan must be an object");
	const { sources, ...base } = input as Record<string, unknown>;
	if (base.kind !== "m07-source-comparison/v1") throw new HarnessError("improvement.workflow-source-comparison", "unsupported source comparison protocol");
	const common = validateWorkflowCalibrationPlan({ ...base, kind: "m07-evidence-handoff-aa/v1" });
	if (!sources || typeof sources !== "object" || Array.isArray(sources) || Object.keys(sources).sort().join(",") !== "baseline,candidate") throw new HarnessError("improvement.workflow-source-comparison", "source comparison requires baseline and candidate snapshots");
	for (const source of Object.values(sources)) {
		if (!source || typeof source !== "object" || Array.isArray(source) || Object.keys(source).sort().join(",") !== "sourceCommit,sourceRoot" || typeof source.sourceRoot !== "string" || !path.isAbsolute(source.sourceRoot) || typeof source.sourceCommit !== "string" || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(source.sourceCommit)) throw new HarnessError("improvement.workflow-source-comparison", "each source must pin a prepared directory and full commit");
	}
	return { ...common, kind: "m07-source-comparison/v1", sources: sources as WorkflowSourceComparisonPlanV1["sources"] };
}
function budget(value: unknown): value is BudgetLimits {
	if (value === undefined) return true;
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const b = value as Record<string, unknown>;
	return Object.keys(b).every((key) => ["maxCpuMillis", "maxInputTokens", "maxOutputTokens", "maxProbeCalls", "maxProviderCalls", "maxSdkEstimatedCost", "maxWallMillis"].includes(key)) &&
		(b.maxSdkEstimatedCost === undefined || typeof b.maxSdkEstimatedCost === "number" && Number.isFinite(b.maxSdkEstimatedCost) && b.maxSdkEstimatedCost >= 0);
}
export function validateWorkflowPlan(input: unknown): WorkflowEvidenceHandoffPlanV1 {
	if (!input || typeof input !== "object" || Array.isArray(input)) throw new HarnessError("improvement.workflow-plan", "workflow plan must be an object");
	const p = input as Record<string, unknown>;
	const keys = ["version", "kind", "baseline", "developmentSource", "developmentCaseSetPath", "admissionCaseSetPath", "experimentRoot", "maxDecisions", "maxCandidates", "maxInspectActions", "maxReadbackChars", "maxFeedbackItems", "perPromptTimeoutMs", "budget", "admissionRepetitions", "metaEpisodeRunIds", "experienceRefs", "experienceMaxRecords", "experienceMaxChars"];
	if (Object.keys(p).some((key) => !keys.includes(key)) || p.version !== 1 || p.kind !== "m07-evidence-handoff/v1") throw new HarnessError("improvement.workflow-plan", "unsupported workflow plan");
	if (p.baseline !== undefined && p.baseline !== "active-h" && p.baseline !== "builtin") throw new HarnessError("improvement.workflow-plan", "baseline must be active-h or builtin");
	const src = p.developmentSource as Record<string, unknown> | undefined;
	if (!src || Object.keys(src).sort().join(",") !== "checkpointId,m04RunId,m07RunId" || !safeId(src.m07RunId) || !safeId(src.checkpointId) || !safeId(src.m04RunId)) throw new HarnessError("improvement.workflow-plan", "development source must pin one M07 checkpoint and its M04 run");
	for (const key of ["developmentCaseSetPath", "experimentRoot"] as const) if (typeof p[key] !== "string" || !p[key].trim() || p[key].length > 500) throw new HarnessError("improvement.workflow-plan", `${key} is required`);
	if (p.admissionCaseSetPath !== undefined && (typeof p.admissionCaseSetPath !== "string" || !p.admissionCaseSetPath.trim() || p.admissionCaseSetPath === p.developmentCaseSetPath)) throw new HarnessError("improvement.workflow-plan", "admission cases must be a distinct path");
	for (const [key, min, max] of [["maxFeedbackItems", 1, 24], ["admissionRepetitions", 2, Number.MAX_SAFE_INTEGER]] as const)
		if (!Number.isSafeInteger(p[key]) || (p[key] as number) < min || (p[key] as number) > max) throw new HarnessError("improvement.workflow-plan", `${key} must be ${min}–${max}`);
	if (p.maxReadbackChars !== undefined && (!Number.isSafeInteger(p.maxReadbackChars) || (p.maxReadbackChars as number) < 0)) throw new HarnessError("improvement.workflow-plan", "legacy maxReadbackChars must be a nonnegative integer");
	if ((p.admissionRepetitions as number) % 2 !== 0 || !budget(p.budget)) throw new HarnessError("improvement.workflow-plan", "even paired repetitions and valid historical budget fields are required");
	if (p.metaEpisodeRunIds !== undefined && (!Array.isArray(p.metaEpisodeRunIds) || !p.metaEpisodeRunIds.every(safeId) || new Set(p.metaEpisodeRunIds).size !== p.metaEpisodeRunIds.length)) throw new HarnessError("improvement.workflow-plan", "prior workflow episodes must be distinct run IDs");
	if (p.experienceRefs !== undefined) {
		if (!Array.isArray(p.experienceRefs) || p.experienceRefs.length > 20 || !p.experienceRefs.every(isKnowledgeRef) || new Set(p.experienceRefs.map((ref: KnowledgeRef) => `${ref.storeId}/${ref.recordId}@${ref.version}`)).size !== p.experienceRefs.length) throw new HarnessError("improvement.workflow-plan", "experienceRefs must be at most twenty distinct pinned references");
	}
	const refCount = (p.experienceRefs as KnowledgeRef[] | undefined)?.length ?? 0;
	if (refCount) {
		if (!Number.isSafeInteger(p.experienceMaxRecords) || (p.experienceMaxRecords as number) < refCount || (p.experienceMaxRecords as number) > 20 || !Number.isSafeInteger(p.experienceMaxChars) || (p.experienceMaxChars as number) < 1 || (p.experienceMaxChars as number) > 12_000) throw new HarnessError("improvement.workflow-plan", "nonempty workflow I experience requires bounded record and character caps");
	} else if (p.experienceMaxRecords !== undefined || p.experienceMaxChars !== undefined) {
		if (p.experienceMaxRecords !== 0 || p.experienceMaxChars !== 0) throw new HarnessError("improvement.workflow-plan", "empty workflow I experience must have zero or omitted caps");
	}
	const { maxOutputTokens: _legacyOutputLimit, maxProviderCalls: _calls, maxInputTokens: _input,
		maxProbeCalls: _probes, maxCpuMillis: _cpu, maxWallMillis: _wall, ...activeBudget } = (p.budget ?? {}) as BudgetLimits;
	const { maxDecisions: _decisions, maxCandidates: _candidates, maxInspectActions: _inspections, maxReadbackChars: _readback,
		perPromptTimeoutMs: _timeout, ...activePlan } = p;
	return { ...activePlan, budget: activeBudget } as unknown as WorkflowEvidenceHandoffPlanV1;
}
export function validateWorkflowCaseSet(input: unknown, split: WorkflowCaseSetV1["split"]): WorkflowCaseSetV1 {
	if (!input || typeof input !== "object" || Array.isArray(input)) throw new HarnessError("improvement.workflow-cases", "case set must be an object");
	const set = input as Record<string, unknown>;
	if (Object.keys(set).sort().join(",") !== "cases,split,version" || set.version !== 1 || set.split !== split || !Array.isArray(set.cases) || set.cases.length < 1) throw new HarnessError("improvement.workflow-cases", "invalid frozen case set");
	const ids = new Set<string>();
	for (const raw of set.cases) {
		const c = raw as Record<string, unknown>;
		if (!c || Object.keys(c).sort().join(",") !== "checks,goal,id,task" || !safeId(c.id) || ids.has(c.id)) throw new HarnessError("improvement.workflow-cases", "invalid or repeated case id");
		ids.add(c.id);
		const goal = c.goal as Record<string, unknown>, task = c.task as Record<string, unknown>;
		if (!goal || typeof goal.goal !== "string" || !goal.goal.trim() || typeof goal.problemRelation !== "string" || !goal.problemRelation.trim() || typeof goal.plan !== "string" || !goal.plan.trim() || !Array.isArray(goal.constraints) || !goal.constraints.length || !Array.isArray(goal.successCriteria) || !goal.successCriteria.length || Object.hasOwn(goal, "workflowMethodVersionId")) throw new HarnessError("improvement.workflow-cases", "case goal is incomplete or controls its own method");
		if (!task || !["reason", "check"].includes(String(task.mode)) || typeof task.objective !== "string" || !task.objective.trim() || !Array.isArray(task.inputs) || !task.inputs.every((x) => typeof x === "string" && !x.includes("..") && !x.startsWith("/")) || !Array.isArray(task.checks) || !task.checks.length || !Array.isArray(task.expectedOutputs) || task.expectedOutputs.length || task.requireIndependentCheck || Array.isArray(task.experienceRefs) && task.experienceRefs.length > 0 || Array.isArray(task.knowledgeIds) && task.knowledgeIds.length > 0) throw new HarnessError("improvement.workflow-cases", "first workflow adapter permits one fixed reason/check task without extra authority");
		if (!Array.isArray(c.checks) || c.checks.length !== task.checks.length || !c.checks.every((x: unknown) => { const check = x as Record<string, unknown>; return check && typeof check.criterion === "string" && (task.checks as unknown[]).includes(check.criterion) && Array.isArray(check.contains) && check.contains.length > 0 && check.contains.length <= 8 && check.contains.every((v: unknown) => typeof v === "string" && v.length > 0 && v.length <= 300) && Array.isArray(check.forbids) && check.forbids.length <= 8 && check.forbids.every((v: unknown) => typeof v === "string" && v.length > 0 && v.length <= 300); })) throw new HarnessError("improvement.workflow-cases", "every fixed check needs executable literal conditions");
		if (split === "admission") {
			const instructions = JSON.stringify({ goal, task });
			if ((c.checks as WorkflowCheckV1[]).some((check) => [...check.contains, ...check.forbids].some((literal) => instructions.includes(literal)))) throw new HarnessError("improvement.workflow-cases", "protected check literals cannot be embedded in G instructions");
			if ((task.inputs as string[]).some((item) => item === "problem/problem.md" || item.startsWith("problem/raw/"))) throw new HarnessError("improvement.workflow-cases", "protected case inputs must stay outside common frozen problem material");
		}
	}
	return set as unknown as WorkflowCaseSetV1;
}

/** Validation belongs to the fixed parent. Only `visible` is ever passed to a selected source. */
export function validateWorkflowCaseV2(input: unknown): WorkflowCaseV2 {
	if (!input || typeof input !== "object" || Array.isArray(input)) throw new HarnessError("improvement.workflow-case-v2", "v2 case must be an object");
	const c = input as Record<string, unknown>;
	if (c.version !== 2 || Object.keys(c).sort().join(",") !== "evaluation,version,visible") throw new HarnessError("improvement.workflow-case-v2", "v2 case must separate visible input and parent evaluation");
	const visible = c.visible as Record<string, unknown> | undefined;
	const evaluation = c.evaluation as Record<string, unknown> | undefined;
	if (!visible || Object.keys(visible).sort().join(",") !== "goal,id,requiredEvidence,task" || !safeId(visible.id) ||
		!evaluation || Object.keys(evaluation).join(",") !== "groundTruth" || evaluation.groundTruth === undefined)
		throw new HarnessError("improvement.workflow-case-v2", "v2 visible input or private ground truth is incomplete");
	const goal = visible.goal as Record<string, unknown> | undefined;
	const task = visible.task as Record<string, unknown> | undefined;
	if (!goal || typeof goal.goal !== "string" || !goal.goal.trim() || typeof goal.problemRelation !== "string" || !goal.problemRelation.trim() ||
		typeof goal.plan !== "string" || !goal.plan.trim() || !Array.isArray(goal.constraints) || !goal.constraints.length ||
		!Array.isArray(goal.successCriteria) || !goal.successCriteria.length || Object.hasOwn(goal, "workflowMethodVersionId") ||
		!task || !["reason", "check"].includes(String(task.mode)) || typeof task.objective !== "string" || !task.objective.trim() ||
		!Array.isArray(task.inputs) || !task.inputs.every((x) => typeof x === "string" && x.length > 0 && !path.isAbsolute(x) && !x.includes("..")) ||
		!Array.isArray(task.expectedOutputs) || task.expectedOutputs.length || task.requireIndependentCheck ||
		!Array.isArray(task.checks) || task.checks.length !== 1 || task.checks[0] !== "M07 evidence report returned")
		throw new HarnessError("improvement.workflow-case-v2", "v2 task must carry original obligations with only the fixed mechanical review check");
	const required = visible.requiredEvidence;
	if (!Array.isArray(required) || required.length < 1 || required.length > 20 ||
		!required.every((x) => typeof x === "string" && x.length > 0 && x.length <= 240 && !path.isAbsolute(x) && !x.includes("..") && (task.inputs as string[]).includes(x)) ||
		new Set(required).size !== required.length || (task.inputs as string[]).length !== required.length)
		throw new HarnessError("improvement.workflow-case-v2", "required evidence must name distinct model-visible task inputs");
	return input as WorkflowCaseV2;
}
