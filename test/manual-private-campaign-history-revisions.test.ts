import assert from "node:assert/strict";
import test from "node:test";
import { offlineChecks } from "../scripts/manual-private-campaign.ts";
import { HarnessError } from "../src/types.ts";

const goalRunId = "R041", taskId = "T003", originalContractId = "synthetic-contract";
const sourceFiles = {
	"candidate.cpp": "// exact synthetic source\n",
	"verification.json": "{\"version\":1,\"status\":\"passed\"}\n",
	"experiment-plan.json": "{\"version\":1,\"question\":\"synthetic\"}\n",
};

function archive(m04?: Record<string, unknown>): string {
	return `${JSON.stringify({ version: 1, kind: "m07-private-candidate-archive", goalRunId, taskId,
		goalOutcome: "fulfilled", taskStatus: "accepted",
		controllerEvidence: { reviewStatus: "accepted", operationOutcomes: [] },
		...(m04 ? { m04 } : {}) })}\n`;
}

function historicalEntry(files: Record<string, string>, interpretation = "Synthetic untrusted development record") {
	return { originalContractId, goalRunId, taskId, interpretation, files };
}

function oldTenFiles() {
	return { ...sourceFiles, "workflow-archive.json": archive({ state: "not-run" }),
		"lesson-delta.json": "{\"lesson\":\"old exact bytes\"}\n",
		"review-decision.json": "{\"review\":\"old exact bytes\"}\n",
		...Object.fromEntries([1, 2, 3, 4].map(round =>
			[`round-${round}-reviewer-feedback.txt`, `Old feedback ${round}\n`])) };
}

function newSixFiles() {
	return { ...sourceFiles, "workflow-archive.json": archive({ state: "completed", runId: "M04-synthetic",
		proposalSubmitted: true, snapshotCreated: true,
		knowledgeExport: { state: "complete", file: "m04-adopted-knowledge.json" },
		transaction: { state: "merged", file: "m04-transaction.json" } }),
		"m04-adopted-knowledge.json": "{\"adopted\":\"synthetic\"}\n",
		"m04-transaction.json": "{\"state\":\"merged\"}\n" };
}

test("same-task M04 upgrade retains exact older ten-file snapshot beneath current six-file authority", () => {
	const old = historicalEntry(oldTenFiles(), "Earlier untrusted review and lessons");
	const next = historicalEntry(newSixFiles(), "Current M04 outcome");
	const entries: Array<Record<string, any>> = [];
	offlineChecks.retainHistoricalArchiveEntry(entries, old);
	offlineChecks.retainHistoricalArchiveEntry(entries, next);
	assert.equal(entries.length, 1);
	assert.deepEqual(entries[0].files, next.files);
	assert.deepEqual(entries[0].supersededVersions, [{ interpretation: old.interpretation, files: old.files }]);
	assert.equal(Object.keys(entries[0].files).length, 6);
	assert.equal(Object.keys(entries[0].supersededVersions[0].files).length, 10);
	const readable = JSON.parse(offlineChecks.rangeReadableHistory(JSON.stringify({ version: 1,
		kind: "untrusted-version-bound-research-history", entries })));
	assert.deepEqual(readable.entries[0].supersededVersions[0].files, old.files);
	const passThrough: Array<Record<string, any>> = [];
	offlineChecks.retainHistoricalArchiveEntry(passThrough, JSON.parse(JSON.stringify(entries[0])));
	assert.deepEqual(passThrough, entries);
	// A superseded failed M04 attempt cannot reopen import or adoption after current completion.
	const failedPredecessor = historicalEntry({ ...oldTenFiles(),
		"workflow-archive.json": archive({ state: "failed", runId: "M04-earlier",
			proposalSubmitted: false, snapshotCreated: false }) });
	const historyWithFailedPredecessor = offlineChecks.restoreHistoricalArchivePredecessor(next, failedPredecessor);
	// Import and M04 selection consume only entry.files, never supersededVersions.
	const bundle = { "research-history.json": JSON.stringify({ version: 1,
		kind: "untrusted-version-bound-research-history", entries: [historyWithFailedPredecessor] }),
		"objective-checkpoint.json": JSON.stringify({ contract: { id: originalContractId },
			boundedRuns: [{ runId: goalRunId, selectedTaskId: taskId, outcome: "fulfilled" }] }) };
	assert.equal(offlineChecks.archivedM07ImportTarget(bundle as any), undefined);
});

test("authenticated predecessor recovery enriches current entry without rewriting current files", () => {
	const predecessor = historicalEntry(oldTenFiles(), "Earlier untrusted review and lessons");
	const current = historicalEntry(newSixFiles(), "Current M04 outcome");
	const recovered = offlineChecks.restoreHistoricalArchivePredecessor(current, predecessor);
	assert.deepEqual(recovered.files, current.files);
	assert.deepEqual(recovered.supersededVersions,
		[{ interpretation: predecessor.interpretation, files: predecessor.files }]);
	assert.equal("supersededVersions" in current, false, "pure restoration cannot mutate its input");
	assert.deepEqual(offlineChecks.restoreHistoricalArchivePredecessor(recovered, predecessor), recovered);
	const rows: Array<Record<string, any>> = [];
	offlineChecks.retainHistoricalArchiveEntry(rows, recovered);
	assert.deepEqual(rows[0], recovered, "the next pass preserves recovered old bytes");
});

test("legacy singleton history keeps omitted interpretation and unranked M04 bytes without adoption", () => {
	const files = { ...sourceFiles, "workflow-archive.json": archive({ runId: "M04-legacy" }) };
	const legacy = { originalContractId, goalRunId, taskId, files };
	const entries: Array<Record<string, any>> = [];
	offlineChecks.retainHistoricalArchiveEntry(entries, legacy);
	assert.deepEqual(entries, [legacy], "a historical singleton is retained byte for byte");
	assert.equal(Object.hasOwn(entries[0], "interpretation"), false);
	assert.equal(Object.hasOwn(entries[0], "supersededVersions"), false);
	assert.throws(() => offlineChecks.retainHistoricalArchiveEntry(entries, historicalEntry(newSixFiles())),
		/historical M04 state is invalid/,
		"an unranked old M04 cannot authorize a same-task upgrade");
	assert.deepEqual(entries, [legacy], "a rejected collision cannot change the old row");
	const oldWithoutInterpretation = { originalContractId, goalRunId, taskId, files: oldTenFiles() };
	const progressed: Array<Record<string, any>> = [];
	offlineChecks.retainHistoricalArchiveEntry(progressed, oldWithoutInterpretation);
	offlineChecks.retainHistoricalArchiveEntry(progressed, historicalEntry(newSixFiles()));
	assert.deepEqual(progressed[0].supersededVersions, [{ files: oldWithoutInterpretation.files }],
		"a comparable upgrade preserves the old absence without inventing a description");
});

test("identical partial historical attempts pass through while changed partial states require full proof", () => {
	const cases: Array<Record<string, string>> = [
		{ "workflow-archive.json": archive({ state: "not-run" }),
			"verification.json": sourceFiles["verification.json"] },
		{ "workflow-archive.json": archive({ state: "not-run" }),
			"candidate.cpp": sourceFiles["candidate.cpp"],
			"verification.json": sourceFiles["verification.json"] },
	];
	for (const files of cases) {
		const partial = historicalEntry(files);
		const before = JSON.stringify(partial);
		assert.deepEqual(offlineChecks.restoreHistoricalArchivePredecessor(partial,
			JSON.parse(before)), partial);
		assert.equal(JSON.stringify(partial), before, "recovery leaves identical partial bytes untouched");
		assert.throws(() => offlineChecks.restoreHistoricalArchivePredecessor(
			{ ...partial, interpretation: "different untrusted description" }, partial),
			/archives lack (candidate\.cpp|experiment-plan\.json)/,
			"a changed partial entry cannot bypass the complete same-task progression check");
	}
	const current = historicalEntry(newSixFiles());
	const older = historicalEntry(oldTenFiles());
	const partial = { originalContractId, goalRunId: "R000", taskId: "T001",
		files: { "verification.json": sourceFiles["verification.json"] } };
	const reconciled = offlineChecks.reconcileHistoricalResearchEntries([partial, current],
		[structuredClone(partial), older]);
	assert.deepEqual(reconciled[0], partial, "the production loop preserves untouched partial history");
	assert.deepEqual(reconciled[1].files, current.files,
		"the production loop retains the latest top-level authority");
	assert.deepEqual(reconciled[1].supersededVersions, [{ interpretation: older.interpretation,
		files: older.files }], "the production loop restores changed same-task raw bytes");
	assert.equal(Object.hasOwn(current, "supersededVersions"), false,
		"the production reconciliation is pure on its inputs");
});

test("history revision and recovery reject divergent sources, malformed snapshots, and M04 rollback", () => {
	const older = historicalEntry(oldTenFiles());
	const current = historicalEntry(newSixFiles());
	for (const name of ["candidate.cpp", "verification.json", "experiment-plan.json"]) {
		const divergent = historicalEntry({ ...older.files, [name]: `changed ${name}` });
		assert.throws(() => offlineChecks.restoreHistoricalArchivePredecessor(current, divergent),
			new RegExp(`archives disagree on ${name.replace(".", "\\.")}`));
		const missing = historicalEntry({ ...older.files });
		delete missing.files[name];
		assert.throws(() => offlineChecks.restoreHistoricalArchivePredecessor(current, missing),
			new RegExp(`archives lack ${name.replace(".", "\\.")}`));
	}
	assert.throws(() => offlineChecks.restoreHistoricalArchivePredecessor(older, current),
		/historical M04 version rollback/);
	assert.throws(() => offlineChecks.retainHistoricalArchiveEntry([], {
		...current, supersededVersions: [{ files: older.files, interpretation: 42 }] }), /historical version is invalid/);
	assert.throws(() => offlineChecks.retainHistoricalArchiveEntry([], {
		...older, supersededVersions: [{ interpretation: "later", files: current.files }] }),
		/historical M04 version rollback/);
	const recovered = offlineChecks.restoreHistoricalArchivePredecessor(current, older);
	assert.throws(() => offlineChecks.retainHistoricalArchiveEntry([recovered], {
		...current, supersededVersions: [{ interpretation: "forged", files: older.files }] }),
		/historical version rollback or divergence/);
});

test("revision and recovery reject unmodeled outer metadata before it can be dropped", () => {
	const older = historicalEntry(oldTenFiles());
	const current = historicalEntry(newSixFiles());
	const extra = { observationReceipt: "exact legacy metadata" };
	const unmodeledOlder = { ...older, ...extra };
	const legacyPassThrough: Array<Record<string, any>> = [];
	offlineChecks.retainHistoricalArchiveEntry(legacyPassThrough, unmodeledOlder);
	assert.deepEqual(legacyPassThrough[0], unmodeledOlder,
		"an unchanged legacy entry keeps its extra metadata");
	const typedIntegrityError = (error: unknown) => error instanceof HarnessError &&
		error.code === "campaign.historical-archive-integrity" &&
		/unsupported outer metadata/.test(error.message);
	assert.throws(() => offlineChecks.retainHistoricalArchiveEntry(legacyPassThrough, current),
		typedIntegrityError, "the old metadata cannot vanish into a two-field snapshot");
	assert.deepEqual(legacyPassThrough[0], unmodeledOlder, "rejection leaves the old row untouched");
	assert.throws(() => offlineChecks.retainHistoricalArchiveEntry([older], { ...current, ...extra }),
		typedIntegrityError);
	assert.throws(() => offlineChecks.restoreHistoricalArchivePredecessor(current, unmodeledOlder),
		typedIntegrityError);
	assert.throws(() => offlineChecks.restoreHistoricalArchivePredecessor({ ...current, ...extra }, older),
		typedIntegrityError);
});
