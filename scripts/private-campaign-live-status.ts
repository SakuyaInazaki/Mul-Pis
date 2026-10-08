/** Best-effort child-side live observation. The control journal has already
 * published before this is called; no observer failure may enter its promise. */
import { createWriteStream } from "node:fs";
import type { StoredIncrementalCheckpoint, IncrementalCheckpointEvent,
	IncrementalCheckpointInput } from "../src/runner/incremental-private-checkpoint.ts";
import type { LiveControlFrameEmission } from "../src/runner/live-control-frame.ts";

type Writer = Readonly<{ emit: (value: LiveControlFrameEmission) => Promise<unknown> }>;
type Timer = ReturnType<typeof setTimeout>;
type Clock = Readonly<{ now: () => number; later: (callback: () => void, ms: number) => Timer;
	clear: (timer: Timer) => void }>;
const realClock: Clock = { now: Date.now, later: setTimeout, clear: clearTimeout };
/** Sampling changes observation frequency only, never research execution. */
export const LIVE_REQUEST_SAMPLE_MS = 120_000;

/** A parent can drop intermediate frames. The latest committed status occupies
 * one pending slot; a slow or broken pipe cannot grow a research-side queue. */
export function bestEffortLiveControlObserver(input: Readonly<{
	enabled: boolean; openWriter: () => Promise<Writer>; clock?: Clock;
}>): Readonly<{ committed: (stored: StoredIncrementalCheckpoint,
	event: IncrementalCheckpointEvent,
	audit: IncrementalCheckpointInput["requestAudit"],
	effects: IncrementalCheckpointInput["hostEffects"]) => void }> {
	if (!input.enabled) return { committed: () => undefined };
	const clock = input.clock ?? realClock;
	let dead = false, busy = false, eligible = false;
	let pending: LiveControlFrameEmission | undefined;
	let pendingTimer: Timer | undefined, lastSemantic: string | undefined, lastSubmittedAt = 0;
	let writer: Promise<Writer> | undefined;
	const clearTimer = () => {
		if (pendingTimer) clock.clear(pendingTimer);
		pendingTimer = undefined;
	};
	const flush = () => {
		if (dead || busy || !pending || !eligible) return;
		busy = true;
		writer ??= Promise.resolve().then(input.openWriter);
		void writer.then(async target => {
			while (pending && eligible && !dead) {
				const latest = pending;
				pending = undefined;
				eligible = false;
				try { await target.emit(latest); }
				catch { dead = true; pending = undefined; clearTimer(); }
			}
		}).catch(() => { dead = true; pending = undefined; clearTimer(); })
			.finally(() => { busy = false; if (pending && eligible && !dead) flush(); });
	};
	const submit = () => {
		if (!pending || dead) return;
		clearTimer();
		lastSubmittedAt = clock.now();
		eligible = true;
		flush();
	};
	return { committed(stored, event, audit, effects) {
		try {
			if (dead || !Number.isSafeInteger(stored.sequence) || stored.sequence < 1 ||
				!Array.isArray(audit.requests) || !Array.isArray(effects.goals)) return;
			const now = clock.now();
			const goalCount = effects.goals.length;
			const taskCount = effects.goals.reduce((sum, goal) => sum + goal.tasks.length, 0);
			const operationCount = effects.goals.reduce((sum, goal) => sum + goal.operations.length, 0);
			const goalOutcomeCounts = { active: 0, partial: 0, blocked: 0, fulfilled: 0 };
			const taskStatusCounts = { running: 0, returned: 0, failed: 0,
				accepted: 0, rejected: 0, unknown: 0 };
			const operationStatusCounts = { prepared: 0, issued: 0,
				"response-received": 0, "partial-settled": 0,
				"terminal-response-incomplete": 0, unknown: 0, confirmed: 0,
				"not-issued": 0 };
			for (const goal of effects.goals) {
				if (!Object.hasOwn(goalOutcomeCounts, goal.outcome)) return;
				goalOutcomeCounts[goal.outcome as keyof typeof goalOutcomeCounts]++;
				for (const task of goal.tasks) {
					if (!Object.hasOwn(taskStatusCounts, task.status)) return;
					taskStatusCounts[task.status as keyof typeof taskStatusCounts]++;
				}
				for (const operation of goal.operations) {
					if (!Object.hasOwn(operationStatusCounts, operation.status)) return;
					operationStatusCounts[operation.status as keyof typeof operationStatusCounts]++;
				}
			}
			const responseReceivedCount = audit.requests.filter(row => row.responseReceived === true).length;
			const requestCount = audit.requests.length;
			if (![goalCount, taskCount, operationCount,
				responseReceivedCount, requestCount]
				.every(Number.isSafeInteger)) return;
			const semantic = JSON.stringify([event, requestCount, responseReceivedCount,
				goalCount, goalOutcomeCounts, taskCount, taskStatusCounts,
				operationCount, operationStatusCounts]);
			if (semantic === lastSemantic) return;
			lastSemantic = semantic;
			pending = { sequence: stored.sequence, checkpointSha256: stored.sha256,
				committedCheckpointBoundary: event, requestCount, responseReceivedCount,
				goalCount, goalOutcomeCounts, taskCount, taskStatusCounts,
				operationCount, operationStatusCounts,
				observedAt: new Date(now).toISOString() };
			const control = event === "initial" || event === "control-observed" ||
				event === "host-effect-observed";
			if (control || lastSubmittedAt === 0 || now - lastSubmittedAt >= LIVE_REQUEST_SAMPLE_MS)
				submit();
			else if (!pendingTimer) {
				pendingTimer = clock.later(submit, LIVE_REQUEST_SAMPLE_MS - (now - lastSubmittedAt));
				pendingTimer.unref?.();
			}
		} catch { /* Observation must not affect the committed controller. */ }
	} };
}

/** FD4 belongs only to the trusted parent. Never wait for drain or propagate
 * pipe errors into the campaign. Each write is one bounded ciphertext line. */
export function actionsLiveControlFrameSink(
	enabled = process.env.GITHUB_ACTIONS === "true" &&
		process.env.MULPIS_ACTIONS_PRIVATE_PROGRESS_FD === "4",
): (line: string) => void {
	if (!enabled) return () => undefined;
	let dead = false, backpressured = false;
	const pipe = createWriteStream("/dev/null", { fd: 4, autoClose: false, highWaterMark: 4096 });
	pipe.on("error", () => { dead = true; });
	pipe.on("close", () => { dead = true; });
	pipe.on("drain", () => { backpressured = false; });
	return line => {
		if (dead || backpressured || pipe.destroyed || /[\r\n]/.test(line) ||
			Buffer.byteLength(line, "utf8") > 4096) return;
		try { if (!pipe.write(`${line}\n`, "utf8")) backpressured = true; }
		catch { dead = true; }
	};
}
