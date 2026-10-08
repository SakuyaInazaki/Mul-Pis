import { createHash, randomUUID } from "node:crypto";
import { copyFile, lstat, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { openBoundedSession, type EvidenceBindingV1 } from "../context/boundary.ts";
import type { SessionRunner, SessionSpec } from "../runner/types.ts";
import type { DeepSeekRequestViolation } from "../runner/deepseek-request-contract.ts";
import { workflowRepairFingerprint, workflowRepairState, type WorkflowRepairFailure,
	type WorkflowRepairStateV1 } from "../runner/repair-liveness.ts";
import type { StageRunRecord } from "../types.ts";
import { HarnessError } from "../types.ts";
import { mergeGroundedAssessmentDelta, validateGroundedAssessment, validatePriorGroundingIndex,
	isGroundedIssueId,
	GroundingSpanError, GroundingFieldError,
	type GroundedAssessmentDelta, type GroundedAssessmentProposal,
	type GroundedIssue, type GroundingContext, type GroundingSourceKind,
	type GroundingSpan } from "./assessor-grounding.ts";

const MAX_EVIDENCE_BYTES = 1_000_000;
const safeAdapterId = (value: unknown): value is string => typeof value === "string" && /^[a-z][a-z0-9._/-]{0,95}$/.test(value);
const safeName = (value: string) => /^[A-Za-z][A-Za-z0-9._-]{0,79}$/.test(value);
const safeInputName = (value: string) => /^[A-Za-z0-9][A-Za-z0-9 ._()-]{0,119}$/.test(value);
const nonemptyText = (value: unknown): value is string =>
		typeof value === "string" && value.trim().length > 0 && !value.includes("\0");

/** The caller's original mission is separate from any finite M07 child goal. */
export interface OriginalObjectiveContractV1 {
	version: 1;
	kind: "original-objective";
	id: string;
	createdAt: string;
	goal: string;
	goalSource: "verbatim-private-input" | "user-intent-summary";
	inputNames: string[];
	/** User directions override conflicting requirements in supplied task material. */
	userOverrides?: string[];
	obligations: Array<{ id: string; description: string }>;
	/** Open-ended strongest-attainable work cannot be closed by a finite evaluation's checks. */
	closure: "open-ended" | "finite-evidence";
}

export interface ObjectiveNextTaskV1 {
	objective: string;
	addresses: string[];
	/** Opaque caller-registered capability ID. Legacy serialized adapter IDs remain readable. */
	adapterScope: string;
}

export interface ObjectiveCapabilityV1 {
	scope: ObjectiveNextTaskV1["adapterScope"];
	available: boolean;
	description: string;
	limits: string[];
}

export interface ModelObjectiveAssessmentV1 {
	version: 1;
	decision: "fulfilled" | "continue" | "blocked";
	rationale: string;
	evidenceRefs: string[];
	unresolvedObligations: string[];
	/** Model-authored open issues from the full original assignment, never a host-chosen strategy list. */
	unresolvedDetails: string[];
	nextTask?: ObjectiveNextTaskV1;
	/** New source-grounded proposal. Historical assessments remain readable without it. */
	groundedAssessment?: GroundedAssessmentProposal;
	/** Index-mode change record; authenticated prior records are host-merged. */
	groundedAssessmentDelta?: GroundedAssessmentDelta;
}

/** Decoded old checkpoints may contain these retired quota reasons. New execution never emits them. */
export type HistoricalObjectiveStopReason = "budget-boundary" | "provider-call-limit" |
	"time-boundary" | "no-progress" | "capability-replan-stalled";
export type CurrentObjectiveStopReason = "accounting-integrity-error" |
	"cancelled" | "output-limit" | "assessment-failed" |
	"assessment-invalid" | "assessment-evidence-unread" | "assessment-evidence-suspended" | "model-reported-blocked" | "model-closure-unverified" |
	"original-checks-unverified" | "assessment-validation-pending" | "next-task-pending" | "next-task-needs-capability" |
	"objective-reassessment-pending" | "dispatch-failed" |
	"request-contract-invalid" | "workflow-repair-needed" |
	"execution-interrupted" |
	"artifact-capacity-boundary" | "m04-evidence-incomplete" | "m04-draft-rejected" |
	"m04-transaction-unresolved" | "bounded-run-incomplete";
export type ObjectiveStopReason = CurrentObjectiveStopReason | HistoricalObjectiveStopReason;
const historicalObjectiveStopReasons: readonly HistoricalObjectiveStopReason[] = [
	"budget-boundary", "provider-call-limit", "time-boundary", "no-progress",
	"capability-replan-stalled",
];

/** A host plan for the next safe boundary. It is not an assessor verdict or proof of completion. */
export type PendingActionKindV1 = "retry-readonly-assessment" | "retry-evidence-read" |
	"fresh-m07-task" | "repair-rejected-m04" | "repair-request-contract" | "reconcile-m07-operation" |
	"reconcile-m04-transaction" | "restore-evidence" | "retry-transport" |
	"reconcile-interrupted-run" |
	"refresh-auth" | "supply-capability" | "repair-workflow-state";
export type PendingActionSafetyV1 = "same-session-read-only" | "fresh-work-only" |
	"no-replay-until-reconciled";

/** Only an independent host check may mark an action as requiring the user. */
export interface VerifiedHumanBlockerV1 {
	kind: "credential-unavailable" | "input-unavailable" | "permission-unavailable" | "capability-unavailable";
	verifiedBy: "host";
	/** A host-owned observation or file reference, never the model's rationale. */
	evidenceRef: string;
	/** The host checked that no authorized automatic route supplies this requirement. */
	exclusiveRequiredAction: true;
}

export interface PendingActionV1 {
	version: 1;
	author: "host";
	kind: PendingActionKindV1;
	safety: PendingActionSafetyV1;
	reasonCode: CurrentObjectiveStopReason;
	target?: { goalRunId?: string; taskId?: string; operationRefs?: string[] };
	evidenceRefs?: string[];
	/** Observed host stage and transport failure; no provider message or prompt. */
	failedStage?: "read-only-assessor" | "objective-assessment" | "m04-judgment" | "m07-execution";
	transportFailure?: true;
	requestContract?: { violation: DeepSeekRequestViolation; messageIndex: number | null };
	/** Optional provenance when the host has authenticated the prior carry. */
	source?: { kind: "authenticated-prior-carry"; runId: string; runAttempt: number;
		commit: string; envelopeSha256: string };
	humanRequired?: true;
	verifiedHumanBlocker?: VerifiedHumanBlockerV1;
}

export interface HostPendingActionFactsV1 {
	/** Host-censused external operations; a model citation is insufficient. */
	unresolvedOperationRefs?: string[];
	/** Host-verified M04 transaction uncertainty has priority over new work. */
	m04TransactionUnresolved?: boolean;
	/** Host-owned IDs, not a model-proposed task description. */
	target?: PendingActionV1["target"];
	evidenceRefs?: string[];
	source?: PendingActionV1["source"];
	/** A currently live read-only assessor can repair in the same session. */
	liveReadOnlySession?: boolean;
	/** Host-captured provider transport failure, never an inferred model complaint. */
	transportFailure?: boolean;
	requestContract?: PendingActionV1["requestContract"];
	failedStage?: PendingActionV1["failedStage"];
	verifiedHumanBlocker?: VerifiedHumanBlockerV1;
}

const safeControlRef = (value: unknown): value is string => nonemptyText(value) &&
	!/[\r\n]/.test(value);
const exactControlFields = (value: unknown, allowed: readonly string[]): boolean =>
	Boolean(value) && typeof value === "object" && !Array.isArray(value) &&
	Object.getPrototypeOf(value) === Object.prototype &&
	Object.entries(value as Record<string, unknown>).every(([name, part]) => allowed.includes(name) && part !== undefined);
const safeControlRefs = (value: unknown): value is string[] => Array.isArray(value) &&
	value.every(safeControlRef) && new Set(value).size === value.length;
const pendingKinds: PendingActionKindV1[] = ["retry-readonly-assessment", "retry-evidence-read",
	"fresh-m07-task", "repair-rejected-m04", "repair-request-contract",
	"reconcile-m07-operation", "reconcile-m04-transaction",
	"reconcile-interrupted-run",
	"restore-evidence", "retry-transport", "refresh-auth", "supply-capability", "repair-workflow-state"];
const pendingSafeties: PendingActionSafetyV1[] = ["same-session-read-only", "fresh-work-only",
	"no-replay-until-reconciled"];
const objectiveStopReasons: CurrentObjectiveStopReason[] = [
	"accounting-integrity-error", "cancelled", "output-limit", "assessment-failed",
	"assessment-invalid", "assessment-evidence-unread", "assessment-evidence-suspended", "model-reported-blocked",
	"model-closure-unverified", "original-checks-unverified", "assessment-validation-pending",
	"next-task-pending", "next-task-needs-capability", "objective-reassessment-pending", "dispatch-failed",
	"request-contract-invalid", "workflow-repair-needed",
	"execution-interrupted",
	"artifact-capacity-boundary", "m04-evidence-incomplete",
	"m04-draft-rejected", "m04-transaction-unresolved", "bounded-run-incomplete"];
export const isCurrentObjectiveStopReason = (value: unknown): value is CurrentObjectiveStopReason =>
	typeof value === "string" && objectiveStopReasons.some(reason => reason === value);
const requestViolations: ReadonlySet<string> = new Set(["request-shape", "message-shape",
	"tool-call-shape", "duplicate-tool-call", "orphan-tool-result", "duplicate-tool-result",
	"incomplete-tool-results", "thinking-tool-choice", "missing-reasoning",
	"unsigned-reasoning", "reasoning-replay-mismatch"]);
function currentObjectiveAdmission(raw: unknown): "admitted" | CurrentObjectiveStopReason {
	if (raw === "admitted" || historicalObjectiveStopReasons.some(reason => reason === raw))
		return "admitted";
	if (isCurrentObjectiveStopReason(raw)) return raw;
	throw new HarnessError("m07.objective", "live objective admission returned an invalid host boundary");
}
/** Classify host observations without consulting model verdict text or draft issues. */
export function classifyPendingAction(stopReason: CurrentObjectiveStopReason,
	hostFacts: HostPendingActionFactsV1 = {}): PendingActionV1 {
	if (!objectiveStopReasons.includes(stopReason))
		throw new HarnessError("m07.objective", "pending action stop reason is invalid");
	if (hostFacts.unresolvedOperationRefs !== undefined && !safeControlRefs(hostFacts.unresolvedOperationRefs))
		throw new HarnessError("m07.objective", "pending action operation references are invalid");
	if (hostFacts.evidenceRefs !== undefined && !safeControlRefs(hostFacts.evidenceRefs))
		throw new HarnessError("m07.objective", "pending action evidence references are invalid");
	if (hostFacts.failedStage !== undefined &&
		!(["read-only-assessor", "objective-assessment", "m04-judgment", "m07-execution"] as const)
			.includes(hostFacts.failedStage))
		throw new HarnessError("m07.objective", "pending action failed stage is invalid");
	if (hostFacts.transportFailure !== undefined && typeof hostFacts.transportFailure !== "boolean")
		throw new HarnessError("m07.objective", "pending action transport fact is invalid");
	const requestContract = hostFacts.requestContract;
	if ((requestContract !== undefined && (!exactControlFields(requestContract, ["violation", "messageIndex"]) ||
		!requestViolations.has(requestContract.violation) ||
		(requestContract.messageIndex !== null &&
			(!Number.isSafeInteger(requestContract.messageIndex) || requestContract.messageIndex < 0)))) ||
		(stopReason === "request-contract-invalid") !== Boolean(requestContract))
		throw new HarnessError("m07.objective", "request contract repair lacks a static host violation");
	const target = hostFacts.target;
	if (target && (!exactControlFields(target, ["goalRunId", "taskId", "operationRefs"]) ||
		(target.goalRunId !== undefined && !safeControlRef(target.goalRunId)) ||
		(target.taskId !== undefined && !safeControlRef(target.taskId)) ||
		(target.operationRefs !== undefined && !safeControlRefs(target.operationRefs)) ||
		(target.goalRunId === undefined && target.taskId === undefined && !target.operationRefs?.length)))
		throw new HarnessError("m07.objective", "pending action target is invalid");
	const source = hostFacts.source;
	if (source && (!exactControlFields(source, ["kind", "runId", "runAttempt", "commit", "envelopeSha256"]) ||
		source.kind !== "authenticated-prior-carry" || !safeControlRef(source.runId) ||
		!Number.isSafeInteger(source.runAttempt) || source.runAttempt < 1 ||
		!/^[0-9a-f]{40}$/.test(source.commit) || !/^[0-9a-f]{64}$/.test(source.envelopeSha256)))
		throw new HarnessError("m07.objective", "pending action source is invalid");
	const human = hostFacts.verifiedHumanBlocker;
	if (human && (!exactControlFields(human, ["kind", "verifiedBy", "evidenceRef", "exclusiveRequiredAction"]) ||
		human.verifiedBy !== "host" || human.exclusiveRequiredAction !== true ||
		!["credential-unavailable", "input-unavailable", "permission-unavailable", "capability-unavailable"].includes(human.kind) ||
		!safeControlRef(human.evidenceRef)))
		throw new HarnessError("m07.objective", "pending action human blocker lacks host verification");
	let kind: PendingActionKindV1;
	let safety: PendingActionSafetyV1 = "fresh-work-only";
	if (stopReason === "execution-interrupted") {
		kind = "reconcile-interrupted-run";
		safety = "no-replay-until-reconciled";
	} else if (hostFacts.m04TransactionUnresolved || stopReason === "m04-transaction-unresolved") {
		kind = "reconcile-m04-transaction";
		safety = "no-replay-until-reconciled";
	} else if (hostFacts.unresolvedOperationRefs?.length) {
		kind = "reconcile-m07-operation";
		safety = "no-replay-until-reconciled";
	} else if (stopReason === "accounting-integrity-error") {
		kind = "retry-transport";
		safety = "no-replay-until-reconciled";
	} else if (stopReason === "workflow-repair-needed") {
		kind = "repair-workflow-state";
	} else if (human) {
		kind = human.kind === "credential-unavailable" ? "refresh-auth" :
			human.kind === "input-unavailable" ? "restore-evidence" : "supply-capability";
	} else if (stopReason === "m04-draft-rejected") {
		kind = "repair-rejected-m04";
	} else if (stopReason === "request-contract-invalid") {
		kind = "repair-request-contract";
	} else if (stopReason === "assessment-evidence-suspended") {
		kind = "restore-evidence";
	} else if (stopReason === "assessment-evidence-unread" || stopReason === "m04-evidence-incomplete") {
		kind = "retry-evidence-read";
	} else if (stopReason === "output-limit") {
		kind = "retry-transport";
	} else if (hostFacts.transportFailure) {
		kind = "retry-transport";
	} else if (stopReason === "next-task-needs-capability") {
		kind = "supply-capability";
	} else if (stopReason === "dispatch-failed" && hostFacts.failedStage === "m07-execution" ||
		stopReason === "bounded-run-incomplete" || stopReason === "next-task-pending") {
		kind = "fresh-m07-task";
	} else {
		kind = "retry-readonly-assessment";
	}
	if (hostFacts.liveReadOnlySession && (kind === "retry-readonly-assessment" || kind === "retry-evidence-read"))
		safety = "same-session-read-only";
	const effectiveTarget = hostFacts.unresolvedOperationRefs?.length ?
		{ ...target, operationRefs: [...hostFacts.unresolvedOperationRefs] } : target;
	return { version: 1, author: "host", kind, safety, reasonCode: stopReason,
		...(effectiveTarget ? { target: { ...effectiveTarget } } : {}),
		...(hostFacts.evidenceRefs?.length ? { evidenceRefs: [...hostFacts.evidenceRefs] } : {}),
		...(hostFacts.failedStage ? { failedStage: hostFacts.failedStage } : {}),
		...(hostFacts.transportFailure ? { transportFailure: true as const } : {}),
		...(requestContract ? { requestContract: { ...requestContract } } : {}),
		...(source ? { source: { ...source } } : {}),
		...(human && safety !== "no-replay-until-reconciled" && stopReason !== "workflow-repair-needed" ?
			{ humanRequired: true as const, verifiedHumanBlocker: { ...human } } : {}) };
}

/** Validate a carried host action without treating its model-facing text as host authority. */
export function validatePendingAction(action: PendingActionV1, stopReason: ObjectiveStopReason | null): void {
	if (!exactControlFields(action, ["version", "author", "kind", "safety", "reasonCode",
		"target", "evidenceRefs", "failedStage", "transportFailure", "requestContract",
		"source", "humanRequired", "verifiedHumanBlocker"]) || stopReason === null ||
		action.version !== 1 || action.author !== "host" || action.reasonCode !== stopReason ||
		!objectiveStopReasons.some(reason => reason === stopReason) ||
		!pendingKinds.includes(action.kind) || !pendingSafeties.includes(action.safety))
		throw new HarnessError("m07.objective", "pending action does not match the host checkpoint boundary");
	// Reuse the host classifier's structural checks for refs and optional carry provenance.
	classifyPendingAction(stopReason, { target: action.target, evidenceRefs: action.evidenceRefs,
		source: action.source, verifiedHumanBlocker: action.verifiedHumanBlocker,
		failedStage: action.failedStage, transportFailure: action.transportFailure,
		requestContract: action.requestContract });
	const reconciles = action.kind === "reconcile-m07-operation" || action.kind === "reconcile-m04-transaction" ||
		action.kind === "reconcile-interrupted-run" ||
		(stopReason === "accounting-integrity-error" && action.kind === "retry-transport");
	const sameSession = action.kind === "retry-readonly-assessment" || action.kind === "retry-evidence-read";
	const humanKind = action.verifiedHumanBlocker?.kind === "credential-unavailable" ? "refresh-auth" :
		action.verifiedHumanBlocker?.kind === "input-unavailable" ? "restore-evidence" : "supply-capability";
	if ((reconciles !== (action.safety === "no-replay-until-reconciled")) ||
		(action.safety === "same-session-read-only" && !sameSession) ||
		(stopReason === "m04-transaction-unresolved" && action.kind !== "reconcile-m04-transaction") ||
		(action.humanRequired !== undefined && action.humanRequired !== true) ||
		(Boolean(action.humanRequired) !== Boolean(action.verifiedHumanBlocker)) ||
		(action.humanRequired && (action.kind !== humanKind || action.safety !== "fresh-work-only")))
		throw new HarnessError("m07.objective", "pending action safety or human gate is inconsistent");
	const operationRefs = action.target?.operationRefs ?? [];
	if ((operationRefs.length > 0 && action.kind !== "reconcile-m07-operation" &&
		 action.kind !== "reconcile-m04-transaction" && action.kind !== "reconcile-interrupted-run") ||
		(action.kind === "reconcile-m07-operation" && operationRefs.length === 0) ||
		(action.kind === "reconcile-m04-transaction" && stopReason !== "m04-transaction-unresolved") ||
		(action.kind === "reconcile-interrupted-run" && stopReason !== "execution-interrupted"))
		throw new HarnessError("m07.objective", "pending action cannot relabel unresolved effects");
	const requiredRepairKind: Partial<Record<CurrentObjectiveStopReason, PendingActionKindV1>> = {
		"assessment-evidence-unread": "retry-evidence-read",
		"assessment-evidence-suspended": "restore-evidence",
		"m04-evidence-incomplete": "retry-evidence-read",
		"m04-draft-rejected": "repair-rejected-m04",
		"request-contract-invalid": "repair-request-contract",
		"workflow-repair-needed": "repair-workflow-state",
		"execution-interrupted": "reconcile-interrupted-run",
		"model-reported-blocked": "retry-readonly-assessment",
		"model-closure-unverified": "retry-readonly-assessment",
		"original-checks-unverified": "retry-readonly-assessment",
		"assessment-invalid": "retry-readonly-assessment",
		"next-task-needs-capability": "supply-capability",
		"output-limit": "retry-transport",
	};
	const required = requiredRepairKind[stopReason];
	if ((action.kind === "repair-workflow-state" && stopReason !== "workflow-repair-needed") ||
		(stopReason === "workflow-repair-needed" && (action.humanRequired || action.verifiedHumanBlocker)))
		throw new HarnessError("m07.objective", "workflow repair cannot become a human gate or unrelated stage repair");
	if (required && !operationRefs.length && !action.verifiedHumanBlocker && action.kind !== required)
		throw new HarnessError("m07.objective", "pending action does not preserve the required stage repair");
	if (!operationRefs.length && !action.verifiedHumanBlocker &&
		(stopReason === "dispatch-failed" || stopReason === "assessment-failed")) {
		const expected = action.transportFailure ? "retry-transport" :
			stopReason === "dispatch-failed" && action.failedStage === "m07-execution" ?
				"fresh-m07-task" : "retry-readonly-assessment";
		if (action.kind !== expected)
			throw new HarnessError("m07.objective", "pending action does not match the observed failed stage");
	}
}

export interface ObjectiveProgressV1 {
	version: 1;
	kind: "original-objective-progress";
	contract: OriginalObjectiveContractV1;
	objectiveOutcome: "incomplete" | "fulfilled";
	stopReason: ObjectiveStopReason | null;
	assessment?: ModelObjectiveAssessmentV1 & { sessionId: string; model: string; evidenceRead: string[];
		unreadEvidence: string[]; proposalHistory?: ModelObjectiveAssessmentV1[];
		blockedProposals?: ObjectiveNextTaskV1[] };
	assessmentHistory: Array<{ iteration: number; assessment: NonNullable<ObjectiveProgressV1["assessment"]>;
		stopReason: ObjectiveStopReason; advanced: boolean }>;
	boundedRuns: Array<{ runId: string; outcome: string; selectedTaskId?: string;
		acceptedTaskIds?: string[]; unresolvedOperationIds?: string[] }>;
	selectedArtifacts: string[];
	availableArtifacts: string[];
	continuation: { mode: "explicit-authorized-new-run" | "reconcile-operations-before-new-run";
		unresolvedOperationIds: string[]; unresolvedObligations: string[];
		unresolvedDetails: string[];
		blockedProposals?: ObjectiveNextTaskV1[];
		nextTask?: ObjectiveNextTaskV1; requiresOriginalInputs: true; requiresBudgetAdmission: true;
		requiresOperationReconciliation: boolean; pendingAction?: PendingActionV1 };
}

/** Reassess the unchanged original goal after every bounded child until an actual stop boundary. */
export async function runOriginalObjectiveLoop(input: {
	admission: () => "admitted" | CurrentObjectiveStopReason;
	step: (iteration: number) => Promise<{ advanced: boolean; stopReason: CurrentObjectiveStopReason; evidenceRefs?: string[] }>;
}): Promise<{ stopReason: CurrentObjectiveStopReason; steps: Array<{ iteration: number; advanced: boolean;
	stopReason: CurrentObjectiveStopReason; evidenceRefs: string[] }> }> {
	const steps: Array<{ iteration: number; advanced: boolean; stopReason: CurrentObjectiveStopReason; evidenceRefs: string[] }> = [];
	for (let iteration = 1; ; iteration++) {
		if (!Number.isSafeInteger(iteration)) throw new HarnessError("m07.objective", "objective iteration identity overflow");
		const admission = currentObjectiveAdmission(input.admission());
		if (admission !== "admitted") return { stopReason: admission, steps };
		const result = await input.step(iteration);
		if (!isCurrentObjectiveStopReason(result.stopReason))
			throw new HarnessError("m07.objective", "live objective step returned a retired quota boundary");
		steps.push({ iteration, advanced: result.advanced, stopReason: result.stopReason,
			evidenceRefs: [...(result.evidenceRefs ?? [])] });
		if (!result.advanced || result.stopReason !== "objective-reassessment-pending")
			return { stopReason: result.stopReason, steps };
	}
}

export function createOriginalObjective(input: {
	goal: string; goalSource: OriginalObjectiveContractV1["goalSource"]; inputNames: string[];
	userOverrides?: string[];
	obligations: Array<{ id: string; description: string }>; closure: OriginalObjectiveContractV1["closure"];
}): OriginalObjectiveContractV1 {
	if (!nonemptyText(input.goal) || !Array.isArray(input.inputNames) || !input.inputNames.length ||
		input.inputNames.some(name => !safeInputName(name)) ||
		new Set(input.inputNames).size !== input.inputNames.length ||
		!Array.isArray(input.obligations) || !input.obligations.length ||
		input.obligations.some(item => !safeName(item.id) || !nonemptyText(item.description)) ||
		new Set(input.obligations.map(item => item.id)).size !== input.obligations.length ||
		!["verbatim-private-input", "user-intent-summary"].includes(input.goalSource) ||
		!["open-ended", "finite-evidence"].includes(input.closure) ||
		!Array.isArray(input.userOverrides ?? []) ||
		(input.userOverrides ?? []).some(item => !nonemptyText(item)))
		throw new HarnessError("m07.objective", "original objective contract is invalid");
	return { version: 1, kind: "original-objective", id: randomUUID(), createdAt: new Date().toISOString(),
		goal: input.goal, goalSource: input.goalSource, inputNames: [...input.inputNames],
		...(input.userOverrides ? { userOverrides: [...input.userOverrides] } : {}),
		obligations: input.obligations.map(item => ({ ...item })), closure: input.closure };
}

class AssessmentValidationError extends HarnessError {
	readonly validationPath: string;
	readonly validationDetail: string | null;
	constructor(message: string, validationPath: string, validationDetail: string | null = null) {
		super("m07.objective-assessment", message);
		this.validationPath = validationPath;
		this.validationDetail = validationDetail;
	}
}
/** Private callback payload. The driver encrypts it with the existing result transport.
 * It cannot authorize a model task, read credit, or scientific selection. */
export type ObjectiveAssessmentValidationDiagnosticV1 = Readonly<{
	sessionId: string;
	generation: number;
	attempt: number;
	rawResponse: string;
		validation: Readonly<{ code: "m07.objective-assessment" | "m07.objective-control"; message: string;
		path: string; detail?: string }>;
	coverage: readonly Readonly<{ sourceId: string; required: boolean;
		coveredRanges: readonly [number, number][]; complete: boolean }>[];
	transcriptPath?: string;
}>;
/** Host-only boundary for an exception before a usable assessor reply exists. */
export type ObjectiveAssessmentExceptionStage = "input-validation" | "contract-read" |
	"evidence-scan" | "source-registry" | "frozen-copy" | "prior-index" |
	"session-create" | "prompt";
function assessmentFailure(message: string, path: string, detail: string | null = null): never {
	throw new AssessmentValidationError(message, path, detail);
}
function fixedGroundingDetail(error: unknown): string | null {
	const message = error instanceof Error ? error.message : "";
	if (!/^assessor-grounding: [A-Za-z0-9 ,;._-]{1,160}$/.test(message)) return null;
	if (message === "assessor-grounding: deliverable readiness is only a proposed finding")
		return "deliverableReady must be an optional object with status proposed, ready boolean, rationale, span evidenceRefs and all remaining open issue IDs; a bare boolean is invalid";
	if (message === "assessor-grounding: next task must address an open grounded issue")
		return "grounded nextTask addresses must be OPEN issue IDs; obligationIds are original obligation IDs";
	return message;
}
function deltaValidationPath(detail: string | null): string {
	if (!detail) return "$.groundedAssessmentDelta";
	if (/(?:prior issue resolution|authenticated prior issue locator|newly resolved issue)/.test(detail))
		return "$.groundedAssessmentDelta.resolutions";
	if (/(?:next task|nextTask|open grounded issue)/.test(detail))
		return "$.groundedAssessmentDelta.nextTask";
	if (/(?:new issue|grounded issue|explicit requirement|necessary verification|optional method|physical gap|issue classification)/.test(detail))
		return "$.groundedAssessmentDelta.newIssues";
	if (/(?:deliverable|finding)/.test(detail))
		return "$.groundedAssessmentDelta.deliverableReady";
	return "$.groundedAssessmentDelta";
}
function parseAssessment(text: string, contract: OriginalObjectiveContractV1, evidenceNames: string[],
	grounding?: GroundingContext, priorGroundingIndex = false): ModelObjectiveAssessmentV1 {
	let value: unknown;
	try { value = JSON.parse(text); } catch { assessmentFailure("assessment is not strict JSON", "$"); }
	if (!value || typeof value !== "object" || Array.isArray(value)) assessmentFailure("assessment object is invalid", "$");
	let raw = value as Record<string, unknown>;
	let groundedAssessmentDelta: GroundedAssessmentDelta | undefined;
	if (priorGroundingIndex) {
		if (!grounding || raw.groundedAssessment !== undefined)
			assessmentFailure("prior grounding delta is invalid", "$.groundedAssessment");
		const delta = raw.groundedAssessmentDelta;
		if (!delta || typeof delta !== "object" || Array.isArray(delta))
			assessmentFailure("prior grounding delta is invalid", "$.groundedAssessmentDelta");
		const fields = delta as Record<string, unknown>;
		if (fields.version !== 1) assessmentFailure("prior grounding delta is invalid", "$.groundedAssessmentDelta.version");
		if (fields.kind !== "grounded-assessment-delta")
			assessmentFailure("prior grounding delta is invalid", "$.groundedAssessmentDelta.kind");
		if (!Array.isArray(fields.newIssues))
			assessmentFailure("prior grounding delta is invalid", "$.groundedAssessmentDelta.newIssues");
		if (!Array.isArray(fields.resolutions))
			assessmentFailure("prior grounding delta is invalid", "$.groundedAssessmentDelta.resolutions");
		let merged: ReturnType<typeof mergeGroundedAssessmentDelta>;
		try {
			merged = mergeGroundedAssessmentDelta(raw.groundedAssessmentDelta, grounding);
		} catch (error) {
			if (error instanceof GroundingSpanError || error instanceof GroundingFieldError)
				assessmentFailure("prior grounding delta is invalid", error.pointer, error.safeDetail);
			const detail = fixedGroundingDetail(error);
			assessmentFailure("prior grounding delta is invalid", deltaValidationPath(detail), detail);
		}
		groundedAssessmentDelta = merged.delta;
		const openClaims = merged.proposal.issues.filter(item => item.status === "open").map(item => item.claim);
		if (raw.unresolvedDetails !== undefined && JSON.stringify(raw.unresolvedDetails) !== JSON.stringify(openClaims))
			assessmentFailure("prior grounding delta is invalid", "$.unresolvedDetails", "open claim mismatch");
		raw = { ...raw, unresolvedDetails: openClaims, groundedAssessment: merged.proposal };
	}
	const ids = new Set(contract.obligations.map(item => item.id));
	const names = new Set(evidenceNames);
	const strings = (item: unknown, allowed: Set<string>): item is string[] =>
		Array.isArray(item) && item.every(part => typeof part === "string" && allowed.has(part)) && new Set(item).size === item.length;
	const details = (item: unknown): item is string[] => Array.isArray(item) &&
		item.every(part => nonemptyText(part)) && new Set(item).size === item.length;
	if (raw.version !== 1) assessmentFailure("assessment fields are invalid", "$.version");
	if (typeof raw.decision !== "string" || !["fulfilled", "continue", "blocked"].includes(raw.decision))
		assessmentFailure("assessment fields are invalid", "$.decision");
	if (!nonemptyText(raw.rationale)) assessmentFailure("assessment fields are invalid", "$.rationale");
	if (!strings(raw.evidenceRefs, names)) assessmentFailure("assessment fields are invalid", "$.evidenceRefs",
		"Top-level evidenceRefs must be unique exact frozen file name strings; grounded citation fields use span objects");
	if (!strings(raw.unresolvedObligations, ids)) assessmentFailure("assessment fields are invalid", "$.unresolvedObligations");
	if (!details(raw.unresolvedDetails)) assessmentFailure("assessment fields are invalid", "$.unresolvedDetails");
	const decision = raw.decision as ModelObjectiveAssessmentV1["decision"];
	let groundedAssessment: GroundedAssessmentProposal | undefined;
	if (grounding) {
		try { groundedAssessment = validateGroundedAssessment(raw.groundedAssessment, grounding); }
		catch (error) {
			if (error instanceof GroundingSpanError || error instanceof GroundingFieldError)
				assessmentFailure("grounded assessment is invalid", error.pointer, error.safeDetail);
			assessmentFailure("grounded assessment is invalid", "$.groundedAssessment",
				fixedGroundingDetail(error));
		}
		const claims = groundedAssessment.issues.filter(item => item.status === "open").map(item => item.claim);
		if (JSON.stringify(claims) !== JSON.stringify(raw.unresolvedDetails))
			assessmentFailure("grounded issues do not match unresolved details", "$.unresolvedDetails");
	}
	let nextTask: ObjectiveNextTaskV1 | undefined;
	if (groundedAssessment) {
		const groundedTask = groundedAssessment.nextTask;
		if (raw.nextTask !== undefined) {
			if (!groundedTask || !raw.nextTask || typeof raw.nextTask !== "object" ||
				Array.isArray(raw.nextTask))
				assessmentFailure("legacy next task has no matching grounded task", "$.nextTask");
			const mirror = raw.nextTask as Record<string, unknown>;
			if (Object.keys(mirror).some(key => !["objective", "addresses", "adapterScope"].includes(key)))
				assessmentFailure("legacy next task contains unsupported fields", "$.nextTask");
			if (mirror.objective !== groundedTask.objective)
				assessmentFailure("legacy next task objective conflicts with grounded task", "$.nextTask.objective",
					"Top-level nextTask is a legacy mirror; its objective must equal grounded nextTask.objective");
			if (mirror.addresses !== undefined &&
				JSON.stringify(mirror.addresses) !== JSON.stringify(groundedTask.obligationIds))
				assessmentFailure("legacy next task addresses conflict with grounded task", "$.nextTask.addresses",
					"Top-level addresses, when supplied, must equal grounded nextTask.obligationIds; grounded nextTask.addresses are open issue IDs");
			if (mirror.adapterScope !== undefined && mirror.adapterScope !== groundedTask.adapterScope)
				assessmentFailure("legacy next task scope conflicts with grounded task", "$.nextTask.adapterScope");
		}
		if (groundedTask) {
			if (!strings(groundedTask.obligationIds, ids) || !groundedTask.obligationIds.length ||
				groundedTask.obligationIds.some(item => !(raw.unresolvedObligations as string[]).includes(item)))
				assessmentFailure("next task does not address unresolved original obligations",
					priorGroundingIndex ? "$.groundedAssessmentDelta.nextTask.obligationIds" :
						"$.groundedAssessment.nextTask.obligationIds");
			nextTask = { objective: groundedTask.objective,
				addresses: [...groundedTask.obligationIds], adapterScope: groundedTask.adapterScope };
		}
	} else if (raw.nextTask !== undefined) {
		if (!raw.nextTask || typeof raw.nextTask !== "object" || Array.isArray(raw.nextTask))
			assessmentFailure("next task object is invalid", "$.nextTask");
		const task = raw.nextTask as Record<string, unknown>;
		if (!nonemptyText(task.objective))
			assessmentFailure("next task does not address unresolved original obligations", "$.nextTask.objective");
			if (!strings(task.addresses, ids) || !task.addresses.length ||
				task.addresses.some(item => !(raw.unresolvedObligations as string[]).includes(item)))
				assessmentFailure("next task does not address unresolved original obligations", "$.nextTask.addresses");
			if (!safeAdapterId(task.adapterScope))
				assessmentFailure("next task does not address unresolved original obligations", "$.nextTask.adapterScope");
			nextTask = { objective: task.objective, addresses: task.addresses,
				adapterScope: task.adapterScope as ObjectiveNextTaskV1["adapterScope"] };
	}
	if ((decision === "continue" && (!raw.unresolvedObligations.length || !raw.unresolvedDetails.length || !nextTask)) ||
		(decision === "fulfilled" && (raw.unresolvedObligations.length || raw.unresolvedDetails.length || !raw.evidenceRefs.length || nextTask)) ||
		(decision === "blocked" && (!raw.unresolvedObligations.length || !raw.unresolvedDetails.length || nextTask)))
		assessmentFailure("decision and unresolved obligations conflict", "$.decision");
	if (groundedAssessment) {
		if (decision === "continue") {
			const groundedTask = groundedAssessment.nextTask;
			if (!nextTask || !groundedTask ||
				!groundedTask.addresses.some(id => groundedAssessment!.issues.some(issue => issue.id === id && issue.status === "open" &&
					["explicit-requirement", "necessary-verification"].includes(issue.classification))))
				assessmentFailure("next task lacks a decision-changing original requirement", "$.groundedAssessment.nextTask");
		} else if (groundedAssessment.nextTask)
			assessmentFailure("grounded next task conflicts with verdict", "$.groundedAssessment.nextTask");
	}
	return { version: 1, decision, rationale: raw.rationale, evidenceRefs: raw.evidenceRefs,
		unresolvedObligations: raw.unresolvedObligations, unresolvedDetails: raw.unresolvedDetails,
		...(nextTask ? { nextTask } : {}), ...(groundedAssessment ? { groundedAssessment } : {}),
		...(groundedAssessmentDelta ? { groundedAssessmentDelta } : {}) };
}

export function objectiveProgress(contract: OriginalObjectiveContractV1, input: {
	boundedRuns: ObjectiveProgressV1["boundedRuns"]; selectedArtifacts: string[];
	availableArtifacts?: string[]; unresolvedOperationIds?: string[];
	assessment?: ObjectiveProgressV1["assessment"];
	assessmentHistory?: ObjectiveProgressV1["assessmentHistory"];
	/** This constructor also recomputes authenticated historical checkpoints. */
	stopReason: ObjectiveStopReason;
	nextTaskDispatched?: boolean;
	/** Opt-in for new host checkpoints; old sealed carries remain byte-compatible. */
	pendingActionFacts?: HostPendingActionFactsV1;
	/** Use only when revalidating a previously host-authored checkpoint. */
	pendingAction?: PendingActionV1;
	/** Only original-level accepted checks, never pilot task checks. */
	originalChecks?: Array<{ obligationId: string; passed: boolean; evidenceRefs: string[] }>;
}): ObjectiveProgressV1 {
	const required = contract.obligations.map(item => item.id);
	const checked = input.originalChecks ?? [];
	const fullOriginalChecks = checked.length === required.length && required.every(id =>
		checked.some(item => item.obligationId === id && item.passed && item.evidenceRefs.length > 0 &&
			item.evidenceRefs.every(ref => input.selectedArtifacts.includes(ref))));
	const hostWorkOutstanding = Boolean(input.unresolvedOperationIds?.length) ||
		Boolean(input.pendingActionFacts?.m04TransactionUnresolved) ||
		input.pendingAction?.safety === "no-replay-until-reconciled";
	const closureReviewBoundary = input.stopReason === "model-closure-unverified" ||
		input.stopReason === "original-checks-unverified";
	const fulfilled = !hostWorkOutstanding && closureReviewBoundary && contract.closure === "finite-evidence" &&
		input.assessment?.decision === "fulfilled" && fullOriginalChecks &&
		input.assessment.unreadEvidence.length === 0 && input.assessment.evidenceRead.includes("original-objective.json") &&
		input.selectedArtifacts.every(ref => input.assessment!.evidenceRead.includes(ref)) &&
		input.assessment.evidenceRefs.every(ref => input.selectedArtifacts.includes(ref));
	const unresolved = fulfilled ? [] : input.assessment?.unresolvedObligations.length ? input.assessment.unresolvedObligations : required;
	const effectiveStopReason = fulfilled ? null : input.pendingActionFacts?.m04TransactionUnresolved ?
		"m04-transaction-unresolved" : !closureReviewBoundary ? input.stopReason : input.assessment?.decision === "fulfilled" ?
			contract.closure === "open-ended" ? "model-closure-unverified" : "original-checks-unverified" : input.stopReason;
	if (input.pendingActionFacts && effectiveStopReason && !isCurrentObjectiveStopReason(effectiveStopReason))
		throw new HarnessError("m07.objective", "retired quota stop cannot mint a new pending action");
	const pendingAction = effectiveStopReason && (input.pendingAction ??
		(input.pendingActionFacts ? classifyPendingAction(effectiveStopReason as CurrentObjectiveStopReason,
			input.pendingActionFacts) : undefined));
	if (pendingAction) validatePendingAction(pendingAction, effectiveStopReason);
	return { version: 1, kind: "original-objective-progress", contract, objectiveOutcome: fulfilled ? "fulfilled" : "incomplete",
		stopReason: effectiveStopReason,
		...(input.assessment ? { assessment: input.assessment } : {}), boundedRuns: input.boundedRuns,
		assessmentHistory: input.assessmentHistory ? input.assessmentHistory.map(item => ({ ...item })) : [],
		selectedArtifacts: [...input.selectedArtifacts], availableArtifacts: [...(input.availableArtifacts ?? input.selectedArtifacts)],
		continuation: { mode: input.unresolvedOperationIds?.length ? "reconcile-operations-before-new-run" :
			"explicit-authorized-new-run", unresolvedOperationIds: [...(input.unresolvedOperationIds ?? [])],
			unresolvedObligations: unresolved,
			unresolvedDetails: fulfilled ? [] : [...new Set([...(input.assessment?.unresolvedDetails ?? []),
				...(input.assessment?.blockedProposals ?? []).map(item => item.objective)])],
			...(input.assessment?.blockedProposals?.length ? { blockedProposals: input.assessment.blockedProposals } : {}),
			...(input.assessment?.nextTask && input.assessment.unreadEvidence.length === 0 && !input.nextTaskDispatched &&
				effectiveStopReason !== "workflow-repair-needed" ?
				{ nextTask: input.assessment.nextTask } : {}),
			requiresOriginalInputs: true, requiresBudgetAdmission: true,
			requiresOperationReconciliation: Boolean(input.unresolvedOperationIds?.length),
			...(pendingAction ? { pendingAction } : {}) } };
}

/** A fresh, read-only model judgment with a durable boundary receipt, then one validated caller-owned M07 dispatch. */
export async function assessAndAdvanceOriginalObjective<T>(input: {
	contract: OriginalObjectiveContractV1; contractFile: string;
	runner: SessionRunner; sessionSpec: Omit<SessionSpec, "tools">; runRecord: StageRunRecord;
	persistReceipt: () => Promise<void>;
	evidenceRoot: string;
	evidence: Array<{ name: string; file: string }>;
	/** Default is required. Only explicitly named historical evidence may be on demand. */
	evidenceAccess?: Record<string, "required" | "retrievable">;
	/** Task adapters own artifact names and semantic evidence contracts. */
	evidenceRequirements?: { requiredNames: string[]; instructions?: string };
	assessmentAdmission: "admitted" | CurrentObjectiveStopReason;
	advanceAdmission: () => "admitted" | CurrentObjectiveStopReason;
	supportedTaskScopes: ObjectiveNextTaskV1["adapterScope"][];
	capabilities?: ObjectiveCapabilityV1[];
	/** Current user policy, applied without rewriting a frozen prior contract. */
	userOverrides?: string[];
	/** Opt-in for new live assessors; old serialized assessments stay readable. */
	groundingPolicy?: { require: true; sourceKinds: Record<string, GroundingSourceKind>;
		legacyOpenDetails: string[]; previousIssues?: GroundedIssue[];
		newEvidenceSourceIds?: string[];
		capabilityLocators?: Record<string, GroundingSpan>;
		priorGroundingIndex?: { indexName: string; partNames: string[] } };
	recordAssessment?: (assessment: NonNullable<ObjectiveProgressV1["assessment"]>) => Promise<void>;
	/** Durable control facts only; never substitutes for evidence reading or a valid verdict. */
	recordRepairState?: (state: WorkflowRepairStateV1) => Promise<void>;
	/** Every rejected model reply, including the raw text, stays in encrypted private output. */
	recordValidationFailure?: (diagnostic: ObjectiveAssessmentValidationDiagnosticV1) => Promise<void>;
	/** Synchronous control observation. A reporting failure must not mask the initiating exception. */
	recordException?: (stage: ObjectiveAssessmentExceptionStage, error: unknown) => void;
	advance: (task: ObjectiveNextTaskV1) => Promise<T>;
}): Promise<{ assessment?: ObjectiveProgressV1["assessment"]; advanced?: T; stopReason: CurrentObjectiveStopReason }> {
	let preSessionStage: ObjectiveAssessmentExceptionStage = "input-validation";
	let sessionCreated = false;
	try {
	const assessmentAdmission = currentObjectiveAdmission(input.assessmentAdmission);
	if (assessmentAdmission !== "admitted") return { stopReason: assessmentAdmission };
	if (input.sessionSpec.role !== "research" ||
		!input.evidence.length || input.evidence.some(item => !safeName(item.name)) ||
		new Set(input.evidence.map(item => item.name)).size !== input.evidence.length)
		throw new HarnessError("m07.objective", "objective assessment boundary is invalid");
	if (input.capabilities?.some(item => !safeAdapterId(item.scope) ||
		typeof item.available !== "boolean" || !nonemptyText(item.description) ||
		!Array.isArray(item.limits) || item.limits.some(limit => !nonemptyText(limit))) ||
		new Set(input.capabilities?.map(item => item.scope)).size !== (input.capabilities?.length ?? 0))
		throw new HarnessError("m07.objective", "objective capability facts are invalid");
	if (!Array.isArray(input.userOverrides ?? []) ||
		(input.userOverrides ?? []).some(item => !nonemptyText(item)))
		throw new HarnessError("m07.objective", "current user overrides are invalid");
	if (input.groundingPolicy && (input.groundingPolicy.require !== true ||
		!input.groundingPolicy.sourceKinds || typeof input.groundingPolicy.sourceKinds !== "object" ||
		Array.isArray(input.groundingPolicy.sourceKinds) ||
		!Array.isArray(input.groundingPolicy.legacyOpenDetails) ||
		input.groundingPolicy.legacyOpenDetails.some(item => !nonemptyText(item)) ||
		!Array.isArray(input.groundingPolicy.previousIssues ?? []) ||
		(input.groundingPolicy.previousIssues ?? []).some(item => !item || !isGroundedIssueId(item.id) ||
			!nonemptyText(item.claim) || !["open", "resolved"].includes(item.status)) ||
		new Set((input.groundingPolicy.previousIssues ?? []).map(item => item.id)).size !==
			(input.groundingPolicy.previousIssues ?? []).length ||
		!Array.isArray(input.groundingPolicy.newEvidenceSourceIds ?? []) ||
		(input.groundingPolicy.newEvidenceSourceIds ?? []).some(item => !safeName(item)) ||
		new Set(input.groundingPolicy.newEvidenceSourceIds ?? []).size !==
			(input.groundingPolicy.newEvidenceSourceIds ?? []).length ||
		(input.groundingPolicy.priorGroundingIndex !== undefined &&
			(!safeName(input.groundingPolicy.priorGroundingIndex.indexName) ||
				!Array.isArray(input.groundingPolicy.priorGroundingIndex.partNames) ||
				input.groundingPolicy.priorGroundingIndex.partNames.some(name => !safeName(name)) ||
				new Set(input.groundingPolicy.priorGroundingIndex.partNames).size !==
					input.groundingPolicy.priorGroundingIndex.partNames.length))))
		throw new HarnessError("m07.objective", "assessor grounding policy is invalid");
	if (input.supportedTaskScopes.some(scope => !safeAdapterId(scope)) ||
		new Set(input.supportedTaskScopes).size !== input.supportedTaskScopes.length)
		throw new HarnessError("m07.objective", "supported adapter IDs are invalid");
	if (input.evidenceRequirements && (!Array.isArray(input.evidenceRequirements.requiredNames) ||
		input.evidenceRequirements.requiredNames.some(name => !safeName(name) || !input.evidence.some(item => item.name === name)) ||
		(input.evidenceRequirements.instructions !== undefined && !nonemptyText(input.evidenceRequirements.instructions))))
		throw new HarnessError("m07.objective", "required adapter evidence is missing or invalid");
	if (input.evidenceAccess && (typeof input.evidenceAccess !== "object" ||
		Array.isArray(input.evidenceAccess) || Object.entries(input.evidenceAccess).some(([name, access]) =>
			!safeName(name) || !["required", "retrievable"].includes(access) ||
			name !== "original-objective.json" && !input.evidence.some(item => item.name === name)) ||
		input.evidenceAccess["original-objective.json"] === "retrievable" ||
		input.evidenceRequirements?.requiredNames.some(name => input.evidenceAccess?.[name] === "retrievable") ||
		input.evidence.some(item => (item.name === "original-problem.txt" ||
			/^original-input-[1-9][0-9]*\.txt$/.test(item.name)) &&
			input.evidenceAccess?.[item.name] === "retrievable")))
		throw new HarnessError("m07.objective", "required objective evidence cannot become retrievable");
	// The complete assessment plan stays frozen even if a caller mutates its input
	// objects while a prompt or persistence callback is running.
	const contract = structuredClone(input.contract);
	const sourceEvidence = input.evidence.map(item => ({ ...item }));
	const evidenceAccess = { ...input.evidenceAccess };
	const capabilities = input.capabilities?.map(item => ({ ...item, limits: [...item.limits] }));
	const supportedTaskScopes = [...input.supportedTaskScopes];
	const userOverrides = [...(input.userOverrides ?? contract.userOverrides ?? [])];
	const groundingPolicy = input.groundingPolicy ? structuredClone(input.groundingPolicy) : undefined;
	const evidenceInstructions = input.evidenceRequirements?.instructions;
	const sessionSpec = structuredClone(input.sessionSpec);
	const evidenceRoot = input.evidenceRoot;

	preSessionStage = "contract-read";
	const contractBytes = await readFile(input.contractFile);
	if (contractBytes.length > MAX_EVIDENCE_BYTES) throw new HarnessError("m07.objective", "original objective contract exceeds evidence file size boundary");
	if (contractBytes.toString("utf8") !== `${JSON.stringify(contract, null, 2)}\n`)
		throw new HarnessError("m07.objective", "original objective contract changed after freezing");
	// Keep only per-file metadata. Evidence is read through a paged tool by the assessor;
	// an aggregate byte cap would reject a valid collection before any such read.
	preSessionStage = "evidence-scan";
	const materials: Array<{ name: string; file: string; lineCount: number; digest: string }> = [];
	for (const item of sourceEvidence) {
		const info = await lstat(item.file);
		if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_EVIDENCE_BYTES)
			throw new HarnessError("m07.objective", "objective evidence is not a bounded regular file");
		const bytes = await readFile(item.file);
		if (bytes.length > MAX_EVIDENCE_BYTES) throw new HarnessError("m07.objective", "objective evidence is not a bounded regular file");
		let text: string;
		try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
		catch { throw new HarnessError("m07.objective", "objective evidence is not valid UTF-8 text"); }
		materials.push({ ...item, lineCount: text.split("\n").length - (text.endsWith("\n") ? 1 : 0),
			digest: createHash("sha256").update(bytes).digest("hex") });
	}
	preSessionStage = "source-registry";
	if (groundingPolicy && (materials.some(item => ["original-objective.json", "current-user-overrides"].includes(item.name)) ||
		Object.keys(groundingPolicy.sourceKinds).length !== materials.length ||
		materials.some(item => !["user-instruction", "supplied-task", "selected-evidence", "host-capability"]
			.includes(groundingPolicy.sourceKinds[item.name])) ||
		(groundingPolicy.newEvidenceSourceIds ?? []).some(name => !materials.some(item => item.name === name &&
			["selected-evidence", "host-capability"].includes(groundingPolicy.sourceKinds[name])))))
		throw new HarnessError("m07.objective", "grounding source registry does not match frozen evidence");
	if (groundingPolicy?.capabilityLocators &&
		Object.entries(groundingPolicy.capabilityLocators).some(([scope, locator]) =>
			!safeAdapterId(scope) || !capabilities?.some(item => item.scope === scope && !item.available) ||
			!locator || groundingPolicy.sourceKinds[locator.sourceId] !== "host-capability" ||
			!Number.isSafeInteger(locator.startLine) || !Number.isSafeInteger(locator.endLine) ||
			locator.startLine < 1 || locator.endLine < locator.startLine ||
			!materials.some(item => item.name === locator.sourceId && locator.endLine <= item.lineCount)))
		throw new HarnessError("m07.objective", "unavailable capability locator does not match frozen host evidence");
	const priorIndex = groundingPolicy?.priorGroundingIndex;
	if (priorIndex && (!materials.some(item => item.name === priorIndex.indexName) ||
		evidenceAccess[priorIndex.indexName] === "retrievable" ||
		priorIndex.partNames.some(name => name === priorIndex.indexName ||
			!materials.some(item => item.name === name) || evidenceAccess[name] !== "retrievable")))
		throw new HarnessError("m07.objective", "prior grounding index and parts must be registered frozen evidence");
	preSessionStage = "frozen-copy";
	await mkdir(evidenceRoot, { mode: 0o700 });
	const frozenContract = path.join(evidenceRoot, "original-objective.json");
	await copyFile(input.contractFile, frozenContract);
	if (!(await readFile(frozenContract)).equals(contractBytes))
		throw new HarnessError("m07.objective", "frozen original objective changed during copy");
	const evidence: EvidenceBindingV1[] = [
		{ version: 1, label: "frozen original objective", path: frozenContract, status: "frozen-copy", sourceVersion: contract.id },
	];
	for (const item of materials) {
		const copy = path.join(evidenceRoot, item.name);
		await copyFile(item.file, copy);
		const frozen = await readFile(copy);
		if (frozen.length > MAX_EVIDENCE_BYTES || createHash("sha256").update(frozen).digest("hex") !== item.digest)
			throw new HarnessError("m07.objective", "frozen objective evidence changed during copy");
		evidence.push({ version: 1, label: item.name, path: copy, status: "frozen-copy", sourceVersion: contract.id });
	}
	preSessionStage = "prior-index";
	let priorIssueLocators: Record<string, GroundingSpan> | undefined;
	if (priorIndex) {
		const parts: Record<string, string> = {};
		for (const name of priorIndex.partNames) parts[name] = await readFile(path.join(evidenceRoot, name), "utf8");
		try { priorIssueLocators = validatePriorGroundingIndex(
			await readFile(path.join(evidenceRoot, priorIndex.indexName), "utf8"), parts,
			{ legacyOpenDetails: groundingPolicy!.legacyOpenDetails,
				previousIssues: groundingPolicy!.previousIssues ?? [] }); }
		catch { throw new HarnessError("m07.objective", "prior grounding partition differs from authenticated records"); }
	}
	const spec: SessionSpec = { ...sessionSpec,
		tools: { kind: "read-dir", root: evidenceRoot, toolName: "objective_evidence_read" } };
	const openAssessor = (reason: string) => openBoundedSession(input.runner, input.runRecord, {
		mode: "fresh", intent: "independent-judgment", reason,
		evidence: structuredClone(evidence), spec: structuredClone(spec),
	}, input.persistReceipt);
	preSessionStage = "session-create";
	let handle = await openAssessor("Assess the original user goal from frozen bounded evidence before choosing further M07 work");
	sessionCreated = true;
	try {
		const contractText = contractBytes.toString("utf8");
		const grounding: GroundingContext | undefined = groundingPolicy ? {
			contractId: contract.id,
			sources: { "original-objective.json": { kind: "user-instruction",
				lineCount: contractText.split("\n").length - (contractText.endsWith("\n") ? 1 : 0) },
				...Object.fromEntries(materials.map(item => [item.name, { kind: groundingPolicy.sourceKinds[item.name],
					lineCount: item.lineCount }])),
				...(userOverrides.length ? { "current-user-overrides": { kind: "user-instruction" as const,
					lineCount: userOverrides.length } } : {}) },
			capabilities: Object.fromEntries((capabilities ?? []).map(item => [item.scope,
				{ available: item.available }])),
			...(groundingPolicy.capabilityLocators ?
				{ capabilityLocators: structuredClone(groundingPolicy.capabilityLocators) } : {}),
			legacyOpenDetails: groundingPolicy.legacyOpenDetails,
			previousIssues: groundingPolicy.previousIssues ?? [],
			newEvidenceSourceIds: groundingPolicy.newEvidenceSourceIds ?? [],
			...(priorIssueLocators ? { priorIssueLocators } : {}),
		} : undefined;
		const requiredMaterials = materials.filter(item => evidenceAccess[item.name] !== "retrievable");
		const retrievableMaterials = materials.filter(item => evidenceAccess[item.name] === "retrievable");
		const retrievableIndex = requiredMaterials.find(item =>
			item.name === "prior-research-history-index.json");
		const checkpointIndex = requiredMaterials.find(item =>
			item.name === "prior-objective-checkpoint-index.json");
		const unavailableScopeIds = (capabilities ?? []).filter(item => !item.available)
			.map(item => item.scope);
		const groundedIssueSchema = "Each new issue has base fields {id,claim,status:'open'|'resolved',classification,sourceRefs:[{sourceId,startLine,endLine}],implication}. Add only the named fields for its classification: claimAtRisk for necessary-verification, optionalBasis for optional-method, or blockedScope and capabilityRef:{sourceId,startLine,endLine} for physical-capability-gap. Do not add a proof field. A resolved issue also needs resolution:{explanation,evidenceRefs:[{sourceId,startLine,endLine}]}.";
		const physicalGapRule = `For physical-capability-gap, blockedScope must be ONE exact unavailable registered scope ID, never a prose description or combined list: ${JSON.stringify(unavailableScopeIds)}. Cite that scope's own host-capability row with capabilityRef; if no registered ID matches a suspected limitation, do not invent a physical gap or claim the limitation is measured.`;
		const priorResolutionSchema = "Each delta resolution is {id,priorRef:{sourceId,startLine,endLine},explanation,evidenceRefs:[{sourceId,startLine,endLine}]}. Copy priorRef exactly from the required prior-grounding-index locator: sourceId is that issue's partName and both line numbers equal its line. Do not use a 'part:line' string. Each evidenceRefs item is a separate span object for newly frozen evidence actually read in this session; do not use string shorthand or infer read credit from a path.";
		const groundedTaskSchema = "For continue, write ONE task in groundedAssessment.nextTask or groundedAssessmentDelta.nextTask: {objective:string,obligationIds:[original obligation ID strings],addresses:[OPEN grounded issue ID strings],adapterScope:one available registered scope,decisionChangingHypothesis:string,expectedEvidence:string,sourceRefs:[{sourceId,startLine,endLine}]}. objective, hypothesis and expectedEvidence must be nonempty. obligationIds must be contained in unresolvedObligations. Omit top-level nextTask; the host derives its full task record from this grounded task after validation. A legacy top-level nextTask is accepted only when its objective and any supplied addresses/scope exactly match the grounded task. For blocked or fulfilled, omit both nextTask objects.";
		const groundedReferenceSchema = "Top-level evidenceRefs is an array of exact frozen FILE NAME STRINGS, not source-span objects; it may be [] for continue or blocked. Grounded sourceRefs, resolution evidenceRefs and deliverableReady evidenceRefs are arrays of {sourceId,startLine,endLine} objects for cited lines actually returned in this session. Never put a span object in top-level evidenceRefs or a filename string in a grounded span array.";
		const deliverableSchema = "Optional deliverableReady is an OBJECT {status:'proposed',ready:boolean,rationale:string,evidenceRefs:[{sourceId,startLine,endLine}],remainingIssueIds:[open issue ID strings]}. List every still-open issue ID in remainingIssueIds. A bare boolean is invalid; omit the field if you have no evidence-backed finding. This proposal never closes the open-ended mission.";
		const responseSchema = priorIndex ? [
			"Return one strict JSON object only: version:1, decision:'fulfilled'|'continue'|'blocked', nonempty rationale, unique evidenceRefs from frozen file names, unique unresolvedObligations from the original obligation IDs, and groundedAssessmentDelta. Omit top-level unresolvedDetails and groundedAssessment; the host reconstructs the former from the authenticated prior issue index and this delta.",
			"groundedAssessmentDelta is {version:1,kind:'grounded-assessment-delta',newIssues:[],resolutions:[],nextTask?,deliverableReady?}. Keep prior issues and legacy details by omission.",
			groundedIssueSchema, physicalGapRule, priorResolutionSchema, groundedTaskSchema,
			groundedReferenceSchema, deliverableSchema,
			"A continuing task must address at least one OPEN explicit requirement or necessary verification issue. For fulfilled, leave unresolvedObligations empty, cite full-file evidence, and omit both nextTask fields. For blocked, retain unresolvedObligations and omit both nextTask fields."
		] : grounding ? [
			"Return one strict JSON object only: version:1, decision:'fulfilled'|'continue'|'blocked', nonempty rationale, unique evidenceRefs from frozen file names, unique unresolvedObligations from original obligation IDs, unique nonempty unresolvedDetails, and groundedAssessment. Do not supply groundedAssessmentDelta without a prior grounding index.",
			"groundedAssessment is {version:1,kind:'grounded-assessment-proposal',contractId,missionStatus:'open',issues,legacyOpenDetails,nextTask?,deliverableReady?}. Preserve every prior issue and legacy detail; unresolvedDetails must exactly list open issue claims.",
			groundedIssueSchema, physicalGapRule, groundedTaskSchema,
			groundedReferenceSchema, deliverableSchema,
			"For continue, address an OPEN explicit requirement or necessary verification. For fulfilled, leave unresolvedObligations and unresolvedDetails empty and omit both nextTask fields. For blocked, retain unresolvedObligations and unresolvedDetails and omit both nextTask fields."
		] : [
			"Return one strict JSON object only: version:1, decision:'fulfilled'|'continue'|'blocked', nonempty rationale, unique evidenceRefs from frozen file names, unique unresolvedObligations from original obligation IDs, and unique nonempty unresolvedDetails.",
			"For continue, include nextTask {objective,addresses,adapterScope} with nonempty addresses contained in unresolvedObligations. For fulfilled, leave unresolvedObligations and unresolvedDetails empty, cite evidence, and omit nextTask. For blocked, retain unresolvedObligations and unresolvedDetails and omit nextTask."
		];
		const prompt = ["# Original objective (unchanged)", contract.goal,
			"# User overrides (higher priority than supplied task material)",
			...userOverrides.map((item, index) => `${index + 1}: ${item}`),
			"# Original obligations", ...contract.obligations.map(item => `${item.id}: ${item.description}`),
			"# Observed execution capabilities", ...(capabilities ?? []).map(item =>
				`${item.scope}: ${item.available ? "available" : "unavailable"}; ${item.description}; limits: ${item.limits.join("; ")}`),
			`Closure policy: ${contract.closure}. A bounded child goal and accepted candidate do not alone establish original-goal completion.`,
			evidenceInstructions ?? "Read all supplied material; the caller identifies the original inputs and the meaning of artifact names.",
			"# Frozen bounded evidence", "Use objective_evidence_read to read the complete original-objective.json and every listed file below. This list contains the required files. If paginated, read every page including the untruncated end. Required files:",
			...requiredMaterials.map(item => item.name),
			...(retrievableMaterials.length ? [
				"Additional frozen history is retrievable on demand. Its locator grants no scientific evidence credit.",
				...(retrievableIndex ? ["Read prior-research-history-index.json for historical part filenames and byte order."] : []),
				...(checkpointIndex ? ["Read prior-objective-checkpoint-index.json for the byte-exact historical checkpoint part names and order. The host already checks the current selected tuple and unresolved control state. Read historical parts only when they can affect your reasoning, and cite every historical claim using actual returned lines."] : []),
				...(priorIndex ? [`Read ${priorIndex.indexName} for prior grounding record locators and part filenames.`] : []),
				...(!retrievableIndex && !priorIndex ?
					retrievableMaterials.map(item => `Retrievable file: ${item.name}, lines 1-${item.lineCount}.`) : []),
				"A retrievable file cited in evidenceRefs needs a complete current-session read; a retrievable source span needs its exact cited lines returned in this session. Unread retrievable files have no authority." ] : []),
			...(grounding ? ["# Grounded assessment requirement",
				"For sourceRefs cite registered sourceId, startLine, endLine. current-user-overrides line N is override N above. Original problem and inputs are supplied-task material; host capability claims need observed host facts. These classifications annotate claims and cannot erase the original obligation.",
				...Object.entries(grounding.sources).filter(([name]) => name === "original-objective.json" ||
					name === "current-user-overrides" || evidenceAccess[name] !== "retrievable" ||
					!retrievableIndex && !priorIndex)
					.map(([name, source]) => `${name}: ${source.kind}, lines 1-${source.lineCount}`),
				"Issue classes are explicit-requirement (cited user or supplied task requirement), necessary-verification (claimAtRisk), optional-method (cited optionalBasis), and physical-capability-gap (one exact unavailable registered blockedScope ID plus its host capabilityRef). Each new issue needs id, claim, status, classification, sourceRefs and implication. A proposed nextTask must identify an open decision-changing issue and expected evidence. Optional methods or unavailable equipment alone do not force another task.",
				...(priorIndex ? [
					`Authenticated prior grounding is in required index ${priorIndex.indexName} and ${priorIndex.partNames.length} retrievable parts. Read the index completely. Use its exact line locators to inspect a prior issue before changing its status. Omitted prior issues and legacy details are retained by the host. New frozen evidence IDs: ${JSON.stringify(grounding.newEvidenceSourceIds ?? [])}.`,
					"Return groundedAssessmentDelta {version:1,kind:'grounded-assessment-delta',newIssues:[],resolutions:[],nextTask?,deliverableReady?} instead of groundedAssessment. Do not echo old issue records or legacy details; the host merges and checks them. The host derives unresolvedDetails from all still-open issues.",
					priorResolutionSchema
				] : [
					`Retain these prior unresolved details verbatim under groundedAssessment.legacyOpenDetails: ${JSON.stringify(grounding.legacyOpenDetails)}. Retain every prior issue ID and claim, changing open to resolved only with new evidence: ${JSON.stringify(grounding.previousIssues ?? [])}. Newly produced frozen evidence IDs: ${JSON.stringify(grounding.newEvidenceSourceIds ?? [])}.`,
					"Add groundedAssessment {version:1,kind:'grounded-assessment-proposal',contractId,missionStatus:'open',issues,legacyOpenDetails,nextTask?,deliverableReady?}. Each issue needs id,claim,status:'open'|'resolved',classification,sourceRefs,implication. A resolved issue retains its ID and adds resolution {explanation,evidenceRefs} citing a selected result or host observation; only OPEN issue claims appear in unresolvedDetails. Classifications: explicit-requirement (user instruction or supplied task), necessary-verification (claimAtRisk), optional-method (optionalBasis cited in task/user text), physical-capability-gap (blockedScope and capabilityRef citing host observation). For continue, groundedAssessment.nextTask carries the sole model-authored objective, original obligation IDs, OPEN issue addresses, available adapterScope, decisionChangingHypothesis, expectedEvidence and sourceRefs. The host derives the top-level task from it. An optional method or unavailable capability alone does not justify another task. Do not claim a global optimum from finite tests."
				]) ] : []),
			...responseSchema,
			"Use a scope only when its observed host capability covers your proposed work. If a proposed task has no available registered executor, retain it as unresolved and name the unavailable capability explicitly. Preserve genuinely unresolved requirements. Assess honestly. Propose the next scientific work yourself from unresolved original obligations; do not change task permissions or claim a global optimum from a finite evaluation."].join("\n\n");
		const frozenFileAccessible = async (name: string, rejectUnknownIo = false): Promise<boolean> => {
			try {
				const file = path.join(evidenceRoot, name);
				const info = await lstat(file);
				if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_EVIDENCE_BYTES) return false;
				const bytes = await readFile(file);
				if (name === "original-objective.json") return bytes.equals(contractBytes);
				const expected = materials.find(item => item.name === name)?.digest;
				return bytes.length <= MAX_EVIDENCE_BYTES && expected !== undefined &&
					createHash("sha256").update(bytes).digest("hex") === expected;
			} catch (error) {
				if (rejectUnknownIo && !["ENOENT", "ENOTDIR", "EACCES", "EPERM"].includes(
					(error as NodeJS.ErrnoException)?.code ?? "")) throw error;
				return false;
			}
		};
		const coverage = (name: string, lines: number): { complete: boolean; score: number; nextRange: string;
			coveredRanges: Array<[number, number]>; reachedUntruncatedEnd: boolean } => {
			const returned = handle.readReturnEvents();
			const rows = returned.filter(item => item.toolName === "objective_evidence_read" && item.path === name &&
				item.status === "returned" && item.returned.kind === "text" && item.returned.startLine !== undefined &&
				item.returned.endLine !== undefined && item.returned.startLine >= 1 &&
				item.returned.endLine >= item.returned.startLine && item.returned.endLine <= lines);
			const covered = new Set<number>();
			for (const row of rows) for (let line = row.returned.startLine!; line <= row.returned.endLine! && line <= lines; line++) covered.add(line);
			const reachedUntruncatedEnd = rows.some(item => item.returned.endLine === lines && item.returned.truncated === false);
			const coveredRanges: Array<[number, number]> = [];
			for (const line of [...covered].sort((a, b) => a - b)) {
				const last = coveredRanges.at(-1);
				if (last && last[1] + 1 === line) last[1] = line;
				else coveredRanges.push([line, line]);
			}
			let start = 1;
			while (start <= lines && covered.has(start)) start++;
			let end = start;
			while (end < lines && !covered.has(end + 1)) end++;
			const offset = start <= lines ? start : Math.max(1, lines);
			const limit = start <= lines ? end - start + 1 : 1;
			return { complete: reachedUntruncatedEnd && covered.size === lines,
				coveredRanges, reachedUntruncatedEnd,
				score: covered.size + Number(reachedUntruncatedEnd),
				nextRange: `${name}: objective_evidence_read path="${name}" offset=${offset} limit=${limit}${start > lines ? " (request the untruncated final page)" : ""}` };
		};
		const readMaterials = [{ name: "original-objective.json", lineCount: contractText.split("\n").length - (contractText.endsWith("\n") ? 1 : 0) }, ...materials];
		const citedSpans = (assessment?: ModelObjectiveAssessmentV1): GroundingSpan[] => {
			const delta = assessment?.groundedAssessmentDelta;
			if (delta) return [
				...delta.newIssues.flatMap(item => [...item.sourceRefs,
					...(item.capabilityRef ? [item.capabilityRef] : []),
					...(item.resolution?.evidenceRefs ?? [])]),
				...delta.resolutions.flatMap(item => [item.priorRef, ...item.evidenceRefs]),
				...(delta.nextTask?.sourceRefs ?? []),
				...(delta.deliverableReady?.evidenceRefs ?? [])];
			const proposal = assessment?.groundedAssessment;
			if (!proposal) return [];
			return [...proposal.issues.flatMap(item => [...item.sourceRefs,
				...(item.capabilityRef ? [item.capabilityRef] : []),
				...(item.resolution?.evidenceRefs ?? [])]),
				...(proposal.nextTask?.sourceRefs ?? []),
				...(proposal.deliverableReady?.evidenceRefs ?? [])];
		};
		const proposals: ModelObjectiveAssessmentV1[] = [];
		const unsupported = new Set<string>();
		const blockedProposals: ObjectiveNextTaskV1[] = [];
		let challengedBlocked = false;
		let latestAssessment: ObjectiveProgressV1["assessment"];
		let priorUnreadScore: number | undefined;
		let readEventCursor = 0;
		let request = prompt;
		let sessionGeneration = 1;
		let assessmentAttempt = 0;
		const failedStrategies = new Map<string, Set<WorkflowRepairStateV1["strategy"]>>();
		const frozenEvidenceIdentity = [{ name: "original-objective.json",
			digest: createHash("sha256").update(contractBytes).digest("hex") },
			...materials.map(({ name, digest }) => ({ name, digest }))];
		const frozenPlan = { prompt, spec, supportedTaskScopes };
		for (;;) {
			let response;
			try { response = await handle.prompt(request); }
			catch (error) {
				try { input.recordException?.("prompt", error); } catch { /* Keep the initiating prompt error. */ }
				const admission = currentObjectiveAdmission(input.advanceAdmission());
				return { assessment: latestAssessment, stopReason: admission === "admitted" ? "assessment-failed" : admission };
			}
			assessmentAttempt++;
			const returned = handle.readReturnEvents();
			const newReadEvents = returned.slice(readEventCursor);
			readEventCursor = returned.length;
			let parsed: ModelObjectiveAssessmentV1 | undefined;
			let invalidReason: string | undefined;
			let validationFailure: AssessmentValidationError | undefined;
			try { parsed = parseAssessment(response.text, contract,
				["original-objective.json", ...materials.map(item => item.name)], grounding, Boolean(priorIndex)); }
			catch (error) {
				if (!(error instanceof HarnessError) || error.code !== "m07.objective-assessment") throw error;
				// Parser reasons are fixed host text, never the model's response or private evidence.
				invalidReason = error.message;
				validationFailure = error instanceof AssessmentValidationError ? error :
					new AssessmentValidationError(error.message, "$");
			}
			const fixedValidationFeedback = validationFailure ? [
				`Rejected field path: ${validationFailure.validationPath}.`,
				...(validationFailure.validationDetail ?
					[`Host validator detail: ${validationFailure.validationDetail}.`] : [])] : [];
			const spans = citedSpans(parsed);
			const fullRequired = new Set(["original-objective.json", ...requiredMaterials.map(item => item.name),
				...(parsed?.evidenceRefs ?? [])]);
			const fileCoverage = readMaterials.map(item => {
				const read = coverage(item.name, item.lineCount);
				const requiredSpans = spans.filter(ref => ref.sourceId === item.name);
				const wholeFile = fullRequired.has(item.name);
				const untruncatedRanges: Array<[number, number]> = [];
				for (const event of returned.filter(event => event.toolName === "objective_evidence_read" &&
					event.path === item.name && event.status === "returned" && event.returned.kind === "text" &&
					event.returned.truncated === false && event.returned.startLine !== undefined &&
					event.returned.endLine !== undefined && event.returned.startLine >= 1 &&
					event.returned.endLine <= item.lineCount))
					untruncatedRanges.push([event.returned.startLine!, event.returned.endLine!]);
				untruncatedRanges.sort((a, b) => a[0] - b[0]);
				const mergedRanges: Array<[number, number]> = [];
				for (const range of untruncatedRanges) {
					const prior = mergedRanges.at(-1);
					if (prior && prior[1] + 1 >= range[0]) prior[1] = Math.max(prior[1], range[1]);
					else mergedRanges.push([...range]);
				}
				const missingSpan = requiredSpans.find(ref => !mergedRanges.some(range =>
					range[0] <= ref.startLine && range[1] >= ref.endLine));
				const needed = wholeFile || requiredSpans.length > 0;
				const satisfied = wholeFile ? read.complete : !missingSpan;
				const spanScore = requiredSpans.reduce((sum, ref) => sum + mergedRanges.reduce((covered, range) =>
					covered + Math.max(0, Math.min(range[1], ref.endLine) - Math.max(range[0], ref.startLine) + 1), 0), 0);
				return { name: item.name, ...read, wholeFile, needed, satisfied,
					score: wholeFile ? read.score : spanScore,
					nextRange: wholeFile || !missingSpan ? read.nextRange :
						`${item.name}: objective_evidence_read path="${item.name}" offset=${missingSpan.startLine} limit=${missingSpan.endLine - missingSpan.startLine + 1} (cited span)` };
			});
			const evidenceRead = fileCoverage.filter(item => item.complete).map(item => item.name);
			const unreadEvidence = fileCoverage.filter(item => item.needed && !item.satisfied).map(item => item.name);
			const unreadScore = fileCoverage.reduce((sum, item) => sum + item.score, 0);
			const recordRejectedReply = async (validation: ObjectiveAssessmentValidationDiagnosticV1["validation"]) =>
				input.recordValidationFailure?.({ sessionId: handle.ref.id,
					generation: sessionGeneration, attempt: assessmentAttempt, rawResponse: response.text,
					validation, coverage: fileCoverage.map(item => ({ sourceId: item.name,
						required: item.needed, coveredRanges: item.coveredRanges.map(range =>
							[range[0], range[1]] as [number, number]), complete: item.satisfied })),
					...(handle.ref.file ? { transcriptPath: handle.ref.file } : {}) });
			if (validationFailure) await recordRejectedReply({
				code: "m07.objective-assessment", message: validationFailure.message,
				path: validationFailure.validationPath,
				...(validationFailure.validationDetail ? { detail: validationFailure.validationDetail } : {}) });
			const repairFailure = async (failure: WorkflowRepairFailure, failureFacts: unknown):
				Promise<"same-session-feedback" | "fresh-context" | CurrentObjectiveStopReason> => {
				const evidenceFingerprint = workflowRepairFingerprint({ frozen: frozenEvidenceIdentity,
					coverage: fileCoverage.filter(item => item.needed).map(({ name, coveredRanges,
						reachedUntruncatedEnd, wholeFile }) =>
						({ name, coveredRanges, reachedUntruncatedEnd, wholeFile })) });
				const planFingerprint = workflowRepairFingerprint({ frozen: frozenPlan, failureFacts });
				// Host failure facts are canonical: timestamps, duplicate reads, JSON
				// whitespace and unsupported rationale wording cannot create progress.
				const responseFingerprint = workflowRepairFingerprint(failureFacts);
				const identity = JSON.stringify({ failure, evidenceFingerprint, planFingerprint, responseFingerprint });
				const tried = failedStrategies.get(identity) ?? new Set<WorkflowRepairStateV1["strategy"]>();
				let strategy: WorkflowRepairStateV1["strategy"] =
					tried.has("fresh-context") ? "workflow-repair-needed" :
					tried.has("same-session-feedback") ? "fresh-context" : "same-session-feedback";
				let unsafeHandoff = false, transientHandoffFailure = false;
				if (strategy === "fresh-context") {
					try {
						for (const item of readMaterials) if (!(await frozenFileAccessible(item.name, true))) {
							strategy = "workflow-repair-needed";
							unsafeHandoff = true;
							break;
						}
					} catch {
						transientHandoffFailure = true;
					}
				}
				const persist = (selected: WorkflowRepairStateV1["strategy"], generation = sessionGeneration,
					observedFailure: WorkflowRepairFailure = failure) =>
					input.recordRepairState?.(workflowRepairState({ stage: "objective-assessment", failure: observedFailure,
						evidenceFingerprint, planFingerprint, responseFingerprint, strategy: selected,
						sessionGeneration: generation }));
				if (transientHandoffFailure) {
					await persist("fresh-context", sessionGeneration + 1, "context-handoff-unavailable");
					const admission = currentObjectiveAdmission(input.advanceAdmission());
					return admission === "admitted" ? "assessment-failed" : admission;
				}
				await persist(strategy, sessionGeneration + Number(strategy === "fresh-context"),
					unsafeHandoff ? "context-handoff-unavailable" : failure);
				tried.add(strategy);
				failedStrategies.set(identity, tried);
				if (strategy === "fresh-context") {
					const previous = handle.ref;
					handle.dispose();
					try {
						const fresh = await openAssessor("Replace ineffective read-only assessment context while preserving the frozen original objective and evidence");
						if (fresh.ref.id === previous.id || previous.file !== undefined && fresh.ref.file === previous.file ||
							fresh.transcript().length || fresh.readReturnEvents().length) {
							fresh.dispose();
							throw new HarnessError("context.boundary", "fresh assessor reused prior dialogue or read proof");
						}
						handle = fresh;
					} catch (error) {
						// Only a known deterministic boundary proves the fresh handoff
						// unsafe. Transient creation/persistence/transport uncertainty
						// remains an assessment failure for the host's accounting-safe
						// retry or reconciliation path; no request is reissued here.
						if (error instanceof HarnessError && ["context.capability", "context.boundary",
							"context.parent", "context.evidence"].includes(error.code)) {
							await persist("workflow-repair-needed", sessionGeneration, "context-handoff-unavailable");
							return "workflow-repair-needed";
						}
						await persist("fresh-context", sessionGeneration + 1, "context-handoff-unavailable");
						const admission = currentObjectiveAdmission(input.advanceAdmission());
						return admission === "admitted" ? "assessment-failed" : admission;
					}
					sessionGeneration++;
					priorUnreadScore = undefined;
					readEventCursor = 0;
					challengedBlocked = false;
					request = prompt;
				}
				return strategy;
			};
			let assessment: ObjectiveProgressV1["assessment"];
			if (parsed) {
				proposals.push(parsed);
				assessment = { ...parsed, sessionId: handle.ref.id, model: handle.ref.model,
					evidenceRead, unreadEvidence, proposalHistory: [...proposals],
					...(blockedProposals.length ? { blockedProposals: [...blockedProposals] } : {}) };
				latestAssessment = assessment;
				await input.recordAssessment?.(assessment);
			}
			if (unreadEvidence.length) {
				// A provisional verdict cannot authorize work until every frozen file is fully read.
				// Repeated unchanged read failure changes the context strategy; it
				// never establishes scientific closure or supplies missing read proof.
				const failedReads = newReadEvents.filter(item => item.toolName === "objective_evidence_read" &&
					item.status === "error");
				// Pi records an unresolved path when confinement or file access fails
				// before the read callback captures its name. Check the frozen unread
				// files themselves rather than trusting an error event's path.
				if (failedReads.length) for (const name of unreadEvidence)
					if (!(await frozenFileAccessible(name)))
						return { assessment: latestAssessment, stopReason: "assessment-evidence-suspended" };
				const noReadProgress = priorUnreadScore !== undefined && unreadScore <= priorUnreadScore;
				priorUnreadScore = unreadScore;
				if (!validationFailure) await recordRejectedReply({ code: "m07.objective-control",
					message: "required or cited objective evidence was not returned in full",
					path: "$.evidenceRefs" });
				const admission = currentObjectiveAdmission(input.advanceAdmission());
				if (admission !== "admitted") return { assessment: latestAssessment, stopReason: admission };
				const repair = await repairFailure("unread-evidence", { unreadEvidence });
				if (repair === "fresh-context") continue;
				if (repair !== "same-session-feedback") return { assessment: latestAssessment, stopReason: repair };
				request = ["Your previous assessment is provisional because mandatory or cited frozen evidence was not sufficiently returned by objective_evidence_read.",
					`Unread or incomplete files: ${unreadEvidence.join(", ")}.`,
					...fileCoverage.filter(item => item.needed && !item.satisfied).map(item => item.nextRange),
					...(failedReads.length ? ["A read tool error occurred for a named file, but the host verified that frozen file is still available. Correct the path and requested range in this same session."] : []),
					...(!parsed ? [`Your last response also failed the required strict JSON schema: ${invalidReason}. Repair its format after inspecting the missing evidence.`,
						...fixedValidationFeedback] : []),
					...(noReadProgress ? ["The last repair turn added no verified read coverage. Replan how to use objective_evidence_read rather than repeating the same unsupported verdict."] : []),
					...responseSchema,
					"In this same session, read every requested range. Whole-file requirements need an untruncated final page; cited spans need each cited line. Then reassess the unchanged original objective and return a new strict JSON assessment. Do not repeat the prior verdict without inspecting the missing evidence; no task may be dispatched or goal closed from incomplete required or cited evidence."].join("\n\n");
				continue;
			}
			if (!parsed || !assessment) {
				// Full evidence coverage cannot turn a single malformed model verdict
				// into a terminal mission outcome. Correct it in the same read-only
				// session; no work or scientific claim is admitted from this response.
				const admission = currentObjectiveAdmission(input.advanceAdmission());
				if (admission !== "admitted") return { assessment: latestAssessment, stopReason: admission };
				const repair = await repairFailure("invalid-assessment", {
					validation: invalidReason ?? "assessment schema invalid",
					path: validationFailure?.validationPath ?? "$",
					detail: validationFailure?.validationDetail ?? null });
				if (repair === "fresh-context") continue;
				if (repair !== "same-session-feedback") return { assessment: latestAssessment, stopReason: repair };
				request = [`Your previous response failed host validation: ${invalidReason ?? "assessment schema invalid"}.`,
					...fixedValidationFeedback,
					...responseSchema,
					"The frozen evidence was already returned in full in this session. Reassess the unchanged original objective and user overrides, repair your own schema or reasoning, and return a fresh valid assessment. This invalid response did not authorize a task or close the mission."].join("\n\n");
				continue;
			}
			if (parsed.decision === "blocked") {
				const available = capabilities?.filter(item => item.available && supportedTaskScopes.includes(item.scope)) ?? [];
				const actionable = parsed.groundedAssessment?.issues.some(item => item.status === "open" &&
					(item.classification === "explicit-requirement" || item.classification === "necessary-verification"));
				if (!available.length || parsed.groundedAssessment && !actionable)
					return { assessment, stopReason: "model-reported-blocked" };
				await recordRejectedReply({ code: "m07.objective-control",
					message: "blocked verdict still has an available actionable capability",
					path: "$.decision" });
				const admission = currentObjectiveAdmission(input.advanceAdmission());
				if (admission !== "admitted") return { assessment, stopReason: admission };
				const repair = await repairFailure("blocked-with-capability", {
					unresolvedObligations: [...parsed.unresolvedObligations].sort() });
				if (repair === "fresh-context") continue;
				if (repair !== "same-session-feedback") return { assessment, stopReason: repair };
				request = [challengedBlocked ? "Your blocked verdict remains provisional while verified execution capabilities are available. Reassess the unchanged objective and choose a feasible next task." :
					"Reassess every remaining requirement against the available capabilities before treating the original objective as blocked.",
					`Unresolved obligations: ${parsed.unresolvedObligations.map(id => `${id}: ${contract.obligations.find(item => item.id === id)!.description}`).join("; ")}`,
					...parsed.unresolvedDetails.map(detail => `Open issue: ${detail}`),
					"Unavailable optional equipment alone does not establish that all feasible work is exhausted. Choose a feasible pending part and return it as nextTask. Keep any genuinely unavailable work unresolved.",
					...available.map(item => `${item.scope}: ${item.description}; limits: ${item.limits.join("; ")}`),
					...responseSchema,
					"Preserve user overrides and return a fresh strict JSON assessment."].join("\n\n");
				challengedBlocked = true;
				continue;
			}
			if (parsed.decision === "fulfilled") return { assessment, stopReason: "model-closure-unverified" };
			const proposed = parsed.nextTask!;
			const supported = supportedTaskScopes.includes(proposed.adapterScope) &&
				(capabilities === undefined || capabilities.some(item => item.scope === proposed.adapterScope && item.available));
			if (supported) {
				const admission = currentObjectiveAdmission(input.advanceAdmission());
				if (admission !== "admitted") return { assessment, stopReason: admission };
				const advanced = await input.advance(proposed);
				return { assessment, advanced, stopReason: "objective-reassessment-pending" };
			}
			if (!capabilities?.some(item => item.available && supportedTaskScopes.includes(item.scope)))
				return { assessment, stopReason: "next-task-needs-capability" };
			await recordRejectedReply({ code: "m07.objective-control",
				message: "next task has no observed available adapter",
				path: "$.nextTask.adapterScope" });
			const key = JSON.stringify(proposed);
			const repeatedUnsupported = unsupported.has(key);
			unsupported.add(key);
			blockedProposals.push(proposed);
			assessment.blockedProposals = [...blockedProposals];
			await input.recordAssessment?.(assessment);
			const admission = currentObjectiveAdmission(input.advanceAdmission());
			if (admission !== "admitted") return { assessment, stopReason: admission };
			const repair = await repairFailure("unsupported-next-task", {
				addresses: [...proposed.addresses].sort(), adapterScope: proposed.adapterScope });
			if (repair === "fresh-context") continue;
			if (repair !== "same-session-feedback") return { assessment, stopReason: repair };
			request = ["Your preceding nextTask cannot be dispatched by the observed host capabilities.",
				...(repeatedUnsupported ? ["This repeats an unavailable proposal. Revisit the evidence and choose an actually available next action; repetition alone does not close the original objective."] : []),
				"Keep that proposal and its unresolved requirement in your assessment history. Choose another feasible pending part of the same original task if one exists. Do not treat unavailable optional equipment as proof the entire mission is blocked. If no feasible pending work exists, explain which host limits block each remaining part before returning blocked.",
				"Available adapters:", ...(capabilities ?? []).filter(item => item.available).map(item =>
					`${item.scope}: ${item.description}; limits: ${item.limits.join("; ")}`),
				...responseSchema,
				"Preserve the user's overrides and return a fresh strict JSON assessment. Read frozen evidence again if needed."].join("\n\n");
		}
	} finally { handle.dispose(); }
	} catch (error) {
		if (!sessionCreated) {
			try { input.recordException?.(preSessionStage, error); }
			catch { /* Preserve the initiating pre-session exception. */ }
		}
		throw error;
	}
}

export async function writeOriginalObjectiveContract(file: string, contract: OriginalObjectiveContractV1): Promise<void> {
	if (path.basename(file) !== "original-objective.json") throw new HarnessError("m07.objective", "original contract file name is invalid");
	await writeFile(file, `${JSON.stringify(contract, null, 2)}\n`, { flag: "wx", mode: 0o600 });
}

export async function writeObjectiveProgress(file: string, progress: ObjectiveProgressV1): Promise<void> {
	if (path.basename(file) !== "objective-checkpoint.json") throw new HarnessError("m07.objective", "objective checkpoint file name is invalid");
	const temporary = `${file}.${process.pid}.tmp`;
	await writeFile(temporary, `${JSON.stringify(progress, null, 2)}\n`, { mode: 0o600 });
	await rename(temporary, file);
}
