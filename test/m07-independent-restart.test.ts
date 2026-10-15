import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import path from "node:path";
import test from "node:test";
import { bindIndependentRestartGoal, reserveIndependentRestart, type AuthenticatedRestartCarryFacts, type IndependentRestartHost, type IndependentRestartInput, type ReviewedRestartEffectPolicy } from "../src/m07/independent-restart.ts";

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
