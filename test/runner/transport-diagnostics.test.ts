import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createAgentSession, type CreateAgentSessionOptions, type ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, type AssistantMessage, type Model } from "@earendil-works/pi-ai";
import { PiSessionRunner } from "../../src/runner/pi.ts";
import { DeepSeekCampaignBudget } from "../../src/runner/deepseek-campaign.ts";
import { verifyDeepSeekProviderOutputLimit } from "../../src/runner/deepseek-provider-limits.ts";
import type { SessionSpec } from "../../src/runner/types.ts";

const MODEL = { id: "deepseek-flash", name: "Offline DeepSeek", provider: "deepseek", api: "openai-completions",
	baseUrl: "https://api.deepseek.com", reasoning: true, input: ["text"],
	cost: { input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0 }, contextWindow: 10_000, maxTokens: 20,
} as Model<"openai-completions">;
const OUTPUT_LIMIT = await verifyDeepSeekProviderOutputLimit({ apiKey: "synthetic-only", request: async () =>
	new Response(JSON.stringify({ object: "list", data: [{ id: MODEL.id, object: "model", name: "DeepSeek-V4.1-Flash",
		max_output_tokens: MODEL.maxTokens, context_window: MODEL.contextWindow }] }), { status: 200 }) });

function factory(mode: "http" | "network" | "generic"): typeof createAgentSession {
	const fakeFetch: typeof fetch = async () => {
		if (mode === "network") throw new Error("HIDDEN", { cause: Object.assign(new Error("HIDDEN"), { code: "UND_ERR_SOCKET" }) });
		return new Response("private provider body", { status: 503 });
	};
	return (async (options: CreateAgentSessionOptions = {}) => {
		const manager = options.sessionManager!;
		const messages: unknown[] = [];
		return { session: {
			sessionId: manager.getSessionId(), sessionFile: manager.getSessionFile(), messages,
			getActiveToolNames: () => options.tools ?? [],
			async prompt(text: string) {
				const user = { role: "user", content: text, timestamp: Date.now() };
				messages.push(user); manager.appendMessage(user as never);
				const stream = (options.modelRuntime as ModelRuntime).streamSimple(options.model!, { messages } as never, { fetch: fakeFetch });
				for await (const event of stream) {
					if (event.type !== "error") continue;
					messages.push(event.error); manager.appendMessage(event.error as never);
				}
			},
			abort() {}, dispose() {},
		} } as unknown as Awaited<ReturnType<typeof createAgentSession>>;
	}) as typeof createAgentSession;
}

function runtime(mode: "http" | "network" | "generic"): ModelRuntime {
	return {
		getModels: () => [MODEL],
		streamSimple(model: Model<"openai-completions">, _context: unknown, options: {
			fetch?: typeof fetch; onPayload?: (payload: unknown, model: typeof MODEL) => Promise<unknown>;
			onResponse?: (response: { status: number; headers: Record<string, string> }, model: typeof MODEL) => Promise<void>;
		}) {
			const stream = createAssistantMessageEventStream();
			void (async () => {
				await options.onPayload?.({ model: MODEL.id, messages: [{ role: "user", content: "hidden" }], max_tokens: MODEL.maxTokens }, model);
				if (mode !== "generic") {
					try {
						const response = await options.fetch!("https://private.example/secret?key=HIDDEN", {});
						await options.onResponse?.({ status: response.status, headers: {} }, model);
						await response.text();
					} catch { /* Simulate SDK flattening the underlying error to generic terminated. */ }
				}
				const error = { role: "assistant", content: [], api: model.api, provider: model.provider,
					model: model.id, stopReason: "error", errorMessage: "terminated HIDDEN provider body",
					timestamp: Date.now(), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } as AssistantMessage;
				stream.push({ type: "error", reason: "error", error }); stream.end();
			})().catch(error => { throw error; });
			return stream;
		},
	} as unknown as ModelRuntime;
}

async function run(mode: "http" | "network" | "generic") {
	const dir = await mkdtemp(path.join(tmpdir(), "transport-diagnostic-"));
	const budget = new DeepSeekCampaignBudget({ model: "deepseek/deepseek-flash:low", endpoint: "https://api.deepseek.com",
		providerOutputLimit: OUTPUT_LIMIT, outputAccountingMarginTokens: 32,
		estimatedInputCnyPerMillionTokens: 4, estimatedOutputCnyPerMillionTokens: 16 });
	const handle = await new PiSessionRunner({ modelRuntime: runtime(mode), createSession: factory(mode), campaignBudget: budget })
		.create({ label: mode, role: "execution", model: "deepseek/deepseek-flash:low", systemPrompt: "offline", tools: { kind: "none" }, persistDir: dir } satisfies SessionSpec);
	try {
		const checkedHandle = { ...handle };
		assert.equal(typeof checkedHandle.transportDiagnostics, "function");
		let thrown: unknown;
		try { await checkedHandle.prompt("private prompt HIDDEN"); } catch (error) { thrown = error; }
		const diagnostics = checkedHandle.transportDiagnostics?.() ?? [];
		if (diagnostics[0]) diagnostics[0].errorCodes.push("MUTATED_COPY");
		assert.doesNotMatch(JSON.stringify(handle.transportDiagnostics?.()), /MUTATED_COPY/);
		return { thrown, diagnostics: handle.transportDiagnostics?.() ?? [] };
	} finally { handle.dispose(); await rm(dir, { recursive: true, force: true }); }
}

test("generic SDK terminated error retains explicitly unavailable transport fields", async () => {
	const result = await run("generic");
	assert(result.thrown instanceof Error);
	assert.equal(result.diagnostics.length, 1);
	assert.deepEqual(result.diagnostics[0], { version: 1, promptIndex: 1, requestId: result.diagnostics[0].requestId,
		phase: "unknown", httpStatus: null, responseStarted: null, bytesRead: null, abortSource: null, errorCodes: [] });
	assert.doesNotMatch(JSON.stringify(result.diagnostics), /HIDDEN|terminated/);
});

test("HTTP response status and consumed bytes are recorded without private body or URL", async () => {
	const result = await run("http");
	assert(result.thrown instanceof Error);
	assert.doesNotMatch(result.thrown.message, /HIDDEN|provider body/);
	assert.equal(result.diagnostics.length, 1);
	assert.equal(result.diagnostics[0].httpStatus, 503);
	assert.equal(result.diagnostics[0].responseStarted, true);
	assert.equal(result.diagnostics[0].bytesRead, Buffer.byteLength("private provider body"));
	assert.equal(result.diagnostics[0].phase, "response-body");
	assert.doesNotMatch(JSON.stringify(result.diagnostics), /HIDDEN|private|terminated/);
});

test("transport error code comes only from an actual cause", async () => {
	const result = await run("network");
	assert.deepEqual(result.diagnostics[0].errorCodes, ["UND_ERR_SOCKET"]);
	assert.equal(result.diagnostics[0].phase, "request");
	assert.equal(result.diagnostics[0].responseStarted, false);
	assert.equal(result.diagnostics[0].httpStatus, null);
	assert.equal(result.diagnostics[0].bytesRead, null);
	assert.doesNotMatch(JSON.stringify(result.diagnostics), /HIDDEN|private|terminated/);
});
