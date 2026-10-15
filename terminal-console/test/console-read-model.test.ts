import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { WorkflowReader, discoverWorkflowWorkspaces } from "../src/console/read-model.ts";

async function fixture(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "workflow-console-"));
  await writeFile(path.join(root, "research.config.json"), "{}\n");
  return root;
}
async function save(root: string, relative: string, value: unknown): Promise<string> {
  const file = path.join(root, relative); await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, typeof value === "string" ? value : JSON.stringify(value)); return file;
}

test("reads selected M07 goal, task ancestry, separate task states and stale heartbeat", async () => {
  const root = await fixture();
  try {
    const runId = "r1", report = await save(root, "stages/M07/r1/report.md", "hello\x1b[31m red\x1b[0m\u202e world\n");
    await save(root, "stages/M07/r1/run.json", { stage: "M07", runId, status: "running", startedAt: "2026-01-01T00:00:00Z", inputs: [], sessions: [], outputs: [], failures: [], remarks: [] });
    await save(root, "stages/M07/r1/goal.json", {
      runId, lifecycle: "active", goal: "实际研究目标", tasks: [
        { taskId: "T1", objective: "采集材料", status: "accepted", createdAt: "2026-01-01T00:01:00Z", returnedAt: "2026-01-01T00:02:00Z", reportPath: report, toolLog: [],
          review: { at: "2026-01-01T00:03:00Z", checks: [{ criterion: "原文已核对", result: "passed", evidence: [report] }], artifacts: [] } },
        { taskId: "T2", parentTaskId: "T1", objective: "核对", status: "unknown", createdAt: "2026-01-01T00:04:00Z", toolLog: [], session: { id: "s2", label: "T2", role: "execution", model: "model-x" } },
      ], decisions: [], goalChecks: [{ criterion: "完成", result: "not_run", evidence: [] }],
      executionState: { activeAttemptId: "a1", attempts: [{ id: "a1", state: "running" }] },
    });
    const reader = new WorkflowReader(root);
    const snap = await reader.read({ now: Date.parse("2026-01-01T00:05:00Z") });
    assert.equal(snap.currentStage, "M07");
    assert.equal(snap.goal?.tasks.accepted, 1);
    assert.equal(snap.goal?.tasks.unknown, 1);
    assert.equal(snap.nodes.find(x => x.id === "task:r1:T2")?.parentId, "task:r1:T1");
    assert.equal(snap.nodes.find(x => x.id === "session:s2")?.parentId, "task:r1:T2");
    assert.equal(snap.nodes.find(x => x.id === "run:M07:r1")?.status, "unknown");
    assert.deepEqual(snap.goal?.checks, { total: 1, passed: 0, failed: 0, notRun: 1 });
    const preview = await reader.preview("task:r1:T1", "output");
    assert(preview.join("\n").includes("hello red world"));
    assert(!preview.join("\n").includes("\x1b"));
    assert(!preview.join("\n").includes("\u202e"));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("M07 summary reads registered checkpoint scope and baseline without inferring completion", async () => {
  const root = await fixture();
  try {
    await save(root, "stages/M07/g/run.json", { stage: "M07", runId: "g", status: "running", startedAt: "2026-01-01T00:00:00Z", inputs: [], sessions: [], outputs: [], failures: [], remarks: [] });
    const frozenPath = await save(root, "stages/M07/g/checkpoints/C001/goal.json", { runId: "g", updatedAt: "2026-01-01T00:01:00Z", checkpointScope: { selectedTaskIds: ["T001"], omittedTaskIds: ["T002"] } });
    await save(root, "stages/M07/g/goal.json", { runId: "g", lifecycle: "active", goal: "目标", tasks: [],
      decisions: [{ id: "D1", status: "open", question: "是否继续", relatedTaskIds: [], requestedAt: "2026-01-01T00:02:00Z" }],
      formalBaseline: true, m04BaselineRunId: "m2", knowledgeSnapshot: "G002",
      baselineHistory: [{ at: "2026-01-01T00:00:00Z", m04RunId: "m1", knowledgeSnapshot: "G001" }, { at: "2026-01-01T00:03:00Z", m04RunId: "m2", knowledgeSnapshot: "G002" }],
      checkpoints: [{ id: "C001", createdAt: "2026-01-01T00:01:00Z", rootDir: path.join(root, "stages/M07/g/checkpoints/C001"), sourceGoalUpdatedAt: "2026-01-01T00:01:00Z", feedbackStatus: "indexed" }],
      feedbackStatus: "pending", returnPath: "M04" });
    const reader = new WorkflowReader(root);
    const snap = await reader.read({ goalRunId: "g" });
    assert.equal(snap.goal?.openDecisions, 1);
    assert.equal(snap.goal?.m04BaselineRunId, "m2");
    assert.equal(snap.goal?.knowledgeSnapshot, "G002");
    assert.equal(snap.goal?.feedbackStatus, "pending");
    assert.equal(snap.goal?.returnPath, "M04");
    assert.deepEqual(snap.goal?.checkpoints?.[0]?.selectedTaskIds, ["T001"]);
    assert.deepEqual(snap.goal?.checkpoints?.[0]?.omittedTaskIds, ["T002"]);
    assert.equal(snap.goal?.outcome, undefined);
    await writeFile(frozenPath, JSON.stringify({ runId: "g", updatedAt: "2026-01-01T00:01:00Z", checkpointScope: { selectedTaskIds: ["T003"], omittedTaskIds: ["T002"] } }));
    await utimes(frozenPath, new Date("2026-01-02T00:00:00Z"), new Date("2026-01-02T00:00:00Z"));
    assert.deepEqual((await reader.read({ goalRunId: "g" })).goal?.checkpoints?.[0]?.selectedTaskIds, ["T003"]);
    await writeFile(frozenPath, "{invalid json");
    const invalid = await reader.read({ goalRunId: "g" });
    assert.equal(invalid.goal?.checkpoints?.[0]?.selectedTaskIds, undefined);
    assert(invalid.warnings.some(w => w.includes("C001") && w.includes("范围不可读取")));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("bounds preview to registered confined paths and discovers only direct workspaces", async () => {
  const root = await fixture();
  try {
    const child = path.join(root, "workspaces", "one");
    await mkdir(child, { recursive: true }); await writeFile(path.join(child, "research.config.json"), "{}\n");
    const nested = path.join(root, "workspaces", "two", "nested");
    await mkdir(nested, { recursive: true }); await writeFile(path.join(nested, "research.config.json"), "{}\n");
    assert.deepEqual(await discoverWorkflowWorkspaces(root), [root, child]);
    await save(root, "stages/M01/a/run.json", { stage: "M01", runId: "a", status: "completed", startedAt: "2026-01-01T00:00:00Z", finishedAt: "2026-01-01T00:01:00Z", inputs: [], sessions: [], outputs: [{ label: "secret", path: path.join(root, "..", "outside.txt") }], failures: [], remarks: [] });
    const reader = new WorkflowReader(root);
    await reader.read({ stage: "M01" });
    assert((await reader.preview("run:M01:a", "output")).join("\n").includes("路径不在工作区内"));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("fresh stage telemetry takes focus while an active M07 goal remains visible", async () => {
  const root = await fixture();
  try {
    const base = { status: "running", inputs: [], sessions: [], outputs: [], failures: [], remarks: [] };
    await save(root, "stages/M07/g/run.json", { ...base, stage: "M07", runId: "g", startedAt: "2026-01-01T00:00:00Z" });
    await save(root, "stages/M07/g/goal.json", { runId: "g", lifecycle: "active", goal: "研究问题", tasks: [], decisions: [], goalChecks: [] });
    await save(root, "stages/M04/m/run.json", { ...base, stage: "M04", runId: "m", startedAt: "2026-01-01T00:01:00Z" });
    await save(root, ".agent/telemetry/t.json", { version: 1, id: "main", kind: "controller", label: "M04", stage: "M04", runId: "m", activity: "active", startedAt: "2026-01-01T00:01:00Z", lastSeenAt: "2026-01-01T00:02:00Z", tools: [] });
    const snap = await new WorkflowReader(root).read({ now: Date.parse("2026-01-01T00:02:05Z") });
    assert.equal(snap.currentStage, "M04");
    assert.equal(snap.goal?.id, "g");
    assert.equal(snap.runs.find(r => r.stage === "M07")?.status, "unknown");
    assert.equal(snap.runs.find(r => r.stage === "M04")?.status, "running");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("explicit stage selection excludes an unrelated active M07 goal, including empty stages", async () => {
  const root = await fixture();
  try {
    await save(root, "stages/M07/g/run.json", { stage: "M07", runId: "g", status: "running", startedAt: "2026-01-01T00:00:00Z", inputs: [], sessions: [], outputs: [], failures: [], remarks: [] });
    await save(root, "stages/M07/g/goal.json", { runId: "g", lifecycle: "active", goal: "当前目标", tasks: [
      { taskId: "T001", objective: "不能出现在其他阶段", status: "returned", createdAt: "2026-01-01T00:00:00Z", toolLog: [] },
    ], decisions: [], goalChecks: [] });
    await save(root, "stages/M01/r/run.json", { stage: "M01", runId: "r", status: "completed", startedAt: "2026-01-01T00:00:00Z", inputs: [], sessions: [], outputs: [], failures: [], remarks: [] });
    const reader = new WorkflowReader(root);
    for (const stage of ["M01", "M09"]) {
      const snap = await reader.read({ stage, now: Date.parse("2026-01-01T00:01:00Z") });
      assert.equal(snap.currentStage, stage);
      assert.equal(snap.goal, undefined);
      assert(!snap.nodes.some(n => n.stage === "M07" && n.kind !== "stage"), stage);
      assert(!snap.nodes.some(n => n.kind === "task"), stage);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("M07 maps task heartbeats, preserves tool states and counts unrun criteria", async () => {
  const root = await fixture();
  try {
    await save(root, "stages/M07/g/run.json", { stage: "M07", runId: "g", status: "running", startedAt: "2026-01-01T00:00:00Z", inputs: [], sessions: [], outputs: [], failures: [], remarks: [] });
    await save(root, "stages/M07/g/goal.json", { runId: "g", lifecycle: "active", goal: "目标", successCriteria: ["A", "B"], tasks: [
      { taskId: "T1", objective: "执行", status: "running", createdAt: "2026-01-01T00:00:00Z", session: { id: "live", label: "live", model: "m" }, toolLog: [
        { name: "read", status: "running", ok: false }, { name: "bash", status: "error", ok: false, error: "退出失败" }, { name: "write", status: "returned", ok: true }, { name: "legacy", ok: true },
      ] },
      { taskId: "T2", objective: "旧任务", status: "running", createdAt: "2026-01-01T00:00:00Z", session: { id: "old", label: "old", model: "m" }, toolLog: [{ name: "old-running", status: "running", ok: false }] },
    ], decisions: [] });
    await save(root, ".agent/telemetry/live.json", { version: 1, id: "live", kind: "agent", label: "live", activity: "active", startedAt: "2026-01-01T00:00:00Z", lastSeenAt: "2026-01-01T00:01:00Z", tools: [] });
    await save(root, ".agent/telemetry/old.json", { version: 1, id: "old", kind: "agent", label: "old", activity: "active", startedAt: "2026-01-01T00:00:00Z", lastSeenAt: "2026-01-01T00:00:00Z", tools: [] });
    const snap = await new WorkflowReader(root).read({ now: Date.parse("2026-01-01T00:01:05Z") });
    assert.equal(snap.runs[0].status, "running");
    assert.equal(snap.nodes.find(x => x.id === "task:g:T1")?.status, "running");
    assert.equal(snap.nodes.find(x => x.id === "task:g:T2")?.status, "stale");
    assert(snap.nodes.find(x => x.id === "task:g:T2")?.detail.includes("存储状态：running"));
    assert.deepEqual(snap.nodes.filter(x => x.kind === "tool").map(x => x.status), ["running", "failed", "returned", "returned", "stale"]);
    assert.deepEqual(snap.goal?.checks, { total: 2, passed: 0, failed: 0, notRun: 2 });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("running tool with no heartbeat is unknown and tail log node IDs remain stable", async () => {
  const root = await fixture();
  try {
    await save(root, "stages/M07/g/run.json", { stage: "M07", runId: "g", status: "running", startedAt: "2026-01-01T00:00:00Z", inputs: [], sessions: [], outputs: [], failures: [], remarks: [] });
    const logs = Array.from({ length: 101 }, (_, i) => ({ name: `call-${i}`, status: i === 100 ? "running" : "returned", ok: i !== 100 }));
    const goalPath = "stages/M07/g/goal.json";
    const goal = { runId: "g", lifecycle: "active", goal: "目标", successCriteria: ["A"], tasks: [{ taskId: "T1", objective: "执行", status: "running", createdAt: "2026-01-01T00:00:00Z", toolLog: logs }], decisions: [] };
    await save(root, goalPath, goal);
    const reader = new WorkflowReader(root), first = await reader.read({ now: Date.parse("2026-01-01T00:01:00Z") });
    assert.equal(first.nodes.find(x => x.id === "tool:g:T1:100")?.status, "unknown");
    assert.equal(first.nodes.filter(x => x.kind === "tool")[0]?.id, "tool:g:T1:1");
    goal.tasks[0].toolLog.push({ name: "call-101", status: "returned", ok: true });
    await save(root, goalPath, goal);
    const next = await reader.read({ now: Date.parse("2026-01-01T00:01:01Z") });
    assert.equal(next.nodes.filter(x => x.kind === "tool")[0]?.id, "tool:g:T1:2");
    assert.equal(next.nodes.find(x => x.id === "tool:g:T1:100")?.status, "unknown");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("usage deduplicates event ids across repeated prompt indexes", async () => {
  const root = await fixture();
  try {
    const sessionFile = await save(root, ".agent/sessions/s.jsonl", "");
    await save(root, ".agent/sessions/s.usage.jsonl", [
      { sessionId: "s", promptIndex: 1, events: [{ entryId: "e1", status: "reported", costStatus: "priced", usage: { input: 10, output: 2, cost: 0.1 } }] },
      { sessionId: "s", promptIndex: 1, events: [{ entryId: "e2", status: "reported", costStatus: "priced", usage: { input: 20, output: 3, cost: 0.2 } }] },
      { sessionId: "s", promptIndex: 2, events: [{ entryId: "e1", status: "reported", costStatus: "priced", usage: { input: 10, output: 2, cost: 0.1 } }] },
    ].map(x => JSON.stringify(x)).join("\n") + "\n");
    await save(root, "stages/M01/r/run.json", { stage: "M01", runId: "r", status: "completed", startedAt: "2026-01-01T00:00:00Z", inputs: [], sessions: [{ id: "s", label: "S", model: "m", file: sessionFile }], outputs: [], failures: [], remarks: [] });
    const snap = await new WorkflowReader(root).read({ stage: "M01" });
    assert.equal(snap.nodes.find(x => x.id === "session:s")?.usage?.input, 30);
    assert.equal(snap.nodes.find(x => x.id === "session:s")?.usage?.reportedEvents, 2);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("metadata reads reject symlinked batch outside workspace and run artifacts show outputs", async () => {
  const root = await fixture(), outside = await mkdtemp(path.join(os.tmpdir(), "workflow-console-outside-"));
  try {
    const external = path.join(outside, "batch.json"); await writeFile(external, JSON.stringify([{ sourceId: "S999", status: "completed" }]));
    const link = path.join(root, "stages", "M06", "r", "batch.json"); await mkdir(path.dirname(link), { recursive: true }); await symlink(external, link);
    const result = await save(root, "stages/M06/r/result.md", "result\n");
    await save(root, "stages/M06/r/run.json", { stage: "M06", runId: "r", status: "completed", startedAt: "2026-01-01T00:00:00Z", inputs: [], sessions: [], outputs: [
      { label: "整批结构化结果", path: link }, { label: "研究结果", path: result },
    ], failures: [], remarks: [] });
    const reader = new WorkflowReader(root), snap = await reader.read({ stage: "M06" });
    assert(!snap.nodes.some(x => x.label.includes("S999")));
    assert(snap.nodes.find(x => x.id === "run:M06:r")?.artifactRefs.some(x => x.path === result));
    assert((await reader.preview("run:M06:r", "artifacts")).join("\n").includes("result"));
  } finally { await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
});

test("M03 keeps one shared reviewer session without fabricating phase completion", async () => {
  const root = await fixture();
  try {
    await save(root, "stages/M03/r/run.json", { stage: "M03", runId: "r", status: "running", startedAt: "2026-01-01T00:00:00Z", inputs: [], sessions: [
      { id: "reviewer", label: "M03-reviewer-R1", model: "m" }, { id: "origin", label: "M01", model: "m" },
    ], outputs: [], failures: [], remarks: [] });
    const snap = await new WorkflowReader(root).read({ stage: "M03", now: Date.parse("2026-01-01T00:01:00Z") });
    assert.equal(snap.nodes.filter(x => x.kind === "session" && x.sessionId === "reviewer").length, 1);
    assert(!snap.nodes.some(x => x.kind === "group" && x.stage === "M03"));
    assert(snap.nodes.find(x => x.id === "session:reviewer")?.detail.some(x => x.includes("出题和后续评价")));
    assert.equal(snap.nodes.find(x => x.id === "run:M03:r")?.status, "unknown");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("M06 groups sessions by source; M08 and M09 show only recorded barriers", async () => {
  const root = await fixture();
  try {
    const base = { status: "completed", startedAt: "2026-01-01T00:00:00Z", inputs: [], failures: [], remarks: [] };
    const batch = await save(root, "stages/M06/a/batch.json", [{ sourceId: "S001", title: "文献", status: "completed", outputs: [] }]);
    await save(root, "stages/M06/a/run.json", { ...base, stage: "M06", runId: "a", sessions: [
      { id: "reader", label: "M06-S001-reader", model: "m" }, { id: "checker", label: "M06-S001-checker", model: "m" },
    ], outputs: [{ label: "整批结构化结果", path: batch }] });
    const m06 = await new WorkflowReader(root).read({ stage: "M06" });
    assert.equal(m06.nodes.find(x => x.id === "session:reader")?.parentId, "group:a:S001");
    assert.equal(m06.nodes.find(x => x.id === "session:checker")?.parentId, "barrier:a:S001:read");
    assert.equal(m06.nodes.find(x => x.id === "barrier:a:S001:read")?.status, "completed");
    assert(m06.nodes.find(x => x.id === "run:M06:a")?.detail.some(x => x.includes("不同资料组可并行")));

    const bundle = await save(root, "stages/M08/b/review-bundle.json", { selfChecks: [{ id: "self", status: "completed" }], reviews: [{ id: "external", status: "completed" }] });
    await save(root, "stages/M08/b/run.json", { ...base, stage: "M08", runId: "b", sessions: [
      { id: "self", label: "M08-selfcheck-self", model: "m" }, { id: "external", label: "M08-reviewer-external", model: "m" },
    ], outputs: [{ label: "M08 审查反馈结构", path: bundle }] });
    const m08 = await new WorkflowReader(root).read({ stage: "M08" });
    assert.equal(m08.nodes.find(x => x.id === "session:self")?.parentId, "group:b:selfchecks");
    assert.equal(m08.nodes.find(x => x.id === "session:external")?.parentId, "barrier:b:selfcheck");
    assert.equal(m08.nodes.find(x => x.id === "barrier:b:selfcheck")?.status, "completed");

    const explanation = await save(root, "stages/M09/c/explanation.md", "已登记说明\n");
    await save(root, "stages/M09/c/run.json", { ...base, stage: "M09", runId: "c", sessions: [
      { id: "org", label: "M09-organizer", model: "m" }, { id: "verify", label: "M09-checker", model: "m" },
    ], outputs: [{ label: "成果说明", path: explanation }] });
    const m09 = await new WorkflowReader(root).read({ stage: "M09" });
    assert.equal(m09.nodes.find(x => x.id === "session:verify")?.parentId, "barrier:c:explanation");
    assert.equal(m09.nodes.find(x => x.id === "barrier:c:explanation")?.status, "completed");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("M06 live telemetry groups a source before batch output exists", async () => {
  const root = await fixture();
  try {
    await save(root, "stages/M06/live/run.json", { stage: "M06", runId: "live", status: "running", startedAt: "2026-01-01T00:00:00Z", inputs: [], sessions: [], outputs: [], failures: [], remarks: [] });
    await save(root, ".agent/telemetry/read.json", { version: 1, id: "read", kind: "agent", label: "M06-S001-reader", stage: "M06", runId: "live", activity: "ended", startedAt: "2026-01-01T00:00:00Z", lastSeenAt: "2026-01-01T00:00:30Z", endedAt: "2026-01-01T00:00:30Z", tools: [] });
    await save(root, ".agent/telemetry/check.json", { version: 1, id: "check", kind: "agent", label: "M06-S001-checker", stage: "M06", runId: "live", activity: "active", startedAt: "2026-01-01T00:00:31Z", lastSeenAt: "2026-01-01T00:01:00Z", tools: [] });
    const snap = await new WorkflowReader(root).read({ stage: "M06", now: Date.parse("2026-01-01T00:01:05Z") });
    assert.equal(snap.nodes.find(x => x.id === "group:live:S001")?.status, "unknown");
    assert.equal(snap.nodes.find(x => x.id === "session:read")?.parentId, "group:live:S001");
    assert.equal(snap.nodes.find(x => x.id === "session:check")?.parentId, "barrier:live:S001:read");
    assert.equal(snap.nodes.find(x => x.id === "barrier:live:S001:read")?.status, "completed");
  } finally { await rm(root, { recursive: true, force: true }); }
});
