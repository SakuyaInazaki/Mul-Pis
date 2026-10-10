/** Private, append-only forensic record for an objective assessor response.
 * Never put this record in a model prompt, public status, or an AEAD carry.
 * The result transport encrypts the two exact output basenames below.
 */
import { constants } from "node:fs";
import { chmod, link, lstat, mkdir, open, readdir, unlink } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

const MAX_FILE = 64 * 1024 * 1024; // Existing private result transport's physical per-file bound.
const MAX_TAR = 96 * 1024 * 1024; // Existing private result transport's physical tar bound.
const RESERVATIONS = ".assessor-diagnostic-reservations";
const OS_ERROR_CODES = ["EACCES", "EPERM", "ENOSPC", "EDQUOT", "EROFS", "EIO",
	"EMFILE", "ENFILE", "ENOENT", "ENOTDIR", "EEXIST"] as const;
export type PrivateAssessorOsErrorCode = typeof OS_ERROR_CODES[number];

/** Fixed, private-only OS cause. Never copy an exception message or path. */
export function privateAssessorOsErrorCode(error: unknown): PrivateAssessorOsErrorCode | undefined {
	try {
		const value = error && (typeof error === "object" || typeof error === "function") ?
			(error as { code?: unknown }).code : undefined;
		return typeof value === "string" && OS_ERROR_CODES.some(code => code === value) ?
			value as PrivateAssessorOsErrorCode : undefined;
	} catch { return undefined; }
}

export interface PrivateAssessorCoverage {
	sourceId: string;
	required: boolean;
	coveredRanges: Array<[number, number]>;
	complete: boolean;
	reachedUntruncatedEnd?: boolean;
}

export interface PrivateAssessorDiagnosticInput {
	/** Omitted by the original-objective callback for backward source compatibility. */
	stage?: "objective-assessment" | "m04-judgment";
	sessionId: string;
	generation: number;
	attempt: number;
	rawResponse: string;
	validation: { code: string; message: string; path?: string; detail?: unknown };
	coverage: PrivateAssessorCoverage[];
	/** Local Pi session transcript path. Only its copied basename is persisted. */
	transcriptPath?: string;
}

export interface PrivateAssessorDiagnosticResult {
	diagnosticName: string;
	transcriptName?: string;
	transcriptStatus: "snapshotted" | "previously-snapshotted" | "not-provided" | "missing" | "not-regular" |
		"too-large" | "read-failed";
}

/** One bounded frozen transcript per live session. Every rejected turn still
 * retains its own exact raw reply and host facts, avoiding quadratic copies. */
const capturedSessionTranscripts = new Map<string, string>();

export class PrivateAssessorDiagnosticError extends Error {
	readonly code: "invalid-input" | "invalid-root" | "physical-result-bound" | "write-failed";
	readonly osErrorCode?: PrivateAssessorOsErrorCode;
	constructor(code: PrivateAssessorDiagnosticError["code"], cause?: unknown) {
		super(`private assessor diagnostic: ${code}`);
		this.code = code;
		this.osErrorCode = privateAssessorOsErrorCode(cause);
	}
}

const text = (value: unknown): value is string => typeof value === "string" &&
	value.length > 0 && !value.includes("\0");
const range = (value: unknown): value is [number, number] => Array.isArray(value) && value.length === 2 &&
	Number.isSafeInteger(value[0]) && Number.isSafeInteger(value[1]) && value[0] >= 1 && value[1] >= value[0];
const padded = (size: number): number => Math.ceil(size / 512) * 512;
const tarBytes = (sizes: number[]): number => Math.ceil((sizes.reduce((sum, size) => sum + 512 + padded(size),
	1024)) / 10240) * 10240;

async function writePrivateTemp(root: string, bytes: Buffer): Promise<string> {
	const file = path.join(root, `.assessor-diagnostic-temp-${randomUUID()}`);
	const handle = await open(file, "wx", 0o600);
	try { await handle.writeFile(bytes); await handle.sync(); }
	finally { await handle.close(); }
	return file;
}

async function syncDirectory(root: string): Promise<void> {
	const handle = await open(root, constants.O_RDONLY);
	try { await handle.sync(); }
	finally { await handle.close(); }
}

async function transcriptBytes(file?: string): Promise<{
	status: PrivateAssessorDiagnosticResult["transcriptStatus"]; bytes?: Buffer }> {
	if (!file) return { status: "not-provided" };
	try {
		const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
		try {
			const before = await handle.stat();
			if (!before.isFile()) return { status: "not-regular" };
			if (before.size > MAX_FILE) return { status: "too-large" };
			const bytes = await handle.readFile();
			const after = await handle.stat();
			if (bytes.length !== before.size || after.size !== before.size ||
				after.mtimeMs !== before.mtimeMs) return { status: "read-failed" };
			return { status: "snapshotted", bytes };
		} finally { await handle.close(); }
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		return { status: code === "ENOENT" ? "missing" : code === "ELOOP" ? "not-regular" : "read-failed" };
	}
}

async function existingSizes(root: string): Promise<number[]> {
	const sizes: number[] = [];
	for (const name of await readdir(root)) {
		if (name.startsWith(".assessor-diagnostic-")) continue;
		const info = await lstat(path.join(root, name));
		if (info.isFile()) sizes.push(info.size);
	}
	return sizes;
}

async function reserveSequence(root: string): Promise<bigint> {
	const reservationRoot = path.join(root, RESERVATIONS);
	await mkdir(reservationRoot, { recursive: true, mode: 0o700 });
	let next = 1n;
	for (const name of await readdir(reservationRoot)) if (/^[1-9][0-9]*$/.test(name)) {
		const candidate = BigInt(name) + 1n;
		if (candidate > next) next = candidate;
	}
	for (;;) {
		try {
			await mkdir(path.join(reservationRoot, next.toString()), { mode: 0o700 });
			return next;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			next++;
		}
	}
}

/** Returns only file names and typed snapshot status; never returns raw content. */
export async function appendPrivateAssessorDiagnostic(root: string,
	input: PrivateAssessorDiagnosticInput): Promise<PrivateAssessorDiagnosticResult> {
	let serializedDetail: string | undefined;
	if (input.validation?.detail !== undefined) {
		try { serializedDetail = JSON.stringify(input.validation.detail); }
		catch { throw new PrivateAssessorDiagnosticError("invalid-input"); }
	}
	if (input.stage !== undefined && !["objective-assessment", "m04-judgment"].includes(input.stage) ||
		!text(input.sessionId) || !Number.isSafeInteger(input.generation) || input.generation < 1 ||
		!Number.isSafeInteger(input.attempt) || input.attempt < 1 ||
		typeof input.rawResponse !== "string" || !input.validation ||
		!text(input.validation.code) || !text(input.validation.message) ||
		(input.validation.path !== undefined && !text(input.validation.path)) ||
		(input.validation.detail !== undefined &&
			(typeof serializedDetail !== "string" || !serializedDetail.length)) ||
		!Array.isArray(input.coverage) || input.coverage.some(item => !item || !text(item.sourceId) ||
			typeof item.required !== "boolean" || typeof item.complete !== "boolean" ||
			!Array.isArray(item.coveredRanges) || !item.coveredRanges.every(range)))
		throw new PrivateAssessorDiagnosticError("invalid-input");
	try {
		const info = await lstat(root);
		if (!info.isDirectory() || info.isSymbolicLink()) throw new PrivateAssessorDiagnosticError("invalid-root");
		await chmod(root, 0o700);
	} catch (error) {
		if (error instanceof PrivateAssessorDiagnosticError) throw error;
		throw new PrivateAssessorDiagnosticError("invalid-root", error);
	}
	const transcriptKey = `${path.resolve(root)}\0${input.sessionId}`;
	const priorTranscriptName = capturedSessionTranscripts.get(transcriptKey);
	const transcript = priorTranscriptName ? undefined : await transcriptBytes(input.transcriptPath);
	const number = await reserveSequence(root);
	const suffix = number.toString().padStart(6, "0");
	const diagnosticName = `assessor-diagnostic-${suffix}.json`;
	const transcriptName = transcript?.bytes ? `assessor-transcript-${suffix}.bin` : undefined;
	const diagnostic = Buffer.from(`${JSON.stringify({ version: 1, kind: "private-assessor-diagnostic",
		stage: input.stage ?? "objective-assessment",
		sequence: number.toString(), sessionId: input.sessionId, generation: input.generation,
		attempt: input.attempt,
		rawResponse: input.rawResponse, validation: input.validation, coverage: input.coverage,
		transcript: priorTranscriptName ? { status: "previously-snapshotted",
			name: priorTranscriptName, scope: "first-rejected-turn" } :
			transcriptName ? { status: "snapshotted", name: transcriptName } :
				{ status: "unavailable", reason: transcript!.status } })}\n`, "utf8");
	if (diagnostic.length > MAX_FILE || transcript?.bytes && transcript.bytes.length > MAX_FILE ||
		tarBytes([...(await existingSizes(root)), diagnostic.length,
			...(transcript?.bytes ? [transcript.bytes.length] : [])]) > MAX_TAR)
		throw new PrivateAssessorDiagnosticError("physical-result-bound");
	let diagnosticTemp: string | undefined, transcriptTemp: string | undefined;
	try {
		if (transcript?.bytes) transcriptTemp = await writePrivateTemp(root, transcript.bytes);
		diagnosticTemp = await writePrivateTemp(root, diagnostic);
		if (transcriptTemp && transcriptName) await link(transcriptTemp, path.join(root, transcriptName));
		await link(diagnosticTemp, path.join(root, diagnosticName));
		await syncDirectory(root);
		if (transcriptName) capturedSessionTranscripts.set(transcriptKey, transcriptName);
		return { diagnosticName, ...(transcriptName ? { transcriptName } : {}),
			transcriptStatus: priorTranscriptName ? "previously-snapshotted" : transcript!.status };
	} catch (error) {
		throw new PrivateAssessorDiagnosticError("write-failed", error);
	} finally {
		for (const file of [diagnosticTemp, transcriptTemp]) if (file)
			try { await unlink(file); } catch { /* An interrupted private temp can be reviewed locally. */ }
	}
}
