/** Bounded, authenticated transport for a multi-part checkpoint byte stream.
 * The manifest must itself be sealed in the mission carry envelope. Sidecars are
 * ciphertext only; every new run republishes the complete current snapshot.
 */
import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from "node:crypto";
import { deflateRawSync, inflateRawSync } from "node:zlib";
import { HarnessError } from "../types.ts";
import { MISSION_ID, MISSION_REPOSITORY } from "./signed-mission-ledger.ts";

export const CARRY_SEGMENT_RAW_BYTES = 1024 * 1024;
export const CARRY_SEGMENT_FILE_BYTES = CARRY_SEGMENT_RAW_BYTES + 4096;
/** Existing private result transport's per-file ceiling. Exceeding it suspends
 * this transport and must not be interpreted as a research or fee stop. */
export const CARRY_LOGICAL_BYTES = 64 * 1024 * 1024;
const FORMAT = "deflate-raw-aes-256-gcm-segments-v1";
const SHA256 = /^[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;

export type CarrySegmentSource = Readonly<{
	runId: string; runAttempt: number; runNumber: number; commit: string;
}>;
export type CarrySidecarManifestV1 = Readonly<{
	version: 1; format: typeof FORMAT; segmentCount: number;
	plaintextBytes: number; plaintextSha256: string; ciphertextChainSha256: string;
}>;
export type CarrySidecar = Readonly<{ name: string; bytes: Buffer }>;
type Binding = Readonly<{
	key: Buffer; seedDigest: string; parentDigest: string; source: CarrySegmentSource;
}>;

function reject(message: string): never {
	throw new HarnessError("runner.carry-sidecar", message);
}
function sha256(data: Buffer): string { return createHash("sha256").update(data).digest("hex"); }
function validBinding(input: Binding): void {
	if (!Buffer.isBuffer(input.key) || input.key.length !== 32 ||
		!SHA256.test(input.seedDigest) || !SHA256.test(input.parentDigest) ||
		!input.source || !/^[1-9][0-9]{0,17}$/.test(input.source.runId) ||
		!Number.isSafeInteger(input.source.runAttempt) || input.source.runAttempt < 1 ||
		!Number.isSafeInteger(input.source.runNumber) || input.source.runNumber < 1 ||
		!COMMIT.test(input.source.commit)) reject("sidecar binding is invalid");
}
function sidecarKey(input: Binding): Buffer {
	return Buffer.from(hkdfSync("sha256", input.key, Buffer.from(input.seedDigest, "hex"),
		"mul-pis-ledger-sidecar-v1", 32));
}
function aad(input: Binding, index: number): Buffer {
	return Buffer.from(JSON.stringify([MISSION_ID, MISSION_REPOSITORY, input.seedDigest,
		input.parentDigest, input.source, index]), "utf8");
}
function appendChain(chain: ReturnType<typeof createHash>, bytes: Buffer): void {
	const length = Buffer.allocUnsafe(4);
	length.writeUInt32BE(bytes.length);
	chain.update(length).update(bytes);
}

export function carrySidecarName(index: number): string {
	if (!Number.isSafeInteger(index) || index < 0) reject("sidecar index is invalid");
	return `ledger-continuation.part-${String(index).padStart(8, "0")}.enc`;
}

export function validCarrySidecarManifest(value: unknown): value is CarrySidecarManifestV1 {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const manifest = value as Record<string, unknown>;
	return Object.keys(manifest).sort().join("|") === ["version", "format", "segmentCount",
		"plaintextBytes", "plaintextSha256", "ciphertextChainSha256"].sort().join("|") &&
		manifest.version === 1 && manifest.format === FORMAT &&
		Number.isSafeInteger(manifest.plaintextBytes) && Number(manifest.plaintextBytes) > 0 &&
		Number(manifest.plaintextBytes) <= CARRY_LOGICAL_BYTES &&
		Number.isSafeInteger(manifest.segmentCount) &&
		Number(manifest.segmentCount) === Math.ceil(Number(manifest.plaintextBytes) / CARRY_SEGMENT_RAW_BYTES) &&
		typeof manifest.plaintextSha256 === "string" && SHA256.test(manifest.plaintextSha256) &&
		typeof manifest.ciphertextChainSha256 === "string" && SHA256.test(manifest.ciphertextChainSha256);
}

export function encodeCarrySidecars(input: Binding & { plaintext: Buffer }): Readonly<{
	manifest: CarrySidecarManifestV1; sidecars: readonly CarrySidecar[];
}> {
	validBinding(input);
	if (!Buffer.isBuffer(input.plaintext) || input.plaintext.length === 0 ||
		input.plaintext.length > CARRY_LOGICAL_BYTES)
		reject("sidecar plaintext is invalid");
	const key = sidecarKey(input);
	const chain = createHash("sha256");
	const sidecars: CarrySidecar[] = [];
	for (let start = 0, index = 0; start < input.plaintext.length;
		start += CARRY_SEGMENT_RAW_BYTES, index++) {
		const raw = input.plaintext.subarray(start, start + CARRY_SEGMENT_RAW_BYTES);
		const compressed = deflateRawSync(raw);
		const nonce = randomBytes(12);
		const cipher = createCipheriv("aes-256-gcm", key, nonce);
		cipher.setAAD(aad(input, index));
		const bytes = Buffer.concat([nonce, cipher.update(compressed), cipher.final(), cipher.getAuthTag()]);
		if (bytes.length > CARRY_SEGMENT_FILE_BYTES) reject("sidecar file exceeds bound");
		appendChain(chain, bytes);
		sidecars.push({ name: carrySidecarName(index), bytes });
	}
	return { manifest: { version: 1, format: FORMAT, segmentCount: sidecars.length,
		plaintextBytes: input.plaintext.length, plaintextSha256: sha256(input.plaintext),
		ciphertextChainSha256: chain.digest("hex") }, sidecars };
}

export function decodeCarrySidecars(input: Binding & {
	manifest: unknown; load: (name: string) => Buffer;
}): Buffer {
	validBinding(input);
	if (!validCarrySidecarManifest(input.manifest)) reject("sidecar manifest is invalid");
	const manifest = input.manifest;
	const key = sidecarKey(input);
	const chain = createHash("sha256");
	const plaintextHash = createHash("sha256");
	const parts: Buffer[] = [];
	let total = 0;
	for (let index = 0; index < manifest.segmentCount; index++) {
		let bytes: Buffer;
		try { bytes = input.load(carrySidecarName(index)); }
		catch { return reject("required sidecar is unavailable"); }
		if (!Buffer.isBuffer(bytes) || bytes.length < 29 ||
			bytes.length > CARRY_SEGMENT_FILE_BYTES) reject("sidecar file bound is invalid");
		appendChain(chain, bytes);
		let compressed: Buffer;
		try {
			const decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
			decipher.setAAD(aad(input, index));
			decipher.setAuthTag(bytes.subarray(bytes.length - 16));
			compressed = Buffer.concat([decipher.update(bytes.subarray(12, -16)), decipher.final()]);
		} catch { return reject("sidecar authentication failed"); }
		let raw: Buffer;
		try { raw = inflateRawSync(compressed, { maxOutputLength: CARRY_SEGMENT_RAW_BYTES }); }
		catch { return reject("sidecar decompression failed"); }
		const expectedLength = Math.min(CARRY_SEGMENT_RAW_BYTES,
			manifest.plaintextBytes - index * CARRY_SEGMENT_RAW_BYTES);
		if (raw.length !== expectedLength) reject("sidecar expanded length is invalid");
		parts.push(raw);
		plaintextHash.update(raw);
		total += raw.length;
	}
	if (total !== manifest.plaintextBytes || chain.digest("hex") !== manifest.ciphertextChainSha256 ||
		plaintextHash.digest("hex") !== manifest.plaintextSha256)
		reject("sidecar stream digest is invalid");
	return Buffer.concat(parts, total);
}
