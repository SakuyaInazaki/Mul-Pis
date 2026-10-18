import assert from "node:assert/strict";
import test from "node:test";
import { candidatePhase, decideCandidate, requireAllowedAction,
	type CandidateChangeKind } from "../src/m07/candidate-policy.ts";
import type { CandidateArchiveEntry } from "../src/m07/candidate-archive.ts";
import type { CandidateDiagnosticSummaryV1 } from "../src/m07/candidate-diagnostics.ts";
import type { CandidateMetricV1, CandidateObservationV1 } from "../src/m07/types.ts";
import { HarnessError } from "../src/types.ts";

const latency = (value: number): CandidateMetricV1 =>
	({ name: "latency", value, unit: "ms", basisId: "subject:a:device:x", direction: "lower" });

function observation(options: { latency?: number; correctness?: "passed" | "failed" | "unknown";
	sourceBinding?: "verified" | "unknown" } = {}): CandidateObservationV1 {
	return { version: 1, kind: "candidate-observation", verifier: { id: "host:test", version: "1" },
		sourceBinding: options.sourceBinding ?? "verified", correctness: options.correctness ?? "passed",
		stage: "evaluated", checks: [], goalChecks: [],
		metrics: options.latency === undefined ? [] : [latency(options.latency)], limitations: [],
		sourceFiles: ["candidate.c"], receiptFiles: ["receipt.json"],
		executionFacts: { evaluations: [{ externalId: `E-${options.latency ?? "none"}`, subjectId: "a",
			status: "Completed", terminal: true, capturedAt: "2026-10-18T00:00:00.000Z", receiptIndex: 0,
			cases: [{ caseId: "one", status: "Completed", correctness: options.correctness ?? "passed",
				metrics: options.latency === undefined ? [] : [latency(options.latency)] }], diagnostics: [] }] } };
}

function entry(id: string, options: Parameters<typeof observation>[0] & {
	changeKind?: CandidateChangeKind } = {}): CandidateArchiveEntry {
	return { ref: `T001/${id}`, taskId: "T001", subjectId: "a", candidateId: id, taskStatus: "returned",
		intent: "solution", changeKind: options.changeKind ?? "structure", sourcePaths: ["candidate.c"],
		receiptPaths: ["receipt.json"], observation: observation(options),
		observationPath: `${id}/observation.json`, workDir: "work" };
}

const diagnostics = (options: { stage?: CandidateDiagnosticSummaryV1["stage"];
	passed?: number; failed?: number; unknown?: number; location?: boolean } = {}):
	Pick<CandidateDiagnosticSummaryV1, "stage" | "cases" | "diagnosticLocations"> => ({
	stage: options.stage ?? "correct-measured",
	cases: { passed: options.passed ?? 1, failed: options.failed ?? 0, unknown: options.unknown ?? 0 },
	diagnosticLocations: options.location
		? [{ subjectId: "a", externalId: "E-1", receiptIndex: 0, category: "numerical",
			caseId: "one", fieldPath: "cases[0].maxAbsoluteError" }]
		: [] });

const decide = (input: { observation: CandidateObservationV1;
	diagnostics?: Parameters<typeof decideCandidate>[0]["diagnostics"];
	history?: CandidateArchiveEntry[]; changeKind?: CandidateChangeKind;
	intent?: "solution" | "diagnostic" }) =>
	decideCandidate({ observation: input.observation, diagnostics: input.diagnostics ?? diagnostics(),
		changeKind: input.changeKind ?? "structure", intent: input.intent ?? "solution",
		subjectId: "a", history: input.history ?? [] });

test("the first verified-correct candidate ends bootstrap and becomes the best", () => {
	assert.equal(candidatePhase([], "a"), "bootstrap");
	const decision = decide({ observation: observation({ latency: 10 }) });
	assert.equal(decision.phase, "bootstrap");
	assert.equal(decision.lane, "repair");
	assert.equal(decision.guard, "keep");
	assert.equal(decision.updatesBest, true);
	assert.equal(decision.tier, "correct-unmeasured");
	assert.equal(decision.score, 0.5);
	assert.equal(candidatePhase([entry("C001", { latency: 10 })], "a"), "tuning");
});

test("only a correct candidate that beats the incumbent beyond the noise margin advances the best", () => {
	const history = [entry("C001", { latency: 10 })];
	const faster = decide({ observation: observation({ latency: 8 }), history });
	assert.equal(faster.guard, "keep");
	assert.equal(faster.updatesBest, true);
	assert.equal(faster.lane, "optimization");
	assert.equal(faster.seedRef, "T001/C001");
	assert.ok(faster.seedSpeedup !== undefined && faster.seedSpeedup > 1.2);
	assert.ok(faster.score > 0.5 && faster.score <= 1);

	const equal = decide({ observation: observation({ latency: 10.05 }), history });
	assert.equal(equal.guard, "accept");
	assert.equal(equal.updatesBest, false);
	assert.ok(equal.advisory.length <= 1);

	const slower = decide({ observation: observation({ latency: 12 }), history });
	assert.equal(slower.guard, "revert");
	assert.equal(slower.updatesBest, false);
	assert.match(slower.requiredFix[0], /T001\/C001/);
	assert.equal(slower.incumbentComparison[0].regressed, true);
});

test("a correctness failure reverts to the verified candidate and names one must-fix location", () => {
	const history = [entry("C001", { latency: 10 })];
	const decision = decide({ observation: observation({ latency: 4, correctness: "failed" }), history,
		diagnostics: diagnostics({ stage: "numerical-failure", passed: 1, failed: 1, location: true }) });
	assert.equal(decision.guard, "revert");
	assert.equal(decision.tier, "near-miss");
	assert.ok(decision.score > 0.2 && decision.score < 0.5);
	assert.equal(decision.requiredFix.length, 1);
	assert.match(decision.requiredFix[0], /maxAbsoluteError/);
	assert.match(decision.advisory[0], /T001\/C001/);
	assert.equal(decision.incumbentComparison.length, 0, "a failing candidate is never compared on speed");
});

test("an unbound or unjudged result is a pre-check rejection, not a search step", () => {
	const decision = decide({ observation: observation({ latency: 3, sourceBinding: "unknown" }),
		diagnostics: diagnostics({ stage: "source-unverified" }) });
	assert.equal(decision.guard, "reject");
	assert.equal(decision.tier, "source-unverified");
	assert.equal(decision.score, 0.05);
	assert.equal(decision.updatesBest, false);
});

test("the score is layered and bounded: near miss beats wrong, wrong beats compile failure, all below correct", () => {
	const score = (stage: CandidateDiagnosticSummaryV1["stage"], passed: number, failed: number) =>
		decide({ observation: observation({ correctness: "failed" }),
			diagnostics: diagnostics({ stage, passed, failed }) }).score;
	const compileFailure = score("compile-failure", 0, 1);
	const wrong = score("correctness-failure", 0, 2);
	const nearMiss = score("numerical-failure", 3, 1);
	const correct = decide({ observation: observation({ latency: 10 }) }).score;
	assert.ok(compileFailure < wrong && wrong < nearMiss && nearMiss < correct);
	assert.ok(correct <= 1);
	const fast = decide({ observation: observation({ latency: 1 }),
		history: [entry("C001", { latency: 10 })] }).score;
	assert.ok(fast <= 1, "the performance term stays bounded for an extreme speedup");
});

test("the stage order gate rejects parameter search before a verified-correct structure", () => {
	assert.throws(() => requireAllowedAction({ changeKind: "parameters", strategy: "numerical-parameters",
		phase: "bootstrap", parentVerifiedCorrect: false }), (error: unknown) =>
		error instanceof HarnessError && error.code === "m07.candidate-phase");
	assert.throws(() => requireAllowedAction({ changeKind: "parameters", strategy: "numerical-parameters",
		phase: "tuning", parentVerifiedCorrect: false }), (error: unknown) =>
		error instanceof HarnessError && error.code === "m07.candidate-phase");
	assert.throws(() => requireAllowedAction({ changeKind: "structure", strategy: "numerical-parameters",
		phase: "tuning", parentVerifiedCorrect: true }), (error: unknown) =>
		error instanceof HarnessError && error.code === "m07.candidate-action");
	requireAllowedAction({ changeKind: "parameters", strategy: "numerical-parameters",
		phase: "tuning", parentVerifiedCorrect: true });
	requireAllowedAction({ changeKind: "structure", strategy: "tiling", phase: "bootstrap",
		parentVerifiedCorrect: false });
	requireAllowedAction({ changeKind: "repair", strategy: "repair", phase: "bootstrap",
		parentVerifiedCorrect: false });
});
