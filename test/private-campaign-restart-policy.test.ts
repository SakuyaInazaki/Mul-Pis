import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { AuthenticatedRestartCarryFacts } from "../src/m07/independent-restart.ts";
import type { OpaqueExecutedRunGap } from "../src/runner/ledger-continuation.ts";
import { offlineRestartPolicyChecks, reviewPrivateCampaignRestartEffects } from
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
	const input = { facts, operationRefs: refs, privateBundle: bundle, proof,
		authenticatedBundle: (value: unknown, data: unknown) => value === proof && data === bundle &&
			hash(JSON.stringify(data)) === bundleDigest,
		bindsAncestor: (value: unknown, item: { runId: string; runAttempt: number; commit: string },
			envelope: string) => value === proof && ancestors.has(key(item, envelope)) };
	const evidence = { ancestry: sources.map((item, index) => ({ source: item,
		envelopeSha256: envelopes[index] })),
		accounting: { historicalCommittedNano: facts.committedNano,
			historicalUnknownHeldNano: facts.unknownHeldNano,
			settledNano: 235, unknownObservedNano: 89, unpricedRequestCount: 1,
			opaqueUnquantifiedRunCount: 0 }, gaps: [] as OpaqueExecutedRunGap[] };
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

test("copied proof and tampered bundle cannot mint an effect policy", () => {
	const f = fixture();
	assert.throws(() => offlineRestartPolicyChecks.reviewWithEvidence(
		{ ...f.input, proof: { privateBrand: true } }, f.evidence),
		/not bound to an authenticated historical carry/);
	f.bundle["candidate.cpp"] = "tampered result";
	assert.throws(() => review(f),
		/not bound to an authenticated historical carry/);
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

test("later V2 receipt cannot reduce or inflate carried v3 observations", () => {
	for (const changed of [0, 1_000_000]) {
		const f = fixture(3);
		f.reservations[2].receipt.prior.accountingObservation.settledNano = changed;
		f.bundle["independent-restart-quarantine.json"] = JSON.stringify({ version: 1,
			kind: "host-independent-restart-reservations", entries: f.reservations });
		f.authorize();
		assert.throws(() => review(f), /historical v3 accounting/);
	}
});

test("abandoned no-goal reservation is a retained claim, never a replayed goal", () => {
	const f = fixture(2);
	const formerCurrent = f.sources.at(-1)!;
	const last = f.reservations.at(-1)!.receipt;
	const abandonedSource = formerCurrent;
	const envelope = f.envelopes.at(-1)!;
	const abandoned = { receipt: { ...last, version: 2,
		prior: { ...last.prior, source: abandonedSource, envelopeSha256: envelope,
			reviewedPolicySha256: hash("abandoned review") },
		quarantine: { ...last.quarantine,
			historicalGoalOutcomes: f.checkpoint.boundedRuns.map(row => ({ runId: row.runId,
				outcome: row.outcome })) },
		freshWorkspace: { workspaceId: "fresh-abandoned", restartNonce: "abandoned" } },
		claim: { claimId: "claim-after-abandoned", currentJobId: "job-after-abandoned",
			priorEnvelopeSha256: envelope, currentRunId: "final-source", currentRunAttempt: 1,
			currentCommit: "c".repeat(40) } };
	f.reservations.push(abandoned);
	f.sources.push(source("final-source", "c".repeat(40)));
	f.input.facts.source = f.sources.at(-1)!;
	f.input.facts.envelopeSha256 = hash("final carry");
	f.ancestors.add(key(f.input.facts.source, f.input.facts.envelopeSha256));
	f.evidence.ancestry.push({ source: f.input.facts.source, envelopeSha256: f.input.facts.envelopeSha256 });
	f.bundle["independent-restart-quarantine.json"] = JSON.stringify({ version: 1,
		kind: "host-independent-restart-reservations", entries: f.reservations });
	f.authorize();
	assert.equal(review(f).effectClass, "historical-unknown-fresh-only");
	assert.equal(formerCurrent.runId, f.reservations[2].receipt.prior.source.runId);
});

test("production review requires a live ledger brand", () => {
	const f = fixture();
	assert.throws(() => reviewPrivateCampaignRestartEffects(f.input),
		/live authenticated ancestry and accounting are required/);
});

test("last claim may precede repeated authenticated wrapper carries", () => {
	const f = fixture(1);
	for (const index of [1, 2, 3]) {
		const wrapper = source(`wrapper-${index}`, String(index + 5).repeat(40));
		const envelope = hash(`wrapper envelope ${index}`);
		f.input.facts.source = wrapper;
		f.input.facts.envelopeSha256 = envelope;
		f.sources.push(wrapper);
		f.envelopes.push(envelope);
		f.ancestors.add(key(wrapper, envelope));
		f.evidence.ancestry.push({ source: wrapper, envelopeSha256: envelope });
		assert.equal(review(f).effectClass, "historical-unknown-fresh-only");
	}
	const missing = fixture(1);
	missing.reservations[0].claim.currentRunId = "unrelated-wrapper";
	missing.bundle["independent-restart-quarantine.json"] = JSON.stringify({ version: 1,
		kind: "host-independent-restart-reservations", entries: missing.reservations });
	missing.authorize();
	assert.throws(() => review(missing), /historical claims/);
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

test("opaque missing-carry gap allows zero M07 unknowns but forged gap fails", () => {
	const f = fixture(1);
	f.checkpoint.boundedRuns = [f.checkpoint.boundedRuns[0]];
	f.checkpoint.continuation.unresolvedOperationIds = [];
	f.input.operationRefs = [];
	f.bundle["objective-checkpoint.json"] = JSON.stringify(f.checkpoint);
	delete f.bundle["independent-restart-quarantine.json"];
	delete f.bundle["independent-restart-goal-binding.json"];
	f.evidence.accounting.opaqueUnquantifiedRunCount = 1;
	f.evidence.gaps.push({ version: 1, kind: "opaque-executed-run-gap",
		source: { ...source("gap-run", "e".repeat(40)), runNumber: 7 },
		priorCarryEnvelopeSha256: f.input.facts.envelopeSha256,
		carryArtifact: "absent", accounting: "unquantified", effects: "unreviewed",
		terminal: {} as any, resultArtifact: {} as any });
	f.authorize();
	assert.deepEqual(review(f).operationAttestations, []);
	f.evidence.gaps[0] = { ...f.evidence.gaps[0], priorCarryEnvelopeSha256: "forged" };
	assert.throws(() => review(f), /opaque run gap/);
});

test("later same-run accepted goal can replace selection before another unknown failure", () => {
	const f = fixture(1);
	const oldFiles = Object.fromEntries(f.checkpoint.selectedArtifacts.map(name => [name, f.bundle[name]]));
	f.checkpoint.boundedRuns.push({ runId: "later-accepted-goal", outcome: "fulfilled",
		selectedTaskId: "T003", acceptedTaskIds: ["T003"], unresolvedOperationIds: [] });
	f.checkpoint.boundedRuns.push({ runId: "later-failed-goal", outcome: "active",
		unresolvedOperationIds: ["O004"] });
	f.checkpoint.continuation.unresolvedOperationIds.push("later-failed-goal/O004");
	f.input.operationRefs = [...f.refs];
	f.bundle["candidate.cpp"] = "candidate selected after first bound goal";
	f.bundle["verification.json"] = JSON.stringify({ version: 1, status: "passed" });
	f.bundle["workflow-archive.json"] = JSON.stringify({ version: 1,
		kind: "m07-private-candidate-archive", goalRunId: "later-accepted-goal",
		taskId: "T003", goalOutcome: "fulfilled", taskStatus: "accepted",
		controllerEvidence: { reviewStatus: "accepted" },
		m04: { state: "completed", runId: "m04-later",
			proposalSubmitted: false, snapshotCreated: false, transaction: {
			file: "m04-transaction.json", state: "no-proposal" } } });
	f.bundle["m04-transaction.json"] = JSON.stringify({ version: 1,
		kind: "m04-knowledge-transaction", m04RunId: "m04-later",
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
		goals: [
			{ runId: "successor-goal-0", outcome: "active", tasks: [],
				operations: [{ id: "O002", status: "unknown" }] },
			{ runId: "later-accepted-goal", outcome: "fulfilled",
				tasks: [{ taskId: "T003", status: "accepted" }], operations: [] },
			{ runId: "later-failed-goal", outcome: "active", tasks: [],
				operations: [{ id: "O004", status: "unknown" }] } ],
		sessions: [], requestIds: [] }, requestAudit: { requests: [] } };
	f.authorize();
	assert.equal(review(f).effectClass, "historical-unknown-fresh-only");
	const acceptedArchive = JSON.parse(f.bundle["workflow-archive.json"]);
	const archive = structuredClone(acceptedArchive);
	delete archive.m04.transaction;
	f.bundle["workflow-archive.json"] = JSON.stringify(archive);
	f.authorize();
	assert.throws(() => review(f), /accepted goal/);
	const rejectedDraft = structuredClone(acceptedArchive);
	rejectedDraft.m04 = { state: "failed", runId: "m04-later",
		proposalSubmitted: true, snapshotCreated: false,
		transaction: { file: "m04-transaction.json", state: "rejected-draft" } };
	f.bundle["workflow-archive.json"] = JSON.stringify(rejectedDraft);
	f.bundle["m04-transaction.json"] = JSON.stringify({ version: 1,
		kind: "m04-knowledge-transaction", m04RunId: "m04-later",
		state: "rejected-draft", attempts: [{ state: "rejected-draft" }] });
	f.authorize();
	assert.throws(() => review(f), /accepted goal/,
		"a rejected M04 draft cannot promote an unselected historical candidate");
});

test("branded selection survives zero and failed wrappers while forged transitions fail", () => {
	const f = fixture(1);
	const selectedNames = [...f.checkpoint.selectedArtifacts];
	const oldFiles = Object.fromEntries(selectedNames.map(name => [name, f.bundle[name]]));
	const bound = f.checkpoint.boundedRuns.at(-1)!;
	bound.outcome = "partial";
	bound.unresolvedOperationIds = [];
	f.checkpoint.boundedRuns.push({ runId: "later-selected", outcome: "fulfilled",
		selectedTaskId: "T003", acceptedTaskIds: ["T003"], unresolvedOperationIds: [] });
	f.checkpoint.boundedRuns.push({ runId: "later-failed", outcome: "active",
		unresolvedOperationIds: ["O004"] });
	f.checkpoint.continuation.unresolvedOperationIds = ["old-goal/O001", "later-failed/O004"];
	f.input.operationRefs = ["old-goal/O001", "later-failed/O004"];
	f.bundle["candidate.cpp"] = "new selected work from prior accepted run";
	f.bundle["verification.json"] = JSON.stringify({ version: 1, status: "passed" });
	f.bundle["workflow-archive.json"] = JSON.stringify({ version: 1,
		kind: "m07-private-candidate-archive", goalRunId: "later-selected", taskId: "T003",
		goalOutcome: "fulfilled", taskStatus: "accepted",
		controllerEvidence: { reviewStatus: "accepted" },
		m04: { state: "completed", runId: "m04-prior-accepted", proposalSubmitted: false,
			snapshotCreated: false, transaction: { file: "m04-transaction.json", state: "no-proposal" } } });
	f.bundle["m04-transaction.json"] = JSON.stringify({ version: 1,
		kind: "m04-knowledge-transaction", m04RunId: "m04-prior-accepted",
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
	const selectionSource = f.sources.at(-1)!;
	const selectionEnvelope = f.envelopes.at(-1)!;
	for (const [name, commit] of [["zero-wrapper", "c".repeat(40)],
		["failed-wrapper", "d".repeat(40)]]) {
		const row = source(name, commit);
		const envelope = hash(`${name} carry`);
		f.sources.push(row); f.envelopes.push(envelope);
		f.evidence.ancestry.push({ source: row, envelopeSha256: envelope });
		f.ancestors.add(key(row, envelope));
		f.input.facts.source = row;
		f.input.facts.envelopeSha256 = envelope;
	}
	(f.evidence as any).hostEffect = { receipt: { source: f.input.facts.source,
		historicalGoalRunIds: ["accepted-goal", "old-goal", "successor-goal-0", "later-selected"],
		goals: [{ runId: "later-failed", outcome: "active", tasks: [],
			operations: [{ id: "O004", status: "unknown" }] }], sessions: [], requestIds: [] },
		requestAudit: { requests: [] } };
	const selectedTupleSha256 = hash(JSON.stringify(selectedNames.slice().sort().map(name => ({
		name, sha256: hash(f.bundle[name]), bytes: Buffer.byteLength(f.bundle[name], "utf8") }))));
	const transition = { version: 1, kind: "host-selected-tuple-transition",
		source: { ...selectionSource, runNumber: 2 }, envelopeSha256: selectionEnvelope,
		priorEnvelopeSha256: f.envelopes[0],
		priorSelectedTupleSha256: f.reservations[0].receipt.prior.selectedTupleSha256,
		selectedTupleSha256, priorSelectedArtifacts: selectedNames, selectedArtifacts: selectedNames,
		contractId: "original-contract", goalRunId: "later-selected", taskId: "T003",
		archiveSha256: hash(f.bundle["workflow-archive.json"]),
		m04RunId: "m04-prior-accepted", m04State: "no-proposal" };
	(f.evidence as any).selectedTransitions = [transition];
	f.authorize();
	assert.equal(review(f).effectClass, "historical-unknown-fresh-only");
	for (const patch of [{ archiveSha256: hash("forged archive") },
		{ priorSelectedTupleSha256: hash("forged predecessor") },
		{ envelopeSha256: hash("forged carry") },
		{ priorEnvelopeSha256: hash("forged parent") },
		{ m04State: "merged" }]) {
		(f.evidence as any).selectedTransitions = [{ ...transition, ...patch }];
		assert.throws(() => review(f), /authenticated accepted goal/);
	}
	(f.evidence as any).selectedTransitions = undefined;
	assert.throws(() => review(f), /authenticated accepted goal/);
});
