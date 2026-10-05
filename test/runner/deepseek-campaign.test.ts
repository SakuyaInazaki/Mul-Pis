import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createAgentSession, ModelRuntime, type CreateAgentSessionOptions } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { DeepSeekCampaignBudget, type DeepSeekCampaignLimits } from "../../src/runner/deepseek-campaign.ts";
import { createConfinedCampaignFileTools } from "../../src/runner/confined-campaign-files.ts";
import { PiSessionRunner } from "../../src/runner/pi.ts";
import type { SessionSpec } from "../../src/runner/types.ts";

const MODEL = {
	id: "deepseek-flash", name: "Offline DeepSeek", provider: "deepseek", api: "openai-completions",
	baseUrl: "https://api.deepseek.com", reasoning: true, input: ["text"],
	cost: { input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0 },
	contextWindow: 10000, maxTokens: 100,
} as Model<"openai-completions">;

const LIMITS: DeepSeekCampaignLimits = {
	model: "deepseek/deepseek-flash:low", endpoint: "https://api.deepseek.com",
	maxCny: 0.006, maxProviderCalls: 2, maxProviderCallsPerPrompt: 2,
	maxOutputTokens: 20, outputAccountingMarginTokens: 32,
	maxInputCnyPerMillionTokens: 4, maxOutputCnyPerMillionTokens: 16, cnyPerUsdCeiling: 10,
};

function spec(dir: string, label: string, tools: SessionSpec["tools"] = { kind: "none" }): SessionSpec {
	return { label, role: "execution", model: LIMITS.model, systemPrompt: "offline test", tools, persistDir: dir };
}

function offlineRuntime(sent: { count: number; options: Array<{ maxTokens?: number; maxRetries?: number }> }, requestModel: Model<"openai-completions"> = MODEL): ModelRuntime {
	return {
		getModels: () => [MODEL],
		async streamSimple(model: Model<"openai-completions">, _context: unknown, options: { maxTokens?: number; maxRetries?: number; onPayload?: (payload: unknown, model: Model<"openai-completions">) => Promise<unknown> }) {
			sent.options.push({ maxTokens: options.maxTokens, maxRetries: options.maxRetries });
			await options.onPayload?.({ model: model.id, messages: [{ role: "user", content: "offline" }], max_tokens: options.maxTokens }, requestModel);
			sent.count++;
		},
	} as unknown as ModelRuntime;
}

function offlineFactory(rounds: number): typeof createAgentSession {
	return (async (options: CreateAgentSessionOptions = {}) => {
		const manager = options.sessionManager!;
		const messages: unknown[] = [];
		return {
			session: {
				sessionId: manager.getSessionId(), sessionFile: manager.getSessionFile(), messages,
				getActiveToolNames: () => options.tools ?? [],
				async prompt(text: string) {
					const user = { role: "user", content: text, timestamp: Date.now() };
					messages.push(user); manager.appendMessage(user as never);
					for (let i = 0; i < rounds; i++) {
						await (options.modelRuntime as unknown as { streamSimple: (model: unknown, context: unknown, options: unknown) => Promise<unknown> }).streamSimple(options.model, { messages }, {});
						const assistant = {
							role: "assistant", api: MODEL.api, provider: MODEL.provider, model: MODEL.id,
							content: [{ type: "text", text: `round ${i + 1}` }], stopReason: i < rounds - 1 ? "toolUse" : "stop",
							timestamp: Date.now(), usage: { input: 10, output: 4, cacheRead: 0, cacheWrite: 0, totalTokens: 14,
								cost: { input: 0.000003, output: 0.0000048, cacheRead: 0, cacheWrite: 0, total: 0.0000078 } },
						};
						messages.push(assistant); manager.appendMessage(assistant as never);
					}
				},
				abort() {}, dispose() {},
			},
		} as unknown as Awaited<ReturnType<typeof createAgentSession>>;
	}) as typeof createAgentSession;
}

test("campaign reserves each tool-loop provider request before transport, then refuses a third", async (t) => {
	const dir = await mkdtemp(path.join(tmpdir(), "deepseek-campaign-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const sent = { count: 0, options: [] as Array<{ maxTokens?: number; maxRetries?: number }> };
	const budget = new DeepSeekCampaignBudget(LIMITS);
	const runner = new PiSessionRunner({ modelRuntime: offlineRuntime(sent), createSession: offlineFactory(2), campaignBudget: budget });
	const builder = await runner.create(spec(dir, "builder", { kind: "custom", tools: await createConfinedCampaignFileTools(dir, { writableFiles: ["candidate.cpp"] }) }));
	assert.equal((await builder.prompt("build")).text, "round 2");
	assert.equal(sent.count, 2);
	assert.deepEqual(sent.options, [{ maxTokens: 20, maxRetries: 0 }, { maxTokens: 20, maxRetries: 0 }]);
	assert.equal(budget.snapshot().reservations, 2);
	assert.equal(budget.snapshot().stopped, false);
	const reviewer = await runner.create(spec(dir, "reviewer"));
	await assert.rejects(reviewer.prompt("review"), /campaign call or CNY planning ceiling exhausted/);
	assert.equal(sent.count, 2, "denied request must not reach transport");
	assert.equal(budget.snapshot().stopped, true);
	assert.equal(budget.snapshot().stopReason, "ceiling");
	builder.dispose(); reviewer.dispose();
});

test("campaign rejects endpoint changes and unavailable payload sizes closed", async (t) => {
	const dir = await mkdtemp(path.join(tmpdir(), "deepseek-campaign-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const changed = { ...MODEL, baseUrl: "https://evil.invalid" };
	const sent = { count: 0, options: [] as Array<{ maxTokens?: number; maxRetries?: number }> };
	const budget = new DeepSeekCampaignBudget(LIMITS);
	const runner = new PiSessionRunner({ modelRuntime: offlineRuntime(sent, changed), createSession: offlineFactory(1), campaignBudget: budget });
	const handle = await runner.create(spec(dir, "changed-endpoint"));
	await assert.rejects(handle.prompt("x"), /DeepSeek model, endpoint or price ceiling did not verify/);
	assert.equal(sent.count, 0);
	assert.equal(budget.snapshot().stopped, true);
	assert.equal(budget.snapshot().stopReason, "prompt-failure");
	await assert.rejects(handle.prompt("again"), /campaign is stopped/);
	handle.dispose();

	const direct = new DeepSeekCampaignBudget(LIMITS);
	direct.beginPrompt();
	assert.throws(() => direct.reserve(0), /payload byte count is unavailable/);
	assert.equal(direct.snapshot().stopped, true);
	assert.equal(direct.snapshot().stopReason, "payload-boundary");
	assert.throws(() => direct.beginPrompt(), /campaign is stopped/);
});

test("campaign accepts input above the former 96 KB cap and reserves its actual serialized bytes", async (t) => {
	const dir = await mkdtemp(path.join(tmpdir(), "deepseek-campaign-dynamic-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const content = "x".repeat(110_000);
	const payload = { model: "deepseek-flash", messages: [{ role: "user", content }], max_tokens: 20 };
	const payloadBytes = Buffer.byteLength(JSON.stringify(payload), "utf8");
	assert(payloadBytes > 96_000);
	let dispatched = 0;
	const runtime = {
		getModels: () => [MODEL],
		async streamSimple(model: Model<"openai-completions">, _context: unknown, options: { onPayload?: (payload: unknown, model: Model<"openai-completions">) => Promise<unknown> }) {
			await options.onPayload?.(payload, model);
			dispatched++;
		},
	} as unknown as ModelRuntime;
	const budget = new DeepSeekCampaignBudget({ ...LIMITS, maxCny: 1, maxProviderCalls: 1, maxProviderCallsPerPrompt: 1 });
	const handle = await new PiSessionRunner({ modelRuntime: runtime, createSession: offlineFactory(1), campaignBudget: budget }).create(spec(dir, "large-input"));
	await handle.prompt("offline");
	const expectedCny = (payloadBytes * LIMITS.maxInputCnyPerMillionTokens +
		(LIMITS.maxOutputTokens + LIMITS.outputAccountingMarginTokens) * LIMITS.maxOutputCnyPerMillionTokens) / 1_000_000;
	assert.equal(dispatched, 1);
	assert.equal(budget.snapshot().reservedCny, expectedCny);
	assert.equal(budget.snapshot().stopped, false);
	handle.dispose();
});

test("campaign rejects inconsistent simultaneous provider output-cap fields before transport", async (t) => {
	const dir = await mkdtemp(path.join(tmpdir(), "deepseek-campaign-cap-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	let dispatched = 0;
	const runtime = {
		getModels: () => [MODEL],
		async streamSimple(model: Model<"openai-completions">, _context: unknown, options: { onPayload?: (payload: unknown, model: Model<"openai-completions">) => Promise<unknown> }) {
			await options.onPayload?.({ model: model.id, messages: [], max_tokens: 20, max_completion_tokens: 50 }, model);
			dispatched++;
		},
	} as unknown as ModelRuntime;
	const budget = new DeepSeekCampaignBudget(LIMITS);
	const handle = await new PiSessionRunner({ modelRuntime: runtime, createSession: offlineFactory(1), campaignBudget: budget }).create(spec(dir, "inconsistent-cap"));
	await assert.rejects(handle.prompt("offline"), /output cap missing or inconsistent/);
	assert.equal(dispatched, 0);
	assert.equal(budget.snapshot().reservations, 0);
	assert.equal(budget.snapshot().stopped, true);
	handle.dispose();
});

test("campaign denies the next large payload before transport when cumulative CNY would exceed the ceiling", async (t) => {
	const dir = await mkdtemp(path.join(tmpdir(), "deepseek-campaign-money-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	let dispatched = 0;
	const payload = { model: "deepseek-flash", messages: [{ role: "user", content: "x".repeat(120_000) }], max_tokens: 20 };
	const payloadBytes = Buffer.byteLength(JSON.stringify(payload), "utf8");
	const runtime = {
		getModels: () => [MODEL],
		async streamSimple(model: Model<"openai-completions">, _context: unknown, options: { onPayload?: (payload: unknown, model: Model<"openai-completions">) => Promise<unknown> }) {
			await options.onPayload?.(payload, model);
			dispatched++;
		},
	} as unknown as ModelRuntime;
	const budget = new DeepSeekCampaignBudget({ ...LIMITS, maxCny: 0.5, maxProviderCalls: 2 });
	const handle = await new PiSessionRunner({ modelRuntime: runtime, createSession: offlineFactory(2), campaignBudget: budget }).create(spec(dir, "money-ceiling"));
	await assert.rejects(handle.prompt("offline"), /campaign call or CNY planning ceiling exhausted/);
	const firstReservation = (payloadBytes * LIMITS.maxInputCnyPerMillionTokens +
		(LIMITS.maxOutputTokens + LIMITS.outputAccountingMarginTokens) * LIMITS.maxOutputCnyPerMillionTokens) / 1_000_000;
	assert.equal(budget.snapshot().reservedCny, firstReservation);
	assert.equal(budget.snapshot().reservations, 1);
	assert.equal(dispatched, 1, "denied second payload must not reach the transport");
	assert.equal(budget.snapshot().stopReason, "ceiling");
	handle.dispose();
});

test("campaign refuses native execution tools, which could bypass provider metering", async (t) => {
	const dir = await mkdtemp(path.join(tmpdir(), "deepseek-campaign-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const sent = { count: 0, options: [] as Array<{ maxTokens?: number; maxRetries?: number }> };
	const runner = new PiSessionRunner({ modelRuntime: offlineRuntime(sent), createSession: offlineFactory(1), campaignBudget: new DeepSeekCampaignBudget(LIMITS) });
	await assert.rejects(runner.create(spec(dir, "native-tools", { kind: "execution", root: dir, tools: ["read", "write", "edit", "bash"] })), /native execution tools are unsafe/);
	await assert.rejects(runner.create(spec(dir, "unreviewed-custom", { kind: "custom", tools: [{ name: "network", description: "unsafe", params: {}, execute: async () => ({ text: "bad" }) }] })), /audited confined file grant/);
	await assert.rejects(runner.create(spec(dir, "extra-tool", { kind: "read-dir", root: dir, extraTools: [{ name: "network", description: "unsafe", params: {}, execute: async () => ({ text: "bad" }) }] })), /cannot include arbitrary extra tools/);
	assert.equal(sent.count, 0);
});

test("audited campaign file tools confine reads and allowlisted writes", async (t) => {
	const dir = await mkdtemp(path.join(tmpdir(), "deepseek-campaign-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const outside = path.join(dir, "..", `outside-${path.basename(dir)}.txt`);
	await writeFile(outside, "private");
	t.after(() => rm(outside, { force: true }));
	await symlink(outside, path.join(dir, "escape.txt"));
	const [read, write, edit] = await createConfinedCampaignFileTools(dir, { writableFiles: ["candidate.cpp"] });
	await assert.rejects(read.execute({ path: "../outside.txt" }), /bounded relative file path/);
	await assert.rejects(read.execute({ path: "escape.txt" }), /regular file inside/);
	await assert.rejects(write.execute({ path: "other.cpp", content: "bad" }), /write allowlist/);
	await write.execute({ path: "candidate.cpp", content: "int main() { return 0; }" });
	await edit.execute({ path: "candidate.cpp", oldText: "return 0", newText: "return 1" });
	assert.equal(await readFile(path.join(dir, "candidate.cpp"), "utf8"), "int main() { return 1; }");
	assert.equal((await read.execute({ path: "candidate.cpp" })).text, "int main() { return 1; }");
	assert.throws(() => { (write as { execute: unknown }).execute = async () => ({ text: "unsafe" }); }, /read only|Cannot assign/);
	const mutable = [read, write, edit];
	const bounded = new DeepSeekCampaignBudget(LIMITS).boundSpec(spec(dir, "immutable-tools", { kind: "custom", tools: mutable }));
	mutable[0] = { name: "network", description: "unsafe", params: {}, execute: async () => ({ text: "bad" }) };
	assert.equal(bounded.tools.kind, "custom");
	if (bounded.tools.kind === "custom") {
		assert.equal(bounded.tools.tools[0], read);
		assert(Object.isFrozen(bounded.tools.tools));
	}
});

test("no-campaign strict path remains exactly one tool-free provider request", async (t) => {
	const dir = await mkdtemp(path.join(tmpdir(), "deepseek-campaign-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const sent = { count: 0, options: [] as Array<{ maxTokens?: number; maxRetries?: number }> };
	const runner = new PiSessionRunner({ modelRuntime: offlineRuntime(sent), createSession: offlineFactory(2) });
	await assert.rejects(runner.create({ ...spec(dir, "regression"), strictRequest: {
		maxProviderCallsPerPrompt: 2, maxInputPayloadBytes: 500, maxOutputTokens: 20,
	} }), /strict request requires positive integer caps/);
	assert.equal(sent.count, 0);
});

test("campaign halts when usage ledger cannot be persisted after a successful response", async (t) => {
	const dir = await mkdtemp(path.join(tmpdir(), "deepseek-campaign-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const sent = { count: 0, options: [] as Array<{ maxTokens?: number; maxRetries?: number }> };
	const budget = new DeepSeekCampaignBudget(LIMITS);
	const runner = new PiSessionRunner({ modelRuntime: offlineRuntime(sent), createSession: offlineFactory(1), campaignBudget: budget });
	const handle = await runner.create(spec(dir, "disk-error"));
	await mkdir(handle.ref.file!.replace(/\.jsonl$/, ".usage.jsonl"));
	await assert.rejects(handle.prompt("one"), /EISDIR|illegal operation on a directory/);
	assert.equal(sent.count, 1);
	assert.equal(budget.snapshot().reservations, 1);
	assert.equal(budget.snapshot().stopped, true);
	assert.equal(budget.snapshot().stopReason, "prompt-failure");
	const retained = budget.snapshot().reservedCny;
	assert(retained > 0, "unknown outcome must retain its full dynamic reservation");
	await assert.rejects(handle.prompt("no retry"), /campaign is stopped/);
	assert.equal(budget.snapshot().reservedCny, retained, "unknown outcome cannot refund the reservation");
	handle.dispose();
});

test("campaign reconciles reported tokens and SDK cost against each reserved envelope", () => {
	for (const usage of [
		{ input: 501, output: 4, cacheRead: 0, cacheWrite: 0, totalTokens: 505, cost: 0.00001 },
		{ input: 10, output: 53, cacheRead: 0, cacheWrite: 0, totalTokens: 63, cost: 0.00001 },
		{ input: 10, output: 4, cacheRead: 0, cacheWrite: 0, totalTokens: 14, cost: 1 },
		{ input: 10, output: 4, cacheRead: 0, cacheWrite: 0, totalTokens: 13, cost: 0.00001 },
	]) {
		const budget = new DeepSeekCampaignBudget(LIMITS);
		budget.beginPrompt(); budget.reserve(100);
		assert.throws(() => budget.finishPrompt([{ entryId: "offline", kind: "assistant", promptIndex: 1,
			at: new Date().toISOString(), provider: "deepseek", model: "deepseek-flash", stopReason: "stop",
			usage, status: "reported", costStatus: "priced", costSource: "sdk-estimate" }]), /provider usage or call outcome/);
		assert.equal(budget.snapshot().stopped, true);
		assert.equal(budget.snapshot().stopReason, "usage-reconciliation");
		assert.equal(budget.snapshot().reservations, 1);
	}
});

test("campaign reconciles each usage event against its own differently sized input reservation", () => {
	const budget = new DeepSeekCampaignBudget({ ...LIMITS, maxCny: 1 });
	budget.beginPrompt();
	budget.reserve(100);
	budget.reserve(120_000);
	const retained = budget.snapshot().reservedCny;
	const event = (id: string, input: number) => ({ entryId: id, kind: "assistant" as const, promptIndex: 1,
		at: new Date().toISOString(), provider: "deepseek", model: "deepseek-flash", stopReason: "toolUse",
		usage: { input, output: 4, cacheRead: 0, cacheWrite: 0, totalTokens: input + 4, cost: 0.00001 },
		status: "reported" as const, costStatus: "priced" as const, costSource: "sdk-estimate" as const });
	assert.throws(() => budget.finishPrompt([event("first", 101), event("second", 100)]), /provider usage or call outcome/);
	assert.equal(budget.snapshot().stopReason, "usage-reconciliation");
	assert.equal(budget.snapshot().reservations, 2);
	assert.equal(budget.snapshot().reservedCny, retained, "ambiguous usage must not refund either request");
});

test("real Pi tool request uses the synthetic runtime key at the fixed DeepSeek endpoint", async () => {
	const dir = await mkdtemp(path.join(tmpdir(), "deepseek-auth-transport-"));
	const originalFetch = globalThis.fetch;
	let unexpectedFetches = 0;
	globalThis.fetch = async () => { unexpectedFetches++; throw new Error("unexpected network path in offline auth test"); };
	let handle: Awaited<ReturnType<PiSessionRunner["create"]>> | undefined;
	try {
		const profile = path.join(dir, "profile"), work = path.join(dir, "work"), sessions = path.join(dir, "sessions");
		await Promise.all([mkdir(profile), mkdir(work), mkdir(sessions)]);
		const modelsPath = path.join(profile, "models.json");
		await writeFile(modelsPath, JSON.stringify({ providers: { deepseek: { models: [{ ...MODEL,
			compat: { supportsStore: false, supportsDeveloperRole: false, maxTokensField: "max_tokens", thinkingFormat: "deepseek" },
		}] } } }));
		const runtime = await ModelRuntime.create({ modelsPath, authPath: path.join(profile, "auth.json"),
			modelsStorePath: path.join(profile, "models-store.json"), allowModelNetwork: false, refreshOnCreate: false });
		const syntheticKey = "sk-SYNTHETIC-OFFLINE-ONLY";
		await runtime.setRuntimeApiKey("deepseek", syntheticKey);
		const calls: Array<{ endpointMatches: boolean; authorizationMatches: boolean; hasTools: boolean }> = [];
		let transportPayloadBytes: number | undefined;
		const fakeFetch: typeof fetch = async (input, init) => {
			const headers = new Headers(input instanceof Request ? input.headers : undefined);
			new Headers(init?.headers).forEach((value, name) => headers.set(name, value));
			const endpoint = input instanceof Request ? input.url : String(input);
			const payload = typeof init?.body === "string" ? JSON.parse(init.body) as { tools?: unknown[] } : undefined;
			transportPayloadBytes = typeof init?.body === "string" ? Buffer.byteLength(init.body, "utf8") : undefined;
			calls.push({ endpointMatches: endpoint === "https://api.deepseek.com/chat/completions",
				authorizationMatches: headers.get("authorization") === `Bearer ${syntheticKey}`,
				hasTools: Array.isArray(payload?.tools) && payload.tools.length === 3 });
			return new Response(JSON.stringify({ error: { message: "offline synthetic rejection", type: "invalid_request_error" } }),
				{ status: 401, headers: { "content-type": "application/json" } });
		};
		const originalStream = runtime.streamSimple.bind(runtime);
		runtime.streamSimple = ((model, context, options) => originalStream(model, context, { ...options, fetch: fakeFetch })) as typeof runtime.streamSimple;
		const budget = new DeepSeekCampaignBudget({ ...LIMITS, maxCny: 1, maxProviderCalls: 1,
			maxProviderCallsPerPrompt: 1, maxOutputTokens: 32 });
		const runner = new PiSessionRunner({ modelRuntime: runtime, campaignBudget: budget });
		const tools = await createConfinedCampaignFileTools(work, { writableFiles: ["candidate.cpp"] });
		handle = await runner.create(spec(sessions, "real-pi-auth", { kind: "custom", tools }));
		await assert.rejects(handle.prompt("Offline authentication check."));
		assert.deepEqual(calls, [{ endpointMatches: true, authorizationMatches: true, hasTools: true }]);
		assert.equal(unexpectedFetches, 0);
		assert.equal(budget.snapshot().reservations, 1);
		assert(transportPayloadBytes !== undefined && transportPayloadBytes > 0);
		const expectedReserve = (transportPayloadBytes * LIMITS.maxInputCnyPerMillionTokens +
			(32 + LIMITS.outputAccountingMarginTokens) * LIMITS.maxOutputCnyPerMillionTokens) / 1_000_000;
		assert.equal(budget.snapshot().reservedCny, expectedReserve, "onPayload must measure the HTTP body the pinned SDK actually sends");
	} finally {
		handle?.dispose();
		globalThis.fetch = originalFetch;
		await rm(dir, { recursive: true, force: true });
	}
});
