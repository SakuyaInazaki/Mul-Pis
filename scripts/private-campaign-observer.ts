/** Trusted Actions parent for a private campaign. The child never inherits the
 * artifact runtime credentials or Actions file-command paths. */
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { openSync, closeSync, writeFileSync, writeSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { constants as osConstants } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PUBLIC_HEARTBEAT_LINE } from "./private-campaign-heartbeat.ts";
import { createLiveControlFrameReader, type LiveControlFrameSource } from
	"../src/runner/live-control-frame.ts";

export const PROGRESS_FRAME_MAX_BYTES = 4096;
export const PROGRESS_ARTIFACT_ATTEMPT_LIMIT = 498; // v4 job cap 500; reserve final outcome and carry.
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
export type ProgressUploaderOptions = {
	directory: string;
	runId: string;
	runAttempt: string;
	client?: () => Promise<ArtifactClient>;
	maxAttempts?: number;
};

async function actionsArtifactClient(): Promise<ArtifactClient> {
	// Dynamic and lazy: no artifact package is required for offline checks.
	const packageName = "@actions/artifact";
	const toolkit = await import(packageName) as { DefaultArtifactClient: new () => ArtifactClient };
	return new toolkit.DefaultArtifactClient();
}

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
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

/** Holds one pending ciphertext snapshot while one upload is in flight. */
export function createProgressUploader(options: ProgressUploaderOptions) {
	let latest: { line: string; sequence: number } | undefined;
	let lastSequence = 0;
	let attempts = 0;
	let active = false;
	let stopped = false;
	let disabled = false;
	let clientPromise: Promise<ArtifactClient> | undefined;
	const maximum = Math.max(0, Math.min(PROGRESS_ARTIFACT_ATTEMPT_LIMIT,
		options.maxAttempts ?? PROGRESS_ARTIFACT_ATTEMPT_LIMIT));
	const pump = async () => {
		if (active || stopped || disabled) return;
		active = true;
		try {
			while (latest && !stopped && !disabled && attempts < maximum) {
				// Loading the client may take time. Select the latest frame afterward.
				let client: ArtifactClient;
				try { client = await (clientPromise ??= (options.client ?? actionsArtifactClient)()); }
				catch { disabled = true; break; }
				const selected = latest;
				latest = undefined;
				const number = attempts + 1;
				const name = `confidential-campaign-progress-${options.runId}-${options.runAttempt}-${number}`;
				const file = path.join(options.directory, `${name}.enc.json`);
				try {
					await mkdir(options.directory, { recursive: true, mode: 0o700 });
					await writeFile(file, `${selected.line}\n`, { flag: "wx", mode: 0o600 });
					if (stopped) break;
					// Count before invocation: even an ambiguous failure may have made an artifact.
					attempts++;
					await client.uploadArtifact(name, [file], options.directory, { retentionDays: 1 });
				} catch { /* An observer failure must not affect or delay the campaign. */ }
			}
		} finally {
			active = false;
			if (latest && !stopped && !disabled && attempts < maximum) void pump();
		}
	};
	return {
		offer(line: string, sequence: number) {
			if (stopped || disabled || attempts >= maximum || sequence <= lastSequence) return false;
			lastSequence = sequence;
			latest = { line, sequence };
			void pump();
			return true;
		},
		stop() { stopped = true; latest = undefined; },
		stats() { return { attempts, lastSequence, active, pending: Boolean(latest) }; },
	};
}

/** Authenticate before publication. One pending raw frame bounds work while
 * key setup is in progress; a failed reader disables observation only. */
export function createAuthenticatedProgressGate(input: {
	parent: NodeJS.ProcessEnv; publicKeyFile: string;
	/** For offline signed fixtures only; production keeps the pinned key. */
	expectedSpkiSha256?: string;
	accept: (line: string, sequence: number) => void;
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
					if (!stopped) input.accept(selected.line, result.sequence);
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
	const uploader = createProgressUploader({ directory: path.join(path.dirname(options.outputDir), "private-campaign-live-ciphertext"),
		runId: parent.GITHUB_RUN_ID ?? "unknown", runAttempt: parent.GITHUB_RUN_ATTEMPT ?? "unknown",
		...(options.client ? { client: options.client } : {}) });
	const gate = createAuthenticatedProgressGate({ parent,
		publicKeyFile: path.join(path.dirname(fileURLToPath(import.meta.url)), "campaign-output-public.pem"),
		accept: (line, sequence) => { uploader.offer(line, sequence); } });
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
