import type { BudgetLimits } from "../experiments/contracts.ts";
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
export interface WorkflowEvidenceHandoffPlanV1 {
	version: 1;
	kind: "m07-evidence-handoff/v1";
	/** A completed real M07 checkpoint and the M04 run that processed it. */
	developmentSource: { m07RunId: string; checkpointId: string; m04RunId: string };
	developmentCaseSetPath: string;
	/** Omission leaves an inspectable research-only run. G is opened only after selection. */
	admissionCaseSetPath?: string;
	/** Must not exist and must be disjoint from the live workspace. Never cleaned automatically. */
	experimentRoot: string;
	maxDecisions: number;
	maxCandidates: number;
	maxInspectActions: number;
	maxReadbackChars: number;
	maxFeedbackItems: number;
	perPromptTimeoutMs: number;
	budget: BudgetLimits;
	/** At least two paired, fresh protected executions are needed for admission. */
	admissionRepetitions: number;
	/** Prior same-workspace development episodes. Protected results are excluded. */
	metaEpisodeRunIds?: string[];
}
export interface WorkflowArmReceiptV1 {
	caseId: string;
	arm: "baseline" | "candidate";
	methodVersionId: string;
	workspaceRoot: string;
	m07RunId?: string;
	m04RunId?: string;
	frozenReportPath?: string;
	reportDeliveredToM04?: boolean;
	feedbackStatus?: string;
	checkResults: Array<{ criterion: string; passed: boolean }>;
	usage: { providerCalls: number; inputTokens: number; outputTokens: number; sdkEstimatedCost: number; complete: boolean };
	status: "complete" | "inconclusive";
	reason?: string;
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
	outcome?: "completed-no-candidate" | "candidate-rejected" | "promoted" | "search-incomplete" | "provider-failed";
	baselineBundleId: string;
	baselineExecutorVersionId: string;
	improverVersionId: string;
	knowledgeSnapshot?: string;
	developmentSource: WorkflowEvidenceHandoffPlanV1["developmentSource"];
	decisions: Array<{ index: number; improverVersionId: string; sessionId?: string; action?: string; candidateVersionId?: string; outcome: string }>;
	candidates: Array<{ versionId: string; parentVersionId: string; producedByImproverVersionId: string; developmentStatus: "untested" | "supported" | "rejected" | "inconclusive"; hypothesis: unknown }>;
	developmentArms: WorkflowArmReceiptV1[];
	protectedArms: WorkflowArmReceiptV1[];
	selectedCandidateId?: string;
	promotedMethodVersionId?: string;
	selectionReceiptPath?: string;
	protectedOpenedAt?: string;
	stopReason?: string;
	budgetAtEnd?: unknown;
	developmentBudgetAtSelection?: unknown;
	metaEpisodeIds?: string[];
}

const safeId = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
function budget(value: unknown): value is BudgetLimits {
	if (!value || typeof value !== "object") return false;
	const b = value as Record<string, unknown>;
	return Object.keys(b).sort().join(",") === ["maxCpuMillis", "maxInputTokens", "maxOutputTokens", "maxProbeCalls", "maxProviderCalls", "maxSdkEstimatedCost", "maxWallMillis"].sort().join(",") &&
		["maxCpuMillis", "maxInputTokens", "maxOutputTokens", "maxProviderCalls", "maxWallMillis"].every((key) => Number.isSafeInteger(b[key]) && (b[key] as number) > 0) && b.maxProbeCalls === 0 &&
		typeof b.maxSdkEstimatedCost === "number" && Number.isFinite(b.maxSdkEstimatedCost) && b.maxSdkEstimatedCost > 0;
}
export function validateWorkflowPlan(input: unknown): WorkflowEvidenceHandoffPlanV1 {
	if (!input || typeof input !== "object" || Array.isArray(input)) throw new HarnessError("improvement.workflow-plan", "workflow plan must be an object");
	const p = input as Record<string, unknown>;
	const keys = ["version", "kind", "developmentSource", "developmentCaseSetPath", "admissionCaseSetPath", "experimentRoot", "maxDecisions", "maxCandidates", "maxInspectActions", "maxReadbackChars", "maxFeedbackItems", "perPromptTimeoutMs", "budget", "admissionRepetitions", "metaEpisodeRunIds"];
	if (Object.keys(p).some((key) => !keys.includes(key)) || p.version !== 1 || p.kind !== "m07-evidence-handoff/v1") throw new HarnessError("improvement.workflow-plan", "unsupported workflow plan");
	const src = p.developmentSource as Record<string, unknown> | undefined;
	if (!src || Object.keys(src).sort().join(",") !== "checkpointId,m04RunId,m07RunId" || !safeId(src.m07RunId) || !safeId(src.checkpointId) || !safeId(src.m04RunId)) throw new HarnessError("improvement.workflow-plan", "development source must pin one M07 checkpoint and its M04 run");
	for (const key of ["developmentCaseSetPath", "experimentRoot"] as const) if (typeof p[key] !== "string" || !p[key].trim() || p[key].length > 500) throw new HarnessError("improvement.workflow-plan", `${key} is required`);
	if (p.admissionCaseSetPath !== undefined && (typeof p.admissionCaseSetPath !== "string" || !p.admissionCaseSetPath.trim() || p.admissionCaseSetPath === p.developmentCaseSetPath)) throw new HarnessError("improvement.workflow-plan", "admission cases must be a distinct path");
	for (const [key, min, max] of [["maxDecisions", 1, 30], ["maxCandidates", 1, 10], ["maxInspectActions", 0, 30], ["maxReadbackChars", 0, 40_000], ["maxFeedbackItems", 1, 24], ["perPromptTimeoutMs", 100, 300_000], ["admissionRepetitions", 2, 10]] as const)
		if (!Number.isSafeInteger(p[key]) || (p[key] as number) < min || (p[key] as number) > max) throw new HarnessError("improvement.workflow-plan", `${key} must be ${min}–${max}`);
	if ((p.admissionRepetitions as number) % 2 !== 0 || !budget(p.budget)) throw new HarnessError("improvement.workflow-plan", "even paired repetitions and a closed budget are required");
	if (p.metaEpisodeRunIds !== undefined && (!Array.isArray(p.metaEpisodeRunIds) || p.metaEpisodeRunIds.length > 4 || !p.metaEpisodeRunIds.every(safeId) || new Set(p.metaEpisodeRunIds).size !== p.metaEpisodeRunIds.length)) throw new HarnessError("improvement.workflow-plan", "prior workflow episodes must be at most four distinct run IDs");
	return p as unknown as WorkflowEvidenceHandoffPlanV1;
}
export function validateWorkflowCaseSet(input: unknown, split: WorkflowCaseSetV1["split"]): WorkflowCaseSetV1 {
	if (!input || typeof input !== "object" || Array.isArray(input)) throw new HarnessError("improvement.workflow-cases", "case set must be an object");
	const set = input as Record<string, unknown>;
	if (Object.keys(set).sort().join(",") !== "cases,split,version" || set.version !== 1 || set.split !== split || !Array.isArray(set.cases) || set.cases.length < 1 || set.cases.length > 4) throw new HarnessError("improvement.workflow-cases", "invalid frozen case set");
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
