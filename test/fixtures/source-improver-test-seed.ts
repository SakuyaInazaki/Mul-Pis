/** Fixed test actor for harness protocol regressions; never inherit the evolvable runtime I. */
import { writeFile } from "node:fs/promises";
import path from "node:path";

export async function writeControlledSourceImproverSeed(repository: string): Promise<void> {
 await writeFile(path.join(repository, "src/improvement/workflow-improver-program.ts"), `
export function decideWorkflowImprovement(state) {
 const unread = state.availableDevelopmentIds.find(id => !state.inspectedDevelopment.some(item => item.id === id));
 if (unread) return { kind: "inspect-development", id: unread };
 const analysis = state.modelObservations.at(-1);
 if (!analysis || analysis.status === "parse-error") return {
  kind: "ask-model", format: "json", evidenceIds: state.inspectedDevelopment.map(item => item.id),
  ...(analysis ? { observationIds: [analysis.id] } : {}), prompt: "Return one source-edit brief as JSON."
 };
 if (analysis.status === "provider-failed") return { kind: "stop", reason: "test model analysis did not settle" };
 if (!state.candidates.length) {
  if (state.operationFailures.at(-1)?.kind === "propose-source") return { kind: "stop", reason: "test source proposal failed" };
  return { kind: "propose-source", brief: analysis.parsed?.brief ?? analysis.text,
   evidenceIds: state.inspectedDevelopment.map(item => item.id) };
 }
 const untested = state.candidates.find(candidate => !state.evaluations.some(item => item.candidateId === candidate.id));
 if (untested?.status === "ready") return { kind: "evaluate-development", candidateId: untested.id };
 if (untested) return { kind: "stop", reason: "test source candidate is not ready" };
 const preferred = state.evaluations.find(item => item.status === "preferred" &&
  state.candidates.some(candidate => candidate.id === item.candidateId && candidate.status === "ready"));
 return preferred ? { kind: "stop", candidateId: preferred.candidateId, reason: "test preferred candidate" }
  : { kind: "stop", reason: "test no preferred candidate" };
}
`);
}
