import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, rename, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { LocalMissionHost, type LocalEvaluatorRecoveryReviewV1 } from "../src/runner/local-mission-host.ts";
import type { ProcessIdentityV1, ProcessProbe } from "../src/runtime/process-identity.ts";

const sha = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
const owner: ProcessIdentityV1 = { hostId: "local-host", bootId: "local-boot", pid: 1001,
	processStartToken: "owner-1001" };
const successor: ProcessIdentityV1 = { ...owner, pid: 1002, processStartToken: "successor-1002" };
const reviewer: ProcessIdentityV1 = { ...owner, pid: 1003, processStartToken: "reviewer-1003" };
const dead = async (): Promise<ProcessProbe> => ({ status: "dead", identityMatch: false,
	reason: "synthetic" });
const alive = async (): Promise<ProcessProbe> => ({ status: "alive", identityMatch: true,
	reason: "synthetic" });
async function put(file: string, value: string | object, mode = 0o600): Promise<string> {
	await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
	const bytes = typeof value === "string" ? value : `${JSON.stringify(value)}\n`;
	await writeFile(file, bytes, { mode });
	return sha(bytes);
}
async function phase(dir: string, name: string, value: object): Promise<string> {
	const hash = await put(path.join(dir, `${name}.json`), value);
	await put(path.join(dir, `${name}.sha256`), `${hash}\n`);
	await chmod(path.join(dir, `${name}.json`), 0o400);
	await chmod(path.join(dir, `${name}.sha256`), 0o400);
	return hash;
}
async function replacePhase(dir: string, name: string, value: object): Promise<string> {
	await unlink(path.join(dir, `${name}.json`));
	await unlink(path.join(dir, `${name}.sha256`));
	return phase(dir, name, value);
}
async function fixture(t: TestContext, form: "original" | "later" | "unrelated" = "original",
	terminal: "returned" | "settled-failure" = "settled-failure", withM04 = false) {
	const ws = await mkdtemp(path.join(os.tmpdir(), "host-evaluator-review-"));
	t.after(() => rm(ws, { recursive: true, force: true }));
	const missionId = "mission-001", intentId = "intent-001", runId = "m07-001";
	const taskId = "T001", operationId = "O001", checkpointId = "C001";
	const root = path.join(ws, ".agent", "missions", missionId);
	await mkdir(path.dirname(root), { recursive: true, mode: 0o700 });
	const host = await LocalMissionHost.begin({ root, missionId, attemptId: "A001",
		codeRevision: "test-revision", currentIdentity: async () => owner });
	const contract = { id: missionId, goal: "A test objective", obligations: [] };
	await host.recordInitialContract({ attemptId: "A001", bytes: Buffer.from(`${JSON.stringify(contract)}\n`) });
	const nextTask = { objective: "Synthetic M07 task", addresses: [], adapterScope: "local-m07-execute" };
	const old = { version: 1, kind: "original-objective-progress", contract,
		objectiveOutcome: "incomplete", stopReason: "execution-interrupted",
		assessment: { nextTask }, assessmentHistory: [], boundedRuns: [],
		selectedArtifacts: [], availableArtifacts: [], continuation: {
			mode: "reconcile-operations-before-new-run", unresolvedOperationIds: [intentId],
			pendingAction: { version: 1, author: "host", kind: "reconcile-interrupted-run",
				safety: "no-replay-until-reconciled", target: { goalRunId: intentId } } } };
	const first = await host.recordCheckpoint({ attemptId: "A001", sequence: 1,
		previousSha256: null, bytes: Buffer.from(`${JSON.stringify(old)}\n`) });
	const heldRefs = (form === "unrelated" ? [intentId, runId, "unrelated-operation"] :
		[intentId, runId]).sort();
	const held = form !== "original" ? { ...old, continuation: { ...old.continuation,
		unresolvedOperationIds: heldRefs,
		pendingAction: { ...old.continuation.pendingAction,
			target: { operationRefs: heldRefs } } } } : old;
	const latestHost = form !== "original" ? await LocalMissionHost.begin({ root, missionId,
		attemptId: "A002", codeRevision: "test-revision", currentIdentity: async () => reviewer,
		probePrior: dead }) : host;
	const latest = form !== "original" ? await latestHost.recordCheckpoint({ attemptId: "A002", sequence: 2,
		previousSha256: first.sha256, bytes: Buffer.from(`${JSON.stringify(held)}\n`) }) : first;
	const m07 = path.join(ws, "stages", "M07", runId);
	const taskRoot = path.join(m07, "tasks", taskId);
	const work = path.join(taskRoot, "work");
	const cp = path.join(m07, "checkpoints", checkpointId);
	await mkdir(work, { recursive: true, mode: 0o700 });
	await mkdir(cp, { recursive: true, mode: 0o700 });
	await mkdir(path.join(taskRoot, "host-evaluator-output"), { mode: 0o700 });
	await mkdir(path.join(taskRoot, terminal === "returned" ? "host-evaluator-snapshot" :
		"host-evaluator-failure-snapshot"), { mode: 0o700 });
	const missionRunSha256 = await put(path.join(ws, "stages", "MISSION", intentId, "run.json"),
		{ stage: "MISSION", runId: intentId, status: "running",
			inputs: [{ path: path.join(root, "evidence", "original-objective.json") }] });
	const report = path.join(work, "report.md");
	await put(report, "synthetic report\n");
	const candidate = path.join(taskRoot, "evaluator-snapshot", "candidate-001.md");
	const candidateSha = await put(candidate, "synthetic report\n");
	const entered = { version: 1, kind: "local-evaluator-attempt", attemptId: "attempt-001",
		missionId, runId, taskId, evaluator: { id: "fake-evaluator", version: "v1" },
		process: owner, candidate: [{ name: "candidate-001.md", file: candidate,
			sourceFile: report, bytes: 17, sha256: candidateSha }], frozenEvidence: [],
		resolvedFailures: [] };
	const journal = path.join(taskRoot, "host-evaluator-attempt");
	await mkdir(journal, { mode: 0o700 });
	const preparedSha256 = await phase(journal, "prepared", { version: 1,
		kind: "local-evaluator-prepared-input", missionId, runId, taskId,
		evaluator: entered.evaluator, candidate: entered.candidate,
		frozenEvidence: entered.frozenEvidence, resolvedFailures: entered.resolvedFailures });
	const enteredSha256 = await phase(journal, "entered", entered);
	if (terminal === "settled-failure") await phase(journal, "threw", { version: 1,
		kind: "local-evaluator-threw", attemptId: entered.attemptId, process: owner });
	if (terminal === "returned") await phase(journal, "returned-uncommitted", { version: 1,
		kind: "local-evaluator-returned-uncommitted", attemptId: entered.attemptId, process: owner });
	const phaseSha256 = terminal === "settled-failure" ? await phase(journal, "settled-failure", {
		version: 1, kind: "local-evaluator-settled-failure", attemptId: entered.attemptId,
		proof: { attemptId: entered.attemptId, process: owner, operationId: "evaluator-operation",
			childProcesses: [], settledEffect: "no-effect", evidence: "synthetic settlement" },
		partialOutputs: [] }) : await phase(journal, "returned", { version: 1,
		kind: "local-evaluator-returned", attemptId: entered.attemptId,
		result: { checks: [], observations: [], limitations: [] }, outputs: [] });
	const receiptSha256 = terminal === "returned" ? await put(path.join(work,
		"local-evaluator-receipt.json"), { version: 1, kind: "local-evaluator-receipt",
		missionId, runId, taskId, evaluator: entered.evaluator, candidate: entered.candidate,
		frozenEvidence: [], observations: [], checks: [], limitations: [] }) : null;
	const goal = { runId, problemRelation: `Local original objective mission: ${missionId}\n${contract.goal}`,
		tasks: [{ taskId, status: terminal === "returned" ? "accepted" : "rejected",
			...(terminal === "returned" ? { review: { checks: [] } } : {}),
			workDir: work, inputs: ["synthetic-input"], checks: ["Synthetic check"] }],
		executionState: { attempts: [{ runDescriptor: { process: owner } }],
			operations: [{ id: operationId, taskId, status: "response-received" }] },
		checkpoints: [{ id: checkpointId, rootDir: cp, goalSnapshotPath: path.join(cp, "goal.json"),
			manifestPath: path.join(cp, "manifest.json"), feedbackPath: path.join(cp, "m04-feedback.md"),
			feedbackStatus: "complete" }] };
	const goalSha256 = await put(path.join(m07, "goal.json"), goal);
	const snapshotSha256 = await put(path.join(cp, "goal.json"), goal);
	const manifestSha256 = await put(path.join(cp, "manifest.json"),
		{ m07RunId: runId, checkpointId, selectedTaskIds: [taskId] });
	const feedbackSha256 = await put(path.join(cp, "m04-feedback.md"), "Negative feedback\n");
	const m04RunId = "m04-001";
	const m04 = path.join(ws, "stages", "M04", m04RunId);
	const requiredM07ReadPaths = ["goal.json", "manifest.json", "m04-feedback.md"];
	const m04Facts = withM04 ? { runId: m04RunId,
		runSha256: await put(path.join(m04, "run.json"), { stage: "M04", runId: m04RunId,
			status: "completed", inputs: [{ path: path.join(cp, "manifest.json") },
				{ path: path.join(cp, "m04-feedback.md") }] }),
		sourceSha256: await put(path.join(m04, "m07-source.json"), {
			m07RunId: runId, checkpointId, feedbackBundlePath: path.join(cp, "m04-feedback.md"),
			goalSnapshotPath: path.join(cp, "goal.json"), manifestPath: path.join(cp, "manifest.json") }),
		transactionSha256: await put(path.join(m04, "m04-transaction.json"), {
			version: 1, kind: "m04-knowledge-transaction", m04RunId, state: "no-proposal" }),
		coverageSha256: await put(path.join(m04, "m07-coverage.json"), {
			promptOutcome: "returned", returnedRanges: requiredM07ReadPaths.map(file => ({
				toolName: "m07_evidence_read", path: file, status: "returned",
				returned: { kind: "text", startLine: 1, endLine: 1, truncated: false } })) }),
		requiredM07ReadPaths } : undefined;
	const lineage = { version: 1, kind: "local-mission-m07-dispatch-lineage", missionId, intentId,
		oldAttempt: host.source, intentCheckpoint: { sequence: first.sequence, sha256: first.sha256 },
		m07RunId: runId, taskId, assessorTaskSha256: sha(JSON.stringify(nextTask)),
		m07TaskInputsSha256: sha(JSON.stringify(goal.tasks[0].inputs)),
		m07TaskChecksSha256: sha(JSON.stringify(goal.tasks[0].checks)), m07Owner: owner };
	const lineageSha256 = await put(path.join(root, "dispatch-links", `${intentId}.json`), lineage);
	await put(path.join(m07, "mission-dispatch-link.json"), lineage);
	await put(path.join(root, "dispatch-links", `${intentId}.commit.json`),
		{ version: 1, kind: "local-mission-m07-dispatch-commit", intentId, lineageSha256 });
	const reviewBase: Omit<LocalEvaluatorRecoveryReviewV1, "recoveryClaim"> = { version: 1,
		kind: "local-evaluator-interruption-host-review", missionId, intentId, missionRunSha256,
		lineageSha256, dispatchOriginAttempt: host.source, oldAttempt: latestHost.source,
		oldCheckpoint: { sequence: latest.sequence, sha256: latest.sha256 },
		newAttempt: { version: 1, missionId, attemptId: form !== "original" ? "A003" : "A002",
			predecessorAttemptId: latestHost.source.attemptId,
			codeRevision: "test-revision", process: successor },
		m07: { runId, taskId, operationId, checkpointId, goalSha256, snapshotSha256,
			manifestSha256, feedbackSha256 },
		evaluator: { id: entered.evaluator.id, version: entered.evaluator.version,
			attemptId: entered.attemptId, owner, preparedSha256, enteredSha256,
			phase: terminal, phaseSha256,
			receiptSha256 }, ...(m04Facts ? { m04: m04Facts } : {}),
		boundary: "fresh-work-only-no-builder-or-evaluator-replay" };
	const next = { ...held, stopReason: "objective-reassessment-pending",
		boundedRuns: [{ runId, outcome: "partial",
			acceptedTaskIds: terminal === "returned" ? [taskId] : [] }],
		continuation: { ...held.continuation, mode: "explicit-authorized-new-run",
			unresolvedOperationIds: [], pendingAction: { version: 1, author: "host",
				kind: "fresh-m07-task", safety: "fresh-work-only",
				reasonCode: "objective-reassessment-pending" } } };
	const acquired = await LocalMissionHost.claimEvaluatorRecovery({ root, missionId, intentId,
		oldCheckpointSequence: latest.sequence, oldCheckpointSha256: latest.sha256,
		currentIdentity: async () => successor, probePrior: dead });
	assert.equal(acquired.state, "claimed");
	if (acquired.state !== "claimed") throw new Error("synthetic claim was not acquired");
	const review: LocalEvaluatorRecoveryReviewV1 = { ...reviewBase,
		recoveryClaim: { claimId: acquired.claim.claimId, owner: acquired.claim.owner,
			oldCheckpointSha256: acquired.claim.oldCheckpoint.sha256,
			predecessors: acquired.claim.predecessors } };
	const commit = (overrides: Partial<Parameters<typeof LocalMissionHost.commitReviewedSuccessor>[0]> = {}) =>
		LocalMissionHost.commitReviewedSuccessor({ root, missionId, review, claim: acquired.claim,
			bytes: Buffer.from(`${JSON.stringify(next)}\n`), currentIdentity: async () => successor,
			probePrior: dead, verifyEvidence: async () => {}, ...overrides });
	return { root, ws, review, next, commit, claim: acquired.claim, latestHost,
		journal, m07, m04, taskRoot };
}
async function orphanFixture(t: TestContext, shape: "pending" | "partial" | "complete" = "pending") {
	const f = await fixture(t);
	const originalPrepared = await readFile(path.join(f.journal, "prepared.json"));
	for (const name of await readdir(f.journal)) await unlink(path.join(f.journal, name));
	await mkdir(path.join(f.taskRoot, "host-evaluator-snapshot"), { mode: 0o700 });
	let orphanMembers: Array<{ name: "prepared.json.pending" | "prepared.json" |
		"prepared.sha256.pending"; sha256: string }>;
	if (shape === "pending") orphanMembers = [{ name: "prepared.json.pending",
		sha256: await put(path.join(f.journal, "prepared.json.pending"), "", 0o400) }];
	else {
		orphanMembers = [{ name: "prepared.json",
			sha256: await put(path.join(f.journal, "prepared.json"),
				shape === "complete" ? originalPrepared.toString("utf8") : "{", 0o400) }];
		if (shape === "partial") orphanMembers.push({ name: "prepared.sha256.pending",
			sha256: await put(path.join(f.journal, "prepared.sha256.pending"), "partial", 0o400) });
	}
	const goalFile = path.join(f.m07, "goal.json");
	const goal = JSON.parse(await readFile(goalFile, "utf8"));
	goal.tasks[0].review = { checks: [{ criterion: "Synthetic check", result: "not_run" }] };
	const goalSha256 = await put(goalFile, goal);
	const snapshotFile = path.join(f.m07, "checkpoints", f.review.m07.checkpointId, "goal.json");
	const snapshot = JSON.parse(await readFile(snapshotFile, "utf8"));
	snapshot.tasks[0].review = goal.tasks[0].review;
	const snapshotSha256 = await put(snapshotFile, snapshot);
	const review: LocalEvaluatorRecoveryReviewV1 = { ...f.review,
		m07: { ...f.review.m07, goalSha256, snapshotSha256 },
		evaluator: { id: f.review.evaluator.id, version: f.review.evaluator.version,
			phase: "pre-entry-unlocated", orphanMembers } };
	return { ...f, review };
}

test("V4 records zero-byte orphan preparation as negative-only", async t => {
	const f = await orphanFixture(t);
	const receipt = await f.commit({ review: f.review });
	assert.equal(receipt.version, 4);
	assert.equal(receipt.evaluatorRecoveryReview?.evaluator.phase, "pre-entry-unlocated");
	assert.deepEqual(JSON.parse((await LocalMissionHost.readLatestCheckpoint(f.root))!.toString())
		.boundedRuns[0].acceptedTaskIds, []);
	assert.equal((await LocalMissionHost.status(f.root)).repairRequired, false);
	await chmod(path.join(f.journal, "prepared.json.pending"), 0o600);
	await writeFile(path.join(f.journal, "prepared.json.pending"), "tampered");
	await chmod(path.join(f.journal, "prepared.json.pending"), 0o400);
	assert.equal((await LocalMissionHost.status(f.root)).repairRequired, true);
});

test("V4 records partial prepared JSON plus pending seal as negative-only", async t => {
	const f = await orphanFixture(t, "partial");
	assert.equal((await f.commit({ review: f.review })).version, 4);
	assert.equal((await LocalMissionHost.status(f.root)).repairRequired, false);
});

test("V4 refuses an unsealed complete locator or orphan observation output", async t => {
	await t.test("complete locator", async t => {
		const f = await orphanFixture(t, "complete");
		await assert.rejects(f.commit({ review: f.review }), /complete prepared evaluator input/);
	});
	await t.test("orphan output", async t => {
		const f = await orphanFixture(t);
		await put(path.join(f.taskRoot, "host-evaluator-output", "observation-extra.txt"), "unsafe");
		await assert.rejects(f.commit({ review: f.review }), /observation directories/);
	});
});

test("recovery claim admits one owner and blocks ordinary mission writes", async t => {
	const f = await fixture(t);
	const argumentsForClaim = { root: f.root, missionId: f.review.missionId,
		intentId: f.review.intentId, oldCheckpointSequence: f.review.oldCheckpoint.sequence,
		oldCheckpointSha256: f.review.oldCheckpoint.sha256 };
	const retried = await LocalMissionHost.claimEvaluatorRecovery({ ...argumentsForClaim,
		currentIdentity: async () => successor, probePrior: dead });
	assert.deepEqual(retried, { state: "claimed", claim: f.claim });
	const held = await LocalMissionHost.claimEvaluatorRecovery({ ...argumentsForClaim,
		currentIdentity: async () => reviewer,
		probePrior: identity => identity.pid === owner.pid ? dead() : alive() });
	assert.deepEqual(held, { state: "held-by-live-owner" });
	await assert.rejects(f.latestHost.recordCheckpoint({ attemptId: f.latestHost.source.attemptId,
		sequence: f.review.oldCheckpoint.sequence + 1,
		previousSha256: f.review.oldCheckpoint.sha256, bytes: Buffer.from("held\n") }),
		/active evaluator recovery claim/);
	await assert.rejects(LocalMissionHost.begin({ root: f.root, missionId: f.review.missionId,
		attemptId: f.review.newAttempt.attemptId, codeRevision: "test-revision",
		currentIdentity: async () => reviewer, probePrior: dead }), /active evaluator recovery claim/);
	await LocalMissionHost.releaseEvaluatorRecoveryClaim({ root: f.root, claim: f.claim,
		currentIdentity: async () => successor });
	assert.equal((await LocalMissionHost.status(f.root)).evaluatorRecoveryClaim, null);
	const winners = await Promise.all([successor, reviewer].map(identity =>
		LocalMissionHost.claimEvaluatorRecovery({ ...argumentsForClaim,
			currentIdentity: async () => identity,
			probePrior: probed => probed.pid === owner.pid ? dead() : alive() })));
	assert.equal(winners.filter(item => item.state === "claimed").length, 1);
	assert.equal(winners.filter(item => item.state === "held-by-live-owner").length, 1);
});

test("dead claim writer lock is recoverable only on the same host and boot", async t => {
	const f = await fixture(t);
	await LocalMissionHost.releaseEvaluatorRecoveryClaim({ root: f.root, claim: f.claim,
		currentIdentity: async () => successor });
	const args = { root: f.root, missionId: f.review.missionId, intentId: f.review.intentId,
		oldCheckpointSequence: f.review.oldCheckpoint.sequence,
		oldCheckpointSha256: f.review.oldCheckpoint.sha256 };
	await assert.rejects(LocalMissionHost.claimEvaluatorRecovery({ ...args,
		currentIdentity: async () => successor, probePrior: dead,
		testCrashAt: "after-claim-publish" }), /synthetic crash/);
	assert.equal((await LocalMissionHost.status(f.root)).writerLockPresent, true);
	assert.equal((await LocalMissionHost.status(f.root)).evaluatorRecoveryClaim?.owner.pid, successor.pid);
	await assert.rejects(LocalMissionHost.recoverReviewLock({ root: f.root,
		intentId: f.review.intentId, oldCheckpointSha256: f.review.oldCheckpoint.sha256,
		currentIdentity: async () => reviewer, probePrior: alive }), /may still be live/);
	await LocalMissionHost.recoverReviewLock({ root: f.root,
		intentId: f.review.intentId, oldCheckpointSha256: f.review.oldCheckpoint.sha256,
		currentIdentity: async () => reviewer, probePrior: dead });
	const succeeded = await LocalMissionHost.claimEvaluatorRecovery({ ...args,
		currentIdentity: async () => reviewer, probePrior: dead });
	assert.equal(succeeded.state, "claimed");
	if (succeeded.state === "claimed") assert.equal(succeeded.claim.owner.pid, reviewer.pid);
});

test("V4 release permits a later, unrelated evaluator recovery claim", async t => {
	const f = await fixture(t);
	const first = await f.commit();
	assert.equal((await LocalMissionHost.status(f.root)).evaluatorRecoveryClaim, null);
	const nextHost = await LocalMissionHost.begin({ root: f.root, missionId: f.review.missionId,
		attemptId: "A003", codeRevision: "test-revision", currentIdentity: async () => reviewer,
		probePrior: dead });
	const intentId = "intent-002";
	const second = { ...f.next, stopReason: "execution-interrupted",
		continuation: { ...f.next.continuation, mode: "reconcile-operations-before-new-run",
			unresolvedOperationIds: [intentId], pendingAction: { version: 1, author: "host",
				kind: "reconcile-interrupted-run", safety: "no-replay-until-reconciled",
				target: { goalRunId: intentId } } } };
	const held = await nextHost.recordCheckpoint({ attemptId: "A003", sequence: first.sequence + 1,
		previousSha256: first.sha256, bytes: Buffer.from(`${JSON.stringify(second)}\n`) });
	const acquired = await LocalMissionHost.claimEvaluatorRecovery({ root: f.root,
		missionId: f.review.missionId, intentId,
		oldCheckpointSequence: held.sequence, oldCheckpointSha256: held.sha256,
		currentIdentity: async () => successor, probePrior: dead });
	assert.equal(acquired.state, "claimed");
});

test("V4 binds a pre-entry evaluator started by the recovery claimant", async t => {
	const f = await fixture(t, "original", "returned");
	const entered = JSON.parse(await readFile(path.join(f.journal, "entered.json"), "utf8"));
	entered.process = successor;
	const enteredSha256 = await replacePhase(f.journal, "entered", entered);
	const marker = JSON.parse(await readFile(path.join(f.journal,
		"returned-uncommitted.json"), "utf8"));
	marker.process = successor;
	await replacePhase(f.journal, "returned-uncommitted", marker);
	const evaluator = f.review.evaluator;
	if (evaluator.phase === "pre-entry-unlocated") throw new Error("expected entered evaluator");
	const review: LocalEvaluatorRecoveryReviewV1 = { ...f.review,
		evaluator: { ...evaluator, owner: successor, enteredSha256 } };
	assert.equal((await f.commit({ review })).version, 4);
	assert.equal((await LocalMissionHost.status(f.root)).repairRequired, false);
});

test("V4 authenticates a dead prior claimant after a second recovery crash", async t => {
	const f = await fixture(t, "original", "returned");
	const entered = JSON.parse(await readFile(path.join(f.journal, "entered.json"), "utf8"));
	entered.process = successor;
	const enteredSha256 = await replacePhase(f.journal, "entered", entered);
	const marker = JSON.parse(await readFile(path.join(f.journal,
		"returned-uncommitted.json"), "utf8"));
	marker.process = successor;
	await replacePhase(f.journal, "returned-uncommitted", marker);
	const evaluator = f.review.evaluator;
	if (evaluator.phase === "pre-entry-unlocated") throw new Error("expected entered evaluator");
	const claimed = await LocalMissionHost.claimEvaluatorRecovery({ root: f.root,
		missionId: f.review.missionId, intentId: f.review.intentId,
		oldCheckpointSequence: f.review.oldCheckpoint.sequence,
		oldCheckpointSha256: f.review.oldCheckpoint.sha256,
		currentIdentity: async () => reviewer, probePrior: dead });
	assert.equal(claimed.state, "claimed");
	if (claimed.state !== "claimed") throw new Error("dead claim was not succeeded");
	assert.deepEqual(claimed.claim.predecessors,
		[{ claimId: f.claim.claimId, owner: successor }]);
	const review: LocalEvaluatorRecoveryReviewV1 = { ...f.review,
		recoveryClaim: { claimId: claimed.claim.claimId, owner: reviewer,
			oldCheckpointSha256: claimed.claim.oldCheckpoint.sha256,
			predecessors: claimed.claim.predecessors },
		newAttempt: { ...f.review.newAttempt, process: reviewer },
		evaluator: { ...evaluator, owner: successor, enteredSha256 } };
	assert.equal((await f.commit({ review, claim: claimed.claim,
		currentIdentity: async () => reviewer })).version, 4);
	assert.equal((await LocalMissionHost.status(f.root)).repairRequired, false);
});

test("V4 rejects an evaluator entered by an unclaimed foreign owner", async t => {
	const f = await fixture(t, "original", "returned");
	const foreign: ProcessIdentityV1 = { ...owner, pid: 2999, processStartToken: "foreign" };
	const entered = JSON.parse(await readFile(path.join(f.journal, "entered.json"), "utf8"));
	entered.process = foreign;
	const enteredSha256 = await replacePhase(f.journal, "entered", entered);
	const evaluator = f.review.evaluator;
	if (evaluator.phase === "pre-entry-unlocated") throw new Error("expected entered evaluator");
	const review: LocalEvaluatorRecoveryReviewV1 = { ...f.review,
		evaluator: { ...evaluator, owner: foreign, enteredSha256 } };
	await assert.rejects(f.commit({ review }), /reviewed successor input is invalid/);
});

for (const form of ["original", "later"] as const) test(`V4 settles the ${form} held checkpoint exactly once`, async t => {
	const f = await fixture(t, form);
	const receipt = await f.commit();
	assert.equal(receipt.version, 4);
	assert.equal(receipt.evaluatorRecoveryReview?.intentId, f.review.intentId);
	assert.equal((await LocalMissionHost.status(f.root)).repairRequired, false);
	assert.deepEqual(JSON.parse((await LocalMissionHost.readLatestCheckpoint(f.root))!.toString()), f.next);
	await assert.rejects(f.commit(), /stale|unresolved|active recovery claim/);
});

test("V4 preserves a returned task's ordinary acceptance without selecting artifacts", async t => {
	const f = await fixture(t, "original", "returned");
	await f.commit();
	const progress = JSON.parse((await LocalMissionHost.readLatestCheckpoint(f.root))!.toString());
	assert.deepEqual(progress.boundedRuns, [{ runId: f.review.m07.runId, outcome: "partial",
		acceptedTaskIds: [f.review.m07.taskId] }]);
	assert.deepEqual(progress.selectedArtifacts, []);
});

test("V4 admits a separately settled bare entered phase", async t => {
	const f = await fixture(t);
	await unlink(path.join(f.journal, "threw.json"));
	await unlink(path.join(f.journal, "threw.sha256"));
	assert.equal((await f.commit()).version, 4);
});

test("V4 ignores an unsealed throw leftover after separate settlement", async t => {
	const f = await fixture(t);
	await rename(path.join(f.journal, "threw.sha256"),
		path.join(f.journal, "threw.sha256.pending"));
	assert.equal((await f.commit()).version, 4);
	assert.equal((await LocalMissionHost.status(f.root)).repairRequired, false);
});

test("V4 rechecks optional settled M04 facts on every read", async t => {
	const f = await fixture(t, "original", "returned", true);
	await f.commit();
	assert.equal((await LocalMissionHost.status(f.root)).repairRequired, false);
	await put(path.join(f.m04, "m04-transaction.json"),
		{ version: 1, kind: "m04-knowledge-transaction", m04RunId: "m04-001", state: "prepared" });
	assert.equal((await LocalMissionHost.status(f.root)).repairRequired, true);
});

test("V4 synthetic crash before rename publishes no successor; after rename publishes one", async t => {
	const f = await fixture(t);
	await assert.rejects(f.commit({ testCrashAt: "after-prepare" }), /synthetic crash/);
	assert.equal((await LocalMissionHost.status(f.root)).latestCheckpoint?.sequence, 1);
	await LocalMissionHost.recoverReviewLock({ root: f.root, intentId: f.review.intentId,
		oldCheckpointSha256: f.review.oldCheckpoint.sha256,
		currentIdentity: async () => reviewer, probePrior: dead });
	await assert.rejects(f.commit({ testCrashAt: "after-rename" }), /synthetic crash/);
	assert.equal((await LocalMissionHost.status(f.root)).latestCheckpoint?.version, 4);
	await LocalMissionHost.recoverReviewLock({ root: f.root, intentId: f.review.intentId,
		oldCheckpointSha256: f.review.oldCheckpoint.sha256,
		currentIdentity: async () => reviewer, probePrior: dead });
	assert.equal((await LocalMissionHost.status(f.root)).checkpointReceipts.length, 2);
});

test("V4 rejects live owner, unrelated held ref, and altered immutable journal", async t => {
	await t.test("live owner", async t => {
		const f = await fixture(t);
		await assert.rejects(f.commit({ probePrior: alive }), /old attempt death/);
	});
	await t.test("unrelated held ref", async t => {
		const f = await fixture(t, "unrelated");
		await assert.rejects(f.commit(), /intervening checkpoint|historical progress/);
	});
	await t.test("journal tamper after commit", async t => {
		const f = await fixture(t);
		await f.commit();
		await chmod(path.join(f.journal, "settled-failure.json"), 0o600);
		await writeFile(path.join(f.journal, "settled-failure.json"), "{}\n");
		assert.equal((await LocalMissionHost.status(f.root)).repairRequired, true);
	});
	await t.test("prepared input tamper after commit", async t => {
		const f = await fixture(t);
		await f.commit();
		await chmod(path.join(f.journal, "prepared.json"), 0o600);
		await writeFile(path.join(f.journal, "prepared.json"), "{}\n");
		await chmod(path.join(f.journal, "prepared.json"), 0o400);
		assert.equal((await LocalMissionHost.status(f.root)).repairRequired, true);
	});
	await t.test("uncommitted evaluator return", async t => {
		const f = await fixture(t, "original", "returned");
		await unlink(path.join(f.journal, "returned.json"));
		await unlink(path.join(f.journal, "returned.sha256"));
		await assert.rejects(f.commit(), /journal has missing or extra phases/);
	});
	await t.test("extra M07 operation", async t => {
		const f = await fixture(t);
		const file = path.join(f.m07, "goal.json");
		const goal = JSON.parse(await readFile(file, "utf8"));
		goal.executionState.operations.push({ id: "O002", taskId: f.review.m07.taskId,
			status: "issued" });
		const goalSha256 = await put(file, goal);
		await assert.rejects(f.commit({ review: { ...f.review,
			m07: { ...f.review.m07, goalSha256 } } }), /M07 task, effect/);
	});
});
