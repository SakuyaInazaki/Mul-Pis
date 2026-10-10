import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createAgentSession, ModelRuntime, type CreateAgentSessionOptions } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { SharedBudget } from "../src/experiments/budget.ts";
import { createWorkflowMeteredRunner, validateWorkflowAction, workflowDecisionPrompt, workflowImproverSystemPrompt } from "../src/improvement/workflow-adapter.ts";
import { runBoundedModelStep } from "../src/improvement/research-model.ts";
import { PiSessionRunner } from "../src/runner/pi.ts";
import type { SessionHandle, SessionRunner, UsageSummary } from "../src/runner/types.ts";

const MODEL = { id: "offline-model", name: "Offline model", api: "anthropic-messages", provider: "offline", baseUrl: "https://invalid.example", reasoning: false, input: ["text"], cost: { input: 0.2, output: 0.2, cacheRead: 0.2, cacheWrite: 0.2 }, contextWindow: 100_000, maxTokens: 2_000 } as Model<"anthropic-messages">;
const RUNTIME = { getModels: () => [MODEL] } as unknown as ModelRuntime;
const usage = (input: number, output: number) => ({ input, output, cacheRead: 0, cacheWrite: 0, totalTokens: input + output, cost: { input: 0.01, output: 0.01, cacheRead: 0, cacheWrite: 0, total: 0.02 } });
const settledUsage: UsageSummary = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: 0.02, reportedEvents: 1, unknownEvents: 0, complete: true, costComplete: true };
const deadlineLimits = { maxProviderCalls: 2, maxInputTokens: 100, maxOutputTokens: 100, maxSdkEstimatedCost: 1, maxProbeCalls: 0, maxCpuMillis: 1_000, maxWallMillis: 1_000 };
function deadlineRunner(prompt: SessionHandle["prompt"], onAbort: () => void): SessionRunner {
	const handle: SessionHandle = {
		ref: { id: "offline-deadline", label: "M07-offline", role: "execution", model: "offline/offline-model" },
		prompt, transcript: () => [], readCoverage: () => [], readReturnEvents: () => [], usageEvents: () => [], usageSummary: () => settledUsage,
		abort: async () => { onAbort(); }, toolLog: () => [], dispose: () => undefined,
	};
	return { create: async () => handle, resume: async () => handle };
}
const deadlineSpec = { label: "M07-offline", role: "execution" as const, model: "offline/offline-model", systemPrompt: "offline", tools: { kind: "none" as const }, persistDir: "/tmp" };

test("workflow arm does not abort progressing work at a legacy timeout", async () => {
	let aborts = 0;
	const budget = new SharedBudget("workflow-hang", deadlineLimits);
	const runner = createWorkflowMeteredRunner(deadlineRunner(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); return { text: "report", stopReason: "stop", toolCalls: 0, usage: settledUsage }; }, () => { aborts++; }), budget, budget.root, [], 1);
	const handle = await runner.create(deadlineSpec);
	await handle.prompt("progressing");
	assert.equal(aborts, 0);
	assert.equal(budget.status().settlement, "settled");
});

test("workflow arm accepts settled usage beyond a legacy wall quota", async (t) => {
	let now = 1_000;
	t.mock.method(Date, "now", () => now);
	const budget = new SharedBudget("workflow-final-wall", { ...deadlineLimits, maxWallMillis: 50 });
	const events: UsageSummary[] = [];
	const runner = createWorkflowMeteredRunner(deadlineRunner(async () => { now += 51; return { text: "report", stopReason: "stop", toolCalls: 0, usage: settledUsage }; }, () => undefined), budget, budget.root, events, 1_000);
	const handle = await runner.create(deadlineSpec);
	await handle.prompt("last arm turn");
	assert.equal(events.length, 1, "observed provider usage is still recorded");
	assert.equal(budget.status().settlement, "settled");
	assert.equal("wallMillis" in budget.status().remaining, false);
});

test("workflow turn continues with complete provider events and unknown price", async () => {
	const budget = new SharedBudget("workflow-unpriced", {});
	const unpriced = { ...settledUsage, costComplete: false };
	const events: UsageSummary[] = [];
	const runner = createWorkflowMeteredRunner(deadlineRunner(async () => ({ text: "report", stopReason: "stop", toolCalls: 0, usage: unpriced }), () => undefined), budget, budget.root, events);
	const handle = await runner.create(deadlineSpec);
	await handle.prompt("first");
	await handle.prompt("second");
	assert.equal(events.length, 2);
	assert.equal(budget.status().usageUnknown, true);
});

test("bounded I request ignores legacy elapsed-time quotas", async () => {
 let aborts = 0;
 const budget = new SharedBudget("workflow-i-deadline", { ...deadlineLimits, maxInputTokens: 10_000, maxWallMillis: 1 });
 const runner: SessionRunner = { ...deadlineRunner(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); return { text: "decision", stopReason: "stop", toolCalls: 0, usage: settledUsage }; }, () => { aborts++; }), estimateMaxSdkCost: async () => 0.1 };
 await runBoundedModelStep({ runner, budget, lease: budget.root, spec: { label: "I-offline", role: "improver", model: "offline/offline-model", systemPrompt: "offline", persistDir: "/tmp" }, message: "Choose a bounded action", timeoutMs: 1 });
 assert.equal(aborts, 0);
 assert.equal(budget.status().settlement, "settled");
});

test("real Pi runner SDK boundary accounts for two offline provider rounds with an actual granted file read", async (t) => {
	const root = await mkdtemp(path.join(os.tmpdir(), "pre-rsi-workflow-turn-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const materials = path.join(root, "materials"); await mkdir(materials);
	await writeFile(path.join(materials, "evidence.txt"), "frozen source evidence\n");
	let readReturned = false;
	const factory = (async (options: CreateAgentSessionOptions = {}) => {
		const manager = options.sessionManager!;
		const messages: unknown[] = [...manager.buildSessionContext().messages];
		const session = {
			sessionId: manager.getSessionId(), sessionFile: manager.getSessionFile(), messages,
			getActiveToolNames: () => [...(options.tools ?? [])],
			async prompt(text: string) {
				const user = { role: "user", content: text, timestamp: Date.now() };
				messages.push(user); manager.appendMessage(user as never);
				const first = { role: "assistant", api: MODEL.api, provider: MODEL.provider, model: MODEL.id, timestamp: Date.now(), content: [{ type: "toolCall", id: "read-1", name: "m07_evidence_read", arguments: { path: "evidence.txt" } }], stopReason: "toolUse", usage: usage(30, 5) };
				messages.push(first); manager.appendMessage(first as never);
				const tool = options.customTools?.find((item) => item.name === "m07_evidence_read");
				assert(tool, "read-dir grant must install the real Pi material reader");
				const result = await tool.execute("read-1", { path: "evidence.txt" }, undefined, undefined, undefined as never);
				readReturned = JSON.stringify(result).includes("frozen source evidence");
				const second = { role: "assistant", api: MODEL.api, provider: MODEL.provider, model: MODEL.id, timestamp: Date.now(), content: [{ type: "text", text: "processed the frozen evidence" }], stopReason: "stop", usage: usage(40, 8) };
				messages.push(second); manager.appendMessage(second as never);
			},
			abort() {}, dispose() {},
		};
		return { session, extensionsResult: undefined } as unknown as Awaited<ReturnType<typeof createAgentSession>>;
	}) as typeof createAgentSession;
	const pi = new PiSessionRunner({ modelRuntime: RUNTIME, createSession: factory });
	const budget = new SharedBudget("offline-tool-turn", { maxProviderCalls: 5, maxInputTokens: 10_000, maxOutputTokens: 1_000, maxSdkEstimatedCost: 1, maxProbeCalls: 0, maxCpuMillis: 1_000, maxWallMillis: 20_000 });
	const events: UsageSummary[] = [];
	const metered = createWorkflowMeteredRunner(pi, budget, budget.root, events);
	const handle = await metered.create({ label: "M04-offline", role: "research", model: "offline/offline-model", systemPrompt: "Use the granted reader to inspect frozen evidence.", tools: { kind: "read-dir", root: materials, toolName: "m07_evidence_read" }, persistDir: root });
	const turn = await handle.prompt("Inspect evidence.txt and report what was read.");
	assert.equal(readReturned, true);
	assert.equal(turn.usage?.reportedEvents, 2);
	assert.equal(events[0]?.reportedEvents, 2);
	assert.equal(budget.status().committed.providerCalls, 2, "unused serial call allowance is returned after settlement");
	assert.equal("providerCalls" in budget.status().remaining, false);
	assert.equal(budget.status().settlement, "settled");
	assert.deepEqual(handle.readCoverage(), ["evidence.txt"]);
	assert.ok(handle.readReturnEvents().some((x) => x.path === "evidence.txt" && x.status === "returned"));
	handle.dispose();
});

test("tool-turn ledger retains missing usage but permits subsequent accounted turns", () => {
	const limits = { maxProviderCalls: 2, maxInputTokens: 100, maxOutputTokens: 100, maxSdkEstimatedCost: 1, maxProbeCalls: 0, maxCpuMillis: 1_000, maxWallMillis: 20_000 };
	const missing = new SharedBudget("unknown-turn", limits);
	const first = missing.reserveObservedTurn(missing.root);
	missing.markObservedTurnUnknown(first);
	assert.equal(missing.status().settlement, "pending-or-unknown");
	const next = missing.reserveObservedTurn(missing.root);
	missing.settleObservedTurn(next, settledUsage);
	assert.equal(missing.status().usageUnknown, true);
	const excess = new SharedBudget("excess-turn", limits);
	const second = excess.reserveObservedTurn(excess.root);
	excess.settleObservedTurn(second, { input: 20, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 25, cost: 0.03, reportedEvents: 3, unknownEvents: 0, complete: true, costComplete: true });
	assert.equal(excess.status().settlement, "settled");
	assert.equal(excess.status().committed.providerCalls, 3);
});

test("workflow I sends its own flat-action contract through the Pi SDK boundary", async (t) => {
	const root = await mkdtemp(path.join(os.tmpdir(), "pre-rsi-workflow-i-contract-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const sourceId = "development:20260924T011834Z-4f90:C001";
	const actualFirstAnswer = { kind: "inspect", read: { object: "development-feedback", id: sourceId, start: 0, maxChars: 4000 } };
	const visible = { sourceId, metaIds: [], methodIds: ["H0", "I0"], candidateIds: [] };
	assert.throws(() => validateWorkflowAction(actualFirstAnswer, visible), /outside the fixed/);
	assert.deepEqual(validateWorkflowAction({ kind: "inspect", object: "development-feedback", id: sourceId, start: 0, maxChars: 4000 }, visible), { kind: "inspect", object: "development-feedback", id: sourceId, start: 0, maxChars: 4000 });
	assert.throws(() => validateWorkflowAction({ kind: "inspect", object: "development-feedback", id: sourceId, start: 0, maxChars: 4001 }, visible), /outside the fixed/);
	let deliveredSystem = "", deliveredUser = "";
	const factory = (async (options: CreateAgentSessionOptions = {}) => {
		deliveredSystem = options.resourceLoader?.getSystemPrompt() ?? "";
		const manager = options.sessionManager!;
		const messages: unknown[] = [...manager.buildSessionContext().messages];
		const session = { sessionId: manager.getSessionId(), sessionFile: manager.getSessionFile(), messages, getActiveToolNames: () => [...(options.tools ?? [])],
			async prompt(message: string) {
				deliveredUser = message;
				const user = { role: "user", content: message, timestamp: Date.now() }; messages.push(user); manager.appendMessage(user as never);
				const assistant = { role: "assistant", api: MODEL.api, provider: MODEL.provider, model: MODEL.id, timestamp: Date.now(), content: [{ type: "text", text: JSON.stringify({ kind: "stop", reason: "offline contract check" }) }], stopReason: "stop", usage: usage(25, 8) };
				messages.push(assistant); manager.appendMessage(assistant as never);
			}, abort() {}, dispose() {} };
		return { session, extensionsResult: undefined } as unknown as Awaited<ReturnType<typeof createAgentSession>>;
	}) as typeof createAgentSession;
	const runner = new PiSessionRunner({ modelRuntime: RUNTIME, createSession: factory });
	const system = workflowImproverSystemPrompt("Use only frozen development evidence.");
	const message = workflowDecisionPrompt({ version: 1, environment: "m07-evidence-handoff/v1", developmentSource: { id: sourceId } });
	const handle = await runner.create({ label: "I-workflow-offline", role: "improver", model: "offline/offline-model", systemPrompt: system, tools: { kind: "none" }, persistDir: root });
	await handle.prompt(message);
	assert.ok(deliveredSystem.includes('"kind":"inspect","object":'));
	assert.ok(!deliveredSystem.includes('"kind":"inspect","read":'));
	assert.ok(!deliveredSystem.includes('"kind":"probe"'));
	assert.ok(deliveredUser.includes("workflow-only system contract"));
	assert.ok(!deliveredUser.includes("inspect.read"));
	assert.equal(deliveredUser.includes(sourceId), true);
	handle.dispose();
});
