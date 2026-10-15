import { existsSync } from "node:fs";
import { open, readFile, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { CurrentGoal, M07TaskRecord } from "../m07/types.ts";
import type { SessionTelemetry } from "../runtime/telemetry.ts";
import type { StageRunRecord } from "../types.ts";
import type { ConsoleRef, ConsoleStatus, WorkflowNode, WorkflowSnapshot } from "./model.ts";

export type { WorkflowSnapshot, WorkflowNode } from "./model.ts";
export interface ReadOptions { goalRunId?: string; stage?: string; runId?: string; now?: number }
const STAGES = Array.from({ length: 9 }, (_, i) => `M${String(i + 1).padStart(2, "0")}`);
const MAX_JSON = 40_000_000;
const MAX_PREVIEW = 65_536;
const STALE_MS = 20_000;
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
  constructor(workspace: string) { this.workspace = path.resolve(workspace); }

  private async json(file: string): Promise<unknown | undefined> {
    try {
      const safe = await this.confined(file);
      if (!safe) return undefined;
      const s = await stat(safe);
      if (!s.isFile() || s.size > MAX_JSON) return undefined;
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
      if (!s.isFile() || s.size > MAX_JSON) return undefined;
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
          warnings.push(`${stage}/${ent.name} 的 run.json ${size > MAX_JSON ? `超过 ${MAX_JSON} 字节读取上限` : "不可读取或格式异常"}`);
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
    const freshFor = (r: StageRunRecord) => telemetry.some(t => ((t.stage === r.stage && t.runId === r.runId) || (r.stage === "M07" && goalSessionIds.get(r.runId)?.has(t.id))) && t.activity !== "ended" && now - Date.parse(t.lastSeenAt) <= STALE_MS);
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
      const fresh = telemetry.filter(t => t.stage && t.runId && t.activity === "active" && now - Date.parse(t.lastSeenAt) <= STALE_MS)
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
      knowledge: { frozen: selected?.knowledgeSnapshot }, warnings,
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
    await this.addUsage(snapshot);
    snapshot.events.sort((a, b) => a.at.localeCompare(b.at));
    snapshot.events = snapshot.events.slice(-120);
    this.last = snapshot;
    return snapshot;
  }

  private runNode(run: StageRunRecord): WorkflowNode {
    const visible = refs(run.outputs).filter(x => !/(?:message|prompt|rationale|出题说明|不转发)/i.test(`${x.label} ${x.path}`));
    return { id: `run:${run.stage}:${run.runId}`, parentId: `stage:${run.stage}`, label: `${run.stage} · ${run.runId}`, kind: "run", status: run.status, stage: run.stage, runId: run.runId,
      detail: [...(run.failures ?? []), ...(run.remarks ?? [])].map(clean), startedAt: run.startedAt, endedAt: run.finishedAt,
      outputRefs: visible, artifactRefs: visible, checks: [] };
  }
  private sessionNode(run: StageRunRecord, s: { id: string; label: string; model: string; file?: string }, telemetry: SessionTelemetry | undefined, now: number, parentId: string): WorkflowNode {
    const stale = telemetry && telemetry.activity !== "ended" && now - Date.parse(telemetry.lastSeenAt) > STALE_MS;
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
      snap.warnings.push(`M07/${run.runId} goal.json ${size > MAX_JSON ? `超过 ${MAX_JSON} 字节读取上限` : "不可读取或格式异常"}`); return;
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
      formalBaseline: goal.formalBaseline, m04BaselineRunId: goal.m04BaselineRunId, knowledgeSnapshot: goal.knowledgeSnapshot,
      baselineHistory: goal.baselineHistory, checkpoints, openDecisions: (goal.decisions ?? []).filter(d => d.status === "open").length, returnPath: goal.returnPath,
      checks: { total: checks.length, passed: checks.filter(c => c.result === "passed").length, failed: checks.filter(c => c.result === "failed").length, notRun: checks.filter(c => c.result === "not_run").length },
      tasks: { total: tasks.length, running: tasks.filter(t => t.status === "running").length, returned: tasks.filter(t => t.status === "returned").length,
        accepted: tasks.filter(t => t.status === "accepted").length, rejected: tasks.filter(t => t.status === "rejected").length,
        failed: tasks.filter(t => t.status === "failed").length, unknown: tasks.filter(t => t.status === "unknown").length },
      waiting: attempt?.waiting ? { reason: attempt.waiting.waitingReason ?? attempt.waiting.reasonKind, recoveryCondition: attempt.waiting.recoveryCondition, nextAction: attempt.waiting.nextAction, at: attempt.waiting.at } : undefined,
      feedbackStatus: goal.feedbackStatus, stateRefs: [{ label: "目标控制记录", path: file }, ...(goal.feedbackPath ? [{ label: "反馈", path: goal.feedbackPath }] : [])] };
    const runNode = snap.nodes.find(n => n.id === `run:M07:${run.runId}`)!;
    runNode.checks = checks;
    runNode.detail.push(`目标：${clean(goal.goal)}`, `生命周期：${goal.lifecycle}`, `执行尝试：${attempt?.state ?? "未记录"}`);
    if (attempt?.state === "waiting") runNode.status = "waiting";
    else if (attempt?.state === "suspended") runNode.status = "suspended";
    else if (attempt?.state === "recovery-required") runNode.status = "blocked";
    else if (goal.lifecycle === "active" && runNode.status === "running" && (!attempt || attempt.state === "running") && !telemetry.some(x => ((x.stage === "M07" && x.runId === run.runId) || goal.tasks.some(t => t.session?.id === x.id)) && x.activity !== "ended" && now - Date.parse(x.lastSeenAt) <= STALE_MS)) {
      runNode.status = "unknown"; snap.warnings.push("M07 记录仍为 active，但没有新鲜心跳；当前执行状态未知");
    }
    for (const t of tasks) this.addTask(snap, run, t, telemetry, now);
    const recorded = new Set(snap.nodes.filter(n => n.sessionId).map(n => n.sessionId));
    for (const tel of telemetry.filter(x => x.stage === "M07" && x.runId === run.runId && !recorded.has(x.id))) {
      snap.nodes.push(this.sessionNode(run, { id: tel.id, label: tel.label, model: tel.model ?? "" }, tel, now, runNode.id));
    }
    for (const d of goal.decisions ?? []) snap.events.push({ at: d.resolvedAt ?? d.requestedAt, summary: d.status === "open" ? "等待用户决定" : "用户决定已记录", nodeId: runNode.id });
    if (attempt?.waiting) snap.events.push({ at: attempt.waiting.at, summary: `等待：${clean(attempt.waiting.waitingReason ?? attempt.waiting.reasonKind)}`, nodeId: runNode.id });
  }
  private addTask(snap: WorkflowSnapshot, run: StageRunRecord, t: M07TaskRecord, telemetry: SessionTelemetry[], now: number): void {
    const id = `task:${run.runId}:${t.taskId}`;
    const parentId = t.parentTaskId ? `task:${run.runId}:${t.parentTaskId}` : `run:M07:${run.runId}`;
    const reportRefs = [t.reportPath, t.review?.frozenReportPath].filter((x): x is string => Boolean(x)).map((p, i) => ({ label: i === 0 ? "任务报告" : "冻结报告", path: p }));
    const artifactRefs = (t.review?.artifacts ?? []).map(a => ({ label: path.basename(a.path), path: a.path }));
    const sessionTelemetry = t.session ? telemetry.find(x => x.id === t.session!.id) : undefined;
    const fresh = sessionTelemetry && sessionTelemetry.activity !== "ended" && now - Date.parse(sessionTelemetry.lastSeenAt) <= STALE_MS;
    const taskStatus: ConsoleStatus = t.status === "running" && !fresh ? sessionTelemetry && sessionTelemetry.activity !== "ended" ? "stale" : "unknown" : t.status;
    snap.nodes.push({ id, parentId, label: `${t.taskId} · ${clean(t.objective)}`, kind: "task", status: taskStatus, stage: "M07", runId: run.runId, taskId: t.taskId,
      detail: [`存储状态：${t.status}`, ...(t.review?.failures ?? []), ...(t.review?.limitations ?? []), ...(t.executionFailure ? [t.executionFailure] : [])].map(clean),
      startedAt: t.createdAt, endedAt: t.returnedAt, outputRefs: reportRefs, artifactRefs, checks: checkRows(t.review?.checks) });
    snap.events.push({ at: t.createdAt, summary: `任务 ${t.taskId} 已委派`, nodeId: id });
    if (t.returnedAt) snap.events.push({ at: t.returnedAt, summary: `任务 ${t.taskId} ${t.status}`, nodeId: id });
    if (t.review?.at) snap.events.push({ at: t.review.at, summary: `任务 ${t.taskId} ${t.status}`, nodeId: id });
    if (t.session) {
      snap.nodes.push(this.sessionNode(run, t.session, sessionTelemetry, now, id));
    }
    // Tool log entries are control records; a tool event is never represented as concurrent work.
    const toolLog = t.toolLog ?? [];
    const offset = Math.max(0, toolLog.length - 100);
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
      const readDone = outputs.some(x => x.label.includes("阅读记录")) || Boolean(checking);
      const checkDone = outputs.some(x => x.label.includes("核对记录")) || Boolean(applicability);
      const readBarrier = `barrier:${run.runId}:${source}:read`, checkBarrier = `barrier:${run.runId}:${source}:check`;
      if (reading) reading.parentId = g.id;
      if (checking || applicability) {
        snap.nodes.push({ id: readBarrier, parentId: g.id, label: "阅读后核对", kind: "barrier", status: readDone ? "completed" : "unknown", stage: "M06", runId: run.runId,
          detail: [readDone ? "后续会话或阅读产出已登记" : "尚无前序完成记录"], outputRefs: [], artifactRefs: [], checks: [] });
        if (checking) checking.parentId = readBarrier;
      }
      if (applicability) {
        snap.nodes.push({ id: checkBarrier, parentId: readBarrier, label: "核对后分析适用性", kind: "barrier", status: checkDone ? "completed" : "unknown", stage: "M06", runId: run.runId,
          detail: [checkDone ? "后续会话或核对产出已登记" : "尚无前序完成记录"], outputRefs: [], artifactRefs: [], checks: [] });
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
      const truncated = (await stat(file)).size > MAX_PREVIEW;
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
    const s = await stat(file); const size = Math.min(MAX_PREVIEW, s.size);
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
