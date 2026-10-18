import type { CandidateCaseObservationV1, CandidateMetricV1, CandidateObservationV1 } from "./types.ts";
import { describeProfileBottleneck, interpretProfileBottleneck, type ProfileBottleneckV1 } from "./profile-bottleneck.ts";

/** Values are normalized by a trusted host, with a field path into one frozen
 * original receipt. This is optional because most platforms expose no profile. */
export interface MeasuredPerformanceQuantityV1 {
	value: number;
	receiptIndex: number;
	fieldPath: string;
}

export interface CandidatePerformanceEvidenceV1 {
	basisId: string;
	elapsedSeconds?: MeasuredPerformanceQuantityV1;
	operations?: MeasuredPerformanceQuantityV1;
	bytesMoved?: MeasuredPerformanceQuantityV1;
	peakOperationsPerSecond?: MeasuredPerformanceQuantityV1;
	peakBytesPerSecond?: MeasuredPerformanceQuantityV1;
	timingSamplesSeconds?: { values: number[]; receiptIndex: number; fieldPath: string };
	/** Round-aligned ratios against independently executed named baselines. */
	pairedBaselineRatios?: Array<{ name: string; values: number[]; receiptIndex: number; fieldPath: string }>;
	/** Instrumented launch has its own basis; never replace unprofiled timing. */
	profiledLaunch?: Omit<CandidatePerformanceEvidenceV1, "profiledLaunch" | "pairedBaselineRatios">;
	counters?: Array<MeasuredPerformanceQuantityV1 & { name: string; unit: string; sourceLocation?: string }>;
}

/** Use from the host observation validator before accepting normalized profile
 * facts. It validates shape and provenance, not the physical truth of a peak. */
export function validCandidatePerformanceEvidence(value: CandidatePerformanceEvidenceV1,
	receiptCount: number): boolean {
	const label = (text: unknown, max: number) => typeof text === "string" && !!text.trim() && text.length <= max && !text.includes("\0");
	const location = (item: unknown): item is { receiptIndex: number; fieldPath: string } =>
		!!item && typeof item === "object" && Number.isSafeInteger((item as { receiptIndex?: unknown }).receiptIndex) &&
		(item as { receiptIndex: number }).receiptIndex >= 0 &&
		(item as { receiptIndex: number }).receiptIndex < receiptCount &&
		label((item as { fieldPath?: unknown }).fieldPath, 512);
	const quantity = (item: MeasuredPerformanceQuantityV1 | undefined, positive: boolean) => item === undefined ||
		location(item) && Number.isFinite(item.value) && (positive ? item.value > 0 : item.value >= 0);
	if (!value || !label(value.basisId, 256) ||
		!quantity(value.elapsedSeconds, true) || !quantity(value.operations, false) ||
		!quantity(value.bytesMoved, false) || !quantity(value.peakOperationsPerSecond, true) ||
		!quantity(value.peakBytesPerSecond, true)) return false;
	const samples = value.timingSamplesSeconds;
	if (samples !== undefined && (!location(samples) || !Array.isArray(samples.values) || !samples.values.length ||
		samples.values.some(sample => !Number.isFinite(sample) || sample <= 0))) return false;
	if (value.pairedBaselineRatios !== undefined && (!samples || !Array.isArray(value.pairedBaselineRatios) ||
		value.pairedBaselineRatios.some(ratios => !location(ratios) || !label(ratios.name, 128) ||
			!Array.isArray(ratios.values) || ratios.values.length !== samples.values.length ||
			ratios.values.some(ratio => !Number.isFinite(ratio) || ratio <= 0)) ||
		new Set(value.pairedBaselineRatios.map(item => item.name)).size !== value.pairedBaselineRatios.length)) return false;
	if (value.profiledLaunch !== undefined && (value.profiledLaunch.basisId === value.basisId ||
		!validCandidatePerformanceEvidence(value.profiledLaunch, receiptCount))) return false;
	if (value.counters !== undefined && (!Array.isArray(value.counters) || value.counters.some(counter =>
		!location(counter) || !Number.isFinite(counter.value) || !label(counter.name, 128) ||
		!label(counter.unit, 64) || (counter.sourceLocation !== undefined && !label(counter.sourceLocation, 512))))) return false;
	return Boolean(value.elapsedSeconds || value.operations || value.bytesMoved ||
		value.peakOperationsPerSecond || value.peakBytesPerSecond || samples || value.counters?.length || value.profiledLaunch);
}

export interface CandidateMetricDeltaV1 {
	name: string;
	unit: string;
	basisId: string;
	direction: "higher" | "lower";
	parentValue: number;
	candidateValue: number;
	/** Candidate minus parent, in the original unit. */
	delta: number;
	improved: boolean;
	regressed: boolean;
}

export interface CandidateCaseChangeV1 {
	/** Older persisted comparisons may contain only a case ID. */
	subjectId?: string;
	caseId: string;
	parentStatus: string;
	candidateStatus: string;
	parentCorrectness: "passed" | "failed" | "unknown";
	candidateCorrectness: "passed" | "failed" | "unknown";
	comparableMetrics: CandidateMetricDeltaV1[];
}

export interface CandidateComparisonV1 {
	comparableMetrics: CandidateMetricDeltaV1[];
	caseChanges: CandidateCaseChangeV1[];
	summary: string[];
}

/** Mechanical interpretation of host observations. It is not a profiler model or
 * a claim that the reported stage explains the underlying kernel bottleneck. */
export interface CandidateDiagnosticSummaryV1 {
	stage: "source-unverified" | "pending-or-unknown" | "compile-failure" | "numerical-failure" |
		"runtime-failure" | "mixed-failure" | "correctness-failure" | "correct-measured" | "correct-unmeasured";
	hostStage: string;
	terminalEvaluations: number;
	nonterminalEvaluations: number;
	cases: { passed: number; failed: number; unknown: number };
	diagnostics: { compile: number; numerical: number; runtime: number; unknown: number };
	/** Exact receipt fields to inspect; these are locations, not model diagnoses. */
	diagnosticLocations: Array<{ subjectId: string; externalId: string; receiptIndex: number;
		category: "compile" | "numerical" | "runtime" | "unknown"; caseId?: string; fieldPath: string }>;
	/** Same-unit, same-basis measured contrasts only; reference semantics are left to the host. */
	referenceContrasts: Array<{ subjectId: string; caseId: string; candidateName: string;
		referenceName: string; unit: string; basisId: string; candidateValue: number;
		referenceValue: number; difference: number; ratio: number | null }>;
	parentMeasuredChange: { improved: number; regressed: number; equal: number;
		correctnessChanges: number } | null;
	inspection: string[];
	profileInterpretations: CandidateProfileInterpretationV1[];
	timingComparisons: CandidateTimingComparisonV1[];
	profilerInterpretation: "unavailable" | "partial" | "derived";
}

export interface CandidateProfileInterpretationV1 {
	subjectId: string;
	caseId: string;
	basisId: string;
	/** Instrumented launch counters never replace the unprofiled timing basis. */
	evidenceKind: "unprofiled" | "instrumented";
	elapsedSeconds?: number;
	arithmeticIntensityOperationsPerByte?: number;
	computeLowerBoundSeconds?: number;
	memoryLowerBoundSeconds?: number;
	rooflineLowerBoundSeconds?: number;
	largerTheoreticalBound?: "compute" | "memory" | "equal";
	observedComputePeakFraction?: number;
	observedMemoryPeakFraction?: number;
	observedToLowerBoundRatio?: number;
	timingSamples?: { count: number; medianSeconds: number; minSeconds: number;
		maxSeconds: number; spreadSeconds: number; medianAbsoluteDeviationSeconds: number };
	pairedBaselineRatios?: Array<{ name: string; count: number; median: number; min: number; max: number;
		medianAbsoluteDeviation: number }>;
	/** A descriptive counter contrast, never a measured bottleneck or acceptance rule. */
	counterContrast?: { smThroughputPercent: number; dramThroughputPercent: number;
		higherObservedUtilization: "sm" | "dram" | "equal";
		absolutePercentagePointDifference: number;
		sm: { receiptIndex: number; fieldPath: string; sourceLocation?: string };
		dram: { receiptIndex: number; fieldPath: string; sourceLocation?: string } };
	/** One falsifiable next experiment; the model still chooses the optimization. */
	nextExperiment?: string;
	/** Fixed-threshold reading of the supplied counters and bounds. Raw counters
	 * stay below in `counters`; this is the form that belongs in a prompt. */
	bottleneck?: ProfileBottleneckV1;
	bottleneckSummary?: string;
	counters: Array<MeasuredPerformanceQuantityV1 & { name: string; unit: string; sourceLocation?: string }>;
	warnings: string[];
}

export interface CandidateTimingComparisonV1 {
	subjectId: string;
	caseId: string;
	basisId: string;
	parent: NonNullable<CandidateProfileInterpretationV1["timingSamples"]>;
	candidate: NonNullable<CandidateProfileInterpretationV1["timingSamples"]>;
	medianDifferenceSeconds: number;
	sampleRangesOverlap: boolean;
	/** Descriptive pooled within-run scale, not a confidence interval. */
	pooledMedianAbsoluteDeviationSeconds: number;
	medianDifferenceToPooledDeviation: number | null;
}

function sampleSummary(values: readonly number[]): NonNullable<CandidateProfileInterpretationV1["timingSamples"]> {
	const sorted = [...values].sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	const median = sorted.length % 2 ? sorted[middle] : sorted[middle - 1] + (sorted[middle] - sorted[middle - 1]) / 2;
	const deviations = sorted.map(value => Math.abs(value - median)).sort((a, b) => a - b);
	const mad = deviations.length % 2 ? deviations[middle] : deviations[middle - 1] + (deviations[middle] - deviations[middle - 1]) / 2;
	return { count: sorted.length, medianSeconds: median, minSeconds: sorted[0], maxSeconds: sorted.at(-1)!,
		spreadSeconds: sorted.at(-1)! - sorted[0], medianAbsoluteDeviationSeconds: mad };
}

function profileCase(subjectId: string, caseId: string,
	performance: CandidatePerformanceEvidenceV1,
	evidenceKind: CandidateProfileInterpretationV1["evidenceKind"] = "unprofiled",
	eligibleForNextExperiment = false): CandidateProfileInterpretationV1 {
	const elapsed = performance.elapsedSeconds?.value;
	const operations = performance.operations?.value;
	const bytes = performance.bytesMoved?.value;
	const peakOperations = performance.peakOperationsPerSecond?.value;
	const peakBytes = performance.peakBytesPerSecond?.value;
	const finite = (value: number | undefined) => value !== undefined && Number.isFinite(value) ? value : undefined;
	const intensity = finite(operations !== undefined && bytes !== undefined && bytes > 0 ? operations / bytes : undefined);
	const computeBound = finite(operations !== undefined && peakOperations !== undefined ? operations / peakOperations : undefined);
	const memoryBound = finite(bytes !== undefined && peakBytes !== undefined ? bytes / peakBytes : undefined);
	const rooflineBound = computeBound !== undefined && memoryBound !== undefined ? Math.max(computeBound, memoryBound) : undefined;
	const computeFraction = finite(elapsed !== undefined && operations !== undefined && peakOperations !== undefined ?
		operations / elapsed / peakOperations : undefined);
	const memoryFraction = finite(elapsed !== undefined && bytes !== undefined && peakBytes !== undefined ?
		bytes / elapsed / peakBytes : undefined);
	const counter = (name: string) => performance.counters?.find(item => item.name === name && item.unit === "%");
	const sm = counter("sm__throughput.avg.pct_of_peak_sustained_elapsed");
	const dram = counter("dram__throughput.avg.pct_of_peak_sustained_elapsed");
	const higherObservedUtilization = sm && dram ? sm.value > dram.value ? "sm" as const :
		dram.value > sm.value ? "dram" as const : "equal" as const : undefined;
	const counterContrast = sm && dram && higherObservedUtilization ? {
		smThroughputPercent: sm.value, dramThroughputPercent: dram.value, higherObservedUtilization,
		absolutePercentagePointDifference: Math.abs(sm.value - dram.value),
		sm: { receiptIndex: sm.receiptIndex, fieldPath: sm.fieldPath,
			...(sm.sourceLocation ? { sourceLocation: sm.sourceLocation } : {}) },
		dram: { receiptIndex: dram.receiptIndex, fieldPath: dram.fieldPath,
			...(dram.sourceLocation ? { sourceLocation: dram.sourceLocation } : {}) },
	} : undefined;
	const nextExperiment = counterContrast && evidenceKind === "instrumented" && eligibleForNextExperiment ?
		higherObservedUtilization === "sm" ?
			"Hypothesis to test: if this pattern reflects a compute-side limit, try one task-permitted compute-scheduling or arithmetic-structure change; check correctness and unprofiled paired timing, then reprofile." :
		higherObservedUtilization === "dram" ?
			"Hypothesis to test: if this pattern reflects a data-movement limit, try one task-permitted data-movement or reuse change; check correctness and unprofiled paired timing, then reprofile." :
			"These two utilization counters give no relative lead; choose a next experiment from case timing or another bound diagnostic." : undefined;
	const warnings: string[] = [];
	if (rooflineBound !== undefined)
		warnings.push("The larger supplied compute/memory lower bound is a roofline estimate, not a measured bottleneck or causal diagnosis.");
	if (performance.counters?.length)
		warnings.push("Counters are host-normalized observations at supplied source locations; their values alone do not establish causality.");
	if (performance.pairedBaselineRatios?.some(item => item.values.some(value => value < 1) && item.values.some(value => value > 1)))
		warnings.push("At least one named baseline changes ordering across measured rounds; inspect the raw paired samples before selecting a winner.");
	if (rooflineBound !== undefined && elapsed !== undefined && elapsed < rooflineBound)
		warnings.push("Observed elapsed is below the supplied theoretical lower bound; inspect normalization and measurement basis.");
	if (computeFraction !== undefined && computeFraction > 1 || memoryFraction !== undefined && memoryFraction > 1)
		warnings.push("Observed attainment exceeds a supplied peak; inspect host-normalized quantities and their basis.");
	const bottleneck = performance.counters?.length || rooflineBound !== undefined ?
		interpretProfileBottleneck(performance, rooflineBound) : undefined;
	return { subjectId, caseId, basisId: performance.basisId, evidenceKind,
		...(elapsed !== undefined ? { elapsedSeconds: elapsed } : {}),
		...(intensity !== undefined ? { arithmeticIntensityOperationsPerByte: intensity } : {}),
		...(computeBound !== undefined ? { computeLowerBoundSeconds: computeBound } : {}),
		...(memoryBound !== undefined ? { memoryLowerBoundSeconds: memoryBound } : {}),
		...(rooflineBound !== undefined ? { rooflineLowerBoundSeconds: rooflineBound,
			largerTheoreticalBound: computeBound! > memoryBound! ? "compute" as const :
				memoryBound! > computeBound! ? "memory" as const : "equal" as const } : {}),
		...(computeFraction !== undefined ? { observedComputePeakFraction: computeFraction } : {}),
		...(memoryFraction !== undefined ? { observedMemoryPeakFraction: memoryFraction } : {}),
		...(rooflineBound !== undefined && rooflineBound > 0 && elapsed !== undefined &&
			Number.isFinite(elapsed / rooflineBound) ? { observedToLowerBoundRatio: elapsed / rooflineBound } : {}),
		...(performance.timingSamplesSeconds ? { timingSamples: sampleSummary(performance.timingSamplesSeconds.values) } : {}),
		...(performance.pairedBaselineRatios ? { pairedBaselineRatios: performance.pairedBaselineRatios.map(item => {
			const summary = sampleSummary(item.values);
			return { name: item.name, count: summary.count, median: summary.medianSeconds,
				min: summary.minSeconds, max: summary.maxSeconds,
				medianAbsoluteDeviation: summary.medianAbsoluteDeviationSeconds };
		}) } : {}),
		...(counterContrast ? { counterContrast } : {}),
		...(nextExperiment ? { nextExperiment } : {}),
		...(bottleneck ? { bottleneck, bottleneckSummary: describeProfileBottleneck(bottleneck) } : {}),
		counters: performance.counters?.map(counter => ({ ...counter })) ?? [], warnings };
}

/** Keep observation, source binding and measurement basis distinct. A receipt
 * can locate a failure without proving what optimization would repair it. */
export function summarizeCandidateDiagnostics(observation: CandidateObservationV1,
	comparison?: CandidateComparisonV1, parentObservation?: CandidateObservationV1): CandidateDiagnosticSummaryV1 {
	const cases = { passed: 0, failed: 0, unknown: 0 };
	const diagnostics = { compile: 0, numerical: 0, runtime: 0, unknown: 0 };
	const diagnosticLocations: CandidateDiagnosticSummaryV1["diagnosticLocations"] = [];
	const referenceContrasts: CandidateDiagnosticSummaryV1["referenceContrasts"] = [];
	const profileInterpretations: CandidateProfileInterpretationV1[] = [];
	const timingComparisons: CandidateTimingComparisonV1[] = [];
	const candidateProfiles = new Map<string, CandidateProfileInterpretationV1>();
	const ambiguousCandidateProfiles = new Set<string>();
	const parentProfiles = new Map<string, CandidateProfileInterpretationV1>();
	const ambiguousParentProfiles = new Set<string>();
	if (parentObservation?.sourceBinding === "verified") for (const evaluation of parentObservation.executionFacts?.evaluations ?? []) {
		if (!evaluation.terminal) continue;
		for (const item of evaluation.cases) {
			const performance = (item as CandidateCaseObservationV1 & { performance?: CandidatePerformanceEvidenceV1 }).performance;
			if (item.correctness !== "passed" || !performance ||
				!validCandidatePerformanceEvidence(performance, parentObservation.receiptFiles.length)) continue;
			const identity = JSON.stringify([evaluation.subjectId, item.caseId, performance.basisId]);
			if (parentProfiles.has(identity)) ambiguousParentProfiles.add(identity);
			else parentProfiles.set(identity, profileCase(evaluation.subjectId, item.caseId, performance));
		}
	}
	let terminalEvaluations = 0, nonterminalEvaluations = 0;
	for (const evaluation of observation.executionFacts?.evaluations ?? []) {
		if (evaluation.terminal) terminalEvaluations++;
		else nonterminalEvaluations++;
		for (const diagnostic of evaluation.diagnostics) {
			diagnostics[diagnostic.category]++;
			diagnosticLocations.push({ subjectId: evaluation.subjectId, externalId: evaluation.externalId,
				receiptIndex: evaluation.receiptIndex, category: diagnostic.category,
				...(diagnostic.caseId ? { caseId: diagnostic.caseId } : {}), fieldPath: diagnostic.fieldPath });
		}
		if (!evaluation.terminal) continue;
		for (const item of evaluation.cases) {
			cases[item.correctness]++;
			if (observation.sourceBinding !== "verified" || item.correctness !== "passed") continue;
			const performance = (item as CandidateCaseObservationV1 & { performance?: CandidatePerformanceEvidenceV1 }).performance;
			if (performance && validCandidatePerformanceEvidence(performance, observation.receiptFiles.length)) {
				const profile = profileCase(evaluation.subjectId, item.caseId, performance);
				profileInterpretations.push(profile);
				if (performance.profiledLaunch)
					profileInterpretations.push(profileCase(evaluation.subjectId, item.caseId, performance.profiledLaunch,
						"instrumented", observation.correctness === "passed"));
				const identity = JSON.stringify([evaluation.subjectId, item.caseId, performance.basisId]);
				if (candidateProfiles.has(identity)) ambiguousCandidateProfiles.add(identity);
				else candidateProfiles.set(identity, profile);
			}
			for (const metric of item.metrics) for (const reference of item.referenceMeasurements ?? []) {
				if (metric.unit !== reference.unit || metric.basisId !== reference.basisId ||
					!Number.isFinite(metric.value) || !Number.isFinite(reference.value)) continue;
				const difference = metric.value - reference.value;
				if (!Number.isFinite(difference)) continue;
				const ratio = reference.value !== 0 && Number.isFinite(metric.value / reference.value) ?
					metric.value / reference.value : null;
				referenceContrasts.push({ subjectId: evaluation.subjectId, caseId: item.caseId,
					candidateName: metric.name, referenceName: reference.name, unit: metric.unit,
					basisId: metric.basisId, candidateValue: metric.value,
					referenceValue: reference.value, difference, ratio });
			}
		}
	}
	for (const [identity, profile] of candidateProfiles) {
		if (ambiguousCandidateProfiles.has(identity) || ambiguousParentProfiles.has(identity)) continue;
		const parent = parentProfiles.get(identity);
		if (!parent?.timingSamples || !profile.timingSamples) continue;
		const pooledDeviation = parent.timingSamples.medianAbsoluteDeviationSeconds +
			profile.timingSamples.medianAbsoluteDeviationSeconds;
		const medianDifference = profile.timingSamples.medianSeconds - parent.timingSamples.medianSeconds;
		timingComparisons.push({ subjectId: profile.subjectId, caseId: profile.caseId,
			basisId: profile.basisId, parent: parent.timingSamples,
			candidate: profile.timingSamples,
			medianDifferenceSeconds: medianDifference,
			pooledMedianAbsoluteDeviationSeconds: pooledDeviation,
			medianDifferenceToPooledDeviation: pooledDeviation > 0 ? medianDifference / pooledDeviation : null,
			sampleRangesOverlap: profile.timingSamples.minSeconds <= parent.timingSamples.maxSeconds &&
				parent.timingSamples.minSeconds <= profile.timingSamples.maxSeconds });
	}
	const failureKinds = (["compile", "numerical", "runtime"] as const).filter(kind => diagnostics[kind] > 0);
	const stage: CandidateDiagnosticSummaryV1["stage"] = observation.sourceBinding !== "verified" ? "source-unverified" :
		observation.correctness === "unknown" ? "pending-or-unknown" :
		observation.correctness === "passed" ? observation.metrics.length ? "correct-measured" : "correct-unmeasured" :
		failureKinds.length > 1 ? "mixed-failure" : failureKinds[0] === "compile" ? "compile-failure" :
		failureKinds[0] === "numerical" ? "numerical-failure" : failureKinds[0] === "runtime" ? "runtime-failure" :
		"correctness-failure";
	const deltas = comparison ? [...comparison.comparableMetrics,
		...comparison.caseChanges.flatMap(change => change.comparableMetrics)] : [];
	const inspection = stage === "source-unverified" ? ["Inspect the original source/receipt binding; no submitted-source conclusion is available."] :
		stage === "pending-or-unknown" ? ["Inspect or reconcile the original external operation before any new side effect."] :
		stage === "correct-measured" ? ["Compare only exact metric bases and inspect the measured cases before changing the implementation."] :
		stage === "correct-unmeasured" ? ["Correctness is observed, but no comparable top-level performance measurement is available."] :
		["Inspect the listed original receipt fields and failed cases before choosing a repair."];
	if (comparison && !deltas.length) inspection.push("No parent performance metrics share a verified comparable basis.");
	if (referenceContrasts.length) inspection.push("Reference contrasts are numeric facts, not speedups or hardware bottleneck diagnoses.");
	if (timingComparisons.length) inspection.push("Timing ranges and median absolute deviations describe observed variation, not a confidence interval or proof of a speed difference.");
	if (profileInterpretations.some(item => item.pairedBaselineRatios?.length))
		inspection.push("Round-aligned candidate/baseline ratios control some within-run drift; they do not establish a quiet device or cross-run ranking fidelity.");
	for (const profile of profileInterpretations.filter(item => item.evidenceKind === "instrumented" && item.counterContrast && item.nextExperiment).slice(0, 3)) {
		const contrast = profile.counterContrast!;
		const ordering = contrast.higherObservedUtilization === "equal" ? "the two reported percentages are equal" :
			`${contrast.higherObservedUtilization.toUpperCase()} has the higher reported percentage`;
		inspection.push(`Instrumented subject ${profile.subjectId}, case ${profile.caseId}, basis ${profile.basisId}: SM throughput ${contrast.smThroughputPercent}% (receipt ${contrast.sm.receiptIndex}, ${contrast.sm.fieldPath}) and DRAM throughput ${contrast.dramThroughputPercent}% (receipt ${contrast.dram.receiptIndex}, ${contrast.dram.fieldPath}) of their respective reported peaks; ${ordering} by ${contrast.absolutePercentagePointDifference} percentage points. This is a counter contrast, not a proven bottleneck. ${profile.nextExperiment}`);
	}
	const hasProfilerCounters = profileInterpretations.some(item => item.counters.length ||
		item.rooflineLowerBoundSeconds !== undefined);
	const profilerInterpretation = !hasProfilerCounters ? "unavailable" as const :
		profileInterpretations.some(item => item.rooflineLowerBoundSeconds !== undefined &&
			item.observedComputePeakFraction !== undefined && item.observedMemoryPeakFraction !== undefined) ?
			"derived" as const : "partial" as const;
	if (!hasProfilerCounters && profileInterpretations.length)
		inspection.push("Elapsed time is observed, but no hardware profiler counters or calibrated roofline inputs are available.");
	return { stage, hostStage: observation.stage, terminalEvaluations, nonterminalEvaluations,
		cases, diagnostics, diagnosticLocations, referenceContrasts, profileInterpretations, timingComparisons,
		parentMeasuredChange: comparison ? { improved: deltas.filter(delta => delta.improved).length,
			regressed: deltas.filter(delta => delta.regressed).length,
			equal: deltas.filter(delta => !delta.improved && !delta.regressed).length,
			correctnessChanges: comparison.caseChanges.filter(change =>
				change.parentCorrectness !== change.candidateCorrectness).length } : null,
		inspection, profilerInterpretation };
}

const metricKey = (metric: Pick<CandidateMetricV1, "name" | "unit" | "basisId" | "direction">): string =>
	JSON.stringify([metric.name, metric.unit, metric.basisId, metric.direction]);

function compareMetrics(parent: readonly CandidateMetricV1[], candidate: readonly CandidateMetricV1[]): CandidateMetricDeltaV1[] {
	const parentByKey = new Map<string, CandidateMetricV1>();
	const duplicateKeys = new Set<string>();
	for (const metric of parent) {
		const key = metricKey(metric);
		if (parentByKey.has(key)) duplicateKeys.add(key);
		parentByKey.set(key, metric);
	}
	const candidateKeys = new Set<string>();
	const result: CandidateMetricDeltaV1[] = [];
	for (const metric of candidate) {
		const key = metricKey(metric);
		if (candidateKeys.has(key)) { duplicateKeys.add(key); continue; }
		candidateKeys.add(key);
		const earlier = parentByKey.get(key);
		if (!earlier || !Number.isFinite(earlier.value) || !Number.isFinite(metric.value)) continue;
		const delta = metric.value - earlier.value;
		if (!Number.isFinite(delta)) continue;
		result.push({ name: metric.name, unit: metric.unit, basisId: metric.basisId,
			direction: metric.direction, parentValue: earlier.value, candidateValue: metric.value,
			delta, improved: metric.direction === "higher" ? delta > 0 : delta < 0,
			regressed: metric.direction === "higher" ? delta < 0 : delta > 0 });
	}
	return result.filter(row => !duplicateKeys.has(metricKey(row)));
}

/** Compare only independently bound observations and identical metric bases.
 * A status change is reported literally; this helper does not infer its meaning. */
export function compareCandidateObservations(parent: CandidateObservationV1,
	candidate: CandidateObservationV1,
	subjects?: { parentSubjectId?: string; candidateSubjectId?: string }): CandidateComparisonV1 {
	if (parent.sourceBinding !== "verified" || candidate.sourceBinding !== "verified")
		return { comparableMetrics: [], caseChanges: [], summary: ["Source binding is unavailable for at least one candidate."] };
	const topLevelSubject = (observation: CandidateObservationV1, declared?: string): string | undefined => {
		const observed = new Set(observation.executionFacts?.evaluations.map(item => item.subjectId) ?? []);
		if (observed.size > 1 || declared !== undefined && (!declared.trim() || observed.size === 1 && !observed.has(declared)))
			return undefined;
		return observed.size === 1 ? [...observed][0] : declared;
	};
	const parentSubject = topLevelSubject(parent, subjects?.parentSubjectId);
	const candidateSubject = topLevelSubject(candidate, subjects?.candidateSubjectId);
	const sameSubject = !!parentSubject && parentSubject === candidateSubject;
	const comparableMetrics = sameSubject && parent.correctness === "passed" && candidate.correctness === "passed" ?
		compareMetrics(parent.metrics, candidate.metrics) : [];
	const priorCases = new Map<string, { status: string; correctness: "passed" | "failed" | "unknown"; metrics: CandidateMetricV1[] }>();
	const ambiguous = new Set<string>();
	for (const evaluation of parent.executionFacts?.evaluations ?? []) {
		if (!evaluation.terminal) continue;
		for (const item of evaluation.cases) {
			const key = JSON.stringify([evaluation.subjectId, item.caseId]);
			if (priorCases.has(key)) ambiguous.add(key);
			else priorCases.set(key, item);
		}
	}
	const candidateCases = new Map<string, { status: string; correctness: "passed" | "failed" | "unknown"; metrics: CandidateMetricV1[] }>();
	for (const evaluation of candidate.executionFacts?.evaluations ?? []) {
		if (!evaluation.terminal) continue;
		for (const item of evaluation.cases) {
			const key = JSON.stringify([evaluation.subjectId, item.caseId]);
			if (candidateCases.has(key)) ambiguous.add(key);
			else candidateCases.set(key, item);
		}
	}
	const caseChanges: CandidateCaseChangeV1[] = [];
	for (const [key, current] of candidateCases) {
		const earlier = priorCases.get(key);
		if (!earlier || ambiguous.has(key)) continue;
		const [subjectId, caseId] = JSON.parse(key) as [string, string];
		const metrics = earlier.correctness === "passed" && current.correctness === "passed" ?
			compareMetrics(earlier.metrics, current.metrics) : [];
		if (earlier.status !== current.status || earlier.correctness !== current.correctness || metrics.length)
			caseChanges.push({ subjectId, caseId, parentStatus: earlier.status,
				candidateStatus: current.status, parentCorrectness: earlier.correctness,
				candidateCorrectness: current.correctness, comparableMetrics: metrics });
	}
	const metricRegressions = comparableMetrics.filter(item => item.regressed).length +
		caseChanges.reduce((count, item) => count + item.comparableMetrics.filter(metric => metric.regressed).length, 0);
	const summary = [`${comparableMetrics.length} top-level and ${caseChanges.reduce((count, item) => count + item.comparableMetrics.length, 0)} case metrics share an exact basis.`,
		`${metricRegressions} comparable metrics regressed.`];
	if (!sameSubject && parent.correctness === "passed" && candidate.correctness === "passed" &&
		parent.metrics.length && candidate.metrics.length)
		summary.push("Top-level metrics lack one matching subject binding; per-case comparisons retain their exact subject and case identities.");
	const changedStatuses = caseChanges.filter(item => item.parentStatus !== item.candidateStatus).length;
	if (changedStatuses) summary.push(`${changedStatuses} case statuses changed; inspect the original statuses and diagnostic text.`);
	const changedCorrectness = caseChanges.filter(item => item.parentCorrectness !== item.candidateCorrectness).length;
	if (changedCorrectness) summary.push(`${changedCorrectness} case correctness results changed; inspect the per-subject case findings.`);
	return { comparableMetrics, caseChanges, summary };
}

/** A display projection only: no evidence, candidate or experiment is discarded.
 * Negative/unknown cases are shown first; this is not a causal diagnosis or ranking. */
export function projectCandidateFeedback(observation: CandidateObservationV1,
	comparison?: CandidateComparisonV1) {
	const { executionFacts, ...control } = observation;
	// These character allowances constrain the immediate tool message, not evaluation or storage.
	let caseIndexSpace = 4000, diagnosticIndexSpace = 6000;
	const evaluations = executionFacts?.evaluations.map((evaluation, evaluationIndex) => {
		const base = `observation.executionFacts.evaluations[${evaluationIndex}]`;
		const correctnessCounts = { passed: 0, failed: 0, unknown: 0 };
		for (const item of evaluation.cases) correctnessCounts[item.correctness]++;
		const caseIndex: Array<{ index: number; path: string; caseId: string; status: string;
			correctness: "passed" | "failed" | "unknown"; metricCount: number;
			metrics: CandidateMetricV1[]; referenceMeasurements?: CandidateCaseObservationV1["referenceMeasurements"];
			omittedMetrics: number; omittedReferenceMeasurements: number }> = [];
		for (const correctness of ["failed", "unknown", "passed"] as const) {
			for (const [index, item] of evaluation.cases.entries()) {
				if (item.correctness !== correctness) continue;
				let row = { ...item, index, path: `${base}.cases[${index}]`, metricCount: item.metrics.length,
					omittedMetrics: 0, omittedReferenceMeasurements: 0 };
				if (JSON.stringify(row).length > caseIndexSpace) row = { ...row, metrics: [], referenceMeasurements: [],
					omittedMetrics: item.metrics.length, omittedReferenceMeasurements: item.referenceMeasurements?.length ?? 0 };
				const size = JSON.stringify(row).length;
				if (size > caseIndexSpace) continue;
				caseIndex.push(row); caseIndexSpace -= size;
			}
		}
		const diagnosticCounts = { compile: 0, numerical: 0, runtime: 0, unknown: 0 };
		for (const item of evaluation.diagnostics) diagnosticCounts[item.category]++;
		const diagnosticIndex: Array<{ index: number; path: string; category: string; fieldPath: string;
			caseId?: string; rawTextPreview: string; rawTextLength: number; omittedRawTextChars: number }> = [];
		// Visit one representative of each present category before the rest, so a long
		// compiler log cannot crowd every numerical/runtime category out of the index.
		const firstByCategory = new Set(Object.keys(diagnosticCounts).map(category =>
			evaluation.diagnostics.findIndex(item => item.category === category)).filter(index => index >= 0));
		const order = [...firstByCategory, ...evaluation.diagnostics.keys()].filter((index, position) =>
			position < firstByCategory.size || !firstByCategory.has(index));
		for (const index of order) {
			const item = evaluation.diagnostics[index];
			let preview = item.rawText;
			let row = { index, path: `${base}.diagnostics[${index}]`, category: item.category,
				fieldPath: item.fieldPath, ...(item.caseId === undefined ? {} : { caseId: item.caseId }),
				rawTextPreview: preview, rawTextLength: item.rawText.length,
				omittedRawTextChars: 0 };
			if (JSON.stringify(row).length > diagnosticIndexSpace) {
				preview = item.rawText.slice(0, 320);
				row = { ...row, rawTextPreview: preview, omittedRawTextChars: item.rawText.length - preview.length };
			}
			const size = JSON.stringify(row).length;
			if (size > diagnosticIndexSpace) continue;
			diagnosticIndex.push(row); diagnosticIndexSpace -= size;
		}
		return { externalId: evaluation.externalId, subjectId: evaluation.subjectId,
			status: evaluation.status, terminal: evaluation.terminal, capturedAt: evaluation.capturedAt,
			receiptIndex: evaluation.receiptIndex,
			cases: { path: `${base}.cases`, total: evaluation.cases.length, correctnessCounts,
				index: caseIndex, omittedIndexEntries: evaluation.cases.length - caseIndex.length,
				fullCaseBodiesOmitted: evaluation.cases.length - caseIndex.filter(item => !item.omittedMetrics && !item.omittedReferenceMeasurements).length },
			diagnostics: { path: `${base}.diagnostics`, total: evaluation.diagnostics.length, categoryCounts: diagnosticCounts,
				index: diagnosticIndex, omittedIndexEntries: evaluation.diagnostics.length - diagnosticIndex.length,
				omittedRawTextChars: evaluation.diagnostics.reduce((sum, item) => sum + item.rawText.length, 0) -
					diagnosticIndex.reduce((sum, item) => sum + item.rawTextPreview.length, 0) } };
	});
	let comparisonSpace = 6000;
	const caseChanges: Array<CandidateCaseChangeV1 & { index: number; path: string; omittedComparableMetrics: number }> = [];
	const changes = comparison?.caseChanges ?? [];
	const displayGroup = (item: CandidateCaseChangeV1) => item.candidateCorrectness !== "passed" ? 0 :
		item.comparableMetrics.some(metric => metric.regressed) ? 1 : 2;
	for (const group of [0, 1, 2]) {
		for (const [index, item] of changes.entries()) {
			if (displayGroup(item) !== group) continue;
			let row = { ...item, index, path: `parentComparison.caseChanges[${index}]`, omittedComparableMetrics: 0 };
			if (JSON.stringify(row).length > comparisonSpace) row = { ...row, comparableMetrics: [], omittedComparableMetrics: item.comparableMetrics.length };
			const size = JSON.stringify(row).length;
			if (size > comparisonSpace) continue;
			caseChanges.push(row); comparisonSpace -= size;
		}
	}
	return {
		observation: { ...control, ...(evaluations ? { executionFacts: { evaluations } } : {}) },
		parentComparison: comparison ? { comparableMetrics: comparison.comparableMetrics,
			summary: comparison.summary, caseChanges, caseChangesProjection: { path: "parentComparison.caseChanges",
				total: changes.length, omitted: changes.length - caseChanges.length } } : null,
	};
}
