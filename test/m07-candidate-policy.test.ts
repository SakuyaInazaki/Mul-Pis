import assert from "node:assert/strict";
import test from "node:test";
import { candidateBudgetLedger, candidatePhase, candidateSearchState, candidateStrategyMenu,
	candidateStrategyStats, decideCandidate, DEFAULT_SEARCH_BUDGET, requireAllowedAction, requireBudget,
	requireUnbannedDirection, validateSearchBudget, type CandidateChangeKind } from "../src/m07/candidate-policy.ts";
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

const judged = (id: string, guard: "keep" | "accept" | "revert" | "reject", options: {
	lane?: "repair" | "optimization"; failureSignature?: string; changeKind?: CandidateChangeKind;
	latency?: number; sourceRepetition?: "duplicate_code" | "code_cycle" } = {}): CandidateArchiveEntry => {
	const row = entry(id, { latency: options.latency ?? 10, changeKind: options.changeKind,
		correctness: guard === "revert" && options.failureSignature ? "failed" : "passed" });
	row.sourceRepetition = options.sourceRepetition;
	row.policy = { version: 1, lane: options.lane ?? "optimization", phase: "tuning", guard,
		score: 0.5, tier: "correct-measured", incumbentComparison: [], updatesBest: guard === "keep",
		...(options.failureSignature ? { failureSignature: options.failureSignature } : {}),
		requiredFix: [], advisory: [], reasons: [] };
	return row;
};

test("stall counting ignores pre-check rejects and restarts at every keep", () => {
	const state = candidateSearchState([judged("C001", "keep"), judged("C002", "accept"),
		judged("C003", "reject"), judged("C004", "accept")], { subjectId: "a" });
	assert.equal(state.stagnation, 2, "two counted steps since the last keep; the reject is not a step");
	assert.equal(state.signals.includes("stagnation"), false);
	assert.equal(state.route, "continue");
	assert.equal(state.forcedDirectionChange, false);
	const reset = candidateSearchState([judged("C001", "accept"), judged("C002", "keep")], { subjectId: "a" });
	assert.equal(reset.stagnation, 0);
});

test("three counted steps without a keep force a direction change and ban the stalled ones", () => {
	const state = candidateSearchState([judged("C001", "keep"), judged("C002", "accept"),
		judged("C003", "accept"), judged("C004", "accept")], { subjectId: "a" });
	assert.deepEqual(state.signals, ["stagnation"]);
	assert.equal(state.forcedDirectionChange, true);
	assert.equal(state.route, "restructure");
	assert.deepEqual(state.bannedDirections.map(item => item.candidateRef), ["T001/C002", "T001/C003", "T001/C004"]);
	assert.equal(state.recommendedParents[0].candidateRef, "T001/C001");
	assert.match(state.message, /different direction/);
});

test("the same failure signature three times in a row is no progress, and oscillation is detected separately", () => {
	const repeated = candidateSearchState([judged("C001", "keep"),
		judged("C002", "revert", { failureSignature: "numerical-failure|numerical:cases[0]" }),
		judged("C003", "revert", { failureSignature: "numerical-failure|numerical:cases[0]" }),
		judged("C004", "revert", { failureSignature: "numerical-failure|numerical:cases[0]" })], { subjectId: "a" });
	assert.ok(repeated.signals.includes("no_progress"));
	const oscillating = candidateSearchState([judged("C001", "revert", { failureSignature: "compile-failure|none" }),
		judged("C002", "revert", { failureSignature: "numerical-failure|a" }),
		judged("C003", "revert", { failureSignature: "runtime-failure|b" }),
		judged("C004", "revert", { failureSignature: "compile-failure|none" }),
		judged("C005", "revert", { failureSignature: "numerical-failure|a" })], { subjectId: "a" });
	assert.ok(oscillating.signals.includes("category_oscillation"));
	const duplicate = candidateSearchState([judged("C001", "keep"),
		judged("C002", "accept", { sourceRepetition: "duplicate_code" })], { subjectId: "a" });
	assert.deepEqual(duplicate.signals, ["duplicate_code"]);
	assert.equal(duplicate.forcedDirectionChange, true);
});

test("repair depth escalates to a structural change and long stagnation returns to planning", () => {
	const repairing = (count: number) => candidateSearchState([judged("C001", "keep"),
		...Array.from({ length: count }, (_, index) => judged(`C10${index}`, "revert",
			{ lane: "repair", changeKind: "repair", failureSignature: `stage|${index}` }))], { subjectId: "a" });
	assert.equal(repairing(2).route, "repair-in-place", "a bounded repair loop stays in place");
	assert.equal(repairing(3).route, "restructure", "three repair steps on one defect is the debug limit");
	const exhausted = candidateSearchState([judged("C001", "keep"),
		...Array.from({ length: 8 }, (_, index) => judged(`C20${index}`, "accept"))], { subjectId: "a" });
	assert.equal(exhausted.route, "replan", "debug plus rewrite limits exhausted: the plan itself must change");
});

test("per-strategy outcomes stay visible so a low-success strategy is not silently dropped", () => {
	const row = (id: string, strategy: string, guard: "keep" | "accept" | "revert", score: number) => {
		const item = judged(id, guard);
		item.strategy = strategy as CandidateArchiveEntry["strategy"];
		item.policy!.score = score;
		return item;
	};
	const stats = candidateStrategyStats([row("C001", "tiling", "revert", 0.2),
		row("C002", "tiling", "revert", 0.2), row("C003", "tiling", "keep", 0.9),
		row("C004", "fusion", "accept", 0.5)], "a");
	assert.deepEqual(stats.map(item => [item.strategy, item.attempts, item.keeps, item.reverts, item.bestScore]),
		[["tiling", 3, 1, 2, 0.9], ["fusion", 1, 0, 0, 0.5]]);
});

test("the strategy menu is replayable, phase aware and never leaves fewer than two structural options", () => {
	const first = candidateStrategyMenu({ phase: "tuning", route: "continue", seed: "goal|T001|3" });
	const again = candidateStrategyMenu({ phase: "tuning", route: "continue", seed: "goal|T001|3" });
	assert.deepEqual(first, again, "the same seed replays the same menu");
	const later = candidateStrategyMenu({ phase: "tuning", route: "continue", seed: "goal|T001|4" });
	assert.notDeepEqual(first.offered, later.offered, "a later step withholds a different subset");
	for (const seed of ["a", "b", "c", "d", "e", "f"]) {
		const menu = candidateStrategyMenu({ phase: "bootstrap", route: "continue", seed });
		assert.ok(menu.offered.filter(item => !["repair", "numerical-parameters"].includes(item)).length >= 2);
		assert.equal(menu.offered.includes("numerical-parameters"), false, "parameter search is not offered in bootstrap");
		assert.ok(menu.withheld.length > 0, "a dropout actually withholds part of the menu");
	}
	assert.deepEqual(candidateStrategyMenu({ phase: "tuning", route: "repair-in-place", seed: "x" }).offered, ["repair"]);
});

test("a banned direction needs declared new evidence, and only while the search is stalled", () => {
	const stalled = candidateSearchState([judged("C001", "keep"),
		...["C002", "C003", "C004"].map(id => {
			const row = judged(id, "accept");
			row.strategy = "tiling";
			row.location = "kernel.c:inner_loop";
			return row;
		})], { subjectId: "a" });
	const action = { changeKind: "structure" as CandidateChangeKind, strategy: "tiling" as const,
		location: "kernel.c:inner_loop" };
	assert.throws(() => requireUnbannedDirection(stalled, action), (error: unknown) =>
		error instanceof HarnessError && error.code === "m07.candidate-direction");
	requireUnbannedDirection(stalled, action, "the profiler now shows the loop is memory bound, not occupancy bound");
	requireUnbannedDirection(stalled, { ...action, location: "kernel.c:epilogue" });
	const healthy = candidateSearchState([judged("C001", "keep")], { subjectId: "a" });
	requireUnbannedDirection(healthy, action);
});

test("every host evaluation spends one unit, including failures and pre-check rejects", () => {
	const policy = validateSearchBudget({ evaluationsPerTask: 5, repairEvaluationsPerTask: 2,
		parameterEvaluationsPerTask: 1 });
	const rows = [judged("C001", "keep", { lane: "optimization" }),
		judged("C002", "revert", { lane: "repair", changeKind: "repair", failureSignature: "a" }),
		judged("C003", "reject", { lane: "repair", changeKind: "repair" })];
	const ledger = candidateBudgetLedger(rows, { taskId: "T001", subjectId: "a", policy });
	assert.equal(ledger.evaluations, 3);
	assert.equal(ledger.repair, 2);
	assert.equal(ledger.optimization, 1);
	assert.equal(ledger.rejected, 1, "a pre-check reject still consumed a host call");
	assert.equal(ledger.remaining, 2);
	assert.equal(ledger.remainingRepair, 0);
	assert.equal(ledger.stop, undefined);
	assert.throws(() => requireBudget(ledger, { changeKind: "repair", lane: "repair" }), (error: unknown) =>
		error instanceof HarnessError && error.code === "m07.candidate-budget");
	requireBudget(ledger, { changeKind: "structure", lane: "optimization" });
});

test("the task budget, the parameter sub-budget and the stagnation limit each stop further evaluation", () => {
	const policy = validateSearchBudget({ evaluationsPerTask: 3, repairEvaluationsPerTask: 3,
		parameterEvaluationsPerTask: 1, routeLimits: { stagnation: 2, directionChange: 2 } });
	const spent = candidateBudgetLedger([judged("C001", "keep"), judged("C002", "keep"), judged("C003", "keep")],
		{ taskId: "T001", subjectId: "a", policy });
	assert.equal(spent.stop, "task-evaluation-budget");
	assert.throws(() => requireBudget(spent, { changeKind: "structure", lane: "optimization" }), /evaluation budget/);

	const parameters = judged("C002", "accept");
	parameters.changeKind = "parameters";
	const parameterLedger = candidateBudgetLedger([judged("C001", "keep"), parameters],
		{ taskId: "T001", subjectId: "a", policy });
	assert.equal(parameterLedger.remainingParameters, 0);
	assert.throws(() => requireBudget(parameterLedger, { changeKind: "parameters", lane: "optimization" }),
		/parameter sub-budget/);

	const roomy = validateSearchBudget({ evaluationsPerTask: 10, repairEvaluationsPerTask: 10,
		parameterEvaluationsPerTask: 10, routeLimits: { stagnation: 2, directionChange: 2 } });
	const stalled = candidateBudgetLedger([judged("C001", "keep"), judged("C002", "accept"), judged("C003", "accept")],
		{ taskId: "T001", subjectId: "a", policy: roomy });
	assert.equal(stalled.stop, "stagnation-limit");
	assert.throws(() => requireBudget(stalled, { changeKind: "structure", lane: "optimization" }), /stagnation limit/);
});

test("search budget validation rejects unknown fields and impossible sub-budgets", () => {
	assert.throws(() => validateSearchBudget({ evaluations: 10 }), /unknown fields/);
	assert.throws(() => validateSearchBudget({ evaluationsPerTask: 0 }), /integer in 1-100000/);
	assert.throws(() => validateSearchBudget({ evaluationsPerTask: 5, repairEvaluationsPerTask: 6 }),
		/cannot exceed/);
	assert.throws(() => validateSearchBudget({ routeLimits: { stagnation: 2, directionChange: 3 } }),
		/directionChange cannot exceed/);
	assert.equal(validateSearchBudget({}).evaluationsPerTask, DEFAULT_SEARCH_BUDGET.evaluationsPerTask);
	assert.ok(DEFAULT_SEARCH_BUDGET.evaluationsPerTask >= 15,
		"the Ascend evidence needs at least fifteen evaluations per operator");
});
