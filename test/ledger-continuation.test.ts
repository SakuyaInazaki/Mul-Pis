import assert from "node:assert/strict";
import { createCipheriv, createDecipheriv, createHash, generateKeyPairSync, randomBytes, sign, constants } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { deflateRawSync } from "node:zlib";
import test, { type TestContext } from "node:test";
import { authenticatedPriorCarryBindsAncestor, authenticatedPriorCarryBindsBundle, isAuthenticatedPriorCarryProof, CARRY_ARTIFACT_NAME, CARRY_FILE_NAME, downloadCarryArtifact, openLedgerContinuation } from "../src/runner/ledger-continuation.ts";
import type { RequestAuditSnapshot } from "../src/runner/ledger-continuation.ts";
import { DeepSeekCampaignBudget } from "../src/runner/deepseek-campaign.ts";
import { verifyDeepSeekCnyBilling, nativeCnyPricingRecord } from "../src/runner/deepseek-cny-pricing.ts";
import { authenticateSignedMissionSeed, MISSION_ARTIFACT, MISSION_ID, MISSION_REPOSITORY, MISSION_TOTAL_CNY, ONE_USE_PUSH_MARKER } from "../src/runner/signed-mission-ledger.ts";

const sha = (letter: string) => letter.repeat(40);
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
	const sealed = open1.sealCurrent({ settledCny: 1.25, unknownOrInFlightCny: 0.75,
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
	const next = open2.sealCurrent({ settledCny: 0, unknownOrInFlightCny: 0,
		requestAudit: audit(0, 0) });
	assert.equal(next.carryForwardCny, 6.125);
	assert.throws(() => open2.sealCurrent({ settledCny: 0, unknownOrInFlightCny: 0,
		requestAudit: audit(0, 0) }), /already sealed/);
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
	const sealed = opened.sealCurrent({ settledCny: 0, unknownOrInFlightCny: 0,
		requestAudit: audit(0, 0) });
	const next = await openLedgerContinuation({ ...f, seedEnvelopeB64,
		githubToken: "synthetic-token", current: current(7003, sha("c")),
		request: github([anchor, { ...first, status: "completed", conclusion: "failure" }, second]),
		loadCarryArtifact: async () => sealed.envelopeB64 });
	assert.deepEqual(next.priorPrivateBundle, privateFiles);
	assert.deepEqual(next.priorBootstrapBinding, binding);
	assert.throws(() => next.sealCurrent({ settledCny: 0, unknownOrInFlightCny: 0,
		requestAudit: audit(0, 0), bootstrapBinding: { ...binding, sourceSha256: "e".repeat(64) } }),
		/accounting exceeds mission bounds/);
	assert.doesNotMatch(Buffer.from(seedEnvelopeB64, "base64").toString(), /synthetic candidate/);
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
	const sealedByWrongSeed = (await openLedgerContinuation({ ...wrongSeed,
		githubToken: "synthetic-token", current: current(7002, sha("b")),
		request: github([anchor, first]), loadCarryArtifact: async () => "unused" }))
		.sealCurrent({ settledCny: 1, unknownOrInFlightCny: 0, requestAudit: audit(1, 0) });
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
	const budget = new DeepSeekCampaignBudget({ model: "deepseek/synthetic", endpoint: "https://api.deepseek.com",
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
	const budget = new DeepSeekCampaignBudget({ model: "deepseek/synthetic", endpoint: "https://api.deepseek.com",
		maxCny: 0.25, priorCommittedCny: 0, maxProviderCalls: 2, maxProviderCallsPerPrompt: 2,
		maxOutputTokens: 20, outputAccountingMarginTokens: 32,
		estimatedInputCnyPerMillionTokens: 4, estimatedOutputCnyPerMillionTokens: 16,
		estimatedCnyPerUsd: 10 });
	const lease = budget.beginPrompt("private-session", "private-prompt");
	assert.throws(() => budget.reserve(lease, 100_000, "unsent", 1), /global CNY total exhausted/);
	budget.failPrompt(lease);
	const evidence = budget.requestAuditSnapshot();
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
	assert.throws(() => opened.sealCurrent({ settledCny: 0, unknownOrInFlightCny: 0,
		requestAudit: altered }), /accounting/);
	const sealed = opened.sealCurrent({ settledCny: 0, unknownOrInFlightCny: 0,
		requestAudit: evidence });
	assert.doesNotMatch(Buffer.from(sealed.envelopeB64, "base64").toString(), /input-unaffordable|private-session|private-prompt/);
	const reopened = await openLedgerContinuation({ ...f, githubToken: "synthetic-token",
		current: current(7003, sha("c")),
		request: github([anchor, { ...first, status: "completed", conclusion: "failure" }, second]),
		loadCarryArtifact: async () => sealed.envelopeB64 });
	assert.equal(reopened.priorCommittedCny, f.payload.priorCommittedCny);
	assert.equal(reopened.priorUnknownHeldCny, 0);
});

test("encrypted carry retains reviewed native CNY price evidence without account balances", async t => {
	const f = await fixture(t);
	let profileClock = new Date("2026-10-06T10:30:00.000Z");
	const profile = await verifyDeepSeekCnyBilling({ apiKey: "synthetic-key",
		now: () => profileClock,
		request: async () => new Response(JSON.stringify({ is_available: true,
			balance_infos: [{ currency: "CNY", total_balance: "PRIVATE-AMOUNT",
				granted_balance: "PRIVATE-GRANT", topped_up_balance: "PRIVATE-TOPUP" }] }), { status: 200 }) });
	profileClock = new Date("2026-10-07T00:00:00.000Z");
	assert.throws(() => new DeepSeekCampaignBudget({ model: "deepseek/deepseek-flash:low",
		endpoint: "https://api.deepseek.com", maxCny: 30, priorCommittedCny: 0,
		maxProviderCalls: 1, maxProviderCallsPerPrompt: 1, maxOutputTokens: 20,
		outputAccountingMarginTokens: 32, estimatedInputCnyPerMillionTokens: 2,
		estimatedCacheReadCnyPerMillionTokens: 0.04, estimatedOutputCnyPerMillionTokens: 8,
		nativeCnyPricing: profile }), /profile review has expired/);
	const opened = await openLedgerContinuation({ ...f, githubToken: "synthetic-token",
		current: current(7002, sha("b")), request: github([anchor, first]),
		loadCarryArtifact: async () => { throw Error("no carry yet"); } });
	const observation = { ...audit(0, 0), pricingProfile: nativeCnyPricingRecord(profile) };
	const invalid = structuredClone(observation);
	(invalid.pricingProfile.rates as { output: number }).output = 1;
	assert.throws(() => opened.sealCurrent({ settledCny: 0, unknownOrInFlightCny: 0,
		requestAudit: invalid }), /accounting/);
	const sealed = opened.sealCurrent({ settledCny: 0, unknownOrInFlightCny: 0,
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

test("truthful over-ceiling unknown observations persist and prevent any next transport", async t => {
	const f = await fixture(t);
	const firstOpen = await openLedgerContinuation({ ...f, githubToken: "synthetic-token",
		current: current(7002, sha("b")), request: github([anchor, first]), loadCarryArtifact: async () => "unused" });
	const observed = audit(0, 31);
	observed.requests[0].reservedCny = 1;
	const sealed = firstOpen.sealCurrent({ settledCny: 0, unknownOrInFlightCny: 31, requestAudit: observed });
	assert.equal(sealed.carryForwardCny, 35.125);
	const restored = await openLedgerContinuation({ ...f, githubToken: "synthetic-token",
		current: current(7003, sha("c")), request: github([anchor, { ...first, status: "completed", conclusion: "failure" }, second]),
		loadCarryArtifact: async () => sealed.envelopeB64 });
	assert.equal(restored.priorCommittedCny, 35.125);
	assert.equal(restored.priorUnknownHeldCny, 31);
	const budget = new DeepSeekCampaignBudget({ model: "deepseek/synthetic", endpoint: "https://api.deepseek.com",
		maxCny: 30, priorCommittedCny: restored.priorCommittedCny, maxProviderCalls: 3, maxProviderCallsPerPrompt: 3,
		maxOutputTokens: 100, outputAccountingMarginTokens: 10, estimatedInputCnyPerMillionTokens: 2,
		estimatedOutputCnyPerMillionTokens: 4, estimatedCnyPerUsd: 7 });
	assert.throws(() => budget.reserve(budget.beginPrompt("synthetic", "next"), 100, "next"), /global CNY total exhausted/);
	assert.equal(budget.requestAuditSnapshot().reservations, 0);
	assert.equal(restored.sealCurrent({ settledCny: 0, unknownOrInFlightCny: 0,
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
		assert.throws(() => opened.sealCurrent({ settledCny: evidence.settledCny, unknownOrInFlightCny: 0,
			requestAudit: evidence }), /accounting exceeds mission bounds/);
	}
});

test("same-seed checkpoint replay from a different source SHA is rejected", async t => {
	const f = await fixture(t);
	const opened = await openLedgerContinuation({ ...f, githubToken: "synthetic-token",
		current: current(7002, sha("b")), request: github([anchor, first]), loadCarryArtifact: async () => "unused" });
	const sealed = opened.sealCurrent({ settledCny: 1, unknownOrInFlightCny: 0, requestAudit: audit(1, 0) });
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
	const firstCarry = firstOpened.sealCurrent({ settledCny: 1, unknownOrInFlightCny: 0.25, requestAudit: audit(1, 0.25) });
	const secondOpened = await openLedgerContinuation({ ...f, seedEnvelopeB64, githubToken: "synthetic-token",
		current: current(7003, sha("c")), request: github([anchor, { ...first, status: "completed", conclusion: "success" }, second]),
		loadCarryArtifact: async () => firstCarry.envelopeB64 });
	const secondCarry = secondOpened.sealCurrent({ settledCny: 0.5, unknownOrInFlightCny: 0, requestAudit: audit(0.5, 0) });
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

test("one-use push marker cannot authorize a second executed automatic attempt", async t => {
	const f = await fixture(t);
	const request = github([anchor, { ...first, event: "push", head_commit: { message: ONE_USE_PUSH_MARKER },
		status: "completed", conclusion: "success" }, { ...second, event: "push", head_commit: { message: ONE_USE_PUSH_MARKER } }]);
	await assert.rejects(openLedgerContinuation({ ...f, githubToken: "synthetic-token",
		current: { ...current(7003, sha("c")), event: "push", manualAuthorized: undefined }, request,
		loadCarryArtifact: async () => "unused" }), /one-use push authorization was already consumed/);
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
	assert.equal(opened.sealCurrent({ settledCny: 0, unknownOrInFlightCny: 0,
		requestAudit: audit(0, 0) }).carryForwardCny, 5.875);
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
	assert.equal(opened.sealCurrent({ settledCny: 0, unknownOrInFlightCny: 0,
		requestAudit: audit(0, 0) }).carryForwardCny, 5.875);
});
