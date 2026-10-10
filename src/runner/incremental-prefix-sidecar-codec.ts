/** Stable, source-bound encrypted transport for historical incremental prefix
 * bytes. A successor republishes these exact ciphertext segments and the
 * authenticated manifest; it never has to fetch an expired original artifact.
 */
import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from "node:crypto";
import { HarnessError } from "../types.ts";
import { MISSION_ID, MISSION_REPOSITORY } from "./signed-mission-ledger.ts";

export const PREFIX_SIDECAR_RAW_BYTES = 1024 * 1024;
export const PREFIX_SIDECAR_FILE_BYTES = PREFIX_SIDECAR_RAW_BYTES + 28;
export const PREFIX_LOGICAL_BYTES = 64 * 1024 * 1024;
const FORMAT = "aes-256-gcm-prefix-segments-v1";
const HEX64 = /^[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const POSITIVE_ID = /^[1-9][0-9]{0,17}$/;

export type HistoricalPrefixSidecarSource = Readonly<{
	runId: string; runAttempt: number; runNumber: number; commit: string;
}>;
export type HistoricalPrefixArtifact = Readonly<{
	repository: string; artifactId: string; artifactName: string; runId: string;
	archiveSha256: string; digestScope: "github-artifact-archive";
}>;
export type HistoricalPrefixSidecarManifest = Readonly<{
	version: 1; format: typeof FORMAT; segmentCount: number;
	plaintextBytes: number; plaintextSha256: string; ciphertextChainSha256: string;
}>;
type Binding = Readonly<{
	key: Buffer; seedDigest: string; source: HistoricalPrefixSidecarSource;
	event: "push" | "workflow_dispatch"; priorCarryEnvelopeSha256: string;
	artifact: HistoricalPrefixArtifact; sequence: number;
}>;

function reject(reason: string): never { throw new HarnessError("runner.historical-prefix-sidecar", reason); }
function sha256(value: Buffer): string { return createHash("sha256").update(value).digest("hex"); }
function validBinding(binding: Binding): void {
	const source = binding.source;
	const artifact = binding.artifact;
	if (!Buffer.isBuffer(binding.key) || binding.key.length !== 32 ||
		!HEX64.test(binding.seedDigest) || !HEX64.test(binding.priorCarryEnvelopeSha256) ||
		!source || !POSITIVE_ID.test(source.runId) ||
		!Number.isSafeInteger(source.runAttempt) || source.runAttempt < 1 ||
		!Number.isSafeInteger(source.runNumber) || source.runNumber < 1 ||
		!COMMIT.test(source.commit) ||
		(binding.event !== "push" && binding.event !== "workflow_dispatch") ||
		!Number.isSafeInteger(binding.sequence) || binding.sequence < 1 ||
		!artifact || artifact.repository !== MISSION_REPOSITORY ||
		!POSITIVE_ID.test(artifact.artifactId) || artifact.runId !== source.runId ||
		!artifact.artifactName || artifact.artifactName.length > 180 ||
		!HEX64.test(artifact.archiveSha256) ||
		artifact.digestScope !== "github-artifact-archive")
		reject("historical prefix sidecar binding is invalid");
}
function sidecarKey(binding: Binding): Buffer {
	return Buffer.from(hkdfSync("sha256", binding.key,
		Buffer.from(binding.seedDigest, "hex"), "mul-pis-historical-prefix-sidecar-v1", 32));
}
function aad(binding: Binding, index: number): Buffer {
	return Buffer.from(JSON.stringify([MISSION_ID, MISSION_REPOSITORY, binding.seedDigest,
		binding.source, binding.event, binding.priorCarryEnvelopeSha256,
		binding.artifact, binding.sequence, index]), "utf8");
}
function appendChain(chain: ReturnType<typeof createHash>, bytes: Buffer): void {
	const length = Buffer.allocUnsafe(4);
	length.writeUInt32BE(bytes.length);
	chain.update(length).update(bytes);
}
export function historicalPrefixSidecarName(source: Pick<HistoricalPrefixSidecarSource,
	"runId" | "runAttempt">, sequence: number, index: number): string {
	if (!POSITIVE_ID.test(source.runId) || !Number.isSafeInteger(source.runAttempt) ||
		source.runAttempt < 1 || !Number.isSafeInteger(sequence) || sequence < 1 ||
		!Number.isSafeInteger(index) || index < 0)
		reject("historical prefix sidecar name is invalid");
	return `ledger-incremental-prefix-${source.runId}-${source.runAttempt}-${sequence}` +
		`.part-${String(index).padStart(8, "0")}.enc`;
}
export function isHistoricalPrefixSidecarName(name: string): boolean {
	return /^ledger-incremental-prefix-[1-9][0-9]{0,17}-[1-9][0-9]*-[1-9][0-9]*\.part-[0-9]{8}\.enc$/.test(name);
}
export function validHistoricalPrefixSidecarManifest(value: unknown):
	value is HistoricalPrefixSidecarManifest {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const manifest = value as Record<string, unknown>;
	return Object.keys(manifest).sort().join("|") === ["version", "format", "segmentCount",
		"plaintextBytes", "plaintextSha256", "ciphertextChainSha256"].sort().join("|") &&
		manifest.version === 1 && manifest.format === FORMAT &&
		Number.isSafeInteger(manifest.plaintextBytes) && Number(manifest.plaintextBytes) > 0 &&
		Number(manifest.plaintextBytes) <= PREFIX_LOGICAL_BYTES &&
		Number.isSafeInteger(manifest.segmentCount) &&
		Number(manifest.segmentCount) ===
			Math.ceil(Number(manifest.plaintextBytes) / PREFIX_SIDECAR_RAW_BYTES) &&
		typeof manifest.plaintextSha256 === "string" && HEX64.test(manifest.plaintextSha256) &&
		typeof manifest.ciphertextChainSha256 === "string" && HEX64.test(manifest.ciphertextChainSha256);
}
export function encodeHistoricalPrefixSidecars(input: Binding & { plaintext: Buffer }): Readonly<{
	manifest: HistoricalPrefixSidecarManifest; sidecars: ReadonlyArray<Readonly<{
		name: string; bytes: Buffer }>>;
}> {
	validBinding(input);
	if (!Buffer.isBuffer(input.plaintext) || input.plaintext.length < 1 ||
		input.plaintext.length > PREFIX_LOGICAL_BYTES)
		reject("historical prefix sidecar plaintext is invalid");
	const key = sidecarKey(input);
	const chain = createHash("sha256");
	const sidecars: Array<{ name: string; bytes: Buffer }> = [];
	for (let start = 0, index = 0; start < input.plaintext.length;
		start += PREFIX_SIDECAR_RAW_BYTES, index++) {
		const raw = input.plaintext.subarray(start, start + PREFIX_SIDECAR_RAW_BYTES);
		const nonce = randomBytes(12);
		const cipher = createCipheriv("aes-256-gcm", key, nonce);
		cipher.setAAD(aad(input, index));
		const bytes = Buffer.concat([nonce, cipher.update(raw), cipher.final(), cipher.getAuthTag()]);
		if (bytes.length > PREFIX_SIDECAR_FILE_BYTES) reject("historical prefix sidecar file exceeds bound");
		appendChain(chain, bytes);
		sidecars.push({ name: historicalPrefixSidecarName(input.source, input.sequence, index), bytes });
	}
	return { manifest: { version: 1, format: FORMAT, segmentCount: sidecars.length,
		plaintextBytes: input.plaintext.length, plaintextSha256: sha256(input.plaintext),
		ciphertextChainSha256: chain.digest("hex") }, sidecars };
}
export function decodeHistoricalPrefixSidecars(input: Binding & {
	manifest: unknown; load: (name: string) => Buffer;
}): Buffer {
	validBinding(input);
	if (!validHistoricalPrefixSidecarManifest(input.manifest))
		reject("historical prefix sidecar manifest is invalid");
	const manifest = input.manifest;
	const key = sidecarKey(input);
	const chain = createHash("sha256");
	const rawHash = createHash("sha256");
	const parts: Buffer[] = [];
	let total = 0;
	for (let index = 0; index < manifest.segmentCount; index++) {
		let bytes: Buffer;
		try { bytes = input.load(historicalPrefixSidecarName(input.source, input.sequence, index)); }
		catch { return reject("historical prefix sidecar is unavailable"); }
		const expectedLength = Math.min(PREFIX_SIDECAR_RAW_BYTES,
			manifest.plaintextBytes - index * PREFIX_SIDECAR_RAW_BYTES);
		if (!Buffer.isBuffer(bytes) || bytes.length !== expectedLength + 28)
			reject("historical prefix sidecar size is invalid");
		appendChain(chain, bytes);
		let raw: Buffer;
		try {
			const decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
			decipher.setAAD(aad(input, index));
			decipher.setAuthTag(bytes.subarray(bytes.length - 16));
			raw = Buffer.concat([decipher.update(bytes.subarray(12, -16)), decipher.final()]);
		} catch { return reject("historical prefix sidecar authentication failed"); }
		if (raw.length !== expectedLength) reject("historical prefix sidecar expanded length is invalid");
		parts.push(raw);
		rawHash.update(raw);
		total += raw.length;
	}
	if (total !== manifest.plaintextBytes ||
		chain.digest("hex") !== manifest.ciphertextChainSha256 ||
		rawHash.digest("hex") !== manifest.plaintextSha256)
		reject("historical prefix sidecar stream digest is invalid");
	return Buffer.concat(parts, total);
}
