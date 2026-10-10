import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { classifyPendingAction } from "../src/m07/objective-progress.ts";
import { REUSABLE_RUN_REQUEST_MESSAGE } from "../src/runner/ledger-continuation.ts";
import { MissionResumeJournal, type TestedControlBinding } from
	"../src/runner/mission-resume-journal.ts";
import { pendingActionIdentity, planMissionContinuation, type ResumeIntent,
	type SupervisorSnapshot } from "../src/runner/mission-supervisor.ts";

const hash = (s: string): string => createHash("sha256").update(s).digest("hex");
function canonical(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
		.map(([key, part]) => `${JSON.stringify(key)}:${canonical(part)}`).join(",")}}`;
}
const source = { runId: "7002", runAttempt: 1, commit: "b".repeat(40) };
function intentFor(reason: "assessment-failed" | "model-reported-blocked" = "assessment-failed"):
	ResumeIntent {
	const action = classifyPendingAction(reason);
	const status = { version: 1 as const, kind: "host-redacted-mission-status" as const,
		contractId: "private-contract", objectiveOutcome: "incomplete" as const,
		stopReason: reason, selectedTupleSha256: hash("tuple"),
		unresolvedOperationRefs: [], pendingAction: action };
	const snapshot: SupervisorSnapshot = { status, pendingAction: action,
		dispatchRecord: { state: "not-requested" },
		terminalCarry: { version: 1, kind: "host-verified-terminal-carry", source,
			envelopeSha256: hash("envelope"), contractId: status.contractId,
			selectedTupleSha256: status.selectedTupleSha256,
			pendingActionSha256: pendingActionIdentity(action),
			terminal: { runStatus: "completed", jobStatus: "completed",
				providerStepStatus: "completed" } } };
	const decision = planMissionContinuation(snapshot);
	assert.equal(decision.kind, "dispatch");
	if (decision.kind !== "dispatch") throw Error("fixture is not dispatchable");
	return decision.intent;
}
const binding = (sourceCommit = "c".repeat(40), tree = "d".repeat(40)):
	TestedControlBinding => ({
	controlRef: "refs/heads/run-requests/workflow-learning-reliability",
	message: REUSABLE_RUN_REQUEST_MESSAGE, testedSourceCommit: sourceCommit,
	testedTree: tree,
	successfulCi: { workflow: "workflow-regression.yml", runId: "9001",
		runAttempt: 1, headCommit: sourceCommit, conclusion: "success" },
	previousControlCommit: "e".repeat(40),
	parents: [sourceCommit, "e".repeat(40)], expectedBefore: "e".repeat(40),
	sourceRef: "refs/heads/improve/workflow-learning-reliability",
	sourceRefTip: sourceCommit,
});
async function fixture(t: TestContext) {
	const dir = await mkdtemp(path.join(os.tmpdir(), "mission-journal-"));
	t.after(async () => rm(dir, { recursive: true, force: true }));
	return { dir, journal: new MissionResumeJournal(path.join(dir, "private")) };
}

function repairIntentFor(control = binding()): ResumeIntent {
	const prior = intentFor();
	const action = classifyPendingAction("workflow-repair-needed", {
		failedStage: "m04-judgment", evidenceRefs: ["repair-state.json"] });
	const pendingActionSha256 = pendingActionIdentity(action);
	const workflowRepair = { reviewedPlanSha256: hash("private operator review"),
		testedSourceCommit: control.testedSourceCommit, testedTree: control.testedTree,
		successfulCi: control.successfulCi };
	return { ...prior, actionKind: action.kind, pendingAction: action, pendingActionSha256,
		workflowRepair, idempotencyKey: hash(canonical({ source: prior.source,
			envelopeSha256: prior.envelopeSha256, contractId: prior.contractId,
			selectedTupleSha256: prior.selectedTupleSha256, pendingActionSha256, workflowRepair })) };
}

function interruptedIntentFor(): ResumeIntent {
	const prior = intentFor();
	const source = { runId: "7003", runAttempt: 1, commit: "f".repeat(40) };
	const action = classifyPendingAction("execution-interrupted");
	const pendingActionSha256 = pendingActionIdentity(action);
	const terminalInterruption = { version: 1 as const,
		kind: "host-verified-terminal-interruption" as const, source,
		priorCarrySource: prior.source, priorCarryEnvelopeSha256: prior.envelopeSha256,
		resultArtifactId: "9103", resultArchiveSha256: hash("opaque result"),
		accounting: "unquantified" as const, effects: "unknown-unreconciled" as const,
		terminationOrigin: "unknown" as const };
	const actionProvenance = { kind: "current-host-interruption" as const,
		priorCheckpointSha256: hash("prior checkpoint"),
		resultArchiveSha256: terminalInterruption.resultArchiveSha256 };
	const interruptedSourceReview = { source, sourceTree: "a".repeat(40),
		receiptSha256: hash("private operator source review") };
	return { ...prior, source, pendingAction: action, pendingActionSha256,
		actionKind: action.kind, terminalInterruption, actionProvenance,
		interruptedSourceReview, m04TransactionQuarantined: true,
		idempotencyKey: hash(canonical({ source, envelopeSha256: prior.envelopeSha256,
			contractId: prior.contractId, selectedTupleSha256: prior.selectedTupleSha256,
			pendingActionSha256, terminalInterruption, actionProvenance,
			interruptedSourceReview })) };
}

test("interrupted review is private, source-bound, durable and cannot be removed under the same key", async t => {
	const { journal } = await fixture(t), intent = interruptedIntentFor();
	const first = await journal.reserve(intent, binding());
	assert.deepEqual(first.intentBinding.interruptedSourceReview, intent.interruptedSourceReview);
	assert.deepEqual(await new MissionResumeJournal(journal.directory).reserve(intent, binding()), first);
	assert.equal(first.control.testedSourceCommit, "c".repeat(40));
	assert.notEqual(first.control.testedSourceCommit, intent.interruptedSourceReview!.source.commit);
	await assert.rejects(journal.reserve({ ...intent, interruptedSourceReview: {
		...intent.interruptedSourceReview!, receiptSha256: hash("changed receipt") } }, binding()),
		/idempotency key/);
	await assert.rejects(journal.reserve({ ...intent, interruptedSourceReview: undefined }, binding()),
		/interruption action provenance/);
	const file = path.join(journal.directory, `${intent.idempotencyKey}.json`);
	const text = await readFile(file, "utf8");
	assert(!text.includes("operator-code-review"));
	assert(!JSON.stringify(first.control).includes(intent.interruptedSourceReview!.receiptSha256));
	const stored = JSON.parse(text);
	stored.intentBinding.interruptedSourceReview.sourceTree = "b".repeat(40);
	await writeFile(file, JSON.stringify(stored));
	await assert.rejects(new MissionResumeJournal(journal.directory).get(intent.idempotencyKey),
		/idempotency binding/);
});

test("repair reservation binds the private review and replacement source through restart", async t => {
	const { journal } = await fixture(t), intent = repairIntentFor();
	const first = await journal.reserve(intent, binding());
	assert.deepEqual(first.intentBinding.workflowRepair, intent.workflowRepair);
	assert.deepEqual(await new MissionResumeJournal(journal.directory).reserve(intent, binding()), first);
	await assert.rejects(journal.reserve({ ...intent, workflowRepair: {
		...intent.workflowRepair!, reviewedPlanSha256: hash("changed review") } }, binding()), /idempotency key/);
	await assert.rejects(journal.reserve({ ...intent, workflowRepair: undefined }, binding()), /private intent/);
	await assert.rejects(journal.reserve(intent, binding("f".repeat(40))), /repair does not bind/);
	const text = await readFile(path.join(journal.directory, `${intent.idempotencyKey}.json`), "utf8");
	assert(!text.includes("operator-code-review"));
	assert(!text.includes("repair-state.json"));
	const stored = JSON.parse(text);
	stored.control.testedTree = "f".repeat(40);
	await writeFile(path.join(journal.directory, `${intent.idempotencyKey}.json`), JSON.stringify(stored));
	await assert.rejects(new MissionResumeJournal(journal.directory).get(intent.idempotencyKey), /stored workflow repair/);
	stored.control.testedTree = binding().testedTree;
	stored.intentBinding.workflowRepair.reviewedPlanSha256 = hash("tampered review");
	await writeFile(path.join(journal.directory, `${intent.idempotencyKey}.json`), JSON.stringify(stored));
	await assert.rejects(new MissionResumeJournal(journal.directory).get(intent.idempotencyKey), /idempotency binding/);
});

test("a workflow repair plan composes with inherited unknown-operation quarantine", async t => {
	const { journal } = await fixture(t);
	const prior = repairIntentFor();
	const unresolved = ["old-goal/O001"];
	const action = classifyPendingAction("workflow-repair-needed", {
		unresolvedOperationRefs: unresolved, failedStage: "m04-judgment",
		evidenceRefs: ["repair-state.json"] });
	assert.equal(action.kind, "reconcile-m07-operation");
	const pendingActionSha256 = pendingActionIdentity(action);
	const intent: ResumeIntent = { ...prior, actionKind: action.kind, pendingAction: action,
		pendingActionSha256, quarantinedOperationRefs: unresolved,
		idempotencyKey: hash(canonical({ source: prior.source,
			envelopeSha256: prior.envelopeSha256, contractId: prior.contractId,
			selectedTupleSha256: prior.selectedTupleSha256, pendingActionSha256,
			workflowRepair: prior.workflowRepair })) };
	const reserved = await journal.reserve(intent, binding());
	assert.equal(reserved.intentBinding.actionKind, "reconcile-m07-operation");
	assert.deepEqual(await new MissionResumeJournal(journal.directory).get(intent.idempotencyKey),
		reserved);
	assert.deepEqual(intent.pendingAction.target?.operationRefs, unresolved);
	assert.equal(reserved.intentBinding.workflowRepair?.reviewedPlanSha256,
		prior.workflowRepair?.reviewedPlanSha256);
	await assert.rejects(journal.reserve({ ...intent, workflowRepair: undefined }, binding()),
		/private intent/);
});

test("reservation is durable across restart and never stores the raw pending action", async t => {
	const { journal } = await fixture(t), intent = intentFor();
	const control = { ...binding(), goal: "SECRET_GOAL",
		successfulCi: { ...binding().successfulCi, fees: "SECRET_FEES" } };
	const first = await journal.reserve(intent, control);
	assert.equal(first.state, "reserved");
	assert.deepEqual(await new MissionResumeJournal(journal.directory).reserve(intent, control), first);
	const text = await readFile(path.join(journal.directory, `${intent.idempotencyKey}.json`), "utf8");
	assert(!text.includes("pendingAction\""));
	assert(!text.includes("transportFailure"));
	assert(!text.includes("SECRET_GOAL"));
	assert(!text.includes("SECRET_FEES"));
	assert(!JSON.stringify(first.control).includes(intent.idempotencyKey));
	assert.equal((await stat(journal.directory)).mode & 0o077, 0);
	assert.equal((await stat(path.join(journal.directory, `${intent.idempotencyKey}.json`))).mode & 0o077, 0);
});

test("a same-key source tree or CI change fails and a different intent cannot displace unresolved work", async t => {
	const { journal } = await fixture(t), intent = intentFor();
	await journal.reserve(intent, binding());
	await assert.rejects(journal.reserve(intent, binding("c".repeat(40), "f".repeat(40))),
		/different binding/);
	await assert.rejects(journal.reserve(intent, binding("f".repeat(40))), /different binding/);
	await assert.rejects(journal.reserve(intent, { ...binding(), successfulCi: {
		...binding().successfulCi, runId: "9002" } }), /different binding/);
	await assert.rejects(journal.reserve(intentFor("model-reported-blocked"), binding()),
		/unresolved reservation/);
	await assert.rejects(journal.reserve({ ...intent, source: {
		...intent.source, commit: "f".repeat(40) } }, binding()), /idempotency key/);
});

test("an initialized control ref already at the tested source uses one parent", async t => {
	const { journal } = await fixture(t), intent = intentFor(), sourceCommit = "c".repeat(40);
	const initialized = { ...binding(), previousControlCommit: sourceCommit,
		parents: [sourceCommit], expectedBefore: sourceCommit };
	assert.equal((await journal.reserve(intent, initialized)).control.parents.length, 1);
	await assert.rejects(journal.reserve(intent, { ...initialized,
		parents: [sourceCommit, sourceCommit] }), /control descriptor/);
});

test("host-derived action provenance has a distinct durable identity", async t => {
	const { journal } = await fixture(t), carried = intentFor();
	const actionProvenance = { kind: "current-host-derived" as const,
		checkpointSha256: hash("exact checkpoint") };
	const derived = { ...carried, actionProvenance,
		idempotencyKey: hash(canonical({ actionProvenance, source: carried.source,
			envelopeSha256: carried.envelopeSha256, contractId: carried.contractId,
			selectedTupleSha256: carried.selectedTupleSha256,
			pendingActionSha256: carried.pendingActionSha256 })) };
	assert.notEqual(derived.idempotencyKey, carried.idempotencyKey);
	await journal.reserve(carried, binding());
	await assert.rejects(journal.reserve(derived, binding()), /unresolved reservation/);
	const other = new MissionResumeJournal(path.join(path.dirname(journal.directory), "other-private"));
	assert.deepEqual((await other.reserve(derived, binding())).intentBinding.actionProvenance,
		actionProvenance);
	await assert.rejects(other.reserve({ ...derived, actionProvenance: {
		...actionProvenance, checkpointSha256: hash("changed checkpoint") } }, binding()),
		/idempotency key/);
});

test("a changed private record fails closed on restart", async t => {
	const { journal } = await fixture(t), intent = intentFor();
	await journal.reserve(intent, binding());
	const file = path.join(journal.directory, `${intent.idempotencyKey}.json`);
	const stored = JSON.parse(await readFile(file, "utf8"));
	stored.control.successfulCi.headCommit = "f".repeat(40);
	await writeFile(file, JSON.stringify(stored), { mode: 0o600 });
	await assert.rejects(new MissionResumeJournal(journal.directory).get(intent.idempotencyKey),
		/control descriptor/);
});

test("a stored provider availability audit cannot claim a different terminal or tested source", async t => {
	const { journal } = await fixture(t);
	const intent = intentFor();
	await journal.reserve(intent, binding());
	const file = path.join(journal.directory, `${intent.idempotencyKey}.json`);
	const stored = JSON.parse(await readFile(file, "utf8"));
	stored.providerAvailabilityAudit = {
		kind: "host-verified-provider-availability-audit",
		receiptSha256: hash("operator review"),
		terminalSource: { ...source, runId: "7003" },
		terminalEnvelopeSha256: intent.envelopeSha256,
		testedSourceCommit: binding().testedSourceCommit,
		probeSource: { runId: "8002", runAttempt: 1, commit: "f".repeat(40) },
		workflowId: "92", jobId: "8202", artifactId: "9302",
		archiveSha256: hash("archive"), envelopeSha256: hash("envelope") };
	await writeFile(file, JSON.stringify(stored));
	await assert.rejects(new MissionResumeJournal(journal.directory).get(intent.idempotencyKey),
		/stored provider availability audit is invalid/);
	stored.providerAvailabilityAudit.terminalSource = source;
	stored.providerAvailabilityAudit.testedSourceCommit = "a".repeat(40);
	await writeFile(file, JSON.stringify(stored));
	await assert.rejects(new MissionResumeJournal(journal.directory).get(intent.idempotencyKey),
		/stored provider availability audit is invalid/);
});

test("a crash after attempt and unknown delivery cannot cause a second update", async t => {
	const { journal } = await fixture(t), intent = intentFor();
	await journal.reserve(intent, binding());
	await journal.markAttempted(intent.idempotencyKey);
	const restarted = new MissionResumeJournal(journal.directory);
	assert.equal((await restarted.get(intent.idempotencyKey))?.state, "ref-update-attempted");
	await assert.rejects(restarted.markAttempted(intent.idempotencyKey), /cannot be reissued/);
	await restarted.markDeliveryUnknown(intent.idempotencyKey);
	assert.equal((await new MissionResumeJournal(journal.directory).unresolvedForRef(binding().controlRef))?.state,
		"delivery-unknown");
	await assert.rejects(restarted.reserve(intentFor("model-reported-blocked"), binding()),
		/unresolved reservation/);
	const accepted = await restarted.acknowledge(intent.idempotencyKey, {
		kind: "read-only-accepted-control", controlRef: binding().controlRef,
		controlCommit: "f".repeat(40), tree: binding().testedTree,
		parents: binding().parents, message: binding().message, successorRunId: "9003" });
	assert.equal(accepted.state, "acknowledged");
	assert.equal((await restarted.unresolvedForRef(binding().controlRef)), undefined);
	await assert.rejects(restarted.reserve(intentFor("model-reported-blocked"), binding()),
		/acknowledged tip/);
	const next = { ...binding(), previousControlCommit: "f".repeat(40),
		parents: [binding().testedSourceCommit, "f".repeat(40)], expectedBefore: "f".repeat(40) };
	assert.equal((await restarted.reserve(intentFor("model-reported-blocked"), next)).state,
		"reserved");
});

test("an acknowledged linked successor does not silently settle the old unknown attempt", async t => {
	const { journal } = await fixture(t), prior = intentFor();
	await journal.reserve(prior, binding());
	await journal.markAttempted(prior.idempotencyKey);
	const oldControlCommit = "f".repeat(40);
	const changed = { ...binding("a".repeat(40)), previousControlCommit: oldControlCommit,
		expectedBefore: oldControlCommit, parents: ["a".repeat(40), oldControlCommit],
		successfulCi: { ...binding("a".repeat(40)).successfulCi, runId: "9002" } };
	const linkedUnknownDelivery = { version: 1 as const,
		kind: "host-verified-linked-unknown-delivery" as const,
		oldJournalKey: prior.idempotencyKey, oldControlCommit,
		oldSourceReviewReceiptSha256: hash("reviewed old source"),
		ancestry: [{ oldJournalKey: prior.idempotencyKey, oldControlCommit }],
		oldTestedSourceCommit: binding().testedSourceCommit, oldTestedTree: binding().testedTree,
		liveControlHead: oldControlCommit,
		census: { kind: "authenticated-complete-actions-run-census" as const,
			headCommit: oldControlCommit, totalCount: 0 as const, pagesRead: 1 as const,
			sha256: hash("authenticated census") },
		newTestedSourceCommit: changed.testedSourceCommit, newTestedTree: changed.testedTree,
		newSuccessfulCi: changed.successfulCi, sourceRefTip: changed.sourceRefTip,
		accounting: "unquantified" as const, effects: "unknown-unreconciled" as const };
	const linked: ResumeIntent = { ...prior, linkedUnknownDelivery,
		idempotencyKey: hash(canonical({ source: prior.source,
			envelopeSha256: prior.envelopeSha256, contractId: prior.contractId,
			selectedTupleSha256: prior.selectedTupleSha256,
			pendingActionSha256: prior.pendingActionSha256, linkedUnknownDelivery })) };
	await journal.reserve(linked, changed);
	assert.equal((await journal.get(prior.idempotencyKey))?.state, "delivery-unknown");
	await assert.rejects(journal.acknowledge(prior.idempotencyKey, {
		kind: "read-only-accepted-control", controlRef: binding().controlRef,
		controlCommit: oldControlCommit, tree: binding().testedTree,
		parents: binding().parents, message: binding().message,
		successorRunId: "9005" }), /remains delivery-unknown/);
	await assert.rejects(journal.reconcileNotDelivered(prior.idempotencyKey, {
		kind: "read-only-not-delivered", controlRef: binding().controlRef,
		observedHead: binding().expectedBefore, matchingRunCount: 0,
		pendingDeliveryExcluded: true }), /remains delivery-unknown/);
	await journal.markAttempted(linked.idempotencyKey);
	await journal.acknowledge(linked.idempotencyKey, {
		kind: "read-only-accepted-control", controlRef: binding().controlRef,
		controlCommit: "1".repeat(40), tree: changed.testedTree,
		parents: changed.parents, message: changed.message, successorRunId: "9004" });
	const fakeCarry = { proof: { source: { runId: "9004", runAttempt: 1,
		commit: "1".repeat(40) }, envelopeSha256: hash("fake carry") }, privateBundle: {} } as
		unknown as Parameters<MissionResumeJournal["markUnknownLineageCarried"]>[1];
	await assert.rejects(journal.markUnknownLineageCarried(linked.idempotencyKey, fakeCarry),
		/does not seal/);
	assert.equal((await journal.unresolvedForRef(binding().controlRef))?.idempotencyKey,
		prior.idempotencyKey);
	assert.equal((await journal.get(prior.idempotencyKey))?.state, "delivery-unknown");
	const third = { ...changed, previousControlCommit: "1".repeat(40),
		expectedBefore: "1".repeat(40), parents: [changed.testedSourceCommit, "1".repeat(40)] };
	await assert.rejects(journal.reserve(intentFor("model-reported-blocked"), third),
		/unresolved reservation/);
});

test("two consecutive accepted zero-run controls retain the full oldest-to-newest ancestry", async t => {
	const { journal } = await fixture(t), original = intentFor();
	await journal.reserve(original, binding());
	await journal.markAttempted(original.idempotencyKey);
	const firstCommit = "f".repeat(40);
	const firstControl: TestedControlBinding = { ...binding("a".repeat(40)),
		previousControlCommit: firstCommit, expectedBefore: firstCommit,
		parents: ["a".repeat(40), firstCommit],
		successfulCi: { ...binding("a".repeat(40)).successfulCi, runId: "9002" } };
	const firstLink: NonNullable<ResumeIntent["linkedUnknownDelivery"]> = {
		version: 1, kind: "host-verified-linked-unknown-delivery",
		oldJournalKey: original.idempotencyKey, oldControlCommit: firstCommit,
		oldSourceReviewReceiptSha256: hash("first old source review"),
		ancestry: [{ oldJournalKey: original.idempotencyKey, oldControlCommit: firstCommit }],
		oldTestedSourceCommit: binding().testedSourceCommit,
		oldTestedTree: binding().testedTree, liveControlHead: firstCommit,
		census: { kind: "authenticated-complete-actions-run-census", headCommit: firstCommit,
			totalCount: 0, pagesRead: 1, sha256: hash("first census") },
		newTestedSourceCommit: firstControl.testedSourceCommit,
		newTestedTree: firstControl.testedTree, newSuccessfulCi: firstControl.successfulCi,
		sourceRefTip: firstControl.sourceRefTip,
		accounting: "unquantified", effects: "unknown-unreconciled" };
	const linkedIntent = (linkedUnknownDelivery: NonNullable<ResumeIntent["linkedUnknownDelivery"]>):
		ResumeIntent => ({ ...original, linkedUnknownDelivery,
		idempotencyKey: hash(canonical({ source: original.source,
			envelopeSha256: original.envelopeSha256, contractId: original.contractId,
			selectedTupleSha256: original.selectedTupleSha256,
			pendingActionSha256: original.pendingActionSha256, linkedUnknownDelivery })) });
	const first = linkedIntent(firstLink);
	await journal.reserve(first, firstControl);
	await journal.markAttempted(first.idempotencyKey);
	const secondCommit = "2".repeat(40);
	const secondControl: TestedControlBinding = { ...binding("3".repeat(40)),
		previousControlCommit: secondCommit, expectedBefore: secondCommit,
		parents: ["3".repeat(40), secondCommit],
		successfulCi: { ...binding("3".repeat(40)).successfulCi, runId: "9006" } };
	const secondLink: NonNullable<ResumeIntent["linkedUnknownDelivery"]> = {
		...firstLink, oldJournalKey: first.idempotencyKey, oldControlCommit: secondCommit,
		oldSourceReviewReceiptSha256: hash("second old source review"),
		ancestry: [...firstLink.ancestry,
			{ oldJournalKey: first.idempotencyKey, oldControlCommit: secondCommit }],
		oldTestedSourceCommit: firstControl.testedSourceCommit,
		oldTestedTree: firstControl.testedTree, liveControlHead: secondCommit,
		census: { ...firstLink.census, headCommit: secondCommit, sha256: hash("second census") },
		newTestedSourceCommit: secondControl.testedSourceCommit,
		newTestedTree: secondControl.testedTree,
		newSuccessfulCi: secondControl.successfulCi,
		sourceRefTip: secondControl.sourceRefTip };
	const second = linkedIntent(secondLink);
	assert.deepEqual(await journal.ancestryForAcceptedUnknown(first.idempotencyKey, secondCommit),
		secondLink.ancestry);
	await journal.reserve(second, secondControl);
	assert.equal((await journal.get(first.idempotencyKey))?.state, "delivery-unknown");
	assert.equal((await journal.unresolvedForRef(binding().controlRef))?.idempotencyKey,
		second.idempotencyKey);
	const tampered = linkedIntent({ ...secondLink,
		ancestry: secondLink.ancestry.slice(1) });
	await assert.rejects(journal.reserve(tampered, secondControl), /linked|ancestry/);
});

test("read-only reconciliation must match the expected control commit facts", async t => {
	const { journal } = await fixture(t), intent = intentFor();
	await journal.reserve(intent, binding());
	await journal.markAttempted(intent.idempotencyKey);
	await assert.rejects(journal.acknowledge(intent.idempotencyKey, {
		kind: "read-only-accepted-control", controlRef: binding().controlRef,
		controlCommit: "f".repeat(40), tree: "a".repeat(40),
		parents: binding().parents, message: binding().message, successorRunId: "9003" }),
		/does not match/);
	await assert.rejects(journal.acknowledge(intent.idempotencyKey, {
		kind: "read-only-accepted-control", controlRef: binding().controlRef,
		controlCommit: binding().expectedBefore!, tree: binding().testedTree,
		parents: binding().parents, message: binding().message, successorRunId: "9003" }),
		/does not match/);
	await assert.rejects(journal.reconcileNotDelivered(intent.idempotencyKey, {
		kind: "read-only-not-delivered", controlRef: binding().controlRef,
		observedHead: "f".repeat(40), matchingRunCount: 0, pendingDeliveryExcluded: true }),
		/does not exclude/);
	assert.equal((await journal.reconcileNotDelivered(intent.idempotencyKey, {
		kind: "read-only-not-delivered", controlRef: binding().controlRef,
		observedHead: binding().expectedBefore, matchingRunCount: 0,
		pendingDeliveryExcluded: true })).state, "reconciled-not-delivered");
	const restarted = new MissionResumeJournal(journal.directory);
	assert.equal((await restarted.rearmAfterReconciliation(intent.idempotencyKey)).state, "reserved");
	assert.equal((await restarted.markAttempted(intent.idempotencyKey)).negativeReconciliations, 1);
	await assert.rejects(restarted.markAttempted(intent.idempotencyKey), /cannot be reissued/);
});

test("concurrent reservations compare-and-swap the same control ref", async t => {
	const { journal } = await fixture(t);
	const first = intentFor(), second = intentFor("model-reported-blocked");
	const results = await Promise.allSettled([
		journal.reserve(first, binding()),
		new MissionResumeJournal(journal.directory).reserve(second, binding()),
	]);
	assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
	assert.equal(results.filter(result => result.status === "rejected").length, 1);
	assert((await journal.unresolvedForRef(binding().controlRef)) !== undefined);
});

test("a crashed lock owner is recovered without losing the durable reservation", async t => {
	const { journal } = await fixture(t), intent = intentFor();
	await journal.reserve(intent, binding());
	const lock = path.join(journal.directory, ".lock");
	await mkdir(lock, { mode: 0o700 });
	await writeFile(path.join(lock, "owner.json"), JSON.stringify({ host: os.hostname(), pid: 99999999,
		boot: (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim(),
		start: "1" }), { mode: 0o600 });
	assert.equal((await new MissionResumeJournal(journal.directory).get(intent.idempotencyKey))?.state,
		"reserved");
});

test("a lock from a different host fails closed", async t => {
	const { journal } = await fixture(t), intent = intentFor();
	await journal.reserve(intent, binding());
	const lock = path.join(journal.directory, ".lock");
	await mkdir(lock, { mode: 0o700 });
	await writeFile(path.join(lock, "owner.json"), JSON.stringify({ host: "another-host",
		pid: 99999999, boot: "different-boot", start: "1" }), { mode: 0o600 });
	await assert.rejects(new MissionResumeJournal(journal.directory).get(intent.idempotencyKey),
		/different host/);
});
