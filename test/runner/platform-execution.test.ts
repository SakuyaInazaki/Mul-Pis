import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { createAgentSession, ModelRuntime, type CreateAgentSessionOptions } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { PiSessionRunner } from "../../src/runner/pi.ts";
import type { PlatformReceiptV1 } from "../../src/platform/gate.ts";
import { profileFixture } from "../platform/profile-fixture.ts";

const MODEL = {
	id: "offline-model", name: "Offline model", api: "anthropic-messages", provider: "offline",
	baseUrl: "https://invalid.example", reasoning: false, input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 10_000, maxTokens: 1_000,
} as Model<"anthropic-messages">;

const MODEL_RUNTIME = { getModels: () => [MODEL] } as unknown as ModelRuntime;

function stubFactory(): { calls: CreateAgentSessionOptions[]; factory: typeof createAgentSession } {
	const calls: CreateAgentSessionOptions[] = [];
	const factory = (async (options: CreateAgentSessionOptions = {}) => {
		calls.push(options);
		const manager = options.sessionManager;
		assert(manager);
		const session = {
			sessionId: manager.getSessionId(), sessionFile: manager.getSessionFile(), messages: [],
			getActiveToolNames: () => [...(options.tools ?? [])],
			async prompt() { /* the platform gate is exercised through the tools, not the model */ },
			abort() { /* no provider request is made in this test */ },
			dispose() { /* nothing to release */ },
		};
		return { session, extensionsResult: undefined } as unknown as Awaited<ReturnType<typeof createAgentSession>>;
	}) as typeof createAgentSession;
	return { calls, factory };
}

const LEGAL = `constexpr int BUFFER_NUM = 2;
pipe.InitBuffer(inQueue, 1024);
inQueue.EnQue(local);
inQueue.DeQue(local);
int tailLength = total % tileLength;
`;

async function boundSession(t: TestContext): Promise<{ work: string; persistDir: string;
	tools: Map<string, NonNullable<CreateAgentSessionOptions["customTools"]>[number]>; receiptFile: string }> {
	const root = await mkdtemp(path.join(tmpdir(), "pre-rsi-platform-exec-"));
	const work = path.join(root, "work");
	const persistDir = path.join(root, "sessions");
	await Promise.all([mkdir(work), mkdir(persistDir), mkdir(path.join(work, "kernel"), { recursive: true })]);
	const raw = profileFixture();
	(raw.deviceSerialization as { leaseFile: string }).leaseFile = path.join(root, "device.lease");
	const profileFile = path.join(root, "platform-profile.json");
	await writeFile(profileFile, JSON.stringify(raw));
	const previous = process.env.PRE_RSI_PLATFORM_PROFILE;
	process.env.PRE_RSI_PLATFORM_PROFILE = profileFile;
	t.after(async () => {
		if (previous === undefined) delete process.env.PRE_RSI_PLATFORM_PROFILE;
		else process.env.PRE_RSI_PLATFORM_PROFILE = previous;
		await rm(root, { recursive: true, force: true });
	});
	const stub = stubFactory();
	const runner = new PiSessionRunner({ modelRuntime: MODEL_RUNTIME, createSession: stub.factory });
	const handle = await runner.create({ label: "platform", role: "execution", model: "offline/offline-model:high",
		systemPrompt: "work on the kernel", tools: { kind: "execution", root: work, tools: ["read", "write", "edit", "bash"] },
		persistDir });
	const tools = new Map((stub.calls[0].customTools ?? []).map(tool => [tool.name, tool]));
	return { work, persistDir, tools, receiptFile: path.join(persistDir, `${handle.ref.id}.platform.jsonl`) };
}

async function receipts(file: string): Promise<PlatformReceiptV1[]> {
	return (await readFile(file, "utf8")).split("\n").filter(Boolean).map(line => JSON.parse(line) as PlatformReceiptV1);
}

test("a candidate that violates the platform contract never reaches the file or the device", async t => {
	const session = await boundSession(t);
	const write = session.tools.get("write");
	const edit = session.tools.get("edit");
	assert(write && edit);
	const context = { cwd: session.work } as never;

	await assert.rejects(write.execute("w1", { path: "kernel/a.cpp", content: "void Launch() { SetBlockDim(1); }" },
		undefined, undefined, context), /REJECTED kernel\/a\.cpp:1 \[single-core-launch\/performance\]/);
	await assert.rejects(readFile(path.join(session.work, "kernel", "a.cpp"), "utf8"), /ENOENT/);

	await write.execute("w2", { path: "kernel/a.cpp", content: LEGAL }, undefined, undefined, context);
	assert.equal(await readFile(path.join(session.work, "kernel", "a.cpp"), "utf8"), LEGAL);

	// The edit is checked against the file it would produce, so the bytes on disk never change.
	await assert.rejects(edit.execute("e1", { path: "kernel/a.cpp",
		edits: [{ oldText: "int tailLength = total % tileLength;", newText: "DeviceApi::Softmax(dst, src);" }] },
		undefined, undefined, context), /not in the API surface/);
	assert.equal(await readFile(path.join(session.work, "kernel", "a.cpp"), "utf8"), LEGAL);

	// One file per round: the accepted write above already used this round.
	await assert.rejects(write.execute("w3", { path: "kernel/b.cpp", content: LEGAL }, undefined, undefined, context),
		/allows one file per round; this round already changed kernel\/a\.cpp/);

	await assert.rejects(write.execute("w4", { path: "verify/reference.py", content: "pass\n" }, undefined, undefined, context),
		/keeps verify\/reference\.py read-only/);

	assert.deepEqual((await receipts(session.receiptFile)).map(row => row.kind),
		["write-rejected", "write-rejected", "second-file-in-turn", "write-outside-surface"]);
});

test("toolchain output is answered mechanically and device commands hold the device", async t => {
	const session = await boundSession(t);
	const bash = session.tools.get("bash");
	assert(bash);
	const context = { cwd: session.work } as never;
	const visible = (result: unknown): string => {
		const content = (result as { content?: Array<{ type: string; text?: string }> }).content ?? [];
		return content.filter(item => item.type === "text").map(item => item.text ?? "").join("\n");
	};

	const failed = await bash.execute("b1", { command: "echo \"error: no member named 'Softmax' in namespace\"" },
		undefined, undefined, context);
	const text = visible(failed);
	// The original bytes stay above the mechanical reading.
	assert.match(text, /error: no member named 'Softmax' in namespace/);
	assert.match(text, /class syntax: missing-symbol/);
	assert.match(text, /symbol Softmax is not declared; nearest declared: SoftMax/);

	const profiled = await bash.execute("b2", { command: "echo 'mte2_ratio: 0.63' && echo 'vector_ratio: 0.26'" },
		undefined, undefined, context);
	assert.match(visible(profiled), /bottleneck transfer from mte2_ratio=0.63 vector_ratio=0.26/);

	const quiet = await bash.execute("b3", { command: "echo ordinary output" }, undefined, undefined, context);
	assert.equal(visible(quiet).trim(), "ordinary output");

	// A device command takes the lease for its duration and gives it back.
	const measured = await bash.execute("b4", { command: "echo device-run case c1" }, undefined, undefined, context);
	assert.match(visible(measured), /device-run case c1/);
	await assert.rejects(readFile(path.join(path.dirname(session.work), "device.lease"), "utf8"), /ENOENT/);

	// The model-facing shell is rebuilt without the host's platform binding.
	const leaked = await bash.execute("b5", { command: "echo \"profile=[$PRE_RSI_PLATFORM_PROFILE]\"" },
		undefined, undefined, context);
	assert.match(visible(leaked), /profile=\[\]/);

	const kinds = (await receipts(session.receiptFile)).map(row => row.kind);
	assert.deepEqual(kinds.filter(kind => kind === "device-lease").length, 1);
	assert.deepEqual(kinds.filter(kind => kind === "diagnosis").length, 2);
});
