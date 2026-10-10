import { createHash } from "node:crypto";
import { HarnessError } from "../types.ts";

/** Structural screening only. The caller must separately authenticate the Actions
 * source and terminal job, artifact archive digest, encrypted-result provenance,
 * and the predecessor carry. This cannot mint a carry or certify request charges. */
export type ResultOnlyGapCandidate = Readonly<{
	version: 1; kind: "non-authoritative-result-only-gap-candidate";
	source: Readonly<{ runId: string; runAttempt: number; commit: string }>;
	priorEnvelopeSha256: string;
	statusSha256: string; censusSha256: string; checkpointSha256: string;
	requestIds: readonly string[];
	observedSettledCny: number; observedUnknownReservedCny: number;
	unpricedRequestCount: number;
	/** Row-level outcome, timing, usage and fees cannot be reconstructed. */
	unreconciledRequestCount: number;
}>;

type Input = {
	source: { runId: string; runAttempt: number; commit: string };
	priorEnvelopeSha256: string;
	priorObjectiveJson: string; priorCheckpointJson: string;
	result: { statusJson: string; censusJson: string; objectiveJson: string; checkpointJson: string };
};
function bad(): never { throw new HarnessError("runner.result-only-gap", "result-only gap evidence is structurally incomplete"); }
function object(x: unknown): x is Record<string, any> {
	return x !== null && typeof x === "object" && !Array.isArray(x);
}
function keys(x: Record<string, unknown>, expected: string[]): boolean {
	return Object.keys(x).sort().join("|") === expected.sort().join("|");
}
function json(raw: string): unknown {
	if (typeof raw !== "string" || Buffer.byteLength(raw, "utf8") > 4 * 1024 * 1024) bad();
	try { return JSON.parse(raw); } catch { bad(); }
}
function nano(x: unknown): x is number {
	return typeof x === "number" && Number.isFinite(x) && x >= 0 &&
		Number.isSafeInteger(Math.ceil(x * 1_000_000_000));
}
function hash(raw: string): string { return createHash("sha256").update(raw).digest("hex"); }
function same(a: unknown, b: unknown): boolean { return JSON.stringify(a) === JSON.stringify(b); }

/** Screen a locally decrypted result against the predecessor's exact objective
 * and bounded-run prefix. Successful screening is deliberately not provenance. */
export function inspectResultOnlyGap(input: Input): ResultOnlyGapCandidate {
	const { source, priorEnvelopeSha256, priorObjectiveJson, priorCheckpointJson, result } = input;
	if (!object(source) || !keys(source, ["runId", "runAttempt", "commit"]) ||
		!/^[1-9][0-9]{0,17}$/.test(source.runId) || !Number.isSafeInteger(source.runAttempt) ||
		source.runAttempt <= 0 || !/^[0-9a-f]{40}$/.test(source.commit) ||
		!/^[0-9a-f]{64}$/.test(priorEnvelopeSha256) ||
		result.objectiveJson !== priorObjectiveJson) bad();
	const prior = json(priorCheckpointJson), checkpoint = json(result.checkpointJson);
	const objective = json(result.objectiveJson), status = json(result.statusJson),
		census = json(result.censusJson);
	if (!object(prior) || !object(checkpoint) || !object(objective) ||
		!Array.isArray(prior.boundedRuns) || !Array.isArray(checkpoint.boundedRuns) ||
		!prior.boundedRuns.every((row: unknown) => object(row) && typeof row.runId === "string") ||
		!same(checkpoint.boundedRuns, prior.boundedRuns) ||
		!same(checkpoint.selectedArtifacts, prior.selectedArtifacts) ||
		!same(checkpoint.contract, objective) || !same(prior.contract, objective) ||
		checkpoint.objectiveOutcome !== "incomplete" || !object(status) ||
		status.version !== 1 || status.outcome !== "incomplete" ||
		(status.runId !== null && status.runId !== source.runId) ||
		!object(status.originalObjective) ||
		status.originalObjective.id !== objective.id ||
		status.originalObjective.outcome !== checkpoint.objectiveOutcome ||
		status.originalObjective.stopReason !== checkpoint.stopReason ||
		!object(status.budget)) bad();
	const budget = status.budget;
	if (budget.accountingMode !== "observed-only" || budget.active !== false ||
		budget.activePrompts !== 0 || budget.stopped !== false ||
		!Number.isSafeInteger(budget.reservations) || budget.reservations < 0 ||
		!Number.isSafeInteger(budget.unpricedRequestCount) || budget.unpricedRequestCount < 0 ||
		budget.unpricedRequestCount > budget.reservations ||
		![budget.settledCny, budget.unknownReservedCny, budget.inFlightReservedCny,
			budget.currentCommittedCny, budget.priorCommittedCny, budget.missionCommittedCny,
			budget.committedCny].every(nano) || budget.inFlightReservedCny !== 0 ||
		Math.ceil(budget.currentCommittedCny * 1e9) !==
			Math.ceil((budget.settledCny + budget.unknownReservedCny) * 1e9) ||
		Math.ceil(budget.missionCommittedCny * 1e9) !==
			Math.ceil((budget.priorCommittedCny + budget.currentCommittedCny) * 1e9) ||
		Math.ceil(budget.committedCny * 1e9) !== Math.ceil(budget.missionCommittedCny * 1e9)) bad();
	if (!object(census) || !keys(census, ["version", "kind", "source", "priorEnvelopeSha256",
		"historicalGoalRunIds", "goals", "sessions", "requestIds"]) ||
		census.version !== 1 || census.kind !== "m07-host-effect-census" ||
		!object(census.source) || !keys(census.source, ["runId", "runAttempt", "commit"]) ||
		!same(census.source, source) || census.priorEnvelopeSha256 !== priorEnvelopeSha256 ||
		!Array.isArray(census.historicalGoalRunIds) ||
		!same(census.historicalGoalRunIds, prior.boundedRuns.map((row: any) => row.runId)) ||
		!Array.isArray(census.goals) || census.goals.length !== 0 ||
		!Array.isArray(census.sessions) ||
		!Array.isArray(census.requestIds) || census.requestIds.length !== budget.reservations ||
		!census.requestIds.every((id: unknown) => typeof id === "string" &&
			/^[A-Za-z0-9._:-]{1,128}$/.test(id)) ||
		new Set(census.requestIds).size !== census.requestIds.length) bad();
	const sessionIds = new Set<string>();
	for (const session of census.sessions) {
		if (!object(session) || !keys(session, ["sessionId", "kind"]) ||
			!/^[0-9a-f]{64}$/.test(session.sessionId) || sessionIds.has(session.sessionId) ||
			!(["none", "read-dir"].includes(session.kind))) bad();
		sessionIds.add(session.sessionId);
	}
	if (budget.reservations > 0 && !census.sessions.some((session: any) => session.kind === "read-dir")) bad();
	return Object.freeze({ version: 1, kind: "non-authoritative-result-only-gap-candidate",
		source: Object.freeze({ ...source }), priorEnvelopeSha256,
		statusSha256: hash(result.statusJson), censusSha256: hash(result.censusJson),
		checkpointSha256: hash(result.checkpointJson),
		requestIds: Object.freeze([...census.requestIds]),
		observedSettledCny: budget.settledCny,
		observedUnknownReservedCny: budget.unknownReservedCny,
		unpricedRequestCount: budget.unpricedRequestCount,
		unreconciledRequestCount: census.requestIds.length });
}
