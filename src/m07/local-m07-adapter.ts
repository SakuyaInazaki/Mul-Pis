import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, open, readFile, readdir, realpath, unlink } from "node:fs/promises";
import path from "node:path";
import { latestFormalBaseline, recoverM07DispatchLock } from "./controller.ts";
import { captureM04BaselineIdentity } from "./formal-baseline.ts";
import { resolveExpectedOutputFiles } from "./expected-output.ts";
import type { LocalObjectiveAdapter, LocalObjectiveAdvanceResult } from "./local-original-objective.ts";
import type { ObjectiveNextTaskV1, OriginalObjectiveContractV1 } from "./objective-progress.ts";
import type { CurrentGoal, M07CheckpointRecord, M07Controller, M07TaskRecord, TaskReviewInput } from "./types.ts";
import type { StageContext } from "../stages/context.ts";
import { runM04 } from "../stages/m04.ts";
import type { ProcessIdentityV1 } from "../runtime/process-identity.ts";
import { HarnessError } from "../types.ts";
import { evaluateLocalM07Task, readLocalEvaluatorAttempt,
	readPreparedLocalEvaluatorInput,
	reconcileEnteredLocalEvaluatorAttempt, recoverReturnedLocalM07Task,
	verifyLocalEvaluatorReceipt } from "./local-evaluator-run.ts";
import { computeMissingSelectionProof, missingCandidateSelectionProof,
	verifyDefaultM04Evidence } from "./local-selection-review.ts";
import { trustedLocalMissionEvaluator, validatedTaskInputContract } from "./local-mission-evaluator.ts";
import type { LocalObjectiveFrozenEvidence } from "./local-original-objective.ts";

export const LOCAL_M07_REASON_SCOPE = "local-m07-reason";
export const LOCAL_M07_EXECUTE_SCOPE = "local-m07-execute";
/** Strict persisted marker for post-crash mission-to-M07 run census. */
export const LOCAL_M07_MISSION_BINDING_PREFIX = "Local original objective mission: ";

function fail(reason: string): never {
	throw new HarnessError("m07.local-adapter", reason);
}
function unresolvedRefs(goal: CurrentGoal, taskId: string): string[] {
	const operations = goal.executionState?.operations.filter(item =>
		["prepared", "issued", "unknown"].includes(item.status))
		.map(item => `${goal.runId}/${item.id}`) ?? [];
	return [...new Set([`${goal.runId}/${taskId}`, ...operations])];
}

/** A trusted evaluator that never entered may report a capability failure.
 * The returned builder task is retained and receives negative host feedback;
 * it is never treated as a measured candidate. */
async function preenterFeedback(report: M07TaskRecord, missionId: string,
	runId: string, evaluatorId: string | undefined): Promise<TaskReviewInput> {
	const file = path.join(report.workDir, "local-evaluator-preenter-feedback.json");
	const bytes = Buffer.from(`${JSON.stringify({ version: 1,
		kind: "local-evaluator-preenter-feedback", missionId, runId,
		taskId: report.taskId, evaluatorId: evaluatorId ?? null,
		state: "not-entered", checkState: "not_run" }, null, 2)}\n`, "utf8");
	const temporary = path.join(report.workDir, `.local-evaluator-preenter-${randomUUID()}.tmp`);
	try {
		const handle = await open(temporary,
			constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
		try { await handle.writeFile(bytes); await handle.sync(); }
		finally { await handle.close(); }
		await link(temporary, file);
		const dir = await open(report.workDir,
			constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
		try { await dir.sync(); } finally { await dir.close(); }
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
		try {
			const info = await handle.stat();
			if (!info.isFile() || (info.mode & 0o777) !== 0o600 || info.nlink !== 1 ||
				!(await handle.readFile()).equals(bytes)) throw error;
		} finally { await handle.close(); }
	} finally { await unlink(temporary).catch(() => undefined); }
	return { taskId: report.taskId, artifacts: [report.reportPath!, file],
		checks: report.checks.map(criterion => ({ criterion, result: "not_run", evidence: [file] })),
		failures: ["Trusted evaluator became unavailable before its host evaluation began."],
		limitations: ["The returned builder task has no admitted evaluator result or selected authority."] };
}

/** Persist a negative bounded result after host-owned effect settlement. */
async function settleNegativeEvaluation(controller: M07Controller, runId: string,
	report: M07TaskRecord, review: TaskReviewInput): Promise<LocalObjectiveAdvanceResult> {
	const reviewed = await controller.review(runId, review);
	if (reviewed.status !== "rejected" || !reviewed.review)
		fail("negative evaluator feedback cannot accept a candidate");
	const checkpoint = await controller.checkpoint(runId, { taskIds: [report.taskId] });
	await controller.finish(runId, { outcome: "partial", returnPath: "continue",
		summary: "The bounded candidate was retained with negative host evaluator feedback; no original objective check passed.",
		goalChecks: reviewed.review.checks.map(check => ({ ...check })) });
	return { runId, outcome: "partial", acceptedTaskIds: [], checkpointId: checkpoint.id,
		unresolvedOperationRefs: [] };
}

export interface BoundLocalM07RecoveryInput {
	ctx: StageContext; controller: M07Controller; contract: OriginalObjectiveContractV1;
	assessorTask: ObjectiveNextTaskV1; runId: string; taskId: string;
	expectedOwner: ProcessIdentityV1;
	/** Owners of prior host recovery claims, verified by the mission host. */
	verifiedRecoveryOwners?: readonly ProcessIdentityV1[];
	/** Reauthenticated original assessor boundary; never inferred from a new prompt. */
	recoveryEvidence: readonly { name: string; file: string }[];
	frozenOriginalInputs: readonly import("./local-mission-evaluator.ts").LocalFrozenOriginalIdentity[];
	capabilities: readonly import("./objective-progress.ts").ObjectiveCapabilityV1[];
	runM04?: typeof runM04;
}
export type BoundLocalM07Recovery =
	| { state: "pending"; reason: "evaluator-effects-unknown" | "host-capability-unavailable" }
	| { state: "settled"; result: LocalObjectiveAdvanceResult;
		evaluation: { id: string; version: string; terminal: "pre-entry-unlocated";
			orphanMembers: Array<{ name: "prepared.json.pending" | "prepared.json" |
				"prepared.sha256.pending"; sha256: string }> } |
		{ id: string; version: string; attemptId: string;
			owner: ProcessIdentityV1; terminal: "returned" | "settled-failure";
			preparedSha256: string; enteredSha256: string;
			terminalSha256: string; receiptSha256?: string } };

const shaFile = async (file: string): Promise<string> =>
	createHash("sha256").update(await readFile(file)).digest("hex");

/** Continue only the trusted host side of one already returned, linked M07
 * task. The evaluator may enter once only when its prior journal is absent
 * or proves a pre-entry crash. This entry never invokes controller.delegate. */
export async function recoverBoundLocalM07Task(input: BoundLocalM07RecoveryInput):
	Promise<BoundLocalM07Recovery> {
	const { ctx, controller, contract, assessorTask, runId, taskId, expectedOwner } = input;
	const goal = await controller.status(runId);
	const report = goal.tasks.find(item => item.taskId === taskId);
	const addressed = contract.obligations.filter(item => assessorTask.addresses.includes(item.id))
		.map(item => item.description);
	if (goal.runId !== runId || goal.problemRelation !==
		`${LOCAL_M07_MISSION_BINDING_PREFIX}${contract.id}\n${contract.goal}` ||
		goal.goal !== assessorTask.objective || goal.tasks.length !== 1 || !report ||
		!report.objective.startsWith(assessorTask.objective) ||
		!(["returned", "accepted", "rejected"] as string[]).includes(report.status) ||
		JSON.stringify(report.checks) !== JSON.stringify(addressed) ||
		goal.executionState?.operations.length !== 1 ||
		Boolean(report.executionLoop) || Boolean(report.lessonDeltaOutput) ||
		goal.executionState.operations[0]?.taskId !== taskId ||
		goal.executionState.operations[0]?.status !== "response-received" ||
		!goal.executionState.attempts.some(row =>
			JSON.stringify(row.runDescriptor.process) === JSON.stringify(expectedOwner)))
		fail("recovered M07 task, response or owner differs from committed dispatch");
	const goalRoot = ctx.ws.runDir("M07", runId);
	const lockFile = path.join(goalRoot, ".delegate-lock");
	const claimsRoot = path.join(goalRoot, ".delegate-recovery-claims");
	let hasLock = false;
	try { await lstat(lockFile); hasLock = true; }
	catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
	let hasClaim = false;
	try { hasClaim = (await readdir(claimsRoot)).length > 0; }
	catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
	if (hasLock || hasClaim) await recoverM07DispatchLock({ ws: ctx.ws, runId,
		expectedOwner, verifiedRecoveryOwners: input.verifiedRecoveryOwners });
	const journalRoot = path.join(path.dirname(report.workDir), "host-evaluator-attempt");
	const evaluatorId = ctx.config.localMission?.evaluatorId;
	const prepared = await readPreparedLocalEvaluatorInput({ contract, goal, task: report,
		evaluatorId });
	const evidence = prepared?.frozenEvidence.map(({ name, file }) => ({ name, file })) ??
		input.recoveryEvidence;
	if (JSON.stringify(evidence) !== JSON.stringify(input.recoveryEvidence))
		fail("prepared evaluator evidence differs from original assessor boundary");
	const evaluation = { contract, goal, task: report, evidence, evaluatorId,
		frozenOriginalInputs: input.frozenOriginalInputs, capabilities: input.capabilities };
	let phase = await readLocalEvaluatorAttempt(evaluation);
	if (phase.state === "absent" && report.status !== "returned")
		fail("journal-absent evaluator recovery requires an unreviewed returned task");
	let review: TaskReviewInput;
	let receiptFile: string | undefined;
	let terminal: "returned" | "settled-failure" | "pre-entry-unlocated";
	if (phase.state === "pre-entry-unlocated") {
		review = await preenterFeedback(report, contract.id, runId, evaluatorId);
		terminal = "pre-entry-unlocated";
	} else if (phase.state === "pre-entry" || phase.state === "absent") {
		// The evaluator never entered: an absent or incomplete entered seal is
		// a host preparation crash, so retry only this host stage.
		try {
			const completed = await evaluateLocalM07Task({ ...evaluation, recoveryPreEntry: true });
			review = completed.review;
			receiptFile = completed.receiptFile;
			terminal = "returned";
		} catch (error) {
			const retryState = await readLocalEvaluatorAttempt(evaluation);
			if (retryState.state === "absent" && error instanceof HarnessError &&
				error.code === "local.evaluator.capability")
				return { state: "pending", reason: "host-capability-unavailable" };
			return { state: "pending", reason: "evaluator-effects-unknown" };
		}
	} else if (phase.state === "returned") {
		const completed = await recoverReturnedLocalM07Task(evaluation);
		review = completed.review;
		receiptFile = completed.receiptFile;
		terminal = "returned";
	} else if (phase.state === "settled-failure") {
		const completed = await reconcileEnteredLocalEvaluatorAttempt(evaluation);
		if (completed.state !== "settled-failure")
			return { state: "pending", reason: "evaluator-effects-unknown" };
		review = completed.review;
		terminal = "settled-failure";
	} else {
		const reconciled = await reconcileEnteredLocalEvaluatorAttempt(evaluation);
		if (reconciled.state !== "settled-failure")
			return { state: "pending", reason: "evaluator-effects-unknown" };
		phase = await readLocalEvaluatorAttempt(evaluation);
		review = reconciled.review;
		terminal = "settled-failure";
	}
	const current = (await controller.status(runId)).tasks.find(item => item.taskId === taskId)!;
	let reviewed: M07TaskRecord;
	if (current.status === "returned") reviewed = await controller.review(runId, review);
	else {
		// Ordinary review also freezes declared output files and records missing
		// output errors. Reconstruct that deterministic addition before comparing
		// a review saved just before the previous host process crashed.
		const outputs = await resolveExpectedOutputFiles(current.workDir,
			current.expectedOutputPaths);
		const expectedFailures = [...(review.failures ?? []),
			...outputs.flatMap(item => item.error ? [item.error] : [])];
		const expectedSources = await Promise.all(review.artifacts.map(file => realpath(file)));
		for (const source of outputs.flatMap(item => item.files))
			if (!expectedSources.includes(source)) expectedSources.push(source);
		const expectedStatus = review.checks.every(check => check.result === "passed") &&
			!expectedFailures.length && !(review.unexecuted ?? []).length ? "accepted" : "rejected";
		if (!["accepted", "rejected"].includes(current.status) || !current.review ||
			current.review.checks.length !== review.checks.length ||
			current.review.artifacts.length !== expectedSources.length ||
			current.status !== expectedStatus ||
			JSON.stringify(current.review.failures) !== JSON.stringify(expectedFailures) ||
			JSON.stringify(current.review.unexecuted) !== JSON.stringify(review.unexecuted ?? []) ||
			JSON.stringify(current.review.limitations) !== JSON.stringify(review.limitations ?? []) ||
			current.review.checks.some((item, index) => item.criterion !== review.checks[index]?.criterion ||
				item.result !== review.checks[index]?.result ||
				item.evidence.length !== review.checks[index]?.evidence.length) ||
			terminal === "settled-failure" && current.status !== "rejected")
			fail("prior M07 review differs from recovered evaluator result");
		if (!(await readFile(current.review.frozenReportPath)).equals(await readFile(report.reportPath!)))
			fail("prior M07 review report differs from recovered builder bytes");
		for (const [index, source] of expectedSources.entries()) {
			const saved = current.review.artifacts[index]!;
			if (saved.sourcePath !== source ||
				!(await readFile(saved.path)).equals(await readFile(source)))
				fail("prior M07 review artifact differs from recovered evaluator bytes");
		}
		for (const [index, check] of review.checks.entries())
			for (const [itemIndex, source] of check.evidence.entries())
				if (!(await readFile(current.review.checks[index]!.evidence[itemIndex]!))
					.equals(await readFile(source)))
					fail("prior M07 review check differs from recovered evaluator bytes");
		reviewed = current;
	}
	let checkpoint: M07CheckpointRecord;
	const afterReview = await controller.status(runId);
	if (afterReview.checkpoints?.length) {
		if (afterReview.checkpoints.length !== 1 ||
			!(["complete", "indexed"] as string[]).includes(afterReview.checkpoints[0]!.feedbackStatus))
			fail("recovered M07 checkpoint has ambiguous or incomplete feedback");
		checkpoint = afterReview.checkpoints[0]!;
		const manifest = JSON.parse(await readFile(checkpoint.manifestPath, "utf8")) as
			{ selectedTaskIds?: string[]; m07RunId?: string; checkpointId?: string };
		if (manifest.m07RunId !== runId || manifest.checkpointId !== checkpoint.id ||
			JSON.stringify(manifest.selectedTaskIds) !== JSON.stringify([taskId]))
			fail("recovered M07 checkpoint does not freeze the exact returned task");
	} else checkpoint = await controller.checkpoint(runId, { taskIds: [taskId] });
	const checkpointGoal = JSON.parse(await readFile(checkpoint.goalSnapshotPath, "utf8")) as CurrentGoal;
	const snapshotTask = checkpointGoal.tasks.find(item => item.taskId === taskId);
	if (checkpointGoal.runId !== runId || !snapshotTask?.review ||
		snapshotTask.status !== reviewed.status)
		fail("recovered M07 checkpoint differs from the reviewed task");
	const requiredM07ReadPaths = terminal === "returned" ? [...new Set([
		"goal.json", "manifest.json", "m04-feedback.md",
		...snapshotTask.review.artifacts.filter(item => item.mediaType === "text")
			.map(item => path.relative(checkpoint.rootDir, item.path).replaceAll("\\", "/"))])] : undefined;
	let m04RunId: string | undefined;
	const m04Matches: string[] = [];
	for (const id of await ctx.ws.listRuns("M04")) {
		const run = await ctx.ws.readRun("M04", id);
		if (run.inputs.some(row => row.path === checkpoint.feedbackPath ||
			row.path === checkpoint.manifestPath)) m04Matches.push(id);
	}
	if (m04Matches.length > 1) fail("multiple M04 runs claim the recovered M07 checkpoint");
	if (m04Matches.length === 1) {
		const id = m04Matches[0]!;
		const run = await ctx.ws.readRun("M04", id);
		const source = JSON.parse(await readFile(path.join(ctx.ws.runDir("M04", id),
			"m07-source.json"), "utf8")) as { m07RunId?: string; checkpointId?: string };
		const tx = JSON.parse(await readFile(path.join(ctx.ws.runDir("M04", id),
			"m04-transaction.json"), "utf8")) as { m04RunId?: string; state?: string };
		if (run.status !== "completed" || source.m07RunId !== runId ||
			source.checkpointId !== checkpoint.id || tx.m04RunId !== id ||
			!(["no-proposal", "merged"] as string[]).includes(tx.state ?? ""))
			return { state: "pending", reason: "evaluator-effects-unknown" };
		m04RunId = id;
	} else if (terminal === "returned") {
		const completed = await (input.runM04 ?? runM04)(ctx, { feedback: { kind: "M07Checkpoint",
			runId, checkpointId: checkpoint.id }, freshSession: true,
			...(requiredM07ReadPaths ? { requiredM07ReadPaths } : {}) });
		m04RunId = completed.record.runId;
	}
	if (m04RunId && requiredM07ReadPaths)
		await verifyDefaultM04Evidence(ctx, { runId, outcome: "partial",
			acceptedTaskIds: reviewed.status === "accepted" ? [taskId] : [],
			selectedTaskId: taskId, m04RunId, checkpointId: checkpoint.id,
			requiredM07ReadPaths }, checkpoint.rootDir);
	const afterM04 = await controller.status(runId);
	if (afterM04.lifecycle === "active")
		await controller.finish(runId, { outcome: "partial", returnPath: m04RunId ? "M04" : "continue",
			summary: "Recovered host evaluation was retained for new original-objective assessment; mission selection remains separate.",
			goalChecks: reviewed.review!.checks.map(check => ({ ...check })) });
	else if (afterM04.outcome !== "partial")
		fail("recovered M07 goal has an unexpected terminal outcome");
	phase = await readLocalEvaluatorAttempt(evaluation);
	if (phase.state !== terminal)
		fail("evaluator journal changed while finishing recovered M07 feedback");
	if (phase.state === "pre-entry-unlocated") {
		const evaluator = trustedLocalMissionEvaluator(evaluatorId);
		if (!evaluator || reviewed.status !== "rejected" || m04RunId || receiptFile)
			fail("pre-entry recovery gained unsupported evaluation or selection authority");
		const orphanMembers = phase.orphanMembers.map(item => {
			if (!["prepared.json.pending", "prepared.json", "prepared.sha256.pending"].includes(item.name))
				fail("pre-entry orphan member is outside the fixed journal namespace");
			return { name: item.name as "prepared.json.pending" | "prepared.json" |
				"prepared.sha256.pending", sha256: item.sha256 };
		});
		return { state: "settled", result: { runId, outcome: "partial",
			acceptedTaskIds: [], checkpointId: checkpoint.id,
			unresolvedOperationRefs: [] }, evaluation: {
			id: evaluator.id, version: evaluator.version,
			terminal: "pre-entry-unlocated", orphanMembers } };
	}
	if (terminal === "pre-entry-unlocated")
		fail("pre-entry terminal changed before recovery publication");
	const evaluator = phase.attempt.evaluator;
	const preparedSha256 = await shaFile(path.join(journalRoot, "prepared.json"));
	const enteredSha256 = await shaFile(path.join(journalRoot, "entered.json"));
	const terminalSha256 = await shaFile(path.join(journalRoot, `${terminal}.json`));
	const receiptSha256 = receiptFile ? await shaFile(receiptFile) : undefined;
	return { state: "settled", result: { runId, outcome: "partial",
		acceptedTaskIds: reviewed.status === "accepted" ? [taskId] : [],
		checkpointId: checkpoint.id, ...(m04RunId ? { m04RunId } : {}),
		...(receiptFile ? { evaluatorReceiptPath: receiptFile } : {}),
		...(requiredM07ReadPaths ? { requiredM07ReadPaths } : {}),
		unresolvedOperationRefs: [] }, evaluation: { id: evaluator.id,
		version: evaluator.version, attemptId: phase.attempt.attemptId,
		owner: phase.attempt.process, terminal,
		preparedSha256, enteredSha256, terminalSha256,
		...(receiptSha256 ? { receiptSha256 } : {}) } };
}

async function verifyTaskInputContract(frozen: LocalObjectiveFrozenEvidence, missionId: string,
	evaluatorId?: string): Promise<string | undefined> {
	const evaluator = trustedLocalMissionEvaluator(evaluatorId);
	const declared = validatedTaskInputContract(evaluator?.taskInputContract);
	const binding = frozen.evaluatorTaskInputContract;
	if (!declared && !binding) return undefined;
	if (!declared || !binding || !evaluator || evaluator.id !== binding.evaluatorId ||
		evaluator.version !== binding.evaluatorVersion ||
		createHash("sha256").update(JSON.stringify(declared)).digest("hex") !== binding.contractSha256 ||
		createHash("sha256").update(JSON.stringify(frozen.frozenOriginalInputs ?? [])).digest("hex") !==
			binding.sourceIdentitySha256)
		fail("trusted evaluator task input contract or source identity changed");
	const evidence = frozen.evidence.find(item => item.name === binding.name);
	if (!evidence) fail("frozen evaluator task input contract is missing");
	const bytes = await readFile(evidence.file);
	if (createHash("sha256").update(bytes).digest("hex") !== binding.sha256)
		fail("frozen evaluator task input contract bytes changed");
	let value: unknown;
	try { value = JSON.parse(bytes.toString("utf8")); }
	catch { fail("frozen evaluator task input contract is invalid JSON"); }
	const wrapper = value as { binding?: Record<string, unknown>; contract?: unknown };
	if (!wrapper || JSON.stringify(wrapper.contract) !== JSON.stringify(declared) ||
		wrapper.binding?.missionId !== missionId ||
		wrapper.binding.evaluatorId !== binding.evaluatorId ||
		wrapper.binding.evaluatorVersion !== binding.evaluatorVersion ||
		wrapper.binding.sourceIdentitySha256 !== binding.sourceIdentitySha256 ||
		wrapper.binding.contractSha256 !== binding.contractSha256)
		fail("frozen evaluator task input contract binding is invalid");
	return binding.name;
}

/** One stateless, built-in local step. Model reports become frozen evidence;
 * only the ordinary M07/M04 review paths can give them scientific authority. */
export function createLocalM07Adapter(mode: "reason" | "execute" = "reason"): LocalObjectiveAdapter {
	const scope = mode === "execute" ? LOCAL_M07_EXECUTE_SCOPE : LOCAL_M07_REASON_SCOPE;
	return { scope, async advance(input) {
		const { ctx, controller, contract, frozen, task } = input;
		// A capability snapshot alone cannot opt the current workspace into native
		// task-root read/write/edit/bash tools. Bash is not an OS sandbox.
		if (mode === "execute" && ctx.config.localMission?.execution !== "task-root-bash")
			fail("local execute requires current workspace task-root-bash opt-in");
		if (task.adapterScope !== scope ||
			!frozen.capabilities.some(item => item.scope === scope && item.available) ||
			!Array.isArray(frozen.unresolvedOperationIds) || frozen.unresolvedOperationIds.length)
			fail("fresh work requires the trusted local capability and reconciled operations");
		if (!Array.isArray(task.addresses) || task.addresses.length === 0 ||
			new Set(task.addresses).size !== task.addresses.length ||
			task.addresses.some(id => !contract.obligations.some(item => item.id === id)))
			fail("next task must address named original obligations");
		const addressed = contract.obligations.filter(item => task.addresses.includes(item.id))
			.map(item => item.description);
		if (new Set(addressed).size !== addressed.length)
			fail("distinct original obligations have indistinguishable check text");
		const retainedInputs = frozen.retainedInputIdentity;
		if (retainedInputs && frozen.checkpointRawScope !==
			(retainedInputs.rawAuthority === "declared-materials" ? "none" : "workspace"))
			fail("retained input authority differs from checkpoint raw-input scope");
		const beforeProblem = await ctx.ws.readProblem();
		const beforeRaw = frozen.checkpointRawScope === "none" ?
			{ items: [], skipped: [] } : await ctx.ws.readRawInfo();
		const checkLiveOriginals = (problem: typeof beforeProblem, raw: typeof beforeRaw): void => {
			if (!retainedInputs) return;
			const digest = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
			if (digest(problem.content) !== retainedInputs.problemSha256 ||
				retainedInputs.rawAuthority === "original-raw" && (raw.skipped.length ||
					raw.items.length !== retainedInputs.raw.length ||
					raw.items.some((item, index) => item.name !== retainedInputs.raw[index]?.name ||
						digest(item.content) !== retainedInputs.raw[index]?.sha256)))
				fail("live original problem or raw input differs from the saved assessment");
		};
		checkLiveOriginals(beforeProblem, beforeRaw);
		const checkRetainedBaseline = async (): Promise<void> => {
			if (retainedInputs && JSON.stringify(await captureM04BaselineIdentity(ctx)) !==
				JSON.stringify(retainedInputs.m04BaselineIdentity))
				fail("M04 baseline changed since the saved assessment");
		};
		await checkRetainedBaseline();
		if (retainedInputs && ((await ctx.store.current())?.id ?? null) !==
			retainedInputs.knowledgeSnapshot)
			fail("published knowledge changed since the saved assessment");
		if (retainedInputs && !input.recordDispatchLineage)
			fail("retained assessment lacks the host dispatch verification seam");
		const workspaceRoot = await realpath(ctx.ws.root);
		const insideWorkspace = (file: string): boolean => {
			const relative = path.relative(workspaceRoot, file);
			return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
		};
		if (!Array.isArray(frozen.evidence) || !frozen.evidence.length ||
			frozen.evidence.some(item => !item || typeof item.file !== "string"))
			fail("host-frozen task evidence is absent");
		const evidenceFiles = await Promise.all(frozen.evidence.map(async item => realpath(item.file)));
		if (evidenceFiles.some(file => !insideWorkspace(file)))
			fail("host-frozen task evidence escaped the workspace");
		const taskInputContractName = await verifyTaskInputContract(frozen, contract.id,
			ctx.config.localMission?.evaluatorId);
		const baseline = await latestFormalBaseline(ctx);
		const goal = await controller.begin({ goal: task.objective,
			problemRelation: `${LOCAL_M07_MISSION_BINDING_PREFIX}${contract.id}\n${contract.goal}`,
			constraints: contract.obligations.map(item => item.description),
			successCriteria: addressed, plan: task.objective,
			exploratory: baseline === undefined },
			{ checkpointRawScope: frozen.checkpointRawScope });
		if (await readFile(goal.problemSnapshotPath, "utf8") !== beforeProblem.content)
			fail("original problem changed before M07 froze it");
		if (retainedInputs && await shaFile(goal.problemSnapshotPath) !== retainedInputs.problemSha256)
			fail("M07 problem snapshot differs from the saved assessment");
		if (mode === "execute" && ctx.config.localMission?.execution !== "task-root-bash")
			fail("local execute requires current workspace task-root-bash opt-in");
		const report = await controller.delegate(goal.runId, {
			objective: `${task.objective}${taskInputContractName ? `\n\nBefore producing files, read the complete ${taskInputContractName} host evidence input. Follow its versioned task input contract and examples; the evaluator checks the declared artifact shape.` : ""}${mode === "execute" ? "\n\nSave tangible result files in the deliverable/ directory. The report is evidence only; it does not establish that the original checks passed." : ""}`,
			mode, inputs: [...new Set([goal.problemSnapshotPath,
				...(retainedInputs ? [] : beforeRaw.items.map(item => item.path)), ...evidenceFiles])],
			expectedOutputs: mode === "execute" ? ["deliverable"] : [], checks: addressed },
			async (m07RunId, taskId) => {
				if (retainedInputs) {
					const observed = await controller.status(m07RunId);
					const prepared = observed.tasks.find(item => item.taskId === taskId);
					const expected = [{ source: await realpath(goal.problemSnapshotPath),
						sha256: retainedInputs.problemSha256 },
						...await Promise.all(frozen.evidence.map(async (item, index) => ({
							source: await realpath(item.file),
							sha256: retainedInputs.evidence[index]?.name === item.name ?
								retainedInputs.evidence[index]!.sha256 : "" })))];
					if (!prepared || prepared.inputCopies.length !== expected.length ||
						expected.some(row => !row.sha256 || prepared.inputCopies.filter(copy =>
							copy.source === row.source).length !== 1))
						fail("M07 copied input set differs from the saved assessment");
					for (const row of expected) {
						const copy = prepared.inputCopies.find(item => item.source === row.source)!;
						if (await shaFile(row.source) !== row.sha256 ||
							await shaFile(copy.copy) !== row.sha256)
							fail("M07 copied input bytes differ from the saved assessment");
					}
					checkLiveOriginals(await ctx.ws.readProblem(),
						frozen.checkpointRawScope === "none" ? beforeRaw : await ctx.ws.readRawInfo());
					if (((await ctx.store.current())?.id ?? null) !==
						retainedInputs.knowledgeSnapshot)
						fail("published knowledge changed before retained task dispatch");
					await checkRetainedBaseline();
				}
				await input.recordDispatchLineage?.(m07RunId, taskId);
			});
		for (const expected of [{ source: goal.problemSnapshotPath, content: beforeProblem.content },
			...(retainedInputs ? [] : beforeRaw.items.map(item => ({ source: item.path, content: item.content })))]) {
			const source = await realpath(expected.source);
			const copy = report.inputCopies.find(item => item.source === source);
			if (!copy || await readFile(copy.copy, "utf8") !== expected.content)
				fail("M07 task did not receive the frozen workspace materials");
		}
		const observed = await controller.status(goal.runId);
		if (report.status !== "returned" || !report.reportPath ||
			observed.executionState?.operations.some(item =>
				["prepared", "issued", "unknown"].includes(item.status))) {
			await controller.checkpoint(goal.runId, { taskIds: [report.taskId] });
			return { runId: goal.runId, outcome: "unknown", acceptedTaskIds: [],
				unresolvedOperationRefs: unresolvedRefs(observed, report.taskId) };
		}
		const evaluatorId = ctx.config.localMission?.evaluatorId;
		await verifyTaskInputContract(frozen, contract.id, evaluatorId);
		const evaluation = { contract, goal: observed, task: report,
			evidence: frozen.evidence, evaluatorId,
			frozenOriginalInputs: frozen.frozenOriginalInputs ?? [],
			capabilities: frozen.capabilities };
		let evaluated;
		try { evaluated = evaluatorId ? await evaluateLocalM07Task(evaluation) : undefined; }
		catch (error) {
			const state = evaluatorId ? await readLocalEvaluatorAttempt(evaluation) : { state: "absent" as const };
			if (state.state === "absent" && error instanceof HarnessError &&
				error.code === "local.evaluator.capability")
				return await settleNegativeEvaluation(controller, goal.runId, report,
					await preenterFeedback(report, contract.id, goal.runId, evaluatorId));
			if (state.state === "entered" || state.state === "threw" ||
				state.state === "returned-uncommitted") {
				const reconciled = await reconcileEnteredLocalEvaluatorAttempt(evaluation);
				if (reconciled.state === "settled-failure")
					return await settleNegativeEvaluation(controller, goal.runId, report,
						reconciled.review);
			}
			throw error;
		}
		const reviewed = await controller.review(goal.runId, evaluated?.review ?? { taskId: report.taskId,
			artifacts: [report.reportPath],
			checks: addressed.map(criterion => ({ criterion, result: "not_run", evidence: [] })) });
		if (evaluated) await verifyLocalEvaluatorReceipt(evaluated.receipt, contract,
			await controller.status(goal.runId), report);
		const checkpoint = await controller.checkpoint(goal.runId, { taskIds: [report.taskId] });
		const manifest = JSON.parse(await readFile(checkpoint.manifestPath, "utf8")) as
			{ problemFile?: string; rawFiles?: Array<{ name: string; relativePath: string }>;
				skippedRaw?: string[] };
		if (await readFile(path.join(checkpoint.rootDir, manifest.problemFile ?? ""), "utf8") !==
			beforeProblem.content || !Array.isArray(manifest.rawFiles) ||
			manifest.rawFiles.length !== beforeRaw.items.length ||
			!Array.isArray(manifest.skippedRaw) ||
			JSON.stringify(manifest.skippedRaw) !== JSON.stringify(beforeRaw.skipped))
			fail("M07 checkpoint changed the frozen workspace materials");
		for (let index = 0; index < beforeRaw.items.length; index++) {
			const expected = beforeRaw.items[index];
			const actual = manifest.rawFiles[index];
			if (actual.name !== expected.name ||
				await readFile(path.join(checkpoint.rootDir, actual.relativePath), "utf8") !== expected.content)
				fail("M07 checkpoint changed the frozen workspace materials");
		}
		const passed = Boolean(evaluated && reviewed.status === "accepted" &&
			contract.obligations.filter(item => task.addresses.includes(item.id)).every(item =>
				evaluated.receipt.checks.some(check => check.obligationId === item.id && check.result === "passed")));
		const eligible = passed && !goal.exploratory && goal.formalBaseline;
		const observationOnlyGap = eligible && evaluated ?
			missingCandidateSelectionProof(evaluated.receipt) : [];
		const selectable = Boolean(eligible && !observationOnlyGap.length);
		const snapshot = JSON.parse(await readFile(checkpoint.goalSnapshotPath, "utf8")) as CurrentGoal;
		const snapTask = snapshot.tasks.find(item => item.taskId === report.taskId);
		const m07Outcome = selectable && snapshot.tasks.some(item => item.taskId !== report.taskId &&
			["rejected", "failed"].includes(item.status)) ? "partial" : selectable ? "fulfilled" : "partial";
		const requiredM07ReadPaths = evaluated ? [...new Set(["goal.json", "manifest.json", "m04-feedback.md",
			...(snapTask?.review?.artifacts ?? []).filter(item => item.mediaType === "text")
				.map(item => path.relative(checkpoint.rootDir, item.path).replaceAll("\\", "/"))])] : undefined;
		const m04 = await input.runM04(ctx, { feedback: { kind: "M07Checkpoint", runId: goal.runId,
			checkpointId: checkpoint.id }, freshSession: true,
			...(requiredM07ReadPaths ? { requiredM07ReadPaths } : {}) });
		let selectionProofGap;
		if (evaluated) {
			const tx = JSON.parse(await readFile(path.join(ctx.ws.runDir("M04", m04.record.runId),
				"m04-transaction.json"), "utf8")) as { state?: string; m04RunId?: string };
			if (tx.m04RunId !== m04.record.runId || !["no-proposal", "merged"].includes(tx.state ?? ""))
				fail("M04 knowledge transaction is unresolved; M07 result cannot be finished");
			if (eligible) {
				const selectionInput = { runId: goal.runId, outcome: "fulfilled",
					acceptedTaskIds: [report.taskId], selectedTaskId: report.taskId,
					checkpointId: checkpoint.id, m04RunId: m04.record.runId,
					evaluatorReceiptPath: evaluated.receiptFile, requiredM07ReadPaths };
				if (observationOnlyGap.length)
					selectionProofGap = await computeMissingSelectionProof({ ctx, controller,
						contract, run: selectionInput });
				else {
					await verifyDefaultM04Evidence(ctx, selectionInput, checkpoint.rootDir);
					await controller.plan(goal.runId, goal.plan, { refreshBaseline: true,
						checkpointId: checkpoint.id, m04RunId: m04.record.runId });
				}
			}
			await controller.finish(goal.runId, { outcome: m07Outcome,
				summary: selectionProofGap ? "Passed host observations lack candidate citations; the accepted task remains unselected partial evidence." :
					eligible ? "Host evaluator checks and full independent M04 reading are recorded; mission selection remains a separate host decision." :
					"Bounded task remains partial or exploratory; evaluator observations do not grant mission selection.",
				returnPath: "M04", goalChecks: reviewed.review!.checks.map(check => ({ ...check })) });
		}
		return { runId: goal.runId, outcome: m07Outcome,
			acceptedTaskIds: reviewed.status === "accepted" ? [report.taskId] : [],
			...(selectable ? { selectedTaskId: report.taskId } : {}),
			...(selectionProofGap ? { selectionProofGap } : {}),
			m04RunId: m04.record.runId, checkpointId: checkpoint.id,
			...(evaluated ? { evaluatorReceiptPath: evaluated.receiptFile,
				requiredM07ReadPaths } : {}), unresolvedOperationRefs: [] };
	} };
}

export function createLocalM07Adapters(): LocalObjectiveAdapter[] {
	return [createLocalM07Adapter("reason"), createLocalM07Adapter("execute")];
}
