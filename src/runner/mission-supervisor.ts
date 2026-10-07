/**
 * A process-boundary planner for an unfinished original objective. The caller
 * authenticates the terminal run, encrypted carry and redacted checkpoint
 * before constructing this snapshot. This module neither starts an Actions run
 * nor grants a resumed session access to an earlier operation or store.
 */
import { createHash } from "node:crypto";
import { classifyPendingAction, validatePendingAction } from "../m07/objective-progress.ts";
import type { ObjectiveStopReason, PendingActionV1 } from "../m07/objective-progress.ts";
import { isVerifiedLinkedUnknownDelivery, isVerifiedWorkflowRepairPlan,
	type VerifiedWorkflowRepairPlanV1 } from "./mission-host-adapter.ts";
import type { TestedControlBinding } from "./mission-resume-journal.ts";
import { isVerifiedInterruptedSourceCapability,
	type VerifiedInterruptedSourceCapabilityV1 } from "./interrupted-source-review.ts";

type Source = Readonly<{ runId: string; runAttempt: number; commit: string }>;
const hex64 = (value: unknown): value is string =>
	typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
const sourceId = (value: unknown): value is Source => Boolean(value) &&
	typeof value === "object" && !Array.isArray(value) &&
	typeof (value as Source).runId === "string" && /^[1-9][0-9]{0,17}$/.test((value as Source).runId) &&
	Number.isSafeInteger((value as Source).runAttempt) && (value as Source).runAttempt > 0 &&
	typeof (value as Source).commit === "string" && /^[0-9a-f]{40}$/.test((value as Source).commit);
const ref = (value: unknown): value is string => typeof value === "string" &&
	value.length > 0 && !/[\r\n\0]/.test(value);
const refs = (value: unknown): value is string[] => Array.isArray(value) &&
	value.every(ref) && new Set(value).size === value.length;
const sameSet = (a: readonly string[], b: readonly string[]): boolean =>
	a.length === b.length && a.every(value => b.includes(value));
const fail = (reason: string): never => { throw new Error(`mission supervisor refused: ${reason}`); };

/** The status is a host projection of an authenticated private checkpoint. */
export type MissionStatusV1 = Readonly<{
	version: 1; kind: "host-redacted-mission-status";
	contractId: string; objectiveOutcome: "incomplete" | "fulfilled";
	stopReason: ObjectiveStopReason | null;
	selectedTupleSha256: string;
	unresolvedOperationRefs: readonly string[];
	pendingAction?: PendingActionV1;
}>;

/** The host verifier must bind these fields to the same terminal Actions run,
 * encrypted carry, and exact checkpoint. A serialized claim alone is not proof.
 */
export type TerminalCarryEvidenceV1 = Readonly<{
	version: 1; kind: "host-verified-terminal-carry";
	source: Source; envelopeSha256: string;
	contractId: string; selectedTupleSha256: string;
	pendingActionSha256: string | null;
	checkpointSha256?: string;
	terminal: Readonly<{ runStatus: "completed"; jobStatus: "completed";
		providerStepStatus: "completed" }>;
}>;

/** A later executed Actions run ended without a carry. This binds the opaque
 * result archive to the last authenticated carry; it grants no authority from
 * the interrupted run's research files or incomplete accounting. */
export type TerminalInterruptionEvidenceV1 = Readonly<{
	version: 1; kind: "host-verified-terminal-interruption";
	source: Source; priorCarrySource: Source; priorCarryEnvelopeSha256: string;
	resultArtifactId: string; resultArchiveSha256: string;
	accounting: "unquantified"; effects: "unknown-unreconciled";
	terminationOrigin: "unknown";
}>;

/** An Actions cancellation or process abort does not establish who requested it. */
export type HostCancellationEventV1 = Readonly<{
	version: 1; kind: "host-verified-cancellation-origin";
	source: Source; envelopeSha256: string; evidenceRef: string;
	origin: "explicit-user-request" | "platform-interruption";
}>;

/** The trigger owns durable, externally reconciled idempotency. A reservation
 * whose delivery is uncertain cannot be treated as an unsent request. */
export type ResumeDispatchRecord =
	| Readonly<{ state: "not-requested" }>
	| Readonly<{ state: "reserved" | "delivery-unknown"; idempotencyKey: string }>
	| Readonly<{ state: "acknowledged"; idempotencyKey: string; successorRunId: string }>;

/** Required before an UNKNOWN historical operation can coexist with new work.
 * The host checks the actual fresh workspace and tool grant, then certifies
 * that the proposed branch does not consume the old operation's result. */
export type FreshIndependentWorkEvidenceV1 = Readonly<{
	version: 1; kind: "host-verified-fresh-independent-work";
	source: Source; envelopeSha256: string; selectedTupleSha256: string;
	pendingActionSha256: string; isolatedWorkspace: true; emptyStore: true;
	noPriorSessionResume: true; confinedGrants: true;
	nextTaskDependency: "independent" | "dependent" | "unknown";
}>;

/** A current host decision for an authenticated legacy checkpoint that predates
 * pendingAction. It is a new decision, never attributed to the old ciphertext. */
export type CurrentDerivedActionV1 = Readonly<{
	version: 1; kind: "current-host-derived-action";
	source: Source; envelopeSha256: string; selectedTupleSha256: string;
	checkpointSha256: string; action: PendingActionV1;
}>;

/** This decision is made NOW from a verified no-carry interruption. The older
 * checkpoint's action remains history and is never replayed as the new action. */
export type CurrentInterruptionActionV1 = Readonly<{
	version: 1; kind: "current-host-interruption-action";
	source: Source; priorCarryEnvelopeSha256: string;
	priorCheckpointSha256: string; resultArchiveSha256: string;
	action: PendingActionV1;
}>;

/** A verified launch contract promises a successor will enforce the existing
 * fresh-work boundary. It does not claim the future workspace already exists. */
export type FreshIndependentLaunchContractV1 = Readonly<{
	version: 1; kind: "verified-fresh-launch-contract";
	source: Source; envelopeSha256: string; selectedTupleSha256: string;
	pendingActionSha256: string; testedSourceCommit: string; testedTree: string;
	requiresRuntimeAttestationBeforeModel: true; mode: "fresh-work-only";
}>;

/** A host-authenticated observation that an earlier control commit reached the
 * ref but still has no observed Actions run. Its delivery/effects remain UNKNOWN.
 * A serialized object is not authority; the host adapter must brand it. */
export type LinkedUnknownDeliveryV1 = Readonly<{
	version: 1; kind: "host-verified-linked-unknown-delivery";
	oldJournalKey: string; oldControlCommit: string;
	/** Digest of a private, source-bound operator confinement review. */
	oldSourceReviewReceiptSha256: string;
	/** Complete unresolved accepted-control lineage, oldest to immediate parent. */
	ancestry: readonly Readonly<{ oldJournalKey: string; oldControlCommit: string }>[];
	oldTestedSourceCommit: string; oldTestedTree: string;
	liveControlHead: string;
	census: Readonly<{ kind: "authenticated-complete-actions-run-census";
		headCommit: string; totalCount: 0; pagesRead: 1; sha256: string }>;
	newTestedSourceCommit: string; newTestedTree: string;
	newSuccessfulCi: TestedControlBinding["successfulCi"];
	sourceRefTip: string;
	accounting: "unquantified"; effects: "unknown-unreconciled";
}>;

export type SupervisorSnapshot = Readonly<{
	status: MissionStatusV1;
	pendingAction?: PendingActionV1;
	currentDerivedAction?: CurrentDerivedActionV1;
	currentInterruptionAction?: CurrentInterruptionActionV1;
	terminalCarry?: TerminalCarryEvidenceV1;
	terminalInterruption?: TerminalInterruptionEvidenceV1;
	cancellationEvent?: HostCancellationEventV1;
	freshIndependentWork?: FreshIndependentWorkEvidenceV1;
	freshLaunchContract?: FreshIndependentLaunchContractV1;
	interruptedSourceReview?: VerifiedInterruptedSourceCapabilityV1;
	workflowRepairPlan?: VerifiedWorkflowRepairPlanV1;
	linkedUnknownDelivery?: LinkedUnknownDeliveryV1;
	dispatchRecord: ResumeDispatchRecord;
}>;

export type ResumeIntent = Readonly<{
	version: 1; kind: "fresh-independent-mission-resume";
	idempotencyKey: string; source: Source; envelopeSha256: string;
	contractId: string; selectedTupleSha256: string; pendingActionSha256: string;
	actionKind: PendingActionV1["kind"];
	pendingAction: PendingActionV1;
	actionProvenance?: Readonly<{ kind: "current-host-derived"; checkpointSha256: string } |
		{ kind: "current-host-interruption"; priorCheckpointSha256: string;
			resultArchiveSha256: string }>;
	terminalInterruption?: TerminalInterruptionEvidenceV1;
	/** Private receipt identity and exact reviewed source; never enters the control descriptor. */
	interruptedSourceReview?: Readonly<{ source: Source; sourceTree: string; receiptSha256: string }>;
	/** Private review identity; never enters the public control descriptor. */
	workflowRepair?: Readonly<{ reviewedPlanSha256: string; testedSourceCommit: string;
		testedTree: string; successfulCi: VerifiedWorkflowRepairPlanV1["replacement"]["successfulCi"] }>;
	linkedUnknownDelivery?: LinkedUnknownDeliveryV1;
	/** The new process must start with no prior session or shared store. */
	boundary: "new-isolated-workspace-no-prior-session-resume";
	/** These effects stay UNKNOWN. The new run may work on independent tasks. */
	quarantinedOperationRefs: readonly string[];
	m04TransactionQuarantined: boolean;
}>;

export type SupervisorDecision =
	| Readonly<{ kind: "wait"; reason: "terminal-carry-unverified" | "dispatch-reserved" |
		"dispatch-delivery-unknown" | "successor-request-accepted" |
		"quarantined-operation-needs-reconciliation" | "accounting-chain-needs-reconciliation" |
		"user-cancelled" | "execution-interrupted" | "cancellation-origin-unverified" |
		"terminal-action-needs-reclassification" | "workflow-repair-plan-required" |
		"interruption-source-review-required";
		idempotencyKey?: string; successorRunId?: string }>
	| Readonly<{ kind: "restore-evidence"; evidenceRefs: readonly string[] }>
	| Readonly<{ kind: "exclusive-external-input";
		blocker: NonNullable<PendingActionV1["verifiedHumanBlocker"]> }>
	| Readonly<{ kind: "complete"; contractId: string }>
	| Readonly<{ kind: "dispatch"; intent: ResumeIntent }>;

/** Stable action identity; this is not a file hash or evidence manifest. */
function canonical(value: unknown): string {
	if (value === null || typeof value === "boolean" || typeof value === "string")
		return JSON.stringify(value);
	if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
		const entries = Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
		if (entries.some(([, part]) => part === undefined)) fail("pending action contains undefined fields");
		return `{${entries.map(([key, part]) => `${JSON.stringify(key)}:${canonical(part)}`).join(",")}}`;
	}
	return fail("pending action contains unsupported values");
}
const sha = (value: string): string => createHash("sha256").update(value).digest("hex");
export function pendingActionIdentity(action: PendingActionV1): string {
	validatePendingAction(action, action?.reasonCode ?? null);
	if (!action || action.version !== 1 || action.author !== "host" || !ref(action.kind) ||
		!ref(action.safety) || !ref(action.reasonCode) ||
		(action.target?.operationRefs !== undefined && !refs(action.target.operationRefs)) ||
		(action.evidenceRefs !== undefined && !refs(action.evidenceRefs)) ||
		Boolean(action.humanRequired) !== Boolean(action.verifiedHumanBlocker))
		fail("host pending action is invalid");
	if (action.verifiedHumanBlocker &&
		(action.verifiedHumanBlocker.verifiedBy !== "host" ||
			action.verifiedHumanBlocker.exclusiveRequiredAction !== true ||
			!ref(action.verifiedHumanBlocker.evidenceRef)))
		fail("external-input requirement is not independently host verified");
	return sha(canonical(action));
}

/** A pending action never changes the original objective's scientific verdict.
 * Unknown external effects are quarantined while independent fresh work can
 * continue. No fixed retry, time, or fee count appears in this planner. */
export function planMissionContinuation(snapshot: SupervisorSnapshot): SupervisorDecision {
	const { status, pendingAction, terminalCarry, terminalInterruption, dispatchRecord } = snapshot;
	if (status?.version !== 1 || status.kind !== "host-redacted-mission-status" ||
		!ref(status.contractId) || !hex64(status.selectedTupleSha256) ||
		!refs(status.unresolvedOperationRefs) ||
		!["incomplete", "fulfilled"].includes(status.objectiveOutcome))
		fail("redacted mission status is invalid");
	if (dispatchRecord?.state !== "not-requested" && dispatchRecord?.state !== "reserved" &&
		dispatchRecord?.state !== "delivery-unknown" && dispatchRecord?.state !== "acknowledged")
		fail("dispatch record is invalid");
	if (dispatchRecord.state !== "not-requested" &&
		(!hex64(dispatchRecord.idempotencyKey) ||
			(dispatchRecord.state === "acknowledged" &&
				!/^[1-9][0-9]{0,17}$/.test(dispatchRecord.successorRunId))))
		fail("dispatch record identity is invalid");
	if (!terminalCarry) return { kind: "wait", reason: "terminal-carry-unverified" };
	if (terminalCarry.version !== 1 || terminalCarry.kind !== "host-verified-terminal-carry" ||
		!sourceId(terminalCarry.source) || !hex64(terminalCarry.envelopeSha256) ||
		!hex64(terminalCarry.selectedTupleSha256) ||
		(terminalCarry.checkpointSha256 !== undefined && !hex64(terminalCarry.checkpointSha256)) ||
		terminalCarry.contractId !== status.contractId ||
		terminalCarry.selectedTupleSha256 !== status.selectedTupleSha256 ||
		terminalCarry.terminal?.runStatus !== "completed" ||
		terminalCarry.terminal.jobStatus !== "completed" ||
		terminalCarry.terminal.providerStepStatus !== "completed")
		fail("terminal carry does not bind redacted mission status");
	if (terminalInterruption && (terminalInterruption.version !== 1 ||
		terminalInterruption.kind !== "host-verified-terminal-interruption" ||
		!sourceId(terminalInterruption.source) || !sourceId(terminalInterruption.priorCarrySource) ||
		terminalInterruption.priorCarrySource.runId !== terminalCarry.source.runId ||
		terminalInterruption.priorCarrySource.runAttempt !== terminalCarry.source.runAttempt ||
		terminalInterruption.priorCarrySource.commit !== terminalCarry.source.commit ||
		terminalInterruption.priorCarryEnvelopeSha256 !== terminalCarry.envelopeSha256 ||
		terminalInterruption.source.runId === terminalCarry.source.runId ||
		!/^[1-9][0-9]{0,17}$/.test(terminalInterruption.resultArtifactId) ||
		!hex64(terminalInterruption.resultArchiveSha256) ||
		terminalInterruption.accounting !== "unquantified" ||
		terminalInterruption.effects !== "unknown-unreconciled" ||
		terminalInterruption.terminationOrigin !== "unknown"))
		fail("terminal interruption does not bind the authenticated prior carry");
	if (snapshot.cancellationEvent && !terminalInterruption && status.stopReason !== "cancelled")
		fail("cancellation origin is unrelated to current terminal status");
	if (terminalInterruption && snapshot.cancellationEvent) {
		const event = snapshot.cancellationEvent;
		if (event.version !== 1 || event.kind !== "host-verified-cancellation-origin" ||
			!sourceId(event.source) || !ref(event.evidenceRef) ||
			event.source.runId !== terminalInterruption.source.runId ||
			event.source.runAttempt !== terminalInterruption.source.runAttempt ||
			event.source.commit !== terminalInterruption.source.commit ||
			event.envelopeSha256 !== terminalCarry.envelopeSha256)
			fail("cancellation origin does not bind terminal interruption");
		if (event.origin === "explicit-user-request")
			return { kind: "wait", reason: "user-cancelled" };
		if (event.origin !== "platform-interruption")
			fail("cancellation origin is invalid");
	}
	if (status.objectiveOutcome === "fulfilled") {
		if (snapshot.linkedUnknownDelivery)
			fail("an unobserved old control delivery cannot close the mission");
		if (terminalInterruption)
			return { kind: "wait", reason: "accounting-chain-needs-reconciliation" };
		if (status.stopReason !== null || status.pendingAction !== undefined ||
			pendingAction !== undefined || terminalCarry.pendingActionSha256 !== null ||
			status.unresolvedOperationRefs.length) fail("fulfilled mission still has pending work");
		if (dispatchRecord.state === "reserved" || dispatchRecord.state === "delivery-unknown")
			return { kind: "wait", reason: dispatchRecord.state === "reserved" ?
				"dispatch-reserved" : "dispatch-delivery-unknown",
				idempotencyKey: dispatchRecord.idempotencyKey };
		if (dispatchRecord.state === "acknowledged")
			return { kind: "wait", reason: "successor-request-accepted",
				idempotencyKey: dispatchRecord.idempotencyKey,
				successorRunId: dispatchRecord.successorRunId };
		return { kind: "complete", contractId: status.contractId };
	}
	if (status.stopReason === "cancelled") {
		const event = snapshot.cancellationEvent;
		if (!event) return { kind: "wait", reason: "cancellation-origin-unverified" };
		if (event.version !== 1 || event.kind !== "host-verified-cancellation-origin" ||
			!sourceId(event.source) || !ref(event.evidenceRef) ||
			event.source.runId !== terminalCarry.source.runId ||
			event.source.runAttempt !== terminalCarry.source.runAttempt ||
			event.source.commit !== terminalCarry.source.commit ||
			event.envelopeSha256 !== terminalCarry.envelopeSha256 ||
			!["explicit-user-request", "platform-interruption"].includes(event.origin))
			fail("cancellation origin does not bind terminal carry");
		return { kind: "wait", reason: event.origin === "explicit-user-request" ?
			"user-cancelled" : "execution-interrupted" };
	}
	if (terminalInterruption && status.pendingAction?.humanRequired) {
		pendingActionIdentity(status.pendingAction);
		const blocker = status.pendingAction.verifiedHumanBlocker;
		if (!blocker)
			fail("authenticated prior exclusive input lacks host evidence");
		return { kind: "exclusive-external-input",
			blocker: blocker! };
	}
	if (terminalInterruption && status.stopReason === "accounting-integrity-error")
		return { kind: "wait", reason: "accounting-chain-needs-reconciliation" };
	if (terminalInterruption && status.stopReason === "workflow-repair-needed")
		return { kind: "wait", reason: "workflow-repair-plan-required" };
	if (terminalInterruption && status.stopReason === "assessment-evidence-suspended") {
		if (status.pendingAction) pendingActionIdentity(status.pendingAction);
		return { kind: "restore-evidence", evidenceRefs: status.pendingAction?.evidenceRefs ?? [] };
	}
	let action!: PendingActionV1;
	let actionSha!: string;
	let actionProvenance: ResumeIntent["actionProvenance"];
	let workflowRepair: ResumeIntent["workflowRepair"];
	const derived = snapshot.currentDerivedAction;
	const interrupted = snapshot.currentInterruptionAction;
	if (terminalInterruption) {
		if (!interrupted) return { kind: "wait", reason: "terminal-action-needs-reclassification" };
		if (derived || interrupted.version !== 1 ||
			interrupted.kind !== "current-host-interruption-action" ||
			!sourceId(interrupted.source) ||
			interrupted.source.runId !== terminalInterruption.source.runId ||
			interrupted.source.runAttempt !== terminalInterruption.source.runAttempt ||
			interrupted.source.commit !== terminalInterruption.source.commit ||
			interrupted.priorCarryEnvelopeSha256 !== terminalCarry.envelopeSha256 ||
			interrupted.priorCheckpointSha256 !== terminalCarry.checkpointSha256 ||
			interrupted.resultArchiveSha256 !== terminalInterruption.resultArchiveSha256 ||
			interrupted.action.reasonCode !== "execution-interrupted" ||
			canonical(interrupted.action) !== canonical(classifyPendingAction("execution-interrupted",
				{ unresolvedOperationRefs: [...status.unresolvedOperationRefs] })))
			fail("current interruption action lacks host provenance or changed the safety class");
		action = interrupted.action;
		actionSha = pendingActionIdentity(action);
		actionProvenance = { kind: "current-host-interruption",
			priorCheckpointSha256: interrupted.priorCheckpointSha256,
			resultArchiveSha256: interrupted.resultArchiveSha256 };
	} else if (interrupted) fail("interruption action has no terminal gap");
	else if (derived) {
		if (status.pendingAction !== undefined || pendingAction !== undefined ||
			terminalCarry.pendingActionSha256 !== null ||
			status.stopReason !== "bounded-run-incomplete" ||
			status.unresolvedOperationRefs.length === 0 ||
			!sourceId(derived.source) || derived.version !== 1 ||
			derived.kind !== "current-host-derived-action" ||
			!hex64(derived.checkpointSha256) ||
			derived.checkpointSha256 !== terminalCarry.checkpointSha256 ||
			derived.source.runId !== terminalCarry.source.runId ||
			derived.source.runAttempt !== terminalCarry.source.runAttempt ||
			derived.source.commit !== terminalCarry.source.commit ||
			derived.envelopeSha256 !== terminalCarry.envelopeSha256 ||
			derived.selectedTupleSha256 !== status.selectedTupleSha256)
			fail("current host derivation does not bind the authenticated legacy checkpoint");
		const expected = classifyPendingAction("bounded-run-incomplete",
			{ unresolvedOperationRefs: [...status.unresolvedOperationRefs] });
		if (canonical(derived.action) !== canonical(expected))
			fail("current host derivation changed the deterministic unknown-operation action");
		action = derived.action;
		actionSha = pendingActionIdentity(action);
		actionProvenance = { kind: "current-host-derived", checkpointSha256: derived.checkpointSha256 };
	} else {
		if (!status.stopReason || !status.pendingAction || !pendingAction)
			return { kind: "restore-evidence", evidenceRefs: [] };
		action = pendingAction;
		actionSha = pendingActionIdentity(action);
		if (pendingActionIdentity(status.pendingAction) !== actionSha ||
			action.reasonCode !== status.stopReason ||
			terminalCarry.pendingActionSha256 !== actionSha)
			fail("pending action does not match authenticated checkpoint and carry");
	}
	const quarantinedOperationRefs = action.target?.operationRefs ?? [];
	const selectedResumeSource = terminalInterruption?.source ?? terminalCarry.source;
	const resumeSource = { runId: selectedResumeSource.runId,
		runAttempt: selectedResumeSource.runAttempt, commit: selectedResumeSource.commit };
	if (!sameSet(status.unresolvedOperationRefs, quarantinedOperationRefs) ||
		(status.unresolvedOperationRefs.length > 0 &&
			action.safety !== "no-replay-until-reconciled"))
		fail("unresolved M07 operations are missing from quarantine");
	if (action.kind === "reconcile-m07-operation" &&
		(!quarantinedOperationRefs.length || action.safety !== "no-replay-until-reconciled"))
		fail("M07 operation reconciliation is unsafe");
	if (action.kind === "reconcile-m04-transaction" &&
		action.safety !== "no-replay-until-reconciled")
		fail("M04 transaction reconciliation is unsafe");
	if (action.safety === "same-session-read-only")
		return { kind: "wait", reason: "terminal-action-needs-reclassification" };
	if (action.reasonCode === "accounting-integrity-error")
		return { kind: "wait", reason: "accounting-chain-needs-reconciliation" };
	if (action.humanRequired) return { kind: "exclusive-external-input",
		blocker: action.verifiedHumanBlocker! };
	const launch = snapshot.freshLaunchContract;
	const launchVerified = Boolean(launch && launch.version === 1 &&
		launch.kind === "verified-fresh-launch-contract" &&
		launch.source.runId === resumeSource.runId &&
		launch.source.runAttempt === resumeSource.runAttempt &&
		launch.source.commit === resumeSource.commit &&
		launch.envelopeSha256 === terminalCarry.envelopeSha256 &&
		launch.selectedTupleSha256 === status.selectedTupleSha256 &&
		launch.pendingActionSha256 === actionSha &&
		typeof launch.testedSourceCommit === "string" && /^[0-9a-f]{40}$/.test(launch.testedSourceCommit) &&
		typeof launch.testedTree === "string" && /^[0-9a-f]{40}$/.test(launch.testedTree) &&
		launch.requiresRuntimeAttestationBeforeModel === true &&
		launch.mode === "fresh-work-only");
	let interruptedSourceReview: ResumeIntent["interruptedSourceReview"];
	if (terminalInterruption) {
		const review = snapshot.interruptedSourceReview;
		if (!review) return { kind: "wait", reason: "interruption-source-review-required" };
		if (!isVerifiedInterruptedSourceCapability(review) ||
			!sourceId(review.source) || !hex64(review.receiptSha256) ||
			!(/^[0-9a-f]{40}$/.test(review.sourceTree)) ||
			review.source.runId !== resumeSource.runId ||
			review.source.runAttempt !== resumeSource.runAttempt ||
			review.source.commit !== resumeSource.commit ||
			Object.keys(review.grant ?? {}).sort().join("|") !== ["mode", "oldResultUse",
				"m07Tools", "modelSessions", "state", "outputTransport", "providerInference"].sort().join("|") ||
			review.grant.mode !== "fresh-only-confined-effects" ||
			review.grant.oldResultUse !== "untrusted-no-replay-no-adoption" ||
			review.grant.m07Tools !== "factory-confined-local" ||
			review.grant.modelSessions !== "read-only" ||
			review.grant.state !== "fresh-workspace-empty-store-no-resume" ||
			review.grant.outputTransport !== "encrypted-fixed" ||
			review.grant.providerInference !== "fixed-configured-provider")
			fail("interrupted source review is not verified for the terminal source");
		interruptedSourceReview = { source: { ...review.source }, sourceTree: review.sourceTree,
			receiptSha256: review.receiptSha256 };
	} else if (snapshot.interruptedSourceReview !== undefined)
		fail("interrupted source review has no terminal gap");
	if (action.kind === "repair-workflow-state" && status.stopReason !== "workflow-repair-needed")
		fail("workflow repair action has an unrelated objective stop");
	if (status.stopReason === "workflow-repair-needed") {
		if (!snapshot.workflowRepairPlan)
			return { kind: "wait", reason: "workflow-repair-plan-required" };
		if (!isVerifiedWorkflowRepairPlan(snapshot.workflowRepairPlan))
			fail("workflow repair plan is not host verified");
	}
	// An executed run with no carry has an unknowable actor and billing suffix.
	// A fresh launch must prove the next process enforces the isolation boundary
	// even if the older carried action itself was read-only repair.
	if (terminalInterruption && !launchVerified)
		return { kind: "wait", reason: "quarantined-operation-needs-reconciliation" };
	if (action.safety === "no-replay-until-reconciled") {
		const fresh = snapshot.freshIndependentWork;
		const actualVerified = Boolean(fresh && fresh.version === 1 &&
			fresh.kind === "host-verified-fresh-independent-work" &&
			fresh.source.runId === terminalCarry.source.runId &&
			fresh.source.runAttempt === terminalCarry.source.runAttempt &&
			fresh.source.commit === terminalCarry.source.commit &&
			fresh.envelopeSha256 === terminalCarry.envelopeSha256 &&
			fresh.selectedTupleSha256 === status.selectedTupleSha256 &&
			fresh.pendingActionSha256 === actionSha &&
			fresh.isolatedWorkspace === true && fresh.emptyStore === true &&
			fresh.noPriorSessionResume === true && fresh.confinedGrants === true &&
			fresh.nextTaskDependency === "independent");
		if (!actualVerified && !launchVerified)
			return { kind: "wait", reason: "quarantined-operation-needs-reconciliation" };
	}
	// A serialized assertion or a changed source tip does not release a repair.
	// The host verifies an explicit private operator review against this exact
	// terminal carry, repair receipt and different tested source before branding.
	if (status.stopReason === "workflow-repair-needed") {
		const plan = snapshot.workflowRepairPlan;
		if (!plan) return { kind: "wait", reason: "workflow-repair-plan-required" };
		if (!isVerifiedWorkflowRepairPlan(plan)) fail("workflow repair plan is not host verified");
		const prior = plan.prior;
		const launch = snapshot.freshLaunchContract;
		if (prior.source.runId !== terminalCarry.source.runId ||
			prior.source.runAttempt !== terminalCarry.source.runAttempt ||
			prior.source.commit !== terminalCarry.source.commit ||
			prior.envelopeSha256 !== terminalCarry.envelopeSha256 ||
			prior.checkpointSha256 !== terminalCarry.checkpointSha256 ||
			prior.contractId !== status.contractId ||
			prior.selectedTupleSha256 !== status.selectedTupleSha256 ||
			prior.pendingActionSha256 !== actionSha ||
			plan.replacement.testedSourceCommit === terminalCarry.source.commit ||
			plan.replacement.testedTree === prior.sourceTree ||
			plan.boundary !== "new-isolated-workspace-no-prior-session-resume" ||
			!launch || launch.version !== 1 || launch.kind !== "verified-fresh-launch-contract" ||
			launch.source.runId !== resumeSource.runId ||
			launch.source.runAttempt !== resumeSource.runAttempt ||
			launch.source.commit !== resumeSource.commit ||
			launch.envelopeSha256 !== terminalCarry.envelopeSha256 ||
			launch.selectedTupleSha256 !== status.selectedTupleSha256 ||
			launch.pendingActionSha256 !== actionSha ||
			launch.testedSourceCommit !== plan.replacement.testedSourceCommit ||
			launch.testedTree !== plan.replacement.testedTree ||
			launch.requiresRuntimeAttestationBeforeModel !== true || launch.mode !== "fresh-work-only")
			fail("workflow repair plan does not bind the fresh launch and terminal carry");
		workflowRepair = { reviewedPlanSha256: sha(canonical(plan)),
			testedSourceCommit: plan.replacement.testedSourceCommit,
			testedTree: plan.replacement.testedTree,
			successfulCi: structuredClone(plan.replacement.successfulCi) };
	} else if (snapshot.workflowRepairPlan !== undefined) fail("workflow repair plan is unrelated to pending action");
	let linkedUnknownDelivery: ResumeIntent["linkedUnknownDelivery"];
	if (snapshot.linkedUnknownDelivery) {
		const linked = snapshot.linkedUnknownDelivery;
		if (!isVerifiedLinkedUnknownDelivery(linked) || !launchVerified ||
			linked.version !== 1 || linked.kind !== "host-verified-linked-unknown-delivery" ||
			!hex64(linked.oldJournalKey) || !/^[0-9a-f]{40}$/.test(linked.oldControlCommit) ||
			!hex64(linked.oldSourceReviewReceiptSha256) ||
			!Array.isArray(linked.ancestry) || !linked.ancestry.length ||
			linked.ancestry.some(row => !hex64(row.oldJournalKey) ||
				!/^[0-9a-f]{40}$/.test(row.oldControlCommit)) ||
			new Set(linked.ancestry.map(row => row.oldJournalKey)).size !== linked.ancestry.length ||
			new Set(linked.ancestry.map(row => row.oldControlCommit)).size !== linked.ancestry.length ||
			linked.ancestry.at(-1)?.oldJournalKey !== linked.oldJournalKey ||
			linked.ancestry.at(-1)?.oldControlCommit !== linked.oldControlCommit ||
			linked.liveControlHead !== linked.oldControlCommit ||
			!(/^[0-9a-f]{40}$/.test(linked.oldTestedSourceCommit)) ||
			!(/^[0-9a-f]{40}$/.test(linked.oldTestedTree)) ||
			linked.oldTestedSourceCommit === linked.newTestedSourceCommit ||
			linked.census?.kind !== "authenticated-complete-actions-run-census" ||
			linked.census.headCommit !== linked.oldControlCommit ||
			linked.census.totalCount !== 0 || linked.census.pagesRead !== 1 ||
			!hex64(linked.census.sha256) ||
			linked.newTestedSourceCommit !== launch!.testedSourceCommit ||
			linked.newTestedTree !== launch!.testedTree ||
			linked.sourceRefTip !== linked.newTestedSourceCommit ||
			linked.newSuccessfulCi?.workflow !== "workflow-regression.yml" ||
			!/^[1-9][0-9]{0,17}$/.test(linked.newSuccessfulCi.runId) ||
			linked.newSuccessfulCi.runAttempt !== 1 ||
			linked.newSuccessfulCi.headCommit !== linked.newTestedSourceCommit ||
			linked.newSuccessfulCi.conclusion !== "success" ||
			linked.accounting !== "unquantified" || linked.effects !== "unknown-unreconciled" ||
			workflowRepair && canonical(workflowRepair.successfulCi) !== canonical(linked.newSuccessfulCi))
			fail("linked unknown delivery lacks a fresh authenticated source fence");
		linkedUnknownDelivery = structuredClone(linked);
	}
	if (action.kind === "restore-evidence" || action.kind === "retry-evidence-read" &&
		action.evidenceRefs?.length)
		return { kind: "restore-evidence", evidenceRefs: action.evidenceRefs ?? [] };
	const idempotencyKey = sha(canonical({ source: resumeSource,
		envelopeSha256: terminalCarry.envelopeSha256,
		contractId: status.contractId, selectedTupleSha256: status.selectedTupleSha256,
		pendingActionSha256: actionSha,
		...(terminalInterruption ? { terminalInterruption } : {}),
		...(interruptedSourceReview ? { interruptedSourceReview } : {}),
		...(actionProvenance ? { actionProvenance } : {}),
		...(workflowRepair ? { workflowRepair } : {}),
		...(linkedUnknownDelivery ? { linkedUnknownDelivery } : {}) }));
	if (dispatchRecord.state !== "not-requested") {
		if (dispatchRecord.idempotencyKey !== idempotencyKey)
			fail("dispatch record belongs to a different pending action");
		if (dispatchRecord.state === "acknowledged") return { kind: "wait",
			reason: "successor-request-accepted", idempotencyKey,
			successorRunId: dispatchRecord.successorRunId };
		return { kind: "wait", reason: dispatchRecord.state === "reserved" ?
			"dispatch-reserved" : "dispatch-delivery-unknown", idempotencyKey };
	}
	return { kind: "dispatch", intent: {
		version: 1, kind: "fresh-independent-mission-resume", idempotencyKey,
		source: resumeSource, envelopeSha256: terminalCarry.envelopeSha256,
		contractId: status.contractId, selectedTupleSha256: status.selectedTupleSha256,
		pendingActionSha256: actionSha, actionKind: action.kind,
		pendingAction: structuredClone(action),
		...(terminalInterruption ? { terminalInterruption: structuredClone(terminalInterruption) } : {}),
		...(interruptedSourceReview ? { interruptedSourceReview } : {}),
		...(actionProvenance ? { actionProvenance } : {}),
		...(workflowRepair ? { workflowRepair } : {}),
		...(linkedUnknownDelivery ? { linkedUnknownDelivery } : {}),
		boundary: "new-isolated-workspace-no-prior-session-resume",
		quarantinedOperationRefs: [...quarantinedOperationRefs],
		m04TransactionQuarantined: action.kind === "reconcile-m04-transaction" ||
			Boolean(terminalInterruption) } };
}

export type ResumeTriggerReceipt = Readonly<
	{ state: "acknowledged"; idempotencyKey: string; successorRunId: string } |
	{ state: "delivery-unknown"; idempotencyKey: string }>;
/** The callback must persist its idempotency reservation before any external
 * request and reconcile uncertain delivery. It must attest fresh isolation at
 * the new process boundary. GitHub permissions and API writes live elsewhere.
 */
export type ResumeTrigger = (intent: ResumeIntent) => Promise<ResumeTriggerReceipt>;

/** Recheck the terminal carry and durable dispatch record immediately before
 * crossing the external trigger boundary. A thrown trigger is delivery-unknown. */
export async function dispatchPlannedResume(planned: SupervisorDecision,
	recheck: () => Promise<SupervisorSnapshot>, trigger: ResumeTrigger): Promise<SupervisorDecision> {
	if (planned.kind !== "dispatch") return planned;
	const current = planMissionContinuation(await recheck());
	if (current.kind !== "dispatch") return current;
	if (current.intent.idempotencyKey !== planned.intent.idempotencyKey)
		return fail("pending action changed before dispatch");
	try {
		const result = await trigger(current.intent);
		if (result.idempotencyKey !== current.intent.idempotencyKey)
			return fail("trigger returned a different action identity");
		if (result.state === "acknowledged" && /^[1-9][0-9]{0,17}$/.test(result.successorRunId))
			return { kind: "wait", reason: "successor-request-accepted",
				idempotencyKey: result.idempotencyKey, successorRunId: result.successorRunId };
		if (result.state !== "delivery-unknown") return fail("trigger receipt is invalid");
	} catch { /* The trigger may have sent before failing. Never resend blindly. */ }
	return { kind: "wait", reason: "dispatch-delivery-unknown",
		idempotencyKey: current.intent.idempotencyKey };
}
