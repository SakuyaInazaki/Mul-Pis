import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { constants, createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createAuthenticatedProgressGate, createProgressUploader,
	launchPrivateCampaignObserver, readAuthenticatedCommittedPrefix,
	PREFIX_PUBLICATION_INTERVAL_MS, PREFIX_LOCAL_FREE_RESERVE_BYTES } from
	"../scripts/private-campaign-observer.ts";
import { PUBLIC_HEARTBEAT_LINE } from "../scripts/private-campaign-heartbeat.ts";
import { createLiveControlFrameWriter } from "../src/runner/live-control-frame.ts";
import { IncrementalPrivateCheckpointJournal, INCREMENTAL_CHECKPOINT_FILE,
	type IncrementalCheckpointSource } from "../src/runner/incremental-private-checkpoint.ts";
import { MISSION_ARTIFACT, MISSION_ID, MISSION_REPOSITORY, MISSION_TOTAL_CNY } from
	"../src/runner/signed-mission-ledger.ts";
import { authenticateSignedMissionSeed } from "../src/runner/signed-mission-ledger.ts";
import { ARTIFACT_PARTITION_MANIFEST_FILE, ARTIFACT_PARTITION_PAYLOAD_BYTES,
	openPartitionManifest, restorePartitionFiles } from
	"../src/runner/private-artifact-partition.ts";
import { closeSync, openSync } from "node:fs";

const actionModule = new URL("../scripts/private-campaign-observer-action.mjs", import.meta.url).href;
const { runPrivateCampaignAction } = await import(actionModule);
const syntheticAvailableBytes = async () =>
	PREFIX_LOCAL_FREE_RESERVE_BYTES + 64n * 1024n * 1024n;

const sourceEnv: NodeJS.ProcessEnv = {
	GITHUB_REPOSITORY: "SakuyaInazaki/Mul-Pis", GITHUB_RUN_ID: "12345",
	GITHUB_RUN_ATTEMPT: "1", GITHUB_SHA: "a".repeat(40),
	GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_ACTIONS: "true",
	GITHUB_TOKEN: "synthetic-github", DEEPSEEK_API_KEY: "synthetic-deepseek",
	MULPIS_MISSION_LEDGER_B64: "synthetic-ledger", ACTIONS_RUNTIME_TOKEN: "must-stay-parent",
	ACTIONS_RESULTS_URL: "must-stay-parent", ACTIONS_CACHE_URL: "must-stay-parent",
	ACTIONS_ID_TOKEN_REQUEST_TOKEN: "must-stay-parent",
	ACTIONS_ID_TOKEN_REQUEST_URL: "must-stay-parent", GITHUB_OUTPUT: "must-stay-parent",
	GITHUB_ENV: "must-stay-parent", GITHUB_PATH: "must-stay-parent",
	GITHUB_STEP_SUMMARY: "must-stay-parent", NODE_OPTIONS: "must-stay-parent",
};
function frame(sequence: number) {
	return JSON.stringify({ version: 1, format: "mul-pis-live-control-frame-v1",
		source: { repository: sourceEnv.GITHUB_REPOSITORY, runId: sourceEnv.GITHUB_RUN_ID,
			runAttempt: 1, commit: sourceEnv.GITHUB_SHA, event: sourceEnv.GITHUB_EVENT_NAME,
			priorEnvelopeSha256: "b".repeat(64) }, sequence,
		nonceB64: Buffer.alloc(12).toString("base64"),
		ciphertextB64: Buffer.from(`opaque-${sequence}`).toString("base64"),
		tagB64: Buffer.alloc(16).toString("base64") });
}
async function until(check: () => boolean): Promise<void> {
	for (let i = 0; i < 100; i++) {
		if (check()) return;
		await new Promise(resolve => setTimeout(resolve, 5));
	}
	assert.fail("synthetic observer did not reach the expected state");
}

async function prefixFixture(directory: string) {
	const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
	const publicKeyFile = path.join(directory, "public.pem");
	await writeFile(publicKeyFile, publicKey.export({ type: "spki", format: "pem" }));
	const expectedSpkiSha256 = createHash("sha256")
		.update(publicKey.export({ type: "spki", format: "der" })).digest("hex");
	const payload = { version: 1, kind: "mul-pis-private-mission-ledger", missionId: MISSION_ID,
		repository: MISSION_REPOSITORY, globalMaxCny: MISSION_TOTAL_CNY,
		priorCommittedCny: 0, revision: 1,
		previous: { runId: "8001001", runAttempt: 1, artifactId: "9002001",
			artifactName: MISSION_ARTIFACT } };
	const payloadBytes = Buffer.from(JSON.stringify(payload));
	const signature = sign("sha256", payloadBytes, { key: privateKey,
		padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 });
	const seedEnvelopeB64 = Buffer.from(JSON.stringify({ payload_b64: payloadBytes.toString("base64"),
		signature_b64: signature.toString("base64") })).toString("base64");
	const seed = await authenticateSignedMissionSeed({ envelopeB64: seedEnvelopeB64,
		publicKeyFile, expectedSpkiSha256 });
	const authenticatedMissionKey = seed.derivePrivateKey("mul-pis-ledger-continuation-v1");
	const source: IncrementalCheckpointSource = { repository: MISSION_REPOSITORY,
		runId: "12345", runAttempt: 1, commit: "a".repeat(40),
		event: "workflow_dispatch", priorEnvelopeSha256: "b".repeat(64) };
	const outputDir = path.join(directory, "results");
	await mkdir(outputDir, { mode: 0o700 });
	const journal = new IncrementalPrivateCheckpointJournal({ source, outputDir,
		authenticatedMissionKey });
	const writer = await createLiveControlFrameWriter({ seedEnvelopeB64, publicKeyFile,
		expectedSpkiSha256, source, emitFrame: () => undefined });
	const snapshot = (count: number) => {
		const requests = Array.from({ length: count }, (_, index) => ({
			requestId: `request-${index + 1}`, sessionId: "c".repeat(64),
			responseReceived: false, inputPayloadBytes: 120, maxOutputTokens: 8192,
			status: "in-flight" as const, settledCny: null, unknownObservedCny: null,
			reportedUsage: null }));
		return { requestAudit: { version: 3 as const, kind: "accounting-only-request-audit" as const,
			requests, settledCny: 0, unknownObservedCny: 0, unpricedRequestCount: count },
			hostEffects: { version: 1 as const, kind: "host-effect-prefix-observation" as const,
				complete: false as const, selectionAuthority: false as const,
				source: { runId: source.runId, runAttempt: source.runAttempt, commit: source.commit },
				priorEnvelopeSha256: source.priorEnvelopeSha256, historicalGoalRunIds: [],
				goals: [], sessions: [], requestIds: requests.map(row => row.requestId) } };
	};
	const makeStatus = (stored: { sequence: number; sha256: string },
		committedCheckpointBoundary: "initial" | "request-reserved" | "control-observed",
		requestCount = 0) => ({
		version: 1 as const, kind: "partial-control-observation" as const,
		partial: true as const, complete: false as const,
		selectionAuthority: false as const, scientificAcceptance: "unreviewed" as const,
		accounting: "unquantified" as const,
		committedCheckpointBoundary, checkpointSha256: stored.sha256,
		requestCount, responseReceivedCount: 0,
		goalCount: 0, goalOutcomeCounts: { active: 0, partial: 0, blocked: 0, fulfilled: 0 },
		taskCount: 0, taskStatusCounts: { running: 0, returned: 0, failed: 0,
			accepted: 0, rejected: 0, unknown: 0 },
		operationCount: 0, operationStatusCounts: { prepared: 0, issued: 0,
			"response-received": 0, "partial-settled": 0,
			"terminal-response-incomplete": 0, unknown: 0, confirmed: 0,
			"not-issued": 0 }, observedAt: "2026-10-08T10:00:00.000Z"
	});
	const makeFrame = (stored: { sequence: number; sha256: string },
		boundary: "initial" | "request-reserved" | "control-observed", requestCount = 0) => {
		const { version: _version, kind: _kind, partial: _partial, complete: _complete,
			selectionAuthority: _selectionAuthority, scientificAcceptance: _scientificAcceptance,
			accounting: _accounting, ...fields } = makeStatus(stored, boundary, requestCount);
		return writer.emit({ sequence: stored.sequence, ...fields });
	};
	return { source, outputDir, publicKeyFile, expectedSpkiSha256, seedEnvelopeB64,
		authenticatedMissionKey, seedDigest: seed.seedDigest, journal, writer, snapshot,
		makeStatus, makeFrame };
}

test("publication gate rejects forged ciphertext even when its outer frame is valid", async () => {
	const directory = await mkdtemp(path.join(os.tmpdir(), "mulpis-gate-auth-"));
	try {
		const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
		const publicKeyFile = path.join(directory, "public.pem");
		await writeFile(publicKeyFile, publicKey.export({ type: "spki", format: "pem" }));
		const expectedSpkiSha256 = createHash("sha256")
			.update(publicKey.export({ type: "spki", format: "der" })).digest("hex");
		const payload = { version: 1, kind: "mul-pis-private-mission-ledger", missionId: MISSION_ID,
			repository: MISSION_REPOSITORY, globalMaxCny: MISSION_TOTAL_CNY,
			priorCommittedCny: 0, revision: 1,
			previous: { runId: "8001001", runAttempt: 1, artifactId: "9002001",
				artifactName: MISSION_ARTIFACT } };
		const payloadBytes = Buffer.from(JSON.stringify(payload));
		const signature = sign("sha256", payloadBytes, { key: privateKey,
			padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 });
		const seedEnvelopeB64 = Buffer.from(JSON.stringify({ payload_b64: payloadBytes.toString("base64"),
			signature_b64: signature.toString("base64") })).toString("base64");
		const source = { repository: MISSION_REPOSITORY, runId: "12345", runAttempt: 1,
			commit: "a".repeat(40), event: "workflow_dispatch" as const,
			priorEnvelopeSha256: "b".repeat(64) };
		const writer = await createLiveControlFrameWriter({ seedEnvelopeB64, publicKeyFile,
			expectedSpkiSha256, source, emitFrame: () => undefined });
		const good = await writer.emit({ sequence: 1, committedCheckpointBoundary: "request-observed",
			checkpointSha256: "c".repeat(64), requestCount: 1, responseReceivedCount: 0,
			goalCount: 0, goalOutcomeCounts: { active: 0, partial: 0, blocked: 0, fulfilled: 0 },
			taskCount: 0, taskStatusCounts: { running: 0, returned: 0, failed: 0,
				accepted: 0, rejected: 0, unknown: 0 },
			operationCount: 0, operationStatusCounts: { prepared: 0, issued: 0,
				"response-received": 0, "partial-settled": 0,
				"terminal-response-incomplete": 0, unknown: 0, confirmed: 0,
				"not-issued": 0 },
			observedAt: "2026-10-08T10:00:00.000Z" });
		const parent = { ...sourceEnv, MULPIS_MISSION_LEDGER_B64: seedEnvelopeB64 };
		const accepted: string[] = [];
		const gate = createAuthenticatedProgressGate({ parent, publicKeyFile, expectedSpkiSha256,
			accept: line => { accepted.push(line); } });
		assert.equal(gate.offer(good), true);
		await until(() => accepted.length === 1);
		assert.deepEqual(accepted, [good]);
		const forged = JSON.parse(good) as Record<string, unknown>;
		forged.ciphertextB64 = Buffer.from("private plaintext smuggled through base64").toString("base64");
		const leaked: string[] = [];
		const badGate = createAuthenticatedProgressGate({ parent, publicKeyFile, expectedSpkiSha256,
			accept: line => { leaked.push(line); } });
		assert.equal(badGate.offer(JSON.stringify(forged)), true);
		await until(() => badGate.stats().disabled);
		assert.deepEqual(leaked, []);
		gate.stop(); badGate.stop();
	} finally { await rm(directory, { recursive: true, force: true }); }
});

test("prefix reader accepts one committed inode and rejects stale, tampered, or symlink bytes", async () => {
	const directory = await mkdtemp(path.join(os.tmpdir(), "mulpis-prefix-inode-"));
	try {
		const f = await prefixFixture(directory);
		const first = await f.journal.record("initial", f.snapshot(0));
		const firstBytes = await readFile(path.join(f.outputDir, INCREMENTAL_CHECKPOINT_FILE));
		assert.deepEqual(await readAuthenticatedCommittedPrefix({ outputDir: f.outputDir,
			source: f.source, sequence: first.sequence, checkpointSha256: first.sha256,
			event: "initial", authenticatedMissionKey: f.authenticatedMissionKey }), firstBytes);
		const second = await f.journal.record("request-reserved", f.snapshot(1));
		await assert.rejects(readAuthenticatedCommittedPrefix({ outputDir: f.outputDir,
			source: f.source, sequence: first.sequence, checkpointSha256: first.sha256,
			event: "initial", authenticatedMissionKey: f.authenticatedMissionKey }));
		const secondBytes = await readAuthenticatedCommittedPrefix({ outputDir: f.outputDir,
			source: f.source, sequence: second.sequence, checkpointSha256: second.sha256,
			event: "request-reserved", authenticatedMissionKey: f.authenticatedMissionKey });
		assert.equal(createHash("sha256").update(secondBytes).digest("hex"), second.sha256);
		await assert.rejects(readAuthenticatedCommittedPrefix({ outputDir: f.outputDir,
			source: { ...f.source, runId: "12346" }, sequence: second.sequence,
			checkpointSha256: second.sha256, event: "request-reserved",
			authenticatedMissionKey: f.authenticatedMissionKey }));
		const file = path.join(f.outputDir, INCREMENTAL_CHECKPOINT_FILE);
		await writeFile(file, "forged private text", { mode: 0o600 });
		await assert.rejects(readAuthenticatedCommittedPrefix({ outputDir: f.outputDir,
			source: f.source, sequence: second.sequence, checkpointSha256: second.sha256,
			event: "request-reserved", authenticatedMissionKey: f.authenticatedMissionKey }));
		await rm(file);
		await symlink(path.join(directory, "public.pem"), file);
		await assert.rejects(readAuthenticatedCommittedPrefix({ outputDir: f.outputDir,
			source: f.source, sequence: second.sequence, checkpointSha256: second.sha256,
			event: "request-reserved", authenticatedMissionKey: f.authenticatedMissionKey }));
	} finally { await rm(directory, { recursive: true, force: true }); }
});

test("late multipart prefix survives saturated status share with encrypted manifest last", async () => {
	const directory = await mkdtemp(path.join(os.tmpdir(), "mulpis-prefix-multipart-reserve-"));
	let now = 0;
	let fireTimer: (() => void) | undefined;
	const uploads: Array<{ name: string; member: string; bytes: Buffer; file: string }> = [];
	try {
		const f = await prefixFixture(directory);
		const first = await f.journal.record("initial", f.snapshot(0));
		const ciphertextDir = path.join(directory, "ciphertext");
		const uploader = createProgressUploader({ directory: ciphertextDir,
			runId: "12345", runAttempt: "1", maxAttempts: 8,
			prefix: { outputDir: f.outputDir, publicKeyFile: f.publicKeyFile,
				seedEnvelopeB64: f.seedEnvelopeB64, expectedSpkiSha256: f.expectedSpkiSha256,
				availableBytes: syntheticAvailableBytes,
				now: () => now, scheduleTimer: fire => {
					fireTimer = fire;
					return { unref: () => undefined, clear: () => undefined };
				} },
			client: async () => ({ uploadArtifact: async (name, files, root) => {
				const bytes = await readFile(files[0]!);
				assert.equal(path.dirname(files[0]!), root);
				uploads.push({ name, member: path.basename(files[0]!), bytes, file: files[0]! });
				const id = 9000 + uploads.length;
					const digest = createHash("sha256")
						.update(`synthetic-archive-${id}`).digest("hex");
					return { id, digest: uploads.length % 2 ? digest : `sha256:${digest}` };
			} }) });
		assert.equal(uploader.offerPrefix({ source: f.source, sequence: first.sequence,
			status: f.makeStatus(first, "initial") }), true);
		await until(() => uploader.stats().prefixAttempts === 1);
		for (let count = 1; count <= 4; count++) {
			const committed = await f.journal.record("control-observed", f.snapshot(0));
			assert.equal(uploader.offer(frame(committed.sequence), committed.sequence), true);
			await until(() => uploader.stats().statusAttempts === count);
		}
		assert.equal(uploader.offer(frame(1000), 1000), false);
		const objectiveCheckpointJson = JSON.stringify({ version: 1,
			kind: "original-objective-progress", detail: "x".repeat(13 * 1024 * 1024) });
		const late = await f.journal.record("control-observed", {
			...f.snapshot(0), objectiveCheckpointJson });
		const original = await readFile(path.join(f.outputDir, INCREMENTAL_CHECKPOINT_FILE));
		assert.ok(original.length > ARTIFACT_PARTITION_PAYLOAD_BYTES);
		assert.ok(fireTimer);
		now = PREFIX_PUBLICATION_INTERVAL_MS;
		fireTimer();
		const rootName = `confidential-mission-prefix-12345-1-${late.sequence}`;
		await until(() => uploads.some(row => row.name === rootName));
		await until(() => !uploader.stats().active);
		assert.equal(uploader.stats().attempts, 8);
		assert.equal(uploader.stats().statusAttempts, 4);
		assert.equal(uploader.stats().prefixAttempts, 4);
		const root = uploads.find(row => row.name === rootName)!;
		assert.equal(root.member, ARTIFACT_PARTITION_MANIFEST_FILE);
		assert.equal(uploads.at(-1)!.name, rootName);
		const source = { repository: MISSION_REPOSITORY, runId: f.source.runId,
			runAttempt: f.source.runAttempt, commit: f.source.commit, event: f.source.event } as const;
		const manifest = openPartitionManifest({ raw: root.bytes.toString("utf8"),
			missionKey: f.authenticatedMissionKey, seedDigest: f.seedDigest,
			expectedSource: source, expectedArtifactName: rootName });
		assert.equal(manifest.chunks.length, 2);
		const chunkBytes = manifest.chunks.map(chunk => {
			const uploaded = uploads.find(row => row.name === chunk.artifactName);
			assert.ok(uploaded);
			assert.equal(uploaded.member, chunk.fileName);
			return uploaded.bytes;
		});
		const recovered = restorePartitionFiles(manifest, chunkBytes, source, rootName);
		assert.deepEqual(recovered[INCREMENTAL_CHECKPOINT_FILE], original);
		assert.deepEqual((await readdir(ciphertextDir)).filter(name =>
			name.startsWith("confidential-mission-prefix-")), []);
		for (const upload of uploads.filter(row => row.name.startsWith("confidential-mission-prefix-")))
			await assert.rejects(readFile(upload.file));
		uploader.stop();
	} finally { await rm(directory, { recursive: true, force: true }); }
});

test("child stdout, stderr and exit remain private; public relay emits only fixed heartbeat", async () => {
	const directory = await mkdtemp(path.join(os.tmpdir(), "mulpis-observer-process-"));
	const publicLines: string[] = [];
	const stdoutFile = path.join(directory, "child-out");
	const stderrFile = path.join(directory, "child-err");
	const synthetic = `const fs=require('node:fs');` +
		`process.stdout.write('synthetic-private-stdout\\n');` +
		`process.stderr.write('synthetic-private-stderr\\n');` +
		`fs.writeSync(3,'DO NOT SHOW PRIVATE TEXT\\n');` +
		`fs.writeSync(3,${JSON.stringify(PUBLIC_HEARTBEAT_LINE)});` +
		`fs.writeSync(4,${JSON.stringify(`${frame(1)}\n`)});` +
		`process.exit(23);`;
	try {
		const code = await launchPrivateCampaignObserver({ inputDir: directory, outputDir: path.join(directory, "results"),
			stdoutFile, stderrFile, parentEnv: sourceEnv,
			spawnChild: (_command, _args, options) => spawn(process.execPath, ["-e", synthetic], options),
			publicWrite: line => { publicLines.push(line); },
			client: async () => ({ uploadArtifact: async () => {} }) });
		assert.equal(code, 23);
		assert.equal(await readFile(stdoutFile, "utf8"), "synthetic-private-stdout\n");
		assert.equal(await readFile(stderrFile, "utf8"), "synthetic-private-stderr\n");
		assert.deepEqual(publicLines, [PUBLIC_HEARTBEAT_LINE]);
		const liveDirectory = path.join(directory, "private-campaign-live-ciphertext");
		if ((await readdir(directory)).includes("private-campaign-live-ciphertext"))
			for (const file of await readdir(liveDirectory))
				assert.ok(file.endsWith(".enc.json"));
	} finally { await rm(directory, { recursive: true, force: true }); }
});

test("local JS action keeps runtime credentials, gates public output and records true driver exit", async () => {
	const directory = await mkdtemp(path.join(os.tmpdir(), "mulpis-js-action-"));
	const observerScript = path.join(directory, "synthetic-observer.mjs");
	const outputFile = path.join(directory, "github-output");
	const publicFile = path.join(directory, "public-output");
	const script = `import { writeFileSync, writeSync } from 'node:fs';` +
		`const p=process.argv.indexOf('--driver-exit-file');` +
		`writeFileSync(process.argv[p+1], JSON.stringify({version:1,kind:'private-campaign-driver-exit',driverExitCode:23,childSignal:null})+'\\n');` +
		`process.stdout.write('private-toolkit-stdout '+Boolean(process.env.ACTIONS_RUNTIME_TOKEN)+'\\n');` +
		`process.stderr.write('private-toolkit-stderr\\n');` +
		`writeSync(3,'do not show private bytes\\n');` +
		`writeSync(3,${JSON.stringify(PUBLIC_HEARTBEAT_LINE)});` +
		`process.exit(23);`;
	await writeFile(observerScript, script);
	await writeFile(outputFile, "");
	const publicFd = openSync(publicFile, "w", 0o600);
	try {
		const result = await runPrivateCampaignAction({ observerScript, publicFd,
			env: { ...sourceEnv, RUNNER_TEMP: directory, INPUT_DIR: directory,
				GITHUB_OUTPUT: outputFile } });
		assert.deepEqual(result, { driverExitCode: "23", observerExitCode: 23 });
		assert.equal(await readFile(outputFile, "utf8"), "driver_exit_code=23\n");
		assert.deepEqual(JSON.parse(await readFile(path.join(directory,
			"private-campaign-output", "campaign-status.json"), "utf8")),
			{ driver_exit_code: 23, status: "incomplete" });
		assert.equal(await readFile(path.join(directory, "private-campaign-observer-stdout"), "utf8"),
			"private-toolkit-stdout true\n");
		assert.equal(await readFile(path.join(directory, "private-campaign-observer-stderr"), "utf8"),
			"private-toolkit-stderr\n");
		assert.equal(await readFile(publicFile, "utf8"), PUBLIC_HEARTBEAT_LINE);
	} finally { closeSync(publicFd); await rm(directory, { recursive: true, force: true }); }
});

test("local JS action marks an observer crash as unknown instead of inventing driver completion", async () => {
	const directory = await mkdtemp(path.join(os.tmpdir(), "mulpis-js-action-unknown-"));
	const observerScript = path.join(directory, "synthetic-crash.mjs");
	const outputFile = path.join(directory, "github-output");
	const publicFile = path.join(directory, "public-output");
	await writeFile(observerScript, "process.exit(7);\n");
	await writeFile(outputFile, "");
	const publicFd = openSync(publicFile, "w", 0o600);
	try {
		const result = await runPrivateCampaignAction({ observerScript, publicFd,
			env: { ...sourceEnv, RUNNER_TEMP: directory, INPUT_DIR: directory,
				GITHUB_OUTPUT: outputFile } });
		assert.deepEqual(result, { driverExitCode: "unknown", observerExitCode: 7 });
		assert.equal(await readFile(outputFile, "utf8"), "driver_exit_code=unknown\n");
		assert.deepEqual(JSON.parse(await readFile(path.join(directory,
			"private-campaign-output", "campaign-status.json"), "utf8")),
			{ status: "incomplete", observer: "driver-outcome-unobserved" });
		assert.equal(await readFile(publicFile, "utf8"), "");
	} finally { closeSync(publicFd); await rm(directory, { recursive: true, force: true }); }
});

test("verified zero exit without a campaign status remains incomplete", async () => {
	const directory = await mkdtemp(path.join(os.tmpdir(), "mulpis-js-action-status-gap-"));
	const observerScript = path.join(directory, "synthetic-zero.mjs");
	const outputFile = path.join(directory, "github-output");
	const publicFile = path.join(directory, "public-output");
	await writeFile(observerScript,
		`import { writeFileSync } from 'node:fs';` +
		`const p=process.argv.indexOf('--driver-exit-file');` +
		`writeFileSync(process.argv[p+1], JSON.stringify({version:1,kind:'private-campaign-driver-exit',driverExitCode:0,childSignal:null})+'\\n');` +
		`process.exit(0);`);
	await writeFile(outputFile, "");
	const publicFd = openSync(publicFile, "w", 0o600);
	try {
		const result = await runPrivateCampaignAction({ observerScript, publicFd,
			env: { ...sourceEnv, RUNNER_TEMP: directory, INPUT_DIR: directory,
				GITHUB_OUTPUT: outputFile } });
		assert.deepEqual(result, { driverExitCode: "unknown", observerExitCode: 0 });
		assert.equal(await readFile(outputFile, "utf8"), "driver_exit_code=unknown\n");
		assert.deepEqual(JSON.parse(await readFile(path.join(directory,
			"private-campaign-output", "campaign-status.json"), "utf8")),
			{ driver_exit_code: 0, status: "incomplete", observer: "campaign-status-missing" });
	} finally { closeSync(publicFd); await rm(directory, { recursive: true, force: true }); }
});
