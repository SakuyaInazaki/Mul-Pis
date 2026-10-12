import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { PiSessionRunner } from "../../src/runner/pi.ts";

const MODEL = {
	id: "offline-compaction", name: "Offline compaction", provider: "deepseek", api: "openai-completions",
	baseUrl: "https://api.deepseek.com", reasoning: false, input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1_048_576, maxTokens: 20_000,
	compat: { supportsStore: false, supportsDeveloperRole: false, maxTokensField: "max_tokens" },
} as Model<"openai-completions">;

function completion(text: string, input: number, output = 10): Response {
	const frames = [
		{ id: "fixture", object: "chat.completion.chunk", created: 1, model: MODEL.id,
			choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] },
		{ id: "fixture", object: "chat.completion.chunk", created: 1, model: MODEL.id,
			choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
		{ id: "fixture", object: "chat.completion.chunk", created: 1, model: MODEL.id,
			choices: [], usage: { prompt_tokens: input, completion_tokens: output, total_tokens: input + output } },
	];
	return new Response(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join("") + "data: [DONE]\n\n",
		{ status: 200, headers: { "content-type": "text/event-stream" } });
}

function toolCall(): Response {
	const frames = [
		{ id: "fixture", object: "chat.completion.chunk", created: 1, model: MODEL.id,
			choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "read-1", type: "function",
				function: { name: "material_read", arguments: '{"path":"large.txt"}' } }] }, finish_reason: null }] },
		{ id: "fixture", object: "chat.completion.chunk", created: 1, model: MODEL.id,
			choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
		{ id: "fixture", object: "chat.completion.chunk", created: 1, model: MODEL.id,
			choices: [], usage: { prompt_tokens: 200_001, completion_tokens: 8, total_tokens: 200_009 } },
	];
	return new Response(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join("") + "data: [DONE]\n\n",
		{ status: 200, headers: { "content-type": "text/event-stream" } });
}

test("Pi compacts during a tool loop above 200k and keeps its original summary budget", async t => {
	const root = await mkdtemp(path.join(tmpdir(), "pre-rsi-compact-"));
	const originalFetch = globalThis.fetch;
	let handle: Awaited<ReturnType<PiSessionRunner["create"]>> | undefined;
	const calls: Array<Record<string, unknown>> = [];
	t.after(async () => {
		handle?.dispose();
		globalThis.fetch = originalFetch;
		await rm(root, { recursive: true, force: true });
	});
	const profile = path.join(root, "profile"), sessions = path.join(root, "sessions"), evidence = path.join(root, "evidence");
	await Promise.all([mkdir(profile), mkdir(sessions), mkdir(evidence)]);
	await writeFile(path.join(evidence, "large.txt"), ("e".repeat(99) + "\n").repeat(450));
	await writeFile(path.join(profile, "models.json"), JSON.stringify({ providers: { deepseek: { models: [MODEL] } } }));
	const runtime = await ModelRuntime.create({ modelsPath: path.join(profile, "models.json"),
		authPath: path.join(profile, "auth.json"), modelsStorePath: path.join(profile, "models-store.json"),
		allowModelNetwork: false, refreshOnCreate: false });
	await runtime.setRuntimeApiKey("deepseek", "sk-SYNTHETIC-ONLY");
	globalThis.fetch = async (input, init) => {
		assert.equal(input instanceof Request ? input.url : String(input), "https://api.deepseek.com/chat/completions");
		const body = init?.body;
		assert.equal(typeof body, "string");
		const payload = JSON.parse(body as string) as Record<string, unknown>;
		calls.push(payload);
		if (calls.length === 1) return completion("first turn done", 100_000);
		if (calls.length === 2) return toolCall();
		if (payload.max_tokens === 13_107) return completion("native summary", 1_000);
		return completion("continued after compact", 1_000);
	};
	const runner = new PiSessionRunner({ modelRuntime: runtime });
	handle = await runner.create({ label: "compaction-tool-loop", role: "reader",
		model: "deepseek/offline-compaction:off", systemPrompt: "Read the supplied evidence only",
		tools: { kind: "read-dir", root: evidence }, persistDir: sessions });
	assert.equal((await handle.prompt("a".repeat(100_000))).text, "first turn done");
	const second = await handle.prompt("Read large.txt, then answer. " + "b".repeat(45_000));
	assert.match(second.text, /continued after compact/);
	assert.equal(calls.length, 4);
	assert(handle.ref.file);
	const transcript = (await readFile(handle.ref.file, "utf8")).split("\n").filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>);
	assert.deepEqual(calls.map(call => call.max_tokens), [20_000, 20_000, 13_107, 20_000]);
	assert.equal(calls[0].model, MODEL.id);
	assert.equal(calls[3].model, MODEL.id);
	assert.equal(transcript.filter(row => row.type === "compaction").length, 1);
	assert.equal(transcript.filter(row => row.type === "custom" && row.customType === "workflow_compaction").length, 1);
	assert.equal(MODEL.contextWindow, 1_048_576);
	assert.equal(MODEL.maxTokens, 20_000);
});
