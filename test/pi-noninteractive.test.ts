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
  };
  createResearchExtension({ service: service as any })(api as any);
  return { tools, handlers };
}

function context(mode: "json" | "tui") { return { cwd: "/workspace", mode, hasUI: mode === "tui" }; }

test("research_goal decision request is rejected in non-interactive modes", async () => {
  let calls = 0;
  const service = { goalAction: async () => { calls += 1; return {}; } };
  const registered = capture(service);
  const tool = registered.tools.get("research_goal");
  if (tool === undefined) throw new Error("missing research_goal");
  const request = { action: "decision", decisionAction: "request", runId: "r1", question: "q", relatedTaskIds: [] };
  await assert.rejects(tool.execute("c", request, undefined, undefined, context("json")), /非交互模式/);
  assert.equal(calls, 0);
  await tool.execute("c", request, undefined, undefined, context("tui"));
  assert.equal(calls, 1);
});

test("non-interactive system prompt forbids stop-and-ask user options", async () => {
  const service = { goalAction: async () => ({ runId: "r1" }) };
  const registered = capture(service);
  const goal = registered.tools.get("research_goal");
  if (goal === undefined) throw new Error("missing research_goal");
  await goal.execute("b", { action: "begin", goal: "g", problemRelation: "p", constraints: ["c"], successCriteria: ["s"], plan: "plan" }, undefined, undefined, context("json"));
  const before = registered.handlers.get("before_agent_start");
  if (before === undefined || before.length === 0) throw new Error("missing before_agent_start");
  const tuiPrompt = await before[0]({ systemPrompt: "base" }, context("tui"));
  assert.doesNotMatch(JSON.stringify(tuiPrompt ?? {}), /非交互单次模式/);
  const jsonPrompt = await before[0]({ systemPrompt: "base" }, context("json"));
  assert.match(JSON.stringify(jsonPrompt ?? {}), /非交互单次模式/);
});

test("non-interactive finish requires an explicit hard stop reason", async () => {
  const calls: unknown[][] = [];
  const service = { goalAction: async (...args: unknown[]) => { calls.push(args); return {}; } };
  const registered = capture(service);
  const goal = registered.tools.get("research_goal");
  if (goal === undefined) throw new Error("missing research_goal");
  const finish = { action: "finish", runId: "r1", outcome: "partial", summary: "s", returnPath: "user", goalChecks: [] };
  await assert.rejects(goal.execute("f", finish, undefined, undefined, context("json")), /硬停止|stopReason|非交互/);
  assert.equal(calls.length, 0);
  await goal.execute("f", { ...finish, stopReason: "resource_exhausted" }, undefined, undefined, context("json"));
  assert.equal(calls.length, 1);
  await goal.execute("f", finish, undefined, undefined, context("tui"));
  assert.equal(calls.length, 2);
});
