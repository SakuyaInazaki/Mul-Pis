import assert from "node:assert/strict";
import test from "node:test";
import { analyzeCandidateSearch, candidateSearchBrief, candidateSearchFocus,
	scopedRepeatedSourceObservations, scopedSearchLeads } from "../src/m07/candidate-search.ts";
import { globalCandidateBest, type CandidateArchiveEntry } from "../src/m07/candidate-archive.ts";
import type { CandidateMetricV1, CandidateObservationV1 } from "../src/m07/types.ts";

const metric = (name: string, value: number, unit: string, basisId = "subject:a:case:one:device:x"):
	CandidateMetricV1 => ({ name, value, unit, basisId, direction: "lower" });

function entry(id: string, latency: number, memory: number, options: {
	basisId?: string; correctness?: "passed" | "failed" | "unknown";
	sourceBinding?: "verified" | "unknown"; changeKind?: CandidateArchiveEntry["changeKind"];
	parentComparison?: CandidateArchiveEntry["parentComparison"];
	parentRef?: CandidateArchiveEntry["parentRef"];
	sourceRepetition?: CandidateArchiveEntry["sourceRepetition"];
	externalId?: string; subjectId?: string; intent?: "solution" | "diagnostic";
} = {}): CandidateArchiveEntry {
	const correctness = options.correctness ?? "passed";
	const observation: CandidateObservationV1 = { version: 1, kind: "candidate-observation",
		verifier: { id: "host:test", version: "1" }, sourceBinding: options.sourceBinding ?? "verified",
		correctness, stage: "test", checks: [], goalChecks: [], metrics: [], limitations: [],
		sourceFiles: ["source"], receiptFiles: ["receipt"],
		executionFacts: { evaluations: [{ externalId: options.externalId ?? id, subjectId: options.subjectId ?? "a", status: "Completed", terminal: true,
			capturedAt: "2026-10-18T00:00:00.000Z", receiptIndex: 0,
			cases: [{ caseId: "one", status: "Completed", correctness: "passed",
				metrics: [metric("latency", latency, "ms", options.basisId),
					metric("memory", memory, "MiB", options.basisId)] }], diagnostics: [] }] } };
	return { ref: `T001/${id}`, taskId: "T001", candidateId: id, taskStatus: "returned",
		intent: options.intent ?? "solution", changeKind: options.changeKind, parentRef: options.parentRef,
		parentComparison: options.parentComparison, sourceRepetition: options.sourceRepetition,
		identicalSourceRefs: options.sourceRepetition ? ["T001/C001"] : undefined,
		sourcePaths: ["candidate.c"], receiptPaths: ["receipt.json"], observation,
		observationPath: "observation.json", workDir: "work" };
}

test("exact-source repeated observations describe distinct IDs without changing search decisions", () => {
	const repeated = (id: string, value: number, externalId = id) => {
		const candidate = entry(id, value, 1, { externalId });
		candidate.sourceGroupRef = "T001/C001";
		candidate.observation.metrics = [metric("score", 100 - value, "points", "overall-score")];
		const evaluation = candidate.observation.executionFacts!.evaluations[0];
		evaluation.cases[0].metrics = [metric("latency", value, "ms", "latency-basis")];
		evaluation.cases[0].performance = { basisId: "device:x", elapsedSeconds: {
			value: value / 1000, receiptIndex: 0, fieldPath: "time" } };
		return candidate;
	};
	const first = repeated("C001", 5, "SID-one"), second = repeated("C002", 7, "SID-two");
	second.intent = "diagnostic";
	const alias = repeated("C003", 5, "SID-one");
	alias.observation.verifier.version = "2";
	alias.observation.executionFacts!.evaluations[0].capturedAt = "2026-10-18T01:00:00.000Z";
	const conflict = repeated("C004", 10, "SID-conflict");
	const conflictingAlias = repeated("C005", 11, "SID-conflict");
	conflictingAlias.observation.verifier.version = "3";
	const partial = repeated("C006", 6, "SID-partial");
	partial.observation.correctness = "failed"; // This case is still independently passed.
	const failed = repeated("C007", 20, "SID-failed");
	failed.observation.correctness = "failed";
	failed.observation.executionFacts!.evaluations[0].cases[0].correctness = "failed";
	const unknown = repeated("C008", 30, "SID-unknown");
	unknown.observation.correctness = "unknown";
	unknown.observation.executionFacts!.evaluations[0].cases[0].correctness = "unknown";
	const missingMetrics = repeated("C009", 40);
	missingMetrics.observation.correctness = "failed";
	missingMetrics.observation.metrics = [];
	missingMetrics.observation.executionFacts!.evaluations[0].cases[0].metrics = [];
	const ungrouped = repeated("C010", 0.1);
	ungrouped.sourceGroupRef = undefined;
	ungrouped.identicalSourceRefs = ["T001/C001"]; // Historical labels cannot establish a present byte group.
	const noId = repeated("C011", 0.2, "");
	const pending = repeated("C012", 0.3);
	pending.observation.executionFacts!.evaluations[0].terminal = false;
	const unverified = repeated("C013", 0.4);
	unverified.observation.sourceBinding = "unknown";
	const otherContext = [repeated("C014", 1), repeated("C015", 2)];
	for (const candidate of otherContext)
		candidate.observation.executionFacts!.evaluations[0].cases[0].performance!.basisId = "device:y";
	const otherSubject = [repeated("C016", 1), repeated("C017", 2)];
	for (const candidate of otherSubject) {
		candidate.subjectId = "b";
		candidate.observation.executionFacts!.evaluations[0].subjectId = "b";
	}
	const otherVerifier = [repeated("C018", 1), repeated("C019", 2)];
	for (const candidate of otherVerifier) candidate.observation.verifier.id = "host:other";
	const otherBasis = [repeated("C020", 1), repeated("C021", 2)];
	for (const candidate of otherBasis)
		candidate.observation.executionFacts!.evaluations[0].cases[0].metrics[0].basisId = "other-latency-basis";
	const otherSource = [repeated("C022", 1), repeated("C023", 2)];
	for (const candidate of otherSource) candidate.sourceGroupRef = "T001/C022";
	const contextConflict = [repeated("C025", 4, "SID-context"), repeated("C026", 4, "SID-context")];
	contextConflict[1].observation.executionFacts!.evaluations[0].cases[0].performance!.basisId = "device:y";
	const swappedContexts = [repeated("C027", 1), repeated("C028", 2),
		repeated("C029", 3), repeated("C030", 4)];
	for (const [index, candidate] of swappedContexts.entries()) {
		candidate.sourceGroupRef = "T001/C027";
		const evaluation = candidate.observation.executionFacts!.evaluations[0];
		const firstCase = evaluation.cases[0];
		firstCase.performance!.basisId = index < 2 ? "device:x" : "device:y";
		evaluation.cases.push({ ...firstCase, caseId: "two", performance: {
			...firstCase.performance!, basisId: index < 2 ? "device:y" : "device:x" } });
	}
	const entries = [first, second, alias, conflict, conflictingAlias, partial, failed, unknown,
		missingMetrics, ungrouped, noId, pending, unverified, ...otherContext, ...otherSubject,
		...otherVerifier, ...otherBasis, ...otherSource, ...contextConflict, ...swappedContexts];
	const facts = analyzeCandidateSearch(entries);
	const matching = facts.repeatedSourceObservations.filter(item => item.sourceGroupRef === "T001/C001" &&
		item.subjectId === "a" && item.verifierId === "host:test" &&
		JSON.stringify(item.contextBasisIds) === JSON.stringify(["device:x", "latency-basis"]));
	const overall = matching.find(item => item.scope === "overall")!;
	assert.deepEqual([overall.count, overall.min, overall.median, overall.max], [2, 93, 94, 95]);
	assert.deepEqual(overall.measurements[0], { externalId: "SID-one", value: 95,
		capturedAt: "2026-10-18T00:00:00.000Z", candidateRefs: ["T001/C001", "T001/C003"],
		verifierVersions: ["1", "2"] });
	assert.deepEqual(overall.excludedReadings, { failed: 2, unknown: 1, conflictingExternalIds: 2 },
		"only matching actual metric readings count; a missing metric is not a failed sample");
	const perCase = matching.find(item => item.scope === "case")!;
	assert.equal(perCase.caseId, "one");
	assert.deepEqual([perCase.count, perCase.min, perCase.median, perCase.max], [3, 5, 6, 7],
		"a passed case from an overall failed candidate remains descriptive case evidence");
	assert.deepEqual(perCase.excludedReadings, { failed: 1, unknown: 1, conflictingExternalIds: 2 });
	assert.deepEqual(perCase.contextCases, [{ caseId: "one", basisIds: ["device:x", "latency-basis"] }]);
	assert.deepEqual(perCase.measurements.map(item => item.externalId), ["SID-one", "SID-two", "SID-partial"]);
	assert(facts.repeatedSourceObservations.some(item => item.contextBasisIds.includes("device:y") &&
		item.scope === "overall" && item.count === 2), "even identical top-level score bases retain the actual case context");
	assert(facts.repeatedSourceObservations.some(item => item.metric.basisId === "other-latency-basis"));
	assert(facts.repeatedSourceObservations.some(item => item.sourceGroupRef === "T001/C022"));
	assert(facts.repeatedSourceObservations.some(item => item.subjectId === "b"));
	assert(facts.repeatedSourceObservations.some(item => item.verifierId === "host:other"));
	const conflictingContexts = facts.repeatedSourceObservations.filter(item =>
		item.sourceGroupRef === "T001/C001" && item.subjectId === "a" && item.verifierId === "host:test" &&
		item.metric.basisId === "overall-score" && item.contextBasisIds.includes("device:y"));
	assert.equal(conflictingContexts.length, 1);
	assert.equal(conflictingContexts[0].count, 2);
	assert.equal(conflictingContexts[0].excludedReadings.conflictingExternalIds, 1);
	assert(facts.repeatedSourceObservations.every(item =>
		item.measurements.every(measurement => measurement.externalId !== "SID-context")),
		"the same ID with contradictory context is excluded from both groups");
	const swappedOverall = facts.repeatedSourceObservations.filter(item =>
		item.sourceGroupRef === "T001/C027" && item.scope === "overall");
	assert.equal(swappedOverall.length, 2);
	assert.deepEqual(swappedOverall.map(item => item.count), [2, 2]);
	assert.deepEqual(swappedOverall[0].contextBasisIds, swappedOverall[1].contextBasisIds);
	assert.notDeepEqual(swappedOverall[0].contextCases, swappedOverall[1].contextCases,
		"swapping per-case device bases cannot merge otherwise identical context basis sets");
	assert.deepEqual(analyzeCandidateSearch([first, alias]).repeatedSourceObservations, [],
		"aliases of one ID cannot create a repeated-observation range");
	const multiEvaluation = repeated("C024", 9);
	multiEvaluation.observation.executionFacts!.evaluations.push({
		...multiEvaluation.observation.executionFacts!.evaluations[0], externalId: "", cases: [],
	});
	assert(!analyzeCandidateSearch([first, multiEvaluation]).repeatedSourceObservations
		.some(item => item.scope === "overall"),
		"a second terminal evaluation without an ID still prevents attributing an overall metric to one ID");
	const withoutGroups = entries.map(candidate => ({ ...candidate, sourceGroupRef: undefined }));
	assert.deepEqual(facts.perCaseFrontiers, analyzeCandidateSearch(withoutGroups).perCaseFrontiers);
	assert.deepEqual(globalCandidateBest(entries), globalCandidateBest(withoutGroups),
		"descriptive repetition does not change Pareto or best selection");
	const brief = candidateSearchBrief(facts, entries, { subjectId: "a" });
	assert.equal(brief.repeatedSourceObservationCount,
		facts.repeatedSourceObservations.filter(item => item.subjectId === "a").length);
	assert.equal(brief.repeatedSourceObservations.length, 3);
	assert(brief.omittedRepeatedSourceObservations > 0);
	assert(brief.repeatedSourceObservations.every(item => item.subjectId === "a"));
	assert(brief.repeatedSourceObservations.every(item =>
		!("measurements" in item) && item.candidateRefs.length <= 3),
		"brief rows keep bounded source links without copying the full measurement ledger");
	const largeContext = { ...overall,
		contextBasisIds: Array.from({ length: 1000 }, (_, index) => "basis-" + index),
		contextCases: Array.from({ length: 1000 }, (_, index) => ({ caseId: "case-" + index, basisIds: ["basis-" + index] })) };
	const largeContextFacts = { ...facts, repeatedSourceObservations: [largeContext] };
	const retainedContext = structuredClone(largeContext);
	const contextBrief = candidateSearchBrief(largeContextFacts, entries, { subjectId: "a" }).repeatedSourceObservations[0];
	assert.equal(contextBrief.contextCaseCount, 1000);
	assert.equal(contextBrief.contextBasisCount, 1000);
	assert(!("contextCases" in contextBrief) && !("contextBasisIds" in contextBrief) && !("measurements" in contextBrief),
		"a large exact context cannot expand the default brief into a full case/basis mapping");
	assert.deepEqual(largeContextFacts.repeatedSourceObservations[0], retainedContext,
		"the full facts retain every context mapping and original reading for paged access");
	assert.equal(scopedRepeatedSourceObservations(largeContextFacts, { subjectId: "a" }, entries)[0], largeContext);
	const matchingBrief = candidateSearchBrief({ ...facts, repeatedSourceObservations: matching }, entries, { subjectId: "a" });
	assert(matchingBrief.repeatedSourceObservations.some(item => item.omittedCandidateRefs > 0));
	assert(overall.measurements.length === 2 && perCase.measurements.length === 3,
		"the full facts retain exact measurement provenance for the paged view");
	assert.deepEqual(brief.readRepeatedSourceObservations.args,
		{ section: "repeated-source", subjectId: "a", offset: 0, limit: 50 });
	assert(scopedRepeatedSourceObservations(facts, { subjectId: "a", basisId: "latency-basis" }, entries)
		.every(item => item.subjectId === "a" && item.metric.basisId === "latency-basis"));
	assert.deepEqual(scopedRepeatedSourceObservations(facts, { basisId: "absent-basis" }, entries), []);
	assert.deepEqual(brief.repeatedSourceObservations.map(item => item.sourceGroupRef),
		["T001/C027", "T001/C022", "T001/C001"],
		"the preview interleaves source buckets by their latest distinct external ID's first binding");
	const ordered = scopedRepeatedSourceObservations(facts, { subjectId: "a" }, entries);
	const latestSameSource = ordered.find(item => item.sourceGroupRef === "T001/C001")!;
	assert.equal(latestSameSource.scope, "overall");
	assert(latestSameSource.contextBasisIds.includes("other-latency-basis"),
		"a newer context precedes this source's older overall readings");
	const lateAlias = repeated("C031", 5, "SID-one");
	lateAlias.observation.verifier.version = "4";
	const reboundEntries = [...entries, lateAlias];
	const orderIdentity = (item: typeof ordered[number]) =>
		JSON.stringify([item.sourceGroupRef, item.subjectId, item.verifierId, item.scope,
			item.caseId, item.metric, item.contextCases]);
	assert.deepEqual(scopedRepeatedSourceObservations(analyzeCandidateSearch(reboundEntries),
		{ subjectId: "a" }, reboundEntries).map(orderIdentity), ordered.map(orderIdentity),
		"rebinding an old ID cannot make its source or context appear to be a new trial");
	assert.equal(facts.repeatedSourceObservations[0], overall, "display ordering does not mutate the full facts");
	assert(facts.limitations.some(item => item.includes("not statistical noise")));
});

test("case Pareto preserves tradeoffs and negative exploration without comparing different bases", () => {
	const a = entry("C001", 5, 8, { changeKind: "structure" });
	const b = entry("C002", 6, 4, { changeKind: "parameters" });
	const c = entry("C003", 7, 9, { changeKind: "structure", parentRef: { taskId: "T001", candidateId: "C001" },
		sourceRepetition: "code_cycle", parentComparison: { comparableMetrics: [{ name: "latency", unit: "ms",
			basisId: "subject:a:case:one:device:x", direction: "lower", parentValue: 5,
			candidateValue: 7, delta: 2, improved: false, regressed: true }], caseChanges: [], summary: [] } });
	const nearMiss = entry("C004", 4, 10, { correctness: "failed", changeKind: "repair" });
	const otherBasis = entry("C005", 1, 1, { basisId: "subject:a:case:one:device:y" });
	const unverified = entry("C006", 0.1, 0.1, { sourceBinding: "unknown" });
	const diagnostic = entry("C007", 0.01, 0.01, { intent: "diagnostic" });
	const diagnosticAlias = entry("C008", 0.01, 0.01, { intent: "diagnostic", externalId: "C007" });
	const entries = [a, b, c, nearMiss, otherBasis, unverified, diagnostic, diagnosticAlias];
	const facts = analyzeCandidateSearch(entries);
	const first = facts.perCaseFrontiers.find(group => group.dimensions[0].basisId === "subject:a:case:one:device:x")!;
	assert.deepEqual(first.frontierRefs, ["T001/C007", "T001/C008"],
		"one host-verified diagnostic measurement can lead the case, while its alias is not another vote");
	assert.equal(first.independentMeasurementCount, 5);
	assert.ok(first.dominated.some(item => item.candidateRef === "T001/C001" && item.by.includes("T001/C007")));
	assert.deepEqual(facts.perCaseFrontiers.find(group => group.dimensions[0].basisId.endsWith("device:y"))!.frontierRefs,
		["T001/C005"]);
	assert.equal(facts.explorationParents.find(parent => parent.candidateRef === "T001/C004")?.category, "verified-negative");
	assert.ok(!facts.explorationParents.some(parent => parent.candidateRef === "T001/C006"));
	assert.deepEqual(facts.explorationParents.find(parent => parent.candidateRef === "T001/C007"),
		{ candidateRef: "T001/C007", category: "verified-correct", intent: "diagnostic", passedCases: 1,
			failedCases: 0, unknownCases: 0 });
	assert.equal(facts.searchLeads.find(lead => lead.candidateRefs.includes("T001/C007"))?.bindings[0].solutionParentEligible,
		true, "a host-verified correct diagnostic candidate can be a measured parent without proving the goal");
	assert.deepEqual(candidateSearchBrief(facts, entries, { subjectId: "a" }).diagnosticRefs,
		["T001/C008", "T001/C004"],
		"the latest binding of one correct diagnostic evaluation uses one short-preview slot");
	const noIdA = entry("C009", 0.01, 0.01, { intent: "diagnostic", externalId: "" });
	const noIdB = entry("C010", 0.01, 0.01, { intent: "diagnostic", externalId: "" });
	const withUnknownIds = [...entries, noIdA, noIdB];
	assert.deepEqual(candidateSearchBrief(analyzeCandidateSearch(withUnknownIds), withUnknownIds,
		{ subjectId: "a" }).diagnosticRefs, ["T001/C010", "T001/C009", "T001/C008"],
		"missing external IDs cannot justify collapsing separate diagnostic bindings");
	assert.deepEqual(facts.localNoMeasuredGain, [{ candidateRef: "T001/C003", parentRef: "T001/C001",
		comparedMetrics: 1, regressions: 1 }]);
	assert.deepEqual(facts.repetition, [{ candidateRef: "T001/C003", kind: "code_cycle",
		identicalSourceRefs: ["T001/C001"] }]);
	assert.equal(facts.changeHistory.find(item => item.changeKind === "unspecified")?.unknown, 1,
		"an unbound source cannot count as a correct search result");
});

test("shared external observations keep candidate refs without gaining independent Pareto votes", () => {
	const first = entry("C001", 5, 8, { externalId: "SID158939" });
	const rebound = entry("C002", 5, 8, { externalId: "SID158939" });
	rebound.observation.verifier.version = "2";
	const competitor = entry("C003", 6, 9);
	const otherBasis = entry("C004", 1, 1, { basisId: "other-device" });
	const facts = analyzeCandidateSearch([first, rebound, competitor, otherBasis]);
	const group = facts.perCaseFrontiers.find(item => item.dimensions[0].basisId === "subject:a:case:one:device:x")!;
	assert.equal(group.independentMeasurementCount, 2);
	assert.deepEqual(group.frontierRefs, ["T001/C001", "T001/C002"]);
	assert.deepEqual(group.frontierMeasurements[0].candidateRefs, ["T001/C001", "T001/C002"]);
	assert.equal(facts.searchLeads.filter(item => item.basisIds.includes("subject:a:case:one:device:x")).length, 1);
	assert.equal(facts.changeHistory.find(item => item.changeKind === "unspecified")?.correct, 3,
		"the rebound external ID is one verified success observation");
	const focus = candidateSearchFocus([first, rebound, competitor, otherBasis], "a");
	assert.deepEqual(focus, { subjectId: "a" });
	assert.deepEqual(scopedSearchLeads(facts, [first, rebound, competitor, otherBasis], focus)
		.map(item => item.candidateRefs), [["T001/C004"], ["T001/C001", "T001/C002"]],
		"default focus retains case leads on different measurement bases");
	assert.deepEqual(scopedSearchLeads(facts, [first, rebound, competitor, otherBasis],
		{ subjectId: "a", basisId: "other-device" }).map(item => item.candidateRefs), [["T001/C004"]],
		"an explicit basis still filters exactly");
	assert.deepEqual(candidateSearchBrief(facts, [first, rebound, competitor, otherBasis], focus)
		.readLeads.args, { section: "search-leads", subjectId: "a", offset: 0, limit: 50 });
	const fresh = entry("C005", 2, 2, { externalId: "SID-new", basisId: "fresh-basis" });
	const lateRebound = entry("C006", 5, 8, { externalId: "SID158939" });
	lateRebound.observation.verifier.version = "4";
	const history = [first, competitor, fresh, lateRebound];
	assert.deepEqual(candidateSearchFocus(history, "a"), { subjectId: "a" },
		"a preferred subject remains the default even after a late binding of an old ID");
	const allBasisLeads = scopedSearchLeads(analyzeCandidateSearch(history), history, { subjectId: "a" });
	assert.equal(allBasisLeads[0].candidateRefs[0], "T001/C005",
		"an old measurement cannot become the first search lead merely because it has a new alias");
	const otherSubject = entry("C007", 3, 3, { subjectId: "b", externalId: "SID-b", basisId: "subject-b-basis" });
	assert.deepEqual(candidateSearchFocus([first, otherSubject, lateRebound]),
		{ subjectId: "b" },
		"a late alias must not switch an unfocused view away from the latest distinct subject");
	const multiCase = entry("C008", 3, 4, { externalId: "SID-multi" });
	multiCase.observation.executionFacts!.evaluations[0].cases.push({ caseId: "two", status: "Completed",
		correctness: "passed", metrics: [metric("latency", 2, "ms", "case-two-basis")] });
	const multiCaseFacts = analyzeCandidateSearch([multiCase]);
	assert.deepEqual(scopedSearchLeads(multiCaseFacts, [multiCase], candidateSearchFocus([multiCase], "a"))
		.map(item => item.caseId), ["one", "two"],
		"a multi-case evaluation must show both per-case bases without caller filtering");
	const conflictingReparse = entry("C005", 4, 8, { externalId: "SID158939" });
	conflictingReparse.observation.verifier.version = "3";
	const conflict = analyzeCandidateSearch([first, rebound, conflictingReparse, competitor]);
	const conflictGroup = conflict.perCaseFrontiers[0];
	assert.equal(conflictGroup.independentMeasurementCount, 1,
		"a conflicting reparse across verifier versions cannot create a new Pareto measurement");
	assert.deepEqual(conflictGroup.frontierRefs, ["T001/C003"]);
	assert.ok(conflict.limitations.some(item => item.includes("conflicting values")));
});

test("global best keeps subject identity even when metric basis text is reused", () => {
	const first = entry("C001", 5, 8, { subjectId: "one" });
	const second = entry("C002", 1, 4, { subjectId: "two" });
	for (const candidate of [first, second]) candidate.observation.metrics = [metric("latency", 5, "ms", "same-basis")];
	second.observation.metrics[0].value = 1;
	const unknown = entry("C003", 0.1, 1);
	unknown.observation.executionFacts = undefined;
	unknown.observation.metrics = [metric("latency", 0.1, "ms", "same-basis")];
	assert.deepEqual(globalCandidateBest([first, second, unknown]).map(item =>
		[item.subjectId, item.candidateRef, item.metric.value]),
		[["one", "T001/C001", 5], ["two", "T001/C002", 1]]);
	const diagnostic = entry("C009", 0.2, 1, { subjectId: "one", intent: "diagnostic" });
	diagnostic.observation.metrics = [metric("latency", 0.2, "ms", "same-basis")];
	assert.deepEqual(globalCandidateBest([first, second, unknown, diagnostic]).map(item =>
		[item.subjectId, item.candidateRef, item.metric.value]),
		[["one", "T001/C009", 0.2], ["two", "T001/C002", 1]],
		"model intent cannot hide a host-verified best on the same subject and basis");
	const duplicate = entry("C004", 0.1, 1, { subjectId: "one" });
	duplicate.observation.metrics = [metric("latency", 0.1, "ms", "same-basis"), metric("latency", 0.2, "ms", "same-basis")];
	assert.deepEqual(globalCandidateBest([first, duplicate]).map(item => [item.candidateRef, item.metric.value]),
		[["T001/C001", 5]], "duplicate top-level metric identities cannot donate a favorable best value");
	const original = entry("C005", 5, 8, { subjectId: "one", externalId: "SID-reparsed" });
	original.observation.metrics = [metric("latency", 5, "ms", "same-basis")];
	const reparse = entry("C006", 1, 8, { subjectId: "one", externalId: "SID-reparsed" });
	reparse.observation.verifier.version = "2";
	reparse.observation.metrics = [metric("latency", 1, "ms", "same-basis")];
	assert.deepEqual(globalCandidateBest([original, reparse, second]).map(item => [item.subjectId, item.candidateRef]),
		[["two", "T001/C002"]], "one external measurement with conflicting reparses cannot become best");
	const otherBasis = entry("C007", 0.5, 8, { subjectId: "one", externalId: "SID-reparsed", basisId: "different-case" });
	otherBasis.observation.metrics = [metric("latency", 0.5, "ms", "different-basis")];
	assert.deepEqual(globalCandidateBest([original, reparse, otherBasis]).map(item => [item.candidateRef, item.metric.basisId]),
		[["T001/C007", "different-basis"]], "an independent metric basis remains visible despite another basis conflict");
	const otherHost = entry("C008", 0.4, 8, { subjectId: "one", externalId: "SID-reparsed" });
	otherHost.observation.verifier.id = "host:other";
	otherHost.observation.metrics = [metric("latency", 0.4, "ms", "same-basis")];
	assert.deepEqual(globalCandidateBest([original, reparse, otherHost]).map(item => item.candidateRef),
		["T001/C008"], "one host's external ID cannot invalidate a different verifier's observation");
});
