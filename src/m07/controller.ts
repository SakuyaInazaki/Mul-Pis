import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import { chmod, copyFile, cp, link, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rmdir, stat, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { loadPrompt, section, systemPromptFor } from "../prompts.ts";
import { HarnessError } from "../types.ts";
import { nowIso, readTextIfExists, writeFileAtomic } from "../workspace.ts";
import { isTextFile, mediaType } from "../media.ts";
import { sessionSpec, type StageContext } from "../stages/context.ts";
import { isSafeRelativeOutputPath, resolveExpectedOutputFiles, type ExpectedOutputResolution } from "./expected-output.ts";
import type { BeginGoalInput, CandidateObservationV1, CurrentGoal, DecisionInput, EvidenceFile, FinishInput, HostStopReasonKind, HostStopReceipt, InterruptInput, M07CheckpointRecord, M07Controller, M07TaskRecord, TaskAdmission, TaskCheck, TaskReviewInput, TaskSpecInput, M07OperationV1 } from "./types.ts";
import { requestNotSentDetails, settledTerminalResponseDetails } from "../runner/operation-disposition.ts";
import type { StageRunRecord } from "../types.ts";
import { loadActiveBudgetPolicy, projectInline, validateActiveBudgetPointer, validateBudgetPolicy, type BudgetPolicy } from "../improvement/policy.ts";
import { DEFAULT_PROJECTION_SNAPSHOT_LIMITS, writeProjectionEvent, type ProjectionEventV1, type ProjectionMaterialV1, type ProjectionSnapshotLimits } from "../improvement/observations.ts";
import { createExperienceProvider, verifyRequiredKnowledge } from "../knowledge/experience-index.ts";
import { retrieveKnowledge } from "../knowledge/retrieval.ts";
import type { KnowledgeRef, KnowledgeStore } from "../knowledge/types.ts";
import { GenerationStore, isM07WorkflowStrategy } from "../improvement/generation.ts";
import { probeProcessIdentity, readCurrentProcessIdentity, type ProcessIdentityV1 } from "../runtime/process-identity.ts";
import { parseRunDescriptor, type RunDescriptorV1 } from "../runtime/run-descriptor.ts";
import { verifyDescriptorLoadedSource, verifyLoadedSource } from "../runtime/loaded-source.ts";
import { runUntilReadyRounds } from "./execution-loop.ts";
import { openBoundedSession, type EvidenceBindingV1 } from "../context/boundary.ts";
import type { SessionHandle, ToolGrant } from "../runner/types.ts";
import type { Workspace } from "../workspace.ts";
import { failedM04Feedback, resolveM04Baseline, type FormalBaseline } from "./formal-baseline.ts";
import { writeFeedback } from "./feedback.ts";
import { candidateObservation, requireCandidateVerifier, type CandidateVerifier, type FrozenCandidateFile } from "./candidate-evaluation.ts";
import { candidateBudgetLedger, DEFAULT_SEARCH_BUDGET, operatorCategoryBudget, OPERATOR_CATEGORIES,
	type SearchBudgetPolicyV1 } from "./candidate-policy.ts";
import { distillEpisode, episodeRestartMessage, writeEpisodeRecord } from "./episode-record.ts";
import { createCandidateEpisodeTool } from "./candidate-episode.ts";
import { createCandidateExecutionTools, pendingCandidateExecutions, type CandidateExecutionBackend } from "./candidate-runner.ts";
import { candidateArchive, candidateSubjectId, createCandidateArchiveTools } from "./candidate-archive.ts";
import { loadPlatformProfile } from "../platform/profile.ts";
import { DEFAULT_HISTORY_DEPTH, layoutPrompt, type PromptLayoutReceiptV1, type PromptSectionKind, type PromptSectionV1 } from "./prompt-layout.ts";
import { createExecutionKnowledgeTools } from "./execution-knowledge.ts";
import { INJECTION_PLANS } from "../knowledge/injection.ts";
import { publicFailure } from "./public-failure.ts";
import { captureMaterial, copySnapshotBounded, createProjectionObservation, omissionLine, projectionMaterial } from "./projection.ts";
export type { FormalBaseline } from "./formal-baseline.ts";

const STATE = "goal.json";
const HOST_STOP_KEY = Symbol("m07-host-stop");
const HOST_STOP_REASONS: ReadonlySet<HostStopReasonKind> = new Set(["request-aborted", "provider-error", "session-shutdown", "no-progress"]);
const dispatchQueues = new Map<string, Promise<void>>();

type DispatchLock = Readonly<{ version: 1; kind: "m07-goal-dispatch-lock";
	goalRunId: string; owner: ProcessIdentityV1 }>;
type RecoveryClaim = Readonly<{ version: 1; kind: "m07-dispatch-recovery-claim";
	goalRunId: string; sequence: number; owner: ProcessIdentityV1;
	target: { dev: number; ino: number; owner: ProcessIdentityV1 } }>;
type RecoveryTerminal = Readonly<{ version: 1; kind: "m07-dispatch-recovery-terminal";
	goalRunId: string; sequence: number; result: "released" | "aborted" }>;
const dispatchLockBytes = (lock: DispatchLock): Buffer => Buffer.from(`${JSON.stringify(lock)}\n`, "utf8");
const sameIdentity = (a: ProcessIdentityV1, b: ProcessIdentityV1): boolean =>
	a.hostId === b.hostId && a.bootId === b.bootId && a.pid === b.pid &&
	a.processStartToken === b.processStartToken;
function validProcessIdentity(value: unknown): value is ProcessIdentityV1 {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const row = value as Record<string, unknown>;
	return Object.keys(row).sort().join("|") === "bootId|hostId|pid|processStartToken" &&
		Number.isSafeInteger(row.pid) && Number(row.pid) > 0 &&
		["hostId", "bootId", "processStartToken"].every(key =>
			typeof row[key] === "string" && (row[key] as string).length > 0 &&
			(row[key] as string).length <= 512 && !/[\0\r\n]/.test(row[key] as string));
}
async function syncDispatchDirectory(directory: string): Promise<void> {
	const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
	try { await handle.sync(); } finally { await handle.close(); }
}
async function optionalNoFollowBytes(file: string, maximum: number,
	maximumLinks = 1): Promise<Buffer | undefined> {
	let handle;
	try { handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
	catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
	try {
		const before = await handle.stat();
		if (!before.isFile() || before.nlink < 1 || before.nlink > maximumLinks ||
			(before.mode & 0o777) !== 0o600 ||
			before.size < 1 || before.size > maximum)
			throw new HarnessError("m07.concurrent", "recovery claim contains unsafe bytes");
		const bytes = await handle.readFile();
		const after = await handle.stat();
		if (bytes.length !== before.size || before.dev !== after.dev || before.ino !== after.ino ||
			before.size !== after.size || before.mtimeMs !== after.mtimeMs)
			throw new HarnessError("m07.concurrent", "recovery claim changed while reading");
		return bytes;
	} finally { await handle.close(); }
}
async function writePrivateRecord(file: string, value: unknown): Promise<void> {
	const bytes = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
	if (bytes.length > 4096) throw new HarnessError("m07.concurrent", "recovery claim exceeds byte bound");
	const handle = await open(file,
		constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
	try { await handle.writeFile(bytes); await handle.sync(); }
	finally { await handle.close(); }
}
async function readRecoveryClaims(directory: string, runId: string): Promise<Array<{
	claim: RecoveryClaim; terminal?: RecoveryTerminal }>> {
	const root = path.join(directory, ".delegate-recovery-claims");
	let info;
	try { info = await lstat(root); }
	catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
	if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0)
		throw new HarnessError("m07.concurrent", "recovery claim directory is unsafe");
	const entries = await readdir(root);
	if (entries.some(name => !/^C[0-9]{6,}$/.test(name) &&
		!/^\.prepare-[0-9a-f-]{36}$/.test(name)))
		throw new HarnessError("m07.concurrent", "recovery claim directory has an unknown member");
	const names = entries.filter(name => /^C[0-9]{6,}$/.test(name))
		.sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
	const rows: Array<{ claim: RecoveryClaim; terminal?: RecoveryTerminal }> = [];
	for (const [index, name] of names.entries()) {
		if (name !== `C${String(index + 1).padStart(6, "0")}`)
			throw new HarnessError("m07.concurrent", "recovery claim sequence is not contiguous");
		const claimDir = path.join(root, name);
		const claimInfo = await lstat(claimDir);
		if (!claimInfo.isDirectory() || claimInfo.isSymbolicLink() || (claimInfo.mode & 0o077) !== 0)
			throw new HarnessError("m07.concurrent", "recovery claim is not a private directory");
		const members = await readdir(claimDir);
		if (members.some(member => !["owner.json", "terminal.json"].includes(member) &&
			!/^\.terminal-[0-9a-f-]{36}$/.test(member)))
			throw new HarnessError("m07.concurrent", "recovery claim has an unknown member");
		const bytes = await optionalNoFollowBytes(path.join(claimDir, "owner.json"), 4096);
		if (!bytes) throw new HarnessError("m07.concurrent", "recovery claim owner is missing");
		let parsed: unknown;
		try { parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
		catch { throw new HarnessError("m07.concurrent", "recovery claim owner is invalid"); }
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) ||
			Object.keys(parsed).sort().join("|") !== "goalRunId|kind|owner|sequence|target|version")
			throw new HarnessError("m07.concurrent", "recovery claim owner is invalid");
		const row = parsed as Record<string, unknown>;
		const target = row.target as Record<string, unknown> | undefined;
		if (row.version !== 1 || row.kind !== "m07-dispatch-recovery-claim" ||
			row.goalRunId !== runId || row.sequence !== index + 1 || !validProcessIdentity(row.owner) ||
			!target || typeof target !== "object" || Array.isArray(target) ||
			Object.keys(target).sort().join("|") !== "dev|ino|owner" ||
			!Number.isSafeInteger(target.dev) || Number(target.dev) < 0 ||
			!Number.isSafeInteger(target.ino) || Number(target.ino) < 0 ||
			!validProcessIdentity(target.owner) ||
			!bytes.equals(Buffer.from(`${JSON.stringify(row)}\n`, "utf8")))
			throw new HarnessError("m07.concurrent", "recovery claim owner or target is invalid");
		const claim = row as RecoveryClaim;
		const terminalBytes = await optionalNoFollowBytes(path.join(claimDir, "terminal.json"), 4096, 2);
		let terminal: RecoveryTerminal | undefined;
		if (terminalBytes) {
			let value: unknown;
			try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(terminalBytes)); }
			catch { throw new HarnessError("m07.concurrent", "recovery terminal is invalid"); }
			if (!value || typeof value !== "object" || Array.isArray(value) ||
				Object.keys(value).sort().join("|") !== "goalRunId|kind|result|sequence|version")
				throw new HarnessError("m07.concurrent", "recovery terminal is invalid");
			const parsedTerminal = value as RecoveryTerminal;
			if (parsedTerminal.version !== 1 || parsedTerminal.kind !== "m07-dispatch-recovery-terminal" ||
				parsedTerminal.goalRunId !== runId || parsedTerminal.sequence !== claim.sequence ||
				!["released", "aborted"].includes(parsedTerminal.result) ||
				!terminalBytes.equals(Buffer.from(`${JSON.stringify(parsedTerminal)}\n`, "utf8")))
				throw new HarnessError("m07.concurrent", "recovery terminal identity is invalid");
			terminal = parsedTerminal;
		}
		rows.push({ claim, ...(terminal ? { terminal } : {}) });
	}
	return rows;
}
async function publishRecoveryClaim(directory: string, claim: RecoveryClaim): Promise<void> {
	const root = path.join(directory, ".delegate-recovery-claims");
	try { await mkdir(root, { mode: 0o700 }); await syncDispatchDirectory(directory); }
	catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
	const rootInfo = await lstat(root);
	if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || (rootInfo.mode & 0o077) !== 0)
		throw new HarnessError("m07.concurrent", "recovery claim directory is unsafe");
	const prepared = path.join(root, `.prepare-${randomUUID()}`);
	await mkdir(prepared, { mode: 0o700 });
	await writePrivateRecord(path.join(prepared, "owner.json"), claim);
	await syncDispatchDirectory(prepared);
	try {
		await rename(prepared, path.join(root, `C${String(claim.sequence).padStart(6, "0")}`));
		await syncDispatchDirectory(root);
	} catch (error) {
		if (["EEXIST", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? ""))
			throw new HarnessError("m07.concurrent", "another dispatch recovery claimed this goal");
		throw error;
	}
}
async function writeRecoveryTerminal(directory: string, terminal: RecoveryTerminal): Promise<void> {
	const root = path.join(directory, ".delegate-recovery-claims",
		`C${String(terminal.sequence).padStart(6, "0")}`);
	const temporary = path.join(root, `.terminal-${randomUUID()}`);
	await writePrivateRecord(temporary, terminal);
	try {
		await link(temporary, path.join(root, "terminal.json"));
		await syncDispatchDirectory(root);
	} finally {
		await unlink(temporary);
		await syncDispatchDirectory(root);
	}
}
async function recoveryPending(directory: string, runId: string): Promise<boolean> {
	const latest = (await readRecoveryClaims(directory, runId)).at(-1);
	return !!latest && !latest.terminal;
}
async function readDispatchLock(file: string, runId: string): Promise<{ lock: DispatchLock; dev: number; ino: number }> {
	let handle;
	try { handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
	catch { throw new HarnessError("m07.concurrent", "dispatch lock is absent or unsafe; inspect it before recovery"); }
	try {
		const before = await handle.stat();
		if (!before.isFile() || before.nlink < 1 || before.nlink > 2 ||
			(before.mode & 0o777) !== 0o600 || before.size < 1 || before.size > 2048)
			throw new HarnessError("m07.concurrent", "legacy or malformed dispatch lock requires manual review");
		const bytes = await handle.readFile();
		const after = await handle.stat();
		if (bytes.length !== before.size || before.dev !== after.dev || before.ino !== after.ino ||
			before.size !== after.size || before.mtimeMs !== after.mtimeMs)
			throw new HarnessError("m07.concurrent", "dispatch lock changed while reading");
		let value: unknown;
		try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
		catch { throw new HarnessError("m07.concurrent", "legacy or malformed dispatch lock requires manual review"); }
		if (!value || typeof value !== "object" || Array.isArray(value) ||
			Object.keys(value).sort().join("|") !== "goalRunId|kind|owner|version")
			throw new HarnessError("m07.concurrent", "legacy or malformed dispatch lock requires manual review");
		const row = value as Record<string, unknown>;
		if (row.version !== 1 || row.kind !== "m07-goal-dispatch-lock" ||
			row.goalRunId !== runId || !validProcessIdentity(row.owner) ||
			!bytes.equals(dispatchLockBytes(row as DispatchLock)))
			throw new HarnessError("m07.concurrent", "dispatch lock identity or bytes do not match this goal");
		return { lock: row as DispatchLock, dev: before.dev, ino: before.ino };
	} finally { await handle.close(); }
}
async function publishDispatchLock(file: string, lock: DispatchLock): Promise<{ dev: number; ino: number }> {
	const directory = path.dirname(file);
	const temporary = path.join(directory, `.delegate-lock.prepare-${randomUUID()}`);
	const handle = await open(temporary,
		constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
	try { await handle.writeFile(dispatchLockBytes(lock)); await handle.sync(); }
	finally { await handle.close(); }
	let published = false;
	try {
		// link is exclusive: rename could replace an existing empty legacy directory.
		await link(temporary, file);
		published = true;
		await syncDispatchDirectory(directory);
		await unlink(temporary);
		await syncDispatchDirectory(directory);
		const info = await lstat(file);
		if (!info.isFile()) throw new HarnessError("m07.concurrent", "published dispatch lock is not a file");
		return { dev: info.dev, ino: info.ino };
	} catch (error) {
		if (!published) await unlink(temporary).catch(() => undefined);
		if ((error as NodeJS.ErrnoException).code === "EEXIST")
			throw new HarnessError("m07.concurrent", "another process owns this goal's task dispatch; reconcile the lock separately");
		throw error;
	}
}
async function releaseDispatchLock(file: string, lock: DispatchLock, inode: { dev: number; ino: number }): Promise<void> {
	const current = await readDispatchLock(file, lock.goalRunId);
	if (current.dev !== inode.dev || current.ino !== inode.ino ||
		!sameIdentity(current.lock.owner, lock.owner))
		throw new HarnessError("m07.concurrent", "dispatch lock changed before owner release");
	await unlink(file);
	await syncDispatchDirectory(path.dirname(file));
}

/** Exact stale cleanup after an independent death proof. This never resumes a task or model call. */
export async function recoverM07DispatchLock(input: { ws: Workspace; runId: string;
	expectedOwner: ProcessIdentityV1; currentIdentity?: () => Promise<ProcessIdentityV1>;
	verifiedRecoveryOwners?: readonly ProcessIdentityV1[];
	probePrior?: typeof probeProcessIdentity }): Promise<void> {
	if (!validProcessIdentity(input.expectedOwner) || !input.runId ||
		/[/\\\0]/.test(input.runId) || input.runId === "." || input.runId === "..")
		throw new HarnessError("m07.concurrent", "dispatch recovery identity is invalid");
	const permittedOwners = [input.expectedOwner, ...(input.verifiedRecoveryOwners ?? [])];
	if (permittedOwners.some(owner => !validProcessIdentity(owner) ||
		owner.hostId !== input.expectedOwner.hostId || owner.bootId !== input.expectedOwner.bootId))
		throw new HarnessError("m07.concurrent", "verified dispatch recovery owner is invalid");
	const permitted = (owner: ProcessIdentityV1): boolean =>
		permittedOwners.some(candidate => sameIdentity(candidate, owner));
	const directory = input.ws.runDir("M07", input.runId);
	const file = path.join(directory, ".delegate-lock");
	const current = await (input.currentIdentity ?? readCurrentProcessIdentity)();
	if (!validProcessIdentity(current) || current.hostId !== input.expectedOwner.hostId ||
		current.bootId !== input.expectedOwner.bootId)
		throw new HarnessError("m07.concurrent", "dispatch owner is from another host or boot");
	const prior = (await readRecoveryClaims(directory, input.runId)).at(-1);
	let observed: Awaited<ReturnType<typeof readDispatchLock>> | undefined;
	try { await lstat(file); observed = await readDispatchLock(file, input.runId); }
	catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
	if (observed && !permitted(observed.lock.owner))
		throw new HarnessError("m07.concurrent", "dispatch owner differs from the expected attempt or verified recovery chain");
	if (prior && !prior.terminal) {
		if (!permitted(prior.claim.target.owner) ||
			(observed && (prior.claim.target.dev !== observed.dev || prior.claim.target.ino !== observed.ino)))
			throw new HarnessError("m07.concurrent", "pending recovery claim targets another dispatch lock");
		if (prior.claim.owner.hostId !== current.hostId || prior.claim.owner.bootId !== current.bootId)
			throw new HarnessError("m07.concurrent", "recovery claimer is from another host or boot");
		const priorProbe = await (input.probePrior ?? probeProcessIdentity)(prior.claim.owner);
		if (priorProbe.status !== "dead" || priorProbe.identityMatch)
			throw new HarnessError("m07.concurrent", "recovery claimer is live, reused, or uncertain");
	}
	if (!observed && (!prior || !permitted(prior.claim.target.owner)))
		throw new HarnessError("m07.concurrent", "dispatch lock is absent without exact recovery history");
	if (!observed && prior?.terminal?.result === "released") return;
	const target = observed ? { dev: observed.dev, ino: observed.ino,
		owner: observed.lock.owner } : prior!.claim.target;
	const claim: RecoveryClaim = { version: 1, kind: "m07-dispatch-recovery-claim",
		goalRunId: input.runId, sequence: (prior?.claim.sequence ?? 0) + 1,
		owner: current, target };
	await publishRecoveryClaim(directory, claim);
	let result: RecoveryTerminal["result"] = "aborted";
	try {
		if (!observed) { result = "released"; return; }
		const probe = await (input.probePrior ?? probeProcessIdentity)(observed.lock.owner);
		if (probe.status !== "dead" || probe.identityMatch)
			throw new HarnessError("m07.concurrent", "dispatch owner is live, reused, or uncertain");
		const again = await readDispatchLock(file, input.runId);
		if (again.dev !== target.dev || again.ino !== target.ino ||
			!sameIdentity(again.lock.owner, observed.lock.owner))
			throw new HarnessError("m07.concurrent", "dispatch lock changed during recovery");
		await unlink(file);
		await syncDispatchDirectory(directory);
		result = "released";
	} finally {
		await writeRecoveryTerminal(directory, { version: 1,
			kind: "m07-dispatch-recovery-terminal", goalRunId: input.runId,
			sequence: claim.sequence, result });
	}
}

/** One M07 dispatch per goal. Lock cleanup never starts a task. */
async function withGoalDispatch<T>(ctx: StageContext, runId: string, body: () => Promise<T>,
	processIdentity: () => Promise<ProcessIdentityV1>): Promise<T> {
	const key = ctx.ws.runDir("M07", runId);
	const prior = dispatchQueues.get(key) ?? Promise.resolve();
	let release!: () => void;
	const turn = new Promise<void>((resolve) => { release = resolve; });
	const tail = prior.then(() => turn);
	dispatchQueues.set(key, tail);
	await prior;
	const lockFile = path.join(key, ".delegate-lock");
	let acquired: { dev: number; ino: number } | undefined;
	let lock: DispatchLock | undefined;
	try {
		const owner = await processIdentity();
		if (!validProcessIdentity(owner)) throw new HarnessError("m07.concurrent", "current dispatch owner identity is invalid");
		lock = { version: 1, kind: "m07-goal-dispatch-lock", goalRunId: runId, owner };
		if (await recoveryPending(key, runId))
			throw new HarnessError("m07.concurrent", "dispatch lock recovery is active or incomplete");
		acquired = await publishDispatchLock(lockFile, lock);
		if (await recoveryPending(key, runId))
			throw new HarnessError("m07.concurrent", "dispatch lock recovery is active or incomplete");
		return await body();
	} finally {
		try { if (acquired && lock) await releaseDispatchLock(lockFile, lock, acquired); }
		finally { release(); if (dispatchQueues.get(key) === tail) dispatchQueues.delete(key); }
	}
}
/** Declared facts only: the harness checks their shape, never their truth. */
function validateSubjectProfile(profile: TaskSpecInput["subjectProfile"], budget: SearchBudgetPolicyV1): TaskSpecInput["subjectProfile"] {
	if (profile === undefined) return undefined;
	if (!profile || typeof profile !== "object" || Array.isArray(profile) ||
		Object.keys(profile).some((key) => !["operatorCategory", "categoryJustification", "implementationSpace", "rationale", "baselineStrength", "endToEndShare", "headroom"].includes(key)) ||
		!(OPERATOR_CATEGORIES as readonly string[]).includes(profile.operatorCategory) ||
		!["vendor-library", "dsl-or-ir", "handwritten-low-level"].includes(profile.implementationSpace) ||
		!["vendor-library", "framework-default", "none"].includes(profile.baselineStrength) ||
		typeof profile.rationale !== "string" || !profile.rationale.trim() || profile.rationale.length > 1000)
		throw new HarnessError("m07.subject-profile", "subjectProfile needs implementationSpace, a nonempty rationale under 1000 characters, and baselineStrength");
	if (profile.endToEndShare !== undefined && (typeof profile.endToEndShare !== "number" ||
		!Number.isFinite(profile.endToEndShare) || profile.endToEndShare < 0 || profile.endToEndShare > 1))
		throw new HarnessError("m07.subject-profile", "subjectProfile.endToEndShare must be a measured share in 0-1");
	if (profile.headroom !== undefined && (!profile.headroom || typeof profile.headroom !== "object" ||
		Array.isArray(profile.headroom) ||
		Object.keys(profile.headroom).some((key) => !["kind", "value", "source"].includes(key)) ||
		!["roofline-ratio", "sol-gap", "measured-reference", "unknown"].includes(profile.headroom.kind) ||
		typeof profile.headroom.source !== "string" || !profile.headroom.source.trim() ||
		profile.headroom.source.length > 400 ||
		(profile.headroom.value !== undefined && (typeof profile.headroom.value !== "number" || !Number.isFinite(profile.headroom.value)))))
		throw new HarnessError("m07.subject-profile", "subjectProfile.headroom needs a kind, a stated source, and a finite value when it claims one");
	// A category the evidence measures as a near-certain loss may still be worked
	// on, but only with a written reason that stays in the trajectory.
	const admitted = operatorCategoryBudget(budget, profile.operatorCategory).admitted;
	if (!admitted && (typeof profile.categoryJustification !== "string" || !profile.categoryJustification.trim()))
		throw new HarnessError("m07.subject-profile", `operator category ${profile.operatorCategory} is not in the default optimization queue: ${operatorCategoryBudget(budget, profile.operatorCategory).note}. Declare categoryJustification to work on it anyway.`);
	if (profile.categoryJustification !== undefined && (typeof profile.categoryJustification !== "string" ||
		!profile.categoryJustification.trim() || profile.categoryJustification.length > 1000))
		throw new HarnessError("m07.subject-profile", "subjectProfile.categoryJustification must be a nonempty reason under 1000 characters");
	return { operatorCategory: profile.operatorCategory,
		...(profile.categoryJustification ? { categoryJustification: profile.categoryJustification.trim() } : {}),
		implementationSpace: profile.implementationSpace, rationale: profile.rationale.trim(),
		baselineStrength: profile.baselineStrength,
		...(profile.endToEndShare === undefined ? {} : { endToEndShare: profile.endToEndShare }),
		...(profile.headroom ? { headroom: { kind: profile.headroom.kind, source: profile.headroom.source.trim(),
			...(profile.headroom.value === undefined ? {} : { value: profile.headroom.value }) } } : {}) };
}

function nonempty(value: string, label: string): string {
	if (!value?.trim()) throw new HarnessError("m07.input", `${label} 不能为空`);
	return value.trim();
}

function normalizedUnique(values: string[], label: string): string[] {
	const result = values.map((value) => nonempty(value, label));
	if (new Set(result).size !== result.length) throw new HarnessError("m07.input", `${label} 不能重复`);
	return result;
}

function sameStrings(a: string[], b: string[]): boolean {
	return a.length === b.length && a.every((value, index) => value === b[index]);
}

function modeRank(mode: TaskSpecInput["mode"]): number {
	if (mode === "execute") return 2;
	if (mode === "check") return 1;
	return 0;
}

function sameSupersededObligation(next: TaskSpecInput, previous: M07TaskRecord): boolean {
	return next.objective.trim() === previous.objective && next.subjectId === previous.subjectId && modeRank(next.mode) >= modeRank(previous.mode) && Boolean(next.requireIndependentCheck) === Boolean(previous.requireIndependentCheck) && sameStrings(next.checks, previous.checks) && sameStrings(next.expectedOutputs, previous.expectedOutputs);
}

function inside(root: string, candidate: string): boolean {
	return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

/** The same file-bound gate is used before a loop accepts ready and during final review. */
async function validateCandidateFiles(workDir: string, expectedPaths: string[], lessonDeltaOutput?: string): Promise<{
	expectedOutputs: ExpectedOutputResolution[];
	lessonEvidence: string[];
	lessonDeltaFailure?: string;
}> {
	const expectedOutputs = await resolveExpectedOutputFiles(workDir, expectedPaths);
	if (!lessonDeltaOutput) return { expectedOutputs, lessonEvidence: [] };
	try {
		const root = await realpath(workDir);
		const deltaSource = await realpath(path.join(workDir, lessonDeltaOutput));
		if (!inside(root, deltaSource)) throw new Error("candidate delta escaped task work directory");
		const bytes = await readFile(deltaSource);
		if (bytes.length > 16_000) throw new Error("candidate lesson-delta.json file exceeds 16,000 bytes");
		const delta = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
		if (delta.version !== 1 || !["none", "propose", "amend", "contradict"].includes(String(delta.action)) || !Array.isArray(delta.evidencePaths) || delta.evidencePaths.some((item) => typeof item !== "string" || !isSafeRelativeOutputPath(item))) throw new Error("candidate delta has invalid schema");
		if (delta.action !== "none" && (typeof delta.observation !== "string" || !delta.observation.trim() || typeof delta.applicability !== "string" || !delta.applicability.trim() || delta.evidencePaths.length === 0)) throw new Error("candidate delta lacks observation, applicability, or evidence");
		if ((delta.action === "amend" || delta.action === "contradict") && (!delta.priorRef || typeof delta.priorRef !== "object" || typeof (delta.priorRef as Record<string, unknown>).storeId !== "string" || typeof (delta.priorRef as Record<string, unknown>).recordId !== "string" || !Number.isInteger((delta.priorRef as Record<string, unknown>).version))) throw new Error("candidate delta revision lacks a pinned priorRef");
		const lessonEvidence: string[] = [];
		for (const item of delta.evidencePaths as string[]) {
			const evidence = await realpath(path.join(workDir, item));
			if (!inside(root, evidence)) throw new Error(`candidate delta evidence escaped task work directory: ${item}`);
			if (!(await stat(evidence)).isFile()) throw new Error(`candidate delta evidence is not a file: ${item}`);
			lessonEvidence.push(evidence);
		}
		return { expectedOutputs, lessonEvidence };
	} catch (error) {
		return { expectedOutputs, lessonEvidence: [], lessonDeltaFailure: `Candidate lesson delta is invalid or missing: ${(error as Error).message}` };
	}
}

async function snapshotRoundForReviewer(workDir: string, destination: string): Promise<number> {
	let bytes = 0;
	await cp(workDir, destination, { recursive: true, filter: async (source) => {
		const info = await lstat(source);
		if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory())) throw new HarnessError("m07.loop-snapshot", "round snapshot contains a symlink or special file");
		if (info.isFile()) bytes += info.size;
		return true;
	} });
	return bytes;
}

/** Preserve a long builder report as exact, readable UTF-8 segments in the reviewer's frozen grant. */
async function freezeBuilderReportForReviewer(report: string, reviewerRoot: string): Promise<{ message: string; folder: string }> {
	const reportBytes = Buffer.byteLength(report, "utf8");
	const folder = `.m07-builder-report-${randomUUID()}`;
	const reportDir = path.join(reviewerRoot, folder);
	await mkdir(reportDir);
	const segments: string[] = [];
	let current = "", currentBytes = 0;
	for (const character of report) {
		const size = Buffer.byteLength(character, "utf8");
		if (currentBytes + size > 8_000 && current) { segments.push(current); current = ""; currentBytes = 0; }
		current += character; currentBytes += size;
	}
	if (current) segments.push(current);
	for (const [index, segment] of segments.entries())
		await writeFileAtomic(path.join(reportDir, `part-${String(index + 1).padStart(6, "0")}.txt`), segment);
	return { folder, message: `The complete builder report (${reportBytes} UTF-8 bytes) is frozen, without inserted or omitted characters, into ${segments.length} ordered files ${folder}/part-000001.txt through ${folder}/part-${String(segments.length).padStart(6, "0")}.txt so material_read can access even a very long line. Read every part (and use offset/limit within a part if needed) before deciding; concatenating the parts without separators reconstructs the original. If you cannot inspect all relevant content, return blocked and explain what was unread. A file path alone is not evidence of having read it.` };
}

interface BranchManifestV1 {
	version: 1;
	parentRunId: string;
	parentTaskId: string;
	parentWorkRoot: string;
	authorizedChildRootBase: string;
	frozenWorkRoot: string;
	/** Observed regular-file bytes in the frozen formal work tree. */
	workBytes?: number;
	problemSourcePath: string;
	frozenProblemPath: string;
	knowledgeSnapshot?: string;
	m04BaselineRunId?: string;
	forkWorkspaceAuthority: { version: 1; parentRoot: string; authorizedChildRootBase: string; childWorkLeaf: string; frozenEvidenceRoot: string; files: Array<{ sourcePath: string; frozenPath: string; bytes: number }> };
	files: Array<{ relativePath: string; historicalPath: string; frozenPath: string; bytes: number }>;
}

function forbiddenBranchEvidence(relative: string): boolean {
	return relative.split(path.sep).some((part) => /^(?:\.git|\.ssh|\.aws|\.npmrc|\.pypirc|\.netrc|\.env(?:\..*)?|id_[a-z0-9_-]+)$/i.test(part) || /(?:^|[-_.])(?:api[-_]?key|password|oauth|service[-_]?account|credential|secret|token|session|auth)(?:[-_.]|$)/i.test(part) || /\.(?:jsonl|pem|key|p12|pfx)$/i.test(part));
}

/** Freeze only bounded task work evidence. Auth/session-like files fail closed rather than entering another execution root. */
async function freezeBranchWork(goal: CurrentGoal, task: M07TaskRecord): Promise<{ manifestPath: string; workSnapshotRoot: string; problemSnapshotCopy: string }> {
	const parentTaskDir = path.dirname(task.workDir);
	if ((await lstat(task.workDir)).isSymbolicLink()) throw new HarnessError("m07.branch-evidence", "task work directory was replaced by a symlink");
	const sourceRoot = await realpath(task.workDir);
	if (!inside(await realpath(parentTaskDir), sourceRoot)) throw new HarnessError("m07.branch-evidence", "task work directory escaped its task root");
	const root = path.join(parentTaskDir, "branch-source");
	const workSnapshotRoot = path.join(root, "work-snapshot");
	await mkdir(root, { recursive: false });
	const files: BranchManifestV1["files"] = [];
	let totalBytes = 0;
	await cp(sourceRoot, workSnapshotRoot, { recursive: true, filter: async (source) => {
		const relative = path.relative(sourceRoot, source);
		if (relative && forbiddenBranchEvidence(relative)) throw new HarnessError("m07.branch-evidence", `unsafe auth/session-like source cannot be forked: ${relative}`);
		const info = await lstat(source);
		if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory())) throw new HarnessError("m07.branch-evidence", "branch evidence contains a symlink or special file");
		if (info.isFile()) {
			totalBytes += info.size;
			files.push({ relativePath: relative, historicalPath: path.join(sourceRoot, relative), frozenPath: path.join(workSnapshotRoot, relative), bytes: info.size });
		}
		return true;
	} });
	const manifestPath = path.join(root, "manifest.json");
	for (const file of files) {
		if (!(await readFile(file.historicalPath)).equals(await readFile(file.frozenPath))) throw new HarnessError("m07.branch-evidence", `task work changed during branch evidence freeze: ${file.relativePath}`);
	}
	const problemInfo = await lstat(goal.problemSnapshotPath);
	if (!problemInfo.isFile() || problemInfo.isSymbolicLink()) throw new HarnessError("m07.branch-evidence", "original problem snapshot is not a regular file");
	const problemSnapshotCopy = path.join(root, "problem-snapshot.md");
	await copyFile(goal.problemSnapshotPath, problemSnapshotCopy);
	if (!(await readFile(goal.problemSnapshotPath)).equals(await readFile(problemSnapshotCopy))) throw new HarnessError("m07.branch-evidence", "original problem snapshot changed while freezing");
	const authorizedChildRootBase = await realpath(path.dirname(parentTaskDir));
	const manifest: BranchManifestV1 = { version: 1, parentRunId: goal.runId, parentTaskId: task.taskId, parentWorkRoot: sourceRoot, authorizedChildRootBase, frozenWorkRoot: workSnapshotRoot, workBytes: totalBytes, problemSourcePath: goal.problemSnapshotPath, frozenProblemPath: problemSnapshotCopy, knowledgeSnapshot: goal.knowledgeSnapshot, m04BaselineRunId: goal.m04BaselineRunId, forkWorkspaceAuthority: { version: 1, parentRoot: sourceRoot, authorizedChildRootBase, childWorkLeaf: path.basename(sourceRoot), frozenEvidenceRoot: workSnapshotRoot, files: files.map((file) => ({ sourcePath: file.historicalPath, frozenPath: file.frozenPath, bytes: file.bytes })) }, files };
	await writeFileAtomic(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
	for (const file of files) await chmod(file.frozenPath, 0o444);
	const directories = [workSnapshotRoot];
	for (const file of files) { let current = path.dirname(file.frozenPath); while (inside(workSnapshotRoot, current) && !directories.includes(current)) { directories.push(current); current = path.dirname(current); } }
	// Keep directories owner-writable for normal workspace cleanup. File mode deters
	// accidental edits; native execution is not an OS sandbox against the same UID.
	for (const directory of directories.sort((a, b) => b.length - a.length)) await chmod(directory, 0o755);
	await chmod(manifestPath, 0o444);
	await chmod(problemSnapshotCopy, 0o444);
	return { manifestPath, workSnapshotRoot, problemSnapshotCopy };
}

async function loadBranchManifest(source: NonNullable<M07TaskRecord["branchSource"]>, parentRunId: string, parentTaskId: string): Promise<BranchManifestV1> {
	let manifest: BranchManifestV1;
	try {
		const bytes = await readFile(source.manifestPath);
		if (!(await readFile(source.checkpoint.manifestSnapshot)).equals(bytes)) throw new Error("manifest differs from checkpoint copy");
		manifest = JSON.parse(bytes.toString("utf8")) as BranchManifestV1;
	}
	catch { throw new HarnessError("m07.branch", "frozen parent evidence manifest is unavailable"); }
	if (manifest.version !== 1 || manifest.parentRunId !== parentRunId || manifest.parentTaskId !== parentTaskId || manifest.authorizedChildRootBase !== path.dirname(path.dirname(manifest.parentWorkRoot)) || manifest.frozenWorkRoot !== source.workSnapshotRoot || manifest.frozenProblemPath !== source.problemSnapshotCopy || !Array.isArray(manifest.files) || manifest.files.some((file) => !Number.isSafeInteger(file.bytes) || file.bytes < 0) || (manifest.workBytes !== undefined && manifest.workBytes !== manifest.files.reduce((sum, file) => sum + file.bytes, 0))) throw new HarnessError("m07.branch", "frozen parent evidence manifest does not match the requested source");
	if (JSON.stringify(manifest.forkWorkspaceAuthority) !== JSON.stringify({ version: 1, parentRoot: manifest.parentWorkRoot, authorizedChildRootBase: manifest.authorizedChildRootBase, childWorkLeaf: path.basename(manifest.parentWorkRoot), frozenEvidenceRoot: manifest.frozenWorkRoot, files: manifest.files.map((file) => ({ sourcePath: file.historicalPath, frozenPath: file.frozenPath, bytes: file.bytes })) })) throw new HarnessError("m07.branch", "fork workspace authority does not match frozen evidence files");
	if ((await lstat(source.problemSnapshotCopy)).isSymbolicLink() || !(await lstat(source.problemSnapshotCopy)).isFile()) throw new HarnessError("m07.branch", "frozen problem evidence is unavailable");
	const snapshotRoot = await realpath(source.workSnapshotRoot);
	for (const file of manifest.files) {
		if (!file.relativePath || path.isAbsolute(file.relativePath) || file.relativePath.split(path.sep).includes("..") || forbiddenBranchEvidence(file.relativePath) || file.historicalPath !== path.join(manifest.parentWorkRoot, file.relativePath) || file.frozenPath !== path.join(source.workSnapshotRoot, file.relativePath)) throw new HarnessError("m07.branch", "frozen evidence mapping is unsafe");
		const sourceInfo = await lstat(file.frozenPath);
		const actual = await realpath(file.frozenPath);
		if (sourceInfo.isSymbolicLink() || !inside(snapshotRoot, actual) || !sourceInfo.isFile() || sourceInfo.size !== file.bytes) throw new HarnessError("m07.branch", "frozen evidence file is unavailable or changed");
	}
	return manifest;
}

function statePath(ctx: StageContext, runId: string): string {
	return path.join(ctx.ws.runDir("M07", runId), STATE);
}

function taskId(goal: CurrentGoal): string {
	return `T${String(goal.tasks.length + 1).padStart(3, "0")}`;
}

async function save(ctx: StageContext, goal: CurrentGoal): Promise<void> {
	goal.updatedAt = nowIso();
	await writeFileAtomic(statePath(ctx, goal.runId), `${JSON.stringify(goal, null, 2)}\n`);
}

async function load(ctx: StageContext, runId: string): Promise<CurrentGoal> {
	try {
		return JSON.parse(await readFile(statePath(ctx, runId), "utf8")) as CurrentGoal;
	} catch (error) {
		throw new HarnessError("m07.missing", `找不到 M07 目标 ${runId}：${(error as Error).message}`);
	}
}

async function activePolicySnapshot(ctx: StageContext): Promise<{ policy: BudgetPolicy; versionId: string }> {
	const pointerPath = path.join(ctx.ws.root, ".agent", "improvement", "active.json");
	for (let attempt = 0; attempt < 3; attempt++) {
		const before = await readTextIfExists(pointerPath);
		const policy = await loadActiveBudgetPolicy(ctx.ws.root);
		const after = await readTextIfExists(pointerPath);
		if (before !== after) continue;
		if (!before) return { policy, versionId: "builtin-default" };
		let parsed: unknown;
		try { parsed = JSON.parse(before); } catch { throw new HarnessError("improvement.active", "active.json 不是合法 JSON"); }
		return { policy, versionId: validateActiveBudgetPointer(parsed).versionId };
	}
	throw new HarnessError("m07.policy-race", "活动预算策略在 M07 begin 期间连续变化；未冻结不一致快照，请重试 begin");
}

function frozenPolicy(goal: CurrentGoal): BudgetPolicy {
	if (!goal.budgetPolicy || !goal.budgetPolicyVersionId || !goal.budgetPolicyFrozenAt) throw new HarnessError("m07.policy-legacy", `M07 目标 ${goal.runId} 创建于策略冻结机制之前；可查看，但不得悄悄套用当前 active policy 继续委派或生成反馈，请新建目标`);
	return validateBudgetPolicy(goal.budgetPolicy);
}

async function verifyFrozenWorkflowMethod(ctx: StageContext, goal: CurrentGoal, registeredStores?: ReadonlyMap<string, KnowledgeStore>, task?: TaskSpecInput): Promise<void> {
	if (!goal.workflowMethod) return;
	if (task) {
		const provider = createExperienceProvider(ctx.store, registeredStores);
		for (const targetKind of ["executor", "improver"] as const) {
			const requestedRefs = goal.workflowMethod.requiredExperienceRefs.filter((item) => item.targetKind === targetKind).map((item) => item.ref);
			if (!requestedRefs.length) continue;
			const applicability = targetKind === "executor"
				? { stage: "M07", tags: [goal.workflowMethod.artifact.slot, task.mode, ...(task.experienceTags ?? [])], contextRefs: task.experienceContextRefs }
				: { stage: "method-research", tags: [`m07-${goal.workflowMethod.artifact.slot}`] };
			const selection = await provider.select({ targetKind, applicability, requestedRefs, expectedSnapshotId: goal.knowledgeSnapshot, maxRecords: 100, maxChars: 100_000 });
			if (selection.status !== "ready" || selection.selected.length !== requestedRefs.length) throw new HarnessError("m07.workflow-method", "frozen method necessary experience is unavailable or not applicable to this task");
		}
	}
	const refs = new Map<string, KnowledgeRef>();
	for (const item of goal.workflowMethod.requiredExperienceRefs) refs.set(`${item.ref.storeId}/${item.ref.recordId}@${item.ref.version}`, item.ref);
	for (const ref of goal.workflowMethod.requiredKnowledgeRefs) refs.set(`${ref.storeId}/${ref.recordId}@${ref.version}`, ref);
	await verifyRequiredKnowledge(ctx.ws.root, [...refs.values()], goal.knowledgeSnapshot, registeredStores);
}

export async function latestFormalBaseline(ctx: StageContext): Promise<FormalBaseline | undefined> {
	return (await resolveM04Baseline(ctx)).baseline;
}

async function requireCurrentFormalBaseline(ctx: StageContext, goal: CurrentGoal): Promise<void> {
	if (!goal.formalBaseline && !goal.m04BaselineFailures?.length) return;
	const resolved = await resolveM04Baseline(ctx);
	const baseline = resolved.baseline;
	if (JSON.stringify(resolved.failedM04) !== JSON.stringify(goal.m04BaselineFailures ?? []) ||
		resolved.knowledgeSnapshot !== goal.knowledgeSnapshot ||
		(baseline?.run.runId ?? null) !== (goal.m04BaselineRunId ?? null)) {
		throw new HarnessError("m07.baseline", `M07 目标 ${goal.runId} 的正式基线或失败 M04 历史已变化；先处理最新运行并显式刷新基线`);
	}
}

function requireActive(goal: CurrentGoal): void {
	if (goal.lifecycle !== "active") throw new HarnessError("m07.finished", `M07 目标 ${goal.runId} 已结束，恢复只可查看，不能自动重跑`);
	if (goal.executionState && goal.executionState.attempts.find((attempt) => attempt.id === goal.executionState?.activeAttemptId)?.state !== "running") throw new HarnessError("m07.suspended", `M07 目标 ${goal.runId} 的执行尝试未运行；先经宿主控制面恢复`);
}

async function requireLoadedAttemptSource(goal: CurrentGoal): Promise<void> {
	const attempt = goal.executionState?.attempts.find((item) => item.id === goal.executionState?.activeAttemptId);
	if (!attempt?.runDescriptor.loadedSource) return; // Older attempts had no loaded-source proof.
	try { await verifyDescriptorLoadedSource(parseRunDescriptor(attempt.runDescriptor), import.meta.url); }
	catch (error) { throw new HarnessError("m07.source-version", `当前加载的工作流源码与运行中 attempt 不一致：${(error as Error).message}`); }
}

function nextAttemptId(goal: CurrentGoal): string { return `A${String((goal.executionState?.attempts.length ?? 0) + 1).padStart(3, "0")}`; }

function sameProcess(a: ProcessIdentityV1, b: ProcessIdentityV1): boolean {
	return a.hostId === b.hostId && a.bootId === b.bootId && a.pid === b.pid && a.processStartToken === b.processStartToken;
}

function validateRecoveryDescriptor(goal: CurrentGoal, descriptor: RunDescriptorV1, expectedAttemptId: string): RunDescriptorV1 {
	const parsed = parseRunDescriptor(descriptor);
	if (parsed.goalRunId !== goal.runId || parsed.attemptId !== expectedAttemptId || parsed.workspaceId !== goal.executionState?.attempts[0]?.runDescriptor.workspaceId) throw new HarnessError("m07.recovery", "恢复运行描述与目标、工作区或新 attempt 不匹配");
	return parsed;
}

async function confinedExistingFile(ctx: StageContext, requested: string): Promise<string> {
	const root = await realpath(ctx.ws.root);
	const candidate = path.resolve(ctx.ws.root, requested);
	let resolved: string;
	try { resolved = await realpath(candidate); } catch { throw new HarnessError("m07.path", `输入或证据文件不存在：${requested}`); }
	if (!inside(root, resolved)) throw new HarnessError("m07.path", `路径逃逸工作区：${requested}`);
	if (!(await lstat(resolved)).isFile()) throw new HarnessError("m07.path", `只接受现有文件：${requested}`);
	return resolved;
}

function uniqueName(index: number, source: string): string {
	return `${String(index + 1).padStart(3, "0")}-${path.basename(source).replace(/[^a-zA-Z0-9._-]/g, "_")}`;
}

/** The host's own platform facts, when a profile is configured. Chip,
 * toolchain, capacities and timing protocol are static for a run, so they
 * belong in the stable part of the prompt rather than in each round's text. */
async function platformSection(): Promise<PromptSectionV1 | undefined> {
	const file = process.env.PRE_RSI_PLATFORM_PROFILE;
	if (!file) return undefined;
	try {
		const profile = await loadPlatformProfile(file);
		const capacities = Object.entries(profile.capacities).slice(0, 12)
			.map(([name, value]) => `- ${name}: ${value.value}${value.unit ? ` ${value.unit}` : ""}`).join("\n");
		return { key: "platform", kind: "hardware",
			text: section("目标硬件与工具链", [`档案 ${profile.id}；芯片 ${profile.chip}；工具链 ${profile.toolchain}`,
				capacities ? `容量上限：\n${capacities}` : "",
				profile.timing ? `计时协议 ${profile.timing.protocolVersion}：warmup ${profile.timing.warmup}、repeats ${profile.timing.repeats}、最小运行 ${profile.timing.minRuntimeMs}ms` : "",
				"以上是宿主档案登记的事实，不是性能保证；任何加速比都必须标注基线类别与硬件型号。",
			].filter(Boolean).join("\n")) };
	} catch { return undefined; }
}

/** One bounded line per earlier candidate on this work object: what was tried,
 * where, and what the host ruled. This is the prompt's history section, and it
 * is the only history the next round carries. */
function recentCandidateHistory(goal: CurrentGoal, subjectId?: string): PromptSectionV1[] {
	const rows = candidateArchive(goal).filter(entry =>
		!subjectId || candidateSubjectId(entry.subjectId, entry.observation) === subjectId);
	return rows.map((entry) => ({ key: entry.ref, kind: "history" as const,
		text: section(`历史候选 ${entry.ref}`, [
			`改动类别 ${entry.changeKind ?? "未标注"}；策略 ${entry.strategy ?? "未标注"}；位置 ${entry.location ?? "未标注"}`,
			`宿主判决 ${entry.policy?.guard ?? "未判决"}；准入状态 ${entry.policy?.status ?? "未知"}；分数 ${entry.policy?.score ?? "未知"}`,
			entry.policy?.failureSignature ? `失败签名 ${entry.policy.failureSignature}` : "",
			entry.hypothesis ? `假设 ${entry.hypothesis.slice(0, 200)}` : "",
		].filter(Boolean).join("\n")) }));
}

async function taskMessage(ctx: StageContext, goal: CurrentGoal, taskId: string, task: TaskSpecInput, copies: M07TaskRecord["inputCopies"], knowledgePack: string | undefined, policy: BudgetPolicy, limits: ProjectionSnapshotLimits, operationId?: string, tempDir?: string, reservedSuffixChars = 0): Promise<{ message: string; event: ProjectionEventV1; layout: PromptLayoutReceiptV1 }> {
	const event = await createProjectionObservation(ctx, goal, "task-message", policy, limits, taskId);
	const planCopy = task.planInput ? copies.find((item) => item.source === task.planInput)?.copy : undefined;
	const resourceCopies = (task.resourceInputs ?? []).map((item) => ({ ...item, copy: copies.find((copy) => copy.source === item.input)?.copy }));
	const actualInputs: string[] = [];
	const inventory: string[] = [];
	const textInputs: Array<{ inventoryIndex: number; material: { chars: number; bytes: number; path: string; text?: string }; record: ProjectionMaterialV1; inputSection: string; inline: boolean }> = [];
	let inlineChars = 0;
	try {
	for (const item of copies) {
		const relative = path.relative(path.dirname(path.dirname(item.copy)), item.copy);
		const materialRecord = projectionMaterial(ctx, event, event.materials.length, "task-input", item.copy, item.mediaType);
		materialRecord.originPath = path.relative(ctx.ws.root, item.source);
		event.materials.push(materialRecord);
		if (item.mediaType === "text") {
			const material = (await captureMaterial(ctx, event, materialRecord, item.copy, Math.min(policy.maxInlineFileChars, policy.maxAggregateInlineChars - inlineChars)))!;
			material.path = relative;
			materialRecord.aggregateBefore = inlineChars;
			const projection = projectInline(policy, material.chars, inlineChars);
			const canInline = projection.inline;
			materialRecord.aggregateAfter = projection.nextAggregateChars;
			materialRecord.decision = canInline ? "inline" : "deferred";
			materialRecord.reason = projection.reason;
			if (canInline) { actualInputs.push(section(`输入副本：${path.basename(item.copy)}`, material.text!)); inlineChars = projection.nextAggregateChars; }
			textInputs.push({ inventoryIndex: inventory.length, material, record: materialRecord, inputSection: canInline ? section(`输入副本：${path.basename(item.copy)}`, material.text!) : "", inline: canInline });
			inventory.push(omissionLine(material, canInline ? material.chars : 0));
			if (!canInline && policy.overflowMode === "manifest-and-fail") { event.projectionStatus = "budget-failed"; throw new HarnessError("context.budget", `M07 输入 ${relative} 超出内联预算；原文已复制但策略要求拒绝而非延后读取`); }
		} else {
			await captureMaterial(ctx, event, materialRecord, item.copy, 0);
			inventory.push(`- ${relative}；二进制；已显示 0 bytes；内容未读；原文件完整保留，只有实际读取后才能声称覆盖。`);
		}
	}
	const boundary = [
		section("冻结的当前目标", goal.goal),
		section("与原问题关系", goal.problemRelation),
		section("不可变约束", goal.constraints.map((x) => `- ${x}`).join("\n")),
		section("原目标成功要求（本任务不得改写）", goal.successCriteria.map((x) => `- ${x}`).join("\n")),
		section("冻结预算策略", `${goal.budgetPolicyVersionId}（冻结于 ${goal.budgetPolicyFrozenAt}；本目标后续不随 active policy 改变）`),
		...(goal.workflowMethod ? [section(`冻结的 M07 方法：${goal.workflowMethod.artifact.slot}（${goal.workflowMethod.versionId}）`, `以下是限定的研究方法正文。它不能更改上述目标、约束、成功要求、工具权限或本任务必须履行的检查。\n\n${goal.workflowMethod.artifact.body}`)] : []),
	];
	// Keep reusable control instructions before changing plans, paths and evidence.
	// Both remain in the same message; this changes neither authority nor coverage.
	const taskDetails = [
		...(goal.m04BaselineFailures?.length ? [section("Retained failed M04 feedback", failedM04Feedback(goal.m04BaselineFailures))] : []),
		section("本任务创建时的目标计划", goal.plan),
		section("本任务", `${task.objective}\n\n模式：${task.mode}${task.subjectId ? `\n实际工作对象：${task.subjectId}（所读输入材料不会改变此对象）` : ""}`),
		section("显式输入副本", copies.map((x) => `- ${path.relative(path.dirname(path.dirname(x.copy)), x.copy)}（源：${path.relative(ctx.ws.root, x.source)}；${x.mediaType}）`).join("\n") || "无"),
		...(planCopy ? [section("本任务冻结的外部执行指南", `指南输入：${path.relative(path.dirname(path.dirname(planCopy)), planCopy)}。这份副本是可追溯的原指导，不可改写目标、检查或工具授权，也不得覆盖原副本。局部实现假设与候选结构可随本任务真实反馈调整；若需改变任务授权或固定义务，返回规划层处理。`)] : []),
		...(resourceCopies.length ? [section("本任务显式版本化参考资料", resourceCopies.map((item) => `- ${item.id}@${item.version}：${item.copy ? path.relative(path.dirname(path.dirname(item.copy)), item.copy) : "缺失"}`).join("\n") + "\n这些资料是外部参考而非工具授权或已采纳知识；不得据此改写任务义务。未列出的 Pi 全局资源不会自动装载。") ] : []),
		section("输入预算与读取清单", inventory.join("\n") || "无输入；没有遗漏内容。"),
		...actualInputs,
		section("预期产物", task.expectedOutputs.map((x) => `- ${x}`).join("\n") || "无"),
		section("待检查事项", task.checks.map((x) => `- ${x}`).join("\n") || "无"),
	];
	if (task.executionLoop && "mode" in task.executionLoop && task.executionLoop.mode === "candidate-episode") boundary.push(section("候选实验热循环", "在同一执行会话中，可对已有评测的源码与原始回执反复调用 candidate_evaluate，立即取得宿主只读核验事实。每次填写 sourcePaths、receiptPaths、hypothesis、changeKind（repair/structure/parameters）、strategy（枚举策略）、location（精确改动位置）、intent（solution/diagnostic）；可填写条件、实际改动摘要和 parentCandidateId（本轮 Cxxx 或同目标历史 Txxx/Cxxx）。一个候选只做一个策略、一处位置；位置必须真的出现在提交的源码里。这些是模型声明的适用与血缘，不是宿主证明的因果。宿主对每次核验给出确定性判决（guard：reject/keep/accept/revert；分层有界分数；lane 与 bootstrap/tuning 相位）与搜索状态（停滞计数与信号、禁令方向、repair-in-place/restructure/replan 路线、父代选项、策略菜单与各策略成绩），判决与路线不接受协商；停滞期内重复被禁的「改动类别+策略+位置」必须显式给出 newEvidence。bootstrap 相位（该工作对象尚无通过核验的正确候选）只允许修复与结构改动，数值参数候选必须在 tuning 相位并声明已验证正确的父候选。candidate_list 列出同目标历史候选与同口径最佳，candidate_read 读取冻结证据，candidate_checkout 复制历史源码作下一工作点；原回执只属历史，改动后要取得新评测回执。上述核验与归档工具处理已有结果。宿主另外提供 candidate_run 时，通过它冻结并执行新候选，按工具声明配置后端；pending 使用原 runId 与 resume 查询。已有回执仍用 candidate_evaluate。执行者确定有限数值参数域后，可用 candidate_sweep 枚举该域并保留每项结果；工具不决定结构、搜索宽度或停止条件。没有执行后端时，按任务已有授权工具执行并保存原始回执。当前探索父代可为较慢或近似正确候选；只有源码绑定且正确性通过的同口径测量可更新对应最佳，不同 basis 不作高低比较。编译/数值负反馈可在本会话修复再测，无需等另一个 reviewer 轮次。最终报告返回规划层，原任务检查、研究评审与原目标验收仍独立进行。用户约束和成功标准不可修订；目标计划、局部路线假设及候选父代可随证据调整。"));
	if (task.executionLoop && (!("mode" in task.executionLoop) || task.executionLoop.mode !== "candidate-episode")) boundary.push(section("执行返工", "mode" in task.executionLoop ?
		"同一候选可持续局部修补，直至 reviewer 给出终态判断或发生真实阻断；每轮由全新只读 reviewer 反馈。不得扩大任务义务、替换指南或假称 reviewer 的 ready 是最终采用。" :
		`历史记录中的轮数 ${task.executionLoop.maxRounds} 和截止时间 ${task.executionLoop.deadlineAt} 仅供审计，不是当前执行限制。同一候选可持续局部修补，直至 reviewer 给出终态判断或发生真实阻断；每轮后由全新只读 reviewer 给出反馈；只有控制器可决定是否再次提示。不得扩大任务义务、替换指南或假称 reviewer 的 ready 是最终采用。`));
	if (task.lessonDeltaOutput) taskDetails.push(section("候选经验回流", `将本轮候选经验写入 ${task.lessonDeltaOutput}，JSON 格式为 {"version":1,"action":"none|propose|amend|contradict","observation":"...","hypothesis":"...","applicability":"...","evidencePaths":["本任务 work 内相对路径"]}。none 合法；不确定因果写为假设。evidencePaths 应指向支持或反驳观察的确切改动产物与检查、测量或回执；使用旧经验时，说明实际采用、修改或弃用及相应实测。仅修正本任务尚未入库的候选时仍用 propose；amend 或 contradict 只用于修订/反驳已存在且已固定身份的知识记录，必须加 "priorRef":{"storeId":"...","recordId":"...","version":1}，不得猜测 ID。此文件是待 M04 处理的候选，不能自称已采纳知识。`));
		if (task.candidate) taskDetails.push(section("宿主候选核验", `本任务类别：${task.candidate.intent ?? "solution"}；声明的候选源码：${task.candidate.sourcePaths.join("、")}；平台原回执：${task.candidate.receiptPaths.join("、")}。保留实际提交请求、平台身份和原响应，确保回执可关联到当前源码；不要把摘要或本地命令退出码当作平台结论。${task.executionLoop && "mode" in task.executionLoop && task.executionLoop.mode === "candidate-episode" ? "同一会话中的 candidate_evaluate 可即时只读核验已有结果；任务返回后的最终声明须与某次冻结候选字节一致，不额外重跑评测。" : "宿主在任务返回后只读核验这些已落盘结果。"}未知绑定和未测要求会保持未知，不由报告自述补全。诊断任务可以交付有效负结果，但不因此达成原目标。`));
	if (task.mode === "execute") boundary.push(section("候选迭代与已有材料", "进行候选优化时，在本任务已有报告或实验记录中逐次写清优化假设、相对上一候选的实际改动、同口径检查或测量的真实反馈，以及保留、否定或待证的结论；区分当前探索候选和按原目标已验证的最佳产物，无需另建文件。若优化算子，分开记录编译、接口、数值正确性与性能、评分反馈；依据真实测量诊断瓶颈，可在有帮助且可用时使用 profiler，不设固定工具。只对实际通过本题正确性检查的候选按原目标和可比口径比较性能或评分，不把速度当正确性证据。显式输入中已有的脚本或经验可以复用，但先核对当前任务的适用性与完整依赖，在本任务 work 内从输入副本派生，并记录修改及验证；旧输入或旧通过记录本身不代表当前已验证。编号输入副本不保持原多文件脚本的相对依赖路径；复用时仅从显式输入在 work 内按原相对关系派生可运行副本。若报模块不存在，先核对解析出的路径与实际文件名。"));
	if (task.mode === "execute") boundary.push(section("外部执行与可消耗资源", `若执行有真实副作用的远端动作，保存实际参数、外部请求/结果 ID、响应和可用的查询方法；在响应丢失后先查询，不能仅凭超时重发。任务级 ID 是恢复索引，只有远端明确支持时才能作为幂等键，不能声称 exactly-once。\n\n如任务涉及真实提交、评测、远程实验或其他可能消耗配额/费用/机会的动作：先用已提供的只读能力或额度接口核对接入和当前状态，并先做本地可完成的语法、类型、编译与兼容性预检。这不禁止任务已授权的真实实验，已授权平台评测/实验产生的结果属于本任务实测证据。每次真实动作都要记录实际结果和资源消耗；失败若仍消耗了资源，同样记录已消耗量、可见剩余量与恢复条件。平台配额不明时如实记录未知，不猜测统一配额。本地命令或客户端成功退出不等于远程实验通过。显式输入和原问题允许使用；若需取得新的外部研究参考资料并用于推理，将具体缺口报回主会话走 M05/M06→M04，不在 execute 任务里通过 bash 另造获取和采用链。`));
	boundary.push("任务义务继承冻结目标、原成功条件和用户约束；局部 objective/checks 不得放宽它们。有界指职责、输入和操作范围，不授权自行添加尝试次数、耗时或费用停止条件。以达成为目标时，持续推进并按结果验收，不能用执行过或记录负结果替代达成。若任务本身是取证或检验，应如实返回其结果，并明确父目标仍未解决的要求。会话返回只表示内部交接，不表示原目标完成；列明实际动作、产物、失败、未执行项和限制。");
	if (task.mode === "execute") taskDetails.push(section("本任务控制操作", operationId ?? "旧目标无操作登记"));
	taskDetails.push(tempDir ? `产物路径规则：expectedOutputs 必须是当前任务工作目录内的精确相对路径；说明写在 objective 或 report.md。正式脚本、输入、测量、回执、负结果、复现数据和证据都必须保存在当前 work 目录。已落盘的原始查询、评测和实验回执须原样保留；派生汇总与后续查询另存并引用原文件。若已有原始记录被覆盖，如实报告缺失；摘要、计数或重新查询不能冒充恢复。临时缓存、下载和浏览器 profile 可写入独立目录 ${tempDir}；bash 的 TMPDIR 指向它。临时目录不属于正式证据，不会进入 reviewer 快照或 branch，也不能作为产物或检查引用。不要写到其他目录。` : "产物路径规则：expectedOutputs 必须是当前任务工作目录内的精确相对路径；说明写在 objective 或 report.md。所有实际写盘必须落在当前工作目录内，不要写到工作区根目录或绝对路径。已落盘的原始查询、评测和实验回执须原样保留；派生汇总与后续查询另存并引用原文件。若已有原始记录被覆盖，如实报告缺失；摘要、计数或重新查询不能冒充恢复。");
	if (knowledgePack) boundary.push(section("本任务局部知识包", knowledgePack));
	boundary.push(...taskDetails);
	// Static instructions first, then hardware, knowledge, bounded history and
	// finally this round's dynamic material. The order is fixed so two rounds
	// that differ only in feedback share a byte-identical prefix.
	const historySections = recentCandidateHistory(goal, task.subjectId);
	const hardware = await platformSection();
	const layout = layoutPrompt([
		...(hardware ? [hardware] : []),
		...boundary.map((text, index) => ({ key: `boundary-${index}`,
			kind: (text.startsWith("【本任务局部知识包】") ? "knowledge" :
				text.startsWith("【目标硬件与工具链】") ? "hardware" : "instruction") as PromptSectionKind, text })),
		...historySections,
	], { historyDepth: ctx.config.promptLayout?.historyDepth ?? DEFAULT_HISTORY_DEPTH });
	const orderedBoundary = layout.text ? layout.text.split("\n\n") : [];
	boundary.length = 0;
	boundary.push(...orderedBoundary);
	const inputBlockStart = boundary.findIndex((part) => part.startsWith("【输入预算与读取清单】\n"));
	let inputBlockLength = 1 + actualInputs.length;
	const systemChars = systemPromptFor(task.mode === "check" ? "reviewer" : "execution").length;
	let message = boundary.join("\n\n");
	while (message.length + systemChars + reservedSuffixChars > policy.maxPromptChars && policy.overflowMode === "manifest-and-defer") {
		const lastInline = [...textInputs].reverse().find((row) => row.inline && row.material.chars > 0);
		if (!lastInline) break;
		lastInline.inline = false;
		inventory[lastInline.inventoryIndex] = omissionLine(lastInline.material, 0);
		const revisedBlock = [section("输入预算与读取清单", inventory.join("\n") || "无输入；没有遗漏内容。"), ...textInputs.filter((row) => row.inline).map((row) => row.inputSection)];
		boundary.splice(inputBlockStart, inputBlockLength, ...revisedBlock);
		inputBlockLength = revisedBlock.length;
		message = boundary.join("\n\n");
	}
	if (message.length + systemChars + reservedSuffixChars > policy.maxPromptChars) { event.projectionStatus = "budget-failed"; throw new HarnessError("context.budget", `M07 控制事实与允许内联内容共 ${message.length + reservedSuffixChars} 字符，超过 prompt 预算 ${policy.maxPromptChars}；未静默截断`); }
	let aggregate = 0;
	const forced: number[] = [];
	for (const row of textInputs) {
		const projected = projectInline(policy, row.material.chars, aggregate);
		if (row.inline && !projected.inline) throw new HarnessError("m07.projection", "保留的输入内联与冻结预算不一致");
		const promptDeferred = !row.inline && projected.inline;
		if (promptDeferred) forced.push(row.record.ordinal);
		const nextAggregate = row.inline ? projected.nextAggregateChars : aggregate;
		row.record.aggregateBefore = aggregate;
		row.record.aggregateAfter = nextAggregate;
		row.record.decision = row.inline ? "inline" : "deferred";
		row.record.reason = promptDeferred ? "overflow-mode" : projected.reason;
		aggregate = nextAggregate;
	}
	if (forced.length) event.taskPromptDeferredOrdinals = forced;
	event.projectionStatus = "materialized";
	event.outputPath = path.relative(ctx.ws.runDir("M07", goal.runId), path.join(ctx.ws.runDir("M07", goal.runId), "tasks", taskId, "message.md"));
	return { message, event, layout: layout.receipt };
	} finally { await writeProjectionEvent(ctx.ws, event); }
}

function isFeedbackControlOverflow(error: unknown): boolean {
	return error instanceof HarnessError && error.code === "context.budget" && error.message.startsWith("M07 反馈包的控制事实与预算内清单共 ");
}

async function writeLegacyInterruptFeedback(ctx: StageContext, goal: CurrentGoal): Promise<string> {
	const lines = [
		"# M07 legacy 受控中断反馈包", "",
		`- 目标：${goal.goal}`,
		`- 与原问题关系：${goal.problemRelation}`,
		`- 目标结果：${goal.outcome ?? "blocked"}`,
		`- 返回路径：${goal.returnPath ?? "user"}`,
		"- 冻结预算策略：缺失（旧记录）", "",
		"此旧目标创建时没有冻结预算策略。为保证硬停止可执行，本归档只记录控制事实和证据位置，不读取、不内联、不截断证据正文，也不套用当前 active policy。下列路径存在不表示其内容已被本反馈包核验。", "",
		"## 原成功要求", "", ...goal.successCriteria.map((item) => `- ${item}`), "",
		"## 任务状态与证据位置", "",
	];
	for (const task of goal.tasks) {
		lines.push(`### ${task.taskId} ${task.objective}`, "", `- 状态：${task.status}`, `- 模式：${task.mode}`);
		if (task.reportPath) lines.push(`- 会话报告位置：${path.relative(ctx.ws.root, task.reportPath)}（未由本归档读取）`);
		for (const artifact of task.review?.artifacts ?? []) lines.push(`- 冻结产物位置：${path.relative(ctx.ws.root, artifact.path)}（未由本归档读取）`);
		for (const check of task.review?.checks ?? []) for (const evidence of check.evidence) lines.push(`- 检查证据位置：${path.relative(ctx.ws.root, evidence)}（未由本归档读取）`);
		if (task.executionFailure) lines.push(`- 执行失败：${task.executionFailure}`);
		for (const failure of task.review?.failures ?? []) lines.push(`- 评审失败：${failure}`);
		for (const item of task.review?.unexecuted ?? []) lines.push(`- 未执行：${item}`);
		lines.push("");
	}
	lines.push("## 总结与限制", "", goal.finishSummary ?? "受控中断", ...goal.limitations.map((item) => `- ${item}`), "", "- legacy 归档没有证据正文覆盖，不能作为证据完整性或科学结论证明。", "");
	const target = path.join(ctx.ws.runDir("M07", goal.runId), "m04-feedback.md");
	const feedback = lines.join("\n");
	if (feedback.length > 4_000) throw new HarnessError("context.budget", `M07 legacy 中断控制事实共 ${feedback.length} 字符，超过归档上限 4000；原记录未截断`);
	await writeFileAtomic(target, feedback);
	return target;
}

/** A bounded handoff index; the complete source stays in goal.json and frozen task files. */
async function writeBoundedFeedbackIndex(ctx: StageContext, goal: CurrentGoal, mode: "finish" | "interrupt" | "checkpoint", checkpointRoot?: string): Promise<string> {
	const cap = goal.budgetPolicy ? frozenPolicy(goal).maxFeedbackChars : 4_000;
	const taskCounts = new Map<string, number>();
	for (const task of goal.tasks) taskCounts.set(task.status, (taskCounts.get(task.status) ?? 0) + 1);
	const lines = [
		mode === "finish" ? "# M07 已结束目标：有界反馈索引" : mode === "checkpoint" ? "# M07 active 目标：非终态开发 checkpoint 有界索引" : goal.budgetPolicy ? "# M07 受控中断：仅控制事实" : "# M07 legacy 受控中断反馈包：仅控制事实", "",
		`- M07 runId：${goal.runId}`,
		...(goal.checkpointScope ? [`- 本批已选任务 ${goal.checkpointScope.selectedTaskIds.length}：${goal.checkpointScope.selectedTaskIds.slice(0, 20).join("、") || "无"}${goal.checkpointScope.selectedTaskIds.length > 20 ? "（其余见 manifest.json）" : ""}；未选任务 ${goal.checkpointScope.omittedTaskIds.length}：${goal.checkpointScope.omittedTaskIds.slice(0, 20).join("、") || "无"}${goal.checkpointScope.omittedTaskIds.length > 20 ? "（其余见 manifest.json）" : ""}。未选任务的评审证据未交接。`] : []),
		mode === "checkpoint" ? "- 目标仍 active；M07 run 仍 running。本快照不是目标终态，也不证明原成功要求已满足。" : `- 目标终态：${goal.outcome ?? "未知"}；M07 run 终态：${mode === "interrupt" || goal.outcome === "blocked" ? "failed" : "completed"}。目标结果由控制器硬检查确定，本索引不新增科学结论。`,
		`- 任务总数：${goal.tasks.length}；状态计数：${[...taskCounts].map(([status, count]) => `${status}=${count}`).join("，") || "无任务"}。`,
		`- 完整控制记录：${STATE}（含任务、工具日志、目标检查、限制及原始引用）；M04 可用 m07_evidence_read 对 goal.json 按 offset/limit 分段实际读取。`,
		...(goal.m04BaselineFailures?.length ? [`- Retained failed M04 feedback: ${goal.m04BaselineFailures.map(item => `${item.runId}:${item.transactionState}`).join(", ")}; full failure details remain in goal.json, with no adoption from those runs.`] : []),
		"- 原证据位置：请按 goal.json 的各任务 reportPath、review.frozenReportPath、review.artifacts 与 review.checks.evidence 定位；文件内容未由本包读取。",
		"- 省略类别：目标与任务长文本、工具日志、检查明细、产物正文、逐项证据清单；没有把这些内容截断后冒充完整反馈。",
		`- 完整反馈失败类别：${goal.feedbackError?.code ?? "unknown"}；详情见 goal.json 的 feedbackError。`,
		mode === "finish" ? "- 这是有界反馈索引，不是完整 M07 科学证据交接。即使目标硬检查为 fulfilled，也不代表 M04 已读完整记录或独立确认科学结论。" : mode === "checkpoint" ? "- 这是非终态开发索引，不是完整科学证据交接。M04 可按需读取冻结材料；不能由本包断言全部材料已读或目标 fulfilled。" : "- 这是退出归档的有界索引，不是完整 M07 科学证据交接。M04 可以读取这些中断事实；不能由本包断言科学验证通过、全部材料已读或目标 fulfilled。",
		...(goal.budgetPolicy ? [] : ["- 冻结预算策略：缺失（旧记录）；未套用当前 active policy。本包不读取、不内联、不截断证据正文。"]),
		"- 后续如需证据，应另按原路径实际读取并记录覆盖范围；路径存在不代表内容已读取。",
	];
	const feedback = lines.join("\n");
	if (feedback.length > cap) throw new HarnessError(mode === "finish" ? "context.budget" : "m07.archive-repair-required", `M07 有界反馈索引 ${feedback.length} 字符超过上限 ${cap}；goal.json 保留完整记录，需修复反馈交接`);
	const target = path.join(checkpointRoot ?? ctx.ws.runDir("M07", goal.runId), "m04-feedback.md");
	await writeFileAtomic(target, feedback);
	return target;
}

/** Freeze only reviewed task evidence and the problem inputs needed by M04. */
async function freezeCheckpoint(ctx: StageContext, goal: CurrentGoal, limits: ProjectionSnapshotLimits, selectedTaskIds: string[]): Promise<M07CheckpointRecord> {
	const runDir = ctx.ws.runDir("M07", goal.runId);
	const checkpointsDir = path.join(runDir, "checkpoints");
	await mkdir(checkpointsDir, { recursive: true });
	let id = "";
	let rootDir = "";
	for (let ordinal = (goal.checkpoints?.length ?? 0) + 1; Number.isSafeInteger(ordinal); ordinal++) {
		const candidateId = `C${String(ordinal).padStart(3, "0")}`;
		const candidateDir = path.join(checkpointsDir, candidateId);
		try {
			await mkdir(candidateDir); // Never overwrite or remove an incomplete prior attempt.
			id = candidateId;
			rootDir = candidateDir;
			break;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
	}
	if (!id) throw new HarnessError("m07.checkpoint", "checkpoint 编号已用尽；本次快照未登记，原目标仍 active");
	const frozen = structuredClone(goal);
	delete frozen.checkpoints;
	const selected = new Set(selectedTaskIds);
	const omittedTaskIds = goal.tasks.filter((task) => !selected.has(task.taskId)).map((task) => task.taskId);
	frozen.checkpointScope = { selectedTaskIds, omittedTaskIds };
	const files: Array<{ sourceRelativePath: string; relativePath: string; bytes: number }> = [];
	const copies = new Map<string, string>();
	const copy = async (source: string, relativePath: string, kind: "review" | "problem" | "raw"): Promise<string> => {
		const sourcePath = path.resolve(source);
		const found = copies.get(sourcePath);
		if (found) return found;
		const info = await lstat(sourcePath);
		if (!info.isFile() || info.isSymbolicLink()) throw new HarnessError("m07.checkpoint", "checkpoint 来源必须是无符号链接的固定文件");
		const expectedRoot = kind === "raw" ? ctx.ws.rawDir : runDir;
		const realSource = await realpath(sourcePath);
		const realRoot = await realpath(expectedRoot);
		if (!inside(realRoot, realSource)) throw new HarnessError("m07.checkpoint", "checkpoint 来源越过允许目录");
		if (kind === "review" && !/^tasks[/\\]T\d{3,}[/\\]review-snapshot[/\\][^/\\]+$/.test(path.relative(realRoot, realSource))) throw new HarnessError("m07.checkpoint", "仅允许复制已评审冻结材料");
		if (kind === "problem" && realSource !== await realpath(goal.problemSnapshotPath)) throw new HarnessError("m07.checkpoint", "原问题来源与 begin 冻结副本不符");
		const target = path.join(rootDir, relativePath);
		if (!inside(rootDir, target)) throw new HarnessError("m07.checkpoint", "checkpoint 目标路径非法");
		// Stream the complete, already reviewed evidence. Its observed byte count
		// detects a changing source; it is not a search or handoff budget. Prompt
		// projection and paged reads bound model context independently below.
		const copied = await copySnapshotBounded(sourcePath, target, info.size);
		if (copied !== info.size || (await stat(sourcePath)).size !== info.size) throw new HarnessError("m07.checkpoint", "checkpoint 来源在复制期间改变；未登记不完整快照");
		copies.set(sourcePath, target);
		files.push({ sourceRelativePath: path.relative(await realpath(ctx.ws.root), realSource), relativePath, bytes: copied });
		return target;
	};
	const problemFile = "problem.md";
	await copy(goal.problemSnapshotPath, problemFile, "problem");
	const rawFiles: Array<{ name: string; relativePath: string }> = [];
	const skippedRaw: string[] = [];
	if (goal.checkpointRawScope !== "none" && existsSync(ctx.ws.rawDir)) {
		const rawNames = (await readdir(ctx.ws.rawDir)).sort();
		for (const name of rawNames) {
			const source = path.join(ctx.ws.rawDir, name);
			const info = await lstat(source);
			if (!info.isFile()) continue;
			if (!isTextFile(name)) { skippedRaw.push(name); continue; }
			const relativePath = path.join("raw", name);
			await copy(source, relativePath, "raw");
			rawFiles.push({ name, relativePath });
		}
	}
	const remap = async (source: string): Promise<string> => {
		const relative = path.relative(await realpath(runDir), await realpath(source));
		return copy(source, path.join("evidence", relative), "review");
	};
	for (const task of frozen.tasks) {
		// The checkpoint exposes no live work/input directory as readable evidence.
		task.workDir = "";
		task.inputCopies = [];
		task.expectedOutputPaths = [];
		task.toolLog = [];
		delete task.session;
		// Keep controller failure facts for selected and omitted tasks, without exposing
		// live private wording or treating unreviewed work as frozen evidence.
		task.executionFailure = publicFailure(task.executionFailure);
		delete task.branchUnavailableReason;
		delete task.branchSource;
		delete task.executionRounds;
		if (!selected.has(task.taskId)) {
			task.objective = ""; task.inputs = []; task.expectedOutputs = []; task.checks = []; task.readCoverage = [];
			delete task.reportPath; delete task.review; delete task.experienceSelection;
			delete task.knowledgeAccess;
			delete task.candidateObservation;
			delete task.episode;
			delete task.planCopy; delete task.planInput; delete task.resourceInputs;
			delete task.knowledgeIds; delete task.experienceRefs; delete task.experienceContextRefs; delete task.experienceTags;
			delete task.lessonDeltaOutput; delete task.executionLoop;
			continue;
		}
		if (!task.review) { delete task.reportPath; delete task.episode; delete task.knowledgeAccess; continue; }
		task.review.frozenReportPath = await remap(task.review.frozenReportPath);
		task.reportPath = task.review.frozenReportPath;
		for (const artifact of task.review.artifacts) { artifact.path = await remap(artifact.path); delete artifact.sourcePath; }
		for (const check of task.review.checks) check.evidence = await Promise.all(check.evidence.map(remap));
		if (task.knowledgeAccess) for (const access of task.knowledgeAccess)
			access.frozenPath = await remap(access.frozenPath);
		if (task.candidateObservation) {
			task.candidateObservation.observationPath = await remap(task.candidateObservation.observationPath);
			task.candidateObservation.sourceFiles = await Promise.all(task.candidateObservation.sourceFiles.map(remap));
			task.candidateObservation.receiptFiles = await Promise.all(task.candidateObservation.receiptFiles.map(remap));
		}
		if (task.episode) for (const candidate of task.episode.candidates) {
			candidate.observationPath = await remap(candidate.observationPath);
			candidate.observation.sourceFiles = await Promise.all(candidate.observation.sourceFiles.map(remap));
			candidate.observation.receiptFiles = await Promise.all(candidate.observation.receiptFiles.map(remap));
		}
		if (task.review.independentCheck) task.review.independentCheck.report = await remap(task.review.independentCheck.report);
	}
	for (const selection of frozen.branchSelections ?? []) {
		selection.rationale = "scoped checkpoint omits branch comparison rationale; inspect the complete goal only through an authorized full handoff";
		for (const candidate of selection.candidates) if (!selected.has(candidate.taskId)) candidate.checks = [];
	}
	frozen.problemSnapshotPath = path.join(rootDir, problemFile);
	const goalSnapshotPath = path.join(rootDir, STATE);
	const manifestPath = path.join(rootDir, "manifest.json");
	const sourceGoalUpdatedAt = goal.updatedAt;
	await writeFileAtomic(goalSnapshotPath, `${JSON.stringify(frozen, null, 2)}\n`);
	let feedbackPath: string;
	let feedbackStatus: M07CheckpointRecord["feedbackStatus"];
	try {
		feedbackPath = await writeFeedback(ctx, frozen, frozenPolicy(frozen), limits, rootDir);
		feedbackStatus = "complete";
	} catch (error) {
		if (!isFeedbackControlOverflow(error)) throw error;
		frozen.feedbackError = { code: "context.budget", summary: (error as Error).message.slice(0, 500) };
		feedbackPath = await writeBoundedFeedbackIndex(ctx, frozen, "checkpoint", rootDir);
		feedbackStatus = "indexed";
	}
	frozen.feedbackPath = feedbackPath;
	frozen.feedbackStatus = feedbackStatus;
	await writeFileAtomic(goalSnapshotPath, `${JSON.stringify(frozen, null, 2)}\n`);
	await writeFileAtomic(manifestPath, `${JSON.stringify({ version: 1, m07RunId: goal.runId, checkpointId: id, createdAt: nowIso(), problemFile, rawFiles, skippedRaw, selectedTaskIds, omittedTaskIds, files }, null, 2)}\n`);
	const record: M07CheckpointRecord = { id, createdAt: nowIso(), rootDir, goalSnapshotPath, feedbackPath, manifestPath, feedbackStatus, sourceGoalUpdatedAt };
	goal.checkpoints = [...(goal.checkpoints ?? []), record];
	await save(ctx, goal);
	return record;
}

export function createM07Controller(ctx: StageContext, options: { projectionSnapshotLimits?: ProjectionSnapshotLimits; registeredExperienceStores?: ReadonlyMap<string, KnowledgeStore>; processIdentity?: () => Promise<ProcessIdentityV1>; probeProcess?: typeof probeProcessIdentity; candidateVerifier?: CandidateVerifier; candidateExecutionBackend?: CandidateExecutionBackend; taskAdmission?: TaskAdmission } = {}): M07Controller {
	const snapshotLimits = options.projectionSnapshotLimits ?? DEFAULT_PROJECTION_SNAPSHOT_LIMITS;
	if (!Number.isSafeInteger(snapshotLimits.perMaterialBytes) || !Number.isSafeInteger(snapshotLimits.perCallBytes) || !Number.isSafeInteger(snapshotLimits.perRunBytes) || snapshotLimits.perMaterialBytes <= 0 || snapshotLimits.perCallBytes < snapshotLimits.perMaterialBytes || snapshotLimits.perRunBytes < snapshotLimits.perCallBytes) throw new HarnessError("m07.projection-budget", "invalid projection snapshot limits");
	const withDispatch = <T>(runId: string, body: () => Promise<T>): Promise<T> =>
		withGoalDispatch(ctx, runId, body, options.processIdentity ?? readCurrentProcessIdentity);
	return {
		async begin(input, beginOptions) {
			if (beginOptions?.checkpointRawScope !== undefined && !["workspace", "none"].includes(beginOptions.checkpointRawScope)) throw new HarnessError("m07.input", "invalid host checkpoint raw-input scope");
			if (beginOptions?.candidateVerification) {
				const verifier = requireCandidateVerifier(options.candidateVerifier, beginOptions.candidateVerification);
				if (beginOptions.candidateVerification.goalAdmission && !verifier.verifyGoal)
					throw new HarnessError("m07.goal-verifier", "host goal admission was requested without an independent verifier");
			}
			nonempty(input.goal, "goal"); nonempty(input.problemRelation, "problemRelation"); nonempty(input.plan, "plan");
			if (!input.constraints.length || !input.successCriteria.length) throw new HarnessError("m07.input", "constraints 与 successCriteria 必须明确且非空");
			input.constraints = normalizedUnique(input.constraints, "constraint"); input.successCriteria = normalizedUnique(input.successCriteria, "success criterion");
			const problem = await ctx.ws.readProblem();
			const resolved = await resolveM04Baseline(ctx);
			const baseline = resolved.baseline;
			if (!baseline && !input.exploratory) throw new HarnessError("m07.baseline", "没有可用的 M04 正式基线；只能显式 exploratory=true 开始探索性 M07，不能声称正式结论");
			const budget = await activePolicySnapshot(ctx);
			let workflowMethod: CurrentGoal["workflowMethod"];
			if (input.workflowMethodVersionId !== undefined) {
				const generations = new GenerationStore(ctx.ws.root);
				const active = await generations.active();
				if (!active || active.bundle.executorVersionId !== input.workflowMethodVersionId) throw new HarnessError("m07.workflow-method", "explicit workflow method is not the active H version");
				const method = await generations.readStrategy(input.workflowMethodVersionId);
				if (method.kind !== "executor" || !isM07WorkflowStrategy(method.artifact) || !["admitted", "manual-active"].includes(method.state)) throw new HarnessError("m07.workflow-method", "active H is not an admitted or manually bound M07 workflow method");
				if (active.bundle.knowledgeSnapshot !== resolved?.knowledgeSnapshot) throw new HarnessError("m07.workflow-method", "workflow method and M04 baseline have different knowledge epochs");
				workflowMethod = { versionId: method.versionId, artifact: method.artifact, requiredExperienceRefs: method.requiredExperienceRefs, requiredKnowledgeRefs: method.requiredKnowledgeRefs };
				const frozenRefs = new Map<string, KnowledgeRef>();
				for (const item of workflowMethod.requiredExperienceRefs) frozenRefs.set(`${item.ref.storeId}/${item.ref.recordId}@${item.ref.version}`, item.ref);
				for (const ref of workflowMethod.requiredKnowledgeRefs) frozenRefs.set(`${ref.storeId}/${ref.recordId}@${ref.version}`, ref);
				await verifyRequiredKnowledge(ctx.ws.root, [...frozenRefs.values()], resolved?.knowledgeSnapshot, options.registeredExperienceStores);
			}
			const knowledgeSnapshot = resolved?.knowledgeSnapshot;
			const failedM04 = resolved?.failedM04 ?? [];
			const loadedSource = await verifyLoadedSource(import.meta.url);
			const record = await ctx.ws.startRun("M07", [{ label: "原始问题", path: problem.path }], knowledgeSnapshot);
			const frozen = path.join(ctx.ws.runDir("M07", record.runId), "problem-snapshot.md");
			await writeFileAtomic(frozen, problem.content);
			const exploratory = input.exploratory === true || !baseline;
			const attemptId = "A001";
			const descriptor: RunDescriptorV1 = { version: 1, instanceId: process.env.PRE_RSI_RUN_INSTANCE_ID ?? randomUUID(), attemptId, workspaceId: await ctx.store.storeId(), goalRunId: record.runId, codeRevision: loadedSource?.sourceCommit ?? process.env.PRE_RSI_CODE_REVISION ?? "unrecorded", ...(loadedSource ? { loadedSource } : {}), controlDir: ctx.ws.runDir("M07", record.runId), process: await (options.processIdentity ?? readCurrentProcessIdentity)() };
			const goal: CurrentGoal = { version: 1, runId: record.runId, lifecycle: "active", startedAt: record.startedAt, updatedAt: record.startedAt, goal: input.goal.trim(), problemRelation: input.problemRelation.trim(), constraints: input.constraints.map((x) => nonempty(x, "constraint")), successCriteria: input.successCriteria.map((x) => nonempty(x, "success criterion")), plan: input.plan.trim(), exploratory, formalBaseline: !!baseline && !exploratory, problemSnapshotPath: frozen, knowledgeSnapshot, m04BaselineRunId: baseline?.run.runId, checkpointRawScope: beginOptions?.checkpointRawScope ?? "workspace", ...(beginOptions?.candidateVerification ? { candidateVerification: { version: 1 as const, id: beginOptions.candidateVerification.id, verifierVersion: beginOptions.candidateVerification.verifierVersion, goalAdmission: beginOptions.candidateVerification.goalAdmission === true, boundAt: record.startedAt, firstTaskIndex: 0 } } : {}), ...(failedM04.length ? { m04BaselineFailures: failedM04 } : {}), baselineHistory: baseline ? [{ at: record.startedAt, knowledgeSnapshot, m04RunId: baseline.run.runId, ...(failedM04.length ? { failedM04 } : {}) }] : [], budgetPolicy: budget.policy, searchBudget: ctx.config.searchBudget ?? DEFAULT_SEARCH_BUDGET, budgetPolicyVersionId: budget.versionId, budgetPolicyFrozenAt: record.startedAt, methodBinding: { versionId: workflowMethod?.versionId ?? budget.versionId }, ...(workflowMethod ? { workflowMethod } : {}), ...(beginOptions?.executionContract === "continuous" ? { executionContract: { version: 1 as const, mode: "continuous" as const, frozenAt: record.startedAt } } : {}), executionState: { version: 1, activeAttemptId: attemptId, attempts: [{ version: 1, id: attemptId, state: "running", startedAt: record.startedAt, runDescriptor: descriptor }], operations: [] }, tasks: [], decisions: [], limitations: [] };
			await save(ctx, goal);
			return goal;
		},

		status: (runId) => load(ctx, runId),

		async hostBindCandidateVerifier(runId, bindOptions) {
			return withDispatch(runId, async () => {
				const goal = await load(ctx, runId); requireActive(goal);
				const verifier = requireCandidateVerifier(options.candidateVerifier);
				if (bindOptions?.goalAdmission && !verifier.verifyGoal)
					throw new HarnessError("m07.goal-verifier", "host goal admission was requested without an independent verifier");
				if (goal.candidateVerification) {
					requireCandidateVerifier(verifier, goal.candidateVerification);
					if (bindOptions?.goalAdmission !== undefined && bindOptions.goalAdmission !== goal.candidateVerification.goalAdmission)
						throw new HarnessError("m07.goal-verifier", "existing goal admission binding cannot be changed in place");
					return goal;
				}
				if (goal.tasks.some(task => task.status === "running" || task.status === "unknown") ||
					goal.executionState?.operations.some(operation => ["prepared", "issued", "unknown"].includes(operation.status)))
					throw new HarnessError("m07.candidate-verifier", "running tasks or unresolved operations must settle before host binding");
				goal.candidateVerification = { version: 1, id: verifier.id, verifierVersion: verifier.version,
					boundAt: nowIso(), firstTaskIndex: goal.tasks.length, goalAdmission: bindOptions?.goalAdmission === true };
				await save(ctx, goal); return goal;
			});
		},

		async hostAddConstraints(runId, input) {
			return withDispatch(runId, async () => {
				const goal = await load(ctx, runId);
				if (goal.lifecycle !== "active") throw new HarnessError("m07.constraints", "只能向 active 目标补充用户约束");
				if (goal.tasks.some((task) => task.status === "running") ||
					goal.executionState?.operations.some((operation) => operation.status === "issued" || operation.status === "unknown"))
					throw new HarnessError("m07.constraints", "存在 running 任务或未决外部操作；先完成或对账后再补充约束");
				const sourceEventId = nonempty(input.sourceEventId, "sourceEventId");
				if (sourceEventId.length > 128 || !/^[A-Za-z0-9._:-]+$/.test(sourceEventId))
					throw new HarnessError("m07.input", "sourceEventId 必须是至多 128 字符的稳定事件标识");
				if (!Array.isArray(input.constraints) || !input.constraints.length)
					throw new HarnessError("m07.input", "补充约束不能为空");
				const constraints = [...new Set(input.constraints.map((value) => nonempty(value, "constraint")))];
				const previous = goal.constraintAdditions?.find((event) => event.sourceEventId === sourceEventId);
				if (previous) {
					if (!sameStrings([...previous.constraints].sort(), [...constraints].sort()))
						throw new HarnessError("m07.constraints", "sourceEventId 已用于不同的约束内容");
					return goal;
				}
				const known = new Set(goal.constraints);
				for (const constraint of constraints) if (!known.has(constraint)) { goal.constraints.push(constraint); known.add(constraint); }
				goal.constraintAdditions = [...(goal.constraintAdditions ?? []), { sourceEventId, constraints, recordedAt: nowIso() }];
				await save(ctx, goal);
				return goal;
			});
		},

		async plan(runId, plan, planOptions) {
			return withDispatch(runId, async () => {
			const goal = await load(ctx, runId); requireActive(goal);
			if (Boolean(planOptions?.checkpointId) !== Boolean(planOptions?.m04RunId)) throw new HarnessError("m07.checkpoint", "refreshBaseline 的 checkpointId 与 m04RunId 必须成对指定");
			if ((planOptions?.checkpointId || planOptions?.m04RunId) && !planOptions?.refreshBaseline) throw new HarnessError("m07.checkpoint", "checkpoint 消费绑定仅适用于 refreshBaseline");
			const nextPlan = nonempty(plan, "plan");
			if (planOptions?.refreshBaseline) {
				const resolved = await resolveM04Baseline(ctx); const baseline = resolved.baseline; if (!baseline) throw new HarnessError("m07.baseline", "没有可用于刷新基线的 M04 运行");
				if (goal.checkpoints?.length && (!planOptions.checkpointId || !planOptions.m04RunId)) throw new HarnessError("m07.checkpoint", "checkpoint 后刷新基线必须显式绑定 checkpointId 与 M04 runId");
				if (planOptions.checkpointId && planOptions.m04RunId) {
					const checkpoint = goal.checkpoints?.find((item) => item.id === planOptions.checkpointId);
					if (!checkpoint || baseline.run.runId !== planOptions.m04RunId) throw new HarnessError("m07.checkpoint", "checkpoint 或最新 M04 运行不匹配");
					const sourceOutput = baseline.run.outputs.find((item) => item.label === "M07 处理来源");
					if (!sourceOutput || path.resolve(sourceOutput.path) !== path.join(ctx.ws.runDir("M04", baseline.run.runId), "m07-source.json")) throw new HarnessError("m07.checkpoint", "M04 缺少控制器登记的 checkpoint 来源");
					const source = JSON.parse(await readFile(sourceOutput.path, "utf8")) as { m07RunId?: string; checkpointId?: string; rootDir?: string; goalSnapshotPath?: string; manifestPath?: string };
					if (source.m07RunId !== runId || source.checkpointId !== checkpoint.id || source.rootDir !== checkpoint.rootDir || source.goalSnapshotPath !== checkpoint.goalSnapshotPath || source.manifestPath !== checkpoint.manifestPath) throw new HarnessError("m07.checkpoint", "M04 来源并非本目标对应的冻结 checkpoint");
				}
				if (goal.workflowMethod && baseline.knowledgeSnapshot !== goal.knowledgeSnapshot) throw new HarnessError("m07.workflow-method", "已冻结工作流方法的目标不能热更新知识版本；请新建目标并显式绑定新方法版本");
				await verifyFrozenWorkflowMethod(ctx, goal, options.registeredExperienceStores);
				goal.m04BaselineRunId = baseline.run.runId; goal.knowledgeSnapshot = baseline.knowledgeSnapshot; goal.m04BaselineFailures = resolved.failedM04; goal.formalBaseline = true; goal.exploratory = false; goal.baselineHistory.push({ at: nowIso(), knowledgeSnapshot: baseline.knowledgeSnapshot, m04RunId: baseline.run.runId, ...(resolved.failedM04.length ? { failedM04: resolved.failedM04 } : {}) });
			}
			goal.plan = nextPlan;
			await save(ctx, goal); return goal;
			});
		},

		async checkpoint(runId, checkpointOptions) {
			return withDispatch(runId, async () => {
			const goal = await load(ctx, runId); requireActive(goal);
			frozenPolicy(goal);
			if (goal.tasks.some((task) => task.status === "running")) throw new HarnessError("m07.checkpoint", "存在 running 任务，不能冻结非终态反馈");
			const requested = checkpointOptions?.taskIds;
			if (requested !== undefined && (!Array.isArray(requested) || requested.length === 0 || requested.some((id) => typeof id !== "string" || !/^T\d{3,}$/.test(id)) || new Set(requested).size !== requested.length || requested.some((id) => !goal.tasks.some((task) => task.taskId === id)))) throw new HarnessError("m07.checkpoint", "taskIds 必须是非空、去重、属于当前目标的任务列表");
			const selectedTaskIds = requested ?? goal.tasks.map((task) => task.taskId);
			await verifyFrozenWorkflowMethod(ctx, goal, options.registeredExperienceStores);
			return freezeCheckpoint(ctx, goal, snapshotLimits, selectedTaskIds);
			});
		},

			async delegate(runId, spec, afterPrepared) {
			return withDispatch(runId, async () => {
				const goal = await load(ctx, runId); requireActive(goal); nonempty(spec.objective, "task objective");
				await requireLoadedAttemptSource(goal);
				if (spec.mode === "execute") for (const existingOperation of goal.executionState?.operations ?? []) {
					const pending = await pendingCandidateExecutions({ journalDir: path.join(ctx.ws.runDir("M07", runId), "tasks", existingOperation.taskId, "candidate-runs"),
						goalRunId: runId, taskId: existingOperation.taskId, operationId: existingOperation.id, backend: options.candidateExecutionBackend });
					if (pending.length) throw new HarnessError("m07.candidate-execution-unresolved", `先前候选评测仍未终态；submitted/confirmed 不等于评测终态，不能新派发执行：${JSON.stringify(pending)}`);
				}
				if (spec.context && spec.context.mode !== "fork") throw new HarnessError("m07.branch", "unsupported task context mode");
				if (spec.mode === "execute" && (goal.executionState?.operations.some((operation) => operation.status === "unknown") || goal.tasks.some((task) => task.mode === "execute" && task.status === "unknown"))) throw new HarnessError("m07.operation-unknown", "仍有外部副作用状态未知；先经宿主控制面对账。只读 check/reason 任务仍可用于核查");
				await verifyFrozenWorkflowMethod(ctx, goal, options.registeredExperienceStores, spec);
			const policy = frozenPolicy(goal);
			await requireCurrentFormalBaseline(ctx, goal);
			if (spec.executionLoop !== undefined) {
				const loop = spec.executionLoop as unknown;
				if (!loop || typeof loop !== "object" || Array.isArray(loop)) throw new HarnessError("m07.loop", "invalid execution-loop policy");
				const fields = loop as Record<string, unknown>;
				const named = ["until-ready", "candidate-episode"].includes(String(fields.mode));
				const extra = Object.keys(fields).filter(key => !["mode", "maxRounds", "deadlineAt"].includes(key));
				if (extra.length || (named ? false : !("maxRounds" in fields) || !("deadlineAt" in fields)) ||
					(fields.maxRounds !== undefined && (!Number.isSafeInteger(fields.maxRounds) || Number(fields.maxRounds) < 1)) ||
					(fields.deadlineAt !== undefined && (typeof fields.deadlineAt !== "string" || !Number.isFinite(Date.parse(fields.deadlineAt)))))
					throw new HarnessError("m07.loop", "invalid execution-loop policy");
			}
			spec = { ...spec, objective: spec.objective.trim(), inputs: normalizedUnique(spec.inputs, "task input"), expectedOutputs: normalizedUnique(spec.expectedOutputs, "expected output"), checks: normalizedUnique(spec.checks, "task check"),
				executionLoop: spec.executionLoop ? { mode: "mode" in spec.executionLoop ? spec.executionLoop.mode : "until-ready",
					...(spec.executionLoop.maxRounds === undefined ? {} : { maxRounds: spec.executionLoop.maxRounds }),
					...(spec.executionLoop.deadlineAt === undefined ? {} : { deadlineAt: spec.executionLoop.deadlineAt }) } : undefined };
			if (spec.subjectId !== undefined) spec.subjectId = nonempty(spec.subjectId, "task subjectId");
			spec.subjectProfile = validateSubjectProfile(spec.subjectProfile, goal.searchBudget ?? DEFAULT_SEARCH_BUDGET);
			// Under a bound verifier an execute task produces candidates, and the basis
			// requires the abstraction-layer decision and the headroom record before
			// spending a search budget on it.
			if (spec.mode === "execute" && goal.candidateVerification && !spec.subjectProfile)
				throw new HarnessError("m07.subject-profile", "an execute task under a bound candidate verifier must declare subjectProfile: the implementation space with its rationale and the baseline strength it competes against");
			let branchParent: M07TaskRecord | undefined;
			let branchManifest: BranchManifestV1 | undefined;
			if (spec.context) {
				const reference = spec.context;
				if (goal.tasks.some((item) => item.status === "running") || goal.executionState?.operations.some((item) => ["prepared", "issued", "unknown"].includes(item.status))) throw new HarnessError("m07.branch", "cannot fork while another task or external operation is active or unresolved");
				if (reference.parentRunId !== runId || !reference.parentTaskId || !reference.checkpointId) throw new HarnessError("m07.branch", "fork requires this goal's run, parent task, and exact checkpoint ID");
				branchParent = goal.tasks.find((item) => item.taskId === reference.parentTaskId);
				if (!branchParent || branchParent.mode !== "execute" || branchParent.context || !["returned", "accepted", "rejected"].includes(branchParent.status) || !branchParent.branchSource || branchParent.branchSource.checkpoint.id !== reference.checkpointId) throw new HarnessError("m07.branch", "parent is not a settled, frozen execute task at the requested checkpoint");
				if (branchParent.branchSource.checkpoint.runId !== runId || branchParent.branchSource.checkpoint.taskId !== branchParent.taskId || branchParent.branchSource.checkpoint.inputManifest !== branchParent.branchSource.manifestPath) throw new HarnessError("m07.branch", "checkpoint receipt does not bind this run, task, and evidence manifest");
				if (goal.branchSelections?.some((item) => item.parentTaskId === reference.parentTaskId)) throw new HarnessError("m07.branch", "branch selection is frozen; no later candidate may join this comparison");
					const siblings = goal.tasks.filter((item) => item.context?.parentTaskId === reference.parentTaskId).length;
					const branchLimit = (goal.searchBudget ?? DEFAULT_SEARCH_BUDGET).maxBranchesPerCheckpoint;
					if (siblings >= branchLimit) throw new HarnessError("m07.branch", `the frozen search budget allows ${branchLimit} competing branches from one checkpoint; select among the existing ones instead of widening further`);
				if (spec.mode !== "execute" || spec.objective !== branchParent.objective || spec.subjectId !== branchParent.subjectId || !sameStrings(spec.checks, branchParent.checks) || !sameStrings(spec.expectedOutputs, branchParent.expectedOutputs) || Boolean(spec.requireIndependentCheck) !== Boolean(branchParent.requireIndependentCheck) || !sameStrings(spec.inputs, branchParent.inputs) || (spec.parentTaskId && spec.parentTaskId !== branchParent.taskId) || (spec.supersedesTaskId && spec.supersedesTaskId !== branchParent.taskId)) throw new HarnessError("m07.branch", "fork candidates must retain the parent's subject, objective, inputs, outputs, checks, execute mode, and independent-check obligation");
					if (Boolean(spec.candidate) !== Boolean(branchParent.candidate) ||
						(spec.candidate && branchParent.candidate &&
							(!sameStrings(spec.candidate.sourcePaths, branchParent.candidate.sourcePaths) ||
							 !sameStrings(spec.candidate.receiptPaths, branchParent.candidate.receiptPaths))))
						throw new HarnessError("m07.branch", "fork must preserve the candidate source and receipt obligations");
				branchManifest = await loadBranchManifest(branchParent.branchSource, runId, branchParent.taskId);
				if (branchParent.inputCopies.length !== branchParent.inputs.length) throw new HarnessError("m07.branch", "frozen parent input identity is incomplete");
				const rootReal = await realpath(ctx.ws.root);
				const frozenInputSource = (requested: string): string => {
					const index = branchParent!.inputs.indexOf(requested);
					const copy = index >= 0 ? branchParent!.inputCopies[index] :
						branchParent!.inputCopies.find((item) => item.source === requested);
					if (!copy || !path.isAbsolute(copy.source) || !inside(rootReal, copy.source))
						throw new HarnessError("m07.branch", "fork input is not one of the parent's frozen declared inputs");
					const relative = path.relative(branchParent!.workDir, copy.copy);
					if (relative.startsWith("..") || path.isAbsolute(relative) ||
						!branchManifest!.files.some((file) => file.relativePath === relative && file.historicalPath === copy.copy))
						throw new HarnessError("m07.branch", "fork input lacks the parent's frozen work-copy identity");
					return copy.source;
				};
				if (spec.planInput !== undefined) spec.planInput = frozenInputSource(spec.planInput);
				if (spec.resourceInputs !== undefined) spec.resourceInputs = spec.resourceInputs.map((item) =>
					({ ...item, input: frozenInputSource(item.input) }));
				if (JSON.stringify(spec.knowledgeIds ?? []) !== JSON.stringify(branchParent.knowledgeIds ?? []) || JSON.stringify(spec.knowledgeContext ?? {}) !== JSON.stringify(branchParent.knowledgeContext ?? {}) || JSON.stringify(spec.experienceRefs ?? []) !== JSON.stringify(branchParent.experienceRefs ?? []) || JSON.stringify(spec.experienceContextRefs ?? []) !== JSON.stringify(branchParent.experienceContextRefs ?? []) || JSON.stringify(spec.experienceTags ?? []) !== JSON.stringify(branchParent.experienceTags ?? []) || JSON.stringify(spec.resourceInputs ?? []) !== JSON.stringify(branchParent.resourceInputs ?? []) || spec.planInput !== branchParent.planInput || spec.lessonDeltaOutput !== branchParent.lessonDeltaOutput || JSON.stringify(spec.executionLoop ?? null) !== JSON.stringify(branchParent.executionLoop ?? null)) throw new HarnessError("m07.branch", "fork cannot silently change frozen knowledge applicability, plan, resources, lesson output, or review-loop obligations");
				if (branchParent.knowledgeSnapshot !== goal.knowledgeSnapshot || branchParent.m04BaselineRunId !== goal.m04BaselineRunId) throw new HarnessError("m07.branch", "goal baseline changed since the source task; establish a new task rather than fork old authority");
				if (branchManifest.knowledgeSnapshot !== goal.knowledgeSnapshot || branchManifest.m04BaselineRunId !== goal.m04BaselineRunId || branchManifest.problemSourcePath !== goal.problemSnapshotPath) throw new HarnessError("m07.branch", "frozen source manifest no longer matches the goal's inputs and formal baseline");
				spec = { ...spec, parentTaskId: branchParent.taskId, supersedesTaskId: branchParent.taskId };
			}
			if (spec.executionLoop) {
				if (spec.mode !== "execute" || !("mode" in spec.executionLoop) || !["until-ready", "candidate-episode"].includes(spec.executionLoop.mode))
					throw new HarnessError("m07.loop", "new executionLoop requires execute mode and a supported policy");
				if (spec.executionLoop.mode === "until-ready" && goal.candidateVerification)
					throw new HarnessError("m07.loop", "a host candidate verifier is bound to this goal: execute tasks use candidate-episode so acceptance stays with the deterministic verifier instead of a reviewer session");
				if (spec.executionLoop.mode === "candidate-episode" && spec.context)
					throw new HarnessError("m07.episode", "candidate episode requires a fresh task, not a historical session fork");
				if (spec.executionLoop.mode === "candidate-episode" && (!goal.candidateVerification || goal.tasks.length < goal.candidateVerification.firstTaskIndex))
					throw new HarnessError("m07.episode", "candidate episode requires a host-bound verifier");
			}
			if (spec.lessonDeltaOutput && (spec.mode !== "execute" || !spec.expectedOutputs.includes(spec.lessonDeltaOutput))) throw new HarnessError("m07.lesson-delta", "lessonDeltaOutput must be an exact expected output of an execute task");
				if (spec.candidate) {
					if (spec.mode !== "execute" || !goal.candidateVerification || goal.tasks.length < goal.candidateVerification.firstTaskIndex)
						throw new HarnessError("m07.candidate", "candidate tasks require a host-bound verifier and execute mode");
					requireCandidateVerifier(options.candidateVerifier, goal.candidateVerification);
					if (!Array.isArray(spec.candidate.sourcePaths) || !Array.isArray(spec.candidate.receiptPaths) ||
						!spec.candidate.sourcePaths.length || !spec.candidate.receiptPaths.length)
						throw new HarnessError("m07.candidate", "candidate requires source and original receipt files");
					const declared = [...spec.candidate.sourcePaths, ...spec.candidate.receiptPaths];
					if (
						new Set(declared).size !== declared.length ||
						declared.some(item => typeof item !== "string" || !isSafeRelativeOutputPath(item) || !spec.expectedOutputs.includes(item)) ||
						(spec.candidate.intent !== undefined && !["solution", "diagnostic"].includes(spec.candidate.intent)) ||
						(spec.candidate.changeKind !== undefined && !["repair", "structure", "parameters"].includes(spec.candidate.changeKind)))
						throw new HarnessError("m07.candidate", "candidate source and receipt paths must be distinct exact expected outputs");
					if (spec.candidate.parentTaskId && !goal.tasks.some(task => task.taskId === spec.candidate!.parentTaskId && task.candidate))
						throw new HarnessError("m07.candidate", "candidate.parentTaskId requires an existing task with a legacy task-level candidate declaration; an episode parent must be selected precisely in candidate_evaluate.parentCandidateId, for example T001/C001");
				}
			for (const expectedOutput of spec.expectedOutputs) {
				if (isSafeRelativeOutputPath(expectedOutput) === false) throw new HarnessError("m07.path", `expectedOutputs 必须是 work 目录内精确相对路径，不得含占位符、通配符、绝对路径、..、多余首尾空白或换行；动态文件名请声明其父目录，并在 objective 或任务报告中说明：${expectedOutput}`);
			}
			if (!spec.checks.length) throw new HarnessError("m07.task", "每个任务必须定义至少一项实际检查；推导可用会话报告作为证据");
			if (spec.mode !== "execute" && spec.expectedOutputs.length > 0) {
				throw new HarnessError("m07.task", `${spec.mode} 模式只读且不写盘，不能声明 expectedOutputs；使用 expectedOutputs: []，会话结果由控制器自动保存为 reportPath；需要额外文件时请使用 execute 模式`);
			}
			if (spec.mode === "execute") {
				if (spec.expectedOutputs.length === 0) {
					if (spec.supersedesTaskId === undefined) throw new HarnessError("m07.task", "execute 任务必须声明至少一个预期产物");
				}
			}
			if (spec.parentTaskId && !goal.tasks.some((t) => t.taskId === spec.parentTaskId)) throw new HarnessError("m07.task", `未知 parentTaskId ${spec.parentTaskId}`);
			const resolvedInputs: string[] = []; for (let index = 0; index < spec.inputs.length; index++)
				resolvedInputs.push(branchParent ? branchParent.inputCopies[index].source : await confinedExistingFile(ctx, spec.inputs[index]));
			if (spec.planInput) {
				if (spec.mode !== "execute") throw new HarnessError("m07.plan-input", "planInput is only valid for an execute task");
				const planSource = branchParent ? spec.planInput : await confinedExistingFile(ctx, spec.planInput);
				if (!resolvedInputs.includes(planSource) || mediaType(planSource) !== "text") throw new HarnessError("m07.plan-input", "planInput must identify a declared text input");
				spec.planInput = planSource;
			}
			if (spec.resourceInputs !== undefined) {
				if (!Array.isArray(spec.resourceInputs)) throw new HarnessError("m07.resources", "resourceInputs must be explicit versioned references");
				const seen = new Set<string>();
				spec.resourceInputs = await Promise.all(spec.resourceInputs.map(async (item) => {
					if (!item || !/^[A-Za-z][A-Za-z0-9._-]{0,63}$/.test(item.id) || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(item.version) || seen.has(item.id)) throw new HarnessError("m07.resources", "resourceInputs must have unique safe IDs and explicit versions");
					seen.add(item.id);
					const source = branchParent ? item.input : await confinedExistingFile(ctx, item.input);
					if (!resolvedInputs.includes(source) || mediaType(source) !== "text") throw new HarnessError("m07.resources", "each resource input must be a declared text input");
					return { id: item.id, version: item.version, input: source };
				}));
			}
			if (spec.supersedesTaskId) { const previous = goal.tasks.find((t) => t.taskId === spec.supersedesTaskId); if (!previous) throw new HarnessError("m07.task", `未知 supersedesTaskId ${spec.supersedesTaskId}`); const previousInputs = previous.inputCopies.map((item) => item.source).sort(); const nextInputs = [...resolvedInputs].sort(); if (!sameSupersededObligation(spec, previous) || !sameStrings(nextInputs, previousInputs)) throw new HarnessError("m07.task", "supersedes 只能替代 objective、兼容 mode（可升级到更强能力）、独立检查要求、inputs、checks 与 expectedOutputs 相同或不降低义务的旧任务"); }
			const dependencies = [spec.parentTaskId, spec.supersedesTaskId].filter(Boolean) as string[];
			if (goal.decisions.some((d) => d.status === "open" && d.relatedTaskIds.some((id) => dependencies.includes(id)))) throw new HarnessError("m07.decision", "该任务依赖待用户决定事项；可继续不受影响的任务，但不能推进此依赖分支");
			await options.taskAdmission?.({ goal: structuredClone(goal), task: structuredClone(spec), workspace: ctx.ws.root });
			const id = taskId(goal), dir = path.join(ctx.ws.runDir("M07", runId), "tasks", id), workDir = path.join(dir, "work"), inputsDir = path.join(workDir, "inputs");
			const existingDir = await lstat(dir).catch((error: NodeJS.ErrnoException) => {
				if (error.code === "ENOENT") return undefined;
				throw error;
			});
			if (existingDir) {
				if (!existingDir.isDirectory() || existingDir.isSymbolicLink()) throw new HarnessError("m07.task", `未派发任务目录 ${id} 不是普通目录，需人工核对`);
				const archiveRoot = path.join(ctx.ws.runDir("M07", runId), "undispatched-task-attempts");
				await mkdir(archiveRoot, { recursive: true, mode: 0o700 });
				const archive = path.join(archiveRoot, `${id}-${randomUUID()}`);
				await rename(dir, archive);
				await writeFileAtomic(`${archive}.json`, `${JSON.stringify({ version: 1, taskId: id, status: "not-dispatched", archivedAt: nowIso(), archivedPath: path.relative(ctx.ws.runDir("M07", runId), archive), reason: "no matching task in persisted goal" }, null, 2)}\n`);
			}
			let tempDir: string | undefined;
			if (spec.mode === "execute") {
				const scratchRoot = path.join(ctx.ws.runDir("M07", runId), "task-scratch");
				await mkdir(scratchRoot, { recursive: true, mode: 0o700 });
				tempDir = await mkdtemp(path.join(scratchRoot, `${id}-`));
			}
			await mkdir(inputsDir, { recursive: true });
			const copies: M07TaskRecord["inputCopies"] = [];
			if (branchParent && branchManifest) {
				for (const file of branchManifest.files) { const destination = path.join(workDir, file.relativePath); await mkdir(path.dirname(destination), { recursive: true }); await copyFile(file.frozenPath, destination); await chmod(destination, 0o644); }
				for (const original of branchParent.inputCopies) { const relative = path.relative(branchParent.workDir, original.copy); if (relative.startsWith("..") || !branchManifest.files.some((file) => file.relativePath === relative)) throw new HarnessError("m07.branch", "parent input lacks a frozen source mapping"); copies.push({ source: original.source, copy: path.join(workDir, relative), mediaType: original.mediaType }); }
				const childMap = branchManifest.files.map((file) => ({ historicalPath: file.historicalPath, frozenPath: file.frozenPath, childPath: path.join(workDir, file.relativePath) }));
				await writeFileAtomic(path.join(workDir, "branch-evidence-map.json"), `${JSON.stringify({ version: 1, parentRunId: runId, parentTaskId: branchParent.taskId, checkpointId: branchParent.branchSource!.checkpoint.id, files: childMap }, null, 2)}\n`);
				await writeFileAtomic(path.join(workDir, "fork-owner.json"), `${JSON.stringify({ version: 1, checkpointId: branchParent.branchSource!.checkpoint.id, parentRoot: branchManifest.parentWorkRoot, childRoot: workDir, childContainer: path.basename(path.dirname(workDir)) }, null, 2)}\n`);
			} else for (let i = 0; i < resolvedInputs.length; i++) { const source = resolvedInputs[i]; const copy = path.join(inputsDir, uniqueName(i, source)); await copyFile(source, copy); copies.push({ source, copy, mediaType: mediaType(source) }); }
			let pack: string | undefined;
			if (spec.knowledgeIds?.length) {
				for (const requested of spec.knowledgeIds) {
					const parsed = /^([CKEJQDX]\d{3,})(?:@(\d+))?$/.exec(requested);
					if (parsed && (await ctx.store.get(parsed[1], parsed[2] ? Number(parsed[2]) : undefined))?.fields.experience !== undefined) throw new HarnessError("m07.experience", `方法经验 ${requested} 必须通过固定 storeId、recordId、version 与适用性选择入口加载`);
				}
			}
			let experienceSelection: M07TaskRecord["experienceSelection"];
			if (spec.experienceRefs?.length) {
				const selection = await createExperienceProvider(ctx.store, options.registeredExperienceStores).select({ targetKind: "executor", applicability: { stage: "M07", tags: [spec.mode, ...(spec.experienceTags ?? [])], contextRefs: spec.experienceContextRefs }, requestedRefs: spec.experienceRefs, expectedSnapshotId: goal.knowledgeSnapshot, maxRecords: 24, maxChars: 24_000 });
				if (selection.status !== "ready") throw new HarnessError("m07.experience", `显式方法经验不可装载：${selection.omitted.map((item) => `${item.ref.storeId}/${item.ref.recordId}@${item.ref.version}:${item.reason}`).join("；") || selection.status}`);
				experienceSelection = { ...selection, invocationStatus: "unknown", faithfulUse: "unknown", causalBenefit: "unknown" };
				pack = selection.markdown;
			}
			const candidateEpisode = spec.executionLoop && "mode" in spec.executionLoop && spec.executionLoop.mode === "candidate-episode";
			// This is the task's first reading list. Goal-wide obligations stay in
			// the task prompt; adding them all to retrieval dilutes the local topic.
			// Later knowledge_select can search the entire frozen catalogue again.
			const knowledgeRequest = { purpose: candidateEpisode ? "M07 候选执行" : "M07 任务执行", text: [spec.objective, ...spec.checks].join("\n"), requiredIds: spec.knowledgeIds ?? [], context: spec.knowledgeContext, maxRecords: candidateEpisode ? Number.MAX_SAFE_INTEGER : INJECTION_PLANS.bootstrap.maxRecords, maxChars: candidateEpisode ? 60_000 : INJECTION_PLANS.bootstrap.maxChars, excludeExperience: true, ...(candidateEpisode ? { view: "brief" as const } : {}) };
			const initialRetrieval = await retrieveKnowledge(ctx.store, knowledgeRequest);
			// A large required dependency/warning closure may be valid yet too large for
			// the initial brief. Validate the complete index before dispatch, then show
			// only an explicitly labelled preview; live tools page the original records.
			const retrieval = candidateEpisode && initialRetrieval.status !== "ready"
				? await retrieveKnowledge(ctx.store, { ...knowledgeRequest, view: "index", maxChars: Number.MAX_SAFE_INTEGER })
				: initialRetrieval;
			if (retrieval.status !== "ready") throw new HarnessError("m07.knowledge", `required knowledge unavailable: ${retrieval.omitted.map((item) => `${item.ref}:${item.reason}`).join("; ")}`);
			if (retrieval !== initialRetrieval && (retrieval.snapshot !== initialRetrieval.snapshot || JSON.stringify(retrieval.limits) !== JSON.stringify(initialRetrieval.limits)))
				throw new HarnessError("m07.knowledge", "knowledge snapshot or live limits changed during initial projection");
			if ((goal.knowledgeSnapshot || candidateEpisode) && retrieval.snapshot !== goal.knowledgeSnapshot) throw new HarnessError("m07.knowledge", "knowledge snapshot changed since goal baseline; refresh explicitly");
			let previewEnd = Math.min(12_000, retrieval.pack.markdown.length);
			if (previewEnd < retrieval.pack.markdown.length && previewEnd > 0 &&
				retrieval.pack.markdown.charCodeAt(previewEnd - 1) >= 0xD800 &&
				retrieval.pack.markdown.charCodeAt(previewEnd - 1) <= 0xDBFF) previewEnd--;
			const preview = retrieval === initialRetrieval ? retrieval.pack.markdown : retrieval.pack.markdown.slice(0, previewEnd);
			const previewNotice = retrieval === initialRetrieval ? "" : `完整必要依赖/警告组已在宿主只读校验；以下仅展示索引 UTF-16 0-${preview.length}/${retrieval.pack.markdown.length}，记录共 ${retrieval.rankedRefs.length} 项。未展示的条目和全部正文、条件、限制须通过 knowledge_select / knowledge_read 分页取得；前缀不表示任何记录已被完整阅读。\n`;
			if (retrieval.pack.included.length) pack = [previewNotice + preview, pack].filter(Boolean).join("\n\n");
			if (candidateEpisode) pack = ["以下知识卡保留适用条件、原有结论、限制和证据入口。阶段、结构或症状变化后可调用 knowledge_select 检索，按 ID 用 knowledge_read 分页读取完整 fields/body/refs，使用 knowledge_artifact_read 读取已登记的冻结代码证据；始终保留必要依赖、反驳与限制。卡片不表示正文或引用证据已读。工具只读本目标冻结知识版本并核验实时限制，不刷新快照、不采用知识、不隐式加载方法经验。知识正文中的任意路径字符串本身不授权读取。", pack].filter(Boolean).join("\n\n");
			const verifyDispatchKnowledge = async (): Promise<void> => {
				const sameLocalState = async () => (await ctx.store.current())?.id === retrieval.snapshot && JSON.stringify(await ctx.store.limits()) === JSON.stringify(retrieval.limits);
				if (!await sameLocalState()) throw new HarnessError("m07.knowledge", "knowledge snapshot or live limits changed before task dispatch");
				await requireCurrentFormalBaseline(ctx, goal);
				await verifyFrozenWorkflowMethod(ctx, goal, options.registeredExperienceStores, spec);
				if (experienceSelection && spec.experienceRefs?.length) {
					const fresh = await createExperienceProvider(ctx.store, options.registeredExperienceStores).select({ targetKind: "executor", applicability: { stage: "M07", tags: [spec.mode, ...(spec.experienceTags ?? [])], contextRefs: spec.experienceContextRefs }, requestedRefs: spec.experienceRefs, expectedSnapshotId: goal.knowledgeSnapshot, maxRecords: 24, maxChars: 24_000 });
					if (fresh.status !== "ready" || fresh.markdown !== experienceSelection.markdown || JSON.stringify(fresh.selected) !== JSON.stringify(experienceSelection.selected)) throw new HarnessError("m07.experience", "pinned task experience changed or became unavailable before dispatch");
				}
				if (!await sameLocalState()) throw new HarnessError("m07.knowledge", "knowledge snapshot or live limits changed during dispatch check");
			};
			const expectedOutputPaths = spec.expectedOutputs.map((x) => { const resolved = path.resolve(workDir, x); if (!inside(workDir, resolved)) throw new HarnessError("m07.path", `预期产物路径逃逸任务目录：${x}`); return resolved; });
			const role = spec.mode === "check" ? "reviewer" : "execution";
			const tools: ToolGrant = spec.mode === "execute" ? { kind: "execution", root: workDir, tempDir: tempDir!, tools: ["read", "write", "edit", "bash"] } : { kind: "read-dir", root: workDir };
			const operationId = spec.mode === "execute" && goal.executionState ? `O${String(goal.executionState.operations.length + 1).padStart(3, "0")}` : undefined;
			const branchSuffix = branchParent?.branchSource && branchManifest ? `\n\n# Frozen competitive branch\nThis is an independently writable candidate for the exact same task and goal obligations. The inherited Pi history is a historical causal record, not permission to reuse its old absolute paths or repeat external actions. Historical work root: ${branchManifest.parentWorkRoot}. Your private work root: ${workDir}. The complete old-path to frozen-evidence and private-copy mapping is in branch-evidence-map.json in your work root. Read original evidence as needed; the manifest and summaries alone do not mean you have read it. Keep formal work in your private work root and disposable files in your own TMPDIR. Do not modify parent files, other branches, the knowledge store, or original checks. Your result is a candidate until the M07 controller reviews and explicitly selects it; M04 alone decides knowledge adoption.` : "";
			let { message, event, layout } = await taskMessage(ctx, goal, id, spec, copies, pack, policy, snapshotLimits, operationId, tempDir, branchSuffix.length);
			message += branchSuffix;
			if (message.length + systemPromptFor(role).length > policy.maxPromptChars) throw new HarnessError("context.budget", "task evidence handoff exceeds the frozen prompt budget");
			await writeFileAtomic(path.join(dir, "message.md"), message);
			const task: M07TaskRecord = { ...spec, taskId: id, status: "running", createdAt: nowIso(), returnedAt: "", promptLayout: layout, workDir, inputCopies: copies, expectedOutputPaths, readCoverage: [], toolLog: [], knowledgeSnapshot: goal.knowledgeSnapshot, m04BaselineRunId: goal.m04BaselineRunId, experienceSelection, ...(spec.planInput ? { planCopy: copies.find((item) => item.source === spec.planInput)?.copy } : {}) };
			let handle: SessionHandle | undefined;
			// Read coverage of sessions closed at an episode boundary stays part of
			// this task's record; a restart must not erase what was read.
			const carriedCoverage: M07TaskRecord["readCoverage"] = [];
			let hostRecoveryReason: HarnessError | undefined;
			let hostRecoveryAbort: Promise<void> | undefined;
			let hostRecoveryAbortError: string | undefined;
			let activeCandidateCalls = 0;
			// Background candidate runs outlive the tool call that started them, so the
			// host keeps their drain and awaits it before the prompt can stop.
			let drainBackgroundRuns: (() => Promise<void>) | undefined;
			if (spec.executionLoop && "mode" in spec.executionLoop && spec.executionLoop.mode === "candidate-episode") {
				task.episode = { version: 1, candidates: [], incumbents: [] };
				if (tools.kind !== "execution") throw new HarnessError("m07.episode", "candidate episode requires execution tools");
				const verifier = requireCandidateVerifier(options.candidateVerifier, goal.candidateVerification);
				const evaluationTool = createCandidateEpisodeTool({ goal, task, verifier, store: ctx.store,
					priorRoot: path.join(ctx.ws.knowledgeDir, "prior"), save: () => save(ctx, goal) });
				tools.extraTools = [evaluationTool,
					...(options.candidateExecutionBackend && operationId ? createCandidateExecutionTools({
						goalRunId: runId, taskId: id, operationId, subjectId: task.subjectId, workDir,
						journalDir: path.join(dir, "candidate-runs"), backend: options.candidateExecutionBackend,
						searchEventLogFile: path.join(ctx.ws.runDir("M07", runId), "search-events.jsonl"),
						backgroundRuns: { register: drain => { drainBackgroundRuns = drain; } },
						evaluate: args => evaluationTool.execute(args),
					}).map(tool => ({ ...tool, execute: async (args: Record<string, unknown>, signal?: AbortSignal) => {
						if (hostRecoveryReason) throw hostRecoveryReason;
						activeCandidateCalls++;
						try { return await tool.execute(args, signal); }
						finally {
							activeCandidateCalls--;
							// The runner serializes candidate execution internally. Wait for every
							// queued wrapper, including rejected calls, before stopping the prompt.
							if (!activeCandidateCalls && !hostRecoveryReason) {
								await drainBackgroundRuns?.();
								const pending = await pendingCandidateExecutions({ journalDir: path.join(dir, "candidate-runs"),
									goalRunId: runId, taskId: id, operationId, backend: options.candidateExecutionBackend });
								if (!activeCandidateCalls && !hostRecoveryReason && pending.some(item => !item.queryAvailable)) {
									hostRecoveryReason = new HarnessError("m07.candidate-execution-unresolved",
										`候选副作用仍未知且不能按原 ID 查询；宿主已交还规划层对账，不能重交：${JSON.stringify(pending)}`);
									// Awaiting abort inside this tool can wait for the tool itself.
									hostRecoveryAbort = handle!.abort().catch(error => { hostRecoveryAbortError = (error as Error).message; });
								}
							}
						}
					} })) : []),
					...createCandidateArchiveTools({ goal, task, save: () => save(ctx, goal) }),
					...createExecutionKnowledgeTools({ store: ctx.store, workspaceRoot: ctx.ws.root, candidateRoot: workDir, expectedSnapshot: goal.knowledgeSnapshot,
						requiredIds: task.knowledgeIds ?? [], context: task.knowledgeContext, archiveDir: path.join(dir, "knowledge-access"),
						beforeAccess: () => requireCurrentFormalBaseline(ctx, goal),
						onAccess: async event => { (task.knowledgeAccess ??= []).push(event); await save(ctx, goal); } })];
			}
			const operation: M07OperationV1 | undefined = operationId ? { version: 1, id: operationId, taskId: id, status: "prepared", issuedAt: nowIso() } : undefined;
			if (operation) goal.executionState!.operations.push(operation);
			goal.tasks.push(task); await save(ctx, goal);
			if (afterPrepared) await afterPrepared(runId, id);
			let promptIssued = false;
			let activeOperation = operation;
			try {
				const frozenInputBytes = await Promise.all([task.planCopy, ...(task.resourceInputs ?? []).map((item) => copies.find((copy) => copy.source === item.input)?.copy)].filter((item): item is string => Boolean(item)).map(async (copy) => ({ copy, bytes: await readFile(copy) })));
				const verifyFrozenInputs = async (): Promise<void> => { for (const input of frozenInputBytes) if (!(await readFile(input.copy)).equals(input.bytes)) throw new HarnessError("m07.plan-input", "builder changed a frozen plan or versioned resource copy; stop this task and review the evidence"); };
				const session = sessionSpec(ctx, `M07-${id}`, role, systemPromptFor(role), tools);
				if (goal.methodBinding) session.methodBinding = goal.methodBinding;
				// The task's own frozen deadline reaches the session as an observed fact
				// in tool results, never as prompt prefix and never as a stop condition.
				const taskDeadline = spec.executionLoop && "mode" in spec.executionLoop ? spec.executionLoop.deadlineAt : undefined;
				if (taskDeadline) session.runDeadline = taskDeadline;
				const runRecord = await ctx.ws.readRun("M07", runId);
				if (branchParent?.branchSource && branchManifest) {
					const checkpoint = branchParent.branchSource.checkpoint;
					const workspaceBinding = { version: 1 as const, parentRoot: branchManifest.parentWorkRoot, authorizedChildRootBase: branchManifest.authorizedChildRootBase, childWorkLeaf: branchManifest.forkWorkspaceAuthority.childWorkLeaf, childRoot: workDir, ownerMarkerPath: path.join(workDir, "fork-owner.json"), frozenEvidenceRoot: branchManifest.frozenWorkRoot, files: branchManifest.files.map((file) => ({ sourcePath: file.historicalPath, frozenPath: file.frozenPath, childPath: path.join(workDir, file.relativePath), bytes: file.bytes })) };
					const evidence: EvidenceBindingV1[] = [
						{ version: 1, label: `M07 ${branchParent.taskId} frozen work mapping`, path: checkpoint.manifestSnapshot, status: "frozen-copy", sourceVersion: checkpoint.id },
						{ version: 1, label: "original problem snapshot", path: branchParent.branchSource.problemSnapshotCopy, status: "frozen-copy", sourceVersion: `${runId}/${branchParent.taskId}` },
					];
					handle = await openBoundedSession(ctx.runner, runRecord, { mode: "fork", intent: "branch-exploration", reason: `M07 ${id} competes from ${branchParent.taskId} frozen checkpoint ${checkpoint.id}; original checks and goal obligations remain binding`, evidence, checkpoint, workspaceBinding, spec: session }, () => ctx.ws.writeRun(runRecord));
				} else {
					const evidence: EvidenceBindingV1[] = copies.map((item) => ({ version: 1, label: path.basename(item.copy), path: item.copy, status: "frozen-copy", sourceVersion: `${runId}/${id}` }));
					handle = await openBoundedSession(ctx.runner, runRecord, { mode: "fresh", intent: spec.mode === "check" ? "independent-judgment" : "new-work", reason: spec.mode === "check" ? "M07 independent task/check requires an uninherited judgement" : "M07 new task has no causal parent session", evidence, spec: session }, () => ctx.ws.writeRun(runRecord));
				}
				task.session = handle.ref; await save(ctx, goal);
				if (spec.executionLoop && "mode" in spec.executionLoop && spec.executionLoop.mode === "until-ready") {
					const loopBounds = spec.executionLoop && "mode" in spec.executionLoop ? spec.executionLoop : undefined;
					await runUntilReadyRounds({ ctx, goal, task, spec, policy, runId, taskId: id, dir, workDir, message,
						maxRounds: loopBounds?.maxRounds ?? (goal.searchBudget ?? DEFAULT_SEARCH_BUDGET).reviewRoundsPerTask,
						...(loopBounds?.deadlineAt ? { deadlineAt: loopBounds.deadlineAt } : {}),
						...(pack ? { pack } : {}), handle, operation: operation!, event,
						...(branchParent ? { branchParent } : {}),
						save: () => save(ctx, goal), verifyDispatchKnowledge, verifyFrozenInputs,
						setActiveOperation: (next) => { activeOperation = next; },
						markPromptIssued: () => { promptIssued = true; },
						validateReadyFiles: async (reviewerRoot) => {
							const candidate = await validateCandidateFiles(reviewerRoot, spec.expectedOutputs.map((item) => path.join(reviewerRoot, item)), spec.lessonDeltaOutput);
							const failures = [...candidate.expectedOutputs.flatMap((item) => item.error ? [item.error] : []), ...(candidate.lessonDeltaFailure ? [candidate.lessonDeltaFailure] : [])];
							return failures.length ? failures.join("; ") : undefined;
						} });
				} else {
					await verifyDispatchKnowledge();
					event.deliveryStatus = "submitted"; event.providerUsageSessionId = handle.ref.id; await writeProjectionEvent(ctx.ws, event);
					if (operation) { operation.status = "issued"; await save(ctx, goal); }
					promptIssued = true;
					let report: string;
					let builderMessage = message;
					const searchBudget = goal.searchBudget ?? DEFAULT_SEARCH_BUDGET;
					// Outer loop: episode boundaries. The builder keeps its live session
					// until the configured number of evaluations has passed, then the
					// host distils what that session established and starts it clean.
					for (;;) {
					for (;;) {
						report = (await handle.prompt(builderMessage)).text;
						if (hostRecoveryReason) throw hostRecoveryReason;
						await verifyFrozenInputs();
						const pending = operation ? await pendingCandidateExecutions({ journalDir: path.join(dir, "candidate-runs"),
							goalRunId: runId, taskId: id, operationId: operation.id, backend: options.candidateExecutionBackend }) : [];
						if (!pending.length) break;
						if (pending.some(item => !item.queryAvailable))
							throw new HarnessError("m07.candidate-execution-unresolved", `候选副作用仍未知且不能按原 ID 查询；必须宿主对账，不能重交：${JSON.stringify(pending)}`);
						builderMessage = `The preceding builder turn ended while these exact candidate evaluations remain pending or unknown: ${JSON.stringify(pending)}. Continue in THIS SAME live session. Call the indicated existing tool with its original runId and resume:true to query the original external ID; do not create a new run, resubmit, or treat submitted/confirmed as a terminal judge result. Keep the original goal and checks. A pending evaluation is not a goal stop; after terminal results are verified, report the actual evidence.`;
					}
					const episode = task.episode;
					if (!episode || !searchBudget.episodeRestartEvaluations) break;
					const evaluatedBefore = episode.restarts?.at(-1)?.afterCandidates ?? 0;
					if (episode.candidates.length - evaluatedBefore < searchBudget.episodeRestartEvaluations) break;
					const ledger = candidateBudgetLedger(candidateArchive(goal, id),
						{ taskId: id, subjectId: task.subjectId, policy: searchBudget,
							...(task.subjectProfile ? { category: task.subjectProfile.operatorCategory } : {}) });
					// A spent or stalled task hands control back instead of restarting.
					if (ledger.stop || !ledger.remaining) break;
					const episodeRecord = await distillEpisode({ runId, taskId: id,
						episode: (episode.restarts?.length ?? 0) + 1, at: nowIso(),
						...(task.subjectId ? { subjectId: task.subjectId } : {}),
						history: candidateArchive(goal, id),
						compactionLog: path.join(ctx.ws.sessionsDir, `${handle.ref.id}.compaction.jsonl`),
						platformLog: path.join(ctx.ws.sessionsDir, `${handle.ref.id}.platform.jsonl`) });
					const recordPath = await writeEpisodeRecord(ctx.ws.root, episodeRecord);
					carriedCoverage.push(...handle.readCoverage());
					task.toolLog.push(...handle.toolLog());
					const previousSessionId = handle.ref.id;
					handle.dispose();
					(episode.restarts ??= []).push({ at: episodeRecord.at, recordPath,
						afterCandidates: episode.candidates.length, previousSessionId });
					await save(ctx, goal);
					const restartRun = await ctx.ws.readRun("M07", runId);
					const restartSpec = sessionSpec(ctx, `M07-${id}-episode-${episodeRecord.episode}`, role, systemPromptFor(role), tools);
					if (goal.methodBinding) restartSpec.methodBinding = goal.methodBinding;
					if (taskDeadline) restartSpec.runDeadline = taskDeadline;
					handle = await openBoundedSession(ctx.runner, restartRun, { mode: "fresh", intent: "episodic-restart",
						reason: `M07 ${id} episode ${episodeRecord.episode} boundary: the previous context was cleared and this distilled record carries its established facts forward`,
						evidence: [{ version: 1, label: `M07 ${id} episode record E${episodeRecord.episode}`, path: recordPath,
							status: "frozen-copy", sourceVersion: `${runId}/${id}` }], spec: restartSpec },
						() => ctx.ws.writeRun(restartRun));
					task.session = handle.ref;
					await save(ctx, goal);
					builderMessage = episodeRestartMessage(message, episodeRecord);
					}
					if (operation) operation.status = "response-received";
					if (task.experienceSelection) task.experienceSelection.loadedAt = nowIso();
					const reportPath = path.join(dir, "report.md"); await writeFileAtomic(reportPath, report);
					task.reportPath = reportPath; task.status = "returned";
					// A spent search budget is a recorded control fact, not a model claim.
					if (task.episode?.budget?.stop) task.loopStopReason = "budget-boundary";
				}
			} catch (error) {
				if (hostRecoveryAbort) await hostRecoveryAbort;
				task.status = "failed"; task.executionFailure = (hostRecoveryReason ?? error as Error).message +
					(hostRecoveryReason && error !== hostRecoveryReason ? `；child prompt terminated: ${(error as Error).message}` : "") +
					(hostRecoveryAbortError ? `；child abort failed: ${hostRecoveryAbortError}` : "");
				if (activeOperation?.status === "prepared") activeOperation.status = "not-issued";
				if (activeOperation && promptIssued && activeOperation.status === "issued") {
					const requestNotSent = hostRecoveryReason ? undefined : requestNotSentDetails(error);
					const terminalResponse = hostRecoveryReason ? undefined : settledTerminalResponseDetails(error);
					let confinedGrantVerified = false;
					if ((requestNotSent || terminalResponse) && handle && ctx.runner.attestConfinedGrant) {
						try {
							const grant = await ctx.runner.attestConfinedGrant(handle);
							confinedGrantVerified = grant?.version === 1 && grant.kind === "confined-campaign-files" &&
								await realpath(grant.root) === await realpath(task.workDir);
						} catch { /* A missing or failed live grant attestation leaves the operation unknown. */ }
					}
					if (requestNotSent?.requestNotSent === true &&
						requestNotSent.noProviderRequestsInPrompt === true &&
						requestNotSent.effectScope === "factory-attested-confined-file-tools" &&
						confinedGrantVerified) {
						try {
							const receiptPath = path.join(dir, "request-contract-not-issued-receipt.json");
							await writeFileAtomic(receiptPath, `${JSON.stringify({ version: 1,
								kind: "m07-host-request-contract-not-issued", goalRunId: runId,
								taskId: id, operationId: activeOperation.id,
								requestNotSent: true, noProviderRequestsInPrompt: true,
								violation: requestNotSent.violation, messageIndex: requestNotSent.messageIndex,
								effectScope: requestNotSent.effectScope,
								observedAt: nowIso() }, null, 2)}\n`);
							activeOperation.status = "not-issued";
							activeOperation.resolvedAt = nowIso();
							activeOperation.observationMethod = "host-request-contract-preflight";
							activeOperation.evidencePath = receiptPath;
							task.loopStopReason = "request-contract-invalid";
						} catch { activeOperation.status = "unknown"; }
					} else if (terminalResponse?.effectScope === "factory-attested-confined-file-tools" && confinedGrantVerified) {
						try {
							const receiptPath = path.join(dir, "terminal-response-receipt.json");
							await writeFileAtomic(receiptPath, `${JSON.stringify({ version: 1,
								kind: "m07-incomplete-settled-terminal-response", goalRunId: runId,
								taskId: id, operationId: activeOperation.id,
								settledProviderRequestCount: terminalResponse.settledProviderRequestCount,
								responseReceived: true, terminalStopReason: "length", taskComplete: false,
								effectScope: terminalResponse.effectScope,
								observedAt: nowIso() }, null, 2)}\n`);
							activeOperation.status = "terminal-response-incomplete";
							activeOperation.resolvedAt = nowIso();
							activeOperation.observationMethod = "host-terminal-response";
							activeOperation.evidencePath = receiptPath;
							task.loopStopReason = "output-limit";
						} catch { activeOperation.status = "unknown"; }
					} else activeOperation.status = "unknown";
				}
			} finally {
				if (handle) {
					if (task.mode === "execute" && task.status === "returned") {
						try {
							if (!ctx.runner.checkpoint) throw new HarnessError("m07.branch-unsupported", "runner has no stable checkpoint capability");
							if (goal.executionState?.operations.some((item) => !["response-received", "partial-settled", "terminal-response-incomplete", "confirmed", "not-issued"].includes(item.status))) throw new HarnessError("m07.branch", "external operation is not settled");
							for (const recordedOperation of goal.executionState?.operations ?? []) {
								const pending = await pendingCandidateExecutions({ journalDir: path.join(ctx.ws.runDir("M07", runId), "tasks", recordedOperation.taskId, "candidate-runs"),
									goalRunId: runId, taskId: recordedOperation.taskId, operationId: recordedOperation.id, backend: options.candidateExecutionBackend });
								if (pending.length) throw new HarnessError("m07.branch", "candidate backend evaluation is not terminal; cannot attest externalOperationsSettled");
							}
							const frozen = await freezeBranchWork(goal, task);
							const checkpoint = await ctx.runner.checkpoint(handle, { inputManifest: frozen.manifestPath, runId, taskId: id, externalOperationsSettled: true });
							task.branchSource = { version: 1, checkpoint, manifestPath: frozen.manifestPath, workSnapshotRoot: frozen.workSnapshotRoot, problemSnapshotCopy: frozen.problemSnapshotCopy };
						} catch (error) { task.branchUnavailableReason = (error as Error).message; }
					}
					task.readCoverage = handle.readCoverage(); task.toolLog.push(...handle.toolLog()); handle.dispose();
				}
				task.returnedAt = nowIso(); await save(ctx, goal);
			}
			return task;
			});
		},

		async review(runId, input) {
			return withDispatch(runId, async () => {
			const goal = await load(ctx, runId); requireActive(goal); await requireLoadedAttemptSource(goal); const task = goal.tasks.find((t) => t.taskId === input.taskId); if (!task) throw new HarnessError("m07.task", `未知任务 ${input.taskId}`);
			if (goal.decisions.some((d) => d.status === "open" && d.relatedTaskIds.includes(task.taskId))) throw new HarnessError("m07.decision", "该任务关联待用户决定事项，不能采用；不受影响任务仍可继续");
			if (task.status !== "returned") throw new HarnessError("m07.review", `任务 ${task.taskId} 状态为 ${task.status}，不能评审采用`);
			const taskRoot = await realpath(path.dirname(task.workDir)); const reportReal = task.reportPath ? await realpath(task.reportPath) : undefined;
			const readySnapshot = task.executionLoop && "mode" in task.executionLoop && task.executionLoop.mode === "until-ready" && task.loopStopReason === "ready" ? task.executionRounds?.at(-1)?.reviewerSnapshotPath : undefined;
			const ensureRoundReviewed = async (source: string): Promise<void> => {
				if (!readySnapshot || source === reportReal) return;
				if (!readySnapshot || !inside(await realpath(task.workDir), source)) throw new HarnessError("m07.review", "bounded-loop evidence was not in the ready reviewer work snapshot");
				const relative = path.relative(task.workDir, source);
				let frozen: string;
				try { frozen = await realpath(path.join(readySnapshot, relative)); }
				catch { throw new HarnessError("m07.review", `evidence was added after ready review: ${relative}`); }
				if (!inside(await realpath(readySnapshot), frozen) || !(await readFile(source)).equals(await readFile(frozen))) throw new HarnessError("m07.review", `evidence changed after ready review: ${relative}`);
			};
			if (!input.checks.length || (!task.candidate && !input.artifacts.length)) throw new HarnessError("m07.review", "不能用空 checks 接受任务；普通任务还须提交 artifacts；reason/check 可提交自动保存的 report.md");
			const snapshotDir = path.join(path.dirname(task.workDir), "review-snapshot"); await mkdir(snapshotDir, { recursive: true });
			const frozenBySource = new Map<string, string>(); let frozenIndex = 0;
			const freeze = async (source: string): Promise<string> => { const found = frozenBySource.get(source); if (found) return found; const target = path.join(snapshotDir, uniqueName(frozenIndex++, source)); await copyFile(source, target); const frozen = await realpath(target); frozenBySource.set(source, frozen); return frozen; };
			if (!reportReal) throw new HarnessError("m07.review", "任务没有可冻结的会话报告");
			const frozenReportPath = await freeze(reportReal);
			const artifacts: EvidenceFile[] = []; for (const p of input.artifacts) { const resolved = await confinedExistingFile(ctx, p); if (!inside(taskRoot, resolved) && resolved !== reportReal) throw new HarnessError("m07.review", `成果不属于任务固定目录或会话报告：${p}`); await ensureRoundReviewed(resolved); artifacts.push({ path: await freeze(resolved), sourcePath: resolved, mediaType: mediaType(resolved), readCoverage: mediaType(resolved) === "text" ? "recorded-not-reviewed" : "unread-binary" }); }
			const checks: TaskCheck[] = []; for (const check of input.checks) { if (!task.checks.includes(check.criterion)) throw new HarnessError("m07.review", `检查不属于任务定义：${check.criterion}`); const evidence = []; for (const p of check.evidence) { const resolved = await confinedExistingFile(ctx, p); if (!inside(taskRoot, resolved) && resolved !== reportReal) throw new HarnessError("m07.review", `检查证据不属于任务固定目录或会话报告：${p}`); await ensureRoundReviewed(resolved); evidence.push(await freeze(resolved)); } if (check.result === "passed" && !evidence.length) throw new HarnessError("m07.review", `通过检查必须有实际文件证据：${check.criterion}`); checks.push({ ...check, evidence }); }
			if (task.checks.some((criterion) => !checks.some((c) => c.criterion === criterion))) throw new HarnessError("m07.review", "必须逐项记录任务定义的全部 checks");
			const failures = [...(input.failures ?? [])], unexecuted = [...(input.unexecuted ?? [])], limitations = input.limitations ?? [];
			const addExpectedArtifact = async (source: string): Promise<void> => {
				if (artifacts.some((item) => item.sourcePath === source)) return;
				await ensureRoundReviewed(source);
				const type = mediaType(source);
				artifacts.push({ path: await freeze(source), sourcePath: source, mediaType: type, readCoverage: type === "text" ? "recorded-not-reviewed" : "unread-binary" });
			};
			const candidateFiles = await validateCandidateFiles(task.workDir, task.expectedOutputPaths, task.lessonDeltaOutput);
			const expectedOutputs = candidateFiles.expectedOutputs;
			for (const expected of expectedOutputs) {
				if (expected.error) { failures.push(expected.error); continue; }
				for (const file of expected.files) await addExpectedArtifact(file);
			}
			if (readySnapshot) {
				const reviewerRoot = task.executionRounds?.at(-1)?.reviewerSnapshotPath;
				if (!reviewerRoot) failures.push("Ready verdict has no immutable round snapshot");
				else {
					const frozenOutputs = await resolveExpectedOutputFiles(reviewerRoot, task.expectedOutputs.map((item) => path.join(reviewerRoot, item)));
					for (let i = 0; i < expectedOutputs.length; i++) {
						if (expectedOutputs[i].error || frozenOutputs[i].error) { failures.push(`Ready snapshot lacks expected output ${task.expectedOutputs[i]}`); continue; }
						const currentFiles = expectedOutputs[i].files.map((file) => path.relative(task.workDir, file)).sort();
						const handoffDir = task.executionRounds?.at(-1)?.builderReportHandoffDir;
						const frozenFiles = frozenOutputs[i].files.map((file) => path.relative(reviewerRoot, file))
							.filter(relative => !handoffDir || (relative !== handoffDir && !relative.startsWith(`${handoffDir}${path.sep}`))).sort();
						if (!sameStrings(currentFiles, frozenFiles)) { failures.push(`Output set changed after ready review: ${task.expectedOutputs[i]}`); continue; }
						for (const relative of currentFiles) if (!(await readFile(path.join(task.workDir, relative))).equals(await readFile(path.join(reviewerRoot, relative)))) failures.push(`Output bytes changed after ready review: ${relative}`);
					}
				}
			}
			if (candidateFiles.lessonDeltaFailure) failures.push(candidateFiles.lessonDeltaFailure);
			if (task.lessonDeltaOutput && !candidateFiles.lessonDeltaFailure)
				await addExpectedArtifact(await realpath(path.join(task.workDir, task.lessonDeltaOutput)));
			for (const evidence of candidateFiles.lessonEvidence) await addExpectedArtifact(evidence);
			const frozenCandidateFiles = async (declared: string[]): Promise<FrozenCandidateFile[]> => Promise.all(declared.map(async declaredPath => {
				const source = path.join(task.workDir, declaredPath);
				const info = await lstat(source);
				if (!info.isFile() || info.isSymbolicLink()) throw new HarnessError("m07.candidate", `candidate declaration must name an exact regular file: ${declaredPath}`);
				const originalPath = await realpath(source);
				if (!inside(await realpath(task.workDir), originalPath)) throw new HarnessError("m07.candidate", "candidate file escaped task work directory");
				await addExpectedArtifact(originalPath);
				return { declaredPath, originalPath, frozenPath: await freeze(originalPath) };
			}));
			const candidateSources = task.candidate ? await frozenCandidateFiles(task.candidate.sourcePaths) : [];
			const candidateReceipts = task.candidate ? await frozenCandidateFiles(task.candidate.receiptPaths) : [];
			if (task.requireIndependentCheck) {
				const independent = input.independentCheck; if (!independent) throw new HarnessError("m07.review", "该任务要求独立检查，必须引用独立 check 任务报告并说明对发现的处置");
				const checkTask = goal.tasks.find((t) => t.taskId === independent.taskId); if (!checkTask || checkTask.mode !== "check" || !["returned", "accepted"].includes(checkTask.status)) throw new HarnessError("m07.review", "独立检查必须是另一个已返回的 check 任务");
				if (!independent.disposition.trim()) throw new HarnessError("m07.review", "必须显式说明如何处置独立检查发现");
				independent.report = await confinedExistingFile(ctx, independent.report);
				if (!checkTask.reportPath || independent.report !== await realpath(checkTask.reportPath)) throw new HarnessError("m07.review", "引用的独立检查报告与 check 任务不一致");
				independent.report = await freeze(independent.report);
				for (const artifact of artifacts) {
					let matchingCopy: M07TaskRecord["inputCopies"][number] | undefined;
					for (const copy of checkTask.inputCopies) if ((await readFile(copy.copy)).equals(await readFile(artifact.path))) { matchingCopy = copy; break; }
					if (!matchingCopy) throw new HarnessError("m07.review", `独立 check 未取得当前提交版本的成果：${path.basename(artifact.path)}`);
					if (artifact.mediaType === "binary") { const relativeCopy = path.relative(checkTask.workDir, matchingCopy.copy); if (!checkTask.readCoverage.includes(relativeCopy)) throw new HarnessError("m07.review", `二进制成果没有独立 check 的真实读取记录：${relativeCopy}`); }
				}
			}
			// Dynamic knowledge access is audit evidence from the builder, not an
			// output the independent checker had to receive before its own task.
			for (const access of task.knowledgeAccess ?? []) {
				await addExpectedArtifact(access.frozenPath);
				access.frozenPath = await freeze(access.frozenPath);
			}
			// Episode evidence was frozen at each tool call. Include every negative and
			// successful observation after the independent check of final outputs.
			for (const episodeCandidate of task.episode?.candidates ?? []) {
				const sourceFiles = [...episodeCandidate.observation.sourceFiles];
				const receiptFiles = [...episodeCandidate.observation.receiptFiles];
				const observationPath = episodeCandidate.observationPath;
				for (const file of [...sourceFiles, ...receiptFiles, observationPath])
					await addExpectedArtifact(file);
				episodeCandidate.observation.sourceFiles = await Promise.all(sourceFiles.map(freeze));
				episodeCandidate.observation.receiptFiles = await Promise.all(receiptFiles.map(freeze));
				episodeCandidate.observationPath = await freeze(observationPath);
				// The portable observation below is a derived review record, not a
				// byte-for-byte alias of its original episode JSON.
				const derived = artifacts.find(item => item.path === episodeCandidate.observationPath);
				if (derived) delete derived.sourcePath;
				await writeFileAtomic(episodeCandidate.observationPath, `${JSON.stringify({ version: 1, id: episodeCandidate.id,
					parentCandidateId: episodeCandidate.parentCandidateId, parentRef: episodeCandidate.parentRef,
					identicalSourceRefs: episodeCandidate.identicalSourceRefs,
					sourceRepetition: episodeCandidate.sourceRepetition,
					sourcePaths: episodeCandidate.sourcePaths, receiptPaths: episodeCandidate.receiptPaths,
					hypothesis: episodeCandidate.hypothesis, conditions: episodeCandidate.conditions,
					changeSummary: episodeCandidate.changeSummary,
					parentComparison: episodeCandidate.parentComparison,
					changeKind: episodeCandidate.changeKind, intent: episodeCandidate.intent,
					sourceFilesRelativeToObservationDir: true,
					observation: { ...episodeCandidate.observation,
						sourceFiles: episodeCandidate.observation.sourceFiles.map(file => path.basename(file)),
						receiptFiles: episodeCandidate.observation.receiptFiles.map(file => path.basename(file)) } }, null, 2)}\n`);
			}
			if (task.episode && !task.candidate) for (const recorded of checks) {
				const observations = task.episode.candidates.flatMap(candidate => candidate.observation.checks
					.filter(check => check.criterion === recorded.criterion)
					.map(check => ({ check, candidate })));
				if (observations.some(item => item.check.result === "failed") &&
					!observations.some(item => item.check.result === "passed")) {
					recorded.result = "failed";
					recorded.evidence = [...new Set([...recorded.evidence, ...observations
						.filter(item => item.check.result === "failed")
						.flatMap(item => [item.candidate.observationPath, ...item.candidate.observation.sourceFiles, ...item.candidate.observation.receiptFiles])])];
				}
			}
			if (task.candidate) {
				const binding = goal.candidateVerification;
				if (!binding || goal.tasks.indexOf(task) < binding.firstTaskIndex)
					throw new HarnessError("m07.candidate", "candidate task is outside the host verifier binding");
				const verifier = requireCandidateVerifier(options.candidateVerifier, binding);
				let observation: CandidateObservationV1;
				let observationPath: string;
				if (task.episode) {
					let matched: NonNullable<M07TaskRecord["episode"]>["candidates"][number] | undefined;
					for (const candidate of [...task.episode.candidates].reverse()) {
						if (candidate.sourcePaths.length !== task.candidate.sourcePaths.length ||
							candidate.receiptPaths.length !== task.candidate.receiptPaths.length) continue;
						const frozenPaths = [...candidate.observation.sourceFiles, ...candidate.observation.receiptFiles];
						if ((await Promise.all([...candidateSources, ...candidateReceipts].map(async (file, index) =>
							(await readFile(file.frozenPath)).equals(await readFile(frozenPaths[index]))))).every(Boolean)) { matched = candidate; break; }
					}
					if (!matched)
						throw new HarnessError("m07.candidate", "declared final candidate bytes must exactly match an evaluated episode candidate; no implicit re-evaluation occurs");
					observation = matched.observation;
					observationPath = matched.observationPath;
				} else {
					let result: Awaited<ReturnType<CandidateVerifier["verifyTask"]>>;
					try { result = await verifier.verifyTask({ goal: structuredClone(goal), task: structuredClone(task), sources: candidateSources, receipts: candidateReceipts }); }
					catch (error) { result = { sourceBinding: "unknown", correctness: "unknown", stage: "verification-unavailable",
						checks: task.checks.map(criterion => ({ criterion, result: "not_run" as const })), metrics: [],
						limitations: [`Host candidate verification failed: ${(error as Error).message}`] }; }
					for (const file of [...candidateSources, ...candidateReceipts])
						if (!(await readFile(file.originalPath)).equals(await readFile(file.frozenPath)))
							throw new HarnessError("m07.candidate", "candidate source or original receipt changed during host verification");
					observation = candidateObservation(result, verifier, goal, task, candidateSources, candidateReceipts);
					observationPath = path.join(snapshotDir, "candidate-observation.json");
					await writeFileAtomic(observationPath, `${JSON.stringify(observation, null, 2)}\n`);
				}
				task.candidateObservation = { ...observation, observationPath };
				if (!artifacts.some(item => item.path === observationPath))
					artifacts.push({ path: observationPath, mediaType: "text", readCoverage: "recorded-not-reviewed" });
				for (const hostCheck of observation.checks) {
					const recorded = checks.find(check => check.criterion === hostCheck.criterion)!;
					if (hostCheck.result !== "passed") recorded.result = hostCheck.result;
					recorded.evidence = [...new Set([...recorded.evidence, observationPath, ...observation.sourceFiles, ...observation.receiptFiles])];
				}
				limitations.push(...observation.limitations);
				if (observation.stage === "verification-unavailable") failures.push("Host candidate verifier failed before producing a trustworthy observation");
				if ((task.candidate.intent ?? "solution") === "solution") {
					if (observation.sourceBinding !== "verified") failures.push("Host could not bind the platform result to the submitted candidate source");
					if (observation.correctness !== "passed") failures.push(`Host correctness is ${observation.correctness}; an observed negative remains evidence, not goal success`);
					for (const check of observation.goalChecks.filter(check => check.result === "failed"))
						failures.push(`Host observed that original goal criterion is not met by this candidate: ${check.criterion}`);
				}
			}
			if (task.executionLoop && "mode" in task.executionLoop && task.executionLoop.mode === "until-ready" && task.loopStopReason !== "ready") failures.push(`Bounded execution stopped without a ready handoff: ${task.loopStopReason ?? "unknown"}`);
			const accepted = checks.every((c) => c.result === "passed") && !failures.length && !unexecuted.length;
			task.status = accepted ? "accepted" : "rejected"; task.review = { at: nowIso(), frozenReportPath, checks, artifacts, failures, unexecuted, limitations, independentCheck: input.independentCheck };
			await save(ctx, goal); return task;
			});
		},

		async selectBranch(runId, input) {
			return withDispatch(runId, async () => {
			const goal = await load(ctx, runId); requireActive(goal);
			if (goal.tasks.some((item) => ["running", "unknown"].includes(item.status)) || goal.executionState?.operations.some((item) => ["prepared", "issued", "unknown"].includes(item.status))) throw new HarnessError("m07.branch", "active tasks or unresolved external operations must settle before branch selection");
			await requireCurrentFormalBaseline(ctx, goal);
			await verifyFrozenWorkflowMethod(ctx, goal, options.registeredExperienceStores);
			if (goal.knowledgeSnapshot && (await ctx.store.current())?.id !== goal.knowledgeSnapshot) throw new HarnessError("m07.branch", "knowledge snapshot changed since branch creation; refresh explicitly instead of selecting under changed authority");
			const parent = goal.tasks.find((item) => item.taskId === input.parentTaskId);
			if (!parent?.branchSource || parent.context) throw new HarnessError("m07.branch", "branch selection requires a frozen original task");
			if (!parent.review || !["accepted", "rejected"].includes(parent.status)) throw new HarnessError("m07.branch", "original task must receive ordinary M07 review before competitive selection");
			const candidates = goal.tasks.filter((item) => item.context?.parentRunId === runId && item.context.parentTaskId === parent.taskId && item.context.checkpointId === parent.branchSource!.checkpoint.id);
			if (!candidates.length || candidates.some((item) => !["accepted", "rejected", "failed"].includes(item.status))) throw new HarnessError("m07.branch", "every returned candidate must receive ordinary M07 review before selection; running candidates block selection");
			if (goal.branchSelections?.some((item) => item.parentTaskId === parent.taskId)) throw new HarnessError("m07.branch", "branch selection has already been frozen");
			if (input.selectedTaskId && !(input.selectedTaskId === parent.taskId && parent.status === "accepted") && !candidates.some((item) => item.taskId === input.selectedTaskId && item.status === "accepted")) throw new HarnessError("m07.branch", "selected source or branch must be an ordinarily reviewed and accepted candidate");
			const selected = [parent, ...candidates].find(item => item.taskId === input.selectedTaskId);
			if (selected?.candidate && (selected.candidateObservation?.sourceBinding !== "verified" || selected.candidateObservation.correctness !== "passed"))
				throw new HarnessError("m07.branch", "selected candidate lacks host-verified source binding and correctness");
			const rationale = nonempty(input.rationale, "branch selection rationale");
			const comparison = [parent, ...candidates].map((item) => ({ taskId: item.taskId, status: item.status, checks: item.review?.checks.map((check) => ({ criterion: check.criterion, result: check.result })) ?? [] }));
			goal.branchSelections = [...(goal.branchSelections ?? []), { version: 1, parentTaskId: parent.taskId, ...(input.selectedTaskId ? { selectedTaskId: input.selectedTaskId } : {}), rationale, selectedAt: nowIso(), candidates: comparison }];
			await save(ctx, goal); return goal;
			});
		},

		async decision(runId, input) {
			return withDispatch(runId, async () => {
			const goal = await load(ctx, runId); requireActive(goal);
			for (const id of input.relatedTaskIds) if (!goal.tasks.some((t) => t.taskId === id)) throw new HarnessError("m07.decision", `未知相关任务 ${id}`);
			if (input.action === "request") goal.decisions.push({ id: `U${String(goal.decisions.length + 1).padStart(3, "0")}`, status: "open", question: nonempty(input.question ?? "", "question"), relatedTaskIds: input.relatedTaskIds, requestedAt: nowIso() });
			else { const open = goal.decisions.find((d) => d.status === "open" && d.relatedTaskIds.join("|") === input.relatedTaskIds.join("|")); if (!open) throw new HarnessError("m07.decision", "没有匹配的待用户决定事项"); open.status = "resolved"; open.decision = nonempty(input.decision ?? "", "decision"); open.resolvedAt = nowIso(); }
			await save(ctx, goal); return goal;
			});
		},

		async finish(runId, input) {
			return withDispatch(runId, async () => {
			const goal = await load(ctx, runId); requireActive(goal);
			if (goal.executionContract?.mode === "continuous" && input.outcome !== "fulfilled") throw new HarnessError("m07.continuous", "continuous 目标不能由模型以 partial/blocked 或自述 stopReason 收口；只有原成功要求的 fulfilled 硬证据门或受信宿主中断可终结");
			let invalidBaseline: string | undefined;
			try { await requireCurrentFormalBaseline(ctx, goal); }
			catch (error) {
				if (input.outcome === "fulfilled") throw error;
				invalidBaseline = (error as Error).message;
				goal.formalBaseline = false;
				goal.exploratory = true;
			}
			if (goal.tasks.some((task) => task.status === "running")) throw new HarnessError("m07.finish", "存在状态未知的 running 任务；本版只能查看且不能结束目标、自动重跑或假称已停止");
			if (goal.tasks.some((task) => task.status === "unknown") || goal.executionState?.operations.some((operation) => ["prepared", "issued", "unknown"].includes(operation.status))) throw new HarnessError("m07.finish", "仍有外部动作或任务状态未知；先经宿主控制面对账，不能通过分支筛选隐藏未知结果");
			if (!goal.candidateVerification?.goalAdmission || input.outcome !== "fulfilled") {
				if (input.goalChecks.length !== goal.successCriteria.length || goal.successCriteria.some((criterion) => !input.goalChecks.some((c) => c.criterion === criterion))) throw new HarnessError("m07.finish", "必须逐项映射原目标 successCriteria，不能以子任务状态代替目标验收");
			}
			const chosenBranches = new Map((goal.branchSelections ?? []).map((selection) => [selection.parentTaskId, selection.selectedTaskId]));
			const branchParents = new Set(goal.tasks.flatMap((item) => item.context ? [item.context.parentTaskId] : []));
			if (input.outcome === "fulfilled" && [...branchParents].some((id) => !goal.branchSelections?.some((selection) => selection.parentTaskId === id))) throw new HarnessError("m07.finish", "competitive branches require an explicit selection or rejection of all branches before fulfilled");
			const byId = new Map(goal.tasks.map((item) => [item.taskId, item])); const superseded = new Set<string>();
			for (const accepted of goal.tasks.filter((item) => item.status === "accepted" && (!item.context || goal.branchSelections?.some((selection) => selection.parentTaskId === item.context?.parentTaskId && selection.selectedTaskId === item.taskId)))) { let prior = accepted.supersedesTaskId; while (prior && !superseded.has(prior)) { superseded.add(prior); prior = byId.get(prior)?.supersedesTaskId; } }
			for (const selection of goal.branchSelections ?? []) if (selection.selectedTaskId) for (const branch of goal.tasks.filter((item) => item.context?.parentTaskId === selection.parentTaskId && item.taskId !== selection.selectedTaskId)) superseded.add(branch.taskId);
			const effectiveTasks = goal.tasks.filter((item) => !superseded.has(item.taskId));
			const evidenceTasks = input.outcome === "fulfilled" ? effectiveTasks : goal.tasks;
			const acceptedTasks = evidenceTasks.filter((item) => item.status === "accepted" && (item.context ? chosenBranches.get(item.context.parentTaskId) === item.taskId : !chosenBranches.has(item.taskId) || chosenBranches.get(item.taskId) === item.taskId));
			const acceptedEvidence = new Map<string, string>(); for (const task of acceptedTasks) { if (task.reportPath && task.review) { const frozen = await realpath(task.review.frozenReportPath); acceptedEvidence.set(frozen, frozen); if (existsSync(task.reportPath)) acceptedEvidence.set(await realpath(task.reportPath), frozen); } for (const artifact of task.review?.artifacts ?? []) { const frozen = await realpath(artifact.path); acceptedEvidence.set(frozen, frozen); if (artifact.sourcePath && existsSync(artifact.sourcePath)) acceptedEvidence.set(await realpath(artifact.sourcePath), frozen); } for (const check of task.review?.checks ?? []) for (const evidence of check.evidence) { const frozen = await realpath(evidence); acceptedEvidence.set(frozen, frozen); } }
			let goalChecksInput: readonly TaskCheck[] = input.goalChecks;
			if (goal.candidateVerification && input.outcome === "fulfilled") {
				const verifier = requireCandidateVerifier(options.candidateVerifier, goal.candidateVerification);
				const continuousCandidateGoal = goal.executionContract?.mode === "continuous";
				if (!acceptedTasks.some(task => (
					(task.candidate && task.candidateObservation?.sourceBinding === "verified" && task.candidateObservation.correctness === "passed") ||
					task.episode?.candidates.some(candidate => candidate.observation.sourceBinding === "verified" && candidate.observation.correctness === "passed")
				)))
					throw new HarnessError("m07.goal-verifier", "no accepted candidate has host-verified source and correctness");
				if ((goal.candidateVerification.goalAdmission || continuousCandidateGoal) && !verifier.verifyGoal)
					throw new HarnessError("m07.goal-verifier", "continuous candidate goal fulfillment requires independent host verification of an original success criterion");
				if (verifier.verifyGoal) {
					const result = await verifier.verifyGoal({ goal: structuredClone(goal), acceptedEvidencePaths: [...new Set(acceptedEvidence.values())] });
					if (!result || !Array.isArray(result.checks) || !Array.isArray(result.limitations) ||
						(goal.candidateVerification.goalAdmission && result.checks.length !== goal.successCriteria.length) ||
						(continuousCandidateGoal && (!result.checks.length || result.checks.some(check => !Array.isArray(check.evidence) || !check.evidence.length))) ||
						new Set(result.checks.map(check => check.criterion)).size !== result.checks.length ||
						result.checks.some(check => !goal.successCriteria.includes(check.criterion) || !["passed", "failed", "not_run"].includes(check.result) || !Array.isArray(check.evidence)) ||
						result.limitations.some(item => typeof item !== "string"))
						throw new HarnessError("m07.goal-verifier", "host goal verification omitted or altered original criteria");
					const unmet = result.checks.filter(check => check.result !== "passed");
					if (unmet.length) throw new HarnessError("m07.goal-verifier",
						`fulfilled 被宿主核验拒绝：${unmet.map(check => `${check.criterion}: ${check.result}`).join("；")}。${result.limitations.join("；")}`);
					// A receipt adapter can decide objective criteria without claiming authority
					// over unrelated scientific adoption. Its findings always override self-report.
					goalChecksInput = goal.successCriteria.map(criterion => {
						const check = result.checks.find(item => item.criterion === criterion) ??
							goalChecksInput.find(item => item.criterion === criterion)!;
						return { criterion, result: check.result, evidence: [...check.evidence] };
					});
					goal.limitations.push(...result.limitations);
				}
			}
			const canonicalGoalChecks: TaskCheck[] = []; for (const check of goalChecksInput) { const evidence: string[] = []; for (const item of check.evidence) { const resolved = await confinedExistingFile(ctx, item); const frozen = acceptedEvidence.get(resolved); if (input.outcome === "fulfilled" && !frozen) throw new HarnessError("m07.finish", `目标验收证据不来自当前有效且已接受任务：${item}`); if (frozen && resolved !== frozen && !(await readFile(resolved)).equals(await readFile(frozen))) throw new HarnessError("m07.finish", `已接受成果在验收后发生变化：${item}`); evidence.push(frozen ?? resolved); } canonicalGoalChecks.push({ ...check, evidence }); }
			if (input.outcome === "fulfilled") {
				if (canonicalGoalChecks.some((c) => c.result !== "passed" || !c.evidence.length)) throw new HarnessError("m07.finish", "fulfilled 要求每项原目标成功标准均通过并有实际文件证据");
				if (goal.decisions.some((d) => d.status === "open")) throw new HarnessError("m07.finish", "存在待用户决定事项，不能标记 fulfilled");
				// Settled failed/rejected attempts remain negative history, not new goal criteria.
				// A returned task still needs ordinary review before goal closure.
				if (effectiveTasks.some(t => t.status === "returned")) throw new HarnessError("m07.finish", "存在尚未审查的 returned 任务，不能标记 fulfilled");
				if (!goal.tasks.length) throw new HarnessError("m07.finish", "没有实际任务，不能标记 fulfilled");
			}
			goal.goalChecks = canonicalGoalChecks;
			goal.lifecycle = "finished"; goal.outcome = input.outcome; goal.finishSummary = nonempty(input.summary, "summary"); goal.returnPath = input.returnPath; goal.limitations.push(...(input.limitations ?? []));
			if (invalidBaseline) goal.limitations.push(`原正式基线已失效：${invalidBaseline}；本次仅如实记录 ${input.outcome} 并回流，不表示原目标完成。`);
			try {
				goal.feedbackPath = await writeFeedback(ctx, goal, frozenPolicy(goal), snapshotLimits);
				goal.feedbackStatus = "complete";
				delete goal.feedbackError;
			} catch (error) {
				if (!isFeedbackControlOverflow(error)) throw error;
				goal.feedbackError = { code: "context.budget", summary: (error as Error).message.slice(0, 500) };
				goal.feedbackPath = await writeBoundedFeedbackIndex(ctx, goal, "finish");
				goal.feedbackStatus = "indexed";
			}
			await save(ctx, goal);
			const run = await ctx.ws.readRun("M07", runId); run.outputs.push({ label: "M07 实际执行反馈包", path: goal.feedbackPath }); run.remarks.push(`目标结果 ${input.outcome}；主 Agent 选择返回 ${input.returnPath}。会话返回不等于科学验收。反馈状态 ${goal.feedbackStatus}；索引不代表 M04 已读取原证据。`); for (const t of goal.tasks) { if (t.session && !run.sessions.some((session) => session.id === t.session!.id)) run.sessions.push({ label: t.session.label, role: t.session.role, id: t.session.id, file: t.session.file, model: t.session.model }); if (t.executionFailure) run.failures.push(`${t.taskId} 执行失败：${t.executionFailure}`); if (t.review) { for (const f of t.review.failures) run.failures.push(`${t.taskId}：${f}`); for (const u of t.review.unexecuted) run.failures.push(`${t.taskId} 未执行：${u}`); } } await ctx.ws.finishRun(run, input.outcome === "blocked" ? "failed" : "completed"); await ctx.ws.writeNote(run, `M07 主 Agent 目标式执行；保留原目标、所有任务、失败、未执行和限制。最终选择返回 ${input.returnPath}。`);
			return goal;
			});
		},

		async interrupt(runId, input: InterruptInput, authorization?: typeof HOST_STOP_KEY, hostReceipt?: HostStopReceipt) {
			return withDispatch(runId, async () => {
			const goal = await load(ctx, runId); requireActive(goal);
			if (goal.executionContract?.mode === "continuous" && (authorization !== HOST_STOP_KEY || hostReceipt?.goalRunId !== runId)) throw new HarnessError("m07.continuous", "continuous 目标不接受模型或外部 JSON 的 interrupt；仅受信宿主生命周期事件可归档");
			if (authorization === HOST_STOP_KEY && hostReceipt?.goalRunId === runId) goal.hostStopReceipt = hostReceipt;
			const reason = nonempty(input.reason, "reason");
			const at = nowIso();
			const interrupted: string[] = [];
			for (const task of goal.tasks) {
				if (task.status !== "running") continue;
				task.status = "failed";
				task.returnedAt = at;
				task.executionFailure = `受控中断归档：${reason}`;
				interrupted.push(task.taskId);
			}
			goal.lifecycle = "finished";
			goal.outcome = "blocked";
			goal.finishSummary = `目标在受控中断后归档为 blocked；原因：${reason}`;
			goal.returnPath = input.returnPath ?? "user";
			goal.limitations.push(`受控中断归档：${reason}`);
			goal.goalChecks = goal.successCriteria.map((criterion) => ({ criterion, result: "not_run" as const, evidence: [] }));
			const legacy = !goal.budgetPolicy || !goal.budgetPolicyVersionId || !goal.budgetPolicyFrozenAt;
			if (legacy) goal.limitations.push("旧目标缺少冻结预算策略；中断反馈只登记控制事实与证据位置，未读取证据正文，也未套用当前 active policy。");
			goal.feedbackStatus = "pending";
			goal.feedbackError = { code: "m07.archive-pending", summary: "中断终态已记录，反馈尚未完成；若此状态持续则需要修复交接。" };
			const run = await ctx.ws.readRun("M07", runId);
			for (const id of interrupted) run.failures.push(`${id} 执行失败：受控中断归档：${reason}`);
			run.remarks.push(`目标受控中断归档为 blocked；返回 ${goal.returnPath}。只记录实际中断事实，不自动重跑或假称完成。`);
			try {
				await save(ctx, goal);
				await ctx.ws.finishRun(run, "failed");
			} catch (error) {
				throw new HarnessError("m07.archive-repair-required", `M07 ${runId} 终态写入未完成；检查 goal.json 与 run.json 后修复，不得只关闭其中一方：${(error as Error).message}`);
			}
			let feedbackFailure: unknown;
			try {
				if (legacy) {
					goal.feedbackPath = await writeLegacyInterruptFeedback(ctx, goal);
					goal.feedbackStatus = "control-facts-only";
					goal.feedbackError = { code: "m07.policy-legacy", summary: "旧目标没有冻结策略；仅归档控制事实和证据位置。" };
				} else {
					goal.feedbackPath = await writeFeedback(ctx, goal, frozenPolicy(goal), snapshotLimits);
					goal.feedbackStatus = "complete";
					delete goal.feedbackError;
				}
			} catch (error) {
				feedbackFailure = error;
				goal.feedbackError = { code: error instanceof HarnessError ? error.code : "m07.feedback-write", summary: (error as Error).message.slice(0, 500) };
				goal.limitations.push("完整反馈生成失败；原控制记录及冻结证据未删除。中断控制事实仅提供证据位置，不表示完整交接或科学验收。");
				try {
					goal.feedbackPath = await writeBoundedFeedbackIndex(ctx, goal, "interrupt");
					goal.feedbackStatus = "control-facts-only";
				} catch (fallbackError) {
					delete goal.feedbackPath;
					goal.feedbackStatus = "failed";
					goal.feedbackError = { code: "m07.archive-repair-required", summary: `完整反馈：${goal.feedbackError.code}；控制事实索引：${fallbackError instanceof HarnessError ? fallbackError.code : "write-failed"}。需按 goal.json 修复交接。` };
				}
			}
			try {
				await save(ctx, goal);
				if (goal.feedbackPath) run.outputs.push({ label: "M07 实际执行反馈包", path: goal.feedbackPath });
				if (feedbackFailure) run.failures.push(`反馈生成失败（${goal.feedbackError?.code ?? "unknown"}）；${goal.feedbackStatus === "control-facts-only" ? "仅有界控制事实可供 M04 读取，原证据须另行核查" : "无反馈包，交接需修复"}`);
				run.remarks.push(`反馈归档状态：${goal.feedbackStatus}；${goal.feedbackStatus === "complete" ? "已生成冻结策略下的完整反馈包" : "未完成科学证据交接"}。`);
				await ctx.ws.writeRun(run);
			} catch (error) {
				throw new HarnessError("m07.archive-repair-required", `M07 ${runId} 反馈归档状态写入未完成；检查 goal.json 与 run.json 后修复：${(error as Error).message}`);
			}
			await ctx.ws.writeNote(run, `M07 目标受控中断归档；running 任务 ${interrupted.join("、") || "无"} 记为 failed；原因：${reason}。`);
			return goal;
			});
		},
		async hostInterrupt(runId, input) {
			if (!HOST_STOP_REASONS.has(input.reasonKind)) throw new HarnessError("m07.host-stop", "未知宿主停止事件");
			if (input.sourceEventId !== undefined && (typeof input.sourceEventId !== "string" || input.sourceEventId.length > 128 || !/^[A-Za-z0-9._:-]+$/.test(input.sourceEventId))) throw new HarnessError("m07.host-stop", "宿主事件 ID 无效");
			const receipt: HostStopReceipt = { version: 1, id: randomUUID(), goalRunId: runId, source: "pi-host", reasonKind: input.reasonKind, observedAt: nowIso(), ...(input.sourceEventId ? { sourceEventId: input.sourceEventId } : {}) };
			const interruptWithAuthority = this.interrupt as (goalRunId: string, request: InterruptInput, key: typeof HOST_STOP_KEY, witness: HostStopReceipt) => Promise<CurrentGoal>;
			return interruptWithAuthority(runId, { reason: `受信宿主生命周期停止：${input.reasonKind}`, returnPath: "user" }, HOST_STOP_KEY, receipt);
		},
		async hostSuspend(runId, input) {
			return withDispatch(runId, async () => {
			if (!HOST_STOP_REASONS.has(input.reasonKind)) throw new HarnessError("m07.host-stop", "未知宿主停止事件");
			if (input.sourceEventId !== undefined && (typeof input.sourceEventId !== "string" || input.sourceEventId.length > 128 || !/^[A-Za-z0-9._:-]+$/.test(input.sourceEventId))) throw new HarnessError("m07.host-stop", "宿主事件 ID 无效");
			const goal = await load(ctx, runId); requireActive(goal);
			const state = goal.executionState;
			if (!state) throw new HarnessError("m07.recovery", "旧目标缺少执行尝试状态；保留旧归档语义，不自动迁移");
			const attempt = state.attempts.find((item) => item.id === state.activeAttemptId);
			if (!attempt || attempt.state !== "running") throw new HarnessError("m07.recovery", "当前执行尝试不是运行态");
			const receipt: HostStopReceipt = { version: 1, id: randomUUID(), goalRunId: runId, source: "pi-host", reasonKind: input.reasonKind, observedAt: nowIso(), ...(input.sourceEventId ? { sourceEventId: input.sourceEventId } : {}) };
			for (const task of goal.tasks) {
				if (task.status !== "running") continue;
			task.status = task.mode === "execute" ? "unknown" : "failed";
				task.executionFailure = `宿主停止时任务结果未确认：${input.reasonKind}；不得自动重放`;
				task.returnedAt = receipt.observedAt;
				const operation = state.operations.find((item) => item.taskId === task.taskId && ["prepared", "issued"].includes(item.status));
				if (operation) operation.status = operation.status === "issued" ? "unknown" : "not-issued";
			}
			attempt.endedAt = receipt.observedAt;
			attempt.stopReceipt = receipt;
			attempt.state = state.operations.some((item) => item.status === "unknown") || goal.tasks.some((item) => item.status === "unknown") ? "recovery-required" : "suspended";
			const controlDir = path.join(ctx.ws.runDir("M07", runId), "control-checkpoints");
			const controlPath = path.join(controlDir, `${attempt.id}.json`);
			await writeFileAtomic(controlPath, `${JSON.stringify({ version: 1, goalRunId: runId, attemptId: attempt.id, state: attempt.state, goalStatePath: statePath(ctx, runId), taskIds: goal.tasks.map((item) => item.taskId), unresolvedOperationIds: state.operations.filter((item) => item.status === "unknown").map((item) => item.id), knowledgeSnapshot: goal.knowledgeSnapshot, at: receipt.observedAt }, null, 2)}\n`);
			attempt.controlCheckpointPath = controlPath;
			await save(ctx, goal);
			const run = await ctx.ws.readRun("M07", runId);
			run.remarks.push(`执行尝试 ${attempt.id} 因 ${input.reasonKind} ${attempt.state}；目标仍 active，原成功要求未变。控制 checkpoint 是恢复索引，不是 M04 科学验收。`);
			await ctx.ws.writeRun(run);
			return goal;
			});
		},
		async hostRecover(runId, input) {
			// Recovery deliberately does not take over a possibly stale dispatch lock:
			// it proves the old process dead, atomically claims a new attempt, and
			// leaves any residual dispatch lock for exact manual review before work.
			const goal = await load(ctx, runId);
			if (goal.lifecycle !== "active" || !goal.executionState) throw new HarnessError("m07.recovery", "只恢复有版本化 executionState 的 active 目标；旧终态须显式建立 successor");
			const state = goal.executionState;
			const prior = state.attempts.find((item) => item.id === state.activeAttemptId);
			if (!prior || prior.id !== input.expectedAttemptId) throw new HarnessError("m07.recovery", "恢复所指定的旧 attempt 与持久状态不匹配");
			const nextId = nextAttemptId(goal);
			const descriptor = validateRecoveryDescriptor(goal, input.runDescriptor, nextId);
			await verifyDescriptorLoadedSource(descriptor, import.meta.url);
			if (descriptor.instanceId === prior.runDescriptor.instanceId || sameProcess(descriptor.process, prior.runDescriptor.process)) throw new HarnessError("m07.recovery", "恢复必须使用新的独立 Pi 进程与实例身份");
			const newProbe = await (options.probeProcess ?? probeProcessIdentity)(descriptor.process);
			if (newProbe.status !== "alive" || !newProbe.identityMatch) throw new HarnessError("m07.recovery", "新 Pi 进程身份不可验证，拒绝恢复");
			const oldProbe = await (options.probeProcess ?? probeProcessIdentity)(prior.runDescriptor.process);
			// A verified new boot on the same host proves the old process is dead.
			// The identity probe also rejects remote hosts and reused live PIDs.
			if (oldProbe.status !== "dead" || prior.runDescriptor.process.hostId !== descriptor.process.hostId) throw new HarnessError("m07.recovery", "旧 attempt 的进程仍存活或身份未知，拒绝并行恢复");
			if (prior.state === "running") {
				prior.state = "recovery-required";
				prior.endedAt = nowIso();
				for (const task of goal.tasks.filter((item) => item.status === "running")) {
					task.status = task.mode === "execute" ? "unknown" : "failed";
					task.executionFailure = "旧进程已死，任务响应及外部副作用待对账；不得自动重放";
					task.returnedAt = nowIso();
					const operation = state.operations.find((item) => item.taskId === task.taskId && ["issued", "prepared"].includes(item.status));
					if (operation) operation.status = operation.status === "issued" ? "unknown" : "not-issued";
				}
				const controlPath = path.join(ctx.ws.runDir("M07", runId), "control-checkpoints", `${prior.id}.json`);
				await writeFileAtomic(controlPath, `${JSON.stringify({ version: 1, goalRunId: runId, attemptId: prior.id, state: prior.state, goalStatePath: statePath(ctx, runId), taskIds: goal.tasks.map((item) => item.taskId), unresolvedOperationIds: state.operations.filter((item) => item.status === "unknown").map((item) => item.id), knowledgeSnapshot: goal.knowledgeSnapshot, at: prior.endedAt }, null, 2)}\n`);
				prior.controlCheckpointPath = controlPath;
			} else if (!['suspended', 'recovery-required'].includes(prior.state)) throw new HarnessError("m07.recovery", "旧 attempt 不能恢复");
			frozenPolicy(goal);
			await verifyFrozenWorkflowMethod(ctx, goal, options.registeredExperienceStores);
			// Recovery only binds a fresh host to the unchanged goal. A later M04 merge
			// must remain available for an explicit plan(refreshBaseline) in that host;
			// normal delegation still checks the current formal baseline.
			const claimsDir = path.join(ctx.ws.runDir("M07", runId), "attempt-claims");
			await mkdir(claimsDir, { recursive: true });
			try { await mkdir(path.join(claimsDir, nextId)); }
			catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new HarnessError("m07.recovery", `执行尝试 ${nextId} 已被另一恢复者占用；核对 goal.json 和 claim 后处理`); throw error; }
			state.attempts.push({ version: 1, id: nextId, state: "running", startedAt: nowIso(), runDescriptor: descriptor });
			state.activeAttemptId = nextId;
			await save(ctx, goal);
			const run = await ctx.ws.readRun("M07", runId);
			run.remarks.push(`新执行尝试 ${nextId} 已在新 Pi 身份启动；旧会话未 resume。未知副作用仍阻断 execute 委派。`);
			await ctx.ws.writeRun(run);
			return goal;
		},
		async hostReconcileOperation(runId, input) {
			return withDispatch(runId, async () => {
			const goal = await load(ctx, runId);
			if (goal.lifecycle !== "active" || !goal.executionState) throw new HarnessError("m07.operation", "目标无可对账的执行状态");
			const operation = goal.executionState.operations.find((item) => item.id === input.operationId);
			if (!operation) throw new HarnessError("m07.operation", "操作不存在或已完成对账");
			const task = goal.tasks.find((item) => item.taskId === operation.taskId);
			const journalInput = { journalDir: path.join(ctx.ws.runDir("M07", runId), "tasks", operation.taskId, "candidate-runs"),
				goalRunId: runId, taskId: operation.taskId, operationId: operation.id, backend: options.candidateExecutionBackend };
			const pendingBefore = await pendingCandidateExecutions(journalInput);
			if (operation.status !== "unknown" && !(operation.status === "confirmed" && pendingBefore.length))
				throw new HarnessError("m07.operation", "操作不存在或已完成对账");
			const source = await confinedExistingFile(ctx, input.evidencePath);
			const bytes = await readFile(source);
			if (bytes.length > 64 * 1024) throw new HarnessError("m07.operation", "对账回执超过 64 KiB");
			let evidence: { version?: unknown; operationId?: unknown; observationMethod?: unknown; observedStatus?: unknown; observedAt?: unknown; externalId?: unknown };
			try { evidence = JSON.parse(bytes.toString("utf8")); }
			catch { throw new HarnessError("m07.operation", "对账证据必须是可读取的结构化 JSON 回执"); }
			if (evidence.version !== 1 || evidence.operationId !== operation.id || evidence.observationMethod !== "external-query" || !["confirmed", "not-issued", "unknown"].includes(String(evidence.observedStatus)) || typeof evidence.observedAt !== "string" || !evidence.observedAt.trim() || (evidence.observedStatus === "confirmed" && (typeof evidence.externalId !== "string" || !evidence.externalId.trim()))) throw new HarnessError("m07.operation", "对账回执须含匹配 operationId、外部查询方法、明确状态及观察时间；确认执行还需远端 ID");
			const frozen = path.join(ctx.ws.runDir("M07", runId), "operation-receipts", `${operation.id}-${randomUUID()}.json`);
			await writeFileAtomic(frozen, bytes.toString("utf8"));
			operation.evidencePath = frozen;
			operation.observationMethod = "external-query";
			if (typeof evidence.externalId === "string") operation.externalId = evidence.externalId;
			if (task?.episode && options.candidateExecutionBackend && pendingBefore.some(item => item.queryAvailable)) {
				const verifier = requireCandidateVerifier(options.candidateVerifier, goal.candidateVerification);
				const evaluationTool = createCandidateEpisodeTool({ goal, task, verifier, store: ctx.store,
					priorRoot: path.join(ctx.ws.knowledgeDir, "prior"), save: () => save(ctx, goal) });
				const recoveryTools = createCandidateExecutionTools({ ...journalInput, workDir: task.workDir,
					subjectId: task.subjectId, backend: options.candidateExecutionBackend, queryOnly: true,
					evaluate: args => evaluationTool.execute(args) });
				const queried = new Set<string>();
				for (const pending of pendingBefore) {
					const key = `${pending.resume.tool}/${pending.resume.runId}`;
					if (!pending.queryAvailable || queried.has(key)) continue;
					queried.add(key);
					await recoveryTools.find(tool => tool.name === pending.resume.tool)!.execute(pending.resume, ctx.signal);
				}
			}
			if ((await pendingCandidateExecutions(journalInput)).length || evidence.observedStatus === "unknown") {
				operation.status = "unknown"; delete operation.resolvedAt;
				await save(ctx, goal); return goal;
			}
			operation.status = evidence.observedStatus as "confirmed" | "not-issued";
			operation.resolvedAt = nowIso();
			if (task?.status === "unknown") { task.status = "failed"; task.executionFailure = `原响应丢失，外部查询结果 ${operation.status}；证据 ${frozen}。任务未自动重放或采用。`; }
			await save(ctx, goal);
			return goal;
			});
		},
		async hostCreateSuccessor(runId, input) {
			return withDispatch(runId, async () => {
			const prior = await load(ctx, runId);
			if (prior.lifecycle !== "finished" || prior.outcome !== "blocked") throw new HarnessError("m07.successor", "仅旧 blocked 终态可显式建立关联后继；原记录保持只读");
			frozenPolicy(prior);
			await verifyFrozenWorkflowMethod(ctx, prior, options.registeredExperienceStores);
			if (prior.knowledgeSnapshot !== (await ctx.store.current())?.id) throw new HarnessError("m07.successor", "原知识快照已不可作为当前基线；先对账，不得悄套新 K");
			await requireCurrentFormalBaseline(ctx, prior);
			const descriptor = parseRunDescriptor(input.runDescriptor);
			await verifyDescriptorLoadedSource(descriptor, import.meta.url);
			const probe = await (options.probeProcess ?? probeProcessIdentity)(descriptor.process);
			if (probe.status !== "alive" || !probe.identityMatch) throw new HarnessError("m07.successor", "新进程身份不可验证");
			if (prior.executionState?.operations.some((item) => item.status === "unknown")) throw new HarnessError("m07.successor", "旧目标有未对账外部动作；先查询确认，不得建立可执行后继");
			try { await mkdir(path.join(ctx.ws.runDir("M07", runId), "successor.claim")); }
			catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new HarnessError("m07.successor", "此旧目标已有后继建立声明；核对原目标和后继运行，不能重复迁移"); throw error; }
			const problem = await readFile(prior.problemSnapshotPath, "utf8");
			const run = await ctx.ws.startRun("M07", [{ label: "原目标冻结问题", path: prior.problemSnapshotPath }], prior.knowledgeSnapshot);
			const frozen = path.join(ctx.ws.runDir("M07", run.runId), "problem-snapshot.md");
			await writeFileAtomic(frozen, problem);
			const newDescriptor: RunDescriptorV1 = { ...descriptor, attemptId: "A001", goalRunId: run.runId, workspaceId: await ctx.store.storeId(), controlDir: ctx.ws.runDir("M07", run.runId) };
			const successor: CurrentGoal = { version: 1, runId: run.runId, lifecycle: "active", startedAt: run.startedAt, updatedAt: run.startedAt, goal: prior.goal, problemRelation: prior.problemRelation, constraints: [...prior.constraints], successCriteria: [...prior.successCriteria], plan: prior.plan, exploratory: prior.exploratory, formalBaseline: prior.formalBaseline, problemSnapshotPath: frozen, knowledgeSnapshot: prior.knowledgeSnapshot, m04BaselineRunId: prior.m04BaselineRunId, checkpointRawScope: prior.checkpointRawScope ?? "workspace", baselineHistory: structuredClone(prior.baselineHistory), ...(prior.m04BaselineFailures ? { m04BaselineFailures: structuredClone(prior.m04BaselineFailures) } : {}), budgetPolicy: structuredClone(prior.budgetPolicy), budgetPolicyVersionId: prior.budgetPolicyVersionId, budgetPolicyFrozenAt: prior.budgetPolicyFrozenAt, methodBinding: prior.methodBinding ? structuredClone(prior.methodBinding) : undefined, workflowMethod: prior.workflowMethod ? structuredClone(prior.workflowMethod) : undefined, executionContract: prior.executionContract ? structuredClone(prior.executionContract) : undefined, predecessorGoalRunId: prior.runId, executionState: { version: 1, activeAttemptId: "A001", attempts: [{ version: 1, id: "A001", state: "running", startedAt: run.startedAt, runDescriptor: newDescriptor }], operations: [] }, tasks: [], decisions: structuredClone(prior.decisions), limitations: [`继承旧目标 ${prior.runId} 的冻结义务、K、策略和方法；旧任务及证据仍在原记录，须重新检查后采用。`] };
			if (prior.constraintAdditions) successor.constraintAdditions = structuredClone(prior.constraintAdditions);
			await save(ctx, successor);
			run.remarks.push(`显式 successor of ${prior.runId}；旧 blocked goal.json 未修改。新目标保留原成功标准和冻结策略。`);
			await ctx.ws.writeRun(run);
			return successor;
			});
		},
	};
}

export type { M07Controller } from "./types.ts";
