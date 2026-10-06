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
import { assessAndAdvanceOriginalObjective, createOriginalObjective, objectiveProgress, runOriginalObjectiveLoop,
	writeObjectiveProgress, writeOriginalObjectiveContract } from "../src/m07/objective-progress.ts";
import type { ObjectiveProgressV1, ObjectiveStopReason, OriginalObjectiveContractV1 } from "../src/m07/objective-progress.ts";
import type { CurrentGoal, M07TaskRecord, TaskSpecInput } from "../src/m07/types.ts";
import { runM04 } from "../src/stages/m04.ts";
import { createPiSessionRunner } from "../src/runner/pi.ts";
import type { SessionCheckpoint, SessionHandle, SessionRunner, SessionSpec } from "../src/runner/types.ts";
import { DeepSeekCampaignBudget } from "../src/runner/deepseek-campaign.ts";
import { verifyDeepSeekCnyBilling, type NativeCnyPricingProfile } from "../src/runner/deepseek-cny-pricing.ts";
import { verifyDeepSeekProviderOutputLimit,
	type DeepSeekProviderOutputLimit } from "../src/runner/deepseek-provider-limits.ts";
import { MISSION_ID, MISSION_REPOSITORY, MISSION_TOTAL_CNY, PRIVATE_CONTINUATION_FILE_KEYS } from
	"../src/runner/signed-mission-ledger.ts";
import { CARRY_FILE_NAME, authenticatedPriorCarryBindsAncestor, authenticatedPriorCarryBindsBundle, downloadCarryArtifact,
	isAuthenticatedPriorCarryProof, openLedgerContinuation,
	type PrivateContinuationBundle } from "../src/runner/ledger-continuation.ts";
import { reviewPrivateCampaignRestartEffects } from "../src/runner/private-campaign-restart-policy.ts";
import { bindIndependentRestartGoal, canonicalRestartUnknowns, reserveIndependentRestart,
	type AuthenticatedRestartCarryFacts, type IndependentRestartReservation,
	type ReviewedRestartEffectPolicy } from "../src/m07/independent-restart.ts";
import { createConfinedCampaignFileTools } from "../src/runner/confined-campaign-files.ts";
import { archivePrivateM07Task, recordPrivateM04Outcome } from "../src/workflow-archive/m07-private.ts";
import { buildCsrChecker as buildLegacyCsrChecker } from "../src/workflow-archive/csr-checker-legacy.ts";
import { buildCsrChecker, inspectCsrTaskContract, validateCsrCandidateSource, validateCsrTargetBodies, CSR_EXPERIMENT_LIMITS, type CsrExperimentPlan } from "../src/workflow-archive/csr-checker.ts";
import { createExperienceProvider } from "../src/knowledge/experience-index.ts";
import type { KnowledgeRef, KnowledgeStore } from "../src/knowledge/types.ts";
import type { StageRunRecord } from "../src/types.ts";

const MODEL = "deepseek/deepseek-flash:low";
// Legacy compatibility only: review of this one immutable historical adapter.
// Later source revisions require their own host effect review and must fail closed.
const LEGACY_RESTART_POLICY = Object.freeze({ version: 1,
	policyId: "mul-pis-legacy-confined-private-campaign-v1",
	sourceCommit: "2fe7f132370b4598c942625fad1a7e9129978eaa",
	reviewedBoundary: "Pi execution sessions received only confined text-file read/write/edit tools; built-in shell and network tools were not granted. The host verifier ran in a non-root bubblewrap user, network, PID and IPC namespace. Host output went only through the fixed encrypted Actions result archive. Provider billing remains unknown and held.",
	effectClass: "confined-ephemeral-local", actorThirdPartyMutations: "none",
	hostTransport: "immutable-versioned-archive" });
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
const ARCHIVE_BASE_EVIDENCE_FILES = ["candidate.cpp", "verification.json", "lesson-delta.json", "experiment-plan.json", "review-decision.json"];
const roundEvidenceName = (name: string): boolean => /^round-[1-9][0-9]*-(?:candidate\.cpp|verification\.json|reviewer-feedback\.txt|reviewer-report\.md)$/.test(name);
const availablePrivateArtifactName = (name: string): boolean =>
	/^(?:candidate\.cpp|verification\.json|experiment-plan\.json|lesson-delta\.json|execution-capabilities\.json|research-history\.json|restored-candidate-verification\.json|workflow-(?:archive|[A-Za-z0-9-]+-archive)\.json|round-[1-9][0-9]*-(?:candidate\.cpp|verification\.json|reviewer-feedback\.txt|reviewer-report\.md)|(?:branch-parent|branch-child|iteration-[1-9][0-9]*|fallback-[0-9a-f]{12}-T[0-9]{3,}|followon|initial)-(?:candidate\.cpp|verification\.json|experiment-plan\.json|round-[1-9][0-9]*-(?:reviewer-feedback\.txt|reviewer-report\.md)))$/.test(name);
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
	input: Parameters<typeof objectiveProgress>[1]): ObjectiveProgressV1 {
	return objectiveProgress(contract, { ...input,
		unresolvedOperationIds: [...new Set([...inheritedUnresolvedOperationIds,
			...(input.unresolvedOperationIds ?? [])])] });
}
function sha256(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function createPrivateCampaignBudget(priorCommittedCny: number,
	nativeCnyPricing: NativeCnyPricingProfile,
	providerOutputLimit: DeepSeekProviderOutputLimit): DeepSeekCampaignBudget {
	return new DeepSeekCampaignBudget({ model: MODEL, endpoint: "https://api.deepseek.com",
		maxCny: MISSION_TOTAL_CNY, priorCommittedCny,
		providerOutputLimit, outputAccountingMarginTokens: 32,
		estimatedInputCnyPerMillionTokens: 2,
		estimatedCacheReadCnyPerMillionTokens: 0.04,
		estimatedOutputCnyPerMillionTokens: 8,
		nativeCnyPricing });
}
function reviewedLegacyRestartEffects(facts: AuthenticatedRestartCarryFacts,
	operationRefs: readonly string[]): ReviewedRestartEffectPolicy {
	if (facts.source.commit !== LEGACY_RESTART_POLICY.sourceCommit || !operationRefs.length ||
		facts.unknownHeldNano < 1 || facts.resultArtifact.digestScope !== "github-artifact-archive")
		fail("no reviewed legacy source/effect policy covers this independent restart");
	const policySha256 = sha256(JSON.stringify(LEGACY_RESTART_POLICY));
	return { sourceCommit: facts.source.commit, policyId: LEGACY_RESTART_POLICY.policyId,
		policySha256, operationAttestations: operationRefs.map(operationRef => ({ operationRef,
			sourceCommit: facts.source.commit,
			evidenceSha256: sha256(JSON.stringify({ policySha256, operationRef,
				resultArtifact: facts.resultArtifact })) })),
		effectClass: "confined-ephemeral-local", unknownBillingHeld: true,
		actorThirdPartyMutations: "none", hostTransport: "immutable-versioned-archive" };
}
function authenticatedLegacyCarryFacts(proof: unknown,
	bundle: PrivateContinuationBundle): AuthenticatedRestartCarryFacts | undefined {
	if (!isAuthenticatedPriorCarryProof(proof) || !authenticatedPriorCarryBindsBundle(proof, bundle) ||
		!proof.resultArtifact || proof.resultArtifact.digestScope !== "github-artifact-archive") return undefined;
	const artifact = proof.resultArtifact;
	const immutableRef = `github-actions://${artifact.repository}/runs/${artifact.runId}/artifacts/${artifact.artifactId}/${artifact.artifactName}`;
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
		resultArtifact: { immutableRef, digestScope: artifact.digestScope,
			sha256: artifact.archiveSha256 },
		committedNano: Math.ceil(proof.priorCommittedCny * 1_000_000_000),
		unknownHeldNano: Math.ceil(proof.priorUnknownHeldCny * 1_000_000_000) };
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
			if (receipt?.version !== 1 || receipt.kind !== "host-independent-goal-quarantine" ||
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
		.replace(/Authorization\s*[:=]\s*[^\r\n]+/gi, "Authorization: [REDACTED_KEY]");
	value = value.slice(0, 4000);
	if (value.includes(runtimeKey) || /sk-[A-Za-z0-9_-]{6,}/i.test(value) ||
		/Bearer\s+(?!\[REDACTED_KEY\])/i.test(value)) return undefined;
	return value;
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
function campaignObjectiveStop(reason: string | undefined): ObjectiveStopReason | undefined {
	if (reason === "total-cny-ceiling") return "budget-boundary";
	if (reason === "provider-call-limit") return "provider-call-limit";
	if (reason === "output-limit") return "output-limit";
	if (reason === "price-assumption-invalid") return "accounting-integrity-error";
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
		...(statusPriorSelectedValidation ? { priorSelectedValidation: statusPriorSelectedValidation } : {}), ...value }, null, 2),
		{ mode: 0o600 });
	await rename(temporary, target);
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
	let canonicalTaskId = await archivedIdentity("workflow-archive.json");
	let branchTaskId = await archivedIdentity("workflow-branch-child-archive.json");
	for (const [index, task] of tasks.entries()) {
		if (task.taskId === canonicalTaskId || task.taskId === branchTaskId) continue;
		if (index === 0 && !existsSync(path.join(outputDir, "workflow-archive.json"))) {
			await archivePrivateM07Task({ goal, task, destination: outputDir });
			canonicalTaskId = task.taskId;
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
			if (prefix === "branch-child") branchTaskId = task.taskId;
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
		previous.stopReason !== "assessment-validation-pending" && unresolvedOperationIds.length === 0 &&
		(!cancelled || previous.stopReason === "cancelled") &&
		(budgetStopReason !== "total-cny-ceiling" || previous.stopReason === "budget-boundary") &&
		(budgetStopReason !== "provider-call-limit" || previous.stopReason === "provider-call-limit") &&
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
	if (!(["initial", "followon", "branch-parent", "branch-child"].includes(prefix) ||
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
	return refs.slice(0, 24);
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
function initialHistoricalSelection(selectedCandidateSource: "initial" | "fork" | "followon" | "none",
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

/** Keep selected evidence as one coherent tuple, never combine a new failed source with an old acceptance. */
async function collectContinuationBundle(directory: string, prior?: PrivateContinuationBundle): Promise<PrivateContinuationBundle | undefined> {
	const current: PrivateContinuationBundle = {};
	for (const name of PRIVATE_CONTINUATION_FILE_KEYS) {
		const file = path.join(directory, name);
		if (!existsSync(file)) continue;
		const info = await lstat(file);
		if (!info.isFile() || info.isSymbolicLink() || info.size > 4 * 1024 * 1024)
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
	if (prior && accepted && prior["workflow-archive.json"] !== current["workflow-archive.json"]) {
		const archived = JSON.parse(prior["workflow-archive.json"] ?? "null");
		const checkpoint = JSON.parse(prior["objective-checkpoint.json"] ?? "null");
		if (!archived?.goalRunId || !archived.taskId || !checkpoint?.contract?.id) fail("historical tuple lacks version binding");
		if (!history.entries.some((entry: Record<string, unknown>) => entry.goalRunId === archived.goalRunId && entry.taskId === archived.taskId))
			history.entries.push({ originalContractId: checkpoint.contract.id, goalRunId: archived.goalRunId,
				taskId: archived.taskId, interpretation: "Untrusted historical development evidence; prior adoption is not current truth",
				files: Object.fromEntries(["candidate.cpp", "verification.json", "workflow-archive.json",
					"experiment-plan.json", "m04-adopted-knowledge.json"].filter(name => prior[name as keyof typeof prior] !== undefined)
					.map(name => [name, prior[name as keyof typeof prior]])) });
	}
	// Preserve failed experiments as version-bound development evidence, separate
	// from the coherent selected source/verification/review tuple.
	const checkpoint = JSON.parse(current["objective-checkpoint.json"] ?? prior?.["objective-checkpoint.json"] ?? "null");
	const contractId = checkpoint?.contract?.id;
	if (typeof contractId === "string" && contractId) {
		const archives = ["workflow-archive.json", ...(await readdir(directory))
			.filter(name => /^workflow-(?:(?:initial|followon|branch-parent|branch-child)|iteration-[1-9][0-9]*|fallback-[0-9a-f]{12}-T[0-9]{3,})-archive\.json$/.test(name))];
		for (const archiveName of archives) {
			const archiveFile = path.join(directory, archiveName);
			if (!existsSync(archiveFile)) continue;
			const archiveText = await readFile(archiveFile, "utf8");
			const archive = JSON.parse(archiveText) as Record<string, any>;
			if (archive?.version !== 1 || archive.kind !== "m07-private-candidate-archive" ||
				(accepted && archiveName === "workflow-archive.json") ||
				!/^T\d{3,}$/.test(String(archive.taskId)) || typeof archive.goalRunId !== "string" ||
				history.entries.some((entry: Record<string, unknown>) =>
					entry.goalRunId === archive.goalRunId && entry.taskId === archive.taskId)) continue;
			const prefix = archiveName === "workflow-archive.json" ? "" : archiveName.slice("workflow-".length, -"-archive.json".length) + "-";
			const files: Record<string, string> = { "workflow-archive.json": archiveText };
			for (const name of ["candidate.cpp", "verification.json", "experiment-plan.json", "lesson-delta.json",
				...(await readdir(directory)).filter(name => name.startsWith(prefix) &&
					/^round-[1-9][0-9]*-reviewer-feedback\.txt$/.test(name.slice(prefix.length)))
					.map(name => name.slice(prefix.length))]) {
				const file = path.join(directory, `${prefix}${name}`);
				if (!existsSync(file)) continue;
				const info = await lstat(file);
				if (!info.isFile() || info.isSymbolicLink() || info.size > 1_000_000)
					fail("unselected campaign evidence must be a bounded regular file");
				files[name] = await readFile(file, "utf8");
			}
			history.entries.push({ originalContractId: contractId, goalRunId: archive.goalRunId,
				taskId: archive.taskId,
				interpretation: "Unselected or unresolved experiment; measurements and review do not establish a replacement for the selected candidate",
				files });
		}
	}
	if (history.entries.length) selected["research-history.json"] = JSON.stringify(history);
	for (const name of ["original-objective.json", "objective-checkpoint.json", "objective-assessment-receipts.json",
		"independent-restart-quarantine.json", "independent-restart-goal-binding.json"] as const)
		if (current[name]) selected[name] = current[name];
	if (Buffer.byteLength(JSON.stringify(selected), "utf8") > 4 * 1024 * 1024)
		fail("research continuation exceeds the authenticated carry capacity");
	return selected;
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
		loadCarryArtifact: ({ artifactId }) => downloadCarryArtifact({ githubToken: githubToken ?? "", artifactId }),
		current: { repository: process.env.GITHUB_REPOSITORY, runId: process.env.GITHUB_RUN_ID,
			runAttempt: process.env.GITHUB_RUN_ATTEMPT, actor: process.env.GITHUB_ACTOR,
			event: process.env.GITHUB_EVENT_NAME, ref: process.env.GITHUB_REF,
			sha: process.env.GITHUB_SHA, manualAuthorized: process.env.MULPIS_MANUAL_AUTHORIZED } });
	let finalBudget: DeepSeekCampaignBudget | undefined;
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
	const nativeCnyPricing = await verifyDeepSeekCnyBilling({ apiKey: runtimeKey });
	statusPhase = "billing-currency-verified";
	const found = await inputs(inputDir);
	await requireIsolation(); // fail before any provider call
	statusPhase = "isolated-preflight-passed";
	const campaignRoot = await mkdtemp(path.join(os.tmpdir(), "mulpis-private-campaign-"));
	let runId: string | undefined;
	const budget = createPrivateCampaignBudget(missionLedger.priorCommittedCny,
		nativeCnyPricing, providerOutputLimit);
	statusBudget = budget;
	finalBudget = budget;
	let campaignCancelled = false;
	try {
		const ws = new Workspace(path.join(campaignRoot, "workspace"));
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
		const priorNeedsQuarantine = previousCheckpoint.continuation.requiresOperationReconciliation ||
			previousCheckpoint.continuation.unresolvedOperationIds.length > 0 ||
			previousCheckpoint.boundedRuns.some(run => (run.unresolvedOperationIds?.length ?? 0) > 0);
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
		if (previousBundle["research-history.json"]) await writeFile(path.join(priorSeedDir, "prior-research-history.json"), rangeReadableHistory(previousBundle["research-history.json"]), { mode: 0o600 });
		const priorSeedInputs = ["objective-seeds/prior-objective-checkpoint.json",
			...(previousBundle["research-history.json"] ? ["objective-seeds/prior-research-history.json"] : []),
			...(previousBundle["m04-adopted-knowledge.json"] ? ["objective-seeds/prior-m04-knowledge.json"] : []),
			"objective-seeds/prior-candidate.cpp", "objective-seeds/prior-verification.json",
			"objective-seeds/prior-archive.json",
			...(previousBundle["experiment-plan.json"] ? ["objective-seeds/prior-experiment-plan.json"] : [])];
		const originalObjective = previousCheckpoint.contract;
		// A historical contract is immutable; current user overrides enter prompts separately.
		const objectiveContractFile = path.join(outputDir, "original-objective.json");
		const objectiveCheckpointFile = path.join(outputDir, "objective-checkpoint.json");
		await writeOriginalObjectiveContract(objectiveContractFile, originalObjective);
		await writeObjectiveProgress(objectiveCheckpointFile, previousCheckpoint);
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
		let restartReservation: IndependentRestartReservation | undefined;
		if (priorNeedsQuarantine) {
			statusPhase = "independent-restart-admission";
			const priorProof = missionLedger.priorCarryProof;
			const facts = authenticatedLegacyCarryFacts(priorProof, previousBundle);
			if (!facts) throw new SandboxPreflightError("authenticated terminal carry and fixed encrypted-result artifact proof unavailable; independent restart refused");
			restartReservation = await reserveIndependentRestart({ authenticatedCarryProof: priorProof,
				privateBundle: previousBundle, freshWorkspace: { workspaceId: path.basename(campaignRoot),
					restartNonce: randomBytes(16).toString("hex") },
				failedHistory: { state: "unavailable", reason: "The prior failed source, experiment plan and reviewer feedback are sealed in the encrypted result artifact and unavailable to this runner; the earlier accepted candidate is separate development evidence.",
					immutableArtifactRef: facts.resultArtifact.immutableRef,
					digestScope: facts.resultArtifact.digestScope,
					artifactSha256: facts.resultArtifact.sha256 } }, {
				authenticatedFacts: proof => proof === priorProof ? authenticatedLegacyCarryFacts(proof, previousBundle) : undefined,
				reviewEffects: async (authenticated, operationRefs) =>
					authenticated.source.commit === LEGACY_RESTART_POLICY.sourceCommit ?
						reviewedLegacyRestartEffects(authenticated, operationRefs) :
						reviewPrivateCampaignRestartEffects({ facts: authenticated, operationRefs,
							privateBundle: previousBundle, proof: priorProof,
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
			await writeFile(gapFile, `${JSON.stringify({ version: 1, kind: "untrusted-private-history-gap",
				selectedCandidate: "earlier accepted bounded task; current correctness was revalidated without adopting old timings",
				laterFailedAttempt: "encrypted and unavailable to this runner; source, plan, verification and feedback must not be inferred",
				oldOperationOutcome: "unknown and quarantined; provider cost hold remains",
				newExecution: "independent fresh workspace and goal only; old task is not resumed or reconciled" }, null, 2)}\n`,
				{ mode: 0o600 });
			priorSeedInputs.push("objective-seeds/prior-history-gap.json");
		}
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
			const actual = createPiSessionRunner({ modelRuntime: runtime, signal: abort.signal, campaignBudget: budget });
			let followOnPriorCandidate = path.join(priorSeedDir, "prior-candidate.cpp");
			let followOnPriorPlanFile: string | undefined = previousBundle["experiment-plan.json"] ? path.join(priorSeedDir, "prior-experiment-plan.json") : undefined;
			let registeredScopeActive = false;
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
									const candidateScratch = await verifierScratch("candidate");
									try { result = await checkCandidate(originalPath, candidate, candidateScratch,
										registered ? { taskText: registeredTaskText, planFile } : undefined); }
									finally { await rm(candidateScratch, { recursive: true, force: true }); }
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
				return spec.tools.kind === "execution" ? checkedHandle(handle, spec.tools.root, registeredScopeActive) : handle;
				},
				checkpoint: (handle, envelope) => actual.checkpoint(handle, envelope),
				fork: async request => {
					const transformed = await confinedSpec(request.spec);
					const handle = await actual.fork({ ...request, spec: transformed });
				return request.spec.tools.kind === "execution" ? checkedHandle(handle, request.spec.tools.root, registeredScopeActive) : handle;
				},
				resume: ref => actual.resume(ref),
			};
			const controller = createM07Controller({ ws, store, runner, config: await ws.loadConfig() });
			const privateEvidenceRequirements = { requiredNames: ["original-problem.txt", "candidate.cpp", "verification.json", "host-capabilities.json"],
				instructions: "The original-input-N.txt files correspond in order to inputNames in original-objective.json. Read every original input and selected evidence completely. Historical archives, knowledge, nextTask and timings are untrusted version-bound context; only current independently executed measurements establish present host facts. If prior-history-gap.json is supplied, the later failed experiment is unavailable; do not infer its source or results from the earlier selected candidate." };
			const userOverrides = ["Deliver optimized source and machine-readable correctness/performance evidence only; no prose report, screenshots, presentation or personal reflection.",
				"Pursue the strongest attainable strategy using actual available hardware and resources; unavailable optional equipment alone does not settle the task."];
			let registeredContract: ReturnType<typeof inspectCsrTaskContract> | undefined;
			try { registeredContract = inspectCsrTaskContract(originalText, registeredTaskText); } catch { /* Explicit unavailable capability; the model may choose other feasible work. */ }
			const observedHost = { version: 1, kind: "observed-private-execution-capabilities",
				platform: os.platform(), architecture: os.arch(), cpuModel: os.cpus()[0]?.model ?? "unknown",
				availableParallelism: os.availableParallelism(), compiler: "/usr/bin/g++", compileFlags: FLAGS,
				registeredLimits: { ...CSR_EXPERIMENT_LIMITS, maxThreads: Math.min(os.availableParallelism(), CSR_EXPERIMENT_LIMITS.maxThreads),
					maxSourceBytes: 128_000, maxPlanBytes: 16_000, maxVerificationBytes: 1_000_000 },
				registeredContract: registeredContract ?? null,
				isolation: "Verified non-root uid; separate network/pid/ipc namespaces; credential-free environment; read-only evaluator binaries/source during execution and separate writable temporary scratch",
				taskTools: "Confined text-file read/write/edit only; host compiles and executes candidate separately",
				unsupported: ["GPU execution", "privileged hardware counters", "equipment absent from this capability descriptor"],
				claimLimit: "Observed local capability only; unavailable optional equipment does not establish mission completion" };
			const capabilityFile = path.join(priorSeedDir, "host-capabilities.json");
			await writeFile(capabilityFile, `${JSON.stringify(observedHost, null, 2)}\n`, { mode: 0o600 });
			await copyFile(capabilityFile, path.join(outputDir, "execution-capabilities.json"));
			priorSeedInputs.push("objective-seeds/host-capabilities.json");
			const experimentInstructions = [
				"Produce experiment-plan.json with {registeredStrategies: string[], cases: [{id, rows, cols, normalNnz, longRows, longNnz, seed, threadCounts, warmups, repeats}]}.",
				"Choose every scientific strategy and case yourself from the supplied original task. Read host-capabilities.json for actual limits; those limits describe this executor, not a smaller scientific mission.",
				registeredContract?.sourceScope ?? "Registered execution is unavailable for this input shape.",
				registeredContract?.timingScope ?? "No registered measurement capability verified.",
				"Total bounded timed work is sum(nonzeros * thread-choice-count * (1 + warmups + repeats) * (registered-strategy-count + 2)). Every strategy must be registered. Retain limitations and feasible untested work in machine-readable evidence.",
			].join(" ");
			const objectiveCapabilities = [
				{ scope: "two-target-existing" as const, available: false,
					description: "Historical in-process adapter, retained only for original-source diagnostics",
					limits: ["Use registered-csr-experiment for fresh execution of the same original bodies or wider permitted variants; model must choose the plan"] },
				{ scope: "registered-csr-experiment" as const, available: Boolean(registeredContract),
					description: "Model-authored registered strategies/cases with a separate independent CPU checker and per-target measurements",
					limits: [`observed CPU parallelism ${os.availableParallelism()}`,
						registeredContract?.sourceScope ?? "task contract shape is unsupported",
						"Read host-capabilities.json for the complete measured capability and allocation limits"] },
				{ scope: "outside-current-adapter" as const, available: false,
					description: "Changes or equipment outside the verified source and measurement adapters",
					limits: ["requires a different verifier and capability proof"] },
			];

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
				...(previousBundle["research-history.json"] ? [{ name: "prior-research-history.json", file: path.join(priorSeedDir, "prior-research-history.json") }] : []),
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
			];
			if (previousBundle["m04-adopted-knowledge.json"])
				await writeFile(path.join(priorSeedDir, "prior-m04-knowledge.json"), previousBundle["m04-adopted-knowledge.json"], { mode: 0o600 });
			statusPhase = "prior-objective-assessment";
			const firstStep = await assessAndAdvanceOriginalObjective({
				contract: originalObjective, contractFile: objectiveContractFile, runner: actual,
				runRecord: firstAssessmentRecord, persistReceipt: () => persistObjectiveReceipt(firstAssessmentRecord),
				sessionSpec: { label: "M07-prior-objective-assessment", role: "research", model: MODEL,
					systemPrompt: "Assess the unchanged user objective and all frozen prior evidence. Choose the next scientific work yourself under observed host capabilities. Read every supplied original input and selected evidence before deciding; report uncertainty honestly.",
					persistDir: ws.sessionsDir },
				evidenceRoot: path.join(campaignRoot, "prior-objective-evidence"), evidence: priorEvidence,
				evidenceRequirements: privateEvidenceRequirements,
				assessmentAdmission: budget.snapshot().stopped ? "budget-boundary" :
					abort.signal.aborted ? "cancelled" : "admitted",
				advanceAdmission: () => budget.snapshot().stopped ? campaignObjectiveStop(budget.snapshot().stopReason) ??
					"assessment-failed" : abort.signal.aborted ? "cancelled" : "admitted",
				supportedTaskScopes: ["two-target-existing", "registered-csr-experiment"],
				capabilities: objectiveCapabilities, userOverrides,
				recordAssessment: async assessment => {
					await writeObjectiveProgress(objectiveCheckpointFile, campaignObjectiveProgress(originalObjective,
						historicalUnresolvedOperationIds, {
						boundedRuns: previousCheckpoint.boundedRuns, selectedArtifacts: previousCheckpoint.selectedArtifacts,
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
					if (restartReservation) await bindIndependentRestartGoal(restartReservation, goal.runId,
						async binding => {
							const bindingRef = "independent-restart-goal-binding.json";
							await appendRestartGoalBinding(outputDir, previousBundle, binding);
							return { bindingRef, bindingSha256: sha256(JSON.stringify(binding)) };
						});
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
			await ws.finishRun(firstAssessmentRecord, firstStep.assessment?.unreadEvidence.length === 0 ? "completed" : "failed");
			await persistObjectiveReceipt(firstAssessmentRecord);
			if (!firstStep.advanced) {
				await writeObjectiveProgress(objectiveCheckpointFile, campaignObjectiveProgress(originalObjective,
					historicalUnresolvedOperationIds, {
					boundedRuns: previousCheckpoint.boundedRuns, selectedArtifacts: previousCheckpoint.selectedArtifacts,
					...(firstStep.assessment ? { assessment: firstStep.assessment } : {}),
					assessmentHistory: [...previousCheckpoint.assessmentHistory,
						...(firstStep.assessment ? [{ iteration: previousCheckpoint.assessmentHistory.length + 1,
							assessment: firstStep.assessment, stopReason: firstStep.stopReason, advanced: false }] : [])],
					stopReason: firstStep.stopReason }));
				await saveStatus({ outcome: "incomplete", originalObjective: { id: originalObjective.id,
					stopReason: firstStep.stopReason, checkpointFile: "objective-checkpoint.json" },
				independentValidation: "prior selected source retained; no new bounded M07 dispatched" });
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
			const accepted = task.status === "returned" && task.loopStopReason === "ready" && parentResult?.status === "passed";
			if (task.status === "returned" && task.reportPath) {
				statusPhase = "parent-review";
				const review = await controller.review(runId, { taskId: task.taskId,
					checks: initialChecks.map((criterion, i) => ({ criterion, result: accepted ? "passed" : "failed",
						evidence: accepted ? [i === 0 ? parentCandidate : parentVerification] : [] })),
					artifacts: [...(initialRegistered && existsSync(path.join(task.workDir, "experiment-plan.json")) ? [path.join(task.workDir, "experiment-plan.json")] : []), task.reportPath, ...(existsSync(parentCandidate) ? [parentCandidate] : []), ...(existsSync(parentVerification) ? [parentVerification] : [])],
					failures: accepted ? [] : ["bounded candidate did not pass all observed checks"] });
				if (accepted && review.status !== "accepted") fail("M07 review did not accept candidate");
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
				branchAccepted = forked.status === "returned" && forked.loopStopReason === "ready" && branchResult?.status === "passed";
				let forkReviewStatus = forked.status;
				if (forked.status === "returned" && forked.reportPath) {
					statusPhase = "fork-review";
					const reviewed = await controller.review(runId, { taskId: forked.taskId,
						checks: initialChecks.map((criterion, i) => ({ criterion, result: branchAccepted ? "passed" : "failed",
							evidence: branchAccepted ? [i === 0 ? branchCandidate : branchVerification] : [] })),
						artifacts: [...(initialRegistered && existsSync(path.join(forked.workDir, "experiment-plan.json")) ? [path.join(forked.workDir, "experiment-plan.json")] : []), forked.reportPath, ...(existsSync(branchCandidate) ? [branchCandidate] : []),
							...(existsSync(branchVerification) ? [branchVerification] : [])],
						failures: branchAccepted ? [] : ["forked candidate did not pass all observed checks"] });
					forkReviewStatus = reviewed.status;
					if (branchAccepted && reviewed.status !== "accepted") fail("forked M07 review did not accept candidate");
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
			// A failed or interrupted parent can leave an issued provider operation unknown.
			// finish() must never be used to turn that state into a partial terminal goal.
			const firstGoalControl = unresolvedGoalControl(await controller.status(runId));
			if (firstGoalControl.operationIds.length || firstGoalControl.taskIds.length) {
				statusPhase = "first-goal-unsettled";
				const boundary = await preserveUnsettledGoalCheckpoint({ ws, runId, outputDir,
					contract: originalObjective, budgetStopReason: budget.snapshot().stopReason });
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
			const acceptedWinner = branchExerciseComplete && Boolean(winner);
			const selectedTask = winner ?? task;
			let candidate = path.join(selectedTask.workDir, "candidate.cpp");
			let verificationPath = path.join(selectedTask.workDir, "verification.json");
			statusPhase = "first-goal-finishing";
			const finished = await controller.finish(runId, { outcome: acceptedWinner ? "fulfilled" : "partial", returnPath: "user",
				summary: acceptedWinner ? "M07 builder, true refinement fork, fresh reviews and measured branch selection completed." :
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
			let finalArchive = privateArchive;
			let selectedCandidateSource: "initial" | "fork" | "followon" | "none" = firstGoalReady ?
				selectedTask.taskId === task.taskId ? "initial" : "fork" : "none";
			let m04: { status: "completed" | "failed" | "not_run"; runId?: string; proposalSubmitted?: boolean;
				snapshotCreated?: boolean; evidenceReturned?: boolean; adoptedExperienceRefs?: KnowledgeRef[];
				failure?: ReturnType<typeof privateExceptionDiagnostic> } = { status: "not_run" };
			if (firstGoalReady && branchExerciseComplete && !budget.snapshot().stopped && !abort.signal.aborted) {
				statusPhase = "m04-dispatch";
				try {
					const m04Runner = createPiSessionRunner({ modelRuntime: runtime,
						signal: abort.signal, campaignBudget: budget });
					const processed = await runM04({ ws, store, runner: m04Runner, config: await ws.loadConfig() },
						{ feedback: { kind: "M07", runId }, freshSession: true,
							requiredM07ReadPaths: selectedM04ReadPaths,
							purpose: "Adjudicate bounded M07 candidate lessons and limits" });
					const complete = processed.record.status === "completed" && processed.record.failures.length === 0;
					const coverage = firstGoalReady ? await m04EvidenceReturned(processed.record, selectedTask.taskId,
						initialRegistered ? ["experiment-plan.json"] : []) :
						{ complete: false, paths: [] };
					m04 = { status: complete ? "completed" : "failed", runId: processed.record.runId,
						proposalSubmitted: Boolean(processed.proposalId), snapshotCreated: Boolean(processed.snapshotId),
						evidenceReturned: coverage.complete && selectedM04ReadPaths.every(item => coverage.paths.includes(item)),
						adoptedExperienceRefs: complete ? await adoptedExperienceRefs(store, processed.record.runId,
							coverage.complete && selectedM04ReadPaths.every(item => coverage.paths.includes(item))) : [] };
				} catch (error) { m04 = { status: "failed", adoptedExperienceRefs: [],
					failure: privateExceptionDiagnostic(error, runtimeKey) }; }
			}
			const archivedM04 = await recordPrivateM04Outcome(outputDir, { state: m04.status === "not_run" ? "not-run" : m04.status,
				...(m04.runId ? { runId: m04.runId } : {}), proposalSubmitted: m04.proposalSubmitted ?? false,
				snapshotCreated: m04.snapshotCreated ?? false, adoptedExperienceRefs: m04.adoptedExperienceRefs ?? [] }, store);
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
			let latestAssessmentAdvanced = false;
			const assessmentHistory: ObjectiveProgressV1["assessmentHistory"] = [...previousCheckpoint.assessmentHistory,
				...(firstStep.assessment ? [{ iteration: previousCheckpoint.assessmentHistory.length + 1,
					assessment: firstStep.assessment, stopReason: firstStep.stopReason, advanced: true }] : [])];
			const priorAssessmentCount = assessmentHistory.length;
			let objectiveStopReason: ObjectiveStopReason = "bounded-run-incomplete";
			let currentM04Status = m04.status;
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
					if (currentM04Status === "failed") return "m04-evidence-incomplete";
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
					const assessmentAdmission = "admitted";
					let objectiveStep;
					try { objectiveStep = await assessAndAdvanceOriginalObjective({
						contract: originalObjective, contractFile: objectiveContractFile,
						runner: actual, runRecord: objectiveRecord, persistReceipt: saveObjectiveReceipt,
						sessionSpec: { label: `M07-original-objective-assessment-${iteration}`, role: "research", model: MODEL,
							systemPrompt: "Independently assess the original research goal using the frozen evidence. Read the complete supplied files before proposing further work. Return only the requested structured judgment; acknowledge uncertainty, bounded search scope and failed checks. Do not invent measurements or treat M04 adoption as proof of performance.",
							persistDir: ws.sessionsDir },
						evidenceRoot: path.join(campaignRoot, `objective-evidence-${iteration}`), evidence,
						evidenceRequirements: privateEvidenceRequirements,
						assessmentAdmission,
						advanceAdmission: () => budget.snapshot().stopped ?
							campaignObjectiveStop(budget.snapshot().stopReason) ?? "assessment-failed" :
							abort.signal.aborted ? "cancelled" : "admitted",
						supportedTaskScopes: ["two-target-existing", "registered-csr-experiment"],
						userOverrides, capabilities: objectiveCapabilities,
						recordAssessment: async assessment => {
							objectiveAssessment = assessment;
							assessmentThisIteration = true;
							if (assessmentHistory.at(-1)?.iteration === iteration)
								assessmentHistory[assessmentHistory.length - 1] = { iteration, assessment,
									stopReason: "assessment-validation-pending", advanced: false };
							else assessmentHistory.push({ iteration, assessment, stopReason: "assessment-validation-pending", advanced: false });
							await writeObjectiveProgress(objectiveCheckpointFile, campaignObjectiveProgress(originalObjective,
								historicalUnresolvedOperationIds,
								{ boundedRuns: [...previousCheckpoint.boundedRuns, { runId: runId!, outcome: finished.outcome ?? "unknown",
									...(firstGoalReady ? { selectedTaskId: selectedTask.taskId } : {}) }],
									selectedArtifacts: ["candidate.cpp", "verification.json", "workflow-archive.json"],
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
						await ws.finishRun(objectiveRecord, objectiveStep.assessment?.unreadEvidence.length === 0 ? "completed" : "failed");
						await saveObjectiveReceipt();
					} catch (error) {
						objectiveRecord.failures.push("Original objective assessment or model-proposed bounded dispatch failed");
						await ws.finishRun(objectiveRecord, "failed").catch(() => undefined);
						await saveObjectiveReceipt().catch(() => undefined);
						throw error;
					}
					objectiveAssessment = objectiveStep.assessment;
					latestAssessmentAdvanced = Boolean(objectiveStep.advanced);
					objectiveStopReason = objectiveStep.stopReason === "assessment-failed" && campaignObjectiveStop(budget.snapshot().stopReason) ?
						campaignObjectiveStop(budget.snapshot().stopReason)! : objectiveStep.stopReason === "assessment-failed" &&
						(abort.signal.aborted) ? "cancelled" : objectiveStep.stopReason;
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
								const m04Runner = createPiSessionRunner({ modelRuntime: runtime,
									signal: abort.signal, campaignBudget: budget });
								const processed = await runM04({ ws, store, runner: m04Runner, config: await ws.loadConfig() },
									{ feedback: { kind: "M07", runId: secondGoal.runId }, freshSession: true,
										requiredM07ReadPaths: requiredPaths,
										purpose: "Adjudicate the latest model-proposed bounded M07 result" });
								const coverage = await m04EvidenceReturned(processed.record, secondTask.taskId,
									registered ? ["experiment-plan.json"] : []);
								const complete = processed.record.status === "completed" && processed.record.failures.length === 0 &&
									coverage.complete && requiredPaths.every(item => coverage.paths.includes(item));
								nextM04 = { status: complete ? "completed" : "failed", runId: processed.record.runId,
									proposalSubmitted: Boolean(processed.proposalId), snapshotCreated: Boolean(processed.snapshotId),
									evidenceReturned: complete,
									adoptedExperienceRefs: complete ? await adoptedExperienceRefs(store, processed.record.runId, true) : [] };
							} catch (error) { nextM04 = { status: "failed", adoptedExperienceRefs: [],
								failure: privateExceptionDiagnostic(error, runtimeKey) }; }
									}
						const nextArchive = await recordPrivateM04Outcome(nextArchiveDir,
							{ state: nextM04.status === "not_run" ? "not-run" : nextM04.status,
								...(nextM04.runId ? { runId: nextM04.runId } : {}),
								proposalSubmitted: nextM04.proposalSubmitted ?? false,
								snapshotCreated: nextM04.snapshotCreated ?? false,
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
							for (const name of [...await archiveEvidenceFiles(outputDir), "workflow-archive.json", "m04-adopted-knowledge.json"]) {
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
				historicalSelection = { priorRetained: !chooseFollowOnCandidate(true, finalVerification.status === "passed", changed, comparison),
					retentionReason: comparison.state === "measured" ? "measured-comparison" : "no-supported-current-gain",
					comparison, comparisonPerformed: comparison.state === "measured",
					historicalTimingUsed: false, priorRevalidated: prior.status === "passed" };
				if (historicalSelection.priorRetained) {
					await exportPrefixedArchive(outputDir, outputDir, "followon");
					const history = previousBundle["research-history.json"] ? JSON.parse(previousBundle["research-history.json"]) :
						{ version: 1, kind: "untrusted-version-bound-research-history", entries: [] };
					const unselectedFiles: Record<string, string> = {};
					for (const name of ["candidate.cpp", "verification.json", "workflow-archive.json", "experiment-plan.json", "m04-adopted-knowledge.json"])
						if (existsSync(path.join(outputDir, name))) unselectedFiles[name] = await readFile(path.join(outputDir, name), "utf8");
					history.entries.push({ originalContractId: originalObjective.id, goalRunId: finalArchive.goalRunId, taskId: finalArchive.taskId,
						interpretation: "Unselected current experiment; no confirmed replacement gain against the historical candidate", files: unselectedFiles });
					await writeFile(path.join(outputDir, "research-history.json"), JSON.stringify(history), { mode: 0o600 });
					for (const name of [...await archiveEvidenceFiles(outputDir), "workflow-archive.json", "m04-adopted-knowledge.json"]) {
						await rm(path.join(outputDir, name), { force: true });
						if (previousBundle[name as keyof PrivateContinuationBundle] !== undefined)
							await writeFile(path.join(outputDir, name), previousBundle[name as keyof PrivateContinuationBundle]!, { mode: 0o600 });
					}
					finalArchive = JSON.parse(previousBundle["workflow-archive.json"]!) as typeof finalArchive;
				}
			}
			const finalCandidateAvailable = selectedCandidateSource !== "none" &&
				finalArchive.controllerEvidence.reviewStatus === "accepted" &&
				(historicalSelection.priorRetained === true || Boolean(finalArchive.controllerEvidence.reviewDecision?.file && existsSync(path.join(outputDir, "review-decision.json")))) &&
				["candidate.cpp", "verification.json"].every(name =>
					finalArchive.files.some(item => item.name === name && item.status === "present") &&
					existsSync(path.join(outputDir, name)));
			const finalCandidateVerified = finalCandidateAvailable && (historicalSelection.priorRetained !== true || historicalSelection.priorRevalidated === true);
			const durableKnowledge = knowledgeExport.state !== "incomplete" &&
				(!m04.adoptedExperienceRefs?.length || knowledgeExport.state === "complete");
			const followOnCompleted = followOn.state === "completed" && followOn.m07Outcome === "fulfilled";
			const boundedRunOutcome = firstGoalReady && finalCandidateVerified && m04.status === "completed" && durableKnowledge &&
				m04SelectedReadContractSatisfied && currentM04Status === "completed" && currentM04Read &&
				currentKnowledgeExport.state !== "incomplete" && branchExerciseComplete &&
				followOnCompleted ? "fulfilled" : "partial";
			if (boundedRunOutcome === "partial" && objectiveStopReason === "bounded-run-incomplete" &&
				budget.snapshot().stopReason === "total-cny-ceiling")
				objectiveStopReason = "budget-boundary";
			const boundedRuns = [...previousCheckpoint.boundedRuns, { runId: runId!, outcome: finished.outcome ?? "unknown",
				...(firstGoalReady ? { selectedTaskId: selectedTask.taskId } : {}) },
				...followOnAttempts.filter(item => typeof item.goalRunId === "string").map(item => ({
					runId: String(item.goalRunId), outcome: String(item.m07Outcome ?? "unknown"),
					...(item.candidateSelected === true ? { selectedTaskId: String(item.taskId) } : {}) }))];
			const objectiveCheckpoint = campaignObjectiveProgress(originalObjective,
				historicalUnresolvedOperationIds, { boundedRuns,
				selectedArtifacts: finalCandidateAvailable ? ["candidate.cpp", "verification.json", "workflow-archive.json"] : previousCheckpoint.selectedArtifacts,
				...(objectiveAssessment ? { assessment: objectiveAssessment } : {}), assessmentHistory,
				nextTaskDispatched: latestAssessmentAdvanced, stopReason: objectiveStopReason });
			await writeObjectiveProgress(objectiveCheckpointFile, objectiveCheckpoint);
			const campaignOutcome = objectiveCheckpoint.objectiveOutcome;
			await saveStatus({ outcome: campaignOutcome, boundedRunOutcome,
				originalObjective: { id: originalObjective.id, outcome: objectiveCheckpoint.objectiveOutcome,
					stopReason: objectiveCheckpoint.stopReason, checkpointFile: "objective-checkpoint.json",
					goalSource: originalObjective.goalSource, continuation: objectiveCheckpoint.continuation.mode },
				m07Outcome: finished.outcome, taskStatus: task.status,
				loopStopReason: task.loopStopReason, taskTelemetry: statusTaskTelemetry,
				credentialProbe: statusCredentialProbe, sdkAuthSource: statusAuthSource,
				sdkAuthMatch: statusSdkAuthMatch,
				workflowArchive: { state: "saved", firstTaskId: task.taskId,
					selectedM07TaskId: firstGoalReady ? selectedTask.taskId : null,
					finalTaskId: finalArchive.taskId,
					lessonState: privateArchive.lesson.state, trustedAdoption: false, m04,
					knowledgeExport, m04EvidenceReturned: m04.evidenceReturned ?? false,
					m04AdoptedExperienceCount, m04AdoptionReadContractSatisfied,
					m04SelectedReadContractSatisfied },
				branch: branchState, branchExerciseComplete, firstGoalReady,
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
			statusArchiveFailure = "bounded-fallback-archive-failed";
			await saveStatus({ outcome: "incomplete", archiveFailure: "bounded-fallback-archive-failed",
				independentValidation: "not-complete" }).catch(() => undefined);
			process.exitCode = 1;
		}
		try { await salvageObjectiveCheckpoint(new Workspace(path.join(campaignRoot, "workspace")), outputDir,
			budget.snapshot().stopReason, campaignCancelled); }
		catch { statusArchiveFailure = "objective-checkpoint-salvage-failed"; process.exitCode = 1; }
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
		catch { statusArchiveFailure = "objective-status-sync-failed"; process.exitCode = 1; }

		await rm(campaignRoot, { recursive: true, force: true });
	}
	} finally {
		try {
			const snapshot = finalBudget?.snapshot();
			const requestAudit = finalBudget?.requestAuditSnapshot() ?? { requests: [], settledCny: 0, unknownReservedCny: 0, inFlightReservedCny: 0, reservations: 0 };
			let privateBundle = missionLedger.priorPrivateBundle;
			try { privateBundle = await collectContinuationBundle(outputDir, missionLedger.priorPrivateBundle); }
			catch { statusArchiveFailure = "research-continuation-collection-failed-prior-retained"; process.exitCode = 1; }
			const carry = missionLedger.sealCurrent({ settledCny: requestAudit.settledCny,
				unknownOrInFlightCny: requestAudit.unknownReservedCny + requestAudit.inFlightReservedCny,
				requestAudit, ...(privateBundle ? { privateBundle } : {}) });
			await writeFile(path.join(outputDir, CARRY_FILE_NAME), `${JSON.stringify({ envelopeB64: carry.envelopeB64 })}\n`, { mode: 0o600 });
			await writeFile(path.join(outputDir, "mission-ledger-out.json"), `${JSON.stringify({
				version: 1, kind: "mul-pis-private-mission-ledger-observation", missionId: MISSION_ID,
				repository: MISSION_REPOSITORY, globalMaxCny: MISSION_TOTAL_CNY,
				currentRunId: process.env.GITHUB_RUN_ID, currentRunAttempt: process.env.GITHUB_RUN_ATTEMPT,
				currentCommit: process.env.GITHUB_SHA, budget: snapshot,
				carryForwardCny: carry.carryForwardCny,
				status: "sealed-encrypted-continuation",
			}, null, 2)}\n`, { mode: 0o600 });
		} catch { statusArchiveFailure = "mission-ledger-continuation-write-failed"; process.exitCode = 1; }

	}
}

export const offlineChecks = { sourceShape, deriveRuntimeCases, m04EvidenceReturned, inputs, stageProbe, verifierScratch,
	checkCandidate, validateSelectedPriorTuple,
	createPrivateCampaignBudget,
	reviewedLegacyRestartEffects,
	appendRestartReservation, appendRestartGoalBinding,
	privateFailureMessage, privateExceptionDiagnostic, credentialProbe, parseCheckerOutput, compareCandidateTimings,
	campaignObjectiveStop, taskTelemetry, privateToolTelemetry,
	chooseForkWinner, chooseFollowOnCandidate, firstM07Accepted,
	availablePrivateArtifactNames,
	initialHistoricalSelection,
	forkReceiptMatches, contextLineageSummary, selectedM07ReviewReadPaths, exportPrefixedArchive, preserveCandidate,
	preserveUnsettledGoalCheckpoint, preserveUnsettledBranchCheckpoint: preserveUnsettledGoalCheckpoint,
	salvageObjectiveCheckpoint, collectContinuationBundle,
	unresolvedGoalControl, campaignObjectiveProgress,
	canonicalUnresolvedOperationRefs, qualifiedOperationRef, reservedCanonicalOperationRefs,
	registeredSourceShape, parseRegisteredCheckerOutput, validateContinuationSeed, rangeReadableHistory, sandboxArguments };

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main().catch(async error => {
		const preProvider = ["preflight", "mission-ledger-verification", "credential-probe", "credential-verified",
			"isolated-preflight-passed", "workspace-init", "private-inputs-staged",
			"provider-output-limit-verification", "provider-output-limit-verified",
			"billing-currency-verification", "billing-currency-verified", "original-source-smoke",
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
	});
}
