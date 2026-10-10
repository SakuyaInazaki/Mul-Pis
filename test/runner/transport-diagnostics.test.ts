import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createAgentSession, ModelRuntime, type CreateAgentSessionOptions } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, type AssistantMessage, type Model } from "@earendil-works/pi-ai";
import { PiSessionRunner } from "../../src/runner/pi.ts";
import { HarnessError } from "../../src/types.ts";
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
type Mode = "http" | "network" | "malformed-fetch" | "body-interrupt" | "sdk-abort" |
	"sdk-prefetch-abort" | "generic" |
	"local-invariant" | "retry-local-invariant" |
	"allowlisted" | "input-schema" |
	"tool-reasoning" | "reasoning-echo" | "malicious" | "oversize" | "malformed" | "absent" |
	"insufficient-balance" | "balance-echo" | "balance-wrong-status" |
	"context-overflow" | "context-overflow-inconsistent" | "context-overflow-echo" |
	"context-overflow-unsafe" | "context-overflow-large-safe";
const VALID_REQUEST_ID = "12345678-1234-1234-1234-123456789abc";
const CONTEXT_OVERFLOW_SENTENCE = "This model's maximum context length is 1048576 tokens. However, you requested 1078729 tokens (685513 in the messages, 393216 in the completion). Please reduce the length of the messages or completion.";

function factory(mode: Mode): typeof createAgentSession {
	let fetchCalls = 0;
	const sdkAbort = new AbortController();
	const fakeFetch: typeof fetch = async () => {
		if (mode === "retry-local-invariant" && ++fetchCalls === 1)
			throw Object.assign(new Error("HIDDEN temporary network failure"), { code: "ECONNRESET" });
		if (mode === "network") throw new Error("HIDDEN", { cause: Object.assign(new Error("HIDDEN"), { code: "UND_ERR_SOCKET" }) });
		if (mode === "malformed-fetch") throw new TypeError("synthetic malformed URL");
		if (mode === "http") return new Response("private provider body", { status: 503 });
		if (mode === "body-interrupt") return new Response(new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode("partial"));
				controller.error(new Error("HIDDEN interrupted stream"));
			},
		}), { status: 200 });
		if (mode === "sdk-abort") return new Response(new ReadableStream<Uint8Array>({
			start(controller) {
				queueMicrotask(() => {
					sdkAbort.abort();
					controller.error(new DOMException("synthetic SDK cancellation", "AbortError"));
				});
			},
		}), { status: 200 });
		if (mode === "local-invariant" || mode === "retry-local-invariant")
			return new Response("ordinary provider output", { status: 200 });
		if (mode === "malformed") return new Response("{not-json HIDDEN", { status: 400,
			headers: { "content-type": "application/json" } });
		const error = mode === "allowlisted" ? { code: "context_length_exceeded", type: "invalid_request_error",
			message: "HIDDEN private prompt", param: "HIDDEN parameter" } :
			mode === "insufficient-balance" || mode === "balance-echo" || mode === "balance-wrong-status" ?
				{ code: "invalid_request_error", type: "unknown_error", message: mode === "balance-echo" ?
					`HIDDEN Insufficient Balance (request_id: ${VALID_REQUEST_ID})` :
					`Insufficient Balance (request_id: ${VALID_REQUEST_ID})` } :
			mode === "context-overflow" ? { code: null, type: "invalid_request_error",
				message: `${CONTEXT_OVERFLOW_SENTENCE} (request_id: ${VALID_REQUEST_ID})` } :
			mode === "context-overflow-inconsistent" ? { code: null, type: "invalid_request_error",
				message: CONTEXT_OVERFLOW_SENTENCE.replace("1078729", "1078730") } :
			mode === "context-overflow-echo" ? { code: null, type: "invalid_request_error",
				message: `HIDDEN ${CONTEXT_OVERFLOW_SENTENCE}` } :
			mode === "context-overflow-unsafe" ? { code: null, type: "invalid_request_error",
				message: "This model's maximum context length is 9007199254740992 tokens. However, you requested 9007199254740993 tokens (9007199254740991 in the messages, 2 in the completion). Please reduce the length of the messages or completion." } :
			mode === "context-overflow-large-safe" ? { code: null, type: "invalid_request_error",
				message: "This model's maximum context length is 100000000 tokens. However, you requested 100000001 tokens (99999999 in the messages, 2 in the completion). Please reduce the length of the messages or completion." } :
			mode === "input-schema" ? { code: "invalid_parameter", type: "invalid_request_error",
				message: "HIDDEN private prompt", param: "HIDDEN parameter",
				max_context_tokens: 128000, prompt_tokens: 130000 } :
			mode === "tool-reasoning" ? { code: null, type: "invalid_request_error",
				message: "The reasoning_content in the thinking mode must be passed back to the API." } :
			mode === "reasoning-echo" ? { code: null, type: "invalid_request_error",
				message: "HIDDEN: The reasoning_content in the thinking mode must be passed back to the API." } :
			mode === "malicious" ? { code: "HIDDEN private prompt", type: "HIDDEN", message: "HIDDEN private prompt", param: "HIDDEN parameter" } :
			mode === "oversize" ? { code: "context_length_exceeded", type: "invalid_request_error", message: "HIDDEN".repeat(2000) } :
			{ message: "HIDDEN private prompt" };
		return new Response(JSON.stringify({ error }), { status: mode === "insufficient-balance" || mode === "balance-echo" ? 402 : 400,
			headers: { "content-type": "application/json",
			"x-request-id": mode === "malicious" ? "sk-HIDDENprivatekey" : VALID_REQUEST_ID } });
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
				if (mode === "sdk-prefetch-abort") sdkAbort.abort();
				const stream = (options.modelRuntime as ModelRuntime).streamSimple(options.model!,
					{ messages } as never, { fetch: fakeFetch,
						...(mode === "sdk-abort" || mode === "sdk-prefetch-abort" ?
							{ signal: sdkAbort.signal } : {}) });
				for await (const event of stream) {
					if (event.type !== "error") continue;
					messages.push(event.error); manager.appendMessage(event.error as never);
				}
				if (mode === "local-invariant" || mode === "retry-local-invariant")
					throw new HarnessError("runner.model", "synthetic local invariant after HTTP 200");
			},
			abort() {}, dispose() {},
		} } as unknown as Awaited<ReturnType<typeof createAgentSession>>;
	}) as typeof createAgentSession;
}

function runtime(mode: Mode, observed: { body?: string }): ModelRuntime {
	return {
		getModels: () => [MODEL],
		streamSimple(model: Model<"openai-completions">, _context: unknown, options: {
			fetch?: typeof fetch; onPayload?: (payload: unknown, model: typeof MODEL) => Promise<unknown>;
			onResponse?: (response: { status: number; headers: Record<string, string> }, model: typeof MODEL) => Promise<void>;
		}) {
			const stream = createAssistantMessageEventStream();
			void (async () => {
				await options.onPayload?.({ model: MODEL.id, messages: [{ role: "user", content: "hidden" }], max_tokens: MODEL.maxTokens }, model);
				if (mode !== "generic" && mode !== "sdk-prefetch-abort") {
					try {
						if (mode === "retry-local-invariant")
							try { await options.fetch!("https://private.example/secret?key=HIDDEN", {}); }
							catch { /* Simulate an SDK retry before the final response. */ }
						const response = await options.fetch!("https://private.example/secret?key=HIDDEN", {});
						await options.onResponse?.({ status: response.status, headers: {} }, model);
						observed.body = await response.text();
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

async function run(mode: Mode, sanitizePrivateProviderError?: (value: string) => string | null,
	withCampaign = true, ordinaryAssessor = true) {
	const dir = await mkdtemp(path.join(tmpdir(), "transport-diagnostic-"));
	const observed: { body?: string } = {};
	const evidenceRoot = path.join(dir, "evidence");
	if (!withCampaign && ordinaryAssessor) await mkdir(evidenceRoot);
	const budget = new DeepSeekCampaignBudget({ model: "deepseek/deepseek-flash:low", endpoint: "https://api.deepseek.com",
		providerOutputLimit: OUTPUT_LIMIT, outputAccountingMarginTokens: 32,
		estimatedInputCnyPerMillionTokens: 4, estimatedOutputCnyPerMillionTokens: 16 });
	const handle = await new PiSessionRunner({ modelRuntime: runtime(mode, observed),
		createSession: factory(mode), ...(withCampaign ? { campaignBudget: budget } : {}),
		sanitizePrivateProviderError })
		.create({ label: !withCampaign && ordinaryAssessor ? "local-original-objective-1" : mode,
			role: !withCampaign && ordinaryAssessor ? "research" : "execution", model: "deepseek/deepseek-flash:low",
			systemPrompt: "offline", tools: withCampaign || !ordinaryAssessor ? { kind: "none" } :
				{ kind: "read-dir", root: evidenceRoot, toolName: "objective_evidence_read" },
			persistDir: dir } satisfies SessionSpec);
	try {
		const checkedHandle = { ...handle };
		assert.equal(typeof checkedHandle.transportDiagnostics, "function");
		let thrown: unknown;
		try { await checkedHandle.prompt("private prompt HIDDEN"); } catch (error) { thrown = error; }
		const diagnostics = checkedHandle.transportDiagnostics?.() ?? [];
		if (diagnostics[0]) diagnostics[0].errorCodes.push("MUTATED_COPY");
		assert.doesNotMatch(JSON.stringify(handle.transportDiagnostics?.()), /MUTATED_COPY/);
		return { thrown, diagnostics: handle.transportDiagnostics?.() ?? [], observed };
	} finally { handle.dispose(); await rm(dir, { recursive: true, force: true }); }
}

test("generic SDK terminated error retains explicitly unavailable transport fields", async () => {
	const result = await run("generic");
	assert(result.thrown instanceof Error);
	assert.equal(result.diagnostics.length, 1);
	assert.deepEqual(result.diagnostics[0], { version: 1, promptIndex: 1, requestId: result.diagnostics[0].requestId,
		phase: "unknown", httpStatus: null, responseStarted: null, bytesRead: null, abortSource: null,
		providerErrorCode: null, providerErrorType: null, providerErrorReasonClass: "unknown",
		providerRequestId: null, errorCodes: [] });
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
	assert.equal(result.diagnostics[0].providerErrorCode, null);
	assert.equal(result.diagnostics[0].providerErrorType, null);
	assert.equal(result.observed.body, "private provider body");
	assert.doesNotMatch(JSON.stringify(result.diagnostics), /HIDDEN|private|terminated/);
});

test("ordinary Pi sessions expose redacted HTTP 503 and network interruption without a campaign", async () => {
	const http = await run("http", undefined, false);
	assert(http.thrown instanceof Error);
	assert.equal(http.diagnostics.length, 1);
	assert.equal(http.diagnostics[0].httpStatus, 503);
	assert.equal(http.diagnostics[0].responseStarted, true);
	assert.equal(http.diagnostics[0].transportInterrupted, undefined);
	assert.doesNotMatch(JSON.stringify(http.diagnostics), /HIDDEN|private provider body|private\.example/);
	const network = await run("network", undefined, false);
	assert(network.thrown instanceof Error);
	assert.equal(network.diagnostics.length, 1);
	assert.equal(network.diagnostics[0].httpStatus, null);
	assert.equal(network.diagnostics[0].transportInterrupted, true);
	assert.doesNotMatch(JSON.stringify(network.diagnostics), /HIDDEN|private\.example/);
	const malformed = await run("malformed-fetch", undefined, false);
	assert(malformed.thrown instanceof Error);
	assert.equal(malformed.diagnostics.length, 1);
	assert.equal(malformed.diagnostics[0].httpStatus, null);
	assert.equal(malformed.diagnostics[0].transportInterrupted, undefined);
	assert.deepEqual(malformed.diagnostics[0].errorCodes, []);
	const body = await run("body-interrupt", undefined, false);
	assert(body.thrown instanceof Error);
	assert.equal(body.diagnostics.length, 1);
	assert.equal(body.diagnostics[0].httpStatus, 200);
	assert.equal(body.diagnostics[0].transportInterrupted, true);
	assert.doesNotMatch(JSON.stringify(body.diagnostics), /HIDDEN|private\.example/);
	const sdkCancelled = await run("sdk-abort", undefined, false);
	assert(sdkCancelled.thrown instanceof Error);
	assert.equal(sdkCancelled.diagnostics.length, 1);
	assert.equal(sdkCancelled.diagnostics[0].httpStatus, 200);
	assert.equal(sdkCancelled.diagnostics[0].transportInterrupted, true);
	assert.equal(sdkCancelled.diagnostics[0].abortSource, "sdk-signal");
	const prefetchAbort = await run("sdk-prefetch-abort", undefined, false);
	assert(prefetchAbort.thrown instanceof HarnessError);
	assert.equal(prefetchAbort.thrown.code, "runner.aborted");
	assert.deepEqual(prefetchAbort.diagnostics, [], "no request means no transport observation");
	const local = await run("local-invariant", undefined, false);
	assert(local.thrown instanceof HarnessError);
	assert.equal(local.thrown.code, "runner.model");
	assert.equal(local.diagnostics.length, 1);
	assert.equal(local.diagnostics[0].httpStatus, 200);
	assert.equal(local.diagnostics[0].transportInterrupted, undefined);
	const internallyRetried = await run("retry-local-invariant", undefined, false);
	assert(internallyRetried.thrown instanceof HarnessError);
	assert.equal(internallyRetried.thrown.code, "runner.model");
	assert.equal(internallyRetried.diagnostics.length, 1);
	assert.equal(internallyRetried.diagnostics[0].httpStatus, 200);
	assert.equal(internallyRetried.diagnostics[0].transportInterrupted, undefined);
	assert.deepEqual(internallyRetried.diagnostics[0].errorCodes, []);
});

test("ordinary execution sessions do not acquire the assessor-only transport probe", async () => {
	const result = await run("http", undefined, false, false);
	assert(result.thrown instanceof Error);
	assert.deepEqual(result.diagnostics, []);
	assert.equal(result.observed.body, "private provider body");
});

test("default Pi AgentSession and OpenAI SDK report an offline HTTP 503 without a campaign", async t => {
	const dir = await mkdtemp(path.join(tmpdir(), "ordinary-pi-sdk-503-"));
	const originalFetch = globalThis.fetch;
	let handle: Awaited<ReturnType<PiSessionRunner["create"]>> | undefined;
	let requests = 0;
	t.after(async () => {
		handle?.dispose();
		globalThis.fetch = originalFetch;
		await rm(dir, { recursive: true, force: true });
	});
	const profile = path.join(dir, "profile"), sessions = path.join(dir, "sessions"), evidence = path.join(dir, "evidence");
	await Promise.all([mkdir(profile), mkdir(sessions), mkdir(evidence)]);
	await writeFile(path.join(evidence, "original-problem.txt"), "Synthetic original problem.\n");
	await writeFile(path.join(profile, "models.json"), JSON.stringify({ providers: { deepseek: { models: [{
		...MODEL, compat: { supportsStore: false, supportsDeveloperRole: false,
			maxTokensField: "max_tokens", thinkingFormat: "deepseek" },
	}] } } }));
	const runtime = await ModelRuntime.create({ modelsPath: path.join(profile, "models.json"),
		authPath: path.join(profile, "auth.json"), modelsStorePath: path.join(profile, "models-store.json"),
		allowModelNetwork: false, refreshOnCreate: false });
	await runtime.setRuntimeApiKey("deepseek", "sk-SYNTHETIC-OFFLINE-ONLY");
	globalThis.fetch = async input => {
		assert.equal(input instanceof Request ? input.url : String(input),
			"https://api.deepseek.com/chat/completions");
		requests++;
		return new Response(JSON.stringify({ error: { type: "server_error", message: "HIDDEN offline rejection" } }),
			{ status: 503, headers: { "content-type": "application/json" } });
	};
	handle = await new PiSessionRunner({ modelRuntime: runtime }).create({
		label: "local-original-objective-1", role: "research", model: "deepseek/deepseek-flash:low",
		systemPrompt: "Read only synthetic evidence", tools: { kind: "read-dir", root: evidence,
			toolName: "objective_evidence_read" }, persistDir: sessions,
	});
	await assert.rejects(handle.prompt("Assess the synthetic original problem"));
	assert.equal(requests, 1, "the host owns assessor retries after each physical request");
	const diagnostic = handle.transportDiagnostics?.().at(-1);
	assert(diagnostic);
	assert.equal(diagnostic.httpStatus, 503);
	assert.equal(diagnostic.responseStarted, true);
	assert.equal(diagnostic.transportInterrupted, undefined);
	assert.equal(handle.usageSummary().complete, false, "failed provider usage remains UNKNOWN");
	assert.doesNotMatch(JSON.stringify(handle.transportDiagnostics?.()),
		/HIDDEN|SYNTHETIC-OFFLINE|chat\/completions/);
});

test("default Pi SDK no-auth preflight is a typed local cause with zero provider requests", async t => {
	const dir = await mkdtemp(path.join(tmpdir(), "ordinary-pi-sdk-no-auth-"));
	const originalFetch = globalThis.fetch;
	let handle: Awaited<ReturnType<PiSessionRunner["create"]>> | undefined;
	let requests = 0;
	t.after(async () => {
		handle?.dispose();
		globalThis.fetch = originalFetch;
		await rm(dir, { recursive: true, force: true });
	});
	const profile = path.join(dir, "profile"), sessions = path.join(dir, "sessions"),
		evidence = path.join(dir, "evidence");
	await Promise.all([mkdir(profile), mkdir(sessions), mkdir(evidence)]);
	await writeFile(path.join(evidence, "original-problem.txt"), "Synthetic original problem.\n");
	await writeFile(path.join(profile, "models.json"), JSON.stringify({ providers: { deepseek: { models: [{
		...MODEL, compat: { supportsStore: false, supportsDeveloperRole: false,
			maxTokensField: "max_tokens", thinkingFormat: "deepseek" },
	}] } } }));
	const runtime = await ModelRuntime.create({ modelsPath: path.join(profile, "models.json"),
		authPath: path.join(profile, "auth.json"), modelsStorePath: path.join(profile, "models-store.json"),
		allowModelNetwork: false, refreshOnCreate: false });
	globalThis.fetch = async () => { requests++; throw new Error("unexpected provider request"); };
	handle = await new PiSessionRunner({ modelRuntime: runtime }).create({
		label: "local-original-objective-1", role: "research", model: "deepseek/deepseek-flash:low",
		systemPrompt: "Read only synthetic evidence", tools: { kind: "read-dir", root: evidence,
			toolName: "objective_evidence_read" }, persistDir: sessions,
	});
	await assert.rejects(handle.prompt("Assess the synthetic original problem"), (error: unknown) => {
		assert(error instanceof HarnessError);
		assert.equal(error.code, "runner.auth-preflight");
		assert.doesNotMatch(error.message, /auth\.json|models\.json|\/login|deepseek-flash/);
		return true;
	});
	assert.equal(requests, 0);
	assert.deepEqual(handle.transcript(), []);
	assert.deepEqual(handle.transportDiagnostics?.(), []);
});

test("Pi credential-store read failure retains only a typed local cause before fetch", async t => {
	const dir = await mkdtemp(path.join(tmpdir(), "ordinary-pi-auth-store-"));
	const originalFetch = globalThis.fetch;
	let handle: Awaited<ReturnType<PiSessionRunner["create"]>> | undefined;
	let requests = 0;
	t.after(async () => {
		handle?.dispose(); globalThis.fetch = originalFetch;
		await rm(dir, { recursive: true, force: true });
	});
	const profile = path.join(dir, "profile"), sessions = path.join(dir, "sessions"),
		evidence = path.join(dir, "evidence");
	await Promise.all([mkdir(profile), mkdir(sessions), mkdir(evidence)]);
	const blocked = path.join(profile, "blocked");
	await mkdir(blocked, { mode: 0o500 });
	await writeFile(path.join(evidence, "original-problem.txt"), "Synthetic original problem.\n");
	await writeFile(path.join(profile, "models.json"), JSON.stringify({ providers: { deepseek: { models: [{
		...MODEL, compat: { supportsStore: false, supportsDeveloperRole: false,
			maxTokensField: "max_tokens", thinkingFormat: "deepseek" },
	}] } } }));
	const runtime = await ModelRuntime.create({ modelsPath: path.join(profile, "models.json"),
		// The test-owned directory is read-only. Pi's real credential store
		// fails before any provider request, without touching a default profile.
		authPath: path.join(blocked, "auth.json"), modelsStorePath: path.join(profile, "models-store.json"),
		allowModelNetwork: false, refreshOnCreate: false });
	globalThis.fetch = async () => { requests++; throw new Error("unexpected provider request"); };
	handle = await new PiSessionRunner({ modelRuntime: runtime }).create({
		label: "local-original-objective-1", role: "research", model: "deepseek/deepseek-flash:low",
		systemPrompt: "Read only synthetic evidence", tools: { kind: "read-dir", root: evidence,
			toolName: "objective_evidence_read" }, persistDir: sessions,
	});
	await assert.rejects(handle.prompt("Assess the synthetic original problem"), (error: unknown) => {
		assert(error instanceof HarnessError);
		assert(["runner.auth-store-unavailable", "runner.auth-preflight"].includes(error.code));
		assert.doesNotMatch(error.message, /private|credential\/location|ENOENT|mkdir/);
		return true;
	});
	assert.equal(requests, 0);
	assert.deepEqual(handle.transcript(), []);
	assert.deepEqual(handle.transportDiagnostics?.(), []);
	handle.dispose();
	const piEntry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
	const nestedEntry = path.resolve(path.dirname(piEntry),
		"../node_modules/@earendil-works/pi-ai/dist/index.js");
	const nestedAi = await import(pathToFileURL(nestedEntry).href).catch(error => {
		if ((error as NodeJS.ErrnoException).code !== "ERR_MODULE_NOT_FOUND") throw error;
		return import("@earendil-works/pi-ai");
	}) as
		{ ModelsError: new (code: "auth", message: string, options: { cause: Error }) => Error };
	const factory = (async (options: CreateAgentSessionOptions = {}) => {
		const created = await createAgentSession(options);
		(created.session as unknown as { prompt(text: string): Promise<void> }).prompt = async () => {
			const cause = Object.assign(new Error("private credential path"), {
				code: "EACCES", syscall: "open", path: "/private/credential/location" });
			throw new nestedAi.ModelsError("auth", "Credential store read failed for deepseek", { cause });
		};
		return created;
	}) as typeof createAgentSession;
	handle = await new PiSessionRunner({ modelRuntime: runtime, createSession: factory }).create({
		label: "local-original-objective-1", role: "research", model: "deepseek/deepseek-flash:low",
		systemPrompt: "Read only synthetic evidence", tools: { kind: "read-dir", root: evidence,
			toolName: "objective_evidence_read" }, persistDir: sessions,
	});
	await assert.rejects(handle.prompt("Assess the synthetic original problem"), (error: unknown) => {
		assert(error instanceof HarnessError);
		assert.equal(error.code, "runner.auth-store-unavailable");
		assert.doesNotMatch(error.message, /private|credential\/location|EACCES|open/);
		return true;
	});
	assert.equal(requests, 0);
	assert.deepEqual(handle.transcript(), []);
});

test("allowlisted provider code and type are captured without message or param", async () => {
	const result = await run("allowlisted");
	const row = result.diagnostics[0];
	assert.equal(row.httpStatus, 400);
	assert.equal(row.providerErrorCode, "context_length_exceeded");
	assert.equal(row.providerErrorType, "invalid_request_error");
	assert.equal(row.providerErrorReasonClass, "context-window");
	assert.equal(row.providerRequestId, VALID_REQUEST_ID);
	assert.equal(row.bytesRead, Buffer.byteLength(result.observed.body!));
	assert.match(result.observed.body!, /HIDDEN private prompt/);
	assert.doesNotMatch(JSON.stringify(row), /HIDDEN|private prompt|HIDDEN parameter/);
});

test("specific error code classifies input schema without retaining provider text", async () => {
	const row = (await run("input-schema")).diagnostics[0];
	assert.equal(row.providerErrorCode, "invalid_parameter");
	assert.equal(row.providerErrorReasonClass, "input-schema");
	assert.doesNotMatch(JSON.stringify(row), /HIDDEN|private prompt|HIDDEN parameter/);
});

test("only an exact completed HTTP 402 balance response yields a static funding reason", async () => {
	const row = (await run("insufficient-balance")).diagnostics[0];
	assert.equal(row.httpStatus, 402);
	assert.equal(row.providerErrorCode, "invalid_request_error");
	assert.equal(row.providerErrorType, null, "the unsupported raw type is not promoted");
	assert.equal(row.providerErrorReasonClass, "insufficient-balance");
	assert.doesNotMatch(JSON.stringify(row), /Insufficient Balance|request_id/);
	for (const mode of ["balance-echo", "balance-wrong-status"] as const)
		assert.equal((await run(mode)).diagnostics[0].providerErrorReasonClass, "unknown");
});

test("redacted provider reason and numeric limits survive only in an opted-in private diagnostic", async () => {
	const result = await run("input-schema", value => value.replaceAll("HIDDEN", "[REDACTED]"));
	const privateError = result.diagnostics[0].privateProviderError;
	assert.deepEqual(privateError, { code: "invalid_parameter", type: "invalid_request_error",
		message: "[REDACTED] private prompt", param: "[REDACTED] parameter",
		numericLimits: { max_context_tokens: 128000, prompt_tokens: 130000 } });
	assert.doesNotMatch(JSON.stringify(result.diagnostics), /HIDDEN|private\.example/);
	const defaultDiagnostic = (await run("input-schema")).diagnostics[0];
	assert.equal(defaultDiagnostic.privateProviderError, undefined);
	const oversized = (await run("oversize", value => value)).diagnostics[0];
	assert.equal(oversized.privateProviderError, undefined);
});

test("documented whole reasoning error sentence classifies while echoed text does not", async () => {
	const reasoning = (await run("tool-reasoning")).diagnostics[0];
	assert.equal(reasoning.providerErrorType, "invalid_request_error");
	assert.equal(reasoning.providerErrorReasonClass, "tool-reasoning");
	assert.doesNotMatch(JSON.stringify(reasoning), /reasoning_content|passed back/);
	const echo = (await run("reasoning-echo")).diagnostics[0];
	assert.equal(echo.providerErrorReasonClass, "unknown");
	assert.doesNotMatch(JSON.stringify(echo), /HIDDEN|reasoning_content|passed back/);
});

test("complete provider context rejection exposes checked token counts without raw text", async () => {
	const row = (await run("context-overflow")).diagnostics[0];
	assert.equal(row.providerErrorCode, null);
	assert.equal(row.providerErrorType, "invalid_request_error");
	assert.equal(row.providerErrorReasonClass, "context-window");
	assert.deepEqual(row.providerContextOverflow, { contextWindow: 1_048_576,
		messagesTokens: 685_513, completionTokens: 393_216, requestedTokens: 1_078_729,
		allowedCompletionTokens: 363_063 });
	assert.doesNotMatch(JSON.stringify(row), /maximum context length|However|request_id|in the messages/);
});

test("inconsistent, echoed and unsafe-number context sentences stay unclassified", async () => {
	for (const mode of ["context-overflow-inconsistent", "context-overflow-echo", "context-overflow-unsafe"] as const) {
		const row = (await run(mode)).diagnostics[0];
		assert.equal(row.providerErrorReasonClass, "unknown");
		assert.equal(row.providerContextOverflow, undefined);
		assert.doesNotMatch(JSON.stringify(row), /maximum context length|However|request_id|HIDDEN/);
	}
});

test("safe future context sizes have no fixed parser ceiling", async () => {
	const row = (await run("context-overflow-large-safe")).diagnostics[0];
	assert.equal(row.providerErrorReasonClass, "context-window");
	assert.deepEqual(row.providerContextOverflow, { contextWindow: 100_000_000,
		messagesTokens: 99_999_999, completionTokens: 2, requestedTokens: 100_000_001,
		allowedCompletionTokens: 1 });
});

test("body echo in code, type, message, param and request ID is discarded", async () => {
	const row = (await run("malicious")).diagnostics[0];
	assert.equal(row.providerErrorCode, null);
	assert.equal(row.providerErrorType, null);
	assert.equal(row.providerErrorReasonClass, "unknown");
	assert.equal(row.providerRequestId, null);
	assert.doesNotMatch(JSON.stringify(row), /HIDDEN|sk-/);
});

test("oversized JSON is ignored rather than partially classified", async () => {
	const result = await run("oversize");
	assert(result.observed.body && Buffer.byteLength(result.observed.body) > 8192);
	assert.equal(result.diagnostics[0].providerErrorCode, null);
	assert.equal(result.diagnostics[0].providerErrorType, null);
	assert.equal(result.diagnostics[0].bytesRead, Buffer.byteLength(result.observed.body));
});

test("malformed JSON remains unavailable without changing SDK response bytes", async () => {
	const result = await run("malformed");
	assert.equal(result.observed.body, "{not-json HIDDEN");
	assert.equal(result.diagnostics[0].httpStatus, 400);
	assert.equal(result.diagnostics[0].providerErrorCode, null);
	assert.equal(result.diagnostics[0].providerErrorType, null);
	assert.doesNotMatch(JSON.stringify(result.diagnostics), /HIDDEN|not-json/);
});

test("HTTP 400 without machine error code stays cause unavailable", async () => {
	const row = (await run("absent")).diagnostics[0];
	assert.equal(row.httpStatus, 400);
	assert.equal(row.providerErrorCode, null);
	assert.equal(row.providerErrorType, null);
	assert.equal(row.providerErrorReasonClass, "unknown");
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
