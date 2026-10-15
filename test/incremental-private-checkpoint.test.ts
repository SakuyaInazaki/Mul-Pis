import assert from "node:assert/strict";
import { createHash, createPublicKey, generateKeyPairSync, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test, { type TestContext } from "node:test";
import { INCREMENTAL_CHECKPOINT_FILE, IncrementalPrivateCheckpointJournal,
	IncrementalCheckpointError, openIncrementalControlPrefix,
	type IncrementalCheckpointInput, type IncrementalCheckpointSource } from
	"../src/runner/incremental-private-checkpoint.ts";

const run = promisify(execFile);
const sha = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
function expectDiagnostic(stage: IncrementalCheckpointError["stage"],
	reason: IncrementalCheckpointError["reason"]) {
	return (error: unknown): boolean => {
		assert(error instanceof IncrementalCheckpointError);
		assert.equal(error.stage, stage);
		assert.equal(error.reason, reason);
		assert.match(error.code, /^runner\.incremental-checkpoint\./);
		assert.equal(error.message, "private incremental checkpoint is incomplete");
		return true;
	};
}
const source: IncrementalCheckpointSource = {
	repository: "Example/Repository", runId: "81234", runAttempt: 1,
	commit: "a".repeat(40), event: "workflow_dispatch",
	priorEnvelopeSha256: "b".repeat(64),
};
function snapshot(request = false): IncrementalCheckpointInput {
	const requests = request ? [{ requestId: "request-1", sessionId: "c".repeat(64),
		responseReceived: false, inputPayloadBytes: 120, maxOutputTokens: 8192,
		outputTokenField: "max_completion_tokens" as const,
		status: "in-flight" as const, settledCny: null, unknownObservedCny: null,
		reportedUsage: null }] : [];
	return { requestAudit: { version: 3, kind: "accounting-only-request-audit",
		requests, settledCny: 0, unknownObservedCny: 0,
		unpricedRequestCount: request ? 1 : 0 },
		hostEffects: { version: 1, kind: "host-effect-prefix-observation",
			complete: false, selectionAuthority: false,
			source: { runId: source.runId, runAttempt: source.runAttempt, commit: source.commit },
			priorEnvelopeSha256: source.priorEnvelopeSha256, historicalGoalRunIds: [],
			goals: [], sessions: [], requestIds: requests.map(row => row.requestId) } };
}
async function fixture(t: TestContext, publish?: ConstructorParameters<
	typeof IncrementalPrivateCheckpointJournal>[0]["publish"]) {
	const dir = await mkdtemp(path.join(os.tmpdir(), "incremental-private-test-"));
	t.after(async () => rm(dir, { recursive: true, force: true }));
	const outputDir = path.join(dir, "output");
	await mkdir(outputDir, { mode: 0o700 });
	const authenticatedMissionKey = randomBytes(32);
	const journal = new IncrementalPrivateCheckpointJournal({ source, outputDir,
		authenticatedMissionKey, publish });
	return { dir, outputDir, journal, authenticatedMissionKey };
}
async function wrapperRoundTrip(f: Awaited<ReturnType<typeof fixture>>) {
	const pair = generateKeyPairSync("rsa", { modulusLength: 3072,
		publicKeyEncoding: { type: "spki", format: "pem" },
		privateKeyEncoding: { type: "pkcs8", format: "pem" } });
	const publicKey = path.join(f.dir, "public.pem"), privateKey = path.join(f.dir, "private.pem");
	await writeFile(publicKey, pair.publicKey, { mode: 0o600 });
	await writeFile(privateKey, pair.privateKey, { mode: 0o600 });
	const spki = createPublicKey(pair.publicKey).export({ type: "spki", format: "der" });
	const script = path.resolve("scripts/private_actions_transport.py");
	const envelope = path.join(f.dir, "outcome.enc.json");
	await run("python3", [script, "encrypt", "--results", f.outputDir,
		"--public-key", publicKey, "--expected-spki-sha256", sha(spki),
		"--output", envelope, "--repository", source.repository,
		"--run-id", source.runId, "--run-attempt", String(source.runAttempt),
		"--commit", source.commit, "--event", source.event]);
	const parent = path.join(f.dir, "decrypted");
	await mkdir(parent, { mode: 0o700 });
	const { stdout } = await run("python3", [script, "decrypt", "--envelope", envelope,
		"--private-key", privateKey, "--parent", parent]);
	return { envelope: await readFile(envelope),
		body: await readFile(path.join(stdout.trim(), INCREMENTAL_CHECKPOINT_FILE), "utf8") };
}

test("atomic local prefix travels in existing RSA wrapper with unknown billing and no replay", async t => {
	const f = await fixture(t);
	const first = await f.journal.record("initial", snapshot());
	const second = await f.journal.record("request-reserved", {
		...snapshot(true), secretExtra: "SECRET-SENTINEL" } as IncrementalCheckpointInput);
	assert.equal(first.sequence, 1);
	assert.equal(second.sequence, 2);
	const completeBytes = await readFile(path.join(f.outputDir, INCREMENTAL_CHECKPOINT_FILE));
	assert.equal(second.sha256, sha(completeBytes));
	const { body, envelope } = await wrapperRoundTrip(f);
	const prefix = openIncrementalControlPrefix(body, f.authenticatedMissionKey, source);
	assert.equal(prefix.sequence, 2);
	assert.equal(prefix.previousCheckpointSha256, first.sha256);
	assert.equal(prefix.requestAudit.requests[0].status, "in-flight");
	assert.equal(prefix.requestAudit.requests[0].settledCny, null);
	assert.equal(prefix.replayAllowed, false);
	assert.equal(prefix.scientificAcceptance, "unreviewed");
	assert.equal(prefix.hostEffects.kind, "host-effect-prefix-observation");
	assert.equal(prefix.hostEffects.complete, false);
	assert(!JSON.stringify(prefix).includes("SECRET-SENTINEL"));
	assert(!body.includes("request-1"));
	assert(!String(envelope).includes("request-1"));
});


test("inner AEAD refuses altered prefix and wrong mission key", async t => {
	const f = await fixture(t);
	await f.journal.record("initial", snapshot());
	const raw = await readFile(path.join(f.outputDir, INCREMENTAL_CHECKPOINT_FILE), "utf8");
	assert.throws(() => openIncrementalControlPrefix(raw, randomBytes(32), source),
		expectDiagnostic("authentication", "tag-verification-failed"));
	const root = JSON.parse(raw);
	root.incrementalControlEnvelope.sequence = 2;
	assert.throws(() => openIncrementalControlPrefix(JSON.stringify(root),
		f.authenticatedMissionKey, source),
		expectDiagnostic("authentication", "tag-verification-failed"));
	root.incrementalControlEnvelope.sequence = 1;
	root.incrementalControlEnvelope.ciphertextB64 = "A".repeat(4 * 1024 * 1024);
	assert.throws(() => openIncrementalControlPrefix(JSON.stringify(root),
		f.authenticatedMissionKey, source),
		expectDiagnostic("authentication", "tag-verification-failed"));
});
