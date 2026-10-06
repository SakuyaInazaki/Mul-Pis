import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { createFileKnowledgeStore } from "../src/knowledge/store.ts";
import { createM07Controller } from "../src/m07/controller.ts";
import { loadCaseSet } from "../src/improvement/admission.ts";
import { evaluateCandidate } from "../src/improvement/evaluator.ts";
import { collectProjectionHistory, ImprovementService } from "../src/improvement/service.ts";
import { DEFAULT_BUDGET_POLICY, loadActiveBudgetPolicy } from "../src/improvement/policy.ts";
import type { CampaignPlan, ImprovementProtocol } from "../src/improvement/types.ts";
import { FakeSessionRunner, type FakeReplyContext } from "../src/runner/fake.ts";
import { Workspace } from "../src/workspace.ts";

const candidate = { ...DEFAULT_BUDGET_POLICY, maxInlineFileChars: 35_000, maxAggregateInlineChars: 100_000 };
const execFileAsync = promisify(execFile);
const usage = (cost: number) => ({ input: 100, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 150, cost });
const hypothesis = { mechanism: "lower the single-file inline threshold", prediction: "historical M07 calls defer one more oversized item", falsifier: "no projection difference or paired mechanism regression", applicability: "text-only M07 materials", origin: "improver" };
const proposal = JSON.stringify({ hypothesis, policy: candidate });
const reasonedStop = JSON.stringify({ stop: "The latest duplicate adds no distinct candidate; stop this synthetic test run" });
function proposalUntilDuplicate(ctx: FakeReplyContext, proposed = proposal) {
 const history = JSON.parse(ctx.message).history as Array<{ failedGates?: string[] }>;
 return { text: history.some((attempt) => attempt.failedGates?.some((gate) => gate.includes("duplicate candidate"))) ? reasonedStop : proposed, usage: usage(0.05) };
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
async function seedRuntimeProjection(f: Awaited<ReturnType<typeof fixture>>, sizes = [10_000, 20_000, 30_000, 40_000, 50_000]) {
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

test("runtime UTF-16 projection survives replay and rejects a byte-only reduction", async (t) => {
 const f = await fixture(t, campaignReply);
 const goal = await f.controller.begin(begin);
 const file = path.join(f.root, "chinese-emoji.txt");
 await writeFile(file, "中文😀".repeat(8_000));
 await f.controller.delegate(goal.runId, { objective: "Read mixed text", inputs: [file], expectedOutputs: [], checks: ["read"], mode: "reason" });
 const history = await collectProjectionHistory(f.ws);
 assert.equal(history.samples.length, 1);
 assert.equal(history.samples[0].inputFileChars[0], 32_000);
 assert.ok(history.samples[0].inputUtf8Bytes > history.samples[0].inputChars);
 const protocol: ImprovementProtocol = { version: 2, objective: "reduce-observed-inline-payload", minimumReductionRatio: 0.1, maximumNewDeferredRatio: 0.35, minimumInlineCoverageRatio: 0.35, requireManifestCoverage: true, allowedCandidate: "budget-policy-only", baselinePolicy: DEFAULT_BUDGET_POLICY, ...history, createdAt: new Date().toISOString() };
 const screened = evaluateCandidate(protocol, candidate);
 assert.equal(screened.passed, false);
 assert.equal(screened.reductionRatio, 0);
 const noChange = evaluateCandidate(protocol, { ...candidate, maxInlineFileChars: 45_000 });
 assert.equal(noChange.passed, false);
 assert.equal(noChange.reductionRatio, 0);
});

test("run requires an explicit experimental plan and does not call a model", async (t) => {
 const f = await fixture(t, campaignReply);
 await assert.rejects(f.service.run(), (error: unknown) => (error as { code?: string }).code === "improvement.plan-required");
 assert.equal(f.runner.created.length, 0);
});

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

test("controller-owned paired local mechanism checks can promote one policy", async (t) => {
 const f = await fixture(t, campaignReply); await seedRuntimeProjection(f);
 const cases = await caseFile(f.root);
 assert.equal((await loadCaseSet(cases)).split, "admission");
 const result = await f.service.run(plan(cases));
 assert.equal(result.run.status, "promoted");
 assert.equal(result.run.attempts[0].status, "promoted");
 assert.deepEqual(await loadActiveBudgetPolicy(f.root), candidate);
 const admission = JSON.parse(await readFile(result.run.admissionPath!, "utf8"));
 assert.equal(admission.status, "accepted");
 assert.equal(admission.scope, "local-mechanism-projection-readback");
 assert.equal(admission.costSource, "sdk-estimate");
 assert.equal(admission.results.length, 4);
 assert.equal(admission.trialCalls, 6);
 assert.deepEqual(admission.results.map((r: {arm: string}) => r.arm), ["baseline", "candidate", "candidate", "baseline"]);
 assert.ok(result.run.campaignUsage!.cost > admission.baselineCost + admission.candidateCost, "proposer cost remains in the campaign ledger");
});

test("a historical total-cost field cannot stop a paired mechanism experiment", async (t) => {
 const f = await fixture(t, campaignReply); await seedRuntimeProjection(f); const cases = await caseFile(f.root);
 const result = await f.service.run({ ...plan(cases), maxTotalCost: 0.001 });
 assert.equal(result.run.status, "promoted");
 assert.ok(result.run.campaignUsage!.cost > 0.001);
 assert.doesNotMatch(await readFile(result.run.planPath!, "utf8"), /maxTotalCost/);
 const admission = JSON.parse(await readFile(result.run.admissionPath!, "utf8"));
 assert.equal(admission.status, "accepted");
 assert.equal(admission.inFlightBudgetMayExceed, undefined);
});

test("missing proposer cost stays unknown in ledger without blocking priced paired evidence", async (t) => {
 const f = await fixture(t, (ctx) => ctx.spec.role === "improver" ? proposal : campaignReply(ctx));
 await seedRuntimeProjection(f); const cases = await caseFile(f.root);
 const result = await f.service.run(plan(cases));
 assert.equal(result.run.status, "promoted");
 assert.equal(result.run.campaignUsage?.complete, false);
 assert.equal(result.run.campaignUsage?.usageSettlement, "pending-or-unknown");
});

test("mechanism readback can exceed a legacy cumulative limit while retaining material bounds", async (t) => {
 const f = await fixture(t, (ctx) => {
  if (ctx.spec.role === "improver") return proposalUntilDuplicate(ctx);
  if (ctx.spec.label.includes("mechanism-") && ctx.turnIndex === 1) return { text: JSON.stringify({ claim: "Need a registered range", conditions: [], evidence: [], readRequests: [{ materialId: "A", start: 0, end: 11_000 }] }), usage: usage(ctx.spec.label.endsWith("baseline") ? 0.5 : 0.1) };
  if (ctx.spec.label.includes("mechanism-")) return { text: JSON.stringify({ claim: "ANSWER-TAG", conditions: [], evidence: [{ materialId: "A", start: 0, end: 11_000 }] }), usage: usage(ctx.spec.label.endsWith("baseline") ? 0.5 : 0.1) };
  return { text: "synthetic M07 task returned", usage: usage(0.01) };
 });
 await seedRuntimeProjection(f); const cases = await caseFile(f.root);
 const result = await f.service.run({ ...plan(cases), maxReadbackChars: 1 });
 assert.equal(result.run.status, "promoted", result.run.stopReason ?? "");
 const admission = JSON.parse(await readFile(result.run.admissionPath!, "utf8"));
 assert.equal(admission.readbackChars, 44_000);
 assert.equal(admission.readbackUtf8Bytes, 44_000);
 assert.deepEqual(admission.results.map((arm: { readback: unknown[] }) => arm.readback.length), [1, 1, 1, 1]);
 assert.doesNotMatch(await readFile(result.run.planPath!, "utf8"), /maxReadbackChars/);
});

test("mechanism case-set file still respects its byte-size boundary", async (t) => {
 const f = await fixture(t, campaignReply);
 const file = path.join(f.root, "oversized-case-set.json");
 await writeFile(file, "x".repeat(2_000_001));
 await assert.rejects(loadCaseSet(file), /exceeds 2 MB/);
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

test("legacy active version exports with downgraded provenance", async (t) => {
 const f = await fixture(t, campaignReply);
 const versionDir = path.join(f.root, ".agent", "improvement", "versions", "legacy-version");
 await mkdir(versionDir, { recursive: true });
 await writeFile(path.join(versionDir, "policy.json"), JSON.stringify(candidate));
 await writeFile(path.join(f.root, ".agent", "improvement", "active.json"), JSON.stringify({ version: 1, versionId: "legacy-version", promotedAt: new Date().toISOString(), runId: "old" }));
 assert.equal((await f.service.status()).activeProvenance, "legacy-projection-only");
 const pkg = await f.service.exportMethodPackage("legacy-version", "historical threshold", path.join(f.root, "legacy-export.json"));
 assert.equal(pkg.provenance, "legacy-projection-only");
});

test("residual mutation lock fails closed", async (t) => {
 const f = await fixture(t, campaignReply);
 const lock = path.join(f.root, ".agent", "improvement", "mutation.lock");
 await mkdir(lock, { recursive: true }); await writeFile(path.join(lock, "owner.json"), JSON.stringify({ pid: 999999 }));
 await assert.rejects(f.service.run(plan()), (error: unknown) => (error as { code?: string }).code === "improvement.locked");
});

test("no observed text projection exits without calling the proposer", async (t) => {
 const f = await fixture(t, campaignReply);
 const result = await f.service.run(plan());
 assert.equal(result.run.status, "inconclusive");
 assert.match(result.run.stopReason ?? "", /no replayable M07 text projection opportunity/);
 assert.equal(f.runner.created.length, 0);
});

test("development cases may diagnose but cannot authorize promotion", async (t) => {
 const f = await fixture(t, campaignReply); await seedRuntimeProjection(f);
 const cases = await caseFile(f.root);
 const parsed = JSON.parse(await readFile(cases, "utf8")); parsed.split = "development"; await writeFile(cases, JSON.stringify(parsed));
 const result = await f.service.run(plan(cases));
 assert.equal(result.run.status, "inconclusive");
 assert.match(result.run.attempts[0].reason ?? "", /development case/);
 assert.deepEqual(await loadActiveBudgetPolicy(f.root), DEFAULT_BUDGET_POLICY);
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

test("zero trigger stays inconclusive while a legacy trial-call quota cannot block admission", async (t) => {
 const noTrigger = await fixture(t, campaignReply); await seedRuntimeProjection(noTrigger);
 const noTriggerCases = await caseFile(noTrigger.root);
 const parsed = JSON.parse(await readFile(noTriggerCases, "utf8")); parsed.cases[0].materials[0].text = "x".repeat(20_000); await writeFile(noTriggerCases, JSON.stringify(parsed));
 const noTriggerRun = await noTrigger.service.run(plan(noTriggerCases));
 assert.equal(noTriggerRun.run.status, "inconclusive");
 assert.match(noTriggerRun.run.attempts[0].reason ?? "", /did not trigger/);
 const exhausted = await fixture(t, campaignReply); await seedRuntimeProjection(exhausted);
 const cases = await caseFile(exhausted.root);
 const limited = { ...plan(cases), maxTrialCalls: 1 };
 const limitedRun = await exhausted.service.run(limited);
 assert.equal(limitedRun.run.status, "promoted");
 assert.ok((limitedRun.run.campaignUsage?.trialCalls ?? 0) > 1);
 assert.notDeepEqual(await loadActiveBudgetPolicy(exhausted.root), DEFAULT_BUDGET_POLICY);
});

test("duplicate candidate is feedback before the model explicitly stops", async (t) => {
 const f = await fixture(t, (ctx) => {
  if (ctx.spec.role === "improver" && ctx.spec.label.endsWith("-2")) {
   const message = JSON.parse(ctx.message);
   assert.equal(message.history[0].hypothesis.mechanism, hypothesis.mechanism);
   assert.equal(message.history[0].policy.maxInlineFileChars, 35_000);
   assert.equal(message.history[0].failureClass, "evidence-or-trigger");
   assert.doesNotMatch(ctx.message, /CHECKER-SECRET|ANSWER-TAG/);
  }
  return campaignReply(ctx);
 }); await seedRuntimeProjection(f);
 const cases = await caseFile(f.root);
 const noTrigger = JSON.parse(await readFile(cases, "utf8")); noTrigger.cases[0].materials[0].text = "x".repeat(20_000);
 await writeFile(cases, JSON.stringify(noTrigger));
 const result = await f.service.run({ ...plan(cases), maxCandidates: 2, maxTotalCost: 0.001 });
 assert.equal(result.run.status, "inconclusive");
 assert.ok(result.run.attempts.length >= 2);
 assert.match(result.run.attempts[1].reason ?? "", /duplicate candidate/);
 assert.match(result.run.attempts[2].reason ?? "", /improver stopped/);
 assert.doesNotMatch(result.run.stopReason ?? "", /duplicate candidate/);
 assert.ok((result.run.campaignUsage?.proposerCalls ?? 0) >= 2);
 assert.deepEqual(result.run.attempts[1].historyConsumed, [`${result.run.runId}#1`]);
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

test("an older attempt remains inspectable after more than twenty historical runs", async (t) => {
 let oldestId = "";
 const f = await fixture(t, async (ctx) => {
  if (ctx.spec.role !== "improver") return campaignReply(ctx);
  const view = JSON.parse(ctx.message);
  assert.equal(view.historyWindow.total, 21);
  assert.equal(view.historyWindow.visible, 3);
  assert.equal(view.historyWindow.omitted, 18);
  assert.doesNotMatch(ctx.message, /earliest-attempt-fact/);
  let start = 0, content = "";
  while (start !== null) {
   const response = JSON.parse((await ctx.tools.history_read({ start, maxChars: 4000 })).text);
   content += response.text;
   start = response.nextStart;
  }
  const frozen = JSON.parse(content);
  assert.equal(frozen.attempts.length, 21);
  assert.equal(frozen.attempts[0].id, `${oldestId}#1`);
  assert.equal(frozen.attempts[0].hypothesis.mechanism, "earliest-attempt-fact");
  return { text: JSON.stringify({ stop: "The oldest attempt already explored this mechanism" }), usage: usage(0.05) };
 });
 await seedRuntimeProjection(f);
 const runsDir = path.join(f.root, ".agent", "improvement", "runs");
 for (let i = 0; i < 21; i++) {
  const runId = `202609${String(i + 1).padStart(2, "0")}T000000Z-${String(i).padStart(6, "0")}`;
  if (i === 0) oldestId = runId;
  const dir = path.join(runsDir, runId); await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "run.json"), JSON.stringify({ version: 2, runId, status: "rejected", startedAt: new Date(2026, 8, i + 1).toISOString(), baselineVersionId: "builtin-default", protocolPath: "", baselinePath: "", attempts: [{ index: 1, status: "rejected", historyConsumed: [], hypothesis: { ...hypothesis, mechanism: i === 0 ? "earliest-attempt-fact" : `later-attempt-${i}` } }] }));
 }
 const result = await f.service.run(plan());
 assert.equal(result.run.status, "inconclusive");
 assert.equal(result.run.attempts[0].historyAvailableCount, 21);
 assert.equal(result.run.attempts[0].historyConsumed.length, 3);
 assert.ok(result.run.attempts[0].historyReadbackRanges!.length > 0);
 assert.ok(result.run.attempts[0].historyReadbackRanges!.some((range) => range.start === 0));
 const saved = JSON.parse(await readFile(path.join(path.dirname(result.run.protocolPath), "run.json"), "utf8"));
 assert.deepEqual(saved.attempts[0].historyReadbackRanges, result.run.attempts[0].historyReadbackRanges);
});

test("improver can explicitly stop without a monetary or count gate", async (t) => {
 const f = await fixture(t, (ctx) => ctx.spec.role === "improver" ? { text: JSON.stringify({ stop: "No distinct policy is supported by these projections" }), usage: usage(0.05) } : campaignReply(ctx));
 await seedRuntimeProjection(f);
 const result = await f.service.run({ ...plan(), maxTotalCost: 0 });
 assert.equal(result.run.status, "inconclusive");
 assert.equal(result.run.attempts.length, 1);
 assert.match(result.run.stopReason ?? "", /No distinct policy/);
 assert.deepEqual(await loadActiveBudgetPolicy(f.root), DEFAULT_BUDGET_POLICY);
});

test("long valid hypothesis and stop reason are preserved without response-text caps", async (t) => {
 const longText = "Detailed mechanism evidence. ".repeat(250);
 const longHypothesis = { ...hypothesis, mechanism: longText, prediction: longText, falsifier: longText, applicability: longText };
 const proposed = await fixture(t, (ctx) => ctx.spec.role === "improver" ? { text: JSON.stringify({ hypothesis: longHypothesis, policy: candidate }), usage: usage(0.05) } : campaignReply(ctx));
 await seedRuntimeProjection(proposed);
 const result = await proposed.service.run({ ...plan(), maxReadbackChars: "obsolete" as unknown as number });
 assert.equal(result.run.status, "inconclusive");
 assert.equal(result.run.attempts[0].hypothesis?.mechanism, longText);
 assert.equal(result.run.attempts[0].hypothesis?.prediction, longText);
 assert.equal(result.run.attempts[0].hypothesis?.falsifier, longText);
 assert.equal(result.run.attempts[0].hypothesis?.applicability, longText);
 const stopped = await fixture(t, (ctx) => ctx.spec.role === "improver" ? { text: JSON.stringify({ stop: longText }), usage: usage(0.05) } : campaignReply(ctx));
 await seedRuntimeProjection(stopped);
 const stopResult = await stopped.service.run(plan());
 assert.equal(stopResult.run.status, "inconclusive");
 assert.equal(stopResult.run.attempts[0].reason, `improver stopped: ${longText}`);
});

test("a progressing proposer is not aborted by a legacy elapsed-time quota", async (t) => {
 const f = await fixture(t, campaignReply); await seedRuntimeProjection(f);
 const delayed = new FakeSessionRunner(async (ctx) => { await new Promise((resolve) => setTimeout(resolve, 30)); return campaignReply(ctx); });
 const service = new ImprovementService({ workspaceRoot: f.root, runner: delayed });
 const result = await service.run({ ...plan(), timeoutMs: 1 });
 assert.equal(result.run.status, "inconclusive");
 assert.equal(result.run.campaignUsage?.proposerCalls, 1);
 assert.deepEqual(await loadActiveBudgetPolicy(f.root), DEFAULT_BUDGET_POLICY);
});


test("mixed paired costs remain inconclusive even when total cost falls", async (t) => {
 const f = await fixture(t, (ctx) => {
  if (ctx.spec.role === "improver") return proposalUntilDuplicate(ctx);
  if (ctx.spec.label.includes("mechanism-") && ctx.spec.label.includes("-r1-candidate")) {
   if (ctx.turnIndex === 1) return { text: JSON.stringify({ claim: "Need range", conditions: [], evidence: [], readRequests: [{ materialId: "A", start: 0, end: 1 }] }), usage: usage(0.3) };
   return { text: JSON.stringify({ claim: "ANSWER-TAG", conditions: [], evidence: [{ materialId: "A", start: 0, end: 1 }] }), usage: usage(0.3) };
  }
  return campaignReply(ctx);
 });
 await seedRuntimeProjection(f); const cases = await caseFile(f.root);
 const result = await f.service.run(plan(cases));
 assert.equal(result.run.status, "inconclusive");
 assert.match(result.run.attempts[0].reason ?? "", /cost increased/);
 assert.deepEqual(await loadActiveBudgetPolicy(f.root), DEFAULT_BUDGET_POLICY);
});

test("one admission repetition is insufficient and starts no proposer", async (t) => {
 const f = await fixture(t, campaignReply); await seedRuntimeProjection(f); const cases = await caseFile(f.root);
 const before = f.runner.created.length;
 const result = await f.service.run({ ...plan(cases), repetitions: 1 });
 assert.equal(result.run.status, "inconclusive");
 assert.match(result.run.stopReason ?? "", /at least two/);
 assert.equal(f.runner.created.length, before);
});

test("unreplayed prompt and feedback caps cannot win by shrinking", async (t) => {
 const altered = { ...candidate, maxPromptChars: 100_000, maxFeedbackChars: 4_000 };
 const f = await fixture(t, (ctx) => ctx.spec.role === "improver" ? proposalUntilDuplicate(ctx, JSON.stringify({ hypothesis, policy: altered })) : campaignReply(ctx));
 await seedRuntimeProjection(f);
 const result = await f.service.run(plan());
 assert.equal(result.run.attempts[0].status, "rejected");
 const evaluation = JSON.parse(await readFile(result.run.evaluationPath!, "utf8"));
 assert.equal(evaluation.gates.find((g: {name: string}) => g.name === "unreplayed-caps-frozen").passed, false);
 assert.deepEqual(await loadActiveBudgetPolicy(f.root), DEFAULT_BUDGET_POLICY);
});

test("second generation cannot cross the absolute inline coverage floor", async (t) => {
 const f = await fixture(t, campaignReply); await seedRuntimeProjection(f); const cases = await caseFile(f.root);
 assert.equal((await f.service.run(plan(cases))).run.status, "promoted");
 const tooDeferred = { ...candidate, maxInlineFileChars: 25_000 };
 const second = new ImprovementService({ workspaceRoot: f.root, runner: new FakeSessionRunner((ctx) => ctx.spec.role === "improver" ? proposalUntilDuplicate(ctx, JSON.stringify({ hypothesis, policy: tooDeferred })) : campaignReply(ctx)) });
 const result = await second.run(plan());
 assert.equal(result.run.attempts[0].status, "rejected");
 const evaluation = JSON.parse(await readFile(result.run.evaluationPath!, "utf8"));
 assert.equal(evaluation.gates.find((g: {name: string}) => g.name === "absolute-inline-coverage").passed, false);
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

test("active pointer remains authoritative if the final run status write was interrupted", async (t) => {
 const f = await fixture(t, campaignReply); await seedRuntimeProjection(f); const cases = await caseFile(f.root);
 const result = await f.service.run(plan(cases));
 const runFile = path.join(path.dirname(result.run.protocolPath), "run.json");
 await writeFile(runFile, JSON.stringify({ ...result.run, status: "candidate-ready", finishedAt: undefined }));
 const visible = (await f.service.status()).runs.find((run) => run.runId === result.run.runId);
 assert.equal(visible?.status, "promoted"); assert.ok(visible?.finishedAt);
});

test("policy schema and active pointer reject unknown fields and traversal", async (t) => {
 const { validateBudgetPolicy } = await import("../src/improvement/policy.ts");
 assert.throws(() => validateBudgetPolicy({ ...DEFAULT_BUDGET_POLICY, evaluator: "replace" }), /未知字段/);
 assert.throws(() => validateBudgetPolicy({ ...DEFAULT_BUDGET_POLICY, maxInlineFileChars: DEFAULT_BUDGET_POLICY.maxAggregateInlineChars + 1 }), /不能大于/);
 const f = await fixture(t, campaignReply);
 const active = path.join(f.root, ".agent", "improvement", "active.json"); await mkdir(path.dirname(active), { recursive: true });
 await writeFile(active, JSON.stringify({ version: 1, versionId: "../escape", promotedAt: new Date().toISOString(), runId: "x" }));
 await assert.rejects(loadActiveBudgetPolicy(f.root), /active.json 字段无效/);
});

test("rollback does not lift an active knowledge restriction", async (t) => {
 const f = await fixture(t, campaignReply); await seedRuntimeProjection(f); const cases = await caseFile(f.root);
 assert.equal((await f.service.run(plan(cases))).run.status, "promoted");
 const store = createFileKnowledgeStore(f.ws.knowledgeDir); await store.init();
 let receipt = await store.submitProposal({ stage: "test", runId: "r1", ops: [{ op: "create", type: "C", title: "synthetic claim", body: "synthetic body", usageDecision: "candidate" }] });
 assert.equal(receipt.structurallyValid, true); await store.merge(receipt.proposalId);
 receipt = await store.submitProposal({ stage: "test", runId: "r2", ops: [{ op: "limit", target: "C001", kind: "suspended", reason: "needs independent check", authority: "reviewer" }] });
 assert.equal(receipt.structurallyValid, true); await store.merge(receipt.proposalId);
 assert.equal((await store.availability("C001")).availability, "not_allowed");
 await f.service.rollback();
 assert.equal((await store.availability("C001")).availability, "not_allowed");
});

test("past candidate is blocked only under the same frozen obligation", async (t) => {
 const f = await fixture(t, campaignReply); await seedRuntimeProjection(f);
 assert.equal((await f.service.run(plan())).run.status, "inconclusive");
 const repeated = await f.service.run(plan());
 assert.equal(repeated.run.attempts[0].status, "rejected");
 assert.match(repeated.run.attempts[0].reason ?? "", /duplicate candidate/);
 await seedRuntimeProjection(f, [10_000]);
 const renewed = await f.service.run(plan());
 assert.equal(renewed.run.status, "inconclusive");
 assert.match(renewed.run.attempts[0].reason ?? "", /projection screen only/);
});
