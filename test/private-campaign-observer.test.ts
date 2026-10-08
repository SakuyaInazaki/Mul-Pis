import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { constants, createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createAuthenticatedProgressGate, createProgressUploader,
	launchPrivateCampaignObserver, parsePrivateProgressFrame,
	privateCampaignChildEnv, PROGRESS_ARTIFACT_ATTEMPT_LIMIT } from "../scripts/private-campaign-observer.ts";
import { PUBLIC_HEARTBEAT_LINE } from "../scripts/private-campaign-heartbeat.ts";
import { createLiveControlFrameWriter } from "../src/runner/live-control-frame.ts";
import { MISSION_ARTIFACT, MISSION_ID, MISSION_REPOSITORY, MISSION_TOTAL_CNY } from
	"../src/runner/signed-mission-ledger.ts";
import { closeSync, openSync } from "node:fs";

const actionModule = new URL("../scripts/private-campaign-observer-action.mjs", import.meta.url).href;
const { runPrivateCampaignAction } = await import(actionModule);

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

test("child has only one-shot inputs, never Actions runtime or file-command channels", () => {
	const child = privateCampaignChildEnv(sourceEnv);
	assert.equal(child.GITHUB_TOKEN, "synthetic-github");
	assert.equal(child.DEEPSEEK_API_KEY, "synthetic-deepseek");
	assert.equal(child.MULPIS_MISSION_LEDGER_B64, "synthetic-ledger");
	assert.equal(child.MULPIS_ACTIONS_PUBLIC_HEARTBEAT_FD, "3");
	assert.equal(child.MULPIS_ACTIONS_PRIVATE_PROGRESS_FD, "4");
	for (const key of Object.keys(child))
		assert.ok(!/^(?:ACTIONS_RUNTIME_|ACTIONS_RESULTS_URL$|ACTIONS_CACHE_URL$|ACTIONS_ID_TOKEN_|GITHUB_(?:OUTPUT|ENV|PATH|STEP_SUMMARY)$|NODE_OPTIONS$)/.test(key), key);
	for (const key of ["ACTIONS_RUNTIME_TOKEN", "ACTIONS_RESULTS_URL", "ACTIONS_CACHE_URL",
		"ACTIONS_ID_TOKEN_REQUEST_TOKEN", "ACTIONS_ID_TOKEN_REQUEST_URL", "GITHUB_OUTPUT",
		"GITHUB_ENV", "GITHUB_PATH", "GITHUB_STEP_SUMMARY", "NODE_OPTIONS"])
		assert.equal(child[key], undefined, key);
});

test("observer accepts only bounded source-bound opaque frames", () => {
	assert.equal(parsePrivateProgressFrame(frame(7), sourceEnv), 7);
	assert.equal(parsePrivateProgressFrame(frame(0), sourceEnv), undefined);
		assert.equal(parsePrivateProgressFrame(frame(8).replace('"sequence":8', '"sequence":9'), sourceEnv), 9);
	const wrongSource = { ...sourceEnv, GITHUB_RUN_ID: "another" };
	assert.equal(parsePrivateProgressFrame(frame(7), wrongSource), undefined);
	assert.equal(parsePrivateProgressFrame(`${frame(7)}private`, sourceEnv), undefined);
	assert.equal(parsePrivateProgressFrame("x".repeat(4097), sourceEnv), undefined);
});

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

test("uploader keeps one latest pending frame, counts ambiguous attempts and never reuses a name", async () => {
	const directory = await mkdtemp(path.join(os.tmpdir(), "mulpis-live-upload-"));
	let firstReject: ((reason?: Error) => void) | undefined;
	const calls: Array<{ name: string; file: string; retention: number }> = [];
	try {
		const uploader = createProgressUploader({ directory, runId: "12345", runAttempt: "1", maxAttempts: 2,
			client: async () => ({ uploadArtifact: async (name, files, root, options) => {
				assert.equal(root, directory);
				calls.push({ name, file: files[0]!, retention: options.retentionDays });
				if (calls.length === 1) await new Promise<void>((_, reject) => { firstReject = reject; });
			} }) });
		assert.equal(uploader.offer(frame(1), 1), true);
		await until(() => calls.length === 1);
		assert.equal(uploader.offer(frame(2), 2), true);
		assert.equal(uploader.offer(frame(3), 3), true);
		assert.equal(uploader.offer(frame(3), 3), false);
		assert.equal(uploader.offer(frame(4), 4), true);
		firstReject!(new Error("ambiguous upload failure"));
		await until(() => calls.length === 2);
		assert.deepEqual(calls.map(value => value.name), [
			"confidential-campaign-progress-12345-1-1",
			"confidential-campaign-progress-12345-1-2"]);
		assert.deepEqual(calls.map(value => value.retention), [1, 1]);
		assert.equal(await readFile(calls[0]!.file, "utf8"), `${frame(1)}\n`);
		assert.equal(await readFile(calls[1]!.file, "utf8"), `${frame(4)}\n`);
		assert.equal(uploader.offer(frame(5), 5), false);
		assert.equal(uploader.stats().attempts, 2);
		assert.equal(PROGRESS_ARTIFACT_ATTEMPT_LIMIT, 498);
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

test("closed private FD4 and failed public heartbeat cannot change child exit", async () => {
	const directory = await mkdtemp(path.join(os.tmpdir(), "mulpis-observer-closed-pipe-"));
	const stdoutFile = path.join(directory, "child-out");
	const stderrFile = path.join(directory, "child-err");
	const synthetic = `const fs=require('node:fs');` +
		`setTimeout(() => {` +
		`try { fs.writeSync(4, 'synthetic frame\\n'); } catch {}` +
		`fs.writeSync(3,${JSON.stringify(PUBLIC_HEARTBEAT_LINE)});` +
		`process.stdout.write('stdout before exit\\n');` +
		`process.stderr.write('stderr before exit\\n');` +
		`process.exit(29); }, 30);`;
	try {
		const code = await launchPrivateCampaignObserver({ inputDir: directory,
			outputDir: path.join(directory, "results"), stdoutFile, stderrFile,
			parentEnv: sourceEnv,
			spawnChild: (_command, _args, options) => {
				const child = spawn(process.execPath, ["-e", synthetic], options);
				child.stdio[4]?.destroy(); // Actually close the parent's private pipe read end.
				return child;
			},
			publicWrite: () => { throw new Error("public output unavailable"); },
			client: async () => { throw new Error("artifact runtime unavailable"); } });
		assert.equal(code, 29);
		assert.equal(await readFile(stdoutFile, "utf8"), "stdout before exit\n");
		assert.equal(await readFile(stderrFile, "utf8"), "stderr before exit\n");
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

test("verified zero exit with a real campaign status can report success", async () => {
	const directory = await mkdtemp(path.join(os.tmpdir(), "mulpis-js-action-success-"));
	const observerScript = path.join(directory, "synthetic-success.mjs");
	const outputFile = path.join(directory, "github-output");
	const publicFile = path.join(directory, "public-output");
	await writeFile(observerScript,
		`import { writeFileSync } from 'node:fs'; import path from 'node:path';` +
		`const r=process.argv.indexOf('--driver-exit-file');` +
		`const o=process.argv.indexOf('--output-dir');` +
		`writeFileSync(path.join(process.argv[o+1],'campaign-status.json'), '{"status":"complete"}\\n');` +
		`writeFileSync(process.argv[r+1], JSON.stringify({version:1,kind:'private-campaign-driver-exit',driverExitCode:0,childSignal:null})+'\\n');` +
		`process.exit(0);`);
	await writeFile(outputFile, "");
	const publicFd = openSync(publicFile, "w", 0o600);
	try {
		const result = await runPrivateCampaignAction({ observerScript, publicFd,
			env: { ...sourceEnv, RUNNER_TEMP: directory, INPUT_DIR: directory,
				GITHUB_OUTPUT: outputFile } });
		assert.deepEqual(result, { driverExitCode: "0", observerExitCode: 0 });
		assert.equal(await readFile(outputFile, "utf8"), "driver_exit_code=0\n");
		assert.deepEqual(JSON.parse(await readFile(path.join(directory,
			"private-campaign-output", "campaign-status.json"), "utf8")), { status: "complete" });
	} finally { closeSync(publicFd); await rm(directory, { recursive: true, force: true }); }
});
