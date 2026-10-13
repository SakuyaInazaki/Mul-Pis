/** Human seed I: one evidence read, one model analysis, one source proposal and development comparison. */
import type { WorkflowImproverActionV1, WorkflowImproverStateV1 } from "./workflow-improver-types.ts";

export function decideWorkflowImprovement(state: WorkflowImproverStateV1): WorkflowImproverActionV1 {
 const unread = state.availableDevelopmentIds.find(id => !state.inspectedDevelopment.some(item => item.id === id));
 if (unread) return { kind: "inspect-development", id: unread };
 const lastAnalysis = state.modelObservations.at(-1);
 if (!lastAnalysis || lastAnalysis.status === "parse-error") {
  const cited = state.inspectedDevelopment.map(item => item.id);
  return { kind: "ask-model", format: "json", evidenceIds: cited,
   ...(lastAnalysis?.status === "parse-error" ? { observationIds: [lastAnalysis.id] } : {}),
   prompt: `Analyze the inspected development evidence. Return JSON with a falsifiable claim and a brief for one source candidate.${lastAnalysis?.status === "parse-error" ? ` Previous JSON parse failed: ${lastAnalysis.error ?? "invalid JSON"}.` : ""}` };
 }
 if (lastAnalysis.status === "provider-failed") return { kind: "stop", reason: "model analysis did not settle" };
 if (!state.candidates.length) {
  if (state.operationFailures.at(-1)?.kind === "propose-source") return { kind: "stop", reason: "source proposal failed during development" };
  const parsed = lastAnalysis.parsed as { brief?: unknown } | undefined;
  const brief = typeof parsed?.brief === "string" && parsed.brief.trim() ? parsed.brief : lastAnalysis.text ?? "";
  return { kind: "propose-source", brief, evidenceIds: state.inspectedDevelopment.map(item => item.id) };
 }
 const untested = state.candidates.find(candidate => !state.evaluations.some(item => item.candidateId === candidate.id));
 if (untested && untested.status === "ready") return { kind: "evaluate-development", candidateId: untested.id };
 if (untested) return { kind: "stop", reason: "generated candidate is not ready for development comparison" };
 const preferred = state.evaluations.find(item => item.status === "preferred" && state.candidates.some(candidate => candidate.id === item.candidateId && candidate.status === "ready"));
 return preferred ? { kind: "stop", candidateId: preferred.candidateId, reason: "development comparison preferred this candidate" }
  : { kind: "stop", reason: "no candidate was preferred by development comparison" };
}
