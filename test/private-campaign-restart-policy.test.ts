import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { AuthenticatedRestartCarryFacts } from "../src/m07/independent-restart.ts";
import { PRIOR_REVIEWED_POLICY_SHA256, reviewPrivateCampaignRestartEffects } from
	"../src/runner/private-campaign-restart-policy.ts";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const oldCommit = "2fe7f132370b4598c942625fad1a7e9129978eaa";
const currentCommit = "242bb0c205ef0d6fb0bf76dd53a2c3d62e55ef66";
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

test("reviewed current source plus ancestor-bound quarantine cover exactly old and new unknowns", () => {
	const f = fixture();
	const result = reviewPrivateCampaignRestartEffects(f.input);
	assert.equal(result.sourceCommit, currentCommit);
	assert.deepEqual(result.operationAttestations.map(item => item.operationRef), [oldRef, newRef]);
	assert.deepEqual(result.operationAttestations.map(item => item.sourceCommit), [oldCommit, currentCommit]);
	assert.equal(result.unknownBillingHeld, true);
	assert.equal(result.actorThirdPartyMutations, "none");
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
