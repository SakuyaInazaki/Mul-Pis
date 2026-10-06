/** A bounded development-only record. Construct it before any protected evaluation. */
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { HarnessError } from "../types.ts";
import type { ResearchRunV1 } from "./research-types.ts";
import type { WorkflowRunV1 } from "./workflow-types.ts";
import type { GenerationBundleV1, GenerationStore } from "./generation.ts";
import { writeFileAtomic } from "../workspace.ts";

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
 /** Complete development-only workflow arm observations; never protected G arms. */
 workflowDevelopmentArms?: Array<{ caseId: string; arm: string; methodVersionId: string; status: string; reason?: string; checkResults: Array<{ criterion: string; passed: boolean }>; reportDeliveredToM04?: boolean; feedbackStatus?: string; usage: WorkflowRunV1["developmentArms"][number]["usage"] }>;
 selectedCandidateId?: string; terminal: "selected" | "no-winner" | "inconclusive";
 usage: { providerCalls: number; inputTokens: number; outputTokens: number; sdkEstimatedCost: number; costSource: "sdk-estimate" | "unknown"; settlement: string };
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
 const budget = run.developmentBudgetAtSelection as { committed?: { providerCalls?: number; inputTokens?: number; outputTokens?: number; sdkEstimatedCost?: number }; settlement?: string; usageUnknown?: boolean } | undefined;
 return { version: 1, id: `meta:${run.runId}`, runId: run.runId, workspaceRoot: path.resolve(workspaceRoot), createdAt: new Date().toISOString(), phase: "development", target,
  current: { bundleId: run.frozenBundle.bundleId, executorVersionId: run.frozenBundle.executorVersionId, improverVersionId: run.frozenBundle.improverVersionId,
   knowledgeSnapshot: run.frozenBundle.knowledgeSnapshot, environmentVersion: run.frozenBundle.environmentVersion, modelConfig: run.frozenBundle.modelConfig, protocolVersion: run.frozenBundle.protocolVersion },
  decisions: outer.map((d) => ({ index: d.index, improverVersionId: d.improverVersionId, kind: d.action?.kind, outcome: d.outcome, feedbackId: d.feedbackId, reason: d.reason })),
  candidates: outerCandidates.map((c) => ({ id: c.id, kind: c.kind, strategyVersionId: c.strategyVersionId,
   hypothesis: { claim: c.hypothesis.claim, predictedObservation: c.hypothesis.predictedObservation, falsifier: c.hypothesis.falsifier, motivatingEvidenceIds: c.hypothesis.motivatingEvidenceIds }, developmentStatus: c.developmentStatus })),
  feedbackIndex: feedback.map((f) => ({ id: f.id, caseId: f.caseId, status: f.status, observationCount: f.observations.length })),
  feedbackExcerpt: feedback.map((f) => ({ id: f.id, caseId: f.caseId, status: f.status, observationCount: f.observations.length,
   observations: f.observations.map((o) => ({ x: o.x, y: o.y, xUnit: o.xUnit, yUnit: o.yUnit, source: o.source })),
   evidenceIds: f.evidence.map((ref) => `${ref.storeId}/${ref.id}@${ref.version}`) })),
  feedbackTotal: feedback.length, feedbackExcerptCount: feedback.length,
  ...(run.selectedCandidateId ? { selectedCandidateId: run.selectedCandidateId } : {}), terminal,
  usage: { providerCalls: budget?.committed?.providerCalls ?? 0, inputTokens: budget?.committed?.inputTokens ?? 0, outputTokens: budget?.committed?.outputTokens ?? 0,
   sdkEstimatedCost: budget?.committed?.sdkEstimatedCost ?? 0, costSource: budget?.usageUnknown ? "unknown" : "sdk-estimate", settlement: budget?.settlement ?? "unknown" } };
}
const PART_BYTES = 120_000;
type PartIndex = { version: 1; kind: "meta-episode-parts"; runId: string; totalUtf8Bytes: number; totalChars: number; parts: Array<{ file: string; utf8Bytes: number; start: number; end: number }> };

/** Freeze the complete development-only view without enlarging any existing file bound. */
export async function writeMetaEpisode(file: string, episode: MetaEpisodeV1): Promise<void> {
 const text = `${JSON.stringify(episode, null, 2)}\n`;
 if (Buffer.byteLength(text, "utf8") <= PART_BYTES) { await writeFileAtomic(file, text); return; }
 const parts: PartIndex["parts"] = [];
 let segment = "", bytes = 0, start = 0;
 const flush = async () => {
  if (!segment) return;
  const name = `meta-episode.development.part-${String(parts.length).padStart(4, "0")}.txt`;
  await writeFileAtomic(path.join(path.dirname(file), name), segment);
  parts.push({ file: name, utf8Bytes: bytes, start, end: start + segment.length });
  start += segment.length; segment = ""; bytes = 0;
 };
 for (const character of text) {
  const size = Buffer.byteLength(character, "utf8");
  if (bytes + size > PART_BYTES) await flush();
  segment += character; bytes += size;
 }
 await flush();
 const index: PartIndex = { version: 1, kind: "meta-episode-parts", runId: episode.runId, totalUtf8Bytes: Buffer.byteLength(text, "utf8"), totalChars: text.length, parts };
 if (Buffer.byteLength(JSON.stringify(index), "utf8") > PART_BYTES) throw new HarnessError("improvement.meta-episode", "development episode part index exceeds retained-file size");
 await writeFileAtomic(file, `${JSON.stringify(index, null, 2)}\n`);
}

async function readMetaEpisode(file: string, runId: string): Promise<MetaEpisodeV1> {
 if ((await stat(file)).size > PART_BYTES) throw new HarnessError("improvement.meta-episode", "development episode index exceeds retained-file size");
 const parsed = JSON.parse(await readFile(file, "utf8")) as MetaEpisodeV1 | PartIndex;
 if ("kind" in parsed && parsed.kind === "meta-episode-parts") {
  if (parsed.version !== 1 || parsed.runId !== runId || !Number.isSafeInteger(parsed.totalUtf8Bytes) || !Number.isSafeInteger(parsed.totalChars) || !Array.isArray(parsed.parts) || !parsed.parts.length) throw new HarnessError("improvement.meta-episode", "invalid development episode part index");
  let text = "", totalBytes = 0;
  for (let i = 0; i < parsed.parts.length; i++) {
   const part = parsed.parts[i]!;
   const name = `meta-episode.development.part-${String(i).padStart(4, "0")}.txt`;
   if (part.file !== name || !Number.isSafeInteger(part.utf8Bytes) || part.utf8Bytes < 1 || part.utf8Bytes > PART_BYTES || part.start !== text.length || !Number.isSafeInteger(part.end) || part.end <= part.start) throw new HarnessError("improvement.meta-episode", "invalid development episode part range");
   const filePath = path.join(path.dirname(file), name);
   let value: string;
   try {
    if ((await stat(filePath)).size !== part.utf8Bytes) throw new Error("size changed");
    value = await readFile(filePath, "utf8");
   } catch { throw new HarnessError("improvement.meta-episode", "development episode part is missing or changed"); }
   if (value.length !== part.end - part.start || Buffer.byteLength(value, "utf8") !== part.utf8Bytes) throw new HarnessError("improvement.meta-episode", "development episode part range changed");
   text += value; totalBytes += part.utf8Bytes;
  }
  if (text.length !== parsed.totalChars || totalBytes !== parsed.totalUtf8Bytes) throw new HarnessError("improvement.meta-episode", "development episode parts are incomplete");
  return JSON.parse(text) as MetaEpisodeV1;
 }
 return parsed as MetaEpisodeV1;
}
export async function loadMetaEpisode(researchRoot: string, workspaceRoot: string, runId: string): Promise<MetaEpisodeV1> {
 const file = metaEpisodePath(researchRoot, runId);
 const value = await readMetaEpisode(file, runId);
 if (value.version !== 1 || value.phase !== "development" || value.runId !== runId || value.id !== `meta:${runId}` || value.workspaceRoot !== path.resolve(workspaceRoot) ||
  !Array.isArray(value.decisions) || !Array.isArray(value.candidates) || !Array.isArray(value.feedbackIndex) ||
  !Array.isArray(value.feedbackExcerpt) || value.feedbackTotal !== value.feedbackIndex.length || value.feedbackExcerptCount !== value.feedbackExcerpt.length ||
  !["selected", "no-winner", "inconclusive"].includes(value.terminal) || !value.usage || !["sdk-estimate", "unknown"].includes(value.usage.costSource)) throw new HarnessError("improvement.meta-episode", "cross-workspace or malformed development episode");
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
  omittedFeedbackCount: episode.workflowDevelopmentArms ? 0 : episode.feedbackTotal - episode.feedbackExcerptCount, workflowDevelopmentArms: episode.workflowDevelopmentArms,
  selectedCandidateId: episode.selectedCandidateId, terminal: episode.terminal, usage: episode.usage };
}

/** The workflow adapter uses the same bounded development episode schema, with no CPU observations. */
export function buildWorkflowMetaEpisode(run: WorkflowRunV1, bundle: GenerationBundleV1, workspaceRoot: string, terminal: MetaEpisodeV1["terminal"]): MetaEpisodeV1 {
 const budget = run.developmentBudgetAtSelection as { committed?: { providerCalls?: number; inputTokens?: number; outputTokens?: number; sdkEstimatedCost?: number }; settlement?: string; usageUnknown?: boolean } | undefined;
 return { version: 1, id: `meta:${run.runId}`, runId: run.runId, workspaceRoot: path.resolve(workspaceRoot), createdAt: new Date().toISOString(), phase: "development", target: "executor",
  current: { bundleId: bundle.bundleId, executorVersionId: run.baselineExecutorVersionId, improverVersionId: run.improverVersionId, knowledgeSnapshot: run.knowledgeSnapshot, environmentVersion: "m07-workflow/v1", modelConfig: bundle.modelConfig, protocolVersion: bundle.protocolVersion },
  decisions: run.decisions.map((d) => ({ index: d.index, improverVersionId: d.improverVersionId, kind: d.action, outcome: d.outcome })),
  candidates: run.candidates.map((c) => { const h = c.hypothesis as { claim: string; predictedObservation: string; falsifier: string; motivatingEvidenceIds: string[] }; return { id: c.versionId, kind: "executor", strategyVersionId: c.versionId, hypothesis: { claim: h.claim, predictedObservation: h.predictedObservation, falsifier: h.falsifier, motivatingEvidenceIds: h.motivatingEvidenceIds }, developmentStatus: c.developmentStatus }; }),
  feedbackIndex: run.developmentArms.map((arm, index) => ({ id: `workflow:${run.runId}:${index}`, caseId: arm.caseId, status: arm.status, observationCount: arm.checkResults.length })),
  feedbackExcerpt: [], feedbackTotal: run.developmentArms.length, feedbackExcerptCount: 0,
  workflowDevelopmentArms: run.developmentArms.map((arm) => ({ caseId: arm.caseId, arm: arm.arm, methodVersionId: arm.methodVersionId, status: arm.status, reason: arm.reason, checkResults: arm.checkResults, reportDeliveredToM04: arm.reportDeliveredToM04, feedbackStatus: arm.feedbackStatus, usage: arm.usage })),
  ...(run.selectedCandidateId ? { selectedCandidateId: run.selectedCandidateId } : {}), terminal,
  usage: { providerCalls: budget?.committed?.providerCalls ?? 0, inputTokens: budget?.committed?.inputTokens ?? 0, outputTokens: budget?.committed?.outputTokens ?? 0, sdkEstimatedCost: budget?.committed?.sdkEstimatedCost ?? 0, costSource: budget?.usageUnknown ? "unknown" : "sdk-estimate", settlement: budget?.settlement ?? "unknown" } };
}

export async function loadWorkflowMetaEpisode(researchRoot: string, workspaceRoot: string, runId: string, generations: GenerationStore): Promise<MetaEpisodeV1> {
 if (!SAFE_RUN.test(runId)) throw new HarnessError("improvement.meta-episode", "invalid workflow run ID");
 const dir = path.join(researchRoot, "workflow-runs", runId), file = path.join(dir, "meta-episode.development.json");
 if ((await stat(file)).size > 120_000 || (await stat(path.join(dir, "run.json"))).size > 3_000_000) throw new HarnessError("improvement.meta-episode", "workflow development episode exceeds read limits");
 const value = await readMetaEpisode(file, runId);
 const source = JSON.parse(await readFile(path.join(dir, "run.json"), "utf8")) as WorkflowRunV1;
 const bundle = await generations.readBundle(source.baselineBundleId);
 if (value.version !== 1 || value.id !== `meta:${runId}` || value.runId !== runId || value.phase !== "development" || value.target !== "executor" || value.workspaceRoot !== path.resolve(workspaceRoot) || source.runId !== runId || source.kind !== "m07-evidence-handoff/v1" || !source.metaEpisodeIds?.includes(value.id) || !source.developmentBudgetAtSelection || source.knowledgeSnapshot !== bundle.knowledgeSnapshot || !["selected", "no-winner", "inconclusive"].includes(value.terminal) ||
  JSON.stringify(metaEpisodeForModel(buildWorkflowMetaEpisode(source, bundle, workspaceRoot, value.terminal))) !== JSON.stringify(metaEpisodeForModel(value))) throw new HarnessError("improvement.meta-episode", "workflow episode does not match its same-workspace development source");
 return value;
}
