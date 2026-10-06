import { createHash, createPublicKey, constants, hkdfSync, verify } from "node:crypto";
import { readFile } from "node:fs/promises";
import { inflateRawSync } from "node:zlib";
import { HarnessError } from "../types.ts";

export const MISSION_ID = "mul-pis-private-original-objective-2026-10-05";
export const MISSION_REPOSITORY = "SakuyaInazaki/Mul-Pis";
export const MISSION_TOTAL_CNY = 30;
export const MISSION_ARTIFACT = "confidential-campaign-envelope";
export const ONE_USE_PUSH_MARKER = "Continue capability-aware workflow with private recovery (mul-pis-20261006-recovery-run1)";
export const PRIVATE_CONTINUATION_FILE_KEYS = ["candidate.cpp", "verification.json",
	"objective-checkpoint.json", "workflow-archive.json", "m04-export.json",
	"m04-adopted-knowledge.json", "assessment-receipts.json",
	"objective-assessment-receipts.json", "original-objective.json",
	"experiment-plan.json", "research-history.json"] as const;
export type PrivateContinuationBundle = Partial<Record<(typeof PRIVATE_CONTINUATION_FILE_KEYS)[number], string>>;
export type BootstrapBinding = { contractId: string; sourceSha256: string };
export type RootReviewedAnchor = { commit: string; artifactSha256: string;
	digestScope: "encrypted-result-envelope" };
const PUBLIC_KEY_SPKI_SHA256 = "095541a341d91f128aa9cd1f0c6d34f6b7291fc5d667365ef5a67efd42fd0d23";

export interface SignedMissionLedgerPayloadV1 {
	version: 1;
	kind: "mul-pis-private-mission-ledger";
	missionId: typeof MISSION_ID;
	repository: typeof MISSION_REPOSITORY;
	globalMaxCny: typeof MISSION_TOTAL_CNY;
	priorCommittedCny: number;
	revision: number;
	previous: { runId: string; runAttempt: number; artifactId: string; artifactName: typeof MISSION_ARTIFACT };
}
export type SignedMissionLedgerAnchor = Omit<SignedMissionLedgerPayloadV1, "version"> & {
	version: 1 | 2; rootReviewedAnchor?: RootReviewedAnchor };
type SignedMissionLedgerPayloadV2 = Omit<SignedMissionLedgerPayloadV1, "version"> & { version: 2;
	rootReviewedAnchor?: RootReviewedAnchor;
	bootstrap: BootstrapBinding & { format: "deflate-raw-json-v1"; filesB64: string } };

function reject(reason: string): never { throw new HarnessError("runner.mission-ledger", reason); }
function record(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
	return Object.keys(value).sort().join("|") === [...keys].sort().join("|");
}
function positiveId(value: unknown): value is string {
	return typeof value === "string" && /^[1-9][0-9]{0,17}$/.test(value);
}
function base64(value: unknown, maxBytes: number): Buffer {
	if (typeof value !== "string" || value.length > Math.ceil(maxBytes * 4 / 3) + 4 ||
		!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) reject("ledger envelope encoding is invalid");
	const decoded = Buffer.from(value, "base64");
	if (!decoded.length || decoded.length > maxBytes || decoded.toString("base64") !== value)
		reject("ledger envelope bytes are invalid");
	return decoded;
}

/** The signature is secret high-entropy key material only while the Actions secret stays private.
 * Do not log, serialize, or pass this handle to a model or confined tool.
 */
export async function authenticateSignedMissionSeed(input: {
	envelopeB64: string | undefined; publicKeyFile: string; expectedSpkiSha256?: string;
}): Promise<{ payload: SignedMissionLedgerAnchor; seedDigest: string;
	bootstrapPrivateBundle?: PrivateContinuationBundle; bootstrapBinding?: BootstrapBinding;
	derivePrivateKey: (purpose: string) => Buffer }> {
	if (typeof input.envelopeB64 !== "string") reject("ledger envelope encoding is invalid");
	if (input.envelopeB64.length > 48 * 1024)
		reject("signed mission ledger exceeds Actions secret limit");
	const envelopeBytes = base64(input.envelopeB64, 36 * 1024);
	let envelope: unknown;
	try { envelope = JSON.parse(envelopeBytes.toString("utf8")); }
	catch { return reject("signed mission ledger envelope is invalid"); }
	if (!record(envelope) || !exactKeys(envelope, ["payload_b64", "signature_b64"]))
		reject("signed mission ledger envelope fields are invalid");
	const payloadBytes = base64(envelope.payload_b64, 30 * 1024);
	const signature = base64(envelope.signature_b64, 1_000);
	const publicKey = createPublicKey(await readFile(input.publicKeyFile));
	const spki = publicKey.export({ type: "spki", format: "der" });
	if (createHash("sha256").update(spki).digest("hex") !==
		(input.expectedSpkiSha256 ?? PUBLIC_KEY_SPKI_SHA256) ||
		!verify("sha256", payloadBytes, { key: publicKey, padding: constants.RSA_PKCS1_PSS_PADDING,
			saltLength: 32 }, signature)) reject("signed mission ledger authentication failed");
	let parsed: unknown;
	try { parsed = JSON.parse(payloadBytes.toString("utf8")); }
	catch { return reject("signed mission ledger payload is invalid"); }
	if (!record(parsed) || (parsed.version !== 1 && parsed.version !== 2) ||
		!exactKeys(parsed, ["version", "kind", "missionId", "repository", "globalMaxCny",
		"priorCommittedCny", "revision", "previous", ...(parsed.version === 2 ? ["bootstrap",
			...(parsed.rootReviewedAnchor === undefined ? [] : ["rootReviewedAnchor"])] : [])]) ||
		!record(parsed.previous) ||
		!exactKeys(parsed.previous, ["runId", "runAttempt", "artifactId", "artifactName"]))
		reject("signed mission ledger payload fields are invalid");
	const payload = parsed as unknown as SignedMissionLedgerPayloadV1 | SignedMissionLedgerPayloadV2;
	if (payload.kind !== "mul-pis-private-mission-ledger" ||
		payload.missionId !== MISSION_ID || payload.repository !== MISSION_REPOSITORY ||
		payload.globalMaxCny !== MISSION_TOTAL_CNY ||
		!Number.isFinite(payload.priorCommittedCny) || payload.priorCommittedCny < 0 ||
		!Number.isSafeInteger(payload.revision) || payload.revision < 1 ||
		!positiveId(payload.previous.runId) || payload.previous.runAttempt !== 1 ||
		!positiveId(payload.previous.artifactId) || payload.previous.artifactName !== MISSION_ARTIFACT)
		reject("signed mission ledger mission or prior commitment is invalid");
	let bootstrapPrivateBundle: PrivateContinuationBundle | undefined;
	let bootstrapBinding: BootstrapBinding | undefined;
	if (payload.version === 2) {
		const anchor = payload.rootReviewedAnchor;
		if (anchor !== undefined && (!record(anchor) || !exactKeys(anchor, ["commit", "artifactSha256", "digestScope"]) ||
			typeof anchor.commit !== "string" || !/^[0-9a-f]{40}$/.test(anchor.commit) ||
			typeof anchor.artifactSha256 !== "string" || !/^[0-9a-f]{64}$/.test(anchor.artifactSha256) ||
			anchor.digestScope !== "encrypted-result-envelope"))
			reject("signed root-reviewed anchor attestation is invalid");
		const b = payload.bootstrap;
		if (!record(b) || !exactKeys(b, ["contractId", "sourceSha256", "format", "filesB64"]) ||
			typeof b.contractId !== "string" || !b.contractId || b.contractId.length > 256 ||
			!(/^[0-9a-f]{64}$/).test(b.sourceSha256) || b.format !== "deflate-raw-json-v1")
			reject("signed bootstrap binding is invalid");
		const compressed = base64(b.filesB64, 24 * 1024);
		let expanded: Buffer;
		try { expanded = inflateRawSync(compressed, { maxOutputLength: 4 * 1024 * 1024 }); }
		catch { return reject("signed bootstrap bundle could not be expanded"); }
		let files: unknown;
		try { files = JSON.parse(expanded.toString("utf8")); }
		catch { return reject("signed bootstrap bundle is invalid"); }
		if (!record(files) || !Object.keys(files).length ||
			!Object.keys(files).every(key => (PRIVATE_CONTINUATION_FILE_KEYS as readonly string[]).includes(key) &&
				typeof files[key] === "string" && Buffer.byteLength(files[key] as string, "utf8") <= 4 * 1024 * 1024))
			reject("signed bootstrap bundle files are invalid");
		bootstrapPrivateBundle = files as PrivateContinuationBundle;
		bootstrapBinding = { contractId: b.contractId, sourceSha256: b.sourceSha256 };
	}
	const seedDigest = createHash("sha256").update(envelopeBytes).digest("hex");
	const { bootstrap: _privateBootstrap, ...safePayload } = payload as SignedMissionLedgerPayloadV2;
	return { payload: safePayload, seedDigest,
		...(bootstrapPrivateBundle ? { bootstrapPrivateBundle, bootstrapBinding } : {}),
		derivePrivateKey: (purpose: string) => {
			if (purpose !== "mul-pis-ledger-continuation-v1") reject("invalid mission key purpose");
			return Buffer.from(hkdfSync("sha256", signature, Buffer.from(seedDigest, "hex"), purpose, 32));
		} };
}
/** Signed carry plus GitHub run-order proof; the private signing key is never loaded here. */
export async function verifySignedMissionLedger(input: {
	envelopeB64: string | undefined; publicKeyFile: string; githubToken: string | undefined;
	current: { repository: string | undefined; runId: string | undefined; runAttempt: string | undefined;
		actor: string | undefined; event: string | undefined; ref: string | undefined;
		sha: string | undefined; manualAuthorized: string | undefined };
	request?: typeof fetch;
	/** Offline fixture key identity only; production caller omits this override. */
	expectedSpkiSha256?: string;
}): Promise<SignedMissionLedgerAnchor> {
	// The compatibility entry point admits only the signed anchor plus proved
	// nonbillable runs. Reuse the same paginated proof as automatic continuation.
	const { openLedgerContinuation } = await import("./ledger-continuation.ts");
	await openLedgerContinuation({ seedEnvelopeB64: input.envelopeB64,
		publicKeyFile: input.publicKeyFile, githubToken: input.githubToken,
		current: input.current, request: input.request, expectedSpkiSha256: input.expectedSpkiSha256,
		requireSeedOnly: true, loadCarryArtifact: async () => reject("intervening workflow may have executed a billable job") });
	return (await authenticateSignedMissionSeed(input)).payload;
}
