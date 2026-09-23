import { randomBytes } from "node:crypto";
import { mkdir, readdir, realpath, rmdir, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { resolveRoleModel } from "../config.ts";
import type { SessionRunner, SessionSpec } from "../runner/types.ts";
import { HarnessError } from "../types.ts";
import { nowIso, readTextIfExists, Workspace, writeFileAtomic } from "../workspace.ts";
import { runAdmission, timedPrompt, loadCaseSet, type AdmissionResult, type MechanismCaseSet } from "./admission.ts";
import { evaluateCandidate } from "./evaluator.ts";
import { readProjectionEvents, replayability } from "./observations.ts";
import { readMethodPackage, type MethodPackageV1 } from "./method.ts";
import { DEFAULT_BUDGET_POLICY, loadActiveBudgetPolicy, validateActiveBudgetPointer, validateBudgetPolicy, type ActiveBudgetPointer, type BudgetPolicy } from "./policy.ts";
import type { AnonymousRunSample, CampaignPlan, ImprovementAttempt, ImprovementHypothesis, ImprovementProtocol, ImprovementRun, ImprovementRunResult, ImprovementStatus } from "./types.ts";

export interface ImprovementServiceOptions {
 workspaceRoot: string;
 runner: SessionRunner;
 minimumReductionRatio?: number;
 maximumNewDeferredRatio?: number;
 minimumInlineCoverageRatio?: number;
 now?: () => Date;
}
interface PromotionReceipt {
 version: 1; runId: string; versionId: string; previousVersionId?: string;
 state: "prepared" | "active"; preparedAt: string; activatedAt?: string; activePointerIsAuthority: true;
}
const IMPROVER_SYSTEM = `You propose one bounded budget policy candidate. Return only JSON with {"hypothesis":{"mechanism":"...","prediction":"...","falsifier":"...","applicability":"...","origin":"improver"},"policy":{"version":1,"maxPromptChars":number,"maxInlineFileChars":number,"maxAggregateInlineChars":number,"maxFeedbackChars":number,"overflowMode":"manifest-and-defer"}}. The hypothesis must be falsifiable. Only the two inline thresholds may change. The anonymous history is developmental feedback, not case answers or proof of scientific benefit. Do not infer private materials.`;
const activeImprovements = new Set<string>();
function runId(now: Date): string { return `${now.toISOString().replace(/[-:.]/g, "").replace("Z", "Z")}-${randomBytes(3).toString("hex")}`; }
function improvementRoot(root: string): string { return path.join(root, ".agent", "improvement"); }
function runRoot(root: string, id: string): string { return path.join(improvementRoot(root), "runs", id); }
function versionRoot(root: string, id: string): string { return path.join(improvementRoot(root), "versions", id); }

/** Real M07 projection calls are the only source of replayable budget samples. */
export async function collectProjectionHistory(workspace: Workspace): Promise<{ samples: AnonymousRunSample[]; unreplayableEvents: number; legacyRunsWithoutEvents: number }> {
 const samples: AnonymousRunSample[] = [];
 let unreplayableEvents = 0, legacyRunsWithoutEvents = 0;
 for (const id of await workspace.listRuns("M07")) {
  const events = await readProjectionEvents(workspace, id);
  if (!events.length) { legacyRunsWithoutEvents++; continue; }
  for (const event of events) {
   if (!replayability(event).replayable || (event.purpose === "task-message" && event.deliveryStatus !== "submitted")) { unreplayableEvents++; continue; }
   const texts = event.materials.filter((item) => item.mediaType === "text");
   const sizes = texts.map((item) => item.utf16CodeUnits!);
   samples.push({ eventId: event.eventId, purpose: event.purpose, policyVersionId: event.policyVersionId,
    deliveryStatus: event.deliveryStatus, inputChars: sizes.reduce((a, b) => a + b, 0), inputFileChars: sizes,
    inputUtf8Bytes: texts.reduce((a, item) => a + item.utf8Bytes!, 0),
    observedInlineChars: texts.filter((item) => item.decision === "inline").reduce((a, item) => a + item.utf16CodeUnits!, 0), failureClasses: [] });
  }
 }
 return { samples, unreplayableEvents, legacyRunsWithoutEvents };
}
/** Compatibility name: the result now contains M07 projection calls, never stage input sizes. */
export async function collectAnonymousRunSamples(workspace: Workspace): Promise<AnonymousRunSample[]> { return (await collectProjectionHistory(workspace)).samples; }
function validatePlan(input: CampaignPlan): CampaignPlan {
 const integer = (name: keyof CampaignPlan, min: number, max: number) => { const n = input[name]; if (typeof n !== "number" || !Number.isSafeInteger(n) || n < min || n > max) throw new HarnessError("improvement.plan", `${name} must be an integer from ${min} to ${max}`); };
 if (!input || input.version !== 1) throw new HarnessError("improvement.plan", "CampaignPlan.version must be 1");
 integer("maxCandidates", 1, 20); integer("maxTrialCalls", 0, 1000); integer("repetitions", 1, 10); integer("maxReadbackChars", 0, 1_000_000);
 integer("maxTotalInputTokens", 1, 100_000_000); integer("maxTotalOutputTokens", 1, 100_000_000); integer("timeoutMs", 100, 3_600_000);
 if (typeof input.maxTotalCost !== "number" || !Number.isFinite(input.maxTotalCost) || input.maxTotalCost <= 0) throw new HarnessError("improvement.plan", "maxTotalCost must be positive");
 if (input.caseSetPath !== undefined && (typeof input.caseSetPath !== "string" || !input.caseSetPath.trim())) throw new HarnessError("improvement.plan", "caseSetPath must be a nonempty string");
 return input;
}
function validateHypothesis(input: unknown): ImprovementHypothesis {
 if (!input || typeof input !== "object") throw new HarnessError("improvement.hypothesis", "hypothesis missing");
 const h = input as Record<string, unknown>;
 for (const key of ["mechanism", "prediction", "falsifier", "applicability"]) if (typeof h[key] !== "string" || !(h[key] as string).trim() || (h[key] as string).length > 2000) throw new HarnessError("improvement.hypothesis", `${key} is required`);
 if (h.origin !== "improver") throw new HarnessError("improvement.hypothesis", "model proposal origin must be improver");
 return h as unknown as ImprovementHypothesis;
}
interface PriorAttemptSummary { id: string; status: string; failureClass: string; hypothesis?: ImprovementHypothesis; policy?: BudgetPolicy; failedGates?: string[] }
async function previousAttemptSummaries(root: string, runs: ImprovementStatus["runs"]): Promise<PriorAttemptSummary[]> {
 const history: PriorAttemptSummary[] = [];
 for (const entry of runs.slice(-20)) {
  const text = await readTextIfExists(path.join(runRoot(root, entry.runId), "run.json")); if (!text) continue;
  let prior: ImprovementRun; try { prior = JSON.parse(text) as ImprovementRun; } catch { continue; }
  for (const attempt of prior.attempts ?? []) {
   const summary: PriorAttemptSummary = { id: `${entry.runId}#${attempt.index}`, status: attempt.status, failureClass: summaryClass(attempt.reason) };
   if (attempt.hypothesis) summary.hypothesis = attempt.hypothesis;
   const policyText = attempt.candidatePath ? await readTextIfExists(attempt.candidatePath) : undefined;
   if (policyText) { try { summary.policy = validateBudgetPolicy(JSON.parse(policyText)); } catch { /* omit invalid legacy candidate */ } }
   const evaluationText = attempt.evaluationPath ? await readTextIfExists(attempt.evaluationPath) : undefined;
   if (evaluationText) { try { const value = JSON.parse(evaluationText) as { gates?: Array<{ name: string; passed: boolean }> }; summary.failedGates = value.gates?.filter((gate) => !gate.passed).map((gate) => gate.name) ?? []; } catch { /* omit */ } }
   history.push(summary);
  }
 }
 return history.slice(-20);
}
function sameObservationObligation(a: ImprovementProtocol, b: ImprovementProtocol): boolean {
 return a.version === 2 && b.version === 2 && JSON.stringify(a.baselinePolicy) === JSON.stringify(b.baselinePolicy) &&
  JSON.stringify(a.samples.map((sample) => sample.eventId)) === JSON.stringify(b.samples.map((sample) => sample.eventId)) &&
  a.minimumReductionRatio === b.minimumReductionRatio && a.maximumNewDeferredRatio === b.maximumNewDeferredRatio && a.minimumInlineCoverageRatio === b.minimumInlineCoverageRatio;
}
function summaryClass(reason?: string): string { if (!reason) return "none"; if (/evidence|case|projection|trigger/.test(reason)) return "evidence-or-trigger"; if (/usage|cost|token|budget/.test(reason)) return "resource-or-usage"; if (/check|quality/.test(reason)) return "quality-check"; return "other"; }

export class ImprovementService {
 private readonly root: string;
 private readonly runner: SessionRunner;
 private readonly minimumReductionRatio: number;
 private readonly maximumNewDeferredRatio: number;
 private readonly minimumInlineCoverageRatio: number;
 private readonly now: () => Date;
 constructor(options: ImprovementServiceOptions) {
  this.root = path.resolve(options.workspaceRoot); this.runner = options.runner;
  this.minimumReductionRatio = options.minimumReductionRatio ?? 0.10;
  this.maximumNewDeferredRatio = options.maximumNewDeferredRatio ?? 0.35;
  this.minimumInlineCoverageRatio = options.minimumInlineCoverageRatio ?? 0.35;
  if (!(this.minimumReductionRatio > 0 && this.minimumReductionRatio < 1)) throw new HarnessError("improvement.protocol", "minimumReductionRatio must be between 0 and 1");
  if (!(this.maximumNewDeferredRatio >= 0 && this.maximumNewDeferredRatio <= 1)) throw new HarnessError("improvement.protocol", "maximumNewDeferredRatio must be between 0 and 1");
  if (!(this.minimumInlineCoverageRatio > 0 && this.minimumInlineCoverageRatio <= 1)) throw new HarnessError("improvement.protocol", "minimumInlineCoverageRatio must be between 0 and 1");
  this.now = options.now ?? (() => new Date());
 }
 /** A campaign needs an explicit caller-frozen resource plan, including screen-only runs. */
 async run(plan?: CampaignPlan): Promise<ImprovementRunResult> {
  if (!plan) throw new HarnessError("improvement.plan-required", "improve run requires an explicit CampaignPlan; no model call was made");
  return this.runCampaign(plan);
 }
 async runCampaign(plan: CampaignPlan): Promise<ImprovementRunResult> { validatePlan(plan); return this.withMutation(() => this.runCampaignUnlocked(plan)); }
 private async runCampaignUnlocked(plan: CampaignPlan): Promise<ImprovementRunResult> {
  const ws = new Workspace(this.root); await this.ensureBuiltinVersion();
  const baseline = await loadActiveBudgetPolicy(this.root), pointer = await this.readPointer();
  const id = runId(this.now()), dir = runRoot(this.root, id);
  await mkdir(path.join(dir, "candidate"), { recursive: true });
  const baselinePath = path.join(dir, "baseline-policy.json"), protocolPath = path.join(dir, "protocol.json"), statePath = path.join(dir, "run.json"), planPath = path.join(dir, "plan.json");
  const history = await collectProjectionHistory(ws);
  const protocol: ImprovementProtocol = { version: 2, objective: "reduce-observed-inline-payload", minimumReductionRatio: this.minimumReductionRatio, maximumNewDeferredRatio: this.maximumNewDeferredRatio, minimumInlineCoverageRatio: this.minimumInlineCoverageRatio, requireManifestCoverage: true, allowedCandidate: "budget-policy-only", baselinePolicy: baseline, ...history, createdAt: nowIso() };
  const run: ImprovementRun = { version: 2, runId: id, status: "proposing", startedAt: nowIso(), baselineVersionId: pointer?.versionId ?? "builtin-default", baselinePath, protocolPath, planPath, attempts: [], campaignUsage: { input: 0, output: 0, cost: 0, complete: true, usageSettlement: "settled", proposerCalls: 0, trialCalls: 0, inFlightBudgetMayExceed: true } };
  await writeFileAtomic(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`);
  await writeFileAtomic(protocolPath, `${JSON.stringify(protocol, null, 2)}\n`);
  await writeFileAtomic(planPath, `${JSON.stringify({ ...plan, caseSetPath: plan.caseSetPath ? "[caller-supplied case set; frozen separately]" : undefined }, null, 2)}\n`);
  await writeFileAtomic(statePath, `${JSON.stringify(run, null, 2)}\n`);
  let caseSet: MechanismCaseSet | undefined;
  let config: Awaited<ReturnType<Workspace["loadConfig"]>>;
  let model: string;
  try {
   if (!protocol.samples.length || !protocol.samples.some((sample) => sample.inputChars > 0)) { run.status = "inconclusive"; run.stopReason = "no replayable M07 text projection opportunity"; run.finishedAt = nowIso(); await writeFileAtomic(statePath, `${JSON.stringify(run, null, 2)}\n`); return { run, activeVersionId: pointer?.versionId }; }
   if (plan.caseSetPath) {
    caseSet = await loadCaseSet(path.resolve(this.root, plan.caseSetPath));
    if (caseSet.split === "admission" && (plan.repetitions < 2 || plan.repetitions % 2 !== 0)) { run.status = "inconclusive"; run.stopReason = "admission requires at least two even-order repetitions"; run.finishedAt = nowIso(); await writeFileAtomic(statePath, `${JSON.stringify(run, null, 2)}\n`); return { run, activeVersionId: pointer?.versionId }; }
    run.caseSetSnapshotPath = path.join(dir, "case-set.private.json");
    await writeFileAtomic(run.caseSetSnapshotPath, `${JSON.stringify(caseSet, null, 2)}\n`);
   }
   config = await ws.loadConfig(); model = resolveRoleModel(config, "improver");
   run.modelConfig = { improver: model, research: resolveRoleModel(config, "research") };
   await writeFileAtomic(statePath, `${JSON.stringify(run, null, 2)}\n`);
  } catch (error) {
   run.status = "failed"; run.stopReason = `setup failed: ${(error as Error).message}`; run.finishedAt = nowIso();
   await writeFileAtomic(statePath, `${JSON.stringify(run, null, 2)}\n`); throw error;
  }
  const budget = { trialCalls: plan.maxTrialCalls, readbackChars: plan.maxReadbackChars, inputTokens: plan.maxTotalInputTokens, outputTokens: plan.maxTotalOutputTokens, cost: plan.maxTotalCost };
  const seen = new Set<string>();
  const previous = await this.status();
  const previousRuns = previous.runs.filter((r) => r.runId !== id);
  const priorHistory = await previousAttemptSummaries(this.root, previousRuns);
  // Duplicate blocking is scoped to this exact frozen experimental obligation.
  for (const entry of previousRuns) {
   const priorText = await readTextIfExists(path.join(runRoot(this.root, entry.runId), "run.json")); if (!priorText) continue;
   let prior: ImprovementRun; try { prior = JSON.parse(priorText) as ImprovementRun; } catch { continue; }
   if (prior.baselineVersionId !== run.baselineVersionId || JSON.stringify(prior.modelConfig) !== JSON.stringify(run.modelConfig)) continue;
   const priorProtocolText = await readTextIfExists(prior.protocolPath); if (!priorProtocolText) continue;
   let priorProtocol: ImprovementProtocol; try { priorProtocol = JSON.parse(priorProtocolText) as ImprovementProtocol; } catch { continue; }
   if (!sameObservationObligation(protocol, priorProtocol)) continue;
   const priorCase = prior.caseSetSnapshotPath ? await readTextIfExists(prior.caseSetSnapshotPath) : undefined;
   const currentCase = run.caseSetSnapshotPath ? await readTextIfExists(run.caseSetSnapshotPath) : undefined;
   if (priorCase !== currentCase) continue;
   for (const attempt of prior.attempts ?? []) {
    const policyText = attempt.candidatePath ? await readTextIfExists(attempt.candidatePath) : undefined;
    if (policyText) { try { seen.add(JSON.stringify(validateBudgetPolicy(JSON.parse(policyText)))); } catch { /* ignore corrupt record */ } }
   }
  }
  for (let index = 1; index <= plan.maxCandidates; index++) {
   if (budget.inputTokens <= 0 || budget.outputTokens <= 0 || budget.cost <= 0) { run.stopReason = "total proposer/trial resource budget exhausted"; break; }
   const attempt: ImprovementAttempt = { index, status: "proposing", historyConsumed: [...priorHistory.map((h) => h.id), ...run.attempts.map((a) => `${id}#${a.index}`)] };
   run.attempts.push(attempt); await writeFileAtomic(statePath, `${JSON.stringify(run, null, 2)}\n`);
   const spec: SessionSpec = { label: `RSI-budget-${id}-${index}`, role: "improver", model, systemPrompt: IMPROVER_SYSTEM, tools: { kind: "none" }, persistDir: ws.sessionsDir };
   let handle;
   try {
    handle = await this.runner.create(spec); run.session = { id: handle.ref.id, label: handle.ref.label, model: handle.ref.model, file: handle.ref.file, usageSidecar: handle.ref.file?.replace(/\.jsonl$/, ".usage.jsonl") };
    const currentHistory = await Promise.all(run.attempts.slice(0, -1).map(async (a): Promise<PriorAttemptSummary> => {
     const policyText = a.candidatePath ? await readTextIfExists(a.candidatePath) : undefined;
     let policy: BudgetPolicy | undefined;
     if (policyText) { try { policy = validateBudgetPolicy(JSON.parse(policyText)); } catch { /* omit invalid candidate */ } }
     return { id: `${id}#${a.index}`, status: a.status, failureClass: summaryClass(a.reason), hypothesis: a.hypothesis, policy, failedGates: a.reason?.split(", ") };
    }));
    const safePrompt = JSON.stringify({ objective: protocol.objective, thresholds: { minimumReductionRatio: protocol.minimumReductionRatio, maximumNewDeferredRatio: protocol.maximumNewDeferredRatio, minimumInlineCoverageRatio: protocol.minimumInlineCoverageRatio }, baselinePolicy: baseline,
     samples: protocol.samples.map((s) => ({ purpose: s.purpose, deliveryStatus: s.deliveryStatus, inputFileChars: s.inputFileChars, observedInlineChars: s.observedInlineChars })),
     history: [...priorHistory, ...currentHistory] });
    let turn;
    run.campaignUsage!.proposerCalls++;
    try { turn = await timedPrompt(handle, safePrompt, plan.timeoutMs); }
    finally {
     const usage = handle.usageSummary?.() ?? { input: 0, output: 0, cost: 0, complete: false, costComplete: false };
     run.campaignUsage!.input += usage.input; run.campaignUsage!.output += usage.output; run.campaignUsage!.cost += usage.cost; run.campaignUsage!.complete &&= usage.complete && usage.costComplete === true && usage.reportedEvents > 0;
     if (!usage.complete || !usage.costComplete || usage.reportedEvents === 0) run.campaignUsage!.usageSettlement = "pending-or-unknown";
     budget.inputTokens -= usage.input; budget.outputTokens -= usage.output; budget.cost -= usage.cost;
    }
    if (!run.campaignUsage!.complete || budget.inputTokens < 0 || budget.outputTokens < 0 || budget.cost < 0) { attempt.status = "inconclusive"; attempt.reason = "proposer usage incomplete or observed budget exceeded"; break; }
    let proposal: unknown;
    try { proposal = JSON.parse(turn.text); } catch { throw new HarnessError("improvement.candidate-json", "proposal must be one JSON object"); }
    if (!proposal || typeof proposal !== "object") throw new HarnessError("improvement.candidate-json", "proposal must be an object");
    const parsed = proposal as Record<string, unknown>;
    attempt.hypothesis = validateHypothesis(parsed.hypothesis);
    const candidate = validateBudgetPolicy(parsed.policy);
    const key = JSON.stringify(candidate);
    if (seen.has(key)) { attempt.status = "rejected"; attempt.reason = "duplicate candidate under the same frozen experimental obligation"; continue; }
    seen.add(key);
    const candidatePath = path.join(dir, "candidate", `policy-${index}.json`); await writeFileAtomic(candidatePath, `${JSON.stringify(candidate, null, 2)}\n`);
    attempt.candidatePath = candidatePath; run.candidatePath = candidatePath; run.status = "candidate-ready";
    const evaluation = evaluateCandidate(protocol, candidate);
    const evaluationPath = path.join(dir, `evaluation-${index}.json`); await writeFileAtomic(evaluationPath, `${JSON.stringify(evaluation, null, 2)}\n`);
    attempt.evaluationPath = evaluationPath; run.evaluationPath = evaluationPath;
    if (!evaluation.passed) { attempt.status = evaluation.status === "insufficient-evidence" ? "inconclusive" : "rejected"; attempt.reason = evaluation.gates.filter((g) => !g.passed).map((g) => g.name).join(", "); continue; }
    attempt.status = "screened";
    if (!caseSet || plan.maxTrialCalls === 0) { attempt.status = "inconclusive"; attempt.reason = "projection screen only; no caller-authorized paired admission case/budget"; continue; }
    const admission = await runAdmission({ runner: this.runner, config, persistDir: ws.sessionsDir, caseSet, baseline, candidate, baselineVersionId: run.baselineVersionId, candidateVersionId: `candidate-${id}-${index}`, plan, remaining: budget });
    run.campaignUsage!.trialCalls += admission.trialCalls;
    for (const arm of admission.results) { run.campaignUsage!.input += arm.usage.input; run.campaignUsage!.output += arm.usage.output; run.campaignUsage!.cost += arm.usage.cost; run.campaignUsage!.complete &&= arm.usage.complete && !arm.failure;
    if (arm.usage.usageSettlement !== "settled") run.campaignUsage!.usageSettlement = "pending-or-unknown"; }
    const admissionPath = path.join(dir, `admission-${index}.json`); await writeFileAtomic(admissionPath, `${JSON.stringify(admission, null, 2)}\n`);
    attempt.admissionPath = admissionPath; run.admissionPath = admissionPath;
    if (admission.status !== "accepted") { attempt.status = admission.status === "rejected" ? "rejected" : "inconclusive"; attempt.reason = admission.reason; continue; }
    if (caseSet.split !== "admission") { attempt.status = "inconclusive"; attempt.reason = "development case results cannot authorize promotion"; continue; }
    const activeVersionId = await this.promote(id, candidate, pointer, run);
    attempt.status = "promoted"; run.status = "promoted"; run.finishedAt = nowIso(); run.stopReason = "accepted by fixed local mechanism admission";
    await writeFileAtomic(statePath, `${JSON.stringify(run, null, 2)}\n`);
    return { run, evaluation, activeVersionId };
   } catch (error) {
    const committed = await this.readPointer().catch(() => undefined);
    if (committed?.runId === id) { run.status = "promoted"; run.finishedAt = nowIso(); await writeFileAtomic(statePath, `${JSON.stringify(run, null, 2)}\n`).catch(() => undefined); return { run, activeVersionId: committed.versionId }; }
    if (error instanceof HarnessError && error.code === "improvement.timeout") {
     attempt.status = "inconclusive"; attempt.reason = error.message; run.stopReason = "timed prompt was aborted; campaign stopped"; run.campaignUsage!.complete = false; run.campaignUsage!.usageSettlement = "pending-or-unknown"; break;
    }
    attempt.status = "failed"; attempt.reason = (error as Error).message; run.status = "failed"; run.finishedAt = nowIso(); run.stopReason = attempt.reason;
    await writeFileAtomic(statePath, `${JSON.stringify(run, null, 2)}\n`).catch(() => undefined); throw error;
   } finally { handle?.dispose(); await writeFileAtomic(statePath, `${JSON.stringify(run, null, 2)}\n`).catch(() => undefined); }
  }
  run.status = run.attempts.some((a) => a.status === "inconclusive") ? "inconclusive" : run.attempts.some((a) => a.status === "screened") ? "screened" : "rejected";
  run.stopReason ??= "bounded campaign finished without an accepted candidate"; run.finishedAt = nowIso();
  await writeFileAtomic(statePath, `${JSON.stringify(run, null, 2)}\n`);
  return { run, activeVersionId: pointer?.versionId };
 }

	async status(): Promise<ImprovementStatus> {
		const pointer = await this.readPointer();
		const runsDir = path.join(improvementRoot(this.root), "runs");
		const runs: ImprovementStatus["runs"] = [];
		if (existsSync(runsDir)) for (const name of (await readdir(runsDir)).sort()) {
			const text = await readTextIfExists(path.join(runsDir, name, "run.json")); if (!text) continue;
			const value = JSON.parse(text) as ImprovementRun;
			const effectiveStatus = pointer?.runId === value.runId ? "promoted" as const : value.status;
			runs.push({ runId: value.runId, status: effectiveStatus, startedAt: value.startedAt, finishedAt: value.finishedAt ?? (effectiveStatus === "promoted" ? pointer?.promotedAt : undefined) });
		}
		return { activeVersionId: pointer?.versionId, activeProvenance: pointer ? pointer.provenance ?? "legacy-projection-only" : undefined, previousVersionId: pointer?.previousVersionId, runs };
	}

	async rollback(): Promise<ActiveBudgetPointer> { return this.withMutation(() => this.rollbackUnlocked()); }

	private async rollbackUnlocked(): Promise<ActiveBudgetPointer> {
		const pointer = await this.readPointer();
		if (!pointer?.previousVersionId) throw new HarnessError("improvement.rollback", "没有可回退的上一预算策略版本");
		if (!existsSync(path.join(versionRoot(this.root, pointer.previousVersionId), "policy.json"))) throw new HarnessError("improvement.rollback", "上一预算策略版本不存在");
		const next: ActiveBudgetPointer = { version: 1, versionId: pointer.previousVersionId, previousVersionId: pointer.versionId, promotedAt: nowIso(), runId: `rollback-${pointer.runId}`, provenance: await this.versionProvenance(pointer.previousVersionId) };
		await writeFileAtomic(path.join(improvementRoot(this.root), "active.json"), `${JSON.stringify(next, null, 2)}\n`);
		const rollbackId = `${this.now().toISOString().replace(/[-:.]/g, "")}-${randomBytes(3).toString("hex")}`;
		await writeFileAtomic(path.join(improvementRoot(this.root), "rollbacks", `${rollbackId}.json`), `${JSON.stringify({ version: 1, at: next.promotedAt, fromVersionId: pointer.versionId, toVersionId: next.versionId, activePointerIsAuthority: true }, null, 2)}\n`);
		return next;
	}

	private async promote(id: string, candidate: BudgetPolicy, previous: ActiveBudgetPointer | undefined, run: ImprovementRun): Promise<string> {
		const current = await this.readPointer();
		if ((current?.versionId ?? "builtin-default") !== (previous?.versionId ?? "builtin-default") || current?.runId !== previous?.runId) throw new HarnessError("improvement.stale-baseline", "活动策略已在本轮评估期间变化；候选未晋级，请基于新 baseline 重跑");
		const versionId = `budget-${id}`;
		const previousVersionId = previous?.versionId ?? "builtin-default";
		await mkdir(versionRoot(this.root, versionId), { recursive: true });
		await writeFileAtomic(path.join(versionRoot(this.root, versionId), "policy.json"), `${JSON.stringify(candidate, null, 2)}\n`);
		const receiptPath = path.join(runRoot(this.root, id), "promotion.json");
		const receipt: PromotionReceipt = { version: 1, runId: id, versionId, previousVersionId, state: "prepared", preparedAt: nowIso(), activePointerIsAuthority: true };
		await writeFileAtomic(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
		run.promotionReceiptPath = receiptPath;
		const pointer: ActiveBudgetPointer = { version: 1, versionId, previousVersionId, promotedAt: nowIso(), runId: id, provenance: "local-mechanism-admission" };
		// This atomic pointer replacement is the sole activation commit point. A prepared receipt is recoverable by comparing it with active.json.
		await writeFileAtomic(path.join(improvementRoot(this.root), "active.json"), `${JSON.stringify(pointer, null, 2)}\n`);
		receipt.state = "active"; receipt.activatedAt = pointer.promotedAt;
		await writeFileAtomic(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
		return versionId;
	}


 async exportMethodPackage(versionId: string, applicability: string, outputPath: string): Promise<MethodPackageV1> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(versionId) || !applicability.trim()) throw new HarnessError("improvement.method", "safe versionId and applicability are required");
  const text = await readTextIfExists(path.join(versionRoot(this.root, versionId), "policy.json"));
  if (!text) throw new HarnessError("improvement.method", "method version does not exist");
  const policy = validateBudgetPolicy(JSON.parse(text));
  let provenance: MethodPackageV1["provenance"] = "legacy-projection-only";
  let admissionSummary: MethodPackageV1["admissionSummary"];
  if (versionId.startsWith("budget-")) {
   const id = versionId.slice("budget-".length);
   const runText = await readTextIfExists(path.join(runRoot(this.root, id), "run.json"));
   if (runText) {
    const run = JSON.parse(runText) as ImprovementRun;
    const admitted = run.attempts?.find((a) => a.status === "promoted" && a.admissionPath);
    const evidenceText = admitted?.admissionPath ? await readTextIfExists(admitted.admissionPath) : undefined;
    if (evidenceText) {
     const evidence = JSON.parse(evidenceText) as AdmissionResult;
     if (evidence.status === "accepted" && evidence.scope === "local-mechanism-projection-readback") {
      provenance = "local-mechanism-admission";
      admissionSummary = { scope: evidence.scope, caseSetSplit: evidence.caseSetSplit, checkedCases: evidence.results.length / 2, queryCount: evidence.queryCount, baselineCost: evidence.baselineCost, candidateCost: evidence.candidateCost };
     }
    }
   }
  }
  const pkg: MethodPackageV1 = { version: 1, methodType: "budget-policy", sourceVersionId: versionId, policy, applicability, provenance, ...(admissionSummary ? { admissionSummary } : {}) };
  await writeFileAtomic(outputPath, `${JSON.stringify(pkg, null, 2)}\n`);
  return pkg;
 }
 async bindMethodPackage(packagePath: string): Promise<ActiveBudgetPointer> {
  return this.withMutation(async () => {
   await this.ensureBuiltinVersion();
   const pkg = await readMethodPackage(packagePath);
   const previous = await this.readPointer();
   const id = runId(this.now()), versionId = `imported-${id}`;
   await writeFileAtomic(path.join(versionRoot(this.root, versionId), "policy.json"), `${JSON.stringify(pkg.policy, null, 2)}\n`);
   await writeFileAtomic(path.join(versionRoot(this.root, versionId), "origin.json"), `${JSON.stringify({ version: 1, origin: "external-manual-unverified", sourceVersionId: pkg.sourceVersionId, claimedProvenance: pkg.provenance, applicability: pkg.applicability, importedAt: nowIso() }, null, 2)}\n`);
   const current = await this.readPointer();
   if ((current?.versionId ?? "builtin-default") !== (previous?.versionId ?? "builtin-default") || current?.runId !== previous?.runId) throw new HarnessError("improvement.stale-baseline", "active policy changed during method bind");
   const pointer: ActiveBudgetPointer = { version: 1, versionId, previousVersionId: previous?.versionId ?? "builtin-default", promotedAt: nowIso(), runId: `manual-bind-${id}`, provenance: "external-manual-unverified" };
   await writeFileAtomic(path.join(improvementRoot(this.root), "active.json"), `${JSON.stringify(pointer, null, 2)}\n`);
   return pointer;
  });
 }
 private async versionProvenance(versionId: string): Promise<ActiveBudgetPointer["provenance"]> {
  const text = await readTextIfExists(path.join(versionRoot(this.root, versionId), "origin.json"));
  if (text) { try { if (JSON.parse(text).origin === "external-manual-unverified") return "external-manual-unverified"; } catch { /* fall through */ } }
  if (versionId.startsWith("budget-")) {
   const id = versionId.slice("budget-".length);
   const runText = await readTextIfExists(path.join(runRoot(this.root, id), "run.json"));
   if (runText) { try { const run = JSON.parse(runText) as ImprovementRun; if (run.attempts?.some((a) => a.status === "promoted" && a.admissionPath)) return "local-mechanism-admission"; } catch { /* fall through */ } }
  }
  return "legacy-projection-only";
 }
	private async readPointer(): Promise<ActiveBudgetPointer | undefined> {
		const text = await readTextIfExists(path.join(improvementRoot(this.root), "active.json"));
		if (!text) return undefined;
		try { return validateActiveBudgetPointer(JSON.parse(text)); } catch (error) { if (error instanceof HarnessError) throw error; throw new HarnessError("improvement.active", "active.json 不是合法 JSON"); }
	}

	private async ensureBuiltinVersion(): Promise<void> {
		const file = path.join(versionRoot(this.root, "builtin-default"), "policy.json");
		if (existsSync(file)) return;
		await writeFileAtomic(file, `${JSON.stringify(DEFAULT_BUDGET_POLICY, null, 2)}\n`);
	}

	private async withMutation<T>(operation: () => Promise<T>): Promise<T> {
		const key = await realpath(this.root).catch(() => this.root);
		if (activeImprovements.has(key)) throw new HarnessError("improvement.busy", `工作区已有策略改进操作：${this.root}`);
		activeImprovements.add(key);
		const lockDir = path.join(improvementRoot(this.root), "mutation.lock");
		const ownerFile = path.join(lockDir, "owner.json");
		let acquired = false;
		try {
			await mkdir(improvementRoot(this.root), { recursive: true });
			try { await mkdir(lockDir); } catch (error) {
				if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new HarnessError("improvement.locked", `策略改进锁已存在：${lockDir}。可能有另一进程正在运行；若确认进程已崩溃，请检查 owner.json 后删除该精确 lock 目录再重试`);
				throw error;
			}
			acquired = true;
			await writeFileAtomic(ownerFile, `${JSON.stringify({ version: 1, pid: process.pid, acquiredAt: nowIso(), operation: "run-or-rollback" }, null, 2)}\n`);
			return await operation();
		} finally {
			activeImprovements.delete(key);
			if (acquired && existsSync(ownerFile)) await unlink(ownerFile).catch(() => undefined);
			if (acquired && existsSync(lockDir)) await rmdir(lockDir).catch(() => undefined);
		}
	}
}

export type { BudgetPolicy } from "./policy.ts";
export { DEFAULT_BUDGET_POLICY, loadActiveBudgetPolicy, validateBudgetPolicy } from "./policy.ts";
