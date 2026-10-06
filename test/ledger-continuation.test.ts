import assert from "node:assert/strict";
import { createCipheriv, createDecipheriv, createHash, generateKeyPairSync, randomBytes, sign, constants } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { deflateRawSync } from "node:zlib";
import test, { type TestContext } from "node:test";
import { authenticateOpaqueGapSourceForOfflineTests, authenticatedReviewedOpaqueRunGaps, authenticatedCarryForwardOrigin, authenticatedHostEffectEvidence, authenticatedPriorCarryBindsAncestor, authenticatedPriorCarryBindsBundle, isAuthenticatedPriorCarryProof, CARRY_ARTIFACT_NAME, CARRY_FILE_NAME, downloadCarryArtifact, openLedgerContinuation, originalObjectiveMatchesSignedBootstrap, reviewKnownOpaqueGapSource, sealHistoricalCarryForOfflineTests, REUSABLE_RUN_REQUEST_MESSAGE } from "../src/runner/ledger-continuation.ts";
import type { RequestAuditSnapshot } from "../src/runner/ledger-continuation.ts";
import { DeepSeekCampaignBudget, campaignSessionEffectId, type CampaignAdmissionRejection } from "../src/runner/deepseek-campaign.ts";
import { offlineChecks } from "../scripts/manual-private-campaign.ts";
import { Workspace } from "../src/workspace.ts";
import { reserveIndependentRestart, bindIndependentRestartGoal } from "../src/m07/independent-restart.ts";
import { objectiveProgress, type OriginalObjectiveContractV1 } from "../src/m07/objective-progress.ts";
import { verifyDeepSeekCnyBilling, nativeCnyPricingRecord } from "../src/runner/deepseek-cny-pricing.ts";
import { verifyDeepSeekProviderOutputLimit, providerOutputLimitRecord } from "../src/runner/deepseek-provider-limits.ts";
import { authenticateSignedMissionSeed, MISSION_ARTIFACT, MISSION_ID, MISSION_REPOSITORY, MISSION_TOTAL_CNY, ONE_USE_PUSH_MARKER } from "../src/runner/signed-mission-ledger.ts";

const sha = (letter: string) => letter.repeat(40);
test("old-writer effect recovery cannot change signed objective text under the same contract ID", () => {
	const signed = JSON.stringify({ version: 1, kind: "original-objective", id: "same-id",
		goal: "synthetic original", constraints: ["frozen"] });
	const current = { "original-objective.json": signed,
		"objective-checkpoint.json": JSON.stringify({ contract: JSON.parse(signed) }) };
	assert.equal(originalObjectiveMatchesSignedBootstrap(current, signed), true);
	const changed = JSON.stringify({ ...JSON.parse(signed), constraints: ["changed"] });
	assert.equal(originalObjectiveMatchesSignedBootstrap({ "original-objective.json": changed,
		"objective-checkpoint.json": JSON.stringify({ contract: JSON.parse(changed) }) }, signed), false);
	assert.equal(originalObjectiveMatchesSignedBootstrap({ ...current,
		"objective-checkpoint.json": JSON.stringify({ contract: { ...JSON.parse(signed), goal: "different" } }) }, signed), false);
});
const TEST_PROVIDER_OUTPUT_LIMIT = await verifyDeepSeekProviderOutputLimit({ apiKey: "synthetic-only",
	request: async () => new Response(JSON.stringify({ object: "list", data: [{ id: "deepseek-flash",
		object: "model", name: "DeepSeek-V4.1-Flash", max_output_tokens: 20,
		context_window: 10_000 }] }), { status: 200 }) });
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
function historicalUnsentRejection(): CampaignAdmissionRejection {
	const inputPayloadBytes = 100_000, inputRate = 4, outputRate = 16;
	const outputAccountingMarginTokens = 32;
	return { version: 1, kind: "campaign-admission-rejection", decision: "input-unaffordable",
		requestNotSent: true, inputPayloadBytes,
		inputUpperCny: inputPayloadBytes * inputRate / 1_000_000,
		outputAllowanceTokens: 0, minimumOutputTokens: 1, requestedOutputTokens: 20,
		outputAccountingMarginTokens, marginUpperCny: outputAccountingMarginTokens * outputRate / 1_000_000,
		availableCny: 0.25,
		requiredAtMinimumOutputCny: (inputPayloadBytes * inputRate +
			(1 + outputAccountingMarginTokens) * outputRate) / 1_000_000,
		globalMaxCny: 0.25, committedBeforeCny: 0, settledProviderRequestCount: 0,
		pricingBasis: { source: "higher-of-configured-and-sdk-estimates",
			inputCnyPerMillionTokens: inputRate, outputCnyPerMillionTokens: outputRate } };
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

test("v2 signed seed privately bootstraps exact source-bound research files", async t => {
	const f = await fixture(t);
	const privateFiles = { "candidate.cpp": "synthetic candidate", "verification.json": "{}",
		"objective-checkpoint.json": "{}", "workflow-archive.json": "{}",
		"experiment-plan.json": "{}", "assessment-receipts.json": "{}",
		"research-history.json": JSON.stringify({ version: 1, records: [{ source: "synthetic-history" }] }),
		"independent-restart-quarantine.json": JSON.stringify({ version: 1, synthetic: true }),
		"independent-restart-goal-binding.json": JSON.stringify({ version: 1, synthetic: true, goalRunId: "fresh-goal" }) };
	const binding = { contractId: "synthetic-original-contract", sourceSha256: "d".repeat(64) };
	const v2 = { ...f.payload, version: 2, rootReviewedAnchor: { commit: sha("a"), artifactSha256: "e".repeat(64),
		digestScope: "encrypted-result-envelope" }, bootstrap: { ...binding,
		format: "deflate-raw-json-v1",
		filesB64: deflateRawSync(JSON.stringify(privateFiles)).toString("base64") } };
	const seedEnvelopeB64 = f.signSeed(v2);
	const opened = await openLedgerContinuation({ ...f, seedEnvelopeB64,
		githubToken: "synthetic-token", current: current(7002, sha("b")),
		request: github([anchor, first]), loadCarryArtifact: async () => "unused" });
	assert.deepEqual(opened.priorPrivateBundle, privateFiles);
	assert.deepEqual(opened.priorBootstrapBinding, binding);
	const sealed = sealHistoricalCarryForOfflineTests(opened, { settledCny: 0, unknownOrInFlightCny: 0,
		requestAudit: audit(0, 0) });
	const next = await openLedgerContinuation({ ...f, seedEnvelopeB64,
		githubToken: "synthetic-token", current: current(7003, sha("c")),
		request: github([anchor, { ...first, status: "completed", conclusion: "failure" }, second]),
		loadCarryArtifact: async () => sealed.envelopeB64 });
	assert.deepEqual(next.priorPrivateBundle, privateFiles);
	assert.deepEqual(next.priorBootstrapBinding, binding);
	assert.throws(() => sealHistoricalCarryForOfflineTests(next, { settledCny: 0, unknownOrInFlightCny: 0,
		requestAudit: audit(0, 0), bootstrapBinding: { ...binding, sourceSha256: "e".repeat(64) } }),
		/accounting exceeds mission bounds/);
	assert.doesNotMatch(Buffer.from(seedEnvelopeB64, "base64").toString(), /synthetic candidate/);
});

test("verified legacy carry transitions monotonically to accounting-only v3 without relabeling old holds", async t => {
	const f = await fixture(t);
	const legacy = await openLedgerContinuation({ ...f, githubToken: "synthetic-token",
		current: current(7002, sha("b")), request: github([anchor, first]),
		loadCarryArtifact: async () => "unused" });
	const legacyCarry = sealHistoricalCarryForOfflineTests(legacy, { settledCny: 1.25,
		unknownOrInFlightCny: 0.75, requestAudit: audit(1.25, 0.75) });
	const completedFirst = { ...first, status: "completed", conclusion: "failure" };
	const start = await openLedgerContinuation({ ...f, githubToken: "synthetic-token",
		current: current(7003, sha("c")), request: github([anchor, completedFirst, second]),
		loadCarryArtifact: async () => legacyCarry.envelopeB64 });
	assert.equal(start.mode, "accounting-only");
	assert.equal(start.historicalCommittedCny, 6.125);
	assert.equal(start.historicalUnknownHeldCny, 0.75);
	assert.equal(start.priorSettledCny, 0);
	assert.equal(start.priorUnknownObservedCny, 0);
	assert.equal(start.priorUnpricedRequestCount, 0);
	assert.equal(start.priorCarryProof?.version, 1);
	const profile = await verifyDeepSeekCnyBilling({ apiKey: "synthetic-key",
		now: () => new Date("2026-10-06T10:30:00.000Z"),
		request: async () => new Response(JSON.stringify({ is_available: true,
			balance_infos: [{ currency: "CNY", total_balance: "PRIVATE-AMOUNT",
				granted_balance: "PRIVATE-GRANT", topped_up_balance: "PRIVATE-TOPUP" }] }),
			{ status: 200 }) });
	const pricedUsage = { input: 10, output: 10, cacheRead: 0, cacheWrite: 0,
		totalTokens: 20, reportedUsdCost: 0.01, costStatus: "priced" };
	const requestAudit = { version: 3 as const, kind: "accounting-only-request-audit" as const,
		requests: [
			{ requestId: "priced", inputPayloadBytes: 100, maxOutputTokens: 100,
				status: "settled" as const, settledCny: 42.25, unknownObservedCny: null,
				reportedUsage: pricedUsage },
			{ requestId: "unpriced", inputPayloadBytes: 100, maxOutputTokens: 100,
				status: "settled" as const, settledCny: null, unknownObservedCny: null,
				reportedUsage: pricedUsage },
			{ requestId: "unknown", inputPayloadBytes: 100, maxOutputTokens: 100,
				status: "unknown" as const, settledCny: null, unknownObservedCny: 1.5,
				reportedUsage: { input: 7, totalTokens: 3, reportedUsdCost: null,
					costStatus: "uncertain" } },
		], settledCny: 42.25, unknownObservedCny: 1.5, unpricedRequestCount: 1,
		pricingProfile: nativeCnyPricingRecord(profile) };
	const missingPrice = { ...requestAudit, pricingProfile: undefined };
	assert.throws(() => start.sealCurrent({ settledCny: 42.25, unknownObservedCny: 1.5,
		unpricedRequestCount: 1, requestAudit: missingPrice }), /accounting-only carry is invalid/);
	assert.throws(() => start.sealCurrent({ settledCny: 42.25, unknownObservedCny: 1.5,
		unpricedRequestCount: 0, requestAudit }), /accounting-only carry is invalid/);
	const sealed = start.sealCurrent({ settledCny: 42.25, unknownObservedCny: 1.5,
		unpricedRequestCount: 1, requestAudit });
	assert.equal(sealed.observedSettledCny, 42.25);
	assert.equal(sealed.observedUnknownHeldCny, 1.5);
	assert.equal(sealed.unpricedRequestCount, 1);
	const completedSecond = { ...second, status: "completed", conclusion: "failure" };
	const baseRequest = github([anchor, completedFirst, completedSecond, third]);
	const request: typeof fetch = async (url, init) => {
		const address = String(url);
		if (address.endsWith("/runs/7003/jobs?per_page=100"))
			return new Response(JSON.stringify({ total_count: 1, jobs: [{ id: 6003, run_id: 7003,
				run_attempt: 1, head_sha: sha("c"), name: "private-campaign", status: "completed",
				conclusion: "failure", steps: [{ name: "Run bounded private campaign",
					status: "completed", conclusion: "success" }] }] }), { status: 200 });
		if (address.endsWith("/runs/7003/artifacts?per_page=100"))
			return new Response(JSON.stringify({ total_count: 1, artifacts: [{ id: 9003,
				name: CARRY_ARTIFACT_NAME, expired: false, workflow_run: { id: 7003 } }] }), { status: 200 });
		return baseRequest(url, init);
	};
	const next = await openLedgerContinuation({ ...f, githubToken: "synthetic-token",
		current: current(7005, sha("e")), request,
		loadCarryArtifact: async () => sealed.envelopeB64 });
	assert.equal(next.historicalCommittedCny, 6.125);
	assert.equal(next.historicalUnknownHeldCny, 0.75);
	assert.equal(next.priorSettledCny, 42.25);
	assert.equal(next.priorUnknownObservedCny, 1.5);
	assert.equal(next.priorUnpricedRequestCount, 1);
	assert.equal(next.priorCarryProof?.version, 2);
	assert.equal(next.priorCarryProof?.priorSettledCny, 42.25);
});

test("v3 records wholly unpriced provider requests without fabricating CNY or requiring a price profile", async t => {
	const f = await fixture(t);
	const opened = await openLedgerContinuation({ ...f, githubToken: "synthetic-token",
		current: current(7002, sha("b")), request: github([anchor, first]),
		loadCarryArtifact: async () => "unused" });
	const requestAudit = { version: 3 as const, kind: "accounting-only-request-audit" as const,
		requests: [
			{ requestId: "settled-unpriced", inputPayloadBytes: 100, maxOutputTokens: 100,
				status: "settled" as const, settledCny: null, unknownObservedCny: null,
				reportedUsage: { input: 20, output: 3, totalTokens: 100 } },
			{ requestId: "unknown-unpriced", inputPayloadBytes: 100, maxOutputTokens: 100,
				status: "unknown" as const, settledCny: null, unknownObservedCny: null,
				reportedUsage: { totalTokens: 10 } },
		], settledCny: 0, unknownObservedCny: 0, unpricedRequestCount: 2 };
	const sealed = opened.sealCurrent({ settledCny: 0, unknownObservedCny: 0,
		unpricedRequestCount: 2, requestAudit });
	assert.equal(sealed.observedSettledCny, 0);
	assert.equal(sealed.unpricedRequestCount, 2);
	const reopened = await openLedgerContinuation({ ...f, githubToken: "synthetic-token",
		current: current(7003, sha("c")),
		request: github([anchor, { ...first, status: "completed", conclusion: "failure" }, second]),
		loadCarryArtifact: async () => sealed.envelopeB64 });
	assert.equal(reopened.historicalCommittedCny, 4.125);
	assert.equal(reopened.priorSettledCny, 0);
	assert.equal(reopened.priorUnpricedRequestCount, 2);
});

test("v2 seed rejects unlisted files and an oversized Actions Secret", async t => {
	const f = await fixture(t);
	const malformed = { ...f.payload, version: 2, rootReviewedAnchor: { commit: sha("a"), artifactSha256: "e".repeat(64),
		digestScope: "encrypted-result-envelope" }, bootstrap: {
		contractId: "synthetic-contract", sourceSha256: "d".repeat(64),
		format: "deflate-raw-json-v1", filesB64: deflateRawSync(JSON.stringify({ "secret.txt": "private" })).toString("base64") } };
	const common = { ...f, githubToken: "synthetic-token", current: current(7002, sha("b")),
		request: github([anchor, first]), loadCarryArtifact: async () => "unused" };
	await assert.rejects(openLedgerContinuation({ ...common, seedEnvelopeB64: f.signSeed(malformed) }),
		/bootstrap bundle files are invalid/);
	await assert.rejects(openLedgerContinuation({ ...common,
		seedEnvelopeB64: "A".repeat(48 * 1024 + 4) }), /exceeds Actions secret limit/);
});

test("missing, duplicate, replayed, or tampered carries fail closed", async t => {
	const f = await fixture(t);
	const common = { ...f, githubToken: "synthetic-token", current: current(7003, sha("c")) };
	const completedFirst = { ...first, status: "completed", conclusion: "failure" };
	await assert.rejects(openLedgerContinuation({ ...common,
		request: github([anchor, completedFirst, second], { missingCarry: true }),
		loadCarryArtifact: async () => "unused" }), /artifact is unavailable/);
	await assert.rejects(openLedgerContinuation({ ...common,
		request: github([anchor, completedFirst, second], { duplicateCarry: true }),
		loadCarryArtifact: async () => "unused" }), /artifact is unavailable/);
	const wrongSeed = await fixture(t);
	const sealedByWrongSeed = sealHistoricalCarryForOfflineTests((await openLedgerContinuation({ ...wrongSeed,
		githubToken: "synthetic-token", current: current(7002, sha("b")),
		request: github([anchor, first]), loadCarryArtifact: async () => "unused" })),
		{ settledCny: 1, unknownOrInFlightCny: 0, requestAudit: audit(1, 0) });
	await assert.rejects(openLedgerContinuation({ ...common,
		request: github([anchor, completedFirst, second]),
		loadCarryArtifact: async () => sealedByWrongSeed.envelopeB64 }), /authentication failed/);
	await assert.rejects(openLedgerContinuation({ ...common,
		request: github([anchor, completedFirst, second]),
		loadCarryArtifact: async () => sealedByWrongSeed.envelopeB64.slice(1) }), /carry encoding|authentication failed/);
});

test("skipped provider run is proven, but cancelled and incomplete histories fail", async t => {
	const f = await fixture(t);
	const open = await openLedgerContinuation({ ...f, githubToken: "synthetic-token",
		current: current(7005, sha("e")), request: github([anchor, { ...first, status: "completed",
			conclusion: "success" }, skipped, third], { step: "skipped" }),
		loadCarryArtifact: async () => { throw Error("skipped"); } });
	assert.equal(open.priorCommittedCny, 4.125);
	await assert.rejects(openLedgerContinuation({ ...f, githubToken: "synthetic-token",
		current: current(7003, sha("c")), request: github([anchor, { ...first,
			status: "completed", conclusion: "cancelled" }, second]),
		loadCarryArtifact: async () => "unused" }), /not settled/);
	await assert.rejects(openLedgerContinuation({ ...f, githubToken: "synthetic-token",
		current: current(7005, sha("e")), request: github([anchor, skipped, third]),
		loadCarryArtifact: async () => "unused" }), /order cannot be proved/);
});

test("queued successor and skipped other-actor run do not obstruct the active run", async t => {
	const f = await fixture(t);
	const otherActorSkipped = { ...skipped, actor: { login: "synthetic-bot" } };
	const queuedSuccessor = run(7006, 5, "queued", sha("f"));
	const opened = await openLedgerContinuation({ ...f, githubToken: "synthetic-token",
		current: current(7005, sha("e")),
		request: github([anchor, { ...first, status: "completed", conclusion: "success" },
			otherActorSkipped, third, queuedSuccessor], { step: "skipped" }),
		loadCarryArtifact: async () => { throw Error("should not load a skipped run"); } });
	assert.equal(opened.priorCommittedCny, 4.125);
});

test("private ZIP downloader rejects untrusted redirects and malformed payloads", async () => {
	const badRedirect: typeof fetch = async () => new Response(null, { status: 302,
		headers: { location: "https://example.net/stolen" } });
	await assert.rejects(downloadCarryArtifact({ githubToken: "synthetic-token", artifactId: "9002",
		request: badRedirect }), /untrusted carry archive redirect/);
	const badZip: typeof fetch = async () => new Response(Buffer.from("not a zip"), { status: 200 });
	await assert.rejects(downloadCarryArtifact({ githubToken: "synthetic-token", artifactId: "9002",
		request: badZip }), /archive layout is invalid/);
});

test("private ZIP downloader extracts exactly one bounded carry envelope", async () => {
	const name = Buffer.from(CARRY_FILE_NAME);
	const content = Buffer.from(JSON.stringify({ envelopeB64: "synthetic-envelope" }));
	const local = Buffer.alloc(30);
	local.writeUInt32LE(0x04034b50, 0);
	local.writeUInt16LE(0, 8); // stored
	local.writeUInt32LE(content.length, 18);
	local.writeUInt32LE(content.length, 22);
	local.writeUInt16LE(name.length, 26);
	const central = Buffer.alloc(46);
	central.writeUInt32LE(0x02014b50, 0);
	central.writeUInt16LE(0, 10);
	central.writeUInt32LE(content.length, 20);
	central.writeUInt32LE(content.length, 24);
	central.writeUInt16LE(name.length, 28);
	const cdOffset = local.length + name.length + content.length;
	const eocd = Buffer.alloc(22);
	eocd.writeUInt32LE(0x06054b50, 0);
	eocd.writeUInt16LE(1, 8);
	eocd.writeUInt16LE(1, 10);
	eocd.writeUInt32LE(central.length + name.length, 12);
	eocd.writeUInt32LE(cdOffset, 16);
	const zip = Buffer.concat([local, name, content, central, name, eocd]);
	const request: typeof fetch = async () => new Response(zip, { status: 200 });
	assert.equal(await downloadCarryArtifact({ githubToken: "synthetic-token", artifactId: "9002",
		request }), "synthetic-envelope");
});

test("host audit retains each reservation after a failed prompt without content", () => {
	const budget = new DeepSeekCampaignBudget({ model: "deepseek/deepseek-flash", endpoint: "https://api.deepseek.com",
		providerOutputLimit: TEST_PROVIDER_OUTPUT_LIMIT,
		maxCny: 30, priorCommittedCny: 0, maxProviderCalls: 3, maxProviderCallsPerPrompt: 3,
		maxOutputTokens: 100, outputAccountingMarginTokens: 10,
		estimatedInputCnyPerMillionTokens: 2, estimatedOutputCnyPerMillionTokens: 4,
		estimatedCnyPerUsd: 7 });
	const lease = budget.beginPrompt("synthetic-session", "synthetic-prompt");
	budget.reserve(lease, 100, "synthetic-request");
	const reserved = budget.requestAuditSnapshot();
	assert.equal(reserved.requests.length, 1);
	assert.equal(reserved.requests[0].status, "reserved");
	assert.equal(reserved.inFlightReservedCny, reserved.requests[0].reservedCny);
	budget.failPrompt(lease);
	const failed = budget.requestAuditSnapshot();
	assert.equal(failed.requests[0].status, "unknown");
	assert.equal(failed.unknownReservedCny, failed.requests[0].unknownHeldCny);
	assert.equal(failed.inFlightReservedCny, 0);
	assert.doesNotMatch(JSON.stringify(failed), /synthetic-session|synthetic-prompt/);
});

test("encrypted carry accepts a bounded unsent-request diagnostic without charging it", async t => {
	const f = await fixture(t);
	const evidence = { ...audit(0, 0), admissionRejections: [historicalUnsentRejection()] };
	assert.equal(evidence.requests.length, 0);
	assert.equal(evidence.admissionRejections[0].decision, "input-unaffordable");
	assert.equal(evidence.admissionRejections[0].requestNotSent, true);
	assert.equal(evidence.settledCny, 0);
	assert.equal(evidence.unknownReservedCny, 0);
	const opened = await openLedgerContinuation({ ...f, githubToken: "synthetic-token",
		current: current(7002, sha("b")), request: github([anchor, first]),
		loadCarryArtifact: async () => { throw Error("no carry yet"); } });
	const altered = structuredClone(evidence);
	altered.admissionRejections[0].requestNotSent = false as true;
	assert.throws(() => sealHistoricalCarryForOfflineTests(opened, { settledCny: 0, unknownOrInFlightCny: 0,
		requestAudit: altered }), /accounting/);
	const sealed = sealHistoricalCarryForOfflineTests(opened, { settledCny: 0, unknownOrInFlightCny: 0,
		requestAudit: evidence });
	assert.doesNotMatch(Buffer.from(sealed.envelopeB64, "base64").toString(), /input-unaffordable|private-session|private-prompt/);
	const reopened = await openLedgerContinuation({ ...f, githubToken: "synthetic-token",
		current: current(7003, sha("c")),
		request: github([anchor, { ...first, status: "completed", conclusion: "failure" }, second]),
		loadCarryArtifact: async () => sealed.envelopeB64 });
	assert.equal(reopened.priorCommittedCny, f.payload.priorCommittedCny);
	assert.equal(reopened.priorUnknownHeldCny, 0);
});

test("encrypted carry has byte bounds, not a 1000-request audit count stop", async t => {
	const f = await fixture(t);
	const opened = await openLedgerContinuation({ ...f, githubToken: "synthetic-token",
		current: current(7002, sha("b")), request: github([anchor, first]),
		loadCarryArtifact: async () => { throw Error("no carry yet"); } });
	const requests = Array.from({ length: 1_001 }, (_, index) => ({
		requestId: `synthetic-${index}`, inputPayloadBytes: 100, reservedCny: 0.001,
		status: "settled" as const, settledCny: 0.001, unknownHeldCny: null,
		reportedUsage: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0,
			totalTokens: 20, reportedUsdCost: 0.0001, costStatus: "priced" },
	}));
	const settledCny = requests.reduce((sum, row) => sum + row.settledCny, 0);
	const requestAudit = { requests, settledCny, unknownReservedCny: 0,
		inFlightReservedCny: 0, reservations: requests.length };
	const sealed = sealHistoricalCarryForOfflineTests(opened, { settledCny, unknownOrInFlightCny: 0, requestAudit });
	assert(sealed.envelopeB64.length < 8 * 1024 * 1024);
	const reopened = await openLedgerContinuation({ ...f, githubToken: "synthetic-token",
		current: current(7003, sha("c")),
		request: github([anchor, { ...first, status: "completed", conclusion: "failure" }, second]),
		loadCarryArtifact: async () => sealed.envelopeB64 });
	assert(reopened.priorCommittedCny !== undefined &&
		reopened.priorCommittedCny > f.payload.priorCommittedCny);
});

test("unsent-request diagnostics also have no arbitrary record-count stop", async t => {
	const f = await fixture(t);
	const opened = await openLedgerContinuation({ ...f, githubToken: "synthetic-token",
		current: current(7002, sha("b")), request: github([anchor, first]),
		loadCarryArtifact: async () => { throw Error("no carry yet"); } });
	const rejection = historicalUnsentRejection();
	const requestAudit = { ...audit(0, 0),
		admissionRejections: Array.from({ length: 1_001 }, () => ({ ...rejection,
			pricingBasis: { ...rejection.pricingBasis } })) };
	const sealed = sealHistoricalCarryForOfflineTests(opened, { settledCny: 0, unknownOrInFlightCny: 0, requestAudit });
	assert(sealed.envelopeB64.length < 8 * 1024 * 1024);
});

test("authenticated workflow history may extend beyond twenty GitHub pages", async t => {
	const f = await fixture(t);
	const latest = run(9002, 2002, "in_progress", sha("c"));
	const all = [latest,
		...Array.from({ length: 2000 }, (_, index) => run(9001 - index, 2001 - index,
			"completed", sha("d"), "success")), anchor];
	let pagesRead = 0;
	const prior = github([anchor, first]);
	const request: typeof fetch = async (url, init) => {
		const address = String(url);
		if (address.includes("/workflows/manual-private-campaign.yml/runs?")) {
			const page = Number(new URL(address).searchParams.get("page"));
			pagesRead++;
			return new Response(JSON.stringify({ total_count: all.length,
				workflow_runs: all.slice((page - 1) * 100, page * 100) }), { status: 200 });
		}
		if (/\/runs\/[0-9]+\/jobs\?per_page=100$/.test(address))
			return new Response(JSON.stringify({ total_count: 1, jobs: [{ name: "private-campaign",
				status: "completed", conclusion: "skipped", steps: [{ name: "Run bounded private campaign",
					status: "completed", conclusion: "skipped" }] }] }), { status: 200 });
		return prior(url, init);
	};
	const opened = await openLedgerContinuation({ ...f, githubToken: "synthetic-token",
		current: current(9002, sha("c")), request,
		loadCarryArtifact: async () => { throw Error("no executed carry in skipped history"); } });
	assert.equal(pagesRead, 21);
	assert.equal(opened.priorCommittedCny, f.payload.priorCommittedCny);
});

test("encrypted carry retains reviewed native CNY price evidence without account balances", async t => {
	const f = await fixture(t);
	let profileClock = new Date("2026-10-06T10:30:00.000Z");
	const profile = await verifyDeepSeekCnyBilling({ apiKey: "synthetic-key",
		now: () => profileClock,
		request: async () => new Response(JSON.stringify({ is_available: true,
			balance_infos: [{ currency: "CNY", total_balance: "PRIVATE-AMOUNT",
				granted_balance: "PRIVATE-GRANT", topped_up_balance: "PRIVATE-TOPUP" }] }), { status: 200 }) });
	const providerOutputLimit = await verifyDeepSeekProviderOutputLimit({ apiKey: "synthetic-key",
		request: async () => new Response(JSON.stringify({ object: "list", data: [{ id: "deepseek-flash",
			object: "model", name: "DeepSeek-V4.1-Flash", max_output_tokens: 393_216,
			context_window: 1_048_576 }] }), { status: 200 }) });
	const opened = await openLedgerContinuation({ ...f, githubToken: "synthetic-token",
		current: current(7002, sha("b")), request: github([anchor, first]),
		loadCarryArtifact: async () => { throw Error("no carry yet"); } });
	const observation = { ...audit(0, 0), pricingProfile: nativeCnyPricingRecord(profile),
		providerOutputLimit: providerOutputLimitRecord(providerOutputLimit) };
	const invalid = structuredClone(observation);
	(invalid.pricingProfile.rates as { output: number }).output = 1;
	assert.throws(() => sealHistoricalCarryForOfflineTests(opened, { settledCny: 0, unknownOrInFlightCny: 0,
		requestAudit: invalid }), /accounting/);
	const sealed = sealHistoricalCarryForOfflineTests(opened, { settledCny: 0, unknownOrInFlightCny: 0,
		requestAudit: observation });
	assert.doesNotMatch(Buffer.from(sealed.envelopeB64, "base64").toString(), /PRIVATE-AMOUNT|synthetic-key|DeepSeek-V4.1-Flash/);
	const reopened = await openLedgerContinuation({ ...f, githubToken: "synthetic-token",
		current: current(7003, sha("c")),
		request: github([anchor, { ...first, status: "completed", conclusion: "failure" }, second]),
		loadCarryArtifact: async () => sealed.envelopeB64 });
	assert.equal(reopened.priorCommittedCny, f.payload.priorCommittedCny);
});

test("a completed newer paid run cannot be omitted after out-of-order concurrency admission", async t => {
	const f = await fixture(t);
	const successor = { ...second, status: "completed", conclusion: "success" };
	const base = github([anchor, first, successor]);
	const request: typeof fetch = async (url, init) => String(url).includes("/runs/7003/jobs?")
		? new Response(JSON.stringify({ total_count: 1, jobs: [{ name: "private-campaign", status: "completed",
			conclusion: "success", steps: [{ name: "Run bounded private campaign", status: "completed", conclusion: "success" }] }] }))
		: base(url, init);
	await assert.rejects(openLedgerContinuation({ ...f, githubToken: "synthetic-token",
		current: current(7002, sha("b")), request, loadCarryArtifact: async () => "unused" }),
		/newer workflow run may have executed/);
	const skippedRequest: typeof fetch = async (url, init) => String(url).includes("/runs/7003/jobs?")
		? new Response(JSON.stringify({ total_count: 1, jobs: [{ name: "private-campaign", status: "completed", conclusion: "skipped" }] }))
		: base(url, init);
	assert.equal((await openLedgerContinuation({ ...f, githubToken: "synthetic-token",
		current: current(7002, sha("b")), request: skippedRequest, loadCarryArtifact: async () => "unused" }))
		.priorCommittedCny, 4.125);
	await assert.rejects(openLedgerContinuation({ ...f, githubToken: "synthetic-token",
		current: current(7002, sha("b")), request: github([anchor, first, second]),
		loadCarryArtifact: async () => "unused" }), /newer workflow run may have executed/);
	await assert.rejects(openLedgerContinuation({ ...f, githubToken: "synthetic-token",
		current: current(7002, sha("b")), request: github([anchor, first, { ...second, status: "queued", run_attempt: 2 }]),
		loadCarryArtifact: async () => "unused" }), /newer workflow run disposition is unresolved/);
});

test("paginated freshness requires complete ordered pages through the anchor", async t => {
	const f = await fixture(t);
	const runs = Array.from({ length: 106 }, (_, index) => run(7001 + index, index + 1,
		index === 105 ? "in_progress" : "completed", sha(index === 0 ? "a" : "b"), index === 105 ? undefined : "success"));
	const urls: string[] = [];
	const base = github([anchor, first]);
	const request: typeof fetch = async (url, init) => {
		const address = String(url); urls.push(address);
		if (address.includes("/workflows/")) {
			const page = Number(new URL(address).searchParams.get("page"));
			return new Response(JSON.stringify({ total_count: runs.length,
				workflow_runs: [...runs].reverse().slice((page - 1) * 100, page * 100) }));
		}
		if (address.includes("/jobs?")) return new Response(JSON.stringify({ total_count: 1,
			jobs: [{ name: "private-campaign", status: "completed", conclusion: "skipped" }] }));
		return base(url, init);
	};
	const input = { ...f, githubToken: "synthetic-token", current: current(7106, sha("b")),
		loadCarryArtifact: async () => "unused" };
	assert.equal((await openLedgerContinuation({ ...input, request })).priorCommittedCny, 4.125);
	assert.equal(urls.filter(url => url.includes("/workflows/")).length, 2);
	const short: typeof fetch = async (url, init) => String(url).includes("/workflows/")
		? new Response(JSON.stringify({ total_count: 106, workflow_runs: [runs.at(-1), runs[0]] })) : request(url, init);
	await assert.rejects(openLedgerContinuation({ ...input, request: short }), /page is incomplete/);
	const changed: typeof fetch = async (url, init) => String(url).endsWith("page=2")
		? new Response(JSON.stringify({ total_count: 107, workflow_runs: [...runs].reverse().slice(100) })) : request(url, init);
	await assert.rejects(openLedgerContinuation({ ...input, request: changed }), /changed during pagination/);
	const reordered: typeof fetch = async (url, init) => String(url).endsWith("page=1")
		? new Response(JSON.stringify({ total_count: 106, workflow_runs: [...runs].reverse().slice(0, 100).reverse() })) : request(url, init);
	await assert.rejects(openLedgerContinuation({ ...input, request: reordered }), /not strictly ordered/);
});

test("truncated job/artifact metadata and duplicate provider steps fail closed", async t => {
	const f = await fixture(t);
	const common = { ...f, githubToken: "synthetic-token", current: current(7003, sha("c")),
		loadCarryArtifact: async () => "unused" };
	const base = github([anchor, { ...first, status: "completed", conclusion: "success" }, second], { step: "skipped" });
	for (const kind of ["jobs", "artifacts", "duplicate-step"] as const) {
		const request: typeof fetch = async (url, init) => {
			const response = await base(url, init);
			const value = await response.json() as { total_count: number; jobs: Array<{ steps: Array<{ name: string; status: string; conclusion: string }> }> };
			if (String(url).includes(kind === "artifacts" ? "/artifacts?" : "/jobs?")) {
				if (kind === "duplicate-step") value.jobs[0].steps.push({ name: "Run bounded private campaign", status: "completed", conclusion: "success" });
				else value.total_count = 2;
			}
			return new Response(JSON.stringify(value));
		};
		await assert.rejects(openLedgerContinuation({ ...common, request }), /incomplete|ambiguous/);
	}
});

test("historical over-ceiling unknown observations remain preserved after v3 transition", async t => {
	const f = await fixture(t);
	const firstOpen = await openLedgerContinuation({ ...f, githubToken: "synthetic-token",
		current: current(7002, sha("b")), request: github([anchor, first]), loadCarryArtifact: async () => "unused" });
	const observed = audit(0, 31);
	observed.requests[0].reservedCny = 1;
	const sealed = sealHistoricalCarryForOfflineTests(firstOpen, { settledCny: 0, unknownOrInFlightCny: 31, requestAudit: observed });
	assert.equal(sealed.carryForwardCny, 35.125);
	const restored = await openLedgerContinuation({ ...f, githubToken: "synthetic-token",
		current: current(7003, sha("c")), request: github([anchor, { ...first, status: "completed", conclusion: "failure" }, second]),
		loadCarryArtifact: async () => sealed.envelopeB64 });
	assert.equal(restored.priorCommittedCny, 35.125);
	assert.equal(restored.priorUnknownHeldCny, 31);
	assert.equal(restored.historicalCommittedCny, 35.125);
	assert.equal(restored.historicalUnknownHeldCny, 31);
	assert.equal(restored.priorSettledCny, 0);
	assert.equal(restored.priorUnknownObservedCny, 0);
	assert.equal(sealHistoricalCarryForOfflineTests(restored, { settledCny: 0, unknownOrInFlightCny: 0,
		requestAudit: audit(0, 0) }).carryForwardCny, 35.125);
});

test("audit totals cannot shave small request costs or claim settlement without usage", async t => {
	const f = await fixture(t);
	for (const malformed of ["under-count", "missing-usage"] as const) {
		const opened = await openLedgerContinuation({ ...f, githubToken: "synthetic-token",
			current: current(7002, sha("b")), request: github([anchor, first]), loadCarryArtifact: async () => "unused" });
		const evidence = audit(1, 0);
		if (malformed === "under-count") evidence.settledCny -= 0.00000005;
		else evidence.requests[0].reportedUsage = null;
		assert.throws(() => sealHistoricalCarryForOfflineTests(opened, { settledCny: evidence.settledCny, unknownOrInFlightCny: 0,
			requestAudit: evidence }), /accounting exceeds mission bounds/);
	}
});

test("same-seed checkpoint replay from a different source SHA is rejected", async t => {
	const f = await fixture(t);
	const opened = await openLedgerContinuation({ ...f, githubToken: "synthetic-token",
		current: current(7002, sha("b")), request: github([anchor, first]), loadCarryArtifact: async () => "unused" });
	const sealed = sealHistoricalCarryForOfflineTests(opened, { settledCny: 1, unknownOrInFlightCny: 0, requestAudit: audit(1, 0) });
	await assert.rejects(openLedgerContinuation({ ...f, githubToken: "synthetic-token",
		current: current(7003, sha("c")), request: github([anchor, { ...first, head_sha: sha("f"), status: "completed", conclusion: "success" }, second]),
		loadCarryArtifact: async () => sealed.envelopeB64 }), /authentication failed/);
});

test("download streaming limit cancels an oversized body without buffering it all", async () => {
	let cancelled = false;
	const request: typeof fetch = async () => new Response(new ReadableStream<Uint8Array>({
		pull(controller) { controller.enqueue(new Uint8Array(1024 * 1024)); },
		cancel() { cancelled = true; },
	}));
	await assert.rejects(downloadCarryArtifact({ githubToken: "synthetic-token", artifactId: "9002", request }),
		/carry archive exceeds limit/);
	assert.equal(cancelled, true);
});

test("malformed ZIP directory offsets and multiple disks fail with controlled errors", async () => {
	for (const field of ["offset", "size", "disk"] as const) {
		const zip = Buffer.alloc(90);
		const end = zip.length - 22;
		zip.writeUInt32LE(0x06054b50, end);
		zip.writeUInt16LE(1, end + 8); zip.writeUInt16LE(1, end + 10);
		if (field === "offset") zip.writeUInt32LE(0xffffffff, end + 16);
		if (field === "size") { zip.writeUInt32LE(1, end + 12); zip.writeUInt32LE(end - 1, end + 16); }
		if (field === "disk") zip.writeUInt16LE(1, end + 4);
		const request: typeof fetch = async () => new Response(zip);
		await assert.rejects(downloadCarryArtifact({ githubToken: "synthetic-token", artifactId: "9002", request }),
			/archive (layout|directory) is invalid/);
	}
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
async function rewriteSyntheticCarry(f: Awaited<ReturnType<typeof compactedFixture>>,
	change: (checkpoint: Record<string, any>) => void, legacy = false): Promise<string> {
	const seed = await authenticateSignedMissionSeed({ ...f, envelopeB64: f.seedEnvelopeB64 });
	const key = seed.derivePrivateKey("mul-pis-ledger-continuation-v1");
	const outer = JSON.parse(Buffer.from(f.secondCarry.envelopeB64, "base64").toString());
	const source = { runId: "7003", runAttempt: 1, runNumber: 3, commit: sha("c") };
	const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(outer.nonce, "base64"));
	decipher.setAAD(Buffer.from(JSON.stringify([MISSION_ID, MISSION_REPOSITORY, seed.seedDigest, 2, outer.parentDigest, source])));
	decipher.setAuthTag(Buffer.from(outer.tag, "base64"));
	const cp = JSON.parse(Buffer.concat([decipher.update(Buffer.from(outer.ciphertext, "base64")), decipher.final()]).toString());
	change(cp);
	if (legacy) { cp.version = 1; delete cp.ancestry; }
	const nonce = randomBytes(12);
	const cipher = createCipheriv("aes-256-gcm", key, nonce);
	cipher.setAAD(Buffer.from(JSON.stringify([MISSION_ID, MISSION_REPOSITORY, seed.seedDigest,
		...(legacy ? [] : [2]), cp.parentDigest, source])));
	const encrypted = Buffer.concat([cipher.update(JSON.stringify(cp)), cipher.final()]);
	return Buffer.from(JSON.stringify({ version: legacy ? 1 : 2, ...(!legacy ? { parentDigest: cp.parentDigest } : {}),
		nonce: nonce.toString("base64"), ciphertext: encrypted.toString("base64"), tag: cipher.getAuthTag().toString("base64") })).toString("base64");
}

test("signed root attestation and compacted carry survive expired anchor and ancestor artifacts", async t => {
	const f = await compactedFixture(t);
	const loaded: string[] = [];
	const opened = await openLedgerContinuation({ ...f, githubToken: "synthetic-token", current: current(7005, sha("e")),
		loadCarryArtifact: async ({ artifactId }) => { loaded.push(artifactId); return f.secondCarry.envelopeB64; } });
	assert.deepEqual(loaded, ["9003"]);
	assert.equal(opened.priorCommittedCny, 5.875);
	assert.equal(opened.priorUnknownHeldCny, 0.25);
	assert.equal(opened.priorPrivateBundle?.["candidate.cpp"], "synthetic root evidence");
});

test("compacted carry rejects omissions, wrong identities, broken digests and shaved accounting", async t => {
	const f = await compactedFixture(t);
	for (const change of [
		(cp: Record<string, any>) => { cp.ancestry = []; },
		(cp: Record<string, any>) => { cp.ancestry[0].source.commit = sha("f"); },
		(cp: Record<string, any>) => { cp.ancestry[0].source.runAttempt = 2; },
		(cp: Record<string, any>) => { cp.ancestry[0].envelopeDigest = "b".repeat(64); },
		(cp: Record<string, any>) => { cp.ancestry[0].committedNano -= 1; },
		(cp: Record<string, any>) => { cp.ancestry[0].unknownHeldNano = 0; },
	]) {
		const forged = await rewriteSyntheticCarry(f, change);
		await assert.rejects(openLedgerContinuation({ ...f, githubToken: "synthetic-token", current: current(7005, sha("e")),
			loadCarryArtifact: async () => forged }), /ancestry does not cover|checkpoint accounting is invalid/);
	}
});

test("latest carry expiration still stops recovery and old unauthenticated expiry bypass is refused", async t => {
	const f = await compactedFixture(t);
	const expired: typeof fetch = async (url, init) => String(url).includes("/runs/7003/artifacts?")
		? new Response(JSON.stringify({ total_count: 1, artifacts: [{ id: 9003, name: CARRY_ARTIFACT_NAME,
			expired: true, workflow_run: { id: 7003 } }] })) : f.request(url, init);
	await assert.rejects(openLedgerContinuation({ ...f, githubToken: "synthetic-token", current: current(7005, sha("e")),
		request: expired, loadCarryArtifact: async () => f.secondCarry.envelopeB64 }), /artifact is unavailable/);
	const legacySeed = f.signSeed(f.payload);
	await assert.rejects(openLedgerContinuation({ ...f, seedEnvelopeB64: legacySeed, githubToken: "synthetic-token",
		current: current(7005, sha("e")), loadCarryArtifact: async () => f.secondCarry.envelopeB64 }), /freshness check could not complete/);
	const wrongCommit = f.signSeed({ ...f.payload, version: 2,
		rootReviewedAnchor: { commit: sha("b"), artifactSha256: "e".repeat(64), digestScope: "encrypted-result-envelope" },
		bootstrap: { contractId: "synthetic-original", sourceSha256: "d".repeat(64), format: "deflate-raw-json-v1",
			filesB64: deflateRawSync(JSON.stringify({ "candidate.cpp": "synthetic" })).toString("base64") } });
	await assert.rejects(openLedgerContinuation({ ...f, seedEnvelopeB64: wrongCommit, githubToken: "synthetic-token",
		current: current(7005, sha("e")), loadCarryArtifact: async () => f.secondCarry.envelopeB64 }), /seed freshness is invalid/);
});

test("legacy carry remains readable only with every required old artifact available", async t => {
	const f = await compactedFixture(t);
	const legacy = await rewriteSyntheticCarry(f, () => {}, true);
	await assert.rejects(openLedgerContinuation({ ...f, githubToken: "synthetic-token", current: current(7005, sha("e")),
		loadCarryArtifact: async ({ artifactId }) => artifactId === "9003" ? legacy : f.firstCarry.envelopeB64 }),
		/freshness check could not complete/);
	const request: typeof fetch = async (url, init) => String(url).includes("/runs/7002/artifacts?")
		? new Response(JSON.stringify({ total_count: 1, artifacts: [{ id: 9002, name: CARRY_ARTIFACT_NAME,
			expired: false, workflow_run: { id: 7002 } }] })) : f.request(url, init);
	const opened = await openLedgerContinuation({ ...f, githubToken: "synthetic-token", current: current(7005, sha("e")), request,
		loadCarryArtifact: async ({ artifactId }) => artifactId === "9003" ? legacy : f.firstCarry.envelopeB64 });
	assert.equal(opened.priorCommittedCny, 5.875);
});

test("current push is never admitted, while an authenticated historical push carry remains readable", async t => {
	const f = await fixture(t);
	const request = github([anchor, { ...first, event: "push", head_commit: { message: ONE_USE_PUSH_MARKER },
		status: "completed", conclusion: "success" }, { ...second, event: "push", head_commit: { message: ONE_USE_PUSH_MARKER } }]);
	await assert.rejects(openLedgerContinuation({ ...f, githubToken: "synthetic-token",
		current: { ...current(7003, sha("c")), event: "push", manualAuthorized: undefined }, request,
		loadCarryArtifact: async () => "unused" }), /current Actions identity/);
	const firstOpen = await openLedgerContinuation({ ...f, githubToken: "synthetic-token",
		current: current(7002, sha("b")), request: github([anchor, first]),
		loadCarryArtifact: async () => "unused" });
	const prior = sealHistoricalCarryForOfflineTests(firstOpen, { settledCny: 0,
		unknownOrInFlightCny: 0, requestAudit: audit(0, 0) });
	const accepted = await openLedgerContinuation({ ...f, githubToken: "synthetic-token",
		current: current(7003, sha("c")),
		request: github([anchor, { ...first, event: "push",
			head_commit: { message: ONE_USE_PUSH_MARKER },
			status: "completed", conclusion: "success" }, second]),
		loadCarryArtifact: async () => prior.envelopeB64 });
	assert.equal(accepted.historicalCommittedCny, f.payload.priorCommittedCny);
});

test("reusable control request admits only an exact empty tested source tree", async t => {
	const f = await fixture(t);
	const source = sha("f"), tree = sha("a"), requested = {
		...first, event: "push", head_branch: "run-requests/workflow-learning-reliability",
		head_commit: { message: REUSABLE_RUN_REQUEST_MESSAGE },
	};
	const base = github([anchor, requested]);
	const request: typeof fetch = async (url, init) => {
		const target = String(url);
		if (target.endsWith("/git/ref/heads/improve/workflow-learning-reliability"))
			return new Response(JSON.stringify({ object: { sha: source } }));
		if (target.endsWith(`/git/commits/${sha("b")}`))
			return new Response(JSON.stringify({ parents: [{ sha: source }], tree: { sha: tree } }));
		if (target.endsWith(`/git/commits/${source}`))
			return new Response(JSON.stringify({ parents: [], tree: { sha: tree } }));
		if (target.includes("/actions/workflows/workflow-regression.yml/runs?"))
			return new Response(JSON.stringify({ workflow_runs: [{ head_sha: source,
				head_branch: "improve/workflow-learning-reliability", event: "push",
				run_attempt: 1, conclusion: "success" }] }));
		return base(url, init);
	};
	const proposed = { ...current(7002, sha("b")), event: "push", before: source,
		ref: "refs/heads/run-requests/workflow-learning-reliability" };
	const input = { ...f, githubToken: "synthetic-token", current: proposed, request,
		loadCarryArtifact: async () => { throw Error("no earlier executed carry"); } };
	assert.equal((await openLedgerContinuation(input)).mode, "accounting-only");
	await assert.rejects(openLedgerContinuation({ ...input,
		current: { ...proposed, actor: "someone-else" } }), /current Actions identity/);
	await assert.rejects(openLedgerContinuation({ ...input,
		current: { ...proposed, ref: "refs/heads/improve/workflow-learning-reliability" } }), /current Actions identity/);
	await assert.rejects(openLedgerContinuation({ ...input, request: async (url, init) => {
		if (String(url).includes("/actions/workflows/manual-private-campaign.yml/runs?"))
			return new Response(JSON.stringify({ total_count: 2, workflow_runs: [
				{ ...requested, head_commit: { message: ONE_USE_PUSH_MARKER } }, anchor] }));
		return request(url, init);
	} }), /workflow identity or signed seed freshness/);
	await assert.rejects(openLedgerContinuation({ ...input, current: { ...proposed, before: sha("d") } }),
		/not a fast-forward empty commit/);
	const failedCi: typeof fetch = async (url, init) => String(url).includes("/actions/workflows/workflow-regression.yml/runs?")
		? new Response(JSON.stringify({ workflow_runs: [] })) : request(url, init);
	await assert.rejects(openLedgerContinuation({ ...input, request: failedCi }), /lacks a successful offline regression/);
});

test("next request fast-forwards the prior control ref while selecting a newly tested source", async t => {
	const f = await fixture(t), source = sha("e"), tree = sha("a"), before = sha("b");
	const prior = { ...run(7002, 2, "completed", before, "success"), event: "push",
		head_branch: "run-requests/workflow-learning-reliability",
		head_commit: { message: REUSABLE_RUN_REQUEST_MESSAGE } };
	const proposed = { ...second, event: "push", head_branch: "run-requests/workflow-learning-reliability",
		head_commit: { message: REUSABLE_RUN_REQUEST_MESSAGE } };
	const base = github([anchor, prior, proposed], { step: "skipped" });
	const request: typeof fetch = async (url, init) => {
		const target = String(url);
		if (target.endsWith("/git/ref/heads/improve/workflow-learning-reliability"))
			return new Response(JSON.stringify({ object: { sha: source } }));
		if (target.endsWith(`/git/commits/${sha("c")}`))
			return new Response(JSON.stringify({ parents: [{ sha: source }, { sha: before }], tree: { sha: tree } }));
		if (target.endsWith(`/git/commits/${source}`))
			return new Response(JSON.stringify({ parents: [], tree: { sha: tree } }));
		if (target.includes("/actions/workflows/workflow-regression.yml/runs?"))
			return new Response(JSON.stringify({ workflow_runs: [{ head_sha: source,
				head_branch: "improve/workflow-learning-reliability", event: "push",
				run_attempt: 1, conclusion: "success" }] }));
		return base(url, init);
	};
	const opened = await openLedgerContinuation({ ...f, githubToken: "synthetic-token", request,
		current: { ...current(7003, sha("c")), event: "push", before,
			ref: "refs/heads/run-requests/workflow-learning-reliability" },
		loadCarryArtifact: async () => { throw Error("skipped prior control job has no carry"); } });
	assert.equal(opened.mode, "accounting-only");
});

test("historical v2 seeds without root attestation keep their old availability requirement", async t => {
	const f = await fixture(t);
	const seedEnvelopeB64 = f.signSeed({ ...f.payload, version: 2,
		bootstrap: { contractId: "synthetic-original", sourceSha256: "d".repeat(64), format: "deflate-raw-json-v1",
			filesB64: deflateRawSync(JSON.stringify({ "candidate.cpp": "synthetic historical evidence" })).toString("base64") } });
	const base = github([anchor, first]);
	const input = { ...f, seedEnvelopeB64, githubToken: "synthetic-token", current: current(7002, sha("b")),
		loadCarryArtifact: async () => "unused" };
	assert.equal((await openLedgerContinuation({ ...input, request: base })).priorCommittedCny, 4.125);
	const expired: typeof fetch = async (url, init) => String(url).includes("/runs/7001/artifacts?")
		? new Response(JSON.stringify({ total_count: 1, artifacts: [{ id: 9001, name: MISSION_ARTIFACT,
			expired: true, workflow_run: { id: 7001 } }] })) : base(url, init);
	await assert.rejects(openLedgerContinuation({ ...input, request: expired }), /artifact is unavailable/);
});

test("authenticated prior carry proof is immutable, bundle-bound, and distinct from raw model JSON", async t => {
	const f = await compactedFixture(t);
	const opened = await openLedgerContinuation({ ...f, githubToken: "synthetic-token", current: current(7005, sha("e")),
		loadCarryArtifact: async () => f.secondCarry.envelopeB64 });
	const proof = opened.priorCarryProof;
	assert(proof);
	assert(isAuthenticatedPriorCarryProof(proof));
	assert.equal(isAuthenticatedPriorCarryProof({ ...proof }), false);
	assert.equal(isAuthenticatedPriorCarryProof(JSON.parse(JSON.stringify(proof))), false);
	assert.equal(authenticatedPriorCarryBindsBundle(proof, opened.priorPrivateBundle), true);
	assert.equal(authenticatedPriorCarryBindsBundle(proof, { "candidate.cpp": "changed evidence" }), false);
	assert.deepEqual(proof.source, { runId: "7003", runAttempt: 1, runNumber: 3, commit: sha("c") });
	assert.equal(proof.envelopeSha256, createHash("sha256").update(Buffer.from(f.secondCarry.envelopeB64, "base64")).digest("hex"));
	assert.deepEqual(proof.artifact, { repository: MISSION_REPOSITORY, artifactId: "9003", artifactName: CARRY_ARTIFACT_NAME, runId: "7003" });
	assert.equal(proof.terminal.jobId, "6003");
	assert.equal(proof.terminal.jobRunId, "7003");
	assert.equal(proof.terminal.jobHeadSha, sha("c"));
	assert.equal(proof.terminal.jobStatus, "completed");
	assert.equal(proof.admittedCurrent.runId, "7005");
	assert.equal(proof.priorCommittedCny, opened.priorCommittedCny);
	assert.equal(proof.priorUnknownHeldCny, 0.25);
	assert.throws(() => { (proof.source as { commit: string }).commit = sha("a"); }, TypeError);
	assert.throws(() => { (proof.terminal as { jobId: string }).jobId = "0"; }, TypeError);
	assert.doesNotMatch(JSON.stringify(proof), /synthetic root evidence|synthetic-token|signature_b64|payload_b64/);
});

test("missing or mismatched terminal job metadata cannot mint restart proof", async t => {
	const f = await compactedFixture(t);
	for (const change of [
		(job: Record<string, unknown>) => { delete job.id; },
		(job: Record<string, unknown>) => { job.run_id = 7002; },
		(job: Record<string, unknown>) => { job.run_attempt = 2; },
		(job: Record<string, unknown>) => { job.head_sha = sha("a"); },
	]) {
		const request: typeof fetch = async (url, init) => {
			const response = await f.request(url, init);
			if (!String(url).includes("/runs/7003/jobs?")) return response;
			const body = await response.json() as { jobs: Array<Record<string, unknown>> };
			change(body.jobs[0]);
			return new Response(JSON.stringify(body));
		};
		const opened = await openLedgerContinuation({ ...f, request, githubToken: "synthetic-token",
			current: current(7005, sha("e")), loadCarryArtifact: async () => f.secondCarry.envelopeB64 });
		assert.equal(opened.priorCarryProof, undefined);
		assert.equal(opened.priorUnknownHeldCny, 0.25);
		await assert.rejects(opened.claimOneUse("0".repeat(64)), /exact authenticated prior carry/);
	}
});

test("result artifact proof uses only the exact GitHub archive digest and source identity", async t => {
	const f = await compactedFixture(t);
	for (const variation of ["valid", "missing-digest", "wrong-commit", "expired", "duplicate"] as const) {
		const request: typeof fetch = async (url, init) => {
			const response = await f.request(url, init);
			if (!String(url).includes("/runs/7003/artifacts?")) return response;
			const body = await response.json() as { total_count: number; artifacts: object[] };
			const result = { id: 9103, name: MISSION_ARTIFACT, expired: variation === "expired",
				...(variation === "missing-digest" ? {} : { digest: `sha256:${"d".repeat(64)}` }),
				workflow_run: { id: 7003, head_sha: sha(variation === "wrong-commit" ? "b" : "c") } };
			body.artifacts.push(result);
			if (variation === "duplicate") body.artifacts.push({ ...result, id: 9203 });
			body.total_count = body.artifacts.length;
			return new Response(JSON.stringify(body));
		};
		const opened = await openLedgerContinuation({ ...f, request, githubToken: "synthetic-token",
			current: current(7005, sha("e")), loadCarryArtifact: async () => f.secondCarry.envelopeB64 });
		assert(opened.priorCarryProof);
		if (variation !== "valid") { assert.equal(opened.priorCarryProof.resultArtifact, undefined); continue; }
		assert.deepEqual(opened.priorCarryProof.resultArtifact, { repository: MISSION_REPOSITORY, artifactId: "9103",
			artifactName: MISSION_ARTIFACT, runId: "7003", archiveSha256: "d".repeat(64), digestScope: "github-artifact-archive" });
		assert(Object.isFrozen(opened.priorCarryProof.resultArtifact));
	}
});

test("Actions-backed restart claim is one-use, live-job-bound, and never refunds unknown holds", async t => {
	const f = await compactedFixture(t);
	let active = false;
	let jobMatches = false;
	let stepActive = false;
	const request: typeof fetch = async (url, init) => {
		const address = String(url);
		if (address.endsWith("/runs/7005")) return new Response(JSON.stringify({ ...third, status: active ? "in_progress" : "completed" }));
		if (address.includes("/runs/7005/jobs?")) return new Response(JSON.stringify({ total_count: 1, jobs: [{
			id: 6005, run_id: jobMatches ? 7005 : 7003, run_attempt: 1, head_sha: sha("e"), name: "private-campaign", status: "in_progress",
			steps: [{ name: "Run bounded private campaign", status: stepActive ? "in_progress" : "completed" }],
		}] }));
		return f.request(url, init);
	};
	const input = { ...f, request, githubToken: "synthetic-token", current: current(7005, sha("e")),
		loadCarryArtifact: async () => f.secondCarry.envelopeB64 };
	const opened = await openLedgerContinuation(input);
	const duplicate = await openLedgerContinuation(input);
	const proof = opened.priorCarryProof!;
	await assert.rejects(opened.claimOneUse("0".repeat(64)), /exact authenticated prior carry/);
	await assert.rejects(opened.claimOneUse(proof.envelopeSha256), /no longer active/);
	active = true;
	await assert.rejects(opened.claimOneUse(proof.envelopeSha256), /job identity is incomplete/);
	jobMatches = true;
	await assert.rejects(opened.claimOneUse(proof.envelopeSha256), /job identity is incomplete/);
	stepActive = true;
	const outcomes = await Promise.allSettled([opened.claimOneUse(proof.envelopeSha256), duplicate.claimOneUse(proof.envelopeSha256)]);
	assert(outcomes[0].status === "fulfilled");
	assert(outcomes[1].status === "rejected");
	const claim = outcomes[0].value;
	assert.equal(claim.priorEnvelopeSha256, proof.envelopeSha256);
	assert.equal(claim.currentJobId, "6005");
	assert.equal(claim.currentRunId, "7005");
	assert.equal(claim.currentCommit, sha("e"));
	assert.match(claim.claimId, /^[0-9a-f]{64}$/);
	assert(Object.isFrozen(claim));
	await assert.rejects(opened.claimOneUse(proof.envelopeSha256), /already consumed/);
	await assert.rejects(duplicate.claimOneUse(proof.envelopeSha256), /already consumed/);
	assert.equal(opened.priorUnknownHeldCny, 0.25);
	assert.equal(sealHistoricalCarryForOfflineTests(opened, { settledCny: 0, unknownOrInFlightCny: 0,
		requestAudit: audit(0, 0) }).carryForwardCny, 5.875);
});

test("control-ref request claims an authenticated prior carry while its current provider step is active", async t => {
	const f = await compactedFixture(t);
	const source = sha("f"), tree = sha("a"), before = source;
	const control = { ...third, event: "push", head_branch: "run-requests/workflow-learning-reliability",
		head_commit: { message: REUSABLE_RUN_REQUEST_MESSAGE } };
	const request: typeof fetch = async (url, init) => {
		const target = String(url);
		if (target.includes("/actions/workflows/manual-private-campaign.yml/runs?"))
			return new Response(JSON.stringify({ total_count: 4, workflow_runs: [control,
				{ ...second, status: "completed", conclusion: "success" },
				{ ...first, status: "completed", conclusion: "success" }, anchor] }));
		if (target.endsWith("/git/ref/heads/improve/workflow-learning-reliability"))
			return new Response(JSON.stringify({ object: { sha: source } }));
		if (target.endsWith(`/git/commits/${sha("e")}`))
			return new Response(JSON.stringify({ parents: [{ sha: source }], tree: { sha: tree } }));
		if (target.endsWith(`/git/commits/${source}`))
			return new Response(JSON.stringify({ parents: [], tree: { sha: tree } }));
		if (target.includes("/actions/workflows/workflow-regression.yml/runs?"))
			return new Response(JSON.stringify({ workflow_runs: [{ head_sha: source,
				head_branch: "improve/workflow-learning-reliability", event: "push",
				run_attempt: 1, conclusion: "success" }] }));
		if (target.endsWith("/runs/7005")) return new Response(JSON.stringify(control));
		if (target.endsWith("/runs/7005/jobs?per_page=100")) return new Response(JSON.stringify({
			total_count: 1, jobs: [{ id: 6005, run_id: 7005, run_attempt: 1,
				head_sha: sha("e"), name: "private-campaign", status: "in_progress",
				steps: [{ name: "Run private campaign", status: "in_progress" }] }] }));
		return f.request(url, init);
	};
	const opened = await openLedgerContinuation({ ...f, githubToken: "synthetic-token", request,
		current: { ...current(7005, sha("e")), event: "push", before,
			ref: "refs/heads/run-requests/workflow-learning-reliability" },
		loadCarryArtifact: async () => f.secondCarry.envelopeB64 });
	const proof = opened.priorCarryProof!;
	assert(proof);
	const claim = await opened.claimOneUse(proof.envelopeSha256);
	assert.equal(claim.currentRunId, "7005");
	assert.equal(claim.currentCommit, sha("e"));
	assert.equal(claim.priorEnvelopeSha256, proof.envelopeSha256);
});

test("branded ancestry predicate binds only exact authenticated source and carry digest", async t => {
	const f = await compactedFixture(t);
	const opened = await openLedgerContinuation({ ...f, githubToken: "synthetic-token", current: current(7005, sha("e")),
		loadCarryArtifact: async () => f.secondCarry.envelopeB64 });
	const proof = opened.priorCarryProof!;
	const ancestor = { runId: "7002", runAttempt: 1, commit: sha("b") };
	const envelopeSha256 = createHash("sha256").update(Buffer.from(f.firstCarry.envelopeB64, "base64")).digest("hex");
	assert.equal(authenticatedPriorCarryBindsAncestor(proof, ancestor, envelopeSha256), true);
	assert.equal(authenticatedPriorCarryBindsAncestor(proof, { ...ancestor, runNumber: 2 }, envelopeSha256), true);
	assert.equal(authenticatedPriorCarryBindsAncestor(proof, proof.source, proof.envelopeSha256), true);
	for (const source of [
		{ ...ancestor, runId: "7004" }, { ...ancestor, runAttempt: 2 }, { ...ancestor, commit: sha("f") },
		{ ...ancestor, runNumber: 3 }, { ...ancestor, runAttempt: "1" }, { ...ancestor, inferred: true }, {},
	]) assert.equal(authenticatedPriorCarryBindsAncestor(proof, source, envelopeSha256), false);
	assert.equal(authenticatedPriorCarryBindsAncestor(proof, ancestor, "d".repeat(64)), false);
	assert.equal(authenticatedPriorCarryBindsAncestor({ ...proof }, ancestor, envelopeSha256), false);
	assert.equal(authenticatedPriorCarryBindsAncestor(JSON.parse(JSON.stringify(proof)), ancestor, envelopeSha256), false);
	assert.equal(authenticatedPriorCarryBindsAncestor(proof, { runId: "7001", runAttempt: 1, commit: sha("a") }, envelopeSha256), false);
	assert.equal(opened.priorUnknownHeldCny, 0.25);
	assert.equal(sealHistoricalCarryForOfflineTests(opened, { settledCny: 0, unknownOrInFlightCny: 0,
		requestAudit: audit(0, 0) }).carryForwardCny, 5.875);
});

test("zero-activity v3 wrapper authenticates exact legacy bundle before carrying restart facts", async t => {
	const f = await compactedFixture(t);
	const opened = await openLedgerContinuation({ ...f, githubToken: "synthetic-token",
		current: current(7005, sha("e")), loadCarryArtifact: async () => f.secondCarry.envelopeB64 });
	const emptyAudit = { version: 3 as const, kind: "accounting-only-request-audit" as const,
		requests: [], settledCny: 0, unknownObservedCny: 0, unpricedRequestCount: 0 };
	const wrapped = opened.sealCurrent({ settledCny: 0, unknownObservedCny: 0,
		unpricedRequestCount: 0, requestAudit: emptyAudit });
	const nextRun = run(7006, 5, "in_progress", sha("f"));
	const base = github([anchor, { ...first, status: "completed", conclusion: "success" },
		{ ...second, status: "completed", conclusion: "success" },
		{ ...third, status: "completed", conclusion: "failure" }, nextRun]);
	const request: typeof fetch = async (url, init) => {
		const address = String(url);
		if (address.includes("/runs/7003/jobs?") || address.includes("/runs/7003/artifacts?"))
			return f.request(url, init);
		if (address.includes("/runs/7005/jobs?")) return new Response(JSON.stringify({ total_count: 1,
			jobs: [{ id: 6005, run_id: 7005, run_attempt: 1, head_sha: sha("e"),
				name: "private-campaign", status: "completed", conclusion: "failure",
				steps: [{ name: "Run private campaign", status: "completed", conclusion: "failure" }] }] }));
		if (address.includes("/runs/7005/artifacts?")) return new Response(JSON.stringify({ total_count: 2,
			artifacts: [{ id: 9005, name: CARRY_ARTIFACT_NAME, expired: false,
				workflow_run: { id: 7005, head_sha: sha("e") } },
				{ id: 9105, name: MISSION_ARTIFACT, expired: false, digest: `sha256:${"d".repeat(64)}`,
					workflow_run: { id: 7005, head_sha: sha("e") } }] }));
		return base(url, init);
	};
	const reopen = async (envelopeB64: string, legacyEnvelope = f.secondCarry.envelopeB64) =>
		openLedgerContinuation({ ...f, githubToken: "synthetic-token", request,
			current: current(7006, sha("f")), loadCarryArtifact: async ({ artifactId }) =>
				artifactId === "9005" ? envelopeB64 : legacyEnvelope });
	const passThrough = await reopen(wrapped.envelopeB64);
	const proof = passThrough.priorCarryProof!;
	assert.equal(proof.version, 2);
	assert.equal(proof.source.runId, "7005");
	assert.equal(proof.envelopeSha256,
		createHash("sha256").update(Buffer.from(wrapped.envelopeB64, "base64")).digest("hex"));
	assert.deepEqual(authenticatedCarryForwardOrigin(proof, passThrough.priorPrivateBundle), {
		source: { runId: "7003", runAttempt: 1, runNumber: 3, commit: sha("c") },
		envelopeSha256: createHash("sha256").update(Buffer.from(f.secondCarry.envelopeB64, "base64")).digest("hex"),
		historicalCommittedNano: 5_875_000_000, historicalUnknownHeldNano: 250_000_000 });
	assert.equal(authenticatedCarryForwardOrigin({ ...proof }, passThrough.priorPrivateBundle), undefined);
	assert.equal(authenticatedCarryForwardOrigin(proof, { "candidate.cpp": "changed" }), undefined);
	const changed = await openLedgerContinuation({ ...f, githubToken: "synthetic-token",
		current: current(7005, sha("e")), loadCarryArtifact: async () => f.secondCarry.envelopeB64 });
	const changedCarry = changed.sealCurrent({ settledCny: 0, unknownObservedCny: 0,
		unpricedRequestCount: 0, requestAudit: emptyAudit,
		privateBundle: { "candidate.cpp": "different goal evidence" } });
	const changedNext = await reopen(changedCarry.envelopeB64);
	assert.equal(authenticatedCarryForwardOrigin(changedNext.priorCarryProof,
		changedNext.priorPrivateBundle), undefined);
	const requestBearing = await openLedgerContinuation({ ...f, githubToken: "synthetic-token",
		current: current(7005, sha("e")), loadCarryArtifact: async () => f.secondCarry.envelopeB64 });
	const observedRequest = requestBearing.sealCurrent({ settledCny: 0, unknownObservedCny: 0,
		unpricedRequestCount: 1, requestAudit: { ...emptyAudit, unpricedRequestCount: 1,
			requests: [{ requestId: "synthetic-request", inputPayloadBytes: 1, status: "in-flight" as const,
				settledCny: null, unknownObservedCny: null, reportedUsage: null }] } });
	const requestNext = await reopen(observedRequest.envelopeB64);
	assert.equal(authenticatedCarryForwardOrigin(requestNext.priorCarryProof,
		requestNext.priorPrivateBundle), undefined);
	const seed = await authenticateSignedMissionSeed({ ...f, envelopeB64: f.seedEnvelopeB64 });
	const key = seed.derivePrivateKey("mul-pis-ledger-continuation-v1");
	const outer = JSON.parse(Buffer.from(wrapped.envelopeB64, "base64").toString());
	const source = { runId: "7005", runAttempt: 1, runNumber: 4, commit: sha("e") };
	const oldCipher = createDecipheriv("aes-256-gcm", key, Buffer.from(outer.nonce, "base64"));
	oldCipher.setAAD(Buffer.from(JSON.stringify([MISSION_ID, MISSION_REPOSITORY,
		seed.seedDigest, 3, outer.parentDigest, source])));
	oldCipher.setAuthTag(Buffer.from(outer.tag, "base64"));
	const tampered = JSON.parse(Buffer.concat([oldCipher.update(Buffer.from(outer.ciphertext, "base64")),
		oldCipher.final()]).toString());
	tampered.historical.committedNano++;
	const nonce = randomBytes(12);
	const newCipher = createCipheriv("aes-256-gcm", key, nonce);
	newCipher.setAAD(Buffer.from(JSON.stringify([MISSION_ID, MISSION_REPOSITORY,
		seed.seedDigest, 3, outer.parentDigest, source])));
	const ciphertext = Buffer.concat([newCipher.update(JSON.stringify(tampered)), newCipher.final()]);
	const changedHistory = Buffer.from(JSON.stringify({ ...outer, nonce: nonce.toString("base64"),
		ciphertext: ciphertext.toString("base64"), tag: newCipher.getAuthTag().toString("base64") })).toString("base64");
	await assert.rejects(reopen(changedHistory), /historical commitment transition is invalid/);
	const wrongLegacy = await reopen(wrapped.envelopeB64, f.firstCarry.envelopeB64);
	assert.equal(authenticatedCarryForwardOrigin(wrongLegacy.priorCarryProof,
		wrongLegacy.priorPrivateBundle), undefined);
	const pinned = passThrough.sealCurrent({ settledCny: 0, unknownObservedCny: 0,
		unpricedRequestCount: 0, requestAudit: emptyAudit });
	const last = run(7007, 6, "in_progress", sha("1"));
	const laterRequest: typeof fetch = async (url, init) => {
		const address = String(url);
		if (address.includes("/workflows/manual-private-campaign.yml/runs?"))
			return new Response(JSON.stringify({ total_count: 6, workflow_runs: [last,
				{ ...nextRun, status: "completed", conclusion: "failure" },
				{ ...third, status: "completed", conclusion: "failure" },
				{ ...second, status: "completed", conclusion: "success" },
				{ ...first, status: "completed", conclusion: "success" }, anchor] }));
		if (address.includes("/runs/7006/jobs?")) return new Response(JSON.stringify({ total_count: 1,
			jobs: [{ id: 6006, run_id: 7006, run_attempt: 1, head_sha: sha("f"),
				name: "private-campaign", status: "completed", conclusion: "failure",
				steps: [{ name: "Run private campaign", status: "completed", conclusion: "failure" }] }] }));
		if (address.includes("/runs/7006/artifacts?")) return new Response(JSON.stringify({ total_count: 2,
			artifacts: [{ id: 9006, name: CARRY_ARTIFACT_NAME, expired: false,
				workflow_run: { id: 7006, head_sha: sha("f") } },
				{ id: 9106, name: MISSION_ARTIFACT, expired: false, digest: `sha256:${"e".repeat(64)}`,
					workflow_run: { id: 7006, head_sha: sha("f") } }] }));
		if (address.includes("/runs/7003/artifacts?"))
			throw Error("old origin artifact intentionally unavailable");
		return request(url, init);
	};
	const later = await openLedgerContinuation({ ...f, githubToken: "synthetic-token",
		request: laterRequest, current: current(7007, sha("1")),
		loadCarryArtifact: async ({ artifactId }) => {
			assert.equal(artifactId, "9006"); return pinned.envelopeB64;
		} });
	assert.deepEqual(authenticatedCarryForwardOrigin(later.priorCarryProof, later.priorPrivateBundle),
		authenticatedCarryForwardOrigin(proof, passThrough.priorPrivateBundle));
});

test("complete received host-effect census brands a nonzero v3 carry without releasing old holds", async t => {
	const f = await fixture(t);
	const contract = { version: 1, kind: "original-objective", id: "old-contract" };
	const oldCheckpoint = { version: 1, kind: "original-objective-progress", contract,
		selectedArtifacts: ["candidate.cpp", "verification.json", "workflow-archive.json"],
		boundedRuns: [{ runId: "selected-goal", outcome: "partial", selectedTaskId: "T001",
			acceptedTaskIds: ["T001"], unresolvedOperationIds: [] },
			{ runId: "old-goal", outcome: "active", unresolvedOperationIds: ["O001", "O002"] }],
		continuation: { requiresOperationReconciliation: true,
			unresolvedOperationIds: ["old-goal/O001", "old-goal/O002"] } };
	const oldBundle = { "candidate.cpp": "old selected source", "verification.json": "{}",
		"workflow-archive.json": "{}", "original-objective.json": JSON.stringify(contract),
		"objective-checkpoint.json": JSON.stringify(oldCheckpoint),
		"independent-restart-quarantine.json": JSON.stringify({ version: 1,
			kind: "host-independent-restart-reservations", entries: [] }),
		"independent-restart-goal-binding.json": JSON.stringify({ version: 1,
			kind: "host-independent-restart-goal-bindings", entries: [] }) };
	const seedEnvelopeB64 = f.signSeed({ ...f.payload, version: 2,
		rootReviewedAnchor: { commit: sha("a"), artifactSha256: "e".repeat(64),
			digestScope: "encrypted-result-envelope" },
		bootstrap: { contractId: "old-contract", sourceSha256: "d".repeat(64),
			format: "deflate-raw-json-v1", filesB64: deflateRawSync(JSON.stringify(oldBundle)).toString("base64") } });
	const firstOpened = await openLedgerContinuation({ ...f, seedEnvelopeB64,
		githubToken: "synthetic-token", current: current(7002, sha("b")),
		request: github([anchor, first]), loadCarryArtifact: async () => "unused" });
	const legacy = sealHistoricalCarryForOfflineTests(firstOpened, { settledCny: 0,
		unknownOrInFlightCny: 0.25, requestAudit: audit(0, 0.25) });
	const firstDone = { ...first, status: "completed", conclusion: "failure" };
	const zeroOpened = await openLedgerContinuation({ ...f, seedEnvelopeB64,
		githubToken: "synthetic-token", current: current(7003, sha("c")),
		request: github([anchor, firstDone, second]),
		loadCarryArtifact: async () => legacy.envelopeB64 });
	const emptyAudit = { version: 3 as const, kind: "accounting-only-request-audit" as const,
		requests: [], settledCny: 0, unknownObservedCny: 0, unpricedRequestCount: 0 };
	const zero = zeroOpened.sealCurrent({ settledCny: 0, unknownObservedCny: 0,
		unpricedRequestCount: 0, requestAudit: emptyAudit });
	const secondDone = { ...second, status: "completed", conclusion: "failure" };
	const work = run(7005, 4, "in_progress", sha("e"));
	const next = run(7006, 5, "in_progress", sha("f"));
	const requestFor = (runs: object[]): typeof fetch => {
		const base = github(runs);
		return async (url, init) => {
			const address = String(url);
			for (const [id, commit, artifactId] of [[7003, sha("c"), 9003],
				[7005, sha("e"), 9005], [7006, sha("f"), 9006],
				[7007, sha("1"), 9007]] as const) {
				if (address.includes(`/runs/${id}/jobs?`)) return new Response(JSON.stringify({ total_count: 1,
					jobs: [{ id: id + 1000, run_id: id, run_attempt: 1, head_sha: commit,
						name: "private-campaign", status: "completed", conclusion: "failure",
						steps: [{ name: "Run private campaign", status: "completed", conclusion: "failure" }] }] }));
				if (address.includes(`/runs/${id}/artifacts?`)) return new Response(JSON.stringify({ total_count: 2,
					artifacts: [{ id: artifactId, name: CARRY_ARTIFACT_NAME, expired: false,
						workflow_run: { id, head_sha: commit } },
						{ id: artifactId + 100, name: MISSION_ARTIFACT, expired: false,
							digest: `sha256:${"a".repeat(64)}`, workflow_run: { id, head_sha: commit } }] }));
			}
			return base(url, init);
		};
	};
	const workOpened = await openLedgerContinuation({ ...f, seedEnvelopeB64,
		githubToken: "synthetic-token", current: current(7005, sha("e")),
		request: requestFor([anchor, firstDone, secondDone, work]),
		loadCarryArtifact: async ({ artifactId }) => artifactId === "9003" ? zero.envelopeB64 : legacy.envelopeB64 });
	assert(authenticatedCarryForwardOrigin(workOpened.priorCarryProof, workOpened.priorPrivateBundle));
	const profile = await verifyDeepSeekCnyBilling({ apiKey: "synthetic-key",
		now: () => new Date("2026-10-06T10:30:00.000Z"),
		request: async () => new Response(JSON.stringify({ is_available: true,
			balance_infos: [{ currency: "CNY", total_balance: "PRIVATE-AMOUNT",
				granted_balance: "PRIVATE-GRANT", topped_up_balance: "PRIVATE-TOPUP" }] }),
			{ status: 200 }) });
	const executionSession = campaignSessionEffectId("exec session");
	const researchSession = campaignSessionEffectId("read-only session");
	const rows = Array.from({ length: 130 }, (_, index) => ({ requestId: `request-${index + 1}`,
		sessionId: index % 2 ? researchSession : executionSession, responseReceived: true,
		inputPayloadBytes: 100,
		status: "settled" as const, settledCny: index === 0 ? 0.5 : 0,
		unknownObservedCny: null,
		reportedUsage: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0,
			totalTokens: 20, reportedUsdCost: 0.01, costStatus: "priced" } }));
	const requestAudit = { ...emptyAudit, requests: rows, settledCny: 0.5,
		pricingProfile: nativeCnyPricingRecord(profile) };
	const priorEnvelopeSha256 = createHash("sha256").update(Buffer.from(zero.envelopeB64, "base64")).digest("hex");
	const ws = new Workspace(path.join(path.dirname(f.publicKeyFile), "host-census"));
	const goalDir = ws.runDir("M07", "new-goal");
	await mkdir(goalDir, { recursive: true });
	await writeFile(path.join(goalDir, "run.json"), "{}\n");
	await writeFile(path.join(goalDir, "goal.json"), JSON.stringify({ runId: "new-goal",
		outcome: "partial", tasks: [{ taskId: "T001", mode: "execute", status: "rejected",
			session: { id: "exec session" } }],
		executionState: { operations: [{ id: "O001", taskId: "T001",
			status: "response-received" }] } }));
	const grant = { version: 1 as const, kind: "confined-campaign-files" as const,
		root: "/tmp/synthetic/T001", writableFiles: ["candidate.cpp", "lesson-delta.json"] };
	const receipt = await offlineChecks.buildHostEffectReceipt({ ws,
		source: { runId: "7005", runAttempt: 1, commit: sha("e") }, priorEnvelopeSha256,
		historicalGoalRunIds: oldCheckpoint.boundedRuns.map(row => row.runId), requestIds: rows.map(row => row.requestId),
		sessions: new Map([
			["exec session", { sessionId: "exec session", grantKind: "confined-execution" as const,
				taskId: "T001", workRoot: grant.root, grant }],
			["read-only session", { sessionId: "read-only session", grantKind: "read-dir" as const }],
		]) });
	const nextBundle = { ...oldBundle,
		"objective-checkpoint.json": JSON.stringify({ boundedRuns: [...oldCheckpoint.boundedRuns,
			{ runId: "new-goal", outcome: "partial", unresolvedOperationIds: [] }] }),
		"host-effect-receipt.json": JSON.stringify(receipt) };
	const sealed = workOpened.sealCurrent({ settledCny: 0.5, unknownObservedCny: 0,
		unpricedRequestCount: 0, requestAudit, privateBundle: nextBundle });
	const resumed = await openLedgerContinuation({ ...f, seedEnvelopeB64,
		githubToken: "synthetic-token", current: current(7006, sha("f")),
		request: requestFor([anchor, firstDone, secondDone,
			{ ...work, status: "completed", conclusion: "failure" }, next]),
		loadCarryArtifact: async () => sealed.envelopeB64 });
	assert.equal(resumed.priorSettledCny, 0.5);
	assert.equal(resumed.historicalUnknownHeldCny, 0.25);
	assert.equal(authenticatedCarryForwardOrigin(resumed.priorCarryProof, resumed.priorPrivateBundle), undefined);
	const evidence = authenticatedHostEffectEvidence(resumed.priorCarryProof, resumed.priorPrivateBundle);
	assert(evidence);
	assert.equal(evidence.requestAudit.requests.length, 130);
	assert.equal(authenticatedHostEffectEvidence({ ...resumed.priorCarryProof }, resumed.priorPrivateBundle), undefined);
	assert.equal(authenticatedHostEffectEvidence(resumed.priorCarryProof,
		{ ...resumed.priorPrivateBundle, "candidate.cpp": "other" }), undefined);
	const reopenWork = () => openLedgerContinuation({ ...f, seedEnvelopeB64,
		githubToken: "synthetic-token", current: current(7005, sha("e")),
		request: requestFor([anchor, firstDone, secondDone, work]),
		loadCarryArtifact: async ({ artifactId }) => artifactId === "9003" ? zero.envelopeB64 : legacy.envelopeB64 });
	const resumeCarry = (envelopeB64: string) => openLedgerContinuation({ ...f, seedEnvelopeB64,
		githubToken: "synthetic-token", current: current(7006, sha("f")),
		request: requestFor([anchor, firstDone, secondDone,
			{ ...work, status: "completed", conclusion: "failure" }, next]),
		loadCarryArtifact: async () => envelopeB64 });
	for (const [label, change] of [
		["untracked audit session", (bundle: Record<string, string>, audit: any) => {
			audit.requests[1].sessionId = createHash("sha256").update("untracked").digest("hex");
		}],
		["unreceived transport", (bundle: Record<string, string>, audit: any) => {
			audit.requests[1].responseReceived = false;
		}],
		["widened write grant", (bundle: Record<string, string>) => {
			const row = JSON.parse(bundle["host-effect-receipt.json"]);
			row.sessions[0].grant.writableFiles.push("outside.txt");
			bundle["host-effect-receipt.json"] = JSON.stringify(row);
		}],
		["unknown operation", (bundle: Record<string, string>) => {
			const row = JSON.parse(bundle["host-effect-receipt.json"]);
			row.goals[0].operations[0].status = "unknown";
			bundle["host-effect-receipt.json"] = JSON.stringify(row);
		}],
		["changed old selected tuple", (bundle: Record<string, string>) => {
			bundle["candidate.cpp"] = "unreviewed candidate";
		}],
		["omitted task", (bundle: Record<string, string>) => {
			const row = JSON.parse(bundle["host-effect-receipt.json"]);
			row.goals[0].tasks = [];
			bundle["host-effect-receipt.json"] = JSON.stringify(row);
		}],
	] as Array<[string, (bundle: Record<string, string>, audit: any) => void]>) {
		const badBundle = { ...nextBundle };
		const badAudit = structuredClone(requestAudit);
		change(badBundle, badAudit);
		const opened = await reopenWork();
		const bad = opened.sealCurrent({ settledCny: badAudit.settledCny,
			unknownObservedCny: badAudit.unknownObservedCny,
			unpricedRequestCount: badAudit.unpricedRequestCount,
			requestAudit: badAudit, privateBundle: badBundle });
		const replay = await resumeCarry(bad.envelopeB64);
		assert.equal(authenticatedHostEffectEvidence(replay.priorCarryProof, replay.priorPrivateBundle),
			undefined, label);
	}
	const unknownBillingAudit: any = structuredClone(requestAudit);
	unknownBillingAudit.requests[1].status = "unknown";
	unknownBillingAudit.requests[1].settledCny = null;
	unknownBillingAudit.requests[1].unknownObservedCny = null;
	unknownBillingAudit.unpricedRequestCount = 1;
	const unknownBillingOpen = await reopenWork();
	const unknownBillingCarry = unknownBillingOpen.sealCurrent({ settledCny: 0.5,
		unknownObservedCny: 0, unpricedRequestCount: 1,
		requestAudit: unknownBillingAudit, privateBundle: nextBundle });
	const unknownBillingResume = await resumeCarry(unknownBillingCarry.envelopeB64);
	assert(authenticatedHostEffectEvidence(unknownBillingResume.priorCarryProof,
		unknownBillingResume.priorPrivateBundle), "received response with unknown CNY retains effect authority");
	assert.equal(unknownBillingResume.priorUnpricedRequestCount, 1);
	const observedUnknownAudit: any = structuredClone(requestAudit);
	observedUnknownAudit.requests[1].status = "unknown";
	observedUnknownAudit.requests[1].settledCny = null;
	observedUnknownAudit.requests[1].unknownObservedCny = 0.25;
	observedUnknownAudit.unknownObservedCny = 0.25;
	const observedUnknownOpen = await reopenWork();
	const observedUnknownCarry = observedUnknownOpen.sealCurrent({ settledCny: 0.5,
		unknownObservedCny: 0.25, unpricedRequestCount: 0,
		requestAudit: observedUnknownAudit, privateBundle: nextBundle });
	const observedUnknownResume = await resumeCarry(observedUnknownCarry.envelopeB64);
	assert(authenticatedHostEffectEvidence(observedUnknownResume.priorCarryProof,
		observedUnknownResume.priorPrivateBundle));
	assert.equal(observedUnknownResume.priorUnknownObservedCny, 0.25);
	assert.equal(observedUnknownResume.historicalUnknownHeldCny, 0.25);
	const transportRows: any[] = structuredClone(rows.slice(0, 17));
	transportRows[16].responseReceived = false;
	transportRows[16].status = "unknown";
	transportRows[16].settledCny = null;
	transportRows[16].unknownObservedCny = 0.25;
	transportRows[16].reportedUsage = null;
	const transportAudit: any = { ...requestAudit, requests: transportRows,
		settledCny: 0.5, unknownObservedCny: 0.25 };
	const transportReceipt = structuredClone(receipt);
	transportReceipt.requestIds = transportRows.map(row => row.requestId);
	transportReceipt.goals[0].outcome = "active";
	transportReceipt.goals[0].tasks[0].status = "failed";
	transportReceipt.goals[0].operations[0].status = "unknown";
	const transportBundle = { ...nextBundle,
		"objective-checkpoint.json": JSON.stringify({ ...oldCheckpoint,
			boundedRuns: [...oldCheckpoint.boundedRuns,
				{ runId: "new-goal", outcome: "active", unresolvedOperationIds: ["O001"] }],
			continuation: { requiresOperationReconciliation: true,
				unresolvedOperationIds: ["old-goal/O001", "old-goal/O002", "new-goal/O001"] } }),
		"host-effect-receipt.json": JSON.stringify(transportReceipt) };
	const transportOpen = await reopenWork();
	const transportCarry = transportOpen.sealCurrent({ settledCny: 0.5,
		unknownObservedCny: 0.25, unpricedRequestCount: 0,
		requestAudit: transportAudit, privateBundle: transportBundle });
	const transportResume = await resumeCarry(transportCarry.envelopeB64);
	assert(authenticatedHostEffectEvidence(transportResume.priorCarryProof,
		transportResume.priorPrivateBundle), "16 received plus one unknown transport retains confined actor-effect authority");
	assert.equal(transportResume.priorUnknownObservedCny, 0.25);
	assert.equal(transportResume.historicalUnknownHeldCny, 0.25);
	const zeroAfterUnknown = transportResume.sealCurrent({ settledCny: 0,
		unknownObservedCny: 0, unpricedRequestCount: 0,
		requestAudit: emptyAudit, privateBundle: transportResume.priorPrivateBundle });
	assert.equal(zeroAfterUnknown.observedUnknownHeldCny, 0.25,
		"a later empty run cannot release the unknown transport observation");
	const claimRequest: typeof fetch = async (url, init) => {
		const address = String(url);
		if (address.endsWith("/runs/7006"))
			return new Response(JSON.stringify(next));
		if (address.includes("/runs/7006/jobs?"))
			return new Response(JSON.stringify({ total_count: 1, jobs: [{
				id: 8006, run_id: 7006, run_attempt: 1, head_sha: sha("f"),
				name: "private-campaign", status: "in_progress",
				steps: [{ name: "Run private campaign", status: "in_progress" }],
			}] }));
		return requestFor([anchor, firstDone, secondDone,
			{ ...work, status: "completed", conclusion: "failure" }, next])(url, init);
	};
	const claimed = await openLedgerContinuation({ ...f, seedEnvelopeB64,
		githubToken: "synthetic-token", current: current(7006, sha("f")),
		request: claimRequest, loadCarryArtifact: async () => transportCarry.envelopeB64 });
	const priorProof = claimed.priorCarryProof!;
	const priorBundle = claimed.priorPrivateBundle!;
	assert(authenticatedHostEffectEvidence(priorProof, priorBundle));
	const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
	const facts = {
		source: { runId: priorProof.source.runId, runAttempt: priorProof.source.runAttempt,
			commit: priorProof.source.commit },
		currentRun: { runId: priorProof.admittedCurrent.runId,
			runAttempt: priorProof.admittedCurrent.runAttempt, commit: priorProof.admittedCurrent.commit },
		envelopeSha256: priorProof.envelopeSha256, privateBundleSha256: priorProof.privateBundleSha256!,
		terminal: { state: "terminal" as const, sourceRunId: priorProof.source.runId,
			sourceRunAttempt: priorProof.source.runAttempt,
			observationDigest: digest(priorProof.terminal), observedAt: "2026-10-06T17:30:00Z" },
		resultArtifact: { immutableRef: "synthetic-immutable-result", digestScope: "github-artifact-archive",
			sha256: priorProof.resultArtifact!.archiveSha256 },
		committedNano: Math.ceil(claimed.historicalCommittedCny! * 1_000_000_000),
		unknownHeldNano: Math.ceil(claimed.historicalUnknownHeldCny! * 1_000_000_000),
	};
	const quarantineChain = JSON.parse(priorBundle["independent-restart-quarantine.json"]!);
	const bindingChain = JSON.parse(priorBundle["independent-restart-goal-binding.json"]!);
	const reservation = await reserveIndependentRestart({ authenticatedCarryProof: priorProof,
		privateBundle: priorBundle, freshWorkspace: { workspaceId: "next-independent-workspace",
			restartNonce: "independent-nonce" },
		failedHistory: { state: "unavailable", reason: "synthetic prior result is unavailable",
			immutableArtifactRef: facts.resultArtifact.immutableRef,
			digestScope: facts.resultArtifact.digestScope,
			artifactSha256: facts.resultArtifact.sha256 } }, {
		authenticatedFacts: proof => proof === priorProof &&
			authenticatedPriorCarryBindsBundle(proof, priorBundle) ? facts : undefined,
		reviewEffects: async (reviewed, refs) => {
			assert(authenticatedHostEffectEvidence(priorProof, priorBundle));
			assert.deepEqual([...refs].sort(), ["new-goal/O001", "old-goal/O001", "old-goal/O002"]);
			return { sourceCommit: reviewed.source.commit, policyId: "synthetic-confined-host-review",
				policySha256: digest([reviewed.source, refs]),
				operationAttestations: refs.map(operationRef => ({ operationRef,
					sourceCommit: reviewed.source.commit, evidenceSha256: digest(operationRef) })),
				effectClass: "confined-ephemeral-local", unknownBillingHeld: true,
				actorThirdPartyMutations: "none", hostTransport: "immutable-versioned-archive" };
		},
		revalidateSelection: async ({ checkpoint, tupleSha256 }) => ({ status: "passed",
			contractId: checkpoint.contract.id, selectedRunId: "selected-goal",
			selectedTaskId: "T001", tupleSha256,
			currentValidationSha256: digest("fresh independent checker") }),
		commitOneUse: async receipt => {
			const claim = await claimed.claimOneUse(receipt.prior.envelopeSha256);
			quarantineChain.entries.push({ receipt, claim });
			return { receiptRef: "independent-restart-quarantine.json",
				receiptSha256: digest(receipt), claim };
		},
	});
	assert.deepEqual(reservation.quarantinedOperationRefs,
		["new-goal/O001", "old-goal/O001", "old-goal/O002"]);
	await bindIndependentRestartGoal(reservation, "next-goal", async binding => {
		bindingChain.entries.push(binding);
		return { bindingRef: "independent-restart-goal-binding.json",
			bindingSha256: digest(binding) };
	});
	const receivedSession = campaignSessionEffectId("after unknown transport");
	const receivedRow = { requestId: "after-unknown-received", sessionId: receivedSession,
		responseReceived: true, inputPayloadBytes: 100, status: "settled" as const,
		settledCny: 0.25, unknownObservedCny: null,
		reportedUsage: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0,
			totalTokens: 20, reportedUsdCost: 0.01, costStatus: "priced" } };
	const afterUnknownAudit = { ...emptyAudit, requests: [receivedRow], settledCny: 0.25,
		pricingProfile: nativeCnyPricingRecord(profile) };
	const afterUnknownReceipt = { ...transportReceipt,
		source: { runId: "7006", runAttempt: 1, commit: sha("f") },
		priorEnvelopeSha256: priorProof.envelopeSha256,
		historicalGoalRunIds: ["selected-goal", "old-goal", "new-goal"],
		goals: [{ runId: "next-goal", outcome: "partial",
			tasks: [{ taskId: "T002", mode: "execute", status: "rejected", sessionId: receivedSession }],
			operations: [{ id: "O001", taskId: "T002", status: "response-received" }] }],
		sessions: [{ sessionId: receivedSession, kind: "confined-execution",
			goalRunId: "next-goal", taskId: "T002", workRoot: "/tmp/synthetic/T002",
			grant: { version: 1, kind: "confined-campaign-files", root: "/tmp/synthetic/T002",
				writableFiles: ["candidate.cpp", "lesson-delta.json"] } }],
		requestIds: [receivedRow.requestId] };
	const afterUnknownBundle = { ...priorBundle,
		"independent-restart-quarantine.json": JSON.stringify(quarantineChain),
		"independent-restart-goal-binding.json": JSON.stringify(bindingChain),
		"objective-checkpoint.json": JSON.stringify({ ...oldCheckpoint,
			boundedRuns: [...oldCheckpoint.boundedRuns,
				{ runId: "new-goal", outcome: "active", unresolvedOperationIds: ["O001"] },
				{ runId: "next-goal", outcome: "partial", unresolvedOperationIds: [] }],
			continuation: { requiresOperationReconciliation: true,
				unresolvedOperationIds: ["old-goal/O001", "old-goal/O002", "new-goal/O001"] } }),
		"host-effect-receipt.json": JSON.stringify(afterUnknownReceipt) };
	const afterUnknown = claimed.sealCurrent({ settledCny: 0.25,
		unknownObservedCny: 0, unpricedRequestCount: 0,
		requestAudit: afterUnknownAudit, privateBundle: afterUnknownBundle });
	const reopenedAfterUnknown = await openLedgerContinuation({ ...f, seedEnvelopeB64,
		githubToken: "synthetic-token", current: current(7007, sha("1")),
		request: requestFor([anchor, firstDone, secondDone,
			{ ...work, status: "completed", conclusion: "failure" },
			{ ...next, status: "completed", conclusion: "failure" },
			run(7007, 6, "in_progress", sha("1"))]),
		loadCarryArtifact: async () => afterUnknown.envelopeB64 });
	const afterEvidence = authenticatedHostEffectEvidence(reopenedAfterUnknown.priorCarryProof,
		reopenedAfterUnknown.priorPrivateBundle);
	assert(afterEvidence, "a new received run retains the reviewed unknown-transport ancestry");
	assert.equal(afterEvidence.reviewedEffectAncestry.length, 1);
	assert.equal(reopenedAfterUnknown.priorUnknownObservedCny, 0.25);
	assert.equal(reopenedAfterUnknown.historicalUnknownHeldCny, 0.25);
	assert.deepEqual(JSON.parse(reopenedAfterUnknown.priorPrivateBundle!["objective-checkpoint.json"]!)
		.continuation.unresolvedOperationIds,
		["old-goal/O001", "old-goal/O002", "new-goal/O001"]);
	for (const [label, change] of [
		["in-flight transport", (bundle: Record<string, string>, audit: any) => {
			audit.requests[16].status = "in-flight";
		}],
		["unknown outside failed task", (bundle: Record<string, string>) => {
			const census = JSON.parse(bundle["host-effect-receipt.json"]);
			census.goals[0].tasks[0].status = "rejected";
			bundle["host-effect-receipt.json"] = JSON.stringify(census);
		}],
		["unknown without unresolved checkpoint", (bundle: Record<string, string>) => {
			const checkpoint = JSON.parse(bundle["objective-checkpoint.json"]);
			checkpoint.boundedRuns.at(-1).unresolvedOperationIds = [];
			bundle["objective-checkpoint.json"] = JSON.stringify(checkpoint);
		}],
		["unreceived read-only session", (bundle: Record<string, string>, audit: any) => {
			audit.requests[16].sessionId = researchSession;
		}],
		["missing host census", (bundle: Record<string, string>) => {
			delete bundle["host-effect-receipt.json"];
		}],
	] as Array<[string, (bundle: Record<string, string>, audit: any) => void]>) {
		const bundle = { ...transportBundle };
		const audit = structuredClone(transportAudit);
		change(bundle, audit);
		const opened = await reopenWork();
		const carry = opened.sealCurrent({ settledCny: audit.settledCny,
			unknownObservedCny: audit.unknownObservedCny,
			unpricedRequestCount: audit.unpricedRequestCount,
			requestAudit: audit, privateBundle: bundle });
		const replay = await resumeCarry(carry.envelopeB64);
		assert.equal(authenticatedHostEffectEvidence(replay.priorCarryProof,
			replay.priorPrivateBundle), undefined, label);
	}
	const changedObjective = { ...transportBundle };
	const alteredContract = { ...contract, constraint: "changed-but-same-id" };
	const alteredProgress = JSON.parse(changedObjective["objective-checkpoint.json"]);
	alteredProgress.contract = alteredContract;
	changedObjective["original-objective.json"] = JSON.stringify(alteredContract);
	changedObjective["objective-checkpoint.json"] = JSON.stringify(alteredProgress);
	const alteredOpen = await reopenWork();
	const alteredCarry = alteredOpen.sealCurrent({ settledCny: 0.5,
		unknownObservedCny: 0.25, unpricedRequestCount: 0,
		requestAudit: transportAudit, privateBundle: changedObjective });
	const alteredResume = await resumeCarry(alteredCarry.envelopeB64);
	assert.equal(authenticatedHostEffectEvidence(alteredResume.priorCarryProof,
		alteredResume.priorPrivateBundle), undefined,
		"same-ID objective mutation cannot mint effect authority beyond signed seed bytes");
	const acceptedReceipt = structuredClone(receipt);
	acceptedReceipt.goals[0].tasks[0].status = "accepted";
	const acceptedArchive = JSON.stringify({ version: 1, kind: "m07-private-candidate-archive",
		goalRunId: "new-goal", taskId: "T001", goalOutcome: "partial", taskStatus: "accepted",
		controllerEvidence: { reviewStatus: "accepted", operationOutcomes: [{ operationId: "O001",
			status: "response-received" }] }, m04: { state: "completed" } });
	const acceptedBundle = { ...nextBundle, "candidate.cpp": "new selected source",
		"verification.json": JSON.stringify({ version: 1, status: "passed" }),
		"workflow-archive.json": acceptedArchive,
		"objective-checkpoint.json": JSON.stringify({ boundedRuns: [...oldCheckpoint.boundedRuns,
			{ runId: "new-goal", outcome: "partial", selectedTaskId: "T001", unresolvedOperationIds: [] }],
			selectedArtifacts: ["candidate.cpp", "verification.json", "workflow-archive.json"] }),
		"research-history.json": JSON.stringify({ version: 1,
			kind: "untrusted-version-bound-research-history", entries: [{ goalRunId: "old-goal",
				taskId: "T999", files: { "candidate.cpp": oldBundle["candidate.cpp"],
					"verification.json": oldBundle["verification.json"],
					"workflow-archive.json": oldBundle["workflow-archive.json"] } }] }),
		"host-effect-receipt.json": JSON.stringify(acceptedReceipt) };
	const acceptedOpen = await reopenWork();
	const acceptedCarry = acceptedOpen.sealCurrent({ settledCny: 0.5,
		unknownObservedCny: 0, unpricedRequestCount: 0,
		requestAudit, privateBundle: acceptedBundle });
	const acceptedResume = await resumeCarry(acceptedCarry.envelopeB64);
	assert(authenticatedHostEffectEvidence(acceptedResume.priorCarryProof,
		acceptedResume.priorPrivateBundle), "coherent new selected tuple can retain effect authority");
	const reviewedPrior = resumed.priorCarryProof!;
	const reviewReceipt = { version: 1, kind: "host-independent-goal-quarantine",
		prior: { source: { runId: reviewedPrior.source.runId,
			runAttempt: reviewedPrior.source.runAttempt, commit: reviewedPrior.source.commit },
			envelopeSha256: reviewedPrior.envelopeSha256,
			privateBundleSha256: reviewedPrior.privateBundleSha256,
			reviewedPolicySha256: "b".repeat(64), selectedTupleSha256: "c".repeat(64) },
		quarantine: { operationOutcome: "unknown", selectedFromFailedAttempt: false,
			operationRefs: ["old-goal/O001"], historicalGoalOutcomes: oldCheckpoint.boundedRuns },
		freshWorkspace: { workspaceId: "fresh-next-workspace", restartNonce: "synthetic-nonce" } };
	const reviewClaim = { claimId: "synthetic-reviewed-claim", currentJobId: "synthetic-job",
		priorEnvelopeSha256: reviewedPrior.envelopeSha256,
		currentRunId: "7006", currentRunAttempt: 1, currentCommit: sha("f") };
	const reviewBinding = { version: 1, kind: "host-independent-goal-binding",
		quarantineReceiptSha256: createHash("sha256").update(JSON.stringify(reviewReceipt)).digest("hex"),
		freshWorkspace: reviewReceipt.freshWorkspace, goalRunId: "next-goal" };
	const nextExecutionSession = createHash("sha256").update("next exec session").digest("hex");
	const nextRow = { requestId: "next-request", sessionId: nextExecutionSession,
		responseReceived: true, inputPayloadBytes: 100, status: "settled" as const,
		settledCny: 0.25, unknownObservedCny: null,
		reportedUsage: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0,
			totalTokens: 20, reportedUsdCost: 0.01, costStatus: "priced" } };
	const nextAudit = { ...emptyAudit, requests: [nextRow], settledCny: 0.25,
		pricingProfile: nativeCnyPricingRecord(profile) };
	const nextReceipt = { ...receipt,
		source: { runId: "7006", runAttempt: 1, commit: sha("f") },
		priorEnvelopeSha256: reviewedPrior.envelopeSha256,
		historicalGoalRunIds: ["selected-goal", "old-goal", "new-goal"],
		goals: [{ runId: "next-goal", outcome: "partial",
			tasks: [{ taskId: "T002", mode: "execute", status: "rejected", sessionId: nextExecutionSession }],
			operations: [{ id: "O001", taskId: "T002", status: "response-received" }] }],
		sessions: [{ sessionId: nextExecutionSession, kind: "confined-execution",
			goalRunId: "next-goal", taskId: "T002", workRoot: "/tmp/synthetic/T002",
			grant: { version: 1, kind: "confined-campaign-files", root: "/tmp/synthetic/T002",
				writableFiles: ["candidate.cpp", "lesson-delta.json"] } }],
		requestIds: [nextRow.requestId] };
	const secondBundle = { ...nextBundle,
		"objective-checkpoint.json": JSON.stringify({ boundedRuns: [...oldCheckpoint.boundedRuns,
			{ runId: "new-goal", outcome: "partial", unresolvedOperationIds: [] },
			{ runId: "next-goal", outcome: "partial", unresolvedOperationIds: [] }] }),
		"independent-restart-quarantine.json": JSON.stringify({ version: 1,
			kind: "host-independent-restart-reservations",
			entries: [{ receipt: reviewReceipt, claim: reviewClaim }] }),
		"independent-restart-goal-binding.json": JSON.stringify({ version: 1,
			kind: "host-independent-restart-goal-bindings", entries: [reviewBinding] }),
		"host-effect-receipt.json": JSON.stringify(nextReceipt) };
	const secondNonzero = resumed.sealCurrent({ settledCny: 0.25, unknownObservedCny: 0,
		unpricedRequestCount: 0, requestAudit: nextAudit, privateBundle: secondBundle });
	const later = await openLedgerContinuation({ ...f, seedEnvelopeB64,
		githubToken: "synthetic-token", current: current(7007, sha("1")),
		request: requestFor([anchor, firstDone, secondDone,
			{ ...work, status: "completed", conclusion: "failure" },
			{ ...next, status: "completed", conclusion: "failure" },
			run(7007, 6, "in_progress", sha("1"))]),
		loadCarryArtifact: async () => secondNonzero.envelopeB64 });
	const cumulative = authenticatedHostEffectEvidence(later.priorCarryProof, later.priorPrivateBundle);
	assert(cumulative, "a reviewed first nonzero run permits a separately receipted second one");
	assert.equal(cumulative.reviewedEffectAncestry.length, 1);
	assert.equal(cumulative.reviewedEffectAncestry[0].envelopeSha256, reviewedPrior.envelopeSha256);
	const unreviewedSuccessor = await resumeCarry(sealed.envelopeB64);
	const brokenBundle = { ...secondBundle };
	const brokenChain = JSON.parse(brokenBundle["independent-restart-quarantine.json"]);
	brokenChain.entries[0].claim.currentCommit = sha("0");
	brokenBundle["independent-restart-quarantine.json"] = JSON.stringify(brokenChain);
	const broken = unreviewedSuccessor.sealCurrent({ settledCny: 0.25,
		unknownObservedCny: 0, unpricedRequestCount: 0,
		requestAudit: nextAudit, privateBundle: brokenBundle });
	const brokenLater = await openLedgerContinuation({ ...f, seedEnvelopeB64,
		githubToken: "synthetic-token", current: current(7007, sha("1")),
		request: requestFor([anchor, firstDone, secondDone,
			{ ...work, status: "completed", conclusion: "failure" },
			{ ...next, status: "completed", conclusion: "failure" },
			run(7007, 6, "in_progress", sha("1"))]),
		loadCarryArtifact: async () => broken.envelopeB64 });
	assert.equal(authenticatedHostEffectEvidence(brokenLater.priorCarryProof,
		brokenLater.priorPrivateBundle), undefined,
	"a claim for another successor cannot review an accounting ancestor");
	const emptyWs = new Workspace(path.join(path.dirname(f.publicKeyFile), "empty-census"));
	const emptyReceipt = await offlineChecks.buildHostEffectReceipt({ ws: emptyWs,
		source: { runId: "7006", runAttempt: 1, commit: sha("f") },
		priorEnvelopeSha256: reviewedPrior.envelopeSha256,
		historicalGoalRunIds: ["selected-goal", "old-goal", "new-goal"],
		requestIds: [], sessions: new Map([
			["pre-request-assessor", { sessionId: "pre-request-assessor", grantKind: "none" as const }],
		]) });
	const abandonedBundle = { ...nextBundle,
		"host-effect-receipt.json": JSON.stringify(emptyReceipt),
		"independent-restart-quarantine.json": JSON.stringify({ version: 1,
			kind: "host-independent-restart-reservations",
			entries: [{ receipt: reviewReceipt, claim: reviewClaim }] }) };
	const unsafeEmptyReceipt = structuredClone(emptyReceipt);
	unsafeEmptyReceipt.sessions.push({ sessionId: campaignSessionEffectId("untracked executor"),
		kind: "confined-execution", goalRunId: "absent-goal", taskId: "T999",
		workRoot: "/tmp/synthetic/T999", grant: { version: 1,
			kind: "confined-campaign-files", root: "/tmp/synthetic/T999",
			writableFiles: ["candidate.cpp", "lesson-delta.json"] } });
	const unsafeEmptyOpen = await resumeCarry(sealed.envelopeB64);
	assert.throws(() => unsafeEmptyOpen.sealCurrent({ settledCny: 0, unknownObservedCny: 0,
		unpricedRequestCount: 0, requestAudit: emptyAudit,
		privateBundle: { ...abandonedBundle,
			"host-effect-receipt.json": JSON.stringify(unsafeEmptyReceipt) } }),
		/reviewed effect ancestry is not bound/);
	const emptySuccessor = await resumeCarry(sealed.envelopeB64);
	const emptyCarry = emptySuccessor.sealCurrent({ settledCny: 0, unknownObservedCny: 0,
		unpricedRequestCount: 0, requestAudit: emptyAudit, privateBundle: abandonedBundle });
	const zeroCurrent = await openLedgerContinuation({ ...f, seedEnvelopeB64,
		githubToken: "synthetic-token", current: current(7007, sha("1")),
		request: requestFor([anchor, firstDone, secondDone,
			{ ...work, status: "completed", conclusion: "failure" },
			{ ...next, status: "completed", conclusion: "failure" },
			run(7007, 6, "in_progress", sha("1"))]),
		loadCarryArtifact: async () => emptyCarry.envelopeB64 });
	const abandoned = authenticatedHostEffectEvidence(zeroCurrent.priorCarryProof,
		zeroCurrent.priorPrivateBundle);
	assert(abandoned, "host census attests a claimed run with no new goal or model call");
	assert.equal(abandoned.receipt.sessions[0].kind, "none");
	assert.equal(abandoned.reviewedEffectAncestry.at(-1)?.abandonedWithoutGoal, true);
	const thirdSession = campaignSessionEffectId("third exec session");
	const thirdRow = { ...nextRow, requestId: "third-request", sessionId: thirdSession };
	const thirdAudit = { ...emptyAudit, requests: [thirdRow], settledCny: 0.25,
		pricingProfile: nativeCnyPricingRecord(profile) };
	const zeroProof = zeroCurrent.priorCarryProof!;
	const zeroSourceReceipt = { ...reviewReceipt,
		prior: { ...reviewReceipt.prior,
			source: { runId: zeroProof.source.runId, runAttempt: zeroProof.source.runAttempt,
				commit: zeroProof.source.commit }, envelopeSha256: zeroProof.envelopeSha256,
			privateBundleSha256: zeroProof.privateBundleSha256 },
		freshWorkspace: { workspaceId: "third-workspace", restartNonce: "third-nonce" } };
	const zeroSourceClaim = { ...reviewClaim, claimId: "zero-source-claim",
		priorEnvelopeSha256: zeroProof.envelopeSha256,
		currentRunId: "7007", currentCommit: sha("1") };
	const zeroSourceBinding = { version: 1, kind: "host-independent-goal-binding",
		quarantineReceiptSha256: createHash("sha256").update(JSON.stringify(zeroSourceReceipt)).digest("hex"),
		freshWorkspace: zeroSourceReceipt.freshWorkspace, goalRunId: "third-goal" };
	const thirdReceipt = { ...receipt,
		source: { runId: "7007", runAttempt: 1, commit: sha("1") },
		priorEnvelopeSha256: zeroProof.envelopeSha256,
		historicalGoalRunIds: ["selected-goal", "old-goal", "new-goal"],
		goals: [{ runId: "third-goal", outcome: "partial",
			tasks: [{ taskId: "T003", mode: "execute", status: "rejected", sessionId: thirdSession }],
			operations: [{ id: "O001", taskId: "T003", status: "response-received" }] }],
		sessions: [{ sessionId: thirdSession, kind: "confined-execution",
			goalRunId: "third-goal", taskId: "T003", workRoot: "/tmp/synthetic/T003",
			grant: { version: 1, kind: "confined-campaign-files", root: "/tmp/synthetic/T003",
				writableFiles: ["candidate.cpp", "lesson-delta.json"] } }],
		requestIds: [thirdRow.requestId] };
	const thirdBundle = { ...abandonedBundle,
		"objective-checkpoint.json": JSON.stringify({ boundedRuns: [...oldCheckpoint.boundedRuns,
			{ runId: "new-goal", outcome: "partial", unresolvedOperationIds: [] },
			{ runId: "third-goal", outcome: "partial", unresolvedOperationIds: [] }] }),
		"host-effect-receipt.json": JSON.stringify(thirdReceipt),
		"independent-restart-quarantine.json": JSON.stringify({ version: 1,
			kind: "host-independent-restart-reservations", entries: [
				{ receipt: reviewReceipt, claim: reviewClaim },
				{ receipt: zeroSourceReceipt, claim: zeroSourceClaim }] }),
		"independent-restart-goal-binding.json": JSON.stringify({ version: 1,
			kind: "host-independent-restart-goal-bindings", entries: [zeroSourceBinding] }) };
	const thirdCarry = zeroCurrent.sealCurrent({ settledCny: 0.25, unknownObservedCny: 0,
		unpricedRequestCount: 0, requestAudit: thirdAudit, privateBundle: thirdBundle });
	const afterAbandoned = await openLedgerContinuation({ ...f, seedEnvelopeB64,
		githubToken: "synthetic-token", current: current(7008, sha("2")),
		request: requestFor([anchor, firstDone, secondDone,
			{ ...work, status: "completed", conclusion: "failure" },
			{ ...next, status: "completed", conclusion: "failure" },
			{ ...run(7007, 6, "in_progress", sha("1")), status: "completed", conclusion: "failure" },
			run(7008, 7, "in_progress", sha("2"))]),
		loadCarryArtifact: async () => thirdCarry.envelopeB64 });
	const resumedAfterAbandoned = authenticatedHostEffectEvidence(afterAbandoned.priorCarryProof,
		afterAbandoned.priorPrivateBundle);
	assert(resumedAfterAbandoned, "fresh bound goal after abandoned claim retains reviewed ancestry");
	assert.equal(resumedAfterAbandoned.reviewedEffectAncestry.length, 2);
});

test("received read-only assessment without a new goal preserves an unbound reviewed claim", async t => {
	const f = await fixture(t);
	const contract: OriginalObjectiveContractV1 = { version: 1, kind: "original-objective",
		id: "assessment-contract", createdAt: "2026-10-06T00:00:00Z", goal: "synthetic improvement",
		goalSource: "user-intent-summary", inputNames: ["source.cpp", "problem.md", "notes.txt"],
		obligations: [{ id: "speed", description: "Improve the synthetic case" }], closure: "open-ended" };
	const selectedArtifacts = ["candidate.cpp", "verification.json", "workflow-archive.json"];
	const oldRuns = [{ runId: "old-goal", outcome: "active", unresolvedOperationIds: ["O001"] }];
	const oldCheckpoint = objectiveProgress(contract, { boundedRuns: oldRuns,
		selectedArtifacts, unresolvedOperationIds: ["old-goal/O001"], stopReason: "bounded-run-incomplete" });
	const emptyReservations = JSON.stringify({ version: 1,
		kind: "host-independent-restart-reservations", entries: [] });
	const emptyBindings = JSON.stringify({ version: 1,
		kind: "host-independent-restart-goal-bindings", entries: [] });
	const emptyAssessments = JSON.stringify({ version: 1,
		kind: "m07-original-objective-assessment-receipts", receipts: [] });
	const oldBundle = { "candidate.cpp": "synthetic selected source", "verification.json": "{}",
		"workflow-archive.json": "{}", "original-objective.json": JSON.stringify(contract),
		"objective-checkpoint.json": JSON.stringify(oldCheckpoint),
		"objective-assessment-receipts.json": emptyAssessments,
		"independent-restart-quarantine.json": emptyReservations,
		"independent-restart-goal-binding.json": emptyBindings };
	const seedEnvelopeB64 = f.signSeed({ ...f.payload, version: 2,
		rootReviewedAnchor: { commit: sha("a"), artifactSha256: "e".repeat(64),
			digestScope: "encrypted-result-envelope" },
		bootstrap: { contractId: contract.id, sourceSha256: "d".repeat(64),
			format: "deflate-raw-json-v1", filesB64: deflateRawSync(JSON.stringify(oldBundle)).toString("base64") } });
	const firstOpened = await openLedgerContinuation({ ...f, seedEnvelopeB64,
		githubToken: "synthetic-token", current: current(7002, sha("b")),
		request: github([anchor, first]), loadCarryArtifact: async () => "unused" });
	const legacy = sealHistoricalCarryForOfflineTests(firstOpened, { settledCny: 0,
		unknownOrInFlightCny: 0.25, requestAudit: audit(0, 0.25) });
	const firstDone = { ...first, status: "completed", conclusion: "failure" };
	const zeroOpened = await openLedgerContinuation({ ...f, seedEnvelopeB64,
		githubToken: "synthetic-token", current: current(7003, sha("c")),
		request: github([anchor, firstDone, second]),
		loadCarryArtifact: async () => legacy.envelopeB64 });
	const emptyAudit = { version: 3 as const, kind: "accounting-only-request-audit" as const,
		requests: [], settledCny: 0, unknownObservedCny: 0, unpricedRequestCount: 0 };
	const zero = zeroOpened.sealCurrent({ settledCny: 0, unknownObservedCny: 0,
		unpricedRequestCount: 0, requestAudit: emptyAudit });
	const secondDone = { ...second, status: "completed", conclusion: "failure" };
	const work = run(7005, 4, "in_progress", sha("e"));
	const next = run(7006, 5, "in_progress", sha("f"));
	const mock = (runs: object[]): typeof fetch => {
		const base = github(runs);
		return async (url, init) => {
			const address = String(url);
			for (const [id, commit, artifactId] of [[7003, sha("c"), 9003],
				[7005, sha("e"), 9005], [7006, sha("f"), 9006]] as const) {
				if (address.includes(`/runs/${id}/jobs?`)) return new Response(JSON.stringify({ total_count: 1,
					jobs: [{ id: id + 1000, run_id: id, run_attempt: 1, head_sha: commit,
						name: "private-campaign", status: "completed", conclusion: "failure",
						steps: [{ name: "Run private campaign", status: "completed", conclusion: "failure" }] }] }));
				if (address.includes(`/runs/${id}/artifacts?`)) return new Response(JSON.stringify({ total_count: 2,
					artifacts: [{ id: artifactId, name: CARRY_ARTIFACT_NAME, expired: false,
						workflow_run: { id, head_sha: commit } },
						{ id: artifactId + 100, name: MISSION_ARTIFACT, expired: false,
							digest: `sha256:${"a".repeat(64)}`, workflow_run: { id, head_sha: commit } }] }));
			}
			return base(url, init);
		};
	};
	const openWork = () => openLedgerContinuation({ ...f, seedEnvelopeB64,
		githubToken: "synthetic-token", current: current(7005, sha("e")),
		request: mock([anchor, firstDone, secondDone, work]),
		loadCarryArtifact: async ({ artifactId }) => artifactId === "9003" ? zero.envelopeB64 : legacy.envelopeB64 });
	const profile = await verifyDeepSeekCnyBilling({ apiKey: "synthetic-key",
		now: () => new Date("2026-10-06T10:30:00.000Z"),
		request: async () => new Response(JSON.stringify({ is_available: true,
			balance_infos: [{ currency: "CNY", total_balance: "PRIVATE-AMOUNT",
				granted_balance: "PRIVATE-GRANT", topped_up_balance: "PRIVATE-TOPUP" }] }),
			{ status: 200 }) });
	const usage = { input: 10, output: 10, cacheRead: 0, cacheWrite: 0,
		totalTokens: 20, reportedUsdCost: 0.01, costStatus: "priced" };
	const builderSession = campaignSessionEffectId("builder-session");
	const firstRow = { requestId: "builder-request", sessionId: builderSession,
		responseReceived: true, inputPayloadBytes: 100, status: "settled" as const,
		settledCny: 0.5, unknownObservedCny: null, reportedUsage: usage };
	const firstAudit = { ...emptyAudit, requests: [firstRow], settledCny: 0.5,
		pricingProfile: nativeCnyPricingRecord(profile) };
	const workCheckpoint = objectiveProgress(contract, { boundedRuns: [...oldRuns,
		{ runId: "new-goal", outcome: "partial", unresolvedOperationIds: [] }],
		selectedArtifacts, unresolvedOperationIds: ["old-goal/O001"],
		stopReason: "bounded-run-incomplete" });
	const zeroDigest = createHash("sha256").update(Buffer.from(zero.envelopeB64, "base64")).digest("hex");
	const workReceipt = { version: 1, kind: "m07-host-effect-census",
		source: { runId: "7005", runAttempt: 1, commit: sha("e") },
		priorEnvelopeSha256: zeroDigest, historicalGoalRunIds: ["old-goal"],
		goals: [{ runId: "new-goal", outcome: "partial",
			tasks: [{ taskId: "T001", mode: "execute", status: "rejected", sessionId: builderSession }],
			operations: [{ id: "O001", taskId: "T001", status: "response-received" }] }],
		sessions: [{ sessionId: builderSession, kind: "confined-execution",
			goalRunId: "new-goal", taskId: "T001", workRoot: "/tmp/synthetic/assessment-T001",
			grant: { version: 1, kind: "confined-campaign-files", root: "/tmp/synthetic/assessment-T001",
				writableFiles: ["candidate.cpp", "lesson-delta.json"] } }],
		requestIds: [firstRow.requestId] };
	const workBundle = { ...oldBundle, "objective-checkpoint.json": JSON.stringify(workCheckpoint),
		"host-effect-receipt.json": JSON.stringify(workReceipt) };
	const workOpened = await openWork();
	const sealedWork = workOpened.sealCurrent({ settledCny: 0.5, unknownObservedCny: 0,
		unpricedRequestCount: 0, requestAudit: firstAudit, privateBundle: workBundle });
	const openAssessment = () => openLedgerContinuation({ ...f, seedEnvelopeB64,
		githubToken: "synthetic-token", current: current(7006, sha("f")),
		request: mock([anchor, firstDone, secondDone,
			{ ...work, status: "completed", conclusion: "failure" }, next]),
		loadCarryArtifact: async () => sealedWork.envelopeB64 });
	const assessmentOpened = await openAssessment();
	assert(authenticatedHostEffectEvidence(assessmentOpened.priorCarryProof,
		assessmentOpened.priorPrivateBundle));
	const priorProof = assessmentOpened.priorCarryProof!;
	const assessorRaw = "synthetic-assessor";
	const assessorSession = campaignSessionEffectId(assessorRaw);
	const rows = Array.from({ length: 12 }, (_, index) => ({ requestId: `assessment-${index}`,
		sessionId: assessorSession, responseReceived: true, inputPayloadBytes: 100,
		status: "settled" as const, settledCny: index === 0 ? 0.25 : 0,
		unknownObservedCny: null, reportedUsage: usage }));
	const assessmentAudit = { ...emptyAudit, requests: rows, settledCny: 0.25,
		pricingProfile: nativeCnyPricingRecord(profile) };
	const assessment = { version: 1 as const, decision: "continue" as const,
		rationale: "Synthetic assessment needs more evidence", evidenceRefs: [],
		unresolvedObligations: ["speed"], unresolvedDetails: ["Synthetic evidence unread"],
		nextTask: { objective: "Improve synthetic case", addresses: ["speed"],
			adapterScope: "registered-csr-experiment" }, sessionId: assessorRaw,
		model: "synthetic-model", evidenceRead: [], unreadEvidence: ["candidate.cpp"] };
	const assessmentStop = "assessment-evidence-unread" as const;
	const assessmentCheckpoint = objectiveProgress(contract, { boundedRuns: workCheckpoint.boundedRuns,
		selectedArtifacts, availableArtifacts: [...selectedArtifacts,
			"execution-capabilities.json", "restored-candidate-verification.json"],
		unresolvedOperationIds: ["old-goal/O001"], assessment,
		assessmentHistory: [{ iteration: 1, assessment, stopReason: assessmentStop, advanced: false }],
		stopReason: assessmentStop });
	const assessmentChain = { version: 1, kind: "m07-original-objective-assessment-receipts",
		receipts: [{ version: 1, kind: "m07-original-objective-assessment",
			runId: "synthetic-assessment-run", status: "failed", sessions: [{
				sessionId: assessorRaw, role: "research", model: "synthetic-model",
				boundaryMode: "fresh", boundaryIntent: "independent-judgment",
				toolGrantKind: "read-dir", evidenceLabels: [] }] }] };
	const quarantineReceipt = { version: 1, kind: "host-independent-goal-quarantine",
		prior: { source: { runId: priorProof.source.runId,
			runAttempt: priorProof.source.runAttempt, commit: priorProof.source.commit },
			envelopeSha256: priorProof.envelopeSha256,
			privateBundleSha256: priorProof.privateBundleSha256,
			reviewedPolicySha256: "b".repeat(64), selectedTupleSha256: "c".repeat(64) },
		quarantine: { operationOutcome: "unknown", selectedFromFailedAttempt: false,
			operationRefs: ["old-goal/O001"], historicalGoalOutcomes: workCheckpoint.boundedRuns },
		freshWorkspace: { workspaceId: "assessment-workspace", restartNonce: "synthetic-nonce" } };
	const claim = { claimId: "synthetic-reviewed-claim", currentJobId: "synthetic-job",
		priorEnvelopeSha256: priorProof.envelopeSha256,
		currentRunId: "7006", currentRunAttempt: 1, currentCommit: sha("f") };
	const noGoalReceipt = { version: 1, kind: "m07-host-effect-census",
		source: { runId: "7006", runAttempt: 1, commit: sha("f") },
		priorEnvelopeSha256: priorProof.envelopeSha256,
		historicalGoalRunIds: workCheckpoint.boundedRuns.map(row => row.runId), goals: [],
		sessions: [{ sessionId: assessorSession, kind: "read-dir" }],
		requestIds: rows.map(row => row.requestId) };
	const assessmentBundle = { ...workBundle,
		"objective-checkpoint.json": JSON.stringify(assessmentCheckpoint),
		"objective-assessment-receipts.json": JSON.stringify(assessmentChain),
		"independent-restart-quarantine.json": JSON.stringify({ version: 1,
			kind: "host-independent-restart-reservations",
			entries: [{ receipt: quarantineReceipt, claim }] }),
		"host-effect-receipt.json": JSON.stringify(noGoalReceipt) };
	const carry = assessmentOpened.sealCurrent({ settledCny: 0.25, unknownObservedCny: 0,
		unpricedRequestCount: 0, requestAudit: assessmentAudit,
		privateBundle: assessmentBundle });
	const reopened = await openLedgerContinuation({ ...f, seedEnvelopeB64,
		githubToken: "synthetic-token", current: current(7007, sha("1")),
		request: mock([anchor, firstDone, secondDone,
			{ ...work, status: "completed", conclusion: "failure" },
			{ ...next, status: "completed", conclusion: "failure" },
			run(7007, 6, "in_progress", sha("1"))]),
		loadCarryArtifact: async () => carry.envelopeB64 });
	const effect = authenticatedHostEffectEvidence(reopened.priorCarryProof,
		reopened.priorPrivateBundle);
	assert(effect, "received read-only assessment with no M07 goal must retain review authority");
	assert.equal(effect.receipt.goals.length, 0);
	assert.equal(effect.requestAudit.requests.length, 12);
	assert.equal(effect.reviewedEffectAncestry.at(-1)?.abandonedWithoutGoal, true);
	const invalidAssessment = await openAssessment();
	const badChain = { ...assessmentBundle,
		"objective-assessment-receipts.json": emptyAssessments };
	assert.throws(() => invalidAssessment.sealCurrent({ settledCny: 0.25,
		unknownObservedCny: 0, unpricedRequestCount: 0,
		requestAudit: assessmentAudit, privateBundle: badChain }),
		/reviewed effect ancestry is not bound/);
	for (const [label, change] of [
		["unreceived assessor request", (bundle: Record<string, string>, audit: any) => {
			audit.requests[0].responseReceived = false;
		}],
		["widened assessor grant", (bundle: Record<string, string>) => {
			const row = JSON.parse(bundle["host-effect-receipt.json"]);
			row.sessions[0].kind = "confined-execution";
			bundle["host-effect-receipt.json"] = JSON.stringify(row);
		}],
		["changed historical unknown", (bundle: Record<string, string>) => {
			const row = JSON.parse(bundle["objective-checkpoint.json"]);
			row.continuation.unresolvedOperationIds = [];
			bundle["objective-checkpoint.json"] = JSON.stringify(row);
		}],
		["changed selected tuple", (bundle: Record<string, string>) => {
			bundle["candidate.cpp"] = "unselected source";
		}],
	] as Array<[string, (bundle: Record<string, string>, audit: any) => void]>) {
		const candidate = { ...assessmentBundle };
		const account = structuredClone(assessmentAudit);
		change(candidate, account);
		const opened = await openAssessment();
		assert.throws(() => opened.sealCurrent({ settledCny: account.settledCny,
			unknownObservedCny: account.unknownObservedCny,
			unpricedRequestCount: account.unpricedRequestCount,
			requestAudit: account, privateBundle: candidate }), /reviewed effect ancestry is not bound/,
			label);
	}
});

test("one exact missing-carry execution stays opaque and compacts into an emergency carry", async t => {
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
	const openGap = (request: typeof fetch, review = true) => openLedgerContinuation({ ...f,
		githubToken: "synthetic-token", current: current(7006, sha("f")), request,
		loadCarryArtifact: async () => f.secondCarry.envelopeB64,
		...(review ? { reviewOpaqueGapSource: async (facts: any) =>
			authenticateOpaqueGapSourceForOfflineTests(facts.source,
				facts.resultArtifact.archiveSha256, facts.priorCarryEnvelopeSha256) } : {}) });
	const runs = [anchor, firstDone, secondDone, gap, next];
	await assert.rejects(openGap(requestFor(runs), false), /independent exact-source authority/);
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
	assert.equal(opened.opaqueExecutedRuns[0].effects, "quarantined-source-reviewed");
	assert.equal(opened.priorCarryProof?.source.runId, "7003");
	assert.deepEqual(authenticatedReviewedOpaqueRunGaps(opened.priorCarryProof,
		opened.priorPrivateBundle), opened.opaqueExecutedRuns);
	assert.equal(authenticatedReviewedOpaqueRunGaps({ ...opened.priorCarryProof },
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
	assert.throws(() => opened.sealEmergencyCurrent({ settledCny: 0.5, unknownObservedCny: 0.25,
		unpricedRequestCount: 0, requestAudit: inFlight }, "effect-review-incomplete"), /invalid or in-flight/);
	const emergency = opened.sealEmergencyCurrent({ settledCny: 0.5, unknownObservedCny: 0.25,
		unpricedRequestCount: 0, requestAudit: currentAudit,
		privateBundle: { "candidate.cpp": "unreviewed replacement" } }, "effect-review-incomplete");
	const authenticatedSeed = await authenticateSignedMissionSeed({ ...f,
		envelopeB64: f.seedEnvelopeB64 });
	const encrypted = JSON.parse(Buffer.from(emergency.envelopeB64, "base64").toString());
	const decipher = createDecipheriv("aes-256-gcm",
		authenticatedSeed.derivePrivateKey("mul-pis-ledger-continuation-v1"),
		Buffer.from(encrypted.nonce, "base64"));
	decipher.setAAD(Buffer.from(JSON.stringify([MISSION_ID, MISSION_REPOSITORY,
		authenticatedSeed.seedDigest, 3, encrypted.parentDigest,
		{ runId: "7006", runAttempt: 1, runNumber: 5, commit: sha("f") }])));
	decipher.setAuthTag(Buffer.from(encrypted.tag, "base64"));
	const emergencyCheckpoint = JSON.parse(Buffer.concat([
		decipher.update(Buffer.from(encrypted.ciphertext, "base64")), decipher.final()]).toString());
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
			assert.equal(artifactId, "9006"); return emergency.envelopeB64;
		} });
	assert.equal(reopened.opaqueExecutedRuns.length, 1);
	assert.equal(reopened.opaqueExecutedRuns[0].source.runId, "7005");
	assert.equal(reopened.priorCarryProof, undefined);
	assert.equal(reopened.priorSettledCny, 0.5);
	assert.equal(reopened.priorUnknownObservedCny, 0.25);
	assert.equal(reopened.priorPrivateBundle?.["candidate.cpp"], "synthetic root evidence");

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
	const emptyAudit = { version: 3 as const, kind: "accounting-only-request-audit" as const,
		requests: [], settledCny: 0, unknownObservedCny: 0, unpricedRequestCount: 0 };
	const normal = admitted.sealCurrent({ settledCny: 0, unknownObservedCny: 0,
		unpricedRequestCount: 0, requestAudit: emptyAudit });
	assert.throws(() => admitted.sealEmergencyCurrent({ settledCny: 0,
		unknownObservedCny: 0, unpricedRequestCount: 0, requestAudit: emptyAudit },
		"effect-review-incomplete"), /unsealed/);
	const normalReopened = await openLedgerContinuation({ ...f, githubToken: "synthetic-token",
		current: current(7007, sha("1")),
		request: async (url, init) => {
			if (String(url).includes("/runs/7005/artifacts?"))
				throw new Error("compacted old gap artifact must not be fetched");
			return requestFor([anchor, firstDone, secondDone, gap,
				{ ...next, status: "completed", conclusion: "failure" }, later])(url, init);
		}, loadCarryArtifact: async ({ artifactId }) => {
			assert.equal(artifactId, "9006"); return normal.envelopeB64;
		} });
	assert.equal(normalReopened.opaqueExecutedRuns[0].accounting, "unquantified");
	assert.equal(normalReopened.opaqueExecutedRuns[0].effects, "quarantined-source-reviewed");
	assert.equal(normalReopened.priorCarryProof?.source.runId, "7006");
	assert.deepEqual(authenticatedReviewedOpaqueRunGaps(normalReopened.priorCarryProof,
		normalReopened.priorPrivateBundle), normalReopened.opaqueExecutedRuns);
	const normalOuter = JSON.parse(Buffer.from(normal.envelopeB64, "base64").toString());
	const normalSource = { runId: "7006", runAttempt: 1, runNumber: 5, commit: sha("f") };
	const key = authenticatedSeed.derivePrivateKey("mul-pis-ledger-continuation-v1");
	const reader = createDecipheriv("aes-256-gcm", key, Buffer.from(normalOuter.nonce, "base64"));
	reader.setAAD(Buffer.from(JSON.stringify([MISSION_ID, MISSION_REPOSITORY,
		authenticatedSeed.seedDigest, 3, normalOuter.parentDigest, normalSource])));
	reader.setAuthTag(Buffer.from(normalOuter.tag, "base64"));
	const altered = JSON.parse(Buffer.concat([
		reader.update(Buffer.from(normalOuter.ciphertext, "base64")), reader.final()]).toString());
	altered.opaqueExecutedRuns[0].priorCarryEnvelopeSha256 = "0".repeat(64);
	const nonce = randomBytes(12);
	const writer = createCipheriv("aes-256-gcm", key, nonce);
	writer.setAAD(Buffer.from(JSON.stringify([MISSION_ID, MISSION_REPOSITORY,
		authenticatedSeed.seedDigest, 3, normalOuter.parentDigest, normalSource])));
	const forgedCipher = Buffer.concat([writer.update(JSON.stringify(altered)), writer.final()]);
	const forged = Buffer.from(JSON.stringify({ version: 3, parentDigest: normalOuter.parentDigest,
		nonce: nonce.toString("base64"), ciphertext: forgedCipher.toString("base64"),
		tag: writer.getAuthTag().toString("base64") })).toString("base64");
	await assert.rejects(openLedgerContinuation({ ...f, githubToken: "synthetic-token",
		current: current(7007, sha("1")),
		request: requestFor([anchor, firstDone, secondDone, gap,
			{ ...next, status: "completed", conclusion: "failure" }, later]),
		loadCarryArtifact: async () => forged }), /opaque gap predecessor digest/);
});

test("one-time opaque gap source authority pins the reviewed control request and terminal provider step", async () => {
	const requestCommit = "db8263c88d9872cd592b43c70f7831cf74e290eb";
	const firstParent = "6ee929545ec3a1d7194054aa4e98988ecd1bd665";
	const source = { runId: "37507828650", runAttempt: 1, runNumber: 26, commit: requestCommit };
	const terminal = { workflowId: "374865232", runStatus: "completed" as const,
		runConclusion: "failure", jobId: "112420914600", jobName: "private-campaign" as const,
		jobStatus: "completed" as const, jobConclusion: "failure", jobRunId: source.runId,
		jobRunAttempt: 1, jobHeadSha: requestCommit,
		providerStepStatus: "completed" as const, providerStepConclusion: "success" };
	const resultArtifact = { repository: MISSION_REPOSITORY as typeof MISSION_REPOSITORY,
		artifactId: "11431834153", artifactName: MISSION_ARTIFACT as typeof MISSION_ARTIFACT, runId: source.runId,
		archiveSha256: "9c0c4e887c4a212148f0b52aa9e3f96448d50d153b3151e1a741d66bd5f472b5",
		digestScope: "github-artifact-archive" as const };
	const facts = { source, terminal, resultArtifact,
		priorCarryEnvelopeSha256: "0f29b2f1b5ef0d3bee9b53e7d86168621f904c355bf55d46c5557d4cbd6d412c" };
	const submitted = { sha: requestCommit, message: REUSABLE_RUN_REQUEST_MESSAGE,
		parents: [{ sha: firstParent }], tree: { sha: sha("a") } };
	const parent = { sha: firstParent, tree: { sha: sha("a") } };
	const reviewedRun = { id: Number(source.runId), run_number: 26, run_attempt: 1,
		workflow_id: 374865232, head_sha: requestCommit, event: "push",
		head_branch: "run-requests/workflow-learning-reliability",
		actor: { login: "SakuyaInazaki" }, status: "completed", conclusion: "failure" };
	const job = { id: 112420914600, run_id: Number(source.runId), run_attempt: 1,
		head_sha: requestCommit, name: "private-campaign", status: "completed",
		conclusion: "failure", steps: [{ number: 10, name: "Run private campaign",
			status: "completed", conclusion: "success" }] };
	const requestFor = (change?: (rows: Record<string, any>) => void): typeof fetch => async url => {
		const rows: Record<string, any> = { submitted: structuredClone(submitted),
			parent: structuredClone(parent), reviewedRun: structuredClone(reviewedRun),
			jobs: { total_count: 1, jobs: [structuredClone(job)] },
			ci: { workflow_runs: [{ head_sha: firstParent,
				head_branch: "improve/workflow-learning-reliability", event: "push",
				run_attempt: 1, conclusion: "success" }] } };
		change?.(rows);
		const address = String(url);
		const value = address.includes(`/git/commits/${requestCommit}`) ? rows.submitted :
			address.includes(`/git/commits/${firstParent}`) ? rows.parent :
			address.includes(`/actions/runs/${source.runId}/jobs?`) ? rows.jobs :
			address.endsWith(`/actions/runs/${source.runId}`) ? rows.reviewedRun : rows.ci;
		return new Response(JSON.stringify(value));
	};
	assert.equal((await reviewKnownOpaqueGapSource(facts, "synthetic-token", requestFor()))?.kind,
		"authenticated-opaque-gap-source-review");
	for (const change of [
		(rows: Record<string, any>) => { rows.submitted.message = "unreviewed request"; },
		(rows: Record<string, any>) => { rows.submitted.tree.sha = sha("b"); },
		(rows: Record<string, any>) => { rows.reviewedRun.conclusion = "success"; },
		(rows: Record<string, any>) => { rows.reviewedRun.head_branch = "improve/workflow-learning-reliability"; },
		(rows: Record<string, any>) => { rows.jobs.jobs[0].conclusion = "success"; },
		(rows: Record<string, any>) => { rows.jobs.jobs[0].steps[0].conclusion = "failure"; },
		(rows: Record<string, any>) => { rows.jobs.jobs[0].steps[0].number = 9; },
	]) assert.equal(await reviewKnownOpaqueGapSource(facts, "synthetic-token", requestFor(change)), undefined);
	assert.equal(await reviewKnownOpaqueGapSource({ ...facts, source: { ...source, runNumber: 25 } },
		"synthetic-token", requestFor()), undefined);
	assert.equal(await reviewKnownOpaqueGapSource({ ...facts,
		terminal: { ...terminal, providerStepConclusion: "failure" } },
		"synthetic-token", requestFor()), undefined);
});
