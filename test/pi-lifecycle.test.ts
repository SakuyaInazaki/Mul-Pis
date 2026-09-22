import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { ResearchService } from "../src/pi/service.ts";
import { Workspace } from "../src/workspace.ts";

test("normal shutdown archives an active M07 goal instead of leaving the run running", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "pre-rsi-goal-shutdown-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const ws = new Workspace(root);
  await mkdir(path.join(root, "problem"), { recursive: true });
  await writeFile(path.join(root, "problem", "problem.md"), "问题\n");
  const baseline = await ws.startRun("M04", [{ label: "问题", path: ws.problemFile }]);
  await ws.finishRun(baseline, "completed");
  const service = new ResearchService({ defaultWorkspace: root });
  await service.init(root);
  const goal = await service.goalAction("begin", root, {
    goal: "测试目标", problemRelation: "直接回答原问题", constraints: ["约束"], successCriteria: ["给出证据"], plan: "执行最小检查",
  }) as { runId: string };
  await service.interruptAllActive("test host shutdown");
  const run = await ws.readRun("M07", goal.runId);
  assert.equal(run.status, "failed");
  assert.match(run.failures.join("\n"), /host-shutdown/);
  const persisted = await service.goalStatus(goal.runId, root) as { lifecycle: string; outcome?: string };
  assert.equal(persisted.lifecycle, "finished");
  assert.equal(persisted.outcome, "blocked");
});
