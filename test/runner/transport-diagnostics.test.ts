import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { PiSessionRunner } from "../../src/runner/pi.ts";
import { HarnessError } from "../../src/types.ts";

const MODEL = { id: "deepseek-flash", name: "Offline DeepSeek", provider: "deepseek", api: "openai-completions",
	baseUrl: "https://api.deepseek.com", reasoning: true, input: ["text"],
	cost: { input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0 }, contextWindow: 10_000, maxTokens: 20,
} as Model<"openai-completions">;
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
