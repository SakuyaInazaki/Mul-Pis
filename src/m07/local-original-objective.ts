/** Workspace-local orchestration for one unchanged user-authored objective.
 *
 * The host owns checkpoint durability and frozen evidence. A registered adapter
 * owns the semantics of one bounded M07/M04 task. Neither the assessor nor this
 * caller may turn an unreviewed task into selected scientific authority.
 */
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { resolveRoleModel } from "../config.ts";
import { runM04 } from "../stages/m04.ts";
import type { StageContext } from "../stages/context.ts";
import { HarnessError } from "../types.ts";
import type { Workspace } from "../workspace.ts";
import { createM07Controller } from "./controller.ts";
import type { M07Controller } from "./types.ts";
import { readLocalMaterialBundle, validateLocalMaterialSelections,
	type LocalMaterialSelection } from "./local-material-bundle.ts";
import { assessAndAdvanceOriginalObjective, createOriginalObjective, objectiveProgress,
	runOriginalObjectiveLoop } from "./objective-progress.ts";
import type { CurrentObjectiveStopReason, HostPendingActionFactsV1, ObjectiveCapabilityV1,
	ObjectiveNextTaskV1, ObjectiveProgressV1, OriginalObjectiveContractV1 } from "./objective-progress.ts";

type AssessorInput = Parameters<typeof assessAndAdvanceOriginalObjective>[0];
const missionIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const obligationIdPattern = /^[A-Za-z][A-Za-z0-9._-]{0,79}$/;

/** The CLI/Pi passes parsed authoring JSON; it never adds scientific criteria. */
export interface LocalObjectiveRequestV1 {
	version: 1;
	kind: "local-original-objective-request";
	goal: string;
	goalSource: OriginalObjectiveContractV1["goalSource"];
	obligations: OriginalObjectiveContractV1["obligations"];
	closure: OriginalObjectiveContractV1["closure"];
	userOverrides?: string[];
	/** Exact user-declared source set; omission uses the legacy workspace text set. */
	materials?: LocalMaterialSelection[];
}

function record(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value) &&
		Object.getPrototypeOf(value) === Object.prototype;
}

function prose(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0 && !value.includes("\0");
}

export function validateLocalObjectiveRequest(value: unknown): LocalObjectiveRequestV1 {
	if (!record(value) || Object.keys(value).some(key => !["version", "kind", "goal", "goalSource",
		"obligations", "closure", "userOverrides", "materials"].includes(key)) ||
		value.version !== 1 || value.kind !== "local-original-objective-request" ||
		!prose(value.goal) || !["verbatim-private-input", "user-intent-summary"].includes(
			String(value.goalSource)) || !["open-ended", "finite-evidence"].includes(
			String(value.closure)) || !Array.isArray(value.obligations) || !value.obligations.length ||
		value.obligations.some(item => !record(item) || Object.keys(item).some(key =>
			!["description", "id", "type", "expectedSha256"].includes(key)) ||
			!obligationIdPattern.test(String(item.id)) || !prose(item.description) ||
			(item.type !== undefined && !obligationIdPattern.test(String(item.type))) ||
			(item.expectedSha256 !== undefined && (typeof item.expectedSha256 !== "string" ||
				!/^[0-9a-f]{64}$/.test(item.expectedSha256)))) ||
		new Set(value.obligations.map(item => item.id)).size !== value.obligations.length ||
		(value.userOverrides !== undefined && (!Array.isArray(value.userOverrides) ||
			value.userOverrides.some(item => !prose(item)))) ||
		(value.materials !== undefined && (!validateLocalMaterialSelections(value.materials) ||
			value.materials.length === 0)))
		throw new HarnessError("local.objective.request", "local original objective request is invalid");
	return structuredClone(value) as unknown as LocalObjectiveRequestV1;
}

/** Safe control projection for CLI/Pi. Full progress contains private task text. */
export function publicLocalMissionStatus(progress: ObjectiveProgressV1) {
	return { missionId: progress.contract.id, objectiveOutcome: progress.objectiveOutcome,
		stopReason: progress.stopReason, boundedRunCount: progress.boundedRuns.length,
		unresolvedOperationCount: progress.continuation.unresolvedOperationIds.length,
		pendingAction: progress.continuation.pendingAction ? {
			kind: progress.continuation.pendingAction.kind,
			safety: progress.continuation.pendingAction.safety,
			reasonCode: progress.continuation.pendingAction.reasonCode } : null };
}

/** All paths refer to regular, bounded host snapshots; the assessor freezes a second copy. */
export interface LocalObjectiveFrozenEvidence {
	contractFile: string;
	evidence: Array<{ name: string; file: string }>;
	/** Host-frozen original file identities supplied to evaluator preflight. */
	frozenOriginalInputs?: Array<{ name: string; bytes: number; sha256: string }>;
	evidenceRoot: string;
	capabilities: ObjectiveCapabilityV1[];
	selectedArtifacts: string[];
	/** Durable host review receipt. Bare check JSON cannot carry selection authority. */
	selectionReview?: LocalObjectiveSelectionReviewV1;
	/** Precise host-observed evaluator capability gap; no assessor call is made. */
	evaluatorCapabilityGap?: string;
	/** Exact host-authored task shape copied into each new M07 task. */
	evaluatorTaskInputContract?: { name: string; sha256: string; evaluatorId: string;
		evaluatorVersion: string; sourceIdentitySha256: string; contractSha256: string };
	availableArtifacts?: string[];
	unresolvedOperationIds: string[];
	/** Host census of M07/M04 work not yet represented in boundedRuns. */
	unrepresentedM07RunIds?: string[];
	/** Every prior bounded run must have exact frozen feedback names in evidence. */
	boundedRunEvidence?: Record<string, string[]>;
	/** The host must explicitly attest any removed prior unknown operation ID. */
	reconciledOperationIds?: string[];
	/** A recovered provisional assessment needs host proof that dispatch is settled. */
	priorDispatchReconciled?: boolean;
	evidenceAccess?: AssessorInput["evidenceAccess"];
	evidenceRequirements?: AssessorInput["evidenceRequirements"];
	groundingPolicy?: AssessorInput["groundingPolicy"];
	pendingActionFacts?: HostPendingActionFactsV1;
	prepareNextTask?: AssessorInput["prepareNextTask"];
}

/** One mission-scoped host; only the host may amend unknown-operation control. */
export interface LocalObjectiveHostPort {
	createContract(contract: OriginalObjectiveContractV1,
		request: { materials?: readonly LocalMaterialSelection[] }): Promise<{
			contractFile: string; materialBundleRoot?: string }>;
	readCheckpoint(): Promise<ObjectiveProgressV1 | undefined>;
	/** Read-only current-evidence check; never rewrites a historical completion. */
	verifyCurrentFulfillment(progress: ObjectiveProgressV1): Promise<void>;
	recordCheckpoint(progress: ObjectiveProgressV1): Promise<void>;
	/** Future dispatch edge; built-in adapter records it after task ID allocation. */
	recordDispatchLineage?(input: { intentId: string; m07RunId: string;
		taskId: string; assessorTask: ObjectiveNextTaskV1 }): Promise<void>;
	/** Recheck trusted local control immediately before any new M07 dispatch. */
	currentUnknownOperationIds(): Promise<string[]>;
	currentUnrepresentedM07RunIds(progress: ObjectiveProgressV1): Promise<string[]>;
	/** Optional authority path. The host must verify M07 review and M04 evidence first. */
	reviewSelection?(input: { ctx: StageContext; controller: M07Controller;
		contract: OriginalObjectiveContractV1;
		frozen: LocalObjectiveFrozenEvidence; run: LocalObjectiveAdvanceResult }):
		Promise<LocalObjectiveSelectionReviewV1 | undefined>;
	freeze(input: { contract: OriginalObjectiveContractV1; progress: ObjectiveProgressV1;
		iteration: number }): Promise<LocalObjectiveFrozenEvidence>;
	recordValidationFailure?: AssessorInput["recordValidationFailure"];
	recordRepairState?: AssessorInput["recordRepairState"];
}

export interface LocalOriginalCheck {
	obligationId: string; passed: boolean; evidenceRefs: string[];
	/** New receipts distinguish a failed proposition from one still unknown. */
	result?: "passed" | "failed" | "unknown";
}

export interface LocalObjectiveSelectionReviewV1 {
	version: 1;
	kind: "local-objective-selection-review";
	runId: string;
	taskId: string;
	m04RunId: string;
	selectedArtifacts: Array<{ name: string; file: string; sha256: string }>;
	originalChecks: LocalOriginalCheck[];
	/** Present for durable default-host reviews; old caller-authored receipts remain readable. */
	hostEvidence?: { missionId: string; checkpointId: string; evaluatorId: string;
		evaluatorVersion: string; evaluatorReceiptSha256: string;
		m04SourceSha256: string; m04CoverageSha256: string;
		m04TransactionSha256: string; checkpointManifestSha256: string;
		requiredM07ReadPaths: string[] };
}

export interface LocalObjectiveAdvanceResult {
	runId: string; outcome: string; acceptedTaskIds: string[];
	selectedTaskId?: string; m04RunId?: string;
	checkpointId?: string; evaluatorReceiptPath?: string;
	requiredM07ReadPaths?: string[];
	unresolvedOperationRefs?: string[];
}

function checkedOriginalChecks(contract: OriginalObjectiveContractV1, selected: readonly string[],
	checks: readonly LocalOriginalCheck[]): LocalOriginalCheck[] {
	const original = new Set(contract.obligations.map(item => item.id));
	if (!Array.isArray(checks) || checks.length !== original.size ||
		new Set(checks.map(item => item.obligationId)).size !== checks.length ||
		checks.some(item => !original.has(item.obligationId) || typeof item.passed !== "boolean" ||
			(item.result !== undefined && (!["passed", "failed", "unknown"].includes(item.result) ||
				item.passed !== (item.result === "passed"))) ||
			!Array.isArray(item.evidenceRefs) || new Set(item.evidenceRefs).size !== item.evidenceRefs.length ||
			item.evidenceRefs.some((ref: string) => !selected.includes(ref)) ||
			item.passed && !item.evidenceRefs.length))
		throw new HarnessError("local.objective.review", "original check lacks exact selected evidence or obligation authority");
	return checks.map(item => ({ obligationId: item.obligationId, passed: item.passed,
		...(item.result ? { result: item.result } : {}), evidenceRefs: [...item.evidenceRefs] }));
}

async function checkedSelectionReview(workspaceRoot: string, contract: OriginalObjectiveContractV1,
	run: LocalObjectiveAdvanceResult, review: LocalObjectiveSelectionReviewV1): Promise<{
	selectedArtifacts: string[]; originalChecks: LocalOriginalCheck[] }> {
	const digest = /^[0-9a-f]{64}$/;
	if (review?.version !== 1 || review.kind !== "local-objective-selection-review" ||
		review.runId !== run.runId || !run.selectedTaskId ||
		review.taskId !== run.selectedTaskId || !run.acceptedTaskIds.includes(review.taskId) ||
		!run.m04RunId || review.m04RunId !== run.m04RunId ||
		!Array.isArray(review.selectedArtifacts) || !review.selectedArtifacts.length ||
		review.selectedArtifacts.some(item => !item ||
			!/^[A-Za-z][A-Za-z0-9._-]{0,79}$/.test(item.name) ||
			!path.isAbsolute(item.file) || !digest.test(item.sha256)) ||
		new Set(review.selectedArtifacts.map(item => item.name)).size !== review.selectedArtifacts.length)
		throw new HarnessError("local.objective.review", "selection review does not match accepted M07/M04 identities");
	const root = await realpath(workspaceRoot);
	for (const item of review.selectedArtifacts) {
		const info = await lstat(item.file);
		const resolved = await realpath(item.file);
		const relative = path.relative(root, resolved);
		if (!info.isFile() || info.isSymbolicLink() ||
			relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
			throw new HarnessError("local.objective.review", "selected artifact escaped the frozen workspace");
		const handle = await open(item.file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
		try {
			const before = await handle.stat();
			if (!before.isFile() || before.nlink !== 1 || before.size < 1 || before.size > 64 * 1024 * 1024)
				throw new HarnessError("local.objective.review", "selected artifact is not a bounded regular file");
			const bytes = await handle.readFile();
			const after = await handle.stat();
			if (bytes.length !== before.size || after.dev !== before.dev || after.ino !== before.ino ||
				after.size !== before.size || createHash("sha256").update(bytes).digest("hex") !== item.sha256)
				throw new HarnessError("local.objective.review", "selected artifact differs from pinned review bytes");
		} finally { await handle.close(); }
	}
	const names = review.selectedArtifacts.map(item => item.name);
	return { selectedArtifacts: names,
		originalChecks: checkedOriginalChecks(contract, names, review.originalChecks) };
}

class LocalObjectiveControlHold extends Error {
	readonly progress: ObjectiveProgressV1;
	constructor(progress: ObjectiveProgressV1) {
		super("local objective dispatch is held for operation reconciliation");
		this.progress = progress;
	}
}

export interface LocalObjectiveAdapter {
	readonly scope: string;
	advance(input: { ctx: StageContext; controller: M07Controller; runM04: typeof runM04;
		contract: OriginalObjectiveContractV1; frozen: LocalObjectiveFrozenEvidence;
		task: ObjectiveNextTaskV1;
		recordDispatchLineage?: (m07RunId: string, taskId: string) => Promise<void> }): Promise<LocalObjectiveAdvanceResult>;
}

export interface LocalOriginalObjectiveCaller {
	begin(request: unknown): Promise<ObjectiveProgressV1>;
	status(missionId: string): Promise<ObjectiveProgressV1>;
	step(missionId: string): Promise<ObjectiveProgressV1>;
	run(missionId: string): Promise<ObjectiveProgressV1>;
}

export function createLocalOriginalObjectiveCaller(input: { ws: Workspace;
	hostFor: (missionId: string) => LocalObjectiveHostPort;
	ctx?: StageContext; adapters?: readonly LocalObjectiveAdapter[];
	controller?: M07Controller }): LocalOriginalObjectiveCaller {
	const { ws, hostFor } = input;
	const adapters = [...(input.adapters ?? [])];
	if (new Set(adapters.map(item => item.scope)).size !== adapters.length ||
		adapters.some(item => !item.scope || typeof item.advance !== "function"))
		throw new HarnessError("local.objective.adapters", "local objective adapter registry is invalid");
	if (input.ctx && path.resolve(input.ctx.ws.root) !== path.resolve(ws.root))
		throw new HarnessError("local.objective.workspace", "local objective context uses another workspace");
	const requireContext = (): StageContext => {
		if (!input.ctx) throw new HarnessError("local.objective.runner", "local objective execution needs a configured runner");
		return input.ctx;
	};
	const load = async (missionId: string): Promise<{ host: LocalObjectiveHostPort;
		progress: ObjectiveProgressV1 }> => {
		if (!missionIdPattern.test(missionId))
			throw new HarnessError("local.objective.id", "local mission ID is invalid");
		const host = hostFor(missionId);
		const progress = await host.readCheckpoint();
		if (!progress || progress.version !== 1 || progress.kind !== "original-objective-progress" ||
			progress.contract.id !== missionId)
			throw new HarnessError("local.objective.missing", "local original objective checkpoint is unavailable");
		if (progress.objectiveOutcome === "fulfilled")
			await host.verifyCurrentFulfillment(progress);
		return { host, progress };
	};
	const stepCore = async (missionId: string): Promise<{ progress: ObjectiveProgressV1;
		advanced: boolean; stopReason: CurrentObjectiveStopReason }> => {
		const ctx = requireContext();
		const { host, progress: previous } = await load(missionId);
		const iteration = previous.assessmentHistory.length + 1;
		const frozen = await host.freeze({ contract: previous.contract, progress: previous, iteration });
		if (JSON.stringify(frozen.selectedArtifacts) !== JSON.stringify(previous.selectedArtifacts))
			throw new HarnessError("local.objective.selection", "host evidence changed selected authority without a reviewed checkpoint");
		const priorUnknown = previous.continuation.unresolvedOperationIds;
		const currentUnknown = [...new Set([...frozen.unresolvedOperationIds,
			...(frozen.unrepresentedM07RunIds ?? [])])];
		if (previous.stopReason === "assessment-validation-pending" &&
			!frozen.priorDispatchReconciled && !currentUnknown.includes(missionId))
			currentUnknown.push(missionId);
		if (priorUnknown.some(id => !currentUnknown.includes(id) &&
			!frozen.reconciledOperationIds?.includes(id)))
			throw new HarnessError("local.objective.operations", "previous unknown operation lacks a host reconciliation receipt");
		if (currentUnknown.length) {
			const blocked = objectiveProgress(previous.contract, { boundedRuns: previous.boundedRuns,
				selectedArtifacts: previous.selectedArtifacts,
				availableArtifacts: frozen.availableArtifacts ?? previous.availableArtifacts,
				assessment: previous.assessment, assessmentHistory: previous.assessmentHistory,
				stopReason: "execution-interrupted", unresolvedOperationIds: currentUnknown,
				pendingActionFacts: { ...frozen.pendingActionFacts,
					unresolvedOperationRefs: currentUnknown } });
			await host.recordCheckpoint(blocked);
			return { progress: blocked, advanced: false, stopReason: "execution-interrupted" };
		}
		const evidenceNames = new Set(frozen.evidence.map(item => item.name));
		if (previous.boundedRuns.some(row => !frozen.boundedRunEvidence?.[row.runId]?.length ||
			frozen.boundedRunEvidence[row.runId]!.some(name => !evidenceNames.has(name))))
			throw new HarnessError("local.objective.history", "prior bounded-run feedback was not frozen for reassessment");
		if (frozen.evaluatorCapabilityGap) {
			const held = objectiveProgress(previous.contract, { boundedRuns: previous.boundedRuns,
				selectedArtifacts: previous.selectedArtifacts,
				availableArtifacts: frozen.availableArtifacts ?? previous.availableArtifacts,
				assessment: previous.assessment, assessmentHistory: previous.assessmentHistory,
				stopReason: "next-task-needs-capability", pendingActionFacts: {
					evidenceRefs: frozen.evidence.filter(item => item.name.startsWith("host-capability-"))
						.map(item => item.name) } });
			await host.recordCheckpoint(held);
			return { progress: held, advanced: false, stopReason: "next-task-needs-capability" };
		}
		if (ctx.signal?.aborted) {
			const cancelled = objectiveProgress(previous.contract, { boundedRuns: previous.boundedRuns,
				selectedArtifacts: previous.selectedArtifacts,
				assessment: previous.assessment, assessmentHistory: previous.assessmentHistory,
				stopReason: "cancelled", pendingActionFacts: frozen.pendingActionFacts ?? {} });
			await host.recordCheckpoint(cancelled);
			return { progress: cancelled, advanced: false, stopReason: "cancelled" };
		}
		let selectedArtifacts = [...previous.selectedArtifacts];
		let originalChecks: LocalOriginalCheck[] = [];
		if (frozen.selectionReview) {
			const bound = previous.boundedRuns.find(row => row.runId === frozen.selectionReview!.runId);
			if (!bound) throw new HarnessError("local.objective.review", "selected review has no bounded-run ancestor");
			const checked = await checkedSelectionReview(ws.root, previous.contract, {
				runId: bound.runId, outcome: bound.outcome, acceptedTaskIds: bound.acceptedTaskIds ?? [],
				selectedTaskId: bound.selectedTaskId,
				m04RunId: frozen.selectionReview.m04RunId }, frozen.selectionReview);
			if (JSON.stringify(checked.selectedArtifacts) !== JSON.stringify(selectedArtifacts))
				throw new HarnessError("local.objective.review", "persisted selected review differs from checkpoint authority");
			originalChecks = checked.originalChecks;
		} else if (selectedArtifacts.length)
			throw new HarnessError("local.objective.review", "selected checkpoint lacks its host review receipt");
		const controller = input.controller ?? createM07Controller(ctx);
		const record = await ws.startRun("MISSION", [{ label: "Frozen original objective",
			path: frozen.contractFile }]);
		const history = [...previous.assessmentHistory];
		let bounded = [...previous.boundedRuns];
		let newUnknownRefs: string[] = [];
		const recordAssessment: NonNullable<AssessorInput["recordAssessment"]> = async assessment => {
			const at = { iteration, assessment, stopReason: "assessment-validation-pending" as const,
				advanced: false };
			if (history.at(-1)?.iteration === iteration) history[history.length - 1] = at;
			else history.push(at);
			await host.recordCheckpoint(objectiveProgress(previous.contract, { boundedRuns: bounded,
				selectedArtifacts: previous.selectedArtifacts, assessment, assessmentHistory: history,
				stopReason: "assessment-validation-pending", pendingActionFacts: frozen.pendingActionFacts ?? {} }));
		};
		let step;
		try {
			step = await assessAndAdvanceOriginalObjective({ contract: previous.contract,
				contractFile: frozen.contractFile, runner: ctx.runner,
				sessionSpec: { label: `local-original-objective-${iteration}`, role: "research",
					model: resolveRoleModel(ctx.config, "research"), persistDir: ws.sessionsDir,
					systemPrompt: "Assess the unchanged user-authored original goal from frozen evidence. Report uncertainty and propose one bounded task only when it could change the result." },
				runRecord: record, persistReceipt: () => ws.writeRun(record),
				evidenceRoot: frozen.evidenceRoot, evidence: frozen.evidence,
				evidenceAccess: frozen.evidenceAccess,
				evidenceRequirements: frozen.evidenceRequirements,
				groundingPolicy: frozen.groundingPolicy,
				capabilities: frozen.capabilities,
				userOverrides: previous.contract.userOverrides,
				assessmentAdmission: "admitted",
				advanceAdmission: () => ctx.signal?.aborted ? "cancelled" : "admitted",
				supportedTaskScopes: adapters.map(item => item.scope),
				prepareNextTask: frozen.prepareNextTask,
				recordAssessment,
				recordValidationFailure: host.recordValidationFailure,
				recordRepairState: host.recordRepairState,
				advance: async task => {
					const adapter = adapters.find(item => item.scope === task.adapterScope);
					if (!adapter || !frozen.capabilities.some(item => item.scope === task.adapterScope && item.available))
						throw new HarnessError("local.objective.adapter", "assessor chose an unavailable local adapter");
					const freshUnknown = [...new Set([
						...await host.currentUnknownOperationIds(),
						...await host.currentUnrepresentedM07RunIds(previous)])];
					if (freshUnknown.length) {
						const held = objectiveProgress(previous.contract, {
							boundedRuns: bounded, selectedArtifacts: previous.selectedArtifacts,
							assessment: history.at(-1)?.assessment ?? previous.assessment,
							assessmentHistory: history, stopReason: "execution-interrupted",
							unresolvedOperationIds: freshUnknown,
							pendingActionFacts: { unresolvedOperationRefs: freshUnknown,
								failedStage: "m07-execution" } });
						await host.recordCheckpoint(held);
						throw new LocalObjectiveControlHold(held);
					}
					// This exact MISSION run ID is a no-replay control intent. A crash
					// after this write requires host census of M07/M04 before any retry.
					await host.recordCheckpoint(objectiveProgress(previous.contract, {
						boundedRuns: bounded, selectedArtifacts: previous.selectedArtifacts,
						assessment: history.at(-1)?.assessment ?? previous.assessment,
						assessmentHistory: history, stopReason: "execution-interrupted",
						unresolvedOperationIds: [record.runId],
						pendingActionFacts: { unresolvedOperationRefs: [record.runId],
							target: { goalRunId: record.runId }, failedStage: "m07-execution" } }));
					const result = await adapter.advance({ ctx, controller, runM04,
						contract: previous.contract, frozen, task,
						recordDispatchLineage: host.recordDispatchLineage ?
							(m07RunId, taskId) => host.recordDispatchLineage!({ intentId: record.runId,
								m07RunId, taskId, assessorTask: task }) : undefined });
					if (!result || typeof result.runId !== "string" || !result.runId ||
						typeof result.outcome !== "string" || !result.outcome ||
						!Array.isArray(result.acceptedTaskIds) ||
						result.acceptedTaskIds.some(id => typeof id !== "string" || !id) ||
						(result.m04RunId !== undefined && (typeof result.m04RunId !== "string" || !result.m04RunId)) ||
						(result.checkpointId !== undefined && (typeof result.checkpointId !== "string" || !result.checkpointId)) ||
						result.unresolvedOperationRefs !== undefined &&
							(!Array.isArray(result.unresolvedOperationRefs) ||
								result.unresolvedOperationRefs.some(id => typeof id !== "string" || !id)) ||
						result.selectedTaskId && !result.acceptedTaskIds.includes(result.selectedTaskId))
						throw new HarnessError("local.objective.adapter", "local adapter returned invalid reviewed bounded-run facts");
					bounded = [...bounded, { runId: result.runId, outcome: result.outcome,
						acceptedTaskIds: result.acceptedTaskIds,
						...(result.selectedTaskId ? { selectedTaskId: result.selectedTaskId } : {}) }];
					if (result.outcome === "unknown" || result.unresolvedOperationRefs?.length)
						newUnknownRefs = result.unresolvedOperationRefs?.length ?
							[...result.unresolvedOperationRefs] : [result.runId];
					if (!newUnknownRefs.length && host.reviewSelection) {
						const review = await host.reviewSelection({ ctx, controller,
							contract: previous.contract,
							frozen, run: result });
						if (review) {
							const checked = await checkedSelectionReview(ws.root, previous.contract, result, review);
							selectedArtifacts = checked.selectedArtifacts;
							originalChecks = checked.originalChecks;
						}
					}
					return result;
				} });
			await ws.finishRun(record, step.assessment ? "completed" : "failed");
		} catch (error) {
			record.failures.push("Local objective assessment or bounded dispatch was interrupted");
			await ws.finishRun(record, "failed").catch(() => undefined);
			if (error instanceof LocalObjectiveControlHold)
				return { progress: error.progress, advanced: false, stopReason: "execution-interrupted" };
			throw error;
		}
		const effectiveStopReason = newUnknownRefs.length ? "execution-interrupted" : step.stopReason;
		if (step.assessment && history.at(-1)?.iteration === iteration)
			history[history.length - 1] = { iteration, assessment: step.assessment,
				stopReason: effectiveStopReason, advanced: Boolean(step.advanced) };
		const next = objectiveProgress(previous.contract, { boundedRuns: bounded,
			selectedArtifacts,
			availableArtifacts: [...new Set([...(frozen.availableArtifacts ?? previous.availableArtifacts),
				...selectedArtifacts])],
			assessment: step.assessment ?? previous.assessment, assessmentHistory: history,
			originalChecks,
			stopReason: effectiveStopReason, unresolvedOperationIds: newUnknownRefs,
			pendingActionFacts: { ...frozen.pendingActionFacts,
				...(newUnknownRefs.length ? { unresolvedOperationRefs: newUnknownRefs } : {}) } });
		await host.recordCheckpoint(next);
		return { progress: next, advanced: Boolean(step.advanced), stopReason: effectiveStopReason };
	};
	return {
		async begin(value) {
			const request = validateLocalObjectiveRequest(value);
			const original = await ws.readProblem();
			const inputNames = request.materials ? request.materials.map(item =>
				item.kind === "registered-source" ? item.sourceId : item.label) :
				[path.basename(original.path), ...(await ws.readRawInfo()).items.map(item => item.name)];
			const contract = createOriginalObjective({ goal: request.goal,
				goalSource: request.goalSource,
				inputNames,
				obligations: request.obligations, closure: request.closure,
				...(request.userOverrides ? { userOverrides: request.userOverrides } : {}) });
			const host = hostFor(contract.id);
			const created = await host.createContract(contract,
				{ ...(request.materials ? { materials: request.materials } : {}) });
			const contractFile = created.contractFile;
			if (request.materials) {
				const bundleRoot = created.materialBundleRoot;
				const relative = bundleRoot && path.relative(ws.root, bundleRoot);
				if (!bundleRoot || !path.isAbsolute(bundleRoot) || !relative ||
					relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
					throw new HarnessError("local.objective.materials", "host did not freeze the declared material bundle");
				await readLocalMaterialBundle(bundleRoot);
			}
			if ((await readFile(contractFile, "utf8")) !== `${JSON.stringify(contract, null, 2)}\n`)
				throw new HarnessError("local.objective.contract", "host did not freeze the exact original objective");
			const progress = objectiveProgress(contract, { boundedRuns: [], selectedArtifacts: [],
				stopReason: "next-task-pending", pendingActionFacts: {} });
			await host.recordCheckpoint(progress);
			return progress;
		},
		async status(missionId) { return (await load(missionId)).progress; },
		async step(missionId) {
			const current = (await load(missionId)).progress;
			return current.objectiveOutcome === "fulfilled" ? current : (await stepCore(missionId)).progress;
		},
		async run(missionId) {
			const current = (await load(missionId)).progress;
			if (current.objectiveOutcome === "fulfilled") return current;
			let latest: ObjectiveProgressV1 | undefined;
			await runOriginalObjectiveLoop({ admission: () => input.ctx?.signal?.aborted ? "cancelled" : "admitted",
				step: async () => {
					const result = await stepCore(missionId);
					latest = result.progress;
					return { advanced: result.advanced, stopReason: result.stopReason };
				} });
			return latest ?? (await load(missionId)).progress;
		}
	};
}
