import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { DeepSeekCampaignBudget } from "../../src/runner/deepseek-campaign.ts";
import { verifyDeepSeekProviderOutputLimit } from "../../src/runner/deepseek-provider-limits.ts";
import { PiSessionRunner, type PiSessionRunnerOptions } from "../../src/runner/pi.ts";

const WINDOW = 128;
const MAX = 64;
const MESSAGES = 90;
const MODEL = {
	id: "deepseek-flash", name: "Offline DeepSeek", provider: "deepseek", api: "openai-completions",
	baseUrl: "https://api.deepseek.com", reasoning: true, input: ["text"],
	cost: { input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0 },
	contextWindow: WINDOW, maxTokens: MAX,
	compat: { supportsStore: false, supportsDeveloperRole: false, maxTokensField: "max_tokens", thinkingFormat: "deepseek" },
} as Model<"openai-completions">;

type Audit = ReturnType<DeepSeekCampaignBudget["requestAccountingAuditSnapshot"]>;
type Boundary = NonNullable<PiSessionRunnerOptions["onCampaignAccountingBoundary"]>;

function rejection(): Response {
	const requested = MESSAGES + MAX;
	const message = `This model's maximum context length is ${WINDOW} tokens. However, you requested ${requested} tokens (${MESSAGES} in the messages, ${MAX} in the completion). Please reduce the length of the messages or completion.`;
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

async function scenario(t: TestContext, onBoundary: Boundary, fakeFetch: (call: number, body: string) => Response) {
	const dir = await mkdtemp(path.join(tmpdir(), "pi-accounting-boundary-"));
	const previousFetch = globalThis.fetch;
	let fetchCount = 0;
	let handle: Awaited<ReturnType<PiSessionRunner["create"]>> | undefined;
	t.after(async () => { handle?.dispose(); globalThis.fetch = previousFetch; await rm(dir, { recursive: true, force: true }); });
	const profile = path.join(dir, "profile"), sessions = path.join(dir, "sessions");
	await Promise.all([mkdir(profile), mkdir(sessions)]);
	await writeFile(path.join(profile, "models.json"), JSON.stringify({ providers: { deepseek: { models: [MODEL] } } }));
	const runtime = await ModelRuntime.create({ modelsPath: path.join(profile, "models.json"),
		authPath: path.join(profile, "auth.json"), modelsStorePath: path.join(profile, "models-store.json"),
		allowModelNetwork: false, refreshOnCreate: false });
	await runtime.setRuntimeApiKey("deepseek", "sk-SYNTHETIC-ONLY");
	const provider = await verifyDeepSeekProviderOutputLimit({ apiKey: "synthetic",
		request: async () => new Response(JSON.stringify({ object: "list", data: [{ id: MODEL.id,
			object: "model", name: "DeepSeek-V4.1-Flash", max_output_tokens: MAX,
			context_window: WINDOW }] }), { status: 200 }) });
	const budget = new DeepSeekCampaignBudget({ model: "deepseek/deepseek-flash:low",
		endpoint: "https://api.deepseek.com", providerOutputLimit: provider, outputAccountingMarginTokens: 0 });
	globalThis.fetch = async (input, init) => {
		assert.equal(input instanceof Request ? input.url : String(input), "https://api.deepseek.com/chat/completions");
		assert.equal(typeof init?.body, "string");
		fetchCount++;
		return fakeFetch(fetchCount, init?.body as string);
	};
	handle = await new PiSessionRunner({ modelRuntime: runtime, campaignBudget: budget,
		onCampaignAccountingBoundary: onBoundary }).create({ label: "offline-boundary", role: "execution",
		model: "deepseek/deepseek-flash:low", systemPrompt: "synthetic fixture", tools: { kind: "none" }, persistDir: sessions });
	return { handle, budget, fetchCount: () => fetchCount };
}

test("a failed reservation checkpoint prevents HTTP dispatch and leaves an incomplete request", async t => {
	const committed: Array<{ event: string; audit: Audit }> = [];
	const run = await scenario(t, async (event, audit) => {
		committed.push({ event, audit });
		throw new Error("synthetic checkpoint write failure");
	}, () => { throw new Error("HTTP was issued before checkpoint"); });
	await assert.rejects(run.handle.prompt("synthetic prompt"), /provider request failed/);
	assert.equal(run.fetchCount(), 0);
	assert.deepEqual(committed.map(row => row.event), ["request-reserved"]);
	assert.equal(committed[0].audit.requests.length, 1);
	assert.equal(committed[0].audit.requests[0].status, "in-flight");
	assert.equal(committed[0].audit.requests[0].responseReceived, false);
	assert.equal(run.budget.requestAccountingAuditSnapshot().requests[0].status, "unknown");
	assert.equal(run.budget.requestAccountingAuditSnapshot().requests[0].responseReceived, false);
});

test("context retry checkpoints the received unknown predecessor and distinct retry reservation before HTTP", async t => {
	const committed: Array<{ event: string; audit: Audit }> = [];
	const run = await scenario(t, async (event, audit) => {
		await Promise.resolve();
		committed.push({ event, audit });
	}, (call, body) => {
		const payload = JSON.parse(body) as { max_tokens: number };
		if (call === 1) {
			assert.deepEqual(committed.map(row => row.event), ["request-reserved"]);
			assert.equal(committed[0].audit.requests[0].status, "in-flight");
			assert.equal(payload.max_tokens, MAX);
			return rejection();
		}
		assert.equal(call, 2);
		assert.deepEqual(committed.map(row => row.event),
			["request-reserved", "request-observed", "request-reserved"]);
		const rejected = committed[1].audit.requests;
		assert.equal(rejected.length, 1);
		assert.equal(rejected[0].responseReceived, true);
		assert.equal(rejected[0].status, "unknown");
		assert.equal(rejected[0].contextRejected, true);
		const reserved = committed[2].audit.requests;
		assert.equal(reserved.length, 2);
		assert.equal(reserved[0].requestId, rejected[0].requestId);
		assert.notEqual(reserved[1].requestId, reserved[0].requestId);
		assert.equal(reserved[1].retryOfRequestId, reserved[0].requestId);
		assert.equal(reserved[1].status, "in-flight");
		assert.equal(payload.max_tokens, WINDOW - MESSAGES);
		return completion();
	});
	await run.handle.prompt("synthetic prompt");
	assert.equal(run.fetchCount(), 2);
	assert.deepEqual(committed.map(row => row.event),
		["request-reserved", "request-observed", "request-reserved", "request-observed"]);
	assert.equal(committed[3].audit.requests[0].status, "unknown");
	assert.equal(committed[3].audit.requests[0].responseReceived, true);
	assert.equal(committed[3].audit.requests[1].responseReceived, true);
	assert.equal(committed[3].audit.requests[1].reportedUsage?.totalTokens, 14);
});

test("a failed retry reservation checkpoint prevents corrected HTTP without erasing the received first request", async t => {
	const committed: Array<{ event: string; audit: Audit }> = [];
	const run = await scenario(t, async (event, audit) => {
		committed.push({ event, audit });
		if (committed.length === 3) throw new Error("synthetic retry checkpoint failure");
	}, (call) => {
		assert.equal(call, 1);
		return rejection();
	});
	await assert.rejects(run.handle.prompt("synthetic prompt"));
	assert.equal(run.fetchCount(), 1);
	assert.deepEqual(committed.map(row => row.event),
		["request-reserved", "request-observed", "request-reserved"]);
	const audit = run.budget.requestAccountingAuditSnapshot();
	assert.equal(audit.requests.length, 2);
	assert.equal(audit.requests[0].status, "unknown");
	assert.equal(audit.requests[0].responseReceived, true);
	assert.equal(audit.requests[1].status, "unknown");
	assert.equal(audit.requests[1].responseReceived, false);
});
