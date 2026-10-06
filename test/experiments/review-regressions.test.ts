import assert from "node:assert/strict";
import test from "node:test";
import { SharedBudget } from "../../src/experiments/budget.ts";
import { reserveResearchPhases } from "../../src/experiments/budget-preflight.ts";
import { createCpuResponseEnvironment, type CpuResponseCase } from "../../src/experiments/local-environment.ts";
import { FakeSessionRunner } from "../../src/runner/fake.ts";
import { prepareModelRequest, runBoundedModelStep } from "../../src/improvement/research-model.ts";
import { runExecutorEpisode } from "../../src/improvement/executor-eval.ts";

const limits = { maxProviderCalls: 100, maxInputTokens: 400_000, maxSdkEstimatedCost: 2, maxProbeCalls: 100, maxCpuMillis: 100_000, maxWallMillis: 200_000 };
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

test("branch activation and pilot pause remain lifecycle controls without elapsed-time quotas", () => {
 const realNow = Date.now; let now = 1_000_000; Date.now = () => now;
 try {
  const budget = new SharedBudget("lifecycle", { ...limits, maxWallMillis: 0 });
  const old = budget.createLease(budget.root, { ...limits, maxWallMillis: 0 });
  const newer = budget.createLease(budget.root, { ...limits, maxWallMillis: 0 });
  const pilot = budget.createLease(budget.root, { ...limits, maxWallMillis: 0 }, { clockMode: "active" });
  budget.activateLease(old); now += 1_000_000_000;
  assert.equal(budget.status(old).lifecycle, "running");
  assert.equal(budget.status(newer).lifecycle, "allocated");
  assert.deepEqual(budget.status().remaining, { sdkEstimatedCost: limits.maxSdkEstimatedCost });
  budget.activateLease(pilot); budget.pauseLease(pilot); now += 1_000_000_000;
  assert.equal(budget.status(pilot).lifecycle, "allocated");
  budget.activateLease(pilot);
  assert.equal(budget.status(pilot).lifecycle, "running");
  budget.reserveProbe(old);
  assert.equal(budget.status(old).committed.probeCalls, 1);
 } finally { Date.now = realNow; }
});

test("completed branch closes independently while in-flight work remains open", () => {
 const budget = new SharedBudget("closed-branches", { ...limits, maxWallMillis: 0 });
 const cap = { ...limits, maxWallMillis: 0 };
 const old = budget.createLease(budget.root, cap), newer = budget.createLease(budget.root, cap);
 budget.activateLease(old);
 const receipt = budget.closeLease(old);
 assert.equal(receipt.lifecycle, "closed");
 assert.deepEqual(receipt.remaining, { sdkEstimatedCost: cap.maxSdkEstimatedCost });
 budget.activateLease(newer);
 assert.equal(budget.status(old).lifecycle, "closed");
 assert.equal(budget.status(newer).lifecycle, "running");
 assert.throws(() => budget.reserveProbe(old), /closed/);
 assert.throws(() => budget.activateLease(old), /closed/);
 const pending = budget.createLease(budget.root, cap);
 const reservation = budget.reservePrompt(pending, { maxInputTokens: 10, maxSdkEstimatedCost: 0.01 });
 assert.throws(() => budget.closeLease(pending), /in-flight/);
 budget.markUnknown(reservation);
 assert.equal(budget.closeLease(pending).lifecycle, "closed");
 assert.equal(budget.status(pending).usageUnknown, true);
});

test("prepared request uses actual prompt bytes without a per-request token quota", async () => {
 const spec = { label: "request-prep", role: "research" as const, model: "fake/research", systemPrompt: "s", persistDir: "/tmp" };
 const prepared = prepareModelRequest({ spec, message: "m" });
 assert.equal(prepared.promptBytes, 2);
 assert.equal(prepared.inputTokenCeiling, 2050);
 assert.equal(prepared.spec.strictRequest?.maxInputPayloadBytes, prepared.payloadByteCeiling);
 assert.equal(prepared.spec.strictRequest?.maxOutputTokens, undefined);
 const long = prepareModelRequest({ spec, message: "x".repeat(50_000) });
 assert.equal(long.promptBytes, 50_001);
 assert.equal(long.inputTokenCeiling, 52_049);
 const budget = new SharedBudget("prepared", limits);
 const runner = new FakeSessionRunner((ctx) => {
  assert.equal(ctx.spec.strictRequest?.maxInputPayloadBytes, prepared.payloadByteCeiling);
  assert.equal(ctx.message, prepared.message);
  return { text: "ok", usage: { input: 2, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: 0.001 } };
 });
 const result = await runBoundedModelStep({ runner, budget, lease: budget.root, spec, message: "m", timeoutMs: 1000 });
 assert.equal(result.text, "ok");
 assert.equal(budget.status().committed.inputTokens, 2);
});

test("unknown SDK cost alone remains visible and does not stop the next model action", async () => {
 const spec = { label: "unpriced-offline", role: "research" as const, model: "fake/unpriced", systemPrompt: "s", persistDir: "/tmp" };
 const budget = new SharedBudget("unpriced", {});
 const fake = new FakeSessionRunner(() => ({ text: "ok", usage: { input: 2, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 3 } }));
 const runner = { create: fake.create.bind(fake), resume: fake.resume.bind(fake) };
 for (let i = 0; i < 2; i++) {
  const step = await runBoundedModelStep({ runner, budget, lease: budget.root, spec, message: "continue" });
  assert.equal(step.text, "ok");
  assert.equal(step.usage.complete, true);
  assert.equal(step.usage.costComplete, false);
 }
 assert.equal(budget.status().committed.providerCalls, 2);
 assert.equal(budget.status().usageUnknown, true);
 assert.deepEqual(budget.status().remaining, {});
});

test("an uncapped reply is recorded without enforcing a legacy aggregate output quota", async () => {
 const spec = { label: "observed-output", role: "research" as const, model: "fake/research", systemPrompt: "s", persistDir: "/tmp" };
 const budget = new SharedBudget("observed-output", { ...limits, maxOutputTokens: 10 });
 assert.equal("maxOutputTokens" in budget.status().limits, false);
 assert.equal("outputTokens" in budget.status().remaining, false);
 let calls = 0;
 const runner = new FakeSessionRunner((ctx) => {
  calls++;
  assert.equal(ctx.spec.strictRequest?.maxOutputTokens, undefined);
  return { text: "x".repeat(20_000), usage: { input: 2, output: 11, cacheRead: 0, cacheWrite: 0, totalTokens: 13, cost: 0.001 } };
 });
 await runBoundedModelStep({ runner, budget, lease: budget.root, spec, message: "m", timeoutMs: 1000 });
 assert.equal(budget.status().committed.outputTokens, 11);
 assert.equal(budget.status().settlement, "settled");
 await runBoundedModelStep({ runner, budget, lease: budget.root, spec, message: "again", timeoutMs: 1000 });
 assert.equal(calls, 2);
});

test("CPU executor accepts a valid action after a long provider reply", async () => {
 const budget = new SharedBudget("long-action", limits);
 const environment = createCpuResponseEnvironment(multi, budget);
 const start = await environment.development.prepare("long-action");
 const runner = new FakeSessionRunner(() => ({ text: JSON.stringify({ kind: "stop", actionId: "long.1", reason: "insufficient evidence" }) + " ".repeat(9_000),
  usage: { input: 2, output: 9_000, cacheRead: 0, cacheWrite: 0, totalTokens: 9_002, cost: 0.01 } }));
 const episode = await runExecutorEpisode({ development: environment.development, start, method: { version: 1, kind: "cpu-numerical-prompt", body: "Use visible observations." },
  methodVersionId: "H-long", runner, model: "fake/research", persistDir: "/tmp", budget, lease: budget.root });
 assert.equal(episode.status, "stopped", episode.failure ?? "unexpected episode status");
 assert.equal(budget.status().settlement, "settled");
});

test("phase preflight creates separate accounting namespaces without monetary gates", async () => {
 const stage = { maxSdkEstimatedCost: 0.1, maxProviderCalls: 0, maxInputTokens: 0, maxOutputTokens: 0, maxProbeCalls: 0, maxCpuMillis: 0, maxWallMillis: 0 };
 const root = new SharedBudget("phases", { ...stage, maxSdkEstimatedCost: 2 });
 const plan = { kind: "meta-improvement" as const, outer: stage, pilot: stage, branch: stage, protected: { ...stage, maxSdkEstimatedCost: 0.5 }, searchReplicates: 2, outcomeReplicates: 12, admissionCases: [{ maxProbeCalls: 20 }] };
 const phases = await reserveResearchPhases(root, plan);
 assert.equal(phases.branches.length, 2);
 assert.equal("protectedMaxProviderCalls" in phases, false);
 assert.deepEqual(root.status(phases.protected).limits, { maxSdkEstimatedCost: 2 });
 assert.deepEqual(root.status(phases.outer).remaining, { sdkEstimatedCost: 2 });
 assert.throws(() => root.reservePrompt(root.root, { maxInputTokens: 1, maxSdkEstimatedCost: 0.01 }), /direct root/);
 assert.throws(() => root.createLease(root.root), /sealed/);
});

test("historical phase and root monetary values do not gate a campaign", async () => {
 const root = new SharedBudget("shared-meta", { maxSdkEstimatedCost: 0.25 });
 const stage = { maxSdkEstimatedCost: 0.1 };
 const phases = await reserveResearchPhases(root, { kind: "meta-improvement", outer: stage, pilot: stage, branch: stage,
  protected: { maxSdkEstimatedCost: 10 }, searchReplicates: 2, outcomeReplicates: 2, admissionCases: [{ maxProbeCalls: 1 }],
  });
 const first = root.reservePrompt(phases.outer, { maxInputTokens: 1, maxSdkEstimatedCost: 0.1 });
 root.settlePrompt(first, { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: 0.15, reportedEvents: 1, unknownEvents: 0, complete: true, costComplete: true });
 assert.deepEqual(root.status(phases.protected).remaining, { sdkEstimatedCost: 0.1 });
 const second = root.reservePrompt(phases.protected, { maxInputTokens: 1, maxSdkEstimatedCost: 0.1 });
 root.settlePrompt(second, { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: 0.1, reportedEvents: 1, unknownEvents: 0, complete: true, costComplete: true });
 assert.equal(root.status().committed.sdkEstimatedCost, 0.25);
 assert.equal(root.status().settlement, "settled");
 const later = root.reserveObservedTurn(phases.branches[0]!.old);
 root.settleObservedTurn(later, { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: 0.1, reportedEvents: 1, unknownEvents: 0, complete: true, costComplete: true });
 assert.equal(root.status().committed.sdkEstimatedCost, 0.35);
 assert.equal(root.status().settlement, "settled");
});

test("meta search freezes alternating settled no-winner arms before G and permits only measured efficiency", async (t) => {
 const { mkdtemp, rm } = await import("node:fs/promises");
 const path = await import("node:path");
 const os = await import("node:os");
 const { runMetaImprovementAdmission } = await import("../../src/improvement/meta-eval.ts");
 const dir = await mkdtemp(path.join(os.tmpdir(), "meta-review-")); t.after(() => rm(dir, { recursive: true, force: true }));
 const budget = new SharedBudget("meta-review", { ...limits, maxProviderCalls: 100 });
 const armLimits = { ...limits, maxProviderCalls: 2, maxInputTokens: 2000, maxSdkEstimatedCost: 0.1, maxProbeCalls: 2, maxCpuMillis: 1000, maxWallMillis: 60_000 };
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
  protocol: "efficiency", searchReplicates: 2, outcomeReplicates: 2, runner, researchModel: "fake/research", persistDir: dir, timeoutMs: 10_000,
  produceSuccessor: async (id, lease, _cases, index, arm) => {
   events.push(`search-${index}-${arm}`);
   const reservation = budget.reservePrompt(lease, { maxInputTokens: 1000, maxSdkEstimatedCost: 0.1 });
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
  runner: new FakeSessionRunner(() => { throw new Error("protected G must not run"); }), researchModel: "fake/research", persistDir: "/tmp", timeoutMs: 1000,
  persistSelection: async () => { frozen++; return "private-selection-receipt"; }, persistObservation: async () => { throw new Error("protected G must not run"); } });
 assert.equal(result.status, "rejected");
 assert.equal(result.protectedQueriedAfterBothSelections, false);
 assert.equal(frozen, 1);
});

test("meta efficiency never treats an unknown search price as a measured gain", async (t) => {
 const { runMetaImprovementAdmission } = await import("../../src/improvement/meta-eval.ts");
 const { mkdtemp, rm } = await import("node:fs/promises");
 const os = await import("node:os");
 const path = await import("node:path");
 const dir = await mkdtemp(path.join(os.tmpdir(), "meta-unpriced-")); t.after(() => rm(dir, { recursive: true, force: true }));
 const budget = new SharedBudget("meta-unpriced", {});
 const branchLeases = [{ old: budget.createLease(budget.root), new: budget.createLease(budget.root) }];
 const protectedLease = budget.createLease(budget.root);
 const caseSet = (split: "development" | "admission") => ({ version: 1 as const, split, cases: [{ ...multi, id: `${split}-unpriced`, hypotheses: multi.hypotheses.slice(0, 2), maxProbeCalls: 1, allowedProbeX: [2] }] });
 const runner = new FakeSessionRunner((ctx) => ({ text: JSON.stringify(JSON.parse(ctx.message).visibleFeedback.length ? { kind: "submit", actionId: "submit.1", hypothesisId: "truth" } : { kind: "probe", actionId: "probe.1", x: 2 }), usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: 0.001 } }));
 const result = await runMetaImprovementAdmission({ oldImproverVersionId: "I0", newImproverVersionId: "I1", initialExecutor: { versionId: "H0", artifact: { version: 1, kind: "cpu-numerical-prompt", body: "Use evidence." } },
  developmentCaseSet: caseSet("development"), admissionCaseSet: caseSet("admission"), budget, branchLeases, protectedLease,
  protocol: "efficiency", searchReplicates: 1, outcomeReplicates: 2, runner, researchModel: "fake/research", persistDir: dir,
  produceSuccessor: async (id, lease, _cases, _index, arm) => {
   const reservation = budget.reserveObservedPrompt(lease, { maxInputTokens: 1 });
   budget.settlePrompt(reservation, { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: arm === "old" ? 0.02 : 0, reportedEvents: 1, unknownEvents: 0, complete: true, costComplete: arm === "old" });
   return { improverVersionId: id, startingExecutorVersionId: "H0", decisionCount: 1, status: "no-winner" };
  },
  persistSelection: async () => path.join(dir, "selection.json"), persistObservation: async () => ({ storeId: "test-ledger", id: "1", version: "1" }) });
 assert.equal(result.status, "inconclusive");
 assert.match(result.reason, /cost is incomplete/);
 assert.equal(result.replicates[0]?.newSearchCostComplete, false);
 assert.equal(result.protectedQueriedAfterBothSelections, true);
});
