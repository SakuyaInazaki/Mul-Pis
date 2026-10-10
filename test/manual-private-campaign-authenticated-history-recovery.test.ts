import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign, constants } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { deflateRawSync } from "node:zlib";
import test from "node:test";
import { offlineChecks } from "../scripts/manual-private-campaign.ts";
import { CARRY_ARTIFACT_NAME, openLedgerContinuation,
	 type CarryArtifactPayload } from "../src/runner/ledger-continuation.ts";
import { MISSION_ARTIFACT, MISSION_ID, MISSION_REPOSITORY, MISSION_TOTAL_CNY } from
	"../src/runner/signed-mission-ledger.ts";

const commit = (digit: string) => digit.repeat(40);
const branch = "improve/workflow-learning-reliability";
const contractId = "synthetic-contract", goalRunId = "R041", taskId = "T003";
const shared = { "candidate.cpp": "// exact synthetic source\n",
	"verification.json": "{\"version\":1,\"status\":\"passed\"}\n",
	"experiment-plan.json": "{\"version\":1,\"question\":\"synthetic\"}\n" };
function archive(m04: Record<string, unknown>) {
	return `${JSON.stringify({ version: 1, kind: "m07-private-candidate-archive", goalRunId, taskId,
		goalOutcome: "fulfilled", taskStatus: "accepted",
		controllerEvidence: { reviewStatus: "accepted", operationOutcomes: [] }, m04 })}\n`;
}
const oldFiles = { ...shared, "workflow-archive.json": archive({ state: "not-run" }),
	"lesson-delta.json": "{\"lesson\":\"old exact bytes\"}\n",
	"review-decision.json": "{\"review\":\"old exact bytes\"}\n",
	...Object.fromEntries([1, 2, 3, 4].map(round =>
		[`round-${round}-reviewer-feedback.txt`, `Old feedback ${round}\n`])) };
const latestFiles = { ...shared, "workflow-archive.json": archive({ state: "completed",
	runId: "M04-synthetic", proposalSubmitted: true, snapshotCreated: true,
	knowledgeExport: { state: "complete", file: "m04-adopted-knowledge.json" },
	transaction: { state: "merged", file: "m04-transaction.json" } }),
	"m04-adopted-knowledge.json": "{\"adopted\":\"synthetic\"}\n",
	"m04-transaction.json": "{\"state\":\"merged\"}\n" };
const oldEntry = { originalContractId: contractId, goalRunId, taskId,
	interpretation: "Earlier untrusted review and lessons", files: oldFiles };
const latestEntry = { originalContractId: contractId, goalRunId, taskId,
	interpretation: "Current M04 outcome", files: latestFiles };
const history = (entry: object) => JSON.stringify({ version: 1,
	kind: "untrusted-version-bound-research-history", entries: [entry] });
const audit = { version: 3 as const, kind: "accounting-only-request-audit" as const,
	requests: [], settledCny: 0, unknownObservedCny: 0, unpricedRequestCount: 0 };
const run = (id: number, status: string) => ({ id, run_number: id - 7000,
	run_attempt: 1, workflow_id: 91, status,
	...(status === "completed" ? { conclusion: "success" } : {}),
	head_branch: branch, head_sha: commit(String(id - 7000)), event: "workflow_dispatch",
	actor: { login: "SakuyaInazaki" } });
const current = (id: number) => ({ repository: MISSION_REPOSITORY, runId: String(id),
	runAttempt: "1", actor: "SakuyaInazaki", event: "workflow_dispatch",
	ref: `refs/heads/${branch}`, sha: commit(String(id - 7000)), manualAuthorized: "true" });

test("branded predecessor recovery seals old same-task bytes and survives later artifact expiry", async t => {
	const dir = await mkdtemp(path.join(os.tmpdir(), "composed-history-recovery-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
	const publicKeyFile = path.join(dir, "public.pem");
	await writeFile(publicKeyFile, publicKey.export({ type: "spki", format: "pem" }));
	const expectedSpkiSha256 = createHash("sha256").update(publicKey.export({
		type: "spki", format: "der" })).digest("hex");
	const payload = { version: 2, kind: "mul-pis-private-mission-ledger", missionId: MISSION_ID,
		repository: MISSION_REPOSITORY, globalMaxCny: MISSION_TOTAL_CNY,
		priorCommittedCny: 0, revision: 1,
		previous: { runId: "7001", runAttempt: 1, artifactId: "9001", artifactName: MISSION_ARTIFACT },
		rootReviewedAnchor: { commit: commit("1"), artifactSha256: "e".repeat(64),
			digestScope: "encrypted-result-envelope" },
		bootstrap: { contractId, sourceSha256: "d".repeat(64), format: "deflate-raw-json-v1",
			filesB64: deflateRawSync(JSON.stringify({ "candidate.cpp": shared["candidate.cpp"] })).toString("base64") } };
	const payloadBytes = Buffer.from(JSON.stringify(payload));
	const signature = sign("sha256", payloadBytes, { key: privateKey,
		padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 });
	const seedEnvelopeB64 = Buffer.from(JSON.stringify({ payload_b64: payloadBytes.toString("base64"),
		signature_b64: signature.toString("base64") })).toString("base64");
	const carries = new Map<string, CarryArtifactPayload>();
	let runs = [run(7001, "completed"), run(7002, "in_progress")];
	let expiredFirst = false, expiredSecond = false, predecessorDownloads = 0;
	const request: typeof fetch = async url => {
		const address = String(url);
		let data: unknown;
		if (address.includes("/workflows/manual-private-campaign.yml/runs?"))
			data = { total_count: runs.length, workflow_runs: [...runs].reverse() };
		else if (/\/runs\/700[234]\/jobs\?/.test(address)) {
			const id = Number(address.match(/\/runs\/(700[234])\/jobs\?/)![1]);
			data = { total_count: 1, jobs: [{ id: id - 1000, run_id: id, run_attempt: 1,
				head_sha: commit(String(id - 7000)), name: "private-campaign", status: "completed",
				conclusion: "success", steps: [{ name: "Run bounded private campaign",
					status: "completed", conclusion: "success" }] }] };
		} else if (/\/runs\/700[234]\/artifacts\?/.test(address)) {
			const id = Number(address.match(/\/runs\/(700[234])\/artifacts\?/)![1]);
			if (id === 7003 && expiredSecond) throw Error("expired predecessor must not be listed");
			data = { total_count: 1, artifacts: [{ id: id + 2000, name: CARRY_ARTIFACT_NAME,
				expired: id === 7002 && expiredFirst,
				workflow_run: { id, head_sha: commit(String(id - 7000)) } }] };
		} else throw Error(`unexpected synthetic GitHub request: ${address}`);
		return new Response(JSON.stringify(data), { status: 200 });
	};
	const loadCarryArtifact = async ({ runId }: { runId: string; artifactId: string }) => {
		if (runId === "7002") predecessorDownloads++;
		const carry = carries.get(runId);
		if (!carry) throw Error("synthetic carry unavailable");
		return carry;
	};
	const open = (id: number) => openLedgerContinuation({ seedEnvelopeB64, publicKeyFile,
		expectedSpkiSha256, githubToken: "synthetic-token", current: current(id),
		request, loadCarryArtifact });
	const first = await open(7002);
	const firstCarry = first.sealCurrent({ settledCny: 0, unknownObservedCny: 0,
		unpricedRequestCount: 0, requestAudit: audit,
		privateBundle: { ...first.priorPrivateBundle!, "research-history.json": history(oldEntry) } });
	carries.set("7002", firstCarry);
	runs = [run(7001, "completed"), run(7002, "completed"), run(7003, "in_progress")];
	const second = await open(7003);
	const secondCarry = second.sealCurrent({ settledCny: 0, unknownObservedCny: 0,
		unpricedRequestCount: 0, requestAudit: audit,
		privateBundle: { ...second.priorPrivateBundle!, "research-history.json": history(latestEntry) } });
	carries.set("7003", secondCarry);
	runs = [run(7001, "completed"), run(7002, "completed"), run(7003, "completed"),
		run(7004, "in_progress")];
	await t.test("an unchanged emergency wrapper cannot hide an older same-task version", async () => {
		const third = await open(7004);
		const copied = third.sealEmergencyCurrent({ settledCny: 0, unknownObservedCny: 0,
			unpricedRequestCount: 0, requestAudit: audit, privateBundle: third.priorPrivateBundle },
			"effect-review-incomplete");
		carries.set("7004", copied);
		runs = [run(7001, "completed"), run(7002, "completed"), run(7003, "completed"),
			run(7004, "completed"), run(7005, "in_progress")];
		const fourth = await open(7005);
		assert.equal(fourth.priorPrivateBundle?.["research-history.json"], history(latestEntry));
		const recovered = await offlineChecks.recoverAuthenticatedHistoricalVersions(fourth,
			fourth.priorPrivateBundle!);
		const recoveredHistory = JSON.parse(recovered["research-history.json"]!);
		assert.deepEqual(recoveredHistory.entries[0].files, latestFiles);
		assert.deepEqual(recoveredHistory.entries[0].supersededVersions,
			[{ interpretation: oldEntry.interpretation, files: oldFiles }]);
		assert.equal(recoveredHistory.predecessorHistoryReconciliation.source.runId, "7002");
		const receipt = offlineChecks.verifiedEmergencyResearchHistory(fourth, recovered);
		assert.ok(receipt, "the exact branded walk can retain old bytes in an emergency");
		fourth.sealEmergencyCurrent({ settledCny: 0, unknownObservedCny: 0,
			unpricedRequestCount: 0, requestAudit: audit, privateBundle: recovered },
			"effect-review-incomplete", receipt);
		expiredFirst = true;
		const expired = await open(7005);
		const uncertain = await offlineChecks.recoverAuthenticatedHistoricalVersions(expired,
			expired.priorPrivateBundle!);
		const marker = JSON.parse(uncertain["research-history.json"]!).predecessorHistoryReconciliation;
		assert.equal(marker.kind, "historical-completeness-unverified");
		assert.equal(marker.source.runId, "7002");
		assert.equal(marker.reason, "artifact-expired");
		const uncertainReceipt = offlineChecks.verifiedEmergencyResearchHistory(expired, uncertain);
		assert.ok(uncertainReceipt, "an unavailable exact older artifact remains explicit in emergency history");
		expired.sealEmergencyCurrent({ settledCny: 0, unknownObservedCny: 0,
			unpricedRequestCount: 0, requestAudit: audit, privateBundle: uncertain },
			"effect-review-incomplete", uncertainReceipt);
		expiredFirst = false;
		runs = [run(7001, "completed"), run(7002, "completed"), run(7003, "completed"),
			run(7004, "in_progress")];
	});
	await t.test("available predecessor restores exact old bytes and seals a durable marker", async () => {
		const third = await open(7004);
		assert.equal(third.priorPrivateBundle?.["research-history.json"], history(latestEntry));
		const beforeRecovery = predecessorDownloads;
		const recovered = await offlineChecks.recoverAuthenticatedHistoricalVersions(third,
			third.priorPrivateBundle!);
		assert.equal(predecessorDownloads, beforeRecovery + 1);
		const recoveredHistory = JSON.parse(recovered["research-history.json"]!);
		assert.deepEqual(recoveredHistory.entries[0].files, latestFiles);
		assert.deepEqual(recoveredHistory.entries[0].supersededVersions,
			[{ interpretation: oldEntry.interpretation, files: oldFiles }]);
		assert.equal(Object.keys(recoveredHistory.entries[0].files).length, 6);
		assert.equal(Object.keys(recoveredHistory.entries[0].supersededVersions[0].files).length, 10);
		assert.equal(recoveredHistory.predecessorHistoryReconciliation.source.runId, "7002");
		assert.match(recoveredHistory.predecessorHistoryReconciliation.envelopeSha256, /^[0-9a-f]{64}$/);
		const receipt = offlineChecks.verifiedEmergencyResearchHistory(third, recovered);
		assert.ok(receipt);
		const thirdCarry = third.sealCurrent({ settledCny: 0, unknownObservedCny: 0,
			unpricedRequestCount: 0, requestAudit: audit, privateBundle: recovered }, receipt);
		carries.set("7004", thirdCarry);
		runs = [run(7001, "completed"), run(7002, "completed"), run(7003, "completed"),
			run(7004, "completed"), run(7005, "in_progress")];
		expiredSecond = true;
		const fourth = await open(7005);
		const beforePassThrough = predecessorDownloads;
		const persisted = await offlineChecks.recoverAuthenticatedHistoricalVersions(fourth,
			fourth.priorPrivateBundle!);
		assert.equal(persisted, fourth.priorPrivateBundle);
		assert.equal(predecessorDownloads, beforePassThrough);
		assert.deepEqual(JSON.parse(persisted["research-history.json"]!), recoveredHistory);
	});
	await t.test("expired predecessor stays unverified and later retries its exact ancestor", async () => {
		runs = [run(7001, "completed"), run(7002, "completed"), run(7003, "completed"),
			run(7004, "in_progress")];
		expiredFirst = true;
		expiredSecond = false;
		const third = await open(7004);
		const beforeRecovery = predecessorDownloads;
		const uncertain = await offlineChecks.recoverAuthenticatedHistoricalVersions(third,
			third.priorPrivateBundle!);
		assert.equal(predecessorDownloads, beforeRecovery);
		const uncertainHistory = JSON.parse(uncertain["research-history.json"]!);
		assert.deepEqual(uncertainHistory.entries[0].files, latestFiles);
		assert.equal(uncertainHistory.entries[0].supersededVersions, undefined);
		assert.equal(uncertainHistory.predecessorHistoryReconciliation.kind,
			"historical-completeness-unverified");
		assert.equal(uncertainHistory.predecessorHistoryReconciliation.reason, "artifact-expired");
		assert.equal(uncertainHistory.predecessorHistoryReconciliation.source.runId, "7002");
		const receipt = offlineChecks.verifiedEmergencyResearchHistory(third, uncertain);
		assert.ok(receipt);
		const uncertainCarry = third.sealCurrent({ settledCny: 0, unknownObservedCny: 0,
			unpricedRequestCount: 0, requestAudit: audit, privateBundle: uncertain }, receipt);
		carries.set("7004", uncertainCarry);
		runs = [run(7001, "completed"), run(7002, "completed"), run(7003, "completed"),
			run(7004, "completed"), run(7005, "in_progress")];
		expiredSecond = true;
		const retryOpening = await open(7005);
		const stillUncertain = await offlineChecks.recoverAuthenticatedHistoricalVersions(retryOpening,
			retryOpening.priorPrivateBundle!);
		assert.deepEqual(JSON.parse(stillUncertain["research-history.json"]!), uncertainHistory);
		expiredFirst = false;
		const retryRecovered = await offlineChecks.recoverAuthenticatedHistoricalVersions(retryOpening,
			retryOpening.priorPrivateBundle!);
		assert.deepEqual(JSON.parse(retryRecovered["research-history.json"]!).entries[0].files,
			latestFiles);
		assert.deepEqual(JSON.parse(retryRecovered["research-history.json"]!).entries[0].supersededVersions,
			[{ interpretation: oldEntry.interpretation, files: oldFiles }]);
	});
});
