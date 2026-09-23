import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import test, { type TestContext } from "node:test";
import { ResearchImprovementService } from "../src/improvement/research-service.ts";
import { GenerationStore } from "../src/improvement/generation.ts";
import { fullyReadDevelopmentFeedbackIds, validateResearchAction, type ResearchInspectionResultV1 } from "../src/improvement/policy-host.ts";
import type { ResearchCampaignPlanV1 } from "../src/improvement/research-types.ts";
import { FakeSessionRunner, type FakeReplyContext } from "../src/runner/fake.ts";
import { SharedBudget } from "../src/experiments/budget.ts";
import { runExecutorQualityAdmission } from "../src/improvement/executor-eval.ts";
import { publicResearchRun, publicResearchStatus } from "../src/improvement/research-public.ts";
import { validateCpuCaseSet } from "../src/experiments/local-environment.ts";
import { runMetaImprovementAdmission } from "../src/improvement/meta-eval.ts";
import { loadMetaEpisode } from "../src/improvement/meta-episode.ts";
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
 ...(admissionCaseSetPath ? { admissionCaseSetPath, perPromptMaxInputTokens: 20_000, searchReplicates: 1, outcomeReplicates: 2,
  outerBudget: { maxProviderCalls: 8, maxInputTokens: 160_000, maxOutputTokens: 16_384, maxSdkEstimatedCost: 1, maxProbeCalls: 5, maxCpuMillis: 10_000, maxWallMillis: 60_000 },
  pilotBudget: { maxProviderCalls: 5, maxInputTokens: 100_000, maxOutputTokens: 10_240, maxSdkEstimatedCost: 1, maxProbeCalls: 3, maxCpuMillis: 10_000, maxWallMillis: 60_000 },
  protectedBudget: { maxProviderCalls: 12, maxInputTokens: 240_000, maxOutputTokens: 24_576, maxSdkEstimatedCost: 2, maxProbeCalls: 8, maxCpuMillis: 10_000, maxWallMillis: 60_000 } } : {}),
 maxDecisions: 4, maxCandidates: 2, admissionRepetitions: 2, maxFeedbackItems: 8, perPromptTimeoutMs: 10_000, perPromptMaxOutputTokens: 2_048,
 budget: { maxProviderCalls: 80, maxInputTokens: 1_000_000, maxOutputTokens: 200_000, maxSdkEstimatedCost: 10, maxProbeCalls: 80, maxCpuMillis: 100_000, maxWallMillis: 500_000 },
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
 assert.equal(result.status, "research-only", result.stopReason);
 assert.ok(result.selectedCandidateId);
 assert.equal((await f.service.status()).active!.pointer.bundleId, before);
 assert.ok(result.feedback.some((x) => x.status === "observed" && x.evidence.length === 1));
 assert.ok(result.decisions.some((x) => x.action?.kind === "probe"));
 const candidate = await new GenerationStore(f.root).readStrategy(result.selectedCandidateId!);
 assert.equal(candidate.origin, "agent-generated");
 assert.ok(f.runner.created.some((x) => x.methodBinding?.versionId === candidate.versionId && x.systemPrompt.includes(candidate.artifact.body)));
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

test("controller rejects a candidate that cites non-visible development evidence", () => {
 const view = { version: 1, target: "executor", current: { bundleId: "b", executorVersionId: "h", improverVersionId: "i" }, task: { allowedProbeX: [2] }, feedback: [{ id: "visible" }], candidates: [] } as unknown as Parameters<typeof validateResearchAction>[1];
 assert.throws(() => validateResearchAction({ kind: "propose", target: "executor", body: "A method", hypothesis: { claim: "A", predictedObservation: "B", falsifier: "C", applicability: [], motivatingEvidenceIds: ["hidden"] } }, view), /unavailable/);
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
  metaBranchBudget: { maxProviderCalls: 7, maxInputTokens: 180_000, maxOutputTokens: 14_336, maxSdkEstimatedCost: 1, maxProbeCalls: 7, maxCpuMillis: 20_000, maxWallMillis: 60_000 } };
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
const runner = new FakeSessionRunner((ctx) => { const view = JSON.parse(ctx.message.slice(ctx.message.indexOf("\\n") + 1)); return { text: JSON.stringify({ kind: "propose", target: "executor", body: "Probe a fresh disambiguating point before selecting.", hypothesis: { claim: "new I can produce a new H", predictedObservation: "candidate is recorded", falsifier: "candidate cannot be constructed", applicability: ["cpu-response-identification"], motivatingEvidenceIds: [view.feedback[0].id] } }), usage: ${JSON.stringify(usage)} }; });
const service = new ResearchImprovementService({ workspaceRoot: root, runner }); const active = (await service.status()).active; const run = await service.run(plan);
process.stdout.write(JSON.stringify({ activeI: active.bundle.improverVersionId, decisionI: run.decisions[0]?.improverVersionId, candidateProducer: run.candidates[0]?.producedByImproverVersionId, origin: run.candidates[0]?.origin, status: run.status, bound: runner.created[0]?.methodBinding?.versionId, loaded: runner.created[0]?.systemPrompt.includes("Prefer general discriminating probes") }));`;
 const child = await execFileAsync(process.execPath, ["--input-type=module", "-e", script, root, JSON.stringify(childPlan)], { cwd: path.resolve("."), maxBuffer: 100_000 });
 const reentered = JSON.parse(child.stdout);
 assert.equal(reentered.activeI, promotedI); assert.equal(reentered.decisionI, promotedI); assert.equal(reentered.candidateProducer, promotedI);
 assert.equal(reentered.bound, promotedI); assert.equal(reentered.loaded, true); assert.equal(reentered.origin, "agent-generated"); assert.equal(reentered.status, "inconclusive", "decision exhaustion cannot be counted as a settled no-winner");
});

test("meta refuses identical selected H bodies before any protected query", async () => {
 const limits = { ...plan().budget, maxProviderCalls: 10 };
 const budget = new SharedBudget("meta-same-body", limits);
 let protectedSelection = 0;
 const oldLease = budget.createLease(budget.root, limits), newLease = budget.createLease(budget.root, limits), protectedLease = budget.createLease(budget.root, limits);
 const result = await runMetaImprovementAdmission({ oldImproverVersionId: "I0", newImproverVersionId: "I1",
  initialExecutor: { versionId: "H0", artifact: { version: 1, kind: "cpu-numerical-prompt", body: "initial" } },
  branchLeases: [{ old: oldLease, new: newLease }], protectedLease, protocol: "quality", searchReplicates: 1, outcomeReplicates: 2,
  developmentCaseSet: validateCpuCaseSet(cpuCase("development", "dev-a")), admissionCaseSet: validateCpuCaseSet(cpuCase("admission", "admit-b")), budget,
  produceSuccessor: async (versionId) => ({ improverVersionId: versionId, startingExecutorVersionId: "H0", selectedExecutor: { versionId: versionId === "I0" ? "HA" : "HB", artifact: { version: 1, kind: "cpu-numerical-prompt", body: "same body" } }, selectedAt: new Date().toISOString(), decisionCount: 1, status: "selected" }),
  runner: new FakeSessionRunner(() => { throw new Error("G must not run"); }), researchModel: "fake/research", persistDir: "/tmp", timeoutMs: 10_000, maxInputTokens: 10_000, maxOutputTokens: 2_048,
  persistSelection: async () => { protectedSelection++; return "unused"; }, persistObservation: async () => { throw new Error("G must not persist"); } });
 assert.equal(result.status, "rejected"); assert.match(result.reason, /same executable H/); assert.equal(result.protectedQueriedAfterBothSelections, false); assert.equal(protectedSelection, 1);
});

test("one-decision I handoff reads only a matching persisted development world and no G", async (t) => {
 const f = await fixture(t);
 const priorDir = path.join(f.root, "l5-pilot-synthetic"); await mkdir(priorDir);
 const frozen = cpuCase("development", "dev-a").cases[0];
 const observed = { x: 2, y: 6, xUnit: "s", yUnit: "m", source: "probe" };
 const ref = { storeId: "l5-pilot-synthetic/observations.jsonl", id: "1", version: "1" };
 const feedback = { version: 1, id: "prior-observed", startId: "prior-start", actionId: "p1", status: "observed", observations: [observed], remainingProbeCalls: 0, checks: [], evidence: [ref], visibility: "development" };
 await writeFile(path.join(priorDir, "private-case.json"), JSON.stringify(frozen));
 await writeFile(path.join(priorDir, "observations.jsonl"), `${JSON.stringify({ index: 1, start: { caseId: "dev-a", environmentVersion: "cpu-response-identification/v1" }, feedback })}\n`);
 await writeFile(path.join(priorDir, "visible-feedback.json"), JSON.stringify({ version: 1, caseId: "dev-a", methodVersionId: "H-prior", developmentFeedback: [feedback], claimBoundary: "development only" }));
 let calls = 0;
 const runner = new FakeSessionRunner((ctx) => {
  calls++;
  const view = JSON.parse(ctx.message.slice(ctx.message.indexOf("\n") + 1));
  assert.equal(view.target, "improver"); assert.deepEqual(view.historicalFeedbackIds, ["prior-observed"]);
  assert.ok(view.feedback.some((f: { id: string; observations: unknown[] }) => f.id === "prior-observed" && f.observations.length === 1));
  assert.doesNotMatch(ctx.message, /truthHypothesisId|private-case|protectedEvaluator/);
  return { text: JSON.stringify({ kind: "stop", reason: "current feedback does not yet justify a new I candidate" }), usage };
 });
 const service = new ResearchImprovementService({ workspaceRoot: f.root, runner });
 const base = plan();
 const one: ResearchCampaignPlanV1 = { ...base, experimentKind: "meta-improvement", target: "improver", priorDevelopmentFeedbackPath: "l5-pilot-synthetic/visible-feedback.json", maxDecisions: 1, maxCandidates: 1,
  pilotBudget: { maxProviderCalls: 1, maxInputTokens: 20_000, maxOutputTokens: 2_048, maxSdkEstimatedCost: 0.1, maxProbeCalls: 0, maxCpuMillis: 1_000, maxWallMillis: 10_000 },
  budget: { ...base.budget, maxProviderCalls: 1 } };
 const run = await service.run(one);
 assert.equal(run.status, "research-only", run.stopReason); assert.equal(calls, 1);
 assert.equal(run.priorDevelopmentSource?.feedbackIds[0], "prior-observed");
 assert.equal(Object.hasOwn(publicResearchRun(run), "admissionPath"), false);
 assert.equal(publicResearchStatus(await service.status()).active?.provenance, "human-seed");
 const altered = { ...frozen, truthHypothesisId: "h2" };
 await writeFile(path.join(priorDir, "private-case.json"), JSON.stringify(altered));
 const rejected = await service.run(one); assert.equal(rejected.status, "failed"); assert.equal(calls, 1);
 await writeFile(path.join(priorDir, "private-case.json"), JSON.stringify(frozen));
 await writeFile(path.join(priorDir, "visible-feedback.json"), JSON.stringify({ version: 1, caseId: "dev-a", methodVersionId: "H-prior", developmentFeedback: [{ ...feedback, evidence: [{ ...ref, storeId: "forged-store" }] }], claimBoundary: "development only" }));
 const badRef = await service.run(one); assert.equal(badRef.status, "failed"); assert.equal(calls, 1);
});

test("I can probe and inspect a second registered case without losing its control facts", async (t) => {
 const f = await fixture(t);
 const set = cpuCase("development", "dev-a"); set.cases.push({ ...cpuCase("development", "dev-b").cases[0], id: "dev-b" });
 await writeFile(path.join(f.root, "development.json"), JSON.stringify(set));
 const runner = new FakeSessionRunner((ctx) => {
  const view = JSON.parse(ctx.message.slice(ctx.message.indexOf("\n") + 1));
  assert.deepEqual(view.cases.map((c: { caseId: string }) => c.caseId), ["dev-a", "dev-b"]);
  const index = Number(ctx.spec.label.split("-").at(-1));
  if (index === 0) return { text: JSON.stringify({ kind: "probe", caseId: "dev-b", x: 2, rationale: "inspect the second case" }), usage };
  if (index === 1) { assert.equal(view.cases[1].probeCalls, 1); return { text: JSON.stringify({ kind: "inspect", read: { object: "development-feedback", caseId: "dev-b", index: 1, start: 0, maxChars: 4_000 } }), usage }; }
  assert.equal(view.inspections[0].caseId, "dev-b"); assert.equal(view.inspections[0].start, 0); assert.equal(view.inspections[0].end, view.inspections[0].totalChars);
  assert.ok(view.inspections[0].text.includes("observed"));
  return { text: JSON.stringify({ kind: "stop", reason: "evidence gathered without a justified candidate" }), usage };
 });
 const service = new ResearchImprovementService({ workspaceRoot: f.root, runner });
 const run = await service.run({ ...plan(), maxDecisions: 3 });
 assert.equal(run.status, "research-only", run.stopReason);
 assert.equal(run.inspections?.length, 1); assert.equal(run.decisions[1].inspectionId, run.inspections?.[0].requestId);
 assert.equal(run.inspections?.[0].methodBindingVersionId, run.frozenBundle.improverVersionId);
});

test("feedback above one page is citable only after contiguous controller readback", () => {
 const span = (start: number, end: number): ResearchInspectionResultV1 => ({ requestId: `r-${start}`, object: "development-feedback", id: "long-feedback", caseId: "dev-b", start, end, totalChars: 5_100, text: "x".repeat(end - start) });
 const claim = { kind: "propose", target: "executor", body: "A bounded diagnostic method.", hypothesis: { claim: "probe separates", predictedObservation: "one response remains", falsifier: "multiple remain", applicability: [], motivatingEvidenceIds: ["long-feedback"] } };
 const view = { version: 1, target: "executor", current: { bundleId: "b", executorVersionId: "h", improverVersionId: "i" }, task: { caseId: "dev-a", allowedProbeX: [2] }, feedback: [], candidates: [], experience: { markdown: "", refs: [] } } as unknown as Parameters<typeof validateResearchAction>[1];
 view.readableEvidenceIds = fullyReadDevelopmentFeedbackIds([span(0, 4_000), span(4_001, 5_100)]);
 assert.deepEqual(view.readableEvidenceIds, []); assert.throws(() => validateResearchAction(claim, view), /unavailable/);
 view.readableEvidenceIds = fullyReadDevelopmentFeedbackIds([span(4_000, 5_100), span(0, 4_000)]);
 assert.deepEqual(view.readableEvidenceIds, ["long-feedback"]); assert.equal(validateResearchAction(claim, view).kind, "propose");
});

test("same-workspace development MetaEpisode is inspectable and citable without protected data", async (t) => {
 const f = await fixture(t);
 const first = await f.service.run(plan()); assert.equal(first.status, "research-only");
 const stored = await loadMetaEpisode(new GenerationStore(f.root).root, f.root, first.runId);
 assert.equal(stored.phase, "development"); assert.equal(stored.terminal, "selected");
 assert.ok(stored.decisions.some((d) => d.kind === "propose"));
 await assert.rejects(loadMetaEpisode(new GenerationStore(f.root).root, path.join(f.root, "other"), first.runId), /cross-workspace/);
 const runner = new FakeSessionRunner((ctx) => {
  const view = JSON.parse(ctx.message.slice(ctx.message.indexOf("\n") + 1));
  assert.equal(view.metaEpisodes[0].id, `meta:${first.runId}`);
  if (ctx.spec.label.endsWith("-0")) return { text: JSON.stringify({ kind: "inspect", read: { object: "meta-episode", id: `meta:${first.runId}`, start: 0, maxChars: 4_000 } }), usage };
  assert.equal(view.inspections[0].object, "meta-episode"); assert.doesNotMatch(view.inspections[0].text, /truthHypothesisId|protectedQuality|admissionCaseSetPath/);
  return { text: JSON.stringify({ kind: "propose", target: "executor", body: "Use the observed episode to choose a bounded diagnostic probe.",
   hypothesis: { claim: "development episode suggests a probe", predictedObservation: "the probe separates responses", falsifier: "it does not separate them", applicability: ["cpu-response-identification"], motivatingEvidenceIds: [`meta:${first.runId}`] } }), usage };
 });
 const run = await new ResearchImprovementService({ workspaceRoot: f.root, runner }).run({ ...plan(), maxDecisions: 2, metaEpisodeRunIds: [first.runId] });
 assert.equal(run.status, "inconclusive", "maxDecisions exhaustion is not a no-winner");
 assert.deepEqual(run.candidates[0].hypothesis.motivatingEvidenceIds, [`meta:${first.runId}`]);
 const episodeFile = path.join(new GenerationStore(f.root).root, "runs", first.runId, "meta-episode.development.json");
 const altered = JSON.parse(await readFile(episodeFile, "utf8")); altered.candidates[0].hypothesis.claim = "protected-evaluator-sentinel";
 await writeFile(episodeFile, JSON.stringify(altered));
 await assert.rejects(loadMetaEpisode(new GenerationStore(f.root).root, f.root, first.runId), /does not match/);
});

test("schema repair is explicit, bounded, and debited as another provider request", async (t) => {
 const f = await fixture(t); let calls = 0;
 const runner = new FakeSessionRunner(() => { calls++; return { text: calls === 1 ? "not JSON" : JSON.stringify({ kind: "stop", reason: "insufficient evidence" }), usage }; });
 const run = await new ResearchImprovementService({ workspaceRoot: f.root, runner }).run({ ...plan(), maxDecisions: 1, schemaRepairAttempts: 1, budget: { ...plan().budget, maxProviderCalls: 2 } });
 assert.equal(run.status, "research-only"); assert.equal(calls, 2); assert.equal(run.decisions[0].repairAttempts, 1);
 assert.equal(run.decisions[0].repairSessionIds?.length, 2); assert.equal((run.budgetAtEnd as { committed: { providerCalls: number } }).committed.providerCalls, 2);
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
  runner, model: "fake/research", persistDir: root, budget, lease: budget.root, timeoutMs: 10_000, repetitions: 2, maxOutputTokens: 2_048,
  persistObservation: async () => ({ storeId: "test", id: "persisted", version: "1" }) });
 assert.equal(result.status, "accepted", result.reason);
 assert.equal(result.results.filter((r) => r.caseId === "unidentifiable" && r.arm === "candidate").every((r) => r.protectedStatus === "justified-unknown"), true);
 assert.equal(result.candidateAccepted, 2);
});
