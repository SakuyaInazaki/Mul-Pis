import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { AuthenticatedRestartCarryFacts } from "../src/m07/independent-restart.ts";
import type { OpaqueExecutedRunGap } from "../src/runner/ledger-continuation.ts";
import { offlineRestartPolicyChecks } from
	"../src/runner/private-campaign-restart-policy.ts";

const hash = (value: string): string => createHash("sha256").update(value).digest("hex");
const source = (runId: string, commit: string) => ({ runId, runAttempt: 1, commit });
const key = (item: { runId: string; runAttempt: number; commit: string }, envelope: string) =>
	`${item.runId}/${item.runAttempt}/${item.commit}/${envelope}`;

function fixture(linkCount = 2) {
	const proof = Object.freeze({ privateBrand: true });
	const sources = Array.from({ length: linkCount + 1 }, (_, index) =>
		source(String(41001 + index * 1000), String(index + 1).repeat(40)));
	const envelopes = sources.map((_, index) => hash(`independent envelope ${index}`));
	const contract = { version: 1, kind: "original-objective", id: "original-contract",
		goal: "Continue the research", inputNames: ["original.txt"], obligations: [], closure: "open-ended" };
	const selectedArtifacts = ["candidate.cpp", "verification.json", "workflow-archive.json"];
	const bundle: Record<string, string> = {
		"original-objective.json": JSON.stringify(contract),
		"candidate.cpp": "an earlier accepted result",
		"verification.json": JSON.stringify({ status: "passed" }),
		"workflow-archive.json": JSON.stringify({ goalRunId: "accepted-goal", taskId: "T001" }),
	};
	const selectedTupleSha256 = hash(JSON.stringify(selectedArtifacts.slice().sort().map(name => ({ name,
		sha256: hash(bundle[name]), bytes: Buffer.byteLength(bundle[name], "utf8") }))));
	const oldGoal = { runId: "old-goal", outcome: "active", unresolvedOperationIds: ["O001"] };
	const accepted = { runId: "accepted-goal", outcome: "fulfilled", selectedTaskId: "T001",
		acceptedTaskIds: ["T001"], unresolvedOperationIds: [] as string[] };
	const boundedRuns: Array<{ runId: string; outcome: string; unresolvedOperationIds: string[];
		selectedTaskId?: string; acceptedTaskIds?: string[] }> = [accepted, oldGoal];
	const refs = ["old-goal/O001"];
	const reservations: Array<{ receipt: any; claim: any }> = [];
	const bindings: any[] = [];
	for (let index = 0; index < linkCount; index++) {
		const goalId = `successor-goal-${index}`;
		const receipt = { version: index === 0 ? 1 : 2, kind: "host-independent-goal-quarantine",
			prior: { source: sources[index], envelopeSha256: envelopes[index],
				contractId: contract.id, reviewedPolicyId: `opaque-prior-policy-${index}`,
				reviewedPolicySha256: hash(`prior-policy-${index}`),
				selectedTupleSha256, committedNano: (index + 1) * 1000,
				unknownHeldNano: index + 1,
				...(index === 0 ? {} : { accountingObservation: {
					historicalCommittedNano: (index + 1) * 1000,
					historicalUnknownHeldNano: index + 1,
					settledNano: index * 40, unknownObservedNano: index * 10,
					unpricedRequestCount: 0, opaqueUnquantifiedRunCount: 0 } }) },
			quarantine: { operationRefs: [...refs], operationOutcome: "unknown",
				selectedFromFailedAttempt: false,
				historicalGoalOutcomes: boundedRuns.map(row => ({ runId: row.runId, outcome: row.outcome })),
				...(index === 0 ? {} : { historicalEffectState: "unknown-unreconciled",
					executionMode: "fresh-work-only" }) },
			freshWorkspace: { workspaceId: `fresh-space-${index}`, restartNonce: `nonce-${index}` } };
		const claim = { claimId: `claim-${index}`, currentJobId: `job-${index}`,
			priorEnvelopeSha256: envelopes[index], currentRunId: sources[index + 1].runId,
			currentRunAttempt: 1, currentCommit: sources[index + 1].commit };
		reservations.push({ receipt, claim });
		bindings.push({ version: 1, kind: "host-independent-goal-binding",
			quarantineReceiptSha256: hash(JSON.stringify(receipt)),
			freshWorkspace: { ...receipt.freshWorkspace }, goalRunId: goalId });
		boundedRuns.push({ runId: goalId, outcome: "active", unresolvedOperationIds: [`O${String(index + 2).padStart(3, "0")}`] });
		refs.push(`${goalId}/O${String(index + 2).padStart(3, "0")}`);
	}
	const checkpoint = { version: 1, kind: "original-objective-progress", contract,
		selectedArtifacts, boundedRuns, continuation: { requiresOperationReconciliation: true,
			unresolvedOperationIds: refs } };
	bundle["objective-checkpoint.json"] = JSON.stringify(checkpoint);
	bundle["independent-restart-quarantine.json"] = JSON.stringify({ version: 1,
		kind: "host-independent-restart-reservations", entries: reservations });
	bundle["independent-restart-goal-binding.json"] = JSON.stringify({ version: 1,
		kind: "host-independent-restart-goal-bindings", entries: bindings });
	const facts: AuthenticatedRestartCarryFacts = { source: sources.at(-1)!,
		currentRun: source("future-run", "f".repeat(40)), envelopeSha256: envelopes.at(-1)!,
		privateBundleSha256: hash("authenticated bundle"),
		terminal: { state: "terminal", sourceRunId: sources.at(-1)!.runId,
			sourceRunAttempt: 1, observationDigest: hash("terminal"), observedAt: "2026-10-07T00:00:00Z" },
		resultArtifact: { immutableRef: "fixed-encrypted-artifact", digestScope: "github-artifact-archive",
			sha256: hash("archive") }, committedNano: (linkCount + 1) * 1000,
		unknownHeldNano: linkCount + 1 };
	const ancestors = new Set(sources.map((item, index) => key(item, envelopes[index])));
	let bundleDigest = hash(JSON.stringify(bundle));
	const unobservedControlDeliveries: import("../src/runner/ledger-continuation.ts").UnobservedControlDelivery[] = [];
	const input = { facts, operationRefs: refs, unobservedControlDeliveries,
		privateBundle: bundle, proof,
		authenticatedControlDeliveries: (value: unknown, data: unknown, rows: unknown) =>
			value === proof && data === bundle && rows === unobservedControlDeliveries,
		authenticatedBundle: (value: unknown, data: unknown) => value === proof && data === bundle &&
			hash(JSON.stringify(data)) === bundleDigest,
		bindsAncestor: (value: unknown, item: { runId: string; runAttempt: number; commit: string },
			envelope: string) => value === proof && ancestors.has(key(item, envelope)) };
	const evidence = { ancestry: sources.map((item, index) => ({ source: item,
		envelopeSha256: envelopes[index] })),
		accounting: { historicalCommittedNano: facts.committedNano,
			historicalUnknownHeldNano: facts.unknownHeldNano,
			settledNano: 235, unknownObservedNano: 89, unpricedRequestCount: 1,
			opaqueUnquantifiedRunCount: 0 }, gaps: [] as OpaqueExecutedRunGap[],
		priorControlDeliveries: [] as import("../src/runner/ledger-continuation.ts").UnobservedControlDelivery[] };
	return { input, bundle, checkpoint, reservations, bindings, sources, envelopes, refs,
		evidence, authorize: () => { bundleDigest = hash(JSON.stringify(bundle)); }, ancestors };
}

const review = (f: ReturnType<typeof fixture>) => offlineRestartPolicyChecks.reviewWithEvidence(f.input, f.evidence);

test("dynamic authenticated chains carry UNKNOWN effects into fresh-only mode", () => {
	for (const length of [1, 2, 5]) {
		const f = fixture(length);
		const policy = review(f);
		assert.equal(policy.sourceCommit, f.sources.at(-1)!.commit);
		assert.equal(policy.effectClass, "historical-unknown-fresh-only");
		assert.equal(policy.actorThirdPartyMutations, "unknown");
		assert.equal(policy.unknownBillingHeld, true);
		assert.deepEqual(policy.operationAttestations.map(row => row.operationRef).sort(), [...f.refs].sort());
	}
});

test("forged source, broken claim, binding replay and lost old unknown fail closed", () => {
	for (const corrupt of ["source", "claim", "binding", "lost-ref"] as const) {
		const f = fixture(3);
		if (corrupt === "source") f.reservations[1].receipt.prior.source.commit = "e".repeat(40);
		if (corrupt === "claim") f.reservations[0].claim.currentRunId = "unrelated-run";
		if (corrupt === "binding") f.bindings[1].goalRunId = f.bindings[0].goalRunId;
		if (corrupt === "lost-ref") f.reservations[2].receipt.quarantine.operationRefs.shift();
		f.bundle["independent-restart-quarantine.json"] = JSON.stringify({ version: 1,
			kind: "host-independent-restart-reservations", entries: f.reservations });
		f.bundle["independent-restart-goal-binding.json"] = JSON.stringify({ version: 1,
			kind: "host-independent-restart-goal-bindings", entries: f.bindings });
		f.authorize();
		assert.throws(() => review(f),
			/historical quarantine|historical claims|historical goal binding|historical restart chain|ordered authenticated/);
	}
});

test("accepted new selection requires a bound goal and exact archival transition", () => {
	const f = fixture(1);
	const oldFiles = Object.fromEntries(f.checkpoint.selectedArtifacts.map(name => [name, f.bundle[name]]));
	const newGoal = f.checkpoint.boundedRuns.at(-1)!;
	newGoal.outcome = "fulfilled";
	newGoal.unresolvedOperationIds = [];
	newGoal.selectedTaskId = "T002";
	newGoal.acceptedTaskIds = ["T002"];
	f.checkpoint.continuation.unresolvedOperationIds = ["old-goal/O001"];
	f.input.operationRefs = ["old-goal/O001"];
	f.bundle["candidate.cpp"] = "new accepted candidate";
	f.bundle["verification.json"] = JSON.stringify({ version: 1, status: "passed", new: true });
	f.bundle["workflow-archive.json"] = JSON.stringify({ version: 1,
		kind: "m07-private-candidate-archive", goalRunId: newGoal.runId, taskId: "T002",
		goalOutcome: "fulfilled", taskStatus: "accepted",
		controllerEvidence: { reviewStatus: "accepted" },
		m04: { state: "completed", runId: "m04-accepted-candidate",
			proposalSubmitted: false, snapshotCreated: false, transaction: {
			file: "m04-transaction.json", state: "no-proposal" } } });
	f.bundle["m04-transaction.json"] = JSON.stringify({ version: 1,
		kind: "m04-knowledge-transaction", m04RunId: "m04-accepted-candidate",
		state: "no-proposal", attempts: [] });
	f.bundle["research-history.json"] = JSON.stringify({ version: 1,
		kind: "untrusted-version-bound-research-history", entries: [{ goalRunId: "accepted-goal",
			taskId: "T001", files: oldFiles }] });
	f.bundle["objective-checkpoint.json"] = JSON.stringify(f.checkpoint);
	f.reservations[0].receipt.prior.selectedRunId = "accepted-goal";
	f.reservations[0].receipt.prior.selectedTaskId = "T001";
	f.bindings[0].quarantineReceiptSha256 = hash(JSON.stringify(f.reservations[0].receipt));
	f.bundle["independent-restart-quarantine.json"] = JSON.stringify({ version: 1,
		kind: "host-independent-restart-reservations", entries: f.reservations });
	f.bundle["independent-restart-goal-binding.json"] = JSON.stringify({ version: 1,
		kind: "host-independent-restart-goal-bindings", entries: f.bindings });
	(f.evidence as any).hostEffect = { receipt: { source: f.input.facts.source,
		historicalGoalRunIds: ["accepted-goal", "old-goal"],
		goals: [{ runId: newGoal.runId, outcome: "fulfilled",
			tasks: [{ taskId: "T002", status: "accepted" }], operations: [] }],
		sessions: [], requestIds: [] }, requestAudit: { requests: [] } };
	f.authorize();
	assert.equal(review(f).effectClass, "historical-unknown-fresh-only");
	f.bundle["workflow-archive.json"] = JSON.stringify({ version: 1,
		kind: "m07-private-candidate-archive", goalRunId: newGoal.runId, taskId: "T002",
		goalOutcome: "fulfilled", taskStatus: "rejected",
		controllerEvidence: { reviewStatus: "rejected" } });
	f.authorize();
	assert.throws(() => review(f), /accepted goal|archive transition|prior selected tuple/);
});
