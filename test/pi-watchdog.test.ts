import assert from "node:assert/strict";
import test from "node:test";
import { createResearchExtension } from "../src/pi/extension.ts";
import { ResearchService } from "../src/pi/service.ts";

function capture(service: ResearchService, options: Record<string, unknown>) {
  const handlers = new Map<string, Array<(event: any, ctx: any) => unknown>>();
  const api = {
    on(name: string, handler: (event: any, ctx: any) => unknown) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
    registerTool() {},
    registerCommand() {},
  } as any;
  createResearchExtension({ service, ...options })(api);
  return { handlers };
}

test("main agent stall watchdog aborts a top-level stream with no progress", async () => {
  const service = new ResearchService({ defaultWorkspace: process.cwd() });
  const { handlers } = capture(service, { mainAgentStallTimeoutMs: 30, mainAgentStallCheckMs: 5 });
  let aborted = 0;
  const ctx: any = { cwd: process.cwd(), isIdle: () => false, abort: () => { aborted += 1; } };
  const handler = (name: string): ((event: any, ctx: any) => unknown) => {
    const list = handlers.get(name);
    if (list === undefined) throw new Error("missing handler " + name);
    return list[0];
  };
  await handler("agent_start")({ type: "agent_start" }, ctx);
  await handler("message_update")({ type: "message_update" }, ctx);
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(aborted, 0);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(aborted, 1);
  await handler("session_shutdown")({ type: "session_shutdown", reason: "quit" }, ctx);
});
