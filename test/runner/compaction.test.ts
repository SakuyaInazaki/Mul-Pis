import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { appendCliffDigest, cliffCompaction, compactionPolicyFromEnvironment, WORKFLOW_COMPACTION,
	type CliffDigestRecordV1, type CliffPreparation } from "../../src/runner/compaction.ts";
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

function preparation(overrides: Partial<CliffPreparation> = {}): CliffPreparation {
	return {
		firstKeptEntryId: "entry-9", tokensBefore: 201_000, isSplitTurn: false, turnPrefixMessages: [],
		fileOps: { read: new Set(["kernel.cpp"]), written: new Set(), edited: new Set(["kernel.cpp"]) },
		messagesToSummarize: [],
		...overrides,
	};
}

const TASK = "Optimise the kernel and report the measured latency.";

test("the cliff block deletes and truncates without rewriting", () => {
	const result = cliffCompaction(preparation({ messagesToSummarize: [
		{ role: "user", content: TASK },
		{ role: "assistant", content: [
			{ type: "thinking", thinking: "t".repeat(900) },
			{ type: "text", text: "Trying a wider tile." },
			{ type: "toolCall", id: "c1", name: "candidate_run", arguments: { tile: 128, note: "n".repeat(300) } },
		] },
		{ role: "toolResult", toolName: "candidate_run", isError: true,
			content: [{ type: "text", text: "no member named 'Softmax' in namespace" }] },
		{ role: "toolResult", toolName: "material_read", isError: false,
			content: [{ type: "text", text: "L".repeat(4_000) }] },
		{ role: "user", content: "u".repeat(2_000) },
	] }));
	assert.equal(result.firstKeptEntryId, "entry-9");
	assert.equal(result.droppedMessages, 5);
	assert.equal(result.droppedChars, 900 + 20 + 38 + 4_000 + 2_000 + TASK.length);
	// The first task message survives in full; nothing else is rewritten.
	assert.match(result.summary, /user: Optimise the kernel and report the measured latency\./);
	assert.match(result.summary, /thinking: t{300}…\[\+600\]/);
	assert.match(result.summary, /call candidate_run\(note=n{48}…/);
	assert.match(result.summary, /result material_read: \[dropped 4000 chars\]/);
	assert.match(result.summary, /result candidate_run \(error\): no member named 'Softmax' in namespace/);
	assert.match(result.summary, /files read: none/);
	assert.match(result.summary, /files modified: kernel\.cpp/);
	assert.deepEqual(result.failureSignatures, ["candidate_run: no member named 'Softmax' in namespace"]);
	assert.equal(result.summary.length < 3_000, true);
	// Deterministic: the same transcript renders byte-identically.
	assert.equal(cliffCompaction(preparation({ messagesToSummarize: [{ role: "user", content: TASK }] })).summary,
		cliffCompaction(preparation({ messagesToSummarize: [{ role: "user", content: TASK }] })).summary);
});

test("an earlier cliff block is carried forward instead of compacted again", () => {
	const earlier = cliffCompaction(preparation({ messagesToSummarize: [
		{ role: "user", content: "First task statement." },
	] })).summary;
	const later = cliffCompaction(preparation({ previousSummary: earlier, messagesToSummarize: [
		{ role: "user", content: earlier },
		{ role: "assistant", content: [{ type: "text", text: "Second round." }] },
	] }));
	assert.equal(later.summary.includes(earlier), true);
	assert.equal(later.summary.split("First task statement.").length, 2);
	// The replayed compaction block is skipped, so only the assistant message counts.
	assert.equal(later.droppedMessages, 1);
});

test("the dropped segment is recorded before it leaves the context", async t => {
	const root = await mkdtemp(path.join(tmpdir(), "pre-rsi-digest-"));
	t.after(async () => { await rm(root, { recursive: true, force: true }); });
	const file = path.join(root, "nested", "session.compaction.jsonl");
	const result = cliffCompaction(preparation({ messagesToSummarize: [
		{ role: "toolResult", toolName: "bash", isError: true, content: [{ type: "text", text: "compile failed" }] },
	] }));
	await appendCliffDigest({ file, sessionId: "S1" }, result, "threshold", new Date("2026-10-18T00:00:00.000Z"));
	await appendCliffDigest({ file, sessionId: "S1" }, result, "overflow", new Date("2026-10-18T01:00:00.000Z"));
	const rows = (await readFile(file, "utf8")).split("\n").filter(Boolean).map(line => JSON.parse(line) as CliffDigestRecordV1);
	assert.equal(rows.length, 2);
	assert.deepEqual(rows.map(row => row.reason), ["threshold", "overflow"]);
	assert.equal(rows[0].version, 1);
	assert.equal(rows[0].sessionId, "S1");
	assert.equal(rows[0].tokensBefore, 201_000);
	assert.deepEqual(rows[0].failureSignatures, ["bash: compile failed"]);
	assert.equal(rows[0].summary, result.summary);
});

test("the threshold is the one configurable knob and rejects unusable values", () => {
	assert.deepEqual(compactionPolicyFromEnvironment({}), WORKFLOW_COMPACTION);
	assert.equal(compactionPolicyFromEnvironment({ PRE_RSI_CONTEXT_THRESHOLD_TOKENS: "128000" }).thresholdTokens, 128_000);
	assert.equal(compactionPolicyFromEnvironment({ PRE_RSI_CONTEXT_THRESHOLD_TOKENS: "128000" }).keepRecentTokens,
		WORKFLOW_COMPACTION.keepRecentTokens);
	assert.throws(() => compactionPolicyFromEnvironment({ PRE_RSI_CONTEXT_THRESHOLD_TOKENS: "4096" }), /at least 16384/);
	assert.throws(() => compactionPolicyFromEnvironment({ PRE_RSI_CONTEXT_THRESHOLD_TOKENS: "many" }), /at least 16384/);
});

test("Pi compacts during a tool loop above 200k without any summarization request", async t => {
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
		return completion("continued after compact", 1_000);
	};
	const runner = new PiSessionRunner({ modelRuntime: runtime });
	handle = await runner.create({ label: "compaction-tool-loop", role: "reader",
		model: "deepseek/offline-compaction:off", systemPrompt: "Read the supplied evidence only",
		tools: { kind: "read-dir", root: evidence }, persistDir: sessions });
	assert.equal((await handle.prompt("a".repeat(100_000))).text, "first turn done");
	const second = await handle.prompt("Read large.txt, then answer. " + "b".repeat(45_000));
	assert.match(second.text, /continued after compact/);
	// Three provider calls: two turns and the continuation. Compaction itself called nothing.
	assert.equal(calls.length, 3);
	assert.deepEqual(calls.map(call => call.max_tokens), [20_000, 20_000, 20_000]);
	assert(handle.ref.file);
	const transcript = (await readFile(handle.ref.file, "utf8")).split("\n").filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>);
	const compaction = transcript.filter(row => row.type === "compaction");
	assert.equal(compaction.length, 1);
	assert.match(String(compaction[0].summary), /^<compacted-history>/);
	// Even an oversized opening prompt is bounded, so the cliff always shrinks the context.
	assert.match(String(compaction[0].summary), /user: a{8000}…\[\+9\d{4}\]/);
	assert.equal(String(compaction[0].summary).length < 12_000, true);
	assert.equal(transcript.filter(row => row.type === "custom" && row.customType === "workflow_compaction").length, 1);
	const digest = (await readFile(path.join(sessions, `${handle.ref.id}.compaction.jsonl`), "utf8"))
		.split("\n").filter(Boolean).map(line => JSON.parse(line) as CliffDigestRecordV1);
	assert.equal(digest.length, 1);
	assert.equal(digest[0].reason, "threshold");
	assert.equal(digest[0].sessionId, handle.ref.id);
	assert.equal(digest[0].summary, compaction[0].summary);
	assert.equal(digest[0].droppedChars > 90_000, true);
});
