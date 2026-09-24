import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { ResearchService } from "../src/pi/service.ts";
import { FakeSessionRunner } from "../src/runner/fake.ts";

class VirtualTimers {
	private callbacks = new Map<NodeJS.Timeout, () => void>();
	setInterval = (callback: () => void, _ms: number): NodeJS.Timeout => { const timer = { unref() { return this; } } as NodeJS.Timeout; this.callbacks.set(timer, callback); return timer; };
	setTimeout = this.setInterval;
	clearInterval = (timer: NodeJS.Timeout): void => { this.callbacks.delete(timer); };
	clearTimeout = this.clearInterval;
	tick(): void { for (const callback of [...this.callbacks.values()]) callback(); }
}

async function setup(t: any, options: { clock: () => number; pause: (now: number) => number; timers: VirtualTimers }) {
	const root = await mkdtemp(path.join(tmpdir(), "pre-rsi-virtual-watchdog-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	await mkdir(path.join(root, "problem", "raw"), { recursive: true });
	await writeFile(path.join(root, "problem", "problem.md"), "problem\n");
	await writeFile(path.join(root, "research.config.json"), JSON.stringify({ roles: { execution: "fake/model" }, concurrency: 1 }) + "\n");
	let started!: () => void;
	const start = new Promise<void>((resolve) => { started = resolve; });
	const service = new ResearchService({ defaultWorkspace: root, progressIntervalMs: 0, promptTimeoutMs: 0,
		watchdogNow: options.clock, trustedPauseMs: options.pause, watchdogTimers: options.timers,
		onProgress: (progress) => { if (progress.phase === "prompt-start") started(); },
		runnerFactory: () => new FakeSessionRunner(async () => { await new Promise<void>(() => undefined); return { text: "never", reads: [] }; }) });
	await service.init(root);
	return { service, root, start };
}

test("default 30-second stall polling detects silence at the real 10-minute limit", async (t) => {
	let now = 0;
	const timers = new VirtualTimers();
	const f = await setup(t, { clock: () => now, pause: () => 0, timers });
	const pending = f.service.runStage({ stage: "M01", workspace: f.root });
	await f.start;
	for (let i = 0; i < 21; i++) { now += 30_000; timers.tick(); }
	await assert.rejects(pending, /made no progress/);
});

test("a delayed normal timer does not erase elapsed work time", async (t) => {
	let now = 0;
	const timers = new VirtualTimers();
	const f = await setup(t, { clock: () => now, pause: () => 0, timers });
	const pending = f.service.runStage({ stage: "M01", workspace: f.root });
	await f.start;
	now = 11 * 60_000;
	timers.tick();
	await assert.rejects(pending, /made no progress/);
});

test("only an injected trusted pause offsets watchdog elapsed time", async (t) => {
	let now = 0;
	let paused = 0;
	const timers = new VirtualTimers();
	const f = await setup(t, { clock: () => now, pause: () => paused, timers });
	const pending = f.service.runStage({ stage: "M01", workspace: f.root });
	await f.start;
	for (let i = 0; i < 10; i++) { now += 30_000; timers.tick(); }
	paused = 5 * 60_000;
	for (let i = 0; i < 10; i++) { now += 30_000; timers.tick(); }
	for (let i = 0; i < 11; i++) { now += 30_000; timers.tick(); }
	await assert.rejects(pending, /made no progress/);
});
