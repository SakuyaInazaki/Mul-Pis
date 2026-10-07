import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { buildUnresolvedHistoricalM04Quarantine,
	hasFreshOnlyM04QuarantineForLatest, offlineM04QuarantineChecks,
	validateM04TransactionQuarantine, type FreshM04QuarantineBoundary } from
	"../src/runner/m04-quarantine.ts";
import type { AuthenticatedHostEffectEvidence, AuthenticatedPriorCarryProof,
	PrivateContinuationBundle } from "../src/runner/ledger-continuation.ts";
import { offlineChecks } from "../scripts/manual-private-campaign.ts";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const source = { runId: "7002", runAttempt: 1, runNumber: 2, commit: "b".repeat(40) };
const proof = { version: 2, source, envelopeSha256: "a".repeat(64) } as AuthenticatedPriorCarryProof;
const boundary: FreshM04QuarantineBoundary = {
	campaignRoot: "/tmp/mulpis-private-campaign-synthetic",
	workspaceRoot: "/tmp/mulpis-private-campaign-synthetic/workspace",
	storeRoot: "/tmp/mulpis-private-campaign-synthetic/workspace/.agent/knowledge",
	storeEmpty: true, sessionCensusEmpty: true,
	sessionMode: "no-prior-session-resume", grantProfile: "private-confined-read-dir",
	externalWriteTools: false, sharedStore: false, selectedRevalidated: true,
};
function fixture(proposalSubmitted: boolean) {
	const contract = { version: 1, kind: "original-objective", id: "synthetic-contract" };
	const selectedArchive = { version: 1, kind: "m07-private-candidate-archive",
		goalRunId: "selected-goal", taskId: "T001" };
	const checkpoint = { version: 1, kind: "original-objective-progress", contract,
		objectiveOutcome: "incomplete", selectedArtifacts: ["candidate.cpp", "verification.json", "workflow-archive.json"],
		boundedRuns: [{ runId: "selected-goal", outcome: "fulfilled", selectedTaskId: "T001",
			unresolvedOperationIds: [] },
			{ runId: "old-goal", outcome: "active", unresolvedOperationIds: ["O001"] },
			{ runId: "new-goal", outcome: "fulfilled", selectedTaskId: "T002", unresolvedOperationIds: [] }],
		continuation: { unresolvedOperationIds: ["old-goal/O001"] } };
	const archive = { version: 1, kind: "m07-private-candidate-archive",
		goalRunId: "new-goal", taskId: "T002", goalOutcome: "fulfilled", taskStatus: "accepted",
		controllerEvidence: { reviewStatus: "accepted",
			reviewChecks: offlineChecks.fixedPrivateChecks.diagnostic.map(criterion => ({ criterion, result: "passed" })),
			operationOutcomes: [{ operationId: "O001", status: "response-received" }] },
		m04: { state: "failed", runId: "M04-run", proposalSubmitted, snapshotCreated: false,
			adoptedExperienceRefs: [], knowledgeExport: { state: "none" } } };
	const bundle: PrivateContinuationBundle = {
		"candidate.cpp": "old selected candidate", "verification.json": "old selected verification",
		"workflow-archive.json": JSON.stringify(selectedArchive),
		"objective-checkpoint.json": JSON.stringify(checkpoint),
		"research-history.json": JSON.stringify({ version: 1,
			kind: "untrusted-version-bound-research-history",
			entries: [{ originalContractId: contract.id, goalRunId: "new-goal", taskId: "T002",
				files: { "workflow-archive.json": JSON.stringify(archive) } }] }) };
	const selectedTupleSha256 = hash(JSON.stringify(checkpoint.selectedArtifacts.slice().sort().map(name => ({ name,
		sha256: hash(bundle[name as keyof PrivateContinuationBundle]!),
		bytes: Buffer.byteLength(bundle[name as keyof PrivateContinuationBundle]!, "utf8") }))));
	bundle["independent-restart-quarantine.json"] = JSON.stringify({ version: 1,
		kind: "host-independent-restart-reservations", entries: [{ receipt: { prior: { selectedTupleSha256 } } }] });
	const execution = "1".repeat(64), read = "2".repeat(64);
	const receipt = { version: 1, kind: "m07-host-effect-census", source: {
		runId: source.runId, runAttempt: source.runAttempt, commit: source.commit },
		goals: [{ runId: "new-goal", outcome: "fulfilled",
			tasks: [{ taskId: "T002", mode: "execute", status: "accepted", sessionId: execution }],
			operations: [{ id: "O001", taskId: "T002", status: "response-received" }] }],
		sessions: [{ sessionId: execution, kind: "confined-execution", goalRunId: "new-goal", taskId: "T002" },
			{ sessionId: read, kind: "read-dir" }] };
	const effect = { receipt, requestAudit: { requests: [
		{ requestId: "received", sessionId: read, responseReceived: true, status: "settled" } ] } } as unknown as AuthenticatedHostEffectEvidence;
	return { bundle, effect };
}

for (const submitted of [false, true]) test(`missing portable M04 proposal ${submitted} stays unresolved and fresh-work-only`, () => {
	const { bundle, effect } = fixture(submitted);
	const quarantine = offlineM04QuarantineChecks.build({ proof, bundle, freshBoundary: boundary, hostEffect: effect });
	assert.equal(quarantine?.entries.length, 1);
	assert.equal(quarantine.entries[0].state, "unknown-unreconciled");
	assert.equal(quarantine.entries[0].proposalSubmitted, submitted);
	assert.deepEqual(quarantine.entries[0].inheritedOperationRefs, ["old-goal/O001"]);
	assert.equal(hasFreshOnlyM04QuarantineForLatest(quarantine, bundle), true);
	assert.equal(offlineChecks.chooseArchivedM07ImportTarget(bundle, proof, quarantine), undefined);
	if (submitted) assert.throws(() => offlineChecks.chooseArchivedM07ImportTarget(bundle, proof,
		structuredClone(quarantine)), /reconcil|authenticated|transaction/i);
	else assert.deepEqual(offlineChecks.chooseArchivedM07ImportTarget(bundle, proof,
		structuredClone(quarantine))?.goalRunId, "new-goal",
		"unbranded data falls through the pre-existing no-proposal import gate");
	assert.equal(hasFreshOnlyM04QuarantineForLatest(structuredClone(quarantine), bundle), false);
	quarantine.entries[0].inheritedOperationRefs.push("old-goal/O002");
	assert.equal(hasFreshOnlyM04QuarantineForLatest(quarantine, bundle), false);
	assert.throws(() => buildUnresolvedHistoricalM04Quarantine({ proof, bundle, freshBoundary: boundary }),
		/live authenticated carry/);
	assert.throws(() => validateM04TransactionQuarantine({ proof, bundle }), /live authenticated carry/);
});

test("a terminal authenticated archive without host census grants only fresh UNKNOWN work", () => {
	const { bundle } = fixture(true);
	const quarantine = offlineM04QuarantineChecks.build({ proof, bundle,
		freshBoundary: boundary });
	assert.equal(quarantine?.entries[0].state, "unknown-unreconciled");
	assert.equal(quarantine?.entries[0].route, "fresh-work-only");
	assert.equal(offlineChecks.chooseArchivedM07ImportTarget(bundle, proof, quarantine), undefined);
	assert.throws(() => offlineChecks.chooseArchivedM07ImportTarget(bundle, proof,
		structuredClone(quarantine)), /reconcil|authenticated|transaction/i);
});

test("portable transaction stays on the portable path; malformed declaration fails closed", () => {
	const { bundle, effect } = fixture(true);
	const history = JSON.parse(bundle["research-history.json"]!);
	const archive = JSON.parse(history.entries[0].files["workflow-archive.json"]);
	archive.m04.transaction = { file: "m04-transaction.json", state: "rejected-draft" };
	history.entries[0].files["workflow-archive.json"] = JSON.stringify(archive);
	history.entries[0].files["m04-transaction.json"] = "synthetic portable payload";
	bundle["research-history.json"] = JSON.stringify(history);
	assert.equal(offlineM04QuarantineChecks.build({ proof, bundle, freshBoundary: boundary,
		hostEffect: effect }), undefined);
	delete history.entries[0].files["m04-transaction.json"];
	bundle["research-history.json"] = JSON.stringify(history);
	assert.throws(() => offlineM04QuarantineChecks.build({ proof, bundle,
		freshBoundary: boundary, hostEffect: effect }), /portable M04 transaction/);
});

test("altered selection, unsafe host grants, shared store, and unreceived rows reject", () => {
	const { bundle, effect } = fixture(true);
	assert.throws(() => offlineM04QuarantineChecks.build({ proof,
		bundle: { ...bundle, "candidate.cpp": "swapped selected source" },
		freshBoundary: boundary, hostEffect: effect }), /previously selected tuple/);
	for (const change of [
		{ externalWriteTools: true }, { sharedStore: true }, { storeEmpty: false },
		{ sessionCensusEmpty: false }, { sessionMode: "resume-old-session" },
		{ selectedRevalidated: false }, { storeRoot: "/tmp/shared-store" },
		{ workspaceRoot: "/tmp/shared-workspace" },
		{ workspaceRoot: "/tmp/mulpis-private-campaign-synthetic/workspace/../shared" },
	]) assert.throws(() => offlineM04QuarantineChecks.build({ proof, bundle,
		freshBoundary: { ...boundary, ...change } as FreshM04QuarantineBoundary,
		hostEffect: effect }), /fresh isolated workspace/);
	const unreceived = structuredClone(effect) as unknown as any;
	unreceived.requestAudit.requests[0].responseReceived = false;
	assert.throws(() => offlineM04QuarantineChecks.build({ proof, bundle,
		freshBoundary: boundary, hostEffect: unreceived }), /incomplete or contradicts/);
	const outside = structuredClone(effect) as unknown as any;
	outside.receipt.sessions.push({ sessionId: "3".repeat(64), kind: "confined-execution",
		goalRunId: "other", taskId: "T999" });
	assert.throws(() => offlineM04QuarantineChecks.build({ proof, bundle,
		freshBoundary: boundary, hostEffect: outside }), /incomplete or contradicts/);
	const external = structuredClone(effect) as unknown as any;
	external.receipt.sessions.push({ sessionId: "4".repeat(64), kind: "external-write" });
	assert.throws(() => offlineM04QuarantineChecks.build({ proof, bundle,
		freshBoundary: boundary, hostEffect: external }), /incomplete or contradicts/);
});

test("a no-goal successor keeps one exact historical quarantine entry", () => {
	const { bundle, effect } = fixture(false);
	const initial = offlineM04QuarantineChecks.build({ proof, bundle, freshBoundary: boundary, hostEffect: effect })!;
	const laterProof = { ...proof, source: { runId: "7003", runAttempt: 1, runNumber: 3,
		commit: "c".repeat(40) }, envelopeSha256: "d".repeat(64) } as AuthenticatedPriorCarryProof;
	const laterEffect = structuredClone(effect) as unknown as any;
	laterEffect.receipt.source = { runId: "7003", runAttempt: 1, commit: "c".repeat(40) };
	laterEffect.receipt.goals = [];
	laterEffect.receipt.sessions = [{ sessionId: "2".repeat(64), kind: "read-dir" }];
	const repeated = offlineM04QuarantineChecks.build({ proof: laterProof, bundle,
		freshBoundary: boundary, hostEffect: laterEffect, prior: initial });
	assert.equal(repeated, initial);
	assert.equal(repeated?.entries.length, 1);
});
