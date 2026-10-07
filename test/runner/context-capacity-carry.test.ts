import assert from "node:assert/strict";
import { constants, createCipheriv, createDecipheriv, createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { deflateRawSync } from "node:zlib";
import { CARRY_ARTIFACT_NAME, openLedgerContinuation,
	type AccountingOnlyRequestAuditSnapshot } from "../../src/runner/ledger-continuation.ts";
import { authenticateSignedMissionSeed, MISSION_ARTIFACT, MISSION_ID, MISSION_REPOSITORY,
	MISSION_TOTAL_CNY } from "../../src/runner/signed-mission-ledger.ts";

const sha = (letter: string) => letter.repeat(40);
const firstSource = { runId: "7002", runAttempt: 1, runNumber: 2, commit: sha("b") };
const proof = { contextWindow: 128, messagesTokens: 90, completionTokens: 64,
	requestedTokens: 154, allowedCompletionTokens: 38 };
const requestAudit: AccountingOnlyRequestAuditSnapshot = {
	version: 3, kind: "accounting-only-request-audit",
	requests: [
		{ requestId: "rejected-http-400", sessionId: "a".repeat(64), inputPayloadBytes: 240,
			maxOutputTokens: 64, status: "unknown", responseReceived: true,
			contextRejected: true, contextOverflow: proof,
			settledCny: null, unknownObservedCny: null, reportedUsage: null },
		{ requestId: "corrected-retry", sessionId: "a".repeat(64), inputPayloadBytes: 240,
			maxOutputTokens: 38, retryOfRequestId: "rejected-http-400",
			status: "unknown", responseReceived: true,
			settledCny: null, unknownObservedCny: null,
			reportedUsage: { input: 11, output: 3, cacheRead: 0, cacheWrite: 0,
				totalTokens: 14, reportedUsdCost: 0.00001, costStatus: "priced" } },
	], settledCny: 0, unknownObservedCny: 0, unpricedRequestCount: 2,
};

function run(id: number, number: number, status: string, commit: string, conclusion?: string) {
	return { id, run_number: number, run_attempt: 1, workflow_id: 91,
		status, conclusion, head_branch: "improve/workflow-learning-reliability", head_sha: commit,
		event: "workflow_dispatch", actor: { login: "SakuyaInazaki" } };
}
const anchor = run(7001, 1, "completed", sha("a"), "success");
const currentRun = run(7002, 2, "in_progress", sha("b"));
const completedRun = run(7002, 2, "completed", sha("b"), "failure");
const nextRun = run(7003, 3, "in_progress", sha("c"));
const current = (id: number, commit: string) => ({ repository: MISSION_REPOSITORY,
	runId: String(id), runAttempt: "1", actor: "SakuyaInazaki", event: "workflow_dispatch",
	ref: "refs/heads/improve/workflow-learning-reliability", sha: commit,
	manualAuthorized: "true" });

function github(runs: object[]): typeof fetch {
	return async input => {
		const url = String(input);
		let data: unknown;
		if (url.includes("/workflows/manual-private-campaign.yml/runs?"))
			data = { total_count: runs.length, workflow_runs: [...runs].reverse() };
		else if (url.endsWith("/runs/7001/artifacts?per_page=100"))
			data = { total_count: 1, artifacts: [{ id: 9001, name: MISSION_ARTIFACT,
				expired: false, workflow_run: { id: 7001 } }] };
		else if (url.endsWith("/runs/7002/artifacts?per_page=100"))
			data = { total_count: 1, artifacts: [{ id: 9002,
				name: CARRY_ARTIFACT_NAME, expired: false, workflow_run: { id: 7002 } }] };
		else if (url.endsWith("/runs/7002/jobs?per_page=100"))
			data = { total_count: 1, jobs: [{ id: 6002, run_id: 7002, run_attempt: 1,
				head_sha: sha("b"), name: "private-campaign", status: "completed", conclusion: "failure",
				steps: [{ name: "Run bounded private campaign", status: "completed", conclusion: "success" }] }] };
		else throw new Error(`unexpected synthetic request: ${url}`);
		return new Response(JSON.stringify(data), { status: 200 });
	};
}

async function fixture(t: TestContext) {
	const dir = await mkdtemp(path.join(tmpdir(), "capacity-carry-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
	const publicKeyFile = path.join(dir, "public.pem");
	await writeFile(publicKeyFile, publicKey.export({ type: "spki", format: "pem" }));
	const expectedSpkiSha256 = createHash("sha256").update(publicKey.export({ type: "spki", format: "der" })).digest("hex");
	const payload = { version: 2, kind: "mul-pis-private-mission-ledger", missionId: MISSION_ID,
		repository: MISSION_REPOSITORY, globalMaxCny: MISSION_TOTAL_CNY, priorCommittedCny: 4.125,
		revision: 1, previous: { runId: "7001", runAttempt: 1, artifactId: "9001", artifactName: MISSION_ARTIFACT },
		bootstrap: { contractId: "synthetic-contract", sourceSha256: "f".repeat(64),
			format: "deflate-raw-json-v1",
			filesB64: deflateRawSync(JSON.stringify({ "candidate.cpp": "synthetic" })).toString("base64") } };
	const bytes = Buffer.from(JSON.stringify(payload));
	const signature = sign("sha256", bytes, { key: privateKey,
		padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 });
	const seedEnvelopeB64 = Buffer.from(JSON.stringify({ payload_b64: bytes.toString("base64"),
		signature_b64: signature.toString("base64") })).toString("base64");
	return { publicKeyFile, expectedSpkiSha256, seedEnvelopeB64 };
}

test("v3 carry authenticates a context-rejected UNKNOWN transport and its accounted retry", async t => {
	const f = await fixture(t);
	const first = await openLedgerContinuation({ ...f, githubToken: "synthetic-token",
		current: current(7002, sha("b")), request: github([anchor, currentRun]),
		loadCarryArtifact: async () => "unused" });
	const seal = (audit: AccountingOnlyRequestAuditSnapshot) => first.sealCurrent({ settledCny: 0,
		unknownObservedCny: 0, unpricedRequestCount: audit.unpricedRequestCount, requestAudit: audit });
	const altered = (change: (copy: AccountingOnlyRequestAuditSnapshot) => void) => {
		const copy = structuredClone(requestAudit);
		change(copy);
		return copy;
	};
	assert.throws(() => seal(altered(a => { a.requests[0].contextOverflow!.requestedTokens = 155; })), /accounting-only carry is invalid/);
	assert.throws(() => seal(altered(a => { a.requests[1].maxOutputTokens = 37; })), /accounting-only carry is invalid/);
	assert.throws(() => seal(altered(a => { a.requests[1].retryOfRequestId = "missing"; })), /accounting-only carry is invalid/);
	assert.throws(() => seal(altered(a => { a.requests[1].sessionId = "b".repeat(64); })), /accounting-only carry is invalid/);
	assert.throws(() => seal(altered(a => {
		a.requests.push({ ...a.requests[1]!, requestId: "duplicate-successor" });
		a.unpricedRequestCount = 3;
	})), /accounting-only carry is invalid/);
	assert.throws(() => seal(altered(a => { a.requests[0].status = "settled"; a.requests[0].settledCny = 0; })), /accounting-only carry is invalid/);
	const diagnostic = first.appendTransportDiagnosticCensus(requestAudit, [{ version: 1,
		promptIndex: 1, requestId: "rejected-http-400", phase: "response-body",
		httpStatus: 400, responseStarted: true, bytesRead: 350, abortSource: null,
		providerErrorCode: null, providerErrorType: "invalid_request_error",
		providerErrorReasonClass: "context-window", providerContextOverflow: proof,
		providerRequestId: null, errorCodes: [],
		privateProviderError: { code: null, type: "invalid_request_error",
			message: "PRIVATE_SYNTHETIC_ERROR_TEXT", param: null, numericLimits: {} } }]);
	assert.ok(diagnostic);
	assert.equal(JSON.parse(diagnostic!).entries[0].rows[0].availability, "observed");
	assert.equal(JSON.parse(diagnostic!).entries[0].rows[0].providerErrorReasonClass,
		"context-window");
	assert(!diagnostic!.includes("PRIVATE_SYNTHETIC_ERROR_TEXT"));
	const sealed = first.sealCurrent({ settledCny: 0, unknownObservedCny: 0,
		unpricedRequestCount: 2, requestAudit,
		privateBundle: { ...first.priorPrivateBundle,
			"transport-diagnostics.json": diagnostic! } });
	assert.equal(sealed.unpricedRequestCount, 2);
	const seed = await authenticateSignedMissionSeed({ ...f, envelopeB64: f.seedEnvelopeB64 });
	const key = seed.derivePrivateKey("mul-pis-ledger-continuation-v1");
	const outer = JSON.parse(Buffer.from(sealed.envelopeB64, "base64").toString("utf8")) as {
		version: number; parentDigest: string; nonce: string; ciphertext: string; tag: string };
	const aad = Buffer.from(JSON.stringify([MISSION_ID, MISSION_REPOSITORY, seed.seedDigest,
		3, seed.seedDigest, firstSource]));
	const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(outer.nonce, "base64"));
	decipher.setAAD(aad);
	decipher.setAuthTag(Buffer.from(outer.tag, "base64"));
	const plaintext = Buffer.concat([decipher.update(Buffer.from(outer.ciphertext, "base64")), decipher.final()]);
	const checkpoint = JSON.parse(plaintext.toString("utf8")) as {
		requestAudit: AccountingOnlyRequestAuditSnapshot };
	assert.deepEqual(checkpoint.requestAudit.requests, requestAudit.requests);
	const reopen = (envelopeB64: string) => openLedgerContinuation({ ...f,
		githubToken: "synthetic-token", current: current(7003, sha("c")),
		request: github([anchor, completedRun, nextRun]), loadCarryArtifact: async () => envelopeB64 });
	const resumed = await reopen(sealed.envelopeB64);
	assert.equal(resumed.priorUnpricedRequestCount, 2);
	assert.equal(resumed.priorSettledCny, 0);
	assert.equal(resumed.priorTransportDiagnosticCensus?.entries[0].rows[0].availability,
		"observed");
	const tamper = (change: (copy: AccountingOnlyRequestAuditSnapshot) => void): string => {
		const copy = structuredClone(checkpoint);
		change(copy.requestAudit);
		const nonce = randomBytes(12);
		const cipher = createCipheriv("aes-256-gcm", key, nonce);
		cipher.setAAD(aad);
		const ciphertext = Buffer.concat([cipher.update(JSON.stringify(copy)), cipher.final()]);
		return Buffer.from(JSON.stringify({ ...outer, nonce: nonce.toString("base64"),
			ciphertext: ciphertext.toString("base64"), tag: cipher.getAuthTag().toString("base64") })).toString("base64");
	};
	await assert.rejects(reopen(tamper(a => { a.requests[0].contextOverflow!.allowedCompletionTokens = 37; })), /accounting|retry/);
	await assert.rejects(reopen(tamper(a => { a.requests[1].maxOutputTokens = 37; })), /accounting|retry/);
	await assert.rejects(reopen(tamper(a => { a.requests[1].retryOfRequestId = "missing"; })), /accounting|retry/);
	await assert.rejects(reopen(tamper(a => { a.requests[1].sessionId = "b".repeat(64); })), /accounting|retry/);
	await assert.rejects(reopen(tamper(a => { a.requests[0].status = "settled"; a.requests[0].settledCny = 0; })), /accounting|retry/);
});
