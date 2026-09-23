/** Explicit, bounded method-research campaign. Existing mechanism-cost improvement remains separate. */
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, realpath, rmdir, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { resolveRoleModel } from "../config.ts";
import { SharedBudget } from "../experiments/budget.ts";
import type { ArtifactRef, BudgetLease, DevelopmentFeedback, ExecutorStrategyV1, ScientificAction } from "../experiments/contracts.ts";
import { createCpuResponseEnvironment, validateCpuCaseSet, type CpuCaseSetV1, type CpuResponseCase } from "../experiments/local-environment.ts";
import { createExperienceProvider } from "../knowledge/experience-index.ts";
import { createFileKnowledgeStore } from "../knowledge/store.ts";
import type { SessionRunner } from "../runner/types.ts";
import { HarnessError } from "../types.ts";
import { nowIso, Workspace, writeFileAtomic } from "../workspace.ts";
import { runExecutorEpisode, runExecutorQualityAdmission } from "./executor-eval.ts";
import { GenerationStore, type ExperienceRequirementV1, type GenerationBundleV1, type ImproverStrategyV1, type StrategyRecordV1, validateExperienceRequirements, validateStrategy } from "./generation.ts";
import { bindMethodPackageV2, exportMethodPackageV2, readMethodPackageV2 } from "./method-v2.ts";
import { runMetaImprovementAdmission, type ProducedSuccessorV1 } from "./meta-eval.ts";
import { decisionPrompt, improverSystemPrompt, validateResearchAction, type ResearchDecisionViewV1 } from "./policy-host.ts";
import { runBoundedModelStep } from "./research-model.ts";
import { validateResearchPlan, type ResearchCampaignPlanV1, type ResearchCandidateV1, type ResearchDecisionRecordV1, type ResearchRunV1 } from "./research-types.ts";

const activeMutations = new Set<string>();
const RUN_ID = () => `${new Date().toISOString().replace(/[-:.]/g, "")}-${randomBytes(3).toString("hex")}`;
export interface ResearchServiceOptions { workspaceRoot: string; runner: SessionRunner }
export interface ResearchBootstrapInput { version: 1; executor: ExecutorStrategyV1; improver: ImproverStrategyV1; applicability: string[] }
type SearchResult = { selected?: ResearchCandidateV1; selectedAt?: string; decisionCount: number; status: "selected" | "no-winner" | "inconclusive" };

/** Recheck pinned necessary experience before every new child invocation and pointer transition. */
export async function verifyRequiredExperience(workspaceRoot: string, requirements: ExperienceRequirementV1[], expectedSnapshotId?: string): Promise<void> {
 const checked = validateExperienceRequirements(requirements, "requiredExperienceRefs");
 if (!checked.length) return;
 const ws = new Workspace(workspaceRoot), store = createFileKnowledgeStore(ws.knowledgeDir); await store.init();
 const provider = createExperienceProvider(store);
 for (const targetKind of ["executor", "improver"] as const) {
  const requestedRefs = checked.filter((item) => item.targetKind === targetKind).map((item) => item.ref);
  if (!requestedRefs.length) continue;
  const result = await provider.select({ targetKind, applicability: { stage: "method-research", tags: ["cpu-response-identification"] }, requestedRefs,
   expectedSnapshotId, maxRecords: 100, maxChars: 100_000 });
  if (result.status !== "ready" || result.selected.length !== requestedRefs.length) throw new HarnessError("improvement.experience", "required method experience is unavailable, changed, or not locally registered");
 }
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
 constructor(options: ResearchServiceOptions) { this.ws = new Workspace(options.workspaceRoot); this.store = new GenerationStore(this.ws.root); this.runner = options.runner; }
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
  await verifyRequiredExperience(this.ws.root, combineRequirements(h.requiredExperienceRefs, i.requiredExperienceRefs), previous.knowledgeSnapshot);
  return this.store.rollback();
 }); }
 async exportMethod(versionId: string, outputPath: string) {
  const active = await this.store.active();
  const scope = active?.bundle.executorVersionId === versionId && active.pointer.provenance === "local-executor-admission" ? "local-executor-quality" : active?.bundle.improverVersionId === versionId && active.pointer.provenance === "local-meta-admission" ? "local-meta-improvement" : "research-only";
  return exportMethodPackageV2(this.store, versionId, scope, outputPath);
 }
 async bindMethod(packagePath: string) { return this.withMutation(async () => { const active = await this.store.active(); if (!active) throw new HarnessError("improvement.generation", "bootstrap research generation first");
  const pkg = await readMethodPackageV2(packagePath);
  await verifyRequiredExperience(this.ws.root, pkg.requiredExperienceRefs, active.bundle.knowledgeSnapshot);
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
   const experience = await createExperienceProvider(knowledge).select({ targetKind: plan.target, applicability: { stage: "method-research", tags: ["cpu-response-identification"] }, requestedRefs: plan.experienceRefs,
    expectedSnapshotId: active.bundle.knowledgeSnapshot, maxRecords: plan.experienceMaxRecords || 1, maxChars: plan.experienceMaxChars || 1 });
   if (experience.status === "incomplete") { run.status = "inconclusive"; run.stopReason = "requested method experience was unavailable or incomplete"; return run; }
   const selection = { markdown: experience.status === "ready" ? experience.markdown : "", refs: experience.selected.map((item) => item.ref) };
   const h = await this.store.readStrategy(active.bundle.executorVersionId), i = await this.store.readStrategy(active.bundle.improverVersionId);
   await verifyRequiredExperience(this.ws.root, combineRequirements(h.requiredExperienceRefs, i.requiredExperienceRefs), active.bundle.knowledgeSnapshot);
   const selected = await this.search({ run, dir, plan, development, bundle: active.bundle, target: plan.target, improver: i, executor: h, budget, lease: budget.root, selection, save, prefix: "outer", priorFeedback: prior?.feedback ?? [] });
   if (!selected.selected) { run.status = selected.status === "inconclusive" ? "inconclusive" : "research-only"; run.stopReason = "bounded campaign ended without a development-selected candidate"; return run; }
   run.selectedCandidateId = selected.selected.id;
   await writeFileAtomic(path.join(dir, "selected-before-g.json"), `${JSON.stringify({ selectedCandidateId: selected.selected.id, selectedAt: selected.selectedAt, source: "development", target: plan.target }, null, 2)}\n`);
   if (!admission) { run.status = "research-only"; run.stopReason = "no caller-frozen admission case set; candidate remains research-only"; return run; }
   if (budget.status().settlement !== "settled") { run.status = "inconclusive"; run.stopReason = "unknown shared budget before protected admission"; return run; }
   if (plan.experimentKind === "executor-quality") {
    const candidate = await this.store.readStrategy(selected.selected.strategyVersionId);
    const result = await runExecutorQualityAdmission({ caseSet: admission, baseline: { versionId: h.versionId, artifact: h.artifact as ExecutorStrategyV1 }, candidate: { versionId: candidate.versionId, artifact: candidate.artifact as ExecutorStrategyV1 }, runner: this.runner,
     model: active.bundle.modelConfig.research, persistDir: this.ws.sessionsDir, budget, lease: budget.root, timeoutMs: plan.perPromptTimeoutMs, repetitions: plan.admissionRepetitions, maxOutputTokens: plan.perPromptMaxOutputTokens,
     persistObservation: this.persistObservation(dir, id), beforeModelRequest: async (versionId) => {
      const record = versionId === h.versionId ? h : candidate;
      await verifyRequiredExperience(this.ws.root, combineRequirements(record.requiredExperienceRefs, i.requiredExperienceRefs), active.bundle.knowledgeSnapshot);
     } });
    run.admissionPath = path.join(dir, "executor-quality-admission.private.json"); await writeFileAtomic(run.admissionPath, `${JSON.stringify(result, null, 2)}\n`);
    if (result.status === "accepted" && budget.status().settlement === "settled") {
     await verifyRequiredExperience(this.ws.root, combineRequirements(candidate.requiredExperienceRefs, i.requiredExperienceRefs), active.bundle.knowledgeSnapshot);
     const bundle = await this.store.writeBundle({ bundleId: this.store.newId("bundle"), parents: [active.bundle.bundleId], executorVersionId: candidate.versionId, improverVersionId: i.versionId, knowledgeSnapshot: active.bundle.knowledgeSnapshot,
      environmentVersion: active.bundle.environmentVersion, modelConfig: active.bundle.modelConfig, protocolVersion: active.bundle.protocolVersion, allowedCapabilities: active.bundle.allowedCapabilities, state: "admitted" });
     await this.store.activate(bundle.bundleId, active.pointer, "local-executor-admission", id); run.status = "promoted"; run.stopReason = "local executor-quality admission accepted";
    } else { run.status = result.status === "rejected" ? "rejected" : "inconclusive"; run.stopReason = result.reason; }
   } else {
    const meta = await runMetaImprovementAdmission({ oldImproverVersionId: i.versionId, newImproverVersionId: selected.selected.strategyVersionId, initialExecutor: { versionId: h.versionId, artifact: h.artifact as ExecutorStrategyV1 }, knowledgeSnapshot: active.bundle.knowledgeSnapshot,
     branchLimits: plan.metaBranchBudget!, developmentCaseSet: development, admissionCaseSet: admission, budget, rootLease: budget.root, runner: this.runner, researchModel: active.bundle.modelConfig.research,
     persistDir: this.ws.sessionsDir, timeoutMs: plan.perPromptTimeoutMs, repetitions: plan.admissionRepetitions, maxOutputTokens: plan.perPromptMaxOutputTokens,
     produceSuccessor: async (improverVersionId, lease, cases): Promise<ProducedSuccessorV1> => {
      const improver = await this.store.readStrategy(improverVersionId);
      const branch = await this.search({ run, dir, plan, development: cases, bundle: active.bundle, target: "executor", improver, executor: h, budget, lease,
       selection: { markdown: "", refs: [] }, save, prefix: `meta-${improverVersionId}`, priorFeedback: [] });
      const record = branch.selected ? await this.store.readStrategy(branch.selected.strategyVersionId) : undefined;
      return { improverVersionId, startingExecutorVersionId: h.versionId, startingKnowledgeSnapshot: active.bundle.knowledgeSnapshot, selectedExecutor: record ? { versionId: record.versionId, artifact: record.artifact as ExecutorStrategyV1 } : undefined,
       selectedAt: branch.selectedAt, decisionCount: branch.decisionCount, status: branch.status };
     },
     persistSelection: async (oldOutcome, newOutcome) => { const file = path.join(dir, "meta-selections-before-g.private.json"); await writeFileAtomic(file, `${JSON.stringify({ oldOutcome, newOutcome, at: nowIso() }, null, 2)}\n`); return file; },
     persistObservation: this.persistObservation(dir, id), beforeModelRequest: async (versionId) => {
      const record = await this.store.readStrategy(versionId);
      await verifyRequiredExperience(this.ws.root, record.requiredExperienceRefs, active.bundle.knowledgeSnapshot);
     } });
    run.admissionPath = path.join(dir, "meta-admission.private.json"); await writeFileAtomic(run.admissionPath, `${JSON.stringify(meta, null, 2)}\n`);
    if (meta.status === "accepted" && budget.status().settlement === "settled") {
     const candidate = await this.store.readStrategy(selected.selected.strategyVersionId);
     await verifyRequiredExperience(this.ws.root, combineRequirements(h.requiredExperienceRefs, candidate.requiredExperienceRefs), active.bundle.knowledgeSnapshot);
     if (candidate.artifact.body === i.artifact.body) { run.status = "rejected"; run.stopReason = "sham improver body did not change"; }
     else { const bundle = await this.store.writeBundle({ bundleId: this.store.newId("bundle"), parents: [active.bundle.bundleId], executorVersionId: h.versionId, improverVersionId: candidate.versionId, knowledgeSnapshot: active.bundle.knowledgeSnapshot,
       environmentVersion: active.bundle.environmentVersion, modelConfig: active.bundle.modelConfig, protocolVersion: active.bundle.protocolVersion, allowedCapabilities: active.bundle.allowedCapabilities, state: "admitted" });
      await this.store.activate(bundle.bundleId, active.pointer, "local-meta-admission", id); run.status = "promoted"; run.stopReason = "local meta successor protocol accepted"; }
    } else { run.status = meta.status === "rejected" ? "rejected" : "inconclusive"; run.stopReason = meta.reason; }
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
  improver: StrategyRecordV1; executor: StrategyRecordV1; budget: SharedBudget; lease: BudgetLease; selection: ResearchDecisionViewV1["experience"]; save: () => Promise<void>; prefix: string; priorFeedback: DevelopmentFeedback[] }): Promise<SearchResult> {
  const { run, dir, plan, development, budget, lease } = args;
  const first = development.cases[0]!;
  const env = createCpuResponseEnvironment(first, budget, { persistObservation: this.persistObservation(dir, run.runId) });
  if (!(await env.development.healthCheck()).usable) return { decisionCount: 0, status: "inconclusive" };
  const start = await env.development.prepare(`${run.runId}:${args.prefix}`), task = env.development.publicTask(start);
  const initialId = `${args.prefix}-initial-${first.id}`;
  const initialRef: ArtifactRef = { storeId: `method-research:${run.runId}`, id: initialId, version: "1" };
  await writeFileAtomic(path.join(dir, "observations", `${initialId}.json`), `${JSON.stringify({ start, task, observations: task.initialObservations }, null, 2)}\n`);
  const visible: DevelopmentFeedback[] = [initialFeedback(run.runId, first.id, task.initialObservations, initialRef), ...args.priorFeedback]; visible[0]!.id = initialId; visible[0]!.remainingProbeCalls = task.maxProbeCalls;
  run.feedback.push(...visible); await args.save();
  const localCandidates: ResearchCandidateV1[] = [];
  const seenBodies = new Set<string>([args.target === "executor" ? args.executor.artifact.body : args.improver.artifact.body]);
  const ensureLiveExperience = async () => {
   await verifyRequiredExperience(this.ws.root, combineRequirements(args.executor.requiredExperienceRefs, args.improver.requiredExperienceRefs), args.bundle.knowledgeSnapshot);
   if (!args.selection.refs.length) return;
   const knowledge = createFileKnowledgeStore(this.ws.knowledgeDir); await knowledge.init();
   const selected = await createExperienceProvider(knowledge).select({ targetKind: args.target, applicability: { stage: "method-research", tags: ["cpu-response-identification"] },
    requestedRefs: args.selection.refs, expectedSnapshotId: args.bundle.knowledgeSnapshot, maxRecords: plan.experienceMaxRecords, maxChars: plan.experienceMaxChars });
   if (selected.status !== "ready" || JSON.stringify(selected.selected.map((item) => item.ref)) !== JSON.stringify(args.selection.refs) || selected.markdown !== args.selection.markdown)
    throw new HarnessError("improvement.experience", "selected method experience changed or became unavailable before a new model request");
  };
  for (let index = 0; index < plan.maxDecisions; index++) {
   if (budget.status(lease).settlement !== "settled" || budget.status(lease).remaining.providerCalls <= 0) return { decisionCount: index, status: "inconclusive" };
   const view: ResearchDecisionViewV1 = { version: 1, target: args.target, current: { bundleId: args.bundle.bundleId, executorVersionId: args.executor.versionId, improverVersionId: args.improver.versionId }, task,
    feedback: visible.slice(-plan.maxFeedbackItems), historicalFeedbackIds: args.priorFeedback.map((f) => f.id), experience: args.selection, candidates: localCandidates.map((c) => ({ id: c.id, target: c.kind, hypothesis: c.hypothesis, developmentStatus: c.developmentStatus })), budget: budget.status(lease) };
   const record: ResearchDecisionRecordV1 = { index: run.decisions.length + 1, at: nowIso(), processId: process.pid, improverVersionId: args.improver.versionId, outcome: "proposing",
    visibleFeedbackIds: view.feedback.map((f) => f.id), experienceRefs: view.experience.refs };
   run.decisions.push(record); await args.save();
   let response;
   try { await ensureLiveExperience(); response = await runBoundedModelStep({ runner: this.runner, budget, lease, spec: { label: `I-${run.runId}-${args.prefix}-${index}`, role: "improver", model: args.bundle.modelConfig.improver,
    systemPrompt: improverSystemPrompt(args.improver.artifact as ImproverStrategyV1), persistDir: this.ws.sessionsDir, methodBinding: { versionId: args.improver.versionId } }, message: decisionPrompt(view), timeoutMs: plan.perPromptTimeoutMs, maxOutputTokens: plan.perPromptMaxOutputTokens }); }
   catch (error) { record.outcome = "inconclusive"; record.reason = (error as Error).message; await args.save(); return { decisionCount: index + 1, status: "inconclusive" }; }
   record.sessionId = response.sessionId; record.specFile = response.specFile; record.usageSidecar = response.usageSidecar;
   let action;
   try { action = validateResearchAction(JSON.parse(response.text), view); }
   catch (error) { record.outcome = "rejected"; record.reason = (error as Error).message; await args.save(); return { decisionCount: index + 1, status: "inconclusive" }; }
   const decision = record; decision.action = action; decision.outcome = "executed"; await args.save();
   if (action.kind === "inspect") {
    // The requested refs are already controller-persisted, public development observations.
    continue;
   }
   if (action.kind === "probe") {
    const feedback = await env.development.runProbe(start, { kind: "probe", actionId: randomUUID(), x: action.x }, lease);
    visible.push(feedback); run.feedback.push(feedback); decision.feedbackId = feedback.id; await args.save();
    if (feedback.status !== "observed") return { decisionCount: index + 1, status: "inconclusive" };
    continue;
   }
   if (action.kind === "propose") {
    const localCap = args.prefix === "outer" ? plan.maxCandidates : plan.maxCandidatesPerMetaArm ?? 0;
    if (localCandidates.length >= localCap || seenBodies.has(action.body)) { decision.outcome = "rejected"; decision.reason = "local candidate budget exhausted or unchanged/repeated body"; await args.save(); continue; }
    seenBodies.add(action.body);
    const artifact = validateStrategy(args.target, { version: 1, kind: args.target === "executor" ? "cpu-numerical-prompt" : "diagnostic-improver-prompt", body: action.body });
    const parentVersionId = args.target === "executor" ? args.executor.versionId : args.improver.versionId;
    const sourceExperienceRefs: ExperienceRequirementV1[] = args.selection.refs.map((ref) => ({ targetKind: args.target, ref }));
    const requiredExperienceRefs = combineRequirements(sourceExperienceRefs, args.executor.requiredExperienceRefs, args.improver.requiredExperienceRefs);
    const strategy = await this.store.writeStrategy({ versionId: this.store.newId(args.target === "executor" ? "H-agent" : "I-agent"), kind: args.target, artifact, parentVersionId,
     origin: "agent-generated", applicability: action.hypothesis.applicability, limitations: [], sourceExperienceRefs, requiredExperienceRefs, state: "research-only" });
    const candidate: ResearchCandidateV1 = { id: strategy.versionId, kind: args.target, strategyVersionId: strategy.versionId, producedByImproverVersionId: args.improver.versionId,
     hypothesis: action.hypothesis, origin: "agent-generated", developmentStatus: "untested", developmentEvidence: action.hypothesis.motivatingEvidenceIds };
    localCandidates.push(candidate); run.candidates.push(candidate); await args.save(); continue;
   }
   if (action.kind === "evaluate-development") {
    const candidate = localCandidates.find((c) => c.id === action.candidateId)!;
    if (candidate.developmentStatus !== "untested") { decision.outcome = "rejected"; decision.reason = "candidate already development-tested"; await args.save(); continue; }
    const strategy = await this.store.readStrategy(candidate.strategyVersionId);
    if (candidate.kind === "executor") {
     let supported = 0, failed = 0;
     for (const c of development.cases) {
      const e = createCpuResponseEnvironment(c, budget, { persistObservation: this.persistObservation(dir, run.runId) });
      if (!(await e.development.healthCheck()).usable) { failed++; continue; }
      const s = await e.development.prepare(`${run.runId}:dev:${c.id}`);
      const episode = await runExecutorEpisode({ development: e.development, start: s, method: strategy.artifact as ExecutorStrategyV1, methodVersionId: strategy.versionId,
       runner: this.runner, model: args.bundle.modelConfig.research, persistDir: this.ws.sessionsDir, budget, lease, timeoutMs: plan.perPromptTimeoutMs, maxOutputTokens: plan.perPromptMaxOutputTokens,
       beforeModelRequest: () => verifyRequiredExperience(this.ws.root, strategy.requiredExperienceRefs, args.bundle.knowledgeSnapshot) });
      for (const f of episode.feedback) { if (c.id === first.id) visible.push(f); run.feedback.push(f); candidate.developmentEvidence.push(f.id); }
      if (episode.feedback.at(-1)?.status === "supported-by-observations") supported++; else failed++;
     }
     candidate.developmentStatus = failed === 0 && supported > 0 ? "supported" : supported > 0 ? "inconclusive" : "rejected";
    } else {
     const testView: ResearchDecisionViewV1 = { ...view, current: { ...view.current, improverVersionId: strategy.versionId } };
     await ensureLiveExperience(); await verifyRequiredExperience(this.ws.root, strategy.requiredExperienceRefs, args.bundle.knowledgeSnapshot);
     const check = await runBoundedModelStep({ runner: this.runner, budget, lease, spec: { label: `I-dev-${strategy.versionId}`, role: "improver", model: args.bundle.modelConfig.improver,
      systemPrompt: improverSystemPrompt(strategy.artifact as ImproverStrategyV1), persistDir: this.ws.sessionsDir, methodBinding: { versionId: strategy.versionId } }, message: decisionPrompt(testView), timeoutMs: plan.perPromptTimeoutMs, maxOutputTokens: plan.perPromptMaxOutputTokens });
     try { validateResearchAction(JSON.parse(check.text), testView); candidate.developmentStatus = "supported"; }
     catch { candidate.developmentStatus = "rejected"; }
    }
    await args.save(); continue;
   }
   if (action.kind === "stop") {
    if (!action.selectedCandidateId) return { decisionCount: index + 1, status: "no-winner" };
    const candidate = localCandidates.find((c) => c.id === action.selectedCandidateId);
    if (!candidate || candidate.developmentStatus !== "supported") { decision.outcome = "rejected"; decision.reason = "selected candidate lacks development support"; await args.save(); return { decisionCount: index + 1, status: "inconclusive" }; }
    const selectedAt = nowIso();
    await writeFileAtomic(path.join(dir, `${args.prefix}-selection-before-g.json`), `${JSON.stringify({ candidateId: candidate.id, selectedAt, improverVersionId: args.improver.versionId, target: args.target }, null, 2)}\n`);
    return { selected: candidate, selectedAt, decisionCount: index + 1, status: "selected" };
   }
  }
  return { decisionCount: plan.maxDecisions, status: "no-winner" };
 }
}
