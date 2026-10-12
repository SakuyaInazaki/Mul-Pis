import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createResearchExtension } from "../src/pi/extension.ts";
import type { ResearchService } from "../src/pi/service.ts";

function goalTool(service: ResearchService, continuation?: { workspace: string; goalRunId: string }): ToolDefinition {
	const tools = new Map<string, ToolDefinition>();
	const api = {
		on() {},
		registerTool(tool: ToolDefinition) { tools.set(tool.name, tool); },
		registerCommand() {},
		getActiveTools() { return ["read"]; },
		setActiveTools() {},
		appendEntry() {},
	} as unknown as ExtensionAPI;
	createResearchExtension({ service, continuation })(api);
	const tool = tools.get("research_goal");
	assert.ok(tool);
	return tool;
}

function call(tool: ToolDefinition, params: Record<string, unknown>, signal?: AbortSignal, cwd = "/bound", mode = "rpc") {
	return tool.execute("reconcile-test", params as never, signal, undefined, { cwd, mode } as never);
}

test("research_goal reconcile delegates only exact host-owned operation identity", async () => {
	const calls: unknown[][] = [];
	const service = {
		reconcileOperation: async (...args: unknown[]) => { calls.push(args); return { operationId: "op-1", state: "reconciled" }; },
	} as unknown as ResearchService;
	const tool = goalTool(service);
	const signal = new AbortController().signal;
	const response = await call(tool, { action: "reconcile", workspace: "./research", runId: "goal-1", operationId: "op-1" }, signal, "/work");
	assert.deepEqual(calls, [["goal-1", "op-1", "/work/research", signal]]);
	assert.match(JSON.stringify(response), /operationId/);
});

test("research_goal reconcile requires operationId and rejects model-supplied verdicts or unrelated fields", async () => {
	let dispatched = 0;
	const service = { reconcileOperation: async () => { dispatched++; return {}; } } as unknown as ResearchService;
	const tool = goalTool(service);
	for (const params of [
		{ action: "reconcile", runId: "goal-1" },
		{ action: "reconcile", runId: "goal-1", operationId: "" },
		{ action: "reconcile", runId: "goal-1", operationId: "  " },
		{ action: "reconcile", runId: "goal-1", operationId: "op-1", evidencePath: "/tmp/forged.json" },
		{ action: "reconcile", runId: "goal-1", operationId: "op-1", observedStatus: "completed" },
		{ action: "reconcile", runId: "goal-1", operationId: "op-1", status: "completed" },
		{ action: "reconcile", runId: "goal-1", operationId: "op-1", goal: "replace target" },
		{ action: "reconcile", runId: "goal-1", operationId: "op-1", operationReconciler: () => ({}) },
		{ action: "status", runId: "goal-1", operationId: "op-1" },
	]) {
		await assert.rejects(call(tool, params), /reconcile|operationId|unrelated/i);
	}
	assert.equal(dispatched, 0);
});

test("continuous reconcile mutates only its bound workspace and goal while status remains read-only", async () => {
	const reconciled: unknown[][] = [];
	const statuses: unknown[][] = [];
	const service = {
		reconcileOperation: async (...args: unknown[]) => { reconciled.push(args); return {}; },
		goalStatus: async (...args: unknown[]) => { statuses.push(args); return { runId: args[0] }; },
	} as unknown as ResearchService;
	const tool = goalTool(service, { workspace: "/bound", goalRunId: "goal-1" });
	await assert.rejects(call(tool, { action: "reconcile", runId: "goal-2", operationId: "op-1" }), /continuation|绑定/);
	await assert.rejects(call(tool, { action: "reconcile", workspace: "/other", runId: "goal-1", operationId: "op-1" }), /continuation|绑定/);
	assert.equal(reconciled.length, 0);
	await call(tool, { action: "reconcile", runId: "goal-1", operationId: "op-1" });
	assert.deepEqual(reconciled[0]?.slice(0, 3), ["goal-1", "op-1", "/bound"]);
	await call(tool, { action: "status", workspace: "/other", runId: "goal-2" });
	assert.deepEqual(statuses, [["goal-2", "/other"]]);
});
