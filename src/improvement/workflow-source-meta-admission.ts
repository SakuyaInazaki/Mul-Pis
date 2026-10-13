/** Parent-owned structural recheck of a registered I offspring confirmation. */
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import type { LoadedSourceV1 } from "../runtime/loaded-source.ts";
import { HarnessError } from "../types.ts";
import type { GenerationStore } from "./generation.ts";
import { assertFirstWorkflowSourceAllowlist } from "./workflow-source-arm.ts";
import type { WorkflowSourceMetaRunV1 } from "./workflow-source-meta.ts";
import type { WorkflowSourceSearchReceipt } from "./workflow-source-search.ts";

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const same = (a: LoadedSourceV1 | undefined, b: LoadedSourceV1 | undefined) => !!a && !!b && a.sourceRoot === b.sourceRoot && a.sourceCommit === b.sourceCommit;
async function fixedText(file: string): Promise<string> {
 const info = await lstat(file);
 if (!info.isFile() || info.isSymbolicLink() || info.size > 8 * 1024 * 1024) throw new HarnessError("improvement.source-meta-admission", "meta evidence is absent, indirect, or unbounded");
 return readFile(file, "utf8");
}
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export async function readAdmissibleSourceMetaRun(store: GenerationStore, runId: string): Promise<WorkflowSourceMetaRunV1> {
 if (!ID.test(runId)) throw new HarnessError("improvement.source-meta-admission", "invalid registered meta run ID");
 const root = path.join(store.root, "source-meta", runId);
 const [runText, planText, candidateText, protectedText] = await Promise.all([
  "run.json", "plan.json", "candidate-I-receipt.private.json", "protected-offspring.private.json"
 ].map(file => fixedText(path.join(root, file))));
 const run = JSON.parse(runText) as WorkflowSourceMetaRunV1;
 const candidateReceipt = JSON.parse(candidateText) as { status?: string; engineeringStatus?: string; parentCommit?: string;
  sourceCommit?: string; snapshot?: LoadedSourceV1; changedFiles?: string[]; writableFiles?: string[]; session?: unknown; diff?: string };
 if (run.version !== 1 || run.kind !== "workflow-source-meta-run/v1" || run.runId !== runId || run.status !== "complete" ||
  run.decision?.status !== "supported" || !run.finishedAt || !run.allSelectionsFrozenAt || !run.protectedOpenedAt ||
  !Number.isFinite(Date.parse(run.allSelectionsFrozenAt)) || !Number.isFinite(Date.parse(run.protectedOpenedAt)) ||
  Date.parse(run.allSelectionsFrozenAt) > Date.parse(run.protectedOpenedAt) || !equal(run.plan, JSON.parse(planText)) ||
  run.protectedReceiptPath !== path.join(root, "protected-offspring.private.json") || !protectedText.trim() ||
  candidateReceipt.status !== "committed" || candidateReceipt.engineeringStatus !== "passed" || !candidateReceipt.session ||
  candidateReceipt.sourceCommit !== run.plan.candidate.source.sourceCommit ||
  candidateReceipt.snapshot?.sourceRoot !== run.plan.candidate.source.sourceRoot ||
  !equal(candidateReceipt.changedFiles, ["src/improvement/workflow-improver-program.ts"]) ||
  !equal(candidateReceipt.writableFiles, ["src/improvement/workflow-improver-program.ts"]) || !candidateReceipt.diff?.trim() ||
  run.usageScope !== "search-provider-offspring-execution-and-reported-protected-evaluator-provider" ||
  !run.costs?.complete || !run.costs.protectedEvaluatorUsageComplete ||
  !Array.isArray(run.costs.protectedEvaluatorObserved) || run.costs.protectedEvaluatorObserved.some(usage => !usage.complete || !usage.costComplete) ||
  !Number.isFinite(run.costs.searchCost) || !Number.isFinite(run.costs.offspringExecutionEstimatedCost) ||
  !Number.isFinite(run.costs.protectedEvaluatorCost) ||
  Math.abs(run.costs.protectedEvaluatorObserved.reduce((n, usage) => n + usage.cost, 0) - run.costs.protectedEvaluatorCost) > 1e-9)
  throw new HarnessError("improvement.source-meta-admission", "I meta run lacks a complete supported frozen decision or model-authored source receipt");
 if (run.searches.length !== run.plan.searchReplicates * 2 || run.searchOrder.length !== run.plan.searchReplicates)
  throw new HarnessError("improvement.source-meta-admission", "I search denominator is incomplete");
 const expectedSearchUsage = [], workspaces = new Set<string>(), processIds = new Set<number>();
 let searchCost = 0, offspringCost = 0;
 for (let repetition = 0; repetition < run.plan.searchReplicates; repetition++) {
  const expectedOrder = repetition % 2 === 0 ? ["old", "candidate"] : ["candidate", "old"];
  if (!equal(run.searchOrder[repetition], expectedOrder)) throw new HarnessError("improvement.source-meta-admission", "I search order differs from frozen alternation");
  for (let index = 0; index < 2; index++) {
   const arm = expectedOrder[index] as "old" | "candidate", entry = run.searches[repetition * 2 + index];
   if (!entry || entry.replicate !== repetition || entry.arm !== arm || entry.error || !entry.search || !entry.offspringSource ||
    entry.searchCopyPath !== path.join(root, `frozen-search-${repetition}-${arm}.json`) ||
    entry.selectionCopyPath !== path.join(root, `frozen-selection-${repetition}-${arm}.json`))
    throw new HarnessError("improvement.source-meta-admission", "an I search or frozen selection is missing");
   const search = JSON.parse(await fixedText(entry.searchCopyPath)) as WorkflowSourceSearchReceipt;
   const selection = JSON.parse(await fixedText(entry.selectionCopyPath)) as Record<string, unknown>;
   if (!equal(entry.search, search) || !same(entry.source, search.source) || !["selected", "no-winner"].includes(search.status) ||
    selection.runId !== search.runId || selection.status !== search.status || !equal(selection.source, search.source) ||
    !equal(selection.baseline, search.baseline) || !equal(selection.actions, search.actions) ||
    !equal(selection.candidates, search.candidates) || !equal(selection.evaluations, search.evaluations) ||
    !equal(selection.usage, search.usage) || search.baseline.bundleId !== run.plan.baselineBundleId ||
    search.baseline.executorVersionId !== run.plan.baseline.executorVersionId ||
    !same(search.baseline.executorSource, run.plan.baseline.executorSource) || search.baseline.developmentSetId !== run.plan.baseline.developmentSetId ||
    search.model !== run.plan.baseline.modelConfig.improver ||
    search.usage.usageUnknown || !search.usage.costComplete ||
    search.usage.observed.some(usage => !usage.complete || !usage.costComplete))
    throw new HarnessError("improvement.source-meta-admission", "I search selection is incomplete or differs from its copied evidence");
   if (search.status === "selected") {
    const picked = search.candidates.find(item => item.id === search.selectedCandidateId);
    const evaluated = search.evaluations.find(item => item.candidateId === picked?.id);
    if (!picked || picked.status !== "ready" || !evaluated || !same(entry.offspringSource, { sourceRoot: picked.sourceRoot!, sourceCommit: picked.sourceCommit! }) ||
     selection.selectedCandidateId !== picked.id || selection.candidateReceiptPath !== picked.receiptPath ||
     selection.developmentEvaluationReceiptPath !== evaluated.receiptPath ||
     entry.candidateReceiptCopyPath !== path.join(root, `frozen-H-candidate-${repetition}-${arm}.json`) ||
     entry.developmentEvaluationReceiptCopyPath !== path.join(root, `frozen-development-evaluation-${repetition}-${arm}.json`))
     throw new HarnessError("improvement.source-meta-admission", "selected H offspring lacks same-search development evaluation");
    const candidate = JSON.parse(await fixedText(entry.candidateReceiptCopyPath)) as { status?: string; engineeringStatus?: string;
     parentCommit?: string; sourceCommit?: string; snapshot?: LoadedSourceV1; changedFiles?: string[]; writableFiles?: string[];
     session?: unknown; diff?: string };
    const development = JSON.parse(await fixedText(entry.developmentEvaluationReceiptCopyPath)) as { candidateId?: string; status?: string; reason?: string };
    if (candidate.status !== "committed" || candidate.engineeringStatus !== "passed" || !candidate.session || !candidate.diff?.trim() ||
     candidate.parentCommit !== run.plan.baseline.executorSource.sourceCommit || candidate.sourceCommit !== picked.sourceCommit ||
     candidate.snapshot?.sourceRoot !== picked.sourceRoot || !equal(candidate.changedFiles, ["src/m07/feedback.ts"]) ||
     !equal(candidate.writableFiles, ["src/m07/feedback.ts"]) || development.candidateId !== evaluated.candidateId ||
     development.status !== evaluated.status || development.reason !== evaluated.reason)
     throw new HarnessError("improvement.source-meta-admission", "frozen H candidate or development evaluation differs from the selected offspring");
    await assertFirstWorkflowSourceAllowlist(run.plan.baseline.executorSource, entry.offspringSource);
   } else if (!entry.noWinner || !same(entry.offspringSource, run.plan.baseline.executorSource) || selection.selectedCandidateId !== null ||
    entry.candidateReceiptCopyPath || entry.developmentEvaluationReceiptCopyPath)
    throw new HarnessError("improvement.source-meta-admission", "no-winner I search did not retain common H");
   expectedSearchUsage.push(...search.usage.observed); searchCost += search.usage.totals.cost;
  }
 }
 if (!equal(expectedSearchUsage, run.costs.searchObserved) || Math.abs(searchCost - run.costs.searchCost) > 1e-9)
  throw new HarnessError("improvement.source-meta-admission", "I search cost ledger differs from complete search evidence");
 const schedule = new Map(run.plan.protectedSchedule.map(item => [`${item.repetition}/${item.caseId}`, item]));
 if (schedule.size !== run.plan.protectedSchedule.length || run.protectedPairs.length !== schedule.size)
  throw new HarnessError("improvement.source-meta-admission", "protected offspring denominator is incomplete");
 for (const pair of run.protectedPairs) {
  const scheduled = schedule.get(`${pair.repetition}/${pair.caseId}`);
  if (!scheduled || !equal(pair.executionOrder, scheduled.executionOrder)) throw new HarnessError("improvement.source-meta-admission", "protected pair differs from declared schedule");
  schedule.delete(`${pair.repetition}/${pair.caseId}`);
  for (const [side, arm] of [["baseline", "old"], ["candidate", "candidate"]] as const) {
   const item = pair[side], selected = run.searches.find(entry => entry.replicate === pair.repetition && entry.arm === arm)?.offspringSource;
   const before = item?.parentLedger?.before, after = item?.parentLedger?.after;
   if (!item || !selected || !same(item.receipt.loadedSource, selected) || item.receipt.arm !== side || item.receipt.caseId !== pair.caseId ||
    item.outcome.caseId !== pair.caseId || !equal(item.outcome.cost, item.receipt.usage) ||
    item.receipt.status !== "complete" || !item.receipt.usage.complete || !item.receipt.usage.costComplete ||
    !item.outcome.executionComplete || !item.outcome.checked || !Number.isSafeInteger(item.receipt.childPid) || item.receipt.childPid <= 0 ||
    processIds.has(item.receipt.childPid) || workspaces.has(item.receipt.workspaceRoot) ||
    !before || !after || after.usageUnknown || after.inFlight ||
    after.committed.providerCalls - before.committed.providerCalls !== item.receipt.usage.providerCalls ||
    after.committed.inputTokens - before.committed.inputTokens !== item.receipt.usage.inputTokens ||
    after.committed.outputTokens - before.committed.outputTokens !== item.receipt.usage.outputTokens ||
    after.committed.sdkEstimatedCost - before.committed.sdkEstimatedCost !== item.receipt.usage.sdkEstimatedCost)
    throw new HarnessError("improvement.source-meta-admission", "protected offspring arm is incomplete, reused, or source-mismatched");
   processIds.add(item.receipt.childPid); workspaces.add(item.receipt.workspaceRoot);
   offspringCost += item.receipt.usage.sdkEstimatedCost;
  }
 }
 if (schedule.size || Math.abs(offspringCost - run.costs.offspringExecutionEstimatedCost) > 1e-9)
  throw new HarnessError("improvement.source-meta-admission", "protected offspring cost ledger or schedule is incomplete");
 return run;
}
