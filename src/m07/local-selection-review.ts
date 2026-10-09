/** Default local host's selection boundary. Evaluator observations remain
 * unselected until the ordinary M07 review, M04 read, and transaction checks
 * have all produced persisted, mutually bound evidence. */
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import type { StageContext } from "../stages/context.ts";
import { assertFullM07Reads, requiredM07Reads } from "../stages/m04.ts";
import type { M04KnowledgeTransactionV1 } from "../stages/m04.ts";
import { HarnessError } from "../types.ts";
import type { M07Controller, CurrentGoal } from "./types.ts";
import type { MissingSelectionProofV1, OriginalObjectiveContractV1, ObjectiveProgressV1 } from "./objective-progress.ts";
import type { LocalObjectiveAdvanceResult, LocalObjectiveSelectionReviewV1 } from "./local-original-objective.ts";
import { readLocalEvaluatorReceipt, verifyLocalEvaluatorReceipt,
	type LocalEvaluatorReceiptV1 } from "./local-evaluator-run.ts";
import { trustedLocalMissionEvaluator } from "./local-mission-evaluator.ts";

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const receiptName = (runId: string) => `selection-review-${runId}.json`;
const safeRunId = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;
function selectedEvidenceName(runId: string, taskId: string, name: string): string {
	const identity = sha256(Buffer.from(`${runId}/${taskId}/${name}`)).slice(0, 16);
	const extension = path.extname(name);
	const stem = name.slice(0, name.length - extension.length);
	return `${stem.slice(0, 50)}-${identity}${extension}`;
}

async function regular(file: string, allowEmpty = false): Promise<Buffer> {
	const info = await lstat(file);
	if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 ||
		(allowEmpty ? info.size < 0 : info.size < 1) ||
		info.size > 8 * 1024 * 1024) throw new HarnessError("local.selection.file", "selection evidence is not a bounded regular file");
	const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	try {
		const before = await handle.stat();
		const bytes = await handle.readFile();
		if (bytes.length !== before.size || (await handle.stat()).size !== before.size)
			throw new HarnessError("local.selection.file", "selection evidence changed during read");
		return bytes;
	} finally { await handle.close(); }
}

export async function verifyDefaultM04Evidence(ctx: StageContext,
	run: LocalObjectiveAdvanceResult, checkpointRoot: string) {
	if (!run.m04RunId || !run.checkpointId || !run.requiredM07ReadPaths?.length)
		throw new HarnessError("local.selection.m04", "selection needs an exact M04 checkpoint read contract");
	if (!safeRunId.test(run.m04RunId) || !safeRunId.test(run.runId) ||
		!/^C\d{3,}$/.test(run.checkpointId))
		throw new HarnessError("local.selection.m04", "M04 or checkpoint identity is invalid");
	await requiredM07Reads(checkpointRoot, run.requiredM07ReadPaths);
	const m04 = await ctx.ws.readRun("M04", run.m04RunId);
	if (m04.status !== "completed" || m04.failures.length)
		throw new HarnessError("local.selection.m04", "M04 review is not a settled completed review");
	const dir = ctx.ws.runDir("M04", run.m04RunId);
	const sourceBytes = await regular(path.join(dir, "m07-source.json"));
	const coverageBytes = await regular(path.join(dir, "m07-coverage.json"));
	const txBytes = await regular(path.join(dir, "m04-transaction.json"));
	const source = JSON.parse(sourceBytes.toString("utf8")) as { m07RunId?: string;
		checkpointId?: string; rootDir?: string; manifestPath?: string; selectedTaskIds?: string[] };
	const coverage = JSON.parse(coverageBytes.toString("utf8")) as { promptOutcome?: string;
		returnedRanges?: Parameters<typeof assertFullM07Reads>[2] };
	const tx = JSON.parse(txBytes.toString("utf8")) as M04KnowledgeTransactionV1;
	if (source.m07RunId !== run.runId || source.checkpointId !== run.checkpointId ||
		source.rootDir !== checkpointRoot || source.manifestPath !== path.join(checkpointRoot, "manifest.json") ||
		!source.selectedTaskIds?.includes(run.selectedTaskId ?? "") ||
		coverage.promptOutcome !== "returned" || !Array.isArray(coverage.returnedRanges) ||
			tx.version !== 1 || tx.kind !== "m04-knowledge-transaction" ||
			tx.m04RunId !== run.m04RunId ||
		!["no-proposal", "merged"].includes(tx.state))
		throw new HarnessError("local.selection.m04", "M04 source, coverage or transaction is unresolved or mismatched");
	await assertFullM07Reads(checkpointRoot, run.requiredM07ReadPaths, coverage.returnedRanges);
	// A different M04 run with an open merge intent cannot be hidden by this
	// selected run's own clean transaction.
	for (const id of await ctx.ws.listRuns("M04")) {
		if ((await ctx.ws.readRun("M04", id)).status === "running")
			throw new HarnessError("local.selection.m04", "an active M04 run blocks selection");
		const file = path.join(ctx.ws.runDir("M04", id), "m04-transaction.json");
		let bytes: Buffer;
		try { bytes = await regular(file); }
		catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
			throw error;
		}
		const other = JSON.parse(bytes.toString("utf8")) as M04KnowledgeTransactionV1;
		if (other.version !== 1 || other.kind !== "m04-knowledge-transaction" ||
			other.m04RunId !== id ||
			!["no-proposal", "rejected-draft", "merged"].includes(other.state))
			throw new HarnessError("local.selection.m04", "an invalid or unresolved knowledge transaction blocks selection");
	}
	return { sourceBytes, coverageBytes, txBytes };
}

/** Missing candidate citations are a selection gap, never an invented citation. */
export function missingCandidateSelectionProof(receipt: LocalEvaluatorReceiptV1): string[] {
	const passed = receipt.checks.filter(item => item.result === "passed");
	const candidates = new Set(receipt.candidate.map(item => item.name));
	const observations = new Set(receipt.observations.map(item => item.name));
	if (!passed.length || !observations.size || passed.some(item =>
		!item.evidenceRefs.some(name => observations.has(name)))) return [];
	return passed.filter(item => !item.evidenceRefs.some(name => candidates.has(name)))
		.map(item => item.obligationId);
}

/** Recompute every byte binding on both the first write and the next assessment. */
export async function computeMissingSelectionProof(input: { ctx: StageContext;
	controller: M07Controller; contract: OriginalObjectiveContractV1;
	run: LocalObjectiveAdvanceResult }): Promise<MissingSelectionProofV1> {
	const { ctx, controller, contract, run } = input;
	if (!run.selectedTaskId || !run.checkpointId || !run.m04RunId ||
		!run.requiredM07ReadPaths?.length || run.acceptedTaskIds.length !== 1 ||
		run.acceptedTaskIds[0] !== run.selectedTaskId)
		throw new HarnessError("local.selection.gap", "missing-proof input is not one accepted task");
	const goal = await controller.status(run.runId);
	const task = goal.tasks.find(item => item.taskId === run.selectedTaskId);
	if (!task || task.status !== "accepted" || !task.review ||
		goal.executionState?.operations.some(item =>
			["prepared", "issued", "unknown"].includes(item.status)))
		throw new HarnessError("local.selection.gap", "missing-proof task is not settled and formally reviewed");
	const receiptPath = path.join(task.workDir, "local-evaluator-receipt.json");
	if (run.evaluatorReceiptPath !== receiptPath)
		throw new HarnessError("local.selection.gap", "missing-proof receipt path differs from the task");
	const { receipt, sha256: evaluatorReceiptSha256 } = await readLocalEvaluatorReceipt(receiptPath);
	const evaluator = trustedLocalMissionEvaluator(ctx.config.localMission?.evaluatorId);
	if (!evaluator || evaluator.id !== receipt.evaluator.id || evaluator.version !== receipt.evaluator.version)
		throw new HarnessError("local.selection.gap", "trusted evaluator identity or version changed");
	await verifyLocalEvaluatorReceipt(receipt, contract, goal, task);
	const missingCandidateObligationIds = missingCandidateSelectionProof(receipt);
	if (!missingCandidateObligationIds.length)
		throw new HarnessError("local.selection.gap", "receipt has no observation-only passed check");
	const checkpoint = goal.checkpoints?.find(item => item.id === run.checkpointId);
	if (!checkpoint || checkpoint.feedbackStatus !== "complete" && checkpoint.feedbackStatus !== "indexed")
		throw new HarnessError("local.selection.gap", "M07 checkpoint is missing");
	const snapshot = JSON.parse((await regular(checkpoint.goalSnapshotPath)).toString("utf8")) as CurrentGoal;
	const snapshotTask = snapshot.tasks.find(item => item.taskId === task.taskId);
	if (snapshot.runId !== goal.runId || !snapshot.formalBaseline || snapshot.exploratory ||
		snapshotTask?.status !== "accepted")
		throw new HarnessError("local.selection.gap", "M07 checkpoint did not retain the accepted task");
	const required = [...new Set(["goal.json", "manifest.json", "m04-feedback.md",
		...(snapshotTask.review?.artifacts ?? []).filter(item => item.mediaType === "text")
			.map(item => path.relative(checkpoint.rootDir, item.path).replaceAll("\\", "/"))])];
	if (JSON.stringify(required) !== JSON.stringify(run.requiredM07ReadPaths))
		throw new HarnessError("local.selection.gap", "M04 read paths differ from the exact checkpoint");
	const m04 = await verifyDefaultM04Evidence(ctx, run, checkpoint.rootDir);
	return { version: 1, kind: "local-selection-proof-gap",
		reasonCode: "passed-check-missing-candidate-reference",
		missionId: contract.id, runId: run.runId, taskId: task.taskId,
		checkpointId: checkpoint.id, m04RunId: run.m04RunId,
		missingCandidateObligationIds, evaluatorReceiptSha256,
		checkpointManifestSha256: sha256(await regular(checkpoint.manifestPath)),
		m04SourceSha256: sha256(m04.sourceBytes),
		m04CoverageSha256: sha256(m04.coverageBytes),
		m04TransactionSha256: sha256(m04.txBytes),
		requiredM07ReadPaths: [...required] };
}

export async function verifyMissingSelectionProof(input: { ctx: StageContext;
	controller: M07Controller; contract: OriginalObjectiveContractV1;
	bounded: ObjectiveProgressV1["boundedRuns"][number] }): Promise<void> {
	const { bounded } = input;
	const gap = bounded.selectionProofGap;
	if (!gap || bounded.selectedTaskId || bounded.outcome !== "partial" ||
		bounded.acceptedTaskIds?.length !== 1 || bounded.acceptedTaskIds[0] !== gap.taskId ||
		gap.runId !== bounded.runId || gap.missionId !== input.contract.id)
		throw new HarnessError("local.selection.gap", "persisted missing-proof run binding is invalid");
	const computed = await computeMissingSelectionProof({ ...input, run: {
		runId: gap.runId, outcome: "partial", acceptedTaskIds: [gap.taskId],
		selectedTaskId: gap.taskId, checkpointId: gap.checkpointId,
		m04RunId: gap.m04RunId,
		evaluatorReceiptPath: path.join(input.ctx.ws.runDir("M07", gap.runId),
			"tasks", gap.taskId, "work", "local-evaluator-receipt.json"),
		requiredM07ReadPaths: gap.requiredM07ReadPaths } });
	if (JSON.stringify(computed) !== JSON.stringify(gap))
		throw new HarnessError("local.selection.gap", "persisted missing-proof bytes differ from M07/M04 evidence");
}

async function compute(ctx: StageContext, controller: M07Controller,
	contract: OriginalObjectiveContractV1, run: LocalObjectiveAdvanceResult):
	Promise<LocalObjectiveSelectionReviewV1 | undefined> {
	if (!run.selectedTaskId) return undefined;
	if (!safeRunId.test(run.runId) || !/^T\d{3,}$/.test(run.selectedTaskId))
		throw new HarnessError("local.selection.identity", "selected M07 identity is invalid");
	const goal: CurrentGoal = await controller.status(run.runId);
	const binding = `Local original objective mission: ${contract.id}\n${contract.goal}`;
	const task = goal.tasks.find(item => item.taskId === run.selectedTaskId);
	const expectedTaskRoot = path.join(ctx.ws.runDir("M07", run.runId), "tasks", run.selectedTaskId);
	if (goal.runId !== run.runId || goal.problemRelation !== binding || goal.exploratory ||
		!goal.formalBaseline || goal.lifecycle !== "finished" ||
		!(["fulfilled", "partial"] as const).includes(goal.outcome as "fulfilled" | "partial") ||
		!task || task.status !== "accepted" || !task.review ||
		path.dirname(task.workDir) !== expectedTaskRoot ||
		run.acceptedTaskIds.length !== 1 || run.acceptedTaskIds[0] !== task.taskId ||
		goal.tasks.some(item => item.taskId !== task.taskId &&
			!["accepted", "rejected", "failed"].includes(item.status)) ||
		goal.executionState?.operations.some(item => ["prepared", "issued", "unknown"].includes(item.status)) ||
		run.evaluatorReceiptPath !== path.join(task.workDir, "local-evaluator-receipt.json") ||
		!run.checkpointId || !run.m04RunId ||
		!run.requiredM07ReadPaths?.length)
		throw new HarnessError("local.selection.identity", "selected task is not a settled, formally reviewed mission task");
	const { receipt, sha256: evaluatorReceiptSha256 } = await readLocalEvaluatorReceipt(run.evaluatorReceiptPath);
	const evaluator = trustedLocalMissionEvaluator(ctx.config.localMission?.evaluatorId);
	if (!evaluator || evaluator.id !== receipt.evaluator.id || evaluator.version !== receipt.evaluator.version)
		throw new HarnessError("local.selection.evaluator", "trusted evaluator identity or version changed");
	await verifyLocalEvaluatorReceipt(receipt, contract, goal, task);
	if (receipt.candidate.some(candidate =>
		path.dirname(candidate.file) !== path.join(expectedTaskRoot, "evaluator-snapshot")))
		throw new HarnessError("local.selection.bytes", "candidate snapshot escaped the M07 task");
	if (receipt.checks.length !== contract.obligations.length ||
		contract.obligations.some(item => !receipt.checks.some(check => check.obligationId === item.id)) ||
		goal.successCriteria.length !== task.checks.length ||
		goal.goalChecks?.length !== task.checks.length ||
		goal.goalChecks.some(item => item.result !== "passed" || !item.evidence.length) ||
		task.review.checks.some(item => item.result !== "passed" || !item.evidence.length) ||
		!task.review.artifacts.some(item => item.sourcePath === run.evaluatorReceiptPath &&
			item.path && item.mediaType === "text"))
		throw new HarnessError("local.selection.checks", "original obligations or evaluator receipt were not accepted by M07");
	const reviewedReceipt = task.review.artifacts.find(item => item.sourcePath === run.evaluatorReceiptPath)!;
	if (sha256(await regular(reviewedReceipt.path)) !== evaluatorReceiptSha256)
		throw new HarnessError("local.selection.receipt", "M07 review snapshot differs from evaluator receipt");
	for (const candidate of receipt.candidate) {
		const reviewed = task.review.artifacts.find(item => item.sourcePath === candidate.sourceFile);
		if (!reviewed || sha256(await regular(reviewed.path, candidate.bytes === 0)) !== candidate.sha256)
			throw new HarnessError("local.selection.bytes", "M07 reviewed candidate differs from evaluator snapshot");
	}
	for (const observation of receipt.observations) {
		const reviewed = task.review.artifacts.find(item => item.sourcePath === observation.file);
		if (!reviewed || reviewed.mediaType !== "text" ||
			sha256(await regular(reviewed.path)) !== observation.sha256)
			throw new HarnessError("local.selection.observation", "M07 review lacks the exact host observation");
	}
	for (const evidenceRef of new Set(receipt.checks.flatMap(item => item.evidenceRefs))) {
		const input = receipt.frozenEvidence.find(item => item.name === evidenceRef);
		if (!input) continue;
		const source = await realpath(input.file);
		const copy = task.inputCopies.find(item => item.source === source);
		const reviewed = task.review.artifacts.find(item => item.sourcePath === copy?.copy);
		if (!copy || !reviewed || sha256(await regular(reviewed.path)) !== input.sha256)
			throw new HarnessError("local.selection.bytes", "M07 reviewed input differs from evaluator evidence");
	}
	const checkpoint = goal.checkpoints?.find(item => item.id === run.checkpointId);
	if (!checkpoint || checkpoint.feedbackStatus !== "complete" && checkpoint.feedbackStatus !== "indexed")
		throw new HarnessError("local.selection.checkpoint", "M07 review checkpoint is missing");
	const snap = JSON.parse((await regular(checkpoint.goalSnapshotPath)).toString("utf8")) as CurrentGoal;
	if (snap.runId !== goal.runId || !snap.checkpointScope?.selectedTaskIds.includes(task.taskId) ||
		snap.tasks.find(item => item.taskId === task.taskId)?.status !== "accepted")
		throw new HarnessError("local.selection.checkpoint", "M07 checkpoint does not pin the accepted task");
	const snapshotTask = snap.tasks.find(item => item.taskId === task.taskId)!;
	for (const member of [...receipt.candidate.map(item => ({ sourceFile: item.sourceFile,
		sha256: item.sha256, allowEmpty: item.bytes === 0 })),
		...receipt.observations.map(item => ({ sourceFile: item.file,
			sha256: item.sha256, allowEmpty: false }))]) {
		const index = task.review.artifacts.findIndex(item => item.sourcePath === member.sourceFile);
		const frozen = snapshotTask.review?.artifacts[index];
		if (index < 0 || !frozen ||
			sha256(await regular(frozen.path, member.allowEmpty)) !== member.sha256)
			throw new HarnessError("local.selection.checkpoint", "M04 checkpoint candidate or observation differs from evaluator bytes");
	}
	const required = [...new Set(["goal.json", "manifest.json", "m04-feedback.md",
		...(snapshotTask.review?.artifacts ?? []).filter(item => item.mediaType === "text")
			.map(item => path.relative(checkpoint.rootDir, item.path).replaceAll("\\", "/"))])];
	if (JSON.stringify(required) !== JSON.stringify(run.requiredM07ReadPaths))
		throw new HarnessError("local.selection.m04", "M04 required read set differs from exact M07 review snapshot");
	const checkpointManifestSha256 = sha256(await regular(checkpoint.manifestPath));
	const evidence = await verifyDefaultM04Evidence(ctx, run, checkpoint.rootDir);
	const selectedNames = [...new Set([
		...receipt.checks.filter(item => item.result === "passed")
			.flatMap(item => item.evidenceRefs).filter(name =>
				receipt.candidate.some(candidate => candidate.name === name)),
		...receipt.observations.map(item => item.name)])];
	if (!receipt.observations.length || receipt.checks.filter(item => item.result === "passed").some(item =>
		!item.evidenceRefs.some(name => receipt.candidate.some(candidate => candidate.name === name)) ||
		!item.evidenceRefs.some(name => receipt.observations.some(observation => observation.name === name))))
		throw new HarnessError("local.selection.checks", "every passed original check needs candidate and host-observation evidence");
	const nameMap = new Map(selectedNames.map(name => [name,
		selectedEvidenceName(run.runId, task.taskId, name)]));
	const selectedArtifacts = selectedNames.map(name => {
		const source = receipt.candidate.find(item => item.name === name) ??
			receipt.observations.find(item => item.name === name)!;
		return { name: nameMap.get(name)!, file: source.file, sha256: source.sha256 };
	});
	return { version: 1, kind: "local-objective-selection-review", runId: run.runId,
		taskId: task.taskId, m04RunId: run.m04RunId, selectedArtifacts,
		originalChecks: receipt.checks.map(item => ({ obligationId: item.obligationId,
			passed: item.result === "passed",
			result: item.result === "not_run" ? "unknown" : item.result,
			evidenceRefs: item.evidenceRefs.flatMap(name => nameMap.has(name) ? [nameMap.get(name)!] : []) })),
		hostEvidence: { missionId: contract.id, checkpointId: checkpoint.id,
			evaluatorId: evaluator.id, evaluatorVersion: evaluator.version,
			evaluatorReceiptSha256, m04SourceSha256: sha256(evidence.sourceBytes),
			m04CoverageSha256: sha256(evidence.coverageBytes),
			m04TransactionSha256: sha256(evidence.txBytes),
			checkpointManifestSha256,
			requiredM07ReadPaths: [...run.requiredM07ReadPaths] } };
}

export async function recordDefaultSelectionReview(input: { ctx: StageContext;
	controller: M07Controller; contract: OriginalObjectiveContractV1;
	run: LocalObjectiveAdvanceResult; root: string }):
	Promise<LocalObjectiveSelectionReviewV1 | undefined> {
	const review = await compute(input.ctx, input.controller, input.contract, input.run);
	if (!review) return undefined;
	const file = path.join(input.root, "evidence", receiptName(review.runId));
	await writeFile(file, `${JSON.stringify(review, null, 2)}\n`, { flag: "wx", mode: 0o600 });
	return review;
}

export async function recoverDefaultSelectionReview(input: { ctx: StageContext;
	controller: M07Controller; contract: OriginalObjectiveContractV1;
	progress: ObjectiveProgressV1; root: string }):
	Promise<LocalObjectiveSelectionReviewV1 | undefined> {
	const selected = [...input.progress.boundedRuns].reverse().find(item => item.selectedTaskId);
	if (!selected && !input.progress.selectedArtifacts.length) return undefined;
	if (!selected) throw new HarnessError("local.selection.persisted", "selected checkpoint has no reviewed task");
	if (!safeRunId.test(selected.runId))
		throw new HarnessError("local.selection.persisted", "persisted selected run identity is invalid");
	const file = path.join(input.root, "evidence", receiptName(selected.runId));
	let bytes: Buffer;
	try { bytes = await regular(file); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT" && !input.progress.selectedArtifacts.length)
			return undefined;
		throw error;
	}
	const persisted = JSON.parse(bytes.toString("utf8")) as LocalObjectiveSelectionReviewV1;
	const bound = input.progress.boundedRuns.find(item => item.runId === persisted.runId);
	if (!bound || persisted.hostEvidence?.missionId !== input.contract.id ||
		bound.selectedTaskId !== persisted.taskId)
		throw new HarnessError("local.selection.persisted", "persisted selection has wrong mission or task");
	const task = (await input.controller.status(persisted.runId)).tasks.find(item => item.taskId === persisted.taskId);
	if (!task) throw new HarnessError("local.selection.persisted", "persisted selected task is missing");
	const computed = await compute(input.ctx, input.controller, input.contract, {
		runId: persisted.runId, outcome: "fulfilled", acceptedTaskIds: [persisted.taskId],
		selectedTaskId: persisted.taskId, m04RunId: persisted.m04RunId,
		checkpointId: persisted.hostEvidence.checkpointId,
		evaluatorReceiptPath: path.join(task.workDir, "local-evaluator-receipt.json"),
		requiredM07ReadPaths: persisted.hostEvidence.requiredM07ReadPaths });
	if (!computed || JSON.stringify(computed) !== JSON.stringify(persisted) ||
		JSON.stringify(persisted.selectedArtifacts.map(item => item.name)) !==
			JSON.stringify(input.progress.selectedArtifacts))
		throw new HarnessError("local.selection.persisted", "persisted selection differs from frozen M07/M04 evidence");
	return persisted;
}

export function defaultSelectionEvidenceFiles(ctx: StageContext, review: LocalObjectiveSelectionReviewV1,
	root: string): Array<{ name: string; file: string }> {
	return [
		{ name: "selection-review.json", file: path.join(root, "evidence", receiptName(review.runId)) },
		{ name: "selected-m04-source.json", file: path.join(ctx.ws.runDir("M04", review.m04RunId), "m07-source.json") },
		{ name: "selected-m04-coverage.json", file: path.join(ctx.ws.runDir("M04", review.m04RunId), "m07-coverage.json") },
		{ name: "selected-m04-transaction.json", file: path.join(ctx.ws.runDir("M04", review.m04RunId), "m04-transaction.json") },
		...review.selectedArtifacts.map(item => ({ name: item.name, file: item.file })),
	];
}
