import { existsSync } from "node:fs";
import { open, readFile, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { CandidateMetricV1, CandidateObservationV1, CurrentGoal, M07TaskRecord } from "../../../src/m07/types.ts";
import { candidateSearchSnapshot, globalCandidateBest, type CandidateArchiveEntry } from "../../../src/m07/candidate-archive.ts";
import { candidateSearchBrief, candidateSearchFocus } from "../../../src/m07/candidate-search.ts";
import { summarizeCandidateDiagnostics, type CandidateComparisonV1 } from "../../../src/m07/candidate-diagnostics.ts";
import type { SessionTelemetry } from "../../../src/telemetry.ts";
import type { StageRunRecord } from "../../../src/types.ts";
import type { ObjectiveProgressV1 } from "../../../src/m07/objective-progress.ts";
import { openDefaultLocalMission } from "../../../src/m07/local-mission.ts";
import type { ConsoleRef, ConsoleStatus, WorkflowNode, WorkflowSnapshot } from "./model.ts";
import { buildWorkflowAudit, type AuditGoalInput } from "./audit.ts";
import { DEFAULT_CONSOLE_LIMITS, loadConsoleLimits, type ConsoleLimitsV1 } from "./limits.ts";

export type { WorkflowSnapshot, WorkflowNode } from "./model.ts";
export interface ReadOptions { goalRunId?: string; missionId?: string; stage?: string; runId?: string; now?: number }
const STAGES = Array.from({ length: 9 }, (_, i) => `M${String(i + 1).padStart(2, "0")}`);
type Cached = { mtimeMs: number; size: number; data: unknown };
type CheckpointProjection = { runId?: string; updatedAt?: string; selectedTaskIds?: string[]; omittedTaskIds?: string[] };
type CachedCheckpoint = { mtimeMs: number; size: number; data?: CheckpointProjection };
const clean = (input: string): string => input.replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g, "")
  .replace(/[\u202a-\u202e\u2066-\u2069\u200e\u200f\u061c]/g, "")
  .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
const str = (x: unknown): string | undefined => typeof x === "string" ? x : undefined;
const obj = (x: unknown): Record<string, unknown> | undefined => x && typeof x === "object" && !Array.isArray(x) ? x as Record<string, unknown> : undefined;
const arr = (x: unknown): unknown[] => Array.isArray(x) ? x : [];
const ref = (x: unknown): ConsoleRef | undefined => { const r = obj(x); return r && str(r.path) ? { label: str(r.label) ?? path.basename(str(r.path)!), path: str(r.path)! } : undefined; };
const refs = (x: unknown): ConsoleRef[] => arr(x).map(ref).filter((x): x is ConsoleRef => Boolean(x));
const checkRows = (x: unknown) => arr(x).map(obj).filter((x): x is Record<string, unknown> => Boolean(x)).map(x => ({ criterion: str(x.criterion) ?? "检查", result: str(x.result) ?? "unknown", evidence: arr(x.evidence).filter((v): v is string => typeof v === "string") }));
const externalEvaluationDetails = (observation: CandidateObservationV1): string[] =>
  (observation.executionFacts?.evaluations ?? []).map(evaluation =>
    `外部评测 ${evaluation.externalId} · ${evaluation.status} · ${evaluation.terminal ? "终态" : "未终态"}；` +
    `用例 ${evaluation.cases.length}（失败 ${evaluation.cases.filter(item => item.correctness === "failed").length}，未知 ${evaluation.cases.filter(item => item.correctness === "unknown").length}）；诊断 ${evaluation.diagnostics.length}；原回执 ${evaluation.receiptIndex + 1}`);
const diagnosticDetails = (observation: CandidateObservationV1, comparison?: CandidateComparisonV1,
  parentObservation?: CandidateObservationV1): string[] => {
  const summary = summarizeCandidateDiagnostics(observation, comparison, parentObservation);
  const locations = summary.diagnosticLocations.slice(0, 6);
  return [`机械诊断阶段：${summary.stage}（宿主阶段 ${summary.hostStage}）`,
    `外部评测：终态 ${summary.terminalEvaluations}，未终态 ${summary.nonterminalEvaluations}；逐例通过 ${summary.cases.passed}、失败 ${summary.cases.failed}、未知 ${summary.cases.unknown}`,
    `原始诊断：编译 ${summary.diagnostics.compile}、数值 ${summary.diagnostics.numerical}、运行 ${summary.diagnostics.runtime}、未知 ${summary.diagnostics.unknown}`,
    ...locations.map(item => `诊断定位：${item.category} · ${item.externalId}${item.caseId ? `/${item.caseId}` : ""} · 回执 ${item.receiptIndex + 1} · ${item.fieldPath}`),
    ...(summary.diagnosticLocations.length > locations.length ? [`其余 ${summary.diagnosticLocations.length - locations.length} 个诊断定位见冻结观测及原回执`] : []),
    ...(summary.parentMeasuredChange ? [`同口径父子观测：改善 ${summary.parentMeasuredChange.improved}、回退 ${summary.parentMeasuredChange.regressed}、相同 ${summary.parentMeasuredChange.equal}；正确性变化 ${summary.parentMeasuredChange.correctnessChanges}`] : []),
    `性能画像证据：${summary.profilerInterpretation}；同口径样本比较 ${summary.timingComparisons.length}，参考值对照 ${summary.referenceContrasts.length}`,
    ...summary.timingComparisons.slice(0, 3).map(item =>
      `样本观测差：${item.caseId} · ${item.basisId} · 中位数差 ${item.medianDifferenceSeconds}s · 样本内MAD ${item.pooledMedianAbsoluteDeviationSeconds}s · 范围${item.sampleRangesOverlap ? "重叠" : "不重叠"}（仅描述性）`),
    ...(summary.timingComparisons.length > 3 ? [`其余 ${summary.timingComparisons.length - 3} 项样本比较见冻结观测`] : []),
    ...summary.profileInterpretations.slice(0, 3).map(item => `画像观测：${item.caseId} · ${item.basisId}${item.rooflineLowerBoundSeconds === undefined ? "" : ` · 理论下界 ${item.rooflineLowerBoundSeconds}s`}${item.timingSamples ? ` · 样本 ${item.timingSamples.count}` : ""}`),
    ...(summary.profileInterpretations.length > 3 ? [`其余 ${summary.profileInterpretations.length - 3} 个画像见冻结观测`] : []),
    ...summary.inspection.map(item => `证据提示：${item}`)];
};
const receiptRefs = (observation: CandidateObservationV1): ConsoleRef[] => observation.receiptFiles.map((file, index) => {
  const external = observation.executionFacts?.evaluations.find(item => item.receiptIndex === index);
  return { label: external ? `外部评测 ${external.externalId} 原回执` : `冻结原回执 · ${path.basename(file)}`, path: file };
});
function inside(root: string, target: string): boolean { const rel = path.relative(root, target); return rel === "" || (!rel.startsWith(".." + path.sep) && rel !== ".." && !path.isAbsolute(rel)); }

export async function discoverWorkflowWorkspaces(root: string): Promise<string[]> {
  const base = path.resolve(root), result: string[] = [];
  if (existsSync(path.join(base, "research.config.json"))) result.push(base);
  const children = path.join(base, "workspaces");
  for (const ent of await readdir(children, { withFileTypes: true }).catch(() => [])) {
    if (!ent.isDirectory() || ent.isSymbolicLink()) continue;
    const candidate = path.join(children, ent.name);
    if (existsSync(path.join(candidate, "research.config.json"))) result.push(candidate);
  }
  return result;
}

/** Read-only projection of durable workflow state. No operation here changes a workspace. */
export class WorkflowReader {
  readonly workspace: string;
  private cache = new Map<string, Cached>();
  private checkpointCache = new Map<string, CachedCheckpoint>();
  private last?: WorkflowSnapshot;
  /** Replaced by the workspace's own file on the first read; the defaults only
   * apply until then, and a malformed override is an error, not a fallback. */
  private limits: ConsoleLimitsV1 = { ...DEFAULT_CONSOLE_LIMITS };
  constructor(workspace: string) { this.workspace = path.resolve(workspace); }

  private async json(file: string): Promise<unknown | undefined> {
    try {
      const safe = await this.confined(file);
      if (!safe) return undefined;
      const s = await stat(safe);
      if (!s.isFile() || s.size > this.limits.maxJsonBytes) return undefined;
      const prior = this.cache.get(safe);
      if (prior && prior.mtimeMs === s.mtimeMs && prior.size === s.size) return prior.data;
      const data: unknown = JSON.parse(await readFile(safe, "utf8"));
      this.cache.set(safe, { mtimeMs: s.mtimeMs, size: s.size, data });
      return data;
    } catch { return undefined; }
  }
  /** Retain only control identity and scope, never the full frozen goal. */
  private async checkpointProjection(file: string): Promise<CheckpointProjection | undefined> {
    try {
      const safe = await this.confined(file);
      if (!safe) return undefined;
      const s = await stat(safe);
      if (!s.isFile() || s.size > this.limits.maxJsonBytes) return undefined;
      const prior = this.checkpointCache.get(safe);
      if (prior && prior.mtimeMs === s.mtimeMs && prior.size === s.size) return prior.data;
      const parsed = obj(JSON.parse(await readFile(safe, "utf8")));
      const scope = obj(parsed?.checkpointScope);
      const data = parsed ? {
        runId: str(parsed.runId), updatedAt: str(parsed.updatedAt),
        selectedTaskIds: Array.isArray(scope?.selectedTaskIds) && scope.selectedTaskIds.every(x => typeof x === "string") ? scope.selectedTaskIds as string[] : undefined,
        omittedTaskIds: Array.isArray(scope?.omittedTaskIds) && scope.omittedTaskIds.every(x => typeof x === "string") ? scope.omittedTaskIds as string[] : undefined,
      } : undefined;
      this.checkpointCache.set(safe, { mtimeMs: s.mtimeMs, size: s.size, data });
      return data;
    } catch { return undefined; }
  }
  private async telemetry(): Promise<SessionTelemetry[]> {
    const dir = path.join(this.workspace, ".agent", "telemetry");
    const found: SessionTelemetry[] = [];
    for (const name of await readdir(dir).catch(() => [])) {
      if (!name.endsWith(".json")) continue;
      const t = obj(await this.json(path.join(dir, name)));
      if (t?.version === 1 && (t.activity === "active" || t.activity === "idle" || t.activity === "ended") && str(t.id) && str(t.lastSeenAt)) found.push(t as unknown as SessionTelemetry);
    }
    return found;
  }

  async read(options: ReadOptions = {}): Promise<WorkflowSnapshot> {
    const now = options.now ?? Date.now(), warnings: string[] = [];
    this.limits = await loadConsoleLimits(this.workspace);
    const nodes: WorkflowNode[] = STAGES.map(stage => ({ id: `stage:${stage}`, label: stage, kind: "stage", status: "pending", stage, detail: [], outputRefs: [], artifactRefs: [], checks: [] }));
    const runs: StageRunRecord[] = [];
    for (const stage of STAGES) {
      const dir = path.join(this.workspace, "stages", stage);
      for (const ent of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
        if (!ent.isDirectory() || ent.isSymbolicLink()) continue;
        const run = await this.json(path.join(dir, ent.name, "run.json"));
        const r = obj(run);
        if (r && r.stage === stage && r.runId === ent.name && str(r.startedAt) && ["running", "completed", "failed"].includes(String(r.status))) runs.push(run as StageRunRecord);
        else if (existsSync(path.join(dir, ent.name, "run.json"))) {
          const size = await stat(path.join(dir, ent.name, "run.json")).then(x => x.size).catch(() => 0);
          warnings.push(`${stage}/${ent.name} 的 run.json ${size > this.limits.maxJsonBytes ? `超过 ${this.limits.maxJsonBytes} 字节读取上限` : "不可读取或格式异常"}`);
        }
      }
    }
    runs.sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.runId.localeCompare(b.runId));
    const telemetry = await this.telemetry();
    const bySession = new Map(telemetry.map(t => [t.id, t]));
    const goalSessionIds = new Map<string, Set<string>>();
    for (const run of runs.filter(r => r.stage === "M07" && r.status === "running")) {
      const goal = obj(await this.json(path.join(this.workspace, "stages", "M07", run.runId, "goal.json")));
      goalSessionIds.set(run.runId, new Set(arr(goal?.tasks).map(x => str(obj(obj(x)?.session)?.id)).filter((x): x is string => Boolean(x))));
    }
    const freshFor = (r: StageRunRecord) => telemetry.some(t => ((t.stage === r.stage && t.runId === r.runId) || (r.stage === "M07" && goalSessionIds.get(r.runId)?.has(t.id))) && t.activity !== "ended" && now - Date.parse(t.lastSeenAt) <= this.limits.staleHeartbeatMs);
    const activeGoals: StageRunRecord[] = [];
    for (const run of runs.filter(r => r.stage === "M07" && r.status === "running")) {
      const goal = obj(await this.json(path.join(this.workspace, "stages", "M07", run.runId, "goal.json")));
      if (goal?.lifecycle === "active") activeGoals.push(run);
    }
    if (activeGoals.length > 1) warnings.push("存在多个 active M07 目标，请显式选择 goalRunId");
    const activeGoal = activeGoals.at(-1);
    let selected: StageRunRecord | undefined;
    if (options.goalRunId) selected = runs.find(r => r.stage === "M07" && r.runId === options.goalRunId);
    else if (options.stage && options.runId) selected = runs.find(r => r.stage === options.stage && r.runId === options.runId);
    else if (options.stage) selected = runs.filter(r => r.stage === options.stage).at(-1);
    else {
      const fresh = telemetry.filter(t => t.stage && t.runId && t.activity === "active" && now - Date.parse(t.lastSeenAt) <= this.limits.staleHeartbeatMs)
        .sort((a, b) => a.lastSeenAt.localeCompare(b.lastSeenAt));
      const current = fresh.at(-1);
      selected = current ? runs.find(r => r.stage === current.stage && r.runId === current.runId) : undefined;
      selected ??= activeGoal ?? runs.at(-1);
    }
    if ((options.goalRunId || options.runId) && !selected) warnings.push("所选运行不存在或不可读取");
    const latestByStage = new Map<string, StageRunRecord>();
    for (const run of runs) latestByStage.set(run.stage, run);
    for (const n of nodes) {
      const r = latestByStage.get(n.stage!); if (!r) continue;
      n.status = r.status === "running" && !freshFor(r) ? "unknown" : r.status;
    }
    const snapshot: WorkflowSnapshot = {
      workspace: { root: this.workspace, label: path.basename(this.workspace) }, generatedAt: new Date(now).toISOString(),
      currentStage: selected?.stage ?? (options.stage && STAGES.includes(options.stage) ? options.stage : undefined), currentRunId: selected?.runId, selected: selected ? { stage: selected.stage, runId: selected.runId } : undefined,
      nodes, events: [], runs: runs.map(r => ({ stage: r.stage, runId: r.runId,
        status: r.status === "running" && !freshFor(r) ? "unknown" : r.status,
        startedAt: r.startedAt, finishedAt: r.finishedAt, sessions: r.sessions?.length ?? 0, outputs: r.outputs?.length ?? 0, knowledgeSnapshot: r.knowledgeSnapshot })),
      knowledge: { frozen: selected?.knowledgeSnapshot }, audit: buildWorkflowAudit([], [], new Date(now).toISOString()), warnings,
    };
    const currentFile = path.join(this.workspace, ".agent", "knowledge", "CURRENT");
    try { const safe = await this.confined(currentFile); if (safe) snapshot.knowledge.current = (await readFile(safe, "utf8")).trim() || undefined; } catch { /* no publication yet */ }
    if (selected) {
      const runNode = this.runNode(selected);
      if (selected.status === "running" && !freshFor(selected)) { runNode.status = "unknown"; runNode.detail.push("运行记录为 running；未发现新鲜心跳，实时状态未知"); }
      nodes.push(runNode);
      snapshot.events.push({ at: selected.startedAt, summary: `${selected.stage} 开始`, nodeId: runNode.id });
      if (selected.finishedAt) snapshot.events.push({ at: selected.finishedAt, summary: `${selected.stage} ${selected.status}`, nodeId: runNode.id });
      if (selected.stage === "M07") await this.addGoal(snapshot, selected, telemetry, now);
      else await this.addStageSessions(snapshot, selected, bySession, telemetry, now);
      if (selected.stage === "M03") this.addM03(snapshot, selected);
      if (selected.stage === "M06") await this.addM06(snapshot, selected);
      if (selected.stage === "M08") await this.addM08(snapshot, selected);
      if (selected.stage === "M09") this.addM09(snapshot, selected);
    }
    // A second active goal is useful only in automatic current-work mode. An
    // explicit stage/run/goal selection must contain only the requested scope.
    if (activeGoal && activeGoal.runId !== selected?.runId && !options.goalRunId && !options.stage && !options.runId) {
      const runNode = this.runNode(activeGoal);
      if (!freshFor(activeGoal)) { runNode.status = "unknown"; runNode.detail.push("运行记录为 running；未发现新鲜心跳，实时状态未知"); }
      snapshot.nodes.push(runNode);
      await this.addGoal(snapshot, activeGoal, telemetry, now);
    }
    if (!options.stage || options.stage === "M07" || options.missionId)
      await this.addMissions(snapshot, runs, telemetry, now, options.missionId);
    await this.addUsage(snapshot);
    snapshot.audit = buildWorkflowAudit(await this.auditGoals(runs), snapshot.nodes, snapshot.generatedAt);
    snapshot.events.sort((a, b) => a.at.localeCompare(b.at));
    snapshot.events = snapshot.events.slice(-120);
    this.last = snapshot;
    return snapshot;
  }

  /** Every readable M07 goal in this workspace, not only the selected one: an
   * audit that only covered the current selection could not answer "how often
   * did the engine refuse what the agent accepted" across the whole run. */
  private async auditGoals(runs: readonly StageRunRecord[]): Promise<AuditGoalInput[]> {
    const goals: AuditGoalInput[] = [];
    for (const run of runs) {
      if (run.stage !== "M07") continue;
      const goal = await this.json(path.join(this.workspace, "stages", "M07", run.runId, "goal.json")) as CurrentGoal | undefined;
      if (goal?.runId === run.runId && Array.isArray(goal.tasks)) goals.push({ runId: run.runId, tasks: goal.tasks });
    }
    return goals;
  }

  private runNode(run: StageRunRecord): WorkflowNode {
    const visible = refs(run.outputs).filter(x => !/(?:message|prompt|rationale|出题说明|不转发)/i.test(`${x.label} ${x.path}`));
    return { id: `run:${run.stage}:${run.runId}`, parentId: `stage:${run.stage}`, label: `${run.stage} · ${run.runId}`, kind: "run", status: run.status, stage: run.stage, runId: run.runId,
      detail: [...(run.failures ?? []), ...(run.remarks ?? [])].map(clean), startedAt: run.startedAt, endedAt: run.finishedAt,
      outputRefs: visible, artifactRefs: visible, checks: [] };
  }
  private sessionNode(run: StageRunRecord, s: { id: string; label: string; model: string; file?: string }, telemetry: SessionTelemetry | undefined, now: number, parentId: string): WorkflowNode {
    const stale = telemetry && telemetry.activity !== "ended" && now - Date.parse(telemetry.lastSeenAt) > this.limits.staleHeartbeatMs;
    const status: ConsoleStatus = telemetry?.activity === "ended" ? telemetry.outcome === "failed" ? "failed" : telemetry.outcome === "aborted" ? "unknown" : "completed"
      : stale ? "stale" : telemetry?.activity === "active" ? "running" : telemetry?.activity === "idle" ? "waiting" : "unknown";
    return { id: `session:${s.id}`, parentId, label: clean(s.label), kind: "session", status, stage: run.stage, runId: run.runId, sessionId: s.id, model: s.model,
      detail: [telemetry ? `遥测：${telemetry.activity}${stale ? "（心跳过期）" : ""}` : "无运行时遥测"], startedAt: telemetry?.startedAt, endedAt: telemetry?.endedAt,
      lastSeenAt: telemetry?.lastSeenAt, outputRefs: s.file ? [{ label: "会话可见输出", path: s.file }] : [], artifactRefs: [], checks: [] };
  }
  private async addStageSessions(snap: WorkflowSnapshot, run: StageRunRecord, bySession: Map<string, SessionTelemetry>, telemetry: SessionTelemetry[], now: number): Promise<void> {
    const seen = new Set<string>();
    for (const s of run.sessions ?? []) {
      if (seen.has(s.id)) continue; seen.add(s.id);
      snap.nodes.push(this.sessionNode(run, s, bySession.get(s.id), now, `run:${run.stage}:${run.runId}`));
    }
    for (const t of telemetry.filter(x => x.stage === run.stage && x.runId === run.runId && !seen.has(x.id))) {
      seen.add(t.id);
      snap.nodes.push(this.sessionNode(run, { id: t.id, label: t.label, model: t.model ?? "" }, t, now, `run:${run.stage}:${run.runId}`));
    }
  }
  private async addGoal(snap: WorkflowSnapshot, run: StageRunRecord, telemetry: SessionTelemetry[], now: number): Promise<void> {
    const file = path.join(this.workspace, "stages", "M07", run.runId, "goal.json");
    const goal = await this.json(file) as CurrentGoal | undefined;
    if (!goal || goal.runId !== run.runId || !Array.isArray(goal.tasks)) {
      const size = await stat(file).then(x => x.size).catch(() => 0);
      snap.warnings.push(`M07/${run.runId} goal.json ${size > this.limits.maxJsonBytes ? `超过 ${this.limits.maxJsonBytes} 字节读取上限` : "不可读取或格式异常"}`); return;
    }
    const execution = goal.executionState;
    const attempt = execution?.attempts.find(a => a.id === execution.activeAttemptId);
    const recordedChecks = checkRows(goal.goalChecks);
    const checks = (goal.successCriteria ?? []).map(criterion => recordedChecks.find(x => x.criterion === criterion) ?? { criterion, result: "not_run", evidence: [] });
    for (const check of recordedChecks) if (!checks.some(x => x.criterion === check.criterion)) checks.push(check);
    const tasks = goal.tasks;
    const checkpoints: NonNullable<WorkflowSnapshot["goal"]>["checkpoints"] = [];
    for (const checkpoint of goal.checkpoints ?? []) {
      if (!/^C\d{3,}$/.test(checkpoint.id)) { snap.warnings.push(`M07/${run.runId} 的 checkpoint ID 无效`); continue; }
      const frozen = await this.checkpointProjection(path.join(this.workspace, "stages", "M07", run.runId, "checkpoints", checkpoint.id, "goal.json"));
      const selected = frozen?.selectedTaskIds;
      const omitted = frozen?.omittedTaskIds;
      const scopeValid = frozen?.runId === run.runId && frozen.updatedAt === checkpoint.sourceGoalUpdatedAt &&
        selected !== undefined && omitted !== undefined;
      if (!scopeValid) {
        snap.warnings.push(`M07/${run.runId} checkpoint ${checkpoint.id} 的冻结范围不可读取`);
      }
      checkpoints.push({ id: checkpoint.id, createdAt: checkpoint.createdAt, feedbackStatus: checkpoint.feedbackStatus,
        ...(scopeValid ? { selectedTaskIds: selected, omittedTaskIds: omitted } : {}) });
    }
    snap.goal = { id: goal.runId, title: clean(goal.goal), lifecycle: goal.lifecycle, outcome: goal.outcome,
      attemptId: attempt?.id, attemptState: attempt?.state,
      currentTaskId: goal.lifecycle === "active" ? tasks.findLast(t => t.status === "running")?.taskId : undefined,
      formalBaseline: goal.formalBaseline, m04BaselineRunId: goal.m04BaselineRunId, knowledgeSnapshot: goal.knowledgeSnapshot,
      baselineHistory: goal.baselineHistory, checkpoints, openDecisions: (goal.decisions ?? []).filter(d => d.status === "open").length, returnPath: goal.returnPath,
      checks: { total: checks.length, passed: checks.filter(c => c.result === "passed").length, failed: checks.filter(c => c.result === "failed").length, notRun: checks.filter(c => c.result === "not_run").length },
      tasks: { total: tasks.length, running: tasks.filter(t => t.status === "running").length, returned: tasks.filter(t => t.status === "returned").length,
        accepted: tasks.filter(t => t.status === "accepted").length, rejected: tasks.filter(t => t.status === "rejected").length,
        failed: tasks.filter(t => t.status === "failed").length, unknown: tasks.filter(t => t.status === "unknown").length },
      feedbackStatus: goal.feedbackStatus, stateRefs: [{ label: "目标控制记录", path: file }, ...(goal.feedbackPath ? [{ label: "反馈", path: goal.feedbackPath }] : [])] };
    const runNode = snap.nodes.find(n => n.id === `run:M07:${run.runId}`)!;
    runNode.checks = checks;
    runNode.detail.push(`目标：${clean(goal.goal)}`, `生命周期：${goal.lifecycle}`, `执行尝试：${attempt?.state ?? "未记录"}`);
    if (attempt?.state === "suspended") runNode.status = "suspended";
    else if (attempt?.state === "recovery-required") runNode.status = "blocked";
    else if (goal.lifecycle === "active" && runNode.status === "running" && (!attempt || attempt.state === "running") && !telemetry.some(x => ((x.stage === "M07" && x.runId === run.runId) || goal.tasks.some(t => t.session?.id === x.id)) && x.activity !== "ended" && now - Date.parse(x.lastSeenAt) <= this.limits.staleHeartbeatMs)) {
      runNode.status = "unknown"; snap.warnings.push("M07 记录仍为 active，但没有新鲜心跳；当前执行状态未知");
    }
    for (const saved of execution?.attempts ?? []) {
      const state: ConsoleStatus = saved.state === "suspended" ? "suspended" : saved.state === "recovery-required" ? "blocked" : "unknown";
      const node: WorkflowNode = { id: `attempt:${run.runId}:${saved.id}`, parentId: runNode.id,
        label: `执行尝试 ${saved.id}${saved.id === execution?.activeAttemptId ? " · 当前" : ""}`, kind: "attempt", status: state,
        stage: "M07", runId: run.runId, detail: [`存储状态：${saved.state}`, `代码来源：${saved.runDescriptor?.codeRevision ?? "未记录"}`,
          ...(saved.runDescriptor?.loadedSource ? [`已加载源码：${saved.runDescriptor.loadedSource.sourceRoot} @ ${saved.runDescriptor.loadedSource.sourceCommit}`] : []),
          ...(saved.stopReceipt ? [`停止回执：${saved.stopReceipt.reasonKind} @ ${saved.stopReceipt.observedAt}`] : [])].map(clean),
        startedAt: saved.startedAt, endedAt: saved.endedAt, outputRefs: saved.controlCheckpointPath ? [{ label: "控制检查点", path: saved.controlCheckpointPath }] : [], artifactRefs: [], checks: [] };
      if (saved.state === "running" && saved.id === execution?.activeAttemptId && runNode.status === "running") node.status = "running";
      snap.nodes.push(node);
    }
    const currentTask = tasks.findLast(task => task.status === "running") ?? tasks.at(-1);
    const archive = await candidateSearchSnapshot(goal, currentTask?.taskId);
    const candidates = archive.available, goalBest = archive.best;
    if (archive.all.length > candidates.length) runNode.detail.push(`有 ${archive.all.length - candidates.length} 个历史候选的冻结证据当前不可读取；原始记录保留，暂不参与最佳和搜索前沿。`);
    if (goalBest.length) runNode.detail.push(...goalBest.map(item =>
      `已归档且宿主核验的同口径候选观测最佳（不含无观测旧任务）：${item.candidateRef} · 对象 ${item.subjectId} · ${item.metric.name}=${item.metric.value} ${item.metric.unit}（${item.metric.basisId}）`).map(clean));
    if (candidates.length) {
      const search = candidateSearchBrief(archive.facts, candidates,
        candidateSearchFocus(candidates, currentTask?.subjectId));
      runNode.detail.push(...[
        `搜索观察：对象 ${search.focus.subjectId ?? "未知"} · 口径 ${search.focus.basisId ?? "全部（逐口径比较）"} · ${search.independentLeadCount} 条逐例前沿；复用同一外部评测只计一次`,
        ...search.leads.map(lead => `逐例线索：${lead.caseId} · ${lead.bindings.map(binding => `${binding.candidateRef}（${binding.solutionParentEligible ? "整体正确" : "仅此例通过"}）`).join("、")} · 外部评测 ${lead.externalId} · ${lead.independentCompetitors} 个不同评测对照；${lead.position === "uncontested" ? "尚无对照" : lead.position === "exclusive" ? "该例唯一前沿" : "该例存在权衡"}`),
        ...(search.omittedLeads ? [`其余 ${search.omittedLeads} 条线索可由 research_goal action=status、runId=${run.runId}、searchOffset=3 分页读取`] : []),
        ...search.repeatedSourceObservations.map(item => `同源码重复观测：对象 ${item.subjectId} · ${item.scope === "case" ? `用例 ${item.caseId}` : "整体"} · ${item.metric.name}（${item.metric.basisId}，${item.metric.unit}）· ${item.count} 个不同外部 ID · 最小 ${item.min} / 中位 ${item.median} / 最大 ${item.max} · 候选 ${item.candidateRefs.join("、")}${item.omittedCandidateRefs ? ` 等其余 ${item.omittedCandidateRefs} 个` : ""}`),
        ...(search.omittedRepeatedSourceObservations ? [`其余 ${search.omittedRepeatedSourceObservations} 组同源码观测可由 research_goal action=status、runId=${run.runId}、section=repeated-source 分页读取`] : []),
        ...(search.diagnosticRefs.length ? [`当前对象的诊断与负结果来源：${search.diagnosticRefs.join("、")}`] : []),
        "逐例优势不代表整体通过；同源码数值范围不说明噪声来源或因果收益，不同评测 ID 也不证明物理试验彼此独立。",
      ].map(clean));
    }
    const episodeObservations = new Map(tasks.flatMap(task => (task.episode?.candidates ?? [])
      .map(candidate => [`${task.taskId}/${candidate.id}`, candidate.observation] as const)));
    const availableCandidates = new Map(candidates.map(candidate => [candidate.ref, candidate] as const));
    const availableCandidateRefs = new Set(availableCandidates.keys());
    for (const t of tasks) {
      this.addTask(snap, run, t, telemetry, now, goalBest, episodeObservations,
        globalCandidateBest(candidates.filter(candidate => candidate.taskId === t.taskId)), availableCandidateRefs);
      await this.addCandidateExecutions(snap, run, t, availableCandidates);
    }
    const recorded = new Set(snap.nodes.filter(n => n.sessionId).map(n => n.sessionId));
    for (const tel of telemetry.filter(x => x.stage === "M07" && x.runId === run.runId && !recorded.has(x.id))) {
      snap.nodes.push(this.sessionNode(run, { id: tel.id, label: tel.label, model: tel.model ?? "" }, tel, now, runNode.id));
    }
    for (const d of goal.decisions ?? []) snap.events.push({ at: d.resolvedAt ?? d.requestedAt, summary: d.status === "open" ? "等待用户决定" : "用户决定已记录", nodeId: runNode.id });
    for (const checkpoint of goal.checkpoints ?? []) snap.nodes.push({ id: `checkpoint:${run.runId}:${checkpoint.id}`, parentId: runNode.id,
      label: `反馈 ${checkpoint.id}`, kind: "checkpoint", status: checkpoint.feedbackStatus === "complete" ? "completed" : "returned",
      stage: "M07", runId: run.runId, detail: [`回流状态：${checkpoint.feedbackStatus}`, "保存路径不是 M04 已完整阅读或科学采纳的证明"],
      outputRefs: checkpoint.feedbackPath ? [{ label: "冻结反馈", path: checkpoint.feedbackPath }] : [], artifactRefs: checkpoint.manifestPath ? [{ label: "证据清单", path: checkpoint.manifestPath }] : [], checks: [] });
    for (const selection of goal.branchSelections ?? []) {
      const parent = snap.nodes.find(n => n.id === `task:${run.runId}:${selection.parentTaskId}`);
      parent?.detail.push(`分支选择：${selection.selectedTaskId ?? "无"}；仅表示控制选择，仍需评测与目标复核`);
    }
  }
  /** Read the runner's durable intent, including evaluations not yet in the candidate archive. */
  private async addCandidateExecutions(snap: WorkflowSnapshot, run: StageRunRecord, task: M07TaskRecord,
    availableCandidates: ReadonlyMap<string, CandidateArchiveEntry>): Promise<void> {
    const root = path.join(this.workspace, "stages", "M07", run.runId, "tasks", task.taskId, "candidate-runs");
    const parentId = `task:${run.runId}:${task.taskId}`;
    const taskNode = snap.nodes.find(node => node.id === parentId)!;
    const status = (state: unknown): ConsoleStatus => state === "completed" || state === "passed" ? "completed" :
      state === "failed" ? "failed" : state === "pending" ? "waiting" : state === "prepared" ? "pending" :
      state === "running" && taskNode.status === "running" ? "running" : "unknown";
    const directories = async (dir: string) => (await readdir(dir, { withFileTypes: true }).catch(() => []))
      .filter(entry => entry.isDirectory() && !entry.isSymbolicLink()).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    const addRun = async (file: string, parent: string): Promise<void> => {
      const journal = obj(await this.json(file));
      if (!journal || journal.version !== 1 || journal.kind !== "candidate" ||
        journal.goalRunId !== run.runId || journal.taskId !== task.taskId || !str(journal.runId)) return;
      const id = `candidate-execution:${run.runId}:${task.taskId}:${journal.runId}`;
      const backend = obj(journal.backend), request = obj(journal.request);
      const parameters = obj(obj(request?.config)?.parameters);
      const sources = arr(journal.sources).map(obj).filter((source): source is Record<string, unknown> => !!source);
      const verified = obj(journal.evaluation);
      // A tool result's text names a candidate, but is not itself verification evidence.
      // Link only when the host journal's exact evaluated inputs identify that readable frozen entry.
      let linkedCandidate: CandidateArchiveEntry | undefined;
      try {
        const evaluation = obj(JSON.parse(str(verified?.text) ?? ""));
        const candidateRef = str(evaluation?.candidateRef);
        const entry = candidateRef && availableCandidates.get(candidateRef);
        const sourceRecords = arr(journal.sources);
        const sourcePaths = sourceRecords.map(item => str(obj(item)?.absolutePath));
        const final = obj(arr(journal.stages).at(-1));
        const finalStage = obj(final?.stage), finalResult = obj(final?.result);
        const declaredReceipts = finalResult?.evaluationReceiptPaths ??
          (arr(finalStage?.checks).includes("measurement") ? finalResult?.receiptPaths : undefined);
        const receiptRecords = arr(final?.receiptSnapshots).map(obj);
        const receiptPaths = arr(declaredReceipts).map(receipt =>
          str(receiptRecords.findLast(item => item?.originalPath === receipt)?.evaluationPath));
        if (entry && entry.taskId === task.taskId && str(obj(evaluation?.projection)?.fullObservationPath) === entry.observationPath &&
          sourcePaths.length > 0 && sourcePaths.every((item): item is string => !!item && inside(task.workDir, item)) &&
          receiptPaths.length > 0 && receiptPaths.every((item): item is string => !!item) &&
          JSON.stringify(sourcePaths.map(item => path.relative(task.workDir, item))) === JSON.stringify(entry.sourcePaths) &&
          JSON.stringify(receiptPaths) === JSON.stringify(entry.receiptPaths)) linkedCandidate = entry;
      } catch { /* No parseable exact archive binding; retain the execution record without a candidate link. */ }
      snap.nodes.push({ id, parentId: parent, label: clean(`候选执行 ${journal.runId}`), kind: "execution",
        status: status(journal.state), stage: "M07", runId: run.runId, taskId: task.taskId,
        startedAt: str(journal.createdAt), detail: [
          `执行状态：${journal.state}`, `后端：${backend?.id ?? "未知"}@${backend?.version ?? "未知"}`,
          `协议：${request?.protocolId ?? "未记录"}`, `关联操作：${journal.operationId ?? "未记录"}`,
          ...(parameters ? [`参数组合：${Object.entries(parameters).filter(([, value]) => typeof value === "number" && Number.isFinite(value)).map(([key, value]) => `${key}=${value}`).join("、")}`] : []),
          verified ? "候选核验已返回；任务复核与原目标验收另见相应节点" : "候选核验尚未返回",
          ...(linkedCandidate ? [`关联冻结候选 ${linkedCandidate.ref}；正确性以候选观测为准`] : []),
          ...(journal.evaluationError ? [`候选核验错误：${journal.evaluationError}`] : []),
        ].map(clean), outputRefs: [{ label: "候选执行原始记录", path: file },
          ...(linkedCandidate ? [{ label: `关联候选冻结观测 ${linkedCandidate.ref}`, path: linkedCandidate.observationPath }] : [])],
        artifactRefs: sources.flatMap(source => str(source.frozenPath) ? [{ label: `执行冻结源码 · ${source.declaredPath}`, path: str(source.frozenPath)! }] : []), checks: [] });
      const actual = arr(journal.stages).map(obj).filter((entry): entry is Record<string, unknown> => !!entry);
      for (const raw of arr(backend?.stages)) {
        const declared = obj(raw); if (!declared || !str(declared.id)) continue;
        const entry = actual.find(item => obj(item.stage)?.id === declared.id), result = obj(entry?.result);
        const performed = arr(result?.performedChecks);
        const receiptFiles = arr(entry?.receiptSnapshots).map(obj).flatMap(item => str(item?.frozenPath) ?
          [{ label: `冻结阶段回执 · ${path.basename(str(item!.frozenPath)!)}`, path: str(item!.frozenPath)! }] : []);
        const stopped = ["failed", "unknown", "pending"].includes(String(journal.state));
        snap.nodes.push({ id: `${id}:stage:${declared.id}`, parentId: id, label: clean(`验证阶段 ${declared.id}`), kind: "execution",
          status: entry ? status(entry.status) : "pending", stage: "M07", runId: run.runId, taskId: task.taskId,
          detail: [`执行方式：${declared.mode}`, `声明检查：${arr(declared.checks).join("、")}`,
            `已执行检查：${performed.join("、") || "未报告"}`,
            ...(entry?.externalId ? [`原始外部 ID：${entry.externalId}`] : []),
            ...(entry?.attempts ? [`已记录执行/查询次数：${entry.attempts}`] : []),
            ...(!entry && stopped ? ["前置阶段尚未通过，此阶段未执行"] : []),
            ...(entry?.error ? [`执行错误：${entry.error}`] : []),
            ...(result?.summary ? [String(result.summary)] : []),
          ].map(clean), outputRefs: receiptFiles, artifactRefs: [],
          checks: [{ criterion: `阶段 ${declared.id}`, evidence: receiptFiles.map(item => item.path),
            result: entry?.status === "passed" ? "passed" : entry?.status === "failed" ? "failed" : "not_run" }] });
      }
    };
    for (const entry of await directories(root)) {
      const dir = path.join(root, entry.name), file = path.join(dir, "journal.json");
      const journal = obj(await this.json(file));
      if (journal?.kind !== "sweep") { await addRun(file, parentId); continue; }
      let binding: unknown;
      try { binding = JSON.parse(str(journal.binding) ?? ""); } catch { continue; }
      if (!Array.isArray(binding) || binding[0] !== run.runId || binding[1] !== task.taskId) continue;
      const id = `candidate-sweep:${run.runId}:${task.taskId}:${entry.name}`;
      const complete = Number.isSafeInteger(journal.total) && Number(journal.total) > 0 && journal.nextIndex === journal.total;
      snap.nodes.push({ id, parentId, label: clean(`参数枚举 ${entry.name}`), kind: "execution", status: complete ? "completed" : "waiting",
        stage: "M07", runId: run.runId, taskId: task.taskId,
        detail: [`已执行组合：${journal.nextIndex}/${journal.total}`, "逐项检查与原始外部 ID 见子节点；枚举结束不代表原目标达标"],
        outputRefs: [{ label: "参数枚举原始记录", path: file }], artifactRefs: [], checks: [] });
      for (const child of await directories(path.join(dir, "runs"))) await addRun(path.join(dir, "runs", child.name, "journal.json"), id);
    }
  }
  private addTask(snap: WorkflowSnapshot, run: StageRunRecord, t: M07TaskRecord, telemetry: SessionTelemetry[], now: number,
    goalBest: ReadonlyArray<{ candidateRef: string; metric: CandidateMetricV1 }>,
    episodeObservations: ReadonlyMap<string, CandidateObservationV1>,
    taskBest: ReturnType<typeof globalCandidateBest>, availableCandidateRefs: ReadonlySet<string>): void {
    const id = `task:${run.runId}:${t.taskId}`;
    const parentId = t.parentTaskId ? `task:${run.runId}:${t.parentTaskId}` : `run:M07:${run.runId}`;
    const reportRefs = [t.reportPath, t.review?.frozenReportPath].filter((x): x is string => Boolean(x)).map((p, i) => ({ label: i === 0 ? "任务报告" : "冻结报告", path: p }));
    const artifactRefs = (t.review?.artifacts ?? []).map(a => ({ label: path.basename(a.path), path: a.path }));
    if (t.branchSource?.manifestPath) artifactRefs.push({ label: "候选冻结清单", path: t.branchSource.manifestPath });
    if (t.candidateObservation?.observationPath) artifactRefs.push({ label: "候选核验观测", path: t.candidateObservation.observationPath });
    const sessionTelemetry = t.session ? telemetry.find(x => x.id === t.session!.id) : undefined;
    const fresh = sessionTelemetry && sessionTelemetry.activity !== "ended" && now - Date.parse(sessionTelemetry.lastSeenAt) <= this.limits.staleHeartbeatMs;
    const taskStatus: ConsoleStatus = t.status === "running" && !fresh ? sessionTelemetry && sessionTelemetry.activity !== "ended" ? "stale" : "unknown" : t.status;
    const reviewedChecks = checkRows(t.review?.checks);
    const declaredChecks = [...new Set(arr(t.checks).filter((criterion): criterion is string => typeof criterion === "string"))];
    const taskChecks = declaredChecks.map(criterion => reviewedChecks.find(check => check.criterion === criterion) ??
      { criterion, result: "not_run", evidence: [] });
    for (const check of reviewedChecks) if (!taskChecks.some(row => row.criterion === check.criterion)) taskChecks.push(check);
    snap.nodes.push({ id, parentId, label: `${t.taskId} · ${clean(t.objective)}`, kind: "task", status: taskStatus, stage: "M07", runId: run.runId, taskId: t.taskId,
      detail: [`存储状态：${t.status}`, ...(t.supersedesTaskId ? [`接续候选：${t.supersedesTaskId}`] : []), ...(t.parentTaskId ? [`父任务：${t.parentTaskId}`] : []),
        ...(t.branchSource ? ["候选工作快照已冻结；接受与否仍以控制器复核为准"] : []), ...(t.review?.failures ?? []), ...(t.review?.limitations ?? []), ...(t.executionFailure ? [t.executionFailure] : [])].map(clean),
      startedAt: t.createdAt, endedAt: t.returnedAt, outputRefs: reportRefs, artifactRefs, checks: taskChecks });
    snap.events.push({ at: t.createdAt, summary: `任务 ${t.taskId} 已委派`, nodeId: id });
    if (t.returnedAt) snap.events.push({ at: t.returnedAt, summary: `任务 ${t.taskId} ${t.status}`, nodeId: id });
    if (t.review?.at) snap.events.push({ at: t.review.at, summary: `任务 ${t.taskId} ${t.status}`, nodeId: id });
    if (t.session) {
      snap.nodes.push(this.sessionNode(run, t.session, sessionTelemetry, now, id));
    }
    const candidateId = `candidate:${run.runId}:${t.taskId}`;
    if (t.candidate) snap.nodes.push({ id: candidateId, parentId: id, label: `候选声明 · ${t.taskId}`,
      kind: "candidate", status: t.candidateObservation ? "returned" : "unknown", stage: "M07", runId: run.runId, taskId: t.taskId,
      detail: [`候选意图：${t.candidate.intent ?? "solution"}`, `改动类别：${t.candidate.changeKind ?? "未声明"}`,
        `父候选任务：${t.candidate.parentTaskId ?? "无"}`, "声明路径不是已核验结果；核验另见子节点"].map(clean),
      outputRefs: t.candidate.receiptPaths.map(file => ({ label: `平台原回执 · ${file}`, path: t.workDir ? path.join(t.workDir, file) : file })),
      artifactRefs: t.candidate.sourcePaths.map(file => ({ label: `候选源码 · ${file}`, path: t.workDir ? path.join(t.workDir, file) : file })), checks: [] });
    if (t.episode) {
      const episode = t.episode;
      const episodeId = `episode:${run.runId}:${t.taskId}`;
      const byId = new Map(episode.candidates.map(candidate => [candidate.id, candidate]));
      const incumbentRows = taskBest.map(item => ({ candidateId: item.candidateRef.split("/")[1],
        metric: item.metric, subjectId: item.subjectId }));
      const localBest = (candidateId: string) => incumbentRows.filter(item => item.candidateId === candidateId);
      const overallBest = (candidateId: string) => goalBest.filter(item => item.candidateRef === `${t.taskId}/${candidateId}`);
      snap.nodes.push({ id: episodeId, parentId: id, label: `候选实验 · ${t.taskId}`, kind: "group",
        status: t.status === "running" ? taskStatus : episode.candidates.length ? "returned" : "pending",
        stage: "M07", runId: run.runId, taskId: t.taskId,
        detail: [`已冻结候选：${episode.candidates.length}`, `当前探索点：${episode.currentCandidateId ?? "无"}`,
          ...incumbentRows.map(item => `本 episode 局部最佳：${item.candidateId} · 对象 ${item.subjectId} · ${item.metric.name}=${item.metric.value} ${item.metric.unit}（${item.metric.basisId}）`),
          "局部最佳不代表整个目标的历史最佳、任务接受或原目标达标；任务状态另见父节点"].map(clean),
        outputRefs: incumbentRows.map(item => ({ label: `局部最佳 ${item.candidateId} 的冻结观测`, path: byId.get(item.candidateId)!.observationPath })),
        artifactRefs: [], checks: [] });
      for (const candidate of episode.candidates) {
        const nodeId = `episode-candidate:${run.runId}:${t.taskId}:${candidate.id}`;
        const parentRef = candidate.parentRef ?? (candidate.parentCandidateId && byId.has(candidate.parentCandidateId) ?
          { taskId: t.taskId, candidateId: candidate.parentCandidateId } : undefined);
        const parent = parentRef?.taskId === t.taskId && byId.has(parentRef.candidateId) ?
          `episode-candidate:${run.runId}:${t.taskId}:${parentRef.candidateId}` : episodeId;
        const observation = candidate.observation;
        const best = localBest(candidate.id);
        snap.nodes.push({ id: nodeId, parentId: parent, label: `候选 ${candidate.id}${candidate.id === episode.currentCandidateId ? " · 当前探索点" : ""}`,
          kind: "candidate", status: observation.correctness === "passed" ? "returned" : observation.correctness === "failed" ? "failed" : "unknown",
          stage: "M07", runId: run.runId, taskId: t.taskId,
          detail: [`假设：${candidate.hypothesis}`, `改动类别：${candidate.changeKind}`, `候选意图：${candidate.intent}`,
            ...(!availableCandidateRefs.has(`${t.taskId}/${candidate.id}`) ? ["冻结证据当前不可读取；以下路径为历史登记，不参与当前最佳和搜索前沿。"] : []),
            `父候选：${parentRef ? `${parentRef.taskId}/${parentRef.candidateId}` : candidate.parentCandidateId ?? "无"}`,
            ...(parentRef && parentRef.taskId !== t.taskId ? ["跨任务血缘为候选声明；本节点保留在当前任务实验下"] : []),
            ...((candidate.conditions ?? []).map(item => `声明条件：${item}`)),
            ...(candidate.changeSummary ? [`声明改动：${candidate.changeSummary}`] : []),
            ...(candidate.sourceRepetition || candidate.identicalSourceRefs?.length ?
              [`同源码事实：${candidate.sourceRepetition ?? "相同字节"}；匹配 ${candidate.identicalSourceRefs?.join("、") || "未记录"}`] : []),
            ...((candidate.parentComparison?.summary ?? []).map(item => `同口径父子比较：${item}`)),
            `阶段：${observation.stage}`, `源绑定：${observation.sourceBinding}`, `正确性：${observation.correctness}`,
            ...best.map(item => `本 episode 局部最佳：${item.metric.name}=${item.metric.value} ${item.metric.unit}（${item.metric.basisId}）`),
            ...overallBest(candidate.id).map(item => `已归档且宿主核验的同口径候选观测最佳：${item.metric.name}=${item.metric.value} ${item.metric.unit}（${item.metric.basisId}）；不含无观测旧任务`),
            "已返回的候选观测不代表控制器已接受任务或原目标达标"].map(clean),
          outputRefs: [{ label: "冻结候选观测", path: candidate.observationPath },
            ...receiptRefs(observation)],
          artifactRefs: observation.sourceFiles.map(file => ({ label: `冻结源码 · ${path.basename(file)}`, path: file })), checks: [] });
        snap.nodes.push({ id: `episode-evaluation:${run.runId}:${t.taskId}:${candidate.id}`, parentId: nodeId,
          label: `只读核验 · ${observation.verifier.id}`, kind: "evaluation",
          status: observation.correctness === "passed" ? "returned" : observation.correctness === "failed" ? "failed" : "unknown",
          stage: "M07", runId: run.runId, taskId: t.taskId,
          detail: [`评测范围：${observation.stage}`, `源绑定：${observation.sourceBinding}`, `正确性：${observation.correctness}`,
            ...externalEvaluationDetails(observation), ...diagnosticDetails(observation, candidate.parentComparison,
              parentRef ? episodeObservations.get(`${parentRef.taskId}/${parentRef.candidateId}`) : undefined),
            ...observation.metrics.map(metric => `${metric.name}：${metric.value} ${metric.unit}（${metric.basisId}，${metric.direction} 更优）`),
            ...observation.limitations, "候选观测仅属于本 episode；原任务与原目标仍需独立复核"].map(clean),
          outputRefs: [{ label: "冻结核验观测", path: candidate.observationPath },
            ...receiptRefs(observation)],
          artifactRefs: observation.sourceFiles.map(file => ({ label: path.basename(file), path: file })),
          checks: [...checkRows(observation.checks), ...checkRows(observation.goalChecks).map(check => ({ ...check, criterion: `原目标局部检查：${check.criterion}` }))] });
      }
    }
    for (const round of t.executionRounds ?? []) snap.nodes.push({ id: `round:${run.runId}:${t.taskId}:${round.index}`, parentId: id,
      label: `执行/复核轮 ${round.index}`, kind: "round", status: round.verdict === "blocked" ? "blocked" : round.verdict === "ready" ? "returned" : round.verdict ? "rejected" : "unknown",
      stage: "M07", runId: run.runId, taskId: t.taskId,
      detail: [`操作：${round.operationId}`, `复核意见：${round.verdict ?? "未记录"}`, ...(round.feedback ? [round.feedback] : [])].map(clean),
      startedAt: round.completedAt, outputRefs: [{ label: "执行报告", path: round.builderReportPath }, ...(round.reviewerReportPath ? [{ label: "轮次复核", path: round.reviewerReportPath }] : [])],
      artifactRefs: [], checks: [] });
    if (t.candidateObservation) {
      const observation = t.candidateObservation;
      const episodeSource = t.episode?.candidates.find(candidate => candidate.observationPath === observation.observationPath);
      snap.nodes.push({ id: `evaluation:${run.runId}:${t.taskId}`, parentId: t.candidate ? candidateId : id,
        label: episodeSource ? `最终声明复用 ${episodeSource.id} 观测` : `候选核验 · ${observation.verifier.id}`,
        kind: "evaluation", status: observation.correctness === "passed" ? "returned" : observation.correctness === "failed" ? "failed" : "unknown",
        stage: "M07", runId: run.runId, taskId: t.taskId,
        detail: [`源绑定：${observation.sourceBinding}`, `正确性：${observation.correctness}`, `评测范围：${observation.stage}`,
          ...(episodeSource ? [`来自 episode 候选 ${episodeSource.id} 的冻结观测；未再次评测`] : []),
          ...externalEvaluationDetails(observation), ...diagnosticDetails(observation, episodeSource?.parentComparison,
            episodeSource?.parentRef ? episodeObservations.get(`${episodeSource.parentRef.taskId}/${episodeSource.parentRef.candidateId}`) :
              episodeSource?.parentCandidateId ? episodeObservations.get(`${t.taskId}/${episodeSource.parentCandidateId}`) : undefined),
          ...observation.metrics.map(metric => `${metric.name}：${metric.value} ${metric.unit}（${metric.basisId}，${metric.direction} 更优）`),
          ...observation.limitations, "候选层检查不能单独证明原目标 fulfilled"].map(clean),
        outputRefs: [{ label: "控制器观测", path: observation.observationPath }, ...receiptRefs(observation)],
        artifactRefs: observation.sourceFiles.map(file => ({ label: path.basename(file), path: file })),
        checks: [...checkRows(observation.checks), ...checkRows(observation.goalChecks ?? []).map(check => ({ ...check, criterion: `原目标局部检查：${check.criterion}` }))] });
    }
    if (t.review) snap.nodes.push({ id: `review:${run.runId}:${t.taskId}`, parentId: id, label: "控制器任务复核", kind: "review",
      status: t.status === "accepted" ? "accepted" : t.status === "rejected" ? "rejected" : "returned", stage: "M07", runId: run.runId, taskId: t.taskId,
      detail: [`独立检查：${t.review.independentCheck?.taskId ?? "未登记"}`, ...(t.review.independentCheck?.disposition ? [t.review.independentCheck.disposition] : []), ...(t.review.failures ?? []), ...(t.review.limitations ?? [])].map(clean),
      startedAt: t.review.at, outputRefs: [...(t.review.frozenReportPath ? [{ label: "冻结复核报告", path: t.review.frozenReportPath }] : []),
        ...(t.review.independentCheck?.report ? [{ label: `独立核验 ${t.review.independentCheck.taskId}`, path: t.review.independentCheck.report }] : [])],
      artifactRefs, checks: checkRows(t.review.checks) });
    // Tool log entries are control records; a tool event is never represented as concurrent work.
    const toolLog = t.toolLog ?? [];
    const offset = Math.max(0, toolLog.length - this.limits.toolLogWindow);
    if (offset) snap.nodes.find(n => n.id === id)?.detail.push(`工具记录共 ${toolLog.length} 条；树中显示末 ${this.limits.toolLogWindow} 条，完整记录以目标控制文件为准`);
    for (const [i, raw] of toolLog.slice(offset).entries()) {
      const row = obj(raw); if (!row) continue;
      const name = str(row.toolName) ?? str(row.name) ?? str(row.tool) ?? "工具";
      const at = str(row.at) ?? str(row.startedAt);
      const persisted = str(row.status);
      const toolStatus: ConsoleStatus = persisted === "running" ? fresh ? "running" : sessionTelemetry && sessionTelemetry.activity !== "ended" ? "stale" : "unknown"
        : persisted === "error" || row.ok === false ? "failed" : row.ok === true ? "returned" : "unknown";
      snap.nodes.push({ id: `tool:${run.runId}:${t.taskId}:${offset + i}`, parentId: t.session ? `session:${t.session.id}` : id,
        label: clean(name), kind: "tool", status: toolStatus, stage: "M07", runId: run.runId, taskId: t.taskId,
        detail: [`存储状态：${persisted ?? "旧日志未记录"}`, `ok：${typeof row.ok === "boolean" ? row.ok : "未知"}`, ...(str(row.error) ? [str(row.error)!] : [])].map(clean), startedAt: at, endedAt: str(row.endedAt), outputRefs: [], artifactRefs: [], checks: [] });
    }
  }
  /** Mission status is authenticated by the existing local host; this projection never advances it. */
  private async addMissions(snap: WorkflowSnapshot, runs: StageRunRecord[], telemetry: SessionTelemetry[], now: number, selectedMissionId?: string): Promise<void> {
    const missionDirectory = path.join(this.workspace, ".agent", "missions");
    const entries = await readdir(missionDirectory, { withFileTypes: true }).catch(() => []);
    if (selectedMissionId && !entries.some(entry => entry.isDirectory() && !entry.isSymbolicLink() && entry.name === selectedMissionId))
      snap.warnings.push(`原目标 ${selectedMissionId} 不存在或不可读取`);
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || !/^[0-9a-f-]{36}$/i.test(entry.name) ||
          selectedMissionId && selectedMissionId !== entry.name) continue;
      let progress: ObjectiveProgressV1;
      try { progress = await openDefaultLocalMission({ workspaceRoot: this.workspace }).status(entry.name); }
      catch (error) { snap.warnings.push(`原目标 ${entry.name} 状态不可核验：${clean(String(error))}`); continue; }
      const missionId = `mission:${entry.name}`;
      const missionStatus: ConsoleStatus = progress.objectiveOutcome === "fulfilled" ? "completed" :
        progress.continuation.unresolvedOperationIds.length ? "blocked" : progress.stopReason ? "suspended" : "running";
      snap.nodes.push({ id: missionId, label: `原目标 · ${clean(progress.contract.goal)}`, kind: "mission", status: missionStatus,
        missionId: entry.name, detail: [`原目标结局：${progress.objectiveOutcome}`, `控制边界：${progress.stopReason ?? "无"}`,
          `未决操作：${progress.continuation.unresolvedOperationIds.join("、") || "无"}`,
          `后续动作：${progress.continuation.pendingAction?.kind ?? "无"}`, `闭合要求：${progress.contract.closure}`,
          "原合同义务（逐项核验结果未登记）：",
          ...progress.contract.obligations.map(o => `${o.id}：${o.description}`)].map(clean),
        startedAt: progress.contract.createdAt, outputRefs: [], artifactRefs: [], checks: [] });
      for (const [index, row] of progress.assessmentHistory.entries()) {
        snap.nodes.push({ id: `assessment:${entry.name}:${index}`, parentId: missionId, label: `原目标复核 ${row.iteration}`, kind: "assessment",
          status: row.advanced ? "returned" : "unknown", missionId: entry.name,
          detail: [`判断：${row.assessment.decision}`, `边界：${row.stopReason}`, row.assessment.rationale,
            `未决要求：${row.assessment.unresolvedObligations.join("；") || "无"}`].map(clean),
          outputRefs: [], artifactRefs: [], checks: [] });
      }
      const selectedSummary = snap.goal;
      for (const bounded of progress.boundedRuns) {
        const run = runs.find(r => r.stage === "M07" && r.runId === bounded.runId);
        const id = `run:M07:${bounded.runId}`;
        let node = snap.nodes.find(n => n.id === id);
        if (!node && run) {
          node = this.runNode(run); snap.nodes.push(node);
          await this.addGoal(snap, run, telemetry, now);
        }
        if (!node) {
          node = { id, label: `M07 · ${bounded.runId}`, kind: "run", status: "unknown", stage: "M07", runId: bounded.runId,
            detail: ["原目标记录引用的 M07 运行不可读取"], outputRefs: [], artifactRefs: [], checks: [] };
          snap.nodes.push(node);
        }
        node.parentId = missionId;
        node.detail.push(`原目标回执：${clean(bounded.outcome)}`, `已选任务：${bounded.selectedTaskId ?? "未选"}`,
          `已接受任务：${bounded.acceptedTaskIds?.join("、") || "无"}`);
      }
      snap.goal = selectedSummary;
      if (progress.pendingM04Review) {
        const pending = progress.pendingM04Review;
        snap.nodes.push({ id: `barrier:mission:${entry.name}:m04`, parentId: `run:M07:${pending.runId}`,
          label: `M04 待复核 · ${pending.taskId}`, kind: "barrier", status: "waiting", missionId: entry.name,
          detail: [`冻结反馈：${pending.checkpointId}`, `已有 M04 尝试：${pending.m04RunIds.join("、") || "无"}`, "已接受任务不等于 M04 科学采纳"],
          outputRefs: [], artifactRefs: [], checks: [] });
      }
      for (const run of runs.filter(r => r.stage === "M04")) {
        const source = obj(await this.json(path.join(this.workspace, "stages", "M04", run.runId, "m07-source.json")));
        const m07RunId = str(source?.m07RunId);
        if (!m07RunId || !progress.boundedRuns.some(row => row.runId === m07RunId)) continue;
        const id = `run:M04:${run.runId}`;
        let node = snap.nodes.find(n => n.id === id);
        if (!node) { node = this.runNode(run); snap.nodes.push(node); }
        node.parentId = `run:M07:${m07RunId}`;
        const transaction = obj(await this.json(path.join(this.workspace, "stages", "M04", run.runId, "m04-transaction.json")));
        const recordedState = transaction?.kind === "m04-knowledge-transaction" && transaction.m04RunId === run.runId ? str(transaction.state) : undefined;
        const transactionState = recordedState && ["no-proposal", "rejected-draft", "merge-intent", "merged", "unknown"].includes(recordedState) ? recordedState : undefined;
        const snapshotId = transactionState === "merged" ? str(transaction?.snapshotId) : undefined;
        node.detail.push(`源 M07：${m07RunId}`, `反馈 checkpoint：${str(source?.checkpointId) ?? "未知"}`,
          `运行结果：${run.status}；知识事务：${transactionState ?? "未登记"}`,
          snapshotId ? `已发布快照：${snapshotId}${snap.knowledge.current === snapshotId ? "（当前）" : "（非当前）"}` : "没有已确认的知识合并快照");
        if (transactionState && transactionState !== "merged") node.status = transactionState === "unknown" || transactionState === "merge-intent" ? "unknown" : run.status;
      }
    }
  }
  private addM03(snap: WorkflowSnapshot, run: StageRunRecord): void {
    const root = snap.nodes.find(x => x.id === `run:M03:${run.runId}`);
    root?.detail.push("执行次序：独立评审出题 → 原 M01 会话逐组串行回答 → 原评审会话逐组评价。阶段完成范围以登记输出为准。");
    for (const n of snap.nodes.filter(x => x.kind === "session" && x.stage === "M03")) n.detail.push(n.label === "M01" ? "原 M01 会话逐组串行回答；具体阶段以登记输出为准" : "同一评审会话用于出题和后续评价；具体阶段以登记输出为准");
  }
  private async addM06(snap: WorkflowSnapshot, run: StageRunRecord): Promise<void> {
    snap.nodes.find(x => x.id === `run:M06:${run.runId}`)?.detail.push("不同资料组可并行；每组内部依次阅读、核对、分析适用性，整批结束后汇总。");
    const batch = refs(run.outputs).find(x => x.label === "整批结构化结果");
    const rows = batch ? await this.json(batch.path) : undefined;
    for (const raw of arr(rows)) {
      const g = obj(raw); const sourceId = str(g?.sourceId); if (!sourceId) continue;
      const id = `group:${run.runId}:${sourceId}`;
      snap.nodes.push({ id, parentId: `run:M06:${run.runId}`, label: `${sourceId} · ${clean(str(g?.title) ?? "资料")}`, kind: "group",
        status: g?.status === "completed" ? "completed" : "failed", stage: "M06", runId: run.runId, detail: str(g?.failure) ? [clean(str(g?.failure)!)] : [],
        outputRefs: refs(g?.outputs), artifactRefs: [], checks: [] });
    }
    for (const n of snap.nodes.filter(x => x.kind === "session" && x.stage === "M06")) {
      const source = /^M06-(S\d+)-/.exec(n.label)?.[1];
      if (!source) continue;
      const groupId = `group:${run.runId}:${source}`;
      if (!snap.nodes.some(x => x.id === groupId)) snap.nodes.push({ id: groupId, parentId: `run:M06:${run.runId}`, label: source, kind: "group", status: "unknown", stage: "M06", runId: run.runId, detail: ["本轮结构化分组结果尚未登记"], outputRefs: [], artifactRefs: [], checks: [] });
      n.detail.push("本资料组内阅读 → 核对 → 适用性分析串行执行；与其他资料组可并行");
    }
    const groups = snap.nodes.filter(x => x.kind === "group" && x.stage === "M06" && x.runId === run.runId);
    for (const g of groups) {
      const source = g.id.split(":").at(-1)!;
      const sessions = snap.nodes.filter(x => x.kind === "session" && x.stage === "M06" && x.label.startsWith(`M06-${source}-`));
      const reading = sessions.find(x => x.label.endsWith("-reader"));
      const checking = sessions.find(x => x.label.endsWith("-checker"));
      const applicability = sessions.find(x => x.label.endsWith("-applicability"));
      const outputs = g.outputRefs;
      const readDone = outputs.some(x => x.label.includes("阅读记录"));
      const checkDone = outputs.some(x => x.label.includes("核对记录"));
      const readBarrier = `barrier:${run.runId}:${source}:read`, checkBarrier = `barrier:${run.runId}:${source}:check`;
      if (reading) reading.parentId = g.id;
      if (checking || applicability) {
        snap.nodes.push({ id: readBarrier, parentId: g.id, label: "阅读后核对", kind: "barrier", status: readDone ? "completed" : "unknown", stage: "M06", runId: run.runId,
          detail: [readDone ? "阅读产出已登记，科学质量仍待复核" : "尚无前序完成记录；后续会话存在不证明通过"], outputRefs: [], artifactRefs: [], checks: [] });
        if (checking) checking.parentId = readBarrier;
      }
      if (applicability) {
        snap.nodes.push({ id: checkBarrier, parentId: readBarrier, label: "核对后分析适用性", kind: "barrier", status: checkDone ? "completed" : "unknown", stage: "M06", runId: run.runId,
          detail: [checkDone ? "核对产出已登记，科学质量仍待复核" : "尚无前序完成记录；后续会话存在不证明通过"], outputRefs: [], artifactRefs: [], checks: [] });
        applicability.parentId = checkBarrier;
      }
    }
  }
  private async addM08(snap: WorkflowSnapshot, run: StageRunRecord): Promise<void> {
    const root = `run:M08:${run.runId}`;
    const bundle = refs(run.outputs).find(x => x.label === "M08 审查反馈结构");
    const data = bundle ? obj(await this.json(bundle.path)) : undefined;
    const selfs = arr(data?.selfChecks), reviews = arr(data?.reviews);
    const barrierStatus: ConsoleStatus = selfs.length && selfs.every(x => obj(x)?.status === "completed") ? "completed" : selfs.some(x => obj(x)?.status === "failed") ? "failed" : run.status === "running" ? "unknown" : "pending";
    const selfGroup = `group:${run.runId}:selfchecks`, barrier = `barrier:${run.runId}:selfcheck`;
    snap.nodes.push({ id: selfGroup, parentId: root, label: "独立自查批次", kind: "group", status: barrierStatus,
      stage: "M08", runId: run.runId, detail: ["自查成员可并行；全部成功后才启动外审"], outputRefs: [], artifactRefs: [], checks: [] });
    snap.nodes.push({ id: barrier, parentId: selfGroup, label: "全部自查成功后启动外审", kind: "barrier", status: barrierStatus,
      stage: "M08", runId: run.runId, detail: [], outputRefs: [], artifactRefs: [], checks: [] });
    for (const n of snap.nodes.filter(x => x.kind === "session" && x.stage === "M08")) n.parentId = n.label.includes("selfcheck") ? selfGroup : barrier;
    if (reviews.length && barrierStatus !== "completed") snap.warnings.push("M08 记录含外审，但自查 barrier 未显示完成，请核对原始记录");
  }

  private addM09(snap: WorkflowSnapshot, run: StageRunRecord): void {
    const root = `run:M09:${run.runId}`;
    const explanation = refs(run.outputs).some(x => x.label === "成果说明");
    const checker = snap.nodes.find(x => x.kind === "session" && x.stage === "M09" && x.label.includes("checker"));
    const organizer = snap.nodes.find(x => x.kind === "session" && x.stage === "M09" && x.label.includes("organizer"));
    snap.nodes.find(x => x.id === root)?.detail.push("先整理交付说明，再对交付副本执行复核；两个会话串行。");
    if (organizer) organizer.detail.push("整理说明先于交付复核；完成范围以登记成果说明为准");
    if (!checker) return;
    const barrier = `barrier:${run.runId}:explanation`;
    snap.nodes.push({ id: barrier, parentId: root, label: "成果说明完成后复核交付副本", kind: "barrier",
      status: explanation ? "completed" : "unknown", stage: "M09", runId: run.runId,
      detail: [explanation ? "成果说明已登记" : "尚无可见的成果说明登记；不能仅凭会话存在判定前序完成"], outputRefs: [], artifactRefs: [], checks: [] });
    checker.parentId = barrier;
  }

  private async addUsage(snap: WorkflowSnapshot): Promise<void> {
    // A resumed session can occur in several run records. Its sidecar remains one ledger.
    const seen = new Set<string>();
    for (const n of snap.nodes.filter(x => x.kind === "session" && x.sessionId)) {
      if (seen.has(n.sessionId!)) continue;
      seen.add(n.sessionId!);
      const output = n.outputRefs.find(x => x.path.endsWith(".jsonl"));
      if (!output) continue;
      const file = await this.confined(output.path.replace(/\.jsonl$/, ".usage.jsonl"));
      if (!file) continue;
      const truncated = (await stat(file)).size > this.limits.maxPreviewBytes;
      const raw = await this.tail(file);
      const rows = raw.split(/\r?\n/).map(line => { try { return obj(JSON.parse(line)); } catch { return undefined; } }).filter((x): x is Record<string, unknown> => Boolean(x));
      const unique = new Map<string, Record<string, unknown>>();
      let unidentified = 0;
      for (const row of rows) {
        if (row.sessionId !== n.sessionId) continue;
        for (const rawEvent of arr(row.events)) {
          const event = obj(rawEvent); if (!event) continue;
          const key = str(event.entryId);
          if (key) unique.set(key, event);
          else unidentified++;
        }
      }
      if (!unique.size && !unidentified) continue;
      const events = [...unique.values()];
      const num = (x: unknown) => typeof x === "number" && Number.isFinite(x) ? x : 0;
      const total = (field: string) => events.reduce((a, x) => a + num(obj(x.usage)?.[field]), 0);
      n.usage = { input: total("input"), output: total("output"), cacheRead: total("cacheRead"), cacheWrite: total("cacheWrite"), cost: total("cost"),
        complete: !truncated && unidentified === 0 && events.every(x => x.status === "reported"),
        costComplete: !truncated && unidentified === 0 && events.every(x => x.status === "reported" && x.costStatus === "priced"),
        reportedEvents: events.filter(x => x.status === "reported").length,
        unknownEvents: unidentified + events.filter(x => x.status !== "reported").length };
      if (truncated) n.detail.push("用量 sidecar 超出预览边界；显示的数值仅为已读末尾记录下界");
    }
  }

  async preview(nodeId: string, tab: "output" | "artifacts" | "checks" | "details"): Promise<string[]> {
    const node = this.last?.nodes.find(n => n.id === nodeId);
    if (!node) return ["请先读取快照并选择其中的节点"];
    if (tab === "details") return node.detail.map(clean);
    if (tab === "checks") return node.checks.map(c => `${c.result} · ${clean(c.criterion)}${c.evidence.length ? ` — ${c.evidence.map(clean).join("；")}` : ""}`);
    const refsToRead = tab === "artifacts" ? node.artifactRefs : node.outputRefs;
    if (!refsToRead.length) return ["没有登记的可见内容"];
    const lines: string[] = [];
    for (const r of refsToRead.slice(0, 12)) {
      lines.push(`【${clean(r.label)}】`);
      const safe = await this.confined(r.path);
      if (!safe) { lines.push("路径不在工作区内或不可读取"); continue; }
      if (safe.endsWith(".jsonl") && node.kind === "session") lines.push(...await this.sessionTail(safe));
      else if (/\.(md|txt|json|log|csv|tsv)$/i.test(safe)) lines.push(clean(await this.tail(safe)));
      else lines.push("二进制产物：已登记路径，无法在文本预览中显示");
    }
    return lines;
  }
  private async confined(file: string): Promise<string | undefined> {
    const target = path.resolve(this.workspace, file);
    if (!inside(this.workspace, target)) return undefined;
    try {
      const actualRoot = await realpath(this.workspace), actual = await realpath(target), s = await stat(actual);
      return inside(actualRoot, actual) && s.isFile() ? actual : undefined;
    } catch { return undefined; }
  }
  private async tail(file: string): Promise<string> {
    const s = await stat(file); const size = Math.min(this.limits.maxPreviewBytes, s.size);
    const handle = await open(file, "r");
    try {
      const buffer = Buffer.alloc(size); await handle.read(buffer, 0, size, s.size - size);
      let text = buffer.toString("utf8");
      if (s.size > size) { const i = text.indexOf("\n"); text = i >= 0 ? text.slice(i + 1) : ""; text = "…（仅显示末尾）\n" + text; }
      return text;
    } finally { await handle.close(); }
  }
  private async sessionTail(file: string): Promise<string[]> {
    const raw = await this.tail(file);
    const out: string[] = [];
    for (const line of raw.split(/\r?\n/)) {
      let row: Record<string, unknown> | undefined;
      try { row = obj(JSON.parse(line)); } catch { continue; }
      const message = obj(row?.message) ?? row;
      if (message?.role !== "assistant" && message?.role !== "toolResult") continue;
      const parts = arr(message.content).map(obj).filter((x): x is Record<string, unknown> => Boolean(x));
      const visible = parts.filter(x => x.type === "text").map(x => str(x.text)).filter((x): x is string => Boolean(x));
      if (typeof message.text === "string") visible.push(message.text);
      if (visible.length) out.push(clean(visible.join("\n")));
    }
    return out.slice(-20).length ? out.slice(-20) : ["最近记录中没有可见的 assistant/tool 文本"];
  }
}
