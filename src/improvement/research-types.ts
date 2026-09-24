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
 maxDecisions: number;
 maxCandidates: number;
 maxCandidatesPerMetaArm?: number;
 admissionRepetitions: number;
 maxFeedbackItems: number;
 /** Read-only development evidence access; defaults preserve bounded older plans. */
 maxInspectActions?: number;
 maxReadbackChars?: number;
 schemaRepairAttempts?: number;
 perPromptTimeoutMs: number;
 budget: BudgetLimits;
 /** Identical cap for each meta arm; both draw from the same root ledger. */
 metaBranchBudget?: BudgetLimits;
 /** Explicit admission phase caps; each phase draws from the same campaign root. */
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

/** Closed, caller-supplied limits. The controller never invents a paid default. */
export function validateResearchPlan(input: unknown): ResearchCampaignPlanV1 {
 if (!input || typeof input !== "object" || Array.isArray(input)) throw new HarnessError("improvement.research-plan", "plan must be an object");
 const p = input as Record<string, unknown>;
 const keys = new Set(["version", "experimentKind", "target", "developmentCaseSetPath", "priorDevelopmentFeedbackPath", "admissionCaseSetPath", "maxDecisions", "maxCandidates", "maxCandidatesPerMetaArm", "admissionRepetitions", "maxFeedbackItems", "maxInspectActions", "maxReadbackChars", "schemaRepairAttempts", "perPromptTimeoutMs", "budget", "outerBudget", "pilotBudget", "protectedBudget", "metaBranchBudget", "metaProtocol", "searchReplicates", "outcomeReplicates", "experienceRefs", "experienceMaxRecords", "experienceMaxChars", "metaEpisodeRunIds"]);
 if ("perPromptMaxOutputTokens" in p || "perPromptMaxInputTokens" in p) throw new HarnessError("improvement.research-plan", "per-request token quotas have been removed; use campaign and phase budgets");
 if (Object.keys(p).some((key) => !keys.has(key)) || p.version !== 1 || !["executor-quality", "meta-improvement"].includes(String(p.experimentKind)) || !["executor", "improver"].includes(String(p.target)) || (p.experimentKind === "executor-quality" ? p.target !== "executor" : p.target !== "improver")) throw new HarnessError("improvement.research-plan", "invalid experiment kind/target");
 const pathValue = (v: unknown, field: string, optional = false) => { if (v === undefined && optional) return; if (typeof v !== "string" || !v.trim() || v.length > 500) throw new HarnessError("improvement.research-plan", `${field} is required`); };
 pathValue(p.developmentCaseSetPath, "developmentCaseSetPath"); pathValue(p.admissionCaseSetPath, "admissionCaseSetPath", true);
 pathValue(p.priorDevelopmentFeedbackPath, "priorDevelopmentFeedbackPath", true);
 if (p.admissionCaseSetPath === p.developmentCaseSetPath) throw new HarnessError("improvement.research-plan", "development and admission paths must differ");
 const integer = (v: unknown, field: string, min: number, max: number) => { if (typeof v !== "number" || !Number.isSafeInteger(v) || v < min || v > max) throw new HarnessError("improvement.research-plan", `${field} must be an integer ${min}–${max}`); };
 integer(p.maxDecisions, "maxDecisions", 1, 30); integer(p.maxCandidates, "maxCandidates", 1, 10); integer(p.maxFeedbackItems, "maxFeedbackItems", 1, 24); integer(p.perPromptTimeoutMs, "perPromptTimeoutMs", 100, 300_000);
 if (p.maxInspectActions !== undefined) integer(p.maxInspectActions, "maxInspectActions", 0, 30);
 if (p.maxReadbackChars !== undefined) integer(p.maxReadbackChars, "maxReadbackChars", 0, 40_000);
 if (p.schemaRepairAttempts !== undefined) integer(p.schemaRepairAttempts, "schemaRepairAttempts", 0, 2);
 if (p.maxInspectActions === 0 && typeof p.maxReadbackChars === "number" && p.maxReadbackChars > 0) throw new HarnessError("improvement.research-plan", "readback characters require inspect actions");
 integer(p.admissionRepetitions, "admissionRepetitions", 2, 10); if ((p.admissionRepetitions as number) % 2 !== 0) throw new HarnessError("improvement.research-plan", "admissionRepetitions must be even");
 integer(p.experienceMaxRecords, "experienceMaxRecords", 0, 20); integer(p.experienceMaxChars, "experienceMaxChars", 0, 12_000);
 if (!Array.isArray(p.experienceRefs) || p.experienceRefs.length > 20 || !p.experienceRefs.every((r) => !!r && typeof r === "object" && typeof r.storeId === "string" && typeof r.recordId === "string" && Number.isSafeInteger(r.version) && r.version > 0)) throw new HarnessError("improvement.research-plan", "experienceRefs must be bounded pinned refs");
 if (p.experienceRefs.length && ((p.experienceMaxRecords as number) < 1 || (p.experienceMaxChars as number) < 1)) throw new HarnessError("improvement.research-plan", "experience bounds must be positive when refs are requested");
 if (p.metaEpisodeRunIds !== undefined && (!Array.isArray(p.metaEpisodeRunIds) || p.metaEpisodeRunIds.length > 4 || !p.metaEpisodeRunIds.every((id) => typeof id === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id)) || new Set(p.metaEpisodeRunIds).size !== p.metaEpisodeRunIds.length)) throw new HarnessError("improvement.research-plan", "metaEpisodeRunIds must be at most four distinct same-workspace run identifiers");
 if (!p.budget || typeof p.budget !== "object" || Array.isArray(p.budget)) throw new HarnessError("improvement.research-plan", "budget is required");
 const b = p.budget as Record<string, unknown>;
 const budgetKeys = new Set(["maxProviderCalls", "maxInputTokens", "maxOutputTokens", "maxSdkEstimatedCost", "maxProbeCalls", "maxCpuMillis", "maxWallMillis"]);
 if (Object.keys(b).some((key) => !budgetKeys.has(key))) throw new HarnessError("improvement.research-plan", "budget has unsupported fields");
 integer(b.maxProviderCalls, "maxProviderCalls", 1, 100); integer(b.maxInputTokens, "maxInputTokens", 1, 10_000_000); integer(b.maxOutputTokens, "maxOutputTokens", 1, 10_000_000); integer(b.maxProbeCalls, "maxProbeCalls", 0, 1_000); integer(b.maxCpuMillis, "maxCpuMillis", 1, 3_600_000); integer(b.maxWallMillis, "maxWallMillis", 100, 86_400_000);
 if (typeof b.maxSdkEstimatedCost !== "number" || !Number.isFinite(b.maxSdkEstimatedCost) || b.maxSdkEstimatedCost <= 0) throw new HarnessError("improvement.research-plan", "maxSdkEstimatedCost must be positive");
 const validateChildBudget = (value: unknown, name: string) => {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !budgetKeys.has(key))) throw new HarnessError("improvement.research-plan", `${name} must be an explicit closed budget`);
  const child = value as Record<string, unknown>;
  for (const key of ["maxProviderCalls", "maxInputTokens", "maxOutputTokens", "maxProbeCalls", "maxCpuMillis", "maxWallMillis"] as const) integer(child[key], `${name}.${key}`, key === "maxProbeCalls" ? 0 : 1, 10_000_000);
  if (typeof child.maxSdkEstimatedCost !== "number" || !Number.isFinite(child.maxSdkEstimatedCost) || child.maxSdkEstimatedCost <= 0) throw new HarnessError("improvement.research-plan", `${name}.maxSdkEstimatedCost must be positive`);
 };
 if (p.target === "improver" && p.pilotBudget === undefined) throw new HarnessError("improvement.research-plan", "I development requires an explicit independent pilotBudget");
 if (p.pilotBudget !== undefined) validateChildBudget(p.pilotBudget, "pilotBudget");
 if (p.admissionCaseSetPath !== undefined) {
  for (const name of ["outerBudget", "pilotBudget", "protectedBudget"] as const) validateChildBudget(p[name], name);
  if (((p.outerBudget as BudgetLimits).maxProviderCalls) < (p.maxDecisions as number) * (1 + ((p.schemaRepairAttempts as number | undefined) ?? 0))) throw new HarnessError("improvement.research-plan", "outer provider-call cap cannot cover declared decisions and schema repairs");
  integer(p.searchReplicates, "searchReplicates", 1, 10); integer(p.outcomeReplicates, "outcomeReplicates", 2, 10);
  if ((p.outcomeReplicates as number) % 2 !== 0 || p.outcomeReplicates !== p.admissionRepetitions) throw new HarnessError("improvement.research-plan", "outcomeReplicates must equal the even admissionRepetitions");
  if (p.experimentKind === "executor-quality" && p.searchReplicates !== 1) throw new HarnessError("improvement.research-plan", "executor quality has one outer search");
  if (p.experimentKind === "meta-improvement" && !["quality", "efficiency"].includes(String(p.metaProtocol))) throw new HarnessError("improvement.research-plan", "metaProtocol is required for matched admission");
 } else if (p.outerBudget !== undefined || p.protectedBudget !== undefined || p.searchReplicates !== undefined || p.outcomeReplicates !== undefined || p.metaProtocol !== undefined) throw new HarnessError("improvement.research-plan", "admission phase controls require an admission case set");
 if (p.experimentKind === "meta-improvement" && p.admissionCaseSetPath !== undefined) {
  integer(p.maxCandidatesPerMetaArm, "maxCandidatesPerMetaArm", 1, 10);
  const child = p.metaBranchBudget;
  if (!child || typeof child !== "object" || Array.isArray(child) || Object.keys(child).some((key) => !budgetKeys.has(key))) throw new HarnessError("improvement.research-plan", "metaBranchBudget is required and closed");
  validateChildBudget(child, "metaBranchBudget");
  const m = child as Record<string, unknown>;
  if ((m.maxProviderCalls as number) < (p.maxDecisions as number) * (1 + ((p.schemaRepairAttempts as number | undefined) ?? 0))) throw new HarnessError("improvement.research-plan", "meta branch provider-call cap cannot cover declared decisions and schema repairs");
  for (const key of ["maxProviderCalls", "maxInputTokens", "maxOutputTokens", "maxProbeCalls", "maxCpuMillis"] as const) {
   integer(m[key], `metaBranchBudget.${key}`, key === "maxProbeCalls" ? 0 : 1, 10_000_000);
   if ((m[key] as number) * 2 > (b[key] as number)) throw new HarnessError("improvement.research-plan", "two matched meta branches exceed root budget");
  }
  integer(m.maxWallMillis, "metaBranchBudget.maxWallMillis", 100, 86_400_000);
  if ((m.maxWallMillis as number) > (b.maxWallMillis as number) || typeof m.maxSdkEstimatedCost !== "number" || !Number.isFinite(m.maxSdkEstimatedCost) || m.maxSdkEstimatedCost <= 0 || m.maxSdkEstimatedCost * 2 > (b.maxSdkEstimatedCost as number)) throw new HarnessError("improvement.research-plan", "invalid matched meta cost/wall cap");
 } else if (p.metaBranchBudget !== undefined || p.maxCandidatesPerMetaArm !== undefined) throw new HarnessError("improvement.research-plan", "matched meta branch controls require a protected meta admission case set");
 return p as unknown as ResearchCampaignPlanV1;
}
