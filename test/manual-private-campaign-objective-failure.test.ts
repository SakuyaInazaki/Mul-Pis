import assert from "node:assert/strict";
import test from "node:test";
import { offlineChecks } from "../scripts/manual-private-campaign.ts";

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
