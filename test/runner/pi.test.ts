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

function stubFactory(response?: StubResponse): FactoryHarness {
	const calls: CreateAgentSessionOptions[] = [];
	let promptCalls = 0;
	let abortCalls = 0;
	const factory = (async (options: CreateAgentSessionOptions = {}) => {
		calls.push(options);
		const manager = options.sessionManager;
		assert(manager);
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
				const assistant = {
					role: "assistant",
					api: MODEL.api,
					provider: MODEL.provider,
					model: MODEL.id,
					timestamp: Date.now(),
					usage: selected.usage ?? {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					content: selected.content,
					stopReason: selected.stopReason,
					...(selected.errorMessage ? { errorMessage: selected.errorMessage } : {}),
				};
				messages.push(user, assistant);
				manager.appendMessage(user as never);
				manager.appendMessage(assistant as never);
			},
			abort() { abortCalls += 1; },
			dispose() {},
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
		usage: { input: 7, output: 11, cost: 0.3 },
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
