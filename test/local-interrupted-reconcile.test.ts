import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { createOriginalObjective, objectiveProgress } from "../src/m07/objective-progress.ts";
import { reconcileInterruptedLocalMission, reconcileLegacyInterruptedLocalMission,
	type InterruptedLocalReviewRequestV1, type LegacyInterruptedLocalReviewRequestV1 } from
	"../src/m07/local-interrupted-reconcile.ts";
import { fullLocalMissionCensus, LEGACY_SERIAL_AUDIT_SHA256, LEGACY_SERIAL_COMMIT,
	LEGACY_SERIAL_TREE, verifyLegacySerialSource, type LegacyEffectReviewV1 } from "../src/m07/local-legacy-review.ts";
import { LOCAL_M07_MISSION_BINDING_PREFIX } from "../src/m07/local-m07-adapter.ts";
import { assessorTaskHash, localLineageBytes, localLineageHash, missionLineageFile,
	recordLocalDispatchLineage } from "../src/m07/local-dispatch-lineage.ts";
import { LocalMissionHost } from "../src/runner/local-mission-host.ts";
import type { ProcessIdentityV1, ProcessProbe } from "../src/runtime/process-identity.ts";
import { Workspace } from "../src/workspace.ts";

const sha = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
const p1: ProcessIdentityV1 = { hostId: "local-host", bootId: "local-boot", pid: 1001, processStartToken: "111" };
const p2: ProcessIdentityV1 = { ...p1, pid: 1002, processStartToken: "222" };
const p3: ProcessIdentityV1 = { ...p1, pid: 1003, processStartToken: "333" };
const p4: ProcessIdentityV1 = { ...p1, pid: 1004, processStartToken: "444" };
const dead = async (): Promise<ProcessProbe> => ({ status: "dead", identityMatch: false, reason: "synthetic death" });
const options = { currentIdentity: async () => p3, probePrior: dead };
test("reviewed legacy source snapshot is self-contained and rejects changed bytes", async t => {
	await verifyLegacySerialSource();
	const root = await mkdtemp(path.join(os.tmpdir(), "local-legacy-source-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const original = await readFile(new URL("../src/m07/legacy-reviewed-serial-source-v1.json.gz", import.meta.url));
	const changed = Buffer.from(original);
	changed[changed.length - 1] ^= 1;
	const file = path.join(root, "changed-source.json.gz");
	await writeFile(file, changed, { mode: 0o600 });
	await assert.rejects(verifyLegacySerialSource(file), /archive differs from reviewed bytes/);
});
async function fixture(t: TestContext, link: "committed" | "missing" | "mission-side" | "both-uncommitted" = "committed") {
	const root = await mkdtemp(path.join(os.tmpdir(), "local-interrupted-review-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const ws = new Workspace(root);
	await mkdir(path.join(ws.agentDir, "missions"), { recursive: true, mode: 0o700 });
	const contract = createOriginalObjective({ goal: "Synthetic objective", goalSource: "user-intent-summary",
		inputNames: ["problem.md"], obligations: [{ id: "O1", description: "Synthetic check" }],
		closure: "open-ended" });
	const missionRoot = path.join(ws.agentDir, "missions", contract.id);
	const a1 = await LocalMissionHost.begin({ root: missionRoot, missionId: contract.id,
		attemptId: "A001", codeRevision: "local-harness-v1", currentIdentity: async () => p1 });
	await a1.recordInitialContract({ attemptId: "A001", bytes: Buffer.from(`${JSON.stringify(contract)}\n`) });
	const initial = objectiveProgress(contract, { boundedRuns: [], selectedArtifacts: [],
		stopReason: "next-task-pending", pendingActionFacts: {} });
	const first = await a1.recordCheckpoint({ attemptId: "A001", sequence: 1,
		previousSha256: null, bytes: Buffer.from(`${JSON.stringify(initial)}\n`) });
	const a2 = await LocalMissionHost.begin({ root: missionRoot, missionId: contract.id,
		attemptId: "A002", codeRevision: "local-harness-v1", currentIdentity: async () => p2,
		probePrior: dead });
	const intermediate = await a2.recordCheckpoint({ attemptId: "A002", sequence: 2,
		previousSha256: first.sha256, bytes: Buffer.from(`${JSON.stringify(initial)}\n`) });
	const intentId = "synthetic-intent-001";
	const nextTask = { objective: "Synthetic M07 task", addresses: ["O1"],
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
		inputs: ["synthetic-source.txt"], checks: ["Synthetic check"], toolLog,
		session: { id: "synthetic-builder", file: builderSessionFile } };
	const checkpoint = { id: "C001", rootDir: checkpointDir,
		manifestPath: path.join(checkpointDir, "manifest.json"),
		feedbackPath: path.join(checkpointDir, "m04-feedback.md"),
		goalSnapshotPath: path.join(checkpointDir, "goal.json"),
		feedbackStatus: "complete", sourceGoalUpdatedAt: timestamp };
	const goal = { version: 1, runId: m07RunId, lifecycle: "active",
		goal: nextTask.objective,
		plan: nextTask.objective, constraints: ["Synthetic check"], successCriteria: ["Synthetic check"],
		problemRelation: `${LOCAL_M07_MISSION_BINDING_PREFIX}${contract.id}\n${contract.goal}`,
		updatedAt: timestamp, tasks: [task], executionState: { version: 1, activeAttemptId: "A001",
			attempts: [{ id: "A001", runDescriptor: { version: 1, instanceId: "synthetic",
				attemptId: "A001", workspaceId: "synthetic-workspace", codeRevision: "local-harness-v1",
				controlDir: root, processGroupId: 8800, process: p2 } }],
			operations: [{ version: 1, id: "O001", taskId: "T001", status: "response-received" }] },
		checkpoints: [checkpoint] };
	await writeFile(path.join(m07Dir, "goal.json"), JSON.stringify(goal));
	const lineage = { version: 1 as const, kind: "local-mission-m07-dispatch-lineage" as const,
		missionId: contract.id, intentId, oldAttempt: a2.source,
		intentCheckpoint: { sequence: old.sequence, sha256: old.sha256 },
		m07RunId, taskId: "T001", assessorTaskSha256: assessorTaskHash(nextTask),
		m07TaskInputsSha256: localLineageHash(JSON.stringify(task.inputs)),
		m07TaskChecksSha256: localLineageHash(JSON.stringify(task.checks)), m07Owner: p2 };
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
async function legacyFixture(t: TestContext) {
	const f = await fixture(t, "missing");
	const goal = JSON.parse(await readFile(path.join(f.m07Dir, "goal.json"), "utf8"));
	const toolLog = goal.tasks[0].toolLog as Array<{ name: string; ok: boolean }>;
	const file = path.join(f.root, "legacy-effect-review.json");
	const m04SessionFile = path.join(f.m04Dir, "synthetic-session.jsonl");
	const review: LegacyEffectReviewV1 = { version: 1, kind: "local-legacy-effect-review",
		source: { commit: LEGACY_SERIAL_COMMIT, tree: LEGACY_SERIAL_TREE,
			serialEntryAuditSha256: LEGACY_SERIAL_AUDIT_SHA256 },
		censusSha256: await fullLocalMissionCensus(f.ws,
			{ intentId: f.request.intentId, m07RunId: f.request.m07RunId }),
		toolLogSha256: localLineageHash(JSON.stringify(toolLog)),
		m04SessionSha256: sha(await readFile(m04SessionFile)),
		toolTranscriptCensusSha256: localLineageHash(JSON.stringify([{
			fileSha256: sha(await readFile(goal.tasks[0].session.file)), calls: 55, results: 55,
			names: toolLog.map(entry => entry.name) }])),
		pairedToolCallCount: 55,
		toolCalls: toolLog.map((entry, index) => ({ ordinal: index + 1,
			entrySha256: localLineageHash(JSON.stringify(entry)),
			result: entry.ok ? "returned" : "returned-error",
			numericExit: index === 34 ? 1 : null,
			externalEffect: "observed-settled-within-trusted-host-scope",
			childEffect: "no-detected-lingering-process",
			networkEffect: "no-explicit-network-or-background-command" })),
		childProcess: { kind: "no-detected-lingering-process", processGroupId: 8800,
			method: "verified-dead-process-group" },
		network: { kind: "no-explicit-network-or-background-command",
			m07ProviderResponseReceived: true, m04LastRequestNotSent: true,
			m04SettledResponseCount: 36, otherOpenRequests: 0 },
		failedToolOrdinals: [35, 36],
		numericExitUnknownOrdinals: Array.from({ length: 34 }, (_, index) => index + 1),
		trustLimit: "same-uid-reviewed-observations-no-os-noninterference-proof",
		conclusion: "observed-settled-within-trusted-host-scope" };
	await writeFile(file, JSON.stringify(review));
	const request: LegacyInterruptedLocalReviewRequestV1 = { ...f.request,
		kind: "review-legacy-interrupted-local-dispatch", legacyEffectReviewFile: file,
		legacyEffectReviewSha256: sha(await readFile(file)) };
	return { ...f, request, review, reviewFile: file };
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

test("altered committed host receipt cannot be read as a reviewed checkpoint", async t => {
	const f = await fixture(t);
	await reconcileInterruptedLocalMission({ workspaceRoot: f.root, request: f.request, ...options });
	const file = path.join(f.missionRoot, "attempts", "A003", "checkpoints", "C00000004.json");
	const receipt = JSON.parse(await readFile(file, "utf8"));
	receipt.interruptedReview.intentId = "forged-intent";
	await writeFile(file, `${JSON.stringify(receipt)}\n`, { mode: 0o600 });
	await assert.rejects(LocalMissionHost.status(f.missionRoot), /reviewed checkpoint|interrupted review/);
});

test("stale or forged review, unknown send, live/reused owner, and unsettled M04 stay held", async t => {
	for (const variant of ["changed-checkpoint", "wrong-mission", "unknown-send", "live-owner",
		"reused-pid", "unsettled-transaction", "ambiguous-goal", "tampered-review",
		"legacy-no-edge", "one-sided-edge", "uncommitted-edge", "wrong-owner"] as const) {
		await t.test(variant, async t => {
			const f = await fixture(t, variant === "legacy-no-edge" ? "missing" :
				variant === "one-sided-edge" ? "mission-side" :
				variant === "uncommitted-edge" ? "both-uncommitted" : "committed");
			let request = f.request;
			let probe = dead;
			if (variant === "changed-checkpoint") request = { ...request, checkpointSha256: "0".repeat(64) };
			if (variant === "wrong-mission") request = { ...request, missionId: "other-mission" };
			if (variant === "unknown-send") {
				const file = path.join(f.m04Dir, "run.json");
				const run = JSON.parse(await readFile(file, "utf8"));
				run.failures = ["provider send status unknown"];
				await writeFile(file, JSON.stringify(run));
			}
			if (variant === "live-owner") probe = async () => ({ status: "alive", identityMatch: true, reason: "still live" });
			if (variant === "reused-pid") probe = async () => ({ status: "unknown", identityMatch: false, reason: "reused" });
			if (variant === "unsettled-transaction") {
				const file = path.join(f.m04Dir, "m04-transaction.json");
				const tx = JSON.parse(await readFile(file, "utf8"));
				tx.state = "merge-intent";
				await writeFile(file, JSON.stringify(tx));
			}
			if (variant === "ambiguous-goal") {
				const extra = f.ws.runDir("M07", "other-goal");
				await mkdir(extra, { recursive: true });
				await writeFile(path.join(extra, "run.json"), JSON.stringify({ stage: "M07", runId: "other-goal" }));
				const goal = JSON.parse(await readFile(path.join(f.m07Dir, "goal.json"), "utf8"));
				await writeFile(path.join(extra, "goal.json"), JSON.stringify(goal));
			}
			if (variant === "tampered-review") request = { ...request,
				providerProofSha256: "0".repeat(64) };
			if (variant === "wrong-owner") {
				const file = path.join(f.m07Dir, "goal.json");
				const goal = JSON.parse(await readFile(file, "utf8"));
				goal.executionState.attempts[0].runDescriptor.process = p1;
				await writeFile(file, JSON.stringify(goal));
			}
			await assert.rejects(reconcileInterruptedLocalMission({ workspaceRoot: f.root,
				request, currentIdentity: async () => p3, probePrior: probe }));
			assert.equal((await LocalMissionHost.status(f.missionRoot)).latestCheckpoint?.sequence, 3);
		});
	}
});

test("legacy serial review dry-runs without mutation, then commits only a fresh-work checkpoint", async t => {
	const f = await legacyFixture(t);
	const retained = await Promise.all([path.join(f.m07Dir, "goal.json"),
		path.join(f.m04Dir, "run.json"), path.join(f.m04Dir, "m04-transaction.json"),
		path.join(f.m04Dir, "synthetic-session.jsonl")].map(file => readFile(file)));
	const dry = await reconcileLegacyInterruptedLocalMission({ workspaceRoot: f.root,
		request: f.request, ...options, probeProcessGroup: async () => true, dryRun: true });
	assert.equal(dry.receipt.historicalExplicitDispatchBinding, false);
	assert.equal(dry.receipt.effectEvidence.toolCallCount, 55);
	assert.deepEqual(dry.receipt.effectEvidence.failedToolOrdinals, [35, 36]);
	assert.equal(dry.receipt.effectEvidence.numericExitUnknownOrdinals.length, 34);
	assert.equal((await LocalMissionHost.status(f.missionRoot)).latestCheckpoint?.sequence, 3);
	const applied = await reconcileLegacyInterruptedLocalMission({ workspaceRoot: f.root,
		request: f.request, ...options, probeProcessGroup: async () => true });
	assert.equal(applied.receipt.kind, "local-legacy-interruption-host-review");
	assert.equal(applied.progress.objectiveOutcome, "incomplete");
	assert.deepEqual(applied.progress.selectedArtifacts, []);
	assert.deepEqual(applied.progress.boundedRuns, [{ runId: f.request.m07RunId,
		outcome: "partial", acceptedTaskIds: [] }]);
	assert.deepEqual(applied.progress.continuation.unresolvedOperationIds, []);
	assert.equal(applied.progress.continuation.nextTask, undefined,
		"the old assessor task cannot be replayed as the successor");
	assert.equal((await LocalMissionHost.status(f.missionRoot)).latestCheckpoint?.version, 3);
	for (const [index, file] of [path.join(f.m07Dir, "goal.json"),
		path.join(f.m04Dir, "run.json"), path.join(f.m04Dir, "m04-transaction.json"),
		path.join(f.m04Dir, "synthetic-session.jsonl")].entries())
		assert((await readFile(file)).equals(retained[index]!));
	const retried = await reconcileLegacyInterruptedLocalMission({ workspaceRoot: f.root,
		request: f.request, ...options, probeProcessGroup: async () => true });
	assert.deepEqual(retried, applied);
	assert.equal((await LocalMissionHost.status(f.missionRoot)).latestCheckpoint?.sequence, 4);
});

test("tampered committed legacy review receipt is rejected on host read", async t => {
	const f = await legacyFixture(t);
	await reconcileLegacyInterruptedLocalMission({ workspaceRoot: f.root,
		request: f.request, ...options, probeProcessGroup: async () => true });
	const file = path.join(f.missionRoot, "attempts", "A003", "checkpoints", "C00000004.json");
	const receipt = JSON.parse(await readFile(file, "utf8"));
	receipt.legacyInterruptedReview.effectEvidence.toolReviewSha256 = "0".repeat(64);
	await writeFile(file, `${JSON.stringify(receipt)}\n`, { mode: 0o600 });
	await assert.rejects(LocalMissionHost.status(f.missionRoot), /review schema|interrupted review/);
});
test("later changes to old M04 settlement turn the reviewed host state into repair-needed", async t => {
	const f = await legacyFixture(t);
	await reconcileLegacyInterruptedLocalMission({ workspaceRoot: f.root,
		request: f.request, ...options, probeProcessGroup: async () => true });
	const file = path.join(f.m04Dir, "m04-transaction.json");
	const tx = JSON.parse(await readFile(file, "utf8"));
	tx.state = "merge-intent";
	await writeFile(file, JSON.stringify(tx));
	assert.equal((await LocalMissionHost.status(f.missionRoot)).repairRequired, true);
});
test("later unrelated workspace runs do not invalidate the frozen legacy census", async t => {
	const f = await legacyFixture(t);
	await reconcileLegacyInterruptedLocalMission({ workspaceRoot: f.root,
		request: f.request, ...options, probeProcessGroup: async () => true });
	const later = f.ws.runDir("M04", "later-independent-m04");
	await mkdir(later, { recursive: true });
	await writeFile(path.join(later, "run.json"), JSON.stringify({
		stage: "M04", runId: "later-independent-m04", status: "completed" }));
	await writeFile(path.join(later, "m04-transaction.json"), JSON.stringify({
		version: 1, kind: "m04-knowledge-transaction", m04RunId: "later-independent-m04",
		state: "no-proposal", attempts: [] }));
	assert.equal((await LocalMissionHost.status(f.missionRoot)).repairRequired, false);
});
test("prepared successor crash windows retry without changing the old checkpoint or duplicating review", async t => {
	for (const at of ["after-prepare", "after-rename"] as const) await t.test(at, async t => {
		const f = await legacyFixture(t);
		await assert.rejects(reconcileLegacyInterruptedLocalMission({ workspaceRoot: f.root,
			request: f.request, ...options, probeProcessGroup: async () => true,
			testCrashAt: at }), /synthetic crash/);
		const crashed = await LocalMissionHost.status(f.missionRoot);
		assert.equal(crashed.writerLockPresent, true);
		if (at === "after-prepare") {
			assert.equal(crashed.preparedReviewPending, true);
			assert.equal(crashed.latestCheckpoint?.sequence, 3,
				"no successor checkpoint is visible before atomic rename");
		} else assert.equal(crashed.latestCheckpoint?.sequence, 4);
		const recovered = await reconcileLegacyInterruptedLocalMission({ workspaceRoot: f.root,
			request: f.request, currentIdentity: async () => p4, probePrior: dead,
			probeProcessGroup: async () => true });
		assert.equal(recovered.receipt.kind, "local-legacy-interruption-host-review");
		const status = await LocalMissionHost.status(f.missionRoot);
		assert.equal(status.writerLockPresent, false);
		assert.equal(status.preparedReviewPending, false);
		assert.equal(status.latestCheckpoint?.sequence, 4);
		assert.equal(status.checkpointReceipts.filter(row => row.legacyInterruptedReview).length, 1);
	});
});
test("late validation failure leaves the old attempt current and allows a clean retry", async t => {
	const f = await legacyFixture(t);
	await assert.rejects(reconcileLegacyInterruptedLocalMission({ workspaceRoot: f.root,
		request: f.request, ...options, probeProcessGroup: async () => true,
		testBeforeCommit: async () => {
			const file = path.join(f.m04Dir, "m04-transaction.json");
			const tx = JSON.parse(await readFile(file, "utf8"));
			tx.state = "merge-intent";
			await writeFile(file, JSON.stringify(tx));
		} }), /changed|open|settled|transaction/);
	const status = await LocalMissionHost.status(f.missionRoot);
	assert.equal(status.currentAttempt?.attemptId, "A002");
	assert.equal(status.latestCheckpoint?.sequence, 3);
	assert.equal(status.preparedReviewPending, false);
	assert.equal(status.writerLockPresent, false);
});

test("legacy inference rejects competing launchers and incomplete source, owner, task or effects", async t => {
	for (const variant of ["concurrent-mission", "changed-source", "changed-owner", "changed-task",
		"incomplete-tool-census", "open-child", "open-network", "forged-effect-review",
		"nondefault-launcher", "unreadable-stage-census", "unknown-operation",
		"unsettled-merge", "other-m07-unknown", "unsupported-other-m04"] as const) {
		await t.test(variant, async t => {
			const f = await legacyFixture(t);
			let request = f.request;
			const review = structuredClone(f.review);
			if (variant === "concurrent-mission") {
				const source = path.join(f.ws.runDir("MISSION", f.request.intentId), "run.json");
				const extra = f.ws.runDir("MISSION", "other-synthetic-mission-run");
				await mkdir(extra, { recursive: true });
				await writeFile(path.join(extra, "run.json"), JSON.stringify({
					...JSON.parse(await readFile(source, "utf8")), runId: "other-synthetic-mission-run" }));
			}
			if (variant === "changed-source") review.source.tree = "0".repeat(40);
			if (variant === "nondefault-launcher") {
				const file = path.join(f.ws.runDir("MISSION", f.request.intentId), "run.json");
				const run = JSON.parse(await readFile(file, "utf8"));
				run.sessions = [{ role: "execution", label: "alternate-launcher" }];
				await writeFile(file, JSON.stringify(run));
			}
			if (variant === "unreadable-stage-census")
				await mkdir(f.ws.runDir("M07", "bad-unreadable-run"), { recursive: true });
			if (variant === "changed-owner" || variant === "changed-task") {
				const file = path.join(f.m07Dir, "goal.json");
				const goal = JSON.parse(await readFile(file, "utf8"));
				if (variant === "changed-owner") goal.executionState.attempts[0].runDescriptor.process = p1;
				else goal.tasks[0].inputs = ["different-input.txt"];
				await writeFile(file, JSON.stringify(goal));
			}
			if (variant === "unknown-operation") {
				const file = path.join(f.m07Dir, "goal.json");
				const goal = JSON.parse(await readFile(file, "utf8"));
				goal.executionState.operations[0].status = "unknown";
				await writeFile(file, JSON.stringify(goal));
			}
			if (variant === "unsettled-merge") {
				const file = path.join(f.m04Dir, "m04-transaction.json");
				const tx = JSON.parse(await readFile(file, "utf8"));
				tx.state = "merge-intent";
				await writeFile(file, JSON.stringify(tx));
			}
			if (variant === "other-m07-unknown") {
				const extra = f.ws.runDir("M07", "other-synthetic-m07");
				await mkdir(extra, { recursive: true });
				await writeFile(path.join(extra, "run.json"), JSON.stringify({
					stage: "M07", runId: "other-synthetic-m07", status: "completed" }));
				await writeFile(path.join(extra, "goal.json"), JSON.stringify({ version: 1,
					runId: "other-synthetic-m07", lifecycle: "finished",
					tasks: [{ taskId: "T001", status: "unknown" }],
					executionState: { version: 1, attempts: [], operations: [
						{ id: "O001", status: "unknown" }] } }));
			}
			if (variant === "unsupported-other-m04") {
				const extra = f.ws.runDir("M04", "other-synthetic-m04");
				await mkdir(extra, { recursive: true });
				await writeFile(path.join(extra, "run.json"), JSON.stringify({
					stage: "M04", runId: "other-synthetic-m04", status: "failed" }));
				await writeFile(path.join(extra, "m04-transaction.json"), JSON.stringify({
					version: 1, kind: "m04-knowledge-transaction", m04RunId: "other-synthetic-m04",
					state: "unsupported", attempts: [] }));
			}
			if (variant === "incomplete-tool-census") review.toolCalls.pop();
			if (variant === "open-network") Object.assign(review.network, { otherOpenRequests: 1 });
			if (["changed-source", "incomplete-tool-census", "open-network"].includes(variant)) {
				await writeFile(f.reviewFile, JSON.stringify(review));
				request = { ...request, legacyEffectReviewSha256: sha(await readFile(f.reviewFile)) };
			}
			if (variant === "forged-effect-review")
				request = { ...request, legacyEffectReviewSha256: "0".repeat(64) };
			await assert.rejects(reconcileLegacyInterruptedLocalMission({ workspaceRoot: f.root,
				request, ...options, probeProcessGroup: async () => variant !== "open-child",
				dryRun: true }));
			assert.equal((await LocalMissionHost.status(f.missionRoot)).latestCheckpoint?.sequence, 3);
		});
	}
});
