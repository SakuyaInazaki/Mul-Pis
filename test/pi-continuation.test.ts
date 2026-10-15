import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fauxAssistantMessage, registerFauxProvider, streamSimple } from "@earendil-works/pi-ai/compat";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createResearchExtension } from "../src/pi/extension.ts";
import { ResearchService } from "../src/pi/service.ts";
import type { CurrentGoal, FinishInput } from "../src/m07/types.ts";

function goal(lifecycle: "active" | "finished", outcome?: "fulfilled" | "blocked"): CurrentGoal {
	return { runId: "g1", lifecycle, outcome, updatedAt: "fixed", tasks: [], decisions: [] } as unknown as CurrentGoal;
}

async function offlineSession(service: ResearchService, continuation?: { workspace: string; goalRunId?: string }) {
	const cwd = await mkdtemp(path.join(tmpdir(), "pre-rsi-continuation-"));
	const faux = registerFauxProvider();
	const settingsManager = SettingsManager.inMemory({ retry: { enabled: false } });
	const sessionManager = SessionManager.inMemory();
	const resourceLoader = new DefaultResourceLoader({
		cwd, agentDir: path.join(cwd, "agent"), settingsManager,
		noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
		extensionFactories: [{ name: "pre-rsi", factory: createResearchExtension({ service, continuation }) }],
	});
	await resourceLoader.reload();
	const modelRuntime = {
		getModels: () => faux.models,
		getModel: () => faux.getModel(),
		getAvailableSnapshot: () => faux.models,
		hasConfiguredAuth: () => true,
		checkAuth: async () => ({ type: "api_key" }),
		isUsingOAuth: () => false,
		getAuth: async () => ({ auth: { apiKey: "offline-faux-key" }, source: "test" }),
		streamSimple,
	} as unknown as ModelRuntime;
	const { session } = await createAgentSession({ cwd, agentDir: path.join(cwd, "agent"), model: faux.getModel(),
		modelRuntime, settingsManager, sessionManager, resourceLoader, noTools: "builtin" });
	return { session, faux, sessionManager, cleanup: async () => { session.dispose(); faux.unregister(); await rm(cwd, { recursive: true, force: true }); } };
}

test("actual Pi prompt drains agent_end follow-up before print-style prompt returns", async () => {
	let reads = 0;
	const service = { goalStatus: async () => (++reads === 1 ? goal("active") : goal("finished", "fulfilled")) } as unknown as ResearchService;
	const h = await offlineSession(service, { workspace: ".", goalRunId: "g1" });
	let ends = 0;
	h.session.subscribe((event) => { if (event.type === "agent_end") ends++; });
	try {
		h.faux.setResponses([fauxAssistantMessage("checkpoint"), fauxAssistantMessage("done")]);
		await h.session.prompt("continue the bound goal");
		assert.equal(h.faux.state.callCount, 2);
		assert.equal(ends, 2);
		assert.equal(h.faux.getPendingResponseCount(), 0);
		assert.equal(reads, 2);
	} finally { await h.cleanup(); }
});

test("provider error on bound goal does not queue another provider request", async () => {
	const service = { goalStatus: async () => goal("active") } as unknown as ResearchService;
	const h = await offlineSession(service, { workspace: ".", goalRunId: "g1" });
	try {
		h.faux.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "offline provider fault" })]);
		await h.session.prompt("continue");
		assert.equal(h.faux.state.callCount, 1);
	} finally { await h.cleanup(); }
});

test("aborted bound turn does not queue another provider request", async () => {
	const service = { goalStatus: async () => goal("active") } as unknown as ResearchService;
	const h = await offlineSession(service, { workspace: ".", goalRunId: "g1" });
	try {
		h.faux.setResponses([fauxAssistantMessage("", { stopReason: "aborted" })]);
		await h.session.prompt("continue");
		assert.equal(h.faux.state.callCount, 1);
		assert(h.sessionManager.getEntries().some((entry) => entry.type === "custom" && entry.customType === "research_continuation" &&
			(entry.data as { reason?: string }).reason === "request-aborted"));
	} finally { await h.cleanup(); }
});

test("unchanged active goals continue beyond the former empty-round cutoff until persisted completion", async () => {
	let reads = 0;
	const service = { goalStatus: async () => (++reads < 7 ? goal("active") : goal("finished", "fulfilled")) } as unknown as ResearchService;
	const h = await offlineSession(service, { workspace: ".", goalRunId: "g1" });
	try {
		h.faux.setResponses(Array.from({ length: 7 }, () => fauxAssistantMessage("checkpoint")));
		await h.session.prompt("continue");
		assert.equal(h.faux.state.callCount, 7);
		const entries = h.sessionManager.getEntries();
		assert(entries.some((entry) => entry.type === "custom" && entry.customType === "research_continuation" &&
			(entry.data as { status?: string }).status === "observed"));
		assert(!entries.some((entry) => entry.type === "custom" && entry.customType === "research_continuation" &&
			(entry.data as { reason?: string }).reason === "repeated-empty-agent-rounds-with-unchanged-goal"));
		assert(entries.some((entry) => entry.type === "custom" && entry.customType === "research_continuation" &&
			(entry.data as { status?: string }).status === "fulfilled"));
	} finally { await h.cleanup(); }
});

test("persisted fulfilled goal ends the prompt without a continuation or archive", async () => {
	const service = { goalStatus: async () => goal("finished", "fulfilled") } as unknown as ResearchService;
	const h = await offlineSession(service, { workspace: ".", goalRunId: "g1" });
	try {
		h.faux.setResponses([fauxAssistantMessage("done")]);
		await h.session.prompt("continue");
		assert.equal(h.faux.state.callCount, 1);
		assert(h.sessionManager.getEntries().some((entry) => entry.type === "custom" && entry.customType === "research_continuation" &&
			(entry.data as { status?: string }).status === "fulfilled"));
	} finally { await h.cleanup(); }
});

test("shutdown suspends a versioned attempt without calling legacy archive", async () => {
	const calls: string[] = [];
	const versioned = { ...goal("active"), executionState: { version: 1, activeAttemptId: "A001", attempts: [{ id: "A001", state: "running" }], operations: [] } } as unknown as CurrentGoal;
	const service = {
		goalStatus: async () => versioned,
		hostSuspend: async () => { calls.push("suspend"); return versioned; },
		hostInterrupt: async () => { calls.push("archive"); throw new Error("legacy path must not run"); },
		interruptAllActive: async () => { calls.push("cleanup"); },
	} as unknown as ResearchService;
	const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
	const api = { on(name: string, handler: (event: unknown, ctx: unknown) => unknown) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); }, registerTool() {}, registerCommand() {}, appendEntry() {} } as unknown as ExtensionAPI;
	createResearchExtension({ service, continuation: { workspace: "/bound", goalRunId: "g1" } })(api);
	await handlers.get("session_shutdown")![0]({ reason: "quit" }, { cwd: "/bound", mode: "json" });
	assert.deepEqual(calls, ["suspend", "cleanup"]);
});

test("RPC fresh recovery binds a successor and keeps continuous goal guards", async t => {
	const root = await mkdtemp(path.join(tmpdir(), "pre-rsi-rpc-recovery-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const descriptorFile = path.join(root, "run-descriptor.json");
	await writeFile(descriptorFile, JSON.stringify({ version: 1, instanceId: "new-instance", attemptId: "pending", workspaceId: "store-1", goalRunId: "g1", codeRevision: "test", controlDir: root, process: { hostId: "test-host", bootId: "test-boot", pid: 999999, processStartToken: "test-start" } }));
	const previousRecover = process.env.PRE_RSI_RECOVER_GOAL_RUN_ID;
	const previousDescriptor = process.env.PRE_RSI_RUN_DESCRIPTOR_FILE;
	process.env.PRE_RSI_RECOVER_GOAL_RUN_ID = "g1";
	process.env.PRE_RSI_RUN_DESCRIPTOR_FILE = descriptorFile;
	t.after(() => { if (previousRecover === undefined) delete process.env.PRE_RSI_RECOVER_GOAL_RUN_ID; else process.env.PRE_RSI_RECOVER_GOAL_RUN_ID = previousRecover; if (previousDescriptor === undefined) delete process.env.PRE_RSI_RUN_DESCRIPTOR_FILE; else process.env.PRE_RSI_RUN_DESCRIPTOR_FILE = previousDescriptor; });
	const recovered: unknown[][] = [];
	const old = { ...goal("active"), executionState: { version: 1, activeAttemptId: "A001", attempts: [{ id: "A001", state: "suspended" }], operations: [] } } as unknown as CurrentGoal;
	const service = { goalStatus: async () => old, hostRecover: async (...args: unknown[]) => { recovered.push(args); return old; } } as unknown as ResearchService;
	const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
	const tools = new Map<string, { execute: (...args: unknown[]) => Promise<unknown> }>();
	let activeTools = ["read", "bash"];
	const api = { on(name: string, handler: (event: unknown, ctx: unknown) => unknown) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
		registerTool(tool: { name: string; execute: (...args: unknown[]) => Promise<unknown> }) { tools.set(tool.name, tool); }, registerCommand() {}, appendEntry() {},
		getActiveTools() { return activeTools; }, setActiveTools(names: string[]) { activeTools = names; } } as unknown as ExtensionAPI;
	createResearchExtension({ service, continuation: { workspace: "/bound", goalRunId: "g1" } })(api);
	const ctx = { cwd: "/bound", mode: "rpc" };
	await handlers.get("session_start")![0]({}, ctx);
	assert.equal(recovered.length, 1);
	assert.equal((recovered[0][0] as { expectedAttemptId: string }).expectedAttemptId, "A001");
	assert.equal((JSON.parse(await readFile(descriptorFile, "utf8")) as { attemptId: string }).attemptId, "A002");
	assert.equal(activeTools.includes("bash"), false);
	await assert.rejects(tools.get("research_goal")!.execute("finish", { action: "finish", workspace: "/bound", runId: "g1", outcome: "blocked", stopReason: "dependency_unavailable" }, undefined, undefined, ctx), /continuous/);
});

test("public Pi goal tool freezes real M07 contract and scientific failure cannot end it", async () => {
	const root = await mkdtemp(path.join(tmpdir(), "pre-rsi-continuous-real-"));
	try {
		await mkdir(path.join(root, "problem", "raw"), { recursive: true });
		await writeFile(path.join(root, "problem", "problem.md"), "Offline test problem\n");
		const service = new ResearchService({ defaultWorkspace: root });
		await service.init(root);
		const tools = new Map<string, { execute: (...args: unknown[]) => Promise<unknown> }>();
		const api = { on() {}, registerTool(tool: { name: string; execute: (...args: unknown[]) => Promise<unknown> }) { tools.set(tool.name, tool); },
			registerCommand() {}, appendEntry() {}, getActiveTools() { return []; }, setActiveTools() {} } as unknown as ExtensionAPI;
		createResearchExtension({ service, continuation: { workspace: root } })(api);
		const tool = tools.get("research_goal")!;
		const ctx = { cwd: root, mode: "json" };
		await tool.execute("begin", { action: "begin", workspace: root, goal: "Improve the frozen target",
			problemRelation: "Same target", constraints: ["Keep the target fixed"], successCriteria: ["Controller-verified target met"], plan: "Continue experiments", exploratory: true }, undefined, undefined, ctx);
		const runId = (await service.status(root)).stages.M07.latest!.runId;
		assert.equal((await service.goalStatus(runId, root) as CurrentGoal).executionContract?.mode, "continuous");
		const blocked: { runId: string } & FinishInput = { runId, outcome: "blocked", summary: "One candidate failed", returnPath: "user",
			limitations: ["dependency_unavailable", "No local compiler for this candidate"], goalChecks: [] };
		await assert.rejects(tool.execute("finish", { action: "finish", workspace: root, stopReason: "dependency_unavailable", ...blocked }, undefined, undefined, ctx), /continuous/);
		await assert.rejects(service.goalAction("finish", root, blocked), /continuous/);
		await assert.rejects(service.goalAction("interrupt", root, { runId, reason: "No more ideas" }), /continuous/);
		assert.equal((await service.goalStatus(runId, root) as CurrentGoal).lifecycle, "active");
		const archived = await service.hostInterrupt({ workspace: root, runId, reasonKind: "provider-error" }) as CurrentGoal;
		assert.equal(archived.lifecycle, "finished");
		assert.equal(archived.hostStopReceipt?.reasonKind, "provider-error");
		assert.equal((await service.goalStatus(runId, root) as CurrentGoal).hostStopReceipt?.source, "pi-host");
	} finally { await rm(root, { recursive: true, force: true }); }
});
