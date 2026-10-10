/** Trusted Actions parent for a private campaign. The child never inherits the
 * artifact runtime credentials or Actions file-command paths. */
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as fsConstants, openSync, closeSync, writeFileSync, writeSync } from "node:fs";
import { mkdir, open, rmdir, statfs, unlink, writeFile } from "node:fs/promises";
import { constants as osConstants } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { TextDecoder } from "node:util";
import { PUBLIC_HEARTBEAT_LINE } from "./private-campaign-heartbeat.ts";
import { createLiveControlFrameReader, type LiveControlFrameSource,
	type LiveControlFrameStatusV1 } from
	"../src/runner/live-control-frame.ts";
import { INCREMENTAL_CHECKPOINT_FILE, openIncrementalControlPrefix } from
	"../src/runner/incremental-private-checkpoint.ts";
import { CARRY_LOGICAL_BYTES } from "../src/runner/carry-sidecar-codec.ts";
import { authenticateSignedMissionSeed } from "../src/runner/signed-mission-ledger.ts";
import { MISSION_REPOSITORY } from "../src/runner/signed-mission-ledger.ts";
import { ARTIFACT_PARTITION_MANIFEST_FILE, ARTIFACT_PARTITION_PAYLOAD_BYTES,
	finalizePartitionManifest, partitionEncryptedFiles, sealPartitionManifest,
	MAX_ARTIFACT_PARTITION_CHUNKS } from
	"../src/runner/private-artifact-partition.ts";

export const PROGRESS_FRAME_MAX_BYTES = 4096;
export const PROGRESS_ARTIFACT_ATTEMPT_LIMIT = 500 - (MAX_ARTIFACT_PARTITION_CHUNKS + 2);
// Reserve one RSA outcome, at most sixteen final carry parts, and its root.
export const PREFIX_PUBLICATION_INTERVAL_MS = 15 * 60 * 1000; // Observation cadence, never a research limit.
export const PREFIX_LOCAL_FREE_RESERVE_BYTES = 2n * 1024n * 1024n * 1024n;
const GITHUB_HOSTED_JOB_WINDOW_MS = 6 * 60 * 60 * 1000;
const PREFIX_MAX_GROUP_ARTIFACTS =
	Math.ceil(CARRY_LOGICAL_BYTES / ARTIFACT_PARTITION_PAYLOAD_BYTES) + 1;
export const PREFIX_RESERVED_ATTEMPTS =
	(Math.ceil(GITHUB_HOSTED_JOB_WINDOW_MS / PREFIX_PUBLICATION_INTERVAL_MS) + 1) *
	PREFIX_MAX_GROUP_ARTIFACTS;
const CHILD_ENV_KEYS = [
	"PATH", "HOME", "TMPDIR", "LANG", "GITHUB_ACTIONS", "GITHUB_ACTOR",
	"GITHUB_EVENT_NAME", "GITHUB_REF", "GITHUB_REPOSITORY", "GITHUB_RUN_ID",
	"GITHUB_RUN_ATTEMPT", "GITHUB_SHA", "GITHUB_TOKEN", "DEEPSEEK_API_KEY",
	"MULPIS_MISSION_LEDGER_B64", "MULPIS_MANUAL_AUTHORIZED",
	"MULPIS_RUN_REQUEST_BEFORE",
] as const;

export function privateCampaignChildEnv(parent: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const child: NodeJS.ProcessEnv = {};
	for (const key of CHILD_ENV_KEYS) if (parent[key] !== undefined) child[key] = parent[key];
	child.MULPIS_ACTIONS_PUBLIC_HEARTBEAT_FD = "3";
	child.MULPIS_ACTIONS_PRIVATE_PROGRESS_FD = "4";
	return child;
}

type ArtifactClient = {
	uploadArtifact(name: string, files: string[], rootDirectory: string,
		options: { retentionDays: number }): Promise<unknown>;
};
type ObserverTimer = { unref: () => void; clear: () => void };
function observerTimer(callback: () => void, delayMs: number): ObserverTimer {
	const timer = setTimeout(callback, delayMs);
	return { unref: () => { timer.unref(); }, clear: () => { clearTimeout(timer); } };
}
export type ProgressUploaderOptions = {
	directory: string;
	runId: string;
	runAttempt: string;
	client?: () => Promise<ArtifactClient>;
	maxAttempts?: number;
	prefix?: Readonly<{ outputDir: string; publicKeyFile: string;
		seedEnvelopeB64: string | undefined; expectedSpkiSha256?: string;
		/** Synthetic clock and shorter cadence overrides for offline tests only. */
		now?: () => number; intervalMs?: number;
		scheduleTimer?: (callback: () => void, delayMs: number) => ObserverTimer;
		availableBytes?: (directory: string) => Promise<bigint> }>;
};

export type CommittedPrefixObservation = Readonly<{
	source: LiveControlFrameSource; sequence: number; status: LiveControlFrameStatusV1;
}>;

async function actionsArtifactClient(): Promise<ArtifactClient> {
	// Dynamic and lazy: no artifact package is required for offline checks.
	const packageName = "@actions/artifact";
	const toolkit = await import(packageName) as { DefaultArtifactClient: new () => ArtifactClient };
	return new toolkit.DefaultArtifactClient();
}

async function filesystemAvailableBytes(directory: string): Promise<bigint> {
	const info = await statfs(directory, { bigint: true });
	return info.bavail * info.bsize;
}

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function uploadedPartIdentity(value: unknown): Readonly<{
	artifactId: string; archiveSha256: string;
}> | undefined {
	if (!record(value) || !Number.isSafeInteger(value.id) || Number(value.id) < 1 ||
		typeof value.digest !== "string") return undefined;
	const digest = value.digest.startsWith("sha256:") ? value.digest.slice(7) : value.digest;
	if (!/^[0-9a-f]{64}$/.test(digest) ||
		value.digest !== digest && value.digest !== `sha256:${digest}`) return undefined;
	return { artifactId: String(value.id), archiveSha256: digest };
}
function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
	return Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}
function canonicalBase64(value: unknown, bytes?: number): value is string {
	if (typeof value !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value))
		return false;
	const decoded = Buffer.from(value, "base64");
	return decoded.toString("base64") === value && (bytes === undefined || decoded.length === bytes);
}

/** Read one committed inode. The driver publishes by rename, so a concurrent
 * replacement cannot turn this snapshot into a mixture of two checkpoints. */
async function readAuthenticatedPrefixInode(input: Readonly<{
	outputDir: string; source: LiveControlFrameSource;
	authenticatedMissionKey: Buffer; expectedSha256?: string;
}>): Promise<Readonly<{ bytes: Buffer; sha256: string;
	opened: ReturnType<typeof openIncrementalControlPrefix> }>> {
	const handle = await open(path.join(input.outputDir, INCREMENTAL_CHECKPOINT_FILE),
		fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
	try {
		const stat = await handle.stat();
		if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0 ||
			stat.size < 1 || stat.size > CARRY_LOGICAL_BYTES)
			throw new Error("committed prefix file is unsafe");
		const bytes = Buffer.alloc(stat.size);
		let position = 0;
		while (position < bytes.length) {
			const result = await handle.read(bytes, position, bytes.length - position, position);
			if (result.bytesRead <= 0) throw new Error("committed prefix changed during read");
			position += result.bytesRead;
		}
		if ((await handle.stat()).size !== stat.size)
			throw new Error("committed prefix changed during read");
		const sha256 = createHash("sha256").update(bytes).digest("hex");
		if (input.expectedSha256 && sha256 !== input.expectedSha256)
			throw new Error("committed prefix does not match the authenticated frame");
		const raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		const opened = openIncrementalControlPrefix(raw, input.authenticatedMissionKey, input.source);
		return { bytes, sha256, opened };
	} finally { await handle.close(); }
}

/** The first publication must match its authenticated FD4 frame exactly. */
export async function readAuthenticatedCommittedPrefix(input: Readonly<{
	outputDir: string; source: LiveControlFrameSource; sequence: number;
	checkpointSha256: string; event: LiveControlFrameStatusV1["committedCheckpointBoundary"];
	authenticatedMissionKey: Buffer;
}>): Promise<Buffer> {
	const result = await readAuthenticatedPrefixInode({ outputDir: input.outputDir,
		source: input.source, authenticatedMissionKey: input.authenticatedMissionKey,
		expectedSha256: input.checkpointSha256 });
	if (result.opened.sequence !== input.sequence || result.opened.event !== input.event)
		throw new Error("committed prefix sequence or boundary differs from the frame");
	return result.bytes;
}

/** Later polls authenticate the newest complete local prefix independently of
 * FD4 sampling, which may coalesce semantically unchanged journal commits. */
export async function readLatestAuthenticatedCommittedPrefix(input: Readonly<{
	outputDir: string; source: LiveControlFrameSource; authenticatedMissionKey: Buffer;
}>): Promise<Readonly<{ bytes: Buffer; sha256: string; sequence: number;
	event: ReturnType<typeof openIncrementalControlPrefix>["event"] }>> {
	const result = await readAuthenticatedPrefixInode(input);
	return { bytes: result.bytes, sha256: result.sha256,
		sequence: result.opened.sequence, event: result.opened.event };
}

/** Checks framing and source binding only. The parent gate authenticates AEAD
 * before upload; a later reader independently authenticates the artifact. */
export function parsePrivateProgressFrame(line: string, expected: NodeJS.ProcessEnv): number | undefined {
	if (Buffer.byteLength(line, "utf8") > PROGRESS_FRAME_MAX_BYTES) return undefined;
	let frame: unknown;
	try { frame = JSON.parse(line); } catch { return undefined; }
	if (!record(frame) || !exactKeys(frame, ["version", "format", "source", "sequence", "nonceB64", "ciphertextB64", "tagB64"]) ||
		frame.version !== 1 || frame.format !== "mul-pis-live-control-frame-v1" ||
		!Number.isSafeInteger(frame.sequence) || (frame.sequence as number) <= 0 ||
		!canonicalBase64(frame.nonceB64, 12) || !canonicalBase64(frame.tagB64, 16) ||
		!canonicalBase64(frame.ciphertextB64) || !frame.ciphertextB64) return undefined;
	const source = frame.source;
	if (!record(source) || !exactKeys(source,
		["repository", "runId", "runAttempt", "commit", "event", "priorEnvelopeSha256"])) return undefined;
	if (source.repository !== expected.GITHUB_REPOSITORY || source.runId !== expected.GITHUB_RUN_ID ||
		source.runAttempt !== Number(expected.GITHUB_RUN_ATTEMPT) || source.commit !== expected.GITHUB_SHA ||
		source.event !== expected.GITHUB_EVENT_NAME ||
		!(typeof source.priorEnvelopeSha256 === "string" &&
			/^[0-9a-f]{64}$/.test(source.priorEnvelopeSha256))) return undefined;
	return frame.sequence as number;
}

/** One serial best-effort publisher for the job's shared physical artifact cap.
 * Prefixes take priority; status still has a separate large observation share. */
export function createProgressUploader(options: ProgressUploaderOptions) {
	let latest: { line: string; sequence: number } | undefined;
	let latestPrefix: CommittedPrefixObservation | undefined;
	let trustedSource: LiveControlFrameSource | undefined;
	let pollPending = false;
	let lastSequence = 0;
	let lastPrefixSequence = 0;
	let lastPrefixAttemptedSequence = 0;
	let nextPollAt = Number.POSITIVE_INFINITY;
	let attempts = 0;
	let statusAttempts = 0;
	let prefixAttempts = 0;
	let active = false;
	let stopped = false;
	let disabled = false;
	let prefixTimer: ObserverTimer | undefined;
	let clientPromise: Promise<ArtifactClient> | undefined;
	let keyPromise: Promise<Readonly<{ key: Buffer; seedDigest: string }>> | undefined;
	const maximum = Math.max(0, Math.min(PROGRESS_ARTIFACT_ATTEMPT_LIMIT,
		options.maxAttempts ?? PROGRESS_ARTIFACT_ATTEMPT_LIMIT));
	const statusMaximum = maximum - (options.prefix ?
		Math.min(PREFIX_RESERVED_ATTEMPTS, Math.floor(maximum / 2)) : 0);
	const requestedInterval = options.prefix?.intervalMs;
	const prefixIntervalMs = Number.isSafeInteger(requestedInterval) && Number(requestedInterval) > 0 ?
		Math.min(PREFIX_PUBLICATION_INTERVAL_MS, Number(requestedInterval)) :
		PREFIX_PUBLICATION_INTERVAL_MS;
	const clock = () => (options.prefix?.now ?? (() => performance.now()))();
	const hasWork = () => Boolean(latestPrefix || pollPending ||
		(latest && statusAttempts < statusMaximum));
	const clearPrefixTimer = () => {
		prefixTimer?.clear();
		prefixTimer = undefined;
	};
	const schedulePrefix = () => {
		if (!trustedSource || stopped || disabled || attempts >= maximum || prefixTimer) return;
		let now: number;
		try { now = clock(); } catch { return; }
		if (!Number.isFinite(now)) return;
		if (!Number.isFinite(nextPollAt)) nextPollAt = now + prefixIntervalMs;
		const wait = Math.max(0, nextPollAt - now);
		if (!prefixTimer) {
			prefixTimer = (options.prefix?.scheduleTimer ?? observerTimer)(() => {
				prefixTimer = undefined;
				if (stopped || disabled || attempts >= maximum) return;
				let observedAt: number;
				try { observedAt = clock(); } catch { return; }
				if (!Number.isFinite(observedAt)) return;
				nextPollAt = observedAt + prefixIntervalMs;
				pollPending = true;
				void pump();
				schedulePrefix();
			}, wait);
			prefixTimer.unref();
		}
	};
	const missionKey = async (): Promise<Readonly<{ key: Buffer; seedDigest: string }>> => {
		if (!options.prefix) throw new Error("prefix publisher is unavailable");
		return keyPromise ??= authenticateSignedMissionSeed({
			envelopeB64: options.prefix.seedEnvelopeB64,
			publicKeyFile: options.prefix.publicKeyFile,
			...(options.prefix.expectedSpkiSha256 ?
				{ expectedSpkiSha256: options.prefix.expectedSpkiSha256 } : {})
		}).then(seed => ({ key: seed.derivePrivateKey("mul-pis-ledger-continuation-v1"),
			seedDigest: seed.seedDigest }));
	};
	const uploadPrefixMember = async (client: ArtifactClient, input: Readonly<{
		artifactName: string; fileName: string; bytes: Buffer; sequence: number;
	}>): Promise<unknown> => {
		if (!options.prefix || stopped || attempts >= maximum)
			throw new Error("prefix observer cannot attempt another artifact");
		// This conservative local floor protects ongoing research and the bounded
		// final artifacts. It only suppresses observer publication.
		const free = await (options.prefix.availableBytes ?? filesystemAvailableBytes)(
			path.dirname(options.directory));
		if (typeof free !== "bigint" ||
			free < PREFIX_LOCAL_FREE_RESERVE_BYTES + BigInt(input.bytes.length))
			throw new Error("prefix observer local free-space floor");
		const root = path.join(options.directory, input.artifactName);
		const file = path.join(root, input.fileName);
		try {
			await mkdir(options.directory, { recursive: true, mode: 0o700 });
			await mkdir(root, { recursive: false, mode: 0o700 });
			await writeFile(file, input.bytes, { flag: "wx", mode: 0o600 });
			if (stopped || attempts >= maximum)
				throw new Error("prefix observer stopped before upload");
			// Count before invocation: even an ambiguous failure may have uploaded.
			attempts++;
			prefixAttempts++;
			lastPrefixAttemptedSequence = input.sequence;
			lastPrefixSequence = Math.max(lastPrefixSequence, input.sequence);
			latestPrefix = undefined;
			return await client.uploadArtifact(input.artifactName, [file], root, { retentionDays: 1 });
		} finally {
			await unlink(file).catch(() => undefined);
			await rmdir(root).catch(() => undefined);
		}
	};
	const pump = async () => {
		if (active || stopped || disabled) return;
		active = true;
		try {
			while (hasWork() && !stopped && !disabled && attempts < maximum) {
				// Loading the client may take time. Select the latest frame afterward.
				let client: ArtifactClient;
				try { client = await (clientPromise ??= (options.client ?? actionsArtifactClient)()); }
				catch { disabled = true; clearPrefixTimer(); break; }
				if (stopped) break;
				const selectedPrefix = latestPrefix;
				if (selectedPrefix) latestPrefix = undefined;
				const selectedPoll = !selectedPrefix && pollPending && trustedSource ?
					trustedSource : undefined;
				if (selectedPoll) pollPending = false;
				const selected = selectedPrefix || selectedPoll ? undefined :
					statusAttempts < statusMaximum ? latest : undefined;
				if (selected) latest = undefined;
				if (!selectedPrefix && !selectedPoll && !selected) break;
				const number = attempts + 1;
				try {
					if (selectedPrefix || selectedPoll) {
						if (!options.prefix) continue;
						const material = await missionKey();
						let snapshot: { bytes: Buffer; sequence: number };
						if (selectedPrefix) {
							try {
								snapshot = { bytes: await readAuthenticatedCommittedPrefix({
									outputDir: options.prefix.outputDir, source: selectedPrefix.source,
									sequence: selectedPrefix.sequence,
									checkpointSha256: selectedPrefix.status.checkpointSha256,
									event: selectedPrefix.status.committedCheckpointBoundary,
									authenticatedMissionKey: material.key }), sequence: selectedPrefix.sequence };
							} catch {
								// A later same-semantic journal rename may beat the first read.
								// Require a newer fully authenticated inode, never a hash mismatch alone.
								const newer = await readLatestAuthenticatedCommittedPrefix({
									outputDir: options.prefix.outputDir, source: selectedPrefix.source,
									authenticatedMissionKey: material.key });
								if (newer.sequence <= selectedPrefix.sequence) continue;
								snapshot = newer;
							}
						} else snapshot = await readLatestAuthenticatedCommittedPrefix({
							outputDir: options.prefix.outputDir, source: selectedPoll!,
							authenticatedMissionKey: material.key });
						if (snapshot.sequence <= lastPrefixAttemptedSequence) continue;
						const rootName = `confidential-mission-prefix-${options.runId}-${options.runAttempt}-${snapshot.sequence}`;
						if (snapshot.bytes.length <= ARTIFACT_PARTITION_PAYLOAD_BYTES) {
							await uploadPrefixMember(client, { artifactName: rootName,
								fileName: INCREMENTAL_CHECKPOINT_FILE, bytes: snapshot.bytes,
								sequence: snapshot.sequence });
						} else {
							const source = selectedPrefix?.source ?? selectedPoll!;
							const prepared = partitionEncryptedFiles({ source: {
								repository: MISSION_REPOSITORY, runId: source.runId,
								runAttempt: source.runAttempt, commit: source.commit, event: source.event },
								artifactName: rootName, files: { [INCREMENTAL_CHECKPOINT_FILE]: snapshot.bytes } });
							// A partially uploaded stream has no root authority. Reserve the
							// complete physical group before making the first part attempt.
							if (prepared.chunks.length + 1 > maximum - attempts) continue;
							const uploads: Array<{ index: number; artifactId: string; archiveSha256: string }> = [];
							for (const chunk of prepared.chunks) {
								const result = await uploadPrefixMember(client, { artifactName: chunk.artifactName,
									fileName: chunk.fileName, bytes: chunk.bytes, sequence: snapshot.sequence });
								const identity = uploadedPartIdentity(result);
								if (!identity) throw new Error("prefix part upload lacks trusted identity");
								uploads.push({ index: chunk.index, ...identity });
							}
							const manifest = finalizePartitionManifest(prepared, uploads);
							const sealed = sealPartitionManifest({ manifest, missionKey: material.key,
								seedDigest: material.seedDigest });
							await uploadPrefixMember(client, { artifactName: rootName,
								fileName: ARTIFACT_PARTITION_MANIFEST_FILE,
								bytes: Buffer.from(`${sealed}\n`, "utf8"), sequence: snapshot.sequence });
					}
				} else {
					const name = `confidential-campaign-progress-${options.runId}-${options.runAttempt}-${number}`;
					const root = options.directory;
					const file = path.join(root, `${name}.enc.json`);
					await mkdir(root, { recursive: true, mode: 0o700 });
					await writeFile(file, `${selected!.line}\n`, { flag: "wx", mode: 0o600 });
					if (stopped) break;
					attempts++;
					statusAttempts++;
					await client.uploadArtifact(name, [file], root, { retentionDays: 1 });
				}
				} catch { /* An observer failure must not affect or delay the campaign. */ }
			}
		} finally {
			active = false;
			schedulePrefix();
			if (hasWork() && !stopped && !disabled && attempts < maximum) void pump();
		}
	};
	return {
		offer(line: string, sequence: number) {
			if (stopped || disabled || attempts >= maximum || statusAttempts >= statusMaximum ||
				sequence <= lastSequence) return false;
			lastSequence = sequence;
			latest = { line, sequence };
			void pump();
			return true;
		},
		offerPrefix(observation: CommittedPrefixObservation) {
			if (!options.prefix || stopped || disabled || attempts >= maximum ||
				observation.sequence <= lastPrefixSequence) return false;
			if (trustedSource && Object.keys(trustedSource).some(key =>
				(trustedSource as unknown as Record<string, unknown>)[key] !==
				(observation.source as unknown as Record<string, unknown>)[key])) return false;
			trustedSource ??= observation.source;
			lastPrefixSequence = observation.sequence;
			if (lastPrefixAttemptedSequence === 0) {
				latestPrefix = observation;
				void pump();
			}
			schedulePrefix();
			return true;
		},
		stop() { stopped = true; latest = undefined; latestPrefix = undefined;
			pollPending = false;
			clearPrefixTimer(); },
		stats() { return { attempts, statusAttempts, prefixAttempts, lastSequence,
			lastPrefixSequence, lastPrefixAttemptedSequence, active,
			pending: Boolean(latest || latestPrefix || pollPending), pollScheduled: Boolean(prefixTimer) }; },
	};
}

/** Authenticate before publication. One pending raw frame bounds work while
 * key setup is in progress; a failed reader disables observation only. */
export function createAuthenticatedProgressGate(input: {
	parent: NodeJS.ProcessEnv; publicKeyFile: string;
	/** For offline signed fixtures only; production keeps the pinned key. */
	expectedSpkiSha256?: string;
	accept: (line: string, sequence: number, status: LiveControlFrameStatusV1,
		source: LiveControlFrameSource) => void;
}) {
	let pending: { line: string; sequence: number } | undefined;
	let reader: Awaited<ReturnType<typeof createLiveControlFrameReader>> | undefined;
	let active = false;
	let stopped = false;
	let disabled = false;
	let lastOfferedSequence = 0;
	const pump = async () => {
		if (active || stopped || disabled) return;
		active = true;
		try {
			while (pending && !stopped && !disabled) {
				const selected = pending;
				pending = undefined;
				try {
					if (!reader) {
						const source = (JSON.parse(selected.line) as { source: LiveControlFrameSource }).source;
						reader = await createLiveControlFrameReader({
							seedEnvelopeB64: input.parent.MULPIS_MISSION_LEDGER_B64,
							publicKeyFile: input.publicKeyFile, source,
							...(input.expectedSpkiSha256 ? { expectedSpkiSha256: input.expectedSpkiSha256 } : {}) });
						}
					const result = reader.read(selected.line);
					if (!stopped) input.accept(selected.line, result.sequence, result.status,
						(JSON.parse(selected.line) as { source: LiveControlFrameSource }).source);
				} catch {
					// A malformed or unauthenticated frame must never become an artifact.
					disabled = true;
					pending = undefined;
				}
			}
		} finally { active = false; }
	};
	return {
		offer(line: string) {
			if (stopped || disabled) return false;
			const sequence = parsePrivateProgressFrame(line, input.parent);
			if (sequence === undefined || sequence <= lastOfferedSequence) return false;
			lastOfferedSequence = sequence;
			pending = { line, sequence };
			void pump();
			return true;
		},
		stop() { stopped = true; pending = undefined; },
		stats() { return { active, disabled, pending: Boolean(pending) }; },
	};
}

function readLines(stream: NodeJS.ReadableStream | null, maximum: number,
	onLine: (line: string) => void): void {
	if (!stream) return;
	let fragment = Buffer.alloc(0);
	let discard = false;
	stream.on("data", (data: Buffer) => {
		const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data);
		let start = 0;
		for (let index = 0; index < chunk.length; index++) {
			if (chunk[index] !== 10) continue;
			const part = chunk.subarray(start, index);
			if (!discard && fragment.length + part.length <= maximum) {
				const bytes = Buffer.concat([fragment, part]);
				onLine(bytes.toString("utf8"));
			}
			fragment = Buffer.alloc(0);
			discard = false;
			start = index + 1;
		}
		if (start < chunk.length && !discard) {
			const tail = chunk.subarray(start);
			if (fragment.length + tail.length > maximum) {
				fragment = Buffer.alloc(0);
				discard = true;
			} else fragment = Buffer.concat([fragment, tail]);
		}
	});
	stream.on("error", () => { /* The child must remain independent of observation. */ });
}

export type CampaignObserverLaunch = {
	inputDir: string; outputDir: string; stdoutFile: string; stderrFile: string;
	exitReceiptFile?: string;
	/** Synthetic signed fixture overrides only. Production uses the pinned public key. */
	publicKeyFile?: string; expectedSpkiSha256?: string;
	prefixAvailableBytes?: (directory: string) => Promise<bigint>;
	parentEnv?: NodeJS.ProcessEnv;
	client?: () => Promise<ArtifactClient>;
	spawnChild?: (command: string, args: string[], options: SpawnOptions) => ChildProcess;
	publicWrite?: (line: string) => void;
};

export function launchPrivateCampaignObserver(options: CampaignObserverLaunch): Promise<number> {
	const parent = options.parentEnv ?? process.env;
	const stdout = openSync(options.stdoutFile, "w", 0o600);
	const stderr = openSync(options.stderrFile, "w", 0o600);
	let child: ChildProcess;
	try {
		child = (options.spawnChild ?? spawn)(process.execPath,
			[path.join(path.dirname(fileURLToPath(import.meta.url)), "manual-private-campaign.ts"),
				"--input-dir", options.inputDir, "--output-dir", options.outputDir],
			{ env: privateCampaignChildEnv(parent), stdio: ["inherit", stdout, stderr, "pipe", "pipe"] });
	} finally {
		closeSync(stdout);
		closeSync(stderr);
	}
	const publicKeyFile = options.publicKeyFile ??
		path.join(path.dirname(fileURLToPath(import.meta.url)), "campaign-output-public.pem");
	const uploader = createProgressUploader({ directory: path.join(path.dirname(options.outputDir), "private-campaign-live-ciphertext"),
		runId: parent.GITHUB_RUN_ID ?? "unknown", runAttempt: parent.GITHUB_RUN_ATTEMPT ?? "unknown",
		prefix: { outputDir: options.outputDir, publicKeyFile,
			seedEnvelopeB64: parent.MULPIS_MISSION_LEDGER_B64,
			...(options.prefixAvailableBytes ? { availableBytes: options.prefixAvailableBytes } : {}),
			...(options.expectedSpkiSha256 ? { expectedSpkiSha256: options.expectedSpkiSha256 } : {}) },
		...(options.client ? { client: options.client } : {}) });
	const gate = createAuthenticatedProgressGate({ parent,
		publicKeyFile,
		...(options.expectedSpkiSha256 ? { expectedSpkiSha256: options.expectedSpkiSha256 } : {}),
		accept: (line, sequence, status, source) => {
			uploader.offerPrefix({ source, sequence, status });
			uploader.offer(line, sequence);
		} });
	readLines(child.stdio[3] as NodeJS.ReadableStream, 128, line => {
		if (`${line}\n` !== PUBLIC_HEARTBEAT_LINE) return;
		try { (options.publicWrite ?? (value => { writeSync(3, value); }))(PUBLIC_HEARTBEAT_LINE); }
		catch { /* Even a broken public heartbeat is nonfatal. */ }
	});
	readLines(child.stdio[4] as NodeJS.ReadableStream, PROGRESS_FRAME_MAX_BYTES, line => { gate.offer(line); });
	return new Promise(resolve => {
		let settled = false;
		child.once("error", () => { if (!settled) { settled = true; gate.stop(); uploader.stop(); resolve(1); } });
		child.once("exit", (code, signal) => {
			if (settled) return;
			settled = true;
			gate.stop();
			uploader.stop();
			const signalNumber = signal ? osConstants.signals[signal] : undefined;
			const driverExitCode = code ?? (signalNumber ? 128 + signalNumber : 1);
			if (options.exitReceiptFile) {
				try {
					writeFileSync(options.exitReceiptFile, `${JSON.stringify({ version: 1,
						kind: "private-campaign-driver-exit", driverExitCode,
						childSignal: signal ?? null })}\n`, { flag: "wx", mode: 0o600 });
				} catch { /* The action treats a missing receipt as an unknown outcome. */ }
			}
			resolve(driverExitCode);
		});
	});
}

function requiredArg(name: string): string {
	const position = process.argv.indexOf(name);
	if (position < 0 || position + 1 >= process.argv.length) throw new Error(`missing ${name}`);
	return process.argv[position + 1]!;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		const code = await launchPrivateCampaignObserver({ inputDir: requiredArg("--input-dir"),
			outputDir: requiredArg("--output-dir"), stdoutFile: requiredArg("--stdout"),
			stderrFile: requiredArg("--stderr"),
			...(process.argv.includes("--driver-exit-file") ?
				{ exitReceiptFile: requiredArg("--driver-exit-file") } : {}) });
		// Deliberately do not await or extend the child for in-flight observation.
		process.exit(code);
	} catch {
		process.exit(1);
	}
}
