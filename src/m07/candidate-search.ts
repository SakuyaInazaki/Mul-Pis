/** Read-only search facts derived from the existing same-goal candidate archive.
 * No experiment is scheduled, rejected, or ended by this analysis. */
import type { CandidateArchiveEntry } from "./candidate-archive.ts";
import type { CandidateMetricV1 } from "./types.ts";

type MetricIdentity = Pick<CandidateMetricV1, "name" | "unit" | "basisId" | "direction">;

export interface CandidateCaseFrontierV1 {
	subjectId: string;
	caseId: string;
	/** Every compared candidate has exactly this metric vector, with no duplicate identities. */
	dimensions: MetricIdentity[];
	frontierRefs: string[];
	dominated: Array<{ candidateRef: string; by: string[] }>;
	/** An external evaluation reused by several candidates contributes one measurement. */
	independentMeasurementCount: number;
	frontierMeasurements: Array<{ candidateRefs: string[]; externalId: string; independentCompetitors: number }>;
}

export interface CandidateSearchLeadV1 {
	subjectId: string;
	caseId: string;
	basisIds: string[];
	candidateRefs: string[];
	bindings: Array<{ candidateRef: string; intent: "solution" | "diagnostic";
		correctness: "passed" | "failed" | "unknown";
		/** Legacy field name: host-bound and overall correct, regardless of model intent; not goal admission. */
		solutionParentEligible: boolean }>;
	externalId: string;
	independentCompetitors: number;
	position: "exclusive" | "tradeoff" | "uncontested";
}

export interface CandidateSearchFocusV1 { subjectId?: string; basisId?: string }

export interface CandidateRepeatedSourceObservationV1 {
	sourceGroupRef: string;
	subjectId: string;
	verifierId: string;
	scope: "overall" | "case";
	caseId?: string;
	metric: MetricIdentity;
	contextBasisIds: string[];
	contextCases: Array<{ caseId: string; basisIds: string[] }>;
	/** Distinct usable external IDs, not independently controlled physical trials. */
	count: number;
	min: number;
	median: number;
	max: number;
	measurements: Array<{ externalId: string; value: number;
		/** First archived capture of this external ID, not a device execution timestamp. */
		capturedAt: string; candidateRefs: string[]; verifierVersions: string[] }>;
	/** Only readings with this exact metric and context; not all failed experiments. */
	excludedReadings: { failed: number; unknown: number; conflictingExternalIds: number };
}

export interface CandidateSearchFactsV1 {
	perCaseFrontiers: CandidateCaseFrontierV1[];
	repeatedSourceObservations: CandidateRepeatedSourceObservationV1[];
	/** One row per independent frontier measurement, with all candidate bindings retained. */
	searchLeads: CandidateSearchLeadV1[];
	changeHistory: Array<{ changeKind: "repair" | "structure" | "parameters" | "unspecified";
		/** Attempts/sourceVerified count bindings. Correct/failed count newly seen external
		 * evaluation evidence, so rebinding the same ID is not a new success. */
		attempts: number; sourceVerified: number; correct: number; failed: number; unknown: number }>;
	repetition: Array<{ candidateRef: string; kind: "duplicate_code" | "code_cycle";
		identicalSourceRefs: string[] }>;
	/** This says only that an exact declared-parent comparison had no measured gain. */
	localNoMeasuredGain: Array<{ candidateRef: string; parentRef: string; comparedMetrics: number;
		regressions: number }>;
	/** Options, not an automatic parent selection. Caller must pass entries with available frozen files. */
	explorationParents: Array<{ candidateRef: string; category: "verified-correct" | "verified-negative";
		intent: "solution" | "diagnostic"; passedCases: number; failedCases: number;
		unknownCases: number }>;
	limitations: string[];
}

const identity = (metric: CandidateMetricV1): MetricIdentity => ({ name: metric.name, unit: metric.unit,
	basisId: metric.basisId, direction: metric.direction });
const key = (metric: MetricIdentity) => JSON.stringify([metric.name, metric.unit, metric.basisId, metric.direction]);

function vector(metrics: readonly CandidateMetricV1[]): { dimensions: MetricIdentity[]; values: number[] } | undefined {
	if (!metrics.length || metrics.some(metric => !Number.isFinite(metric.value))) return;
	const sorted = [...metrics].sort((left, right) => key(left).localeCompare(key(right)));
	if (new Set(sorted.map(key)).size !== sorted.length) return;
	return { dimensions: sorted.map(identity), values: sorted.map(metric => metric.value) };
}

function dominates(left: { values: number[] }, right: { values: number[] }, dimensions: readonly MetricIdentity[]): boolean {
	let strictlyBetter = false;
	for (let index = 0; index < dimensions.length; index++) {
		const better = dimensions[index].direction === "higher" ? left.values[index] > right.values[index] : left.values[index] < right.values[index];
		const worse = dimensions[index].direction === "higher" ? left.values[index] < right.values[index] : left.values[index] > right.values[index];
		if (worse) return false;
		if (better) strictlyBetter = true;
	}
	return strictlyBetter;
}

/** Describe already recorded values for byte-identical sources; never rank or admit them. */
function repeatedSourceObservations(entries: readonly CandidateArchiveEntry[]): CandidateRepeatedSourceObservationV1[] {
	type Correctness = "passed" | "failed" | "unknown";
	type Reading = CandidateRepeatedSourceObservationV1["measurements"][number] & {
		correctness: Correctness; conflict: boolean;
	};
	type Group = Pick<CandidateRepeatedSourceObservationV1,
		"sourceGroupRef" | "subjectId" | "verifierId" | "scope" | "caseId" | "metric" | "contextBasisIds" | "contextCases"> &
		{ readings: Map<string, Reading> };
	const groups = new Map<string, Group>();
	for (const entry of entries) {
		const observation = entry.observation;
		const sourceGroupRef = entry.sourceGroupRef;
		// Only the snapshot's current byte comparison establishes source groups.
		// Persisted repetition labels or old identicalSourceRefs are insufficient.
		if (!sourceGroupRef || observation.sourceBinding !== "verified") continue;
		const evaluations = observation.executionFacts?.evaluations ?? [];
		const terminal = evaluations.filter(item => item.terminal);
		const context = (cases: typeof terminal[number]["cases"]) => cases.map(item => ({
			caseId: item.caseId, basisIds: [...new Set([
				...item.metrics.map(metric => metric.basisId), ...(item.performance ? [item.performance.basisId] : []),
			])].sort(),
		})).sort((left, right) => left.caseId.localeCompare(right.caseId) ||
			JSON.stringify(left.basisIds).localeCompare(JSON.stringify(right.basisIds)));
		const add = (evaluation: typeof terminal[number], scope: "overall" | "case", caseId: string | undefined,
			metrics: readonly CandidateMetricV1[], contextCases: CandidateRepeatedSourceObservationV1["contextCases"], correctness: Correctness,
			ambiguousCase = false) => {
			const contextBasisIds = [...new Set(contextCases.flatMap(item => item.basisIds))].sort();
			const counts = new Map<string, number>();
			for (const metric of metrics) counts.set(key(metric), (counts.get(key(metric)) ?? 0) + 1);
			const seen = new Set<string>();
			for (const metric of metrics) {
				const metricKey = key(metric);
				if (!Number.isFinite(metric.value) || seen.has(metricKey)) continue;
				seen.add(metricKey);
				const groupKey = JSON.stringify([sourceGroupRef, evaluation.subjectId,
					observation.verifier.id, scope, caseId, metricKey, contextCases]);
				let group = groups.get(groupKey);
				if (!group) {
					group = { sourceGroupRef, subjectId: evaluation.subjectId,
						verifierId: observation.verifier.id, scope, ...(caseId === undefined ? {} : { caseId }),
						metric: identity(metric), contextBasisIds, contextCases, readings: new Map() };
					groups.set(groupKey, group);
				}
				const conflict = ambiguousCase || counts.get(metricKey) !== 1;
				const prior = group.readings.get(evaluation.externalId);
				if (!prior) group.readings.set(evaluation.externalId, { externalId: evaluation.externalId,
					value: metric.value, capturedAt: evaluation.capturedAt, candidateRefs: [entry.ref],
					verifierVersions: [observation.verifier.version], correctness, conflict });
				else {
					if (!prior.candidateRefs.includes(entry.ref)) prior.candidateRefs.push(entry.ref);
					if (!prior.verifierVersions.includes(observation.verifier.version))
						prior.verifierVersions.push(observation.verifier.version);
					prior.conflict ||= conflict || prior.value !== metric.value || prior.correctness !== correctness;
				}
			}
		};
		for (const evaluation of terminal) {
			if (!evaluation.externalId.trim()) continue;
			if (entry.subjectId && entry.subjectId !== evaluation.subjectId) continue;
			if (terminal.length === 1) add(evaluation, "overall", undefined, observation.metrics,
				context(evaluation.cases), observation.correctness);
			const counts = new Map<string, number>();
			for (const item of evaluation.cases) counts.set(item.caseId, (counts.get(item.caseId) ?? 0) + 1);
			for (const item of evaluation.cases) add(evaluation, "case", item.caseId, item.metrics,
				context([item]), item.correctness, counts.get(item.caseId) !== 1);
		}
	}
	// One exact external reading cannot establish two different case/context
	// mappings. Exclude every conflicting binding, not one sample in each group.
	const externalContexts = new Map<string, { contexts: Set<string>; readings: Reading[] }>();
	for (const group of groups.values()) for (const reading of group.readings.values()) {
		const externalKey = JSON.stringify([group.sourceGroupRef, group.subjectId, group.verifierId,
			group.scope, group.caseId, key(group.metric), reading.externalId]);
		const context = JSON.stringify(group.contextCases);
		const prior = externalContexts.get(externalKey);
		if (!prior) externalContexts.set(externalKey, { contexts: new Set([context]), readings: [reading] });
		else {
			prior.readings.push(reading);
			prior.contexts.add(context);
			if (prior.contexts.size > 1) for (const item of prior.readings) item.conflict = true;
		}
	}
	const summaries: CandidateRepeatedSourceObservationV1[] = [];
	for (const { readings, ...group } of groups.values()) {
		const excludedReadings = { failed: 0, unknown: 0, conflictingExternalIds: 0 };
		const measurements: CandidateRepeatedSourceObservationV1["measurements"] = [];
		for (const { correctness, conflict, ...measurement } of readings.values()) {
			if (conflict) excludedReadings.conflictingExternalIds++;
			else if (correctness !== "passed") excludedReadings[correctness]++;
			else measurements.push(measurement);
		}
		if (measurements.length < 2) continue;
		const values = measurements.map(item => item.value).sort((left, right) => left - right);
		const middle = Math.floor(values.length / 2);
		const median = values.length % 2 ? values[middle] : values[middle - 1] / 2 + values[middle] / 2;
		summaries.push({ ...group, count: measurements.length, min: values[0], median,
			max: values.at(-1)!, measurements, excludedReadings });
	}
	return summaries;
}

/** Derive per-case Pareto facts only for terminal, passed cases on identical
 * metric identities and bases. A failed overall candidate can still contribute
 * a valid case observation, but this never promotes it to goal best. */
export function analyzeCandidateSearch(entries: readonly CandidateArchiveEntry[]): CandidateSearchFactsV1 {
	const groups = new Map<string, { subjectId: string; caseId: string; dimensions: MetricIdentity[];
		members: Array<{ candidateRef: string; values: number[]; externalId: string; measurementKey: string }> }>();
	const changeHistory = new Map<"repair" | "structure" | "parameters" | "unspecified",
		CandidateSearchFactsV1["changeHistory"][number]>();
	const repetition: CandidateSearchFactsV1["repetition"] = [];
	const localNoMeasuredGain: CandidateSearchFactsV1["localNoMeasuredGain"] = [];
	const explorationParents: CandidateSearchFactsV1["explorationParents"] = [];
	const seenExternalEvaluations = new Set<string>();
	const byRef = new Map(entries.map(entry => [entry.ref, entry]));
	let missingCaseMetrics = 0, ambiguousCases = 0, conflictingMeasurements = 0;
	for (const entry of entries) {
		const observation = entry.observation;
		const kind = entry.changeKind ?? "unspecified";
		const history = changeHistory.get(kind) ?? { changeKind: kind, attempts: 0,
			sourceVerified: 0, correct: 0, failed: 0, unknown: 0 };
		history.attempts++;
		if (observation.sourceBinding === "verified") {
			history.sourceVerified++;
			const externalKeys = [...new Set((observation.executionFacts?.evaluations ?? [])
				.filter(evaluation => evaluation.terminal && evaluation.externalId.trim())
				.map(evaluation => JSON.stringify([observation.verifier.id, evaluation.externalId, evaluation.subjectId])))];
			const hasNewEvidence = !externalKeys.length || externalKeys.some(evidenceKey => !seenExternalEvaluations.has(evidenceKey));
			for (const evidenceKey of externalKeys) seenExternalEvaluations.add(evidenceKey);
			if (hasNewEvidence) {
				if (observation.correctness === "passed") history.correct++;
				else if (observation.correctness === "failed") history.failed++;
				else history.unknown++;
			}
		} else history.unknown++;
		changeHistory.set(kind, history);
		if (entry.sourceRepetition) repetition.push({ candidateRef: entry.ref,
			kind: entry.sourceRepetition, identicalSourceRefs: entry.identicalSourceRefs ?? [] });
		const comparison = entry.parentComparison;
		if (entry.parentRef && comparison && observation.sourceBinding === "verified") {
			const deltas = [...comparison.comparableMetrics,
				...comparison.caseChanges.flatMap(change => change.comparableMetrics)];
			if (deltas.length && deltas.every(delta => !delta.improved) &&
				comparison.caseChanges.every(change => change.parentCorrectness === change.candidateCorrectness &&
					change.parentStatus === change.candidateStatus))
				localNoMeasuredGain.push({ candidateRef: entry.ref,
					parentRef: `${entry.parentRef.taskId}/${entry.parentRef.candidateId}`,
					comparedMetrics: deltas.length, regressions: deltas.filter(delta => delta.regressed).length });
		}
		if (observation.sourceBinding !== "verified") continue;
		const counts = { passed: 0, failed: 0, unknown: 0 };
		const casesByKey = new Map<string, { subjectId: string; caseId: string;
			metrics: CandidateMetricV1[]; externalId: string }>();
		const seenCases = new Set<string>();
		const ambiguous = new Set<string>();
		for (const evaluation of observation.executionFacts?.evaluations ?? []) {
			if (!evaluation.terminal) continue;
			for (const item of evaluation.cases) {
				counts[item.correctness]++;
				const caseKey = JSON.stringify([evaluation.subjectId, item.caseId]);
				if (seenCases.has(caseKey)) ambiguous.add(caseKey);
				seenCases.add(caseKey);
				if (item.correctness !== "passed") continue;
				if (!casesByKey.has(caseKey)) casesByKey.set(caseKey, { subjectId: evaluation.subjectId, caseId: item.caseId,
					metrics: item.metrics, externalId: evaluation.externalId });
			}
		}
		if (observation.correctness === "passed" || observation.correctness === "failed")
			explorationParents.push({ candidateRef: entry.ref, category: observation.correctness === "passed" ?
				"verified-correct" : "verified-negative", intent: entry.intent,
				passedCases: counts.passed, failedCases: counts.failed, unknownCases: counts.unknown });
		for (const [caseKey, item] of casesByKey) {
			if (ambiguous.has(caseKey)) { ambiguousCases++; continue; }
			const measured = vector(item.metrics);
			if (!measured) { missingCaseMetrics++; continue; }
			const groupKey = JSON.stringify([item.subjectId, item.caseId, measured.dimensions.map(key)]);
			const group = groups.get(groupKey) ?? { subjectId: item.subjectId, caseId: item.caseId,
				dimensions: measured.dimensions, members: [] };
			const measurementKey = item.externalId.trim() ? JSON.stringify([observation.verifier.id,
				item.externalId, item.subjectId, item.caseId,
				measured.dimensions.map(key)]) : JSON.stringify([entry.ref, item.subjectId, item.caseId,
				measured.dimensions.map(key)]);
			group.members.push({ candidateRef: entry.ref, values: measured.values,
				externalId: item.externalId, measurementKey });
			groups.set(groupKey, group);
		}
	}
	const searchLeads: CandidateSearchLeadV1[] = [];
	const perCaseFrontiers = [...groups.values()].map(group => {
		const independent = new Map<string, { candidateRefs: string[]; values: number[]; externalId: string; conflict: boolean }>();
		for (const member of group.members) {
			const prior = independent.get(member.measurementKey);
			if (!prior) independent.set(member.measurementKey, { candidateRefs: [member.candidateRef],
				values: member.values, externalId: member.externalId, conflict: false });
			else {
				prior.candidateRefs.push(member.candidateRef);
				if (prior.values.some((value, index) => value !== member.values[index])) prior.conflict = true;
			}
		}
		const measurements = [...independent.values()].filter(item => {
			if (!item.conflict) return true;
			conflictingMeasurements++;
			return false;
		});
		const dominated: CandidateCaseFrontierV1["dominated"] = [];
		const frontierRefs: string[] = [];
		const frontierMeasurements: CandidateCaseFrontierV1["frontierMeasurements"] = [];
		for (const candidate of measurements) {
			const by = measurements.filter(other => other !== candidate && dominates(other, candidate, group.dimensions))
				.flatMap(other => other.candidateRefs);
			if (by.length) dominated.push(...candidate.candidateRefs.map(candidateRef => ({ candidateRef, by })));
			else {
				frontierRefs.push(...candidate.candidateRefs);
				frontierMeasurements.push({ candidateRefs: candidate.candidateRefs,
					externalId: candidate.externalId, independentCompetitors: measurements.length - 1 });
			}
		}
		for (const item of frontierMeasurements) searchLeads.push({ subjectId: group.subjectId,
			caseId: group.caseId, basisIds: [...new Set(group.dimensions.map(dimension => dimension.basisId))],
			candidateRefs: item.candidateRefs,
			bindings: item.candidateRefs.map(candidateRef => {
				const entry = byRef.get(candidateRef)!;
				return { candidateRef, intent: entry.intent, correctness: entry.observation.correctness,
					solutionParentEligible: entry.observation.sourceBinding === "verified" && entry.observation.correctness === "passed" };
			}),
			externalId: item.externalId,
			independentCompetitors: item.independentCompetitors,
			position: measurements.length < 2 ? "uncontested" : frontierMeasurements.length === 1 ? "exclusive" : "tradeoff" });
		return { subjectId: group.subjectId, caseId: group.caseId,
			dimensions: group.dimensions, frontierRefs, dominated,
			independentMeasurementCount: measurements.length, frontierMeasurements };
	});
	return { perCaseFrontiers, repeatedSourceObservations: repeatedSourceObservations(entries),
		searchLeads, changeHistory: [...changeHistory.values()], repetition,
		localNoMeasuredGain, explorationParents,
		limitations: ["Pareto groups are case-local, use exact metric identities and are not whole-goal rankings.",
				"A reused verifier/external ID is one measurement across verifier versions when subject, case and metric identities match; distinct IDs do not prove independent physical trials.",
			"Change-history attempts count candidate bindings; correct and failed count newly seen external evaluation IDs when available, without proving independent physical trials.",
			"Change kind, parent and applicability conditions are model declarations, not proven causal effects.",
			"Local no-gain covers only comparable parent metrics; newly observed cases or unmeasured effects remain outside that fact.",
			"No fixed search budget, parent choice, route ban or hardware bottleneck follows from these facts.",
			"Repeated-source ranges describe recorded values on matching declared bases, not statistical noise, confidence intervals, stable speed or independent physical trials. Baseline values and unrecorded conditions can still change; no retest or ranking decision follows.",
			"Repeated-source excluded readings count only distinct external IDs with the exact displayed metric and context. Missing metrics, IDs or source groups are not inferred; failed/unknown counts are not totals of all failed experiments. Capture time is the first archived observation of an ID.",
			...(missingCaseMetrics ? [`${missingCaseMetrics} passed case observations lack an unambiguous finite metric vector.`] : []),
			...(ambiguousCases ? [`${ambiguousCases} repeated subject/case observations were excluded from Pareto comparison.`] : []),
			...(conflictingMeasurements ? [`${conflictingMeasurements} reused external measurement IDs had conflicting values and were excluded from Pareto comparison.`] : [])] };
}

/** Keep the first view near the current task. A single evaluation can use a
 * different basis for every case, so only an explicit caller basis may narrow it. */
export function candidateSearchFocus(entries: readonly CandidateArchiveEntry[], preferredSubjectId?: string): CandidateSearchFocusV1 {
	const seen = new Set<string>();
	const evaluationKey = (entry: CandidateArchiveEntry, evaluation: { externalId: string; subjectId: string }, index: number) =>
		evaluation.externalId.trim()
			? JSON.stringify([entry.observation.verifier.id, evaluation.externalId, evaluation.subjectId])
			: JSON.stringify([entry.ref, index, evaluation.subjectId]);
	let subjectId = preferredSubjectId;
	for (const entry of entries) {
		if (entry.observation.sourceBinding !== "verified") continue;
		for (const [evaluationIndex, evaluation] of (entry.observation.executionFacts?.evaluations ?? []).entries()) {
			if (!evaluation.terminal) continue;
			const identity = evaluationKey(entry, evaluation, evaluationIndex);
			if (seen.has(identity)) continue;
			seen.add(identity);
			if (!preferredSubjectId) subjectId = evaluation.subjectId;
		}
	}
	return subjectId ? { subjectId } : {};
}

export function scopedSearchLeads(facts: CandidateSearchFactsV1, entries: readonly CandidateArchiveEntry[],
	focus: CandidateSearchFocusV1): CandidateSearchLeadV1[] {
	const recency = new Map(entries.map((entry, index) => [entry.ref, index]));
	const ordered = facts.searchLeads.filter(lead => (!focus.subjectId || lead.subjectId === focus.subjectId) &&
		(!focus.basisId || lead.basisIds.includes(focus.basisId)))
		.sort((left, right) => {
			// Rebinding one old external evaluation must not make it a new trial.
			const newest = (item: CandidateSearchLeadV1) => Math.min(...item.candidateRefs.map(ref => recency.get(ref) ?? -1));
			return newest(right) - newest(left) ||
				({ exclusive: 0, tradeoff: 1, uncontested: 2 })[left.position] -
				({ exclusive: 0, tradeoff: 1, uncontested: 2 })[right.position] ||
				left.caseId.localeCompare(right.caseId);
		});
	// A single candidate can have hundreds of case rows. Interleave candidate
	// groups so the first page still exposes other measured search directions.
	const buckets = new Map<string, CandidateSearchLeadV1[]>();
	for (const lead of ordered) {
		const bucketKey = JSON.stringify(lead.candidateRefs);
		const bucket = buckets.get(bucketKey) ?? [];
		bucket.push(lead);
		buckets.set(bucketKey, bucket);
	}
	const result: CandidateSearchLeadV1[] = [];
	for (let index = 0; result.length < ordered.length; index++)
		for (const bucket of buckets.values()) if (bucket[index]) result.push(bucket[index]);
	return result;
}

export function candidateSearchBrief(facts: CandidateSearchFactsV1, entries: readonly CandidateArchiveEntry[],
	focus: CandidateSearchFocusV1) {
	const leads = scopedSearchLeads(facts, entries, focus);
	const repeated = scopedRepeatedSourceObservations(facts, focus, entries);
	const byRef = new Map(entries.map(entry => [entry.ref, entry]));
	const diagnosticRefs: string[] = [];
	const seenDiagnosticEvaluations = new Set<string>();
	for (const parent of [...facts.explorationParents].reverse()) {
		if (parent.intent !== "diagnostic" && parent.category !== "verified-negative") continue;
		const entry = byRef.get(parent.candidateRef);
		if (!entry || focus.subjectId && !entry.observation.executionFacts?.evaluations
			.some(evaluation => evaluation.subjectId === focus.subjectId)) continue;
		const terminal = entry.observation.executionFacts?.evaluations.filter(evaluation => evaluation.terminal) ?? [];
		const evaluationKey = terminal.length && terminal.every(evaluation => evaluation.externalId.trim())
			? JSON.stringify([entry.observation.verifier.id, [...new Set(terminal.map(evaluation =>
				JSON.stringify([evaluation.externalId, evaluation.subjectId])))].sort()]) : undefined;
		if (evaluationKey && seenDiagnosticEvaluations.has(evaluationKey)) continue;
		if (evaluationKey) seenDiagnosticEvaluations.add(evaluationKey);
		diagnosticRefs.push(parent.candidateRef);
		if (diagnosticRefs.length === 3) break;
	}
	return { focus, independentLeadCount: leads.length, leads: leads.slice(0, 3),
		omittedLeads: Math.max(0, leads.length - 3), diagnosticRefs,
		repeatedSourceObservations: repeated.slice(0, 3).map(({ measurements, contextCases, contextBasisIds, ...summary }) => {
			const candidateRefs = [...new Set(measurements.flatMap(item => item.candidateRefs))];
			return { ...summary, contextCaseCount: contextCases.length, contextBasisCount: contextBasisIds.length,
				candidateRefs: candidateRefs.slice(0, 3),
				omittedCandidateRefs: Math.max(0, candidateRefs.length - 3) };
		}),
		repeatedSourceObservationCount: repeated.length,
		omittedRepeatedSourceObservations: Math.max(0, repeated.length - 3),
		readRepeatedSourceObservations: { tool: "candidate_list",
			args: { section: "repeated-source", ...focus, offset: 0, limit: 50 } },
		readLeads: { tool: "candidate_list", args: { section: "search-leads", ...focus, offset: 0, limit: 50 } },
		message: "These are per-case measured frontier leads, not a whole-goal ranking or required next parent. Shared candidate refs may bind one external measurement. Repeated-source count is the number of deduplicated usable external evaluation IDs; min/median/max describe retained readings only. Different IDs do not establish independent physical trials, noise, or benefit. Full context mappings and readings are available through readRepeatedSourceObservations. Diagnostic refs include negative results and diagnostic-intent experiments even when correct. The legacy solutionParentEligible flag means host-bound and overall correct regardless of intent; it does not establish the original goal. Inspect frozen evidence and choose the next hypothesis yourself." };
}

/** The same exact filters serve immediate feedback and paged read-only projections. */
export function scopedRepeatedSourceObservations(facts: CandidateSearchFactsV1,
	focus: CandidateSearchFocusV1, entries: readonly CandidateArchiveEntry[]): CandidateRepeatedSourceObservationV1[] {
	const externalKey = (sourceGroupRef: string, subjectId: string, verifierId: string, externalId: string) =>
		JSON.stringify([sourceGroupRef, subjectId, verifierId, externalId]);
	const firstBindings = new Map<string, number>();
	for (const [index, entry] of entries.entries()) {
		if (!entry.sourceGroupRef || entry.observation.sourceBinding !== "verified") continue;
		for (const evaluation of entry.observation.executionFacts?.evaluations ?? []) {
			if (!evaluation.terminal || !evaluation.externalId.trim() ||
				entry.subjectId && entry.subjectId !== evaluation.subjectId) continue;
			const identity = externalKey(entry.sourceGroupRef, evaluation.subjectId,
				entry.observation.verifier.id, evaluation.externalId);
			if (!firstBindings.has(identity)) firstBindings.set(identity, index);
		}
	}
	const selected = facts.repeatedSourceObservations.filter(item =>
		(!focus.subjectId || item.subjectId === focus.subjectId) &&
		(!focus.basisId || item.metric.basisId === focus.basisId));
	const recency = (item: CandidateRepeatedSourceObservationV1) => item.measurements.reduce((latest, measurement) =>
		Math.max(latest, firstBindings.get(externalKey(item.sourceGroupRef, item.subjectId,
			item.verifierId, measurement.externalId)) ?? -1), -1);
	const buckets = new Map<string, { latest: number; rows: CandidateRepeatedSourceObservationV1[] }>();
	for (const item of selected) {
		const bucket = buckets.get(item.sourceGroupRef) ?? { latest: -1, rows: [] };
		bucket.latest = Math.max(bucket.latest, recency(item));
		bucket.rows.push(item);
		buckets.set(item.sourceGroupRef, bucket);
	}
	const ordered = [...buckets.values()].sort((left, right) => right.latest - left.latest);
	for (const bucket of ordered) bucket.rows.sort((left, right) => recency(right) - recency(left) ||
		Number(left.scope === "case") - Number(right.scope === "case"));
	const result: CandidateRepeatedSourceObservationV1[] = [];
	for (let index = 0; result.length < selected.length; index++)
		for (const bucket of ordered) if (bucket.rows[index]) result.push(bucket.rows[index]);
	return result;
}
