import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { DeepSeekCampaignBudget } from "../../src/runner/deepseek-campaign.ts";
import { verifyDeepSeekProviderOutputLimit } from "../../src/runner/deepseek-provider-limits.ts";
import { PiSessionRunner } from "../../src/runner/pi.ts";

// Leave room for Pi 0.85.1's 4096-token context safety reserve in this retry fixture.
const WINDOW = 8192;
const MAX = 64;
const MESSAGES = WINDOW - 38;
const CORRECTED = WINDOW - MESSAGES;
const KEY = "sk-SYNTHETIC-CONTEXT-RETRY";
const MODEL = {
	id: "deepseek-flash", name: "Offline DeepSeek", provider: "deepseek", api: "openai-completions",
	baseUrl: "https://api.deepseek.com", reasoning: true, input: ["text"],
	cost: { input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0 },
	contextWindow: WINDOW, maxTokens: MAX,
	compat: { supportsStore: false, supportsDeveloperRole: false, maxTokensField: "max_tokens", thinkingFormat: "deepseek" },
} as Model<"openai-completions">;

function rejection(messages: number, completion = MAX, requested = messages + completion,
	window = WINDOW): Response {
	const message = `This model's maximum context length is ${window} tokens. However, you requested ${requested} tokens (${messages} in the messages, ${completion} in the completion). Please reduce the length of the messages or completion.`;
	return new Response(JSON.stringify({ error: { type: "invalid_request_error", code: "context_length_exceeded", message } }),
		{ status: 400, headers: { "content-type": "application/json" } });
}

function completion(): Response {
	const chunk = { id: "offline-completion", object: "chat.completion.chunk", created: 1,
		model: MODEL.id, choices: [{ index: 0, delta: { role: "assistant", content: "offline answer" }, finish_reason: "stop" }],
		usage: { prompt_tokens: 11, completion_tokens: 3, total_tokens: 14 } };
	return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`,
		{ status: 200, headers: { "content-type": "text/event-stream" } });
}

async function scenario(t: TestContext, first: () => Response,
	allowSuccess: boolean, model: Model<"openai-completions"> = MODEL) {
	const dir = await mkdtemp(path.join(tmpdir(), "pi-context-retry-"));
	const originalFetch = globalThis.fetch;
	const calls: Array<{ raw: string; payload: Record<string, unknown> }> = [];
	let unrelatedFetches = 0;
	let handle: Awaited<ReturnType<PiSessionRunner["create"]>> | undefined;
	t.after(async () => {
		handle?.dispose();
		globalThis.fetch = originalFetch;
		await rm(dir, { recursive: true, force: true });
	});
	const profile = path.join(dir, "profile"), sessions = path.join(dir, "sessions");
	await Promise.all([mkdir(profile), mkdir(sessions)]);
	await writeFile(path.join(profile, "models.json"), JSON.stringify({ providers: { deepseek: { models: [model] } } }));
	const runtime = await ModelRuntime.create({ modelsPath: path.join(profile, "models.json"),
		authPath: path.join(profile, "auth.json"), modelsStorePath: path.join(profile, "models-store.json"),
		allowModelNetwork: false, refreshOnCreate: false });
	await runtime.setRuntimeApiKey("deepseek", KEY);
	const provider = await verifyDeepSeekProviderOutputLimit({ apiKey: KEY,
		request: async () => new Response(JSON.stringify({ object: "list", data: [{ id: MODEL.id,
			object: "model", name: "DeepSeek-V4.1-Flash", max_output_tokens: MAX,
			context_window: model.contextWindow }] }), { status: 200 }) });
	const budget = new DeepSeekCampaignBudget({ model: "deepseek/deepseek-flash:low",
		endpoint: "https://api.deepseek.com", providerOutputLimit: provider,
		outputAccountingMarginTokens: 0 });
	globalThis.fetch = async (input, init) => {
		const url = input instanceof Request ? input.url : String(input);
		if (url !== "https://api.deepseek.com/chat/completions") {
			unrelatedFetches++;
			throw new Error("unexpected network route");
		}
		const raw = init?.body;
		if (typeof raw !== "string") throw new Error("SDK request body was not serialized text");
		const payload = JSON.parse(raw) as Record<string, unknown>;
		const headers = new Headers(input instanceof Request ? input.headers : undefined);
		new Headers(init?.headers).forEach((value, name) => headers.set(name, value));
		assert.equal(headers.get("authorization"), `Bearer ${KEY}`);
		calls.push({ raw, payload });
		if (calls.length === 1) return first();
		if (allowSuccess && calls.length === 2) return completion();
		throw new Error("unexpected extra transport");
	};
	handle = await new PiSessionRunner({ modelRuntime: runtime, campaignBudget: budget }).create({
		label: "offline-context-capacity", role: "execution", model: "deepseek/deepseek-flash:low",
		systemPrompt: "synthetic offline fixture", tools: { kind: "none" }, persistDir: sessions,
	});
	return { calls, budget, handle, sessions, unrelatedFetches: () => unrelatedFetches };
}

test("real Pi context clamp is observed and exhausted context remains incomplete", async t => {
	const smallWindow = 128;
	const model = { ...MODEL, contextWindow: smallWindow };
	const run = await scenario(t, () => rejection(smallWindow, 1, smallWindow + 1, smallWindow), false, model);
	await assert.rejects(run.handle.prompt("synthetic request"), /provider request failed/);
	assert.equal(run.calls.length, 1);
	assert.equal(run.calls[0].payload.max_tokens, 1);
	assert.deepEqual(run.handle.providerOutputRequests?.(), [{ resolvedMaxTokens: MAX,
		outputField: "max_tokens", outgoingMaxTokens: 1 }]);
	const audit = run.budget.requestAccountingAuditSnapshot();
	assert.equal(audit.requests.length, 1);
	assert.equal(audit.requests[0].maxOutputTokens, 1);
	assert.equal(audit.requests[0].status, "unknown");
	assert.equal(audit.requests[0].reportedUsage, null);
	assert.equal(run.handle.transportDiagnostics?.()[0]?.responseStarted, true);
});

test("real Pi retries an exact provider context rejection with only the output cap reduced", async t => {
	const run = await scenario(t, () => rejection(MESSAGES), true);
	const turn = await run.handle.prompt("synthetic request");
	assert.match(JSON.stringify(turn), /offline answer/);
	assert.equal(run.calls.length, 2);
	assert.equal(run.calls[0].payload.max_tokens, MAX);
	assert.equal(run.calls[1].payload.max_tokens, CORRECTED);
	const original = { ...run.calls[0].payload, max_tokens: CORRECTED };
	assert.equal(run.calls[1].raw, JSON.stringify(original), "retry changes no other serialized request field");
	const audit = run.budget.requestAccountingAuditSnapshot();
	assert.equal(audit.requests.length, 2);
	assert.notEqual(audit.requests[0].requestId, audit.requests[1].requestId);
	assert.equal(audit.requests[1].retryOfRequestId, audit.requests[0].requestId);
	assert.deepEqual(audit.requests.map(r => r.maxOutputTokens), [MAX, CORRECTED]);
	assert.deepEqual(audit.requests.map(r => r.status), ["unknown", "unknown"]);
	assert.equal(audit.requests[0].responseReceived, true);
	assert.equal(audit.requests[0].reportedUsage, null, "HTTP 400 has no assistant usage or free invoice claim");
	assert.equal(audit.requests[1].reportedUsage?.totalTokens, 14);
	const carry = run.budget.requestAuditSnapshot();
	assert.equal(carry.reservations, 2);
	assert.deepEqual(carry.requests.map(r => [r.status, r.maxOutputTokens]),
		[["unknown", MAX], ["unknown", CORRECTED]]);
	assert.equal(audit.requests[1].retryOfRequestId, audit.requests[0].requestId);
	const diagnostic = run.handle.transportDiagnostics?.() ?? [];
	assert.equal(diagnostic.length, 1);
	assert.equal(diagnostic[0].requestId, audit.requests[0].requestId);
	assert.deepEqual(diagnostic[0].providerContextOverflow, { contextWindow: WINDOW,
		messagesTokens: MESSAGES, completionTokens: MAX,
		requestedTokens: MESSAGES + MAX, allowedCompletionTokens: CORRECTED });
	assert.doesNotMatch(JSON.stringify(diagnostic), /SYNTHETIC-CONTEXT-RETRY|synthetic request|chat\/completions/);
	assert.equal(run.unrelatedFetches(), 0);
	const usage = await readFile(run.handle.ref.file!.replace(/\.jsonl$/, ".usage.jsonl"), "utf8");
	assert.deepEqual(JSON.parse(usage.trim()).requestIds, audit.requests.map(r => r.requestId));
});

test("context retry preserves Pi's alternate output field", async t => {
	const model = { ...MODEL, compat: { ...MODEL.compat, maxTokensField: "max_completion_tokens" as const } };
	const run = await scenario(t, () => rejection(MESSAGES), true, model);
	await run.handle.prompt("synthetic request");
	assert.equal(run.calls.length, 2);
	assert.equal(run.calls[0].payload.max_completion_tokens, MAX);
	assert.equal(run.calls[1].payload.max_completion_tokens, CORRECTED);
	assert.equal(run.calls[0].payload.max_tokens, undefined);
	assert.equal(run.calls[1].payload.max_tokens, undefined);
	assert.deepEqual(run.budget.requestAccountingAuditSnapshot().requests.map(r => r.outputTokenField),
		["max_completion_tokens", "max_completion_tokens"]);
});

for (const [label, first] of [
	["inconsistent token sum", () => rejection(MESSAGES, MAX, MESSAGES + MAX + 1)],
	["completion count differs from sent payload", () => rejection(MESSAGES + 1, MAX - 1)],
	["no output room remains", () => rejection(WINDOW)],
] as const) {
	test(`real Pi does not retry context rejection with ${label}`, async t => {
		const run = await scenario(t, first, false);
		await assert.rejects(run.handle.prompt("synthetic request"));
		assert.equal(run.calls.length, 1);
		assert.equal(run.calls[0].payload.max_tokens, MAX);
		const audit = run.budget.requestAccountingAuditSnapshot();
		assert.equal(audit.requests.length, 1);
		assert.equal(audit.requests[0].status, "unknown");
		assert.equal(run.handle.transportDiagnostics?.()[0]?.responseStarted, true);
		assert.equal(audit.requests[0].reportedUsage, null);
		assert.equal(run.unrelatedFetches(), 0);
	});
}
