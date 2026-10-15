import assert from "node:assert/strict";
import { constants, createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { authenticateSignedMissionSeed, MISSION_ARTIFACT, MISSION_ID,
	MISSION_REPOSITORY, MISSION_TOTAL_CNY } from "../src/runner/signed-mission-ledger.ts";
import { openLedgerContinuation } from "../src/runner/ledger-continuation.ts";
import { INCREMENTAL_CHECKPOINT_FILE } from
	"../src/runner/incremental-private-checkpoint.ts";
import { ARTIFACT_PARTITION_MANIFEST_FILE, openPartitionManifest,
	restorePartitionFiles, type ArtifactTransportSource } from
	"../src/runner/private-artifact-partition.ts";

const actionModule = new URL("../.github/actions/final-carry-upload/main.mjs", import.meta.url).href;
const { uploadFinalCarry } = await import(actionModule);
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const source: ArtifactTransportSource = { repository: MISSION_REPOSITORY,
	runId: "12345678", runAttempt: 1,
	commit: "a".repeat(40), event: "workflow_dispatch" };

async function fixture(t: TestContext) {
	const temporary = await mkdtemp(path.join(os.tmpdir(), "mulpis-final-carry-"));
	t.after(() => rm(temporary, { recursive: true, force: true }));
	const outputDir = path.join(temporary, "private-campaign-output");
	await mkdir(outputDir, { mode: 0o700 });
	const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
	const publicKeyFile = path.join(temporary, "mission-public.pem");
	await writeFile(publicKeyFile, publicKey.export({ type: "spki", format: "pem" }), { mode: 0o600 });
	const expectedSpkiSha256 = sha(publicKey.export({ type: "spki", format: "der" }));
	const payload = { version: 1, kind: "mul-pis-private-mission-ledger", missionId: MISSION_ID,
		repository: MISSION_REPOSITORY, globalMaxCny: MISSION_TOTAL_CNY,
		priorCommittedCny: 0, revision: 1,
		previous: { runId: "8001001", runAttempt: 1, artifactId: "9002001",
			artifactName: MISSION_ARTIFACT } };
	const payloadBytes = Buffer.from(JSON.stringify(payload));
	const signature = sign("sha256", payloadBytes, { key: privateKey,
		padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 });
	const seedEnvelopeB64 = Buffer.from(JSON.stringify({
		payload_b64: payloadBytes.toString("base64"),
		signature_b64: signature.toString("base64") })).toString("base64");
	const env = { RUNNER_TEMP: temporary, GITHUB_REPOSITORY: source.repository,
		GITHUB_RUN_ID: source.runId, GITHUB_RUN_ATTEMPT: String(source.runAttempt),
		GITHUB_RUN_NUMBER: "2", GITHUB_SHA: source.commit, GITHUB_EVENT_NAME: source.event,
		MULPIS_MISSION_LEDGER_B64: seedEnvelopeB64 };
	return { temporary, outputDir, publicKeyFile, expectedSpkiSha256, seedEnvelopeB64, env };
}

async function openCarry(f: Awaited<ReturnType<typeof fixture>>) {
	const run = (id: number, runNumber: number, status: string, commit: string,
		conclusion?: string) => ({ id, run_number: runNumber, run_attempt: 1,
		workflow_id: 91, status, conclusion,
		head_branch: "improve/workflow-learning-reliability", head_sha: commit,
		event: "workflow_dispatch", actor: { login: "SakuyaInazaki" } });
	const anchor = run(8001001, 1, "completed", "b".repeat(40), "success");
	const currentRun = run(12345678, 2, "in_progress", source.commit);
	const request: typeof fetch = async url => {
		const address = String(url);
		let body: unknown;
		if (address.includes("/workflows/manual-private-campaign.yml/runs?"))
			body = { total_count: 2, workflow_runs: [currentRun, anchor] };
		else if (address.endsWith("/runs/8001001/artifacts?per_page=100"))
			body = { total_count: 1, artifacts: [{ id: 9002001, name: MISSION_ARTIFACT,
				expired: false, workflow_run: { id: 8001001 } }] };
		else throw Error(`unexpected synthetic URL: ${address}`);
		return new Response(JSON.stringify(body));
	};
	return openLedgerContinuation({ seedEnvelopeB64: f.seedEnvelopeB64,
		publicKeyFile: f.publicKeyFile, expectedSpkiSha256: f.expectedSpkiSha256,
		githubToken: "synthetic-token", request,
		current: { repository: source.repository, runId: source.runId,
			runAttempt: String(source.runAttempt), actor: "SakuyaInazaki",
			event: source.event, ref: "refs/heads/improve/workflow-learning-reliability",
			sha: source.commit, manualAuthorized: "true" },
		loadCarryArtifact: async () => { throw Error("synthetic prior carry not used"); } });
}

async function sealedCarry(f: Awaited<ReturnType<typeof fixture>>) {
	const opened = await openCarry(f);
	const carry = opened.sealCurrent({ settledCny: 0, unknownObservedCny: 0,
		unpricedRequestCount: 0, requestAudit: { version: 3,
			kind: "accounting-only-request-audit", requests: [], settledCny: 0,
			unknownObservedCny: 0, unpricedRequestCount: 0 } });
	return { opened, carry };
}


async function writeAuthenticatedCurrentPrefix(f: Awaited<ReturnType<typeof fixture>>,
	opened: Awaited<ReturnType<typeof sealedCarry>>["opened"],
	objectiveCheckpointJson?: string) {
	const source = opened.incrementalControlSource;
	const journal = opened.createIncrementalControlJournal(f.outputDir);
	await journal.record("initial", { requestAudit: { version: 3,
		kind: "accounting-only-request-audit", requests: [], settledCny: 0,
		unknownObservedCny: 0, unpricedRequestCount: 0 },
		hostEffects: { version: 1, kind: "host-effect-prefix-observation",
			complete: false, selectionAuthority: false,
			source: { runId: source.runId, runAttempt: source.runAttempt, commit: source.commit },
			priorEnvelopeSha256: source.priorEnvelopeSha256,
			historicalGoalRunIds: [], goals: [], sessions: [], requestIds: [] },
		...(objectiveCheckpointJson ? { objectiveCheckpointJson } : {}) });
	return readFile(path.join(f.outputDir, INCREMENTAL_CHECKPOINT_FILE));
}





test("authenticated current carry publishes chunk first and sealed manifest last", async t => {
	const f = await fixture(t);
	const { opened, carry } = await sealedCarry(f);
	const original: Record<string, Buffer> = {
		"ledger-continuation.enc.json": Buffer.from(`${JSON.stringify({ envelopeB64: carry.envelopeB64 })}\n`),
		...Object.fromEntries(Object.entries(carry.sidecars).map(([name, text]) =>
			[name, Buffer.from(text)])),
		"incremental-control-prefix.json": await writeAuthenticatedCurrentPrefix(f, opened),
	};
	assert.ok(Object.keys(carry.sidecars).length > 0);
	for (const [name, bytes] of Object.entries(original))
		await writeFile(path.join(f.outputDir, name), bytes, { mode: 0o600 });
	const calls: Array<{ name: string; fileName: string; bytes: Buffer; retentionDays: number }> = [];
	const client = { async uploadArtifact(name: string, files: string[], _root: string,
		options: { retentionDays: number }) {
		assert.equal(files.length, 1);
		const bytes = await readFile(files[0]);
		calls.push({ name, fileName: path.basename(files[0]), bytes,
			retentionDays: options.retentionDays });
		return { id: 500 + calls.length, digest: `sha256:${sha(bytes)}` }; } };
	const result = await uploadFinalCarry({ env: f.env, artifactClient: client,
		publicKeyFile: f.publicKeyFile, expectedSpkiSha256: f.expectedSpkiSha256 });
	assert.deepEqual(result, { multipart: true, partCount: 1, rootArtifactId: 502 });
	assert.deepEqual(calls.map(call => call.name),
		["confidential-mission-carry-part-00000000", "confidential-mission-carry"]);
	assert.deepEqual(calls.map(call => call.fileName),
		["private-artifact.part-00000000.bin", ARTIFACT_PARTITION_MANIFEST_FILE]);
	assert.deepEqual(calls.map(call => call.retentionDays), [1, 1]);
	assert.ok(!calls[1].bytes.includes(original["ledger-continuation.enc.json"]));
	assert.ok(!calls[1].bytes.includes(Buffer.from("archiveSha256")));
	const seed = await authenticateSignedMissionSeed({ envelopeB64: f.seedEnvelopeB64,
		publicKeyFile: f.publicKeyFile, expectedSpkiSha256: f.expectedSpkiSha256 });
	const manifest = openPartitionManifest({ raw: calls[1].bytes.toString("utf8"),
		missionKey: seed.derivePrivateKey("mul-pis-ledger-continuation-v1"),
		seedDigest: seed.seedDigest, expectedSource: source,
		expectedArtifactName: "confidential-mission-carry" });
	assert.equal(manifest.chunks[0].archiveSha256, sha(calls[0].bytes));
	const restored = restorePartitionFiles(manifest, [calls[0].bytes], source,
		"confidential-mission-carry");
	assert.deepEqual(Object.keys(restored).sort(), Object.keys(original).sort());
	for (const [name, bytes] of Object.entries(original)) assert.deepEqual(restored[name], bytes);
});

test("missing part and ambiguous upload never publish a root manifest", async t => {
	const f = await fixture(t);
	const { carry } = await sealedCarry(f);
	const sidecars = Object.entries(carry.sidecars);
	assert.equal(sidecars.length, 1);
	await writeFile(path.join(f.outputDir, "ledger-continuation.enc.json"),
		`${JSON.stringify({ envelopeB64: carry.envelopeB64 })}\n`, { mode: 0o600 });
	await writeFile(path.join(f.outputDir, "ledger-continuation.part-00000001.enc"),
		sidecars[0][1], { mode: 0o600 });
	let attempts = 0;
	const client = { async uploadArtifact() { attempts++; return { id: 41, digest: "a".repeat(64) }; } };
	await assert.rejects(uploadFinalCarry({ env: f.env, artifactClient: client,
		publicKeyFile: f.publicKeyFile, expectedSpkiSha256: f.expectedSpkiSha256 }),
		/incomplete/);
	assert.equal(attempts, 0);
	await rm(path.join(f.outputDir, "ledger-continuation.part-00000001.enc"));
	await writeFile(path.join(f.outputDir, "ledger-continuation.part-00000000.enc"),
		sidecars[0][1], { mode: 0o600 });
	const names: string[] = [];
	await assert.rejects(uploadFinalCarry({ env: f.env,
		artifactClient: { async uploadArtifact(name: string) {
			names.push(name); throw Error("ambiguous backend reply with PRIVATE-CONTENT"); } },
		publicKeyFile: f.publicKeyFile, expectedSpkiSha256: f.expectedSpkiSha256 }),
		/ambiguous backend/);
	assert.deepEqual(names, ["confidential-mission-carry-part-00000000"]);
	assert.equal(attempts, 0);
	names.length = 0;
	await assert.rejects(uploadFinalCarry({ env: f.env,
		artifactClient: { async uploadArtifact(name: string) {
			names.push(name); return { id: 42, digest: "a".repeat(63) }; } },
		publicKeyFile: f.publicKeyFile, expectedSpkiSha256: f.expectedSpkiSha256 }),
		/result is incomplete/);
	assert.deepEqual(names, ["confidential-mission-carry-part-00000000"]);
});

for (const altered of ["root", "sidecar", "prefix"] as const) test(
	`tampered ${altered} ciphertext is rejected before any artifact upload`, async t => {
	const f = await fixture(t);
	const { opened, carry } = await sealedCarry(f);
	let rootEnvelope = carry.envelopeB64;
	if (altered === "root") {
		const outer = JSON.parse(Buffer.from(rootEnvelope, "base64").toString("utf8"));
		outer.tag = `${outer.tag[0] === "A" ? "B" : "A"}${outer.tag.slice(1)}`;
		rootEnvelope = Buffer.from(JSON.stringify(outer)).toString("base64");
	}
	await writeFile(path.join(f.outputDir, "ledger-continuation.enc.json"),
		`${JSON.stringify({ envelopeB64: rootEnvelope })}\n`, { mode: 0o600 });
	for (const [name, text] of Object.entries(carry.sidecars)) {
		let next = text;
		if (altered === "sidecar" && name.endsWith("00000000.enc")) {
			const bytes = Buffer.from(text, "base64");
			bytes[12] ^= 1;
			next = bytes.toString("base64");
		}
		await writeFile(path.join(f.outputDir, name), next, { mode: 0o600 });
	}
	if (altered === "prefix") {
		const raw = JSON.parse((await writeAuthenticatedCurrentPrefix(f, opened)).toString("utf8"));
		const envelope = raw.incrementalControlEnvelope;
		envelope.tagB64 = `${envelope.tagB64[0] === "A" ? "B" : "A"}` +
			envelope.tagB64.slice(1);
		await writeFile(path.join(f.outputDir, INCREMENTAL_CHECKPOINT_FILE),
			`${JSON.stringify(raw)}\n`, { mode: 0o600 });
	}
	let attempts = 0;
	await assert.rejects(uploadFinalCarry({ env: f.env,
		artifactClient: { async uploadArtifact() { attempts++; return { id: 41 }; } },
		publicKeyFile: f.publicKeyFile, expectedSpkiSha256: f.expectedSpkiSha256 }));
	assert.equal(attempts, 0);
});
