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

test("a silent child prompt is not ended by a default wall or stall deadline", async (t) => {
	const root = await mkdtemp(path.join(tmpdir(), "pre-rsi-virtual-watchdog-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	await mkdir(path.join(root, "problem", "raw"), { recursive: true });
	await writeFile(path.join(root, "problem", "problem.md"), "problem\n");
	await writeFile(path.join(root, "research.config.json"), JSON.stringify({ roles: { execution: "fake/model" }, concurrency: 1 }) + "\n");
	let now = 0;
	let started!: () => void;
	const start = new Promise<void>((resolve) => { started = resolve; });
	let release!: () => void;
	const work = new Promise<void>((resolve) => { release = resolve; });
	const timers = new VirtualTimers();
	const service = new ResearchService({ defaultWorkspace: root, progressIntervalMs: 0,
		watchdogNow: () => now, trustedPauseMs: () => 0, watchdogTimers: timers,
		onProgress: (progress) => { if (progress.phase === "prompt-start") started(); },
		runnerFactory: () => new FakeSessionRunner(async () => { await work; return { text: "completed after long silence", reads: [] }; }) });
	await service.init(root);
	const pending = service.runStage({ stage: "M01", workspace: root });
	await start;
	now = 3 * 60 * 60_000;
	timers.tick();
	release();
	const result = await pending;
	assert.ok(result);
});
