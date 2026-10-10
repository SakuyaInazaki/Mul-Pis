/** Exact, host-owned reconciliation of a dead local mission dispatch. This is a
 * review of retained control evidence, not a resumption of any old session. */
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import path from "node:path";
import { LocalMissionHost, validColdMigrationObservation, type LocalInterruptedReviewV1,
	type LocalLegacyInterruptedReviewV1, type LocalColdMigrationReviewV1,
	type LocalFailedM04ReviewV1,
	type ColdMigrationObservationV1 } from "../runner/local-mission-host.ts";
import { readCurrentProcessIdentity, probeProcessIdentity,
	type ProcessIdentityV1, type ProcessProbe } from "../runtime/process-identity.ts";
import { Workspace } from "../workspace.ts";
import type { CurrentGoal } from "./types.ts";
import { LOCAL_M07_MISSION_BINDING_PREFIX } from "./local-m07-adapter.ts";
import { assessorTaskHash, goalLineageFile, localLineageHash,
	missionLineageCommitFile, missionLineageFile, readLocalDispatchLineage } from "./local-dispatch-lineage.ts";
import { fullLocalMissionCensus, LEGACY_SERIAL_AUDIT_SHA256, LEGACY_SERIAL_COMMIT,
	LEGACY_SERIAL_TREE, verifyLegacyEffectReview } from "./local-legacy-review.ts";
import { objectiveProgress, type ObjectiveProgressV1 } from "./objective-progress.ts";
import { readLocalEvaluatorReceipt, verifyLocalEvaluatorReceipt } from "./local-evaluator-run.ts";
import { hashStableHistoricalFile, verifyFailedM04EffectReview,
	type FailedM04EffectReviewV1 } from "./local-failed-m04-effects.ts";

const hash = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");
const id = (value: unknown): value is string => typeof value === "string" &&
	/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
const fail = (message: string): never => { throw new Error(`local mission reconciliation refused: ${message}`); };
async function bytes(file: string, max = 64 * 1024 * 1024): Promise<Buffer> {
	const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	try {
		const before = await handle.stat();
		if (!before.isFile() || before.nlink !== 1 || before.size < 1 || before.size > max)
			fail("evidence file is not bounded regular data");
		const value = await handle.readFile();
		const after = await handle.stat();
		if (value.length !== before.size || after.dev !== before.dev || after.ino !== before.ino ||
			after.size !== before.size || after.mtimeMs !== before.mtimeMs) fail("evidence changed while read");
		return value;
	} finally { await handle.close(); }
}
async function json<T>(file: string): Promise<{ value: T; sha256: string }> {
	const value = await bytes(file);
	return { value: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(value)) as T,
		sha256: hash(value) };
}
/** Stream an archive of any size without making its size a mission policy. */
async function hashStableArchive(file: string): Promise<string> {
	const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	try {
		const before = await handle.stat();
		if (!before.isFile() || before.nlink !== 1 || before.size < 1)
			fail("archive is not regular data");
		const state = createHash("sha256");
		const buffer = Buffer.allocUnsafe(1024 * 1024);
		let offset = 0;
		while (offset < before.size) {
			const { bytesRead } = await handle.read(buffer, 0,
				Math.min(buffer.length, before.size - offset), offset);
			if (bytesRead < 1) fail("archive changed while read");
			state.update(buffer.subarray(0, bytesRead));
			offset += bytesRead;
		}
		const after = await handle.stat();
		if (offset !== before.size || after.dev !== before.dev || after.ino !== before.ino ||
			after.size !== before.size || after.mtimeMs !== before.mtimeMs)
			fail("archive changed while read");
		return state.digest("hex");
	} finally { await handle.close(); }
}
export interface InterruptedLocalReviewRequestV1 {
	version: 1; kind: "review-interrupted-local-dispatch";
	missionId: string; intentId: string; oldAttemptId: string;
	checkpointSequence: number; checkpointSha256: string;
	m07RunId: string; taskId: string; operationId: string; checkpointId: string;
	m04RunId: string;
	/** Operator-reviewed transport witness. The host verifies its scope and pinned run error. */
	providerProofFile: string; providerProofSha256: string;
}
export interface LegacyInterruptedLocalReviewRequestV1 extends Omit<InterruptedLocalReviewRequestV1, "kind"> {
	kind: "review-legacy-interrupted-local-dispatch";
	legacyEffectReviewFile: string; legacyEffectReviewSha256: string;
}
export interface FailedM04LocalReviewRequestV1 extends Omit<InterruptedLocalReviewRequestV1,
	"kind" | "providerProofFile" | "providerProofSha256"> {
	kind: "review-failed-m04-local-dispatch";
	effectReviewFile: string; effectReviewSha256: string;
}
export interface ColdMigrationLocalReviewRequestV1 extends Omit<LegacyInterruptedLocalReviewRequestV1, "kind"> {
	kind: "review-cold-migrated-local-dispatch";
	observationFile: string; observationSha256: string;
	archiveFile: string; archiveSha256: string;
}
interface ProviderProofV1 {
	version: 1; kind: "m04-sdk-output-max-before-http-review";
	m04RunId: string; sessionId: string;
	error: "SDK DeepSeek request lowered or lost the resolved provider output maximum";
	lastRequestNotSent: true; earlierResponsesSettled: true;
	/** Fees and provider usage remain in the old ledger; this review never rewrites them. */
	accounting: "preserve-observed-usage";
}
async function reconcileCore(input: {
	workspaceRoot: string; request: InterruptedLocalReviewRequestV1 | LegacyInterruptedLocalReviewRequestV1 |
		ColdMigrationLocalReviewRequestV1 | FailedM04LocalReviewRequestV1;
	currentIdentity?: () => Promise<ProcessIdentityV1>;
	probePrior?: (identity: ProcessIdentityV1) => Promise<ProcessProbe>;
	probeProcessGroup?: (groupId: number) => Promise<boolean>;
	verifyTrustedObservation?: (observation: ColdMigrationObservationV1) => Promise<void>;
	verifyTrustedEffects?: (review: FailedM04EffectReviewV1) => Promise<void>;
	dryRun?: boolean;
	testCrashAt?: "after-prepare" | "after-rename";
	testBeforeCommit?: () => Promise<void>;
}): Promise<{ progress: ObjectiveProgressV1;
	receipt: LocalInterruptedReviewV1 | LocalLegacyInterruptedReviewV1 | LocalColdMigrationReviewV1 |
		LocalFailedM04ReviewV1 }> {
	const request = input.request;
	const cold = request?.kind === "review-cold-migrated-local-dispatch";
	const legacy = cold || request?.kind === "review-legacy-interrupted-local-dispatch";
	const failedM04 = request?.kind === "review-failed-m04-local-dispatch";
	if (!request || Object.keys(request).sort().join("|") !== ["version", "kind", "missionId",
		"intentId", "oldAttemptId", "checkpointSequence", "checkpointSha256", "m07RunId",
		"taskId", "operationId", "checkpointId", "m04RunId",
		...(failedM04 ? ["effectReviewFile", "effectReviewSha256"] :
			["providerProofFile", "providerProofSha256"]),
		...(legacy ? ["legacyEffectReviewFile", "legacyEffectReviewSha256"] : []),
		...(cold ? ["observationFile", "observationSha256", "archiveFile", "archiveSha256"] : [])].sort().join("|") || request.version !== 1 ||
		!(["review-interrupted-local-dispatch", "review-legacy-interrupted-local-dispatch",
			"review-cold-migrated-local-dispatch", "review-failed-m04-local-dispatch"] as unknown[]).includes(request.kind) ||
		![request.missionId, request.intentId, request.oldAttemptId, request.m07RunId,
			request.taskId, request.operationId, request.checkpointId, request.m04RunId].every(id) ||
		!Number.isSafeInteger(request.checkpointSequence) || request.checkpointSequence < 1 ||
		![request.checkpointSha256, failedM04 ? request.effectReviewSha256 : request.providerProofSha256,
			...(legacy ? [(request as LegacyInterruptedLocalReviewRequestV1).legacyEffectReviewSha256] : []),
			...(cold ? [(request as ColdMigrationLocalReviewRequestV1).observationSha256,
				(request as ColdMigrationLocalReviewRequestV1).archiveSha256] : [])].every(x =>
			typeof x === "string" && /^[0-9a-f]{64}$/.test(x)) ||
		!(failedM04 ? path.isAbsolute(request.effectReviewFile) :
			path.isAbsolute(request.providerProofFile)) ||
		(failedM04 && typeof input.verifyTrustedEffects !== "function") ||
		(legacy && !path.isAbsolute((request as LegacyInterruptedLocalReviewRequestV1).legacyEffectReviewFile)) ||
		(cold && (!path.isAbsolute((request as ColdMigrationLocalReviewRequestV1).observationFile) ||
			!path.isAbsolute((request as ColdMigrationLocalReviewRequestV1).archiveFile) ||
			typeof input.verifyTrustedObservation !== "function")))
		fail("review request is invalid");
	const ws = new Workspace(input.workspaceRoot);
	const root = path.join(ws.agentDir, "missions", request.missionId);
	const currentProcess = await (input.currentIdentity ?? readCurrentProcessIdentity)();
	if (!input.dryRun) await LocalMissionHost.recoverReviewLock({ root,
		intentId: request.intentId, oldCheckpointSha256: request.checkpointSha256,
		currentIdentity: input.currentIdentity, probePrior: input.probePrior });
	const status = await LocalMissionHost.status(root);
	if (status.repairRequired && !(status.preparedReviewPending && !status.writerLockPresent && !input.dryRun))
		fail("local mission host has unresolved repair evidence");
	const committed = status.checkpointReceipts.find(row =>
		(row.interruptedReview?.intentId === request.intentId ||
			row.legacyInterruptedReview?.intentId === request.intentId ||
			row.coldMigrationReview?.intentId === request.intentId ||
			row.failedM04Review?.intentId === request.intentId));
	if (committed) {
		const review = committed.interruptedReview ?? committed.legacyInterruptedReview ??
			committed.coldMigrationReview ?? committed.failedM04Review!;
		if (review.oldCheckpoint.sequence !== request.checkpointSequence ||
			review.oldCheckpoint.sha256 !== request.checkpointSha256 ||
			review.missionId !== request.missionId ||
			review.oldAttempt.attemptId !== request.oldAttemptId ||
			review.m07.runId !== request.m07RunId || review.m07.taskId !== request.taskId ||
			review.m07.operationId !== request.operationId ||
			review.m07.checkpointId !== request.checkpointId ||
			review.m04.runId !== request.m04RunId ||
			(review.kind === "local-cold-migration-host-review") !== cold ||
			(review.kind === "local-legacy-interruption-host-review") !== (legacy && !cold) ||
			(review.kind === "local-failed-m04-interruption-host-review") !== failedM04 ||
			failedM04 && (review as LocalFailedM04ReviewV1).effectReviewFileSha256 !==
				(request as FailedM04LocalReviewRequestV1).effectReviewSha256)
			fail("committed review does not match this exact retry");
		return { progress: JSON.parse((await LocalMissionHost.readCommittedCheckpoint(root,
			committed.sequence)).toString("utf8")) as ObjectiveProgressV1, receipt: review };
	}
	const checkpoint = status.checkpointReceipts.find(row => row.sequence === request.checkpointSequence &&
		row.sha256 === request.checkpointSha256);
	const old = checkpoint?.source;
	if (!old || !checkpoint) throw new Error("local mission reconciliation refused: mission has no committed old attempt and checkpoint");
	if (status.writerLockPresent || status.unresolvedOperationIds.length ||
		old.attemptId !== request.oldAttemptId || old.missionId !== request.missionId ||
		status.latestCheckpoint?.sha256 !== checkpoint.sha256 ||
		checkpoint.sequence !== request.checkpointSequence || checkpoint.sha256 !== request.checkpointSha256 ||
		!status.currentAttempt)
		fail("old attempt or committed checkpoint is stale, unrecoverable, or already reviewed");
	let coldObservation: ColdMigrationObservationV1 | undefined;
	if (cold) {
		const coldRequest = request as ColdMigrationLocalReviewRequestV1;
		const observed = await json<ColdMigrationObservationV1>(coldRequest.observationFile);
		if (observed.sha256 !== coldRequest.observationSha256 ||
			!validColdMigrationObservation(observed.value) ||
			observed.sha256 !== hash(Buffer.from(`${JSON.stringify(observed.value)}\n`, "utf8")) ||
			await hashStableArchive(coldRequest.archiveFile) !== coldRequest.archiveSha256 ||
			observed.value.archive.sha256 !== coldRequest.archiveSha256 ||
			observed.value.archive.checkpointSha256 !== checkpoint.sha256 ||
			observed.value.missionId !== request.missionId || observed.value.intentId !== request.intentId ||
			observed.value.oldAttemptId !== old.attemptId ||
			JSON.stringify(observed.value.oldOwner) !== JSON.stringify(old.process) ||
			observed.value.oldCheckpoint.sequence !== checkpoint.sequence ||
			observed.value.oldCheckpoint.sha256 !== checkpoint.sha256 ||
			observed.value.launch !== "reviewed-one-shot" ||
			observed.value.autoRestarter !== "none-observed" ||
			observed.value.fence !== "destination-exclusive-claim" ||
			old.process.hostId === currentProcess.hostId)
			fail("cold migration observation does not bind the original host and archive");
		await input.verifyTrustedObservation!(observed.value);
		coldObservation = observed.value;
	} else {
		const oldProbe = await (input.probePrior ?? probeProcessIdentity)(old.process);
		if (oldProbe.status !== "dead" || oldProbe.identityMatch ||
			old.process.hostId !== currentProcess.hostId || old.process.bootId !== currentProcess.bootId ||
			old.process.pid === currentProcess.pid && old.process.processStartToken === currentProcess.processStartToken)
			fail("old process death on this host and boot is not verified");
	}
	const oldBytes = await LocalMissionHost.readCommittedCheckpoint(root, checkpoint.sequence);
	const progress = JSON.parse(oldBytes.toString("utf8")) as ObjectiveProgressV1;
	if (progress.version !== 1 || progress.kind !== "original-objective-progress" ||
		progress.contract.id !== request.missionId || progress.objectiveOutcome !== "incomplete" ||
		progress.stopReason !== "execution-interrupted" ||
		progress.continuation.pendingAction?.kind !== "reconcile-interrupted-run" ||
		progress.continuation.pendingAction.safety !== "no-replay-until-reconciled" ||
		progress.continuation.pendingAction.target?.goalRunId !== request.intentId ||
		JSON.stringify(progress.continuation.unresolvedOperationIds) !== JSON.stringify([request.intentId]) ||
		progress.boundedRuns.some(row => row.runId === request.m07RunId))
		fail("checkpoint has no unique mission-level interrupted dispatch intent");
	const priorReviewed: Array<{ intentId: string; m07RunId: string }> = [];
	for (const row of status.checkpointReceipts) {
		if (row.sequence >= checkpoint.sequence) continue;
		const review = row.failedM04Review ?? row.interruptedReview ??
			row.evaluatorRecoveryReview ?? row.legacyInterruptedReview ?? row.coldMigrationReview;
		if (!review || review.missionId !== request.missionId ||
			!progress.boundedRuns.some(bounded => bounded.runId === review.m07.runId)) continue;
		const priorM07Dir = ws.runDir("M07", review.m07.runId);
		if ("lineageSha256" in review) {
			const priorLink = await readLocalDispatchLineage({ missionRoot: root,
				m07Dir: priorM07Dir, intentId: review.intentId }).catch(() =>
				fail("prior reviewed running stage lacks its committed dispatch edge"));
			if (priorLink.sha256 !== review.lineageSha256 ||
				priorLink.lineage.missionId !== request.missionId ||
				priorLink.lineage.intentId !== review.intentId ||
				priorLink.lineage.m07RunId !== review.m07.runId)
				fail("prior reviewed running stage differs from its exact dispatch edge");
		} else if (review.kind !== "local-legacy-interruption-host-review" &&
			review.kind !== "local-cold-migration-host-review")
			fail("prior reviewed running stage has no supported historical proof");
		if (review.kind === "local-interrupted-dispatch-review") {
			const priorM04Dir = ws.runDir("M04", review.m04.runId);
			const priorCp = path.join(priorM07Dir, "checkpoints", review.m07.checkpointId);
			for (const [file, expected] of [
				[path.join(ws.runDir("MISSION", review.intentId), "run.json"), review.missionRunSha256],
				[path.join(priorM07Dir, "goal.json"), review.m07.goalSha256],
				[path.join(priorCp, "goal.json"), review.m07.snapshotSha256],
				[path.join(priorCp, "manifest.json"), review.m07.manifestSha256],
				[path.join(priorCp, "m04-feedback.md"), review.m07.feedbackSha256],
				[path.join(priorM04Dir, "run.json"), review.m04.runSha256],
				[path.join(priorM04Dir, "m07-source.json"), review.m04.sourceSha256],
				[path.join(priorM04Dir, "m04-transaction.json"), review.m04.transactionSha256]
			] as Array<[string, string]>) if (hash(await bytes(file)) !== expected)
				fail("prior V2 running stage differs from its committed host receipt");
		}
		priorReviewed.push({ intentId: review.intentId, m07RunId: review.m07.runId });
	}
	const missionFile = await json<Awaited<ReturnType<typeof ws.readRun>>>(
		path.join(ws.runDir("MISSION", request.intentId), "run.json"));
	const mission = missionFile.value;
	const contractFile = path.join(root, "evidence", "original-objective.json");
	if (mission.runId !== request.intentId || mission.stage !== "MISSION" ||
		!mission.inputs.some(item => item.path === contractFile) ||
		mission.status === "completed") fail("mission intent is not the interrupted run");
	if (legacy && (old.codeRevision !== "local-harness-v1" ||
		!Array.isArray(mission.sessions) || mission.sessions.some(row =>
			row.role !== "research" || !row.label?.startsWith("local-original-objective-"))))
		fail("legacy source loader or default serial MISSION launcher is not verified");
	// The old checkpoint names the MISSION run, not the M07 run. Require that it
	// was the only unclosed dispatcher of this contract, then census all goal IDs.
	const unclosedMissionRuns: string[] = [];
	for (const runId of await ws.listRuns("MISSION")) {
		const run = await ws.readRun("MISSION", runId);
		if (run.inputs.some(item => item.path === contractFile) && run.status !== "completed" &&
			!status.checkpointReceipts.some(row => row.interruptedReview?.intentId === runId ||
				row.legacyInterruptedReview?.intentId === runId ||
				row.evaluatorRecoveryReview?.intentId === runId ||
				row.coldMigrationReview?.intentId === runId ||
				row.failedM04Review?.intentId === runId))
			unclosedMissionRuns.push(runId);
	}
	if (JSON.stringify(unclosedMissionRuns) !== JSON.stringify([request.intentId]))
		fail("MISSION run does not uniquely own the interrupted dispatch");
	if (legacy) for (const runId of await ws.listRuns("M07")) {
		if (runId !== request.m07RunId && (await ws.readRun("M07", runId)).status === "running")
			fail("another M07 execution may be concurrent with the legacy dispatcher");
	}
	const candidates: string[] = [];
	for (const runId of await ws.listRuns("M07")) {
		const goal = (await json<CurrentGoal>(path.join(ws.runDir("M07", runId), "goal.json"))).value;
		if (goal.problemRelation === `${LOCAL_M07_MISSION_BINDING_PREFIX}${request.missionId}\n${progress.contract.goal}` &&
			!progress.boundedRuns.some(row => row.runId === runId)) candidates.push(runId);
	}
	if (JSON.stringify(candidates) !== JSON.stringify([request.m07RunId]))
		fail("interrupted dispatch does not map uniquely to one unrepresented M07 run");
	const m07Dir = ws.runDir("M07", request.m07RunId);
	let linked: Awaited<ReturnType<typeof readLocalDispatchLineage>> | undefined;
	if (legacy) {
		for (const file of [missionLineageFile(root, request.intentId),
			goalLineageFile(m07Dir), missionLineageCommitFile(root, request.intentId)]) {
			try { await lstat(file); fail("legacy review cannot backfill or bypass an existing dispatch edge"); }
			catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
		}
	} else {
		try { linked = await readLocalDispatchLineage({ missionRoot: root, m07Dir,
			intentId: request.intentId }); }
		catch { return fail("no committed bidirectional MISSION-to-M07 dispatch edge exists"); }
		const lineage = linked.lineage;
		if (lineage.missionId !== request.missionId || lineage.m07RunId !== request.m07RunId ||
			lineage.taskId !== request.taskId || lineage.oldAttempt.attemptId !== old.attemptId ||
			JSON.stringify(lineage.oldAttempt) !== JSON.stringify(old) ||
			lineage.intentCheckpoint.sequence !== checkpoint.sequence ||
			lineage.intentCheckpoint.sha256 !== checkpoint.sha256 ||
			JSON.stringify(lineage.m07Owner) !== JSON.stringify(old.process) ||
			!progress.assessment?.nextTask ||
			lineage.assessorTaskSha256 !== assessorTaskHash(progress.assessment.nextTask))
			fail("dispatch edge does not bind the exact old attempt and frozen assessor task");
	}
	const goalFile = await json<CurrentGoal>(path.join(m07Dir, "goal.json"));
	const goal = goalFile.value;
	const task = goal.tasks?.find(row => row.taskId === request.taskId);
	const operation = goal.executionState?.operations?.find(row => row.id === request.operationId);
	const selected = goal.checkpoints?.find(row => row.id === request.checkpointId);
	if (!task || !operation || !selected) throw new Error("local mission reconciliation refused: M07 terminal task, operation, or checkpoint is missing");
	if (!goal.executionState || goal.tasks.length !== 1 || goal.tasks[0] !== task ||
		goal.executionState.operations.length !== 1 || goal.executionState.operations[0] !== operation ||
		goal.checkpoints?.length !== 1 || !task || task.status !== "rejected" ||
		operation.taskId !== task.taskId || operation.status !== "response-received" ||
		selected.feedbackStatus !== "complete" ||
		selected.rootDir !== path.join(m07Dir, "checkpoints", request.checkpointId) ||
		selected.manifestPath !== path.join(selected.rootDir, "manifest.json") ||
		selected.feedbackPath !== path.join(selected.rootDir, "m04-feedback.md") ||
		selected.goalSnapshotPath !== path.join(selected.rootDir, "goal.json"))
		fail("M07 task, effect, or complete checkpoint is not terminal and unique");
	if (!goal.executionState || !progress.assessment?.nextTask)
		throw new Error("local mission reconciliation refused: execution owner or assessor task is missing");
	const addressed = progress.contract.obligations.filter(item =>
		progress.assessment!.nextTask!.addresses.includes(item.id)).map(item => item.description);
	if (legacy && (task.mode !== "execute" || addressed.length !== progress.assessment.nextTask.addresses.length ||
		JSON.stringify(goal.constraints) !== JSON.stringify(progress.contract.obligations.map(item => item.description)) ||
		JSON.stringify(goal.successCriteria) !== JSON.stringify(addressed) ||
		JSON.stringify(task.checks) !== JSON.stringify(addressed) ||
		goal.plan !== progress.assessment.nextTask.objective))
		fail("legacy goal, task mode, or frozen success criteria differ from the serial adapter input");
	if (goal.goal !== progress.assessment.nextTask.objective ||
		!task.objective.startsWith(progress.assessment.nextTask.objective) ||
		!Array.isArray(task.inputs) || !Array.isArray(task.checks) ||
		(!legacy && (linked!.lineage.m07TaskInputsSha256 !== localLineageHash(JSON.stringify(task.inputs)) ||
			linked!.lineage.m07TaskChecksSha256 !== localLineageHash(JSON.stringify(task.checks)))) ||
		goal.executionState.attempts.filter(row => JSON.stringify(row.runDescriptor.process) ===
			JSON.stringify(old.process)).length !== 1)
		fail("M07 task and execution owner differ from the frozen mission assessor");
	const manifestFile = await json<{ version: number; m07RunId: string; checkpointId: string;
		selectedTaskIds: string[]; omittedTaskIds: string[] }>(selected.manifestPath);
	if (manifestFile.value.version !== 1 || manifestFile.value.m07RunId !== goal.runId ||
		manifestFile.value.checkpointId !== selected.id ||
		JSON.stringify(manifestFile.value.selectedTaskIds) !== JSON.stringify([request.taskId]) ||
		manifestFile.value.omittedTaskIds.length !== 0)
		fail("M07 manifest does not freeze exactly the rejected task");
	const snapFile = await json<CurrentGoal>(selected.goalSnapshotPath);
	const snap = snapFile.value;
	if (snap.runId !== goal.runId || snap.tasks.length !== 1 ||
		snap.tasks[0].taskId !== request.taskId || snap.tasks[0].status !== "rejected" ||
		snap.updatedAt !== selected.sourceGoalUpdatedAt) fail("M07 checkpoint snapshot differs from rejected task");
	const feedback = await bytes(selected.feedbackPath);
	const m04Dir = ws.runDir("M04", request.m04RunId);
	const m04RunFile = await json<Awaited<ReturnType<typeof ws.readRun>>>(path.join(m04Dir, "run.json"));
	const m04 = m04RunFile.value;
	const m04Source = await json<{ m07RunId: string; checkpointId: string;
		feedbackBundlePath: string; goalSnapshotPath: string; manifestPath: string }>(path.join(m04Dir, "m07-source.json"));
	const tx = await json<{ version: number; kind: string; m04RunId: string;
		state: string; attempts: unknown[]; currentProposalId?: string;
		snapshotId?: string; updatedAt?: string }>(path.join(m04Dir, "m04-transaction.json"));
	if (m04.stage !== "M04" || m04.runId !== request.m04RunId || m04.status !== "failed" ||
		!m04.inputs.some(row => row.path === selected.feedbackPath) ||
		!m04.inputs.some(row => row.path === selected.manifestPath) ||
		m04Source.value.m07RunId !== request.m07RunId ||
		m04Source.value.checkpointId !== request.checkpointId ||
		m04Source.value.feedbackBundlePath !== selected.feedbackPath ||
		m04Source.value.goalSnapshotPath !== selected.goalSnapshotPath ||
		m04Source.value.manifestPath !== selected.manifestPath ||
		tx.value.version !== 1 || tx.value.kind !== "m04-knowledge-transaction" ||
		tx.value.m04RunId !== request.m04RunId || tx.value.state !== "no-proposal" ||
		!Array.isArray(tx.value.attempts) || tx.value.attempts.length !== 0 ||
		tx.value.currentProposalId !== undefined || tx.value.snapshotId !== undefined)
		fail("M04 failure, handoff, or no-proposal transaction is not settled");
	const verifyNoKnowledgeWrite = async (): Promise<void> => {
		const transactionFile = path.join(m04Dir, "m04-transaction.json");
		if (!m04.finishedAt || !Number.isFinite(Date.parse(m04.finishedAt)) ||
			m04.outputs.filter(row => row.label === "M04 知识事务状态" &&
				row.path === transactionFile).length !== 1 ||
			m04.outputs.some(row => ["知识提案", "合入结果"].includes(row.label)) ||
			!tx.value.updatedAt || !Number.isFinite(Date.parse(tx.value.updatedAt)))
			fail("failed M04 lacks an exact terminal no-proposal transaction binding");
		for (const file of [path.join(m04Dir, "proposal.json"), path.join(m04Dir, "merge.json"),
			path.join(ws.knowledgeDir, ".merge.lock"),
			path.join(ws.knowledgeDir, ".merge.recovery.lock")]) {
			try { await lstat(file); fail("failed M04 has proposal or pending knowledge merge"); }
			catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
		}
		for (const name of await readdir(path.join(ws.knowledgeDir, "proposals"))) {
			if (!/^P\d{4,}\.json$/.test(name)) continue;
			const draft = (await json<{ stage?: string; runId?: string }>(path.join(
				ws.knowledgeDir, "proposals", name))).value;
			if (draft.stage === "M04" && draft.runId === m04.runId)
				fail("failed M04 has an unaccounted knowledge proposal");
		}
	};
	if (failedM04) await verifyNoKnowledgeWrite();
	const proof = failedM04 ? undefined : await json<ProviderProofV1>(request.providerProofFile);
	if (proof && (proof.sha256 !== (request as InterruptedLocalReviewRequestV1).providerProofSha256 || Object.keys(proof.value).sort().join("|") !==
		["version", "kind", "m04RunId", "sessionId", "error", "lastRequestNotSent",
			"earlierResponsesSettled", "accounting"].sort().join("|") ||
		proof.value.version !== 1 || proof.value.kind !== "m04-sdk-output-max-before-http-review" ||
		proof.value.m04RunId !== m04.runId ||
		!m04.sessions.some(row => row.id === proof.value.sessionId) ||
		proof.value.error !== "SDK DeepSeek request lowered or lost the resolved provider output maximum" ||
		!m04.failures.some(row => row.includes(proof.value.error)) ||
		proof.value.lastRequestNotSent !== true || proof.value.earlierResponsesSettled !== true ||
		proof.value.accounting !== "preserve-observed-usage"))
		fail("the last provider request has no bound before-HTTP proof");
	// No M04 peer may have merged or kept an unsettled transaction for this checkpoint.
	for (const runId of await ws.listRuns("M04")) {
		if (runId === m04.runId) continue;
		const run = await ws.readRun("M04", runId);
		if (run.inputs.some(row => row.path === selected.feedbackPath))
			fail("M07 feedback has another M04 knowledge transaction");
	}
	const legacyRequest = legacy ? request as LegacyInterruptedLocalReviewRequestV1 : undefined;
	if (cold) {
		const declaration = await json<{ childProcess?: { method?: string; processGroupId?: number | null } }>(
			legacyRequest!.legacyEffectReviewFile);
		if (declaration.sha256 !== legacyRequest!.legacyEffectReviewSha256 ||
			declaration.value.childProcess?.method !== "reviewed-tool-and-process-census" ||
			declaration.value.childProcess.processGroupId !== null ||
			coldObservation!.effectCensus.processGroupId !== null)
			fail("cross-host child-process settlement lacks an original-host reviewed census");
	}
	const m04Session = legacy ? m04.sessions.find(row => row.id === proof!.value.sessionId) : undefined;
	const m04Sessions = failedM04 ? m04.sessions.map(row => ({ id: row.id, file: row.file })) : [];
	if (failedM04 && (!m04Sessions.length ||
		new Set(m04Sessions.map(row => row.id)).size !== m04Sessions.length ||
		m04Sessions.some(row => !id(row.id) || !row.file || !path.isAbsolute(row.file) ||
			!row.file.startsWith(`${m04Dir}${path.sep}`))))
		fail("failed M04 session set is missing, ambiguous, or outside the historical run");
	if (legacy && (m04.sessions.length !== 1 || !m04Session?.file ||
		!path.isAbsolute(m04Session.file)))
		fail("legacy M04 response transcript is incomplete");
	const legacyEffects = legacyRequest ? await verifyLegacyEffectReview({ ws,
		file: legacyRequest.legacyEffectReviewFile,
		sha256: legacyRequest.legacyEffectReviewSha256, intentId: request.intentId, goal, task,
		m04SessionFile: m04Session!.file!, probeProcessGroup: cold ? async () => false :
			input.probeProcessGroup }) : undefined;
	const evaluatorFile = task.workDir ? path.join(task.workDir, "local-evaluator-receipt.json") : "";
	const evaluator = failedM04 ? await readLocalEvaluatorReceipt(evaluatorFile) : undefined;
	if (failedM04) {
		if (!task.workDir || !task.workDir.startsWith(`${path.join(m07Dir, "tasks", task.taskId)}${path.sep}`) ||
			!task.review || !evaluator || task.review.checks?.length !== task.checks.length ||
			task.checks.some((criterion, index) => {
				const obligation = progress.contract.obligations.find(row => row.description === criterion);
				const formal = evaluator!.receipt.checks.find(row => row.obligationId === obligation?.id);
				const shown = task.review!.checks[index];
				return !formal || !shown || shown.criterion !== criterion ||
					shown.result !== (formal.result === "unknown" ? "not_run" : formal.result);
			}))
			fail("formal evaluator receipt is absent or differs from the rejected task review");
		await verifyLocalEvaluatorReceipt(evaluator!.receipt, progress.contract, goal, task);
	}
	const effectsRequest = failedM04 ? request as FailedM04LocalReviewRequestV1 : undefined;
	const effects = effectsRequest ? await verifyFailedM04EffectReview({ ws,
		file: effectsRequest.effectReviewFile, sha256: effectsRequest.effectReviewSha256,
		missionId: request.missionId, intentId: request.intentId,
		oldCheckpointSha256: request.checkpointSha256, goal, task,
		operationId: operation.id, checkpointId: selected.id, m04RunId: m04.runId,
		m04Sessions: m04Sessions as Array<{ id: string; file: string }>,
		m04TransactionSha256: tx.sha256,
		priorReviewed,
		evaluatorReceiptSha256: evaluator!.sha256,
		verifyTrustedEffects: input.verifyTrustedEffects! }) : undefined;
	if (cold && legacyEffects?.censusSha256 !== coldObservation!.effectCensus.workspaceCensusSha256)
		fail("original-host effect census differs from the retained workspace census");
	const nextId = `A${String(Number(status.currentAttempt!.attemptId.slice(1)) + 1).padStart(3, "0")}`;
	const predicted = { version: 1 as const, missionId: request.missionId,
		attemptId: nextId, predecessorAttemptId: status.currentAttempt!.attemptId,
		codeRevision: "local-harness-v1", process: currentProcess };
	const commonReview = { version: 1 as const, missionId: request.missionId,
		intentId: request.intentId, missionRunSha256: missionFile.sha256, oldAttempt: old,
		oldCheckpoint: { sequence: checkpoint.sequence, sha256: checkpoint.sha256 },
		newAttempt: predicted,
		m07: { runId: goal.runId, taskId: task.taskId, operationId: operation.id,
			checkpointId: selected.id, goalSha256: goalFile.sha256,
			snapshotSha256: snapFile.sha256,
			manifestSha256: manifestFile.sha256, feedbackSha256: hash(feedback),
			result: "rejected-with-complete-feedback" as const, effect: "response-received" as const },
		boundary: "new-work-only-no-old-task-or-session-replay" as const };
	const oldM04Review = { runId: m04.runId, sourceSha256: m04Source.sha256,
		transactionSha256: tx.sha256, runSha256: m04RunFile.sha256,
		result: "failed-no-proposal" as const, lastRequest: "sdk-output-max-guard-before-http" as const,
		providerProofSha256: proof?.sha256 ?? "" };
	const legacyReview: LocalLegacyInterruptedReviewV1 | undefined = legacyEffects ? {
		...commonReview, m04: oldM04Review, kind: "local-legacy-interruption-host-review" as const,
		historicalExplicitDispatchBinding: false, actualArgvRecorded: false,
		association: "host-reviewed-inferred", effects: "observed-settled-within-trusted-host-scope",
		authority: "fresh-follow-up-only",
		source: { commit: LEGACY_SERIAL_COMMIT, tree: LEGACY_SERIAL_TREE,
			serialEntryAuditSha256: LEGACY_SERIAL_AUDIT_SHA256 },
		associationEvidence: { kind: "host-reviewed-serial-dispatch-inference",
			assessorTaskSha256: assessorTaskHash(progress.assessment!.nextTask!),
			m07OwnerSha256: localLineageHash(JSON.stringify(old.process)),
			taskInputsSha256: localLineageHash(JSON.stringify(task.inputs)),
			workspaceCensusSha256: legacyEffects.censusSha256,
			launcher: "single-default-cli-serial-objective-loop" },
		effectReview: legacyEffects.declaration,
		effectEvidence: { toolLogSha256: legacyEffects.toolLogSha256,
			toolReviewSha256: localLineageHash(JSON.stringify(legacyEffects.declaration)),
			m04SessionSha256: legacyEffects.m04SessionSha256,
			toolTranscriptCensusSha256: legacyEffects.toolTranscriptCensusSha256,
			pairedToolCallCount: legacyEffects.pairedToolCallCount,
			childProcessReviewSha256: legacyEffects.childReviewSha256,
			networkReviewSha256: legacyEffects.networkReviewSha256,
			toolCallCount: task.toolLog.length,
			failedToolOrdinals: legacyEffects.failedToolOrdinals,
			numericExitUnknownOrdinals: legacyEffects.numericExitUnknownOrdinals,
			trustLimit: "same-uid-reviewed-observations-no-os-noninterference-proof" as const } } : undefined;
	const review: LocalInterruptedReviewV1 | LocalLegacyInterruptedReviewV1 | LocalColdMigrationReviewV1 |
		LocalFailedM04ReviewV1 = failedM04 ? {
		...commonReview, kind: "local-failed-m04-interruption-host-review",
		lineageSha256: linked!.sha256,
		evaluatorReceiptSha256: evaluator!.sha256,
		effectReview: effects!.review, effectReviewSha256: hash(Buffer.from(JSON.stringify(effects!.review))),
		effectReviewFileSha256: effects!.sha256,
		m04: { runId: m04.runId, sourceSha256: m04Source.sha256,
			transactionSha256: tx.sha256, runSha256: m04RunFile.sha256,
			sessions: effects!.review.m04Sessions, result: "failed-no-proposal" }
	} :
		cold ? { ...legacyReview!, kind: "local-cold-migration-host-review",
			coldMigration: { observation: coldObservation!,
				observationSha256: (request as ColdMigrationLocalReviewRequestV1).observationSha256 } } :
		legacyReview ?? { ...commonReview, m04: oldM04Review, kind: "local-interrupted-dispatch-review",
			lineageSha256: linked!.sha256 };
	const next = objectiveProgress(progress.contract, {
		boundedRuns: [...progress.boundedRuns, { runId: goal.runId, outcome: "partial", acceptedTaskIds: [] }],
		selectedArtifacts: progress.selectedArtifacts, availableArtifacts: progress.availableArtifacts,
		assessment: progress.assessment, assessmentHistory: progress.assessmentHistory,
		stopReason: "objective-reassessment-pending", unresolvedOperationIds: [],
		nextTaskDispatched: true, pendingActionFacts: {} });
	const nextBytes = Buffer.from(`${JSON.stringify(next, null, 2)}\n`, "utf8");
	if (input.dryRun) return { progress: next, receipt: review };
	await input.testBeforeCommit?.();
	await LocalMissionHost.commitReviewedSuccessor({ root, missionId: request.missionId,
		bytes: nextBytes, review, currentIdentity: input.currentIdentity,
		probePrior: input.probePrior, testCrashAt: input.testCrashAt,
		verifyColdMigrationOrigin: cold ? input.verifyTrustedObservation : undefined,
		verifyEvidence: async () => {
			if (cold) await input.verifyTrustedObservation!(coldObservation!);
			else {
				const again = await (input.probePrior ?? probeProcessIdentity)(old.process);
				if (again.status !== "dead" || again.identityMatch)
					fail("old process liveness changed before checkpoint commit");
			}
			if ((review.kind === "local-interrupted-dispatch-review" ||
				review.kind === "local-failed-m04-interruption-host-review") &&
				(await readLocalDispatchLineage({ missionRoot: root, m07Dir,
					intentId: request.intentId })).sha256 !== review.lineageSha256)
				fail("dispatch lineage changed before checkpoint commit");
			if (failedM04) {
				await verifyNoKnowledgeWrite();
				const checked = await readLocalEvaluatorReceipt(evaluatorFile);
				if (checked.sha256 !== evaluator!.sha256)
					fail("formal evaluator receipt changed before checkpoint commit");
				await verifyLocalEvaluatorReceipt(checked.receipt, progress.contract, goal, task);
				const repeated = await verifyFailedM04EffectReview({ ws,
					file: effectsRequest!.effectReviewFile, sha256: effectsRequest!.effectReviewSha256,
					missionId: request.missionId, intentId: request.intentId,
					oldCheckpointSha256: request.checkpointSha256, goal, task,
					operationId: operation.id, checkpointId: selected.id, m04RunId: m04.runId,
					m04Sessions: m04Sessions as Array<{ id: string; file: string }>,
					m04TransactionSha256: tx.sha256,
					priorReviewed,
					evaluatorReceiptSha256: checked.sha256,
					verifyTrustedEffects: input.verifyTrustedEffects! });
				if (repeated.sha256 !== effects!.sha256)
					fail("failed M04 effect review changed before checkpoint commit");
			}
			if (review.kind === "local-legacy-interruption-host-review" ||
				review.kind === "local-cold-migration-host-review") {
				for (const file of [missionLineageFile(root, request.intentId),
					goalLineageFile(m07Dir), missionLineageCommitFile(root, request.intentId)]) {
					try { await lstat(file); fail("legacy dispatch edge appeared before checkpoint commit"); }
					catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
				}
				const checked = await verifyLegacyEffectReview({ ws,
					file: legacyRequest!.legacyEffectReviewFile,
					sha256: legacyRequest!.legacyEffectReviewSha256,
					intentId: request.intentId, goal, task,
					m04SessionFile: m04Session!.file!, probeProcessGroup: cold ? async () => false :
						input.probeProcessGroup });
				if (checked.censusSha256 !== review.associationEvidence.workspaceCensusSha256 ||
					checked.toolLogSha256 !== review.effectEvidence.toolLogSha256)
					fail("legacy effect or workspace census changed before checkpoint commit");
			}
			const pinned: Array<[string, string]> = [
				[path.join(ws.runDir("MISSION", request.intentId), "run.json"), review.missionRunSha256],
				[path.join(m07Dir, "goal.json"), review.m07.goalSha256],
				[selected.goalSnapshotPath, review.m07.snapshotSha256],
				[selected.manifestPath, review.m07.manifestSha256],
				[selected.feedbackPath, review.m07.feedbackSha256],
				[path.join(m04Dir, "m07-source.json"), review.m04.sourceSha256],
				[path.join(m04Dir, "m04-transaction.json"), review.m04.transactionSha256],
				[path.join(m04Dir, "run.json"), review.m04.runSha256],
				...(failedM04 ? [
					[evaluatorFile, evaluator!.sha256],
					...m04Sessions.map((row, index) => [row.file!,
						effects!.review.m04Sessions[index]!.fileSha256] as [string, string]),
					[effectsRequest!.effectReviewFile, effects!.sha256]
				] as Array<[string, string]> : [
					[(request as InterruptedLocalReviewRequestV1).providerProofFile,
						(request as InterruptedLocalReviewRequestV1).providerProofSha256]
				] as Array<[string, string]>),
				...(cold ? [
					[(request as ColdMigrationLocalReviewRequestV1).observationFile,
						(request as ColdMigrationLocalReviewRequestV1).observationSha256],
					[(request as ColdMigrationLocalReviewRequestV1).archiveFile,
						(request as ColdMigrationLocalReviewRequestV1).archiveSha256]
				] as Array<[string, string]> : []),
				...(review.kind === "local-interrupted-dispatch-review" ||
					review.kind === "local-failed-m04-interruption-host-review" ? [
					[missionLineageFile(root, request.intentId), review.lineageSha256],
					[goalLineageFile(m07Dir), review.lineageSha256],
				] as Array<[string, string]> : []),
			];
			for (const [file, expected] of pinned) if (
				failedM04 && m04Sessions.some(row => row.file === file) ?
					await hashStableHistoricalFile(file) !== expected :
				cold && file === (request as ColdMigrationLocalReviewRequestV1).archiveFile ?
					await hashStableArchive(file) !== expected : hash(await bytes(file)) !== expected)
				fail("review evidence changed before checkpoint commit");
		} });
	return { progress: next, receipt: review };
}
export async function reconcileInterruptedLocalMission(input: {
	workspaceRoot: string; request: InterruptedLocalReviewRequestV1;
	currentIdentity?: () => Promise<ProcessIdentityV1>;
	probePrior?: (identity: ProcessIdentityV1) => Promise<ProcessProbe>;
	dryRun?: boolean;
	testCrashAt?: "after-prepare" | "after-rename";
	testBeforeCommit?: () => Promise<void>;
}): Promise<{ progress: ObjectiveProgressV1; receipt: LocalInterruptedReviewV1 }> {
	return await reconcileCore(input) as { progress: ObjectiveProgressV1; receipt: LocalInterruptedReviewV1 };
}
/** The trusted host supplies independent observations for this exact scope.
 * A caller-controlled JSON declaration alone cannot authorize recovery. */
export async function reconcileFailedM04LocalMission(input: {
	workspaceRoot: string; request: FailedM04LocalReviewRequestV1;
	verifyTrustedEffects: (review: FailedM04EffectReviewV1) => Promise<void>;
	currentIdentity?: () => Promise<ProcessIdentityV1>;
	probePrior?: (identity: ProcessIdentityV1) => Promise<ProcessProbe>;
	dryRun?: boolean;
	testCrashAt?: "after-prepare" | "after-rename";
	testBeforeCommit?: () => Promise<void>;
}): Promise<{ progress: ObjectiveProgressV1; receipt: LocalFailedM04ReviewV1 }> {
	return await reconcileCore(input) as { progress: ObjectiveProgressV1;
		receipt: LocalFailedM04ReviewV1 };
}
export async function reconcileLegacyInterruptedLocalMission(input: {
	workspaceRoot: string; request: LegacyInterruptedLocalReviewRequestV1;
	currentIdentity?: () => Promise<ProcessIdentityV1>;
	probePrior?: (identity: ProcessIdentityV1) => Promise<ProcessProbe>;
	probeProcessGroup?: (groupId: number) => Promise<boolean>;
	dryRun?: boolean;
	testCrashAt?: "after-prepare" | "after-rename";
	testBeforeCommit?: () => Promise<void>;
}): Promise<{ progress: ObjectiveProgressV1; receipt: LocalLegacyInterruptedReviewV1 }> {
	return await reconcileCore(input) as { progress: ObjectiveProgressV1; receipt: LocalLegacyInterruptedReviewV1 };
}
/** Host-only cold handoff. The callback must authenticate the retained platform
 * observations and finite one-shot ownership from a trusted source, not request text. */
export async function reconcileColdMigratedLocalMission(input: {
	workspaceRoot: string; request: ColdMigrationLocalReviewRequestV1;
	currentIdentity?: () => Promise<ProcessIdentityV1>;
	probePrior?: (identity: ProcessIdentityV1) => Promise<ProcessProbe>;
	verifyTrustedObservation: (observation: ColdMigrationObservationV1) => Promise<void>;
	dryRun?: boolean;
	testCrashAt?: "after-prepare" | "after-rename";
	testBeforeCommit?: () => Promise<void>;
}): Promise<{ progress: ObjectiveProgressV1; receipt: LocalColdMigrationReviewV1 }> {
	return await reconcileCore(input) as { progress: ObjectiveProgressV1; receipt: LocalColdMigrationReviewV1 };
}
