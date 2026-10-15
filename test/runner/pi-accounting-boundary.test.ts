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

// Pi 0.85.1 keeps 4096 context tokens in reserve before building this request.
const WINDOW = 8192;
const MAX = 64;
const MODEL = {
	id: "deepseek-flash", name: "Offline DeepSeek", provider: "deepseek", api: "openai-completions",
	baseUrl: "https://api.deepseek.com", reasoning: true, input: ["text"],
	cost: { input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0 },
	contextWindow: WINDOW, maxTokens: MAX,
	compat: { supportsStore: false, supportsDeveloperRole: false, maxTokensField: "max_tokens", thinkingFormat: "deepseek" },
} as Model<"openai-completions">;

type Audit = ReturnType<DeepSeekCampaignBudget["requestAccountingAuditSnapshot"]>;
type Boundary = NonNullable<PiSessionRunnerOptions["onCampaignAccountingBoundary"]>;

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
