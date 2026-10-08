/** GitHub-free, append-only host evidence for one local mission. This store
 * records bytes and uncertainty; it never certifies scientific completion,
 * provider settlement, or safe replay of an external operation. */
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, readdir, unlink } from "node:fs/promises";
import path from "node:path";
import { readCurrentProcessIdentity, probeProcessIdentity,
	type ProcessIdentityV1, type ProcessProbe } from "../runtime/process-identity.ts";

const CHECKPOINT_BYTES = 64 * 1024 * 1024;
/** Bounds one physical payload file; exceeding it is a transport repair need,
 * never a scientific, fee, or iteration stopping rule. */
const FINAL_BYTES = 255 * 1024 * 1024;
const CONTROL_BYTES = 64 * 1024;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const ATTEMPT = /^A([0-9]{3,})$/;

export type LocalMissionAttempt = Readonly<{
	version: 1; missionId: string; attemptId: string; predecessorAttemptId: string | null;
	/** Operator/local-build label only; this is not a source-authentication proof. */
	codeRevision: string; process: ProcessIdentityV1;
}>;
export type LocalCheckpointReceipt = Readonly<{
	version: 1; kind: "local-mission-checkpoint"; source: LocalMissionAttempt;
	sequence: number; previousSha256: string | null; sha256: string; bytes: number;
	unresolvedOperationIds: readonly string[];
}>;
export type LocalContractReceipt = Readonly<{
	version: 1; kind: "local-mission-original-contract";
	source: LocalMissionAttempt; sha256: string; bytes: number;
}>;
export type LocalFinalIntent = Readonly<{
	version: 1; kind: "local-mission-final-intent"; source: LocalMissionAttempt;
	intentId: string; checkpointSequence: number; checkpointSha256: string;
	carrySha256: string; unresolvedOperationIds: readonly string[];
}>;
export type LocalFinalReceipt = Readonly<{
	version: 1; kind: "local-mission-final-receipt"; source: LocalMissionAttempt;
	intentId: string; checkpointSequence: number; checkpointSha256: string;
	sha256: string; bytes: number; transportOnly: true;
}>;
export type LocalMissionStatus = Readonly<{
	missionId: string; currentAttempt: LocalMissionAttempt | null;
	contractReceipt: LocalContractReceipt | null; contractOrphan: boolean;
	latestCheckpoint: LocalCheckpointReceipt | null;
	checkpointReceipts: readonly LocalCheckpointReceipt[];
	unresolvedOperationIds: readonly string[]; interruptedAttemptIds: readonly string[];
	final: "none" | "reserved" | "attempted-unknown" | "committed";
	finalReceipt: LocalFinalReceipt | null; finalReceipts: readonly LocalFinalReceipt[];
	repairRequired: boolean; writerLockPresent: boolean;
	selectionAuthority: false; accounting: "unquantified";
}>;

type UnknownOperation = Readonly<{
	version: 1; kind: "local-mission-unknown-operation";
	source: LocalMissionAttempt; operationId: string;
	effects: "unknown-unreconciled"; accounting: "unquantified";
}>;
type FinalAttempt = Readonly<{
	version: 1; kind: "local-mission-final-attempt"; source: LocalMissionAttempt;
	intentId: string; carrySha256: string;
}>;
type Scan = { status: LocalMissionStatus; attempts: LocalMissionAttempt[];
	intent: LocalFinalIntent | null; attempted: FinalAttempt | null };

function reject(reason: string): never { throw new Error(`local mission host refused: ${reason}`); }
function digest(bytes: Buffer | string): string { return createHash("sha256").update(bytes).digest("hex"); }
function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value) &&
		Object.keys(value).sort().join("|") === [...keys].sort().join("|");
}
function validAttemptId(value: unknown): value is string {
	if (typeof value !== "string" || !ATTEMPT.test(value)) return false;
	const index = Number(value.slice(1));
	return Number.isSafeInteger(index) && index > 0 &&
		`A${String(index).padStart(3, "0")}` === value;
}
function validProcess(value: unknown): value is ProcessIdentityV1 {
	const identityText = (item: unknown): item is string =>
		typeof item === "string" && item.length > 0 && item.length <= 512 &&
		!/[\0\r\n]/.test(item);
	return exact(value, ["hostId", "bootId", "pid", "processStartToken"]) &&
		["hostId", "bootId", "processStartToken"].every(key => identityText(value[key])) &&
		Number.isSafeInteger(value.pid) && Number(value.pid) > 0;
}
function validSource(value: unknown): value is LocalMissionAttempt {
	return exact(value, ["version", "missionId", "attemptId", "predecessorAttemptId",
		"codeRevision", "process"]) && value.version === 1 &&
		typeof value.missionId === "string" && SAFE_ID.test(value.missionId) &&
		validAttemptId(value.attemptId) &&
		(value.predecessorAttemptId === null || validAttemptId(value.predecessorAttemptId)) &&
		typeof value.codeRevision === "string" && SAFE_ID.test(value.codeRevision) &&
		validProcess(value.process);
}
function same(a: unknown, b: unknown): boolean { return JSON.stringify(a) === JSON.stringify(b); }
function validIds(value: unknown): value is string[] {
	return Array.isArray(value) && value.every(item => typeof item === "string" && SAFE_ID.test(item)) &&
		new Set(value).size === value.length && [...value].sort().join("|") === value.join("|");
}

async function privateDir(directory: string, create = false): Promise<void> {
	if (create) {
		try {
			await mkdir(directory, { mode: 0o700 });
			await syncDir(path.dirname(directory));
		}
		catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
	}
	const info = await lstat(directory);
	if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0)
		reject("private directory is unsafe");
}
async function syncDir(directory: string): Promise<void> {
	const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
	try { await handle.sync(); } finally { await handle.close(); }
}
async function privateBytes(file: string, max: number): Promise<Buffer> {
	const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	try {
		const before = await handle.stat();
		if (!before.isFile() || before.nlink !== 1 || (before.mode & 0o077) !== 0 ||
			before.size < 1 || before.size > max) reject("private file is unsafe");
		const bytes = await handle.readFile();
		const after = await handle.stat();
		if (bytes.length !== before.size || after.size !== before.size ||
			after.mtimeMs !== before.mtimeMs) reject("private file changed while reading");
		return bytes;
	} finally { await handle.close(); }
}
async function optionalBytes(file: string, max: number): Promise<Buffer | undefined> {
	try { return await privateBytes(file, max); }
	catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}
async function json(file: string): Promise<unknown | undefined> {
	const bytes = await optionalBytes(file, CONTROL_BYTES);
	if (!bytes) return undefined;
	try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown; }
	catch { return reject("private control JSON is invalid"); }
}
async function once(file: string, bytes: Buffer): Promise<void> {
	const directory = path.dirname(file);
	const temporary = path.join(directory, `.pending-${randomUUID()}`);
	const handle = await open(temporary,
		constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
	try { await handle.writeFile(bytes); await handle.sync(); }
	finally { await handle.close(); }
	await link(temporary, file); // EEXIST refuses overwrite atomically.
	await syncDir(directory);
	await unlink(temporary);
	await syncDir(directory);
}
async function onceJson(file: string, value: unknown): Promise<void> {
	const bytes = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
	if (bytes.length > CONTROL_BYTES) reject("private control record exceeds physical file bound");
	await once(file, bytes);
}

async function lock<T>(root: string, work: (mutation: () => void) => Promise<T>): Promise<T> {
	const file = path.join(root, ".writer.lock");
	let handle;
	try { handle = await open(file,
		constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") reject("writer lock remains; review uncertain prior mutation");
		throw error;
	}
	const identity = await handle.stat();
	await handle.writeFile(`${JSON.stringify({ pid: process.pid, at: new Date().toISOString() })}\n`);
	await handle.sync();
	await handle.close();
	await syncDir(root);
	let mutationStarted = false;
	let succeeded = false;
	try {
		const result = await work(() => { mutationStarted = true; });
		succeeded = true;
		return result;
	}
	finally {
		if (succeeded || !mutationStarted) {
			const current = await lstat(file);
			if (current.dev === identity.dev && current.ino === identity.ino) {
				await unlink(file); await syncDir(root);
			}
		}
		// A failed or interrupted mutation retains the lock for explicit review.
	}
}
function attemptPath(root: string, attemptId: string): string {
	if (!validAttemptId(attemptId)) reject("attempt ID is invalid");
	return path.join(root, "attempts", attemptId);
}
function checkpointPaths(root: string, attemptId: string, sequence: number) {
	const stem = `C${String(sequence).padStart(8, "0")}`;
	const directory = path.join(attemptPath(root, attemptId), "checkpoints");
	return { bin: path.join(directory, `${stem}.bin`), receipt: path.join(directory, `${stem}.json`) };
}

async function scan(root: string, ignoreCurrentLock = false): Promise<Scan> {
	await privateDir(root);
	const rootEntries = await readdir(root);
	const writerLockPresent = rootEntries.includes(".writer.lock");
	const attemptsRoot = path.join(root, "attempts");
	await privateDir(attemptsRoot);
	const names = (await readdir(attemptsRoot)).sort((a, b) =>
		Number(a.slice(1)) - Number(b.slice(1)));
	const attempts: LocalMissionAttempt[] = [];
	const checkpoints: LocalCheckpointReceipt[] = [];
	const unknown = new Set<string>();
	const interruptedAttemptIds: string[] = [];
	let repairRequired = false;
	if (rootEntries.some(entry => !["attempts", "original-contract.json",
		"original-contract.receipt.json", "evidence", "assessments", "materials",
		".writer.lock"].includes(entry)))
		repairRequired = true;
	for (const adjunct of ["evidence", "assessments", "materials"])
		if (rootEntries.includes(adjunct)) await privateDir(path.join(root, adjunct));
	if (writerLockPresent && !ignoreCurrentLock) repairRequired = true;
	let intent: LocalFinalIntent | null = null;
	let attempted: FinalAttempt | null = null;
	let finalReceipt: LocalFinalReceipt | null = null;
	const finalReceipts: LocalFinalReceipt[] = [];
	let finalState: LocalMissionStatus["final"] = "none";
	for (const [index, name] of names.entries()) {
		if (!validAttemptId(name) || Number(name.slice(1)) !== index + 1)
			reject("attempt sequence has a gap or unexpected directory");
		const directory = attemptPath(root, name);
		await privateDir(directory);
		const value = await json(path.join(directory, "source.json"));
		if (!validSource(value) || value.attemptId !== name ||
			value.predecessorAttemptId !== (index ? names[index - 1] : null) ||
			(index && value.missionId !== attempts[0].missionId))
			reject("attempt identity is absent or mismatched");
		attempts.push(value);
		const checkpointsDir = path.join(directory, "checkpoints");
		const operationsDir = path.join(directory, "operations");
		const finalDir = path.join(directory, "final");
		for (const part of [checkpointsDir, operationsDir, finalDir]) await privateDir(part);
		const entries = await readdir(checkpointsDir);
		const receipts = entries.filter(entry => /^C[0-9]{8,}\.json$/.test(entry))
			.sort((a, b) => Number(a.slice(1, -5)) - Number(b.slice(1, -5)));
		if (entries.some(entry => !/^C[0-9]{8,}\.(?:json|bin)$/.test(entry)) ||
			entries.some(entry => entry.endsWith(".bin") &&
				!receipts.includes(entry.replace(/\.bin$/, ".json")))) repairRequired = true;
		for (const entry of receipts) {
			const receipt = await json(path.join(checkpointsDir, entry));
			const previous = checkpoints.at(-1);
			const sequence = checkpoints.length + 1;
			if (!exact(receipt, ["version", "kind", "source", "sequence", "previousSha256",
				"sha256", "bytes", "unresolvedOperationIds"]) ||
				receipt.version !== 1 || receipt.kind !== "local-mission-checkpoint" ||
				!same(receipt.source, value) || receipt.sequence !== sequence ||
				receipt.previousSha256 !== (previous?.sha256 ?? null) ||
				typeof receipt.sha256 !== "string" || !HEX64.test(receipt.sha256) ||
				!Number.isSafeInteger(receipt.bytes) || Number(receipt.bytes) < 1 ||
				Number(receipt.bytes) > CHECKPOINT_BYTES || !validIds(receipt.unresolvedOperationIds) ||
				entry !== `C${String(sequence).padStart(8, "0")}.json`)
				reject("checkpoint receipt sequence or identity is invalid");
			const bytes = await optionalBytes(path.join(checkpointsDir, entry.replace(/\.json$/, ".bin")), CHECKPOINT_BYTES);
			if (!bytes || bytes.length !== receipt.bytes || digest(bytes) !== receipt.sha256)
				repairRequired = true;
			checkpoints.push(receipt as LocalCheckpointReceipt);
		}
		for (const entry of await readdir(operationsDir)) {
			if (!/^[0-9a-f]{64}\.json$/.test(entry)) { repairRequired = true; continue; }
			const operation = await json(path.join(operationsDir, entry));
			if (!exact(operation, ["version", "kind", "source", "operationId", "effects", "accounting"]) ||
				operation.version !== 1 || operation.kind !== "local-mission-unknown-operation" ||
				!same(operation.source, value) || typeof operation.operationId !== "string" ||
				!SAFE_ID.test(operation.operationId) || entry !== `${digest(operation.operationId)}.json` ||
				operation.effects !== "unknown-unreconciled" || operation.accounting !== "unquantified")
				reject("unknown operation receipt is invalid");
			unknown.add(operation.operationId);
		}
		const files = await readdir(finalDir);
		if (files.some(file => !["intent.json", "attempted.json", "carry.bin", "receipt.json"].includes(file)))
			repairRequired = true;
		const intentRaw = await json(path.join(finalDir, "intent.json"));
		const attemptedRaw = await json(path.join(finalDir, "attempted.json"));
		const receiptRaw = await json(path.join(finalDir, "receipt.json"));
		const carry = await optionalBytes(path.join(finalDir, "carry.bin"), FINAL_BYTES);
		if (intentRaw !== undefined) {
			if (!exact(intentRaw, ["version", "kind", "source", "intentId", "checkpointSequence",
				"checkpointSha256", "carrySha256", "unresolvedOperationIds"]) ||
				intentRaw.version !== 1 || intentRaw.kind !== "local-mission-final-intent" ||
				!same(intentRaw.source, value) || typeof intentRaw.intentId !== "string" ||
				!SAFE_ID.test(intentRaw.intentId) || !Number.isSafeInteger(intentRaw.checkpointSequence) ||
				Number(intentRaw.checkpointSequence) < 1 ||
				typeof intentRaw.checkpointSha256 !== "string" || !HEX64.test(intentRaw.checkpointSha256) ||
				typeof intentRaw.carrySha256 !== "string" || !HEX64.test(intentRaw.carrySha256) ||
				!validIds(intentRaw.unresolvedOperationIds)) reject("final intent is invalid");
			intent = intentRaw as LocalFinalIntent;
			finalState = "reserved";
		}
		if (attemptedRaw !== undefined) {
			if (!intent || !exact(attemptedRaw, ["version", "kind", "source", "intentId", "carrySha256"]) ||
				attemptedRaw.version !== 1 || attemptedRaw.kind !== "local-mission-final-attempt" ||
				!same(attemptedRaw.source, value) || attemptedRaw.intentId !== intent.intentId ||
				attemptedRaw.carrySha256 !== intent.carrySha256) reject("final attempt is invalid");
			attempted = attemptedRaw as FinalAttempt;
			finalState = "attempted-unknown";
		}
		if (receiptRaw !== undefined) {
			if (!intent || !attempted || !carry ||
				!exact(receiptRaw, ["version", "kind", "source", "intentId",
					"checkpointSequence", "checkpointSha256", "sha256", "bytes", "transportOnly"]) ||
				receiptRaw.version !== 1 || receiptRaw.kind !== "local-mission-final-receipt" ||
				!same(receiptRaw.source, value) || receiptRaw.intentId !== intent.intentId ||
				receiptRaw.checkpointSequence !== intent.checkpointSequence ||
				receiptRaw.checkpointSha256 !== intent.checkpointSha256 ||
				receiptRaw.sha256 !== intent.carrySha256 || receiptRaw.bytes !== carry.length ||
				receiptRaw.transportOnly !== true || digest(carry) !== receiptRaw.sha256)
				reject("final receipt is invalid");
			finalReceipt = receiptRaw as LocalFinalReceipt;
			finalReceipts.push(finalReceipt);
			finalState = "committed";
		} else if (carry) repairRequired = true;
		if (index < names.length - 1 && finalState !== "committed")
			interruptedAttemptIds.push(name);
		if (index < names.length - 1) { intent = null; attempted = null; finalReceipt = null; finalState = "none"; }
	}
	const contractRaw = await optionalBytes(path.join(root, "original-contract.json"), CHECKPOINT_BYTES);
	const contractValue = await json(path.join(root, "original-contract.receipt.json"));
	let contractReceipt: LocalContractReceipt | null = null;
	const contractOrphan = Boolean(contractRaw && !contractValue);
	if (contractOrphan || !contractRaw && contractValue) repairRequired = true;
	if (contractValue) {
		if (!exact(contractValue, ["version", "kind", "source", "sha256", "bytes"]) ||
			contractValue.version !== 1 || contractValue.kind !== "local-mission-original-contract" ||
			!same(contractValue.source, attempts[0]) ||
			typeof contractValue.sha256 !== "string" || !HEX64.test(contractValue.sha256) ||
			!Number.isSafeInteger(contractValue.bytes) || Number(contractValue.bytes) < 1 ||
			Number(contractValue.bytes) > CHECKPOINT_BYTES)
			reject("original contract receipt is invalid");
		if (!contractRaw || contractRaw.length !== contractValue.bytes ||
			digest(contractRaw) !== contractValue.sha256) repairRequired = true;
		contractReceipt = contractValue as LocalContractReceipt;
	}
	return { attempts, intent, attempted,
		status: { missionId: attempts[0]?.missionId ?? "", currentAttempt: attempts.at(-1) ?? null,
			contractReceipt, contractOrphan,
			latestCheckpoint: checkpoints.at(-1) ?? null, checkpointReceipts: checkpoints,
			unresolvedOperationIds: [...unknown].sort(), interruptedAttemptIds,
			final: finalState, finalReceipt, finalReceipts, repairRequired, writerLockPresent,
			selectionAuthority: false, accounting: "unquantified" } };
}

export class LocalMissionHost {
	readonly root: string;
	readonly source: LocalMissionAttempt;
	private readonly currentIdentity: () => Promise<ProcessIdentityV1>;
	private constructor(root: string, source: LocalMissionAttempt,
		currentIdentity: () => Promise<ProcessIdentityV1>) {
		this.root = root;
		this.source = source;
		this.currentIdentity = currentIdentity;
	}

	static async begin(input: Readonly<{ root: string; missionId: string; attemptId: string;
		codeRevision: string; currentIdentity?: () => Promise<ProcessIdentityV1>;
		probePrior?: (identity: ProcessIdentityV1) => Promise<ProcessProbe> }>): Promise<LocalMissionHost> {
		if (!path.isAbsolute(input.root) || !SAFE_ID.test(input.missionId) ||
			!validAttemptId(input.attemptId) || !SAFE_ID.test(input.codeRevision))
			reject("local mission source is invalid");
		const currentIdentity = input.currentIdentity ?? readCurrentProcessIdentity;
		const process = await currentIdentity();
		const root = path.resolve(input.root);
		const grandparent = await lstat(path.dirname(path.dirname(root)));
		if (!grandparent.isDirectory() || grandparent.isSymbolicLink())
			reject("local mission parent is unsafe");
		await privateDir(path.dirname(root), true);
		await privateDir(root, true);
		const attemptsRoot = path.join(root, "attempts");
		await privateDir(attemptsRoot, true);
		const source: LocalMissionAttempt = { version: 1, missionId: input.missionId,
			attemptId: input.attemptId, predecessorAttemptId: input.attemptId === "A001" ? null :
				`A${String(Number(input.attemptId.slice(1)) - 1).padStart(3, "0")}`,
			codeRevision: input.codeRevision, process };
		if (!validSource(source)) reject("local mission attempt identity is invalid");
		await lock(root, async mutation => {
			const observed = await scan(root, true);
			if (observed.status.repairRequired) reject("prior local evidence requires review");
			if (observed.attempts.length === Number(input.attemptId.slice(1))) {
				if (!same(observed.status.currentAttempt, source)) reject("attempt identity changed");
				return;
			}
			if (observed.attempts.length + 1 !== Number(input.attemptId.slice(1)) ||
				(observed.attempts.length && observed.attempts[0].missionId !== input.missionId))
				reject("attempt is not the exact successor");
			const prior = observed.status.currentAttempt;
			if (prior && observed.status.final !== "committed") {
				const probe = await (input.probePrior ?? probeProcessIdentity)(prior.process);
				if (probe.status !== "dead" || probe.identityMatch)
					reject("prior attempt may still be executing");
			}
			mutation();
			const directory = attemptPath(root, source.attemptId);
			await mkdir(directory, { mode: 0o700 }); await syncDir(attemptsRoot);
			for (const part of ["checkpoints", "operations", "final"]) {
				await mkdir(path.join(directory, part), { mode: 0o700 }); await syncDir(directory);
			}
			await onceJson(path.join(directory, "source.json"), source);
		});
		return new LocalMissionHost(root, source, currentIdentity);
	}

	static async status(root: string): Promise<LocalMissionStatus> {
		if (!path.isAbsolute(root)) reject("local mission directory is invalid");
		return (await scan(path.resolve(root))).status;
	}

	static async readInitialContract(root: string): Promise<Buffer | undefined> {
		const status = await LocalMissionHost.status(root);
		const receipt = status.contractReceipt;
		if (!receipt) return undefined;
		const bytes = await privateBytes(path.join(path.resolve(root), "original-contract.json"),
			CHECKPOINT_BYTES);
		if (bytes.length !== receipt.bytes || digest(bytes) !== receipt.sha256)
			reject("original contract differs from committed receipt");
		return bytes;
	}

	static async readLatestCheckpoint(root: string): Promise<Buffer | undefined> {
		const status = await LocalMissionHost.status(root);
		const receipt = status.latestCheckpoint;
		if (!receipt) return undefined;
		return LocalMissionHost.readCommittedCheckpoint(root, receipt.sequence);
	}

	static async readCommittedCheckpoint(root: string, sequence: number): Promise<Buffer> {
		if (!path.isAbsolute(root) || !Number.isSafeInteger(sequence) || sequence < 1)
			reject("checkpoint read identity is invalid");
		const status = await LocalMissionHost.status(root);
		const matches = status.checkpointReceipts.filter(row => row.sequence === sequence);
		if (matches.length !== 1) reject("checkpoint is not an exact committed sequence");
		const receipt = matches[0];
		const file = checkpointPaths(path.resolve(root), receipt.source.attemptId,
			receipt.sequence).bin;
		const bytes = await privateBytes(file, CHECKPOINT_BYTES);
		if (bytes.length !== receipt.bytes || digest(bytes) !== receipt.sha256)
			reject("checkpoint bytes differ from committed receipt");
		return bytes;
	}

	static async readCommittedFinal(root: string, attemptId: string): Promise<Buffer | undefined> {
		if (!path.isAbsolute(root) || !validAttemptId(attemptId))
			reject("final carry read identity is invalid");
		const status = await LocalMissionHost.status(root);
		const matches = status.finalReceipts.filter(row => row.source.attemptId === attemptId);
		if (!matches.length) return undefined;
		if (matches.length !== 1) reject("final carry has ambiguous receipts");
		const receipt = matches[0];
		const bytes = await privateBytes(path.join(attemptPath(path.resolve(root), attemptId),
			"final", "carry.bin"), FINAL_BYTES);
		if (bytes.length !== receipt.bytes || digest(bytes) !== receipt.sha256)
			reject("final carry bytes differ from committed receipt");
		return bytes;
	}

	private async owned(): Promise<void> {
		if (!same(await this.currentIdentity(), this.source.process))
			reject("current process differs from attempt identity");
	}
	private async mutate<T>(body: (mutation: () => void, state: Scan) => Promise<T>): Promise<T> {
		await this.owned();
		const value = await lock(this.root, async mutation => {
			const state = await scan(this.root, true);
			if (state.status.repairRequired || !same(state.status.currentAttempt, this.source))
				reject("attempt is not current or prior evidence needs review");
			return body(mutation, state);
		});
		return value;
	}

	status(): Promise<LocalMissionStatus> { return LocalMissionHost.status(this.root); }
	readInitialContract(): Promise<Buffer | undefined> {
		return LocalMissionHost.readInitialContract(this.root);
	}

	async recordInitialContract(input: Readonly<{ attemptId: string; bytes: Buffer }> ):
		Promise<LocalContractReceipt> {
		if (input.attemptId !== this.source.attemptId || this.source.attemptId !== "A001" ||
			!Buffer.isBuffer(input.bytes) || input.bytes.length < 1 ||
			input.bytes.length > CHECKPOINT_BYTES)
			reject("original contract identity or physical byte bound is invalid");
		return this.mutate(async (mutation, state) => {
			if (state.status.contractReceipt) {
				const existing = state.status.contractReceipt;
				if (existing.sha256 === digest(input.bytes) && existing.bytes === input.bytes.length)
					return existing; // Exact retry can finish separately frozen local evidence.
				reject("original contract identity changed");
			}
			if (state.status.contractOrphan ||
				state.status.latestCheckpoint || state.status.final !== "none")
				reject("original contract was already written or research evidence exists");
			const receipt: LocalContractReceipt = { version: 1,
				kind: "local-mission-original-contract", source: this.source,
				sha256: digest(input.bytes), bytes: input.bytes.length };
			mutation();
			await once(path.join(this.root, "original-contract.json"), input.bytes);
			await onceJson(path.join(this.root, "original-contract.receipt.json"), receipt);
			return receipt;
		});
	}

	async recordUnknownOperation(input: Readonly<{ attemptId: string; operationId: string }>): Promise<void> {
		if (input.attemptId !== this.source.attemptId || !SAFE_ID.test(input.operationId))
			reject("unknown operation identity is invalid");
		await this.mutate(async (mutation, state) => {
			if (state.status.final !== "none") reject("final intent already froze this attempt");
			if (state.status.unresolvedOperationIds.includes(input.operationId)) return;
			const receipt: UnknownOperation = { version: 1, kind: "local-mission-unknown-operation",
				source: this.source, operationId: input.operationId,
				effects: "unknown-unreconciled", accounting: "unquantified" };
			mutation();
			await onceJson(path.join(attemptPath(this.root, this.source.attemptId),
				"operations", `${digest(input.operationId)}.json`), receipt);
		});
	}

	async recordCheckpoint(input: Readonly<{ attemptId: string; sequence: number;
		previousSha256: string | null; bytes: Buffer }>): Promise<LocalCheckpointReceipt> {
		if (input.attemptId !== this.source.attemptId || !Number.isSafeInteger(input.sequence) ||
			input.sequence < 1 || !Buffer.isBuffer(input.bytes) || input.bytes.length < 1 ||
			input.bytes.length > CHECKPOINT_BYTES)
			reject("checkpoint identity or physical byte bound is invalid");
		return this.mutate(async (mutation, state) => {
			if (!state.status.contractReceipt) reject("original contract is not committed");
			if (state.status.final !== "none") reject("final intent already froze this attempt");
			const latest = state.status.latestCheckpoint;
			if (input.sequence !== (latest?.sequence ?? 0) + 1 ||
				input.previousSha256 !== (latest?.sha256 ?? null))
				reject("checkpoint sequence or predecessor digest differs");
			const receipt: LocalCheckpointReceipt = { version: 1, kind: "local-mission-checkpoint",
				source: this.source, sequence: input.sequence, previousSha256: input.previousSha256,
				sha256: digest(input.bytes), bytes: input.bytes.length,
				unresolvedOperationIds: state.status.unresolvedOperationIds };
			const files = checkpointPaths(this.root, this.source.attemptId, input.sequence);
			mutation();
			await once(files.bin, input.bytes);
			await onceJson(files.receipt, receipt); // receipt is the commit marker.
			return receipt;
		});
	}

	async readCheckpoint(sequence: number): Promise<Buffer> {
		return LocalMissionHost.readCommittedCheckpoint(this.root, sequence);
	}

	async reserveFinal(input: Readonly<{ attemptId: string; intentId: string;
		checkpointSequence: number; checkpointSha256: string; carrySha256: string }> ):
		Promise<LocalFinalIntent> {
		if (input.attemptId !== this.source.attemptId || !SAFE_ID.test(input.intentId) ||
			!HEX64.test(input.checkpointSha256) || !HEX64.test(input.carrySha256))
			reject("final intent identity is invalid");
		return this.mutate(async (mutation, state) => {
			const checkpoint = state.status.latestCheckpoint;
			if (state.status.final !== "none" || !checkpoint ||
				checkpoint.sequence !== input.checkpointSequence ||
				checkpoint.sha256 !== input.checkpointSha256)
				reject("final intent is not bound to the exact latest checkpoint");
			const intent: LocalFinalIntent = { version: 1, kind: "local-mission-final-intent",
				source: this.source, intentId: input.intentId,
				checkpointSequence: checkpoint.sequence, checkpointSha256: checkpoint.sha256,
				carrySha256: input.carrySha256,
				unresolvedOperationIds: state.status.unresolvedOperationIds };
			mutation();
			await onceJson(path.join(attemptPath(this.root, this.source.attemptId),
				"final", "intent.json"), intent);
			return intent;
		});
	}

	async commitFinal(input: Readonly<{ attemptId: string; intentId: string; bytes: Buffer }> ):
		Promise<LocalFinalReceipt> {
		if (input.attemptId !== this.source.attemptId || !SAFE_ID.test(input.intentId) ||
			!Buffer.isBuffer(input.bytes) || input.bytes.length < 1 || input.bytes.length > FINAL_BYTES)
			reject("final carry identity or physical byte bound is invalid");
		return this.mutate(async (mutation, state) => {
			const intent = state.intent;
			if (state.status.final !== "reserved" || !intent || intent.intentId !== input.intentId ||
				intent.carrySha256 !== digest(input.bytes) ||
				state.status.latestCheckpoint?.sequence !== intent.checkpointSequence ||
				state.status.latestCheckpoint?.sha256 !== intent.checkpointSha256 ||
				!same(intent.unresolvedOperationIds, state.status.unresolvedOperationIds))
				reject("final carry differs from one-use intent or unknown-operation state");
			const directory = path.join(attemptPath(this.root, this.source.attemptId), "final");
			const attempted: FinalAttempt = { version: 1, kind: "local-mission-final-attempt",
				source: this.source, intentId: input.intentId, carrySha256: intent.carrySha256 };
			const receipt: LocalFinalReceipt = { version: 1, kind: "local-mission-final-receipt",
				source: this.source, intentId: input.intentId,
				checkpointSequence: intent.checkpointSequence,
				checkpointSha256: intent.checkpointSha256,
				sha256: intent.carrySha256, bytes: input.bytes.length, transportOnly: true };
			mutation();
			await onceJson(path.join(directory, "attempted.json"), attempted);
			await once(path.join(directory, "carry.bin"), input.bytes);
			await onceJson(path.join(directory, "receipt.json"), receipt);
			return receipt;
		});
	}

	async readFinal(attemptId = this.source.attemptId): Promise<Buffer | undefined> {
		return LocalMissionHost.readCommittedFinal(this.root, attemptId);
	}
}

export function openLocalMissionHost(input: Parameters<typeof LocalMissionHost.begin>[0]):
	Promise<LocalMissionHost> {
	return LocalMissionHost.begin(input);
}
