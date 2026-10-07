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
import { MissionHostPreparationError, prepareAuthenticatedResumeRequest } from "../src/runner/mission-host-adapter.ts";
import { MissionResumeJournal } from "../src/runner/mission-resume-journal.ts";
import type { CarryArtifactPayload, CurrentMissionRun } from "../src/runner/ledger-continuation.ts";
import { CARRY_LOGICAL_BYTES, CARRY_SEGMENT_FILE_BYTES, CARRY_SEGMENT_RAW_BYTES,
	carrySidecarName } from "../src/runner/carry-sidecar-codec.ts";
import { HarnessError } from "../src/types.ts";

type Args = { source: string; seed: string; publicKey: string;
	journalDir: string; outputPrivate: string; readOnly: boolean; recoverReserved: boolean;
	repairPlanPrivate?: string;
	interruptedSourceReviewPrivate?: string; resultOnlyRepairReviewPrivate?: string;
	linkedUnknownDeliveryOldControlCommit?: string;
	unobservedControlSourceReviewPrivate?: string };
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
class PrivateBridgeError extends Error {
	readonly reasonCode: string;
	readonly osErrorCode?: string;
	constructor(reasonCode: string, cause?: unknown) {
		super(reasonCode); this.reasonCode = reasonCode;
		this.osErrorCode = privateOsErrorCode(cause);
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
	name?: "incremental-control-prefix.json" | "private-campaign-outcome.enc.json";
	archiveSha256?: string;
	sidecars?: ArtifactSidecarFile[];
	prefix?: ArtifactSidecarFile };
const maxSidecars = CARRY_LOGICAL_BYTES / CARRY_SEGMENT_RAW_BYTES;
const maxSidecarTextBytes = Math.ceil(CARRY_SEGMENT_FILE_BYTES * 4 / 3) + 4;
function privateFileReference<T>(value: T): value is T & {
	file: string; sha256: string; name?: unknown } {
	return Boolean(value) && typeof value === "object" &&
		typeof (value as { file?: unknown }).file === "string" &&
		path.isAbsolute((value as { file: string }).file) &&
		typeof (value as { sha256?: unknown }).sha256 === "string" &&
		/^[0-9a-f]{64}$/.test((value as { sha256: string }).sha256);
}
async function verifiedPrivateBytes(reference: { file: string; sha256: string }, max: number): Promise<Buffer> {
	const handle = await open(reference.file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
	try {
		const meta = await handle.stat();
		if (!meta.isFile() || (meta.mode & 0o077) !== 0 || meta.size < 1 || meta.size > max)
			throw new Error("artifact file is not private and regular");
		const bytes = await handle.readFile();
		if (bytes.length !== meta.size ||
			createHash("sha256").update(bytes).digest("hex") !== reference.sha256)
			throw new Error("artifact file changed after connector verification");
		return bytes;
	} finally { await handle.close(); }
}
function canonicalSidecarText(bytes: Buffer): string {
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
	if (decoded.length < 29 || decoded.length > CARRY_SEGMENT_FILE_BYTES ||
		decoded.toString("base64") !== value)
		throw new Error("artifact sidecar encoding is invalid");
	return value;
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
		"--result-only-repair-review-private", "--linked-unknown-control-commit",
		"--unobserved-control-source-review-private"];
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
		...(option.has("--result-only-repair-review-private") ?
			{ resultOnlyRepairReviewPrivate: option.get("--result-only-repair-review-private")! } : {}),
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
		(result.resultOnlyRepairReviewPrivate !== undefined && underRepo(result.resultOnlyRepairReviewPrivate)) ||
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
	close: () => void } {
	const pending = new Map<number, { kind: "github-get" | "artifact-file";
		resolve: (value: unknown) => void;
		reject: (error: Error) => void }>();
	let closed = false;
	const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
	lines.on("line", line => {
		let reply: { id?: unknown; status?: unknown; body?: unknown;
			file?: unknown; sha256?: unknown; name?: unknown; sidecars?: unknown;
			prefix?: unknown; archiveSha256?: unknown };
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
				...(reply.sidecars === undefined ? [] : ["sidecars"]),
				...(reply.prefix === undefined ? [] : ["prefix"])].sort();
			if (!privateFileReference(reply) || keys.join("|") !== expected.join("|") ||
				(reply.archiveSha256 !== undefined &&
					(typeof reply.archiveSha256 !== "string" || !/^[0-9a-f]{64}$/.test(reply.archiveSha256))) ||
				(reply.name !== undefined && !["incremental-control-prefix.json",
					"private-campaign-outcome.enc.json"].includes(String(reply.name))) ||
				(reply.name !== undefined && (reply.prefix !== undefined || reply.sidecars !== undefined)) ||
				(reply.prefix !== undefined && (!privateFileReference(reply.prefix) ||
					Object.keys(reply.prefix).sort().join("|") !== "file|name|sha256" ||
					reply.prefix.name !== "incremental-control-prefix.json")) ||
				(reply.sidecars !== undefined && (!Array.isArray(reply.sidecars) ||
					reply.sidecars.length > maxSidecars ||
					reply.sidecars.some((entry: unknown) => !privateFileReference(entry) ||
						Object.keys(entry).sort().join("|") !== "file|name|sha256" ||
						typeof entry.name !== "string" ||
						!/^ledger-continuation\.part-[0-9]{8}\.enc$/.test(entry.name))))) {
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
	const artifact = async (identity: { runId: string; artifactId: string;
		expectedArchiveSha256?: string }): Promise<string | {
		envelopeB64: string; sidecars: Record<string, string>;
		incrementalControlPrefix?: string } | { incrementalControlPrefix: string }> => {
		if (closed || process.stdin.readableEnded)
			throw new PrivateBridgeError("authenticated-github-connector-stdin-closed");
		const id = ++nextId;
		const reply = new Promise<ArtifactFileReply>((resolve, reject) =>
			pending.set(id, { kind: "artifact-file", resolve: value =>
				resolve(value as ArtifactFileReply), reject }));
		process.stdout.write(`${JSON.stringify({ kind: "artifact-file", id,
			runId: identity.runId, artifactId: identity.artifactId,
			...(identity.expectedArchiveSha256 ?
				{ expectedArchiveSha256: identity.expectedArchiveSha256 } : {}) })}\n`);
		const observed = await reply;
		if (observed.name === "private-campaign-outcome.enc.json")
			throw new Error("carry artifact reply supplied a result envelope");
		if (identity.expectedArchiveSha256 &&
			observed.archiveSha256 !== identity.expectedArchiveSha256)
			throw new Error("artifact ZIP digest does not match authenticated GitHub metadata");
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
			sidecars[item.name] = canonicalSidecarText(await verifiedPrivateBytes(item, maxSidecarTextBytes));
		}
		for (let index = 0; index < observed.sidecars.length; index++)
			if (!Object.hasOwn(sidecars, carrySidecarName(index)))
				throw new Error("artifact sidecar set is invalid");
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
		return verifiedPrivateBytes(observed, 132 * 1024 * 1024);
	};
	return { request, artifact, resultEnvelope, close: () => lines.close() };
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
				...(args.repairPlanPrivate ? { repairPlanPrivateFile: args.repairPlanPrivate } : {}),
				...(args.interruptedSourceReviewPrivate ?
					{ interruptedSourceReviewPrivateFile: args.interruptedSourceReviewPrivate } : {}),
				...(args.resultOnlyRepairReviewPrivate ?
					{ resultOnlyRepairReviewPrivateFile: args.resultOnlyRepairReviewPrivate } : {}),
				...(args.linkedUnknownDeliveryOldControlCommit ?
					{ linkedUnknownDeliveryOldControlCommit: args.linkedUnknownDeliveryOldControlCommit } : {}),
				...(args.unobservedControlSourceReviewPrivate ?
					{ unobservedControlSourceReviewPrivateFile: args.unobservedControlSourceReviewPrivate } : {}),
				journal: new MissionResumeJournal(args.journalDir), readOnly: args.readOnly,
				...(args.recoverReserved ? { recoverReservedDescriptor: true } : {}) });
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
	if (error instanceof MissionHostPreparationError)
		return { code: error.refusal.code, stage: error.refusal.stage,
			...(error.refusal.ciRunId === undefined ? {} : { ciRunId: error.refusal.ciRunId }),
			...(error.refusal.ciStatus === undefined ? {} : { ciStatus: error.refusal.ciStatus }),
			...(error.refusal.ciConclusion === undefined ? {} : { ciConclusion: error.refusal.ciConclusion }),
			...(error.refusal.httpStatus === undefined ? {} : { httpStatus: error.refusal.httpStatus }) };
	if (error instanceof PrivateBridgeError) return { code: error.reasonCode,
		...(error.osErrorCode ? { osErrorCode: error.osErrorCode } : {}) };
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
