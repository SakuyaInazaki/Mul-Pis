import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, rm, stat, truncate, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { createOriginalObjective, objectiveProgress } from "../src/m07/objective-progress.ts";
import { reconcileInterruptedLocalMission, reconcileLegacyInterruptedLocalMission,
	reconcileColdMigratedLocalMission, reconcileFailedM04LocalMission,
	type FailedM04LocalReviewRequestV1, type ColdMigrationLocalReviewRequestV1,
	type InterruptedLocalReviewRequestV1, type LegacyInterruptedLocalReviewRequestV1 } from
	"../src/m07/local-interrupted-reconcile.ts";
import { fullLocalMissionCensus, LEGACY_SERIAL_AUDIT_SHA256, LEGACY_SERIAL_COMMIT,
	LEGACY_SERIAL_TREE, verifyLegacySerialSource, pairedToolTranscript,
	type LegacyEffectReviewV1 } from "../src/m07/local-legacy-review.ts";
import type { FailedM04EffectReviewV1 } from "../src/m07/local-failed-m04-effects.ts";
import { hashStableHistoricalFile, pairedHistoricalToolTranscript } from
	"../src/m07/local-failed-m04-effects.ts";
import { LOCAL_M07_MISSION_BINDING_PREFIX } from "../src/m07/local-m07-adapter.ts";
import { openDefaultLocalMission } from "../src/m07/local-mission.ts";
import { assessorTaskHash, goalLineageFile, localLineageBytes, localLineageHash,
	missionLineageCommitFile, missionLineageFile,
	recordLocalDispatchLineage } from "../src/m07/local-dispatch-lineage.ts";
import { LocalMissionHost, type ColdMigrationObservationV1 } from "../src/runner/local-mission-host.ts";
import type { ProcessIdentityV1, ProcessProbe } from "../src/runtime/process-identity.ts";
import { readCurrentProcessIdentity } from "../src/runtime/process-identity.ts";
import { FakeSessionRunner } from "../src/runner/fake.ts";
import { Workspace } from "../src/workspace.ts";
import { createFileKnowledgeStore } from "../src/knowledge/store.ts";

const sha = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
const p1: ProcessIdentityV1 = { hostId: "local-host", bootId: "local-boot", pid: 1001, processStartToken: "111" };
const p2: ProcessIdentityV1 = { ...p1, pid: 1002, processStartToken: "222" };
const p3: ProcessIdentityV1 = { ...p1, pid: 1003, processStartToken: "333" };
const p4: ProcessIdentityV1 = { ...p1, pid: 1004, processStartToken: "444" };
const remote: ProcessIdentityV1 = { hostId: "successor-host", bootId: "successor-boot",
	pid: 2001, processStartToken: "555" };
const remoteRetry: ProcessIdentityV1 = { ...remote, pid: 2002, processStartToken: "666" };
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
async function fixture(t: TestContext, link: "committed" | "missing" | "mission-side" | "both-uncommitted" = "committed",
	mixed = false, oldHost?: ProcessIdentityV1) {
	const owner1 = oldHost ? { ...p1, hostId: oldHost.hostId, bootId: oldHost.bootId } : p1;
	const owner2 = oldHost ? { ...p2, hostId: oldHost.hostId, bootId: oldHost.bootId } : p2;
	const root = await mkdtemp(path.join(os.tmpdir(), "local-interrupted-review-"));
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
async function legacyFixture(t: TestContext,
	supplied?: Awaited<ReturnType<typeof fixture>>) {
	const f = supplied ?? await fixture(t, "missing");
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
async function coldFixture(t: TestContext,
	supplied?: Awaited<ReturnType<typeof fixture>>) {
	const f = await legacyFixture(t, supplied);
	const reviewedEffects = structuredClone(f.review);
	reviewedEffects.childProcess = { kind: "no-detected-lingering-process", processGroupId: null,
		method: "reviewed-tool-and-process-census" };
	await writeFile(f.reviewFile, JSON.stringify(reviewedEffects));
	f.request.legacyEffectReviewSha256 = sha(await readFile(f.reviewFile));
	const archiveFile = path.join(f.root, "retained-pre-migration-archive.bin");
	await writeFile(archiveFile, "retained synthetic archive\n");
	const archiveSha256 = sha(await readFile(archiveFile));
	const observation: ColdMigrationObservationV1 = { version: 1,
		kind: "trusted-original-host-terminal-observation", missionId: f.request.missionId,
		intentId: f.request.intentId, oldAttemptId: f.request.oldAttemptId, oldOwner: p2,
		oldCheckpoint: { sequence: f.request.checkpointSequence, sha256: f.request.checkpointSha256 },
		terminal: { messageId: "original-host-exit-001", observedAt: "2026-10-09T20:43:53Z",
			state: "old-owner-terminal", exitCode: 1 },
		effectCensus: { messageId: "original-host-scan-002", observedAt: "2026-10-09T21:09:00Z",
			workspaceCensusSha256: f.review.censusSha256, processGroupId: null, state: "observed-settled" },
		archive: { sha256: archiveSha256, checkpointSha256: f.request.checkpointSha256 },
		provenance: "trusted-host-reviewed-contemporaneous-platform-observations",
		launch: "reviewed-one-shot", autoRestarter: "none-observed",
		fence: "destination-exclusive-claim",
		limit: "same-uid-observations-no-cross-host-os-or-permanent-copy-lock-proof" };
	const observationFile = path.join(f.root, "retained-host-observation.json");
	await writeFile(observationFile, `${JSON.stringify(observation)}\n`);
	const request: ColdMigrationLocalReviewRequestV1 = { ...f.request,
		kind: "review-cold-migrated-local-dispatch", observationFile,
		observationSha256: sha(await readFile(observationFile)), archiveFile, archiveSha256 };
	const verifyTrustedObservation = async (value: ColdMigrationObservationV1) => {
		assert.deepEqual(value, observation);
	};
	return { ...f, request, observation, observationFile, archiveFile, verifyTrustedObservation };
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

test("reviewed cold migration publishes one fresh-work V5 successor on another host", async t => {
	const f = await coldFixture(t);
	const old = await readFile(path.join(f.missionRoot, "attempts", "A002", "checkpoints", "C00000003.bin"));
	const input = { workspaceRoot: f.root, request: f.request,
		currentIdentity: async () => remote, verifyTrustedObservation: f.verifyTrustedObservation,
		probePrior: async (): Promise<ProcessProbe> => ({ status: "unknown", identityMatch: false,
			reason: "other host" }) };
	const completed = await reconcileColdMigratedLocalMission(input);
	assert.equal(completed.receipt.kind, "local-cold-migration-host-review");
	assert.equal(completed.receipt.oldAttempt.process.hostId, p2.hostId);
	assert.equal(completed.receipt.newAttempt.process.hostId, remote.hostId);
	assert.equal(completed.progress.continuation.pendingAction?.safety, "fresh-work-only");
	assert.equal(completed.progress.continuation.nextTask, undefined);
	const status = await LocalMissionHost.status(f.missionRoot);
	assert.equal(status.latestCheckpoint?.version, 5);
	assert.equal(status.latestCheckpoint?.coldMigrationReview?.coldMigration.observationSha256,
		f.request.observationSha256);
	assert.deepEqual(await reconcileColdMigratedLocalMission(input), completed);
	assert((await readFile(path.join(f.missionRoot, "attempts", "A002", "checkpoints", "C00000003.bin"))).equals(old));
	const next = await LocalMissionHost.begin({ root: f.missionRoot, missionId: f.request.missionId,
		attemptId: "A004", codeRevision: "local-harness-v1",
		currentIdentity: async () => remoteRetry, probePrior: dead });
	assert.equal(next.source.attemptId, "A004");
});

test("cold migration hashes a sparse archive beyond the control-file bound", async t => {
	const f = await coldFixture(t);
	await truncate(f.archiveFile, 70 * 1024 * 1024);
	const archiveSha256 = sha(await readFile(f.archiveFile));
	const observation = { ...f.observation, archive: { ...f.observation.archive, sha256: archiveSha256 } };
	await writeFile(f.observationFile, `${JSON.stringify(observation)}\n`);
	const request = { ...f.request, archiveSha256,
		observationSha256: sha(await readFile(f.observationFile)) };
	const result = await reconcileColdMigratedLocalMission({ workspaceRoot: f.root,
		request, currentIdentity: async () => remote,
		verifyTrustedObservation: async value => assert.deepEqual(value, observation), dryRun: true });
	assert.equal(result.receipt.kind, "local-cold-migration-host-review");
});

test("a V5 reviewed running MISSION is not redispatched by default mission step", async t => {
	const f = await coldFixture(t);
	const localOwner = await readCurrentProcessIdentity();
	const result = await reconcileColdMigratedLocalMission({ workspaceRoot: f.root,
		request: f.request, currentIdentity: async () => localOwner,
		verifyTrustedObservation: f.verifyTrustedObservation });
	assert.equal(result.receipt.newAttempt.process.hostId, localOwner.hostId);
	let prompts = 0;
	const runner = new FakeSessionRunner((): string => {
		prompts++;
		if (prompts > 4)
			throw new DOMException("Synthetic stop after repeated invalid assessor replies", "AbortError");
		return "Synthetic malformed assessor response";
	});
	const mission = openDefaultLocalMission({ workspaceRoot: f.root, runner,
		config: { roles: { research: "fake/research", execution: "fake/execution" },
			localMission: { evaluatorId: "host:file-sha256" }, concurrency: 1 } as any });
	const stepped = await mission.step(f.request.missionId);
	assert(prompts > 0, `fresh assessment must begin after V5 review: ${JSON.stringify({
		stopReason: stepped.stopReason, continuation: stepped.continuation })}`);
	assert.equal((await LocalMissionHost.status(f.missionRoot)).currentAttempt?.attemptId, "A003");
	assert.equal((await f.ws.readRun("MISSION", f.request.intentId)).status, "running");
});

test("cold migration rejects forged or stale origin observations without treating another host as dead", async t => {
	for (const variant of ["untrusted", "wrong-owner", "wrong-host", "wrong-boot",
		"wrong-message-ref", "wrong-checkpoint", "wrong-census",
		"auto-restarter", "changed-archive", "stale-checkpoint", "remote-group-probe",
		"noncanonical-observation"] as const) await t.test(variant, async t => {
		const f = await coldFixture(t);
		let request = f.request;
		let verify = f.verifyTrustedObservation;
		if (variant === "untrusted") verify = async () => { throw new Error("source not authenticated"); };
		if (["wrong-owner", "wrong-host", "wrong-boot", "wrong-message-ref",
			"wrong-checkpoint", "wrong-census", "auto-restarter"].includes(variant)) {
			const changed = structuredClone(f.observation);
			if (variant === "wrong-owner") changed.oldOwner.processStartToken = "other-birth";
			if (variant === "wrong-host") changed.oldOwner.hostId = "other-original-host";
			if (variant === "wrong-boot") changed.oldOwner.bootId = "other-original-boot";
			if (variant === "wrong-message-ref") changed.terminal.messageId = "wrong-platform-message";
			if (variant === "wrong-checkpoint") changed.oldCheckpoint.sha256 = "0".repeat(64);
			if (variant === "wrong-census") changed.effectCensus.workspaceCensusSha256 = "0".repeat(64);
			if (variant === "auto-restarter") (changed as any).autoRestarter = "observed";
			await writeFile(f.observationFile, `${JSON.stringify(changed)}\n`);
			request = { ...request, observationSha256: sha(await readFile(f.observationFile)) };
		}
		if (variant === "changed-archive") await writeFile(f.archiveFile, "changed archive\n");
		if (variant === "noncanonical-observation") {
			await writeFile(f.observationFile, JSON.stringify(f.observation, null, 2));
			request = { ...request, observationSha256: sha(await readFile(f.observationFile)) };
		}
		if (variant === "remote-group-probe") {
			const review = JSON.parse(await readFile(f.reviewFile, "utf8"));
			review.childProcess = { kind: "no-detected-lingering-process", processGroupId: 8800,
				method: "verified-dead-process-group" };
			await writeFile(f.reviewFile, JSON.stringify(review));
			request = { ...request, legacyEffectReviewSha256: sha(await readFile(f.reviewFile)) };
		}
		if (variant === "stale-checkpoint") request = { ...request, checkpointSha256: "0".repeat(64) };
		await assert.rejects(reconcileColdMigratedLocalMission({ workspaceRoot: f.root,
			request, currentIdentity: async () => remote, verifyTrustedObservation: verify,
			probePrior: async (): Promise<ProcessProbe> => ({ status: "unknown",
				identityMatch: false, reason: "other host" }), dryRun: true }));
		assert.equal((await LocalMissionHost.status(f.missionRoot)).latestCheckpoint?.sequence, 3);
	});
});

test("cold migration recovers both atomic publication crash windows on the successor host", async t => {
	for (const at of ["after-prepare", "after-rename"] as const) await t.test(at, async t => {
		const f = await coldFixture(t);
		await assert.rejects(reconcileColdMigratedLocalMission({ workspaceRoot: f.root,
			request: f.request, currentIdentity: async () => remote,
			verifyTrustedObservation: f.verifyTrustedObservation, testCrashAt: at }), /synthetic crash/);
		const crashed = await LocalMissionHost.status(f.missionRoot);
		assert.equal(crashed.latestCheckpoint?.sequence, at === "after-prepare" ? 3 : 4);
		const resumed = await reconcileColdMigratedLocalMission({ workspaceRoot: f.root,
			request: f.request, currentIdentity: async () => remoteRetry,
			verifyTrustedObservation: f.verifyTrustedObservation, probePrior: dead });
		assert.equal(resumed.receipt.kind, "local-cold-migration-host-review");
		assert.equal((await LocalMissionHost.status(f.missionRoot)).checkpointReceipts
			.filter(row => row.coldMigrationReview).length, 1);
	});
});

test("two cold successor hosts sharing one mission root admit only one reviewed attempt", async t => {
	const f = await coldFixture(t);
	const otherRemote: ProcessIdentityV1 = { ...remote, hostId: "other-successor-host",
		bootId: "other-successor-boot", pid: 3001 };
	const outcomes = await Promise.allSettled([remote, otherRemote].map(identity =>
		reconcileColdMigratedLocalMission({ workspaceRoot: f.root, request: f.request,
			currentIdentity: async () => identity,
			verifyTrustedObservation: f.verifyTrustedObservation })));
	assert.equal(outcomes.filter(item => item.status === "fulfilled").length, 1);
	assert.equal((await LocalMissionHost.status(f.missionRoot)).checkpointReceipts
		.filter(row => row.coldMigrationReview).length, 1);
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

test("host-reviewed failed M04 appends negative history and one atomic V6 successor", async t => {
	const f = await failedM04Fixture(t);
	const oldGoal = await readFile(path.join(f.m07Dir, "goal.json"));
	const oldM04 = await readFile(path.join(f.m04Dir, "run.json"));
	const result = await reconcileFailedM04LocalMission({ workspaceRoot: f.root,
		request: f.request, verifyTrustedEffects: f.verifyTrustedEffects, ...options });
	assert.equal(result.receipt.kind, "local-failed-m04-interruption-host-review");
	assert.deepEqual(result.progress.boundedRuns, [{ runId: f.request.m07RunId,
		outcome: "partial", acceptedTaskIds: [] }]);
	assert.equal(result.progress.objectiveOutcome, "incomplete");
	assert.equal(result.progress.stopReason, "objective-reassessment-pending");
	assert(f.attestations() >= 2, "host review rechecks effects under the commit lock");
	assert((await readFile(path.join(f.m07Dir, "goal.json"))).equals(oldGoal));
	assert((await readFile(path.join(f.m04Dir, "run.json"))).equals(oldM04));
	const status = await LocalMissionHost.status(f.missionRoot);
	assert.equal(status.latestCheckpoint?.version, 6);
	assert.equal(status.latestCheckpoint?.failedM04Review?.intentId, f.request.intentId);
	const retried = await reconcileFailedM04LocalMission({ workspaceRoot: f.root,
		request: f.request, verifyTrustedEffects: f.verifyTrustedEffects, ...options });
	assert.deepEqual(retried, result);
	assert.equal((await LocalMissionHost.status(f.missionRoot)).checkpointReceipts
		.filter(row => row.failedM04Review).length, 1);
});

test("mixed formal checks and multiple M04 sessions remain negative evidence", async t => {
	const f = await failedM04Fixture(t, true, true);
	const result = await reconcileFailedM04LocalMission({ workspaceRoot: f.root,
		request: f.request, verifyTrustedEffects: f.verifyTrustedEffects, ...options });
	assert.equal(result.receipt.m04.sessions.length, 2);
	assert.deepEqual(result.receipt.effectReview.m04Sessions, result.receipt.m04.sessions);
	assert.deepEqual(result.progress.boundedRuns[0]?.acceptedTaskIds, []);
	assert.equal(result.progress.objectiveOutcome, "incomplete");
	assert.equal((await LocalMissionHost.status(f.missionRoot)).repairRequired, false);
});

test("V6 hashes a long historical M04 session without a transcript size gate", async t => {
	const f = await failedM04Fixture(t);
	const session = path.join(f.m04Dir, "synthetic-session.jsonl");
	await truncate(session, 70 * 1024 * 1024);
	const review = structuredClone(f.review);
	review.m04Sessions[0]!.fileSha256 = await hashStableHistoricalFile(session);
	await writeFile(f.reviewFile, JSON.stringify(review));
	const request = { ...f.request, effectReviewSha256: sha(await readFile(f.reviewFile)) };
	const result = await reconcileFailedM04LocalMission({ workspaceRoot: f.root,
		request, verifyTrustedEffects: f.verifyTrustedEffects, ...options });
	assert.equal(result.receipt.m04.sessions[0]?.fileSha256, review.m04Sessions[0]?.fileSha256);
	assert.equal((await LocalMissionHost.status(f.missionRoot)).repairRequired, false);
});

test("later unrelated knowledge and M04 records leave V6 historical evidence readable", async t => {
	const f = await failedM04Fixture(t);
	await reconcileFailedM04LocalMission({ workspaceRoot: f.root,
		request: f.request, verifyTrustedEffects: f.verifyTrustedEffects, ...options });
	const newM04 = f.ws.runDir("M04", "later-reviewed-m04");
	await mkdir(newM04, { recursive: true });
	await writeFile(path.join(newM04, "run.json"), JSON.stringify({ stage: "M04",
		runId: "later-reviewed-m04", status: "completed", inputs: [], sessions: [],
		outputs: [], failures: [], remarks: [], startedAt: new Date().toISOString() }));
	assert.equal((await LocalMissionHost.status(f.missionRoot)).repairRequired, false);
});

test("post-commit M07 tool transcript changes make V6 history repair-needed", async t => {
	const f = await failedM04Fixture(t);
	await reconcileFailedM04LocalMission({ workspaceRoot: f.root,
		request: f.request, verifyTrustedEffects: f.verifyTrustedEffects, ...options });
	const sessionFile = path.join(f.m07Dir, "synthetic-builder.jsonl");
	await writeFile(sessionFile, `${await readFile(sessionFile, "utf8")}${JSON.stringify({
		type: "message", message: { role: "assistant", content: [{ type: "toolCall",
			id: "late-unpaired-call", name: "bash" }] } })}\n`);
	assert.equal((await LocalMissionHost.status(f.missionRoot)).repairRequired, true);
});

for (const variant of ["result-before-call", "duplicate-call", "orphan-result",
	"ancestor-session", "wrong-session", "late-session"] as const)
test(`historical transcript census rejects ${variant}`, async t => {
	const f = await failedM04Fixture(t);
	const goal = JSON.parse(await readFile(path.join(f.m07Dir, "goal.json"), "utf8"));
	const file = path.join(f.m07Dir, "synthetic-builder.jsonl");
	const lines = (await readFile(file, "utf8")).trim().split("\n");
	if (variant === "result-before-call") [lines[0], lines[1]] = [lines[1]!, lines[0]!];
	else if (variant === "duplicate-call") lines.splice(1, 0, lines[0]!);
	else if (variant === "orphan-result") lines.splice(1, 0, JSON.stringify({ type: "message",
		message: { role: "toolResult", toolCallId: "orphan", isError: false } }));
	else if (variant === "ancestor-session") lines.unshift(JSON.stringify({ type: "session",
		id: goal.tasks[0].session.id, parentSession: "synthetic-ancestor" }));
	else if (variant === "wrong-session") lines.unshift(JSON.stringify({ type: "session",
		id: "synthetic-foreign-session" }));
	else lines.push(JSON.stringify({ type: "session", id: goal.tasks[0].session.id }));
	await writeFile(file, `${lines.join("\n")}\n`);
	await assert.rejects(pairedHistoricalToolTranscript(goal.tasks[0]),
		/unmatched|incomplete tool result|duplicate|ancestor session|foreign/);
});

for (const variant of ["missing-builder-id", "missing-builder-file",
	"missing-reviewer-id", "missing-reviewer-file", "null-reviewer"] as const)
test(`historical transcript census rejects ${variant} session reference`, async t => {
	const f = await failedM04Fixture(t);
	const goal = JSON.parse(await readFile(path.join(f.m07Dir, "goal.json"), "utf8"));
	const task = goal.tasks[0];
	if (variant === "missing-builder-id") delete task.session.id;
	else if (variant === "missing-builder-file") delete task.session.file;
	else {
		const reviewerFile = path.join(f.m07Dir, "empty-reviewer.jsonl");
		await writeFile(reviewerFile, `${JSON.stringify({ type: "session",
			id: "synthetic-empty-reviewer" })}\n`);
		const reviewerSession: Record<string, unknown> | null = variant === "null-reviewer" ? null :
			{ id: "synthetic-empty-reviewer", file: reviewerFile };
		if (variant === "missing-reviewer-id") delete reviewerSession!.id;
		if (variant === "missing-reviewer-file") delete reviewerSession!.file;
		task.executionRounds = [{ reviewerSession }];
	}
	await assert.rejects(pairedHistoricalToolTranscript(task),
		/historical tool transcript set is missing or ambiguous/);
});

test("a second failed M04 recovery preserves the earlier reviewed running history", async t => {
	for (const predecessor of ["V2", "V3", "V5", "V6"] as const)
	await t.test(predecessor, async t => {
	const f = await failedM04Fixture(t);
	let firstProgress: Awaited<ReturnType<typeof reconcileFailedM04LocalMission>>["progress"];
	let oldSuccessor: ProcessIdentityV1 = p3;
	let newSuccessor: ProcessIdentityV1 = p4;
	if (predecessor === "V6") firstProgress = (await reconcileFailedM04LocalMission({
		workspaceRoot: f.root, request: f.request,
		verifyTrustedEffects: f.verifyTrustedEffects, ...options })).progress;
	else {
		if (predecessor !== "V2") for (const file of [missionLineageFile(f.missionRoot, f.request.intentId),
			goalLineageFile(f.m07Dir), missionLineageCommitFile(f.missionRoot,
				f.request.intentId)]) await rm(file);
		const { effectReviewFile: _effectFile, effectReviewSha256: _effectSha,
			...oldBase } = f.request;
		const originalRequest: InterruptedLocalReviewRequestV1 = { ...oldBase,
			kind: "review-interrupted-local-dispatch", providerProofFile: f.proofFile,
			providerProofSha256: sha(await readFile(f.proofFile)) };
		const priorFixture = { ...f, request: originalRequest };
		if (predecessor === "V2") firstProgress = (await reconcileInterruptedLocalMission({
			workspaceRoot: f.root, request: originalRequest, ...options })).progress;
		else if (predecessor === "V3") {
			const legacy = await legacyFixture(t, priorFixture);
			firstProgress = (await reconcileLegacyInterruptedLocalMission({ workspaceRoot: f.root,
				request: legacy.request, ...options, probeProcessGroup: async () => true })).progress;
		} else {
			const cold = await coldFixture(t, priorFixture);
			firstProgress = (await reconcileColdMigratedLocalMission({ workspaceRoot: f.root,
				request: cold.request, currentIdentity: async () => remote,
				verifyTrustedObservation: cold.verifyTrustedObservation })).progress;
			oldSuccessor = remote;
			newSuccessor = remoteRetry;
		}
	}
	const intentId = "synthetic-intent-002";
	const m07RunId = "synthetic-m07-002";
	const m04RunId = "synthetic-m04-002";
	const secondTask = { ...f.held.assessment!.nextTask!, objective: "A second bounded task" };
	const held = objectiveProgress(f.held.contract, { boundedRuns: firstProgress.boundedRuns,
		selectedArtifacts: [], assessment: { ...f.held.assessment!, nextTask: secondTask },
		stopReason: "execution-interrupted", unresolvedOperationIds: [intentId],
		pendingActionFacts: { unresolvedOperationRefs: [intentId],
			target: { goalRunId: intentId }, failedStage: "m07-execution" } });
	const owner = await LocalMissionHost.begin({ root: f.missionRoot,
		missionId: f.request.missionId, attemptId: "A003", codeRevision: "local-harness-v1",
		currentIdentity: async () => oldSuccessor });
	const prior = (await LocalMissionHost.status(f.missionRoot)).latestCheckpoint!;
	const checkpoint = await owner.recordCheckpoint({ attemptId: "A003", sequence: 5,
		previousSha256: prior.sha256, bytes: Buffer.from(`${JSON.stringify(held)}\n`) });
	const originalMission = await readFile(path.join(f.ws.runDir("MISSION", f.request.intentId), "run.json"), "utf8");
	const nextMission = f.ws.runDir("MISSION", intentId);
	await mkdir(nextMission, { recursive: true });
	await writeFile(path.join(nextMission, "run.json"), originalMission.replaceAll(f.request.intentId, intentId));
	const newM07Dir = f.ws.runDir("M07", m07RunId);
	const newM04Dir = f.ws.runDir("M04", m04RunId);
	await cp(f.m07Dir, newM07Dir, { recursive: true });
	await cp(f.m04Dir, newM04Dir, { recursive: true });
	// The copied fixture edge belongs to the first dispatch; the second edge is
	// independently committed after the new checkpoint exists.
	if (predecessor === "V2" || predecessor === "V6")
		await rm(path.join(newM07Dir, "mission-dispatch-link.json"));
	const replace = (data: string) => data.replaceAll(f.m07Dir, newM07Dir)
		.replaceAll(f.m04Dir, newM04Dir)
		.replaceAll(f.request.m07RunId, m07RunId)
		.replaceAll(f.request.m04RunId, m04RunId);
	for (const file of [path.join(newM07Dir, "run.json"), path.join(newM07Dir, "goal.json"),
		path.join(newM07Dir, "checkpoints", "C001", "goal.json"),
		path.join(newM07Dir, "checkpoints", "C001", "manifest.json"),
		path.join(newM07Dir, "tasks", "T001", "work", "local-evaluator-receipt.json"),
		path.join(newM04Dir, "run.json"), path.join(newM04Dir, "m07-source.json"),
		path.join(newM04Dir, "m04-transaction.json")])
		await writeFile(file, replace(await readFile(file, "utf8")));
	for (const file of [path.join(newM07Dir, "goal.json"),
		path.join(newM07Dir, "checkpoints", "C001", "goal.json")]) {
		const goal = JSON.parse(await readFile(file, "utf8"));
		goal.goal = secondTask.objective; goal.plan = secondTask.objective;
		goal.tasks[0].objective = secondTask.objective;
		goal.executionState.attempts[0].runDescriptor.process = oldSuccessor;
		await writeFile(file, JSON.stringify(goal));
	}
	const evaluatorFile = path.join(newM07Dir, "tasks", "T001", "work", "local-evaluator-receipt.json");
	const lineage = { version: 1 as const, kind: "local-mission-m07-dispatch-lineage" as const,
		missionId: f.request.missionId, intentId, oldAttempt: owner.source,
		intentCheckpoint: { sequence: checkpoint.sequence, sha256: checkpoint.sha256 },
		m07RunId, taskId: "T001", assessorTaskSha256: assessorTaskHash(secondTask),
		m07TaskInputsSha256: localLineageHash(JSON.stringify((JSON.parse(await readFile(path.join(
			newM07Dir, "goal.json"), "utf8"))).tasks[0].inputs)),
		m07TaskChecksSha256: localLineageHash(JSON.stringify((JSON.parse(await readFile(path.join(
			newM07Dir, "goal.json"), "utf8"))).tasks[0].checks)), m07Owner: oldSuccessor };
	await recordLocalDispatchLineage({ missionRoot: f.missionRoot, m07Dir: newM07Dir, lineage });
	const review = structuredClone(f.review);
	review.scope = { ...review.scope, intentId,
		oldCheckpointSha256: checkpoint.sha256, m07RunId, m04RunId };
	review.workspaceCensusSha256 = await fullLocalMissionCensus(f.ws, { intentId, m07RunId,
		priorReviewed: [{ intentId: f.request.intentId, m07RunId: f.request.m07RunId }] });
	review.evaluatorReceiptSha256 = sha(await readFile(evaluatorFile));
	review.m04TransactionSha256 = sha(await readFile(path.join(newM04Dir, "m04-transaction.json")));
	review.m04Sessions = await Promise.all((JSON.parse(await readFile(path.join(newM04Dir,
		"run.json"), "utf8")).sessions as Array<{ id: string; file: string }>).map(async row => ({
		id: row.id, fileSha256: await hashStableHistoricalFile(row.file) })));
	const reviewFile = path.join(f.root, "second-failed-m04-effects.json");
	await writeFile(reviewFile, JSON.stringify(review));
	const request: FailedM04LocalReviewRequestV1 = { ...f.request, intentId,
		oldAttemptId: "A003", checkpointSequence: checkpoint.sequence,
		checkpointSha256: checkpoint.sha256, m07RunId, m04RunId,
		effectReviewFile: reviewFile, effectReviewSha256: sha(await readFile(reviewFile)) };
	const second = await reconcileFailedM04LocalMission({ workspaceRoot: f.root,
		request, verifyTrustedEffects: async value => assert.deepEqual(value.scope, review.scope),
		currentIdentity: async () => newSuccessor, probePrior: dead });
	assert.deepEqual(second.progress.boundedRuns.map(row => row.runId),
		[f.request.m07RunId, m07RunId]);
	assert.equal((await LocalMissionHost.status(f.missionRoot)).checkpointReceipts
		.filter(row => row.failedM04Review).length, predecessor === "V6" ? 2 : 1);
	});
});

test("default mission step resumes a fresh assessment after V6 review", async t => {
	const localOwner = await readCurrentProcessIdentity();
	const f = await failedM04Fixture(t, false, false, localOwner);
	await reconcileFailedM04LocalMission({ workspaceRoot: f.root,
		request: f.request, verifyTrustedEffects: f.verifyTrustedEffects,
		currentIdentity: async () => localOwner, probePrior: dead });
	let prompts = 0;
	const runner = new FakeSessionRunner((): string => {
		prompts++;
		if (prompts > 4)
			throw new DOMException("Synthetic stop after repeated invalid assessor replies", "AbortError");
		return "Synthetic malformed assessor response";
	});
	const mission = openDefaultLocalMission({ workspaceRoot: f.root, runner,
		config: { roles: { research: "fake/research", execution: "fake/execution" },
			localMission: { evaluatorId: "host:file-sha256" }, concurrency: 1 } as any });
	const stepped = await mission.step(f.request.missionId);
	assert(prompts > 0, `fresh assessor did not begin: ${stepped.stopReason}`);
	assert.equal(stepped.objectiveOutcome, "incomplete");
	assert.equal((await LocalMissionHost.status(f.missionRoot)).currentAttempt?.attemptId, "A003");
	assert.equal((await f.ws.readRun("MISSION", f.request.intentId)).status, "running");
});

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

test("failed M04 review holds altered effects, source, live owner and pending merge", async t => {
	for (const variant of ["unauthenticated", "altered-tool", "altered-session",
		"changed-receipt", "live-owner", "pending-merge", "missing-edge",
		"unpaired-tool", "unknown-effect", "knowledge-lock"] as const)
		await t.test(variant, async t => {
			const f = await failedM04Fixture(t);
			let probe: () => Promise<ProcessProbe> = dead;
			let verify = f.verifyTrustedEffects;
			if (variant === "unauthenticated") verify = async () => { throw new Error("untrusted effects"); };
			if (variant === "altered-tool") {
				const file = path.join(f.m07Dir, "goal.json");
				const goal = JSON.parse(await readFile(file, "utf8"));
				goal.tasks[0].toolLog[0].ok = false;
				await writeFile(file, JSON.stringify(goal));
			}
			if (variant === "altered-session") await writeFile(path.join(f.m04Dir,
				"synthetic-session.jsonl"), "changed session\n");
			if (variant === "changed-receipt") await writeFile(f.receiptFile, "{}\n");
			if (variant === "unpaired-tool") await writeFile(path.join(f.m07Dir,
				"synthetic-builder.jsonl"), `${JSON.stringify({ type: "message",
					message: { role: "assistant", content: [{ type: "toolCall", id: "dangling",
						name: "bash" }] } })}\n`);
			if (variant === "unknown-effect") {
				const changed = structuredClone(f.review) as any;
				changed.toolCalls[0].effect = "unknown";
				await writeFile(f.reviewFile, JSON.stringify(changed));
				f.request.effectReviewSha256 = sha(await readFile(f.reviewFile));
			}
			if (variant === "live-owner") probe = async () => ({ status: "alive",
				identityMatch: true, reason: "synthetic live owner" });
			if (variant === "pending-merge") {
				const file = path.join(f.m04Dir, "m04-transaction.json");
				const tx = JSON.parse(await readFile(file, "utf8")); tx.state = "merge-intent";
				await writeFile(file, JSON.stringify(tx));
			}
			if (variant === "missing-edge") await rm(missionLineageFile(f.missionRoot,
				f.request.intentId));
			if (variant === "knowledge-lock") await writeFile(path.join(f.ws.knowledgeDir,
				".merge.lock"), "unsettled\n");
			await assert.rejects(reconcileFailedM04LocalMission({ workspaceRoot: f.root,
				request: f.request, verifyTrustedEffects: verify,
				currentIdentity: async () => p3, probePrior: probe }));
			assert.equal((await LocalMissionHost.status(f.missionRoot)).latestCheckpoint?.sequence, 3);
		});
});

test("late failed M04 effect change cannot publish a successor", async t => {
	const f = await failedM04Fixture(t);
	await assert.rejects(reconcileFailedM04LocalMission({ workspaceRoot: f.root,
		request: f.request, verifyTrustedEffects: f.verifyTrustedEffects, ...options,
			testBeforeCommit: async () => { await writeFile(f.reviewFile,
				JSON.stringify({ ...f.review, otherOpenMutatingOperations: 1 })); } }));
	const status = await LocalMissionHost.status(f.missionRoot);
	assert.equal(status.latestCheckpoint?.sequence, 3);
	assert.equal(status.preparedReviewPending, false);
});

test("failed M04 recovery is atomic across both crash windows and concurrent claimants", async t => {
	for (const at of ["after-prepare", "after-rename"] as const) await t.test(at, async t => {
		const f = await failedM04Fixture(t);
		await assert.rejects(reconcileFailedM04LocalMission({ workspaceRoot: f.root,
			request: f.request, verifyTrustedEffects: f.verifyTrustedEffects,
			...options, testCrashAt: at }), /synthetic crash/);
		const retried = await reconcileFailedM04LocalMission({ workspaceRoot: f.root,
			request: f.request, verifyTrustedEffects: f.verifyTrustedEffects,
			currentIdentity: async () => p4, probePrior: dead });
		assert.equal(retried.receipt.kind, "local-failed-m04-interruption-host-review");
		assert.equal((await LocalMissionHost.status(f.missionRoot)).checkpointReceipts
			.filter(row => row.failedM04Review).length, 1);
	});
	const f = await failedM04Fixture(t);
	const outcomes = await Promise.allSettled([p3, p4].map(identity =>
		reconcileFailedM04LocalMission({ workspaceRoot: f.root, request: f.request,
			verifyTrustedEffects: f.verifyTrustedEffects,
			currentIdentity: async () => identity, probePrior: dead })));
	assert(outcomes.some(row => row.status === "fulfilled"));
	assert.equal((await LocalMissionHost.status(f.missionRoot)).checkpointReceipts
		.filter(row => row.failedM04Review).length, 1);
});
