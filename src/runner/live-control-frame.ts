/** Small authenticated status frames for observing an in-flight Actions run.
 * Frames report only committed control facts. They grant no scientific selection
 * authority, do not settle accounting, and carry no task or model text.
 */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { TextDecoder } from "node:util";
import { HarnessError } from "../types.ts";
import { authenticateSignedMissionSeed, MISSION_ID, MISSION_REPOSITORY } from "./signed-mission-ledger.ts";
import type { IncrementalCheckpointEvent, IncrementalCheckpointSource } from "./incremental-private-checkpoint.ts";

export const LIVE_CONTROL_FRAME_BYTES = 4096;
const FORMAT = "mul-pis-live-control-frame-v1";
const HEX40 = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const RUN_ID = /^[1-9][0-9]{0,17}$/;
const BOUNDARIES: readonly IncrementalCheckpointEvent[] = ["initial", "request-reserved",
	"request-observed", "host-effect-observed", "control-observed"];
const SOURCE_KEYS = ["repository", "runId", "runAttempt", "commit", "event",
	"priorEnvelopeSha256"];
const FRAME_KEYS = ["version", "format", "source", "sequence", "nonceB64",
	"ciphertextB64", "tagB64"];
const OBSERVATION_KEYS = ["committedCheckpointBoundary", "checkpointSha256", "requestCount",
	"responseReceivedCount", "goalCount", "goalOutcomeCounts", "taskCount",
	"taskStatusCounts", "operationCount", "operationStatusCounts", "observedAt"];
const GOAL_OUTCOME_KEYS = ["active", "partial", "blocked", "fulfilled"];
const TASK_STATUS_KEYS = ["running", "returned", "failed", "accepted", "rejected", "unknown"];
const OPERATION_STATUS_KEYS = ["prepared", "issued", "response-received", "partial-settled",
	"terminal-response-incomplete", "unknown", "confirmed", "not-issued"];
const STATUS_KEYS = ["version", "kind", "partial", "complete", "selectionAuthority",
	"scientificAcceptance", "accounting", ...OBSERVATION_KEYS];

export type LiveControlFrameSource = IncrementalCheckpointSource;
export type LiveControlFrameCounts = Readonly<{
	committedCheckpointBoundary: IncrementalCheckpointEvent;
	/** Digest of the committed incremental prefix named by the frame sequence. */
	checkpointSha256: string;
	requestCount: number; responseReceivedCount: number;
	goalCount: number;
	goalOutcomeCounts: Readonly<{ active: number; partial: number; blocked: number;
		fulfilled: number }>;
	taskCount: number;
	taskStatusCounts: Readonly<{ running: number; returned: number; failed: number;
		accepted: number; rejected: number; unknown: number }>;
	operationCount: number;
	operationStatusCounts: Readonly<{ prepared: number; issued: number;
		"response-received": number; "partial-settled": number;
		"terminal-response-incomplete": number; unknown: number; confirmed: number;
		"not-issued": number }>;
	observedAt: string;
}>;
export type LiveControlFrameStatusV1 = LiveControlFrameCounts & Readonly<{
	version: 1; kind: "partial-control-observation"; partial: true; complete: false;
	selectionAuthority: false; scientificAcceptance: "unreviewed";
	accounting: "unquantified";
}>;
export type LiveControlFrameEmission = LiveControlFrameCounts & Readonly<{ sequence: number }>;
type Opening = Readonly<{
	seedEnvelopeB64: string | undefined; publicKeyFile: string;
	source: LiveControlFrameSource;
	/** For offline fixtures only; production callers omit this override. */
	expectedSpkiSha256?: string;
}>;

function reject(reason: string): never { throw new HarnessError("runner.live-control-frame", reason); }
function record(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
	return Object.keys(value).sort().join("|") === [...keys].sort().join("|");
}
function positiveSequence(value: unknown): value is number {
	return Number.isSafeInteger(value) && Number(value) > 0;
}
function nonnegativeCount(value: unknown): value is number {
	return Number.isSafeInteger(value) && Number(value) >= 0;
}
function validAggregateCounts(value: unknown, keys: readonly string[], total: unknown): boolean {
	if (!nonnegativeCount(total) || !record(value) || !exactKeys(value, keys) ||
		!keys.every(key => nonnegativeCount(value[key]))) return false;
	return keys.reduce((sum, key) => sum + BigInt(value[key] as number), 0n) === BigInt(total);
}
function validSource(value: unknown): value is LiveControlFrameSource {
	if (!record(value) || !exactKeys(value, SOURCE_KEYS)) return false;
	return value.repository === MISSION_REPOSITORY && typeof value.runId === "string" &&
		RUN_ID.test(value.runId) && positiveSequence(value.runAttempt) &&
		typeof value.commit === "string" && HEX40.test(value.commit) &&
		(value.event === "push" || value.event === "workflow_dispatch") &&
		typeof value.priorEnvelopeSha256 === "string" && HEX64.test(value.priorEnvelopeSha256);
}
function sameSource(value: unknown, expected: LiveControlFrameSource): boolean {
	return validSource(value) && SOURCE_KEYS.every(key =>
		(value as unknown as Record<string, unknown>)[key] ===
		(expected as unknown as Record<string, unknown>)[key]);
}
function validObservedAt(value: unknown): value is string {
	if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value))
		return false;
	const time = Date.parse(value);
	return Number.isFinite(time) && new Date(time).toISOString() === value;
}
function validCounts(value: Record<string, unknown>): boolean {
	return BOUNDARIES.includes(value.committedCheckpointBoundary as IncrementalCheckpointEvent) &&
		typeof value.checkpointSha256 === "string" && HEX64.test(value.checkpointSha256) &&
		nonnegativeCount(value.requestCount) && nonnegativeCount(value.responseReceivedCount) &&
		Number(value.responseReceivedCount) <= Number(value.requestCount) &&
		validAggregateCounts(value.goalOutcomeCounts, GOAL_OUTCOME_KEYS, value.goalCount) &&
		validAggregateCounts(value.taskStatusCounts, TASK_STATUS_KEYS, value.taskCount) &&
		validAggregateCounts(value.operationStatusCounts, OPERATION_STATUS_KEYS,
			value.operationCount) && validObservedAt(value.observedAt);
}
function validEmission(value: unknown): value is LiveControlFrameEmission {
	return record(value) && exactKeys(value, ["sequence", ...OBSERVATION_KEYS]) &&
		positiveSequence(value.sequence) && validCounts(value);
}
function validStatus(value: unknown): value is LiveControlFrameStatusV1 {
	return record(value) && exactKeys(value, STATUS_KEYS) && value.version === 1 &&
		value.kind === "partial-control-observation" && value.partial === true &&
		value.complete === false && value.selectionAuthority === false &&
		value.scientificAcceptance === "unreviewed" && value.accounting === "unquantified" &&
		validCounts(value);
}
function canonicalBase64(value: unknown, expectedBytes?: number): Buffer {
	if (typeof value !== "string" || !value.length ||
		!(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/).test(value))
		reject("frame encoding is invalid");
	const bytes = Buffer.from(value, "base64");
	if (bytes.toString("base64") !== value ||
		(expectedBytes !== undefined && bytes.length !== expectedBytes))
		reject("frame encoding is invalid");
	return bytes;
}
function aad(source: LiveControlFrameSource, sequence: number): Buffer {
	return Buffer.from(JSON.stringify([FORMAT, MISSION_ID, source.repository, source.runId,
		source.runAttempt, source.commit, source.event, source.priorEnvelopeSha256, sequence]), "utf8");
}
async function openKey(input: Opening): Promise<Buffer> {
	if (!validSource(input.source)) reject("source is invalid");
	const seed = await authenticateSignedMissionSeed({ envelopeB64: input.seedEnvelopeB64,
		publicKeyFile: input.publicKeyFile, expectedSpkiSha256: input.expectedSpkiSha256 });
	const continuationKey = seed.derivePrivateKey("mul-pis-ledger-continuation-v1");
	return Buffer.from(hkdfSync("sha256", continuationKey,
		Buffer.from(input.source.priorEnvelopeSha256, "hex"), FORMAT, 32));
}

/** Caller supplies the sequence from a committed StoredIncrementalCheckpoint.
 * The sink receives one bounded JSON line, without a trailing newline.
 */
export async function createLiveControlFrameWriter(input: Opening & {
	emitFrame: (line: string) => void | Promise<void>;
}): Promise<Readonly<{ emit: (value: LiveControlFrameEmission) => Promise<string> }>> {
	if (typeof input.emitFrame !== "function") reject("frame sink is invalid");
	const source = Object.freeze({ ...input.source });
	const key = await openKey({ ...input, source });
	let lastSequence = 0;
	let pending: Promise<unknown> = Promise.resolve();
	return { emit(value) {
		const work = pending.then(async () => {
			if (!validEmission(value)) reject("status fields are invalid");
			if (value.sequence <= lastSequence) reject("frame sequence did not increase");
			const { sequence, ...counts } = value;
			const status: LiveControlFrameStatusV1 = { version: 1,
				kind: "partial-control-observation", partial: true, complete: false,
				selectionAuthority: false, scientificAcceptance: "unreviewed",
				accounting: "unquantified", ...counts };
			const nonce = randomBytes(12);
			const cipher = createCipheriv("aes-256-gcm", key, nonce);
			cipher.setAAD(aad(source, sequence));
			const ciphertext = Buffer.concat([cipher.update(JSON.stringify(status), "utf8"), cipher.final()]);
			const line = JSON.stringify({ version: 1, format: FORMAT, source, sequence,
				nonceB64: nonce.toString("base64"), ciphertextB64: ciphertext.toString("base64"),
				tagB64: cipher.getAuthTag().toString("base64") });
			if (Buffer.byteLength(line, "utf8") > LIVE_CONTROL_FRAME_BYTES || /[\r\n]/.test(line))
				reject("frame exceeds byte bound");
			// Advance before invoking the sink: a rejected write may already have emitted.
			lastSequence = sequence;
			await input.emitFrame(line);
			return line;
		});
		pending = work.catch(() => undefined);
		return work;
	} };
}

/** Offline host reader. Read frames in arrival order; gaps are allowed, but
 * each accepted source sequence must be strictly greater than the last one.
 */
export async function createLiveControlFrameReader(input: Opening): Promise<Readonly<{
	read: (line: string) => Readonly<{ sequence: number; missedSequences: number;
		status: LiveControlFrameStatusV1 }>;
}>> {
	const source = Object.freeze({ ...input.source });
	const key = await openKey({ ...input, source });
	let lastSequence = 0;
	return { read(line) {
		if (typeof line !== "string" || !line.length || /[\r\n]/.test(line) ||
			Buffer.byteLength(line, "utf8") > LIVE_CONTROL_FRAME_BYTES)
			reject("frame line is invalid or exceeds byte bound");
		let frame: unknown;
		try { frame = JSON.parse(line); }
		catch { return reject("frame JSON is invalid"); }
		if (!record(frame) || !exactKeys(frame, FRAME_KEYS) || frame.version !== 1 ||
			frame.format !== FORMAT || !sameSource(frame.source, source) ||
			!positiveSequence(frame.sequence)) reject("frame fields or source are invalid");
		const sequence = frame.sequence as number;
		if (sequence <= lastSequence) reject("frame sequence did not increase");
		const nonce = canonicalBase64(frame.nonceB64, 12);
		const ciphertext = canonicalBase64(frame.ciphertextB64);
		const tag = canonicalBase64(frame.tagB64, 16);
		let plaintext: Buffer;
		try {
			const decipher = createDecipheriv("aes-256-gcm", key, nonce);
			decipher.setAAD(aad(source, sequence));
			decipher.setAuthTag(tag);
			plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
		} catch { return reject("frame authentication failed"); }
		let status: unknown;
		try { status = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plaintext)); }
		catch { return reject("frame plaintext JSON is invalid"); }
		if (!validStatus(status)) reject("frame status schema is invalid");
		const missedSequences = sequence - lastSequence - 1;
		lastSequence = sequence;
		return { sequence, missedSequences, status };
	} };
}
