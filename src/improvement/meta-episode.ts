/** A bounded development-only record. Construct it before any protected evaluation. */
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { HarnessError } from "../types.ts";
import type { ResearchRunV1 } from "./research-types.ts";

const SAFE_RUN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
export interface MetaEpisodeV1 {
 version: 1; id: string; runId: string; workspaceRoot: string; createdAt: string;
 phase: "development"; target: "executor" | "improver";
 current: { bundleId: string; executorVersionId: string; improverVersionId: string; knowledgeSnapshot?: string; environmentVersion: string; modelConfig: { improver: string; research: string }; protocolVersion: string };
 decisions: Array<{ index: number; improverVersionId: string; kind?: string; outcome: string; feedbackId?: string; reason?: string }>;
 candidates: Array<{ id: string; kind: string; strategyVersionId: string; hypothesis: { claim: string; predictedObservation: string; falsifier: string; motivatingEvidenceIds: string[] }; developmentStatus: string }>;
 feedbackIndex: Array<{ id: string; caseId?: string; status: string; observationCount: number }>;
 feedbackExcerpt: Array<{ id: string; caseId?: string; status: string; observationCount: number; observations: Array<{ x: number; y: number; xUnit: string; yUnit: string; source: string }>; evidenceIds: string[] }>;
 feedbackTotal: number; feedbackExcerptCount: number;
 selectedCandidateId?: string; terminal: "selected" | "no-winner" | "inconclusive";
 usage: { providerCalls: number; inputTokens: number; outputTokens: number; sdkEstimatedCost: number; costSource: "sdk-estimate"; settlement: string };
}
export function metaEpisodePath(researchRoot: string, runId: string): string {
 if (!SAFE_RUN.test(runId)) throw new HarnessError("improvement.meta-episode", "invalid run ID");
 return path.join(researchRoot, "runs", runId, "meta-episode.development.json");
}
export function buildMetaEpisode(run: ResearchRunV1, workspaceRoot: string, target: MetaEpisodeV1["target"], terminal: MetaEpisodeV1["terminal"]): MetaEpisodeV1 {
 const outer = run.decisions.filter((d) => d.branchPrefix === "outer");
 const outerCandidates = run.candidates.filter((c) => c.branchPrefix === "outer");
 const visible = new Set(outer.flatMap((d) => d.visibleFeedbackIds));
 for (const item of outerCandidates) for (const id of item.developmentEvidence) visible.add(id);
 for (const item of run.feedback) if (item.id.startsWith("outer-initial-")) visible.add(item.id);
 const feedback = run.feedback.filter((f) => visible.has(f.id));
 if (outer.length > 30 || outerCandidates.length > 10 || feedback.length > 1_000) throw new HarnessError("improvement.meta-episode", "development episode exceeds bounded control index");
 const budget = run.developmentBudgetAtSelection as { committed?: { providerCalls?: number; inputTokens?: number; outputTokens?: number; sdkEstimatedCost?: number }; settlement?: string } | undefined;
 return { version: 1, id: `meta:${run.runId}`, runId: run.runId, workspaceRoot: path.resolve(workspaceRoot), createdAt: new Date().toISOString(), phase: "development", target,
  current: { bundleId: run.frozenBundle.bundleId, executorVersionId: run.frozenBundle.executorVersionId, improverVersionId: run.frozenBundle.improverVersionId,
   knowledgeSnapshot: run.frozenBundle.knowledgeSnapshot, environmentVersion: run.frozenBundle.environmentVersion, modelConfig: run.frozenBundle.modelConfig, protocolVersion: run.frozenBundle.protocolVersion },
  decisions: outer.map((d) => ({ index: d.index, improverVersionId: d.improverVersionId, kind: d.action?.kind, outcome: d.outcome, feedbackId: d.feedbackId, reason: d.reason?.slice(0, 160) })),
  candidates: outerCandidates.map((c) => ({ id: c.id, kind: c.kind, strategyVersionId: c.strategyVersionId,
   hypothesis: { claim: c.hypothesis.claim, predictedObservation: c.hypothesis.predictedObservation, falsifier: c.hypothesis.falsifier, motivatingEvidenceIds: c.hypothesis.motivatingEvidenceIds }, developmentStatus: c.developmentStatus })),
  feedbackIndex: feedback.map((f) => ({ id: f.id, caseId: f.caseId, status: f.status, observationCount: f.observations.length })),
  feedbackExcerpt: feedback.slice(0, 40).map((f) => ({ id: f.id, caseId: f.caseId, status: f.status, observationCount: f.observations.length,
   observations: f.observations.slice(0, 16).map((o) => ({ x: o.x, y: o.y, xUnit: o.xUnit, yUnit: o.yUnit, source: o.source })),
   evidenceIds: f.evidence.map((ref) => `${ref.storeId}/${ref.id}@${ref.version}`) })),
  feedbackTotal: feedback.length, feedbackExcerptCount: Math.min(feedback.length, 40),
  ...(run.selectedCandidateId ? { selectedCandidateId: run.selectedCandidateId } : {}), terminal,
  usage: { providerCalls: budget?.committed?.providerCalls ?? 0, inputTokens: budget?.committed?.inputTokens ?? 0, outputTokens: budget?.committed?.outputTokens ?? 0,
   sdkEstimatedCost: budget?.committed?.sdkEstimatedCost ?? 0, costSource: "sdk-estimate", settlement: budget?.settlement ?? "unknown" } };
}
export async function loadMetaEpisode(researchRoot: string, workspaceRoot: string, runId: string): Promise<MetaEpisodeV1> {
 const file = metaEpisodePath(researchRoot, runId);
 if ((await stat(file)).size > 120_000) throw new HarnessError("improvement.meta-episode", "development episode exceeds fixed size");
 const value = JSON.parse(await readFile(file, "utf8")) as MetaEpisodeV1;
 if (value.version !== 1 || value.phase !== "development" || value.runId !== runId || value.id !== `meta:${runId}` || value.workspaceRoot !== path.resolve(workspaceRoot) ||
  !Array.isArray(value.decisions) || value.decisions.length > 30 || !Array.isArray(value.candidates) || value.candidates.length > 10 || !Array.isArray(value.feedbackIndex) || value.feedbackIndex.length > 1_000 ||
  !Array.isArray(value.feedbackExcerpt) || value.feedbackExcerpt.length > 40 || value.feedbackTotal !== value.feedbackIndex.length || value.feedbackExcerptCount !== value.feedbackExcerpt.length ||
  !["selected", "no-winner", "inconclusive"].includes(value.terminal) || !value.usage || value.usage.costSource !== "sdk-estimate") throw new HarnessError("improvement.meta-episode", "cross-workspace or malformed development episode");
 const runFile = path.join(researchRoot, "runs", runId, "run.json");
 if ((await stat(runFile)).size > 3_000_000) throw new HarnessError("improvement.meta-episode", "source run exceeds controller read limit");
 const source = JSON.parse(await readFile(runFile, "utf8")) as ResearchRunV1;
 if (source.runId !== runId || source.developmentTarget !== value.target || source.developmentTerminal !== value.terminal || !source.developmentBudgetAtSelection ||
  !source.metaEpisodeIds?.includes(value.id) ||
  JSON.stringify(metaEpisodeForModel(buildMetaEpisode(source, workspaceRoot, value.target, value.terminal))) !== JSON.stringify(metaEpisodeForModel(value)))
  throw new HarnessError("improvement.meta-episode", "development episode does not match its controller source run");
 return value;
}

/** Never pass workspaceRoot or private controller fields to I. */
export function metaEpisodeForModel(episode: MetaEpisodeV1) {
 return { id: episode.id, runId: episode.runId, phase: episode.phase, target: episode.target, current: episode.current,
  decisions: episode.decisions, candidates: episode.candidates, feedbackIndex: episode.feedbackIndex, feedbackExcerpt: episode.feedbackExcerpt,
  feedbackTotal: episode.feedbackTotal, feedbackExcerptCount: episode.feedbackExcerptCount,
  omittedFeedbackCount: episode.feedbackTotal - episode.feedbackExcerptCount, selectedCandidateId: episode.selectedCandidateId, terminal: episode.terminal, usage: episode.usage };
}
