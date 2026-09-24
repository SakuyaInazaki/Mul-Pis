import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { ResearchService } from "../src/pi/service.ts";
import { Workspace } from "../src/workspace.ts";

test("normal shutdown suspends a new M07 attempt while preserving its goal and run", async (t) => {
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
  assert.equal(run.status, "running");
  const persisted = await service.goalStatus(goal.runId, root) as { lifecycle: string; outcome?: string; executionState?: { attempts: Array<{ state: string }> } };
  assert.equal(persisted.lifecycle, "active");
  assert.equal(persisted.outcome, undefined);
  assert.equal(persisted.executionState?.attempts[0].state, "suspended");
  const visible = await service.status(root);
  assert.equal(visible.stages.M07.latest?.attemptId, "A001");
  assert.equal(visible.stages.M07.latest?.attemptState, "suspended");
  assert.deepEqual(visible.stages.M07.latest?.unresolvedOperationIds, []);
});

test("shutdown with oversized M07 control facts writes a small recovery index without ending the goal", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "pre-rsi-goal-shutdown-overflow-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const ws = new Workspace(root);
  await mkdir(path.join(root, "problem"), { recursive: true });
  await writeFile(path.join(root, "problem", "problem.md"), "问题\n");
  const baseline = await ws.startRun("M04", [{ label: "问题", path: ws.problemFile }]);
  await ws.finishRun(baseline, "completed");
  const service = new ResearchService({ defaultWorkspace: root });
  await service.init(root);
  const improvement = path.join(root, ".agent", "improvement");
  await mkdir(path.join(improvement, "versions", "shutdown-test"), { recursive: true });
  await writeFile(path.join(improvement, "versions", "shutdown-test", "policy.json"), JSON.stringify({ version: 1, maxPromptChars: 8_000, maxInlineFileChars: 1_000, maxAggregateInlineChars: 4_000, maxFeedbackChars: 4_000, overflowMode: "manifest-and-defer" }));
  await writeFile(path.join(improvement, "active.json"), JSON.stringify({ version: 1, versionId: "shutdown-test", promotedAt: "2026-09-23T00:00:00Z", runId: "test" }));
  const goal = await service.goalAction("begin", root, {
    goal: `host must preserve ${"X".repeat(5_000)}`, problemRelation: "直接回答原问题", constraints: ["约束"], successCriteria: ["给出证据"], plan: "执行最小检查",
  }) as { runId: string };
  await service.interruptAllActive("test host shutdown");
  const run = await ws.readRun("M07", goal.runId);
  const persisted = await service.goalStatus(goal.runId, root) as { lifecycle: string; outcome?: string; goal: string; executionState?: { attempts: Array<{ state: string; controlCheckpointPath?: string }> } };
  assert.equal(run.status, "running");
  assert.equal(persisted.lifecycle, "active");
  assert.equal(persisted.outcome, undefined);
  assert.equal(persisted.executionState?.attempts[0].state, "suspended");
  assert.match(persisted.goal, /X{5000}/);
  assert.ok((await readFile(persisted.executionState!.attempts[0].controlCheckpointPath!, "utf8")).length < 4_000);
});

test("host-frozen continuous contract blocks ordinary service stop but accepts host lifecycle receipt", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "pre-rsi-continuous-host-stop-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const ws = new Workspace(root);
  await mkdir(path.join(root, "problem"), { recursive: true });
  await writeFile(ws.problemFile, "问题\n");
  const baseline = await ws.startRun("M04", [{ label: "问题", path: ws.problemFile }]);
  await ws.finishRun(baseline, "completed");
  const service = new ResearchService({ defaultWorkspace: root });
  await service.init(root);
  const goal = await service.goalAction("begin", root, { goal: "持续目标", problemRelation: "原题", constraints: ["不改目标"], successCriteria: ["有证据"], plan: "继续实验" }, undefined, { executionContract: "continuous" }) as { runId: string };
  await assert.rejects(service.goalAction("finish", root, { runId: goal.runId, outcome: "partial", summary: "候选负结果", returnPath: "user", limitations: ["stopReason=dependency_unavailable"], goalChecks: [{ criterion: "有证据", result: "not_run", evidence: [] }] }), /continuous/);
  await assert.rejects(service.goalAction("interrupt", root, { runId: goal.runId, reason: "模型自述硬阻塞" }), /continuous/);
  assert.equal((await ws.readRun("M07", goal.runId)).status, "running");
  const result = await service.hostInterrupt({ workspace: root, runId: goal.runId, reasonKind: "request-aborted", sourceEventId: "host-event-1" }) as { hostStopReceipt?: { sourceEventId?: string; reasonKind?: string } };
  assert.equal(result.hostStopReceipt?.sourceEventId, "host-event-1");
  assert.equal(result.hostStopReceipt?.reasonKind, "request-aborted");
  assert.equal((await ws.readRun("M07", goal.runId)).status, "failed");
});
