/** Fixed host contract for a source-backed I program. The program sees development observations only. */
import type { UsageSummary } from "../runner/types.ts";

export interface WorkflowImproverStateV1 {
 version: 1;
 improverVersionId: string;
 availableDevelopmentIds: string[];
 inspectedDevelopment: Array<{ id: string; text: string }>;
 modelObservations: Array<{ id: string; prompt: string; evidenceIds: string[]; format: "json" | "text";
  status: "returned" | "parse-error" | "provider-failed"; text?: string; parsed?: unknown; error?: string }>;
 candidates: Array<{ id: string; status: "ready" | "not-ready"; sourceCommit?: string; reason?: string }>;
 evaluations: Array<{ candidateId: string; status: "preferred" | "rejected" | "unknown" | "failed"; reason: string }>;
 operationFailures: Array<{ kind: string; reason: string }>;
 lastAction?: WorkflowImproverActionV1;
}
export type WorkflowImproverActionV1 =
 | { kind: "inspect-development"; id: string }
 | { kind: "ask-model"; prompt: string; evidenceIds: string[]; observationIds?: string[]; format: "json" | "text" }
 | { kind: "propose-source"; brief: string; evidenceIds: string[] }
 | { kind: "evaluate-development"; candidateId: string }
 | { kind: "stop"; candidateId?: string; reason: string };

export interface SourceSearchCandidateV1 {
 id: string; status: "ready" | "not-ready"; sourceRoot?: string; sourceCommit?: string; reason?: string;
 receiptPath: string; usage: UsageSummary;
}
export interface SourceSearchEvaluationV1 {
 candidateId: string; status: "preferred" | "rejected" | "unknown"; reason: string;
 receiptPath: string; usage: UsageSummary;
}
