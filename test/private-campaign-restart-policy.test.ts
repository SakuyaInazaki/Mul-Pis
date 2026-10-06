import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { AuthenticatedRestartCarryFacts } from "../src/m07/independent-restart.ts";
import { PRIOR_REVIEWED_POLICY_SHA256, reviewOneTimeLegacyV3Effects,
	reviewPrivateCampaignRestartEffects, offlineRestartPolicyChecks } from
	"../src/runner/private-campaign-restart-policy.ts";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const oldCommit = "2fe7f132370b4598c942625fad1a7e9129978eaa";
const currentCommit = "242bb0c205ef0d6fb0bf76dd53a2c3d62e55ef66";
const inheritedOnlyCommit = "2efc466b42757bfdc33a8c21ab053f2e786abf14";
const lengthSettledCommit = "fafd5051e18f4f10a5897cf507c49d92641384d3";
const oldRef = "earlier-goal/O002";
const newRef = "latest-goal/O001";

function fixture() {
	const proof = Object.freeze({ opaque: true });
	const facts: AuthenticatedRestartCarryFacts = {
		source: { runId: "latest-job", runAttempt: 1, commit: currentCommit },
		currentRun: { runId: "next-job", runAttempt: 1, commit: "f".repeat(40) },
		envelopeSha256: hash("latest carry"), privateBundleSha256: hash("bundle"),
		terminal: { state: "terminal", sourceRunId: "latest-job", sourceRunAttempt: 1,
			observationDigest: hash("terminal job"), observedAt: "2026-10-06T10:00:00Z" },
		resultArtifact: { immutableRef: "immutable-result-artifact", digestScope: "github-artifact-archive",
			sha256: hash("artifact archive") },
		committedNano: 20_000_000_000, unknownHeldNano: 2_000_000_000,
	};
	const receipt = { version: 1, kind: "host-independent-goal-quarantine",
		prior: { source: { runId: "earlier-job", runAttempt: 1, commit: oldCommit },
			envelopeSha256: hash("earlier carry"), contractId: "original-contract",
			reviewedPolicyId: "mul-pis-legacy-confined-private-campaign-v1",
			reviewedPolicySha256: PRIOR_REVIEWED_POLICY_SHA256,
			unknownHeldNano: 2_000_000_000, committedNano: 19_000_000_000 },
		quarantine: { operationRefs: [oldRef], operationOutcome: "unknown",
			selectedFromFailedAttempt: false },
		freshWorkspace: { workspaceId: "latest-workspace", restartNonce: "nonce" } };
	const claim = { claimId: "claimed", currentJobId: "job-id",
		priorEnvelopeSha256: receipt.prior.envelopeSha256,
		currentRunId: facts.source.runId, currentRunAttempt: facts.source.runAttempt,
		currentCommit: facts.source.commit };
	const binding = { version: 1, kind: "host-independent-goal-binding",
		quarantineReceiptSha256: hash(JSON.stringify(receipt)),
		freshWorkspace: { ...receipt.freshWorkspace }, goalRunId: "latest-goal" };
	const checkpoint = { contract: { id: "original-contract" }, boundedRuns: [
		{ runId: "earlier-goal", outcome: "active", unresolvedOperationIds: ["O002"] },
		{ runId: "latest-goal", outcome: "active", unresolvedOperationIds: ["O001"] },
	] };
	const bundle: Record<string, string> = {
		"objective-checkpoint.json": JSON.stringify(checkpoint),
		"independent-restart-quarantine.json": JSON.stringify({ version: 1,
			kind: "host-independent-restart-reservations", entries: [{ receipt, claim }] }),
		"independent-restart-goal-binding.json": JSON.stringify({ version: 1,
			kind: "host-independent-restart-goal-bindings", entries: [binding] }),
	};
	let ancestor = true;
	const input = { facts, operationRefs: [oldRef, newRef], privateBundle: bundle, proof,
		authenticatedBundle: (value: unknown, given: unknown) => value === proof && given === bundle,
		bindsAncestor: (value: unknown, source: { runId: string; runAttempt: number; commit: string },
			digest: string) => ancestor && value === proof && source.runId === receipt.prior.source.runId &&
			source.runAttempt === receipt.prior.source.runAttempt && source.commit === oldCommit &&
			digest === receipt.prior.envelopeSha256 };
	return { input, facts, bundle, receipt, claim, binding, checkpoint, setAncestor: (value: boolean) => { ancestor = value; } };
}

function inheritedOnlyFixture() {
	const f = fixture();
	const precedingPolicy = reviewPrivateCampaignRestartEffects(f.input);
	const firstReservations = JSON.parse(f.bundle["independent-restart-quarantine.json"]).entries;
	const firstBindings = JSON.parse(f.bundle["independent-restart-goal-binding.json"]).entries;
	const source = { ...f.facts.source };
	const secondReceipt = { version: 1, kind: "host-independent-goal-quarantine",
		prior: { source, envelopeSha256: f.facts.envelopeSha256,
			contractId: "original-contract", reviewedPolicyId: precedingPolicy.policyId,
			reviewedPolicySha256: precedingPolicy.policySha256,
			unknownHeldNano: f.facts.unknownHeldNano, committedNano: f.facts.committedNano },
		quarantine: { operationRefs: [oldRef, newRef], operationOutcome: "unknown",
			selectedFromFailedAttempt: false },
		freshWorkspace: { workspaceId: "third-workspace", restartNonce: "third-nonce" } };
	f.facts.source = { runId: "third-job", runAttempt: 1, commit: inheritedOnlyCommit };
	f.facts.committedNano += 100_000_000;
	const secondClaim = { claimId: "claim-third", currentJobId: "job-third",
		priorEnvelopeSha256: secondReceipt.prior.envelopeSha256,
		currentRunId: f.facts.source.runId, currentRunAttempt: f.facts.source.runAttempt,
		currentCommit: f.facts.source.commit };
	const secondBinding = { version: 1, kind: "host-independent-goal-binding",
		quarantineReceiptSha256: hash(JSON.stringify(secondReceipt)),
		freshWorkspace: { ...secondReceipt.freshWorkspace }, goalRunId: "partial-new-goal" };
	f.checkpoint.boundedRuns.push({ runId: "partial-new-goal", outcome: "partial",
		unresolvedOperationIds: [] });
	f.bundle["objective-checkpoint.json"] = JSON.stringify(f.checkpoint);
	f.bundle["independent-restart-quarantine.json"] = JSON.stringify({ version: 1,
		kind: "host-independent-restart-reservations",
		entries: [...firstReservations, { receipt: secondReceipt, claim: secondClaim }] });
	f.bundle["independent-restart-goal-binding.json"] = JSON.stringify({ version: 1,
		kind: "host-independent-restart-goal-bindings", entries: [...firstBindings, secondBinding] });
	f.bundle["research-history.json"] = JSON.stringify({ version: 1,
		kind: "untrusted-version-bound-research-history", entries: [{ goalRunId: secondBinding.goalRunId,
			files: { "workflow-archive.json": JSON.stringify({ version: 1,
				kind: "m07-private-candidate-archive", goalRunId: secondBinding.goalRunId,
				goalOutcome: "partial", taskStatus: "failed", loopStopReason: "budget-boundary",
				m04: { state: "not-run" }, controllerEvidence: { reviewStatus: "unreviewed", operationOutcomes: [{
					operationId: "O001", status: "partial-settled",
					localStop: { settledProviderRequestCount: 1, rejectedBeforeTransport: true,
						stopReason: "total-cny-ceiling", effectScope: "factory-attested-confined-file-tools" },
				}] } }) } }] });
	f.input.bindsAncestor = (value, ancestor, envelope) => value === f.input.proof &&
		((ancestor.runId === f.receipt.prior.source.runId &&
			ancestor.runAttempt === f.receipt.prior.source.runAttempt &&
			ancestor.commit === f.receipt.prior.source.commit &&
			envelope === f.receipt.prior.envelopeSha256) ||
			(ancestor.runId === source.runId && ancestor.runAttempt === source.runAttempt &&
				ancestor.commit === source.commit && envelope === secondReceipt.prior.envelopeSha256));
	return { ...f, secondReceipt, secondClaim, secondBinding };
}

function lengthSettledFixture() {
	const f = inheritedOnlyFixture();
	const prefix = reviewPrivateCampaignRestartEffects(f.input);
	const prior = { ...f.facts.source };
	const priorEnvelope = hash("third carry");
	const thirdReceipt = { version: 1, kind: "host-independent-goal-quarantine",
		prior: { source: prior, envelopeSha256: priorEnvelope,
			contractId: "original-contract", reviewedPolicyId: prefix.policyId,
			reviewedPolicySha256: prefix.policySha256,
			unknownHeldNano: f.facts.unknownHeldNano,
			committedNano: f.facts.committedNano },
		quarantine: { operationRefs: [oldRef, newRef], operationOutcome: "unknown",
			selectedFromFailedAttempt: false },
		freshWorkspace: { workspaceId: "fourth-workspace", restartNonce: "fourth-nonce" } };
	f.facts.source = { runId: "fourth-job", runAttempt: 1, commit: lengthSettledCommit };
	f.facts.committedNano += 500_000_000;
	const thirdClaim = { claimId: "claim-fourth", currentJobId: "job-fourth",
		priorEnvelopeSha256: priorEnvelope, currentRunId: f.facts.source.runId,
		currentRunAttempt: 1, currentCommit: lengthSettledCommit };
	const thirdBinding = { version: 1, kind: "host-independent-goal-binding",
		quarantineReceiptSha256: hash(JSON.stringify(thirdReceipt)),
		freshWorkspace: { ...thirdReceipt.freshWorkspace }, goalRunId: "length-goal" };
	f.checkpoint.boundedRuns.push({ runId: "length-goal", outcome: "partial", unresolvedOperationIds: [] });
	f.bundle["objective-checkpoint.json"] = JSON.stringify(f.checkpoint);
	const reservations = JSON.parse(f.bundle["independent-restart-quarantine.json"]).entries;
	reservations.push({ receipt: thirdReceipt, claim: thirdClaim });
	f.bundle["independent-restart-quarantine.json"] = JSON.stringify({ version: 1,
		kind: "host-independent-restart-reservations", entries: reservations });
	const bindings = JSON.parse(f.bundle["independent-restart-goal-binding.json"]).entries;
	bindings.push(thirdBinding);
	f.bundle["independent-restart-goal-binding.json"] = JSON.stringify({ version: 1,
		kind: "host-independent-restart-goal-bindings", entries: bindings });
	const history = JSON.parse(f.bundle["research-history.json"]);
	const archive = { version: 1, kind: "m07-private-candidate-archive",
		goalRunId: "length-goal", goalOutcome: "partial", taskStatus: "failed",
		loopStopReason: "output-limit", m04: { state: "not-run" },
		controllerEvidence: { reviewStatus: "unreviewed", operationOutcomes: [{
			operationId: "O001", status: "terminal-response-incomplete",
			terminalResponse: { settledProviderRequestCount: 2, responseReceived: true,
				terminalStopReason: "length", taskComplete: false,
				effectScope: "factory-attested-confined-file-tools" },
		}] } };
	history.entries.push({ goalRunId: "length-goal",
		files: { "workflow-archive.json": JSON.stringify(archive) } });
	f.bundle["research-history.json"] = JSON.stringify(history);
	const originalBind = f.input.bindsAncestor;
	f.input.bindsAncestor = (proof, source, digest) => originalBind(proof, source, digest) ||
		(proof === f.input.proof && source.runId === prior.runId &&
			source.runAttempt === prior.runAttempt && source.commit === prior.commit &&
			digest === priorEnvelope);
	return { ...f, thirdReceipt, thirdClaim, thirdBinding, archive };
}

function oneTimeLegacyV3Fixture() {
	const f = lengthSettledFixture();
	f.checkpoint.boundedRuns.splice(-1, 0, { runId: "synthetic-prior-goal",
		outcome: "partial", unresolvedOperationIds: [] });
	(f.thirdReceipt.quarantine as typeof f.thirdReceipt.quarantine & {
		historicalGoalOutcomes?: Array<{ runId: string; outcome: string }> }).historicalGoalOutcomes =
		f.checkpoint.boundedRuns.slice(0, -1).map(row => ({ runId: row.runId, outcome: row.outcome }));
	f.thirdBinding.quarantineReceiptSha256 = hash(JSON.stringify(f.thirdReceipt));
	const sealedReservations = JSON.parse(f.bundle["independent-restart-quarantine.json"]);
	sealedReservations.entries[2].receipt = f.thirdReceipt;
	f.bundle["independent-restart-quarantine.json"] = JSON.stringify(sealedReservations);
	const sealedBindings = JSON.parse(f.bundle["independent-restart-goal-binding.json"]);
	sealedBindings.entries[2] = f.thirdBinding;
	f.bundle["independent-restart-goal-binding.json"] = JSON.stringify(sealedBindings);
	const origin = { source: { ...f.facts.source, runNumber: 4 }, envelopeSha256: f.facts.envelopeSha256,
		historicalCommittedNano: f.facts.committedNano,
		historicalUnknownHeldNano: f.facts.unknownHeldNano };
	const immediateZeroActivitySource = { source: { runId: "37485015330", runAttempt: 1,
		runNumber: 5, commit: "1ca70ade2e2a7aa4d2655aca93ba806161e012b7" },
		envelopeSha256: hash("synthetic-zero-control-carry") };
	f.facts.source = { runId: "37490692145", runAttempt: 1,
		commit: "f9d29bfd58449dba072c80f62a7db524f0a668c4" };
	const newGoal = { runId: "synthetic-unselected-goal", outcome: "active",
		acceptedTaskIds: [] as string[], unresolvedOperationIds: [] as string[] };
	const fourthReceipt = { version: 1, kind: "host-independent-goal-quarantine",
		prior: { source: { ...immediateZeroActivitySource.source },
			envelopeSha256: immediateZeroActivitySource.envelopeSha256,
			contractId: "original-contract",
			reviewedPolicyId: "mul-pis-v3-no-model-activity-carry-forward-v1",
			reviewedPolicySha256: hash("synthetic-reviewed-zero-policy"),
			unknownHeldNano: origin.historicalUnknownHeldNano,
			committedNano: origin.historicalCommittedNano },
		quarantine: { operationRefs: [oldRef, newRef], operationOutcome: "unknown",
			selectedFromFailedAttempt: false,
			historicalGoalOutcomes: f.checkpoint.boundedRuns.map(row => ({ runId: row.runId,
				outcome: row.outcome })) },
		freshWorkspace: { workspaceId: "synthetic-final-workspace", restartNonce: "synthetic-final-nonce" } };
	const fourthClaim = { claimId: "synthetic-final-claim", currentJobId: "synthetic-final-job",
		priorEnvelopeSha256: fourthReceipt.prior.envelopeSha256,
		currentRunId: f.facts.source.runId, currentRunAttempt: f.facts.source.runAttempt,
		currentCommit: f.facts.source.commit };
	const fourthBinding = { version: 1, kind: "host-independent-goal-binding",
		quarantineReceiptSha256: hash(JSON.stringify(fourthReceipt)),
		freshWorkspace: { ...fourthReceipt.freshWorkspace }, goalRunId: newGoal.runId };
	sealedReservations.entries.push({ receipt: fourthReceipt, claim: fourthClaim });
	sealedBindings.entries.push(fourthBinding);
	f.bundle["independent-restart-quarantine.json"] = JSON.stringify(sealedReservations);
	f.bundle["independent-restart-goal-binding.json"] = JSON.stringify(sealedBindings);
	const previousBindsAncestor = f.input.bindsAncestor;
	f.input.bindsAncestor = (proof, source, envelope) => previousBindsAncestor(proof, source, envelope) ||
		(proof === f.input.proof && source.runId === immediateZeroActivitySource.source.runId &&
			source.runAttempt === immediateZeroActivitySource.source.runAttempt &&
			source.commit === immediateZeroActivitySource.source.commit &&
			envelope === immediateZeroActivitySource.envelopeSha256);
	f.checkpoint.boundedRuns.push(newGoal);
	const checkpoint = { ...f.checkpoint, objectiveOutcome: "incomplete", boundedRuns: f.checkpoint.boundedRuns };
	f.bundle["objective-checkpoint.json"] = JSON.stringify(checkpoint);
	const history = JSON.parse(f.bundle["research-history.json"]);
	for (const [taskId, operationIds] of [["T001", ["O001", "O002", "O003", "O004"]],
		["T002", ["O005", "O006", "O007"]]] as const) {
		history.entries.push({ originalContractId: "original-contract", goalRunId: newGoal.runId,
			taskId, files: { "workflow-archive.json": JSON.stringify({ version: 1,
				kind: "m07-private-candidate-archive", goalRunId: newGoal.runId, taskId,
				goalOutcome: "active", taskStatus: "rejected", m04: { state: "not-run" },
				controllerEvidence: { reviewStatus: "rejected",
					operationOutcomes: operationIds.map(operationId => ({ operationId,
						status: "response-received" })) } }) } });
	}
	f.bundle["research-history.json"] = JSON.stringify(history);
	f.bundle["workflow-archive.json"] = JSON.stringify({ goalRunId: "earlier-goal",
		controllerEvidence: { reviewStatus: "accepted" } });
	const review = { origin, immediateZeroActivitySource,
		reviewedSourceCommit: "00d4309390bb06536abbe5e86f97213298e901a0" as const,
		settledAddedNano: 130_000_000, unknownObservedAddedNano: 0, unpricedAddedCount: 0,
		requestAudit: { version: 3 as const, kind: "accounting-only-request-audit" as const,
			requests: Array.from({ length: 130 }, (_, index) => ({ requestId: `synthetic-${index}`,
				inputPayloadBytes: 40, status: "settled" as const, settledCny: 0.001,
				unknownObservedCny: null, reportedUsage: null })),
			settledCny: 0.13, unknownObservedCny: 0, unpricedRequestCount: 0 } };
	const reservations = JSON.parse(f.bundle["independent-restart-quarantine.json"]).entries;
	const bindings = JSON.parse(f.bundle["independent-restart-goal-binding.json"]).entries;
	return { ...f, origin, newGoal, checkpoint, history, review, reservations, bindings,
		check: () => reviewOneTimeLegacyV3Effects(f.input, review, checkpoint,
			reservations, bindings) };
}

function unknownTransportFixture() {
	const f = oneTimeLegacyV3Fixture();
	const priorSource = { ...f.facts.source };
	const priorPolicy = f.check();
	const selected = ["candidate.cpp", "verification.json", "workflow-archive.json"];
	f.bundle["candidate.cpp"] = "historically selected source";
	f.bundle["verification.json"] = "historically selected verification";
	const selectedTupleSha256 = hash(JSON.stringify(selected.slice().sort().map(name => ({ name,
		sha256: hash(f.bundle[name]), bytes: Buffer.byteLength(f.bundle[name], "utf8") }))));
	const priorEnvelope = hash("one-time source envelope");
	const newGoalId = "fresh-transport-goal";
	const fifthReceipt = { version: 1, kind: "host-independent-goal-quarantine",
		prior: { source: priorSource, envelopeSha256: priorEnvelope,
			contractId: "original-contract", reviewedPolicyId: priorPolicy.policyId,
			reviewedPolicySha256: priorPolicy.policySha256, selectedTupleSha256,
			unknownHeldNano: f.origin.historicalUnknownHeldNano,
			committedNano: f.origin.historicalCommittedNano },
		quarantine: { operationRefs: [oldRef, newRef], operationOutcome: "unknown",
			selectedFromFailedAttempt: false,
			historicalGoalOutcomes: f.checkpoint.boundedRuns.map(row => ({ runId: row.runId,
				outcome: row.outcome })) },
		freshWorkspace: { workspaceId: "fresh-unknown-workspace", restartNonce: "fresh-nonce" } };
	f.facts.source = { runId: "synthetic-transport-job", runAttempt: 1, commit: "a".repeat(40) };
	f.facts.committedNano = f.origin.historicalCommittedNano;
	f.facts.unknownHeldNano = f.origin.historicalUnknownHeldNano;
	const fifthClaim = { claimId: "fifth-claim", currentJobId: "fifth-job",
		priorEnvelopeSha256: priorEnvelope, currentRunId: f.facts.source.runId,
		currentRunAttempt: 1, currentCommit: f.facts.source.commit };
	const fifthBinding = { version: 1, kind: "host-independent-goal-binding",
		quarantineReceiptSha256: hash(JSON.stringify(fifthReceipt)),
		freshWorkspace: fifthReceipt.freshWorkspace, goalRunId: newGoalId };
	const reservationChain = JSON.parse(f.bundle["independent-restart-quarantine.json"]);
	reservationChain.entries.push({ receipt: fifthReceipt, claim: fifthClaim });
	f.bundle["independent-restart-quarantine.json"] = JSON.stringify(reservationChain);
	const bindingChain = JSON.parse(f.bundle["independent-restart-goal-binding.json"]);
	bindingChain.entries.push(fifthBinding);
	f.bundle["independent-restart-goal-binding.json"] = JSON.stringify(bindingChain);
	const checkpoint = { ...f.checkpoint, objectiveOutcome: "incomplete", selectedArtifacts: selected,
		boundedRuns: [...f.checkpoint.boundedRuns,
			{ runId: newGoalId, outcome: "active", selectedTaskId: null,
				acceptedTaskIds: [], unresolvedOperationIds: ["O001"] }] };
	f.bundle["objective-checkpoint.json"] = JSON.stringify(checkpoint);
	const archive = { version: 1, kind: "m07-private-candidate-archive",
		goalRunId: newGoalId, taskId: "T001", goalOutcome: "active", taskStatus: "failed",
		m04: { state: "not-run" }, controllerEvidence: { reviewStatus: "unreviewed",
			operationOutcomes: [{ operationId: "O001", status: "unknown" }] } };
	const history = JSON.parse(f.bundle["research-history.json"]);
	history.entries.push({ goalRunId: newGoalId, taskId: "T001",
		files: { "workflow-archive.json": JSON.stringify(archive) } });
	f.bundle["research-history.json"] = JSON.stringify(history);
	const sessionId = hash("synthetic-confined-session");
	const rows = Array.from({ length: 17 }, (_, index) => ({ requestId: `synthetic-transport-${index}`,
		sessionId, responseReceived: index < 16, status: index < 16 ? "settled" : "unknown",
		settledCny: index < 16 ? 0.001 : null,
		unknownObservedCny: index < 16 ? null : 0.25 }));
	const receipt = { version: 1, kind: "m07-host-effect-census", source: f.facts.source,
		priorEnvelopeSha256: hash("prior-carry"),
		historicalGoalRunIds: f.checkpoint.boundedRuns.map(row => row.runId),
		goals: [{ runId: newGoalId, outcome: "active",
			tasks: [{ taskId: "T001", mode: "execute", status: "failed", sessionId }],
			operations: [{ id: "O001", taskId: "T001", status: "unknown" }] }],
		sessions: [{ sessionId, kind: "confined-execution", goalRunId: newGoalId,
			taskId: "T001", workRoot: "/tmp/synthetic/fresh-task",
			grant: { version: 1, kind: "confined-campaign-files",
				root: "/tmp/synthetic/fresh-task",
				writableFiles: ["candidate.cpp", "lesson-delta.json"] } }],
		requestIds: rows.map(row => row.requestId) };
	f.input.operationRefs = [oldRef, newRef, `${newGoalId}/O001`];
	const evidence: any = { origin: f.origin, receipt,
		requestAudit: { version: 3, kind: "accounting-only-request-audit",
			requests: rows, settledCny: 0.016, unknownObservedCny: 0.25,
			unpricedRequestCount: 0 },
		reviewedEffectAncestry: [{ source: priorSource, envelopeSha256: priorEnvelope,
			privateBundleSha256: hash("prior bundle"), reviewedPolicySha256: priorPolicy.policySha256,
			selectedTupleSha256, historicalOriginEnvelopeSha256: f.origin.envelopeSha256 }] };
	return { ...f, receipt, archive, checkpoint, history, evidence,
		check: () => offlineRestartPolicyChecks.reviewWithHostEffect(f.input, evidence) };
}

test("one-time reviewed v3 source preserves old quarantine and rejects two new tasks", () => {
	const f = oneTimeLegacyV3Fixture();
	const result = f.check();
	assert.equal(result.sourceCommit, f.facts.source.commit);
	assert.equal(result.policyId, "mul-pis-reviewed-run-37490692145-one-time-v1");
	assert.deepEqual(result.operationAttestations.map(row => row.operationRef), [oldRef, newRef]);
	assert.equal(result.unknownBillingHeld, true);
	assert.equal(result.actorThirdPartyMutations, "none");
});

test("one-time reviewed v3 rejects a changed source, account census, old goal, or new adoption", () => {
	const changedSource = oneTimeLegacyV3Fixture();
	changedSource.facts.source.commit = "a".repeat(40);
	assert.throws(changedSource.check, /source, inherited commitments/);
	const changedAudit = oneTimeLegacyV3Fixture();
	changedAudit.review.requestAudit.requests[0].status = "unknown" as "settled";
	assert.throws(changedAudit.check, /settled request census/);
	const missingRequest = oneTimeLegacyV3Fixture();
	missingRequest.review.requestAudit.requests.pop();
	assert.throws(missingRequest.check, /settled request census/);
	const oldGoal = oneTimeLegacyV3Fixture();
	oldGoal.checkpoint.boundedRuns[0].outcome = "fulfilled";
	assert.throws(oldGoal.check, /historical goals/);
	const selected = oneTimeLegacyV3Fixture();
	(selected.newGoal as typeof selected.newGoal & { selectedTaskId?: string }).selectedTaskId = "T001";
	assert.throws(selected.check, /selected, accepted, or unresolved/);
	const unresolved = oneTimeLegacyV3Fixture();
	unresolved.newGoal.unresolvedOperationIds.push("O008");
	assert.throws(unresolved.check, /selected, accepted, or unresolved/);
	const accepted = oneTimeLegacyV3Fixture();
	accepted.history.entries.at(-1).files["workflow-archive.json"] = JSON.stringify({ version: 1,
		kind: "m07-private-candidate-archive", goalRunId: accepted.newGoal.runId, taskId: "T002",
		goalOutcome: "active", taskStatus: "accepted", m04: { state: "completed" },
		controllerEvidence: { reviewStatus: "accepted", operationOutcomes: ["O005", "O006", "O007"]
			.map(operationId => ({ operationId, status: "response-received" })) } });
	accepted.bundle["research-history.json"] = JSON.stringify(accepted.history);
	assert.throws(accepted.check, /rejected, response-received, unadopted/);
});

test("unbranded host-effect JSON does not authorize an unknown restart source", () => {
	const f = lengthSettledFixture();
	f.facts.source.commit = "b".repeat(40);
	f.bundle["host-effect-receipt.json"] = JSON.stringify({ version: 1,
		kind: "m07-host-effect-census", source: f.facts.source });
	assert.throws(() => reviewPrivateCampaignRestartEffects(f.input), /outside reviewed scope/);
});

test("one unknown transport attests confined actor effects while preserving all three unknown operations", () => {
	const f = unknownTransportFixture();
	const result = f.check();
	assert.deepEqual(result.operationAttestations.map(row => row.operationRef),
		[oldRef, newRef, "fresh-transport-goal/O001"]);
	assert.equal(result.unknownBillingHeld, true);
	assert.equal(result.actorThirdPartyMutations, "none");
	assert.equal(f.evidence.requestAudit.requests.filter((row: any) => row.responseReceived === false).length, 1);
});

test("unknown transport policy rejects changed selection, missing failed archive, or unquarantined operation", () => {
	const changed = unknownTransportFixture();
	changed.bundle["candidate.cpp"] = "different selected source";
	assert.throws(changed.check, /changed the prior selected tuple/);
	const missing = unknownTransportFixture();
	const history = JSON.parse(missing.bundle["research-history.json"]);
	history.entries.pop();
	missing.bundle["research-history.json"] = JSON.stringify(history);
	assert.throws(missing.check, /does not cover every new execute task archive/);
	const unquarantined = unknownTransportFixture();
	unquarantined.input.operationRefs.pop();
	assert.throws(unquarantined.check, /do not partition historical quarantine/);
	const unconfined = unknownTransportFixture();
	unconfined.evidence.receipt.sessions[0].kind = "read-dir";
	assert.throws(unconfined.check, /failed, confined, unselected task archive/);
});

test("reviewed current source plus ancestor-bound quarantine cover exactly old and new unknowns", () => {
	const f = fixture();
	const result = reviewPrivateCampaignRestartEffects(f.input);
	assert.equal(result.sourceCommit, currentCommit);
	assert.deepEqual(result.operationAttestations.map(item => item.operationRef), [oldRef, newRef]);
	assert.deepEqual(result.operationAttestations.map(item => item.sourceCommit), [oldCommit, currentCommit]);
	assert.equal(result.unknownBillingHeld, true);
	assert.equal(result.actorThirdPartyMutations, "none");
});

test("restart chain parsing has no arbitrary sixty-four-entry stop", () => {
	const f = fixture();
	f.bundle["independent-restart-quarantine.json"] = JSON.stringify({ version: 1,
		kind: "host-independent-restart-reservations",
		entries: Array.from({ length: 65 }, () => ({ receipt: f.receipt, claim: f.claim })) });
	assert.throws(() => reviewPrivateCampaignRestartEffects(f.input), error =>
		error instanceof Error && !/invalid .* chain/.test(error.message),
		"duplicate claims may fail semantic review, but count alone must not reject the chain");
});

test("unbranded bundle, unreviewed latest source, or missing ancestor proof fail closed", () => {
	const unbranded = fixture();
	unbranded.input.proof = { opaque: true };
	assert.throws(() => reviewPrivateCampaignRestartEffects(unbranded.input), /not authenticated/);
	const source = fixture();
	source.facts.source.commit = "e".repeat(40);
	assert.throws(() => reviewPrivateCampaignRestartEffects(source.input), /outside reviewed scope/);
	const ancestor = fixture();
	ancestor.setAncestor(false);
	assert.throws(() => reviewPrivateCampaignRestartEffects(ancestor.input), /not bound to authenticated ancestry/);
});

test("changed prior review, claim, binding or held cost cannot license inherited operation", () => {
	const review = fixture();
	review.receipt.prior.reviewedPolicySha256 = hash("another policy");
	review.bundle["independent-restart-quarantine.json"] = JSON.stringify({ version: 1,
		kind: "host-independent-restart-reservations", entries: [{ receipt: review.receipt, claim: review.claim }] });
	assert.throws(() => reviewPrivateCampaignRestartEffects(review.input), /not bound to authenticated ancestry/);
	const claim = fixture();
	claim.claim.currentRunId = "other-job";
	claim.bundle["independent-restart-quarantine.json"] = JSON.stringify({ version: 1,
		kind: "host-independent-restart-reservations", entries: [{ receipt: claim.receipt, claim: claim.claim }] });
	assert.throws(() => reviewPrivateCampaignRestartEffects(claim.input), /not bound to authenticated ancestry/);
	const binding = fixture();
	binding.binding.quarantineReceiptSha256 = hash("wrong receipt");
	binding.bundle["independent-restart-goal-binding.json"] = JSON.stringify({ version: 1,
		kind: "host-independent-restart-goal-bindings", entries: [binding.binding] });
	assert.throws(() => reviewPrivateCampaignRestartEffects(binding.input), /no unique fresh-goal binding/);
	const cost = fixture();
	cost.facts.unknownHeldNano = cost.receipt.prior.unknownHeldNano - 1;
	assert.throws(() => reviewPrivateCampaignRestartEffects(cost.input), /not bound to authenticated ancestry/);
});

test("extra, absent, or contradictory unknown operation references fail exact partition", () => {
	const extra = fixture();
	extra.input.operationRefs.push("other-goal/O007");
	assert.throws(() => reviewPrivateCampaignRestartEffects(extra.input), /do not partition exactly/);
	const absent = fixture();
	absent.input.operationRefs.splice(1, 1);
	assert.throws(() => reviewPrivateCampaignRestartEffects(absent.input), /do not partition exactly/);
	const inventedCurrent = fixture();
	inventedCurrent.input.operationRefs[1] = "latest-goal/O777";
	assert.throws(() => reviewPrivateCampaignRestartEffects(inventedCurrent.input),
		/do not partition exactly/);
	const conflicting = fixture();
	conflicting.receipt.quarantine.operationRefs = [newRef];
	conflicting.bundle["independent-restart-quarantine.json"] = JSON.stringify({ version: 1,
		kind: "host-independent-restart-reservations",
		entries: [{ receipt: conflicting.receipt, claim: conflicting.claim }] });
	assert.throws(() => reviewPrivateCampaignRestartEffects(conflicting.input), /no unique fresh-goal binding|do not partition exactly/);
});

test("inherited-only source accepts both older unknowns with two exact sealed ancestry links", () => {
	const f = inheritedOnlyFixture();
	const result = reviewPrivateCampaignRestartEffects(f.input);
	assert.equal(result.sourceCommit, inheritedOnlyCommit);
	assert.deepEqual(result.operationAttestations.map(item => item.operationRef), [oldRef, newRef]);
	assert.deepEqual(result.operationAttestations.map(item => item.sourceCommit), [oldCommit, currentCommit]);
	assert.equal(result.unknownBillingHeld, true);
});

test("inherited-only source rejects a new unknown, broken second link, shaved hold or unknown revision", () => {
	const newlyUnknown = inheritedOnlyFixture();
	newlyUnknown.checkpoint.boundedRuns.at(-1)!.unresolvedOperationIds.push("O009");
	newlyUnknown.bundle["objective-checkpoint.json"] = JSON.stringify(newlyUnknown.checkpoint);
	newlyUnknown.input.operationRefs.push("partial-new-goal/O009");
	assert.throws(() => reviewPrivateCampaignRestartEffects(newlyUnknown.input), /unaccounted or newly unknown/);
	const brokenClaim = inheritedOnlyFixture();
	brokenClaim.secondClaim.currentRunId = "unrelated-job";
	const entries = JSON.parse(brokenClaim.bundle["independent-restart-quarantine.json"]).entries;
	entries[1].claim = brokenClaim.secondClaim;
	brokenClaim.bundle["independent-restart-quarantine.json"] = JSON.stringify({ version: 1,
		kind: "host-independent-restart-reservations", entries });
	assert.throws(() => reviewPrivateCampaignRestartEffects(brokenClaim.input), /claims do not form/);
	const shaved = inheritedOnlyFixture();
	shaved.facts.unknownHeldNano -= 1;
	assert.throws(() => reviewPrivateCampaignRestartEffects(shaved.input), /release unknown billing/);
	const unreviewed = inheritedOnlyFixture();
	unreviewed.facts.source.commit = "e".repeat(40);
	assert.throws(() => reviewPrivateCampaignRestartEffects(unreviewed.input), /outside reviewed scope/);
});

test("inherited-only source requires a certified confined local-stop archive", () => {
	const missing = inheritedOnlyFixture();
	delete missing.bundle["research-history.json"];
	assert.throws(() => reviewPrivateCampaignRestartEffects(missing.input), /lacks host archive history/);
	const wrongScope = inheritedOnlyFixture();
	const history = JSON.parse(wrongScope.bundle["research-history.json"]);
	const archive = JSON.parse(history.entries[0].files["workflow-archive.json"]);
	archive.controllerEvidence.operationOutcomes[0].localStop.effectScope = "unverified";
	history.entries[0].files["workflow-archive.json"] = JSON.stringify(archive);
	wrongScope.bundle["research-history.json"] = JSON.stringify(history);
	assert.throws(() => reviewPrivateCampaignRestartEffects(wrongScope.input),
		/lacks the certified confined local-stop boundary/);
});

test("fafd length-settled source preserves inherited unknowns without accepting an unfinished task", () => {
	const f = lengthSettledFixture();
	const result = reviewPrivateCampaignRestartEffects(f.input);
	assert.equal(result.sourceCommit, lengthSettledCommit);
	assert.deepEqual(result.operationAttestations.map(x => x.operationRef), [oldRef, newRef]);
	assert.equal(result.unknownBillingHeld, true);
	assert.equal(result.actorThirdPartyMutations, "none");
	const noScope = lengthSettledFixture();
	const history = JSON.parse(noScope.bundle["research-history.json"]);
	const archive = JSON.parse(history.entries[1].files["workflow-archive.json"]);
	archive.controllerEvidence.operationOutcomes[0].terminalResponse.effectScope = "unverified";
	history.entries[1].files["workflow-archive.json"] = JSON.stringify(archive);
	noScope.bundle["research-history.json"] = JSON.stringify(history);
	assert.throws(() => reviewPrivateCampaignRestartEffects(noScope.input), /lacks the received, settled, confined length-stop receipt/);
	const noReceipt = lengthSettledFixture();
	const rows = JSON.parse(noReceipt.bundle["research-history.json"]);
	const withoutTerminal = JSON.parse(rows.entries[1].files["workflow-archive.json"]);
	delete withoutTerminal.controllerEvidence.operationOutcomes[0].terminalResponse;
	rows.entries[1].files["workflow-archive.json"] = JSON.stringify(withoutTerminal);
	noReceipt.bundle["research-history.json"] = JSON.stringify(rows);
	assert.throws(() => reviewPrivateCampaignRestartEffects(noReceipt.input), /lacks the received, settled, confined length-stop receipt/);
});
