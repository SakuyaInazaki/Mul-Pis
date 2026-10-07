import { createHash, randomUUID } from "node:crypto";
import { copyFile, lstat, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { openBoundedSession, type EvidenceBindingV1 } from "../context/boundary.ts";
import type { SessionRunner, SessionSpec } from "../runner/types.ts";
import type { DeepSeekRequestViolation } from "../runner/deepseek-request-contract.ts";
import type { StageRunRecord } from "../types.ts";
import { HarnessError } from "../types.ts";

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
}

/** Decoded old checkpoints may contain these retired quota reasons. New execution never emits them. */
export type HistoricalObjectiveStopReason = "budget-boundary" | "provider-call-limit" |
	"time-boundary" | "no-progress" | "capability-replan-stalled";
export type CurrentObjectiveStopReason = "accounting-integrity-error" |
	"cancelled" | "output-limit" | "assessment-failed" |
	"assessment-invalid" | "assessment-evidence-unread" | "assessment-evidence-suspended" | "model-reported-blocked" | "model-closure-unverified" |
	"original-checks-unverified" | "assessment-validation-pending" | "next-task-pending" | "next-task-needs-capability" |
	"objective-reassessment-pending" | "dispatch-failed" |
	"request-contract-invalid" |
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
	"refresh-auth" | "supply-capability";
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
	failedStage?: "read-only-assessor" | "m07-execution";
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
	"restore-evidence", "retry-transport", "refresh-auth", "supply-capability"];
const pendingSafeties: PendingActionSafetyV1[] = ["same-session-read-only", "fresh-work-only",
	"no-replay-until-reconciled"];
const objectiveStopReasons: CurrentObjectiveStopReason[] = [
	"accounting-integrity-error", "cancelled", "output-limit", "assessment-failed",
	"assessment-invalid", "assessment-evidence-unread", "assessment-evidence-suspended", "model-reported-blocked",
	"model-closure-unverified", "original-checks-unverified", "assessment-validation-pending",
	"next-task-pending", "next-task-needs-capability", "objective-reassessment-pending", "dispatch-failed",
	"request-contract-invalid",
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
	if (hostFacts.failedStage !== undefined && hostFacts.failedStage !== "read-only-assessor" &&
		hostFacts.failedStage !== "m07-execution")
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
	if (hostFacts.m04TransactionUnresolved || stopReason === "m04-transaction-unresolved") {
		kind = "reconcile-m04-transaction";
		safety = "no-replay-until-reconciled";
	} else if (hostFacts.unresolvedOperationRefs?.length) {
		kind = "reconcile-m07-operation";
		safety = "no-replay-until-reconciled";
	} else if (stopReason === "accounting-integrity-error") {
		kind = "retry-transport";
		safety = "no-replay-until-reconciled";
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
		...(human && safety !== "no-replay-until-reconciled" ?
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
		action.kind !== "reconcile-m04-transaction") ||
		(action.kind === "reconcile-m07-operation" && operationRefs.length === 0) ||
		(action.kind === "reconcile-m04-transaction" && stopReason !== "m04-transaction-unresolved"))
		throw new HarnessError("m07.objective", "pending action cannot relabel unresolved effects");
	const requiredRepairKind: Partial<Record<CurrentObjectiveStopReason, PendingActionKindV1>> = {
		"assessment-evidence-unread": "retry-evidence-read",
		"assessment-evidence-suspended": "restore-evidence",
		"m04-evidence-incomplete": "retry-evidence-read",
		"m04-draft-rejected": "repair-rejected-m04",
		"request-contract-invalid": "repair-request-contract",
		"model-reported-blocked": "retry-readonly-assessment",
		"model-closure-unverified": "retry-readonly-assessment",
		"original-checks-unverified": "retry-readonly-assessment",
		"assessment-invalid": "retry-readonly-assessment",
		"next-task-needs-capability": "supply-capability",
		"output-limit": "retry-transport",
	};
	const required = requiredRepairKind[stopReason];
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

function parseAssessment(text: string, contract: OriginalObjectiveContractV1, evidenceNames: string[]): ModelObjectiveAssessmentV1 {
	let value: unknown;
	try { value = JSON.parse(text); } catch { throw new HarnessError("m07.objective-assessment", "assessment is not strict JSON"); }
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new HarnessError("m07.objective-assessment", "assessment object is invalid");
	const raw = value as Record<string, unknown>;
	const ids = new Set(contract.obligations.map(item => item.id));
	const names = new Set(evidenceNames);
	const strings = (item: unknown, allowed: Set<string>): item is string[] =>
		Array.isArray(item) && item.every(part => typeof part === "string" && allowed.has(part)) && new Set(item).size === item.length;
	const details = (item: unknown): item is string[] => Array.isArray(item) &&
		item.every(part => nonemptyText(part)) && new Set(item).size === item.length;
	if (raw.version !== 1 || typeof raw.decision !== "string" || !["fulfilled", "continue", "blocked"].includes(raw.decision) ||
		!nonemptyText(raw.rationale) || !strings(raw.evidenceRefs, names) ||
		!strings(raw.unresolvedObligations, ids) || !details(raw.unresolvedDetails))
		throw new HarnessError("m07.objective-assessment", "assessment fields are invalid");
	const decision = raw.decision as ModelObjectiveAssessmentV1["decision"];
	let nextTask: ObjectiveNextTaskV1 | undefined;
	if (raw.nextTask !== undefined) {
		if (!raw.nextTask || typeof raw.nextTask !== "object" || Array.isArray(raw.nextTask))
			throw new HarnessError("m07.objective-assessment", "next task object is invalid");
		const task = raw.nextTask as Record<string, unknown>;
		if (!nonemptyText(task.objective) || !strings(task.addresses, ids) ||
			!safeAdapterId(task.adapterScope) ||
			!task.addresses.length || task.addresses.some(item => !(raw.unresolvedObligations as string[]).includes(item)))
			throw new HarnessError("m07.objective-assessment", "next task does not address unresolved original obligations");
		nextTask = { objective: task.objective, addresses: task.addresses,
			adapterScope: task.adapterScope as ObjectiveNextTaskV1["adapterScope"] };
	}
	if ((decision === "continue" && (!raw.unresolvedObligations.length || !raw.unresolvedDetails.length || !nextTask)) ||
		(decision === "fulfilled" && (raw.unresolvedObligations.length || raw.unresolvedDetails.length || !raw.evidenceRefs.length || nextTask)) ||
		(decision === "blocked" && (!raw.unresolvedObligations.length || !raw.unresolvedDetails.length || nextTask)))
		throw new HarnessError("m07.objective-assessment", "decision and unresolved obligations conflict");
	return { version: 1, decision, rationale: raw.rationale, evidenceRefs: raw.evidenceRefs,
		unresolvedObligations: raw.unresolvedObligations, unresolvedDetails: raw.unresolvedDetails,
		...(nextTask ? { nextTask } : {}) };
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
			...(input.assessment?.nextTask && input.assessment.unreadEvidence.length === 0 && !input.nextTaskDispatched ?
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
	/** Task adapters own artifact names and semantic evidence contracts. */
	evidenceRequirements?: { requiredNames: string[]; instructions?: string };
	assessmentAdmission: "admitted" | CurrentObjectiveStopReason;
	advanceAdmission: () => "admitted" | CurrentObjectiveStopReason;
	supportedTaskScopes: ObjectiveNextTaskV1["adapterScope"][];
	capabilities?: ObjectiveCapabilityV1[];
	/** Current user policy, applied without rewriting a frozen prior contract. */
	userOverrides?: string[];
	recordAssessment?: (assessment: NonNullable<ObjectiveProgressV1["assessment"]>) => Promise<void>;
	advance: (task: ObjectiveNextTaskV1) => Promise<T>;
}): Promise<{ assessment?: ObjectiveProgressV1["assessment"]; advanced?: T; stopReason: CurrentObjectiveStopReason }> {
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
	if (input.supportedTaskScopes.some(scope => !safeAdapterId(scope)) ||
		new Set(input.supportedTaskScopes).size !== input.supportedTaskScopes.length)
		throw new HarnessError("m07.objective", "supported adapter IDs are invalid");
	if (input.evidenceRequirements && (!Array.isArray(input.evidenceRequirements.requiredNames) ||
		input.evidenceRequirements.requiredNames.some(name => !safeName(name) || !input.evidence.some(item => item.name === name)) ||
		(input.evidenceRequirements.instructions !== undefined && !nonemptyText(input.evidenceRequirements.instructions))))
		throw new HarnessError("m07.objective", "required adapter evidence is missing or invalid");

	const contractBytes = await readFile(input.contractFile);
	if (contractBytes.length > MAX_EVIDENCE_BYTES) throw new HarnessError("m07.objective", "original objective contract exceeds evidence file size boundary");
	if (contractBytes.toString("utf8") !== `${JSON.stringify(input.contract, null, 2)}\n`)
		throw new HarnessError("m07.objective", "original objective contract changed after freezing");
	// Keep only per-file metadata. Evidence is read through a paged tool by the assessor;
	// an aggregate byte cap would reject a valid collection before any such read.
	const materials: Array<{ name: string; file: string; lineCount: number; digest: string }> = [];
	for (const item of input.evidence) {
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
	await mkdir(input.evidenceRoot, { mode: 0o700 });
	const frozenContract = path.join(input.evidenceRoot, "original-objective.json");
	await copyFile(input.contractFile, frozenContract);
	if (!(await readFile(frozenContract)).equals(contractBytes))
		throw new HarnessError("m07.objective", "frozen original objective changed during copy");
	const evidence: EvidenceBindingV1[] = [
		{ version: 1, label: "frozen original objective", path: frozenContract, status: "frozen-copy", sourceVersion: input.contract.id },
	];
	for (const item of materials) {
		const copy = path.join(input.evidenceRoot, item.name);
		await copyFile(item.file, copy);
		const frozen = await readFile(copy);
		if (frozen.length > MAX_EVIDENCE_BYTES || createHash("sha256").update(frozen).digest("hex") !== item.digest)
			throw new HarnessError("m07.objective", "frozen objective evidence changed during copy");
		evidence.push({ version: 1, label: item.name, path: copy, status: "frozen-copy", sourceVersion: input.contract.id });
	}
	const spec: SessionSpec = { ...input.sessionSpec,
		tools: { kind: "read-dir", root: input.evidenceRoot, toolName: "objective_evidence_read" } };
	const handle = await openBoundedSession(input.runner, input.runRecord, {
		mode: "fresh", intent: "independent-judgment", reason: "Assess the original user goal from frozen bounded evidence before choosing further M07 work",
		evidence, spec,
	}, input.persistReceipt);
	try {
		const prompt = ["# Original objective (unchanged)", input.contract.goal,
			"# User overrides (higher priority than supplied task material)",
			...(input.userOverrides ?? input.contract.userOverrides ?? []),
			"# Original obligations", ...input.contract.obligations.map(item => `${item.id}: ${item.description}`),
			"# Observed execution capabilities", ...(input.capabilities ?? []).map(item =>
				`${item.scope}: ${item.available ? "available" : "unavailable"}; ${item.description}; limits: ${item.limits.join("; ")}`),
			`Closure policy: ${input.contract.closure}. A bounded child goal and accepted candidate do not alone establish original-goal completion.`,
			input.evidenceRequirements?.instructions ?? "Read all supplied material; the caller identifies the original inputs and the meaning of artifact names.",
			"# Frozen bounded evidence", "Use objective_evidence_read to read the complete original-objective.json and every listed file. If a file is paginated, read every page including the untruncated end. The file names are:",
			...materials.map(item => item.name),
			"Return only strict JSON with version 1, decision (fulfilled, continue, or blocked), rationale, evidenceRefs (file names above), unresolvedObligations (IDs above), unresolvedDetails (your concrete open requirements from the full original assignment), and when continuing nextTask {objective, addresses, adapterScope}. Use a scope only when its observed host capability covers your proposed work. If a proposed task has no available registered executor, retain it as unresolved and name the unavailable capability explicitly. The host may ask you to replan feasible work; preserve unresolved requirements. Assess honestly. Propose the next scientific work yourself from unresolved original obligations; do not change task permissions or claim a global optimum from a finite evaluation."].join("\n\n");
		const frozenFileAccessible = async (name: string): Promise<boolean> => {
			try {
				const file = path.join(input.evidenceRoot, name);
				const info = await lstat(file);
				if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_EVIDENCE_BYTES) return false;
				const bytes = await readFile(file);
				if (name === "original-objective.json") return bytes.equals(contractBytes);
				const expected = materials.find(item => item.name === name)?.digest;
				return bytes.length <= MAX_EVIDENCE_BYTES && expected !== undefined &&
					createHash("sha256").update(bytes).digest("hex") === expected;
			} catch { return false; }
		};
		const coverage = (name: string, lines: number): { complete: boolean; score: number; nextRange: string } => {
			const returned = handle.readReturnEvents();
			const rows = returned.filter(item => item.toolName === "objective_evidence_read" && item.path === name &&
				item.status === "returned" && item.returned.kind === "text" && item.returned.startLine !== undefined &&
				item.returned.endLine !== undefined && item.returned.startLine >= 1 &&
				item.returned.endLine >= item.returned.startLine && item.returned.endLine <= lines);
			const covered = new Set<number>();
			for (const row of rows) for (let line = row.returned.startLine!; line <= row.returned.endLine! && line <= lines; line++) covered.add(line);
			const reachedUntruncatedEnd = rows.some(item => item.returned.endLine === lines && item.returned.truncated === false);
			let start = 1;
			while (start <= lines && covered.has(start)) start++;
			let end = start;
			while (end < lines && !covered.has(end + 1)) end++;
			const offset = start <= lines ? start : Math.max(1, lines);
			const limit = start <= lines ? end - start + 1 : 1;
			return { complete: reachedUntruncatedEnd && covered.size === lines,
				score: covered.size + Number(reachedUntruncatedEnd),
				nextRange: `${name}: objective_evidence_read path="${name}" offset=${offset} limit=${limit}${start > lines ? " (request the untruncated final page)" : ""}` };
		};
		const contractText = contractBytes.toString("utf8");
		const readMaterials = [{ name: "original-objective.json", lineCount: contractText.split("\n").length - (contractText.endsWith("\n") ? 1 : 0) }, ...materials];
		const proposals: ModelObjectiveAssessmentV1[] = [];
		const unsupported = new Set<string>();
		const blockedProposals: ObjectiveNextTaskV1[] = [];
		let challengedBlocked = false;
		let latestAssessment: ObjectiveProgressV1["assessment"];
		let priorUnreadScore: number | undefined;
		let readEventCursor = 0;
		let request = prompt;
		for (;;) {
			let response;
			try { response = await handle.prompt(request); }
			catch {
				const admission = currentObjectiveAdmission(input.advanceAdmission());
				return { assessment: latestAssessment, stopReason: admission === "admitted" ? "assessment-failed" : admission };
			}
			const returned = handle.readReturnEvents();
			const newReadEvents = returned.slice(readEventCursor);
			readEventCursor = returned.length;
			const fileCoverage = readMaterials.map(item => ({ name: item.name, ...coverage(item.name, item.lineCount) }));
			const evidenceRead = fileCoverage.filter(item => item.complete).map(item => item.name);
			const unreadEvidence = fileCoverage.filter(item => !item.complete).map(item => item.name);
			const unreadScore = fileCoverage.reduce((sum, item) => sum + item.score, 0);
			let parsed: ModelObjectiveAssessmentV1 | undefined;
			let invalidReason: string | undefined;
			try { parsed = parseAssessment(response.text, input.contract,
				["original-objective.json", ...materials.map(item => item.name)]); }
			catch (error) {
				if (!(error instanceof HarnessError) || error.code !== "m07.objective-assessment") throw error;
				// Parser reasons are fixed host text, never the model's response or private evidence.
				invalidReason = error.message;
			}
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
				// An unchanged response is not a mission stop: keep prompting this same
				// assessor until read proof arrives or a real host/tool boundary occurs.
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
				const admission = currentObjectiveAdmission(input.advanceAdmission());
				if (admission !== "admitted") return { assessment: latestAssessment, stopReason: admission };
				request = ["Your previous assessment is provisional because required frozen evidence was not completely returned by objective_evidence_read.",
					`Unread or incomplete files: ${unreadEvidence.join(", ")}.`,
					...fileCoverage.filter(item => !item.complete).map(item => item.nextRange),
					...(failedReads.length ? ["A read tool error occurred for a named file, but the host verified that frozen file is still available. Correct the path and requested range in this same session."] : []),
					...(!parsed ? [`Your last response also failed the required strict JSON schema: ${invalidReason}. Repair its format after inspecting the missing evidence.`] : []),
					...(noReadProgress ? ["The last repair turn added no verified read coverage. Replan how to use objective_evidence_read rather than repeating the same unsupported verdict."] : []),
					"In this same session, read every missing range of each named file, including an untruncated final page. Then reassess the unchanged original objective and return a new strict JSON assessment. Do not repeat the prior verdict without inspecting the missing evidence; no task may be dispatched or goal closed from an incomplete read."].join("\n\n");
				continue;
			}
			if (!parsed || !assessment) {
				// Full evidence coverage cannot turn a single malformed model verdict
				// into a terminal mission outcome. Correct it in the same read-only
				// session; no work or scientific claim is admitted from this response.
				const admission = currentObjectiveAdmission(input.advanceAdmission());
				if (admission !== "admitted") return { assessment: latestAssessment, stopReason: admission };
				request = [`Your previous response failed host validation: ${invalidReason ?? "assessment schema invalid"}.`,
					"Return one strict JSON object only, with version 1, decision (fulfilled, continue, or blocked), a nonempty rationale, unique evidenceRefs chosen from the frozen file names, unique unresolvedObligations chosen from the original obligation IDs, and unique nonempty unresolvedDetails.",
					"For continue, include unresolved obligations and details plus nextTask {objective, addresses, adapterScope}; addresses must be nonempty and contained in unresolvedObligations. For fulfilled, leave unresolved obligations and details empty, cite evidence, and omit nextTask. For blocked, retain unresolved obligations and details and omit nextTask.",
					"The frozen evidence was already returned in full in this session. Reassess the unchanged original objective and user overrides, repair your own schema or reasoning, and return a fresh valid assessment. This invalid response did not authorize a task or close the mission."].join("\n\n");
				continue;
			}
			if (parsed.decision === "blocked") {
				const available = input.capabilities?.filter(item => item.available && input.supportedTaskScopes.includes(item.scope)) ?? [];
				if (!available.length) return { assessment, stopReason: "model-reported-blocked" };
				const admission = currentObjectiveAdmission(input.advanceAdmission());
				if (admission !== "admitted") return { assessment, stopReason: admission };
				request = [challengedBlocked ? "Your blocked verdict remains provisional while verified execution capabilities are available. Reassess the unchanged objective and choose a feasible next task." :
					"Reassess every remaining requirement against the available capabilities before treating the original objective as blocked.",
					`Unresolved obligations: ${parsed.unresolvedObligations.map(id => `${id}: ${input.contract.obligations.find(item => item.id === id)!.description}`).join("; ")}`,
					...parsed.unresolvedDetails.map(detail => `Open issue: ${detail}`),
					"Unavailable optional equipment alone does not establish that all feasible work is exhausted. Choose a feasible pending part and return it as nextTask. Keep any genuinely unavailable work unresolved.",
					...available.map(item => `${item.scope}: ${item.description}; limits: ${item.limits.join("; ")}`),
					"Preserve user overrides and return the same strict JSON schema."].join("\n\n");
				challengedBlocked = true;
				continue;
			}
			if (parsed.decision === "fulfilled") return { assessment, stopReason: "model-closure-unverified" };
			const proposed = parsed.nextTask!;
			const supported = input.supportedTaskScopes.includes(proposed.adapterScope) &&
				(input.capabilities === undefined || input.capabilities.some(item => item.scope === proposed.adapterScope && item.available));
			if (supported) {
				const admission = currentObjectiveAdmission(input.advanceAdmission());
				if (admission !== "admitted") return { assessment, stopReason: admission };
				const advanced = await input.advance(proposed);
				return { assessment, advanced, stopReason: "objective-reassessment-pending" };
			}
			if (!input.capabilities?.some(item => item.available && input.supportedTaskScopes.includes(item.scope)))
				return { assessment, stopReason: "next-task-needs-capability" };
			const key = JSON.stringify(proposed);
			const repeatedUnsupported = unsupported.has(key);
			unsupported.add(key);
			blockedProposals.push(proposed);
			assessment.blockedProposals = [...blockedProposals];
			await input.recordAssessment?.(assessment);
			const admission = currentObjectiveAdmission(input.advanceAdmission());
			if (admission !== "admitted") return { assessment, stopReason: admission };
			request = ["Your preceding nextTask cannot be dispatched by the observed host capabilities.",
				...(repeatedUnsupported ? ["This repeats an unavailable proposal. Revisit the evidence and choose an actually available next action; repetition alone does not close the original objective."] : []),
				"Keep that proposal and its unresolved requirement in your assessment history. Choose another feasible pending part of the same original task if one exists. Do not treat unavailable optional equipment as proof the entire mission is blocked. If no feasible pending work exists, explain which host limits block each remaining part before returning blocked.",
				"Available adapters:", ...(input.capabilities ?? []).filter(item => item.available).map(item =>
					`${item.scope}: ${item.description}; limits: ${item.limits.join("; ")}`),
				"Preserve the user's overrides and return the same strict JSON schema. Read frozen evidence again if needed."].join("\n\n");
		}
	} finally { handle.dispose(); }
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
