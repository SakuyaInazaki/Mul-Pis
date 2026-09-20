import assert from "node:assert/strict";
import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { DefaultResourceLoader, SettingsManager, type ExtensionAPI, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createResearchExtension } from "../src/pi/extension.ts";
import { ResearchService } from "../src/pi/service.ts";
import { FakeSessionRunner } from "../src/runner/fake.ts";

function captureExtension(service: ResearchService): { tools: Map<string, ToolDefinition>; commands: Map<string, { handler: (args: string, ctx: any) => Promise<void> }>; handlers: Map<string, Array<(event: any, ctx: any) => unknown>> } {
	const tools = new Map<string, ToolDefinition>();
	const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
	const handlers = new Map<string, Array<(event: any, ctx: any) => unknown>>();
	const api = {
		on(name: string, handler: (event: any, ctx: any) => unknown) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
		registerTool(tool: ToolDefinition) { tools.set(tool.name, tool); },
		registerCommand(name: string, command: { handler: (args: string, ctx: any) => Promise<void> }) { commands.set(name, command); },
	} as unknown as ExtensionAPI;
	createResearchExtension({ service })(api);
	return { tools, commands, handlers };
}

function toolContext(cwd: string): any { return { cwd }; }

test("extension registration is inert and exposes bounded tools", async () => {
	const root = await mkdtemp(path.join(tmpdir(), "pre-rsi-extension-"));
	const service = new ResearchService({ defaultWorkspace: root });
	const registered = captureExtension(service);
	assert.deepEqual([...registered.tools.keys()].sort(), ["research_delegate", "research_goal", "research_init", "research_review", "research_stage", "research_status"]);
	assert.equal(registered.commands.has("research"), true);
	assert.equal((await service.status(root)).initialized, false);
});

test("status works without model config and does not initialize the workspace", async () => {
	const root = await mkdtemp(path.join(tmpdir(), "pre-rsi-status-"));
	const service = new ResearchService({ defaultWorkspace: root });
	const status = await service.status();
	assert.equal(status.configPresent, false);
	assert.equal(status.initialized, false);
	assert.equal(status.stages.M01.count, 0);
	assert.match(status.limitations.join("\n"), /不会自动重跑/);
});

test("tool workspace defaults to each execute ctx.cwd instead of extension construction cwd", async () => {
	const defaultRoot = await mkdtemp(path.join(tmpdir(), "pre-rsi-default-"));
	const currentRoot = await mkdtemp(path.join(tmpdir(), "pre-rsi-current-"));
	const registered = captureExtension(new ResearchService({ defaultWorkspace: defaultRoot }));
	const output = await registered.tools.get("research_status")!.execute("status", {}, undefined, undefined, toolContext(currentRoot));
	assert.match(JSON.stringify(output), new RegExp(currentRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
	const explicit = await registered.tools.get("research_status")!.execute("status", { workspace: defaultRoot }, undefined, undefined, toolContext(currentRoot));
	assert.match(JSON.stringify(explicit), new RegExp(defaultRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("stage tool uses a fresh runner, reports progress, and preserves completion caveat", async () => {
	const root = await mkdtemp(path.join(tmpdir(), "pre-rsi-stage-"));
	await mkdir(path.join(root, "problem", "raw"), { recursive: true });
	await writeFile(path.join(root, "problem", "problem.md"), "测试问题\n");
	await writeFile(path.join(root, "research.config.json"), `${JSON.stringify({ roles: { execution: "fake/model" }, concurrency: 1 })}\n`);
	const updates: string[] = [];
	const service = new ResearchService({
		defaultWorkspace: root,
		onProgress: (progress) => updates.push(progress.message),
		runnerFactory: () => new FakeSessionRunner(() => ({ text: "离线结果", reads: [] })),
	});
	await service.init(root);
	const registered = captureExtension(service);
	const tool = registered.tools.get("research_stage")!;
	const result = await tool.execute("call-1", { stage: "M01", workspace: root }, undefined, undefined, toolContext(root));
	assert.match(JSON.stringify(result), /initial-understanding\.md/);
	const run = (await service.status(root)).stages.M01.latest!;
	assert.equal(run.status, "completed");
	assert.ok(updates.some((message) => message.includes("M01：正在创建隔离会话")));
	assert.ok(updates.some((message) => message.includes("完成不等于科学判断已通过")));
});

test("failed research operation does not activate P07; success, off, and session start control activation", async () => {
	const root = await mkdtemp(path.join(tmpdir(), "pre-rsi-activation-"));
	await mkdir(path.join(root, "problem", "raw"), { recursive: true });
	await writeFile(path.join(root, "problem", "problem.md"), "问题\n");
	const service = new ResearchService({ defaultWorkspace: root, runnerFactory: () => new FakeSessionRunner(() => ({ text: "ok", reads: [] })) });
	await service.init(root);
	const registered = captureExtension(service);
	await assert.rejects(registered.tools.get("research_stage")!.execute("bad", { stage: "M01" }, undefined, undefined, toolContext(root)), /缺少/);
	const before = registered.handlers.get("before_agent_start")![0];
	assert.equal(await before({ systemPrompt: "base" }, toolContext(root)), undefined);
	await registered.tools.get("research_goal")!.execute("begin", { action: "begin", goal: "目标", problemRelation: "关系", constraints: ["约束"], successCriteria: ["标准"], plan: "计划", exploratory: true }, undefined, undefined, toolContext(root));
	assert.match(JSON.stringify(await before({ systemPrompt: "base" }, toolContext(root))), /P07|研究/);
	await registered.commands.get("research")!.handler("off", { cwd: root, ui: { notify() {} } });
	assert.equal(await before({ systemPrompt: "base" }, toolContext(root)), undefined);
	await registered.tools.get("research_goal")!.execute("plan", { action: "plan", runId: (await service.status(root)).stages.M07.latest!.runId, plan: "新计划" }, undefined, undefined, toolContext(root));
	await registered.handlers.get("session_start")![0]({}, toolContext(root));
	assert.equal(await before({ systemPrompt: "base" }, toolContext(root)), undefined);
});

test("symlink aliases share the same mutation lock", async () => {
	const root = await mkdtemp(path.join(tmpdir(), "pre-rsi-lock-"));
	const alias = `${root}-alias`;
	await symlink(root, alias);
	await mkdir(path.join(root, "problem", "raw"), { recursive: true });
	await writeFile(path.join(root, "problem", "problem.md"), "问题\n");
	await writeFile(path.join(root, "research.config.json"), `${JSON.stringify({ roles: { execution: "fake/model" }, concurrency: 1 })}\n`);
	let release!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	const service = new ResearchService({ defaultWorkspace: root, runnerFactory: () => new FakeSessionRunner(async () => { await gate; return { text: "ok", reads: [] }; }) });
	await service.init(root);
	const first = service.runStage({ stage: "M01", workspace: root });
	await new Promise((resolve) => setTimeout(resolve, 10));
	await assert.rejects(service.runStage({ stage: "M01", workspace: alias }), /已有同步研究操作/);
	release();
	await first;
});

test("Pi DefaultResourceLoader loads the inline extension without prompting or network", async () => {
	const root = await mkdtemp(path.join(tmpdir(), "pre-rsi-loader-"));
	const agentDir = path.join(root, "agent");
	await mkdir(agentDir, { recursive: true });
	const loader = new DefaultResourceLoader({
		cwd: root,
		agentDir,
		settingsManager: SettingsManager.inMemory({}),
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		extensionFactories: [{ name: "pre-rsi", factory: createResearchExtension({ defaultWorkspace: root }) }],
	});
	await loader.reload();
	const loaded = loader.getExtensions();
	assert.equal(loaded.errors.length, 0);
	assert.equal(loaded.extensions.length, 1);
	assert.deepEqual([...loaded.extensions[0].tools.keys()].sort(), ["research_delegate", "research_goal", "research_init", "research_review", "research_stage", "research_status"]);
});

test("Pi DefaultResourceLoader loads the actual extensions/research.ts entrypoint", async () => {
	const root = await mkdtemp(path.join(tmpdir(), "pre-rsi-file-loader-"));
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
	assert.deepEqual([...loaded.extensions[0].tools.keys()].sort(), ["research_delegate", "research_goal", "research_init", "research_review", "research_stage", "research_status"]);
});
