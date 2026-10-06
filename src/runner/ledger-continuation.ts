import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { inflateRawSync } from "node:zlib";
import { HarnessError } from "../types.ts";
import type { CampaignAdmissionRejection, CampaignRequestAudit } from "./deepseek-campaign.ts";
import { isNativeCnyPricingRecord, type NativeCnyPricingProfile } from "./deepseek-cny-pricing.ts";
import { isDeepSeekProviderOutputLimitRecord, type DeepSeekProviderOutputLimit } from "./deepseek-provider-limits.ts";
import { authenticateSignedMissionSeed, MISSION_ARTIFACT, MISSION_ID, MISSION_REPOSITORY,
	MISSION_TOTAL_CNY, ONE_USE_PUSH_MARKER, PRIVATE_CONTINUATION_FILE_KEYS } from "./signed-mission-ledger.ts";
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
const WORKFLOW = "manual-private-campaign.yml";
export type { PrivateContinuationBundle, BootstrapBinding } from "./signed-mission-ledger.ts";
export type CurrentMissionRun = {
	repository: string | undefined; runId: string | undefined; runAttempt: string | undefined;
	actor: string | undefined; event: string | undefined; ref: string | undefined;
	sha: string | undefined; manualAuthorized: string | undefined;
};
type Run = { id?: number; run_number?: number; run_attempt?: number; workflow_id?: number;
	status?: string; conclusion?: string; head_branch?: string; head_sha?: string; event?: string;
	actor?: { login?: string }; head_commit?: { message?: string } };
type Job = { id?: number; run_id?: number; run_attempt?: number; head_sha?: string;
	name?: string; status?: string; conclusion?: string;
	steps?: Array<{ name?: string; status?: string; conclusion?: string }> };
type Artifact = { id?: number; name?: string; expired?: boolean; digest?: string;
	workflow_run?: { id?: number; head_sha?: string } };
type Source = { runId: string; runAttempt: number; runNumber: number; commit: string };
/** Host-only admission evidence. Terminal execution is not usage reconciliation,
 * and this read-only proof is not an atomic durable restart claim.
 */
export type AuthenticatedPriorCarryProof = Readonly<{
	version: 1; kind: "authenticated-prior-mission-carry"; repository: typeof MISSION_REPOSITORY;
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
	priorCommittedCny: number; priorUnknownHeldCny: number; admittedCurrent: Readonly<Source>;
}>;
const authenticatedCarryProofs = new WeakSet<object>();
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
function privateBundleDigest(bundle: PrivateContinuationBundle): string {
	return digest(JSON.stringify(Object.fromEntries(Object.entries(bundle).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))));
}
export function authenticatedPriorCarryBindsBundle(proof: unknown, bundle: unknown): boolean {
	return isAuthenticatedPriorCarryProof(proof) && proof.privateBundleSha256 !== null &&
		validBundle(bundle) && privateBundleDigest(bundle) === proof.privateBundleSha256;
}
type Checkpoint = { version: 1 | 2; kind: "mul-pis-private-ledger-continuation";
	missionId: typeof MISSION_ID; repository: typeof MISSION_REPOSITORY; seedDigest: string;
	parentDigest: string; source: Source; committedNano: number; unknownHeldNano: number;
	settledAddedNano: number; unknownAddedNano: number; requestAudit: RequestAuditSnapshot;
	bootstrapBinding?: BootstrapBinding;
	privateBundle?: PrivateContinuationBundle; ancestry?: AncestorReceipt[] };
type AncestorReceipt = Pick<Checkpoint, "parentDigest" | "source" | "committedNano" |
	"unknownHeldNano" | "settledAddedNano" | "unknownAddedNano" | "requestAudit" | "bootstrapBinding"> &
	{ envelopeDigest: string };
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
		!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value))
		reject("invalid carry encoding");
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
function sourceOf(run: Run): Source {
	if (!Number.isSafeInteger(run.id) || run.id! <= 0 ||
		!Number.isSafeInteger(run.run_number) || run.run_number! <= 0 ||
		!Number.isSafeInteger(run.run_attempt) || run.run_attempt! <= 0 || !/^[0-9a-f]{40}$/.test(run.head_sha ?? ""))
		reject("workflow run identity is incomplete");
	return { runId: String(run.id), runAttempt: run.run_attempt!, runNumber: run.run_number!, commit: run.head_sha! };
}
function validateAccounting(cp: Pick<Checkpoint, "source" | "parentDigest" | "committedNano" |
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
function checkpointVersion(envelopeB64: string): 1 | 2 {
	const bytes = canonicalBase64(envelopeB64, MAX_CARRY_BYTES);
	let outer: unknown;
	try { outer = JSON.parse(bytes.toString("utf8")); }
	catch { return reject("carry envelope is invalid"); }
	if (!record(outer) || (outer.version !== 1 && outer.version !== 2))
		reject("carry envelope fields are invalid");
	return outer.version;
}
function readCheckpoint(envelopeB64: string, key: Buffer, seedDigest: string, expectedSource: Source,
	legacyParentDigest?: string): { checkpoint: Checkpoint; digest: string } {
	const envelopeBytes = canonicalBase64(envelopeB64, MAX_CARRY_BYTES);
	let outer: unknown;
	try { outer = JSON.parse(envelopeBytes.toString("utf8")); } catch { return reject("carry envelope is invalid"); }
	if (!record(outer) || (outer.version !== 1 && outer.version !== 2) ||
		!exactKeys(outer, ["version", "nonce", "ciphertext", "tag", ...(outer.version === 2 ? ["parentDigest"] : [])]))
		reject("carry envelope fields are invalid");
	const parentDigest = outer.version === 2 ? outer.parentDigest : legacyParentDigest;
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
			...(outer.version === 2 ? [2] : []), parentDigest, expectedSource])));
		decipher.setAuthTag(tag);
		bytes = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
	} catch { return reject("carry authentication failed"); }
	let parsed: unknown;
	try { parsed = JSON.parse(bytes.toString("utf8")); } catch { return reject("carry plaintext is invalid"); }
	if (!record(parsed) || !exactKeys(parsed, ["version", "kind", "missionId", "repository", "seedDigest",
		"parentDigest", "source", "committedNano", "unknownHeldNano", "settledAddedNano",
		"unknownAddedNano", "requestAudit", ...(parsed.version === 2 ? ["ancestry"] : []),
		...(parsed.privateBundle === undefined ? [] : ["privateBundle"]),
		...(parsed.bootstrapBinding === undefined ? [] : ["bootstrapBinding"])]))
		reject("carry checkpoint fields are invalid");
	const cp = parsed as unknown as Checkpoint;
	if (cp.version !== outer.version || cp.kind !== "mul-pis-private-ledger-continuation" ||
		cp.missionId !== MISSION_ID || cp.repository !== MISSION_REPOSITORY || cp.seedDigest !== seedDigest ||
		cp.parentDigest !== parentDigest ||
		(cp.version === 2 && !Array.isArray(cp.ancestry)) ||
		(cp.privateBundle !== undefined && !validBundle(cp.privateBundle)) ||
		(cp.bootstrapBinding !== undefined && !validBinding(cp.bootstrapBinding)) ||
		(cp.privateBundle === undefined) !== (cp.bootstrapBinding === undefined))
		reject("carry checkpoint fields are invalid");
	return { checkpoint: cp, digest: digest(envelopeBytes) };
}
function ancestorReceipt(cp: Checkpoint, envelopeDigest: string): AncestorReceipt {
	return { source: cp.source, parentDigest: cp.parentDigest, envelopeDigest,
		committedNano: cp.committedNano, unknownHeldNano: cp.unknownHeldNano,
		settledAddedNano: cp.settledAddedNano, unknownAddedNano: cp.unknownAddedNano,
		requestAudit: cp.requestAudit, ...(cp.bootstrapBinding ? { bootstrapBinding: cp.bootstrapBinding } : {}) };
}
function validateAncestry(cp: Checkpoint, sources: Source[], seedDigest: string,
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
function sealCheckpoint(cp: Checkpoint, key: Buffer): string {
	const nonce = randomBytes(12);
	const cipher = createCipheriv("aes-256-gcm", key, nonce);
	cipher.setAAD(Buffer.from(JSON.stringify([MISSION_ID, MISSION_REPOSITORY, cp.seedDigest,
		...(cp.version === 2 ? [2] : []), cp.parentDigest, cp.source])));
	const ciphertext = Buffer.concat([cipher.update(JSON.stringify(cp), "utf8"), cipher.final()]);
	const outer = { version: cp.version, ...(cp.version === 2 ? { parentDigest: cp.parentDigest } : {}),
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
	const steps = job.steps?.filter(step => step.name === "Run bounded private campaign") ?? [];
	if (steps.length > 1 || (job.conclusion === "skipped" &&
		steps.some(step => step.conclusion !== "skipped")))
		reject("workflow provider step disposition is ambiguous");
	if (job.conclusion === "skipped" ||
		(steps[0]?.status === "completed" && steps[0].conclusion === "skipped")) return "skipped";
	if (steps[0]?.status !== "completed") reject("intervening provider execution is unresolved");
	return "executed";
}
function priorCarryProof(input: { source: Source; current: Source; run: Run; job: Job;
	artifactId: string; envelopeSha256: string; bundle?: PrivateContinuationBundle;
	resultArtifact?: AuthenticatedPriorCarryProof["resultArtifact"];
	ancestry: readonly AncestorReceipt[];
	committedNano: number; unknownHeldNano: number }): AuthenticatedPriorCarryProof | undefined {
	const { source, current, run, job } = input;
	const steps = job.steps?.filter(step => step.name === "Run bounded private campaign") ?? [];
	const terminalConclusions = ["success", "failure", "neutral", "timed_out", "action_required", "stale"];
	// Historical carry accounting remains readable without these extra API fields,
	// but their absence or mismatch must never mint restart authority.
	if (!Number.isSafeInteger(job.id) || job.id! <= 0 || job.run_id !== Number(source.runId) ||
		job.run_attempt !== source.runAttempt || job.head_sha !== source.commit ||
		run.id !== Number(source.runId) || run.run_attempt !== source.runAttempt || run.head_sha !== source.commit ||
		!Number.isSafeInteger(run.workflow_id) || run.workflow_id! <= 0 ||
		run.status !== "completed" || !terminalConclusions.includes(run.conclusion ?? "") ||
		job.status !== "completed" || job.name !== "private-campaign" ||
		!terminalConclusions.includes(job.conclusion ?? "") || steps.length !== 1 ||
		steps[0].status !== "completed" ||
		![...terminalConclusions, "cancelled"].includes(steps[0].conclusion ?? "")) return undefined;
	const proof: AuthenticatedPriorCarryProof = Object.freeze({
		version: 1, kind: "authenticated-prior-mission-carry", repository: MISSION_REPOSITORY,
		source: Object.freeze({ ...source }), envelopeSha256: input.envelopeSha256,
		privateBundleSha256: input.bundle ? privateBundleDigest(input.bundle) : null,
		artifact: Object.freeze({ repository: MISSION_REPOSITORY, artifactId: input.artifactId,
			artifactName: CARRY_ARTIFACT_NAME, runId: source.runId }),
		...(input.resultArtifact ? { resultArtifact: input.resultArtifact } : {}),
		terminal: Object.freeze({ workflowId: String(run.workflow_id), runStatus: "completed",
			runConclusion: run.conclusion!, jobId: String(job.id), jobName: "private-campaign",
			jobStatus: "completed", jobConclusion: job.conclusion!, jobRunId: String(job.run_id),
			jobRunAttempt: job.run_attempt!, jobHeadSha: job.head_sha!,
			providerStepStatus: "completed", providerStepConclusion: steps[0].conclusion! }),
		priorCommittedCny: decimal(input.committedNano), priorUnknownHeldCny: decimal(input.unknownHeldNano),
		admittedCurrent: Object.freeze({ ...current }),
	});
	authenticatedCarryProofs.add(proof);
	authenticatedCarryAncestors.set(proof, Object.freeze(input.ancestry.map(ancestor => Object.freeze({
		source: Object.freeze({ ...ancestor.source }), envelopeSha256: ancestor.envelopeDigest,
	}))));
	return proof;
}
async function oneArtifact(runId: string, token: string, request: typeof fetch,
	name: string, requiredId?: string, inspect?: (artifacts: Artifact[]) => void): Promise<string> {
	const url = `https://api.github.com/repos/${MISSION_REPOSITORY}/actions/runs/${runId}/artifacts?per_page=100`;
	const response = await githubJson(url, token, request);
	if (!Array.isArray(response.artifacts) || response.artifacts.length > 100 ||
		!Number.isSafeInteger(response.total_count) || response.total_count !== response.artifacts.length)
		reject("workflow artifact list is incomplete");
	const found = response.artifacts.filter(value => {
		const a = value as Artifact;
		return record(value) && a.name === name && a.workflow_run?.id === Number(runId);
	}) as Artifact[];
	if (found.length !== 1 || !Number.isSafeInteger(found[0].id) || found[0].id! <= 0 ||
		found[0].expired !== false || (requiredId !== undefined && String(found[0].id) !== requiredId))
		reject("required private carry artifact is unavailable");
	inspect?.(response.artifacts.filter(record) as Artifact[]);
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
	request?: typeof fetch; expectedSpkiSha256?: string;
	/** Compatibility verifier may require every intervening run to be nonbillable. */
	requireSeedOnly?: boolean;
}): Promise<{ priorCommittedCny: number; priorUnknownHeldCny: number;
	/** Present only for a fully authenticated carry with independently matched terminal job metadata. */
	priorCarryProof?: AuthenticatedPriorCarryProof;
	/** Under the reviewed shared-concurrency, single-driver Actions workflow only.
	 * A later run must account for this durable run record or stop on missing carry.
	 * This is not an atomic claim across arbitrary same-job host processes.
	 */
	claimOneUse: (carryDigest: string) => Promise<ActionsCarryRestartClaim>;
	priorPrivateBundle?: PrivateContinuationBundle;
	priorBootstrapBinding?: BootstrapBinding;
	sealCurrent: (amounts: { settledCny: number; unknownOrInFlightCny: number;
		requestAudit: RequestAuditSnapshot;
		privateBundle?: PrivateContinuationBundle; bootstrapBinding?: BootstrapBinding }) =>
		{ envelopeB64: string; carryForwardCny: number } }> {
	const c = input.current;
	if (c.repository !== MISSION_REPOSITORY || c.actor !== "SakuyaInazaki" ||
		(c.event !== "workflow_dispatch" && c.event !== "push") ||
		(c.event === "workflow_dispatch" && c.manualAuthorized !== "true") ||
		c.ref !== `refs/heads/${BRANCH}` || c.runAttempt !== "1" || !positiveId(c.runId) ||
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
		current.head_branch !== BRANCH || (c.event === "push" && current.head_commit?.message !== ONE_USE_PUSH_MARKER) ||
		!Number.isSafeInteger(current.workflow_id) || current.workflow_id! <= 0 ||
		pages.some(run => run.workflow_id !== current.workflow_id) ||
		anchor.status !== "completed" || anchor.run_attempt !== seed.payload.previous.runAttempt ||
		anchor.head_branch !== BRANCH ||
		(seed.payload.rootReviewedAnchor !== undefined && anchor.head_sha !== seed.payload.rootReviewedAnchor.commit))
		reject("workflow identity or signed seed freshness is invalid");
	if (c.event === "push" && anchor.event === "push") {
		if (typeof anchor.head_commit?.message !== "string") reject("prior push authorization disposition is unknown");
		if (anchor.head_commit.message === ONE_USE_PUSH_MARKER) reject("one-use push authorization was already consumed");
	}
	const ordered = pages.filter(x => Number.isSafeInteger(x.run_number) &&
		x.run_number! >= anchor.run_number! && x.run_number! <= current.run_number!)
		.sort((a, b) => a.run_number! - b.run_number!);
	if (ordered.length !== current.run_number! - anchor.run_number! + 1 ||
		new Set(ordered.map(x => x.run_number)).size !== ordered.length ||
		ordered[0].id !== anchor.id || ordered.at(-1)?.id !== current.id)
		reject("workflow run order cannot be proved exclusive");
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
	if (!seed.payload.rootReviewedAnchor) await oneArtifact(seed.payload.previous.runId, input.githubToken, request,
		seed.payload.previous.artifactName, seed.payload.previous.artifactId);
	let committedNano = n(seed.payload.priorCommittedCny);
	let unknownHeldNano = 0;
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
		if (run.head_branch !== BRANCH || run.actor?.login !== c.actor ||
			(run.event !== "push" && run.event !== "workflow_dispatch"))
			reject("intervening provider execution is unresolved");
		if (c.event === "push" && run.event === "push") {
			if (typeof run.head_commit?.message !== "string") reject("prior push authorization disposition is unknown");
			if (run.head_commit.message === ONE_USE_PUSH_MARKER) reject("one-use push authorization was already consumed");
		}
		executedSources.push(source);
		executedMetadata.set(source.runId, { run, job });
	}
	const loadedArtifacts = new Map<string, string>();
	const resultArtifacts = new Map<string, AuthenticatedPriorCarryProof["resultArtifact"]>();
	const load = async (source: Source): Promise<string> => {
		const artifactId = await oneArtifact(source.runId, input.githubToken!, request, CARRY_ARTIFACT_NAME,
			undefined, artifacts => resultArtifacts.set(source.runId, resultArtifactIdentity(artifacts, source)));
		loadedArtifacts.set(source.runId, artifactId);
		try { return await input.loadCarryArtifact({ runId: source.runId, artifactId }); }
		catch { return reject("private carry artifact could not be read"); }
	};
	let ancestry: AncestorReceipt[] = [];
	if (executedSources.length) {
		const latest = executedSources.at(-1)!;
		const latestEnvelope = await load(latest);
		if (checkpointVersion(latestEnvelope) === 2) {
			const opened = readCheckpoint(latestEnvelope, key, seed.seedDigest, latest);
			validateAncestry(opened.checkpoint, executedSources, seed.seedDigest, committedNano, priorBootstrapBinding);
			const cp = opened.checkpoint;
			ancestry = [...cp.ancestry!, ancestorReceipt(cp, opened.digest)];
			committedNano = cp.committedNano; unknownHeldNano = cp.unknownHeldNano;
			priorPrivateBundle = cp.privateBundle; priorBootstrapBinding = cp.bootstrapBinding;
			parentDigest = opened.digest;
		} else {
			// Legacy carries have no compacted ancestry. Every original ciphertext
			// must remain present until a verified v2 checkpoint carries its receipt.
			for (const [index, source] of executedSources.entries()) {
				const envelope = index === executedSources.length - 1 ? latestEnvelope : await load(source);
				const opened = readCheckpoint(envelope, key, seed.seedDigest, source, parentDigest);
				const cp = opened.checkpoint;
				if (cp.version === 2) validateAncestry(cp, executedSources.slice(0, index + 1),
					seed.seedDigest, n(seed.payload.priorCommittedCny), seed.bootstrapBinding);
				validateAccounting(cp, source, parentDigest, committedNano, unknownHeldNano, priorBootstrapBinding);
				ancestry.push(ancestorReceipt(cp, opened.digest));
				committedNano = cp.committedNano; unknownHeldNano = cp.unknownHeldNano;
				priorPrivateBundle = cp.privateBundle; priorBootstrapBinding = cp.bootstrapBinding;
				parentDigest = opened.digest;
			}
		}
	}
	const currentSource = sourceOf(current);
	const latestSource = executedSources.at(-1);
	const proof = latestSource ? priorCarryProof({ source: latestSource, current: currentSource,
		...executedMetadata.get(latestSource.runId)!, artifactId: loadedArtifacts.get(latestSource.runId)!,
		resultArtifact: resultArtifacts.get(latestSource.runId),
		ancestry, envelopeSha256: parentDigest, bundle: priorPrivateBundle, committedNano, unknownHeldNano }) : undefined;
	if (priorPrivateBundle) Object.freeze(priorPrivateBundle);
	if (priorBootstrapBinding) Object.freeze(priorBootstrapBinding);
	let sealed = false;
	return { priorCommittedCny: decimal(committedNano), priorUnknownHeldCny: decimal(unknownHeldNano),
		...(proof ? { priorCarryProof: proof } : {}),
		...(priorPrivateBundle ? { priorPrivateBundle } : {}),
		...(priorBootstrapBinding ? { priorBootstrapBinding } : {}),
		claimOneUse: async carryDigest => {
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
					observed.actor?.login !== c.actor || observed.event !== c.event || observed.head_branch !== BRANCH)
					reject("current Actions restart admission is no longer active");
				const disposition = await githubJson(`${base}/runs/${currentSource.runId}/jobs?per_page=100`, input.githubToken!, request);
				if (disposition.total_count !== 1 || !Array.isArray(disposition.jobs) ||
					disposition.jobs.length !== 1 || !record(disposition.jobs[0]))
					reject("current Actions restart job identity is incomplete");
				const job = disposition.jobs[0] as Job;
				const steps = Array.isArray(job.steps) ? job.steps.filter(step => record(step) && step.name === "Run bounded private campaign") : [];
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
			if (sealed) reject("current carry was already sealed");
			const settledAddedNano = n(amounts.settledCny);
			const unknownAddedNano = n(amounts.unknownOrInFlightCny);
			const nextCommittedNano = committedNano + settledAddedNano + unknownAddedNano;
			const privateBundle = amounts.privateBundle ?? priorPrivateBundle;
			const bootstrapBinding = amounts.bootstrapBinding ?? priorBootstrapBinding;
			if (!Number.isSafeInteger(nextCommittedNano) ||
				!validAudit(amounts.requestAudit, settledAddedNano, unknownAddedNano) ||
				(privateBundle !== undefined && !validBundle(privateBundle)) ||
				(bootstrapBinding !== undefined && !validBinding(bootstrapBinding)) ||
				(priorBootstrapBinding !== undefined && !sameBinding(bootstrapBinding, priorBootstrapBinding)) ||
				(privateBundle === undefined) !== (bootstrapBinding === undefined))
				reject("current carry accounting exceeds mission bounds");
			const cp: Checkpoint = { version: 2, ancestry, kind: "mul-pis-private-ledger-continuation",
				missionId: MISSION_ID, repository: MISSION_REPOSITORY, seedDigest: seed.seedDigest,
				parentDigest, source: currentSource, committedNano: nextCommittedNano,
				unknownHeldNano: unknownHeldNano + unknownAddedNano,
				settledAddedNano, unknownAddedNano, requestAudit: amounts.requestAudit,
				...(privateBundle ? { privateBundle, bootstrapBinding } : {}) };
			const envelopeB64 = sealCheckpoint(cp, key);
			sealed = true;
			return { envelopeB64, carryForwardCny: decimal(nextCommittedNano) };
		} };
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
