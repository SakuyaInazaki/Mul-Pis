import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { AuthenticatedRestartCarryFacts } from "../src/m07/independent-restart.ts";
import { PRIOR_REVIEWED_POLICY_SHA256, reviewPrivateCampaignRestartEffects } from
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
