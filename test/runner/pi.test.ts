import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { createAgentSession, ModelRuntime, type CreateAgentSessionOptions } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { PiSessionRunner } from "../../src/runner/pi.ts";
import type { CustomToolSpec, SessionSpec } from "../../src/runner/types.ts";
import { HarnessError } from "../../src/types.ts";
import { createConfinedCampaignFileTools } from "../../src/runner/confined-campaign-files.ts";
import { readManagedBashReceipt, readManagedBashSessionReceipts } from "../../src/runner/managed-bash.ts";

import { inspectManagedExecutionSession } from "../../src/m07/managed-local-failure.ts";

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
	assert.deepEqual(loader.getExtensions().extensions.map(extension => extension.path), ["<inline:workflow-compaction>"]);
	assert.equal(loader.getExtensions().extensions[0].tools.size, 0);
	assert.equal(path.dirname(stub.calls[0].cwd!), persistDir);
	assert.match(path.basename(stub.calls[0].cwd!), /^\.pi-session-/);
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

test("managed local bash receipts bind real foreground exits to exact Pi calls", async t => {
	const persistDir = await fixture(t);
	const root = path.join(persistDir, "work");
	await mkdir(root);
	const stub = stubFactory();
	const handle = await new PiSessionRunner({ modelRuntime: MODEL_RUNTIME, createSession: stub.factory })
		.create(spec(persistDir, { tools: { kind: "execution", root, tools: ["bash"] } }));
	const bash = stub.calls[0].customTools?.find(tool => tool.name === "bash");
	assert(bash);
	const goodCommand = "printf head; sleep 0.02; printf tail";
	const good = await bash.execute("call-success", { command: goodCommand }, undefined, undefined, { cwd: root } as never);
	assert.match(JSON.stringify(good.content), /headtail/);
	await assert.rejects(bash.execute("call-failure", { command: "exit 17" }, undefined, undefined,
		{ cwd: root } as never), /code 17/);
	const rows = handle.toolLog();
	assert.deepEqual(rows.map(row => [row.toolCallId, row.ok]), [["call-success", true], ["call-failure", false]]);
	const first = await readManagedBashReceipt(rows[0].hostReceiptPath!);
	const second = await readManagedBashReceipt(rows[1].hostReceiptPath!);
	assert.equal(first.commandSha256, (await import("node:crypto")).createHash("sha256").update(goodCommand).digest("hex"));
	assert.equal(first.toolCallId, "call-success");
	assert.equal(first.sessionId, handle.ref.id);
	assert.equal(first.spawn, "observed");
	assert(first.pid && first.processGroupId === first.pid);
	assert.equal(first.processExit?.exitCode, 0);
	assert.equal(first.toolOutcome, "returned");
	assert.equal(first.outputBytesAtExit, 8);
	assert.equal(second.toolCallId, "call-failure");
	assert.equal(second.processExit?.exitCode, 17);
	assert.equal(second.toolOutcome, "threw");
	assert.equal(second.toolErrorKind, "nonzero-exit");
	assert.equal(second.remoteOrDetachedEffects, "unknown");
	assert.equal((await readManagedBashSessionReceipts(persistDir, handle.ref.id)).length, 2);
	handle.dispose();
});

test("execution bash exposes milliseconds, times out in milliseconds, and rejects legacy timeout before spawn", async t => {
	const persistDir = await fixture(t);
	const root = path.join(persistDir, "work");
	await mkdir(root);
	const stub = stubFactory();
	const handle = await new PiSessionRunner({ modelRuntime: MODEL_RUNTIME, createSession: stub.factory })
		.create(spec(persistDir, { tools: { kind: "execution", root, tools: ["bash"] } }));
	const bash = stub.calls[0].customTools?.find(tool => tool.name === "bash");
	assert(bash);
	const properties = (bash.parameters as { properties: Record<string, unknown> }).properties;
	assert.deepEqual(Object.keys(properties).sort(), ["command", "timeoutMs"]);
	assert.match(bash.description, /timeoutMs.*milliseconds/);
	await assert.rejects(bash.execute("millisecond-timeout", { command: "exec sleep 5", timeoutMs: 50 },
		undefined, undefined, { cwd: root } as never), /Command timed out after 0\.05 seconds/);
	const timedOut = await readManagedBashReceipt(handle.toolLog()[0].hostReceiptPath!);
	assert.equal(timedOut.processExit?.abortSource, "timeout");
	assert.equal(timedOut.toolErrorKind, "timeout");
	await assert.rejects(bash.execute("legacy-timeout", { command: "touch should-not-exist", timeout: 30_000 },
		undefined, undefined, { cwd: root } as never), /use timeoutMs in milliseconds and retry/);
	const rejected = await readManagedBashReceipt(handle.toolLog()[1].hostReceiptPath!);
	assert.equal(rejected.spawn, "not-attempted");
	await assert.rejects(readFile(path.join(root, "should-not-exist")), { code: "ENOENT" });
	handle.dispose();
});

test("detached local child leaves remote or detached effects explicitly unknown", async t => {
	if (process.platform !== "linux") return t.skip("Linux setsid fixture");
	const persistDir = await fixture(t);
	const root = path.join(persistDir, "work");
	await mkdir(root);
	const stub = stubFactory();
	const handle = await new PiSessionRunner({ modelRuntime: MODEL_RUNTIME, createSession: stub.factory })
		.create(spec(persistDir, { tools: { kind: "execution", root, tools: ["bash"] } }));
	const bash = stub.calls[0].customTools?.find(tool => tool.name === "bash");
	assert(bash);
	const result = await bash.execute("call-detached", { command: "setsid sh -c 'sleep 1; printf late' & printf now" },
		undefined, undefined, { cwd: root } as never);
	assert.match(JSON.stringify(result.content), /now/);
	const receipt = await readManagedBashReceipt(handle.toolLog()[0].hostReceiptPath!);
	assert.equal(receipt.processExit?.exitCode, 0);
	assert.equal(receipt.toolOutcome, "returned");
	assert.equal(receipt.remoteOrDetachedEffects, "unknown");
	handle.dispose();
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
	await assert.rejects(before.prompt("must not send"), (error: unknown) => {
		assert(error instanceof HarnessError);
		assert.equal(error.code, "runner.aborted");
		assert.match(error.message, /aborted before prompt/);
		return true;
	});
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
		assert.equal(error.code, "runner.aborted");
		assert.match(error.message, /aborted during prompt/);
		assert.match(error.message, /SDK abort failed: offline abort rejection/);
		return true;
	});
	assert.equal(abortCalls, 1);
	during.dispose();
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
	assert.deepEqual(stub.calls.at(-1)?.resourceLoader?.getExtensions().extensions.map(extension => extension.path), ["<inline:workflow-compaction>"]);
	assert.deepEqual(stub.calls.at(-1)?.resourceLoader?.getSkills().skills, []);
	const firstFile = await readFile(first.ref.file!, "utf8");
	await assert.rejects(inspectManagedExecutionSession({ persistDir: childSessions,
		sessionId: first.ref.id, sessionFile: first.ref.file! }), /forked Pi session/);
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
