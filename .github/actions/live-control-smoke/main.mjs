/** CI-only, synthetic Actions runtime smoke. No mission input or provider key is used. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { constants, createHash, generateKeyPairSync, sign } from "node:crypto";
import { once } from "node:events";
import { writeFileSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAuthenticatedProgressGate, createProgressUploader,
	privateCampaignChildEnv } from "../../../scripts/private-campaign-observer.ts";
import { runPrivateCampaignAction } from "../../../scripts/private-campaign-observer-action.mjs";
import { createLiveControlFrameReader } from "../../../src/runner/live-control-frame.ts";
import { MISSION_ARTIFACT, MISSION_ID, MISSION_REPOSITORY,
	MISSION_TOTAL_CNY } from "../../../src/runner/signed-mission-ledger.ts";

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
	const checkpointSha256 = digest("synthetic-committed-prefix");
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
		expectedSpkiSha256, priorEnvelopeSha256, checkpointSha256],
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
	const uploader = createProgressUploader({ directory: path.join(temporary, "ciphertext"),
		runId: source.runId, runAttempt: String(source.runAttempt), maxAttempts: 1,
		client: async () => ({ uploadArtifact: async (name, files, root, options) => {
			try {
				assert.equal(options.retentionDays, 1);
				const result = await client.uploadArtifact(name, files, root, options);
				uploaded.resolve({ name, result });
				return result;
			} catch (error) { uploaded.reject(error); throw error; }
		} }) });
	const accepted = Promise.withResolvers();
	const gate = createAuthenticatedProgressGate({ parent, publicKeyFile, expectedSpkiSha256,
		accept: (authenticatedLine, sequence) => {
			assert.equal(authenticatedLine, line);
			assert.equal(sequence, 1);
			assert.equal(uploader.offer(authenticatedLine, sequence), true);
			accepted.resolve();
		} });
	assert.equal(gate.offer(line), true);
	await bounded(accepted.promise, 15000);
	const { name, result } = await bounded(uploaded.promise, 120000);
	gate.stop(); uploader.stop();
	assert.equal(uploader.stats().attempts, 1);
	assert.ok(Number.isSafeInteger(result?.id) && result.id > 0);
	const downloaded = await bounded(client.downloadArtifact(result.id,
		{ path: path.join(temporary, "downloaded") }), 120000);
	const downloadedBytes = await readFile(path.join(downloaded.downloadPath,
		`${name}.enc.json`));
	assert.ok(downloadedBytes.equals(Buffer.from(`${line}\n`, "utf8")),
		"downloaded ciphertext bytes differ from uploaded frame");
	const reader = await createLiveControlFrameReader({ seedEnvelopeB64, publicKeyFile,
		expectedSpkiSha256, source });
	const verified = reader.read(line);
	assert.equal(verified.sequence, 1);
	assert.equal(verified.status.committedCheckpointBoundary, "initial");
	assert.equal(verified.status.checkpointSha256, checkpointSha256);
	assert.equal(verified.status.partial, true);
	assert.equal(verified.status.complete, false);

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
	return { artifactName: name, artifactId: result.id, driverExitCode: 23 };
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
