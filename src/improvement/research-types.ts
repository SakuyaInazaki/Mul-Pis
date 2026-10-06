import type { BudgetLimits, DevelopmentFeedback } from "../experiments/contracts.ts";
import type { KnowledgeRef } from "../knowledge/types.ts";
import type { ResearchActionV1, ResearchHypothesisV1 } from "./policy-host.ts";
import type { ActiveGenerationPointerV1, GenerationBundleV1, StrategyKind } from "./generation.ts";
import type { ResearchInspectionResultV1 } from "./policy-host.ts";
import type { ExecutorEpisodeResult } from "./executor-eval.ts";
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
 /** Legacy execution quotas retained only for historical plan decoding. */
 maxDecisions?: number;
 maxCandidates?: number;
 maxCandidatesPerMetaArm?: number;
 admissionRepetitions: number;
 maxFeedbackItems: number;
 /** Legacy cumulative readback quota, accepted only for historical plan decoding. */
 maxInspectActions?: number;
 maxReadbackChars?: number;
 schemaRepairAttempts?: number;
 perPromptTimeoutMs?: number;
 budget: BudgetLimits;
 /** Historical phase budgets are accepted for decoding only; all arms draw from the root. */
 metaBranchBudget?: BudgetLimits;
 /** Historical phase budgets are accepted for decoding only; they do not set caps. */
 outerBudget?: BudgetLimits;
 pilotBudget?: BudgetLimits;
 protectedBudget?: BudgetLimits;
 metaProtocol?: "quality" | "efficiency";
 searchReplicates?: number;
 outcomeReplicates?: number;
 experienceRefs: KnowledgeRef[];
 experienceMaxRecords: number;
 experienceMaxChars: number;
 /** Explicit same-workspace development episodes; never file paths or protected reports. */
 metaEpisodeRunIds?: string[];
}
export interface ResearchCandidateV1 {
 id: string;
 kind: StrategyKind;
 strategyVersionId: string;
 producedByImproverVersionId: string;
 hypothesis: ResearchHypothesisV1;
 origin: "agent-generated";
 developmentStatus: "untested" | "schema-valid" | "pilot-complete" | "development-supported" | "supported" | "rejected" | "inconclusive";
 developmentEvidence: string[];
 branchPrefix?: string;
}
export interface ResearchDecisionRecordV1 {
 index: number; at: string; processId: number; improverVersionId: string; sessionId?: string;
 action?: ResearchActionV1; outcome: "proposing" | "executed" | "rejected" | "failed" | "inconclusive";
 feedbackId?: string; reason?: string; specFile?: string; usageSidecar?: string; visibleFeedbackIds: string[];
 experienceRefs: KnowledgeRef[];
 inspectionId?: string; repairAttempts?: number;
 repairSessionIds?: string[];
 branchPrefix?: string;
}
export interface ResearchDevelopmentEpisodeV1 { caseId: string; candidateId: string; episode: ExecutorEpisodeResult; sdkEstimatedCost: number; modelCalls: number; scientificStatus: "supported" | "justified-unknown" | "contradicted" | "premature-stop" | "incomplete" }
export interface ResearchRunV1 {
 version: 1; runId: string; startedAt: string; finishedAt?: string;
 planPath: string; baselineBundleId: string; baselinePointer?: ActiveGenerationPointerV1;
 frozenBundle: GenerationBundleV1; developmentCaseSetPath: string; admissionCaseSetPath?: string;
 status: "running" | "research-only" | "rejected" | "inconclusive" | "promoted" | "failed";
 /** Optional precise lifecycle classification; status remains the compatible public summary. */
 outcome?: "setup-blocked" | "provider-failed" | "search-incomplete" | "completed-no-candidate" | "candidate-rejected" | "promoted";
 selectedCandidateId?: string; candidates: ResearchCandidateV1[]; decisions: ResearchDecisionRecordV1[];
 inspections?: ResearchInspectionResultV1[]; developmentEpisodes?: ResearchDevelopmentEpisodeV1[];
 metaEpisodeIds?: string[];
 developmentTarget?: StrategyKind; developmentTerminal?: "selected" | "no-winner" | "inconclusive"; developmentBudgetAtSelection?: unknown;
 feedback: Array<DevelopmentFeedback & { caseId?: string }>; priorDevelopmentSource?: { caseId: string; methodVersionId: string; feedbackIds: string[]; claimBoundary: string };
 admissionPath?: string; stopReason?: string;
 budgetAtEnd?: unknown;
}

/** Closed, caller-supplied total monetary limit. The controller invents no paid default. */
export function validateResearchPlan(input: unknown): ResearchCampaignPlanV1 {
 if (!input || typeof input !== "object" || Array.isArray(input)) throw new HarnessError("improvement.research-plan", "plan must be an object");
 const p = input as Record<string, unknown>;
 const keys = new Set(["version", "experimentKind", "target", "developmentCaseSetPath", "priorDevelopmentFeedbackPath", "admissionCaseSetPath", "maxDecisions", "maxCandidates", "maxCandidatesPerMetaArm", "admissionRepetitions", "maxFeedbackItems", "maxInspectActions", "maxReadbackChars", "schemaRepairAttempts", "perPromptTimeoutMs", "budget", "outerBudget", "pilotBudget", "protectedBudget", "metaBranchBudget", "metaProtocol", "searchReplicates", "outcomeReplicates", "experienceRefs", "experienceMaxRecords", "experienceMaxChars", "metaEpisodeRunIds"]);
 if ("perPromptMaxOutputTokens" in p || "perPromptMaxInputTokens" in p) throw new HarnessError("improvement.research-plan", "per-request token quotas have been removed; use the campaign budget");
 if (Object.keys(p).some((key) => !keys.has(key)) || p.version !== 1 || !["executor-quality", "meta-improvement"].includes(String(p.experimentKind)) || !["executor", "improver"].includes(String(p.target)) || (p.experimentKind === "executor-quality" ? p.target !== "executor" : p.target !== "improver")) throw new HarnessError("improvement.research-plan", "invalid experiment kind/target");
 const pathValue = (v: unknown, field: string, optional = false) => { if (v === undefined && optional) return; if (typeof v !== "string" || !v.trim() || v.length > 500) throw new HarnessError("improvement.research-plan", `${field} is required`); };
 pathValue(p.developmentCaseSetPath, "developmentCaseSetPath"); pathValue(p.admissionCaseSetPath, "admissionCaseSetPath", true);
 pathValue(p.priorDevelopmentFeedbackPath, "priorDevelopmentFeedbackPath", true);
 if (p.admissionCaseSetPath === p.developmentCaseSetPath) throw new HarnessError("improvement.research-plan", "development and admission paths must differ");
 const integer = (v: unknown, field: string, min: number, max: number) => { if (typeof v !== "number" || !Number.isSafeInteger(v) || v < min || v > max) throw new HarnessError("improvement.research-plan", `${field} must be an integer ${min}–${max}`); };
 integer(p.maxFeedbackItems, "maxFeedbackItems", 1, 24);
 if (p.maxReadbackChars !== undefined) integer(p.maxReadbackChars, "maxReadbackChars", 0, Number.MAX_SAFE_INTEGER);
 integer(p.admissionRepetitions, "admissionRepetitions", 2, Number.MAX_SAFE_INTEGER); if ((p.admissionRepetitions as number) % 2 !== 0) throw new HarnessError("improvement.research-plan", "admissionRepetitions must be even");
 integer(p.experienceMaxRecords, "experienceMaxRecords", 0, 20); integer(p.experienceMaxChars, "experienceMaxChars", 0, 12_000);
 if (!Array.isArray(p.experienceRefs) || p.experienceRefs.length > 20 || !p.experienceRefs.every((r) => !!r && typeof r === "object" && typeof r.storeId === "string" && typeof r.recordId === "string" && Number.isSafeInteger(r.version) && r.version > 0)) throw new HarnessError("improvement.research-plan", "experienceRefs must be bounded pinned refs");
 if (p.experienceRefs.length && ((p.experienceMaxRecords as number) < 1 || (p.experienceMaxChars as number) < 1)) throw new HarnessError("improvement.research-plan", "experience bounds must be positive when refs are requested");
 if (p.metaEpisodeRunIds !== undefined && (!Array.isArray(p.metaEpisodeRunIds) || !p.metaEpisodeRunIds.every((id) => typeof id === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id)) || new Set(p.metaEpisodeRunIds).size !== p.metaEpisodeRunIds.length)) throw new HarnessError("improvement.research-plan", "metaEpisodeRunIds must be distinct same-workspace run identifiers");
 if (!p.budget || typeof p.budget !== "object" || Array.isArray(p.budget)) throw new HarnessError("improvement.research-plan", "budget is required");
 const b = p.budget as Record<string, unknown>;
 const budgetKeys = new Set(["maxProviderCalls", "maxInputTokens", "maxOutputTokens", "maxSdkEstimatedCost", "maxProbeCalls", "maxCpuMillis", "maxWallMillis"]);
 if (Object.keys(b).some((key) => !budgetKeys.has(key))) throw new HarnessError("improvement.research-plan", "budget has unsupported fields");
 if (typeof b.maxSdkEstimatedCost !== "number" || !Number.isFinite(b.maxSdkEstimatedCost) || b.maxSdkEstimatedCost <= 0) throw new HarnessError("improvement.research-plan", "maxSdkEstimatedCost must be positive");
 const validateHistoricalPhase = (value: unknown, name: string) => {
  if (value !== undefined && (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !budgetKeys.has(key)))) throw new HarnessError("improvement.research-plan", `${name} has unsupported fields`);
 };
 for (const name of ["outerBudget", "pilotBudget", "protectedBudget", "metaBranchBudget"] as const) validateHistoricalPhase(p[name], name);
 if (p.admissionCaseSetPath !== undefined) {
  integer(p.searchReplicates, "searchReplicates", 1, Number.MAX_SAFE_INTEGER); integer(p.outcomeReplicates, "outcomeReplicates", 2, Number.MAX_SAFE_INTEGER);
  if ((p.outcomeReplicates as number) % 2 !== 0 || p.outcomeReplicates !== p.admissionRepetitions) throw new HarnessError("improvement.research-plan", "outcomeReplicates must equal the even admissionRepetitions");
  if (p.experimentKind === "executor-quality" && p.searchReplicates !== 1) throw new HarnessError("improvement.research-plan", "executor quality has one outer search");
  if (p.experimentKind === "meta-improvement" && !["quality", "efficiency"].includes(String(p.metaProtocol))) throw new HarnessError("improvement.research-plan", "metaProtocol is required for matched admission");
 } else if (p.searchReplicates !== undefined || p.outcomeReplicates !== undefined || p.metaProtocol !== undefined) throw new HarnessError("improvement.research-plan", "admission phase controls require an admission case set");
 const withoutLegacyOutput = (value: unknown): BudgetLimits | undefined => {
  if (value === undefined) return undefined;
  const { maxOutputTokens: _legacyOutputLimit, maxProviderCalls: _calls, maxInputTokens: _input,
   maxProbeCalls: _probes, maxCpuMillis: _cpu, maxWallMillis: _wall, ...active } = value as BudgetLimits;
  return active;
 };
 const { maxDecisions: _decisions, maxCandidates: _candidates, maxCandidatesPerMetaArm: _branchCandidates,
  outerBudget: _outerBudget, pilotBudget: _pilotBudget, protectedBudget: _protectedBudget, metaBranchBudget: _metaBranchBudget,
  maxInspectActions: _inspections, maxReadbackChars: _readback, schemaRepairAttempts: _repairs, perPromptTimeoutMs: _timeout, ...activePlan } = p;
 return { ...activePlan, budget: withoutLegacyOutput(p.budget) } as unknown as ResearchCampaignPlanV1;
}
