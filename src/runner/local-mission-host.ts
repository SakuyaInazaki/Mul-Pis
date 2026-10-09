/** GitHub-free, append-only host evidence for one local mission. This store
 * records bytes and uncertainty; it never certifies scientific completion,
 * provider settlement, or safe replay of an external operation. */
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, readdir, realpath, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { readCurrentProcessIdentity, probeProcessIdentity,
	type ProcessIdentityV1, type ProcessProbe } from "../runtime/process-identity.ts";
import type { ObjectiveProgressV1 } from "../m07/objective-progress.ts";
import type { LegacyEffectReviewV1 } from "../m07/local-legacy-review.ts";
import { assertFullM07Reads, requiredM07Reads } from "../stages/m04.ts";

const CHECKPOINT_BYTES = 64 * 1024 * 1024;
/** Bounds one physical payload file; exceeding it is a transport repair need,
 * never a scientific, fee, or iteration stopping rule. */
const FINAL_BYTES = 255 * 1024 * 1024;
const CONTROL_BYTES = 64 * 1024;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const ATTEMPT = /^A([0-9]{3,})$/;

export type LocalMissionAttempt = Readonly<{
	version: 1; missionId: string; attemptId: string; predecessorAttemptId: string | null;
	/** Operator/local-build label only; this is not a source-authentication proof. */
	codeRevision: string; process: ProcessIdentityV1;
}>;
export type LocalCheckpointReceipt = Readonly<{
	version: 1 | 2 | 3 | 4 | 5; kind: "local-mission-checkpoint"; source: LocalMissionAttempt;
	sequence: number; previousSha256: string | null; sha256: string; bytes: number;
	unresolvedOperationIds: readonly string[];
	/** V2 commits the host review with the successor checkpoint, never with the old attempt. */
	interruptedReview?: LocalInterruptedReviewV1;
	legacyInterruptedReview?: LocalLegacyInterruptedReviewV1;
	evaluatorRecoveryReview?: LocalEvaluatorRecoveryReviewV1;
	coldMigrationReview?: LocalColdMigrationReviewV1;
}>;
export type LocalEvaluatorRecoveryClaimV1 = Readonly<{
	version: 1; kind: "local-evaluator-recovery-claim"; claimId: string;
	missionId: string; intentId: string;
	oldCheckpoint: { sequence: number; sha256: string }; owner: ProcessIdentityV1;
	/** Each prior owner was proved dead on the same host/boot before replacement. */
	predecessors: readonly { claimId: string; owner: ProcessIdentityV1 }[];
}>;
export type LocalEvaluatorRecoveryEvidenceV1 =
	| Readonly<{ id: string; version: string; phase: "pre-entry-unlocated";
		orphanMembers: readonly { name: "prepared.json.pending" | "prepared.json" |
			"prepared.sha256.pending"; sha256: string }[] }>
	| Readonly<{ id: string; version: string; attemptId: string; owner: ProcessIdentityV1;
		preparedSha256: string; enteredSha256: string;
		phase: "returned" | "settled-failure"; phaseSha256: string;
		receiptSha256: string | null }>;
/** A transport review of one settled host evaluator call. It carries no task
 * selection or scientific authority. Every digest is checked again on read. */
export type LocalEvaluatorRecoveryReviewV1 = Readonly<{
	version: 1; kind: "local-evaluator-interruption-host-review";
	missionId: string; intentId: string; missionRunSha256: string;
	recoveryClaim: { claimId: string; owner: ProcessIdentityV1; oldCheckpointSha256: string;
		predecessors: readonly { claimId: string; owner: ProcessIdentityV1 }[] };
	lineageSha256: string; dispatchOriginAttempt: LocalMissionAttempt;
	/** Source of the latest held checkpoint; an intervening status/step may own it. */
	oldAttempt: LocalMissionAttempt;
	oldCheckpoint: { sequence: number; sha256: string }; newAttempt: LocalMissionAttempt;
	m07: { runId: string; taskId: string; operationId: string; checkpointId: string;
		goalSha256: string; snapshotSha256: string; manifestSha256: string; feedbackSha256: string };
	evaluator: LocalEvaluatorRecoveryEvidenceV1;
	/** Optional old M04 evidence is retained, never replayed or promoted. */
	m04?: { runId: string; runSha256: string; sourceSha256: string;
		transactionSha256: string; coverageSha256: string; requiredM07ReadPaths: string[] };
	boundary: "fresh-work-only-no-builder-or-evaluator-replay";
}>;
export type LocalInterruptedReviewV1 = Readonly<{
	version: 1; kind: "local-interrupted-dispatch-review";
	missionId: string; intentId: string;
	missionRunSha256: string;
	lineageSha256: string;
	oldAttempt: LocalMissionAttempt;
	oldCheckpoint: { sequence: number; sha256: string };
	newAttempt: LocalMissionAttempt;
	m07: { runId: string; taskId: string; operationId: string; checkpointId: string;
		goalSha256: string; snapshotSha256: string; manifestSha256: string; feedbackSha256: string;
		result: "rejected-with-complete-feedback"; effect: "response-received" };
	m04: { runId: string; sourceSha256: string; transactionSha256: string;
		runSha256: string; result: "failed-no-proposal";
		lastRequest: "sdk-output-max-guard-before-http"; providerProofSha256: string };
	boundary: "new-work-only-no-old-task-or-session-replay";
}>;
export type LocalLegacyInterruptedReviewV1 = Readonly<Omit<LocalInterruptedReviewV1,
	"kind" | "lineageSha256"> & {
	kind: "local-legacy-interruption-host-review";
	historicalExplicitDispatchBinding: false;
	actualArgvRecorded: false;
	association: "host-reviewed-inferred";
	effects: "observed-settled-within-trusted-host-scope";
	authority: "fresh-follow-up-only";
	source: { commit: string; tree: string; serialEntryAuditSha256: string };
	associationEvidence: { kind: "host-reviewed-serial-dispatch-inference";
		assessorTaskSha256: string; m07OwnerSha256: string; taskInputsSha256: string;
		workspaceCensusSha256: string; launcher: "single-default-cli-serial-objective-loop" };
	effectReview: LegacyEffectReviewV1;
	effectEvidence: { toolLogSha256: string; toolReviewSha256: string; m04SessionSha256: string;
		toolTranscriptCensusSha256: string; pairedToolCallCount: number;
		childProcessReviewSha256: string; networkReviewSha256: string;
		toolCallCount: number; failedToolOrdinals: number[]; numericExitUnknownOrdinals: number[];
		trustLimit: "same-uid-reviewed-observations-no-os-noninterference-proof" };
}>;
/** A retained original-host observation, authenticated by a trusted host reviewer
 * before this receipt is made. Message references are provenance, not OS proof. */
export type ColdMigrationObservationV1 = Readonly<{
	version: 1; kind: "trusted-original-host-terminal-observation";
	missionId: string; intentId: string; oldAttemptId: string;
	oldOwner: ProcessIdentityV1; oldCheckpoint: { sequence: number; sha256: string };
	terminal: { messageId: string; observedAt: string; state: "old-owner-terminal";
		exitCode: number | null };
	effectCensus: { messageId: string; observedAt: string; workspaceCensusSha256: string;
		processGroupId: number | null; state: "observed-settled" };
	archive: { sha256: string; checkpointSha256: string };
	provenance: "trusted-host-reviewed-contemporaneous-platform-observations";
	launch: "reviewed-one-shot"; autoRestarter: "none-observed";
	fence: "destination-exclusive-claim";
	limit: "same-uid-observations-no-cross-host-os-or-permanent-copy-lock-proof";
}>;
export type LocalColdMigrationReviewV1 = Readonly<Omit<LocalLegacyInterruptedReviewV1,
	"kind"> & {
	kind: "local-cold-migration-host-review";
	coldMigration: { observation: ColdMigrationObservationV1; observationSha256: string };
}>;
export type LocalContractReceipt = Readonly<{
	version: 1; kind: "local-mission-original-contract";
	source: LocalMissionAttempt; sha256: string; bytes: number;
}>;
export type LocalFinalIntent = Readonly<{
	version: 1; kind: "local-mission-final-intent"; source: LocalMissionAttempt;
	intentId: string; checkpointSequence: number; checkpointSha256: string;
	carrySha256: string; unresolvedOperationIds: readonly string[];
}>;
export type LocalFinalReceipt = Readonly<{
	version: 1; kind: "local-mission-final-receipt"; source: LocalMissionAttempt;
	intentId: string; checkpointSequence: number; checkpointSha256: string;
	sha256: string; bytes: number; transportOnly: true;
}>;
export type LocalMissionStatus = Readonly<{
	missionId: string; currentAttempt: LocalMissionAttempt | null;
	contractReceipt: LocalContractReceipt | null; contractOrphan: boolean;
	latestCheckpoint: LocalCheckpointReceipt | null;
	checkpointReceipts: readonly LocalCheckpointReceipt[];
	unresolvedOperationIds: readonly string[]; interruptedAttemptIds: readonly string[];
	final: "none" | "reserved" | "attempted-unknown" | "committed";
	finalReceipt: LocalFinalReceipt | null; finalReceipts: readonly LocalFinalReceipt[];
	repairRequired: boolean; writerLockPresent: boolean;
	preparedReviewPending: boolean;
	evaluatorRecoveryClaim: LocalEvaluatorRecoveryClaimV1 | null;
	selectionAuthority: false; accounting: "unquantified";
}>;

type UnknownOperation = Readonly<{
	version: 1; kind: "local-mission-unknown-operation";
	source: LocalMissionAttempt; operationId: string;
	effects: "unknown-unreconciled"; accounting: "unquantified";
}>;
type FinalAttempt = Readonly<{
	version: 1; kind: "local-mission-final-attempt"; source: LocalMissionAttempt;
	intentId: string; carrySha256: string;
}>;
type Scan = { status: LocalMissionStatus; attempts: LocalMissionAttempt[];
	intent: LocalFinalIntent | null; attempted: FinalAttempt | null };

function reject(reason: string): never { throw new Error(`local mission host refused: ${reason}`); }
class SyntheticReviewCrash extends Error {}
function digest(bytes: Buffer | string): string { return createHash("sha256").update(bytes).digest("hex"); }
function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value) &&
		Object.keys(value).sort().join("|") === [...keys].sort().join("|");
}
function validAttemptId(value: unknown): value is string {
	if (typeof value !== "string" || !ATTEMPT.test(value)) return false;
	const index = Number(value.slice(1));
	return Number.isSafeInteger(index) && index > 0 &&
		`A${String(index).padStart(3, "0")}` === value;
}
function validProcess(value: unknown): value is ProcessIdentityV1 {
	const identityText = (item: unknown): item is string =>
		typeof item === "string" && item.length > 0 && item.length <= 512 &&
		!/[\0\r\n]/.test(item);
	return exact(value, ["hostId", "bootId", "pid", "processStartToken"]) &&
		["hostId", "bootId", "processStartToken"].every(key => identityText(value[key])) &&
		Number.isSafeInteger(value.pid) && Number(value.pid) > 0;
}
function validSource(value: unknown): value is LocalMissionAttempt {
	return exact(value, ["version", "missionId", "attemptId", "predecessorAttemptId",
		"codeRevision", "process"]) && value.version === 1 &&
		typeof value.missionId === "string" && SAFE_ID.test(value.missionId) &&
		validAttemptId(value.attemptId) &&
		(value.predecessorAttemptId === null || validAttemptId(value.predecessorAttemptId)) &&
		typeof value.codeRevision === "string" && SAFE_ID.test(value.codeRevision) &&
		validProcess(value.process);
}
function same(a: unknown, b: unknown): boolean { return JSON.stringify(a) === JSON.stringify(b); }
function validIds(value: unknown): value is string[] {
	return Array.isArray(value) && value.every(item => typeof item === "string" && SAFE_ID.test(item)) &&
		new Set(value).size === value.length && [...value].sort().join("|") === value.join("|");
}
function validInterruptedReview(value: unknown): value is LocalInterruptedReviewV1 {
	if (!exact(value, ["version", "kind", "missionId", "intentId", "missionRunSha256", "lineageSha256", "oldAttempt",
		"oldCheckpoint", "newAttempt", "m07", "m04", "boundary"]) ||
		value.version !== 1 || value.kind !== "local-interrupted-dispatch-review" ||
		!validSource(value.oldAttempt) || !validSource(value.newAttempt) ||
		value.missionId !== value.oldAttempt.missionId || value.missionId !== value.newAttempt.missionId ||
		!SAFE_ID.test(String(value.intentId)) || !HEX64.test(String(value.missionRunSha256)) ||
		!HEX64.test(String(value.lineageSha256)) ||
		!exact(value.oldCheckpoint, ["sequence", "sha256"]) ||
		!Number.isSafeInteger(value.oldCheckpoint.sequence) || Number(value.oldCheckpoint.sequence) < 1 ||
		!HEX64.test(String(value.oldCheckpoint.sha256)) ||
		!exact(value.m07, ["runId", "taskId", "operationId", "checkpointId", "goalSha256", "snapshotSha256",
			"manifestSha256", "feedbackSha256", "result", "effect"]) ||
		![value.m07.runId, value.m07.taskId, value.m07.operationId, value.m07.checkpointId].every(x =>
			typeof x === "string" && SAFE_ID.test(x)) ||
		![value.m07.goalSha256, value.m07.snapshotSha256, value.m07.manifestSha256,
			value.m07.feedbackSha256].every(x =>
			typeof x === "string" && HEX64.test(x)) ||
		value.m07.result !== "rejected-with-complete-feedback" || value.m07.effect !== "response-received" ||
		!exact(value.m04, ["runId", "sourceSha256", "transactionSha256", "runSha256",
			"result", "lastRequest", "providerProofSha256"]) ||
		typeof value.m04.runId !== "string" || !SAFE_ID.test(value.m04.runId) ||
		![value.m04.sourceSha256, value.m04.transactionSha256, value.m04.runSha256,
			value.m04.providerProofSha256].every(x => typeof x === "string" && HEX64.test(x)) ||
		value.m04.result !== "failed-no-proposal" ||
		value.m04.lastRequest !== "sdk-output-max-guard-before-http" ||
		value.boundary !== "new-work-only-no-old-task-or-session-replay") return false;
	return true;
}
function validLegacyInterruptedReview(value: unknown): value is LocalLegacyInterruptedReviewV1 {
	if (!exact(value, ["version", "kind", "missionId", "intentId", "missionRunSha256",
		"oldAttempt", "oldCheckpoint", "newAttempt", "m07", "m04", "boundary",
		"historicalExplicitDispatchBinding", "actualArgvRecorded", "association", "effects", "authority",
		"source", "associationEvidence", "effectReview", "effectEvidence"]) ||
		value.kind !== "local-legacy-interruption-host-review" ||
		value.historicalExplicitDispatchBinding !== false ||
		value.actualArgvRecorded !== false || value.association !== "host-reviewed-inferred" ||
		value.effects !== "observed-settled-within-trusted-host-scope" ||
		value.authority !== "fresh-follow-up-only" ||
		!exact(value.source, ["commit", "tree", "serialEntryAuditSha256"]) ||
		![value.source.commit, value.source.tree].every(x => typeof x === "string" && /^[0-9a-f]{40}$/.test(x)) ||
		!HEX64.test(String(value.source.serialEntryAuditSha256)) ||
		!exact(value.associationEvidence, ["kind", "assessorTaskSha256", "m07OwnerSha256",
			"taskInputsSha256", "workspaceCensusSha256", "launcher"]) ||
		value.associationEvidence.kind !== "host-reviewed-serial-dispatch-inference" ||
		value.associationEvidence.launcher !== "single-default-cli-serial-objective-loop" ||
		![value.associationEvidence.assessorTaskSha256, value.associationEvidence.m07OwnerSha256,
			value.associationEvidence.taskInputsSha256, value.associationEvidence.workspaceCensusSha256]
			.every(x => typeof x === "string" && HEX64.test(x)) ||
		!exact(value.effectEvidence, ["toolLogSha256", "toolReviewSha256", "m04SessionSha256",
			"toolTranscriptCensusSha256", "pairedToolCallCount", "childProcessReviewSha256",
			"networkReviewSha256", "toolCallCount", "failedToolOrdinals", "numericExitUnknownOrdinals",
			"trustLimit"]) ||
		value.effectEvidence.trustLimit !== "same-uid-reviewed-observations-no-os-noninterference-proof" ||
		!exact(value.effectReview, ["version", "kind", "source", "censusSha256", "toolLogSha256",
			"m04SessionSha256", "toolTranscriptCensusSha256", "pairedToolCallCount",
			"toolCalls", "childProcess", "network", "failedToolOrdinals",
			"numericExitUnknownOrdinals", "trustLimit", "conclusion"]) ||
		digest(JSON.stringify(value.effectReview)) !== value.effectEvidence.toolReviewSha256 ||
		!Array.isArray(value.effectReview.toolCalls) ||
		value.effectReview.toolCalls.length !== value.effectEvidence.toolCallCount ||
		!same(value.effectReview.failedToolOrdinals, value.effectEvidence.failedToolOrdinals) ||
		!same(value.effectReview.numericExitUnknownOrdinals, value.effectEvidence.numericExitUnknownOrdinals) ||
		value.effectReview.censusSha256 !== value.associationEvidence.workspaceCensusSha256 ||
		value.effectReview.toolLogSha256 !== value.effectEvidence.toolLogSha256 ||
		value.effectReview.m04SessionSha256 !== value.effectEvidence.m04SessionSha256 ||
		value.effectReview.toolTranscriptCensusSha256 !== value.effectEvidence.toolTranscriptCensusSha256 ||
		value.effectReview.pairedToolCallCount !== value.effectEvidence.pairedToolCallCount ||
		value.effectEvidence.pairedToolCallCount !== value.effectEvidence.toolCallCount ||
		!Number.isSafeInteger(value.effectEvidence.toolCallCount) || Number(value.effectEvidence.toolCallCount) < 0 ||
		![value.effectEvidence.failedToolOrdinals, value.effectEvidence.numericExitUnknownOrdinals].every(ids =>
			Array.isArray(ids) && ids.every(x => Number.isSafeInteger(x) && x > 0)) ||
		![value.effectEvidence.toolLogSha256, value.effectEvidence.toolReviewSha256,
			value.effectEvidence.m04SessionSha256,
			value.effectEvidence.toolTranscriptCensusSha256,
			value.effectEvidence.childProcessReviewSha256, value.effectEvidence.networkReviewSha256]
			.every(x => typeof x === "string" && HEX64.test(x))) return false;
	const { historicalExplicitDispatchBinding: _binding, actualArgvRecorded: _argv,
		association: _association, effects: _effects, authority: _authority, source: _source,
		associationEvidence: _associationEvidence, effectReview: _review,
		effectEvidence: _effectEvidence, ...common } = value;
	return validInterruptedReview({ ...common, kind: "local-interrupted-dispatch-review",
		lineageSha256: value.associationEvidence.workspaceCensusSha256 });
}
/** Pure shape check shared by legacy and later host-owned transfer paths. It does
 * not authenticate message provenance; the host reviewer must do that. */
export function validColdMigrationObservation(value: unknown): value is ColdMigrationObservationV1 {
	const time = (item: unknown) => typeof item === "string" && Number.isFinite(Date.parse(item));
	return exact(value, ["version", "kind", "missionId", "intentId", "oldAttemptId", "oldOwner",
		"oldCheckpoint", "terminal", "effectCensus", "archive", "provenance", "launch", "autoRestarter", "fence", "limit"]) &&
		value.version === 1 && value.kind === "trusted-original-host-terminal-observation" &&
		[value.missionId, value.intentId, value.oldAttemptId].every(x => typeof x === "string" && SAFE_ID.test(x)) &&
		validProcess(value.oldOwner) &&
		exact(value.oldCheckpoint, ["sequence", "sha256"]) &&
		Number.isSafeInteger(value.oldCheckpoint.sequence) && Number(value.oldCheckpoint.sequence) > 0 &&
		HEX64.test(String(value.oldCheckpoint.sha256)) &&
		exact(value.terminal, ["messageId", "observedAt", "state", "exitCode"]) &&
		typeof value.terminal.messageId === "string" && SAFE_ID.test(value.terminal.messageId) &&
		time(value.terminal.observedAt) && value.terminal.state === "old-owner-terminal" &&
		(value.terminal.exitCode === null || Number.isSafeInteger(value.terminal.exitCode) &&
			Number(value.terminal.exitCode) >= 0) &&
		exact(value.effectCensus, ["messageId", "observedAt", "workspaceCensusSha256", "processGroupId", "state"]) &&
		typeof value.effectCensus.messageId === "string" && SAFE_ID.test(value.effectCensus.messageId) &&
		time(value.effectCensus.observedAt) &&
		Date.parse(String(value.effectCensus.observedAt)) >= Date.parse(String(value.terminal.observedAt)) &&
		HEX64.test(String(value.effectCensus.workspaceCensusSha256)) &&
		(value.effectCensus.processGroupId === null || Number.isSafeInteger(value.effectCensus.processGroupId) && Number(value.effectCensus.processGroupId) > 0) &&
		value.effectCensus.state === "observed-settled" &&
		exact(value.archive, ["sha256", "checkpointSha256"]) &&
		HEX64.test(String(value.archive.sha256)) && HEX64.test(String(value.archive.checkpointSha256)) &&
		value.provenance === "trusted-host-reviewed-contemporaneous-platform-observations" &&
		value.launch === "reviewed-one-shot" && value.autoRestarter === "none-observed" &&
		value.fence === "destination-exclusive-claim" &&
		value.limit === "same-uid-observations-no-cross-host-os-or-permanent-copy-lock-proof";
}
function validColdMigrationReview(value: unknown): value is LocalColdMigrationReviewV1 {
	if (!value || typeof value !== "object" || Array.isArray(value) ||
		!exact(value, ["version", "kind", "missionId", "intentId", "missionRunSha256",
			"oldAttempt", "oldCheckpoint", "newAttempt", "m07", "m04", "boundary",
			"historicalExplicitDispatchBinding", "actualArgvRecorded", "association", "effects", "authority",
			"source", "associationEvidence", "effectReview", "effectEvidence", "coldMigration"]) ||
		value.kind !== "local-cold-migration-host-review" ||
		!exact(value.coldMigration, ["observation", "observationSha256"]) ||
		!validColdMigrationObservation(value.coldMigration.observation) ||
		!HEX64.test(String(value.coldMigration.observationSha256)) ||
		digest(`${JSON.stringify(value.coldMigration.observation)}\n`) !== value.coldMigration.observationSha256 ||
		value.coldMigration.observation.missionId !== value.missionId ||
		value.coldMigration.observation.intentId !== value.intentId ||
		value.coldMigration.observation.oldAttemptId !== (value.oldAttempt as LocalMissionAttempt)?.attemptId ||
		!same(value.coldMigration.observation.oldOwner, (value.oldAttempt as LocalMissionAttempt)?.process) ||
		!same(value.coldMigration.observation.oldCheckpoint, value.oldCheckpoint) ||
		value.coldMigration.observation.effectCensus.workspaceCensusSha256 !==
			(value.associationEvidence as LocalLegacyInterruptedReviewV1["associationEvidence"])?.workspaceCensusSha256 ||
		value.coldMigration.observation.archive.checkpointSha256 !==
			(value.oldCheckpoint as LocalColdMigrationReviewV1["oldCheckpoint"]).sha256 ||
		(value.newAttempt as LocalMissionAttempt)?.process?.hostId ===
			(value.oldAttempt as LocalMissionAttempt)?.process?.hostId) return false;
	const { coldMigration: _cold, ...legacy } = value;
	return validLegacyInterruptedReview({ ...legacy, kind: "local-legacy-interruption-host-review" });
}
function validEvaluatorRecoveryReview(value: unknown): value is LocalEvaluatorRecoveryReviewV1 {
	if (!exact(value, ["version", "kind", "missionId", "intentId", "missionRunSha256", "recoveryClaim",
		"lineageSha256", "dispatchOriginAttempt", "oldAttempt", "oldCheckpoint", "newAttempt", "m07", "evaluator",
		...(value && typeof value === "object" && "m04" in value ? ["m04"] : []), "boundary"]) ||
		value.version !== 1 || value.kind !== "local-evaluator-interruption-host-review" ||
		!validSource(value.dispatchOriginAttempt) || !validSource(value.oldAttempt) ||
		!validSource(value.newAttempt) ||
		value.missionId !== value.dispatchOriginAttempt.missionId ||
		value.missionId !== value.oldAttempt.missionId || value.missionId !== value.newAttempt.missionId ||
		!exact(value.recoveryClaim, ["claimId", "owner", "oldCheckpointSha256", "predecessors"]) ||
		typeof value.recoveryClaim.claimId !== "string" ||
		!SAFE_ID.test(value.recoveryClaim.claimId) ||
		!validProcess(value.recoveryClaim.owner) ||
		!validClaimPredecessors(value.recoveryClaim.predecessors, value.recoveryClaim.owner) ||
		!HEX64.test(String(value.recoveryClaim.oldCheckpointSha256)) ||
		!same(value.recoveryClaim.owner, value.newAttempt.process) ||
		typeof value.intentId !== "string" || !SAFE_ID.test(value.intentId) ||
		![value.missionRunSha256, value.lineageSha256].every(x => typeof x === "string" && HEX64.test(x)) ||
		!exact(value.oldCheckpoint, ["sequence", "sha256"]) ||
		!Number.isSafeInteger(value.oldCheckpoint.sequence) || Number(value.oldCheckpoint.sequence) < 1 ||
		!HEX64.test(String(value.oldCheckpoint.sha256)) ||
		value.recoveryClaim.oldCheckpointSha256 !== value.oldCheckpoint.sha256 ||
		!exact(value.m07, ["runId", "taskId", "operationId", "checkpointId", "goalSha256",
			"snapshotSha256", "manifestSha256", "feedbackSha256"]) ||
		![value.m07.runId, value.m07.taskId, value.m07.operationId, value.m07.checkpointId]
			.every(x => typeof x === "string" && SAFE_ID.test(x)) ||
		![value.m07.goalSha256, value.m07.snapshotSha256, value.m07.manifestSha256,
			value.m07.feedbackSha256].every(x => typeof x === "string" && HEX64.test(x)) ||
		!validEvaluatorBinding(value.evaluator, value.dispatchOriginAttempt,
			value.recoveryClaim.owner, value.recoveryClaim.predecessors) ||
		value.boundary !== "fresh-work-only-no-builder-or-evaluator-replay") return false;
	if ("m04" in value && (value.evaluator.phase !== "returned" ||
		!exact(value.m04, ["runId", "runSha256", "sourceSha256", "transactionSha256",
			"coverageSha256", "requiredM07ReadPaths"]) ||
		typeof value.m04.runId !== "string" || !SAFE_ID.test(value.m04.runId) ||
		![value.m04.runSha256, value.m04.sourceSha256, value.m04.transactionSha256,
			value.m04.coverageSha256].every(x => typeof x === "string" && HEX64.test(x)) ||
		!Array.isArray(value.m04.requiredM07ReadPaths) ||
		!value.m04.requiredM07ReadPaths.length ||
		!value.m04.requiredM07ReadPaths.every(x => typeof x === "string" && x.length > 0 && x.length <= 240) ||
		new Set(value.m04.requiredM07ReadPaths).size !== value.m04.requiredM07ReadPaths.length)) return false;
	return true;
}
function validEvaluatorBinding(value: unknown, origin: LocalMissionAttempt,
	claimOwner: ProcessIdentityV1, predecessors: readonly { owner: ProcessIdentityV1 }[]):
	value is LocalEvaluatorRecoveryEvidenceV1 {
	if (exact(value, ["id", "version", "phase", "orphanMembers"]) &&
		value.phase === "pre-entry-unlocated") {
		const members = value.orphanMembers;
		if (typeof value.id !== "string" || !SAFE_ID.test(value.id) ||
			typeof value.version !== "string" || !SAFE_ID.test(value.version) ||
			!Array.isArray(members) || members.length < 1 || members.length > 2 ||
			members.some(item => !exact(item, ["name", "sha256"]) ||
				typeof item.sha256 !== "string" || !HEX64.test(item.sha256))) return false;
		const names = members.map(item => item.name);
		return same(names, ["prepared.json.pending"]) || same(names, ["prepared.json"]) ||
			same(names, ["prepared.json", "prepared.sha256.pending"]);
	}
	return exact(value, ["id", "version", "attemptId", "owner", "preparedSha256",
		"enteredSha256", "phase", "phaseSha256", "receiptSha256"]) &&
		validProcess(value.owner) &&
		(same(value.owner, origin.process) || same(value.owner, claimOwner) ||
			predecessors.some(row => same(row.owner, value.owner))) &&
		[value.id, value.version, value.attemptId].every(x => typeof x === "string" && SAFE_ID.test(x)) &&
		[value.preparedSha256, value.enteredSha256, value.phaseSha256]
			.every(x => typeof x === "string" && HEX64.test(x)) &&
		["returned", "settled-failure"].includes(String(value.phase)) &&
		(value.phase === "returned" ? HEX64.test(String(value.receiptSha256)) :
			value.receiptSha256 === null);
}
function validEvaluatorRecoveryClaim(value: unknown): value is LocalEvaluatorRecoveryClaimV1 {
	return exact(value, ["version", "kind", "claimId", "missionId", "intentId", "oldCheckpoint", "owner", "predecessors"]) &&
		value.version === 1 && value.kind === "local-evaluator-recovery-claim" &&
		typeof value.claimId === "string" && SAFE_ID.test(value.claimId) &&
		typeof value.missionId === "string" && SAFE_ID.test(value.missionId) &&
		typeof value.intentId === "string" && SAFE_ID.test(value.intentId) &&
		exact(value.oldCheckpoint, ["sequence", "sha256"]) &&
		Number.isSafeInteger(value.oldCheckpoint.sequence) && Number(value.oldCheckpoint.sequence) > 0 &&
		typeof value.oldCheckpoint.sha256 === "string" && HEX64.test(value.oldCheckpoint.sha256) &&
		validProcess(value.owner) && validClaimPredecessors(value.predecessors, value.owner);
}
function validClaimPredecessors(value: unknown, current: ProcessIdentityV1):
	value is { claimId: string; owner: ProcessIdentityV1 }[] {
	return Array.isArray(value) && value.length <= 128 && value.every(row =>
		exact(row, ["claimId", "owner"]) && typeof row.claimId === "string" &&
		SAFE_ID.test(row.claimId) && validProcess(row.owner) &&
		row.owner.hostId === current.hostId && row.owner.bootId === current.bootId) &&
		new Set(value.map(row => row.claimId)).size === value.length &&
		!value.some(row => same(row.owner, current));
}
function validEvaluatorProgressTransition(oldBytes: Buffer, newBytes: Buffer,
	review: LocalEvaluatorRecoveryReviewV1, accepted: boolean): boolean {
	try {
		const old = JSON.parse(oldBytes.toString("utf8")) as ObjectiveProgressV1;
		const next = JSON.parse(newBytes.toString("utf8")) as ObjectiveProgressV1;
		const refs = old.continuation?.unresolvedOperationIds;
		return old.version === 1 && next.version === 1 &&
			old.kind === "original-objective-progress" && next.kind === old.kind &&
			old.contract?.id === review.missionId && same(old.contract, next.contract) &&
			old.objectiveOutcome === "incomplete" && next.objectiveOutcome === "incomplete" &&
			old.stopReason === "execution-interrupted" &&
			old.continuation?.pendingAction?.kind === "reconcile-interrupted-run" &&
			old.continuation?.pendingAction?.safety === "no-replay-until-reconciled" &&
			(old.continuation?.pendingAction?.target?.goalRunId === review.intentId ||
				old.continuation?.pendingAction?.target?.goalRunId === undefined &&
				same(refs, [review.intentId, review.m07.runId].sort()) &&
				same(old.continuation?.pendingAction?.target?.operationRefs, refs)) &&
			(same(refs, [review.intentId]) ||
				same(refs, [review.intentId, review.m07.runId].sort())) &&
			next.stopReason === "objective-reassessment-pending" &&
			next.continuation?.mode === "explicit-authorized-new-run" &&
			next.continuation?.pendingAction?.safety === "fresh-work-only" &&
			same(next.continuation?.unresolvedOperationIds, []) &&
			same(old.selectedArtifacts, next.selectedArtifacts) &&
			same(old.availableArtifacts, next.availableArtifacts) &&
			same(old.assessment, next.assessment) && same(old.assessmentHistory, next.assessmentHistory) &&
			Array.isArray(old.boundedRuns) && Array.isArray(next.boundedRuns) &&
			!old.boundedRuns.some(row => row.runId === review.m07.runId) &&
			next.boundedRuns.length === old.boundedRuns.length + 1 &&
			same(next.boundedRuns.slice(0, -1), old.boundedRuns) &&
			same(next.boundedRuns.at(-1), { runId: review.m07.runId,
				outcome: "partial", acceptedTaskIds: accepted ? [review.m07.taskId] : [] });
	} catch { return false; }
}
function validReviewedProgressTransition(oldBytes: Buffer, newBytes: Buffer,
	review: LocalInterruptedReviewV1 | LocalLegacyInterruptedReviewV1 | LocalColdMigrationReviewV1): boolean {
	try {
		const old = JSON.parse(oldBytes.toString("utf8")) as ObjectiveProgressV1;
		const next = JSON.parse(newBytes.toString("utf8")) as ObjectiveProgressV1;
		return old.version === 1 && next.version === 1 &&
			old.kind === "original-objective-progress" && next.kind === old.kind &&
			old.contract?.id === review.missionId && same(old.contract, next.contract) &&
			old.objectiveOutcome === "incomplete" && next.objectiveOutcome === "incomplete" &&
			old.stopReason === "execution-interrupted" &&
			old.continuation?.pendingAction?.kind === "reconcile-interrupted-run" &&
			old.continuation?.pendingAction?.safety === "no-replay-until-reconciled" &&
			old.continuation?.pendingAction?.target?.goalRunId === review.intentId &&
			same(old.continuation?.unresolvedOperationIds, [review.intentId]) &&
			next.stopReason === "objective-reassessment-pending" &&
			next.continuation?.pendingAction?.safety === "fresh-work-only" &&
			same(next.continuation?.unresolvedOperationIds, []) &&
			same(old.selectedArtifacts, next.selectedArtifacts) &&
			same(old.availableArtifacts, next.availableArtifacts) &&
			same(old.assessment, next.assessment) &&
			same(old.assessmentHistory, next.assessmentHistory) &&
			Array.isArray(old.boundedRuns) && Array.isArray(next.boundedRuns) &&
			next.boundedRuns.length === old.boundedRuns.length + 1 &&
			same(next.boundedRuns.slice(0, -1), old.boundedRuns) &&
			same(next.boundedRuns.at(-1), { runId: review.m07.runId,
				outcome: "partial", acceptedTaskIds: [] });
	} catch { return false; }
}

async function privateDir(directory: string, create = false): Promise<void> {
	if (create) {
		try {
			await mkdir(directory, { mode: 0o700 });
			await syncDir(path.dirname(directory));
		}
		catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
	}
	const info = await lstat(directory);
	if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0)
		reject("private directory is unsafe");
}
async function syncDir(directory: string): Promise<void> {
	const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
	try { await handle.sync(); } finally { await handle.close(); }
}
async function privateBytes(file: string, max: number): Promise<Buffer> {
	const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	try {
		const before = await handle.stat();
		if (!before.isFile() || before.nlink !== 1 || (before.mode & 0o077) !== 0 ||
			before.size < 1 || before.size > max) reject("private file is unsafe");
		const bytes = await handle.readFile();
		const after = await handle.stat();
		if (bytes.length !== before.size || after.size !== before.size ||
			after.mtimeMs !== before.mtimeMs) reject("private file changed while reading");
		return bytes;
	} finally { await handle.close(); }
}
async function optionalBytes(file: string, max: number): Promise<Buffer | undefined> {
	try { return await privateBytes(file, max); }
	catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}
/** Stage files need not use host-private mode, but cannot be links or mutable during read. */
async function stageBytes(file: string, allowEmpty = false): Promise<Buffer> {
	const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	try {
		const before = await handle.stat();
		if (!before.isFile() || before.nlink !== 1 || (!allowEmpty && before.size < 1) ||
			before.size > CHECKPOINT_BYTES)
			reject("reviewed stage evidence is not a bounded regular file");
		const bytes = await handle.readFile();
		const after = await handle.stat();
		if (bytes.length !== before.size || after.dev !== before.dev || after.ino !== before.ino ||
			after.size !== before.size || after.mtimeMs !== before.mtimeMs)
			reject("reviewed stage evidence changed during read");
		return bytes;
	} finally { await handle.close(); }
}
async function stageDigest(file: string): Promise<string> { return digest(await stageBytes(file)); }
function inside(root: string, file: string): boolean {
	const relative = path.relative(root, file);
	return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) &&
		!path.isAbsolute(relative);
}
async function stageJson(file: string): Promise<Record<string, any>> {
	const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await stageBytes(file)));
	if (value === null || typeof value !== "object" || Array.isArray(value)) reject("reviewed stage JSON is invalid");
	return value as Record<string, any>;
}
async function evaluatorJournal(dir: string, phase: string, expected: string): Promise<Record<string, any>> {
	for (const suffix of ["json", "sha256"]) {
		const stat = await lstat(path.join(dir, `${phase}.${suffix}`));
		if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o400)
			reject("evaluator journal member is not immutable and private");
	}
	const bytes = await privateBytes(path.join(dir, `${phase}.json`), 512 * 1024);
	const seal = await privateBytes(path.join(dir, `${phase}.sha256`), CONTROL_BYTES);
	if (digest(bytes) !== expected || seal.toString("utf8") !== `${expected}\n`)
		reject("evaluator journal phase or seal differs");
	const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
	if (!value || typeof value !== "object" || Array.isArray(value) ||
		!bytes.equals(Buffer.from(`${JSON.stringify(value)}\n`, "utf8")))
		reject("evaluator journal is not canonical JSON");
	return value as Record<string, any>;
}
async function orphanEvaluatorBytes(file: string): Promise<Buffer> {
	const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	try {
		const before = await handle.stat();
		if (!before.isFile() || before.nlink !== 1 ||
			(typeof process.getuid === "function" && before.uid !== process.getuid()) ||
			(before.mode & 0o777) !== 0o400 || before.size > 512 * 1024)
			reject("orphan prepared member is not a private bounded file");
		const bytes = await handle.readFile();
		const after = await handle.stat();
		if (bytes.length !== before.size || after.dev !== before.dev || after.ino !== before.ino ||
			after.size !== before.size || after.mtimeMs !== before.mtimeMs)
			reject("orphan prepared member changed during read");
		return bytes;
	} finally { await handle.close(); }
}
/** Recheck only fixed layout paths and names bound by the review. Never follow a
 * filename offered by a journal or goal outside its canonical workspace root. */
async function evaluatorRecoveryEvidence(root: string, review: LocalEvaluatorRecoveryReviewV1,
	checkpoints: readonly LocalCheckpointReceipt[]): Promise<{ accepted: boolean }> {
	const ws = path.resolve(root, "../../..");
	const m07 = path.join(ws, "stages", "M07", review.m07.runId);
	const cp = path.join(m07, "checkpoints", review.m07.checkpointId);
	const taskRoot = path.join(m07, "tasks", review.m07.taskId);
	const work = path.join(taskRoot, "work");
	const journal = path.join(taskRoot, "host-evaluator-attempt");
	for (const dir of [path.join(ws, "stages"), path.join(ws, "stages", "MISSION"),
		path.join(ws, "stages", "MISSION", review.intentId), m07, path.join(m07, "tasks"),
		taskRoot, work, journal,
		...(review.evaluator.phase === "pre-entry-unlocated" ? [] : [
			path.join(taskRoot, "evaluator-snapshot"),
			path.join(taskRoot, "host-evaluator-output"),
			path.join(taskRoot, review.evaluator.phase === "returned" ? "host-evaluator-snapshot" :
				"host-evaluator-failure-snapshot")]),
		path.join(m07, "checkpoints"), cp,
		...(review.m04 ? [path.join(ws, "stages", "M04"),
			path.join(ws, "stages", "M04", review.m04.runId)] : [])]) {
		const stat = await lstat(dir);
		if (!stat.isDirectory() || stat.isSymbolicLink()) reject("reviewed stage directory is unsafe");
	}
	const pinned: Array<[string, string]> = [
		[path.join(ws, "stages", "MISSION", review.intentId, "run.json"), review.missionRunSha256],
		[path.join(m07, "goal.json"), review.m07.goalSha256],
		[path.join(cp, "goal.json"), review.m07.snapshotSha256],
		[path.join(cp, "manifest.json"), review.m07.manifestSha256],
		[path.join(cp, "m04-feedback.md"), review.m07.feedbackSha256]
	];
	let m04Coverage: Record<string, any> | undefined;
	if (review.m04) {
		const m04 = path.join(ws, "stages", "M04", review.m04.runId);
		pinned.push([path.join(m04, "run.json"), review.m04.runSha256],
			[path.join(m04, "m07-source.json"), review.m04.sourceSha256],
			[path.join(m04, "m04-transaction.json"), review.m04.transactionSha256],
			[path.join(m04, "m07-coverage.json"), review.m04.coverageSha256]);
	}
	for (const [file, sha] of pinned) if (await stageDigest(file) !== sha)
		reject("reviewed stage evidence differs");
	if (review.m04) {
		const m04 = path.join(ws, "stages", "M04", review.m04.runId);
		const run = await stageJson(path.join(m04, "run.json"));
		const source = await stageJson(path.join(m04, "m07-source.json"));
		const transaction = await stageJson(path.join(m04, "m04-transaction.json"));
		m04Coverage = await stageJson(path.join(m04, "m07-coverage.json"));
		if (run.stage !== "M04" || run.runId !== review.m04.runId ||
			run.status !== "completed" ||
			!Array.isArray(run.inputs) ||
			!run.inputs.some((row: any) => row.path === path.join(cp, "manifest.json")) ||
			!run.inputs.some((row: any) => row.path === path.join(cp, "m04-feedback.md")) ||
			source.m07RunId !== review.m07.runId ||
			source.checkpointId !== review.m07.checkpointId ||
			source.feedbackBundlePath !== path.join(cp, "m04-feedback.md") ||
			source.goalSnapshotPath !== path.join(cp, "goal.json") ||
			source.manifestPath !== path.join(cp, "manifest.json") ||
			transaction.version !== 1 || transaction.kind !== "m04-knowledge-transaction" ||
			transaction.m04RunId !== review.m04.runId ||
			m04Coverage.promptOutcome !== "returned" || !Array.isArray(m04Coverage.returnedRanges) ||
			!["no-proposal", "merged"].includes(transaction.state))
			reject("optional M04 facts do not bind a settled checkpoint handoff");
	}
	const mission = await stageJson(pinned[0][0]);
	if (mission.stage !== "MISSION" || mission.runId !== review.intentId ||
		mission.status === "completed" || !Array.isArray(mission.inputs) ||
		!mission.inputs.some((row: any) => row.path === path.join(root, "evidence", "original-objective.json")))
		reject("reviewed mission intent is not interrupted");
	const goal = await stageJson(path.join(m07, "goal.json"));
	const task = goal.tasks?.find((row: any) => row.taskId === review.m07.taskId);
	const operation = goal.executionState?.operations?.find((row: any) => row.id === review.m07.operationId);
	const checkpoint = goal.checkpoints?.find((row: any) => row.id === review.m07.checkpointId);
	if (goal.runId !== review.m07.runId || !task || !operation || !checkpoint ||
		goal.tasks.length !== 1 || goal.executionState?.operations?.length !== 1 ||
		goal.problemRelation !== `Local original objective mission: ${review.missionId}\n${
			(JSON.parse((await privateBytes(path.join(root, "original-contract.json"), CHECKPOINT_BYTES))
				.toString("utf8")) as { goal?: string }).goal}` ||
		!goal.executionState?.attempts?.some((row: any) => same(row.runDescriptor?.process, review.dispatchOriginAttempt.process)) ||
		task.workDir !== work || operation.taskId !== task.taskId ||
		!["response-received", "partial-settled", "confirmed", "not-issued"].includes(operation.status) ||
		checkpoint.rootDir !== cp || checkpoint.goalSnapshotPath !== path.join(cp, "goal.json") ||
		checkpoint.manifestPath !== path.join(cp, "manifest.json") ||
		checkpoint.feedbackPath !== path.join(cp, "m04-feedback.md") ||
		!["complete", "indexed"].includes(checkpoint.feedbackStatus))
		reject("M07 task, effect or checkpoint is not settled and bound");
	const snapshot = await stageJson(path.join(cp, "goal.json"));
	const manifest = await stageJson(path.join(cp, "manifest.json"));
	if (snapshot.runId !== review.m07.runId ||
		snapshot.tasks?.find((row: any) => row.taskId === review.m07.taskId)?.status !== task.status ||
		manifest.m07RunId !== review.m07.runId || manifest.checkpointId !== review.m07.checkpointId ||
		!Array.isArray(manifest.selectedTaskIds) ||
		!same(manifest.selectedTaskIds, [review.m07.taskId]))
		reject("M07 checkpoint snapshot or manifest does not bind reviewed task");
	if (review.m04) {
		const snapTask = snapshot.tasks.find((row: any) => row.taskId === review.m07.taskId);
		const artifactPaths = (snapTask?.review?.artifacts ?? []).filter((item: any) =>
			item.mediaType === "text").map((item: any) => path.relative(cp, item.path).replaceAll("\\", "/"));
		const expectedReads = [...new Set(["goal.json", "manifest.json", "m04-feedback.md",
			...artifactPaths])];
		if (!same(review.m04.requiredM07ReadPaths, expectedReads))
			reject("M04 required read paths differ from checkpoint artifacts");
		await requiredM07Reads(cp, review.m04.requiredM07ReadPaths);
		await assertFullM07Reads(cp, review.m04.requiredM07ReadPaths,
			m04Coverage!.returnedRanges);
	}
	const lineageFiles = [path.join(root, "dispatch-links", `${review.intentId}.json`),
		path.join(m07, "mission-dispatch-link.json")];
	const sides = await Promise.all(lineageFiles.map(file => stageBytes(file)));
	if (!sides[0].equals(sides[1]) || digest(sides[0]) !== review.lineageSha256)
		reject("bidirectional dispatch lineage differs");
	const lineage = JSON.parse(sides[0].toString("utf8")) as Record<string, any>;
	const lineageCommit = await stageJson(path.join(root, "dispatch-links", `${review.intentId}.commit.json`));
	if (!exact(lineage, ["version", "kind", "missionId", "intentId", "oldAttempt", "intentCheckpoint",
		"m07RunId", "taskId", "assessorTaskSha256", "m07TaskInputsSha256", "m07TaskChecksSha256",
		"m07Owner"]) || lineage.version !== 1 || lineage.kind !== "local-mission-m07-dispatch-lineage" ||
		lineage.missionId !== review.missionId || lineage.intentId !== review.intentId ||
		!same(lineage.oldAttempt, review.dispatchOriginAttempt) ||
		!same(lineage.m07Owner, review.dispatchOriginAttempt.process) ||
		lineage.m07RunId !== review.m07.runId || lineage.taskId !== review.m07.taskId ||
		lineage.m07TaskInputsSha256 !== digest(JSON.stringify(task.inputs)) ||
		lineage.m07TaskChecksSha256 !== digest(JSON.stringify(task.checks)) ||
		!exact(lineageCommit, ["version", "kind", "intentId", "lineageSha256"]) ||
		lineageCommit.version !== 1 || lineageCommit.kind !== "local-mission-m07-dispatch-commit" ||
		lineageCommit.intentId !== review.intentId || lineageCommit.lineageSha256 !== review.lineageSha256)
		reject("dispatch lineage does not bind reviewed task");
	const intentCheckpoint = lineage.intentCheckpoint as { sequence?: number; sha256?: string } | undefined;
	const start = checkpoints.findIndex(row => row.sequence === intentCheckpoint?.sequence &&
		row.sha256 === intentCheckpoint?.sha256 && same(row.source, review.dispatchOriginAttempt));
	const end = checkpoints.findIndex(row => row.sequence === review.oldCheckpoint.sequence &&
		row.sha256 === review.oldCheckpoint.sha256 && same(row.source, review.oldAttempt));
	if (start < 0 || end < start || checkpoints.slice(start, end + 1).some(row =>
		Number(row.source.attemptId.slice(1)) < Number(review.dispatchOriginAttempt.attemptId.slice(1)) ||
		Number(row.source.attemptId.slice(1)) > Number(review.oldAttempt.attemptId.slice(1))))
		reject("intervening held checkpoint chain is not exact");
	const initial = JSON.parse((await privateBytes(checkpointPaths(root, review.dispatchOriginAttempt.attemptId,
		intentCheckpoint!.sequence!).bin, CHECKPOINT_BYTES)).toString("utf8")) as ObjectiveProgressV1;
	if (initial.continuation?.pendingAction?.target?.goalRunId !== review.intentId ||
		!same(initial.continuation.unresolvedOperationIds, [review.intentId]) ||
		lineage.assessorTaskSha256 !== digest(JSON.stringify(initial.assessment?.nextTask)))
		reject("lineage intent checkpoint differs from frozen assessor task");
	for (const row of checkpoints.slice(start + 1, end + 1)) {
		const next = JSON.parse((await privateBytes(checkpointPaths(root, row.source.attemptId,
			row.sequence).bin, CHECKPOINT_BYTES)).toString("utf8")) as ObjectiveProgressV1;
		if (!same(next.contract, initial.contract) || !same(next.assessment, initial.assessment) ||
			!same(next.assessmentHistory, initial.assessmentHistory) ||
			!same(next.boundedRuns, initial.boundedRuns) ||
			!same(next.selectedArtifacts, initial.selectedArtifacts) ||
			!same(next.availableArtifacts, initial.availableArtifacts) ||
			!(same(next.continuation?.unresolvedOperationIds, [review.intentId]) ||
				same(next.continuation?.unresolvedOperationIds, [review.intentId, review.m07.runId].sort())))
			reject("intervening checkpoint changed scientific history or unrelated refs");
	}
	if (review.evaluator.phase === "pre-entry-unlocated") {
		for (const part of ["host-evaluator-output", "host-evaluator-snapshot"]) {
			const directory = path.join(taskRoot, part);
			const info = await lstat(directory);
			if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 ||
				(await readdir(directory)).length)
				reject("orphan evaluator preparation has unsafe or nonempty observation directories");
		}
		for (const part of ["host-evaluator-failure-snapshot"]) {
			const directory = path.join(taskRoot, part);
			try {
				const info = await lstat(directory);
				if (!info.isDirectory() || info.isSymbolicLink() ||
					(await readdir(directory)).length)
					reject("orphan evaluator preparation has observation files");
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
		}
		const names = (await readdir(journal)).sort();
		if (!same(names, review.evaluator.orphanMembers.map(item => item.name)))
			reject("orphan evaluator preparation has extra or missing journal members");
		for (const item of review.evaluator.orphanMembers) {
			const bytes = await orphanEvaluatorBytes(path.join(journal, item.name));
			if (digest(bytes) !== item.sha256)
				reject("orphan evaluator preparation bytes differ");
		}
		if (names.includes("prepared.json")) {
			const bytes = await orphanEvaluatorBytes(path.join(journal, "prepared.json"));
			let complete = false;
			try {
				const decoded: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
				complete = exact(decoded, ["version", "kind", "missionId", "runId", "taskId", "evaluator",
					"candidate", "frozenEvidence", "resolvedFailures"]) &&
					decoded.version === 1 && decoded.kind === "local-evaluator-prepared-input" &&
					decoded.missionId === review.missionId && decoded.runId === review.m07.runId &&
					decoded.taskId === review.m07.taskId &&
					bytes.equals(Buffer.from(`${JSON.stringify(decoded)}\n`));
			} catch {
				// An incomplete or noncanonical preparation has no evaluator entry identity.
			}
			if (complete)
				reject("complete prepared evaluator input can be recovered without a negative review");
		}
		const snapTask = snapshot.tasks.find((row: any) => row.taskId === review.m07.taskId);
		if (task.status !== "rejected" || !Array.isArray(task.review?.checks) ||
			!Array.isArray(task.checks) || task.review.checks.length !== task.checks.length ||
			task.review.checks.some((item: any) => item.result !== "not_run") ||
			!Array.isArray(snapTask?.review?.checks) ||
			snapTask.review.checks.length !== task.checks.length ||
			snapTask.review.checks.some((item: any) => item.result !== "not_run"))
			reject("orphan evaluator preparation lacks negative ordinary M07 review");
		return { accepted: false };
	}
	const journalNames = (await readdir(journal)).sort();
	const present = (phase: string) => journalNames.some(name => name.startsWith(`${phase}.`));
	if (review.evaluator.phase === "settled-failure" && present("threw") &&
		present("returned-uncommitted"))
		reject("evaluator journal has conflicting uncommitted phases");
	const phases = review.evaluator.phase === "returned" ?
		["prepared", "entered", "returned-uncommitted", "returned"] :
		["prepared", "entered", ...(present("threw") ? ["threw"] : []),
			...(present("returned-uncommitted") ? ["returned-uncommitted"] : []),
			"settled-failure"];
	const unsealedMarker = review.evaluator.phase === "settled-failure" ?
		["threw", "returned-uncommitted"].find(marker => present(marker) &&
			!journalNames.includes(`${marker}.sha256`)) : undefined;
	const expectedJournalNames = phases.flatMap(phase => phase === unsealedMarker ?
		[`${phase}.json`, ...(journalNames.includes(`${phase}.sha256.pending`) ?
			[`${phase}.sha256.pending`] : [])] : [`${phase}.json`, `${phase}.sha256`]).sort();
	if (!same(journalNames, expectedJournalNames))
		reject("evaluator journal has missing or extra phases");
	if (unsealedMarker) {
		for (const name of expectedJournalNames.filter(name => name.startsWith(`${unsealedMarker}.`))) {
			const info = await lstat(path.join(journal, name));
			if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 ||
				(info.mode & 0o777) !== 0o400 || info.size < 1 || info.size > 512 * 1024)
				reject("unsealed evaluator journal leftover is unsafe");
		}
	}
	const prepared = await evaluatorJournal(journal, "prepared", review.evaluator.preparedSha256);
	const preparedEvaluator = prepared.evaluator as { id?: unknown; version?: unknown } | undefined;
	if (!exact(prepared, ["version", "kind", "missionId", "runId", "taskId", "evaluator",
		"candidate", "frozenEvidence", "resolvedFailures"]) ||
		prepared.version !== 1 || prepared.kind !== "local-evaluator-prepared-input" ||
		prepared.missionId !== review.missionId || prepared.runId !== review.m07.runId ||
		prepared.taskId !== review.m07.taskId ||
		preparedEvaluator?.id !== review.evaluator.id ||
		preparedEvaluator?.version !== review.evaluator.version ||
		!Array.isArray(prepared.candidate) || !prepared.candidate.length ||
		!Array.isArray(prepared.frozenEvidence) || !Array.isArray(prepared.resolvedFailures) ||
		!prepared.resolvedFailures.every((row: unknown) => typeof row === "string"))
		reject("evaluator prepared inputs are not bound to reviewed task");
	const entered = await evaluatorJournal(journal, "entered", review.evaluator.enteredSha256);
	if (entered.version !== 1 || entered.kind !== "local-evaluator-attempt" ||
		entered.attemptId !== review.evaluator.attemptId || entered.missionId !== review.missionId ||
		entered.runId !== review.m07.runId || entered.taskId !== review.m07.taskId ||
		entered.evaluator?.id !== review.evaluator.id ||
		entered.evaluator?.version !== review.evaluator.version ||
		!same(entered.process, review.evaluator.owner) ||
		!same(entered.candidate, prepared.candidate) ||
		!same(entered.frozenEvidence, prepared.frozenEvidence) ||
		!same(entered.resolvedFailures, prepared.resolvedFailures))
		reject("evaluator entered phase is not bound to old task and owner");
	if (!same((await readdir(path.join(taskRoot, "evaluator-snapshot"))).sort(),
		entered.candidate.map((item: any) => item.name).sort()))
		reject("evaluator candidate snapshot census differs");
	for (const candidate of entered.candidate) {
		if (typeof candidate.name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(candidate.name) ||
			candidate.file !== path.join(taskRoot, "evaluator-snapshot", candidate.name) ||
			typeof candidate.sourceFile !== "string" || !path.isAbsolute(candidate.sourceFile) ||
			!inside(taskRoot, candidate.sourceFile) ||
			!HEX64.test(candidate.sha256) || !Number.isSafeInteger(candidate.bytes))
			reject("evaluator candidate path is not canonical");
		if (await realpath(candidate.sourceFile) !== candidate.sourceFile)
			reject("evaluator candidate source traverses a link");
		if (candidate.bytes === 0 && candidate.sourceFile === task.reportPath)
			reject("returned task report is empty");
		const source = await stageBytes(candidate.sourceFile, candidate.bytes === 0);
		const bytes = await stageBytes(candidate.file, candidate.bytes === 0);
		if (bytes.length !== candidate.bytes || digest(bytes) !== candidate.sha256 ||
			!source.equals(bytes))
			reject("evaluator candidate snapshot differs");
	}
	for (const item of entered.frozenEvidence) {
		if (typeof item.file !== "string" || !path.isAbsolute(item.file) || !inside(ws, item.file) ||
			path.resolve(item.file) !== item.file || await realpath(item.file) !== item.file ||
			!HEX64.test(item.sha256) || !Number.isSafeInteger(item.bytes))
			reject("evaluator frozen evidence path is unsafe");
		const bytes = await stageBytes(item.file);
		if (bytes.length !== item.bytes || digest(bytes) !== item.sha256)
			reject("evaluator frozen evidence differs");
	}
	for (const marker of ["threw", "returned-uncommitted"] as const) {
		if (!phases.includes(marker) || marker === unsealedMarker) continue;
		const bytes = await privateBytes(path.join(journal, `${marker}.json`), 512 * 1024);
		const value = await evaluatorJournal(journal, marker, digest(bytes));
		if (value.version !== 1 || value.kind !== `local-evaluator-${marker}` ||
			value.attemptId !== entered.attemptId || !same(value.process, entered.process))
			reject("evaluator intermediate phase is not bound to entered attempt");
	}
	const terminal = await evaluatorJournal(journal, review.evaluator.phase, review.evaluator.phaseSha256);
	if (terminal.version !== 1 || terminal.kind !== `local-evaluator-${review.evaluator.phase}` ||
		terminal.attemptId !== entered.attemptId) reject("evaluator terminal phase is not bound");
	const outputs = review.evaluator.phase === "returned" ? terminal.outputs : terminal.partialOutputs;
	if (!Array.isArray(outputs) || new Set(outputs.map((item: any) => item.name)).size !== outputs.length)
		reject("evaluator output census is invalid");
	const outputNames = outputs.map((item: any) => item.name).sort();
	if (!same((await readdir(path.join(taskRoot, "host-evaluator-output"))).sort(), outputNames) ||
		!same((await readdir(path.join(taskRoot, review.evaluator.phase === "returned" ?
			"host-evaluator-snapshot" : "host-evaluator-failure-snapshot"))).sort(), outputNames))
		reject("evaluator output directory contains unreviewed files");
	for (const item of outputs) {
		if (typeof item.name !== "string" || !/^observation-[A-Za-z0-9][A-Za-z0-9._-]{0,79}\.(?:txt|md|json|jsonl|csv|tsv)$/.test(item.name) ||
			!HEX64.test(item.sha256) || !Number.isSafeInteger(item.bytes))
			reject("evaluator output identity is invalid");
		const output = await stageBytes(path.join(taskRoot, "host-evaluator-output", item.name), true);
		if (output.length !== item.bytes || digest(output) !== item.sha256)
			reject("evaluator output bytes differ");
		if (review.evaluator.phase === "settled-failure") {
			const snapshot = await stageBytes(path.join(taskRoot, "host-evaluator-failure-snapshot", item.name), true);
			if (!snapshot.equals(output)) reject("evaluator failure snapshot differs");
		}
	}
	if (review.evaluator.phase === "settled-failure") {
		if (terminal.proof?.attemptId !== entered.attemptId ||
			!same(terminal.proof?.process, entered.process) ||
			!["no-effect", "contained"].includes(terminal.proof?.settledEffect) ||
			!Array.isArray(terminal.proof?.childProcesses) ||
			typeof terminal.proof?.operationId !== "string" ||
			terminal.proof.operationId.length === 0 ||
			typeof terminal.proof?.evidence !== "string" ||
			!terminal.proof.evidence.trim() || task.status === "accepted")
			reject("evaluator failure proof or M07 task status differs");
	} else {
		if (!Array.isArray(terminal.result?.observations) ||
			!same(terminal.result.observations.map((item: any) => item.name).sort(), outputNames))
			reject("evaluator returned output declaration differs");
		const receipt = await stageJson(path.join(work, "local-evaluator-receipt.json"));
		if (await stageDigest(path.join(work, "local-evaluator-receipt.json")) !==
			review.evaluator.receiptSha256 || receipt.version !== 1 ||
			receipt.kind !== "local-evaluator-receipt" || receipt.missionId !== review.missionId ||
			receipt.runId !== review.m07.runId || receipt.taskId !== review.m07.taskId ||
			receipt.evaluator?.id !== entered.evaluator.id ||
			receipt.evaluator?.version !== entered.evaluator.version ||
			!same(receipt.candidate, entered.candidate) ||
			!same(receipt.frozenEvidence, entered.frozenEvidence) ||
			!same(receipt.checks, terminal.result.checks) ||
			!Array.isArray(receipt.observations) ||
			!same(receipt.observations.map((item: any) => item.name).sort(), outputNames))
			reject("evaluator receipt is not bound to returned attempt");
		for (const observation of receipt.observations) {
			const output = outputs.find((item: any) => item.name === observation.name);
			if (!output || observation.file !== path.join(taskRoot, "host-evaluator-snapshot", observation.name) ||
				observation.sourceFile !== path.join(taskRoot, "host-evaluator-output", observation.name) ||
				observation.bytes !== output.bytes || observation.sha256 !== output.sha256 ||
				observation.binding?.missionId !== review.missionId ||
				observation.binding?.runId !== review.m07.runId ||
				observation.binding?.taskId !== review.m07.taskId ||
				observation.binding?.evaluatorId !== review.evaluator.id ||
				observation.binding?.evaluatorVersion !== review.evaluator.version ||
				!same(observation.binding?.candidate, entered.candidate.map((item: any) =>
					({ name: item.name, sha256: item.sha256 }))))
				reject("evaluator receipt observation binding differs");
		}
		for (const item of outputs) {
			const snapshot = await stageBytes(path.join(taskRoot, "host-evaluator-snapshot", item.name), true);
			if (snapshot.length !== item.bytes || digest(snapshot) !== item.sha256)
				reject("evaluator returned snapshot differs");
		}
	}
	if (task.status === "accepted" && (review.evaluator.phase !== "returned" ||
		!task.review || !Array.isArray(task.review.checks)))
		reject("accepted M07 task lacks ordinary review");
	return { accepted: task.status === "accepted" };
}
async function validLegacyStageEvidence(root: string,
	review: LocalLegacyInterruptedReviewV1 | LocalColdMigrationReviewV1): Promise<boolean> {
	try {
		const ws = path.resolve(root, "../../..");
		const m07 = path.join(ws, "stages", "M07", review.m07.runId);
		const cp = path.join(m07, "checkpoints", review.m07.checkpointId);
		const m04 = path.join(ws, "stages", "M04", review.m04.runId);
		const pinned: Array<[string, string]> = [
			[path.join(ws, "stages", "MISSION", review.intentId, "run.json"), review.missionRunSha256],
			[path.join(m07, "goal.json"), review.m07.goalSha256],
			[path.join(cp, "goal.json"), review.m07.snapshotSha256],
			[path.join(cp, "manifest.json"), review.m07.manifestSha256],
			[path.join(cp, "m04-feedback.md"), review.m07.feedbackSha256],
			[path.join(m04, "run.json"), review.m04.runSha256],
			[path.join(m04, "m07-source.json"), review.m04.sourceSha256],
			[path.join(m04, "m04-transaction.json"), review.m04.transactionSha256],
		];
		for (const [file, expected] of pinned) if (await stageDigest(file) !== expected) return false;
		const m04Run = JSON.parse((await stageBytes(path.join(m04, "run.json"))).toString("utf8")) as
			{ sessions?: Array<{ file?: string }> };
		const sessionFile = m04Run.sessions?.length === 1 ? m04Run.sessions[0]?.file : undefined;
		const relativeSession = sessionFile ? path.relative(ws, sessionFile) : "..";
		if (!sessionFile || !path.isAbsolute(sessionFile) ||
			relativeSession === ".." || relativeSession.startsWith(`..${path.sep}`) ||
			path.isAbsolute(relativeSession) ||
			await stageDigest(sessionFile) !== review.effectEvidence.m04SessionSha256) return false;
		const goal = JSON.parse((await stageBytes(path.join(m07, "goal.json"))).toString("utf8")) as
			{ tasks?: Array<{ taskId: string; toolLog?: unknown[] }>;
				executionState?: { attempts?: Array<{ runDescriptor?: { process?: ProcessIdentityV1 } }> } };
		const task = goal.tasks?.find(item => item.taskId === review.m07.taskId);
		return !!task && digest(JSON.stringify(task.toolLog)) === review.effectEvidence.toolLogSha256 &&
			goal.executionState?.attempts?.some(item => same(item.runDescriptor?.process,
				review.oldAttempt.process)) === true;
	} catch { return false; }
}
async function json(file: string): Promise<unknown | undefined> {
	const bytes = await optionalBytes(file, CONTROL_BYTES);
	if (!bytes) return undefined;
	try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown; }
	catch { return reject("private control JSON is invalid"); }
}
async function once(file: string, bytes: Buffer): Promise<void> {
	const directory = path.dirname(file);
	const temporary = path.join(directory, `.pending-${randomUUID()}`);
	const handle = await open(temporary,
		constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
	try { await handle.writeFile(bytes); await handle.sync(); }
	finally { await handle.close(); }
	await link(temporary, file); // EEXIST refuses overwrite atomically.
	await syncDir(directory);
	await unlink(temporary);
	await syncDir(directory);
}
async function onceJson(file: string, value: unknown): Promise<void> {
	const bytes = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
	if (bytes.length > CONTROL_BYTES) reject("private control record exceeds physical file bound");
	await once(file, bytes);
}
function evaluatorClaimFile(root: string): string {
	return path.join(root, "evaluator-recovery-claim.json");
}
async function publishEvaluatorClaim(root: string, claim: LocalEvaluatorRecoveryClaimV1): Promise<void> {
	const archive = path.join(root, "review-abandoned");
	await privateDir(archive, true);
	const temporary = path.join(archive, `.evaluator-claim-prepared-${randomUUID()}`);
	const bytes = Buffer.from(`${JSON.stringify(claim)}\n`, "utf8");
	const handle = await open(temporary,
		constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
	try { await handle.writeFile(bytes); await handle.sync(); }
	finally { await handle.close(); }
	await syncDir(archive);
	if (await optionalBytes(evaluatorClaimFile(root), CONTROL_BYTES))
		reject("evaluator recovery claim already exists before publication");
	await rename(temporary, evaluatorClaimFile(root));
	await syncDir(root);
	await syncDir(archive);
}

async function lock<T>(root: string, work: (mutation: () => void) => Promise<T>,
	review?: { owner: ProcessIdentityV1; intentId: string; oldCheckpointSha256: string }): Promise<T> {
	const file = path.join(root, ".writer.lock");
	let handle;
	try { handle = await open(file,
		constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") reject("writer lock remains; review uncertain prior mutation");
		throw error;
	}
	const identity = await handle.stat();
	await handle.writeFile(`${JSON.stringify(review ? { version: 2,
		kind: "review-successor-writer-lock", owner: review.owner,
		intentId: review.intentId, oldCheckpointSha256: review.oldCheckpointSha256 } :
		{ pid: process.pid, at: new Date().toISOString() })}\n`);
	await handle.sync();
	await handle.close();
	await syncDir(root);
	let mutationStarted = false;
	let succeeded = false;
	let simulatedCrash = false;
	try {
		const result = await work(() => { mutationStarted = true; });
		succeeded = true;
		return result;
	}
	catch (error) { simulatedCrash = error instanceof SyntheticReviewCrash; throw error; }
	finally {
		if (!simulatedCrash && (succeeded || !mutationStarted || review)) {
			const current = await lstat(file);
			if (current.dev === identity.dev && current.ino === identity.ino) {
				await unlink(file); await syncDir(root);
			}
		}
		// A failed or interrupted mutation retains the lock for explicit review.
	}
}
function attemptPath(root: string, attemptId: string): string {
	if (!validAttemptId(attemptId)) reject("attempt ID is invalid");
	return path.join(root, "attempts", attemptId);
}
function checkpointPaths(root: string, attemptId: string, sequence: number) {
	const stem = `C${String(sequence).padStart(8, "0")}`;
	const directory = path.join(attemptPath(root, attemptId), "checkpoints");
	return { bin: path.join(directory, `${stem}.bin`), receipt: path.join(directory, `${stem}.json`) };
}
async function archivePreparedReviews(root: string): Promise<void> {
	const source = path.join(root, "attempts");
	const entries = (await readdir(source)).filter(name => name.startsWith(".review-prepared-"));
	if (!entries.length) return;
	const archive = path.join(root, "review-abandoned");
	await privateDir(archive, true);
	for (const entry of entries) {
		if (!/^\.review-prepared-A[0-9]{3,}-[0-9a-f-]{36}$/.test(entry))
			reject("prepared review has an unexpected identity");
		await rename(path.join(source, entry), path.join(archive, `${entry}-${randomUUID()}`));
	}
	await syncDir(source); await syncDir(archive);
}

async function scan(root: string, ignoreCurrentLock = false): Promise<Scan> {
	await privateDir(root);
	const rootEntries = await readdir(root);
	const writerLockPresent = rootEntries.includes(".writer.lock");
	const attemptsRoot = path.join(root, "attempts");
	await privateDir(attemptsRoot);
	let repairRequired = false;
	const attemptEntries = await readdir(attemptsRoot);
	if (attemptEntries.some(name => !validAttemptId(name) &&
		!/^\.review-prepared-A[0-9]{3,}-[0-9a-f-]{36}$/.test(name)))
		reject("attempts directory has an unexpected entry");
	const preparedReviewPending = attemptEntries.some(name => name.startsWith(".review-prepared-"));
	if (preparedReviewPending) repairRequired = true;
	const names = attemptEntries.filter(validAttemptId).sort((a, b) =>
		Number(a.slice(1)) - Number(b.slice(1)));
	const attempts: LocalMissionAttempt[] = [];
	const checkpoints: LocalCheckpointReceipt[] = [];
	const unknown = new Set<string>();
	const interruptedAttemptIds: string[] = [];
	if (rootEntries.some(entry => !["attempts", "original-contract.json",
		"original-contract.receipt.json", "evidence", "assessments", "materials", "dispatch-links",
		"review-abandoned", "evaluator-recovery-claim.json",
		".writer.lock"].includes(entry)))
		repairRequired = true;
	for (const adjunct of ["evidence", "assessments", "materials", "dispatch-links", "review-abandoned"])
		if (rootEntries.includes(adjunct)) await privateDir(path.join(root, adjunct));
	if (writerLockPresent && !ignoreCurrentLock) repairRequired = true;
	let intent: LocalFinalIntent | null = null;
	let attempted: FinalAttempt | null = null;
	let finalReceipt: LocalFinalReceipt | null = null;
	const finalReceipts: LocalFinalReceipt[] = [];
	let finalState: LocalMissionStatus["final"] = "none";
	for (const [index, name] of names.entries()) {
		if (!validAttemptId(name) || Number(name.slice(1)) !== index + 1)
			reject("attempt sequence has a gap or unexpected directory");
		const directory = attemptPath(root, name);
		await privateDir(directory);
		const value = await json(path.join(directory, "source.json"));
		if (!validSource(value) || value.attemptId !== name ||
			value.predecessorAttemptId !== (index ? names[index - 1] : null) ||
			(index && value.missionId !== attempts[0].missionId))
			reject("attempt identity is absent or mismatched");
		attempts.push(value);
		const checkpointsDir = path.join(directory, "checkpoints");
		const operationsDir = path.join(directory, "operations");
		const finalDir = path.join(directory, "final");
		for (const part of [checkpointsDir, operationsDir, finalDir]) await privateDir(part);
		const entries = await readdir(checkpointsDir);
		const receipts = entries.filter(entry => /^C[0-9]{8,}\.json$/.test(entry))
			.sort((a, b) => Number(a.slice(1, -5)) - Number(b.slice(1, -5)));
		if (entries.some(entry => !/^C[0-9]{8,}\.(?:json|bin)$/.test(entry)) ||
			entries.some(entry => entry.endsWith(".bin") &&
				!receipts.includes(entry.replace(/\.bin$/, ".json")))) repairRequired = true;
		for (const entry of receipts) {
			const receipt = await json(path.join(checkpointsDir, entry));
			const previous = checkpoints.at(-1);
			const sequence = checkpoints.length + 1;
			if (!(exact(receipt, ["version", "kind", "source", "sequence", "previousSha256",
				"sha256", "bytes", "unresolvedOperationIds"]) && receipt.version === 1 ||
				exact(receipt, ["version", "kind", "source", "sequence", "previousSha256",
					"sha256", "bytes", "unresolvedOperationIds", "interruptedReview"]) && receipt.version === 2 ||
				exact(receipt, ["version", "kind", "source", "sequence", "previousSha256",
					"sha256", "bytes", "unresolvedOperationIds", "legacyInterruptedReview"]) && receipt.version === 3 ||
				exact(receipt, ["version", "kind", "source", "sequence", "previousSha256",
					"sha256", "bytes", "unresolvedOperationIds", "evaluatorRecoveryReview"]) && receipt.version === 4 ||
				exact(receipt, ["version", "kind", "source", "sequence", "previousSha256",
					"sha256", "bytes", "unresolvedOperationIds", "coldMigrationReview"]) && receipt.version === 5) ||
				receipt.kind !== "local-mission-checkpoint" ||
				!same(receipt.source, value) || receipt.sequence !== sequence ||
				receipt.previousSha256 !== (previous?.sha256 ?? null) ||
				typeof receipt.sha256 !== "string" || !HEX64.test(receipt.sha256) ||
				!Number.isSafeInteger(receipt.bytes) || Number(receipt.bytes) < 1 ||
				Number(receipt.bytes) > CHECKPOINT_BYTES || !validIds(receipt.unresolvedOperationIds) ||
				entry !== `C${String(sequence).padStart(8, "0")}.json`)
				reject("checkpoint receipt sequence or identity is invalid");
			const review = receipt.version === 2 ? receipt.interruptedReview :
				receipt.version === 3 ? receipt.legacyInterruptedReview :
				receipt.version === 4 ? receipt.evaluatorRecoveryReview : receipt.coldMigrationReview;
			if (receipt.version === 2 || receipt.version === 3 || receipt.version === 4 || receipt.version === 5) {
				if (!(receipt.version === 2 ? validInterruptedReview(review) :
					receipt.version === 3 ? validLegacyInterruptedReview(review) :
					receipt.version === 4 ? validEvaluatorRecoveryReview(review) : validColdMigrationReview(review)))
					reject("interrupted review schema is invalid");
				const bound = review as LocalInterruptedReviewV1 | LocalLegacyInterruptedReviewV1 |
					LocalEvaluatorRecoveryReviewV1 | LocalColdMigrationReviewV1;
				if (!same(bound.newAttempt, value) || !same(bound.oldAttempt, previous?.source) ||
					bound.oldCheckpoint.sequence !== previous?.sequence ||
					bound.oldCheckpoint.sha256 !== previous?.sha256 ||
					checkpoints.some(row => row.interruptedReview?.intentId === bound.intentId ||
						row.legacyInterruptedReview?.intentId === bound.intentId ||
						row.evaluatorRecoveryReview?.intentId === bound.intentId ||
						row.coldMigrationReview?.intentId === bound.intentId))
					reject("interrupted review does not bind the preceding checkpoint and successor");
			}
			const bytes = await optionalBytes(path.join(checkpointsDir, entry.replace(/\.json$/, ".bin")), CHECKPOINT_BYTES);
			if (!bytes || bytes.length !== receipt.bytes || digest(bytes) !== receipt.sha256)
				repairRequired = true;
			if ((receipt.version === 2 && validInterruptedReview(review) ||
				receipt.version === 3 && validLegacyInterruptedReview(review) ||
				receipt.version === 5 && validColdMigrationReview(review)) && bytes && previous) {
				const priorBytes = await optionalBytes(checkpointPaths(root, previous.source.attemptId,
					previous.sequence).bin, CHECKPOINT_BYTES);
				if (!priorBytes || !validReviewedProgressTransition(priorBytes, bytes, review))
					reject("reviewed checkpoint changed historical progress or replay boundary");
			}
			if ((receipt.version === 3 && validLegacyInterruptedReview(review) ||
				receipt.version === 5 && validColdMigrationReview(review)) &&
				!await validLegacyStageEvidence(root, review)) repairRequired = true;
			if (receipt.version === 4 && validEvaluatorRecoveryReview(review) && bytes && previous) {
				try {
					const evidence = await evaluatorRecoveryEvidence(root, review, checkpoints);
					const priorBytes = await privateBytes(checkpointPaths(root, previous.source.attemptId,
						previous.sequence).bin, CHECKPOINT_BYTES);
					if (!validEvaluatorProgressTransition(priorBytes, bytes, review, evidence.accepted))
						reject("reviewed evaluator checkpoint changed historical progress");
				} catch { repairRequired = true; }
			}
			checkpoints.push(receipt as LocalCheckpointReceipt);
		}
		for (const entry of await readdir(operationsDir)) {
			if (!/^[0-9a-f]{64}\.json$/.test(entry)) { repairRequired = true; continue; }
			const operation = await json(path.join(operationsDir, entry));
			if (!exact(operation, ["version", "kind", "source", "operationId", "effects", "accounting"]) ||
				operation.version !== 1 || operation.kind !== "local-mission-unknown-operation" ||
				!same(operation.source, value) || typeof operation.operationId !== "string" ||
				!SAFE_ID.test(operation.operationId) || entry !== `${digest(operation.operationId)}.json` ||
				operation.effects !== "unknown-unreconciled" || operation.accounting !== "unquantified")
				reject("unknown operation receipt is invalid");
			unknown.add(operation.operationId);
		}
		const files = await readdir(finalDir);
		if (files.some(file => !["intent.json", "attempted.json", "carry.bin", "receipt.json"].includes(file)))
			repairRequired = true;
		const intentRaw = await json(path.join(finalDir, "intent.json"));
		const attemptedRaw = await json(path.join(finalDir, "attempted.json"));
		const receiptRaw = await json(path.join(finalDir, "receipt.json"));
		const carry = await optionalBytes(path.join(finalDir, "carry.bin"), FINAL_BYTES);
		if (intentRaw !== undefined) {
			if (!exact(intentRaw, ["version", "kind", "source", "intentId", "checkpointSequence",
				"checkpointSha256", "carrySha256", "unresolvedOperationIds"]) ||
				intentRaw.version !== 1 || intentRaw.kind !== "local-mission-final-intent" ||
				!same(intentRaw.source, value) || typeof intentRaw.intentId !== "string" ||
				!SAFE_ID.test(intentRaw.intentId) || !Number.isSafeInteger(intentRaw.checkpointSequence) ||
				Number(intentRaw.checkpointSequence) < 1 ||
				typeof intentRaw.checkpointSha256 !== "string" || !HEX64.test(intentRaw.checkpointSha256) ||
				typeof intentRaw.carrySha256 !== "string" || !HEX64.test(intentRaw.carrySha256) ||
				!validIds(intentRaw.unresolvedOperationIds)) reject("final intent is invalid");
			intent = intentRaw as LocalFinalIntent;
			finalState = "reserved";
		}
		if (attemptedRaw !== undefined) {
			if (!intent || !exact(attemptedRaw, ["version", "kind", "source", "intentId", "carrySha256"]) ||
				attemptedRaw.version !== 1 || attemptedRaw.kind !== "local-mission-final-attempt" ||
				!same(attemptedRaw.source, value) || attemptedRaw.intentId !== intent.intentId ||
				attemptedRaw.carrySha256 !== intent.carrySha256) reject("final attempt is invalid");
			attempted = attemptedRaw as FinalAttempt;
			finalState = "attempted-unknown";
		}
		if (receiptRaw !== undefined) {
			if (!intent || !attempted || !carry ||
				!exact(receiptRaw, ["version", "kind", "source", "intentId",
					"checkpointSequence", "checkpointSha256", "sha256", "bytes", "transportOnly"]) ||
				receiptRaw.version !== 1 || receiptRaw.kind !== "local-mission-final-receipt" ||
				!same(receiptRaw.source, value) || receiptRaw.intentId !== intent.intentId ||
				receiptRaw.checkpointSequence !== intent.checkpointSequence ||
				receiptRaw.checkpointSha256 !== intent.checkpointSha256 ||
				receiptRaw.sha256 !== intent.carrySha256 || receiptRaw.bytes !== carry.length ||
				receiptRaw.transportOnly !== true || digest(carry) !== receiptRaw.sha256)
				reject("final receipt is invalid");
			finalReceipt = receiptRaw as LocalFinalReceipt;
			finalReceipts.push(finalReceipt);
			finalState = "committed";
		} else if (carry) repairRequired = true;
		if (index < names.length - 1 && finalState !== "committed")
			interruptedAttemptIds.push(name);
		if (index < names.length - 1) { intent = null; attempted = null; finalReceipt = null; finalState = "none"; }
	}
	const contractRaw = await optionalBytes(path.join(root, "original-contract.json"), CHECKPOINT_BYTES);
	const contractValue = await json(path.join(root, "original-contract.receipt.json"));
	let contractReceipt: LocalContractReceipt | null = null;
	const contractOrphan = Boolean(contractRaw && !contractValue);
	if (contractOrphan || !contractRaw && contractValue) repairRequired = true;
	if (contractValue) {
		if (!exact(contractValue, ["version", "kind", "source", "sha256", "bytes"]) ||
			contractValue.version !== 1 || contractValue.kind !== "local-mission-original-contract" ||
			!same(contractValue.source, attempts[0]) ||
			typeof contractValue.sha256 !== "string" || !HEX64.test(contractValue.sha256) ||
			!Number.isSafeInteger(contractValue.bytes) || Number(contractValue.bytes) < 1 ||
			Number(contractValue.bytes) > CHECKPOINT_BYTES)
			reject("original contract receipt is invalid");
		if (!contractRaw || contractRaw.length !== contractValue.bytes ||
			digest(contractRaw) !== contractValue.sha256) repairRequired = true;
		contractReceipt = contractValue as LocalContractReceipt;
	}
	const claimRaw = await json(path.join(root, "evaluator-recovery-claim.json"));
	let evaluatorRecoveryClaim: LocalEvaluatorRecoveryClaimV1 | null = null;
	if (claimRaw !== undefined) {
		if (!validEvaluatorRecoveryClaim(claimRaw) || claimRaw.missionId !== attempts[0]?.missionId ||
			!checkpoints.some(row => row.sequence === claimRaw.oldCheckpoint.sequence &&
				row.sha256 === claimRaw.oldCheckpoint.sha256))
			reject("evaluator recovery claim is invalid or unbound");
		const committed = checkpoints.find(row => row.evaluatorRecoveryReview?.intentId === claimRaw.intentId &&
			row.evaluatorRecoveryReview.oldCheckpoint.sequence === claimRaw.oldCheckpoint.sequence &&
			row.evaluatorRecoveryReview.oldCheckpoint.sha256 === claimRaw.oldCheckpoint.sha256 &&
			same(row.source.process, claimRaw.owner));
		if (!committed && (checkpoints.at(-1)?.sequence !== claimRaw.oldCheckpoint.sequence ||
			checkpoints.at(-1)?.sha256 !== claimRaw.oldCheckpoint.sha256)) repairRequired = true;
		evaluatorRecoveryClaim = claimRaw;
	}
	return { attempts, intent, attempted,
		status: { missionId: attempts[0]?.missionId ?? "", currentAttempt: attempts.at(-1) ?? null,
			contractReceipt, contractOrphan,
			latestCheckpoint: checkpoints.at(-1) ?? null, checkpointReceipts: checkpoints,
			unresolvedOperationIds: [...unknown].sort(), interruptedAttemptIds,
			final: finalState, finalReceipt, finalReceipts, repairRequired, writerLockPresent,
			preparedReviewPending, evaluatorRecoveryClaim,
			selectionAuthority: false, accounting: "unquantified" } };
}

export class LocalMissionHost {
	readonly root: string;
	readonly source: LocalMissionAttempt;
	private readonly currentIdentity: () => Promise<ProcessIdentityV1>;
	private constructor(root: string, source: LocalMissionAttempt,
		currentIdentity: () => Promise<ProcessIdentityV1>) {
		this.root = root;
		this.source = source;
		this.currentIdentity = currentIdentity;
	}

	/** Serializes all host work that could reach the old evaluator or M04. A
	 * caller must hold this claim until V4 publication or an explicit release. */
	static async claimEvaluatorRecovery(input: Readonly<{ root: string; missionId: string;
		intentId: string; oldCheckpointSequence: number; oldCheckpointSha256: string;
		currentIdentity?: () => Promise<ProcessIdentityV1>;
		probePrior?: (identity: ProcessIdentityV1) => Promise<ProcessProbe>;
		testCrashAt?: "after-claim-publish" }> ):
		Promise<{ state: "claimed"; claim: LocalEvaluatorRecoveryClaimV1 } |
			{ state: "held-by-live-owner" }> {
		if (!path.isAbsolute(input.root) || !SAFE_ID.test(input.missionId) ||
			!SAFE_ID.test(input.intentId) || !Number.isSafeInteger(input.oldCheckpointSequence) ||
			input.oldCheckpointSequence < 1 || !HEX64.test(input.oldCheckpointSha256))
			reject("evaluator recovery claim input is invalid");
		const root = path.resolve(input.root);
		const current = await (input.currentIdentity ?? readCurrentProcessIdentity)();
		if (!validProcess(current)) reject("evaluator recovery claimant identity is invalid");
		try {
			return await lock(root, async mutation => {
				const state = await scan(root, true);
				const previous = state.status.latestCheckpoint;
				if (state.status.repairRequired || state.status.missionId !== input.missionId ||
					state.status.final !== "none" || state.status.unresolvedOperationIds.length ||
					!previous || previous.sequence !== input.oldCheckpointSequence ||
					previous.sha256 !== input.oldCheckpointSha256 ||
					state.status.checkpointReceipts.some(row =>
						row.evaluatorRecoveryReview?.intentId === input.intentId))
					reject("evaluator recovery claim is stale or mission evidence is unresolved");
				const bytes = await privateBytes(checkpointPaths(root, previous.source.attemptId,
					previous.sequence).bin, CHECKPOINT_BYTES);
				const progress = JSON.parse(bytes.toString("utf8")) as ObjectiveProgressV1;
				if (progress.contract?.id !== input.missionId ||
					!progress.continuation?.unresolvedOperationIds?.includes(input.intentId) ||
					progress.stopReason !== "execution-interrupted")
					reject("evaluator recovery claim lacks an exact held intent");
				const oldOwner = previous.source.process;
				const oldProbe = await (input.probePrior ?? probeProcessIdentity)(oldOwner);
				if (oldProbe.status !== "dead" || oldProbe.identityMatch ||
					oldOwner.hostId !== current.hostId || oldOwner.bootId !== current.bootId)
					return { state: "held-by-live-owner" } as const;
				const prior = state.status.evaluatorRecoveryClaim;
				let predecessors: LocalEvaluatorRecoveryClaimV1["predecessors"] = [];
				if (prior) {
					if (prior.missionId !== input.missionId || prior.intentId !== input.intentId ||
						prior.oldCheckpoint.sequence !== input.oldCheckpointSequence ||
						prior.oldCheckpoint.sha256 !== input.oldCheckpointSha256)
						return { state: "held-by-live-owner" } as const;
					if (same(prior.owner, current)) return { state: "claimed", claim: prior } as const;
					const probe = await (input.probePrior ?? probeProcessIdentity)(prior.owner);
					if (probe.status !== "dead" || probe.identityMatch ||
						prior.owner.hostId !== current.hostId || prior.owner.bootId !== current.bootId)
						return { state: "held-by-live-owner" } as const;
					predecessors = [...prior.predecessors,
						{ claimId: prior.claimId, owner: prior.owner }];
					if (!validClaimPredecessors(predecessors, current))
						reject("dead recovery claim chain exceeds its audit bound");
					const archive = path.join(root, "review-abandoned");
					await privateDir(archive, true);
					mutation();
					await rename(evaluatorClaimFile(root), path.join(archive,
						`evaluator-claim-replaced-${prior.claimId}-${randomUUID()}.json`));
					await syncDir(root); await syncDir(archive);
				}
				const claim: LocalEvaluatorRecoveryClaimV1 = { version: 1,
					kind: "local-evaluator-recovery-claim", claimId: randomUUID(),
					missionId: input.missionId, intentId: input.intentId,
					oldCheckpoint: { sequence: input.oldCheckpointSequence,
						sha256: input.oldCheckpointSha256 }, owner: current, predecessors };
				mutation();
				await publishEvaluatorClaim(root, claim);
				if (input.testCrashAt === "after-claim-publish")
					throw new SyntheticReviewCrash("synthetic crash after evaluator recovery claim publication");
				return { state: "claimed", claim } as const;
			}, { owner: current, intentId: input.intentId,
				oldCheckpointSha256: input.oldCheckpointSha256 });
		} catch (error) {
			if (/writer lock remains/.test(String(error))) return { state: "held-by-live-owner" };
			throw error;
		}
	}

	/** Used only when no V4 successor was published. A stale process cannot
	 * release a newer owner's claim. */
	static async releaseEvaluatorRecoveryClaim(input: Readonly<{ root: string;
		claim: LocalEvaluatorRecoveryClaimV1;
		currentIdentity?: () => Promise<ProcessIdentityV1> }> ): Promise<void> {
		if (!path.isAbsolute(input.root) || !validEvaluatorRecoveryClaim(input.claim))
			reject("evaluator recovery release is invalid");
		const root = path.resolve(input.root);
		const current = await (input.currentIdentity ?? readCurrentProcessIdentity)();
		if (!same(current, input.claim.owner)) reject("evaluator recovery release owner changed");
		await lock(root, async mutation => {
			const state = await scan(root, true);
			if (!same(state.status.evaluatorRecoveryClaim, input.claim))
				reject("evaluator recovery claim was replaced or already released");
			mutation();
			await unlink(evaluatorClaimFile(root)); await syncDir(root);
		}, { owner: current, intentId: input.claim.intentId,
			oldCheckpointSha256: input.claim.oldCheckpoint.sha256 });
	}

	/** Only this exact dead review writer may release its stale lock. A prepared
	 * directory is archived, never mistaken for a committed successor. */
	static async recoverReviewLock(input: { root: string; intentId: string;
		oldCheckpointSha256: string; currentIdentity?: () => Promise<ProcessIdentityV1>;
		probePrior?: (identity: ProcessIdentityV1) => Promise<ProcessProbe> }): Promise<void> {
		const root = path.resolve(input.root);
		const file = path.join(root, ".writer.lock");
		const lockValue = await json(file);
		if (lockValue === undefined) return;
		if (!exact(lockValue, ["version", "kind", "owner", "intentId", "oldCheckpointSha256"]) ||
			lockValue.version !== 2 || lockValue.kind !== "review-successor-writer-lock" ||
			!validProcess(lockValue.owner) || lockValue.intentId !== input.intentId ||
			lockValue.oldCheckpointSha256 !== input.oldCheckpointSha256)
			reject("writer lock has no exact reviewed-successor recovery authority");
		const current = await (input.currentIdentity ?? readCurrentProcessIdentity)();
		const probe = await (input.probePrior ?? probeProcessIdentity)(lockValue.owner);
		if (probe.status !== "dead" || probe.identityMatch ||
			lockValue.owner.hostId !== current.hostId || lockValue.owner.bootId !== current.bootId)
			reject("review writer may still be live or its birth identity is unknown");
		const identity = await lstat(file);
		await archivePreparedReviews(root);
		const observed = await scan(root, true);
		const committed = observed.status.checkpointReceipts.find(row =>
			(row.interruptedReview?.intentId === input.intentId ||
				row.legacyInterruptedReview?.intentId === input.intentId ||
				row.evaluatorRecoveryReview?.intentId === input.intentId ||
				row.coldMigrationReview?.intentId === input.intentId) &&
			row.previousSha256 === input.oldCheckpointSha256);
		if (observed.status.repairRequired || !committed &&
			observed.status.latestCheckpoint?.sha256 !== input.oldCheckpointSha256)
			reject("stale review lock accompanies unrelated or damaged host evidence");
		const again = await lstat(file);
		if (identity.dev !== again.dev || identity.ino !== again.ino)
			reject("writer lock changed during recovery");
		const claim = observed.status.evaluatorRecoveryClaim;
		if (claim && committed?.version === 4 &&
			claim.intentId === committed.evaluatorRecoveryReview?.intentId &&
			claim.oldCheckpoint.sha256 === committed.evaluatorRecoveryReview.oldCheckpoint.sha256 &&
			same(claim.owner, committed.source.process)) {
			await unlink(evaluatorClaimFile(root)); await syncDir(root);
		}
		await unlink(file); await syncDir(root);
	}

	static async begin(input: Readonly<{ root: string; missionId: string; attemptId: string;
		codeRevision: string; currentIdentity?: () => Promise<ProcessIdentityV1>;
		probePrior?: (identity: ProcessIdentityV1) => Promise<ProcessProbe> }>): Promise<LocalMissionHost> {
		if (!path.isAbsolute(input.root) || !SAFE_ID.test(input.missionId) ||
			!validAttemptId(input.attemptId) || !SAFE_ID.test(input.codeRevision))
			reject("local mission source is invalid");
		const currentIdentity = input.currentIdentity ?? readCurrentProcessIdentity;
		const process = await currentIdentity();
		const root = path.resolve(input.root);
		const grandparent = await lstat(path.dirname(path.dirname(root)));
		if (!grandparent.isDirectory() || grandparent.isSymbolicLink())
			reject("local mission parent is unsafe");
		await privateDir(path.dirname(root), true);
		await privateDir(root, true);
		const attemptsRoot = path.join(root, "attempts");
		await privateDir(attemptsRoot, true);
		const source: LocalMissionAttempt = { version: 1, missionId: input.missionId,
			attemptId: input.attemptId, predecessorAttemptId: input.attemptId === "A001" ? null :
				`A${String(Number(input.attemptId.slice(1)) - 1).padStart(3, "0")}`,
			codeRevision: input.codeRevision, process };
		if (!validSource(source)) reject("local mission attempt identity is invalid");
		await lock(root, async mutation => {
			const observed = await scan(root, true);
			if (observed.status.repairRequired) reject("prior local evidence requires review");
			if (observed.attempts.length === Number(input.attemptId.slice(1))) {
				if (!same(observed.status.currentAttempt, source)) reject("attempt identity changed");
				return;
			}
			if (observed.attempts.length + 1 !== Number(input.attemptId.slice(1)) ||
				(observed.attempts.length && observed.attempts[0].missionId !== input.missionId))
				reject("attempt is not the exact successor");
			if (observed.status.evaluatorRecoveryClaim)
				reject("active evaluator recovery claim holds mission mutations");
			const prior = observed.status.currentAttempt;
			if (prior && observed.status.final !== "committed") {
				const probe = await (input.probePrior ?? probeProcessIdentity)(prior.process);
				if (probe.status !== "dead" || probe.identityMatch)
					reject("prior attempt may still be executing");
			}
			mutation();
			const directory = attemptPath(root, source.attemptId);
			await mkdir(directory, { mode: 0o700 }); await syncDir(attemptsRoot);
			for (const part of ["checkpoints", "operations", "final"]) {
				await mkdir(path.join(directory, part), { mode: 0o700 }); await syncDir(directory);
			}
			await onceJson(path.join(directory, "source.json"), source);
		});
		return new LocalMissionHost(root, source, currentIdentity);
	}

	static async status(root: string): Promise<LocalMissionStatus> {
		if (!path.isAbsolute(root)) reject("local mission directory is invalid");
		return (await scan(path.resolve(root))).status;
	}

	static async readInitialContract(root: string): Promise<Buffer | undefined> {
		const status = await LocalMissionHost.status(root);
		const receipt = status.contractReceipt;
		if (!receipt) return undefined;
		const bytes = await privateBytes(path.join(path.resolve(root), "original-contract.json"),
			CHECKPOINT_BYTES);
		if (bytes.length !== receipt.bytes || digest(bytes) !== receipt.sha256)
			reject("original contract differs from committed receipt");
		return bytes;
	}

	static async readLatestCheckpoint(root: string): Promise<Buffer | undefined> {
		const status = await LocalMissionHost.status(root);
		const receipt = status.latestCheckpoint;
		if (!receipt) return undefined;
		return LocalMissionHost.readCommittedCheckpoint(root, receipt.sequence);
	}

	static async readCommittedCheckpoint(root: string, sequence: number): Promise<Buffer> {
		if (!path.isAbsolute(root) || !Number.isSafeInteger(sequence) || sequence < 1)
			reject("checkpoint read identity is invalid");
		const status = await LocalMissionHost.status(root);
		const matches = status.checkpointReceipts.filter(row => row.sequence === sequence);
		if (matches.length !== 1) reject("checkpoint is not an exact committed sequence");
		const receipt = matches[0];
		const file = checkpointPaths(path.resolve(root), receipt.source.attemptId,
			receipt.sequence).bin;
		const bytes = await privateBytes(file, CHECKPOINT_BYTES);
		if (bytes.length !== receipt.bytes || digest(bytes) !== receipt.sha256)
			reject("checkpoint bytes differ from committed receipt");
		return bytes;
	}

	static async readCommittedFinal(root: string, attemptId: string): Promise<Buffer | undefined> {
		if (!path.isAbsolute(root) || !validAttemptId(attemptId))
			reject("final carry read identity is invalid");
		const status = await LocalMissionHost.status(root);
		const matches = status.finalReceipts.filter(row => row.source.attemptId === attemptId);
		if (!matches.length) return undefined;
		if (matches.length !== 1) reject("final carry has ambiguous receipts");
		const receipt = matches[0];
		const bytes = await privateBytes(path.join(attemptPath(path.resolve(root), attemptId),
			"final", "carry.bin"), FINAL_BYTES);
		if (bytes.length !== receipt.bytes || digest(bytes) !== receipt.sha256)
			reject("final carry bytes differ from committed receipt");
		return bytes;
	}

	private async owned(): Promise<void> {
		if (!same(await this.currentIdentity(), this.source.process))
			reject("current process differs from attempt identity");
	}
	private async mutate<T>(body: (mutation: () => void, state: Scan) => Promise<T>): Promise<T> {
		await this.owned();
		const value = await lock(this.root, async mutation => {
			const state = await scan(this.root, true);
			if (state.status.repairRequired || !same(state.status.currentAttempt, this.source))
				reject("attempt is not current or prior evidence needs review");
			if (state.status.evaluatorRecoveryClaim)
				reject("active evaluator recovery claim holds mission mutations");
			return body(mutation, state);
		});
		return value;
	}

	status(): Promise<LocalMissionStatus> { return LocalMissionHost.status(this.root); }
	readInitialContract(): Promise<Buffer | undefined> {
		return LocalMissionHost.readInitialContract(this.root);
	}

	async recordInitialContract(input: Readonly<{ attemptId: string; bytes: Buffer }> ):
		Promise<LocalContractReceipt> {
		if (input.attemptId !== this.source.attemptId || this.source.attemptId !== "A001" ||
			!Buffer.isBuffer(input.bytes) || input.bytes.length < 1 ||
			input.bytes.length > CHECKPOINT_BYTES)
			reject("original contract identity or physical byte bound is invalid");
		return this.mutate(async (mutation, state) => {
			if (state.status.contractReceipt) {
				const existing = state.status.contractReceipt;
				if (existing.sha256 === digest(input.bytes) && existing.bytes === input.bytes.length)
					return existing; // Exact retry can finish separately frozen local evidence.
				reject("original contract identity changed");
			}
			if (state.status.contractOrphan ||
				state.status.latestCheckpoint || state.status.final !== "none")
				reject("original contract was already written or research evidence exists");
			const receipt: LocalContractReceipt = { version: 1,
				kind: "local-mission-original-contract", source: this.source,
				sha256: digest(input.bytes), bytes: input.bytes.length };
			mutation();
			await once(path.join(this.root, "original-contract.json"), input.bytes);
			await onceJson(path.join(this.root, "original-contract.receipt.json"), receipt);
			return receipt;
		});
	}

	async recordUnknownOperation(input: Readonly<{ attemptId: string; operationId: string }>): Promise<void> {
		if (input.attemptId !== this.source.attemptId || !SAFE_ID.test(input.operationId))
			reject("unknown operation identity is invalid");
		await this.mutate(async (mutation, state) => {
			if (state.status.final !== "none") reject("final intent already froze this attempt");
			if (state.status.unresolvedOperationIds.includes(input.operationId)) return;
			const receipt: UnknownOperation = { version: 1, kind: "local-mission-unknown-operation",
				source: this.source, operationId: input.operationId,
				effects: "unknown-unreconciled", accounting: "unquantified" };
			mutation();
			await onceJson(path.join(attemptPath(this.root, this.source.attemptId),
				"operations", `${digest(input.operationId)}.json`), receipt);
		});
	}

	async recordCheckpoint(input: Readonly<{ attemptId: string; sequence: number;
		previousSha256: string | null; bytes: Buffer }>): Promise<LocalCheckpointReceipt> {
		if (input.attemptId !== this.source.attemptId || !Number.isSafeInteger(input.sequence) ||
			input.sequence < 1 || !Buffer.isBuffer(input.bytes) || input.bytes.length < 1 ||
			input.bytes.length > CHECKPOINT_BYTES)
			reject("checkpoint identity or physical byte bound is invalid");
		return this.mutate(async (mutation, state) => {
			if (!state.status.contractReceipt) reject("original contract is not committed");
			if (state.status.final !== "none") reject("final intent already froze this attempt");
			const latest = state.status.latestCheckpoint;
			if (input.sequence !== (latest?.sequence ?? 0) + 1 ||
				input.previousSha256 !== (latest?.sha256 ?? null))
				reject("checkpoint sequence or predecessor digest differs");
			const receipt: LocalCheckpointReceipt = { version: 1, kind: "local-mission-checkpoint",
				source: this.source, sequence: input.sequence, previousSha256: input.previousSha256,
				sha256: digest(input.bytes), bytes: input.bytes.length,
				unresolvedOperationIds: state.status.unresolvedOperationIds };
			const files = checkpointPaths(this.root, this.source.attemptId, input.sequence);
			mutation();
			await once(files.bin, input.bytes);
			await onceJson(files.receipt, receipt); // receipt is the commit marker.
			return receipt;
		});
	}

	/** Build a complete successor off to the side, then publish the attempt and
	 * its review checkpoint with one directory rename. Before rename there is no
	 * successor; afterward the progress and receipt are both committed. */
	static async commitReviewedSuccessor(input: Readonly<{ root: string; missionId: string;
		bytes: Buffer; review: LocalInterruptedReviewV1 | LocalLegacyInterruptedReviewV1 |
			LocalEvaluatorRecoveryReviewV1 | LocalColdMigrationReviewV1;
		claim?: LocalEvaluatorRecoveryClaimV1;
		currentIdentity?: () => Promise<ProcessIdentityV1>;
		probePrior?: (identity: ProcessIdentityV1) => Promise<ProcessProbe>;
		/** Supplied only by trusted host code; verifies immutable original-host refs and
		 * the finite one-shot/exclusive-owner observation, never a remote PID probe. */
		verifyColdMigrationOrigin?: (observation: ColdMigrationObservationV1) => Promise<void>;
		verifyEvidence: () => Promise<void>;
		/** Synthetic crash-window injection; never used by the CLI. */
		testCrashAt?: "after-prepare" | "after-rename"; }>): Promise<LocalCheckpointReceipt> {
		if (!path.isAbsolute(input.root) || !SAFE_ID.test(input.missionId) ||
			!Buffer.isBuffer(input.bytes) || input.bytes.length < 1 || input.bytes.length > CHECKPOINT_BYTES ||
			!(validInterruptedReview(input.review) || validLegacyInterruptedReview(input.review) ||
				validEvaluatorRecoveryReview(input.review) || validColdMigrationReview(input.review)) ||
			(input.review.kind === "local-cold-migration-host-review" &&
				typeof input.verifyColdMigrationOrigin !== "function") ||
			input.review.missionId !== input.missionId || typeof input.verifyEvidence !== "function")
			reject("reviewed successor input is invalid");
		const root = path.resolve(input.root);
		const current = await (input.currentIdentity ?? readCurrentProcessIdentity)();
		if (!same(current, input.review.newAttempt.process))
			reject("reviewed successor process changed before preparation");
		return lock(root, async mutation => {
			await archivePreparedReviews(root);
			const state = await scan(root, true);
			const prior = state.status.latestCheckpoint;
			const nextSource = input.review.newAttempt;
			if (input.review.kind === "local-evaluator-interruption-host-review") {
				const claim = state.status.evaluatorRecoveryClaim;
				if (!claim || !input.claim || !same(claim, input.claim) ||
					!same(claim.owner, current) || claim.missionId !== input.missionId ||
					claim.intentId !== input.review.intentId ||
					!same(claim.oldCheckpoint, input.review.oldCheckpoint) ||
					!same(input.review.recoveryClaim, { claimId: claim.claimId,
						owner: claim.owner, oldCheckpointSha256: claim.oldCheckpoint.sha256,
						predecessors: claim.predecessors }))
					reject("reviewed evaluator successor lacks the exact active recovery claim");
			} else if (input.claim) reject("legacy review cannot consume an evaluator recovery claim");
			if (state.status.repairRequired || !state.status.contractReceipt ||
				state.status.unresolvedOperationIds.length || state.status.final !== "none" || !prior ||
				!same(prior.source, input.review.oldAttempt) ||
				prior.sequence !== input.review.oldCheckpoint.sequence ||
				prior.sha256 !== input.review.oldCheckpoint.sha256 ||
				state.status.checkpointReceipts.some(row => row.interruptedReview?.intentId === input.review.intentId ||
					row.legacyInterruptedReview?.intentId === input.review.intentId ||
					row.evaluatorRecoveryReview?.intentId === input.review.intentId ||
					row.coldMigrationReview?.intentId === input.review.intentId) ||
				nextSource.attemptId !== `A${String(state.attempts.length + 1).padStart(3, "0")}` ||
				nextSource.predecessorAttemptId !== state.status.currentAttempt?.attemptId ||
				!same(nextSource.process, current))
				reject("reviewed successor is stale or another operation remains unresolved");
			const oldIndex = state.attempts.findIndex(row => same(row, input.review.oldAttempt));
			if (oldIndex < 0) reject("reviewed old attempt is absent");
			for (const prepared of state.attempts.slice(oldIndex + 1)) {
				const directory = attemptPath(root, prepared.attemptId);
				if (state.status.checkpointReceipts.some(row => same(row.source, prepared)) ||
					(await readdir(path.join(directory, "operations"))).length ||
					(await readdir(path.join(directory, "final"))).length)
					reject("prior prepared successor has work or external effects");
				if (!same(prepared.process, current)) {
					const probe = await (input.probePrior ?? probeProcessIdentity)(prepared.process);
					if (probe.status !== "dead" || probe.identityMatch ||
						prepared.process.hostId !== current.hostId || prepared.process.bootId !== current.bootId)
						reject("prior prepared successor may still be executing");
				}
			}
			if (input.review.kind === "local-cold-migration-host-review") {
				await input.verifyColdMigrationOrigin!(input.review.coldMigration.observation);
			} else {
				const oldProbe = await (input.probePrior ?? probeProcessIdentity)(input.review.oldAttempt.process);
				if (oldProbe.status !== "dead" || oldProbe.identityMatch ||
					input.review.oldAttempt.process.hostId !== current.hostId ||
					input.review.oldAttempt.process.bootId !== current.bootId)
					reject("old attempt death changed before successor publication");
			}
			if (input.review.kind === "local-evaluator-interruption-host-review") {
				const origin = input.review.dispatchOriginAttempt;
				const originIndex = state.attempts.findIndex(row =>
					same(row, origin));
				if (originIndex < 0 || originIndex > oldIndex)
					reject("dispatch origin is not an ancestor of the held checkpoint");
				for (const ancestor of state.attempts.slice(originIndex, oldIndex)) {
					const probe = await (input.probePrior ?? probeProcessIdentity)(ancestor.process);
					if (probe.status !== "dead" || probe.identityMatch ||
						ancestor.process.hostId !== current.hostId || ancestor.process.bootId !== current.bootId)
						reject("dispatch chain owner may still be executing");
				}
			}
			await input.verifyEvidence();
			const evaluator = input.review.kind === "local-evaluator-interruption-host-review";
			const evaluatorState = evaluator ? await evaluatorRecoveryEvidence(root,
				input.review as LocalEvaluatorRecoveryReviewV1, state.status.checkpointReceipts) : undefined;
			const priorBytes = await privateBytes(checkpointPaths(root, prior.source.attemptId,
				prior.sequence).bin, CHECKPOINT_BYTES);
			if (!(evaluator ? validEvaluatorProgressTransition(priorBytes, input.bytes,
				input.review as LocalEvaluatorRecoveryReviewV1, evaluatorState!.accepted) :
					validReviewedProgressTransition(priorBytes, input.bytes,
						input.review as LocalInterruptedReviewV1 | LocalLegacyInterruptedReviewV1 |
							LocalColdMigrationReviewV1)))
				reject("reviewed successor changes historical progress or replay boundary");
			const legacy = input.review.kind === "local-legacy-interruption-host-review";
			const cold = input.review.kind === "local-cold-migration-host-review";
			const receipt: LocalCheckpointReceipt = {
				version: evaluator ? 4 : cold ? 5 : legacy ? 3 : 2, kind: "local-mission-checkpoint", source: nextSource,
				sequence: prior.sequence + 1, previousSha256: prior.sha256,
				sha256: digest(input.bytes), bytes: input.bytes.length,
				unresolvedOperationIds: state.status.unresolvedOperationIds,
				...(evaluator ? { evaluatorRecoveryReview: input.review as LocalEvaluatorRecoveryReviewV1 } :
				cold ? { coldMigrationReview: input.review as LocalColdMigrationReviewV1 } :
				legacy ? { legacyInterruptedReview: input.review as LocalLegacyInterruptedReviewV1 } :
					{ interruptedReview: input.review as LocalInterruptedReviewV1 })
			};
			const attemptsRoot = path.join(root, "attempts");
			const preparedDir = path.join(attemptsRoot,
				`.review-prepared-${nextSource.attemptId}-${randomUUID()}`);
			await mkdir(preparedDir, { mode: 0o700 }); await syncDir(attemptsRoot);
			for (const part of ["checkpoints", "operations", "final"]) {
				await mkdir(path.join(preparedDir, part), { mode: 0o700 }); await syncDir(preparedDir);
			}
			await onceJson(path.join(preparedDir, "source.json"), nextSource);
			const stem = `C${String(receipt.sequence).padStart(8, "0")}`;
			await once(path.join(preparedDir, "checkpoints", `${stem}.bin`), input.bytes);
			await onceJson(path.join(preparedDir, "checkpoints", `${stem}.json`), receipt);
			await syncDir(path.join(preparedDir, "checkpoints")); await syncDir(preparedDir);
			if (input.testCrashAt === "after-prepare") throw new SyntheticReviewCrash("synthetic crash after review preparation");
			mutation();
			await rename(preparedDir, attemptPath(root, nextSource.attemptId));
			await syncDir(attemptsRoot);
			if (input.testCrashAt === "after-rename") throw new SyntheticReviewCrash("synthetic crash after reviewed successor publication");
			if (evaluator) { await unlink(evaluatorClaimFile(root)); await syncDir(root); }
			return receipt;
		}, { owner: current, intentId: input.review.intentId,
			oldCheckpointSha256: input.review.oldCheckpoint.sha256 });
	}

	async readCheckpoint(sequence: number): Promise<Buffer> {
		return LocalMissionHost.readCommittedCheckpoint(this.root, sequence);
	}

	async reserveFinal(input: Readonly<{ attemptId: string; intentId: string;
		checkpointSequence: number; checkpointSha256: string; carrySha256: string }> ):
		Promise<LocalFinalIntent> {
		if (input.attemptId !== this.source.attemptId || !SAFE_ID.test(input.intentId) ||
			!HEX64.test(input.checkpointSha256) || !HEX64.test(input.carrySha256))
			reject("final intent identity is invalid");
		return this.mutate(async (mutation, state) => {
			const checkpoint = state.status.latestCheckpoint;
			if (state.status.final !== "none" || !checkpoint ||
				checkpoint.sequence !== input.checkpointSequence ||
				checkpoint.sha256 !== input.checkpointSha256)
				reject("final intent is not bound to the exact latest checkpoint");
			const intent: LocalFinalIntent = { version: 1, kind: "local-mission-final-intent",
				source: this.source, intentId: input.intentId,
				checkpointSequence: checkpoint.sequence, checkpointSha256: checkpoint.sha256,
				carrySha256: input.carrySha256,
				unresolvedOperationIds: state.status.unresolvedOperationIds };
			mutation();
			await onceJson(path.join(attemptPath(this.root, this.source.attemptId),
				"final", "intent.json"), intent);
			return intent;
		});
	}

	async commitFinal(input: Readonly<{ attemptId: string; intentId: string; bytes: Buffer }> ):
		Promise<LocalFinalReceipt> {
		if (input.attemptId !== this.source.attemptId || !SAFE_ID.test(input.intentId) ||
			!Buffer.isBuffer(input.bytes) || input.bytes.length < 1 || input.bytes.length > FINAL_BYTES)
			reject("final carry identity or physical byte bound is invalid");
		return this.mutate(async (mutation, state) => {
			const intent = state.intent;
			if (state.status.final !== "reserved" || !intent || intent.intentId !== input.intentId ||
				intent.carrySha256 !== digest(input.bytes) ||
				state.status.latestCheckpoint?.sequence !== intent.checkpointSequence ||
				state.status.latestCheckpoint?.sha256 !== intent.checkpointSha256 ||
				!same(intent.unresolvedOperationIds, state.status.unresolvedOperationIds))
				reject("final carry differs from one-use intent or unknown-operation state");
			const directory = path.join(attemptPath(this.root, this.source.attemptId), "final");
			const attempted: FinalAttempt = { version: 1, kind: "local-mission-final-attempt",
				source: this.source, intentId: input.intentId, carrySha256: intent.carrySha256 };
			const receipt: LocalFinalReceipt = { version: 1, kind: "local-mission-final-receipt",
				source: this.source, intentId: input.intentId,
				checkpointSequence: intent.checkpointSequence,
				checkpointSha256: intent.checkpointSha256,
				sha256: intent.carrySha256, bytes: input.bytes.length, transportOnly: true };
			mutation();
			await onceJson(path.join(directory, "attempted.json"), attempted);
			await once(path.join(directory, "carry.bin"), input.bytes);
			await onceJson(path.join(directory, "receipt.json"), receipt);
			return receipt;
		});
	}

	async readFinal(attemptId = this.source.attemptId): Promise<Buffer | undefined> {
		return LocalMissionHost.readCommittedFinal(this.root, attemptId);
	}
}

export function openLocalMissionHost(input: Parameters<typeof LocalMissionHost.begin>[0]):
	Promise<LocalMissionHost> {
	return LocalMissionHost.begin(input);
}
