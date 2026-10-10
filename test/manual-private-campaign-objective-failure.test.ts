import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { offlineChecks } from "../scripts/manual-private-campaign.ts";
import { readObjectiveCheckpointFile, writeObjectiveCheckpointFile } from
	"../src/m07/objective-checkpoint-store.ts";
import { IncrementalCheckpointError } from "../src/runner/incremental-private-checkpoint.ts";

test("campaign collector reads a multipart checkpoint as exact logical JSON", async t => {
	const dir = await mkdtemp(path.join(os.tmpdir(), "synthetic-objective-collector-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const file = path.join(dir, "objective-checkpoint.json");
	const checkpoint = `${JSON.stringify({ version: 1, kind: "original-objective-progress",
		contract: { id: "synthetic-contract" },
		boundedRuns: [{ runId: "synthetic-goal", selectedTaskId: "T001" }],
		selectedArtifacts: ["candidate.cpp", "verification.json"],
		historicalExplanation: "x".repeat(4_458_098) })}\n`;
	assert.ok(Buffer.byteLength(checkpoint) > 4 * 1024 * 1024);
	await writeObjectiveCheckpointFile(file, checkpoint);
	await writeFile(path.join(dir, "candidate.cpp"), "// synthetic source\n");
	await writeFile(path.join(dir, "verification.json"), JSON.stringify({ version: 1, status: "passed" }));
	await writeFile(path.join(dir, "workflow-archive.json"), JSON.stringify({ version: 1,
		kind: "m07-private-candidate-archive", goalRunId: "synthetic-goal", taskId: "T001",
		controllerEvidence: { reviewStatus: "accepted" } }));
	const names = await readdir(dir);
	assert.ok(names.some(name => name.startsWith("objective-checkpoint.part-")));
	assert.ok((await stat(file)).size < 4 * 1024 * 1024);
	assert.equal(await readObjectiveCheckpointFile(file), checkpoint);
	const collected = await offlineChecks.collectContinuationBundle(dir);
	assert.equal(collected?.["objective-checkpoint.json"], checkpoint,
		"collector gives selected-tuple validation the logical checkpoint, never the manifest");
});

test("the exact long typed incremental failure survives private cause reporting", () => {
	const error = new IncrementalCheckpointError("decoded-schema", "objective-checkpoint-invalid");
	const diagnostic = offlineChecks.privateExceptionDiagnostic(error, "sk-SYNTHETICCONTROLKEY999");
	assert.equal(diagnostic.code,
		"runner.incremental-checkpoint.decoded-schema.objective-checkpoint-invalid");
	assert.equal(diagnostic.category, "incremental-checkpoint");
	assert.equal(diagnostic.message, "private incremental checkpoint is incomplete");
	assert.deepEqual(offlineChecks.privateExceptionCauseChain(error, undefined), [diagnostic]);
});

test("terminal failure retains prior private collection and accounting causes", () => {
	const collectionFailure = { stage: "research-continuation-collection",
		kind: "host-invariant", message: "continuation evidence must be a bounded regular file" };
	const previous = { version: 1, runId: "prior", phase: "finalizing", budget: { sample: true },
		collectionFailure, accountingAudit: { requests: [{ requestId: "synthetic-observed" }] },
		originalObjective: { stopReason: "dispatch-failed", checkpointFile: "objective-checkpoint.json" } };
	const merged = offlineChecks.terminalFailureStatus(previous, {
		outcome: "incomplete", exceptionCode:
			"runner.incremental-checkpoint.decoded-schema.objective-checkpoint-invalid",
		originalObjective: { outcome: "incomplete", checkpointFile: "objective-checkpoint.json" },
	});
	assert.equal(merged.collectionFailure, collectionFailure);
	assert.equal(merged.accountingAudit, previous.accountingAudit);
	assert.deepEqual(merged.originalObjective, {
		stopReason: "dispatch-failed", checkpointFile: "objective-checkpoint.json", outcome: "incomplete" });
	for (const key of ["version", "runId", "phase", "budget"])
		assert.equal(Object.hasOwn(merged, key), false, "saveStatus owns its fresh header");
});

test("each durable assessment can include settled follow-on controller runs", () => {
	const rows = offlineChecks.observedFollowOnBoundedRuns([
		{ state: "completed", goalRunId: "synthetic-A", taskId: "T002",
			m07Outcome: "fulfilled", candidateSelected: true },
		{ state: "completed", goalRunId: "synthetic-B", taskId: "T001",
			m07Outcome: "partial", candidateSelected: false },
		{ state: "failed", goalRunId: "synthetic-C", taskId: "T001",
			candidateSelected: true },
		{ state: "not_run" },
	]);
	assert.deepEqual(rows, [
		{ runId: "synthetic-A", outcome: "fulfilled", acceptedTaskIds: ["T002"],
			selectedTaskId: "T002" },
		{ runId: "synthetic-B", outcome: "partial", acceptedTaskIds: [] },
		{ runId: "synthetic-C", outcome: "unknown", acceptedTaskIds: [] },
	]);
});

test("model-facing prior-run control counts omit source IDs and scientific authority", () => {
	const source = { runId: "private-run-identifier", runAttempt: 1,
		runNumber: 43, commit: "a".repeat(40) };
	const summary = offlineChecks.priorIncompleteRunControlSummary({ source,
		requestCount: 1019, responseReceivedCount: 1019, unknownCount: 1019,
		currentEffectReviewPending: true, selectionAuthority: false, complete: false });
	assert.deepEqual(summary.requestObservation,
		{ total: 1019, responsesReceived: 1019, billingStateUnknown: 1019 });
	assert.equal(summary.goalTaskCensus, "unavailable-in-terminal-carry");
	assert.equal(summary.scientificOutcome,
		"unreviewed; absent current-run research files do not imply no work");
	assert.equal(summary.selectionAuthority, false);
	assert.doesNotMatch(JSON.stringify(summary), /private-run-identifier|a{40}/);
});

test("objective failures retain chronological pre-session stages and initiating causes", () => {
	const before = offlineChecks.objectiveAssessmentFailureSnapshot().length;
	const key = "sk-SYNTHETICOBJECTIVEKEY999";
	const frozenCause = Object.assign(new Error(`HTTP 503 Bearer ${key}`),
		{ code: "PROVIDER_UNAVAILABLE" });
	const frozenError = Object.assign(new Error(`frozen copy failed api_key=${key}`, { cause: frozenCause }),
		{ code: "FROZEN_COPY_FAILED" });
	const failures = [
		{ iteration: 1, stage: "contract-read" as const,
			error: Object.assign(new Error("synthetic contract read failed"), { code: "ENOENT" }) },
		{ iteration: 1, stage: "frozen-copy" as const, error: frozenError },
		{ iteration: 2, stage: "session-create" as const,
			error: Object.assign(new Error("synthetic session creation failed"), { code: "EACCES" }) },
	];
	for (const failure of failures)
		offlineChecks.observeObjectiveAssessmentFailure(failure.iteration, failure.stage, failure.error, key);

	const observed = offlineChecks.objectiveAssessmentFailureSnapshot().slice(before);
	assert.deepEqual(observed.map(row => [row.iteration, row.stage]),
		[[1, "contract-read"], [1, "frozen-copy"], [2, "session-create"]]);
	assert.deepEqual(observed.map(row => row.causeChain.map(cause => cause.code)),
		[["ENOENT"], ["FROZEN_COPY_FAILED", "PROVIDER_UNAVAILABLE"], ["EACCES"]]);
	assert.equal(observed[1]!.causeChain[0]!.message,
		"frozen copy failed api_key=[REDACTED_KEY]");
	assert.equal(observed[1]!.causeChain[1]!.category, "http-503");
	assert.equal(observed[1]!.causeChain[1]!.message,
		"HTTP 503 Bearer [REDACTED_KEY]");
	assert.doesNotMatch(JSON.stringify(observed), /SYNTHETICOBJECTIVEKEY999/);
	assert.equal(observed[1]!.causeChain[0]!.code, frozenError.code,
		"the initiating error must precede its cause");
});

test("nested Error.cause is bounded by object identity when a cause cycles", () => {
	const key = "sk-SYNTHETICCAUSEKEY999";
	const last = Object.assign(new Error(`credential rejected password=${key}`),
		{ code: "AUTH_REJECTED", cause: undefined as unknown });
	const middle = Object.assign(new Error("HTTP 401 from synthetic provider", { cause: last }),
		{ code: "PROVIDER_REJECTED" });
	const initiating = Object.assign(new Error("objective assessor failed", { cause: middle }),
		{ code: "ASSESSOR_FAILED" });
	last.cause = middle;

	const chain = offlineChecks.privateExceptionCauseChain(initiating, key);
	assert.deepEqual(chain.map(row => row.code),
		["ASSESSOR_FAILED", "PROVIDER_REJECTED", "AUTH_REJECTED"]);
	assert.deepEqual(chain.map(row => row.category),
		["unclassified", "http-401", "unclassified"]);
	assert.equal(chain[2]!.message, "credential rejected password=[REDACTED_KEY]");
	assert.doesNotMatch(JSON.stringify(chain), /SYNTHETICCAUSEKEY999/);
});

test("prompt failure with an uncertain issued request differs from zero-session preflight", () => {
	const before = offlineChecks.objectiveAssessmentFailureSnapshot().length;
	const key = "sk-SYNTHETICPROMPTKEY999";
	const preflight = Object.assign(new Error("synthetic evidence scan failed"),
		{ code: "EVIDENCE_SCAN_FAILED" });
	const prompt = Object.assign(new Error("synthetic prompt transport failed"),
		{ code: "PROMPT_TRANSPORT_FAILED" });
	offlineChecks.observeObjectiveAssessmentFailure(3, "evidence-scan", preflight, key);
	offlineChecks.observeObjectiveAssessmentFailure(3, "prompt", prompt, key);
	const [preflightRow, promptRow] = offlineChecks.objectiveAssessmentFailureSnapshot().slice(before);
	assert.deepEqual([preflightRow?.stage, promptRow?.stage], ["evidence-scan", "prompt"]);
	assert.equal(preflightRow?.causeChain[0]?.code, "EVIDENCE_SCAN_FAILED");
	assert.equal(promptRow?.causeChain[0]?.code, "PROMPT_TRANSPORT_FAILED");

	const emptyAudit: Parameters<typeof offlineChecks.observedTransportActionFacts>[2] = {
		version: 3, kind: "accounting-only-request-audit", requests: [],
		settledCny: 0, unknownObservedCny: 0, unpricedRequestCount: 0 };
	const issuedAudit: Parameters<typeof offlineChecks.observedTransportActionFacts>[2] = {
		...emptyAudit, unpricedRequestCount: 1,
		requests: [{ requestId: "synthetic-issued-request", sessionId: "synthetic-session",
			responseReceived: false, inputPayloadBytes: 100, maxOutputTokens: 50,
			status: "unknown", settledCny: null, unknownObservedCny: null,
			reportedUsage: null }] };
	const zeroSessionFacts = offlineChecks.observedTransportActionFacts("assessment-failed", [],
		emptyAudit, "read-only-assessor");
	const uncertainPromptFacts = offlineChecks.observedTransportActionFacts("assessment-failed",
		[{ version: 1, promptIndex: 1, requestId: "synthetic-issued-request", phase: "request",
			httpStatus: null, responseStarted: false, bytesRead: null, abortSource: null,
			providerErrorCode: null, providerErrorType: null, providerRequestId: null, errorCodes: [] }],
		issuedAudit, "read-only-assessor");
	assert.deepEqual(zeroSessionFacts, { failedStage: "read-only-assessor" });
	assert.deepEqual(uncertainPromptFacts,
		{ failedStage: "read-only-assessor", transportFailure: true });
	assert.equal("transportFailure" in zeroSessionFacts, false);
});
