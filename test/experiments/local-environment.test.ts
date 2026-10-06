import assert from "node:assert/strict";
import test from "node:test";
import { SharedBudget } from "../../src/experiments/budget.ts";
import { createCpuResponseEnvironment, validateCpuCaseSet, type CpuResponseCase } from "../../src/experiments/local-environment.ts";
import type { ArtifactRef } from "../../src/experiments/contracts.ts";
import type { UsageSummary } from "../../src/runner/types.ts";

const CASE: CpuResponseCase = {
	id: "response-a", version: 1, truthHypothesisId: "affine",
	hypotheses: [
		{ id: "affine", formula: { kind: "affine", slope: 2, intercept: 2 } },
		{ id: "quadratic", formula: { kind: "quadratic", coefficient: 2, intercept: 2 } },
	],
	initialX: [0], allowedProbeX: [2], maxProbeCalls: 1, tolerance: 0.001, units: { x: "second", y: "unit" },
};
const limits = { maxProviderCalls: 3, maxInputTokens: 100, maxSdkEstimatedCost: 1, maxProbeCalls: 10, maxCpuMillis: 1000, maxWallMillis: 10_000 };
const usage: UsageSummary = { input: 4, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 7, cost: 0.01, reportedEvents: 1, unknownEvents: 0, complete: true, costComplete: true };

test("CPU health calibration executes positive, negative, ambiguous, reset and per-case resource branches", async () => {
	const env = createCpuResponseEnvironment(CASE, new SharedBudget("health", limits));
	const report = await env.development.healthCheck();
	assert.equal(report.usable, true, JSON.stringify(report.checks));
	assert.equal(report.checks.length, 9);
	assert.equal(report.checks.some((check) => check.name === "timeout"), false);
 assert.equal(report.checks.find((check) => check.name === "premature-stop")?.passed, true);
});

test("unidentifiable allowed probes are healthy only with justified-unknown calibration", async () => {
	const unidentifiable: CpuResponseCase = { ...CASE, id: "response-unidentifiable", allowedProbeX: [1] };
	const budget = new SharedBudget("unknown-case", limits);
	const env = createCpuResponseEnvironment(unidentifiable, budget);
	const report = await env.development.healthCheck();
	assert.equal(report.usable, true, JSON.stringify(report.checks));
	assert.deepEqual(report.checks.find((check) => check.name === "discriminating-probe")?.applicability, "not-applicable");
	assert.equal(report.checks.find((check) => check.name === "unidentifiable-stop")?.passed, true);
	const start = await env.development.prepare("unknown");
	await env.development.runProbe(start, { kind: "probe", actionId: "p", x: 1 }, budget.root);
	await env.development.stop(start, { kind: "stop", actionId: "s", reason: "the permitted measurement does not separate the hypotheses" });
	assert.deepEqual((await env.protectedEvaluator.evaluateStop(start)).status, "justified-unknown");
});

test("probe separates same initial observation, fork resets state, and private truth is absent from model view", async () => {
	const budget = new SharedBudget("fork", limits);
	const stored: Array<{ ref: ArtifactRef; observation: number }> = [];
	const env = createCpuResponseEnvironment(CASE, budget, {
		persistObservation: async ({ feedback }) => {
			const ref = { storeId: "test-private-ledger", id: String(stored.length + 1), version: "1" };
			stored.push({ ref, observation: feedback.observations[0]?.y ?? 0 });
			return ref;
		},
	});
	const start = await env.development.prepare("same-seed");
	const publicTask = env.development.publicTask(start);
	assert.equal(JSON.stringify(publicTask).includes("truthHypothesisId"), false);
	assert.equal(publicTask.initialObservations[0]?.y, 2);
	const premature = await env.development.fork(start);
	assert.equal((await env.development.evaluateDevelopment(premature, { kind: "submit", actionId: "guess", hypothesisId: "affine" }, budget.root)).status, "underdetermined");
	assert.equal((await env.protectedEvaluator.evaluate(premature, "affine")).status, "inconclusive");
	const probe = { kind: "probe" as const, actionId: "probe-1", x: 2 };
	const result = await env.development.runProbe(start, probe, budget.root);
	assert.equal(result.status, "observed");
	assert.equal(result.observations[0]?.y, 6);
	assert.deepEqual(result.evidence, [stored.at(-1)?.ref]);
	assert.deepEqual(await env.development.runProbe(start, probe, budget.root), result);
	assert.equal(budget.status().committed.probeCalls, 1);
	await assert.rejects(env.development.runProbe(start, { ...probe, x: 0 }, budget.root), /collision/);
	const fresh = await env.development.fork(start);
	assert.equal(fresh.inputSnapshotId, start.inputSnapshotId);
	assert.equal((await env.development.runProbe(fresh, probe, budget.root)).remainingProbeCalls, 0);
	const supported = await env.development.evaluateDevelopment(start, { kind: "submit", actionId: "answer", hypothesisId: "affine" }, budget.root);
	assert.equal(supported.status, "supported-by-observations");
	assert.equal((await env.protectedEvaluator.evaluate(start, "affine")).status, "accepted");
});

test("runtime case validation strips extra private fields from public hypotheses", async () => {
	const malicious = structuredClone(CASE) as CpuResponseCase & { hypotheses: Array<CpuResponseCase["hypotheses"][number] & { secretAnswer?: string }> };
	malicious.hypotheses[0]!.secretAnswer = "private-canary";
	const env = createCpuResponseEnvironment(malicious, new SharedBudget("sanitize", limits));
	const start = await env.development.prepare("seed");
	assert.equal(JSON.stringify(env.development.publicTask(start)).includes("private-canary"), false);
});

test("failed persistence leaves action unresolved and does not repeat a charged probe", async () => {
	const budget = new SharedBudget("failure", limits);
	let attempts = 0;
	const env = createCpuResponseEnvironment(CASE, budget, { persistObservation: async () => { attempts++; throw new Error("private storage fault"); } });
	const start = await env.development.prepare("seed");
	const action = { kind: "probe" as const, actionId: "p", x: 2 };
	await assert.rejects(env.development.runProbe(start, action, budget.root), /persistence failed/);
	await assert.rejects(env.development.runProbe(start, action, budget.root), /unresolved/);
	await assert.rejects(env.development.runProbe(start, { ...action, x: 0 }, budget.root), /collision/);
	await assert.rejects(env.development.fork(start), /unresolved/);
	assert.equal((await env.protectedEvaluator.evaluate(start, "affine")).status, "inconclusive");
	assert.equal(attempts, 1);
	assert.equal(budget.status().committed.probeCalls, 1);
});

test("failed submit and stop persistence cannot produce protected acceptance", async () => {
	for (const terminal of ["submit", "stop"] as const) {
		const budget = new SharedBudget(`terminal-${terminal}`, limits);
		let calls = 0;
		const env = createCpuResponseEnvironment(CASE, budget, { persistObservation: async () => {
			calls++;
			if (terminal === "submit" && calls === 2 || terminal === "stop") throw new Error("disk fault");
			return { storeId: "private-test", id: String(calls), version: "1" };
		} });
		const start = await env.development.prepare("seed");
		if (terminal === "submit") {
			await env.development.runProbe(start, { kind: "probe", actionId: "p", x: 2 }, budget.root);
			await assert.rejects(env.development.evaluateDevelopment(start, { kind: "submit", actionId: "s", hypothesisId: "affine" }, budget.root), /persistence failed/);
			assert.equal((await env.protectedEvaluator.evaluate(start, "affine")).status, "inconclusive");
		} else {
			await assert.rejects(env.development.stop(start, { kind: "stop", actionId: "s", reason: "uncertain" }), /persistence failed/);
			assert.equal((await env.protectedEvaluator.evaluateStop(start)).status, "inconclusive");
		}
		await assert.rejects(env.development.fork(start), /unresolved/);
	}
});

test("oversized model action is rejected before persistence", async () => {
	const budget = new SharedBudget("oversized", limits);
	let persisted = 0;
	const env = createCpuResponseEnvironment(CASE, budget, { persistObservation: async () => { persisted++; return { storeId: "private", id: "1", version: "1" }; } });
	const start = await env.development.prepare("seed");
	await assert.rejects(env.development.evaluateDevelopment(start, { kind: "submit", actionId: "s", hypothesisId: "affine", explanation: "😀".repeat(400) }, budget.root), /oversized/);
	await assert.rejects(env.development.stop(start, { kind: "stop", actionId: "x".repeat(101), reason: "stop" }), /oversized/);
	assert.equal(persisted, 0);
});

test("shared root and child budget reserve, settle, and fail closed on unknown or invalid usage", () => {
	const budget = new SharedBudget("tokens", limits);
	const child = budget.createLease(budget.root, { ...limits, maxProviderCalls: 2 });
	const one = budget.reservePrompt(child, { maxInputTokens: 20, maxSdkEstimatedCost: 0.1 });
	assert.equal(budget.status().settlement, "pending-or-unknown");
	budget.settlePrompt(one, usage);
	assert.equal(budget.status().committed.providerCalls, 1);
	assert.equal(budget.status(child).committed.providerCalls, 1);
	assert.equal(budget.status().settlement, "settled");
	const two = budget.reservePrompt(child, { maxInputTokens: 20, maxSdkEstimatedCost: 0.1 });
	budget.settlePrompt(two, { ...usage, input: Number.NaN });
	assert.equal(budget.status().settlement, "pending-or-unknown");
	assert.equal(budget.status().committed.inputTokens, 4);
	assert.throws(() => budget.reservePrompt(budget.root, { maxInputTokens: 1, maxSdkEstimatedCost: 0.01 }), /pending, unknown/);
	const overshoot = new SharedBudget("overshoot", limits);
	const reservation = overshoot.reservePrompt(overshoot.root, { maxInputTokens: 10, maxSdkEstimatedCost: 0.1 });
	overshoot.settlePrompt(reservation, { ...usage, output: 11 });
	assert.equal(overshoot.status().settlement, "settled");
	assert.equal(overshoot.status().committed.outputTokens, 11);
});

test("multiple reported rounds charge cached input and reasoning output once at root and child", () => {
	const budget = new SharedBudget("cached", limits);
	const child = budget.createLease(budget.root);
	const reservation = budget.reservePrompt(child, { maxInputTokens: 30, maxSdkEstimatedCost: 0.2 });
	const multi: UsageSummary = { input: 8, cacheRead: 7, cacheWrite: 3, output: 12, totalTokens: 30, cost: 0.08, reportedEvents: 2, unknownEvents: 0, complete: true, costComplete: true };
	budget.settlePrompt(reservation, multi);
	for (const lease of [budget.root, child]) {
		const status = budget.status(lease);
		assert.equal(status.committed.providerCalls, 2);
		assert.equal(status.committed.inputTokens, 18);
		assert.equal(status.committed.outputTokens, 12);
		assert.equal(status.committed.sdkEstimatedCost, 0.08);
		assert.equal(status.settlement, "settled");
	}
	const missing = new SharedBudget("missing", limits);
	const pending = missing.reservePrompt(missing.root, { maxInputTokens: 10, maxSdkEstimatedCost: 0.1 });
	missing.settlePrompt(pending, { ...usage, cacheRead: -1 });
	assert.equal(missing.status().settlement, "pending-or-unknown");
});

test("stop retains scientific per-case probe semantics and ignores historical campaign time/count quotas", async () => {
	const budget = new SharedBudget("stop", { ...limits, maxProbeCalls: 0, maxCpuMillis: 0, maxWallMillis: 0 });
	const env = createCpuResponseEnvironment(CASE, budget);
	const start = await env.development.prepare("seed");
	await env.development.stop(start, { kind: "stop", actionId: "stop", reason: "uncertain" });
	assert.equal((await env.protectedEvaluator.evaluateStop(start, budget.root)).status, "premature-stop");
	const fresh = await env.development.prepare("fresh");
	assert.equal((await env.development.runProbe(fresh, { kind: "probe", actionId: "first", x: 2 }, budget.root)).status, "observed");
	assert.equal((await env.development.runProbe(fresh, { kind: "probe", actionId: "extra", x: 2 }, budget.root)).status, "resource-exhausted");
	assert.equal(budget.status().settlement, "settled");
	assert.equal(budget.status().committed.probeCalls, 1);
});

test("cost-only live status strips all legacy quotas while retaining actual unlimited usage", () => {
	const budget = new SharedBudget("cost-only", { maxSdkEstimatedCost: 2, maxProviderCalls: 0, maxInputTokens: 0, maxOutputTokens: 0, maxProbeCalls: 0, maxCpuMillis: 0, maxWallMillis: 0 });
	const child = budget.createLease(budget.root, { maxSdkEstimatedCost: 1 });
	assert.deepEqual(budget.status().limits, { maxSdkEstimatedCost: 2 });
	assert.deepEqual(budget.status(child).limits, { maxSdkEstimatedCost: 2 });
	assert.deepEqual(budget.status().remaining, { sdkEstimatedCost: 2 });
	const reservation = budget.reserveObservedPrompt(child, { maxInputTokens: 1 });
	budget.settlePrompt(reservation, { ...usage, input: 100_000, output: 200_000, reportedEvents: 20 });
	const turn = budget.reserveObservedTurn(child);
	assert.deepEqual(Object.keys(turn).sort(), ["id", "leaseId"]);
	budget.settleObservedTurn(turn, { ...usage, input: 300_000, output: 400_000, reportedEvents: 50 });
	for (let index = 0; index < 20; index++) budget.reserveProbe(child);
	budget.debitCpuMillis(child, 1_000_000);
	for (const lease of [budget.root, child]) {
		const status = budget.status(lease);
		assert.deepEqual(status.committed, { providerCalls: 70, inputTokens: 400_000, outputTokens: 600_000, sdkEstimatedCost: 0.02, probeCalls: 20, cpuMillis: 1_000_000 });
		assert.equal(status.settlement, "settled");
		assert.deepEqual(Object.keys(status.remaining), ["sdkEstimatedCost"]);
	}
});

test("monetary budget and unknown usage still block further paid requests", () => {
	const budget = new SharedBudget("money", { maxSdkEstimatedCost: 0.1 });
	const child = budget.createLease(budget.root, { maxSdkEstimatedCost: 1 });
	assert.throws(() => budget.reservePrompt(child, { maxInputTokens: 1, maxSdkEstimatedCost: 0.2 }), /monetary budget/);
	const turn = budget.reserveObservedTurn(child);
	budget.settleObservedTurn(turn, { ...usage, cost: 0.2 });
	assert.equal(budget.status().settlement, "exceeded");
	assert.equal(budget.status(child).settlement, "exceeded");
	assert.throws(() => budget.reserveObservedTurn(child), /exceeded/);
	const unknown = new SharedBudget("unknown-turn", { maxSdkEstimatedCost: 1 });
	const pending = unknown.reserveObservedTurn(unknown.root);
	unknown.markObservedTurnUnknown(pending);
	assert.equal(unknown.status().settlement, "pending-or-unknown");
	assert.throws(() => unknown.reserveObservedTurn(unknown.root), /unknown/);
});


test("caller-selected case counts and probe allowances have no fixed workflow count ceiling", () => {
	const cases = Array.from({ length: 40 }, (_, index) => ({ ...CASE, id: `case-${index}`, initialX: Array.from({ length: 10 }, () => 0), allowedProbeX: Array.from({ length: 20 }, (_, x) => x), maxProbeCalls: 20 }));
	const parsed = validateCpuCaseSet({ version: 1, split: "development", cases });
	assert.equal(parsed.cases.length, 40);
	assert.equal(parsed.cases[0]!.maxProbeCalls, 20);
	assert.equal(parsed.cases[0]!.allowedProbeX.length, 20);
});
