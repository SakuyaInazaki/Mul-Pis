import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createAgentSession, ModelRuntime, type CreateAgentSessionOptions } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, type Model } from "@earendil-works/pi-ai";
import { DeepSeekCampaignBudget, type DeepSeekCampaignLimits } from "../../src/runner/deepseek-campaign.ts";
import { verifyDeepSeekCnyBilling } from "../../src/runner/deepseek-cny-pricing.ts";
import { verifyDeepSeekProviderOutputLimit } from "../../src/runner/deepseek-provider-limits.ts";
import { createConfinedCampaignFileTools } from "../../src/runner/confined-campaign-files.ts";
import { PiSessionRunner } from "../../src/runner/pi.ts";
import { openBoundedSession } from "../../src/context/boundary.ts";
import type { SessionRunner, SessionSpec } from "../../src/runner/types.ts";
import type { StageRunRecord } from "../../src/types.ts";

const MODEL = {
	id: "deepseek-flash", name: "Offline DeepSeek", provider: "deepseek", api: "openai-completions",
	baseUrl: "https://api.deepseek.com", reasoning: true, input: ["text"],
	cost: { input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0 },
	contextWindow: 10000, maxTokens: 20,
} as Model<"openai-completions">;

const TEST_PROVIDER_OUTPUT_LIMIT = await verifyDeepSeekProviderOutputLimit({ apiKey: "synthetic-only",
	request: async () => new Response(JSON.stringify({ object: "list", data: [{ id: "deepseek-flash",
		object: "model", name: "DeepSeek-V4.1-Flash", max_output_tokens: 20,
		context_window: 10_000 }] }), { status: 200 }) });

const LIMITS = {
	model: "deepseek/deepseek-flash:low", endpoint: "https://api.deepseek.com",
	maxCny: 0.006, priorCommittedCny: 0, maxProviderCalls: 2, maxProviderCallsPerPrompt: 2,
	maxOutputTokens: 20, providerOutputLimit: TEST_PROVIDER_OUTPUT_LIMIT,
	outputAccountingMarginTokens: 32,
	estimatedInputCnyPerMillionTokens: 4, estimatedOutputCnyPerMillionTokens: 16, estimatedCnyPerUsd: 10,
} satisfies DeepSeekCampaignLimits;

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

test("retired call counts do not stop additional accounted provider requests", async (t) => {
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
	await reviewer.prompt("review");
	assert.equal(sent.count, 4);
	assert.equal(budget.snapshot().reservations, 4);
	assert.equal(budget.snapshot().stopped, false);
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

test("attested confined file grants may list more than sixteen files without weakening per-file checks", async t => {
	const dir = await mkdtemp(path.join(tmpdir(), "campaign-file-grant-count-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const work = path.join(dir, "work"), sessions = path.join(dir, "sessions");
	await Promise.all([mkdir(work), mkdir(sessions)]);
	const writableFiles = Array.from({ length: 17 }, (_, index) => `candidate-${index}.cpp`);
	const budget = new DeepSeekCampaignBudget({ ...LIMITS, maxCny: 1 });
	const sent = { count: 0, options: [] as Array<{ maxTokens?: number; maxRetries?: number }> };
	const actual = new PiSessionRunner({ modelRuntime: offlineRuntime(sent),
		createSession: offlineFactory(1), campaignBudget: budget });
	const wrapper: SessionRunner = { create: async requested => actual.create({ ...requested,
		tools: { kind: "custom", tools: await createConfinedCampaignFileTools(work, { writableFiles }) } }),
		resume: ref => actual.resume(ref), attestConfinedGrant: handle => actual.attestConfinedGrant(handle) };
	const run: StageRunRecord = { stage: "M07", runId: "R001", startedAt: new Date().toISOString(),
		status: "running", inputs: [], outputs: [], sessions: [], failures: [], remarks: [] };
	const handle = await openBoundedSession(wrapper, run, { mode: "fresh", intent: "new-work",
		reason: "audited file list", evidence: [], spec: spec(sessions, "seventeen-files",
			{ kind: "execution", root: work, tools: ["read", "write"] }) }, async () => {});
	assert.equal(run.sessions[0].boundary?.capability?.writableFiles?.length, 17);
	assert.equal(sent.count, 0);
	handle.dispose();
});

test("retired output fields cannot replace a missing live provider maximum", () => {
	assert.throws(() => new DeepSeekCampaignBudget({ ...LIMITS, maxOutputTokens: 1,
		maxProviderCalls: 1, maxProviderCallsPerPrompt: 1,
		providerOutputLimit: undefined as never }), /invalid DeepSeek campaign limits/);
	const budget = new DeepSeekCampaignBudget({ ...LIMITS, maxOutputTokens: 1,
		maxProviderCalls: 1, maxProviderCallsPerPrompt: 1 });
	assert.equal(budget.strictRequest.maxOutputTokens, TEST_PROVIDER_OUTPUT_LIMIT.maxOutputTokens);
	assert.equal(budget.strictRequest.maxProviderCallsPerPrompt, undefined);
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

test("no-campaign strict path retains tool/data safety without an artificial call-count quota", async (t) => {
	const dir = await mkdtemp(path.join(tmpdir(), "deepseek-campaign-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const sent = { count: 0, options: [] as Array<{ maxTokens?: number; maxRetries?: number }> };
	const runner = new PiSessionRunner({ modelRuntime: offlineRuntime(sent), createSession: offlineFactory(2) });
	await assert.rejects(runner.create({ ...spec(dir, "regression"), strictRequest: {
		maxInputPayloadBytes: 500, maxOutputTokens: 20,
	} }), /strict request requires positive integer caps/);
	assert.equal(sent.count, 0);
	const toolFree = await runner.create({ ...spec(dir, "two-calls", { kind: "none" }),
		strictRequest: { maxInputPayloadBytes: 500 } });
	t.after(() => toolFree.dispose());
	await toolFree.prompt("offline");
	assert.equal(sent.count, 2);
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
		assert.equal(budget.snapshot().stopped, false);
		assert.equal(budget.snapshot().stopReason, undefined);
		assert.equal(budget.snapshot().reservations, 1);
		assert.equal(budget.requestAccountingAuditSnapshot().requests[0].status, "unknown");
		const later = budget.beginPrompt("direct", "2");
		budget.reserve(later, 100, "request-2");
		assert.equal(budget.snapshot().reservations, 2);
	}
});

test("campaign reconciles each usage event against its own differently sized input reservation", () => {
	const budget = new DeepSeekCampaignBudget({ ...LIMITS, maxCny: 1 });
	const lease = budget.beginPrompt("direct", "1");
	budget.reserve(lease, 100, "request-1");
	budget.reserve(lease, 120_000, "request-2");
	const retained = budget.requestAccountingAuditSnapshot().requests.map(row => row.inputPayloadBytes);
	const event = (id: string, input: number) => ({ entryId: id, kind: "assistant" as const, promptIndex: 1,
		at: new Date().toISOString(), provider: "deepseek", model: "deepseek-flash", stopReason: "toolUse",
		usage: { input, output: 4, cacheRead: 0, cacheWrite: 0, totalTokens: input + 4, cost: 0.00001 },
		status: "reported" as const, costStatus: "priced" as const, costSource: "sdk-estimate" as const });
	assert.throws(() => budget.finishPrompt(lease, [
		{ requestId: "request-1", event: event("first", 101) },
		{ requestId: "request-2", event: event("second", 100) },
	]), /provider usage or call outcome/);
	assert.equal(budget.snapshot().stopped, false);
	assert.equal(budget.snapshot().stopReason, undefined);
	assert.equal(budget.snapshot().reservations, 2);
	assert.deepEqual(budget.requestAccountingAuditSnapshot().requests.map(row => row.inputPayloadBytes), retained);
	assert(budget.requestAccountingAuditSnapshot().requests.every(row => row.status === "unknown"));
	const later = budget.beginPrompt("direct", "2");
	budget.reserve(later, 100, "request-3");
	assert.equal(budget.snapshot().reservations, 3);
});

function reported(id: string, promptIndex = 1, input = 10, stopReason = "stop") {
	return { entryId: id, kind: "assistant" as const, promptIndex,
		at: new Date().toISOString(), provider: "deepseek", model: "deepseek-flash", stopReason,
		usage: { input, output: 4, cacheRead: 0, cacheWrite: 0, totalTokens: input + 4, cost: 0.0000078 },
		status: "reported" as const, costStatus: "priced" as const, costSource: "sdk-estimate" as const };
}

test("parallel branch leases reconcile independently without retired call quotas", () => {
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
	budget.reserve(next, 100, "third-1");
	assert.equal(budget.snapshot().reservations, 4);
	assert.equal(budget.snapshot().stopped, false);
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

test("concurrent Pi handles may exceed retired single-call fields", async (t) => {
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
	assert.equal(dispatched, 2);
	assert.equal(budget.snapshot().reservations, 2);
	assert.equal(budget.snapshot().stopped, false);
	assert(outcomes.every((item) => item.status === "fulfilled"));
});

test("duplicate lease or request ownership fails closed without granting an untracked retry", () => {
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
	const audit = budget.requestAccountingAuditSnapshot();
	assert.equal(audit.requests[0].status, "unknown");
	assert.equal(audit.requests[1].status, "in-flight");
	assert.equal(audit.unpricedRequestCount, 2);
});

test("duplicate finish cannot settle or bill the same provider response twice", () => {
	const budget = new DeepSeekCampaignBudget(LIMITS);
	const lease = budget.beginPrompt("session", "1");
	budget.reserve(lease, 100, "request-1");
	const receipts = [{ requestId: "request-1", event: reported("entry-1") }];
	budget.finishPrompt(lease, receipts);
	const before = budget.requestAccountingAuditSnapshot();
	assert.throws(() => budget.finishPrompt(lease, receipts), /invalid or already finished/);
	assert.deepEqual(budget.requestAccountingAuditSnapshot().requests, before.requests);
	assert.equal(budget.requestAccountingAuditSnapshot().unpricedRequestCount, 1);
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

test("campaign restores the live provider maximum if SDK context heuristics lower its payload cap", async t => {
	const dir = await mkdtemp(path.join(tmpdir(), "deepseek-provider-bound-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const price = await verifyDeepSeekCnyBilling({ apiKey: "synthetic", now: () => new Date("2026-10-06T11:20:00.000Z"),
		request: async () => new Response(JSON.stringify({ is_available: true, balance_infos: [{ currency: "CNY",
			total_balance: "PRIVATE", granted_balance: "PRIVATE", topped_up_balance: "PRIVATE" }] }), { status: 200 }) });
	const provider = await verifyDeepSeekProviderOutputLimit({ apiKey: "synthetic",
		request: async () => new Response(JSON.stringify({ object: "list", data: [{ id: "deepseek-flash",
			object: "model", name: "DeepSeek-V4.1-Flash", max_output_tokens: 393_216,
			context_window: 1_048_576 }] }), { status: 200 }) });
	const budget = new DeepSeekCampaignBudget({ model: LIMITS.model, endpoint: LIMITS.endpoint,
		maxCny: 30, priorCommittedCny: 0,
		outputAccountingMarginTokens: 32, estimatedInputCnyPerMillionTokens: 2,
		estimatedCacheReadCnyPerMillionTokens: 0.04, estimatedOutputCnyPerMillionTokens: 8,
		nativeCnyPricing: price, providerOutputLimit: provider });
	const model = { ...MODEL, maxTokens: provider.maxOutputTokens,
		contextWindow: provider.contextWindow } as Model<"openai-completions">;
	let outgoingCap = 0;
	const runtime = { getModels: () => [model],
		async streamSimple(m: Model<"openai-completions">, _context: unknown,
			options: { onPayload?: (payload: unknown, model: Model<"openai-completions">) => Promise<unknown> }) {
			const outgoing = await options.onPayload?.({ model: m.id, messages: [{ role: "user", content: "offline" }],
				max_tokens: 64_000 }, m) as { max_tokens: number };
			outgoingCap = outgoing.max_tokens;
		},
	} as unknown as ModelRuntime;
	const handle = await new PiSessionRunner({ modelRuntime: runtime, createSession: offlineFactory(1),
		campaignBudget: budget }).create(spec(dir, "provider-max"));
	t.after(() => handle.dispose());
	await handle.prompt("offline");
	assert.equal(outgoingCap, provider.maxOutputTokens);
	assert.equal(budget.requestAccountingAuditSnapshot().requests[0].maxOutputTokens, provider.maxOutputTokens);
});


test("legacy CNY ceiling and prior carry never deny a transport, including an over-ceiling carry", async t => {
	const dir = await mkdtemp(path.join(tmpdir(), "deepseek-accounting-no-gate-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const sent = { count: 0, options: [] as Array<{ maxTokens?: number; maxRetries?: number }> };
	const budget = new DeepSeekCampaignBudget({ ...LIMITS, maxCny: 0.000001,
		priorCommittedCny: 100, maxProviderCalls: 1, maxProviderCallsPerPrompt: 1, maxOutputTokens: 1 });
	const runner = new PiSessionRunner({ modelRuntime: offlineRuntime(sent),
		createSession: offlineFactory(2), campaignBudget: budget });
	const handle = await runner.create(spec(dir, "over-old-ceiling"));
	t.after(() => handle.dispose());
	await handle.prompt("two calls despite obsolete fee gate");
	assert.equal(sent.count, 2);
	assert.deepEqual(sent.options.map(option => option.maxTokens), [20, 20]);
	assert.equal(budget.snapshot().reservations, 2);
	assert.equal(budget.snapshot().stopped, false);
	const audit = budget.requestAccountingAuditSnapshot();
	assert.equal(audit.kind, "accounting-only-request-audit");
	assert.equal(audit.requests.length, 2);
	assert.equal(audit.unpricedRequestCount, 2);
	assert(audit.requests.every(row => row.settledCny === null && row.unknownObservedCny === null));
	assert(audit.requests.every(row => row.reportedUsage?.totalTokens === 14));
});

test("a large serialized payload is observed without the retired fee ceiling or 96 KB cap", async t => {
	const dir = await mkdtemp(path.join(tmpdir(), "deepseek-accounting-payload-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const payload = { model: MODEL.id, messages: [{ role: "user", content: "x".repeat(120_000) }], max_tokens: 20 };
	const payloadBytes = Buffer.byteLength(JSON.stringify(payload), "utf8");
	let sent = 0;
	const runtime = { getModels: () => [MODEL],
		async streamSimple(model: Model<"openai-completions">, _context: unknown,
			options: { onPayload?: (payload: unknown, model: Model<"openai-completions">) => Promise<unknown> }) {
			await options.onPayload?.(payload, model);
			sent++;
		},
	} as unknown as ModelRuntime;
	const budget = new DeepSeekCampaignBudget({ ...LIMITS, maxCny: 0.000001 });
	const handle = await new PiSessionRunner({ modelRuntime: runtime, createSession: offlineFactory(2),
		campaignBudget: budget }).create(spec(dir, "large-payload"));
	t.after(() => handle.dispose());
	await handle.prompt("offline");
	assert.equal(sent, 2);
	assert.equal(budget.snapshot().stopped, false);
	const rows = budget.requestAccountingAuditSnapshot().requests;
	assert.deepEqual(rows.map(row => row.inputPayloadBytes), [payloadBytes, payloadBytes]);
	assert(rows.every(row => row.maxOutputTokens === 20));
	assert(rows.every(row => /^[0-9a-f]{64}$/.test(row.sessionId) && row.sessionId !== handle.ref.id));
});

test("unpriced CNY retains raw usage and unknown status rather than reporting a zero charge", () => {
	const budget = new DeepSeekCampaignBudget(LIMITS);
	const lease = budget.beginPrompt("session", "one");
	budget.reserve(lease, 100, "request-one");
	budget.finishPrompt(lease, [{ requestId: "request-one", event: reported("entry-one") }]);
	const audit = budget.requestAccountingAuditSnapshot();
	assert.equal(audit.settledCny, 0);
	assert.equal(audit.unpricedRequestCount, 1);
	assert.equal(audit.requests[0].status, "unknown");
	assert.equal(audit.requests[0].responseReceived, true, "unknown CNY is not an unknown transport");
	assert.equal(audit.requests[0].settledCny, null);
	assert.equal(audit.requests[0].unknownObservedCny, null);
	assert.equal(audit.requests[0].reportedUsage?.reportedUsdCost, 0.0000078);
	assert.equal(audit.requests[0].reportedUsage?.totalTokens, 14);
	const next = budget.beginPrompt("session", "two");
	budget.reserve(next, 100, "request-two");
	assert.equal(budget.snapshot().stopped, false);
	assert.equal(budget.snapshot().reservations, 2);
});

test("failed unpriced prompt retains unknown outcome without stopping an unrelated branch", () => {
	const budget = new DeepSeekCampaignBudget(LIMITS);
	const left = budget.beginPrompt("left", "one");
	const right = budget.beginPrompt("right", "one");
	budget.reserve(left, 100, "left-request");
	budget.failPrompt(left);
	assert.equal(budget.requestAccountingAuditSnapshot().requests[0].status, "unknown");
	assert.equal(budget.requestAccountingAuditSnapshot().requests[0].responseReceived, false);
	assert.equal(budget.requestAccountingAuditSnapshot().unpricedRequestCount, 1);
	assert.equal(budget.snapshot().stopped, false);
	budget.reserve(right, 100, "right-request");
	budget.finishPrompt(right, [{ requestId: "right-request", event: reported("right-entry") }]);
	assert.equal(budget.snapshot().reservations, 2);
	assert.equal(budget.snapshot().stopped, false);
});

test("an unpriced received length response certifies transport effects while keeping fee unknown", () => {
	const budget = new DeepSeekCampaignBudget(LIMITS);
	const lease = budget.beginPrompt("session", "one");
	budget.reserve(lease, 100, "request");
	budget.stopAfterTerminalLength(lease, "request", reported("length", 1, 10, "length"));
	assert.equal(budget.certifySettledTerminalResponse(lease, "no-tools")?.code,
		"runner.response.length-settled");
	assert.equal(budget.requestAccountingAuditSnapshot().requests[0].status, "unknown");
	assert.equal(budget.requestAccountingAuditSnapshot().requests[0].responseReceived, true);
	budget.failPrompt(lease);
});

test("accounting audit is immutable and omits prompt ownership details", () => {
	const budget = new DeepSeekCampaignBudget(LIMITS);
	const lease = budget.beginPrompt("private-session", "private-prompt");
	budget.reserve(lease, 100, "transport-id");
	budget.finishPrompt(lease, [{ requestId: "transport-id", event: reported("entry") }]);
	const audit = budget.requestAccountingAuditSnapshot();
	assert.doesNotMatch(JSON.stringify(audit), /private-session|private-prompt/);
	assert.equal(audit.requests[0].reportedUsage?.input, 10);
	audit.requests[0].reportedUsage!.input = 999;
	assert.equal(budget.requestAccountingAuditSnapshot().requests[0].reportedUsage?.input, 10);
});

test("endpoint mismatch and unavailable payload size stop transport before it is issued", async t => {
	const dir = await mkdtemp(path.join(tmpdir(), "deepseek-identity-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const sent = { count: 0, options: [] as Array<{ maxTokens?: number; maxRetries?: number }> };
	const altered = { ...MODEL, baseUrl: "https://evil.invalid" };
	const budget = new DeepSeekCampaignBudget(LIMITS);
	const handle = await new PiSessionRunner({ modelRuntime: offlineRuntime(sent, altered),
		createSession: offlineFactory(1), campaignBudget: budget }).create(spec(dir, "changed-endpoint"));
	t.after(() => handle.dispose());
	await assert.rejects(handle.prompt("offline"), /DeepSeek model, endpoint or provider output limit did not verify/);
	assert.equal(sent.count, 0);
	assert.equal(budget.snapshot().reservations, 0);
	const direct = new DeepSeekCampaignBudget(LIMITS);
	const lease = direct.beginPrompt("direct", "one");
	assert.throws(() => direct.reserve(lease, 0, "request"), /payload byte count is unavailable/);
	assert.equal(direct.snapshot().stopReason, "payload-boundary");
});

test("conflicting provider output-cap fields fail before transport", async t => {
	const dir = await mkdtemp(path.join(tmpdir(), "deepseek-cap-integrity-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	let dispatched = 0;
	const runtime = { getModels: () => [MODEL],
		async streamSimple(model: Model<"openai-completions">, _context: unknown,
			options: { onPayload?: (payload: unknown, model: Model<"openai-completions">) => Promise<unknown> }) {
			await options.onPayload?.({ model: model.id, messages: [], max_tokens: 20,
				max_completion_tokens: 50 }, model);
			dispatched++;
		},
	} as unknown as ModelRuntime;
	const budget = new DeepSeekCampaignBudget(LIMITS);
	const handle = await new PiSessionRunner({ modelRuntime: runtime, createSession: offlineFactory(1),
		campaignBudget: budget }).create(spec(dir, "conflicting-output-cap"));
	t.after(() => handle.dispose());
	await assert.rejects(handle.prompt("offline"), /output bound missing or inconsistent/);
	assert.equal(dispatched, 0);
	assert.equal(budget.snapshot().reservations, 0);
});

test("a usage-ledger write failure retains an unpriced unknown transport", async t => {
	const dir = await mkdtemp(path.join(tmpdir(), "deepseek-ledger-write-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const sent = { count: 0, options: [] as Array<{ maxTokens?: number; maxRetries?: number }> };
	const budget = new DeepSeekCampaignBudget(LIMITS);
	const handle = await new PiSessionRunner({ modelRuntime: offlineRuntime(sent),
		createSession: offlineFactory(1), campaignBudget: budget }).create(spec(dir, "ledger-failure"));
	t.after(() => handle.dispose());
	await mkdir(handle.ref.file!.replace(/\.jsonl$/, ".usage.jsonl"));
	await assert.rejects(handle.prompt("offline"), /EISDIR|illegal operation on a directory/);
	assert.equal(sent.count, 1);
	assert.equal(budget.requestAccountingAuditSnapshot().requests[0].status, "unknown");
	assert.equal(budget.requestAccountingAuditSnapshot().unpricedRequestCount, 1);
});

test("a reported terminal tool-loop usage is reconciled before the next request", async t => {
	const dir = await mkdtemp(path.join(tmpdir(), "deepseek-stream-accounting-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const payload = { model: MODEL.id, messages: [], max_tokens: 20 };
	const budget = new DeepSeekCampaignBudget(LIMITS);
	let called = 0;
	let observedBeforeSecond = false;
	const runtime = { getModels: () => [MODEL],
		streamSimple(model: Model<"openai-completions">, _context: unknown,
			options: { onPayload?: (payload: unknown, model: Model<"openai-completions">) => Promise<unknown> }) {
			const stream = createAssistantMessageEventStream();
			void (async () => {
				await options.onPayload?.(payload, model);
				called++;
				if (called === 2) observedBeforeSecond = budget.requestAccountingAuditSnapshot().requests[0].reportedUsage?.totalTokens === 14;
				const stopReason = called === 1 ? "toolUse" as const : "stop" as const;
				const assistant = { role: "assistant" as const, api: model.api, provider: model.provider, model: model.id,
					content: [{ type: "text" as const, text: `round ${called}` }], stopReason, timestamp: Date.now(),
					usage: { input: 10, output: 4, cacheRead: 0, cacheWrite: 0, totalTokens: 14,
						cost: { input: 0.000003, output: 0.0000048, cacheRead: 0, cacheWrite: 0, total: 0.0000078 } } };
				stream.push({ type: "start", partial: assistant });
				stream.push({ type: "done", reason: stopReason, message: assistant });
				stream.end();
			})().catch(error => { throw error; });
			return stream;
		},
	} as unknown as ModelRuntime;
	const handle = await new PiSessionRunner({ modelRuntime: runtime, createSession: streamFactory(2),
		campaignBudget: budget }).create(spec(dir, "stream-accounting"));
	t.after(() => handle.dispose());
	await handle.prompt("two tool loops");
	assert.equal(called, 2);
	assert.equal(observedBeforeSecond, true);
	assert.equal(budget.requestAccountingAuditSnapshot().unpricedRequestCount, 2);
});

test("real Pi transports one offline request with its runtime key, confined tools, and live provider maximum", async () => {
	const dir = await mkdtemp(path.join(tmpdir(), "deepseek-real-pi-offline-"));
	const originalFetch = globalThis.fetch;
	let unrelatedFetches = 0;
	globalThis.fetch = async () => { unrelatedFetches++; throw new Error("unexpected network route"); };
	let handle: Awaited<ReturnType<PiSessionRunner["create"]>> | undefined;
	try {
		const profile = path.join(dir, "profile"), work = path.join(dir, "work"), sessions = path.join(dir, "sessions");
		await Promise.all([mkdir(profile), mkdir(work), mkdir(sessions)]);
		await writeFile(path.join(profile, "models.json"), JSON.stringify({ providers: { deepseek: { models: [{ ...MODEL,
			maxTokens: 393_216, contextWindow: 1_048_576,
			compat: { supportsStore: false, supportsDeveloperRole: false, maxTokensField: "max_tokens",
				thinkingFormat: "deepseek" },
		}] } } }));
		const runtime = await ModelRuntime.create({ modelsPath: path.join(profile, "models.json"),
			authPath: path.join(profile, "auth.json"), modelsStorePath: path.join(profile, "models-store.json"),
			allowModelNetwork: false, refreshOnCreate: false });
		const key = "sk-SYNTHETIC-OFFLINE-ONLY";
		await runtime.setRuntimeApiKey("deepseek", key);
		const provider = await verifyDeepSeekProviderOutputLimit({ apiKey: key,
			request: async () => new Response(JSON.stringify({ object: "list", data: [{ id: "deepseek-flash",
				object: "model", name: "DeepSeek-V4.1-Flash", max_output_tokens: 393_216,
				context_window: 1_048_576 }] }), { status: 200 }) });
		const calls: Array<{ endpoint: string; authorization: string | null; tools: number; cap: number }> = [];
		const fakeFetch: typeof fetch = async (input, init) => {
			const headers = new Headers(input instanceof Request ? input.headers : undefined);
			new Headers(init?.headers).forEach((value, name) => headers.set(name, value));
			const payload = typeof init?.body === "string" ? JSON.parse(init.body) as { tools?: unknown[]; max_tokens?: number } : {};
			calls.push({ endpoint: input instanceof Request ? input.url : String(input),
				authorization: headers.get("authorization"), tools: payload.tools?.length ?? 0,
				cap: payload.max_tokens ?? 0 });
			return new Response(JSON.stringify({ error: { message: "offline synthetic rejection",
				type: "invalid_request_error" } }),
				{ status: 401, headers: { "content-type": "application/json" } });
		};
		const originalStream = runtime.streamSimple.bind(runtime);
		runtime.streamSimple = ((model, context, options) => originalStream(model, context,
			{ ...options, fetch: fakeFetch })) as typeof runtime.streamSimple;
		const budget = new DeepSeekCampaignBudget({ ...LIMITS, maxCny: 0.000001, priorCommittedCny: 100,
			maxOutputTokens: 1, providerOutputLimit: provider });
		const tools = await createConfinedCampaignFileTools(work, { writableFiles: ["candidate.cpp"] });
		handle = await new PiSessionRunner({ modelRuntime: runtime, campaignBudget: budget })
			.create(spec(sessions, "real-pi-offline", { kind: "custom", tools }));
		await assert.rejects(handle.prompt("Offline authentication check."));
		assert.deepEqual(calls, [{ endpoint: "https://api.deepseek.com/chat/completions",
			authorization: `Bearer ${key}`, tools: 3, cap: provider.maxOutputTokens }]);
		assert.equal(unrelatedFetches, 0);
		assert.equal(budget.requestAccountingAuditSnapshot().requests[0].maxOutputTokens,
			provider.maxOutputTokens);
		assert.equal(budget.requestAccountingAuditSnapshot().requests[0].status, "unknown");
		assert.equal(budget.requestAccountingAuditSnapshot().unpricedRequestCount, 1);
	} finally {
		handle?.dispose();
		globalThis.fetch = originalFetch;
		await rm(dir, { recursive: true, force: true });
	}
});
