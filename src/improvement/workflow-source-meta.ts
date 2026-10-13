/** Fixed parent-side comparison of two actually loaded I programs through their H offspring. */
import { lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { resolveRoleModel } from "../config.ts";
import { createFileKnowledgeStore } from "../knowledge/store.ts";
import type { LoadedSourceV1 } from "../runtime/loaded-source.ts";
import type { SessionRunner, UsageSummary } from "../runner/types.ts";
import { HarnessError } from "../types.ts";
import { Workspace, writeFileAtomic } from "../workspace.ts";
import { GenerationStore, type ActiveGenerationPointerV1 } from "./generation.ts";
import type { SourceCandidateReceipt } from "./source-candidate.ts";
import { assertFirstWorkflowSourceAllowlist, verifyPreparedWorkflowSource } from "./workflow-source-arm.ts";
import type { WorkflowSourceDecisionDeclarationV2, WorkflowSourceDecisionV2, WorkflowSourcePairV2 } from "./workflow-source-confirmation.ts";
import { runWorkflowSourceSearch, type WorkflowSourceSearchInput, type WorkflowSourceSearchReceipt } from "./workflow-source-search.ts";

const I_FILE = "src/improvement/workflow-improver-program.ts";
const H_FILE = "src/m07/feedback.ts";
type Arm = "old" | "candidate";
type SearchCall = Pick<WorkflowSourceSearchInput, "proposeSource" | "evaluateDevelopment">;
type ProtectedArmInput = { caseId: string; repetition: number; executionOrder: WorkflowSourcePairV2["executionOrder"];
 side: "baseline" | "candidate"; result: NonNullable<WorkflowSourcePairV2["baseline"]> };
export interface WorkflowSourceMetaPlanV1 {
 version: 1; kind: "workflow-source-meta/v1"; baselineBundleId: string;
 baseline: { executorVersionId: string; improverVersionId: string; executorSource: LoadedSourceV1;
  knowledgeSnapshot: string | null; modelConfig: { improver: string; research: string }; developmentSetId: string };
 candidate: { versionId: string; source: LoadedSourceV1; candidateReceiptPath: string };
 searchReplicates: number;
 /** Predeclared paired protected schedule, rather than a host-chosen statistical threshold. */
 protectedSchedule: Array<{ caseId: string; repetition: number; executionOrder: ["baseline", "candidate"] | ["candidate", "baseline"] }>;
 decisionRule: WorkflowSourceDecisionDeclarationV2;
}
export interface WorkflowSourceMetaSearchV1 {
 replicate: number; arm: Arm; source: LoadedSourceV1; searchPath: string;
 search?: WorkflowSourceSearchReceipt; searchCopyPath?: string; selectionCopyPath?: string;
 candidateReceiptCopyPath?: string; developmentEvaluationReceiptCopyPath?: string;
 offspringSource?: LoadedSourceV1; noWinner?: boolean; error?: string;
}
export interface WorkflowSourceMetaRunV1 {
 version: 1; kind: "workflow-source-meta-run/v1"; runId: string; status: "running" | "complete" | "inconclusive";
 plan: WorkflowSourceMetaPlanV1; activePointer: ActiveGenerationPointerV1; startedAt: string; finishedAt?: string;
 searchOrder: Arm[][]; searches: WorkflowSourceMetaSearchV1[]; allSelectionsFrozenAt?: string;
 protectedOpenedAt?: string; protectedPairs: WorkflowSourcePairV2[]; protectedReceiptPath?: string;
 decision?: WorkflowSourceDecisionV2; reason?: string;
 usageScope: "search-provider-offspring-execution-and-reported-protected-evaluator-provider";
 costs: { searchObserved: UsageSummary[]; searchCost: number; offspringExecutionEstimatedCost: number;
  protectedEvaluatorObserved: UsageSummary[]; protectedEvaluatorCost: number; protectedEvaluatorUsageComplete: boolean; complete: boolean };
}
export interface WorkflowSourceMetaInput {
 workspaceRoot: string; runRoot: string; persistDir: string; runner: SessionRunner; signal: AbortSignal;
 /** Service-owned live pointer/K/reference gate, called before every external operation. */
 beforeOperation?: () => Promise<void>;
 plan: WorkflowSourceMetaPlanV1; development: Array<{ id: string; text: string }>;
 /** Trusted callbacks receive the common frozen H/K and no protected G data. */
 searchCallbacks(context: { arm: Arm; replicate: number; sharedH: LoadedSourceV1; knowledgeSnapshot: string | null }): SearchCall;
 /** Invoked only after every independent search and its selection are copied. */
 evaluateProtectedOffspring(context: { runId: string; schedule: WorkflowSourceMetaPlanV1["protectedSchedule"];
  searches: WorkflowSourceMetaSearchV1[]; sharedH: LoadedSourceV1; knowledgeSnapshot: string | null;
  recordArm(input: ProtectedArmInput): Promise<void>;
  recordPair(pair: WorkflowSourcePairV2): Promise<void>; recordEvaluatorUsage(usage: UsageSummary): Promise<void>;
  signal: AbortSignal }): Promise<{ receiptPath: string; evaluatorUsageComplete: boolean }>;
 decider(input: { declaration: WorkflowSourceDecisionDeclarationV2; pairs: readonly WorkflowSourcePairV2[];
  searches: readonly WorkflowSourceMetaSearchV1[]; costs: WorkflowSourceMetaRunV1["costs"] }): Promise<WorkflowSourceDecisionV2>;
}

function sameSource(a: LoadedSourceV1, b: LoadedSourceV1): boolean {
 return a.sourceRoot === b.sourceRoot && a.sourceCommit === b.sourceCommit;
}
async function sourceFiles(root: string): Promise<Map<string, Buffer>> {
 const files = new Map<string, Buffer>();
 const walk = async (dir: string, relative: string): Promise<void> => {
  for (const name of await readdir(dir)) {
   if (!relative && ["node_modules", ".venv", ".workflow-source.json"].includes(name)) continue;
   const rel = relative ? `${relative}/${name}` : name, file = path.join(dir, name), info = await lstat(file);
   if (info.isSymbolicLink()) throw new HarnessError("improvement.source-meta", "prepared source contains an unexpected symlink");
   if (info.isDirectory()) await walk(file, rel);
   else if (info.isFile()) files.set(rel, await readFile(file));
   else throw new HarnessError("improvement.source-meta", "prepared source contains a non-file entry");
  }
 };
 await walk(root, ""); return files;
}
export async function assertOnlyIChange(oldSource: LoadedSourceV1, candidate: LoadedSourceV1): Promise<void> {
 await verifyPreparedWorkflowSource(oldSource); await verifyPreparedWorkflowSource(candidate);
 const oldFiles = await sourceFiles(oldSource.sourceRoot), newFiles = await sourceFiles(candidate.sourceRoot);
 let changed = false;
 for (const name of new Set([...oldFiles.keys(), ...newFiles.keys()])) {
  const before = oldFiles.get(name), after = newFiles.get(name);
  if (before?.equals(after ?? Buffer.alloc(0)) && after) continue;
  if (name !== I_FILE) throw new HarnessError("improvement.source-meta", `candidate I changed fixed source: ${name}`);
  changed = true;
 }
 if (!changed) throw new HarnessError("improvement.source-meta", "candidate I source is unchanged");
}
async function regularFile(file: string): Promise<string> {
 if (!path.isAbsolute(file)) throw new HarnessError("improvement.source-meta", "receipt path must be absolute");
 const info = await lstat(file);
 if (!info.isFile() || info.isSymbolicLink() || info.size > 8 * 1024 * 1024)
  throw new HarnessError("improvement.source-meta", "receipt is missing, indirect, or too large");
 return readFile(file, "utf8");
}
function assertPlan(plan: WorkflowSourceMetaPlanV1): void {
 if (plan.version !== 1 || plan.kind !== "workflow-source-meta/v1" || !plan.baselineBundleId?.trim() ||
  !plan.baseline?.executorVersionId?.trim() || !plan.baseline.improverVersionId?.trim() ||
  !plan.baseline.developmentSetId?.trim() || !plan.candidate?.versionId?.trim() ||
  !Number.isSafeInteger(plan.searchReplicates) || plan.searchReplicates < 1 ||
  !plan.decisionRule?.id?.trim() || !plan.decisionRule.parameters ||
  !Array.isArray(plan.protectedSchedule) || !plan.protectedSchedule.length)
  throw new HarnessError("improvement.source-meta", "meta plan lacks explicit baseline, replicated searches, protected schedule, or decision rule");
 const keys = new Set<string>();
 for (const pair of plan.protectedSchedule) {
  const key = `${pair.caseId}/${pair.repetition}`;
  if (!pair.caseId?.trim() || !Number.isSafeInteger(pair.repetition) || pair.repetition < 0 || keys.has(key) ||
   !Array.isArray(pair.executionOrder) || pair.executionOrder.length !== 2 ||
   !(["baseline", "candidate"].every(arm => pair.executionOrder.includes(arm as "baseline" | "candidate"))))
   throw new HarnessError("improvement.source-meta", "protected schedule must contain distinct paired cases and explicit order");
  keys.add(key);
 }
 for (let replicate = 0; replicate < plan.searchReplicates; replicate++)
  if (!plan.protectedSchedule.some(item => item.repetition === replicate))
   throw new HarnessError("improvement.source-meta", "every independent I search pair needs protected offspring cases");
 if (plan.protectedSchedule.some(item => item.repetition >= plan.searchReplicates))
  throw new HarnessError("improvement.source-meta", "protected repetition has no independent I search pair");
}
function selectionSource(search: WorkflowSourceSearchReceipt, sharedH: LoadedSourceV1): LoadedSourceV1 {
 if (search.status === "no-winner") return sharedH;
 const picked = search.candidates.find(item => item.id === search.selectedCandidateId);
 if (search.status !== "selected" || !picked?.sourceRoot || !picked.sourceCommit || picked.status !== "ready" ||
  !search.evaluations.some(item => item.candidateId === picked.id) || !search.selectionReceiptPath)
  throw new HarnessError("improvement.source-meta", "search has no settled selected H offspring");
 return { sourceRoot: picked.sourceRoot, sourceCommit: picked.sourceCommit };
}
function pairKey(pair: { caseId: string; repetition: number }): string { return `${pair.caseId}/${pair.repetition}`; }

/** This run evaluates I only through protected outcomes of the H versions each I actually selected. */
export async function runWorkflowSourceMetaComparison(input: WorkflowSourceMetaInput): Promise<WorkflowSourceMetaRunV1> {
 assertPlan(input.plan);
 if (!input.signal || typeof input.signal.aborted !== "boolean") throw new HarnessError("improvement.source-meta", "caller cancellation signal is required");
 const ws = new Workspace(input.workspaceRoot), store = new GenerationStore(input.workspaceRoot);
 const active = await store.active();
 if (!active || active.bundle.bundleId !== input.plan.baselineBundleId) throw new HarnessError("improvement.source-meta", "active bundle differs from meta baseline");
 const [h, oldI, newI, config, currentK] = await Promise.all([
  store.readStrategy(active.bundle.executorVersionId), store.readStrategy(active.bundle.improverVersionId),
  store.readStrategy(input.plan.candidate.versionId), ws.loadConfig(), createFileKnowledgeStore(ws.knowledgeDir).current()]);
 const baseline = input.plan.baseline;
 const developmentIds = new Set(input.development.map(item => item.id));
 if (developmentIds.size !== input.development.length || input.plan.protectedSchedule.some(item => developmentIds.has(item.caseId)))
  throw new HarnessError("improvement.source-meta", "development IDs must be distinct and separate from protected cases");
 if (active.bundle.executorVersionId !== baseline.executorVersionId || active.bundle.improverVersionId !== baseline.improverVersionId ||
  active.bundle.knowledgeSnapshot !== (baseline.knowledgeSnapshot ?? undefined) || (currentK?.id ?? null) !== baseline.knowledgeSnapshot ||
  JSON.stringify(active.bundle.modelConfig) !== JSON.stringify(baseline.modelConfig) ||
  resolveRoleModel(config, "improver") !== baseline.modelConfig.improver || resolveRoleModel(config, "research") !== baseline.modelConfig.research ||
  h.artifact.kind !== "source-executor" || oldI.artifact.kind !== "source-improver" || newI.artifact.kind !== "source-improver" ||
  newI.kind !== "improver" || newI.parentVersionId !== oldI.versionId || newI.origin !== "agent-generated" || newI.state !== "research-only" ||
  h.artifact.sourceRoot !== baseline.executorSource.sourceRoot || h.artifact.sourceCommit !== baseline.executorSource.sourceCommit ||
  newI.artifact.sourceRoot !== input.plan.candidate.source.sourceRoot || newI.artifact.sourceCommit !== input.plan.candidate.source.sourceCommit)
  throw new HarnessError("improvement.source-meta", "active H/I/K/model or candidate I lineage differs from the frozen plan");
 const oldSource: LoadedSourceV1 = { sourceRoot: oldI.artifact.sourceRoot, sourceCommit: oldI.artifact.sourceCommit };
 await assertOnlyIChange(oldSource, input.plan.candidate.source);
 await verifyPreparedWorkflowSource(baseline.executorSource);
 const candidateReceipt = JSON.parse(await regularFile(input.plan.candidate.candidateReceiptPath)) as SourceCandidateReceipt;
 if (candidateReceipt.status !== "committed" || candidateReceipt.engineeringStatus !== "passed" || !candidateReceipt.session ||
  candidateReceipt.parentCommit !== oldSource.sourceCommit || candidateReceipt.sourceCommit !== input.plan.candidate.source.sourceCommit ||
  candidateReceipt.snapshot?.sourceRoot !== input.plan.candidate.source.sourceRoot ||
  JSON.stringify(candidateReceipt.changedFiles) !== JSON.stringify([I_FILE]) ||
  JSON.stringify(candidateReceipt.writableFiles) !== JSON.stringify([I_FILE]) || !candidateReceipt.diff?.trim())
  throw new HarnessError("improvement.source-meta", "candidate I lacks a checked model-generated single-module source receipt");
 const dir = path.resolve(input.runRoot);
 const runId = path.basename(dir);
 if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(runId))
  throw new HarnessError("improvement.source-meta", "runRoot basename must be a registered safe run ID");
 if (await lstat(dir).catch(() => undefined)) throw new HarnessError("improvement.source-meta", "meta run root already exists");
 await mkdir(dir, { recursive: true });
 const run: WorkflowSourceMetaRunV1 = { version: 1, kind: "workflow-source-meta-run/v1", runId, status: "running",
  plan: structuredClone(input.plan), activePointer: active.pointer, startedAt: new Date().toISOString(), searchOrder: [], searches: [], protectedPairs: [],
  usageScope: "search-provider-offspring-execution-and-reported-protected-evaluator-provider",
  costs: { searchObserved: [], searchCost: 0, offspringExecutionEstimatedCost: 0,
   protectedEvaluatorObserved: [], protectedEvaluatorCost: 0, protectedEvaluatorUsageComplete: false, complete: false } };
 const save = () => writeFileAtomic(path.join(dir, "run.json"), `${JSON.stringify(run, null, 2)}\n`);
 await writeFile(path.join(dir, "plan.json"), `${JSON.stringify(input.plan, null, 2)}\n`, { flag: "wx", mode: 0o600 });
 await writeFile(path.join(dir, "candidate-I-receipt.private.json"), `${JSON.stringify(candidateReceipt, null, 2)}\n`, { flag: "wx", mode: 0o600 });
 await save();
 try {
  for (let replicate = 0; replicate < input.plan.searchReplicates; replicate++) {
   const order: Arm[] = replicate % 2 === 0 ? ["old", "candidate"] : ["candidate", "old"];
   run.searchOrder.push(order); await save();
   for (const arm of order) {
    const source = arm === "old" ? oldSource : input.plan.candidate.source;
    const searchPath = path.join(dir, `search-${replicate}-${arm}.json`);
    const entry: WorkflowSourceMetaSearchV1 = { replicate, arm, source, searchPath };
    run.searches.push(entry); await save();
    try {
     const callbacks = input.searchCallbacks({ arm, replicate, sharedH: baseline.executorSource, knowledgeSnapshot: baseline.knowledgeSnapshot });
     await input.beforeOperation?.();
     const search = await runWorkflowSourceSearch({ workspaceRoot: input.workspaceRoot, persistDir: path.join(input.persistDir, `${replicate}-${arm}`),
      receiptPath: searchPath, source, improverVersionId: arm === "old" ? oldI.versionId : newI.versionId,
      baseline: { bundleId: input.plan.baselineBundleId, executorVersionId: baseline.executorVersionId,
       executorSource: baseline.executorSource, developmentSetId: baseline.developmentSetId },
      development: structuredClone(input.development), runner: input.runner, signal: input.signal,
      beforeOperation: input.beforeOperation,
      proposeSource: async request => {
       const proposed = await callbacks.proposeSource(request);
       const raw = JSON.parse(await regularFile(proposed.receiptPath)) as SourceCandidateReceipt;
       if (raw.parentCommit !== baseline.executorSource.sourceCommit ||
        (proposed.status === "ready" && (raw.status !== "committed" || raw.engineeringStatus !== "passed" ||
         JSON.stringify(raw.changedFiles) !== JSON.stringify([H_FILE]) || JSON.stringify(raw.writableFiles) !== JSON.stringify([H_FILE]))))
        throw new HarnessError("improvement.source-meta", "I arm proposed H from a different parent or changed a fixed module");
       if (proposed.status === "ready" && proposed.sourceRoot && proposed.sourceCommit)
        await assertFirstWorkflowSourceAllowlist(baseline.executorSource, { sourceRoot: proposed.sourceRoot, sourceCommit: proposed.sourceCommit });
       return proposed;
      }, evaluateDevelopment: callbacks.evaluateDevelopment });
     entry.search = search;
     const searchText = await regularFile(searchPath);
     entry.searchCopyPath = path.join(dir, `frozen-search-${replicate}-${arm}.json`);
     await writeFile(entry.searchCopyPath, searchText, { flag: "wx", mode: 0o600 });
     run.costs.searchObserved.push(...search.usage.observed);
     run.costs.searchCost += search.usage.totals.cost;
     if ((search.status === "selected" || search.status === "no-winner") && search.selectionReceiptPath &&
      search.usage.costComplete && search.model === baseline.modelConfig.improver) {
      entry.selectionCopyPath = path.join(dir, `frozen-selection-${replicate}-${arm}.json`);
      await writeFile(entry.selectionCopyPath, await regularFile(search.selectionReceiptPath), { flag: "wx", mode: 0o600 });
      entry.offspringSource = selectionSource(search, baseline.executorSource);
      entry.noWinner = search.status === "no-winner";
      if (search.status === "selected") {
       const picked = search.candidates.find(item => item.id === search.selectedCandidateId)!;
       const evaluated = search.evaluations.find(item => item.candidateId === picked.id)!;
       const candidateText = await regularFile(picked.receiptPath);
       const candidate = JSON.parse(candidateText) as SourceCandidateReceipt;
       if (!candidate.session || !candidate.diff?.trim() || candidate.parentCommit !== baseline.executorSource.sourceCommit ||
        candidate.sourceCommit !== picked.sourceCommit || candidate.snapshot?.sourceRoot !== picked.sourceRoot ||
        JSON.stringify(candidate.changedFiles) !== JSON.stringify([H_FILE]) ||
        JSON.stringify(candidate.writableFiles) !== JSON.stringify([H_FILE]))
        throw new HarnessError("improvement.source-meta", "selected H lacks a model session and frozen single-module diff");
       const evaluationText = await regularFile(evaluated.receiptPath);
       entry.candidateReceiptCopyPath = path.join(dir, `frozen-H-candidate-${replicate}-${arm}.json`);
       entry.developmentEvaluationReceiptCopyPath = path.join(dir, `frozen-development-evaluation-${replicate}-${arm}.json`);
       await writeFile(entry.candidateReceiptCopyPath, candidateText, { flag: "wx", mode: 0o600 });
       await writeFile(entry.developmentEvaluationReceiptCopyPath, evaluationText, { flag: "wx", mode: 0o600 });
      }
     } else entry.error = search.reason ?? "I search did not produce a complete selection";
    } catch (error) { entry.error = error instanceof Error ? error.message : String(error); }
    await save();
   }
  }
  if (run.searches.length !== input.plan.searchReplicates * 2 || run.searches.some(item => !item.selectionCopyPath || !item.offspringSource || item.error)) {
   run.status = "inconclusive"; run.reason = "one or more independent I searches did not settle completely"; return run;
  }
  run.allSelectionsFrozenAt = new Date().toISOString(); await save();
  await input.beforeOperation?.();
  run.protectedOpenedAt = new Date().toISOString(); await save();
  const recorded = new Map<string, WorkflowSourcePairV2>(), childPids = new Set<number>(), armWorkspaces = new Set<string>();
  let protectedClosed = false;
  const expected = new Map(input.plan.protectedSchedule.map(item => [pairKey(item), item]));
  const recordArm = async ({ caseId, repetition, executionOrder, side, result }: ProtectedArmInput): Promise<void> => {
   if (protectedClosed) throw new HarnessError("improvement.source-meta", "protected comparison is already settled");
   const key = pairKey({ caseId, repetition }), scheduled = expected.get(key);
   if (!scheduled || JSON.stringify(executionOrder) !== JSON.stringify(scheduled.executionOrder))
    throw new HarnessError("improvement.source-meta", "protected offspring pair differs from the frozen schedule");
   const pair = recorded.get(key) ?? { caseId, repetition, executionOrder };
   if (pair[side]) throw new HarnessError("improvement.source-meta", "protected offspring arm was already recorded");
   {
     const arm = side === "baseline" ? "old" : "candidate";
     const found = run.searches.find(item => item.replicate === repetition && item.arm === arm);
     if (!found?.offspringSource || !result.receipt.loadedSource || !sameSource(result.receipt.loadedSource, found.offspringSource) ||
      result.receipt.caseId !== caseId || result.outcome.caseId !== caseId || result.receipt.arm !== side ||
      !Number.isSafeInteger(result.receipt.childPid) || result.receipt.childPid! <= 0 || childPids.has(result.receipt.childPid!) ||
      !result.receipt.workspaceRoot || armWorkspaces.has(result.receipt.workspaceRoot) ||
      JSON.stringify(result.outcome.cost) !== JSON.stringify(result.receipt.usage))
      throw new HarnessError("improvement.source-meta", "protected offspring result is not bound to selected H source");
     const { before, after } = result.parentLedger;
     if (after.usageUnknown || after.inFlight ||
      after.committed.providerCalls - before.committed.providerCalls !== result.receipt.usage.providerCalls ||
      after.committed.inputTokens - before.committed.inputTokens !== result.receipt.usage.inputTokens ||
      after.committed.outputTokens - before.committed.outputTokens !== result.receipt.usage.outputTokens ||
      after.committed.sdkEstimatedCost - before.committed.sdkEstimatedCost !== result.receipt.usage.sdkEstimatedCost)
      throw new HarnessError("improvement.source-meta", "protected offspring receipt differs from parent provider ledger");
     run.costs.offspringExecutionEstimatedCost += result.receipt.usage.sdkEstimatedCost;
     childPids.add(result.receipt.childPid!); armWorkspaces.add(result.receipt.workspaceRoot);
   }
   pair[side] = result;
   if (!recorded.has(key)) { recorded.set(key, pair); run.protectedPairs.push(pair); }
   await save();
  };
  const recordPair = async (pair: WorkflowSourcePairV2): Promise<void> => {
   if (!pair.baseline && !pair.candidate) throw new HarnessError("improvement.source-meta", "protected pair has no observed arm");
   if (pair.baseline) await recordArm({ caseId: pair.caseId, repetition: pair.repetition,
    executionOrder: pair.executionOrder, side: "baseline", result: pair.baseline });
   if (pair.candidate) await recordArm({ caseId: pair.caseId, repetition: pair.repetition,
    executionOrder: pair.executionOrder, side: "candidate", result: pair.candidate });
  };
  const recordEvaluatorUsage = async (usage: UsageSummary): Promise<void> => {
   if (protectedClosed) throw new HarnessError("improvement.source-meta", "protected comparison is already settled");
   run.costs.protectedEvaluatorObserved.push(usage);
   if (Number.isFinite(usage.cost) && usage.cost >= 0) run.costs.protectedEvaluatorCost += usage.cost;
   await save();
  };
  try {
   const protectedResult = await input.evaluateProtectedOffspring({ runId: run.runId, schedule: input.plan.protectedSchedule,
    searches: structuredClone(run.searches), sharedH: baseline.executorSource, knowledgeSnapshot: baseline.knowledgeSnapshot,
    recordArm, recordPair, recordEvaluatorUsage, signal: input.signal });
   protectedClosed = true;
   const protectedText = await regularFile(protectedResult.receiptPath);
   run.protectedReceiptPath = path.join(dir, "protected-offspring.private.json");
   await writeFile(run.protectedReceiptPath, protectedText, { flag: "wx", mode: 0o600 });
   run.costs.protectedEvaluatorUsageComplete = protectedResult.evaluatorUsageComplete === true;
  } catch (error) { protectedClosed = true; run.status = "inconclusive"; run.reason = `protected offspring comparison failed: ${(error as Error).message}`; return run; }
  if (recorded.size !== expected.size || !run.costs.protectedEvaluatorUsageComplete ||
   run.costs.protectedEvaluatorObserved.some(usage => !usage.complete || !usage.costComplete || usage.unknownEvents > 0 ||
    !Number.isFinite(usage.cost) || usage.cost < 0) ||
   run.protectedPairs.some(pair => [pair.baseline, pair.candidate].some(item => !item ||
   item.receipt.status !== "complete" || !item.receipt.usage.complete || !item.receipt.usage.costComplete ||
   !item.outcome.executionComplete || !item.outcome.checked)) || run.costs.searchObserved.some(usage => !usage.complete || !usage.costComplete)) {
   run.status = "inconclusive"; run.reason = "protected offspring or search cost evidence is incomplete"; return run;
  }
  run.costs.complete = true;
  run.decision = await input.decider({ declaration: input.plan.decisionRule, pairs: run.protectedPairs,
   searches: run.searches, costs: run.costs });
  if (!run.decision || !["supported", "rejected", "inconclusive"].includes(run.decision.status) ||
   !run.decision.quality?.reason || !run.decision.cost?.reason || !run.decision.reason)
   throw new HarnessError("improvement.source-meta", "declared decider returned no structured result");
  run.status = run.decision.status === "inconclusive" ? "inconclusive" : "complete";
  run.reason = run.decision.reason;
 } catch (error) { run.status = "inconclusive"; run.reason = error instanceof Error ? error.message : String(error); }
 finally { run.finishedAt = new Date().toISOString(); await save(); }
 return run;
}
