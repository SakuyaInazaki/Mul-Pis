import assert from "node:assert/strict";
import { createCipheriv, createDecipheriv, createHash, generateKeyPairSync, randomBytes, sign, constants } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { deflateRawSync } from "node:zlib";
import test, { type TestContext } from "node:test";
import  {
	authenticatedAccountingObservation,
	authenticatedHistoricalOpaqueRunGaps,
	authenticatedPendingHistoricalEffectSources,
	authenticatedSelectedTransitions,
	authenticatedPriorCarryBindsBundle,
	isAuthenticatedPredecessorResearchHistory,
	CARRY_ARTIFACT_NAME,
	openLedgerContinuation,
	sealHistoricalCarryForOfflineTests
}  from "../src/runner/ledger-continuation.ts";
import type { RequestAuditSnapshot } from "../src/runner/ledger-continuation.ts";
import { campaignSessionEffectId } from "../src/runner/deepseek-campaign.ts";
import { offlineChecks } from "../scripts/manual-private-campaign.ts";
import { verifyDeepSeekCnyBilling, nativeCnyPricingRecord } from "../src/runner/deepseek-cny-pricing.ts";
import { authenticateSignedMissionSeed, MISSION_ARTIFACT, MISSION_ID, MISSION_REPOSITORY, MISSION_TOTAL_CNY } from "../src/runner/signed-mission-ledger.ts";
import { decodeCarrySidecars, encodeCarrySidecars } from "../src/runner/carry-sidecar-codec.ts";
import { reconcileHistoricalResearchEntries } from "../src/runner/research-history-reconciliation.ts";

const sha = (letter: string) => letter.repeat(40);


test("verified restored history alone survives emergency carry and next reopen", async t => {
	const f = await fixture(t);
	const seedEnvelopeB64 = attestedSeed(f);
	const zeroAudit = { version: 3 as const, kind: "accounting-only-request-audit" as const,
		requests: [], settledCny: 0, unknownObservedCny: 0, unpricedRequestCount: 0 };
	const older = { version: 1, kind: "untrusted-version-bound-research-history",
		entries: [{ goalRunId: "old-goal", taskId: "T001", originalContractId: "old-contract",
			files: Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`old-file-${i}.txt`, `old-${i}`])) }] };
	const currentHistory = { version: 1, kind: "untrusted-version-bound-research-history",
		entries: [{ goalRunId: "new-goal", taskId: "T002", originalContractId: "new-contract",
			files: { "candidate.cpp": "new source", "verification.json": "{}",
				"experiment-plan.json": "{}", "workflow-archive.json": "{}",
				"lesson-delta.json": "{}", "execution-capabilities.json": "{}" } }] };
	const firstOpening = await openLedgerContinuation({ ...f, seedEnvelopeB64,
		githubToken: "synthetic-token", current: current(7002, sha("b")),
		request: github([anchor, first]), loadCarryArtifact: async () => "unused" });
	const firstCarry = firstOpening.sealCurrent({ settledCny: 0, unknownObservedCny: 0,
		unpricedRequestCount: 0, requestAudit: zeroAudit,
		privateBundle: { ...firstOpening.priorPrivateBundle!, "research-history.json": JSON.stringify(older) } });
	const firstDone = { ...first, status: "completed", conclusion: "success" };
	const secondRun = run(7003, 3, "in_progress", sha("c"));
	const secondOpening = await openLedgerContinuation({ ...f, seedEnvelopeB64,
		githubToken: "synthetic-token", current: current(7003, sha("c")),
		request: github([anchor, firstDone, secondRun]), loadCarryArtifact: async () => firstCarry });
	const secondCarry = secondOpening.sealCurrent({ settledCny: 0, unknownObservedCny: 0,
		unpricedRequestCount: 0, requestAudit: zeroAudit,
		privateBundle: { ...secondOpening.priorPrivateBundle!,
			"research-history.json": JSON.stringify(currentHistory) } });
	const secondDone = { ...secondRun, status: "completed", conclusion: "success" };
	const thirdRun = run(7004, 4, "in_progress", sha("d"));
	const base = github([anchor, firstDone, secondDone, thirdRun]);
	let predecessorExpired = false;
	const request: typeof fetch = (url, init) => {
		const address = String(url);
		if (address.includes("/runs/7002/artifacts?"))
			return Promise.resolve(new Response(JSON.stringify({ total_count: 1, artifacts: [{
				id: 9002, name: CARRY_ARTIFACT_NAME, expired: predecessorExpired,
				workflow_run: { id: 7002, head_sha: sha("b") } }] })));
		if (address.includes("/runs/7003/artifacts?"))
			return Promise.resolve(new Response(JSON.stringify({ total_count: 1, artifacts: [{
				id: 9003, name: CARRY_ARTIFACT_NAME, expired: false,
				workflow_run: { id: 7003, head_sha: sha("c") } }] })));
		if (address.includes("/runs/7003/jobs?"))
			return Promise.resolve(new Response(JSON.stringify({ total_count: 1, jobs: [{ id: 6003,
				run_id: 7003, run_attempt: 1, head_sha: sha("c"), name: "private-campaign",
				status: "completed", conclusion: "success", steps: [{ name: "Run bounded private campaign",
					status: "completed", conclusion: "success" }] }] })));
		return base(url, init);
	};
	const openThird = () => openLedgerContinuation({ ...f, seedEnvelopeB64,
		githubToken: "synthetic-token", current: current(7004, sha("d")), request,
		loadCarryArtifact: async ({ runId }) => runId === "7002" ? firstCarry : secondCarry });
	const third = await openThird();
	const predecessor = await third.recoverImmediatePredecessorResearchHistory();
	assert(isAuthenticatedPredecessorResearchHistory(predecessor));
	assert.equal(predecessor.artifact.artifactId, "9002");
	const entries = reconcileHistoricalResearchEntries(currentHistory.entries, older.entries);
	const interim = JSON.stringify({ ...currentHistory, entries });
	const finalHistoryText = JSON.stringify({ ...currentHistory, entries,
		predecessorHistoryReconciliation: { version: 2,
			kind: "authenticated-predecessor-history-reconciled",
			source: predecessor.source, envelopeSha256: predecessor.envelopeSha256,
			entriesSha256: createHash("sha256").update(JSON.stringify(entries)).digest("hex"),
			selectedTransitionsSha256: createHash("sha256").update(JSON.stringify(
				authenticatedSelectedTransitions(third.priorCarryProof, third.priorPrivateBundle) ?? []))
				.digest("hex") } });
	const steps = [{ predecessor, resultingHistoryText: interim }];
	assert.throws(() => third.attestEmergencyRestoredResearchHistory({
		originalBundle: third.priorPrivateBundle!, steps: [{ predecessor: { ...predecessor },
			resultingHistoryText: interim }], finalHistoryText }), /exact predecessor proof/);
	assert.throws(() => third.attestEmergencyRestoredResearchHistory({
		originalBundle: third.priorPrivateBundle!, steps,
		finalHistoryText: `${finalHistoryText} forged` }), /differs from verified walk/);
	const receipt = third.attestEmergencyRestoredResearchHistory({
		originalBundle: third.priorPrivateBundle!, steps, finalHistoryText });
	const ordinaryRecovered = await openThird();
	const ordinaryPredecessor = await ordinaryRecovered.recoverImmediatePredecessorResearchHistory();
	assert(isAuthenticatedPredecessorResearchHistory(ordinaryPredecessor));
	const ordinarySteps = [{ predecessor: ordinaryPredecessor,
		resultingHistoryText: JSON.stringify({ ...currentHistory, entries }) }];
	const ordinaryFinal = JSON.stringify({ ...currentHistory, entries,
		predecessorHistoryReconciliation: { version: 2,
			kind: "authenticated-predecessor-history-reconciled",
			source: ordinaryPredecessor.source,
			envelopeSha256: ordinaryPredecessor.envelopeSha256,
			entriesSha256: createHash("sha256").update(JSON.stringify(entries)).digest("hex"),
			selectedTransitionsSha256: createHash("sha256").update("[]").digest("hex") } });
	const ordinaryReceipt = ordinaryRecovered.attestEmergencyRestoredResearchHistory({
		originalBundle: ordinaryRecovered.priorPrivateBundle!, steps: ordinarySteps,
		finalHistoryText: ordinaryFinal });
	assert.throws(() => ordinaryRecovered.sealCurrent({ settledCny: 0, unknownObservedCny: 0,
		unpricedRequestCount: 0, requestAudit: zeroAudit,
		privateBundle: { ...ordinaryRecovered.priorPrivateBundle!,
			"research-history.json": ordinaryFinal } }),
		/new v2 research history marker lacks exact verified recovery receipt/);
	const ordinarySealed = ordinaryRecovered.sealCurrent({ settledCny: 0, unknownObservedCny: 0,
		unpricedRequestCount: 0, requestAudit: zeroAudit,
		privateBundle: { ...ordinaryRecovered.priorPrivateBundle!,
			"research-history.json": ordinaryFinal } }, ordinaryReceipt);
	assert.ok(ordinarySealed.envelopeB64);
	assert.throws(() => third.sealEmergencyCurrent({ settledCny: 0, unknownObservedCny: 0,
		unpricedRequestCount: 0, requestAudit: zeroAudit,
		privateBundle: { ...third.priorPrivateBundle!, "research-history.json": "forged" } },
		"effect-review-incomplete", receipt), /exact verified receipt/);
	const emergency = third.sealEmergencyCurrent({ settledCny: 0, unknownObservedCny: 0,
		unpricedRequestCount: 0, requestAudit: zeroAudit,
		privateBundle: { ...third.priorPrivateBundle!, "candidate.cpp": "forged selection" } },
		"effect-review-incomplete", receipt);
	const seed = await authenticateSignedMissionSeed({ ...f, envelopeB64: seedEnvelopeB64 });
	const decoded = decodeV4Checkpoint(emergency, seed.seedDigest,
		seed.derivePrivateKey("mul-pis-ledger-continuation-v1"),
		{ runId: "7004", runAttempt: 1, runNumber: 4, commit: sha("d") });
	assert.equal(decoded.privateBundle["research-history.json"], finalHistoryText);
	assert.equal(decoded.privateBundle["candidate.cpp"], third.priorPrivateBundle!["candidate.cpp"]);
	assert.equal(decoded.currentEffectReview, "pending");
	const ordinary = await openThird();
	const ordinaryEmergency = ordinary.sealEmergencyCurrent({ settledCny: 0, unknownObservedCny: 0,
		unpricedRequestCount: 0, requestAudit: zeroAudit,
		privateBundle: { ...ordinary.priorPrivateBundle!, "research-history.json": finalHistoryText } },
		"effect-review-incomplete");
	const oldDecoded = decodeV4Checkpoint(ordinaryEmergency, seed.seedDigest,
		seed.derivePrivateKey("mul-pis-ledger-continuation-v1"),
		{ runId: "7004", runAttempt: 1, runNumber: 4, commit: sha("d") });
	assert.equal(oldDecoded.privateBundle["research-history.json"], JSON.stringify(currentHistory));
	predecessorExpired = true;
	const incomplete = await openThird();
	const unavailable = await incomplete.recoverImmediatePredecessorResearchHistory();
	assert.equal(unavailable.kind, "predecessor-research-history-unavailable");
	if (unavailable.kind !== "predecessor-research-history-unavailable" ||
		!unavailable.predecessor) return;
	const unverifiedHistoryText = JSON.stringify({ ...currentHistory,
		predecessorHistoryReconciliation: { version: 2,
			kind: "historical-completeness-unverified",
			source: unavailable.predecessor.source,
			envelopeSha256: unavailable.predecessor.envelopeSha256,
			reason: unavailable.reason,
			entriesSha256: createHash("sha256").update(JSON.stringify(currentHistory.entries)).digest("hex"),
			selectedTransitionsSha256: createHash("sha256").update(JSON.stringify(
				authenticatedSelectedTransitions(incomplete.priorCarryProof, incomplete.priorPrivateBundle) ?? []))
				.digest("hex") } });
	assert.throws(() => incomplete.attestEmergencyRestoredResearchHistory({
		originalBundle: incomplete.priorPrivateBundle!, steps: [],
		unavailable: { ...unavailable }, finalHistoryText: unverifiedHistoryText }),
		/unavailable history lacks/);
	const incompleteReceipt = incomplete.attestEmergencyRestoredResearchHistory({
		originalBundle: incomplete.priorPrivateBundle!, steps: [], unavailable,
		finalHistoryText: unverifiedHistoryText });
	const incompleteCarry = incomplete.sealEmergencyCurrent({ settledCny: 0,
		unknownObservedCny: 0, unpricedRequestCount: 0, requestAudit: zeroAudit },
		"effect-review-incomplete", incompleteReceipt);
	const incompleteDecoded = decodeV4Checkpoint(incompleteCarry, seed.seedDigest,
		seed.derivePrivateKey("mul-pis-ledger-continuation-v1"),
		{ runId: "7004", runAttempt: 1, runNumber: 4, commit: sha("d") });
	assert.equal(incompleteDecoded.privateBundle["research-history.json"], unverifiedHistoryText);
	predecessorExpired = false;
	const thirdDone = { ...thirdRun, status: "completed", conclusion: "failure" };
	const fourthRun = run(7005, 5, "in_progress", sha("e"));
	const fourthBase = github([anchor, firstDone, secondDone, thirdDone, fourthRun]);
	const fourthRequest: typeof fetch = (url, init) => {
		const address = String(url);
		if (address.includes("/workflows/manual-private-campaign.yml/runs?"))
			return fourthBase(url, init);
		if (address.includes("/runs/7004/artifacts?"))
			return Promise.resolve(new Response(JSON.stringify({ total_count: 1, artifacts: [{
				id: 9004, name: CARRY_ARTIFACT_NAME, expired: false,
				workflow_run: { id: 7004, head_sha: sha("d") } }] })));
		if (address.includes("/runs/7004/jobs?"))
			return Promise.resolve(new Response(JSON.stringify({ total_count: 1, jobs: [{ id: 6004,
				run_id: 7004, run_attempt: 1, head_sha: sha("d"), name: "private-campaign",
				status: "completed", conclusion: "failure", steps: [{ name: "Run bounded private campaign",
					status: "completed", conclusion: "failure" }] }] })));
		return request(url, init);
	};
	const reopened = await openLedgerContinuation({ ...f, seedEnvelopeB64,
		githubToken: "synthetic-token", current: current(7005, sha("e")), request: fourthRequest,
		loadCarryArtifact: async () => emergency });
	assert.equal(reopened.priorPrivateBundle?.["research-history.json"], finalHistoryText);
	assert.equal(reopened.priorPrivateBundle?.["candidate.cpp"], third.priorPrivateBundle!["candidate.cpp"]);
	assert.deepEqual(reopened.priorRunControlObservation, {
		source: { runId: "7004", runAttempt: 1, runNumber: 4, commit: sha("d") },
		requestCount: 0, responseReceivedCount: 0, unknownCount: 0,
		currentEffectReviewPending: true, selectionAuthority: false, complete: false });
	assert.equal(authenticatedPriorCarryBindsBundle(reopened.priorCarryProof,
		reopened.priorPrivateBundle), true);
	predecessorExpired = true;
	const secondEmergency = reopened.sealEmergencyCurrent({ settledCny: 0,
		unknownObservedCny: 0, unpricedRequestCount: 0, requestAudit: zeroAudit },
		"effect-review-incomplete");
	const fourthDone = { ...fourthRun, status: "completed", conclusion: "failure" };
	const fifthRun = run(7006, 6, "in_progress", sha("f"));
	const fifthBase = github([anchor, firstDone, secondDone, thirdDone, fourthDone, fifthRun]);
	const fifthRequest: typeof fetch = (url, init) => {
		const address = String(url);
		if (address.includes("/workflows/manual-private-campaign.yml/runs?"))
			return fifthBase(url, init);
		if (address.includes("/runs/7005/artifacts?"))
			return Promise.resolve(new Response(JSON.stringify({ total_count: 1, artifacts: [{
				id: 9005, name: CARRY_ARTIFACT_NAME, expired: false,
				workflow_run: { id: 7005, head_sha: sha("e") } }] })));
		if (address.includes("/runs/7005/jobs?"))
			return Promise.resolve(new Response(JSON.stringify({ total_count: 1, jobs: [{ id: 6005,
				run_id: 7005, run_attempt: 1, head_sha: sha("e"), name: "private-campaign",
				status: "completed", conclusion: "failure", steps: [{ name: "Run bounded private campaign",
					status: "completed", conclusion: "failure" }] }] })));
		return fourthRequest(url, init);
	};
	const collectionDir = path.join(path.dirname(f.publicKeyFile), "unselected-collection");
	await mkdir(collectionDir);
	const newUnselectedEntry = { goalRunId: "unselected-goal", taskId: "T003",
		originalContractId: "unselected-contract", files: { "workflow-archive.json": JSON.stringify({
			version: 1, kind: "m07-private-candidate-archive",
			goalRunId: "unselected-goal", taskId: "T003" }) } };
	await writeFile(path.join(collectionDir, "research-history.json"), JSON.stringify({
		...JSON.parse(finalHistoryText), entries: [...JSON.parse(finalHistoryText).entries,
			newUnselectedEntry] }));
	const collected = await offlineChecks.collectContinuationBundle(collectionDir,
		reopened.priorPrivateBundle!);
	assert(collected);
	const collectedHistory = JSON.parse(collected["research-history.json"]!);
	assert.equal(collectedHistory.predecessorHistoryReconciliation, undefined,
		"a new unselected entry retires the covered v2 marker");
	assert.equal(collectedHistory.entries[1].files["old-file-9.txt"], "old-9");
	assert.equal(collectedHistory.entries[2].goalRunId, "unselected-goal");
	const appendedOpening = await openLedgerContinuation({ ...f, seedEnvelopeB64,
		githubToken: "synthetic-token", current: current(7005, sha("e")), request: fourthRequest,
		loadCarryArtifact: async () => emergency });
	const appendedCarry = appendedOpening.sealCurrent({ settledCny: 0,
		unknownObservedCny: 0, unpricedRequestCount: 0, requestAudit: zeroAudit,
		privateBundle: collected });
	const appendedReopened = await openLedgerContinuation({ ...f, seedEnvelopeB64,
		githubToken: "synthetic-token", current: current(7006, sha("f")), request: fifthRequest,
		loadCarryArtifact: async () => appendedCarry });
	const appendedHistory = JSON.parse(appendedReopened.priorPrivateBundle!["research-history.json"]!);
	assert.equal(appendedHistory.entries.length, 3);
	assert.equal(appendedHistory.entries[1].files["old-file-9.txt"], "old-9");
	assert.equal(appendedHistory.entries[2].goalRunId, "unselected-goal");
	assert.equal(appendedReopened.priorPrivateBundle?.["candidate.cpp"],
		reopened.priorPrivateBundle!["candidate.cpp"]);
	assert.equal(appendedReopened.priorUnpricedRequestCount, reopened.priorUnpricedRequestCount);
	const twiceReopened = await openLedgerContinuation({ ...f, seedEnvelopeB64,
		githubToken: "synthetic-token", current: current(7006, sha("f")), request: fifthRequest,
		loadCarryArtifact: async () => secondEmergency });
	const retained = JSON.parse(twiceReopened.priorPrivateBundle!["research-history.json"]!);
	assert.equal(retained.entries.length, 2);
	assert.equal(retained.entries[1].files["old-file-9.txt"], "old-9");
	assert.equal(twiceReopened.priorPrivateBundle?.["candidate.cpp"],
		third.priorPrivateBundle!["candidate.cpp"]);
	assert.equal(twiceReopened.priorUnpricedRequestCount, reopened.priorUnpricedRequestCount);
	assert.equal(await offlineChecks.recoverAuthenticatedHistoricalVersions(twiceReopened,
		twiceReopened.priorPrivateBundle!), twiceReopened.priorPrivateBundle,
		"a current v2 marker preserves restored bytes after the older archive expires");
	predecessorExpired = false;
	const skippedOpening = await openLedgerContinuation({ ...f, seedEnvelopeB64,
		githubToken: "synthetic-token", current: current(7005, sha("e")), request: fourthRequest,
		loadCarryArtifact: async ({ runId }) => runId === "7002" ? firstCarry : ordinaryEmergency });
	const skipped = await skippedOpening.recoverImmediatePredecessorResearchHistory({
		source: predecessor.source, envelopeSha256: predecessor.envelopeSha256 });
	assert(isAuthenticatedPredecessorResearchHistory(skipped));
	assert.throws(() => skippedOpening.attestEmergencyRestoredResearchHistory({
		originalBundle: skippedOpening.priorPrivateBundle!,
		steps: [{ predecessor: skipped, resultingHistoryText: interim }],
		finalHistoryText }), /adjacent|exact predecessor proof/,
	"an older branded artifact cannot hide an available intermediate ancestry hop");
	const staleMarkerHistory = { ...currentHistory, predecessorHistoryReconciliation: {
		version: 2, kind: "authenticated-predecessor-history-reconciled",
		source: { runId: "7003", runAttempt: 1, runNumber: 3, commit: sha("c") },
		envelopeSha256: createHash("sha256").update(Buffer.from(secondCarry.envelopeB64,
			"base64")).digest("hex"),
		entriesSha256: createHash("sha256").update(JSON.stringify(currentHistory.entries)).digest("hex"),
		selectedTransitionsSha256: "f".repeat(64) } };
	const staleThird = await openThird();
	assert.throws(() => staleThird.sealCurrent({ settledCny: 0, unknownObservedCny: 0,
		unpricedRequestCount: 0, requestAudit: zeroAudit,
		privateBundle: { ...staleThird.priorPrivateBundle!,
			"research-history.json": JSON.stringify(staleMarkerHistory) } }),
		/new v2 research history marker lacks exact verified recovery receipt/,
	"ordinary sealing cannot authenticate a forged selected-transition frontier marker");
});

function decodeV4Checkpoint(carry: { envelopeB64: string; sidecars: Readonly<Record<string, string>> },
	seedDigest: string, key: Buffer, source: { runId: string; runAttempt: number;
		runNumber: number; commit: string }): Record<string, any> {
	const outer = JSON.parse(Buffer.from(carry.envelopeB64, "base64").toString("utf8"));
	assert.equal(outer.version, 4);
	const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(outer.nonce, "base64"));
	decipher.setAAD(Buffer.from(JSON.stringify([MISSION_ID, MISSION_REPOSITORY, seedDigest,
		4, outer.parentDigest, source])));
	decipher.setAuthTag(Buffer.from(outer.tag, "base64"));
	const manifest = JSON.parse(Buffer.concat([decipher.update(Buffer.from(outer.ciphertext, "base64")),
		decipher.final()]).toString("utf8"));
	const bytes = decodeCarrySidecars({ manifest, key, seedDigest,
		parentDigest: outer.parentDigest, source,
		load: name => Buffer.from(carry.sidecars[name]!, "base64") });
	return JSON.parse(bytes.toString("utf8"));
}
function resealV4Checkpoint(checkpoint: Record<string, any>, seedDigest: string,
	key: Buffer, source: { runId: string; runAttempt: number; runNumber: number; commit: string }) {
	const encoded = encodeCarrySidecars({ plaintext: Buffer.from(JSON.stringify(checkpoint)),
		key, seedDigest, parentDigest: checkpoint.parentDigest, source });
	const nonce = randomBytes(12);
	const cipher = createCipheriv("aes-256-gcm", key, nonce);
	cipher.setAAD(Buffer.from(JSON.stringify([MISSION_ID, MISSION_REPOSITORY, seedDigest,
		4, checkpoint.parentDigest, source])));
	const ciphertext = Buffer.concat([cipher.update(JSON.stringify(encoded.manifest)), cipher.final()]);
	return { envelopeB64: Buffer.from(JSON.stringify({ version: 4,
		parentDigest: checkpoint.parentDigest, nonce: nonce.toString("base64"),
		ciphertext: ciphertext.toString("base64"), tag: cipher.getAuthTag().toString("base64") })).toString("base64"),
		sidecars: Object.fromEntries(encoded.sidecars.map(part =>
			[part.name, part.bytes.toString("base64")])) };
}
const run = (id: number, number: number, status: string, commit: string, conclusion?: string) => ({
	id, run_number: number, run_attempt: 1, workflow_id: 91, status, conclusion,
	head_branch: "improve/workflow-learning-reliability", head_sha: commit,
	event: "workflow_dispatch", actor: { login: "SakuyaInazaki" },
});
const anchor = run(7001, 1, "completed", sha("a"), "success");
const first = run(7002, 2, "in_progress", sha("b"));
const second = run(7003, 3, "in_progress", sha("c"));
const skipped = run(7004, 3, "completed", sha("d"), "success");
const third = run(7005, 4, "in_progress", sha("e"));
const current = (id: number, commit: string) => ({ repository: MISSION_REPOSITORY,
	runId: String(id), runAttempt: "1", actor: "SakuyaInazaki", event: "workflow_dispatch",
	ref: "refs/heads/improve/workflow-learning-reliability", sha: commit,
	manualAuthorized: "true" });
function audit(settledCny: number, unknownReservedCny: number): RequestAuditSnapshot {
	const requests: RequestAuditSnapshot["requests"] = [];
	if (settledCny) requests.push({ requestId: "synthetic-settled", inputPayloadBytes: 100,
		reservedCny: settledCny, status: "settled", settledCny, unknownHeldCny: null,
		reportedUsage: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0,
			totalTokens: 20, reportedUsdCost: 0.01, costStatus: "priced" } });
	if (unknownReservedCny) requests.push({ requestId: "synthetic-unknown", inputPayloadBytes: 100,
		reservedCny: unknownReservedCny, status: "unknown", settledCny: null,
		unknownHeldCny: unknownReservedCny, reportedUsage: null });
	return { requests, settledCny, unknownReservedCny, inFlightReservedCny: 0,
		reservations: requests.length };
}

async function fixture(t: TestContext) {
	const dir = await mkdtemp(path.join(os.tmpdir(), "continuation-test-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
	const publicKeyFile = path.join(dir, "public.pem");
	await writeFile(publicKeyFile, publicKey.export({ type: "spki", format: "pem" }));
	const expectedSpkiSha256 = createHash("sha256").update(publicKey.export({ type: "spki", format: "der" })).digest("hex");
	const payload = { version: 1, kind: "mul-pis-private-mission-ledger", missionId: MISSION_ID,
		repository: MISSION_REPOSITORY, globalMaxCny: MISSION_TOTAL_CNY, priorCommittedCny: 4.125,
		revision: 1, previous: { runId: "7001", runAttempt: 1, artifactId: "9001", artifactName: MISSION_ARTIFACT } };
	const signSeed = (value: object) => {
		const bytes = Buffer.from(JSON.stringify(value));
		const signature = sign("sha256", bytes, { key: privateKey, padding: constants.RSA_PKCS1_PSS_PADDING,
			saltLength: 32 });
		return Buffer.from(JSON.stringify({ payload_b64: bytes.toString("base64"),
			signature_b64: signature.toString("base64") })).toString("base64");
	};
	return { publicKeyFile, expectedSpkiSha256, seedEnvelopeB64: signSeed(payload), payload, signSeed };
}
function github(runs: object[], options: { missingCarry?: boolean; duplicateCarry?: boolean;
	step?: "success" | "skipped"; cancelled?: boolean } = {}) {
	const request: typeof fetch = async (url) => {
		const address = String(url);
		let data: unknown;
		if (address.includes("/workflows/manual-private-campaign.yml/runs?"))
			data = { total_count: runs.length, workflow_runs: [...runs].reverse() };
		else if (address.endsWith("/runs/7001/artifacts?per_page=100"))
			data = { total_count: 1, artifacts: [{ id: 9001, name: MISSION_ARTIFACT, expired: false,
				workflow_run: { id: 7001 } }] };
		else if (address.endsWith("/runs/7002/artifacts?per_page=100"))
			data = { total_count: options.missingCarry ? 0 : options.duplicateCarry ? 2 : 1,
				artifacts: options.missingCarry ? [] : [{ id: 9002,
				name: CARRY_ARTIFACT_NAME, expired: false, workflow_run: { id: 7002 } },
				...(options.duplicateCarry ? [{ id: 9012, name: CARRY_ARTIFACT_NAME,
					expired: false, workflow_run: { id: 7002 } }] : [])] };
		else if (address.endsWith("/runs/7002/jobs?per_page=100"))
			data = { total_count: 1, jobs: [{ id: 6002, run_id: 7002, run_attempt: 1, head_sha: sha("b"),
				name: "private-campaign", status: "completed",
				conclusion: options.cancelled ? "cancelled" : "failure",
				steps: [{ name: "Run bounded private campaign", status: "completed",
					conclusion: options.step ?? "success" }] }] };
		else if (address.endsWith("/runs/7004/jobs?per_page=100"))
			data = { total_count: 1, jobs: [{ name: "private-campaign", status: "completed", conclusion: "success",
				steps: [{ name: "Run bounded private campaign", status: "completed", conclusion: "skipped" }] }] };
		else throw Error("unexpected synthetic request");
		return new Response(JSON.stringify(data), { status: 200 });
	};
	return request;
}


test("signed seed and finished carry chain preserve the single cumulative ceiling and private bundle", async t => {
	const f = await fixture(t);
	const open1 = await openLedgerContinuation({ ...f, githubToken: "synthetic-token",
		current: current(7002, sha("b")), request: github([anchor, first]),
		loadCarryArtifact: async () => { throw Error("no carry yet"); } });
	assert.equal(open1.priorCommittedCny, 4.125);
	const sealed = sealHistoricalCarryForOfflineTests(open1, { settledCny: 1.25, unknownOrInFlightCny: 0.75,
		requestAudit: audit(1.25, 0.75),
		bootstrapBinding: { contractId: "synthetic-contract", sourceSha256: "f".repeat(64) },
		privateBundle: { "candidate.cpp": "synthetic candidate" } });
	assert.equal(sealed.carryForwardCny, 6.125);
	assert.doesNotMatch(Buffer.from(sealed.envelopeB64, "base64").toString(), /synthetic candidate/);
	const completedFirst = { ...first, status: "completed", conclusion: "failure" };
	const open2 = await openLedgerContinuation({ ...f, githubToken: "synthetic-token",
		current: current(7003, sha("c")), request: github([anchor, completedFirst, second]),
		loadCarryArtifact: async ({ artifactId }) => {
			assert.equal(artifactId, "9002"); return sealed.envelopeB64;
		} });
	assert.equal(open2.priorCommittedCny, 6.125);
	assert.equal(open2.priorUnknownHeldCny, 0.75);
	assert.deepEqual(open2.priorPrivateBundle, { "candidate.cpp": "synthetic candidate" });
	assert.deepEqual(open2.priorBootstrapBinding,
		{ contractId: "synthetic-contract", sourceSha256: "f".repeat(64) });
	const next = sealHistoricalCarryForOfflineTests(open2, { settledCny: 0, unknownOrInFlightCny: 0,
		requestAudit: audit(0, 0) });
	assert.equal(next.carryForwardCny, 6.125);
	assert.throws(() => sealHistoricalCarryForOfflineTests(open2, { settledCny: 0, unknownOrInFlightCny: 0,
		requestAudit: audit(0, 0) }), /already sealed|cannot follow/);
});


function attestedSeed(f: Awaited<ReturnType<typeof fixture>>) {
	return f.signSeed({ ...f.payload, version: 2,
		rootReviewedAnchor: { commit: sha("a"), artifactSha256: "e".repeat(64), digestScope: "encrypted-result-envelope" },
		bootstrap: { contractId: "synthetic-original", sourceSha256: "d".repeat(64), format: "deflate-raw-json-v1",
			filesB64: deflateRawSync(JSON.stringify({ "candidate.cpp": "synthetic root evidence" })).toString("base64") } });
}
async function compactedFixture(t: TestContext) {
	const f = await fixture(t);
	const seedEnvelopeB64 = attestedSeed(f);
	const firstOpened = await openLedgerContinuation({ ...f, seedEnvelopeB64, githubToken: "synthetic-token",
		current: current(7002, sha("b")), request: github([anchor, first]), loadCarryArtifact: async () => "unused" });
	const firstCarry = sealHistoricalCarryForOfflineTests(firstOpened, { settledCny: 1, unknownOrInFlightCny: 0.25, requestAudit: audit(1, 0.25) });
	const secondOpened = await openLedgerContinuation({ ...f, seedEnvelopeB64, githubToken: "synthetic-token",
		current: current(7003, sha("c")), request: github([anchor, { ...first, status: "completed", conclusion: "success" }, second]),
		loadCarryArtifact: async () => firstCarry.envelopeB64 });
	const secondCarry = sealHistoricalCarryForOfflineTests(secondOpened, { settledCny: 0.5, unknownOrInFlightCny: 0, requestAudit: audit(0.5, 0) });
	const base = github([anchor, { ...first, status: "completed", conclusion: "success" },
		{ ...second, status: "completed", conclusion: "success" }, third]);
	const request: typeof fetch = async (url, init) => {
		const address = String(url);
		if (address.includes("/runs/7001/artifacts?") || address.includes("/runs/7002/artifacts?"))
			throw new Error("expired ancestor artifact must not be requested");
		if (address.includes("/runs/7003/jobs?")) return new Response(JSON.stringify({ total_count: 1,
			jobs: [{ id: 6003, run_id: 7003, run_attempt: 1, head_sha: sha("c"), name: "private-campaign", status: "completed", conclusion: "success", steps: [
				{ name: "Run bounded private campaign", status: "completed", conclusion: "success" }] }] }));
		if (address.includes("/runs/7003/artifacts?")) return new Response(JSON.stringify({ total_count: 1,
			artifacts: [{ id: 9003, name: CARRY_ARTIFACT_NAME, expired: false, workflow_run: { id: 7003 } }] }));
		return base(url, init);
	};
	return { ...f, seedEnvelopeB64, firstCarry, secondCarry, request };
}


test("any exact terminal missing-carry execution stays unknown through seal and reopen", async t => {
	const f = await compactedFixture(t);
	const firstDone = { ...first, status: "completed", conclusion: "success" };
	const secondDone = { ...second, status: "completed", conclusion: "success" };
	const gap = { ...third, status: "completed", conclusion: "failure" };
	const next = run(7006, 5, "in_progress", sha("f"));
	const gapArtifact = { id: 9505, name: MISSION_ARTIFACT, expired: false,
		digest: `sha256:${"9".repeat(64)}`,
		workflow_run: { id: 7005, head_sha: sha("e") } };
	const requestFor = (runs: object[], carry: unknown[] = []): typeof fetch => async (url, init) => {
		const address = String(url);
		if (address.includes("/workflows/manual-private-campaign.yml/runs?"))
			return new Response(JSON.stringify({ total_count: runs.length, workflow_runs: [...runs].reverse() }));
		if (address.includes("/runs/7005/jobs?")) return new Response(JSON.stringify({ total_count: 1,
			jobs: [{ id: 6005, run_id: 7005, run_attempt: 1, head_sha: sha("e"),
				name: "private-campaign", status: "completed", conclusion: "failure",
				steps: [{ name: "Run private campaign", status: "completed", conclusion: "failure" }] }] }));
		if (address.includes("/runs/7005/artifacts?")) return new Response(JSON.stringify({
			total_count: 1 + carry.length, artifacts: [gapArtifact, ...carry] }));
		if (address.includes("/runs/7003/artifacts?")) return new Response(JSON.stringify({ total_count: 2,
			artifacts: [{ id: 9003, name: CARRY_ARTIFACT_NAME, expired: false,
				workflow_run: { id: 7003, head_sha: sha("c") } },
				{ id: 9103, name: MISSION_ARTIFACT, expired: false,
					digest: `sha256:${"7".repeat(64)}`,
					workflow_run: { id: 7003, head_sha: sha("c") } }] }));
		if (address.includes("/runs/7006/jobs?")) return new Response(JSON.stringify({ total_count: 1,
			jobs: [{ id: 6006, run_id: 7006, run_attempt: 1, head_sha: sha("f"),
				name: "private-campaign", status: "completed", conclusion: "failure",
				steps: [{ name: "Run private campaign", status: "completed", conclusion: "failure" }] }] }));
		if (address.includes("/runs/7006/artifacts?")) return new Response(JSON.stringify({ total_count: 2,
			artifacts: [{ id: 9006, name: CARRY_ARTIFACT_NAME, expired: false,
				workflow_run: { id: 7006, head_sha: sha("f") } },
				{ id: 9106, name: MISSION_ARTIFACT, expired: false,
					digest: `sha256:${"8".repeat(64)}`,
					workflow_run: { id: 7006, head_sha: sha("f") } }] }));
		return f.request(url, init);
	};
	const openGap = (request: typeof fetch) => openLedgerContinuation({ ...f,
		githubToken: "synthetic-token", current: current(7006, sha("f")), request,
		loadCarryArtifact: async () => f.secondCarry.envelopeB64 });
	const runs = [anchor, firstDone, secondDone, gap, next];
	for (const [pathPart, change] of [
		["/artifacts?", (row: any) => { row.artifacts[0].digest = "not-a-github-digest"; }],
		["/artifacts?", (row: any) => { row.artifacts[0].workflow_run.head_sha = sha("9"); }],
		["/jobs?", (row: any) => { row.jobs[0].head_sha = sha("9"); }],
	] as Array<[string, (row: any) => void]>) {
		const invalid: typeof fetch = async (url, init) => {
			const response = await requestFor(runs)(url, init);
			const address = String(url);
			if (!address.includes(`/runs/7005${pathPart}`)) return response;
			const body = await response.json() as any;
			change(body);
			return new Response(JSON.stringify(body));
		};
		await assert.rejects(openGap(invalid), /exact terminal encrypted result artifact/);
	}
	for (const carry of [
		[{ id: 9005, name: CARRY_ARTIFACT_NAME, expired: true,
			workflow_run: { id: 7005, head_sha: sha("e") } }],
		[{ id: 9005, name: CARRY_ARTIFACT_NAME, expired: false,
			workflow_run: { id: 7005, head_sha: sha("e") } },
			{ id: 9006, name: CARRY_ARTIFACT_NAME, expired: false,
				workflow_run: { id: 7005, head_sha: sha("e") } }],
	]) await assert.rejects(openGap(requestFor(runs, carry)), /artifact is unavailable or ambiguous/);
	const opened = await openGap(requestFor(runs));
	assert.equal(opened.opaqueExecutedRuns.length, 1);
	assert.equal(opened.opaqueExecutedRuns[0].accounting, "unquantified");
	assert.equal(opened.opaqueExecutedRuns[0].effects, "unreviewed");
	assert.equal(opened.priorCarryProof?.source.runId, "7003");
	assert.deepEqual(authenticatedHistoricalOpaqueRunGaps(opened.priorCarryProof,
		opened.priorPrivateBundle), opened.opaqueExecutedRuns);
	assert.equal(authenticatedHistoricalOpaqueRunGaps({ ...opened.priorCarryProof },
		opened.priorPrivateBundle), undefined);
	await assert.rejects(opened.claimOneUse("0".repeat(64)), /exact authenticated prior carry/);
	const profile = await verifyDeepSeekCnyBilling({ apiKey: "synthetic-key",
		now: () => new Date("2026-10-06T10:30:00.000Z"),
		request: async () => new Response(JSON.stringify({ is_available: true,
			balance_infos: [{ currency: "CNY", total_balance: "PRIVATE-AMOUNT",
				granted_balance: "PRIVATE-GRANT", topped_up_balance: "PRIVATE-TOPUP" }] }),
			{ status: 200 }) });
	const currentAudit = { version: 3 as const, kind: "accounting-only-request-audit" as const,
		requests: [{ requestId: "current-priced", inputPayloadBytes: 100,
			status: "settled" as const, settledCny: 0.5, unknownObservedCny: null,
			reportedUsage: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0,
				totalTokens: 20, reportedUsdCost: 0.01, costStatus: "priced" } },
			{ requestId: "current-unknown", inputPayloadBytes: 100,
				status: "unknown" as const, settledCny: null, unknownObservedCny: 0.25,
				reportedUsage: null }],
		settledCny: 0.5, unknownObservedCny: 0.25, unpricedRequestCount: 0,
		pricingProfile: nativeCnyPricingRecord(profile) };
	const inFlight = structuredClone(currentAudit);
	(inFlight.requests[1] as any).status = "in-flight";
	assert.throws(() => opened.sealCurrent({ settledCny: 0.5,
		unknownObservedCny: 0.25, unpricedRequestCount: 0,
		requestAudit: currentAudit }), /live V2 fresh-only reservation/);
	assert.throws(() => opened.sealEmergencyCurrent({ settledCny: 0.5, unknownObservedCny: 0.25,
		unpricedRequestCount: 0, requestAudit: inFlight }, "effect-review-incomplete"), /invalid or in-flight/);
	const emergency = opened.sealEmergencyCurrent({ settledCny: 0.5, unknownObservedCny: 0.25,
		unpricedRequestCount: 0, requestAudit: currentAudit,
		privateBundle: { "candidate.cpp": "unreviewed replacement" } }, "effect-review-incomplete");
	const authenticatedSeed = await authenticateSignedMissionSeed({ ...f,
		envelopeB64: f.seedEnvelopeB64 });
	const emergencyCheckpoint = decodeV4Checkpoint(emergency, authenticatedSeed.seedDigest,
		authenticatedSeed.derivePrivateKey("mul-pis-ledger-continuation-v1"),
		{ runId: "7006", runAttempt: 1, runNumber: 5, commit: sha("f") });
	assert.deepEqual(emergencyCheckpoint.requestAudit, currentAudit);
	assert.equal(emergencyCheckpoint.currentEffectReview, "pending");
	assert.deepEqual(emergencyCheckpoint.opaqueExecutedRuns, opened.opaqueExecutedRuns);
	assert.throws(() => opened.sealEmergencyCurrent({ settledCny: 0.5, unknownObservedCny: 0.25,
		unpricedRequestCount: 0, requestAudit: currentAudit }, "effect-review-incomplete"), /unsealed/);
	const later = run(7007, 6, "in_progress", sha("1"));
	const reopened = await openLedgerContinuation({ ...f, githubToken: "synthetic-token",
		current: current(7007, sha("1")),
		request: async (url, init) => {
			if (String(url).includes("/runs/7005/artifacts?"))
				throw new Error("compacted old gap artifact must not be fetched");
			return requestFor([anchor, firstDone, secondDone, gap,
				{ ...next, status: "completed", conclusion: "failure" }, later])(url, init);
		},
		loadCarryArtifact: async ({ artifactId }) => {
			assert.equal(artifactId, "9006"); return emergency;
		} });
	assert.equal(reopened.opaqueExecutedRuns.length, 1);
	assert.equal(reopened.opaqueExecutedRuns[0].source.runId, "7005");
	assert.equal(reopened.priorCarryProof?.source.runId, "7006");
	assert.deepEqual(authenticatedPendingHistoricalEffectSources(reopened.priorCarryProof,
		reopened.priorPrivateBundle)?.map(source => source.runId), ["7006"]);
	assert.equal(reopened.priorSettledCny, 0.5);
	assert.equal(reopened.priorUnknownObservedCny, 0.25);
	assert.equal(reopened.priorPrivateBundle?.["candidate.cpp"], "synthetic root evidence");
	const pendingLiveRequest: typeof fetch = async (url, init) => {
		const address = String(url);
		if (address.endsWith("/actions/runs/7007")) return new Response(JSON.stringify(later));
		if (address.includes("/runs/7007/jobs?")) return new Response(JSON.stringify({
			total_count: 1, jobs: [{ id: 6007, run_id: 7007, run_attempt: 1,
				head_sha: sha("1"), name: "private-campaign", status: "in_progress",
				conclusion: null, steps: [{ name: "Run private campaign",
					status: "in_progress", conclusion: null }] }] }));
		return requestFor([anchor, firstDone, secondDone, gap,
			{ ...next, status: "completed", conclusion: "failure" }, later])(url, init);
	};
	const pendingFresh = await openLedgerContinuation({ ...f, githubToken: "synthetic-token",
		current: current(7007, sha("1")), request: pendingLiveRequest,
		loadCarryArtifact: async () => emergency });
	const pendingClaim = await pendingFresh.claimOneUse(pendingFresh.priorCarryProof!.envelopeSha256);
	const pendingV2 = { version: 2, kind: "host-independent-goal-quarantine",
		prior: { source: pendingFresh.priorCarryProof!.source,
			envelopeSha256: pendingFresh.priorCarryProof!.envelopeSha256,
			privateBundleSha256: pendingFresh.priorCarryProof!.privateBundleSha256 },
		quarantine: { historicalEffectState: "unknown-unreconciled",
			executionMode: "fresh-work-only", operationOutcome: "unknown",
			selectedFromFailedAttempt: false, operationRefs: ["synthetic/O001"] } };
	const pendingBundle = { ...pendingFresh.priorPrivateBundle,
		"independent-restart-quarantine.json": JSON.stringify({ version: 1,
			kind: "host-independent-restart-reservations",
			entries: [{ receipt: pendingV2, claim: pendingClaim }] }) };
	const pendingSealed = pendingFresh.sealCurrent({ settledCny: 0.5,
		unknownObservedCny: 0.25, unpricedRequestCount: 0,
		requestAudit: currentAudit, privateBundle: pendingBundle });
	const pendingCheckpoint = decodeV4Checkpoint(pendingSealed, authenticatedSeed.seedDigest,
		authenticatedSeed.derivePrivateKey("mul-pis-ledger-continuation-v1"),
		{ runId: "7007", runAttempt: 1, runNumber: 6, commit: sha("1") });
	assert.deepEqual(pendingCheckpoint.pendingEffectAncestry.map((source: any) => source.runId), ["7006"]);
	assert.equal(pendingCheckpoint.currentEffectReview, "pending");
	assert.equal(pendingCheckpoint.settledNano, 1_000_000_000);
	assert.equal(pendingCheckpoint.unknownObservedNano, 500_000_000);

	const liveRequest: typeof fetch = async (url, init) => {
		const address = String(url);
		if (address.endsWith("/actions/runs/7006")) return new Response(JSON.stringify(next));
		if (address.includes("/runs/7006/jobs?")) return new Response(JSON.stringify({ total_count: 1,
			jobs: [{ id: 6006, run_id: 7006, run_attempt: 1, head_sha: sha("f"),
				name: "private-campaign", status: "in_progress", conclusion: null,
				steps: [{ name: "Run private campaign", status: "in_progress", conclusion: null }] }] }));
		return requestFor(runs)(url, init);
	};
	const admitted = await openGap(liveRequest);
	const claim = await admitted.claimOneUse(admitted.priorCarryProof!.envelopeSha256);
	assert.equal(claim.priorEnvelopeSha256, admitted.priorCarryProof!.envelopeSha256);
	assert.equal(claim.currentRunId, "7006");
	const freshOnlyReceipt = { version: 2, kind: "host-independent-goal-quarantine",
		prior: { source: admitted.priorCarryProof!.source,
			envelopeSha256: admitted.priorCarryProof!.envelopeSha256,
			privateBundleSha256: admitted.priorCarryProof!.privateBundleSha256 },
		quarantine: { historicalEffectState: "unknown-unreconciled",
			executionMode: "fresh-work-only", operationOutcome: "unknown",
			selectedFromFailedAttempt: false, operationRefs: [] } };
	const freshOnlyBundle = { ...admitted.priorPrivateBundle,
		"independent-restart-quarantine.json": JSON.stringify({ version: 1,
			kind: "host-independent-restart-reservations",
			entries: [{ receipt: freshOnlyReceipt, claim }] }) };
	const normal = admitted.sealCurrent({ settledCny: 0.5, unknownObservedCny: 0.25,
		unpricedRequestCount: 0, requestAudit: currentAudit, privateBundle: freshOnlyBundle });
	assert.throws(() => admitted.sealEmergencyCurrent({ settledCny: 0,
		unknownObservedCny: 0, unpricedRequestCount: 0, requestAudit: currentAudit },
		"effect-review-incomplete"), /unsealed/);
	const normalReopened = await openLedgerContinuation({ ...f, githubToken: "synthetic-token",
		current: current(7007, sha("1")),
		request: async (url, init) => {
			if (String(url).includes("/runs/7005/artifacts?"))
				throw new Error("compacted old gap artifact must not be fetched");
			return requestFor([anchor, firstDone, secondDone, gap,
				{ ...next, status: "completed", conclusion: "failure" }, later])(url, init);
		}, loadCarryArtifact: async ({ artifactId }) => {
			assert.equal(artifactId, "9006"); return normal;
		} });
	assert.equal(normalReopened.opaqueExecutedRuns[0].accounting, "unquantified");
	assert.equal(normalReopened.opaqueExecutedRuns[0].effects, "unreviewed");
	assert.equal(authenticatedAccountingObservation(normalReopened.priorCarryProof,
		normalReopened.priorPrivateBundle)?.opaqueUnquantifiedRunCount, 1);
	assert.equal(normalReopened.priorCarryProof?.source.runId, "7006");
	assert.deepEqual(authenticatedHistoricalOpaqueRunGaps(normalReopened.priorCarryProof,
		normalReopened.priorPrivateBundle), normalReopened.opaqueExecutedRuns);
	const withoutLatestResult = await openLedgerContinuation({ ...f, githubToken: "synthetic-token",
		current: current(7007, sha("1")),
		request: async (url, init) => String(url).includes("/runs/7006/artifacts?") ?
			new Response(JSON.stringify({ total_count: 1, artifacts: [{ id: 9006,
				name: CARRY_ARTIFACT_NAME, expired: false,
				workflow_run: { id: 7006, head_sha: sha("f") } }] })) :
			requestFor([anchor, firstDone, secondDone, gap,
				{ ...next, status: "completed", conclusion: "failure" }, later])(url, init),
		loadCarryArtifact: async () => normal });
	assert.equal(withoutLatestResult.priorCarryProof?.resultArtifact, undefined);
	assert.deepEqual(authenticatedHistoricalOpaqueRunGaps(withoutLatestResult.priorCarryProof,
		withoutLatestResult.priorPrivateBundle)?.map(item => item.source.runId), ["7005"]);
	const normalSource = { runId: "7006", runAttempt: 1, runNumber: 5, commit: sha("f") };
	const key = authenticatedSeed.derivePrivateKey("mul-pis-ledger-continuation-v1");
	const altered = decodeV4Checkpoint(normal, authenticatedSeed.seedDigest, key, normalSource);
	const historicalReviewedClaim = structuredClone(altered);
	historicalReviewedClaim.opaqueExecutedRuns[0].effects = "quarantined-source-reviewed";
	const wrapCheckpoint = (checkpoint: Record<string, any>) =>
		resealV4Checkpoint(checkpoint, authenticatedSeed.seedDigest, key, normalSource);
	const oldWriterGap = await openLedgerContinuation({ ...f, githubToken: "synthetic-token",
		current: current(7007, sha("1")),
		request: requestFor([anchor, firstDone, secondDone, gap,
			{ ...next, status: "completed", conclusion: "failure" }, later]),
		loadCarryArtifact: async () => wrapCheckpoint(historicalReviewedClaim) });
	assert.equal(oldWriterGap.opaqueExecutedRuns[0].effects, "unreviewed");
	assert.equal(authenticatedHistoricalOpaqueRunGaps(oldWriterGap.priorCarryProof,
		oldWriterGap.priorPrivateBundle)?.[0].effects, "unreviewed");
	const oldGapPassThrough = oldWriterGap.sealCurrent({ settledCny: 0,
		unknownObservedCny: 0, unpricedRequestCount: 0,
		requestAudit: { version: 3, kind: "accounting-only-request-audit",
			requests: [], settledCny: 0, unknownObservedCny: 0, unpricedRequestCount: 0 } });
	const successorCheckpoint = decodeV4Checkpoint(oldGapPassThrough, authenticatedSeed.seedDigest,
		key, { runId: "7007", runAttempt: 1, runNumber: 6, commit: sha("1") });
	assert.equal(successorCheckpoint.opaqueExecutedRuns[0].effects,
		"quarantined-source-reviewed", "the old signed statement is retained as history");
	assert.equal(successorCheckpoint.historicalOpaqueGapEffectInterpretation,
		"unknown-unreconciled", "the new safety interpretation is explicit");
	assert.equal(successorCheckpoint.opaqueExecutedRuns[0].resultArtifact.archiveSha256,
		historicalReviewedClaim.opaqueExecutedRuns[0].resultArtifact.archiveSha256);
	altered.opaqueExecutedRuns[0].priorCarryEnvelopeSha256 = "0".repeat(64);
	const forged = wrapCheckpoint(altered);
	await assert.rejects(openLedgerContinuation({ ...f, githubToken: "synthetic-token",
		current: current(7007, sha("1")),
		request: requestFor([anchor, firstDone, secondDone, gap,
			{ ...next, status: "completed", conclusion: "failure" }, later]),
		loadCarryArtifact: async () => forged }), /opaque gap predecessor digest/);
});


test("accepted selection remains authenticated across zero and emergency wrappers", async t => {
	const f = await fixture(t);
	const contract = { version: 1, kind: "original-objective", id: "selection-contract" };
	const priorArchive = JSON.stringify({ goalRunId: "prior-goal", taskId: "T001" });
	const priorCheckpoint = { version: 1, kind: "original-objective-progress", contract,
		selectedArtifacts: ["candidate.cpp", "verification.json", "workflow-archive.json"],
		boundedRuns: [{ runId: "prior-goal", outcome: "fulfilled", selectedTaskId: "T001",
			acceptedTaskIds: ["T001"], unresolvedOperationIds: [] }] };
	const oldBundle = { "candidate.cpp": "prior selected source", "verification.json": "{}",
		"workflow-archive.json": priorArchive,
		"objective-checkpoint.json": JSON.stringify(priorCheckpoint) };
	const seedEnvelopeB64 = f.signSeed({ ...f.payload, version: 2,
		rootReviewedAnchor: { commit: sha("a"), artifactSha256: "e".repeat(64),
			digestScope: "encrypted-result-envelope" },
		bootstrap: { contractId: contract.id, sourceSha256: "d".repeat(64),
			format: "deflate-raw-json-v1",
			filesB64: deflateRawSync(JSON.stringify(oldBundle)).toString("base64") } });
	const oldRun = await openLedgerContinuation({ ...f, seedEnvelopeB64,
		githubToken: "synthetic-token", current: current(7002, sha("b")),
		request: github([anchor, first]), loadCarryArtifact: async () => "unused" });
	const oldCarry = sealHistoricalCarryForOfflineTests(oldRun, { settledCny: 0,
		unknownOrInFlightCny: 0, requestAudit: audit(0, 0) });
	const firstDone = { ...first, status: "completed", conclusion: "failure" };
	const secondDone = { ...second, status: "completed", conclusion: "failure" };
	const selectedArchive = { version: 1, kind: "m07-private-candidate-archive",
		goalRunId: "new-goal", taskId: "T002", goalOutcome: "fulfilled", taskStatus: "accepted",
		controllerEvidence: { reviewStatus: "accepted" }, files: [
			{ name: "candidate.cpp", status: "present" },
			{ name: "verification.json", status: "present" }],
		m04: { state: "completed", runId: "M04-new", proposalSubmitted: false,
			snapshotCreated: false, transaction: { file: "m04-transaction.json", state: "no-proposal" } } };
	const selectedCheckpoint = { ...priorCheckpoint,
		boundedRuns: [...priorCheckpoint.boundedRuns,
			{ runId: "new-goal", outcome: "fulfilled", selectedTaskId: "T002",
				acceptedTaskIds: ["T002"], unresolvedOperationIds: [] }] };
	const history = { version: 1, kind: "untrusted-version-bound-research-history",
		entries: [{ goalRunId: "prior-goal", taskId: "T001",
			files: { "candidate.cpp": oldBundle["candidate.cpp"],
				"verification.json": oldBundle["verification.json"],
				"workflow-archive.json": oldBundle["workflow-archive.json"] } }] };
	const tx = { version: 1, kind: "m04-knowledge-transaction", m04RunId: "M04-new",
		state: "no-proposal", attempts: [] };
	const selectedBundle: Record<string, string> = { ...oldBundle, "candidate.cpp": "new selected source",
		"verification.json": JSON.stringify({ version: 1, status: "passed" }),
		"workflow-archive.json": JSON.stringify(selectedArchive),
		"objective-checkpoint.json": JSON.stringify(selectedCheckpoint),
		"research-history.json": JSON.stringify(history),
		"m04-transaction.json": JSON.stringify(tx) };
	const sessionId = campaignSessionEffectId("new accepted selection");
	const profile = await verifyDeepSeekCnyBilling({ apiKey: "synthetic-key",
		now: () => new Date("2026-10-06T10:30:00.000Z"),
		request: async () => new Response(JSON.stringify({ is_available: true,
			balance_infos: [{ currency: "CNY", total_balance: "PRIVATE-AMOUNT",
				granted_balance: "PRIVATE-GRANT", topped_up_balance: "PRIVATE-TOPUP" }] })) });
	const requestAudit = { version: 3 as const, kind: "accounting-only-request-audit" as const,
		requests: [{ requestId: "accepted-request", sessionId, responseReceived: true,
			inputPayloadBytes: 100, status: "settled" as const, settledCny: 0.25,
			unknownObservedCny: null, reportedUsage: { input: 10, output: 10,
				cacheRead: 0, cacheWrite: 0, totalTokens: 20, reportedUsdCost: 0.01,
				costStatus: "priced" } }], settledCny: 0.25, unknownObservedCny: 0,
		unpricedRequestCount: 0, pricingProfile: nativeCnyPricingRecord(profile) };
	const emptyAudit = { version: 3 as const, kind: "accounting-only-request-audit" as const,
		requests: [], settledCny: 0, unknownObservedCny: 0, unpricedRequestCount: 0 };
	const openSelection = () => openLedgerContinuation({ ...f, seedEnvelopeB64,
		githubToken: "synthetic-token", current: current(7003, sha("c")),
		request: github([anchor, firstDone, second]),
		loadCarryArtifact: async () => oldCarry.envelopeB64 });
	const chosen = await openSelection();
	selectedBundle["host-effect-receipt.json"] = JSON.stringify({ version: 1,
		kind: "m07-host-effect-census", source: { runId: "7003", runAttempt: 1, commit: sha("c") },
		priorEnvelopeSha256: chosen.priorCarryProof!.envelopeSha256,
		historicalGoalRunIds: ["prior-goal"],
		goals: [{ runId: "new-goal", outcome: "fulfilled",
			tasks: [{ taskId: "T002", mode: "execute", status: "accepted", sessionId }],
			operations: [{ id: "O001", taskId: "T002", status: "response-received" }] }],
		sessions: [{ sessionId, kind: "confined-execution", goalRunId: "new-goal",
			taskId: "T002", workRoot: "/tmp/synthetic/T002",
			grant: { version: 1, kind: "confined-campaign-files", root: "/tmp/synthetic/T002",
				writableFiles: ["candidate.cpp", "lesson-delta.json"] } }],
		requestIds: ["accepted-request"] });
	for (const name of ["candidate.cpp", "verification.json"] as const) {
		const invalid = { ...selectedBundle, "objective-checkpoint.json": JSON.stringify({
			...selectedCheckpoint, selectedArtifacts: selectedCheckpoint.selectedArtifacts.filter(item => item !== name) }) };
		assert.throws(() => chosen.sealCurrent({ settledCny: 0.25, unknownObservedCny: 0,
			unpricedRequestCount: 0, requestAudit, privateBundle: invalid }),
			/selected tuple omitted required source or checker/);
	}
	const unchangedFilesBadList = { ...oldBundle,
		"objective-checkpoint.json": JSON.stringify({ ...priorCheckpoint,
			selectedArtifacts: ["verification.json", "workflow-archive.json"] }) };
	assert.throws(() => chosen.sealCurrent({ settledCny: 0,
		unknownObservedCny: 0, unpricedRequestCount: 0,
		requestAudit: emptyAudit, privateBundle: unchangedFilesBadList }),
		/selected tuple omitted required source or checker/);
	const reorderedOld = { ...oldBundle,
		"objective-checkpoint.json": JSON.stringify({ ...priorCheckpoint,
			selectedArtifacts: [...priorCheckpoint.selectedArtifacts].reverse() }) };
	const reorderOpen = await openSelection();
	assert.doesNotThrow(() => reorderOpen.sealCurrent({ settledCny: 0,
		unknownObservedCny: 0, unpricedRequestCount: 0,
		requestAudit: emptyAudit, privateBundle: reorderedOld }));
	const planChangedOpen = await openSelection();
	assert.throws(() => planChangedOpen.sealCurrent({ settledCny: 0,
		unknownObservedCny: 0, unpricedRequestCount: 0,
		requestAudit: emptyAudit,
		privateBundle: { ...oldBundle, "experiment-plan.json": "changed unselected plan" } }),
		/selected plan changed without a completed authenticated transition/);
	const malformedOldRun = await openLedgerContinuation({ ...f, seedEnvelopeB64,
		githubToken: "synthetic-token", current: current(7002, sha("b")),
		request: github([anchor, first]), loadCarryArtifact: async () => "unused" });
	const malformedOldCarry = sealHistoricalCarryForOfflineTests(malformedOldRun, {
		settledCny: 0, unknownOrInFlightCny: 0, requestAudit: audit(0, 0),
		privateBundle: unchangedFilesBadList });
	const malformedPrior = await openLedgerContinuation({ ...f, seedEnvelopeB64,
		githubToken: "synthetic-token", current: current(7003, sha("c")),
		request: github([anchor, firstDone, second]),
		loadCarryArtifact: async () => malformedOldCarry.envelopeB64 });
	assert.throws(() => malformedPrior.sealCurrent({ settledCny: 0.25,
		unknownObservedCny: 0, unpricedRequestCount: 0,
		requestAudit, privateBundle: selectedBundle }),
		/authenticated predecessor selected tuple is incomplete/);
	const wrongArchive = { ...selectedArchive, m04: { ...selectedArchive.m04,
		state: "completed", proposalSubmitted: true, snapshotCreated: true,
		snapshotId: "snapshot-A", transaction: { file: "m04-transaction.json", state: "merged" } } };
	const wrongMerged = { ...selectedBundle,
		"workflow-archive.json": JSON.stringify(wrongArchive),
		"m04-transaction.json": JSON.stringify({ ...tx, state: "merged", snapshotId: "snapshot-B",
			currentProposalId: "P0001", attempts: [{ state: "merged", proposalId: "P0001",
				structurallyValid: true }] }) };
	assert.throws(() => chosen.sealCurrent({ settledCny: 0.25, unknownObservedCny: 0,
		unpricedRequestCount: 0, requestAudit, privateBundle: wrongMerged }),
		/new selected tuple lacks a completed authenticated transition/);
	const firstSelected = chosen.sealCurrent({ settledCny: 0.25, unknownObservedCny: 0,
		unpricedRequestCount: 0, requestAudit, privateBundle: selectedBundle });
	const requestFor = (runs: object[]): typeof fetch => async (url, init) => {
		const address = String(url);
		if (address.includes("/workflows/manual-private-campaign.yml/runs?"))
			return new Response(JSON.stringify({ total_count: runs.length, workflow_runs: [...runs].reverse() }));
		for (const [id, commit, artifactId] of [[7003, sha("c"), 9003],
			[7005, sha("e"), 9005], [7006, sha("f"), 9006]] as const) {
			if (address.includes(`/runs/${id}/jobs?`)) return new Response(JSON.stringify({
				total_count: 1, jobs: [{ id: id + 1000, run_id: id, run_attempt: 1,
					head_sha: commit, name: "private-campaign", status: "completed",
					conclusion: "failure", steps: [{ name: "Run private campaign",
						status: "completed", conclusion: "failure" }] }] }));
			if (address.includes(`/runs/${id}/artifacts?`)) return new Response(JSON.stringify({
				total_count: 2, artifacts: [{ id: artifactId, name: CARRY_ARTIFACT_NAME,
					expired: false, workflow_run: { id, head_sha: commit } },
					{ id: artifactId + 100, name: MISSION_ARTIFACT, expired: false,
						digest: `sha256:${"a".repeat(64)}`,
						workflow_run: { id, head_sha: commit } }] }));
		}
		return github(runs)(url, init);
	};
	const thirdRun = run(7005, 4, "in_progress", sha("e"));
	const newOpened = await openLedgerContinuation({ ...f, seedEnvelopeB64,
		githubToken: "synthetic-token", current: current(7005, sha("e")),
		request: requestFor([anchor, firstDone, secondDone, thirdRun]),
		loadCarryArtifact: async () => firstSelected });
	const selected = authenticatedSelectedTransitions(newOpened.priorCarryProof,
		newOpened.priorPrivateBundle);
	assert.equal(selected?.length, 1);
	assert.equal(selected?.[0].source.runId, "7003");
	assert.equal(selected?.[0].envelopeSha256, newOpened.priorCarryProof?.envelopeSha256);
	assert.equal(authenticatedSelectedTransitions({ ...newOpened.priorCarryProof },
		newOpened.priorPrivateBundle), undefined);
	const reorderedSelection = { ...newOpened.priorPrivateBundle!,
		"objective-checkpoint.json": JSON.stringify({ ...selectedCheckpoint,
			selectedArtifacts: [...selectedCheckpoint.selectedArtifacts].reverse() }) };
	const zero = newOpened.sealCurrent({ settledCny: 0, unknownObservedCny: 0,
		unpricedRequestCount: 0, requestAudit: emptyAudit,
		privateBundle: reorderedSelection });
	const fourthRun = run(7006, 5, "in_progress", sha("f"));
	const zeroOpened = await openLedgerContinuation({ ...f, seedEnvelopeB64,
		githubToken: "synthetic-token", current: current(7006, sha("f")),
		request: requestFor([anchor, firstDone, secondDone,
			{ ...thirdRun, status: "completed", conclusion: "failure" }, fourthRun]),
		loadCarryArtifact: async () => zero });
	assert.deepEqual(authenticatedSelectedTransitions(zeroOpened.priorCarryProof,
		zeroOpened.priorPrivateBundle), selected);
	const secondSelection = await openLedgerContinuation({ ...f, seedEnvelopeB64,
		githubToken: "synthetic-token", current: current(7006, sha("f")),
		request: requestFor([anchor, firstDone, secondDone,
			{ ...thirdRun, status: "completed", conclusion: "failure" }, fourthRun]),
		loadCarryArtifact: async () => zero });
	const secondSession = campaignSessionEffectId("second accepted selection");
	const secondArchive = { ...selectedArchive, goalRunId: "third-goal", taskId: "T003",
		m04: { ...selectedArchive.m04, runId: "M04-next" } };
	const secondCheckpoint = { ...selectedCheckpoint,
		boundedRuns: [...selectedCheckpoint.boundedRuns,
			{ runId: "third-goal", outcome: "fulfilled", selectedTaskId: "T003",
				acceptedTaskIds: ["T003"], unresolvedOperationIds: [] }] };
	const secondHistory = { ...history, entries: [...history.entries,
		{ goalRunId: "new-goal", taskId: "T002", files: {
			"candidate.cpp": selectedBundle["candidate.cpp"],
			"verification.json": selectedBundle["verification.json"],
			"workflow-archive.json": selectedBundle["workflow-archive.json"],
			"m04-transaction.json": selectedBundle["m04-transaction.json"] } }] };
	const secondBundle: Record<string, string> = { ...selectedBundle,
		"candidate.cpp": "second selected source",
		"workflow-archive.json": JSON.stringify(secondArchive),
		"m04-transaction.json": JSON.stringify({ ...tx, m04RunId: "M04-next" }),
		"objective-checkpoint.json": JSON.stringify(secondCheckpoint),
		"research-history.json": JSON.stringify(secondHistory),
		"host-effect-receipt.json": JSON.stringify({ version: 1,
			kind: "m07-host-effect-census", source: { runId: "7006", runAttempt: 1, commit: sha("f") },
			priorEnvelopeSha256: secondSelection.priorCarryProof!.envelopeSha256,
			historicalGoalRunIds: ["prior-goal", "new-goal"],
			goals: [{ runId: "third-goal", outcome: "fulfilled",
				tasks: [{ taskId: "T003", mode: "execute", status: "accepted",
					sessionId: secondSession }],
				operations: [{ id: "O001", taskId: "T003", status: "response-received" }] }],
			sessions: [{ sessionId: secondSession, kind: "confined-execution",
				goalRunId: "third-goal", taskId: "T003", workRoot: "/tmp/synthetic/T003",
				grant: { version: 1, kind: "confined-campaign-files",
					root: "/tmp/synthetic/T003",
					writableFiles: ["candidate.cpp", "lesson-delta.json"] } }],
			requestIds: ["second-accepted-request"] }) };
	const secondAudit = { ...requestAudit, requests: [{ ...requestAudit.requests[0],
		requestId: "second-accepted-request", sessionId: secondSession }] };
	const secondCarry = secondSelection.sealCurrent({ settledCny: 0.25,
		unknownObservedCny: 0, unpricedRequestCount: 0,
		requestAudit: secondAudit, privateBundle: secondBundle });
	const failed = zeroOpened.sealEmergencyCurrent({ settledCny: 0,
		unknownObservedCny: 0, unpricedRequestCount: 0,
		requestAudit: emptyAudit }, "effect-review-incomplete");
	const fifthRun = run(7007, 6, "in_progress", sha("1"));
	const failedOpened = await openLedgerContinuation({ ...f, seedEnvelopeB64,
		githubToken: "synthetic-token", current: current(7007, sha("1")),
		request: requestFor([anchor, firstDone, secondDone,
			{ ...thirdRun, status: "completed", conclusion: "failure" },
			{ ...fourthRun, status: "completed", conclusion: "failure" }, fifthRun]),
		loadCarryArtifact: async () => failed });
	assert.deepEqual(authenticatedSelectedTransitions(failedOpened.priorCarryProof,
		failedOpened.priorPrivateBundle), selected);
	const secondOpened = await openLedgerContinuation({ ...f, seedEnvelopeB64,
		githubToken: "synthetic-token", current: current(7007, sha("1")),
		request: requestFor([anchor, firstDone, secondDone,
			{ ...thirdRun, status: "completed", conclusion: "failure" },
			{ ...fourthRun, status: "completed", conclusion: "failure" }, fifthRun]),
		loadCarryArtifact: async () => secondCarry });
	assert.equal(authenticatedSelectedTransitions(secondOpened.priorCarryProof,
		secondOpened.priorPrivateBundle)?.length, 2);
	const seed = await authenticateSignedMissionSeed({ ...f, envelopeB64: seedEnvelopeB64 });
	const key = seed.derivePrivateKey("mul-pis-ledger-continuation-v1");
	const source = { runId: "7005", runAttempt: 1, runNumber: 4, commit: sha("e") };
	const corrupted = decodeV4Checkpoint(zero, seed.seedDigest, key, source);
	corrupted.selectedTransitions[0].archiveSha256 = "0".repeat(64);
	const forged = resealV4Checkpoint(corrupted, seed.seedDigest, key, source);
	await assert.rejects(openLedgerContinuation({ ...f, seedEnvelopeB64,
		githubToken: "synthetic-token", current: current(7006, sha("f")),
		request: requestFor([anchor, firstDone, secondDone,
			{ ...thirdRun, status: "completed", conclusion: "failure" }, fourthRun]),
		loadCarryArtifact: async () => forged }), /selected transition ancestry prefix/);
	const secondSource = { runId: "7006", runAttempt: 1, runNumber: 5, commit: sha("f") };
	const alteredHistory = decodeV4Checkpoint(secondCarry, seed.seedDigest, key, secondSource);
	const archived = JSON.parse(alteredHistory.privateBundle["research-history.json"]);
	archived.entries[1].files["candidate.cpp"] = "tampered prior selection";
	alteredHistory.privateBundle["research-history.json"] = JSON.stringify(archived);
	const forgedHistory = resealV4Checkpoint(alteredHistory, seed.seedDigest, key, secondSource);
	await assert.rejects(openLedgerContinuation({ ...f, seedEnvelopeB64,
		githubToken: "synthetic-token", current: current(7007, sha("1")),
		request: requestFor([anchor, firstDone, secondDone,
			{ ...thirdRun, status: "completed", conclusion: "failure" },
			{ ...fourthRun, status: "completed", conclusion: "failure" }, fifthRun]),
		loadCarryArtifact: async () => forgedHistory }),
		/selected transition tuple or completed M04 archive changed/);
});
