import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import {
	createAgentSession,
	ModelRuntime,
	type CreateAgentSessionOptions,
} from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { PiSessionRunner } from "../../src/runner/pi.ts";
import { FakeSessionRunner } from "../../src/runner/fake.ts";
import type { CustomToolSpec, SessionSpec, ToolGrant } from "../../src/runner/types.ts";
import { HarnessError } from "../../src/types.ts";
import { readTelemetry } from "../../src/dashboard/telemetry.ts";
import { createConfinedCampaignFileTools } from "../../src/runner/confined-campaign-files.ts";

const MODEL = {
	id: "offline-model",
	name: "Offline model",
	api: "anthropic-messages",
	provider: "offline",
	baseUrl: "https://invalid.example",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 10_000,
	maxTokens: 1_000,
} as Model<"anthropic-messages">;

const MODEL_RUNTIME = {
	getModels: () => [MODEL],
} as unknown as ModelRuntime;

interface StubResponse {
	content: unknown[];
	stopReason: string;
	errorMessage?: string;
	usage?: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		totalTokens: number;
		cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
	};
}

interface FactoryHarness {
	calls: CreateAgentSessionOptions[];
	factory: typeof createAgentSession;
	promptCalls: number;
	abortCalls: number;
}

function stubFactory(response?: StubResponse | StubResponse[], config: { pruneIntermediate?: boolean; compactionUsage?: StubResponse["usage"]; disposeCounter?: { count: number }; blockSpecWrite?: boolean; insertToolResult?: boolean } = {}): FactoryHarness {
	const calls: CreateAgentSessionOptions[] = [];
	let promptCalls = 0;
	let abortCalls = 0;
	const factory = (async (options: CreateAgentSessionOptions = {}) => {
		calls.push(options);
		const manager = options.sessionManager;
		assert(manager);
		if (config.blockSpecWrite) await mkdir(manager.getSessionFile()!.replace(/\.jsonl$/, ".spec.json"));
		const messages: unknown[] = [...manager.buildSessionContext().messages];
		const session = {
			sessionId: manager.getSessionId(),
			sessionFile: manager.getSessionFile(),
			messages,
			getActiveToolNames: () => [...(options.tools ?? [])],
			async prompt(text: string) {
				promptCalls += 1;
				const user = { role: "user", content: text, timestamp: Date.now() };
				const selected = response ?? {
					content: [
						{ type: "thinking", thinking: "hidden" },
						{ type: "toolCall", id: "call-1", name: "example", arguments: {} },
						{ type: "text", text: "visible answer" },
					],
					stopReason: "stop",
					usage: {
						input: 7,
						output: 11,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 18,
						cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0, total: 0.3 },
					},
				};
				const responses = Array.isArray(selected) ? selected : [selected];
				for (const [index, item] of responses.entries()) {
				const assistant = {
					role: "assistant",
					api: MODEL.api,
					provider: MODEL.provider,
					model: MODEL.id,
					timestamp: Date.now(),
					...(("usage" in item && item.usage === undefined) ? {} : { usage: item.usage ?? {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					} }),
					content: item.content,
					stopReason: item.stopReason,
					...(item.errorMessage ? { errorMessage: item.errorMessage } : {}),
				};
				if (index === 0) { messages.push(user); manager.appendMessage(user as never); }
				messages.push(assistant);
				manager.appendMessage(assistant as never);
				if (config.insertToolResult && index === 0) {
					const toolResult = { role: "toolResult", toolCallId: "t", toolName: "offline", content: [{ type: "text", text: "ORIGINAL TOOL PAYLOAD at /parent/original.txt" }], isError: false, timestamp: Date.now() };
					messages.push(toolResult);
					manager.appendMessage(toolResult as never);
				}
				if (config.pruneIntermediate && index < responses.length - 1) messages.pop();
				}
				if (config.compactionUsage) manager.appendCompaction("offline summary", "offline-entry", 100, undefined, false, config.compactionUsage as never);
			},
			abort() { abortCalls += 1; },
			dispose() { if (config.disposeCounter) config.disposeCounter.count++; },
		};
		return { session, extensionsResult: undefined } as unknown as Awaited<ReturnType<typeof createAgentSession>>;
	}) as typeof createAgentSession;
	return { calls, factory, get promptCalls() { return promptCalls; }, get abortCalls() { return abortCalls; } };
}

async function fixture(t: TestContext): Promise<string> {
	const dir = await mkdtemp(path.join(tmpdir(), "pre-rsi-pi-runner-"));
	t.after(async () => rm(dir, { recursive: true, force: true }));
	return dir;
}

function spec(persistDir: string, overrides: Partial<SessionSpec> = {}): SessionSpec {
	return {
		label: "runner-test",
		role: "execution",
		model: "offline/offline-model:high",
		systemPrompt: "EXACT SYSTEM PROMPT\nwith a second line",
		tools: { kind: "none" },
		persistDir,
		...overrides,
	};
}

test("isolates all discovered resources and preserves the exact system prompt", async (t) => {
	const persistDir = await fixture(t);
	const stub = stubFactory();
	const runner = new PiSessionRunner({ modelRuntime: MODEL_RUNTIME, createSession: stub.factory });
	await runner.create(spec(persistDir));
	assert.equal(stub.calls.length, 1);
	const loader = stub.calls[0].resourceLoader;
	assert(loader);
	assert.match(loader.getSystemPrompt() ?? "", /^EXACT SYSTEM PROMPT\nwith a second line\n\n输入信任边界：/);
	assert.deepEqual(loader.getAppendSystemPrompt(), []);
	assert.deepEqual(loader.getAgentsFiles().agentsFiles, []);
	assert.deepEqual(loader.getSkills().skills, []);
	assert.deepEqual(loader.getPrompts().prompts, []);
	assert.deepEqual(loader.getThemes().themes, []);
	assert.deepEqual(loader.getExtensions().extensions, []);
	assert.equal(path.dirname(stub.calls[0].cwd!), persistDir);
	assert.match(path.basename(stub.calls[0].cwd!), /^\.pi-session-/);
});

test("a none grant disables every tool", async (t) => {
	const persistDir = await fixture(t);
	const stub = stubFactory();
	const runner = new PiSessionRunner({ modelRuntime: MODEL_RUNTIME, createSession: stub.factory });
	await runner.create(spec(persistDir));
	assert.equal(stub.calls[0].noTools, "all");
	assert.deepEqual(stub.calls[0].tools, []);
	assert.equal(stub.calls[0].customTools, undefined);
	assert.equal(stub.calls[0].sessionManager?.isPersisted(), true);
	assert.equal(stub.calls[0].sessionManager?.getSessionDir(), persistDir);
});

test("strict DeepSeek request rejects a caller output cap and uses the resolved model bound", async (t) => {
	const persistDir = await fixture(t);
	const model = { ...MODEL, id: "deepseek-flash", provider: "deepseek", api: "openai-completions", cost: { input: 0.2, output: 0.3, cacheRead: 0.1, cacheWrite: 0.1 } } as Model<"openai-completions">;
	const seen: Array<{ maxTokens?: number; maxRetries?: number }> = [];
	const runtime = {
		getModels: () => [model],
		streamSimple(_model: unknown, _context: unknown, options: { maxTokens?: number; maxRetries?: number; onPayload?: (payload: unknown, model: unknown) => Promise<unknown> }) {
			seen.push({ maxTokens: options.maxTokens, maxRetries: options.maxRetries });
			return options.onPayload?.({ model: "deepseek-flash", messages: [{ role: "user", content: "short" }], max_tokens: options.maxTokens }, model);
		},
	} as unknown as ModelRuntime;
	const stub = stubFactory();
	const factory = (async (options: CreateAgentSessionOptions = {}) => {
		const created = await stub.factory(options);
		const original = created.session.prompt.bind(created.session);
		(created.session as unknown as { prompt: (text: string) => Promise<void> }).prompt = async (text) => {
			await (options.modelRuntime as unknown as { streamSimple: (model: unknown, context: unknown, options: unknown) => Promise<unknown> }).streamSimple(model, { messages: [] }, {});
			await original(text);
		};
		return created;
	}) as typeof createAgentSession;
	const runner = new PiSessionRunner({ modelRuntime: runtime, createSession: factory });
	const estimate = await runner.estimateMaxSdkCost("deepseek/deepseek-flash", { maxInputTokens: 200, maxOutputTokens: 20 });
	assert(estimate && estimate > 0);
	await assert.rejects(runner.create(spec(persistDir, { model: "deepseek/deepseek-flash",
		strictRequest: { maxOutputTokens: 20, maxInputPayloadBytes: 500 } })),
		/strict request requires positive integer caps/);
	const handle = await runner.create(spec(persistDir, { model: "deepseek/deepseek-flash", strictRequest: { maxInputPayloadBytes: 500 } }));
	assert.equal(stub.calls[0].settingsManager?.getRetrySettings().enabled, false);
	assert.equal(stub.calls[0].settingsManager?.getProviderRetrySettings().maxRetries, 0);
	assert.equal(stub.calls[0].settingsManager?.getCompactionSettings().enabled, false);
	await handle.prompt("one step");
	assert.deepEqual(seen, [{ maxTokens: model.maxTokens, maxRetries: 0 }]);
	handle.dispose();
});

test("strict research request explicitly uses the resolved model output bound", async (t) => {
	const persistDir = await fixture(t);
	const model = { ...MODEL, id: "deepseek-flash", provider: "deepseek", api: "openai-completions" } as Model<"openai-completions">;
	const seen: Array<{ maxTokens?: number; maxRetries?: number }> = [];
	const runtime = {
		getModels: () => [model],
		streamSimple(_model: unknown, _context: unknown, options: { maxTokens?: number; maxRetries?: number; onPayload?: (payload: unknown, model: unknown) => Promise<unknown> }) {
			seen.push({ maxTokens: options.maxTokens, maxRetries: options.maxRetries });
			return options.onPayload?.({ model: "deepseek-flash", messages: [{ role: "user", content: "short" }],
				max_tokens: options.maxTokens }, model);
		},
	} as unknown as ModelRuntime;
	const stub = stubFactory();
	const factory = (async (options: CreateAgentSessionOptions = {}) => {
		const created = await stub.factory(options);
		const original = created.session.prompt.bind(created.session);
		(created.session as unknown as { prompt: (text: string) => Promise<void> }).prompt = async (text) => {
			await (options.modelRuntime as unknown as { streamSimple: (model: unknown, context: unknown, options: unknown) => Promise<unknown> }).streamSimple(model, { messages: [] }, {});
			await original(text);
		};
		return created;
	}) as typeof createAgentSession;
	const runner = new PiSessionRunner({ modelRuntime: runtime, createSession: factory });
	const handle = await runner.create(spec(persistDir, { model: "deepseek/deepseek-flash", strictRequest: { maxInputPayloadBytes: 500 } }));
	await handle.prompt("one step");
	assert.deepEqual(seen, [{ maxTokens: model.maxTokens, maxRetries: 0 }]);
	handle.dispose();
});

test("ordinary DeepSeek Pi requests explicitly use the resolved output maximum", async t => {
	const persistDir = await fixture(t);
	const model = { ...MODEL, id: "deepseek-flash", provider: "deepseek",
		api: "openai-completions" } as Model<"openai-completions">;
	const seen: number[] = [];
	const runtime = { getModels: () => [model],
		streamSimple(_model: unknown, _context: unknown,
			options: { maxTokens?: number; onPayload?: (payload: unknown, model: unknown) => Promise<unknown> }) {
			seen.push(options.maxTokens ?? 0);
			return options.onPayload?.({ model: "deepseek-flash", max_tokens: options.maxTokens,
				messages: [{ role: "user", content: "offline" }] }, model);
		},
	} as unknown as ModelRuntime;
	const stub = stubFactory();
	const factory = (async (options: CreateAgentSessionOptions = {}) => {
		const created = await stub.factory(options);
		const original = created.session.prompt.bind(created.session);
		(created.session as unknown as { prompt: (text: string) => Promise<void> }).prompt = async text => {
			await (options.modelRuntime as unknown as { streamSimple: (model: unknown, context: unknown,
				options: unknown) => Promise<unknown> }).streamSimple(model, { messages: [] }, {});
			await original(text);
		};
		return created;
	}) as typeof createAgentSession;
	const handle = await new PiSessionRunner({ modelRuntime: runtime, createSession: factory })
		.create(spec(persistDir, { model: "deepseek/deepseek-flash" }));
	await handle.prompt("ordinary request");
	assert.deepEqual(seen, [model.maxTokens]);
	handle.dispose();
});

async function runOfflineDeepSeekPayload(t: TestContext, strict: boolean, fields: Record<string, unknown>,
	requestModelChange: Record<string, unknown> = {}) {
	const persistDir = await fixture(t);
	const model = { ...MODEL, id: "deepseek-flash", provider: "deepseek",
		api: "openai-completions", baseUrl: "https://api.deepseek.com" } as Model<"openai-completions">;
	let dispatched = 0;
	let outgoing: unknown;
	let requestedMaxTokens: number | undefined;
	const runtime = { getModels: () => [model],
		async streamSimple(_model: unknown, _context: unknown, options: { maxTokens?: number;
			onPayload?: (payload: unknown, model: Model<"openai-completions">) => Promise<unknown> }) {
			requestedMaxTokens = options.maxTokens;
			outgoing = await options.onPayload?.({ model: model.id,
				messages: [{ role: "user", content: "offline" }], ...fields },
				{ ...model, ...requestModelChange });
			dispatched++;
		},
	} as unknown as ModelRuntime;
	const stub = stubFactory();
	const factory = (async (options: CreateAgentSessionOptions = {}) => {
		const created = await stub.factory(options);
		const original = created.session.prompt.bind(created.session);
		(created.session as unknown as { prompt: (text: string) => Promise<void> }).prompt = async text => {
			await (options.modelRuntime as unknown as { streamSimple: (model: unknown, context: unknown,
				options: unknown) => Promise<unknown> }).streamSimple(model, { messages: [] }, {});
			await original(text);
		};
		return created;
	}) as typeof createAgentSession;
	const handle = await new PiSessionRunner({ modelRuntime: runtime, createSession: factory })
		.create(spec(persistDir, { model: "deepseek/deepseek-flash",
			...(strict ? { strictRequest: { maxInputPayloadBytes: 1000 } } : {}) }));
	let error: unknown;
	try { await handle.prompt("offline request"); }
	catch (caught) { error = caught; }
	const observations = handle.providerOutputRequests?.();
	handle.dispose();
	return { error, dispatched, outgoing, requestedMaxTokens, observations, resolvedMaxTokens: model.maxTokens };
}

for (const strict of [false, true]) {
	test(`${strict ? "strict" : "ordinary"} DeepSeek request keeps Pi's adjusted or omitted output field`, async t => {
		for (const [name, fields, outputField, outgoingMaxTokens] of [
			["context-adjusted max_tokens", { max_tokens: 75 }, "max_tokens", 75],
			["alternate max_completion_tokens", { max_completion_tokens: 60 }, "max_completion_tokens", 60],
			["omitted", {}, "omitted", null],
		] as const) {
			await t.test(name, async subtest => {
				const run = await runOfflineDeepSeekPayload(subtest, strict, fields);
				assert.equal(run.error, undefined);
				assert.equal(run.dispatched, 1);
				assert.equal(run.requestedMaxTokens, run.resolvedMaxTokens);
				assert.deepEqual(run.observations, [{ resolvedMaxTokens: run.resolvedMaxTokens,
					outputField, outgoingMaxTokens }]);
				assert.equal((run.outgoing as Record<string, unknown>).max_tokens, fields.max_tokens);
				assert.equal((run.outgoing as Record<string, unknown>).max_completion_tokens, fields.max_completion_tokens);
			});
		}
	});

	test(`${strict ? "strict" : "ordinary"} DeepSeek request rejects unsafe output and identity changes`, async t => {
		for (const [name, fields, modelChange] of [
			["fractional", { max_tokens: 1.5 }, {}],
			["nonfinite", { max_tokens: Infinity }, {}],
			["nonpositive", { max_tokens: 0 }, {}],
			["above resolved provider capability", { max_tokens: 1001 }, {}],
			["conflicting fields", { max_tokens: 75, max_completion_tokens: 60 }, {}],
			["changed payload model", { model: "other" }, {}],
			["changed runtime model", { max_tokens: 75 }, { id: "other" }],
			["changed provider", { max_tokens: 75 }, { provider: "other" }],
			["changed endpoint", { max_tokens: 75 }, { baseUrl: "https://invalid.example" }],
		] as const) {
			await t.test(name, async subtest => {
				const run = await runOfflineDeepSeekPayload(subtest, strict, fields, modelChange);
				assert(run.error instanceof Error);
				assert.match(run.error.message, /DeepSeek provider request|strict request/);
				assert.equal(run.dispatched, 0);
				assert.deepEqual(run.observations, []);
			});
		}
	});
}

test("a read-dir grant confines both tools, rejects PDFs, and records successful reads", async (t) => {
	const persistDir = await fixture(t);
	const materialRoot = path.join(persistDir, "materials");
	const outsideRoot = path.join(persistDir, "outside");
	await mkdir(materialRoot);
	await mkdir(outsideRoot);
	await writeFile(path.join(materialRoot, "note.txt"), "material text\n", "utf8");
	await writeFile(path.join(materialRoot, "paper.pdf"), "not parsed", "utf8");
	await writeFile(path.join(outsideRoot, "secret.txt"), "outside", "utf8");
	await symlink(path.join(outsideRoot, "secret.txt"), path.join(materialRoot, "escape.txt"));

	const stub = stubFactory();
	const runner = new PiSessionRunner({ modelRuntime: MODEL_RUNTIME, createSession: stub.factory });
	const handle = await runner.create(
		spec(persistDir, { role: "reader", tools: { kind: "read-dir", root: materialRoot } }),
	);
	const options = stub.calls[0];
	assert.equal(options.noTools, "builtin");
	assert.deepEqual(options.tools, ["material_read", "material_list"]);
	assert.deepEqual(options.customTools?.map((tool) => tool.name), ["material_read", "material_list"]);
	const readTool = options.customTools?.find((tool) => tool.name === "material_read");
	assert(readTool);
	await assert.rejects(
		readTool.execute("escape", { path: "escape.txt" }, undefined, undefined, undefined as never),
		/outside the granted directory/,
	);
	await assert.rejects(
		readTool.execute("pdf", { path: "paper.pdf" }, undefined, undefined, undefined as never),
		/PDF reading is not supported/,
	);
	const result = await readTool.execute(
		"text",
		{ path: "note.txt" },
		undefined,
		undefined,
		undefined as never,
	);
	assert.match((result.content[0] as { text: string }).text, /material text/);
	assert.deepEqual(handle.readCoverage(), ["note.txt"]);
});

test("writes the sidecar next to the SDK path and resume rebuilds from it", async (t) => {
	const persistDir = await fixture(t);
	const stub = stubFactory();
	const runner = new PiSessionRunner({ modelRuntime: MODEL_RUNTIME, createSession: stub.factory });
	const original = spec(persistDir, { systemPrompt: "persisted boundary" });
	const created = await runner.create(original);
	const sessionFile = created.ref.file;
	if (!sessionFile) throw new Error("runner did not return a session file");
	assert(sessionFile.endsWith(".jsonl"));
	assert.equal(created.ref.specFile, sessionFile.replace(/\.jsonl$/, ".spec.json"));
	assert.deepEqual(JSON.parse(await readFile(created.ref.specFile!, "utf8")), original);

	// Pi materializes the JSONL only when an assistant message is persisted.
	await created.prompt("persist this session");
	const resumed = await runner.resume({ ...created.ref, label: "untrusted-ref-label", model: "offline/wrong" });
	assert.equal(stub.calls.length, 2);
	assert.match(stub.calls[1].resourceLoader?.getSystemPrompt() ?? "", /^persisted boundary\n\n输入信任边界：/);
	assert.equal(resumed.ref.label, original.label);
	assert.equal(resumed.ref.model, original.model);
});

test("prompt reports visible output and rejects a non-stop assistant result", async (t) => {
	const successDir = await fixture(t);
	const successStub = stubFactory();
	const successRunner = new PiSessionRunner({ modelRuntime: MODEL_RUNTIME, createSession: successStub.factory });
	const success = await successRunner.create(spec(successDir));
	const turn = await success.prompt("hello");
	assert.deepEqual(turn, {
		text: "visible answer",
		stopReason: "stop",
		toolCalls: 1,
		usage: { input: 7, output: 11, cacheRead: 0, cacheWrite: 0, totalTokens: 18, cost: 0.3, reportedEvents: 1, unknownEvents: 0, complete: true, costComplete: false },
	});
	assert.deepEqual(success.transcript(), [
		{ role: "user", text: "hello" },
		{ role: "assistant", text: "visible answer" },
	]);

	const errorDir = await fixture(t);
	const errorStub = stubFactory({
		content: [{ type: "text", text: "partial" }],
		stopReason: "error",
		errorMessage: "provider failed offline",
	});
	const errorRunner = new PiSessionRunner({ modelRuntime: MODEL_RUNTIME, createSession: errorStub.factory });
	const failed = await errorRunner.create(spec(errorDir));
	await assert.rejects(failed.prompt("fail"), (error: unknown) => {
		assert(error instanceof HarnessError);
		assert.equal(error.code, "runner.stop");
		assert.match(error.message, /stopReason=error/);
		assert.match(error.message, /provider failed offline/);
		return true;
	});
});

test("execution grants only requested native tools at the execution cwd and logs calls", async (t) => {
	const persistDir = await fixture(t);
	const executionRoot = path.join(persistDir, "execution");
	await mkdir(executionRoot);
	await writeFile(path.join(executionRoot, "input.txt"), "hello execution\n", "utf8");
	const stub = stubFactory();
	const runner = new PiSessionRunner({ modelRuntime: MODEL_RUNTIME, createSession: stub.factory });
	const handle = await runner.create(spec(persistDir, {
		tools: { kind: "execution", root: executionRoot, tools: ["read", "write"] },
	}));
	const options = stub.calls[0];
	assert.equal(options.cwd, await import("node:fs/promises").then(({ realpath }) => realpath(executionRoot)));
	assert.equal(path.dirname(options.sessionManager!.getCwd()), persistDir);
	assert.deepEqual(options.tools, ["read", "write"]);
	assert.deepEqual(options.customTools?.map((tool) => tool.name), ["read", "write"]);
	const readTool = options.customTools?.find((tool) => tool.name === "read");
	const writeTool = options.customTools?.find((tool) => tool.name === "write");
	assert(readTool);
	assert(writeTool);
	await readTool.execute("read-1", { path: "input.txt" }, undefined, undefined, { cwd: executionRoot } as never);
	await writeTool.execute("write-1", { path: "output.txt", content: "written by native tool\n" }, undefined, undefined, { cwd: executionRoot } as never);
	assert.equal(await readFile(path.join(executionRoot, "output.txt"), "utf8"), "written by native tool\n");
	assert.deepEqual(handle.readCoverage(), ["input.txt"]);
	assert.deepEqual(handle.toolLog().map(({ name, ok }) => ({ name, ok })), [
		{ name: "read", ok: true },
		{ name: "write", ok: true },
	]);
	await assert.rejects(runner.resume(handle.ref), /cannot be resumed/);
});

test("local execution bash does not inherit model process credentials", async t => {
	const persistDir = await fixture(t);
	const executionRoot = path.join(persistDir, "execution");
	await mkdir(executionRoot);
	const key = "MULPIS_LOCAL_MISSION_SECRET_CANARY";
	const before = process.env[key];
	process.env[key] = "synthetic-private-value";
	try {
		const stub = stubFactory();
		const runner = new PiSessionRunner({ modelRuntime: MODEL_RUNTIME,
			createSession: stub.factory });
		await runner.create(spec(persistDir, { tools: { kind: "execution",
			root: executionRoot, tools: ["bash"] } }));
		const bash = stub.calls[0].customTools?.find(tool => tool.name === "bash");
		assert(bash);
		const output = await bash.execute("canary", { command: "env" }, undefined,
			undefined, { cwd: executionRoot } as never);
		assert.doesNotMatch(JSON.stringify(output), /MULPIS_LOCAL_MISSION_SECRET_CANARY|synthetic-private-value/);
	} finally {
		if (before === undefined) delete process.env[key];
		else process.env[key] = before;
	}
});

test("confined custom tool logs prove full UTF-8 reads without logging contents or write arguments", async t => {
	const persistDir = await fixture(t);
	const work = path.join(persistDir, "confined-work");
	await mkdir(work);
	await writeFile(path.join(work, "source.txt"), "PRIVATE-READ-CONTENT\n", "utf8");
	const stub = stubFactory();
	const tools = await createConfinedCampaignFileTools(work, { writableFiles: ["output.txt"] });
	const handle = await new PiSessionRunner({ modelRuntime: MODEL_RUNTIME, createSession: stub.factory })
		.create(spec(persistDir, { tools: { kind: "custom", tools } }));
	const active = stub.calls[0].customTools ?? [];
	const read = active.find(tool => tool.name === "read")!;
	const write = active.find(tool => tool.name === "write")!;
	await read.execute("read-one", { path: "source.txt" }, undefined, undefined, {} as never);
	await assert.rejects(read.execute("read-missing", { path: "missing.txt" }, undefined, undefined, {} as never));
	await write.execute("write-one", { path: "output.txt", content: "PRIVATE-WRITE-CONTENT" }, undefined, undefined, {} as never);
	const rows = handle.toolLog();
	assert.deepEqual(rows[0].resultMetadata, { kind: "confined-utf8-read", relativePath: "source.txt",
		utf8Bytes: Buffer.byteLength("PRIVATE-READ-CONTENT\n", "utf8"), truncated: false });
	assert.equal(rows[1].errorClass, "filesystem");
	assert.equal(rows[1].errorCode, "ENOENT");
	assert.match(rows[1].errorMessage ?? "", /File read failed/);
	assert.deepEqual(rows[2].args, { path: "output.txt" });
	assert.doesNotMatch(JSON.stringify(rows), /PRIVATE-READ-CONTENT|PRIVATE-WRITE-CONTENT/);
	handle.dispose();
});

test("an arbitrary custom read-named tool cannot claim factory read completeness or log secret args", async t => {
	const persistDir = await fixture(t);
	const stub = stubFactory();
	const arbitrary: CustomToolSpec = { name: "read", description: "synthetic untrusted tool",
		params: { secret: { type: "string", description: "secret" } },
		async execute() { return { text: "UNTRUSTED-RESULT" }; } };
	const handle = await new PiSessionRunner({ modelRuntime: MODEL_RUNTIME, createSession: stub.factory })
		.create(spec(persistDir, { tools: { kind: "custom", tools: [arbitrary] } }));
	await stub.calls[0].customTools![0].execute("arbitrary", { secret: "PRIVATE-ARGUMENT" },
		undefined, undefined, {} as never);
	const row = handle.toolLog()[0];
	assert.equal(row.resultMetadata, undefined);
	assert.deepEqual(row.args, {});
	assert.doesNotMatch(JSON.stringify(row), /PRIVATE-ARGUMENT|UNTRUSTED-RESULT/);
	handle.dispose();
});

test("abort before prompt sends nothing and abort during prompt reaches the SDK", async (t) => {
	const beforeDir = await fixture(t);
	const beforeController = new AbortController();
	beforeController.abort();
	const beforeStub = stubFactory();
	const before = await new PiSessionRunner({
		modelRuntime: MODEL_RUNTIME,
		createSession: beforeStub.factory,
		signal: beforeController.signal,
	}).create(spec(beforeDir));
	await assert.rejects(before.prompt("must not send"), /aborted before prompt/);
	assert.equal(beforeStub.promptCalls, 0);

	const duringDir = await fixture(t);
	const duringController = new AbortController();
	const calls: CreateAgentSessionOptions[] = [];
	let abortCalls = 0;
	let release!: () => void;
	const blocked = new Promise<void>((resolve) => { release = resolve; });
	const factory = (async (options: CreateAgentSessionOptions = {}) => {
		calls.push(options);
		const manager = options.sessionManager!;
		return { session: {
			sessionId: manager.getSessionId(), sessionFile: manager.getSessionFile(), messages: [],
			getActiveToolNames: () => [...(options.tools ?? [])],
			prompt: async () => blocked,
			abort: async () => { abortCalls += 1; release(); await Promise.resolve(); throw new Error("offline abort rejection"); },
			dispose() {},
		} } as unknown as Awaited<ReturnType<typeof createAgentSession>>;
	}) as typeof createAgentSession;
	const during = await new PiSessionRunner({ modelRuntime: MODEL_RUNTIME, createSession: factory, signal: duringController.signal }).create(spec(duringDir));
	const pending = during.prompt("interrupt me");
	duringController.abort();
	await assert.rejects(pending, (error: unknown) => {
		assert(error instanceof HarnessError);
		assert.equal(error.code, "runner.stop");
		assert.match(error.message, /aborted during prompt/);
		assert.match(error.message, /SDK abort failed: offline abort rejection/);
		return true;
	});
	assert.equal(abortCalls, 1);
	during.dispose();
});

test("removes the abort listener after a normal prompt", async (t) => {
	const persistDir = await fixture(t);
	const controller = new AbortController();
	const stub = stubFactory();
	const handle = await new PiSessionRunner({ modelRuntime: MODEL_RUNTIME, createSession: stub.factory, signal: controller.signal }).create(spec(persistDir));
	await handle.prompt("finish normally");
	controller.abort();
	await Promise.resolve();
	assert.equal(stub.abortCalls, 0);
});

test("runner reports only allowlisted idle and archived lifecycle metadata", async (t) => {
	const root = await fixture(t);
	const persistDir = path.join(root, ".agent", "sessions");
	await mkdir(persistDir, { recursive: true });
	const stub = stubFactory();
	const handle = await new PiSessionRunner({ modelRuntime: MODEL_RUNTIME, createSession: stub.factory }).create(spec(persistDir));
	await handle.prompt("sensitive prompt must not be recorded");
	const idle = await readTelemetry(root, handle.ref.id);
	assert.equal(idle?.activity, "idle");
	assert.equal(idle?.outcome, "completed");
	assert.doesNotMatch(JSON.stringify(idle), /sensitive prompt/);
	handle.dispose();
	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.equal((await readTelemetry(root, handle.ref.id))?.activity, "ended");
});

test("fake runner rejects cached custom and execution sessions on resume", async (t) => {
	const persistDir = await fixture(t);
	const noopTool: CustomToolSpec = {
		name: "noop",
		description: "offline no-op",
		params: {},
		execute: async () => ({ text: "ok" }),
	};
	const grants: ToolGrant[] = [
		{ kind: "custom", tools: [noopTool] },
		{ kind: "execution", root: persistDir, tools: ["read"] },
	];
	for (const tools of grants) {
		const fake = new FakeSessionRunner(() => "ok");
		const handle = await fake.create(spec(persistDir, { tools }));
		await assert.rejects(fake.resume(handle.ref), /non-resumable tool session/);
	}
});

test("accounts for every appended assistant and compaction once across prompts and resume", async (t) => {
	const persistDir = await fixture(t);
	const usage = (input: number, output: number, cost: number) => ({
		input, output, cacheRead: 1, cacheWrite: 2, totalTokens: input + output + 3,
		cost: { input: cost, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
	});
	const stub = stubFactory([
		{ content: [{ type: "toolCall", id: "t", name: "offline", arguments: {} }], stopReason: "toolUse", usage: usage(10, 2, 0.1) },
		{ content: [{ type: "text", text: "done" }], stopReason: "stop", usage: usage(20, 3, 0.2) },
	], { pruneIntermediate: true, compactionUsage: usage(4, 1, 0.04) });
	const runner = new PiSessionRunner({ modelRuntime: MODEL_RUNTIME, createSession: stub.factory });
	const handle = await runner.create(spec(persistDir));
	const first = await handle.prompt("first");
	assert.equal(first.toolCalls, 1);
	assert.equal(first.usage?.input, 34);
	assert.equal(first.usage?.cost, 0.34);
	assert.deepEqual(handle.usageEvents().map((event) => event.kind), ["assistant", "assistant", "compaction"]);
	await handle.prompt("second");
	assert.equal(handle.usageSummary().input, 68);
	const lines = (await readFile(handle.ref.file!.replace(/\.jsonl$/, ".usage.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
	assert.equal(lines.length, 2);
	assert.deepEqual(lines.map((row) => row.summary.input), [34, 34]);
	handle.dispose();
	const resumed = await runner.resume(handle.ref);
	await resumed.prompt("third");
	assert.equal(resumed.usageSummary().input, 34);
	assert.equal((await readFile(handle.ref.file!.replace(/\.jsonl$/, ".usage.jsonl"), "utf8")).trim().split("\n").length, 3);
	resumed.dispose();
});

test("failed prompt persists unknown usage, and explicit abort leaves a readable ledger", async (t) => {
	const persistDir = await fixture(t);
	const missing = stubFactory({ content: [{ type: "text", text: "failed" }], stopReason: "error", usage: undefined });
	const failed = await new PiSessionRunner({ modelRuntime: MODEL_RUNTIME, createSession: missing.factory }).create(spec(persistDir));
	await assert.rejects(failed.prompt("fail"), /stopReason=error/);
	assert.equal(failed.usageSummary().complete, false);
	assert.equal(failed.usageSummary().unknownEvents, 1);
	const ledger = JSON.parse((await readFile(failed.ref.file!.replace(/\.jsonl$/, ".usage.jsonl"), "utf8")).trim());
	assert.equal(ledger.outcome, "failed");
	assert.equal(ledger.events[0].status, "unknown");
	failed.dispose();

	let release!: () => void;
	const blocked = new Promise<void>((resolve) => { release = resolve; });
	const managerFactory = (async (options: CreateAgentSessionOptions = {}) => {
		const manager = options.sessionManager!;
		return { session: {
			sessionId: manager.getSessionId(), sessionFile: manager.getSessionFile(), messages: [],
			getActiveToolNames: () => [], prompt: async () => blocked,
			abort: async () => { release(); }, dispose() { release(); },
		} } as unknown as Awaited<ReturnType<typeof createAgentSession>>;
	}) as typeof createAgentSession;
	const interrupted = await new PiSessionRunner({ modelRuntime: MODEL_RUNTIME, createSession: managerFactory }).create(spec(persistDir));
	const pending = interrupted.prompt("interrupt");
	await interrupted.abort();
	await assert.rejects(pending, /aborted during prompt/);
	assert.equal(interrupted.usageSummary().unknownEvents, 1);
	assert.equal(JSON.parse((await readFile(interrupted.ref.file!.replace(/\.jsonl$/, ".usage.jsonl"), "utf8")).trim()).outcome, "aborted");
	interrupted.dispose();
});

test("records only returned text lines after limits, truncation and oversized-line warning", async (t) => {
	const persistDir = await fixture(t);
	const materialRoot = path.join(persistDir, "materials");
	await mkdir(materialRoot);
	await writeFile(path.join(materialRoot, "many.txt"), Array.from({ length: 2100 }, (_, i) => `line ${i + 1}`).join("\n"));
	await writeFile(path.join(materialRoot, "wide.txt"), "x".repeat(52 * 1024));
	const stub = stubFactory();
	const handle = await new PiSessionRunner({ modelRuntime: MODEL_RUNTIME, createSession: stub.factory }).create(spec(persistDir, { tools: { kind: "read-dir", root: materialRoot } }));
	const read = stub.calls[0].customTools?.find((tool) => tool.name === "material_read");
	assert(read);
	await read.execute("one", { path: "many.txt", offset: 5, limit: 3 }, undefined, undefined, undefined as never);
	await read.execute("two", { path: "many.txt" }, undefined, undefined, undefined as never);
	await read.execute("three", { path: "wide.txt" }, undefined, undefined, undefined as never);
	await assert.rejects(read.execute("four", { path: "missing.txt" }, undefined, undefined, undefined as never));
	assert.deepEqual(handle.readReturnEvents().map((event) => ({ status: event.status, start: event.returned.startLine, end: event.returned.endLine, truncated: event.returned.truncated })), [
		{ status: "returned", start: 5, end: 7, truncated: true },
		{ status: "returned", start: 1, end: 2000, truncated: true },
		{ status: "no-content", start: undefined, end: undefined, truncated: true },
		{ status: "error", start: undefined, end: undefined, truncated: undefined },
	]);
	handle.dispose();
});

test("method binding survives resume without enabling discovered resources", async (t) => {
	const persistDir = await fixture(t);
	const stub = stubFactory();
	const runner = new PiSessionRunner({ modelRuntime: MODEL_RUNTIME, createSession: stub.factory });
	const binding = { versionId: "method-v1", contentId: "approved-package-v1" };
	const handle = await runner.create(spec(persistDir, { methodBinding: binding }));
	assert.deepEqual(handle.ref.methodBinding, binding);
	assert.deepEqual(stub.calls[0].resourceLoader?.getExtensions().extensions, []);
	assert.deepEqual(stub.calls[0].resourceLoader?.getSkills().skills, []);
	await handle.prompt("first");
	handle.dispose();
	await assert.rejects(runner.resume({ ...handle.ref, methodBinding: { versionId: "different" } }), /method binding differs/);
	const resumed = await runner.resume(handle.ref);
	assert.deepEqual(resumed.ref.methodBinding, binding);
	resumed.dispose();
});

test("Pi forks two independent histories from a frozen completed leaf, preserving tool payload and excluding later parent turns", async (t) => {
	const root = await fixture(t);
	const sessions = path.join(root, "parent-sessions");
	const childSessions = path.join(root, "child-sessions");
	const frozen = path.join(root, "frozen-evidence.json");
	await mkdir(sessions);
	await mkdir(childSessions);
	await writeFile(frozen, JSON.stringify({ originalPath: "/parent/original.txt", frozenPath: frozen }));
	const stub = stubFactory([
		{ content: [{ type: "toolCall", id: "t", name: "offline", arguments: {} }], stopReason: "toolUse" },
		{ content: [{ type: "text", text: "finished first" }], stopReason: "stop" },
	], { insertToolResult: true });
	const runner = new PiSessionRunner({ modelRuntime: MODEL_RUNTIME, createSession: stub.factory });
	const historicalTool: CustomToolSpec = { name: "offline", description: "historical only", params: {}, execute: async () => ({ text: "unused" }) };
	const parent = await runner.create(spec(sessions, { tools: { kind: "custom", tools: [historicalTool] } }));
	await parent.prompt("parent first");
	const checkpoint = await runner.checkpoint(parent, { inputManifest: frozen, runId: "run-1", taskId: "task-1", externalOperationsSettled: true });
	const parentAtCheckpoint = await readFile(parent.ref.file!, "utf8");
	await parent.prompt("parent later");
	const parentBeforeFork = await readFile(parent.ref.file!, "utf8");
	const childSpec = spec(childSessions, { label: "child", role: "research", tools: { kind: "none" } });
	const evidenceBindings = [{ version: 1 as const, label: "original tool result binding", path: frozen, status: "frozen-copy" as const, sourceVersion: checkpoint.id }];
	const first = await runner.fork({ checkpoint, spec: childSpec, evidenceBindings, reason: "competing route one" });
	const second = await runner.fork({ checkpoint, spec: { ...childSpec, label: "child-two" }, evidenceBindings, reason: "competing route two" });
	assert.notEqual(first.ref.id, second.ref.id);
	assert.notEqual(first.ref.file, second.ref.file);
	assert.notEqual(first.ref.file, parent.ref.file);
	assert.deepEqual(stub.calls.at(-1)?.tools, []);
	assert.deepEqual(stub.calls.at(-1)?.resourceLoader?.getExtensions().extensions, []);
	assert.deepEqual(stub.calls.at(-1)?.resourceLoader?.getSkills().skills, []);
	const firstFile = await readFile(first.ref.file!, "utf8");
	assert.match(firstFile, /ORIGINAL TOOL PAYLOAD at \/parent\/original\.txt/);
	assert.match(JSON.stringify(stub.calls.at(-2)?.sessionManager?.buildSessionContext().messages), /ORIGINAL TOOL PAYLOAD at \/parent\/original\.txt/);
	assert.doesNotMatch(firstFile, /parent later/);
	assert.match(firstFile, /parent first/);
	assert.equal(await readFile(parent.ref.file!, "utf8"), parentBeforeFork);
	assert.notEqual((JSON.parse(firstFile.split("\n")[0]) as { cwd: string }).cwd, (JSON.parse(parentAtCheckpoint.split("\n")[0]) as { cwd: string }).cwd);
	const lineage = JSON.parse(await readFile(first.ref.lineageFile!, "utf8"));
	assert.equal(lineage.parent.leafId, checkpoint.leafId);
	assert.equal(lineage.inheritedUsageBilled, false);
	assert.deepEqual(lineage.evidenceBindings, evidenceBindings);
	await first.prompt("first child only");
	assert.doesNotMatch(await readFile(second.ref.file!, "utf8"), /first child only/);
	assert.equal(first.usageEvents().filter((event) => event.kind === "assistant").length, 2);
	first.dispose();
	const resumedChild = await runner.resume(first.ref);
	assert.equal(resumedChild.ref.lineageFile, first.ref.lineageFile);
	resumedChild.dispose();
	second.dispose();
	await rm(second.ref.lineageFile!);
	await assert.rejects(runner.resume(second.ref), /lineage receipt is missing/);
	parent.dispose();
});

test("Pi checkpoint and fork fail closed for active, failed, unsettled, missing-evidence and changed-model parents", async (t) => {
	const root = await fixture(t);
	const manifest = path.join(root, "frozen.json");
	await writeFile(manifest, "{}\n");
	const stub = stubFactory();
	const runner = new PiSessionRunner({ modelRuntime: MODEL_RUNTIME, createSession: stub.factory });
	const parent = await runner.create(spec(root));
	await assert.rejects(runner.checkpoint(parent, { inputManifest: manifest, runId: "run", externalOperationsSettled: true }), /completed/);
	await parent.prompt("complete");
	await assert.rejects(runner.checkpoint(parent, { inputManifest: manifest, runId: "run", externalOperationsSettled: false }), /unknown external operations/);
	const checkpoint = await runner.checkpoint(parent, { inputManifest: manifest, runId: "run", externalOperationsSettled: true });
	await assert.rejects(runner.fork({ checkpoint, spec: spec(root, { model: "offline/other" }), evidenceBindings: [], reason: "candidate" }), /cross-model/);
	await assert.rejects(runner.fork({ checkpoint, spec: spec(root, { tools: { kind: "execution", root, tools: ["bash"] } }), evidenceBindings: [{ version: 1, label: "frozen", path: manifest, status: "frozen-copy", sourceVersion: checkpoint.id }], reason: "candidate" }), /cannot elevate tool authority/);
	await assert.rejects(runner.fork({ checkpoint, spec: spec(root), evidenceBindings: [{ version: 1, label: "mutable", path: manifest, status: "linked" }], reason: "candidate" }), /frozen-copy/);
	await writeFile(manifest, "{\"changed\":true}\n");
	await assert.rejects(runner.fork({ checkpoint, spec: spec(root), evidenceBindings: [{ version: 1, label: "frozen", path: manifest, status: "frozen-copy", sourceVersion: checkpoint.id }], reason: "candidate" }), /manifest is missing or changed/);
	await writeFile(manifest, "{}\n");
	await writeFile(parent.ref.specFile!, JSON.stringify(spec(root, { label: "changed" })));
	await assert.rejects(runner.fork({ checkpoint, spec: spec(root), evidenceBindings: [{ version: 1, label: "frozen", path: manifest, status: "frozen-copy", sourceVersion: checkpoint.id }], reason: "candidate" }), /parent spec changed/);
	parent.dispose();
});

test("Pi forks a compaction-aware checkpoint while retaining original JSONL evidence", async (t) => {
	const root = await fixture(t);
	const manifest = path.join(root, "manifest.json");
	await writeFile(manifest, "{}\n");
	const usage = { input: 4, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 5, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
	const stub = stubFactory(undefined, { compactionUsage: usage });
	const runner = new PiSessionRunner({ modelRuntime: MODEL_RUNTIME, createSession: stub.factory });
	const parent = await runner.create(spec(root));
	await parent.prompt("full original before compaction");
	const checkpoint = await runner.checkpoint(parent, { inputManifest: manifest, runId: "run", externalOperationsSettled: true });
	const child = await runner.fork({ checkpoint, spec: spec(path.join(root, "children")), evidenceBindings: [{ version: 1, label: "frozen", path: manifest, status: "frozen-copy", sourceVersion: checkpoint.id }], reason: "alternate compaction-aware continuation" });
	const childJsonl = await readFile(child.ref.file!, "utf8");
	assert.match(childJsonl, /full original before compaction/);
	assert.match(childJsonl, /"type":"compaction"/);
	assert.equal(child.usageEvents().length, 0);
	child.dispose(); parent.dispose();
});

test("Pi checkpoint refuses a prompt still in flight", async (t) => {
	const root = await fixture(t);
	const manifest = path.join(root, "manifest.json");
	await writeFile(manifest, "{}\n");
	const stub = stubFactory();
	let release!: () => void;
	let started!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	const entered = new Promise<void>((resolve) => { started = resolve; });
	const factory = (async (options: CreateAgentSessionOptions = {}) => {
		const created = await stub.factory(options);
		const original = created.session.prompt.bind(created.session);
		(created.session as unknown as { prompt(text: string): Promise<void> }).prompt = async (text) => { started(); await gate; await original(text); };
		return created;
	}) as typeof createAgentSession;
	const runner = new PiSessionRunner({ modelRuntime: MODEL_RUNTIME, createSession: factory });
	const handle = await runner.create(spec(root));
	const inFlight = handle.prompt("waiting");
	await entered;
	await assert.rejects(runner.checkpoint(handle, { inputManifest: manifest, runId: "run", externalOperationsSettled: true }), /idle, completed/);
	release();
	await inFlight;
	const checkpoint = await runner.checkpoint(handle, { inputManifest: manifest, runId: "run", externalOperationsSettled: true });
	assert(checkpoint.leafId);
	handle.dispose();
});

test("fake runner mirrors independent checkpoint snapshots and child scratch identity", async (t) => {
	const root = await fixture(t);
	const manifest = path.join(root, "manifest.json");
	await writeFile(manifest, "{}\n");
	const runner = new FakeSessionRunner(() => "ok");
	const parent = await runner.create(spec(root));
	await parent.prompt("ancestor");
	const checkpoint = await runner.checkpoint(parent, { inputManifest: manifest, runId: "run", externalOperationsSettled: true });
	await parent.prompt("later parent");
	const evidenceBindings = [{ version: 1 as const, label: "frozen", path: manifest, status: "frozen-copy" as const, sourceVersion: checkpoint.id }];
	const a = await runner.fork({ checkpoint, spec: spec(root, { label: "a" }), evidenceBindings, reason: "first option" });
	const b = await runner.fork({ checkpoint, spec: spec(root, { label: "b" }), evidenceBindings, reason: "second option" });
	assert.deepEqual(a.transcript(), b.transcript());
	assert.doesNotMatch(JSON.stringify(a.transcript()), /later parent/);
	const aLineage = JSON.parse(await readFile(a.ref.lineageFile!, "utf8"));
	const bLineage = JSON.parse(await readFile(b.ref.lineageFile!, "utf8"));
	assert.notEqual(aLineage.child.scratch, bLineage.child.scratch);
	assert.notEqual(aLineage.child.sessionFile, bLineage.child.sessionFile);
	a.dispose(); b.dispose();
	const resumed = await runner.resume(a.ref);
	resumed.dispose();
	await rm(b.ref.lineageFile!);
	await assert.rejects(runner.resume(b.ref), /lineage receipt is missing/);
	parent.dispose();
});

test("releases SDK session when post-create sidecar write fails", async (t) => {
	const persistDir = await fixture(t);
	const disposed = { count: 0 };
	const stub = stubFactory(undefined, { blockSpecWrite: true, disposeCounter: disposed });
	await assert.rejects(new PiSessionRunner({ modelRuntime: MODEL_RUNTIME, createSession: stub.factory }).create(spec(persistDir)));
	assert.equal(disposed.count, 1);
});

test("resource samples contain process counters and ending a session stays ended", async (t) => {
	const root = await fixture(t);
	const persistDir = path.join(root, ".agent", "sessions");
	await mkdir(persistDir, { recursive: true });
	const stub = stubFactory();
	const handle = await new PiSessionRunner({ modelRuntime: MODEL_RUNTIME, createSession: stub.factory }).create(spec(persistDir));
	await handle.prompt("offline");
	handle.dispose();
	handle.dispose();
	await new Promise((resolve) => setTimeout(resolve, 30));
	const samples = (await readFile(path.join(root, ".agent", "telemetry", `runner-resources-${process.pid}.jsonl`), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
	assert.deepEqual(samples.map((sample) => sample.event), ["create", "prompt-end", "dispose"]);
	assert(samples.every((sample) => sample.pid === process.pid && sample.rss > 0 && sample.heapUsed > 0 && !JSON.stringify(sample).includes("offline")));
	assert.equal(samples.at(-1).activeSessions, samples[0].activeSessions - 1);
	assert.equal((await readTelemetry(root, handle.ref.id))?.activity, "ended");
});
