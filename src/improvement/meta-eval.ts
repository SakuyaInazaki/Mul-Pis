/** Matched successor-production protocol. It evaluates H successors, never I's current answer. */
import type { ArtifactRef, BudgetLease, DevelopmentFeedback, ExecutorStrategyV1, ExperimentStart, ScientificAction } from "../experiments/contracts.ts";
import { SharedBudget } from "../experiments/budget.ts";
import type { CpuCaseSetV1 } from "../experiments/local-environment.ts";
import type { SessionRunner } from "../runner/types.ts";
import { runExecutorQualityAdmission, type ExecutorQualityResult } from "./executor-eval.ts";

export interface ProducedSuccessorV1 {
 improverVersionId: string; startingExecutorVersionId: string; startingKnowledgeSnapshot?: string;
 selectedExecutor?: { versionId: string; artifact: ExecutorStrategyV1 };
 /** Selection is persisted before any protected G query. */
 selectedAt?: string; selectionReceiptPath?: string;
 decisionCount: number; status: "selected" | "no-winner" | "inconclusive";
}
export interface MetaReplicateV1 {
 index: number; firstArm: "old" | "new";
 old: ProducedSuccessorV1; new: ProducedSuccessorV1;
 /** Search-only Pi SDK price-table estimates. No provider invoice is implied. */
 oldSearchSdkEstimatedCost: number; newSearchSdkEstimatedCost: number;
 protectedQuality?: ExecutorQualityResult;
}
export interface MetaImprovementResultV1 {
 version: 1; experimentKind: "meta-improvement"; protocol: "quality" | "efficiency";
 status: "accepted" | "rejected" | "inconclusive";
 reason: string; oldImproverVersionId: string; newImproverVersionId: string;
 initialExecutorVersionId: string; knowledgeSnapshot?: string;
 /** Kept for older result readers; all repeats are in replicates. */
 oldOutcome?: ProducedSuccessorV1; newOutcome?: ProducedSuccessorV1;
 replicates: MetaReplicateV1[]; selectionReceiptPath?: string;
 protectedQuality?: ExecutorQualityResult; protectedQueriedAfterBothSelections: boolean;
 budgetSettlement: "settled" | "pending-or-unknown" | "exceeded";
}

export async function runMetaImprovementAdmission(args: {
 oldImproverVersionId: string; newImproverVersionId: string;
 initialExecutor: { versionId: string; artifact: ExecutorStrategyV1 }; knowledgeSnapshot?: string;
 developmentCaseSet: CpuCaseSetV1; admissionCaseSet: CpuCaseSetV1;
 budget: SharedBudget; branchLeases: Array<{ old: BudgetLease; new: BudgetLease }>; protectedLease: BudgetLease;
 protocol: "quality" | "efficiency"; searchReplicates: number; outcomeReplicates: number;
 produceSuccessor: (improverVersionId: string, lease: BudgetLease, caseSet: CpuCaseSetV1, replicateIndex: number, arm: "old" | "new") => Promise<ProducedSuccessorV1>;
 runner: SessionRunner; researchModel: string; persistDir: string; timeoutMs: number;
 persistSelection: (replicates: Array<{ old: ProducedSuccessorV1; new: ProducedSuccessorV1 }>) => Promise<string>;
 persistObservation: (record: { start: ExperimentStart; action: ScientificAction; feedback: DevelopmentFeedback }) => Promise<ArtifactRef>;
 beforeModelRequest?: (versionId: string) => Promise<void>;
}): Promise<MetaImprovementResultV1> {
 const result: MetaImprovementResultV1 = { version: 1, experimentKind: "meta-improvement", protocol: args.protocol, status: "inconclusive", reason: "not evaluated", oldImproverVersionId: args.oldImproverVersionId, newImproverVersionId: args.newImproverVersionId,
  initialExecutorVersionId: args.initialExecutor.versionId, knowledgeSnapshot: args.knowledgeSnapshot, replicates: [], protectedQueriedAfterBothSelections: false, budgetSettlement: "settled" };
 const withinBudget = (lease?: BudgetLease, mustBeClosed = false) => { const status = args.budget.status(lease); return status.settlement === "settled" && status.remaining.wallMillis > 0 && (!mustBeClosed || status.lifecycle === "closed"); };
 const settled = () => withinBudget() && withinBudget(args.protectedLease) && args.branchLeases.every((pair) => withinBudget(pair.old, true) && withinBudget(pair.new, true));
 const updateSettlement = () => { result.budgetSettlement = args.budget.status().settlement; return settled(); };
 if (args.developmentCaseSet.split !== "development" || args.admissionCaseSet.split !== "admission") { result.reason = "development/admission split mismatch"; return result; }
 if (args.oldImproverVersionId === args.newImproverVersionId) { result.status = "rejected"; result.reason = "sham improver identity"; return result; }
 if (!Number.isSafeInteger(args.searchReplicates) || args.searchReplicates < 1 || args.branchLeases.length !== args.searchReplicates || !Number.isSafeInteger(args.outcomeReplicates) || args.outcomeReplicates < 2 || args.outcomeReplicates % 2 !== 0 || !["quality", "efficiency"].includes(args.protocol)) { result.reason = "invalid preregistered matched meta protocol"; return result; }
 const leaseIds = [args.protectedLease.id, ...args.branchLeases.flatMap((pair) => [pair.old.id, pair.new.id])];
 if (new Set(leaseIds).size !== leaseIds.length) { result.reason = "matched search and protected leases must be independent"; return result; }
 // Freeze all independent search outcomes before the first protected query. Order alternates by replicate.
 for (let index = 0; index < args.searchReplicates; index++) {
  const firstArm: "old" | "new" = index % 2 === 0 ? "old" : "new";
  const pair = args.branchLeases[index];
  const outcomes = {} as { old: ProducedSuccessorV1; new: ProducedSuccessorV1 };
  for (const arm of [firstArm, firstArm === "old" ? "new" : "old"] as const) {
   outcomes[arm] = await args.produceSuccessor(arm === "old" ? args.oldImproverVersionId : args.newImproverVersionId, pair[arm], args.developmentCaseSet, index, arm);
   try { args.budget.closeLease(pair[arm]); } catch { result.reason = "search arm cannot close with pending, unknown, or exhausted resource use"; return result; }
   if (!withinBudget(pair[arm], true) || !withinBudget()) { result.reason = "pending, unknown, or exceeded search resource use"; return result; }
  }
  const old = outcomes.old, newer = outcomes.new;
  if (old.startingExecutorVersionId !== args.initialExecutor.versionId || newer.startingExecutorVersionId !== args.initialExecutor.versionId || old.startingKnowledgeSnapshot !== args.knowledgeSnapshot || newer.startingKnowledgeSnapshot !== args.knowledgeSnapshot || old.improverVersionId !== args.oldImproverVersionId || newer.improverVersionId !== args.newImproverVersionId) { result.reason = "meta arms did not share the frozen H/K start and I identities"; return result; }
  if ([old, newer].some((outcome) => outcome.status === "inconclusive" || outcome.status === "selected" && (!outcome.selectedExecutor || !outcome.selectedAt) || outcome.status === "no-winner" && outcome.selectedExecutor)) { result.reason = "search arm did not settle a valid selected or explicit no-winner terminal"; return result; }
  const oldSearchSdkEstimatedCost = args.budget.status(pair.old).committed.sdkEstimatedCost;
  const newSearchSdkEstimatedCost = args.budget.status(pair.new).committed.sdkEstimatedCost;
  result.replicates.push({ index, firstArm, old, new: newer, oldSearchSdkEstimatedCost, newSearchSdkEstimatedCost });
 }
 result.oldOutcome = result.replicates[0]?.old; result.newOutcome = result.replicates[0]?.new;
 // A no-winner is a settled H0 terminal, not a missing arm. Persist that choice too.
 const receipt = await args.persistSelection(result.replicates.map(({ old, new: newer }) => ({ old, new: newer })));
 if (!receipt) { result.reason = "frozen search selections were not persisted"; return result; }
 result.selectionReceiptPath = receipt;
 for (const repeat of result.replicates) { repeat.old.selectionReceiptPath = receipt; repeat.new.selectionReceiptPath = receipt; }
 if (!updateSettlement()) { result.reason = "unknown budget after selection freeze"; return result; }
 if (args.protocol === "quality" && result.replicates.every((r) => (r.old.selectedExecutor ?? args.initialExecutor).artifact.body === (r.new.selectedExecutor ?? args.initialExecutor).artifact.body)) {
  result.status = "rejected"; result.reason = "matched searches produced the same executable H; no quality gain"; return result;
 }
 // One protected pool was reserved for the worst case of every repeat before any paid search.
 for (const repeat of result.replicates) {
  const baseline = repeat.old.selectedExecutor ?? args.initialExecutor;
  const candidate = repeat.new.selectedExecutor ?? args.initialExecutor;
  const quality = await runExecutorQualityAdmission({ caseSet: args.admissionCaseSet, baseline, candidate,
   runner: args.runner, model: args.researchModel, persistDir: args.persistDir, budget: args.budget, lease: args.protectedLease,
   timeoutMs: args.timeoutMs, repetitions: args.outcomeReplicates,
   comparisonMode: args.protocol === "efficiency" ? "noninferiority" : "gain", persistObservation: args.persistObservation, beforeModelRequest: args.beforeModelRequest });
  result.protectedQueriedAfterBothSelections = true; repeat.protectedQuality = quality; result.protectedQuality = quality;
  if (!updateSettlement()) { result.reason = "unknown or exceeded nested/protected resource use"; return result; }
  if (quality.status !== "accepted") { result.status = quality.status; result.reason = `replicate ${repeat.index} protected quality: ${quality.reason}`; return result; }
 }
 if (args.protocol === "efficiency") {
  const oldCost = result.replicates.reduce((n, r) => n + r.oldSearchSdkEstimatedCost, 0);
  const newCost = result.replicates.reduce((n, r) => n + r.newSearchSdkEstimatedCost, 0);
  if (result.replicates.some((r) => r.newSearchSdkEstimatedCost > r.oldSearchSdkEstimatedCost + 1e-12) || !(newCost + 1e-12 < oldCost)) {
   result.status = "rejected"; result.reason = "quality was noninferior but matched search SDK-estimated cost did not strictly decrease"; return result;
  }
  result.status = "accepted"; result.reason = "matched successor quality was noninferior and SDK-estimated search cost strictly decreased"; return result;
 }
 result.status = "accepted"; result.reason = "each matched successor showed registered scientific quality gain"; return result;
}
