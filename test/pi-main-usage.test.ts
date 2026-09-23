import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import type { ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { createMainUsageLedger } from "../src/pi/main-usage.ts";

function fixtureContext(cwd: string, entries: SessionEntry[], sessionId = "main-test"): ExtensionContext {
	return {
		cwd,
		model: { id: "test-model", provider: "test", cost: { input: 1, output: 1 } },
		sessionManager: { getSessionId: () => sessionId, getEntries: () => entries },
	} as unknown as ExtensionContext;
}

function assistant(id: string, input: number, output: number): SessionEntry {
	return {
		id, type: "message", timestamp: new Date().toISOString(),
		message: { role: "assistant", provider: "test", model: "test-model", stopReason: "stop", content: [], usage: { input, output, cacheRead: 0, cacheWrite: 0, totalTokens: input + output, cost: { total: (input + output) / 1000 } } },
	} as unknown as SessionEntry;
}

async function rows(root: string): Promise<Array<Record<string, any>>> {
	const content = await readFile(path.join(root, ".agent", "telemetry", "pi-main-usage-main-test.jsonl"), "utf8");
	return content.trim().split("\n").map((line) => JSON.parse(line));
}

test("Pi main usage accumulates append-only entries once across duplicate hooks and reload", async (t) => {
	const root = await mkdtemp(path.join(tmpdir(), "pi-main-usage-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	await mkdir(path.join(root, ".agent"));
	const entries: SessionEntry[] = [];
	const ctx = fixtureContext(root, entries);
	const ledger = createMainUsageLedger();
	await ledger.sessionStart(ctx);
	await ledger.agentStart(ctx);
	entries.push(assistant("a1", 10, 3), assistant("a2", 4, 2));
	await ledger.agentEnd(ctx);
	await ledger.agentEnd(ctx);
	await ledger.sessionShutdown(ctx);
	let saved = await rows(root);
	assert.equal(saved.length, 1);
	assert.equal(saved[0].classification, "pi-main-orchestration");
	assert.equal(saved[0].summary.input, 14);
	assert.equal(saved[0].summary.output, 5);
	assert.equal(saved[0].summary.complete, true);
	assert.equal(saved[0].summary.costComplete, true);
	assert.equal(JSON.stringify(saved).includes("content"), false);

	const reloaded = createMainUsageLedger();
	await reloaded.sessionStart(ctx);
	await reloaded.agentStart(ctx);
	entries.push(assistant("a3", 1, 1));
	await reloaded.agentEnd(ctx);
	saved = await rows(root);
	assert.equal(saved.length, 2);
	assert.equal(saved[1].summary.input, 15);
	assert.equal(saved[1].summary.output, 6);
});

test("Pi main usage marks a failed call with no provider entry unknown", async (t) => {
	const root = await mkdtemp(path.join(tmpdir(), "pi-main-usage-fail-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	await mkdir(path.join(root, ".agent"));
	const entries: SessionEntry[] = [];
	const ctx = fixtureContext(root, entries);
	const ledger = createMainUsageLedger();
	await ledger.sessionStart(ctx);
	await ledger.agentStart(ctx);
	await ledger.agentEnd(ctx);
	await ledger.agentEnd(ctx);
	const saved = await rows(root);
	assert.equal(saved.length, 1);
	assert.equal(saved[0].events[0].status, "unknown");
	assert.equal(saved[0].summary.complete, false);
	assert.equal(saved[0].summary.costComplete, false);
});

test("Pi main usage keeps a watermark when the same session changes cwd", async (t) => {
	const first = await mkdtemp(path.join(tmpdir(), "pi-main-first-"));
	const second = await mkdtemp(path.join(tmpdir(), "pi-main-second-"));
	t.after(() => Promise.all([rm(first, { recursive: true, force: true }), rm(second, { recursive: true, force: true })]));
	await Promise.all([mkdir(path.join(first, ".agent")), mkdir(path.join(second, ".agent"))]);
	const entries: SessionEntry[] = [];
	const ledger = createMainUsageLedger();
	const firstCtx = fixtureContext(first, entries);
	const secondCtx = fixtureContext(second, entries);
	await ledger.sessionStart(firstCtx);
	await ledger.agentStart(firstCtx);
	entries.push(assistant("first", 7, 2));
	await ledger.agentEnd(firstCtx);
	await ledger.sessionStart(secondCtx);
	await ledger.agentStart(secondCtx);
	entries.push(assistant("second", 3, 1));
	await ledger.agentEnd(secondCtx);
	assert.equal((await rows(first)).at(-1)?.summary.input, 7);
	assert.equal((await rows(second)).at(-1)?.summary.input, 3);
});
