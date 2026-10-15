import assert from "node:assert/strict";
import test from "node:test";
import { SharedBudget } from "../../src/experiments/budget.ts";
import { createCpuResponseEnvironment, type CpuResponseCase } from "../../src/experiments/local-environment.ts";
import type { ArtifactRef } from "../../src/experiments/contracts.ts";

const CASE: CpuResponseCase = {
	id: "response-a", version: 1, truthHypothesisId: "affine",
	hypotheses: [
		{ id: "affine", formula: { kind: "affine", slope: 2, intercept: 2 } },
		{ id: "quadratic", formula: { kind: "quadratic", coefficient: 2, intercept: 2 } },
	],
	initialX: [0], allowedProbeX: [2], maxProbeCalls: 1, tolerance: 0.001, units: { x: "second", y: "unit" },
};
const limits = { maxProviderCalls: 3, maxInputTokens: 100, maxSdkEstimatedCost: 1, maxProbeCalls: 10, maxCpuMillis: 1000, maxWallMillis: 10_000 };

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
