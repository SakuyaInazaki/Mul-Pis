import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createAgentSession, ModelRuntime, type CreateAgentSessionOptions } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, type Model } from "@earendil-works/pi-ai";
import { DeepSeekCampaignBudget, type DeepSeekCampaignLimits } from "../../src/runner/deepseek-campaign.ts";
import { verifyDeepSeekProviderOutputLimit } from "../../src/runner/deepseek-provider-limits.ts";
import { createConfinedCampaignFileTools } from "../../src/runner/confined-campaign-files.ts";
import { PiSessionRunner } from "../../src/runner/pi.ts";
import { openBoundedSession } from "../../src/context/boundary.ts";
import type { SessionRunner, SessionSpec } from "../../src/runner/types.ts";
import type { StageRunRecord } from "../../src/types.ts";

const MODEL = {
	id: "deepseek-flash", name: "Offline DeepSeek", provider: "deepseek", api: "openai-completions",
	baseUrl: "https://api.deepseek.com", reasoning: true, input: ["text"],
	cost: { input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0 },
	contextWindow: 10000, maxTokens: 20,
} as Model<"openai-completions">;

const TEST_PROVIDER_OUTPUT_LIMIT = await verifyDeepSeekProviderOutputLimit({ apiKey: "synthetic-only",
	request: async () => new Response(JSON.stringify({ object: "list", data: [{ id: "deepseek-flash",
		object: "model", name: "DeepSeek-V4.1-Flash", max_output_tokens: 20,
		context_window: 10_000 }] }), { status: 200 }) });

const LIMITS = {
	model: "deepseek/deepseek-flash:low", endpoint: "https://api.deepseek.com",
	maxCny: 0.006, priorCommittedCny: 0, maxProviderCalls: 2, maxProviderCallsPerPrompt: 2,
	maxOutputTokens: 20, providerOutputLimit: TEST_PROVIDER_OUTPUT_LIMIT,
	outputAccountingMarginTokens: 32,
	estimatedInputCnyPerMillionTokens: 4, estimatedOutputCnyPerMillionTokens: 16, estimatedCnyPerUsd: 10,
} satisfies DeepSeekCampaignLimits;

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

function streamFactory(rounds: number): typeof createAgentSession {
	return (async (options: CreateAgentSessionOptions = {}) => {
		const manager = options.sessionManager!;
		const messages: unknown[] = [];
		return { session: {
			sessionId: manager.getSessionId(), sessionFile: manager.getSessionFile(), messages,
			getActiveToolNames: () => options.tools ?? [],
			async prompt(text: string) {
				const user = { role: "user", content: text, timestamp: Date.now() };
				messages.push(user); manager.appendMessage(user as never);
				for (let i = 0; i < rounds; i++) {
					const stream = (options.modelRuntime as ModelRuntime).streamSimple(options.model!, { messages } as never, {});
					let assistant: unknown;
					for await (const event of stream) {
						if (event.type === "done") assistant = event.message;
						if (event.type === "error") throw new Error(event.error.errorMessage ?? "stream error");
					}
					if (!assistant) throw new Error("stream had no assistant");
					messages.push(assistant); manager.appendMessage(assistant as never);
				}
			},
			abort() {}, dispose() {},
		} } as unknown as Awaited<ReturnType<typeof createAgentSession>>;
	}) as typeof createAgentSession;
}

test("controller records a live-attested execution-to-confined-custom narrowing before any prompt", async (t) => {
	const dir = await realpath(await mkdtemp(path.join(tmpdir(), "deepseek-boundary-attest-")));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const work = path.join(dir, "work");
	const sessions = path.join(dir, "sessions");
	await Promise.all([mkdir(work), mkdir(sessions)]);
	const budget = new DeepSeekCampaignBudget({ ...LIMITS, maxCny: 1 });
	const sent = { count: 0, options: [] as Array<{ maxTokens?: number; maxRetries?: number }> };
	const actual = new PiSessionRunner({ modelRuntime: offlineRuntime(sent), createSession: offlineFactory(1), campaignBudget: budget });
	const wrapper: SessionRunner = {
		create: async (requested) => actual.create({ ...requested, tools: { kind: "custom", tools: await createConfinedCampaignFileTools(work, { writableFiles: ["candidate.cpp"] }) } }),
		resume: (ref) => actual.resume(ref),
		attestConfinedGrant: (handle) => actual.attestConfinedGrant(handle),
	};
	const requested = spec(sessions, "bounded-builder", { kind: "execution", root: work, tools: ["read", "write"] });
	const run: StageRunRecord = { stage: "M07", runId: "R001", startedAt: new Date().toISOString(), status: "running", inputs: [], outputs: [], sessions: [], failures: [], remarks: [] };
	const handle = await openBoundedSession(wrapper, run, { mode: "fresh", intent: "new-work", reason: "audited private builder", evidence: [], spec: requested }, async () => { await writeFile(path.join(dir, "run.json"), JSON.stringify(run)); });
	assert.equal(sent.count, 0);
	assert.deepEqual(run.sessions[0].boundary?.capability, { kind: "custom", toolNames: ["edit", "read", "write"], root: work, writableFiles: ["candidate.cpp"] });
	assert.deepEqual(run.sessions[0].boundary?.requestedCapability, { kind: "execution", root: work, toolNames: ["read", "write"] });
	assert.equal(JSON.parse(await readFile(path.join(dir, "run.json"), "utf8")).sessions[0].boundary.capability.root, work);
	await assert.rejects(openBoundedSession(wrapper, run, { mode: "fresh", intent: "new-work", reason: "read-only build must stay read-only", evidence: [],
		spec: { ...requested, label: "read-only-request", tools: { kind: "execution", root: work, tools: ["read"] } } }, async () => {}), /would add read or write authority/);
	assert.equal(run.sessions.length, 1);
	handle.dispose();
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

function reported(id: string, promptIndex = 1, input = 10, stopReason = "stop") {
	return { entryId: id, kind: "assistant" as const, promptIndex,
		at: new Date().toISOString(), provider: "deepseek", model: "deepseek-flash", stopReason,
		usage: { input, output: 4, cacheRead: 0, cacheWrite: 0, totalTokens: input + 4, cost: 0.0000078 },
		status: "reported" as const, costStatus: "priced" as const, costSource: "sdk-estimate" as const };
}

test("duplicate lease or request ownership fails closed without granting an untracked retry", () => {
	const budget = new DeepSeekCampaignBudget(LIMITS);
	const lease = budget.beginPrompt("branch", "1");
	budget.reserve(lease, 100, "request-1");
	assert.throws(() => budget.reserve(lease, 100, "request-1"), /already reserved/);
	assert.equal(budget.snapshot().reservations, 1);
	assert.equal(budget.snapshot().stopReason, "payload-boundary");
	budget.failPrompt(lease);
	assert.equal(budget.snapshot().stopReason, "payload-boundary", "first campaign stop reason must remain stable");
	const second = new DeepSeekCampaignBudget(LIMITS);
	second.beginPrompt("branch", "1");
	assert.throws(() => second.beginPrompt("branch", "2"), /ownership is duplicated/);
	assert.equal(second.snapshot().stopReason, "prompt-failure");
	const third = new DeepSeekCampaignBudget(LIMITS);
	const done = third.beginPrompt("branch", "1");
	third.reserve(done, 100, "request-1");
	third.finishPrompt(done, [{ requestId: "request-1", event: reported("entry-1") }]);
	assert.throws(() => third.beginPrompt("branch", "1"), /ownership is duplicated/);
});

test("Pi rejects an orphan DeepSeek tool result before reservation or transport", async t => {
	const dir = await mkdtemp(path.join(tmpdir(), "deepseek-request-preflight-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	let transmitted = 0;
	const runtime = { getModels: () => [MODEL],
		async streamSimple(model: Model<"openai-completions">, _context: unknown,
			options: { onPayload?: (payload: unknown, model: Model<"openai-completions">) => Promise<unknown> }) {
			await options.onPayload?.({ model: model.id,
				messages: [{ role: "tool", tool_call_id: "synthetic-call", content: "private synthetic result" }],
				max_tokens: 20, thinking: { type: "enabled" }, tools: [] }, model);
			transmitted++;
		},
	} as unknown as ModelRuntime;
	const budget = new DeepSeekCampaignBudget(LIMITS);
	const handle = await new PiSessionRunner({ modelRuntime: runtime,
		createSession: offlineFactory(1), campaignBudget: budget }).create(spec(dir, "request-preflight"));
	t.after(() => handle.dispose());
	await assert.rejects(handle.prompt("synthetic prompt"), /DeepSeek request contract rejected before provider transport/);
	assert.equal(transmitted, 0);
	assert.equal(budget.snapshot().reservations, 0);
	assert.deepEqual(budget.requestAccountingAuditSnapshot().requests, []);
	const [diagnostic] = handle.transportDiagnostics?.() ?? [];
	assert.equal(diagnostic?.requestContractViolation, "orphan-tool-result");
	assert.equal(diagnostic?.attemptedRequestNotSent, true);
	assert.equal(diagnostic?.wholePromptNotIssued, true);
	assert.equal(diagnostic?.responseStarted, null);
	assert.doesNotMatch(JSON.stringify(diagnostic), /synthetic-call|private synthetic result|synthetic prompt/);
});

test("endpoint mismatch and unavailable payload size stop transport before it is issued", async t => {
	const dir = await mkdtemp(path.join(tmpdir(), "deepseek-identity-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const sent = { count: 0, options: [] as Array<{ maxTokens?: number; maxRetries?: number }> };
	const altered = { ...MODEL, baseUrl: "https://evil.invalid" };
	const budget = new DeepSeekCampaignBudget(LIMITS);
	const handle = await new PiSessionRunner({ modelRuntime: offlineRuntime(sent, altered),
		createSession: offlineFactory(1), campaignBudget: budget }).create(spec(dir, "changed-endpoint"));
	t.after(() => handle.dispose());
	await assert.rejects(handle.prompt("offline"), /DeepSeek model, endpoint or provider output limit did not verify/);
	assert.equal(sent.count, 0);
	assert.equal(budget.snapshot().reservations, 0);
	const direct = new DeepSeekCampaignBudget(LIMITS);
	const lease = direct.beginPrompt("direct", "one");
	assert.throws(() => direct.reserve(lease, 0, "request"), /payload byte count is unavailable/);
	assert.equal(direct.snapshot().stopReason, "payload-boundary");
});

test("a usage-ledger write failure retains an unpriced unknown transport", async t => {
	const dir = await mkdtemp(path.join(tmpdir(), "deepseek-ledger-write-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const sent = { count: 0, options: [] as Array<{ maxTokens?: number; maxRetries?: number }> };
	const budget = new DeepSeekCampaignBudget(LIMITS);
	const handle = await new PiSessionRunner({ modelRuntime: offlineRuntime(sent),
		createSession: offlineFactory(1), campaignBudget: budget }).create(spec(dir, "ledger-failure"));
	t.after(() => handle.dispose());
	await mkdir(handle.ref.file!.replace(/\.jsonl$/, ".usage.jsonl"));
	await assert.rejects(handle.prompt("offline"), /EISDIR|illegal operation on a directory/);
	assert.equal(sent.count, 1);
	assert.equal(budget.requestAccountingAuditSnapshot().requests[0].status, "unknown");
	assert.equal(budget.requestAccountingAuditSnapshot().unpricedRequestCount, 1);
});

test("a reported terminal tool-loop usage is reconciled before the next request", async t => {
	const dir = await mkdtemp(path.join(tmpdir(), "deepseek-stream-accounting-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const payload = { model: MODEL.id,
		messages: [{ role: "user", content: "synthetic request" }], max_tokens: 20 };
	const budget = new DeepSeekCampaignBudget(LIMITS);
	let called = 0;
	let observedBeforeSecond = false;
	const runtime = { getModels: () => [MODEL],
		streamSimple(model: Model<"openai-completions">, _context: unknown,
			options: { onPayload?: (payload: unknown, model: Model<"openai-completions">) => Promise<unknown> }) {
			const stream = createAssistantMessageEventStream();
			void (async () => {
				await options.onPayload?.(payload, model);
				called++;
				if (called === 2) observedBeforeSecond = budget.requestAccountingAuditSnapshot().requests[0].reportedUsage?.totalTokens === 14;
				const stopReason = called === 1 ? "toolUse" as const : "stop" as const;
				const assistant = { role: "assistant" as const, api: model.api, provider: model.provider, model: model.id,
					content: [{ type: "text" as const, text: `round ${called}` }], stopReason, timestamp: Date.now(),
					usage: { input: 10, output: 4, cacheRead: 0, cacheWrite: 0, totalTokens: 14,
						cost: { input: 0.000003, output: 0.0000048, cacheRead: 0, cacheWrite: 0, total: 0.0000078 } } };
				stream.push({ type: "start", partial: assistant });
				stream.push({ type: "done", reason: stopReason, message: assistant });
				stream.end();
			})().catch(error => { throw error; });
			return stream;
		},
	} as unknown as ModelRuntime;
	const handle = await new PiSessionRunner({ modelRuntime: runtime, createSession: streamFactory(2),
		campaignBudget: budget }).create(spec(dir, "stream-accounting"));
	t.after(() => handle.dispose());
	await handle.prompt("two tool loops");
	assert.equal(called, 2);
	assert.equal(observedBeforeSecond, true);
	assert.equal(budget.requestAccountingAuditSnapshot().unpricedRequestCount, 2);
});

test("real Pi transports one offline request with its runtime key, confined tools, and live provider maximum", async () => {
	const dir = await mkdtemp(path.join(tmpdir(), "deepseek-real-pi-offline-"));
	const originalFetch = globalThis.fetch;
	let unrelatedFetches = 0;
	globalThis.fetch = async () => { unrelatedFetches++; throw new Error("unexpected network route"); };
	let handle: Awaited<ReturnType<PiSessionRunner["create"]>> | undefined;
	try {
		const profile = path.join(dir, "profile"), work = path.join(dir, "work"), sessions = path.join(dir, "sessions");
		await Promise.all([mkdir(profile), mkdir(work), mkdir(sessions)]);
		await writeFile(path.join(profile, "models.json"), JSON.stringify({ providers: { deepseek: { models: [{ ...MODEL,
			maxTokens: 393_216, contextWindow: 1_048_576,
			compat: { supportsStore: false, supportsDeveloperRole: false, maxTokensField: "max_tokens",
				thinkingFormat: "deepseek" },
		}] } } }));
		const runtime = await ModelRuntime.create({ modelsPath: path.join(profile, "models.json"),
			authPath: path.join(profile, "auth.json"), modelsStorePath: path.join(profile, "models-store.json"),
			allowModelNetwork: false, refreshOnCreate: false });
		const key = "sk-SYNTHETIC-OFFLINE-ONLY";
		await runtime.setRuntimeApiKey("deepseek", key);
		const provider = await verifyDeepSeekProviderOutputLimit({ apiKey: key,
			request: async () => new Response(JSON.stringify({ object: "list", data: [{ id: "deepseek-flash",
				object: "model", name: "DeepSeek-V4.1-Flash", max_output_tokens: 393_216,
				context_window: 1_048_576 }] }), { status: 200 }) });
		const calls: Array<{ endpoint: string; authorization: string | null; tools: number; cap: number }> = [];
		const fakeFetch: typeof fetch = async (input, init) => {
			const endpoint = input instanceof Request ? input.url : String(input);
			if (endpoint !== "https://api.deepseek.com/chat/completions") {
				unrelatedFetches++;
				throw new Error("unexpected network route");
			}
			const headers = new Headers(input instanceof Request ? input.headers : undefined);
			new Headers(init?.headers).forEach((value, name) => headers.set(name, value));
			const payload = typeof init?.body === "string" ? JSON.parse(init.body) as { tools?: unknown[]; max_tokens?: number } : {};
			calls.push({ endpoint,
				authorization: headers.get("authorization"), tools: payload.tools?.length ?? 0,
				cap: payload.max_tokens ?? 0 });
			return new Response(JSON.stringify({ error: { message: "offline synthetic rejection",
				type: "invalid_request_error" } }),
				{ status: 401, headers: { "content-type": "application/json" } });
		};
		globalThis.fetch = fakeFetch;
		const budget = new DeepSeekCampaignBudget({ ...LIMITS, maxCny: 0.000001, priorCommittedCny: 100,
			maxOutputTokens: 1, providerOutputLimit: provider });
		const tools = await createConfinedCampaignFileTools(work, { writableFiles: ["candidate.cpp"] });
		handle = await new PiSessionRunner({ modelRuntime: runtime, campaignBudget: budget })
			.create(spec(sessions, "real-pi-offline", { kind: "custom", tools }));
		await assert.rejects(handle.prompt("Offline authentication check."));
		assert.deepEqual(calls, [{ endpoint: "https://api.deepseek.com/chat/completions",
			authorization: `Bearer ${key}`, tools: 3, cap: provider.maxOutputTokens }]);
		assert.equal(unrelatedFetches, 0);
		assert.equal(budget.requestAccountingAuditSnapshot().requests[0].maxOutputTokens,
			provider.maxOutputTokens);
		assert.equal(budget.requestAccountingAuditSnapshot().requests[0].status, "unknown");
		assert.equal(budget.requestAccountingAuditSnapshot().unpricedRequestCount, 1);
		const diagnostics = handle.transportDiagnostics?.() ?? [];
		assert.equal(diagnostics.length, 1);
		assert.equal(diagnostics[0].httpStatus, 401);
		assert.equal(diagnostics[0].responseStarted, true);
		assert.equal(diagnostics[0].providerErrorType, "invalid_request_error");
		assert.equal(diagnostics[0].providerErrorCode, null);
		assert.equal(diagnostics[0].bytesRead, Buffer.byteLength(JSON.stringify({ error: {
			message: "offline synthetic rejection", type: "invalid_request_error" } })));
		assert.doesNotMatch(JSON.stringify(diagnostics), /SYNTHETIC-OFFLINE|offline synthetic rejection|chat\/completions/);
	} finally {
		handle?.dispose();
		globalThis.fetch = originalFetch;
		await rm(dir, { recursive: true, force: true });
	}
});
