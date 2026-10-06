import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createAgentSession, ModelRuntime, type CreateAgentSessionOptions } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, type Model } from "@earendil-works/pi-ai";
import { DeepSeekCampaignBudget, isSettledLocalCampaignBudgetStop, settledLocalCampaignBudgetStopDetails,
	type DeepSeekCampaignLimits } from "../../src/runner/deepseek-campaign.ts";
import { isSettledTerminalResponse, settledTerminalResponseDetails } from "../../src/runner/operation-disposition.ts";
import { createConfinedCampaignFileTools } from "../../src/runner/confined-campaign-files.ts";
import { PiSessionRunner } from "../../src/runner/pi.ts";
import { openBoundedSession } from "../../src/context/boundary.ts";
import { createFileKnowledgeStore } from "../../src/knowledge/store.ts";
import { createM07Controller } from "../../src/m07/controller.ts";
import type { StageContext } from "../../src/stages/context.ts";
import { Workspace } from "../../src/workspace.ts";
import type { SessionRunner, SessionSpec } from "../../src/runner/types.ts";
import type { StageRunRecord } from "../../src/types.ts";

const MODEL = {
	id: "deepseek-flash", name: "Offline DeepSeek", provider: "deepseek", api: "openai-completions",
	baseUrl: "https://api.deepseek.com", reasoning: true, input: ["text"],
	cost: { input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0 },
	contextWindow: 10000, maxTokens: 100,
} as Model<"openai-completions">;

const LIMITS: DeepSeekCampaignLimits = {
	model: "deepseek/deepseek-flash:low", endpoint: "https://api.deepseek.com",
	maxCny: 0.006, priorCommittedCny: 0, maxProviderCalls: 2, maxProviderCallsPerPrompt: 2,
	maxOutputTokens: 20, outputAccountingMarginTokens: 32,
	estimatedInputCnyPerMillionTokens: 4, estimatedOutputCnyPerMillionTokens: 16, estimatedCnyPerUsd: 10,
};

function spec(dir: string, label: string, tools: SessionSpec["tools"] = { kind: "none" }): SessionSpec {
	return { label, role: "execution", model: LIMITS.model, systemPrompt: "offline test", tools, persistDir: dir };
}

function offlineRuntime(sent: { count: number; options: Array<{ maxTokens?: number; maxRetries?: number }> }, requestModel: Model<"openai-completions"> = MODEL): ModelRuntime {
	return {
		getModels: () => [MODEL],
		async streamSimple(model: Model<"openai-completions">, _context: unknown, options: { maxTokens?: number; maxRetries?: number; onPayload?: (payload: unknown, model: Model<"openai-completions">) => Promise<unknown> }) {
			sent.options.push({ maxTokens: options.maxTokens, maxRetries: options.maxRetries });
			await options.onPayload?.({ model: model.id, messages: [{ role: "user", content: "offline" }], max_tokens: options.maxTokens }, requestModel);
			sent.count++;
		},
	} as unknown as ModelRuntime;
}

function offlineFactory(rounds: number): typeof createAgentSession {
	return (async (options: CreateAgentSessionOptions = {}) => {
		const manager = options.sessionManager!;
		const messages: unknown[] = [];
		return {
			session: {
				sessionId: manager.getSessionId(), sessionFile: manager.getSessionFile(), messages,
				getActiveToolNames: () => options.tools ?? [],
				async prompt(text: string) {
					const user = { role: "user", content: text, timestamp: Date.now() };
					messages.push(user); manager.appendMessage(user as never);
					for (let i = 0; i < rounds; i++) {
						await (options.modelRuntime as unknown as { streamSimple: (model: unknown, context: unknown, options: unknown) => Promise<unknown> }).streamSimple(options.model, { messages }, {});
						const assistant = {
							role: "assistant", api: MODEL.api, provider: MODEL.provider, model: MODEL.id,
							content: [{ type: "text", text: `round ${i + 1}` }], stopReason: i < rounds - 1 ? "toolUse" : "stop",
							timestamp: Date.now(), usage: { input: 10, output: 4, cacheRead: 0, cacheWrite: 0, totalTokens: 14,
								cost: { input: 0.000003, output: 0.0000048, cacheRead: 0, cacheWrite: 0, total: 0.0000078 } },
						};
						messages.push(assistant); manager.appendMessage(assistant as never);
					}
				},
				abort() {}, dispose() {},
			},
		} as unknown as Awaited<ReturnType<typeof createAgentSession>>;
	}) as typeof createAgentSession;
}

function streamFactory(rounds: number): typeof createAgentSession {
	return (async (options: CreateAgentSessionOptions = {}) => {
		const manager = options.sessionManager!;
		const messages: unknown[] = [];
		return { session: {
			sessionId: manager.getSessionId(), sessionFile: manager.getSessionFile(), messages,
			getActiveToolNames: () => options.tools ?? [],
			async prompt(text: string) {
				const user = { role: "user", content: text, timestamp: Date.now() };
				messages.push(user); manager.appendMessage(user as never);
				for (let i = 0; i < rounds; i++) {
					const stream = (options.modelRuntime as ModelRuntime).streamSimple(options.model!, { messages } as never, {});
					let assistant: unknown;
					for await (const event of stream) {
						if (event.type === "done") assistant = event.message;
						if (event.type === "error") throw new Error(event.error.errorMessage ?? "stream error");
					}
					if (!assistant) throw new Error("stream had no assistant");
					messages.push(assistant); manager.appendMessage(assistant as never);
				}
			},
			abort() {}, dispose() {},
		} } as unknown as Awaited<ReturnType<typeof createAgentSession>>;
	}) as typeof createAgentSession;
}

test("campaign reserves each tool-loop provider request before transport, then refuses a third", async (t) => {
	const dir = await mkdtemp(path.join(tmpdir(), "deepseek-campaign-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const sent = { count: 0, options: [] as Array<{ maxTokens?: number; maxRetries?: number }> };
	const budget = new DeepSeekCampaignBudget(LIMITS);
	const runner = new PiSessionRunner({ modelRuntime: offlineRuntime(sent), createSession: offlineFactory(2), campaignBudget: budget });
	const builder = await runner.create(spec(dir, "builder", { kind: "custom", tools: await createConfinedCampaignFileTools(dir, { writableFiles: ["candidate.cpp"] }) }));
	assert.equal((await builder.prompt("build")).text, "round 2");
	assert.equal(sent.count, 2);
	assert.deepEqual(sent.options, [{ maxTokens: 20, maxRetries: 0 }, { maxTokens: 20, maxRetries: 0 }]);
	assert.equal(budget.snapshot().reservations, 2);
	assert.equal(budget.snapshot().stopped, false);
	const reviewer = await runner.create(spec(dir, "reviewer"));
	await assert.rejects(reviewer.prompt("review"), /campaign provider call limit exhausted/);
	assert.equal(sent.count, 2, "denied request must not reach transport");
	assert.equal(budget.snapshot().stopped, true);
	assert.equal(budget.snapshot().stopReason, "provider-call-limit");
	builder.dispose(); reviewer.dispose();
});

test("audited campaign file tools fork into an independently bound work root without inherited provider charge", async (t) => {
	const dir = await mkdtemp(path.join(tmpdir(), "deepseek-fork-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const base = path.join(dir, "tasks");
	const parentRoot = path.join(base, "T001", "work");
	const childRoot = path.join(base, "T002", "work");
	const frozenRoot = path.join(dir, "frozen");
	const sessions = path.join(dir, "sessions");
	await Promise.all([parentRoot, childRoot, frozenRoot, sessions].map((root) => mkdir(root, { recursive: true })));
	for (const root of [parentRoot, childRoot, frozenRoot]) await writeFile(path.join(root, "candidate.cpp"), "parent\n");
	const files = [{ sourcePath: path.join(parentRoot, "candidate.cpp"), frozenPath: path.join(frozenRoot, "candidate.cpp"), childPath: path.join(childRoot, "candidate.cpp"), bytes: 7 }];
	const authority = { version: 1 as const, parentRoot, authorizedChildRootBase: base, childWorkLeaf: "work", frozenEvidenceRoot: frozenRoot, files: files.map(({ sourcePath, frozenPath, bytes }) => ({ sourcePath, frozenPath, bytes })) };
	const manifest = path.join(dir, "manifest.json");
	await writeFile(manifest, `${JSON.stringify({ forkWorkspaceAuthority: authority })}\n`);
	const sent = { count: 0, options: [] as Array<{ maxTokens?: number; maxRetries?: number }> };
	const budget = new DeepSeekCampaignBudget({ ...LIMITS, maxCny: 1, maxProviderCalls: 3, maxProviderCallsPerPrompt: 1 });
	const runner = new PiSessionRunner({ modelRuntime: offlineRuntime(sent), createSession: offlineFactory(1), campaignBudget: budget });
	const parentTools = await createConfinedCampaignFileTools(parentRoot, { writableFiles: ["candidate.cpp"] });
	const parent = await runner.create(spec(sessions, "parent", { kind: "custom", tools: parentTools }));
	assert.deepEqual(await runner.attestConfinedGrant(parent), { version: 1, kind: "confined-campaign-files", root: parentRoot, writableFiles: ["candidate.cpp"] });
	assert.equal(await runner.attestConfinedGrant({ ...parent, ref: { ...parent.ref } }), undefined, "copied ref cannot attest the live factory-backed grant");
	await parent.prompt("parent route");
	const checkpoint = await runner.checkpoint(parent, { inputManifest: manifest, runId: "run", taskId: "T001", externalOperationsSettled: true });
	const ownerMarkerPath = path.join(childRoot, "fork-owner.json");
	await writeFile(ownerMarkerPath, JSON.stringify({ version: 1, checkpointId: checkpoint.id, parentRoot, childRoot, childContainer: "T002" }));
	const childTools = await createConfinedCampaignFileTools(childRoot, { writableFiles: ["candidate.cpp"] });
	const child = await runner.fork({ checkpoint, spec: spec(sessions, "child", { kind: "custom", tools: childTools }),
		evidenceBindings: [{ version: 1, label: "frozen work", path: manifest, status: "frozen-copy", sourceVersion: checkpoint.id }],
		workspaceBinding: { ...authority, childRoot, ownerMarkerPath, files }, reason: "parallel candidate" });
	assert.equal(JSON.parse(await readFile(child.ref.specFile!, "utf8")).toolAuthority.root, childRoot);
	assert.equal((await runner.attestConfinedGrant(child))?.root, childRoot);
	assert.equal(child.usageEvents().length, 0);
	await child.prompt("child route");
	assert.equal(budget.snapshot().reservations, 2, "copied ancestor usage must not cause another provider reservation");
	assert.equal(sent.count, 2);
	await childTools.find((tool) => tool.name === "write")!.execute({ path: "candidate.cpp", content: "child\n" });
	assert.equal(await readFile(path.join(parentRoot, "candidate.cpp"), "utf8"), "parent\n");
	assert.equal(await readFile(path.join(childRoot, "candidate.cpp"), "utf8"), "child\n");
	await assert.rejects(childTools.find((tool) => tool.name === "write")!.execute({ path: path.join(parentRoot, "candidate.cpp"), content: "escape" }), /bounded relative file path/);
	const outsideRoot = path.join(dir, "unrelated", "work");
	await mkdir(outsideRoot, { recursive: true });
	await writeFile(path.join(outsideRoot, "candidate.cpp"), "parent\n");
	const outsideTools = await createConfinedCampaignFileTools(outsideRoot, { writableFiles: ["candidate.cpp"] });
	const outsideOwner = path.join(outsideRoot, "fork-owner.json");
	await writeFile(outsideOwner, JSON.stringify({ version: 1, checkpointId: checkpoint.id, parentRoot, childRoot: outsideRoot, childContainer: "unrelated" }));
	await assert.rejects(runner.fork({ checkpoint, spec: spec(sessions, "outside-child", { kind: "custom", tools: outsideTools }),
		evidenceBindings: [{ version: 1, label: "frozen work", path: manifest, status: "frozen-copy", sourceVersion: checkpoint.id }],
		workspaceBinding: { ...authority, childRoot: outsideRoot, ownerMarkerPath: outsideOwner, files: files.map((file) => ({ ...file, childPath: path.join(outsideRoot, "candidate.cpp") })) }, reason: "forged root" }), /not a separate task directory|not independently bound/);
	const broaderTools = await createConfinedCampaignFileTools(childRoot, { writableFiles: ["candidate.cpp", "extra.cpp"] });
	await assert.rejects(runner.fork({ checkpoint, spec: spec(sessions, "broader-child", { kind: "custom", tools: broaderTools }),
		evidenceBindings: [{ version: 1, label: "frozen work", path: manifest, status: "frozen-copy", sourceVersion: checkpoint.id }],
		workspaceBinding: { ...authority, childRoot, ownerMarkerPath, files }, reason: "broader write grant" }), /equal-or-narrower write allowlist/);
	child.dispose(); parent.dispose();
});

test("controller records a live-attested execution-to-confined-custom narrowing before any prompt", async (t) => {
	const dir = await mkdtemp(path.join(tmpdir(), "deepseek-boundary-attest-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const work = path.join(dir, "work");
	const sessions = path.join(dir, "sessions");
	await Promise.all([mkdir(work), mkdir(sessions)]);
	const budget = new DeepSeekCampaignBudget({ ...LIMITS, maxCny: 1 });
	const sent = { count: 0, options: [] as Array<{ maxTokens?: number; maxRetries?: number }> };
	const actual = new PiSessionRunner({ modelRuntime: offlineRuntime(sent), createSession: offlineFactory(1), campaignBudget: budget });
	const wrapper: SessionRunner = {
		create: async (requested) => actual.create({ ...requested, tools: { kind: "custom", tools: await createConfinedCampaignFileTools(work, { writableFiles: ["candidate.cpp"] }) } }),
		resume: (ref) => actual.resume(ref),
		attestConfinedGrant: (handle) => actual.attestConfinedGrant(handle),
	};
	const requested = spec(sessions, "bounded-builder", { kind: "execution", root: work, tools: ["read", "write"] });
	const run: StageRunRecord = { stage: "M07", runId: "R001", startedAt: new Date().toISOString(), status: "running", inputs: [], outputs: [], sessions: [], failures: [], remarks: [] };
	const handle = await openBoundedSession(wrapper, run, { mode: "fresh", intent: "new-work", reason: "audited private builder", evidence: [], spec: requested }, async () => { await writeFile(path.join(dir, "run.json"), JSON.stringify(run)); });
	assert.equal(sent.count, 0);
	assert.deepEqual(run.sessions[0].boundary?.capability, { kind: "custom", toolNames: ["edit", "read", "write"], root: work, writableFiles: ["candidate.cpp"] });
	assert.deepEqual(run.sessions[0].boundary?.requestedCapability, { kind: "execution", root: work, toolNames: ["read", "write"] });
	assert.equal(JSON.parse(await readFile(path.join(dir, "run.json"), "utf8")).sessions[0].boundary.capability.root, work);
	await assert.rejects(openBoundedSession(wrapper, run, { mode: "fresh", intent: "new-work", reason: "read-only build must stay read-only", evidence: [],
		spec: { ...requested, label: "read-only-request", tools: { kind: "execution", root: work, tools: ["read"] } } }, async () => {}), /would add read or write authority/);
	assert.equal(run.sessions.length, 1);
	handle.dispose();
});

test("campaign rejects endpoint changes and unavailable payload sizes closed", async (t) => {
	const dir = await mkdtemp(path.join(tmpdir(), "deepseek-campaign-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const changed = { ...MODEL, baseUrl: "https://evil.invalid" };
	const sent = { count: 0, options: [] as Array<{ maxTokens?: number; maxRetries?: number }> };
	const budget = new DeepSeekCampaignBudget(LIMITS);
	const runner = new PiSessionRunner({ modelRuntime: offlineRuntime(sent, changed), createSession: offlineFactory(1), campaignBudget: budget });
	const handle = await runner.create(spec(dir, "changed-endpoint"));
	await assert.rejects(handle.prompt("x"), /DeepSeek model, endpoint or pricing data did not verify/);
	assert.equal(sent.count, 0);
	assert.equal(budget.snapshot().stopped, true);
	assert.equal(budget.snapshot().stopReason, "prompt-failure");
	await assert.rejects(handle.prompt("again"), /campaign is stopped/);
	handle.dispose();

	const direct = new DeepSeekCampaignBudget(LIMITS);
	const lease = direct.beginPrompt("direct", "1");
	assert.throws(() => direct.reserve(lease, 0, "direct-1"), /payload byte count is unavailable/);
	assert.equal(direct.snapshot().stopped, true);
	assert.equal(direct.snapshot().stopReason, "payload-boundary");
	assert.throws(() => direct.beginPrompt("direct", "2"), /campaign is stopped/);
});

test("campaign accepts input above the former 96 KB cap and reserves its actual serialized bytes", async (t) => {
	const dir = await mkdtemp(path.join(tmpdir(), "deepseek-campaign-dynamic-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const content = "x".repeat(110_000);
	const payload = { model: "deepseek-flash", messages: [{ role: "user", content }], max_tokens: 20 };
	const payloadBytes = Buffer.byteLength(JSON.stringify(payload), "utf8");
	assert(payloadBytes > 96_000);
	let dispatched = 0;
	const runtime = {
		getModels: () => [MODEL],
		async streamSimple(model: Model<"openai-completions">, _context: unknown, options: { onPayload?: (payload: unknown, model: Model<"openai-completions">) => Promise<unknown> }) {
			await options.onPayload?.(payload, model);
			dispatched++;
		},
	} as unknown as ModelRuntime;
	const budget = new DeepSeekCampaignBudget({ ...LIMITS, maxCny: 1, maxProviderCalls: 1, maxProviderCallsPerPrompt: 1 });
	const handle = await new PiSessionRunner({ modelRuntime: runtime, createSession: offlineFactory(1), campaignBudget: budget }).create(spec(dir, "large-input"));
	await handle.prompt("offline");
	const expectedCny = (payloadBytes * LIMITS.estimatedInputCnyPerMillionTokens +
		(LIMITS.maxOutputTokens + LIMITS.outputAccountingMarginTokens) * LIMITS.estimatedOutputCnyPerMillionTokens) / 1_000_000;
	assert.equal(dispatched, 1);
	assert.equal(budget.snapshot().reservedCny, expectedCny);
	assert.equal(budget.snapshot().stopped, false);
	handle.dispose();
});

test("campaign rejects inconsistent simultaneous provider output-cap fields before transport", async (t) => {
	const dir = await mkdtemp(path.join(tmpdir(), "deepseek-campaign-cap-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	let dispatched = 0;
	const runtime = {
		getModels: () => [MODEL],
		async streamSimple(model: Model<"openai-completions">, _context: unknown, options: { onPayload?: (payload: unknown, model: Model<"openai-completions">) => Promise<unknown> }) {
			await options.onPayload?.({ model: model.id, messages: [], max_tokens: 20, max_completion_tokens: 50 }, model);
			dispatched++;
		},
	} as unknown as ModelRuntime;
	const budget = new DeepSeekCampaignBudget(LIMITS);
	const handle = await new PiSessionRunner({ modelRuntime: runtime, createSession: offlineFactory(1), campaignBudget: budget }).create(spec(dir, "inconsistent-cap"));
	await assert.rejects(handle.prompt("offline"), /output cap missing or inconsistent/);
	assert.equal(dispatched, 0);
	assert.equal(budget.snapshot().reservations, 0);
	assert.equal(budget.snapshot().stopped, true);
	handle.dispose();
});

test("campaign denies the next large payload before transport when cumulative CNY would exceed the ceiling", async (t) => {
	const dir = await mkdtemp(path.join(tmpdir(), "deepseek-campaign-money-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	let dispatched = 0;
	const payload = { model: "deepseek-flash", messages: [{ role: "user", content: "x".repeat(120_000) }], max_tokens: 20 };
	const payloadBytes = Buffer.byteLength(JSON.stringify(payload), "utf8");
	const runtime = {
		getModels: () => [MODEL],
		async streamSimple(model: Model<"openai-completions">, _context: unknown, options: { onPayload?: (payload: unknown, model: Model<"openai-completions">) => Promise<unknown> }) {
			await options.onPayload?.(payload, model);
			dispatched++;
		},
	} as unknown as ModelRuntime;
	const budget = new DeepSeekCampaignBudget({ ...LIMITS, maxCny: 0.5, maxProviderCalls: 2 });
	const handle = await new PiSessionRunner({ modelRuntime: runtime, createSession: offlineFactory(2), campaignBudget: budget }).create(spec(dir, "money-ceiling"));
	await assert.rejects(handle.prompt("offline"), /campaign global CNY total exhausted/);
	const firstReservation = (payloadBytes * LIMITS.estimatedInputCnyPerMillionTokens +
		(LIMITS.maxOutputTokens + LIMITS.outputAccountingMarginTokens) * LIMITS.estimatedOutputCnyPerMillionTokens) / 1_000_000;
	assert.equal(budget.snapshot().reservedCny, firstReservation);
	assert.equal(budget.snapshot().reservations, 1);
	assert.equal(dispatched, 1, "denied second payload must not reach the transport");
	assert.equal(budget.snapshot().stopReason, "total-cny-ceiling");
	handle.dispose();
});

test("campaign refuses native execution tools, which could bypass provider metering", async (t) => {
	const dir = await mkdtemp(path.join(tmpdir(), "deepseek-campaign-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const sent = { count: 0, options: [] as Array<{ maxTokens?: number; maxRetries?: number }> };
	const runner = new PiSessionRunner({ modelRuntime: offlineRuntime(sent), createSession: offlineFactory(1), campaignBudget: new DeepSeekCampaignBudget(LIMITS) });
	await assert.rejects(runner.create(spec(dir, "native-tools", { kind: "execution", root: dir, tools: ["read", "write", "edit", "bash"] })), /native execution tools are unsafe/);
	await assert.rejects(runner.create(spec(dir, "unreviewed-custom", { kind: "custom", tools: [{ name: "network", description: "unsafe", params: {}, execute: async () => ({ text: "bad" }) }] })), /audited confined file grant/);
	await assert.rejects(runner.create(spec(dir, "extra-tool", { kind: "read-dir", root: dir, extraTools: [{ name: "network", description: "unsafe", params: {}, execute: async () => ({ text: "bad" }) }] })), /cannot include arbitrary extra tools/);
	assert.equal(sent.count, 0);
});

test("audited campaign file tools confine reads and allowlisted writes", async (t) => {
	const dir = await mkdtemp(path.join(tmpdir(), "deepseek-campaign-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const outside = path.join(dir, "..", `outside-${path.basename(dir)}.txt`);
	await writeFile(outside, "private");
	t.after(() => rm(outside, { force: true }));
	await symlink(outside, path.join(dir, "escape.txt"));
	const [read, write, edit] = await createConfinedCampaignFileTools(dir, { writableFiles: ["candidate.cpp"] });
	await assert.rejects(read.execute({ path: "../outside.txt" }), /bounded relative file path/);
	await assert.rejects(read.execute({ path: "escape.txt" }), /regular file inside/);
	await assert.rejects(write.execute({ path: "other.cpp", content: "bad" }), /write allowlist/);
	await write.execute({ path: "candidate.cpp", content: "int main() { return 0; }" });
	await edit.execute({ path: "candidate.cpp", oldText: "return 0", newText: "return 1" });
	assert.equal(await readFile(path.join(dir, "candidate.cpp"), "utf8"), "int main() { return 1; }");
	assert.equal((await read.execute({ path: "candidate.cpp" })).text, "int main() { return 1; }");
	assert.throws(() => { (write as { execute: unknown }).execute = async () => ({ text: "unsafe" }); }, /read only|Cannot assign/);
	const mutable = [read, write, edit];
	const bounded = new DeepSeekCampaignBudget(LIMITS).boundSpec(spec(dir, "immutable-tools", { kind: "custom", tools: mutable }));
	mutable[0] = { name: "network", description: "unsafe", params: {}, execute: async () => ({ text: "bad" }) };
	assert.equal(bounded.tools.kind, "custom");
	if (bounded.tools.kind === "custom") {
		assert.equal(bounded.tools.tools[0], read);
		assert(Object.isFrozen(bounded.tools.tools));
	}
});

test("no-campaign strict path remains exactly one tool-free provider request", async (t) => {
	const dir = await mkdtemp(path.join(tmpdir(), "deepseek-campaign-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const sent = { count: 0, options: [] as Array<{ maxTokens?: number; maxRetries?: number }> };
	const runner = new PiSessionRunner({ modelRuntime: offlineRuntime(sent), createSession: offlineFactory(2) });
	await assert.rejects(runner.create({ ...spec(dir, "regression"), strictRequest: {
		maxProviderCallsPerPrompt: 2, maxInputPayloadBytes: 500, maxOutputTokens: 20,
	} }), /strict request requires positive integer caps/);
	assert.equal(sent.count, 0);
});

test("campaign halts when usage ledger cannot be persisted after a successful response", async (t) => {
	const dir = await mkdtemp(path.join(tmpdir(), "deepseek-campaign-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const sent = { count: 0, options: [] as Array<{ maxTokens?: number; maxRetries?: number }> };
	const budget = new DeepSeekCampaignBudget(LIMITS);
	const runner = new PiSessionRunner({ modelRuntime: offlineRuntime(sent), createSession: offlineFactory(1), campaignBudget: budget });
	const handle = await runner.create(spec(dir, "disk-error"));
	await mkdir(handle.ref.file!.replace(/\.jsonl$/, ".usage.jsonl"));
	await assert.rejects(handle.prompt("one"), /EISDIR|illegal operation on a directory/);
	assert.equal(sent.count, 1);
	assert.equal(budget.snapshot().reservations, 1);
	assert.equal(budget.snapshot().stopped, true);
	assert.equal(budget.snapshot().stopReason, "prompt-failure");
	const retained = budget.snapshot().reservedCny;
	assert(retained > 0, "unknown outcome must retain its full dynamic reservation");
	await assert.rejects(handle.prompt("no retry"), /campaign is stopped/);
	assert.equal(budget.snapshot().reservedCny, retained, "unknown outcome cannot refund the reservation");
	handle.dispose();
});

test("campaign rejects impossible token usage, independently of price estimates", () => {
	for (const usage of [
		{ input: 501, output: 4, cacheRead: 0, cacheWrite: 0, totalTokens: 505, cost: 0.00001 },
		{ input: 10, output: 53, cacheRead: 0, cacheWrite: 0, totalTokens: 63, cost: 0.00001 },
		{ input: 10, output: 4, cacheRead: 0, cacheWrite: 0, totalTokens: 13, cost: 0.00001 },
	]) {
		const budget = new DeepSeekCampaignBudget(LIMITS);
		const lease = budget.beginPrompt("direct", "1"); budget.reserve(lease, 100, "request-1");
		assert.throws(() => budget.finishPrompt(lease, [{ requestId: "request-1", event: { entryId: "offline", kind: "assistant", promptIndex: 1,
			at: new Date().toISOString(), provider: "deepseek", model: "deepseek-flash", stopReason: "stop",
			usage, status: "reported", costStatus: "priced", costSource: "sdk-estimate" } }]), /provider usage or call outcome/);
		assert.equal(budget.snapshot().stopped, true);
		assert.equal(budget.snapshot().stopReason, "usage-reconciliation");
		assert.equal(budget.snapshot().reservations, 1);
	}
});

test("campaign reconciles each usage event against its own differently sized input reservation", () => {
	const budget = new DeepSeekCampaignBudget({ ...LIMITS, maxCny: 1 });
	const lease = budget.beginPrompt("direct", "1");
	budget.reserve(lease, 100, "request-1");
	budget.reserve(lease, 120_000, "request-2");
	const retained = budget.snapshot().reservedCny;
	const event = (id: string, input: number) => ({ entryId: id, kind: "assistant" as const, promptIndex: 1,
		at: new Date().toISOString(), provider: "deepseek", model: "deepseek-flash", stopReason: "toolUse",
		usage: { input, output: 4, cacheRead: 0, cacheWrite: 0, totalTokens: input + 4, cost: 0.00001 },
		status: "reported" as const, costStatus: "priced" as const, costSource: "sdk-estimate" as const });
	assert.throws(() => budget.finishPrompt(lease, [
		{ requestId: "request-1", event: event("first", 101) },
		{ requestId: "request-2", event: event("second", 100) },
	]), /provider usage or call outcome/);
	assert.equal(budget.snapshot().stopReason, "usage-reconciliation");
	assert.equal(budget.snapshot().reservations, 2);
	assert.equal(budget.snapshot().reservedCny, retained, "ambiguous usage must not refund either request");
});

function reported(id: string, promptIndex = 1, input = 10, stopReason = "stop") {
	return { entryId: id, kind: "assistant" as const, promptIndex,
		at: new Date().toISOString(), provider: "deepseek", model: "deepseek-flash", stopReason,
		usage: { input, output: 4, cacheRead: 0, cacheWrite: 0, totalTokens: input + 4, cost: 0.0000078 },
		status: "reported" as const, costStatus: "priced" as const, costSource: "sdk-estimate" as const };
}

test("parallel branch leases reserve a single shared call/CNY ceiling with interleaved tool requests", () => {
	const budget = new DeepSeekCampaignBudget({ ...LIMITS, maxProviderCalls: 3, maxProviderCallsPerPrompt: 2, maxCny: 1 });
	const left = budget.beginPrompt("left-session", "1");
	const right = budget.beginPrompt("right-session", "1");
	budget.reserve(left, 100, "left-1");
	budget.reserve(right, 200, "right-1");
	budget.reserve(left, 300, "left-2");
	assert.equal(budget.snapshot().activePrompts, 2);
	assert.equal(budget.snapshot().reservations, 3);
	budget.finishPrompt(right, [{ requestId: "right-1", event: reported("right-entry") }]);
	budget.finishPrompt(left, [
		{ requestId: "left-1", event: reported("left-entry-1", 1, 10, "toolUse") },
		{ requestId: "left-2", event: reported("left-entry-2") },
	]);
	assert.equal(budget.snapshot().activePrompts, 0);
	assert.equal(budget.snapshot().stopped, false);
	const next = budget.beginPrompt("third-session", "1");
	assert.throws(() => budget.reserve(next, 100, "third-1"), /campaign provider call limit exhausted/);
	assert.equal(budget.snapshot().reservations, 3);
	assert.equal(budget.snapshot().stopReason, "provider-call-limit");
});

test("two Pi handles may prompt concurrently while sharing one budget", async (t) => {
	const dir = await mkdtemp(path.join(tmpdir(), "deepseek-parallel-handles-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	let dispatched = 0;
	const runtime = {
		getModels: () => [MODEL],
		async streamSimple(model: Model<"openai-completions">, _context: unknown, options: { onPayload?: (payload: unknown, model: Model<"openai-completions">) => Promise<unknown> }) {
			await options.onPayload?.({ model: model.id, messages: [], max_tokens: 20 }, model);
			dispatched++;
			await new Promise((resolve) => setTimeout(resolve, 20));
		},
	} as unknown as ModelRuntime;
	const budget = new DeepSeekCampaignBudget({ ...LIMITS, maxCny: 1, maxProviderCallsPerPrompt: 1 });
	const runner = new PiSessionRunner({ modelRuntime: runtime, createSession: offlineFactory(1), campaignBudget: budget });
	const left = await runner.create(spec(path.join(dir, "left"), "left"));
	const right = await runner.create(spec(path.join(dir, "right"), "right"));
	t.after(() => { left.dispose(); right.dispose(); });
	const [a, b] = await Promise.all([left.prompt("A"), right.prompt("B")]);
	assert.equal(a.text, "round 1");
	assert.equal(b.text, "round 1");
	assert.equal(dispatched, 2);
	assert.equal(budget.snapshot().reservations, 2);
	assert.equal(budget.snapshot().stopped, false);
});

test("concurrent Pi handles cannot cross a single-call total limit", async (t) => {
	const dir = await mkdtemp(path.join(tmpdir(), "deepseek-parallel-cap-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	let dispatched = 0;
	const runtime = {
		getModels: () => [MODEL],
		async streamSimple(model: Model<"openai-completions">, _context: unknown, options: { onPayload?: (payload: unknown, model: Model<"openai-completions">) => Promise<unknown> }) {
			await options.onPayload?.({ model: model.id, messages: [], max_tokens: 20 }, model);
			dispatched++;
			await new Promise((resolve) => setTimeout(resolve, 20));
		},
	} as unknown as ModelRuntime;
	const budget = new DeepSeekCampaignBudget({ ...LIMITS, maxCny: 1, maxProviderCalls: 1, maxProviderCallsPerPrompt: 1 });
	const runner = new PiSessionRunner({ modelRuntime: runtime, createSession: offlineFactory(1), campaignBudget: budget });
	const left = await runner.create(spec(path.join(dir, "left"), "left"));
	const right = await runner.create(spec(path.join(dir, "right"), "right"));
	t.after(() => { left.dispose(); right.dispose(); });
	const outcomes = await Promise.allSettled([left.prompt("A"), right.prompt("B")]);
	assert.equal(dispatched, 1);
	assert.equal(budget.snapshot().reservations, 1);
	assert.equal(budget.snapshot().stopReason, "provider-call-limit");
	assert(outcomes.some((item) => item.status === "rejected"));
});

test("duplicate lease or request ownership fails closed without granting an unmetered retry", () => {
	const budget = new DeepSeekCampaignBudget(LIMITS);
	const lease = budget.beginPrompt("branch", "1");
	budget.reserve(lease, 100, "request-1");
	assert.throws(() => budget.reserve(lease, 100, "request-1"), /already reserved/);
	assert.equal(budget.snapshot().reservations, 1);
	assert.equal(budget.snapshot().stopReason, "payload-boundary");
	budget.failPrompt(lease);
	assert.equal(budget.snapshot().stopReason, "payload-boundary", "first campaign stop reason must remain stable");
	const second = new DeepSeekCampaignBudget(LIMITS);
	second.beginPrompt("branch", "1");
	assert.throws(() => second.beginPrompt("branch", "2"), /ownership is duplicated/);
	assert.equal(second.snapshot().stopReason, "prompt-failure");
	const third = new DeepSeekCampaignBudget(LIMITS);
	const done = third.beginPrompt("branch", "1");
	third.reserve(done, 100, "request-1");
	third.finishPrompt(done, [{ requestId: "request-1", event: reported("entry-1") }]);
	assert.throws(() => third.beginPrompt("branch", "1"), /ownership is duplicated/);
});

test("a stale prompt lease cannot reserve into a later prompt on the same session", () => {
	const budget = new DeepSeekCampaignBudget(LIMITS);
	const first = budget.beginPrompt("session", "1");
	budget.reserve(first, 100, "request-1");
	budget.finishPrompt(first, [{ requestId: "request-1", event: reported("entry-1") }]);
	const next = budget.beginPrompt("session", "2");
	assert.throws(() => budget.reserve(first, 100, "late-request"), /payload byte count is unavailable/);
	assert.equal(budget.snapshot().reservations, 1);
	assert.equal(budget.snapshot().activePrompts, 1);
	assert.throws(() => budget.reserve(next, 100, "new-request"), /payload byte count is unavailable/);
});

test("failed branch retains reserve and stops other active branch without changing first reason", () => {
	const budget = new DeepSeekCampaignBudget(LIMITS);
	const left = budget.beginPrompt("left", "1");
	const right = budget.beginPrompt("right", "1");
	budget.reserve(left, 100, "left-1");
	budget.reserve(right, 100, "right-1");
	const held = budget.snapshot().reservedCny;
	budget.failPrompt(left);
	assert.equal(budget.snapshot().stopReason, "prompt-failure");
	assert.throws(() => budget.reserve(right, 100, "right-2"), /payload byte count is unavailable/);
	assert.equal(budget.snapshot().reservedCny, held);
	budget.finishPrompt(right, [{ requestId: "right-1", event: reported("right-entry") }]);
	assert.equal(budget.snapshot().stopReason, "prompt-failure");
	assert.equal(budget.snapshot().activePrompts, 0);
});

test("interleaved branches obey independent per-prompt caps and one atomic CNY ceiling", () => {
	const cap = (100 * LIMITS.estimatedInputCnyPerMillionTokens +
		(LIMITS.maxOutputTokens + LIMITS.outputAccountingMarginTokens) * LIMITS.estimatedOutputCnyPerMillionTokens) / 1_000_000;
	const budget = new DeepSeekCampaignBudget({ ...LIMITS, maxCny: cap * 2, maxProviderCalls: 4, maxProviderCallsPerPrompt: 2 });
	const left = budget.beginPrompt("left", "1");
	const right = budget.beginPrompt("right", "1");
	budget.reserve(left, 100, "left-1");
	budget.reserve(right, 100, "right-1");
	assert.throws(() => budget.reserve(left, 100, "left-2"), /campaign global CNY total exhausted/);
	assert.equal(budget.snapshot().reservations, 2, "third concurrent reservation must not pass total money ceiling");
	assert.equal(budget.snapshot().reservedCny, cap * 2);
	const promptCap = new DeepSeekCampaignBudget({ ...LIMITS, maxCny: 1, maxProviderCalls: 4, maxProviderCallsPerPrompt: 1 });
	const a = promptCap.beginPrompt("a", "1");
	const b = promptCap.beginPrompt("b", "1");
	promptCap.reserve(a, 100, "a-1");
	promptCap.reserve(b, 100, "b-1");
	assert.throws(() => promptCap.reserve(a, 100, "a-2"), /campaign provider call limit exhausted/);
	assert.equal(promptCap.snapshot().reservations, 2, "one branch may not borrow the other prompt's calls");
});

test("usage receipts cannot be charged to another branch or replayed as fork ancestry", () => {
	const budget = new DeepSeekCampaignBudget(LIMITS);
	const left = budget.beginPrompt("left", "1");
	const right = budget.beginPrompt("right", "1");
	budget.reserve(left, 100, "left-request");
	budget.reserve(right, 100, "right-request");
	assert.throws(() => budget.finishPrompt(left, [{ requestId: "right-request", event: reported("left-entry") }]), /provider usage or call outcome/);
	assert.equal(budget.snapshot().reservations, 2);
	assert.equal(budget.snapshot().stopReason, "usage-reconciliation");
	budget.finishPrompt(right, [{ requestId: "right-request", event: reported("right-entry") }]);
	const replay = new DeepSeekCampaignBudget(LIMITS);
	const ancestor = replay.beginPrompt("ancestor", "1");
	replay.reserve(ancestor, 100, "ancestor-request");
	replay.finishPrompt(ancestor, [{ requestId: "ancestor-request", event: reported("shared-entry") }]);
	const child = replay.beginPrompt("child", "1");
	replay.reserve(child, 100, "child-request");
	assert.throws(() => replay.finishPrompt(child, [{ requestId: "child-request", event: reported("shared-entry") }]), /provider usage or call outcome/);
	assert.equal(replay.snapshot().reservations, 2, "copied history does not create a reservation");
});

test("known provider usage settles one request conservatively before the next reservation", () => {
	const oneWorst = (100 * LIMITS.estimatedInputCnyPerMillionTokens +
		(LIMITS.maxOutputTokens + LIMITS.outputAccountingMarginTokens) * LIMITS.estimatedOutputCnyPerMillionTokens) / 1_000_000;
	const oneKnown = (10 * LIMITS.estimatedInputCnyPerMillionTokens + 4 * LIMITS.estimatedOutputCnyPerMillionTokens) / 1_000_000;
	const budget = new DeepSeekCampaignBudget({ ...LIMITS, maxCny: oneWorst + oneKnown + 0.000001 });
	const lease = budget.beginPrompt("session", "1");
	budget.reserve(lease, 100, "request-1");
	budget.settleReported(lease, "request-1", reported("stream-1", 1, 10, "toolUse"));
	const afterFirst = budget.snapshot();
	assert.equal(afterFirst.grossReservedCny, oneWorst);
	assert.equal(afterFirst.settledCny, oneKnown);
	assert.equal(afterFirst.committedCny, oneKnown);
	assert.equal(afterFirst.unknownReservedCny, 0);
	budget.reserve(lease, 100, "request-2");
	assert.equal(budget.snapshot().reservations, 2);
	assert(budget.snapshot().committedCny <= budget.limits.maxCny);
	budget.settleReported(lease, "request-2", reported("stream-2"));
	budget.finishPrompt(lease, [
		{ requestId: "request-1", event: reported("persisted-1", 1, 10, "toolUse") },
		{ requestId: "request-2", event: reported("persisted-2") },
	]);
	assert.equal(budget.snapshot().inFlightReservedCny, 0);
	assert.equal(budget.snapshot().committedCny, oneKnown * 2);
	assert.equal(budget.snapshot().stopped, false);
});

test("terminal stream usage is settled before the next tool-loop onPayload", async (t) => {
	const dir = await mkdtemp(path.join(tmpdir(), "deepseek-stream-settlement-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const payload = { model: MODEL.id, messages: [], max_tokens: LIMITS.maxOutputTokens };
	const bytes = Buffer.byteLength(JSON.stringify(payload), "utf8");
	const worst = (bytes * LIMITS.estimatedInputCnyPerMillionTokens +
		(LIMITS.maxOutputTokens + LIMITS.outputAccountingMarginTokens) * LIMITS.estimatedOutputCnyPerMillionTokens) / 1_000_000;
	const known = (10 * LIMITS.estimatedInputCnyPerMillionTokens + 4 * LIMITS.estimatedOutputCnyPerMillionTokens) / 1_000_000;
	const budget = new DeepSeekCampaignBudget({ ...LIMITS, maxCny: worst + known + 0.000001 });
	let called = 0;
	let settledAtSecondPayload = false;
	const runtime = {
		getModels: () => [MODEL],
		streamSimple(model: Model<"openai-completions">, _context: unknown, options: { onPayload?: (payload: unknown, model: Model<"openai-completions">) => Promise<unknown> }) {
			const stream = createAssistantMessageEventStream();
			void (async () => {
				await options.onPayload?.(payload, model);
				called++;
				if (called === 2) settledAtSecondPayload = budget.snapshot().settledCny > 0 && budget.snapshot().reservations === 2;
				const stopReason = called === 1 ? "toolUse" as const : "stop" as const;
				const assistant = { role: "assistant" as const, api: model.api, provider: model.provider, model: model.id,
					content: [{ type: "text" as const, text: `round ${called}` }], stopReason, timestamp: Date.now(),
					usage: { input: 10, output: 4, cacheRead: 0, cacheWrite: 0, totalTokens: 14,
						cost: { input: 0.000003, output: 0.0000048, cacheRead: 0, cacheWrite: 0, total: 0.0000078 } } };
				stream.push({ type: "start", partial: assistant });
				stream.push({ type: "done", reason: stopReason, message: assistant });
				stream.end();
			})().catch((error) => { throw error; });
			return stream;
		},
	} as unknown as ModelRuntime;
	const runner = new PiSessionRunner({ modelRuntime: runtime, createSession: streamFactory(2), campaignBudget: budget });
	const handle = await runner.create(spec(dir, "stream-settlement"));
	t.after(() => handle.dispose());
	assert.equal((await handle.prompt("two tool-loop calls")).text, "round 2");
	assert.equal(called, 2);
	assert.equal(settledAtSecondPayload, true);
	assert.equal(budget.snapshot().reservations, 2);
	assert.equal(budget.snapshot().committedCny, known * 2);
	assert.equal(budget.snapshot().stopped, false);
});

test("a known length terminal response settles its charge while the prompt fails", async (t) => {
	const dir = await mkdtemp(path.join(tmpdir(), "deepseek-length-settlement-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const budget = new DeepSeekCampaignBudget({ ...LIMITS, maxCny: 1, maxProviderCalls: 2 });
	let lateRequestDenied = false;
	let lateProbe: Promise<void> | undefined;
	const runtime = {
		getModels: () => [MODEL],
		streamSimple(model: Model<"openai-completions">, _context: unknown, options: { onPayload?: (payload: unknown, model: Model<"openai-completions">) => Promise<unknown> }) {
			const stream = createAssistantMessageEventStream();
			void (async () => {
				await options.onPayload?.({ model: model.id, messages: [], max_tokens: 20 }, model);
				const assistant = { role: "assistant" as const, api: model.api, provider: model.provider, model: model.id,
					content: [{ type: "text" as const, text: "truncated" }], stopReason: "length" as const, timestamp: Date.now(),
					usage: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 30,
						cost: { input: 0.000003, output: 0.000024, cacheRead: 0, cacheWrite: 0, total: 0.000027 } } };
				stream.push({ type: "start", partial: assistant });
				stream.push({ type: "done", reason: "length", message: assistant });
				stream.end();
				lateProbe = new Promise<void>((resolve) => setImmediate(resolve)).then(async () => {
					try { await options.onPayload?.({ model: model.id, messages: [{ role: "user", content: "illicit continuation" }], max_tokens: 20 }, model); }
					catch (error) { lateRequestDenied = /campaign|provider|payload/i.test(String(error)); }
				});
			})().catch((error) => { throw error; });
			return stream;
		},
	} as unknown as ModelRuntime;
	const runner = new PiSessionRunner({ modelRuntime: runtime, createSession: streamFactory(1), campaignBudget: budget });
	const handle = await runner.create(spec(dir, "length-response"));
	t.after(() => handle.dispose());
	let truncated: unknown;
	try { await handle.prompt("known but incomplete"); } catch (error) { truncated = error; }
	assert.equal(isSettledTerminalResponse(truncated), true);
	assert.deepEqual(settledTerminalResponseDetails(truncated), {
		settledProviderRequestCount: 1, responseReceived: true, terminalStopReason: "length", taskComplete: false,
		effectScope: "no-tools",
	});
	assert.equal(isSettledTerminalResponse(new Error(String(truncated))), false);
	await lateProbe;
	assert.equal(lateRequestDenied, true, "post-length tool-loop onPayload must fail before transport");
	assert.equal(budget.snapshot().reservations, 1);
	assert.equal(budget.snapshot().settledCny, (10 * LIMITS.estimatedInputCnyPerMillionTokens + 20 * LIMITS.estimatedOutputCnyPerMillionTokens) / 1_000_000);
	assert.equal(budget.snapshot().unknownReservedCny, 0);
	assert.equal(budget.snapshot().stopReason, "prompt-failure");
});

test("length response cannot certify a whole prompt with an earlier unsettled request", () => {
	const budget = new DeepSeekCampaignBudget({ ...LIMITS, maxCny: 1 });
	const lease = budget.beginPrompt("synthetic", "incomplete-earlier-call");
	budget.reserve(lease, 100, "unsettled");
	budget.reserve(lease, 100, "length");
	budget.stopAfterTerminalLength(lease, "length", reported("length-receipt", 1, 10, "length"));
	assert.equal(budget.certifySettledTerminalResponse(lease, "no-tools"), undefined);
	budget.failPrompt(lease);
	assert(budget.snapshot().unknownReservedCny > 0);
});

test("provider stream error stops a later tool-loop request before transport", async (t) => {
	const dir = await mkdtemp(path.join(tmpdir(), "deepseek-stream-error-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const budget = new DeepSeekCampaignBudget({ ...LIMITS, maxCny: 1, maxProviderCalls: 2 });
	let lateRequestDenied = false;
	let lateProbe: Promise<void> | undefined;
	const runtime = {
		getModels: () => [MODEL],
		streamSimple(model: Model<"openai-completions">, _context: unknown, options: { onPayload?: (payload: unknown, model: Model<"openai-completions">) => Promise<unknown> }) {
			const stream = createAssistantMessageEventStream();
			void (async () => {
				await options.onPayload?.({ model: model.id, messages: [], max_tokens: 20 }, model);
				const assistant = { role: "assistant" as const, api: model.api, provider: model.provider, model: model.id,
					content: [], stopReason: "error" as const, errorMessage: "synthetic unknown outcome", timestamp: Date.now(),
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
				stream.push({ type: "error", reason: "error", error: assistant });
				stream.end();
				lateProbe = new Promise<void>((resolve) => setImmediate(resolve)).then(async () => {
					try { await options.onPayload?.({ model: model.id, messages: [{ role: "user", content: "illicit continuation" }], max_tokens: 20 }, model); }
					catch (error) { lateRequestDenied = /campaign|provider|payload/i.test(String(error)); }
				});
			})().catch((error) => { throw error; });
			return stream;
		},
	} as unknown as ModelRuntime;
	const runner = new PiSessionRunner({ modelRuntime: runtime, createSession: streamFactory(1), campaignBudget: budget });
	const handle = await runner.create(spec(dir, "unknown-response"));
	t.after(() => handle.dispose());
	await assert.rejects(handle.prompt("unknown outcome"), /synthetic unknown outcome/);
	await lateProbe;
	assert.equal(lateRequestDenied, true);
	assert.equal(budget.snapshot().reservations, 1);
	assert(budget.snapshot().unknownReservedCny > 0);
	assert.equal(budget.snapshot().settledCny, 0);
});

test("unknown responses retain full worst reserve while known length usage can settle on failure", () => {
	const budget = new DeepSeekCampaignBudget({ ...LIMITS, maxCny: 1 });
	const lease = budget.beginPrompt("session", "1");
	budget.reserve(lease, 100, "known-length");
	budget.reserve(lease, 100, "unknown");
	const worst = budget.snapshot().grossReservedCny / 2;
	budget.settleReported(lease, "known-length", reported("length", 1, 10, "length"));
	budget.failPrompt(lease);
	assert.equal(budget.snapshot().settledCny, (10 * LIMITS.estimatedInputCnyPerMillionTokens + 4 * LIMITS.estimatedOutputCnyPerMillionTokens) / 1_000_000);
	assert.equal(budget.snapshot().unknownReservedCny, worst);
	assert.equal(budget.snapshot().inFlightReservedCny, 0);
	assert.equal(budget.snapshot().stopReason, "prompt-failure");
	assert.equal(budget.snapshot().committedCny, budget.snapshot().settledCny + worst);
});

test("partial or synthetic zero usage never frees reserve; repeated settlement is idempotent", () => {
	const partial = new DeepSeekCampaignBudget(LIMITS);
	const p = partial.beginPrompt("p", "1");
	partial.reserve(p, 100, "p-1");
	const worst = partial.snapshot().committedCny;
	assert.throws(() => partial.settleReported(p, "p-1", { ...reported("p-event"),
		usage: { input: 10, output: 4, cacheRead: 0, cacheWrite: 0, cost: 0.0000078 } }), /provider usage or call outcome/);
	assert.equal(partial.snapshot().unknownReservedCny, worst);
	assert.equal(partial.snapshot().committedCny, worst);
	const zero = new DeepSeekCampaignBudget(LIMITS);
	const z = zero.beginPrompt("z", "1");
	zero.reserve(z, 100, "z-1");
	assert.throws(() => zero.settleReported(z, "z-1", reported("zero", 1, 0)), /provider usage or call outcome/);
	assert.equal(zero.snapshot().unknownReservedCny, zero.snapshot().grossReservedCny);
	const duplicate = new DeepSeekCampaignBudget(LIMITS);
	const d = duplicate.beginPrompt("d", "1");
	duplicate.reserve(d, 100, "d-1");
	const response = reported("response");
	duplicate.settleReported(d, "d-1", response);
	const settled = duplicate.snapshot().settledCny;
	duplicate.settleReported(d, "d-1", { ...response, entryId: "same-result-different-entry" });
	assert.equal(duplicate.snapshot().settledCny, settled);
	assert.throws(() => duplicate.settleReported(d, "d-1", reported("conflict", 1, 11)), /conflicts/);
	assert.equal(duplicate.snapshot().settledCny, 0);
	assert.equal(duplicate.snapshot().unknownReservedCny, duplicate.snapshot().grossReservedCny);
	assert.equal(duplicate.snapshot().stopReason, "usage-reconciliation");
});

test("reported disjoint cache hits settle at a verified cache-read ceiling while the pre-request reserve stays all-miss", () => {
	const payloadBytes = 1_200;
	const usage = { input: 10, cacheRead: 1_000, cacheWrite: 5, output: 4, totalTokens: 1_019, cost: 0.00002 };
	const event = { ...reported("cached"), usage };
	const cacheBudget = new DeepSeekCampaignBudget({ ...LIMITS, maxCny: 1, estimatedCacheReadCnyPerMillionTokens: 0.2 });
	cacheBudget.assertResolved(MODEL);
	const lease = cacheBudget.beginPrompt("cache", "1");
	cacheBudget.reserve(lease, payloadBytes, "cached-request");
	const worst = (payloadBytes * LIMITS.estimatedInputCnyPerMillionTokens +
		(LIMITS.maxOutputTokens + LIMITS.outputAccountingMarginTokens) * LIMITS.estimatedOutputCnyPerMillionTokens) / 1_000_000;
	assert.equal(cacheBudget.snapshot().committedCny, worst, "reservation assumes every input byte costs the uncached rate");
	cacheBudget.settleReported(lease, "cached-request", event);
	const expected = ((usage.input + usage.cacheWrite) * LIMITS.estimatedInputCnyPerMillionTokens +
		usage.cacheRead * 0.2 + usage.output * LIMITS.estimatedOutputCnyPerMillionTokens) / 1_000_000;
	assert.equal(cacheBudget.snapshot().settledCny, expected);
	assert.equal(cacheBudget.snapshot().grossReservedCny, worst);
	const defaultBudget = new DeepSeekCampaignBudget({ ...LIMITS, maxCny: 1 });
	const defaultLease = defaultBudget.beginPrompt("default", "1");
	defaultBudget.reserve(defaultLease, payloadBytes, "default-request");
	defaultBudget.settleReported(defaultLease, "default-request", event);
	assert.equal(defaultBudget.snapshot().settledCny,
		((usage.input + usage.cacheRead + usage.cacheWrite) * LIMITS.estimatedInputCnyPerMillionTokens +
			usage.output * LIMITS.estimatedOutputCnyPerMillionTokens) / 1_000_000,
		"omitting the optional cache ceiling retains old all-input settlement behavior");
});

test("invalid cache estimates fail, while higher model prices raise total-cost planning", () => {
	for (const cacheLimit of [0, -1]) {
		assert.throws(() => new DeepSeekCampaignBudget({ ...LIMITS, estimatedCacheReadCnyPerMillionTokens: cacheLimit }), /invalid DeepSeek campaign limits/);
	}
	const budget = new DeepSeekCampaignBudget({ ...LIMITS, estimatedCacheReadCnyPerMillionTokens: 0.2 });
	budget.assertResolved({ ...MODEL, cost: { ...MODEL.cost, cacheRead: 0.5 } });
	const lease = budget.beginPrompt("higher-price", "1");
	budget.reserve(lease, 100, "higher-price-request");
	assert.equal(budget.snapshot().grossReservedCny, (100 * 5 + (20 + 32) * 16) / 1_000_000);
	const lowerEstimate = new DeepSeekCampaignBudget({ ...LIMITS, estimatedCacheReadCnyPerMillionTokens: 0.05 });
	lowerEstimate.assertResolved(MODEL);
});

test("one mission total carries prior conservative commitments across fresh attempts", () => {
	const cap = (100 * LIMITS.estimatedInputCnyPerMillionTokens +
		(LIMITS.maxOutputTokens + LIMITS.outputAccountingMarginTokens) * LIMITS.estimatedOutputCnyPerMillionTokens) / 1_000_000;
	const prior = 20.25; // synthetic offline carry; the driver verifies the real ledger separately
	for (const invalid of [NaN, Infinity, -1]) {
		assert.throws(() => new DeepSeekCampaignBudget({ ...LIMITS, maxCny: 30, priorCommittedCny: invalid }), /invalid DeepSeek campaign limits/);
	}
	const budget = new DeepSeekCampaignBudget({ ...LIMITS, maxCny: prior + cap * 2 - cap / 10, priorCommittedCny: prior });
	const first = budget.beginPrompt("first-role", "1");
	budget.reserve(first, 100, "attempt-1");
	assert.equal(budget.snapshot().priorCommittedCny, prior);
	assert.equal(budget.snapshot().currentCommittedCny, cap);
	assert.equal(budget.snapshot().missionCommittedCny, prior + cap);
	assert.equal(budget.snapshot().settledCny, 0, "historical uncertainty is not mislabeled as settled usage");
	const second = budget.beginPrompt("child-role", "1");
	assert.throws(() => budget.reserve(second, 100, "attempt-2"), /global CNY total exhausted/);
	assert.equal(budget.snapshot().stopReason, "total-cny-ceiling");
	const over = new DeepSeekCampaignBudget({ ...LIMITS, maxCny: 30, priorCommittedCny: 31 });
	assert.equal(over.snapshot().missionCommittedCny, 31, "an over-cap historical ledger remains readable");
	assert.throws(() => over.reserve(over.beginPrompt("over", "1"), 100, "over-1"), /global CNY total exhausted/);
});

test("higher SDK tariff rates raise planning without creating another fee ceiling", () => {
	const budget = new DeepSeekCampaignBudget({ ...LIMITS, maxCny: 1, maxProviderCalls: 3 });
	budget.assertResolved({ ...MODEL, cost: { ...MODEL.cost, input: 1, output: 4 } });
	const first = budget.beginPrompt("builder", "1");
	budget.reserve(first, 100, "higher-priced-request");
	assert.equal(budget.snapshot().grossReservedCny, (100 * 10 + (20 + 32) * 40) / 1_000_000);
	budget.finishPrompt(first, [{ requestId: "higher-priced-request", event: { ...reported("higher-priced"), usage: { ...reported("higher-priced").usage, cost: 0.000026 } } }]);
	assert.equal(budget.snapshot().settledCny, (10 * 10 + 4 * 40) / 1_000_000);
	assert.equal(budget.snapshot().stopped, false);
	const second = budget.beginPrompt("reviewer", "1");
	budget.reserve(second, 100, "next-request");
	assert.equal(budget.snapshot().reservations, 2);
});

test("an in-flight request settles with its own frozen tariff estimate", () => {
	const budget = new DeepSeekCampaignBudget({ ...LIMITS, maxCny: 1, maxProviderCalls: 3 });
	budget.assertResolved(MODEL);
	const first = budget.beginPrompt("first", "1");
	budget.reserve(first, 100, "before-price-update");
	budget.assertResolved({ ...MODEL, cost: { ...MODEL.cost, input: 100, output: 100 } });
	budget.finishPrompt(first, [{ requestId: "before-price-update", event: reported("old-price") }]);
	assert.equal(budget.snapshot().settledCny, (10 * 4 + 4 * 16) / 1_000_000);
	assert.equal(budget.snapshot().stopped, false);
	const second = budget.beginPrompt("second", "1");
	budget.reserve(second, 100, "after-price-update");
	assert.equal(budget.snapshot().grossReservedCny,
		(100 * 4 + 52 * 16) / 1_000_000 + (100 * 1_000 + 52 * 1_000) / 1_000_000);
});

test("a reported estimate contradicting the pre-HTTP plan is retained as unknown and halts further spend", () => {
	const budget = new DeepSeekCampaignBudget({ ...LIMITS, maxCny: 1 });
	const lease = budget.beginPrompt("builder", "1");
	budget.reserve(lease, 100, "unexpected-price");
	budget.finishPrompt(lease, [{ requestId: "unexpected-price", event: { ...reported("unexpected-price"), usage: { ...reported("unexpected-price").usage, cost: 0.01 } } }]);
	assert.equal(budget.snapshot().settledCny, 0, "an invalidated price assumption must not masquerade as known settlement");
	assert.equal(budget.snapshot().unknownReservedCny, 0.1);
	assert.equal(budget.snapshot().stopReason, "price-assumption-invalid");
	assert.throws(() => budget.beginPrompt("reviewer", "1"), /campaign is stopped/);
	const exceeded = new DeepSeekCampaignBudget({ ...LIMITS, maxCny: 0.01 });
	const overLease = exceeded.beginPrompt("builder", "1");
	exceeded.reserve(overLease, 100, "exceeded-price");
	exceeded.finishPrompt(overLease, [{ requestId: "exceeded-price", event: { ...reported("exceeded-price"), usage: { ...reported("exceeded-price").usage, cost: 0.1 } } }]);
	assert.equal(exceeded.snapshot().stopReason, "total-cny-ceiling");
	assert.equal(exceeded.snapshot().unknownReservedCny, 1);
	assert(exceeded.snapshot().missionCommittedCny > 0.01);
});

test("inconsistent tokens do not erase a higher observed SDK estimate", () => {
	const budget = new DeepSeekCampaignBudget({ ...LIMITS, maxCny: 1 });
	const lease = budget.beginPrompt("builder", "1");
	budget.reserve(lease, 100, "bad-token-report");
	assert.throws(() => budget.settleReported(lease, "bad-token-report", {
		...reported("bad-token-report"),
		usage: { input: 10, output: 4, cacheRead: 0, cacheWrite: 0, totalTokens: 999, cost: 0.01 },
	}), /provider usage or call outcome is inconsistent/);
	assert.equal(budget.snapshot().unknownReservedCny, 0.1);
	assert.equal(budget.snapshot().settledCny, 0);
	assert.equal(budget.snapshot().stopReason, "usage-reconciliation");
});

test("missing priced cost remains unknown without a false settlement or extra fee gate", () => {
	const budget = new DeepSeekCampaignBudget({ ...LIMITS, maxCny: 1 });
	const lease = budget.beginPrompt("builder", "1");
	budget.reserve(lease, 100, "unpriced-request");
	const held = budget.snapshot().currentCommittedCny;
	const event = { ...reported("unpriced"), status: "unknown" as const, costStatus: "unknown" as const,
		usage: { input: 10, output: 4, cacheRead: 0, cacheWrite: 0, totalTokens: 14 } };
	budget.finishPrompt(lease, [{ requestId: "unpriced-request", event }]);
	assert.equal(budget.snapshot().settledCny, 0);
	assert.equal(budget.snapshot().unknownReservedCny, held);
	assert.equal(budget.snapshot().stopped, false);
	const next = budget.beginPrompt("reviewer", "1");
	budget.reserve(next, 100, "after-unpriced");
	assert.equal(budget.snapshot().reservations, 2);
});

test("missing or overlapping cache usage remains at the full worst-case reserve", () => {
	for (const usage of [
		{ input: 10, cacheWrite: 5, output: 4, totalTokens: 19, cost: 0.00001 },
		{ input: 10, cacheRead: 1_000, cacheWrite: 5, output: 4, totalTokens: 19, cost: 0.00001 },
	]) {
		const budget = new DeepSeekCampaignBudget({ ...LIMITS, maxCny: 1, estimatedCacheReadCnyPerMillionTokens: 0.2 });
		const lease = budget.beginPrompt("partial-cache", "1");
		budget.reserve(lease, 1_200, "request");
		const held = budget.snapshot().committedCny;
		assert.throws(() => budget.settleReported(lease, "request", { ...reported("partial-cache"), usage }), /provider usage or call outcome/);
		assert.equal(budget.snapshot().settledCny, 0);
		assert.equal(budget.snapshot().unknownReservedCny, held);
		assert.equal(budget.snapshot().committedCny, held);
	}
});

test("late and cross-lease usage cannot settle someone else's reserve", () => {
	const budget = new DeepSeekCampaignBudget(LIMITS);
	const left = budget.beginPrompt("left", "1");
	const right = budget.beginPrompt("right", "1");
	budget.reserve(left, 100, "left-request");
	budget.reserve(right, 100, "right-request");
	assert.throws(() => budget.settleReported(right, "left-request", reported("cross")), /no active reserved request/);
	assert.equal(budget.snapshot().settledCny, 0);
	assert.equal(budget.snapshot().stopReason, "usage-reconciliation");
	budget.failPrompt(left);
	assert.throws(() => budget.settleReported(left, "left-request", reported("late")), /no active reserved request/);
	assert.equal(budget.snapshot().unknownReservedCny, budget.snapshot().grossReservedCny / 2);
});

test("duplicate finish cannot settle or bill the same provider response twice", () => {
	const budget = new DeepSeekCampaignBudget(LIMITS);
	const lease = budget.beginPrompt("session", "1");
	budget.reserve(lease, 100, "request-1");
	const receipts = [{ requestId: "request-1", event: reported("entry-1") }];
	budget.finishPrompt(lease, receipts);
	const committed = budget.snapshot().committedCny;
	assert.throws(() => budget.finishPrompt(lease, receipts), /invalid or already finished/);
	assert.equal(budget.snapshot().committedCny, committed);
	assert.equal(budget.snapshot().settledCny, committed);
	assert.equal(budget.snapshot().stopReason, "usage-reconciliation");
});

test("dispose and resume can continue the same session with a fresh prompt lease", async (t) => {
	const dir = await mkdtemp(path.join(tmpdir(), "deepseek-resume-lease-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const budget = new DeepSeekCampaignBudget({ ...LIMITS, maxCny: 1, maxProviderCallsPerPrompt: 1 });
	const sent = { count: 0, options: [] as Array<{ maxTokens?: number; maxRetries?: number }> };
	const runner = new PiSessionRunner({ modelRuntime: offlineRuntime(sent), createSession: offlineFactory(1), campaignBudget: budget });
	const initial = await runner.create(spec(dir, "resume-lease"));
	await initial.prompt("first");
	const ref = initial.ref;
	initial.dispose();
	const resumed = await runner.resume(ref);
	t.after(() => resumed.dispose());
	await resumed.prompt("second");
	assert.equal(sent.count, 2);
	assert.equal(budget.snapshot().reservations, 2);
	assert.equal(budget.snapshot().activePrompts, 0);
	assert.equal(budget.snapshot().stopped, false);
});

test("real Pi tool request uses the synthetic runtime key at the fixed DeepSeek endpoint", async () => {
	const dir = await mkdtemp(path.join(tmpdir(), "deepseek-auth-transport-"));
	const originalFetch = globalThis.fetch;
	let unexpectedFetches = 0;
	globalThis.fetch = async () => { unexpectedFetches++; throw new Error("unexpected network path in offline auth test"); };
	let handle: Awaited<ReturnType<PiSessionRunner["create"]>> | undefined;
	try {
		const profile = path.join(dir, "profile"), work = path.join(dir, "work"), sessions = path.join(dir, "sessions");
		await Promise.all([mkdir(profile), mkdir(work), mkdir(sessions)]);
		const modelsPath = path.join(profile, "models.json");
		await writeFile(modelsPath, JSON.stringify({ providers: { deepseek: { models: [{ ...MODEL,
			compat: { supportsStore: false, supportsDeveloperRole: false, maxTokensField: "max_tokens", thinkingFormat: "deepseek" },
		}] } } }));
		const runtime = await ModelRuntime.create({ modelsPath, authPath: path.join(profile, "auth.json"),
			modelsStorePath: path.join(profile, "models-store.json"), allowModelNetwork: false, refreshOnCreate: false });
		const syntheticKey = "sk-SYNTHETIC-OFFLINE-ONLY";
		await runtime.setRuntimeApiKey("deepseek", syntheticKey);
		const calls: Array<{ endpointMatches: boolean; authorizationMatches: boolean; hasTools: boolean }> = [];
		const sentCaps: number[] = [];
		let transportPayloadBytes: number | undefined;
		const fakeFetch: typeof fetch = async (input, init) => {
			const headers = new Headers(input instanceof Request ? input.headers : undefined);
			new Headers(init?.headers).forEach((value, name) => headers.set(name, value));
			const endpoint = input instanceof Request ? input.url : String(input);
			const payload = typeof init?.body === "string" ? JSON.parse(init.body) as { tools?: unknown[]; max_tokens?: number } : undefined;
			transportPayloadBytes = typeof init?.body === "string" ? Buffer.byteLength(init.body, "utf8") : undefined;
			sentCaps.push(payload?.max_tokens ?? 0);
			calls.push({ endpointMatches: endpoint === "https://api.deepseek.com/chat/completions",
				authorizationMatches: headers.get("authorization") === `Bearer ${syntheticKey}`,
				hasTools: Array.isArray(payload?.tools) && payload.tools.length === 3 });
			return new Response(JSON.stringify({ error: { message: "offline synthetic rejection", type: "invalid_request_error" } }),
				{ status: 401, headers: { "content-type": "application/json" } });
		};
		const originalStream = runtime.streamSimple.bind(runtime);
		runtime.streamSimple = ((model, context, options) => originalStream(model, context, { ...options, fetch: fakeFetch })) as typeof runtime.streamSimple;
		const budget = new DeepSeekCampaignBudget({ ...LIMITS, maxCny: 1, maxProviderCalls: 1,
			maxProviderCallsPerPrompt: 1, maxOutputTokens: 32 });
		const runner = new PiSessionRunner({ modelRuntime: runtime, campaignBudget: budget });
		const tools = await createConfinedCampaignFileTools(work, { writableFiles: ["candidate.cpp"] });
		handle = await runner.create(spec(sessions, "real-pi-auth", { kind: "custom", tools }));
		await assert.rejects(handle.prompt("Offline authentication check."));
		assert.deepEqual(calls, [{ endpointMatches: true, authorizationMatches: true, hasTools: true }]);
		assert.equal(unexpectedFetches, 0);
		assert.equal(budget.snapshot().reservations, 1);
		assert(transportPayloadBytes !== undefined && transportPayloadBytes > 0);
		const expectedReserve = (transportPayloadBytes * LIMITS.estimatedInputCnyPerMillionTokens +
			(32 + LIMITS.outputAccountingMarginTokens) * LIMITS.estimatedOutputCnyPerMillionTokens) / 1_000_000;
		assert.equal(budget.snapshot().reservedCny, expectedReserve, "onPayload must measure the HTTP body the pinned SDK actually sends");
		const fullBytes = transportPayloadBytes;
		assert.equal(sentCaps[0], 32);
		handle.dispose();
		const minCost = ((fullBytes - 1) * LIMITS.estimatedInputCnyPerMillionTokens +
			(1 + LIMITS.outputAccountingMarginTokens) * LIMITS.estimatedOutputCnyPerMillionTokens) / 1_000_000;
		const dynamic = new DeepSeekCampaignBudget({ ...LIMITS, maxCny: (minCost + expectedReserve) / 2,
			maxProviderCalls: 1, maxProviderCallsPerPrompt: 1, maxOutputTokens: 32 });
		handle = await new PiSessionRunner({ modelRuntime: runtime, campaignBudget: dynamic })
			.create(spec(sessions, "real-pi-adaptive", { kind: "custom", tools }));
		await assert.rejects(handle.prompt("Offline authentication check."));
		assert.equal(calls.length, 2);
		assert(sentCaps[1] >= 1 && sentCaps[1] < 32, "the real SDK transport must carry the reduced cap");
		assert.equal(dynamic.requestAuditSnapshot().requests[0].maxOutputTokens, sentCaps[1]);
		assert.equal(dynamic.requestAuditSnapshot().requests[0].inputPayloadBytes, transportPayloadBytes);
		assert(dynamic.snapshot().grossReservedCny <= dynamic.limits.maxCny);
	} finally {
		handle?.dispose();
		globalThis.fetch = originalFetch;
		await rm(dir, { recursive: true, force: true });
	}
});

test("retained per-request audit is immutable and leaves no negative in-flight epsilon", () => {
	const budget = new DeepSeekCampaignBudget({ ...LIMITS, maxCny: 30, maxProviderCalls: 6, maxProviderCallsPerPrompt: 6 });
	const lease = budget.beginPrompt("private-session", "private-prompt");
	for (const [index, bytes] of [101, 333, 777, 151, 272, 991].entries()) budget.reserve(lease, bytes, `audit-${index}`);
	for (const index of [3, 1, 5, 0, 4, 2]) budget.settleReported(lease, `audit-${index}`, reported(`receipt-${index}`));
	assert.equal(budget.snapshot().inFlightReservedCny, 0);
	const evidence = budget.requestAuditSnapshot();
	assert.equal(evidence.inFlightReservedCny, 0);
	assert.equal(evidence.requests.length, 6);
	assert.equal(evidence.settledCny, evidence.requests.reduce((sum, row) => sum + row.settledCny!, 0));
	assert.doesNotMatch(JSON.stringify(evidence), /private-session|private-prompt/);
	evidence.requests[0].reportedUsage!.input = 999;
	evidence.requests[0].settledCny = 99;
	assert.notEqual(budget.requestAuditSnapshot().requests[0].reportedUsage!.input, 999);
	assert.notEqual(budget.requestAuditSnapshot().requests[0].settledCny, 99);
});

test("conflicting late price reports only increase unknown holds and never erase the larger observation", () => {
	const budget = new DeepSeekCampaignBudget({ ...LIMITS, maxCny: 30 });
	const lease = budget.beginPrompt("session", "prompt");
	budget.reserve(lease, 100, "request");
	budget.settleReported(lease, "request", reported("first"));
	const higher = { ...reported("conflicting"), usage: { ...reported("conflicting").usage, cost: 3.5 } };
	assert.throws(() => budget.settleReported(lease, "request", higher), /conflicts/);
	assert.equal(budget.snapshot().settledCny, 0);
	assert.equal(budget.snapshot().unknownReservedCny, 35);
	const highest = { ...higher, usage: { ...higher.usage, cost: 4 } };
	assert.throws(() => budget.settleReported(lease, "request", highest), /conflicts/);
	assert.equal(budget.snapshot().unknownReservedCny, 40);
	budget.failPrompt(lease);
	assert.equal(budget.requestAuditSnapshot().requests[0].unknownHeldCny, 40);
});

test("campaign sends and reserves the affordable reduced output cap under the one total", async (t) => {
	const dir = await mkdtemp(path.join(tmpdir(), "deepseek-adaptive-cap-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const payload = { model: MODEL.id, messages: [{ role: "user", content: "offline" }], max_tokens: 20 };
	const minBytes = Buffer.byteLength(JSON.stringify({ ...payload, max_tokens: 1 }), "utf8");
	const fullBytes = Buffer.byteLength(JSON.stringify(payload), "utf8");
	const minCost = (minBytes * 4 + (1 + 32) * 16) / 1_000_000;
	const fullCost = (fullBytes * 4 + (20 + 32) * 16) / 1_000_000;
	const budget = new DeepSeekCampaignBudget({ ...LIMITS, maxCny: 30,
		priorCommittedCny: 30 - (minCost + fullCost) / 2 });
	let sentCap = 0;
	let sentBytes = 0;
	const runtime = {
		getModels: () => [MODEL],
		async streamSimple(model: Model<"openai-completions">, _context: unknown,
			options: { onPayload?: (payload: unknown, model: Model<"openai-completions">) => Promise<unknown> }) {
			const outgoing = await options.onPayload?.(payload, model) as typeof payload;
			sentCap = outgoing.max_tokens;
			sentBytes = Buffer.byteLength(JSON.stringify(outgoing), "utf8");
		},
	} as unknown as ModelRuntime;
	const handle = await new PiSessionRunner({ modelRuntime: runtime, createSession: offlineFactory(1),
		campaignBudget: budget }).create(spec(dir, "adaptive-cap"));
	t.after(() => handle.dispose());
	assert.equal((await handle.prompt("offline")).text, "round 1");
	assert(sentCap >= 4 && sentCap < 20);
	const audit = budget.requestAuditSnapshot().requests[0];
	assert.equal(audit.maxOutputTokens, sentCap);
	assert.equal(audit.inputPayloadBytes, sentBytes);
	assert.equal(audit.reservedCny, (sentBytes * 4 + (sentCap + 32) * 16) / 1_000_000);
	assert(budget.snapshot().missionCommittedCny <= 30);
	assert.equal(budget.snapshot().priorCommittedCny, 30 - (minCost + fullCost) / 2);
});

test("local rejection after a settled subrequest carries a host-certified partial-settled receipt", async (t) => {
	const dir = await mkdtemp(path.join(tmpdir(), "deepseek-local-stop-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const payload = { model: MODEL.id, messages: [], max_tokens: 20 };
	const bytes = Buffer.byteLength(JSON.stringify(payload), "utf8");
	const firstWorst = (bytes * 4 + (20 + 32) * 16) / 1_000_000;
	const budget = new DeepSeekCampaignBudget({ ...LIMITS, maxCny: firstWorst });
	let sent = 0;
	const runtime = {
		getModels: () => [MODEL],
		streamSimple(model: Model<"openai-completions">, _context: unknown,
			options: { onPayload?: (payload: unknown, model: Model<"openai-completions">) => Promise<unknown> }) {
			const stream = createAssistantMessageEventStream();
			void (async () => {
				try {
					await options.onPayload?.(payload, model);
					sent++;
					const assistant = { role: "assistant" as const, api: model.api, provider: model.provider, model: model.id,
						content: [{ type: "text" as const, text: "partial" }], stopReason: "toolUse" as const,
						timestamp: Date.now(), usage: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0,
							totalTokens: 30, cost: { input: 0.000003, output: 0.000024, cacheRead: 0,
								cacheWrite: 0, total: 0.000027 } } };
					stream.push({ type: "start", partial: assistant });
					stream.push({ type: "done", reason: "toolUse", message: assistant });
				} catch (error) {
					const failed = { role: "assistant" as const, api: model.api, provider: model.provider, model: model.id,
						content: [], stopReason: "error" as const, errorMessage: String(error), timestamp: Date.now(),
						usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
					stream.push({ type: "error", reason: "error", error: failed });
				} finally { stream.end(); }
			})();
			return stream;
		},
	} as unknown as ModelRuntime;
	const handle = await new PiSessionRunner({ modelRuntime: runtime, createSession: streamFactory(2),
		campaignBudget: budget }).create(spec(dir, "partial-settled"));
	t.after(() => handle.dispose());
	let failed: unknown;
	try { await handle.prompt("two calls"); } catch (error) { failed = error; }
	assert.equal(isSettledLocalCampaignBudgetStop(failed), true);
	assert.deepEqual(settledLocalCampaignBudgetStopDetails(failed), {
		settledProviderRequestCount: 1, rejectedBeforeTransport: true, stopReason: "total-cny-ceiling",
		effectScope: "no-tools",
	});
	assert.equal(sent, 1);
	assert.equal(budget.snapshot().reservations, 1);
	assert.equal(budget.snapshot().unknownReservedCny, 0);
	assert(budget.snapshot().settledCny > 0);
	assert.equal(isSettledLocalCampaignBudgetStop(new Error(String(failed))), false);
});

test("M07 persists a real runner's certified partial-settled disposition without inventing an unknown charge", async (t) => {
	const dir = await mkdtemp(path.join(tmpdir(), "m07-campaign-local-stop-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const ws = new Workspace(dir);
	await mkdir(path.dirname(ws.problemFile), { recursive: true });
	await writeFile(ws.problemFile, "Synthetic bounded problem\n");
	const store = createFileKnowledgeStore(ws.knowledgeDir);
	await store.init();
	const baseline = await ws.startRun("M04", [{ label: "problem", path: ws.problemFile }]);
	await ws.finishRun(baseline, "completed");
	const budget = new DeepSeekCampaignBudget({ ...LIMITS, maxCny: 0.25,
		maxProviderCalls: 2, maxProviderCallsPerPrompt: 2 });
	let issued = 0;
	let calls = 0;
	const runtime = {
		getModels: () => [MODEL],
		streamSimple(model: Model<"openai-completions">, _context: unknown,
			options: { onPayload?: (payload: unknown, model: Model<"openai-completions">) => Promise<unknown> }) {
			const stream = createAssistantMessageEventStream();
			void (async () => {
				try {
					calls++;
					const payload = { model: model.id,
						messages: [{ role: "user", content: calls === 1 ? "synthetic" : "x".repeat(100_000) }],
						max_tokens: LIMITS.maxOutputTokens };
					await options.onPayload?.(payload, model);
					issued++;
					const assistant = { role: "assistant" as const, api: model.api, provider: model.provider,
						model: model.id, content: [{ type: "text" as const, text: "partial" }],
						stopReason: "toolUse" as const, timestamp: Date.now(),
						usage: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 30,
							cost: { input: 0.000003, output: 0.000024, cacheRead: 0,
								cacheWrite: 0, total: 0.000027 } } };
					stream.push({ type: "start", partial: assistant });
					stream.push({ type: "done", reason: "toolUse", message: assistant });
				} catch (error) {
					const failed = { role: "assistant" as const, api: model.api, provider: model.provider,
						model: model.id, content: [], stopReason: "error" as const,
						errorMessage: String(error), timestamp: Date.now(),
						usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
					stream.push({ type: "error", reason: "error", error: failed });
				} finally { stream.end(); }
			})();
			return stream;
		},
	} as unknown as ModelRuntime;
	const actual = new PiSessionRunner({ modelRuntime: runtime, createSession: streamFactory(2), campaignBudget: budget });
	const runner: SessionRunner = {
		create: async (requested) => actual.create({ ...requested, tools: requested.tools.kind === "execution"
			? { kind: "custom", tools: await createConfinedCampaignFileTools(requested.tools.root,
				{ writableFiles: ["result.txt"] }) } : requested.tools }),
		resume: (ref) => actual.resume(ref),
		attestConfinedGrant: (handle) => actual.attestConfinedGrant(handle),
	};
	const controller = createM07Controller({ ws, store, runner, config: {
		roles: { execution: LIMITS.model, reviewer: LIMITS.model }, concurrency: 1, tools: {},
	} } as StageContext);
	const goal = await controller.begin({ goal: "Synthetic bounded candidate", problemRelation: "direct",
		constraints: ["keep the plan"], successCriteria: ["checked"], plan: "one candidate" });
	const task = await controller.delegate(goal.runId, { objective: "produce candidate", inputs: [],
		expectedOutputs: ["result.txt"], checks: ["checked"], mode: "execute",
		executionLoop: { maxRounds: 1, deadlineAt: new Date(Date.now() + 60_000).toISOString() } });
	assert.equal(task.status, "failed");
	const persisted = await controller.status(goal.runId);
	const operation = persisted.executionState?.operations.find((entry) => entry.taskId === task.taskId);
	assert.equal(operation?.status, "partial-settled");
	assert.equal(operation?.observationMethod, "host-local-admission-rejection");
	assert(operation?.evidencePath);
	const receipt = JSON.parse(await readFile(operation.evidencePath, "utf8"));
	assert.equal(receipt.settledProviderRequestCount, 1);
	assert.equal(receipt.rejectedBeforeTransport, true);
	assert.equal(receipt.stopReason, "total-cny-ceiling");
	assert.equal(receipt.effectScope, "factory-attested-confined-file-tools");
	assert.equal(issued, 1);
	assert.equal(budget.snapshot().settledCny > 0, true);
	assert.equal(budget.snapshot().unknownReservedCny, 0);
	assert.equal(budget.snapshot().reservations, 1);
});
