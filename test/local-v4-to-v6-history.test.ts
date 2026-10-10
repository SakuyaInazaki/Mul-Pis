import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, rename, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { Workspace } from "../src/workspace.ts";
import { createFileKnowledgeStore } from "../src/knowledge/store.ts";
import { fullLocalMissionCensus } from "../src/m07/local-legacy-review.ts";
import { pairedHistoricalToolTranscript } from "../src/m07/local-failed-m04-effects.ts";
import { assessorTaskHash, localLineageHash, recordLocalDispatchLineage } from "../src/m07/local-dispatch-lineage.ts";
import { reconcileFailedM04LocalMission, type FailedM04LocalReviewRequestV1 } from "../src/m07/local-interrupted-reconcile.ts";
import type { FailedM04EffectReviewV1 } from "../src/m07/local-failed-m04-effects.ts";
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
	const contract = { id: missionId, goal: "A test objective", obligations: [
		{ id: "O1", description: "Synthetic check", type: "file-sha256", expectedSha256: "0".repeat(64) }
	] };
	await host.recordInitialContract({ attemptId: "A001", bytes: Buffer.from(`${JSON.stringify(contract)}\n`) });
	const nextTask = { objective: "Synthetic M07 task", addresses: [], adapterScope: "local-m07-execute" };
	const old = { version: 1, kind: "original-objective-progress", contract,
		objectiveOutcome: "incomplete", stopReason: "execution-interrupted",
		assessment: { version: 1, decision: "continue", rationale: "Synthetic task needed",
			evidenceRefs: [], unresolvedObligations: ["O1"], unresolvedDetails: [],
			evidenceRead: ["original-objective.json"], unreadEvidence: [], nextTask },
		assessmentHistory: [], boundedRuns: [],
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
	const goal = { version: 1, lifecycle: "active", runId,
		problemRelation: `Local original objective mission: ${missionId}\n${contract.goal}`,
		tasks: [{ taskId, status: terminal === "returned" ? "accepted" : "rejected",
			...(terminal === "returned" ? { review: { checks: [] } } : {}),
			workDir: work, inputs: ["synthetic-input"], checks: ["Synthetic check"] }],
		executionState: { version: 1, attempts: [{ runDescriptor: { process: owner } }],
			operations: [{ id: operationId, taskId, status: "response-received" }] },
		checkpoints: [{ id: checkpointId, rootDir: cp, goalSnapshotPath: path.join(cp, "goal.json"),
			manifestPath: path.join(cp, "manifest.json"), feedbackPath: path.join(cp, "m04-feedback.md"),
			feedbackStatus: "complete" }] };
	const goalSha256 = await put(path.join(m07, "goal.json"), goal);
	await put(path.join(m07, "run.json"), { stage: "M07", runId, status: "running" });
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

async function v4ThenFailedM04(t: TestContext) {
	const f = await fixture(t);
	const first = await f.commit();
	assert.equal(first.version, 4);
	assert.equal((await LocalMissionHost.status(f.root)).repairRequired, false);
	const ws = new Workspace(f.ws);
	await createFileKnowledgeStore(ws.knowledgeDir).init();
	const missionId = f.review.missionId;
	const intentId = "intent-002", runId = "m07-002", m04RunId = "m04-002";
	const taskId = "T001", operationId = "O001", checkpointId = "C001";
	const nextTask = { objective: "A second synthetic task", addresses: ["O1"],
		adapterScope: "local-m07-execute" };
	const held = { ...f.next, stopReason: "execution-interrupted",
		assessment: { ...f.next.assessment, nextTask },
		continuation: { mode: "reconcile-operations-before-new-run",
			unresolvedOperationIds: [intentId], pendingAction: { version: 1, author: "host",
				kind: "reconcile-interrupted-run", safety: "no-replay-until-reconciled",
				target: { goalRunId: intentId } } } };
	const host = await LocalMissionHost.begin({ root: f.root, missionId,
		attemptId: "A002", codeRevision: "test-revision", currentIdentity: async () => successor });
	const checkpoint = await host.recordCheckpoint({ attemptId: "A002", sequence: 3,
		previousSha256: first.sha256, bytes: Buffer.from(`${JSON.stringify(held)}\n`) });
	const mission = ws.runDir("MISSION", intentId);
	await put(path.join(mission, "run.json"), { stage: "MISSION", runId: intentId,
		status: "running", inputs: [{ path: path.join(f.root, "evidence", "original-objective.json") }] });
	const m07 = ws.runDir("M07", runId), cp = path.join(m07, "checkpoints", checkpointId);
	const taskRoot = path.join(m07, "tasks", taskId), work = path.join(taskRoot, "work");
	await mkdir(work, { recursive: true, mode: 0o700 });
	await mkdir(cp, { recursive: true, mode: 0o700 });
	for (const name of ["evaluator-snapshot", "host-evaluator-output", "host-evaluator-snapshot"])
		await mkdir(path.join(taskRoot, name), { mode: 0o700 });
	const reportPath = path.join(taskRoot, "report.md"), candidateFile = path.join(taskRoot,
		"evaluator-snapshot", "candidate.md");
	const report = "second synthetic report\n";
	await put(reportPath, report); await put(candidateFile, report);
	const receiptFile = path.join(work, "local-evaluator-receipt.json");
	await put(receiptFile, { version: 1, kind: "local-evaluator-receipt", missionId, runId, taskId,
		evaluator: { id: "fake-evaluator", version: "v1" }, candidate: [{ name: "candidate.md",
			sourceFile: reportPath, file: candidateFile, bytes: Buffer.byteLength(report), sha256: sha(report) }],
		frozenEvidence: [], observations: [], checks: [{ obligationId: "O1", result: "unknown",
			evidenceRefs: [], limitations: [] }], limitations: ["No accepted claim"] });
	const timestamp = new Date().toISOString();
	const toolLog = [{ name: "read", args: { path: "candidate.md" }, ok: true, at: timestamp }];
	const builderSessionFile = path.join(m07, "builder.jsonl");
	await put(builderSessionFile, [
		{ type: "message", message: { role: "assistant", content: [{ type: "toolCall",
			id: "call-1", name: "read" }] } },
		{ type: "message", message: { role: "toolResult", toolCallId: "call-1" } }
	].map(row => JSON.stringify(row)).join("\n") + "\n");
	const task = { taskId, objective: nextTask.objective, mode: "execute", status: "rejected",
		inputs: ["candidate.md"], checks: ["Synthetic check"], toolLog, workDir: work,
		reportPath, session: { id: "builder-002", file: builderSessionFile },
		review: { at: timestamp, frozenReportPath: reportPath,
			checks: [{ criterion: "Synthetic check", result: "not_run", evidence: [] }],
			artifacts: [], failures: ["Synthetic task rejected"],
			unexecuted: ["Synthetic check"], limitations: ["No accepted claim"] } };
	const selected = { id: checkpointId, rootDir: cp, goalSnapshotPath: path.join(cp, "goal.json"),
		manifestPath: path.join(cp, "manifest.json"), feedbackPath: path.join(cp, "m04-feedback.md"),
		feedbackStatus: "complete", sourceGoalUpdatedAt: timestamp };
	const goal = { version: 1, runId, lifecycle: "active", goal: nextTask.objective,
		plan: nextTask.objective, constraints: ["Synthetic check"],
		successCriteria: ["Synthetic check"],
		problemRelation: `Local original objective mission: ${missionId}\n${held.contract.goal}`,
		updatedAt: timestamp, tasks: [task], executionState: { version: 1, activeAttemptId: "A001",
			attempts: [{ id: "A001", runDescriptor: { process: successor } }],
			operations: [{ version: 1, id: operationId, taskId, status: "response-received" }] },
		checkpoints: [selected] };
	await put(path.join(m07, "run.json"), { stage: "M07", runId, status: "running" });
	await put(path.join(m07, "goal.json"), goal);
	await put(selected.goalSnapshotPath, goal);
	await put(selected.manifestPath, { version: 1, m07RunId: runId, checkpointId,
		selectedTaskIds: [taskId], omittedTaskIds: [] });
	await put(selected.feedbackPath, "Synthetic rejected task feedback\n");
	await recordLocalDispatchLineage({ missionRoot: f.root, m07Dir: m07,
		lineage: { version: 1, kind: "local-mission-m07-dispatch-lineage", missionId, intentId,
			oldAttempt: host.source, intentCheckpoint: { sequence: checkpoint.sequence,
				sha256: checkpoint.sha256 }, m07RunId: runId, taskId,
			assessorTaskSha256: assessorTaskHash(nextTask),
			m07TaskInputsSha256: localLineageHash(JSON.stringify(task.inputs)),
			m07TaskChecksSha256: localLineageHash(JSON.stringify(task.checks)), m07Owner: successor } });
	const m04 = ws.runDir("M04", m04RunId), sessionFile = path.join(m04, "session.jsonl");
	await mkdir(m04, { recursive: true });
	await put(sessionFile, `${JSON.stringify({ type: "message", message: { role: "assistant",
		stopReason: "error", usage: { input: 1, output: 0 } } })}\n`);
	await put(path.join(m04, "run.json"), { stage: "M04", runId: m04RunId,
		status: "failed", inputs: [{ path: selected.manifestPath }, { path: selected.feedbackPath }],
		sessions: [{ id: "session-002", file: sessionFile }],
		outputs: [{ label: "M04 知识事务状态", path: path.join(m04, "m04-transaction.json") }],
		failures: ["Synthetic failure"], remarks: [], startedAt: timestamp, finishedAt: timestamp });
	await put(path.join(m04, "m07-source.json"), { m07RunId: runId, checkpointId,
		feedbackBundlePath: selected.feedbackPath, goalSnapshotPath: selected.goalSnapshotPath,
		manifestPath: selected.manifestPath });
	const transactionFile = path.join(m04, "m04-transaction.json");
	await put(transactionFile, { version: 1, kind: "m04-knowledge-transaction", m04RunId,
		state: "no-proposal", attempts: [], updatedAt: timestamp });
	const paired = await pairedHistoricalToolTranscript(task as any);
	const review: FailedM04EffectReviewV1 = { version: 1, kind: "local-failed-m04-effect-review",
		scope: { missionId, intentId, oldCheckpointSha256: checkpoint.sha256, m07RunId: runId,
			taskId, operationId, checkpointId, m04RunId },
		workspaceCensusSha256: await fullLocalMissionCensus(ws, { intentId, m07RunId: runId,
			priorReviewed: [{ intentId: f.review.intentId, m07RunId: f.review.m07.runId }] }),
		toolLogSha256: sha(JSON.stringify(toolLog)), toolTranscriptCensusSha256: paired.sha256,
		pairedToolCallCount: paired.calls, evaluatorReceiptSha256: sha(await readFile(receiptFile)),
		m04Sessions: [{ id: "session-002", fileSha256: sha(await readFile(sessionFile)) }],
		m04TransactionSha256: sha(await readFile(transactionFile)),
		toolCalls: [{ ordinal: 1, entrySha256: sha(JSON.stringify(toolLog[0])), result: "returned",
			numericExit: null, effect: "observed-settled" }],
		childProcesses: "no-detected-lingering-process", backgroundWork: "no-unsettled-work",
		providerRequests: "inference-only-no-hosted-work", providerAccounting: "unreconciled",
		knowledgeWrite: "none-observed", otherOpenMutatingOperations: 0,
		trustLimit: "same-uid-host-observation-no-os-isolation-proof",
		conclusion: "observed-settled-within-reviewed-scope" };
	const reviewFile = path.join(f.ws, "failed-m04-effects.json");
	await put(reviewFile, review);
	const request: FailedM04LocalReviewRequestV1 = { version: 1,
		kind: "review-failed-m04-local-dispatch", missionId, intentId, oldAttemptId: "A002",
		checkpointSequence: checkpoint.sequence, checkpointSha256: checkpoint.sha256,
		m07RunId: runId, taskId, operationId, checkpointId, m04RunId,
		effectReviewFile: reviewFile, effectReviewSha256: sha(await readFile(reviewFile)) };
	return { ...f, ws, request, review, first, firstM07: f.m07, m07, m04,
		verifyTrustedEffects: async (actual: FailedM04EffectReviewV1) => assert.deepEqual(actual.scope, review.scope) };
}

for (const tamper of [false, true]) test(`V4 history before V6 failed M04 recovery ${tamper ? "rejects altered V4 evidence" : "is retained"}`, async t => {
	const f = await v4ThenFailedM04(t);
	if (tamper) {
		const firstGoal = path.join(f.firstM07, "goal.json");
		await put(firstGoal, { ...JSON.parse(await readFile(firstGoal, "utf8")),
			problemRelation: "altered historical V4 stage" });
		assert.equal((await LocalMissionHost.status(f.root)).repairRequired, true);
		await assert.rejects(reconcileFailedM04LocalMission({ workspaceRoot: f.ws.root,
			request: f.request, verifyTrustedEffects: f.verifyTrustedEffects,
			currentIdentity: async () => reviewer, probePrior: dead }), /repair|review/);
		return;
	}
	const result = await reconcileFailedM04LocalMission({ workspaceRoot: f.ws.root,
		request: f.request, verifyTrustedEffects: f.verifyTrustedEffects,
		currentIdentity: async () => reviewer, probePrior: dead });
	assert.deepEqual(result.progress.boundedRuns.map(row => row.runId), ["m07-001", "m07-002"]);
	assert.deepEqual(result.progress.boundedRuns.map(row => row.acceptedTaskIds), [[], []]);
	const status = await LocalMissionHost.status(f.root);
	assert.equal(status.repairRequired, false);
	assert.deepEqual(status.checkpointReceipts.filter(row => row.version >= 4).map(row => row.version), [4, 6]);
});
