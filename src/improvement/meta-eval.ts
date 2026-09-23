/** Matched successor-production protocol. It evaluates H successors, never I's current answer. */
import type { ArtifactRef, BudgetLease, BudgetLimits, DevelopmentFeedback, ExecutorStrategyV1, ExperimentStart, ScientificAction } from "../experiments/contracts.ts";
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
export interface MetaImprovementResultV1 {
 version: 1; experimentKind: "meta-improvement"; status: "accepted" | "rejected" | "inconclusive";
 reason: string; oldImproverVersionId: string; newImproverVersionId: string;
 initialExecutorVersionId: string; knowledgeSnapshot?: string;
 oldOutcome?: ProducedSuccessorV1; newOutcome?: ProducedSuccessorV1;
 protectedQuality?: ExecutorQualityResult; protectedQueriedAfterBothSelections: boolean;
 budgetSettlement: "settled" | "pending-or-unknown" | "exceeded";
}

export async function runMetaImprovementAdmission(args: {
 oldImproverVersionId: string; newImproverVersionId: string;
 initialExecutor: { versionId: string; artifact: ExecutorStrategyV1 }; knowledgeSnapshot?: string;
 branchLimits: BudgetLimits; developmentCaseSet: CpuCaseSetV1; admissionCaseSet: CpuCaseSetV1;
 budget: SharedBudget; rootLease: BudgetLease;
 produceSuccessor: (improverVersionId: string, lease: BudgetLease, caseSet: CpuCaseSetV1) => Promise<ProducedSuccessorV1>;
 runner: SessionRunner; researchModel: string; persistDir: string; timeoutMs: number; repetitions: number; maxOutputTokens: number;
 persistSelection: (oldOutcome: ProducedSuccessorV1, newOutcome: ProducedSuccessorV1) => Promise<string>;
 persistObservation: (record: { start: ExperimentStart; action: ScientificAction; feedback: DevelopmentFeedback }) => Promise<ArtifactRef>;
 beforeModelRequest?: (versionId: string) => Promise<void>;
}): Promise<MetaImprovementResultV1> {
 const result: MetaImprovementResultV1 = { version: 1, experimentKind: "meta-improvement", status: "inconclusive", reason: "not evaluated", oldImproverVersionId: args.oldImproverVersionId, newImproverVersionId: args.newImproverVersionId,
  initialExecutorVersionId: args.initialExecutor.versionId, knowledgeSnapshot: args.knowledgeSnapshot, protectedQueriedAfterBothSelections: false, budgetSettlement: "settled" };
 if (args.developmentCaseSet.split !== "development" || args.admissionCaseSet.split !== "admission") { result.reason = "development/admission split mismatch"; return result; }
 if (args.oldImproverVersionId === args.newImproverVersionId) { result.status = "rejected"; result.reason = "sham improver identity"; return result; }
 const oldLease = args.budget.createLease(args.rootLease, args.branchLimits);
 const newLease = args.budget.createLease(args.rootLease, args.branchLimits);
 result.oldOutcome = await args.produceSuccessor(args.oldImproverVersionId, oldLease, args.developmentCaseSet);
 result.newOutcome = await args.produceSuccessor(args.newImproverVersionId, newLease, args.developmentCaseSet);
 result.budgetSettlement = args.budget.status(args.rootLease).settlement;
 if (result.budgetSettlement !== "settled") { result.reason = "pending, unknown, or exceeded nested resource use"; return result; }
 if (result.oldOutcome.status !== "selected" || result.newOutcome.status !== "selected" || !result.oldOutcome.selectedExecutor || !result.newOutcome.selectedExecutor || !result.oldOutcome.selectedAt || !result.newOutcome.selectedAt) {
  result.reason = "both improvers must preselect one real H successor from development only"; return result;
 }
 if (result.oldOutcome.startingExecutorVersionId !== args.initialExecutor.versionId || result.newOutcome.startingExecutorVersionId !== args.initialExecutor.versionId || result.oldOutcome.startingKnowledgeSnapshot !== args.knowledgeSnapshot || result.newOutcome.startingKnowledgeSnapshot !== args.knowledgeSnapshot) {
  result.reason = "meta arms did not share the frozen H/K start"; return result;
 }
 if (result.oldOutcome.selectedExecutor.artifact.body === result.newOutcome.selectedExecutor.artifact.body) {
  result.reason = "selected H successors have the same executable strategy body; no mechanism difference to test"; return result;
 }
 const receipt = await args.persistSelection(result.oldOutcome, result.newOutcome);
 result.oldOutcome.selectionReceiptPath = receipt; result.newOutcome.selectionReceiptPath = receipt;
 const quality = await runExecutorQualityAdmission({ caseSet: args.admissionCaseSet,
  baseline: result.oldOutcome.selectedExecutor, candidate: result.newOutcome.selectedExecutor,
  runner: args.runner, model: args.researchModel, persistDir: args.persistDir, budget: args.budget, lease: args.rootLease, timeoutMs: args.timeoutMs, repetitions: args.repetitions, maxOutputTokens: args.maxOutputTokens, persistObservation: args.persistObservation, beforeModelRequest: args.beforeModelRequest });
 result.protectedQueriedAfterBothSelections = true;
 result.protectedQuality = quality; result.budgetSettlement = args.budget.status(args.rootLease).settlement;
 if (result.budgetSettlement !== "settled") { result.reason = "nested or protected evaluation resource use is unknown"; return result; }
 result.status = quality.status; result.reason = `successor quality: ${quality.reason}`;
 return result;
}
