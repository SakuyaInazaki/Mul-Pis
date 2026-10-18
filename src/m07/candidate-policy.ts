/** Deterministic judgement over already recorded candidate observations.
 *
 * Everything here is pure, replayable code: the same frozen observations always
 * produce the same guard state, score and stall signals. The model proposes
 * candidates; this module decides what the proposal did to the search state.
 * It never schedules, submits or reruns an evaluation, and it never claims
 * causality for a model-declared parent, strategy or location. */
import { candidateSubjectId, globalCandidateBest, type CandidateArchiveEntry } from "./candidate-archive.ts";
import type { CandidateDiagnosticSummaryV1 } from "./candidate-diagnostics.ts";
import { HarnessError } from "../types.ts";
import type { CandidateMetricV1, CandidateObservationV1 } from "./types.ts";

export type CandidateChangeKind = "repair" | "structure" | "parameters";
export type CandidateGuard = "reject" | "keep" | "accept" | "revert";
export type CandidateLane = "repair" | "optimization";
export type CandidatePhase = "bootstrap" | "tuning";
export type CandidateScoreTier = "source-unverified" | "compile-failure" | "incorrect" |
	"near-miss" | "correct-unmeasured" | "correct-measured";

/** Structural strategies come first; the last two bind to a fixed change kind. */
export const CANDIDATE_STRATEGIES = ["tiling", "vectorization", "fusion", "pipeline", "reordering",
	"memory-layout", "instruction-selection", "other-structure", "numerical-parameters", "repair"] as const;
export type CandidateStrategy = typeof CANDIDATE_STRATEGIES[number];

const STRUCTURAL_STRATEGIES: ReadonlySet<CandidateStrategy> = new Set(CANDIDATE_STRATEGIES.slice(0, 8));

/** Relative difference that still counts as the same measurement. Raise it on a
 * platform with noisier timing; it is a frozen policy field, not a constant. */
export const DEFAULT_NOISE_MARGIN = 0.01;
/** The score's performance term saturates at this speedup over the seed. */
const SCORE_SATURATION_SPEEDUP = 2;

export interface CandidateIncumbentComparisonV1 {
	name: string;
	unit: string;
	basisId: string;
	direction: "higher" | "lower";
	incumbentRef: string;
	incumbentValue: number;
	candidateValue: number;
	/** Candidate relative to incumbent in the metric's own improvement direction. */
	relativeGain: number;
	improved: boolean;
	regressed: boolean;
}

export interface CandidatePolicyDecisionV1 {
	version: 1;
	lane: CandidateLane;
	phase: CandidatePhase;
	guard: CandidateGuard;
	/** Layered and bounded in [0, 1]: a near miss outranks a wrong result and
	 * never reaches a correct one. Ranking only; archives keep the raw values. */
	score: number;
	tier: CandidateScoreTier;
	/** Speedup against the goal's first verified-correct candidate for this
	 * subject, worst case over comparable metrics; absent without one. */
	seedRef?: string;
	seedSpeedup?: number;
	incumbentComparison: CandidateIncumbentComparisonV1[];
	/** Does this candidate change the best-so-far pointer? Only a KEEP does. */
	updatesBest: boolean;
	/** Stable identity of an observed failure: stage plus the first witness
	 * location. Equal signatures across rounds are what "no progress" means. */
	failureSignature?: string;
	/** At most one must-fix item and one suggestion, by design. */
	requiredFix: string[];
	advisory: string[];
	reasons: string[];
}

const metricKey = (metric: CandidateMetricV1): string =>
	JSON.stringify([metric.name, metric.unit, metric.basisId, metric.direction]);

const verifiedCorrect = (entry: CandidateArchiveEntry): boolean =>
	entry.observation.sourceBinding === "verified" && entry.observation.correctness === "passed";

/** Metrics that appear exactly once and carry a finite value. */
function uniqueMetrics(metrics: readonly CandidateMetricV1[]): Map<string, CandidateMetricV1> {
	const counts = new Map<string, number>();
	for (const metric of metrics) counts.set(metricKey(metric), (counts.get(metricKey(metric)) ?? 0) + 1);
	const result = new Map<string, CandidateMetricV1>();
	for (const metric of metrics)
		if (counts.get(metricKey(metric)) === 1 && Number.isFinite(metric.value)) result.set(metricKey(metric), metric);
	return result;
}

function relativeGain(reference: CandidateMetricV1, candidate: CandidateMetricV1): number | undefined {
	if (!Number.isFinite(reference.value) || !Number.isFinite(candidate.value) || reference.value === 0) return;
	const change = (candidate.value - reference.value) / Math.abs(reference.value);
	return reference.direction === "lower" ? -change : change;
}

function speedup(reference: CandidateMetricV1, candidate: CandidateMetricV1): number | undefined {
	if (!Number.isFinite(reference.value) || !Number.isFinite(candidate.value) ||
		reference.value <= 0 || candidate.value <= 0) return;
	return reference.direction === "lower" ? reference.value / candidate.value : candidate.value / reference.value;
}

/** Same-subject candidates recorded before the one being judged. */
export function subjectHistory(history: readonly CandidateArchiveEntry[], subjectId?: string): CandidateArchiveEntry[] {
	return history.filter(entry => !subjectId || candidateSubjectId(entry.subjectId, entry.observation) === subjectId);
}

/** Bootstrap lasts until one verified, correct candidate exists for the subject.
 * The switch is a host fact, never an agent declaration. */
export function candidatePhase(history: readonly CandidateArchiveEntry[], subjectId?: string): CandidatePhase {
	return subjectHistory(history, subjectId).some(verifiedCorrect) ? "tuning" : "bootstrap";
}

/** The first verified-correct candidate is a stable scoring reference: unlike the
 * incumbent it does not move, so scores stay comparable across a whole task. */
function seedEntry(history: readonly CandidateArchiveEntry[], subjectId?: string): CandidateArchiveEntry | undefined {
	return subjectHistory(history, subjectId).find(entry => verifiedCorrect(entry) &&
		uniqueMetrics(entry.observation.metrics).size > 0);
}

function compareWithIncumbent(observation: CandidateObservationV1, history: readonly CandidateArchiveEntry[],
	subjectId: string | undefined, margin: number): CandidateIncumbentComparisonV1[] {
	const best = globalCandidateBest(subjectHistory(history, subjectId));
	const candidateMetrics = uniqueMetrics(observation.metrics);
	const comparison: CandidateIncumbentComparisonV1[] = [];
	for (const incumbent of best) {
		const candidate = candidateMetrics.get(metricKey(incumbent.metric));
		if (!candidate) continue;
		const gain = relativeGain(incumbent.metric, candidate);
		if (gain === undefined) continue;
		comparison.push({ name: incumbent.metric.name, unit: incumbent.metric.unit,
			basisId: incumbent.metric.basisId, direction: incumbent.metric.direction,
			incumbentRef: incumbent.candidateRef, incumbentValue: incumbent.metric.value,
			candidateValue: candidate.value, relativeGain: gain,
			improved: gain > margin, regressed: gain < -margin });
	}
	const key = (item: CandidateIncumbentComparisonV1) =>
		JSON.stringify([item.name, item.unit, item.basisId, item.direction]);
	return comparison.sort((left, right) => key(left).localeCompare(key(right)));
}

function scoreOf(tier: CandidateScoreTier, passRatio: number, seedSpeedup?: number): number {
	switch (tier) {
		case "source-unverified": return 0.05;
		case "compile-failure": return 0.1;
		case "incorrect": return 0.2;
		case "near-miss": return 0.2 + 0.2 * passRatio;
		case "correct-unmeasured": return 0.5;
		case "correct-measured":
			return 0.5 + 0.5 * Math.min(1, Math.max(0, (seedSpeedup ?? 1) / SCORE_SATURATION_SPEEDUP));
	}
}

export interface CandidateDecisionInput {
	observation: CandidateObservationV1;
	diagnostics: Pick<CandidateDiagnosticSummaryV1, "stage" | "cases" | "diagnosticLocations">;
	changeKind: CandidateChangeKind;
	intent: "solution" | "diagnostic";
	subjectId?: string;
	/** Same-goal candidates recorded before this one, in archive order. */
	history: readonly CandidateArchiveEntry[];
	noiseMargin?: number;
}

/** Decide what one recorded observation does to the search state. */
export function decideCandidate(input: CandidateDecisionInput): CandidatePolicyDecisionV1 {
	const margin = input.noiseMargin ?? DEFAULT_NOISE_MARGIN;
	const observation = input.observation;
	// Without an unambiguous subject the host cannot keep a best pointer for this
	// work object, so the candidate can only ever be a working point.
	const attributable = input.subjectId !== undefined;
	const phase = attributable ? candidatePhase(input.history, input.subjectId) : "bootstrap";
	const lane: CandidateLane = input.changeKind === "repair" || phase === "bootstrap" ? "repair" : "optimization";
	const cases = input.diagnostics.cases;
	const totalCases = cases.passed + cases.failed + cases.unknown;
	const passRatio = totalCases ? cases.passed / totalCases : 0;
	const reasons: string[] = [];
	const requiredFix: string[] = [];
	const advisory: string[] = [];
	const seed = attributable ? seedEntry(input.history, input.subjectId) : undefined;
	const candidateMetrics = uniqueMetrics(observation.metrics);
	let seedSpeedup: number | undefined;
	if (seed) {
		const seedMetrics = uniqueMetrics(seed.observation.metrics);
		const ratios: number[] = [];
		for (const [key, metric] of seedMetrics) {
			const candidate = candidateMetrics.get(key);
			if (!candidate) continue;
			const ratio = speedup(metric, candidate);
			if (ratio !== undefined) ratios.push(ratio);
		}
		if (ratios.length) seedSpeedup = Math.min(...ratios);
	}
	const unverified = observation.sourceBinding !== "verified" || observation.correctness === "unknown";
	const tier: CandidateScoreTier = unverified ? "source-unverified" :
		observation.correctness === "failed" ? (input.diagnostics.stage === "compile-failure" ? "compile-failure" :
			cases.passed > 0 ? "near-miss" : "incorrect") :
		seedSpeedup === undefined ? "correct-unmeasured" : "correct-measured";
	const incumbentComparison = unverified || observation.correctness !== "passed" || !attributable ? [] :
		compareWithIncumbent(observation, input.history, input.subjectId, margin);
	let guard: CandidateGuard;
	if (unverified) {
		guard = "reject";
		reasons.push("Host could not bind this result to the submitted source, or returned no usable judgement; this is a pre-check rejection and does not count as a search step.");
		requiredFix.push("Reconcile the original operation and receipt identity before submitting another candidate.");
	} else if (observation.correctness === "failed") {
		guard = "revert";
		const location = input.diagnostics.diagnosticLocations[0];
		reasons.push(`Host observed ${input.diagnostics.stage} with ${cases.passed}/${totalCases} cases passed.`);
		requiredFix.push(location
			? `Repair the ${location.category} failure first; the exact receipt field is ${location.fieldPath}.`
			: "Repair the observed correctness failure before any further optimization.");
		const fallback = globalCandidateBest(subjectHistory(input.history, input.subjectId))[0];
		if (fallback) advisory.push(`Continue from the verified ${fallback.candidateRef}, not from this failing source.`);
	} else if (!attributable) {
		guard = "accept";
		reasons.push("The host could not bind this observation to one work object, so it is a working point only; declare the task subjectId to let the best-so-far pointer advance.");
	} else if (!incumbentComparison.length) {
		guard = phase === "bootstrap" ? "keep" : "accept";
		reasons.push(phase === "bootstrap"
			? "First verified-correct candidate for this subject; bootstrap ends here and it becomes the incumbent."
			: "Correct, but no metric is comparable with the incumbent, so it stays a working point without replacing the best.");
	} else if (incumbentComparison.some(item => item.regressed)) {
		guard = "revert";
		const worst = [...incumbentComparison].sort((left, right) => left.relativeGain - right.relativeGain)[0];
		reasons.push(`Correct but regressed beyond the ${margin} noise margin against ${worst.incumbentRef} on ${worst.name}.`);
		requiredFix.push(`Return to ${worst.incumbentRef} before continuing; a regression is not a working point.`);
	} else if (incumbentComparison.some(item => item.improved)) {
		guard = "keep";
		const bestGain = [...incumbentComparison].sort((left, right) => right.relativeGain - left.relativeGain)[0];
		reasons.push(`Correct and better than ${bestGain.incumbentRef} on ${bestGain.name} beyond the noise margin; best-so-far advances.`);
	} else {
		guard = "accept";
		reasons.push("Correct but within the noise margin of the incumbent: retained as a working point, best-so-far unchanged.");
		advisory.push("A correct, equally fast intermediate step is a legitimate parent; declare what it enables next.");
	}
	if (input.intent === "diagnostic" && guard === "revert" && observation.correctness === "failed")
		advisory.push("A declared diagnostic candidate may fail by design; its evidence is kept, but it still cannot become the incumbent.");
	const firstLocation = input.diagnostics.diagnosticLocations[0];
	const failureSignature = observation.correctness === "passed" ? undefined :
		`${input.diagnostics.stage}|${firstLocation ? `${firstLocation.category}:${firstLocation.fieldPath}` : "no-location"}`;
	return { version: 1, lane, phase, guard, score: scoreOf(tier, passRatio, seedSpeedup), tier,
		...(failureSignature ? { failureSignature } : {}),
		...(seed ? { seedRef: seed.ref } : {}), ...(seedSpeedup === undefined ? {} : { seedSpeedup }),
		incumbentComparison, updatesBest: guard === "keep",
		requiredFix: requiredFix.slice(0, 1), advisory: advisory.slice(0, 1), reasons };
}

/** Reject an action that the frozen stage order does not allow yet. The gate is
 * deterministic and cannot be negotiated by the session. */
export function requireAllowedAction(input: { changeKind: CandidateChangeKind; strategy: CandidateStrategy;
	phase: CandidatePhase; parentVerifiedCorrect: boolean }): void {
	if (input.changeKind === "repair" && input.strategy !== "repair")
		throw new HarnessError("m07.candidate-action", "a repair candidate must use strategy repair");
	if (input.changeKind === "parameters" && input.strategy !== "numerical-parameters")
		throw new HarnessError("m07.candidate-action", "a parameters candidate must use strategy numerical-parameters");
	if (input.changeKind === "structure" && !STRUCTURAL_STRATEGIES.has(input.strategy))
		throw new HarnessError("m07.candidate-action", `a structure candidate must use one structural strategy: ${[...STRUCTURAL_STRATEGIES].join(", ")}`);
	if (input.changeKind === "parameters" && input.phase === "bootstrap")
		throw new HarnessError("m07.candidate-phase", "numerical parameter search needs a verified-correct candidate first: stay in bootstrap with repair or structure changes");
	if (input.changeKind === "parameters" && !input.parentVerifiedCorrect)
		throw new HarnessError("m07.candidate-phase", "a parameters candidate must declare a verified-correct parent candidate; search parameters only on a settled structure");
}

export type CandidateStallSignal = "duplicate_code" | "code_cycle" | "no_progress" |
	"category_oscillation" | "stagnation";
/** Where the next step belongs, by observed failure class and depth. A route is
 * an instruction to the session, never an automatic task or goal end. */
export type CandidateRoute = "continue" | "repair-in-place" | "restructure" | "replan";

export interface CandidateRouteLimitsV1 {
	/** Consecutive repair-lane steps on one defect before the structure must change. */
	repairDepth: number;
	/** Consecutive counted steps without a keep before the plan must change. */
	stagnation: number;
	/** Counted steps without a keep that force a different declared direction. */
	directionChange: number;
}

/** Three-level fallback from the basis: debug at most 3, rewrite under the same
 * plan at most 5, then return to planning. */
export const DEFAULT_ROUTE_LIMITS: CandidateRouteLimitsV1 = Object.freeze({
	repairDepth: 3, stagnation: 8, directionChange: 3 });

export interface CandidateSearchStateV1 {
	version: 1;
	phase: CandidatePhase;
	/** Counted steps since the last keep. Pre-check rejects never count. */
	stagnation: number;
	repairDepth: number;
	signals: CandidateStallSignal[];
	forcedDirectionChange: boolean;
	route: CandidateRoute;
	/** Declared directions that produced no measured gain; retry needs new evidence. */
	bannedDirections: Array<{ changeKind: CandidateChangeKind; candidateRef: string; reason: string }>;
	/** Deterministic options, in order. The session still picks and justifies one. */
	recommendedParents: Array<{ candidateRef: string; why: string }>;
	message: string;
}

const COUNTED: ReadonlySet<CandidateGuard> = new Set(["keep", "accept", "revert"]);

/** Recompute the search state from the recorded decisions of one work object.
 * Pure: the same archive always yields the same signals, route and bans. */
export function candidateSearchState(history: readonly CandidateArchiveEntry[], subjectId?: string,
	limits: CandidateRouteLimitsV1 = DEFAULT_ROUTE_LIMITS): CandidateSearchStateV1 {
	const scoped = subjectHistory(history, subjectId);
	const counted = scoped.filter(entry => entry.policy && COUNTED.has(entry.policy.guard));
	const lastKeep = counted.map(entry => entry.policy!.guard).lastIndexOf("keep");
	const trailing = counted.slice(lastKeep + 1);
	const stagnation = trailing.length;
	let repairDepth = 0;
	for (const entry of [...trailing].reverse()) {
		if (entry.policy!.lane !== "repair") break;
		repairDepth++;
	}
	const signals: CandidateStallSignal[] = [];
	const latest = counted.at(-1);
	if (latest?.sourceRepetition) signals.push(latest.sourceRepetition);
	const signatures = trailing.map(entry => entry.policy!.failureSignature).filter(Boolean);
	if (signatures.length >= 3 && new Set(signatures.slice(-3)).size === 1) signals.push("no_progress");
	const window = counted.slice(-5).map(entry => entry.policy!.failureSignature ?? "correct");
	let changes = 0;
	for (let index = 1; index < window.length; index++) if (window[index] !== window[index - 1]) changes++;
	if (window.length >= 5 && changes >= 3) signals.push("category_oscillation");
	if (stagnation >= limits.directionChange) signals.push("stagnation");
	const forcedDirectionChange = signals.length > 0;
	const lastGuard = latest?.policy?.guard;
	const route: CandidateRoute = stagnation >= limits.stagnation ? "replan" :
		repairDepth >= limits.repairDepth ? "restructure" :
		lastGuard === "revert" ? "repair-in-place" :
		forcedDirectionChange ? "restructure" : "continue";
	const bannedDirections = trailing.slice(-5).map(entry => ({
		changeKind: entry.changeKind ?? "structure" as CandidateChangeKind, candidateRef: entry.ref,
		reason: entry.policy!.guard === "revert"
			? "regressed or failed against the verified incumbent"
			: "measured no gain beyond the noise margin" }));
	const best = globalCandidateBest(scoped);
	const recommendedParents: Array<{ candidateRef: string; why: string }> = [];
	for (const item of best) if (!recommendedParents.some(parent => parent.candidateRef === item.candidateRef))
		recommendedParents.push({ candidateRef: item.candidateRef,
			why: `verified best on ${item.metric.name} (${item.metric.basisId})` });
	const workingPoint = [...counted].reverse().find(entry => entry.policy!.guard === "accept");
	if (workingPoint && !recommendedParents.some(parent => parent.candidateRef === workingPoint.ref))
		recommendedParents.push({ candidateRef: workingPoint.ref,
			why: "correct working point that did not advance the best; useful for a step that pays off later" });
	if (forcedDirectionChange) {
		const alternative = [...scoped].reverse().find(entry => entry.policy?.guard === "keep" &&
			!recommendedParents.some(parent => parent.candidateRef === entry.ref));
		if (alternative) recommendedParents.push({ candidateRef: alternative.ref,
			why: "earlier verified lineage, available when the current one has stalled" });
	}
	return { version: 1, phase: candidatePhase(history, subjectId), stagnation, repairDepth, signals,
		forcedDirectionChange, route, bannedDirections, recommendedParents: recommendedParents.slice(0, 4),
		message: forcedDirectionChange
			? "The host detected a stall. The next candidate must declare a different direction than the listed ones, or cite new evidence for repeating one; repeating a banned direction unchanged is not a search step."
			: "No stall signal. Keep the declared direction while it still produces measured gain." };
}
