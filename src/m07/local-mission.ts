/** Workspace-local original-objective entry point. GitHub transport is an optional
 * host adapter; this path binds the existing assessor and M07/M04 stages to a
 * private, durable filesystem host without choosing a scientific conclusion. */
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { createFileKnowledgeStore, serialiseRecord } from "../knowledge/store.ts";
import type { KnowledgeRecord, Snapshot } from "../knowledge/types.ts";
import { LocalMissionHost, type LocalEvaluatorRecoveryReviewV1 } from "../runner/local-mission-host.ts";
import type { SessionRunner } from "../runner/types.ts";
import { probeProcessIdentity, readCurrentProcessIdentity } from "../runtime/process-identity.ts";
import { HarnessError, type HarnessConfig } from "../types.ts";
import type { StageContext } from "../stages/context.ts";
import { runM04 } from "../stages/m04.ts";
import { Workspace } from "../workspace.ts";
import { createLocalM07Adapters, LOCAL_M07_MISSION_BINDING_PREFIX,
	LOCAL_M07_REASON_SCOPE, LOCAL_M07_EXECUTE_SCOPE,
	recoverBoundLocalM07Task } from "./local-m07-adapter.ts";
import { requireLocalEvaluator } from "./local-evaluator-run.ts";
import { trustedLocalMissionEvaluator, validatedTaskInputContract,
	type LocalMissionEvaluator } from "./local-mission-evaluator.ts";
import { recordDefaultSelectionReview, recoverDefaultSelectionReview,
	verifyMissingSelectionProof,
	defaultSelectionEvidenceFiles } from "./local-selection-review.ts";
import { createM07Controller } from "./controller.ts";
import { captureM04BaselineIdentity } from "./formal-baseline.ts";
import { assessorTaskHash, localLineageHash, missionLineageCommitFile,
	missionLineageFile, readLocalDispatchLineage,
	recordLocalDispatchLineage } from "./local-dispatch-lineage.ts";
import type { CurrentGoal } from "./types.ts";
import { freezeLocalMaterialBundle, readLocalMaterialBundle,
	type LocalMaterialSelection } from "./local-material-bundle.ts";
import { createLocalOriginalObjectiveCaller, type LocalObjectiveFrozenEvidence,
	type LocalObjectiveHostPort, type LocalObjectiveRequestV1 } from "./local-original-objective.ts";
import { objectiveProgress, type ObjectiveProgressV1,
	type OriginalObjectiveContractV1 } from "./objective-progress.ts";
export type { LocalObjectiveRequestV1 } from "./local-original-objective.ts";

const checkpointBytes = (progress: ObjectiveProgressV1): Buffer =>
	Buffer.from(`${JSON.stringify(progress, null, 2)}\n`, "utf8");
const sha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");
const attemptNumber = (id: string): number => Number(id.slice(1));
const safeId = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const activeRecoveryClaims = new Set<string>();
const activeNoIssuedResumes = new Set<string>();

async function safeText(file: string): Promise<string> {
	const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	try {
		const before = await handle.stat();
		if (!before.isFile() || before.nlink !== 1 || before.size > 64 * 1024 * 1024)
			throw new Error("local mission input is not a bounded regular file");
		const bytes = await handle.readFile();
		if (bytes.length !== before.size) throw new Error("local mission input changed during freeze");
		return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
	} finally { await handle.close(); }
}

async function saveFrozen(file: string, text: string): Promise<void> {
	const handle = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
	try { await handle.writeFile(text); await handle.sync(); }
	finally { await handle.close(); }
	const directory = await open(path.dirname(file), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
	try { await directory.sync(); } finally { await directory.close(); }
}

async function ensureFrozen(file: string, text: string): Promise<void> {
	try { await saveFrozen(file, text); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST" || await safeText(file) !== text)
			throw error;
	}
}

async function stageOrVerifyFrozen(file: string, text: string, verifyOnly: boolean): Promise<void> {
	if (verifyOnly) {
		if (await safeText(file) !== text)
			throw new Error("frozen mission evidence differs from its committed source");
	} else await ensureFrozen(file, text);
}

function textParts(text: string): string[] {
	const parts: string[] = [];
	let current = "", bytes = 0;
	for (const character of text) {
		const size = Buffer.byteLength(character, "utf8");
		if (current && bytes + size > 900_000) { parts.push(current); current = ""; bytes = 0; }
		current += character; bytes += size;
	}
	parts.push(current);
	return parts;
}

async function parseProgress(bytes: Buffer | undefined, missionId: string): Promise<ObjectiveProgressV1 | undefined> {
	if (!bytes) return undefined;
	const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as ObjectiveProgressV1;
	if (value?.version !== 1 || value.kind !== "original-objective-progress" ||
		value.contract?.id !== missionId || !Array.isArray(value.boundedRuns) ||
		!Array.isArray(value.assessmentHistory) || !Array.isArray(value.selectedArtifacts) ||
		!Array.isArray(value.continuation?.unresolvedOperationIds))
		throw new Error("local mission checkpoint schema or identity is invalid");
	return value;
}

export function openDefaultLocalMission(input: { workspaceRoot: string;
	runner?: SessionRunner; config?: HarnessConfig }) {
	const ws = new Workspace(input.workspaceRoot);
	const rootFor = (missionId: string) => path.join(ws.agentDir, "missions", missionId);
	const context: StageContext | undefined = input.runner && input.config ?
		{ ws, runner: input.runner, config: input.config,
			store: createFileKnowledgeStore(ws.knowledgeDir) } : undefined;
	const hostFor = (missionId: string): LocalObjectiveHostPort => {
		const root = rootFor(missionId);
		let active: LocalMissionHost | undefined;
		const writable = async (): Promise<LocalMissionHost> => {
			if (active) return active;
			const current = await LocalMissionHost.status(root).catch(error => {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
				throw error;
			});
			const source = current?.currentAttempt;
			const nextId = source ? `A${String(attemptNumber(source.attemptId) + 1).padStart(3, "0")}` : "A001";
			// The host authenticates same-process reuse and checks a dead predecessor before
			// admitting any new attempt. A failed probe leaves prior effects UNKNOWN.
			try { active = await LocalMissionHost.begin({ root, missionId,
				attemptId: source?.attemptId ?? "A001", codeRevision: "local-harness-v1" }); }
			catch (error) {
				if (!source || !/attempt identity changed/.test(String(error))) throw error;
				active = await LocalMissionHost.begin({ root, missionId,
					attemptId: nextId, codeRevision: "local-harness-v1" });
			}
			return active;
		};
		const contractFile = path.join(root, "evidence", "original-objective.json");
		const stageBoundedEvidence = async (progress: ObjectiveProgressV1): Promise<Record<string, string[]>> => {
			const evidenceDir = path.join(root, "evidence");
			const mapped: Record<string, string[]> = {};
			for (const [index, bounded] of progress.boundedRuns.entries()) {
				const goalPath = path.join(ws.runDir("M07", bounded.runId), "goal.json");
				const goal = JSON.parse(await safeText(goalPath)) as { problemRelation?: string;
					checkpoints?: Array<{ id: string; feedbackPath: string; feedbackStatus: string }> };
				if (goal.problemRelation !== `${LOCAL_M07_MISSION_BINDING_PREFIX}${missionId}\n${progress.contract.goal}`)
					throw new Error("local mission bounded M07 run lacks exact mission binding");
				const checkpoint = goal.checkpoints?.at(-1);
				let feedback: string;
				let controlOnly = false;
				if (checkpoint && ["complete", "indexed"].includes(checkpoint.feedbackStatus) &&
					checkpoint.feedbackPath === path.join(ws.runDir("M07", bounded.runId), "checkpoints",
						checkpoint.id, "m04-feedback.md")) feedback = await safeText(checkpoint.feedbackPath);
				else if (bounded.outcome === "unknown" &&
					progress.continuation.unresolvedOperationIds.some(id =>
						id === bounded.runId || id.startsWith(`${bounded.runId}/`))) {
					controlOnly = true;
					// A failed task may have no report. This host control witness preserves
					// the negative outcome without inventing scientific evidence.
					const control = goal as { lifecycle?: string; tasks?: Array<{ taskId: string; status: string }>;
						executionState?: { operations?: Array<{ id: string; status: string }> } };
					feedback = `${JSON.stringify({ version: 1, kind: "local-m07-incomplete-control",
						runId: bounded.runId, outcome: bounded.outcome, lifecycle: control.lifecycle,
						tasks: (control.tasks ?? []).map(task => ({ taskId: task.taskId, status: task.status })),
						operations: (control.executionState?.operations ?? []).map(operation =>
							({ id: operation.id, status: operation.status })) }, null, 2)}\n`;
				} else throw new Error("local mission bounded M07 feedback is incomplete");
				const names: string[] = [];
				for (const [partIndex, part] of textParts(feedback).entries()) {
					const name = `prior-run-${index + 1}-${controlOnly ? "control" : "feedback"}-${partIndex + 1}.txt`;
					await ensureFrozen(path.join(evidenceDir, name), part);
					names.push(name);
				}
				mapped[bounded.runId] = names;
			}
			return mapped;
		};
		const stageMissingProofGaps = async (progress: ObjectiveProgressV1,
			verifyOnly = false): Promise<string[]> => {
			const names: string[] = [];
			for (const [index, bounded] of progress.boundedRuns.entries()) {
				if (!bounded.selectionProofGap) continue;
				if (!context) throw new Error("missing-selection-proof evidence requires the original host context");
				await verifyMissingSelectionProof({ ctx: context,
					controller: createM07Controller(context), contract: progress.contract, bounded });
				const name = `selection-proof-gap-${index + 1}.json`;
				await stageOrVerifyFrozen(path.join(root, "evidence", name),
					`${JSON.stringify(bounded.selectionProofGap, null, 2)}\n`, verifyOnly);
				names.push(name);
			}
			return names;
		};
		const stageCommittedKnowledge = async (verifyOnly = false): Promise<{ indexName: string;
			partNames: string[] } | undefined> => {
			if (!context) return undefined;
			const snapshot = await context.store.current();
			if (!snapshot) return undefined;
			const proposalId = snapshot.proposals[0];
			if (snapshot.proposals.length !== 1 || !/^P\d{4,}$/.test(proposalId ?? ""))
				throw new Error("published knowledge has no single committed proposal identity");
			const knowledgeDir = ws.knowledgeDir;
			const currentFile = path.join(knowledgeDir, "CURRENT");
			const limitsFile = path.join(knowledgeDir, "limits.json");
			const snapshotFile = path.join(knowledgeDir, "snapshots", `${snapshot.id}.json`);
			const limitsText = await safeText(limitsFile);
			const snapshotText = await safeText(snapshotFile);
			const resultText = await safeText(path.join(knowledgeDir, "proposals", `${proposalId}.result.json`));
			const intentText = await safeText(path.join(knowledgeDir, "proposals", `${proposalId}.intent.json`));
			const result = JSON.parse(resultText) as { proposalId?: string; snapshot?: unknown };
			const intent = JSON.parse(intentText) as { status?: string; proposalId?: string;
				proposal?: { stage?: string; runId?: string; session?: string }; baseSnapshotId?: string | null;
				result?: { snapshot?: unknown }; records?: KnowledgeRecord[] };
			const proposalText = await safeText(path.join(knowledgeDir, "proposals", `${proposalId}.json`));
			if ((await safeText(currentFile)).trim() !== snapshot.id ||
				!same(JSON.parse(snapshotText), snapshot) || result.proposalId !== proposalId ||
				intent.status !== "committed" || intent.proposalId !== proposalId ||
				!same(JSON.parse(proposalText), intent.proposal) || !same(result.snapshot, snapshot) ||
				!same(intent.result?.snapshot, snapshot) || !Array.isArray(intent.records))
				throw new Error("published knowledge snapshot differs from its committed merge");
			if (intent.baseSnapshotId !== null &&
				(typeof intent.baseSnapshotId !== "string" || !/^G\d{3,}$/.test(intent.baseSnapshotId)))
				throw new Error("committed knowledge base snapshot identity is invalid");
			const base = intent.baseSnapshotId === null ? undefined :
				JSON.parse(await safeText(path.join(knowledgeDir, "snapshots",
					`${intent.baseSnapshotId}.json`))) as Snapshot;
			if (base && base.id !== intent.baseSnapshotId)
				throw new Error("committed knowledge base snapshot identity is invalid");
			const changed = intent.records;
			const ids: string[] = [];
			const sourceHashes: Array<{ id: string; version: number; sha256: string }> = [];
			const versions = new Map((base?.records ?? []).map(row => [row.id, row.version]));
			const finalVersions = new Map(snapshot.records.map(row => [row.id, row.version]));
			if (versions.size !== (base?.records.length ?? 0) ||
				finalVersions.size !== snapshot.records.length ||
				(base?.records ?? []).some(row => !finalVersions.has(row.id)))
				throw new Error("committed knowledge final snapshot identity is invalid");
			for (const item of changed) {
				const previous = versions.get(item.id) ?? 0;
				if (!/^[CKEJQDX]\d{3,}$/.test(item.id) || !Number.isSafeInteger(item.version) ||
					item.version !== previous + 1 || ids.includes(`${item.id}@${item.version}`) ||
					item.supersedes !== (previous ? `${item.id}@${previous}` : undefined) ||
					item.source?.stage !== intent.proposal?.stage ||
					item.source?.runId !== intent.proposal?.runId ||
					item.source?.session !== intent.proposal?.session)
					throw new Error("committed knowledge record identity is invalid");
				versions.set(item.id, item.version);
				const stored = await context.store.get(item.id, item.version);
				if (!stored || [...new Set([...Object.keys(item), ...Object.keys(stored)])].some(key =>
					JSON.stringify((item as unknown as Record<string, unknown>)[key]) !==
					JSON.stringify((stored as unknown as Record<string, unknown>)[key])))
					throw new Error("published knowledge record differs from committed M04 bytes");
				const source = await safeText(path.join(knowledgeDir, "records", item.id,
					`v${item.version}.md`));
				if (source !== serialiseRecord(item))
					throw new Error("published knowledge record bytes differ from committed M04 intent");
				ids.push(`${item.id}@${item.version}`);
				sourceHashes.push({ id: item.id, version: item.version,
					sha256: sha256(Buffer.from(source)) });
			}
			if (versions.size !== finalVersions.size ||
				[...versions].some(([id, version]) => finalVersions.get(id) !== version))
				throw new Error("committed knowledge final snapshot differs from revision history");
			const pack = await context.store.buildPack({ ids, includeOpenQuestions: false,
				purpose: "Newly committed knowledge for original-objective reassessment" });
			if (pack.snapshot !== snapshot.id || pack.truncated || pack.omitted.length ||
				!same(pack.included.map(item => `${item.id}@${item.version}`).sort(), [...ids].sort()))
				throw new Error("committed knowledge pack omitted a published record");
			const prefix = `published-knowledge-${snapshot.id}-${sha256(Buffer.from(snapshotText)).slice(0, 16)}`;
			const partNames: string[] = [];
			const parts = textParts(pack.markdown);
			for (const [index, part] of parts.entries()) {
				const name = `${prefix}-pack-${index + 1}.txt`;
				await stageOrVerifyFrozen(path.join(root, "evidence", name), part, verifyOnly);
				partNames.push(name);
			}
			const indexName = `${prefix}-index.json`;
			await stageOrVerifyFrozen(path.join(root, "evidence", indexName), `${JSON.stringify({
				version: 1, kind: "committed-knowledge-handoff", snapshotId: snapshot.id,
				originStage: intent.proposal?.stage, proposalId,
				snapshotSha256: sha256(Buffer.from(snapshotText)),
				limitsSha256: sha256(Buffer.from(limitsText)),
				resultSha256: sha256(Buffer.from(resultText)),
				intentSha256: sha256(Buffer.from(intentText)), records: sourceHashes,
				packSha256: sha256(Buffer.from(pack.markdown)),
				parts: parts.map((part, index) => ({ name: partNames[index],
					sha256: sha256(Buffer.from(part)), bytes: Buffer.byteLength(part) })) }, null, 2)}\n`, verifyOnly);
			if ((await safeText(currentFile)).trim() !== snapshot.id ||
				await safeText(limitsFile) !== limitsText ||
				await safeText(snapshotFile) !== snapshotText ||
				await safeText(path.join(knowledgeDir, "proposals", `${proposalId}.result.json`)) !== resultText ||
				await safeText(path.join(knowledgeDir, "proposals", `${proposalId}.intent.json`)) !== intentText)
				throw new Error("published knowledge changed during assessor freeze");
			for (const item of sourceHashes) if (sha256(Buffer.from(await safeText(path.join(
				knowledgeDir, "records", item.id, `v${item.version}.md`)))) !== item.sha256)
				throw new Error("published knowledge record changed during assessor freeze");
			return { indexName, partNames };
		};
		const publishedAndProofEvidence = async (progress: ObjectiveProgressV1,
			verifyOnly = false): Promise<{ committedKnowledge: Awaited<ReturnType<typeof stageCommittedKnowledge>>;
			selectionProofGapNames: string[]; files: Array<{ name: string; file: string }> }> => {
			const committedKnowledge = await stageCommittedKnowledge(verifyOnly);
			const selectionProofGapNames = await stageMissingProofGaps(progress, verifyOnly);
			const names = [...(committedKnowledge ? [committedKnowledge.indexName,
				...committedKnowledge.partNames] : []), ...selectionProofGapNames];
			return { committedKnowledge, selectionProofGapNames,
				files: names.map(name => ({ name, file: path.join(root, "evidence", name) })) };
		};
		const unrepresentedM07 = async (progress: ObjectiveProgressV1): Promise<string[]> => {
			const runIds = await ws.listRuns("M07");
			const missing: string[] = [];
			for (const runId of runIds) {
				const goal = JSON.parse(await safeText(path.join(ws.runDir("M07", runId), "goal.json"))) as
					{ problemRelation?: string };
				if (goal.problemRelation?.startsWith(`${LOCAL_M07_MISSION_BINDING_PREFIX}${missionId}\n`) &&
					!progress.boundedRuns.some(item => item.runId === runId)) missing.push(runId);
			}
			return missing;
		};
		const recoverUnissuedAssessment: NonNullable<LocalObjectiveHostPort["recoverUnissuedAssessment"]> =
			async ({ contract, progress }) => {
				const intentId = progress.continuation.pendingAction?.target?.goalRunId ??
					progress.continuation.unresolvedOperationIds[0];
				if (progress.stopReason !== "execution-interrupted" ||
					progress.objectiveOutcome !== "incomplete" || !intentId || !safeId.test(intentId) ||
					!same(progress.continuation.unresolvedOperationIds, [intentId]) ||
					progress.continuation.pendingAction?.kind !== "reconcile-interrupted-run" ||
					progress.continuation.pendingAction.safety !== "no-replay-until-reconciled" ||
					progress.continuation.pendingAction.target?.goalRunId !== intentId ||
					!progress.assessment?.nextTask || progress.assessment.decision !== "continue" ||
					progress.assessment.unreadEvidence.length ||
					![LOCAL_M07_REASON_SCOPE, LOCAL_M07_EXECUTE_SCOPE].includes(
						progress.assessment.nextTask.adapterScope)) return undefined;
				if (activeNoIssuedResumes.has(root)) return { busy: true };
				activeNoIssuedResumes.add(root);
				let reserved = false;
				try {
				const status = await LocalMissionHost.status(root);
				if (status.repairRequired || status.writerLockPresent || status.preparedReviewPending ||
					status.evaluatorRecoveryClaim || status.unresolvedOperationIds.length ||
					status.final !== "none" || !status.contractReceipt ||
					status.latestCheckpoint?.sha256 !== sha256(checkpointBytes(progress))) return undefined;
				const receipts = status.checkpointReceipts;
				const checkpoints = await Promise.all(receipts.map(async row =>
					parseProgress(await LocalMissionHost.readCommittedCheckpoint(root, row.sequence), missionId)));
				const assessment = progress.assessment;
				const sameScientific = (candidate: ObjectiveProgressV1): boolean =>
					same(candidate.contract, contract) && same(candidate.assessment, assessment) &&
					same(candidate.assessmentHistory, progress.assessmentHistory) &&
					same(candidate.boundedRuns, progress.boundedRuns) &&
					same(candidate.selectedArtifacts, progress.selectedArtifacts) &&
					same(candidate.availableArtifacts, progress.availableArtifacts);
				const originCandidates: number[] = [];
				for (let index = 0; index + 1 < checkpoints.length; index++) {
					const before = checkpoints[index], after = checkpoints[index + 1];
					if (before?.stopReason === "assessment-validation-pending" &&
						after?.stopReason === "execution-interrupted" && sameScientific(before) &&
						sameScientific(after) && same(after.continuation.unresolvedOperationIds, [intentId]) &&
						after.continuation.pendingAction?.target?.goalRunId === intentId)
						originCandidates.push(index);
				}
				if (originCandidates.length !== 1) return undefined;
				const origin = originCandidates[0]!;
				if (!progress.assessmentHistory.length ||
					!same(progress.assessmentHistory.at(-1)?.assessment, assessment) ||
					progress.assessmentHistory.at(-1)?.advanced !== false ||
					checkpoints.slice(origin + 1).some(candidate => !candidate || !sameScientific(candidate) ||
						candidate.stopReason !== "execution-interrupted" ||
						!same(candidate.continuation.unresolvedOperationIds, [intentId]) ||
						candidate.continuation.pendingAction?.kind !== "reconcile-interrupted-run" ||
						candidate.continuation.pendingAction.safety !== "no-replay-until-reconciled" ||
						candidate.continuation.pendingAction.target?.goalRunId !== intentId))
					return undefined;
				const firstIntent = receipts[origin + 1]!;
				const currentProcess = await readCurrentProcessIdentity();
				if (!same(firstIntent.source.process, currentProcess)) {
					const death = await probeProcessIdentity(firstIntent.source.process);
					if (death.status !== "dead" || death.identityMatch ||
						firstIntent.source.process.hostId !== currentProcess.hostId ||
						firstIntent.source.process.bootId !== currentProcess.bootId) return undefined;
				}
				const mission = await ws.readRun("MISSION", intentId).catch(() => undefined);
				if (!mission || mission.status !== "failed" || mission.runId !== intentId ||
					!mission.inputs.some(item => item.path === contractFile)) return undefined;
				const missionStarted = Date.parse(mission.startedAt);
				if (!Number.isFinite(missionStarted)) return undefined;
				// A later M04 could change what the saved scientific assessment should
				// have considered. Its task must then wait for fresh reconciliation.
				const m04RunIds = await ws.listRuns("M04");
				const m04Entries = await readdir(path.join(ws.stagesDir, "M04")).catch(error => {
					if ((error as NodeJS.ErrnoException).code === "ENOENT") return [] as string[];
					throw error;
				});
				if (!same([...m04Entries].sort(), [...m04RunIds].sort())) return undefined;
				for (const runId of m04RunIds) {
					const run = await ws.readRun("M04", runId);
					const started = Date.parse(run.startedAt), finished = Date.parse(run.finishedAt ?? "");
					if (!Number.isFinite(started) || started >= missionStarted ||
						!["completed", "failed"].includes(run.status) ||
						!Number.isFinite(finished) || finished >= missionStarted) return undefined;
				}
				if (!context) return undefined;
				const m04BaselineIdentity = await captureM04BaselineIdentity(context);
				const published = (await context.store.current())?.id;
				const latestM04 = await ws.latestRun("M04");
				if ((published ?? null) !== m04BaselineIdentity.knowledgeSnapshot ||
					(latestM04?.status === "failed" &&
						(latestM04.knowledgeSnapshot ?? null) !== m04BaselineIdentity.knowledgeSnapshot) ||
					(!latestM04 && published !== undefined)) return undefined;
				const session = mission.sessions.filter(row => row.id === assessment.sessionId &&
					row.model === assessment.model);
				if (session.length !== 1 || session[0]!.role !== "research" ||
					session[0]!.boundary?.mode !== "fresh" ||
					session[0]!.boundary.intent !== "independent-judgment" ||
					session[0]!.boundary.toolGrantKind !== "read-dir" ||
					session[0]!.boundary.capability?.kind !== "read-dir" ||
					!session[0]!.boundary.capability.toolNames?.includes("objective_evidence_read") ||
					!session[0]!.boundary.capability.toolNames?.includes("material_list"))
					return undefined;
				// The built-in adapter creates its M07 run before delegate can open a
				// provider session. Any orphan or mission-bound run defeats no-issue proof.
				for (const stage of ["MISSION", "M07"] as const) {
					const directory = path.join(ws.stagesDir, stage);
					let entries: string[];
					try { entries = await readdir(directory); }
					catch (error) {
						if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
						entries = [];
					}
					const committed = await ws.listRuns(stage);
					if (!same([...entries].sort(), [...committed].sort())) return undefined;
					for (const runId of committed) {
						const run = await ws.readRun(stage, runId);
						if (stage === "MISSION") {
							if (runId !== intentId && run.status !== "completed" &&
								run.inputs.some(item => item.path === contractFile) &&
								!receipts.some(row => row.interruptedReview?.intentId === runId ||
									row.legacyInterruptedReview?.intentId === runId ||
									row.evaluatorRecoveryReview?.intentId === runId ||
									row.coldMigrationReview?.intentId === runId)) return undefined;
						} else {
							const goal = JSON.parse(await safeText(path.join(ws.runDir("M07", runId),
								"goal.json"))) as { problemRelation?: string };
							if (goal.problemRelation?.startsWith(`${LOCAL_M07_MISSION_BINDING_PREFIX}${missionId}\n`) &&
								!progress.boundedRuns.some(item => item.runId === runId)) return undefined;
						}
					}
				}
				if ((await unrepresentedM07(progress)).length) return undefined;
				for (const file of [missionLineageFile(root, intentId),
					missionLineageCommitFile(root, intentId)]) {
					try { await lstat(file); return undefined; }
					catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
				}
				// The original read-only assessor's exact frozen copies are the only
				// task evidence authorized by this retained judgment.
				const boundary = session[0]!.boundary;
				const evidenceRoot = boundary.capability?.root;
				const assessmentBase = path.join(root, "assessments");
				if (!evidenceRoot || path.dirname(evidenceRoot) !== assessmentBase ||
					await realpath(evidenceRoot) !== evidenceRoot ||
					!boundary.evidence.length) return undefined;
				const stored = await LocalMissionHost.readInitialContract(root);
				if (!stored) return undefined;
				const storedValue = JSON.parse(stored.toString("utf8")) as
					OriginalObjectiveContractV1 & { frozenInputs?: Array<{ name: string;
						bytes: number; sha256: string }>; materialManifestSha256?: string };
				if (!same(Object.fromEntries(Object.entries(storedValue)
					.filter(([key]) => key !== "frozenInputs" && key !== "materialManifestSha256")), contract) ||
					!Array.isArray(storedValue.frozenInputs) ||
					await safeText(contractFile) !== `${JSON.stringify(contract, null, 2)}\n`)
					return undefined;
				const currentOriginals = new Map<string, string>();
				const requiredRetained = new Set<string>();
				for (const item of storedValue.frozenInputs) {
					const file = path.join(root, "evidence", item.name);
					const text = await safeText(file);
					if (Buffer.byteLength(text) !== item.bytes || sha256(Buffer.from(text)) !== item.sha256)
						return undefined;
					currentOriginals.set(item.name, file);
					requiredRetained.add(item.name);
				}
				const originalIdentities: Array<{ name: string; bytes: number; sha256: string;
					sourceIdentity?: string }> = [...storedValue.frozenInputs];
				if (storedValue.materialManifestSha256) {
					const materialRoot = path.join(root, "materials");
					if (sha256(await readFile(path.join(materialRoot, "manifest.json"))) !==
						storedValue.materialManifestSha256) return undefined;
					const manifest = await readLocalMaterialBundle(materialRoot);
					originalIdentities.push(...manifest.items.map(item => ({
						name: `material-${item.id}`, bytes: item.bytes, sha256: item.sha256,
						sourceIdentity: item.sourceIdentity })));
				for (const [index, relative] of manifest.indexFiles.entries()) {
						currentOriginals.set(`material-index-${index + 1}.md`,
							path.join(materialRoot, relative));
					requiredRetained.add(`material-index-${index + 1}.md`);
				}
					for (const item of manifest.items) if (item.text)
					for (const [index, part] of item.parts.entries()) {
							currentOriginals.set(`${item.id}-part-${index + 1}.txt`,
								path.join(materialRoot, part.file));
						requiredRetained.add(`${item.id}-part-${index + 1}.txt`);
					}
				}
				const boundedRunEvidence = await stageBoundedEvidence(progress);
				for (const name of Object.values(boundedRunEvidence).flat())
					currentOriginals.set(name, path.join(root, "evidence", name));
				const latestBounded = progress.boundedRuns.at(-1);
				let needsRepairReading = false;
				if (latestBounded) {
					const goal = JSON.parse(await safeText(path.join(ws.runDir("M07",
						latestBounded.runId), "goal.json"))) as CurrentGoal;
					needsRepairReading = goal.tasks.some(task =>
						task.status === "rejected" || task.status === "failed");
					if (needsRepairReading) for (const name of boundedRunEvidence[latestBounded.runId] ?? [])
						requiredRetained.add(name);
				}
				const additional = await publishedAndProofEvidence(progress);
				const committedKnowledge = additional.committedKnowledge;
				for (const { name, file } of additional.files)
					currentOriginals.set(name, file);
				if (committedKnowledge) for (const name of [committedKnowledge.indexName,
					...committedKnowledge.partNames]) {
					if (name === committedKnowledge.indexName || needsRepairReading)
						requiredRetained.add(name);
				}
				for (const name of additional.selectionProofGapNames) {
					requiredRetained.add(name);
				}
				const selectedReview = progress.selectedArtifacts.length && context ?
					await recoverDefaultSelectionReview({ ctx: context,
						controller: createM07Controller(context), contract, progress, root }) : undefined;
				if (progress.selectedArtifacts.length && !selectedReview) return undefined;
				if (selectedReview && context)
					for (const item of defaultSelectionEvidenceFiles(context, selectedReview, root)) {
						currentOriginals.set(item.name, item.file);
						requiredRetained.add(item.name);
					}
				const oldEvidence: LocalObjectiveFrozenEvidence["evidence"] = [];
				const oldEvidenceIdentity: Array<{ name: string; sha256: string }> = [];
				const seen = new Set<string>();
				for (const item of boundary.evidence) {
					const name = path.basename(item.path);
					if (item.version !== 1 || item.status !== "frozen-copy" ||
						item.sourceVersion !== missionId || path.dirname(item.path) !== evidenceRoot ||
						seen.has(name)) return undefined;
					seen.add(name);
					const hostNamed = /^(?:host-capability-[1-9][0-9]*(?:-[0-9a-f]{16})?\.txt|host-evaluator-task-input-[1-9][0-9]*-[0-9a-f]{16}\.json)$/.test(name);
					const source = name === "original-objective.json" ? contractFile :
						currentOriginals.get(name) ?? (hostNamed ? path.join(root, "evidence", name) : undefined);
					if (!source) return undefined;
					let sourceText: string;
					try { sourceText = await safeText(source); }
					catch { return undefined; }
					if (hostNamed && sha256(Buffer.from(sourceText)).slice(0, 16) !==
						name.match(/-([0-9a-f]{16})\.(?:txt|json)$/)?.[1]) return undefined;
					if (await safeText(item.path) !== sourceText) return undefined;
					oldEvidence.push({ name, file: item.path });
					oldEvidenceIdentity.push({ name, sha256: sha256(Buffer.from(sourceText)) });
				}
				if (!same((await readdir(evidenceRoot)).sort(), [...seen].sort()) ||
					!seen.has("original-objective.json") ||
					!assessment.evidenceRead.includes("original-objective.json") ||
					[...requiredRetained]
						.some(name => !seen.has(name) || !assessment.evidenceRead.includes(name)) ||
					assessment.evidenceRead.some(name => !seen.has(name))) return undefined;
				const hasModel = (role: "research" | "execution") =>
					Boolean(context?.config.roles[role] ?? context?.config.roles.default);
				const hostCapabilities = [
					{ scope: LOCAL_M07_REASON_SCOPE, available: hasModel("research") && hasModel("execution"),
						description: "Local M07 read-only reasoning with M04 review",
						limits: ["A returned report is unselected evidence"] },
					{ scope: LOCAL_M07_EXECUTE_SCOPE, available: hasModel("research") && hasModel("execution") &&
						context?.config.localMission?.execution === "task-root-bash",
						description: "Opt-in trusted local M07 execution with task-root Pi read/write/edit/bash tools",
						limits: ["Bash is not an OS sandbox and can access same-user files outside the task root; keep unrelated secrets outside this worker environment", "External effects require authorization and host reconciliation"] },
				];
				const evaluator = await requireLocalEvaluator(contract,
					context?.config.localMission?.evaluatorId, {
						frozenOriginalInputs: originalIdentities, capabilities: hostCapabilities }).catch(() => undefined);
				if (!evaluator || !hostCapabilities.some(item =>
					item.scope === assessment.nextTask!.adapterScope && item.available)) return undefined;
				const assessedIteration = progress.assessmentHistory.at(-1)!.iteration;
				const oldTaskContract = oldEvidence.filter(item =>
					item.name.startsWith(`host-evaluator-task-input-${assessedIteration}-`));
				if (needsRepairReading && oldTaskContract.some(item =>
						!assessment.evidenceRead.includes(item.name))) return undefined;
				const declared = validatedTaskInputContract(evaluator.taskInputContract);
				let evaluatorTaskInputContract: LocalObjectiveFrozenEvidence["evaluatorTaskInputContract"];
				if (declared) {
					const expectedBinding = {
						missionId, evaluatorId: evaluator.id, evaluatorVersion: evaluator.version,
						sourceIdentitySha256: sha256(Buffer.from(JSON.stringify(originalIdentities))),
						contractSha256: sha256(Buffer.from(JSON.stringify(declared))) };
					const matches = await Promise.all(oldTaskContract.map(async item => {
						const text = await safeText(item.file);
						const value = JSON.parse(text) as { binding?: typeof expectedBinding; contract?: unknown };
						return same(value.binding, expectedBinding) && same(value.contract, declared) ?
							{ name: item.name, sha256: sha256(Buffer.from(text)), evaluatorId: evaluator.id,
								evaluatorVersion: evaluator.version,
								sourceIdentitySha256: expectedBinding.sourceIdentitySha256,
								contractSha256: expectedBinding.contractSha256 } : undefined;
					}));
					if (matches.filter(Boolean).length !== 1) return undefined;
					evaluatorTaskInputContract = matches.find(Boolean);
				}
				const capabilities: LocalObjectiveFrozenEvidence["capabilities"] = [
					{ scope: "local-mission-evaluator", available: true,
						description: `Trusted host evaluator ${evaluator.id}`,
						limits: ["Evaluator results are observations until M07 review, M04 reads and host selection",
							...(evaluatorTaskInputContract ? [`Read ${evaluatorTaskInputContract.name} for the exact host-declared task input shape before proposing or executing work.`] : [])] },
					...hostCapabilities ];
				const assessedCapabilities = oldEvidence.filter(item =>
					item.name.startsWith(`host-capability-${assessedIteration}-`));
				if (assessedCapabilities.length !== 1 ||
					await safeText(assessedCapabilities[0]!.file) !== `${JSON.stringify(capabilities)}\n`)
					return undefined;
				const originalProblem = storedValue.frozenInputs.find(item =>
					item.name === "original-problem.txt");
				if (!originalProblem) return undefined;
				const rawIdentities: Array<{ name: string; sha256: string }> = [];
				if (!storedValue.materialManifestSha256) {
					if (storedValue.frozenInputs.length !== contract.inputNames.length) return undefined;
					for (let index = 1; index < storedValue.frozenInputs.length; index++) {
						const original = storedValue.frozenInputs[index]!;
						if (original.name !== `original-input-${index}.txt` ||
							!contract.inputNames[index]) return undefined;
						rawIdentities.push({ name: contract.inputNames[index]!, sha256: original.sha256 });
					}
				} else if (storedValue.frozenInputs.length !== 1) return undefined;
				const host = await writable();
				const latest = (await host.status()).latestCheckpoint;
				if (!latest || latest.sha256 !== sha256(checkpointBytes(progress))) return undefined;
				if (!same(latest.source, host.source))
					await host.recordCheckpoint({ attemptId: host.source.attemptId,
						sequence: latest.sequence + 1, previousSha256: latest.sha256,
						bytes: checkpointBytes(progress) });
				reserved = true;
				return { intentId, task: assessment.nextTask!, release: () => {
					activeNoIssuedResumes.delete(root); }, frozen: {
					contractFile, evidenceRoot, evidence: oldEvidence,
					checkpointRawScope: storedValue.materialManifestSha256 ? "none" : "workspace",
					frozenOriginalInputs: originalIdentities, capabilities,
					retainedInputIdentity: { problemSha256: originalProblem.sha256,
						knowledgeSnapshot: m04BaselineIdentity.knowledgeSnapshot,
						m04BaselineIdentity,
						rawAuthority: storedValue.materialManifestSha256 ? "declared-materials" : "original-raw",
						raw: rawIdentities, evidence: oldEvidenceIdentity },
					selectedArtifacts: [...progress.selectedArtifacts],
					...(selectedReview ? { selectionReview: selectedReview } : {}),
					...(evaluatorTaskInputContract ? { evaluatorTaskInputContract } : {}),
					availableArtifacts: [...progress.availableArtifacts],
					unresolvedOperationIds: [], boundedRunEvidence } };
				} finally { if (!reserved) activeNoIssuedResumes.delete(root); }
			};
		return {
			recoverUnissuedAssessment,
			async recoverInterruptedEvaluator({ ctx, controller, contract, progress }) {
				// A prior V4 writer can die after atomic publication but before lock
				// cleanup. The committed review itself supplies the only lock key.
				let status = await LocalMissionHost.status(root);
				const latestReview = status.latestCheckpoint?.evaluatorRecoveryReview;
				if (status.writerLockPresent && latestReview && status.latestCheckpoint &&
					sha256(checkpointBytes(progress)) === status.latestCheckpoint.sha256) {
					await LocalMissionHost.recoverReviewLock({ root,
						intentId: latestReview.intentId,
						oldCheckpointSha256: latestReview.oldCheckpoint.sha256 });
					return undefined;
				}
				// This is a transport recovery of exactly one old dispatch. The old
				// assessment remains evidence, never a fresh dispatch instruction.
				const originalIntent = progress.continuation.pendingAction?.target?.goalRunId;
				if (progress.stopReason !== "execution-interrupted" ||
					progress.continuation.pendingAction?.kind !== "reconcile-interrupted-run" ||
					progress.continuation.pendingAction.safety !== "no-replay-until-reconciled" ||
					!progress.assessment?.nextTask ||
					progress.objectiveOutcome !== "incomplete") return undefined;
				const missionRuns = await ws.listRuns("MISSION");
				const possibleIntents = progress.continuation.unresolvedOperationIds.filter(id =>
					missionRuns.includes(id));
				if (possibleIntents.length !== 1 ||
					(originalIntent && originalIntent !== possibleIntents[0])) return undefined;
				const intentId = possibleIntents[0]!;
				if (!safeId.test(intentId)) return undefined;
				if (status.writerLockPresent && status.latestCheckpoint &&
					sha256(checkpointBytes(progress)) === status.latestCheckpoint.sha256) {
					await LocalMissionHost.recoverReviewLock({ root, intentId,
						oldCheckpointSha256: status.latestCheckpoint.sha256 });
					status = await LocalMissionHost.status(root);
				}
				const oldCheckpoint = status.latestCheckpoint;
				if (status.repairRequired || status.writerLockPresent || status.preparedReviewPending ||
					status.unresolvedOperationIds.length || status.final !== "none" || !oldCheckpoint ||
					!same(status.currentAttempt, oldCheckpoint.source) ||
					sha256(checkpointBytes(progress)) !== oldCheckpoint.sha256 ||
					status.checkpointReceipts.some(item => item.evaluatorRecoveryReview?.intentId === intentId ||
						item.interruptedReview?.intentId === intentId ||
						item.legacyInterruptedReview?.intentId === intentId ||
						item.coldMigrationReview?.intentId === intentId)) return undefined;
				const currentProcess = await readCurrentProcessIdentity();
				const oldProcess = oldCheckpoint.source.process;
				const death = await probeProcessIdentity(oldProcess);
				if (death.status !== "dead" || death.identityMatch ||
					oldProcess.hostId !== currentProcess.hostId ||
					oldProcess.bootId !== currentProcess.bootId) return undefined;
				const unrepresented = await unrepresentedM07(progress);
				if (unrepresented.length !== 1 || !safeId.test(unrepresented[0]!)) return undefined;
				const runId = unrepresented[0]!;
				const refs = progress.continuation.unresolvedOperationIds;
				if (!(same(refs, [intentId]) || same(refs, [intentId, runId].sort()))) return undefined;
				const reviews = new Set(status.checkpointReceipts.flatMap(item =>
					[item.interruptedReview?.intentId, item.legacyInterruptedReview?.intentId,
						item.evaluatorRecoveryReview?.intentId,
						item.coldMigrationReview?.intentId].filter((id): id is string => !!id)));
				for (const id of missionRuns) {
					if (id === intentId || reviews.has(id)) continue;
					const candidate = await ws.readRun("MISSION", id);
					if (candidate.status === "running" &&
						candidate.inputs.some(item => item.path === contractFile)) return undefined;
				}
				const mission = await ws.readRun("MISSION", intentId);
				if (mission.status === "completed" || !mission.inputs.some(item => item.path === contractFile))
					return undefined;
				const m07Dir = ws.runDir("M07", runId);
				let link;
				try { link = await readLocalDispatchLineage({ missionRoot: root, m07Dir, intentId }); }
				catch (error) {
					if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
					throw error;
				}
				const { lineage } = link;
				if (lineage.missionId !== missionId || lineage.m07RunId !== runId ||
					!safeId.test(lineage.taskId) ||
					lineage.assessorTaskSha256 !== assessorTaskHash(progress.assessment.nextTask) ||
					!same(lineage.m07Owner, lineage.oldAttempt.process) ||
					lineage.oldAttempt.missionId !== missionId ||
					lineage.oldAttempt.process.hostId !== currentProcess.hostId ||
					lineage.oldAttempt.process.bootId !== currentProcess.bootId) return undefined;
				const originDeath = await probeProcessIdentity(lineage.oldAttempt.process);
				if (originDeath.status !== "dead" || originDeath.identityMatch) return undefined;
				const intentCheckpoint = status.checkpointReceipts.find(item =>
					item.sequence === lineage.intentCheckpoint.sequence &&
					item.sha256 === lineage.intentCheckpoint.sha256 &&
					same(item.source, lineage.oldAttempt));
				if (!intentCheckpoint || intentCheckpoint.sequence > oldCheckpoint.sequence ||
					attemptNumber(lineage.oldAttempt.attemptId) >
						attemptNumber(oldCheckpoint.source.attemptId)) return undefined;
				const goal = await controller.status(runId);
				const task = goal.tasks.find(item => item.taskId === lineage.taskId);
				const operation = goal.executionState?.operations.find(item => item.taskId === lineage.taskId);
				if (goal.runId !== runId || goal.goal !== progress.assessment.nextTask.objective ||
					goal.problemRelation !== `${LOCAL_M07_MISSION_BINDING_PREFIX}${missionId}\n${contract.goal}` ||
					goal.tasks.length !== 1 || goal.executionState?.operations.length !== 1 ||
					!task || !["returned", "accepted", "rejected"].includes(task.status) ||
					!task.reportPath || !operation ||
					!["response-received", "confirmed", "partial-settled", "not-issued"].includes(operation.status) ||
					lineage.m07TaskInputsSha256 !== localLineageHash(JSON.stringify(task.inputs)) ||
					lineage.m07TaskChecksSha256 !== localLineageHash(JSON.stringify(task.checks)) ||
					!goal.executionState.attempts.some(item => same(item.runDescriptor.process,
						lineage.oldAttempt.process))) return undefined;
				const evaluatorId = ctx.config.localMission?.evaluatorId;
				const evaluator = trustedLocalMissionEvaluator(evaluatorId);
				if (!evaluator) return undefined;
				if (activeRecoveryClaims.has(root)) return progress;
				activeRecoveryClaims.add(root);
				try {
					const claim = await LocalMissionHost.claimEvaluatorRecovery({ root, missionId,
						intentId, oldCheckpointSequence: oldCheckpoint.sequence,
						oldCheckpointSha256: oldCheckpoint.sha256 });
					if (claim.state === "held-by-live-owner") return progress;
					const claimedStatus = await LocalMissionHost.status(root);
					if (claimedStatus.repairRequired || claimedStatus.writerLockPresent ||
						claimedStatus.latestCheckpoint?.sequence !== oldCheckpoint.sequence ||
						claimedStatus.latestCheckpoint.sha256 !== oldCheckpoint.sha256 ||
						!same(claimedStatus.currentAttempt, status.currentAttempt))
						throw new HarnessError("local.mission.recovery", "mission checkpoint changed after recovery claim");
					// Recover the original assessor's exact read-only input set. A
					// returned task never authorizes a fresh assessor judgment.
					const assessor = mission.sessions.filter(row =>
						row.id === progress.assessment!.sessionId &&
						row.model === progress.assessment!.model);
					const boundary = assessor[0]?.boundary;
					const evidenceRoot = boundary?.capability?.root;
					if (assessor.length !== 1 || assessor[0]!.role !== "research" ||
						boundary?.mode !== "fresh" || boundary.intent !== "independent-judgment" ||
						boundary.toolGrantKind !== "read-dir" || boundary.capability?.kind !== "read-dir" ||
						!boundary.capability.toolNames?.includes("objective_evidence_read") ||
						!boundary.capability.toolNames?.includes("material_list") ||
						!evidenceRoot || path.dirname(evidenceRoot) !== path.join(root, "assessments") ||
						await realpath(evidenceRoot) !== evidenceRoot || !boundary.evidence.length)
						throw new HarnessError("local.mission.recovery", "original assessor boundary is unproven");
					const initial = await LocalMissionHost.readInitialContract(root);
					if (!initial) throw new HarnessError("local.mission.recovery", "original contract is missing");
					const stored = JSON.parse(initial.toString("utf8")) as OriginalObjectiveContractV1 & {
						frozenInputs?: Array<{ name: string; bytes: number; sha256: string }>;
						materialManifestSha256?: string };
					if (!same(Object.fromEntries(Object.entries(stored).filter(([key]) =>
						key !== "frozenInputs" && key !== "materialManifestSha256")), contract) ||
						!Array.isArray(stored.frozenInputs) ||
						await safeText(contractFile) !== `${JSON.stringify(contract, null, 2)}\n`)
						throw new HarnessError("local.mission.recovery", "original contract identity changed");
					const sources = new Map<string, string>([["original-objective.json", contractFile]]);
					const required = new Set<string>();
					for (const item of stored.frozenInputs) {
						const file = path.join(root, "evidence", item.name);
						const bytes = Buffer.from(await safeText(file));
						if (bytes.length !== item.bytes || sha256(bytes) !== item.sha256)
							throw new HarnessError("local.mission.recovery", "original input identity changed");
						sources.set(item.name, file); required.add(item.name);
					}
					const originalIdentities: Array<{ name: string; bytes: number; sha256: string;
						sourceIdentity?: string }> = [...stored.frozenInputs];
					if (stored.materialManifestSha256) {
						const materialRoot = path.join(root, "materials");
						if (sha256(await readFile(path.join(materialRoot, "manifest.json"))) !==
							stored.materialManifestSha256)
							throw new HarnessError("local.mission.recovery", "material manifest identity changed");
						const manifest = await readLocalMaterialBundle(materialRoot);
						originalIdentities.push(...manifest.items.map(item => ({ name: `material-${item.id}`,
							bytes: item.bytes, sha256: item.sha256, sourceIdentity: item.sourceIdentity })));
						for (const [index, relative] of manifest.indexFiles.entries()) {
							const name = `material-index-${index + 1}.md`;
							sources.set(name, path.join(materialRoot, relative)); required.add(name);
						}
						for (const item of manifest.items) if (item.text)
							for (const [index, part] of item.parts.entries()) {
								const name = `${item.id}-part-${index + 1}.txt`;
								sources.set(name, path.join(materialRoot, part.file)); required.add(name);
							}
					}
					for (const names of Object.values(await stageBoundedEvidence(progress)))
						for (const name of names) sources.set(name, path.join(root, "evidence", name));
					for (const { name, file } of (await publishedAndProofEvidence(progress, true)).files)
						sources.set(name, file);
					if (progress.selectedArtifacts.length) {
						const selectedReview = await recoverDefaultSelectionReview({ ctx, controller,
							contract, progress, root });
						if (!selectedReview)
							throw new HarnessError("local.mission.recovery", "selected history is unproven");
						for (const item of defaultSelectionEvidenceFiles(ctx, selectedReview, root)) {
							sources.set(item.name, item.file); required.add(item.name);
						}
					}
					const frozenEvidence: Array<{ name: string; file: string }> = [];
					const sourceEvidence: Array<{ name: string; file: string }> = [];
					const seen = new Set<string>();
					for (const row of boundary.evidence) {
						const name = path.basename(row.path);
						const hostNamed = /^(?:host-capability-[1-9][0-9]*(?:-[0-9a-f]{16})?\.txt|host-evaluator-task-input-[1-9][0-9]*-[0-9a-f]{16}\.json)$/.test(name);
						const source = sources.get(name) ?? (hostNamed ? path.join(root, "evidence", name) : undefined);
						if (row.version !== 1 || row.status !== "frozen-copy" ||
							row.sourceVersion !== missionId || path.dirname(row.path) !== evidenceRoot ||
							seen.has(name) || !source || await safeText(row.path) !== await safeText(source))
							throw new HarnessError("local.mission.recovery", "assessor evidence source differs from frozen copy");
						if (hostNamed && sha256(Buffer.from(await safeText(source))).slice(0, 16) !==
							name.match(/-([0-9a-f]{16})\.(?:txt|json)$/)?.[1])
							throw new HarnessError("local.mission.recovery", "host evidence identity changed");
						seen.add(name); frozenEvidence.push({ name, file: row.path });
						sourceEvidence.push({ name, file: source });
					}
					if (!same((await readdir(evidenceRoot)).sort(), [...seen].sort()) ||
						!seen.has("original-objective.json") ||
						[...required].some(name => !seen.has(name) ||
							!progress.assessment!.evidenceRead.includes(name)) ||
						progress.assessment!.evidenceRead.some(name => !seen.has(name)))
						throw new HarnessError("local.mission.recovery", "assessor read set differs from frozen evidence");
					const raw = await ws.readRawInfo();
					const frozenRaw = stored.frozenInputs.filter(item => item.name !== "original-problem.txt");
					const exactRaw = !raw.skipped.length && raw.items.length === frozenRaw.length &&
						raw.items.every((item, index) => item.name === contract.inputNames[index + 1] &&
							sha256(Buffer.from(item.content)) === frozenRaw[index]?.sha256);
					const evidenceVariants = [frozenEvidence, sourceEvidence,
						frozenEvidence.filter(item => item.name !== "original-objective.json"),
						sourceEvidence.filter(item => item.name !== "original-objective.json")];
					const possibleInputs = evidenceVariants.flatMap(evidence => [
						{ evidence, inputs: [goal.problemSnapshotPath, ...evidence.map(item => item.file)] },
						...(exactRaw ? [{ evidence, inputs: [goal.problemSnapshotPath,
							...raw.items.map(item => item.path), ...evidence.map(item => item.file)] }] : []),
					]);
					const matchedInputs = possibleInputs.find(item => same(task.inputs, item.inputs));
					const expectedInputs = matchedInputs?.inputs;
					const recoveryEvidence = matchedInputs?.evidence;
					if (!expectedInputs || task.inputCopies.length !== expectedInputs.length ||
						sha256(await readFile(goal.problemSnapshotPath)) !==
							stored.frozenInputs.find(item => item.name === "original-problem.txt")?.sha256)
						throw new HarnessError("local.mission.recovery", "returned task input set differs from assessor evidence");
					for (const file of expectedInputs) {
						const source = await realpath(file);
						const copies = task.inputCopies.filter(item => item.source === source);
						if (copies.length !== 1 || await safeText(copies[0]!.copy) !== await safeText(source))
							throw new HarnessError("local.mission.recovery", "returned task input copy differs from assessor evidence");
					}
					const declared = validatedTaskInputContract(evaluator.taskInputContract);
					const iteration = progress.assessmentHistory.at(-1)?.iteration;
					const taskContracts = frozenEvidence.filter(item => item.name.startsWith(
						`host-evaluator-task-input-${iteration}-`));
					if (declared) {
						const binding = { missionId, evaluatorId: evaluator.id, evaluatorVersion: evaluator.version,
							sourceIdentitySha256: sha256(Buffer.from(JSON.stringify(originalIdentities))),
							contractSha256: sha256(Buffer.from(JSON.stringify(declared))) };
						if (taskContracts.length !== 1 || !same(JSON.parse(await safeText(taskContracts[0]!.file)),
							{ binding, contract: declared }))
							throw new HarnessError("local.mission.recovery", "evaluator task contract changed");
					} else if (taskContracts.length)
						throw new HarnessError("local.mission.recovery", "unexpected evaluator task contract");
					const model = (role: "research" | "execution") =>
						Boolean(ctx.config.roles[role] ?? ctx.config.roles.default);
					const hostCapabilities = [
						{ scope: LOCAL_M07_REASON_SCOPE, available: model("research") && model("execution"),
							description: "Local M07 read-only reasoning with M04 review",
							limits: ["A returned report is unselected evidence"] },
						{ scope: LOCAL_M07_EXECUTE_SCOPE, available: model("research") && model("execution") &&
								ctx.config.localMission?.execution === "task-root-bash",
							description: "Opt-in trusted local M07 execution with task-root Pi read/write/edit/bash tools",
							limits: ["Bash is not an OS sandbox and can access same-user files outside the task root; keep unrelated secrets outside this worker environment", "External effects require authorization and host reconciliation"] },
					];
					const capabilities = [
						{ scope: "local-mission-evaluator", available: true,
							description: `Trusted host evaluator ${evaluator.id}`,
							limits: ["Evaluator results are observations until M07 review, M04 reads and host selection",
								...(declared ? [`Read ${taskContracts[0]!.name} for the exact host-declared task input shape before proposing or executing work.`] : [])] },
						...hostCapabilities ];
					const capCopies = frozenEvidence.filter(item => item.name.startsWith(`host-capability-${iteration}-`));
					if (capCopies.length !== 1 || await safeText(capCopies[0]!.file) !== `${JSON.stringify(capabilities)}\n`)
						throw new HarnessError("local.mission.recovery", "assessed host capability changed");
					const admitted = await requireLocalEvaluator(contract, evaluatorId,
						{ frozenOriginalInputs: originalIdentities, capabilities: hostCapabilities });
					if (admitted.id !== evaluator.id || admitted.version !== evaluator.version)
						throw new HarnessError("local.mission.recovery", "trusted evaluator changed");
					const resumed = await recoverBoundLocalM07Task({ ctx, controller, runM04,
						contract, assessorTask: progress.assessment.nextTask, runId,
						taskId: lineage.taskId, expectedOwner: lineage.m07Owner,
						recoveryEvidence: recoveryEvidence!,
						frozenOriginalInputs: originalIdentities, capabilities: hostCapabilities,
						verifiedRecoveryOwners: [lineage.m07Owner,
							...claim.claim.predecessors.map(item => item.owner)] });
					if (resumed.state === "pending") return progress;
					const result = resumed.result;
					if (result.runId !== runId || result.checkpointId === undefined ||
						!safeId.test(result.checkpointId) || result.unresolvedOperationRefs?.length ||
						(result.m04RunId !== undefined && (!safeId.test(result.m04RunId) ||
							!Array.isArray(result.requiredM07ReadPaths) ||
							!result.requiredM07ReadPaths.length)) ||
						(resumed.evaluation.terminal === "pre-entry-unlocated" &&
							(result.m04RunId !== undefined || result.evaluatorReceiptPath !== undefined ||
								result.acceptedTaskIds.length !== 0)) ||
						result.selectedTaskId || result.evaluatorReceiptPath &&
							resumed.evaluation.terminal !== "returned")
						throw new HarnessError("local.mission.recovery", "recovered adapter returned mismatched bounded facts");
					const m07 = await controller.status(runId);
					const reviewedTask = m07.tasks.find(item => item.taskId === lineage.taskId);
					const reviewedOperation = m07.executionState?.operations.find(item => item.id === operation.id);
					const checkpoint = m07.checkpoints?.find(item => item.id === result.checkpointId);
					if (!reviewedTask || !reviewedOperation || !checkpoint ||
						m07.tasks.length !== 1 || m07.executionState?.operations.length !== 1 ||
						!["accepted", "rejected"].includes(reviewedTask.status) ||
						(resumed.evaluation.terminal !== "returned" && reviewedTask.status !== "rejected"))
						throw new HarnessError("local.mission.recovery", "recovered M07 task is not reviewed and settled");
					const accepted = reviewedTask.status === "accepted";
					if (!same(result.acceptedTaskIds, accepted ? [lineage.taskId] : []))
						throw new HarnessError("local.mission.recovery", "recovered M07 acceptance differs from review");
					const m07Root = ws.runDir("M07", runId);
					const cp = path.join(m07Root, "checkpoints", result.checkpointId);
					const fileHash = async (file: string) => sha256(await readFile(file));
					if (resumed.evaluation.id !== evaluator.id ||
						resumed.evaluation.version !== evaluator.version ||
						(resumed.evaluation.terminal === "returned" &&
							!resumed.evaluation.receiptSha256))
						throw new HarnessError("local.mission.recovery", "trusted evaluator identity or receipt changed");
					const review: LocalEvaluatorRecoveryReviewV1 = {
						version: 1, kind: "local-evaluator-interruption-host-review", missionId,
						intentId, missionRunSha256: await fileHash(path.join(ws.runDir("MISSION", intentId), "run.json")),
						lineageSha256: link.sha256, dispatchOriginAttempt: lineage.oldAttempt,
						recoveryClaim: { claimId: claim.claim.claimId, owner: claim.claim.owner,
							oldCheckpointSha256: claim.claim.oldCheckpoint.sha256,
							predecessors: claim.claim.predecessors },
						oldAttempt: oldCheckpoint.source,
						oldCheckpoint: { sequence: oldCheckpoint.sequence, sha256: oldCheckpoint.sha256 },
						newAttempt: { version: 1, missionId,
							attemptId: `A${String(attemptNumber(status.currentAttempt!.attemptId) + 1).padStart(3, "0")}`,
							predecessorAttemptId: status.currentAttempt!.attemptId,
							codeRevision: "local-harness-v1", process: currentProcess },
						m07: { runId, taskId: lineage.taskId, operationId: operation.id,
							checkpointId: result.checkpointId,
							goalSha256: await fileHash(path.join(m07Root, "goal.json")),
							snapshotSha256: await fileHash(path.join(cp, "goal.json")),
							manifestSha256: await fileHash(path.join(cp, "manifest.json")),
							feedbackSha256: await fileHash(path.join(cp, "m04-feedback.md")) },
					evaluator: resumed.evaluation.terminal === "pre-entry-unlocated" ?
						{ id: resumed.evaluation.id, version: resumed.evaluation.version,
							phase: "pre-entry-unlocated", orphanMembers: resumed.evaluation.orphanMembers } :
						{ id: resumed.evaluation.id, version: resumed.evaluation.version,
							owner: resumed.evaluation.owner,
							attemptId: resumed.evaluation.attemptId,
							preparedSha256: resumed.evaluation.preparedSha256,
							enteredSha256: resumed.evaluation.enteredSha256,
							phase: resumed.evaluation.terminal,
							phaseSha256: resumed.evaluation.terminalSha256,
							receiptSha256: resumed.evaluation.receiptSha256 ?? null },
						...(result.m04RunId ? { m04: { runId: result.m04RunId,
							runSha256: await fileHash(path.join(ws.runDir("M04", result.m04RunId), "run.json")),
							sourceSha256: await fileHash(path.join(ws.runDir("M04", result.m04RunId), "m07-source.json")),
							transactionSha256: await fileHash(path.join(ws.runDir("M04", result.m04RunId),
								"m04-transaction.json")),
							coverageSha256: await fileHash(path.join(ws.runDir("M04", result.m04RunId),
								"m07-coverage.json")),
							requiredM07ReadPaths: result.requiredM07ReadPaths ?? [] } } : {}),
						boundary: "fresh-work-only-no-builder-or-evaluator-replay" };
					const successor = objectiveProgress(contract, {
						boundedRuns: [...progress.boundedRuns, { runId, outcome: "partial",
							acceptedTaskIds: accepted ? [lineage.taskId] : [] }],
						selectedArtifacts: progress.selectedArtifacts,
						availableArtifacts: progress.availableArtifacts,
						assessment: progress.assessment, assessmentHistory: progress.assessmentHistory,
						stopReason: "objective-reassessment-pending", nextTaskDispatched: true,
						pendingActionFacts: {} });
					await LocalMissionHost.commitReviewedSuccessor({ root, missionId,
						bytes: checkpointBytes(successor), review, claim: claim.claim,
						verifyEvidence: async () => {
							const rechecked = await readLocalDispatchLineage({ missionRoot: root, m07Dir, intentId });
							if (rechecked.sha256 !== link.sha256)
								throw new Error("dispatch link changed before reviewed successor commit");
						} });
					return successor;
				} finally { activeRecoveryClaims.delete(root); }
			},
			async recordDispatchLineage({ intentId, m07RunId, taskId, assessorTask }) {
				const host = await writable();
				const status = await host.status();
				const checkpoint = status.latestCheckpoint;
				if (!checkpoint || checkpoint.source.attemptId !== host.source.attemptId ||
					status.repairRequired || status.unresolvedOperationIds.length)
					throw new Error("local mission dispatch has no exact current intent checkpoint");
				const progress = await parseProgress(await host.readCheckpoint(checkpoint.sequence), missionId);
				if (!progress || progress.stopReason !== "execution-interrupted" ||
					progress.continuation.pendingAction?.target?.goalRunId !== intentId ||
					JSON.stringify(progress.continuation.unresolvedOperationIds) !== JSON.stringify([intentId]) ||
					!progress.assessment?.nextTask ||
					assessorTaskHash(progress.assessment.nextTask) !== assessorTaskHash(assessorTask))
					throw new Error("local mission dispatch does not match the frozen assessor task");
				const m07Dir = ws.runDir("M07", m07RunId);
				const goal = JSON.parse(await safeText(path.join(m07Dir, "goal.json"))) as CurrentGoal;
				const task = goal.tasks.find(row => row.taskId === taskId);
				if (goal.runId !== m07RunId || goal.goal !== assessorTask.objective ||
					goal.problemRelation !== `${LOCAL_M07_MISSION_BINDING_PREFIX}${missionId}\n${progress.contract.goal}` ||
					goal.tasks.length !== 1 || !task || !task.objective.startsWith(assessorTask.objective) ||
					goal.executionState?.attempts.filter(row => JSON.stringify(row.runDescriptor.process) ===
						JSON.stringify(host.source.process)).length !== 1)
					throw new Error("local M07 task or execution owner does not match the mission dispatch");
				await recordLocalDispatchLineage({ missionRoot: root, m07Dir, lineage: {
					version: 1, kind: "local-mission-m07-dispatch-lineage", missionId,
					intentId, oldAttempt: host.source,
					intentCheckpoint: { sequence: checkpoint.sequence, sha256: checkpoint.sha256 },
					m07RunId, taskId, assessorTaskSha256: assessorTaskHash(assessorTask),
					m07TaskInputsSha256: localLineageHash(JSON.stringify(task.inputs)),
					m07TaskChecksSha256: localLineageHash(JSON.stringify(task.checks)),
					m07Owner: host.source.process } });
			},
			async verifyCurrentFulfillment(progress) {
				try {
					const readContext: StageContext = context ?? { ws,
						runner: { create: async () => { throw new HarnessError("local.mission.status", "status cannot start a session"); },
							resume: async () => { throw new HarnessError("local.mission.status", "status cannot resume a session"); } },
						config: await ws.loadConfig(), store: createFileKnowledgeStore(ws.knowledgeDir) };
					const review = await recoverDefaultSelectionReview({ ctx: readContext,
						controller: createM07Controller(readContext), contract: progress.contract,
						progress, root });
					if (!review) throw new Error("completed mission has no selected review");
				} catch (error) {
					throw new HarnessError("local.mission.current-evidence",
						`A fulfilled checkpoint was recorded, but its current evidence is invalid: ${(error as Error).message}`);
				}
			},
			async reviewSelection({ ctx, controller, contract, run }) {
				return recordDefaultSelectionReview({ ctx, controller, contract, run, root });
			},
			async currentUnknownOperationIds() {
				return [...(await LocalMissionHost.status(root)).unresolvedOperationIds];
			},
			currentUnrepresentedM07RunIds: unrepresentedM07,
			async createContract(contract: OriginalObjectiveContractV1,
				request: { materials?: readonly LocalMaterialSelection[] }) {
				const problem = await ws.readProblem();
				const raw = request.materials ? undefined : await ws.readRawInfo();
				if (raw?.skipped.length)
					throw new Error("local mission has original binary inputs that require an explicit supported evidence conversion before starting");
				const host = await writable();
				const serialized = `${JSON.stringify(contract, null, 2)}\n`;
				const evidenceDir = path.join(root, "evidence");
				await mkdir(evidenceDir, { mode: 0o700 });
				await saveFrozen(contractFile, serialized);
				await saveFrozen(path.join(evidenceDir, "original-problem.txt"), await safeText(problem.path));
				for (const [index, item] of (raw?.items ?? []).entries())
					await saveFrozen(path.join(evidenceDir, `original-input-${index + 1}.txt`), await safeText(item.path));
				const inputFiles = ["original-problem.txt",
					...(raw?.items ?? []).map((_, index) => `original-input-${index + 1}.txt`)];
				const frozenInputs = await Promise.all(inputFiles.map(async name => {
					const bytes = await readFile(path.join(evidenceDir, name));
					return { name, bytes: bytes.length, sha256: sha256(bytes) };
				}));
				const material = request.materials ? await freezeLocalMaterialBundle({
					root: path.join(root, "materials"), baseDir: ws.root,
					selections: request.materials }) : undefined;
				const materialManifestSha256 = material ?
					sha256(await readFile(material.manifestFile)) : undefined;
				// The original contract gains durable host authority only after all
				// workspace inputs are frozen. Partial preliminary copies remain orphans.
				await host.recordInitialContract({ attemptId: host.source.attemptId,
					bytes: Buffer.from(`${JSON.stringify({ ...contract, frozenInputs,
						...(materialManifestSha256 ? { materialManifestSha256 } : {}) }, null, 2)}\n`, "utf8") });
				return { contractFile,
					...(material ? { materialBundleRoot: path.join(root, "materials") } : {}) };
			},
			async readCheckpoint() {
				return parseProgress(await LocalMissionHost.readLatestCheckpoint(root), missionId);
			},
			async recordCheckpoint(progress: ObjectiveProgressV1) {
				if (progress.contract.id !== missionId) throw new Error("local mission checkpoint belongs to another mission");
				// Evidence is copied before this control checkpoint becomes the latest
				// committed state. A crash cannot seal a run whose feedback vanished.
				await stageBoundedEvidence(progress);
				const host = await writable();
				const latest = (await host.status()).latestCheckpoint;
				await host.recordCheckpoint({ attemptId: host.source.attemptId,
					sequence: (latest?.sequence ?? 0) + 1,
					previousSha256: latest?.sha256 ?? null, bytes: checkpointBytes(progress) });
			},
			async freeze({ contract, progress, iteration }: { contract: OriginalObjectiveContractV1;
				progress: ObjectiveProgressV1; iteration: number }): Promise<LocalObjectiveFrozenEvidence> {
				const stored = await LocalMissionHost.readInitialContract(root);
				const storedValue = stored ? JSON.parse(stored.toString("utf8")) as
					OriginalObjectiveContractV1 & { frozenInputs?: Array<{ name: string; bytes: number;
						sha256: string }>; materialManifestSha256?: string } : undefined;
				if (!storedValue || JSON.stringify(Object.fromEntries(Object.entries(storedValue)
					.filter(([key]) => key !== "frozenInputs" && key !== "materialManifestSha256"))) !==
					JSON.stringify(contract) ||
					await safeText(contractFile) !== `${JSON.stringify(contract, null, 2)}\n`)
					throw new Error("local mission original contract differs from committed host evidence");
				const evidenceDir = path.join(root, "evidence");
				const names = (await readdir(evidenceDir)).filter(name =>
					name === "original-problem.txt" || /^original-input-[1-9][0-9]*\.txt$/.test(name)).sort();
				const original = names.map(name => ({ name, file: path.join(evidenceDir, name) }));
				if (!names.includes("original-problem.txt") ||
					(!storedValue.materialManifestSha256 && names.length !== contract.inputNames.length) ||
					(storedValue.materialManifestSha256 && names.length !== 1) ||
					!Array.isArray(storedValue.frozenInputs) ||
					JSON.stringify(storedValue.frozenInputs.map(item => item.name).sort()) !==
						JSON.stringify([...names].sort()))
					throw new Error("local mission frozen original input set is incomplete");
				for (const item of original) {
					const text = await safeText(item.file);
					const bytes = Buffer.from(text, "utf8");
					const expected = storedValue.frozenInputs.find(row => row.name === item.name);
					if (!expected || bytes.length !== expected.bytes || sha256(bytes) !== expected.sha256)
						throw new Error("local mission original input differs from committed host evidence");
				}
				const originalIdentities: Array<{ name: string; bytes: number; sha256: string;
					sourceIdentity?: string }> = [...storedValue.frozenInputs];
				const materialNames = new Map<string, "host-control" | "supplied-task" |
					"unselected-evidence">();
				if (storedValue.materialManifestSha256) {
					const materialRoot = path.join(root, "materials");
					const manifestBytes = await readFile(path.join(materialRoot, "manifest.json"));
					if (sha256(manifestBytes) !== storedValue.materialManifestSha256)
						throw new Error("local mission material manifest differs from committed host evidence");
					const manifest = await readLocalMaterialBundle(materialRoot);
					originalIdentities.push(...manifest.items.map(item => ({
						name: `material-${item.id}`, bytes: item.bytes, sha256: item.sha256,
						sourceIdentity: item.sourceIdentity })));
					for (const [index, relative] of manifest.indexFiles.entries()) {
						const name = `material-index-${index + 1}.md`;
						original.push({ name, file: path.join(materialRoot, relative) });
						materialNames.set(name, "host-control");
					}
					for (const item of manifest.items) if (item.text)
						for (const [index, part] of item.parts.entries()) {
							const name = `${item.id}-part-${index + 1}.txt`;
							original.push({ name, file: path.join(materialRoot, part.file) });
							materialNames.set(name, item.sourceIdentity.startsWith("declared:") ?
								"supplied-task" : "unselected-evidence");
						}
				}
				const status = await LocalMissionHost.status(root);
				if (status.repairRequired || status.writerLockPresent)
					throw new Error("local mission host has an unresolved durable-write repair; assessor was not started");
				// A new CLI/Pi process must prove the prior attempt is dead before any
				// read-only assessor can reserve another provider request.
				await writable();
				const boundedRunEvidence = await stageBoundedEvidence(progress);
				for (const names of Object.values(boundedRunEvidence))
					for (const name of names) original.push({ name, file: path.join(evidenceDir, name) });
			const repairFeedbackNames = new Set<string>();
			const bounded = progress.boundedRuns.at(-1);
			if (bounded) {
				const goal = JSON.parse(await safeText(path.join(ws.runDir("M07", bounded.runId),
					"goal.json"))) as CurrentGoal;
				if (goal.tasks.some(task => task.status === "rejected" || task.status === "failed")) {
					const names = boundedRunEvidence[bounded.runId];
					if (!names?.length || names.some(name => !name.startsWith(
						`prior-run-${progress.boundedRuns.length}-feedback-`)))
						throw new Error("rejected or failed M07 task has no complete feedback for the next assessor");
					for (const name of names) repairFeedbackNames.add(name);
				}
			}
			const additional = await publishedAndProofEvidence(progress);
			const { committedKnowledge, selectionProofGapNames } = additional;
			original.push(...additional.files);
				const selectionReview = progress.selectedArtifacts.length && context ?
					await recoverDefaultSelectionReview({ ctx: context,
						controller: createM07Controller(context), contract, progress, root }) : undefined;
				const selectedEvidenceNames = new Map<string, "selected-evidence" | "host-control">();
				if (selectionReview && context) for (const item of defaultSelectionEvidenceFiles(context,
				selectionReview, root)) {
					original.push(item);
					selectedEvidenceNames.set(item.name,
						selectionReview.selectedArtifacts.some(selected => selected.name === item.name) ?
							"selected-evidence" : "host-control");
				}
				const unrepresentedM07RunIds = await unrepresentedM07(progress);
				const reviewedMissionIntents = new Set(status.checkpointReceipts
					.flatMap(item => item.interruptedReview ? [item.interruptedReview.intentId] :
						item.legacyInterruptedReview ? [item.legacyInterruptedReview.intentId] :
						item.evaluatorRecoveryReview ? [item.evaluatorRecoveryReview.intentId] :
						item.coldMigrationReview ? [item.coldMigrationReview.intentId] : []));
				for (const runId of await ws.listRuns("MISSION")) {
					const run = await ws.readRun("MISSION", runId);
					if (run.status === "running" && !reviewedMissionIntents.has(runId) &&
						run.inputs.some(item => item.path === contractFile))
						unrepresentedM07RunIds.push(`MISSION:${runId}`);
				}
				const previousCapabilities = (await readdir(evidenceDir)).filter(name =>
					/^host-capability-[1-9][0-9]*(?:-[0-9a-f]{16})?\.txt$/.test(name));
				const previousTaskContracts = (await readdir(evidenceDir)).filter(name =>
					/^host-evaluator-task-input-[1-9][0-9]*-[0-9a-f]{16}\.json$/.test(name));
				const hasModel = (role: "research" | "execution") =>
					Boolean(context?.config.roles[role] ?? context?.config.roles.default);
				const hostCapabilities = [
					{ scope: "local-m07-reason", available: hasModel("research") && hasModel("execution"),
						description: "Local M07 read-only reasoning with M04 review", limits: ["A returned report is unselected evidence"] },
					{ scope: "local-m07-execute", available: hasModel("research") && hasModel("execution") &&
						context?.config.localMission?.execution === "task-root-bash",
						description: "Opt-in trusted local M07 execution with task-root Pi read/write/edit/bash tools",
						limits: ["Bash is not an OS sandbox and can access same-user files outside the task root; keep unrelated secrets outside this worker environment", "External effects require authorization and host reconciliation"] },
				];
				let evaluatorCapabilityGap: string | undefined;
				let evaluator: LocalMissionEvaluator | undefined;
				{
					try { evaluator = await requireLocalEvaluator(contract, context?.config.localMission?.evaluatorId, {
						frozenOriginalInputs: originalIdentities,
						capabilities: hostCapabilities }); }
					catch (error) { evaluatorCapabilityGap = (error as Error).message; }
				}
				const declaredTaskContract = validatedTaskInputContract(evaluator?.taskInputContract);
				const sourceIdentitySha256 = sha256(Buffer.from(JSON.stringify(originalIdentities)));
				const taskContractIdentity = declaredTaskContract && evaluator ? {
					missionId: contract.id, evaluatorId: evaluator.id, evaluatorVersion: evaluator.version,
					sourceIdentitySha256,
					contractSha256: sha256(Buffer.from(JSON.stringify(declaredTaskContract))) } : undefined;
				let taskContractEvidenceName: string | undefined;
				for (const name of previousTaskContracts) {
					const priorText = await safeText(path.join(evidenceDir, name));
					const prior = JSON.parse(priorText) as { binding?: {
						missionId?: string; evaluatorId?: string; evaluatorVersion?: string;
						sourceIdentitySha256?: string; contractSha256?: string }; contract?: unknown };
					if (sha256(Buffer.from(priorText)).slice(0, 16) !==
						name.match(/-([0-9a-f]{16})\.json$/)?.[1] || !prior.binding || !prior.contract ||
						sha256(Buffer.from(JSON.stringify(prior.contract))) !== prior.binding.contractSha256 ||
						prior.binding.missionId !== contract.id ||
						prior.binding.sourceIdentitySha256 !== sourceIdentitySha256 ||
						(evaluator && prior.binding.evaluatorId === evaluator.id &&
						 prior.binding.evaluatorVersion === evaluator.version &&
						 prior.binding.contractSha256 !== taskContractIdentity?.contractSha256))
						throw new Error("local evaluator task input contract identity changed across reopen");
					original.push({ name, file: path.join(evidenceDir, name) });
				}
				if (declaredTaskContract && taskContractIdentity) {
					const contractText = `${JSON.stringify({ binding: taskContractIdentity,
						contract: declaredTaskContract }, null, 2)}\n`;
					const name = `host-evaluator-task-input-${iteration}-${sha256(Buffer.from(contractText)).slice(0, 16)}.json`;
					taskContractEvidenceName = name;
					await ensureFrozen(path.join(evidenceDir, name), contractText);
					if (!previousTaskContracts.includes(name)) original.push({ name, file: path.join(evidenceDir, name) });
				}
				const capabilities = [
				{ scope: "local-mission-evaluator", available: !evaluatorCapabilityGap,
					description: evaluatorCapabilityGap ?? `Trusted host evaluator ${context?.config.localMission?.evaluatorId ?? "unconfigured"}`,
					limits: ["Evaluator results are observations until M07 review, M04 reads and host selection",
						...(taskContractEvidenceName ? [`Read ${taskContractEvidenceName} for the exact host-declared task input shape before proposing or executing work.`] : [])] },
					...hostCapabilities,
				];
				const capabilityText = `${JSON.stringify(capabilities)}\n`;
				const capabilityFile = path.join(evidenceDir,
					`host-capability-${iteration}-${sha256(Buffer.from(capabilityText)).slice(0, 16)}.txt`);
				await ensureFrozen(capabilityFile, capabilityText);
				for (const name of previousCapabilities) if (name !== path.basename(capabilityFile)) {
					const previousHash = name.match(/-([0-9a-f]{16})\.txt$/)?.[1];
					if (previousHash && sha256(Buffer.from(await safeText(path.join(evidenceDir, name)))).slice(0, 16) !== previousHash)
						throw new Error("local mission prior capability observation changed");
					original.push({ name, file: path.join(evidenceDir, name) });
				}
				original.push({ name: path.basename(capabilityFile), file: capabilityFile });
				const sourceKinds = Object.fromEntries(original.map(item => [item.name,
					item.name.startsWith("host-capability-") || item.name.startsWith("host-evaluator-task-input-") ? "host-capability" :
					selectedEvidenceNames.get(item.name) ?? materialNames.get(item.name) ??
						(item.name === committedKnowledge?.indexName ? "host-control" :
						committedKnowledge?.partNames.includes(item.name) ? "unselected-evidence" :
						(item.name.startsWith("selection-proof-gap-") ? "host-control" : item.name.startsWith("prior-run-") ?
						item.name.includes("-control-") ? "host-control" : "unselected-evidence" :
						"supplied-task"))])) as
					NonNullable<LocalObjectiveFrozenEvidence["groundingPolicy"]>["sourceKinds"];
				const unknown = [...new Set([...status.unresolvedOperationIds,
					...progress.continuation.unresolvedOperationIds])].sort();
				const assessmentsDir = path.join(root, "assessments");
				await mkdir(assessmentsDir, { mode: 0o700, recursive: true });
				return { contractFile, frozenOriginalInputs: originalIdentities,
					checkpointRawScope: storedValue.materialManifestSha256 ? "none" : "workspace",
					evidenceRoot: path.join(assessmentsDir,
					`attempt-${iteration}-${randomUUID()}`), evidence: original,
					capabilities, ...(evaluatorCapabilityGap ? { evaluatorCapabilityGap } : {}),
					...(taskContractEvidenceName && taskContractIdentity ? { evaluatorTaskInputContract: {
						name: taskContractEvidenceName,
						sha256: sha256(Buffer.from(await safeText(path.join(evidenceDir, taskContractEvidenceName)))),
						evaluatorId: taskContractIdentity.evaluatorId,
						evaluatorVersion: taskContractIdentity.evaluatorVersion,
						sourceIdentitySha256: taskContractIdentity.sourceIdentitySha256,
						contractSha256: taskContractIdentity.contractSha256 } } : {}),
					...(selectionReview ? { selectionReview } : {}),
					selectedArtifacts: [...progress.selectedArtifacts],
					availableArtifacts: [...progress.availableArtifacts], unresolvedOperationIds: unknown,
					groundingPolicy: { require: true, sourceKinds,
						newEvidenceSourceIds: [...selectedEvidenceNames].filter(([, kind]) =>
							kind === "selected-evidence").map(([name]) => name),
						legacyOpenDetails: [...(selectionReview ?
							progress.assessment?.groundedAssessment?.legacyOpenDetails ??
								progress.continuation.unresolvedDetails :
							progress.continuation.unresolvedDetails)],
						previousIssues: progress.assessment?.groundedAssessment?.issues ?? [] },
					boundedRunEvidence, unrepresentedM07RunIds,
				evidenceAccess: Object.fromEntries(Object.values(boundedRunEvidence).flat()
					.filter(name => !repairFeedbackNames.has(name))
					.map(name => [name, "retrievable" as const]).concat(
						committedKnowledge && !repairFeedbackNames.size ?
							committedKnowledge.partNames.map(name => [name, "retrievable" as const]) : [])),
					evidenceRequirements: { requiredNames: original.filter(item =>
						item.name.startsWith("original-") || materialNames.has(item.name) ||
					repairFeedbackNames.has(item.name) ||
					(repairFeedbackNames.size > 0 && item.name === taskContractEvidenceName) ||
					item.name === committedKnowledge?.indexName ||
					(repairFeedbackNames.size > 0 && committedKnowledge?.partNames.includes(item.name)) ||
						selectionProofGapNames.includes(item.name) ||
						selectedEvidenceNames.has(item.name)).map(item => item.name),
					instructions: "Read every selected frozen text projection and its coverage index. Read the committed knowledge index and, when repairing a rejected or failed task, every listed current-merge knowledge pack part; M04 adoption does not select a candidate or prove original closure. A binary original remains frozen but is not read by text extraction; check its explicit gap before any claim. Historical reports are unselected until reviewed." } };
			},
		};
	};
	const caller = createLocalOriginalObjectiveCaller({ ws, hostFor, ctx: context,
		adapters: createLocalM07Adapters() });
	return caller;
}
