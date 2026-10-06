import assert from "node:assert/strict";
import { constants, createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { authenticatedLegacyV3RunReview, authenticatedPriorCarryBindsBundle,
	CARRY_ARTIFACT_NAME, openLedgerContinuation, sealHistoricalCarryForOfflineTests,
	REUSABLE_RUN_REQUEST_MESSAGE } from "../src/runner/ledger-continuation.ts";
import { verifyDeepSeekCnyBilling, nativeCnyPricingRecord } from "../src/runner/deepseek-cny-pricing.ts";
import { MISSION_ARTIFACT, MISSION_ID, MISSION_REPOSITORY, MISSION_TOTAL_CNY } from
	"../src/runner/signed-mission-ledger.ts";

const anchorCommit = "a".repeat(40);
const legacyCommit = "fafd5051e18f4f10a5897cf507c49d92641384d3";
const zeroCommit = "1ca70ade2e2a7aa4d2655aca93ba806161e012b7";
const zeroRunId = 37485015330;
const reviewedSource = "00d4309390bb06536abbe5e86f97213298e901a0";
const requestCommit = "f9d29bfd58449dba072c80f62a7db524f0a668c4";
const nextCommit = "d".repeat(40);
const tree = "e".repeat(40);
const runRequestId = 37490692145;
const nextRunId = runRequestId + 1;
const requestBranch = "run-requests/workflow-learning-reliability";
const sourceBranch = "improve/workflow-learning-reliability";

function run(id: number, number: number, commit: string, status: string,
	more: Record<string, unknown> = {}) {
	return { id, run_number: number, run_attempt: 1, workflow_id: 91,
		status, conclusion: status === "completed" ? "failure" : undefined,
		head_branch: sourceBranch, head_sha: commit, event: "workflow_dispatch",
		actor: { login: "SakuyaInazaki" }, ...more };
}
function current(id: number, commit: string, request: boolean) {
	return { repository: MISSION_REPOSITORY, runId: String(id), runAttempt: "1",
		actor: "SakuyaInazaki", event: request ? "push" : "workflow_dispatch",
		ref: `refs/heads/${request ? requestBranch : sourceBranch}`,
		sha: commit, manualAuthorized: "true", ...(request ? { before: reviewedSource } : {}) };
}
function github(runs: object[], badTree = false): typeof fetch {
	return async url => {
		const at = String(url);
		let response: unknown;
		if (at.includes("/workflows/manual-private-campaign.yml/runs?"))
			response = { total_count: runs.length, workflow_runs: [...runs].reverse() };
		else if (at.endsWith("/runs/7001/artifacts?per_page=100"))
			response = { total_count: 1, artifacts: [{ id: 9001, name: MISSION_ARTIFACT,
				expired: false, workflow_run: { id: 7001 } }] };
		else if (at.endsWith("/runs/7002/artifacts?per_page=100"))
			response = { total_count: 1, artifacts: [{ id: 9002, name: CARRY_ARTIFACT_NAME,
				expired: false, workflow_run: { id: 7002 } }] };
		else if (at.endsWith(`/runs/${zeroRunId}/artifacts?per_page=100`))
			response = { total_count: 1, artifacts: [{ id: 9005, name: CARRY_ARTIFACT_NAME,
				expired: false, workflow_run: { id: zeroRunId } }] };
		else if (at.endsWith(`/runs/${runRequestId}/artifacts?per_page=100`))
			response = { total_count: 2, artifacts: [
				{ id: 9003, name: CARRY_ARTIFACT_NAME, expired: false,
					workflow_run: { id: runRequestId, head_sha: requestCommit } },
				{ id: 9004, name: MISSION_ARTIFACT, expired: false,
					digest: `sha256:${"f".repeat(64)}`,
					workflow_run: { id: runRequestId, head_sha: requestCommit } }] };
		else if (at.endsWith("/runs/7002/jobs?per_page=100") ||
			at.endsWith(`/runs/${zeroRunId}/jobs?per_page=100`) ||
			at.endsWith(`/runs/${runRequestId}/jobs?per_page=100`)) {
			const id = at.endsWith("/runs/7002/jobs?per_page=100") ? 7002 :
				at.endsWith(`/runs/${zeroRunId}/jobs?per_page=100`) ? zeroRunId : runRequestId;
			response = { total_count: 1, jobs: [{ id: id + 1, run_id: id, run_attempt: 1,
				head_sha: id === 7002 ? legacyCommit : id === zeroRunId ? zeroCommit : requestCommit,
				name: "private-campaign", status: "completed", conclusion: "failure",
				steps: [{ name: "Run bounded private campaign", status: "completed",
					conclusion: "success" }] }] };
		} else if (at.endsWith(`/git/ref/heads/${sourceBranch}`))
			response = { object: { sha: reviewedSource } };
		else if (at.endsWith(`/git/commits/${requestCommit}`))
			response = { sha: requestCommit, parents: [{ sha: reviewedSource }],
				tree: { sha: badTree ? "0".repeat(40) : tree } };
		else if (at.endsWith(`/git/commits/${reviewedSource}`))
			response = { sha: reviewedSource, tree: { sha: tree } };
		else if (at.includes("/workflows/workflow-regression.yml/runs?"))
			response = { workflow_runs: [{ head_sha: reviewedSource, head_branch: sourceBranch,
				event: "push", run_attempt: 1, conclusion: "success" }] };
		else throw new Error(`unexpected synthetic request: ${at}`);
		return new Response(JSON.stringify(response), { status: 200 });
	};
}

test("live ledger brands the one-time settled v3 carry only after exact GitHub tree review", async t => {
	const dir = await mkdtemp(path.join(os.tmpdir(), "legacy-v3-brand-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
	const publicKeyFile = path.join(dir, "public.pem");
	await writeFile(publicKeyFile, publicKey.export({ type: "spki", format: "pem" }));
	const expectedSpkiSha256 = createHash("sha256").update(publicKey.export({ type: "spki", format: "der" })).digest("hex");
	const payload = { version: 1, kind: "mul-pis-private-mission-ledger", missionId: MISSION_ID,
		repository: MISSION_REPOSITORY, globalMaxCny: MISSION_TOTAL_CNY, priorCommittedCny: 1,
		revision: 1, previous: { runId: "7001", runAttempt: 1, artifactId: "9001",
			artifactName: MISSION_ARTIFACT } };
	const bytes = Buffer.from(JSON.stringify(payload));
	const signature = sign("sha256", bytes, { key: privateKey,
		padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 });
	const seedEnvelopeB64 = Buffer.from(JSON.stringify({ payload_b64: bytes.toString("base64"),
		signature_b64: signature.toString("base64") })).toString("base64");
	const common = { seedEnvelopeB64, publicKeyFile, expectedSpkiSha256,
		githubToken: "synthetic-token" };
	const anchor = run(7001, 1, anchorCommit, "completed");
	const first = run(7002, 2, legacyCommit, "in_progress");
	const admitted = await openLedgerContinuation({ ...common, current: current(7002, legacyCommit, false),
		request: github([anchor, first]), loadCarryArtifact: async () => "unused" });
	const usage = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0,
		totalTokens: 15, reportedUsdCost: 0.01, costStatus: "priced" };
	const legacyAudit = { requests: [{ requestId: "synthetic-old-settled", inputPayloadBytes: 100,
		reservedCny: 0.25, status: "settled" as const, settledCny: 0.25,
		unknownHeldCny: null, reportedUsage: usage },
		{ requestId: "synthetic-old-unknown", inputPayloadBytes: 100, reservedCny: 0.125,
			status: "unknown" as const, settledCny: null, unknownHeldCny: 0.125,
			reportedUsage: null }], settledCny: 0.25, unknownReservedCny: 0.125,
		inFlightReservedCny: 0, reservations: 2 };
	const bundle = { "candidate.cpp": "synthetic retained candidate" };
	const binding = { contractId: "synthetic-contract", sourceSha256: "0".repeat(64) };
	const legacyCarry = sealHistoricalCarryForOfflineTests(admitted, { settledCny: 0.25,
		unknownOrInFlightCny: 0.125, requestAudit: legacyAudit,
		privateBundle: bundle, bootstrapBinding: binding });
	const completedFirst = run(7002, 2, legacyCommit, "completed");
	const activeZero = run(zeroRunId, 3, zeroCommit, "in_progress");
	const zeroStarted = await openLedgerContinuation({ ...common,
		current: current(zeroRunId, zeroCommit, false),
		request: github([anchor, completedFirst, activeZero]),
		loadCarryArtifact: async () => legacyCarry.envelopeB64 });
	const zeroAudit = { version: 3 as const, kind: "accounting-only-request-audit" as const,
		requests: [], settledCny: 0, unknownObservedCny: 0, unpricedRequestCount: 0 };
	const zeroCarry = zeroStarted.sealCurrent({ settledCny: 0, unknownObservedCny: 0,
		unpricedRequestCount: 0, requestAudit: zeroAudit,
		privateBundle: bundle, bootstrapBinding: binding });
	const completedZero = run(zeroRunId, 3, zeroCommit, "completed");
	const activeRequest = run(runRequestId, 4, requestCommit, "in_progress", { event: "push",
		head_branch: requestBranch, head_commit: { message: REUSABLE_RUN_REQUEST_MESSAGE } });
	const started = await openLedgerContinuation({ ...common,
		current: current(runRequestId, requestCommit, true),
		request: github([anchor, completedFirst, completedZero, activeRequest]),
		loadCarryArtifact: async ({ artifactId }) => artifactId === "9005" ? zeroCarry.envelopeB64 :
			legacyCarry.envelopeB64 });
	const profile = await verifyDeepSeekCnyBilling({ apiKey: "synthetic-only",
		now: () => new Date("2026-10-06T10:30:00.000Z"),
		request: async () => new Response(JSON.stringify({ is_available: true,
			balance_infos: [{ currency: "CNY", total_balance: "PRIVATE-AMOUNT",
				granted_balance: "PRIVATE-GRANT", topped_up_balance: "PRIVATE-TOPUP" }] }),
			{ status: 200 }) });
	const requestAudit = { version: 3 as const, kind: "accounting-only-request-audit" as const,
		requests: Array.from({ length: 130 }, (_, index) => ({ requestId: `synthetic-${index}`,
			inputPayloadBytes: 100, status: "settled" as const, settledCny: 0.125,
			unknownObservedCny: null, reportedUsage: usage })),
		settledCny: 16.25, unknownObservedCny: 0, unpricedRequestCount: 0,
		pricingProfile: nativeCnyPricingRecord(profile) };
	const sealed = started.sealCurrent({ settledCny: 16.25, unknownObservedCny: 0,
		unpricedRequestCount: 0, requestAudit, privateBundle: bundle,
		bootstrapBinding: binding });
	const completedRequest = run(runRequestId, 4, requestCommit, "completed", { event: "push",
		head_branch: requestBranch, head_commit: { message: REUSABLE_RUN_REQUEST_MESSAGE } });
	const next = run(nextRunId, 5, nextCommit, "in_progress");
	const reopen = (badTree: boolean) => openLedgerContinuation({ ...common,
		current: current(nextRunId, nextCommit, false),
		request: github([anchor, completedFirst, completedZero, completedRequest, next], badTree),
		loadCarryArtifact: async ({ artifactId }) => artifactId === "9003" ? sealed.envelopeB64 :
			artifactId === "9005" ? zeroCarry.envelopeB64 : legacyCarry.envelopeB64 });
	const opened = await reopen(false);
	assert.equal(authenticatedPriorCarryBindsBundle(opened.priorCarryProof, opened.priorPrivateBundle), true);
	const review = authenticatedLegacyV3RunReview(opened.priorCarryProof, opened.priorPrivateBundle);
	assert.equal(review?.reviewedSourceCommit, reviewedSource);
	assert.equal(review?.requestAudit.requests.length, 130);
	assert.equal(review?.origin.historicalUnknownHeldNano, 125_000_000);
	assert.equal(review?.immediateZeroActivitySource.source.runId, String(zeroRunId));
	assert.equal(authenticatedLegacyV3RunReview({ ...opened.priorCarryProof }, opened.priorPrivateBundle), undefined);
	await assert.rejects(reopen(true), /one-time reviewed request commit is not the first-parent source tree/);
});
