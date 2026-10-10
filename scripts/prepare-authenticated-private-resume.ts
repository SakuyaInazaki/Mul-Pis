/**
 * Private host bridge. In --connector-stdio mode a caller handles each printed
 * public GitHub GET through its existing read-only connector. Only the final
 * public commit descriptor may be copied into a GitHub create-commit call.
 * No ref update or model request occurs here.
 */
import { createInterface } from "node:readline";
import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, open, readFile, realpath } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";
import { MissionHostPreparationError, prepareAuthenticatedResumeRequest } from "../src/runner/mission-host-adapter.ts";
import { MissionResumeJournal } from "../src/runner/mission-resume-journal.ts";
import { PeriodicPrefixRecoveryError,
	CARRY_FILE_NAME, type CarryArtifactPayload, type CurrentMissionRun } from
	"../src/runner/ledger-continuation.ts";
import { INCREMENTAL_CHECKPOINT_FILE } from "../src/runner/incremental-private-checkpoint.ts";
import { PREFIX_SIDECAR_FILE_BYTES, historicalPrefixSidecarName,
	isHistoricalPrefixSidecarName } from "../src/runner/incremental-prefix-sidecar-codec.ts";
import { CARRY_SEGMENT_FILE_BYTES, carrySidecarName } from
	"../src/runner/carry-sidecar-codec.ts";
import { ARTIFACT_PARTITION_MANIFEST_FILE, ARTIFACT_PARTITION_PAYLOAD_BYTES,
	MAX_ARTIFACT_PARTITION_MANIFEST_BYTES, openPartitionManifest,
	restorePartitionFiles, validatePartitionArtifactCensus,
	type ArtifactTransportSource, type ArtifactPartitionManifestV1 } from
	"../src/runner/private-artifact-partition.ts";
import { HarnessError } from "../src/types.ts";

type Args = { source: string; seed: string; publicKey: string;
	journalDir: string; outputPrivate: string; readOnly: boolean; recoverReserved: boolean;
	repairPlanPrivate?: string;
	interruptedSourceReviewPrivate?: string; resultOnlyRepairReviewPrivate?: string;
	terminalPrefixSourceReviewPrivate?: string;
	providerAvailabilityReceiptPrivate?: string;
	linkedUnknownDeliveryOldControlCommit?: string;
	unobservedControlSourceReviewPrivate?: string };
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
class PrivateBridgeError extends Error {
	readonly reasonCode: string;
	readonly osErrorCode?: string;
	readonly preparationCause?: unknown;
	constructor(reasonCode: string, cause?: unknown) {
		super(reasonCode); this.reasonCode = reasonCode;
		this.osErrorCode = privateOsErrorCode(cause);
		if (reasonCode === "result-envelope-exceeds-connector-capacity")
			this.preparationCause = cause;
	}
}
const SAFE_OS_CODES = ["EACCES", "EPERM", "ENOSPC", "EDQUOT", "EROFS", "EIO",
	"EMFILE", "ENFILE", "ENOENT", "ENOTDIR", "EEXIST"] as const;
function privateOsErrorCode(error: unknown): typeof SAFE_OS_CODES[number] | undefined {
	try {
		const code = error && (typeof error === "object" || typeof error === "function") ?
			(error as { code?: unknown }).code : undefined;
		return typeof code === "string" && SAFE_OS_CODES.some(value => value === code) ?
			code as typeof SAFE_OS_CODES[number] : undefined;
	} catch { return undefined; }
}
type ArtifactSidecarFile = { name: string; file: string; sha256: string };
type ArtifactFileReply = { file: string; sha256: string;
	name?: string;
	archiveSha256?: string;
	archiveFile?: string;
	sidecars?: ArtifactSidecarFile[];
	prefix?: ArtifactSidecarFile };
const maxLegacyZipEntries = 65;
const RESULT_ARCHIVE_MAX_BYTES = 132 * 1024 * 1024;
const RESULT_MEMBER_NAME = "private-campaign-outcome.enc.json";
const maxSidecarTextBytes = Math.ceil(CARRY_SEGMENT_FILE_BYTES * 4 / 3) + 4;
const maxPrefixSidecarTextBytes = Math.ceil(PREFIX_SIDECAR_FILE_BYTES * 4 / 3) + 4;
function privateFileReference<T>(value: T): value is T & {
	file: string; sha256: string; name?: unknown } {
	return Boolean(value) && typeof value === "object" &&
		typeof (value as { file?: unknown }).file === "string" &&
		path.isAbsolute((value as { file: string }).file) &&
		typeof (value as { sha256?: unknown }).sha256 === "string" &&
		/^[0-9a-f]{64}$/.test((value as { sha256: string }).sha256);
}
async function verifiedPrivateBytes(reference: { file: string; sha256: string }, max: number,
	overflowCode?: string): Promise<Buffer> {
	const handle = await open(reference.file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
	try {
		const meta = await handle.stat();
		if (!meta.isFile() || (meta.mode & 0o077) !== 0 || meta.size < 1)
			throw new Error("artifact file is not private and regular");
		if (meta.size > max && overflowCode)
			throw new PrivateBridgeError(overflowCode);
		if (meta.size > max)
			throw new Error("artifact file is not private and regular");
		const bytes = await handle.readFile();
		if (bytes.length !== meta.size ||
			createHash("sha256").update(bytes).digest("hex") !== reference.sha256)
			throw new Error("artifact file changed after connector verification");
		return bytes;
	} finally { await handle.close(); }
}

/** Inspect an already restored original GitHub ZIP. Its live archive SHA is
 * checked separately before calling this function. No path or claimed member
 * hash is authority for the encrypted result. */
export function exactResultArchiveMember(zip: Buffer): Buffer {
	const invalid = (): never => { throw new Error("original result archive layout is invalid"); };
	if (!Buffer.isBuffer(zip) || zip.length < 98 || zip.length > RESULT_ARCHIVE_MAX_BYTES)
		return invalid();
	const eocd = zip.length - 22;
	if (zip.readUInt32LE(eocd) !== 0x06054b50 || zip.readUInt16LE(eocd + 20) !== 0 ||
		zip.readUInt16LE(eocd + 4) !== 0 || zip.readUInt16LE(eocd + 6) !== 0 ||
		zip.readUInt16LE(eocd + 8) !== 1 || zip.readUInt16LE(eocd + 10) !== 1)
		return invalid();
	const directoryBytes = zip.readUInt32LE(eocd + 12);
	const directory = zip.readUInt32LE(eocd + 16);
	if (directory < 30 || directory + directoryBytes !== eocd ||
		directoryBytes < 46 || zip.readUInt32LE(directory) !== 0x02014b50)
		return invalid();
	const flags = zip.readUInt16LE(directory + 8), method = zip.readUInt16LE(directory + 10);
	const crc = zip.readUInt32LE(directory + 16);
	const packed = zip.readUInt32LE(directory + 20), unpacked = zip.readUInt32LE(directory + 24);
	const nameLength = zip.readUInt16LE(directory + 28);
	const extraLength = zip.readUInt16LE(directory + 30);
	const commentLength = zip.readUInt16LE(directory + 32);
	const localOffset = zip.readUInt32LE(directory + 42);
	const name = Buffer.from(RESULT_MEMBER_NAME, "utf8");
	if ((flags & ~(0x800 | 0x8)) !== 0 || ![0, 8].includes(method) ||
		packed < 1 || unpacked < 1 || packed > RESULT_ARCHIVE_MAX_BYTES ||
		unpacked > RESULT_ARCHIVE_MAX_BYTES ||
		nameLength !== name.length || directory + 46 + nameLength +
			extraLength + commentLength !== eocd ||
		!zip.subarray(directory + 46, directory + 46 + nameLength).equals(name) ||
		localOffset !== 0 || zip.readUInt32LE(0) !== 0x04034b50 ||
		zip.readUInt16LE(6) !== flags || zip.readUInt16LE(8) !== method ||
		zip.readUInt16LE(directory + 34) !== 0)
		return invalid();
	const localNameLength = zip.readUInt16LE(26);
	const localExtraLength = zip.readUInt16LE(28);
	const dataOffset = 30 + localNameLength + localExtraLength;
	const dataEnd = dataOffset + packed;
	if (localNameLength !== name.length || dataOffset > directory ||
		!zip.subarray(30, 30 + localNameLength).equals(name) || dataEnd > directory)
		return invalid();
	if (flags & 0x8) {
		const signed = dataEnd + 16 === directory &&
			zip.readUInt32LE(dataEnd) === 0x08074b50;
		const descriptor = dataEnd + (signed ? 4 : 0);
		if (descriptor + 12 !== directory || zip.readUInt32LE(descriptor) !== crc ||
			zip.readUInt32LE(descriptor + 4) !== packed ||
			zip.readUInt32LE(descriptor + 8) !== unpacked)
			return invalid();
	} else if (dataEnd !== directory || zip.readUInt32LE(14) !== crc ||
		zip.readUInt32LE(18) !== packed || zip.readUInt32LE(22) !== unpacked)
		return invalid();
	let member: Buffer;
	try { member = method === 0 ? Buffer.from(zip.subarray(dataOffset, dataEnd)) :
			inflateRawSync(zip.subarray(dataOffset, dataEnd),
				{ maxOutputLength: RESULT_ARCHIVE_MAX_BYTES }); }
	catch { return invalid(); }
	if (member.length !== unpacked) return invalid();
	return member;
}
function canonicalSidecarText(bytes: Buffer, maxCipherBytes = CARRY_SEGMENT_FILE_BYTES): string {
	const value = bytes.toString("utf8");
	if (Buffer.byteLength(value, "utf8") !== bytes.length || !value.length || value.length % 4 !== 0)
		throw new Error("artifact sidecar encoding is invalid");
	const paddingAt = value.indexOf("=");
	const dataEnd = paddingAt < 0 ? value.length : paddingAt;
	if (value.length - dataEnd > 2) throw new Error("artifact sidecar encoding is invalid");
	for (let index = 0; index < dataEnd; index++) {
		const code = value.charCodeAt(index);
		if (!((code >= 65 && code <= 90) || (code >= 97 && code <= 122) ||
			(code >= 48 && code <= 57) || code === 43 || code === 47))
			throw new Error("artifact sidecar encoding is invalid");
	}
	for (let index = dataEnd; index < value.length; index++)
		if (value.charCodeAt(index) !== 61) throw new Error("artifact sidecar encoding is invalid");
	const decoded = Buffer.from(value, "base64");
	if (decoded.length < 29 || decoded.length > maxCipherBytes ||
		decoded.toString("base64") !== value)
		throw new Error("artifact sidecar encoding is invalid");
	return value;
}
function validSidecarSet(names: readonly string[]): void {
	const main = names.filter(name => /^ledger-continuation\.part-[0-9]{8}\.enc$/.test(name));
	for (let index = 0; index < main.length; index++)
		if (!main.includes(carrySidecarName(index)))
			throw new Error("carry sidecar set is incomplete");
	const groups = new Map<string, { runId: string; runAttempt: number;
		sequence: number; names: string[] }>();
	for (const name of names) {
		if (main.includes(name)) continue;
		if (!isHistoricalPrefixSidecarName(name))
			throw new Error("historical prefix sidecar name is invalid");
		const match = /^ledger-incremental-prefix-([1-9][0-9]{0,17})-([1-9][0-9]*)-([1-9][0-9]*)\.part-[0-9]{8}\.enc$/.exec(name)!;
		const runAttempt = Number(match[2]), sequence = Number(match[3]);
		if (!Number.isSafeInteger(runAttempt) || !Number.isSafeInteger(sequence))
			throw new Error("historical prefix sidecar source is invalid");
		const key = `${match[1]}/${runAttempt}/${sequence}`;
		const group = groups.get(key) ?? { runId: match[1], runAttempt, sequence, names: [] };
		group.names.push(name); groups.set(key, group);
	}
	for (const group of groups.values())
		for (let index = 0; index < group.names.length; index++)
			if (!group.names.includes(historicalPrefixSidecarName(group, group.sequence, index)))
				throw new Error("historical prefix sidecar set is incomplete");
	// The ledger verifies every historical name against the exact authenticated
	// carry receipt and rejects any unclaimed sidecar after this transport check.
}
function restoredCarryPayload(files: Readonly<Record<string, Buffer>>,
	transportIndex: ArtifactPartitionManifestV1): CarryArtifactPayload {
	const names = Object.keys(files);
	const root = files[CARRY_FILE_NAME];
	const prefix = files[INCREMENTAL_CHECKPOINT_FILE];
	const text = (bytes: Buffer, maximum: number): string => {
		if (bytes.length < 1 || bytes.length > maximum)
			throw new Error("restored artifact file exceeds its physical boundary");
		return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	};
	if (!root) {
		if (!prefix || names.length !== 1)
			throw new Error("multipart prefix file set is invalid");
		return { incrementalControlPrefix: text(prefix, 64 * 1024 * 1024),
			transportIndex };
	}
	const outer = JSON.parse(text(root, 8 * 1024 * 1024)) as unknown;
	if (!outer || typeof outer !== "object" || Array.isArray(outer) ||
		Object.keys(outer).length !== 1 ||
		typeof (outer as { envelopeB64?: unknown }).envelopeB64 !== "string")
		throw new Error("restored carry root format is invalid");
	const sidecars: Record<string, string> = Object.create(null) as Record<string, string>;
	validSidecarSet(names.filter(name =>
		name !== CARRY_FILE_NAME && name !== INCREMENTAL_CHECKPOINT_FILE));
	for (const name of names) {
		if (name === CARRY_FILE_NAME || name === INCREMENTAL_CHECKPOINT_FILE) continue;
		sidecars[name] = canonicalSidecarText(files[name],
			isHistoricalPrefixSidecarName(name) ? PREFIX_SIDECAR_FILE_BYTES : CARRY_SEGMENT_FILE_BYTES);
	}
	return { envelopeB64: (outer as { envelopeB64: string }).envelopeB64,
		sidecars, ...(prefix ? { incrementalControlPrefix: text(prefix, 64 * 1024 * 1024) } : {}),
		transportIndex };
}
function underRepo(file: string): boolean {
	const relative = path.relative(repoRoot, file);
	return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) &&
		!path.isAbsolute(relative));
}
function parseArgs(values: string[]): Args {
	const option = new Map<string, string>();
	let connectorStdio = false;
	let readOnly = false;
	let recoverReserved = false;
	for (let i = 0; i < values.length; i++) {
		const name = values[i]!;
		if (name === "--connector-stdio") { connectorStdio = true; continue; }
		if (name === "--read-only") { readOnly = true; continue; }
		if (name === "--recover-reserved") { recoverReserved = true; continue; }
		if (!name.startsWith("--") || option.has(name) || i + 1 >= values.length)
			throw new Error("invalid private resume arguments");
		option.set(name, values[++i]!);
	}
	const keys = ["--source", "--seed", "--public-key", "--journal-dir", "--output-private"];
	const allowed = [...keys, "--repair-plan-private", "--interrupted-source-review-private",
		"--terminal-prefix-source-review-private",
		"--result-only-repair-review-private", "--linked-unknown-control-commit",
		"--unobserved-control-source-review-private", "--provider-availability-receipt-private"];
	if (!connectorStdio || readOnly && recoverReserved || keys.some(key => !option.has(key)) ||
		[...option.keys()].some(key => !allowed.includes(key)) ||
		option.has("--linked-unknown-control-commit") !==
			option.has("--unobserved-control-source-review-private"))
		throw new Error("missing private resume arguments");
	const result = { source: option.get("--source")!, seed: option.get("--seed")!,
		publicKey: option.get("--public-key")!, journalDir: option.get("--journal-dir")!,
		outputPrivate: option.get("--output-private")!, readOnly, recoverReserved,
		...(option.has("--repair-plan-private") ? { repairPlanPrivate: option.get("--repair-plan-private")! } : {}),
		...(option.has("--interrupted-source-review-private") ?
			{ interruptedSourceReviewPrivate: option.get("--interrupted-source-review-private")! } : {}),
		...(option.has("--terminal-prefix-source-review-private") ?
			{ terminalPrefixSourceReviewPrivate: option.get("--terminal-prefix-source-review-private")! } : {}),
		...(option.has("--result-only-repair-review-private") ?
			{ resultOnlyRepairReviewPrivate: option.get("--result-only-repair-review-private")! } : {}),
		...(option.has("--provider-availability-receipt-private") ?
			{ providerAvailabilityReceiptPrivate: option.get("--provider-availability-receipt-private")! } : {}),
		...(option.has("--linked-unknown-control-commit") ?
			{ linkedUnknownDeliveryOldControlCommit: option.get("--linked-unknown-control-commit")! } : {}),
		...(option.has("--unobserved-control-source-review-private") ?
			{ unobservedControlSourceReviewPrivate: option.get("--unobserved-control-source-review-private")! } : {}) };
	if (result.linkedUnknownDeliveryOldControlCommit !== undefined &&
		!/^[0-9a-f]{40}$/.test(result.linkedUnknownDeliveryOldControlCommit))
		throw new Error("linked control commit is invalid");
	if (Object.entries(result).some(([key, value]) => !["readOnly", "recoverReserved",
		"linkedUnknownDeliveryOldControlCommit"].includes(key) &&
		!path.isAbsolute(String(value)))) throw new Error("private resume paths must be absolute");
	if (underRepo(result.journalDir) || underRepo(result.outputPrivate) ||
		(result.repairPlanPrivate !== undefined && underRepo(result.repairPlanPrivate)) ||
		(result.interruptedSourceReviewPrivate !== undefined && underRepo(result.interruptedSourceReviewPrivate)) ||
		(result.terminalPrefixSourceReviewPrivate !== undefined &&
			underRepo(result.terminalPrefixSourceReviewPrivate)) ||
		(result.resultOnlyRepairReviewPrivate !== undefined && underRepo(result.resultOnlyRepairReviewPrivate)) ||
		(result.providerAvailabilityReceiptPrivate !== undefined && underRepo(result.providerAvailabilityReceiptPrivate)) ||
		(result.unobservedControlSourceReviewPrivate !== undefined &&
			underRepo(result.unobservedControlSourceReviewPrivate)))
		throw new Error("private resume records must be outside the source repository");
	return result;
}

/** All requests remain on the fixed repository's public metadata REST surface.
 * The connector response is trusted as the read-only GitHub account result. */
function connectorBridge(): { request: typeof fetch;
	artifact: (identity: { runId: string; artifactId: string;
		expectedArchiveSha256?: string }) => Promise<CarryArtifactPayload>;
	resultEnvelope: (identity: { runId: string; artifactId: string;
		expectedArchiveSha256: string }) => Promise<Uint8Array>;
	providerAvailabilityEnvelope: (identity: { runId: string; artifactId: string;
		expectedArchiveSha256: string }) => Promise<Uint8Array>;
	capacityFailure: () => PrivateBridgeError | undefined;
	close: () => void } {
	let capacityFailure: PrivateBridgeError | undefined;
	const pending = new Map<number, { kind: "github-get" | "artifact-file";
		resolve: (value: unknown) => void;
		reject: (error: Error) => void }>();
	let closed = false;
	const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
	lines.on("line", line => {
		let reply: { id?: unknown; status?: unknown; body?: unknown;
			file?: unknown; sha256?: unknown; name?: unknown; sidecars?: unknown;
			prefix?: unknown; archiveSha256?: unknown; archiveFile?: unknown };
		try { reply = JSON.parse(line) as typeof reply; }
		catch { return; }
		if (!Number.isSafeInteger(reply.id)) return;
		const awaiting = pending.get(Number(reply.id));
		if (!awaiting) return;
		pending.delete(Number(reply.id));
		if (awaiting.kind === "github-get") {
			if (!Number.isSafeInteger(reply.status) || Number(reply.status) < 200 ||
				Number(reply.status) > 599 || reply.file !== undefined) {
				awaiting.reject(new Error("GitHub connector response status is invalid")); return;
			}
			awaiting.resolve(new Response(JSON.stringify(reply.body), { status: Number(reply.status) }));
		} else {
			const keys = Object.keys(reply).sort();
			const expected = ["id", "file", "sha256",
				...(reply.name === undefined ? [] : ["name"]),
				...(reply.archiveSha256 === undefined ? [] : ["archiveSha256"]),
				...(reply.archiveFile === undefined ? [] : ["archiveFile"]),
				...(reply.sidecars === undefined ? [] : ["sidecars"]),
				...(reply.prefix === undefined ? [] : ["prefix"])].sort();
			if (!privateFileReference(reply) || keys.join("|") !== expected.join("|") ||
				(reply.archiveFile !== undefined &&
					(typeof reply.archiveFile !== "string" ||
						!path.isAbsolute(reply.archiveFile) || underRepo(reply.archiveFile))) ||
				(reply.archiveSha256 !== undefined &&
					(typeof reply.archiveSha256 !== "string" || !/^[0-9a-f]{64}$/.test(reply.archiveSha256))) ||
				(reply.name !== undefined && typeof reply.name !== "string") ||
				(reply.name !== undefined && !["incremental-control-prefix.json",
					"private-campaign-outcome.enc.json", "provider-balance.enc.json",
					ARTIFACT_PARTITION_MANIFEST_FILE].includes(String(reply.name)) &&
					!/^private-artifact\.part-[0-9]{8}\.bin$/.test(String(reply.name))) ||
				(reply.name !== undefined && (reply.prefix !== undefined || reply.sidecars !== undefined)) ||
				(reply.prefix !== undefined && (!privateFileReference(reply.prefix) ||
					Object.keys(reply.prefix).sort().join("|") !== "file|name|sha256" ||
					reply.prefix.name !== "incremental-control-prefix.json")) ||
				(reply.sidecars !== undefined && (!Array.isArray(reply.sidecars) ||
					reply.sidecars.length > maxLegacyZipEntries - 1 ||
					reply.sidecars.some((entry: unknown) => !privateFileReference(entry) ||
						Object.keys(entry).sort().join("|") !== "file|name|sha256" ||
						typeof entry.name !== "string" ||
						!/^ledger-continuation\.part-[0-9]{8}\.enc$/.test(entry.name) &&
						!isHistoricalPrefixSidecarName(entry.name))))) {
				awaiting.reject(new Error("artifact file reply is invalid")); return;
			}
			awaiting.resolve(reply as ArtifactFileReply);
		}
	});
	lines.on("close", () => {
		closed = true;
		for (const awaiting of pending.values())
			awaiting.reject(new PrivateBridgeError("authenticated-github-connector-stdin-closed"));
		pending.clear();
	});
	let nextId = 0;
	const request: typeof fetch = async (input): Promise<Response> => {
		if (closed || process.stdin.readableEnded)
			throw new PrivateBridgeError("authenticated-github-connector-stdin-closed");
		const url = String(input);
		if (!url.startsWith("https://api.github.com/repos/SakuyaInazaki/Mul-Pis/"))
			throw new Error("private resume requested an unexpected GitHub URL");
		const id = ++nextId;
		const response = new Promise<Response>((resolve, reject) => pending.set(id,
			{ kind: "github-get", resolve: value => resolve(value as Response), reject }));
		process.stdout.write(`${JSON.stringify({ kind: "github-get", id, url })}\n`);
		return response;
	};
	const artifactFile = async (identity: { runId: string; artifactId: string;
		expectedArchiveSha256?: string; name?: string;
		expectedArtifactName?: string }): Promise<ArtifactFileReply> => {
		if (closed || process.stdin.readableEnded)
			throw new PrivateBridgeError("authenticated-github-connector-stdin-closed");
		const id = ++nextId;
		const reply = new Promise<ArtifactFileReply>((resolve, reject) =>
			pending.set(id, { kind: "artifact-file", resolve: value =>
				resolve(value as ArtifactFileReply), reject }));
		process.stdout.write(`${JSON.stringify({ kind: "artifact-file", id,
			runId: identity.runId, artifactId: identity.artifactId,
			...(identity.name ? { name: identity.name } : {}),
			...(identity.expectedArtifactName ?
				{ expectedArtifactName: identity.expectedArtifactName } : {}),
			...(identity.expectedArchiveSha256 ?
				{ expectedArchiveSha256: identity.expectedArchiveSha256 } : {}) })}\n`);
		return reply;
	};
	const artifactCensus = async (runId: string): Promise<unknown[]> => {
		const rows: unknown[] = [];
		let total: number | undefined;
		for (let page = 1; ; page++) {
			if (!Number.isSafeInteger(page))
				throw new Error("artifact census page index is invalid");
			const url = `https://api.github.com/repos/SakuyaInazaki/Mul-Pis/actions/runs/${runId}/artifacts?per_page=100&page=${page}`;
			const response = await request(url);
			if (!response.ok) throw new Error("artifact census read failed");
			const body = await response.json() as { total_count?: unknown; artifacts?: unknown };
			if (!Number.isSafeInteger(body?.total_count) || Number(body.total_count) < 0 ||
				!Array.isArray(body.artifacts) ||
				(total !== undefined && total !== body.total_count))
				throw new Error("artifact census response is invalid");
			total = Number(body.total_count);
			if (body.artifacts.length !== Math.min(100, Math.max(0, total - rows.length)))
				throw new Error("artifact census page is incomplete");
			rows.push(...body.artifacts);
			if (rows.length === total) return rows;
		}
	};
	const stableArtifactCensus = async (runId: string): Promise<unknown[]> => {
		const first = await artifactCensus(runId);
		const second = await artifactCensus(runId);
		if (JSON.stringify(first) !== JSON.stringify(second))
			throw new Error("artifact census changed during multipart read");
		return second;
	};
	const artifact = async (identity: { runId: string; artifactId: string;
		expectedArchiveSha256?: string; missionKey?: Buffer; seedDigest?: string;
		expectedSource?: ArtifactTransportSource; expectedArtifactName?: string }):
		Promise<CarryArtifactPayload> => {
		const observed = await artifactFile(identity);
		if (observed.archiveFile !== undefined)
			throw new Error("carry artifact reply supplied a result archive");
		if (observed.name === "private-campaign-outcome.enc.json" ||
			observed.name === "provider-balance.enc.json")
			throw new Error("carry artifact reply supplied a result envelope");
		if (identity.expectedArchiveSha256 &&
			observed.archiveSha256 !== identity.expectedArchiveSha256)
			throw new Error("artifact ZIP digest does not match authenticated GitHub metadata");
		if (observed.name === ARTIFACT_PARTITION_MANIFEST_FILE) {
			if (!identity.expectedArchiveSha256 || !identity.missionKey ||
				!identity.seedDigest || !identity.expectedSource || !identity.expectedArtifactName ||
				identity.expectedSource.runId !== identity.runId ||
				observed.sidecars !== undefined || observed.prefix !== undefined)
				throw new Error("multipart artifact lacks authenticated transport context");
			const raw = new TextDecoder("utf-8", { fatal: true }).decode(
				await verifiedPrivateBytes(observed, MAX_ARTIFACT_PARTITION_MANIFEST_BYTES * 2));
			const manifest = openPartitionManifest({ raw, missionKey: identity.missionKey,
				seedDigest: identity.seedDigest, expectedSource: identity.expectedSource,
				expectedArtifactName: identity.expectedArtifactName });
			const census = await stableArtifactCensus(identity.runId);
			const root = census.filter(row => Boolean(row) && typeof row === "object" &&
				(row as { id?: unknown }).id === Number(identity.artifactId) &&
				(row as { name?: unknown }).name === manifest.artifactName);
			const rootSource = (root[0] as { workflow_run?: unknown } | undefined)?.workflow_run;
			if (root.length !== 1 || (root[0] as { expired?: unknown }).expired !== false ||
				(root[0] as { digest?: unknown }).digest !==
					`sha256:${identity.expectedArchiveSha256}` ||
				!rootSource || typeof rootSource !== "object" ||
				(rootSource as { id?: unknown }).id !== Number(identity.runId) ||
				(rootSource as { head_sha?: unknown }).head_sha !== manifest.source.commit)
				throw new Error("multipart root does not match stable GitHub metadata");
			validatePartitionArtifactCensus(manifest, census);
			const parts: Buffer[] = [];
			for (const chunk of manifest.chunks) {
				const part = await artifactFile({ runId: identity.runId,
					artifactId: chunk.artifactId, expectedArchiveSha256: chunk.archiveSha256,
					expectedArtifactName: chunk.artifactName, name: chunk.fileName });
				if (part.name !== chunk.fileName || part.archiveSha256 !== chunk.archiveSha256 ||
					part.prefix !== undefined || part.sidecars !== undefined)
					throw new Error("multipart part reply does not match the indexed ZIP");
				parts.push(await verifiedPrivateBytes(part, ARTIFACT_PARTITION_PAYLOAD_BYTES));
			}
			const files = restorePartitionFiles(manifest, parts, identity.expectedSource,
				identity.expectedArtifactName);
			return restoredCarryPayload(files, manifest);
		}
		const bytes = await verifiedPrivateBytes(observed,
			observed.name === "incremental-control-prefix.json" ? 64 * 1024 * 1024 : 8 * 1024 * 1024);
		if (observed.name === "incremental-control-prefix.json")
			return { incrementalControlPrefix: bytes.toString("utf8") };
		const outer = JSON.parse(bytes.toString("utf8")) as unknown;
		if (!outer || typeof outer !== "object" || Array.isArray(outer) ||
			Object.keys(outer).length !== 1 ||
			typeof (outer as { envelopeB64?: unknown }).envelopeB64 !== "string")
			throw new Error("artifact file format is invalid");
		const envelopeB64 = (outer as { envelopeB64: string }).envelopeB64;
		const prefix = observed.prefix ?
			(await verifiedPrivateBytes(observed.prefix, 64 * 1024 * 1024)).toString("utf8") : undefined;
		if (observed.sidecars === undefined)
			return prefix === undefined ? envelopeB64 :
				{ envelopeB64, sidecars: {}, incrementalControlPrefix: prefix };
		const sidecars: Record<string, string> = Object.create(null) as Record<string, string>;
		const paths = new Set([observed.file, ...(observed.prefix ? [observed.prefix.file] : [])]);
		for (const item of observed.sidecars) {
			if (Object.hasOwn(sidecars, item.name) || paths.has(item.file))
				throw new Error("artifact sidecar set is invalid");
			paths.add(item.file);
			const historical = isHistoricalPrefixSidecarName(item.name);
			sidecars[item.name] = canonicalSidecarText(await verifiedPrivateBytes(item,
				historical ? maxPrefixSidecarTextBytes : maxSidecarTextBytes),
				historical ? PREFIX_SIDECAR_FILE_BYTES : CARRY_SEGMENT_FILE_BYTES);
		}
		validSidecarSet(Object.keys(sidecars));
		return { envelopeB64, sidecars,
			...(prefix === undefined ? {} : { incrementalControlPrefix: prefix }) };
	};
	const resultEnvelope = async (identity: { runId: string; artifactId: string;
		expectedArchiveSha256: string }): Promise<Uint8Array> => {
		if (closed || process.stdin.readableEnded)
			throw new PrivateBridgeError("authenticated-github-connector-stdin-closed");
		const id = ++nextId;
		const reply = new Promise<ArtifactFileReply>((resolve, reject) =>
			pending.set(id, { kind: "artifact-file", resolve: value =>
				resolve(value as ArtifactFileReply), reject }));
		process.stdout.write(`${JSON.stringify({ kind: "artifact-file", id,
			runId: identity.runId, artifactId: identity.artifactId,
			expectedArchiveSha256: identity.expectedArchiveSha256 })}\n`);
		const observed = await reply;
		if (observed.name !== "private-campaign-outcome.enc.json" ||
			observed.sidecars !== undefined || observed.prefix !== undefined ||
			observed.archiveSha256 !== identity.expectedArchiveSha256)
			throw new Error("encrypted result artifact reply does not match live ZIP identity");
		if (observed.archiveFile) {
			const original = await verifiedPrivateBytes({ file: observed.archiveFile,
				sha256: identity.expectedArchiveSha256 }, RESULT_ARCHIVE_MAX_BYTES);
			const archivedMember = exactResultArchiveMember(original);
			const extractedMember = await verifiedPrivateBytes(observed, RESULT_ARCHIVE_MAX_BYTES);
			if (!archivedMember.equals(extractedMember))
				throw new Error("restored result member differs from the exact original ZIP");
			return extractedMember;
		}
		try { return await verifiedPrivateBytes(observed, 32 * 1024 * 1024,
			"result-envelope-exceeds-connector-capacity"); }
		catch (error) {
			if (error instanceof PrivateBridgeError &&
				error.reasonCode === "result-envelope-exceeds-connector-capacity")
				capacityFailure = error;
			throw error;
		}
	};
	const providerAvailabilityEnvelope = async (identity: { runId: string; artifactId: string;
		expectedArchiveSha256: string }): Promise<Uint8Array> => {
		if (closed || process.stdin.readableEnded)
			throw new PrivateBridgeError("authenticated-github-connector-stdin-closed");
		const id = ++nextId;
		const reply = new Promise<ArtifactFileReply>((resolve, reject) =>
			pending.set(id, { kind: "artifact-file", resolve: value =>
				resolve(value as ArtifactFileReply), reject }));
		process.stdout.write(`${JSON.stringify({ kind: "artifact-file", id,
			runId: identity.runId, artifactId: identity.artifactId,
			name: "provider-balance.enc.json",
			expectedArchiveSha256: identity.expectedArchiveSha256 })}\n`);
		const observed = await reply;
		if (observed.name !== "provider-balance.enc.json" ||
			observed.sidecars !== undefined || observed.prefix !== undefined ||
			observed.archiveFile !== undefined ||
			observed.archiveSha256 !== identity.expectedArchiveSha256)
			throw new Error("encrypted balance artifact reply does not match live ZIP identity");
		return verifiedPrivateBytes(observed, 64 * 1024);
	};
	return { request, artifact, resultEnvelope, providerAvailabilityEnvelope,
		capacityFailure: () => capacityFailure,
		close: () => lines.close() };
}

/** The second argument is used only by synthetic signed-seed tests. The CLI
 * below always uses the mission's pinned production signing key. */
async function writePrivateSlot(handle: FileHandle, value: unknown): Promise<void> {
	const bytes = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
	await handle.truncate(0);
	let offset = 0;
	while (offset < bytes.length) {
		const written = (await handle.write(bytes, offset, bytes.length - offset, offset)).bytesWritten;
		if (written <= 0) throw new PrivateBridgeError("private-output-write-failed");
		offset += written;
	}
	await handle.truncate(bytes.length);
	await handle.sync();
}
export async function runPrivateResumeBridge(values: string[],
	testOnly?: Readonly<{ expectedSpkiSha256: string }>): Promise<void> {
	let privateSlot: FileHandle | undefined;
	let successWritten = false;
	try {
		const args = parseArgs(values);
		if (underRepo(await realpath(path.dirname(args.outputPrivate))) ||
			underRepo(await realpath(path.dirname(args.journalDir))))
			throw new Error("private resume directory resolves inside the source repository");
		// Claim the caller's private result before a journal reservation can occur.
		if (!args.readOnly) try { privateSlot = await open(args.outputPrivate, "wx", 0o600); }
			catch (error) { throw new PrivateBridgeError(privateOsErrorCode(error) === "EEXIST" ?
				"private-output-exists" : "private-output-unavailable", error); }
		const seedInfo = await lstat(args.seed);
		if (!seedInfo.isFile() || (seedInfo.mode & 0o077) !== 0)
			throw new Error("signed mission seed file is not private and regular");
		const source = JSON.parse(await readFile(args.source, "utf8")) as CurrentMissionRun;
		if (source?.manualAuthorized !== "true")
			throw new PrivateBridgeError("source-authorization-flag-missing");
		const seedEnvelopeB64 = (await readFile(args.seed, "utf8")).trim();
		const bridge = connectorBridge();
		let result: Awaited<ReturnType<typeof prepareAuthenticatedResumeRequest>>;
		try {
			result = await prepareAuthenticatedResumeRequest({ source, seedEnvelopeB64,
				publicKeyFile: args.publicKey,
				...(testOnly ? { expectedSpkiSha256: testOnly.expectedSpkiSha256 } : {}),
				githubToken: undefined,
				authenticatedHostRead: { kind: "authenticated-host-github-read", request: bridge.request },
				loadCarryArtifact: identity => bridge.artifact(identity),
				loadResultEnvelope: identity => bridge.resultEnvelope(identity),
				loadProviderAvailabilityEnvelope: identity => bridge.providerAvailabilityEnvelope(identity),
				...(args.providerAvailabilityReceiptPrivate ?
					{ providerAvailabilityReceiptPrivateFile: args.providerAvailabilityReceiptPrivate } : {}),
				...(args.repairPlanPrivate ? { repairPlanPrivateFile: args.repairPlanPrivate } : {}),
				...(args.interruptedSourceReviewPrivate ?
					{ interruptedSourceReviewPrivateFile: args.interruptedSourceReviewPrivate } : {}),
				...(args.terminalPrefixSourceReviewPrivate ?
					{ terminalPrefixSourceReviewPrivateFile: args.terminalPrefixSourceReviewPrivate } : {}),
				...(args.resultOnlyRepairReviewPrivate ?
					{ resultOnlyRepairReviewPrivateFile: args.resultOnlyRepairReviewPrivate } : {}),
				...(args.linkedUnknownDeliveryOldControlCommit ?
					{ linkedUnknownDeliveryOldControlCommit: args.linkedUnknownDeliveryOldControlCommit } : {}),
				...(args.unobservedControlSourceReviewPrivate ?
					{ unobservedControlSourceReviewPrivateFile: args.unobservedControlSourceReviewPrivate } : {}),
				journal: new MissionResumeJournal(args.journalDir), readOnly: args.readOnly,
				...(args.recoverReserved ? { recoverReservedDescriptor: true } : {}) });
		} catch (error) {
			const capacity = bridge.capacityFailure();
			if (capacity) throw new PrivateBridgeError(capacity.reasonCode, error);
			throw error;
		} finally { bridge.close(); }
		if (privateSlot) {
			try { await writePrivateSlot(privateSlot, result); }
			catch (error) { throw new PrivateBridgeError("private-output-write-failed", error); }
			successWritten = true;
			try { await privateSlot.close(); }
			catch (error) { throw new PrivateBridgeError("private-output-close-failed", error); }
			privateSlot = undefined;
		}
		process.stdout.write(`${JSON.stringify(result.descriptor ?
			{ kind: args.readOnly ? "planned-read-only" :
				result.decision.kind === "wait" && result.decision.reason === "dispatch-reserved" ?
					"recovered-reservation" : "prepared", descriptor: result.descriptor } :
			{ kind: "no-dispatch", decisionKind: result.decision.kind })}\n`);
	} catch (error) {
		if (privateSlot && !successWritten) try { await writePrivateSlot(privateSlot, {
			version: 1, kind: "private-resume-preparation-diagnostic",
			...privateHostPreparationDiagnostic(error) }); } catch { /* Keep the initiating failure. */ }
		try { await savePrivateFailure(values, error); } catch { /* Private output may be unavailable. */ }
		throw error;
	} finally {
		if (privateSlot) try { await privateSlot.close(); } catch { /* Preserve the initiating error. */ }
	}
}

export function privateHostPreparationDiagnostic(error: unknown): Record<string, unknown> {
	if (error instanceof AggregateError && error.errors.length === 2)
		return { code: "terminal-authentication-failed",
			attempts: error.errors.map(item => privateHostPreparationDiagnostic(item)) };
	if (error instanceof PeriodicPrefixRecoveryError)
		return { code: error.code, stage: error.stage, reason: error.reason,
			...(error.checkpointStage ? { checkpointStage: error.checkpointStage } : {}),
			...(error.checkpointReason ? { checkpointReason: error.checkpointReason } : {}) };
	if (error instanceof MissionHostPreparationError)
		return { code: error.refusal.code, stage: error.refusal.stage,
			...(error.refusal.providerAvailabilityCause === undefined ? {} :
				{ providerAvailabilityCause: error.refusal.providerAvailabilityCause }),
			...(error.refusal.providerAvailabilityCheck === undefined ? {} :
				{ providerAvailabilityCheck: error.refusal.providerAvailabilityCheck }),
			...(error.refusal.ciRunId === undefined ? {} : { ciRunId: error.refusal.ciRunId }),
			...(error.refusal.ciStatus === undefined ? {} : { ciStatus: error.refusal.ciStatus }),
			...(error.refusal.ciConclusion === undefined ? {} : { ciConclusion: error.refusal.ciConclusion }),
			...(error.refusal.httpStatus === undefined ? {} : { httpStatus: error.refusal.httpStatus }) };
	if (error instanceof PrivateBridgeError) return { code: error.reasonCode,
		...(error.osErrorCode ? { osErrorCode: error.osErrorCode } : {}),
		...(error.preparationCause ?
			{ preparation: privateHostPreparationDiagnostic(error.preparationCause) } : {}) };
	if (error instanceof HarnessError &&
		/^(?:runner\.ledger-continuation|runner\.signed-mission-ledger|runner\.mission)/.test(error.code) &&
		/^[A-Za-z0-9 .,;:()_\-]{1,250}$/.test(error.message))
		return { code: error.code, detail: error.message };
	return { code: "unclassified-host-preparation-error" };
}

async function savePrivateFailure(values: string[], error: unknown): Promise<void> {
	const index = values.indexOf("--output-private");
	const target = index >= 0 ? values[index + 1] : undefined;
	if (!target || !path.isAbsolute(target) || underRepo(target) ||
		underRepo(await realpath(path.dirname(target)))) return;
	const diagnostic = privateHostPreparationDiagnostic(error);
	const attemptFile = path.join(path.dirname(target),
		`.${path.basename(target)}.attempt-${randomUUID()}.failure.json`);
	const handle = await open(attemptFile, "wx", 0o600);
	try { await handle.writeFile(`${JSON.stringify({ version: 1,
		kind: "private-resume-preparation-diagnostic", ...diagnostic })}\n`); await handle.sync(); }
	finally { await handle.close(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const values = process.argv.slice(2);
	runPrivateResumeBridge(values).catch(async error => {
		process.stderr.write("private resume preparation failed; no control request was sent; inspect private diagnostic\n");
		process.exitCode = 1;
	});
}
