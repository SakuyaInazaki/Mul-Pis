import assert from "node:assert/strict";
import { createCipheriv, createHash, createPublicKey, generateKeyPairSync,
	hkdfSync, randomBytes } from "node:crypto";
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
import { MISSION_ID } from "../src/runner/signed-mission-ledger.ts";
import { CARRY_LOGICAL_BYTES } from "../src/runner/carry-sidecar-codec.ts";

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

const unknownControl = { version: 1 as const, kind: "unobserved-control-delivery" as const,
	controlCommit: "d".repeat(40), testedSourceCommit: "e".repeat(40),
	testedSourceTree: "f".repeat(40), previousControlParent: "c".repeat(40),
	admittedBy: { runId: source.runId, runAttempt: source.runAttempt,
		runNumber: 8, commit: source.commit }, observedRunsAtAdmission: 0 as const,
	effects: "unknown-unreconciled" as const, accounting: "unquantified" as const };

test("initial private prefix seals accepted unobserved control before later requests", async t => {
	const f = await fixture(t);
	const initial = { ...snapshot(), unobservedControlDeliveries: [unknownControl] };
	await f.journal.record("initial", initial);
	let raw = await readFile(path.join(f.outputDir, INCREMENTAL_CHECKPOINT_FILE), "utf8");
	let opened = openIncrementalControlPrefix(raw, f.authenticatedMissionKey, source);
	assert.deepEqual(opened.unobservedControlDeliveries, [unknownControl]);
	assert.equal(opened.requestAudit.requests.length, 0);
	const later = { ...snapshot(true), unobservedControlDeliveries: [unknownControl] };
	await f.journal.record("request-reserved", later);
	raw = await readFile(path.join(f.outputDir, INCREMENTAL_CHECKPOINT_FILE), "utf8");
	opened = openIncrementalControlPrefix(raw, f.authenticatedMissionKey, source);
	assert.deepEqual(opened.unobservedControlDeliveries, [unknownControl]);
	assert.equal(opened.requestAudit.requests.length, 1);
	assert.equal(opened.requestAudit.requests[0].outputTokenField, "max_completion_tokens");
	await assert.rejects(f.journal.record("control-observed", snapshot(true)),
		expectDiagnostic("monotonic-regression", "unobserved-control-regressed"));
	assert.equal(await readFile(path.join(f.outputDir, INCREMENTAL_CHECKPOINT_FILE), "utf8"), raw);
});

test("incremental prefix preserves the exact run43-size objective checkpoint", async t => {
	const f = await fixture(t);
	const targetBytes = 4_458_098;
	const base = JSON.stringify({ version: 1, kind: "original-objective-progress", detail: "" });
	const objectiveCheckpointJson = JSON.stringify({ version: 1,
		kind: "original-objective-progress", detail: "x".repeat(targetBytes - base.length) });
	assert.equal(Buffer.byteLength(objectiveCheckpointJson, "utf8"), targetBytes);
	await f.journal.record("initial", { ...snapshot(), objectiveCheckpointJson });
	const raw = await readFile(path.join(f.outputDir, INCREMENTAL_CHECKPOINT_FILE), "utf8");
	assert.ok(Buffer.byteLength(raw, "utf8") <= CARRY_LOGICAL_BYTES);
	assert.equal(openIncrementalControlPrefix(raw, f.authenticatedMissionKey, source)
		.objectiveCheckpointJson, objectiveCheckpointJson);
});

test("incremental prefix rejects an objective checkpoint beyond the logical carry bound", async t => {
	const f = await fixture(t);
	const oversized = JSON.stringify({ kind: "original-objective-progress",
		detail: "x".repeat(CARRY_LOGICAL_BYTES) });
	await assert.rejects(f.journal.record("initial", {
		...snapshot(), objectiveCheckpointJson: oversized }),
		expectDiagnostic("decoded-schema", "objective-checkpoint-invalid"));
});

test("incremental prefix keeps the 64 MiB physical file bound for an allowed objective", async t => {
	const f = await fixture(t);
	const physicallyOversized = JSON.stringify({ kind: "original-objective-progress",
		detail: "x".repeat(48 * 1024 * 1024) });
	assert.ok(Buffer.byteLength(physicallyOversized, "utf8") < CARRY_LOGICAL_BYTES);
	await assert.rejects(f.journal.record("initial", {
		...snapshot(), objectiveCheckpointJson: physicallyOversized }),
		expectDiagnostic("file-io", "file-bound-exceeded"));
});
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
function resealWithPayload(raw: string, missionKey: Buffer, plaintext: string): string {
	const root = JSON.parse(raw);
	const envelope = root.incrementalControlEnvelope;
	const key = Buffer.from(hkdfSync("sha256", missionKey,
		Buffer.from(source.priorEnvelopeSha256, "hex"),
		"mul-pis-incremental-control-prefix-v1", 32));
	const nonce = randomBytes(12);
	const cipher = createCipheriv("aes-256-gcm", key, nonce);
	cipher.setAAD(Buffer.from(JSON.stringify([MISSION_ID, source.repository, source.runId,
		source.runAttempt, source.commit, source.event, source.priorEnvelopeSha256,
		envelope.sequence, envelope.previousCheckpointSha256]), "utf8"));
	const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
	envelope.nonceB64 = nonce.toString("base64");
	envelope.ciphertextB64 = ciphertext.toString("base64");
	envelope.tagB64 = cipher.getAuthTag().toString("base64");
	return JSON.stringify(root);
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
	await run("python", [script, "encrypt", "--results", f.outputDir,
		"--public-key", publicKey, "--expected-spki-sha256", sha(spki),
		"--output", envelope, "--repository", source.repository,
		"--run-id", source.runId, "--run-attempt", String(source.runAttempt),
		"--commit", source.commit, "--event", source.event]);
	const parent = path.join(f.dir, "decrypted");
	await mkdir(parent, { mode: 0o700 });
	const { stdout } = await run("python", [script, "decrypt", "--envelope", envelope,
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

test("invalid next snapshot preserves earlier complete prefix and stops journal", async t => {
	const f = await fixture(t);
	await f.journal.record("initial", snapshot());
	const before = await readFile(path.join(f.outputDir, INCREMENTAL_CHECKPOINT_FILE));
	const inconsistent = snapshot(true);
	inconsistent.hostEffects.requestIds.splice(0);
	await assert.rejects(f.journal.record("request-reserved", inconsistent),
		/private incremental checkpoint is incomplete/);
	await assert.rejects(f.journal.record("control-observed", snapshot()),
		/private incremental checkpoint is incomplete/);
	assert.deepEqual(await readFile(path.join(f.outputDir, INCREMENTAL_CHECKPOINT_FILE)), before);
});

test("optional sink failure leaves a whole local prefix and blocks subsequent effects", async t => {
	let calls = 0;
	const f = await fixture(t, async ({ file, sha256 }) => {
		calls++;
		assert.equal(sha(await readFile(file)), sha256);
		throw Error("optional sink failed");
	});
	await assert.rejects(f.journal.record("request-reserved", snapshot(true)),
		/private incremental checkpoint is incomplete/);
	const whole = openIncrementalControlPrefix(
		await readFile(path.join(f.outputDir, INCREMENTAL_CHECKPOINT_FILE), "utf8"),
		f.authenticatedMissionKey, source);
	assert.equal(whole.sequence, 1);
	assert.equal(whole.event, "request-reserved");
	await assert.rejects(f.journal.record("request-observed", snapshot(true)),
		/private incremental checkpoint is incomplete/);
	assert.equal(calls, 1);
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

test("private diagnostic stages distinguish source, envelope, decoded schema and physical bounds", async t => {
	const f = await fixture(t);
	await f.journal.record("initial", snapshot());
	const raw = await readFile(path.join(f.outputDir, INCREMENTAL_CHECKPOINT_FILE), "utf8");
	assert.throws(() => openIncrementalControlPrefix(raw, f.authenticatedMissionKey,
		{ ...source, priorEnvelopeSha256: "e".repeat(64) }),
		expectDiagnostic("source", "binding-mismatch"));
	assert.throws(() => openIncrementalControlPrefix("{", f.authenticatedMissionKey, source),
		expectDiagnostic("envelope", "invalid-json"));
	assert.throws(() => openIncrementalControlPrefix(
		resealWithPayload(raw, f.authenticatedMissionKey, "{"),
		f.authenticatedMissionKey, source),
		expectDiagnostic("decoded-schema", "payload-json-invalid"));
	assert.throws(() => openIncrementalControlPrefix(
		resealWithPayload(raw, f.authenticatedMissionKey, "{}"),
		f.authenticatedMissionKey, source),
		expectDiagnostic("decoded-schema", "payload-structure-invalid"));
	assert.throws(() => openIncrementalControlPrefix("x".repeat(64 * 1024 * 1024 + 1),
		f.authenticatedMissionKey, source),
		expectDiagnostic("file-io", "file-bound-exceeded"));
});

test("stale next census cannot erase an earlier reserved request", async t => {
	const f = await fixture(t);
	await f.journal.record("request-reserved", snapshot(true));
	const before = await readFile(path.join(f.outputDir, INCREMENTAL_CHECKPOINT_FILE));
	await assert.rejects(f.journal.record("control-observed", snapshot()),
		expectDiagnostic("monotonic-regression", "request-prefix-regressed"));
	assert.deepEqual(await readFile(path.join(f.outputDir, INCREMENTAL_CHECKPOINT_FILE)), before);
});

test("confined session may precede its persisted goal without declaring a complete census", async t => {
	const f = await fixture(t);
	const sessionId = "d".repeat(64);
	const grant = { version: 1 as const, kind: "confined-campaign-files" as const,
		root: "/private/work/T001", writableFiles: ["candidate.cpp", "lesson-delta.json"] };
	const early = snapshot();
	early.hostEffects.sessions.push({ sessionId, kind: "confined-execution",
		taskId: "T001", workRoot: grant.root, grant });
	await f.journal.record("host-effect-observed", early);
	const late = snapshot();
	late.hostEffects.sessions.push({ sessionId, kind: "confined-execution",
		goalRunId: "goal-1", taskId: "T001", workRoot: grant.root, grant });
	late.hostEffects.goals.push({ runId: "goal-1", outcome: "active",
		tasks: [{ taskId: "T001", mode: "execute", status: "running", sessionId }],
		operations: [] });
	await f.journal.record("control-observed", late);
	const raw = await readFile(path.join(f.outputDir, INCREMENTAL_CHECKPOINT_FILE), "utf8");
	const opened = openIncrementalControlPrefix(raw, f.authenticatedMissionKey, source);
	assert.equal(opened.hostEffects.complete, false);
	assert.equal(opened.hostEffects.selectionAuthority, false);
	assert.equal(opened.hostEffects.goals[0].runId, "goal-1");
	const widened = snapshot();
	widened.hostEffects.sessions.push({ sessionId, kind: "confined-execution",
		goalRunId: "goal-1", taskId: "T001", workRoot: grant.root,
		grant: { ...grant, writableFiles: [...grant.writableFiles, "other.cpp"] } });
	widened.hostEffects.goals.push(late.hostEffects.goals[0]);
	await assert.rejects(f.journal.record("host-effect-observed", widened),
		/private incremental checkpoint is incomplete/);
	assert.equal(await readFile(path.join(f.outputDir, INCREMENTAL_CHECKPOINT_FILE), "utf8"), raw);
});

function controllerSnapshot(operationStatus: string, taskStatus = "running",
	goalOutcome = "active"): IncrementalCheckpointInput {
	const value = snapshot();
	value.hostEffects.goals.push({ runId: "goal-1", outcome: goalOutcome,
		tasks: [{ taskId: "T001", mode: "execute", status: taskStatus,
			sessionId: "d".repeat(64) }],
		operations: [{ id: "O001", taskId: "T001", status: operationStatus }] });
	return value;
}

function unknownBillingSnapshot(): IncrementalCheckpointInput {
	const value = snapshot(true);
	value.requestAudit.requests[0].status = "unknown";
	value.requestAudit.requests[0].unknownObservedCny = 0.5;
	value.requestAudit.requests[0].reportedUsage = { input: 100, output: 20,
		cacheRead: 0, cacheWrite: 0, totalTokens: 120,
		reportedUsdCost: null, costStatus: "unknown" };
	value.requestAudit.unknownObservedCny = 0.5;
	value.requestAudit.unpricedRequestCount = 0;
	return value;
}

test("an UNKNOWN billing row cannot lose its hold or change reported usage", async t => {
	for (const change of ["lower-hold", "change-usage", "false-settlement"] as const) {
		await t.test(change, async child => {
			const f = await fixture(child);
			await f.journal.record("request-observed", unknownBillingSnapshot());
			const before = await readFile(path.join(f.outputDir, INCREMENTAL_CHECKPOINT_FILE));
			const next = unknownBillingSnapshot();
			if (change === "lower-hold") {
				next.requestAudit.requests[0].unknownObservedCny = 0.25;
				next.requestAudit.unknownObservedCny = 0.25;
			} else if (change === "change-usage") {
				next.requestAudit.requests[0].reportedUsage!.output = 21;
			} else {
				next.requestAudit.requests[0].status = "settled";
				next.requestAudit.requests[0].responseReceived = true;
				next.requestAudit.requests[0].unknownObservedCny = null;
				next.requestAudit.requests[0].settledCny = 0.25;
				next.requestAudit.unknownObservedCny = 0;
				next.requestAudit.settledCny = 0.25;
			}
			await assert.rejects(f.journal.record("request-observed", next),
				expectDiagnostic("monotonic-regression", "request-prefix-regressed"));
			assert.deepEqual(await readFile(path.join(f.outputDir, INCREMENTAL_CHECKPOINT_FILE)), before);
		});
	}
});

test("previously observed controller statuses cannot regress", async t => {
	const regressions = [
		["response-received", "issued", "running", "running", "active", "active"],
		["partial-settled", "prepared", "running", "running", "active", "active"],
		["terminal-response-incomplete", "issued", "running", "running", "active", "active"],
		["confirmed", "unknown", "running", "running", "active", "active"],
		["not-issued", "unknown", "running", "running", "active", "active"],
		["response-received", "response-received", "accepted", "running", "active", "active"],
		["response-received", "response-received", "rejected", "running", "active", "active"],
		["response-received", "response-received", "accepted", "accepted", "fulfilled", "active"],
	] as const;
	for (const [oldOperation, newOperation, oldTask, newTask, oldGoal, newGoal] of regressions) {
		await t.test(`${oldOperation}/${oldTask}/${oldGoal} to ${newOperation}/${newTask}/${newGoal}`,
			async child => {
				const f = await fixture(child);
				await f.journal.record("control-observed",
					controllerSnapshot(oldOperation, oldTask, oldGoal));
				const before = await readFile(path.join(f.outputDir, INCREMENTAL_CHECKPOINT_FILE));
				await assert.rejects(f.journal.record("control-observed",
					controllerSnapshot(newOperation, newTask, newGoal)),
					/private incremental checkpoint is incomplete/);
				assert.deepEqual(await readFile(path.join(f.outputDir, INCREMENTAL_CHECKPOINT_FILE)), before);
			});
	}
});

test("controller operation progress and external reconciliation remain recordable", async t => {
	for (const [before, after] of [["issued", "response-received"],
		["unknown", "confirmed"], ["unknown", "not-issued"]] as const) {
		await t.test(`${before} to ${after}`, async child => {
			const f = await fixture(child);
			await f.journal.record("control-observed", controllerSnapshot(before));
			await f.journal.record("control-observed", controllerSnapshot(after));
			const opened = openIncrementalControlPrefix(
				await readFile(path.join(f.outputDir, INCREMENTAL_CHECKPOINT_FILE), "utf8"),
				f.authenticatedMissionKey, source);
			assert.equal(opened.hostEffects.goals[0].operations[0].status, after);
		});
	}
});
