import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { bindConsoleDescriptorToGoal, parseConsoleWorkflowRequest } from "../../src/pi/console-bridge.ts";
import { readCurrentProcessIdentity } from "../../src/runtime/process-identity.ts";
import { createResearchExtension } from "../../src/pi/extension.ts";
import { ResearchService } from "../../src/pi/service.ts";
import { FakeSessionRunner } from "../../src/runner/fake.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { CurrentGoal } from "../../src/m07/types.ts";

test("workflow bridge accepts current stage fields and rejects obsolete strategy controls", () => {
	const base = { version: 1, requestId: randomUUID(), instanceId: randomUUID(), workspaceId: randomUUID(),
		workspace: "/tmp/workspace", attemptId: "A001" };
	const parsed = parseConsoleWorkflowRequest({ ...base, action: { kind: "stage", request: { stage: "M04",
		feedbackStage: "M07", feedbackRunId: "g", requiredM07ReadPaths: ["stages/M07/g/checkpoints/C001/feedback.md"] } } });
	assert.equal(parsed.action.kind, "stage");
	assert.throws(() => parseConsoleWorkflowRequest({ ...base, action: { kind: "stage", request: { stage: "M07" } } }), /invalid workflow stage/);
	assert.throws(() => parseConsoleWorkflowRequest({ ...base, action: { kind: "stage", request: { stage: "M04", reprocessAll: true } } }), /unexpected stage field/);
});

test("goal binding installs the persisted store identity only for the same Pi process and source", async (t) => {
	const identity = await readCurrentProcessIdentity().catch(() => undefined);
	if (!identity) { t.skip("precise process identity is unavailable"); return; }
	const root = await mkdtemp(path.join(tmpdir(), "workflow-console-bridge-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const controlDir = path.join(root, "private");
	await mkdir(controlDir, { mode: 0o700 });
	const descriptorFile = path.join(controlDir, "run-descriptor.json");
	const instanceId = randomUUID(), revision = "builtin:" + "f".repeat(40), storeId = randomUUID();
	const descriptor = { version: 1, instanceId, attemptId: "A001", workspaceId: root,
		codeRevision: revision, controlDir, process: identity };
	await writeFile(descriptorFile, JSON.stringify(descriptor), { mode: 0o600 });
	const target = { ...descriptor, goalRunId: "g", workspaceId: storeId, controlDir: path.join(root, "stages", "M07", "g") };
	const goal = { runId: "g", executionState: { activeAttemptId: "A001", attempts: [{ id: "A001", runDescriptor: target }] } } as CurrentGoal;
	await bindConsoleDescriptorToGoal(goal, { controlDir, descriptorFile, processIdentity: async () => identity });
	const bound = JSON.parse(await readFile(descriptorFile, "utf8"));
	assert.equal(bound.workspaceId, storeId);
	assert.equal(bound.goalRunId, "g");
	assert.equal(bound.attemptId, "A001");
	await assert.rejects(bindConsoleDescriptorToGoal({ ...goal, executionState: { ...goal.executionState!, attempts: [{
		...goal.executionState!.attempts[0], runDescriptor: { ...target, codeRevision: "other" } }] } },
		{ controlDir, descriptorFile, processIdentity: async () => identity }), /does not belong/);
});

test("real service and extension bridge persist one console goal and return its status without a model session", async (t) => {
	const identity = await readCurrentProcessIdentity().catch(() => undefined);
	if (!identity) { t.skip("precise process identity is unavailable"); return; }
	const workspace = await realpath(await mkdtemp(path.join(tmpdir(), "workflow-console-service-")));
	t.after(() => rm(workspace, { recursive: true, force: true }));
	await mkdir(path.join(workspace, "problem"), { recursive: true });
	await writeFile(path.join(workspace, "problem", "problem.md"), "A bounded offline question.\n");
	await writeFile(path.join(workspace, "research.config.json"), JSON.stringify({ roles: {
		research: "fake/research", execution: "fake/execution", reviewer: "fake/reviewer" }, concurrency: 1, tools: {} }));
	const runner = new FakeSessionRunner(() => { throw new Error("this control-only test must not start a model session"); });
	const service = new ResearchService({ defaultWorkspace: workspace, runnerFactory: () => runner });
	await service.init(workspace);
	const instanceId = randomUUID(), controlDir = path.join(workspace, ".agent", "console", "instances", instanceId);
	const descriptorFile = path.join(controlDir, "run-descriptor.json");
	await mkdir(path.join(controlDir, "requests"), { recursive: true, mode: 0o700 });
	await mkdir(path.join(controlDir, "responses"), { mode: 0o700 });
	const codeRevision = "builtin:offline-integration";
	await writeFile(descriptorFile, JSON.stringify({ version: 1, instanceId, attemptId: "A001", workspaceId: workspace,
		codeRevision, controlDir, processGroupId: process.pid, process: identity }), { mode: 0o600 });
	await writeFile(path.join(workspace, ".agent", "console", "owner.lock"), JSON.stringify({ version: 1, kind: "console", instanceId,
		process: identity }), { mode: 0o600 });
	const envKeys = ["MUL_PIS_CONSOLE_CONTROL_DIR", "PRE_RSI_RUN_DESCRIPTOR_FILE", "PRE_RSI_RUN_INSTANCE_ID", "PRE_RSI_CODE_REVISION", "PRE_RSI_CONTINUATION_WORKSPACE", "PRE_RSI_SOURCE_ROOT", "PRE_RSI_ACTIVE_H_VERSION_ID"] as const;
	const prior = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
	delete process.env.PRE_RSI_SOURCE_ROOT;
	delete process.env.PRE_RSI_ACTIVE_H_VERSION_ID;
	Object.assign(process.env, { MUL_PIS_CONSOLE_CONTROL_DIR: controlDir, PRE_RSI_RUN_DESCRIPTOR_FILE: descriptorFile,
		PRE_RSI_RUN_INSTANCE_ID: instanceId, PRE_RSI_CODE_REVISION: codeRevision, PRE_RSI_CONTINUATION_WORKSPACE: workspace });
	t.after(() => { for (const key of envKeys) if (prior[key] === undefined) delete process.env[key]; else process.env[key] = prior[key]; });
	const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
	let activeTools: string[] = ["read", "bash", "edit", "write"];
	const api = { on() {}, registerTool() {}, registerCommand(name: string, command: { handler: (args: string, ctx: unknown) => Promise<void> }) {
		commands.set(name, command); }, getActiveTools: () => activeTools, setActiveTools(names: string[]) { activeTools = names; }, appendEntry() {} } as unknown as ExtensionAPI;
	createResearchExtension({ service, continuation: { workspace } })(api);
	const command = commands.get("workflow-console");
	assert(command, "the real extension must register the console command after descriptor bootstrap");
	const invoke = async (action: unknown, goalRunId?: string): Promise<Record<string, unknown>> => {
		const descriptor = JSON.parse(await readFile(descriptorFile, "utf8")) as { workspaceId: string; attemptId: string };
		const requestId = randomUUID();
		await writeFile(path.join(controlDir, "requests", `${requestId}.json`), JSON.stringify({ version: 1, requestId,
			instanceId, workspaceId: descriptor.workspaceId, workspace, attemptId: descriptor.attemptId,
			...(goalRunId ? { goalRunId } : {}), action }), { mode: 0o600 });
		await command.handler(requestId, { cwd: workspace, isIdle: () => true, mode: "rpc" });
		return JSON.parse(await readFile(path.join(controlDir, "responses", `${requestId}.json`), "utf8")) as Record<string, unknown>;
	};
	const begun = await invoke({ kind: "begin", input: { goal: "Check the bounded question", problemRelation: "direct",
		constraints: ["preserve evidence"], successCriteria: ["answer checked"], plan: "inspect evidence", exploratory: true } });
	assert.equal(begun.ok, true, JSON.stringify(begun));
	const runId = (begun.data as { runId?: string }).runId;
	assert(runId);
	const goal = await service.goalStatus(runId, workspace) as CurrentGoal;
	assert.equal(goal.lifecycle, "active");
	assert.equal(goal.executionState?.attempts[0]?.runDescriptor.instanceId, instanceId);
	const descriptor = JSON.parse(await readFile(descriptorFile, "utf8"));
	assert.equal(descriptor.goalRunId, runId);
	assert.equal(descriptor.workspaceId, goal.executionState?.attempts[0]?.runDescriptor.workspaceId);
	assert(activeTools.includes("research_goal") && !activeTools.includes("bash"), "console begin activates research-only tool authority");
	const status = await invoke({ kind: "status", runId }, runId);
	assert.equal(status.ok, true, JSON.stringify(status));
	assert.equal((status.data as { lifecycle?: string }).lifecycle, "active");
	assert.equal((status.data as { outcome?: string }).outcome, undefined);
	const consoleEnv = process.env.MUL_PIS_CONSOLE_CONTROL_DIR;
	delete process.env.MUL_PIS_CONSOLE_CONTROL_DIR;
	try {
		await assert.rejects(service.goalAction("checkpoint", workspace, { runId }), /already owned/);
	} finally { if (consoleEnv === undefined) delete process.env.MUL_PIS_CONSOLE_CONTROL_DIR; else process.env.MUL_PIS_CONSOLE_CONTROL_DIR = consoleEnv; }
	assert.equal(runner.created.length, 0);
});
