/**
 * The platform contract as the execution session actually experiences it.
 *
 * A rule written in a prompt is a request; a rule enforced at the editing
 * surface is a structure. This gate sits between the model's file tools and the
 * work directory: it refuses writes outside the editable surface, refuses source
 * that violates a contract the harness can decide statically, keeps a round to
 * one file when the profile asks for it, serialises the commands that touch the
 * device, and appends a mechanical reading of toolchain and profiler output.
 *
 * Every decision is appended to a receipt file, so a later review can count how
 * much of the device budget was never spent and why.
 */
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { checkPlatformSource, describePlatformFindings, platformEditable, type PlatformFindingV1 } from "./contract.ts";
import { describePlatformDiagnosis, diagnosePlatformOutput, hasPlatformDiagnosis } from "./diagnostics.ts";
import { acquireDeviceLease } from "./device-lease.ts";
import { loadPlatformProfile, type PlatformProfileV1 } from "./profile.ts";

export interface PlatformReceiptV1 {
	version: 1;
	at: string;
	kind: "write-rejected" | "write-accepted" | "write-outside-surface" | "second-file-in-turn" | "device-lease" | "diagnosis";
	platformId: string;
	sessionId?: string;
	turn?: number;
	path?: string;
	toolName?: string;
	findings?: PlatformFindingV1[];
	classes?: string[];
	bottleneck?: string;
	leasePurpose?: string;
	waitedMs?: number;
}

export interface PlatformWriteVerdict {
	/** Set when the write must not happen; the text is returned to the model. */
	rejected?: string;
	/** Set when the write may happen but the contract flagged something. */
	warning?: string;
}

export interface PlatformGate {
	readonly profile: PlatformProfileV1;
	/** Decide one write or edit of `absolutePath` whose resulting text is `source`. */
	checkWrite(absolutePath: string, source: string, turn: number): Promise<PlatformWriteVerdict>;
	/** Hold the device for exactly the commands that use it. */
	withDevice<T>(command: string, run: () => Promise<T>): Promise<T>;
	/** Mechanical reading appended after tool output; undefined when nothing matched. */
	observe(toolName: string, text: string): Promise<string | undefined>;
}

export interface PlatformGateOptions {
	profile: PlatformProfileV1;
	/** Execution root; paths are reported relative to it. */
	root: string;
	receiptFile?: string;
	sessionId?: string;
	now?: () => number;
	sleep?: (ms: number) => Promise<void>;
}

function relative(root: string, target: string): string {
	const resolved = path.isAbsolute(target) ? path.resolve(target) : path.resolve(root, target);
	return path.relative(root, resolved) || path.basename(resolved);
}

export function createPlatformGate(options: PlatformGateOptions): PlatformGate {
	const profile = options.profile;
	const now = options.now ?? (() => Date.now());
	let turnFile: { turn: number; path: string } | undefined;
	const receipt = async (entry: Omit<PlatformReceiptV1, "version" | "at" | "platformId">): Promise<void> => {
		if (!options.receiptFile) return;
		const row: PlatformReceiptV1 = { version: 1, at: new Date(now()).toISOString(), platformId: profile.id,
			...(options.sessionId ? { sessionId: options.sessionId } : {}), ...entry };
		try {
			await mkdir(path.dirname(options.receiptFile), { recursive: true });
			await appendFile(options.receiptFile, `${JSON.stringify(row)}\n`, "utf8");
		} catch {
			// A missing receipt must not turn into a refused edit; the verdict text
			// still reaches the model and the session transcript.
		}
	};
	return {
		profile,
		async checkWrite(absolutePath, source, turn) {
			const file = relative(options.root, absolutePath);
			if (!platformEditable(profile, file)) {
				await receipt({ kind: "write-outside-surface", turn, path: file });
				return { rejected: `platform ${profile.id} keeps ${file} read-only: the evaluation surface and generated host scaffolding are not the agent's editing surface. Change only the files the profile declares editable.` };
			}
			const verdict = checkPlatformSource(profile, file, source);
			if (!verdict.allowed) {
				await receipt({ kind: "write-rejected", turn, path: file, findings: verdict.findings });
				return { rejected: describePlatformFindings(profile, verdict) };
			}
			// A refused write changed nothing, so it does not spend the round's one file.
			if (profile.editableSurface?.singleFilePerTurn) {
				if (turnFile && turnFile.turn === turn && turnFile.path !== file) {
					await receipt({ kind: "second-file-in-turn", turn, path: file });
					return { rejected: `platform ${profile.id} allows one file per round; this round already changed ${turnFile.path}. Finish and evaluate that change before editing ${file}.` };
				}
				turnFile = { turn, path: file };
			}
			if (verdict.findings.length) {
				await receipt({ kind: "write-accepted", turn, path: file, findings: verdict.findings });
				return { warning: describePlatformFindings(profile, verdict) };
			}
			return {};
		},
		async withDevice(command, run) {
			const serialization = profile.deviceSerialization;
			if (!serialization || !new RegExp(serialization.commandPattern).test(command)) return run();
			const started = now();
			const lease = await acquireDeviceLease({ file: serialization.leaseFile, platformId: profile.id,
				purpose: command.slice(0, 120), timeoutMs: serialization.timeoutMs,
				...(options.now ? { now: options.now } : {}), ...(options.sleep ? { sleep: options.sleep } : {}) });
			await receipt({ kind: "device-lease", leasePurpose: lease.record.purpose, waitedMs: now() - started });
			try {
				return await run();
			} finally {
				await lease.release();
			}
		},
		async observe(toolName, text) {
			if (!text) return undefined;
			const diagnosis = diagnosePlatformOutput(profile, text);
			if (!hasPlatformDiagnosis(diagnosis)) return undefined;
			await receipt({ kind: "diagnosis", toolName, classes: diagnosis.classes.map(entry => `${entry.class}:${entry.id}`),
				...(diagnosis.bottleneck ? { bottleneck: diagnosis.bottleneck.label } : {}) });
			return describePlatformDiagnosis(profile, diagnosis);
		},
	};
}

/**
 * Bind a platform from the host environment. The variable is read in the
 * harness process only: a model-facing shell is spawned with a rebuilt
 * environment, so a candidate can neither see this path nor point it elsewhere.
 */
export async function platformGateFromEnvironment(options: Omit<PlatformGateOptions, "profile"> &
	{ env?: NodeJS.ProcessEnv }): Promise<PlatformGate | undefined> {
	const file = (options.env ?? process.env).PRE_RSI_PLATFORM_PROFILE;
	if (!file) return undefined;
	const profile = await loadPlatformProfile(file);
	const { env: _env, ...rest } = options;
	return createPlatformGate({ ...rest, profile });
}
