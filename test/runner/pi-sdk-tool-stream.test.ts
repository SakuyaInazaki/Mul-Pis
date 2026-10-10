import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { setImmediate } from "node:timers/promises";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { DeepSeekCampaignBudget } from "../../src/runner/deepseek-campaign.ts";
import { verifyDeepSeekProviderOutputLimit } from "../../src/runner/deepseek-provider-limits.ts";
import { createConfinedCampaignFileTools, getConfinedCampaignFileGrantDescriptor } from "../../src/runner/confined-campaign-files.ts";
import { PiSessionRunner } from "../../src/runner/pi.ts";

const MODEL = {
	id: "deepseek-flash", name: "Offline DeepSeek", provider: "deepseek", api: "openai-completions",
	baseUrl: "https://api.deepseek.com", reasoning: true, input: ["text"],
	cost: { input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0 },
	contextWindow: 8192, maxTokens: 64,
	compat: { supportsStore: false, supportsDeveloperRole: false, maxTokensField: "max_tokens", thinkingFormat: "deepseek" },
} as Model<"openai-completions">;

function chunk(delta: Record<string, unknown>, finishReason: string | null = null): string {
	return `data: ${JSON.stringify({ id: "offline-stream", object: "chat.completion.chunk", created: 1,
		model: MODEL.id, choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`;
}

function usage(input: number, output: number): string {
	return `data: ${JSON.stringify({ id: "offline-stream", object: "chat.completion.chunk", created: 1,
		model: MODEL.id, choices: [], usage: { prompt_tokens: input, completion_tokens: output,
			total_tokens: input + output } })}\n\n`;
}

async function scenario(t: TestContext, interruptAfterTool: boolean) {
	const dir = await mkdtemp(path.join(tmpdir(), "pi-sdk-tool-stream-"));
	const originalFetch = globalThis.fetch;
	let handle: Awaited<ReturnType<PiSessionRunner["create"]>> | undefined;
	const requests: Array<Record<string, unknown>> = [];
	const server = createServer(async (request, response) => {
		try {
			assert.equal(request.method, "POST");
			assert.equal(request.url, "/chat/completions");
			assert.equal(request.headers.authorization, "Bearer sk-SYNTHETIC-ONLY");
			const parts: Buffer[] = [];
			for await (const part of request) parts.push(Buffer.from(part));
			requests.push(JSON.parse(Buffer.concat(parts).toString("utf8")) as Record<string, unknown>);
			response.writeHead(200, { "content-type": "text/event-stream" });
			if (requests.length === 2 && interruptAfterTool) {
				response.write(chunk({ role: "assistant", content: "partial answer" }));
				await setImmediate();
				response.destroy();
				return;
			}
			const frames = requests.length === 1 ? [
				chunk({ role: "assistant", reasoning_content: "I will write the file. " }),
				chunk({ reasoning_content: "Then inspect the result.", tool_calls: [{ index: 0, id: "call_local_1",
					type: "function", function: { name: "write", arguments: '{"path":"artifact.txt",' } }] }),
				chunk({ tool_calls: [{ index: 0, function: { arguments: '"content":"one execution"}' } }] }),
				chunk({}, "tool_calls"), usage(20, 8), "data: [DONE]\n\n",
			] : [chunk({ role: "assistant", content: "The file was written." }), chunk({}, "stop"),
				usage(30, 6), "data: [DONE]\n\n"];
			// Split every SSE frame inside its JSON payload, not only at event boundaries.
			for (const frame of frames) {
				const middle = Math.floor(frame.length / 2);
				response.write(frame.slice(0, middle));
				await setImmediate();
				response.write(frame.slice(middle));
				await setImmediate();
			}
			response.end();
		} catch (error) { response.destroy(error as Error); }
	});
	await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
	t.after(async () => {
		handle?.dispose();
		globalThis.fetch = originalFetch;
		await new Promise<void>(resolve => server.close(() => resolve()));
		await rm(dir, { recursive: true, force: true });
	});
	const address = server.address();
	assert(address && typeof address !== "string");
	const localEndpoint = `http://127.0.0.1:${address.port}/chat/completions`;
	globalThis.fetch = async (input, init) => {
		assert.equal(input instanceof Request ? input.url : String(input), "https://api.deepseek.com/chat/completions");
		return originalFetch(localEndpoint, init);
	};
	const profile = path.join(dir, "profile"), sessions = path.join(dir, "sessions"), work = path.join(dir, "work");
	await Promise.all([mkdir(profile), mkdir(sessions), mkdir(work)]);
	await writeFile(path.join(profile, "models.json"), JSON.stringify({ providers: { deepseek: { models: [MODEL] } } }));
	const runtime = await ModelRuntime.create({ modelsPath: path.join(profile, "models.json"),
		authPath: path.join(profile, "auth.json"), modelsStorePath: path.join(profile, "models-store.json"),
		allowModelNetwork: false, refreshOnCreate: false });
	await runtime.setRuntimeApiKey("deepseek", "sk-SYNTHETIC-ONLY");
	assert.equal(MODEL.id, "deepseek-flash");
	assert.equal(MODEL.maxTokens, 64);
	assert.equal(MODEL.contextWindow, 8192);
	const provider = await verifyDeepSeekProviderOutputLimit({ apiKey: "synthetic",
		request: async () => new Response(JSON.stringify({ object: "list", data: [{ id: MODEL.id,
			object: "model", name: "DeepSeek-V4.1-Flash", max_output_tokens: MODEL.maxTokens,
			context_window: MODEL.contextWindow }] }), { status: 200 }) });
	const budget = new DeepSeekCampaignBudget({ model: "deepseek/deepseek-flash:low",
		endpoint: "https://api.deepseek.com", providerOutputLimit: provider, outputAccountingMarginTokens: 0 });
	const tools = await createConfinedCampaignFileTools(work, { writableFiles: ["artifact.txt"] });
	const authority = getConfinedCampaignFileGrantDescriptor(tools);
	assert(authority);
	handle = await new PiSessionRunner({ modelRuntime: runtime, campaignBudget: budget }).create({
		label: "sdk-tool-stream", role: "execution", model: "deepseek/deepseek-flash:low",
		systemPrompt: "Use the local tool once", tools: { kind: "custom", tools }, toolAuthority: authority,
		persistDir: sessions,
	});
	return { handle, requests, budget, work };
}

test("Pi 0.85.1 decodes fragmented tool stream, executes once, and encodes the result for the next SDK request", async t => {
	const { handle, requests, budget, work } = await scenario(t, false);
	const result = await handle.prompt("Write the fixture file");
	assert.equal(result.text, "The file was written.");
	assert.equal(result.toolCalls, 1);
	assert.equal(await readFile(path.join(work, "artifact.txt"), "utf8"), "one execution");
	assert.deepEqual(handle.toolLog().map(call => [call.name, call.ok]), [["write", true]]);
	assert.equal(requests.length, 2);
	assert.equal(requests[0].max_tokens, MODEL.maxTokens);
	assert.equal((requests[0].tools as unknown[]).length, 3);
	const first = requests[0].messages as Array<Record<string, unknown>>;
	const second = requests[1].messages as Array<Record<string, unknown>>;
	assert.equal(first.some(message => message.role === "tool"), false);
	const assistant = second.find(message => message.role === "assistant");
	assert(assistant);
	assert.equal(assistant.reasoning_content, "I will write the file. Then inspect the result.");
	assert.deepEqual(assistant.tool_calls, [{ id: "call_local_1", type: "function",
		function: { name: "write", arguments: '{"path":"artifact.txt","content":"one execution"}' } }]);
	assert.deepEqual(second.filter(message => message.role === "tool"), [{ role: "tool",
		tool_call_id: "call_local_1", content: "Wrote the requested task file." }]);
	const audit = budget.requestAccountingAuditSnapshot();
	assert.equal(audit.requests.length, 2);
	assert.deepEqual(audit.requests.map(request => request.reportedUsage?.totalTokens), [28, 36]);
});

test("an interrupted SDK stream after a real tool result fails without replaying the local tool", async t => {
	const { handle, requests, budget, work } = await scenario(t, true);
	await assert.rejects(handle.prompt("Write the fixture file"));
	assert.equal(await readFile(path.join(work, "artifact.txt"), "utf8"), "one execution");
	assert.deepEqual(handle.toolLog().map(call => [call.name, call.ok]), [["write", true]]);
	assert.equal(requests.length, 2, "failed assistant response must not trigger another SDK request");
	const second = requests[1].messages as Array<Record<string, unknown>>;
	assert.equal(second.filter(message => message.role === "tool").length, 1);
	const audit = budget.requestAccountingAuditSnapshot();
	assert.equal(audit.requests.length, 2);
	assert.equal(audit.requests[0].reportedUsage?.totalTokens, 28);
	assert.equal(audit.requests[1].status, "unknown");
	assert.equal(audit.requests[1].reportedUsage, null);
	const diagnostic = handle.transportDiagnostics?.()[0];
	assert(diagnostic);
	assert.equal(diagnostic.responseStarted, true);
	assert.equal(diagnostic.httpStatus, 200);
	assert(diagnostic.bytesRead && diagnostic.bytesRead > 0);
});
