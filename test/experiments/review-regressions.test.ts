import assert from "node:assert/strict";
import test from "node:test";
import { SharedBudget } from "../../src/experiments/budget.ts";
import { reserveResearchPhases } from "../../src/experiments/budget-preflight.ts";
import { createCpuResponseEnvironment, type CpuResponseCase } from "../../src/experiments/local-environment.ts";
import { FakeSessionRunner } from "../../src/runner/fake.ts";

const limits = { maxProviderCalls: 100, maxInputTokens: 400_000, maxOutputTokens: 400_000, maxSdkEstimatedCost: 2, maxProbeCalls: 100, maxCpuMillis: 100_000, maxWallMillis: 200_000 };
const multi: CpuResponseCase = { id: "two-step", version: 1, truthHypothesisId: "truth", hypotheses: [
 { id: "truth", formula: { kind: "affine", slope: 1, intercept: 0 } },
 { id: "wrong-a", formula: { kind: "quadratic", coefficient: 1, intercept: 0 } },
 { id: "wrong-b", formula: { kind: "quadratic", coefficient: 0.5, intercept: 0 } },
], initialX: [0], allowedProbeX: [1, 2], maxProbeCalls: 2, tolerance: 0.001, units: { x: "s", y: "m" } };

test("finite CPU reference classifies initial, multi-step and budget-limited uncertainty", async () => {
 const budget = new SharedBudget("reference", limits);
 const env = createCpuResponseEnvironment(multi, budget);
 assert.equal((await env.development.healthCheck()).classification, "multi-step");
 assert.equal((await env.development.healthCheck()).usable, true);
 const s = await env.development.prepare("multi");
 await assert.rejects(env.development.runProbe(s, { kind: "probe", actionId: "closed.1", x: 1, extra: "untrusted" } as never, budget.root), /invalid or oversized/);
 assert.equal((await env.development.runProbe(s, { kind: "probe", actionId: "probe.1", x: 1 }, budget.root)).status, "observed");
 await env.development.stop(s, { kind: "stop", actionId: "stop.1", reason: "uncertain" });
 assert.equal((await env.protectedEvaluator.evaluateStop(s, budget.root)).status, "premature-stop");
 const solved = createCpuResponseEnvironment({ ...multi, id: "initial", initialX: [0, 1, 2] }, new SharedBudget("initial", limits));
 assert.equal((await solved.development.healthCheck()).classification, "initially-resolved");
 assert.equal((await solved.development.healthCheck()).usable, true);
 const bounded = createCpuResponseEnvironment({ ...multi, id: "bounded", maxProbeCalls: 1 }, new SharedBudget("bounded", limits));
 assert.equal((await bounded.development.healthCheck()).classification, "not-identifiable-within-budget");
 assert.equal((await bounded.development.healthCheck()).usable, true);
 const b = await bounded.development.prepare("bounded");
 await bounded.development.stop(b, { kind: "stop", actionId: "stop.1", reason: "no resolving probe within budget" });
 assert.equal((await bounded.protectedEvaluator.evaluateStop(b)).status, "justified-unknown");
});

test("dormant branch clocks and paused pilot exclude waiting while root elapsed remains real", () => {
 const realNow = Date.now; let now = 1_000_000; Date.now = () => now;
 try {
  const budget = new SharedBudget("clocks", limits);
  const old = budget.createLease(budget.root, { ...limits, maxWallMillis: 60_000 });
  const newer = budget.createLease(budget.root, { ...limits, maxWallMillis: 60_000 });
  const pilot = budget.createLease(budget.root, { ...limits, maxWallMillis: 30_000 }, { clockMode: "active" });
  budget.activateLease(old); now += 45_000;
  assert.equal(budget.status(old).remaining.wallMillis, 15_000);
  assert.equal(budget.status(newer).remaining.wallMillis, 60_000);
  assert.equal(budget.status(budget.root).remaining.wallMillis, 155_000);
  budget.activateLease(pilot); now += 5_000; budget.pauseLease(pilot); now += 40_000;
  assert.equal(budget.status(pilot).remaining.wallMillis, 25_000);
  assert.equal(budget.status(newer).remaining.wallMillis, 60_000);
  assert.equal(budget.status(budget.root).remaining.wallMillis, 110_000);
 } finally { Date.now = realNow; }
});

test("phase preflight refuses insufficient G output before spend and seals disjoint pools", async () => {
 const runner = new FakeSessionRunner(() => "unused");
 const stage = { ...limits, maxProviderCalls: 2, maxInputTokens: 20_000, maxOutputTokens: 8_192, maxSdkEstimatedCost: 0.1, maxProbeCalls: 2, maxCpuMillis: 5_000, maxWallMillis: 10_000 };
 const budget = new SharedBudget("short", limits);
 const base = { kind: "meta-improvement" as const, outer: stage, pilot: stage, branch: stage, protected: { ...limits, maxProviderCalls: 24, maxInputTokens: 240_000, maxOutputTokens: 98_304, maxSdkEstimatedCost: 0.5, maxProbeCalls: 0, maxCpuMillis: 10_000, maxWallMillis: 20_000 }, searchReplicates: 2, outcomeReplicates: 2, admissionCases: [{ maxProbeCalls: 2 }], perPromptMaxInputTokens: 10_000, perPromptMaxOutputTokens: 4_096, runner, researchModel: "fake/research" };
 await assert.rejects(reserveResearchPhases(budget, { ...base, protected: { ...base.protected, maxOutputTokens: 98_303 } }), /protected maxOutputTokens/);
 assert.equal(budget.status().committed.providerCalls, 0);
 await assert.rejects(reserveResearchPhases(budget, { ...base, protected: { ...base.protected, maxInputTokens: 239_999 } }), /protected maxInputTokens/);
 const unpriced = new FakeSessionRunner(() => "unused");
 unpriced.estimateMaxSdkCost = async () => undefined;
 await assert.rejects(reserveResearchPhases(budget, { ...base, runner: unpriced }), /price is unavailable/);
 assert.equal(budget.status().committed.providerCalls, 0);
 // An independent roomy root can reserve all stages before any request.
 const roomy = new SharedBudget("roomy", { ...limits, maxProviderCalls: 40, maxInputTokens: 360_000, maxOutputTokens: 150_000, maxSdkEstimatedCost: 2, maxProbeCalls: 20, maxCpuMillis: 50_000, maxWallMillis: 100_000 });
 const phases = await reserveResearchPhases(roomy, base);
 assert.equal(phases.branches.length, 2);
 assert.equal(phases.protectedMaxProviderCalls, 24);
 assert.throws(() => roomy.reservePrompt(roomy.root, { maxInputTokens: 1, maxOutputTokens: 1, maxSdkEstimatedCost: 0.01 }), /direct root/);
 assert.throws(() => roomy.createLease(roomy.root), /sealed/);
});

test("meta search freezes alternating settled no-winner arms before G and permits only measured efficiency", async (t) => {
 const { mkdtemp, rm } = await import("node:fs/promises");
 const path = await import("node:path");
 const os = await import("node:os");
 const { runMetaImprovementAdmission } = await import("../../src/improvement/meta-eval.ts");
 const dir = await mkdtemp(path.join(os.tmpdir(), "meta-review-")); t.after(() => rm(dir, { recursive: true, force: true }));
 const budget = new SharedBudget("meta-review", { ...limits, maxProviderCalls: 100 });
 const armLimits = { ...limits, maxProviderCalls: 2, maxInputTokens: 2000, maxOutputTokens: 200, maxSdkEstimatedCost: 0.1, maxProbeCalls: 2, maxCpuMillis: 1000, maxWallMillis: 60_000 };
 const branchLeases = Array.from({ length: 2 }, () => ({ old: budget.createLease(budget.root, armLimits), new: budget.createLease(budget.root, armLimits) }));
 const protectedLease = budget.createLease(budget.root, { ...limits, maxProviderCalls: 20 });
 const events: string[] = [];
 const runner = new FakeSessionRunner((ctx) => {
  events.push("G");
  const prompt = JSON.parse(ctx.message);
  return { text: JSON.stringify(prompt.visibleFeedback.length ? { kind: "submit", actionId: "submit.1", hypothesisId: "truth" } : { kind: "probe", actionId: "probe.1", x: 2 }),
   usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 120, cost: 0.001 } };
 });
 const caseSet = (split: "development" | "admission") => ({ version: 1 as const, split, cases: [{ ...multi, id: `${split}-case`, hypotheses: multi.hypotheses.slice(0, 2), maxProbeCalls: 1, allowedProbeX: [2] }] });
 const result = await runMetaImprovementAdmission({ oldImproverVersionId: "I0", newImproverVersionId: "I1", initialExecutor: { versionId: "H0", artifact: { version: 1, kind: "cpu-numerical-prompt", body: "Identify the mechanism from evidence." } },
  developmentCaseSet: caseSet("development"), admissionCaseSet: caseSet("admission"), budget, branchLeases, protectedLease,
  protocol: "efficiency", searchReplicates: 2, outcomeReplicates: 2, runner, researchModel: "fake/research", persistDir: dir, timeoutMs: 10_000, maxOutputTokens: 512, maxInputTokens: 12_000,
  produceSuccessor: async (id, lease, _cases, index, arm) => {
   events.push(`search-${index}-${arm}`);
   const reservation = budget.reservePrompt(lease, { maxInputTokens: 1000, maxOutputTokens: 100, maxSdkEstimatedCost: 0.1 });
   budget.settlePrompt(reservation, { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 20, cost: arm === "old" ? 0.02 : 0.01, reportedEvents: 1, unknownEvents: 0, complete: true, costComplete: true });
   return { improverVersionId: id, startingExecutorVersionId: "H0", decisionCount: 1, status: "no-winner" };
  },
  persistSelection: async (repeats) => { events.push("freeze"); assert.equal(repeats.length, 2); return path.join(dir, "frozen.json"); },
  persistObservation: async () => ({ storeId: "test-ledger", id: "1", version: "1" }) });
 assert.equal(result.status, "accepted", result.reason);
 assert.deepEqual(events.slice(0, 5), ["search-0-old", "search-0-new", "search-1-new", "search-1-old", "freeze"]);
 assert.equal(events.slice(5).every((e) => e === "G"), true);
 assert.equal(result.replicates.length, 2);
 assert.equal(result.replicates.every((r) => r.oldSearchSdkEstimatedCost > r.newSearchSdkEstimatedCost), true);
 assert.equal(result.budgetSettlement, "settled");
});

test("quality protocol rejects identical no-winner H0 without a protected request", async () => {
 const { runMetaImprovementAdmission } = await import("../../src/improvement/meta-eval.ts");
 const budget = new SharedBudget("quality-same", limits);
 const branchLeases = [{ old: budget.createLease(budget.root), new: budget.createLease(budget.root) }];
 const protectedLease = budget.createLease(budget.root);
 let frozen = 0;
 const caseSet = (split: "development" | "admission") => ({ version: 1 as const, split, cases: [{ ...multi, id: `${split}-same` }] });
 const result = await runMetaImprovementAdmission({ oldImproverVersionId: "I0", newImproverVersionId: "I1", initialExecutor: { versionId: "H0", artifact: { version: 1, kind: "cpu-numerical-prompt", body: "Evidence first." } },
  developmentCaseSet: caseSet("development"), admissionCaseSet: caseSet("admission"), budget, branchLeases, protectedLease, protocol: "quality", searchReplicates: 1, outcomeReplicates: 2,
  produceSuccessor: async (id) => ({ improverVersionId: id, startingExecutorVersionId: "H0", decisionCount: 1, status: "no-winner" }),
  runner: new FakeSessionRunner(() => { throw new Error("protected G must not run"); }), researchModel: "fake/research", persistDir: "/tmp", timeoutMs: 1000, maxOutputTokens: 512, maxInputTokens: 12_000,
  persistSelection: async () => { frozen++; return "private-selection-receipt"; }, persistObservation: async () => { throw new Error("protected G must not run"); } });
 assert.equal(result.status, "rejected");
 assert.equal(result.protectedQueriedAfterBothSelections, false);
 assert.equal(frozen, 1);
});
