import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, realpath, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ObjectiveCapabilityV1, OriginalObjectiveContractV1 } from "./objective-progress.ts";
import { mediaType } from "../media.ts";
import type { CurrentGoal, M07TaskRecord, TaskReviewInput } from "./types.ts";
import { resolveExpectedOutputFiles } from "./expected-output.ts";
import { trustedLocalMissionEvaluator, type LocalCandidateSnapshot,
	validEvaluatorSchemaErrors, validatedTaskInputContract,
	type LocalEvaluatorCheck, type LocalMissionEvaluator } from "./local-mission-evaluator.ts";
import type { LocalFrozenOriginalIdentity, LocalEvaluationReconcileResult } from "./local-mission-evaluator.ts";
import { HarnessError } from "../types.ts";
import { probeProcessIdentity, readCurrentProcessIdentity,
	type ProcessIdentityV1 } from "../runtime/process-identity.ts";

const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const inside = (root: string, file: string) => file.startsWith(`${root}${path.sep}`);
const RECEIPT = "local-evaluator-receipt.json";
const ATTEMPT_DIR = "host-evaluator-attempt";
const observationName = /^observation-[A-Za-z0-9][A-Za-z0-9._-]{0,79}\.(?:txt|md|json|jsonl|csv|tsv)$/;

export interface LocalEvaluatorObservation {
	name: string; kind: "text" | "json";
	sourceFile: string; file: string; bytes: number; sha256: string;
	binding: { missionId: string; runId: string; taskId: string;
		evaluatorId: string; evaluatorVersion: string;
		candidate: Array<{ name: string; sha256: string }> };
}

export interface LocalEvaluatorReceiptV1 {
	version: 1; kind: "local-evaluator-receipt";
	missionId: string; runId: string; taskId: string;
	evaluator: { id: string; version: string };
	candidate: LocalCandidateSnapshot[];
	observations: LocalEvaluatorObservation[];
	frozenEvidence: Array<{ name: string; file: string; bytes: number; sha256: string }>;
	checks: LocalEvaluatorCheck[];
	limitations: string[];
}

export interface LocalEvaluatorRunInput {
	contract: OriginalObjectiveContractV1; goal: CurrentGoal; task: M07TaskRecord;
	evidence: readonly { name: string; file: string }[];
	evaluatorId: string | undefined;
	frozenOriginalInputs: readonly LocalFrozenOriginalIdentity[];
	capabilities: readonly ObjectiveCapabilityV1[];
	/** A dead-owner host recovery must reject uncopied post-return source edits. */
	recoveryPreEntry?: boolean;
}
export interface LocalEvaluatorRunOutcome { receipt: LocalEvaluatorReceiptV1;
	receiptFile: string; review: TaskReviewInput }
export interface LocalEvaluatorAttemptEnteredV1 {
	version: 1; kind: "local-evaluator-attempt"; attemptId: string;
	missionId: string; runId: string; taskId: string;
	evaluator: { id: string; version: string }; process: ProcessIdentityV1;
	candidate: LocalCandidateSnapshot[];
	frozenEvidence: Array<{ name: string; file: string; bytes: number; sha256: string }>;
	resolvedFailures: string[];
}
export interface LocalEvaluatorPreparedInputV1 {
	version: 1; kind: "local-evaluator-prepared-input";
	missionId: string; runId: string; taskId: string;
	evaluator: { id: string; version: string };
	candidate: LocalCandidateSnapshot[];
	frozenEvidence: Array<{ name: string; file: string; bytes: number; sha256: string }>;
	resolvedFailures: string[];
}
export interface LocalEvaluatorAttemptReturnedV1 {
	version: 1; kind: "local-evaluator-returned"; attemptId: string;
	result: { checks: LocalEvaluatorCheck[];
		observations: Array<{ name: string; kind: "text" | "json" }>;
		limitations: string[] };
	outputs: Array<{ name: string; bytes: number; sha256: string }>;
}
export interface LocalEvaluatorAttemptThrewV1 {
	version: 1; kind: "local-evaluator-threw"; attemptId: string;
	process: ProcessIdentityV1;
}
export interface LocalEvaluatorAttemptReturnedUncommittedV1 {
	version: 1; kind: "local-evaluator-returned-uncommitted"; attemptId: string;
	process: ProcessIdentityV1;
}
export interface LocalEvaluatorAttemptSettledFailureV1 {
	version: 1; kind: "local-evaluator-settled-failure"; attemptId: string;
	proof: Extract<LocalEvaluationReconcileResult, { state: "settled-failure" }>["proof"];
	partialOutputs: Array<{ name: string; bytes: number; sha256: string }>;
}
export type LocalEvaluatorPreEntryOrphanName = "prepared.json.pending" |
	"prepared.json" | "prepared.sha256.pending";
export type LocalEvaluatorAttemptState =
	| { state: "absent" }
	| { state: "pre-entry-unlocated";
		orphanMembers: Array<{ name: LocalEvaluatorPreEntryOrphanName; sha256: string }> }
	| { state: "pre-entry" }
	| { state: "entered"; attempt: LocalEvaluatorAttemptEnteredV1 }
	| { state: "threw"; attempt: LocalEvaluatorAttemptEnteredV1;
		threw?: LocalEvaluatorAttemptThrewV1 }
	| { state: "returned-uncommitted"; attempt: LocalEvaluatorAttemptEnteredV1;
		marker?: LocalEvaluatorAttemptReturnedUncommittedV1 }
	| { state: "returned"; attempt: LocalEvaluatorAttemptEnteredV1;
		returned: LocalEvaluatorAttemptReturnedV1 }
	| { state: "settled-failure"; attempt: LocalEvaluatorAttemptEnteredV1;
		settled: LocalEvaluatorAttemptSettledFailureV1 };

function validProcess(value: unknown): value is ProcessIdentityV1 {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const item = value as Partial<ProcessIdentityV1>;
	return typeof item.hostId === "string" && item.hostId.length > 0 && item.hostId.length <= 256 &&
		typeof item.bootId === "string" && item.bootId.length > 0 && item.bootId.length <= 256 &&
		Number.isSafeInteger(item.pid) && Number(item.pid) > 0 &&
		typeof item.processStartToken === "string" &&
		item.processStartToken.length > 0 && item.processStartToken.length <= 256;
}

function validSettlementProof(value: unknown, attempt: LocalEvaluatorAttemptEnteredV1): boolean {
	if (!dataOnly(value) || !value || typeof value !== "object" || Array.isArray(value)) return false;
	const proof = value as LocalEvaluatorAttemptSettledFailureV1["proof"];
	return proof.attemptId === attempt.attemptId && validProcess(proof.process) &&
		JSON.stringify(proof.process) === JSON.stringify(attempt.process) &&
		typeof proof.operationId === "string" &&
		/^[-A-Za-z0-9._:]{1,160}$/.test(proof.operationId) &&
		Array.isArray(proof.childProcesses) && proof.childProcesses.every(validProcess) &&
		["no-effect", "contained"].includes(proof.settledEffect) &&
		typeof proof.evidence === "string" && !!proof.evidence.trim() &&
		proof.evidence.length <= 4096;
}

async function exactDirectory(root: string, expected: readonly string[]): Promise<void> {
	const info = await lstat(root);
	if (!info.isDirectory() || info.isSymbolicLink() ||
		(typeof process.getuid === "function" && info.uid !== process.getuid()) ||
		(info.mode & 0o077) !== 0 ||
		await realpath(root) !== root)
		throw new HarnessError("local.evaluator.observation", "evaluator observation directory is not host-owned");
	const entries = await readdir(root, { withFileTypes: true });
	if (entries.some(entry => !entry.isFile() || entry.isSymbolicLink()) ||
		JSON.stringify(entries.map(entry => entry.name).sort()) !== JSON.stringify([...expected].sort()))
		throw new HarnessError("local.evaluator.observation", "evaluator observation members are missing or extra");
}

function observationText(bytes: Buffer, kind: "text" | "json"): void {
	const value = bytes.toString("utf8");
	if (!Buffer.from(value, "utf8").equals(bytes) || value.includes("\0"))
		throw new HarnessError("local.evaluator.observation", "observation is not valid UTF-8 text");
	if (kind === "json") {
		try { JSON.parse(value); }
		catch { throw new HarnessError("local.evaluator.observation", "declared JSON observation is invalid"); }
	}
}

async function boundedFile(file: string, root?: string, allowEmpty = false,
	role = "evidence"): Promise<Buffer> {
	const info = await lstat(file);
	const resolved = await realpath(file);
	const invalid = !info.isFile() ? "not-regular" : info.isSymbolicLink() ? "symbolic-link" :
		info.nlink !== 1 ? "link-count" : info.size < 0 ? "invalid-size" :
		!allowEmpty && info.size === 0 ? "empty" : info.size > 8 * 1024 * 1024 ? "too-large" :
		root && !inside(root, resolved) ? "outside-root" : undefined;
	if (invalid) throw new HarnessError("local.evaluator.file", `${role}: ${invalid}`);
	const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	try {
		const before = await handle.stat();
		const bytes = await handle.readFile();
		const after = await handle.stat();
		if (bytes.length !== before.size || before.dev !== after.dev || before.ino !== after.ino ||
			before.size !== after.size)
			throw new HarnessError("local.evaluator.file", `${role}: changed-during-read`);
		return bytes;
	} finally { await handle.close(); }
}

async function opaquePartialIdentities(dir: string, names: readonly string[]):
	Promise<Array<{ name: string; bytes: number; sha256: string }>> {
	if (new Set(names).size !== names.length ||
		names.some(name => !observationName.test(name)))
		throw new HarnessError("local.evaluator.attempt", "partial observation names are invalid");
	await exactDirectory(dir, names);
	const found = [];
	for (const name of names) {
		const file = path.join(dir, name);
		if (((await lstat(file)).mode & 0o077) !== 0)
			throw new HarnessError("local.evaluator.attempt", "partial observation is not private");
		const bytes = await boundedFile(file, dir, true);
		found.push({ name, bytes: bytes.length, sha256: digest(bytes) });
	}
	return found;
}

function dataOnly(value: unknown, depth = 0, seen = new Set<object>()): boolean {
	if (depth > 16) return false;
	if (value === null || typeof value === "string" || typeof value === "boolean") return true;
	if (typeof value === "number") return Number.isFinite(value);
	if (typeof value !== "object" || seen.has(value)) return false;
	if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype) return false;
	seen.add(value);
	const good = Array.isArray(value) ? value.every(item => dataOnly(item, depth + 1, seen)) :
		Object.entries(value).every(([key, item]) =>
			!["__proto__", "constructor", "prototype"].includes(key) &&
			dataOnly(item, depth + 1, seen));
	seen.delete(value);
	return good;
}

function jsonBytes(value: unknown): Buffer {
	if (!dataOnly(value)) throw new HarnessError("local.evaluator.attempt", "evaluator result is not data-only");
	const bytes = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
	if (bytes.length > 512 * 1024) throw new HarnessError("local.evaluator.attempt", "evaluator journal exceeds limit");
	return bytes;
}

function attemptRoot(task: M07TaskRecord): string {
	return path.join(path.dirname(task.workDir), ATTEMPT_DIR);
}

async function privateAttemptDir(dir: string, create: boolean): Promise<boolean> {
	if (create) {
		try { await mkdir(dir, { mode: 0o700 }); }
		catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
	}
	let info;
	try { info = await lstat(dir); }
	catch (error) {
		if (!create && (error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
	if (!info.isDirectory() || info.isSymbolicLink() || info.nlink < 2 ||
		(typeof process.getuid === "function" && info.uid !== process.getuid()) ||
		(info.mode & 0o077) !== 0 || await realpath(dir) !== dir)
		throw new HarnessError("local.evaluator.attempt", "attempt directory is not private and direct");
	return true;
}

async function syncDirectory(dir: string): Promise<void> {
	const handle = await open(dir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
	try { await handle.sync(); }
	finally { await handle.close(); }
}

async function immutableWrite(file: string, bytes: Buffer, mode = 0o600): Promise<void> {
	const handle = await open(file, constants.O_WRONLY | constants.O_CREAT |
		constants.O_EXCL | constants.O_NOFOLLOW, mode);
	try { await handle.writeFile(bytes); await handle.sync(); }
	finally { await handle.close(); }
	await syncDirectory(path.dirname(file));
}

async function writeJournal(dir: string, name: string, value: unknown): Promise<void> {
	await privateAttemptDir(dir, true);
	const bytes = jsonBytes(value);
	if (name === "prepared") {
		const staging = path.join(dir, "prepared.json.pending");
		await immutableWrite(staging, bytes, 0o400);
		await rename(staging, path.join(dir, "prepared.json"));
		await syncDirectory(dir);
	} else await immutableWrite(path.join(dir, `${name}.json`), bytes, 0o400);
	await writeJournalSeal(dir, name, bytes);
}

async function writeJournalSeal(dir: string, name: string, bytes: Buffer): Promise<void> {
	const pending = path.join(dir, `${name}.sha256.pending`);
	await immutableWrite(pending, Buffer.from(`${digest(bytes)}\n`), 0o400);
	await rename(pending, path.join(dir, `${name}.sha256`));
	await syncDirectory(dir);
}

async function sealVerifiedPrepared(dir: string): Promise<void> {
	const names = await readdir(dir);
	if (names.includes("prepared.sha256")) return;
	const file = path.join(dir, "prepared.json");
	const bytes = await journalBytes(file);
	parseJournalBytes<LocalEvaluatorPreparedInputV1>(bytes);
	const pending = path.join(dir, "prepared.sha256.pending");
	if (names.includes("prepared.sha256.pending")) {
		await unsealedJournalMember(pending);
		await unlink(pending);
		await syncDirectory(dir);
	}
	await writeJournalSeal(dir, "prepared", bytes);
}

async function journalBytes(file: string): Promise<Buffer> {
	const info = await lstat(file);
	if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 ||
		(typeof process.getuid === "function" && info.uid !== process.getuid()) ||
		(info.mode & 0o777) !== 0o400 || info.size < 1 || info.size > 512 * 1024)
		throw new HarnessError("local.evaluator.attempt", "attempt journal member is invalid");
	const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	try {
		const before = await handle.stat();
		const bytes = await handle.readFile();
		const after = await handle.stat();
		if (before.ino !== after.ino || before.dev !== after.dev || before.size !== after.size ||
			bytes.length !== before.size) throw new HarnessError("local.evaluator.attempt", "attempt journal changed during read");
		return bytes;
	} finally { await handle.close(); }
}

async function unsealedJournalMember(file: string): Promise<void> {
	const info = await lstat(file);
	if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 ||
		(typeof process.getuid === "function" && info.uid !== process.getuid()) ||
		(info.mode & 0o777) !== 0o400 || info.size > 512 * 1024)
		throw new HarnessError("local.evaluator.attempt", "incomplete journal member is invalid");
}

async function preEntryOrphanMembers(dir: string, names: readonly string[]):
	Promise<Array<{ name: LocalEvaluatorPreEntryOrphanName; sha256: string }>> {
	const allowed = new Set(["prepared.json.pending", "prepared.json", "prepared.sha256.pending"]);
	if (!names.length || names.some(name => !allowed.has(name)))
		throw new HarnessError("local.evaluator.attempt", "pre-entry orphan members are invalid");
	const result: Array<{ name: LocalEvaluatorPreEntryOrphanName; sha256: string }> = [];
	for (const name of [...names].sort()) {
		const file = path.join(dir, name);
		await unsealedJournalMember(file);
		result.push({ name: name as LocalEvaluatorPreEntryOrphanName,
			sha256: digest(await boundedFile(file, undefined, true)) });
	}
	return result;
}

async function verifyNoPreEntryEvaluatorOutput(task: M07TaskRecord): Promise<void> {
	const root = await realpath(path.dirname(task.workDir));
	await exactDirectory(path.join(root, "host-evaluator-output"), []);
	await exactDirectory(path.join(root, "host-evaluator-snapshot"), []);
}

async function clearUnsealedPhase(dir: string, phase: string): Promise<void> {
	const names = await readdir(dir);
	if (names.includes(`${phase}.sha256`))
		throw new HarnessError("local.evaluator.attempt", "cannot replace sealed attempt phase");
	for (const name of [`${phase}.sha256.pending`, `${phase}.json`]) {
		if (!names.includes(name)) continue;
		const file = path.join(dir, name);
		await unsealedJournalMember(file);
		await unlink(file);
	}
	await syncDirectory(dir);
}

async function readJournal<T>(dir: string, name: string): Promise<T> {
	const bytes = await journalBytes(path.join(dir, `${name}.json`));
	const seal = await journalBytes(path.join(dir, `${name}.sha256`));
	if (seal.toString("utf8") !== `${digest(bytes)}\n`)
		throw new HarnessError("local.evaluator.attempt", "attempt journal seal differs");
	return parseJournalBytes<T>(bytes);
}

function parseJournalBytes<T>(bytes: Buffer): T {
	let value: unknown;
	try { value = JSON.parse(bytes.toString("utf8")); }
	catch { throw new HarnessError("local.evaluator.attempt", "attempt journal is invalid JSON"); }
	if (!dataOnly(value) || !jsonBytes(value).equals(bytes))
		throw new HarnessError("local.evaluator.attempt", "attempt journal is not canonical data");
	return value as T;
}

async function outputIdentities(dir: string, declarations: readonly { name: string; kind: "text" | "json" }[]):
	Promise<Array<{ name: string; bytes: number; sha256: string }>> {
	if (!Array.isArray(declarations) || new Set(declarations.map(item => item?.name)).size !== declarations.length ||
		declarations.some(item => !item || typeof item.name !== "string" ||
			!observationName.test(item.name) || !["text", "json"].includes(item.kind) ||
			(item.kind === "json" && !item.name.endsWith(".json"))))
		throw new HarnessError("local.evaluator.observation", "observation declarations are invalid");
	await exactDirectory(dir, declarations.map(item => item.name));
	const outputs = [];
	for (const item of declarations) {
		const file = path.join(dir, item.name);
		if (((await lstat(file)).mode & 0o077) !== 0)
			throw new HarnessError("local.evaluator.observation", "evaluator output file is not private");
		const bytes = await boundedFile(file, dir);
		observationText(bytes, item.kind);
		outputs.push({ name: item.name, bytes: bytes.length, sha256: digest(bytes) });
	}
	return outputs;
}

export async function requireLocalEvaluator(contract: OriginalObjectiveContractV1,
	id: string | undefined, facts: { frozenOriginalInputs: readonly LocalFrozenOriginalIdentity[];
		capabilities: readonly ObjectiveCapabilityV1[] }): Promise<LocalMissionEvaluator> {
	const evaluator = trustedLocalMissionEvaluator(id);
	if (!evaluator) throw new HarnessError("local.evaluator.capability",
		id ? `trusted evaluator ${id} is not registered` : "local objective needs a configured trusted host evaluator");
	const supported = new Set(evaluator.supportedObligationTypes);
	if (contract.obligations.some(item => !supported.has(item.type ?? "general")))
		throw new HarnessError("local.evaluator.capability", `trusted evaluator ${id} does not support every obligation type`);
	const preflight = await evaluator.preflight({ contract,
		frozenOriginalInputs: facts.frozenOriginalInputs,
		capabilities: facts.capabilities });
	if (!preflight.available) throw new HarnessError("local.evaluator.capability",
		preflight.reason || `trusted evaluator ${id} preflight declined this objective`);
	return evaluator;
}

/** A sealed, owner-independent input locator. It never parses entered.json. */
export async function readPreparedLocalEvaluatorInput(input: Pick<LocalEvaluatorRunInput,
	"contract" | "goal" | "task" | "evaluatorId">):
	Promise<LocalEvaluatorPreparedInputV1 | undefined> {
	const dir = attemptRoot(input.task);
	if (!await privateAttemptDir(dir, false)) return undefined;
	const names = await readdir(dir);
	if (!names.includes("prepared.json")) {
		if (names.length === 1 && names[0] === "prepared.json.pending") {
			await unsealedJournalMember(path.join(dir, "prepared.json.pending"));
			return undefined;
		}
		if (!names.length) return undefined;
		throw new HarnessError("local.evaluator.attempt", "prepared manifest has no input record");
	}
	let prepared: LocalEvaluatorPreparedInputV1;
	if (names.includes("prepared.sha256"))
		prepared = await readJournal<LocalEvaluatorPreparedInputV1>(dir, "prepared");
	else {
		if (names.some(name => !["prepared.json", "prepared.sha256.pending"].includes(name)))
			throw new HarnessError("local.evaluator.attempt", "unsealed prepared manifest has later phases");
		if (names.includes("prepared.sha256.pending"))
			await unsealedJournalMember(path.join(dir, "prepared.sha256.pending"));
		const file = path.join(dir, "prepared.json");
		await unsealedJournalMember(file);
		if ((await lstat(file)).size === 0) return undefined;
		const bytes = await journalBytes(file);
		try { prepared = parseJournalBytes<LocalEvaluatorPreparedInputV1>(bytes); }
		catch (error) {
			if (error instanceof HarnessError && error.code === "local.evaluator.attempt")
				return undefined;
			throw error;
		}
	}
	const evaluator = trustedLocalMissionEvaluator(input.evaluatorId);
	if (!evaluator || prepared.kind !== "local-evaluator-prepared-input" ||
		prepared.version !== 1 || prepared.missionId !== input.contract.id ||
		prepared.runId !== input.goal.runId || prepared.taskId !== input.task.taskId ||
		prepared.evaluator?.id !== evaluator.id || prepared.evaluator.version !== evaluator.version ||
		!Array.isArray(prepared.candidate) || !prepared.candidate.length ||
		!Array.isArray(prepared.frozenEvidence) || !Array.isArray(prepared.resolvedFailures) ||
		prepared.resolvedFailures.some(item => typeof item !== "string") ||
		new Set([...prepared.candidate.map(item => item?.name),
			...prepared.frozenEvidence.map(item => item?.name)]).size !==
			prepared.candidate.length + prepared.frozenEvidence.length)
		throw new HarnessError("local.evaluator.attempt", "prepared evaluator inputs have the wrong binding");
	const taskRoot = await realpath(path.dirname(input.task.workDir));
	await exactDirectory(path.join(taskRoot, "evaluator-snapshot"),
		prepared.candidate.map(item => item.name));
	const resolved = await resolveExpectedOutputFiles(input.task.workDir, input.task.expectedOutputPaths);
	const sources = [...new Set([input.task.reportPath,
		...resolved.flatMap(item => item.error ? [] : item.files)].filter((file): file is string => !!file))];
	if (JSON.stringify(sources) !== JSON.stringify(prepared.candidate.map(item => item.sourceFile)) ||
		JSON.stringify(resolved.flatMap(item => item.error ? [item.error] : [])) !==
			JSON.stringify(prepared.resolvedFailures))
		throw new HarnessError("local.evaluator.attempt", "prepared candidate paths changed");
	for (const item of prepared.candidate) {
		if (!item || typeof item.name !== "string" || path.basename(item.name) !== item.name ||
			item.file !== path.join(taskRoot, "evaluator-snapshot", item.name) ||
			!Number.isSafeInteger(item.bytes) ||
			(item.sourceFile === input.task.reportPath ? item.bytes < 1 : item.bytes < 0) ||
			!/^[0-9a-f]{64}$/.test(item.sha256))
			throw new HarnessError("local.evaluator.attempt", "prepared candidate identity is invalid");
		const source = await boundedFile(item.sourceFile, taskRoot, item.sourceFile !== input.task.reportPath,
			item.sourceFile === input.task.reportPath ? "task report" : "candidate source");
		const snapshot = await boundedFile(item.file, path.join(taskRoot, "evaluator-snapshot"),
			item.sourceFile !== input.task.reportPath, "candidate snapshot");
		if (source.length !== item.bytes || snapshot.length !== item.bytes ||
			digest(source) !== item.sha256 || digest(snapshot) !== item.sha256)
			throw new HarnessError("local.evaluator.attempt", "prepared candidate bytes changed after evaluation");
	}
	for (const item of prepared.frozenEvidence) {
		if (!item || typeof item.name !== "string" || !item.name ||
			typeof item.file !== "string" || !Number.isSafeInteger(item.bytes) || item.bytes < 1 ||
			!/^[0-9a-f]{64}$/.test(item.sha256))
			throw new HarnessError("local.evaluator.attempt", "prepared evidence identity is invalid");
		const bytes = await boundedFile(item.file);
		if (bytes.length !== item.bytes || digest(bytes) !== item.sha256)
			throw new HarnessError("local.evaluator.attempt", "prepared evidence bytes changed");
	}
	return prepared;
}

/** Reads only host journal data and frozen bytes; it never calls evaluator code. */
export async function readLocalEvaluatorAttempt(input: LocalEvaluatorRunInput):
	Promise<LocalEvaluatorAttemptState> {
	const dir = attemptRoot(input.task);
	if (!await privateAttemptDir(dir, false)) return { state: "absent" };
	const names = (await readdir(dir)).sort();
	if (!names.length) return { state: "absent" };
	const phases = ["prepared", "entered", "threw", "returned-uncommitted", "returned", "settled-failure"];
	const has = (phase: string) => names.includes(`${phase}.json`);
	const sealed = (phase: string) => names.includes(`${phase}.sha256`);
	const pending = (phase: string) => names.includes(`${phase}.sha256.pending`);
	if (names.some(name => !phases.some(phase =>
		name === `${phase}.json` || name === `${phase}.sha256` ||
		name === `${phase}.sha256.pending` ||
		(phase === "prepared" && name === "prepared.json.pending"))) ||
		phases.some(phase => sealed(phase) && !has(phase)) ||
		phases.some(phase => pending(phase) && (!has(phase) || sealed(phase))) ||
		(has("threw") && (has("returned-uncommitted") || has("returned"))) ||
		(has("returned") && !has("returned-uncommitted")) ||
		(has("settled-failure") && has("returned" ) && sealed("returned")))
		throw new HarnessError("local.evaluator.attempt", "attempt journal members are missing or extra");
	for (const phase of phases) if (pending(phase))
		await unsealedJournalMember(path.join(dir, `${phase}.sha256.pending`));
	if (!has("prepared")) {
		if (names.length === 1 && names[0] === "prepared.json.pending") {
			await verifyNoPreEntryEvaluatorOutput(input.task);
			return { state: "pre-entry-unlocated",
				orphanMembers: await preEntryOrphanMembers(dir, names) };
		}
		throw new HarnessError("local.evaluator.attempt", "prepared inputs are missing");
	}
	if (names.includes("prepared.json.pending"))
		throw new HarnessError("local.evaluator.attempt", "prepared staging and published files coexist");
	const prepared = await readPreparedLocalEvaluatorInput(input);
	if (!sealed("prepared")) {
		if (has("entered") || names.some(name => !["prepared.json", "prepared.sha256.pending"].includes(name)))
			throw new HarnessError("local.evaluator.attempt", "unsealed prepared inputs have later phases");
		if (!prepared) {
			await verifyNoPreEntryEvaluatorOutput(input.task);
			return { state: "pre-entry-unlocated",
				orphanMembers: await preEntryOrphanMembers(dir, names) };
		}
	}
	if (!prepared) throw new HarnessError("local.evaluator.attempt", "prepared inputs are missing");
	if (JSON.stringify(input.evidence) !== JSON.stringify(prepared.frozenEvidence.map(item =>
		({ name: item.name, file: item.file }))))
		throw new HarnessError("local.evaluator.attempt", "prepared evidence locator differs from caller");
	if (!has("entered")) {
		if (names.every(name => name === "prepared.json" || name === "prepared.sha256" ||
			name === "prepared.sha256.pending"))
			return { state: "pre-entry" };
		throw new HarnessError("local.evaluator.attempt", "attempt phase exists before evaluator entry");
	}
	if (!sealed("entered")) {
		if (names.every(name => name === "prepared.json" || name === "prepared.sha256" ||
			name === "entered.json" || name === "entered.sha256.pending")) {
			await unsealedJournalMember(path.join(dir, "entered.json"));
			return { state: "pre-entry" };
		}
		throw new HarnessError("local.evaluator.attempt", "unsealed entered attempt has later phases");
	}
	const attempt = await readJournal<LocalEvaluatorAttemptEnteredV1>(dir, "entered");
	const evaluator = trustedLocalMissionEvaluator(input.evaluatorId);
	if (!evaluator || attempt.version !== 1 || attempt.kind !== "local-evaluator-attempt" ||
		!attempt.attemptId || attempt.missionId !== input.contract.id ||
		attempt.runId !== input.goal.runId || attempt.taskId !== input.task.taskId ||
		attempt.evaluator?.id !== evaluator.id || attempt.evaluator.version !== evaluator.version ||
		!Array.isArray(attempt.candidate) || !attempt.candidate.length ||
		!Array.isArray(attempt.frozenEvidence) || !Array.isArray(attempt.resolvedFailures) ||
		!validProcess(attempt.process) ||
		JSON.stringify(attempt.candidate) !== JSON.stringify(prepared.candidate) ||
		JSON.stringify(attempt.frozenEvidence) !== JSON.stringify(prepared.frozenEvidence) ||
		JSON.stringify(attempt.resolvedFailures) !== JSON.stringify(prepared.resolvedFailures))
		throw new HarnessError("local.evaluator.attempt", "attempt identity differs from trusted evaluator or task");
	const taskRoot = await realpath(path.dirname(input.task.workDir));
	await exactDirectory(path.join(taskRoot, "evaluator-snapshot"),
		attempt.candidate.map(item => item.name));
	const resolved = await resolveExpectedOutputFiles(input.task.workDir, input.task.expectedOutputPaths);
	const sources = [...new Set([input.task.reportPath,
		...resolved.flatMap(item => item.error ? [] : item.files)].filter((file): file is string => !!file))];
	if (JSON.stringify(sources) !== JSON.stringify(attempt.candidate.map(item => item.sourceFile)) ||
		JSON.stringify(resolved.flatMap(item => item.error ? [item.error] : [])) !==
		JSON.stringify(attempt.resolvedFailures) ||
		JSON.stringify(input.evidence) !== JSON.stringify(attempt.frozenEvidence.map(item =>
			({ name: item.name, file: item.file }))))
		throw new HarnessError("local.evaluator.attempt", "attempt input paths or resolved outputs changed");
	for (const item of attempt.candidate) {
		if (item.file !== path.join(taskRoot, "evaluator-snapshot", item.name) ||
			path.basename(item.name) !== item.name || !/^[0-9a-f]{64}$/.test(item.sha256))
			throw new HarnessError("local.evaluator.attempt", "candidate snapshot identity is invalid");
		const source = await boundedFile(item.sourceFile, taskRoot, item.sourceFile !== input.task.reportPath,
			item.sourceFile === input.task.reportPath ? "task report" : "candidate source");
		const snapshot = await boundedFile(item.file, path.join(taskRoot, "evaluator-snapshot"),
			item.sourceFile !== input.task.reportPath, "candidate snapshot");
		if (source.length !== item.bytes || snapshot.length !== item.bytes ||
			digest(source) !== item.sha256 || digest(snapshot) !== item.sha256)
			throw new HarnessError("local.evaluator.attempt", "candidate bytes changed after evaluation");
	}
	for (const item of attempt.frozenEvidence) {
		const bytes = await boundedFile(item.file);
		if (bytes.length !== item.bytes || digest(bytes) !== item.sha256)
			throw new HarnessError("local.evaluator.attempt", "frozen evidence differs from entered identity");
	}
	let threw: LocalEvaluatorAttemptThrewV1 | undefined;
	if (has("threw")) {
		if (sealed("threw")) {
			threw = await readJournal<LocalEvaluatorAttemptThrewV1>(dir, "threw");
			if (threw.kind !== "local-evaluator-threw" || threw.version !== 1 ||
				threw.attemptId !== attempt.attemptId ||
				JSON.stringify(threw.process) !== JSON.stringify(attempt.process))
				throw new HarnessError("local.evaluator.attempt", "threw phase is not bound to entered attempt");
		} else await unsealedJournalMember(path.join(dir, "threw.json"));
		if (!has("settled-failure")) return { state: "threw", attempt, threw };
	}
	let marker: LocalEvaluatorAttemptReturnedUncommittedV1 | undefined;
	if (has("returned-uncommitted")) {
		if (sealed("returned-uncommitted")) {
			marker = await readJournal<LocalEvaluatorAttemptReturnedUncommittedV1>(dir, "returned-uncommitted");
			if (marker.kind !== "local-evaluator-returned-uncommitted" || marker.version !== 1 ||
				marker.attemptId !== attempt.attemptId ||
				JSON.stringify(marker.process) !== JSON.stringify(attempt.process))
				throw new HarnessError("local.evaluator.attempt", "return boundary is not bound to entered attempt");
		} else await unsealedJournalMember(path.join(dir, "returned-uncommitted.json"));
		if (!sealed("returned-uncommitted") && !has("settled-failure"))
			return { state: "returned-uncommitted", attempt, marker };
		if ((!has("returned") || !sealed("returned")) && !has("settled-failure"))
			return { state: "returned-uncommitted", attempt, marker };
	}
	if (has("returned") && sealed("returned") && sealed("returned-uncommitted")) {
		const returned = await readJournal<LocalEvaluatorAttemptReturnedV1>(dir, "returned");
		if (returned.kind !== "local-evaluator-returned" || returned.version !== 1 ||
			returned.attemptId !== attempt.attemptId || !Array.isArray(returned.outputs) ||
			!Array.isArray(returned.result?.checks) ||
			!Array.isArray(returned.result?.observations) ||
			!Array.isArray(returned.result?.limitations))
			throw new HarnessError("local.evaluator.attempt", "returned phase is not bound to entered attempt");
		const actual = await outputIdentities(path.join(taskRoot, "host-evaluator-output"),
			returned.result.observations);
		if (JSON.stringify(actual) !== JSON.stringify(returned.outputs))
			throw new HarnessError("local.evaluator.attempt", "returned observation bytes changed");
		return { state: "returned", attempt, returned };
	}
	if (has("returned") && !sealed("returned") && !has("settled-failure")) {
		await unsealedJournalMember(path.join(dir, "returned.json"));
		return { state: "returned-uncommitted", attempt, marker };
	}
	if (!has("settled-failure")) return { state: "entered", attempt };
	if (!sealed("settled-failure")) {
		await unsealedJournalMember(path.join(dir, "settled-failure.json"));
		if (has("threw")) return { state: "threw", attempt, threw };
		if (has("returned-uncommitted"))
			return { state: "returned-uncommitted", attempt, marker };
		return { state: "entered", attempt };
	}
	const settled = await readJournal<LocalEvaluatorAttemptSettledFailureV1>(dir, "settled-failure");
	if (settled.kind !== "local-evaluator-settled-failure" || settled.version !== 1 ||
		settled.attemptId !== attempt.attemptId || !Array.isArray(settled.partialOutputs) ||
		!validSettlementProof(settled.proof, attempt))
		throw new HarnessError("local.evaluator.attempt", "settled failure is not bound to entered attempt");
	const actual = await opaquePartialIdentities(path.join(taskRoot, "host-evaluator-output"),
		settled.partialOutputs.map(item => item.name));
	if (JSON.stringify(actual) !== JSON.stringify(settled.partialOutputs))
		throw new HarnessError("local.evaluator.attempt", "partial observation bytes changed");
	await exactDirectory(path.join(taskRoot, "host-evaluator-failure-snapshot"),
		settled.partialOutputs.map(item => item.name));
	for (const item of settled.partialOutputs) {
		const bytes = await boundedFile(path.join(taskRoot, "host-evaluator-failure-snapshot", item.name),
			path.join(taskRoot, "host-evaluator-failure-snapshot"), true);
		if (bytes.length !== item.bytes || digest(bytes) !== item.sha256)
			throw new HarnessError("local.evaluator.attempt", "partial observation snapshot changed");
	}
	return { state: "settled-failure", attempt, settled };
}

export async function verifyLocalEvaluatorReceipt(receipt: LocalEvaluatorReceiptV1,
	contract: OriginalObjectiveContractV1, goal: CurrentGoal, task: M07TaskRecord): Promise<void> {
	if (receipt.version !== 1 || receipt.kind !== "local-evaluator-receipt" ||
		receipt.missionId !== contract.id || receipt.runId !== goal.runId ||
		receipt.taskId !== task.taskId || !receipt.candidate.length ||
		!Array.isArray(receipt.observations) ||
		new Set(receipt.observations.map(item => item.name)).size !== receipt.observations.length ||
		receipt.observations.some(item => !observationName.test(item.name) ||
			!["text", "json"].includes(item.kind) ||
			(item.kind === "json" && !item.name.endsWith(".json")) ||
			mediaType(item.name) !== "text") ||
		new Set([...receipt.candidate.map(item => item.name),
			...receipt.frozenEvidence.map(item => item.name),
			...receipt.observations.map(item => item.name)]).size !==
			receipt.candidate.length + receipt.frozenEvidence.length + receipt.observations.length ||
		receipt.checks.length !== contract.obligations.length ||
		new Set(receipt.checks.map(item => item.obligationId)).size !== receipt.checks.length ||
		new Set(receipt.candidate.map(item => item.name)).size !== receipt.candidate.length ||
		receipt.checks.some(item => !contract.obligations.some(ob => ob.id === item.obligationId) ||
			!["passed", "failed", "not_run", "unknown"].includes(item.result) ||
			!Array.isArray(item.evidenceRefs) || !Array.isArray(item.limitations) ||
			(item.schemaErrors !== undefined && (!validEvaluatorSchemaErrors(item.schemaErrors) ||
				item.schemaErrors.some(error => item.result === "passed"))) ||
			item.evidenceRefs.some(ref => !receipt.candidate.some(candidate => candidate.name === ref) &&
				!receipt.frozenEvidence.some(file => file.name === ref) &&
				!receipt.observations.some(file => file.name === ref)) ||
			(item.result === "passed" && !item.evidenceRefs.length)))
		throw new HarnessError("local.evaluator.receipt", "evaluator receipt has mismatched mission, task or checks");
	const taskRoot = await realpath(path.dirname(task.workDir));
	const outputDir = path.join(taskRoot, "host-evaluator-output");
	const snapshotDir = path.join(taskRoot, "host-evaluator-snapshot");
	await exactDirectory(outputDir, receipt.observations.map(item => item.name));
	await exactDirectory(snapshotDir, receipt.observations.map(item => item.name));
	for (const file of receipt.candidate) {
		const source = await boundedFile(file.sourceFile, taskRoot, file.sourceFile !== task.reportPath,
			file.sourceFile === task.reportPath ? "task report" : "candidate source");
		const snapshot = await boundedFile(file.file, undefined, file.sourceFile !== task.reportPath, "candidate snapshot");
		if (source.length !== file.bytes || snapshot.length !== file.bytes ||
			digest(source) !== file.sha256 || digest(snapshot) !== file.sha256)
			throw new HarnessError("local.evaluator.bytes", "candidate bytes changed after evaluation");
	}
	for (const file of receipt.frozenEvidence) {
		const bytes = await boundedFile(file.file);
		if (bytes.length !== file.bytes || digest(bytes) !== file.sha256)
			throw new HarnessError("local.evaluator.bytes", "frozen evaluation evidence changed");
	}
	const binding = { missionId: contract.id, runId: goal.runId, taskId: task.taskId,
		evaluatorId: receipt.evaluator.id, evaluatorVersion: receipt.evaluator.version,
		candidate: receipt.candidate.map(item => ({ name: item.name, sha256: item.sha256 })) };
	for (const item of receipt.observations) {
		if (item.sourceFile !== path.join(outputDir, item.name) ||
			item.file !== path.join(snapshotDir, item.name) ||
			JSON.stringify(item.binding) !== JSON.stringify(binding))
			throw new HarnessError("local.evaluator.observation", "observation binding or path differs from trusted task");
		if (((await lstat(item.sourceFile)).mode & 0o077) !== 0 ||
			((await lstat(item.file)).mode & 0o077) !== 0)
			throw new HarnessError("local.evaluator.observation", "observation file is not private");
		const source = await boundedFile(item.sourceFile, outputDir);
		const snapshot = await boundedFile(item.file, snapshotDir);
		if (source.length !== item.bytes || snapshot.length !== item.bytes ||
			digest(source) !== item.sha256 || digest(snapshot) !== item.sha256)
			throw new HarnessError("local.evaluator.observation", "observation bytes changed after evaluation");
		observationText(source, item.kind);
	}
}

async function writeOrVerify(file: string, bytes: Buffer, mode: number): Promise<void> {
	try { await immutableWrite(file, bytes); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		const current = await boundedFile(file, undefined, true);
		const currentMode = (await lstat(file)).mode & 0o777;
		if (!current.equals(bytes) || (currentMode !== mode && currentMode !== 0o600))
			throw new HarnessError("local.evaluator.attempt", "existing finalization bytes differ");
	}
	await chmod(file, mode);
	const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
	try { await handle.sync(); }
	finally { await handle.close(); }
	await syncDirectory(path.dirname(file));
}

async function preEntryCandidateCopy(file: string, bytes: Buffer): Promise<void> {
	try { await immutableWrite(file, bytes); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		if (!(await boundedFile(file, undefined, true, "candidate snapshot")).equals(bytes))
			throw new HarnessError("local.evaluator.attempt", "orphan candidate snapshot differs");
	}
	await chmod(file, 0o400);
	const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
	try { await handle.sync(); }
	finally { await handle.close(); }
	await syncDirectory(path.dirname(file));
}

async function privateObservationSnapshotDir(dir: string): Promise<void> {
	await privateAttemptDir(dir, true);
}

async function finalizeReturned(input: LocalEvaluatorRunInput,
	evaluator: LocalMissionEvaluator, attempt: LocalEvaluatorAttemptEnteredV1,
	returned: LocalEvaluatorAttemptReturnedV1): Promise<LocalEvaluatorRunOutcome> {
	const { contract, goal, task } = input;
	const { candidate, frozenEvidence } = attempt;
	const result = returned.result;
	const taskRoot = await realpath(path.dirname(task.workDir));
	const observationOutputDir = path.join(taskRoot, "host-evaluator-output");
	const observationSnapshotDir = path.join(taskRoot, "host-evaluator-snapshot");
	await privateObservationSnapshotDir(observationSnapshotDir);
	const sources = candidate.map(item => item.sourceFile);
	const taskContract = validatedTaskInputContract(evaluator.taskInputContract);
	const contractedPaths = new Set(taskContract?.artifacts.map(item => item.path) ?? []);
	if (!Array.isArray(result.checks) || !Array.isArray(result.limitations) ||
		result.checks.some(item => !item || !Array.isArray(item.evidenceRefs) ||
			!Array.isArray(item.limitations) || (item.schemaErrors !== undefined &&
		(!validEvaluatorSchemaErrors(item.schemaErrors) ||
			(item.schemaErrors.length > 0 && (item.result === "passed" ||
				!taskContract || item.schemaErrors.some((error: { artifact: string }) =>
					!contractedPaths.has(error.artifact))))))))
		throw new HarnessError("local.evaluator.receipt", "evaluator returned invalid schema-error feedback");
	if (!Array.isArray(result.observations) || result.observations.some(item =>
		!item || typeof item.name !== "string" || !observationName.test(item.name) ||
		!["text", "json"].includes(item.kind) ||
		(item.kind === "json" && !item.name.endsWith(".json")) ||
		mediaType(item.name) !== "text") ||
		new Set([...candidate.map(item => item.name), ...frozenEvidence.map(item => item.name),
			...result.observations.map(item => item.name)]).size !==
			candidate.length + frozenEvidence.length + result.observations.length)
		throw new HarnessError("local.evaluator.observation", "evaluator declared invalid observation members");
	const actualOutputs = await outputIdentities(observationOutputDir, result.observations);
	if (JSON.stringify(actualOutputs) !== JSON.stringify(returned.outputs))
		throw new HarnessError("local.evaluator.attempt", "returned observation bytes changed");
	const binding = { missionId: contract.id, runId: goal.runId, taskId: task.taskId,
		evaluatorId: evaluator.id, evaluatorVersion: evaluator.version,
		candidate: candidate.map(item => ({ name: item.name, sha256: item.sha256 })) };
	const observations: LocalEvaluatorObservation[] = [];
	for (const item of result.observations) {
		const sourceFile = path.join(observationOutputDir, item.name);
		if (((await lstat(sourceFile)).mode & 0o077) !== 0)
			throw new HarnessError("local.evaluator.observation", "evaluator output file is not private");
		const bytes = await boundedFile(sourceFile, observationOutputDir);
		observationText(bytes, item.kind);
		const file = path.join(observationSnapshotDir, item.name);
		await writeOrVerify(file, bytes, 0o400);
		observations.push({ name: item.name, kind: item.kind, sourceFile, file,
			bytes: bytes.length, sha256: digest(bytes), binding });
	}
	const receipt: LocalEvaluatorReceiptV1 = { version: 1, kind: "local-evaluator-receipt",
		missionId: contract.id, runId: goal.runId, taskId: task.taskId,
		evaluator: { id: evaluator.id, version: evaluator.version }, candidate, observations,
		frozenEvidence, checks: result.checks.map(item => ({ obligationId: item.obligationId,
			result: item.result, evidenceRefs: [...item.evidenceRefs],
			limitations: [...item.limitations],
			...(item.schemaErrors ? { schemaErrors: item.schemaErrors.map((error: {
				artifact: string; path: string; message: string }) => ({ ...error })) } : {}) })),
		limitations: [...result.limitations] };
	await verifyLocalEvaluatorReceipt(receipt, contract, goal, task);
	const frozenCopies = new Map<string, string>();
	for (const name of new Set(receipt.checks.flatMap(item => item.evidenceRefs))) {
		const evidence = frozenEvidence.find(item => item.name === name);
		if (!evidence) continue;
		const source = await realpath(evidence.file);
		const copy = task.inputCopies.find(item => item.source === source);
		if (!copy || digest(await boundedFile(copy.copy, taskRoot)) !== evidence.sha256)
			throw new HarnessError("local.evaluator.evidence", "evaluator evidence lacks the exact M07 task input copy");
		frozenCopies.set(name, copy.copy);
	}
	const receiptFile = path.join(task.workDir, RECEIPT);
	await writeOrVerify(receiptFile, Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`), 0o600);
	const evidencePath = (ref: string): string => candidate.find(file => file.name === ref)?.sourceFile ??
		observations.find(file => file.name === ref)?.file ?? frozenCopies.get(ref)!;
	const checks = task.checks.map((criterion, index) => {
		const item = receipt.checks.find(check => contract.obligations.find(ob => ob.id === check.obligationId)?.description === criterion);
		if (!item) throw new HarnessError("local.evaluator.receipt", `no evaluator check for task criterion ${index + 1}`);
		return { criterion, result: item.result === "unknown" ? "not_run" as const : item.result,
				evidence: [receiptFile, ...item.evidenceRefs.map(evidencePath)] };
	});
	return { receipt, receiptFile,
		review: { taskId: task.taskId, artifacts: [receiptFile, ...sources,
			...observations.map(item => item.file), ...frozenCopies.values()], checks,
			failures: attempt.resolvedFailures,
			limitations: [...receipt.limitations, ...receipt.checks.flatMap(item => [
				...item.limitations, ...(item.schemaErrors ?? []).map(error =>
					`Schema error in ${error.artifact} at ${error.path}: ${error.message}`)])] } };
}

export async function evaluateLocalM07Task(input: LocalEvaluatorRunInput):
	Promise<LocalEvaluatorRunOutcome> {
	const existing = await readLocalEvaluatorAttempt(input);
	if (existing.state === "pre-entry") {
		// The complete entered seal is written before evaluate is invoked.
		// An unsealed sole member is an incomplete pre-entry write, not a plugin call.
		await clearUnsealedPhase(attemptRoot(input.task), "entered");
	}
	if (existing.state === "returned") {
		const evaluator = trustedLocalMissionEvaluator(input.evaluatorId)!;
		return await finalizeReturned(input, evaluator, existing.attempt, existing.returned);
	}
	if (existing.state !== "absent" && existing.state !== "pre-entry")
		throw new HarnessError("local.evaluator.attempt", "entered evaluator attempt cannot be re-run");
	const { contract, goal, task } = input;
	const evaluator = await requireLocalEvaluator(contract, input.evaluatorId, input);
	const taskRoot = await realpath(path.dirname(task.workDir));
	const observationOutputDir = path.join(taskRoot, "host-evaluator-output");
	const observationSnapshotDir = path.join(taskRoot, "host-evaluator-snapshot");
	const failureSnapshotDir = path.join(taskRoot, "host-evaluator-failure-snapshot");
	try { await exactDirectory(failureSnapshotDir, []); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	const resolved = await resolveExpectedOutputFiles(task.workDir, task.expectedOutputPaths);
	const outputFiles = resolved.flatMap(item => item.error ? [] : item.files);
	const sources = [...new Set([task.reportPath, ...outputFiles].filter((file): file is string => !!file))];
	if (!sources.length) throw new HarnessError("local.evaluator.candidate", "returned task has no candidate files");
	const snapshotDir = path.join(path.dirname(task.workDir), "evaluator-snapshot");
	await privateAttemptDir(snapshotDir, true);
	// A prior owner may have died during pre-entry copying. Existing members
	// must be an exact prefix of the returned task's candidates, before we add
	// any missing member. An extra or replaced snapshot is ambiguous.
	const expectedNames = sources.map((sourceFile, index) =>
		`candidate-${String(index + 1).padStart(3, "0")}${path.extname(sourceFile) || ".bin"}`);
	const existingNames = (await readdir(snapshotDir)).sort();
	if (JSON.stringify(existingNames) !== JSON.stringify(expectedNames.slice(0, existingNames.length).sort()))
		throw new HarnessError("local.evaluator.attempt", "orphan candidate snapshot census differs from returned task");
	const returnedAt = Date.parse(task.returnedAt);
	if (input.recoveryPreEntry && !Number.isFinite(returnedAt))
		throw new HarnessError("local.evaluator.candidate", "returned task time is invalid");
	const candidate: LocalCandidateSnapshot[] = [];
	for (const [index, sourceFile] of sources.entries()) {
		// No digest was recorded for an as-yet uncopied member. Its local file
		// metadata must still predate the durable returned-task boundary.
		if (input.recoveryPreEntry && index >= existingNames.length) {
			const info = await lstat(sourceFile);
			if (info.mtimeMs > returnedAt + 1 || info.ctimeMs > returnedAt + 1)
				throw new HarnessError("local.evaluator.candidate", "uncopied candidate changed after task return");
		}
		const bytes = await boundedFile(sourceFile, taskRoot, sourceFile !== task.reportPath,
			sourceFile === task.reportPath ? "task report" : "candidate source");
		const name = expectedNames[index]!;
		const file = path.join(snapshotDir, name);
		await preEntryCandidateCopy(file, bytes);
		candidate.push({ name, file, sourceFile, bytes: bytes.length, sha256: digest(bytes) });
	}
	await exactDirectory(snapshotDir, candidate.map(item => item.name));
	const frozenEvidence = await Promise.all(input.evidence.map(async item => {
		const bytes = await boundedFile(item.file);
		return { ...item, bytes: bytes.length, sha256: digest(bytes) };
	}));
	if (new Set([...candidate.map(file => file.name), ...frozenEvidence.map(file => file.name)]).size !==
		candidate.length + frozenEvidence.length)
		throw new HarnessError("local.evaluator.evidence", "candidate and frozen evidence names collide");
	await privateAttemptDir(observationOutputDir, true);
	await privateAttemptDir(observationSnapshotDir, true);
	await exactDirectory(observationOutputDir, []);
	await exactDirectory(observationSnapshotDir, []);
	const prepared: LocalEvaluatorPreparedInputV1 = { version: 1,
		kind: "local-evaluator-prepared-input", missionId: contract.id,
		runId: goal.runId, taskId: task.taskId,
		evaluator: { id: evaluator.id, version: evaluator.version }, candidate,
		frozenEvidence,
		resolvedFailures: resolved.flatMap(item => item.error ? [item.error] : []) };
	const priorPrepared = await readPreparedLocalEvaluatorInput(input);
	if (priorPrepared) {
		if (JSON.stringify(priorPrepared) !== JSON.stringify(prepared))
			throw new HarnessError("local.evaluator.attempt", "prepared input manifest differs from frozen task");
		await sealVerifiedPrepared(attemptRoot(task));
	} else await writeJournal(attemptRoot(task), "prepared", prepared);
	const attempt: LocalEvaluatorAttemptEnteredV1 = { version: 1,
		kind: "local-evaluator-attempt", attemptId: randomUUID(),
		missionId: contract.id, runId: goal.runId, taskId: task.taskId,
		evaluator: { id: evaluator.id, version: evaluator.version },
		process: await readCurrentProcessIdentity(), candidate, frozenEvidence,
		resolvedFailures: resolved.flatMap(item => item.error ? [item.error] : []) };
	await writeJournal(attemptRoot(task), "entered", attempt);
	let raw: Awaited<ReturnType<LocalMissionEvaluator["evaluate"]>>;
	try {
		raw = await evaluator.evaluate({ contract, missionId: contract.id, runId: goal.runId,
			taskId: task.taskId, candidate, frozenEvidence, observationOutputDir });
	} catch (error) {
		await writeJournal(attemptRoot(task), "threw", { version: 1,
			kind: "local-evaluator-threw", attemptId: attempt.attemptId,
			process: attempt.process } satisfies LocalEvaluatorAttemptThrewV1);
		throw error;
	}
	await writeJournal(attemptRoot(task), "returned-uncommitted", { version: 1,
		kind: "local-evaluator-returned-uncommitted", attemptId: attempt.attemptId,
		process: attempt.process } satisfies LocalEvaluatorAttemptReturnedUncommittedV1);
	// Freeze the exact returned data and the output bytes before any host finalization.
	const result = JSON.parse(jsonBytes(raw).toString("utf8")) as LocalEvaluatorAttemptReturnedV1["result"];
	const outputs = await outputIdentities(observationOutputDir, result.observations);
	const returned: LocalEvaluatorAttemptReturnedV1 = { version: 1,
		kind: "local-evaluator-returned", attemptId: attempt.attemptId, result, outputs };
	await writeJournal(attemptRoot(task), "returned", returned);
	return await finalizeReturned(input, evaluator, attempt, returned);
}

export async function recoverReturnedLocalM07Task(input: LocalEvaluatorRunInput):
	Promise<LocalEvaluatorRunOutcome> {
	const state = await readLocalEvaluatorAttempt(input);
	if (state.state !== "returned")
		throw new HarnessError("local.evaluator.attempt", "no durable returned evaluation to recover");
	return await finalizeReturned(input, trustedLocalMissionEvaluator(input.evaluatorId)!,
		state.attempt, state.returned);
}

async function settledFailureReview(task: M07TaskRecord,
	settled: LocalEvaluatorAttemptSettledFailureV1): Promise<TaskReviewInput> {
	const root = path.dirname(task.workDir);
	const feedbackFile = path.join(root, "host-evaluator-negative-feedback.json");
	const feedback = { version: 1, kind: "local-evaluator-negative-feedback",
		state: "settled-failure", checkResult: "not_run",
		partialOutputs: settled.partialOutputs,
		limitations: ["The trusted evaluator did not return objective checks.",
			"Partial output bytes are retained for host diagnosis only."] };
	await writeOrVerify(feedbackFile, Buffer.from(`${JSON.stringify(feedback, null, 2)}\n`), 0o600);
	return { taskId: task.taskId, artifacts: [feedbackFile],
		checks: task.checks.map(criterion => ({ criterion, result: "not_run", evidence: [feedbackFile] })),
		failures: ["Trusted evaluator settled without a returned result; no objective check was admitted."],
		limitations: ["Partial observations are retained only for diagnosis; they do not establish a passed check."] };
}

/** Only a trusted read-only hook can settle an opaque entered/threw failure. */
export async function reconcileEnteredLocalEvaluatorAttempt(input: LocalEvaluatorRunInput):
	Promise<{ state: "pending"; attempt: LocalEvaluatorAttemptEnteredV1 } |
		{ state: "settled-failure"; attempt: LocalEvaluatorAttemptEnteredV1;
			settled: LocalEvaluatorAttemptSettledFailureV1; review: TaskReviewInput }> {
	const state = await readLocalEvaluatorAttempt(input);
	if (state.state === "settled-failure") return { ...state,
		review: await settledFailureReview(input.task, state.settled) };
	if (state.state !== "entered" && state.state !== "threw" &&
		state.state !== "returned-uncommitted")
		throw new HarnessError("local.evaluator.attempt", "no opaque entered evaluation to reconcile");
	const evaluator = trustedLocalMissionEvaluator(input.evaluatorId);
	if (!evaluator?.reconcileEvaluation) return { state: "pending", attempt: state.attempt };
	const ownerProbe = await probeProcessIdentity(state.attempt.process);
	const current = await readCurrentProcessIdentity();
	const sameOwner = JSON.stringify(current) === JSON.stringify(state.attempt.process) &&
		ownerProbe.status === "alive" && ownerProbe.identityMatch;
	if (!((state.state === "threw" || state.state === "returned-uncommitted") && sameOwner) &&
		ownerProbe.status !== "dead")
		return { state: "pending", attempt: state.attempt };
	const decision = await evaluator.reconcileEvaluation({ attemptId: state.attempt.attemptId,
		missionId: state.attempt.missionId, runId: state.attempt.runId,
		taskId: state.attempt.taskId, evaluatorId: state.attempt.evaluator.id,
		evaluatorVersion: state.attempt.evaluator.version,
		candidate: state.attempt.candidate.map(item => ({ name: item.name,
			bytes: item.bytes, sha256: item.sha256 })), process: state.attempt.process });
	if (!decision || decision.state === "pending")
		return { state: "pending", attempt: state.attempt };
	if (decision.state !== "settled-failure" ||
		!validSettlementProof(decision.proof, state.attempt))
		throw new HarnessError("local.evaluator.attempt", "trusted reconciliation lacks bound settlement proof");
	for (const child of decision.proof.childProcesses) {
		const probe = await probeProcessIdentity(child);
		if (probe.status !== "dead") return { state: "pending", attempt: state.attempt };
	}
	const taskRoot = await realpath(path.dirname(input.task.workDir));
	const outputDir = path.join(taskRoot, "host-evaluator-output");
	const entries = await readdir(outputDir);
	const partialOutputs = await opaquePartialIdentities(outputDir, entries);
	const snapshotDir = path.join(taskRoot, "host-evaluator-failure-snapshot");
	await privateAttemptDir(snapshotDir, true);
	for (const item of partialOutputs) {
		const bytes = await boundedFile(path.join(outputDir, item.name), outputDir, true);
		await writeOrVerify(path.join(snapshotDir, item.name), bytes, 0o400);
	}
	await exactDirectory(snapshotDir, partialOutputs.map(item => item.name));
	const settled: LocalEvaluatorAttemptSettledFailureV1 = { version: 1,
		kind: "local-evaluator-settled-failure", attemptId: state.attempt.attemptId,
		proof: decision.proof, partialOutputs };
	await clearUnsealedPhase(attemptRoot(input.task), "settled-failure");
	await writeJournal(attemptRoot(input.task), "settled-failure", settled);
	return { state: "settled-failure", attempt: state.attempt, settled,
		review: await settledFailureReview(input.task, settled) };
}


export async function readLocalEvaluatorReceipt(file: string): Promise<{ receipt: LocalEvaluatorReceiptV1; sha256: string }> {
	const bytes = await boundedFile(file);
	return { receipt: JSON.parse(bytes.toString("utf8")) as LocalEvaluatorReceiptV1,
		sha256: digest(bytes) };
}
