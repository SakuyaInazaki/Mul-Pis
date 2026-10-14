/** Fixed host for a source-backed I development search. It never evaluates protected G or activates source. */
import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { resolveRoleModel } from "../config.ts";
import type { LoadedSourceV1 } from "../runtime/loaded-source.ts";
import type { SessionRef, SessionRunner, UsageSummary } from "../runner/types.ts";
import { HarnessError } from "../types.ts";
import { Workspace, writeFileAtomic } from "../workspace.ts";
import { openWorkflowImproverProcess } from "./workflow-improver-process.ts";
import { parseModelJson } from "./model-json.ts";
import { verifyPreparedWorkflowSource } from "./workflow-source-arm.ts";
import type { SourceSearchCandidateV1, SourceSearchEvaluationV1, WorkflowImproverActionV1, WorkflowImproverStateV1 } from "./workflow-improver-types.ts";

export interface WorkflowSourceEditTargetV1 {
 kind: "H-executor" | "I-improver"; objective: string; writableFiles: string[];
}

export interface WorkflowSourceSearchInput {
 workspaceRoot: string; persistDir: string; receiptPath: string;
 source: LoadedSourceV1; improverVersionId: string; runner: SessionRunner;
 /** Trusted caller freezes the actual source-edit goal and builder allowlist for model analysis. */
 editTarget: WorkflowSourceEditTargetV1;
 /** Trusted, frozen origin of this development comparison; copied into the selection receipt. */
 baseline: { bundleId: string; executorVersionId: string; executorSource: LoadedSourceV1; developmentSetId: string };
 /** Frozen development material already selected by the trusted caller. No private G fields. */
 development: Array<{ id: string; text: string }>;
 proposeSource(request: { brief: string; model: string; editTarget: WorkflowSourceEditTargetV1; evidence: Array<{ id: string; text: string }>;
  modelObservations: WorkflowImproverStateV1["modelObservations"]; signal: AbortSignal;
  recordUsage(usage: UsageSummary): void }): Promise<SourceSearchCandidateV1>;
 evaluateDevelopment(request: { candidate: SourceSearchCandidateV1; inspectedDevelopment: WorkflowImproverStateV1["inspectedDevelopment"];
  signal: AbortSignal; recordUsage(usage: UsageSummary): void }): Promise<SourceSearchEvaluationV1>;
 /** Mandatory caller-owned cancellation; the host never invents a search quota. */
 signal: AbortSignal;
 /** Trusted control-layer gate before a provider call, source edit proposal, or development evaluation. */
 beforeOperation?: () => Promise<void>;
}
export interface WorkflowSourceSearchReceipt {
 version: 1; runId: string; status: "running" | "selected" | "no-winner" | "incomplete"; reason?: string;
 source: LoadedSourceV1; improverVersionId: string;
 baseline: WorkflowSourceSearchInput["baseline"]; editTarget: WorkflowSourceEditTargetV1;
 program: { pid: number; modulePath: string; exportName: string; source: LoadedSourceV1 };
 model: string; developmentIds: string[]; state: WorkflowImproverStateV1;
 actions: Array<{ index: number; action: WorkflowImproverActionV1; outcome: "pending" | "completed" | "failed"; reason?: string; resultId?: string;
  usage?: UsageSummary[]; operationReceiptPath?: string }>;
 modelSessions: Array<{ id: string; session?: SessionRef; usage?: UsageSummary; status: "returned" | "parse-error" | "provider-failed" }>;
 candidates: SourceSearchCandidateV1[]; evaluations: SourceSearchEvaluationV1[];
 selectedCandidateId?: string; selectionReceiptPath?: string;
 usage: { observed: UsageSummary[]; totals: { input: number; output: number; cacheRead: number; cacheWrite: number;
  totalTokens: number; cost: number }; usageUnknown: boolean; costComplete: boolean };
}

function nonempty(value: unknown, field: string): string {
 if (typeof value !== "string" || !value.trim()) throw new HarnessError("improvement.source-search", `${field} must be nonempty text`);
 return value;
}
function ids(value: unknown, field: string): string[] {
 if (!Array.isArray(value) || !value.every(item => typeof item === "string" && item.length > 0) ||
  new Set(value).size !== value.length) throw new HarnessError("improvement.source-search", `${field} must contain distinct IDs`);
 return value;
}
function validateAction(input: unknown): WorkflowImproverActionV1 {
 if (!input || typeof input !== "object" || Array.isArray(input)) throw new HarnessError("improvement.source-search", "I program returned no action object");
 const item = input as Record<string, unknown>;
 const fields = (allowed: string[]) => {
  if (Object.keys(item).some(key => !allowed.includes(key))) throw new HarnessError("improvement.source-search", "I program returned unknown action fields");
 };
 if (item.kind === "inspect-development") { fields(["kind", "id"]); return { kind: "inspect-development", id: nonempty(item.id, "evidence ID") }; }
 if (item.kind === "ask-model") { fields(["kind", "prompt", "evidenceIds", "observationIds", "format"]);
  if (item.format !== "json" && item.format !== "text") throw new HarnessError("improvement.source-search", "model response format must be json or text");
  return { kind: "ask-model", prompt: nonempty(item.prompt, "model prompt"), evidenceIds: ids(item.evidenceIds, "model evidence IDs"),
   ...(item.observationIds === undefined ? {} : { observationIds: ids(item.observationIds, "prior model observation IDs") }), format: item.format };
 }
 if (item.kind === "propose-source") { fields(["kind", "brief", "evidenceIds"]);
  return { kind: "propose-source", brief: nonempty(item.brief, "source brief"), evidenceIds: ids(item.evidenceIds, "proposal evidence IDs") };
 }
 if (item.kind === "evaluate-development") { fields(["kind", "candidateId"]);
  return { kind: "evaluate-development", candidateId: nonempty(item.candidateId, "candidate ID") };
 }
 if (item.kind === "stop") { fields(["kind", "candidateId", "reason"]);
  return { kind: "stop", ...(item.candidateId === undefined ? {} : { candidateId: nonempty(item.candidateId, "selected candidate ID") }),
   reason: nonempty(item.reason, "stop reason") };
 }
 throw new HarnessError("improvement.source-search", "I program returned unsupported action");
}
function checkUsage(receipt: WorkflowSourceSearchReceipt, usage: UsageSummary | undefined): void {
 if (!usage) { receipt.usage.usageUnknown = true; receipt.usage.costComplete = false; return; }
 if (["input", "output", "cacheRead", "cacheWrite", "totalTokens", "cost", "reportedEvents", "unknownEvents"]
  .some(field => !Number.isFinite(usage[field as keyof UsageSummary] as number) || (usage[field as keyof UsageSummary] as number) < 0) ||
  typeof usage.complete !== "boolean" || typeof usage.costComplete !== "boolean") {
  receipt.usage.usageUnknown = true; receipt.usage.costComplete = false; return;
 }
 receipt.usage.observed.push(usage);
 for (const field of ["input", "output", "cacheRead", "cacheWrite", "totalTokens", "cost"] as const)
  receipt.usage.totals[field] += usage[field];
 if (!usage.complete || usage.unknownEvents > 0) receipt.usage.usageUnknown = true;
 if (!usage.costComplete) receipt.usage.costComplete = false;
}
function finishCallbackUsage(receipt: WorkflowSourceSearchReceipt, reported: UsageSummary[], aggregate: UsageSummary,
 record: WorkflowSourceSearchReceipt["actions"][number]): void {
 if (!reported.length) { checkUsage(receipt, aggregate); record.usage = [aggregate]; return; }
 // A callback may report each settled provider call early to preserve costs on failure.
 // Its final summary must reconcile exactly with that already-observed ledger.
 const fields = ["input", "output", "cacheRead", "cacheWrite", "totalTokens", "cost", "reportedEvents", "unknownEvents"] as const;
 if (fields.some(field => reported.reduce((total, item) => total + item[field], 0) !== aggregate[field]) ||
  aggregate.complete !== reported.every(item => item.complete) ||
  aggregate.costComplete !== reported.every(item => item.costComplete)) {
  receipt.usage.usageUnknown = true; receipt.usage.costComplete = false;
 }
}
async function assertReceiptFile(file: string): Promise<void> {
 if (!path.isAbsolute(file)) throw new HarnessError("improvement.source-search", "operation receipt path must be absolute");
 const info = await lstat(file);
 if (!info.isFile() || info.isSymbolicLink()) throw new HarnessError("improvement.source-search", "operation receipt is missing or indirect");
}

/** One I lineage and one independent state. All callbacks are trusted host operations keyed by registered IDs. */
export async function runWorkflowSourceSearch(input: WorkflowSourceSearchInput): Promise<WorkflowSourceSearchReceipt> {
 const ws = new Workspace(input.workspaceRoot);
 if (!input.signal || typeof input.signal.aborted !== "boolean")
  throw new HarnessError("improvement.source-search", "caller-owned cancellation signal is required");
 const config = await ws.loadConfig();
 const model = resolveRoleModel(config, "improver");
 if (!input.improverVersionId.trim()) throw new HarnessError("improvement.source-search", "I version ID is required");
 const editTarget = input.editTarget;
 if (!editTarget || !["H-executor", "I-improver"].includes(editTarget.kind) ||
  typeof editTarget.objective !== "string" || !editTarget.objective.trim() ||
  !Array.isArray(editTarget.writableFiles) || !editTarget.writableFiles.length ||
  new Set(editTarget.writableFiles).size !== editTarget.writableFiles.length ||
  editTarget.writableFiles.some(file => typeof file !== "string" || !file.trim() || path.isAbsolute(file) ||
   file.split(/[\\/]/).some(part => !part || part === "." || part === "..")))
  throw new HarnessError("improvement.source-search", "trusted source edit target and relative writable files are required");
 if (!input.baseline?.bundleId?.trim() || !input.baseline.executorVersionId?.trim() ||
  !input.baseline.executorSource?.sourceRoot || !input.baseline.executorSource?.sourceCommit || !input.baseline.developmentSetId?.trim())
  throw new HarnessError("improvement.source-search", "frozen baseline bundle, executor source, and development set are required");
 const development = new Map<string, string>();
 for (const item of input.development) {
  if (!item.id.trim() || development.has(item.id) || typeof item.text !== "string")
   throw new HarnessError("improvement.source-search", "development evidence IDs must be distinct and frozen text");
  development.set(item.id, item.text);
 }
 await mkdir(path.dirname(input.receiptPath), { recursive: true });
 await mkdir(input.persistDir, { recursive: true });
 const process = await openWorkflowImproverProcess(input.source, input.improverVersionId, input.signal);
 const state: WorkflowImproverStateV1 = { version: 1, improverVersionId: input.improverVersionId,
  availableDevelopmentIds: [...development.keys()], inspectedDevelopment: [], modelObservations: [], candidates: [], evaluations: [], operationFailures: [] };
 const receipt: WorkflowSourceSearchReceipt = { version: 1, runId: randomUUID(), status: "running", source: input.source,
  improverVersionId: input.improverVersionId, baseline: structuredClone(input.baseline), editTarget: structuredClone(editTarget),
  program: { pid: process.pid, modulePath: process.modulePath, exportName: process.exportName, source: process.binding },
  model, developmentIds: [...development.keys()], state, actions: [], modelSessions: [], candidates: [], evaluations: [],
  usage: { observed: [], totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 },
   usageUnknown: false, costComplete: true } };
 const save = () => writeFileAtomic(input.receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
 const inspected = (requested: string[]) => requested.map(id => {
  const item = state.inspectedDevelopment.find(entry => entry.id === id);
  if (!item) throw new HarnessError("improvement.source-search", `I cited development evidence before reading it: ${id}`);
  return item;
 });
 await save();
 try {
  for (;;) {
   if (input.signal?.aborted) { receipt.status = "incomplete"; receipt.reason = "source search cancelled"; break; }
   let action: WorkflowImproverActionV1;
   try { action = validateAction(await process.decide(structuredClone(state))); }
   catch (error) { receipt.status = "incomplete"; receipt.reason = `source I decision failed: ${(error as Error).message}`; break; }
   state.lastAction = action;
   const record: WorkflowSourceSearchReceipt["actions"][number] = { index: receipt.actions.length, action, outcome: "pending" };
   receipt.actions.push(record);
   await save();
   try {
    if (action.kind === "inspect-development") {
     const text = development.get(action.id);
     if (text === undefined) throw new HarnessError("improvement.source-search", "I requested unregistered development evidence");
     if (state.inspectedDevelopment.some(item => item.id === action.id)) throw new HarnessError("improvement.source-search", "I requested development evidence already inspected");
     state.inspectedDevelopment.push({ id: action.id, text }); record.resultId = action.id;
    } else if (action.kind === "ask-model") {
     await input.beforeOperation?.();
     inspected(action.evidenceIds);
     const priorObservations = (action.observationIds ?? []).map(id => {
      const observation = state.modelObservations.find(item => item.id === id);
      if (!observation) throw new HarnessError("improvement.source-search", `I cited an unknown prior model observation: ${id}`);
      return observation;
     });
     const id = `analysis-${receipt.modelSessions.length + 1}`;
     let session: Awaited<ReturnType<SessionRunner["create"]>> | undefined;
     const onAbort = () => { void session?.abort(); };
     input.signal?.addEventListener("abort", onAbort, { once: true });
     try {
      session = await input.runner.create({ label: `I-source-${receipt.runId}-${id}`, role: "improver", model,
       systemPrompt: `You are analyzing a research workflow SOURCE CODE improvement for the ${editTarget.kind}. The trusted builder may edit only ${editTarget.writableFiles.join(", ")}. Objective: ${editTarget.objective}. Use the supplied development observations to identify a source-code failure mechanism, a concrete edit direction, a predicted development observation, and a falsifier. Development evidence and its references are observations, not the source-code candidate or a knowledge-record proposal. Distinguish required outcome checks from diagnostic observations; do not treat every false diagnostic as an edit target. If the I request asks for a candidate brief in JSON, include a top-level brief string describing the source edit hypothesis. Return the format requested by the I program. Protected confirmation results are unavailable.`,
       tools: { kind: "none" }, persistDir: input.persistDir, methodBinding: { versionId: input.improverVersionId } });
      if (input.signal?.aborted) { await session.abort(); throw new Error("source search cancelled before model prompt"); }
      const turn = await session.prompt(JSON.stringify({ prompt: action.prompt, editTarget, evidence: inspected(action.evidenceIds), priorObservations }));
      const observation: WorkflowImproverStateV1["modelObservations"][number] = { id, prompt: action.prompt, evidenceIds: action.evidenceIds, format: action.format, status: "returned", text: turn.text };
      if (action.format === "json") {
       try { observation.parsed = parseModelJson(turn.text); }
       catch (error) { observation.status = "parse-error"; observation.error = (error as Error).message; }
      }
      state.modelObservations.push(observation);
      const usage = session.usageSummary(); checkUsage(receipt, usage); record.usage = [usage];
      receipt.modelSessions.push({ id, session: session.ref, usage, status: observation.status });
      record.resultId = id;
     } catch (error) {
      const reason = (error as Error).message;
      receipt.usage.usageUnknown = true; receipt.usage.costComplete = false;
      const usage = session?.usageSummary(); if (usage) { checkUsage(receipt, usage); record.usage = [usage]; }
      state.modelObservations.push({ id, prompt: action.prompt, evidenceIds: action.evidenceIds, format: action.format, status: "provider-failed", error: reason });
      receipt.modelSessions.push({ id, ...(session ? { session: session.ref } : {}), ...(usage ? { usage } : {}), status: "provider-failed" });
      record.outcome = "failed"; record.reason = reason; record.resultId = id;
     } finally { input.signal?.removeEventListener("abort", onAbort); session?.dispose(); }
    } else if (action.kind === "propose-source") {
     await input.beforeOperation?.();
     const evidence = inspected(action.evidenceIds);
     const reportedUsage: UsageSummary[] = [];
     const recordUsage = (usage: UsageSummary) => { checkUsage(receipt, usage); reportedUsage.push(usage); record.usage = [...reportedUsage]; };
     const candidate = await input.proposeSource({ brief: action.brief, model, editTarget, evidence,
      modelObservations: structuredClone(state.modelObservations), signal: input.signal, recordUsage });
     if (!candidate.id.trim() || receipt.candidates.some(item => item.id === candidate.id) ||
      !["ready", "not-ready"].includes(candidate.status) || !candidate.receiptPath.trim() ||
      (candidate.status === "ready" && (!candidate.sourceRoot || !path.isAbsolute(candidate.sourceRoot) ||
       !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(candidate.sourceCommit ?? ""))))
      throw new HarnessError("improvement.source-search", "source proposal returned an invalid or duplicate candidate");
     await assertReceiptFile(candidate.receiptPath);
     record.operationReceiptPath = candidate.receiptPath;
     if (candidate.status === "ready") {
      const sourceReceipt = JSON.parse(await readFile(candidate.receiptPath, "utf8")) as { status?: string; engineeringStatus?: string;
       sourceCommit?: string; snapshot?: LoadedSourceV1 };
      if (sourceReceipt.status !== "committed" || sourceReceipt.engineeringStatus !== "passed" ||
       sourceReceipt.sourceCommit !== candidate.sourceCommit || sourceReceipt.snapshot?.sourceRoot !== candidate.sourceRoot ||
       sourceReceipt.snapshot?.sourceCommit !== candidate.sourceCommit)
       throw new HarnessError("improvement.source-search", "ready candidate lacks a committed, engineering-passed source receipt");
      await verifyPreparedWorkflowSource({ sourceRoot: candidate.sourceRoot!, sourceCommit: candidate.sourceCommit! });
     }
     receipt.candidates.push(candidate);
     state.candidates.push({ id: candidate.id, status: candidate.status, ...(candidate.sourceCommit ? { sourceCommit: candidate.sourceCommit } : {}),
      ...(candidate.reason ? { reason: candidate.reason } : {}) });
     finishCallbackUsage(receipt, reportedUsage, candidate.usage, record);
     record.resultId = candidate.id;
    } else if (action.kind === "evaluate-development") {
     await input.beforeOperation?.();
     const candidate = receipt.candidates.find(item => item.id === action.candidateId);
     if (!candidate || receipt.evaluations.some(item => item.candidateId === action.candidateId) || candidate.status !== "ready")
      throw new HarnessError("improvement.source-search", "I requested evaluation of an unregistered, repeated, or unready candidate");
     const reportedUsage: UsageSummary[] = [];
     const recordUsage = (usage: UsageSummary) => { checkUsage(receipt, usage); reportedUsage.push(usage); record.usage = [...reportedUsage]; };
     const result = await input.evaluateDevelopment({ candidate, inspectedDevelopment: structuredClone(state.inspectedDevelopment), signal: input.signal, recordUsage });
     if (result.candidateId !== action.candidateId || !["preferred", "rejected", "unknown"].includes(result.status) || !result.reason.trim() || !result.receiptPath.trim())
      throw new HarnessError("improvement.source-search", "development evaluator returned an unbound result");
     await assertReceiptFile(result.receiptPath);
     record.operationReceiptPath = result.receiptPath;
     receipt.evaluations.push(result);
     state.evaluations.push({ candidateId: result.candidateId, status: result.status, reason: result.reason });
     finishCallbackUsage(receipt, reportedUsage, result.usage, record);
     record.resultId = result.candidateId;
    } else {
     if (action.candidateId) {
      const candidate = receipt.candidates.find(item => item.id === action.candidateId);
      if (!candidate || candidate.status !== "ready" || !receipt.evaluations.some(item => item.candidateId === action.candidateId))
       throw new HarnessError("improvement.source-search", "I selected a candidate not registered and development-evaluated in this search");
      if (!receipt.usage.usageUnknown && receipt.usage.costComplete) receipt.selectedCandidateId = action.candidateId;
     }
     receipt.status = receipt.usage.usageUnknown || !receipt.usage.costComplete ? "incomplete" : action.candidateId ? "selected" : "no-winner";
     receipt.reason = receipt.usage.usageUnknown ? "search usage did not settle completely" :
      !receipt.usage.costComplete ? "search estimated provider cost did not settle completely" : action.reason;
     record.outcome = "completed";
     if (receipt.status !== "incomplete") {
      const selectionReceiptPath = `${input.receiptPath}.selection.json`;
      await writeFile(selectionReceiptPath, `${JSON.stringify({ version: 1, runId: receipt.runId, source: receipt.source,
       improverVersionId: receipt.improverVersionId, baseline: receipt.baseline, editTarget: receipt.editTarget, program: receipt.program, status: receipt.status,
       selectedCandidateId: receipt.selectedCandidateId ?? null, candidateReceiptPath: receipt.candidates.find(item => item.id === action.candidateId)?.receiptPath ?? null,
       developmentEvaluationReceiptPath: receipt.evaluations.find(item => item.candidateId === action.candidateId)?.receiptPath ?? null,
       developmentIds: receipt.developmentIds, inspectedDevelopmentIds: state.inspectedDevelopment.map(item => item.id),
       actions: receipt.actions, modelSessions: receipt.modelSessions, candidates: receipt.candidates,
       evaluations: receipt.evaluations, usage: receipt.usage, frozenAt: new Date().toISOString() }, null, 2)}\n`,
       { flag: "wx", mode: 0o600 });
      receipt.selectionReceiptPath = selectionReceiptPath;
     }
     break;
    }
    if (record.outcome === "pending") record.outcome = "completed";
   } catch (error) {
    record.outcome = "failed"; record.reason = (error as Error).message;
    state.operationFailures.push({ kind: action.kind, reason: record.reason });
    if (action.kind === "stop") { receipt.status = "incomplete"; receipt.reason = record.reason;
     receipt.selectedCandidateId = undefined; receipt.selectionReceiptPath = undefined; break; }
    if (action.kind === "propose-source" || action.kind === "evaluate-development") {
     receipt.usage.usageUnknown = true; receipt.usage.costComplete = false;
    }
   }
   await save();
  }
 } finally { await process.close(); await save(); }
 return receipt;
}
