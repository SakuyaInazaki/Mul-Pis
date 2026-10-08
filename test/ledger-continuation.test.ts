import assert from "node:assert/strict";
import { createCipheriv, createDecipheriv, createHash, generateKeyPairSync, randomBytes, sign, constants } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { deflateRawSync } from "node:zlib";
import test, { type TestContext } from "node:test";
import { authenticateLatestTerminalCarry, authenticateLatestTerminalInterruption, authenticatedSupervisorProjection, authenticatedTerminalCarryBindsBundle, authenticatedTerminalInterruptionBindsPriorBundle, authenticatedTerminalInterruptionSupervisorProjection, isAuthenticatedTerminalCarryProof, isAuthenticatedTerminalInterruptionProof, isAuthenticatedIncrementalPrefixObservation, authenticatedIncrementalPrefixBindsPriorBundle, authenticatedAccountingObservation, authenticatedHistoricalOpaqueRunGaps, authenticatedHistoricalCarryOrigin, authenticatedPendingHistoricalEffectSources, authenticatedSelectedTransitions, authenticatedCarryForwardOrigin, authenticatedHostEffectEvidence, authenticatedPriorCarryBindsAncestor, authenticatedPriorCarryBindsBundle, authenticatedUnknownControlDeliveries, authenticatedTerminalUnknownControlDeliveries, isAuthenticatedPriorCarryProof, isAuthenticatedPredecessorResearchHistory, PredecessorResearchHistoryAccessError, PredecessorResearchHistoryIntegrityError, CARRY_ARTIFACT_NAME, CARRY_FILE_NAME, downloadCarryArtifact, openLedgerContinuation, originalObjectiveMatchesSignedBootstrap, sealHistoricalCarryForOfflineTests, REUSABLE_RUN_REQUEST_MESSAGE, retainedTransportDiagnosticWithinBundle } from "../src/runner/ledger-continuation.ts";
import { INCREMENTAL_CHECKPOINT_FILE, IncrementalPrivateCheckpointJournal } from "../src/runner/incremental-private-checkpoint.ts";
import type { CarryArtifactPayload, RequestAuditSnapshot } from "../src/runner/ledger-continuation.ts";
import { DeepSeekCampaignBudget, campaignSessionEffectId, type CampaignAdmissionRejection } from "../src/runner/deepseek-campaign.ts";
import { offlineChecks } from "../scripts/manual-private-campaign.ts";
import { Workspace } from "../src/workspace.ts";
import { reserveIndependentRestart, bindIndependentRestartGoal } from "../src/m07/independent-restart.ts";
import { createOriginalObjective, objectiveProgress, type OriginalObjectiveContractV1 } from "../src/m07/objective-progress.ts";
import { verifyDeepSeekCnyBilling, nativeCnyPricingRecord } from "../src/runner/deepseek-cny-pricing.ts";
import { verifyDeepSeekProviderOutputLimit, providerOutputLimitRecord } from "../src/runner/deepseek-provider-limits.ts";
import { checkDeepSeekAvailability } from "../src/runner/deepseek-availability.ts";
import { authenticateSignedMissionSeed, MISSION_ARTIFACT, MISSION_ID, MISSION_REPOSITORY, MISSION_TOTAL_CNY } from "../src/runner/signed-mission-ledger.ts";
import { sealCampaignCarry } from "../src/runner/emergency-carry.ts";
import { decodeCarrySidecars, encodeCarrySidecars } from "../src/runner/carry-sidecar-codec.ts";
import { CARRY_LOGICAL_BYTES } from "../src/runner/carry-sidecar-codec.ts";
import { workflowRepairState } from "../src/runner/repair-liveness.ts";
import { reconcileHistoricalResearchEntries } from "../src/runner/research-history-reconciliation.ts";

const sha = (letter: string) => letter.repeat(40);
test("v4 carry seals and opens the exact run43-size objective checkpoint in bounded sidecars", async t => {
	const f = await fixture(t);
	const targetBytes = 4_458_098;
	const base = JSON.stringify({ version: 1, kind: "original-objective-progress", detail: "" });
	const objectiveCheckpointJson = JSON.stringify({ version: 1,
		kind: "original-objective-progress", detail: "x".repeat(targetBytes - base.length) });
	assert.equal(Buffer.byteLength(objectiveCheckpointJson, "utf8"), targetBytes);
	const open = () => openLedgerContinuation({ ...f, githubToken: "synthetic-token",
		current: current(7002, sha("b")), request: github([anchor, first]),
		loadCarryArtifact: async () => "unused" });
	const zeroAudit = { version: 3 as const, kind: "accounting-only-request-audit" as const,
		requests: [], settledCny: 0, unknownObservedCny: 0, unpricedRequestCount: 0 };
	const opened = await open();
	const carry = opened.sealCurrent({ settledCny: 0, unknownObservedCny: 0,
		unpricedRequestCount: 0, requestAudit: zeroAudit,
		bootstrapBinding: { contractId: "synthetic-objective", sourceSha256: "d".repeat(64) },
		privateBundle: { "objective-checkpoint.json": objectiveCheckpointJson } });
	assert.ok(Object.keys(carry.sidecars).length > 4);
	const seed = await authenticateSignedMissionSeed({ ...f, envelopeB64: f.seedEnvelopeB64 });
	const decoded = decodeV4Checkpoint(carry, seed.seedDigest,
		seed.derivePrivateKey("mul-pis-ledger-continuation-v1"),
		{ runId: "7002", runAttempt: 1, runNumber: 2, commit: sha("b") });
	assert.equal(decoded.privateBundle["objective-checkpoint.json"], objectiveCheckpointJson);
	const next = await openLedgerContinuation({ ...f, githubToken: "synthetic-token",
		current: current(7003, sha("c")), request: github([anchor,
			{ ...first, status: "completed", conclusion: "failure" }, second]),
		loadCarryArtifact: async () => carry });
	assert.equal(next.priorPrivateBundle?.["objective-checkpoint.json"], objectiveCheckpointJson);
	assert.equal(authenticatedPriorCarryBindsBundle(next.priorCarryProof, next.priorPrivateBundle), true);
	const ordinary = await open();
	assert.throws(() => ordinary.sealCurrent({ settledCny: 0, unknownObservedCny: 0,
		unpricedRequestCount: 0, requestAudit: zeroAudit,
		bootstrapBinding: { contractId: "synthetic-objective", sourceSha256: "d".repeat(64) },
		privateBundle: { "candidate.cpp": "x".repeat(4 * 1024 * 1024 + 1) } }),
		/current carry accounting exceeds mission bounds/);
	const legacy = await open();
	assert.throws(() => sealHistoricalCarryForOfflineTests(legacy, {
		settledCny: 0, unknownOrInFlightCny: 0, requestAudit: audit(0, 0),
		bootstrapBinding: { contractId: "synthetic-objective", sourceSha256: "d".repeat(64) },
		privateBundle: { "objective-checkpoint.json": objectiveCheckpointJson } }),
		/current carry accounting exceeds mission bounds/);
});

test("v4 rejects an objective bundle above the 64 MiB decoded limit", async t => {
	const f = await fixture(t);
	const opened = await openLedgerContinuation({ ...f, githubToken: "synthetic-token",
		current: current(7002, sha("b")), request: github([anchor, first]),
		loadCarryArtifact: async () => "unused" });
	const oversized = JSON.stringify({ kind: "original-objective-progress",
		detail: "x".repeat(CARRY_LOGICAL_BYTES) });
	assert.throws(() => opened.sealCurrent({ settledCny: 0, unknownObservedCny: 0,
		unpricedRequestCount: 0, requestAudit: { version: 3, kind: "accounting-only-request-audit",
			requests: [], settledCny: 0, unknownObservedCny: 0, unpricedRequestCount: 0 },
		bootstrapBinding: { contractId: "synthetic-objective", sourceSha256: "d".repeat(64) },
		privateBundle: { "objective-checkpoint.json": oversized } }),
		/current carry accounting exceeds mission bounds/);
	const withinKeyBound = JSON.stringify({ kind: "original-objective-progress",
		detail: "x".repeat(4_458_098) });
	assert.throws(() => opened.sealCurrent({ settledCny: 0, unknownObservedCny: 0,
		unpricedRequestCount: 0, requestAudit: { version: 3, kind: "accounting-only-request-audit",
			requests: [], settledCny: 0, unknownObservedCny: 0, unpricedRequestCount: 0 },
		bootstrapBinding: { contractId: "synthetic-objective", sourceSha256: "d".repeat(64) },
		privateBundle: { "objective-checkpoint.json": withinKeyBound,
			"research-history.json": "h".repeat(CARRY_LOGICAL_BYTES - 4_458_098) } }),
		/sidecar plaintext is invalid/);
});

test("immediate predecessor history is recovered only from exact authenticated v4 ancestry", async t => {
	const f = await fixture(t);
	const seedEnvelopeB64 = attestedSeed(f);
	const emptyAudit = { version: 3 as const, kind: "accounting-only-request-audit" as const,
		requests: [], settledCny: 0, unknownObservedCny: 0, unpricedRequestCount: 0 };
	const oldHistory = JSON.stringify({ version: 1, kind: "untrusted-version-bound-research-history",
		entries: [{ taskId: "synthetic-task", version: 1, files: { "candidate.cpp": "old version" } }] });
	const newHistory = JSON.stringify({ version: 1, kind: "untrusted-version-bound-research-history",
		entries: [{ taskId: "synthetic-task", version: 2, files: { "candidate.cpp": "new version" } }] });
	const firstOpening = await openLedgerContinuation({ ...f, seedEnvelopeB64,
		githubToken: "synthetic-token", current: current(7002, sha("b")),
		request: github([anchor, first]), loadCarryArtifact: async () => "unused" });
	assert.equal(firstOpening.priorRunControlObservation, undefined);
	const firstCarry = firstOpening.sealCurrent({ settledCny: 0, unknownObservedCny: 0,
		unpricedRequestCount: 0, requestAudit: emptyAudit,
		privateBundle: { ...firstOpening.priorPrivateBundle!, "research-history.json": oldHistory } });
	const firstDone = { ...first, status: "completed", conclusion: "success" };
	const secondRun = run(7003, 3, "in_progress", sha("c"));
	const secondOpening = await openLedgerContinuation({ ...f, seedEnvelopeB64,
		githubToken: "synthetic-token", current: current(7003, sha("c")),
		request: github([anchor, firstDone, secondRun]),
		loadCarryArtifact: async () => firstCarry });
	const secondCarry = secondOpening.sealCurrent({ settledCny: 0, unknownObservedCny: 0,
		unpricedRequestCount: 0, requestAudit: emptyAudit,
		privateBundle: { ...secondOpening.priorPrivateBundle!, "research-history.json": newHistory } });
	const secondDone = { ...secondRun, status: "completed", conclusion: "success" };
	const thirdRun = run(7004, 4, "in_progress", sha("d"));
	const base = github([anchor, firstDone, secondDone, thirdRun]);
	const artifact = (runId: number, commit: string) => new Response(JSON.stringify({ total_count: 1,
		artifacts: [{ id: runId + 2000, name: CARRY_ARTIFACT_NAME, expired: false,
			workflow_run: { id: runId, head_sha: commit } }] }));
	let predecessorCommit = sha("b");
	let predecessorExpired = false;
	let predecessorMissing = false;
	let listingFailure: unknown;
	let predecessorPages: Array<{ id: number; name: string; expired: boolean;
		workflow_run: { id: number; head_sha: string } }> | undefined;
	let changeSecondPagePass = false, changePageTwoTotal = false, pageOneCalls = 0;
	const request: typeof fetch = (url, init) => {
		const address = String(url);
		if (address.includes("/runs/7002/artifacts?") && listingFailure)
			return Promise.reject(listingFailure);
		if (address.includes("/runs/7002/artifacts?") && predecessorMissing)
			return Promise.resolve(new Response(JSON.stringify({ total_count: 0, artifacts: [] })));
		if (address.includes("/runs/7002/artifacts?") && predecessorPages) {
			const page = Number(new URL(address).searchParams.get("page") ?? "1");
			const pageRows = predecessorPages.slice((page - 1) * 100, page * 100);
			if (page === 1) pageOneCalls++;
			return Promise.resolve(new Response(JSON.stringify({
				total_count: predecessorPages.length + (changePageTwoTotal && page === 2 ? 1 : 0),
				artifacts: changeSecondPagePass && page === 1 && pageOneCalls === 2 ?
					[{ ...pageRows[0], name: "changed-between-passes" }, ...pageRows.slice(1)] : pageRows })));
		}
		if (address.includes("/runs/7002/artifacts?")) return Promise.resolve(predecessorExpired ?
			new Response(JSON.stringify({ total_count: 1, artifacts: [{ id: 9002,
				name: CARRY_ARTIFACT_NAME, expired: true,
				workflow_run: { id: 7002, head_sha: predecessorCommit } }] })) :
			artifact(7002, predecessorCommit));
		if (address.includes("/runs/7003/artifacts?")) return Promise.resolve(artifact(7003, sha("c")));
		if (address.includes("/runs/7003/jobs?")) return Promise.resolve(new Response(JSON.stringify({
			total_count: 1, jobs: [{ id: 6003, run_id: 7003, run_attempt: 1, head_sha: sha("c"),
				name: "private-campaign", status: "completed", conclusion: "success",
				steps: [{ name: "Run bounded private campaign", status: "completed", conclusion: "success" }] }] })));
		return base(url, init);
	};
	let predecessorPayload: CarryArtifactPayload = firstCarry;
	let downloadFailure: unknown;
	const reopened = await openLedgerContinuation({ ...f, seedEnvelopeB64,
		githubToken: "synthetic-token", current: current(7004, sha("d")), request,
		loadCarryArtifact: async ({ runId }) => {
			if (runId === "7002" && downloadFailure) throw downloadFailure;
			return runId === "7002" ? predecessorPayload : secondCarry;
		} });
	assert.equal(reopened.priorPrivateBundle?.["research-history.json"], newHistory);
	const recovered = await reopened.recoverImmediatePredecessorResearchHistory();
	assert.equal(isAuthenticatedPredecessorResearchHistory(recovered), true);
	if (!isAuthenticatedPredecessorResearchHistory(recovered)) return;
	assert.equal(isAuthenticatedPredecessorResearchHistory({ ...recovered }), false);
	assert.equal(recovered.text, oldHistory);
	assert.equal(recovered.source.runId, "7002");
	assert.equal(recovered.selectionAuthority, false);
	assert.equal(recovered.envelopeSha256,
		createHash("sha256").update(Buffer.from(firstCarry.envelopeB64, "base64")).digest("hex"));
	predecessorPages = [...Array.from({ length: 100 }, (_, index) => ({
		id: 12000 - index, name: `unrelated-${index}`, expired: false,
		workflow_run: { id: 7002, head_sha: sha("b") } })),
		{ id: 9002, name: CARRY_ARTIFACT_NAME, expired: false,
			workflow_run: { id: 7002, head_sha: sha("b") } }];
	const beyondOnePage = await reopened.recoverImmediatePredecessorResearchHistory();
	assert.equal(beyondOnePage.kind === "authenticated-predecessor-research-history" ?
		beyondOnePage.text : undefined, oldHistory);
	assert.equal(pageOneCalls, 2, "both complete pagination passes were checked");
	predecessorPages[100] = { ...predecessorPages[100], id: predecessorPages[0].id };
	await assert.rejects(reopened.recoverImmediatePredecessorResearchHistory(),
		(error: unknown) => error instanceof PredecessorResearchHistoryIntegrityError);
	predecessorPages[100] = { ...predecessorPages[100], id: 9002 };
	changeSecondPagePass = true; pageOneCalls = 0;
	await assert.rejects(reopened.recoverImmediatePredecessorResearchHistory(),
		(error: unknown) => error instanceof PredecessorResearchHistoryIntegrityError);
	changeSecondPagePass = false; changePageTwoTotal = true;
	await assert.rejects(reopened.recoverImmediatePredecessorResearchHistory(),
		(error: unknown) => error instanceof PredecessorResearchHistoryIntegrityError);
	changePageTwoTotal = false; predecessorPages = undefined;
	listingFailure = Error("private synthetic connector detail");
	await assert.rejects(reopened.recoverImmediatePredecessorResearchHistory(),
		(error: unknown) => error instanceof PredecessorResearchHistoryAccessError &&
			error.stage === "artifact-list" && error.cause === listingFailure &&
			!error.message.includes("private synthetic connector detail") &&
			!JSON.stringify(error).includes("private synthetic connector detail"));
	listingFailure = undefined;
	downloadFailure = Error("private synthetic downloader detail");
	await assert.rejects(reopened.recoverImmediatePredecessorResearchHistory(),
		(error: unknown) => error instanceof PredecessorResearchHistoryAccessError &&
			error.stage === "artifact-download" && error.cause === downloadFailure &&
			!error.message.includes("private synthetic downloader detail") &&
			!JSON.stringify(error).includes("private synthetic downloader detail"));
	downloadFailure = undefined;
	predecessorCommit = sha("f");
	await assert.rejects(reopened.recoverImmediatePredecessorResearchHistory(),
		(error: unknown) => error instanceof PredecessorResearchHistoryIntegrityError);
	predecessorCommit = sha("b");
	predecessorPayload = { ...firstCarry, envelopeB64: secondCarry.envelopeB64 };
	await assert.rejects(reopened.recoverImmediatePredecessorResearchHistory(),
		(error: unknown) => error instanceof PredecessorResearchHistoryIntegrityError);
	const tamperedOuter = JSON.parse(Buffer.from(firstCarry.envelopeB64, "base64").toString("utf8"));
	tamperedOuter.tag = `${tamperedOuter.tag[0] === "A" ? "B" : "A"}${tamperedOuter.tag.slice(1)}`;
	predecessorPayload = { ...firstCarry,
		envelopeB64: Buffer.from(JSON.stringify(tamperedOuter)).toString("base64") };
	await assert.rejects(reopened.recoverImmediatePredecessorResearchHistory(),
		(error: unknown) => error instanceof PredecessorResearchHistoryIntegrityError);
	const seed = await authenticateSignedMissionSeed({ ...f, envelopeB64: seedEnvelopeB64 });
	const predecessorSource = { runId: "7002", runAttempt: 1, runNumber: 2, commit: sha("b") };
	const key = seed.derivePrivateKey("mul-pis-ledger-continuation-v1");
	predecessorPayload = resealV4Checkpoint(decodeV4Checkpoint(firstCarry,
		seed.seedDigest, key, predecessorSource), seed.seedDigest, key, predecessorSource);
	await assert.rejects(reopened.recoverImmediatePredecessorResearchHistory(),
		(error: unknown) => error instanceof PredecessorResearchHistoryIntegrityError &&
			/differs from authenticated ancestry/.test(error.message));
	predecessorExpired = true;
	const expectedUnavailable = {
		version: 1, kind: "predecessor-research-history-unavailable",
		reason: "artifact-expired", predecessor: {
			source: { runId: "7002", runAttempt: 1, runNumber: 2, commit: sha("b") },
			envelopeSha256: recovered.envelopeSha256 } };
	const expired = await reopened.recoverImmediatePredecessorResearchHistory();
	assert.deepEqual(expired, expectedUnavailable);
	assert.equal(isAuthenticatedPredecessorResearchHistory(expired), false);
	predecessorExpired = false;
	predecessorMissing = true;
	const missing = await reopened.recoverImmediatePredecessorResearchHistory();
	assert.deepEqual(missing, { ...expectedUnavailable, reason: "artifact-not-observed" });
	assert.equal(isAuthenticatedPredecessorResearchHistory(missing), false);
	predecessorMissing = false;
	predecessorPayload = firstCarry;
	const thirdCarry = reopened.sealCurrent({ settledCny: 0, unknownObservedCny: 0,
		unpricedRequestCount: 0, requestAudit: emptyAudit });
	const thirdDone = { ...thirdRun, status: "completed", conclusion: "success" };
	const fourthRun = run(7005, 5, "in_progress", sha("e"));
	const fourthBase = github([anchor, firstDone, secondDone, thirdDone, fourthRun]);
	const fourthRequest: typeof fetch = (url, init) => {
		const address = String(url);
		if (address.includes("/workflows/manual-private-campaign.yml/runs?"))
			return fourthBase(url, init);
		if (address.includes("/runs/7004/artifacts?"))
			return Promise.resolve(artifact(7004, sha("d")));
		if (address.includes("/runs/7004/jobs?")) return Promise.resolve(new Response(JSON.stringify({
			total_count: 1, jobs: [{ id: 6004, run_id: 7004, run_attempt: 1, head_sha: sha("d"),
				name: "private-campaign", status: "completed", conclusion: "success",
				steps: [{ name: "Run bounded private campaign", status: "completed", conclusion: "success" }] }] })));
		return request(url, init);
	};
	const successor = await openLedgerContinuation({ ...f, seedEnvelopeB64,
		githubToken: "synthetic-token", current: current(7005, sha("e")), request: fourthRequest,
		loadCarryArtifact: async ({ runId }) => runId === "7004" ? thirdCarry : firstCarry });
	const olderTarget = { source: recovered.source, envelopeSha256: recovered.envelopeSha256 };
	const older = await successor.recoverImmediatePredecessorResearchHistory(olderTarget);
	assert.equal(isAuthenticatedPredecessorResearchHistory(older), true);
	assert.equal(older.kind === "authenticated-predecessor-research-history" ? older.text : undefined,
		oldHistory);
	await assert.rejects(successor.recoverImmediatePredecessorResearchHistory({
		...olderTarget, envelopeSha256: "f".repeat(64) }), /target is not an earlier authenticated/);
	predecessorMissing = true;
	assert.deepEqual(await successor.recoverImmediatePredecessorResearchHistory(olderTarget),
		{ ...expectedUnavailable, reason: "artifact-not-observed" });
});
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

test("historical six-field grounded nextTask survives v4/v3 carry without acquiring authority", async t => {
	const f = await fixture(t);
	const contract = createOriginalObjective({ goal: "Synthetic source-grounded mission",
		goalSource: "user-intent-summary", inputNames: ["input.txt"],
		obligations: [{ id: "O1", description: "Check the synthetic result" }],
		closure: "open-ended" });
	// This is the old accepted form: the objective was mirrored at the top level,
	// while groundedAssessment.nextTask had the six other fields only.
	const historicalAssessment = {
		version: 1, decision: "continue", rationale: "An original requirement remains open",
		evidenceRefs: [], unresolvedObligations: ["O1"],
		unresolvedDetails: ["Check the synthetic result"],
		nextTask: { objective: "Check the synthetic result", addresses: ["O1"],
			adapterScope: "synthetic-scope" },
		groundedAssessment: { version: 1, kind: "grounded-assessment-proposal",
			contractId: contract.id, missionStatus: "open", legacyOpenDetails: [],
			issues: [{ id: "I1", claim: "Check the synthetic result", status: "open",
				classification: "explicit-requirement", implication: "The result is unresolved",
				sourceRefs: [{ sourceId: "input.txt", startLine: 1, endLine: 1 }] }],
			nextTask: { obligationIds: ["O1"], addresses: ["I1"],
				adapterScope: "synthetic-scope",
				decisionChangingHypothesis: "A check can resolve I1",
				expectedEvidence: "A checked synthetic result",
				sourceRefs: [{ sourceId: "input.txt", startLine: 1, endLine: 1 }] } },
		sessionId: "historical-assessor", model: "synthetic-model", evidenceRead: [],
		unreadEvidence: [], blockedProposals: [] };
	const selectedArtifacts = ["candidate.cpp", "verification.json", "workflow-archive.json"];
	const checkpoint = objectiveProgress(contract, { boundedRuns: [], selectedArtifacts,
		assessment: historicalAssessment as unknown as NonNullable<ReturnType<typeof objectiveProgress>["assessment"]>,
		assessmentHistory: [{ iteration: 1,
			assessment: historicalAssessment as unknown as NonNullable<ReturnType<typeof objectiveProgress>["assessment"]>,
			stopReason: "next-task-pending", advanced: false }], stopReason: "next-task-pending" });
	const checkpointBytes = JSON.stringify(checkpoint);
	assert.equal(Object.hasOwn(historicalAssessment.groundedAssessment.nextTask, "objective"), false);
	const bundle = { "candidate.cpp": "synthetic accepted source",
		"verification.json": "{}", "workflow-archive.json": "{}",
		"original-objective.json": JSON.stringify(contract),
		"objective-checkpoint.json": checkpointBytes };
	const seedEnvelopeB64 = f.signSeed({ ...f.payload, version: 2,
		rootReviewedAnchor: { commit: sha("a"), artifactSha256: "e".repeat(64),
			digestScope: "encrypted-result-envelope" },
		bootstrap: { contractId: contract.id, sourceSha256: "d".repeat(64),
			format: "deflate-raw-json-v1",
			filesB64: deflateRawSync(JSON.stringify(bundle)).toString("base64") } });
	const firstOpened = await openLedgerContinuation({ ...f, seedEnvelopeB64,
		githubToken: "synthetic-token", current: current(7002, sha("b")),
		request: github([anchor, first]), loadCarryArtifact: async () => "unused" });
	const firstCarry = sealHistoricalCarryForOfflineTests(firstOpened, { settledCny: 0,
		unknownOrInFlightCny: 0.25, requestAudit: audit(0, 0.25) });
	const firstDone = { ...first, status: "completed", conclusion: "success" };
	const secondOpened = await openLedgerContinuation({ ...f, seedEnvelopeB64,
		githubToken: "synthetic-token", current: current(7003, sha("c")),
		request: github([anchor, firstDone, second]),
		loadCarryArtifact: async () => firstCarry.envelopeB64 });
	const secondCarry = sealHistoricalCarryForOfflineTests(secondOpened, { settledCny: 0,
		unknownOrInFlightCny: 0, requestAudit: audit(0, 0) });
	const secondDone = { ...second, status: "completed", conclusion: "success" };
	const priorBase = github([anchor, firstDone, secondDone, third]);
	const priorRequest: typeof fetch = async (url, init) => {
		const address = String(url);
		if (address.includes("/runs/7003/jobs?")) return new Response(JSON.stringify({ total_count: 1,
			jobs: [{ id: 6003, run_id: 7003, run_attempt: 1, head_sha: sha("c"),
				name: "private-campaign", status: "completed", conclusion: "success",
				steps: [{ name: "Run private campaign", status: "completed", conclusion: "success" }] }] }));
		if (address.includes("/runs/7003/artifacts?")) return new Response(JSON.stringify({ total_count: 1,
			artifacts: [{ id: 9003, name: CARRY_ARTIFACT_NAME, expired: false,
				workflow_run: { id: 7003, head_sha: sha("c") } }] }));
		return priorBase(url, init);
	};
	const opened = await openLedgerContinuation({ ...f, seedEnvelopeB64,
		githubToken: "synthetic-token", current: current(7005, sha("e")),
		request: priorRequest, loadCarryArtifact: async () => secondCarry.envelopeB64 });
	const emptyAudit = { version: 3 as const, kind: "accounting-only-request-audit" as const,
		requests: [], settledCny: 0, unknownObservedCny: 0, unpricedRequestCount: 0 };
	const carry = opened.sealCurrent({ settledCny: 0, unknownObservedCny: 0,
		unpricedRequestCount: 0, requestAudit: emptyAudit });
	const seed = await authenticateSignedMissionSeed({ ...f, envelopeB64: seedEnvelopeB64 });
	const source = { runId: "7005", runAttempt: 1, runNumber: 4, commit: sha("e") };
	assert.equal(decodeV4Checkpoint(carry, seed.seedDigest,
		seed.derivePrivateKey("mul-pis-ledger-continuation-v1"), source)
		.privateBundle["objective-checkpoint.json"], checkpointBytes);
	const next = run(7006, 5, "in_progress", sha("f"));
	const base = github([anchor, firstDone, secondDone,
		{ ...third, status: "completed", conclusion: "failure" }, next]);
	const request: typeof fetch = async (url, init) => {
		const address = String(url);
		if (address.includes("/runs/7003/jobs?") || address.includes("/runs/7003/artifacts?"))
			return priorRequest(url, init);
		if (address.includes("/runs/7005/jobs?")) return new Response(JSON.stringify({ total_count: 1,
			jobs: [{ id: 6005, run_id: 7005, run_attempt: 1, head_sha: sha("e"),
				name: "private-campaign", status: "completed", conclusion: "failure",
				steps: [{ name: "Run private campaign", status: "completed", conclusion: "failure" }] }] }));
		if (address.includes("/runs/7005/artifacts?")) return new Response(JSON.stringify({ total_count: 1,
			artifacts: [{ id: 9005, name: CARRY_ARTIFACT_NAME, expired: false,
				workflow_run: { id: 7005, head_sha: sha("e") } }] }));
		return base(url, init);
	};
	const reopened = await openLedgerContinuation({ ...f, seedEnvelopeB64, githubToken: "synthetic-token",
		current: current(7006, sha("f")), request, loadCarryArtifact: async () => carry });
	assert.equal(reopened.priorPrivateBundle?.["objective-checkpoint.json"], checkpointBytes);
	assert.equal(JSON.parse(reopened.priorPrivateBundle!["objective-checkpoint.json"]!)
		.assessment.groundedAssessment.nextTask.objective, undefined);
	assert.equal(authenticatedPriorCarryBindsBundle(reopened.priorCarryProof, reopened.priorPrivateBundle), true);
	assert.deepEqual(authenticatedSelectedTransitions(reopened.priorCarryProof, reopened.priorPrivateBundle),
		authenticatedSelectedTransitions(opened.priorCarryProof, opened.priorPrivateBundle));
	for (const name of selectedArtifacts)
		assert.equal((reopened.priorPrivateBundle as Record<string, string>)[name],
			(opened.priorPrivateBundle as Record<string, string>)[name]);
	assert.equal(reopened.historicalUnknownHeldCny, opened.historicalUnknownHeldCny);
	assert.equal(reopened.historicalUnknownHeldCny, 0.25);
	assert.equal(reopened.priorUnknownObservedCny, 0);
	const forwarded = reopened.sealCurrent({ settledCny: 0, unknownObservedCny: 0,
		unpricedRequestCount: 0, requestAudit: emptyAudit });
	assert.equal(decodeV4Checkpoint(forwarded, seed.seedDigest,
		seed.derivePrivateKey("mul-pis-ledger-continuation-v1"),
		{ runId: "7006", runAttempt: 1, runNumber: 5, commit: sha("f") })
		.privateBundle["objective-checkpoint.json"], checkpointBytes);
});
test("private repair telemetry is schema checked and AEAD carried without granting selection authority", async t => {
	const f = await compactedFixture(t);
	const opened = await openLedgerContinuation({ ...f, githubToken: "synthetic-token",
		current: current(7005, sha("e")), loadCarryArtifact: async () => f.secondCarry.envelopeB64 });
	const receipt = workflowRepairState({ stage: "objective-assessment",
		failure: "invalid-assessment", evidenceFingerprint: "a".repeat(64),
		planFingerprint: "b".repeat(64), responseFingerprint: "c".repeat(64),
		strategy: "fresh-context", sessionGeneration: 2 });
	const bundle = { ...opened.priorPrivateBundle, "repair-state.json": JSON.stringify(receipt) };
	const requestAudit = { version: 3 as const, kind: "accounting-only-request-audit" as const,
		requests: [], settledCny: 0, unknownObservedCny: 0, unpricedRequestCount: 0 };
	const sealed = opened.sealCurrent({ settledCny: 0, unknownObservedCny: 0,
		unpricedRequestCount: 0, requestAudit, privateBundle: bundle });
	const seed = await authenticateSignedMissionSeed({ ...f, envelopeB64: f.seedEnvelopeB64 });
	const checkpoint = decodeV4Checkpoint(sealed, seed.seedDigest,
		seed.derivePrivateKey("mul-pis-ledger-continuation-v1"),
		{ runId: "7005", runAttempt: 1, runNumber: 4, commit: sha("e") });
	assert.equal(checkpoint.privateBundle["repair-state.json"], JSON.stringify(receipt));
	assert.equal(checkpoint.privateBundle["candidate.cpp"],
		opened.priorPrivateBundle?.["candidate.cpp"], "repair telemetry cannot replace selected science");
	const malformed = await openLedgerContinuation({ ...f, githubToken: "synthetic-token",
		current: current(7005, sha("e")), loadCarryArtifact: async () => f.secondCarry.envelopeB64 });
	assert.throws(() => malformed.sealCurrent({ settledCny: 0, unknownObservedCny: 0,
		unpricedRequestCount: 0, requestAudit,
		privateBundle: { ...bundle, "repair-state.json": JSON.stringify({ ...receipt,
			strategy: "scientific-acceptance" }) } }), /current carry accounting exceeds mission bounds/);
});
const HISTORICAL_PUSH_MESSAGE = "Synthetic old control request";
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

test("latest terminal carry is live-authenticated before supervisor projection", async t => {
	const f = await fixture(t);
	const contract = createOriginalObjective({ goal: "Synthetic task", goalSource: "user-intent-summary",
		inputNames: ["input.txt"], obligations: [{ id: "O1", description: "Synthetic check" }],
		closure: "open-ended" });
	const bundle = { "original-objective.json": JSON.stringify(contract),
		"objective-checkpoint.json": JSON.stringify(objectiveProgress(contract, {
			boundedRuns: [], selectedArtifacts: ["candidate.cpp", "verification.json", "workflow-archive.json"],
			stopReason: "bounded-run-incomplete" })),
		"candidate.cpp": "synthetic candidate", "verification.json": "{}", "workflow-archive.json": "{}" };
	const seedEnvelopeB64 = f.signSeed({ ...f.payload, version: 2,
		rootReviewedAnchor: { commit: sha("a"), artifactSha256: "e".repeat(64),
			digestScope: "encrypted-result-envelope" },
		bootstrap: { contractId: contract.id, sourceSha256: "d".repeat(64),
			format: "deflate-raw-json-v1", filesB64: deflateRawSync(JSON.stringify(bundle)).toString("base64") } });
	const source = current(7002, sha("b"));
	const opening = await openLedgerContinuation({ ...f, seedEnvelopeB64, githubToken: "synthetic-token",
		current: source, request: github([anchor, first]), loadCarryArtifact: async () => "unused" });
	const carry = opening.sealCurrent({ settledCny: 0, unknownObservedCny: 0,
		unpricedRequestCount: 0, requestAudit: { version: 3, kind: "accounting-only-request-audit",
			requests: [], settledCny: 0, unknownObservedCny: 0, unpricedRequestCount: 0 } });
	const done = { ...first, status: "completed", conclusion: "failure" };
	const live = (runs: object[], actor = "SakuyaInazaki"): typeof fetch => {
		const base = github(runs);
		return (url, init) => String(url).endsWith("/actions/runs/7002") ?
			Promise.resolve(new Response(JSON.stringify({ ...done, actor: { login: actor } }))) : base(url, init);
	};
	const common = { ...f, seedEnvelopeB64, githubToken: "synthetic-token", source,
		request: live([anchor, done]), loadCarryArtifact: async () => carry };
	const terminal = await authenticateLatestTerminalCarry(common);
	assert.equal(isAuthenticatedTerminalCarryProof(terminal.proof), true);
	const withResultArtifact: typeof fetch = async (url, init) =>
		String(url).endsWith("/runs/7002/artifacts?per_page=100") ?
			new Response(JSON.stringify({ total_count: 2, artifacts: [
				{ id: 9002, name: CARRY_ARTIFACT_NAME, expired: false,
					workflow_run: { id: 7002, head_sha: sha("b") } },
				{ id: 9202, name: MISSION_ARTIFACT, expired: false,
					digest: `sha256:${"9".repeat(64)}`,
					workflow_run: { id: 7002, head_sha: sha("b") } }] })) :
			common.request(url, init);
	const resultBound = await authenticateLatestTerminalCarry({ ...common,
		request: withResultArtifact });
	assert.equal(resultBound.proof.resultArtifact?.artifactId, "9202");
	assert.equal(resultBound.proof.resultArtifact?.archiveSha256, "9".repeat(64));
	assert.equal(terminal.proof.resultArtifact, undefined);
	const sealedWithStalePrefix = await authenticateLatestTerminalCarry({ ...common,
		loadCarryArtifact: async () => ({ ...carry, incrementalControlPrefix: "stale-untrusted-prefix" }) });
	assert.equal(isAuthenticatedTerminalCarryProof(sealedWithStalePrefix.proof), true);
	assert.equal(sealedWithStalePrefix.proof.envelopeSha256, terminal.proof.envelopeSha256);
	assert.doesNotMatch(JSON.stringify(terminal.proof), /synthetic candidate|Synthetic task/);
	assert.equal(isAuthenticatedTerminalCarryProof({ ...terminal.proof }), false);
	assert.equal(authenticatedTerminalCarryBindsBundle(terminal.proof, terminal.privateBundle), true);
	assert.equal(authenticatedTerminalCarryBindsBundle(terminal.proof,
		{ ...terminal.privateBundle, "candidate.cpp": "changed" }), false);
	const projection = authenticatedSupervisorProjection(terminal.proof, terminal.privateBundle);
	assert.equal(projection?.status.contractId, contract.id);
	assert.equal(projection?.status.objectiveOutcome, "incomplete");
	assert.equal(projection?.pendingAction, undefined);
	assert.equal(projection?.terminalCarry.source.runId, "7002");
	assert.equal(projection?.terminalCarry.checkpointSha256,
		createHash("sha256").update(terminal.privateBundle["objective-checkpoint.json"]!).digest("hex"));
	assert.equal(authenticatedSupervisorProjection({ ...terminal.proof }, terminal.privateBundle), undefined);
	assert.equal(authenticatedSupervisorProjection(terminal.proof,
		{ ...terminal.privateBundle, "candidate.cpp": "changed" }), undefined);
	await assert.rejects(authenticateLatestTerminalCarry({ ...common,
		source: { ...source, sha: sha("c") } }), /identity|source/);
	await assert.rejects(authenticateLatestTerminalCarry({ ...common,
		request: live([anchor, { ...done, actor: { login: "other" } }]) }), /identity|source/);
	await assert.rejects(authenticateLatestTerminalCarry({ ...common,
		request: github([anchor, done], { duplicateCarry: true }) }), /artifact/);
	const outer = JSON.parse(Buffer.from(carry.envelopeB64, "base64").toString("utf8"));
	outer.tag = `${outer.tag[0] === "A" ? "B" : "A"}${outer.tag.slice(1)}`;
	const altered = Buffer.from(JSON.stringify(outer)).toString("base64");
	await assert.rejects(authenticateLatestTerminalCarry({ ...common,
		loadCarryArtifact: async () => altered }), /authentication/);
	const seed = await authenticateSignedMissionSeed({ envelopeB64: seedEnvelopeB64,
		publicKeyFile: f.publicKeyFile, expectedSpkiSha256: f.expectedSpkiSha256 });
	const key = seed.derivePrivateKey("mul-pis-ledger-continuation-v1");
	const expectedSource = { runId: "7002", runAttempt: 1, runNumber: 2, commit: sha("b") };
	const checkpoint = decodeV4Checkpoint(carry, seed.seedDigest, key, expectedSource);
	const changedParent = "f".repeat(64);
	checkpoint.parentDigest = changedParent;
	const brokenChain = resealV4Checkpoint(checkpoint, seed.seedDigest, key, expectedSource);
	await assert.rejects(authenticateLatestTerminalCarry({ ...common,
		loadCarryArtifact: async () => brokenChain }), /ancestry|accounting/);
	const changedSelection = decodeV4Checkpoint(carry, seed.seedDigest, key, expectedSource);
	changedSelection.privateBundle["candidate.cpp"] = "unreviewed replacement";
	const unprovenSelection = resealV4Checkpoint(changedSelection, seed.seedDigest, key, expectedSource);
	await assert.rejects(authenticateLatestTerminalCarry({ ...common,
		loadCarryArtifact: async () => unprovenSelection }), /selected tuple.*provenance/);
	const unsupportedClosure = decodeV4Checkpoint(carry, seed.seedDigest, key, expectedSource);
	const closureCheckpoint = JSON.parse(unsupportedClosure.privateBundle["objective-checkpoint.json"]);
	closureCheckpoint.objectiveOutcome = "fulfilled";
	closureCheckpoint.stopReason = null;
	unsupportedClosure.privateBundle["objective-checkpoint.json"] = JSON.stringify(closureCheckpoint);
	const unprovedClosure = resealV4Checkpoint(unsupportedClosure, seed.seedDigest, key, expectedSource);
	await assert.rejects(authenticateLatestTerminalCarry({ ...common,
		loadCarryArtifact: async () => unprovedClosure }), /closure lacks an independent host receipt/);
	const newer = run(7003, 3, "completed", sha("c"), "failure");
	const withNewer: typeof fetch = (url, init) => String(url).endsWith("/runs/7003/jobs?per_page=100") ?
		Promise.resolve(new Response(JSON.stringify({ total_count: 1, jobs: [{ id: 6003, run_id: 7003,
			run_attempt: 1, head_sha: sha("c"), name: "private-campaign", status: "completed",
			conclusion: "failure", steps: [{ name: "Run private campaign", status: "completed",
				conclusion: "failure" }] }] }))) : live([anchor, done, newer])(url, init);
	await assert.rejects(authenticateLatestTerminalCarry({ ...common, request: withNewer }),
		/latest completed workflow run/);
});

test("terminal control request authenticates its immutable tested source after feature publication", async t => {
	const f = await fixture(t);
	const contract = createOriginalObjective({ goal: "Synthetic control task",
		goalSource: "user-intent-summary", inputNames: ["input.txt"],
		obligations: [{ id: "O1", description: "Synthetic check" }], closure: "open-ended" });
	const bundle = { "original-objective.json": JSON.stringify(contract),
		"objective-checkpoint.json": JSON.stringify(objectiveProgress(contract, {
			boundedRuns: [], selectedArtifacts: ["candidate.cpp", "verification.json", "workflow-archive.json"],
			stopReason: "bounded-run-incomplete" })),
		"candidate.cpp": "synthetic candidate", "verification.json": "{}", "workflow-archive.json": "{}" };
	const seedEnvelopeB64 = f.signSeed({ ...f.payload, version: 2,
		rootReviewedAnchor: { commit: sha("a"), artifactSha256: "e".repeat(64),
			digestScope: "encrypted-result-envelope" },
		bootstrap: { contractId: contract.id, sourceSha256: "d".repeat(64),
			format: "deflate-raw-json-v1", filesB64: deflateRawSync(JSON.stringify(bundle)).toString("base64") } });
	const testedSource = sha("f"), advancedTip = sha("e"), tree = sha("1");
	const control = { ...first, event: "push", head_branch: "run-requests/workflow-learning-reliability",
		head_commit: { message: REUSABLE_RUN_REQUEST_MESSAGE } };
	const completedControl = { ...control, status: "completed", conclusion: "failure" };
	const source = { ...current(7002, sha("b")), event: "push", before: testedSource,
		ref: "refs/heads/run-requests/workflow-learning-reliability" };
	const requestFor = (terminal: boolean, sourceTree = tree, ciSuccess = true,
		featureTip = terminal ? advancedTip : testedSource): typeof fetch => {
		const run = terminal ? completedControl : control;
		const base = github([anchor, run]);
		return async (url, init) => {
			const address = String(url);
			if (address.endsWith("/git/ref/heads/improve/workflow-learning-reliability"))
				return new Response(JSON.stringify({ object: { sha: featureTip } }));
			if (address.endsWith(`/git/commits/${sha("b")}`))
				return new Response(JSON.stringify({ parents: [{ sha: testedSource }], tree: { sha: tree } }));
			if (address.endsWith(`/git/commits/${testedSource}`) ||
				address.endsWith(`/git/commits/${advancedTip}`))
				return new Response(JSON.stringify({ tree: { sha: sourceTree } }));
			if (address.includes("/actions/workflows/workflow-regression.yml/runs?")) {
				assert.match(address, new RegExp(`head_sha=${testedSource}`));
				return new Response(JSON.stringify({ workflow_runs: ciSuccess ? [{ head_sha: testedSource,
					head_branch: "improve/workflow-learning-reliability", event: "push", run_attempt: 1,
					status: "completed", conclusion: "success" }] : [] }));
			}
			if (address.endsWith("/actions/runs/7002"))
				return new Response(JSON.stringify(completedControl));
			return base(url, init);
		};
	};
	const opening = await openLedgerContinuation({ ...f, seedEnvelopeB64, githubToken: "synthetic-token",
		current: source, request: requestFor(false), loadCarryArtifact: async () => "unused" });
	await assert.rejects(openLedgerContinuation({ ...f, seedEnvelopeB64, githubToken: "synthetic-token",
		current: source, request: requestFor(false, tree, true, advancedTip),
		loadCarryArtifact: async () => "unused" }), /accepted source tree/);
	const carry = opening.sealCurrent({ settledCny: 0, unknownObservedCny: 0, unpricedRequestCount: 0,
		requestAudit: { version: 3, kind: "accounting-only-request-audit", requests: [],
			settledCny: 0, unknownObservedCny: 0, unpricedRequestCount: 0 } });
	const terminalInput = { ...f, seedEnvelopeB64, githubToken: "synthetic-token", source,
		loadCarryArtifact: async () => carry };
	const terminal = await authenticateLatestTerminalCarry({ ...terminalInput, request: requestFor(true) });
	assert.equal(authenticatedSupervisorProjection(terminal.proof, terminal.privateBundle)?.status.contractId,
		contract.id);
	assert.deepEqual(authenticatedTerminalUnknownControlDeliveries(terminal.proof,
		terminal.privateBundle), []);
	assert.equal(authenticatedTerminalUnknownControlDeliveries({ ...terminal.proof },
		terminal.privateBundle), undefined);
	await assert.rejects(authenticateLatestTerminalCarry({ ...terminalInput,
		request: requestFor(true, sha("2")) }), /accepted source tree/);
	await assert.rejects(authenticateLatestTerminalCarry({ ...terminalInput,
		request: requestFor(true, tree, false) }), /successful offline regression/);
	const oldControl = sha("d"), oldSource = sha("e");
	const linkedSource = { ...source, before: oldControl };
	const linkedRequest = (done: boolean): typeof fetch => async (url, init) => {
		const address = String(url);
		if (address.endsWith(`/git/commits/${sha("b")}`))
			return new Response(JSON.stringify({ parents: [{ sha: testedSource }, { sha: oldControl }],
				tree: { sha: tree } }));
		if (address.endsWith(`/git/commits/${oldControl}`))
			return new Response(JSON.stringify({ sha: oldControl, message: REUSABLE_RUN_REQUEST_MESSAGE,
				parents: [{ sha: oldSource }], tree: { sha: tree } }));
		if (address.endsWith(`/git/commits/${oldSource}`))
			return new Response(JSON.stringify({ sha: oldSource, tree: { sha: tree } }));
		if (address.includes(`/workflows/manual-private-campaign.yml/runs?head_sha=${oldControl}`))
			return new Response(JSON.stringify({ total_count: 0, workflow_runs: [] }));
		if (address.includes(`/workflows/workflow-regression.yml/runs?head_sha=${oldSource}`))
			return new Response(JSON.stringify({ workflow_runs: [{ head_sha: oldSource,
				head_branch: "improve/workflow-learning-reliability", event: "push",
				run_attempt: 1, status: "completed", conclusion: "success" }] }));
		return requestFor(done)(url, init);
	};
	const linkedOpening = await openLedgerContinuation({ ...f, seedEnvelopeB64,
		githubToken: "synthetic-token", current: linkedSource,
		request: linkedRequest(false), loadCarryArtifact: async () => "unused" });
	const linkedCarry = linkedOpening.sealCurrent({ settledCny: 0, unknownObservedCny: 0,
		unpricedRequestCount: 0, requestAudit: { version: 3,
			kind: "accounting-only-request-audit", requests: [], settledCny: 0,
			unknownObservedCny: 0, unpricedRequestCount: 0 } });
	const linkedTerminal = await authenticateLatestTerminalCarry({ ...f, seedEnvelopeB64,
		githubToken: "synthetic-token", source: linkedSource,
		request: linkedRequest(true), loadCarryArtifact: async () => linkedCarry });
	assert.deepEqual(authenticatedTerminalUnknownControlDeliveries(linkedTerminal.proof,
		linkedTerminal.privateBundle)?.map(row => row.controlCommit), [oldControl]);
});

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
		unknownOrInFlightCny: 0.75, requestAudit: audit(1.25, 0.75),
		bootstrapBinding: { contractId: "synthetic-history", sourceSha256: "d".repeat(64) },
		privateBundle: { "candidate.cpp": "synthetic prior research" } });
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
		loadCarryArtifact: async () => sealed });
	assert.equal(next.historicalCommittedCny, 6.125);
	assert.equal(next.historicalUnknownHeldCny, 0.75);
	assert.equal(next.priorSettledCny, 42.25);
	assert.equal(next.priorUnknownObservedCny, 1.5);
	assert.equal(next.priorUnpricedRequestCount, 1);
	assert.equal(next.priorCarryProof?.version, 2);
	assert.equal(next.priorCarryProof?.priorSettledCny, 42.25);
	const historicalOrigin = authenticatedHistoricalCarryOrigin(next.priorCarryProof,
		next.priorPrivateBundle);
	assert.equal(historicalOrigin?.source.runId, "7002");
	assert.equal(historicalOrigin?.historicalCommittedNano, 6_125_000_000);
	assert.equal(historicalOrigin?.historicalUnknownHeldNano, 750_000_000);
	assert.equal(authenticatedHistoricalCarryOrigin({ ...next.priorCarryProof },
		next.priorPrivateBundle), undefined);
	assert.equal(authenticatedHistoricalCarryOrigin(next.priorCarryProof,
		{ "candidate.cpp": "changed" }), undefined);
	assert.deepEqual(authenticatedAccountingObservation(next.priorCarryProof,
		next.priorPrivateBundle), {
		historicalCommittedNano: 6_125_000_000,
		historicalUnknownHeldNano: 750_000_000,
		settledNano: 42_250_000_000, unknownObservedNano: 1_500_000_000,
		unpricedRequestCount: 1, opaqueUnquantifiedRunCount: 0 });
	assert.equal(authenticatedAccountingObservation({ ...next.priorCarryProof },
		next.priorPrivateBundle), undefined);
	assert.equal(authenticatedAccountingObservation(next.priorCarryProof,
		{ "candidate.cpp": "changed" }), undefined);
	const zeroAudit = { version: 3 as const, kind: "accounting-only-request-audit" as const,
		requests: [], settledCny: 0, unknownObservedCny: 0, unpricedRequestCount: 0 };
	const sealedAgain = next.sealCurrent({ settledCny: 0, unknownObservedCny: 0,
		unpricedRequestCount: 0, requestAudit: zeroAudit });
	const finishedThird = { ...third, status: "completed", conclusion: "failure" };
	const fourth = run(7006, 5, "in_progress", sha("f"));
	const newestRequest: typeof fetch = async (url, init) => {
		const address = String(url);
		if (address.includes("/workflows/manual-private-campaign.yml/runs?"))
			return new Response(JSON.stringify({ total_count: 5,
				workflow_runs: [fourth, finishedThird, completedSecond, completedFirst, anchor] }));
		if (address.includes("/runs/7005/jobs?"))
			return new Response(JSON.stringify({ total_count: 1, jobs: [{ id: 6005,
				run_id: 7005, run_attempt: 1, head_sha: sha("e"), name: "private-campaign",
				status: "completed", conclusion: "failure", steps: [{ name: "Run private campaign",
					status: "completed", conclusion: "failure" }] }] }));
		if (address.includes("/runs/7005/artifacts?"))
			return new Response(JSON.stringify({ total_count: 2, artifacts: [
				{ id: 9005, name: CARRY_ARTIFACT_NAME, expired: false,
					workflow_run: { id: 7005, head_sha: sha("e") } },
				{ id: 9105, name: MISSION_ARTIFACT, expired: false,
					digest: `sha256:${"8".repeat(64)}`,
					workflow_run: { id: 7005, head_sha: sha("e") } }] }));
		return request(url, init);
	};
	const reopened = await openLedgerContinuation({ ...f, githubToken: "synthetic-token",
		current: current(7006, sha("f")), request: newestRequest,
		loadCarryArtifact: async () => sealedAgain });
	assert.deepEqual(authenticatedAccountingObservation(reopened.priorCarryProof,
		reopened.priorPrivateBundle), authenticatedAccountingObservation(next.priorCarryProof,
		next.priorPrivateBundle));
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
		loadCarryArtifact: async () => sealed });
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
		loadCarryArtifact: async () => "unused" }), /cancelled workflow run is not an exact missing-carry opaque gap/);
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

function carryZip(entries: Array<[string, Buffer]>): Buffer {
	const locals: Buffer[] = [], centrals: Buffer[] = [];
	let offset = 0;
	for (const [label, content] of entries) {
		const name = Buffer.from(label);
		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt32LE(content.length, 18); local.writeUInt32LE(content.length, 22);
		local.writeUInt16LE(name.length, 26);
		locals.push(local, name, content);
		const central = Buffer.alloc(46);
		central.writeUInt32LE(0x02014b50, 0);
		central.writeUInt32LE(content.length, 20); central.writeUInt32LE(content.length, 24);
		central.writeUInt16LE(name.length, 28); central.writeUInt32LE(offset, 42);
		centrals.push(central, name);
		offset += local.length + name.length + content.length;
	}
	const directory = Buffer.concat(centrals);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
	end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
	return Buffer.concat([...locals, directory, end]);
}

test("carry ZIP accepts encrypted segments and rejects extra or duplicate members", async () => {
	const root = Buffer.from(JSON.stringify({ envelopeB64: "v4-root" }));
	const part = ["ledger-continuation.part-00000000.enc", Buffer.from("c2lkZWNhcg==")] as const;
	const archive = carryZip([[CARRY_FILE_NAME, root], [...part]]);
	const request: typeof fetch = async () => new Response(archive);
	assert.deepEqual(await downloadCarryArtifact({ githubToken: "synthetic-token", artifactId: "9002", request }),
		{ envelopeB64: "v4-root", sidecars: { [part[0]]: part[1].toString("utf8") } });
	for (const invalid of [carryZip([[CARRY_FILE_NAME, root], [...part], [...part]]),
		carryZip([[CARRY_FILE_NAME, root], ["extra.txt", Buffer.from("x")]])])
		await assert.rejects(downloadCarryArtifact({ githubToken: "synthetic-token", artifactId: "9002",
			request: async () => new Response(invalid) }), /carry archive entry is invalid/);
});

test("carry ZIP distinguishes prefix-only from a sealed carry and checks archive bytes", async () => {
	const prefix = Buffer.from(JSON.stringify({ status: "incomplete", incrementalControlEnvelope: {} }));
	const root = Buffer.from(JSON.stringify({ envelopeB64: "sealed-root" }));
	const prefixOnly = carryZip([[INCREMENTAL_CHECKPOINT_FILE, prefix]]);
	const archived = async (zip: Buffer, expectedArchiveSha256?: string) =>
		downloadCarryArtifact({ githubToken: "synthetic-token", artifactId: "9002",
			expectedArchiveSha256, request: async () => new Response(zip) });
	assert.deepEqual(await archived(prefixOnly, createHash("sha256").update(prefixOnly).digest("hex")),
		{ incrementalControlPrefix: prefix.toString("utf8") });
	assert.deepEqual(await archived(carryZip([[CARRY_FILE_NAME, root],
		[INCREMENTAL_CHECKPOINT_FILE, prefix]])),
		{ envelopeB64: "sealed-root", sidecars: {}, incrementalControlPrefix: prefix.toString("utf8") });
	await assert.rejects(archived(prefixOnly, "0".repeat(64)), /archive digest differs/);
	await assert.rejects(archived(carryZip([[INCREMENTAL_CHECKPOINT_FILE, prefix],
		["ledger-continuation.part-00000000.enc", Buffer.from("x")]])), /root file is missing/);
	await assert.rejects(archived(carryZip([[INCREMENTAL_CHECKPOINT_FILE, prefix],
		[INCREMENTAL_CHECKPOINT_FILE, prefix]])), /archive entry is invalid/);
});

test("carry download uses per-chunk idle timing while a slow body progresses", async () => {
	const archive = carryZip([[CARRY_FILE_NAME,
		Buffer.from(JSON.stringify({ envelopeB64: "slow-valid-root" }))]]);
	let start = 0;
	const request: typeof fetch = async () => new Response(new ReadableStream<Uint8Array>({
		async pull(controller) {
			await new Promise(resolve => setTimeout(resolve, 4));
			const end = Math.min(start + 8, archive.length);
			controller.enqueue(archive.subarray(start, end)); start = end;
			if (start === archive.length) controller.close();
		},
	}));
	assert.equal(await downloadCarryArtifact({ githubToken: "synthetic-token", artifactId: "9002",
		request, idleTimeoutMs: 20 }), "slow-valid-root");
	let cancelled = false;
	const stalled: typeof fetch = async () => new Response(new ReadableStream<Uint8Array>({
		start() {},
		cancel() { cancelled = true; },
	}));
	await assert.rejects(downloadCarryArtifact({ githubToken: "synthetic-token", artifactId: "9002",
		request: stalled, idleTimeoutMs: 5 }), /body stalled/);
	assert.equal(cancelled, true);
});

test("normal and emergency carries discard only an optional diagnostic at the exact v4 capacity", async t => {
	const f = await fixture(t);
	const zeroAudit = { version: 3 as const, kind: "accounting-only-request-audit" as const,
		requests: [], settledCny: 0, unknownObservedCny: 0, unpricedRequestCount: 0 };
	const firstOpened = await openLedgerContinuation({ ...f, githubToken: "synthetic-token",
		current: current(7002, sha("b")), request: github([anchor, first]),
		loadCarryArtifact: async () => "unused" });
	const historicalText = "h".repeat(CARRY_LOGICAL_BYTES - 250_000);
	const firstCarry = firstOpened.sealCurrent({ settledCny: 0, unknownObservedCny: 0,
		unpricedRequestCount: 0, requestAudit: zeroAudit,
		bootstrapBinding: { contractId: "synthetic-near-capacity", sourceSha256: "d".repeat(64) },
		privateBundle: { "research-history.json": historicalText } });
	const firstDone = { ...first, status: "completed", conclusion: "failure" };
	const openSecond = () => openLedgerContinuation({ ...f, githubToken: "synthetic-token",
		current: current(7003, sha("c")), request: github([anchor, firstDone, second]),
		loadCarryArtifact: async () => firstCarry });
	const requests = Array.from({ length: 700 }, (_, index) => ({
		requestId: `q${String(index).padStart(4, "0")}${"x".repeat(118)}`,
		inputPayloadBytes: 1, responseReceived: false, status: "unknown" as const,
		settledCny: null, unknownObservedCny: null, reportedUsage: null }));
	const audit = { ...zeroAudit, requests, unpricedRequestCount: requests.length };
	const diagnostic = (parentDigest: string) => JSON.stringify({ version: 1,
		kind: "host-transport-diagnostic-census", entries: [{
		source: { runId: "7003", runAttempt: 1, commit: sha("c") },
		priorEnvelopeSha256: parentDigest,
		rows: requests.map(row => ({ requestId: row.requestId, availability: "unavailable" })) }] });
	const normalOpened = await openSecond();
	const bundle = { ...normalOpened.priorPrivateBundle!,
		"transport-diagnostics.json": diagnostic(normalOpened.priorCarryProof!.envelopeSha256) };
	assert.ok(Buffer.byteLength(JSON.stringify(bundle), "utf8") < CARRY_LOGICAL_BYTES);
	assert.equal(normalOpened.appendTransportDiagnosticCensus(audit, []),
		bundle["transport-diagnostics.json"]);
	const normal = normalOpened.sealCurrent({ settledCny: 0, unknownObservedCny: 0,
		unpricedRequestCount: requests.length, requestAudit: audit, privateBundle: bundle });
	const seed = await authenticateSignedMissionSeed({ ...f, envelopeB64: f.seedEnvelopeB64 });
	const source = { runId: "7003", runAttempt: 1, runNumber: 3, commit: sha("c") };
	const normalCheckpoint = decodeV4Checkpoint(normal, seed.seedDigest,
		seed.derivePrivateKey("mul-pis-ledger-continuation-v1"), source);
	assert.equal(normalCheckpoint.privateBundle["research-history.json"], historicalText);
	assert.equal(normalCheckpoint.privateBundle["transport-diagnostics.json"], undefined);
	assert.equal(normalCheckpoint.unpricedRequestCount, requests.length);
	const emergencyOpened = await openSecond();
	const emergency = emergencyOpened.sealEmergencyCurrent({ settledCny: 0, unknownObservedCny: 0,
		unpricedRequestCount: requests.length, requestAudit: audit, privateBundle: bundle },
		"effect-review-incomplete");
	const emergencyCheckpoint = decodeV4Checkpoint(emergency, seed.seedDigest,
		seed.derivePrivateKey("mul-pis-ledger-continuation-v1"), source);
	assert.equal(emergencyCheckpoint.privateBundle["research-history.json"], historicalText);
	assert.equal(emergencyCheckpoint.privateBundle["transport-diagnostics.json"], undefined);
	assert.equal(emergencyCheckpoint.unpricedRequestCount, requests.length);
	const interrupted = await openSecond();
	assert.equal(interrupted.appendTransportDiagnosticCensus(audit, []),
		bundle["transport-diagnostics.json"]);
	const actualNormalSeal = interrupted.sealCurrent;
	let sealAttempts = 0;
	interrupted.sealCurrent = input => {
		sealAttempts++;
		if (sealAttempts === 2) throw Error("synthetic selected-effect invariant on smaller retry");
		return actualNormalSeal(input);
	};
	const recovered = sealCampaignCarry(interrupted, { settledCny: 0, unknownObservedCny: 0,
		unpricedRequestCount: requests.length, requestAudit: audit, privateBundle: bundle });
	assert.equal(sealAttempts, 2);
	assert.equal(recovered.mode, "emergency-effects-unreviewed");
	if (recovered.mode === "emergency-effects-unreviewed")
		assert.match(String(recovered.normalFailure), /synthetic selected-effect invariant/);
	const recoveredCheckpoint = decodeV4Checkpoint(recovered.carry, seed.seedDigest,
		seed.derivePrivateKey("mul-pis-ledger-continuation-v1"), source);
	assert.equal(recoveredCheckpoint.privateBundle["research-history.json"], historicalText);
	assert.equal(recoveredCheckpoint.privateBundle["transport-diagnostics.json"], undefined);
	assert.equal(recoveredCheckpoint.unpricedRequestCount, requests.length);
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
	const request = github([anchor, { ...first, event: "push", head_commit: { message: HISTORICAL_PUSH_MESSAGE },
		status: "completed", conclusion: "success" }, { ...second, event: "push", head_commit: { message: HISTORICAL_PUSH_MESSAGE } }]);
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
			head_commit: { message: HISTORICAL_PUSH_MESSAGE },
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
				{ ...requested, head_commit: { message: HISTORICAL_PUSH_MESSAGE } }, anchor] }));
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
		if (target.endsWith(`/git/commits/${before}`))
			return new Response(JSON.stringify({ sha: before, message: REUSABLE_RUN_REQUEST_MESSAGE,
				parents: [{ sha: source }], tree: { sha: tree } }));
		if (target.endsWith(`/git/commits/${source}`))
			return new Response(JSON.stringify({ sha: source, parents: [], tree: { sha: tree } }));
		if (target.includes("/actions/workflows/workflow-regression.yml/runs?"))
			return new Response(JSON.stringify({ workflow_runs: [{ head_sha: source,
				head_branch: "improve/workflow-learning-reliability", event: "push",
				run_attempt: 1, status: "completed", conclusion: "success" }] }));
		return base(url, init);
	};
	const opened = await openLedgerContinuation({ ...f, githubToken: "synthetic-token", request,
		current: { ...current(7003, sha("c")), event: "push", before,
			ref: "refs/heads/run-requests/workflow-learning-reliability" },
		loadCarryArtifact: async () => { throw Error("skipped prior control job has no carry"); } });
	assert.equal(opened.mode, "accounting-only");
});

test("linked accepted control with no observed Action stays UNKNOWN across ordinary and emergency carries", async t => {
	const f = await fixture(t), seedEnvelopeB64 = attestedSeed(f);
	const priorOpen = await openLedgerContinuation({ ...f, seedEnvelopeB64,
		githubToken: "synthetic-token", current: current(7002, sha("b")),
		request: github([anchor, first]), loadCarryArtifact: async () => "unused" });
	const emptyAudit = { version: 3 as const, kind: "accounting-only-request-audit" as const,
		requests: [], settledCny: 0, unknownObservedCny: 0, unpricedRequestCount: 0 };
	const priorCarry = priorOpen.sealCurrent({ settledCny: 0, unknownObservedCny: 0,
		unpricedRequestCount: 0, requestAudit: emptyAudit });
	const priorDone = { ...first, status: "completed", conclusion: "success" };
	const linked = { ...second, event: "push", head_branch: "run-requests/workflow-learning-reliability",
		head_commit: { message: REUSABLE_RUN_REQUEST_MESSAGE } };
	const oldControl = sha("d"), oldSource = sha("f"), oldFirst = sha("6"),
		oldFirstSource = sha("7"), oldFirstTree = sha("8"), newSource = sha("e");
	const oldTree = sha("1"), newTree = sha("2");
	const linkedCurrent = { ...current(7003, sha("c")), event: "push", before: oldControl,
		ref: "refs/heads/run-requests/workflow-learning-reliability" };
	const requests = (runs: object[], options: { oldRuns?: number; late?: "preprovider" | "provider-started";
		twoUnknowns?: boolean; lateFirst?: boolean; bothLate?: boolean; badOldTree?: boolean;
		badOldCommitSha?: boolean; badOldSourceSha?: boolean;
		badOldCi?: boolean; badOldBranch?: boolean } = {}): typeof fetch => {
		const base = github(runs);
		return async (url, init) => {
			const address = String(url);
			if (address.endsWith("/git/ref/heads/improve/workflow-learning-reliability"))
				return new Response(JSON.stringify({ object: { sha: newSource } }));
			if (address.endsWith(`/git/commits/${sha("c")}`))
				return new Response(JSON.stringify({ parents: [{ sha: newSource }, { sha: oldControl }],
					tree: { sha: newTree } }));
			if (address.endsWith(`/git/commits/${newSource}`))
				return new Response(JSON.stringify({ tree: { sha: newTree } }));
			if (address.endsWith(`/git/commits/${oldControl}`))
				return new Response(JSON.stringify({ sha: options.badOldCommitSha ? sha("9") : oldControl,
					message: REUSABLE_RUN_REQUEST_MESSAGE,
					parents: [{ sha: oldSource }, ...(options.twoUnknowns ? [{ sha: oldFirst }] : [])],
					tree: { sha: options.badOldTree ? sha("3") : oldTree } }));
			if (address.endsWith(`/git/commits/${oldSource}`))
				return new Response(JSON.stringify({ sha: options.badOldSourceSha ? sha("9") : oldSource,
					tree: { sha: oldTree } }));
			if (address.endsWith(`/git/commits/${oldFirst}`))
				return new Response(JSON.stringify({ sha: oldFirst, message: REUSABLE_RUN_REQUEST_MESSAGE,
					parents: [{ sha: oldFirstSource }], tree: { sha: oldFirstTree } }));
			if (address.endsWith(`/git/commits/${oldFirstSource}`))
				return new Response(JSON.stringify({ sha: oldFirstSource, tree: { sha: oldFirstTree } }));
			if (address.includes(`/workflows/manual-private-campaign.yml/runs?head_sha=${oldControl}`))
				return new Response(JSON.stringify({ total_count: options.bothLate ? 1 : options.oldRuns ?? 0,
					workflow_runs: options.bothLate ? [secondLateRun] : options.oldRuns ?
						options.late ? [lateRun] : [{ head_sha: oldControl }] : [] }));
			if (address.includes(`/workflows/manual-private-campaign.yml/runs?head_sha=${oldFirst}`))
				return new Response(JSON.stringify({ total_count: options.lateFirst || options.bothLate ? 1 : 0,
					workflow_runs: options.bothLate ? [firstLateRun] :
						options.lateFirst ? [{ head_sha: oldFirst }] : [] }));
			if (address.includes(`/workflows/workflow-regression.yml/runs?head_sha=${newSource}`))
				return new Response(JSON.stringify({ workflow_runs: [{ head_sha: newSource,
					head_branch: "improve/workflow-learning-reliability", event: "push",
					run_attempt: 1, status: "completed", conclusion: "success" }] }));
			if (address.includes(`/workflows/workflow-regression.yml/runs?head_sha=${oldSource}`))
				return new Response(JSON.stringify({ workflow_runs: options.badOldCi ? [] : [{
					head_sha: oldSource, head_branch: options.badOldBranch ? "main" :
						"improve/workflow-learning-reliability", event: "push", run_attempt: 1,
					status: "completed", conclusion: "success" }] }));
			if (address.includes(`/workflows/workflow-regression.yml/runs?head_sha=${oldFirstSource}`))
				return new Response(JSON.stringify({ workflow_runs: [{ head_sha: oldFirstSource,
					head_branch: "improve/workflow-learning-reliability", event: "push",
					run_attempt: 1, status: "completed", conclusion: "success" }] }));
			if (address.includes("/runs/7003/jobs?")) return new Response(JSON.stringify({ total_count: 1,
				jobs: [{ id: 6003, run_id: 7003, run_attempt: 1, head_sha: sha("c"),
					name: "private-campaign", status: "completed", conclusion: "success",
					steps: [{ name: "Run private campaign", status: "completed", conclusion: "success" }] }] }));
			if (address.includes("/runs/7003/artifacts?")) return new Response(JSON.stringify({ total_count: 1,
				artifacts: [{ id: 9003, name: CARRY_ARTIFACT_NAME, expired: false,
					workflow_run: { id: 7003, head_sha: sha("c") } }] }));
			if (address.includes("/runs/7004/jobs?")) return new Response(JSON.stringify({ total_count: 1,
				jobs: [{ id: 6004, run_id: 7004, run_attempt: 1,
					head_sha: options.bothLate ? oldFirst : oldControl,
					name: "private-campaign", status: "completed", conclusion: "failure", steps: [
						{ name: "Verify reusable control-branch request and accepted source CI",
							status: "completed", conclusion: "failure" },
						{ name: "Decode confidential input without logging it", status: "completed",
							conclusion: "skipped" },
						{ name: "Run private campaign", status: "completed", conclusion:
								options.late === "provider-started" ? "success" : "skipped" }] }] }));
			if (address.includes("/runs/7005/jobs?") && options.bothLate)
				return new Response(JSON.stringify({ total_count: 1,
					jobs: [{ id: 6005, run_id: 7005, run_attempt: 1, head_sha: oldControl,
						name: "private-campaign", status: "completed", conclusion: "failure", steps: [
							{ name: "Verify reusable control-branch request and accepted source CI",
								status: "completed", conclusion: "failure" },
							{ name: "Decode confidential input without logging it", status: "completed",
								conclusion: "skipped" },
							{ name: "Run private campaign", status: "completed", conclusion: "skipped" }] }] }));
			return base(url, init);
		};
	};
	const lateRun = { ...run(7004, 4, "completed", oldControl, "failure"),
		event: "push", head_branch: "run-requests/workflow-learning-reliability",
		head_commit: { message: REUSABLE_RUN_REQUEST_MESSAGE } };
	const firstLateRun = { ...lateRun, head_sha: oldFirst };
	const secondLateRun = { ...lateRun, id: 7005, run_number: 5 };
	const opening = () => openLedgerContinuation({ ...f, seedEnvelopeB64,
		githubToken: "synthetic-token", current: linkedCurrent,
		request: requests([anchor, priorDone, linked]),
		loadCarryArtifact: async () => priorCarry });
	const opened = await opening();
	assert.equal(opened.authenticatedUnobservedControlDeliveries(
		opened.unobservedControlDeliveries), true);
	assert.equal(opened.authenticatedUnobservedControlDeliveries(
		JSON.parse(JSON.stringify(opened.unobservedControlDeliveries))), false);
	assert.equal(Object.isFrozen(opened.unobservedControlDeliveries[0]), true);
	assert.equal(Object.isFrozen(opened.unobservedControlDeliveries[0].admittedBy), true);
	assert.deepEqual(opened.unobservedControlDeliveries.map(row => ({
		commit: row.controlCommit, source: row.testedSourceCommit, runs: row.observedRunsAtAdmission,
		effects: row.effects, accounting: row.accounting })), [{ commit: oldControl,
		source: oldSource, runs: 0, effects: "unknown-unreconciled", accounting: "unquantified" }]);
	const ordinary = opened.sealCurrent({ settledCny: 0, unknownObservedCny: 0,
		unpricedRequestCount: 0, requestAudit: emptyAudit });
	const seed = await authenticateSignedMissionSeed({ ...f, envelopeB64: seedEnvelopeB64 });
	const key = seed.derivePrivateKey("mul-pis-ledger-continuation-v1");
	const linkedSource = { runId: "7003", runAttempt: 1, runNumber: 3, commit: sha("c") };
	const altered = decodeV4Checkpoint(ordinary, seed.seedDigest, key, linkedSource);
	altered.unobservedControlDeliveries[0].effects = "no-effects";
	const forged = resealV4Checkpoint(altered, seed.seedDigest, key, linkedSource);
	const emergency = (await opening()).sealEmergencyCurrent({ settledCny: 0,
		unknownObservedCny: 0, unpricedRequestCount: 0, requestAudit: emptyAudit },
		"effect-review-incomplete");
	for (const carry of [ordinary, emergency]) {
		const next = run(7005, 4, "in_progress", sha("5"));
		const reopened = await openLedgerContinuation({ ...f, seedEnvelopeB64,
			githubToken: "synthetic-token", current: current(7005, sha("5")),
			request: requests([anchor, priorDone, { ...linked, status: "completed", conclusion: "success" }, next]),
			loadCarryArtifact: async ({ runId }) => runId === "7003" ? carry : priorCarry });
		assert.equal(reopened.unobservedControlDeliveries.length, 1);
		assert.deepEqual(authenticatedUnknownControlDeliveries(reopened.priorCarryProof,
			reopened.priorPrivateBundle), reopened.unobservedControlDeliveries);
		await assert.rejects(openLedgerContinuation({ ...f, seedEnvelopeB64,
			githubToken: "synthetic-token", current: current(7005, sha("5")),
			request: requests([anchor, priorDone, { ...linked, status: "completed", conclusion: "success" }, next],
				{ oldRuns: 1 }), loadCarryArtifact: async ({ runId }) => runId === "7003" ? carry : priorCarry }),
			/late prior control Action requires explicit UNKNOWN-effect reconciliation/);
	}
	const lateHistory = [anchor, priorDone, { ...linked, status: "completed", conclusion: "success" },
		lateRun, run(7005, 5, "in_progress", sha("5"))];
	const preprovider = await openLedgerContinuation({ ...f, seedEnvelopeB64,
		githubToken: "synthetic-token", current: current(7005, sha("5")),
		request: requests(lateHistory, { oldRuns: 1, late: "preprovider" }),
		loadCarryArtifact: async ({ runId }) => runId === "7003" ? ordinary : priorCarry });
	assert.equal(preprovider.unobservedControlDeliveries[0].effects, "unknown-unreconciled");
	assert.equal(preprovider.lateControlPreproviderDispositions[0].providerStep, "skipped");
	const reconciledCarry = preprovider.sealCurrent({ settledCny: 0, unknownObservedCny: 0,
		unpricedRequestCount: 0, requestAudit: emptyAudit });
	const reconciledPlaintext = decodeV4Checkpoint(reconciledCarry, seed.seedDigest, key,
		{ runId: "7005", runAttempt: 1, runNumber: 5, commit: sha("5") });
	assert.equal(reconciledPlaintext.lateControlPreproviderDispositions[0].effects,
		"unknown-unreconciled");
	await assert.rejects(openLedgerContinuation({ ...f, seedEnvelopeB64,
		githubToken: "synthetic-token", current: current(7005, sha("5")),
		request: requests(lateHistory, { oldRuns: 1, late: "provider-started" }),
		loadCarryArtifact: async ({ runId }) => runId === "7003" ? ordinary : priorCarry }),
		/UNKNOWN-effect reconciliation/);
	for (const emergencyMode of [false, true]) {
		const chainOpen = await openLedgerContinuation({ ...f, seedEnvelopeB64,
			githubToken: "synthetic-token", current: linkedCurrent,
			request: requests([anchor, priorDone, linked], { twoUnknowns: true }),
			loadCarryArtifact: async () => priorCarry });
		assert.deepEqual(chainOpen.unobservedControlDeliveries.map(row => row.controlCommit),
			[oldFirst, oldControl]);
		const chainCarry = emergencyMode ? chainOpen.sealEmergencyCurrent({ settledCny: 0,
			unknownObservedCny: 0, unpricedRequestCount: 0, requestAudit: emptyAudit },
			"effect-review-incomplete") : chainOpen.sealCurrent({ settledCny: 0,
				unknownObservedCny: 0, unpricedRequestCount: 0, requestAudit: emptyAudit });
		const successor = [anchor, priorDone,
			{ ...linked, status: "completed", conclusion: "success" },
			run(7005, 4, "in_progress", sha("5"))];
		const recovered = await openLedgerContinuation({ ...f, seedEnvelopeB64,
			githubToken: "synthetic-token", current: current(7005, sha("5")),
			request: requests(successor, { twoUnknowns: true }),
			loadCarryArtifact: async ({ runId }) => runId === "7003" ? chainCarry : priorCarry });
		assert.deepEqual(recovered.unobservedControlDeliveries.map(row => row.controlCommit),
			[oldFirst, oldControl]);
		for (const late of [{ twoUnknowns: true, lateFirst: true },
			{ twoUnknowns: true, oldRuns: 1 }])
			await assert.rejects(openLedgerContinuation({ ...f, seedEnvelopeB64,
				githubToken: "synthetic-token", current: current(7005, sha("5")),
				request: requests(successor, late),
				loadCarryArtifact: async ({ runId }) => runId === "7003" ? chainCarry : priorCarry }),
				/UNKNOWN-effect reconciliation/);
		const twoLate = await openLedgerContinuation({ ...f, seedEnvelopeB64,
			githubToken: "synthetic-token", current: current(7006, sha("5")),
			request: requests([anchor, priorDone,
				{ ...linked, status: "completed", conclusion: "success" },
				firstLateRun, secondLateRun, run(7006, 6, "in_progress", sha("5"))],
				{ twoUnknowns: true, bothLate: true }),
			loadCarryArtifact: async ({ runId }) => runId === "7003" ? chainCarry : priorCarry });
		assert.deepEqual(twoLate.lateControlPreproviderDispositions.map(row => row.controlCommit),
			[oldFirst, oldControl]);
		const twoLateCarry = twoLate.sealCurrent({ settledCny: 0, unknownObservedCny: 0,
			unpricedRequestCount: 0, requestAudit: emptyAudit });
		const twoLatePlaintext = decodeV4Checkpoint(twoLateCarry, seed.seedDigest, key,
			{ runId: "7006", runAttempt: 1, runNumber: 6, commit: sha("5") });
		assert.equal(twoLatePlaintext.lateControlPreproviderDispositions.length, 2);
	}
	await assert.rejects(openLedgerContinuation({ ...f, seedEnvelopeB64,
		githubToken: "synthetic-token", current: current(7005, sha("5")),
		request: requests([anchor, priorDone, { ...linked, status: "completed", conclusion: "success" },
			run(7005, 4, "in_progress", sha("5"))]),
		loadCarryArtifact: async ({ runId }) => runId === "7003" ? forged : priorCarry }),
		/unobserved control delivery/);
	for (const option of [{ badOldTree: true }, { badOldCi: true }, { badOldBranch: true },
		{ badOldCommitSha: true }, { badOldSourceSha: true }])
		await assert.rejects(openLedgerContinuation({ ...f, seedEnvelopeB64,
			githubToken: "synthetic-token", current: linkedCurrent,
			request: requests([anchor, priorDone, linked], option),
			loadCarryArtifact: async () => priorCarry }), /unobserved prior control/);
	const wrongRow = { ...run(7004, 4, "queued", oldControl), event: "workflow_dispatch" };
	await assert.rejects(openLedgerContinuation({ ...f, seedEnvelopeB64,
		githubToken: "synthetic-token", current: linkedCurrent,
		request: requests([anchor, priorDone, linked, wrongRow], { oldRuns: 1 }),
		loadCarryArtifact: async () => priorCarry }),
		/prior control Action lies outside authenticated workflow history/);
	await assert.rejects(openLedgerContinuation({ ...f, seedEnvelopeB64,
		githubToken: "synthetic-token", current: { ...linkedCurrent, before: sha("4") },
		request: requests([anchor, priorDone, linked]),
		loadCarryArtifact: async () => priorCarry }), /not a fast-forward empty commit/);
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
	const reopen = async (carryPayload: CarryArtifactPayload, legacyEnvelope = f.secondCarry.envelopeB64) =>
		openLedgerContinuation({ ...f, githubToken: "synthetic-token", request,
			current: current(7006, sha("f")), loadCarryArtifact: async ({ artifactId }) =>
				artifactId === "9005" ? carryPayload : legacyEnvelope });
	const passThrough = await reopen(wrapped);
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
	const changedNext = await reopen(changedCarry);
	assert.equal(authenticatedCarryForwardOrigin(changedNext.priorCarryProof,
		changedNext.priorPrivateBundle), undefined);
	const requestBearing = await openLedgerContinuation({ ...f, githubToken: "synthetic-token",
		current: current(7005, sha("e")), loadCarryArtifact: async () => f.secondCarry.envelopeB64 });
	const observedRequest = requestBearing.sealCurrent({ settledCny: 0, unknownObservedCny: 0,
		unpricedRequestCount: 1, requestAudit: { ...emptyAudit, unpricedRequestCount: 1,
			requests: [{ requestId: "synthetic-request", inputPayloadBytes: 1, status: "in-flight" as const,
				settledCny: null, unknownObservedCny: null, reportedUsage: null }] } });
	const requestNext = await reopen(observedRequest);
	assert.equal(authenticatedCarryForwardOrigin(requestNext.priorCarryProof,
		requestNext.priorPrivateBundle), undefined);
	const seed = await authenticateSignedMissionSeed({ ...f, envelopeB64: f.seedEnvelopeB64 });
	const key = seed.derivePrivateKey("mul-pis-ledger-continuation-v1");
	const outer = JSON.parse(Buffer.from(wrapped.envelopeB64, "base64").toString());
	const source = { runId: "7005", runAttempt: 1, runNumber: 4, commit: sha("e") };
	const tampered = decodeV4Checkpoint(wrapped, seed.seedDigest, key, source);
	tampered.historical.committedNano++;
	const changedHistory = resealV4Checkpoint(tampered, seed.seedDigest, key, source);
	await assert.rejects(reopen(changedHistory), /historical commitment transition is invalid/);
	const wrongLegacy = await reopen(wrapped, f.firstCarry.envelopeB64);
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
			assert.equal(artifactId, "9006"); return pinned;
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
		loadCarryArtifact: async ({ artifactId }) => artifactId === "9003" ? zero : legacy.envelopeB64 });
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
		"objective-checkpoint.json": JSON.stringify({ ...oldCheckpoint, boundedRuns: [...oldCheckpoint.boundedRuns,
			{ runId: "new-goal", outcome: "partial", unresolvedOperationIds: [] }] }),
		"host-effect-receipt.json": JSON.stringify(receipt) };
	const sealed = workOpened.sealCurrent({ settledCny: 0.5, unknownObservedCny: 0,
		unpricedRequestCount: 0, requestAudit, privateBundle: nextBundle });
	const resumed = await openLedgerContinuation({ ...f, seedEnvelopeB64,
		githubToken: "synthetic-token", current: current(7006, sha("f")),
		request: requestFor([anchor, firstDone, secondDone,
			{ ...work, status: "completed", conclusion: "failure" }, next]),
		loadCarryArtifact: async () => sealed });
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
		loadCarryArtifact: async ({ artifactId }) => artifactId === "9003" ? zero : legacy.envelopeB64 });
	const resumeCarry = (carryPayload: CarryArtifactPayload) => openLedgerContinuation({ ...f, seedEnvelopeB64,
		githubToken: "synthetic-token", current: current(7006, sha("f")),
		request: requestFor([anchor, firstDone, secondDone,
			{ ...work, status: "completed", conclusion: "failure" }, next]),
		loadCarryArtifact: async () => carryPayload });
	{
		const priorProof = resumed.priorCarryProof!;
		const entry = { source: priorProof.source, envelopeSha256: priorProof.envelopeSha256,
			contractId: "old-contract", goalRunId: "new-goal", taskId: "T001", m04RunId: "M04-synthetic",
			state: "unknown-unreconciled", route: "fresh-work-only", proposalSubmitted: true,
			selectedTupleSha256: "a".repeat(64), inheritedOperationRefs: ["old-goal/O001"] };
		const quarantineText = JSON.stringify({ version: 1,
			kind: "unresolved-historical-m04-quarantine", entries: [entry] });
		const withQuarantine = { ...resumed.priorPrivateBundle,
			"m04-transaction-quarantine.json": quarantineText };
		const emergencyOpen = await resumeCarry(sealed);
		const emergency = emergencyOpen.sealEmergencyCurrent({ settledCny: 0,
			unknownObservedCny: 0, unpricedRequestCount: 0,
			requestAudit: emptyAudit, privateBundle: withQuarantine }, "effect-review-incomplete");
		const seed = await authenticateSignedMissionSeed({ ...f, envelopeB64: seedEnvelopeB64 });
		const emergencyCheckpoint = decodeV4Checkpoint(emergency, seed.seedDigest,
			seed.derivePrivateKey("mul-pis-ledger-continuation-v1"),
			{ runId: "7006", runAttempt: 1, runNumber: 5, commit: sha("f") });
		assert.equal(emergencyCheckpoint.privateBundle["m04-transaction-quarantine.json"], quarantineText);
		assert.equal(emergencyCheckpoint.currentEffectReview, "pending");
		const normalOpen = await resumeCarry(sealed);
		const normal = normalOpen.sealCurrent({ settledCny: 0, unknownObservedCny: 0,
			unpricedRequestCount: 0, requestAudit: emptyAudit, privateBundle: withQuarantine });
		const later = run(7007, 6, "in_progress", sha("1"));
		const reopen = () => openLedgerContinuation({ ...f, seedEnvelopeB64,
			githubToken: "synthetic-token", current: current(7007, sha("1")),
			request: requestFor([anchor, firstDone, secondDone,
				{ ...work, status: "completed", conclusion: "failure" },
				{ ...next, status: "completed", conclusion: "failure" }, later]),
			loadCarryArtifact: async () => normal });
		const inherited = await reopen();
		assert.equal(inherited.priorPrivateBundle?.["m04-transaction-quarantine.json"], quarantineText);
		const { "m04-transaction-quarantine.json": _removed, ...without } = inherited.priorPrivateBundle!;
		assert.throws(() => inherited.sealCurrent({ settledCny: 0,
			unknownObservedCny: 0, unpricedRequestCount: 0, requestAudit: emptyAudit,
			privateBundle: without }), /M04 quarantine/);
		const rewritten = JSON.parse(quarantineText);
		rewritten.entries[0].taskId = "T999";
		assert.throws(() => inherited.sealCurrent({ settledCny: 0,
			unknownObservedCny: 0, unpricedRequestCount: 0, requestAudit: emptyAudit,
			privateBundle: { ...inherited.priorPrivateBundle,
				"m04-transaction-quarantine.json": JSON.stringify(rewritten) } }), /M04 quarantine/);
		assert.doesNotThrow(() => inherited.sealCurrent({ settledCny: 0,
			unknownObservedCny: 0, unpricedRequestCount: 0, requestAudit: emptyAudit,
			privateBundle: inherited.priorPrivateBundle }));
	}
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
		if (label === "changed old selected tuple") {
			assert.throws(() => opened.sealCurrent({ settledCny: badAudit.settledCny,
				unknownObservedCny: badAudit.unknownObservedCny,
				unpricedRequestCount: badAudit.unpricedRequestCount,
				requestAudit: badAudit, privateBundle: badBundle }),
				/new selected tuple lacks a completed authenticated transition/);
			continue;
		}
		const bad = opened.sealCurrent({ settledCny: badAudit.settledCny,
			unknownObservedCny: badAudit.unknownObservedCny,
			unpricedRequestCount: badAudit.unpricedRequestCount,
			requestAudit: badAudit, privateBundle: badBundle });
		const replay = await resumeCarry(bad);
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
	const unknownBillingResume = await resumeCarry(unknownBillingCarry);
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
	const observedUnknownResume = await resumeCarry(observedUnknownCarry);
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
	const transportResume = await resumeCarry(transportCarry);
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
		request: claimRequest, loadCarryArtifact: async () => transportCarry });
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
	const freshCampaignRoot = path.join(os.tmpdir(), "mulpis-private-campaign-synthetic-ledger");
	const freshWorkspaceRoot = path.join(freshCampaignRoot, "workspace");
	const reservation = await reserveIndependentRestart({ authenticatedCarryProof: priorProof,
		privateBundle: priorBundle, unobservedControlDeliveries: [],
		freshWorkspace: { workspaceId: path.basename(freshCampaignRoot),
			restartNonce: "independent-nonce" },
		freshBoundary: { campaignRoot: freshCampaignRoot, workspaceRoot: freshWorkspaceRoot,
			storeRoot: path.join(freshWorkspaceRoot, ".agent", "knowledge"),
			storeEmpty: true, sessionCensusEmpty: true,
			sessionMode: "no-prior-session-resume", grantProfile: "private-confined-read-dir",
			externalWriteTools: false, sharedStore: false, selectedRevalidated: true },
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
				unobservedControlLineage: { priorSource: { ...facts.source },
					admissionSource: { ...facts.currentRun }, count: 0, sha256: digest([]) },
				operationAttestations: refs.map(operationRef => ({ operationRef,
					sourceCommit: reviewed.source.commit, evidenceSha256: digest(operationRef) })),
				effectClass: "historical-unknown-fresh-only", unknownBillingHeld: true,
				actorThirdPartyMutations: "unknown", hostTransport: "immutable-versioned-archive",
				accountingObservation: authenticatedAccountingObservation(priorProof, priorBundle)! };
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
		loadCarryArtifact: async () => afterUnknown });
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
		const replay = await resumeCarry(carry);
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
	const alteredResume = await resumeCarry(alteredCarry);
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
		"objective-checkpoint.json": JSON.stringify({ ...oldCheckpoint, boundedRuns: [...oldCheckpoint.boundedRuns,
			{ runId: "new-goal", outcome: "partial", selectedTaskId: "T001", unresolvedOperationIds: [] }],
			selectedArtifacts: ["candidate.cpp", "verification.json", "workflow-archive.json"] }),
		"research-history.json": JSON.stringify({ version: 1,
			kind: "untrusted-version-bound-research-history", entries: [{ goalRunId: "old-goal",
				taskId: "T999", files: { "candidate.cpp": oldBundle["candidate.cpp"],
					"verification.json": oldBundle["verification.json"],
					"workflow-archive.json": oldBundle["workflow-archive.json"] } }] }),
		"host-effect-receipt.json": JSON.stringify(acceptedReceipt) };
	const acceptedOpen = await reopenWork();
	assert.throws(() => acceptedOpen.sealCurrent({ settledCny: 0.5,
		unknownObservedCny: 0, unpricedRequestCount: 0,
		requestAudit, privateBundle: acceptedBundle }),
		/new selected tuple lacks a completed authenticated transition/,
		"M07 acceptance without completed portable M04 cannot change the selected tuple");
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
		"objective-checkpoint.json": JSON.stringify({ ...oldCheckpoint, boundedRuns: [...oldCheckpoint.boundedRuns,
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
		loadCarryArtifact: async () => secondNonzero });
	const cumulative = authenticatedHostEffectEvidence(later.priorCarryProof, later.priorPrivateBundle);
	assert(cumulative, "a reviewed first nonzero run permits a separately receipted second one");
	assert.equal(cumulative.reviewedEffectAncestry.length, 1);
	assert.equal(cumulative.reviewedEffectAncestry[0].envelopeSha256, reviewedPrior.envelopeSha256);
	const unreviewedSuccessor = await resumeCarry(sealed);
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
		loadCarryArtifact: async () => broken });
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
	const unsafeEmptyOpen = await resumeCarry(sealed);
	assert.throws(() => unsafeEmptyOpen.sealCurrent({ settledCny: 0, unknownObservedCny: 0,
		unpricedRequestCount: 0, requestAudit: emptyAudit,
		privateBundle: { ...abandonedBundle,
			"host-effect-receipt.json": JSON.stringify(unsafeEmptyReceipt) } }),
		/reviewed effect ancestry is not bound/);
	const emptySuccessor = await resumeCarry(sealed);
	const emptyCarry = emptySuccessor.sealCurrent({ settledCny: 0, unknownObservedCny: 0,
		unpricedRequestCount: 0, requestAudit: emptyAudit, privateBundle: abandonedBundle });
	const zeroCurrent = await openLedgerContinuation({ ...f, seedEnvelopeB64,
		githubToken: "synthetic-token", current: current(7007, sha("1")),
		request: requestFor([anchor, firstDone, secondDone,
			{ ...work, status: "completed", conclusion: "failure" },
			{ ...next, status: "completed", conclusion: "failure" },
			run(7007, 6, "in_progress", sha("1"))]),
		loadCarryArtifact: async () => emptyCarry });
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
		"objective-checkpoint.json": JSON.stringify({ ...oldCheckpoint, boundedRuns: [...oldCheckpoint.boundedRuns,
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
		loadCarryArtifact: async () => thirdCarry });
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
		loadCarryArtifact: async ({ artifactId }) => artifactId === "9003" ? zero : legacy.envelopeB64 });
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
		loadCarryArtifact: async () => sealedWork });
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
		pendingActionFacts: { unresolvedOperationRefs: ["old-goal/O001"] },
		stopReason: assessmentStop });
	assert.equal(assessmentCheckpoint.continuation.pendingAction?.kind, "reconcile-m07-operation");
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
		loadCarryArtifact: async () => carry });
	const effect = authenticatedHostEffectEvidence(reopened.priorCarryProof,
		reopened.priorPrivateBundle);
	assert(effect, "received read-only assessment with no M07 goal must retain review authority");
	assert.equal(effect.receipt.goals.length, 0);
	assert.equal(effect.requestAudit.requests.length, 12);
	assert.equal(effect.reviewedEffectAncestry.at(-1)?.abandonedWithoutGoal, true);
	const repairCheckpoint = objectiveProgress(contract, {
		boundedRuns: workCheckpoint.boundedRuns, selectedArtifacts,
		unresolvedOperationIds: ["old-goal/O001"], assessment,
		assessmentHistory: [{ iteration: 1, assessment, stopReason: "workflow-repair-needed",
			advanced: false }], stopReason: "workflow-repair-needed",
		pendingActionFacts: { unresolvedOperationRefs: ["old-goal/O001"],
			failedStage: "objective-assessment", evidenceRefs: ["repair-state.json"] } });
	assert.equal(repairCheckpoint.continuation.pendingAction?.kind, "reconcile-m07-operation");
	const repairBundle = { ...assessmentBundle,
		"objective-checkpoint.json": JSON.stringify(repairCheckpoint) };
	assert.equal(Object.hasOwn(repairBundle, "repair-state.json"), false,
		"the historical writer omitted this host repair receipt");
	const repairing = await openAssessment();
	const repairCarry = repairing.sealCurrent({ settledCny: 0.25, unknownObservedCny: 0,
		unpricedRequestCount: 0, requestAudit: assessmentAudit, privateBundle: repairBundle });
	const nextRunning = run(7007, 6, "in_progress", sha("1"));
	const liveNext: typeof fetch = async (url, init) => {
		const address = String(url);
		if (address.endsWith("/actions/runs/7007"))
			return new Response(JSON.stringify(nextRunning));
		if (address.endsWith("/actions/runs/7007/jobs?per_page=100"))
			return new Response(JSON.stringify({ total_count: 1, jobs: [{ id: 8007,
				run_id: 7007, run_attempt: 1, head_sha: sha("1"), name: "private-campaign",
				status: "in_progress", conclusion: null,
				steps: [{ name: "Run private campaign", status: "in_progress", conclusion: null }] }] }));
		return mock([anchor, firstDone, secondDone,
			{ ...work, status: "completed", conclusion: "failure" },
			{ ...next, status: "completed", conclusion: "failure" }, nextRunning])(url, init);
	};
	const freshFromMissingRepair = await openLedgerContinuation({ ...f, seedEnvelopeB64,
		githubToken: "synthetic-token", current: current(7007, sha("1")),
		request: liveNext, loadCarryArtifact: async () => repairCarry });
	assert.equal(freshFromMissingRepair.priorPrivateBundle?.["repair-state.json"], undefined);
	assert.equal(JSON.parse(freshFromMissingRepair.priorPrivateBundle!["objective-checkpoint.json"]!)
		.continuation.pendingAction.kind, "reconcile-m07-operation");
	assert.deepEqual(freshFromMissingRepair.priorCarryProof?.source.runId, "7006");
	const repairClaim = await freshFromMissingRepair.claimOneUse(
		freshFromMissingRepair.priorCarryProof!.envelopeSha256);
	assert.equal(repairClaim.currentRunId, "7007");
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
			requestAudit: account, privateBundle: candidate }),
			/reviewed effect ancestry is not bound|new selected tuple lacks a completed authenticated transition/,
			label);
	}
});

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

test("cancelled executed missing-carry run has a separate terminal proof and keeps the prior AEAD selection", async t => {
	const f = await fixture(t);
	const contract = createOriginalObjective({ goal: "Synthetic cancellation gap", goalSource: "user-intent-summary",
		inputNames: ["input.txt"], obligations: [{ id: "O1", description: "Synthetic check" }],
		closure: "open-ended" });
	const bundle = { "original-objective.json": JSON.stringify(contract),
		"objective-checkpoint.json": JSON.stringify(objectiveProgress(contract, {
			boundedRuns: [], selectedArtifacts: ["candidate.cpp", "verification.json", "workflow-archive.json"],
			stopReason: "bounded-run-incomplete" })),
		"candidate.cpp": "prior authenticated candidate", "verification.json": "{}", "workflow-archive.json": "{}" };
	const seedEnvelopeB64 = f.signSeed({ ...f.payload, version: 2,
		rootReviewedAnchor: { commit: sha("a"), artifactSha256: "e".repeat(64),
			digestScope: "encrypted-result-envelope" },
		bootstrap: { contractId: contract.id, sourceSha256: "d".repeat(64),
			format: "deflate-raw-json-v1", filesB64: deflateRawSync(JSON.stringify(bundle)).toString("base64") } });
	const opening = await openLedgerContinuation({ ...f, seedEnvelopeB64,
		githubToken: "synthetic-token", current: current(7002, sha("b")),
		request: github([anchor, first]), loadCarryArtifact: async () => "unused" });
	const carry = opening.sealCurrent({ settledCny: 0, unknownObservedCny: 0,
		unpricedRequestCount: 0, requestAudit: { version: 3, kind: "accounting-only-request-audit",
			requests: [], settledCny: 0, unknownObservedCny: 0, unpricedRequestCount: 0 } });
	const carried = { ...first, status: "completed", conclusion: "failure" };
	const cancelled = { ...second, status: "completed", conclusion: "cancelled" };
	const next = { ...third, status: "in_progress" };
	const rsa = { id: 9503, name: MISSION_ARTIFACT, expired: false,
		digest: `sha256:${"9".repeat(64)}`,
		workflow_run: { id: 7003, head_sha: sha("c") } };
	const requestFor = (runs: object[], options: { artifacts?: object[]; job?: object;
		observed?: object } = {}): typeof fetch => async (url, init) => {
		const address = String(url);
		if (address.endsWith("/runs/7003/jobs?per_page=100")) return new Response(JSON.stringify({
			total_count: 1, jobs: [options.job ?? { id: 6003, run_id: 7003, run_attempt: 1,
				head_sha: sha("c"), name: "private-campaign", status: "completed", conclusion: "cancelled",
				steps: [{ name: "Run private campaign", status: "completed", conclusion: "cancelled" }] }] }));
		if (address.endsWith("/runs/7003/artifacts?per_page=100")) {
			const artifacts = options.artifacts ?? [rsa];
			return new Response(JSON.stringify({ total_count: artifacts.length, artifacts }));
		}
		if (address.endsWith("/actions/runs/7003"))
			return new Response(JSON.stringify(options.observed ?? cancelled));
		return github(runs)(url, init);
	};
	const runs = [anchor, carried, cancelled];
	const terminalInput = { ...f, seedEnvelopeB64, githubToken: "synthetic-token",
		source: current(7003, sha("c")), request: requestFor(runs),
		loadCarryArtifact: async () => carry };
	const terminal = await authenticateLatestTerminalInterruption(terminalInput);
	assert.equal(isAuthenticatedTerminalInterruptionProof(terminal.proof), true);
	assert.equal(isAuthenticatedTerminalInterruptionProof({ ...terminal.proof }), false);
	assert.equal(isAuthenticatedTerminalCarryProof(terminal.proof), false);
	assert.equal(terminal.proof.gap.source.runId, "7003");
	assert.equal(terminal.proof.gap.terminal.runConclusion, "cancelled");
	assert.equal(terminal.proof.gap.terminal.jobConclusion, "cancelled");
	assert.equal(terminal.proof.gap.resultArtifact.artifactId, "9503");
	assert.equal(terminal.proof.gap.resultArtifact.archiveSha256, "9".repeat(64));
	assert.equal(terminal.proof.gap.priorCarryEnvelopeSha256, terminal.priorCarryProof.envelopeSha256);
	assert.equal(terminal.proof.priorCarry.envelopeSha256, terminal.priorCarryProof.envelopeSha256);
	assert.equal(terminal.proof.gap.effects, "unreviewed");
	assert.equal(terminal.proof.gap.accounting, "unquantified");
	assert.equal(terminal.priorPrivateBundle["candidate.cpp"], bundle["candidate.cpp"]);
	assert.equal(authenticatedTerminalInterruptionBindsPriorBundle(terminal.proof,
		terminal.priorPrivateBundle), true);
	assert.equal(authenticatedTerminalInterruptionBindsPriorBundle(terminal.proof,
		{ ...terminal.priorPrivateBundle, "candidate.cpp": "unreviewed result" }), false);
	const projection = authenticatedTerminalInterruptionSupervisorProjection(terminal.proof,
		terminal.priorPrivateBundle);
	assert.equal(projection?.status.contractId, contract.id);
	assert.equal(projection?.status.stopReason, "bounded-run-incomplete");
	assert.equal(projection?.priorSource.runId, "7002");
	assert.equal(authenticatedTerminalInterruptionSupervisorProjection({ ...terminal.proof },
		terminal.priorPrivateBundle), undefined);
	const ordinary = await openLedgerContinuation({ ...f, seedEnvelopeB64,
		githubToken: "synthetic-token", current: current(7005, sha("e")),
		request: requestFor([...runs, next]), loadCarryArtifact: async () => carry });
	assert.equal(ordinary.opaqueExecutedRuns.length, 1);
	assert.equal(ordinary.opaqueExecutedRuns[0].source.runId, "7003");
	assert.equal(ordinary.opaqueExecutedRuns[0].accounting, "unquantified");
	assert.equal(ordinary.priorCarryProof?.source.runId, "7002");
	const incrementalDir = await mkdtemp(path.join(os.tmpdir(), "ledger-incremental-reopen-"));
	t.after(async () => rm(incrementalDir, { recursive: true, force: true }));
	const authenticatedSeed = await authenticateSignedMissionSeed({ ...f, envelopeB64: seedEnvelopeB64 });
	const prefixSource = { repository: MISSION_REPOSITORY, runId: "7003", runAttempt: 1,
		commit: sha("c"), event: "workflow_dispatch" as const,
		priorEnvelopeSha256: ordinary.priorCarryProof!.envelopeSha256 };
	const journal = new IncrementalPrivateCheckpointJournal({ source: prefixSource,
		outputDir: incrementalDir,
		authenticatedMissionKey: authenticatedSeed.derivePrivateKey("mul-pis-ledger-continuation-v1") });
	const sessionId = campaignSessionEffectId("synthetic-prefix-request");
	const prefixInput = (received: boolean) => {
		const requests = [{ requestId: "prefix-request-1", sessionId, responseReceived: received,
			inputPayloadBytes: 120, maxOutputTokens: 512,
			status: (received ? "unknown" : "in-flight") as "unknown" | "in-flight",
			settledCny: null, unknownObservedCny: received ? 0.002 : null,
			reportedUsage: null }];
		return { requestAudit: { version: 3 as const, kind: "accounting-only-request-audit" as const,
			requests, settledCny: 0, unknownObservedCny: received ? 0.002 : 0,
			unpricedRequestCount: received ? 0 : 1 },
			hostEffects: { version: 1 as const, kind: "host-effect-prefix-observation" as const,
				complete: false as const, selectionAuthority: false as const,
				source: { runId: prefixSource.runId, runAttempt: prefixSource.runAttempt,
					commit: prefixSource.commit },
				priorEnvelopeSha256: prefixSource.priorEnvelopeSha256,
				historicalGoalRunIds: [], goals: [], sessions: [],
				requestIds: requests.map(row => row.requestId) } };
	};
	await journal.record("request-reserved", prefixInput(false));
	const reservedRaw = await readFile(path.join(incrementalDir, INCREMENTAL_CHECKPOINT_FILE), "utf8");
	await journal.record("request-observed", prefixInput(true));
	const observedRaw = await readFile(path.join(incrementalDir, INCREMENTAL_CHECKPOINT_FILE), "utf8");
	const prefixArtifact = { id: 9603, name: CARRY_ARTIFACT_NAME, expired: false,
		digest: `sha256:${"8".repeat(64)}`,
		workflow_run: { id: 7003, head_sha: sha("c") } };
	let observedExpectedArchiveSha256: string | undefined;
	const withPrefix = (raw: string, artifactList: object[] = [rsa, prefixArtifact]) => ({
		...terminalInput, request: requestFor(runs, { artifacts: artifactList }),
		loadCarryArtifact: async ({ runId, expectedArchiveSha256 }: { runId: string;
			artifactId: string; expectedArchiveSha256?: string }) => {
			if (runId === "7003") observedExpectedArchiveSha256 = expectedArchiveSha256;
			return runId === "7003" ? { incrementalControlPrefix: raw } : carry;
		} });
	const reserved = await authenticateLatestTerminalInterruption(withPrefix(reservedRaw));
	assert.equal(observedExpectedArchiveSha256, "8".repeat(64));
	assert.equal(isAuthenticatedIncrementalPrefixObservation(reserved.incrementalPrefixObservation), true);
	assert.equal(reserved.incrementalPrefixObservation?.event, "request-reserved");
	assert.equal(reserved.incrementalPrefixObservation?.requestAudit.requests[0].status, "in-flight");
	assert.equal(reserved.incrementalPrefixObservation?.artifact.artifactId, "9603");
	assert.equal(reserved.incrementalPrefixObservation?.artifact.archiveSha256, "8".repeat(64));
	assert.equal(reserved.incrementalPrefixObservation?.priorCarryEnvelopeSha256,
		reserved.priorCarryProof.envelopeSha256);
	assert.equal(isAuthenticatedIncrementalPrefixObservation({ ...reserved.incrementalPrefixObservation }), false);
	assert.equal(authenticatedIncrementalPrefixBindsPriorBundle(reserved.incrementalPrefixObservation,
		reserved.priorPrivateBundle), true);
	assert.equal(authenticatedIncrementalPrefixBindsPriorBundle(reserved.incrementalPrefixObservation,
		{ ...reserved.priorPrivateBundle, "candidate.cpp": "unreviewed replacement" }), false);
	assert.equal(reserved.proof.gap.accounting, "unquantified");
	const observed = await authenticateLatestTerminalInterruption(withPrefix(observedRaw));
	assert.equal(observed.incrementalPrefixObservation?.event, "request-observed");
	assert.equal(observed.incrementalPrefixObservation?.requestAudit.requests[0].responseReceived, true);
	assert.equal(observed.incrementalPrefixObservation?.requestAudit.unknownObservedCny, 0.002);
	assert.equal(observed.priorCarryProof.priorSettledCny, reserved.priorCarryProof.priorSettledCny);
	const corrupted = JSON.stringify({ ...JSON.parse(observedRaw), status: "complete" });
	const unusable = await authenticateLatestTerminalInterruption(withPrefix(corrupted));
	assert.equal(unusable.incrementalPrefixObservation, undefined);
	assert.equal(unusable.incrementalPrefixFailure?.category, "decode-or-authentication-failed");
	assert.equal(unusable.incrementalPrefixFailure?.stage, "envelope");
	assert.equal(unusable.incrementalPrefixFailure?.reason, "invalid-format");
	assert.equal(unusable.incrementalPrefixFailure?.artifact.artifactId, "9603");
	assert.equal(unusable.proof.gap.accounting, "unquantified");
	const wrongParent = JSON.stringify({ ...JSON.parse(observedRaw), incrementalControlEnvelope: {
		...JSON.parse(observedRaw).incrementalControlEnvelope,
		source: { ...prefixSource, priorEnvelopeSha256: "f".repeat(64) } } });
	const parentFailure = (await authenticateLatestTerminalInterruption(withPrefix(wrongParent)))
		.incrementalPrefixFailure;
	assert.equal(parentFailure?.category, "decode-or-authentication-failed");
	assert.equal(parentFailure?.stage, "source");
	assert.equal(parentFailure?.reason, "binding-mismatch");
	const wrongSource = JSON.stringify({ ...JSON.parse(observedRaw), incrementalControlEnvelope: {
		...JSON.parse(observedRaw).incrementalControlEnvelope,
		source: { ...prefixSource, runId: "7002" } } });
	const sourceFailure = (await authenticateLatestTerminalInterruption(withPrefix(wrongSource)))
		.incrementalPrefixFailure;
	assert.equal(sourceFailure?.category, "decode-or-authentication-failed");
	assert.equal(sourceFailure?.stage, "source");
	assert.equal(sourceFailure?.reason, "binding-mismatch");
	await assert.rejects(authenticateLatestTerminalInterruption(withPrefix(observedRaw,
		[rsa, prefixArtifact, { ...prefixArtifact, id: 9604 }])), /unavailable or ambiguous/);
	for (const invalidArtifact of [
		{ ...prefixArtifact, workflow_run: { id: 7003, head_sha: sha("9") } },
		{ ...prefixArtifact, digest: "sha256:bad" },
		{ ...prefixArtifact, expired: true },
	]) await assert.rejects(authenticateLatestTerminalInterruption(withPrefix(observedRaw,
		[rsa, invalidArtifact])), /incremental prefix artifact identity|unavailable or ambiguous/);
	const successorWithPrefix = await openLedgerContinuation({ ...f, seedEnvelopeB64,
		githubToken: "synthetic-token", current: current(7005, sha("e")),
		request: requestFor([...runs, next], { artifacts: [rsa, prefixArtifact] }),
		loadCarryArtifact: async ({ runId }) => runId === "7003" ?
			{ incrementalControlPrefix: observedRaw } : carry });
	assert.equal(successorWithPrefix.incrementalPrefixObservation?.event, "request-observed");
	assert.equal(successorWithPrefix.priorSettledCny, ordinary.priorSettledCny);
	assert.equal(successorWithPrefix.opaqueExecutedRuns[0].accounting, "unquantified");
	const successorCarry = successorWithPrefix.sealCurrent({ settledCny: 0, unknownObservedCny: 0,
		unpricedRequestCount: 0, requestAudit: { version: 3, kind: "accounting-only-request-audit",
			requests: [], settledCny: 0, unknownObservedCny: 0, unpricedRequestCount: 0 } });
	const successorDone = { ...next, status: "completed", conclusion: "failure" };
	const later = run(7006, 5, "in_progress", sha("f"));
	const reopenRequest: typeof fetch = async (url, init) => {
		const address = String(url);
		if (address.endsWith("/runs/7005/jobs?per_page=100")) return new Response(JSON.stringify({
			total_count: 1, jobs: [{ id: 6005, run_id: 7005, run_attempt: 1,
				head_sha: sha("e"), name: "private-campaign", status: "completed", conclusion: "failure",
				steps: [{ name: "Run private campaign", status: "completed", conclusion: "failure" }] }] }));
		if (address.endsWith("/runs/7005/artifacts?per_page=100")) return new Response(JSON.stringify({
			total_count: 1, artifacts: [{ id: 9005, name: CARRY_ARTIFACT_NAME,
				expired: false, workflow_run: { id: 7005, head_sha: sha("e") } }] }));
		return requestFor([...runs, successorDone, later])(url, init);
	};
	const reopened = await openLedgerContinuation({ ...f, seedEnvelopeB64,
		githubToken: "synthetic-token", current: current(7006, sha("f")),
		request: reopenRequest, loadCarryArtifact: async identity =>
			identity.runId === "7005" ? successorCarry : carry });
	assert.equal(reopened.opaqueExecutedRuns.length, 1);
	assert.equal(reopened.opaqueExecutedRuns[0].source.runId, "7003");
	assert.equal(reopened.opaqueExecutedRuns[0].effects, "unreviewed");
	assert.equal(reopened.opaqueExecutedRuns[0].accounting, "unquantified");
	assert.equal(reopened.historicalIncrementalPrefixes.length, 1);
	assert.equal(reopened.historicalIncrementalPrefixes[0].event, "request-observed");
	assert.equal(reopened.historicalIncrementalPrefixes[0].requestAudit.requests[0].requestId,
		"prefix-request-1");
	assert.equal(reopened.historicalIncrementalPrefixes[0].requestAudit.unknownObservedCny, 0.002);
	assert.deepEqual(reopened.historicalIncrementalPrefixes[0].hostEffects.requestIds,
		["prefix-request-1"]);
	assert.equal(reopened.historicalIncrementalPrefixes[0].prefixSha256,
		createHash("sha256").update(observedRaw).digest("hex"));
	assert.equal(reopened.historicalIncrementalPrefixes[0].accounting, "unquantified");
	assert.equal(authenticatedIncrementalPrefixBindsPriorBundle(
		reopened.historicalIncrementalPrefixes[0], reopened.priorPrivateBundle), true);
	assert.equal(authenticatedAccountingObservation(reopened.priorCarryProof,
		reopened.priorPrivateBundle)?.opaqueUnquantifiedRunCount, 1);
	await assert.rejects(authenticateLatestTerminalCarry(terminalInput), /artifact is unavailable or ambiguous/);
	for (const [label, options] of [
		["carry present", { artifacts: [rsa, { id: 9003, name: CARRY_ARTIFACT_NAME,
			expired: false, workflow_run: { id: 7003 } }] }],
		["result absent", { artifacts: [] }],
		["result duplicate", { artifacts: [rsa, { ...rsa, id: 9504 }] }],
		["result SHA wrong", { artifacts: [{ ...rsa, workflow_run: { id: 7003, head_sha: sha("9") } }] }],
		["result digest malformed", { artifacts: [{ ...rsa, digest: "sha256:bad" }] }],
		["job SHA wrong", { job: { id: 6003, run_id: 7003, run_attempt: 1,
			head_sha: sha("9"), name: "private-campaign", status: "completed", conclusion: "cancelled",
			steps: [{ name: "Run private campaign", status: "completed", conclusion: "cancelled" }] } }],
		["step missing", { job: { id: 6003, run_id: 7003, run_attempt: 1,
			head_sha: sha("c"), name: "private-campaign", status: "completed", conclusion: "cancelled",
			steps: [] } }],
		["run reread changed", { observed: { ...cancelled, head_sha: sha("9") } }],
	] as Array<[string, { artifacts?: object[]; job?: object; observed?: object }]>)
		await assert.rejects(authenticateLatestTerminalInterruption({ ...terminalInput,
			request: requestFor(runs, options) }), label);
});

test("optional encrypted transport cause census binds only unknown audit IDs and carries forward unchanged", async t => {
	const f = await compactedFixture(t);
	const opened = await openLedgerContinuation({ ...f, githubToken: "synthetic-token",
		current: current(7005, sha("e")), loadCarryArtifact: async () => f.secondCarry.envelopeB64 });
	assert.equal(opened.priorTransportDiagnosticCensus, undefined);
	const lostSession = campaignSessionEffectId("synthetic-lost-session");
	const currentAudit = { version: 3 as const, kind: "accounting-only-request-audit" as const,
		requests: [{ requestId: "synthetic-lost", sessionId: lostSession, responseReceived: false,
			inputPayloadBytes: 100, status: "unknown" as const, settledCny: null,
			unknownObservedCny: null, reportedUsage: null }], settledCny: 0,
		unknownObservedCny: 0, unpricedRequestCount: 1 };
	const diagnostic = { version: 1 as const, promptIndex: 9, requestId: "synthetic-lost",
		phase: "response-body" as const, httpStatus: 400, responseStarted: true,
		bytesRead: 64, abortSource: null, providerErrorCode: "invalid_parameter",
		providerErrorType: "invalid_request_error", providerErrorReasonClass: "input-schema" as const,
		providerRequestId: "a".repeat(32),
		errorCodes: [], message: "RAW_PRIVATE_MESSAGE_MUST_NOT_PERSIST",
		privateProviderError: { code: "invalid_parameter", type: "invalid_request_error",
			message: "PRIVATE_RSA_REASON_ONLY", param: "messages[3]",
			numericLimits: { max_context_tokens: 128000 } } };
	const unavailable = opened.appendTransportDiagnosticCensus(currentAudit, []);
	assert.equal(JSON.parse(unavailable!).entries[0].rows[0].availability, "unavailable");
	const { providerErrorReasonClass: _omitted, ...legacyDiagnostic } = diagnostic;
	const legacyText = opened.appendTransportDiagnosticCensus(currentAudit, [legacyDiagnostic]);
	assert.equal(JSON.parse(legacyText!).entries[0].rows[0].providerErrorReasonClass, undefined,
		"older v1 observed rows remain valid without rewriting them");
	const text = opened.appendTransportDiagnosticCensus(currentAudit, [diagnostic]);
	assert.ok(text);
	assert.doesNotMatch(text, /RAW_PRIVATE_MESSAGE_MUST_NOT_PERSIST|PRIVATE_RSA_REASON_ONLY|privateProviderError|providerRequestId|promptIndex/);
	assert.equal(JSON.parse(text).entries[0].rows[0].providerErrorReasonClass, "input-schema");
	const collectorFailure = await openLedgerContinuation({ ...f, githubToken: "synthetic-token",
		current: current(7005, sha("e")), loadCarryArtifact: async () => f.secondCarry.envelopeB64 });
	const prepared = collectorFailure.appendTransportDiagnosticCensus(currentAudit, [diagnostic]);
	const retained = offlineChecks.collectorFailureBundle(collectorFailure.priorPrivateBundle, prepared);
	assert.equal(retained?.["transport-diagnostics.json"], prepared);
	const emergency = sealCampaignCarry({ sealCurrent: () => {
		throw Error("synthetic research collector failure");
	}, sealEmergencyCurrent: collectorFailure.sealEmergencyCurrent },
	{ settledCny: 0, unknownObservedCny: 0, unpricedRequestCount: 1,
		requestAudit: currentAudit, privateBundle: retained });
	assert.equal(emergency.mode, "emergency-effects-unreviewed");
	assert.equal(emergency.carry.unpricedRequestCount, (collectorFailure.priorUnpricedRequestCount ?? 0) + 1);
	const nearLimit = { "candidate.cpp": "x".repeat(4 * 1024 * 1024 - 200) };
	assert.equal(retainedTransportDiagnosticWithinBundle(nearLimit, text), text,
		"segmented carry retains the optional cause beyond the old aggregate bound");
	assert.equal(retainedTransportDiagnosticWithinBundle(nearLimit,
		"x".repeat(4 * 1024 * 1024 + 1)), undefined,
		"optional cause yields when its own file exceeds the byte bound");
	assert.equal(offlineChecks.collectorFailureBundle(nearLimit,
		retainedTransportDiagnosticWithinBundle(nearLimit, text))?.["candidate.cpp"],
		nearLimit["candidate.cpp"]);
	const nearLimitCarry = await rewriteSyntheticCarry(f, cp => {
		cp.privateBundle["candidate.cpp"] = nearLimit["candidate.cpp"];
	});
	const nearLimitOpened = await openLedgerContinuation({ ...f, githubToken: "synthetic-token",
		current: current(7005, sha("e")), loadCarryArtifact: async () => nearLimitCarry });
	const nearPrepared = nearLimitOpened.appendTransportDiagnosticCensus(currentAudit, [diagnostic]);
	assert.ok(nearPrepared);
	const feeSafe = nearLimitOpened.sealEmergencyCurrent({ settledCny: 0, unknownObservedCny: 0,
		unpricedRequestCount: 1, requestAudit: currentAudit,
		privateBundle: { ...nearLimitOpened.priorPrivateBundle,
			"transport-diagnostics.json": nearPrepared } }, "effect-review-incomplete");
	assert.equal(feeSafe.unpricedRequestCount, (nearLimitOpened.priorUnpricedRequestCount ?? 0) + 1);
	assert.throws(() => opened.appendTransportDiagnosticCensus(currentAudit, [diagnostic, diagnostic]),
		/repeats one unknown request/);
	const badCode = { ...diagnostic, providerErrorCode: "raw_private_parameter" };
	assert.throws(() => opened.appendTransportDiagnosticCensus(currentAudit, [badCode]),
		/transport diagnostic rows/);
	const badReason = { ...diagnostic, providerErrorReasonClass: "raw_private_reason" as never };
	assert.throws(() => opened.appendTransportDiagnosticCensus(currentAudit, [badReason]),
		/transport diagnostic rows/);
	const badBundle = { ...opened.priorPrivateBundle!, "transport-diagnostics.json":
		text.replace('"availability":"observed"', '"availability":"observed","message":"raw"') };
	assert.throws(() => opened.sealCurrent({ settledCny: 0, unknownObservedCny: 0,
		unpricedRequestCount: 1, requestAudit: currentAudit, privateBundle: badBundle }),
		/transport diagnostic/);
	for (const altered of [
		text.replace('"requestId":"synthetic-lost"', '"requestId":"other-request"'),
		text.replace('"commit":"' + sha("e") + '"', '"commit":"' + sha("f") + '"'),
	]) assert.throws(() => opened.sealCurrent({ settledCny: 0, unknownObservedCny: 0,
		unpricedRequestCount: 1, requestAudit: currentAudit,
		privateBundle: { ...opened.priorPrivateBundle!, "transport-diagnostics.json": altered } }),
		/transport diagnostic/);
	const sealed = opened.sealCurrent({ settledCny: 0, unknownObservedCny: 0,
		unpricedRequestCount: 1, requestAudit: currentAudit,
		privateBundle: { ...opened.priorPrivateBundle!, "transport-diagnostics.json": text } });
	const done = { ...third, status: "completed", conclusion: "failure" };
	const next = run(7006, 5, "in_progress", sha("f"));
	const reopened = await openLedgerContinuation({ ...f, githubToken: "synthetic-token",
		current: current(7006, sha("f")), request: async (url, init) => {
			const address = String(url);
			if (address.includes("/workflows/manual-private-campaign.yml/runs?"))
				return new Response(JSON.stringify({ total_count: 5,
					workflow_runs: [next, done, { ...second, status: "completed", conclusion: "success" },
						{ ...first, status: "completed", conclusion: "success" }, anchor] }));
			if (address.includes("/runs/7005/jobs?")) return new Response(JSON.stringify({ total_count: 1,
				jobs: [{ id: 6005, run_id: 7005, run_attempt: 1, head_sha: sha("e"),
					name: "private-campaign", status: "completed", conclusion: "failure",
					steps: [{ name: "Run private campaign", status: "completed", conclusion: "failure" }] }] }));
			if (address.includes("/runs/7005/artifacts?")) return new Response(JSON.stringify({ total_count: 1,
				artifacts: [{ id: 9005, name: CARRY_ARTIFACT_NAME, expired: false,
					workflow_run: { id: 7005, head_sha: sha("e") } }] }));
			return f.request(url, init);
		}, loadCarryArtifact: async ({ artifactId }) => {
			assert.equal(artifactId, "9005"); return sealed;
		} });
	assert.equal(reopened.priorTransportDiagnosticCensus?.entries.length, 1);
	assert.equal(reopened.priorTransportDiagnosticCensus?.entries[0].rows.length, 1);
	const emptyAudit = { version: 3 as const, kind: "accounting-only-request-audit" as const,
		requests: [], settledCny: 0, unknownObservedCny: 0, unpricedRequestCount: 0 };
	assert.equal(reopened.appendTransportDiagnosticCensus(emptyAudit, []), text);
});

test("a terminal HTTP 402 hold survives a zero-request unavailable wrapper and clears only after a newer live available check", async t => {
	const f = await compactedFixture(t);
	const emptyAudit = { version: 3 as const, kind: "accounting-only-request-audit" as const,
		requests: [], settledCny: 0, unknownObservedCny: 0, unpricedRequestCount: 0 };
	const failedAudit = { ...emptyAudit, requests: [{ requestId: "payment-rejected", sessionId:
		campaignSessionEffectId("payment-session"), inputPayloadBytes: 100,
		responseReceived: false, status: "unknown" as const, settledCny: null,
		unknownObservedCny: null, reportedUsage: null }], unpricedRequestCount: 1 };
	const opening = await openLedgerContinuation({ ...f, githubToken: "synthetic-token",
		current: current(7005, sha("e")), loadCarryArtifact: async () => f.secondCarry.envelopeB64 });
	const cause = opening.appendTransportDiagnosticCensus(failedAudit, [{ version: 1, promptIndex: 1,
		requestId: "payment-rejected", phase: "response-body", httpStatus: 402,
		responseStarted: true, bytesRead: 162, abortSource: null,
		providerErrorCode: "invalid_request_error", providerErrorType: null,
		providerErrorReasonClass: "unknown", providerRequestId: null, errorCodes: [] }]);
	assert.ok(cause);
	const sameRunAvailable = await checkDeepSeekAvailability({ apiKey: "synthetic-only", request: async () =>
		new Response(JSON.stringify({ is_available: true, balance_infos: [{ currency: "CNY",
			total_balance: "synthetic", granted_balance: "synthetic", topped_up_balance: "synthetic" }] }),
			{ status: 200 }) });
	opening.appendProviderAvailabilityObservation(sameRunAvailable);
	const replayOpening = await openLedgerContinuation({ ...f, githubToken: "synthetic-token",
		current: current(7005, sha("e")), loadCarryArtifact: async () => f.secondCarry.envelopeB64 });
	assert.throws(() => replayOpening.appendProviderAvailabilityObservation(sameRunAvailable),
		/lacks one live verified check/, "one read-only GET cannot attest a second run reservation");
	const heldCarry = opening.sealEmergencyCurrent({ settledCny: 0, unknownObservedCny: 0,
		unpricedRequestCount: 1, requestAudit: failedAudit,
		privateBundle: { ...opening.priorPrivateBundle!, "transport-diagnostics.json": cause } },
		"effect-review-incomplete");
	const done5 = { ...third, status: "completed", conclusion: "failure" };
	const commitOf = (runId: number): string => sha(({ 7005: "e", 7006: "f", 7007: "1", 7008: "2" } as
		Record<number, string>)[runId]!);
	const readNext = async (runId: number, carry: CarryArtifactPayload, priorDone: object[]) => {
		return openLedgerContinuation({ ...f, githubToken: "synthetic-token",
			current: current(runId, commitOf(runId)),
			request: async (url, init) => {
				const address = String(url);
				if (address.includes("/workflows/manual-private-campaign.yml/runs?"))
					return new Response(JSON.stringify({ total_count: priorDone.length + 1,
						workflow_runs: [run(runId, runId - 7001, "in_progress",
							commitOf(runId)), ...priorDone] }));
				for (const id of [7005, 7006, 7007]) {
					if (address.includes(`/runs/${id}/jobs?`))
						return new Response(JSON.stringify({ total_count: 1, jobs: [{ id: id - 1000,
							run_id: id, run_attempt: 1, head_sha: commitOf(id),
							name: "private-campaign", status: "completed", conclusion: "failure",
							steps: [{ name: "Run private campaign", status: "completed", conclusion: "failure" }] }] }));
					if (address.includes(`/runs/${id}/artifacts?`))
						return new Response(JSON.stringify({ total_count: 1, artifacts: [{ id: id + 2000,
							name: CARRY_ARTIFACT_NAME, expired: false,
							workflow_run: { id, head_sha: commitOf(id) } }] }));
				}
				return f.request(url, init);
			}, loadCarryArtifact: async () => carry });
	};
	const older = [{ ...second, status: "completed", conclusion: "success" },
		{ ...first, status: "completed", conclusion: "success" }, anchor];
	const held = await readNext(7006, heldCarry, [done5, ...older]);
	assert.equal(held.priorProviderPaymentHold, true,
		"a terminal 402 outranks an earlier available probe in the same run");
	const unavailable = await checkDeepSeekAvailability({ apiKey: "synthetic-only", request: async () =>
		new Response(JSON.stringify({ is_available: false, balance_infos: [] }), { status: 200 }) });
	const observation = held.appendProviderAvailabilityObservation(unavailable);
	assert.equal(JSON.parse(observation).entries.at(-1).availability, "unavailable");
	assert.throws(() => held.sealEmergencyCurrent({ settledCny: 0, unknownObservedCny: 0,
		unpricedRequestCount: 0, requestAudit: emptyAudit, privateBundle: {
			...held.priorPrivateBundle, "provider-availability-observation.json": observation.replace(
				'"unavailable"', '"available"') } }, "effect-review-incomplete"),
		/availability observation changed/);
	const unavailableCarry = held.sealEmergencyCurrent({ settledCny: 0, unknownObservedCny: 0,
		unpricedRequestCount: 0, requestAudit: emptyAudit }, "effect-review-incomplete");
	const nextHeld = await readNext(7007, unavailableCarry,
		[{ ...run(7006, 5, "completed", commitOf(7006), "failure") }, done5, ...older]);
	assert.equal(nextHeld.priorProviderPaymentHold, true,
		"a zero-request emergency wrapper cannot erase the earlier payment hold");
	assert.equal(nextHeld.priorPrivateBundle?.["provider-availability-observation.json"], observation);
	const available = await checkDeepSeekAvailability({ apiKey: "synthetic-only", request: async () =>
		new Response(JSON.stringify({ is_available: true, balance_infos: [{ currency: "CNY",
			total_balance: "synthetic", granted_balance: "synthetic", topped_up_balance: "synthetic" }] }),
			{ status: 200 }) });
	const clearText = nextHeld.appendProviderAvailabilityObservation(available);
	assert.equal(JSON.parse(clearText).entries.length, 3);
	const clearCarry = nextHeld.sealEmergencyCurrent({ settledCny: 0, unknownObservedCny: 0,
		unpricedRequestCount: 0, requestAudit: emptyAudit }, "effect-review-incomplete");
	const cleared = await readNext(7008, clearCarry,
		[run(7007, 6, "completed", commitOf(7007), "failure"),
		 run(7006, 5, "completed", commitOf(7006), "failure"), done5, ...older]);
	assert.equal(cleared.priorProviderPaymentHold, false,
		"only a newer process-verified available result clears the payment hold");
	assert.equal(cleared.priorPrivateBundle?.["provider-availability-observation.json"], clearText);
	const omittedAvailability = { ...cleared.priorPrivateBundle! };
	delete omittedAvailability["provider-availability-observation.json"];
	assert.throws(() => cleared.sealCurrent({ settledCny: 0, unknownObservedCny: 0,
		unpricedRequestCount: 0, requestAudit: emptyAudit,
		privateBundle: omittedAvailability }), /availability observation changed/,
		"a normal sealer cannot silently erase carried provider availability history");
	const recoveredAudit = { ...failedAudit, requests: [...failedAudit.requests, {
		requestId: "later-response", sessionId: campaignSessionEffectId("second-session"),
		inputPayloadBytes: 120, responseReceived: true, status: "unknown" as const,
		settledCny: null, unknownObservedCny: null,
		reportedUsage: { input: 10, output: 10, totalTokens: 20 } }], unpricedRequestCount: 2 };
	const recoveredOpening = await openLedgerContinuation({ ...f, githubToken: "synthetic-token",
		current: current(7005, sha("e")), loadCarryArtifact: async () => f.secondCarry.envelopeB64 });
	const earlier402 = recoveredOpening.appendTransportDiagnosticCensus(recoveredAudit, [{
		version: 1, promptIndex: 1, requestId: "payment-rejected", phase: "response-body",
		httpStatus: 402, responseStarted: true, bytesRead: 162, abortSource: null,
		providerErrorCode: "invalid_request_error", providerErrorType: null,
		providerErrorReasonClass: "unknown", providerRequestId: null, errorCodes: [] }]);
	const recoveredCarry = recoveredOpening.sealEmergencyCurrent({ settledCny: 0,
		unknownObservedCny: 0, unpricedRequestCount: 2, requestAudit: recoveredAudit,
		privateBundle: { ...recoveredOpening.priorPrivateBundle!, "transport-diagnostics.json": earlier402 } },
		"effect-review-incomplete");
	const noFalseHold = await readNext(7006, recoveredCarry, [done5, ...older]);
	assert.equal(noFalseHold.priorProviderPaymentHold, false,
		"an earlier 402 followed by a received terminal response cannot mint a payment hold");
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
