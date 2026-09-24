/** Explicit, bounded method-research campaign. Existing mechanism-cost improvement remains separate. */
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, realpath, rmdir, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { resolveRoleModel } from "../config.ts";
import { SharedBudget } from "../experiments/budget.ts";
import { reserveResearchPhases } from "../experiments/budget-preflight.ts";
import type { ArtifactRef, BudgetLease, DevelopmentEnvironment, DevelopmentFeedback, ExecutorStrategyV1, ExperimentStart, PublicTask, ScientificAction } from "../experiments/contracts.ts";
import { createCpuResponseEnvironment, validateCpuCaseSet, type CpuCaseSetV1, type CpuResponseCase } from "../experiments/local-environment.ts";
import { createExperienceProvider, verifyRequiredKnowledge } from "../knowledge/experience-index.ts";
import { createFileKnowledgeStore } from "../knowledge/store.ts";
import type { KnowledgeRef, KnowledgeStore } from "../knowledge/types.ts";
import type { SessionRunner } from "../runner/types.ts";
import { HarnessError } from "../types.ts";
import { nowIso, Workspace, writeFileAtomic } from "../workspace.ts";
import { runExecutorEpisode, runExecutorQualityAdmission } from "./executor-eval.ts";
import { GenerationStore, isCpuExecutorStrategy, type ExperienceRequirementV1, type GenerationBundleV1, type ImproverStrategyV1, type StrategyRecordV1, validateExperienceRequirements, validateStrategy } from "./generation.ts";
import { advanceKnowledgeEpochInLock, transitionMethodKnowledgeDependenciesInLock } from "./knowledge-epoch.ts";
import { bindMethodPackageV2, exportMethodPackageV2, readMethodPackageV2 } from "./method-v2.ts";
import { buildMetaEpisode, loadMetaEpisode, metaEpisodeForModel, metaEpisodePath, type MetaEpisodeV1 } from "./meta-episode.ts";
import { runMetaImprovementAdmission, type ProducedSuccessorV1 } from "./meta-eval.ts";
import { decisionPrompt, fullyReadDevelopmentFeedbackIds, improverSystemPrompt, validateResearchAction, type ResearchCaseViewV1, type ResearchDecisionViewV1, type ResearchInspectionRequestV1, type ResearchInspectionResultV1 } from "./policy-host.ts";
import { runBoundedModelStep } from "./research-model.ts";
import { validateResearchPlan, type ResearchCampaignPlanV1, type ResearchCandidateV1, type ResearchDecisionRecordV1, type ResearchRunV1 } from "./research-types.ts";

const activeMutations = new Set<string>();
const RUN_ID = () => `${new Date().toISOString().replace(/[-:.]/g, "")}-${randomBytes(3).toString("hex")}`;
export interface ResearchServiceOptions { workspaceRoot: string; runner: SessionRunner; registeredExperienceStores?: ReadonlyMap<string, KnowledgeStore> }
export interface ResearchBootstrapInput { version: 1; executor: ExecutorStrategyV1; improver: ImproverStrategyV1; applicability: string[] }
type SearchResult = { selected?: ResearchCandidateV1; selectedAt?: string; decisionCount: number; status: "selected" | "no-winner" | "inconclusive"; stopReason?: string };

/** Recheck pinned necessary experience before every new child invocation and pointer transition. */
export async function verifyRequiredExperience(workspaceRoot: string, requirements: ExperienceRequirementV1[], expectedSnapshotId?: string, registeredStores?: ReadonlyMap<string, KnowledgeStore>): Promise<void> {
 const checked = validateExperienceRequirements(requirements, "requiredExperienceRefs");
 if (!checked.length) return;
 const ws = new Workspace(workspaceRoot), store = createFileKnowledgeStore(ws.knowledgeDir); await store.init();
 const provider = createExperienceProvider(store, registeredStores);
 for (const targetKind of ["executor", "improver"] as const) {
  const requestedRefs = checked.filter((item) => item.targetKind === targetKind).map((item) => item.ref);
  if (!requestedRefs.length) continue;
  const result = await provider.select({ targetKind, applicability: { stage: "method-research", tags: ["cpu-response-identification"] }, requestedRefs,
   expectedSnapshotId, maxRecords: 100, maxChars: 100_000 });
  if (result.status !== "ready" || result.selected.length !== requestedRefs.length) throw new HarnessError("improvement.experience", "required method experience is unavailable, changed, or not locally registered");
 }
}
function combineKnowledgeRefs(...groups: KnowledgeRef[][]): KnowledgeRef[] {
 const refs = new Map<string, KnowledgeRef>();
 for (const ref of groups.flat()) refs.set(`${ref.storeId}/${ref.recordId}@${ref.version}`, ref);
 if (refs.size > 100) throw new HarnessError("improvement.experience", "inherited pinned knowledge references exceed limit");
 return [...refs.values()];
}
function combineRequirements(...groups: ExperienceRequirementV1[][]): ExperienceRequirementV1[] {
 const byId = new Map<string, ExperienceRequirementV1>();
 for (const item of groups.flat()) byId.set(`${item.targetKind}:${item.ref.storeId}/${item.ref.recordId}@${item.ref.version}`, item);
 return validateExperienceRequirements([...byId.values()], "inherited requiredExperienceRefs");
}

async function loadCaseSet(file: string, split: CpuCaseSetV1["split"]): Promise<CpuCaseSetV1> {
 let value: unknown;
 try { if ((await stat(file)).size > 2_000_000) throw new Error("case set exceeds 2 MB"); value = JSON.parse(await readFile(file, "utf8")); }
 catch (error) { throw new HarnessError("improvement.research-cases", `cannot load case set: ${(error as Error).message}`); }
 const set = validateCpuCaseSet(value);
 if (set.split !== split) throw new HarnessError("improvement.research-cases", `expected ${split} case set`);
 return set;
}
async function loadPriorDevelopmentFeedback(file: string, currentCase: CpuResponseCase): Promise<{ feedback: DevelopmentFeedback[]; source: NonNullable<ResearchRunV1["priorDevelopmentSource"]> }> {
 const caseId = currentCase.id;
 if ((await stat(file)).size > 64_000) throw new HarnessError("improvement.prior-feedback", "development feedback handoff exceeds 64 KB");
 const raw = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
 if (raw.version !== 1 || raw.caseId !== caseId || typeof raw.methodVersionId !== "string" || !Array.isArray(raw.developmentFeedback) || raw.developmentFeedback.length > 16 || typeof raw.claimBoundary !== "string" || raw.claimBoundary.length > 500) throw new HarnessError("improvement.prior-feedback", "invalid public development feedback handoff");
 const oldFile = path.join(path.dirname(file), "private-case.json");
 if ((await stat(oldFile)).size > 64_000) throw new HarnessError("improvement.prior-feedback", "prior case snapshot exceeds 64 KB");
 const oldRaw = JSON.parse(await readFile(oldFile, "utf8")) as Record<string, unknown>;
 const oldCase = (oldRaw.case ?? (Array.isArray(oldRaw.cases) ? oldRaw.cases[0] : oldRaw)) as Record<string, unknown>;
 const frozenCase = (value: Record<string, unknown>) => ({ id: value.id, version: value.version, truthHypothesisId: value.truthHypothesisId, hypotheses: value.hypotheses, initialX: value.initialX, allowedProbeX: value.allowedProbeX, maxProbeCalls: value.maxProbeCalls, tolerance: value.tolerance, units: value.units });
 // Compare the private world binding in the controller only. It is never copied to the I view.
 if (JSON.stringify(frozenCase(oldCase)) !== JSON.stringify(frozenCase(currentCase as unknown as Record<string, unknown>))) throw new HarnessError("improvement.prior-feedback", "prior development case differs from frozen current case");
 const journal = path.join(path.dirname(file), "observations.jsonl");
 const journalStoreId = `${path.basename(path.dirname(file))}/observations.jsonl`;
 if ((await stat(journal)).size > 128_000) throw new HarnessError("improvement.prior-feedback", "development observation journal exceeds 128 KB");
 const lines = (await readFile(journal, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
 const feedback: DevelopmentFeedback[] = [];
 for (const partial of raw.developmentFeedback as Array<Record<string, unknown>>) {
  if (!partial || typeof partial.id !== "string" || !["observed", "supported-by-observations", "contradicted", "underdetermined", "invalid", "resource-exhausted", "timed-out", "stopped"].includes(String(partial.status)) || partial.visibility !== "development" || !Array.isArray(partial.evidence) || partial.evidence.length !== 1) throw new HarnessError("improvement.prior-feedback", "invalid development-only observation");
  const ref = partial.evidence[0] as Record<string, unknown>;
  if (typeof ref.id !== "string" || !/^[1-9]\d*$/.test(ref.id) || ref.version !== "1" || ref.storeId !== journalStoreId) throw new HarnessError("improvement.prior-feedback", "invalid observation reference");
  const line = lines[Number(ref.id) - 1];
  if (!line || line.index !== Number(ref.id) || (line.start as Record<string, unknown>)?.caseId !== caseId || (line.start as Record<string, unknown>)?.environmentVersion !== "cpu-response-identification/v1") throw new HarnessError("improvement.prior-feedback", "observation journal does not resolve reference");
  const saved = line.feedback as DevelopmentFeedback;
  if (!saved || saved.id !== partial.id || saved.status !== partial.status || saved.visibility !== "development" || JSON.stringify(saved.observations) !== JSON.stringify(partial.observations) || saved.observations.length > 16) throw new HarnessError("improvement.prior-feedback", "visible feedback differs from observed journal");
  if (typeof saved.startId !== "string" || typeof saved.actionId !== "string" || !Number.isSafeInteger(saved.remainingProbeCalls) || saved.remainingProbeCalls < 0 || !Array.isArray(saved.checks) || saved.checks.length > 16 ||
   !saved.observations.every((o) => typeof o.x === "number" && Number.isFinite(o.x) && typeof o.y === "number" && Number.isFinite(o.y) && typeof o.xUnit === "string" && typeof o.yUnit === "string" && ["initial", "probe"].includes(o.source))) throw new HarnessError("improvement.prior-feedback", "invalid public observation fields");
  // Reconstruct a strict development-only packet; never spread untrusted journal extras.
  feedback.push({ version: 1, id: saved.id, startId: saved.startId, actionId: saved.actionId, status: saved.status, observations: saved.observations.map((o) => ({ x: o.x, y: o.y, xUnit: o.xUnit, yUnit: o.yUnit, source: o.source })),
   remainingProbeCalls: saved.remainingProbeCalls, checks: [], evidence: [ref as unknown as ArtifactRef], visibility: "development" });
 }
 return { feedback, source: { caseId, methodVersionId: raw.methodVersionId, feedbackIds: feedback.map((f) => f.id), claimBoundary: raw.claimBoundary } };
}
function initialFeedback(runId: string, caseId: string, observations: DevelopmentFeedback["observations"], ref: ArtifactRef): DevelopmentFeedback {
 return { version: 1, id: `initial-${caseId}`, startId: `initial-${caseId}`, actionId: "prepare", status: "observed", observations, remainingProbeCalls: 0,
  checks: [], evidence: [ref], visibility: "development" };
}

export class ResearchImprovementService {
 private readonly ws: Workspace;
 readonly store: GenerationStore;
 private readonly runner: SessionRunner;
 private readonly registeredExperienceStores?: ReadonlyMap<string, KnowledgeStore>;
 constructor(options: ResearchServiceOptions) { this.ws = new Workspace(options.workspaceRoot); this.store = new GenerationStore(this.ws.root); this.runner = options.runner; this.registeredExperienceStores = options.registeredExperienceStores; }
 private async verifyRequirements(records: StrategyRecordV1[], snapshot?: string): Promise<void> {
  await verifyRequiredExperience(this.ws.root, combineRequirements(...records.map((r) => r.requiredExperienceRefs)), snapshot, this.registeredExperienceStores);
  await verifyRequiredKnowledge(this.ws.root, combineKnowledgeRefs(...records.map((r) => r.requiredKnowledgeRefs)), snapshot, this.registeredExperienceStores);
 }
 async advanceKnowledgeEpoch(m04RunId: string, expectedActiveBundleId: string) { return this.withMutation(() => advanceKnowledgeEpochInLock({ workspaceRoot: this.ws.root, generationStore: this.store, m04RunId, expectedActiveBundleId, registeredExperienceStores: this.registeredExperienceStores })); }
 async transitionKnowledgeDependencies(m04RunId: string, expectedActiveBundleId: string, methodVersionId: string, decisionRef: KnowledgeRef) {
  return this.withMutation(() => transitionMethodKnowledgeDependenciesInLock({ workspaceRoot: this.ws.root, generationStore: this.store, m04RunId, expectedActiveBundleId, methodVersionId, decisionRef, registeredExperienceStores: this.registeredExperienceStores }));
 }
 private async withMutation<T>(operation: () => Promise<T>): Promise<T> {
  const root = await realpath(this.ws.root).catch(() => this.ws.root);
  if (activeMutations.has(root)) throw new HarnessError("improvement.busy", "method-research mutation already active");
  activeMutations.add(root);
  const lock = path.join(this.ws.agentDir, "improvement", "mutation.lock"), owner = path.join(lock, "owner.json");
  let acquired = false;
  try {
   await mkdir(path.dirname(lock), { recursive: true });
   try { await mkdir(lock); } catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new HarnessError("improvement.locked", `improvement lock exists; inspect ${owner} before exact manual removal`); throw error; }
   acquired = true; await writeFileAtomic(owner, `${JSON.stringify({ version: 1, pid: process.pid, at: nowIso(), operation: "research-improvement" })}\n`);
   return await operation();
  } finally { activeMutations.delete(root); if (acquired && existsSync(owner)) await unlink(owner).catch(() => undefined); if (acquired && existsSync(lock)) await rmdir(lock).catch(() => undefined); }
 }
 async bootstrap(input: ResearchBootstrapInput): Promise<GenerationBundleV1> {
  return this.withMutation(async () => {
   if (!input || input.version !== 1 || !Array.isArray(input.applicability) || input.applicability.length > 16 || input.applicability.some((x) => typeof x !== "string" || !x.trim() || x.length > 240)) throw new HarnessError("improvement.bootstrap", "invalid explicit human seed");
   if (await this.store.active()) throw new HarnessError("improvement.bootstrap", "research generation already active");
   const executor = validateStrategy("executor", input.executor), improver = validateStrategy("improver", input.improver);
   const config = await this.ws.loadConfig();
   const models = { improver: resolveRoleModel(config, "improver"), research: resolveRoleModel(config, "research") };
   const knowledge = createFileKnowledgeStore(this.ws.knowledgeDir); await knowledge.init();
   const knowledgeSnapshot = (await knowledge.current())?.id;
   const h = await this.store.writeStrategy({ versionId: this.store.newId("H-human"), kind: "executor", artifact: executor, origin: "human-seed", applicability: input.applicability, limitations: [], state: "manual-active" });
   const i = await this.store.writeStrategy({ versionId: this.store.newId("I-human"), kind: "improver", artifact: improver, origin: "human-seed", applicability: input.applicability, limitations: [], state: "manual-active" });
   const bundle = await this.store.writeBundle({ bundleId: this.store.newId("bundle"), parents: [], executorVersionId: h.versionId, improverVersionId: i.versionId, knowledgeSnapshot,
    environmentVersion: "cpu-response-identification/v1", modelConfig: models, protocolVersion: "research-protocol/v1", allowedCapabilities: ["cpu-probe", "no-tools-model"], state: "manual-active" });
   await this.store.activate(bundle.bundleId, undefined, "human-seed", `bootstrap-${RUN_ID()}`);
   return bundle;
  });
 }
 async status(): Promise<{ active?: Awaited<ReturnType<GenerationStore["active"]>>; bundles: string[] }> { return { active: await this.store.active(), bundles: await this.store.listBundles() }; }
 async rollback() { return this.withMutation(async () => {
  const active = await this.store.active(); if (!active?.pointer.previousBundleId) throw new HarnessError("improvement.rollback", "no previous research generation");
  const previous = await this.store.readBundle(active.pointer.previousBundleId);
  const [h, i] = await Promise.all([this.store.readStrategy(previous.executorVersionId), this.store.readStrategy(previous.improverVersionId)]);
  await this.verifyRequirements([h, i], previous.knowledgeSnapshot);
  return this.store.rollback();
 }); }
 async exportMethod(versionId: string, outputPath: string) {
  const active = await this.store.active();
  const scope = active?.bundle.executorVersionId === versionId && active.pointer.provenance === "local-executor-admission" ? "local-executor-quality" : active?.bundle.improverVersionId === versionId && active.pointer.provenance === "local-meta-admission" ? "local-meta-improvement" : "research-only";
  return exportMethodPackageV2(this.store, versionId, scope, outputPath);
 }
 async bindMethod(packagePath: string) { return this.withMutation(async () => { const active = await this.store.active(); if (!active) throw new HarnessError("improvement.generation", "bootstrap research generation first");
  const pkg = await readMethodPackageV2(packagePath);
  await verifyRequiredExperience(this.ws.root, pkg.requiredExperienceRefs, active.bundle.knowledgeSnapshot, this.registeredExperienceStores);
  await verifyRequiredKnowledge(this.ws.root, pkg.requiredKnowledgeRefs, active.bundle.knowledgeSnapshot, this.registeredExperienceStores);
  return bindMethodPackageV2(this.store, packagePath, active, `manual-bind-${RUN_ID()}`); }); }
 async run(input: unknown): Promise<ResearchRunV1> { const plan = validateResearchPlan(input); return this.withMutation(() => this.runUnlocked(plan)); }

 private async runUnlocked(plan: ResearchCampaignPlanV1): Promise<ResearchRunV1> {
  const active = await this.store.active(); if (!active) throw new HarnessError("improvement.generation", "bootstrap a human-seeded research generation first");
  const id = RUN_ID(), dir = path.join(this.store.root, "runs", id), observationsDir = path.join(dir, "observations");
  await mkdir(observationsDir, { recursive: true });
  const statePath = path.join(dir, "run.json"), planPath = path.join(dir, "plan.json");
  const run: ResearchRunV1 = { version: 1, runId: id, startedAt: nowIso(), planPath, baselineBundleId: active.bundle.bundleId, baselinePointer: active.pointer, frozenBundle: active.bundle,
   developmentCaseSetPath: path.join(dir, "development-cases.private.json"), ...(plan.admissionCaseSetPath ? { admissionCaseSetPath: path.join(dir, "admission-cases.private.json") } : {}),
   status: "running", candidates: [], decisions: [], feedback: [] };
  const save = async () => { run.budgetAtEnd = budget.status(); await writeFileAtomic(statePath, `${JSON.stringify(run, null, 2)}\n`); };
  const budget = new SharedBudget(id, plan.budget);
  await writeFileAtomic(planPath, `${JSON.stringify({ ...plan, developmentCaseSetPath: "[frozen private copy]", priorDevelopmentFeedbackPath: plan.priorDevelopmentFeedbackPath ? "[checked prior public development handoff]" : undefined, admissionCaseSetPath: plan.admissionCaseSetPath ? "[frozen private copy]" : undefined }, null, 2)}\n`);
  await save();
  try {
   const development = await loadCaseSet(path.resolve(this.ws.root, plan.developmentCaseSetPath), "development");
   const prior = plan.priorDevelopmentFeedbackPath ? await loadPriorDevelopmentFeedback(path.resolve(this.ws.root, plan.priorDevelopmentFeedbackPath), development.cases[0]!) : undefined;
   if (prior) run.priorDevelopmentSource = prior.source;
   const admission = plan.admissionCaseSetPath ? await loadCaseSet(path.resolve(this.ws.root, plan.admissionCaseSetPath), "admission") : undefined;
   if (admission && admission.cases.some((c) => development.cases.some((d) => d.id === c.id || JSON.stringify({ ...d, id: "" }) === JSON.stringify({ ...c, id: "" })))) throw new HarnessError("improvement.research-cases", "development and admission cases overlap");
   await writeFileAtomic(run.developmentCaseSetPath, `${JSON.stringify(development, null, 2)}\n`);
   if (admission && run.admissionCaseSetPath) await writeFileAtomic(run.admissionCaseSetPath, `${JSON.stringify(admission, null, 2)}\n`);
   const config = await this.ws.loadConfig();
   if (resolveRoleModel(config, "improver") !== active.bundle.modelConfig.improver || resolveRoleModel(config, "research") !== active.bundle.modelConfig.research) throw new HarnessError("improvement.generation", "model config changed since bundle freeze; explicit new binding is required");
   const knowledge = createFileKnowledgeStore(this.ws.knowledgeDir); await knowledge.init();
   const experience = await createExperienceProvider(knowledge, this.registeredExperienceStores).select({ targetKind: plan.target, applicability: { stage: "method-research", tags: ["cpu-response-identification"] }, requestedRefs: plan.experienceRefs,
    expectedSnapshotId: active.bundle.knowledgeSnapshot, maxRecords: plan.experienceMaxRecords || 1, maxChars: plan.experienceMaxChars || 1 });
   if (experience.status === "incomplete") { run.status = "inconclusive"; run.outcome = "setup-blocked"; run.stopReason = "requested method experience was unavailable or incomplete"; return run; }
   const selection = { markdown: experience.status === "ready" ? experience.markdown : "", refs: experience.selected.map((item) => item.ref), targetKind: plan.target, scientificRequiredRefs: experience.selected.flatMap((item) => item.scientificRequiredRefs) };
   const loadedMetaEpisodes = await Promise.all((plan.metaEpisodeRunIds ?? []).map((priorRunId) => loadMetaEpisode(this.store.root, this.ws.root, priorRunId)));
   const h = await this.store.readStrategy(active.bundle.executorVersionId), i = await this.store.readStrategy(active.bundle.improverVersionId);
   if (!isCpuExecutorStrategy(h.artifact)) throw new HarnessError("improvement.strategy", "CPU research requires an active CPU executor method; the workflow slot is M07-only");
   await this.verifyRequirements([h, i], active.bundle.knowledgeSnapshot);
   const phases = admission ? await reserveResearchPhases(budget, { kind: plan.experimentKind, outer: plan.outerBudget!, pilot: plan.pilotBudget!, protected: plan.protectedBudget!, branch: plan.metaBranchBudget,
    searchReplicates: plan.searchReplicates!, outcomeReplicates: plan.outcomeReplicates!, admissionCases: admission.cases }) : undefined;
   const pilotLease = phases?.pilot ?? (plan.target === "improver" && plan.pilotBudget ? budget.createLease(budget.root, plan.pilotBudget, { clockMode: "active" }) : undefined);
   const selected = await this.search({ run, dir, plan, development, bundle: active.bundle, target: plan.target, improver: i, executor: h, budget, lease: phases?.outer ?? budget.root,
    pilotLease, depth: 0, selection, metaEpisodes: loadedMetaEpisodes, save, prefix: "outer", priorFeedback: prior?.feedback ?? [] });
   if (selected.selected) run.selectedCandidateId = selected.selected.id;
   run.developmentTarget = plan.target; run.developmentTerminal = selected.status; run.developmentBudgetAtSelection = budget.status();
   await save();
   const episode = buildMetaEpisode(run, this.ws.root, plan.target, selected.status);
   const episodeText = `${JSON.stringify(episode, null, 2)}\n`;
   if (Buffer.byteLength(episodeText, "utf8") > 120_000) throw new HarnessError("improvement.meta-episode", "development episode exceeds fixed readback size");
   await writeFileAtomic(metaEpisodePath(this.store.root, id), episodeText);
   run.metaEpisodeIds = [episode.id];
   if (!selected.selected) { run.status = selected.status === "inconclusive" ? "inconclusive" : "research-only"; run.outcome = selected.status === "no-winner" ? "completed-no-candidate" : "search-incomplete"; run.stopReason = selected.stopReason ?? (selected.status === "no-winner" ? "improver explicitly stopped without selecting a development candidate" : "development search ended inconclusively"); return run; }
   await writeFileAtomic(path.join(dir, "selected-before-g.json"), `${JSON.stringify({ selectedCandidateId: selected.selected.id, selectedAt: selected.selectedAt, source: "development", target: plan.target }, null, 2)}\n`);
   if (!admission) { run.status = "research-only"; run.stopReason = "no caller-frozen admission case set; candidate remains research-only"; return run; }
   if (budget.status().settlement !== "settled") { run.status = "inconclusive"; run.outcome = "search-incomplete"; run.stopReason = "unknown shared budget before protected admission"; return run; }
   if (plan.experimentKind === "executor-quality") {
    const candidate = await this.store.readStrategy(selected.selected.strategyVersionId);
    const result = await runExecutorQualityAdmission({ caseSet: admission, baseline: { versionId: h.versionId, artifact: h.artifact as ExecutorStrategyV1 }, candidate: { versionId: candidate.versionId, artifact: candidate.artifact as ExecutorStrategyV1 }, runner: this.runner,
     model: active.bundle.modelConfig.research, persistDir: this.ws.sessionsDir, budget, lease: phases!.protected, timeoutMs: plan.perPromptTimeoutMs, repetitions: plan.outcomeReplicates!,
     persistObservation: this.persistObservation(dir, id), beforeModelRequest: async (versionId) => {
      const record = versionId === h.versionId ? h : candidate;
      await this.verifyRequirements([record, i], active.bundle.knowledgeSnapshot);
     } });
    run.admissionPath = path.join(dir, "executor-quality-admission.private.json"); await writeFileAtomic(run.admissionPath, `${JSON.stringify(result, null, 2)}\n`);
    if (result.status === "accepted" && budget.status().settlement === "settled") {
     await this.verifyRequirements([candidate, i], active.bundle.knowledgeSnapshot);
     const bundle = await this.store.writeBundle({ bundleId: this.store.newId("bundle"), parents: [active.bundle.bundleId], executorVersionId: candidate.versionId, improverVersionId: i.versionId, knowledgeSnapshot: active.bundle.knowledgeSnapshot,
      environmentVersion: active.bundle.environmentVersion, modelConfig: active.bundle.modelConfig, protocolVersion: active.bundle.protocolVersion, allowedCapabilities: active.bundle.allowedCapabilities, state: "admitted" });
     await this.store.activate(bundle.bundleId, active.pointer, "local-executor-admission", id); run.status = "promoted"; run.outcome = "promoted"; run.stopReason = "local executor-quality admission accepted";
    } else { run.status = result.status === "rejected" ? "rejected" : "inconclusive"; run.outcome = result.status === "rejected" ? "candidate-rejected" : "search-incomplete"; run.stopReason = result.reason; }
   } else {
    const meta = await runMetaImprovementAdmission({ oldImproverVersionId: i.versionId, newImproverVersionId: selected.selected.strategyVersionId, initialExecutor: { versionId: h.versionId, artifact: h.artifact }, knowledgeSnapshot: active.bundle.knowledgeSnapshot,
     branchLeases: phases!.branches, protectedLease: phases!.protected, protocol: plan.metaProtocol!, searchReplicates: plan.searchReplicates!, outcomeReplicates: plan.outcomeReplicates!,
     developmentCaseSet: development, admissionCaseSet: admission, budget, runner: this.runner, researchModel: active.bundle.modelConfig.research,
     persistDir: this.ws.sessionsDir, timeoutMs: plan.perPromptTimeoutMs,
     produceSuccessor: async (improverVersionId, lease, cases, replicateIndex, arm): Promise<ProducedSuccessorV1> => {
      const improver = await this.store.readStrategy(improverVersionId);
      const branch = await this.search({ run, dir, plan, development: cases, bundle: active.bundle, target: "executor", improver, executor: h, budget, lease,
       selection, metaEpisodes: loadedMetaEpisodes, save, prefix: `meta-${replicateIndex}-${arm}`, priorFeedback: [], depth: 1 });
      const record = branch.selected ? await this.store.readStrategy(branch.selected.strategyVersionId) : undefined;
      return { improverVersionId, startingExecutorVersionId: h.versionId, startingKnowledgeSnapshot: active.bundle.knowledgeSnapshot, selectedExecutor: record ? { versionId: record.versionId, artifact: record.artifact as ExecutorStrategyV1 } : undefined,
       selectedAt: branch.selectedAt, decisionCount: branch.decisionCount, status: branch.status };
     },
     persistSelection: async (replicates) => { const file = path.join(dir, "meta-selections-before-g.private.json"); await writeFileAtomic(file, `${JSON.stringify({ replicates, at: nowIso() }, null, 2)}\n`); return file; },
     persistObservation: this.persistObservation(dir, id), beforeModelRequest: async (versionId) => {
      const record = await this.store.readStrategy(versionId);
      await this.verifyRequirements([record], active.bundle.knowledgeSnapshot);
     } });
    run.admissionPath = path.join(dir, "meta-admission.private.json"); await writeFileAtomic(run.admissionPath, `${JSON.stringify(meta, null, 2)}\n`);
    if (meta.status === "accepted" && budget.status().settlement === "settled") {
     const candidate = await this.store.readStrategy(selected.selected.strategyVersionId);
     await this.verifyRequirements([h, candidate], active.bundle.knowledgeSnapshot);
     if (candidate.artifact.body === i.artifact.body) { run.status = "rejected"; run.outcome = "candidate-rejected"; run.stopReason = "sham improver body did not change"; }
     else { const bundle = await this.store.writeBundle({ bundleId: this.store.newId("bundle"), parents: [active.bundle.bundleId], executorVersionId: h.versionId, improverVersionId: candidate.versionId, knowledgeSnapshot: active.bundle.knowledgeSnapshot,
       environmentVersion: active.bundle.environmentVersion, modelConfig: active.bundle.modelConfig, protocolVersion: active.bundle.protocolVersion, allowedCapabilities: active.bundle.allowedCapabilities, state: "admitted" });
      await this.store.activate(bundle.bundleId, active.pointer, "local-meta-admission", id); run.status = "promoted"; run.outcome = "promoted"; run.stopReason = "local meta successor protocol accepted"; }
    } else { run.status = meta.status === "rejected" ? "rejected" : "inconclusive"; run.outcome = meta.status === "rejected" ? "candidate-rejected" : "search-incomplete"; run.stopReason = meta.reason; }
   }
   return run;
  } catch (error) {
   run.status = error instanceof HarnessError && ["improvement.budget", "improvement.usage", "improvement.timeout", "improvement.experience"].includes(error.code) ? "inconclusive" : "failed";
   run.stopReason = (error as Error).message; return run;
  } finally { run.finishedAt = nowIso(); await save(); }
 }

 private persistObservation(dir: string, runId: string) {
  return async (record: { start: { id: string }; action: ScientificAction; feedback: DevelopmentFeedback }): Promise<ArtifactRef> => {
   const id = `observation-${randomUUID()}`, file = path.join(dir, "observations", `${id}.json`);
   await writeFileAtomic(file, `${JSON.stringify(record, null, 2)}\n`);
   return { storeId: `method-research:${runId}`, id, version: "1" };
  };
 }

 private async search(args: { run: ResearchRunV1; dir: string; plan: ResearchCampaignPlanV1; development: CpuCaseSetV1; bundle: GenerationBundleV1; target: "executor" | "improver";
  improver: StrategyRecordV1; executor: StrategyRecordV1; budget: SharedBudget; lease: BudgetLease; pilotLease?: BudgetLease; depth?: number; selection: ResearchDecisionViewV1["experience"]; metaEpisodes?: MetaEpisodeV1[]; save: () => Promise<void>; prefix: string; priorFeedback: DevelopmentFeedback[] }): Promise<SearchResult> {
  const { run, dir, plan, development, budget, lease } = args;
  type CaseRuntime = { caseId: string; development: DevelopmentEnvironment; start: ExperimentStart; task: PublicTask; feedback: DevelopmentFeedback[]; episodes: Array<{ candidateId: string; episode: import("./executor-eval.ts").ExecutorEpisodeResult; sdkEstimatedCost: number }>; modelCalls: number; probeCalls: number; sdkEstimatedCost: number };
  const cases = new Map<string, CaseRuntime>();
  const visible: Array<DevelopmentFeedback & { caseId: string }> = [];
  for (const c of development.cases) {
   const env = createCpuResponseEnvironment(c, budget, { persistObservation: this.persistObservation(dir, run.runId) });
   if (!(await env.development.healthCheck()).usable) return { decisionCount: 0, status: "inconclusive" };
   const start = await env.development.prepare(`${run.runId}:${args.prefix}:${c.id}`), task = env.development.publicTask(start);
   const initialId = `${args.prefix}-initial-${c.id}`;
   const initialRef: ArtifactRef = { storeId: `method-research:${run.runId}`, id: initialId, version: "1" };
   await writeFileAtomic(path.join(dir, "observations", `${initialId}.json`), `${JSON.stringify({ start, task, observations: task.initialObservations }, null, 2)}\n`);
   const initial = initialFeedback(run.runId, c.id, task.initialObservations, initialRef); initial.id = initialId; initial.remainingProbeCalls = task.maxProbeCalls;
   cases.set(c.id, { caseId: c.id, development: env.development, start, task, feedback: [initial], episodes: [], modelCalls: 0, probeCalls: 0, sdkEstimatedCost: 0 });
   visible.push({ ...initial, caseId: c.id }); run.feedback.push({ ...initial, caseId: c.id });
  }
  const first = development.cases[0]!, task = cases.get(first.id)!.task;
  const feedbackIds = new Set(visible.map((f) => f.id));
  for (const prior of args.priorFeedback) {
   if (feedbackIds.has(prior.id)) throw new HarnessError("improvement.prior-feedback", "prior feedback identity collides with current or prior observation");
   feedbackIds.add(prior.id); cases.get(first.id)!.feedback.push(prior); visible.push({ ...prior, caseId: first.id }); run.feedback.push({ ...prior, caseId: first.id });
  }
  await args.save();
  const localCandidates: ResearchCandidateV1[] = [];
  const methodRecords = new Map<string, StrategyRecordV1>([[args.executor.versionId, args.executor], [args.improver.versionId, args.improver]]);
  for (const episode of args.metaEpisodes ?? []) {
   const ids = [episode.current.executorVersionId, episode.current.improverVersionId, ...episode.candidates.map((c) => c.strategyVersionId)];
   for (const versionId of ids) if (!methodRecords.has(versionId)) methodRecords.set(versionId, await this.store.readStrategy(versionId));
  }
  const inspectionResults: ResearchInspectionResultV1[] = [];
  let readbackChars = 0, inspectActions = 0;
  let lastActionResult: ResearchDecisionViewV1["lastActionResult"];
  const methodView = (record: StrategyRecordV1, inline: boolean) => ({ versionId: record.versionId, kind: record.kind, utf16Length: record.artifact.body.length, ...(inline ? { body: record.artifact.body } : {}) });
  const caseViews = (): ResearchCaseViewV1[] => [...cases.values()].map((item) => ({ caseId: item.caseId, allowedProbeX: item.task.allowedProbeX, units: item.task.units,
   initialObservations: item.task.initialObservations, feedbackCount: item.feedback.length, latestFeedbackId: item.feedback.at(-1)?.id, latestStatus: item.feedback.at(-1)?.status,
   episodeCount: item.episodes.length, latestEpisodeStatus: item.episodes.at(-1)?.episode.status, latestEpisodeFailure: item.episodes.at(-1)?.episode.failure ? "episode-incomplete" : undefined,
   modelCalls: item.modelCalls, probeCalls: item.probeCalls, sdkEstimatedCost: item.sdkEstimatedCost }));
  const seenBodies = new Set<string>([args.target === "executor" ? args.executor.artifact.body : args.improver.artifact.body]);
  const ensureLiveExperience = async () => {
   await this.verifyRequirements([args.executor, args.improver], args.bundle.knowledgeSnapshot);
   if (!args.selection.refs.length) return;
   const knowledge = createFileKnowledgeStore(this.ws.knowledgeDir); await knowledge.init();
   const selected = await createExperienceProvider(knowledge, this.registeredExperienceStores).select({ targetKind: args.selection.targetKind ?? args.target, applicability: { stage: "method-research", tags: ["cpu-response-identification"] },
    requestedRefs: args.selection.refs, expectedSnapshotId: args.bundle.knowledgeSnapshot, maxRecords: plan.experienceMaxRecords, maxChars: plan.experienceMaxChars });
   if (selected.status !== "ready" || JSON.stringify(selected.selected.map((item) => item.ref)) !== JSON.stringify(args.selection.refs) || selected.markdown !== args.selection.markdown)
    throw new HarnessError("improvement.experience", "selected method experience changed or became unavailable before a new model request");
  };
  const inspect = (action: Extract<import("./policy-host.ts").ResearchActionV1, { kind: "inspect" }>, sessionId: string): ResearchInspectionResultV1 => {
   if (++inspectActions > (plan.maxInspectActions ?? 4)) throw new HarnessError("improvement.inspect", "inspect action budget exhausted");
   let request: ResearchInspectionRequestV1;
   let content: string;
   let observedFeedbackId: string | undefined;
   if ("read" in action && action.read) {
    request = action.read;
    const selectedCase = request.caseId ? cases.get(request.caseId) : undefined;
    if (request.object === "meta-episode") { const selected = args.metaEpisodes?.find((episode) => episode.id === request.id); content = selected ? JSON.stringify(metaEpisodeForModel(selected)) : ""; }
    else if (request.object === "method") content = methodRecords.get(request.id!)?.artifact.body ?? "";
    else if (request.object === "compare-methods") content = JSON.stringify({ left: methodRecords.get(request.id!)?.artifact.body, right: methodRecords.get(request.compareToId!)?.artifact.body });
    else if (request.object === "case-task") content = JSON.stringify(selectedCase?.task);
    else if (request.object === "development-feedback") { observedFeedbackId = selectedCase?.feedback[request.index!]?.id; content = JSON.stringify(selectedCase?.feedback[request.index!]); }
    else { const record = selectedCase?.episodes[request.index!]; content = record ? JSON.stringify({ caseId: selectedCase!.caseId, candidateId: record.candidateId,
     methodVersionId: record.episode.methodVersionId, status: record.episode.status, selectedHypothesisId: record.episode.selectedHypothesisId,
     modelCalls: record.episode.modelCalls, usedProbeXs: record.episode.usedProbeXs, feedbackIds: record.episode.feedback.map((f) => f.id),
     feedbackStatuses: record.episode.feedback.map((f) => f.status), sdkEstimatedCost: record.sdkEstimatedCost, costSource: "sdk-estimate",
     failureCategory: record.episode.failure ? "episode-incomplete" : undefined }) : ""; }
   } else {
    request = { object: "development-feedback", start: 0, maxChars: 4_000 };
    content = JSON.stringify(action.evidenceIds.map((id) => [...cases.values()].flatMap((c) => c.feedback.map((f) => ({ caseId: c.caseId, feedback: f }))).find((item) => item.feedback.id === id)));
    if (action.evidenceIds.length === 1) observedFeedbackId = action.evidenceIds[0];
   }
   if (!content || content === "undefined") throw new HarnessError("improvement.inspect", "registered development object is unavailable");
   const remaining = (plan.maxReadbackChars ?? 8_000) - readbackChars;
   if (remaining < 1) throw new HarnessError("improvement.inspect", "readback character budget exhausted");
   const start = request.start, end = Math.min(content.length, start + Math.min(request.maxChars, remaining));
   if (start >= content.length) throw new HarnessError("improvement.inspect", "inspect start is past registered object");
   const result: ResearchInspectionResultV1 = { requestId: `${args.prefix}-inspect-${inspectActions}`, object: request.object, ...(observedFeedbackId ? { id: observedFeedbackId } : request.id ? { id: request.id } : {}), ...(request.caseId ? { caseId: request.caseId } : {}),
    start, end, totalChars: content.length, text: content.slice(start, end), requestedBySessionId: sessionId, methodBindingVersionId: args.improver.versionId, branchPrefix: args.prefix };
   readbackChars += result.text.length;
   return result;
  };
  for (let index = 0; index < plan.maxDecisions; index++) {
   if (budget.status(lease).settlement !== "settled" || budget.status(lease).remaining.providerCalls <= 0) return { decisionCount: index, status: "inconclusive", stopReason: "development provider budget became unavailable before a terminal decision" };
   const candidateCap = args.prefix.startsWith("meta-") ? plan.maxCandidatesPerMetaArm ?? 0 : plan.maxCandidates;
   const view: ResearchDecisionViewV1 = { version: 1, target: args.target, current: { bundleId: args.bundle.bundleId, executorVersionId: args.executor.versionId, improverVersionId: args.improver.versionId }, task,
    methods: { executor: methodView(args.executor, true), improver: methodView(args.improver, true), candidates: [...methodRecords.values()].filter((record) => record.versionId !== args.executor.versionId && record.versionId !== args.improver.versionId).map((record) => methodView(record, false)) },
    cases: caseViews(), inspections: inspectionResults.slice(-3), inspectionWindow: { total: inspectionResults.length, visible: Math.min(3, inspectionResults.length), omitted: Math.max(0, inspectionResults.length - 3) }, readableEvidenceIds: fullyReadDevelopmentFeedbackIds(inspectionResults), metaEpisodes: args.metaEpisodes?.map((episode) => ({ id: episode.id, runId: episode.runId, target: episode.target, terminal: episode.terminal,
     decisionKinds: episode.decisions.map((d) => d.kind ?? "none"), candidateOutcomes: episode.candidates.map((c) => ({ id: c.id, claim: c.hypothesis.claim,
      predictedObservation: c.hypothesis.predictedObservation, falsifier: c.hypothesis.falsifier, developmentStatus: c.developmentStatus })),
     feedbackIds: episode.feedbackIndex.map((f) => f.id), sdkEstimatedCost: episode.usage.sdkEstimatedCost })),
    feedback: visible.slice(-plan.maxFeedbackItems), feedbackWindow: { total: visible.length, visible: Math.min(plan.maxFeedbackItems, visible.length), omitted: Math.max(0, visible.length - plan.maxFeedbackItems) }, historicalFeedbackIds: args.priorFeedback.map((f) => f.id), experience: args.selection, candidates: localCandidates.map((c) => ({ id: c.id, target: c.kind, hypothesis: c.hypothesis, developmentStatus: c.developmentStatus })), budget: budget.status(lease),
    remainingActions: { decisions: plan.maxDecisions - index, candidates: Math.max(0, candidateCap - localCandidates.length), inspections: Math.max(0, (plan.maxInspectActions ?? 4) - inspectActions), readbackChars: Math.max(0, (plan.maxReadbackChars ?? 8_000) - readbackChars), finalDecision: index === plan.maxDecisions - 1 },
    ...(lastActionResult ? { lastActionResult } : {}) };
   const record: ResearchDecisionRecordV1 = { index: run.decisions.length + 1, at: nowIso(), processId: process.pid, improverVersionId: args.improver.versionId, branchPrefix: args.prefix, outcome: "proposing",
    visibleFeedbackIds: view.feedback.map((f) => f.id), experienceRefs: view.experience.refs };
   run.decisions.push(record); await args.save();
   let action: ReturnType<typeof validateResearchAction> | undefined;
   let formatError = "";
   for (let repair = 0; repair <= (plan.schemaRepairAttempts ?? 0); repair++) {
    try {
     await ensureLiveExperience();
     const response = await runBoundedModelStep({ runner: this.runner, budget, lease, spec: { label: `I-${run.runId}-${args.prefix}-${index}${repair ? `-repair-${repair}` : ""}`, role: "improver", model: args.bundle.modelConfig.improver,
      systemPrompt: improverSystemPrompt(args.improver.artifact as ImproverStrategyV1), persistDir: this.ws.sessionsDir, methodBinding: { versionId: args.improver.versionId } },
      message: repair === 0 ? decisionPrompt(view) : `${decisionPrompt(view)}\nYour previous response failed this controller schema check: ${formatError.slice(0, 240)}. Return one valid JSON action with the same permissions.`,
      timeoutMs: plan.perPromptTimeoutMs });
     (record.repairSessionIds ??= []).push(response.sessionId); record.sessionId = response.sessionId; record.specFile = response.specFile; record.usageSidecar = response.usageSidecar; record.repairAttempts = repair;
     try { action = validateResearchAction(JSON.parse(response.text), view); break; }
     catch (error) { formatError = (error as Error).message; }
    } catch (error) { record.outcome = "inconclusive"; record.reason = (error as Error).message; await args.save(); return { decisionCount: index + 1, status: "inconclusive" }; }
   }
   if (!action) { record.outcome = "rejected"; record.reason = `schema repair exhausted: ${formatError.slice(0, 240)}`; await args.save(); return { decisionCount: index + 1, status: "inconclusive" }; }
   const decision = record; decision.action = action; decision.outcome = "executed"; await args.save();
   if (action.kind === "inspect") {
    try { const result = inspect(action, record.sessionId!); inspectionResults.push(result); (run.inspections ??= []).push(result); decision.inspectionId = result.requestId; lastActionResult = { kind: "inspect", outcome: "executed", inspectionId: result.requestId }; await args.save(); }
    catch (error) { decision.outcome = "rejected"; decision.reason = (error as Error).message; lastActionResult = { kind: "inspect", outcome: "rejected", reason: decision.reason }; await args.save(); continue; }
    continue;
   }
   if (action.kind === "probe") {
    const selectedCase = cases.get(action.caseId ?? first.id)!;
    const feedback = await selectedCase.development.runProbe(selectedCase.start, { kind: "probe", actionId: randomUUID(), x: action.x }, lease);
    selectedCase.feedback.push(feedback); selectedCase.probeCalls++; visible.push({ ...feedback, caseId: selectedCase.caseId }); run.feedback.push({ ...feedback, caseId: selectedCase.caseId }); decision.feedbackId = feedback.id; await args.save();
    lastActionResult = { kind: "probe", outcome: "executed", feedbackId: feedback.id, reason: feedback.status };
    if (feedback.status !== "observed") return { decisionCount: index + 1, status: "inconclusive" };
    continue;
   }
   if (action.kind === "propose") {
    const localCap = candidateCap;
    if (localCandidates.length >= localCap || seenBodies.has(action.body)) { decision.outcome = "rejected"; decision.reason = "local candidate budget exhausted or unchanged/repeated body"; lastActionResult = { kind: "propose", outcome: "rejected", reason: decision.reason }; await args.save(); continue; }
    seenBodies.add(action.body);
    const artifact = validateStrategy(args.target, { version: 1, kind: args.target === "executor" ? "cpu-numerical-prompt" : "diagnostic-improver-prompt", body: action.body });
    const parentVersionId = args.target === "executor" ? args.executor.versionId : args.improver.versionId;
    const sourceExperienceRefs: ExperienceRequirementV1[] = args.selection.refs.map((ref) => ({ targetKind: args.selection.targetKind ?? args.target, ref }));
    const requiredExperienceRefs = combineRequirements(args.executor.requiredExperienceRefs, args.improver.requiredExperienceRefs);
    const strategy = await this.store.writeStrategy({ versionId: this.store.newId(args.target === "executor" ? "H-agent" : "I-agent"), kind: args.target, artifact, parentVersionId,
     origin: "agent-generated", applicability: action.hypothesis.applicability, limitations: [], sourceExperienceRefs, requiredExperienceRefs,
     requiredKnowledgeRefs: combineKnowledgeRefs(args.executor.requiredKnowledgeRefs, args.improver.requiredKnowledgeRefs, args.selection.scientificRequiredRefs ?? []), state: "research-only" });
    const candidate: ResearchCandidateV1 = { id: strategy.versionId, kind: args.target, strategyVersionId: strategy.versionId, producedByImproverVersionId: args.improver.versionId, branchPrefix: args.prefix,
     hypothesis: action.hypothesis, origin: "agent-generated", developmentStatus: "untested", developmentEvidence: action.hypothesis.motivatingEvidenceIds };
    localCandidates.push(candidate); run.candidates.push(candidate); methodRecords.set(strategy.versionId, strategy); lastActionResult = { kind: "propose", outcome: "executed", candidateId: candidate.id, developmentStatus: candidate.developmentStatus }; await args.save(); continue;
   }
   if (action.kind === "evaluate-development") {
    const candidate = localCandidates.find((c) => c.id === action.candidateId)!;
    if (candidate.developmentStatus !== "untested") { decision.outcome = "rejected"; decision.reason = "candidate already development-tested"; lastActionResult = { kind: "evaluate-development", outcome: "rejected", reason: decision.reason, candidateId: candidate.id, developmentStatus: candidate.developmentStatus }; await args.save(); continue; }
    const strategy = await this.store.readStrategy(candidate.strategyVersionId);
    if (candidate.kind === "executor") {
     let valid = 0, contradicted = 0, incomplete = 0;
     for (const c of development.cases) {
      const e = createCpuResponseEnvironment(c, budget, { persistObservation: this.persistObservation(dir, run.runId) });
      if (!(await e.development.healthCheck()).usable) { incomplete++; continue; }
      const s = await e.development.prepare(`${run.runId}:dev:${c.id}`);
      const costBefore = budget.status(lease).committed.sdkEstimatedCost;
      const episode = await runExecutorEpisode({ development: e.development, start: s, method: strategy.artifact as ExecutorStrategyV1, methodVersionId: strategy.versionId,
       runner: this.runner, model: args.bundle.modelConfig.research, persistDir: this.ws.sessionsDir, budget, lease, timeoutMs: plan.perPromptTimeoutMs,
       beforeModelRequest: () => this.verifyRequirements([strategy], args.bundle.knowledgeSnapshot) });
      const selectedCase = cases.get(c.id)!;
      const episodeCost = budget.status(lease).committed.sdkEstimatedCost - costBefore;
      selectedCase.episodes.push({ candidateId: candidate.id, episode, sdkEstimatedCost: episodeCost }); selectedCase.modelCalls += episode.modelCalls; selectedCase.probeCalls += episode.usedProbeXs.length;
      selectedCase.sdkEstimatedCost += episodeCost;
      let scientificStatus: import("./research-types.ts").ResearchDevelopmentEpisodeV1["scientificStatus"] = "incomplete";
      if (episode.status === "submitted") scientificStatus = episode.feedback.at(-1)?.status === "supported-by-observations" ? "supported" : episode.feedback.at(-1)?.status === "contradicted" ? "contradicted" : "incomplete";
      else if (episode.status === "stopped") {
       const stop = await e.protectedEvaluator.evaluateStop(s, lease);
       scientificStatus = stop.status === "justified-unknown" ? "justified-unknown" : stop.status === "premature-stop" ? "premature-stop" : "incomplete";
      }
      (run.developmentEpisodes ??= []).push({ caseId: c.id, candidateId: candidate.id, episode, sdkEstimatedCost: episodeCost, modelCalls: episode.modelCalls, scientificStatus });
      for (const f of episode.feedback) { selectedCase.feedback.push(f); visible.push({ ...f, caseId: c.id }); run.feedback.push({ ...f, caseId: c.id }); candidate.developmentEvidence.push(f.id); }
      if (scientificStatus === "supported" || scientificStatus === "justified-unknown") valid++;
      else if (scientificStatus === "contradicted" || scientificStatus === "premature-stop") contradicted++;
      else incomplete++;
     }
     candidate.developmentStatus = incomplete > 0 ? "inconclusive" : contradicted > 0 ? "rejected" : valid === development.cases.length ? "supported" : "inconclusive";
    } else {
     candidate.developmentStatus = "schema-valid"; await args.save();
     if ((args.depth ?? 0) >= 1 || !args.pilotLease) { candidate.developmentStatus = "inconclusive"; decision.reason = "candidate I requires an explicit independent pilot lease"; }
     else {
      let pilot: SearchResult;
      try { pilot = await this.search({ ...args, target: "executor", improver: strategy, executor: args.executor, lease: args.pilotLease, pilotLease: undefined,
        depth: 1, prefix: `${args.prefix}-pilot-${candidate.id}`, selection: args.selection, priorFeedback: [] }); }
      finally { budget.pauseLease(args.pilotLease); }
      candidate.developmentStatus = pilot.status === "selected" && pilot.selected ? "development-supported" : pilot.status === "no-winner" ? "pilot-complete" : "inconclusive";
      candidate.developmentEvidence.push(...(pilot.selected?.developmentEvidence ?? []));
     }
    }
    lastActionResult = { kind: "evaluate-development", outcome: "executed", candidateId: candidate.id, developmentStatus: candidate.developmentStatus, ...(decision.reason ? { reason: decision.reason } : {}) };
    await args.save(); continue;
   }
   if (action.kind === "stop") {
    if (!action.selectedCandidateId) return { decisionCount: index + 1, status: "no-winner", stopReason: `improver explicitly stopped without a development-selected candidate: ${action.reason}` };
    const candidate = localCandidates.find((c) => c.id === action.selectedCandidateId);
    if (!candidate || !["supported", "development-supported"].includes(candidate.developmentStatus)) { decision.outcome = "rejected"; decision.reason = "selected candidate lacks development support"; await args.save(); return { decisionCount: index + 1, status: "inconclusive" }; }
    const selectedAt = nowIso();
    await writeFileAtomic(path.join(dir, `${args.prefix}-selection-before-g.json`), `${JSON.stringify({ candidateId: candidate.id, selectedAt, improverVersionId: args.improver.versionId, target: args.target }, null, 2)}\n`);
    return { selected: candidate, selectedAt, decisionCount: index + 1, status: "selected" };
   }
  }
  return { decisionCount: plan.maxDecisions, status: "inconclusive", stopReason: "development decision budget exhausted before an explicit terminal stop" };
 }
}
