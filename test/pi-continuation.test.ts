import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fauxAssistantMessage, registerFauxProvider, streamSimple } from "@earendil-works/pi-ai/compat";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createResearchExtension } from "../src/pi/extension.ts";
import { ResearchService } from "../src/pi/service.ts";
import type { CurrentGoal, FinishInput } from "../src/m07/types.ts";
import { FakeSessionRunner } from "../src/runner/fake.ts";

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

test("unbound status-like session never queues a model turn", async () => {
	const service = { goalStatus: async () => { throw new Error("must not read another goal"); } } as unknown as ResearchService;
	const h = await offlineSession(service);
	try {
		h.faux.setResponses([fauxAssistantMessage("status reported")]);
		await h.session.prompt("read status");
		assert.equal(h.faux.state.callCount, 1);
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

test("repeated empty finals on an unchanged active goal stop with a visible incomplete reason", async () => {
	const service = { goalStatus: async () => goal("active") } as unknown as ResearchService;
	const h = await offlineSession(service, { workspace: ".", goalRunId: "g1" });
	try {
		h.faux.setResponses([fauxAssistantMessage("checkpoint"), fauxAssistantMessage("checkpoint"), fauxAssistantMessage("checkpoint")]);
		await h.session.prompt("continue");
		assert.equal(h.faux.state.callCount, 3);
		const entries = h.sessionManager.getEntries();
		assert(entries.some((entry) => entry.type === "custom" && entry.customType === "research_continuation" &&
			(entry.data as { reason?: string }).reason === "repeated-empty-agent-rounds-with-unchanged-goal"));
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

test("shutdown archives only the explicitly bound unfinished goal", async () => {
	const calls: unknown[][] = [];
	const service = {
		goalStatus: async () => goal("active"),
		hostInterrupt: async (...args: unknown[]) => { calls.push(args); return goal("finished", "blocked"); },
		interruptAllActive: async (...args: unknown[]) => { calls.push(args); },
	} as unknown as ResearchService;
	const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
	const entries: unknown[] = [];
	const api = {
		on(name: string, handler: (event: unknown, ctx: unknown) => unknown) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
		registerTool() {}, registerCommand() {}, appendEntry(_type: string, data: unknown) { entries.push(data); },
	} as unknown as ExtensionAPI;
	createResearchExtension({ service, continuation: { workspace: "/bound", goalRunId: "g1" } })(api);
	await handlers.get("session_shutdown")![0]({ reason: "quit" }, { cwd: "/bound", mode: "json" });
	assert.equal(calls.length, 2);
	assert.equal((calls[0][0] as { runId: string }).runId, "g1");
	assert.equal((calls[0][0] as { reasonKind: string }).reasonKind, "session-shutdown");
	assert.equal(calls[1][1], false);
	assert(entries.some((entry) => (entry as { reason?: string }).reason === "session-shutdown"));
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

test("failed fresh recovery never claims or suspends the old goal at shutdown", async (t) => {
	const root = await mkdtemp(path.join(tmpdir(), "pre-rsi-recovery-handshake-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const descriptorFile = path.join(root, "run-descriptor.json");
	await writeFile(descriptorFile, JSON.stringify({ version: 1, instanceId: "new-instance", attemptId: "pending", workspaceId: "store-1", goalRunId: "g1", codeRevision: "test", controlDir: root, process: { hostId: "test-host", bootId: "test-boot", pid: 999999, processStartToken: "test-start" } }));
	const previousRecover = process.env.PRE_RSI_RECOVER_GOAL_RUN_ID;
	const previousDescriptor = process.env.PRE_RSI_RUN_DESCRIPTOR_FILE;
	process.env.PRE_RSI_RECOVER_GOAL_RUN_ID = "g1";
	process.env.PRE_RSI_RUN_DESCRIPTOR_FILE = descriptorFile;
	t.after(() => { if (previousRecover === undefined) delete process.env.PRE_RSI_RECOVER_GOAL_RUN_ID; else process.env.PRE_RSI_RECOVER_GOAL_RUN_ID = previousRecover; if (previousDescriptor === undefined) delete process.env.PRE_RSI_RUN_DESCRIPTOR_FILE; else process.env.PRE_RSI_RUN_DESCRIPTOR_FILE = previousDescriptor; });
	const calls: string[] = [];
	const old = { ...goal("active"), executionState: { version: 1, activeAttemptId: "A001", attempts: [{ id: "A001", state: "running" }], operations: [] } } as unknown as CurrentGoal;
	const service = { goalStatus: async () => old, hostRecover: async () => { calls.push("recover"); throw new Error("old owner alive"); }, hostSuspend: async () => { calls.push("suspend"); }, hostInterrupt: async () => { calls.push("archive"); }, interruptAllActive: async () => { calls.push("cleanup"); } } as unknown as ResearchService;
	const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
	const api = { on(name: string, handler: (event: unknown, ctx: unknown) => unknown) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); }, registerTool() {}, registerCommand() {}, appendEntry() {} } as unknown as ExtensionAPI;
	createResearchExtension({ service, continuation: { workspace: "/bound", goalRunId: "g1" } })(api);
	await assert.rejects(async () => { await handlers.get("session_start")![0]({}, { cwd: "/bound", mode: "json" }); }, /old owner alive/);
	await handlers.get("session_shutdown")![0]({ reason: "quit" }, { cwd: "/bound", mode: "json" });
	assert.deepEqual(calls, ["recover", "cleanup"]);
});

test("ordinary continuation cannot claim a versioned goal owned by another Pi process", async (t) => {
	const root = await mkdtemp(path.join(tmpdir(), "pre-rsi-old-owner-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const descriptorFile = path.join(root, "run-descriptor.json");
	const processIdentity = { hostId: "test-host", bootId: "test-boot", pid: 999999, processStartToken: "old-birth" };
	const oldDescriptor = { version: 1, instanceId: "old-instance", attemptId: "A001", workspaceId: "store-1", goalRunId: "g1", codeRevision: "test", controlDir: root, process: processIdentity };
	await writeFile(descriptorFile, JSON.stringify({ ...oldDescriptor, instanceId: "new-instance", process: { ...processIdentity, pid: 999998, processStartToken: "new-birth" } }));
	const previousDescriptor = process.env.PRE_RSI_RUN_DESCRIPTOR_FILE;
	const previousRecover = process.env.PRE_RSI_RECOVER_GOAL_RUN_ID;
	process.env.PRE_RSI_RUN_DESCRIPTOR_FILE = descriptorFile;
	delete process.env.PRE_RSI_RECOVER_GOAL_RUN_ID;
	t.after(() => { if (previousDescriptor === undefined) delete process.env.PRE_RSI_RUN_DESCRIPTOR_FILE; else process.env.PRE_RSI_RUN_DESCRIPTOR_FILE = previousDescriptor; if (previousRecover === undefined) delete process.env.PRE_RSI_RECOVER_GOAL_RUN_ID; else process.env.PRE_RSI_RECOVER_GOAL_RUN_ID = previousRecover; });
	const calls: string[] = [];
	const old = { ...goal("active"), executionState: { version: 1, activeAttemptId: "A001", attempts: [{ version: 1, id: "A001", state: "running", runDescriptor: oldDescriptor }], operations: [] } } as unknown as CurrentGoal;
	const service = { goalStatus: async () => old, hostSuspend: async () => { calls.push("suspend"); }, hostInterrupt: async () => { calls.push("archive"); }, interruptAllActive: async () => { calls.push("cleanup"); } } as unknown as ResearchService;
	const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
	const api = { on(name: string, handler: (event: unknown, ctx: unknown) => unknown) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); }, registerTool() {}, registerCommand() {}, appendEntry() {} } as unknown as ExtensionAPI;
	createResearchExtension({ service, continuation: { workspace: "/bound", goalRunId: "g1" } })(api);
	await assert.rejects(async () => { await handlers.get("session_start")![0]({}, { cwd: "/bound", mode: "json" }); }, /不是 M07 运行中 attempt 的宿主/);
	await handlers.get("session_shutdown")![0]({ reason: "quit" }, { cwd: "/bound", mode: "json" });
	assert.deepEqual(calls, ["cleanup"]);
});

test("agent end does not queue another turn for an open goal with a suspended attempt", async () => {
	const suspended = { ...goal("active"), executionState: { version: 1, activeAttemptId: "A001", attempts: [{ id: "A001", state: "suspended" }], operations: [{ id: "O001", status: "unknown" }] } } as CurrentGoal;
	const service = { goalStatus: async () => suspended } as unknown as ResearchService;
	const h = await offlineSession(service, { workspace: ".", goalRunId: "g1" });
	try {
		h.faux.setResponses([fauxAssistantMessage("pause acknowledged")]);
		await h.session.prompt("continue");
		assert.equal(h.faux.state.callCount, 1);
		assert(h.sessionManager.getEntries().some((entry) => entry.type === "custom" && entry.customType === "research_continuation" && (entry.data as { reason?: string }).reason === "attempt-suspended"));
	} finally { await h.cleanup(); }
});

test("unreadable bound goal still runs owned stage cleanup and records repair need", async () => {
	const calls: string[] = [];
	const service = {
		goalStatus: async () => { throw new Error("offline unreadable goal"); },
		hostInterrupt: async () => { calls.push("interrupt"); throw new Error("offline archive fault"); },
		interruptAllActive: async () => { calls.push("stage-cleanup"); },
	} as unknown as ResearchService;
	const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
	const entries: unknown[] = [];
	const api = {
		on(name: string, handler: (event: unknown, ctx: unknown) => unknown) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
		registerTool() {}, registerCommand() {}, appendEntry(_type: string, data: unknown) { entries.push(data); },
	} as unknown as ExtensionAPI;
	createResearchExtension({ service, continuation: { workspace: "/bound", goalRunId: "g1" } })(api);
	await assert.rejects(async () => { await handlers.get("session_shutdown")![0]({ reason: "quit" }, { cwd: "/bound", mode: "json" }); });
	assert.deepEqual(calls, ["stage-cleanup"], "unreadable goal version must not be guessed or archived");
	assert(entries.some((entry) => (entry as { status?: string }).status === "repair-required"));
});

test("only a successful goal begin in the enabled workspace binds a new goal", async () => {
	const queued: unknown[] = [];
	const beginCalls: unknown[][] = [];
	const service = {
		goalAction: async (...args: unknown[]) => { beginCalls.push(args); return goal("active"); },
		goalStatus: async () => goal("active"),
	} as unknown as ResearchService;
	const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
	const tools = new Map<string, { execute: (...args: unknown[]) => Promise<unknown> }>();
	const api = {
		on(name: string, handler: (event: unknown, ctx: unknown) => unknown) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
		registerTool(tool: { name: string; execute: (...args: unknown[]) => Promise<unknown> }) { tools.set(tool.name, tool); },
		registerCommand() {}, appendEntry() {}, sendMessage(message: unknown) { queued.push(message); },
	} as unknown as ExtensionAPI;
	createResearchExtension({ service, continuation: { workspace: "/bound" } })(api);
	const ctx = { cwd: "/controller", mode: "json" };
	await handlers.get("agent_end")![0]({ messages: [fauxAssistantMessage("status only")] }, ctx);
	assert.equal(queued.length, 0);
	await assert.rejects(tools.get("research_goal")!.execute("wrong-workspace", { action: "begin", goal: "g", problemRelation: "r", plan: "p" }, undefined, undefined, ctx), /workspace/);
	await handlers.get("agent_end")![0]({ messages: [fauxAssistantMessage("other workspace") ] }, ctx);
	assert.equal(queued.length, 0);
	await tools.get("research_goal")!.execute("begin", { action: "begin", workspace: "/bound", goal: "g", problemRelation: "r", plan: "p" }, undefined, undefined, ctx);
	assert.deepEqual(beginCalls[0][4], { executionContract: "continuous" });
	await handlers.get("agent_end")![0]({ messages: [fauxAssistantMessage("checkpoint")] }, ctx);
	assert.equal(queued.length, 1);
	assert.match(JSON.stringify(queued[0]), /runId=g1/);
	assert.match(JSON.stringify(queued[0]), /workspace=\/bound/);
	assert.match(JSON.stringify(queued[0]), /feedbackCheckpointId/);
	assert.doesNotMatch(JSON.stringify(queued[0]), /finish.*stopReason/);
});

test("bound active goal cannot be displaced by same- or cross-workspace begin", async () => {
	const calls: unknown[][] = [];
	const service = { goalStatus: async () => goal("active"), goalAction: async (...args: unknown[]) => { calls.push(args); return goal("active"); } } as unknown as ResearchService;
	const tools = new Map<string, { execute: (...args: unknown[]) => Promise<unknown> }>();
	const api = { on() {}, registerTool(tool: { name: string; execute: (...args: unknown[]) => Promise<unknown> }) { tools.set(tool.name, tool); },
		registerCommand() {}, appendEntry() {} } as unknown as ExtensionAPI;
	createResearchExtension({ service, continuation: { workspace: "/bound", goalRunId: "g1" } })(api);
	const tool = tools.get("research_goal")!;
	const ctx = { cwd: "/controller", mode: "json" };
	await assert.rejects(tool.execute("new-same", { action: "begin", workspace: "/bound", goal: "another" }, undefined, undefined, ctx), /仍 active/);
	await assert.rejects(tool.execute("new-other", { action: "begin", workspace: "/other", goal: "another" }, undefined, undefined, ctx), /workspace/);
	await assert.rejects(tool.execute("other-checkpoint", { action: "checkpoint", workspace: "/bound", runId: "g2" }, undefined, undefined, ctx), /当前绑定/);
	await assert.rejects(tool.execute("other-plan", { action: "plan", workspace: "/other", runId: "g1", plan: "x" }, undefined, undefined, ctx), /当前绑定/);
	assert.equal(calls.length, 0);
});

test("public tools pass an exact checkpoint into M04 and an explicit same-goal baseline refresh", async () => {
	const calls: unknown[][] = [];
	const service = {
		goalAction: async (...args: unknown[]) => { calls.push(args); return args[0] === "checkpoint"
			? { id: "cp-1", createdAt: "fixed", rootDir: "/bound", goalSnapshotPath: "goal.json", feedbackPath: "feedback.json", manifestPath: "manifest.json", feedbackStatus: "complete", sourceGoalUpdatedAt: "fixed" }
			: goal("active"); },
		runStage: async (...args: unknown[]) => { calls.push(args); return { stage: "M04", runId: "m04-1", status: "completed" }; },
	} as unknown as ResearchService;
	const tools = new Map<string, { execute: (...args: unknown[]) => Promise<unknown> }>();
	const api = { on() {}, registerTool(tool: { name: string; execute: (...args: unknown[]) => Promise<unknown> }) { tools.set(tool.name, tool); },
		registerCommand() {}, appendEntry() {} } as unknown as ExtensionAPI;
	createResearchExtension({ service, continuation: { workspace: "/bound", goalRunId: "g1" } })(api);
	const ctx = { cwd: "/controller", mode: "json" };
	const checkpoint = await tools.get("research_goal")!.execute("cp", { action: "checkpoint", workspace: "/bound", runId: "g1", taskIds: ["T001"] }, undefined, undefined, ctx);
	assert.match(JSON.stringify(checkpoint), /checkpointId.*cp-1/);
	assert.deepEqual(calls[0].slice(0, 3), ["checkpoint", "/bound", { runId: "g1", taskIds: ["T001"] }]);
	await tools.get("research_stage")!.execute("m04", { stage: "M04", workspace: "/bound", feedbackStage: "M07", feedbackRunId: "g1", feedbackCheckpointId: "cp-1", freshSession: true }, undefined, undefined, ctx);
	assert.deepEqual(calls[1][0], { stage: "M04", workspace: "/bound", feedbackStage: "M07", feedbackRunId: "g1", feedbackCheckpointId: "cp-1", freshSession: true, sources: undefined });
	await tools.get("research_goal")!.execute("refresh", { action: "plan", workspace: "/bound", runId: "g1", plan: "Continue same target", refreshBaseline: true, checkpointId: "cp-1", m04RunId: "m04-1" }, undefined, undefined, ctx);
	assert.deepEqual(calls[2].slice(0, 3), ["plan", "/bound", { runId: "g1", plan: "Continue same target", refreshBaseline: true, checkpointId: "cp-1", m04RunId: "m04-1" }]);
});

test("model cannot close or interrupt an explicitly continuous goal with text-only reasons", async () => {
	const calls: unknown[][] = [];
	const service = { goalAction: async (...args: unknown[]) => { calls.push(args); return goal("active"); } } as unknown as ResearchService;
	const tools = new Map<string, { execute: (...args: unknown[]) => Promise<unknown> }>();
	const api = { on() {}, registerTool(tool: { name: string; execute: (...args: unknown[]) => Promise<unknown> }) { tools.set(tool.name, tool); },
		registerCommand() {}, appendEntry() {} } as unknown as ExtensionAPI;
	createResearchExtension({ service, continuation: { workspace: "/bound", goalRunId: "g1" } })(api);
	const tool = tools.get("research_goal")!;
	const ctx = { cwd: "/controller", mode: "json" };
	await assert.rejects(tool.execute("finish", { action: "finish", workspace: "/bound", runId: "g1", outcome: "blocked",
		stopReason: "dependency_unavailable", limitations: ["candidate failed"], goalChecks: [] }, undefined, undefined, ctx), /continuous/);
	await assert.rejects(tool.execute("interrupt", { action: "interrupt", workspace: "/bound", runId: "g1", reason: "no idea" }, undefined, undefined, ctx), /continuous/);
	assert.equal(calls.length, 0);
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
			registerCommand() {}, appendEntry() {} } as unknown as ExtensionAPI;
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

test("public Pi checkpoint feeds fixed M04 view and refreshes the same active goal", async () => {
	const root = await realpath(await mkdtemp(path.join(tmpdir(), "pre-rsi-public-checkpoint-")));
	try {
		await mkdir(path.join(root, "problem", "raw"), { recursive: true });
		await writeFile(path.join(root, "problem", "problem.md"), "Offline fixed problem\n");
		await writeFile(path.join(root, "research.config.json"), `${JSON.stringify({ roles: { execution: "fake/execution", reviewer: "fake/reviewer", research: "fake/research" }, concurrency: 1 })}\n`);
		const service = new ResearchService({ defaultWorkspace: root, runnerFactory: () => new FakeSessionRunner(() => ({ text: "Checkpoint evidence considered", reads: [] })) });
		await service.init(root);
		const tools = new Map<string, { execute: (...args: unknown[]) => Promise<unknown> }>();
		const api = { on() {}, registerTool(tool: { name: string; execute: (...args: unknown[]) => Promise<unknown> }) { tools.set(tool.name, tool); },
			registerCommand() {}, appendEntry() {} } as unknown as ExtensionAPI;
		createResearchExtension({ service, continuation: { workspace: root } })(api);
		const ctx = { cwd: root, mode: "json" };
		await tools.get("research_goal")!.execute("begin", { action: "begin", workspace: root, goal: "Keep a fixed objective",
			problemRelation: "Same objective", constraints: ["Preserve target"], successCriteria: ["Target evidenced"], plan: "Measure", exploratory: true }, undefined, undefined, ctx);
		const runId = (await service.status(root)).stages.M07.latest!.runId;
		const frozen = await tools.get("research_goal")!.execute("checkpoint", { action: "checkpoint", workspace: root, runId }, undefined, undefined, ctx) as { details?: { summary?: { checkpointId?: string } } };
		const checkpointId = frozen.details?.summary?.checkpointId;
		assert.ok(checkpointId);
		assert.match(checkpointId, /^C\d{3}$/);
		await assert.rejects(tools.get("research_stage")!.execute("live", { stage: "M04", workspace: root, feedbackStage: "M07", feedbackRunId: runId }, undefined, undefined, ctx), /尚未结束/);
		await assert.rejects(tools.get("research_stage")!.execute("empty", { stage: "M04", workspace: root, feedbackStage: "M07", feedbackRunId: runId, feedbackCheckpointId: "" }, undefined, undefined, ctx), /feedbackCheckpointId/);
		await tools.get("research_stage")!.execute("m04", { stage: "M04", workspace: root, feedbackStage: "M07", feedbackRunId: runId, feedbackCheckpointId: checkpointId, freshSession: true }, undefined, undefined, ctx);
		const m04RunId = (await service.status(root)).stages.M04.latest!.runId;
		assert.equal((await service.goalStatus(runId, root) as CurrentGoal).lifecycle, "active");
		await tools.get("research_goal")!.execute("refresh", { action: "plan", workspace: root, runId, plan: "Continue same objective", refreshBaseline: true, checkpointId, m04RunId }, undefined, undefined, ctx);
		const refreshed = await service.goalStatus(runId, root) as CurrentGoal;
		assert.equal(refreshed.lifecycle, "active");
		assert.equal(refreshed.m04BaselineRunId, m04RunId);
		assert.deepEqual(refreshed.successCriteria, ["Target evidenced"]);
	} finally { await rm(root, { recursive: true, force: true }); }
});
