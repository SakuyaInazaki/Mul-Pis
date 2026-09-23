import type { BudgetLimits, DevelopmentFeedback } from "../experiments/contracts.ts";
import type { KnowledgeRef } from "../knowledge/types.ts";
import type { ResearchActionV1, ResearchHypothesisV1 } from "./policy-host.ts";
import type { ActiveGenerationPointerV1, GenerationBundleV1, StrategyKind } from "./generation.ts";
import { HarnessError } from "../types.ts";

/** Separate from the V1/V2 budget-policy CampaignPlan and its mechanism-cost rule. */
export interface ResearchCampaignPlanV1 {
 version: 1;
 experimentKind: "executor-quality" | "meta-improvement";
 target: StrategyKind;
 developmentCaseSetPath: string;
 /** Optional controller-checked development-only observation handoff from an earlier real trial. */
 priorDevelopmentFeedbackPath?: string;
 /** Explicit caller-frozen admission cases; omitted means research-only. */
 admissionCaseSetPath?: string;
 maxDecisions: number;
 maxCandidates: number;
 maxCandidatesPerMetaArm?: number;
 admissionRepetitions: number;
 maxFeedbackItems: number;
 perPromptTimeoutMs: number;
 perPromptMaxOutputTokens: number;
 budget: BudgetLimits;
 /** Identical cap for each meta arm; both draw from the same root ledger. */
 metaBranchBudget?: BudgetLimits;
 experienceRefs: KnowledgeRef[];
 experienceMaxRecords: number;
 experienceMaxChars: number;
}
export interface ResearchCandidateV1 {
 id: string;
 kind: StrategyKind;
 strategyVersionId: string;
 producedByImproverVersionId: string;
 hypothesis: ResearchHypothesisV1;
 origin: "agent-generated";
 developmentStatus: "untested" | "supported" | "rejected" | "inconclusive";
 developmentEvidence: string[];
}
export interface ResearchDecisionRecordV1 {
 index: number; at: string; processId: number; improverVersionId: string; sessionId?: string;
 action?: ResearchActionV1; outcome: "proposing" | "executed" | "rejected" | "failed" | "inconclusive";
 feedbackId?: string; reason?: string; specFile?: string; usageSidecar?: string; visibleFeedbackIds: string[];
 experienceRefs: KnowledgeRef[];
}
export interface ResearchRunV1 {
 version: 1; runId: string; startedAt: string; finishedAt?: string;
 planPath: string; baselineBundleId: string; baselinePointer?: ActiveGenerationPointerV1;
 frozenBundle: GenerationBundleV1; developmentCaseSetPath: string; admissionCaseSetPath?: string;
 status: "running" | "research-only" | "rejected" | "inconclusive" | "promoted" | "failed";
 selectedCandidateId?: string; candidates: ResearchCandidateV1[]; decisions: ResearchDecisionRecordV1[];
 feedback: DevelopmentFeedback[]; priorDevelopmentSource?: { caseId: string; methodVersionId: string; feedbackIds: string[]; claimBoundary: string };
 admissionPath?: string; stopReason?: string;
 budgetAtEnd?: unknown;
}

/** Closed, caller-supplied limits. The controller never invents a paid default. */
export function validateResearchPlan(input: unknown): ResearchCampaignPlanV1 {
 if (!input || typeof input !== "object" || Array.isArray(input)) throw new HarnessError("improvement.research-plan", "plan must be an object");
 const p = input as Record<string, unknown>;
 const keys = new Set(["version", "experimentKind", "target", "developmentCaseSetPath", "priorDevelopmentFeedbackPath", "admissionCaseSetPath", "maxDecisions", "maxCandidates", "maxCandidatesPerMetaArm", "admissionRepetitions", "maxFeedbackItems", "perPromptTimeoutMs", "perPromptMaxOutputTokens", "budget", "metaBranchBudget", "experienceRefs", "experienceMaxRecords", "experienceMaxChars"]);
 if (Object.keys(p).some((key) => !keys.has(key)) || p.version !== 1 || !["executor-quality", "meta-improvement"].includes(String(p.experimentKind)) || !["executor", "improver"].includes(String(p.target)) || (p.experimentKind === "executor-quality" ? p.target !== "executor" : p.target !== "improver")) throw new HarnessError("improvement.research-plan", "invalid experiment kind/target");
 const pathValue = (v: unknown, field: string, optional = false) => { if (v === undefined && optional) return; if (typeof v !== "string" || !v.trim() || v.length > 500) throw new HarnessError("improvement.research-plan", `${field} is required`); };
 pathValue(p.developmentCaseSetPath, "developmentCaseSetPath"); pathValue(p.admissionCaseSetPath, "admissionCaseSetPath", true);
 pathValue(p.priorDevelopmentFeedbackPath, "priorDevelopmentFeedbackPath", true);
 if (p.admissionCaseSetPath === p.developmentCaseSetPath) throw new HarnessError("improvement.research-plan", "development and admission paths must differ");
 const integer = (v: unknown, field: string, min: number, max: number) => { if (typeof v !== "number" || !Number.isSafeInteger(v) || v < min || v > max) throw new HarnessError("improvement.research-plan", `${field} must be an integer ${min}–${max}`); };
 integer(p.maxDecisions, "maxDecisions", 1, 30); integer(p.maxCandidates, "maxCandidates", 1, 10); integer(p.maxFeedbackItems, "maxFeedbackItems", 1, 24); integer(p.perPromptTimeoutMs, "perPromptTimeoutMs", 100, 300_000);
 integer(p.perPromptMaxOutputTokens, "perPromptMaxOutputTokens", 1, 20_000);
 integer(p.admissionRepetitions, "admissionRepetitions", 2, 10); if ((p.admissionRepetitions as number) % 2 !== 0) throw new HarnessError("improvement.research-plan", "admissionRepetitions must be even");
 integer(p.experienceMaxRecords, "experienceMaxRecords", 0, 20); integer(p.experienceMaxChars, "experienceMaxChars", 0, 12_000);
 if (!Array.isArray(p.experienceRefs) || p.experienceRefs.length > 20 || !p.experienceRefs.every((r) => !!r && typeof r === "object" && typeof r.storeId === "string" && typeof r.recordId === "string" && Number.isSafeInteger(r.version) && r.version > 0)) throw new HarnessError("improvement.research-plan", "experienceRefs must be bounded pinned refs");
 if (p.experienceRefs.length && ((p.experienceMaxRecords as number) < 1 || (p.experienceMaxChars as number) < 1)) throw new HarnessError("improvement.research-plan", "experience bounds must be positive when refs are requested");
 if (p.experimentKind === "meta-improvement" && p.experienceRefs.length) throw new HarnessError("improvement.research-plan", "first meta protocol requires an explicit empty shared experience selection");
 if (!p.budget || typeof p.budget !== "object" || Array.isArray(p.budget)) throw new HarnessError("improvement.research-plan", "budget is required");
 const b = p.budget as Record<string, unknown>;
 const budgetKeys = new Set(["maxProviderCalls", "maxInputTokens", "maxOutputTokens", "maxSdkEstimatedCost", "maxProbeCalls", "maxCpuMillis", "maxWallMillis"]);
 if (Object.keys(b).some((key) => !budgetKeys.has(key))) throw new HarnessError("improvement.research-plan", "budget has unsupported fields");
 integer(b.maxProviderCalls, "maxProviderCalls", 1, 100); integer(b.maxInputTokens, "maxInputTokens", 1, 10_000_000); integer(b.maxOutputTokens, "maxOutputTokens", 1, 10_000_000); integer(b.maxProbeCalls, "maxProbeCalls", 0, 1_000); integer(b.maxCpuMillis, "maxCpuMillis", 1, 3_600_000); integer(b.maxWallMillis, "maxWallMillis", 100, 86_400_000);
 if (typeof b.maxSdkEstimatedCost !== "number" || !Number.isFinite(b.maxSdkEstimatedCost) || b.maxSdkEstimatedCost <= 0) throw new HarnessError("improvement.research-plan", "maxSdkEstimatedCost must be positive");
 if ((p.perPromptMaxOutputTokens as number) > (b.maxOutputTokens as number)) throw new HarnessError("improvement.research-plan", "per-prompt output cap exceeds root output budget");
 if (p.experimentKind === "meta-improvement" && p.admissionCaseSetPath !== undefined) {
  integer(p.maxCandidatesPerMetaArm, "maxCandidatesPerMetaArm", 1, 10);
  const child = p.metaBranchBudget;
  if (!child || typeof child !== "object" || Array.isArray(child) || Object.keys(child).some((key) => !budgetKeys.has(key))) throw new HarnessError("improvement.research-plan", "metaBranchBudget is required and closed");
  const m = child as Record<string, unknown>;
  for (const key of ["maxProviderCalls", "maxInputTokens", "maxOutputTokens", "maxProbeCalls", "maxCpuMillis"] as const) {
   integer(m[key], `metaBranchBudget.${key}`, key === "maxProbeCalls" ? 0 : 1, 10_000_000);
   if ((m[key] as number) * 2 > (b[key] as number)) throw new HarnessError("improvement.research-plan", "two matched meta branches exceed root budget");
  }
  integer(m.maxWallMillis, "metaBranchBudget.maxWallMillis", 100, 86_400_000);
  if ((m.maxWallMillis as number) > (b.maxWallMillis as number) || typeof m.maxSdkEstimatedCost !== "number" || !Number.isFinite(m.maxSdkEstimatedCost) || m.maxSdkEstimatedCost <= 0 || m.maxSdkEstimatedCost * 2 > (b.maxSdkEstimatedCost as number)) throw new HarnessError("improvement.research-plan", "invalid matched meta cost/wall cap");
 } else if (p.metaBranchBudget !== undefined || p.maxCandidatesPerMetaArm !== undefined) throw new HarnessError("improvement.research-plan", "matched meta branch controls require a protected meta admission case set");
 return p as unknown as ResearchCampaignPlanV1;
}
