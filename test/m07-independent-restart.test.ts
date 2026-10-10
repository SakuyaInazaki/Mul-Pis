import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import path from "node:path";
import test from "node:test";
import { bindIndependentRestartGoal, reserveIndependentRestart, type AuthenticatedRestartCarryFacts,
	type IndependentRestartHost, type IndependentRestartInput,
	type ReviewedRestartEffectPolicy } from "../src/m07/independent-restart.ts";

const hash = (value: string): string => createHash("sha256").update(value).digest("hex");
const bundleHash = (bundle: Record<string, string>): string => hash(JSON.stringify(
	Object.fromEntries(Object.entries(bundle).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))));
const sourceCommit = "a".repeat(40);
const unknown = "old-goal/O002";

function fixture() {
	const contract = { version: 1, kind: "original-objective", id: "original-objective",
		createdAt: "2026-10-01T00:00:00Z", goal: "Find the strongest supported result",
		goalSource: "user-intent-summary", inputNames: ["original.txt"],
		obligations: [{ id: "original-task", description: "Finish supported work" }],
		closure: "open-ended" };
	const checkpoint = { version: 1, kind: "original-objective-progress", contract,
		objectiveOutcome: "incomplete", stopReason: "bounded-run-incomplete",
		assessmentHistory: [], selectedArtifacts: ["candidate.cpp", "verification.json", "workflow-archive.json"],
		availableArtifacts: ["candidate.cpp", "verification.json", "workflow-archive.json"],
		boundedRuns: [
			{ runId: "accepted-goal", outcome: "fulfilled", selectedTaskId: "T001",
				acceptedTaskIds: ["T001"], unresolvedOperationIds: [] },
			{ runId: "old-goal", outcome: "active", acceptedTaskIds: [], unresolvedOperationIds: ["O002"] },
		], continuation: { mode: "reconcile-operations-before-new-run", unresolvedOperationIds: [unknown],
			unresolvedObligations: ["original-task"], unresolvedDetails: ["Unfinished"],
			requiresOriginalInputs: true, requiresBudgetAdmission: true,
			requiresOperationReconciliation: true } };
	const bundle: Record<string, string> = {
		"original-objective.json": JSON.stringify(contract),
		"objective-checkpoint.json": JSON.stringify(checkpoint),
		"candidate.cpp": "old accepted source",
		"verification.json": JSON.stringify({ version: 1, status: "passed" }),
		"workflow-archive.json": JSON.stringify({ version: 1, goalRunId: "accepted-goal",
			taskId: "T001", reviewStatus: "accepted" }),
	};
	const proof = Object.freeze({ id: "runtime-branded-proof" });
	const facts: AuthenticatedRestartCarryFacts = {
		source: { runId: "completed-job", runAttempt: 1, commit: sourceCommit },
		currentRun: { runId: "new-job", runAttempt: 1, commit: "b".repeat(40) },
		envelopeSha256: hash("authenticated envelope"), privateBundleSha256: bundleHash(bundle),
		terminal: { state: "terminal", sourceRunId: "completed-job", sourceRunAttempt: 1,
			observationDigest: hash("independently observed terminal job"), observedAt: "2026-10-06T09:00:00Z" },
		resultArtifact: { immutableRef: "artifact:completed-job:encrypted-output:123",
			digestScope: "artifact-archive", sha256: hash("ciphertext-archive") },
		committedNano: 25_000_000_000, unknownHeldNano: 3_000_000_000,
	};
	const campaignRoot = path.join("/tmp", "mulpis-private-campaign-synthetic-restart");
	const workspaceRoot = path.join(campaignRoot, "workspace");
	const input: IndependentRestartInput = { authenticatedCarryProof: proof, privateBundle: bundle,
		unobservedControlDeliveries: [],
		freshWorkspace: { workspaceId: path.basename(campaignRoot), restartNonce: "fresh-nonce" },
		freshBoundary: { campaignRoot, workspaceRoot,
			storeRoot: path.join(workspaceRoot, ".agent", "knowledge"),
			storeEmpty: true, sessionCensusEmpty: true,
			sessionMode: "no-prior-session-resume", grantProfile: "private-confined-read-dir",
			externalWriteTools: false, sharedStore: false, selectedRevalidated: true },
		failedHistory: { state: "unavailable", reason: "Encrypted prior outcome cannot be read by this runner",
			immutableArtifactRef: facts.resultArtifact!.immutableRef,
			digestScope: facts.resultArtifact!.digestScope,
			artifactSha256: facts.resultArtifact!.sha256 } };
	const claims = new Set<string>();
	const policy: ReviewedRestartEffectPolicy = { sourceCommit, policyId: "reviewed-commit-policy",
		policySha256: hash("reviewed immutable source"),
		operationAttestations: [{ operationRef: unknown, sourceCommit,
			evidenceSha256: hash("reviewed exact operation policy") }],
		effectClass: "historical-unknown-fresh-only", unknownBillingHeld: true,
		actorThirdPartyMutations: "unknown", hostTransport: "immutable-versioned-archive",
		accountingObservation: { historicalCommittedNano: facts.committedNano,
			historicalUnknownHeldNano: facts.unknownHeldNano, settledNano: 0,
			unknownObservedNano: 0, unpricedRequestCount: 0, opaqueUnquantifiedRunCount: 0 },
		unobservedControlLineage: { priorSource: { ...facts.source },
			admissionSource: { ...facts.currentRun }, count: 0, sha256: hash("[]") } };
	const host: IndependentRestartHost<typeof proof> = {
		authenticatedFacts: value => value === proof ? facts : undefined,
		reviewEffects: async () => policy,
		revalidateSelection: async ({ tupleSha256 }) => ({ status: "passed", contractId: contract.id,
			selectedRunId: "accepted-goal", selectedTaskId: "T001", tupleSha256,
			currentValidationSha256: hash("fresh independent checker pass") }),
		commitOneUse: async receipt => {
			if (claims.has(receipt.reuseKey)) throw new Error("reused receipt");
			claims.add(receipt.reuseKey);
			return { receiptRef: `sealed:${receipt.reuseKey}`, receiptSha256: hash(JSON.stringify(receipt)),
				claim: { claimId: "claim-1", priorEnvelopeSha256: facts.envelopeSha256,
					currentRunId: facts.currentRun.runId, currentRunAttempt: facts.currentRun.runAttempt,
					currentCommit: facts.currentRun.commit, currentJobId: "job-2" } };
		},
	};
	return { input, host, facts, policy, proof, claims, checkpointText: bundle["objective-checkpoint.json"] };
}

function controlOnlyFixture(controlCommit = "c".repeat(40)) {
	const f = fixture();
	f.facts.currentRun.runId = "12345";
	const checkpoint = JSON.parse(f.input.privateBundle["objective-checkpoint.json"]);
	checkpoint.boundedRuns[1].unresolvedOperationIds = [];
	checkpoint.continuation.unresolvedOperationIds = [];
	checkpoint.continuation.requiresOperationReconciliation = false;
	f.input.privateBundle["objective-checkpoint.json"] = JSON.stringify(checkpoint);
	f.facts.privateBundleSha256 = bundleHash(f.input.privateBundle);
	const delivery = { version: 1 as const, kind: "unobserved-control-delivery" as const,
		controlCommit, testedSourceCommit: "d".repeat(40), testedSourceTree: "e".repeat(40),
		previousControlParent: null, admittedBy: { ...f.facts.currentRun, runNumber: 2 },
		observedRunsAtAdmission: 0 as const, effects: "unknown-unreconciled" as const,
		accounting: "unquantified" as const };
	f.input.unobservedControlDeliveries = [delivery];
	f.policy.operationAttestations = [];
	f.policy.unobservedControlLineage = { priorSource: { ...f.facts.source },
		admissionSource: { ...f.facts.currentRun }, count: 1, sha256: hash(JSON.stringify([delivery])) };
	return { ...f, delivery };
}

test("control-only UNKNOWN reserves, claims, and seals fresh goal without settling effects", async () => {
	const f = controlOnlyFixture();
	const admission = await reserveIndependentRestart(f.input, f.host);
	assert.deepEqual(admission.quarantinedOperationRefs, []);
	assert.equal(admission.receipt.quarantine.unobservedControlLineage.count, 1);
	assert.equal(admission.receipt.quarantine.unobservedControlLineage.sha256,
		hash(JSON.stringify([f.delivery])));
	assert.equal(admission.receipt.quarantine.historicalEffectState, "unknown-unreconciled");
	assert.equal(admission.receipt.prior.accountingObservation.opaqueUnquantifiedRunCount, 0);
	assert.equal(admission.receipt.prior.unknownHeldNano, f.facts.unknownHeldNano);
	const bound = await bindIndependentRestartGoal(admission, "fresh-control-goal", async binding =>
		({ bindingRef: "sealed:fresh-control-goal", bindingSha256: hash(JSON.stringify(binding)) }));
	assert.equal(bound.binding.goalRunId, "fresh-control-goal");
	await assert.rejects(reserveIndependentRestart(f.input, f.host), /reused receipt/);
});

test("missing or altered control delivery cannot use the authenticated review", async () => {
	const missing = controlOnlyFixture();
	await assert.rejects(reserveIndependentRestart({ ...missing.input,
		unobservedControlDeliveries: [] }, missing.host), /source-policy review/);
	const altered = controlOnlyFixture();
	await assert.rejects(reserveIndependentRestart({ ...altered.input,
		unobservedControlDeliveries: [{ ...altered.delivery,
			controlCommit: "f".repeat(40) }] }, altered.host), /source-policy review/);
});

test("control lineage contributes distinct reuse identity for repeated fresh chains", async () => {
	const first = controlOnlyFixture("c".repeat(40));
	const second = controlOnlyFixture("f".repeat(40));
	const a = await reserveIndependentRestart(first.input, first.host);
	const b = await reserveIndependentRestart(second.input, second.host);
	assert.notEqual(a.receipt.reuseKey, b.receipt.reuseKey);
	assert.notEqual(a.receipt.quarantine.unobservedControlLineage.sha256,
		b.receipt.quarantine.unobservedControlLineage.sha256);
});

test("independent restart seals a one-use quarantine and preserves unknown old state and cost", async () => {
	const f = fixture();
	const admission = await reserveIndependentRestart(f.input, f.host);
	assert.deepEqual(admission.quarantinedOperationRefs, [unknown]);
	assert.equal(admission.receipt.quarantine.operationOutcome, "unknown");
	assert.equal(admission.receipt.quarantine.selectedFromFailedAttempt, false);
	assert.equal(admission.receipt.quarantine.failedHistory.state, "unavailable");
	assert.equal(admission.receipt.prior.unknownHeldNano, 3_000_000_000);
	assert.equal(admission.receipt.prior.committedNano, 25_000_000_000);
	assert.equal(admission.receipt.prior.selectedRunId, "accepted-goal");
	assert.equal(admission.receipt.version, 2);
	assert.equal(admission.receipt.quarantine.executionMode, "fresh-work-only");
	assert.equal(admission.receipt.quarantine.historicalEffectState, "unknown-unreconciled");
	assert.equal(admission.receipt.freshWorkspace.workspaceId, "mulpis-private-campaign-synthetic-restart");
	assert.equal(f.input.privateBundle["objective-checkpoint.json"], f.checkpointText);
	const bound = await bindIndependentRestartGoal(admission, "fresh-goal", async binding =>
		({ bindingRef: "sealed:fresh-goal", bindingSha256: hash(JSON.stringify(binding)) }));
	assert.equal(bound.binding.goalRunId, "fresh-goal");
	await assert.rejects(bindIndependentRestartGoal(admission, "second-goal", async () =>
		({ bindingRef: "ref", bindingSha256: hash("other") })), /already bound/);
	await assert.rejects(reserveIndependentRestart(f.input, f.host), /reused receipt/);
});

test("fresh-only admission requires an empty local store and no prior session replay", async () => {
	for (const changed of [
		{ storeEmpty: false }, { sessionCensusEmpty: false },
		{ sessionMode: "resume-prior-session" }, { externalWriteTools: true },
		{ sharedStore: true }, { selectedRevalidated: false },
	]) {
		const f = fixture();
		f.input.freshBoundary = { ...f.input.freshBoundary, ...changed } as typeof f.input.freshBoundary;
		await assert.rejects(reserveIndependentRestart(f.input, f.host), /fresh-only workspace/);
		assert.equal(f.claims.size, 0);
	}
});

test("zero historical unknown fee is allowed while the unknown operation remains quarantined", async () => {
	const f = fixture();
	f.facts.unknownHeldNano = 0;
	f.policy.accountingObservation.historicalUnknownHeldNano = 0;
	const receipt = await reserveIndependentRestart(f.input, f.host);
	assert.equal(receipt.receipt.prior.unknownHeldNano, 0);
	assert.deepEqual(receipt.receipt.quarantine.operationRefs, [unknown]);
});

test("an authenticated opaque gap permits fresh work with no M07 operation refs", async () => {
	const f = fixture();
	const checkpoint = JSON.parse(f.input.privateBundle["objective-checkpoint.json"]);
	checkpoint.boundedRuns[1].unresolvedOperationIds = [];
	checkpoint.continuation.unresolvedOperationIds = [];
	checkpoint.continuation.requiresOperationReconciliation = false;
	f.input.privateBundle["objective-checkpoint.json"] = JSON.stringify(checkpoint);
	f.facts.privateBundleSha256 = bundleHash(f.input.privateBundle);
	f.policy.operationAttestations = [];
	f.policy.accountingObservation.opaqueUnquantifiedRunCount = 1;
	const reservation = await reserveIndependentRestart(f.input, f.host);
	assert.deepEqual(reservation.receipt.quarantine.operationRefs, []);
	assert.equal(reservation.receipt.prior.accountingObservation.opaqueUnquantifiedRunCount, 1);
	const forged = fixture();
	const forgedCheckpoint = JSON.parse(forged.input.privateBundle["objective-checkpoint.json"]);
	forgedCheckpoint.boundedRuns[1].unresolvedOperationIds = [];
	forgedCheckpoint.continuation.unresolvedOperationIds = [];
	forged.input.privateBundle["objective-checkpoint.json"] = JSON.stringify(forgedCheckpoint);
	forged.facts.privateBundleSha256 = bundleHash(forged.input.privateBundle);
	forged.policy.operationAttestations = [];
	await assert.rejects(reserveIndependentRestart(forged.input, forged.host), /source-policy review/);
});

test("expired result archive binds the AEAD carry without inventing an archive digest", async () => {
	const f = fixture();
	f.facts.resultArtifact = undefined;
	f.policy.hostTransport = "none";
	f.input.failedHistory = { state: "result-unavailable", reason: "result artifact expired",
		carrySource: { ...f.facts.source }, carryEnvelopeSha256: f.facts.envelopeSha256 };
	const reservation = await reserveIndependentRestart(f.input, f.host);
	assert.equal(reservation.receipt.quarantine.failedHistory.state, "result-unavailable");
	const forged = fixture();
	forged.facts.resultArtifact = undefined;
	forged.policy.hostTransport = "none";
	forged.input.failedHistory = { state: "result-unavailable", reason: "result artifact expired",
		carrySource: { ...forged.facts.source }, carryEnvelopeSha256: hash("wrong carry") };
	await assert.rejects(reserveIndependentRestart(forged.input, forged.host),
		/expired result history must bind/);
});

test("a historical confinement claim cannot mint a fresh-only receipt", async () => {
	const f = fixture();
	f.policy.effectClass = "confined-ephemeral-local" as ReviewedRestartEffectPolicy["effectClass"];
	await assert.rejects(reserveIndependentRestart(f.input, f.host), /source-policy review/);
	assert.equal(f.claims.size, 0);
});

test("unbranded proof, live run, and tampered authenticated bundle fail before commit", async () => {
	const unbranded = fixture();
	await assert.rejects(reserveIndependentRestart({ ...unbranded.input,
		authenticatedCarryProof: { id: "runtime-branded-proof" } }, unbranded.host), /not runtime authenticated/);
	assert.equal(unbranded.claims.size, 0);

	const live = fixture();
	live.facts.terminal = { ...live.facts.terminal, state: "running" as "terminal" };
	await assert.rejects(reserveIndependentRestart(live.input, live.host), /not independently proven terminal/);
	assert.equal(live.claims.size, 0);

	const tampered = fixture();
	tampered.input.privateBundle["candidate.cpp"] = "unreviewed replacement";
	await assert.rejects(reserveIndependentRestart(tampered.input, tampered.host), /bundle binding is invalid/);
	assert.equal(tampered.claims.size, 0);
});

test("unchecked effect, omitted unknown, and failed fresh selection cannot admit", async () => {
	const unchecked = fixture();
	unchecked.policy.operationAttestations = [];
	await assert.rejects(reserveIndependentRestart(unchecked.input, unchecked.host), /does not cover every unknown effect/);
	assert.equal(unchecked.claims.size, 0);

	const omitted = fixture();
	const cp = JSON.parse(omitted.input.privateBundle["objective-checkpoint.json"]);
	cp.continuation.unresolvedOperationIds = [];
	omitted.input.privateBundle["objective-checkpoint.json"] = JSON.stringify(cp);
	omitted.facts.privateBundleSha256 = bundleHash(omitted.input.privateBundle);
	await assert.rejects(reserveIndependentRestart(omitted.input, omitted.host),
		/qualified continuation operations do not exactly match historical bounded runs/);
	assert.equal(omitted.claims.size, 0);

	const failed = fixture();
	failed.host.revalidateSelection = async ({ tupleSha256 }) => ({ status: "passed",
		contractId: "wrong-contract", selectedRunId: "accepted-goal", selectedTaskId: "T001",
		tupleSha256, currentValidationSha256: hash("pass") });
	await assert.rejects(reserveIndependentRestart(failed.input, failed.host), /not independently revalidated/);
	assert.equal(failed.claims.size, 0);
});

test("receipt must bind a distinct goal and an immutable unread-history reference", async () => {
	const sameGoal = fixture();
	const reserved = await reserveIndependentRestart(sameGoal.input, sameGoal.host);
	await assert.rejects(bindIndependentRestartGoal(reserved, "old-goal", async () =>
		({ bindingRef: "ref", bindingSha256: hash("unused") })), /aliases historical identity/);

	const gap = fixture();
	if (gap.input.failedHistory.state !== "unavailable") throw new Error("fixture mismatch");
	gap.input.failedHistory.artifactSha256 = "";
	await assert.rejects(reserveIndependentRestart(gap.input, gap.host), /authenticated result artifact/);

	const falseReceipt = fixture();
	falseReceipt.host.commitOneUse = async () => ({ receiptRef: "ref", receiptSha256: hash("other receipt"),
		claim: { claimId: "claim", priorEnvelopeSha256: falseReceipt.facts.envelopeSha256,
			currentRunId: falseReceipt.facts.currentRun.runId,
			currentRunAttempt: falseReceipt.facts.currentRun.runAttempt,
			currentCommit: falseReceipt.facts.currentRun.commit, currentJobId: "job" } });
	await assert.rejects(reserveIndependentRestart(falseReceipt.input, falseReceipt.host), /one-use receipt was not verified/);
});

test("goal binding rejects a mutated reservation and an invented reservation", async () => {
	const f = fixture();
	const admission = await reserveIndependentRestart(f.input, f.host);
	admission.receipt.prior.unknownHeldNano = 0;
	await assert.rejects(bindIndependentRestartGoal(admission, "fresh-goal", async () =>
		({ bindingRef: "ref", bindingSha256: hash("unused") })), /changed after its host claim/);
	const invented = { ...admission, receipt: { ...admission.receipt } };
	await assert.rejects(bindIndependentRestartGoal(invented, "fresh-goal", async () =>
		({ bindingRef: "ref", bindingSha256: hash("unused") })), /reservation is absent/);
});

test("a later independent restart retains both historical and newly unknown operations", async () => {
	const first = fixture();
	const old = await reserveIndependentRestart(first.input, first.host);
	const second = fixture();
	const checkpoint = JSON.parse(second.input.privateBundle["objective-checkpoint.json"]);
	checkpoint.boundedRuns.push({ runId: "newly-ended-goal", outcome: "active", acceptedTaskIds: [],
		unresolvedOperationIds: ["O005"] });
	checkpoint.continuation.unresolvedOperationIds.push("O005", "newly-ended-goal/O005");
	second.input.privateBundle["objective-checkpoint.json"] = JSON.stringify(checkpoint);
	second.input.privateBundle["independent-restart-quarantine.json"] = JSON.stringify(old.receipt);
	second.facts.privateBundleSha256 = bundleHash(second.input.privateBundle);
	second.facts.source = { runId: "second-completed-job", runAttempt: 1, commit: "c".repeat(40) };
	second.facts.currentRun = { runId: "third-job", runAttempt: 1, commit: "d".repeat(40) };
	second.facts.terminal.sourceRunId = second.facts.source.runId;
	second.policy.sourceCommit = second.facts.source.commit;
	second.policy.unobservedControlLineage = { priorSource: { ...second.facts.source },
		admissionSource: { ...second.facts.currentRun }, count: 0, sha256: hash("[]") };
	second.policy.operationAttestations = [
		{ operationRef: unknown, sourceCommit, evidenceSha256: hash(JSON.stringify(old.receipt)) },
		{ operationRef: "newly-ended-goal/O005", sourceCommit: second.facts.source.commit,
			evidenceSha256: hash("second reviewed source policy") },
	];
	const later = await reserveIndependentRestart(second.input, second.host);
	assert.deepEqual(later.quarantinedOperationRefs, ["newly-ended-goal/O005", unknown]);
	assert.notEqual(later.receipt.reuseKey, old.receipt.reuseKey);
	assert.deepEqual(later.receipt.quarantine.legacyQualifiedAliases,
		[{ bareOperationId: "O005", qualifiedOperationRef: "newly-ended-goal/O005" }]);
	assert.deepEqual(later.receipt.quarantine.historicalGoalOutcomes.map(item => item.outcome),
		["fulfilled", "active", "active"]);
	assert.equal(JSON.parse(second.input.privateBundle["objective-checkpoint.json"])
		.continuation.unresolvedOperationIds.length, 3);
});

test("duplicate or absent operation references fail closed", async () => {
	const duplicate = fixture();
	const cp = JSON.parse(duplicate.input.privateBundle["objective-checkpoint.json"]);
	cp.continuation.unresolvedOperationIds.push(unknown);
	duplicate.input.privateBundle["objective-checkpoint.json"] = JSON.stringify(cp);
	duplicate.facts.privateBundleSha256 = bundleHash(duplicate.input.privateBundle);
	await assert.rejects(reserveIndependentRestart(duplicate.input, duplicate.host),
		/missing, duplicated, or hidden/);
	const absent = fixture();
	const noOperation = JSON.parse(absent.input.privateBundle["objective-checkpoint.json"]);
	noOperation.boundedRuns[1].unresolvedOperationIds = [];
	noOperation.continuation.unresolvedOperationIds = [];
	absent.input.privateBundle["objective-checkpoint.json"] = JSON.stringify(noOperation);
	absent.facts.privateBundleSha256 = bundleHash(absent.input.privateBundle);
	await assert.rejects(reserveIndependentRestart(absent.input, absent.host),
		/source-policy review does not cover every unknown effect/);
});

test("legacy bare alias requires the exact qualified ref and one active origin", async () => {
	const missingQualified = fixture();
	const noQualified = JSON.parse(missingQualified.input.privateBundle["objective-checkpoint.json"]);
	noQualified.continuation.unresolvedOperationIds = ["O002"];
	missingQualified.input.privateBundle["objective-checkpoint.json"] = JSON.stringify(noQualified);
	missingQualified.facts.privateBundleSha256 = bundleHash(missingQualified.input.privateBundle);
	await assert.rejects(reserveIndependentRestart(missingQualified.input, missingQualified.host),
		/bare operation lacks one active, qualified historical origin/);

	const ambiguous = fixture();
	const ambiguousCheckpoint = JSON.parse(ambiguous.input.privateBundle["objective-checkpoint.json"]);
	ambiguousCheckpoint.boundedRuns.push({ runId: "another-active-goal", outcome: "active",
		unresolvedOperationIds: ["O002"] });
	ambiguousCheckpoint.continuation.unresolvedOperationIds =
		[unknown, "another-active-goal/O002", "O002"];
	ambiguous.input.privateBundle["objective-checkpoint.json"] = JSON.stringify(ambiguousCheckpoint);
	ambiguous.facts.privateBundleSha256 = bundleHash(ambiguous.input.privateBundle);
	await assert.rejects(reserveIndependentRestart(ambiguous.input, ambiguous.host),
		/bare operation lacks one active, qualified historical origin/);

	const contradictory = fixture();
	const conflictingCheckpoint = JSON.parse(contradictory.input.privateBundle["objective-checkpoint.json"]);
	conflictingCheckpoint.continuation.unresolvedOperationIds.push("other-goal/O777");
	contradictory.input.privateBundle["objective-checkpoint.json"] = JSON.stringify(conflictingCheckpoint);
	contradictory.facts.privateBundleSha256 = bundleHash(contradictory.input.privateBundle);
	await assert.rejects(reserveIndependentRestart(contradictory.input, contradictory.host),
		/absent from historical bounded runs/);
});
