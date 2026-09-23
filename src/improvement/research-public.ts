/** Deliberately small model-facing projections; protected case paths and reports stay controller-only. */
import type { ResearchRunV1 } from "./research-types.ts";
import type { ActiveGenerationPointerV1, GenerationBundleV1 } from "./generation.ts";

export function publicResearchRun(run: ResearchRunV1) {
 const budget = run.budgetAtEnd as { settlement?: string; committed?: Record<string, number> } | undefined;
 return { runId: run.runId, status: run.status, selectedCandidateId: run.selectedCandidateId,
  candidates: run.candidates.map((c) => ({ id: c.id, kind: c.kind, strategyVersionId: c.strategyVersionId, origin: c.origin, developmentStatus: c.developmentStatus })),
  decisionCount: run.decisions.length, feedbackCount: run.feedback.length,
  budget: budget ? { settlement: budget.settlement, committed: budget.committed, costSource: "sdk-estimate" as const } : undefined,
  conclusion: run.status === "promoted" ? "local protocol admitted; see controller record for scope" : "no new locally admitted generation; see controller record for details" };
}

export function publicResearchStatus(status: { active?: { pointer: ActiveGenerationPointerV1; bundle: GenerationBundleV1 }; bundles: string[] }) {
 return { active: status.active ? { bundleId: status.active.bundle.bundleId,
  executorVersionId: status.active.bundle.executorVersionId, improverVersionId: status.active.bundle.improverVersionId,
  provenance: status.active.pointer.provenance, activatedAt: status.active.pointer.activatedAt } : undefined,
  bundleIds: status.bundles };
}
