import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import test, { type TestContext } from "node:test";
import { ResearchImprovementService } from "../src/improvement/research-service.ts";
import { GenerationStore } from "../src/improvement/generation.ts";
import type { ResearchCampaignPlanV1 } from "../src/improvement/research-types.ts";
import { FakeSessionRunner, type FakeReplyContext } from "../src/runner/fake.ts";
import { SharedBudget } from "../src/experiments/budget.ts";
import { runExecutorQualityAdmission } from "../src/improvement/executor-eval.ts";
import { validateCpuCaseSet } from "../src/experiments/local-environment.ts";
import { createFileKnowledgeStore } from "../src/knowledge/store.ts";

const usage = { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 150, cost: 0.001 };
const execFileAsync = promisify(execFile);
const cpuCase = (split: "development" | "admission", id: string) => ({ version: 1, split, cases: [{ id, version: 1, truthHypothesisId: "h1",
 hypotheses: [
  { id: "h1", formula: { kind: "affine", slope: split === "admission" ? 2 : 1, intercept: 4 } },
  { id: "h2", formula: { kind: "quadratic", coefficient: split === "admission" ? 3 : 1, intercept: 4 } },
  { id: "h3", formula: { kind: "affine", slope: split === "admission" ? 5 : 3, intercept: 4 } },
 ], initialX: [0], allowedProbeX: [2], maxProbeCalls: 1, tolerance: 0.01, units: { x: "s", y: "m" } }] });
const plan = (admissionCaseSetPath?: string): ResearchCampaignPlanV1 => ({ version: 1, experimentKind: "executor-quality", target: "executor", developmentCaseSetPath: "development.json",
 ...(admissionCaseSetPath ? { admissionCaseSetPath, searchReplicates: 1, outcomeReplicates: 2,
  outerBudget: { maxProviderCalls: 8, maxInputTokens: 160_000, maxSdkEstimatedCost: 1, maxProbeCalls: 5, maxCpuMillis: 10_000, maxWallMillis: 60_000 },
  pilotBudget: { maxProviderCalls: 5, maxInputTokens: 100_000, maxSdkEstimatedCost: 1, maxProbeCalls: 3, maxCpuMillis: 10_000, maxWallMillis: 60_000 },
  protectedBudget: { maxProviderCalls: 12, maxInputTokens: 240_000, maxSdkEstimatedCost: 2, maxProbeCalls: 8, maxCpuMillis: 10_000, maxWallMillis: 60_000 } } : {}),
 maxDecisions: 4, maxCandidates: 2, admissionRepetitions: 2, maxFeedbackItems: 8, perPromptTimeoutMs: 10_000,
 budget: { maxProviderCalls: 80, maxInputTokens: 1_000_000, maxSdkEstimatedCost: 10, maxProbeCalls: 80, maxCpuMillis: 100_000, maxWallMillis: 500_000 },
 experienceRefs: [], experienceMaxRecords: 0, experienceMaxChars: 0 });

function fakeReply(ctx: FakeReplyContext) {
 assert.deepEqual(ctx.spec.tools, { kind: "none" });
 assert.ok(ctx.spec.strictRequest);
 assert.doesNotMatch(ctx.message, /truthHypothesisId|admission-cases|protectedEvaluator/);
 if (ctx.spec.role === "improver") {
  const view = JSON.parse(ctx.message.slice(ctx.message.indexOf("\n") + 1));
  const visible = view.feedback[0].id;
  const turn = Number(ctx.spec.label.split("-").at(-1));
  if (turn === 0) return { text: JSON.stringify({ kind: "probe", x: 2, rationale: "separate observed response mechanisms" }), usage };
  if (turn === 1) return { text: JSON.stringify({ kind: "propose", target: "executor", body: "Probe the discriminating coordinate before submitting a response hypothesis.",
   hypothesis: { claim: "A discriminating measurement avoids premature selection", predictedObservation: "A unique response remains after x=2", falsifier: "The probe leaves multiple responses viable", applicability: ["cpu-response-identification"], motivatingEvidenceIds: [visible] } }), usage };
  if (turn === 2) return { text: JSON.stringify({ kind: "evaluate-development", candidateId: view.candidates[0].id }), usage };
  return { text: JSON.stringify({ kind: "stop", reason: "candidate has development support", selectedCandidateId: view.candidates[0].id }), usage };
 }
 const input = JSON.parse(ctx.message);
 if (ctx.spec.systemPrompt.includes("Probe the discriminating coordinate") && input.visibleFeedback.length === 0) return { text: JSON.stringify({ kind: "probe", actionId: "probe-1", x: 2 }), usage };
 return { text: JSON.stringify({ kind: "submit", actionId: "submit-1", hypothesisId: "h1" }), usage };
}

async function fixture(t: TestContext) {
 const root = await mkdtemp(path.join(os.tmpdir(), "pre-rsi-research-")); t.after(() => rm(root, { recursive: true, force: true }));
 await writeFile(path.join(root, "research.config.json"), JSON.stringify({ roles: { default: "fake/default", improver: "fake/improver", research: "fake/research" }, concurrency: 1 }));
 await writeFile(path.join(root, "development.json"), JSON.stringify(cpuCase("development", "dev-a")));
 await writeFile(path.join(root, "admission.json"), JSON.stringify(cpuCase("admission", "admit-b")));
 const runner = new FakeSessionRunner(fakeReply);
 const service = new ResearchImprovementService({ workspaceRoot: root, runner });
 await service.bootstrap({ version: 1, executor: { version: 1, kind: "cpu-numerical-prompt", body: "Submit a response hypothesis from visible observations." },
  improver: { version: 1, kind: "diagnostic-improver-prompt", body: "Choose a bounded diagnostic experiment and revise a scientific method when evidence supports it." }, applicability: ["cpu-response-identification"] });
 return { root, runner, service };
}

test("research-only campaign consumes real CPU feedback, saves an agent H candidate, and leaves active generation unchanged", async (t) => {
 const f = await fixture(t); const before = (await f.service.status()).active!.pointer.bundleId;
 const result = await f.service.run(plan());
 assert.equal(result.status, "research-only", result.stopReason ?? "");
 assert.ok(result.selectedCandidateId);
 assert.equal((await f.service.status()).active!.pointer.bundleId, before);
 assert.ok(result.feedback.some((x) => x.status === "observed" && x.evidence.length === 1));
 assert.ok(result.decisions.some((x) => x.action?.kind === "probe"));
 const candidate = await new GenerationStore(f.root).readStrategy(result.selectedCandidateId!);
 assert.equal(candidate.origin, "agent-generated");
 assert.equal(candidate.artifact.kind, "cpu-numerical-prompt");
 if (candidate.artifact.kind !== "cpu-numerical-prompt") throw new Error("fixture requires a CPU prompt method");
 const candidateBody = candidate.artifact.body;
 assert.ok(f.runner.created.some((x) => x.methodBinding?.versionId === candidate.versionId && x.systemPrompt.includes(candidateBody)));
});

test("executor-quality protocol may repair an underdetermined baseline without weakening mechanism-cost rules", async (t) => {
 const f = await fixture(t);
 const result = await f.service.run(plan("admission.json"));
 assert.equal(result.status, "promoted", `${result.stopReason}: ${JSON.stringify(result.decisions)}`);
 const admission = JSON.parse(await readFile(result.admissionPath!, "utf8"));
 assert.equal(admission.experimentKind, "executor-quality");
 assert.equal(admission.status, "accepted");
 assert.equal(admission.results.length, 4);
 assert.equal(admission.baselineAccepted, 0);
 assert.equal(admission.candidateAccepted, 2);
 assert.ok(admission.results.every((x: { episode: { feedback: Array<{ evidence: unknown[] }> } }) => x.episode.feedback.every((f) => f.evidence.length > 0)));
 assert.equal((await f.service.status()).active!.pointer.provenance, "local-executor-admission");
});

test("meta arms see separate development histories and select successors before G", async (t) => {
 const root = await mkdtemp(path.join(os.tmpdir(), "pre-rsi-meta-")); t.after(() => rm(root, { recursive: true, force: true }));
 await writeFile(path.join(root, "research.config.json"), JSON.stringify({ roles: { default: "fake/default", improver: "fake/improver", research: "fake/research" }, concurrency: 1 }));
 await writeFile(path.join(root, "development.json"), JSON.stringify(cpuCase("development", "dev-a")));
 await writeFile(path.join(root, "admission.json"), JSON.stringify(cpuCase("admission", "admit-b")));
 const knowledge = createFileKnowledgeStore(path.join(root, ".agent", "knowledge")); await knowledge.init();
 const proposal = await knowledge.submitProposal({ stage: "M04", runId: "shared-meta-experience", ops: [{ op: "create", type: "K", title: "诊断实验经验", body: "先读取可见测量再提出可证伪候选", usageDecision: "adopted",
  fields: { experience: { version: 1, targetKind: "improver", applicableStages: ["method-research"], requiredTags: ["cpu-response-identification"], excludedTags: [], requiredRefs: [] } } }] });
 assert.equal(proposal.structurallyValid, true); await knowledge.merge(proposal.proposalId);
 const sharedRef = { storeId: await knowledge.storeId(), recordId: "K001", version: 1 };
 const newArmPrompts: string[] = [];
 const branchPacks: string[] = [];
 const oldArmFeedbackIds = new Set<string>();
 const runner = new FakeSessionRunner((ctx) => {
  assert.deepEqual(ctx.spec.tools, { kind: "none" });
  if (ctx.spec.role === "research") {
   const input = JSON.parse(ctx.message);
   const body = ctx.spec.systemPrompt;
   const shouldProbe = body.includes("Probe every case") || body.includes("Probe only dev-a") && input.task.caseId === "dev-a";
   return { text: JSON.stringify(shouldProbe && input.visibleFeedback.length === 0 ? { kind: "probe", actionId: "p-1", x: 2 } : { kind: "submit", actionId: "s-1", hypothesisId: "h1" }), usage };
  }
  const view = JSON.parse(ctx.message.slice(ctx.message.indexOf("\n") + 1));
  const index = Number(ctx.spec.label.split("-").at(-1));
  const metaArm = ctx.spec.label.includes("-meta-") || ctx.spec.label.includes("-pilot-");
  if (ctx.spec.label.includes("-meta-")) branchPacks.push(JSON.stringify(view.experience));
  const isNew = ctx.spec.systemPrompt.includes("Prefer general discriminating probes");
  if (metaArm && !isNew) for (const feedback of view.feedback as Array<{ id: string }>) if (!feedback.id.startsWith("meta-") || feedback.id.includes("old")) oldArmFeedbackIds.add(feedback.id);
  if (metaArm && isNew) { newArmPrompts.push(ctx.message); assert.doesNotMatch(ctx.message, /Probe only dev-a/); for (const id of oldArmFeedbackIds) if (!id.startsWith("meta-")) assert.equal(ctx.message.includes(id), false); }
  if (!metaArm) {
   if (index === 0) return { text: JSON.stringify({ kind: "propose", target: "improver", body: "Prefer general discriminating probes in every new task.", hypothesis: { claim: "general probes improve selection", predictedObservation: "new successor survives other cases", falsifier: "new successor fails another case", applicability: ["cpu-response-identification"], motivatingEvidenceIds: [view.feedback[0].id] } }), usage };
   if (index === 1) return { text: JSON.stringify({ kind: "evaluate-development", candidateId: view.candidates[0].id }), usage };
   return { text: JSON.stringify({ kind: "stop", reason: "test the revised strategy", selectedCandidateId: view.candidates[0].id }), usage };
  }
  if (index === 0) return { text: JSON.stringify({ kind: "propose", target: "executor", body: isNew ? "Probe every case before choosing a response." : "Probe only dev-a before choosing a response.", hypothesis: { claim: "probe policy matters", predictedObservation: "a response becomes identifiable", falsifier: "probe does not distinguish", applicability: ["cpu-response-identification"], motivatingEvidenceIds: [view.feedback[0].id] } }), usage };
  if (index === 1) return { text: JSON.stringify({ kind: "evaluate-development", candidateId: view.candidates[0].id }), usage };
  return { text: JSON.stringify({ kind: "stop", reason: "select from development", selectedCandidateId: view.candidates[0].id }), usage };
 });
 const service = new ResearchImprovementService({ workspaceRoot: root, runner });
 await service.bootstrap({ version: 1, executor: { version: 1, kind: "cpu-numerical-prompt", body: "Submit from observed data." }, improver: { version: 1, kind: "diagnostic-improver-prompt", body: "Look for a local diagnostic." }, applicability: ["cpu-response-identification"] });
 const base = plan("admission.json");
 const meta: ResearchCampaignPlanV1 = { ...base, experimentKind: "meta-improvement", target: "improver", maxDecisions: 3, maxCandidates: 1, maxCandidatesPerMetaArm: 1,
  metaProtocol: "quality", searchReplicates: 1,
  experienceRefs: [sharedRef], experienceMaxRecords: 1, experienceMaxChars: 2_000,
  metaBranchBudget: { maxProviderCalls: 7, maxInputTokens: 180_000, maxSdkEstimatedCost: 1, maxProbeCalls: 7, maxCpuMillis: 20_000, maxWallMillis: 60_000 } };
 const result = await service.run(meta);
 assert.equal(result.status, "promoted", `${result.stopReason}: ${JSON.stringify(result.decisions)}`);
 assert.ok(newArmPrompts.length > 0);
 assert.ok(branchPacks.length >= 2); assert.equal(new Set(branchPacks).size, 1, "both meta arms receive the same frozen experience pack");
 assert.ok(branchPacks[0].includes("K001"));
 for (const candidate of result.candidates.filter((c) => c.branchPrefix?.startsWith("meta-"))) {
  const record = await new GenerationStore(root).readStrategy(candidate.strategyVersionId);
  assert.equal(record.sourceExperienceRefs[0]?.targetKind, "improver", "H successor records the real consulted I-pack role");
 }
 const report = JSON.parse(await readFile(result.admissionPath!, "utf8"));
 assert.equal(report.protectedQueriedAfterBothSelections, true);
 assert.equal(report.oldOutcome.status, "selected"); assert.equal(report.newOutcome.status, "selected");
 assert.equal(result.candidates.length, 4, "outer, pilot, old arm and new arm each receive their own candidate quota");
 assert.equal(report.protectedQuality.status, "accepted");
 const receipt = JSON.parse(await readFile(report.selectionReceiptPath, "utf8"));
 assert.ok(Date.parse(receipt.at) <= Date.parse(result.finishedAt!));
 const promotedI = (await service.status()).active!.bundle.improverVersionId;
 const childPlan: ResearchCampaignPlanV1 = { ...plan(), maxDecisions: 1, maxCandidates: 1, budget: { ...plan().budget, maxProviderCalls: 1 } };
 const script = `import { ResearchImprovementService } from ${JSON.stringify(pathToFileURL(path.resolve("src/improvement/research-service.ts")).href)};
import { FakeSessionRunner } from ${JSON.stringify(pathToFileURL(path.resolve("src/runner/fake.ts")).href)};
const [root, planRaw] = process.argv.slice(1); const plan = JSON.parse(planRaw);
const runner = new FakeSessionRunner((ctx) => { const view = JSON.parse(ctx.message.slice(ctx.message.indexOf("\\n") + 1)); return { text: JSON.stringify(view.candidates.length ? { kind: "stop", reason: "development evidence is insufficient" } : { kind: "propose", target: "executor", body: "Probe a fresh disambiguating point before selecting.", hypothesis: { claim: "new I can produce a new H", predictedObservation: "candidate is recorded", falsifier: "candidate cannot be constructed", applicability: ["cpu-response-identification"], motivatingEvidenceIds: [view.feedback[0].id] } }), usage: ${JSON.stringify(usage)} }; });
const service = new ResearchImprovementService({ workspaceRoot: root, runner }); const active = (await service.status()).active; const run = await service.run(plan);
process.stdout.write(JSON.stringify({ activeI: active.bundle.improverVersionId, decisionI: run.decisions[0]?.improverVersionId, candidateProducer: run.candidates[0]?.producedByImproverVersionId, origin: run.candidates[0]?.origin, status: run.status, bound: runner.created[0]?.methodBinding?.versionId, loaded: runner.created[0]?.systemPrompt.includes("Prefer general discriminating probes") }));`;
 const child = await execFileAsync(process.execPath, ["--input-type=module", "-e", script, root, JSON.stringify(childPlan)], { cwd: path.resolve("."), maxBuffer: 100_000 });
 const reentered = JSON.parse(child.stdout);
 assert.equal(reentered.activeI, promotedI); assert.equal(reentered.decisionI, promotedI); assert.equal(reentered.candidateProducer, promotedI);
 assert.equal(reentered.bound, promotedI); assert.equal(reentered.loaded, true); assert.equal(reentered.origin, "agent-generated"); assert.equal(reentered.status, "research-only");
});

test("quality protocol credits justified unknown only partially and requires a solved-case gain", async (t) => {
 const root = await mkdtemp(path.join(os.tmpdir(), "pre-rsi-unknown-")); t.after(() => rm(root, { recursive: true, force: true }));
 const identifiable = cpuCase("admission", "identifiable").cases[0];
 const unidentifiable = { ...cpuCase("admission", "unidentifiable").cases[0], hypotheses: [
  { id: "h1", formula: { kind: "affine" as const, slope: 1, intercept: 4 } },
  { id: "h2", formula: { kind: "quadratic" as const, coefficient: 1, intercept: 4 } },
 ], allowedProbeX: [1] };
 const runner = new FakeSessionRunner((ctx) => {
  const input = JSON.parse(ctx.message);
  const candidate = ctx.spec.systemPrompt.includes("Probe first");
  if (candidate && input.visibleFeedback.length === 0) return { text: JSON.stringify({ kind: "probe", actionId: "p", x: input.task.allowedProbeX[0] }), usage };
  if (input.task.caseId === "unidentifiable") return { text: JSON.stringify({ kind: "stop", actionId: "stop", reason: "public responses remain equivalent" }), usage };
  return { text: JSON.stringify({ kind: "submit", actionId: "submit", hypothesisId: "h1" }), usage };
 });
 const limits = plan().budget;
 const budget = new SharedBudget("unknown-quality", { ...limits, maxProviderCalls: 20 });
 const caseSet = validateCpuCaseSet({ version: 1, split: "admission", cases: [identifiable, unidentifiable] });
 const result = await runExecutorQualityAdmission({ caseSet, baseline: { versionId: "H0", artifact: { version: 1, kind: "cpu-numerical-prompt", body: "Submit immediately" } }, candidate: { versionId: "H1", artifact: { version: 1, kind: "cpu-numerical-prompt", body: "Probe first" } },
  runner, model: "fake/research", persistDir: root, budget, lease: budget.root, timeoutMs: 10_000, repetitions: 2,
  persistObservation: async () => ({ storeId: "test", id: "persisted", version: "1" }) });
 assert.equal(result.status, "accepted", result.reason);
 assert.equal(result.results.filter((r) => r.caseId === "unidentifiable" && r.arm === "candidate").every((r) => r.protectedStatus === "justified-unknown"), true);
 assert.equal(result.candidateAccepted, 2);
});
