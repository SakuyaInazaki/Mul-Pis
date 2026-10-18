import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { WorkflowReader, discoverWorkflowWorkspaces } from "../src/console/read-model.ts";
import { createCandidateExecutionTools } from "../../src/m07/candidate-runner.ts";
import { openDefaultLocalMission } from "../../src/m07/local-mission.ts";

async function fixture(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "workflow-console-"));
  await writeFile(path.join(root, "research.config.json"), "{}\n");
  return root;
}
async function save(root: string, relative: string, value: unknown): Promise<string> {
  const file = path.join(root, relative); await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, typeof value === "string" ? value : JSON.stringify(value)); return file;
}

test("execution tree follows durable stage and original-ID query records before candidate archival", async t => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const workDir = path.join(root, "stages/M07/g/tasks/T001/work");
  await mkdir(workDir, { recursive: true });
  await writeFile(path.join(workDir, "kernel.txt"), "source bytes\n");
  await save(root, "stages/M07/g/run.json", { stage: "M07", runId: "g", status: "running", startedAt: "2026-01-01T00:00:00Z", inputs: [], sessions: [], outputs: [], failures: [], remarks: [] });
  await save(root, "stages/M07/g/goal.json", { runId: "g", lifecycle: "active", goal: "目标", tasks: [
    { taskId: "T001", objective: "执行候选", status: "running", createdAt: "2026-01-01T00:00:00Z", workDir, toolLog: [] },
  ], decisions: [], goalChecks: [] });
  let issued = 0, evaluationAttempts = 0;
  const tools = createCandidateExecutionTools({ goalRunId: "g", taskId: "T001", operationId: "O001", workDir,
    journalDir: path.join(path.dirname(workDir), "candidate-runs"),
    backend: { id: "test-host", version: "1", stages: [
      { id: "compile", mode: "local", checks: ["compile"] },
      { id: "correctness", mode: "delegated", checks: ["correctness"] },
      { id: "measurement", mode: "local", checks: ["measurement"] },
    ], async executeStage(ctx) {
      if (ctx.stage.id === "correctness") { issued++; await ctx.recordExternalId("existing-1");
        return { status: "pending", externalId: "existing-1", receiptPaths: [] }; }
      const file = path.join(ctx.outputDir, "result.json"); await writeFile(file, JSON.stringify({ stage: ctx.stage.id }));
      const relative = path.relative(ctx.workDir, file);
      return { status: "passed", performedChecks: ctx.stage.checks, receiptPaths: [relative],
        ...(ctx.stage.id === "measurement" ? { evaluationReceiptPaths: [relative] } : {}) };
    }, async queryStage(ctx) {
      assert.equal(ctx.externalId, "existing-1");
      const file = path.join(ctx.outputDir, "query.json"); await writeFile(file, '{"correct":true}');
      return { status: "passed", performedChecks: ["correctness"], externalId: ctx.externalId, receiptPaths: [path.relative(ctx.workDir, file)] };
    } }, evaluate: async () => {
      if (++evaluationAttempts === 1) throw new Error("verifier temporarily unavailable");
      return { text: '{"verified":true}' };
    } });
  const execute = tools.find(tool => tool.name === "candidate_run")!;
  await execute.execute({ runId: "candidate1", sourcePaths: ["kernel.txt"], protocolId: "test", configJson: '{"parameters":{"BLOCK":128}}',
    hypothesis: "test original-ID continuation", intent: "solution", changeKind: "structure" });
  const reader = new WorkflowReader(root);
  const before = await reader.read({ goalRunId: "g" });
  const prefix = "candidate-execution:g:T001:candidate1";
  assert.equal(before.nodes.find(node => node.id === prefix)?.status, "waiting");
  assert(before.nodes.find(node => node.id === prefix)?.detail.includes("参数组合：BLOCK=128"));
  assert.equal(before.nodes.find(node => node.id === `${prefix}:stage:compile`)?.status, "completed");
  assert.equal(before.nodes.find(node => node.id === `${prefix}:stage:correctness`)?.status, "waiting");
  assert(before.nodes.find(node => node.id === `${prefix}:stage:correctness`)?.detail.includes("原始外部 ID：existing-1"));
  assert.equal(before.nodes.find(node => node.id === `${prefix}:stage:measurement`)?.checks[0].result, "not_run");
  await execute.execute({ runId: "candidate1", resume: true });
  const unverified = await reader.read({ goalRunId: "g" });
  assert.equal(unverified.nodes.find(node => node.id === prefix)?.status, "completed");
  assert(unverified.nodes.find(node => node.id === prefix)?.detail.some(line => line.includes("候选核验错误")));
  await execute.execute({ runId: "candidate1", resume: true });
  const after = await reader.read({ goalRunId: "g" });
  assert.equal(issued, 1);
  assert.equal(after.nodes.find(node => node.id === prefix)?.status, "completed");
  assert(after.nodes.find(node => node.id === prefix)?.detail.some(line => line.startsWith("候选核验已返回")));
  assert.equal(after.goal?.lifecycle, "active");
  assert.equal(after.goal?.tasks.accepted, 0);
});

test("reads selected M07 goal, task ancestry, separate task states and stale heartbeat", async () => {
  const root = await fixture();
  try {
    const runId = "r1", report = await save(root, "stages/M07/r1/report.md", "hello\x1b[31m red\x1b[0m\u202e world\n");
    const priorRoot = "stages/M07/r1/tasks/T1/episode";
    const priorSource = await save(root, `${priorRoot}/C001/sources/000-prior.py`, "prior\n");
    const priorReceipt = await save(root, `${priorRoot}/C001/receipts/000-prior.json`, { submissionId: 0 });
    const priorObservation = await save(root, `${priorRoot}/C001/observation.json`, { id: "C001", frozen: true });
    const episodeRoot = "stages/M07/r1/tasks/T3/episode";
    const source1 = await save(root, `${episodeRoot}/C001/sources/000-a.py`, "candidate A\n");
    const receipt1 = await save(root, `${episodeRoot}/C001/receipts/000-a.json`, { submissionId: 1 });
    const observation1 = await save(root, `${episodeRoot}/C001/observation.json`, { id: "C001", frozen: true });
    const source2 = await save(root, `${episodeRoot}/C002/sources/000-b.py`, "candidate B\n");
    const receipt2 = await save(root, `${episodeRoot}/C002/receipts/000-b.json`, { submissionId: 2 });
    const observation2 = await save(root, `${episodeRoot}/C002/observation.json`, { id: "C002", frozen: true });
    const source3 = await save(root, `${episodeRoot}/C003/sources/000-c.py`, "candidate A\n");
    const receipt3 = await save(root, `${episodeRoot}/C003/receipts/000-c.json`, { submissionId: 3 });
    const observation3 = await save(root, `${episodeRoot}/C003/observation.json`, { id: "C003", frozen: true });
    const work3 = path.join(root, "stages/M07/r1/tasks/T3/work");
    const runInputs = (runName: string, sourceName: string) => ({
      source: `.candidate-runs/${runName}/sources/${sourceName}`,
      receipt: `.candidate-runs/${runName}/receipts/measurement.json`,
    });
    const firstInputs = runInputs("run-a", "a.py"), secondInputs = runInputs("run-b", "b.py");
    const evaluated = (sourceFile: string, receiptFile: string, correctness: "passed" | "failed", score?: number, samples?: number[]) => ({
      version: 1, kind: "candidate-observation", verifier: { id: "host:offline", version: "1" },
      sourceBinding: "verified", correctness, stage: "platform-result", checks: [], goalChecks: [],
      metrics: score === undefined ? [] : [{ name: "displayScore", value: score, unit: "platform-score", basisId: "problem:51:displayScore", direction: "higher" }],
      executionFacts: { evaluations: [{ externalId: receiptFile === priorReceipt ? "SID-0" : receiptFile === receipt3 ? "SID-3" : receiptFile === receipt2 ? "SID-2" : "SID-1", subjectId: "problem:51",
        status: correctness === "failed" ? "Wrong Answer" : "Accepted", terminal: true, capturedAt: "2026-01-01T00:04:30Z", receiptIndex: 0,
        cases: [{ caseId: "case-1", status: correctness === "failed" ? "Wrong Answer" : "Accepted", correctness,
          metrics: score === undefined ? [] : [{ name: "score", value: score, unit: "points", basisId: "case-score", direction: "higher" }],
          ...(samples ? { performance: { basisId: "problem:51:case:1:seconds", timingSamplesSeconds: { values: samples, receiptIndex: 0, fieldPath: "samplesSeconds" } } } : {}) }],
        diagnostics: correctness === "failed" ? [{ category: "numerical", fieldPath: "cases[0].message", rawText: "sensitive raw diagnostic" }] : [] }] },
      limitations: [], sourceFiles: [sourceFile], receiptFiles: [receiptFile],
    });
    await save(root, "stages/M07/r1/run.json", { stage: "M07", runId, status: "running", startedAt: "2026-01-01T00:00:00Z", inputs: [], sessions: [], outputs: [], failures: [], remarks: [] });
    await save(root, "stages/M07/r1/goal.json", {
      runId, lifecycle: "active", goal: "实际研究目标", tasks: [
        { taskId: "T1", objective: "采集材料", status: "accepted", createdAt: "2026-01-01T00:01:00Z", returnedAt: "2026-01-01T00:02:00Z", reportPath: report, toolLog: [],
          workDir: path.join(root, "stages/M07/r1/tasks/T1/work"), candidate: { sourcePaths: ["source.txt"], receiptPaths: ["receipt.json"], intent: "solution" },
          episode: { version: 1, currentCandidateId: "C001", incumbents: [{ candidateId: "C001", metric: { name: "displayScore", value: 90, unit: "platform-score", basisId: "problem:51:displayScore", direction: "higher" } }],
            candidates: [{ id: "C001", sourcePaths: ["prior.py"], receiptPaths: ["prior.json"], hypothesis: "旧路线", changeKind: "structure", intent: "solution", observation: evaluated(priorSource, priorReceipt, "passed", 90), observationPath: priorObservation }] },
          review: { at: "2026-01-01T00:03:00Z", checks: [{ criterion: "原文已核对", result: "passed", evidence: [report] }], artifacts: [] } },
        { taskId: "T2", parentTaskId: "T1", objective: "核对", status: "unknown", createdAt: "2026-01-01T00:04:00Z", toolLog: [], session: { id: "s2", label: "T2", role: "execution", model: "model-x" } },
        { taskId: "T3", objective: "候选实验", status: "returned", createdAt: "2026-01-01T00:04:30Z", returnedAt: "2026-01-01T00:04:45Z", toolLog: [],
          workDir: work3,
          episode: { version: 1, currentCandidateId: "C002", incumbents: [{ candidateId: "C001", metric: { name: "displayScore", value: 92, unit: "platform-score", basisId: "problem:51:displayScore", direction: "higher" } }],
            candidates: [
              { id: "C001", sourcePaths: [firstInputs.source], receiptPaths: [firstInputs.receipt], hypothesis: "第一条路线", changeKind: "structure", intent: "solution", observation: evaluated(source1, receipt1, "passed", 92, [0.000003, 0.000004]), observationPath: observation1 },
              { id: "C002", parentCandidateId: "T1/C001", parentRef: { taskId: "T1", candidateId: "C001" },
                sourcePaths: [secondInputs.source], receiptPaths: [secondInputs.receipt], hypothesis: "从旧任务继续探索", conditions: ["编译器配置一致"], changeSummary: "调整分块",
                sourceRepetition: "code_cycle", identicalSourceRefs: ["T1/C001"], parentComparison: { comparableMetrics: [], caseChanges: [], summary: ["父子结果不可直接比较"] },
                changeKind: "parameters", intent: "solution", observation: evaluated(source2, receipt2, "failed"), observationPath: observation2 },
              { id: "C003", parentCandidateId: "C001", parentRef: { taskId: "T3", candidateId: "C001" },
                sourcePaths: ["c.py"], receiptPaths: ["c.json"], hypothesis: "检查同口径样本", changeKind: "parameters", intent: "solution",
                observation: evaluated(source3, receipt3, "passed", 91, [0.000002, 0.000003]), observationPath: observation3 },
            ] } },
      ], decisions: [], goalChecks: [{ criterion: "完成", result: "not_run", evidence: [] }],
      executionState: { activeAttemptId: "a1", attempts: [{ id: "a1", state: "running" }] },
    });
    const journalRoot = "stages/M07/r1/tasks/T3/candidate-runs";
    const execution = async (runName: string, inputs: { source: string; receipt: string },
      candidateRef?: string, observationPath?: string, state = "completed") => {
      const absoluteSource = await save(root, path.relative(root, path.join(work3, inputs.source)), `${runName} source\n`);
      const absoluteReceipt = await save(root, path.relative(root, path.join(work3, inputs.receipt)), { runName });
      await save(root, `${journalRoot}/${runName}/journal.json`, {
        version: 1, kind: "candidate", runId: runName, goalRunId: "r1", taskId: "T3", operationId: `O-${runName}`,
        state, backend: { id: "test-host", version: "1", stages: [{ id: "measurement", mode: "local", checks: ["measurement"] }] },
        request: { protocolId: "test", config: { parameters: { BLOCK: 128 } } },
        sources: [{ declaredPath: path.basename(inputs.source), absolutePath: absoluteSource, frozenPath: absoluteSource }],
        stages: state === "unknown" ? [] : [{ stage: { id: "measurement", mode: "local", checks: ["measurement"] }, status: "passed",
          result: { status: "passed", receiptPaths: ["platform.json"], evaluationReceiptPaths: ["platform.json"] },
          receiptSnapshots: [{ originalPath: "platform.json", frozenPath: absoluteReceipt, evaluationPath: inputs.receipt }] }],
        ...(candidateRef ? { evaluation: { text: JSON.stringify({ candidateRef, projection: { fullObservationPath: observationPath } }) } } : {}),
      });
    };
    await execution("run-a", firstInputs, "T3/C001", observation1);
    await execution("run-b", secondInputs, "T3/C002", observation2);
    await execution("run-wrong", runInputs("run-wrong", "wrong.py"), "T3/C002", observation2);
    await execution("run-cross-task", runInputs("run-cross-task", "wrong.py"), "T1/C001", priorObservation);
    await execution("run-unknown", runInputs("run-unknown", "unknown.py"), undefined, undefined, "unknown");
    const reader = new WorkflowReader(root);
    const snap = await reader.read({ now: Date.parse("2026-01-01T00:05:00Z") });
    assert.equal(snap.currentStage, "M07");
    assert.equal(snap.goal?.tasks.accepted, 1);
    assert.equal(snap.goal?.tasks.returned, 1);
    assert.equal(snap.goal?.tasks.unknown, 1);
    assert.equal(snap.nodes.find(x => x.id === "task:r1:T2")?.parentId, "task:r1:T1");
    assert.equal(snap.nodes.find(x => x.id === "session:s2")?.parentId, "task:r1:T2");
    assert.equal(snap.nodes.find(x => x.id === "candidate:r1:T1")?.parentId, "task:r1:T1");
    assert.equal(snap.nodes.find(x => x.id === "task:r1:T3")?.status, "returned");
    assert.equal(snap.nodes.find(x => x.id === "episode:r1:T3")?.parentId, "task:r1:T3");
    assert.equal(snap.nodes.find(x => x.id === "episode-candidate:r1:T3:C001")?.parentId, "episode:r1:T3");
    assert.equal(snap.nodes.find(x => x.id === "episode-candidate:r1:T3:C002")?.parentId, "episode:r1:T3");
    assert.equal(snap.nodes.find(x => x.id === "episode-candidate:r1:T3:C002")?.status, "failed");
    assert(snap.nodes.find(x => x.id === "episode-candidate:r1:T3:C002")?.label.includes("当前探索点"));
    const childDetails = snap.nodes.find(x => x.id === "episode-candidate:r1:T3:C002")?.detail ?? [];
    assert(childDetails.some(x => x.includes("父候选：T1/C001")));
    assert(childDetails.some(x => x.includes("声明条件：编译器配置一致")));
    assert(childDetails.some(x => x.includes("同源码事实：code_cycle")));
    assert(childDetails.some(x => x.includes("父子结果不可直接比较")));
    assert(snap.nodes.find(x => x.id === "episode:r1:T3")?.detail.some(x => x.includes("局部最佳：C001") && x.includes("92")));
    assert(snap.nodes.find(x => x.id === "episode:r1:T3")?.detail.some(x => x.includes("不代表整个目标的历史最佳")));
    assert(snap.nodes.find(x => x.id === "run:M07:r1")?.detail.some(x => x.includes("已归档且宿主核验") && x.includes("T3/C001") && x.includes("92")));
    assert(snap.nodes.find(x => x.id === "run:M07:r1")?.detail.some(x => x.includes("搜索观察") && x.includes("problem:51")));
    assert(snap.nodes.find(x => x.id === "run:M07:r1")?.detail.some(x => x.includes("逐例线索") && x.includes("case-1")));
    assert(snap.nodes.find(x => x.id === "run:M07:r1")?.detail.some(x => x.includes("同源码重复观测") && x.includes("problem:51") && x.includes("displayScore") && x.includes("91") && x.includes("92") && x.includes("T3/C001") && x.includes("T3/C003")));
    assert(snap.nodes.find(x => x.id === "episode-candidate:r1:T3:C001")?.detail.some(x => x.includes("已归档且宿主核验")));
    assert(!snap.nodes.find(x => x.id === "episode-candidate:r1:T1:C001")?.detail.some(x => x.includes("已归档且宿主核验")));
    const externalDetails = snap.nodes.find(x => x.id === "episode-evaluation:r1:T3:C002")?.detail ?? [];
    assert(externalDetails.some(x => x.includes("机械诊断阶段：")));
    assert(externalDetails.some(x => x.includes("性能画像证据：unavailable")));
    assert(externalDetails.some(x => x.includes("诊断定位：numerical") && x.includes("cases[0].message")));
    assert(externalDetails.some(x => x.includes("SID-2") && x.includes("失败 1") && x.includes("诊断 1")));
    assert(!externalDetails.join(" ").includes("sensitive raw diagnostic"));
    assert(snap.nodes.find(x => x.id === "episode-evaluation:r1:T3:C003")?.detail.some(x => x.includes("同口径样本比较 1")));
    assert(snap.nodes.find(x => x.id === "episode-evaluation:r1:T3:C003")?.detail.some(x => x.includes("样本观测差：case-1") && x.includes("仅描述性")));
    assert(snap.nodes.find(x => x.id === "episode-evaluation:r1:T3:C002")?.outputRefs.some(x => x.label.includes("SID-2") && x.path === receipt2));
    assert.equal(snap.nodes.find(x => x.id === "episode-evaluation:r1:T3:C001")?.outputRefs[0]?.path, observation1);
    assert.equal(snap.nodes.find(x => x.id === "episode-evaluation:r1:T3:C002")?.artifactRefs[0]?.path, source2);
    assert.equal(snap.nodes.find(x => x.id === "episode-candidate:r1:T3:C002")?.outputRefs[1]?.path, receipt2);
    const executionNode = (runName: string) => snap.nodes.find(x => x.id === `candidate-execution:r1:T3:${runName}`);
    assert(executionNode("run-a")?.detail.some(x => x.includes("关联冻结候选 T3/C001")));
    assert(executionNode("run-a")?.outputRefs.some(x => x.path === observation1));
    assert(executionNode("run-b")?.detail.some(x => x.includes("关联冻结候选 T3/C002")));
    assert(executionNode("run-b")?.outputRefs.some(x => x.path === observation2));
    for (const runName of ["run-wrong", "run-cross-task", "run-unknown"]) {
      assert(!executionNode(runName)?.detail.some(x => x.includes("关联冻结候选")));
      assert.equal(executionNode(runName)?.outputRefs.length, 1);
    }
    assert.equal(executionNode("run-unknown")?.status, "unknown");
    assert.equal(snap.nodes.find(x => x.id === "attempt:r1:a1")?.parentId, "run:M07:r1");
    assert.equal(snap.nodes.find(x => x.id === "run:M07:r1")?.status, "unknown");
    assert.deepEqual(snap.goal?.checks, { total: 1, passed: 0, failed: 0, notRun: 1 });
    const preview = await reader.preview("task:r1:T1", "output");
    assert(preview.join("\n").includes("hello red world"));
    assert(!preview.join("\n").includes("\x1b"));
    assert(!preview.join("\n").includes("\u202e"));
    assert((await reader.preview("episode-evaluation:r1:T3:C001", "output")).join("\n").includes("C001"));
    await rm(source1);
    const missing = await reader.read({ now: Date.parse("2026-01-01T00:05:00Z") });
    assert(missing.nodes.find(x => x.id === "episode-candidate:r1:T3:C001")?.detail.some(x => x.includes("冻结证据当前不可读取")));
    assert(!missing.nodes.find(x => x.id === "run:M07:r1")?.detail.some(x => x.includes("观测最佳") && x.includes("T3/C001")));
    assert(!missing.nodes.find(x => x.id === "candidate-execution:r1:T3:run-a")?.detail.some(x => x.includes("关联冻结候选")));
    assert(missing.nodes.find(x => x.id === "candidate-execution:r1:T3:run-b")?.detail.some(x => x.includes("关联冻结候选 T3/C002")));
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
    await save(root, "problem/problem.md", "原始合同材料\n");
    await mkdir(path.join(root, ".agent"), { recursive: true });
    const mission = await openDefaultLocalMission({ workspaceRoot: root }).begin({ version: 1,
      kind: "local-original-objective-request", goal: "合同目标", goalSource: "user-intent-summary",
      obligations: [{ id: "O1", description: "依据原材料完成研究" }], closure: "open-ended" });
    const projected = await reader.read({ goalRunId: "g" });
    const missionNode = projected.nodes.find(node => node.id === `mission:${mission.contract.id}`);
    assert.deepEqual(missionNode?.checks, []);
    assert(missionNode?.detail.includes("原合同义务（逐项核验结果未登记）："));
    assert(missionNode?.detail.includes("O1：依据原材料完成研究"));
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
      { taskId: "T1", objective: "执行", status: "running", createdAt: "2026-01-01T00:00:00Z", checks: ["源码冻结", "独立核验"], session: { id: "live", label: "live", model: "m" }, toolLog: [
        { name: "read", status: "running", ok: false }, { name: "bash", status: "error", ok: false, error: "退出失败" }, { name: "write", status: "returned", ok: true }, { name: "legacy", ok: true },
      ] },
      { taskId: "T2", objective: "旧任务", status: "running", createdAt: "2026-01-01T00:00:00Z", session: { id: "old", label: "old", model: "m" }, toolLog: [{ name: "old-running", status: "running", ok: false }] },
    ], decisions: [] });
    await save(root, ".agent/telemetry/live.json", { version: 1, id: "live", kind: "agent", label: "live", activity: "active", startedAt: "2026-01-01T00:00:00Z", lastSeenAt: "2026-01-01T00:01:00Z", tools: [] });
    await save(root, ".agent/telemetry/old.json", { version: 1, id: "old", kind: "agent", label: "old", activity: "active", startedAt: "2026-01-01T00:00:00Z", lastSeenAt: "2026-01-01T00:00:00Z", tools: [] });
    const snap = await new WorkflowReader(root).read({ now: Date.parse("2026-01-01T00:01:05Z") });
    assert.equal(snap.runs[0].status, "running");
    assert.equal(snap.nodes.find(x => x.id === "task:g:T1")?.status, "running");
    assert.deepEqual(snap.nodes.find(x => x.id === "task:g:T1")?.checks, [
      { criterion: "源码冻结", result: "not_run", evidence: [] },
      { criterion: "独立核验", result: "not_run", evidence: [] },
    ]);
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
    assert(first.nodes.find(x => x.id === "task:g:T1")?.detail.some(x => x.includes("共 101 条；树中显示末 100 条")));
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
    assert.equal(m06.nodes.find(x => x.id === "barrier:a:S001:read")?.status, "unknown");
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
    assert.equal(snap.nodes.find(x => x.id === "barrier:live:S001:read")?.status, "unknown");
  } finally { await rm(root, { recursive: true, force: true }); }
});
