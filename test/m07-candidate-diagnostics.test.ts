import assert from "node:assert/strict";
import test from "node:test";
import { compareCandidateObservations, projectCandidateFeedback, summarizeCandidateDiagnostics,
	validCandidatePerformanceEvidence, type CandidatePerformanceEvidenceV1 } from "../src/m07/candidate-diagnostics.ts";
import type { CandidateObservationV1 } from "../src/m07/types.ts";

const base: CandidateObservationV1 = {
	version: 1, kind: "candidate-observation", verifier: { id: "host:test", version: "1" },
	sourceBinding: "verified", correctness: "passed", stage: "performance", checks: [], goalChecks: [],
	metrics: [{ name: "displayScore", value: 70, unit: "platform-score", basisId: "problem:49:score", direction: "higher" }],
	limitations: [], sourceFiles: ["source"], receiptFiles: ["receipt"],
	executionFacts: { evaluations: [{ externalId: "1", subjectId: "49", status: "Accepted", terminal: true,
		capturedAt: "2026-10-18T00:00:00.000Z", receiptIndex: 0,
		cases: [{ caseId: "case-a", status: "Accepted", correctness: "passed", metrics: [
			{ name: "displayScore", value: 80, unit: "platform-score", basisId: "problem:49:case:a:score", direction: "higher" },
			{ name: "tk", value: 4, unit: "ms", basisId: "problem:49:case:a:language:x:schema-v2:timing", direction: "lower" }],
			referenceMeasurements: [{ name: "tb", value: 8, unit: "ms", basisId: "problem:49:case:a:language:x:schema-v2:timing" }] }],
		diagnostics: [] }] },
};

test("candidate comparison gives same-basis case deltas only for two correct evaluations", () => {
	const candidate: CandidateObservationV1 = { ...base,
		metrics: [{ ...base.metrics[0], value: 75 }],
		executionFacts: { evaluations: [{ ...base.executionFacts!.evaluations[0], externalId: "2",
			cases: [{ caseId: "case-a", status: "Accepted", correctness: "passed", metrics: [
				{ ...base.executionFacts!.evaluations[0].cases[0].metrics[0], value: 60 },
				{ ...base.executionFacts!.evaluations[0].cases[0].metrics[1], value: 2 }],
				referenceMeasurements: [{ ...base.executionFacts!.evaluations[0].cases[0].referenceMeasurements![0], value: 9 }] }],
			diagnostics: [] }] },
	};
	const result = compareCandidateObservations(base, candidate);
	assert.equal(result.comparableMetrics[0].delta, 5);
	assert.equal(result.comparableMetrics[0].improved, true);
	assert.deepEqual(result.caseChanges[0].comparableMetrics.map(item => item.name), ["displayScore", "tk"]);
	assert.equal(result.caseChanges[0].comparableMetrics[0].regressed, true);
	assert.match(result.summary.join(" "), /1 comparable metrics regressed/);
	const projected = projectCandidateFeedback(candidate, result);
	const cases = projected.observation.executionFacts!.evaluations[0].cases;
	assert.deepEqual(cases.index[0].metrics, candidate.executionFacts!.evaluations[0].cases[0].metrics);
	assert.deepEqual(cases.index[0].referenceMeasurements, candidate.executionFacts!.evaluations[0].cases[0].referenceMeasurements);
	assert.equal(cases.fullCaseBodiesOmitted, 0, "small case feedback keeps every measurement");
	assert.deepEqual(projected.parentComparison!.caseChanges[0].comparableMetrics, result.caseChanges[0].comparableMetrics);
	assert.equal(projected.parentComparison!.caseChangesProjection.omitted, 0);
	assert.equal(projected.parentComparison!.caseChanges[0].comparableMetrics[0].delta, -20);
	assert.equal(projected.parentComparison!.caseChanges[0].comparableMetrics[1].delta, -2);
	const failed: CandidateObservationV1 = { ...candidate, correctness: "failed", metrics: [],
		executionFacts: { evaluations: [{ ...candidate.executionFacts!.evaluations[0], status: "WrongAnswer",
			cases: [{ ...candidate.executionFacts!.evaluations[0].cases[0], status: "WrongAnswer", correctness: "failed" }],
			diagnostics: [{ category: "numerical", caseId: "case-a",
				fieldPath: "progress.testcaseResult.case-a.checkerMessage", rawText: "exact checker output" }] }] } };
	const failedComparison = compareCandidateObservations(base, failed);
	assert.equal(failedComparison.comparableMetrics.length, 0);
	assert.equal(failedComparison.caseChanges[0].candidateStatus, "WrongAnswer");
	assert.equal(failedComparison.caseChanges[0].comparableMetrics.length, 0);
	assert.equal(failed.executionFacts!.evaluations[0].diagnostics[0].rawText, "exact checker output");
	const failedProjection = projectCandidateFeedback(failed, failedComparison);
	const diagnostic = failedProjection.observation.executionFacts!.evaluations[0].diagnostics.index[0];
	assert.equal(diagnostic.rawTextPreview, "exact checker output");
	assert.equal(diagnostic.omittedRawTextChars, 0, "short diagnostics are returned completely");
	assert.equal(failedProjection.parentComparison!.caseChanges[0].candidateStatus, "WrongAnswer");
});

test("candidate feedback preserves correctness-only changes and distinguishes subjects sharing a case ID", () => {
	const parent = structuredClone(base);
	parent.metrics = [];
	parent.correctness = "failed";
	parent.receiptFiles = ["receipt-a", "receipt-b"];
	const evaluation = parent.executionFacts!.evaluations[0];
	parent.executionFacts!.evaluations = ["operator-a", "operator-b"].map((subjectId, index) => ({
		...evaluation, subjectId, externalId: `parent-${index}`, receiptIndex: index,
		cases: [{ caseId: "case-0", status: "Completed", correctness: index ? "passed" as const : "failed" as const, metrics: [] }],
	}));
	const candidate = structuredClone(parent);
	for (const [index, result] of candidate.executionFacts!.evaluations.entries()) {
		result.externalId = `candidate-${index}`;
		result.cases[0].correctness = index ? "failed" : "passed";
	}
	const comparison = compareCandidateObservations(parent, candidate);
	assert.deepEqual(comparison.caseChanges.map(item => [item.subjectId, item.caseId, item.parentCorrectness, item.candidateCorrectness]), [
		["operator-a", "case-0", "failed", "passed"],
		["operator-b", "case-0", "passed", "failed"],
	]);
	assert.ok(comparison.caseChanges.every(item => item.parentStatus === item.candidateStatus && !item.comparableMetrics.length));
	assert.match(comparison.summary.join(" "), /2 case correctness results changed/);
	const feedback = projectCandidateFeedback(candidate, comparison);
	assert.deepEqual(feedback.parentComparison!.caseChanges.map(item => item.subjectId), ["operator-b", "operator-a"]);
	assert.equal(feedback.parentComparison!.caseChangesProjection.omitted, 0);
});

test("top-level metrics require one matching subject, including explicit legacy task bindings", () => {
	const parent = structuredClone(base);
	const candidate = structuredClone(base);
	candidate.metrics[0].value = 75;
	assert.equal(compareCandidateObservations(parent, candidate).comparableMetrics.length, 1);
	const otherSubject = structuredClone(candidate);
	otherSubject.executionFacts!.evaluations[0].subjectId = "another-operator";
	assert.deepEqual(compareCandidateObservations(parent, otherSubject).comparableMetrics, []);
	const multiSubject = structuredClone(candidate);
	multiSubject.receiptFiles.push("another-receipt");
	multiSubject.executionFacts!.evaluations[0].cases[0].metrics[0].value = 81;
	multiSubject.executionFacts!.evaluations.push({ ...multiSubject.executionFacts!.evaluations[0],
		subjectId: "another-operator", receiptIndex: 1, externalId: "multi" });
	assert.deepEqual(compareCandidateObservations(parent, multiSubject).comparableMetrics, []);
	assert.equal(compareCandidateObservations(parent, multiSubject).caseChanges[0].subjectId, "49",
		"per-case facts stay scoped even when the top-level observation spans subjects");
	assert.deepEqual(compareCandidateObservations(parent, candidate, {
		parentSubjectId: "another-operator", candidateSubjectId: "49" }).comparableMetrics, [],
		"an explicit task subject cannot override a different observed subject");
	const legacyParent = structuredClone(parent), legacyCandidate = structuredClone(candidate);
	legacyParent.executionFacts = undefined;
	legacyCandidate.executionFacts = undefined;
	assert.deepEqual(compareCandidateObservations(legacyParent, legacyCandidate).comparableMetrics, []);
	assert.equal(compareCandidateObservations(legacyParent, legacyCandidate, {
		parentSubjectId: "49", candidateSubjectId: "49" }).comparableMetrics.length, 1);
	assert.deepEqual(compareCandidateObservations(legacyParent, legacyCandidate, {
		parentSubjectId: "49", candidateSubjectId: "another-operator" }).comparableMetrics, []);
});

test("diagnosis uses verified receipt locations and comparable numbers without inventing a profiler bottleneck", () => {
	const parent = structuredClone(base);
	const next = structuredClone(base);
	next.executionFacts!.evaluations[0].cases[0].metrics[1].value = 6;
	next.executionFacts!.evaluations[0].cases[0].referenceMeasurements![0].value = 8;
	const summary = summarizeCandidateDiagnostics(next, compareCandidateObservations(parent, next));
	assert.equal(summary.stage, "correct-measured");
	assert.deepEqual(summary.parentMeasuredChange, { improved: 0, regressed: 1, equal: 2, correctnessChanges: 0 });
	assert.deepEqual(summary.referenceContrasts.map(item => [item.candidateName, item.referenceName, item.difference, item.ratio]),
		[["tk", "tb", -2, 0.75]]);
	assert.equal(summary.profilerInterpretation, "unavailable");
	const failed = structuredClone(next);
	failed.correctness = "failed";
	failed.metrics = [];
	failed.executionFacts!.evaluations[0].cases[0].correctness = "failed";
	failed.executionFacts!.evaluations[0].diagnostics = [{ category: "numerical", caseId: "case-a",
		fieldPath: "progress.cases[0].checkerMessage", rawText: "actual mismatch" }];
	const failure = summarizeCandidateDiagnostics(failed);
	assert.equal(failure.stage, "numerical-failure");
	assert.deepEqual(failure.diagnosticLocations.map(item => [item.receiptIndex, item.category, item.fieldPath]),
		[[0, "numerical", "progress.cases[0].checkerMessage"]]);
	assert.equal(failure.referenceContrasts.length, 0, "failed case measurements are not performance contrasts");
	assert.match(failure.inspection[0], /original receipt fields/);
});

test("trusted profile quantities derive only supported roofline bounds and descriptive timing overlap", () => {
	const quantity = (value: number) => ({ value, receiptIndex: 0, fieldPath: "profile.measurement" });
	const performance: CandidatePerformanceEvidenceV1 = { basisId: "device:x:shape:y",
		elapsedSeconds: quantity(0.0055), operations: quantity(1e9), bytesMoved: quantity(5e8),
		peakOperationsPerSecond: quantity(1e12), peakBytesPerSecond: quantity(1e11),
		timingSamplesSeconds: { values: [0.005, 0.0055, 0.006], receiptIndex: 0, fieldPath: "profile.samples" },
		counters: [{ name: "stall_cycles", unit: "cycles", ...quantity(120), sourceLocation: "kernel.c:19" }] };
	assert.equal(validCandidatePerformanceEvidence(performance, 1), true);
	assert.equal(validCandidatePerformanceEvidence({ ...performance, peakBytesPerSecond: quantity(0) }, 1), false);
	const parent = structuredClone(base), candidate = structuredClone(base);
	parent.executionFacts!.evaluations[0].cases[0].performance = { ...performance,
		timingSamplesSeconds: { values: [0.0055, 0.006, 0.0065], receiptIndex: 0, fieldPath: "profile.samples" } };
	candidate.executionFacts!.evaluations[0].cases[0].performance = performance;
	const summary = summarizeCandidateDiagnostics(candidate, compareCandidateObservations(parent, candidate), parent);
	const profile = summary.profileInterpretations[0];
	assert.equal(summary.profilerInterpretation, "derived");
	assert.equal(profile.arithmeticIntensityOperationsPerByte, 2);
	assert.equal(profile.computeLowerBoundSeconds, 0.001);
	assert.equal(profile.memoryLowerBoundSeconds, 0.005);
	assert.equal(profile.largerTheoreticalBound, "memory");
	assert.equal(profile.observedComputePeakFraction! < 1, true);
	assert.deepEqual(profile.counters.map(counter => [counter.name, counter.sourceLocation]), [["stall_cycles", "kernel.c:19"]]);
	assert.ok(Math.abs(summary.timingComparisons[0].medianDifferenceSeconds + 0.0005) < 1e-12);
	assert.equal(summary.timingComparisons[0].sampleRangesOverlap, true);
	assert.ok(Math.abs(summary.timingComparisons[0].pooledMedianAbsoluteDeviationSeconds - 0.001) < 1e-12);
	assert.ok(summary.timingComparisons[0].medianDifferenceToPooledDeviation! < 0);
	assert.match(summary.inspection.join(" "), /not a confidence interval/);
	const separate = structuredClone(candidate);
	separate.executionFacts!.evaluations[0].cases[0].performance = {
		...performance,
		pairedBaselineRatios: [{ name: "library", values: [0.98, 1.01, 0.99], receiptIndex: 0, fieldPath: "measurement.pairs" }],
		profiledLaunch: { basisId: "instrumented:launch", elapsedSeconds: quantity(0.006),
			counters: [{ name: "stall_cycles", unit: "cycles", ...quantity(120) }] },
	};
	assert.equal(validCandidatePerformanceEvidence(separate.executionFacts!.evaluations[0].cases[0].performance!, 1), true);
	const split = summarizeCandidateDiagnostics(separate, undefined, parent);
	assert.equal(split.profileInterpretations.length, 2);
	assert.equal(split.profileInterpretations[0].timingSamples!.count, 3);
	assert.equal(split.profileInterpretations[1].basisId, "instrumented:launch");
	assert.equal(split.profileInterpretations[1].timingSamples, undefined);
	assert.match(split.profileInterpretations[0].warnings.join(" "), /changes ordering/);
	const partial = structuredClone(base);
	partial.executionFacts!.evaluations[0].cases[0].performance = { basisId: "device:x:shape:y",
		elapsedSeconds: quantity(0.006) };
	const partialSummary = summarizeCandidateDiagnostics(partial);
	assert.equal(partialSummary.profilerInterpretation, "unavailable", "elapsed-only timing is not a hardware profile");
	assert.equal(partialSummary.profileInterpretations[0].rooflineLowerBoundSeconds, undefined);
	assert.match(partialSummary.inspection.join(" "), /no hardware profiler counters/);
});

test("instrumented NCU utilization contrasts lead to a falsifiable next experiment without replacing timing", () => {
	const observed = structuredClone(base);
	const caseRow = observed.executionFacts!.evaluations[0].cases[0];
	caseRow.performance = { basisId: "unprofiled:case-a",
		timingSamplesSeconds: { values: [0.005, 0.006, 0.0055], receiptIndex: 0, fieldPath: "cases[0].samplesSeconds" },
		profiledLaunch: { basisId: "ncu:launch-7", elapsedSeconds: { value: 0.008, receiptIndex: 0,
			fieldPath: "csv.row:2.Metric Value" }, counters: [
			{ name: "sm__throughput.avg.pct_of_peak_sustained_elapsed", unit: "%", value: 34,
				receiptIndex: 0, fieldPath: "csv.row:3.Metric Value" },
			{ name: "dram__throughput.avg.pct_of_peak_sustained_elapsed", unit: "%", value: 67,
				receiptIndex: 0, fieldPath: "csv.row:4.Metric Value" },
		] },
	};
	const summary = summarizeCandidateDiagnostics(observed);
	assert.equal(summary.profilerInterpretation, "partial");
	assert.equal(summary.profileInterpretations[0].evidenceKind, "unprofiled");
	assert.equal(summary.profileInterpretations[0].timingSamples!.medianSeconds, 0.0055);
	const instrumented = summary.profileInterpretations[1];
	assert.equal(instrumented.evidenceKind, "instrumented");
	assert.equal(instrumented.basisId, "ncu:launch-7");
	assert.equal(instrumented.counterContrast?.higherObservedUtilization, "dram");
	assert.equal(instrumented.counterContrast?.absolutePercentagePointDifference, 33);
	assert.equal(instrumented.counterContrast?.dram.fieldPath, "csv.row:4.Metric Value");
	assert.match(instrumented.nextExperiment!, /data-movement or reuse/);
	assert.match(summary.inspection.join(" "), /counter contrast, not a proven bottleneck/);
	assert.match(summary.inspection.join(" "), /33 percentage points/);
	assert.match(summary.inspection.join(" "), /csv.row:4.Metric Value/);
	const partial = structuredClone(observed);
	partial.executionFacts!.evaluations[0].cases[0].performance!.profiledLaunch!.counters!.pop();
	assert.equal(summarizeCandidateDiagnostics(partial).profileInterpretations[1].nextExperiment, undefined);
	const failed = structuredClone(observed);
	failed.executionFacts!.evaluations[0].cases[0].correctness = "failed";
	assert.equal(summarizeCandidateDiagnostics(failed).profileInterpretations.length, 0,
		"a failed case cannot emit optimization guidance from a profile");
	const incomplete = structuredClone(observed);
	incomplete.correctness = "unknown";
	const incompleteSummary = summarizeCandidateDiagnostics(incomplete);
	assert.equal(incompleteSummary.profileInterpretations[1].nextExperiment, undefined,
		"a passed case in an incomplete candidate must not lead an optimization change");
	assert.doesNotMatch(incompleteSummary.inspection.join(" "), /Hypothesis to test/);
	assert.doesNotMatch(incompleteSummary.inspection.join(" "), /undefined/);
});
