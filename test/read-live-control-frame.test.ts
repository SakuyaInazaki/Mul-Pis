import assert from "node:assert/strict";
import { constants, createHash, generateKeyPairSync, sign } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmod, lstat, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";
import { createLiveControlFrameWriter, type LiveControlFrameSource } from
	"../src/runner/live-control-frame.ts";
import { MISSION_ARTIFACT, MISSION_ID, MISSION_REPOSITORY, MISSION_TOTAL_CNY } from
	"../src/runner/signed-mission-ledger.ts";
import { readLiveControlFrameFile } from "../scripts/read-live-control-frame.ts";

const script = fileURLToPath(new URL("../scripts/read-live-control-frame.ts", import.meta.url));
const source: LiveControlFrameSource = { repository: MISSION_REPOSITORY, runId: "8001004",
	runAttempt: 1, commit: "a".repeat(40), event: "workflow_dispatch",
	priorEnvelopeSha256: "b".repeat(64) };

async function fixture(t: TestContext) {
	const dir = await mkdtemp(path.join(os.tmpdir(), "read-live-frame-"));
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
	const frameFile = path.join(dir, "frame.ndjson");
	const seedFile = path.join(dir, "seed.secret");
	const sourceFile = path.join(dir, "source.json");
	const outputFile = path.join(dir, "status.json");
	const writer = await createLiveControlFrameWriter({ seedEnvelopeB64, publicKeyFile,
		expectedSpkiSha256, source, emitFrame: () => undefined });
	const line = await writer.emit({ sequence: 3, checkpointSha256: "c".repeat(64),
		committedCheckpointBoundary: "control-observed", requestCount: 8,
		responseReceivedCount: 5, goalCount: 2,
		goalOutcomeCounts: { active: 1, partial: 0, blocked: 1, fulfilled: 0 },
		taskCount: 2, taskStatusCounts: { running: 0, returned: 0, failed: 0,
			accepted: 1, rejected: 1, unknown: 0 },
		operationCount: 2, operationStatusCounts: { prepared: 0, issued: 0,
			"response-received": 0, "partial-settled": 0,
			"terminal-response-incomplete": 0, unknown: 0, confirmed: 1,
			"not-issued": 1 }, observedAt: "2026-10-08T10:00:00.000Z" });
	await writeFile(frameFile, `${line}\n`);
	await writeFile(seedFile, `${seedEnvelopeB64}\n`, { mode: 0o600 });
	await chmod(seedFile, 0o600);
	await writeFile(sourceFile, JSON.stringify(source));
	const args = (changes: Partial<Record<"frame" | "seed" | "source" | "output", string>> = {}) =>
		["--frame", changes.frame ?? frameFile,
			"--seed", changes.seed ?? seedFile, "--source", changes.source ?? sourceFile,
			"--public-key", publicKeyFile, "--output", changes.output ?? outputFile];
	const run = (changes: Partial<Record<"frame" | "seed" | "source" | "output", string>> = {}) =>
		readLiveControlFrameFile(args(changes), expectedSpkiSha256);
	const runCli = () => spawnSync(process.execPath, [script, ...args()], { encoding: "utf8" });
	return { dir, line, source, frameFile, seedFile, sourceFile, outputFile, run, runCli };
}

test("CLI reads a single authenticated frame into exclusive private control output", async t => {
	const f = await fixture(t);
	await f.run();
	assert.equal((await lstat(f.outputFile)).mode & 0o777, 0o600);
	const output = JSON.parse(await readFile(f.outputFile, "utf8"));
	assert.deepEqual(Object.keys(output).sort(), ["version", "kind", "source", "sequence",
		"missedSequences", "status"].sort());
	assert.equal(output.sequence, 3);
	assert.equal(output.missedSequences, 2);
	assert.deepEqual(output.source, source);
	assert.equal(output.status.complete, false);
	assert.equal(output.status.scientificAcceptance, "unreviewed");
	assert.equal(output.status.accounting, "unquantified");
	assert.equal(output.status.goalOutcomeCounts.blocked, 1);
	assert.equal(output.status.operationStatusCounts.confirmed, 1);
	assert.ok(!JSON.stringify(output).includes("ciphertextB64"));
	await assert.rejects(f.run());
	assert.equal((await readFile(f.outputFile, "utf8")).includes("authenticated-live-control-observation"), true);
	const cli = f.runCli();
	assert.notEqual(cli.status, 0, "synthetic key must not pass production CLI pinning");
	assert.equal(cli.stdout, "");
	assert.equal(cli.stderr, "Live control frame could not be authenticated or saved.\n");
});

test("wrong source and tampered ciphertext leave no private output", async t => {
	const f = await fixture(t);
	const wrongSourceFile = path.join(f.dir, "wrong-source.json");
	await writeFile(wrongSourceFile, JSON.stringify({ ...source, commit: "d".repeat(40) }));
	await assert.rejects(f.run({ source: wrongSourceFile }));
	await assert.rejects(lstat(f.outputFile));
	const forged = JSON.parse(f.line);
	const tag = Buffer.from(forged.tagB64, "base64");
	tag[0] ^= 1;
	const tamperedFile = path.join(f.dir, "tampered.ndjson");
	await writeFile(tamperedFile, `${JSON.stringify({ ...forged, tagB64: tag.toString("base64") })}\n`);
	await assert.rejects(f.run({ frame: tamperedFile }));
	await assert.rejects(lstat(f.outputFile));
});

test("seed must be a mode 0600 regular nonsymlink file, and frame is bounded", async t => {
	const f = await fixture(t);
	const linkFile = path.join(f.dir, "seed-link");
	await symlink(f.seedFile, linkFile);
	await assert.rejects(f.run({ seed: linkFile }));
	await chmod(f.seedFile, 0o644);
	await assert.rejects(f.run());
	await chmod(f.seedFile, 0o600);
	const oversizedFile = path.join(f.dir, "oversized.ndjson");
	await writeFile(oversizedFile, "x".repeat(4097));
	await assert.rejects(f.run({ frame: oversizedFile }));
	await assert.rejects(lstat(f.outputFile));
});
