import assert from "node:assert/strict";
import test from "node:test";
import { privateHostPreparationDiagnostic } from
	"../scripts/prepare-authenticated-private-resume.ts";
import { IncrementalCheckpointError } from
	"../src/runner/incremental-private-checkpoint.ts";
import { PeriodicPrefixRecoveryError } from
	"../src/runner/ledger-continuation.ts";

test("private host result retains exact static periodic-prefix decoder cause", () => {
	const failure = new PeriodicPrefixRecoveryError("authentication", "invalid-aead-prefix",
		new IncrementalCheckpointError("authentication", "tag-verification-failed"));
	const expected = { code: "runner.periodic-prefix-recovery.authentication.invalid-aead-prefix",
		stage: "authentication", reason: "invalid-aead-prefix",
		checkpointStage: "authentication", checkpointReason: "tag-verification-failed" };
	assert.deepEqual(privateHostPreparationDiagnostic(failure), expected);
	assert.deepEqual(privateHostPreparationDiagnostic(new AggregateError([
		new Error("raw private reply must not escape"), failure])), {
		code: "terminal-authentication-failed", attempts: [
			{ code: "unclassified-host-preparation-error" }, expected] });
});
