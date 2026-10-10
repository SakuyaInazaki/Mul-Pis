import assert from "node:assert/strict";
import test from "node:test";
import { inspectResultOnlyGap } from "../src/runner/result-only-gap.ts";

const source = { runId: "812345", runAttempt: 1, commit: "a".repeat(40) };
const priorEnvelopeSha256 = "b".repeat(64);
const contract = { version: 1, kind: "original-objective", id: "synthetic-objective", goal: "Synthetic test" };
const boundedRuns = [{ runId: "prior-goal", outcome: "blocked" }];
function fixture() {
	const priorObjectiveJson = JSON.stringify(contract);
	const priorCheckpointJson = JSON.stringify({ contract, boundedRuns,
		selectedArtifacts: { candidate: "synthetic" } });
	const result = {
		objectiveJson: priorObjectiveJson,
		checkpointJson: JSON.stringify({ contract, boundedRuns,
			selectedArtifacts: { candidate: "synthetic" }, objectiveOutcome: "incomplete",
			stopReason: "assessment-evidence-unread" }),
		statusJson: JSON.stringify({ version: 1, runId: null, outcome: "incomplete",
			originalObjective: { id: contract.id, outcome: "incomplete",
				stopReason: "assessment-evidence-unread" },
			budget: { accountingMode: "observed-only", active: false, activePrompts: 0,
				stopped: false, reservations: 2, unpricedRequestCount: 0,
				settledCny: 0.02, unknownReservedCny: 0, inFlightReservedCny: 0,
				currentCommittedCny: 0.02, priorCommittedCny: 0,
				missionCommittedCny: 0.02, committedCny: 0.02 } }),
		censusJson: JSON.stringify({ version: 1, kind: "m07-host-effect-census",
			source, priorEnvelopeSha256, historicalGoalRunIds: ["prior-goal"],
			goals: [], sessions: [{ sessionId: "c".repeat(64), kind: "read-dir" }],
			requestIds: ["synthetic-1", "synthetic-2"] }),
	};
	return { source, priorEnvelopeSha256, priorObjectiveJson, priorCheckpointJson, result };
}
function mutate(file: keyof ReturnType<typeof fixture>["result"], change: (value: any) => void) {
	const x = fixture(), value = JSON.parse(x.result[file]); change(value);
	x.result[file] = JSON.stringify(value); return x;
}
test("result-only gap screening retains observed aggregate and quarantines every request", () => {
	const candidate = inspectResultOnlyGap(fixture());
	assert.equal(candidate.kind, "non-authoritative-result-only-gap-candidate");
	assert.equal(candidate.observedSettledCny, 0.02);
	assert.equal(candidate.unreconciledRequestCount, 2);
	assert.equal(candidate.requestIds.length, 2);
	assert.match(candidate.statusSha256, /^[0-9a-f]{64}$/);
});
test("result-only gap screening rejects dropped requests, drifted accounting and in-flight transport", () => {
	for (const value of [
		mutate("censusJson", x => x.requestIds.pop()),
		mutate("censusJson", x => { x.requestIds[1] = x.requestIds[0]; }),
		mutate("statusJson", x => { x.budget.settledCny = 0; }),
		mutate("statusJson", x => { x.budget.inFlightReservedCny = 0.01; }),
		mutate("statusJson", x => { x.budget.active = true; }),
		mutate("statusJson", x => { x.budget.unpricedRequestCount = 3; }),
	]) assert.throws(() => inspectResultOnlyGap(value), /structurally incomplete/);
});
test("result-only gap screening rejects actor effects, changed objective and broken predecessor binding", () => {
	for (const value of [
		mutate("censusJson", x => { x.goals = [{ runId: "new-goal" }]; }),
		mutate("censusJson", x => { x.sessions[0].kind = "confined-execution"; }),
		mutate("censusJson", x => { x.priorEnvelopeSha256 = "d".repeat(64); }),
		mutate("checkpointJson", x => { x.boundedRuns.push({ runId: "new-goal" }); }),
		mutate("checkpointJson", x => { x.selectedArtifacts.candidate = "changed"; }),
		{ ...fixture(), result: { ...fixture().result, objectiveJson:
			JSON.stringify({ ...contract, goal: "same ID, different goal" }) } },
	]) assert.throws(() => inspectResultOnlyGap(value), /structurally incomplete/);
});
