import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { inflateRawSync } from "node:zlib";
import { HarnessError } from "../types.ts";
import { canonicalRestartUnknowns } from "../m07/independent-restart.ts";
import { objectiveProgress, type ObjectiveProgressV1 } from "../m07/objective-progress.ts";
import type { CampaignAdmissionRejection, CampaignRequestAudit } from "./deepseek-campaign.ts";
import type { TransportFailureDiagnostic } from "./types.ts";
import { campaignSessionEffectId } from "./deepseek-campaign.ts";
import { isNativeCnyPricingRecord, type NativeCnyPricingProfile } from "./deepseek-cny-pricing.ts";
import { isDeepSeekProviderOutputLimitRecord, type DeepSeekProviderOutputLimit } from "./deepseek-provider-limits.ts";
import { authenticateSignedMissionSeed, MISSION_ARTIFACT, MISSION_ID, MISSION_REPOSITORY,
	MISSION_TOTAL_CNY, PRIVATE_CONTINUATION_FILE_KEYS } from "./signed-mission-ledger.ts";
import type { BootstrapBinding, PrivateContinuationBundle } from "./signed-mission-ledger.ts";

/** Keep seed, derived key, ledger bookkeeping and raw carry plaintext host-only.
 * Verified restored research files may enter a separately authorized, confined
 * research handoff as untrusted evidence; never send keys or carry metadata there.
 */
export const CARRY_ARTIFACT_NAME = "confidential-mission-carry";
export const CARRY_FILE_NAME = "ledger-continuation.enc.json";
const MAX_CARRY_BYTES = 8 * 1024 * 1024;
const NANO = 1_000_000_000;
const BRANCH = "improve/workflow-learning-reliability";
const REQUEST_BRANCH = "run-requests/workflow-learning-reliability";
const WORKFLOW = "manual-private-campaign.yml";
const ONE_TIME_LEGACY_V3_RUN = "37490692145";
const ONE_TIME_LEGACY_V3_REQUEST = "f9d29bfd58449dba072c80f62a7db524f0a668c4";
const ONE_TIME_LEGACY_V3_SOURCE = "00d4309390bb06536abbe5e86f97213298e901a0";
export const REUSABLE_RUN_REQUEST_MESSAGE = "Run confidential workflow";
export type { PrivateContinuationBundle, BootstrapBinding } from "./signed-mission-ledger.ts";
export type CurrentMissionRun = {
	repository: string | undefined; runId: string | undefined; runAttempt: string | undefined;
	actor: string | undefined; event: string | undefined; ref: string | undefined;
	sha: string | undefined; manualAuthorized: string | undefined; before?: string | undefined;
};
type Run = { id?: number; run_number?: number; run_attempt?: number; workflow_id?: number;
	status?: string; conclusion?: string; head_branch?: string; head_sha?: string; event?: string;
	actor?: { login?: string }; head_commit?: { message?: string } };
type Job = { id?: number; run_id?: number; run_attempt?: number; head_sha?: string;
	name?: string; status?: string; conclusion?: string;
	steps?: Array<{ number?: number; name?: string; status?: string; conclusion?: string }> };
type Artifact = { id?: number; name?: string; expired?: boolean; digest?: string;
	workflow_run?: { id?: number; head_sha?: string } };
type Source = { runId: string; runAttempt: number; runNumber: number; commit: string };
export type OpaqueExecutedRunGap = Readonly<{
	version: 1; kind: "opaque-executed-run-gap"; source: Readonly<Source>;
	priorCarryEnvelopeSha256: string; carryArtifact: "absent";
	accounting: "unquantified"; effects: "unreviewed" | "quarantined-source-reviewed";
	terminal: AuthenticatedPriorCarryProof["terminal"];
	resultArtifact: NonNullable<AuthenticatedPriorCarryProof["resultArtifact"]>;
}>;
export type AuthenticatedOpaqueGapSourceReview = Readonly<{
	version: 1; kind: "authenticated-opaque-gap-source-review";
	source: Readonly<Source>; resultArchiveSha256: string;
	priorCarryEnvelopeSha256: string;
}>;
const authenticatedOpaqueGapSourceReviews = new WeakSet<object>();
const authenticatedReviewedOpaqueGaps = new WeakMap<object, readonly OpaqueExecutedRunGap[]>();
/** The underlying carry still belongs to its actual source. Gap effects have
 * their own receipt and cannot be treated as measured research or a paid invoice. */
export function authenticatedReviewedOpaqueRunGaps(proof: unknown,
	bundle: unknown): readonly OpaqueExecutedRunGap[] | undefined {
	if (!isAuthenticatedPriorCarryProof(proof) ||
		!authenticatedPriorCarryBindsBundle(proof, bundle)) return undefined;
	return authenticatedReviewedOpaqueGaps.get(proof);
}
/** Test-only brand. Production review must independently audit the exact
 * immutable Actions source before it mints this authority. */
export function authenticateOpaqueGapSourceForOfflineTests(source: Readonly<Source>,
	resultArchiveSha256: string, priorCarryEnvelopeSha256: string): AuthenticatedOpaqueGapSourceReview {
	if (!process.env.NODE_TEST_CONTEXT || !/^[0-9a-f]{64}$/.test(resultArchiveSha256) ||
		!/^[0-9a-f]{64}$/.test(priorCarryEnvelopeSha256))
		reject("opaque gap source review fixture is test-only");
	const review = Object.freeze({ version: 1 as const,
		kind: "authenticated-opaque-gap-source-review" as const,
		source: Object.freeze({ ...source }), resultArchiveSha256, priorCarryEnvelopeSha256 });
	authenticatedOpaqueGapSourceReviews.add(review);
	return review;
}
function bindsOpaqueGapSourceReview(review: unknown, source: Source,
	resultArtifact: NonNullable<AuthenticatedPriorCarryProof["resultArtifact"]>,
	priorCarryEnvelopeSha256: string): boolean {
	return Boolean(review) && typeof review === "object" &&
		authenticatedOpaqueGapSourceReviews.has(review as object) &&
		JSON.stringify((review as AuthenticatedOpaqueGapSourceReview).source) === JSON.stringify(source) &&
		(review as AuthenticatedOpaqueGapSourceReview).resultArchiveSha256 === resultArtifact.archiveSha256 &&
		(review as AuthenticatedOpaqueGapSourceReview).priorCarryEnvelopeSha256 === priorCarryEnvelopeSha256;
}
/** Host-only admission evidence. Terminal execution is not usage reconciliation,
 * and this read-only proof is not an atomic durable restart claim.
 */
export type AuthenticatedPriorCarryProof = Readonly<{
	version: 1 | 2; kind: "authenticated-prior-mission-carry"; repository: typeof MISSION_REPOSITORY;
	source: Readonly<Source>; envelopeSha256: string; privateBundleSha256: string | null;
	artifact: Readonly<{ repository: typeof MISSION_REPOSITORY; artifactId: string;
		artifactName: typeof CARRY_ARTIFACT_NAME; runId: string }>;
	/** GitHub's artifact archive digest, never the inner encrypted-envelope file digest. */
	resultArtifact?: Readonly<{ repository: typeof MISSION_REPOSITORY; artifactId: string;
		artifactName: typeof MISSION_ARTIFACT; runId: string; archiveSha256: string;
		digestScope: "github-artifact-archive" }>;
	terminal: Readonly<{ workflowId: string; runStatus: "completed"; runConclusion: string;
		jobId: string; jobName: "private-campaign"; jobStatus: "completed"; jobConclusion: string;
		jobRunId: string; jobRunAttempt: number; jobHeadSha: string;
		providerStepStatus: "completed"; providerStepConclusion: string }>;
	priorCommittedCny?: number; priorUnknownHeldCny?: number;
	priorSettledCny?: number; priorUnknownObservedCny?: number; priorUnpricedRequestCount?: number;
	admittedCurrent: Readonly<Source>;
}>;
export type AuthenticatedCarryForwardOrigin = Readonly<{
	source: Readonly<Source>; envelopeSha256: string;
	historicalCommittedNano: number; historicalUnknownHeldNano: number;
}>;
type StoredCarryForwardOrigin = AuthenticatedCarryForwardOrigin & { privateBundleSha256: string };
const authenticatedCarryProofs = new WeakSet<object>();
const authenticatedCarryForwardOrigins = new WeakMap<object, AuthenticatedCarryForwardOrigin>();
const authenticatedCarryAncestors = new WeakMap<object, ReadonlyArray<Readonly<{
	source: Readonly<Source>; envelopeSha256: string;
}>>>();
const claimedActionsAdmissions = new Set<string>();
export type ActionsCarryRestartClaim = Readonly<{
	claimId: string; currentRunId: string; currentRunAttempt: number; currentCommit: string;
	currentJobId: string; priorEnvelopeSha256: string;
}>;

/** Reject copied, deserialized or model-authored objects; only this live verifier may attest a carry. */
export function isAuthenticatedPriorCarryProof(value: unknown): value is AuthenticatedPriorCarryProof {
	return Boolean(value) && typeof value === "object" && authenticatedCarryProofs.has(value as object);
}

/** Authenticate an inherited receipt's exact origin against the already verified
 * complete carry ancestry, including the latest prior carry itself. This says
 * nothing about settlement or scientific acceptance of the referenced attempt.
 */
export function authenticatedPriorCarryBindsAncestor(proof: unknown, source: unknown, envelopeSha256: unknown): boolean {
	if (!isAuthenticatedPriorCarryProof(proof) || !record(source) ||
		!exactKeys(source, ["runId", "runAttempt", "commit", ...(source.runNumber === undefined ? [] : ["runNumber"])]) ||
		!positiveId(source.runId) || !Number.isSafeInteger(source.runAttempt) || Number(source.runAttempt) <= 0 ||
		typeof source.commit !== "string" || !/^[0-9a-f]{40}$/.test(source.commit) ||
		(source.runNumber !== undefined && (!Number.isSafeInteger(source.runNumber) || Number(source.runNumber) <= 0)) ||
		typeof envelopeSha256 !== "string" || !/^[0-9a-f]{64}$/.test(envelopeSha256)) return false;
	return authenticatedCarryAncestors.get(proof)?.some(ancestor =>
		ancestor.envelopeSha256 === envelopeSha256 && ancestor.source.runId === source.runId &&
		ancestor.source.runAttempt === source.runAttempt && ancestor.source.commit === source.commit &&
		(source.runNumber === undefined || ancestor.source.runNumber === source.runNumber)) ?? false;
}

/** Canonicalize only the fixed filename map; file contents remain exact UTF-8 strings. */
function canonicalPrivateBundle(bundle: PrivateContinuationBundle): string {
	return JSON.stringify(Object.fromEntries(Object.entries(bundle).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)));
}
function privateBundleDigest(bundle: PrivateContinuationBundle): string { return digest(canonicalPrivateBundle(bundle)); }
export function authenticatedPriorCarryBindsBundle(proof: unknown, bundle: unknown): boolean {
	return isAuthenticatedPriorCarryProof(proof) && proof.privateBundleSha256 !== null &&
		validBundle(bundle) && privateBundleDigest(bundle) === proof.privateBundleSha256;
}
/** A verified v3 transport-only chain may retain a historical restart origin.
 * This does not confer scientific acceptance or settle the old billing unknown.
 */
export function authenticatedCarryForwardOrigin(proof: unknown,
	bundle: unknown): AuthenticatedCarryForwardOrigin | undefined {
	if (!isAuthenticatedPriorCarryProof(proof) || proof.version !== 2 ||
		!authenticatedPriorCarryBindsBundle(proof, bundle)) return undefined;
	return authenticatedCarryForwardOrigins.get(proof);
}
type LegacyCheckpoint = { version: 1 | 2; kind: "mul-pis-private-ledger-continuation";
	missionId: typeof MISSION_ID; repository: typeof MISSION_REPOSITORY; seedDigest: string;
	parentDigest: string; source: Source; committedNano: number; unknownHeldNano: number;
	settledAddedNano: number; unknownAddedNano: number; requestAudit: RequestAuditSnapshot;
	bootstrapBinding?: BootstrapBinding;
	privateBundle?: PrivateContinuationBundle; ancestry?: AncestorReceipt[] };
type AncestorReceipt = Pick<LegacyCheckpoint, "parentDigest" | "source" | "committedNano" |
	"unknownHeldNano" | "settledAddedNano" | "unknownAddedNano" | "requestAudit" | "bootstrapBinding"> &
	{ envelopeDigest: string };
export type AccountingOnlyRequestAuditSnapshot = {
	version: 3; kind: "accounting-only-request-audit";
	requests: Array<{
		requestId: string; inputPayloadBytes: number; maxOutputTokens?: number;
		/** New receipts separate received transport from possibly unknown billing. */
		sessionId?: string; responseReceived?: boolean;
		status: "settled" | "unknown" | "in-flight";
		settledCny: number | null; unknownObservedCny: number | null;
		/** Unknown/unpriced rows retain raw, possibly incomplete SDK observation. */
		reportedUsage: Partial<{ input: number; output: number; cacheRead: number; cacheWrite: number;
			totalTokens: number; reportedUsdCost: number | null; costStatus: string | null }> | null;
	}>;
	settledCny: number; unknownObservedCny: number; unpricedRequestCount: number;
	/** Structural evidence of the verified native-CNY basis, never a live price authorization. */
	pricingProfile?: NativeCnyPricingProfile;
};
export type HostTransportDiagnosticCensusV1 = Readonly<{
	version: 1; kind: "host-transport-diagnostic-census";
	entries: ReadonlyArray<Readonly<{
		source: Readonly<{ runId: string; runAttempt: number; commit: string }>;
		priorEnvelopeSha256: string;
		rows: ReadonlyArray<Readonly<{ requestId: string; availability: "unavailable" }> |
			Readonly<{ requestId: string; availability: "observed";
				phase: TransportFailureDiagnostic["phase"]; httpStatus: number | null;
				responseStarted: boolean | null; bytesRead: number | null;
				abortSource: TransportFailureDiagnostic["abortSource"];
				providerErrorCode: string | null; providerErrorType: string | null;
				errorCodes: string[] }>>;
	}>>;
}>;
/** Host-created complete census. It is authority only while bound to a live carry proof. */
export type HostEffectReceiptV1 = {
	version: 1; kind: "m07-host-effect-census";
	source: { runId: string; runAttempt: number; commit: string };
	priorEnvelopeSha256: string; historicalGoalRunIds: string[];
	goals: Array<{ runId: string; outcome: string;
		tasks: Array<{ taskId: string; mode: "execute" | "check"; status: string; sessionId: string }>;
		operations: Array<{ id: string; taskId: string; status: string }> }>;
	sessions: Array<{ sessionId: string; kind: "none" | "read-dir" | "confined-execution";
		goalRunId?: string; taskId?: string; workRoot?: string;
		grant?: { version: 1; kind: "confined-campaign-files"; root: string; writableFiles: string[] } }>;
	requestIds: string[];
};
export type AuthenticatedHostEffectEvidence = Readonly<{
	origin: AuthenticatedCarryForwardOrigin;
	receipt: Readonly<HostEffectReceiptV1>;
	requestAudit: Readonly<AccountingOnlyRequestAuditSnapshot>;
	reviewedEffectAncestry: ReadonlyArray<ReviewedEffectAncestorReceipt>;
}>;
const authenticatedHostEffects = new WeakMap<object, AuthenticatedHostEffectEvidence>();
/** A copied receipt or proof cannot mint this authority. */
export function authenticatedHostEffectEvidence(proof: unknown,
	bundle: unknown): AuthenticatedHostEffectEvidence | undefined {
	if (!isAuthenticatedPriorCarryProof(proof) || proof.version !== 2 ||
		!authenticatedPriorCarryBindsBundle(proof, bundle)) return undefined;
	return authenticatedHostEffects.get(proof);
}
/** Exact, non-reusable host review of one pre-census v3 Actions run. This is
 * minted only by the live verifier after the GitHub request commit's first
 * parent and tree have been checked. It does not validate research output. */
export type AuthenticatedLegacyV3RunReview = Readonly<{
	origin: AuthenticatedCarryForwardOrigin;
	/** The immediately preceding v3 carry is authenticated and has no provider activity. */
	immediateZeroActivitySource: Readonly<{ source: Readonly<Source>; envelopeSha256: string }>;
	reviewedSourceCommit: "00d4309390bb06536abbe5e86f97213298e901a0";
	requestAudit: Readonly<AccountingOnlyRequestAuditSnapshot>;
	settledAddedNano: number; unknownObservedAddedNano: number; unpricedAddedCount: number;
}>;
const authenticatedLegacyV3RunReviews = new WeakMap<object, AuthenticatedLegacyV3RunReview>();
export function authenticatedLegacyV3RunReview(proof: unknown,
	bundle: unknown): AuthenticatedLegacyV3RunReview | undefined {
	if (!isAuthenticatedPriorCarryProof(proof) || proof.version !== 2 ||
		!authenticatedPriorCarryBindsBundle(proof, bundle)) return undefined;
	return authenticatedLegacyV3RunReviews.get(proof);
}
export type LegacyCarrySealInput = { settledCny: number; unknownOrInFlightCny: number;
	requestAudit: RequestAuditSnapshot; privateBundle?: PrivateContinuationBundle;
	bootstrapBinding?: BootstrapBinding };
export type AccountingCarrySealInput = { settledCny: number; unknownObservedCny: number;
	unpricedRequestCount: number; requestAudit: AccountingOnlyRequestAuditSnapshot;
	privateBundle?: PrivateContinuationBundle; bootstrapBinding?: BootstrapBinding };
export type LedgerContinuation = {
	mode: "accounting-only";
	/** Validated metadata only; never an invoice or authorization to replay an operation. */
	priorTransportDiagnosticCensus?: HostTransportDiagnosticCensusV1;
	appendTransportDiagnosticCensus: (audit: AccountingOnlyRequestAuditSnapshot,
		diagnostics: readonly TransportFailureDiagnostic[]) => string | undefined;
	/** A paid, terminal Actions run lacked its encrypted carry. Known totals exclude it. */
	opaqueExecutedRuns: readonly OpaqueExecutedRunGap[];
	priorCommittedCny?: number; priorUnknownHeldCny?: number;
	priorSettledCny?: number; priorUnknownObservedCny?: number; priorUnpricedRequestCount?: number;
	historicalCommittedCny?: number; historicalUnknownHeldCny?: number;
	priorCarryProof?: AuthenticatedPriorCarryProof;
	claimOneUse: (carryDigest: string) => Promise<ActionsCarryRestartClaim>;
	priorPrivateBundle?: PrivateContinuationBundle; priorBootstrapBinding?: BootstrapBinding;
	sealCurrent: (input: AccountingCarrySealInput) => { envelopeB64: string; observedSettledCny: number;
			observedUnknownHeldCny: number; unpricedRequestCount: number };
	sealEmergencyCurrent: (input: AccountingCarrySealInput, reason: "effect-review-incomplete") =>
		{ envelopeB64: string; observedSettledCny: number; observedUnknownHeldCny: number;
			unpricedRequestCount: number };
};
const historicalFixtureSealers = new WeakMap<LedgerContinuation,
	(input: LegacyCarrySealInput) => { envelopeB64: string; carryForwardCny: number }>();
/** Synthetic regression fixture only. Production sealCurrent always writes v3. */
export function sealHistoricalCarryForOfflineTests(opened: LedgerContinuation,
	amounts: LegacyCarrySealInput): { envelopeB64: string; carryForwardCny: number } {
	if (!process.env.NODE_TEST_CONTEXT) reject("historical fixture sealing is test-only");
	const seal = historicalFixtureSealers.get(opened);
	if (!seal) reject("historical fixture sealer is unavailable");
	return seal(amounts);
}
type AccountingCheckpoint = {
	version: 3; kind: "mul-pis-private-ledger-continuation"; missionId: typeof MISSION_ID;
	repository: typeof MISSION_REPOSITORY; seedDigest: string; parentDigest: string; source: Source;
	settledNano: number; unknownObservedNano: number; unpricedRequestCount: number;
	settledAddedNano: number; unknownObservedAddedNano: number; unpricedAddedCount: number;
	requestAudit: AccountingOnlyRequestAuditSnapshot;
	legacyAncestry: AncestorReceipt[]; ancestry: AccountingAncestorReceipt[];
	opaqueExecutedRuns?: OpaqueExecutedRunGap[];
	currentEffectReview?: "pending";
	pendingEffectAncestry?: Source[];
	/** Previously reviewed nonzero v3 runs, in accounting-source order. */
	reviewedEffectAncestry?: ReviewedEffectAncestorReceipt[];
	historical: { committedNano: number; unknownHeldNano: number; legacyParentDigest: string };
	carryForwardOrigin?: StoredCarryForwardOrigin;
	bootstrapBinding?: BootstrapBinding; privateBundle?: PrivateContinuationBundle;
};
export type ReviewedEffectAncestorReceipt = Readonly<{
	source: Readonly<Source>; envelopeSha256: string; privateBundleSha256: string;
	reviewedPolicySha256: string; selectedTupleSha256: string;
	historicalOriginEnvelopeSha256: string;
	/** The next run claimed this source but ended before a fresh M07 goal existed. */
	abandonedWithoutGoal?: true;
}>;
type AccountingAncestorReceipt = Pick<AccountingCheckpoint, "parentDigest" | "source" |
	"settledNano" | "unknownObservedNano" | "unpricedRequestCount" | "settledAddedNano" |
	"unknownObservedAddedNano" | "unpricedAddedCount" | "requestAudit" | "bootstrapBinding"> &
	{ envelopeDigest: string };
type Checkpoint = LegacyCheckpoint | AccountingCheckpoint;
export type RequestAuditSnapshot = { requests: CampaignRequestAudit[]; settledCny: number;
	unknownReservedCny: number; inFlightReservedCny: number; reservations: number;
	/** Absent in earlier encrypted carries. */ admissionRejections?: CampaignAdmissionRejection[];
	/** Verified-at-run native CNY source metadata, without balances. */ pricingProfile?: NativeCnyPricingProfile;
	/** Fresh provider maximum metadata for a new run; never a lower workflow output cap. */
	providerOutputLimit?: DeepSeekProviderOutputLimit };

function reject(reason: string): never { throw new HarnessError("runner.ledger-continuation", reason); }
function record(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function positiveId(value: unknown): value is string {
	return typeof value === "string" && /^[1-9][0-9]{0,17}$/.test(value);
}
function digest(bytes: Buffer | string): string { return createHash("sha256").update(bytes).digest("hex"); }
function n(value: number): number {
	// The admission ceiling is enforced before transport. A truthful observation
	// above it must remain recoverable; persistence must never erase an overspend.
	if (!Number.isFinite(value) || value < 0) reject("invalid monetary amount");
	const rounded = Math.ceil(value * NANO);
	if (!Number.isSafeInteger(rounded)) reject("invalid monetary precision");
	return rounded;
}
function decimal(value: number): number { return value / NANO; }
function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
	return Object.keys(value).sort().join("|") === [...keys].sort().join("|");
}
function canonicalBase64(value: unknown, max: number): Buffer {
	if (typeof value !== "string" || value.length > Math.ceil(max * 4 / 3) + 4 ||
		value.length === 0 || value.length % 4 !== 0)
		reject("invalid carry encoding");
	// A repeated capture-group regexp can overflow the JS stack on an otherwise
	// valid near-bound carry. Validate the alphabet in a strictly linear scan.
	const paddingAt = value.indexOf("=");
	const dataEnd = paddingAt < 0 ? value.length : paddingAt;
	if (value.length - dataEnd > 2) reject("invalid carry encoding");
	for (let index = 0; index < dataEnd; index++) {
		const code = value.charCodeAt(index);
		if (!((code >= 65 && code <= 90) || (code >= 97 && code <= 122) ||
			(code >= 48 && code <= 57) || code === 43 || code === 47))
			reject("invalid carry encoding");
	}
	for (let index = dataEnd; index < value.length; index++)
		if (value.charCodeAt(index) !== 61) reject("invalid carry encoding");
	const bytes = Buffer.from(value, "base64");
	if (!bytes.length || bytes.length > max || bytes.toString("base64") !== value)
		reject("invalid carry bytes");
	return bytes;
}
function validBundle(bundle: unknown): bundle is PrivateContinuationBundle {
	return record(bundle) && Object.keys(bundle).length > 0 && Object.keys(bundle).every(key =>
		(PRIVATE_CONTINUATION_FILE_KEYS as readonly string[]).includes(key) && typeof bundle[key] === "string" &&
		Buffer.byteLength(bundle[key] as string, "utf8") <= 4 * 1024 * 1024) &&
		Buffer.byteLength(JSON.stringify(bundle), "utf8") <= 4 * 1024 * 1024;
}
/** Optional cause metadata must yield before it could prevent a fee carry. */
export function retainedTransportDiagnosticWithinBundle(prior: PrivateContinuationBundle | undefined,
	next: string): string | undefined {
	return validBundle({ ...prior, "transport-diagnostics.json": next }) ? next :
		prior?.["transport-diagnostics.json"];
}
function validBinding(value: unknown): value is BootstrapBinding {
	return record(value) && exactKeys(value, ["contractId", "sourceSha256"]) &&
		typeof value.contractId === "string" && value.contractId.length > 0 &&
		value.contractId.length <= 256 && typeof value.sourceSha256 === "string" &&
		/^[0-9a-f]{64}$/.test(value.sourceSha256);
}
function sameBinding(a: BootstrapBinding | undefined, b: BootstrapBinding): boolean {
	return a?.contractId === b.contractId && a.sourceSha256 === b.sourceSha256;
}
function validAudit(value: unknown, settledNano: number, unknownNano: number): value is RequestAuditSnapshot {
	if (!record(value) || !exactKeys(value, ["requests", "settledCny", "unknownReservedCny",
		"inFlightReservedCny", "reservations", ...(value.admissionRejections === undefined ? [] : ["admissionRejections"]),
		...(value.pricingProfile === undefined ? [] : ["pricingProfile"]),
		...(value.providerOutputLimit === undefined ? [] : ["providerOutputLimit"])]) || !Array.isArray(value.requests) ||
		!Number.isSafeInteger(value.reservations) ||
		value.reservations !== value.requests.length) return false;
	const a = value as RequestAuditSnapshot;
	if (a.pricingProfile !== undefined && !isNativeCnyPricingRecord(a.pricingProfile)) return false;
	if (a.providerOutputLimit !== undefined &&
		!isDeepSeekProviderOutputLimitRecord(a.providerOutputLimit)) return false;
	if (a.admissionRejections !== undefined && (!Array.isArray(a.admissionRejections) ||
		a.admissionRejections.some(row =>
			!record(row) || !exactKeys(row, ["version", "kind", "decision", "requestNotSent",
				"inputPayloadBytes", "inputUpperCny", "outputAllowanceTokens", "minimumOutputTokens",
				"requestedOutputTokens", "outputAccountingMarginTokens", "marginUpperCny",
				"availableCny", "requiredAtMinimumOutputCny", "globalMaxCny", "committedBeforeCny",
				"settledProviderRequestCount", "pricingBasis"]) ||
			row.version !== 1 || row.kind !== "campaign-admission-rejection" || row.requestNotSent !== true ||
			!["input-unaffordable", "minimum-output-unaffordable", "requested-output-cap-unaffordable",
				"provider-maximum-unaffordable", "provider-call-limit"].includes(String(row.decision)) ||
			![row.inputPayloadBytes, row.requestedOutputTokens, row.settledProviderRequestCount]
				.every(x => Number.isSafeInteger(x) && x >= 0) || row.inputPayloadBytes < 1 ||
			row.requestedOutputTokens < 1 || row.settledProviderRequestCount > a.requests.length ||
			!Number.isSafeInteger(row.outputAllowanceTokens) || row.outputAllowanceTokens < 0 ||
			!Number.isSafeInteger(row.outputAccountingMarginTokens) || row.outputAccountingMarginTokens < 0 ||
			row.minimumOutputTokens !== 1 ||
			![row.inputUpperCny, row.marginUpperCny, row.availableCny, row.requiredAtMinimumOutputCny,
				row.globalMaxCny, row.committedBeforeCny].every(x => typeof x === "number" && Number.isFinite(x)) ||
			[row.inputUpperCny, row.marginUpperCny, row.requiredAtMinimumOutputCny,
				row.globalMaxCny, row.committedBeforeCny].some(x => x < 0) ||
			!record(row.pricingBasis) || !exactKeys(row.pricingBasis, ["source", "inputCnyPerMillionTokens", "outputCnyPerMillionTokens"]) ||
			!["higher-of-configured-and-sdk-estimates", "native-cny-peak-and-normalized-sdk-quotes"]
				.includes(String(row.pricingBasis.source)) ||
			(row.pricingBasis.source === "native-cny-peak-and-normalized-sdk-quotes" && !a.pricingProfile) ||
			![row.pricingBasis.inputCnyPerMillionTokens, row.pricingBasis.outputCnyPerMillionTokens]
				.every(x => typeof x === "number" && Number.isFinite(x) && x > 0) ||
			row.inputUpperCny !== row.inputPayloadBytes * row.pricingBasis.inputCnyPerMillionTokens / 1_000_000 ||
			row.marginUpperCny !== row.outputAccountingMarginTokens * row.pricingBasis.outputCnyPerMillionTokens / 1_000_000 ||
			row.requiredAtMinimumOutputCny !== (row.inputPayloadBytes * row.pricingBasis.inputCnyPerMillionTokens +
				(1 + row.outputAccountingMarginTokens) * row.pricingBasis.outputCnyPerMillionTokens) / 1_000_000 ||
			row.availableCny !== row.globalMaxCny - row.committedBeforeCny))) return false;
	if (![a.settledCny, a.unknownReservedCny, a.inFlightReservedCny].every(x =>
		Number.isFinite(x) && x >= 0 && Number.isSafeInteger(Math.ceil(x * NANO)))) return false;
	if (n(a.settledCny) !== settledNano ||
		n(a.unknownReservedCny + a.inFlightReservedCny) !== unknownNano) return false;
	const ids = new Set<string>();
	let settled = 0, unknown = 0, inFlight = 0;
	for (const item of a.requests) {
		if (!record(item) || !exactKeys(item, ["requestId", "inputPayloadBytes", "reservedCny",
			"status", "settledCny", "unknownHeldCny", "reportedUsage",
			...(item.maxOutputTokens === undefined ? [] : ["maxOutputTokens"]),
			...(item.admissionDecision === undefined ? [] : ["admissionDecision"])]) ||
			typeof item.requestId !== "string" || item.requestId.length > 128 || !item.requestId ||
			ids.has(item.requestId) || !Number.isSafeInteger(item.inputPayloadBytes) ||
			item.inputPayloadBytes <= 0 ||
			(item.maxOutputTokens !== undefined &&
				(!Number.isSafeInteger(item.maxOutputTokens) || item.maxOutputTokens < 1)) ||
			(item.admissionDecision !== undefined && !["full-output", "reduced-output", "provider-maximum"].includes(String(item.admissionDecision))) ||
			(item.admissionDecision === "provider-maximum" &&
				(!a.providerOutputLimit || item.maxOutputTokens !== a.providerOutputLimit.maxOutputTokens)) ||
			typeof item.reservedCny !== "number" || !Number.isFinite(item.reservedCny) ||
			item.reservedCny < 0 || item.reservedCny > MISSION_TOTAL_CNY ||
			!["reserved", "settled", "unknown"].includes(String(item.status))) return false;
		ids.add(item.requestId);
		if (item.status === "settled") {
			if (typeof item.settledCny !== "number" || !Number.isFinite(item.settledCny) ||
				item.settledCny < 0 || item.settledCny > item.reservedCny ||
				item.unknownHeldCny !== null) return false;
			settled += item.settledCny;
		} else if (item.status === "unknown") {
			if (typeof item.unknownHeldCny !== "number" || !Number.isFinite(item.unknownHeldCny) ||
				item.unknownHeldCny < item.reservedCny || !Number.isSafeInteger(Math.ceil(item.unknownHeldCny * NANO)) ||
				item.settledCny !== null) return false;
			unknown += item.unknownHeldCny;
		} else {
			if (item.settledCny !== null || item.unknownHeldCny !== null) return false;
			inFlight += item.reservedCny;
		}
		if (item.reportedUsage !== null) {
			const u = item.reportedUsage;
			if (!record(u) || !exactKeys(u, ["input", "output", "cacheRead", "cacheWrite",
				"totalTokens", "reportedUsdCost", "costStatus"]) ||
				![u.input, u.output, u.cacheRead, u.cacheWrite, u.totalTokens].every(x =>
					Number.isSafeInteger(x) && x >= 0) ||
				(u.reportedUsdCost !== null &&
					(typeof u.reportedUsdCost !== "number" || !Number.isFinite(u.reportedUsdCost) || u.reportedUsdCost < 0)) ||
				(u.costStatus !== null && (typeof u.costStatus !== "string" || u.costStatus.length > 32))) return false;
		}
		if (item.status === "settled") {
			const u = item.reportedUsage;
			if (!u || u.reportedUsdCost === null || u.costStatus !== "priced" ||
				u.input + u.cacheRead + u.cacheWrite <= 0 || u.output <= 0 ||
				u.input + u.cacheRead + u.cacheWrite > item.inputPayloadBytes ||
				u.totalTokens !== u.input + u.cacheRead + u.cacheWrite + u.output) return false;
		}
	}
	return n(settled) === settledNano && n(unknown) === n(a.unknownReservedCny) &&
		n(inFlight) === n(a.inFlightReservedCny) && n(unknown + inFlight) === unknownNano;
}
function validAccountingAudit(value: unknown, settledNano: number, unknownNano: number,
	unpricedCount: number): value is AccountingOnlyRequestAuditSnapshot {
	if (!record(value) || !exactKeys(value, ["version", "kind", "requests", "settledCny",
		"unknownObservedCny", "unpricedRequestCount",
		...(value.pricingProfile === undefined ? [] : ["pricingProfile"])]) ||
		value.version !== 3 || value.kind !== "accounting-only-request-audit" ||
		(value.pricingProfile !== undefined && !isNativeCnyPricingRecord(value.pricingProfile)) ||
		!Array.isArray(value.requests) || !Number.isSafeInteger(value.unpricedRequestCount) ||
		Number(value.unpricedRequestCount) < 0 ||
		typeof value.settledCny !== "number" || typeof value.unknownObservedCny !== "number" ||
		n(value.settledCny) !== settledNano || n(value.unknownObservedCny) !== unknownNano ||
		value.unpricedRequestCount !== unpricedCount) return false;
	const audit = value as AccountingOnlyRequestAuditSnapshot;
	const ids = new Set<string>();
	let settled = 0, unknown = 0, unpriced = 0;
	for (const item of audit.requests) {
		if (!record(item) || !exactKeys(item, ["requestId", "inputPayloadBytes",
			"status", "settledCny", "unknownObservedCny", "reportedUsage",
			...(item.maxOutputTokens === undefined ? [] : ["maxOutputTokens"]),
			...(item.sessionId === undefined ? [] : ["sessionId"]),
			...(item.responseReceived === undefined ? [] : ["responseReceived"])]) ||
			typeof item.requestId !== "string" || !item.requestId ||
			item.requestId.length > 128 || ids.has(item.requestId) ||
			(item.sessionId !== undefined && (typeof item.sessionId !== "string" ||
				!/^[0-9a-f]{64}$/.test(item.sessionId))) ||
			(item.responseReceived !== undefined && typeof item.responseReceived !== "boolean") ||
			!Number.isSafeInteger(item.inputPayloadBytes) || item.inputPayloadBytes <= 0 ||
			(item.maxOutputTokens !== undefined &&
				(!Number.isSafeInteger(item.maxOutputTokens) || item.maxOutputTokens < 1)) ||
			!["settled", "unknown", "in-flight"].includes(String(item.status))) return false;
		ids.add(item.requestId);
		if (item.reportedUsage !== null) {
			const u = item.reportedUsage;
			const raw = u as Record<string, unknown>;
			const allowed = ["input", "output", "cacheRead", "cacheWrite",
				"totalTokens", "reportedUsdCost", "costStatus"];
			if (!record(u) || !Object.keys(u).every(key => allowed.includes(key)) ||
				["input", "output", "cacheRead", "cacheWrite", "totalTokens"].some(key =>
					raw[key] !== undefined && (!Number.isSafeInteger(raw[key]) || Number(raw[key]) < 0)) ||
				(u.reportedUsdCost !== undefined && u.reportedUsdCost !== null &&
					(typeof u.reportedUsdCost !== "number" ||
					!Number.isFinite(u.reportedUsdCost) || u.reportedUsdCost < 0)) ||
				(u.costStatus !== undefined && u.costStatus !== null &&
					(typeof u.costStatus !== "string" || u.costStatus.length > 32))) return false;
		}
		if (item.status === "settled") {
			if (item.unknownObservedCny !== null) return false;
			if (item.settledCny === null) unpriced++;
			else if (typeof item.settledCny !== "number" || !Number.isFinite(item.settledCny) ||
				item.settledCny < 0 || !Number.isSafeInteger(Math.ceil(item.settledCny * NANO))) return false;
			else {
				if (!audit.pricingProfile) return false;
				const u = item.reportedUsage;
				if (!record(u) || !exactKeys(u, ["input", "output", "cacheRead", "cacheWrite",
					"totalTokens", "reportedUsdCost", "costStatus"]) ||
					![u.input, u.output, u.cacheRead, u.cacheWrite, u.totalTokens].every(x =>
						Number.isSafeInteger(x) && Number(x) >= 0))
					return false;
				const full = u as Required<typeof u>;
				if (full.totalTokens !== full.input + full.output + full.cacheRead + full.cacheWrite ||
					full.input + full.cacheRead + full.cacheWrite <= 0 || full.output <= 0 ||
					full.input + full.cacheRead + full.cacheWrite > item.inputPayloadBytes) return false;
				settled += item.settledCny;
			}
		} else {
			if (item.settledCny !== null) return false;
			if (item.unknownObservedCny === null) unpriced++;
			else if (typeof item.unknownObservedCny !== "number" ||
				!Number.isFinite(item.unknownObservedCny) || item.unknownObservedCny < 0 ||
				!Number.isSafeInteger(Math.ceil(item.unknownObservedCny * NANO))) return false;
			else {
				if (!audit.pricingProfile) return false;
				unknown += item.unknownObservedCny;
			}
		}
	}
	return n(settled) === settledNano && n(unknown) === unknownNano && unpriced === unpricedCount;
}
const TRANSPORT_PHASES = new Set(["request", "response-body", "provider-stream", "unknown"]);
const TRANSPORT_ABORTS = new Set(["host-signal", "handle", "sdk-signal"]);
const TRANSPORT_PROVIDER_CODES = new Set(["invalid_request_error", "invalid_format",
	"invalid_parameter", "invalid_api_key", "model_not_found", "context_length_exceeded",
	"rate_limit_exceeded", "insufficient_quota", "content_filter"]);
const TRANSPORT_PROVIDER_TYPES = new Set(["invalid_request_error", "authentication_error",
	"permission_error", "not_found_error", "rate_limit_error", "server_error"]);
const TRANSPORT_NETWORK_CODES = new Set(["ECONNRESET", "ECONNREFUSED", "ECONNABORTED",
	"ENOTFOUND", "EAI_AGAIN", "ETIMEDOUT", "EHOSTUNREACH", "ENETUNREACH", "EPIPE",
	"UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT",
	"UND_ERR_BODY_TIMEOUT", "UND_ERR_RESPONSE", "UND_ERR_ABORTED"]);
function transportUnknownIds(audit: AccountingOnlyRequestAuditSnapshot): string[] {
	return audit.requests.filter(row => row.responseReceived === false && row.status === "unknown")
		.map(row => row.requestId);
}
/** An optional, strictly enum-only private cause census. Earlier ciphertexts
 * remain valid without it; the census has no billing or effect authority. */
function transportDiagnosticCensus(cp: Pick<AccountingCheckpoint,
	"privateBundle" | "ancestry" | "source" | "parentDigest" | "requestAudit">):
	HostTransportDiagnosticCensusV1 | undefined {
	const raw = cp.privateBundle?.["transport-diagnostics.json"];
	if (raw === undefined) return undefined;
	let parsed: unknown;
	try { parsed = JSON.parse(raw); } catch { return reject("transport diagnostic census JSON is invalid"); }
	if (!record(parsed) || !exactKeys(parsed, ["version", "kind", "entries"]) ||
		parsed.version !== 1 || parsed.kind !== "host-transport-diagnostic-census" ||
		!Array.isArray(parsed.entries) || parsed.entries.length === 0)
		reject("transport diagnostic census fields are invalid");
	const carried = [...cp.ancestry, cp];
	let lastIndex = -1;
	for (const entry of parsed.entries) {
		if (!record(entry) || !exactKeys(entry, ["source", "priorEnvelopeSha256", "rows"]) ||
			!record(entry.source) || !exactKeys(entry.source, ["runId", "runAttempt", "commit"]) ||
			!positiveId(entry.source.runId) || !Number.isSafeInteger(entry.source.runAttempt) ||
			Number(entry.source.runAttempt) < 1 || typeof entry.source.commit !== "string" ||
			!/^[0-9a-f]{40}$/.test(entry.source.commit) ||
			typeof entry.priorEnvelopeSha256 !== "string" ||
			!/^[0-9a-f]{64}$/.test(entry.priorEnvelopeSha256) || !Array.isArray(entry.rows))
			reject("transport diagnostic source or rows are invalid");
		const diagnosticSource = entry.source as Record<string, unknown>;
		const index = carried.findIndex(item => item.source.runId === diagnosticSource.runId &&
			item.source.runAttempt === diagnosticSource.runAttempt &&
			item.source.commit === diagnosticSource.commit);
		const linked = carried[index];
		if (index <= lastIndex || !linked || linked.parentDigest !== entry.priorEnvelopeSha256)
			reject("transport diagnostic source is not bound to accounting ancestry");
		lastIndex = index;
		const expectedIds = transportUnknownIds(linked.requestAudit);
		if (!expectedIds.length || entry.rows.length !== expectedIds.length ||
			entry.rows.some((row, rowIndex) => !record(row) || row.requestId !== expectedIds[rowIndex] ||
				(row.availability === "unavailable" ? !exactKeys(row, ["requestId", "availability"]) :
					row.availability !== "observed" || !exactKeys(row, ["requestId", "availability",
						"phase", "httpStatus", "responseStarted", "bytesRead", "abortSource",
						"providerErrorCode", "providerErrorType", "errorCodes"]) ||
					!TRANSPORT_PHASES.has(String(row.phase)) ||
					(row.httpStatus !== null && (!Number.isSafeInteger(row.httpStatus) ||
						Number(row.httpStatus) < 100 || Number(row.httpStatus) > 599)) ||
					(row.responseStarted !== null && typeof row.responseStarted !== "boolean") ||
					(row.bytesRead !== null && (!Number.isSafeInteger(row.bytesRead) || Number(row.bytesRead) < 0)) ||
					(row.abortSource !== null && !TRANSPORT_ABORTS.has(String(row.abortSource))) ||
					(row.providerErrorCode !== null && !TRANSPORT_PROVIDER_CODES.has(String(row.providerErrorCode))) ||
					(row.providerErrorType !== null && !TRANSPORT_PROVIDER_TYPES.has(String(row.providerErrorType))) ||
					!Array.isArray(row.errorCodes) || new Set(row.errorCodes).size !== row.errorCodes.length ||
					row.errorCodes.some(code => !TRANSPORT_NETWORK_CODES.has(String(code))))))
			reject("transport diagnostic rows do not match unknown request audit");
	}
	const census = parsed as HostTransportDiagnosticCensusV1;
	for (const entry of census.entries) {
		for (const row of entry.rows) {
			if (row.availability === "observed") Object.freeze(row.errorCodes);
			Object.freeze(row);
		}
		Object.freeze(entry.rows); Object.freeze(entry.source); Object.freeze(entry);
	}
	Object.freeze(census.entries);
	return Object.freeze(census);
}
function sourceOf(run: Run): Source {
	if (!Number.isSafeInteger(run.id) || run.id! <= 0 ||
		!Number.isSafeInteger(run.run_number) || run.run_number! <= 0 ||
		!Number.isSafeInteger(run.run_attempt) || run.run_attempt! <= 0 || !/^[0-9a-f]{40}$/.test(run.head_sha ?? ""))
		reject("workflow run identity is incomplete");
	return { runId: String(run.id), runAttempt: run.run_attempt!, runNumber: run.run_number!, commit: run.head_sha! };
}
function validateAccounting(cp: Pick<LegacyCheckpoint, "source" | "parentDigest" | "committedNano" |
	"unknownHeldNano" | "settledAddedNano" | "unknownAddedNano" | "requestAudit" | "bootstrapBinding">,
	expectedSource: Source, parentDigest: string, committedNano: number, unknownHeldNano: number,
	expectedBinding?: BootstrapBinding): void {
	if (!record(cp.source) || !exactKeys(cp.source, ["runId", "runAttempt", "runNumber", "commit"]) ||
		cp.parentDigest !== parentDigest || JSON.stringify(cp.source) !== JSON.stringify(expectedSource) ||
		![cp.committedNano, cp.unknownHeldNano, cp.settledAddedNano, cp.unknownAddedNano]
			.every(x => Number.isSafeInteger(x) && x >= 0) ||
		cp.committedNano !== committedNano + cp.settledAddedNano + cp.unknownAddedNano ||
		cp.unknownHeldNano !== unknownHeldNano + cp.unknownAddedNano ||
		!validAudit(cp.requestAudit, cp.settledAddedNano, cp.unknownAddedNano) ||
		(cp.bootstrapBinding !== undefined && !validBinding(cp.bootstrapBinding)) ||
		(expectedBinding !== undefined && !sameBinding(cp.bootstrapBinding, expectedBinding)))
		reject("carry checkpoint accounting is invalid");
}
function validateAccountingV3(cp: Pick<AccountingCheckpoint, "source" | "parentDigest" |
	"settledNano" | "unknownObservedNano" | "unpricedRequestCount" | "settledAddedNano" |
	"unknownObservedAddedNano" | "unpricedAddedCount" | "requestAudit" | "bootstrapBinding">,
	expectedSource: Source, parentDigest: string, settledNano: number, unknownNano: number,
	unpricedCount: number, expectedBinding?: BootstrapBinding): void {
	if (!record(cp.source) || !exactKeys(cp.source, ["runId", "runAttempt", "runNumber", "commit"]) ||
		cp.parentDigest !== parentDigest || JSON.stringify(cp.source) !== JSON.stringify(expectedSource) ||
		![cp.settledNano, cp.unknownObservedNano, cp.unpricedRequestCount, cp.settledAddedNano,
			cp.unknownObservedAddedNano, cp.unpricedAddedCount].every(x => Number.isSafeInteger(x) && x >= 0) ||
		cp.settledNano !== settledNano + cp.settledAddedNano ||
		cp.unknownObservedNano !== unknownNano + cp.unknownObservedAddedNano ||
		cp.unpricedRequestCount !== unpricedCount + cp.unpricedAddedCount ||
		!validAccountingAudit(cp.requestAudit, cp.settledAddedNano, cp.unknownObservedAddedNano,
			cp.unpricedAddedCount) ||
		(cp.bootstrapBinding !== undefined && !validBinding(cp.bootstrapBinding)) ||
		(expectedBinding !== undefined && !sameBinding(cp.bootstrapBinding, expectedBinding)))
		reject("carry checkpoint accounting is invalid");
}
function checkpointVersion(envelopeB64: string): 1 | 2 | 3 {
	const bytes = canonicalBase64(envelopeB64, MAX_CARRY_BYTES);
	let outer: unknown;
	try { outer = JSON.parse(bytes.toString("utf8")); }
	catch { return reject("carry envelope is invalid"); }
	if (!record(outer) || (outer.version !== 1 && outer.version !== 2 && outer.version !== 3))
		reject("carry envelope fields are invalid");
	return outer.version;
}
function readCheckpoint(envelopeB64: string, key: Buffer, seedDigest: string, expectedSource: Source,
	legacyParentDigest?: string): { checkpoint: Checkpoint; digest: string } {
	const envelopeBytes = canonicalBase64(envelopeB64, MAX_CARRY_BYTES);
	let outer: unknown;
	try { outer = JSON.parse(envelopeBytes.toString("utf8")); } catch { return reject("carry envelope is invalid"); }
	if (!record(outer) || (outer.version !== 1 && outer.version !== 2 && outer.version !== 3) ||
		!exactKeys(outer, ["version", "nonce", "ciphertext", "tag", ...(outer.version !== 1 ? ["parentDigest"] : [])]))
		reject("carry envelope fields are invalid");
	const parentDigest = outer.version !== 1 ? outer.parentDigest : legacyParentDigest;
	if (typeof parentDigest !== "string" || !/^[0-9a-f]{64}$/.test(parentDigest))
		reject("carry parent digest is invalid");
	const nonce = canonicalBase64(outer.nonce, 12);
	const ciphertext = canonicalBase64(outer.ciphertext, MAX_CARRY_BYTES);
	const tag = canonicalBase64(outer.tag, 16);
	if (nonce.length !== 12 || tag.length !== 16) reject("carry authentication fields are invalid");
	let bytes: Buffer;
	try {
		const decipher = createDecipheriv("aes-256-gcm", key, nonce);
		decipher.setAAD(Buffer.from(JSON.stringify([MISSION_ID, MISSION_REPOSITORY, seedDigest,
			...(outer.version === 1 ? [] : [outer.version]), parentDigest, expectedSource])));
		decipher.setAuthTag(tag);
		bytes = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
	} catch { return reject("carry authentication failed"); }
	let parsed: unknown;
	try { parsed = JSON.parse(bytes.toString("utf8")); } catch { return reject("carry plaintext is invalid"); }
	if (!record(parsed) || !exactKeys(parsed, parsed.version === 3 ?
		["version", "kind", "missionId", "repository", "seedDigest", "parentDigest", "source",
			"settledNano", "unknownObservedNano", "unpricedRequestCount", "settledAddedNano",
			"unknownObservedAddedNano", "unpricedAddedCount", "requestAudit", "ancestry",
			"legacyAncestry", "historical",
			...(parsed.opaqueExecutedRuns === undefined ? [] : ["opaqueExecutedRuns"]),
			...(parsed.currentEffectReview === undefined ? [] : ["currentEffectReview"]),
			...(parsed.pendingEffectAncestry === undefined ? [] : ["pendingEffectAncestry"]),
			...(parsed.reviewedEffectAncestry === undefined ? [] : ["reviewedEffectAncestry"]),
			...(parsed.carryForwardOrigin === undefined ? [] : ["carryForwardOrigin"]),
			...(parsed.privateBundle === undefined ? [] : ["privateBundle"]),
			...(parsed.bootstrapBinding === undefined ? [] : ["bootstrapBinding"])] :
		["version", "kind", "missionId", "repository", "seedDigest",
			"parentDigest", "source", "committedNano", "unknownHeldNano", "settledAddedNano",
			"unknownAddedNano", "requestAudit", ...(parsed.version === 2 ? ["ancestry"] : []),
			...(parsed.privateBundle === undefined ? [] : ["privateBundle"]),
			...(parsed.bootstrapBinding === undefined ? [] : ["bootstrapBinding"])]))
		reject("carry checkpoint fields are invalid");
	const cp = parsed as unknown as Checkpoint;
	if (cp.version !== outer.version || cp.kind !== "mul-pis-private-ledger-continuation" ||
		cp.missionId !== MISSION_ID || cp.repository !== MISSION_REPOSITORY || cp.seedDigest !== seedDigest ||
		cp.parentDigest !== parentDigest ||
		(cp.version !== 1 && !Array.isArray(cp.ancestry)) ||
		(cp.version === 3 && (!Array.isArray(cp.legacyAncestry) || !record(cp.historical) ||
			(cp.reviewedEffectAncestry !== undefined && !Array.isArray(cp.reviewedEffectAncestry)) ||
			(cp.opaqueExecutedRuns !== undefined && !Array.isArray(cp.opaqueExecutedRuns)) ||
			(cp.currentEffectReview !== undefined && cp.currentEffectReview !== "pending") ||
			(cp.pendingEffectAncestry !== undefined && !Array.isArray(cp.pendingEffectAncestry)))) ||
		(cp.version === 3 && cp.carryForwardOrigin !== undefined &&
			(!record(cp.carryForwardOrigin) || !exactKeys(cp.carryForwardOrigin,
				["source", "envelopeSha256", "historicalCommittedNano", "historicalUnknownHeldNano",
					"privateBundleSha256"]))) ||
		(cp.privateBundle !== undefined && !validBundle(cp.privateBundle)) ||
		(cp.bootstrapBinding !== undefined && !validBinding(cp.bootstrapBinding)) ||
		(cp.privateBundle === undefined) !== (cp.bootstrapBinding === undefined))
		reject("carry checkpoint fields are invalid");
	return { checkpoint: cp, digest: digest(envelopeBytes) };
}
function ancestorReceipt(cp: LegacyCheckpoint, envelopeDigest: string): AncestorReceipt {
	return { source: cp.source, parentDigest: cp.parentDigest, envelopeDigest,
		committedNano: cp.committedNano, unknownHeldNano: cp.unknownHeldNano,
		settledAddedNano: cp.settledAddedNano, unknownAddedNano: cp.unknownAddedNano,
		requestAudit: cp.requestAudit, ...(cp.bootstrapBinding ? { bootstrapBinding: cp.bootstrapBinding } : {}) };
}
function validateAncestry(cp: LegacyCheckpoint, sources: Source[], seedDigest: string,
	seedCommittedNano: number, seedBinding?: BootstrapBinding): void {
	if (!cp.ancestry || cp.ancestry.length !== sources.length - 1)
		reject("carry ancestry does not cover every executed workflow run");
	let parentDigest = seedDigest, committedNano = seedCommittedNano, unknownHeldNano = 0;
	let binding = seedBinding;
	for (const [index, receipt] of cp.ancestry.entries()) {
		if (!record(receipt) || !exactKeys(receipt, ["source", "parentDigest", "envelopeDigest",
			"committedNano", "unknownHeldNano", "settledAddedNano", "unknownAddedNano", "requestAudit",
			...(receipt.bootstrapBinding === undefined ? [] : ["bootstrapBinding"])]) ||
			typeof receipt.envelopeDigest !== "string" || !/^[0-9a-f]{64}$/.test(receipt.envelopeDigest))
			reject("carry ancestry receipt is invalid");
		validateAccounting(receipt, sources[index], parentDigest, committedNano, unknownHeldNano, binding);
		parentDigest = receipt.envelopeDigest;
		committedNano = receipt.committedNano; unknownHeldNano = receipt.unknownHeldNano;
		binding = receipt.bootstrapBinding;
	}
	validateAccounting(cp, sources.at(-1)!, parentDigest, committedNano, unknownHeldNano, binding);
}
function accountingAncestorReceipt(cp: AccountingCheckpoint, envelopeDigest: string): AccountingAncestorReceipt {
	return { source: cp.source, parentDigest: cp.parentDigest, envelopeDigest,
		settledNano: cp.settledNano, unknownObservedNano: cp.unknownObservedNano,
		unpricedRequestCount: cp.unpricedRequestCount, settledAddedNano: cp.settledAddedNano,
		unknownObservedAddedNano: cp.unknownObservedAddedNano, unpricedAddedCount: cp.unpricedAddedCount,
		requestAudit: cp.requestAudit,
		...(cp.bootstrapBinding ? { bootstrapBinding: cp.bootstrapBinding } : {}) };
}
function validOpaqueGap(value: unknown): value is OpaqueExecutedRunGap {
	if (!record(value) || !exactKeys(value, ["version", "kind", "source",
		"priorCarryEnvelopeSha256", "carryArtifact", "accounting", "effects",
		"terminal", "resultArtifact"]) || value.version !== 1 ||
		value.kind !== "opaque-executed-run-gap" || value.carryArtifact !== "absent" ||
		value.accounting !== "unquantified" ||
		!["unreviewed", "quarantined-source-reviewed"].includes(String(value.effects)) ||
		!record(value.source) || !exactKeys(value.source, ["runId", "runAttempt", "runNumber", "commit"]) ||
		!positiveId(value.source.runId) || !Number.isSafeInteger(value.source.runAttempt) ||
		Number(value.source.runAttempt) < 1 || !Number.isSafeInteger(value.source.runNumber) ||
		Number(value.source.runNumber) < 1 || typeof value.source.commit !== "string" ||
		!/^[0-9a-f]{40}$/.test(value.source.commit) ||
		typeof value.priorCarryEnvelopeSha256 !== "string" ||
		!/^[0-9a-f]{64}$/.test(value.priorCarryEnvelopeSha256) ||
		!record(value.terminal) || !exactKeys(value.terminal, ["workflowId", "runStatus",
			"runConclusion", "jobId", "jobName", "jobStatus", "jobConclusion",
			"jobRunId", "jobRunAttempt", "jobHeadSha", "providerStepStatus",
			"providerStepConclusion"]) ||
		value.terminal.runStatus !== "completed" || value.terminal.jobStatus !== "completed" ||
		value.terminal.jobName !== "private-campaign" ||
		value.terminal.providerStepStatus !== "completed" ||
		value.terminal.jobRunId !== value.source.runId ||
		value.terminal.jobRunAttempt !== value.source.runAttempt ||
		value.terminal.jobHeadSha !== value.source.commit ||
		!record(value.resultArtifact) || !exactKeys(value.resultArtifact, ["repository",
			"artifactId", "artifactName", "runId", "archiveSha256", "digestScope"]) ||
		value.resultArtifact.repository !== MISSION_REPOSITORY ||
		value.resultArtifact.artifactName !== MISSION_ARTIFACT ||
		value.resultArtifact.runId !== value.source.runId ||
		!positiveId(value.resultArtifact.artifactId) ||
		value.resultArtifact.digestScope !== "github-artifact-archive" ||
		typeof value.resultArtifact.archiveSha256 !== "string" ||
		!/^[0-9a-f]{64}$/.test(value.resultArtifact.archiveSha256)) return false;
	return true;
}
function hasNoV3ProviderActivity(cp: Pick<AccountingCheckpoint, "settledAddedNano" |
	"unknownObservedAddedNano" | "unpricedAddedCount" | "requestAudit">): boolean {
	return cp.settledAddedNano === 0 &&
		cp.unknownObservedAddedNano === 0 && cp.unpricedAddedCount === 0 &&
		cp.requestAudit.requests.length === 0 && cp.requestAudit.settledCny === 0 &&
		cp.requestAudit.unknownObservedCny === 0 && cp.requestAudit.unpricedRequestCount === 0;
}
function reviewedEffectPrefixValid(cp: AccountingCheckpoint): boolean {
	const accounting = [...cp.ancestry, accountingAncestorReceipt(cp, "0".repeat(64))];
	const nonzero = cp.ancestry.map((row, index) => ({ row, index }))
		.filter(({ row }) => !hasNoV3ProviderActivity(row));
	const reviewed = cp.reviewedEffectAncestry ?? [];
	if (reviewed.length > cp.ancestry.length ||
		reviewed.some(item => !record(item) || !exactKeys(item, ["source", "envelopeSha256",
			"privateBundleSha256", "reviewedPolicySha256", "selectedTupleSha256",
			"historicalOriginEnvelopeSha256",
			...(item.abandonedWithoutGoal === undefined ? [] : ["abandonedWithoutGoal"])]) ||
			(item.abandonedWithoutGoal !== undefined && item.abandonedWithoutGoal !== true))) return false;
	if (!reviewed.length) return true;
	let chain: unknown;
	try { chain = JSON.parse(cp.privateBundle?.["independent-restart-quarantine.json"] ?? ""); }
	catch { return false; }
	if (!record(chain) || chain.version !== 1 ||
		chain.kind !== "host-independent-restart-reservations" || !Array.isArray(chain.entries)) return false;
	let bindings: unknown;
	try { bindings = JSON.parse(cp.privateBundle?.["independent-restart-goal-binding.json"] ?? ""); }
	catch { return false; }
	if (!record(bindings) || bindings.version !== 1 ||
		bindings.kind !== "host-independent-restart-goal-bindings" ||
		!Array.isArray(bindings.entries)) return false;
	let lastIndex = -1;
	for (const entry of reviewed) {
		const index = cp.ancestry.findIndex(row =>
			JSON.stringify(row.source) === JSON.stringify(entry.source) &&
			row.envelopeDigest === entry.envelopeSha256);
		if (index <= lastIndex) return false;
		lastIndex = index;
		const prior = cp.ancestry[index];
		const next = accounting[index + 1].source;
		if (!record(entry.source) || !exactKeys(entry.source, ["runId", "runAttempt", "runNumber", "commit"]) ||
			JSON.stringify(entry.source) !== JSON.stringify(prior.source) ||
			entry.envelopeSha256 !== prior.envelopeDigest ||
			entry.historicalOriginEnvelopeSha256 !== cp.historical.legacyParentDigest ||
			![entry.envelopeSha256, entry.privateBundleSha256, entry.reviewedPolicySha256,
				entry.selectedTupleSha256, entry.historicalOriginEnvelopeSha256]
				.every(value => typeof value === "string" && /^[0-9a-f]{64}$/.test(value))) return false;
		const matches = chain.entries.filter(item => {
			if (!record(item) || !record(item.receipt) || !record(item.claim) ||
				!record(item.receipt.prior) || !record(item.receipt.prior.source) ||
				!record(item.receipt.quarantine) || !record(item.receipt.freshWorkspace)) return false;
			const receipt = item.receipt as Record<string, unknown>;
			const workspace = receipt.freshWorkspace as Record<string, unknown>;
			const p = receipt.prior as Record<string, unknown>, claim = item.claim;
			const source = p.source as Record<string, unknown>;
			const receiptDigest = digest(JSON.stringify(receipt));
			const bindingMatches = (bindings.entries as unknown[]).filter((binding: unknown) => record(binding) &&
				binding.version === 1 && binding.kind === "host-independent-goal-binding" &&
				binding.quarantineReceiptSha256 === receiptDigest &&
				record(binding.freshWorkspace) &&
				binding.freshWorkspace.workspaceId === workspace.workspaceId &&
				binding.freshWorkspace.restartNonce === workspace.restartNonce &&
				typeof binding.goalRunId === "string" && binding.goalRunId.length > 0);
			const quarantine = receipt.quarantine as Record<string, unknown>;
			return receipt.version === 1 &&
				receipt.kind === "host-independent-goal-quarantine" &&
				quarantine.operationOutcome === "unknown" &&
				quarantine.selectedFromFailedAttempt === false &&
				bindingMatches.length === (entry.abandonedWithoutGoal ? 0 : 1) &&
				typeof claim.claimId === "string" && claim.claimId.length > 0 &&
				typeof claim.currentJobId === "string" && claim.currentJobId.length > 0 &&
				source.runId === entry.source.runId &&
				source.runAttempt === entry.source.runAttempt &&
				source.commit === entry.source.commit &&
				p.envelopeSha256 === entry.envelopeSha256 &&
				p.privateBundleSha256 === entry.privateBundleSha256 &&
				p.reviewedPolicySha256 === entry.reviewedPolicySha256 &&
				p.selectedTupleSha256 === entry.selectedTupleSha256 &&
				claim.priorEnvelopeSha256 === entry.envelopeSha256 &&
				claim.currentRunId === next.runId &&
				claim.currentRunAttempt === next.runAttempt &&
				claim.currentCommit === next.commit;
		});
		if (matches.length !== 1) return false;
	}
	const reviewedNonzero = reviewed.filter(entry => nonzero.some(item =>
		item.row.envelopeDigest === entry.envelopeSha256));
	return reviewedNonzero.every((entry, index) =>
		nonzero[index]?.row.envelopeDigest === entry.envelopeSha256);
}
function newlyReviewedPriorEffect(proof: AuthenticatedPriorCarryProof | undefined,
	currentSource: Source, prior: AccountingAncestorReceipt | undefined,
	bundle: PrivateContinuationBundle | undefined,
	origin: AuthenticatedCarryForwardOrigin | undefined,
	abandonedWithoutGoal = false): ReviewedEffectAncestorReceipt | undefined {
	if (!proof || !isAuthenticatedPriorCarryProof(proof) || !proof.resultArtifact ||
		!prior || !origin ||
		!proof.privateBundleSha256 || !bundle?.["independent-restart-quarantine.json"] ||
		JSON.stringify(proof.source) !== JSON.stringify(prior.source) ||
		proof.envelopeSha256 !== prior.envelopeDigest) return undefined;
	let chain: unknown;
	try { chain = JSON.parse(bundle["independent-restart-quarantine.json"]); }
	catch { return undefined; }
	if (!record(chain) || chain.version !== 1 ||
		chain.kind !== "host-independent-restart-reservations" || !Array.isArray(chain.entries)) return undefined;
	const matches = chain.entries.filter(item => {
		if (!record(item) || !record(item.receipt) || !record(item.receipt.prior) ||
			!record(item.receipt.prior.source) || !record(item.claim)) return false;
		const p = item.receipt.prior, claim = item.claim;
		const source = p.source as Record<string, unknown>;
		return source.runId === proof.source.runId &&
			source.runAttempt === proof.source.runAttempt &&
			source.commit === proof.source.commit &&
			p.envelopeSha256 === proof.envelopeSha256 &&
			p.privateBundleSha256 === proof.privateBundleSha256 &&
			typeof p.reviewedPolicySha256 === "string" && /^[0-9a-f]{64}$/.test(p.reviewedPolicySha256) &&
			typeof p.selectedTupleSha256 === "string" && /^[0-9a-f]{64}$/.test(p.selectedTupleSha256) &&
			claim.priorEnvelopeSha256 === proof.envelopeSha256 &&
			claim.currentRunId === currentSource.runId &&
			claim.currentRunAttempt === currentSource.runAttempt &&
			claim.currentCommit === currentSource.commit;
	});
	if (matches.length !== 1) return undefined;
	const p = matches[0].receipt.prior;
	return { source: { ...proof.source }, envelopeSha256: proof.envelopeSha256,
		privateBundleSha256: proof.privateBundleSha256,
		reviewedPolicySha256: p.reviewedPolicySha256,
		selectedTupleSha256: p.selectedTupleSha256,
		historicalOriginEnvelopeSha256: origin.envelopeSha256,
		...(abandonedWithoutGoal ? { abandonedWithoutGoal: true as const } : {}) };
}
function distinctStrings(values: unknown, pattern: RegExp): values is string[] {
	return Array.isArray(values) && values.every(value => typeof value === "string" &&
		pattern.test(value)) && new Set(values).size === values.length;
}
function restartChainExtends(prior: string | undefined, current: string | undefined,
	kind: string, added: number): boolean {
	if (added !== 0 && added !== 1) return false;
	if (!prior && !current) return added === 0;
	let before: unknown, after: unknown;
	try {
		before = prior ? JSON.parse(prior) : { version: 1, kind, entries: [] };
		after = current ? JSON.parse(current) : undefined;
	} catch { return false; }
	return record(before) && record(after) && before.version === 1 && after.version === 1 &&
		before.kind === kind && after.kind === kind && Array.isArray(before.entries) &&
		Array.isArray(after.entries) && after.entries.length === before.entries.length + added &&
		before.entries.every((entry, index) => JSON.stringify(entry) ===
			JSON.stringify((after.entries as unknown[])[index]));
}
function hostEffectReceipt(cp: AccountingCheckpoint,
	previousBundle?: PrivateContinuationBundle): HostEffectReceiptV1 | undefined {
	const raw = cp.privateBundle?.["host-effect-receipt.json"];
	if (!raw || !cp.privateBundle?.["objective-checkpoint.json"] ||
		cp.requestAudit.requests.some(row => row.status === "in-flight" || !row.sessionId ||
			(row.responseReceived !== true && (row.responseReceived !== false ||
				row.status !== "unknown" || row.settledCny !== null ||
				(row.unknownObservedCny !== null && row.unknownObservedCny <= 0))))) return undefined;
	let receipt: unknown, checkpoint: unknown, priorCheckpoint: unknown;
	try {
		receipt = JSON.parse(raw); checkpoint = JSON.parse(cp.privateBundle["objective-checkpoint.json"]);
		if (previousBundle?.["objective-checkpoint.json"])
			priorCheckpoint = JSON.parse(previousBundle["objective-checkpoint.json"]);
	} catch { return undefined; }
	if (!record(receipt) || !exactKeys(receipt, ["version", "kind", "source", "priorEnvelopeSha256",
		"historicalGoalRunIds", "goals", "sessions", "requestIds"]) ||
		receipt.version !== 1 || receipt.kind !== "m07-host-effect-census" ||
		!record(receipt.source) || !exactKeys(receipt.source, ["runId", "runAttempt", "commit"]) ||
		receipt.source.runId !== cp.source.runId || receipt.source.runAttempt !== cp.source.runAttempt ||
		receipt.source.commit !== cp.source.commit || receipt.priorEnvelopeSha256 !== cp.parentDigest ||
		!record(checkpoint) || !Array.isArray(checkpoint.boundedRuns) ||
		!distinctStrings(receipt.historicalGoalRunIds, /^[A-Za-z0-9._:-]{1,256}$/) ||
		!Array.isArray(receipt.goals) || !Array.isArray(receipt.sessions) ||
		!distinctStrings(receipt.requestIds, /^[A-Za-z0-9._:-]{1,128}$/)) return undefined;
	if (cp.requestAudit.requests.length === 0 &&
		(!hasNoV3ProviderActivity(cp) || receipt.goals.length !== 0 ||
			receipt.sessions.some(session => session?.kind !== "none" && session?.kind !== "read-dir") ||
			receipt.requestIds.length !== 0)) return undefined;
	if (previousBundle && (!record(priorCheckpoint) || !Array.isArray(priorCheckpoint.boundedRuns) ||
		JSON.stringify(receipt.historicalGoalRunIds) !==
		JSON.stringify(priorCheckpoint.boundedRuns.map(row => row.runId)))) return undefined;
	const auditIds = cp.requestAudit.requests.map(row => row.requestId);
	if (receipt.requestIds.length !== auditIds.length ||
		receipt.requestIds.some(id => !auditIds.includes(id))) return undefined;
	const sessions = new Map<string, Record<string, unknown>>();
	for (const session of receipt.sessions) {
		if (!record(session) || typeof session.sessionId !== "string" ||
			!/^[0-9a-f]{64}$/.test(session.sessionId) || sessions.has(session.sessionId)) return undefined;
		if (session.kind === "none" || session.kind === "read-dir") {
			if (!exactKeys(session, ["sessionId", "kind"])) return undefined;
		} else if (session.kind === "confined-execution") {
			if (!exactKeys(session, ["sessionId", "kind", "goalRunId", "taskId", "workRoot", "grant"]) ||
				typeof session.goalRunId !== "string" || !session.goalRunId ||
				typeof session.taskId !== "string" || !/^T\d{3,}$/.test(session.taskId) ||
				typeof session.workRoot !== "string" || !session.workRoot.startsWith("/") ||
				!record(session.grant) || !exactKeys(session.grant, ["version", "kind", "root", "writableFiles"]) ||
				session.grant.version !== 1 || session.grant.kind !== "confined-campaign-files" ||
				session.grant.root !== session.workRoot ||
				!Array.isArray(session.grant.writableFiles) ||
				!["candidate.cpp|lesson-delta.json", "candidate.cpp|experiment-plan.json|lesson-delta.json"]
					.includes([...session.grant.writableFiles].sort().join("|"))) return undefined;
		} else return undefined;
		sessions.set(session.sessionId, session);
	}
	if (cp.requestAudit.requests.some(row => !sessions.has(row.sessionId!))) return undefined;
	// Transport uncertainty is a billing/operation hold, not evidence of a remote
	// actor effect. It is admissible only inside one factory-confined failed task.
	const unreceivedSessions = new Set(cp.requestAudit.requests.filter(row =>
		row.responseReceived === false).map(row => row.sessionId!));
	if ([...unreceivedSessions].some(id => sessions.get(id)?.kind !== "confined-execution"))
		return undefined;
	const historicalGoalRunIds = receipt.historicalGoalRunIds as string[];
	const expectedGoals = checkpoint.boundedRuns.filter(row =>
		!historicalGoalRunIds.includes(row.runId));
	if (receipt.goals.length !== expectedGoals.length || new Set(receipt.goals.map(goal => goal?.runId)).size !== receipt.goals.length ||
		receipt.goals.some(goal => !record(goal) || !exactKeys(goal, ["runId", "outcome", "tasks", "operations"]) ||
			!expectedGoals.some(row => row.runId === goal.runId && row.outcome === goal.outcome) ||
			!Array.isArray(goal.tasks) || !Array.isArray(goal.operations))) return undefined;
	const usedSessions = new Set<string>();
	for (const goal of receipt.goals as HostEffectReceiptV1["goals"]) {
		const taskIds = new Set<string>(), operationIds = new Set<string>();
		for (const task of goal.tasks) {
			if (!record(task) || !exactKeys(task, ["taskId", "mode", "status", "sessionId"]) ||
				!/^T\d{3,}$/.test(task.taskId) || taskIds.has(task.taskId) ||
				!["execute", "check"].includes(task.mode) ||
				!["returned", "failed", "accepted", "rejected"].includes(task.status) ||
				typeof task.sessionId !== "string" || !sessions.has(task.sessionId) ||
				usedSessions.has(task.sessionId)) return undefined;
			taskIds.add(task.taskId); usedSessions.add(task.sessionId);
			const session = sessions.get(task.sessionId)!;
			if (task.mode === "execute" ? session.kind !== "confined-execution" ||
				session.goalRunId !== goal.runId || session.taskId !== task.taskId :
				session.kind !== "read-dir") return undefined;
		}
		for (const operation of goal.operations) {
			if (!record(operation) || !exactKeys(operation, ["id", "taskId", "status"]) ||
				!/^O\d{3,}$/.test(operation.id) || operationIds.has(operation.id) ||
				!taskIds.has(operation.taskId) ||
				!(["response-received", "unknown"].includes(operation.status))) return undefined;
			if (operation.status === "unknown") {
				const task = goal.tasks.find(item => item.taskId === operation.taskId);
				if (goal.outcome !== "active" || task?.mode !== "execute" ||
					task.status !== "failed" || !unreceivedSessions.has(task.sessionId) ||
					!expectedGoals.find(item => item.runId === goal.runId)?.unresolvedOperationIds?.includes(operation.id))
					return undefined;
			}
			operationIds.add(operation.id);
		}
		if (goal.tasks.some(task => task.mode === "execute" &&
			!goal.operations.some(operation => operation.taskId === task.taskId))) return undefined;
	}
	if ([...unreceivedSessions].some(id => !(receipt.goals as HostEffectReceiptV1["goals"]).some(goal =>
		goal.tasks.some(task => task.sessionId === id && task.mode === "execute" &&
			task.status === "failed" && goal.operations.some(operation =>
				operation.taskId === task.taskId && operation.status === "unknown"))))) return undefined;
	if ([...sessions.values()].some(session => session.kind === "confined-execution" &&
		!usedSessions.has(session.sessionId as string))) return undefined;
	return receipt as HostEffectReceiptV1;
}
/** A research-only assessor may consume received provider responses without
 * creating an M07 goal. Its model grant is read-only and its unbound restart
 * claim remains spent. The assessment changes research state, not old effects.
 */
function assessmentOnlyNoGoal(cp: AccountingCheckpoint, receipt: HostEffectReceiptV1 | undefined,
	previousBundle?: PrivateContinuationBundle): boolean {
	if (!receipt || receipt.goals.length !== 0 || cp.requestAudit.requests.length === 0 ||
		receipt.sessions.some(session => session.kind !== "none" && session.kind !== "read-dir") ||
		cp.requestAudit.requests.some(row => row.responseReceived !== true ||
			row.status === "in-flight" || !row.sessionId)) return false;
	let current: ObjectiveProgressV1, prior: ObjectiveProgressV1 | undefined;
	let chain: unknown, priorChain: unknown;
	try {
		current = JSON.parse(cp.privateBundle?.["objective-checkpoint.json"] ?? "");
		chain = JSON.parse(cp.privateBundle?.["objective-assessment-receipts.json"] ?? "");
		if (previousBundle) {
			prior = JSON.parse(previousBundle["objective-checkpoint.json"] ?? "");
			priorChain = previousBundle["objective-assessment-receipts.json"] ?
				JSON.parse(previousBundle["objective-assessment-receipts.json"]) :
				{ version: 1, kind: "m07-original-objective-assessment-receipts", receipts: [] };
		}
	} catch { return false; }
	if (current?.version !== 1 || current.kind !== "original-objective-progress" ||
		current.objectiveOutcome !== "incomplete" || typeof current.stopReason !== "string" ||
		!Array.isArray(current.boundedRuns) || !Array.isArray(current.selectedArtifacts) ||
		!Array.isArray(current.availableArtifacts) || !Array.isArray(current.assessmentHistory) ||
		!record(chain) || chain.version !== 1 ||
		chain.kind !== "m07-original-objective-assessment-receipts" ||
		!Array.isArray(chain.receipts) || chain.receipts.length < 1) return false;
	const latest = chain.receipts.at(-1);
	if (!record(latest) || !["completed", "failed"].includes(String(latest.status)) ||
		!Array.isArray(latest.sessions) || latest.sessions.length < 1 ||
		latest.sessions.some(session => !record(session) ||
			(session.toolGrantKind !== "none" && session.toolGrantKind !== "read-dir") ||
			(session.boundaryMode !== "fresh" || session.boundaryIntent !== "independent-judgment") ||
			typeof session.sessionId !== "string" ||
			!receipt.sessions.some(saved => saved.sessionId === campaignSessionEffectId(String(session.sessionId)) &&
				saved.kind === session.toolGrantKind))) return false;
	if (current.assessment && !latest.sessions.some(session =>
		record(session) && session.sessionId === current.assessment?.sessionId)) return false;
	if (new Set(current.availableArtifacts).size !== current.availableArtifacts.length ||
		current.availableArtifacts.some(name => typeof name !== "string" || !name)) return false;
	if (prior) {
		if (prior.version !== 1 || prior.kind !== "original-objective-progress" ||
			prior.objectiveOutcome !== "incomplete" || !record(priorChain) ||
			priorChain.version !== 1 || priorChain.kind !== chain.kind ||
			!Array.isArray(priorChain.receipts) ||
			chain.receipts.length !== priorChain.receipts.length + 1 ||
			!priorChain.receipts.every((row, index) =>
				JSON.stringify(row) === JSON.stringify((chain.receipts as unknown[])[index])) ||
			JSON.stringify(current.contract) !== JSON.stringify(prior.contract) ||
			JSON.stringify(current.boundedRuns) !== JSON.stringify(prior.boundedRuns) ||
			JSON.stringify(current.selectedArtifacts) !== JSON.stringify(prior.selectedArtifacts) ||
			!prior.availableArtifacts.every(name => current.availableArtifacts.includes(name)) ||
			current.availableArtifacts.some(name => !prior!.availableArtifacts.includes(name) &&
				!["execution-capabilities.json", "restored-candidate-verification.json"].includes(name)) ||
			!Array.isArray(prior.assessmentHistory) ||
			current.assessmentHistory.length !== prior.assessmentHistory.length + 1 ||
			prior.assessmentHistory.some((row, index) =>
				JSON.stringify(row) !== JSON.stringify(current.assessmentHistory[index]))) return false;
		const last = current.assessmentHistory.at(-1);
		if (!last || last.iteration !== prior.assessmentHistory.length + 1 ||
			last.advanced !== false || last.stopReason !== current.stopReason ||
			JSON.stringify(last.assessment) !== JSON.stringify(current.assessment)) return false;
	}
	try {
		const unresolved = prior ? canonicalRestartUnknowns(prior).operationRefs :
			current.continuation.unresolvedOperationIds;
		const recomputed = objectiveProgress(current.contract, {
			boundedRuns: current.boundedRuns, selectedArtifacts: current.selectedArtifacts,
			availableArtifacts: current.availableArtifacts, unresolvedOperationIds: unresolved,
			assessment: current.assessment, assessmentHistory: current.assessmentHistory,
			stopReason: current.stopReason });
		return JSON.stringify(recomputed) === JSON.stringify(current);
	} catch { return false; }
}
/** An older writer omitted carryForwardOrigin when one provider response was lost.
 * Recover only when the selected tuple is byte-for-byte the one sealed by the
 * latest authenticated restart link. This does not settle the lost transport.
 */
/** The old-writer recovery path cannot change the signed original mission under a reused ID. */
export function originalObjectiveMatchesSignedBootstrap(bundle: PrivateContinuationBundle | undefined,
	signedOriginalObjective: string | undefined): boolean {
	if (!bundle || typeof signedOriginalObjective !== "string" ||
		bundle["original-objective.json"] !== signedOriginalObjective) return false;
	let checkpoint: unknown, originalObjective: unknown;
	try {
		checkpoint = JSON.parse(bundle["objective-checkpoint.json"] ?? "");
		originalObjective = JSON.parse(signedOriginalObjective);
	}
	catch { return false; }
	return record(checkpoint) && record(originalObjective) &&
		JSON.stringify(checkpoint.contract) === JSON.stringify(originalObjective);
}
function unchangedReviewedSelection(cp: AccountingCheckpoint,
	signedOriginalObjective: string | undefined): boolean {
	const prior = cp.reviewedEffectAncestry?.at(-1);
	const bundle = cp.privateBundle;
	if (!prior || !originalObjectiveMatchesSignedBootstrap(bundle, signedOriginalObjective)) return false;
	const files = bundle! as Record<string, string | undefined>;
	let checkpoint: unknown;
	try { checkpoint = JSON.parse(files["objective-checkpoint.json"] ?? ""); }
	catch { return false; }
	if (!record(checkpoint)) return false;
	const selected = checkpoint.selectedArtifacts;
	if (!distinctStrings(selected, /^[A-Za-z0-9._-]{1,128}$/) || !selected.length ||
		selected.some(name => typeof files[name] !== "string")) return false;
	const tuple = selected.slice().sort().map(name => ({ name,
		sha256: digest(files[name]!), bytes: Buffer.byteLength(files[name]!, "utf8") }));
	return digest(JSON.stringify(tuple)) === prior.selectedTupleSha256;
}
function validateAncestryV3(cp: AccountingCheckpoint, sources: Source[], seedDigest: string,
	seedCommittedNano: number, seedBinding?: BootstrapBinding): void {
	if (!Array.isArray(cp.legacyAncestry) || !record(cp.historical) ||
		!exactKeys(cp.historical, ["committedNano", "unknownHeldNano", "legacyParentDigest"]) ||
		cp.legacyAncestry.length > sources.length - 1)
		reject("accounting-only transition receipt is invalid");
	let legacyParentDigest = seedDigest, committedNano = seedCommittedNano, unknownHeldNano = 0;
	let binding = seedBinding;
	for (const [index, receipt] of cp.legacyAncestry.entries()) {
		if (!record(receipt) || !exactKeys(receipt, ["source", "parentDigest", "envelopeDigest",
			"committedNano", "unknownHeldNano", "settledAddedNano", "unknownAddedNano", "requestAudit",
			...(receipt.bootstrapBinding === undefined ? [] : ["bootstrapBinding"])]) ||
			typeof receipt.envelopeDigest !== "string" || !/^[0-9a-f]{64}$/.test(receipt.envelopeDigest))
			reject("historical carry ancestry receipt is invalid");
		validateAccounting(receipt, sources[index], legacyParentDigest, committedNano, unknownHeldNano, binding);
		legacyParentDigest = receipt.envelopeDigest;
		committedNano = receipt.committedNano; unknownHeldNano = receipt.unknownHeldNano;
		binding = receipt.bootstrapBinding;
	}
	if (cp.historical.committedNano !== committedNano ||
		cp.historical.unknownHeldNano !== unknownHeldNano ||
		cp.historical.legacyParentDigest !== legacyParentDigest)
		reject("historical commitment transition is invalid");
	const gaps = cp.opaqueExecutedRuns ?? [];
	let previousGapIndex = cp.legacyAncestry.length - 1;
	for (const gap of gaps) {
		const index = sources.findIndex(source => JSON.stringify(source) === JSON.stringify(gap.source));
		if (!validOpaqueGap(gap) || index <= previousGapIndex || index >= sources.length - 1)
			reject("opaque executed run gap is not an exact ordered workflow source");
		previousGapIndex = index;
	}
	const gapRunIds = new Set(gaps.map(gap => gap.source.runId));
	const accountingSources = sources.slice(cp.legacyAncestry.length)
		.filter(source => !gapRunIds.has(source.runId));
	if (!accountingSources.length || accountingSources.at(-1)?.runId !== cp.source.runId)
		reject("opaque gap cannot replace the current authenticated carry source");
	if (cp.ancestry.length !== accountingSources.length - 1)
		reject("carry ancestry does not cover every executed workflow run");
	let parentDigest = legacyParentDigest, settledNano = 0, unknownNano = 0;
	let unpricedCount = 0;
	for (const [index, receipt] of cp.ancestry.entries()) {
		if (!record(receipt) || !exactKeys(receipt, ["source", "parentDigest", "envelopeDigest",
			"settledNano", "unknownObservedNano", "unpricedRequestCount", "settledAddedNano",
			"unknownObservedAddedNano", "unpricedAddedCount", "requestAudit",
			...(receipt.bootstrapBinding === undefined ? [] : ["bootstrapBinding"])]) ||
			typeof receipt.envelopeDigest !== "string" || !/^[0-9a-f]{64}$/.test(receipt.envelopeDigest))
			reject("carry ancestry receipt is invalid");
		validateAccountingV3(receipt, accountingSources[index], parentDigest, settledNano, unknownNano,
			unpricedCount, binding);
		parentDigest = receipt.envelopeDigest;
		settledNano = receipt.settledNano; unknownNano = receipt.unknownObservedNano;
		unpricedCount = receipt.unpricedRequestCount; binding = receipt.bootstrapBinding;
	}
	validateAccountingV3(cp, accountingSources.at(-1)!, parentDigest, settledNano, unknownNano,
		unpricedCount, binding);
	// A compacted gap keeps the digest of the actual preceding ciphertext. No
	// later carry may silently re-anchor that gap to a different research state.
	const carryReceipts = [...cp.legacyAncestry, ...cp.ancestry];
	for (const gap of gaps) {
		const gapIndex = sources.findIndex(source => source.runId === gap.source.runId);
		const preceding = carryReceipts.map(receipt => ({ receipt,
			index: sources.findIndex(source => source.runId === receipt.source.runId) }))
			.filter(row => row.index >= 0 && row.index < gapIndex)
			.sort((a, b) => b.index - a.index)[0]?.receipt;
		if (!preceding || gap.priorCarryEnvelopeSha256 !== preceding.envelopeDigest)
			reject("opaque gap predecessor digest is not the authenticated carry prefix");
	}
	let pendingIndex = -1;
	for (const source of cp.pendingEffectAncestry ?? []) {
		const index = cp.ancestry.findIndex(row => JSON.stringify(row.source) === JSON.stringify(source));
		if (!record(source) || !exactKeys(source, ["runId", "runAttempt", "runNumber", "commit"]) ||
			index <= pendingIndex) reject("pending effect ancestry is not an exact ordered carry source");
		pendingIndex = index;
	}
	if (!reviewedEffectPrefixValid(cp))
		reject("reviewed effect ancestry does not match prior accounting and host restart claims");
	transportDiagnosticCensus(cp);
}
function sealCheckpoint(cp: Checkpoint, key: Buffer): string {
	const nonce = randomBytes(12);
	const cipher = createCipheriv("aes-256-gcm", key, nonce);
	cipher.setAAD(Buffer.from(JSON.stringify([MISSION_ID, MISSION_REPOSITORY, cp.seedDigest,
		...(cp.version === 1 ? [] : [cp.version]), cp.parentDigest, cp.source])));
	const ciphertext = Buffer.concat([cipher.update(JSON.stringify(cp), "utf8"), cipher.final()]);
	const outer = { version: cp.version, ...(cp.version !== 1 ? { parentDigest: cp.parentDigest } : {}),
		nonce: nonce.toString("base64"), ciphertext: ciphertext.toString("base64"), tag: cipher.getAuthTag().toString("base64") };
	const bytes = Buffer.from(JSON.stringify(outer));
	const envelopeB64 = bytes.toString("base64");
	if (bytes.length > MAX_CARRY_BYTES || Buffer.byteLength(JSON.stringify({ envelopeB64 })) > MAX_CARRY_BYTES)
		reject("carry exceeds private artifact limit");
	return envelopeB64;
}
async function githubJson(url: string, token: string, request: typeof fetch): Promise<Record<string, unknown>> {
	let response: Response;
	try { response = await request(url, { method: "GET", redirect: "error", signal: AbortSignal.timeout(15_000),
		headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}` } }); }
	catch { return reject("GitHub carry freshness check could not complete"); }
	if (response.status !== 200) reject("GitHub carry freshness check was not accepted");
	let value: unknown;
	try { value = await response.json(); } catch { return reject("GitHub carry freshness response is invalid"); }
	if (!record(value)) reject("GitHub carry freshness response is invalid");
	return value;
}
/** Read-only GitHub check. Its boolean alone never brands or authorizes a carry. */
export async function reviewedLegacyV3SourceTree(token: string, request: typeof fetch): Promise<boolean> {
	const base = `https://api.github.com/repos/${MISSION_REPOSITORY}/git/commits`;
	const submitted = await githubJson(`${base}/${ONE_TIME_LEGACY_V3_REQUEST}`, token, request);
	const source = await githubJson(`${base}/${ONE_TIME_LEGACY_V3_SOURCE}`, token, request);
	const parents = submitted.parents;
	return submitted.sha === ONE_TIME_LEGACY_V3_REQUEST &&
		source.sha === ONE_TIME_LEGACY_V3_SOURCE &&
		Array.isArray(parents) && [1, 2].includes(parents.length) &&
		parents.every(parent => record(parent) && typeof parent.sha === "string" &&
			/^[0-9a-f]{40}$/.test(parent.sha)) &&
		parents[0].sha === ONE_TIME_LEGACY_V3_SOURCE &&
		record(submitted.tree) && record(source.tree) &&
		typeof submitted.tree.sha === "string" &&
		/^[0-9a-f]{40}$/.test(submitted.tree.sha) &&
		submitted.tree.sha === source.tree.sha;
}
/** One root-reviewed missing-carry exception. The pinned prior envelope binds
 * the selected tuple checked against the private result by the owner; Actions
 * still independently proves the exact executable source tree and result ZIP.
 * No other missing-carry source gains authority from this function. */
export async function reviewKnownOpaqueGapSource(facts: { source: Readonly<Source>;
	terminal: AuthenticatedPriorCarryProof["terminal"];
	resultArtifact: NonNullable<AuthenticatedPriorCarryProof["resultArtifact"]>;
	priorCarryEnvelopeSha256: string }, githubToken: string,
	request: typeof fetch = fetch): Promise<AuthenticatedOpaqueGapSourceReview | undefined> {
	const source = facts.source;
	const requestCommit = "db8263c88d9872cd592b43c70f7831cf74e290eb";
	const reviewedFirstParent = "6ee929545ec3a1d7194054aa4e98988ecd1bd665";
	if (source.runId !== "37507828650" || source.runAttempt !== 1 ||
		source.runNumber !== 26 ||
		source.commit !== requestCommit ||
		facts.priorCarryEnvelopeSha256 !==
			"0f29b2f1b5ef0d3bee9b53e7d86168621f904c355bf55d46c5557d4cbd6d412c" ||
		facts.resultArtifact.repository !== MISSION_REPOSITORY ||
		facts.resultArtifact.artifactId !== "11431834153" ||
		facts.resultArtifact.artifactName !== MISSION_ARTIFACT ||
		facts.resultArtifact.runId !== source.runId ||
		facts.resultArtifact.digestScope !== "github-artifact-archive" ||
		facts.resultArtifact.archiveSha256 !==
			"9c0c4e887c4a212148f0b52aa9e3f96448d50d153b3151e1a741d66bd5f472b5" ||
		facts.terminal.workflowId !== "374865232" ||
		facts.terminal.runStatus !== "completed" ||
		facts.terminal.runConclusion !== "failure" ||
		facts.terminal.jobId !== "112420914600" ||
		facts.terminal.jobName !== "private-campaign" ||
		facts.terminal.jobStatus !== "completed" ||
		facts.terminal.jobConclusion !== "failure" ||
		facts.terminal.providerStepStatus !== "completed" ||
		facts.terminal.providerStepConclusion !== "success" ||
		facts.terminal.jobRunId !== source.runId ||
		facts.terminal.jobRunAttempt !== source.runAttempt ||
		facts.terminal.jobHeadSha !== source.commit || !githubToken)
		return undefined;
	const repo = `https://api.github.com/repos/${MISSION_REPOSITORY}`;
	const submitted = await githubJson(`${repo}/git/commits/${requestCommit}`, githubToken, request);
	const parent = await githubJson(`${repo}/git/commits/${reviewedFirstParent}`, githubToken, request);
	const reviewedRun = await githubJson(`${repo}/actions/runs/${source.runId}`, githubToken, request);
	const reviewedJobs = await githubJson(`${repo}/actions/runs/${source.runId}/jobs?per_page=100`, githubToken, request);
	const exactJob = Array.isArray(reviewedJobs.jobs) && reviewedJobs.jobs.length === 1 &&
		record(reviewedJobs.jobs[0]) ? reviewedJobs.jobs[0] as Job : undefined;
	const exactSteps = exactJob ? providerSteps(exactJob) : [];
	if (submitted.sha !== requestCommit || parent.sha !== reviewedFirstParent ||
		submitted.message !== REUSABLE_RUN_REQUEST_MESSAGE ||
		reviewedRun.id !== Number(source.runId) ||
		reviewedRun.run_number !== source.runNumber ||
		reviewedRun.run_attempt !== source.runAttempt ||
		reviewedRun.workflow_id !== 374865232 ||
		reviewedRun.head_sha !== source.commit ||
		reviewedRun.event !== "push" || reviewedRun.head_branch !== REQUEST_BRANCH ||
		!record(reviewedRun.actor) || reviewedRun.actor.login !== "SakuyaInazaki" ||
		reviewedRun.status !== "completed" || reviewedRun.conclusion !== "failure" ||
		reviewedJobs.total_count !== 1 || !exactJob ||
		exactJob.id !== 112420914600 || exactJob.run_id !== Number(source.runId) ||
		exactJob.run_attempt !== source.runAttempt || exactJob.head_sha !== source.commit ||
		exactJob.name !== "private-campaign" || exactJob.status !== "completed" ||
		exactJob.conclusion !== "failure" || exactSteps.length !== 1 ||
		exactSteps[0].number !== 10 || exactSteps[0].name !== "Run private campaign" ||
		exactSteps[0].status !== "completed" || exactSteps[0].conclusion !== "success" ||
		!Array.isArray(submitted.parents) || ![1, 2].includes(submitted.parents.length) ||
		!record(submitted.parents[0]) || submitted.parents[0].sha !== reviewedFirstParent ||
		!record(submitted.tree) || !record(parent.tree) ||
		typeof submitted.tree.sha !== "string" ||
		!/^[0-9a-f]{40}$/.test(submitted.tree.sha) ||
		submitted.tree.sha !== parent.tree.sha) return undefined;
	const ci = await githubJson(`${repo}/actions/workflows/workflow-regression.yml/runs?head_sha=${reviewedFirstParent}&per_page=100`,
		githubToken, request);
	if (!Array.isArray(ci.workflow_runs) || !ci.workflow_runs.some(row =>
		record(row) && row.head_sha === reviewedFirstParent && row.head_branch === BRANCH &&
		row.event === "push" && row.run_attempt === 1 && row.conclusion === "success")) return undefined;
	const review = Object.freeze({ version: 1 as const,
		kind: "authenticated-opaque-gap-source-review" as const,
		source: Object.freeze({ ...source }),
		resultArchiveSha256: facts.resultArtifact.archiveSha256,
		priorCarryEnvelopeSha256: facts.priorCarryEnvelopeSha256 });
	authenticatedOpaqueGapSourceReviews.add(review);
	return review;
}
async function oneJob(runId: string, token: string, request: typeof fetch): Promise<Job> {
	const url = `https://api.github.com/repos/${MISSION_REPOSITORY}/actions/runs/${runId}/jobs?per_page=100`;
	const response = await githubJson(url, token, request);
	if (response.total_count !== 1 || !Array.isArray(response.jobs) ||
		response.jobs.length !== 1 || !record(response.jobs[0]))
		reject("workflow job disposition is incomplete");
	const job = response.jobs[0] as Job;
	if (job.name !== "private-campaign" || job.status !== "completed" ||
		(job.steps !== undefined && (!Array.isArray(job.steps) || job.steps.some(step => !record(step)))))
		reject("workflow job disposition is incomplete");
	return job;
}
function providerDisposition(job: Job): "skipped" | "executed" {
	const steps = providerSteps(job);
	if (steps.length > 1 || (job.conclusion === "skipped" &&
		steps.some(step => step.conclusion !== "skipped")))
		reject("workflow provider step disposition is ambiguous");
	if (job.conclusion === "skipped" ||
		(steps[0]?.status === "completed" && steps[0].conclusion === "skipped")) return "skipped";
	if (steps[0]?.status !== "completed") reject("intervening provider execution is unresolved");
	return "executed";
}

/** The old and current source revisions used different names for the same step. */
function providerSteps(job: Job): NonNullable<Job["steps"]> {
	return job.steps?.filter(step => step.name === "Run bounded private campaign" ||
		step.name === "Run private campaign") ?? [];
}
function verifiedTerminal(run: Run, job: Job, source: Source):
	AuthenticatedPriorCarryProof["terminal"] | undefined {
	const steps = providerSteps(job);
	const terminalConclusions = ["success", "failure", "neutral", "timed_out", "action_required", "stale"];
	if (!Number.isSafeInteger(job.id) || job.id! <= 0 || job.run_id !== Number(source.runId) ||
		job.run_attempt !== source.runAttempt || job.head_sha !== source.commit ||
		run.id !== Number(source.runId) || run.run_attempt !== source.runAttempt ||
		run.head_sha !== source.commit || !Number.isSafeInteger(run.workflow_id) ||
		run.workflow_id! <= 0 || run.status !== "completed" ||
		!terminalConclusions.includes(run.conclusion ?? "") || job.status !== "completed" ||
		job.name !== "private-campaign" || !terminalConclusions.includes(job.conclusion ?? "") ||
		steps.length !== 1 || steps[0].status !== "completed" ||
		![...terminalConclusions, "cancelled"].includes(steps[0].conclusion ?? "")) return undefined;
	return Object.freeze({ workflowId: String(run.workflow_id), runStatus: "completed",
		runConclusion: run.conclusion!, jobId: String(job.id), jobName: "private-campaign",
		jobStatus: "completed", jobConclusion: job.conclusion!, jobRunId: String(job.run_id),
		jobRunAttempt: job.run_attempt!, jobHeadSha: job.head_sha!,
		providerStepStatus: "completed", providerStepConclusion: steps[0].conclusion! });
}
function priorCarryProof(input: { source: Source; current: Source; run: Run; job: Job;
	artifactId: string; envelopeSha256: string; bundle?: PrivateContinuationBundle;
	resultArtifact?: AuthenticatedPriorCarryProof["resultArtifact"];
	ancestry: readonly (AncestorReceipt | AccountingAncestorReceipt)[];
	accounting?: { settledNano: number; unknownObservedNano: number; unpricedRequestCount: number };
	committedNano?: number; unknownHeldNano?: number }): AuthenticatedPriorCarryProof | undefined {
	const { source, current, run, job } = input;
	// Historical carry accounting remains readable without these extra API fields,
	// but their absence or mismatch must never mint restart authority.
	const terminal = verifiedTerminal(run, job, source);
	if (!terminal) return undefined;
	const proof: AuthenticatedPriorCarryProof = Object.freeze({
		version: input.accounting ? 2 : 1, kind: "authenticated-prior-mission-carry", repository: MISSION_REPOSITORY,
		source: Object.freeze({ ...source }), envelopeSha256: input.envelopeSha256,
		privateBundleSha256: input.bundle ? privateBundleDigest(input.bundle) : null,
		artifact: Object.freeze({ repository: MISSION_REPOSITORY, artifactId: input.artifactId,
			artifactName: CARRY_ARTIFACT_NAME, runId: source.runId }),
		...(input.resultArtifact ? { resultArtifact: input.resultArtifact } : {}),
		terminal,
		...(input.accounting ? {
			priorSettledCny: decimal(input.accounting.settledNano),
			priorUnknownObservedCny: decimal(input.accounting.unknownObservedNano),
			priorUnpricedRequestCount: input.accounting.unpricedRequestCount,
		} : { priorCommittedCny: decimal(input.committedNano!),
			priorUnknownHeldCny: decimal(input.unknownHeldNano!) }),
		admittedCurrent: Object.freeze({ ...current }),
	});
	authenticatedCarryProofs.add(proof);
	authenticatedCarryAncestors.set(proof, Object.freeze(input.ancestry.map(ancestor => Object.freeze({
		source: Object.freeze({ ...ancestor.source }), envelopeSha256: ancestor.envelopeDigest,
	}))));
	return proof;
}
async function artifactsForRun(runId: string, token: string, request: typeof fetch): Promise<Artifact[]> {
	const url = `https://api.github.com/repos/${MISSION_REPOSITORY}/actions/runs/${runId}/artifacts?per_page=100`;
	const response = await githubJson(url, token, request);
	if (!Array.isArray(response.artifacts) || response.artifacts.length > 100 ||
		!Number.isSafeInteger(response.total_count) || response.total_count !== response.artifacts.length)
		reject("workflow artifact list is incomplete");
	return response.artifacts.filter(record) as Artifact[];
}
async function oneArtifact(runId: string, token: string, request: typeof fetch,
	name: string, requiredId?: string, inspect?: (artifacts: Artifact[]) => void): Promise<string> {
	const artifacts = await artifactsForRun(runId, token, request);
	const found = artifacts.filter(value => {
		const a = value as Artifact;
		return record(value) && a.name === name && a.workflow_run?.id === Number(runId);
	}) as Artifact[];
	if (found.length !== 1 || !Number.isSafeInteger(found[0].id) || found[0].id! <= 0 ||
		found[0].expired !== false || (requiredId !== undefined && String(found[0].id) !== requiredId))
		reject("required private carry artifact is unavailable");
	inspect?.(artifacts);
	return String(found[0].id);
}
function resultArtifactIdentity(artifacts: Artifact[], source: Source): AuthenticatedPriorCarryProof["resultArtifact"] {
	const found = artifacts.filter(item => item.name === MISSION_ARTIFACT && item.workflow_run?.id === Number(source.runId));
	if (found.length !== 1 || !Number.isSafeInteger(found[0].id) || found[0].id! <= 0 ||
		found[0].expired !== false || found[0].workflow_run?.head_sha !== source.commit ||
		typeof found[0].digest !== "string" || !/^sha256:[0-9a-f]{64}$/.test(found[0].digest)) return undefined;
	return Object.freeze({ repository: MISSION_REPOSITORY, artifactId: String(found[0].id),
		artifactName: MISSION_ARTIFACT, runId: source.runId, archiveSha256: found[0].digest.slice(7),
		digestScope: "github-artifact-archive" });
}

export async function openLedgerContinuation(input: {
	seedEnvelopeB64: string | undefined; publicKeyFile: string; githubToken: string | undefined;
	current: CurrentMissionRun;
	loadCarryArtifact: (identity: { runId: string; artifactId: string }) => Promise<string>;
	/** Absent by default. A live auditor must bind the exact source and result archive. */
	reviewOpaqueGapSource?: (facts: { source: Readonly<Source>;
		terminal: AuthenticatedPriorCarryProof["terminal"];
		resultArtifact: NonNullable<AuthenticatedPriorCarryProof["resultArtifact"]>;
		priorCarryEnvelopeSha256: string }) =>
		Promise<AuthenticatedOpaqueGapSourceReview | undefined>;
	request?: typeof fetch; expectedSpkiSha256?: string;
	/** Compatibility verifier may require every intervening run to be nonbillable. */
	requireSeedOnly?: boolean;
}): Promise<LedgerContinuation> {
	const c = input.current;
	const authorizedDispatch = c.event === "workflow_dispatch" &&
		c.ref === `refs/heads/${BRANCH}` && c.manualAuthorized === "true";
	const authorizedControlRequest = c.event === "push" &&
		c.ref === `refs/heads/${REQUEST_BRANCH}` && c.manualAuthorized === "true" &&
		/^[0-9a-f]{40}$/.test(c.before ?? "");
	if (c.repository !== MISSION_REPOSITORY || c.actor !== "SakuyaInazaki" ||
		(!authorizedDispatch && !authorizedControlRequest) ||
		c.runAttempt !== "1" || !positiveId(c.runId) ||
		!/^[0-9a-f]{40}$/.test(c.sha ?? "") || !input.githubToken || input.githubToken.length > 4_000)
		reject("current Actions identity is not admitted for the mission ledger");
	const seed = await authenticateSignedMissionSeed({ envelopeB64: input.seedEnvelopeB64,
		publicKeyFile: input.publicKeyFile, expectedSpkiSha256: input.expectedSpkiSha256 });
	const key = seed.derivePrivateKey("mul-pis-ledger-continuation-v1");
	const request = input.request ?? fetch;
	const base = `https://api.github.com/repos/${MISSION_REPOSITORY}/actions`;
	const pages: Run[] = [];
	let foundSeed = false;
	let totalCount: number | undefined;
	for (let page = 1; ; page++) {
		if (!Number.isSafeInteger(page)) reject("workflow run pagination index is invalid");
		const response = await githubJson(`${base}/workflows/${WORKFLOW}/runs?per_page=100&page=${page}`,
			input.githubToken, request);
		if (!Array.isArray(response.workflow_runs) || response.workflow_runs.length > 100 ||
			!Number.isSafeInteger(response.total_count) ||
			Number(response.total_count) < response.workflow_runs.length ||
			response.workflow_runs.some(x => !record(x))) reject("workflow run listing is incomplete");
		const batch = response.workflow_runs as Run[];
		if (totalCount !== undefined && totalCount !== response.total_count)
			reject("workflow run listing changed during pagination");
		totalCount = Number(response.total_count);
		if (batch.length !== Math.min(100, Math.max(0, totalCount - pages.length)))
			reject("workflow run listing page is incomplete");
		for (const run of batch) sourceOf(run);
		pages.push(...batch);
		if (pages.some((run, index) => index > 0 && run.run_number! >= pages[index - 1].run_number!))
			reject("workflow run listing is not strictly ordered");
		if (batch.some(x => String(x.id) === seed.payload.previous.runId)) { foundSeed = true; break; }
		if (batch.length < 100) break;
	}
	if (!foundSeed) reject("signed seed run is outside verified workflow history");
	if (new Set(pages.map(run => run.id)).size !== pages.length ||
		new Set(pages.map(run => run.run_number)).size !== pages.length)
		reject("workflow run listing is duplicated or changed during pagination");
	const current = pages.find(x => String(x.id) === c.runId);
	const anchor = pages.find(x => String(x.id) === seed.payload.previous.runId);
	if (!current || !anchor || !Number.isSafeInteger(current.run_number) ||
		!Number.isSafeInteger(anchor.run_number) || anchor.run_number! >= current.run_number! ||
		current.run_attempt !== 1 || current.status !== "in_progress" ||
		current.event !== c.event || current.head_sha !== c.sha || current.actor?.login !== c.actor ||
		current.head_branch !== (authorizedControlRequest ? REQUEST_BRANCH : BRANCH) ||
		(authorizedControlRequest && current.head_commit?.message !== REUSABLE_RUN_REQUEST_MESSAGE) ||
		!Number.isSafeInteger(current.workflow_id) || current.workflow_id! <= 0 ||
		pages.some(run => run.workflow_id !== current.workflow_id) ||
		anchor.status !== "completed" || anchor.run_attempt !== seed.payload.previous.runAttempt ||
		anchor.head_branch !== BRANCH ||
		(seed.payload.rootReviewedAnchor !== undefined && anchor.head_sha !== seed.payload.rootReviewedAnchor.commit))
		reject("workflow identity or signed seed freshness is invalid");
	const ordered = pages.filter(x => Number.isSafeInteger(x.run_number) &&
		x.run_number! >= anchor.run_number! && x.run_number! <= current.run_number!)
		.sort((a, b) => a.run_number! - b.run_number!);
	if (ordered.length !== current.run_number! - anchor.run_number! + 1 ||
		new Set(ordered.map(x => x.run_number)).size !== ordered.length ||
		ordered[0].id !== anchor.id || ordered.at(-1)?.id !== current.id)
		reject("workflow run order cannot be proved exclusive");
	if (authorizedControlRequest && pages.some(run => run.id !== current.id &&
		run.event === "push" && run.head_sha === current.head_sha))
		reject("run request commit was already used by an earlier workflow run");
	if (authorizedControlRequest) {
		const repo = `https://api.github.com/repos/${MISSION_REPOSITORY}`;
		const featureRef = await githubJson(`${repo}/git/ref/heads/${BRANCH}`, input.githubToken, request);
		const source = record(featureRef.object) ? featureRef.object.sha : undefined;
		if (typeof source !== "string" || !/^[0-9a-f]{40}$/.test(source))
			reject("run request source ref is unavailable");
		const submitted = await githubJson(`${repo}/git/commits/${current.head_sha}`, input.githubToken, request);
		const sourceCommit = await githubJson(`${repo}/git/commits/${source}`, input.githubToken, request);
		const parents = submitted.parents;
		if (!Array.isArray(parents) || ![1, 2].includes(parents.length) ||
			parents.some(parent => !record(parent) || typeof parent.sha !== "string") ||
			parents[0].sha !== source ||
			(parents.length === 1 ? c.before !== source : parents[1].sha !== c.before) ||
			!record(submitted.tree) || !record(sourceCommit.tree) ||
			typeof submitted.tree.sha !== "string" || submitted.tree.sha !== sourceCommit.tree.sha)
			reject("run request is not a fast-forward empty commit of the accepted source tree");
		const ci = await githubJson(`${base}/workflows/workflow-regression.yml/runs?head_sha=${source}&per_page=100`,
			input.githubToken, request);
		if (!Array.isArray(ci.workflow_runs) || !ci.workflow_runs.some(row =>
			record(row) && row.head_sha === source && row.head_branch === BRANCH &&
			row.event === "push" && row.run_attempt === 1 && row.conclusion === "success"))
			reject("run request source lacks a successful offline regression run");
	}
	// Workflow concurrency prevents simultaneous execution, but it does not promise
	// run-number order. A newer completed paid run cannot be silently omitted just
	// because this older queued run finally acquired the concurrency slot.
	for (const successor of pages.filter(run => run.run_number! > current.run_number!)) {
		if (successor.run_attempt !== 1) reject("newer workflow run disposition is unresolved");
		if (successor.status === "queued" || successor.status === "pending") continue;
		if (successor.status !== "completed" || providerDisposition(
			await oneJob(String(successor.id), input.githubToken, request)) !== "skipped")
			reject("newer workflow run may have executed a billable job");
	}
	// A signed root-reviewed attestation outlives the old ciphertext's retention.
	// Legacy seeds have no such attestation and must still prove availability.
	if (!seed.payload.rootReviewedAnchor)
		await oneArtifact(seed.payload.previous.runId, input.githubToken, request,
		seed.payload.previous.artifactName, seed.payload.previous.artifactId);
	let committedNano = n(seed.payload.priorCommittedCny);
	let unknownHeldNano = 0;
	let settledNano = 0;
	let unknownObservedNano = 0;
	let unpricedRequestCount = 0;
	let historical = { committedNano, unknownHeldNano, legacyParentDigest: seed.seedDigest };
	let parentDigest = seed.seedDigest;
	let priorPrivateBundle: PrivateContinuationBundle | undefined = seed.bootstrapPrivateBundle;
	let priorBootstrapBinding: BootstrapBinding | undefined = seed.bootstrapBinding;
	const executedSources: Source[] = [];
	const executedMetadata = new Map<string, { run: Run; job: Job }>();
	for (const run of ordered.slice(1, -1)) {
		const source = sourceOf(run);
		if (run.workflow_id !== current.workflow_id || run.run_attempt !== 1 || run.status !== "completed")
			reject("intervening workflow run is not settled");
		const job = await oneJob(source.runId, input.githubToken, request);
		if (providerDisposition(job) === "skipped") continue;
		if (input.requireSeedOnly) reject("intervening workflow may have executed a billable job");
		if (run.conclusion === "cancelled" || job.conclusion === "cancelled")
			reject("intervening workflow run is not settled");
		if (![BRANCH, REQUEST_BRANCH].includes(run.head_branch ?? "") || run.actor?.login !== c.actor ||
			(run.event !== "push" && run.event !== "workflow_dispatch"))
			reject("intervening provider execution is unresolved");
		executedSources.push(source);
		executedMetadata.set(source.runId, { run, job });
	}
	const loadedArtifacts = new Map<string, string>();
	const resultArtifacts = new Map<string, AuthenticatedPriorCarryProof["resultArtifact"]>();
	const load = async (source: Source): Promise<string> => {
		const artifactId = loadedArtifacts.get(source.runId) ?? await oneArtifact(source.runId,
			input.githubToken!, request, CARRY_ARTIFACT_NAME, undefined,
			artifacts => resultArtifacts.set(source.runId, resultArtifactIdentity(artifacts, source)));
		loadedArtifacts.set(source.runId, artifactId);
		try { return await input.loadCarryArtifact({ runId: source.runId, artifactId }); }
		catch { return reject("private carry artifact could not be read"); }
	};
	let sourcesWithCarry = executedSources;
	let newlyOpaqueGap: Omit<OpaqueExecutedRunGap, "priorCarryEnvelopeSha256"> | undefined;
	if (executedSources.length) {
		const latest = executedSources.at(-1)!;
		const artifacts = await artifactsForRun(latest.runId, input.githubToken, request);
		const carries = artifacts.filter(item => item.name === CARRY_ARTIFACT_NAME);
		if (carries.length === 1 && carries[0].workflow_run?.id === Number(latest.runId) &&
			carries[0].expired === false && Number.isSafeInteger(carries[0].id) && carries[0].id! > 0) {
			loadedArtifacts.set(latest.runId, String(carries[0].id));
			resultArtifacts.set(latest.runId, resultArtifactIdentity(artifacts, latest));
		} else if (carries.length === 0) {
			if (executedSources.length < 2)
				reject("required private carry artifact is unavailable without an earlier authenticated carry");
			const results = artifacts.filter(item => item.name === MISSION_ARTIFACT);
			const resultArtifact = results.length === 1 ? resultArtifactIdentity(artifacts, latest) : undefined;
			const metadata = executedMetadata.get(latest.runId);
			const terminal = metadata && verifiedTerminal(metadata.run, metadata.job, latest);
			if (!resultArtifact || !terminal)
				reject("missing carry run lacks an exact terminal encrypted result artifact");
			newlyOpaqueGap = Object.freeze({ version: 1, kind: "opaque-executed-run-gap",
				source: Object.freeze({ ...latest }), carryArtifact: "absent",
				accounting: "unquantified", effects: "quarantined-source-reviewed",
				terminal, resultArtifact });
			sourcesWithCarry = executedSources.slice(0, -1);
		} else reject("required private carry artifact is unavailable or ambiguous");
	}
	let legacyAncestry: AncestorReceipt[] = [];
	let accountingAncestry: AccountingAncestorReceipt[] = [];
	let ancestry: (AncestorReceipt | AccountingAncestorReceipt)[] = [];
	let carryForwardOrigin: AuthenticatedCarryForwardOrigin | undefined;
	let hostEffectEvidence: AuthenticatedHostEffectEvidence | undefined;
	let oneTimeLegacyV3Review: AuthenticatedLegacyV3RunReview | undefined;
	let reviewedEffectAncestry: ReviewedEffectAncestorReceipt[] = [];
	let priorTransportDiagnosticCensus: HostTransportDiagnosticCensusV1 | undefined;
	let opaqueExecutedRuns: OpaqueExecutedRunGap[] = [];
	let currentEffectReviewPending = false;
	let pendingEffectAncestry: Source[] = [];
	if (sourcesWithCarry.length) {
		const latest = sourcesWithCarry.at(-1)!;
		const latestEnvelope = await load(latest);
		const latestVersion = checkpointVersion(latestEnvelope);
		if (latestVersion === 3) {
			const opened = readCheckpoint(latestEnvelope, key, seed.seedDigest, latest);
			if (opened.checkpoint.version !== 3) reject("accounting-only carry version is invalid");
			validateAncestryV3(opened.checkpoint, sourcesWithCarry, seed.seedDigest,
				n(seed.payload.priorCommittedCny), seed.bootstrapBinding);
			const cp = opened.checkpoint;
			priorTransportDiagnosticCensus = transportDiagnosticCensus(cp);
			opaqueExecutedRuns = [...(cp.opaqueExecutedRuns ?? [])];
			currentEffectReviewPending = cp.currentEffectReview === "pending";
			pendingEffectAncestry = [...(cp.pendingEffectAncestry ?? [])];
			const historicalOrigin = cp.legacyAncestry.at(-1);
			const allPriorEffectsReviewed = cp.ancestry.filter(row => !hasNoV3ProviderActivity(row))
				.every(row => cp.reviewedEffectAncestry?.some(entry =>
					entry.envelopeSha256 === row.envelopeDigest) ?? false);
			if (historicalOrigin && allPriorEffectsReviewed &&
				cp.historical.legacyParentDigest === historicalOrigin.envelopeDigest) {
				const candidate = Object.freeze({ source: Object.freeze({ ...historicalOrigin.source }),
					envelopeSha256: historicalOrigin.envelopeDigest,
					historicalCommittedNano: cp.historical.committedNano,
					historicalUnknownHeldNano: cp.historical.unknownHeldNano });
				const bundleSha256 = cp.privateBundle ? privateBundleDigest(cp.privateBundle) : undefined;
				const immediateZero = cp.ancestry.at(-1);
				if (cp.ancestry.every(hasNoV3ProviderActivity) &&
					immediateZero && cp.parentDigest === immediateZero.envelopeDigest &&
					cp.source.runId === ONE_TIME_LEGACY_V3_RUN &&
					cp.source.runAttempt === 1 && cp.source.commit === ONE_TIME_LEGACY_V3_REQUEST &&
					executedMetadata.get(cp.source.runId)?.run.event === "push" &&
					executedMetadata.get(cp.source.runId)?.run.head_branch === REQUEST_BRANCH &&
					cp.privateBundle && bundleSha256 && cp.historical.unknownHeldNano > 0) {
					if (!await reviewedLegacyV3SourceTree(input.githubToken!, request))
						reject("one-time reviewed request commit is not the first-parent source tree");
					oneTimeLegacyV3Review = Object.freeze({ origin: candidate,
						immediateZeroActivitySource: Object.freeze({
							source: Object.freeze({ ...immediateZero.source }),
							envelopeSha256: immediateZero.envelopeDigest }),
						reviewedSourceCommit: ONE_TIME_LEGACY_V3_SOURCE,
						requestAudit: cp.requestAudit, settledAddedNano: cp.settledAddedNano,
						unknownObservedAddedNano: cp.unknownObservedAddedNano,
						unpricedAddedCount: cp.unpricedAddedCount });
				}
				if (hasNoV3ProviderActivity(cp) && cp.carryForwardOrigin !== undefined) {
					if (!bundleSha256 || cp.carryForwardOrigin.privateBundleSha256 !== bundleSha256 ||
						JSON.stringify(cp.carryForwardOrigin.source) !== JSON.stringify(candidate.source) ||
						cp.carryForwardOrigin.envelopeSha256 !== candidate.envelopeSha256 ||
						cp.carryForwardOrigin.historicalCommittedNano !== candidate.historicalCommittedNano ||
						cp.carryForwardOrigin.historicalUnknownHeldNano !== candidate.historicalUnknownHeldNano)
						reject("authenticated carry-forward origin is inconsistent");
					if (cp.reviewedEffectAncestry?.at(-1)?.abandonedWithoutGoal) {
						const noGoalReceipt = hostEffectReceipt(cp);
						if (!noGoalReceipt || noGoalReceipt.goals.length !== 0 ||
							noGoalReceipt.sessions.some(session => session.kind !== "none" &&
								session.kind !== "read-dir") || noGoalReceipt.requestIds.length !== 0)
							reject("abandoned reviewed restart lacks an empty host effect census");
						hostEffectEvidence = Object.freeze({ origin: candidate, receipt: noGoalReceipt,
							requestAudit: cp.requestAudit,
							reviewedEffectAncestry: Object.freeze([...(cp.reviewedEffectAncestry ?? [])]) });
					} else carryForwardOrigin = candidate;
				} else if (hasNoV3ProviderActivity(cp) && bundleSha256) {
					// Old v3 wrappers did not record a bundle digest. Authenticate the
					// legacy ciphertext itself before claiming its files were passed through.
					let legacyEnvelope: string | undefined;
					try {
						const id = await oneArtifact(historicalOrigin.source.runId, input.githubToken!, request,
							CARRY_ARTIFACT_NAME);
						legacyEnvelope = await input.loadCarryArtifact({ runId: historicalOrigin.source.runId,
							artifactId: id });
					} catch { /* Historical artifact unavailable: no pass-through authority. */ }
					if (legacyEnvelope) {
						let old: ReturnType<typeof readCheckpoint> | undefined;
						try { old = readCheckpoint(legacyEnvelope, key, seed.seedDigest, historicalOrigin.source); }
						catch { /* No authority from an unreadable legacy artifact. */ }
						if (old?.digest === candidate.envelopeSha256 && old.checkpoint.version === 2 &&
							old.checkpoint.committedNano === candidate.historicalCommittedNano &&
							old.checkpoint.unknownHeldNano === candidate.historicalUnknownHeldNano &&
							old.checkpoint.privateBundle && cp.privateBundle &&
							canonicalPrivateBundle(old.checkpoint.privateBundle) === canonicalPrivateBundle(cp.privateBundle))
							carryForwardOrigin = candidate;
					}
				} else if (cp.carryForwardOrigin !== undefined) {
					const receipt = hostEffectReceipt(cp);
					if (receipt && bundleSha256 && cp.carryForwardOrigin.privateBundleSha256 === bundleSha256 &&
						JSON.stringify(cp.carryForwardOrigin.source) === JSON.stringify(candidate.source) &&
						cp.carryForwardOrigin.envelopeSha256 === candidate.envelopeSha256 &&
						cp.carryForwardOrigin.historicalCommittedNano === candidate.historicalCommittedNano &&
						cp.carryForwardOrigin.historicalUnknownHeldNano === candidate.historicalUnknownHeldNano &&
						(receipt.goals.length > 0 || assessmentOnlyNoGoal(cp, receipt)))
						hostEffectEvidence = Object.freeze({ origin: candidate, receipt,
							requestAudit: cp.requestAudit,
							reviewedEffectAncestry: Object.freeze([...(cp.reviewedEffectAncestry ?? [])]) });
				} else if (cp.requestAudit.requests.some(row => row.responseReceived === false) &&
					cp.reviewedEffectAncestry?.length && unchangedReviewedSelection(cp,
						seed.bootstrapPrivateBundle?.["original-objective.json"])) {
					// Compatibility for an authenticated terminal carry sealed before
					// unknown transport was separated from actor-side effect review.
					const receipt = hostEffectReceipt(cp);
					if (receipt && bundleSha256)
						hostEffectEvidence = Object.freeze({ origin: candidate, receipt,
							requestAudit: cp.requestAudit,
							reviewedEffectAncestry: Object.freeze([...(cp.reviewedEffectAncestry ?? [])]) });
				}
			}
			if (cp.carryForwardOrigin !== undefined && !carryForwardOrigin && !hostEffectEvidence)
				reject("authenticated carry-forward origin lacks a complete host-effect receipt");
			legacyAncestry = cp.legacyAncestry;
			reviewedEffectAncestry = [...(cp.reviewedEffectAncestry ?? [])];
			accountingAncestry = [...cp.ancestry, accountingAncestorReceipt(cp, opened.digest)];
			ancestry = [...legacyAncestry, ...accountingAncestry];
			historical = cp.historical;
			committedNano = historical.committedNano; unknownHeldNano = historical.unknownHeldNano;
			settledNano = cp.settledNano; unknownObservedNano = cp.unknownObservedNano;
			unpricedRequestCount = cp.unpricedRequestCount;
			priorPrivateBundle = cp.privateBundle; priorBootstrapBinding = cp.bootstrapBinding;
			parentDigest = opened.digest;
		} else if (latestVersion === 2) {
			const opened = readCheckpoint(latestEnvelope, key, seed.seedDigest, latest);
			if (opened.checkpoint.version !== 2) reject("legacy carry version is invalid");
			validateAncestry(opened.checkpoint, sourcesWithCarry, seed.seedDigest, committedNano, priorBootstrapBinding);
			const cp = opened.checkpoint;
			legacyAncestry = [...cp.ancestry!, ancestorReceipt(cp, opened.digest)];
			ancestry = [...legacyAncestry];
			committedNano = cp.committedNano; unknownHeldNano = cp.unknownHeldNano;
			historical = { committedNano, unknownHeldNano, legacyParentDigest: opened.digest };
			priorPrivateBundle = cp.privateBundle; priorBootstrapBinding = cp.bootstrapBinding;
			parentDigest = opened.digest;
		} else {
			// Legacy carries have no compacted ancestry. Every original ciphertext
			// must remain present until a verified v2 checkpoint carries its receipt.
			for (const [index, source] of sourcesWithCarry.entries()) {
				const envelope = index === sourcesWithCarry.length - 1 ? latestEnvelope : await load(source);
				const opened = readCheckpoint(envelope, key, seed.seedDigest, source, parentDigest);
				const cp = opened.checkpoint;
				if (cp.version === 3) reject("legacy activation cannot inherit an accounting-only carry");
				if (cp.version === 2) validateAncestry(cp, sourcesWithCarry.slice(0, index + 1),
					seed.seedDigest, n(seed.payload.priorCommittedCny), seed.bootstrapBinding);
				validateAccounting(cp, source, parentDigest, committedNano, unknownHeldNano, priorBootstrapBinding);
				legacyAncestry.push(ancestorReceipt(cp, opened.digest));
				ancestry.push(ancestorReceipt(cp, opened.digest));
				committedNano = cp.committedNano; unknownHeldNano = cp.unknownHeldNano;
				priorPrivateBundle = cp.privateBundle; priorBootstrapBinding = cp.bootstrapBinding;
				parentDigest = opened.digest;
			}
			historical = { committedNano, unknownHeldNano, legacyParentDigest: parentDigest };
		}
	}
	if (newlyOpaqueGap) {
		if (!input.reviewOpaqueGapSource || !bindsOpaqueGapSourceReview(
			await input.reviewOpaqueGapSource({ source: newlyOpaqueGap.source,
				terminal: newlyOpaqueGap.terminal, resultArtifact: newlyOpaqueGap.resultArtifact,
				priorCarryEnvelopeSha256: parentDigest }), newlyOpaqueGap.source,
			newlyOpaqueGap.resultArtifact, parentDigest))
			reject("opaque executed run gap lacks independent exact-source authority");
		opaqueExecutedRuns.push(Object.freeze({ ...newlyOpaqueGap,
			priorCarryEnvelopeSha256: parentDigest,
			effects: "quarantined-source-reviewed" as const }));
	}
	const currentSource = sourceOf(current);
	const latestSource = sourcesWithCarry.at(-1);
	const proof = latestSource && opaqueExecutedRuns.every(gap =>
		gap.effects === "quarantined-source-reviewed") && !currentEffectReviewPending &&
		!pendingEffectAncestry.length ? priorCarryProof({ source: latestSource, current: currentSource,
		...executedMetadata.get(latestSource.runId)!, artifactId: loadedArtifacts.get(latestSource.runId)!,
		resultArtifact: resultArtifacts.get(latestSource.runId),
		ancestry, envelopeSha256: parentDigest, bundle: priorPrivateBundle,
		...(accountingAncestry.length ?
			{ accounting: { settledNano, unknownObservedNano, unpricedRequestCount } } :
			{ committedNano, unknownHeldNano }) }) : undefined;
	if (proof && carryForwardOrigin && priorPrivateBundle && proof.resultArtifact)
		authenticatedCarryForwardOrigins.set(proof, carryForwardOrigin);
	if (proof && hostEffectEvidence && priorPrivateBundle && proof.resultArtifact)
		authenticatedHostEffects.set(proof, hostEffectEvidence);
	if (proof && oneTimeLegacyV3Review && priorPrivateBundle && proof.resultArtifact)
		authenticatedLegacyV3RunReviews.set(proof, oneTimeLegacyV3Review);
	if (proof && opaqueExecutedRuns.length && priorPrivateBundle && proof.resultArtifact)
		authenticatedReviewedOpaqueGaps.set(proof, Object.freeze([...opaqueExecutedRuns]));
	if (priorPrivateBundle) Object.freeze(priorPrivateBundle);
	if (priorBootstrapBinding) Object.freeze(priorBootstrapBinding);
	let sealed = false;
	let diagnosticPrepared = false;
	let preparedDiagnosticText: string | undefined;
	let preparedDiagnosticAuditSha256: string | undefined;
	const validateCurrentDiagnostic = (cp: AccountingCheckpoint): void => {
		const latest = transportDiagnosticCensus(cp);
		const inherited = priorTransportDiagnosticCensus?.entries ?? [];
		const entries = latest?.entries ?? [];
		if (entries.length < inherited.length || entries.length > inherited.length + 1 ||
			JSON.stringify(entries.slice(0, inherited.length)) !== JSON.stringify(inherited) ||
			(entries.length === inherited.length + 1 &&
				entries.at(-1)?.source.runId !== currentSource.runId))
			reject("transport diagnostic census did not preserve its authenticated prefix");
		if (diagnosticPrepared && (cp.privateBundle?.["transport-diagnostics.json"] !== preparedDiagnosticText ||
			preparedDiagnosticAuditSha256 !== digest(JSON.stringify(cp.requestAudit))))
			reject("transport diagnostic census differs from the final host audit");
	};
	const result: LedgerContinuation = { mode: "accounting-only",
		...(priorTransportDiagnosticCensus ? { priorTransportDiagnosticCensus } : {}),
		opaqueExecutedRuns: Object.freeze([...opaqueExecutedRuns]),
		priorSettledCny: decimal(settledNano), priorUnknownObservedCny: decimal(unknownObservedNano),
		priorUnpricedRequestCount: unpricedRequestCount,
		historicalCommittedCny: decimal(historical.committedNano),
		historicalUnknownHeldCny: decimal(historical.unknownHeldNano),
		priorCommittedCny: decimal(historical.committedNano),
		priorUnknownHeldCny: decimal(historical.unknownHeldNano),
		...(proof ? { priorCarryProof: proof } : {}),
		...(priorPrivateBundle ? { priorPrivateBundle } : {}),
		...(priorBootstrapBinding ? { priorBootstrapBinding } : {}),
		appendTransportDiagnosticCensus: (audit, diagnostics) => {
			if (sealed) reject("transport diagnostic census cannot follow carry sealing");
			if (!validAccountingAudit(audit, n(audit.settledCny),
				n(audit.unknownObservedCny), audit.unpricedRequestCount))
				reject("transport diagnostic census has an invalid current request audit");
			const priorRaw = priorPrivateBundle?.["transport-diagnostics.json"];
			if (priorRaw && !priorTransportDiagnosticCensus)
				reject("prior transport diagnostic census lacks v3 ancestry authentication");
			const unknownIds = transportUnknownIds(audit);
			if (!unknownIds.length) {
				diagnosticPrepared = true; preparedDiagnosticText = priorRaw;
				preparedDiagnosticAuditSha256 = digest(JSON.stringify(audit));
				return priorRaw;
			}
			const observations = new Map<string, TransportFailureDiagnostic>();
			for (const diagnostic of diagnostics) {
				if (!diagnostic.requestId || !unknownIds.includes(diagnostic.requestId)) continue;
				if (observations.has(diagnostic.requestId))
					reject("transport diagnostic census repeats one unknown request");
				observations.set(diagnostic.requestId, diagnostic);
			}
			const rows = unknownIds.map(requestId => {
				const observed = observations.get(requestId);
				return observed ? { requestId, availability: "observed" as const,
					phase: observed.phase, httpStatus: observed.httpStatus,
					responseStarted: observed.responseStarted, bytesRead: observed.bytesRead,
					abortSource: observed.abortSource, providerErrorCode: observed.providerErrorCode,
					providerErrorType: observed.providerErrorType, errorCodes: [...observed.errorCodes] } :
					{ requestId, availability: "unavailable" as const };
			});
			const source = { runId: currentSource.runId, runAttempt: currentSource.runAttempt,
				commit: currentSource.commit };
			const priorEntries = priorTransportDiagnosticCensus?.entries ?? [];
			const next = JSON.stringify({ version: 1, kind: "host-transport-diagnostic-census",
				entries: [...priorEntries, { source, priorEnvelopeSha256: parentDigest, rows }] });
			transportDiagnosticCensus({ privateBundle: { "transport-diagnostics.json": next },
				ancestry: accountingAncestry, source: currentSource, parentDigest, requestAudit: audit });
			// This census is optional metadata. If appending it would cross the
			// physical private-bundle bound, keep the authenticated older census;
			// the current RSA result still reports the transport observation.
			const retained = retainedTransportDiagnosticWithinBundle(priorPrivateBundle, next);
			diagnosticPrepared = true; preparedDiagnosticText = retained;
			preparedDiagnosticAuditSha256 = digest(JSON.stringify(audit));
			return retained;
		},
		claimOneUse: async carryDigest => {
			if (opaqueExecutedRuns.some(gap => gap.effects !== "quarantined-source-reviewed") ||
				currentEffectReviewPending || pendingEffectAncestry.length)
				reject("opaque or unreviewed execution requires independent effect authority");
			if (!proof || !isAuthenticatedPriorCarryProof(proof) || carryDigest !== proof.envelopeSha256)
				reject("restart claim requires the exact authenticated prior carry");
			if (sealed) reject("restart claim cannot follow current carry sealing");
			const admissionKey = JSON.stringify([MISSION_REPOSITORY, currentSource, carryDigest]);
			if (claimedActionsAdmissions.has(admissionKey)) reject("current Actions restart admission was already consumed");
			claimedActionsAdmissions.add(admissionKey);
			try {
				const observed = await githubJson(`${base}/runs/${currentSource.runId}`, input.githubToken!, request) as Run;
				if (JSON.stringify(sourceOf(observed)) !== JSON.stringify(currentSource) ||
					observed.status !== "in_progress" || (observed.conclusion !== undefined && observed.conclusion !== null) ||
					observed.workflow_id !== current.workflow_id ||
					observed.actor?.login !== c.actor || observed.event !== c.event ||
					observed.head_branch !== current.head_branch)
					reject("current Actions restart admission is no longer active");
				const disposition = await githubJson(`${base}/runs/${currentSource.runId}/jobs?per_page=100`, input.githubToken!, request);
				if (disposition.total_count !== 1 || !Array.isArray(disposition.jobs) ||
					disposition.jobs.length !== 1 || !record(disposition.jobs[0]))
					reject("current Actions restart job identity is incomplete");
				const job = disposition.jobs[0] as Job;
				const steps = Array.isArray(job.steps) ? providerSteps(job) : [];
				if (!Number.isSafeInteger(job.id) || job.id! <= 0 || job.run_id !== Number(currentSource.runId) ||
					job.run_attempt !== currentSource.runAttempt || job.head_sha !== currentSource.commit ||
					job.name !== "private-campaign" || job.status !== "in_progress" ||
					(job.conclusion !== undefined && job.conclusion !== null) ||
					!Array.isArray(job.steps) || job.steps.some(step => !record(step)) ||
					job.steps.filter(step => step.status === "in_progress").length !== 1 ||
					steps.length !== 1 || steps[0].status !== "in_progress" ||
					(steps[0].conclusion !== undefined && steps[0].conclusion !== null))
					reject("current Actions restart job identity is incomplete");
				if (sealed) reject("restart claim cannot follow current carry sealing");
				return Object.freeze({ claimId: digest(JSON.stringify([admissionKey, job.id])),
					currentRunId: currentSource.runId, currentRunAttempt: currentSource.runAttempt,
					currentCommit: currentSource.commit, currentJobId: String(job.id), priorEnvelopeSha256: carryDigest });
			} catch (error) {
				// These checks are read-only; a failed observation never minted a claim.
				claimedActionsAdmissions.delete(admissionKey);
				throw error;
			}
		},
		sealCurrent: amounts => {
			if (opaqueExecutedRuns.some(gap => gap.effects !== "quarantined-source-reviewed") ||
				currentEffectReviewPending || pendingEffectAncestry.length)
				reject("ordinary carry cannot bypass opaque or pending effects");
			if (sealed) reject("current carry was already sealed");
			const privateBundle = amounts.privateBundle ?? priorPrivateBundle;
			const bootstrapBinding = amounts.bootstrapBinding ?? priorBootstrapBinding;
			if ((privateBundle !== undefined && !validBundle(privateBundle)) ||
				(bootstrapBinding !== undefined && !validBinding(bootstrapBinding)) ||
				(priorBootstrapBinding !== undefined && !sameBinding(bootstrapBinding, priorBootstrapBinding)) ||
				(privateBundle === undefined) !== (bootstrapBinding === undefined))
				reject("current carry accounting exceeds mission bounds");
				const settledAddedNano = n(amounts.settledCny);
				const unknownObservedAddedNano = n(amounts.unknownObservedCny);
				const nextSettledNano = settledNano + settledAddedNano;
				const nextUnknownNano = unknownObservedNano + unknownObservedAddedNano;
				const nextUnpricedCount = unpricedRequestCount + amounts.unpricedRequestCount;
				if (![nextSettledNano, nextUnknownNano, nextUnpricedCount].every(Number.isSafeInteger) ||
					!validAccountingAudit(amounts.requestAudit, settledAddedNano,
						unknownObservedAddedNano, amounts.unpricedRequestCount))
					reject("current accounting-only carry is invalid");
				const cp: AccountingCheckpoint = { version: 3, ancestry: accountingAncestry,
					legacyAncestry, historical,
					...(opaqueExecutedRuns.length ? { opaqueExecutedRuns: [...opaqueExecutedRuns] } : {}),
					kind: "mul-pis-private-ledger-continuation", missionId: MISSION_ID,
					repository: MISSION_REPOSITORY, seedDigest: seed.seedDigest, parentDigest,
					source: currentSource, settledNano: nextSettledNano,
					unknownObservedNano: nextUnknownNano, unpricedRequestCount: nextUnpricedCount,
					settledAddedNano, unknownObservedAddedNano, unpricedAddedCount: amounts.unpricedRequestCount,
					requestAudit: amounts.requestAudit,
					...(privateBundle ? { privateBundle, bootstrapBinding } : {}) };
				if (reviewedEffectAncestry.length)
					cp.reviewedEffectAncestry = [...reviewedEffectAncestry];
				const priorNonzero = accountingAncestry.filter(row => !hasNoV3ProviderActivity(row));
				const reviewedOrigin = hostEffectEvidence?.origin ?? oneTimeLegacyV3Review?.origin ??
					carryForwardOrigin;
				const currentEffectReceipt = hostEffectReceipt(cp, priorPrivateBundle);
				const selectedKeys = ["candidate.cpp", "verification.json", "workflow-archive.json",
					"experiment-plan.json", "m04-adopted-knowledge.json"] as const;
				const sameSelection = privateBundle && priorPrivateBundle &&
					selectedKeys.every(name => privateBundle[name] === priorPrivateBundle[name]);
				const emptyNoGoal = hasNoV3ProviderActivity(cp) && currentEffectReceipt &&
					currentEffectReceipt.goals.length === 0 &&
					currentEffectReceipt.sessions.every(session => session.kind === "none" ||
						session.kind === "read-dir") &&
					currentEffectReceipt.requestIds.length === 0 && sameSelection &&
					privateBundle?.["objective-checkpoint.json"] === priorPrivateBundle?.["objective-checkpoint.json"] &&
					privateBundle?.["research-history.json"] === priorPrivateBundle?.["research-history.json"];
				const readOnlyAssessmentNoGoal = sameSelection &&
					privateBundle?.["research-history.json"] === priorPrivateBundle?.["research-history.json"] &&
					assessmentOnlyNoGoal(cp, currentEffectReceipt, priorPrivateBundle);
				const abandonedNoGoal = Boolean(emptyNoGoal || readOnlyAssessmentNoGoal);
				const latestPrior = accountingAncestry.at(-1);
				const earlierNonzeroReviewed = accountingAncestry.slice(0, -1)
					.filter(row => !hasNoV3ProviderActivity(row)).every(row =>
						reviewedEffectAncestry.some(entry => entry.envelopeSha256 === row.envelopeDigest));
				if (latestPrior && earlierNonzeroReviewed &&
					!reviewedEffectAncestry.some(entry => entry.envelopeSha256 === latestPrior.envelopeDigest) &&
					reviewedOrigin?.envelopeSha256 === historical.legacyParentDigest) {
					const added = newlyReviewedPriorEffect(proof, currentSource,
						latestPrior, privateBundle, reviewedOrigin, abandonedNoGoal);
					if (added) cp.reviewedEffectAncestry = [...reviewedEffectAncestry, added];
				}
				if (!reviewedEffectPrefixValid(cp))
					reject("current reviewed effect ancestry is not bound to restart claims");
				validateCurrentDiagnostic(cp);
				const allPriorEffectsReviewed = priorNonzero.every(row =>
					cp.reviewedEffectAncestry?.some(entry => entry.envelopeSha256 === row.envelopeDigest) ?? false);
				const originForCurrent = carryForwardOrigin ?? reviewedOrigin;
				if (originForCurrent && privateBundle && priorPrivateBundle && allPriorEffectsReviewed) {
					const zeroPassThrough = privateBundleDigest(privateBundle) === privateBundleDigest(priorPrivateBundle) &&
						hasNoV3ProviderActivity(cp);
					// Historical obligations never change. Restart links only append after
					// a reviewed prior effect; new selection archives the old tuple.
					const addedReviewCount = (cp.reviewedEffectAncestry?.length ?? 0) - reviewedEffectAncestry.length;
					const abandonedAdded = addedReviewCount === 1 &&
						cp.reviewedEffectAncestry?.at(-1)?.abandonedWithoutGoal === true;
					const historicalPreserved = privateBundle["original-objective.json"] ===
						priorPrivateBundle["original-objective.json"] &&
						restartChainExtends(priorPrivateBundle["independent-restart-quarantine.json"],
							privateBundle["independent-restart-quarantine.json"],
							"host-independent-restart-reservations", addedReviewCount) &&
						restartChainExtends(priorPrivateBundle["independent-restart-goal-binding.json"],
							privateBundle["independent-restart-goal-binding.json"],
							"host-independent-restart-goal-bindings", addedReviewCount - (abandonedAdded ? 1 : 0));
					let oldSelectionArchived = false;
					if (!sameSelection && privateBundle["research-history.json"] &&
						priorPrivateBundle["candidate.cpp"] && priorPrivateBundle["verification.json"] &&
						priorPrivateBundle["workflow-archive.json"]) {
						try {
							const history = JSON.parse(privateBundle["research-history.json"]);
							oldSelectionArchived = history?.version === 1 &&
								history.kind === "untrusted-version-bound-research-history" &&
								Array.isArray(history.entries) && history.entries.some((entry: any) =>
									entry?.files && selectedKeys.every(name =>
										priorPrivateBundle[name] === undefined || entry.files[name] === priorPrivateBundle[name]));
						} catch { /* A missing old tuple never grants restart authority. */ }
					}
					if (zeroPassThrough || (historicalPreserved && (sameSelection || oldSelectionArchived) &&
						(currentEffectReceipt?.goals.length || abandonedNoGoal) && currentEffectReceipt))
						cp.carryForwardOrigin = { ...originForCurrent,
							privateBundleSha256: privateBundleDigest(privateBundle) };
				}
				const envelopeB64 = sealCheckpoint(cp, key);
				sealed = true;
				return { envelopeB64, observedSettledCny: decimal(nextSettledNano),
					observedUnknownHeldCny: decimal(nextUnknownNano),
					unpricedRequestCount: nextUnpricedCount };
		},
		sealEmergencyCurrent: (amounts, reason) => {
			if (reason !== "effect-review-incomplete" || sealed)
				reject("emergency carry requires an unsealed effect-review failure");
			if (!priorPrivateBundle || !validBundle(priorPrivateBundle) ||
				!priorBootstrapBinding || !validBinding(priorBootstrapBinding))
				reject("emergency carry lacks authenticated prior research evidence");
			const settledAddedNano = n(amounts.settledCny);
			const unknownObservedAddedNano = n(amounts.unknownObservedCny);
			const nextSettledNano = settledNano + settledAddedNano;
			const nextUnknownNano = unknownObservedNano + unknownObservedAddedNano;
			const nextUnpricedCount = unpricedRequestCount + amounts.unpricedRequestCount;
			if (![nextSettledNano, nextUnknownNano, nextUnpricedCount].every(Number.isSafeInteger) ||
				amounts.requestAudit.requests.some(row => row.status === "in-flight") ||
				!validAccountingAudit(amounts.requestAudit, settledAddedNano,
					unknownObservedAddedNano, amounts.unpricedRequestCount))
				reject("emergency carry request audit is invalid or in-flight");
			const pending = [...pendingEffectAncestry];
			if (currentEffectReviewPending) {
				const predecessor = accountingAncestry.at(-1)?.source;
				if (!predecessor) reject("pending effect ancestry lacks its authenticated source");
				pending.push({ ...predecessor });
			}
			const emergencyBundle = { ...priorPrivateBundle };
			if (amounts.privateBundle?.["transport-diagnostics.json"] !== undefined)
				emergencyBundle["transport-diagnostics.json"] =
					amounts.privateBundle["transport-diagnostics.json"];
			if (!validBundle(emergencyBundle))
				reject("emergency transport diagnostic bundle exceeds private bounds");
			const cp: AccountingCheckpoint = { version: 3, ancestry: accountingAncestry,
				legacyAncestry, historical,
				kind: "mul-pis-private-ledger-continuation", missionId: MISSION_ID,
				repository: MISSION_REPOSITORY, seedDigest: seed.seedDigest, parentDigest,
				source: currentSource, settledNano: nextSettledNano,
				unknownObservedNano: nextUnknownNano, unpricedRequestCount: nextUnpricedCount,
				settledAddedNano, unknownObservedAddedNano,
				unpricedAddedCount: amounts.unpricedRequestCount,
				requestAudit: amounts.requestAudit, currentEffectReview: "pending",
				privateBundle: emergencyBundle, bootstrapBinding: priorBootstrapBinding,
				...(opaqueExecutedRuns.length ? { opaqueExecutedRuns: [...opaqueExecutedRuns] } : {}),
				...(reviewedEffectAncestry.length ?
					{ reviewedEffectAncestry: [...reviewedEffectAncestry] } : {}),
				...(pending.length ? { pendingEffectAncestry: pending } : {}) };
			validateCurrentDiagnostic(cp);
			const envelopeB64 = sealCheckpoint(cp, key);
			sealed = true;
			return { envelopeB64, observedSettledCny: decimal(nextSettledNano),
				observedUnknownHeldCny: decimal(nextUnknownNano),
				unpricedRequestCount: nextUnpricedCount };
		}
	};
	historicalFixtureSealers.set(result, amounts => {
			if (sealed || accountingAncestry.length) reject("historical fixture cannot follow v3 sealing");
			const privateBundle = amounts.privateBundle ?? priorPrivateBundle;
			const bootstrapBinding = amounts.bootstrapBinding ?? priorBootstrapBinding;
			if ((privateBundle !== undefined && !validBundle(privateBundle)) ||
				(bootstrapBinding !== undefined && !validBinding(bootstrapBinding)) ||
				(priorBootstrapBinding !== undefined && !sameBinding(bootstrapBinding, priorBootstrapBinding)) ||
				(privateBundle === undefined) !== (bootstrapBinding === undefined))
				reject("current carry accounting exceeds mission bounds");
			const settledAddedNano = n(amounts.settledCny);
			const unknownAddedNano = n(amounts.unknownOrInFlightCny);
			const nextCommittedNano = committedNano + settledAddedNano + unknownAddedNano;
			if (!Number.isSafeInteger(nextCommittedNano) ||
				!validAudit(amounts.requestAudit, settledAddedNano, unknownAddedNano))
				reject("current carry accounting exceeds mission bounds");
			const cp: LegacyCheckpoint = { version: 2, ancestry: legacyAncestry, kind: "mul-pis-private-ledger-continuation",
				missionId: MISSION_ID, repository: MISSION_REPOSITORY, seedDigest: seed.seedDigest,
				parentDigest, source: currentSource, committedNano: nextCommittedNano,
				unknownHeldNano: unknownHeldNano + unknownAddedNano,
				settledAddedNano, unknownAddedNano, requestAudit: amounts.requestAudit,
				...(privateBundle ? { privateBundle, bootstrapBinding } : {}) };
			const envelopeB64 = sealCheckpoint(cp, key);
			sealed = true;
			return { envelopeB64, carryForwardCny: decimal(nextCommittedNano) };
		});
	return result;
}

/** Download the one fixed encrypted carry file; the token is used only for GitHub API. */
export async function downloadCarryArtifact(input: { githubToken: string; artifactId: string;
	request?: typeof fetch }): Promise<string> {
	if (!positiveId(input.artifactId) || !input.githubToken || input.githubToken.length > 4_000)
		reject("invalid carry artifact request");
	const request = input.request ?? fetch;
	const url = `https://api.github.com/repos/${MISSION_REPOSITORY}/actions/artifacts/${input.artifactId}/zip`;
	let initial: Response;
	try { initial = await request(url, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(15_000),
		headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${input.githubToken}` } }); }
	catch { return reject("carry archive download failed"); }
	let response = initial;
	if ([301, 302, 303, 307, 308].includes(initial.status)) {
		const location = initial.headers.get("location");
		let parsed: URL;
		try { parsed = new URL(location ?? ""); } catch { return reject("invalid carry archive redirect"); }
		if (parsed.protocol !== "https:" || parsed.username || parsed.password ||
			(parsed.port && parsed.port !== "443") || !(
			parsed.hostname.endsWith(".blob.core.windows.net") ||
			parsed.hostname.endsWith(".amazonaws.com") ||
			parsed.hostname === "objects.githubusercontent.com"))
			reject("untrusted carry archive redirect");
		try { response = await request(parsed.toString(), { method: "GET", redirect: "error",
			signal: AbortSignal.timeout(15_000) }); }
		catch { return reject("carry archive download failed"); }
	}
	if (response.status !== 200 || Number(response.headers.get("content-length") ?? 0) > MAX_CARRY_BYTES)
		reject("carry archive response is invalid");
	let zip: Buffer;
	try {
		if (!response.body) reject("carry archive response is unreadable");
		const reader = response.body.getReader();
		const chunks: Buffer[] = [];
		let length = 0;
		try {
			while (true) {
				const { value, done } = await reader.read();
				if (done) break;
				length += value.byteLength;
				if (length > MAX_CARRY_BYTES) {
					await reader.cancel().catch(() => undefined);
					reject("carry archive exceeds limit");
				}
				chunks.push(Buffer.from(value));
			}
		} finally { reader.releaseLock(); }
		zip = Buffer.concat(chunks, length);
	} catch (error) {
		if (error instanceof HarnessError) throw error;
		return reject("carry archive response is unreadable");
	}
	const raw = oneZipEntry(zip, CARRY_FILE_NAME);
	let parsed: unknown;
	try { parsed = JSON.parse(raw.toString("utf8")); } catch { return reject("carry file is invalid"); }
	if (!record(parsed) || !exactKeys(parsed, ["envelopeB64"]) || typeof parsed.envelopeB64 !== "string")
		reject("carry file fields are invalid");
	return parsed.envelopeB64;
}

/** Minimal strict ZIP reader for GitHub's single-file artifact; rejects ZIP64, encryption and extra entries. */
function oneZipEntry(zip: Buffer, expectedName: string): Buffer {
	const eocd = zip.length - 22;
	if (eocd < 0 || zip.readUInt32LE(eocd) !== 0x06054b50 || zip.readUInt16LE(eocd + 20) !== 0 ||
		zip.readUInt16LE(eocd + 4) !== 0 || zip.readUInt16LE(eocd + 6) !== 0 ||
		zip.readUInt16LE(eocd + 8) !== 1 || zip.readUInt16LE(eocd + 10) !== 1)
		reject("carry archive layout is invalid");
	const cdSize = zip.readUInt32LE(eocd + 12), cdOffset = zip.readUInt32LE(eocd + 16);
	if (cdSize < 46 || cdOffset < 30 || cdOffset + cdSize !== eocd ||
		zip.readUInt32LE(cdOffset) !== 0x02014b50)
		reject("carry archive directory is invalid");
	const flags = zip.readUInt16LE(cdOffset + 8), method = zip.readUInt16LE(cdOffset + 10);
	const packed = zip.readUInt32LE(cdOffset + 20), unpacked = zip.readUInt32LE(cdOffset + 24);
	const nameLength = zip.readUInt16LE(cdOffset + 28), extraLength = zip.readUInt16LE(cdOffset + 30);
	const commentLength = zip.readUInt16LE(cdOffset + 32), localOffset = zip.readUInt32LE(cdOffset + 42);
	const name = zip.subarray(cdOffset + 46, cdOffset + 46 + nameLength).toString("utf8");
	if (name !== expectedName || cdOffset + 46 + nameLength + extraLength + commentLength !== eocd ||
		(flags & ~(0x800 | 0x8)) || ![0, 8].includes(method) || packed > MAX_CARRY_BYTES || unpacked > MAX_CARRY_BYTES ||
		zip.readUInt16LE(cdOffset + 34) !== 0 || localOffset !== 0 ||
		zip.readUInt32LE(localOffset) !== 0x04034b50 ||
		zip.readUInt16LE(localOffset + 6) !== flags || zip.readUInt16LE(localOffset + 8) !== method)
		reject("carry archive entry is invalid");
	const localNameLength = zip.readUInt16LE(localOffset + 26);
	const localExtraLength = zip.readUInt16LE(localOffset + 28);
	const localName = zip.subarray(localOffset + 30, localOffset + 30 + localNameLength).toString("utf8");
	const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
	if (localName !== expectedName || dataOffset + packed > cdOffset)
		reject("carry archive local entry is invalid");
	const end = dataOffset + packed;
	if (flags & 0x8) {
		const descriptor = cdOffset - end;
		if (![12, 16].includes(descriptor) ||
			(descriptor === 16 && zip.readUInt32LE(end) !== 0x08074b50))
			reject("carry archive descriptor is invalid");
		const offset = end + (descriptor === 16 ? 4 : 0);
		if (zip.readUInt32LE(offset) !== zip.readUInt32LE(cdOffset + 16) ||
			zip.readUInt32LE(offset + 4) !== packed || zip.readUInt32LE(offset + 8) !== unpacked)
			reject("carry archive descriptor is invalid");
	} else if (end !== cdOffset || zip.readUInt32LE(localOffset + 14) !== zip.readUInt32LE(cdOffset + 16) ||
		zip.readUInt32LE(localOffset + 18) !== packed || zip.readUInt32LE(localOffset + 22) !== unpacked)
		reject("carry archive local sizes are invalid");
	const packedBytes = zip.subarray(dataOffset, dataOffset + packed);
	let bytes: Buffer;
	try { bytes = method === 0 ? packedBytes : inflateRawSync(packedBytes, { maxOutputLength: MAX_CARRY_BYTES }); }
	catch { return reject("carry archive decompression failed"); }
	if (bytes.length !== unpacked) reject("carry archive length is invalid");
	return bytes;
}
