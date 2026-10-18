import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { createFileKnowledgeStore } from "../src/knowledge/store.ts";
import { createM07Controller } from "../src/m07/controller.ts";
import { ImprovementService } from "../src/improvement/service.ts";
import { pairedStatistics } from "../src/improvement/admission.ts";
import { DEFAULT_BUDGET_POLICY, loadActiveBudgetPolicy } from "../src/improvement/policy.ts";
import type { CampaignPlan } from "../src/improvement/types.ts";
import { FakeSessionRunner, type FakeReplyContext } from "../src/runner/fake.ts";
import { Workspace } from "../src/workspace.ts";

const candidate = { ...DEFAULT_BUDGET_POLICY, maxInlineFileChars: 35_000, maxAggregateInlineChars: 100_000 };
const execFileAsync = promisify(execFile);
const usage = (cost: number) => ({ input: 100, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 150, cost });
const hypothesis = { mechanism: "lower the single-file inline threshold", prediction: "historical M07 calls defer one more oversized item", falsifier: "no projection difference or paired mechanism regression", applicability: "text-only M07 materials", origin: "improver" };
const proposal = JSON.stringify({ hypothesis, policy: candidate });
const reasonedStop = JSON.stringify({ stop: "The latest duplicate adds no distinct candidate; stop this synthetic test run" });
function proposalUntilDuplicate(ctx: FakeReplyContext) {
 const history = JSON.parse(ctx.message).history as Array<{ failedGates?: string[] }>;
 return { text: history.some((attempt) => attempt.failedGates?.some((gate) => gate.includes("duplicate candidate"))) ? reasonedStop : proposal, usage: usage(0.05) };
}
const plan = (caseSetPath?: string): CampaignPlan => ({ version: 1, maxCandidates: 1, maxTrialCalls: caseSetPath ? 8 : 0, repetitions: 2, maxReadbackChars: caseSetPath ? 100 : 0, maxTotalInputTokens: 10_000, maxTotalOutputTokens: 1, timeoutMs: 10_000, ...(caseSetPath ? { caseSetPath } : {}) });
const begin = { goal: "检查材料", problemRelation: "与原问题一致", constraints: ["保持证据"], successCriteria: ["明确结论"], plan: "逐项检查", exploratory: true };

async function fixture(t: TestContext, reply: (ctx: FakeReplyContext) => string | { text: string; usage: ReturnType<typeof usage> } | Promise<string | { text: string; usage: ReturnType<typeof usage> }>) {
 const root = await mkdtemp(path.join(os.tmpdir(), "pre-rsi-improvement-"));
 t.after(async () => rm(root, { recursive: true, force: true }));
 const ws = new Workspace(root);
 await mkdir(path.dirname(ws.problemFile), { recursive: true });
 await writeFile(ws.problemFile, "A public synthetic mechanism task.\n");
 await writeFile(ws.configFile, JSON.stringify({ roles: { default: "fake/user-selected-model", improver: "fake/user-selected-improver", research: "fake/user-selected-research" }, concurrency: 1 }));
 const config = await ws.loadConfig();
 const runner = new FakeSessionRunner(reply);
 const controller = createM07Controller({ ws, runner, config, store: createFileKnowledgeStore(ws.knowledgeDir) });
 const service = new ImprovementService({ workspaceRoot: root, runner, now: () => new Date("2026-09-23T00:00:00.000Z") });
 return { root, ws, runner, controller, service };
}
async function seedRuntimeProjection(f: Awaited<ReturnType<typeof fixture>>) {
 const sizes = [10_000, 20_000, 30_000, 40_000, 50_000];
 const goal = await f.controller.begin(begin);
 const inputs: string[] = [];
 for (const [index, size] of sizes.entries()) {
  const file = path.join(f.root, `synthetic-${index}.txt`);
  await writeFile(file, "x".repeat(size)); inputs.push(file);
 }
 await f.controller.delegate(goal.runId, { objective: "Read a synthetic evidence set", inputs, expectedOutputs: [], checks: ["read evidence"], mode: "reason" });
 return goal;
}

function campaignReply(ctx: FakeReplyContext) {
 if (ctx.spec.role === "improver") {
  assert.equal(ctx.spec.tools.kind, "custom");
  assert.deepEqual(ctx.spec.tools.tools.map((tool) => tool.name), ["history_read"]);
  assert.doesNotMatch(ctx.message, /CHECKER-SECRET|ANSWER-TAG|private-input/);
  return proposalUntilDuplicate(ctx);
 }
 if (ctx.spec.label.includes("mechanism-")) {
  assert.deepEqual(ctx.spec.tools, { kind: "none" });
  assert.doesNotMatch(ctx.message, /CHECKER-SECRET|ANSWER-TAG|requiredEvidence|requiredConditions/);
  if (ctx.spec.label.endsWith("candidate") && ctx.turnIndex === 1) return { text: JSON.stringify({ claim: "Need range", conditions: [], evidence: [], readRequests: [{ materialId: "A", start: 0, end: 1 }] }), usage: usage(0.1) };
  return { text: JSON.stringify({ claim: "ANSWER-TAG", conditions: [], evidence: [{ materialId: "A", start: 0, end: 1 }] }), usage: usage(ctx.spec.label.endsWith("baseline") ? 0.5 : 0.1) };
 }
 return { text: "synthetic M07 task returned", usage: usage(0.01) };
}
async function caseFile(root: string) {
 const file = path.join(root, "case-set.json");
 await writeFile(file, JSON.stringify({ version: 1, split: "admission", cases: [{ id: "case-a", question: "Return the answer tag after reading the evidence range you need.", materials: [{ id: "A", text: "x".repeat(40_000) }], checker: { requiredConditions: [], requiredEvidence: [{ materialId: "A", start: 0, end: 1 }], forbiddenClaims: ["CHECKER-SECRET"], requiredAnswerTerms: ["ANSWER-TAG"] } }] }));
 return file;
}

test("projection screen without admission case ends inconclusive and keeps active policy", async (t) => {
 const f = await fixture(t, campaignReply); await seedRuntimeProjection(f);
 const result = await f.service.run(plan());
 assert.doesNotMatch(await readFile(result.run.planPath!, "utf8"), /maxTotalOutputTokens/);
 assert.doesNotMatch(await readFile(result.run.planPath!, "utf8"), /maxTotalCost/);
 assert.equal(result.run.status, "inconclusive");
 assert.equal(result.run.attempts[0].status, "inconclusive");
 assert.match(result.run.attempts[0].reason ?? "", /projection screen only/);
 assert.deepEqual(await loadActiveBudgetPolicy(f.root), DEFAULT_BUDGET_POLICY);
});


test("method export and manual bind move policy without case or knowledge data", async (t) => {
 const f = await fixture(t, campaignReply); await seedRuntimeProjection(f); const cases = await caseFile(f.root);
 const promoted = await f.service.run(plan(cases));
 const target = await fixture(t, campaignReply); const oldGoal = await target.controller.begin(begin);
 const output = path.join(f.root, "public-method.json");
 const pkg = await f.service.exportMethodPackage(promoted.activeVersionId!, "synthetic text input", output);
 assert.equal(pkg.provenance, "local-mechanism-admission");
 const text = await readFile(output, "utf8");
 assert.doesNotMatch(text, /CHECKER-SECRET|ANSWER-TAG|case-a|synthetic-0|pre-rsi-improvement-/);
 const pointer = await target.service.bindMethodPackage(output);
 assert.equal(pointer.provenance, "external-manual-unverified");
 assert.deepEqual(await loadActiveBudgetPolicy(target.root), candidate);
 const newService = new ImprovementService({ workspaceRoot: target.root, runner: target.runner });
 assert.equal((await newService.status()).activeProvenance, "external-manual-unverified");
 const methodUrl = new URL("../src/improvement/method.ts", import.meta.url).href;
 const child = await execFileAsync(process.execPath, ["--input-type=module", "-e", `import { loadActiveMethodBinding } from ${JSON.stringify(methodUrl)}; console.log(JSON.stringify(await loadActiveMethodBinding(process.argv[1])));`, target.root]);
 assert.equal(JSON.parse(child.stdout).versionId, pointer.versionId, "a fresh process loads the imported method version");
 const newGoal = await target.controller.begin(begin);
 assert.equal(oldGoal.budgetPolicyVersionId, "builtin-default");
 assert.equal(newGoal.budgetPolicyVersionId, pointer.versionId);
 assert.deepEqual(newGoal.budgetPolicy, candidate);
 const rollback = await target.service.rollback();
 assert.equal(rollback.versionId, "builtin-default");
 assert.equal((await target.controller.status(newGoal.runId)).budgetPolicyVersionId, pointer.versionId);
});

test("failed mechanical checks reject, and missing usage is inconclusive", async (t) => {
 const wrong = await fixture(t, (ctx) => ctx.spec.role === "improver" ? proposalUntilDuplicate(ctx) : { text: JSON.stringify({ claim: "wrong", conditions: [], evidence: [] }), usage: usage(0.2) });
 await seedRuntimeProjection(wrong); const wrongCases = await caseFile(wrong.root);
 const rejected = await wrong.service.run(plan(wrongCases));
 assert.equal(rejected.run.attempts[0].status, "rejected");
 assert.equal(rejected.run.status, "inconclusive", "the synthetic proposer explicitly stops after duplicate feedback");
 assert.match(rejected.run.attempts[1].reason ?? "", /duplicate candidate/);
 assert.match(rejected.run.attempts[2].reason ?? "", /improver stopped/);
 assert.deepEqual(await loadActiveBudgetPolicy(wrong.root), DEFAULT_BUDGET_POLICY);
 const missing = await fixture(t, (ctx) => ctx.spec.role === "improver" ? proposalUntilDuplicate(ctx) : JSON.stringify({ claim: "ANSWER-TAG", conditions: [], evidence: [{ materialId: "A", start: 0, end: 1 }] }));
 await seedRuntimeProjection(missing); const missingCases = await caseFile(missing.root);
 const inconclusive = await missing.service.run(plan(missingCases));
 assert.equal(inconclusive.run.status, "inconclusive");
 assert.match(inconclusive.run.attempts[0].reason ?? "", /incomplete provider usage/);
});

test("a duplicate proposal does not stop a later distinct feasible candidate", async (t) => {
 const first = { ...candidate, maxInlineFileChars: 45_000 };
 const f = await fixture(t, (ctx) => {
  if (ctx.spec.role !== "improver") return campaignReply(ctx);
  const attempt = Number(ctx.spec.label.split("-").at(-1));
  return { text: JSON.stringify({ hypothesis, policy: attempt < 3 ? first : candidate }), usage: usage(0.05) };
 });
 await seedRuntimeProjection(f); const cases = await caseFile(f.root);
 const result = await f.service.run(plan(cases));
 assert.equal(result.run.attempts[0].status, "rejected");
 assert.equal(result.run.attempts[1].status, "rejected");
 assert.match(result.run.attempts[1].reason ?? "", /duplicate candidate/);
 assert.equal(result.run.attempts[2].status, "promoted");
 assert.equal(result.run.status, "promoted");
 assert.deepEqual(await loadActiveBudgetPolicy(f.root), candidate);
});

test("concurrent services allow only one mutation", async (t) => {
 let release!: () => void; let entered!: () => void;
 const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
 const hold = new Promise<void>((resolve) => { release = resolve; });
 const f = await fixture(t, async (ctx) => { if (ctx.spec.role === "improver") { entered(); await hold; return { text: proposal, usage: usage(0.05) }; } return campaignReply(ctx); });
 await seedRuntimeProjection(f);
 const first = f.service.run(plan()); await enteredPromise;
 const second = new ImprovementService({ workspaceRoot: f.root, runner: new FakeSessionRunner(campaignReply) });
 await assert.rejects(second.run(plan()), (error: unknown) => ["improvement.busy", "improvement.locked"].includes((error as {code?: string}).code ?? ""));
 release(); assert.equal((await first).run.status, "inconclusive");
});

test("promotion compares active pointer with frozen baseline before commit", async (t) => {
 let root = "";
 const f = await fixture(t, async (ctx) => {
  if (ctx.spec.role === "improver") {
   const versionDir = path.join(root, ".agent", "improvement", "versions", "external-version");
   await mkdir(versionDir, { recursive: true });
   await writeFile(path.join(versionDir, "policy.json"), JSON.stringify(DEFAULT_BUDGET_POLICY));
   await writeFile(path.join(root, ".agent", "improvement", "active.json"), JSON.stringify({ version: 1, versionId: "external-version", promotedAt: new Date().toISOString(), runId: "external-run" }));
   return { text: proposal, usage: usage(0.05) };
  }
  return campaignReply(ctx);
 });
 root = f.root; await seedRuntimeProjection(f); const cases = await caseFile(f.root);
 await assert.rejects(f.service.run(plan(cases)), (error: unknown) => (error as {code?: string}).code === "improvement.stale-baseline");
 assert.equal((await f.service.status()).activeVersionId, "external-version");
});

test("the exact sign test excludes ties and reports the n it is based on", () => {
 assert.deepEqual(pairedStatistics([]), { n: 0, candidateCheaper: 0, candidateCostlier: 0, tied: 0, signTestTwoSidedP: null });
 assert.deepEqual(pairedStatistics([0, 0]), { n: 0, candidateCheaper: 0, candidateCostlier: 0, tied: 2, signTestTwoSidedP: null });
 // Five one-directional pairs: 2 * (1/2^5) = 0.0625.
 const oneSided = pairedStatistics([-1, -2, -3, -4, -5]);
 assert.deepEqual([oneSided.n, oneSided.candidateCheaper, oneSided.candidateCostlier, oneSided.tied], [5, 5, 0, 0]);
 assert.equal(oneSided.signTestTwoSidedP, 0.0625);
 // One reversal in six: 2 * (1 + 6) / 2^6 = 0.21875; ties stay out of n.
 const mixed = pairedStatistics([-1, -1, -1, -1, -1, 2, 0]);
 assert.deepEqual([mixed.n, mixed.candidateCheaper, mixed.candidateCostlier, mixed.tied], [6, 5, 1, 1]);
 assert.equal(mixed.signTestTwoSidedP, 0.21875);
 assert.equal(pairedStatistics([-1, 1]).signTestTwoSidedP, 1);
});

test("admission records the model, token budget, headroom and paired statistic, and status reports the write-back rate", async (t) => {
 const f = await fixture(t, campaignReply); await seedRuntimeProjection(f); const cases = await caseFile(f.root);
 const promoted = await f.service.run(plan(cases));
 assert.equal(promoted.run.status, "promoted");
 const admission = JSON.parse(await readFile(promoted.run.admissionPath!, "utf8")) as {
  model: string; baselineTokens: number; candidateTokens: number;
  headroom: { cases: number; triggeredCases: number; untriggeredCaseIds: string[] };
  paired: { n: number; candidateCheaper: number; candidateCostlier: number; tied: number; signTestTwoSidedP: number | null };
 };
 assert.equal(admission.model, "fake/user-selected-research");
 // Two arms x two repetitions, each arm reporting 100 input and 50 output tokens.
 assert.equal(admission.baselineTokens, 300);
 assert.ok(admission.candidateTokens > 0);
 assert.deepEqual(admission.headroom, { cases: 1, triggeredCases: 1, untriggeredCaseIds: [] });
 assert.equal(admission.paired.n, 2);
 assert.equal(admission.paired.candidateCheaper, 2);
 assert.equal(admission.paired.candidateCostlier, 0);
 assert.equal(admission.paired.signTestTwoSidedP, 0.5);
 const status = await f.service.status();
 assert.equal(status.admissionRate.promoted, 1);
 assert.equal(status.admissionRate.attempts, status.admissionRate.promoted + status.admissionRate.rejected + status.admissionRate.inconclusive + status.admissionRate.other);
 assert.equal(status.admissionRate.rate, status.admissionRate.promoted / status.admissionRate.attempts);
});
