import assert from "node:assert/strict";
import test from "node:test";
import { classifyToolFailure, classifyTransportFailure, remainingWallClockNote, runDeadlineFromEnvironment,
	tallyFailures } from "../../src/runner/failure-class.ts";

test("a command that ran and failed is the candidate's result; a broken environment is not", () => {
	assert.deepEqual(classifyToolFailure({ name: "bash", exit: { exitCode: 2, abortSource: null } }),
		{ class: "policy", reason: "nonzero-exit", retryable: false });
	assert.deepEqual(classifyToolFailure({ name: "bash", exit: { exitCode: null, abortSource: "timeout" } }),
		{ class: "infrastructure", reason: "tool-timeout", retryable: true });
	assert.deepEqual(classifyToolFailure({ name: "bash", errorCode: "ECONNRESET" }),
		{ class: "infrastructure", reason: "ECONNRESET", retryable: true });
	assert.deepEqual(classifyToolFailure({ name: "bash", errorCode: "platform.device-lease" }),
		{ class: "infrastructure", reason: "platform.device-lease", retryable: true });
	assert.deepEqual(classifyToolFailure({ name: "write", errorCode: "runner.platform-contract" }),
		{ class: "policy", reason: "platform-contract-violation", retryable: false });
	// The platform profile's own reading of the output decides before anything else.
	assert.deepEqual(classifyToolFailure({ name: "bash", exit: { exitCode: 1, abortSource: null }, platformClass: "infrastructure" }),
		{ class: "infrastructure", reason: "platform-reported-environment-fault", retryable: true });
	assert.deepEqual(classifyToolFailure({ name: "bash", exit: { exitCode: 1, abortSource: null }, platformClass: "syntax" }),
		{ class: "policy", reason: "candidate-syntax", retryable: false });
});

test("anything the closed list does not cover stays unjudged and is never retried", () => {
	assert.deepEqual(classifyToolFailure({ name: "bash" }),
		{ class: "unjudged", reason: "unclassified", retryable: false });
	assert.deepEqual(classifyToolFailure({ name: "bash", errorCode: "EWEIRD" }),
		{ class: "unjudged", reason: "EWEIRD", retryable: false });
	// A killed process could be either side; guessing would blame the candidate.
	assert.deepEqual(classifyToolFailure({ name: "bash", exit: { exitCode: null, abortSource: "signal" } }),
		{ class: "unjudged", reason: "tool-killed", retryable: false });
	assert.deepEqual(classifyToolFailure({ name: "bash", exit: { exitCode: 0, abortSource: null } }),
		{ class: "unjudged", reason: "unclassified", retryable: false });
});

test("provider failures are split the same way", () => {
	const base = { httpStatus: null, providerErrorCode: null, abortSource: null, errorCodes: [] } as const;
	assert.deepEqual(classifyTransportFailure({ ...base, httpStatus: 503 }),
		{ class: "infrastructure", reason: "provider-5xx", retryable: true });
	assert.deepEqual(classifyTransportFailure({ ...base, providerErrorCode: "rate_limit_exceeded" }),
		{ class: "infrastructure", reason: "rate_limit_exceeded", retryable: true });
	assert.deepEqual(classifyTransportFailure({ ...base, transportInterrupted: true }),
		{ class: "infrastructure", reason: "transport-interrupted", retryable: true });
	assert.deepEqual(classifyTransportFailure({ ...base, providerErrorReasonClass: "context-window" }),
		{ class: "policy", reason: "context-window-exceeded", retryable: false });
	assert.deepEqual(classifyTransportFailure({ ...base, attemptedRequestNotSent: true }),
		{ class: "policy", reason: "request-contract-violation", retryable: false });
	assert.deepEqual(classifyTransportFailure({ ...base, abortSource: "handle" }),
		{ class: "unjudged", reason: "aborted-by-host", retryable: false });
	assert.deepEqual(classifyTransportFailure({ ...base, httpStatus: 418 }),
		{ class: "unjudged", reason: "unclassified-provider-failure", retryable: false });
});

test("the unjudged share is reported rather than folded into either side", () => {
	assert.deepEqual(tallyFailures([]), { infrastructure: 0, policy: 0, unjudged: 0, unjudgedShare: 0 });
	assert.deepEqual(tallyFailures([
		classifyToolFailure({ name: "bash", exit: { exitCode: 1, abortSource: null } }),
		classifyToolFailure({ name: "bash", exit: { exitCode: null, abortSource: "timeout" } }),
		classifyToolFailure({ name: "bash", errorCode: "EWEIRD" }),
		classifyToolFailure({ name: "bash", errorCode: "EWEIRD" }),
	]), { infrastructure: 1, policy: 1, unjudged: 2, unjudgedShare: 0.5 });
});

test("remaining wall-clock reads as time left and turns into a save instruction at the end", () => {
	const now = Date.parse("2026-10-18T12:00:00.000Z");
	assert.match(remainingWallClockNote("2026-10-18T14:30:00.000Z", now) ?? "", /^Run budget: 2h30m of wall-clock left\./);
	assert.match(remainingWallClockNote("2026-10-18T12:07:00.000Z", now) ?? "", /^Run budget: 7m of wall-clock left\./);
	assert.match(remainingWallClockNote("2026-10-18T11:30:00.000Z", now) ?? "", /^Run deadline passed\./);
	assert.equal(remainingWallClockNote("not a time", now), undefined);
	assert.equal(runDeadlineFromEnvironment({}), undefined);
	assert.equal(runDeadlineFromEnvironment({ PRE_RSI_RUN_DEADLINE: "2026-10-18T14:30:00.000Z" }), "2026-10-18T14:30:00.000Z");
	assert.throws(() => runDeadlineFromEnvironment({ PRE_RSI_RUN_DEADLINE: "soon" }), /must be an ISO timestamp/);
});
