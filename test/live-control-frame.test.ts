import assert from "node:assert/strict";
import { constants, createCipheriv, createHash, generateKeyPairSync, hkdfSync, randomBytes,
	sign } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { createLiveControlFrameReader, createLiveControlFrameWriter,
	LIVE_CONTROL_FRAME_BYTES, type LiveControlFrameEmission,
	type LiveControlFrameSource } from "../src/runner/live-control-frame.ts";
import { authenticateSignedMissionSeed, MISSION_ARTIFACT, MISSION_ID,
	MISSION_REPOSITORY, MISSION_TOTAL_CNY } from "../src/runner/signed-mission-ledger.ts";

const source: LiveControlFrameSource = { repository: MISSION_REPOSITORY, runId: "8001004",
	runAttempt: 1, commit: "a".repeat(40), event: "workflow_dispatch",
	priorEnvelopeSha256: "b".repeat(64) };
const observation = (sequence: number): LiveControlFrameEmission => ({ sequence,
	committedCheckpointBoundary: "request-observed", checkpointSha256: "c".repeat(64), requestCount: 10,
	responseReceivedCount: 3, goalCount: 2,
	goalOutcomeCounts: { active: 1, partial: 0, blocked: 0, fulfilled: 1 }, taskCount: 4,
	taskStatusCounts: { running: 1, returned: 1, failed: 0, accepted: 1,
		rejected: 0, unknown: 1 }, operationCount: 5,
	operationStatusCounts: { prepared: 1, issued: 1, "response-received": 1,
		"partial-settled": 0, "terminal-response-incomplete": 0, unknown: 2,
		confirmed: 0, "not-issued": 0 },
	observedAt: "2026-10-08T10:00:00.000Z" });

async function fixture(t: TestContext) {
	const dir = await mkdtemp(path.join(os.tmpdir(), "live-control-frame-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
	const publicKeyFile = path.join(dir, "public.pem");
	await writeFile(publicKeyFile, publicKey.export({ type: "spki", format: "pem" }));
	const expectedSpkiSha256 = createHash("sha256").update(publicKey.export({
		type: "spki", format: "der" })).digest("hex");
	const payload = { version: 1, kind: "mul-pis-private-mission-ledger", missionId: MISSION_ID,
		repository: MISSION_REPOSITORY, globalMaxCny: MISSION_TOTAL_CNY,
		priorCommittedCny: 0, revision: 1,
		previous: { runId: "8001001", runAttempt: 1, artifactId: "9002001",
			artifactName: MISSION_ARTIFACT } };
	const bytes = Buffer.from(JSON.stringify(payload));
	const signature = sign("sha256", bytes, { key: privateKey,
		padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 });
	const seedEnvelopeB64 = Buffer.from(JSON.stringify({ payload_b64: bytes.toString("base64"),
		signature_b64: signature.toString("base64") })).toString("base64");
	return { seedEnvelopeB64, publicKeyFile, expectedSpkiSha256, source };
}

test("a signed seed seals fixed partial control facts and reader permits sequence gaps", async t => {
	const f = await fixture(t), lines: string[] = [];
	const writer = await createLiveControlFrameWriter({ ...f, emitFrame: line => { lines.push(line); } });
	const reader = await createLiveControlFrameReader(f);
	const first = await writer.emit(observation(1));
	await writer.emit({ ...observation(3), committedCheckpointBoundary: "control-observed",
		requestCount: Number.MAX_SAFE_INTEGER });
	assert.deepEqual(lines.length, 2);
	assert.equal(first, lines[0]);
	assert.ok(lines.every(line => Buffer.byteLength(line, "utf8") <= LIVE_CONTROL_FRAME_BYTES &&
		!line.includes("\n") && !line.includes("requestCount") && !line.includes("taskCount")));
	assert.deepEqual(Object.keys(JSON.parse(lines[0])).sort(), ["version", "format", "source",
		"sequence", "nonceB64", "ciphertextB64", "tagB64"].sort());
	assert.deepEqual(reader.read(lines[0]), { sequence: 1, missedSequences: 0, status: { version: 1,
		kind: "partial-control-observation", partial: true, complete: false,
		selectionAuthority: false, scientificAcceptance: "unreviewed",
		accounting: "unquantified", ...((({ sequence: _, ...status }) => status)(observation(1))) } });
	const later = reader.read(lines[1]);
	assert.equal(later.status.requestCount, Number.MAX_SAFE_INTEGER);
	assert.equal(later.missedSequences, 1);
	assert.throws(() => reader.read(lines[1]), /sequence did not increase/);
	assert.throws(() => reader.read(lines[0]), /sequence did not increase/);
	await assert.rejects(writer.emit(observation(3)), /sequence did not increase/);
});

test("same-count task transitions remain visible and status totals must match", async t => {
	const f = await fixture(t), lines: string[] = [];
	const writer = await createLiveControlFrameWriter({ ...f, emitFrame: line => { lines.push(line); } });
	const reader = await createLiveControlFrameReader(f);
	await writer.emit(observation(1));
	await writer.emit({ ...observation(2),
		goalOutcomeCounts: { active: 0, partial: 0, blocked: 1, fulfilled: 1 },
		taskStatusCounts: { running: 0, returned: 1,
		failed: 0, accepted: 2, rejected: 0, unknown: 1 },
		operationStatusCounts: { prepared: 1, issued: 0, "response-received": 1,
			"partial-settled": 0, "terminal-response-incomplete": 0,
			unknown: 2, confirmed: 1, "not-issued": 0 } });
	const first = reader.read(lines[0]);
	const second = reader.read(lines[1]);
	assert.equal(first.status.taskCount, second.status.taskCount);
	assert.equal(first.status.taskStatusCounts.running, 1);
	assert.equal(second.status.taskStatusCounts.running, 0);
	assert.equal(second.status.taskStatusCounts.accepted, 2);
	assert.equal(first.status.goalOutcomeCounts.active, 1);
	assert.equal(second.status.goalOutcomeCounts.blocked, 1);
	assert.equal(first.status.operationStatusCounts.issued, 1);
	assert.equal(second.status.operationStatusCounts.confirmed, 1);
	await assert.rejects(writer.emit({ ...observation(3), taskStatusCounts: {
		running: 0, returned: 1, failed: 0, accepted: 1, rejected: 0,
		unknown: 1 } }), /status fields/);
	await assert.rejects(writer.emit({ ...observation(3), goalOutcomeCounts: {
		active: 1, partial: 0, blocked: 1, fulfilled: 1 } }),
		/status fields/);
	await assert.rejects(writer.emit({ ...observation(3), operationStatusCounts: {
		...observation(3).operationStatusCounts, issued: 0 } }),
		/status fields/);
});

test("wrong source, outer sequence and tag fail authentication or binding", async t => {
	const f = await fixture(t);
	const writer = await createLiveControlFrameWriter({ ...f, emitFrame: () => undefined });
	const line = await writer.emit(observation(5));
	const frame = JSON.parse(line) as Record<string, any>;
	const wrongSource = await createLiveControlFrameReader({ ...f,
		source: { ...source, commit: "c".repeat(40) } });
	assert.throws(() => wrongSource.read(line), /fields or source/);
	const reader = await createLiveControlFrameReader(f);
	assert.throws(() => reader.read(JSON.stringify({ ...frame, sequence: 6 })), /authentication failed/);
	const tag = Buffer.from(frame.tagB64, "base64");
	tag[0] ^= 1;
	assert.throws(() => reader.read(JSON.stringify({ ...frame, tagB64: tag.toString("base64") })),
		/authentication failed/);
	assert.throws(() => reader.read(JSON.stringify({ ...frame,
		source: { ...frame.source, priorEnvelopeSha256: "c".repeat(64) } })), /fields or source/);
	assert.equal(reader.read(line).missedSequences, 4);
});

test("reader authenticates the signed seed before accepting a frame", async t => {
	const f = await fixture(t);
	const envelope = JSON.parse(Buffer.from(f.seedEnvelopeB64, "base64").toString("utf8")) as
		Record<string, string>;
	const signature = Buffer.from(envelope.signature_b64, "base64");
	signature[0] ^= 1;
	const badEnvelope = Buffer.from(JSON.stringify({ ...envelope,
		signature_b64: signature.toString("base64") })).toString("base64");
	await assert.rejects(createLiveControlFrameReader({ ...f, seedEnvelopeB64: badEnvelope }),
		/signed mission ledger authentication failed/);
});

test("reader rejects unknown fields, oversized lines, truncation and invalid encoding", async t => {
	const f = await fixture(t);
	const writer = await createLiveControlFrameWriter({ ...f, emitFrame: () => undefined });
	const line = await writer.emit(observation(1));
	const frame = JSON.parse(line) as Record<string, any>;
	const reader = await createLiveControlFrameReader(f);
	assert.throws(() => reader.read(JSON.stringify({ ...frame, status: "fulfilled" })),
		/fields or source/);
	assert.throws(() => reader.read(JSON.stringify({ ...frame,
		source: { ...frame.source, extra: "x" } })), /fields or source/);
	assert.throws(() => reader.read(`${line}${" ".repeat(LIVE_CONTROL_FRAME_BYTES)}`), /byte bound/);
	assert.throws(() => reader.read(line.slice(0, -1)), /JSON is invalid/);
	assert.throws(() => reader.read(`${line}\n`), /frame line is invalid/);
	assert.throws(() => reader.read(JSON.stringify({ ...frame, nonceB64: "!!!!" })),
		/encoding is invalid/);
	assert.equal(reader.read(line).sequence, 1);
});

test("authenticated unknown plaintext fields and claims fail strict schema", async t => {
	const f = await fixture(t);
	const seed = await authenticateSignedMissionSeed({ envelopeB64: f.seedEnvelopeB64,
		publicKeyFile: f.publicKeyFile, expectedSpkiSha256: f.expectedSpkiSha256 });
	const key = Buffer.from(hkdfSync("sha256",
		seed.derivePrivateKey("mul-pis-ledger-continuation-v1"),
		Buffer.from(source.priorEnvelopeSha256, "hex"), "mul-pis-live-control-frame-v1", 32));
	const seal = (sequence: number, status: object): string => {
		const nonce = randomBytes(12);
		const cipher = createCipheriv("aes-256-gcm", key, nonce);
		cipher.setAAD(Buffer.from(JSON.stringify(["mul-pis-live-control-frame-v1", MISSION_ID,
			source.repository, source.runId, source.runAttempt, source.commit, source.event,
			source.priorEnvelopeSha256, sequence])));
		const ciphertext = Buffer.concat([cipher.update(JSON.stringify(status)), cipher.final()]);
		return JSON.stringify({ version: 1, format: "mul-pis-live-control-frame-v1", source, sequence,
			nonceB64: nonce.toString("base64"), ciphertextB64: ciphertext.toString("base64"),
			tagB64: cipher.getAuthTag().toString("base64") });
	};
	const good = { version: 1, kind: "partial-control-observation", partial: true,
		complete: false, selectionAuthority: false, scientificAcceptance: "unreviewed",
		accounting: "unquantified",
		...((({ sequence: _, ...status }) => status)(observation(1))) };
	const reader = await createLiveControlFrameReader(f);
	assert.throws(() => reader.read(seal(1, { ...good, rawTaskText: "private" })),
		/status schema is invalid/);
	assert.throws(() => reader.read(seal(1, { ...good, partial: false })),
		/status schema is invalid/);
	assert.throws(() => reader.read(seal(1, { ...good, complete: true })),
		/status schema is invalid/);
	assert.throws(() => reader.read(seal(1, { ...good, scientificAcceptance: "accepted" })),
		/status schema is invalid/);
	assert.throws(() => reader.read(seal(1, { ...good, accounting: "settled" })),
		/status schema is invalid/);
	assert.throws(() => reader.read(seal(1, { ...good,
		responseReceivedCount: good.requestCount + 1 })), /status schema is invalid/);
	assert.throws(() => reader.read(seal(1, { ...good,
		taskStatusCounts: { ...good.taskStatusCounts, running: 2 } })),
		/status schema is invalid/);
	assert.throws(() => reader.read(seal(1, { ...good,
		taskStatusCounts: { ...good.taskStatusCounts, taskId: "private" } })),
		/status schema is invalid/);
	assert.throws(() => reader.read(seal(1, { ...good,
		goalOutcomeCounts: { ...good.goalOutcomeCounts, active: 0 } })),
		/status schema is invalid/);
	assert.throws(() => reader.read(seal(1, { ...good,
		operationStatusCounts: { ...good.operationStatusCounts, confirmed: 1 } })),
		/status schema is invalid/);
	assert.throws(() => reader.read(seal(1, { ...good,
		operationStatusCounts: { ...good.operationStatusCounts, operationId: "private" } })),
		/status schema is invalid/);
	assert.equal(reader.read(seal(1, good)).status.partial, true);
});

test("writer rejects unsafe or non-static fields before emission", async t => {
	const f = await fixture(t), lines: string[] = [];
	const writer = await createLiveControlFrameWriter({ ...f,
		emitFrame: line => { lines.push(line); } });
	await assert.rejects(writer.emit({ ...observation(1), requestCount: -1 }), /status fields/);
	await assert.rejects(writer.emit({ ...observation(1), responseReceivedCount: 11 }),
		/status fields/);
	await assert.rejects(writer.emit({ ...observation(1), goalCount: Number.MAX_SAFE_INTEGER + 1 }),
		/status fields/);
	await assert.rejects(writer.emit({ ...observation(1), observedAt: "2026-10-08" }),
		/status fields/);
	await assert.rejects(writer.emit({ ...observation(1), checkpointSha256: "c".repeat(63) }),
		/status fields/);
	await assert.rejects(writer.emit({ ...observation(1), rawTaskText: "private" } as
		unknown as LiveControlFrameEmission), /status fields/);
	assert.equal(lines.length, 0);
	assert.equal((await writer.emit(observation(1))).length > 0, true);
});
