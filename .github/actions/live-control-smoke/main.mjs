/** CI-only, synthetic Actions runtime smoke. No mission input or provider key is used. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { constants, createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { once } from "node:events";
import { writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAuthenticatedProgressGate, createProgressUploader,
	privateCampaignChildEnv } from "../../../scripts/private-campaign-observer.ts";
import { runPrivateCampaignAction } from "../../../scripts/private-campaign-observer-action.mjs";
import { createLiveControlFrameReader } from "../../../src/runner/live-control-frame.ts";
import { IncrementalPrivateCheckpointJournal, INCREMENTAL_CHECKPOINT_FILE,
	openIncrementalControlPrefix } from
	"../../../src/runner/incremental-private-checkpoint.ts";
import { ARTIFACT_PARTITION_MANIFEST_FILE, openPartitionManifest,
	restorePartitionFiles } from "../../../src/runner/private-artifact-partition.ts";
import { uploadFinalCarry } from "../final-carry-upload/main.mjs";
import { authenticateSignedMissionSeed, MISSION_ARTIFACT, MISSION_ID,
	MISSION_REPOSITORY, MISSION_TOTAL_CNY } from
	"../../../src/runner/signed-mission-ledger.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const digest = text => createHash("sha256").update(text).digest("hex");
// These bound only this synthetic CI check. They never run in the campaign.
const bounded = (promise, milliseconds) => {
	let timer;
	return Promise.race([promise, new Promise((_, reject) => {
		timer = setTimeout(() => reject(new Error("synthetic smoke timed out")), milliseconds);
	})]).finally(() => clearTimeout(timer));
};

async function readSingleFrame(stream) {
	let data = Buffer.alloc(0);
	for await (const chunk of stream) {
		data = Buffer.concat([data, chunk]);
		if (data.length > 4097) throw new Error("synthetic frame exceeds byte bound");
	}
	assert.equal(data.at(-1), 10);
	const line = data.subarray(0, -1).toString("utf8");
	assert.ok(!line.includes("\n") && !line.includes("\r"));
	return line;
}

export async function runSyntheticLiveObserverSmoke({ env = process.env, artifactClient } = {}) {
	assert.ok(env.ACTIONS_RUNTIME_TOKEN && env.ACTIONS_RESULTS_URL,
		"Node 24 action did not receive the GitHub artifact runtime");
	assert.equal(env.GITHUB_REPOSITORY, MISSION_REPOSITORY);
	assert.match(env.GITHUB_RUN_ID ?? "", /^[1-9][0-9]{0,17}$/);
	assert.match(env.GITHUB_RUN_ATTEMPT ?? "", /^[1-9][0-9]{0,17}$/);
	assert.match(env.GITHUB_SHA ?? "", /^[0-9a-f]{40}$/);
	assert.ok(env.GITHUB_EVENT_NAME === "push" || env.GITHUB_EVENT_NAME === "workflow_dispatch");
	const temporary = await mkdtemp(path.join(env.RUNNER_TEMP ?? os.tmpdir(), "mulpis-synthetic-live-"));
	const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
	const publicKeyFile = path.join(temporary, "synthetic-public.pem");
	await writeFile(publicKeyFile, publicKey.export({ type: "spki", format: "pem" }), { mode: 0o600 });
	const expectedSpkiSha256 = digest(publicKey.export({ type: "spki", format: "der" }));
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
	const priorEnvelopeSha256 = digest("synthetic-prior-envelope");
	const prefixOutputDir = path.join(temporary, "committed-prefix");
	await mkdir(prefixOutputDir, { mode: 0o700 });
	const source = { repository: MISSION_REPOSITORY, runId: env.GITHUB_RUN_ID,
		runAttempt: Number(env.GITHUB_RUN_ATTEMPT), commit: env.GITHUB_SHA,
		event: env.GITHUB_EVENT_NAME, priorEnvelopeSha256 };
	const parent = { ...env, MULPIS_MISSION_LEDGER_B64: seedEnvelopeB64,
		SMOKE_RUNTIME_CANARY: "parent-only" };
	const childEnv = privateCampaignChildEnv(parent);
	for (const key of ["ACTIONS_RUNTIME_TOKEN", "ACTIONS_RESULTS_URL", "ACTIONS_CACHE_URL",
		"ACTIONS_ID_TOKEN_REQUEST_TOKEN", "GITHUB_OUTPUT", "GITHUB_ENV", "GITHUB_PATH",
		"GITHUB_STEP_SUMMARY", "SMOKE_RUNTIME_CANARY"])
		assert.equal(childEnv[key], undefined, `${key} reached synthetic child`);
	const child = spawn(process.execPath, [path.join(HERE, "child.mjs"), publicKeyFile,
		expectedSpkiSha256, priorEnvelopeSha256, prefixOutputDir],
		{ env: childEnv, stdio: ["ignore", "pipe", "pipe", "pipe", "pipe"] });
	child.stdout.resume(); child.stderr.resume(); child.stdio[3].resume();
	const [line, [childCode, childSignal]] = await bounded(Promise.all([
		readSingleFrame(child.stdio[4]), once(child, "exit")]), 15000);
	assert.equal(childSignal, null);
	assert.equal(childCode, 23, "synthetic child did not retain its terminal code");

	let client = artifactClient;
	if (!client) {
		const { DefaultArtifactClient } = await import("@actions/artifact");
		client = new DefaultArtifactClient();
	}
	const uploaded = Promise.withResolvers();
	const uploads = new Map();
	const uploader = createProgressUploader({ directory: path.join(temporary, "ciphertext"),
		runId: source.runId, runAttempt: String(source.runAttempt), maxAttempts: 2,
		prefix: { outputDir: prefixOutputDir, publicKeyFile, seedEnvelopeB64,
			expectedSpkiSha256 },
		client: async () => ({ uploadArtifact: async (name, files, root, options) => {
			try {
				assert.equal(options.retentionDays, 1);
				assert.equal(files.length, 1);
				assert.ok(!uploads.has(name));
				const result = await client.uploadArtifact(name, files, root, options);
				uploads.set(name, result);
				if (uploads.size === 2) uploaded.resolve();
				return result;
			} catch (error) { uploaded.reject(error); throw error; }
		} }) });
	const accepted = Promise.withResolvers();
	const gate = createAuthenticatedProgressGate({ parent, publicKeyFile, expectedSpkiSha256,
		accept: (authenticatedLine, sequence, status, authenticatedSource) => {
			assert.equal(authenticatedLine, line);
			assert.equal(sequence, 1);
			assert.equal(uploader.offerPrefix({ source: authenticatedSource,
				sequence, status }), true);
			assert.equal(uploader.offer(authenticatedLine, sequence), true);
			accepted.resolve();
		} });
	assert.equal(gate.offer(line), true);
	await bounded(accepted.promise, 15000);
	await bounded(uploaded.promise, 120000);
	gate.stop(); uploader.stop();
	assert.equal(uploader.stats().attempts, 2);
	assert.equal(uploader.stats().prefixAttempts, 1);
	assert.equal(uploader.stats().statusAttempts, 1);
	const prefixName = `confidential-mission-prefix-${source.runId}-${source.runAttempt}-1`;
	const statusName = [...uploads.keys()].find(name =>
		name.startsWith(`confidential-campaign-progress-${source.runId}-${source.runAttempt}-`));
	assert.ok(statusName);
	const prefixResult = uploads.get(prefixName);
	const statusResult = uploads.get(statusName);
	assert.ok(Number.isSafeInteger(prefixResult?.id) && prefixResult.id > 0);
	assert.ok(Number.isSafeInteger(statusResult?.id) && statusResult.id > 0);
	const downloaded = await bounded(client.downloadArtifact(statusResult.id,
		{ path: path.join(temporary, "downloaded") }), 120000);
	const downloadedBytes = await readFile(path.join(downloaded.downloadPath,
		`${statusName}.enc.json`));
	assert.ok(downloadedBytes.equals(Buffer.from(`${line}\n`, "utf8")),
		"downloaded ciphertext bytes differ from uploaded frame");
	const reader = await createLiveControlFrameReader({ seedEnvelopeB64, publicKeyFile,
		expectedSpkiSha256, source });
	const verified = reader.read(line);
	assert.equal(verified.sequence, 1);
	assert.equal(verified.status.committedCheckpointBoundary, "initial");
	assert.equal(verified.status.partial, true);
	assert.equal(verified.status.complete, false);
	const downloadedPrefix = await bounded(client.downloadArtifact(prefixResult.id,
		{ path: path.join(temporary, "downloaded-prefix") }), 120000);
	const prefixBytes = await readFile(path.join(downloadedPrefix.downloadPath,
		INCREMENTAL_CHECKPOINT_FILE));
	const committedBytes = await readFile(path.join(prefixOutputDir, INCREMENTAL_CHECKPOINT_FILE));
	assert.ok(prefixBytes.equals(committedBytes), "downloaded prefix differs from committed bytes");
	assert.equal(digest(prefixBytes), verified.status.checkpointSha256);
	const authenticatedMissionKey = (await authenticateSignedMissionSeed({
		envelopeB64: seedEnvelopeB64, publicKeyFile, expectedSpkiSha256 }))
		.derivePrivateKey("mul-pis-ledger-continuation-v1");
	const prefix = openIncrementalControlPrefix(prefixBytes.toString("utf8"),
		authenticatedMissionKey, source);
	assert.equal(prefix.sequence, 1);
	assert.equal(prefix.event, "initial");
	assert.equal(prefix.requestAudit.requests.length, 0);
	assert.equal(prefix.hostEffects.complete, false);

	// Exercise the real 16-MiB multipart path through both observer and final
	// carry actions. The large field is random synthetic checkpoint text, so
	// compression cannot turn this into a small legacy artifact.
	const largePrefixDir = path.join(temporary, "large-committed-prefix");
	await mkdir(largePrefixDir, { mode: 0o700 });
	const largeJournal = new IncrementalPrivateCheckpointJournal({ source,
		outputDir: largePrefixDir, authenticatedMissionKey });
	const emptyControl = {
		requestAudit: { version: 3, kind: "accounting-only-request-audit", requests: [],
			settledCny: 0, unknownObservedCny: 0, unpricedRequestCount: 0 },
		hostEffects: { version: 1, kind: "host-effect-prefix-observation", complete: false,
			selectionAuthority: false,
			source: { runId: source.runId, runAttempt: source.runAttempt, commit: source.commit },
			priorEnvelopeSha256: source.priorEnvelopeSha256, historicalGoalRunIds: [],
			goals: [], sessions: [], requestIds: [] }
	};
	await largeJournal.record("initial", emptyControl);
	const largeStored = await largeJournal.record("control-observed", {
		...emptyControl, objectiveCheckpointJson: JSON.stringify({
			kind: "original-objective-progress",
			syntheticPadding: randomBytes(13 * 1024 * 1024).toString("base64") })
	});
	const largePrefixBytes = await readFile(path.join(largePrefixDir, INCREMENTAL_CHECKPOINT_FILE));
	assert.ok(largePrefixBytes.length > 16 * 1024 * 1024);
	const largePrefixName =
		`confidential-mission-prefix-${source.runId}-${source.runAttempt}-${largeStored.sequence}`;
	const largeUploads = new Map();
	const largeUploaded = Promise.withResolvers();
	const largeUploader = createProgressUploader({
		directory: path.join(temporary, "large-prefix-ciphertext"),
		runId: source.runId, runAttempt: String(source.runAttempt), maxAttempts: 6,
		prefix: { outputDir: largePrefixDir, publicKeyFile, seedEnvelopeB64,
			expectedSpkiSha256 },
		client: async () => ({ uploadArtifact: async (name, files, root, options) => {
			try {
				const response = await client.uploadArtifact(name, files, root, options);
				largeUploads.set(name, response);
				if (name === largePrefixName) largeUploaded.resolve();
				return response;
			} catch (error) { largeUploaded.reject(error); throw error; }
		} }) });
	assert.equal(largeUploader.offerPrefix({ source, sequence: largeStored.sequence,
		status: { ...verified.status, committedCheckpointBoundary: "control-observed",
			checkpointSha256: largeStored.sha256 } }), true);
	await bounded(largeUploaded.promise, 180000);
	largeUploader.stop();
	assert.equal(largeUploader.stats().prefixAttempts, 3);
	assert.equal(largeUploads.size, 3);
	const transportSource = { repository: source.repository, runId: source.runId,
		runAttempt: source.runAttempt, commit: source.commit, event: source.event };
	const restoreUploadedMultipart = async (artifactName, rootId, directoryName) => {
		const rootDownload = await bounded(client.downloadArtifact(rootId,
			{ path: path.join(temporary, `${directoryName}-root`) }), 120000);
		const sealed = await readFile(path.join(rootDownload.downloadPath,
			ARTIFACT_PARTITION_MANIFEST_FILE), "utf8");
		const manifest = openPartitionManifest({ raw: sealed, missionKey: authenticatedMissionKey,
			seedDigest: (await authenticateSignedMissionSeed({ envelopeB64: seedEnvelopeB64,
				publicKeyFile, expectedSpkiSha256 })).seedDigest,
			expectedSource: transportSource, expectedArtifactName: artifactName });
		assert.ok(manifest.chunks.length > 1);
		const chunks = [];
		for (const part of manifest.chunks) {
			const downloaded = await bounded(client.downloadArtifact(Number(part.artifactId),
				{ path: path.join(temporary, `${directoryName}-part-${part.index}`) }), 120000);
			chunks.push(await readFile(path.join(downloaded.downloadPath, part.fileName)));
		}
		return restorePartitionFiles(manifest, chunks, transportSource, artifactName);
	};
	const periodicFiles = await restoreUploadedMultipart(largePrefixName,
		largeUploads.get(largePrefixName).id, "periodic-multipart");
	assert.ok(periodicFiles[INCREMENTAL_CHECKPOINT_FILE].equals(largePrefixBytes));
	assert.equal(openIncrementalControlPrefix(
			periodicFiles[INCREMENTAL_CHECKPOINT_FILE].toString("utf8"),
			authenticatedMissionKey, source).sequence, largeStored.sequence);

	const finalOutput = path.join(temporary, "private-campaign-output");
	await mkdir(finalOutput, { mode: 0o700 });
	await writeFile(path.join(finalOutput, INCREMENTAL_CHECKPOINT_FILE),
		largePrefixBytes, { mode: 0o600 });
	const finalUpload = await bounded(uploadFinalCarry({
		env: { ...parent, RUNNER_TEMP: temporary }, artifactClient: client,
		publicKeyFile, expectedSpkiSha256 }), 180000);
	assert.equal(finalUpload.multipart, true);
	assert.equal(finalUpload.partCount, 2);
	const finalFiles = await restoreUploadedMultipart("confidential-mission-carry",
		finalUpload.rootArtifactId, "final-multipart");
	assert.ok(finalFiles[INCREMENTAL_CHECKPOINT_FILE].equals(largePrefixBytes));
	assert.equal(openIncrementalControlPrefix(
			finalFiles[INCREMENTAL_CHECKPOINT_FILE].toString("utf8"),
			authenticatedMissionKey, source).sequence, largeStored.sequence);

	// Exercise the exact production JS action exit-receipt path with a synthetic
	// observer. This uses no campaign driver, model, or mission input.
	const observerScript = path.join(temporary, "synthetic-observer.mjs");
	await writeFile(observerScript,
		`import { writeFileSync } from 'node:fs';\n` +
		`const i = process.argv.indexOf('--driver-exit-file');\n` +
		`writeFileSync(process.argv[i + 1], JSON.stringify({ version: 1, kind: 'private-campaign-driver-exit', driverExitCode: 23, childSignal: null }) + '\\n');\n` +
		`process.exit(23);\n`, { mode: 0o600 });
	const outputFile = path.join(temporary, "synthetic-github-output");
	writeFileSync(outputFile, "", { mode: 0o600 });
	const outcome = await runPrivateCampaignAction({ observerScript,
		env: { ...parent, RUNNER_TEMP: temporary, INPUT_DIR: temporary, GITHUB_OUTPUT: outputFile } });
	assert.deepEqual(outcome, { driverExitCode: "23", observerExitCode: 23 });
	assert.equal(await readFile(outputFile, "utf8"), "driver_exit_code=23\n");
	return { artifactName: statusName, artifactId: statusResult.id,
		prefixArtifactName: prefixName, prefixArtifactId: prefixResult.id,
		driverExitCode: 23 };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		await runSyntheticLiveObserverSmoke();
		process.stdout.write("Synthetic live observer smoke passed\n");
		process.exit(0);
	} catch {
		process.stderr.write("Synthetic live observer smoke failed\n");
		process.exit(1);
	}
}
