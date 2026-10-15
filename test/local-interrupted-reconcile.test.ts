import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { createOriginalObjective, objectiveProgress } from "../src/m07/objective-progress.ts";
import  {
	reconcileInterruptedLocalMission,
	reconcileFailedM04LocalMission,
	type FailedM04LocalReviewRequestV1,
	type InterruptedLocalReviewRequestV1
}  from "../src/m07/local-interrupted-reconcile.ts";
import { fullLocalMissionCensus, pairedToolTranscript } from "../src/m07/local-legacy-review.ts";
import type { FailedM04EffectReviewV1 } from "../src/m07/local-failed-m04-effects.ts";
import { LOCAL_M07_MISSION_BINDING_PREFIX } from "../src/m07/local-m07-adapter.ts";
import { openDefaultLocalMission } from "../src/m07/local-mission.ts";
import { assessorTaskHash, localLineageBytes, localLineageHash, missionLineageFile, recordLocalDispatchLineage } from "../src/m07/local-dispatch-lineage.ts";
import { LocalMissionHost } from "../src/runner/local-mission-host.ts";
import type { ProcessIdentityV1, ProcessProbe } from "../src/runtime/process-identity.ts";
import { readCurrentProcessIdentity } from "../src/runtime/process-identity.ts";
import { FakeSessionRunner } from "../src/runner/fake.ts";
import { Workspace } from "../src/workspace.ts";
import { createFileKnowledgeStore } from "../src/knowledge/store.ts";

const sha = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
const p1: ProcessIdentityV1 = { hostId: "local-host", bootId: "local-boot", pid: 1001, processStartToken: "111" };
const p2: ProcessIdentityV1 = { ...p1, pid: 1002, processStartToken: "222" };
const p3: ProcessIdentityV1 = { ...p1, pid: 1003, processStartToken: "333" };
const dead = async (): Promise<ProcessProbe> => ({ status: "dead", identityMatch: false, reason: "synthetic death" });
const options = { currentIdentity: async () => p3, probePrior: dead };
async function fixture(t: TestContext, link: "committed" | "missing" | "mission-side" | "both-uncommitted" = "committed",
	mixed = false, oldHost?: ProcessIdentityV1) {
	const owner1 = oldHost ? { ...p1, hostId: oldHost.hostId, bootId: oldHost.bootId } : p1;
	const owner2 = oldHost ? { ...p2, hostId: oldHost.hostId, bootId: oldHost.bootId } : p2;
	const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "local-interrupted-review-")));
	t.after(() => rm(root, { recursive: true, force: true }));
	const ws = new Workspace(root);
	await mkdir(path.join(ws.agentDir, "missions"), { recursive: true, mode: 0o700 });
	const contract = createOriginalObjective({ goal: "Synthetic objective", goalSource: "user-intent-summary",
		inputNames: ["problem.md"], obligations: [{ id: "O1", description: "Synthetic check",
			type: "file-sha256", expectedSha256: "0".repeat(64) },
			...(mixed ? [{ id: "O2", description: "Second synthetic check",
				type: "file-sha256" as const, expectedSha256: "1".repeat(64) }] : [])],
		closure: "open-ended" });
	const missionRoot = path.join(ws.agentDir, "missions", contract.id);
	const a1 = await LocalMissionHost.begin({ root: missionRoot, missionId: contract.id,
		attemptId: "A001", codeRevision: "local-harness-v1", currentIdentity: async () => owner1 });
	const evidenceDir = path.join(missionRoot, "evidence");
	await mkdir(evidenceDir, { recursive: true, mode: 0o700 });
	const problemBytes = Buffer.from("Synthetic objective\n");
	await mkdir(path.dirname(ws.problemFile), { recursive: true });
	await writeFile(ws.problemFile, problemBytes);
	await writeFile(path.join(evidenceDir, "original-objective.json"), `${JSON.stringify(contract, null, 2)}\n`);
	await writeFile(path.join(evidenceDir, "original-problem.txt"), problemBytes);
	await a1.recordInitialContract({ attemptId: "A001", bytes: Buffer.from(`${JSON.stringify({
		...contract, frozenInputs: [{ name: "original-problem.txt", bytes: problemBytes.length,
			sha256: sha(problemBytes) }] }, null, 2)}\n`) });
	const initial = objectiveProgress(contract, { boundedRuns: [], selectedArtifacts: [],
		stopReason: "next-task-pending", pendingActionFacts: {} });
	const first = await a1.recordCheckpoint({ attemptId: "A001", sequence: 1,
		previousSha256: null, bytes: Buffer.from(`${JSON.stringify(initial)}\n`) });
	const a2 = await LocalMissionHost.begin({ root: missionRoot, missionId: contract.id,
		attemptId: "A002", codeRevision: "local-harness-v1", currentIdentity: async () => owner2,
		probePrior: dead });
	const intermediate = await a2.recordCheckpoint({ attemptId: "A002", sequence: 2,
		previousSha256: first.sha256, bytes: Buffer.from(`${JSON.stringify(initial)}\n`) });
	const intentId = "synthetic-intent-001";
	const nextTask = { objective: "Synthetic M07 task", addresses: mixed ? ["O1", "O2"] : ["O1"],
		adapterScope: "local-m07-execute" };
	const held = objectiveProgress(contract, { boundedRuns: [], selectedArtifacts: [],
		assessment: { version: 1, decision: "continue", rationale: "Synthetic task needed",
			evidenceRefs: [], unresolvedObligations: ["O1"], unresolvedDetails: [],
			nextTask, sessionId: "synthetic-assessor", model: "fake/model",
			evidenceRead: ["original-objective.json"], unreadEvidence: [] },
		stopReason: "execution-interrupted", unresolvedOperationIds: [intentId],
		pendingActionFacts: { unresolvedOperationRefs: [intentId], target: { goalRunId: intentId },
			failedStage: "m07-execution" } });
	const old = await a2.recordCheckpoint({ attemptId: "A002", sequence: 3,
		previousSha256: intermediate.sha256, bytes: Buffer.from(`${JSON.stringify(held)}\n`) });
	const missionRunDir = ws.runDir("MISSION", intentId);
	await mkdir(missionRunDir, { recursive: true });
	await writeFile(path.join(missionRunDir, "run.json"), JSON.stringify({ stage: "MISSION", runId: intentId,
		status: "running", inputs: [{ label: "Frozen original objective", path: path.join(missionRoot, "evidence", "original-objective.json") }],
		sessions: [], outputs: [], failures: [], remarks: [], startedAt: new Date().toISOString() }));
	const m07RunId = "synthetic-m07-001";
	const m07Dir = ws.runDir("M07", m07RunId);
	const checkpointDir = path.join(m07Dir, "checkpoints", "C001");
	await mkdir(checkpointDir, { recursive: true });
	await writeFile(path.join(m07Dir, "run.json"), JSON.stringify({ stage: "M07", runId: m07RunId,
		status: "running", inputs: [], sessions: [], outputs: [], failures: [], remarks: [],
		startedAt: new Date().toISOString() }));
	const timestamp = new Date().toISOString();
	const toolLog = [
		...Array.from({ length: 34 }, (_, index) => ({ name: "bash", args: { command: `printf 'local-${index}'` },
			ok: true, at: timestamp, resultMetadata: { local: true } })),
		{ name: "bash", args: { command: "exit 1" }, ok: false, at: timestamp, error: "exit 1" },
		{ name: "edit", args: { path: "synthetic-source.txt" }, ok: false,
			at: timestamp, error: "synthetic edit error" },
		...Array.from({ length: 19 }, (_, index) => ({ name: "read", args: { path: `local-${index}.txt` },
			ok: true, at: timestamp })) ];
	const builderSessionFile = path.join(m07Dir, "synthetic-builder.jsonl");
	const builderEvents = toolLog.flatMap((entry, index) => [
		{ type: "message", message: { role: "assistant", content: [{ type: "toolCall",
			id: `call-${index + 1}`, name: entry.name }] } },
		{ type: "message", message: { role: "toolResult", toolCallId: `call-${index + 1}` } },
	]);
	await writeFile(builderSessionFile, builderEvents.map(event => JSON.stringify(event)).join("\n"));
	const task = { taskId: "T001", objective: nextTask.objective, mode: "execute", status: "rejected",
		inputs: ["synthetic-source.txt"], checks: mixed ? ["Synthetic check", "Second synthetic check"] :
			["Synthetic check"], toolLog,
		session: { id: "synthetic-builder", file: builderSessionFile } };
	const checkpoint = { id: "C001", rootDir: checkpointDir,
		manifestPath: path.join(checkpointDir, "manifest.json"),
		feedbackPath: path.join(checkpointDir, "m04-feedback.md"),
		goalSnapshotPath: path.join(checkpointDir, "goal.json"),
		feedbackStatus: "complete", sourceGoalUpdatedAt: timestamp };
	const goal = { version: 1, runId: m07RunId, lifecycle: "active",
		goal: nextTask.objective,
		plan: nextTask.objective, constraints: mixed ? ["Synthetic check", "Second synthetic check"] :
			["Synthetic check"], successCriteria: mixed ? ["Synthetic check", "Second synthetic check"] :
			["Synthetic check"],
		problemRelation: `${LOCAL_M07_MISSION_BINDING_PREFIX}${contract.id}\n${contract.goal}`,
		updatedAt: timestamp, tasks: [task], executionState: { version: 1, activeAttemptId: "A001",
			attempts: [{ id: "A001", runDescriptor: { version: 1, instanceId: "synthetic",
				attemptId: "A001", workspaceId: "synthetic-workspace", codeRevision: "local-harness-v1",
				controlDir: root, processGroupId: 8800, process: owner2 } }],
			operations: [{ version: 1, id: "O001", taskId: "T001", status: "response-received" }] },
		checkpoints: [checkpoint] };
	await writeFile(path.join(m07Dir, "goal.json"), JSON.stringify(goal));
	const lineage = { version: 1 as const, kind: "local-mission-m07-dispatch-lineage" as const,
		missionId: contract.id, intentId, oldAttempt: a2.source,
		intentCheckpoint: { sequence: old.sequence, sha256: old.sha256 },
		m07RunId, taskId: "T001", assessorTaskSha256: assessorTaskHash(nextTask),
		m07TaskInputsSha256: localLineageHash(JSON.stringify(task.inputs)),
		m07TaskChecksSha256: localLineageHash(JSON.stringify(task.checks)), m07Owner: owner2 };
	if (link === "committed") await recordLocalDispatchLineage({ missionRoot, m07Dir, lineage });
	else if (link === "mission-side" || link === "both-uncommitted") {
		const file = missionLineageFile(missionRoot, intentId);
		await mkdir(path.dirname(file), { recursive: true });
		await chmod(path.dirname(file), 0o700);
		await writeFile(file, localLineageBytes(lineage), { mode: 0o600 });
		if (link === "both-uncommitted")
			await writeFile(path.join(m07Dir, "mission-dispatch-link.json"), localLineageBytes(lineage),
				{ mode: 0o600 });
	}
	await writeFile(path.join(checkpointDir, "goal.json"), JSON.stringify(goal));
	await writeFile(checkpoint.manifestPath, JSON.stringify({ version: 1, m07RunId, checkpointId: "C001",
		selectedTaskIds: ["T001"], omittedTaskIds: [] }));
	await writeFile(checkpoint.feedbackPath, "Synthetic rejected task feedback\n");
	const m04RunId = "synthetic-m04-001";
	const m04Dir = ws.runDir("M04", m04RunId);
	await mkdir(m04Dir, { recursive: true });
	const guard = "SDK DeepSeek request lowered or lost the resolved provider output maximum";
	const m04Run = { stage: "M04", runId: m04RunId, status: "failed",
		inputs: [{ label: "feedback", path: checkpoint.feedbackPath },
			{ label: "manifest", path: checkpoint.manifestPath }],
		sessions: [{ id: "synthetic-session", file: path.join(m04Dir, "synthetic-session.jsonl") }],
		outputs: [], failures: [guard], remarks: [],
		startedAt: new Date().toISOString() };
	await writeFile(path.join(m04Dir, "run.json"), JSON.stringify(m04Run));
	await writeFile(m04Run.sessions[0].file,
		[...Array.from({ length: 36 }, (_, index) => JSON.stringify({ type: "message",
			id: `response-${index + 1}`, message: { role: "assistant", stopReason: "stop",
				usage: { input: 100, output: 20 } } })),
			JSON.stringify({ type: "message", id: "terminal-error", message: { role: "assistant",
				stopReason: "error", usage: { input: 0, output: 0 } } })].join("\n"));
	await writeFile(path.join(m04Dir, "m07-source.json"), JSON.stringify({ m07RunId,
		checkpointId: "C001", feedbackBundlePath: checkpoint.feedbackPath,
		goalSnapshotPath: checkpoint.goalSnapshotPath, manifestPath: checkpoint.manifestPath }));
	await writeFile(path.join(m04Dir, "m04-transaction.json"), JSON.stringify({ version: 1,
		kind: "m04-knowledge-transaction", m04RunId, state: "no-proposal", attempts: [],
		updatedAt: timestamp }));
	await writeFile(path.join(m04Dir, "synthetic-usage-ledger.json"), JSON.stringify({
		responses: Array.from({ length: 36 }, (_, index) => ({ request: index + 1,
			status: "settled", inputTokens: 100, outputTokens: 20, feeCny: 0.001 })) }));
	const proofFile = path.join(root, "before-http-proof.json");
	await writeFile(proofFile, JSON.stringify({ version: 1,
		kind: "m04-sdk-output-max-before-http-review", m04RunId, sessionId: "synthetic-session",
		error: guard, lastRequestNotSent: true, earlierResponsesSettled: true,
		accounting: "preserve-observed-usage" }));
	const request: InterruptedLocalReviewRequestV1 = { version: 1,
		kind: "review-interrupted-local-dispatch", missionId: contract.id, intentId,
		oldAttemptId: "A002", checkpointSequence: old.sequence, checkpointSha256: old.sha256,
		m07RunId, taskId: "T001", operationId: "O001", checkpointId: "C001",
		m04RunId, providerProofFile: proofFile, providerProofSha256: sha(await readFile(proofFile)) };
	return { ws, root, missionRoot, request, held, m07Dir, m04Dir, checkpointDir, proofFile };
}

test("exact dead-process review records one safe successor checkpoint without erasing history", async t => {
	const f = await fixture(t);
	const retained = await Promise.all([
		path.join(f.m04Dir, "run.json"), path.join(f.m04Dir, "m04-transaction.json"),
		path.join(f.m04Dir, "synthetic-usage-ledger.json"), path.join(f.m07Dir, "goal.json")]
		.map(file => readFile(file)));
	const result = await reconcileInterruptedLocalMission({ workspaceRoot: f.root, request: f.request, ...options });
	assert.equal(result.receipt.oldAttempt.attemptId, "A002");
	assert.equal(result.receipt.newAttempt.attemptId, "A003");
	assert.deepEqual(result.progress.continuation.unresolvedOperationIds, []);
	assert.equal(result.progress.continuation.pendingAction?.safety, "fresh-work-only");
	assert.deepEqual(result.progress.boundedRuns, [{ runId: f.request.m07RunId,
		outcome: "partial", acceptedTaskIds: [] }]);
	assert.deepEqual(result.progress.assessmentHistory, f.held.assessmentHistory);
	const status = await LocalMissionHost.status(f.missionRoot);
	assert.equal(status.latestCheckpoint?.version, 2);
	assert.equal(status.latestCheckpoint?.interruptedReview?.intentId, f.request.intentId);
	assert.deepEqual(JSON.parse((await LocalMissionHost.readLatestCheckpoint(f.missionRoot))!.toString()), result.progress);
	for (const [index, file] of [path.join(f.m04Dir, "run.json"),
		path.join(f.m04Dir, "m04-transaction.json"),
		path.join(f.m04Dir, "synthetic-usage-ledger.json"), path.join(f.m07Dir, "goal.json")].entries())
		assert((await readFile(file)).equals(retained[index]!));
	const retried = await reconcileInterruptedLocalMission({ workspaceRoot: f.root,
		request: f.request, ...options });
	assert.deepEqual(retried, result);
	assert.equal((await LocalMissionHost.status(f.missionRoot)).latestCheckpoint?.sequence, 4);
});


async function failedM04Fixture(t: TestContext, mixed = false, extraM04Session = false,
	oldHost?: ProcessIdentityV1) {
	const f = await fixture(t, "committed", mixed, oldHost);
	await createFileKnowledgeStore(f.ws.knowledgeDir).init();
	const m04RunFile = path.join(f.m04Dir, "run.json");
	const failedRun = JSON.parse(await readFile(m04RunFile, "utf8"));
	failedRun.finishedAt = new Date().toISOString();
	failedRun.outputs = [{ label: "M04 知识事务状态",
		path: path.join(f.m04Dir, "m04-transaction.json") }];
	await writeFile(m04RunFile, JSON.stringify(failedRun));
	const goalFile = path.join(f.m07Dir, "goal.json");
	const goal = JSON.parse(await readFile(goalFile, "utf8"));
	const task = goal.tasks[0];
	const taskRoot = path.join(f.m07Dir, "tasks", "T001");
	task.workDir = path.join(taskRoot, "work");
	task.reportPath = path.join(taskRoot, "report.md");
	task.review = { at: new Date().toISOString(), frozenReportPath: task.reportPath,
		checks: mixed ? [{ criterion: "Synthetic check", result: "passed", evidence: [] },
			{ criterion: "Second synthetic check", result: "failed", evidence: [] }] :
			[{ criterion: "Synthetic check", result: "not_run", evidence: [] }],
		artifacts: [], failures: ["Synthetic task rejected"], unexecuted: ["Synthetic check"],
		limitations: ["No scientific acceptance"] };
	await mkdir(task.workDir, { recursive: true, mode: 0o700 });
	await mkdir(path.join(taskRoot, "evaluator-snapshot"), { mode: 0o700 });
	await mkdir(path.join(taskRoot, "host-evaluator-output"), { mode: 0o700 });
	await mkdir(path.join(taskRoot, "host-evaluator-snapshot"), { mode: 0o700 });
	const report = Buffer.from("Synthetic rejected report\n");
	await writeFile(task.reportPath, report);
	const snapshotPath = path.join(taskRoot, "evaluator-snapshot", "report.md");
	await writeFile(snapshotPath, report);
	const receipt = { version: 1, kind: "local-evaluator-receipt",
		missionId: f.request.missionId, runId: f.request.m07RunId, taskId: "T001",
		evaluator: { id: "synthetic-evaluator", version: "v1" },
		candidate: [{ name: "report.md", sourceFile: task.reportPath, file: snapshotPath,
			bytes: report.length, sha256: sha(report) }], observations: [], frozenEvidence: [],
		checks: mixed ? [{ obligationId: "O1", result: "passed", evidenceRefs: ["report.md"],
			limitations: [] }, { obligationId: "O2", result: "failed", evidenceRefs: [], limitations: [] }] :
			[{ obligationId: "O1", result: "unknown", evidenceRefs: [], limitations: [] }],
		limitations: ["No accepted claim"] };
	const receiptFile = path.join(task.workDir, "local-evaluator-receipt.json");
	await writeFile(receiptFile, JSON.stringify(receipt));
	await writeFile(goalFile, JSON.stringify(goal));
	await writeFile(path.join(f.checkpointDir, "goal.json"), JSON.stringify(goal));
	if (extraM04Session) {
		const file = path.join(f.m04Dir, "second-session.jsonl");
		await writeFile(file, `${JSON.stringify({ type: "message", message: { role: "assistant",
			stopReason: "stop", usage: { input: 2, output: 1 } } })}\n`);
		const m04RunFile = path.join(f.m04Dir, "run.json");
		const m04Run = JSON.parse(await readFile(m04RunFile, "utf8"));
		m04Run.sessions.push({ id: "second-session", file });
		await writeFile(m04RunFile, JSON.stringify(m04Run));
	}
	const m04Sessions = (JSON.parse(await readFile(path.join(f.m04Dir, "run.json"), "utf8"))
		.sessions as Array<{ id: string; file: string }>);
	const toolLog = task.toolLog as Array<{ name: string; ok: boolean }>;
	const paired = await pairedToolTranscript(task);
	const review: FailedM04EffectReviewV1 = { version: 1,
		kind: "local-failed-m04-effect-review",
		scope: { missionId: f.request.missionId, intentId: f.request.intentId,
			oldCheckpointSha256: f.request.checkpointSha256, m07RunId: f.request.m07RunId,
			taskId: "T001", operationId: "O001", checkpointId: "C001",
			m04RunId: f.request.m04RunId },
		workspaceCensusSha256: await fullLocalMissionCensus(f.ws,
			{ intentId: f.request.intentId, m07RunId: f.request.m07RunId }),
		toolLogSha256: sha(JSON.stringify(toolLog)),
		toolTranscriptCensusSha256: paired.sha256, pairedToolCallCount: paired.calls,
		evaluatorReceiptSha256: sha(await readFile(receiptFile)),
		m04Sessions: await Promise.all(m04Sessions.map(async row => ({ id: row.id,
			fileSha256: sha(await readFile(row.file)) }))),
		m04TransactionSha256: sha(await readFile(path.join(f.m04Dir, "m04-transaction.json"))),
		toolCalls: toolLog.map((entry, index) => ({ ordinal: index + 1,
			entrySha256: sha(JSON.stringify(entry)), result: entry.ok ? "returned" : "returned-error",
			numericExit: null, effect: "observed-settled" })),
		childProcesses: "no-detected-lingering-process", backgroundWork: "no-unsettled-work",
		providerRequests: "inference-only-no-hosted-work", providerAccounting: "unreconciled",
		knowledgeWrite: "none-observed",
		otherOpenMutatingOperations: 0,
		trustLimit: "same-uid-host-observation-no-os-isolation-proof",
		conclusion: "observed-settled-within-reviewed-scope" };
	const reviewFile = path.join(f.root, "failed-m04-effects.json");
	await writeFile(reviewFile, JSON.stringify(review));
	const request: FailedM04LocalReviewRequestV1 = { version: 1,
		kind: "review-failed-m04-local-dispatch", missionId: f.request.missionId,
		intentId: f.request.intentId, oldAttemptId: f.request.oldAttemptId,
		checkpointSequence: f.request.checkpointSequence,
		checkpointSha256: f.request.checkpointSha256, m07RunId: f.request.m07RunId,
		taskId: f.request.taskId, operationId: f.request.operationId,
		checkpointId: f.request.checkpointId, m04RunId: f.request.m04RunId,
		effectReviewFile: reviewFile, effectReviewSha256: sha(await readFile(reviewFile)) };
	let attestations = 0;
	const verifyTrustedEffects = async (effect: FailedM04EffectReviewV1) => {
		assert.deepEqual(effect.scope, review.scope);
		attestations++;
	};
	return { ...f, request, review, reviewFile, receiptFile, verifyTrustedEffects,
		attestations: () => attestations };
}


test("default mission chooses a distinct task after V6 negative feedback", async t => {
	const localOwner = await readCurrentProcessIdentity();
	const f = await failedM04Fixture(t, false, false, localOwner);
	await reconcileFailedM04LocalMission({ workspaceRoot: f.root,
		request: f.request, verifyTrustedEffects: f.verifyTrustedEffects,
		currentIdentity: async () => localOwner, probePrior: dead });
	let sawPriorFeedback = false;
	let assessorCalls = 0;
	const runner = new FakeSessionRunner(async ({ spec }) => {
		if (spec.label.startsWith("local-original-objective-")) {
			assessorCalls++;
			if (assessorCalls > 2) throw new Error("unexpected third assessor");
			assert.equal(spec.tools.kind, "read-dir");
			if (spec.tools.kind !== "read-dir") throw new Error("assessor read grant missing");
			const readRoot = spec.tools.root;
			const names = (await readdir(readRoot)).sort();
			sawPriorFeedback ||= names.some(name => name.startsWith("prior-run-1-feedback-"));
			const readReturns = await Promise.all(names.map(async name => {
				const file = path.join(readRoot, name);
				const data = await readFile(file);
				const lines = data.toString("utf8").split("\n").length - Number(data.at(-1) === 10);
				return { toolName: "objective_evidence_read", status: "returned" as const,
					path: name, requested: {}, returned: { kind: "text" as const,
						startLine: 1, endLine: lines, truncated: false }, at: new Date().toISOString() };
			}));
			const refs = [{ sourceId: "original-problem.txt", startLine: 1, endLine: 1 }];
			const issue = { id: "fresh-gap", claim: "The original check remains open", status: "open",
				classification: "explicit-requirement", sourceRefs: refs,
				implication: "A distinct bounded task could test it" };
			if (assessorCalls === 2) return { text: JSON.stringify({ version: 1,
				decision: "blocked", rationale: "Both bounded reports remain unselected.",
				evidenceRefs: names.filter(name => name.startsWith("prior-run-2-feedback-")).slice(0, 1),
				unresolvedObligations: ["O1"], unresolvedDetails: [issue.claim],
				groundedAssessment: { version: 1, kind: "grounded-assessment-proposal",
					contractId: f.request.missionId, missionStatus: "open", issues: [issue],
					legacyOpenDetails: [issue.claim] } }), readReturns };
			return { text: JSON.stringify({ version: 1, decision: "continue",
				rationale: "The prior rejected task left the original check open.",
				evidenceRefs: ["original-problem.txt", names.find(name => name.startsWith("prior-run-1-feedback-"))],
				unresolvedObligations: ["O1"], unresolvedDetails: [issue.claim],
				groundedAssessment: { version: 1, kind: "grounded-assessment-proposal",
					contractId: f.request.missionId, missionStatus: "open", issues: [issue],
					legacyOpenDetails: [], nextTask: { objective: "A distinct successor task",
						obligationIds: ["O1"], addresses: ["fresh-gap"],
						adapterScope: "local-m07-reason",
						decisionChangingHypothesis: "New reasoning may identify the missing fact",
						expectedEvidence: "A separately reviewed bounded report", sourceRefs: refs } } }),
				readReturns };
		}
		if (spec.label.startsWith("M07-")) return "Distinct task returned a bounded report.";
		if (spec.label === "M04-research") {
			assert.equal(spec.tools.kind, "read-dir");
			if (spec.tools.kind !== "read-dir") throw new Error("M04 read grant missing");
			const readRoot = spec.tools.root;
			const readReturns: Array<{ toolName: string; status: "returned"; path: string;
				requested: object; returned: { kind: "text"; startLine: number;
				endLine: number; truncated: false }; at: string }> = [];
			const visit = async (folder: string): Promise<void> => {
				for (const name of await readdir(folder)) {
					const file = path.join(folder, name);
					if ((await stat(file)).isDirectory()) { await visit(file); continue; }
					const data = await readFile(file);
					if (data.length) readReturns.push({ toolName: "m07_evidence_read", status: "returned",
						path: path.relative(readRoot, file).replaceAll("\\", "/"), requested: {},
						returned: { kind: "text", startLine: 1,
							endLine: data.toString("utf8").split("\n").length - Number(data.at(-1) === 10),
							truncated: false }, at: new Date().toISOString() });
				}
			};
			await visit(readRoot);
			return { text: "The distinct bounded report remains unselected; no proposal.", readReturns };
		}
		throw new Error(`unexpected fake session ${spec.label}`);
	});
	const mission = openDefaultLocalMission({ workspaceRoot: f.root, runner,
		config: { roles: { research: "fake/research", execution: "fake/execution" },
			localMission: { evaluatorId: "host:file-sha256" }, concurrency: 1 } as any });
	const progress = await mission.run(f.request.missionId);
	assert(sawPriorFeedback, "new assessor must see the rejected task feedback");
	assert(assessorCalls >= 2);
	assert.equal(progress.objectiveOutcome, "incomplete");
	const m07Runs = await f.ws.listRuns("M07");
	assert(m07Runs.some(runId => runId !== f.request.m07RunId),
		"fresh assessment must dispatch a distinct M07 run");
});
