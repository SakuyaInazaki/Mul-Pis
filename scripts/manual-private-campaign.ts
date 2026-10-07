/**
 * Generic private-input M07 campaign for a manually dispatched, isolated runner.
 * No assignment text or starter source is embedded in this public entrypoint.
 * All private inputs are loaded at runtime from --input-dir and never printed.
 */
import { existsSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { chmod, copyFile, link, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { Workspace } from "../src/workspace.ts";
import { runInit } from "../src/stages/init.ts";
import { createFileKnowledgeStore } from "../src/knowledge/store.ts";
import { createM07Controller } from "../src/m07/controller.ts";
import { runMeasuredEvidenceHandoff } from "../src/m07/evidence-finalization.ts";
import { assessAndAdvanceOriginalObjective, createOriginalObjective, isCurrentObjectiveStopReason,
	objectiveProgress, runOriginalObjectiveLoop,
	writeObjectiveProgress, writeOriginalObjectiveContract } from "../src/m07/objective-progress.ts";
import type { CurrentObjectiveStopReason, HostPendingActionFactsV1, ObjectiveCapabilityV1, ObjectiveProgressV1,
	OriginalObjectiveContractV1, ObjectiveAssessmentValidationDiagnosticV1 } from "../src/m07/objective-progress.ts";
import type { GroundedIssue, GroundingSourceKind } from "../src/m07/assessor-grounding.ts";
import type { BeginGoalInput, CurrentGoal, M07TaskRecord, TaskSpecInput } from "../src/m07/types.ts";
import { runM04, type M04InvalidJudgmentEvent } from "../src/stages/m04.ts";
import { createPiSessionRunner } from "../src/runner/pi.ts";
import { appendPrivateAssessorDiagnostic, PrivateAssessorDiagnosticError, privateAssessorOsErrorCode,
	type PrivateAssessorOsErrorCode } from
	"../src/runner/private-assessor-diagnostic.ts";
import type { SessionCheckpoint, SessionHandle, SessionRunner, SessionSpec,
	TransportFailureDiagnostic } from "../src/runner/types.ts";
import { DeepSeekCampaignBudget, campaignSessionEffectId } from "../src/runner/deepseek-campaign.ts";
import type { HostEffectPrefixObservationV1,
	IncrementalCheckpointEvent } from "../src/runner/incremental-private-checkpoint.ts";
import { locateHistoryEntries } from "../src/runner/research-history-locator.ts";
import { verifyDeepSeekCnyBilling, type NativeCnyPricingProfile } from "../src/runner/deepseek-cny-pricing.ts";
import { verifyDeepSeekProviderOutputLimit,
	type DeepSeekProviderOutputLimit } from "../src/runner/deepseek-provider-limits.ts";
import { MISSION_ID, MISSION_REPOSITORY, PRIVATE_CONTINUATION_FILE_KEYS } from
	"../src/runner/signed-mission-ledger.ts";
import { CARRY_FILE_NAME, authenticatedHistoricalCarryOrigin,
	authenticatedPendingHistoricalEffectSources,
	authenticatedPriorCarryBindsAncestor, authenticatedPriorCarryBindsBundle, downloadCarryArtifact,
	isAuthenticatedPriorCarryProof, openLedgerContinuation,
	type PrivateContinuationBundle, type HostEffectReceiptV1,
	type OpaqueExecutedRunGap, type UnobservedControlDelivery } from "../src/runner/ledger-continuation.ts";
import { reviewPrivateCampaignRestartEffects } from "../src/runner/private-campaign-restart-policy.ts";
import { sealCampaignCarry, type CampaignCarrySeal } from "../src/runner/emergency-carry.ts";
import { CARRY_LOGICAL_BYTES, CARRY_SEGMENT_FILE_BYTES, carrySidecarName } from "../src/runner/carry-sidecar-codec.ts";
import { bindIndependentRestartGoal, canonicalRestartUnknowns, reserveIndependentRestart,
	type AuthenticatedRestartCarryFacts, type IndependentRestartReservation,
	type BoundIndependentRestartGoal } from "../src/m07/independent-restart.ts";
import { createConfinedCampaignFileTools } from "../src/runner/confined-campaign-files.ts";
import { acceptedArchivedOperationCensus, historicalM04EvidenceIndex, stageArchivedM07Import,
	validateArchivedM07Import } from "../src/runner/archived-m07-import.ts";
import { buildUnresolvedHistoricalM04Quarantine, hasFreshOnlyM04QuarantineForLatest,
	validateM04TransactionQuarantine, M04_TRANSACTION_QUARANTINE_FILE,
	type M04TransactionQuarantineV1, type FreshM04QuarantineBoundary } from "../src/runner/m04-quarantine.ts";
import { startPrivateCampaignHeartbeat } from "./private-campaign-heartbeat.ts";
import { WorkflowRepairNeededError, validWorkflowRepairState,
	type WorkflowRepairStateV1 } from "../src/runner/repair-liveness.ts";
import { archivePrivateM07Task, recordPrivateM04Outcome } from "../src/workflow-archive/m07-private.ts";
import { exportPortableM04Transaction } from "../src/workflow-archive/m04-transaction.ts";
import type { PortableM04KnowledgeTransactionV1 } from "../src/workflow-archive/m04-transaction.ts";
import { buildCsrChecker as buildLegacyCsrChecker } from "../src/workflow-archive/csr-checker-legacy.ts";
import { buildCsrChecker, inspectCsrTaskContract, validateCsrCandidateSource, validateCsrTargetBodies, CSR_EXPERIMENT_LIMITS, type CsrExperimentPlan } from "../src/workflow-archive/csr-checker.ts";
import { createExperienceProvider } from "../src/knowledge/experience-index.ts";
import type { KnowledgeRef, KnowledgeStore } from "../src/knowledge/types.ts";
import { HarnessError, type StageRunRecord } from "../src/types.ts";

const MODEL = "deepseek/deepseek-flash:low";
const FLAGS = ["-O2", "-std=c++17", "-fopenmp", "-pthread"];
const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHECKS = [
	"The two target parallel implementations in this bounded adapter pass are substantively different and adapter-frozen non-target source is preserved",
	"Original program checker and controller-owned independent finite full-row mutation checker pass on several CPU-only configurations",
	"Measured per-kernel timings are compared with the preserved original baselines; within the bounded rounds the candidate strategies are improved or selected for the strongest observed performance, with any lack of gain recorded honestly and no global-optimality claim",
];
const REGISTERED_CHECKS = [
	"The model-authored experiment plan names every strategy; original generators, references, checker and benchmark are preserved; every source extension passes the independent capability boundary",
	"The original program checker and isolated independent full-row finite and mutation checks pass for every registered strategy and both original references",
	"Host-owned isolated-worker roundtrip timings for model-authored cases and available threads use fair preserved references; startup, cold-call and steady-state costs are separate, and no kernel-only gain is inferred from IPC-inclusive observations",
];
function archivedM07ImportTarget(bundle: PrivateContinuationBundle, proof?: unknown):
	{ goalRunId: string; taskId: string; checks: string[]; registered: boolean } | undefined {
	let checkpoint: Record<string, any>, history: Record<string, any>;
	try {
		checkpoint = JSON.parse(bundle["objective-checkpoint.json"] ?? "null");
		history = JSON.parse(bundle["research-history.json"] ?? "null");
	} catch { fail("authenticated archived M07 import metadata is invalid"); }
	if (!Array.isArray(checkpoint?.boundedRuns) || !Array.isArray(history?.entries)) return undefined;
	// Only the latest bounded run may need a missing M04 stage. Older failures
	// remain development history, never a reason to re-import after later work.
	const latest = checkpoint.boundedRuns.at(-1);
	if (latest?.outcome !== "fulfilled" || typeof latest.runId !== "string" ||
		!/^T\d{3,}$/.test(String(latest.selectedTaskId))) return undefined;
	const matching = history.entries.filter((entry: Record<string, any>) =>
		entry?.goalRunId === latest.runId && entry.taskId === latest.selectedTaskId);
	if (matching.length !== 1) return undefined;
	let archive: Record<string, any>;
	try { archive = JSON.parse(matching[0].files?.["workflow-archive.json"] ?? "null"); }
	catch { fail("authenticated archived M07 import manifest is invalid"); }
	if (archive?.m04?.state !== "failed") return undefined;
	if (archive.goalOutcome !== "fulfilled" || archive.taskStatus !== "accepted" ||
		archive.controllerEvidence?.reviewStatus !== "accepted")
		throw new HarnessError("campaign.m04-integrity",
			"Newest fulfilled M07 task and historical archive review disagree; reconcile the authenticated record before continuing.");
	if (!acceptedArchivedOperationCensus(archive.controllerEvidence.operationOutcomes))
		throw new HarnessError("campaign.m04-integrity",
			"Accepted historical task lacks a complete settled operation census; reconcile control effects before continuing.");
	if (archive.m04.snapshotCreated === true || archive.m04.proposalSubmitted === true && !proof)
		throw new HarnessError("campaign.m04-reconciliation",
			"Failed M04 may already have submitted or merged a proposal; reconcile its existing knowledge transaction before any retry or new optimizer.");
	if (archive.m04.proposalSubmitted !== false && archive.m04.proposalSubmitted !== true ||
		archive.m04.snapshotCreated !== false)
		throw new HarnessError("campaign.m04-integrity",
			"Failed M04 proposal and snapshot outcomes are missing or malformed; reconcile the archived transaction before continuing.");
	const received = archive.controllerEvidence.reviewChecks?.map((item: Record<string, unknown>) => item.criterion);
	const registered = JSON.stringify(received) === JSON.stringify(REGISTERED_CHECKS);
	if (!registered && JSON.stringify(received) !== JSON.stringify(CHECKS))
		fail("archived M07 import checks do not match a fixed host verifier");
	if (archive.m04.proposalSubmitted === true) {
		// A rejected, never-merged draft is recoverable only through the live
		// authenticated source review or a host-sealed rejected transaction.
		validateArchivedM07Import({ proof, bundle, contractId: checkpoint.contract.id,
			goalRunId: latest.runId, taskId: latest.selectedTaskId,
			expectedChecks: registered ? REGISTERED_CHECKS : CHECKS });
	}
	return { goalRunId: latest.runId, taskId: latest.selectedTaskId,
		checks: registered ? REGISTERED_CHECKS : CHECKS, registered };
}
function chooseArchivedM07ImportTarget(bundle: PrivateContinuationBundle, proof: unknown,
	quarantine: M04TransactionQuarantineV1 | undefined): ReturnType<typeof archivedM07ImportTarget> {
	// An authenticated UNKNOWN transaction authorizes only a fresh task from
	// the older selected tuple. It cannot authorize this historical import.
	return hasFreshOnlyM04QuarantineForLatest(quarantine, bundle) ? undefined :
		archivedM07ImportTarget(bundle, proof);
}
/** A quarantine reservation authorizes the first fresh M07 goal in this live
 * workspace. Later same-run goals inherit that execution boundary, not a new
 * one-use claim or a second binding of the same receipt. */
function createOneUseRestartGoalBinder<T extends { binding: { goalRunId: string } }>(
	bind: (goalRunId: string) => Promise<T>) {
	let firstBinding: T | undefined;
	return async (goalRunId: string): Promise<{ firstBinding: T; newlyBound: boolean }> => {
		if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(goalRunId))
			fail("fresh goal identity is invalid for restart binding");
		if (firstBinding) return { firstBinding, newlyBound: false };
		const bound = await bind(goalRunId);
		if (bound.binding.goalRunId !== goalRunId)
			fail("persisted restart binding does not identify the first fresh goal");
		firstBinding = bound;
		return { firstBinding, newlyBound: true };
	};
}
const ARCHIVE_BASE_EVIDENCE_FILES = ["candidate.cpp", "verification.json", "lesson-delta.json", "experiment-plan.json", "review-decision.json"];
const roundEvidenceName = (name: string): boolean => /^round-[1-9][0-9]*-(?:candidate\.cpp|verification\.json|reviewer-feedback\.txt|reviewer-report\.md)$/.test(name);
const availablePrivateArtifactName = (name: string): boolean =>
	/^(?:candidate\.cpp|verification\.json|experiment-plan\.json|lesson-delta\.json|execution-capabilities\.json|research-history\.json|restored-candidate-verification\.json|workflow-(?:archive|[A-Za-z0-9-]+-archive)\.json|round-[1-9][0-9]*-(?:candidate\.cpp|verification\.json|reviewer-feedback\.txt|reviewer-report\.md)|(?:branch-parent|branch-child|provenance-import|iteration-[1-9][0-9]*|fallback-[0-9a-f]{12}-T[0-9]{3,}|followon|initial)-(?:candidate\.cpp|verification\.json|lesson-delta\.json|experiment-plan\.json|review-decision\.json|m04-adopted-knowledge\.json|round-[1-9][0-9]*-(?:reviewer-feedback\.txt|reviewer-report\.md)))$/.test(name);
async function availablePrivateArtifactNames(directory: string): Promise<string[]> {
	return (await readdir(directory)).filter(availablePrivateArtifactName);
}
async function archiveEvidenceFiles(directory: string): Promise<string[]> {
	return [...ARCHIVE_BASE_EVIDENCE_FILES, ...(await readdir(directory)).filter(roundEvidenceName).sort()];
}
let statusOutputDir: string | undefined;
let statusRunId: string | undefined;
let statusBudget: DeepSeekCampaignBudget | undefined;
let statusPhase = "preflight";
let statusTaskTelemetry: Record<string, unknown> | undefined;
let statusBranchTelemetry: Record<string, unknown> | undefined;
let statusRuntimeKey: string | undefined;
let statusCredentialProbe: { httpStatus: number | null; accepted: boolean } | undefined;
let statusAuthSource: "runtime" | "unexpected" | undefined;
let statusSdkAuthMatch: boolean | undefined;
let statusArchiveFailure: string | undefined;
let statusPriorSelectedValidation: "passed" | "failed" | "infrastructure-unavailable" | undefined;
let statusTransportDiagnostics: TransportFailureDiagnostic[] = [];
let statusAssessorDiagnosticFailure: { code: string; generation: number; attempt: number;
	validatorCode: string; validatorMessage: string; validatorPath?: string;
	validatorDetail?: string; osErrorCode?: PrivateAssessorOsErrorCode;
	transactionExportFailure?: true } | undefined;

function unresolvedGoalControl(goal: CurrentGoal): { operationIds: string[]; taskIds: string[] } {
	return {
		operationIds: (goal.executionState?.operations ?? [])
			.filter(item => ["prepared", "issued", "unknown"].includes(item.status)).map(item => item.id),
		taskIds: goal.tasks.filter(item => ["running", "unknown"].includes(item.status)).map(item => item.taskId),
	};
}
function qualifiedOperationRef(runId: string, operationId: string): string {
	if (!runId) fail("unknown operation identity cannot be qualified safely");
	if (/^O\d{3,}$/.test(operationId)) return `${runId}/${operationId}`;
	if (operationId.startsWith(`${runId}/`) && /^O\d{3,}$/.test(operationId.slice(runId.length + 1)))
		return operationId;
	fail("unknown operation identity cannot be qualified safely");
}
function canonicalUnresolvedOperationRefs(progress: ObjectiveProgressV1): string[] {
	if (!progress.continuation.unresolvedOperationIds.length) {
		if (progress.boundedRuns.some(run => run.unresolvedOperationIds?.length))
			fail("historical unknown operations are missing from the continuation");
		return [];
	}
	return canonicalRestartUnknowns(progress).operationRefs;
}
function reservedCanonicalOperationRefs(progress: ObjectiveProgressV1,
	reservation: IndependentRestartReservation): string[] {
	const expected = canonicalUnresolvedOperationRefs(progress);
	const actual = reservation.quarantinedOperationRefs;
	if (expected.length !== actual.length || expected.some(id => !actual.includes(id)) ||
		new Set(actual).size !== actual.length)
		fail("independent-restart reservation does not cover all historical unknowns");
	return [...actual];
}
function campaignObjectiveProgress(contract: OriginalObjectiveContractV1, inheritedUnresolvedOperationIds: string[],
	input: Omit<Parameters<typeof objectiveProgress>[1], "stopReason"> &
		{ stopReason: CurrentObjectiveStopReason }): ObjectiveProgressV1 {
	const unresolvedOperationIds = [...new Set([...inheritedUnresolvedOperationIds,
		...(input.unresolvedOperationIds ?? [])])];
	return objectiveProgress(contract, { ...input,
		unresolvedOperationIds,
		...(input.stopReason === "cancelled" ? {} : { pendingActionFacts: {
			...input.pendingActionFacts, unresolvedOperationRefs: unresolvedOperationIds } }) });
}

/** New live assessments cite frozen materials. Historical free-text details
 * remain visible until grounded, without becoming new mandatory obligations. */
function assessorGroundingPolicy(evidence: readonly { name: string; file: string }[],
	prior: ObjectiveProgressV1, latest?: ObjectiveProgressV1["assessment"],
	newSelectedEvidence = false): {
	require: true; sourceKinds: Record<string, GroundingSourceKind>;
	legacyOpenDetails: string[]; previousIssues: NonNullable<NonNullable<ObjectiveProgressV1["assessment"]>["groundedAssessment"]>["issues"];
	newEvidenceSourceIds: string[] } {
	const grounded = latest?.groundedAssessment ?? prior.assessment?.groundedAssessment;
	const selectedNames = ["candidate.cpp", "verification.json", "workflow-archive.json",
		"experiment-plan.json", "m04-knowledge.json"];
	return { require: true,
		sourceKinds: Object.fromEntries(evidence.map(item => [item.name,
			item.name === "host-capabilities.json" ? "host-capability" :
			item.name === "original-problem.txt" || /^original-input-[1-9][0-9]*\.txt$/.test(item.name) ?
				"supplied-task" : "selected-evidence"])) as Record<string, GroundingSourceKind>,
		legacyOpenDetails: [...(grounded?.legacyOpenDetails ?? prior.continuation.unresolvedDetails)],
		previousIssues: grounded?.issues.map(issue => structuredClone(issue)) ?? [],
		newEvidenceSourceIds: evidence.filter(item => item.name === "host-capabilities.json" && !latest ||
			newSelectedEvidence && selectedNames.includes(item.name)).map(item => item.name) };
}

function assessorEvidenceAccess(evidence: readonly { name: string; file: string }[]):
	Record<string, "required" | "retrievable"> {
	return Object.fromEntries(evidence.map(item => [item.name,
		item.name === "prior-research-history.json" ||
		/^prior-research-history-part-[0-9]+\.txt$/.test(item.name) ||
		/^prior-research-history-catalog-[0-9]+\.json$/.test(item.name) ||
		/^prior-grounding-part-[0-9]+\.jsonl$/.test(item.name) ?
			"retrievable" : "required"]));
}

const OBJECTIVE_SUPPORTED_TASK_SCOPES = ["two-target-existing", "registered-csr-experiment"] as const;

function observedUnavailableCapabilities(adapters: readonly ObjectiveCapabilityV1[],
	unsupported: readonly string[], limits: Readonly<Record<string, number>>): ObjectiveCapabilityV1[] {
	const observations: ObjectiveCapabilityV1[] = unsupported.map((description, index) => ({
		scope: `host.unavailable.observation-${index + 1}`, available: false,
		description: `Observed unsupported capability: ${description}`,
		limits: ["This observation limits the current host; it does not redefine the original task"] }));
	const numeric: ObjectiveCapabilityV1[] = Object.entries(limits)
		.filter((entry): entry is [string, number] => typeof entry[1] === "number" && Number.isFinite(entry[1]))
		.map(([key, value]) => {
			const bound = key.startsWith("min") ? "below" : "above";
			const slug = key.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`);
			return { scope: `host.unavailable.${bound}-${slug}`, available: false,
				description: `Outside the current registered ${key} bound (${bound} ${value})`,
				limits: [`registeredLimits.${key}=${value}`,
					"This is an executor allocation bound, not a scientific requirement"] };
		});
	const rows = [...adapters.filter(item => !item.available), ...observations, ...numeric];
	if (new Set(rows.map(item => item.scope)).size !== rows.length)
		fail("unavailable host capability scope collision");
	return rows;
}

function frozenCapabilityLocators(hostText: string, unavailable: readonly ObjectiveCapabilityV1[]) {
	const lines = hostText.split("\n");
	return Object.fromEntries(unavailable.map(item => {
		const scopeRow = `"scope": ${JSON.stringify(item.scope)},`;
		const hits = lines.flatMap((line, index) => line.trim() === scopeRow ? [index + 1] : []);
		if (hits.length !== 1) fail("unavailable capability scope is not uniquely frozen in host evidence");
		return [item.scope, { sourceId: "host-capabilities.json", startLine: hits[0]!, endLine: hits[0]! }];
	}));
}

/** The complete prior issue record stays available under the existing per-file
 * evidence bound. The required index is a locator, not scientific authority. */
async function stagePriorGroundingRecords(directory: string, input: {
	legacyOpenDetails: readonly string[]; previousIssues: readonly GroundedIssue[];
}): Promise<{ evidence: Array<{ name: string; file: string }>;
	priorGroundingIndex: { indexName: string; partNames: string[] } }> {
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const partNames: string[] = [];
	const parts: Array<{ name: string; file: string }> = [];
	const legacyLocators: Array<{ partName: string; line: number }> = [];
	const issueLocators: Array<{ id: string; partName: string; line: number }> = [];
	let lines: string[] = [], bytes = 0;
	const flush = async () => {
		if (!lines.length) return;
		const name = `prior-grounding-part-${String(partNames.length + 1).padStart(6, "0")}.jsonl`;
		const file = path.join(directory, name);
		await writeFile(file, `${lines.join("\n")}\n`, { mode: 0o600 });
		partNames.push(name); parts.push({ name, file }); lines = []; bytes = 0;
	};
	const add = async (record: { kind: "legacy-detail"; value: string } |
		{ kind: "issue"; value: GroundedIssue }): Promise<{ partName: string; line: number }> => {
		const line = JSON.stringify(record), length = Buffer.byteLength(`${line}\n`, "utf8");
		if (length > 1_000_000) fail("one prior grounding record exceeds the per-file evidence bound");
		if (bytes + length > 1_000_000) await flush();
		const partName = `prior-grounding-part-${String(partNames.length + 1).padStart(6, "0")}.jsonl`;
		lines.push(line); bytes += length;
		return { partName, line: lines.length };
	};
	for (const value of input.legacyOpenDetails)
		legacyLocators.push(await add({ kind: "legacy-detail", value }));
	for (const value of input.previousIssues)
		issueLocators.push({ id: value.id, ...await add({ kind: "issue", value }) });
	await flush();
	const indexName = "prior-grounding-index.json";
	const indexText = `${JSON.stringify({ version: 1, kind: "prior-grounding-index",
		parts: partNames, legacyLocators, issueLocators })}\n`;
	if (Buffer.byteLength(indexText, "utf8") > 1_000_000)
		fail("prior grounding index exceeds the per-file evidence bound");
	const index = { name: indexName, file: path.join(directory, indexName) };
	await writeFile(index.file, indexText, { mode: 0o600 });
	return { evidence: [index, ...parts], priorGroundingIndex: { indexName, partNames } };
}
function observedTransportActionFacts(stopReason: CurrentObjectiveStopReason,
	diagnostics: readonly TransportFailureDiagnostic[],
	requestAudit: ReturnType<DeepSeekCampaignBudget["requestAccountingAuditSnapshot"]>,
	failedStage: "read-only-assessor" | "m07-execution"): HostPendingActionFactsV1 {
	if (stopReason !== "assessment-failed" && stopReason !== "dispatch-failed") return {};
	const byId = new Map(requestAudit.requests.map(request => [request.requestId, request]));
	const successors = new Map<string, (typeof requestAudit.requests)[number]>();
	for (const request of requestAudit.requests) {
		if (request.retryOfRequestId && byId.has(request.retryOfRequestId))
			successors.set(request.retryOfRequestId, request);
	}
	const recovered = (requestId: string): boolean => {
		const visited = new Set<string>();
		let current = requestId;
		while (!visited.has(current)) {
			visited.add(current);
			const next = successors.get(current);
			if (!next) return false;
			if (next.responseReceived && next.reportedUsage !== null &&
				!next.contextRejected) return true;
			if (!next.contextRejected || !next.responseReceived) return false;
			current = next.requestId;
		}
		return false;
	};
	const unrecovered = diagnostics.some(row =>
		!row.requestId || !recovered(row.requestId));
	return { failedStage,
		...(unrecovered ? { transportFailure: true } : {}) };
}
function observedRequestContract(diagnosticsBefore: number,
	diagnostics: readonly TransportFailureDiagnostic[]): HostPendingActionFactsV1["requestContract"] {
	if (!Number.isSafeInteger(diagnosticsBefore) || diagnosticsBefore < 0 ||
		diagnosticsBefore > diagnostics.length) fail("request contract diagnostic cursor is invalid");
	const row = diagnostics.slice(diagnosticsBefore).findLast(item =>
		item.wholePromptNotIssued === true && item.requestContractViolation !== undefined);
	return row?.requestContractViolation ? { violation: row.requestContractViolation,
		messageIndex: row.requestContractMessageIndex ?? null } : undefined;
}
function observeTransport(handle: SessionHandle, diagnostics: TransportFailureDiagnostic[]): SessionHandle {
	let delivered = 0;
	return { ...handle, prompt: async message => {
		try { return await handle.prompt(message); }
		finally {
			const rows = handle.transportDiagnostics?.() ?? [];
			diagnostics.push(...rows.slice(delivered));
			delivered = rows.length;
		}
	} };
}
function archivedRequestContract(archive: Awaited<ReturnType<typeof archivePrivateM07Task>>):
	HostPendingActionFactsV1["requestContract"] {
	if (archive.loopStopReason !== "request-contract-invalid") return undefined;
	const rows = archive.controllerEvidence.operationOutcomes?.filter(item =>
		item.status === "not-issued" && item.requestContractNotIssued) ?? [];
	if (rows.length !== 1 || !rows[0].requestContractNotIssued)
		fail("request-contract repair lacks its validated private archive receipt");
	return { violation: rows[0].requestContractNotIssued.violation,
		messageIndex: rows[0].requestContractNotIssued.messageIndex };
}
function sha256(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function createPrivateCampaignBudget(nativeCnyPricing: NativeCnyPricingProfile | undefined,
	providerOutputLimit: DeepSeekProviderOutputLimit): DeepSeekCampaignBudget {
	return new DeepSeekCampaignBudget({ model: MODEL, endpoint: "https://api.deepseek.com",
		accountingMode: "accounting-only",
		providerOutputLimit, outputAccountingMarginTokens: 32,
		estimatedInputCnyPerMillionTokens: nativeCnyPricing?.rates.inputMiss ?? 0,
		estimatedCacheReadCnyPerMillionTokens: nativeCnyPricing?.rates.cacheRead ?? 0,
		estimatedOutputCnyPerMillionTokens: nativeCnyPricing?.rates.output ?? 0,
		...(nativeCnyPricing ? { nativeCnyPricing } : {}) });
}
function authenticatedHistoricalCarryFacts(proof: unknown,
	bundle: PrivateContinuationBundle): AuthenticatedRestartCarryFacts | undefined {
	const carriedOrigin = authenticatedHistoricalCarryOrigin(proof, bundle);
	if (!isAuthenticatedPriorCarryProof(proof) || !authenticatedPriorCarryBindsBundle(proof, bundle) ||
		(proof.resultArtifact !== undefined && proof.resultArtifact.digestScope !== "github-artifact-archive") ||
		(!carriedOrigin && (proof.priorCommittedCny === undefined ||
			proof.priorUnknownHeldCny === undefined))) return undefined;
	const artifact = proof.resultArtifact;
	const immutableRef = artifact ?
		`github-actions://${artifact.repository}/runs/${artifact.runId}/artifacts/${artifact.artifactId}/${artifact.artifactName}` : undefined;
	return { source: { runId: proof.source.runId, runAttempt: proof.source.runAttempt,
		commit: proof.source.commit },
		currentRun: { runId: proof.admittedCurrent.runId, runAttempt: proof.admittedCurrent.runAttempt,
			commit: proof.admittedCurrent.commit },
		envelopeSha256: proof.envelopeSha256, privateBundleSha256: proof.privateBundleSha256!,
		terminal: { state: "terminal", sourceRunId: proof.source.runId,
			sourceRunAttempt: proof.source.runAttempt,
			observationDigest: sha256(JSON.stringify({ source: proof.source,
				terminal: proof.terminal, resultArtifact: artifact })),
			observedAt: new Date().toISOString() },
		...(artifact && immutableRef ? { resultArtifact: { immutableRef,
			digestScope: artifact.digestScope, sha256: artifact.archiveSha256 } } : {}),
		committedNano: carriedOrigin?.historicalCommittedNano ?? Math.ceil(proof.priorCommittedCny! * 1_000_000_000),
		unknownHeldNano: carriedOrigin?.historicalUnknownHeldNano ?? Math.ceil(proof.priorUnknownHeldCny! * 1_000_000_000) };
}
function historicalGapEvidence(facts: AuthenticatedRestartCarryFacts,
	opaqueGaps: readonly Pick<OpaqueExecutedRunGap, "source" | "resultArtifact">[],
	historyAvailable: boolean,
	unobservedControls: readonly UnobservedControlDelivery[] = []): Record<string, unknown> {
	return { version: 1, kind: "untrusted-private-history-gap",
		selectedCandidate: "authenticated currently selected bounded task; current correctness was revalidated without adopting old timings",
		baselineCarry: { source: facts.source, envelopeSha256: facts.envelopeSha256,
			resultArtifact: facts.resultArtifact ? { immutableArtifactRef: facts.resultArtifact.immutableRef,
				digestScope: facts.resultArtifact.digestScope,
				artifactSha256: facts.resultArtifact.sha256 } : { state: "expired-or-unavailable" } },
		opaqueExecutedRuns: opaqueGaps.map(gap => ({ source: gap.source,
			resultArtifact: { immutableArtifactRef: `github-actions://${gap.resultArtifact.repository}/runs/${gap.resultArtifact.runId}/artifacts/${gap.resultArtifact.artifactId}/${gap.resultArtifact.artifactName}`,
				digestScope: gap.resultArtifact.digestScope,
				artifactSha256: gap.resultArtifact.archiveSha256 },
			accounting: "unquantified", effectState: "unknown-unreconciled" })),
		unobservedControlDeliveries: unobservedControls.map(row => ({
			controlCommit: row.controlCommit, testedSourceCommit: row.testedSourceCommit,
			admittedBy: row.admittedBy, observedRunsAtAdmission: row.observedRunsAtAdmission,
			accounting: "unquantified", effectState: "unknown-unreconciled",
			interpretation: "A control ref accepted this request, but a model-capable Actions run was not observed at admission. The earlier delivery and any hidden suffix remain UNKNOWN; do not replay or adopt its result." })),
		laterFailedAttempt: historyAvailable ?
			"The authenticated carry has bounded unselected history files. They may be read as development evidence, never inferred as adopted truth or as the contents of an opaque run." :
			"Encrypted result content is unavailable to this runner; source, plan, verification and feedback must not be inferred.",
		oldOperationOutcome: "Historical operation and accepted-control delivery outcomes remain unknown; existing quantified holds remain recorded and opaque or unobserved exposure stays unquantified.",
		providerTransportCause: "unavailable in the authenticated prior carry; do not infer an HTTP status or replay an unreceived request",
		newExecution: "independent fresh workspace and goal only; old task is not resumed or reconciled" };
}
async function writePrivateJsonOnce(directory: string, name: string, value: unknown): Promise<void> {
	if (!/^[a-z][a-z0-9-]{0,100}\.json$/.test(name)) fail("invalid private receipt name");
	const target = path.join(directory, name);
	const temporary = `${target}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
	await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
	try { await link(temporary, target); }
	finally { await rm(temporary, { force: true }); }
}
function readRestartChain(text: string | undefined, kind: string): any[] {
	if (text === undefined) return [];
	let value: Record<string, unknown>;
	try { value = JSON.parse(text) as Record<string, unknown>; }
	catch { return fail("authenticated independent-restart receipt chain is invalid JSON"); }
	if (value?.version !== 1 || value.kind !== kind || !Array.isArray(value.entries) ||
		Buffer.byteLength(text, "utf8") > 4 * 1024 * 1024) fail("authenticated independent-restart receipt chain is invalid");
	const ids = new Set<string>();
	for (const entry of value.entries) {
		if (!entry || typeof entry !== "object" || Array.isArray(entry))
			fail("authenticated independent-restart chain entry is invalid");
		if (kind === "host-independent-restart-reservations") {
			const receipt = entry.receipt, claim = entry.claim;
			if ((receipt?.version !== 1 && receipt?.version !== 2) ||
				receipt.kind !== "host-independent-goal-quarantine" ||
				(receipt.version === 2 && (receipt.quarantine?.historicalEffectState !== "unknown-unreconciled" ||
					receipt.quarantine?.executionMode !== "fresh-work-only")) ||
				typeof receipt.reuseKey !== "string" || !/^[0-9a-f]{64}$/.test(receipt.reuseKey) ||
				typeof receipt.prior?.envelopeSha256 !== "string" ||
				!/^[0-9a-f]{64}$/.test(receipt.prior.envelopeSha256) ||
				claim?.priorEnvelopeSha256 !== receipt.prior.envelopeSha256 ||
				typeof claim.claimId !== "string" || !/^[0-9a-f]{64}$/.test(claim.claimId) ||
				typeof claim.currentRunId !== "string" || !/^[1-9][0-9]*$/.test(claim.currentRunId) ||
				!Number.isSafeInteger(claim.currentRunAttempt) || claim.currentRunAttempt < 1 ||
				typeof claim.currentCommit !== "string" || !/^[0-9a-f]{40}$/.test(claim.currentCommit) ||
				typeof claim.currentJobId !== "string" || !/^[1-9][0-9]*$/.test(claim.currentJobId) ||
				ids.has(receipt.reuseKey)) fail("authenticated independent-restart reservation is invalid or repeated");
			ids.add(receipt.reuseKey);
		} else if (kind === "host-independent-restart-goal-bindings") {
			if (entry.version !== 1 || entry.kind !== "host-independent-goal-binding" ||
				typeof entry.quarantineReceiptSha256 !== "string" ||
				!/^[0-9a-f]{64}$/.test(entry.quarantineReceiptSha256) ||
				typeof entry.goalRunId !== "string" || !entry.goalRunId ||
				ids.has(entry.goalRunId)) fail("authenticated independent-restart goal binding is invalid or repeated");
			ids.add(entry.goalRunId);
		} else fail("unsupported independent-restart chain kind");
	}
	return value.entries;
}
async function appendRestartReservation(outputDir: string, prior: PrivateContinuationBundle,
	receipt: unknown, claim: unknown): Promise<void> {
	const name = "independent-restart-quarantine.json";
	const entries = readRestartChain(prior[name], "host-independent-restart-reservations");
	const priorBindings = readRestartChain(prior["independent-restart-goal-binding.json"],
		"host-independent-restart-goal-bindings");
	const priorHashes = new Set(entries.map(item => sha256(JSON.stringify(item.receipt))));
	if (priorBindings.some(item => !priorHashes.has(item.quarantineReceiptSha256)))
		fail("authenticated independent-restart goal binding lacks its prior reservation");
	readRestartChain(JSON.stringify({ version: 1, kind: "host-independent-restart-reservations",
		entries: [{ receipt, claim }] }), "host-independent-restart-reservations");
	if (entries.some(item => item?.receipt?.reuseKey === (receipt as Record<string, unknown>)?.reuseKey))
		fail("independent-restart reservation reuse key is already recorded");
	await writePrivateJsonOnce(outputDir, name, { version: 1,
		kind: "host-independent-restart-reservations", entries: [...entries, { receipt, claim }] });
}
async function appendRestartGoalBinding(outputDir: string, prior: PrivateContinuationBundle,
	binding: unknown): Promise<void> {
	const receipts = readRestartChain(await readFile(path.join(outputDir,
		"independent-restart-quarantine.json"), "utf8"), "host-independent-restart-reservations");
	const receiptHashes = new Set(receipts.map(item => sha256(JSON.stringify(item?.receipt))));
	const name = "independent-restart-goal-binding.json";
	const entries = readRestartChain(prior[name], "host-independent-restart-goal-bindings");
	readRestartChain(JSON.stringify({ version: 1, kind: "host-independent-restart-goal-bindings",
		entries: [binding] }), "host-independent-restart-goal-bindings");
	if ([...entries, binding].some(item => !receiptHashes.has(item?.quarantineReceiptSha256)) ||
		entries.some(item => item?.goalRunId === (binding as Record<string, unknown>)?.goalRunId))
		fail("independent-restart goal binding does not match an immutable reservation");
	await writePrivateJsonOnce(outputDir, name, { version: 1,
		kind: "host-independent-restart-goal-bindings", entries: [...entries, binding] });
}

async function credentialProbe(key: string, request: typeof fetch = fetch): Promise<{ httpStatus: number | null; accepted: boolean }> {
	const response = await request("https://api.deepseek.com/models", {
		method: "GET", redirect: "error", signal: AbortSignal.timeout(20_000),
		headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
	});
	await response.body?.cancel().catch(() => undefined);
	return { httpStatus: Number.isInteger(response.status) ? response.status : null, accepted: response.status === 200 };
}

function privateFailureMessage(raw: unknown, runtimeKey: string | undefined): string | undefined {
	if (typeof raw !== "string" || !raw || !runtimeKey) return undefined;
	let value = raw.replaceAll(runtimeKey, "[REDACTED_KEY]")
		.replace(/sk-[A-Za-z0-9_-]{6,}/gi, "[REDACTED_KEY]")
		.replace(/Bearer\s+[^\s'"\r\n]+/gi, "Bearer [REDACTED_KEY]")
		.replace(/Authorization\s*[:=]\s*[^\r\n]+/gi, "Authorization: [REDACTED_KEY]")
		.replace(/\b(api[_-]?key|access[_-]?token|password|client[_-]?secret)\s*[:=]\s*[^\s,}&]+/gi,
			"$1=[REDACTED_KEY]");
	value = value.slice(0, 4000);
	if (value.includes(runtimeKey) || /sk-[A-Za-z0-9_-]{6,}/i.test(value) ||
		/Bearer\s+(?!\[REDACTED_KEY\])/i.test(value)) return undefined;
	return value;
}
function privateProviderErrorField(raw: string, runtimeKey: string): string | null {
	const redacted = privateFailureMessage(raw, runtimeKey);
	if (redacted === undefined) return null;
	const field = Buffer.from(redacted, "utf8").subarray(0, 4_000).toString("utf8");
	return field.includes(runtimeKey) ? null : field;
}
function taskFailureCategory(raw: unknown): string {
	if (typeof raw !== "string") return "none";
	const http = /(?:HTTP|status(?: code)?)[ :=]+(400|401|402|403|404|408|409|413|422|429|500|502|503|504)\b/i.exec(raw);
	if (http) return `http-${http[1]}`;
	if (/campaign (?:call or CNY planning ceiling exhausted|global CNY total exhausted)/i.test(raw)) return "campaign-total-ceiling";
	if (/campaign provider call limit exhausted/i.test(raw)) return "provider-call-limit";
	if (/price assumption/i.test(raw)) return "price-assumption-invalid";
	if (/provider payload exceeds the campaign boundary|input payload exceeds/i.test(raw)) return "payload-ceiling";
	if (/provider usage or call outcome is incomplete/i.test(raw)) return "usage-incomplete";
	if (/stopReason=length|terminalStopReason=length|provider length response|output cap/i.test(raw)) return "output-limit";
	if (/abort|deadline|timeout/i.test(raw)) return "abort-or-deadline";
	if (/unsafe active tool set|campaign file|custom tool|tool execution/i.test(raw)) return "tool-grant";
	if (/model.*not found|model.*resolved|model route/i.test(raw)) return "model-resolution";
	if (/did not stop normally|runner.stop/i.test(raw)) return "sdk-stop";
	return "unclassified";
}
function campaignObjectiveStop(reason: string | undefined): CurrentObjectiveStopReason | undefined {
	if (reason === "output-limit") return "output-limit";
	if (reason === "usage-reconciliation" || reason === "payload-boundary") return "accounting-integrity-error";
	return undefined;
}
function privateExceptionDiagnostic(error: unknown, runtimeKey: string | undefined):
	{ code: string; category: string; message: string | null } {
	const raw = error instanceof Error ? error.message : undefined;
	const candidateCode = error && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
	const code = typeof candidateCode === "string" && /^[A-Za-z][A-Za-z0-9._-]{0,63}$/.test(candidateCode) &&
		privateFailureMessage(candidateCode, runtimeKey) === candidateCode ?
		candidateCode : "unavailable";
	return { code, category: taskFailureCategory(raw), message: privateFailureMessage(raw, runtimeKey) ?? null };
}
/** Only literal, host-owned ledger rejection phrases can appear in the private
 * sealing diagnostic. Provider errors, task text and arbitrary Error.message
 * values must never be copied into it, even if they resemble an invariant. */
const STATIC_LEDGER_INVARIANT_MESSAGES = new Set([
	"GitHub carry freshness check could not complete",
	"GitHub carry freshness check was not accepted",
	"GitHub carry freshness response is invalid",
	"abandoned reviewed restart lacks an empty host effect census",
	"accounting-only carry version is invalid",
	"accounting-only transition receipt is invalid",
	"authenticated carry-forward origin is inconsistent",
	"authenticated carry-forward origin lacks a complete host-effect receipt",
	"authenticated host GitHub read channel closed before a response",
	"authenticated host GitHub read transport is invalid",
	"authenticated predecessor selected tuple is incomplete",
	"carry ancestry does not cover every executed workflow run",
	"carry ancestry receipt is invalid",
	"carry archive decompression failed",
	"carry archive descriptor is invalid",
	"carry archive directory is invalid",
	"carry archive download failed",
	"carry archive entry is invalid",
	"carry archive exceeds limit",
	"carry archive layout is invalid",
	"carry archive length is invalid",
	"carry archive local entry is invalid",
	"carry archive local sizes are invalid",
	"carry archive response is invalid",
	"carry archive response is unreadable",
	"carry authentication failed",
	"carry authentication fields are invalid",
	"carry checkpoint accounting is invalid",
	"carry checkpoint fields are invalid",
	"carry envelope fields are invalid",
	"carry envelope is invalid",
	"carry exceeds private artifact limit",
	"carry file fields are invalid",
	"carry file is invalid",
	"carry parent digest is invalid",
	"carry plaintext is invalid",
	"current Actions identity is not admitted for the mission ledger",
	"current Actions restart admission is no longer active",
	"current Actions restart admission was already consumed",
	"current Actions restart job identity is incomplete",
	"current M04 quarantine is not an exact append-only prior-effect record",
	"current accounting-only carry is invalid",
	"current carry accounting exceeds mission bounds",
	"current carry was already sealed",
	"current reviewed effect ancestry is not bound to restart claims",
	"current selected tuple differs from authenticated transition",
	"emergency M04 quarantine is not an exact append-only prior-effect record",
	"emergency carry lacks authenticated prior research evidence",
	"emergency carry request audit is invalid or in-flight",
	"emergency carry requires an unsealed effect-review failure",
	"emergency transport diagnostic bundle exceeds private bounds",
	"historical carry ancestry receipt is invalid",
	"historical commitment transition is invalid",
	"historical fixture cannot follow v3 sealing",
	"historical fixture sealer is unavailable",
	"historical fixture sealing is test-only",
	"intervening provider execution is unresolved",
	"intervening workflow may have executed a billable job",
	"intervening workflow run is not settled",
	"invalid carry archive redirect",
	"invalid carry artifact request",
	"invalid carry bytes",
	"invalid carry encoding",
	"invalid monetary amount",
	"invalid monetary precision",
	"legacy activation cannot inherit an accounting-only carry",
	"legacy carry version is invalid",
	"missing carry run lacks an exact terminal encrypted result artifact",
	"new selected tuple lacks a completed authenticated transition",
	"new selected tuple omitted required source or checker evidence",
	"newer workflow run disposition is unresolved",
	"newer workflow run may have executed a billable job",
	"opaque executed run gap is not an exact ordered workflow source",
	"opaque gap cannot replace the current authenticated carry source",
	"opaque gap predecessor digest is not the authenticated carry prefix",
	"pending effect ancestry is not an exact ordered carry source",
	"pending effect ancestry lacks its authenticated source",
	"prior transport diagnostic census lacks v3 ancestry authentication",
	"private carry artifact could not be read",
	"required private carry artifact is unavailable",
	"required private carry artifact is unavailable or ambiguous",
	"required private carry artifact is unavailable without an earlier authenticated carry",
	"restart claim cannot follow current carry sealing",
	"restart claim requires the exact authenticated prior carry",
	"reviewed effect ancestry does not match prior accounting and host restart claims",
	"run request commit was already used by an earlier workflow run",
	"run request is not a fast-forward empty commit of the accepted source tree",
	"run request source commit is invalid",
	"run request source lacks a successful offline regression run",
	"run request source ref is unavailable",
	"selected plan changed without a completed authenticated transition",
	"selected transition ancestry dropped its authenticated prefix",
	"selected transition ancestry omitted a selection",
	"selected transition ancestry prefix is invalid",
	"selected transition archive is missing or ambiguous",
	"selected transition current tuple is incomplete",
	"selected transition has no authenticated research bundle",
	"selected transition history is invalid",
	"selected transition predecessor tuple is missing or ambiguous",
	"selected transition receipt is invalid",
	"selected transition source or predecessor is not authenticated",
	"selected transition tuple or completed M04 archive changed",
	"signed seed run is outside verified workflow history",
	"terminal Actions source changed after the workflow listing",
	"terminal carry lacks an exact completed source and v3 checkpoint",
	"terminal host pending action is invalid",
	"terminal objective checkpoint is incomplete",
	"terminal objective checkpoint is invalid",
	"terminal objective closure lacks an independent host receipt",
	"terminal objective is not the exact signed bootstrap objective",
	"terminal objective operation ancestry is invalid",
	"terminal pending action differs from objective stop",
	"terminal selected tuple has no authenticated provenance",
	"terminal source is not the latest completed workflow run",
	"terminal workflow provider step did not execute",
	"transport diagnostic census JSON is invalid",
	"transport diagnostic census cannot follow carry sealing",
	"transport diagnostic census did not preserve its authenticated prefix",
	"transport diagnostic census differs from the final host audit",
	"transport diagnostic census fields are invalid",
	"transport diagnostic census has an invalid current request audit",
	"transport diagnostic census repeats one unknown request",
	"transport diagnostic rows do not match unknown request audit",
	"transport diagnostic source is not bound to accounting ancestry",
	"transport diagnostic source or rows are invalid",
	"unreviewed historical effect requires the live V2 fresh-only reservation",
	"untrusted carry archive redirect",
	"workflow artifact list is incomplete",
	"workflow identity or signed seed freshness is invalid",
	"workflow job disposition is incomplete",
	"workflow provider step disposition is ambiguous",
	"workflow run identity is incomplete",
	"workflow run listing changed during pagination",
	"workflow run listing is duplicated or changed during pagination",
	"workflow run listing is incomplete",
	"workflow run listing is not strictly ordered",
	"workflow run listing page is incomplete",
	"workflow run order cannot be proved exclusive",
	"workflow run pagination index is invalid",
 ]);
function privateExceptionClass(error: unknown): string | null {
	if (error instanceof HarnessError) return "HarnessError";
	if (error instanceof TypeError) return "TypeError";
	if (error instanceof RangeError) return "RangeError";
	if (error instanceof SyntaxError) return "SyntaxError";
	if (error instanceof ReferenceError) return "ReferenceError";
	if (error instanceof AggregateError) return "AggregateError";
	return error instanceof Error ? "Error" : null;
}
function privateExceptionSource(error: unknown): string | null {
	if (!(error instanceof Error)) return null;
	let stack: string | undefined;
	try { stack = error.stack; } catch { return null; }
	if (typeof stack !== "string") return null;
	const root = path.dirname(HERE);
	for (const line of stack.split("\n").slice(1, 8)) {
		const match = /(?:\(|\s)(file:\/\/\/[^()\s]+|\/[^()\s]+):(\d+):(\d+)\)?$/.exec(line.trim());
		if (!match) continue;
		let source: string;
		try { source = match[1].startsWith("file:") ? fileURLToPath(match[1]) : match[1]; }
		catch { continue; }
		const relative = path.relative(root, source).replaceAll(path.sep, "/");
		if (!/^(?:src|scripts|extensions)\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+\.tsx?$/.test(relative) ||
			relative.length > 180) continue;
		const row = Number(match[2]), column = Number(match[3]);
		if (!Number.isSafeInteger(row) || row < 1 || !Number.isSafeInteger(column) || column < 1)
			continue;
		return `${relative}:${row}:${column}`;
	}
	return null;
}
function privateErrorCore(error: unknown, runtimeKey: string | undefined, knownMessage: boolean) {
	let raw: string | undefined, code: string | null = null;
	try { raw = error instanceof Error ? error.message : undefined; } catch { /* Do not trust thrown accessors. */ }
	try {
		const candidate = error instanceof HarnessError ? error.code : undefined;
		if (typeof candidate === "string" && /^(?:runner|campaign|m07|m04)\.[A-Za-z0-9._-]{1,63}$/.test(candidate) &&
			!/(?:sk-|token|secret)/i.test(candidate) && (!runtimeKey || !candidate.includes(runtimeKey)))
			code = candidate;
	} catch { /* Do not trust thrown accessors. */ }
	// Provider payloads and multi-line request bodies are not useful error messages.
	const resemblesPayload = raw && (/[{}\r\n]/.test(raw) ||
		/\b(?:messages|prompt|requestBody)\s*[:=]/i.test(raw));
	const redacted = !knownMessage && raw && !resemblesPayload ?
		privateFailureMessage(raw, runtimeKey) : undefined;
	return { exceptionClass: privateExceptionClass(error), safeCode: code,
		source: privateExceptionSource(error), messageSha256: raw === undefined ? null : sha256(raw),
		redactedMessage: redacted ? redacted.slice(0, 1_000) : null };
}
function privateErrorMetadata(error: unknown, runtimeKey: string | undefined, knownMessage: boolean) {
	const causeChain: Array<ReturnType<typeof privateErrorCore>> = [];
	const seen = new Set<object>();
	let current = error;
	for (let depth = 0; depth < 3 && current instanceof Error; depth++) {
		if (seen.has(current)) break;
		seen.add(current);
		let cause: unknown;
		try { cause = (current as Error & { cause?: unknown }).cause; } catch { break; }
		if (!(cause instanceof Error) || seen.has(cause)) break;
		causeChain.push(privateErrorCore(cause, runtimeKey, false));
		current = cause;
	}
	return { ...privateErrorCore(error, runtimeKey, knownMessage), causeChain };
}
function privateSealDiagnostic(error: unknown,
	stage: "normal-continuation-seal" | "emergency-continuation-seal",
	runtimeKey: string | undefined = statusRuntimeKey): {
	stage: "normal-continuation-seal" | "emergency-continuation-seal";
	kind: "harness-invariant" | "unclassified-error";
	code: "runner.ledger-continuation" | null;
	invariantClass: "selected-transition" | "transport-diagnostic" | "effect-ancestry" | "accounting" | "other-ledger-invariant" | null;
	message: string | null;
	} & ReturnType<typeof privateErrorMetadata> {
	const message = error instanceof HarnessError && error.code === "runner.ledger-continuation" &&
		STATIC_LEDGER_INVARIANT_MESSAGES.has(error.message) ? error.message : null;
	return { stage,
		kind: message ? "harness-invariant" : "unclassified-error",
		code: message ? "runner.ledger-continuation" : null,
		invariantClass: !message ? null : message.startsWith("selected transition") ||
			message.startsWith("new selected tuple") || message.startsWith("current selected tuple") ||
			message.startsWith("selected plan") || message.startsWith("authenticated predecessor selected tuple") ?
			"selected-transition" : message.startsWith("transport diagnostic") ?
			"transport-diagnostic" : message.includes("effect ancestry") ||
			message.includes("effect review") || message.includes("historical effect") ?
			"effect-ancestry" : message.includes("accounting") || message.includes("request audit") ?
			"accounting" : "other-ledger-invariant",
		message, ...privateErrorMetadata(error, runtimeKey, Boolean(message)) };
}

const STATIC_COLLECTION_INVARIANT_MESSAGES = new Set([
	"continuation evidence must be a bounded regular file",
	"prior research history is invalid",
	"prior research history entry identity is invalid",
	"historical tuple lacks version binding",
	"unselected campaign evidence must be a bounded regular file",
	"research continuation exceeds the authenticated carry capacity",
	"research continuation exceeds the segmented carry capacity",
	"same-task historical archives disagree on original contract",
	"same-task historical archive has no files",
	...(["candidate.cpp", "verification.json", "experiment-plan.json"] as const)
		.map(name => `same-task historical archives disagree on ${name}`),
	"same-task historical M04 transaction bytes conflict",
	"same-task historical archive manifest is invalid",
	"same-task historical archive identity differs from its entry",
	"same-task historical M04 state is invalid",
	"same-task historical M04 transaction is undeclared",
	"same-task historical M04 outcomes conflict",
	"same-task historical M04 run identity conflicts",
	"same-task historical M04 transaction evidence was dropped",
]);
function privateCollectionDiagnostic(error: unknown, runtimeKey: string | undefined = statusRuntimeKey): {
	stage: "research-continuation-collection";
	kind: "host-invariant" | "unclassified-error";
	invariantClass: "capacity" | "evidence-integrity" | null;
	message: string | null;
	} & ReturnType<typeof privateErrorMetadata> {
	const message = error instanceof Error && STATIC_COLLECTION_INVARIANT_MESSAGES.has(error.message) ?
		error.message : null;
	return { stage: "research-continuation-collection",
		kind: message ? "host-invariant" : "unclassified-error",
		invariantClass: !message ? null : message === "research continuation exceeds the authenticated carry capacity" ||
			message === "research continuation exceeds the segmented carry capacity" ?
			"capacity" : "evidence-integrity", message,
		...privateErrorMetadata(error, runtimeKey, Boolean(message)) };
}
function privateSealOptions(collectionFailure: ReturnType<typeof privateCollectionDiagnostic> | undefined):
	{ forceEmergencyReason: "research-collection-incomplete" } | undefined {
	return collectionFailure ? { forceEmergencyReason: "research-collection-incomplete" } : undefined;
}
function privateEmergencyStatusDiagnostics(collectionFailure: ReturnType<typeof privateCollectionDiagnostic> | undefined,
	sealed: Extract<CampaignCarrySeal, { mode: "emergency-effects-unreviewed" }>) {
	return { archiveFailure: sealed.forcedReason === "research-collection-incomplete" ?
			"research-continuation-collection-failed-emergency-preserved" :
			"normal-continuation-seal-failed-emergency-preserved",
		...(collectionFailure ? { collectionFailure } : {}),
		...(sealed.forcedReason ? {} : { normalSealFailure: privateSealDiagnostic(sealed.normalFailure,
			"normal-continuation-seal") }) };
}
const FINALIZATION_FAILURE_CODES = [
	"bounded-fallback-archive-failed", "objective-checkpoint-salvage-failed",
	"objective-status-sync-failed", "host-effect-census-unavailable",
	"accounting-audit-status-write-failed", "m04-quarantine-receipt-unavailable",
	"research-continuation-collection-failed-prior-retained",
	"normal-continuation-seal-failed", "emergency-continuation-seal-failed",
	"carry-sidecar-write-failed",
	"mission-ledger-continuation-write-failed",
] as const;
type FinalizationFailureCode = (typeof FINALIZATION_FAILURE_CODES)[number];
function recordFinalizationFailure(failures: FinalizationFailureCode[], code: FinalizationFailureCode): FinalizationFailureCode {
	failures.push(code);
	return code;
}
class CarrySidecarPersistenceError extends Error {
	constructor() { super("carry sidecar could not be persisted safely"); }
}
function canonicalCarrySidecarBase64(text: unknown): text is string {
	if (typeof text !== "string" || text.length === 0 || text.length % 4 !== 0 ||
		text.length > Math.ceil(CARRY_SEGMENT_FILE_BYTES / 3) * 4) return false;
	let padding = false;
	for (let index = 0; index < text.length; index++) {
		const char = text.charCodeAt(index);
		if (char === 61) {
			padding = true;
			if (index < text.length - 2) return false;
		} else if (padding || !(char >= 65 && char <= 90 || char >= 97 && char <= 122 ||
			char >= 48 && char <= 57 || char === 43 || char === 47)) return false;
	}
	const bytes = Buffer.from(text, "base64");
	return bytes.length >= 28 && bytes.length <= CARRY_SEGMENT_FILE_BYTES &&
		bytes.toString("base64") === text;
}
async function writeSealedCarryFiles(outputDir: string,
	carry: { envelopeB64: string; sidecars?: Readonly<Record<string, string>> },
	io: { write: (target: string, data: string, options: { mode: number; flag: "wx" }) => Promise<void>;
		rename: (source: string, destination: string) => Promise<void> } =
		{ write: writeFile, rename }): Promise<void> {
	const sidecars = Object.entries(carry.sidecars ?? {}).sort(([left], [right]) => left.localeCompare(right));
	const files: Array<{ name: string; text: string }> = [];
	for (const [index, [name, text]] of sidecars.entries()) {
		if (path.basename(name) !== name || !/^ledger-continuation\.part-[0-9]{8}\.enc$/.test(name) ||
			name !== carrySidecarName(index) || !canonicalCarrySidecarBase64(text))
			throw new CarrySidecarPersistenceError();
		files.push({ name, text });
	}
	for (const file of files) {
		try { await io.write(path.join(outputDir, file.name), file.text, { mode: 0o600, flag: "wx" }); }
		catch { throw new CarrySidecarPersistenceError(); }
	}
	const carryFile = path.join(outputDir, CARRY_FILE_NAME);
	const temporaryCarry = `${carryFile}.${process.pid}.tmp`;
	await io.write(temporaryCarry, `${JSON.stringify({ envelopeB64: carry.envelopeB64 })}\n`,
		{ mode: 0o600, flag: "wx" });
	await io.rename(temporaryCarry, carryFile);
}

function privateToolPath(raw: unknown, runtimeKey: string | undefined): string | undefined {
	if (typeof raw !== "string" || !raw || raw.length > 240 || raw.includes("\0") ||
		path.isAbsolute(raw) || raw.split(/[\\/]/).some(part => !part || part === "..")) return undefined;
	return privateFailureMessage(raw, runtimeKey)?.slice(0, 240);
}
function privateToolTelemetry(item: Record<string, unknown>, index: number,
	runtimeKey: string | undefined): Record<string, unknown> {
	const name = ["read", "write", "edit", "material_read", "material_list"].includes(String(item.name)) ?
		String(item.name) : "other";
	const result = item.resultMetadata && typeof item.resultMetadata === "object" &&
		!Array.isArray(item.resultMetadata) ? item.resultMetadata as Record<string, unknown> : undefined;
	const returnedEvidence = name === "read" && item.ok === true && result?.kind === "confined-utf8-read" &&
		Number.isSafeInteger(result.utf8Bytes) && Number(result.utf8Bytes) >= 0 &&
		Number(result.utf8Bytes) <= 1_000_000 && result.truncated === false ? {
		kind: "full-utf8-text", relativePath: privateToolPath(result.relativePath, runtimeKey) ?? null,
		utf8Bytes: result.utf8Bytes, truncated: false } : undefined;
	const args = item.args && typeof item.args === "object" && !Array.isArray(item.args) ?
		item.args as Record<string, unknown> : undefined;
	const errorClass = ["harness", "filesystem", "tool-error"].includes(String(item.errorClass)) ?
		item.errorClass : "unknown";
	const errorCode = typeof item.errorCode === "string" && /^[A-Za-z][A-Za-z0-9._-]{0,63}$/.test(item.errorCode) ?
		item.errorCode : null;
	const errorMessage = privateFailureMessage(item.errorMessage, runtimeKey)?.slice(0, 500) ?? null;
	return { index, name, ok: item.ok === true,
		...(name === "read" && item.ok === false ? {
			requestedPath: privateToolPath(args?.path, runtimeKey) ?? null,
			errorClass, errorCode, errorMessage } : {}),
		...(returnedEvidence ? { returnedEvidence } : {}) };
}
async function taskTelemetry(ws: Workspace, task: any, runtimeKey: string | undefined): Promise<Record<string, unknown>> {
	const failure = privateFailureMessage(task.executionFailure, runtimeKey);
	const sessionFile = typeof task.session?.file === "string" ? path.resolve(task.session.file) : undefined;
	let usage: Array<Record<string, unknown>> = [];
	if (sessionFile?.startsWith(path.resolve(ws.sessionsDir) + path.sep) && sessionFile.endsWith(".jsonl")) {
		const usageFile = sessionFile.replace(/\.jsonl$/, ".usage.jsonl");
		try {
			const rows = (await readFile(usageFile, "utf8")).split(/\r?\n/).filter(Boolean);
			usage = rows.slice(-12).map(line => {
				const row = JSON.parse(line) as Record<string, any>;
				const summary = row.summary ?? {};
				const eventRows = Array.isArray(row.events) ? row.events : [];
				return { outcome: ["completed", "failed", "aborted"].includes(row.outcome) ? row.outcome : "unknown",
					promptIndex: Number.isSafeInteger(row.promptIndex) ? row.promptIndex : null,
					usage: Object.fromEntries(["input", "output", "cacheRead", "cacheWrite", "totalTokens", "cost",
						"reportedEvents", "unknownEvents"].filter(key => typeof summary[key] === "number" && Number.isFinite(summary[key]))
						.map(key => [key, summary[key]])),
					complete: summary.complete === true, costComplete: summary.costComplete === true,
					events: eventRows.map((event: Record<string, unknown>) => ({
						kind: ["assistant", "tool-result", "compaction", "branch-summary"].includes(String(event.kind)) ? event.kind : "unknown",
						status: ["reported", "unknown"].includes(String(event.status)) ? event.status : "unknown",
						stopReason: ["stop", "toolUse", "error", "aborted", "length"].includes(String(event.stopReason)) ? event.stopReason : "other",
					})),
				};
			});
		} catch { usage = [{ status: "unavailable" }]; }
	}
	return { taskId: typeof task.taskId === "string" ? task.taskId : null,
		status: ["running", "returned", "failed", "accepted", "rejected", "unknown"].includes(task.status) ? task.status : "unknown",
		loopStopReason: typeof task.loopStopReason === "string" ? task.loopStopReason : null,
		failureCategory: task.loopStopReason === "output-limit" ? "output-limit" :
			taskFailureCategory(task.executionFailure),
		failure: failure ?? null, failureDiagnosticStatus: failure ? "redacted-private" : "unavailable",
		sessionCreated: Boolean(sessionFile), roundCount: Array.isArray(task.executionRounds) ? task.executionRounds.length : 0,
		tools: Array.isArray(task.toolLog) ? task.toolLog.map((item: Record<string, unknown>, index: number) =>
			privateToolTelemetry(item, index, runtimeKey)) : [],
		usage };
}

async function saveStatus(value: Record<string, unknown>): Promise<void> {
	if (!statusOutputDir) return;
	await mkdir(statusOutputDir, { recursive: true, mode: 0o700 });
	const target = path.join(statusOutputDir, "campaign-status.json");
	const temporary = `${target}.${process.pid}.tmp`;
	await writeFile(temporary, JSON.stringify({ version: 1, runId: statusRunId ?? null,
		phase: statusPhase, budget: statusBudget?.snapshot() ?? { status: "unavailable" },
		...(statusPriorSelectedValidation ? { priorSelectedValidation: statusPriorSelectedValidation } : {}),
		...(statusAssessorDiagnosticFailure ? { assessorDiagnosticFailure: statusAssessorDiagnosticFailure } : {}),
		...value,
		...(statusTransportDiagnostics.length ? { transportDiagnostics: statusTransportDiagnostics } : {}) }, null, 2),
		{ mode: 0o600 });
	await rename(temporary, target);
}
/** Latest host-observed repair transition. The carry authenticates this private
 * control receipt; it grants neither evidence-read credit nor scientific acceptance. */
async function saveRepairState(outputDir: string, state: WorkflowRepairStateV1): Promise<void> {
	if (!validWorkflowRepairState(state))
		throw new HarnessError("runner.workflow-repair", "host repair receipt is invalid");
	const target = path.join(outputDir, "repair-state.json");
	const temporary = `${target}.${process.pid}.tmp`;
	const text = `${JSON.stringify(state)}\n`;
	if (Buffer.byteLength(text, "utf8") > 4096)
		throw new HarnessError("runner.workflow-repair", "host repair receipt exceeds its physical byte boundary");
	await writeFile(temporary, text, { mode: 0o600 });
	await rename(temporary, target);
}
async function saveAssessorValidationDiagnostic(outputDir: string,
	diagnostic: ObjectiveAssessmentValidationDiagnosticV1 | M04InvalidJudgmentEvent): Promise<void> {
	try {
		await appendPrivateAssessorDiagnostic(outputDir, {
			...diagnostic,
			coverage: diagnostic.coverage.map(item => ({ ...item,
				coveredRanges: item.coveredRanges.map(range => Array.isArray(range) ?
					[range[0], range[1]] as [number, number] :
					[range.start, range.end] as [number, number]) }))
		});
	} catch (error) {
		const cause = assessorDiagnosticFailureCause(error);
		statusAssessorDiagnosticFailure = {
			...cause,
			generation: diagnostic.generation, attempt: diagnostic.attempt,
			validatorCode: diagnostic.validation.code,
			validatorMessage: diagnostic.validation.message,
			...(diagnostic.validation.path ? { validatorPath: diagnostic.validation.path } : {}),
			...(typeof diagnostic.validation.detail === "string" ?
				{ validatorDetail: diagnostic.validation.detail } : {}) };
		throw error instanceof PrivateAssessorDiagnosticError ? error :
			new PrivateAssessorDiagnosticError("write-failed", error);
	}
}
function assessorDiagnosticFailureCause(error: unknown): { code: string;
	osErrorCode?: PrivateAssessorOsErrorCode } {
	const osErrorCode = error instanceof PrivateAssessorDiagnosticError ? error.osErrorCode :
		privateAssessorOsErrorCode(error);
	return { code: error instanceof PrivateAssessorDiagnosticError ? error.code : "unclassified-write-failure",
		...(osErrorCode ? { osErrorCode } : {}) };
}
function assessorDiagnosticFailureSnapshot(): typeof statusAssessorDiagnosticFailure {
	return statusAssessorDiagnosticFailure ? structuredClone(statusAssessorDiagnosticFailure) : undefined;
}
async function campaignArchiveNames(directory: string): Promise<string[]> {
	return ["workflow-archive.json", ...(await readdir(directory)).filter(name =>
		/^workflow-(?:(?:initial|followon|branch-parent|branch-child|provenance-import)|iteration-[1-9][0-9]*|fallback-[0-9a-f]{12}-T[0-9]{3,})-archive\.json$/.test(name))];
}

async function preserveCandidate(ws: Workspace, runId: string | undefined, outputDir: string): Promise<void> {
	if (!runId) return;
	const goalFile = path.join(ws.runDir("M07", runId), "goal.json");
	if (!existsSync(goalFile)) return;
	const goal = JSON.parse(await readFile(goalFile, "utf8")) as CurrentGoal;
	const tasks = goal.tasks.filter(item => item.mode === "execute");
	if (!tasks.length) return;
	const archivedIdentity = async (name: string): Promise<string | undefined> => {
		const file = path.join(outputDir, name);
		if (!existsSync(file)) return undefined;
		const archive = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
		return archive.goalRunId === runId && typeof archive.taskId === "string" ? archive.taskId : undefined;
	};
	const archivedTaskIds = new Set<string>();
	for (const name of await campaignArchiveNames(outputDir)) {
		const id = await archivedIdentity(name);
		if (id) archivedTaskIds.add(id);
	}
	for (const [index, task] of tasks.entries()) {
		if (archivedTaskIds.has(task.taskId)) continue;
		if (index === 0 && !existsSync(path.join(outputDir, "workflow-archive.json"))) {
			await archivePrivateM07Task({ goal, task, destination: outputDir });
			archivedTaskIds.add(task.taskId);
			continue;
		}
		const prefix = index === 1 && !existsSync(path.join(outputDir, "workflow-branch-child-archive.json")) ?
			"branch-child" : `fallback-${sha256(runId).slice(0, 12)}-${task.taskId}`;
		const name = `workflow-${prefix}-archive.json`;
		if (existsSync(path.join(outputDir, name))) {
			if (await archivedIdentity(name) !== task.taskId) fail("fallback archive prefix is occupied by another task");
			continue;
		}
		const temporary = await mkdtemp(path.join(os.tmpdir(), "mulpis-private-fallback-"));
		try {
			await archivePrivateM07Task({ goal, task, destination: temporary });
			await exportPrefixedArchive(temporary, outputDir, prefix);
			archivedTaskIds.add(task.taskId);
		} finally { await rm(temporary, { recursive: true, force: true }); }
	}
}

/** Leave an auditable active result when a task or external operation cannot be settled. */
async function preserveUnsettledGoalCheckpoint(input: {
	ws: Workspace; runId: string; outputDir: string; contract: OriginalObjectiveContractV1;
	budgetStopReason?: string;
}): Promise<{ checkpoint: ObjectiveProgressV1; acceptedTaskIds: string[];
	unresolvedOperationIds: string[]; unresolvedTaskIds: string[]; archiveFailure?: string }> {
	const goalFile = path.join(input.ws.runDir("M07", input.runId), "goal.json");
	const goal = JSON.parse(await readFile(goalFile, "utf8")) as CurrentGoal;
	const { operationIds: unresolvedOperationIds, taskIds: unresolvedTaskIds } = unresolvedGoalControl(goal);
	if (goal.runId !== input.runId || (!unresolvedOperationIds.length && !unresolvedTaskIds.length))
		fail("unsettled checkpoint requires the matching goal and actual unresolved control state");
	const acceptedTaskIds = goal.tasks.filter(item => item.status === "accepted").map(item => item.taskId);
	let archiveFailure: string | undefined;
	try { await preserveCandidate(input.ws, input.runId, input.outputDir); }
	catch { archiveFailure = "unsettled-goal-archive-incomplete"; }
	const availableArtifacts = await availablePrivateArtifactNames(input.outputDir);
	let prior: ObjectiveProgressV1 | undefined;
	try { prior = JSON.parse(await readFile(path.join(input.outputDir, "objective-checkpoint.json"), "utf8")); } catch { /* First attempt has no checkpoint. */ }
	if (prior?.contract.id !== input.contract.id) prior = undefined;
	const checkpoint = campaignObjectiveProgress(input.contract,
		prior ? canonicalUnresolvedOperationRefs(prior) : [], {
		...(prior?.assessment ? { assessment: prior.assessment } : {}), assessmentHistory: prior?.assessmentHistory,
		boundedRuns: [...(prior?.boundedRuns.filter(run => run.runId !== input.runId) ?? []), { runId: input.runId, outcome: goal.lifecycle === "finished" ? goal.outcome ?? "unknown" : "active",
			acceptedTaskIds, unresolvedOperationIds }],
		selectedArtifacts: prior?.selectedArtifacts ?? [], availableArtifacts: [...new Set([...(prior?.availableArtifacts ?? []), ...availableArtifacts])],
		unresolvedOperationIds: unresolvedOperationIds.map(id => qualifiedOperationRef(input.runId, id)),
		stopReason: campaignObjectiveStop(input.budgetStopReason) ?? "bounded-run-incomplete",
	});
	await writeObjectiveProgress(path.join(input.outputDir, "objective-checkpoint.json"), checkpoint);
	return { checkpoint, acceptedTaskIds, unresolvedOperationIds, unresolvedTaskIds,
		...(archiveFailure ? { archiveFailure } : {}) };
}

async function salvageObjectiveCheckpoint(ws: Workspace, outputDir: string,
	budgetStopReason: string | undefined, cancelled: boolean): Promise<void> {
	const contractFile = path.join(outputDir, "original-objective.json");
	if (!existsSync(contractFile)) return;
	const contract = JSON.parse(await readFile(contractFile, "utf8")) as OriginalObjectiveContractV1;
	if (contract.version !== 1 || contract.kind !== "original-objective" || !contract.id)
		fail("frozen original objective is unavailable during checkpoint salvage");
	const checkpointFile = path.join(outputDir, "objective-checkpoint.json");
	let previous: ObjectiveProgressV1 | undefined;
	try { previous = JSON.parse(await readFile(checkpointFile, "utf8")) as ObjectiveProgressV1; } catch { /* repair missing checkpoint */ }
	const boundedRuns: ObjectiveProgressV1["boundedRuns"] = [];
	const unresolvedOperationIds: string[] = [];
	for (const id of await ws.listRuns("M07")) {
		try {
			const goal = JSON.parse(await readFile(path.join(ws.runDir("M07", id), "goal.json"), "utf8")) as CurrentGoal;
			const pending = (goal.executionState?.operations ?? [])
				.filter(item => ["prepared", "issued", "unknown"].includes(item.status)).map(item => item.id);
			unresolvedOperationIds.push(...pending.map(item => qualifiedOperationRef(id, item)));
			const acceptedTaskIds = goal.tasks.filter(item => item.status === "accepted").map(item => item.taskId);
			const selected = goal.branchSelections?.findLast(item => item.selectedTaskId)?.selectedTaskId;
			boundedRuns.push({ runId: id, outcome: goal.lifecycle === "finished" ? goal.outcome ?? "unknown" : "active",
				acceptedTaskIds, unresolvedOperationIds: pending,
				...(selected && acceptedTaskIds.includes(selected) ? { selectedTaskId: selected } : {}) });
		} catch { boundedRuns.push({ runId: id, outcome: "record-unavailable" }); }
	}
	const historicalRuns = previous?.contract.id === contract.id ? previous.boundedRuns.filter(saved =>
		!boundedRuns.some(live => live.runId === saved.runId)) : [];
	const allBoundedRuns = [...historicalRuns, ...boundedRuns];
	const availableArtifacts = await availablePrivateArtifactNames(outputDir);
	const priorCoversLive = previous?.contract.id === contract.id &&
		isCurrentObjectiveStopReason(previous.stopReason) &&
		previous.stopReason !== "assessment-validation-pending" && unresolvedOperationIds.length === 0 &&
		(!cancelled || previous.stopReason === "cancelled") &&
		(budgetStopReason !== "output-limit" || previous.stopReason === "output-limit") &&
		(budgetStopReason !== "price-assumption-invalid" || previous.stopReason === "accounting-integrity-error") &&
		boundedRuns.every(item => item.outcome !== "active" && item.outcome !== "record-unavailable") &&
		boundedRuns.every(item =>
			previous!.boundedRuns.some(saved => saved.runId === item.runId && saved.outcome === item.outcome));
	if (priorCoversLive && previous) {
		const added = availableArtifacts.filter(name => !previous.availableArtifacts.includes(name));
		if (added.length) await writeObjectiveProgress(checkpointFile,
			{ ...previous, availableArtifacts: [...previous.availableArtifacts, ...added] });
		return;
	}
	const progress = campaignObjectiveProgress(contract,
		previous?.contract.id === contract.id ? canonicalUnresolvedOperationRefs(previous) : [], { boundedRuns: allBoundedRuns,
		selectedArtifacts: previous?.contract.id === contract.id ?
			previous.selectedArtifacts : [],
		availableArtifacts, unresolvedOperationIds,
		...(previous?.contract.id === contract.id && previous.assessment ? { assessment: previous.assessment } : {}),
		...(previous?.contract.id === contract.id ? { assessmentHistory: previous.assessmentHistory } : {}),
		stopReason: campaignObjectiveStop(budgetStopReason) ?? (cancelled ? "cancelled" : "bounded-run-incomplete") });
	await writeObjectiveProgress(checkpointFile, progress);
}
async function forkReceiptMatches(file: string | undefined, checkpoint: SessionCheckpoint, childSessionId: string | undefined): Promise<boolean> {
	if (!file || !childSessionId) return false;
	try {
		const info = await lstat(file);
		if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > 128_000) return false;
		const receipt = JSON.parse(await readFile(file, "utf8")) as Record<string, any>;
		return receipt.version === 1 && receipt.state === "committed" && receipt.intent === "branch-exploration" &&
			receipt.checkpoint?.id === checkpoint.id && receipt.checkpoint?.leafId === checkpoint.leafId &&
			receipt.parent?.sessionId === checkpoint.sourceSessionId && receipt.parent?.leafId === checkpoint.leafId &&
			receipt.child?.sessionId === childSessionId && receipt.child?.sessionId !== checkpoint.sourceSessionId &&
			receipt.inheritedUsageBilled === false;
	} catch { return false; }
}
async function contextLineageSummary(file: string | undefined, checkpoint: SessionCheckpoint,
	childSessionId: string | undefined, childModel: string | undefined,
	expectedProblemSnapshotCopy: string, expectedModel = MODEL): Promise<Record<string, unknown>> {
	const identityMatches = await forkReceiptMatches(file, checkpoint, childSessionId);
	let evidenceBindingCount = 0, workspaceBindingFileCount = 0;
	let frozenManifestBinding = false, frozenProblemBinding = false, workspaceBindingPresent = false;
	if (identityMatches && file) {
		try {
			const receipt = JSON.parse(await readFile(file, "utf8")) as Record<string, any>;
			const bindings = receipt.evidenceBindings;
			const workspace = receipt.workspaceBinding;
			evidenceBindingCount = Array.isArray(bindings) ? bindings.length : 0;
			workspaceBindingFileCount = Array.isArray(workspace?.files) ? workspace.files.length : 0;
			frozenManifestBinding = evidenceBindingCount === 2 && bindings[0]?.status === "frozen-copy" &&
				bindings[0]?.path === checkpoint.manifestSnapshot && bindings[0]?.sourceVersion === checkpoint.id;
			frozenProblemBinding = evidenceBindingCount === 2 && path.isAbsolute(expectedProblemSnapshotCopy) &&
				Boolean(checkpoint.taskId) && bindings[1]?.status === "frozen-copy" &&
				bindings[1]?.path === expectedProblemSnapshotCopy &&
				bindings[1]?.sourceVersion === `${checkpoint.runId}/${checkpoint.taskId}`;
			workspaceBindingPresent = workspace?.version === 1 && workspaceBindingFileCount > 0;
		} catch { /* Only finite, allowlisted scalar fields leave the workspace. */ }
	}
	const exactModel = checkpoint.model === expectedModel && childModel === expectedModel;
	const verified = identityMatches && frozenManifestBinding && frozenProblemBinding && workspaceBindingPresent && exactModel;
	return { version: 1, kind: "private-context-lineage-summary", state: verified ? "verified" : "unverified",
		checkpointId: checkpoint.id, parentSessionId: checkpoint.sourceSessionId, frozenLeafId: checkpoint.leafId,
		childSessionId: childSessionId ?? null, intent: "branch-exploration", model: expectedModel,
		evidenceBindingCount, workspaceBindingFileCount,
		driverChecks: { committedExactLineage: identityMatches, exactModel,
			frozenManifestBinding, frozenProblemBinding, workspaceBindingPresent },
		limitation: "Counts and a committed receipt identify the fork; this summary does not reprint or independently reread the inherited transcript." };
}
/** Flat encrypted-transport layout; the renamed manifest is an index, not a default loader input. */
async function exportPrefixedArchive(sourceDir: string, outputDir: string,
	prefix: string): Promise<void> {
	if (!(["initial", "followon", "branch-parent", "branch-child", "provenance-import"].includes(prefix) ||
		/^iteration-[1-9][0-9]*$/.test(prefix) ||
		/^fallback-[0-9a-f]{12}-T[0-9]{3,}$/.test(prefix))) fail("unsupported private archive transport prefix");
	for (const name of await archiveEvidenceFiles(sourceDir)) if (existsSync(path.join(sourceDir, name)))
		await copyFile(path.join(sourceDir, name), path.join(outputDir, `${prefix}-${name}`));
	const archive = JSON.parse(await readFile(path.join(sourceDir, "workflow-archive.json"), "utf8")) as Record<string, any>;
	for (const item of archive.files ?? []) item.name = `${prefix}-${item.name}`;
	for (const item of archive.controllerEvidence?.rounds ?? []) {
		if (item.candidate?.file) item.candidate.file = `${prefix}-${item.candidate.file}`;
		if (item.verification?.file) item.verification.file = `${prefix}-${item.verification.file}`;
		if (item.feedbackFile) item.feedbackFile = `${prefix}-${item.feedbackFile}`;
		if (item.reviewerReport?.file) item.reviewerReport.file = `${prefix}-${item.reviewerReport.file}`;
	}
	if (archive.controllerEvidence?.reviewDecision?.file) archive.controllerEvidence.reviewDecision.file = `${prefix}-${archive.controllerEvidence.reviewDecision.file}`;
	if (archive.m04?.knowledgeExport?.state === "complete") {
		if (archive.m04.knowledgeExport.file !== "m04-adopted-knowledge.json" ||
			!existsSync(path.join(sourceDir, "m04-adopted-knowledge.json")))
			fail("complete M04 knowledge export is unavailable for prefixed archive");
		await copyFile(path.join(sourceDir, "m04-adopted-knowledge.json"),
			path.join(outputDir, `${prefix}-m04-adopted-knowledge.json`));
		archive.m04.knowledgeExport.file = `${prefix}-m04-adopted-knowledge.json`;
	}
	if (archive.m04?.transaction?.file === "m04-transaction.json") {
		const transactionFile = path.join(sourceDir, "m04-transaction.json");
		if (!existsSync(transactionFile)) fail("declared M04 transaction is unavailable for prefixed archive");
		await copyFile(transactionFile, path.join(outputDir, `${prefix}-m04-transaction.json`));
		archive.m04.transaction.file = `${prefix}-m04-transaction.json`;
	}
	archive.transportLayout = { kind: "prefixed-flat-index", prefix, defaultArchiveLoaderCompatible: false };
	await writeFile(path.join(outputDir, `workflow-${prefix}-archive.json`), JSON.stringify(archive, null, 2), { mode: 0o600 });
}

function fail(message: string): never { throw new Error(message); }
class SandboxPreflightError extends Error {
	readonly privateDiagnostic: string;
	constructor(diagnostic: string) { super("isolated preflight failed"); this.privateDiagnostic = diagnostic; }
}
function arg(name: string): string {
	const index = process.argv.indexOf(name);
	if (index < 0 || index + 1 >= process.argv.length) fail(`missing ${name}`);
	return path.resolve(process.argv[index + 1]);
}
function cleanEnv(): NodeJS.ProcessEnv {
	return { PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "C.UTF-8", HOME: "/nonexistent", TMPDIR: "/tmp" };
}
function sandboxArguments(command: string, args: string[], mountedWork?: string, readOnlyWork = false): string[] {
	return ["-n", "bwrap", "--unshare-user", "--unshare-net", "--unshare-pid", "--unshare-ipc",
		"--uid", "65534", "--gid", "65534", "--die-with-parent", "--clearenv",
		"--setenv", "PATH", "/usr/bin:/bin", "--setenv", "LANG", "C.UTF-8",
		"--ro-bind", "/usr", "/usr", "--symlink", "usr/bin", "/bin", "--symlink", "usr/lib", "/lib",
		"--symlink", "usr/lib64", "/lib64", "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp",
		...(mountedWork ? [readOnlyWork ? "--ro-bind" : "--bind", mountedWork, "/work", "--chdir", "/work"] : []),
		"--", command, ...args];
}
function isolated(command: string, args: string[], mountedWork?: string, readOnlyWork = false) {
	return spawnSync("sudo", sandboxArguments(command, args, mountedWork, readOnlyWork),
		{ encoding: "utf8", maxBuffer: 100_000, env: cleanEnv() });
}
async function requireIsolation(): Promise<void> {
	const id = isolated("/usr/bin/id", ["-u"]);
	if (id.status !== 0 || id.stdout.trim() !== "65534")
		throw new SandboxPreflightError(`uid probe: ${(id.stderr ?? "").slice(-2000)}`);
	const environment = isolated("/usr/bin/env", []);
	if (environment.status !== 0 || /(?:KEY|TOKEN|SECRET|PASSWORD|AUTH)=/i.test(environment.stdout))
		throw new SandboxPreflightError(`environment probe: ${(environment.stderr ?? "").slice(-2000)}`);
	const scratch = await mkdtemp(path.join(os.tmpdir(), "mulpis-sandbox-preflight-"));
	try {
		await chmod(scratch, 0o777);
		await stageProbe(scratch);
		const compileProbe = isolated("/usr/bin/g++", [...FLAGS, "/work/probe.cpp", "-o", "/work/probe-bin"], scratch);
		if (compileProbe.status !== 0)
			throw new SandboxPreflightError(`compiler probe: ${(compileProbe.stderr ?? "").slice(-2000)}`);
		const runProbe = isolated("/work/probe-bin", [], scratch, true);
		if (runProbe.status !== 0)
			throw new SandboxPreflightError(`executable probe: ${(runProbe.stderr ?? "").slice(-2000)}`);
	} finally { await rm(scratch, { recursive: true, force: true }); }
}
async function stageProbe(scratch: string): Promise<void> {
	const source = path.join(scratch, "probe.cpp");
	await writeFile(source, "#include <omp.h>\nint main() { return omp_get_max_threads() > 0 ? 0 : 1; }\n",
		{ mode: 0o644 });
	// Actions uses umask 077; mode on creation alone would leave an unreadable 0600 file for sandbox UID 65534.
	await chmod(source, 0o644);
}
async function verifierScratch(kind: "original" | "candidate"): Promise<string> {
	const directory = await mkdtemp(path.join(os.tmpdir(), `mulpis-${kind}-check-`));
	await chmod(directory, 0o777);
	return directory;
}
function extractBody(source: string, name: string): string | null {
	const declaration = new RegExp(`\\b${name}\\s*\\(`, "g");
	let match: RegExpExecArray | null;
	while ((match = declaration.exec(source))) {
		const open = source.indexOf("{", match.index + match[0].length);
		if (open < 0 || source.slice(match.index, open).includes(";")) continue;
		let depth = 0;
		for (let index = open; index < source.length; index++) {
			if (source[index] === "{") depth++;
			else if (source[index] === "}" && --depth === 0) return source.slice(open + 1, index);
		}
	}
	return null;
}
function targetBodySpan(source: string, name: string): { start: number; end: number } | undefined {
	const declaration = new RegExp(name === "main" ? "\\bint\\s+main\\s*\\(" :
		`\\bstatic\\s+void\\s+${name}\\s*\\(`).exec(source);
	if (!declaration) return undefined;
	const open = source.indexOf("{", declaration.index + declaration[0].length);
	if (open < 0 || source.slice(declaration.index, open).includes(";")) return undefined;
	let depth = 0;
	for (let index = open; index < source.length; index++) {
		if (source[index] === "{") depth++;
		else if (source[index] === "}" && --depth === 0) return { start: open, end: index + 1 };
	}
	return undefined;
}
function outsideTargets(source: string, targets: string[]): string | undefined {
	const spans = targets.map(name => targetBodySpan(source, name));
	if (spans.some(span => !span)) return undefined;
	let text = source;
	for (const span of (spans as Array<{ start: number; end: number }>).sort((a, b) => b.start - a.start))
		text = text.slice(0, span.start) + "{}" + text.slice(span.end);
	return text.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "").replace(/\s+/g, "");
}
function safeTargetDirectives(body: string): boolean {
	const conditionals: Array<{ elseSeen: boolean }> = [];
	for (const match of body.matchAll(/^\s*#\s*([^\n]*)/gm)) {
		const directive = match[1].trim();
		if (/^pragma\s+omp\b/.test(directive)) continue;
		if (/^(?:ifdef\s+_OPENMP|if\s+defined\s*(?:\(\s*_OPENMP\s*\)|_OPENMP))\s*$/.test(directive)) {
			conditionals.push({ elseSeen: false }); continue;
		}
		if (directive === "else" && conditionals.length && !conditionals.at(-1)!.elseSeen) {
			conditionals.at(-1)!.elseSeen = true; continue;
		}
		if (directive === "endif" && conditionals.length) { conditionals.pop(); continue; }
		return false;
	}
	return conditionals.length === 0;
}
function sourceShape(original: string, candidate: string): { ok: boolean; reason: string; targetCount: number } {
	const targets = [...original.matchAll(/\/\/\s*TODO[^\n]*\n\s*static\s+void\s+([A-Za-z_]\w*)\s*\(/g)].map(x => x[1]);
	if (targets.length < 2) return { ok: false, reason: "could not derive two original implementation targets", targetCount: targets.length };
	if (!outsideTargets(original, targets) || outsideTargets(original, targets) !== outsideTargets(candidate, targets))
		return { ok: false, reason: "candidate changed code or preprocessor directives outside the required target bodies", targetCount: targets.length };
	for (const name of ["main", ...[...original.matchAll(/static\s+(?:bool|void)\s+([A-Za-z_]\w*)\s*\(/g)].map(x => x[1]).filter(x => !targets.includes(x))]) {
		const before = extractBody(original, name), after = extractBody(candidate, name);
		if (!before || !after || before.replace(/\s+/g, "") !== after.replace(/\s+/g, ""))
			return { ok: false, reason: `original non-target function changed: ${name}`, targetCount: targets.length };
	}
	const bodies = targets.map(x => extractBody(candidate, x));
	if (bodies.some(body => body && !safeTargetDirectives(body)))
		return { ok: false, reason: "required target body contains an unsafe or unbalanced preprocessor directive", targetCount: targets.length };
	if (bodies.some(x => !x || !/#\s*pragma\s+omp\b/.test(x)))
		return { ok: false, reason: "a required target lacks an OpenMP directive", targetCount: targets.length };
	if (bodies[0]!.replace(/\s+/g, "") === bodies[1]!.replace(/\s+/g, ""))
		return { ok: false, reason: "required target bodies are identical", targetCount: targets.length };
	return { ok: true, reason: "structural preservation checks passed; substantive difference also needs reviewer judgment", targetCount: targets.length };
}
/** The registered verifier owns its source preservation and extension boundary. */
function registeredSourceShape(original: string, candidate: string, taskText: string, plan: CsrExperimentPlan):
	{ ok: boolean; reason: string; targetCount: number; diagnostic?: unknown } {
	try {
		const { ok, reason, targetCount } = validateCsrCandidateSource(original, candidate, taskText, plan.registeredStrategies);
		return { ok, reason, targetCount };
	} catch (error) { return { ok: false, reason: error instanceof Error ? error.message.slice(0, 2_000) : "source is outside the independently validated registered capability", targetCount: 0,
		...(error && typeof error === "object" && "diagnostic" in error ? { diagnostic: error.diagnostic } : {}) }; }
}

function deriveRuntimeCases(original: string): string[][] | undefined {
	const candidates = [...original.matchAll(/\bstruct\s+[A-Za-z_]\w*\s*\{([\s\S]*?)\};/g)]
		.map(match => [...match[1].matchAll(/\bint\s+([A-Za-z_]\w*)\s*=\s*(\d+)\s*;/g)]
			.map(item => ({ field: item[1], value: Number(item[2]) })))
		.filter(fields => fields.length >= 7 && fields.length <= 12);
	if (candidates.length !== 1) return undefined;
	const fields = candidates[0];
	const parsedFlags = new Map<string, string>();
	for (const match of original.matchAll(/\barg\s*==\s*"(--[A-Za-z0-9-]+)"\s*\)\s*\{\s*[A-Za-z_]\w*\.([A-Za-z_]\w*)\s*=\s*read_int_arg\s*\(/g))
		parsedFlags.set(match[2], match[1]);
	if (fields.slice(0, 7).some(item => !parsedFlags.has(item.field) || !Number.isSafeInteger(item.value))) return undefined;
	const [first, second, third, fourth, fifth, thread, repeat] = fields;
	if (first.value < 1 || first.value > 20_000 || second.value < 1 || second.value > 200_000 ||
		third.value < 0 || third.value > 200 || fourth.value < 0 || fourth.value > first.value ||
		fifth.value < 0 || fifth.value > second.value || thread.value < 1 || repeat.value < 1) return undefined;
	const shape = (values: number[]) => values.flatMap((value, index) => [parsedFlags.get(fields[index].field)!, String(value)]);
	const uniform = shape([Math.min(first.value * 2, 20_000), second.value, third.value, 0, 0]);
	const broadSecond = Math.min(second.value * 2, 200_000);
	const heavier = shape([Math.min(first.value * 2, 20_000), broadSecond,
		Math.max(1, Math.floor(third.value / 2)), Math.max(1, Math.floor(fourth.value / 2)),
		Math.min(broadSecond, Math.max(1, fifth.value * 4))]);
	const cases: string[][] = [];
	for (const base of [[], uniform, heavier]) for (const threads of [1, 2, 4])
		cases.push([...base, parsedFlags.get(thread.field)!, String(threads), parsedFlags.get(repeat.field)!, "10"]);
	return cases;
}
async function m04EvidenceReturned(record: StageRunRecord, taskId: string,
	extraNames: string[] = []): Promise<{ complete: boolean; paths: string[] }> {
	const coverage = record.outputs.find(item => item.label === "M07 回流证据实际访问范围");
	const source = record.outputs.find(item => item.label === "M07 处理来源");
	if (!coverage || !source || !/^T\d{3,}$/.test(taskId)) return { complete: false, paths: [] };
	try {
		const parsed = JSON.parse(await readFile(coverage.path, "utf8")) as { returnedRanges?: Array<{
			path?: unknown; status?: unknown; returned?: { kind?: unknown; startLine?: unknown; endLine?: unknown; truncated?: unknown } }> };
		const sourceInfo = JSON.parse(await readFile(source.path, "utf8")) as { rootDir?: unknown };
		if (typeof sourceInfo.rootDir !== "string" || !Array.isArray(parsed.returnedRanges)) return { complete: false, paths: [] };
		const root = await realpath(sourceInfo.rootDir);
		const paths: string[] = [];
		for (const name of ["candidate.cpp", "verification.json", "lesson-delta.json", ...extraNames]) {
			const exactEvidencePath = (value: unknown): value is string => {
				if (typeof value !== "string") return false;
				const parts = value.replaceAll("\\", "/").split("/");
				return parts.length === 4 && parts[0] === "tasks" && parts[1] === taskId &&
					parts[2] === "review-snapshot" && /^\d{3}-/.test(parts[3]) && parts[3].slice(4) === name;
			};
			const relevant = parsed.returnedRanges.filter(item => exactEvidencePath(item.path) &&
				item.status === "returned" && item.returned?.kind === "text" &&
				Number.isSafeInteger(item.returned.startLine) && Number.isSafeInteger(item.returned.endLine));
			if (!relevant.length) return { complete: false, paths };
			const file = await realpath(path.join(root, relevant[0].path as string));
			if (!file.startsWith(root + path.sep) || !(await lstat(file)).isFile()) return { complete: false, paths };
			const content = await readFile(file, "utf8");
			const totalLines = content.split(/\r?\n/).length - (content.endsWith("\n") ? 1 : 0);
			const covered = Array.from({ length: totalLines }, () => false);
			let completeTerminalPage = false;
			for (const item of relevant) {
				if (item.path !== relevant[0].path) continue;
				const start = item.returned!.startLine as number, end = item.returned!.endLine as number;
				if (start < 1 || end < start || end > totalLines) continue;
				for (let line = start; line <= end; line++) covered[line - 1] = true;
				if (end === totalLines && item.returned?.truncated === false) completeTerminalPage = true;
			}
			if (!covered.length || !completeTerminalPage || covered.some(flag => !flag)) return { complete: false, paths };
			paths.push(relevant[0].path as string);
		}
		return { complete: true, paths };
	} catch { return { complete: false, paths: [] }; }
}
function selectedM07ReviewReadPaths(goalRoot: string, task: M07TaskRecord, extraNames: string[] = []): string[] {
	if (task.status !== "accepted" || !task.review || !/^T\d{3,}$/.test(task.taskId))
		fail("selected M07 task lacks an accepted frozen review");
	if (extraNames.some(name => name !== "experiment-plan.json") || new Set(extraNames).size !== extraNames.length)
		fail("unsupported additional M07 evidence path");
	return ["candidate.cpp", "verification.json", "lesson-delta.json", ...extraNames].map(name => {
		const source = path.join(task.workDir, name);
		const artifacts = task.review!.artifacts.filter(item => item.sourcePath === source);
		if (artifacts.length !== 1) fail("selected M07 review evidence is missing or ambiguous");
		const relative = path.relative(goalRoot, artifacts[0].path).replaceAll("\\", "/");
		const escaped = name.replace(".", "\\.");
		if (!new RegExp(`^tasks/${task.taskId}/review-snapshot/\\d{3}-${escaped}$`).test(relative))
			fail("selected M07 review evidence is outside the expected frozen task snapshot");
		return relative;
	});
}
async function adoptedExperienceRefs(store: KnowledgeStore, m04RunId: string, evidenceReturned: boolean): Promise<KnowledgeRef[]> {
	if (!evidenceReturned) return [];
	const storeId = await store.storeId();
	const records = await store.list();
	const refs: KnowledgeRef[] = [];
	for (const record of records) {
		const experience = record.fields.experience as Record<string, unknown> | undefined;
		if (record.source.stage !== "M04" || record.source.runId !== m04RunId || record.usageDecision !== "adopted" ||
			!experience || experience.version !== 1 || experience.targetKind !== "executor" ||
			!Array.isArray(experience.applicableStages) || !experience.applicableStages.includes("M07")) continue;
		if ((await store.availability(record.id, record.version)).availability !== "usable_conditionally") continue;
		refs.push({ storeId, recordId: record.id, version: record.version });
	}
	return refs;
}
type TrustedTiming = { target: number; rows: number; cols: number; threads: number; repeats: number; elapsedNs: number };
function compareCandidateTimings(previous: unknown, current: unknown): { state: "measured" | "unavailable"; ratios?: number[]; medianRatio?: number; minRatio?: number; scope?: string } {
	const registered = (value: unknown): Array<Record<string, any>> | undefined => {
		if (!value || typeof value !== "object") return undefined;
		const experiment = (value as Record<string, any>).registeredExperiment;
		return experiment?.status === "passed" && Array.isArray(experiment.timings) ?
			experiment.timings.filter((row: Record<string, any>) => row.kind === "strategy") : undefined;
	};
	const registeredBefore = registered(previous), registeredAfter = registered(current);
	if (registeredBefore || registeredAfter) {
		if (!registeredBefore?.length || !registeredAfter?.length ||
			(previous as Record<string, any>).registeredExperiment.metric !== "isolated-worker-roundtrip" ||
			(current as Record<string, any>).registeredExperiment.metric !== "isolated-worker-roundtrip") return { state: "unavailable" };
		const priorProtocol = (previous as Record<string, any>).registeredExperiment;
		const nextProtocol = (current as Record<string, any>).registeredExperiment;
		if (priorProtocol.freshProcessPerSelection !== true || nextProtocol.freshProcessPerSelection !== true ||
			priorProtocol.threadPolicy?.threadsMeaning !== "requested-default-and-openmp-cap" ||
			priorProtocol.threadPolicy?.actualThreads !== "not_observed" ||
			typeof priorProtocol.threadPolicy?.description !== "string" ||
			JSON.stringify(priorProtocol.threadPolicy) !== JSON.stringify(nextProtocol.threadPolicy) ||
			!Array.isArray(priorProtocol.compileFlags) || !Array.isArray(nextProtocol.compileFlags) ||
			JSON.stringify(priorProtocol.compileFlags) !== JSON.stringify(nextProtocol.compileFlags) ||
			typeof priorProtocol.accounting !== "string" || priorProtocol.accounting !== nextProtocol.accounting ||
			priorProtocol.measurementAuthority !== "parent-clock-and-raw-output-comparison" ||
			nextProtocol.measurementAuthority !== "parent-clock-and-raw-output-comparison" ||
			priorProtocol.baselineIsolation !== "independently-compiled-immutable-original" || nextProtocol.baselineIsolation !== priorProtocol.baselineIsolation ||
			priorProtocol.runtimeFiles !== "read-only-evaluator-with-separate-writable-scratch" || nextProtocol.runtimeFiles !== priorProtocol.runtimeFiles) return { state: "unavailable" };
		const key = (row: Record<string, any>) => JSON.stringify([row.caseId, row.rows, row.cols, row.ordinaryNnz,
			row.heavyRows, row.heavyNnz, row.seed, row.threads, row.warmups, row.repeats]);
		const fastest = (rows: Array<Record<string, any>>) => {
			const grouped = new Map<string, Record<string, any>>();
			for (const row of rows) {
				if (!Number.isSafeInteger(row.medianNs) || row.medianNs < 1 || !Number.isSafeInteger(row.coldNs) || row.coldNs < 1 ||
					row.requestedThreads !== row.threads || row.actualThreads !== "not_observed")
					return undefined;
				if (!grouped.has(key(row)) || grouped.get(key(row))!.medianNs > row.medianNs) grouped.set(key(row), row);
			}
			return grouped;
		};
		const before = fastest(registeredBefore), after = fastest(registeredAfter);
		if (!before || !after || before.size !== after.size) return { state: "unavailable" };
		const ratios: number[] = [];
		for (const [caseKey, row] of before) {
			const next = after.get(caseKey);
			if (!next) return { state: "unavailable" };
			// Both first-call cost and steady-state are visible; a cached steady-state gain alone cannot hide setup regressions.
			ratios.push(Number((row.medianNs / next.medianNs).toFixed(3)), Number((row.coldNs / next.coldNs).toFixed(3)));
		}
		const sorted = [...ratios].sort((a, b) => a - b);
		return { state: "measured", ratios, medianRatio: (sorted[(sorted.length - 1) >> 1] + sorted[sorted.length >> 1]) / 2,
			minRatio: sorted[0], scope: "best-registered-observation-per-exact-case-with-cold-cost" };
	}
	const trusted = (value: unknown): TrustedTiming[] | undefined => {
		if (!value || typeof value !== "object") return undefined;
		const independent = (value as Record<string, unknown>).independent;
		if (!independent || typeof independent !== "object" || (independent as Record<string, unknown>).status !== "passed") return undefined;
		const timings = (independent as Record<string, unknown>).timings;
		return Array.isArray(timings) && timings.length === 8 ? timings : undefined;
	};
	const before = trusted(previous), after = trusted(current);
	if (!before || !after) return { state: "unavailable" };
	const ratios: number[] = [];
	for (const item of before) {
		const next = after.find(other => other.target === item.target && other.rows === item.rows &&
			other.cols === item.cols && other.threads === item.threads && other.repeats === item.repeats);
		const prior = item.elapsedNs;
		if (!next || !Number.isSafeInteger(prior) || prior < 1 || !Number.isSafeInteger(next.elapsedNs) || next.elapsedNs < 1)
			return { state: "unavailable" };
		ratios.push(Number((prior / next.elapsedNs).toFixed(3)));
	}
	if (ratios.length !== 8 || new Set(before.map(item => `${item.target}:${item.rows}:${item.cols}:${item.threads}`)).size !== 8)
		return { state: "unavailable" };
	const sorted = [...ratios].sort((a, b) => a - b);
	return { state: "measured", ratios, medianRatio: (sorted[3] + sorted[4]) / 2, minRatio: sorted[0] };
}
function chooseForkWinner(parentAccepted: boolean, forkAccepted: boolean, sourceChanged: boolean,
	comparison: { state?: string; medianRatio?: number; minRatio?: number }): "parent" | "fork" | undefined {
	if (forkAccepted && (!parentAccepted || (sourceChanged && comparison.state === "measured" &&
		comparison.medianRatio !== undefined && comparison.medianRatio > 1.03 &&
		comparison.minRatio !== undefined && comparison.minRatio >= 0.95))) return "fork";
	return parentAccepted ? "parent" : undefined;
}
function chooseFollowOnCandidate(previousAccepted: boolean, followOnAccepted: boolean, sourceChanged: boolean,
	comparison: { state?: string; medianRatio?: number; minRatio?: number }): boolean {
	return followOnAccepted && (!previousAccepted || (sourceChanged && comparison.state === "measured" &&
		comparison.medianRatio !== undefined && comparison.medianRatio > 1.03 &&
		comparison.minRatio !== undefined && comparison.minRatio >= 0.95));
}
function retainPriorSelectionUntilM04Ready(m04: { status: "not_run" | "completed" | "failed";
	fullSelectedRead: boolean; knowledgeExportState: "complete" | "none" | "incomplete" },
	previousAccepted: boolean, candidateAccepted: boolean, sourceChanged: boolean,
	comparison: { state?: string; medianRatio?: number; minRatio?: number }): boolean {
	return m04.status !== "completed" || !m04.fullSelectedRead ||
		m04.knowledgeExportState === "incomplete" ||
		!chooseFollowOnCandidate(previousAccepted, candidateAccepted, sourceChanged, comparison);
}
function initialHistoricalSelection(selectedCandidateSource: "initial" | "fork" | "repair" | "followon" | "none",
	priorValidation: "passed" | "failed" | "infrastructure-unavailable" | undefined): Record<string, unknown> {
	return selectedCandidateSource === "none" ? {
		priorRetained: true, retentionReason: "no-new-accepted-candidate",
		selectedTupleProvenance: "authenticated-prior-carry",
		priorCurrentHostCorrectnessGuard: priorValidation ?? "unavailable",
		currentAttemptAcceptedTask: false, currentAttemptGainEstablished: false,
		comparison: { state: "unavailable" }, comparisonPerformed: false,
	} : { priorRetained: false, retentionReason: "comparison-pending",
		comparison: { state: "unavailable" }, comparisonPerformed: false };
}
function firstM07Accepted(acceptedWinner: boolean, finishedOutcome: unknown): boolean {
	return acceptedWinner && finishedOutcome === "fulfilled";
}
function objectiveAssessmentRunCompleted(assessment: ObjectiveProgressV1["assessment"] | undefined,
	stopReason: CurrentObjectiveStopReason): boolean {
	return Boolean(assessment?.unreadEvidence.length === 0 &&
		(["objective-reassessment-pending", "model-closure-unverified",
			"model-reported-blocked", "next-task-needs-capability"] as CurrentObjectiveStopReason[])
			.includes(stopReason));
}
function workflowRepairActionFacts(stage: "objective-assessment" | "m04-judgment"):
	HostPendingActionFactsV1 {
	return { failedStage: stage, evidenceRefs: ["repair-state.json"] };
}
function importM04EffectDisposition(input: { status: "not-run" | "completed" | "failed";
	proposalSubmitted: boolean | undefined; snapshotCreated: boolean | undefined;
	transactionState?: PortableM04KnowledgeTransactionV1["state"];
	threw: boolean; repairNeeded?: boolean }): "continue" | "m04-draft-rejected" | "workflow-repair-needed" |
	"pending-merge-reconciliation" | "m04-integrity-unknown" {
	if (input.status !== "failed") return "continue";
	if (input.transactionState === "merge-intent" || input.transactionState === "unknown" ||
		input.transactionState === "merged") return "pending-merge-reconciliation";
	if (input.snapshotCreated === true ||
		input.proposalSubmitted === true && input.transactionState !== "rejected-draft")
		return "pending-merge-reconciliation";
	if (input.repairNeeded) return "workflow-repair-needed";
	if (input.transactionState === "rejected-draft" &&
		input.proposalSubmitted === true && input.snapshotCreated === false)
		return "m04-draft-rejected";
	// A host-written no-proposal journal proves no knowledge submission or
	// merge was attempted, even if the read-only M04 session then threw.
	// Preserve its failed stage as unselected history and continue fresh work.
	if (input.transactionState === "no-proposal" && input.proposalSubmitted === false &&
		input.snapshotCreated === false) return "continue";
	if (input.threw || input.proposalSubmitted !== false || input.snapshotCreated !== false)
		return "m04-integrity-unknown";
	return "continue";
}
function failedM04StopReason(status: "completed" | "failed" | "not_run",
	state?: PortableM04KnowledgeTransactionV1["state"], repairNeeded = false): CurrentObjectiveStopReason {
	if (status !== "failed") return "m04-evidence-incomplete";
	if (state === "merge-intent" || state === "unknown" || state === "merged")
		return "m04-transaction-unresolved";
	if (repairNeeded) return "workflow-repair-needed";
	if (state === "rejected-draft") return "m04-draft-rejected";
	return "m04-evidence-incomplete";
}
function privateM04TransactionFacts(transaction: PortableM04KnowledgeTransactionV1): {
	proposalSubmitted: boolean | undefined; snapshotCreated: boolean | undefined;
} {
	return {
		proposalSubmitted: transaction.attempts.length ? true : transaction.state === "no-proposal" ? false : undefined,
		snapshotCreated: transaction.state === "merged" ? true :
			transaction.state === "rejected-draft" || transaction.state === "no-proposal" ? false : undefined,
	};
}

/** A thrown M04 call does not supply completed booleans. Retain only the last
 * matching host-written transaction, preserving uncertainty around merge. */
async function retainFailedM04Transaction(ws: Workspace, goalRunId: string,
	destination: string): Promise<{ runId: string; transaction?: PortableM04KnowledgeTransactionV1;
	proposalSubmitted?: boolean; snapshotCreated?: boolean } | undefined> {
	for (const runId of (await ws.listRuns("M04")).reverse()) {
		const record = await ws.readRun("M04", runId);
		const source = record.outputs.find(item => item.label === "M07 处理来源");
		if (!source) continue;
		let sourceGoalRunId: string | undefined;
		try { sourceGoalRunId = JSON.parse(await readFile(source.path, "utf8")).m07RunId; }
		catch { /* A malformed source cannot identify this failed transaction. */ }
		if (sourceGoalRunId !== goalRunId) continue;
		const hostFile = path.join(ws.runDir("M04", runId), "m04-transaction.json");
		if (!existsSync(hostFile)) return { runId };
		const transaction = await exportPortableM04Transaction({ ws, m04RunId: runId, destination });
		return { runId, transaction, ...privateM04TransactionFacts(transaction) };
	}
	return undefined;
}
/** A diagnostic storage failure stops the campaign, but an already rejected
 * M04 draft still needs its exact portable transaction in the RSA result. */
async function retainM04TransactionOnDiagnosticFailure(ws: Workspace, goalRunId: string,
	stagingDir: string, outputDir: string, prefix?: "provenance-import" | `iteration-${number}`): Promise<void> {
	const retained = await retainFailedM04Transaction(ws, goalRunId, stagingDir);
	if (!retained?.transaction)
		throw new HarnessError("runner.m04-diagnostic-rescue",
			"M04 diagnostic rescue lacks the exact host transaction");
	if (!prefix) return;
	await copyFile(path.join(stagingDir, "m04-transaction.json"),
		path.join(outputDir, `${prefix}-m04-transaction.json`));
}
function selectedGoalBranchSatisfied(selectedGoalRunId: string, initialGoalRunId: string,
	initialBranchExerciseComplete: boolean): boolean {
	// A linked successor is a separate M07 goal. Its own finish() enforces any
	// competitive branches it created; an earlier partial goal cannot gate it.
	return selectedGoalRunId !== initialGoalRunId || initialBranchExerciseComplete;
}
function shouldRepairRejectedReview(input: { winner: boolean; stopped: boolean; aborted: boolean;
	rejected?: { status?: string; loopStopReason?: string; review?: unknown };
	unresolvedOperationIds: string[]; unresolvedTaskIds: string[] }): boolean {
	return !input.winner && !input.stopped && !input.aborted &&
		input.rejected?.status === "rejected" && input.rejected.loopStopReason === "ready" &&
		Boolean(input.rejected.review) && !input.unresolvedOperationIds.length && !input.unresolvedTaskIds.length;
}
function settledFailedM07RepairFeedback(goal: CurrentGoal, taskId: string,
	input: { winner: boolean; stopped: boolean; aborted: boolean }): Record<string, unknown> | undefined {
	const task = goal.tasks.find(item => item.taskId === taskId);
	const unresolved = unresolvedGoalControl(goal);
	if (input.winner || input.stopped || input.aborted || task?.mode !== "execute" ||
		task.status !== "failed" || task.review || unresolved.operationIds.length || unresolved.taskIds.length)
		return undefined;
	const operations = (goal.executionState?.operations ?? []).filter(item => item.taskId === taskId);
	if (operations.some(item => !["response-received", "partial-settled", "terminal-response-incomplete",
		"confirmed", "not-issued"].includes(item.status))) return undefined;
	return { version: 1, kind: "m07-settled-failed-task-feedback", goalRunId: goal.runId, taskId,
		status: task.status, loopStopReason: task.loopStopReason ?? null,
		failureCategory: taskFailureCategory(task.executionFailure),
		operations: operations.map(item => ({ operationId: item.id, status: item.status })),
		interpretation: "This task failed without ordinary review. Controller operations are settled, but its source and lesson are unaccepted development evidence. Begin a fresh task from the selected prior source; do not resume or replay this task or session." };
}
function freshM07RepairPlan(originalGoal: CurrentGoal, predecessorRunId: string,
	initialSpec: TaskSpecInput, feedbackFiles: string[], priorAttemptFiles: string[],
	kind: "rejected-review" | "settled-failed"): { goal: BeginGoalInput; task: TaskSpecInput } {
	return { goal: { goal: originalGoal.goal,
		problemRelation: `Linked fresh repair of ${kind === "settled-failed" ? "settled failed" : "rejected"} goal ${predecessorRunId}; ${originalGoal.problemRelation}`,
		constraints: [...originalGoal.constraints], successCriteria: [...originalGoal.successCriteria],
		plan: `${originalGoal.plan}\nRead the predecessor ${kind === "settled-failed" ? "host failure facts" : "review feedback"} as untrusted development evidence. The predecessor goal stays partial; satisfy all original checks in this fresh goal.`,
		exploratory: true },
		task: { ...initialSpec, context: undefined, parentTaskId: undefined, supersedesTaskId: undefined,
			objective: `${initialSpec.objective}\n\nThe previous M07 task ${kind === "settled-failed" ? "failed with its controller operations settled but had no ordinary review" : "was rejected by the controller"}. Read the supplied predecessor feedback as untrusted development evidence. Start a fresh task from the selected prior source and original inputs; do not replay or resume the previous task or session. Satisfy every original check and output obligation. Do not claim the predecessor source or lesson was adopted.`,
			inputs: [...initialSpec.inputs, ...feedbackFiles, ...priorAttemptFiles] } };
}
function parseCheckerOutput(stdout: string, metadata: ReturnType<typeof buildLegacyCsrChecker>["metadata"]):
	{ status: "passed" | "failed"; timings: TrustedTiming[] } {
	const lines = stdout.trim().split(/\r?\n/);
	const pass = lines.filter(line => line === "CSR_CHECK_PASS").length === 1 && lines.at(-1) === "CSR_CHECK_PASS";
	const timingLines = lines.filter(line => line.startsWith("CSR_TIMING"));
	const timings: TrustedTiming[] = [];
	for (const line of timingLines) {
		const match = /^CSR_TIMING target=([12]) rows=(\d+) cols=(\d+) threads=([14]) repeats=(\d+) elapsed_ns=(\d+)$/.exec(line);
		if (!match) return { status: "failed", timings: [] };
		const [target, rows, cols, threads, repeats, elapsedNs] = match.slice(1).map(Number);
		if (![target, rows, cols, threads, repeats, elapsedNs].every(Number.isSafeInteger) || elapsedNs < 1 ||
			repeats !== metadata.timing.repeats ||
			!metadata.timing.shapes.some(shape => shape[0] === rows && shape[1] === cols) ||
			!metadata.timing.threadCounts.includes(threads as 1 | 4)) return { status: "failed", timings: [] };
		timings.push({ target, rows, cols, threads, repeats, elapsedNs });
	}
	const keys = timings.map(item => `${item.target}:${item.rows}:${item.cols}:${item.threads}`);
	return { status: pass && lines.length === 9 && timingLines.length === 8 && timings.length === 8 &&
		new Set(keys).size === 8 ? "passed" : "failed", timings };
}
function parseRegisteredCheckerOutput(stdout: string, metadata: ReturnType<typeof buildCsrChecker>["metadata"]):
	{ status: "passed" | "failed"; timings: Array<Record<string, string | number | number[]>> } {
	const lines = stdout.trim().split(/\r?\n/);
	const pattern = /^CSR_TIMING case=([a-z][a-z0-9_-]*) kind=(serial|std_thread|strategy) target=(\d+) name=([A-Za-z_]\w*) rows=(\d+) cols=(\d+) ordinary_nnz=(\d+) heavy_rows=(\d+) heavy_nnz=(\d+) seed=(\d+) threads=(\d+) warmups=(\d+) repeats=(\d+) min_ns=(\d+) median_ns=(\d+) max_ns=(\d+) startup_ns=(\d+) cold_ns=(\d+) warmup_samples_ns=([\d,]+) samples_ns=([\d,]+)$/;
	const timings: Array<Record<string, string | number | number[]>> = [];
	const seen = new Set<string>();
	for (const line of lines.slice(0, -1)) {
		const match = pattern.exec(line);
		if (!match) return { status: "failed", timings: [] };
		const [caseId, kind, targetText, name] = match.slice(1, 5);
		const [rows, cols, ordinaryNnz, heavyRows, heavyNnz, seed, threads, warmups, repeats,
			minNs, medianNs, maxNs] = match.slice(5, 17).map(Number);
		const startupNs = Number(match[17]), coldNs = Number(match[18]);
		const warmupSamples = match[19].split(",").map(Number);
		const samples = match[20].split(",").map(Number);
		const sortedSamples = [...samples].sort((a, b) => a - b);
		const expectedMedian = sortedSamples.length % 2 ? sortedSamples[Math.floor(sortedSamples.length / 2)] :
			Math.floor((sortedSamples[sortedSamples.length / 2 - 1] + sortedSamples[sortedSamples.length / 2]) / 2);
		const numeric = [Number(targetText), rows, cols, ordinaryNnz, heavyRows, heavyNnz, seed, threads,
			warmups, repeats, minNs, medianNs, maxNs, startupNs, coldNs, ...warmupSamples, ...samples];
		const config = metadata.timing.cases.find(item => item.id === caseId);
		const expectedName = kind === "serial" ? metadata.baselines.serial : kind === "std_thread" ?
			metadata.baselines.stdThread : metadata.targets[Number(targetText) - 1];
		const key = `${caseId}:${kind}:${targetText}:${threads}`;
		if (!config || !numeric.every(Number.isSafeInteger) || samples.length !== repeats ||
			startupNs < 1 || coldNs < 1 || warmupSamples.length !== warmups || warmupSamples.some(value => value < 1) ||
			samples.some(value => value < 1) || minNs < 1 || medianNs !== expectedMedian || maxNs < medianNs ||
			Math.min(...samples) !== minNs || Math.max(...samples) !== maxNs ||
			rows !== config.rows || cols !== config.cols || ordinaryNnz !== config.normalNnz ||
			heavyRows !== config.longRows || heavyNnz !== config.longNnz || seed !== config.seed ||
			warmups !== config.warmups || repeats !== config.repeats || !config.threadCounts.includes(threads) ||
			!expectedName || expectedName !== name || (kind !== "strategy" && Number(targetText) !== 0) ||
			seen.has(key)) return { status: "failed", timings: [] };
		seen.add(key);
		timings.push({ caseId, kind, target: Number(targetText), name, rows, cols, ordinaryNnz, heavyRows,
			heavyNnz, seed, threads, requestedThreads: threads, actualThreads: "not_observed" as const,
			warmups, repeats, minNs, medianNs, maxNs, startupNs, coldNs, warmupSamplesNs: warmupSamples, samplesNs: samples });
	}
	const expectedCount = metadata.timing.cases.reduce((sum, item) => sum + item.threadCounts.length *
		(metadata.targets.length + 2), 0);
	return { status: lines.at(-1) === "CSR_CHECK_PASS" && timings.length === expectedCount ? "passed" : "failed", timings };
}
async function checkCandidate(original: string, candidate: string, scratch: string,
	registered?: { taskText: string; planFile: string }) {
	const originalText = await readFile(original, "utf8");
	const candidateText = await readFile(candidate, "utf8");
	let experimentPlan: CsrExperimentPlan | undefined;
	let planFailure: string | undefined;
	if (registered) try {
		const info = await lstat(registered.planFile);
		if (!info.isFile() || info.isSymbolicLink() || info.size > 16_000) throw new Error("invalid bounded plan file");
		experimentPlan = JSON.parse(await readFile(registered.planFile, "utf8")) as CsrExperimentPlan;
		if (!Array.isArray(experimentPlan?.cases) || experimentPlan.cases.some(item =>
			!Array.isArray(item.threadCounts) || item.threadCounts.some((count: number) =>
				!Number.isSafeInteger(count) || count < 1 || count > os.availableParallelism())))
			throw new Error("plan requests unavailable CPU parallelism");
	} catch { planFailure = "registered experiment plan unavailable or invalid"; }
	let shape = registered ? experimentPlan ? registeredSourceShape(originalText, candidateText, registered.taskText, experimentPlan) :
		{ ok: false, reason: planFailure ?? "registered experiment plan unavailable", targetCount: 0 } :
		sourceShape(originalText, candidateText);
	if (!registered && candidateText !== originalText) try { validateCsrTargetBodies(originalText, candidateText); }
	catch { shape = { ok: false, reason: "candidate body is outside the lexical host-safety capability", targetCount: shape.targetCount }; }
	if (!shape.ok && candidateText !== originalText) return { version: 1, status: "failed", sourceShape: shape,
		compile: { success: false, status: "not_run" }, independent: { status: "not_run" },
		...(registered ? { registeredExperiment: { status: "not_run", reason: shape.reason } } : {}) };
	await mkdir(scratch, { recursive: true, mode: 0o700 });
	await chmod(scratch, 0o777);
	await copyFile(candidate, path.join(scratch, "candidate.cpp"));
	await chmod(path.join(scratch, "candidate.cpp"), 0o644);
	const compiled = path.join(scratch, "candidate-bin");
	const build = isolated("/usr/bin/g++", [...FLAGS, "/work/candidate.cpp", "-o", "/work/candidate-bin"], scratch);
	const infrastructureFailure = Boolean(build.error) || build.status === null ||
		/(?:^|\n)(?:bwrap|sudo):|failed to (?:create|unshare|mount)/i.test(build.stderr ?? "");
	const verification: Record<string, unknown> = {
		version: 1, status: "failed", sourceShape: shape,
		compile: { success: build.status === 0, flags: FLAGS, infrastructureFailure,
			exitCode: build.status, signal: build.signal,
			spawnError: build.error?.message?.slice(0, 1000),
			stdoutTail: (build.stdout ?? "").slice(-4000), stderrTail: (build.stderr ?? "").slice(-8000) },
		originalCheckerRuns: [], independent: { status: "not_run" }, environment: { platform: os.platform(), release: os.release(),
			cpuModel: os.cpus()[0]?.model ?? "unknown", availableParallelism: os.availableParallelism() },
		limitation: "Program exit status is the original built-in checker, not an independent finite-output proof.",
	};
	if (build.status !== 0) return verification;
	// These CLI cases are used only when the private original source demonstrates support.
	const cases = deriveRuntimeCases(originalText);
	if (!cases)
		return { ...verification, status: "failed", reason: "required runtime options unavailable in original source" };
	const runs = [];
	for (const args of cases) {
		const started = process.hrtime.bigint();
		const run = isolated("/work/candidate-bin", args, scratch, true);
		const isolatedProcessWallMs = Number(process.hrtime.bigint() - started) / 1e6;
		const reportedKernelMs = (run.stdout ?? "").split(/\r?\n/).flatMap(line => {
			const match = /^\s*(.*?)\s+([0-9]+(?:\.[0-9]+)?)\s+ms\s*$/.exec(line);
			return match ? [{ label: match[1].trim(), ms: Number(match[2]) }] : [];
		});
		runs.push({ args, exitCode: run.status, isolatedProcessWallMs,
			reportedKernelMs, timingInterpretation: "isolatedProcessWallMs includes process startup; reportedKernelMs is the preserved original program's per-kernel timing",
			stdout: (run.stdout ?? "").slice(0, 12_000),
			stderrTail: run.status === 0 ? undefined : (run.stderr ?? "").slice(-1000) });
	}
	verification.originalCheckerRuns = runs;
	if (!registered) try {
		const checker = buildLegacyCsrChecker(originalText);
		await writeFile(path.join(scratch, "checker.cpp"), checker.source, { mode: 0o644 });
		await chmod(path.join(scratch, "checker.cpp"), 0o644);
		const compiledChecker = isolated("/usr/bin/g++", [...FLAGS,
			"/work/checker.cpp", "-o", "/work/independent-checker"], scratch);
		if (compiledChecker.status !== 0) verification.independent = { status: "compile_failed",
			stderrTail: (compiledChecker.stderr ?? "").slice(-4000) };
		else {
			const checked = isolated("/work/independent-checker", [], scratch, true);
			const parsed = parseCheckerOutput(checked.stdout ?? "", checker.metadata);
			verification.independent = { status: checked.status === 0 ? parsed.status : "failed", timings: parsed.timings,
				threadCounts: checker.metadata.threadCounts, shapes: checker.metadata.shapes,
				mutationPasses: checker.metadata.mutationPasses, timing: checker.metadata.timing,
				stderrTail: checked.status === 0 ? undefined : (checked.stderr ?? "").slice(-1000) };
		}
	} catch { verification.independent = { status: "unavailable" }; }
	verification.status = shape.ok && runs.every(x => x.exitCode === 0 && x.reportedKernelMs.length >= 3) &&
		(verification.independent as { status?: string }).status === "passed"
		? "passed" : "failed";
	if (registered) {
		verification.registeredExperiment = { status: "not_run", reason: planFailure ?? shape.reason };
		try {
			if (!experimentPlan || !shape.ok) return verification;
			const generated = buildCsrChecker(originalText, candidateText, registered.taskText, experimentPlan);
			const checkerFile = path.join(scratch, "registered-checker.cpp");
			await writeFile(checkerFile, generated.source, { mode: 0o644 });
			await writeFile(path.join(scratch, "candidate-worker.cpp"), generated.workerSource, { mode: 0o644 });
			await chmod(path.join(scratch, "candidate-worker.cpp"), 0o644);
			await writeFile(path.join(scratch, "baseline-worker.cpp"), generated.baselineWorkerSource, { mode: 0o644 });
			await chmod(path.join(scratch, "baseline-worker.cpp"), 0o644);
			await chmod(checkerFile, 0o644);
			const buildRegistered = isolated("/usr/bin/g++", [...FLAGS,
				"/work/registered-checker.cpp", "-o", "/work/registered-checker"], scratch);
			const buildWorker = isolated("/usr/bin/g++", [...FLAGS, "/work/candidate-worker.cpp", "-o", "/work/candidate-worker"], scratch);
			const buildBaseline = isolated("/usr/bin/g++", [...FLAGS, "/work/baseline-worker.cpp", "-o", "/work/baseline-worker"], scratch);
			if (buildRegistered.status !== 0 || buildWorker.status !== 0 || buildBaseline.status !== 0) verification.registeredExperiment = { status: "compile_failed",
				stderrTail: ((buildRegistered.stderr ?? "") + (buildWorker.stderr ?? "") + (buildBaseline.stderr ?? "")).slice(-4000) };
			else {
				const correctness = isolated("/work/registered-checker", ["--check"], scratch, true);
				const output: string[] = [];
				const executionFailures: Array<Record<string, unknown>> = [];
				let passed = correctness.status === 0 && correctness.stdout.trim() === "CSR_CHECK_PASS";
				const selectors = ["serial:0", "std_thread:0", ...generated.metadata.targets.map((_, index) => `strategy:${index + 1}`)];
				for (const config of generated.metadata.timing.cases) {
					for (const threads of config.threadCounts) for (const selector of selectors) {
						if (!passed) break;
						const measured = isolated("/work/registered-checker", ["--timing", config.id, selector, String(threads)],
							scratch, true);
						const rows = measured.stdout.trim().split(/\r?\n/);
						if (measured.status !== 0 || rows.length !== 2 || rows[1] !== "CSR_CHECK_PASS") {
							executionFailures.push({ phase: "timing", caseId: config.id, selector, threads, exitCode: measured.status, signal: measured.signal,
								stderrTail: (measured.stderr ?? "").slice(-4_000), stdoutTail: (measured.stdout ?? "").slice(-4_000) });
							passed = false; break; }
						output.push(rows[0]);
					}
				}
				const parsed = parseRegisteredCheckerOutput([...output, "CSR_CHECK_PASS"].join("\n"), generated.metadata);
				verification.registeredExperiment = { status: passed ? parsed.status : "failed",
					plan: experimentPlan, timings: parsed.timings, strategyNames: generated.metadata.targets,
					baselineNames: generated.metadata.baselines, metric: generated.metadata.timing.metric, measurementAuthority: generated.metadata.timing.trust, accounting: generated.metadata.timing.accounting,
					threadPolicy: generated.metadata.threadPolicy,
					freshProcessPerSelection: true, compileFlags: FLAGS, executionFailures,
					baselineIsolation: generated.metadata.timing.baselineIsolation, runtimeFiles: generated.metadata.timing.runtimeFiles,
					correctness: { status: correctness.status === 0 ? "passed" : "failed",
						threadCounts: generated.metadata.threadCounts, mutationPasses: generated.metadata.mutationPasses },
					stderrTail: correctness.status === 0 ? undefined : (correctness.stderr ?? "").slice(-1000) };
				verification.independent = { status: passed ? parsed.status : "failed", mutationPasses: generated.metadata.mutationPasses };

			}
		} catch (error) { verification.registeredExperiment = { status: "failed", reason: error instanceof Error ? error.message.slice(0, 2_000) : "registered checker generation or execution failed" }; }
		verification.status = shape.ok && runs.every(run => run.exitCode === 0) &&
			(verification.registeredExperiment as { status?: string }).status === "passed" ? "passed" : "failed";
	}
	return verification;
}

/** Authenticate transport elsewhere, then validate identities without promoting historical observations to current facts. */
function validateSelectedPriorTuple(bundle: PrivateContinuationBundle, inputNames: string[], binding: {
	contractId: string; sourceSha256: string;
}, originalSource: string): { checkpoint: ObjectiveProgressV1; archive: Record<string, any> } {
	if (!bundle["candidate.cpp"] || !bundle["verification.json"] || !bundle["objective-checkpoint.json"] ||
		!bundle["workflow-archive.json"]) fail("prior private continuation lacks selected evidence");
	const checkpoint = JSON.parse(bundle["objective-checkpoint.json"]) as ObjectiveProgressV1;
	if (checkpoint?.version !== 1 || checkpoint.kind !== "original-objective-progress" ||
		checkpoint.contract?.version !== 1 || checkpoint.contract.kind !== "original-objective" ||
		checkpoint.contract.id !== binding.contractId || typeof checkpoint.contract.createdAt !== "string" ||
		!Number.isFinite(Date.parse(checkpoint.contract.createdAt)) ||
		createHash("sha256").update(originalSource).digest("hex") !== binding.sourceSha256 ||
		JSON.stringify(checkpoint.contract.inputNames) !== JSON.stringify(inputNames) ||
		checkpoint.contract.closure !== "open-ended" || !Array.isArray(checkpoint.boundedRuns) ||
		!Array.isArray(checkpoint.assessmentHistory) || !Array.isArray(checkpoint.selectedArtifacts) ||
		!Array.isArray(checkpoint.availableArtifacts) || !Array.isArray(checkpoint.continuation?.unresolvedOperationIds))
		fail("prior objective or original-source version binding is invalid");
	// Reuse contract field validation, but preserve the original object and bytes verbatim.
	createOriginalObjective(checkpoint.contract);
	if (bundle["original-objective.json"] &&
		JSON.stringify(JSON.parse(bundle["original-objective.json"])) !== JSON.stringify(checkpoint.contract))
		fail("prior original contract and checkpoint differ");
	const archive = JSON.parse(bundle["workflow-archive.json"]) as Record<string, any>;
	const verification = JSON.parse(bundle["verification.json"]) as Record<string, any>;
	if (archive?.version !== 1 || archive.kind !== "m07-private-candidate-archive" ||
		archive.controllerEvidence?.reviewStatus !== "accepted" || !/^T\d{3,}$/.test(archive.taskId ?? "") ||
		typeof archive.goalRunId !== "string" || !checkpoint.boundedRuns.some(run => run.runId === archive.goalRunId &&
			(run.selectedTaskId === archive.taskId || run.acceptedTaskIds?.includes(archive.taskId))) ||
		verification?.version !== 1 || verification.status !== "passed" ||
		Buffer.byteLength(bundle["candidate.cpp"], "utf8") > 128_000 ||
		Buffer.byteLength(bundle["verification.json"], "utf8") > 1_000_000)
		fail("prior source and verification do not match a bounded accepted historical task");
	if (bundle["m04-adopted-knowledge.json"]) {
		const knowledge = JSON.parse(bundle["m04-adopted-knowledge.json"]) as Record<string, any>;
		if (knowledge?.version !== 1 || knowledge.kind !== "m04-published-knowledge-export" ||
			knowledge.m04RunId !== archive.m04?.runId || typeof knowledge.storeId !== "string" ||
			!Array.isArray(knowledge.records) || !Array.isArray(knowledge.adoptedExperienceRefs) ||
			knowledge.adoptedExperienceRefs.some((ref: Record<string, unknown>) =>
				ref.storeId !== knowledge.storeId || typeof ref.recordId !== "string" ||
				!Number.isSafeInteger(ref.version) || Number(ref.version) < 1))
			fail("prior knowledge export lacks its historical M04 version binding");
	}
	return { checkpoint, archive };
}

function validateContinuationSeed(bundle: PrivateContinuationBundle, inputNames: string[], binding: {
	contractId: string; sourceSha256: string;
}, originalSource: string): { checkpoint: ObjectiveProgressV1; archive: Record<string, any> } {
	const selected = validateSelectedPriorTuple(bundle, inputNames, binding, originalSource);
	if (selected.checkpoint.continuation.requiresOperationReconciliation ||
		selected.checkpoint.continuation.unresolvedOperationIds.length ||
		selected.checkpoint.boundedRuns.some(run => (run.unresolvedOperationIds?.length ?? 0) > 0))
		fail("prior unresolved external operations require reconciliation before new execution");
	return selected;
}

/** A read-only, lossless range-readable view; the authenticated carry keeps the original historical bytes. */
function rangeReadableHistory(text: string): string {
	const history = JSON.parse(text) as { version: number; kind: string; entries: Array<Record<string, any>> };
	if (history?.version !== 1 || history.kind !== "untrusted-version-bound-research-history" || !Array.isArray(history.entries))
		fail("historical research context is invalid");
	return `${JSON.stringify({ ...history, entries: history.entries.map(entry => ({ ...entry,
		files: Object.fromEntries(Object.entries(entry.files ?? {}).map(([name, content]) => {
			if (typeof content !== "string") fail("historical file content is invalid");
			const segments: string[] = [];
			for (let index = 0; index < content.length; index += 2_000) segments.push(content.slice(index, index + 2_000));
			return [name, { encoding: "concatenated-utf16-string-segments", segments }];
		})) })) }, null, 2)}\n`;
}

/** Preserve the whole readable projection; only the assessor's per-file bound determines paging. */
async function stageRangeReadableHistory(directory: string, text: string): Promise<{
	inputs: string[]; evidence: Array<{ name: string; file: string }>; partitioned: boolean;
}> {
	const rendered = Buffer.from(rangeReadableHistory(text), "utf8");
	const writePart = async (name: string, content: Buffer) => {
		await writeFile(path.join(directory, name), content, { mode: 0o600 });
		return { name, file: path.join(directory, name) };
	};
	if (rendered.length <= 1_000_000) {
		const item = await writePart("prior-research-history.json", rendered);
		return { inputs: [`objective-seeds/${item.name}`], evidence: [item], partitioned: false };
	}
	const parts: Array<{ name: string; bytes: number }> = [];
	const partByteSpans: Array<{ startByte: number; endByte: number }> = [];
	const evidence: Array<{ name: string; file: string }> = [];
	for (let start = 0; start < rendered.length;) {
		let end = Math.min(start + 1_000_000, rendered.length);
		if (end < rendered.length) while (end > start && (rendered[end] & 0xc0) === 0x80) end--;
		if (end <= start) fail("range-readable history cannot be partitioned on a UTF-8 boundary");
		const name = `prior-research-history-part-${String(parts.length + 1).padStart(6, "0")}.txt`;
		const content = rendered.subarray(start, end);
		evidence.push(await writePart(name, content));
		parts.push({ name, bytes: content.length });
		partByteSpans.push({ startByte: start, endByte: end });
		start = end;
	}
	const entries = locateHistoryEntries(rendered, partByteSpans).map(row => ({
		entryOrdinal: row.entryOrdinal,
		...(row.goalRunId === undefined ? {} : { goalRunId: row.goalRunId }),
		...(row.taskId === undefined ? {} : { taskId: row.taskId }),
		...(row.fileNames === undefined ? {} : { fileNames: row.fileNames }),
		parts: row.parts.map(range => ({ name: parts[range.partIndex]!.name,
			startLine: range.startLine, endLine: range.endLine,
			startByte: range.startByte, endByte: range.endByte })) }));
	const catalogParts: Array<{ name: string; firstOrdinal: number; lastOrdinal: number }> = [];
	const catalogEvidence: Array<{ name: string; file: string }> = [];
	let embeddedEntries = entries;
	const manifestFor = (rows: typeof entries) => ({ version: 1,
		kind: "range-readable-history-part-index",
		interpretation: "untrusted-control-locator-only",
		encoding: "utf8-concatenate-in-order-without-separators", totalBytes: rendered.length,
		parts, entries: rows, ...(catalogParts.length ? { catalogParts } : {}) });
	if (Buffer.byteLength(JSON.stringify(manifestFor(entries)), "utf8") > 1_000_000) {
		embeddedEntries = [];
		let chunk: typeof entries = [];
		const catalogHeaderBytes = Buffer.byteLength(JSON.stringify({ version: 1,
			kind: "untrusted-history-entry-locators", entries: [] }), "utf8");
		let chunkBytes = catalogHeaderBytes;
		const flush = async () => {
			if (!chunk.length) return;
			const name = `prior-research-history-catalog-${String(catalogParts.length + 1).padStart(6, "0")}.json`;
			const content = Buffer.from(`${JSON.stringify({ version: 1,
				kind: "untrusted-history-entry-locators", entries: chunk })}\n`, "utf8");
			if (content.length > 1_000_000) fail("one history locator exceeds the per-file evidence bound");
			catalogEvidence.push(await writePart(name, content));
			catalogParts.push({ name, firstOrdinal: chunk[0]!.entryOrdinal,
				lastOrdinal: chunk.at(-1)!.entryOrdinal });
			chunk = [];
			chunkBytes = catalogHeaderBytes;
		};
		for (const row of entries) {
			const rowBytes = Buffer.byteLength(JSON.stringify(row), "utf8");
			if (chunkBytes + rowBytes + Number(chunk.length > 0) > 1_000_000) {
				await flush();
				chunk = [row];
				chunkBytes += rowBytes;
			} else {
				chunkBytes += rowBytes + Number(chunk.length > 0);
				chunk.push(row);
			}
		}
		await flush();
	}
	const manifest = Buffer.from(`${JSON.stringify(manifestFor(embeddedEntries), null, 2)}\n`, "utf8");
	if (manifest.length > 1_000_000) fail("range-readable history part index exceeds the per-file evidence bound");
	const index = await writePart("prior-research-history-index.json", manifest);
	return { inputs: [index, ...catalogEvidence, ...evidence].map(item => `objective-seeds/${item.name}`),
		evidence: [index, ...catalogEvidence, ...evidence], partitioned: true };
}

/** A prior rejected draft is evidence for a NEW M04 decision, never a proposal
 * to replay. The old writer lacked exact issues, so that absence stays explicit. */
async function stageHistoricalM04RejectionEvidence(input: {
	goalRoot: string; bundle: PrivateContinuationBundle;
	goalRunId: string; taskId: string;
}): Promise<string[]> {
	const history = JSON.parse(input.bundle["research-history.json"] ?? "null") as
		{ entries?: Array<{ goalRunId: string; taskId: string; files?: Record<string, string> }> };
	const matches = history.entries?.filter(entry => entry.goalRunId === input.goalRunId &&
		entry.taskId === input.taskId) ?? [];
	if (matches.length !== 1) fail("historical rejected M04 entry is ambiguous");
	const archive = JSON.parse(matches[0].files?.["workflow-archive.json"] ?? "null") as
		{ m04?: { runId?: string } };
	const m04RunId = archive?.m04?.runId;
	if (typeof m04RunId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(m04RunId))
		fail("historical rejected M04 run identity is invalid");
	const portable = matches[0].files?.["m04-transaction.json"];
	if (portable === undefined)
		fail("historical rejected M04 has no portable host transaction receipt");
	const body = portable;
	const bytes = Buffer.from(body, "utf8");
	const write = async (name: string, content: Buffer) => {
		await writeFile(path.join(input.goalRoot, name), content, { mode: 0o600 });
		return name;
	};
	if (bytes.length <= 1_000_000)
		return [await write("prior-rejected-m04-transaction.json", bytes)];
	const parts: Array<{ name: string; bytes: number }> = [];
	for (let start = 0; start < bytes.length;) {
		let end = Math.min(start + 1_000_000, bytes.length);
		if (end < bytes.length) while (end > start && (bytes[end] & 0xc0) === 0x80) end--;
		if (end <= start) fail("historical M04 evidence cannot split on a UTF-8 boundary");
		const name = `prior-rejected-m04-transaction-part-${String(parts.length + 1).padStart(6, "0")}.txt`;
		await write(name, bytes.subarray(start, end));
		parts.push({ name, bytes: end - start });
		start = end;
	}
	const index = Buffer.from(`${JSON.stringify({ version: 1, kind: "prior-rejected-m04-part-index",
		encoding: "utf8-concatenate-in-order-without-separators", totalBytes: bytes.length,
		parts }, null, 2)}\n`, "utf8");
	if (index.length > 1_000_000) fail("historical M04 evidence index exceeds the per-file bound");
	return [await write("prior-rejected-m04-transaction-index.json", index),
		...parts.map(item => item.name)];
}

/** One goal/task has one final historical state, regardless of transport filename. */
function retainHistoricalArchiveEntry(entries: Array<Record<string, any>>, incoming: Record<string, any>): void {
	const index = entries.findIndex(entry => entry.goalRunId === incoming.goalRunId && entry.taskId === incoming.taskId);
	if (index < 0) { entries.push(incoming); return; }
	const existing = entries[index];
	if (existing.originalContractId !== incoming.originalContractId) fail("same-task historical archives disagree on original contract");
	const files = (entry: Record<string, any>): Record<string, string> => {
		if (!entry.files || typeof entry.files !== "object" || Array.isArray(entry.files)) fail("same-task historical archive has no files");
		return entry.files as Record<string, string>;
	};
	const oldFiles = files(existing), newFiles = files(incoming);
	for (const name of ["candidate.cpp", "verification.json", "experiment-plan.json"]) {
		if (oldFiles[name] !== newFiles[name]) fail(`same-task historical archives disagree on ${name}`);
	}
	if (oldFiles["m04-transaction.json"] && newFiles["m04-transaction.json"] &&
		oldFiles["m04-transaction.json"] !== newFiles["m04-transaction.json"])
		fail("same-task historical M04 transaction bytes conflict");
	const facts = (entry: Record<string, any>) => {
		let archive: Record<string, any>;
		try { archive = JSON.parse(files(entry)["workflow-archive.json"]); }
		catch { return fail("same-task historical archive manifest is invalid"); }
		if (archive?.goalRunId !== entry.goalRunId || archive.taskId !== entry.taskId)
			fail("same-task historical archive identity differs from its entry");
		const m04 = archive.m04 ?? { state: "not-run" };
		const stateRank = { "not-run": 0, failed: 1, completed: 2 }[m04.state as "not-run" | "failed" | "completed"];
		if (stateRank === undefined || (m04.proposalSubmitted !== undefined && typeof m04.proposalSubmitted !== "boolean") ||
			(m04.snapshotCreated !== undefined && typeof m04.snapshotCreated !== "boolean"))
			fail("same-task historical M04 state is invalid");
		if (files(entry)["m04-transaction.json"] &&
			(!m04.transaction || m04.transaction.state === undefined ||
				typeof m04.transaction.file !== "string" ||
				!m04.transaction.file.endsWith("m04-transaction.json")))
			fail("same-task historical M04 transaction is undeclared");
		return { stateRank, proposal: Number(m04.proposalSubmitted === true), snapshot: Number(m04.snapshotCreated === true),
			runId: typeof m04.runId === "string" ? m04.runId : undefined,
			exportComplete: m04.knowledgeExport?.state === "complete",
			transactionPresent: typeof files(entry)["m04-transaction.json"] === "string" };
	};
	const old = facts(existing), next = facts(incoming);
	const dominates = (a: typeof old, b: typeof old) => a.stateRank >= b.stateRank &&
		a.proposal >= b.proposal && a.snapshot >= b.snapshot;
	if (!dominates(old, next) && !dominates(next, old)) fail("same-task historical M04 outcomes conflict");
	const oldStrict = old.stateRank > next.stateRank || old.proposal > next.proposal || old.snapshot > next.snapshot;
	const nextStrict = next.stateRank > old.stateRank || next.proposal > old.proposal || next.snapshot > old.snapshot;
	if (!oldStrict && !nextStrict && old.runId && next.runId && old.runId !== next.runId)
		fail("same-task historical M04 run identity conflicts");
	if (nextStrict && old.transactionPresent && !next.transactionPresent)
		fail("same-task historical M04 transaction evidence was dropped");
	if (nextStrict || (!oldStrict && !nextStrict && ((!old.runId && next.runId) ||
		(!old.exportComplete && next.exportComplete) ||
		(!old.transactionPresent && next.transactionPresent))))
		entries[index] = incoming;
}

/** Keep selected evidence as one coherent tuple, never combine a new failed source with an old acceptance. */
async function collectContinuationBundle(directory: string, prior?: PrivateContinuationBundle): Promise<PrivateContinuationBundle | undefined> {
	const current: PrivateContinuationBundle = {};
	for (const name of PRIVATE_CONTINUATION_FILE_KEYS) {
		const file = path.join(directory, name);
		if (!existsSync(file)) continue;
		const info = await lstat(file);
		if (!info.isFile() || info.isSymbolicLink() ||
			info.size > (name === "research-history.json" ? CARRY_LOGICAL_BYTES : 4 * 1024 * 1024))
			fail("continuation evidence must be a bounded regular file");
		current[name] = await readFile(file, "utf8");
	}
	let accepted = false;
	try {
		const archive = JSON.parse(current["workflow-archive.json"] ?? "null");
		const verification = JSON.parse(current["verification.json"] ?? "null");
		const checkpoint = JSON.parse(current["objective-checkpoint.json"] ?? "null");
		accepted = Boolean(current["candidate.cpp"] && archive?.version === 1 &&
			archive.kind === "m07-private-candidate-archive" && archive.controllerEvidence?.reviewStatus === "accepted" &&
			verification?.version === 1 && verification.status === "passed" &&
			checkpoint?.selectedArtifacts?.includes("candidate.cpp") && checkpoint.selectedArtifacts.includes("verification.json") &&
			checkpoint.boundedRuns?.some((run: { runId: string; selectedTaskId?: string }) =>
				run.runId === archive.goalRunId && run.selectedTaskId === archive.taskId));
	} catch { /* Keep the prior coherent accepted tuple on an interrupted or failed new attempt. */ }
	const selected = accepted ? current : prior ? { ...prior } : undefined;
	if (!selected) return undefined;
	const savedHistory = current["research-history.json"] ?? prior?.["research-history.json"];
	const history = savedHistory ? JSON.parse(savedHistory) :
		{ version: 1, kind: "untrusted-version-bound-research-history", entries: [] };
	if (history?.version !== 1 || history.kind !== "untrusted-version-bound-research-history" || !Array.isArray(history.entries))
		fail("prior research history is invalid");
	const priorHistoryEntries = [...history.entries];
	history.entries = [];
	for (const entry of priorHistoryEntries) {
		if (!entry || typeof entry.goalRunId !== "string" || !/^T\d{3,}$/.test(String(entry.taskId)))
			fail("prior research history entry identity is invalid");
		retainHistoricalArchiveEntry(history.entries, entry);
	}
	if (prior && accepted && prior["workflow-archive.json"] !== current["workflow-archive.json"]) {
		const archived = JSON.parse(prior["workflow-archive.json"] ?? "null");
		const checkpoint = JSON.parse(prior["objective-checkpoint.json"] ?? "null");
		if (!archived?.goalRunId || !archived.taskId || !checkpoint?.contract?.id) fail("historical tuple lacks version binding");
		retainHistoricalArchiveEntry(history.entries, { originalContractId: checkpoint.contract.id, goalRunId: archived.goalRunId,
				taskId: archived.taskId, interpretation: "Untrusted historical development evidence; prior adoption is not current truth",
				files: Object.fromEntries(["candidate.cpp", "verification.json", "workflow-archive.json",
					"experiment-plan.json", "m04-adopted-knowledge.json", "m04-transaction.json"].filter(name => prior[name as keyof typeof prior] !== undefined)
					.map(name => [name, prior[name as keyof typeof prior]])) });
	}
	// Preserve failed experiments as version-bound development evidence, separate
	// from the coherent selected source/verification/review tuple.
	const checkpoint = JSON.parse(current["objective-checkpoint.json"] ?? prior?.["objective-checkpoint.json"] ?? "null");
	const contractId = checkpoint?.contract?.id;
	if (typeof contractId === "string" && contractId) {
		const archives = await campaignArchiveNames(directory);
		for (const archiveName of archives) {
			const archiveFile = path.join(directory, archiveName);
			if (!existsSync(archiveFile)) continue;
			const archiveText = await readFile(archiveFile, "utf8");
			const archive = JSON.parse(archiveText) as Record<string, any>;
			if (archive?.version !== 1 || archive.kind !== "m07-private-candidate-archive" ||
				(accepted && archiveName === "workflow-archive.json") ||
				!/^T\d{3,}$/.test(String(archive.taskId)) || typeof archive.goalRunId !== "string") continue;
			const prefix = archiveName === "workflow-archive.json" ? "" : archiveName.slice("workflow-".length, -"-archive.json".length) + "-";
			const files: Record<string, string> = { "workflow-archive.json": archiveText };
			for (const name of ["candidate.cpp", "verification.json", "experiment-plan.json", "lesson-delta.json",
				"review-decision.json", "m04-adopted-knowledge.json", "m04-transaction.json",
				...(await readdir(directory)).filter(name => name.startsWith(prefix) &&
					/^round-[1-9][0-9]*-reviewer-feedback\.txt$/.test(name.slice(prefix.length)))
					.map(name => name.slice(prefix.length))]) {
				const file = path.join(directory, `${prefix}${name}`);
				if (!existsSync(file)) continue;
				const info = await lstat(file);
				if (!info.isFile() || info.isSymbolicLink() ||
					info.size > (name === "m04-transaction.json" ? 4 * 1024 * 1024 : 1_000_000))
					fail("unselected campaign evidence must be a bounded regular file");
				files[name] = await readFile(file, "utf8");
			}
			retainHistoricalArchiveEntry(history.entries, { originalContractId: contractId, goalRunId: archive.goalRunId,
				taskId: archive.taskId,
				interpretation: "Unselected or unresolved experiment; measurements and review do not establish a replacement for the selected candidate",
				files });
		}
	}
	if (history.entries.length) selected["research-history.json"] = JSON.stringify(history);
	for (const name of ["original-objective.json", "objective-checkpoint.json", "objective-assessment-receipts.json",
		"independent-restart-quarantine.json", "independent-restart-goal-binding.json",
		"host-effect-receipt.json", "transport-diagnostics.json", "repair-state.json",
		"m04-transaction.json",
		"m04-transaction-quarantine.json"] as const)
		if (current[name]) selected[name] = current[name];
	// Repair telemetry belongs to the current process only. A later accepted
	// objective must not inherit an older source's repair-plan authority.
	if (!current["repair-state.json"]) delete selected["repair-state.json"];
	// A receipt describes one Actions execution. An older receipt cannot attest
	// this process merely because its historical selected tuple was retained.
	if (!current["host-effect-receipt.json"]) delete selected["host-effect-receipt.json"];
	if (Buffer.byteLength(JSON.stringify(selected), "utf8") > CARRY_LOGICAL_BYTES)
		fail("research continuation exceeds the segmented carry capacity");
	return selected;
}

/** Collection failure retains the authenticated old research and only the new
 * host-prepared transport metadata for an emergency accounting/effect seal. */
function collectorFailureBundle(prior: PrivateContinuationBundle | undefined,
	transportCensus: string | undefined,
	m04QuarantineText?: string): PrivateContinuationBundle | undefined {
	if (transportCensus === undefined && m04QuarantineText === undefined) return prior;
	return { ...prior,
		...(transportCensus === undefined ? {} : { "transport-diagnostics.json": transportCensus }),
		...(m04QuarantineText === undefined ? {} : { [M04_TRANSACTION_QUARANTINE_FILE]: m04QuarantineText }) };
}

/** Host-side task and tool census; the encrypted carry later authenticates these exact bytes. */
async function buildHostEffectReceipt(input: { ws: Workspace;
	source: HostEffectReceiptV1["source"]; priorEnvelopeSha256: string;
	historicalGoalRunIds: string[]; requestIds: string[];
	sessions: ReadonlyMap<string, { sessionId: string;
		grantKind: "none" | "read-dir" | "confined-execution"; taskId?: string;
		workRoot?: string; grant?: NonNullable<SessionSpec["toolAuthority"]> }> }): Promise<HostEffectReceiptV1> {
	const owners = new Map<string, { goalRunId: string; taskId: string }>();
	const goals: HostEffectReceiptV1["goals"] = [];
	for (const runId of await input.ws.listRuns("M07")) {
		const goal = JSON.parse(await readFile(path.join(input.ws.runDir("M07", runId), "goal.json"), "utf8")) as CurrentGoal;
		if (goal.runId !== runId || !Array.isArray(goal.tasks) || !Array.isArray(goal.executionState?.operations))
			fail("M07 host effect census lacks a complete controller goal");
		const tasks = goal.tasks.map(task => {
			if (task.mode !== "execute" && task.mode !== "check")
				fail("M07 host effect census saw an unsupported task mode");
			const sessionId = task.session?.id ? campaignSessionEffectId(task.session.id) : "";
			if (sessionId) {
				if (owners.has(sessionId)) fail("M07 host effect census reused one session for multiple tasks");
				owners.set(sessionId, { goalRunId: runId, taskId: task.taskId });
			}
			return { taskId: task.taskId, mode: task.mode, status: task.status, sessionId };
		});
		goals.push({ runId, outcome: goal.outcome ?? "active", tasks,
			operations: goal.executionState.operations.map(operation => ({ id: operation.id,
				taskId: operation.taskId, status: operation.status })) });
	}
	const sessions: HostEffectReceiptV1["sessions"] = [];
	for (const session of input.sessions.values()) {
		const sessionId = campaignSessionEffectId(session.sessionId);
		if (session.grantKind === "confined-execution") {
			const owner = owners.get(sessionId);
			if (!owner || owner.taskId !== session.taskId || !session.grant || !session.workRoot)
				fail("M07 execution grant lacks an exact controller task identity");
			sessions.push({ sessionId, kind: "confined-execution",
				goalRunId: owner.goalRunId, taskId: owner.taskId, workRoot: session.workRoot,
				grant: session.grant });
		} else sessions.push({ sessionId, kind: session.grantKind });
	}
	return { version: 1, kind: "m07-host-effect-census", source: input.source,
		priorEnvelopeSha256: input.priorEnvelopeSha256,
		historicalGoalRunIds: input.historicalGoalRunIds, goals, sessions,
		requestIds: input.requestIds };
}

/** A nonterminal observation may precede task/session linkage. Persist only
 * controller rows that actually exist on disk; the final census still checks
 * complete ownership before granting any restart authority. */
async function observedPersistedM07Goals(ws: Workspace): Promise<HostEffectPrefixObservationV1["goals"]> {
	const goals: HostEffectPrefixObservationV1["goals"] = [];
	for (const runId of await ws.listRuns("M07")) {
		const file = path.join(ws.runDir("M07", runId), "goal.json");
		let raw: string;
		try { raw = await readFile(file, "utf8"); }
		catch (error) {
			// startRun can create a run directory before the controller creates its
			// first goal record. That unobserved interval stays outside the prefix.
			if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
			throw error;
		}
		const goal = JSON.parse(raw) as CurrentGoal;
		if (goal.runId !== runId || !Array.isArray(goal.tasks) ||
			!Array.isArray(goal.executionState?.operations))
			fail("incremental M07 goal observation is incomplete");
		goals.push({ runId, outcome: goal.outcome ?? "active",
			tasks: goal.tasks.map(task => ({ taskId: task.taskId, mode: task.mode,
				status: task.status,
				sessionId: task.session?.id ? campaignSessionEffectId(task.session.id) : "" })),
			operations: goal.executionState.operations.map(operation => ({ id: operation.id,
				taskId: operation.taskId, status: operation.status })) });
	}
	return goals;
}

async function inputs(inputDir: string) {
	const entries = await readdir(inputDir, { withFileTypes: true });
	const sources = entries.filter(x => x.name.endsWith(".cpp"));
	const texts = entries.filter(x => /\.(?:md|txt)$/i.test(x.name));
	if (entries.length !== 3 || sources.length !== 1 || texts.length !== 2 ||
		entries.length !== sources.length + texts.length || entries.some(x => !x.isFile() || x.name.startsWith(".")))
		fail("input bundle must contain exactly three regular flat files: one C++ source and two text files");
	for (const entry of entries) {
		const full = path.join(inputDir, entry.name), info = await lstat(full);
		if (!info.isFile() || info.isSymbolicLink() || info.size > 512_000 || info.size < 1) fail("invalid private input file");
	}
	return { source: sources[0].name, files: entries.map(x => x.name).sort() };
}

async function main() {
	const inputDir = arg("--input-dir"), outputDir = arg("--output-dir");
	statusTransportDiagnostics = [];
	statusOutputDir = outputDir;
	await mkdir(outputDir, { recursive: true, mode: 0o700 });
	const ledgerEnvelope = process.env.MULPIS_MISSION_LEDGER_B64;
	const githubToken = process.env.GITHUB_TOKEN;
	const runtimeKey = process.env.DEEPSEEK_API_KEY;
	delete process.env.MULPIS_MISSION_LEDGER_B64;
	delete process.env.GITHUB_TOKEN;
	delete process.env.DEEPSEEK_API_KEY;
	statusPhase = "mission-ledger-verification";
	const missionLedger = await openLedgerContinuation({ seedEnvelopeB64: ledgerEnvelope,
		publicKeyFile: path.join(HERE, "campaign-output-public.pem"), githubToken,
		loadCarryArtifact: ({ artifactId, expectedArchiveSha256 }) => downloadCarryArtifact({
			githubToken: githubToken ?? "", artifactId, expectedArchiveSha256 }),
		current: { repository: process.env.GITHUB_REPOSITORY, runId: process.env.GITHUB_RUN_ID,
			runAttempt: process.env.GITHUB_RUN_ATTEMPT, actor: process.env.GITHUB_ACTOR,
			event: process.env.GITHUB_EVENT_NAME, ref: process.env.GITHUB_REF,
			sha: process.env.GITHUB_SHA, manualAuthorized: process.env.MULPIS_MANUAL_AUTHORIZED,
			before: process.env.MULPIS_RUN_REQUEST_BEFORE } });
	// Old signed ceilings remain authenticated history, not a runnable fee policy.
	if (missionLedger.mode !== "accounting-only") fail("explicit signed accounting-only mission transition is required");
	let finalBudget: DeepSeekCampaignBudget | undefined;
	const finalizationFailures: FinalizationFailureCode[] = [];
	try {
	if (!runtimeKey?.trim()) fail("DeepSeek credential absent");
	statusRuntimeKey = runtimeKey;
	statusPhase = "credential-probe";
	try { statusCredentialProbe = await credentialProbe(runtimeKey); }
	catch { statusCredentialProbe = { httpStatus: null, accepted: false }; }
	if (!statusCredentialProbe.accepted) {
		if (statusCredentialProbe.httpStatus === 401 || statusCredentialProbe.httpStatus === 403)
			fail("DeepSeek credential rejected by read-only model-list endpoint");
		fail("DeepSeek credential probe did not complete successfully");
	}
	statusPhase = "credential-verified";
	statusPhase = "provider-output-limit-verification";
	const providerOutputLimit = await verifyDeepSeekProviderOutputLimit({ apiKey: runtimeKey });
	statusPhase = "provider-output-limit-verified";
	statusPhase = "billing-currency-verification";
	const checkedCnyPricing = await verifyDeepSeekCnyBilling({ apiKey: runtimeKey }).catch(() => undefined);
	const nativeCnyPricing = checkedCnyPricing?.modelVersion === providerOutputLimit.modelVersion
		? checkedCnyPricing : undefined;
	statusPhase = nativeCnyPricing ? "billing-currency-verified" : "billing-currency-unverified";
	const found = await inputs(inputDir);
	await requireIsolation(); // fail before any provider call
	statusPhase = "isolated-preflight-passed";
	const campaignRoot = await mkdtemp(path.join(os.tmpdir(), "mulpis-private-campaign-"));
	let runId: string | undefined;
	const budget = createPrivateCampaignBudget(nativeCnyPricing, providerOutputLimit);
	statusBudget = budget;
	finalBudget = budget;
	let receiptHistoricalGoalRunIds: string[] = [];
	const sessionEffects = new Map<string, { sessionId: string;
		grantKind: "none" | "read-dir" | "confined-execution";
		taskId?: string; workRoot?: string;
		grant?: NonNullable<SessionSpec["toolAuthority"]> }>();
	const incrementalJournal = missionLedger.createIncrementalControlJournal(outputDir);
	let prefixObjectiveCheckpointFile: string | undefined;
	let prefixWorkspace: Workspace | undefined;
	const recordIncrementalPrefix = async (event: IncrementalCheckpointEvent,
		audit = budget.requestAccountingAuditSnapshot()): Promise<void> => {
		let objectiveCheckpointJson: string | undefined;
		if (prefixObjectiveCheckpointFile) {
			try { objectiveCheckpointJson = await readFile(prefixObjectiveCheckpointFile, "utf8"); }
			catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
		}
		const source = missionLedger.incrementalControlSource;
		const prefixGoals = prefixWorkspace ? await observedPersistedM07Goals(prefixWorkspace) : [];
		const hostEffects: HostEffectPrefixObservationV1 = { version: 1,
			kind: "host-effect-prefix-observation", complete: false, selectionAuthority: false,
			source: { runId: source.runId, runAttempt: source.runAttempt, commit: source.commit },
			priorEnvelopeSha256: source.priorEnvelopeSha256,
			historicalGoalRunIds: [...receiptHistoricalGoalRunIds],
			goals: structuredClone(prefixGoals),
			sessions: [...sessionEffects.values()].map(session => ({
				sessionId: campaignSessionEffectId(session.sessionId), kind: session.grantKind,
				...(session.taskId ? { taskId: session.taskId } : {}),
				...(session.workRoot ? { workRoot: session.workRoot } : {}),
				...(session.grant ? { grant: { version: 1 as const,
					kind: "confined-campaign-files" as const,
					root: session.grant.root,
					writableFiles: [...session.grant.writableFiles] } } : {}) })),
			requestIds: audit.requests.map(row => row.requestId) };
		await incrementalJournal.record(event, { requestAudit: audit, hostEffects,
			unobservedControlDeliveries: missionLedger.unobservedControlDeliveries,
			...(objectiveCheckpointJson === undefined ? {} : { objectiveCheckpointJson }) });
	};
	let campaignCancelled = false;
	try {
		await recordIncrementalPrefix("initial");
		const ws = new Workspace(path.join(campaignRoot, "workspace"));
		prefixWorkspace = ws;
		statusPhase = "workspace-init";
		const store = createFileKnowledgeStore(ws.knowledgeDir);
		await runInit(ws, store);
		for (const name of found.files) await copyFile(path.join(inputDir, name), path.join(ws.rawDir, name));
		statusPhase = "private-inputs-staged";
		await writeFile(ws.problemFile,
			"Private C++ parallel-programming task. Use only the supplied original inputs. Produce optimized source and machine-readable correctness/performance observations. Do not produce a prose report, screenshots, presentation, or personal reflection. Do not invent measurements.\n" +
			(await readFile(path.join(ws.rawDir, found.files.find(x => /\.md$/i.test(x)) ?? found.files.find(x => /\.txt$/i.test(x))!), "utf8")),
			{ mode: 0o600 });
		const originalPath = path.join(ws.rawDir, found.source);
		const originalText = await readFile(originalPath, "utf8");
		const registeredTaskText = (await Promise.all(found.files.filter(name => /\.(?:md|txt)$/i.test(name))
			.map(name => readFile(path.join(ws.rawDir, name), "utf8")))).join("\n\n");
		const previousBundle = missionLedger.priorPrivateBundle;
		if (!previousBundle || !missionLedger.priorBootstrapBinding)
			fail("mission continuation lacks authenticated selected prior evidence");
		const selectedSeed = validateSelectedPriorTuple(previousBundle, found.files,
			missionLedger.priorBootstrapBinding, originalText);
		const previousCheckpoint = selectedSeed.checkpoint;
		let importTarget: ReturnType<typeof archivedM07ImportTarget>;
		let m04QuarantineEvidencePath: string | undefined;
		receiptHistoricalGoalRunIds = previousCheckpoint.boundedRuns.map(item => item.runId);
		const priorNeedsQuarantine = previousCheckpoint.continuation.requiresOperationReconciliation ||
			previousCheckpoint.continuation.unresolvedOperationIds.length > 0 ||
			previousCheckpoint.boundedRuns.some(run => (run.unresolvedOperationIds?.length ?? 0) > 0) ||
			missionLedger.opaqueExecutedRuns.length > 0 ||
			missionLedger.unobservedControlDeliveries.length > 0 ||
			Boolean(authenticatedPendingHistoricalEffectSources(missionLedger.priorCarryProof,
				previousBundle)?.length);
		if (!priorNeedsQuarantine) validateContinuationSeed(previousBundle, found.files,
			missionLedger.priorBootstrapBinding, originalText);
		let historicalUnresolvedOperationIds = canonicalUnresolvedOperationRefs(previousCheckpoint);
		const priorSeedDir = path.join(ws.root, "objective-seeds");
		await mkdir(priorSeedDir, { recursive: true, mode: 0o700 });
		await writeFile(path.join(priorSeedDir, "prior-candidate.cpp"), previousBundle["candidate.cpp"]!, { mode: 0o600 });
		await writeFile(path.join(priorSeedDir, "prior-verification.json"), previousBundle["verification.json"]!, { mode: 0o600 });
		await writeFile(path.join(priorSeedDir, "prior-archive.json"), previousBundle["workflow-archive.json"]!, { mode: 0o600 });
		if (previousBundle["experiment-plan.json"])
			await writeFile(path.join(priorSeedDir, "prior-experiment-plan.json"), previousBundle["experiment-plan.json"], { mode: 0o600 });
		await writeFile(path.join(priorSeedDir, "prior-objective-checkpoint.json"), previousBundle["objective-checkpoint.json"]!, { mode: 0o600 });
		const historySeed = previousBundle["research-history.json"] ?
			await stageRangeReadableHistory(priorSeedDir, previousBundle["research-history.json"]) : undefined;
		const priorSeedInputs = ["objective-seeds/prior-objective-checkpoint.json",
			...(historySeed?.inputs ?? []),
			...(previousBundle["m04-adopted-knowledge.json"] ? ["objective-seeds/prior-m04-knowledge.json"] : []),
			"objective-seeds/prior-candidate.cpp", "objective-seeds/prior-verification.json",
			"objective-seeds/prior-archive.json",
			...(previousBundle["experiment-plan.json"] ? ["objective-seeds/prior-experiment-plan.json"] : [])];
		const priorTransportObservation = missionLedger.priorTransportDiagnosticCensus?.entries.at(-1);
		const priorTransportObservationPath = priorTransportObservation ?
			path.join(priorSeedDir, "prior-transport-observation.json") : undefined;
		if (priorTransportObservation && priorTransportObservationPath) {
			await writeFile(priorTransportObservationPath, `${JSON.stringify({ version: 1,
				kind: "authenticated-prior-transport-observation",
				source: priorTransportObservation.source, rows: priorTransportObservation.rows,
				interpretation: "Host-observed transport metadata only; an unreceived assistant response leaves billing and operation outcome unresolved. Do not replay the old request or treat HTTP status as a scientific verdict. An unknown reason class leaves the provider cause unavailable.",
			}, null, 2)}\n`, { mode: 0o600 });
			priorSeedInputs.push("objective-seeds/prior-transport-observation.json");
		}
		const historicalM04Index = missionLedger.priorCarryProof ? historicalM04EvidenceIndex({
			proof: missionLedger.priorCarryProof, bundle: previousBundle }) : undefined;
		const historicalM04IndexPath = historicalM04Index ?
			path.join(priorSeedDir, "historical-m04-evidence-index.json") : undefined;
		if (historicalM04IndexPath) {
			await writeFile(historicalM04IndexPath, `${JSON.stringify(historicalM04Index, null, 2)}\n`,
				{ mode: 0o600 });
			priorSeedInputs.push("objective-seeds/historical-m04-evidence-index.json");
		}
		const originalObjective = previousCheckpoint.contract;
		// A historical contract is immutable; current user overrides enter prompts separately.
		const objectiveContractFile = path.join(outputDir, "original-objective.json");
		const objectiveCheckpointFile = path.join(outputDir, "objective-checkpoint.json");
		prefixObjectiveCheckpointFile = objectiveCheckpointFile;
		const writeCurrentObjectiveProgress = async (progress: ObjectiveProgressV1): Promise<void> => {
			await writeObjectiveProgress(objectiveCheckpointFile, progress);
			await recordIncrementalPrefix("control-observed");
		};
		await writeOriginalObjectiveContract(objectiveContractFile, originalObjective);
		await writeCurrentObjectiveProgress(previousCheckpoint);
		await writeFile(ws.configFile, JSON.stringify({ roles: { execution: MODEL, reviewer: MODEL, research: MODEL }, concurrency: 1, tools: {} }), { mode: 0o600 });
		const targetCount = [...originalText.matchAll(/\/\/\s*TODO[^\n]*\n\s*static\s+void\s+([A-Za-z_]\w*)\s*\(/g)].length;
		if (targetCount < 2 || !originalText.includes('"--threads"') || !originalText.includes('"--repeats"'))
			fail("private source does not satisfy bounded campaign preflight contract");
		statusPhase = "original-source-smoke";
		// The separate /tmp directory has no 0700 campaignRoot ancestor, so sandbox UID 65534 can traverse its bind source.
		const originalScratch = await verifierScratch("original");
		let originalSmoke;
		try { originalSmoke = await checkCandidate(originalPath, originalPath, originalScratch); }
		finally { await rm(originalScratch, { recursive: true, force: true }); }
		await writeFile(path.join(outputDir, "verification.json"),
			JSON.stringify({ kind: "original-preflight", result: originalSmoke }, null, 2), { mode: 0o600 });
		if ((originalSmoke.compile as { success?: boolean } | undefined)?.success !== true || !Array.isArray(originalSmoke.originalCheckerRuns) ||
			originalSmoke.originalCheckerRuns.length !== 9 || originalSmoke.originalCheckerRuns.some(x => x.exitCode !== 0) ||
			(originalSmoke.independent as { status?: string } | undefined)?.status !== "passed")
			throw new SandboxPreflightError("original source compile/check failed; inspect encrypted verification.json");
		statusPhase = "prior-selected-revalidation";
		const priorScratch = await verifierScratch("candidate");
		let priorSelectedCheck: Record<string, unknown>;
		try {
			priorSelectedCheck = await checkCandidate(originalPath, path.join(priorSeedDir, "prior-candidate.cpp"), priorScratch,
				previousBundle["experiment-plan.json"] ? { taskText: registeredTaskText,
					planFile: path.join(priorSeedDir, "prior-experiment-plan.json") } : undefined);
		} finally { await rm(priorScratch, { recursive: true, force: true }); }
		await writeFile(path.join(outputDir, "restored-candidate-verification.json"),
			`${JSON.stringify({ ...priorSelectedCheck,
				validationPurpose: "Fresh deterministic prior-source correctness guard; timings are not a new research study or historical speedup comparison" }, null, 2)}\n`,
			{ mode: 0o600 });
		const priorCompile = priorSelectedCheck.compile as Record<string, unknown> | undefined;
		statusPriorSelectedValidation = priorSelectedCheck.status === "passed" ? "passed" :
			priorCompile?.infrastructureFailure === true ? "infrastructure-unavailable" : "failed";
		if (statusPriorSelectedValidation === "infrastructure-unavailable")
			throw new SandboxPreflightError(`selected prior source revalidation sandbox unavailable; exit=${String(priorCompile?.exitCode)}, signal=${String(priorCompile?.signal)}, error=${privateFailureMessage(priorCompile?.spawnError, runtimeKey) ?? "none"}, stderr=${privateFailureMessage(priorCompile?.stderrTail, runtimeKey) ?? "none"}`);
		if (statusPriorSelectedValidation !== "passed")
			throw new SandboxPreflightError("selected prior source failed current host correctness revalidation; inspect encrypted restored-candidate-verification.json");
		const priorSelectedValidationSha256 = createHash("sha256").update(JSON.stringify(priorSelectedCheck)).digest("hex");
		const verifiedFreshBoundary = async (): Promise<FreshM04QuarantineBoundary> => {
			const campaignReal = await realpath(campaignRoot);
			const workspaceReal = await realpath(ws.root);
			const storeReal = await realpath(ws.knowledgeDir);
			const proposalDir = path.join(ws.knowledgeDir, "proposals");
			const rootsAreDirectories = (await Promise.all([campaignRoot, ws.root, ws.knowledgeDir]
				.map(item => lstat(item)))).every(info => info.isDirectory() && !info.isSymbolicLink());
			let emptyStore = false;
			try { emptyStore = (await store.current()) === undefined &&
				(await store.list()).length === 0 && (await readdir(proposalDir)).length === 0; }
			catch { /* Unknown store state cannot grant fresh work. */ }
			const privateConfig = await ws.loadConfig();
			const freshStoreVerified = emptyStore && rootsAreDirectories &&
				path.dirname(campaignReal) === await realpath(os.tmpdir()) &&
				workspaceReal === path.join(campaignReal, "workspace") &&
				storeReal === path.join(workspaceReal, ".agent", "knowledge");
			const noExternalWriteTools = Object.keys(privateConfig.tools ?? {}).length === 0;
			if (!freshStoreVerified || sessionEffects.size !== 0 || !noExternalWriteTools ||
				statusPriorSelectedValidation !== "passed")
				fail("fresh independent campaign store or grant boundary is unavailable");
			return { campaignRoot: campaignReal, workspaceRoot: workspaceReal,
				storeRoot: storeReal, storeEmpty: true, sessionCensusEmpty: true,
				sessionMode: "no-prior-session-resume", grantProfile: "private-confined-read-dir",
				externalWriteTools: false, sharedStore: false, selectedRevalidated: true };
		};
		// Classify historical M04 state before consuming the one-use Actions claim.
		// The old proposal remains UNKNOWN; this preflight only chooses fresh work.
		const initialFreshBoundary = await verifiedFreshBoundary();
		const freshOnlyM04Quarantine = missionLedger.priorCarryProof ?
			buildUnresolvedHistoricalM04Quarantine({ proof: missionLedger.priorCarryProof,
				bundle: previousBundle, freshBoundary: initialFreshBoundary }) : undefined;
		const inheritedM04Quarantine = missionLedger.priorCarryProof ?
			validateM04TransactionQuarantine({ proof: missionLedger.priorCarryProof,
				bundle: previousBundle }) : undefined;
		let restartReservation: IndependentRestartReservation | undefined;
		if (priorNeedsQuarantine) {
			statusPhase = "independent-restart-admission";
			const priorProof = missionLedger.priorCarryProof;
			const facts = authenticatedHistoricalCarryFacts(priorProof, previousBundle);
			if (!facts) throw new SandboxPreflightError("authenticated terminal carry and selected prior proof unavailable; independent restart suspended");
			restartReservation = await reserveIndependentRestart({ authenticatedCarryProof: priorProof,
				privateBundle: previousBundle, freshBoundary: initialFreshBoundary,
				unobservedControlDeliveries: missionLedger.unobservedControlDeliveries,
				freshWorkspace: { workspaceId: path.basename(campaignRoot),
					restartNonce: randomBytes(16).toString("hex") },
				failedHistory: facts.resultArtifact ? { state: "unavailable",
					reason: "This reference identifies the last authenticated carry run's encrypted result, which this runner cannot decrypt. Any later executed run without a carry is a separate unquantified, unresolved gap. Retained research-history files are unselected development evidence; only the authenticated currently selected candidate is selected.",
					immutableArtifactRef: facts.resultArtifact.immutableRef,
					digestScope: facts.resultArtifact.digestScope,
					artifactSha256: facts.resultArtifact.sha256 } : {
					state: "result-unavailable", reason: "The last authenticated carry is available, but its separate encrypted result artifact is unavailable. Historical research remains untrusted; continue only from the revalidated selected tuple without replay.",
					carrySource: facts.source, carryEnvelopeSha256: facts.envelopeSha256 } }, {
				authenticatedFacts: proof => proof === priorProof ? authenticatedHistoricalCarryFacts(proof, previousBundle) : undefined,
				reviewEffects: async (authenticated, operationRefs, unobservedControlDeliveries) =>
					reviewPrivateCampaignRestartEffects({ facts: authenticated, operationRefs,
						unobservedControlDeliveries,
						privateBundle: previousBundle, proof: priorProof,
						authenticatedControlDeliveries: (proof, bundle, value) =>
							proof === priorProof && bundle === previousBundle &&
							missionLedger.authenticatedUnobservedControlDeliveries(value),
						authenticatedBundle: authenticatedPriorCarryBindsBundle,
							bindsAncestor: authenticatedPriorCarryBindsAncestor }),
				revalidateSelection: async ({ privateBundle, checkpoint, tupleSha256 }) => {
					if (privateBundle !== previousBundle || checkpoint.contract.id !== originalObjective.id ||
						statusPriorSelectedValidation !== "passed") fail("selected prior tuple was not freshly validated");
					return { status: "passed", contractId: originalObjective.id,
						selectedRunId: selectedSeed.archive.goalRunId, selectedTaskId: selectedSeed.archive.taskId,
						tupleSha256, currentValidationSha256: priorSelectedValidationSha256 };
				},
				commitOneUse: async receipt => {
					const claim = await missionLedger.claimOneUse(receipt.prior.envelopeSha256);
					const receiptRef = "independent-restart-quarantine.json";
					await appendRestartReservation(outputDir, previousBundle, receipt, claim);
					return { receiptRef, receiptSha256: sha256(JSON.stringify(receipt)), claim };
				},
			});
			historicalUnresolvedOperationIds = reservedCanonicalOperationRefs(previousCheckpoint, restartReservation);
			const gapFile = path.join(priorSeedDir, "prior-history-gap.json");
			await writeFile(gapFile, `${JSON.stringify(historicalGapEvidence(facts,
				missionLedger.opaqueExecutedRuns, Boolean(previousBundle["research-history.json"]),
				missionLedger.unobservedControlDeliveries), null, 2)}\n`,
				{ mode: 0o600 });
			priorSeedInputs.push("objective-seeds/prior-history-gap.json");
		}
		let archivedImport: ReturnType<typeof validateArchivedM07Import> | undefined;
		const bindRestartFirstGoal = restartReservation ? createOneUseRestartGoalBinder<BoundIndependentRestartGoal>(
			async goalRunId => {
				return bindIndependentRestartGoal(restartReservation, goalRunId, async binding => {
					const bindingRef = "independent-restart-goal-binding.json";
					await appendRestartGoalBinding(outputDir, previousBundle, binding);
					return { bindingRef, bindingSha256: sha256(JSON.stringify(binding)) };
				});
			}) : undefined;
		statusPhase = "source-and-isolation-preflight-passed";
		statusPhase = "model-route-setup";
		const profile = path.join(campaignRoot, "profile");
		await mkdir(profile, { mode: 0o700 });
		const modelsPath = path.join(profile, "models.json");
		const models = { providers: { deepseek: { models: [{ id: "deepseek-flash", name: "DeepSeek Flash",
			api: "openai-completions", baseUrl: "https://api.deepseek.com", reasoning: true, input: ["text"],
			cost: { input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0 },
			contextWindow: providerOutputLimit.contextWindow,
			maxTokens: providerOutputLimit.maxOutputTokens,
			compat: { supportsStore: false, supportsDeveloperRole: false, maxTokensField: "max_tokens",
				requiresReasoningContentOnAssistantMessages: true, thinkingFormat: "deepseek" },
			thinkingLevelMap: { low: "low", high: "high", max: "max" },
		}] } } };
		await writeFile(modelsPath, JSON.stringify(models), { mode: 0o600 });
		const runtime = await ModelRuntime.create({ modelsPath, authPath: path.join(profile, "auth.json"),
			modelsStorePath: path.join(profile, "models-store.json"), allowModelNetwork: false, refreshOnCreate: false });
		await runtime.setRuntimeApiKey("deepseek", runtimeKey);
		statusAuthSource = runtime.getProviderAuthStatus("deepseek").source === "runtime" ? "runtime" : "unexpected";
		if (statusAuthSource !== "runtime") fail("SDK runtime credential source did not verify");
		const resolved = runtime.getModel("deepseek", "deepseek-flash");
		if (resolved?.provider !== "deepseek" || resolved.id !== "deepseek-flash" ||
			resolved.api !== "openai-completions" || resolved.baseUrl !== "https://api.deepseek.com") fail("unexpected model route");
		statusSdkAuthMatch = (await runtime.getAuth(resolved))?.auth.apiKey === runtimeKey;
		if (!statusSdkAuthMatch) fail("SDK model credential resolution did not verify");
		const abort = new AbortController();
		const cancel = () => { campaignCancelled = true; abort.abort(); };
		process.once("SIGINT", cancel);
		process.once("SIGTERM", cancel);
		try {
			const actual = createPiSessionRunner({ modelRuntime: runtime, signal: abort.signal,
				campaignBudget: budget,
				onCampaignAccountingBoundary: (event, audit) => recordIncrementalPrefix(event, audit),
				sanitizePrivateProviderError: value => privateProviderErrorField(value, runtimeKey) });
			const observeCampaignTransport = (handle: SessionHandle): SessionHandle =>
				observeTransport(handle, statusTransportDiagnostics);
			const recordSessionEffect = async (requested: SessionSpec, handle: SessionHandle): Promise<void> => {
				if (sessionEffects.has(handle.ref.id)) fail("duplicate private session effect identity");
				if (requested.tools.kind === "execution") {
					const taskId = /^M07-(T\d{3,})$/.exec(requested.label)?.[1];
					const grant = await actual.attestConfinedGrant(handle);
					if (!taskId || !grant || grant.kind !== "confined-campaign-files" ||
						grant.root !== await realpath(requested.tools.root) ||
						JSON.stringify(grant.writableFiles) !== JSON.stringify(["candidate.cpp", "lesson-delta.json",
							...(registeredScopeActive ? ["experiment-plan.json"] : [])].sort()))
						fail("M07 execution session lacks the live factory-confined file grant");
					sessionEffects.set(handle.ref.id, { sessionId: handle.ref.id, grantKind: "confined-execution",
						taskId, workRoot: grant.root, grant });
				} else if (requested.tools.kind === "none") {
					sessionEffects.set(handle.ref.id, { sessionId: handle.ref.id, grantKind: "none" });
				} else if (requested.tools.kind === "read-dir" && !requested.tools.extraTools?.length) {
					sessionEffects.set(handle.ref.id, { sessionId: handle.ref.id, grantKind: "read-dir" });
				} else fail("private session received an unreviewed tool grant");
			};
			let followOnPriorCandidate = path.join(priorSeedDir, "prior-candidate.cpp");
			let followOnPriorPlanFile: string | undefined = previousBundle["experiment-plan.json"] ? path.join(priorSeedDir, "prior-experiment-plan.json") : undefined;
			let registeredScopeActive = false;
			let exactImportSource: { candidate: string; plan?: string } | undefined;
			const remeasurePrior = async (priorSource: string, priorPlanFile: string | undefined,
				registered: boolean, currentPlanFile: string): Promise<Record<string, unknown>> => {
				const scratch = await verifierScratch("candidate");
				try {
					if (!registered) return await checkCandidate(originalPath, priorSource, scratch);
					const plan = JSON.parse(await readFile(currentPlanFile, "utf8")) as CsrExperimentPlan;
					const oldStrategies = priorPlanFile ? (JSON.parse(await readFile(priorPlanFile, "utf8")) as CsrExperimentPlan).registeredStrategies :
						inspectCsrTaskContract(originalText, registeredTaskText).originalTargets;
					const matchedPlanFile = path.join(scratch, "prior-matched-plan.json");
					await writeFile(matchedPlanFile, JSON.stringify({ registeredStrategies: oldStrategies, cases: plan.cases }), { mode: 0o600 });
					return await checkCandidate(originalPath, priorSource, scratch,
						{ taskText: registeredTaskText, planFile: matchedPlanFile });
				} catch { return { status: "failed", reason: "prior source could not be revalidated under the current model-authored plan" }; }
				finally { await rm(scratch, { recursive: true, force: true }); }
			};
			const confinedSpec = async (spec: SessionSpec): Promise<SessionSpec> => {
				if (spec.tools.kind !== "execution") return spec;
				if (!/^M07-T\d+$/.test(spec.label)) fail("unexpected execution session");
				const tools = await createConfinedCampaignFileTools(spec.tools.root,
					{ writableFiles: registeredScopeActive ? ["candidate.cpp", "lesson-delta.json", "experiment-plan.json"] :
						["candidate.cpp", "lesson-delta.json"] });
				return { ...spec, tools: { kind: "custom", tools } };
			};
			const checkedHandle = (handle: SessionHandle, workDir: string, registered: boolean): SessionHandle => ({
				...handle, prompt: async (message: string) => {
						const candidate = path.join(workDir, "candidate.cpp");
						const verification = path.join(workDir, "verification.json");
						const planFile = path.join(workDir, "experiment-plan.json");
						const previousPhase = statusPhase;
						const turn = await runMeasuredEvidenceHandoff({ handle,
							implementationPrompt: message, sourceFile: candidate, evidenceFile: verification,
							...(registered ? { frozenSourceFiles: [planFile] } : {}),
							measure: async () => {
								statusPhase = "host-verification";
								let result: Record<string, unknown> = { version: 1, status: "failed", reason: "candidate missing" };
								if (existsSync(candidate)) {
									const exactCopy = !exactImportSource ||
										(await readFile(candidate, "utf8")) === exactImportSource.candidate &&
										(!registered || Boolean(exactImportSource.plan) && existsSync(planFile) &&
											(await readFile(planFile, "utf8")) === exactImportSource.plan);
									if (!exactCopy) result = { version: 1, status: "failed",
										reason: "provenance import source or plan differs from authenticated carried bytes" };
									else {
										const candidateScratch = await verifierScratch("candidate");
										try { result = await checkCandidate(originalPath, candidate, candidateScratch,
											registered ? { taskText: registeredTaskText, planFile } : undefined); }
										finally { await rm(candidateScratch, { recursive: true, force: true }); }
									}
								}
								result.originalBaselineRuns = originalSmoke.originalCheckerRuns;
								result.originalBaselineIndependent = {
									status: (originalSmoke.independent as { status?: string }).status,
									timings: (originalSmoke.independent as { timings?: TrustedTiming[] }).timings,
								};
								result.originalHostComparison = compareCandidateTimings(originalSmoke, result);
								if (!registered && result.status === "passed" && (result.originalHostComparison as { state?: string }).state !== "measured")
									result.status = "failed";
								if (result.status === "passed") {
									const measuredPrior = await remeasurePrior(followOnPriorCandidate, followOnPriorPlanFile, registered, planFile);
									result.priorCandidateComparison = compareCandidateTimings(measuredPrior, result);
									result.priorCandidateTimingEvidence = { status: measuredPrior.status,
										remeasuredOnCurrentHost: measuredPrior.status === "passed", historicalTimingUsed: false,
										independent: measuredPrior.independent, registeredExperiment: measuredPrior.registeredExperiment };
								}
								const compile = result.compile as Record<string, unknown> | undefined;
								const measured = result.registeredExperiment as Record<string, unknown> | undefined;
								const shape = result.sourceShape as Record<string, unknown> | undefined;
								const measurementRan = Array.isArray(measured?.timings) && measured.timings.length > 0;
								result.hostFeedback = { version: 1, kind: "execution-result-feedback", status: result.status,
									observedEnvironment: result.environment, sourceBoundary: shape,
									...(registeredContract?.threadPolicy ? { threadPolicy: registeredContract.threadPolicy } : {}),
									measurementMetric: registered ? (measurementRan ? measured?.metric ?? "not_run" : "not_run") : "legacy-diagnostic-only",
									timingInterpretation: registered ? (measurementRan ?
										"Parent-clocked persistent-worker roundtrip, including IPC and kernel work. Startup and cold-call costs are separate. This is not kernel-only time." :
										"No registered candidate timing was run; original baseline timings are separate in-process reference observations.") : "Historical diagnostic protocol",
									diagnostics: [compile?.success === false ? { phase: "compile", message: compile.stderrTail ?? "No candidate compiled" } : undefined,
										shape?.diagnostic ? { phase: "source-boundary", detail: shape.diagnostic } : undefined,
										measured?.status !== "passed" ? { phase: "independent-validation", message: measured?.stderrTail ?? measured?.reason ?? result.reason ?? "Candidate or plan unavailable" } : undefined,
										...(Array.isArray(measured?.executionFailures) ? measured.executionFailures : [])].filter(Boolean),
									interpretation: "Measurements and diagnostics are task feedback. Finite passing checks do not prove exhaustive correctness, strongest possible performance, or completion." };
								await writeFile(verification, JSON.stringify(result, null, 2), { mode: 0o600 });
							},
							finalizationPrompt: "Evidence-finalization phase for this same M07 task. The host just measured the current candidate and wrote verification.json. Use the read tool to read the complete current verification.json before making claims; earlier reports and measurements may describe a different candidate or timing run. You may read candidate.cpp and lesson-delta.json, and update only lesson-delta.json. Do not write or edit candidate.cpp, experiment-plan.json or verification.json. Report the exact current measured facts, including shape-dependent winners, regressions and limitations, without inventing or reusing stale numbers. The lesson-delta.json schema is version 1 with action none, propose, amend or contradict and an evidencePaths array of at most 20 relative task paths. A proposal needs a nonempty observation and applicability and at least one evidence path such as verification.json. Amend or contradict additionally requires an exact pinned priorRef with storeId, recordId and integer version; if no such adopted prior record is available, use propose or none. None can use an empty evidencePaths array. This is only a pending lesson candidate; do not claim M04 adoption. Return structured execution feedback for the fresh reviewer as strict JSON with version 1, status, observations, limitations, nextStep and evidenceRefs. Cite decisive current measured values and concrete failures; do not copy the full verification file or create a prose deliverable. Do not describe isolated-worker roundtrip timings as kernel-only timings. No code changes.",
							readToolName: "read", onFinalization: () => { statusPhase = "evidence-finalization"; },
						});
						statusPhase = previousPhase;
						return turn;
					},
			});
			const runner: SessionRunner = {
				capabilities: () => actual.capabilities(),
				attestConfinedGrant: handle => actual.attestConfinedGrant(handle),
				create: async spec => {
					const transformed = await confinedSpec(spec);
					const handle = await actual.create(transformed);
					try { await recordSessionEffect(spec, handle); }
					catch (error) { handle.dispose(); throw error; }
					const observed = observeCampaignTransport(handle);
					return spec.tools.kind === "execution" ? checkedHandle(observed, spec.tools.root, registeredScopeActive) : observed;
				},
				checkpoint: (handle, envelope) => actual.checkpoint(handle, envelope),
				fork: async request => {
					const transformed = await confinedSpec(request.spec);
					const handle = await actual.fork({ ...request, spec: transformed });
					try { await recordSessionEffect(request.spec, handle); }
					catch (error) { handle.dispose(); throw error; }
				const observed = observeCampaignTransport(handle);
				return request.spec.tools.kind === "execution" ? checkedHandle(observed, request.spec.tools.root, registeredScopeActive) : observed;
				},
				resume: async ref => {
					const handle = await actual.resume(ref);
					const known = sessionEffects.get(handle.ref.id);
					if (!known) {
						handle.dispose();
						fail("resumed private session has no current host effect authority");
					}
					if (known.grantKind === "confined-execution") {
						const grant = await actual.attestConfinedGrant(handle);
						if (!grant || JSON.stringify(grant) !== JSON.stringify(known.grant) || !known.workRoot) {
							handle.dispose();
							fail("resumed M07 session lost its factory-confined grant");
						}
						return checkedHandle(observeCampaignTransport(handle), known.workRoot,
							grant.writableFiles.includes("experiment-plan.json"));
					}
					return observeCampaignTransport(handle);
				},
			};
			// A disputed historical M04 transaction is never imported or replayed.
			// Fresh work is allowed only with a newly isolated, empty current store,
			// no prior session identity, and the already revalidated old selection.
			await verifiedFreshBoundary();
			const m04Quarantine: M04TransactionQuarantineV1 | undefined =
				freshOnlyM04Quarantine ?? inheritedM04Quarantine;
			if (m04Quarantine) {
				await writeFile(path.join(outputDir, M04_TRANSACTION_QUARANTINE_FILE),
					`${JSON.stringify(m04Quarantine, null, 2)}\n`, { mode: 0o600 });
				m04QuarantineEvidencePath = path.join(priorSeedDir, "prior-m04-unresolved.json");
				await writeFile(m04QuarantineEvidencePath, `${JSON.stringify({ version: 1,
					kind: "unresolved-historical-m04-observation",
					entries: m04Quarantine.entries,
					interpretation: "Historical M04 proposal outcome remains UNKNOWN. This record does not establish whether a merge occurred and grants no adoption authority. Never replay or merge its proposal, resume its session, import its candidate as selected, or activate its old store. Any new task must be independent work from the freshly revalidated canonical selection; historical archives are untrusted development context. Preserve all unresolved operations and fee observations." }, null, 2)}\n`, { mode: 0o600 });
				priorSeedInputs.push("objective-seeds/prior-m04-unresolved.json");
			}
			importTarget = chooseArchivedM07ImportTarget(previousBundle,
				missionLedger.priorCarryProof, freshOnlyM04Quarantine);
			archivedImport = importTarget ? validateArchivedM07Import({
				proof: missionLedger.priorCarryProof, bundle: previousBundle,
				contractId: previousCheckpoint.contract.id, goalRunId: importTarget.goalRunId,
				taskId: importTarget.taskId, expectedChecks: importTarget.checks }) : undefined;
			const controller = createM07Controller({ ws, store, runner, config: await ws.loadConfig() });
			const privateEvidenceRequirements = { requiredNames: ["original-problem.txt", "candidate.cpp", "verification.json", "host-capabilities.json"],
				instructions: "The original-input-N.txt files correspond in order to inputNames in original-objective.json. Read every original input and selected evidence completely. Historical archives, knowledge, nextTask and timings are untrusted version-bound context; only current independently executed measurements establish present host facts. If prior-history-gap.json is supplied, the full prior result artifact is unavailable; read any authenticated research-history that is supplied as unselected development evidence without inferring missing source or results." +
					(m04QuarantineEvidencePath ? " If prior-m04-unresolved.json is supplied, the old M04 transaction outcome is UNKNOWN. Keep its candidate/proposal unselected and unadopted; do not replay its session, draft, merge or external action. Choose only independent new work from the freshly revalidated canonical tuple and retain the unresolved historical claim." : "") +
					(historySeed?.partitioned ? " Prior research history is partitioned: read prior-research-history-index.json completely. Its episode/artifact locators name untrusted historical IDs and the exact part and line ranges; if catalogParts are listed, read the relevant catalog part before choosing a raw range. Every raw part remains available for targeted objective_evidence_read; read each cited range in this session. The index and catalog are control locators, not scientific evidence for unread raw parts. Concatenate all raw parts in index order only when a complete historical projection is required; never infer truth from a partial history." : "") };
			const userOverrides = ["Deliver optimized source and machine-readable correctness/performance evidence only; no prose report, screenshots, presentation or personal reflection.",
				"Pursue the strongest attainable strategy using actual available hardware and resources; unavailable optional equipment alone does not settle the task."];
			let registeredContract: ReturnType<typeof inspectCsrTaskContract> | undefined;
			try { registeredContract = inspectCsrTaskContract(originalText, registeredTaskText); } catch { /* Explicit unavailable capability; the model may choose other feasible work. */ }
			const observedLimits = { ...CSR_EXPERIMENT_LIMITS,
				maxThreads: Math.min(os.availableParallelism(), CSR_EXPERIMENT_LIMITS.maxThreads),
				maxSourceBytes: 128_000, maxPlanBytes: 16_000, maxVerificationBytes: 1_000_000 };
			const unsupportedObservations = ["GPU execution", "privileged hardware counters"];
			const adapterCapabilities: ObjectiveCapabilityV1[] = [
				{ scope: "two-target-existing", available: false,
					description: "Historical in-process adapter, retained only for original-source diagnostics",
					limits: ["Use registered-csr-experiment for fresh execution of the same original bodies or wider permitted variants; model must choose the plan"] },
				{ scope: "registered-csr-experiment", available: Boolean(registeredContract),
					description: "Model-authored registered strategies/cases with a separate independent CPU checker and per-target measurements",
					limits: [`observed CPU parallelism ${os.availableParallelism()}`,
						registeredContract?.sourceScope ?? "task contract shape is unsupported",
						"Read host-capabilities.json for the complete measured capability and allocation limits"] },
				{ scope: "outside-current-adapter", available: false,
					description: "Changes or equipment outside the verified source and measurement adapters",
					limits: ["requires a different verifier and capability proof"] },
			];
			const unavailableCapabilities = observedUnavailableCapabilities(adapterCapabilities,
				unsupportedObservations, observedLimits);
			const adapterScopes = new Set(adapterCapabilities.map(item => item.scope));
			const objectiveCapabilities: ObjectiveCapabilityV1[] = [...adapterCapabilities,
				...unavailableCapabilities.filter(item => !adapterScopes.has(item.scope))];
			const observedHost = { version: 1, kind: "observed-private-execution-capabilities",
				platform: os.platform(), architecture: os.arch(), cpuModel: os.cpus()[0]?.model ?? "unknown",
				availableParallelism: os.availableParallelism(), compiler: "/usr/bin/g++", compileFlags: FLAGS,
				registeredLimits: observedLimits,
				registeredContract: registeredContract ?? null,
				isolation: "Verified non-root uid; separate network/pid/ipc namespaces; credential-free environment; read-only evaluator binaries/source during execution and separate writable temporary scratch",
				taskTools: "Confined text-file read/write/edit only; host compiles and executes candidate separately",
				unsupported: unsupportedObservations,
				unavailableCapabilities,
				claimLimit: "Observed local capability only. Equipment absent from this descriptor is unverified, not proven unavailable. Unavailable optional equipment does not establish mission completion" };
			const observedHostText = `${JSON.stringify(observedHost, null, 2)}\n`;
			const capabilityLocators = frozenCapabilityLocators(observedHostText, unavailableCapabilities);
			const capabilityFile = path.join(priorSeedDir, "host-capabilities.json");
			await writeFile(capabilityFile, observedHostText, { mode: 0o600 });
			await copyFile(capabilityFile, path.join(outputDir, "execution-capabilities.json"));
			priorSeedInputs.push("objective-seeds/host-capabilities.json");
			const experimentInstructions = [
				"Produce experiment-plan.json with {registeredStrategies: string[], cases: [{id, rows, cols, normalNnz, longRows, longNnz, seed, threadCounts, warmups, repeats}]}.",
				"Choose every scientific strategy and case yourself from the supplied original task. Read host-capabilities.json for actual limits; those limits describe this executor, not a smaller scientific mission.",
				registeredContract?.sourceScope ?? "Registered execution is unavailable for this input shape.",
				registeredContract?.timingScope ?? "No registered measurement capability verified.",
				"Total bounded timed work is sum(nonzeros * thread-choice-count * (1 + warmups + repeats) * (registered-strategy-count + 2)). Every strategy must be registered. Retain limitations and feasible untested work in machine-readable evidence.",
			].join(" ");
			const importBoundedRuns: ObjectiveProgressV1["boundedRuns"] = [];
			const importAssessmentEvidence: Array<{ name: string; file: string }> = [];
			let provenanceImportSummary: Record<string, unknown> | undefined;
			if (archivedImport && importTarget) {
				statusPhase = "provenance-import-staging";
				// The archived accepted task is not the selected mission tuple. Keep
				// the latter byte-for-byte separate while obtaining new review evidence.
				for (const name of ["candidate.cpp", "verification.json", "workflow-archive.json",
					"experiment-plan.json", "m04-adopted-knowledge.json", "m04-transaction.json"] as const) {
					const prior = previousBundle[name];
					if (prior !== undefined) await writeFile(path.join(outputDir, name), prior, { mode: 0o600 });
					else await rm(path.join(outputDir, name), { force: true });
				}
				const staged = await stageArchivedM07Import(archivedImport, priorSeedDir);
				if (importTarget.registered !== Boolean(staged.planPath) ||
					(importTarget.registered && !registeredContract))
					fail("archived provenance import plan cannot use the current verified adapter");
				const importedInputs = [staged.candidatePath, staged.verificationPath,
					staged.provenancePath, ...(staged.planPath ? [staged.planPath] : []),
					...found.files.map(name => path.join(ws.rawDir, name)), capabilityFile];
				statusPhase = "provenance-import-m07";
				const goal = await controller.begin({
					goal: `Revalidate an archived accepted source for original objective ${originalObjective.id}`,
					problemRelation: `Fresh provenance check of archived goal ${importTarget.goalRunId}/${importTarget.taskId}; old M04 evidence was incomplete. This is not mission candidate selection.`,
					constraints: ["Copy the archived candidate byte-for-byte; do not optimize or change its strategies.",
						"The old review and lesson snapshot are unavailable as current authority; independent host verification and ordinary M07 review are required.",
						"Keep the prior selected mission source separate until an actual comparison supports replacement."],
					successCriteria: [...importTarget.checks],
					plan: "Import the exact source and optional plan, run the current host checker, freeze a new ordinary review, then request M04 adjudication of only the new evidence.",
					exploratory: true });
				runId = goal.runId;
				statusRunId = runId;
				await bindRestartFirstGoal?.(goal.runId);
				let importedTask: M07TaskRecord;
				registeredScopeActive = importTarget.registered;
				exactImportSource = { candidate: archivedImport.candidate.text,
					...(archivedImport.plan ? { plan: archivedImport.plan.text } : {}) };
				try {
					importedTask = await controller.delegate(goal.runId, {
						mode: "execute", inputs: importedInputs,
						objective: `Read the frozen work-directory input copy inputs/001-candidate.cpp and copy its complete bytes to candidate.cpp. ${staged.planPath ? "Read inputs/004-experiment-plan.json and copy its complete bytes to experiment-plan.json." : "Do not create an experiment plan."} Do not optimize or alter the archived source. Its old verification is historical context only. After the host writes a NEW verification.json, read it fully and write a NEW lesson-delta.json with action none or a precisely evidenced candidate lesson. The old lesson and review snapshot are unavailable. No scientific adoption or mission-source selection occurs here.`,
						expectedOutputs: ["candidate.cpp", "lesson-delta.json",
							...(staged.planPath ? ["experiment-plan.json"] : [])],
						lessonDeltaOutput: "lesson-delta.json", checks: importTarget.checks,
					});
				} finally { registeredScopeActive = false; exactImportSource = undefined; }
				statusTaskTelemetry = await taskTelemetry(ws, importedTask, runtimeKey);
				const candidatePath = path.join(importedTask.workDir, "candidate.cpp");
				const verificationPath = path.join(importedTask.workDir, "verification.json");
				const lessonPath = path.join(importedTask.workDir, "lesson-delta.json");
				const planPath = path.join(importedTask.workDir, "experiment-plan.json");
				const exactCandidate = existsSync(candidatePath) &&
					(await readFile(candidatePath, "utf8")) === archivedImport.candidate.text;
				const exactPlan = !archivedImport.plan || existsSync(planPath) &&
					(await readFile(planPath, "utf8")) === archivedImport.plan.text;
				let checked: Record<string, any> = {};
				try { checked = JSON.parse(await readFile(verificationPath, "utf8")); } catch { /* no host pass */ }
				const hostPassed = importedTask.status === "returned" && exactCandidate && exactPlan &&
					checked?.status === "passed" && checked?.independent?.status === "passed";
				const unsettled = unresolvedGoalControl(await controller.status(goal.runId));
				if (unsettled.operationIds.length || unsettled.taskIds.length) {
					statusPhase = "provenance-import-unsettled";
					await preserveUnsettledGoalCheckpoint({ ws, runId: goal.runId, outputDir,
						contract: originalObjective, budgetStopReason: budget.snapshot().stopReason });
					await recordIncrementalPrefix("control-observed");
					await saveStatus({ outcome: "incomplete", originalObjective: { id: originalObjective.id,
						continuation: "reconcile-operations-before-new-run" },
						provenanceImport: { state: "unsettled", sourceGoalRunId: importTarget.goalRunId,
							newGoalRunId: goal.runId, unresolvedOperationIds: unsettled.operationIds,
							unresolvedTaskIds: unsettled.taskIds } });
					process.exitCode = 1;
					return;
				}
				let reviewed: M07TaskRecord | undefined;
				if (importedTask.status === "returned" && importedTask.reportPath) {
					statusPhase = "provenance-import-review";
					reviewed = await controller.review(goal.runId, { taskId: importedTask.taskId,
						checks: importTarget.checks.map((criterion, index) => ({ criterion,
							result: hostPassed ? "passed" : "failed",
							evidence: hostPassed ? [index === 0 ? candidatePath : verificationPath] : [] })),
						artifacts: [importedTask.reportPath, ...[candidatePath, verificationPath, lessonPath,
							...(staged.planPath ? [planPath] : [])].filter(existsSync)],
						failures: hostPassed ? [] : ["Current host did not independently verify an exact import of the archived candidate and plan"] });
				}
				const accepted = reviewed?.status === "accepted";
				const finished = await controller.finish(goal.runId, { outcome: accepted ? "fulfilled" : "partial",
					returnPath: "user", summary: accepted ?
						"Exact archived source independently revalidated and newly reviewed; mission selection remains unchanged." :
						"Archived source import did not pass exact-copy and ordinary current review gates.",
						goalChecks: importTarget.checks.map((criterion, index) => ({ criterion,
							result: accepted ? "passed" : "not_run",
							evidence: accepted ? [index === 0 ? candidatePath : verificationPath] : [] })),
						limitations: ["Historical lesson and review snapshot were not transported as current authority; the prior selected mission candidate was not replaced."] });
				const archiveDir = path.join(campaignRoot, "provenance-import-archive");
				await archivePrivateM07Task({ goal: finished, task: finished.tasks[0], destination: archiveDir });
				let m04Status: "not-run" | "completed" | "failed" = "not-run";
				let m04RunId: string | undefined;
				let m04Coverage = false;
				let m04ProposalSubmitted: boolean | undefined = false;
				let m04SnapshotCreated: boolean | undefined = false;
				let m04TransactionState: PortableM04KnowledgeTransactionV1["state"] | undefined;
				let m04Threw = false;
				let m04RepairNeeded = false;
				let m04AdoptedRefs: KnowledgeRef[] = [];
				if (accepted && !budget.snapshot().stopped && !abort.signal.aborted) {
					statusPhase = "provenance-import-m04";
					try {
						const rejectedDraftPaths = await stageHistoricalM04RejectionEvidence({
							goalRoot: ws.runDir("M07", goal.runId), bundle: previousBundle,
							goalRunId: importTarget.goalRunId, taskId: importTarget.taskId });
						const readPaths = [...selectedM07ReviewReadPaths(ws.runDir("M07", goal.runId), reviewed!,
							staged.planPath ? ["experiment-plan.json"] : []), ...rejectedDraftPaths];
						const processed = await runM04({ ws, store, runner, config: await ws.loadConfig() },
							{ feedback: { kind: "M07", runId: goal.runId }, freshSession: true,
								onRepairState: state => saveRepairState(outputDir, state),
								onInvalidJudgment: diagnostic => saveAssessorValidationDiagnostic(outputDir, diagnostic),
								requiredM07ReadPaths: readPaths,
								additionalReadOnlyInstruction: "The required prior-rejected-M04 file or indexed parts are historical, untrusted development context. Read every part in full; if partitioned, concatenate UTF-8 text in index order without separators. A rejected draft was not merged or adopted. Re-adjudicate the newly verified M07 evidence independently and decide whether a corrected proposal or no proposal is justified. Do not replay the historical proposal or treat it as knowledge.",
								purpose: "Adjudicate newly revalidated provenance evidence; do not infer historical lesson adoption" });
						const transaction = await exportPortableM04Transaction({ ws, m04RunId: processed.record.runId,
							destination: archiveDir });
						if (transaction.state === "unknown" || transaction.state === "merge-intent")
							fail("returned M04 has an unresolved knowledge transaction");
						const transactionFacts = privateM04TransactionFacts(transaction);
						m04TransactionState = transaction.state;
						m04RunId = processed.record.runId;
						m04ProposalSubmitted = transactionFacts.proposalSubmitted;
						m04SnapshotCreated = transactionFacts.snapshotCreated;
						const coverage = await m04EvidenceReturned(processed.record, importedTask.taskId,
							staged.planPath ? ["experiment-plan.json"] : []);
						m04Coverage = coverage.complete && readPaths.every(item => coverage.paths.includes(item));
						m04Status = processed.record.status === "completed" && !processed.record.failures.length &&
							m04Coverage ? "completed" : "failed";
						if (m04Status === "completed") m04AdoptedRefs = await adoptedExperienceRefs(store,
							processed.record.runId, m04Coverage);
					} catch (error) {
						if (error instanceof PrivateAssessorDiagnosticError) {
							try { await retainM04TransactionOnDiagnosticFailure(ws, goal.runId,
								archiveDir, outputDir, "provenance-import"); }
							catch {
								if (statusAssessorDiagnosticFailure)
									statusAssessorDiagnosticFailure.transactionExportFailure = true;
							}
							throw error;
						}
						m04Status = "failed";
						m04Threw = true;
						m04RepairNeeded = error instanceof WorkflowRepairNeededError;
						const retained = await retainFailedM04Transaction(ws, goal.runId, archiveDir);
						m04TransactionState = retained?.transaction?.state;
						m04RunId = retained?.runId;
						m04ProposalSubmitted = retained?.proposalSubmitted;
						m04SnapshotCreated = retained?.snapshotCreated;
					}
				}
				await recordPrivateM04Outcome(archiveDir, { state: m04Status,
					...(m04RunId ? { runId: m04RunId } : {}), proposalSubmitted: m04ProposalSubmitted,
					snapshotCreated: m04SnapshotCreated, adoptedExperienceRefs: m04AdoptedRefs }, store);
				const m04EffectDisposition = importM04EffectDisposition({ status: m04Status,
					proposalSubmitted: m04ProposalSubmitted, snapshotCreated: m04SnapshotCreated,
					...(m04TransactionState ? { transactionState: m04TransactionState } : {}),
					threw: m04Threw, repairNeeded: m04RepairNeeded });
				// Export only after recording final M04 state. The canonical tuple above
				// remains the earlier selected candidate until a later real comparison.
				await exportPrefixedArchive(archiveDir, outputDir, "provenance-import");
				importBoundedRuns.push({ runId: goal.runId, outcome: finished.outcome ?? "partial",
					acceptedTaskIds: accepted ? [importedTask.taskId] : [],
					...(accepted ? { selectedTaskId: importedTask.taskId } : {}) });
				const importSummary = path.join(priorSeedDir, "provenance-import-result.json");
				provenanceImportSummary = { version: 1,
					kind: "provenance-import-result", historicalGoalRunId: importTarget.goalRunId,
					newGoalRunId: goal.runId, taskId: importedTask.taskId,
					m07Outcome: finished.outcome, m04Status, m04Coverage,
					m04EffectDisposition,
					missionSelectionAtImport: "unchanged-prior", historicalLessonAuthority: "unavailable",
					historicalReviewSnapshotAuthority: "unavailable" };
				await writeFile(importSummary, `${JSON.stringify(provenanceImportSummary, null, 2)}\n`,
					{ mode: 0o600 });
				if (m04EffectDisposition !== "continue") {
					statusPhase = m04EffectDisposition;
					await writeCurrentObjectiveProgress(campaignObjectiveProgress(
						originalObjective, historicalUnresolvedOperationIds, {
							boundedRuns: [...previousCheckpoint.boundedRuns, ...importBoundedRuns],
							selectedArtifacts: previousCheckpoint.selectedArtifacts,
							assessmentHistory: previousCheckpoint.assessmentHistory,
							stopReason: failedM04StopReason(m04Status === "not-run" ? "not_run" : m04Status,
								m04TransactionState, m04RepairNeeded),
							...(m04RepairNeeded ? { pendingActionFacts: workflowRepairActionFacts("m04-judgment") } : {}) }));
					await saveStatus({ outcome: "incomplete", provenanceImport: provenanceImportSummary,
						originalObjective: { id: originalObjective.id,
							stopReason: failedM04StopReason(m04Status === "not-run" ? "not_run" : m04Status,
								m04TransactionState, m04RepairNeeded), checkpointFile: "objective-checkpoint.json" },
						blocker: m04EffectDisposition,
						independentValidation: "prior selected source retained; M04 transaction needs reconciliation" });
					process.exitCode = 1;
					return;
				}
				importAssessmentEvidence.push({ name: "provenance-import-result.json", file: importSummary });
				const reviewDecision = path.join(archiveDir, "review-decision.json");
				if (existsSync(reviewDecision))
					importAssessmentEvidence.push({ name: "provenance-import-review-decision.json",
						file: reviewDecision });
				if (m04RunId) {
					const m04Run = await ws.readRun("M04", m04RunId);
					for (const [label, name] of [["处理结果", "provenance-import-m04-processing.md"],
						["M07 回流证据实际访问范围", "provenance-import-m04-coverage.json"]] as const) {
						const item = m04Run.outputs.find(output => output.label === label);
						if (item && existsSync(item.path))
							importAssessmentEvidence.push({ name, file: item.path });
					}
				}
				statusPhase = "provenance-import-assessment-ready";
			}

			const priorReceipts = previousBundle["objective-assessment-receipts.json"] ?
				JSON.parse(previousBundle["objective-assessment-receipts.json"]) : undefined;
			const objectiveReceipts: Array<Record<string, unknown>> = Array.isArray(priorReceipts?.receipts) ? [...priorReceipts.receipts] : [];
			const persistObjectiveReceipt = async (record: StageRunRecord) => {
				await ws.writeRun(record);
				const receipt = { version: 1, kind: "m07-original-objective-assessment", runId: record.runId,
					status: record.status, sessions: record.sessions.map(item => ({ sessionId: item.id, role: item.role,
						model: item.model, boundaryMode: item.boundary?.mode ?? "unknown",
						boundaryIntent: item.boundary?.intent ?? "unknown", toolGrantKind: item.boundary?.toolGrantKind ?? "unknown",
						evidenceLabels: item.boundary?.evidence.map(entry => entry.label) ?? [] })) };
				const index = objectiveReceipts.findIndex(item => item.runId === record.runId);
				if (index >= 0) objectiveReceipts[index] = receipt; else objectiveReceipts.push(receipt);
				await writeFile(path.join(outputDir, "objective-assessment-receipt.json"), JSON.stringify(receipt, null, 2), { mode: 0o600 });
				await writeFile(path.join(outputDir, "objective-assessment-receipts.json"), JSON.stringify({ version: 1,
					kind: "m07-original-objective-assessment-receipts", receipts: objectiveReceipts }, null, 2), { mode: 0o600 });
			};
			const firstAssessmentRecord = await ws.startRun("M07Objective", [
				{ label: "Unchanged original objective", path: objectiveContractFile },
				{ label: "Prior selected source", path: path.join(priorSeedDir, "prior-candidate.cpp") },
				{ label: "Prior selected verification", path: path.join(priorSeedDir, "prior-verification.json") },
			]);
			const priorEvidence = [
				{ name: "host-capabilities.json", file: capabilityFile },
				...(restartReservation ? [{ name: "prior-history-gap.json",
					file: path.join(priorSeedDir, "prior-history-gap.json") }] : []),
				...(historySeed?.evidence ?? []),
				{ name: "original-problem.txt", file: ws.problemFile },
				...found.files.map((name, index) => ({ name: `original-input-${index + 1}.txt`, file: path.join(ws.rawDir, name) })),
				{ name: "candidate.cpp", file: path.join(priorSeedDir, "prior-candidate.cpp") },
				{ name: "verification.json", file: path.join(priorSeedDir, "prior-verification.json") },
				{ name: "workflow-archive.json", file: path.join(priorSeedDir, "prior-archive.json") },
				{ name: "prior-objective-checkpoint.json", file: path.join(priorSeedDir, "prior-objective-checkpoint.json") },
				...(previousBundle["m04-adopted-knowledge.json"] ? [{ name: "m04-knowledge.json",
					file: path.join(priorSeedDir, "prior-m04-knowledge.json") }] : []),
				...(previousBundle["experiment-plan.json"] ? [{ name: "experiment-plan.json",
					file: path.join(priorSeedDir, "prior-experiment-plan.json") }] : []),
				...(historicalM04IndexPath ? [{ name: "historical-m04-evidence-index.json",
					file: historicalM04IndexPath }] : []),
				...(priorTransportObservationPath ? [{ name: "prior-transport-observation.json",
					file: priorTransportObservationPath }] : []),
				...(m04QuarantineEvidencePath ? [{ name: "prior-m04-unresolved.json",
					file: m04QuarantineEvidencePath }] : []),
				...importAssessmentEvidence,
			];
			const priorGroundingBase = assessorGroundingPolicy(priorEvidence, previousCheckpoint);
			const priorGrounding = await stagePriorGroundingRecords(
				path.join(campaignRoot, "prior-grounding-evidence"), priorGroundingBase);
			priorEvidence.push(...priorGrounding.evidence);
			const priorGroundingPolicy = { ...assessorGroundingPolicy(priorEvidence, previousCheckpoint),
				priorGroundingIndex: priorGrounding.priorGroundingIndex, capabilityLocators };
			if (previousBundle["m04-adopted-knowledge.json"])
				await writeFile(path.join(priorSeedDir, "prior-m04-knowledge.json"), previousBundle["m04-adopted-knowledge.json"], { mode: 0o600 });
			statusPhase = "prior-objective-assessment";
			const firstAssessmentDiagnosticStart = statusTransportDiagnostics.length;
			const firstStep = await assessAndAdvanceOriginalObjective({
				contract: originalObjective, contractFile: objectiveContractFile, runner,
				recordRepairState: state => saveRepairState(outputDir, state),
				recordValidationFailure: diagnostic => saveAssessorValidationDiagnostic(outputDir, diagnostic),
				runRecord: firstAssessmentRecord, persistReceipt: () => persistObjectiveReceipt(firstAssessmentRecord),
				sessionSpec: { label: "M07-prior-objective-assessment", role: "research", model: MODEL,
					systemPrompt: "Assess the unchanged user objective and all frozen prior evidence. Choose the next scientific work yourself under observed host capabilities. Read every supplied original input and selected evidence before deciding; report uncertainty honestly.",
					persistDir: ws.sessionsDir },
				evidenceRoot: path.join(campaignRoot, "prior-objective-evidence"), evidence: priorEvidence,
				groundingPolicy: priorGroundingPolicy,
				evidenceAccess: assessorEvidenceAccess(priorEvidence),
				evidenceRequirements: privateEvidenceRequirements,
				assessmentAdmission: budget.snapshot().stopped ? campaignObjectiveStop(budget.snapshot().stopReason) ?? "assessment-failed" :
					abort.signal.aborted ? "cancelled" : "admitted",
				advanceAdmission: () => budget.snapshot().stopped ? campaignObjectiveStop(budget.snapshot().stopReason) ??
					"assessment-failed" : abort.signal.aborted ? "cancelled" : "admitted",
				supportedTaskScopes: [...OBJECTIVE_SUPPORTED_TASK_SCOPES],
				capabilities: objectiveCapabilities, userOverrides,
				recordAssessment: async assessment => {
					await writeCurrentObjectiveProgress(campaignObjectiveProgress(originalObjective,
						historicalUnresolvedOperationIds, {
						boundedRuns: [...previousCheckpoint.boundedRuns, ...importBoundedRuns],
						selectedArtifacts: previousCheckpoint.selectedArtifacts,
						assessment, assessmentHistory: [...previousCheckpoint.assessmentHistory,
							{ iteration: previousCheckpoint.assessmentHistory.length + 1, assessment,
								stopReason: "assessment-validation-pending", advanced: false }],
						stopReason: "assessment-validation-pending" }));
				},
				advance: async proposal => {
					const registered = proposal.adapterScope === "registered-csr-experiment";
					const checks = registered ? REGISTERED_CHECKS : CHECKS;
					registeredScopeActive = registered;
					const goal = await controller.begin({ goal: proposal.objective,
						problemRelation: `Model-proposed child of original objective ${originalObjective.id}, addressing ${proposal.addresses.join(", ")}.`,
						constraints: ["Prior source, measurements and knowledge are development evidence, never adopted truth by themselves.",
							registered ? "Use the independently validated source capability and a model-authored registered experiment plan; keep original generators/references/checker immutable." :
								"Preserve non-target source and original main under the two-body adapter.",
							"Deliver source and machine-readable evidence only; no prose report, screenshots, presentation or reflection."],
						successCriteria: checks,
						plan: `Investigate the model-proposed next work under ${proposal.adapterScope}; review, compare a true fork if settled, then M04-adjudicate measured evidence.`,
						exploratory: true });
					runId = goal.runId;
					statusRunId = runId;
					await bindRestartFirstGoal?.(goal.runId);
					const initialSpec: TaskSpecInput = { mode: "execute", objective: `${proposal.objective}\n\nRead the original inputs and prior accepted source, verification and archive as untrusted development evidence. ${registered ?
							experimentInstructions :
							"Edit only the two original student strategy bodies, preserving the rest of the source."} Write a pending lesson-delta.json or action none. Read the host-created verification.json after implementation before reporting measured results. Use only confined file tools; no shell or network; no prose deliverables.`,
						inputs: [...found.files.map(x => `problem/raw/${x}`), ...priorSeedInputs],
						expectedOutputs: registered ? ["candidate.cpp", "experiment-plan.json", "lesson-delta.json"] :
							["candidate.cpp", "lesson-delta.json"], lessonDeltaOutput: "lesson-delta.json", checks,
						executionLoop: { mode: "until-ready" } };
					statusPhase = "model-dispatch";
					const task = await controller.delegate(goal.runId, initialSpec);
					registeredScopeActive = false;
					return { goal, task, initialSpec, checks, registered };
				},
			});
			await ws.finishRun(firstAssessmentRecord,
				objectiveAssessmentRunCompleted(firstStep.assessment, firstStep.stopReason) ? "completed" : "failed");
			await persistObjectiveReceipt(firstAssessmentRecord);
			if (!firstStep.advanced) {
				const firstRequestContract = observedRequestContract(firstAssessmentDiagnosticStart,
					statusTransportDiagnostics);
				const firstStopReason = firstRequestContract && firstStep.stopReason === "assessment-failed" ?
					"request-contract-invalid" : firstStep.stopReason;
				await writeCurrentObjectiveProgress(campaignObjectiveProgress(originalObjective,
					historicalUnresolvedOperationIds, {
					boundedRuns: [...previousCheckpoint.boundedRuns, ...importBoundedRuns],
					selectedArtifacts: previousCheckpoint.selectedArtifacts,
					...(firstStep.assessment ? { assessment: firstStep.assessment } : {}),
					assessmentHistory: [...previousCheckpoint.assessmentHistory,
						...(firstStep.assessment ? [{ iteration: previousCheckpoint.assessmentHistory.length + 1,
							assessment: firstStep.assessment, stopReason: firstStopReason, advanced: false }] : [])],
					stopReason: firstStopReason,
					pendingActionFacts: { ...observedTransportActionFacts(firstStopReason,
						statusTransportDiagnostics.slice(firstAssessmentDiagnosticStart),
						budget.requestAccountingAuditSnapshot(),
						"read-only-assessor"),
						...(firstStopReason === "workflow-repair-needed" ?
							workflowRepairActionFacts("objective-assessment") : {}),
						...(firstStopReason === "request-contract-invalid" ?
							{ requestContract: firstRequestContract } : {}) } }));
				await saveStatus({ outcome: "incomplete", originalObjective: { id: originalObjective.id,
					stopReason: firstStopReason, checkpointFile: "objective-checkpoint.json" },
				...(provenanceImportSummary ? { provenanceImport: provenanceImportSummary } : {}),
				independentValidation: "prior selected source retained; no mission replacement established" });
				process.exitCode = 1;
				return;
			}
			const { goal, task, initialSpec, checks: initialChecks, registered: initialRegistered } = firstStep.advanced;
			runId = goal.runId;
			statusPhase = "parent-task-returned";
			statusTaskTelemetry = await taskTelemetry(ws, task, runtimeKey);
			const parentCandidate = path.join(task.workDir, "candidate.cpp");
			const parentVerification = path.join(task.workDir, "verification.json");
			let parentResult: Record<string, unknown> | undefined;
			try { parentResult = JSON.parse(await readFile(parentVerification, "utf8")) as Record<string, unknown>; } catch { /* no parent verification */ }
			const parentHostPassed = task.status === "returned" && task.loopStopReason === "ready" && parentResult?.status === "passed";
			let accepted = false;
			if (task.status === "returned" && task.reportPath) {
				statusPhase = "parent-review";
				const review = await controller.review(runId, { taskId: task.taskId,
					checks: initialChecks.map((criterion, i) => ({ criterion, result: parentHostPassed ? "passed" : "failed",
						evidence: parentHostPassed ? [i === 0 ? parentCandidate : parentVerification] : [] })),
					artifacts: [...(initialRegistered && existsSync(path.join(task.workDir, "experiment-plan.json")) ? [path.join(task.workDir, "experiment-plan.json")] : []), task.reportPath, ...(existsSync(parentCandidate) ? [parentCandidate] : []), ...(existsSync(parentVerification) ? [parentVerification] : [])],
					failures: parentHostPassed ? [] : ["bounded candidate did not pass all observed checks"] });
				accepted = review.status === "accepted";
			}
			statusPhase = "parent-reviewed";
			let branchTask: Awaited<ReturnType<typeof controller.delegate>> | undefined;
			let branchAccepted = false;
			let branchExerciseComplete = false;
			let branchComparison: { state?: string; medianRatio?: number; minRatio?: number } = { state: "unavailable" };
			let branchState: Record<string, unknown> = { state: "not_run", reason: "no settled source checkpoint or remaining campaign boundary" };
			let winner = accepted ? task : undefined;
			const parentControl = unresolvedGoalControl(await controller.status(runId));
			if (task.branchSource && !parentControl.operationIds.length && !parentControl.taskIds.length &&
				!budget.snapshot().stopped && !abort.signal.aborted) {
				followOnPriorCandidate = parentCandidate;
				followOnPriorPlanFile = initialRegistered ? path.join(task.workDir, "experiment-plan.json") : undefined;
				statusPhase = "fork-dispatch";
				registeredScopeActive = initialRegistered;
				const forked = await controller.delegate(runId, { ...initialSpec,
					context: { mode: "fork", parentRunId: runId, parentTaskId: task.taskId,
						checkpointId: task.branchSource.checkpoint.id },
					executionLoop: { mode: "until-ready" } });
				registeredScopeActive = false;
				branchTask = forked;
				statusPhase = "fork-task-returned";
				statusBranchTelemetry = await taskTelemetry(ws, forked, runtimeKey);
				const branchCandidate = path.join(forked.workDir, "candidate.cpp");
				const branchVerification = path.join(forked.workDir, "verification.json");
				let branchResult: Record<string, unknown> | undefined;
				try { branchResult = JSON.parse(await readFile(branchVerification, "utf8")) as Record<string, unknown>; } catch { /* no branch verification */ }
				branchComparison = (branchResult?.priorCandidateComparison as typeof branchComparison | undefined) ?? { state: "unavailable" };
				const forkHostPassed = forked.status === "returned" && forked.loopStopReason === "ready" && branchResult?.status === "passed";
				let forkReviewStatus = forked.status;
				if (forked.status === "returned" && forked.reportPath) {
					statusPhase = "fork-review";
					const reviewed = await controller.review(runId, { taskId: forked.taskId,
						checks: initialChecks.map((criterion, i) => ({ criterion, result: forkHostPassed ? "passed" : "failed",
							evidence: forkHostPassed ? [i === 0 ? branchCandidate : branchVerification] : [] })),
						artifacts: [...(initialRegistered && existsSync(path.join(forked.workDir, "experiment-plan.json")) ? [path.join(forked.workDir, "experiment-plan.json")] : []), forked.reportPath, ...(existsSync(branchCandidate) ? [branchCandidate] : []),
							...(existsSync(branchVerification) ? [branchVerification] : [])],
						failures: forkHostPassed ? [] : ["forked candidate did not pass all observed checks"] });
					forkReviewStatus = reviewed.status;
					branchAccepted = reviewed.status === "accepted";
				}
				statusPhase = "fork-reviewed";
				const sourceChanged = !existsSync(parentCandidate) || !existsSync(branchCandidate) ||
					!(await readFile(parentCandidate)).equals(await readFile(branchCandidate));
				const preference = chooseForkWinner(accepted, branchAccepted, sourceChanged, branchComparison);
				winner = preference === "fork" ? forked : preference === "parent" ? task : undefined;
				const lineageSummary = await contextLineageSummary(forked.session?.lineageFile,
					task.branchSource.checkpoint, forked.session?.id, forked.session?.model,
					task.branchSource.problemSnapshotCopy);
					await writeFile(path.join(outputDir, "context-lineage.json"), `${JSON.stringify(lineageSummary, null, 2)}\n`, { mode: 0o600 });
					const trueForkReceipt = lineageSummary.state === "verified";
					const branchGoal = await controller.status(runId);
					const unresolvedBranch = unresolvedGoalControl(branchGoal);
					if (unresolvedBranch.operationIds.length || unresolvedBranch.taskIds.length) {
						statusPhase = "branch-unsettled";
						const boundary = await preserveUnsettledGoalCheckpoint({ ws, runId, outputDir,
							contract: originalObjective, budgetStopReason: budget.snapshot().stopReason });
						await recordIncrementalPrefix("control-observed");
						if (boundary.archiveFailure) statusArchiveFailure = boundary.archiveFailure;
						await saveStatus({ outcome: "incomplete", boundedRunOutcome: "partial",
							originalObjective: { id: originalObjective.id, outcome: "incomplete",
								stopReason: boundary.checkpoint.stopReason, checkpointFile: "objective-checkpoint.json",
								continuation: boundary.checkpoint.continuation.mode },
							branch: { state: "unsettled", parentTaskId: task.taskId, forkTaskId: forked.taskId,
								parentAccepted: accepted, forkAccepted: branchAccepted, trueForkReceipt,
								acceptedTaskIds: boundary.acceptedTaskIds,
								unresolvedOperationIds: boundary.unresolvedOperationIds,
								unresolvedTaskIds: boundary.unresolvedTaskIds },
							taskTelemetry: statusTaskTelemetry, branchTaskTelemetry: statusBranchTelemetry,
							availableArtifacts: boundary.checkpoint.availableArtifacts,
							...(boundary.archiveFailure ? { archiveFailure: boundary.archiveFailure } : {}),
							independentValidation: "bounded-parent-only; branch and original objective unresolved" });
						process.exitCode = 1;
						return;
					}
					if (["accepted", "rejected", "failed"].includes(forkReviewStatus)) {
					statusPhase = "branch-selection";
					await controller.selectBranch(runId, { parentTaskId: task.taskId,
						...(winner ? { selectedTaskId: winner.taskId } : {}),
						rationale: winner ? "Select the ordinarily reviewed candidate with the strongest bounded host-owned timing and no material regression; unproven speedups are not promoted." :
							"Neither candidate met the ordinary M07 review and bounded independent checks." });
					branchExerciseComplete = trueForkReceipt;
				}
				statusPhase = "branch-selected";
				branchState = { state: branchExerciseComplete ? "completed" : "incomplete", parentTaskId: task.taskId,
					forkTaskId: forked.taskId, checkpointId: task.branchSource.checkpoint.id,
					parentSessionId: task.branchSource.checkpoint.sourceSessionId, forkSessionId: forked.session?.id ?? null,
					trueForkReceipt,
					parentAccepted: accepted, forkAccepted: branchAccepted, sourceChanged,
					measuredGainSupported: sourceChanged && accepted && preference === "fork",
					measuredComparison: branchComparison,
					selectedTaskId: winner?.taskId ?? null, taskTelemetry: statusBranchTelemetry };
			}
			// A ready reviewer verdict is not the controller's final adoption decision.
			// A rejected comparison is finished partial, then its exact feedback is
			// handed to a linked fresh goal. The controller does not allow a later
			// task to retroactively turn a no-winner branch selection into fulfillment.
			const initialGoalRunId = runId;
			const rejectedGoalOutcomes: Array<{ runId: string; outcome: string }> = [];
			const repairTaskIds: string[] = [];
			const repairFeedbackFiles: string[] = [];
			let rejectedForRepair = branchTask ?? task;
			while (!winner && !budget.snapshot().stopped && !abort.signal.aborted) {
				const currentGoal = await controller.status(runId);
				const rejected = currentGoal.tasks.find(item => item.taskId === rejectedForRepair.taskId);
				const unresolved = unresolvedGoalControl(currentGoal);
				const rejectedReview = shouldRepairRejectedReview({ winner: Boolean(winner), stopped: budget.snapshot().stopped,
					aborted: abort.signal.aborted, rejected, unresolvedOperationIds: unresolved.operationIds,
					unresolvedTaskIds: unresolved.taskIds });
				const settledFailure = settledFailedM07RepairFeedback(currentGoal, rejectedForRepair.taskId,
					{ winner: Boolean(winner), stopped: budget.snapshot().stopped, aborted: abort.signal.aborted });
				if (!rejectedReview && !settledFailure) break;
				const feedbackFile = path.join(priorSeedDir, `review-repair-${repairTaskIds.length + 1}.json`);
				const feedback = settledFailure ?? { version: 1, kind: "m07-rejected-review-feedback",
					goalRunId: runId, taskId: rejected!.taskId, status: rejected!.status,
					checks: rejected!.review!.checks.map(check => ({ criterion: check.criterion, result: check.result })),
					failures: rejected!.review!.failures, unexecuted: rejected!.review!.unexecuted,
					interpretation: "Rejected development attempt. Preserve the frozen objective and all checks; no source or lesson is adopted." };
				await writeFile(feedbackFile, `${JSON.stringify(feedback, null, 2)}\n`, { mode: 0o600 });
				repairFeedbackFiles.push(feedbackFile);
				const priorAttemptFiles = (rejectedReview ? currentGoal.tasks : []).filter(item => item.mode === "execute" &&
					["rejected", "failed"].includes(item.status)).flatMap(item =>
					["candidate.cpp", "verification.json", "experiment-plan.json", "lesson-delta.json"]
						.map(name => path.join(item.workDir, name)).filter(existsSync));
				statusPhase = "review-repair-predecessor-finishing";
				const partial = await controller.finish(runId, { outcome: "partial", returnPath: "user",
					summary: rejectedReview ?
						"Ordinary M07 review rejected the bounded candidates; their exact failures remain development evidence for a linked successor goal." :
						"A settled M07 task failed without ordinary review; its host failure facts remain development evidence for a linked fresh goal.",
					goalChecks: initialChecks.map(criterion => ({ criterion, result: "not_run", evidence: [] })),
					limitations: ["No candidate from this goal was accepted or selected.",
						...(settledFailure ? ["The failed task's source and lesson were not reviewed or adopted."] : [])] });
				rejectedGoalOutcomes.push({ runId, outcome: partial.outcome ?? "partial" });
				for (const failedTask of partial.tasks.filter(item => item.mode === "execute")) {
					const archiveDir = path.join(campaignRoot, `review-repair-${rejectedGoalOutcomes.length}-${failedTask.taskId}-archive`);
					await archivePrivateM07Task({ goal: partial, task: failedTask, destination: archiveDir });
					await exportPrefixedArchive(archiveDir, outputDir,
						`fallback-${sha256(runId).slice(0, 12)}-${failedTask.taskId}`);
				}
				const repairPlan = freshM07RepairPlan(goal, runId, initialSpec, repairFeedbackFiles,
					priorAttemptFiles, settledFailure ? "settled-failed" : "rejected-review");
				const successor = await controller.begin(repairPlan.goal);
				runId = successor.runId;
				statusRunId = runId;
				followOnPriorCandidate = path.join(priorSeedDir, "prior-candidate.cpp");
				followOnPriorPlanFile = previousBundle["experiment-plan.json"] ?
					path.join(priorSeedDir, "prior-experiment-plan.json") : undefined;
				statusPhase = "review-repair-dispatch";
				registeredScopeActive = initialRegistered;
				let repairTask: Awaited<ReturnType<typeof controller.delegate>>;
				try {
					repairTask = await controller.delegate(runId, repairPlan.task);
				} finally { registeredScopeActive = false; }
				repairTaskIds.push(repairTask.taskId);
				statusPhase = "review-repair-task-returned";
				statusTaskTelemetry = await taskTelemetry(ws, repairTask, runtimeKey);
				const repairCandidate = path.join(repairTask.workDir, "candidate.cpp");
				const repairVerification = path.join(repairTask.workDir, "verification.json");
				let repairResult: Record<string, unknown> | undefined;
				try { repairResult = JSON.parse(await readFile(repairVerification, "utf8")) as Record<string, unknown>; }
				catch { /* no verified repair */ }
				const repairHostPassed = repairTask.status === "returned" && repairTask.loopStopReason === "ready" &&
					repairResult?.status === "passed";
				rejectedForRepair = repairTask;
				if (repairTask.status === "failed") continue;
				if (repairTask.status !== "returned" || !repairTask.reportPath) break;
				statusPhase = "review-repair-review";
				const reviewed = await controller.review(runId, { taskId: repairTask.taskId,
					checks: initialChecks.map((criterion, i) => ({ criterion,
						result: repairHostPassed ? "passed" : "failed",
						evidence: repairHostPassed ? [i === 0 ? repairCandidate : repairVerification] : [] })),
					artifacts: [repairTask.reportPath,
						...(existsSync(repairCandidate) ? [repairCandidate] : []),
						...(existsSync(repairVerification) ? [repairVerification] : []),
						...(initialRegistered && existsSync(path.join(repairTask.workDir, "experiment-plan.json")) ?
							[path.join(repairTask.workDir, "experiment-plan.json")] : [])],
					failures: repairHostPassed ? [] : ["repair candidate did not pass all observed checks"] });
				if (reviewed.status === "accepted") winner = repairTask;
			}
			statusPhase = "review-repair-reviewed";
			// A failed or interrupted parent can leave an issued provider operation unknown.
			// finish() must never be used to turn that state into a partial terminal goal.
			const firstGoalControl = unresolvedGoalControl(await controller.status(runId));
			if (firstGoalControl.operationIds.length || firstGoalControl.taskIds.length) {
				statusPhase = "first-goal-unsettled";
				const boundary = await preserveUnsettledGoalCheckpoint({ ws, runId, outputDir,
					contract: originalObjective, budgetStopReason: budget.snapshot().stopReason });
				await recordIncrementalPrefix("control-observed");
				if (boundary.archiveFailure) statusArchiveFailure = boundary.archiveFailure;
				await saveStatus({ outcome: "incomplete", boundedRunOutcome: "partial",
					originalObjective: { id: originalObjective.id, outcome: "incomplete",
						stopReason: boundary.checkpoint.stopReason, checkpointFile: "objective-checkpoint.json",
						continuation: boundary.checkpoint.continuation.mode },
					m07Outcome: "active", taskStatus: task.status, loopStopReason: task.loopStopReason,
					acceptedTaskIds: boundary.acceptedTaskIds,
					unresolvedOperationIds: boundary.unresolvedOperationIds,
					unresolvedTaskIds: boundary.unresolvedTaskIds,
					taskTelemetry: statusTaskTelemetry, branch: branchState,
					availableArtifacts: boundary.checkpoint.availableArtifacts,
					...(boundary.archiveFailure ? { archiveFailure: boundary.archiveFailure } : {}),
					independentValidation: "not-complete" });
				process.exitCode = 1;
				return;
			}
			const branchRequirementSatisfied = selectedGoalBranchSatisfied(runId, initialGoalRunId,
				branchExerciseComplete);
			const acceptedWinner = branchRequirementSatisfied && Boolean(winner);
			const selectedTask = winner ?? task;
			let candidate = path.join(selectedTask.workDir, "candidate.cpp");
			let verificationPath = path.join(selectedTask.workDir, "verification.json");
			statusPhase = "first-goal-finishing";
			const finished = await controller.finish(runId, { outcome: acceptedWinner ? "fulfilled" : "partial", returnPath: "user",
				summary: acceptedWinner ? runId === initialGoalRunId ?
					"M07 builder, true refinement fork and controller-accepted selected task completed." :
					"A prior rejected goal remains partial; this linked fresh goal produced a controller-accepted task." :
					"M07 attempt or true branch selection was incomplete.",
				goalChecks: initialChecks.map((criterion, i) => ({ criterion, result: acceptedWinner ? "passed" : "not_run",
					evidence: acceptedWinner ? [i === 0 ? candidate : verificationPath] : [] })),
				limitations: ["The workflow-owned independent checker covers bounded shapes, mutations and threads; it is not exhaustive proof of correctness or optimality."] });
			const firstGoalReady = firstM07Accepted(acceptedWinner, finished.outcome);
			statusPhase = "first-goal-finished";
			const frozenGoal = await controller.status(runId);
			const frozenTask = frozenGoal.tasks.find(item => item.taskId === selectedTask.taskId);
			if (!frozenTask) fail("finished M07 task identity is unavailable for private archive");
			const selectedM04ReadPaths = firstGoalReady ? selectedM07ReviewReadPaths(ws.runDir("M07", runId), frozenTask,
				initialRegistered ? ["experiment-plan.json"] : []) : [];
			statusPhase = "private-archive";
			const privateArchive = await archivePrivateM07Task({ goal: frozenGoal, task: frozenTask, destination: outputDir });
			const firstGoalRequestContract = archivedRequestContract(privateArchive);
			if (runId === initialGoalRunId) {
				const parentArchiveDir = path.join(campaignRoot, "branch-parent-archive");
				await archivePrivateM07Task({ goal: frozenGoal, task: frozenGoal.tasks.find(item => item.taskId === task.taskId)!,
					destination: parentArchiveDir });
				await exportPrefixedArchive(parentArchiveDir, outputDir, "branch-parent");
				if (branchTask) {
					const childArchiveDir = path.join(campaignRoot, "branch-child-archive");
					await archivePrivateM07Task({ goal: frozenGoal, task: frozenGoal.tasks.find(item => item.taskId === branchTask.taskId)!,
						destination: childArchiveDir });
					await exportPrefixedArchive(childArchiveDir, outputDir, "branch-child");
				}
			}
			let finalArchive = privateArchive;
			let selectedCandidateSource: "initial" | "fork" | "repair" | "followon" | "none" = firstGoalReady ?
				repairTaskIds.includes(selectedTask.taskId) ? "repair" :
				selectedTask.taskId === task.taskId ? "initial" : "fork" : "none";
			let m04: { status: "completed" | "failed" | "not_run"; runId?: string; proposalSubmitted?: boolean;
				snapshotCreated?: boolean; evidenceReturned?: boolean; adoptedExperienceRefs?: KnowledgeRef[];
				transactionState?: PortableM04KnowledgeTransactionV1["state"];
				repairNeeded?: boolean;
				failure?: ReturnType<typeof privateExceptionDiagnostic> } = { status: "not_run" };
			if (firstGoalReady && branchRequirementSatisfied && !budget.snapshot().stopped && !abort.signal.aborted) {
				statusPhase = "m04-dispatch";
				try {
					const m04Runner = runner;
					const processed = await runM04({ ws, store, runner: m04Runner, config: await ws.loadConfig() },
						{ feedback: { kind: "M07", runId }, freshSession: true,
							onRepairState: state => saveRepairState(outputDir, state),
							onInvalidJudgment: diagnostic => saveAssessorValidationDiagnostic(outputDir, diagnostic),
							requiredM07ReadPaths: selectedM04ReadPaths,
							purpose: "Adjudicate bounded M07 candidate lessons and limits" });
					const transaction = await exportPortableM04Transaction({ ws, m04RunId: processed.record.runId,
						destination: outputDir });
					if (transaction.state === "unknown" || transaction.state === "merge-intent")
						fail("returned M04 has an unresolved knowledge transaction");
					const transactionFacts = privateM04TransactionFacts(transaction);
					const complete = processed.record.status === "completed" && processed.record.failures.length === 0;
					const coverage = firstGoalReady ? await m04EvidenceReturned(processed.record, selectedTask.taskId,
						initialRegistered ? ["experiment-plan.json"] : []) :
						{ complete: false, paths: [] };
					m04 = { status: complete ? "completed" : "failed", runId: processed.record.runId,
						proposalSubmitted: transactionFacts.proposalSubmitted,
						snapshotCreated: transactionFacts.snapshotCreated,
						transactionState: transaction.state,
						evidenceReturned: coverage.complete && selectedM04ReadPaths.every(item => coverage.paths.includes(item)),
						adoptedExperienceRefs: complete ? await adoptedExperienceRefs(store, processed.record.runId,
							coverage.complete && selectedM04ReadPaths.every(item => coverage.paths.includes(item))) : [] };
				} catch (error) {
					if (error instanceof PrivateAssessorDiagnosticError) {
						try { await retainM04TransactionOnDiagnosticFailure(ws, runId!,
							outputDir, outputDir); }
						catch {
							if (statusAssessorDiagnosticFailure)
								statusAssessorDiagnosticFailure.transactionExportFailure = true;
						}
						throw error;
					}
					const retained = await retainFailedM04Transaction(ws, runId!, outputDir);
					m04 = { status: "failed", adoptedExperienceRefs: [],
						...(error instanceof WorkflowRepairNeededError ? { repairNeeded: true } : {}),
						...(retained ? { runId: retained.runId,
							...(retained.proposalSubmitted !== undefined ? { proposalSubmitted: retained.proposalSubmitted } : {}),
							...(retained.snapshotCreated !== undefined ? { snapshotCreated: retained.snapshotCreated } : {}),
							...(retained.transaction ? { transactionState: retained.transaction.state } : {}) } : {}),
						failure: privateExceptionDiagnostic(error, runtimeKey) };
				}
			}
			const archivedM04 = await recordPrivateM04Outcome(outputDir, { state: m04.status === "not_run" ? "not-run" : m04.status,
				...(m04.runId ? { runId: m04.runId } : {}),
				...(m04.proposalSubmitted !== undefined ? { proposalSubmitted: m04.proposalSubmitted } : {}),
				...(m04.snapshotCreated !== undefined ? { snapshotCreated: m04.snapshotCreated } : {}),
				adoptedExperienceRefs: m04.adoptedExperienceRefs ?? [] }, store);
			const knowledgeExport = archivedM04.m04?.knowledgeExport ?? { state: "incomplete", reason: "M04 export state unavailable" };
			const m04AdoptedExperienceCount = m04.runId ? (await store.list()).filter(record =>
				record.source.stage === "M04" && record.source.runId === m04.runId &&
				record.usageDecision === "adopted" && record.fields.experience !== undefined).length : 0;
			const m04SelectedReadContractSatisfied = m04.evidenceReturned === true;
			const m04AdoptionReadContractSatisfied = m04AdoptedExperienceCount === 0 || m04.evidenceReturned === true;
			const reusableRefs = m04.evidenceReturned && knowledgeExport.state === "complete" ?
				(m04.adoptedExperienceRefs ?? []).filter(ref => (archivedM04.m04?.adoptedExperienceRefs ?? []).some(exported =>
					exported.storeId === ref.storeId && exported.recordId === ref.recordId && exported.version === ref.version)) : [];
			let followOn: Record<string, unknown> = { state: "not_run", reason: "M04, seed, budget or cancellation boundary unavailable" };
			const followOnAttempts: Array<Record<string, unknown>> = [];
			let followOnSourceChanged: boolean | null = null;
			let objectiveAssessment: ObjectiveProgressV1["assessment"];
			let lastAssessedSelectedGoalRunId = previousCheckpoint.boundedRuns.findLast(row =>
				row.selectedTaskId)?.runId;
			let latestAssessmentAdvanced = false;
			const assessmentHistory: ObjectiveProgressV1["assessmentHistory"] = [...previousCheckpoint.assessmentHistory,
				...(firstStep.assessment ? [{ iteration: previousCheckpoint.assessmentHistory.length + 1,
					assessment: firstStep.assessment, stopReason: firstStep.stopReason, advanced: true }] : [])];
			const priorAssessmentCount = assessmentHistory.length;
			let objectiveStopReason: CurrentObjectiveStopReason = "bounded-run-incomplete";
			let objectivePendingActionFacts: HostPendingActionFactsV1 = {};
			let objectivePendingActionReason: CurrentObjectiveStopReason | undefined;
			let currentM04Status = m04.status;
			let currentM04TransactionState = m04.transactionState;
			let currentM04RepairNeeded = m04.repairNeeded === true;
			let currentM04Read = m04SelectedReadContractSatisfied;
			let currentKnowledgeExport = knowledgeExport;
			let currentReusableRefs = reusableRefs;
			let currentKnowledgeFile = existsSync(path.join(outputDir, "m04-adopted-knowledge.json")) ?
				path.join(outputDir, "m04-adopted-knowledge.json") : undefined;
			let currentSelectedGoalRunId = runId!;
			let currentSelectedTaskId = selectedTask.taskId;
			let selectedRegisteredPlan = initialRegistered;
			let latestAttemptEvidence: Array<{ name: string; file: string }> = [];
			const loop = await runOriginalObjectiveLoop({
				admission: () => {
					if (budget.snapshot().stopped) return campaignObjectiveStop(budget.snapshot().stopReason) ??
						"bounded-run-incomplete";
					if (abort.signal.aborted) return "cancelled";
					if (currentM04Status === "failed")
						return failedM04StopReason(currentM04Status, currentM04TransactionState,
							currentM04RepairNeeded);
					if (!firstGoalReady && firstGoalRequestContract) return "request-contract-invalid";
					if (!firstGoalReady || currentM04Status !== "completed" || currentKnowledgeExport.state === "incomplete" ||
						!currentM04Read || !existsSync(candidate) || !existsSync(verificationPath)) return "bounded-run-incomplete";
					return "admitted";
				},
				step: async localIteration => {
				const iteration = priorAssessmentCount + localIteration;
				let advancedThisIteration = false;
				let assessmentThisIteration = false;
				let activeFollowOnGoalId: string | undefined;
				let activeFollowOnTaskId: string | undefined;
				const iterationDiagnosticStart = statusTransportDiagnostics.length;
				statusPhase = "original-objective-assessment";
				try {
					const objectiveRecord = await ws.startRun("M07Objective", [
						{ label: "Frozen original objective", path: objectiveContractFile },
						{ label: "Original private problem", path: ws.problemFile },
						{ label: "Selected bounded candidate", path: candidate },
						{ label: "Selected bounded verification", path: verificationPath },
					]);
					const saveObjectiveReceipt = () => persistObjectiveReceipt(objectiveRecord);
					const evidence = [
						{ name: "host-capabilities.json", file: capabilityFile },
						{ name: "original-problem.txt", file: ws.problemFile },
						...found.files.map((name, index) => ({ name: `original-input-${index + 1}.txt`,
							file: path.join(ws.rawDir, name) })),
						{ name: "candidate.cpp", file: candidate },
						{ name: "verification.json", file: verificationPath },
						...(selectedRegisteredPlan && existsSync(path.join(path.dirname(candidate), "experiment-plan.json")) ?
							[{ name: "experiment-plan.json", file: path.join(path.dirname(candidate), "experiment-plan.json") }] : []),
						{ name: "workflow-archive.json", file: path.join(outputDir, "workflow-archive.json") },
						...(currentKnowledgeFile ? [{ name: "m04-knowledge.json", file: currentKnowledgeFile }] : []),
						...latestAttemptEvidence,
					];
					const latestGrounding = assessmentHistory.at(-1)?.assessment ?? firstStep.assessment;
					const selectedEvidenceNew = currentSelectedGoalRunId !== lastAssessedSelectedGoalRunId;
					const groundingBase = assessorGroundingPolicy(evidence, previousCheckpoint,
						latestGrounding, selectedEvidenceNew);
					const stagedGrounding = await stagePriorGroundingRecords(
						path.join(campaignRoot, `objective-grounding-${iteration}`), groundingBase);
					evidence.push(...stagedGrounding.evidence);
					const groundedPolicy = { ...assessorGroundingPolicy(evidence, previousCheckpoint,
						latestGrounding, selectedEvidenceNew),
						priorGroundingIndex: stagedGrounding.priorGroundingIndex, capabilityLocators };
					const assessmentAdmission = "admitted";
					let objectiveStep;
					try { objectiveStep = await assessAndAdvanceOriginalObjective({
						contract: originalObjective, contractFile: objectiveContractFile,
							runner, runRecord: objectiveRecord, persistReceipt: saveObjectiveReceipt,
							recordRepairState: state => saveRepairState(outputDir, state),
							recordValidationFailure: diagnostic => saveAssessorValidationDiagnostic(outputDir, diagnostic),
						sessionSpec: { label: `M07-original-objective-assessment-${iteration}`, role: "research", model: MODEL,
							systemPrompt: "Independently assess the original research goal using the frozen evidence. Read the complete supplied files before proposing further work. Return only the requested structured judgment; acknowledge uncertainty, bounded search scope and failed checks. Do not invent measurements or treat M04 adoption as proof of performance.",
							persistDir: ws.sessionsDir },
						evidenceRoot: path.join(campaignRoot, `objective-evidence-${iteration}`), evidence,
						groundingPolicy: groundedPolicy,
						evidenceAccess: assessorEvidenceAccess(evidence),
						evidenceRequirements: privateEvidenceRequirements,
						assessmentAdmission,
						advanceAdmission: () => budget.snapshot().stopped ?
							campaignObjectiveStop(budget.snapshot().stopReason) ?? "assessment-failed" :
							abort.signal.aborted ? "cancelled" : "admitted",
						supportedTaskScopes: [...OBJECTIVE_SUPPORTED_TASK_SCOPES],
						userOverrides, capabilities: objectiveCapabilities,
						recordAssessment: async assessment => {
							objectiveAssessment = assessment;
							assessmentThisIteration = true;
							if (assessmentHistory.at(-1)?.iteration === iteration)
								assessmentHistory[assessmentHistory.length - 1] = { iteration, assessment,
									stopReason: "assessment-validation-pending", advanced: false };
							else assessmentHistory.push({ iteration, assessment, stopReason: "assessment-validation-pending", advanced: false });
							await writeCurrentObjectiveProgress(campaignObjectiveProgress(originalObjective,
								historicalUnresolvedOperationIds,
								{ boundedRuns: [...previousCheckpoint.boundedRuns, ...importBoundedRuns, ...rejectedGoalOutcomes,
									{ runId: runId!, outcome: finished.outcome ?? "unknown",
									acceptedTaskIds: finished.tasks.filter(item => item.status === "accepted").map(item => item.taskId),
									...(firstGoalReady ? { selectedTaskId: selectedTask.taskId } : {}) }],
									selectedArtifacts: ["candidate.cpp", "verification.json", "workflow-archive.json",
										...(selectedRegisteredPlan ? ["experiment-plan.json"] : [])],
									assessment, assessmentHistory, stopReason: "assessment-validation-pending" }));
						},
						advance: async proposal => {
							statusPhase = "model-proposed-m07-dispatch";
							const registered = proposal.adapterScope === "registered-csr-experiment";
							const taskChecks = registered ? REGISTERED_CHECKS : CHECKS;
						const prior = JSON.parse(await readFile(verificationPath, "utf8")) as Record<string, unknown>;
							followOnPriorCandidate = candidate;
							followOnPriorPlanFile = selectedRegisteredPlan ? path.join(path.dirname(candidate), "experiment-plan.json") : undefined;
							const seedDir = path.join(ws.root, "objective-seeds");
							await mkdir(seedDir, { recursive: true, mode: 0o700 });
							const seedPath = path.join(seedDir, `prior-candidate-seed-${iteration}.json`);
							const summary = Array.isArray(prior.originalCheckerRuns) ? prior.originalCheckerRuns.map((row: Record<string, unknown>) => ({
								args: row.args, exitCode: row.exitCode, reportedKernelMs: row.reportedKernelMs })) : [];
							await writeFile(seedPath, JSON.stringify({ version: 1, sourceGoalRunId: currentSelectedGoalRunId, sourceTaskId: currentSelectedTaskId,
								status: prior.status, independent: prior.independent, measuredCases: summary }, null, 2), { mode: 0o600 });
							const secondGoal = await controller.begin({
								goal: `Bounded continuation of original objective ${originalObjective.id}: ${proposal.objective}`,
								problemRelation: `Model-proposed work addressing unresolved original obligations ${proposal.addresses.join(", ")}; original goal: ${originalObjective.goal}`,
								constraints: ["Prior candidate and measurements are development evidence, not adopted truth.",
									"Use only M04-adopted pinned experience refs that pass current applicability and live-limit checks.",
									registered ? "Use the independently validated source capability and model-authored registered experiment plan; keep original generators/references/checker immutable." :
										"Keep this adapter's two-target scope and preserve non-target code and built-in checker.",
									"Deliver source and machine-readable evidence only; no prose report, screenshots, presentation or personal reflection."],
								successCriteria: taskChecks,
								plan: `Investigate the model-proposed next work against the original unresolved obligations: ${proposal.addresses.join(", ")}. Inspect prior candidate and measurements, then run one fresh bounded builder/reviewer loop.`,
								exploratory: false,
							});
							activeFollowOnGoalId = secondGoal.runId;
						const proposedRefs = currentReusableRefs;
							const tags = ["execute", "numeric", "cpu", "cpp-parallel"];
							const selection = await createExperienceProvider(store).select({ targetKind: "executor",
								applicability: { stage: "M07", tags }, requestedRefs: proposedRefs,
								expectedSnapshotId: secondGoal.knowledgeSnapshot, maxRecords: 24, maxChars: 24_000 });
							const pinnedRefs = selection.status === "ready" ? proposedRefs : [];
						const seedInputs = [path.relative(ws.root, candidate), path.relative(ws.root, seedPath),
								"objective-seeds/host-capabilities.json",
								...(selectedRegisteredPlan ? [path.relative(ws.root, path.join(path.dirname(candidate), "experiment-plan.json"))] : [])];
							registeredScopeActive = registered;
							const secondTask = await controller.delegate(secondGoal.runId, { mode: "execute",
								objective: `${proposal.objective}\n\nInspect the supplied prior candidate and prior-candidate-seed.json as untrusted development evidence. Address original obligations ${proposal.addresses.join(", ")}. Produce a complete candidate.cpp and pending lesson-delta.json. ${registered ?
									experimentInstructions :
									"Keep this adapter's two-target original-source scope."} Report negative or mixed measured results honestly. Use only confined read/write/edit; the host writes verification.json; no shell, network or prose deliverables.`,
								inputs: [...found.files.map(x => `problem/raw/${x}`), ...seedInputs],
								expectedOutputs: registered ? ["candidate.cpp", "experiment-plan.json", "lesson-delta.json"] :
									["candidate.cpp", "lesson-delta.json"], lessonDeltaOutput: "lesson-delta.json", checks: taskChecks,
								...(pinnedRefs.length ? { experienceRefs: pinnedRefs, experienceTags: tags } : {}),
								executionLoop: { mode: "until-ready" },
							});
							registeredScopeActive = false;
							activeFollowOnTaskId = secondTask.taskId;
							return { secondGoal, secondTask, proposedRefs, selection, pinnedRefs, taskChecks, registered };
						},
					});
						objectiveRecord.outputs.push({ label: "Original objective checkpoint", path: objectiveCheckpointFile });
						await ws.finishRun(objectiveRecord,
							objectiveAssessmentRunCompleted(objectiveStep.assessment,
								objectiveStep.stopReason) ? "completed" : "failed");
						await saveObjectiveReceipt();
					} catch (error) {
						objectiveRecord.failures.push("Original objective assessment or model-proposed bounded dispatch failed");
						await ws.finishRun(objectiveRecord, "failed").catch(() => undefined);
						await saveObjectiveReceipt().catch(() => undefined);
						throw error;
					}
					objectiveAssessment = objectiveStep.assessment;
					if (objectiveStep.assessment?.unreadEvidence.length === 0)
						lastAssessedSelectedGoalRunId = currentSelectedGoalRunId;
					latestAssessmentAdvanced = Boolean(objectiveStep.advanced);
					objectiveStopReason = objectiveStep.stopReason === "assessment-failed" && campaignObjectiveStop(budget.snapshot().stopReason) ?
						campaignObjectiveStop(budget.snapshot().stopReason)! : objectiveStep.stopReason === "assessment-failed" &&
						(abort.signal.aborted) ? "cancelled" : objectiveStep.stopReason;
					const stepRequestContract = observedRequestContract(iterationDiagnosticStart,
						statusTransportDiagnostics);
					if (stepRequestContract && objectiveStopReason === "assessment-failed")
						objectiveStopReason = "request-contract-invalid";
					objectivePendingActionFacts = { ...observedTransportActionFacts(objectiveStopReason,
						statusTransportDiagnostics.slice(iterationDiagnosticStart),
						budget.requestAccountingAuditSnapshot(), "read-only-assessor"),
						...(objectiveStopReason === "workflow-repair-needed" ?
							workflowRepairActionFacts("objective-assessment") : {}),
						...(objectiveStopReason === "request-contract-invalid" ?
							{ requestContract: stepRequestContract } : {}) };
					objectivePendingActionReason = objectiveStopReason;
					if (assessmentHistory.at(-1)?.iteration === iteration) {
						assessmentHistory[assessmentHistory.length - 1].stopReason = objectiveStopReason;
						assessmentHistory[assessmentHistory.length - 1].advanced = Boolean(objectiveStep.advanced);
					}
					if (objectiveStep.advanced) {
						statusPhase = "post-m04-followon";
						const { secondGoal, secondTask, proposedRefs, selection, pinnedRefs, taskChecks, registered } = objectiveStep.advanced;
					const nextCandidate = path.join(secondTask.workDir, "candidate.cpp");
					const nextVerification = path.join(secondTask.workDir, "verification.json");
					let nextResult: Record<string, unknown> | undefined;
					try { nextResult = JSON.parse(await readFile(nextVerification, "utf8")) as Record<string, unknown>; } catch { /* no verified follow-on */ }
					const comparison = nextResult?.priorCandidateComparison ?? { state: "unavailable" };
					const secondReady = secondTask.status === "returned" && secondTask.loopStopReason === "ready" && nextResult?.status === "passed";
					if (secondTask.status === "returned" && secondTask.reportPath) {
						const reviewed = await controller.review(secondGoal.runId, { taskId: secondTask.taskId,
							checks: taskChecks.map((criterion, index) => ({ criterion, result: secondReady ? "passed" : "failed",
								evidence: secondReady ? [index === 0 ? nextCandidate : nextVerification] : [] })),
							artifacts: [secondTask.reportPath, ...(existsSync(nextCandidate) ? [nextCandidate] : []),
								...(existsSync(nextVerification) ? [nextVerification] : []),
								...(registered && existsSync(path.join(secondTask.workDir, "experiment-plan.json")) ?
									[path.join(secondTask.workDir, "experiment-plan.json")] : [])],
							failures: secondReady ? [] : ["follow-on candidate did not pass all bounded checks"] });
						if (secondReady && reviewed.status !== "accepted") fail("follow-on M07 review did not accept candidate");
					}
						const secondControl = unresolvedGoalControl(await controller.status(secondGoal.runId));
						if (secondControl.operationIds.length || secondControl.taskIds.length)
							fail("follow-on goal has unresolved external operations or tasks");
						const secondFinished = await controller.finish(secondGoal.runId, { outcome: secondReady ? "fulfilled" : "partial",
						returnPath: "user", summary: secondReady ? "Fresh bounded follow-on checked prior context and produced verified candidate." :
							"Fresh bounded follow-on did not complete all checks.",
						goalChecks: taskChecks.map((criterion, index) => ({ criterion, result: secondReady ? "passed" : "not_run",
							evidence: secondReady ? [index === 0 ? nextCandidate : nextVerification] : [] })),
						limitations: ["Prior archive/context and loaded experience do not by themselves establish faithful use or scientific benefit."] });
					const nextFrozenGoal = await controller.status(secondGoal.runId);
						const nextFrozenTask = nextFrozenGoal.tasks.find(item => item.taskId === secondTask.taskId);
						if (!nextFrozenTask) fail("model-proposed M07 task identity unavailable for private archive");
						const nextArchiveDir = path.join(campaignRoot, `iteration-${iteration}-archive`);
						await archivePrivateM07Task({ goal: nextFrozenGoal, task: nextFrozenTask, destination: nextArchiveDir });
						let nextM04: typeof m04 = { status: "not_run" };
						if (secondReady && nextFrozenTask.review && !budget.snapshot().stopped && !abort.signal.aborted) {
							statusPhase = "model-proposed-m04-dispatch";
							const requiredPaths = selectedM07ReviewReadPaths(ws.runDir("M07", secondGoal.runId), nextFrozenTask,
								registered ? ["experiment-plan.json"] : []);
							try {
								const m04Runner = runner;
								const processed = await runM04({ ws, store, runner: m04Runner, config: await ws.loadConfig() },
									{ feedback: { kind: "M07", runId: secondGoal.runId }, freshSession: true,
										onRepairState: state => saveRepairState(outputDir, state),
										onInvalidJudgment: diagnostic => saveAssessorValidationDiagnostic(outputDir, diagnostic),
										requiredM07ReadPaths: requiredPaths,
										purpose: "Adjudicate the latest model-proposed bounded M07 result" });
								const transaction = await exportPortableM04Transaction({ ws, m04RunId: processed.record.runId,
									destination: nextArchiveDir });
								if (transaction.state === "unknown" || transaction.state === "merge-intent")
									fail("returned M04 has an unresolved knowledge transaction");
								const transactionFacts = privateM04TransactionFacts(transaction);
								const coverage = await m04EvidenceReturned(processed.record, secondTask.taskId,
									registered ? ["experiment-plan.json"] : []);
								const complete = processed.record.status === "completed" && processed.record.failures.length === 0 &&
									coverage.complete && requiredPaths.every(item => coverage.paths.includes(item));
								nextM04 = { status: complete ? "completed" : "failed", runId: processed.record.runId,
									proposalSubmitted: transactionFacts.proposalSubmitted,
									snapshotCreated: transactionFacts.snapshotCreated,
									transactionState: transaction.state,
									evidenceReturned: complete,
									adoptedExperienceRefs: complete ? await adoptedExperienceRefs(store, processed.record.runId, true) : [] };
							} catch (error) {
								if (error instanceof PrivateAssessorDiagnosticError) {
									try { await retainM04TransactionOnDiagnosticFailure(ws,
										secondGoal.runId, nextArchiveDir, outputDir,
										`iteration-${iteration}`); }
									catch {
										if (statusAssessorDiagnosticFailure)
											statusAssessorDiagnosticFailure.transactionExportFailure = true;
									}
									throw error;
								}
								const retained = await retainFailedM04Transaction(ws, secondGoal.runId, nextArchiveDir);
								nextM04 = { status: "failed", adoptedExperienceRefs: [],
									...(error instanceof WorkflowRepairNeededError ? { repairNeeded: true } : {}),
									...(retained ? { runId: retained.runId,
										...(retained.proposalSubmitted !== undefined ? { proposalSubmitted: retained.proposalSubmitted } : {}),
										...(retained.snapshotCreated !== undefined ? { snapshotCreated: retained.snapshotCreated } : {}),
										...(retained.transaction ? { transactionState: retained.transaction.state } : {}) } : {}),
									failure: privateExceptionDiagnostic(error, runtimeKey) };
							}
									}
						const nextArchive = await recordPrivateM04Outcome(nextArchiveDir,
							{ state: nextM04.status === "not_run" ? "not-run" : nextM04.status,
								...(nextM04.runId ? { runId: nextM04.runId } : {}),
								...(nextM04.proposalSubmitted !== undefined ? { proposalSubmitted: nextM04.proposalSubmitted } : {}),
								...(nextM04.snapshotCreated !== undefined ? { snapshotCreated: nextM04.snapshotCreated } : {}),
								adoptedExperienceRefs: nextM04.adoptedExperienceRefs ?? [] }, store);
						const iterationPrefix = `iteration-${localIteration}`;
						await exportPrefixedArchive(nextArchiveDir, outputDir, iterationPrefix);
						latestAttemptEvidence = [{ name: "latest-attempt-archive.json",
							file: path.join(outputDir, `workflow-${iterationPrefix}-archive.json`) },
							...(existsSync(path.join(outputDir, `${iterationPrefix}-candidate.cpp`)) ?
								[{ name: "latest-attempt.cpp", file: path.join(outputDir, `${iterationPrefix}-candidate.cpp`) }] : []),
							...(existsSync(path.join(outputDir, `${iterationPrefix}-verification.json`)) ?
								[{ name: "latest-attempt-verification.json", file: path.join(outputDir, `${iterationPrefix}-verification.json`) }] : []),
							...(registered && existsSync(path.join(outputDir, `${iterationPrefix}-experiment-plan.json`)) ?
								[{ name: "latest-attempt-plan.json", file: path.join(outputDir, `${iterationPrefix}-experiment-plan.json`) }] : [])];
						const sourceChanged = !existsSync(candidate) || !existsSync(nextCandidate) ||
							!(await readFile(candidate)).equals(await readFile(nextCandidate));
						const chooseFollowOn = chooseFollowOnCandidate(selectedCandidateSource !== "none",
							secondFinished.outcome === "fulfilled" && secondReady && nextM04.status === "completed", sourceChanged,
							comparison as { state?: string; medianRatio?: number; minRatio?: number });
						let promoted = false;
						if (chooseFollowOn && nextArchive.files.some(item => item.name === "candidate.cpp" && item.status === "present") &&
							nextArchive.files.some(item => item.name === "verification.json" && item.status === "present")) {
							if (selectedCandidateSource !== "followon") await exportPrefixedArchive(outputDir, outputDir, "initial");
							for (const name of [...await archiveEvidenceFiles(outputDir), "workflow-archive.json",
								"m04-adopted-knowledge.json", "m04-transaction.json"]) {
								await rm(path.join(outputDir, name), { force: true });
								if (existsSync(path.join(nextArchiveDir, name))) await copyFile(path.join(nextArchiveDir, name), path.join(outputDir, name));
							}
							finalArchive = nextArchive;
							selectedCandidateSource = "followon";
							candidate = nextCandidate;
							verificationPath = nextVerification;
							currentSelectedGoalRunId = secondGoal.runId;
							currentSelectedTaskId = secondTask.taskId;
							selectedRegisteredPlan = registered;
							promoted = true;
						}
						followOnSourceChanged = sourceChanged;
						if (secondReady) {
							currentM04Status = nextM04.status;
							currentM04TransactionState = nextM04.transactionState;
							currentM04RepairNeeded = nextM04.repairNeeded === true;
							currentM04Read = nextM04.evidenceReturned === true;
							currentKnowledgeExport = nextArchive.m04?.knowledgeExport ?? { state: "incomplete" };
							currentReusableRefs = nextM04.evidenceReturned && currentKnowledgeExport.state === "complete" ?
								(nextM04.adoptedExperienceRefs ?? []).filter(ref => (nextArchive.m04?.adoptedExperienceRefs ?? []).some(exported =>
									exported.storeId === ref.storeId && exported.recordId === ref.recordId && exported.version === ref.version)) : [];
							currentKnowledgeFile = existsSync(path.join(nextArchiveDir, "m04-adopted-knowledge.json")) ?
								path.join(nextArchiveDir, "m04-adopted-knowledge.json") : undefined;
						}
						followOn = { state: "completed", iteration, goalRunId: secondGoal.runId,
							taskId: secondTask.taskId, m07Outcome: secondFinished.outcome,
							priorCandidateProvided: true, priorEvidenceProvided: true, adoptedRefsEligible: proposedRefs.length,
							experienceSelectionStatus: selection.status, pinnedRefs, loadedExperience: Boolean(secondTask.experienceSelection?.loadedAt),
							faithfulUse: "unknown", causalBenefit: "unknown", measuredComparison: comparison,
							candidateSelected: promoted, selectedCandidateSource,
							sourceChanged: followOnSourceChanged,
							noChangeOutcome: followOnSourceChanged === false ? "identical-source-kept-previous" : null,
							m04: nextM04,
							knowledgeMode: pinnedRefs.length ? "m04-adopted-pinned" : "prior-artifact-only",
							archiveTransportLayout: "prefixed-flat-index" };
						followOnAttempts.push(followOn);
						advancedThisIteration = true;
						objectiveStopReason = "objective-reassessment-pending";
						if (assessmentHistory.at(-1)?.iteration === iteration)
							assessmentHistory[assessmentHistory.length - 1].stopReason = objectiveStopReason;
					}
					} catch (error) { objectiveStopReason = campaignObjectiveStop(budget.snapshot().stopReason) ??
						(abort.signal.aborted ? "cancelled" :
							assessmentThisIteration ? "dispatch-failed" : "assessment-failed");
					const stepRequestContract = observedRequestContract(iterationDiagnosticStart,
						statusTransportDiagnostics);
					if (stepRequestContract && (objectiveStopReason === "assessment-failed" ||
						objectiveStopReason === "dispatch-failed")) objectiveStopReason = "request-contract-invalid";
					objectivePendingActionFacts = { ...observedTransportActionFacts(objectiveStopReason,
						statusTransportDiagnostics.slice(iterationDiagnosticStart),
						budget.requestAccountingAuditSnapshot(),
						activeFollowOnGoalId ? "m07-execution" : "read-only-assessor"),
						...(objectiveStopReason === "request-contract-invalid" ?
							{ requestContract: stepRequestContract } : {}) };
					objectivePendingActionReason = objectiveStopReason;
					if (assessmentHistory.at(-1)?.iteration === iteration)
						assessmentHistory[assessmentHistory.length - 1].stopReason = objectiveStopReason;
					let failedAttemptArchive = "unavailable";
					if (activeFollowOnGoalId) {
						try {
							const failedGoal = await controller.status(activeFollowOnGoalId);
							const failedTask = failedGoal.tasks.find(item => item.taskId === activeFollowOnTaskId) ??
								failedGoal.tasks.findLast(item => item.mode === "execute");
							if (failedTask) {
								activeFollowOnTaskId = failedTask.taskId;
								const failedDir = path.join(campaignRoot, `iteration-${iteration}-archive`);
								await archivePrivateM07Task({ goal: failedGoal, task: failedTask, destination: failedDir });
								await exportPrefixedArchive(failedDir, outputDir, `iteration-${localIteration}`);
								failedAttemptArchive = `workflow-iteration-${localIteration}-archive.json`;
							}
						} catch { statusArchiveFailure = "model-proposed-attempt-archive-failed"; }
					}
					followOn = { state: "failed", iteration, ...(activeFollowOnGoalId ? { goalRunId: activeFollowOnGoalId } : {}),
						...(activeFollowOnTaskId ? { taskId: activeFollowOnTaskId } : {}),
						archive: failedAttemptArchive, priorCandidateProvided: true,
						failure: privateExceptionDiagnostic(error, runtimeKey), faithfulUse: "unknown", causalBenefit: "unknown" };
					if (activeFollowOnGoalId) followOnAttempts.push(followOn);
				}
				return { advanced: advancedThisIteration, stopReason: objectiveStopReason,
					evidenceRefs: latestAttemptEvidence.map(item => item.name) };
				},
			});
			objectiveStopReason = loop.stopReason;
			statusPhase = "workflow-finished";
			let historicalSelection: Record<string, unknown> = initialHistoricalSelection(selectedCandidateSource,
				statusPriorSelectedValidation);
			if (selectedCandidateSource !== "none") {
				const finalVerification = JSON.parse(await readFile(verificationPath, "utf8")) as Record<string, unknown>;
				const prior = await remeasurePrior(path.join(priorSeedDir, "prior-candidate.cpp"),
					previousBundle["experiment-plan.json"] ? path.join(priorSeedDir, "prior-experiment-plan.json") : undefined,
					selectedRegisteredPlan, path.join(path.dirname(candidate), "experiment-plan.json"));
				await writeFile(path.join(outputDir, "restored-candidate-verification.json"), JSON.stringify(prior), { mode: 0o600 });
				const comparison = compareCandidateTimings(prior, finalVerification);
				const changed = !(await readFile(candidate)).equals(await readFile(path.join(priorSeedDir, "prior-candidate.cpp")));
				const m04SelectionReady = currentM04Status === "completed" && currentM04Read &&
					currentKnowledgeExport.state !== "incomplete";
				historicalSelection = { priorRetained: retainPriorSelectionUntilM04Ready({ status: currentM04Status,
					fullSelectedRead: currentM04Read, knowledgeExportState: currentKnowledgeExport.state },
					true, finalVerification.status === "passed", changed, comparison),
					retentionReason: !m04SelectionReady ? "m04-stage-unresolved" :
						comparison.state === "measured" ? "measured-comparison" : "no-supported-current-gain",
					comparison, comparisonPerformed: comparison.state === "measured",
					historicalTimingUsed: false, priorRevalidated: prior.status === "passed" };
				if (historicalSelection.priorRetained) {
					await exportPrefixedArchive(outputDir, outputDir, "followon");
					const history = previousBundle["research-history.json"] ? JSON.parse(previousBundle["research-history.json"]) :
						{ version: 1, kind: "untrusted-version-bound-research-history", entries: [] };
					const unselectedFiles: Record<string, string> = {};
					for (const name of ["candidate.cpp", "verification.json", "workflow-archive.json",
						"experiment-plan.json", "m04-adopted-knowledge.json", "m04-transaction.json"])
						if (existsSync(path.join(outputDir, name))) unselectedFiles[name] = await readFile(path.join(outputDir, name), "utf8");
					history.entries.push({ originalContractId: originalObjective.id, goalRunId: finalArchive.goalRunId, taskId: finalArchive.taskId,
						interpretation: "Unselected current experiment; no confirmed replacement gain against the historical candidate", files: unselectedFiles });
					await writeFile(path.join(outputDir, "research-history.json"), JSON.stringify(history), { mode: 0o600 });
					for (const name of [...await archiveEvidenceFiles(outputDir), "workflow-archive.json",
						"m04-adopted-knowledge.json", "m04-transaction.json"]) {
						await rm(path.join(outputDir, name), { force: true });
						if (previousBundle[name as keyof PrivateContinuationBundle] !== undefined)
							await writeFile(path.join(outputDir, name), previousBundle[name as keyof PrivateContinuationBundle]!, { mode: 0o600 });
					}
					finalArchive = JSON.parse(previousBundle["workflow-archive.json"]!) as typeof finalArchive;
				}
			}
			const selectedArtifactNames = historicalSelection.priorRetained === true ?
				previousCheckpoint.selectedArtifacts : ["candidate.cpp", "verification.json", "workflow-archive.json",
					...(selectedRegisteredPlan ? ["experiment-plan.json"] : [])];
			const finalCandidateAvailable = selectedCandidateSource !== "none" &&
				finalArchive.controllerEvidence.reviewStatus === "accepted" &&
				(historicalSelection.priorRetained === true || Boolean(finalArchive.controllerEvidence.reviewDecision?.file && existsSync(path.join(outputDir, "review-decision.json")))) &&
				selectedArtifactNames.filter(name => name !== "workflow-archive.json").every(name =>
					finalArchive.files.some(item => item.name === name && item.status === "present") &&
					existsSync(path.join(outputDir, name)));
			const finalCandidateVerified = finalCandidateAvailable && (historicalSelection.priorRetained !== true || historicalSelection.priorRevalidated === true);
			const durableKnowledge = knowledgeExport.state !== "incomplete" &&
				(!m04.adoptedExperienceRefs?.length || knowledgeExport.state === "complete");
			const followOnCompleted = followOn.state === "completed" && followOn.m07Outcome === "fulfilled";
			const boundedRunOutcome = firstGoalReady && finalCandidateVerified && m04.status === "completed" && durableKnowledge &&
				m04SelectedReadContractSatisfied && currentM04Status === "completed" && currentM04Read &&
				currentKnowledgeExport.state !== "incomplete" && branchRequirementSatisfied &&
				followOnCompleted ? "fulfilled" : "partial";
			const boundedRuns = [...previousCheckpoint.boundedRuns, ...importBoundedRuns, ...rejectedGoalOutcomes,
				{ runId: runId!, outcome: finished.outcome ?? "unknown",
				acceptedTaskIds: finished.tasks.filter(item => item.status === "accepted").map(item => item.taskId),
				...(firstGoalReady ? { selectedTaskId: selectedTask.taskId } : {}) },
				...followOnAttempts.filter(item => typeof item.goalRunId === "string").map(item => ({
					runId: String(item.goalRunId), outcome: String(item.m07Outcome ?? "unknown"),
					acceptedTaskIds: item.m07Outcome === "fulfilled" && typeof item.taskId === "string" ?
						[String(item.taskId)] : [],
					...(item.candidateSelected === true ? { selectedTaskId: String(item.taskId) } : {}) }))];
			const objectiveCheckpoint = campaignObjectiveProgress(originalObjective,
				historicalUnresolvedOperationIds, { boundedRuns,
				selectedArtifacts: finalCandidateAvailable ? selectedArtifactNames : previousCheckpoint.selectedArtifacts,
				...(objectiveAssessment ? { assessment: objectiveAssessment } : {}), assessmentHistory,
				nextTaskDispatched: latestAssessmentAdvanced, stopReason: objectiveStopReason,
				...(objectivePendingActionReason === objectiveStopReason ?
					{ pendingActionFacts: objectivePendingActionFacts } :
					objectiveStopReason === "workflow-repair-needed" ?
						{ pendingActionFacts: workflowRepairActionFacts("m04-judgment") } :
					objectiveStopReason === "request-contract-invalid" && firstGoalRequestContract ?
						{ pendingActionFacts: { requestContract: firstGoalRequestContract } } : {}) });
			await writeCurrentObjectiveProgress(objectiveCheckpoint);
			const campaignOutcome = objectiveCheckpoint.objectiveOutcome;
			await saveStatus({ outcome: campaignOutcome, boundedRunOutcome,
				...(provenanceImportSummary ? { provenanceImport: provenanceImportSummary } : {}),
				originalObjective: { id: originalObjective.id, outcome: objectiveCheckpoint.objectiveOutcome,
					stopReason: objectiveCheckpoint.stopReason, checkpointFile: "objective-checkpoint.json",
					goalSource: originalObjective.goalSource, continuation: objectiveCheckpoint.continuation.mode },
				m07Outcome: finished.outcome, taskStatus: frozenTask.status,
				loopStopReason: frozenTask.loopStopReason, taskTelemetry: statusTaskTelemetry,
				credentialProbe: statusCredentialProbe, sdkAuthSource: statusAuthSource,
				sdkAuthMatch: statusSdkAuthMatch,
				workflowArchive: { state: "saved", firstGoalRunId: initialGoalRunId,
					selectedM07GoalRunId: firstGoalReady ? runId : null,
					firstTaskId: task.taskId,
					selectedM07TaskId: firstGoalReady ? selectedTask.taskId : null,
					finalTaskId: finalArchive.taskId,
					lessonState: privateArchive.lesson.state, trustedAdoption: false, m04,
					knowledgeExport, m04EvidenceReturned: m04.evidenceReturned ?? false,
					m04AdoptedExperienceCount, m04AdoptionReadContractSatisfied,
					m04SelectedReadContractSatisfied },
				branch: branchState, branchExerciseComplete, branchRequirementSatisfied,
				firstGoalReady: firstGoalReady && runId === initialGoalRunId,
				selectedGoalReady: firstGoalReady,
				rejectedGoalOutcomes,
				followOn, followOnAttempts, objectiveLoop: loop, selectedCandidateSource,
				selectedMissionCandidateSource: historicalSelection.priorRetained === true ?
					"authenticated-prior-carry" : selectedCandidateSource,
				finalCandidateVerified, historicalSelection,
				...(statusArchiveFailure ? { archiveFailure: statusArchiveFailure } : {}),
				independentValidation: finalCandidateVerified ? "bounded-workflow-checker-passed" : "not-complete",
				validationLimit: "Finite bounded cases are not exhaustive correctness or global-optimality proof" });
			console.log(JSON.stringify({ status: "private-campaign-bounded-run-ended", outcome: campaignOutcome,
				boundedRunOutcome, stopReason: objectiveCheckpoint.stopReason, budget: budget.snapshot() }));
			if (campaignOutcome !== "fulfilled") process.exitCode = 1;
		} finally { process.off("SIGINT", cancel); process.off("SIGTERM", cancel); }
	} finally {
		if (runId && !statusTaskTelemetry) {
			try {
				const goalFile = path.join(new Workspace(path.join(campaignRoot, "workspace")).runDir("M07", runId), "goal.json");
				const goal = JSON.parse(await readFile(goalFile, "utf8"));
				const lastTask = Array.isArray(goal.tasks) ? goal.tasks.at(-1) : undefined;
				if (lastTask) statusTaskTelemetry = await taskTelemetry(new Workspace(path.join(campaignRoot, "workspace")), lastTask, statusRuntimeKey);
			} catch { statusTaskTelemetry = { status: "unavailable" }; }
		}
		try { await preserveCandidate(new Workspace(path.join(campaignRoot, "workspace")), runId, outputDir); }
		catch {
			statusArchiveFailure = recordFinalizationFailure(finalizationFailures, "bounded-fallback-archive-failed");
			await saveStatus({ outcome: "incomplete", archiveFailure: "bounded-fallback-archive-failed",
				finalizationFailures,
				independentValidation: "not-complete" }).catch(() => undefined);
			process.exitCode = 1;
		}
		try {
			const workspace = new Workspace(path.join(campaignRoot, "workspace"));
			const noNewResearchEffect = (await workspace.listRuns("M07")).length === 0 &&
				budget.requestAccountingAuditSnapshot().requests.length === 0;
			// Preserve the authenticated predecessor checkpoint byte-for-byte when
			// this request only appended a restart reservation before interruption.
			// Fresh preflight files still travel in the encrypted result, not as a
			// change to the selected research checkpoint.
			if (noNewResearchEffect && missionLedger.priorPrivateBundle?.["objective-checkpoint.json"])
				await writeFile(path.join(outputDir, "objective-checkpoint.json"),
					missionLedger.priorPrivateBundle["objective-checkpoint.json"], { mode: 0o600 });
			else await salvageObjectiveCheckpoint(workspace, outputDir,
				budget.snapshot().stopReason, campaignCancelled);
			await recordIncrementalPrefix("control-observed");
		}
		catch { statusArchiveFailure = recordFinalizationFailure(finalizationFailures,
			"objective-checkpoint-salvage-failed"); process.exitCode = 1; }
		try {
			const statusFile = path.join(outputDir, "campaign-status.json");
			if (existsSync(statusFile)) {
				const status = JSON.parse(await readFile(statusFile, "utf8")) as Record<string, any>;
				const checkpoint = JSON.parse(await readFile(path.join(outputDir, "objective-checkpoint.json"), "utf8")) as ObjectiveProgressV1;
				if (status.originalObjective?.checkpointFile === "objective-checkpoint.json" &&
					(status.originalObjective.stopReason !== checkpoint.stopReason ||
						status.originalObjective.outcome !== checkpoint.objectiveOutcome))
					await saveStatus({ ...status, originalObjective: { ...status.originalObjective,
						outcome: checkpoint.objectiveOutcome, stopReason: checkpoint.stopReason } });
			}
		}
		catch { statusArchiveFailure = recordFinalizationFailure(finalizationFailures,
			"objective-status-sync-failed"); process.exitCode = 1; }
		try {
			if (process.env.GITHUB_ACTIONS === "true") {
				const source = { runId: process.env.GITHUB_RUN_ID ?? "",
					runAttempt: Number(process.env.GITHUB_RUN_ATTEMPT),
					commit: process.env.GITHUB_SHA ?? "" };
				const priorEnvelopeSha256 = missionLedger.priorCarryProof?.envelopeSha256 ?? "";
				if (!/^[1-9][0-9]*$/.test(source.runId) || !Number.isSafeInteger(source.runAttempt) ||
					source.runAttempt < 1 || !/^[0-9a-f]{40}$/.test(source.commit) ||
					!/^[0-9a-f]{64}$/.test(priorEnvelopeSha256))
					fail("Actions host effect census lacks exact run and prior carry identity");
				const receipt = await buildHostEffectReceipt({ ws: new Workspace(path.join(campaignRoot, "workspace")),
					source, priorEnvelopeSha256,
					historicalGoalRunIds: receiptHistoricalGoalRunIds,
					requestIds: budget.requestAccountingAuditSnapshot().requests.map(item => item.requestId),
					sessions: sessionEffects });
				await writeFile(path.join(outputDir, "host-effect-receipt.json"),
					`${JSON.stringify(receipt)}\n`, { mode: 0o600 });
			}
		} catch { statusArchiveFailure = recordFinalizationFailure(finalizationFailures,
			"host-effect-census-unavailable"); process.exitCode = 1; }

		await rm(campaignRoot, { recursive: true, force: true });
	}
	} finally {
		let normalSealFailed = false;
		let normalSealFailure: unknown;
		let emergencySealFailed = false;
		let emergencySealFailure: unknown;
		let collectionFailure: ReturnType<typeof privateCollectionDiagnostic> | undefined;
		try {
			const snapshot = finalBudget?.snapshot();
			const requestAudit = finalBudget?.requestAccountingAuditSnapshot() ?? {
				version: 3 as const, kind: "accounting-only-request-audit" as const,
				requests: [], settledCny: 0, unknownObservedCny: 0, unpricedRequestCount: 0 };
			// Preserve the host's actual request observations in the RSA-encrypted
			// outcome even if a later carry invariant refuses to seal. A missing
			// carry must never turn an executed run into an apparent free skip.
			const statusFile = path.join(outputDir, "campaign-status.json");
			let savedStatus: Record<string, unknown> = {};
			try {
				if (existsSync(statusFile)) savedStatus = JSON.parse(await readFile(statusFile, "utf8")) as Record<string, unknown>;
				if (!savedStatus || typeof savedStatus !== "object" || Array.isArray(savedStatus)) savedStatus = {};
			} catch { savedStatus = {}; }
			try { await saveStatus({ ...savedStatus, accountingAudit: requestAudit,
				unquantifiedExecutedRunCount: missionLedger.opaqueExecutedRuns.length,
				unobservedControlDeliveryCount: missionLedger.unobservedControlDeliveries.length }); }
			catch { statusArchiveFailure = recordFinalizationFailure(finalizationFailures,
				"accounting-audit-status-write-failed"); process.exitCode = 1; }
			const transportCensus = missionLedger.appendTransportDiagnosticCensus(
				requestAudit, statusTransportDiagnostics);
			if (transportCensus !== undefined)
				await writeFile(path.join(outputDir, "transport-diagnostics.json"), transportCensus,
					{ mode: 0o600 });
			let m04QuarantineText: string | undefined;
			const m04QuarantineFile = path.join(outputDir, M04_TRANSACTION_QUARANTINE_FILE);
			if (existsSync(m04QuarantineFile)) {
				try {
					const info = await lstat(m04QuarantineFile);
					if (!info.isFile() || info.isSymbolicLink() || info.size > 4 * 1024 * 1024)
						throw Error("M04 quarantine receipt is not a bounded regular file");
					m04QuarantineText = await readFile(m04QuarantineFile, "utf8");
				} catch { statusArchiveFailure = recordFinalizationFailure(finalizationFailures,
					"m04-quarantine-receipt-unavailable"); process.exitCode = 1; }
			}
			let privateBundle = collectorFailureBundle(missionLedger.priorPrivateBundle,
				transportCensus, m04QuarantineText);
			try { privateBundle = await collectContinuationBundle(outputDir, missionLedger.priorPrivateBundle); }
			catch (error) {
				collectionFailure = privateCollectionDiagnostic(error);
				statusArchiveFailure = recordFinalizationFailure(finalizationFailures,
					"research-continuation-collection-failed-prior-retained");
				process.exitCode = 1;
			}
			const sealed = sealCampaignCarry({
				sealCurrent: input => {
					try { return missionLedger.sealCurrent(input); }
					catch (error) {
						normalSealFailed = true;
						normalSealFailure = error;
						recordFinalizationFailure(finalizationFailures, "normal-continuation-seal-failed");
						throw error;
					}
				},
				sealEmergencyCurrent: (input, reason) => {
					try { return missionLedger.sealEmergencyCurrent(input, reason); }
					catch (error) {
						emergencySealFailed = true;
						emergencySealFailure = error;
						recordFinalizationFailure(finalizationFailures, "emergency-continuation-seal-failed");
						throw error;
					}
				},
			}, { settledCny: requestAudit.settledCny,
				unknownObservedCny: requestAudit.unknownObservedCny,
				unpricedRequestCount: requestAudit.unpricedRequestCount,
				requestAudit, ...(privateBundle ? { privateBundle } : {}) }, privateSealOptions(collectionFailure));
			const carry = sealed.carry;
			// Once an envelope has been sealed, an I/O retry must use these same
			// ciphertext bytes; a second seal would create an ambiguous checkpoint.
			try { await writeSealedCarryFiles(outputDir, carry); }
			catch (error) {
				if (error instanceof CarrySidecarPersistenceError)
					recordFinalizationFailure(finalizationFailures, "carry-sidecar-write-failed");
				throw error;
			}
			await writeFile(path.join(outputDir, "mission-ledger-out.json"), `${JSON.stringify({
				version: 3, kind: "mul-pis-private-mission-ledger-observation", missionId: MISSION_ID,
				repository: MISSION_REPOSITORY, accountingMode: "observed-only",
				currentRunId: process.env.GITHUB_RUN_ID, currentRunAttempt: process.env.GITHUB_RUN_ATTEMPT,
				currentCommit: process.env.GITHUB_SHA, accounting: snapshot,
				observedSettledCny: carry.observedSettledCny,
				observedUnknownHeldCny: carry.observedUnknownHeldCny,
				unpricedRequestCount: carry.unpricedRequestCount,
				unquantifiedExecutedRunCount: missionLedger.opaqueExecutedRuns.length,
				unobservedControlDeliveryCount: missionLedger.unobservedControlDeliveries.length,
				status: sealed.mode === "normal" ? "sealed-encrypted-continuation" :
					"sealed-emergency-effects-unreviewed",
			}, null, 2)}\n`, { mode: 0o600 });
			if (sealed.mode === "emergency-effects-unreviewed") {
				const emergencyStatus = privateEmergencyStatusDiagnostics(collectionFailure, sealed);
				statusArchiveFailure = emergencyStatus.archiveFailure;
				await saveStatus({ ...savedStatus, accountingAudit: requestAudit,
					unquantifiedExecutedRunCount: missionLedger.opaqueExecutedRuns.length,
					unobservedControlDeliveryCount: missionLedger.unobservedControlDeliveries.length,
					outcome: "incomplete",
					...emergencyStatus,
					finalizationFailures,
					continuationMode: "sealed-emergency-effects-unreviewed",
					independentValidation: "not-complete" });
				process.exitCode = 1;
			} else if (finalizationFailures.length) {
				await saveStatus({ ...savedStatus, accountingAudit: requestAudit,
					unquantifiedExecutedRunCount: missionLedger.opaqueExecutedRuns.length,
					unobservedControlDeliveryCount: missionLedger.unobservedControlDeliveries.length,
					outcome: "incomplete", archiveFailure: statusArchiveFailure,
					...(collectionFailure ? { collectionFailure } : {}), finalizationFailures,
					independentValidation: "not-complete" });
			}
		} catch (error) {
			statusArchiveFailure = recordFinalizationFailure(finalizationFailures,
				"mission-ledger-continuation-write-failed");
			const diagnostic = normalSealFailed ? undefined : privateExceptionDiagnostic(error, statusRuntimeKey);
			try {
				const statusFile = path.join(outputDir, "campaign-status.json");
				const savedStatus = existsSync(statusFile) ?
					JSON.parse(await readFile(statusFile, "utf8")) as Record<string, unknown> : {};
				await saveStatus({ ...savedStatus, outcome: "incomplete", archiveFailure: statusArchiveFailure,
					finalizationFailures,
					...(collectionFailure ? { collectionFailure } : {}),
					...(normalSealFailed ? { normalSealFailure: privateSealDiagnostic(normalSealFailure,
						"normal-continuation-seal") } : {}),
					...(emergencySealFailed ? { emergencySealFailure: privateSealDiagnostic(emergencySealFailure,
						"emergency-continuation-seal") } : {}),
					continuationDiagnostic: diagnostic?.message ?? null,
					continuationDiagnosticCategory: normalSealFailed ?
						(emergencySealFailed ? "emergency-seal-failed" : "emergency-carry-not-persisted") : diagnostic?.category });
			} catch { /* Encrypted outcome may contain only the earlier status. */ }
			process.exitCode = 1;
		}

	}
}

export const offlineChecks = { sourceShape, deriveRuntimeCases, m04EvidenceReturned, inputs, stageProbe, verifierScratch,
	checkCandidate, validateSelectedPriorTuple,
	createPrivateCampaignBudget,
	historicalGapEvidence,
	appendRestartReservation, appendRestartGoalBinding,
	privateFailureMessage, privateProviderErrorField, privateExceptionDiagnostic, privateSealDiagnostic,
	privateCollectionDiagnostic, privateSealOptions, privateEmergencyStatusDiagnostics,
	recordFinalizationFailure,
	writeSealedCarryFiles,
	credentialProbe, parseCheckerOutput, compareCandidateTimings,
	campaignObjectiveStop, taskTelemetry, privateToolTelemetry,
	chooseForkWinner, chooseFollowOnCandidate, firstM07Accepted, importM04EffectDisposition,
	retainPriorSelectionUntilM04Ready,
	selectedGoalBranchSatisfied,
	archivedM07ImportTarget, fixedPrivateChecks: { diagnostic: CHECKS, registered: REGISTERED_CHECKS },
	chooseArchivedM07ImportTarget,
	objectiveAssessmentRunCompleted,
	workflowRepairActionFacts,
	createOneUseRestartGoalBinder,
	shouldRepairRejectedReview, settledFailedM07RepairFeedback, freshM07RepairPlan,
	availablePrivateArtifactNames,
	initialHistoricalSelection,
	forkReceiptMatches, contextLineageSummary, selectedM07ReviewReadPaths, exportPrefixedArchive, preserveCandidate,
	preserveUnsettledGoalCheckpoint, preserveUnsettledBranchCheckpoint: preserveUnsettledGoalCheckpoint,
	salvageObjectiveCheckpoint, collectContinuationBundle, collectorFailureBundle,
	privateM04TransactionFacts, retainFailedM04Transaction, failedM04StopReason,
	retainM04TransactionOnDiagnosticFailure,
	buildHostEffectReceipt, observeTransport,
	unresolvedGoalControl, campaignObjectiveProgress, observedTransportActionFacts,
	observedRequestContract, archivedRequestContract,
	assessorGroundingPolicy,
	assessorEvidenceAccess,
	observedUnavailableCapabilities, frozenCapabilityLocators, OBJECTIVE_SUPPORTED_TASK_SCOPES,
	stagePriorGroundingRecords,
	canonicalUnresolvedOperationRefs, qualifiedOperationRef, reservedCanonicalOperationRefs,
	registeredSourceShape, parseRegisteredCheckerOutput, validateContinuationSeed, rangeReadableHistory,
	stageRangeReadableHistory, stageHistoricalM04RejectionEvidence, sandboxArguments,
	saveAssessorValidationDiagnostic, assessorDiagnosticFailureSnapshot, assessorDiagnosticFailureCause };

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const stopHeartbeat = startPrivateCampaignHeartbeat();
	main().catch(async error => {
		const preProvider = ["preflight", "mission-ledger-verification", "credential-probe", "credential-verified",
			"isolated-preflight-passed", "workspace-init", "private-inputs-staged",
			"provider-output-limit-verification", "provider-output-limit-verified",
			"billing-currency-verification", "billing-currency-verified", "billing-currency-unverified", "original-source-smoke",
			"prior-selected-revalidation", "independent-restart-admission",
			"source-and-isolation-preflight-passed"].includes(statusPhase);
		const diagnostic = privateExceptionDiagnostic(error, statusRuntimeKey);
		try { await saveStatus({ outcome: "incomplete", errorCategory: "campaign-exception",
			...(existsSync(path.join(statusOutputDir ?? "", "objective-checkpoint.json")) ?
				{ originalObjective: { outcome: "incomplete", checkpointFile: "objective-checkpoint.json" } } : {}),
			...(preProvider ? { privateDiagnostic: error instanceof SandboxPreflightError
				? error.privateDiagnostic : error instanceof Error ? error.message.slice(-2000) : "unknown pre-provider failure" } : {}),
			...(!preProvider ? { privateDiagnostic: diagnostic.message,
				exceptionCode: diagnostic.code, exceptionCategory: diagnostic.category } : {}),
			...(statusTaskTelemetry ? { taskTelemetry: statusTaskTelemetry } : {}),
			...(statusBranchTelemetry ? { branchTaskTelemetry: statusBranchTelemetry } : {}),
			...(statusArchiveFailure ? { archiveFailure: statusArchiveFailure } : {}),
			...(statusCredentialProbe ? { credentialProbe: statusCredentialProbe } : {}),
			...(statusAuthSource ? { sdkAuthSource: statusAuthSource } : {}),
			...(statusSdkAuthMatch !== undefined ? { sdkAuthMatch: statusSdkAuthMatch } : {}),
			independentValidation: "not-complete" }); } catch { /* transport synthesizes an incomplete status */ }
		// Never print the model response, source, input paths, credential, or raw provider errors.
		console.error(JSON.stringify({ status: "private-campaign-failed", category: "campaign-exception" }));
		process.exitCode = 1;
	}).finally(stopHeartbeat);
}
