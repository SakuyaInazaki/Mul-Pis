/** Bounded, byte-exact outer transport for encrypted private artifact files.
 * The multipart index is a locator; inner mission AEAD remains the authority.
 * Every part artifact is uploaded before the original-name index artifact.
 */
import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from "node:crypto";
import { HarnessError } from "../types.ts";
import { MISSION_ID, MISSION_REPOSITORY } from "./signed-mission-ledger.ts";

export const ARTIFACT_PARTITION_PAYLOAD_BYTES = 16 * 1024 * 1024;
export const MAX_ARTIFACT_PARTITION_STREAM_BYTES = 255 * 1024 * 1024;
export const MAX_ARTIFACT_PARTITION_MANIFEST_BYTES = 512 * 1024;
export const MAX_ARTIFACT_PARTITION_CHUNKS = Math.ceil(
	MAX_ARTIFACT_PARTITION_STREAM_BYTES / ARTIFACT_PARTITION_PAYLOAD_BYTES);
export const ARTIFACT_PARTITION_MANIFEST_FILE = "private-artifact-transport.enc.json";
const HEX64 = /^[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const ID = /^[1-9][0-9]{0,17}$/;
const openedPartitionManifests = new WeakSet<object>();

export type ArtifactTransportSource = Readonly<{
	repository: typeof MISSION_REPOSITORY; runId: string; runAttempt: number;
	commit: string; event: "push" | "workflow_dispatch";
}>;
export type ArtifactPartitionFile = Readonly<{
	name: string; offset: number; length: number; sha256: string;
}>;
export type ArtifactPartitionChunk = Readonly<{
	index: number; artifactName: string; fileName: string;
	bytes: Buffer; byteLength: number; sha256: string;
}>;
export type PreparedArtifactPartition = Readonly<{
	source: ArtifactTransportSource; artifactName: string;
	streamBytes: number; streamSha256: string;
	files: readonly ArtifactPartitionFile[];
	chunks: readonly ArtifactPartitionChunk[];
}>;
export type ArtifactPartitionManifestV1 = Readonly<{
	version: 1; kind: "mul-pis-private-artifact-multipart";
	source: ArtifactTransportSource; artifactName: string;
	streamBytes: number; streamSha256: string;
	files: readonly ArtifactPartitionFile[];
	chunks: ReadonlyArray<Readonly<{
		index: number; artifactName: string; fileName: string;
		byteLength: number; sha256: string; artifactId: string; archiveSha256: string;
	}>>;
}>;
export type ArtifactPartUpload = Readonly<{
	index: number; artifactId: string; archiveSha256: string;
}>;
export type SealedPartitionManifestV1 = Readonly<{
	version: 1; kind: "mul-pis-encrypted-artifact-transport-index";
	source: ArtifactTransportSource; artifactName: string; seedDigest: string;
	nonceB64: string; ciphertextB64: string; tagB64: string;
}>;

function reject(reason: string): never { throw new HarnessError("runner.private-artifact-partition", reason); }
function hash(value: Buffer): string { return createHash("sha256").update(value).digest("hex"); }
function base64(value: unknown, maxBytes: number): Buffer {
	if (typeof value !== "string" || !value.length || value.length % 4 !== 0 ||
		value.length > Math.ceil(maxBytes * 4 / 3) + 4 ||
		!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) reject("artifact index encoded field is invalid");
	const bytes = Buffer.from(value, "base64");
	if (bytes.length > maxBytes || bytes.toString("base64") !== value)
		reject("artifact index encoded field is invalid");
	return bytes;
}
function record(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function keys(value: Record<string, unknown>, expected: readonly string[]): boolean {
	return Object.keys(value).sort().join("|") === [...expected].sort().join("|");
}
function validSource(value: unknown): value is ArtifactTransportSource {
	return record(value) && keys(value, ["repository", "runId", "runAttempt", "commit", "event"]) &&
		value.repository === MISSION_REPOSITORY && typeof value.runId === "string" && ID.test(value.runId) &&
		Number.isSafeInteger(value.runAttempt) && Number(value.runAttempt) > 0 &&
		typeof value.commit === "string" && COMMIT.test(value.commit) &&
		(value.event === "push" || value.event === "workflow_dispatch");
}
function sameSource(left: ArtifactTransportSource, right: ArtifactTransportSource): boolean {
	return left.repository === right.repository && left.runId === right.runId &&
		left.runAttempt === right.runAttempt && left.commit === right.commit &&
		left.event === right.event;
}
function manifestKey(missionKey: Buffer, seedDigest: string): Buffer {
	if (!Buffer.isBuffer(missionKey) || missionKey.length !== 32 || !HEX64.test(seedDigest))
		reject("artifact index mission key or seed digest is invalid");
	return Buffer.from(hkdfSync("sha256", missionKey, Buffer.from(seedDigest, "hex"),
		"mul-pis-private-artifact-transport-index-v1", 32));
}
function manifestAad(source: ArtifactTransportSource, artifactName: string,
	seedDigest: string): Buffer {
	return Buffer.from(JSON.stringify(["mul-pis-encrypted-artifact-transport-index-v1",
		MISSION_ID, MISSION_REPOSITORY, seedDigest,
		[source.repository, source.runId, source.runAttempt, source.commit, source.event],
		artifactName]), "utf8");
}
function validArtifactName(name: unknown, source: ArtifactTransportSource): name is string {
	return typeof name === "string" && name.length < 180 &&
		(name === "confidential-mission-carry" ||
			new RegExp(`^confidential-mission-prefix-${source.runId}-${source.runAttempt}-[1-9][0-9]*$`)
				.test(name));
}
export function validArtifactPartitionFileName(name: unknown): name is string {
	return typeof name === "string" && (
		name === "ledger-continuation.enc.json" ||
		name === "incremental-control-prefix.json" ||
		/^ledger-continuation\.part-[0-9]{8}\.enc$/.test(name) ||
		/^ledger-incremental-prefix-[1-9][0-9]{0,17}-[1-9][0-9]*-[1-9][0-9]*\.part-[0-9]{8}\.enc$/.test(name));
}
export function artifactPartitionPartName(artifactName: string, index: number): string {
	if (!Number.isSafeInteger(index) || index < 0 || index >= MAX_ARTIFACT_PARTITION_CHUNKS ||
		!artifactName || artifactName.length >= 180)
		reject("artifact partition part index or name is invalid");
	return `${artifactName}-part-${String(index).padStart(8, "0")}`;
}
export function artifactPartitionPartFile(index: number): string {
	if (!Number.isSafeInteger(index) || index < 0 || index >= MAX_ARTIFACT_PARTITION_CHUNKS)
		reject("artifact partition part file index is invalid");
	return `private-artifact.part-${String(index).padStart(8, "0")}.bin`;
}
export function partitionEncryptedFiles(input: Readonly<{
	source: ArtifactTransportSource; artifactName: string;
	files: Readonly<Record<string, Buffer>>;
}>): PreparedArtifactPartition {
	if (!validSource(input.source) || !validArtifactName(input.artifactName, input.source) ||
		!record(input.files)) reject("artifact partition source or files are invalid");
	const names = Object.keys(input.files).sort();
	if (!names.length || names.some(name => !validArtifactPartitionFileName(name) ||
		!Buffer.isBuffer(input.files[name]) || input.files[name].length < 1))
		reject("artifact partition file set is invalid");
	let length = 0;
	const files: ArtifactPartitionFile[] = [];
	const pieces: Buffer[] = [];
	for (const name of names) {
		const bytes = input.files[name];
		if (bytes.length > MAX_ARTIFACT_PARTITION_STREAM_BYTES - length)
			reject("artifact partition physical stream bound is exceeded");
		files.push({ name, offset: length, length: bytes.length, sha256: hash(bytes) });
		pieces.push(bytes);
		length += bytes.length;
	}
	const stream = Buffer.concat(pieces, length);
	const chunks: ArtifactPartitionChunk[] = [];
	for (let start = 0, index = 0; start < stream.length;
		start += ARTIFACT_PARTITION_PAYLOAD_BYTES, index++) {
		const bytes = Buffer.from(stream.subarray(start,
			Math.min(start + ARTIFACT_PARTITION_PAYLOAD_BYTES, stream.length)));
		chunks.push({ index, artifactName: artifactPartitionPartName(input.artifactName, index),
			fileName: artifactPartitionPartFile(index), bytes,
			byteLength: bytes.length, sha256: hash(bytes) });
	}
	return { source: { ...input.source }, artifactName: input.artifactName,
		streamBytes: stream.length, streamSha256: hash(stream), files, chunks };
}
export function finalizePartitionManifest(prepared: PreparedArtifactPartition,
	uploads: readonly ArtifactPartUpload[]): ArtifactPartitionManifestV1 {
	if (uploads.length !== prepared.chunks.length ||
		new Set(uploads.map(row => row.index)).size !== uploads.length ||
		uploads.some(row => !Number.isSafeInteger(row.index) || row.index < 0 ||
			!ID.test(row.artifactId) || !HEX64.test(row.archiveSha256)) ||
		new Set(uploads.map(row => row.artifactId)).size !== uploads.length)
		reject("artifact partition uploads are incomplete or ambiguous");
	const byIndex = new Map(uploads.map(row => [row.index, row]));
	const manifest: ArtifactPartitionManifestV1 = {
		version: 1, kind: "mul-pis-private-artifact-multipart", source: prepared.source,
		artifactName: prepared.artifactName, streamBytes: prepared.streamBytes,
		streamSha256: prepared.streamSha256, files: prepared.files,
		chunks: prepared.chunks.map(chunk => {
			const uploaded = byIndex.get(chunk.index);
			if (!uploaded) reject("artifact partition upload is missing");
			return { index: chunk.index, artifactName: chunk.artifactName,
				fileName: chunk.fileName, byteLength: chunk.byteLength, sha256: chunk.sha256,
				artifactId: uploaded.artifactId, archiveSha256: uploaded.archiveSha256 };
		})
	};
	if (!validPartitionManifest(manifest, prepared.source, prepared.artifactName))
		reject("artifact partition manifest is invalid");
	return manifest;
}
export function sealPartitionManifest(input: Readonly<{
	manifest: ArtifactPartitionManifestV1; missionKey: Buffer; seedDigest: string;
}>): string {
	const manifest = input.manifest;
	if (!validPartitionManifest(manifest, manifest.source, manifest.artifactName))
		reject("artifact index manifest is invalid before sealing");
	const key = manifestKey(input.missionKey, input.seedDigest);
	const nonce = randomBytes(12);
	const cipher = createCipheriv("aes-256-gcm", key, nonce);
	cipher.setAAD(manifestAad(manifest.source, manifest.artifactName, input.seedDigest));
	const ciphertext = Buffer.concat([cipher.update(JSON.stringify(manifest), "utf8"), cipher.final()]);
	const outer: SealedPartitionManifestV1 = { version: 1,
		kind: "mul-pis-encrypted-artifact-transport-index",
		source: manifest.source, artifactName: manifest.artifactName,
		seedDigest: input.seedDigest, nonceB64: nonce.toString("base64"),
		ciphertextB64: ciphertext.toString("base64"), tagB64: cipher.getAuthTag().toString("base64") };
	return JSON.stringify(outer);
}
export function openPartitionManifest(input: Readonly<{
	raw: string; missionKey: Buffer; seedDigest: string;
	expectedSource: ArtifactTransportSource; expectedArtifactName: string;
}>): ArtifactPartitionManifestV1 {
	if (typeof input.raw !== "string" ||
		Buffer.byteLength(input.raw, "utf8") > MAX_ARTIFACT_PARTITION_MANIFEST_BYTES * 2 ||
		!validSource(input.expectedSource) ||
		!validArtifactName(input.expectedArtifactName, input.expectedSource))
		reject("artifact index source or size is invalid");
	let parsed: unknown;
	try { parsed = JSON.parse(input.raw); }
	catch { return reject("artifact index JSON is invalid"); }
	if (!record(parsed) || !keys(parsed, ["version", "kind", "source", "artifactName",
		"seedDigest", "nonceB64", "ciphertextB64", "tagB64"]) ||
		parsed.version !== 1 || parsed.kind !== "mul-pis-encrypted-artifact-transport-index" ||
		!validSource(parsed.source) || !sameSource(parsed.source, input.expectedSource) ||
		parsed.artifactName !== input.expectedArtifactName || parsed.seedDigest !== input.seedDigest)
		reject("artifact index outer source is invalid");
	const nonce = base64(parsed.nonceB64, 12);
	const ciphertext = base64(parsed.ciphertextB64, MAX_ARTIFACT_PARTITION_MANIFEST_BYTES);
	const tag = base64(parsed.tagB64, 16);
	if (nonce.length !== 12 || tag.length !== 16)
		reject("artifact index nonce or tag is invalid");
	const key = manifestKey(input.missionKey, input.seedDigest);
	let plaintext: Buffer;
	try {
		const decipher = createDecipheriv("aes-256-gcm", key, nonce);
		decipher.setAAD(manifestAad(input.expectedSource, input.expectedArtifactName, input.seedDigest));
		decipher.setAuthTag(tag);
		plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
	} catch { return reject("artifact index authentication failed"); }
	let manifest: unknown;
	try { manifest = JSON.parse(plaintext.toString("utf8")); }
	catch { return reject("artifact index plaintext is invalid"); }
	if (!validPartitionManifest(manifest, input.expectedSource, input.expectedArtifactName))
		reject("artifact index fields are invalid");
	openedPartitionManifests.add(manifest);
	return manifest;
}
export function isOpenedPartitionManifest(value: unknown): value is ArtifactPartitionManifestV1 {
	return Boolean(value) && typeof value === "object" &&
		openedPartitionManifests.has(value as object);
}
/** The caller must supply a stable, complete live GitHub artifact census for
 * this run. Part IDs and archive digests are checked before any part download. */
export function validatePartitionArtifactCensus(manifest: ArtifactPartitionManifestV1,
	artifacts: readonly unknown[]): void {
	if (!validPartitionManifest(manifest, manifest.source, manifest.artifactName) ||
		!Array.isArray(artifacts)) reject("artifact index or census is invalid");
	const claimedNames = new Set(manifest.chunks.map(chunk => chunk.artifactName));
	for (const artifact of artifacts) {
		if (!record(artifact) || typeof artifact.name !== "string")
			reject("artifact census row is invalid");
		if (artifact.name.startsWith(`${manifest.artifactName}-part-`) &&
			!claimedNames.has(artifact.name))
			reject("artifact census has an unclaimed partition part");
	}
	for (const part of manifest.chunks) {
		const matches = artifacts.filter(row => record(row) &&
			row.name === part.artifactName && row.id === Number(part.artifactId));
		if (matches.length !== 1) reject("artifact partition part is unavailable or ambiguous");
		const row = matches[0];
		if (!record(row) || row.expired !== false ||
			row.digest !== `sha256:${part.archiveSha256}` ||
			!record(row.workflow_run) ||
			row.workflow_run.id !== Number(manifest.source.runId) ||
			row.workflow_run.head_sha !== manifest.source.commit ||
			artifacts.filter(candidate => record(candidate) &&
				candidate.name === part.artifactName).length !== 1)
			reject("artifact partition part source or archive digest is invalid");
	}
}
export function validPartitionManifest(value: unknown, expectedSource: ArtifactTransportSource,
	expectedArtifactName: string): value is ArtifactPartitionManifestV1 {
	if (!validSource(expectedSource) || !validArtifactName(expectedArtifactName, expectedSource) ||
		!record(value) || !keys(value, ["version", "kind", "source", "artifactName",
			"streamBytes", "streamSha256", "files", "chunks"]) ||
		value.version !== 1 || value.kind !== "mul-pis-private-artifact-multipart" ||
		!validSource(value.source) || !sameSource(value.source, expectedSource) ||
		value.artifactName !== expectedArtifactName ||
		!Number.isSafeInteger(value.streamBytes) || Number(value.streamBytes) < 1 ||
		Number(value.streamBytes) > MAX_ARTIFACT_PARTITION_STREAM_BYTES ||
		typeof value.streamSha256 !== "string" || !HEX64.test(value.streamSha256) ||
		!Array.isArray(value.files) || !value.files.length ||
		!Array.isArray(value.chunks) || !value.chunks.length ||
		value.chunks.length > MAX_ARTIFACT_PARTITION_CHUNKS ||
		Buffer.byteLength(JSON.stringify(value), "utf8") > MAX_ARTIFACT_PARTITION_MANIFEST_BYTES)
		return false;
	let offset = 0;
	let previousName = "";
	for (const file of value.files) {
		if (!record(file) || !keys(file, ["name", "offset", "length", "sha256"]) ||
			!validArtifactPartitionFileName(file.name) || file.name <= previousName ||
			file.offset !== offset || !Number.isSafeInteger(file.length) || Number(file.length) < 1 ||
			typeof file.sha256 !== "string" || !HEX64.test(file.sha256)) return false;
		previousName = file.name;
		offset += Number(file.length);
	}
	if (offset !== value.streamBytes) return false;
	let chunkBytes = 0;
	const ids = new Set<string>();
	for (let index = 0; index < value.chunks.length; index++) {
		const chunk = value.chunks[index];
		if (!record(chunk) || !keys(chunk, ["index", "artifactName", "fileName",
			"byteLength", "sha256", "artifactId", "archiveSha256"]) ||
			chunk.index !== index ||
			chunk.artifactName !== artifactPartitionPartName(expectedArtifactName, index) ||
			chunk.fileName !== artifactPartitionPartFile(index) ||
			!Number.isSafeInteger(chunk.byteLength) || Number(chunk.byteLength) < 1 ||
			Number(chunk.byteLength) > ARTIFACT_PARTITION_PAYLOAD_BYTES ||
			(index < value.chunks.length - 1 &&
				chunk.byteLength !== ARTIFACT_PARTITION_PAYLOAD_BYTES) ||
			typeof chunk.sha256 !== "string" || !HEX64.test(chunk.sha256) ||
			typeof chunk.artifactId !== "string" || !ID.test(chunk.artifactId) ||
			ids.has(chunk.artifactId) ||
			typeof chunk.archiveSha256 !== "string" || !HEX64.test(chunk.archiveSha256))
			return false;
		ids.add(chunk.artifactId);
		chunkBytes += Number(chunk.byteLength);
	}
	return chunkBytes === value.streamBytes;
}
export function restorePartitionFiles(manifest: ArtifactPartitionManifestV1,
	orderedChunkBytes: readonly Buffer[], expectedSource: ArtifactTransportSource,
	expectedArtifactName: string): Readonly<Record<string, Buffer>> {
	if (!validPartitionManifest(manifest, expectedSource, expectedArtifactName) ||
		orderedChunkBytes.length !== manifest.chunks.length)
		reject("artifact partition restoration manifest is invalid");
	for (let index = 0; index < orderedChunkBytes.length; index++) {
		const bytes = orderedChunkBytes[index];
		if (!Buffer.isBuffer(bytes) || bytes.length !== manifest.chunks[index].byteLength ||
			hash(bytes) !== manifest.chunks[index].sha256)
			reject("artifact partition chunk bytes differ from the manifest");
	}
	const stream = Buffer.concat(orderedChunkBytes, manifest.streamBytes);
	if (hash(stream) !== manifest.streamSha256)
		reject("artifact partition stream digest differs from the manifest");
	const files: Record<string, Buffer> = Object.create(null) as Record<string, Buffer>;
	for (const file of manifest.files) {
		const bytes = Buffer.from(stream.subarray(file.offset, file.offset + file.length));
		if (hash(bytes) !== file.sha256)
			reject("artifact partition file digest differs from the manifest");
		files[file.name] = bytes;
	}
	return files;
}
