import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createAgentSession, type CreateAgentSessionOptions, type ModelRuntime } from "@earendil-works/pi-coding-agent";
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
	maxInputPayloadBytes: 500, maxOutputTokens: 20, outputAccountingMarginTokens: 32,
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
	builder.dispose(); reviewer.dispose();
});

test("campaign rejects endpoint changes, oversize payloads, and unknown outcomes closed", async (t) => {
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
	await assert.rejects(handle.prompt("again"), /campaign is stopped/);
	handle.dispose();

	const direct = new DeepSeekCampaignBudget(LIMITS);
	direct.beginPrompt();
	assert.throws(() => direct.reserve(501), /payload exceeds/);
	assert.equal(direct.snapshot().stopped, true);
	assert.throws(() => direct.beginPrompt(), /campaign is stopped/);
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
	handle.dispose();
});

test("campaign reconciles reported tokens and SDK cost against each reserved envelope", () => {
	for (const usage of [
		{ input: 501, output: 4, cacheRead: 0, cacheWrite: 0, totalTokens: 505, cost: 0.00001 },
		{ input: 10, output: 53, cacheRead: 0, cacheWrite: 0, totalTokens: 63, cost: 0.00001 },
		{ input: 10, output: 4, cacheRead: 0, cacheWrite: 0, totalTokens: 14, cost: 1 },
	]) {
		const budget = new DeepSeekCampaignBudget(LIMITS);
		budget.beginPrompt(); budget.reserve(100);
		assert.throws(() => budget.finishPrompt([{ entryId: "offline", kind: "assistant", promptIndex: 1,
			at: new Date().toISOString(), provider: "deepseek", model: "deepseek-flash", stopReason: "stop",
			usage, status: "reported", costStatus: "priced", costSource: "sdk-estimate" }]), /provider usage or call outcome/);
		assert.equal(budget.snapshot().stopped, true);
		assert.equal(budget.snapshot().reservations, 1);
	}
});
