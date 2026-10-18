import assert from "node:assert/strict";
import test from "node:test";
import { createResearchExtension } from "../src/pi/extension.ts";

function capture(service: unknown) {
  const tools = new Map<string, any>();
  const handlers = new Map<string, any[]>();
  const api = {
    on(name: string, handler: any) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
    registerTool(tool: any) { tools.set(tool.name, tool); },
    registerCommand() {},
    getActiveTools() { return []; },
    setActiveTools() {},
  };
  createResearchExtension({ service: service as any })(api as any);
  return { tools, handlers };
}

function context(mode: "json" | "rpc" | "tui") { return { cwd: "/workspace", mode, hasUI: mode === "tui" }; }

test("research_goal decision request is rejected in non-interactive modes", async () => {
  let calls = 0;
  const service = { goalAction: async () => { calls += 1; return {}; } };
  const registered = capture(service);
  const tool = registered.tools.get("research_goal");
  if (tool === undefined) throw new Error("missing research_goal");
  const request = { action: "decision", decisionAction: "request", runId: "r1", question: "q", relatedTaskIds: [] };
  await assert.rejects(tool.execute("c", request, undefined, undefined, context("json")), /非交互模式/);
  await assert.rejects(tool.execute("c", request, undefined, undefined, context("rpc")), /非交互模式/);
  assert.equal(calls, 0);
  await tool.execute("c", request, undefined, undefined, context("tui"));
  assert.equal(calls, 1);
});

test("non-interactive finish requires an explicit hard stop reason", async () => {
  const calls: unknown[][] = [];
  const service = { goalAction: async (...args: unknown[]) => { calls.push(args); return {}; } };
  const registered = capture(service);
  const goal = registered.tools.get("research_goal");
  if (goal === undefined) throw new Error("missing research_goal");
  const finish = { action: "finish", runId: "r1", outcome: "partial", summary: "s", returnPath: "user", goalChecks: [] };
  await assert.rejects(goal.execute("f", finish, undefined, undefined, context("json")), /硬停止|stopReason|非交互/);
  await assert.rejects(goal.execute("f", finish, undefined, undefined, context("rpc")), /硬停止|stopReason|非交互/);
  await assert.rejects(goal.execute("f", { ...finish, stopReason: "resource_exhausted" }, undefined, undefined, context("json")), /resource_exhausted/);
  assert.equal(calls.length, 0);
  await goal.execute("f", { ...finish, stopReason: "dependency_unavailable" }, undefined, undefined, context("json"));
  assert.equal(calls.length, 1);
  await goal.execute("f", finish, undefined, undefined, context("tui"));
  assert.equal(calls.length, 2);
});
