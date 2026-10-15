import assert from "node:assert/strict";
import { mkdtemp, realpath, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { DefaultResourceLoader, SettingsManager, type ExtensionAPI, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createResearchExtension } from "../src/pi/extension.ts";
import { ResearchService } from "../src/pi/service.ts";
import { FakeSessionRunner } from "../src/runner/fake.ts";

function captureExtension(service: ResearchService, improvementServiceFactory?: (workspaceRoot: string) => any, researchImprovementServiceFactory?: (workspaceRoot: string) => any, continuation?: { workspace: string; goalRunId?: string }): { tools: Map<string, ToolDefinition>; commands: Map<string, { handler: (args: string, ctx: any) => Promise<void> }>; handlers: Map<string, Array<(event: any, ctx: any) => unknown>>; activeTools: () => string[] } {
	const tools = new Map<string, ToolDefinition>();
	const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
	const handlers = new Map<string, Array<(event: any, ctx: any) => unknown>>();
	let activeTools = ["read", "bash", "edit", "write"];
	const api = {
		on(name: string, handler: (event: any, ctx: any) => unknown) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
		registerTool(tool: ToolDefinition) { tools.set(tool.name, tool); activeTools.push(tool.name); },
		registerCommand(name: string, command: { handler: (args: string, ctx: any) => Promise<void> }) { commands.set(name, command); },
		getActiveTools() { return [...activeTools]; },
		setActiveTools(names: string[]) { activeTools = [...names]; },
	} as unknown as ExtensionAPI;
	createResearchExtension({ service, improvementServiceFactory, researchImprovementServiceFactory, continuation })(api);
	return { tools, commands, handlers, activeTools: () => [...activeTools] };
}

function toolContext(cwd: string): any { return { cwd }; }

test("research_mission routes local controls and returns only a compact status", async () => {
	const calls: string[] = [];
	const progress = { contract: { id: "local-id", goal: "private original goal" },
		objectiveOutcome: "incomplete", stopReason: "next-task-pending", boundedRuns: [],
		continuation: { unresolvedOperationIds: ["private-operation"],
			pendingAction: { kind: "reconcile-m07-operation", safety: "no-replay-until-reconciled" } } };
	const service = { missionStatus: async (id: string) => { calls.push(`status:${id}`); return progress; },
		missionStart: async () => { calls.push("start"); return progress; },
		missionAdvance: async (action: string, id: string) => { calls.push(`${action}:${id}`); return progress; } } as unknown as ResearchService;
	const tool = captureExtension(service).tools.get("research_mission")!;
	const status = JSON.stringify(await tool.execute("status", { action: "status", missionId: "local-id" },
		undefined, undefined, toolContext("/workspace")));
	assert.match(status, /reconcile-m07-operation/);
	assert.doesNotMatch(status, /private original goal|private-operation/);
	await tool.execute("step", { action: "step", missionId: "local-id" },
		undefined, undefined, toolContext("/workspace"));
	assert.deepEqual(calls, ["status:local-id", "step:local-id"]);
});

test("research_delegate passes approved plan, versioned resources, bounded loop, and lesson output to M07", async () => {
	const seen: unknown[] = [];
	const service = { delegate: async (_runId: string, task: unknown) => { seen.push(task); return { taskId: "task-offline", status: "returned" }; } } as unknown as ResearchService;
	const tool = captureExtension(service).tools.get("research_delegate")!;
	await tool.execute("d", { runId: "goal-offline", objective: "execute approved plan", inputs: ["plan.md", "guide.md"], expectedOutputs: ["lesson.md"], checks: ["evidence recorded"], mode: "execute", planInput: "plan.md", resourceInputs: [{ id: "operator-guide", version: "v2", input: "guide.md" }], executionLoop: { mode: "until-ready" }, lessonDeltaOutput: "lesson.md" }, undefined, undefined, toolContext("/workspace"));
	assert.deepEqual(seen, [{ objective: "execute approved plan", inputs: ["plan.md", "guide.md"], expectedOutputs: ["lesson.md"], checks: ["evidence recorded"], mode: "execute", planInput: "plan.md", resourceInputs: [{ id: "operator-guide", version: "v2", input: "guide.md" }], executionLoop: { mode: "until-ready" }, lessonDeltaOutput: "lesson.md" }]);
});

test("main-session capability guard blocks side-effect tools from the start", async () => {
	const service = {
		status: async () => ({ workspace: "/workspace", stages: {} }),
		init: async () => ({ initialized: true }),
		goalAction: async () => ({ runId: "goal-1", lifecycle: "active" }),
	} as unknown as ResearchService;
	const registered = captureExtension(service);
	const hook = registered.handlers.get("tool_call")![0];
	const bash = { toolName: "bash", input: { command: "true" } };
	assert.equal(((await hook(bash, toolContext("/workspace"))) as { block?: boolean }).block, true);
	await registered.tools.get("research_status")!.execute("status", {}, undefined, undefined, toolContext("/workspace"));
	assert.equal(((await hook(bash, toolContext("/workspace"))) as { block?: boolean }).block, true);
	await registered.tools.get("research_init")!.execute("init", { workspace: "/workspace" }, undefined, undefined, toolContext("/workspace"));
	assert.equal(((await hook(bash, toolContext("/workspace"))) as { block?: boolean }).block, true);
	await registered.tools.get("research_goal")!.execute("begin", { action: "begin", goal: "g", problemRelation: "p", constraints: [], successCriteria: [], plan: "p" }, undefined, undefined, toolContext("/workspace"));
	const blocked = await hook(bash, toolContext("/workspace")) as { block?: boolean; reason?: string };
	assert.equal(blocked.block, true);
	assert.match(blocked.reason ?? "", /M07/);
	// A blocked mutation remains recoverable: Pi may follow the reason and call a workflow tool next.
	assert.equal(await hook({ toolName: "research_delegate", input: {} }, toolContext("/workspace")), undefined);
	assert.equal(await hook({ toolName: "read", input: { path: "result.md" } }, toolContext("/workspace")), undefined);
	assert.equal(await hook({ toolName: "research_stage", input: {} }, toolContext("/workspace")), undefined);
	assert.equal((await hook({ toolName: "research_secret", input: {} }, toolContext("/workspace")) as { block: boolean }).block, true);
	assert.equal(((await hook(bash, toolContext("/different-cwd"))) as { block?: boolean }).block, true);
});

test("failed recovery initialization shuts down the prompt and blocks every tool", async () => {
	const previous = process.env.PRE_RSI_RECOVER_GOAL_RUN_ID;
	const previousDescriptor = process.env.PRE_RSI_RUN_DESCRIPTOR_FILE;
	const root = await realpath(await mkdtemp(path.join(tmpdir(), "pre-rsi-recovery-gate-")));
	const descriptorPath = path.join(root, "run-descriptor.json");
	await writeFile(descriptorPath, JSON.stringify({ version: 1, instanceId: "fresh-instance", attemptId: "A008",
		workspaceId: "workspace-id", goalRunId: "goal-recovery", codeRevision: "test-revision", controlDir: root,
		process: { hostId: "test-host", bootId: "test-boot", pid: 123, processStartToken: "test-start" } }));
	process.env.PRE_RSI_RECOVER_GOAL_RUN_ID = "goal-recovery";
	process.env.PRE_RSI_RUN_DESCRIPTOR_FILE = descriptorPath;
	try {
		const service = {
			goalStatus: async () => ({ executionState: { activeAttemptId: "A007", attempts: Array.from({ length: 7 }) } }),
			hostRecover: async () => { throw new Error("recovery rejected"); },
		} as unknown as ResearchService;
		const registered = captureExtension(service, undefined, undefined, { workspace: "/workspace", goalRunId: "goal-recovery" });
		let aborted = 0;
		let shutdown = 0;
		const ctx = { cwd: "/workspace", mode: "rpc", abort: () => { aborted++; }, shutdown: () => { shutdown++; } };
		await assert.rejects(async () => registered.handlers.get("session_start")![0]({}, ctx), /recovery rejected/);
		assert.deepEqual(registered.activeTools(), []);
		await registered.handlers.get("before_agent_start")![0]({ systemPrompt: "normal prompt" }, ctx);
		assert.equal(aborted, 1);
		assert.equal(shutdown, 1);
		for (const toolName of ["read", "research_goal", "bash"]) {
			const decision = await registered.handlers.get("tool_call")![0]({ toolName, toolCallId: toolName, input: {} }, ctx) as { block?: boolean; terminate?: boolean };
			assert.equal(decision.block, true);
			assert.equal(decision.terminate, true);
		}
	} finally {
		if (previous === undefined) delete process.env.PRE_RSI_RECOVER_GOAL_RUN_ID;
		else process.env.PRE_RSI_RECOVER_GOAL_RUN_ID = previous;
		if (previousDescriptor === undefined) delete process.env.PRE_RSI_RUN_DESCRIPTOR_FILE;
		else process.env.PRE_RSI_RUN_DESCRIPTOR_FILE = previousDescriptor;
	}
});

test("stage tool uses a fresh runner, reports progress, and preserves completion caveat", async () => {
	const root = await realpath(await mkdtemp(path.join(tmpdir(), "pre-rsi-stage-")));
	await mkdir(path.join(root, "problem", "raw"), { recursive: true });
	await writeFile(path.join(root, "problem", "problem.md"), "测试问题\n");
	await writeFile(path.join(root, "research.config.json"), `${JSON.stringify({ roles: { execution: "fake/model", research: "fake/research" }, concurrency: 1 })}\n`);
	const updates: string[] = [];
	const service = new ResearchService({
		defaultWorkspace: root,
		onProgress: (progress) => updates.push(progress.message),
		runnerFactory: () => new FakeSessionRunner(({ spec }) => ({ text: spec.label === "M04-research"
			? '核对后保留候选。\n\n```knowledge-proposals\n[{"op":"create","type":"Q","title":"待复核问题","body":"仍需更多证据","usageDecision":"candidate"}]\n```'
			: "离线结果", reads: [] })),
	});
	await service.init(root);
	const registered = captureExtension(service);
	const tool = registered.tools.get("research_stage")!;
	const result = await tool.execute("call-1", { stage: "M01", workspace: root }, undefined, undefined, toolContext(root));
	assert.match(JSON.stringify(result), /initial-understanding\.md/);
	const run = (await service.status(root)).stages.M01.latest!;
	assert.equal(run.status, "completed");
	assert.ok(updates.length > 0);
	const feedbackFile = path.join(root, "feedback.md");
	await writeFile(feedbackFile, "需要记录尚未解决的问题。\n");
	const m04 = await tool.execute("call-m04", { stage: "M04", workspace: root, feedbackFile, freshSession: true }, undefined, undefined, toolContext(root));
	const m04Summary = JSON.parse((m04.content[0] as { text: string }).text) as { proposalId?: string; snapshotId?: string; outputs?: Array<{ path: string }> };
	assert.equal(m04Summary.proposalId, "P0001");
	assert.equal(m04Summary.snapshotId, "G001");
	assert.ok(m04Summary.outputs?.some((item) => item.path.endsWith("/P0001.json")));
	assert.ok(m04Summary.outputs?.some((item) => item.path.endsWith("/merge.json")));
});

test("research_stage schema invokes the real M08 service path with explicit review inputs", async () => {
	const root = await realpath(await mkdtemp(path.join(tmpdir(), "pre-rsi-m08-extension-")));
	await mkdir(path.join(root, "problem", "raw"), { recursive: true });
	await writeFile(path.join(root, "problem", "problem.md"), "需要审查的原问题\n");
	const artifact = path.join(root, "result.md");
	await writeFile(artifact, "实际成果\n");
	await writeFile(path.join(root, "research.config.json"), `${JSON.stringify({ roles: { reviewer: "fake/reviewer" }, concurrency: 1 })}\n`);
	const service = new ResearchService({ defaultWorkspace: root, runnerFactory: () => new FakeSessionRunner(() => ({ text: "已按固定材料核验", reads: ["materials/001-成果/result.md"] })) });
	await service.init(root);
	const tool = captureExtension(service).tools.get("research_stage")!;
	const output = await tool.execute("m08", {
		stage: "M08", materials: [{ label: "成果", path: artifact, sourceCategory: "result", providedScope: "全文" }],
		selfChecks: [{ id: "scope", instruction: "核对目标与成果", mode: "read-only" }],
		reviewers: [{ id: "external", role: "reviewer", mode: "read-only" }],
		unprovidedScopes: ["未提供现实实验复核"],
	}, undefined, undefined, toolContext(root));
	assert.match(JSON.stringify(output), /review-bundle\.md/);
	assert.match(JSON.stringify(output), /scope/);
	assert.match(JSON.stringify(output), /external/);
	assert.match(JSON.stringify(output), /coverage/);
	const status = await service.status(root);
	assert.equal(status.stages.M08.latest?.status, "completed");
});

test("Pi DefaultResourceLoader loads the actual extensions/research.ts entrypoint", async () => {
	const root = await realpath(await mkdtemp(path.join(tmpdir(), "pre-rsi-file-loader-")));
	const agentDir = path.join(root, "agent");
	await mkdir(agentDir, { recursive: true });
	const loader = new DefaultResourceLoader({
		cwd: root, agentDir, settingsManager: SettingsManager.inMemory({}), noSkills: true,
		noPromptTemplates: true, noThemes: true, noContextFiles: true,
		additionalExtensionPaths: [path.resolve("extensions/research.ts")],
	});
	await loader.reload();
	const loaded = loader.getExtensions();
	assert.equal(loaded.errors.length, 0);
	assert.equal(loaded.extensions.length, 1);
	assert.deepEqual([...loaded.extensions[0].tools.keys()].sort(), ["research_delegate", "research_goal", "research_improve", "research_init", "research_method_improve", "research_mission", "research_review", "research_stage", "research_status"]);
});
