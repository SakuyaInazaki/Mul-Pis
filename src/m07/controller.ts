import { createReadStream, createWriteStream } from "node:fs";
import { randomUUID } from "node:crypto";
import { chmod, copyFile, cp, lstat, mkdir, readFile, readdir, realpath, rmdir, stat, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import { loadPrompt, section, systemPromptFor } from "../prompts.ts";
import { HarnessError } from "../types.ts";
import { nowIso, readTextIfExists, writeFileAtomic } from "../workspace.ts";
import { isTextFile, mediaType } from "../media.ts";
import { sessionSpec, type StageContext } from "../stages/context.ts";
import { isSafeRelativeOutputPath, resolveExpectedOutputFiles, type ExpectedOutputResolution } from "./expected-output.ts";
import type { BeginGoalInput, CurrentGoal, DecisionInput, EvidenceFile, FinishInput, HostStopReasonKind, HostStopReceipt, InterruptInput, M07CheckpointRecord, M07Controller, M07TaskRecord, TaskCheck, TaskReviewInput, TaskSpecInput, M07OperationV1 } from "./types.ts";
import { requestNotSentDetails, settledTerminalResponseDetails } from "../runner/operation-disposition.ts";
import type { StageRunRecord } from "../types.ts";
import { loadActiveBudgetPolicy, projectInline, validateActiveBudgetPointer, validateBudgetPolicy, type BudgetPolicy } from "../improvement/policy.ts";
import { capturedRunBytes, DEFAULT_PROJECTION_SNAPSHOT_LIMITS, newProjectionEvent, nextProjectionOrdinal, writeProjectionEvent, type ProjectionEventV1, type ProjectionMaterialV1, type ProjectionSnapshotLimits } from "../improvement/observations.ts";
import { createExperienceProvider, verifyRequiredKnowledge } from "../knowledge/experience-index.ts";
import { retrieveKnowledge } from "../knowledge/retrieval.ts";
import type { KnowledgeRef, KnowledgeStore } from "../knowledge/types.ts";
import { GenerationStore, isM07WorkflowStrategy } from "../improvement/generation.ts";
import { probeProcessIdentity, readCurrentProcessIdentity, type ProcessIdentityV1 } from "../runtime/process-identity.ts";
import { parseRunDescriptor, type RunDescriptorV1 } from "../runtime/run-descriptor.ts";
import { parseRoundReview } from "./execution-loop.ts";
import { openBoundedSession, type EvidenceBindingV1 } from "../context/boundary.ts";

const STATE = "goal.json";
const HOST_STOP_KEY = Symbol("m07-host-stop");
const HOST_STOP_REASONS: ReadonlySet<HostStopReasonKind> = new Set(["request-aborted", "provider-error", "session-shutdown", "no-progress"]);
const dispatchQueues = new Map<string, Promise<void>>();

/** One M07 task dispatch per goal at a time, including shared benchmark operations. A stale cross-process lock fails closed. */
async function withGoalDispatch<T>(ctx: StageContext, runId: string, body: () => Promise<T>): Promise<T> {
	const key = ctx.ws.runDir("M07", runId);
	const prior = dispatchQueues.get(key) ?? Promise.resolve();
	let release!: () => void;
	const turn = new Promise<void>((resolve) => { release = resolve; });
	const tail = prior.then(() => turn);
	dispatchQueues.set(key, tail);
	await prior;
	const lockDir = path.join(key, ".delegate-lock");
	let acquired = false;
	try {
		try { await mkdir(lockDir); acquired = true; }
		catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new HarnessError("m07.concurrent", "another process owns this goal's task dispatch; verify it has stopped before retrying");
			throw error;
		}
		return await body();
	} finally {
		try { if (acquired) await rmdir(lockDir); }
		finally { release(); if (dispatchQueues.get(key) === tail) dispatchQueues.delete(key); }
	}
}
function nonempty(value: string, label: string): string {
	if (!value?.trim()) throw new HarnessError("m07.input", `${label} 不能为空`);
	return value.trim();
}

function normalizedUnique(values: string[], label: string): string[] {
	const result = values.map((value) => nonempty(value, label));
	if (new Set(result).size !== result.length) throw new HarnessError("m07.input", `${label} 不能重复`);
	return result;
}

function sameStrings(a: string[], b: string[]): boolean {
	return a.length === b.length && a.every((value, index) => value === b[index]);
}

function modeRank(mode: TaskSpecInput["mode"]): number {
	if (mode === "execute") return 2;
	if (mode === "check") return 1;
	return 0;
}

function sameSupersededObligation(next: TaskSpecInput, previous: M07TaskRecord): boolean {
	return next.objective.trim() === previous.objective && modeRank(next.mode) >= modeRank(previous.mode) && Boolean(next.requireIndependentCheck) === Boolean(previous.requireIndependentCheck) && sameStrings(next.checks, previous.checks) && sameStrings(next.expectedOutputs, previous.expectedOutputs);
}

function inside(root: string, candidate: string): boolean {
	return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

/** The same file-bound gate is used before a loop accepts ready and during final review. */
async function validateCandidateFiles(workDir: string, expectedPaths: string[], lessonDeltaOutput?: string): Promise<{
	expectedOutputs: ExpectedOutputResolution[];
	lessonEvidence: string[];
	lessonDeltaFailure?: string;
}> {
	const expectedOutputs = await resolveExpectedOutputFiles(workDir, expectedPaths);
	if (!lessonDeltaOutput) return { expectedOutputs, lessonEvidence: [] };
	try {
		const root = await realpath(workDir);
		const deltaSource = await realpath(path.join(workDir, lessonDeltaOutput));
		if (!inside(root, deltaSource)) throw new Error("candidate delta escaped task work directory");
		const bytes = await readFile(deltaSource);
		if (bytes.length > 16_000) throw new Error("candidate lesson-delta.json file exceeds 16,000 bytes");
		const delta = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
		if (delta.version !== 1 || !["none", "propose", "amend", "contradict"].includes(String(delta.action)) || !Array.isArray(delta.evidencePaths) || delta.evidencePaths.length > 20 || delta.evidencePaths.some((item) => typeof item !== "string" || !isSafeRelativeOutputPath(item))) throw new Error("candidate delta has invalid schema");
		if (delta.action !== "none" && (typeof delta.observation !== "string" || !delta.observation.trim() || typeof delta.applicability !== "string" || !delta.applicability.trim() || delta.evidencePaths.length === 0)) throw new Error("candidate delta lacks observation, applicability, or evidence");
		if ((delta.action === "amend" || delta.action === "contradict") && (!delta.priorRef || typeof delta.priorRef !== "object" || typeof (delta.priorRef as Record<string, unknown>).storeId !== "string" || typeof (delta.priorRef as Record<string, unknown>).recordId !== "string" || !Number.isInteger((delta.priorRef as Record<string, unknown>).version))) throw new Error("candidate delta revision lacks a pinned priorRef");
		const lessonEvidence: string[] = [];
		for (const item of delta.evidencePaths as string[]) {
			const evidence = await realpath(path.join(workDir, item));
			if (!inside(root, evidence)) throw new Error(`candidate delta evidence escaped task work directory: ${item}`);
			if (!(await stat(evidence)).isFile()) throw new Error(`candidate delta evidence is not a file: ${item}`);
			lessonEvidence.push(evidence);
		}
		return { expectedOutputs, lessonEvidence };
	} catch (error) {
		return { expectedOutputs, lessonEvidence: [], lessonDeltaFailure: `Candidate lesson delta is invalid or missing: ${(error as Error).message}` };
	}
}

async function snapshotRoundForReviewer(workDir: string, destination: string): Promise<number> {
	let bytes = 0;
	await cp(workDir, destination, { recursive: true, filter: async (source) => {
		const info = await lstat(source);
		if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory())) throw new HarnessError("m07.loop-snapshot", "round snapshot contains a symlink or special file");
		if (info.isFile()) bytes += info.size;
		if (bytes > 64_000_000) throw new HarnessError("m07.loop-snapshot", "round snapshot exceeds 64 MB");
		return true;
	} });
	return bytes;
}

/** Preserve a long builder report as exact, readable UTF-8 segments in the reviewer's frozen grant. */
async function freezeBuilderReportForReviewer(report: string, reviewerRoot: string, snapshotBytes: number): Promise<string> {
	const reportBytes = Buffer.byteLength(report, "utf8");
	if (snapshotBytes + reportBytes > 64_000_000) throw new HarnessError("m07.loop-snapshot", "reviewer snapshot including full builder report exceeds 64 MB");
	const folder = `.m07-builder-report-${randomUUID()}`;
	const reportDir = path.join(reviewerRoot, folder);
	await mkdir(reportDir);
	const segments: string[] = [];
	let current = "", currentBytes = 0;
	for (const character of report) {
		const size = Buffer.byteLength(character, "utf8");
		if (currentBytes + size > 8_000 && current) { segments.push(current); current = ""; currentBytes = 0; }
		current += character; currentBytes += size;
	}
	if (current) segments.push(current);
	for (const [index, segment] of segments.entries())
		await writeFileAtomic(path.join(reportDir, `part-${String(index + 1).padStart(6, "0")}.txt`), segment);
	return `The complete builder report (${reportBytes} UTF-8 bytes) is frozen, without inserted or omitted characters, into ${segments.length} ordered files ${folder}/part-000001.txt through ${folder}/part-${String(segments.length).padStart(6, "0")}.txt so material_read can access even a very long line. Read every part (and use offset/limit within a part if needed) before deciding; concatenating the parts without separators reconstructs the original. If you cannot inspect all relevant content, return blocked and explain what was unread. A file path alone is not evidence of having read it.`;
}

interface BranchManifestV1 {
	version: 1;
	parentRunId: string;
	parentTaskId: string;
	parentWorkRoot: string;
	authorizedChildRootBase: string;
	frozenWorkRoot: string;
	problemSourcePath: string;
	frozenProblemPath: string;
	knowledgeSnapshot?: string;
	m04BaselineRunId?: string;
	forkWorkspaceAuthority: { version: 1; parentRoot: string; authorizedChildRootBase: string; childWorkLeaf: string; frozenEvidenceRoot: string; files: Array<{ sourcePath: string; frozenPath: string; bytes: number }> };
	files: Array<{ relativePath: string; historicalPath: string; frozenPath: string; bytes: number }>;
}

function forbiddenBranchEvidence(relative: string): boolean {
	return relative.split(path.sep).some((part) => /^(?:\.git|\.ssh|\.aws|\.npmrc|\.pypirc|\.netrc|\.env(?:\..*)?|id_[a-z0-9_-]+)$/i.test(part) || /(?:^|[-_.])(?:api[-_]?key|password|oauth|service[-_]?account|credential|secret|token|session|auth)(?:[-_.]|$)/i.test(part) || /\.(?:jsonl|pem|key|p12|pfx)$/i.test(part));
}

/** Freeze only bounded task work evidence. Auth/session-like files fail closed rather than entering another execution root. */
async function freezeBranchWork(goal: CurrentGoal, task: M07TaskRecord): Promise<{ manifestPath: string; workSnapshotRoot: string; problemSnapshotCopy: string }> {
	const parentTaskDir = path.dirname(task.workDir);
	if ((await lstat(task.workDir)).isSymbolicLink()) throw new HarnessError("m07.branch-evidence", "task work directory was replaced by a symlink");
	const sourceRoot = await realpath(task.workDir);
	if (!inside(await realpath(parentTaskDir), sourceRoot)) throw new HarnessError("m07.branch-evidence", "task work directory escaped its task root");
	const root = path.join(parentTaskDir, "branch-source");
	const workSnapshotRoot = path.join(root, "work-snapshot");
	await mkdir(root, { recursive: false });
	const files: BranchManifestV1["files"] = [];
	let totalBytes = 0;
	await cp(sourceRoot, workSnapshotRoot, { recursive: true, filter: async (source) => {
		const relative = path.relative(sourceRoot, source);
		if (relative && forbiddenBranchEvidence(relative)) throw new HarnessError("m07.branch-evidence", `unsafe auth/session-like source cannot be forked: ${relative}`);
		const info = await lstat(source);
		if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory())) throw new HarnessError("m07.branch-evidence", "branch evidence contains a symlink or special file");
		if (info.isFile()) {
			totalBytes += info.size;
			files.push({ relativePath: relative, historicalPath: path.join(sourceRoot, relative), frozenPath: path.join(workSnapshotRoot, relative), bytes: info.size });
		}
		if (totalBytes > 64_000_000) throw new HarnessError("m07.branch-evidence", "branch evidence exceeds 64 MB");
		return true;
	} });
	const manifestPath = path.join(root, "manifest.json");
	for (const file of files) {
		if (!(await readFile(file.historicalPath)).equals(await readFile(file.frozenPath))) throw new HarnessError("m07.branch-evidence", `task work changed during branch evidence freeze: ${file.relativePath}`);
	}
	const problemInfo = await lstat(goal.problemSnapshotPath);
	if (!problemInfo.isFile() || problemInfo.isSymbolicLink() || totalBytes + problemInfo.size > 64_000_000) throw new HarnessError("m07.branch-evidence", "original problem snapshot is not a bounded regular file");
	const problemSnapshotCopy = path.join(root, "problem-snapshot.md");
	await copyFile(goal.problemSnapshotPath, problemSnapshotCopy);
	if (!(await readFile(goal.problemSnapshotPath)).equals(await readFile(problemSnapshotCopy))) throw new HarnessError("m07.branch-evidence", "original problem snapshot changed while freezing");
	const authorizedChildRootBase = await realpath(path.dirname(parentTaskDir));
	const manifest: BranchManifestV1 = { version: 1, parentRunId: goal.runId, parentTaskId: task.taskId, parentWorkRoot: sourceRoot, authorizedChildRootBase, frozenWorkRoot: workSnapshotRoot, problemSourcePath: goal.problemSnapshotPath, frozenProblemPath: problemSnapshotCopy, knowledgeSnapshot: goal.knowledgeSnapshot, m04BaselineRunId: goal.m04BaselineRunId, forkWorkspaceAuthority: { version: 1, parentRoot: sourceRoot, authorizedChildRootBase, childWorkLeaf: path.basename(sourceRoot), frozenEvidenceRoot: workSnapshotRoot, files: files.map((file) => ({ sourcePath: file.historicalPath, frozenPath: file.frozenPath, bytes: file.bytes })) }, files };
	await writeFileAtomic(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
	for (const file of files) await chmod(file.frozenPath, 0o444);
	const directories = [workSnapshotRoot];
	for (const file of files) { let current = path.dirname(file.frozenPath); while (inside(workSnapshotRoot, current) && !directories.includes(current)) { directories.push(current); current = path.dirname(current); } }
	// Keep directories owner-writable for normal workspace cleanup. File mode deters
	// accidental edits; native execution is not an OS sandbox against the same UID.
	for (const directory of directories.sort((a, b) => b.length - a.length)) await chmod(directory, 0o755);
	await chmod(manifestPath, 0o444);
	await chmod(problemSnapshotCopy, 0o444);
	return { manifestPath, workSnapshotRoot, problemSnapshotCopy };
}

async function loadBranchManifest(source: NonNullable<M07TaskRecord["branchSource"]>, parentRunId: string, parentTaskId: string): Promise<BranchManifestV1> {
	let manifest: BranchManifestV1;
	try {
		const bytes = await readFile(source.manifestPath);
		if (!(await readFile(source.checkpoint.manifestSnapshot)).equals(bytes)) throw new Error("manifest differs from checkpoint copy");
		manifest = JSON.parse(bytes.toString("utf8")) as BranchManifestV1;
	}
	catch { throw new HarnessError("m07.branch", "frozen parent evidence manifest is unavailable"); }
	if (manifest.version !== 1 || manifest.parentRunId !== parentRunId || manifest.parentTaskId !== parentTaskId || manifest.authorizedChildRootBase !== path.dirname(path.dirname(manifest.parentWorkRoot)) || manifest.frozenWorkRoot !== source.workSnapshotRoot || manifest.frozenProblemPath !== source.problemSnapshotCopy || !Array.isArray(manifest.files) || manifest.files.some((file) => !Number.isSafeInteger(file.bytes) || file.bytes < 0) || manifest.files.reduce((sum, file) => sum + file.bytes, 0) > 64_000_000) throw new HarnessError("m07.branch", "frozen parent evidence manifest does not match the requested source");
	if (JSON.stringify(manifest.forkWorkspaceAuthority) !== JSON.stringify({ version: 1, parentRoot: manifest.parentWorkRoot, authorizedChildRootBase: manifest.authorizedChildRootBase, childWorkLeaf: path.basename(manifest.parentWorkRoot), frozenEvidenceRoot: manifest.frozenWorkRoot, files: manifest.files.map((file) => ({ sourcePath: file.historicalPath, frozenPath: file.frozenPath, bytes: file.bytes })) })) throw new HarnessError("m07.branch", "fork workspace authority does not match frozen evidence files");
	if ((await lstat(source.problemSnapshotCopy)).isSymbolicLink() || !(await lstat(source.problemSnapshotCopy)).isFile()) throw new HarnessError("m07.branch", "frozen problem evidence is unavailable");
	const snapshotRoot = await realpath(source.workSnapshotRoot);
	for (const file of manifest.files) {
		if (!file.relativePath || path.isAbsolute(file.relativePath) || file.relativePath.split(path.sep).includes("..") || forbiddenBranchEvidence(file.relativePath) || file.historicalPath !== path.join(manifest.parentWorkRoot, file.relativePath) || file.frozenPath !== path.join(source.workSnapshotRoot, file.relativePath)) throw new HarnessError("m07.branch", "frozen evidence mapping is unsafe");
		const sourceInfo = await lstat(file.frozenPath);
		const actual = await realpath(file.frozenPath);
		if (sourceInfo.isSymbolicLink() || !inside(snapshotRoot, actual) || !sourceInfo.isFile() || sourceInfo.size !== file.bytes) throw new HarnessError("m07.branch", "frozen evidence file is unavailable or changed");
	}
	return manifest;
}

function statePath(ctx: StageContext, runId: string): string {
	return path.join(ctx.ws.runDir("M07", runId), STATE);
}

function taskId(goal: CurrentGoal): string {
	return `T${String(goal.tasks.length + 1).padStart(3, "0")}`;
}

async function save(ctx: StageContext, goal: CurrentGoal): Promise<void> {
	goal.updatedAt = nowIso();
	await writeFileAtomic(statePath(ctx, goal.runId), `${JSON.stringify(goal, null, 2)}\n`);
}

async function load(ctx: StageContext, runId: string): Promise<CurrentGoal> {
	try {
		return JSON.parse(await readFile(statePath(ctx, runId), "utf8")) as CurrentGoal;
	} catch (error) {
		throw new HarnessError("m07.missing", `找不到 M07 目标 ${runId}：${(error as Error).message}`);
	}
}

async function activePolicySnapshot(ctx: StageContext): Promise<{ policy: BudgetPolicy; versionId: string }> {
	const pointerPath = path.join(ctx.ws.root, ".agent", "improvement", "active.json");
	for (let attempt = 0; attempt < 3; attempt++) {
		const before = await readTextIfExists(pointerPath);
		const policy = await loadActiveBudgetPolicy(ctx.ws.root);
		const after = await readTextIfExists(pointerPath);
		if (before !== after) continue;
		if (!before) return { policy, versionId: "builtin-default" };
		let parsed: unknown;
		try { parsed = JSON.parse(before); } catch { throw new HarnessError("improvement.active", "active.json 不是合法 JSON"); }
		return { policy, versionId: validateActiveBudgetPointer(parsed).versionId };
	}
	throw new HarnessError("m07.policy-race", "活动预算策略在 M07 begin 期间连续变化；未冻结不一致快照，请重试 begin");
}

function frozenPolicy(goal: CurrentGoal): BudgetPolicy {
	if (!goal.budgetPolicy || !goal.budgetPolicyVersionId || !goal.budgetPolicyFrozenAt) throw new HarnessError("m07.policy-legacy", `M07 目标 ${goal.runId} 创建于策略冻结机制之前；可查看，但不得悄悄套用当前 active policy 继续委派或生成反馈，请新建目标`);
	return validateBudgetPolicy(goal.budgetPolicy);
}

async function verifyFrozenWorkflowMethod(ctx: StageContext, goal: CurrentGoal, registeredStores?: ReadonlyMap<string, KnowledgeStore>, task?: TaskSpecInput): Promise<void> {
	if (!goal.workflowMethod) return;
	if (task) {
		const provider = createExperienceProvider(ctx.store, registeredStores);
		for (const targetKind of ["executor", "improver"] as const) {
			const requestedRefs = goal.workflowMethod.requiredExperienceRefs.filter((item) => item.targetKind === targetKind).map((item) => item.ref);
			if (!requestedRefs.length) continue;
			const applicability = targetKind === "executor"
				? { stage: "M07", tags: [goal.workflowMethod.artifact.slot, task.mode, ...(task.experienceTags ?? [])], contextRefs: task.experienceContextRefs }
				: { stage: "method-research", tags: ["cpu-response-identification"] };
			const selection = await provider.select({ targetKind, applicability, requestedRefs, expectedSnapshotId: goal.knowledgeSnapshot, maxRecords: 100, maxChars: 100_000 });
			if (selection.status !== "ready" || selection.selected.length !== requestedRefs.length) throw new HarnessError("m07.workflow-method", "frozen method necessary experience is unavailable or not applicable to this task");
		}
	}
	const refs = new Map<string, KnowledgeRef>();
	for (const item of goal.workflowMethod.requiredExperienceRefs) refs.set(`${item.ref.storeId}/${item.ref.recordId}@${item.ref.version}`, item.ref);
	for (const ref of goal.workflowMethod.requiredKnowledgeRefs) refs.set(`${ref.storeId}/${ref.recordId}@${ref.version}`, ref);
	await verifyRequiredKnowledge(ctx.ws.root, [...refs.values()], goal.knowledgeSnapshot, registeredStores);
}

export interface FormalBaseline { run: StageRunRecord; knowledgeSnapshot?: string }

export async function latestFormalBaseline(ctx: StageContext): Promise<FormalBaseline | undefined> {
	let run: StageRunRecord | undefined;
	try { run = await ctx.ws.latestRun("M04"); }
	catch (error) {
		if (error instanceof HarnessError && error.code === "run.order") throw new HarnessError("m07.baseline", "无法确定最新正式基线；M04 创建顺序存在歧义，不得回退到任一候选");
		throw error;
	}
	if (!run) return undefined;
	if (run.status !== "completed") throw new HarnessError("m07.baseline", `最新 M04 运行 ${run.runId} 状态为 ${run.status}，不得回退到更旧基线`);
	if (run.failures.length) throw new HarnessError("m07.baseline", `最新 M04 运行 ${run.runId} 含未解决失败，不能作为正式基线：${run.failures.join("；")}`);
	const proposal = run.outputs.find((item) => item.label === "知识提案");
	const merge = run.outputs.find((item) => item.label === "合入结果");
	if (proposal && !merge) throw new HarnessError("m07.baseline", `最新 M04 运行 ${run.runId} 产生了知识提案但未成功合入，不能作为正式基线`);
	let knowledgeSnapshot = run.knowledgeSnapshot;
	if (merge) {
		try {
			const parsed = JSON.parse(await readFile(merge.path, "utf8")) as { snapshot?: { id?: unknown } };
			if (typeof parsed.snapshot?.id !== "string" || !parsed.snapshot.id) throw new Error("缺少 snapshot.id");
			knowledgeSnapshot = parsed.snapshot.id;
		} catch (error) {
			throw new HarnessError("m07.baseline", `最新 M04 运行 ${run.runId} 的合入结果无法确定知识快照，不能作为正式基线：${(error as Error).message}`);
		}
	}
	return { run, knowledgeSnapshot };
}

async function requireCurrentFormalBaseline(ctx: StageContext, goal: CurrentGoal): Promise<void> {
	if (!goal.formalBaseline) return;
	const baseline = await latestFormalBaseline(ctx);
	if (!baseline || baseline.run.runId !== goal.m04BaselineRunId || baseline.knowledgeSnapshot !== goal.knowledgeSnapshot) {
		throw new HarnessError("m07.baseline", `M07 目标 ${goal.runId} 的正式基线已不是最新可用 M04；先处理最新运行并显式刷新基线`);
	}
}

function requireActive(goal: CurrentGoal): void {
	if (goal.lifecycle !== "active") throw new HarnessError("m07.finished", `M07 目标 ${goal.runId} 已结束，恢复只可查看，不能自动重跑`);
	if (goal.executionState && goal.executionState.attempts.find((attempt) => attempt.id === goal.executionState?.activeAttemptId)?.state !== "running") throw new HarnessError("m07.suspended", `M07 目标 ${goal.runId} 的执行尝试未运行；先经宿主控制面恢复`);
}

function nextAttemptId(goal: CurrentGoal): string { return `A${String((goal.executionState?.attempts.length ?? 0) + 1).padStart(3, "0")}`; }

function sameProcess(a: ProcessIdentityV1, b: ProcessIdentityV1): boolean {
	return a.hostId === b.hostId && a.bootId === b.bootId && a.pid === b.pid && a.processStartToken === b.processStartToken;
}

function validateRecoveryDescriptor(goal: CurrentGoal, descriptor: RunDescriptorV1, expectedAttemptId: string): RunDescriptorV1 {
	const parsed = parseRunDescriptor(descriptor);
	if (parsed.goalRunId !== goal.runId || parsed.attemptId !== expectedAttemptId || parsed.workspaceId !== goal.executionState?.attempts[0]?.runDescriptor.workspaceId) throw new HarnessError("m07.recovery", "恢复运行描述与目标、工作区或新 attempt 不匹配");
	return parsed;
}

async function confinedExistingFile(ctx: StageContext, requested: string): Promise<string> {
	const root = await realpath(ctx.ws.root);
	const candidate = path.resolve(ctx.ws.root, requested);
	let resolved: string;
	try { resolved = await realpath(candidate); } catch { throw new HarnessError("m07.path", `输入或证据文件不存在：${requested}`); }
	if (!inside(root, resolved)) throw new HarnessError("m07.path", `路径逃逸工作区：${requested}`);
	if (!(await lstat(resolved)).isFile()) throw new HarnessError("m07.path", `只接受现有文件：${requested}`);
	return resolved;
}

function uniqueName(index: number, source: string): string {
	return `${String(index + 1).padStart(3, "0")}-${path.basename(source).replace(/[^a-zA-Z0-9._-]/g, "_")}`;
}

interface TextInventory { text?: string; chars: number; bytes: number; path: string }

/** Count UTF-8 bytes and decoded UTF-16 units without retaining deferred text. */
async function textInventory(source: string, displayPath: string, retainThroughChars: number): Promise<TextInventory> {
	const decoder = new StringDecoder("utf8");
	let chars = 0, bytes = 0;
	let retained: string[] | undefined = [];
	const accept = (text: string) => {
		chars += text.length;
		if (retained && chars <= retainThroughChars) retained.push(text);
		else retained = undefined;
	};
	for await (const chunk of createReadStream(source)) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		bytes += buffer.length;
		accept(decoder.write(buffer));
	}
	accept(decoder.end());
	return { text: retained?.join(""), chars, bytes, path: displayPath };
}

class SnapshotBudgetExceeded extends Error {}

async function copySnapshotBounded(source: string, snapshot: string, maxBytes: number): Promise<number> {
	await mkdir(path.dirname(snapshot), { recursive: true });
	let copied = 0;
	try {
		await pipeline(createReadStream(source), new Transform({ transform(chunk: Buffer, _encoding, callback) {
			copied += chunk.length;
			callback(copied > maxBytes ? new SnapshotBudgetExceeded("projection snapshot budget exceeded") : null, copied > maxBytes ? undefined : chunk);
		} }), createWriteStream(snapshot, { flags: "wx" }));
		return copied;
	} catch (error) {
		await unlink(snapshot).catch(() => undefined);
		throw error;
	}
}

function omissionLine(item: { chars: number; bytes: number; path: string }, shown: number): string {
	const shownRange = shown > 0 ? `1–${shown}` : "无（0 字符）";
	const unreadRange = shown < item.chars ? `${shown + 1}–${item.chars}` : "无";
	return `- ${item.path}；${item.bytes} bytes / ${item.chars} 字符；已显示字符 ${shownRange}；未显示字符 ${unreadRange}；原文完整保留，可用只读工具按需读取。`;
}

function projectionMaterial(ctx: StageContext, event: ProjectionEventV1, ordinal: number, role: ProjectionMaterialV1["role"], source: string, type: "text" | "binary"): ProjectionMaterialV1 {
	const snapshotPath = path.join("projection-materials", event.eventId, `${String(ordinal + 1).padStart(3, "0")}-${path.basename(source)}`);
	return { ordinal, role, mediaType: type, sourcePath: path.relative(ctx.ws.root, source), snapshotPath, availability: "available", snapshotStatus: "unavailable", laterReadVersion: "unknown", decision: type === "binary" ? "binary" : "unavailable" };
}

async function captureMaterial(ctx: StageContext, event: ProjectionEventV1, material: ProjectionMaterialV1, source: string, retainThroughChars: number): Promise<TextInventory | undefined> {
	const snapshot = path.join(ctx.ws.runDir("M07", event.m07RunId), material.snapshotPath!);
	try {
		const sourceInfo = await stat(source);
		const budget = event.captureBudget;
		const remainingCall = Math.max(0, budget.perCallBytes - budget.usedCallBytes);
		const remainingRun = Math.max(0, budget.perRunBytes - budget.usedRunBytesAtStart - budget.usedCallBytes);
		const cap = Math.min(budget.perMaterialBytes, remainingCall, remainingRun);
		const reason: ProjectionMaterialV1["captureReason"] = sourceInfo.size > budget.perMaterialBytes ? "per-material" : sourceInfo.size > remainingCall ? "per-call" : "per-run";
		if (sourceInfo.size > cap) {
			material.snapshotStatus = "budget-exceeded";
			material.captureReason = reason;
			material.snapshotPath = undefined;
			material.utf8Bytes = sourceInfo.size;
			if (material.mediaType === "binary") return undefined;
			const inventory = await textInventory(source, material.sourcePath, retainThroughChars);
			material.utf8Bytes = inventory.bytes;
			material.utf16CodeUnits = inventory.chars;
			return inventory;
		}
		let captured = 0;
		try { captured = await copySnapshotBounded(source, snapshot, cap); }
		catch (error) {
			if (!(error instanceof SnapshotBudgetExceeded)) throw error;
			material.snapshotStatus = "budget-exceeded";
			material.captureReason = cap === budget.perMaterialBytes ? "per-material" : cap === remainingCall ? "per-call" : "per-run";
			material.snapshotPath = undefined;
			if (material.mediaType === "binary") { material.utf8Bytes = (await stat(source)).size; return undefined; }
			const inventory = await textInventory(source, material.sourcePath, retainThroughChars);
			material.utf8Bytes = inventory.bytes;
			material.utf16CodeUnits = inventory.chars;
			return inventory;
		}
		budget.usedCallBytes += captured;
		material.snapshotStatus = "captured";
		material.utf8Bytes = captured;
		material.snapshotMtimeMs = (await stat(snapshot)).mtimeMs;
		if (material.mediaType === "binary") {
			return undefined;
		}
		const inventory = await textInventory(snapshot, material.sourcePath, retainThroughChars);
		material.utf8Bytes = inventory.bytes;
		material.utf16CodeUnits = inventory.chars;
		return inventory;
	} catch (error) {
		material.availability = (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unreadable";
		material.snapshotStatus = "unavailable";
		material.decision = "unavailable";
		material.reason = "unavailable";
		throw error;
	}
}

async function createProjectionObservation(ctx: StageContext, goal: CurrentGoal, purpose: ProjectionEventV1["purpose"], policy: BudgetPolicy, limits: ProjectionSnapshotLimits, taskId?: string): Promise<ProjectionEventV1> {
	return newProjectionEvent({ callOrdinal: await nextProjectionOrdinal(ctx.ws, goal.runId), purpose, m07RunId: goal.runId, taskId, policyVersionId: goal.budgetPolicyVersionId!, policy, methodBinding: goal.methodBinding, tokenMeasurement: { unit: "provider-token", status: "unavailable" }, captureBudget: { ...limits, usedRunBytesAtStart: await capturedRunBytes(ctx.ws, goal.runId), usedCallBytes: 0 }, projectionStatus: "unavailable", deliveryStatus: "not-submitted", materials: [] });
}

async function taskMessage(ctx: StageContext, goal: CurrentGoal, taskId: string, task: TaskSpecInput, copies: M07TaskRecord["inputCopies"], knowledgePack: string | undefined, policy: BudgetPolicy, limits: ProjectionSnapshotLimits, operationId?: string): Promise<{ message: string; event: ProjectionEventV1 }> {
	const event = await createProjectionObservation(ctx, goal, "task-message", policy, limits, taskId);
	const planCopy = task.planInput ? copies.find((item) => item.source === task.planInput)?.copy : undefined;
	const resourceCopies = (task.resourceInputs ?? []).map((item) => ({ ...item, copy: copies.find((copy) => copy.source === item.input)?.copy }));
	const actualInputs: string[] = [];
	const inventory: string[] = [];
	let inlineChars = 0;
	try {
	for (const item of copies) {
		const relative = path.relative(path.dirname(path.dirname(item.copy)), item.copy);
		const materialRecord = projectionMaterial(ctx, event, event.materials.length, "task-input", item.copy, item.mediaType);
		materialRecord.originPath = path.relative(ctx.ws.root, item.source);
		event.materials.push(materialRecord);
		if (item.mediaType === "text") {
			const material = (await captureMaterial(ctx, event, materialRecord, item.copy, Math.min(policy.maxInlineFileChars, policy.maxAggregateInlineChars - inlineChars)))!;
			material.path = relative;
			materialRecord.aggregateBefore = inlineChars;
			const projection = projectInline(policy, material.chars, inlineChars);
			const canInline = projection.inline;
			materialRecord.aggregateAfter = projection.nextAggregateChars;
			materialRecord.decision = canInline ? "inline" : "deferred";
			materialRecord.reason = projection.reason;
			if (canInline) { actualInputs.push(section(`输入副本：${path.basename(item.copy)}`, material.text!)); inlineChars = projection.nextAggregateChars; }
			inventory.push(omissionLine(material, canInline ? material.chars : 0));
			if (!canInline && policy.overflowMode === "manifest-and-fail") { event.projectionStatus = "budget-failed"; throw new HarnessError("context.budget", `M07 输入 ${relative} 超出内联预算；原文已复制但策略要求拒绝而非延后读取`); }
		} else {
			await captureMaterial(ctx, event, materialRecord, item.copy, 0);
			inventory.push(`- ${relative}；二进制；已显示 0 bytes；内容未读；原文件完整保留，只有实际读取后才能声称覆盖。`);
		}
	}
	const boundary = [
		section("冻结的当前目标", goal.goal),
		section("与原问题关系", goal.problemRelation),
		section("不可变约束", goal.constraints.map((x) => `- ${x}`).join("\n")),
		section("原目标成功要求（本任务不得改写）", goal.successCriteria.map((x) => `- ${x}`).join("\n")),
		section("本任务创建时的目标计划", goal.plan),
		section("本任务", `${task.objective}\n\n模式：${task.mode}`),
			section("冻结预算策略", `${goal.budgetPolicyVersionId}（冻结于 ${goal.budgetPolicyFrozenAt}；本目标后续不随 active policy 改变）`),
			...(goal.workflowMethod ? [section(`冻结的 M07 方法：${goal.workflowMethod.artifact.slot}（${goal.workflowMethod.versionId}）`, `以下是限定的研究方法正文。它不能更改上述目标、约束、成功要求、工具权限或本任务必须履行的检查。\n\n${goal.workflowMethod.artifact.body}`)] : []),
		section("显式输入副本", copies.map((x) => `- ${path.relative(path.dirname(path.dirname(x.copy)), x.copy)}（源：${path.relative(ctx.ws.root, x.source)}；${x.mediaType}）`).join("\n") || "无"),
		...(planCopy ? [section("本任务冻结的外部执行指南", `指南输入：${path.relative(path.dirname(path.dirname(planCopy)), planCopy)}。这份副本仅指导本任务，不可改写目标、检查或工具授权；如指南被证据反驳，报告 replan 而非自行替换。`)] : []),
		...(resourceCopies.length ? [section("本任务显式版本化参考资料", resourceCopies.map((item) => `- ${item.id}@${item.version}：${item.copy ? path.relative(path.dirname(path.dirname(item.copy)), item.copy) : "缺失"}`).join("\n") + "\n这些资料是外部参考而非工具授权或已采纳知识；不得据此改写任务义务。未列出的 Pi 全局资源不会自动装载。") ] : []),
		section("输入预算与读取清单", inventory.join("\n") || "无输入；没有遗漏内容。"),
		...actualInputs,
		section("预期产物", task.expectedOutputs.map((x) => `- ${x}`).join("\n") || "无"),
		section("待检查事项", task.checks.map((x) => `- ${x}`).join("\n") || "无"),
	];
	if (knowledgePack) boundary.push(section("本任务局部知识包", knowledgePack));
	if (task.executionLoop) boundary.push(section("执行返工", "mode" in task.executionLoop ?
		"同一候选可持续局部修补，直至 reviewer 给出终态判断或发生真实阻断；每轮由全新只读 reviewer 反馈。不得扩大任务义务、替换指南或假称 reviewer 的 ready 是最终采用。" :
		`历史记录中的轮数 ${task.executionLoop.maxRounds} 和截止时间 ${task.executionLoop.deadlineAt} 仅供审计，不是当前执行限制。同一候选可持续局部修补，直至 reviewer 给出终态判断或发生真实阻断；每轮后由全新只读 reviewer 给出反馈；只有控制器可决定是否再次提示。不得扩大任务义务、替换指南或假称 reviewer 的 ready 是最终采用。`));
	if (task.lessonDeltaOutput) boundary.push(section("候选经验回流", `将本轮候选经验写入 ${task.lessonDeltaOutput}，JSON 格式为 {"version":1,"action":"none|propose|amend|contradict","observation":"...","hypothesis":"...","applicability":"...","evidencePaths":["本任务 work 内相对路径"]}。none 合法；不确定因果写为假设。仅修正本任务尚未入库的候选时仍用 propose；amend 或 contradict 只用于修订/反驳已存在且已固定身份的知识记录，必须加 "priorRef":{"storeId":"...","recordId":"...","version":1}，不得猜测 ID。此文件是待 M04 处理的候选，不能自称已采纳知识。`));
	if (task.mode === "execute") boundary.push(section("外部执行与可消耗资源", `本任务控制操作 ID：${operationId ?? "旧目标无操作登记"}。若执行有真实副作用的远端动作，保存实际参数、外部请求/结果 ID、响应和可用的查询方法；在响应丢失后先查询，不能仅凭超时重发。任务级 ID 是恢复索引，只有远端明确支持时才能作为幂等键，不能声称 exactly-once。\n\n如任务涉及真实提交、评测、远程实验或其他可能消耗配额/费用/机会的动作：先用已提供的只读能力或额度接口核对接入和当前状态，并先做本地可完成的语法、类型、编译与兼容性预检。这不禁止任务已授权的真实实验，已授权平台评测/实验产生的结果属于本任务实测证据。每次真实动作都要记录实际结果和资源消耗；失败若仍消耗了资源，同样记录已消耗量、可见剩余量与恢复条件。平台配额不明时如实记录未知，不猜测统一配额。本地命令或客户端成功退出不等于远程实验通过。显式输入和原问题允许使用；若需取得新的外部研究参考资料并用于推理，将具体缺口报回主会话走 M05/M06→M04，不在 execute 任务里通过 bash 另造获取和采用链。`));
	boundary.push("会话返回只表示任务已返回，不表示成果被主 Agent 接受。请如实列出实际动作、产物、失败、未执行项和限制。");
	boundary.push("产物路径规则：expectedOutputs 必须是当前任务工作目录内的精确相对路径；说明写在 objective 或 report.md。所有实际写盘必须落在当前工作目录内，不要写到工作区根目录或绝对路径。");
	const message = boundary.join("\n\n");
	if (message.length + systemPromptFor(task.mode === "check" ? "reviewer" : "execution").length > policy.maxPromptChars) { event.projectionStatus = "budget-failed"; throw new HarnessError("context.budget", `M07 控制事实与允许内联内容共 ${message.length} 字符，超过 prompt 预算 ${policy.maxPromptChars}；未静默截断`); }
	event.projectionStatus = "materialized";
	event.outputPath = path.relative(ctx.ws.runDir("M07", goal.runId), path.join(ctx.ws.runDir("M07", goal.runId), "tasks", taskId, "message.md"));
	return { message, event };
	} finally { await writeProjectionEvent(ctx.ws, event); }
}

async function writeFeedback(ctx: StageContext, goal: CurrentGoal, limits: ProjectionSnapshotLimits, checkpointRoot?: string): Promise<string> {
	const policy = frozenPolicy(goal);
	const event = await createProjectionObservation(ctx, goal, "feedback", policy, limits);
	try {
	const displayPath = (file: string) => path.relative(checkpointRoot ?? ctx.ws.root, file);
	const lines = [
		"# M07 实际执行反馈包", "", `- 目标：${goal.goal}`, `- 与原问题关系：${goal.problemRelation}`, `- 目标结果：${goal.outcome ?? "进行中"}`, `- 返回路径：${goal.returnPath ?? "未选择"}`, `- 正式基线：${goal.formalBaseline ? "是" : "否（探索性）"}`, `- 知识快照：${goal.knowledgeSnapshot ?? "无"}`, `- 冻结预算策略：${goal.budgetPolicyVersionId}（${goal.budgetPolicyFrozenAt}）`, "",
		...(checkpointRoot ? ["- 这是 active 目标的非终态开发 checkpoint；不改变原成功要求，不表示 fulfilled，也不表示 M04 已核验全部证据。", "- 本次 M04 只允许读取本 checkpoint 冻结目录，所有材料路径均相对于该目录。", ""] : []),
		...(goal.checkpointScope ? [`- 本批已选任务 ${goal.checkpointScope.selectedTaskIds.length}：${goal.checkpointScope.selectedTaskIds.slice(0, 20).join("、") || "无"}${goal.checkpointScope.selectedTaskIds.length > 20 ? "（其余见 manifest.json）" : ""}；未选任务 ${goal.checkpointScope.omittedTaskIds.length}：${goal.checkpointScope.omittedTaskIds.slice(0, 20).join("、") || "无"}${goal.checkpointScope.omittedTaskIds.length > 20 ? "（其余见 manifest.json）" : ""}。未选任务的评审证据未交接，完整任务范围见 manifest.json。`, ""] : []),
		...(goal.workflowMethod ? [`- 实际装载的 M07 方法：${goal.workflowMethod.versionId}（${goal.workflowMethod.artifact.slot}）；仅作为研究方法，不改变原成功要求或 M04 科学判断。`, ""] : []),
		"## 原成功要求", "", ...goal.successCriteria.map((x) => `- ${x}`), "", "## 任务与实际证据", "",
	];
	if (goal.workflowMethod?.artifact.slot === "evidence-handoff") lines.push("## 冻结的证据交接方法", "", "以下方法正文曾作为 M07 任务指导；这里保留其版本与内容以供 M04 核对，实际证据与未执行项仍以本包记录为准。", "", goal.workflowMethod.artifact.body, "");
	for (const task of goal.tasks) {
		lines.push(`### ${task.taskId} ${task.objective}`, "", `- 状态：${task.status}`, `- 模式：${task.mode}`, `- 会话报告：${task.reportPath ? displayPath(task.reportPath) : "未产生"}`, `- 实际读取：${task.readCoverage.join("、") || "无可记录读取"}`);
		if (task.context) lines.push(`- 竞争分支来源：${task.context.parentRunId}/${task.context.parentTaskId}@${task.context.checkpointId}；继承历史不是知识采用，也不代表旧路径在当前分支仍可操作。`);
		for (const artifact of task.review?.artifacts ?? []) lines.push(`- 产物：${displayPath(artifact.path)}（${artifact.mediaType === "text" ? "文本，纳入下方实际内容" : "二进制，未读取内容"}）`);
		for (const check of task.review?.checks ?? []) lines.push(`- 检查 ${check.result}：${check.criterion}；证据 ${check.evidence.map(displayPath).join("、") || "无"}`);
		for (const failure of task.review?.failures ?? []) lines.push(`- 失败：${failure}`);
		for (const item of task.review?.unexecuted ?? []) lines.push(`- 未执行：${item}`);
		for (const limitation of task.review?.limitations ?? []) lines.push(`- 限制：${limitation}`);
		if (task.review?.independentCheck) lines.push(`- 独立检查：${task.review.independentCheck.taskId}；处置：${task.review.independentCheck.disposition}`);
		if (task.executionFailure) lines.push(`- 执行失败：${task.executionFailure}`);
		if (task.toolLog.length) lines.push(`- 工具日志：${JSON.stringify(task.toolLog)}`);
		lines.push("");
	}
	if (goal.branchSelections?.length) lines.push("## 竞争分支比较与选择", "", ...goal.branchSelections.flatMap((selection) => [
		`- 来源 ${selection.parentTaskId}；候选 ${selection.candidates.map((candidate) => `${candidate.taskId}:${candidate.status}[${candidate.checks.map((check) => check.result).join(",") || "no-review"}]`).join("、")}；选择 ${selection.selectedTaskId ?? "无胜者"}。`,
		`- 理由：${selection.rationale}`, "- 以上只是 M07 候选筛选与已记录 checks；M04 仍须实际读取原证据后自行判断经验是否采用。", "",
	]));
	lines.push("## 实际材料清单与预算内内容", "", "清单中的‘已显示’只表示反馈包内联范围；未显示部分没有被本反馈包或后续 M04 自动读取。", "");
	const materialPaths = new Map<string, { role: ProjectionMaterialV1["role"]; optional: boolean }>();
	const addMaterial = (file: string, role: ProjectionMaterialV1["role"], optional = false) => { if (!materialPaths.has(file)) materialPaths.set(file, { role, optional }); };
	for (const task of goal.tasks) {
		if (task.review) addMaterial(task.review.frozenReportPath, "task-report");
		else if (task.reportPath) addMaterial(task.reportPath, "task-report", true);
		for (const artifact of task.review?.artifacts ?? []) addMaterial(artifact.path, "artifact");
		for (const check of task.review?.checks ?? []) for (const evidence of check.evidence) addMaterial(evidence, "check-evidence");
		if (task.review?.independentCheck) addMaterial(task.review.independentCheck.report, "independent-check");
	}
	let aggregateInline = 0;
	for (const [materialPath, { role, optional }] of materialPaths) {
		const relative = path.relative(checkpointRoot ?? ctx.ws.runDir("M07", goal.runId), materialPath);
		const type = mediaType(materialPath);
		const materialRecord = projectionMaterial(ctx, event, event.materials.length, role, materialPath, type);
		event.materials.push(materialRecord);
		if (optional && !existsSync(materialPath)) {
			materialRecord.availability = "missing";
			materialRecord.decision = "unavailable";
			materialRecord.reason = "unavailable";
			lines.push(`### ${relative}`, "", `- ${relative}；未复核会话报告已缺失，内容未内联；本次投影不可重放。`, "");
			continue;
		}
		if (type === "binary") { await captureMaterial(ctx, event, materialRecord, materialPath, 0); lines.push(`### ${relative}`, "", `- ${relative}；${materialRecord.utf8Bytes} bytes；二进制；已显示 0 bytes；内容未读。`, ""); continue; }
		const material = (await captureMaterial(ctx, event, materialRecord, materialPath, Math.min(policy.maxInlineFileChars, policy.maxAggregateInlineChars - aggregateInline)))!;
		material.path = relative;
		materialRecord.aggregateBefore = aggregateInline;
		const projection = projectInline(policy, material.chars, aggregateInline);
		const canInline = projection.inline;
		materialRecord.aggregateAfter = projection.nextAggregateChars;
		materialRecord.decision = canInline ? "inline" : "deferred";
		materialRecord.reason = projection.reason;
		lines.push(`### ${relative}`, "", omissionLine(material, canInline ? material.chars : 0), "");
		if (canInline) { lines.push(material.text!, ""); aggregateInline = projection.nextAggregateChars; }
		else if (policy.overflowMode === "manifest-and-fail") { event.projectionStatus = "budget-failed"; throw new HarnessError("context.budget", `M07 反馈证据 ${relative} 超出内联预算；冻结原文仍保留，策略要求拒绝生成延后读取包`); }
	}
	lines.push("## 原目标验收", "", ...(goal.goalChecks?.map((c) => `- ${c.result}：${c.criterion}；证据 ${c.evidence.map(displayPath).join("、") || "无"}`) ?? ["- 未验收"]), "", "## 用户决定事项", "", ...(goal.decisions.length ? goal.decisions.map((d) => `- ${d.status}：${d.question}${d.decision ? `；决定：${d.decision}` : ""}`) : ["- 无"]), "", "## 总结与限制", "", goal.finishSummary ?? "尚未结束", ...goal.limitations.map((x) => `- ${x}`));
	const feedback = lines.join("\n");
	if (feedback.length > policy.maxFeedbackChars) { event.projectionStatus = "budget-failed"; throw new HarnessError("context.budget", `M07 反馈包的控制事实与预算内清单共 ${feedback.length} 字符，超过上限 ${policy.maxFeedbackChars}；未静默截断`); }
	const target = path.join(checkpointRoot ?? ctx.ws.runDir("M07", goal.runId), "m04-feedback.md");
	await writeFileAtomic(target, feedback);
	event.projectionStatus = "materialized";
	event.outputPath = path.relative(ctx.ws.runDir("M07", goal.runId), target);
	return target;
	} finally { await writeProjectionEvent(ctx.ws, event); }
}

function isFeedbackControlOverflow(error: unknown): boolean {
	return error instanceof HarnessError && error.code === "context.budget" && error.message.startsWith("M07 反馈包的控制事实与预算内清单共 ");
}

async function writeLegacyInterruptFeedback(ctx: StageContext, goal: CurrentGoal): Promise<string> {
	const lines = [
		"# M07 legacy 受控中断反馈包", "",
		`- 目标：${goal.goal}`,
		`- 与原问题关系：${goal.problemRelation}`,
		`- 目标结果：${goal.outcome ?? "blocked"}`,
		`- 返回路径：${goal.returnPath ?? "user"}`,
		"- 冻结预算策略：缺失（旧记录）", "",
		"此旧目标创建时没有冻结预算策略。为保证硬停止可执行，本归档只记录控制事实和证据位置，不读取、不内联、不截断证据正文，也不套用当前 active policy。下列路径存在不表示其内容已被本反馈包核验。", "",
		"## 原成功要求", "", ...goal.successCriteria.map((item) => `- ${item}`), "",
		"## 任务状态与证据位置", "",
	];
	for (const task of goal.tasks) {
		lines.push(`### ${task.taskId} ${task.objective}`, "", `- 状态：${task.status}`, `- 模式：${task.mode}`);
		if (task.reportPath) lines.push(`- 会话报告位置：${path.relative(ctx.ws.root, task.reportPath)}（未由本归档读取）`);
		for (const artifact of task.review?.artifacts ?? []) lines.push(`- 冻结产物位置：${path.relative(ctx.ws.root, artifact.path)}（未由本归档读取）`);
		for (const check of task.review?.checks ?? []) for (const evidence of check.evidence) lines.push(`- 检查证据位置：${path.relative(ctx.ws.root, evidence)}（未由本归档读取）`);
		if (task.executionFailure) lines.push(`- 执行失败：${task.executionFailure}`);
		for (const failure of task.review?.failures ?? []) lines.push(`- 评审失败：${failure}`);
		for (const item of task.review?.unexecuted ?? []) lines.push(`- 未执行：${item}`);
		lines.push("");
	}
	lines.push("## 总结与限制", "", goal.finishSummary ?? "受控中断", ...goal.limitations.map((item) => `- ${item}`), "", "- legacy 归档没有证据正文覆盖，不能作为证据完整性或科学结论证明。", "");
	const target = path.join(ctx.ws.runDir("M07", goal.runId), "m04-feedback.md");
	const feedback = lines.join("\n");
	if (feedback.length > 4_000) throw new HarnessError("context.budget", `M07 legacy 中断控制事实共 ${feedback.length} 字符，超过归档上限 4000；原记录未截断`);
	await writeFileAtomic(target, feedback);
	return target;
}

/** A bounded handoff index; the complete source stays in goal.json and frozen task files. */
async function writeBoundedFeedbackIndex(ctx: StageContext, goal: CurrentGoal, mode: "finish" | "interrupt" | "checkpoint", checkpointRoot?: string): Promise<string> {
	const cap = goal.budgetPolicy ? frozenPolicy(goal).maxFeedbackChars : 4_000;
	const taskCounts = new Map<string, number>();
	for (const task of goal.tasks) taskCounts.set(task.status, (taskCounts.get(task.status) ?? 0) + 1);
	const lines = [
		mode === "finish" ? "# M07 已结束目标：有界反馈索引" : mode === "checkpoint" ? "# M07 active 目标：非终态开发 checkpoint 有界索引" : goal.budgetPolicy ? "# M07 受控中断：仅控制事实" : "# M07 legacy 受控中断反馈包：仅控制事实", "",
		`- M07 runId：${goal.runId}`,
		...(goal.checkpointScope ? [`- 本批已选任务 ${goal.checkpointScope.selectedTaskIds.length}：${goal.checkpointScope.selectedTaskIds.slice(0, 20).join("、") || "无"}${goal.checkpointScope.selectedTaskIds.length > 20 ? "（其余见 manifest.json）" : ""}；未选任务 ${goal.checkpointScope.omittedTaskIds.length}：${goal.checkpointScope.omittedTaskIds.slice(0, 20).join("、") || "无"}${goal.checkpointScope.omittedTaskIds.length > 20 ? "（其余见 manifest.json）" : ""}。未选任务的评审证据未交接。`] : []),
		mode === "checkpoint" ? "- 目标仍 active；M07 run 仍 running。本快照不是目标终态，也不证明原成功要求已满足。" : `- 目标终态：${goal.outcome ?? "未知"}；M07 run 终态：${mode === "interrupt" || goal.outcome === "blocked" ? "failed" : "completed"}。目标结果由控制器硬检查确定，本索引不新增科学结论。`,
		`- 任务总数：${goal.tasks.length}；状态计数：${[...taskCounts].map(([status, count]) => `${status}=${count}`).join("，") || "无任务"}。`,
		`- 完整控制记录：${STATE}（含任务、工具日志、目标检查、限制及原始引用）；M04 可用 m07_evidence_read 对 goal.json 按 offset/limit 分段实际读取。`,
		"- 原证据位置：请按 goal.json 的各任务 reportPath、review.frozenReportPath、review.artifacts 与 review.checks.evidence 定位；文件内容未由本包读取。",
		"- 省略类别：目标与任务长文本、工具日志、检查明细、产物正文、逐项证据清单；没有把这些内容截断后冒充完整反馈。",
		`- 完整反馈失败类别：${goal.feedbackError?.code ?? "unknown"}；详情见 goal.json 的 feedbackError。`,
		mode === "finish" ? "- 这是有界反馈索引，不是完整 M07 科学证据交接。即使目标硬检查为 fulfilled，也不代表 M04 已读完整记录或独立确认科学结论。" : mode === "checkpoint" ? "- 这是非终态开发索引，不是完整科学证据交接。M04 可按需读取冻结材料；不能由本包断言全部材料已读或目标 fulfilled。" : "- 这是退出归档的有界索引，不是完整 M07 科学证据交接。M04 可以读取这些中断事实；不能由本包断言科学验证通过、全部材料已读或目标 fulfilled。",
		...(goal.budgetPolicy ? [] : ["- 冻结预算策略：缺失（旧记录）；未套用当前 active policy。本包不读取、不内联、不截断证据正文。"]),
		"- 后续如需证据，应另按原路径实际读取并记录覆盖范围；路径存在不代表内容已读取。",
	];
	const feedback = lines.join("\n");
	if (feedback.length > cap) throw new HarnessError(mode === "finish" ? "context.budget" : "m07.archive-repair-required", `M07 有界反馈索引 ${feedback.length} 字符超过上限 ${cap}；goal.json 保留完整记录，需修复反馈交接`);
	const target = path.join(checkpointRoot ?? ctx.ws.runDir("M07", goal.runId), "m04-feedback.md");
	await writeFileAtomic(target, feedback);
	return target;
}

/** Freeze only reviewed task evidence and the problem inputs needed by M04. */
async function freezeCheckpoint(ctx: StageContext, goal: CurrentGoal, limits: ProjectionSnapshotLimits, selectedTaskIds: string[]): Promise<M07CheckpointRecord> {
	const runDir = ctx.ws.runDir("M07", goal.runId);
	const checkpointsDir = path.join(runDir, "checkpoints");
	await mkdir(checkpointsDir, { recursive: true });
	let id = "";
	let rootDir = "";
	for (let ordinal = (goal.checkpoints?.length ?? 0) + 1; Number.isSafeInteger(ordinal); ordinal++) {
		const candidateId = `C${String(ordinal).padStart(3, "0")}`;
		const candidateDir = path.join(checkpointsDir, candidateId);
		try {
			await mkdir(candidateDir); // Never overwrite or remove an incomplete prior attempt.
			id = candidateId;
			rootDir = candidateDir;
			break;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
	}
	if (!id) throw new HarnessError("m07.checkpoint", "checkpoint 编号已用尽；本次快照未登记，原目标仍 active");
	const frozen = structuredClone(goal);
	delete frozen.checkpoints;
	const selected = new Set(selectedTaskIds);
	const omittedTaskIds = goal.tasks.filter((task) => !selected.has(task.taskId)).map((task) => task.taskId);
	frozen.checkpointScope = { selectedTaskIds, omittedTaskIds };
	const files: Array<{ sourceRelativePath: string; relativePath: string; bytes: number }> = [];
	const copies = new Map<string, string>();
	let totalBytes = 0;
	const copy = async (source: string, relativePath: string, kind: "review" | "problem" | "raw"): Promise<string> => {
		const sourcePath = path.resolve(source);
		const found = copies.get(sourcePath);
		if (found) return found;
		const info = await lstat(sourcePath);
		if (!info.isFile() || info.isSymbolicLink()) throw new HarnessError("m07.checkpoint", "checkpoint 来源必须是无符号链接的固定文件");
		const expectedRoot = kind === "raw" ? ctx.ws.rawDir : runDir;
		const realSource = await realpath(sourcePath);
		const realRoot = await realpath(expectedRoot);
		if (!inside(realRoot, realSource)) throw new HarnessError("m07.checkpoint", "checkpoint 来源越过允许目录");
		if (kind === "review" && !/^tasks[/\\]T\d{3,}[/\\]review-snapshot[/\\][^/\\]+$/.test(path.relative(realRoot, realSource))) throw new HarnessError("m07.checkpoint", "仅允许复制已评审冻结材料");
		if (kind === "problem" && realSource !== await realpath(goal.problemSnapshotPath)) throw new HarnessError("m07.checkpoint", "原问题来源与 begin 冻结副本不符");
		if (info.size > 8 * 1024 * 1024 || totalBytes + info.size > 64 * 1024 * 1024) throw new HarnessError("m07.checkpoint", "本次 checkpoint 局部冻结材料超过 8 MiB/文件或 64 MiB/批；快照未登记，目标仍 active。可调整待交接材料后重试，不代表全工作流资源耗尽");
		const target = path.join(rootDir, relativePath);
		if (!inside(rootDir, target)) throw new HarnessError("m07.checkpoint", "checkpoint 目标路径非法");
		const copied = await copySnapshotBounded(sourcePath, target, 8 * 1024 * 1024);
		if (copied !== info.size || (await stat(sourcePath)).size !== info.size) throw new HarnessError("m07.checkpoint", "checkpoint 来源在复制期间改变；未登记不完整快照");
		totalBytes += copied;
		copies.set(sourcePath, target);
		files.push({ sourceRelativePath: path.relative(await realpath(ctx.ws.root), realSource), relativePath, bytes: copied });
		return target;
	};
	const problemFile = "problem.md";
	await copy(goal.problemSnapshotPath, problemFile, "problem");
	const rawFiles: Array<{ name: string; relativePath: string }> = [];
	const skippedRaw: string[] = [];
	if (existsSync(ctx.ws.rawDir)) {
		const rawNames = (await readdir(ctx.ws.rawDir)).sort();
		for (const name of rawNames) {
			const source = path.join(ctx.ws.rawDir, name);
			const info = await lstat(source);
			if (!info.isFile()) continue;
			if (!isTextFile(name)) { skippedRaw.push(name); continue; }
			const relativePath = path.join("raw", name);
			await copy(source, relativePath, "raw");
			rawFiles.push({ name, relativePath });
		}
	}
	const remap = async (source: string): Promise<string> => {
		const relative = path.relative(await realpath(runDir), await realpath(source));
		return copy(source, path.join("evidence", relative), "review");
	};
	for (const task of frozen.tasks) {
		// The checkpoint exposes no live work/input directory as readable evidence.
		task.workDir = "";
		task.inputCopies = [];
		task.expectedOutputPaths = [];
		task.toolLog = [];
		delete task.session;
		delete task.executionFailure;
		delete task.branchUnavailableReason;
		delete task.branchSource;
		delete task.executionRounds;
		if (!selected.has(task.taskId)) {
			task.objective = ""; task.inputs = []; task.expectedOutputs = []; task.checks = []; task.readCoverage = [];
			delete task.reportPath; delete task.review; delete task.experienceSelection;
			delete task.planCopy; delete task.planInput; delete task.resourceInputs;
			delete task.knowledgeIds; delete task.experienceRefs; delete task.experienceContextRefs; delete task.experienceTags;
			delete task.lessonDeltaOutput; delete task.executionLoop;
			continue;
		}
		if (!task.review) { delete task.reportPath; continue; }
		task.review.frozenReportPath = await remap(task.review.frozenReportPath);
		task.reportPath = task.review.frozenReportPath;
		for (const artifact of task.review.artifacts) { artifact.path = await remap(artifact.path); delete artifact.sourcePath; }
		for (const check of task.review.checks) check.evidence = await Promise.all(check.evidence.map(remap));
		if (task.review.independentCheck) task.review.independentCheck.report = await remap(task.review.independentCheck.report);
	}
	for (const selection of frozen.branchSelections ?? []) {
		selection.rationale = "scoped checkpoint omits branch comparison rationale; inspect the complete goal only through an authorized full handoff";
		for (const candidate of selection.candidates) if (!selected.has(candidate.taskId)) candidate.checks = [];
	}
	frozen.problemSnapshotPath = path.join(rootDir, problemFile);
	const goalSnapshotPath = path.join(rootDir, STATE);
	const manifestPath = path.join(rootDir, "manifest.json");
	const sourceGoalUpdatedAt = goal.updatedAt;
	await writeFileAtomic(goalSnapshotPath, `${JSON.stringify(frozen, null, 2)}\n`);
	let feedbackPath: string;
	let feedbackStatus: M07CheckpointRecord["feedbackStatus"];
	try {
		feedbackPath = await writeFeedback(ctx, frozen, limits, rootDir);
		feedbackStatus = "complete";
	} catch (error) {
		if (!isFeedbackControlOverflow(error)) throw error;
		frozen.feedbackError = { code: "context.budget", summary: (error as Error).message.slice(0, 500) };
		feedbackPath = await writeBoundedFeedbackIndex(ctx, frozen, "checkpoint", rootDir);
		feedbackStatus = "indexed";
	}
	frozen.feedbackPath = feedbackPath;
	frozen.feedbackStatus = feedbackStatus;
	await writeFileAtomic(goalSnapshotPath, `${JSON.stringify(frozen, null, 2)}\n`);
	await writeFileAtomic(manifestPath, `${JSON.stringify({ version: 1, m07RunId: goal.runId, checkpointId: id, createdAt: nowIso(), problemFile, rawFiles, skippedRaw, selectedTaskIds, omittedTaskIds, files }, null, 2)}\n`);
	const record: M07CheckpointRecord = { id, createdAt: nowIso(), rootDir, goalSnapshotPath, feedbackPath, manifestPath, feedbackStatus, sourceGoalUpdatedAt };
	goal.checkpoints = [...(goal.checkpoints ?? []), record];
	await save(ctx, goal);
	return record;
}

export function createM07Controller(ctx: StageContext, options: { projectionSnapshotLimits?: ProjectionSnapshotLimits; registeredExperienceStores?: ReadonlyMap<string, KnowledgeStore>; processIdentity?: () => Promise<ProcessIdentityV1>; probeProcess?: typeof probeProcessIdentity } = {}): M07Controller {
	const snapshotLimits = options.projectionSnapshotLimits ?? DEFAULT_PROJECTION_SNAPSHOT_LIMITS;
	if (!Number.isSafeInteger(snapshotLimits.perMaterialBytes) || !Number.isSafeInteger(snapshotLimits.perCallBytes) || !Number.isSafeInteger(snapshotLimits.perRunBytes) || snapshotLimits.perMaterialBytes <= 0 || snapshotLimits.perCallBytes < snapshotLimits.perMaterialBytes || snapshotLimits.perRunBytes < snapshotLimits.perCallBytes) throw new HarnessError("m07.projection-budget", "invalid projection snapshot limits");
	return {
		async begin(input, beginOptions) {
			nonempty(input.goal, "goal"); nonempty(input.problemRelation, "problemRelation"); nonempty(input.plan, "plan");
			if (!input.constraints.length || !input.successCriteria.length) throw new HarnessError("m07.input", "constraints 与 successCriteria 必须明确且非空");
			input.constraints = normalizedUnique(input.constraints, "constraint"); input.successCriteria = normalizedUnique(input.successCriteria, "success criterion");
			const problem = await ctx.ws.readProblem();
			let baseline: FormalBaseline | undefined;
			try { baseline = await latestFormalBaseline(ctx); }
			catch (error) { if (!input.exploratory) throw error; }
			if (!baseline && !input.exploratory) throw new HarnessError("m07.baseline", "没有可用的 M04 正式基线；只能显式 exploratory=true 开始探索性 M07，不能声称正式结论");
			const budget = await activePolicySnapshot(ctx);
			let workflowMethod: CurrentGoal["workflowMethod"];
			if (input.workflowMethodVersionId !== undefined) {
				const generations = new GenerationStore(ctx.ws.root);
				const active = await generations.active();
				if (!active || active.bundle.executorVersionId !== input.workflowMethodVersionId) throw new HarnessError("m07.workflow-method", "explicit workflow method is not the active H version");
				const method = await generations.readStrategy(input.workflowMethodVersionId);
				if (method.kind !== "executor" || !isM07WorkflowStrategy(method.artifact) || !["admitted", "manual-active"].includes(method.state)) throw new HarnessError("m07.workflow-method", "active H is not an admitted or manually bound M07 workflow method");
				if (active.bundle.knowledgeSnapshot !== baseline?.knowledgeSnapshot) throw new HarnessError("m07.workflow-method", "workflow method and M04 baseline have different knowledge epochs");
				workflowMethod = { versionId: method.versionId, artifact: method.artifact, requiredExperienceRefs: method.requiredExperienceRefs, requiredKnowledgeRefs: method.requiredKnowledgeRefs };
				const frozenRefs = new Map<string, KnowledgeRef>();
				for (const item of workflowMethod.requiredExperienceRefs) frozenRefs.set(`${item.ref.storeId}/${item.ref.recordId}@${item.ref.version}`, item.ref);
				for (const ref of workflowMethod.requiredKnowledgeRefs) frozenRefs.set(`${ref.storeId}/${ref.recordId}@${ref.version}`, ref);
				await verifyRequiredKnowledge(ctx.ws.root, [...frozenRefs.values()], baseline?.knowledgeSnapshot, options.registeredExperienceStores);
			}
			const record = await ctx.ws.startRun("M07", [{ label: "原始问题", path: problem.path }], baseline?.knowledgeSnapshot);
			const frozen = path.join(ctx.ws.runDir("M07", record.runId), "problem-snapshot.md");
			await writeFileAtomic(frozen, problem.content);
			const exploratory = input.exploratory === true || !baseline;
			const attemptId = "A001";
			const descriptor: RunDescriptorV1 = { version: 1, instanceId: process.env.PRE_RSI_RUN_INSTANCE_ID ?? randomUUID(), attemptId, workspaceId: await ctx.store.storeId(), goalRunId: record.runId, codeRevision: process.env.PRE_RSI_CODE_REVISION ?? "unrecorded", controlDir: ctx.ws.runDir("M07", record.runId), process: await (options.processIdentity ?? readCurrentProcessIdentity)() };
			const goal: CurrentGoal = { version: 1, runId: record.runId, lifecycle: "active", startedAt: record.startedAt, updatedAt: record.startedAt, goal: input.goal.trim(), problemRelation: input.problemRelation.trim(), constraints: input.constraints.map((x) => nonempty(x, "constraint")), successCriteria: input.successCriteria.map((x) => nonempty(x, "success criterion")), plan: input.plan.trim(), exploratory, formalBaseline: !!baseline && !exploratory, problemSnapshotPath: frozen, knowledgeSnapshot: baseline?.knowledgeSnapshot, m04BaselineRunId: baseline?.run.runId, baselineHistory: baseline ? [{ at: record.startedAt, knowledgeSnapshot: baseline.knowledgeSnapshot, m04RunId: baseline.run.runId }] : [], budgetPolicy: budget.policy, budgetPolicyVersionId: budget.versionId, budgetPolicyFrozenAt: record.startedAt, methodBinding: { versionId: workflowMethod?.versionId ?? budget.versionId }, ...(workflowMethod ? { workflowMethod } : {}), ...(beginOptions?.executionContract === "continuous" ? { executionContract: { version: 1 as const, mode: "continuous" as const, frozenAt: record.startedAt } } : {}), executionState: { version: 1, activeAttemptId: attemptId, attempts: [{ version: 1, id: attemptId, state: "running", startedAt: record.startedAt, runDescriptor: descriptor }], operations: [] }, tasks: [], decisions: [], limitations: [] };
			await save(ctx, goal);
			return goal;
		},

		status: (runId) => load(ctx, runId),

		async plan(runId, plan, planOptions) {
			return withGoalDispatch(ctx, runId, async () => {
			const goal = await load(ctx, runId); requireActive(goal);
			if (Boolean(planOptions?.checkpointId) !== Boolean(planOptions?.m04RunId)) throw new HarnessError("m07.checkpoint", "refreshBaseline 的 checkpointId 与 m04RunId 必须成对指定");
			if ((planOptions?.checkpointId || planOptions?.m04RunId) && !planOptions?.refreshBaseline) throw new HarnessError("m07.checkpoint", "checkpoint 消费绑定仅适用于 refreshBaseline");
			const nextPlan = nonempty(plan, "plan");
			if (planOptions?.refreshBaseline) {
				const baseline = await latestFormalBaseline(ctx); if (!baseline) throw new HarnessError("m07.baseline", "没有可用于刷新基线的 M04 运行");
				if (goal.checkpoints?.length && (!planOptions.checkpointId || !planOptions.m04RunId)) throw new HarnessError("m07.checkpoint", "checkpoint 后刷新基线必须显式绑定 checkpointId 与 M04 runId");
				if (planOptions.checkpointId && planOptions.m04RunId) {
					const checkpoint = goal.checkpoints?.find((item) => item.id === planOptions.checkpointId);
					if (!checkpoint || baseline.run.runId !== planOptions.m04RunId) throw new HarnessError("m07.checkpoint", "checkpoint 或最新 M04 运行不匹配");
					const sourceOutput = baseline.run.outputs.find((item) => item.label === "M07 处理来源");
					if (!sourceOutput || path.resolve(sourceOutput.path) !== path.join(ctx.ws.runDir("M04", baseline.run.runId), "m07-source.json")) throw new HarnessError("m07.checkpoint", "M04 缺少控制器登记的 checkpoint 来源");
					const source = JSON.parse(await readFile(sourceOutput.path, "utf8")) as { m07RunId?: string; checkpointId?: string; rootDir?: string; goalSnapshotPath?: string; manifestPath?: string };
					if (source.m07RunId !== runId || source.checkpointId !== checkpoint.id || source.rootDir !== checkpoint.rootDir || source.goalSnapshotPath !== checkpoint.goalSnapshotPath || source.manifestPath !== checkpoint.manifestPath) throw new HarnessError("m07.checkpoint", "M04 来源并非本目标对应的冻结 checkpoint");
				}
				if (goal.workflowMethod && baseline.knowledgeSnapshot !== goal.knowledgeSnapshot) throw new HarnessError("m07.workflow-method", "已冻结工作流方法的目标不能热更新知识版本；请新建目标并显式绑定新方法版本");
				await verifyFrozenWorkflowMethod(ctx, goal, options.registeredExperienceStores);
				goal.m04BaselineRunId = baseline.run.runId; goal.knowledgeSnapshot = baseline.knowledgeSnapshot; goal.formalBaseline = true; goal.exploratory = false; goal.baselineHistory.push({ at: nowIso(), knowledgeSnapshot: baseline.knowledgeSnapshot, m04RunId: baseline.run.runId });
			}
			goal.plan = nextPlan;
			await save(ctx, goal); return goal;
			});
		},

		async checkpoint(runId, checkpointOptions) {
			return withGoalDispatch(ctx, runId, async () => {
			const goal = await load(ctx, runId); requireActive(goal);
			frozenPolicy(goal);
			if (goal.tasks.some((task) => task.status === "running")) throw new HarnessError("m07.checkpoint", "存在 running 任务，不能冻结非终态反馈");
			const requested = checkpointOptions?.taskIds;
			if (requested !== undefined && (!Array.isArray(requested) || requested.length === 0 || requested.some((id) => typeof id !== "string" || !/^T\d{3,}$/.test(id)) || new Set(requested).size !== requested.length || requested.some((id) => !goal.tasks.some((task) => task.taskId === id)))) throw new HarnessError("m07.checkpoint", "taskIds 必须是非空、去重、属于当前目标的任务列表");
			const selectedTaskIds = requested ?? goal.tasks.map((task) => task.taskId);
			await verifyFrozenWorkflowMethod(ctx, goal, options.registeredExperienceStores);
			return freezeCheckpoint(ctx, goal, snapshotLimits, selectedTaskIds);
			});
		},

			async delegate(runId, spec, afterPrepared) {
			return withGoalDispatch(ctx, runId, async () => {
				const goal = await load(ctx, runId); requireActive(goal); nonempty(spec.objective, "task objective");
				if (spec.context && spec.context.mode !== "fork") throw new HarnessError("m07.branch", "unsupported task context mode");
				if (spec.mode === "execute" && (goal.executionState?.operations.some((operation) => operation.status === "unknown") || goal.tasks.some((task) => task.mode === "execute" && task.status === "unknown"))) throw new HarnessError("m07.operation-unknown", "仍有外部副作用状态未知；先经宿主控制面对账。只读 check/reason 任务仍可用于核查");
				await verifyFrozenWorkflowMethod(ctx, goal, options.registeredExperienceStores, spec);
			const policy = frozenPolicy(goal);
			await requireCurrentFormalBaseline(ctx, goal);
			if (spec.executionLoop !== undefined) {
				const loop = spec.executionLoop as unknown;
				if (!loop || typeof loop !== "object" || Array.isArray(loop)) throw new HarnessError("m07.loop", "invalid execution-loop policy");
				const fields = loop as Record<string, unknown>;
				if (fields.mode === "until-ready" ? Object.keys(fields).length !== 1 :
					Object.keys(fields).length !== 2 || !Number.isSafeInteger(fields.maxRounds) || Number(fields.maxRounds) < 1 ||
					typeof fields.deadlineAt !== "string" || !Number.isFinite(Date.parse(fields.deadlineAt)))
					throw new HarnessError("m07.loop", "invalid execution-loop policy");
			}
			spec = { ...spec, objective: spec.objective.trim(), inputs: normalizedUnique(spec.inputs, "task input"), expectedOutputs: normalizedUnique(spec.expectedOutputs, "expected output"), checks: normalizedUnique(spec.checks, "task check"),
				executionLoop: spec.executionLoop ? { mode: "until-ready" } : undefined };
			let branchParent: M07TaskRecord | undefined;
			let branchManifest: BranchManifestV1 | undefined;
			if (spec.context) {
				const reference = spec.context;
				if (goal.tasks.some((item) => item.status === "running") || goal.executionState?.operations.some((item) => ["prepared", "issued", "unknown"].includes(item.status))) throw new HarnessError("m07.branch", "cannot fork while another task or external operation is active or unresolved");
				if (reference.parentRunId !== runId || !reference.parentTaskId || !reference.checkpointId) throw new HarnessError("m07.branch", "fork requires this goal's run, parent task, and exact checkpoint ID");
				branchParent = goal.tasks.find((item) => item.taskId === reference.parentTaskId);
				if (!branchParent || branchParent.mode !== "execute" || branchParent.context || !["returned", "accepted", "rejected"].includes(branchParent.status) || !branchParent.branchSource || branchParent.branchSource.checkpoint.id !== reference.checkpointId) throw new HarnessError("m07.branch", "parent is not a settled, frozen execute task at the requested checkpoint");
				if (branchParent.branchSource.checkpoint.runId !== runId || branchParent.branchSource.checkpoint.taskId !== branchParent.taskId || branchParent.branchSource.checkpoint.inputManifest !== branchParent.branchSource.manifestPath) throw new HarnessError("m07.branch", "checkpoint receipt does not bind this run, task, and evidence manifest");
				if (goal.branchSelections?.some((item) => item.parentTaskId === reference.parentTaskId)) throw new HarnessError("m07.branch", "branch selection is frozen; no later candidate may join this comparison");
				if (spec.mode !== "execute" || spec.objective !== branchParent.objective || !sameStrings(spec.checks, branchParent.checks) || !sameStrings(spec.expectedOutputs, branchParent.expectedOutputs) || Boolean(spec.requireIndependentCheck) !== Boolean(branchParent.requireIndependentCheck) || !sameStrings(spec.inputs, branchParent.inputs) || (spec.parentTaskId && spec.parentTaskId !== branchParent.taskId) || (spec.supersedesTaskId && spec.supersedesTaskId !== branchParent.taskId)) throw new HarnessError("m07.branch", "fork candidates must retain the parent's objective, inputs, outputs, checks, execute mode, and independent-check obligation");
				branchManifest = await loadBranchManifest(branchParent.branchSource, runId, branchParent.taskId);
				if (branchParent.inputCopies.length !== branchParent.inputs.length) throw new HarnessError("m07.branch", "frozen parent input identity is incomplete");
				const rootReal = await realpath(ctx.ws.root);
				const frozenInputSource = (requested: string): string => {
					const index = branchParent!.inputs.indexOf(requested);
					const copy = index >= 0 ? branchParent!.inputCopies[index] :
						branchParent!.inputCopies.find((item) => item.source === requested);
					if (!copy || !path.isAbsolute(copy.source) || !inside(rootReal, copy.source))
						throw new HarnessError("m07.branch", "fork input is not one of the parent's frozen declared inputs");
					const relative = path.relative(branchParent!.workDir, copy.copy);
					if (relative.startsWith("..") || path.isAbsolute(relative) ||
						!branchManifest!.files.some((file) => file.relativePath === relative && file.historicalPath === copy.copy))
						throw new HarnessError("m07.branch", "fork input lacks the parent's frozen work-copy identity");
					return copy.source;
				};
				if (spec.planInput !== undefined) spec.planInput = frozenInputSource(spec.planInput);
				if (spec.resourceInputs !== undefined) spec.resourceInputs = spec.resourceInputs.map((item) =>
					({ ...item, input: frozenInputSource(item.input) }));
				if (JSON.stringify(spec.knowledgeIds ?? []) !== JSON.stringify(branchParent.knowledgeIds ?? []) || JSON.stringify(spec.experienceRefs ?? []) !== JSON.stringify(branchParent.experienceRefs ?? []) || JSON.stringify(spec.experienceContextRefs ?? []) !== JSON.stringify(branchParent.experienceContextRefs ?? []) || JSON.stringify(spec.experienceTags ?? []) !== JSON.stringify(branchParent.experienceTags ?? []) || JSON.stringify(spec.resourceInputs ?? []) !== JSON.stringify(branchParent.resourceInputs ?? []) || spec.planInput !== branchParent.planInput || spec.lessonDeltaOutput !== branchParent.lessonDeltaOutput || Boolean(spec.executionLoop) !== Boolean(branchParent.executionLoop)) throw new HarnessError("m07.branch", "fork cannot silently change frozen knowledge applicability, plan, resources, lesson output, or review-loop obligations");
				if (branchParent.knowledgeSnapshot !== goal.knowledgeSnapshot || branchParent.m04BaselineRunId !== goal.m04BaselineRunId) throw new HarnessError("m07.branch", "goal baseline changed since the source task; establish a new task rather than fork old authority");
				if (branchManifest.knowledgeSnapshot !== goal.knowledgeSnapshot || branchManifest.m04BaselineRunId !== goal.m04BaselineRunId || branchManifest.problemSourcePath !== goal.problemSnapshotPath) throw new HarnessError("m07.branch", "frozen source manifest no longer matches the goal's inputs and formal baseline");
				spec = { ...spec, parentTaskId: branchParent.taskId, supersedesTaskId: branchParent.taskId };
			}
			if (spec.executionLoop) {
				if (spec.mode !== "execute" || !("mode" in spec.executionLoop) || spec.executionLoop.mode !== "until-ready")
					throw new HarnessError("m07.loop", "new executionLoop requires execute mode and until-ready policy");
			}
			if (spec.lessonDeltaOutput && (spec.mode !== "execute" || !spec.expectedOutputs.includes(spec.lessonDeltaOutput))) throw new HarnessError("m07.lesson-delta", "lessonDeltaOutput must be an exact expected output of an execute task");
			for (const expectedOutput of spec.expectedOutputs) {
				if (isSafeRelativeOutputPath(expectedOutput) === false) throw new HarnessError("m07.path", `expectedOutputs 必须是 work 目录内精确相对路径，不得含占位符、通配符、绝对路径、..、多余首尾空白或换行；动态文件名请声明其父目录，并在 objective 或任务报告中说明：${expectedOutput}`);
			}
			if (!spec.checks.length) throw new HarnessError("m07.task", "每个任务必须定义至少一项实际检查；推导可用会话报告作为证据");
			if (spec.mode === "check") {
				if (spec.expectedOutputs.length > 0) throw new HarnessError("m07.task", "check 模式只读且不写盘，不能声明 expectedOutputs；需要产出文件时请使用 execute 模式");
			}
			if (spec.mode === "execute") {
				if (spec.expectedOutputs.length === 0) {
					if (spec.supersedesTaskId === undefined) throw new HarnessError("m07.task", "execute 任务必须声明至少一个预期产物");
				}
			}
			if (spec.parentTaskId && !goal.tasks.some((t) => t.taskId === spec.parentTaskId)) throw new HarnessError("m07.task", `未知 parentTaskId ${spec.parentTaskId}`);
			const resolvedInputs: string[] = []; for (let index = 0; index < spec.inputs.length; index++)
				resolvedInputs.push(branchParent ? branchParent.inputCopies[index].source : await confinedExistingFile(ctx, spec.inputs[index]));
			if (spec.planInput) {
				if (spec.mode !== "execute") throw new HarnessError("m07.plan-input", "planInput is only valid for an execute task");
				const planSource = branchParent ? spec.planInput : await confinedExistingFile(ctx, spec.planInput);
				if (!resolvedInputs.includes(planSource) || mediaType(planSource) !== "text") throw new HarnessError("m07.plan-input", "planInput must identify a declared text input");
				spec.planInput = planSource;
			}
			if (spec.resourceInputs !== undefined) {
				if (!Array.isArray(spec.resourceInputs)) throw new HarnessError("m07.resources", "resourceInputs must be explicit versioned references");
				const seen = new Set<string>();
				spec.resourceInputs = await Promise.all(spec.resourceInputs.map(async (item) => {
					if (!item || !/^[A-Za-z][A-Za-z0-9._-]{0,63}$/.test(item.id) || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(item.version) || seen.has(item.id)) throw new HarnessError("m07.resources", "resourceInputs must have unique safe IDs and explicit versions");
					seen.add(item.id);
					const source = branchParent ? item.input : await confinedExistingFile(ctx, item.input);
					if (!resolvedInputs.includes(source) || mediaType(source) !== "text") throw new HarnessError("m07.resources", "each resource input must be a declared text input");
					return { id: item.id, version: item.version, input: source };
				}));
			}
			if (spec.supersedesTaskId) { const previous = goal.tasks.find((t) => t.taskId === spec.supersedesTaskId); if (!previous) throw new HarnessError("m07.task", `未知 supersedesTaskId ${spec.supersedesTaskId}`); const previousInputs = previous.inputCopies.map((item) => item.source).sort(); const nextInputs = [...resolvedInputs].sort(); if (!sameSupersededObligation(spec, previous) || !sameStrings(nextInputs, previousInputs)) throw new HarnessError("m07.task", "supersedes 只能替代 objective、兼容 mode（可升级到更强能力）、独立检查要求、inputs、checks 与 expectedOutputs 相同或不降低义务的旧任务"); }
			const dependencies = [spec.parentTaskId, spec.supersedesTaskId].filter(Boolean) as string[];
			if (goal.decisions.some((d) => d.status === "open" && d.relatedTaskIds.some((id) => dependencies.includes(id)))) throw new HarnessError("m07.decision", "该任务依赖待用户决定事项；可继续不受影响的任务，但不能推进此依赖分支");
			const id = taskId(goal), dir = path.join(ctx.ws.runDir("M07", runId), "tasks", id), workDir = path.join(dir, "work"), inputsDir = path.join(workDir, "inputs");
			await mkdir(inputsDir, { recursive: true });
			const copies: M07TaskRecord["inputCopies"] = [];
			if (branchParent && branchManifest) {
				for (const file of branchManifest.files) { const destination = path.join(workDir, file.relativePath); await mkdir(path.dirname(destination), { recursive: true }); await copyFile(file.frozenPath, destination); await chmod(destination, 0o644); }
				for (const original of branchParent.inputCopies) { const relative = path.relative(branchParent.workDir, original.copy); if (relative.startsWith("..") || !branchManifest.files.some((file) => file.relativePath === relative)) throw new HarnessError("m07.branch", "parent input lacks a frozen source mapping"); copies.push({ source: original.source, copy: path.join(workDir, relative), mediaType: original.mediaType }); }
				const childMap = branchManifest.files.map((file) => ({ historicalPath: file.historicalPath, frozenPath: file.frozenPath, childPath: path.join(workDir, file.relativePath) }));
				await writeFileAtomic(path.join(workDir, "branch-evidence-map.json"), `${JSON.stringify({ version: 1, parentRunId: runId, parentTaskId: branchParent.taskId, checkpointId: branchParent.branchSource!.checkpoint.id, files: childMap }, null, 2)}\n`);
				await writeFileAtomic(path.join(workDir, "fork-owner.json"), `${JSON.stringify({ version: 1, checkpointId: branchParent.branchSource!.checkpoint.id, parentRoot: branchManifest.parentWorkRoot, childRoot: workDir, childContainer: path.basename(path.dirname(workDir)) }, null, 2)}\n`);
			} else for (let i = 0; i < resolvedInputs.length; i++) { const source = resolvedInputs[i]; const copy = path.join(inputsDir, uniqueName(i, source)); await copyFile(source, copy); copies.push({ source, copy, mediaType: mediaType(source) }); }
			let pack: string | undefined;
			if (spec.knowledgeIds?.length) {
				for (const requested of spec.knowledgeIds) {
					const parsed = /^([CKEJQDX]\d{3,})(?:@(\d+))?$/.exec(requested);
					if (parsed && (await ctx.store.get(parsed[1], parsed[2] ? Number(parsed[2]) : undefined))?.fields.experience !== undefined) throw new HarnessError("m07.experience", `方法经验 ${requested} 必须通过固定 storeId、recordId、version 与适用性选择入口加载`);
				}
			}
			let experienceSelection: M07TaskRecord["experienceSelection"];
			if (spec.experienceRefs?.length) {
				const selection = await createExperienceProvider(ctx.store, options.registeredExperienceStores).select({ targetKind: "executor", applicability: { stage: "M07", tags: [spec.mode, ...(spec.experienceTags ?? [])], contextRefs: spec.experienceContextRefs }, requestedRefs: spec.experienceRefs, expectedSnapshotId: goal.knowledgeSnapshot, maxRecords: 24, maxChars: 24_000 });
				if (selection.status !== "ready") throw new HarnessError("m07.experience", `显式方法经验不可装载：${selection.omitted.map((item) => `${item.ref.storeId}/${item.ref.recordId}@${item.ref.version}:${item.reason}`).join("；") || selection.status}`);
				experienceSelection = { ...selection, invocationStatus: "unknown", faithfulUse: "unknown", causalBenefit: "unknown" };
				pack = selection.markdown;
			}
			const retrieval = await retrieveKnowledge(ctx.store, { purpose: `M07 ${id}`, text: [goal.goal, goal.problemRelation, ...goal.successCriteria, spec.objective, ...spec.checks].join("\n"), requiredIds: spec.knowledgeIds ?? [], maxRecords: 24, maxChars: 60_000, excludeExperience: true });
			if (retrieval.status !== "ready") throw new HarnessError("m07.knowledge", `required knowledge unavailable: ${retrieval.omitted.map((item) => `${item.ref}:${item.reason}`).join("; ")}`);
			if (goal.knowledgeSnapshot && retrieval.snapshot !== goal.knowledgeSnapshot) throw new HarnessError("m07.knowledge", "knowledge snapshot changed since goal baseline; refresh explicitly");
			if (retrieval.pack.included.length) pack = [retrieval.pack.markdown, pack].filter(Boolean).join("\n\n");
			const verifyDispatchKnowledge = async (): Promise<void> => {
				const sameLocalState = async () => (await ctx.store.current())?.id === retrieval.snapshot && JSON.stringify(await ctx.store.limits()) === JSON.stringify(retrieval.limits);
				if (!await sameLocalState()) throw new HarnessError("m07.knowledge", "knowledge snapshot or live limits changed before task dispatch");
				await requireCurrentFormalBaseline(ctx, goal);
				await verifyFrozenWorkflowMethod(ctx, goal, options.registeredExperienceStores, spec);
				if (experienceSelection && spec.experienceRefs?.length) {
					const fresh = await createExperienceProvider(ctx.store, options.registeredExperienceStores).select({ targetKind: "executor", applicability: { stage: "M07", tags: [spec.mode, ...(spec.experienceTags ?? [])], contextRefs: spec.experienceContextRefs }, requestedRefs: spec.experienceRefs, expectedSnapshotId: goal.knowledgeSnapshot, maxRecords: 24, maxChars: 24_000 });
					if (fresh.status !== "ready" || fresh.markdown !== experienceSelection.markdown || JSON.stringify(fresh.selected) !== JSON.stringify(experienceSelection.selected)) throw new HarnessError("m07.experience", "pinned task experience changed or became unavailable before dispatch");
				}
				if (!await sameLocalState()) throw new HarnessError("m07.knowledge", "knowledge snapshot or live limits changed during dispatch check");
			};
			const expectedOutputPaths = spec.expectedOutputs.map((x) => { const resolved = path.resolve(workDir, x); if (!inside(workDir, resolved)) throw new HarnessError("m07.path", `预期产物路径逃逸任务目录：${x}`); return resolved; });
			const role = spec.mode === "check" ? "reviewer" : "execution";
			const tools = spec.mode === "execute" ? { kind: "execution" as const, root: workDir, tools: ["read", "write", "edit", "bash"] as Array<"read" | "write" | "edit" | "bash"> } : { kind: "read-dir" as const, root: workDir };
			const operationId = spec.mode === "execute" && goal.executionState ? `O${String(goal.executionState.operations.length + 1).padStart(3, "0")}` : undefined;
			let { message, event } = await taskMessage(ctx, goal, id, spec, copies, pack, policy, snapshotLimits, operationId);
			if (branchParent?.branchSource && branchManifest) {
				message += `\n\n# Frozen competitive branch\nThis is an independently writable candidate for the exact same task and goal obligations. The inherited Pi history is a historical causal record, not permission to reuse its old absolute paths or repeat external actions. Historical work root: ${branchManifest.parentWorkRoot}. Your private work root: ${workDir}. The complete old-path to frozen-evidence and private-copy mapping is in branch-evidence-map.json in your work root. Read original evidence as needed; the manifest and summaries alone do not mean you have read it. Write only in your private work root. Do not modify parent files, other branches, the knowledge store, or original checks. Your result is a candidate until the M07 controller reviews and explicitly selects it; M04 alone decides knowledge adoption.`;
				if (message.length + systemPromptFor("execution").length > policy.maxPromptChars) throw new HarnessError("context.budget", "branch evidence handoff exceeds the frozen prompt budget");
			}
			await writeFileAtomic(path.join(dir, "message.md"), message);
			const task: M07TaskRecord = { ...spec, taskId: id, status: "running", createdAt: nowIso(), returnedAt: "", workDir, inputCopies: copies, expectedOutputPaths, readCoverage: [], toolLog: [], knowledgeSnapshot: goal.knowledgeSnapshot, m04BaselineRunId: goal.m04BaselineRunId, experienceSelection, ...(spec.planInput ? { planCopy: copies.find((item) => item.source === spec.planInput)?.copy } : {}) };
			const operation: M07OperationV1 | undefined = operationId ? { version: 1, id: operationId, taskId: id, status: "prepared", issuedAt: nowIso() } : undefined;
			if (operation) goal.executionState!.operations.push(operation);
			goal.tasks.push(task); await save(ctx, goal);
			if (afterPrepared) await afterPrepared(runId, id);
			let handle;
			let promptIssued = false;
			let activeOperation = operation;
			try {
				const frozenInputBytes = await Promise.all([task.planCopy, ...(task.resourceInputs ?? []).map((item) => copies.find((copy) => copy.source === item.input)?.copy)].filter((item): item is string => Boolean(item)).map(async (copy) => ({ copy, bytes: await readFile(copy) })));
				const verifyFrozenInputs = async (): Promise<void> => { for (const input of frozenInputBytes) if (!(await readFile(input.copy)).equals(input.bytes)) throw new HarnessError("m07.plan-input", "builder changed a frozen plan or versioned resource copy; stop this task and review the evidence"); };
				const session = sessionSpec(ctx, `M07-${id}`, role, systemPromptFor(role), tools);
				if (goal.methodBinding) session.methodBinding = goal.methodBinding;
				const runRecord = await ctx.ws.readRun("M07", runId);
				if (branchParent?.branchSource && branchManifest) {
					const checkpoint = branchParent.branchSource.checkpoint;
					const workspaceBinding = { version: 1 as const, parentRoot: branchManifest.parentWorkRoot, authorizedChildRootBase: branchManifest.authorizedChildRootBase, childWorkLeaf: branchManifest.forkWorkspaceAuthority.childWorkLeaf, childRoot: workDir, ownerMarkerPath: path.join(workDir, "fork-owner.json"), frozenEvidenceRoot: branchManifest.frozenWorkRoot, files: branchManifest.files.map((file) => ({ sourcePath: file.historicalPath, frozenPath: file.frozenPath, childPath: path.join(workDir, file.relativePath), bytes: file.bytes })) };
					const evidence: EvidenceBindingV1[] = [
						{ version: 1, label: `M07 ${branchParent.taskId} frozen work mapping`, path: checkpoint.manifestSnapshot, status: "frozen-copy", sourceVersion: checkpoint.id },
						{ version: 1, label: "original problem snapshot", path: branchParent.branchSource.problemSnapshotCopy, status: "frozen-copy", sourceVersion: `${runId}/${branchParent.taskId}` },
					];
					handle = await openBoundedSession(ctx.runner, runRecord, { mode: "fork", intent: "branch-exploration", reason: `M07 ${id} competes from ${branchParent.taskId} frozen checkpoint ${checkpoint.id}; original checks and goal obligations remain binding`, evidence, checkpoint, workspaceBinding, spec: session }, () => ctx.ws.writeRun(runRecord));
				} else {
					const evidence: EvidenceBindingV1[] = copies.map((item) => ({ version: 1, label: path.basename(item.copy), path: item.copy, status: "frozen-copy", sourceVersion: `${runId}/${id}` }));
					handle = await openBoundedSession(ctx.runner, runRecord, { mode: "fresh", intent: spec.mode === "check" ? "independent-judgment" : "new-work", reason: spec.mode === "check" ? "M07 independent task/check requires an uninherited judgement" : "M07 new task has no causal parent session", evidence, spec: session }, () => ctx.ws.writeRun(runRecord));
				}
				task.session = handle.ref; await save(ctx, goal);
				if (spec.executionLoop) {
					const transcript: string[] = [];
					task.executionRounds = [];
					let nextMessage = message;
					for (let index = 1; ; index++) {
						if (!Number.isSafeInteger(index)) throw new HarnessError("m07.loop", "round identity overflow");
						const currentOperation: M07OperationV1 = index === 1 ? operation! : { version: 1, id: `O${String(goal.executionState!.operations.length + 1).padStart(3, "0")}`, taskId: id, status: "prepared", issuedAt: nowIso() };
						activeOperation = currentOperation;
						if (index > 1) { goal.executionState!.operations.push(currentOperation); await save(ctx, goal); }
						await verifyDispatchKnowledge();
						if (index === 1) { event.deliveryStatus = "submitted"; event.providerUsageSessionId = handle.ref.id; await writeProjectionEvent(ctx.ws, event); }
						currentOperation.status = "issued"; await save(ctx, goal);
						promptIssued = true;
						const report = (await handle.prompt(nextMessage)).text;
						currentOperation.status = "response-received";
						await verifyFrozenInputs();
						if (task.experienceSelection) task.experienceSelection.loadedAt = nowIso();
						const builderReportPath = path.join(dir, `round-${index}-builder.md`);
						await writeFileAtomic(builderReportPath, report);
						const round: NonNullable<M07TaskRecord["executionRounds"]>[number] = { index, operationId: currentOperation.id, builderContext: index === 1 ? branchParent ? { mode: "fork", reason: `same task explored from ${branchParent.branchSource!.checkpoint.id}` } : { mode: "fresh", reason: "new M07 task" } : { mode: "continue", reason: "same builder repairs the same frozen task in its live session" }, builderReportPath, completedAt: nowIso() };
						task.executionRounds.push(round);
						transcript.push(`## Round ${index} builder\n\n${report}`);
						await save(ctx, goal);
						const reviewerRoot = path.join(dir, `round-${index}-snapshot`);
						const reviewerSnapshotBytes = await snapshotRoundForReviewer(workDir, reviewerRoot);
						round.reviewerSnapshotPath = reviewerRoot;
						let reviewerPrompt = `Review only this M07 task round and the copied work-directory snapshot. Goal: ${goal.goal}\nProblem relation: ${goal.problemRelation}\nFrozen goal constraints: ${goal.constraints.join("; ")}\nFrozen success criteria: ${goal.successCriteria.join("; ")}\nGoal plan at task creation: ${goal.plan}\nTask objective: ${spec.objective}\nChecks: ${spec.checks.join("; ")}\nExpected outputs: ${spec.expectedOutputs.join("; ")}\nFrozen plan input: ${task.planCopy ? path.relative(workDir, task.planCopy) : "none"}\nThe builder report follows. Inspect the copied files only as needed. Reply with only JSON {"verdict":"ready|revise|replan|blocked","feedback":"specific evidence-grounded reason"}, without extra prose or code fences. Escape paragraph breaks inside the feedback JSON string as \\n, never raw line breaks inside quotes. Identify decisive checked files, measurements, failures and limitations. Use blocked if a material uncertainty remains. ready only means ready for the controller's separate final review. Do not change the plan or task obligations.\n\n${report}`;
						if (reviewerPrompt.length + systemPromptFor("reviewer").length > policy.maxPromptChars) {
							const handoff = await freezeBuilderReportForReviewer(report, reviewerRoot, reviewerSnapshotBytes);
							reviewerPrompt = reviewerPrompt.slice(0, reviewerPrompt.length - report.length) + handoff;
						}
						if (reviewerPrompt.length + systemPromptFor("reviewer").length > policy.maxPromptChars) throw new HarnessError("context.budget", "reviewer control input exceeds the frozen prompt handoff size");
						const reviewerSpec = sessionSpec(ctx, `M07-${id}-round-${index}-reviewer`, "reviewer", systemPromptFor("reviewer"), { kind: "read-dir", root: reviewerRoot });
						if (goal.methodBinding) reviewerSpec.methodBinding = goal.methodBinding;
						const reviewRunRecord = await ctx.ws.readRun("M07", runId);
						const reviewer = await openBoundedSession(ctx.runner, reviewRunRecord, { mode: "fresh", intent: "independent-judgment", reason: `M07 round ${index} reviewer must independently inspect the frozen candidate snapshot`, evidence: [{ version: 1, label: `M07 ${id} round ${index} snapshot`, path: reviewerRoot, status: "frozen-copy", sourceVersion: `${runId}/${id}/round-${index}` }], spec: reviewerSpec }, () => ctx.ws.writeRun(reviewRunRecord));
						round.reviewerSession = reviewer.ref;
						await save(ctx, goal);
						let rawReview!: string;
						let verdict!: ReturnType<typeof parseRoundReview>;
						try {
							let request = reviewerPrompt;
							for (let attempt = 1; ; attempt++) {
								if (!Number.isSafeInteger(attempt)) throw new HarnessError("m07.loop-review", "reviewer attempt identity overflow");
								await verifyDispatchKnowledge();
								rawReview = (await reviewer.prompt(request)).text;
								if (Buffer.byteLength(rawReview, "utf8") > 512_000)
									throw new HarnessError("m07.file-size", "reviewer report file exceeds 512,000 UTF-8 bytes");
								const attemptPath = path.join(dir, `round-${index}-reviewer-attempt-${attempt}.md`);
								await writeFileAtomic(attemptPath, rawReview);
								try { verdict = parseRoundReview(rawReview); break; }
								catch (error) {
									if (!(error instanceof HarnessError) || error.code !== "m07.loop-review") throw error;
									transcript.push(`## Round ${index} reviewer attempt ${attempt}\n\nInvalid structured verdict; see ${path.basename(attemptPath)}. ${error.message}`);
									request = `Your preceding response was not a usable structured verdict: ${error.message}. Continue in this SAME independent read-only reviewer session against the SAME frozen round snapshot and unchanged task checks. Inspect the files as needed, then return only strict JSON {"verdict":"ready|revise|replan|blocked","feedback":"specific evidence-grounded reason"}. Do not infer ready from malformed text, change task obligations, or request builder work before a valid verdict.`;
								}
							}
						} finally { task.toolLog.push(...reviewer.toolLog().map((entry) => ({ ...entry, reviewerSessionId: reviewer.ref.id }))); reviewer.dispose(); }
						const reviewerReportPath = path.join(dir, `round-${index}-reviewer.md`);
						await writeFileAtomic(reviewerReportPath, rawReview);
						round.reviewerReportPath = reviewerReportPath;
						let fileCheckFailure: string | undefined;
						if (verdict.verdict === "ready") {
							const candidate = await validateCandidateFiles(reviewerRoot, spec.expectedOutputs.map((item) => path.join(reviewerRoot, item)), spec.lessonDeltaOutput);
							const fileFailures = [...candidate.expectedOutputs.flatMap((item) => item.error ? [item.error] : []), ...(candidate.lessonDeltaFailure ? [candidate.lessonDeltaFailure] : [])];
							if (fileFailures.length) {
								fileCheckFailure = fileFailures.join("; ");
								verdict = { verdict: "revise" as const, feedback: `Reviewer reported ready, but the controller's final-review file checks failed: ${fileCheckFailure}. Repair the same candidate and let a fresh reviewer inspect it.` };
							}
						}
						round.verdict = verdict.verdict; round.feedback = verdict.feedback;
						transcript.push(`## Round ${index} reviewer\n\n${rawReview}${fileCheckFailure ? `\n\nController file-bound check changed this ready verdict to revise: ${fileCheckFailure}` : ""}`);
						await save(ctx, goal);
						if (verdict.verdict === "ready" || verdict.verdict === "replan" || verdict.verdict === "blocked") { task.loopStopReason = verdict.verdict; break; }
						nextMessage = `Continue only the same frozen task and plan. Fresh reviewer feedback from round ${index}: ${verdict.feedback}\nDo a bounded local repair, report concrete changes and verification. Do not expand scope or silently restart an external action whose outcome is unknown.`;
					}
					const reportPath = path.join(dir, "report.md");
					const renderReport = () => `# M07 execution\n\nStop: ${task.loopStopReason ?? "incomplete"}\n\n${transcript.join("\n\n")}\n`;
					await writeFileAtomic(reportPath, renderReport());
					task.reportPath = reportPath; task.status = "returned";
				} else {
					await verifyDispatchKnowledge();
					event.deliveryStatus = "submitted"; event.providerUsageSessionId = handle.ref.id; await writeProjectionEvent(ctx.ws, event);
					if (operation) { operation.status = "issued"; await save(ctx, goal); }
					promptIssued = true;
					const report = (await handle.prompt(message)).text; if (operation) operation.status = "response-received"; await verifyFrozenInputs(); if (task.experienceSelection) task.experienceSelection.loadedAt = nowIso(); const reportPath = path.join(dir, "report.md"); await writeFileAtomic(reportPath, report);
					task.reportPath = reportPath; task.status = "returned";
				}
			} catch (error) {
				task.status = "failed"; task.executionFailure = (error as Error).message;
				if (activeOperation?.status === "prepared") activeOperation.status = "not-issued";
				if (activeOperation && promptIssued && activeOperation.status === "issued") {
					const requestNotSent = requestNotSentDetails(error);
					const terminalResponse = settledTerminalResponseDetails(error);
					let confinedGrantVerified = false;
					if ((requestNotSent || terminalResponse) && handle && ctx.runner.attestConfinedGrant) {
						try {
							const grant = await ctx.runner.attestConfinedGrant(handle);
							confinedGrantVerified = grant?.version === 1 && grant.kind === "confined-campaign-files" &&
								await realpath(grant.root) === await realpath(task.workDir);
						} catch { /* A missing or failed live grant attestation leaves the operation unknown. */ }
					}
					if (requestNotSent?.requestNotSent === true &&
						requestNotSent.noProviderRequestsInPrompt === true &&
						requestNotSent.effectScope === "factory-attested-confined-file-tools" &&
						confinedGrantVerified) {
						try {
							const receiptPath = path.join(dir, "request-contract-not-issued-receipt.json");
							await writeFileAtomic(receiptPath, `${JSON.stringify({ version: 1,
								kind: "m07-host-request-contract-not-issued", goalRunId: runId,
								taskId: id, operationId: activeOperation.id,
								requestNotSent: true, noProviderRequestsInPrompt: true,
								violation: requestNotSent.violation, messageIndex: requestNotSent.messageIndex,
								effectScope: requestNotSent.effectScope,
								observedAt: nowIso() }, null, 2)}\n`);
							activeOperation.status = "not-issued";
							activeOperation.resolvedAt = nowIso();
							activeOperation.observationMethod = "host-request-contract-preflight";
							activeOperation.evidencePath = receiptPath;
							task.loopStopReason = "request-contract-invalid";
						} catch { activeOperation.status = "unknown"; }
					} else if (terminalResponse?.effectScope === "factory-attested-confined-file-tools" && confinedGrantVerified) {
						try {
							const receiptPath = path.join(dir, "terminal-response-receipt.json");
							await writeFileAtomic(receiptPath, `${JSON.stringify({ version: 1,
								kind: "m07-incomplete-settled-terminal-response", goalRunId: runId,
								taskId: id, operationId: activeOperation.id,
								settledProviderRequestCount: terminalResponse.settledProviderRequestCount,
								responseReceived: true, terminalStopReason: "length", taskComplete: false,
								effectScope: terminalResponse.effectScope,
								observedAt: nowIso() }, null, 2)}\n`);
							activeOperation.status = "terminal-response-incomplete";
							activeOperation.resolvedAt = nowIso();
							activeOperation.observationMethod = "host-terminal-response";
							activeOperation.evidencePath = receiptPath;
							task.loopStopReason = "output-limit";
						} catch { activeOperation.status = "unknown"; }
					} else activeOperation.status = "unknown";
				}
			} finally {
				if (handle) {
					if (task.mode === "execute" && task.status === "returned") {
						try {
							if (!ctx.runner.checkpoint) throw new HarnessError("m07.branch-unsupported", "runner has no stable checkpoint capability");
							if (goal.executionState?.operations.some((item) => !["response-received", "partial-settled", "terminal-response-incomplete", "confirmed", "not-issued"].includes(item.status))) throw new HarnessError("m07.branch", "external operation is not settled");
							const frozen = await freezeBranchWork(goal, task);
							const checkpoint = await ctx.runner.checkpoint(handle, { inputManifest: frozen.manifestPath, runId, taskId: id, externalOperationsSettled: true });
							task.branchSource = { version: 1, checkpoint, manifestPath: frozen.manifestPath, workSnapshotRoot: frozen.workSnapshotRoot, problemSnapshotCopy: frozen.problemSnapshotCopy };
						} catch (error) { task.branchUnavailableReason = (error as Error).message; }
					}
					task.readCoverage = handle.readCoverage(); task.toolLog.push(...handle.toolLog()); handle.dispose();
				}
				task.returnedAt = nowIso(); await save(ctx, goal);
			}
			return task;
			});
		},

		async review(runId, input) {
			return withGoalDispatch(ctx, runId, async () => {
			const goal = await load(ctx, runId); requireActive(goal); const task = goal.tasks.find((t) => t.taskId === input.taskId); if (!task) throw new HarnessError("m07.task", `未知任务 ${input.taskId}`);
			if (goal.decisions.some((d) => d.status === "open" && d.relatedTaskIds.includes(task.taskId))) throw new HarnessError("m07.decision", "该任务关联待用户决定事项，不能采用；不受影响任务仍可继续");
			if (task.status !== "returned") throw new HarnessError("m07.review", `任务 ${task.taskId} 状态为 ${task.status}，不能评审采用`);
			const taskRoot = await realpath(path.dirname(task.workDir)); const reportReal = task.reportPath ? await realpath(task.reportPath) : undefined;
			const readySnapshot = task.executionLoop && task.loopStopReason === "ready" ? task.executionRounds?.at(-1)?.reviewerSnapshotPath : undefined;
			const ensureRoundReviewed = async (source: string): Promise<void> => {
				if (!task.executionLoop || task.loopStopReason !== "ready" || source === reportReal) return;
				if (!readySnapshot || !inside(await realpath(task.workDir), source)) throw new HarnessError("m07.review", "bounded-loop evidence was not in the ready reviewer work snapshot");
				const relative = path.relative(task.workDir, source);
				let frozen: string;
				try { frozen = await realpath(path.join(readySnapshot, relative)); }
				catch { throw new HarnessError("m07.review", `evidence was added after ready review: ${relative}`); }
				if (!inside(await realpath(readySnapshot), frozen) || !(await readFile(source)).equals(await readFile(frozen))) throw new HarnessError("m07.review", `evidence changed after ready review: ${relative}`);
			};
			if (!input.artifacts.length || !input.checks.length) throw new HarnessError("m07.review", "不能用空 artifacts 或空 checks 接受任务；reason/check 可提交自动保存的 report.md");
			const snapshotDir = path.join(path.dirname(task.workDir), "review-snapshot"); await mkdir(snapshotDir, { recursive: true });
			const frozenBySource = new Map<string, string>(); let frozenIndex = 0;
			const freeze = async (source: string): Promise<string> => { const found = frozenBySource.get(source); if (found) return found; const target = path.join(snapshotDir, uniqueName(frozenIndex++, source)); await copyFile(source, target); const frozen = await realpath(target); frozenBySource.set(source, frozen); return frozen; };
			if (!reportReal) throw new HarnessError("m07.review", "任务没有可冻结的会话报告");
			const frozenReportPath = await freeze(reportReal);
			const artifacts: EvidenceFile[] = []; for (const p of input.artifacts) { const resolved = await confinedExistingFile(ctx, p); if (!inside(taskRoot, resolved) && resolved !== reportReal) throw new HarnessError("m07.review", `成果不属于任务固定目录或会话报告：${p}`); await ensureRoundReviewed(resolved); artifacts.push({ path: await freeze(resolved), sourcePath: resolved, mediaType: mediaType(resolved), readCoverage: mediaType(resolved) === "text" ? "recorded-not-reviewed" : "unread-binary" }); }
			const checks: TaskCheck[] = []; for (const check of input.checks) { if (!task.checks.includes(check.criterion)) throw new HarnessError("m07.review", `检查不属于任务定义：${check.criterion}`); const evidence = []; for (const p of check.evidence) { const resolved = await confinedExistingFile(ctx, p); if (!inside(taskRoot, resolved) && resolved !== reportReal) throw new HarnessError("m07.review", `检查证据不属于任务固定目录或会话报告：${p}`); await ensureRoundReviewed(resolved); evidence.push(await freeze(resolved)); } if (check.result === "passed" && !evidence.length) throw new HarnessError("m07.review", `通过检查必须有实际文件证据：${check.criterion}`); checks.push({ ...check, evidence }); }
			if (task.checks.some((criterion) => !checks.some((c) => c.criterion === criterion))) throw new HarnessError("m07.review", "必须逐项记录任务定义的全部 checks");
			if (task.requireIndependentCheck) {
				const independent = input.independentCheck; if (!independent) throw new HarnessError("m07.review", "该任务要求独立检查，必须引用独立 check 任务报告并说明对发现的处置");
				const checkTask = goal.tasks.find((t) => t.taskId === independent.taskId); if (!checkTask || checkTask.mode !== "check" || !["returned", "accepted"].includes(checkTask.status)) throw new HarnessError("m07.review", "独立检查必须是另一个已返回的 check 任务");
				if (!independent.disposition.trim()) throw new HarnessError("m07.review", "必须显式说明如何处置独立检查发现");
				independent.report = await confinedExistingFile(ctx, independent.report);
				if (!checkTask.reportPath || independent.report !== await realpath(checkTask.reportPath)) throw new HarnessError("m07.review", "引用的独立检查报告与 check 任务不一致");
				independent.report = await freeze(independent.report);
				for (const artifact of artifacts) {
					let matchingCopy: M07TaskRecord["inputCopies"][number] | undefined;
					for (const copy of checkTask.inputCopies) if ((await readFile(copy.copy)).equals(await readFile(artifact.path))) { matchingCopy = copy; break; }
					if (!matchingCopy) throw new HarnessError("m07.review", `独立 check 未取得当前提交版本的成果：${path.basename(artifact.path)}`);
					if (artifact.mediaType === "binary") { const relativeCopy = path.relative(checkTask.workDir, matchingCopy.copy); if (!checkTask.readCoverage.includes(relativeCopy)) throw new HarnessError("m07.review", `二进制成果没有独立 check 的真实读取记录：${relativeCopy}`); }
				}
			}
			const failures = [...(input.failures ?? [])], unexecuted = [...(input.unexecuted ?? [])], limitations = input.limitations ?? [];
			const addExpectedArtifact = async (source: string): Promise<void> => {
				if (artifacts.some((item) => item.sourcePath === source)) return;
				await ensureRoundReviewed(source);
				const type = mediaType(source);
				artifacts.push({ path: await freeze(source), sourcePath: source, mediaType: type, readCoverage: type === "text" ? "recorded-not-reviewed" : "unread-binary" });
			};
			const candidateFiles = await validateCandidateFiles(task.workDir, task.expectedOutputPaths, task.lessonDeltaOutput);
			const expectedOutputs = candidateFiles.expectedOutputs;
			for (const expected of expectedOutputs) {
				if (expected.error) { failures.push(expected.error); continue; }
				for (const file of expected.files) await addExpectedArtifact(file);
			}
			if (task.executionLoop && task.loopStopReason === "ready") {
				const reviewerRoot = task.executionRounds?.at(-1)?.reviewerSnapshotPath;
				if (!reviewerRoot) failures.push("Ready verdict has no immutable round snapshot");
				else {
					const frozenOutputs = await resolveExpectedOutputFiles(reviewerRoot, task.expectedOutputs.map((item) => path.join(reviewerRoot, item)));
					for (let i = 0; i < expectedOutputs.length; i++) {
						if (expectedOutputs[i].error || frozenOutputs[i].error) { failures.push(`Ready snapshot lacks expected output ${task.expectedOutputs[i]}`); continue; }
						const currentFiles = expectedOutputs[i].files.map((file) => path.relative(task.workDir, file)).sort();
						const frozenFiles = frozenOutputs[i].files.map((file) => path.relative(reviewerRoot, file)).sort();
						if (!sameStrings(currentFiles, frozenFiles)) { failures.push(`Output set changed after ready review: ${task.expectedOutputs[i]}`); continue; }
						for (const relative of currentFiles) if (!(await readFile(path.join(task.workDir, relative))).equals(await readFile(path.join(reviewerRoot, relative)))) failures.push(`Output bytes changed after ready review: ${relative}`);
					}
				}
			}
			if (candidateFiles.lessonDeltaFailure) failures.push(candidateFiles.lessonDeltaFailure);
			for (const evidence of candidateFiles.lessonEvidence) await addExpectedArtifact(evidence);
			if (task.executionLoop && task.loopStopReason !== "ready") failures.push(`Bounded execution stopped without a ready handoff: ${task.loopStopReason ?? "unknown"}`);
			const accepted = checks.every((c) => c.result === "passed") && !failures.length && !unexecuted.length;
			task.status = accepted ? "accepted" : "rejected"; task.review = { at: nowIso(), frozenReportPath, checks, artifacts, failures, unexecuted, limitations, independentCheck: input.independentCheck };
			await save(ctx, goal); return task;
			});
		},

		async selectBranch(runId, input) {
			return withGoalDispatch(ctx, runId, async () => {
			const goal = await load(ctx, runId); requireActive(goal);
			if (goal.tasks.some((item) => ["running", "unknown"].includes(item.status)) || goal.executionState?.operations.some((item) => ["prepared", "issued", "unknown"].includes(item.status))) throw new HarnessError("m07.branch", "active tasks or unresolved external operations must settle before branch selection");
			await requireCurrentFormalBaseline(ctx, goal);
			await verifyFrozenWorkflowMethod(ctx, goal, options.registeredExperienceStores);
			if (goal.knowledgeSnapshot && (await ctx.store.current())?.id !== goal.knowledgeSnapshot) throw new HarnessError("m07.branch", "knowledge snapshot changed since branch creation; refresh explicitly instead of selecting under changed authority");
			const parent = goal.tasks.find((item) => item.taskId === input.parentTaskId);
			if (!parent?.branchSource || parent.context) throw new HarnessError("m07.branch", "branch selection requires a frozen original task");
			if (!parent.review || !["accepted", "rejected"].includes(parent.status)) throw new HarnessError("m07.branch", "original task must receive ordinary M07 review before competitive selection");
			const candidates = goal.tasks.filter((item) => item.context?.parentRunId === runId && item.context.parentTaskId === parent.taskId && item.context.checkpointId === parent.branchSource!.checkpoint.id);
			if (!candidates.length || candidates.some((item) => !["accepted", "rejected", "failed"].includes(item.status))) throw new HarnessError("m07.branch", "every returned candidate must receive ordinary M07 review before selection; running candidates block selection");
			if (goal.branchSelections?.some((item) => item.parentTaskId === parent.taskId)) throw new HarnessError("m07.branch", "branch selection has already been frozen");
			if (input.selectedTaskId && !(input.selectedTaskId === parent.taskId && parent.status === "accepted") && !candidates.some((item) => item.taskId === input.selectedTaskId && item.status === "accepted")) throw new HarnessError("m07.branch", "selected source or branch must be an ordinarily reviewed and accepted candidate");
			const rationale = nonempty(input.rationale, "branch selection rationale");
			const comparison = [parent, ...candidates].map((item) => ({ taskId: item.taskId, status: item.status, checks: item.review?.checks.map((check) => ({ criterion: check.criterion, result: check.result })) ?? [] }));
			goal.branchSelections = [...(goal.branchSelections ?? []), { version: 1, parentTaskId: parent.taskId, ...(input.selectedTaskId ? { selectedTaskId: input.selectedTaskId } : {}), rationale, selectedAt: nowIso(), candidates: comparison }];
			await save(ctx, goal); return goal;
			});
		},

		async decision(runId, input) {
			return withGoalDispatch(ctx, runId, async () => {
			const goal = await load(ctx, runId); requireActive(goal);
			for (const id of input.relatedTaskIds) if (!goal.tasks.some((t) => t.taskId === id)) throw new HarnessError("m07.decision", `未知相关任务 ${id}`);
			if (input.action === "request") goal.decisions.push({ id: `U${String(goal.decisions.length + 1).padStart(3, "0")}`, status: "open", question: nonempty(input.question ?? "", "question"), relatedTaskIds: input.relatedTaskIds, requestedAt: nowIso() });
			else { const open = goal.decisions.find((d) => d.status === "open" && d.relatedTaskIds.join("|") === input.relatedTaskIds.join("|")); if (!open) throw new HarnessError("m07.decision", "没有匹配的待用户决定事项"); open.status = "resolved"; open.decision = nonempty(input.decision ?? "", "decision"); open.resolvedAt = nowIso(); }
			await save(ctx, goal); return goal;
			});
		},

		async finish(runId, input) {
			return withGoalDispatch(ctx, runId, async () => {
			const goal = await load(ctx, runId); requireActive(goal);
			if (goal.executionContract?.mode === "continuous" && input.outcome !== "fulfilled") throw new HarnessError("m07.continuous", "continuous 目标不能由模型以 partial/blocked 或自述 stopReason 收口；只有原成功要求的 fulfilled 硬证据门或受信宿主中断可终结");
			let invalidBaseline: string | undefined;
			try { await requireCurrentFormalBaseline(ctx, goal); }
			catch (error) {
				if (input.outcome === "fulfilled") throw error;
				invalidBaseline = (error as Error).message;
				goal.formalBaseline = false;
				goal.exploratory = true;
			}
			if (goal.tasks.some((task) => task.status === "running")) throw new HarnessError("m07.finish", "存在状态未知的 running 任务；本版只能查看且不能结束目标、自动重跑或假称已停止");
			if (goal.tasks.some((task) => task.status === "unknown") || goal.executionState?.operations.some((operation) => ["prepared", "issued", "unknown"].includes(operation.status))) throw new HarnessError("m07.finish", "仍有外部动作或任务状态未知；先经宿主控制面对账，不能通过分支筛选隐藏未知结果");
			if (input.goalChecks.length !== goal.successCriteria.length || goal.successCriteria.some((criterion) => !input.goalChecks.some((c) => c.criterion === criterion))) throw new HarnessError("m07.finish", "必须逐项映射原目标 successCriteria，不能以子任务状态代替目标验收");
			const chosenBranches = new Map((goal.branchSelections ?? []).map((selection) => [selection.parentTaskId, selection.selectedTaskId]));
			const acceptedEvidence = new Map<string, string>(); for (const task of goal.tasks.filter((item) => item.status === "accepted" && (item.context ? chosenBranches.get(item.context.parentTaskId) === item.taskId : !chosenBranches.has(item.taskId) || chosenBranches.get(item.taskId) === item.taskId))) { if (task.reportPath && task.review) { const frozen = await realpath(task.review.frozenReportPath); acceptedEvidence.set(frozen, frozen); if (existsSync(task.reportPath)) acceptedEvidence.set(await realpath(task.reportPath), frozen); } for (const artifact of task.review?.artifacts ?? []) { const frozen = await realpath(artifact.path); acceptedEvidence.set(frozen, frozen); if (artifact.sourcePath && existsSync(artifact.sourcePath)) acceptedEvidence.set(await realpath(artifact.sourcePath), frozen); } for (const check of task.review?.checks ?? []) for (const evidence of check.evidence) { const frozen = await realpath(evidence); acceptedEvidence.set(frozen, frozen); } }
			const canonicalGoalChecks: TaskCheck[] = []; for (const check of input.goalChecks) { const evidence: string[] = []; for (const item of check.evidence) { const resolved = await confinedExistingFile(ctx, item); const frozen = acceptedEvidence.get(resolved); if (input.outcome === "fulfilled" && !frozen) throw new HarnessError("m07.finish", `目标验收证据不来自已接受任务：${item}`); if (frozen && resolved !== frozen && !(await readFile(resolved)).equals(await readFile(frozen))) throw new HarnessError("m07.finish", `已接受成果在验收后发生变化：${item}`); evidence.push(frozen ?? resolved); } canonicalGoalChecks.push({ ...check, evidence }); }
			const branchParents = new Set(goal.tasks.flatMap((item) => item.context ? [item.context.parentTaskId] : []));
			if (input.outcome === "fulfilled" && [...branchParents].some((id) => !goal.branchSelections?.some((selection) => selection.parentTaskId === id && selection.selectedTaskId))) throw new HarnessError("m07.finish", "competitive branches require an explicit reviewed winner before fulfilled");
			const byId = new Map(goal.tasks.map((item) => [item.taskId, item])); const superseded = new Set<string>();
			for (const accepted of goal.tasks.filter((item) => item.status === "accepted" && (!item.context || goal.branchSelections?.some((selection) => selection.parentTaskId === item.context?.parentTaskId && selection.selectedTaskId === item.taskId)))) { let prior = accepted.supersedesTaskId; while (prior && !superseded.has(prior)) { superseded.add(prior); prior = byId.get(prior)?.supersedesTaskId; } }
			for (const selection of goal.branchSelections ?? []) if (selection.selectedTaskId) for (const branch of goal.tasks.filter((item) => item.context?.parentTaskId === selection.parentTaskId && item.taskId !== selection.selectedTaskId)) superseded.add(branch.taskId);
			const effectiveTasks = goal.tasks.filter((item) => !superseded.has(item.taskId));
			if (input.outcome === "fulfilled") { if (canonicalGoalChecks.some((c) => c.result !== "passed" || !c.evidence.length)) throw new HarnessError("m07.finish", "fulfilled 要求每项原目标成功标准均通过并有实际文件证据"); if (goal.decisions.some((d) => d.status === "open")) throw new HarnessError("m07.finish", "存在待用户决定事项，不能标记 fulfilled"); if (effectiveTasks.some((t) => t.status !== "accepted")) throw new HarnessError("m07.finish", "存在未接受且未被合法替代的任务，不能标记 fulfilled"); if (!goal.tasks.length) throw new HarnessError("m07.finish", "没有实际任务，不能标记 fulfilled"); }
			goal.goalChecks = canonicalGoalChecks;
			goal.lifecycle = "finished"; goal.outcome = input.outcome; goal.finishSummary = nonempty(input.summary, "summary"); goal.returnPath = input.returnPath; goal.limitations.push(...(input.limitations ?? []));
			if (invalidBaseline) goal.limitations.push(`原正式基线已失效：${invalidBaseline}；本次仅如实记录 ${input.outcome} 并回流，不表示原目标完成。`);
			try {
				goal.feedbackPath = await writeFeedback(ctx, goal, snapshotLimits);
				goal.feedbackStatus = "complete";
				delete goal.feedbackError;
			} catch (error) {
				if (!isFeedbackControlOverflow(error)) throw error;
				goal.feedbackError = { code: "context.budget", summary: (error as Error).message.slice(0, 500) };
				goal.feedbackPath = await writeBoundedFeedbackIndex(ctx, goal, "finish");
				goal.feedbackStatus = "indexed";
			}
			await save(ctx, goal);
			const run = await ctx.ws.readRun("M07", runId); run.outputs.push({ label: "M07 实际执行反馈包", path: goal.feedbackPath }); run.remarks.push(`目标结果 ${input.outcome}；主 Agent 选择返回 ${input.returnPath}。会话返回不等于科学验收。反馈状态 ${goal.feedbackStatus}；索引不代表 M04 已读取原证据。`); for (const t of goal.tasks) { if (t.session && !run.sessions.some((session) => session.id === t.session!.id)) run.sessions.push({ label: t.session.label, role: t.session.role, id: t.session.id, file: t.session.file, model: t.session.model }); if (t.executionFailure) run.failures.push(`${t.taskId} 执行失败：${t.executionFailure}`); if (t.review) { for (const f of t.review.failures) run.failures.push(`${t.taskId}：${f}`); for (const u of t.review.unexecuted) run.failures.push(`${t.taskId} 未执行：${u}`); } } await ctx.ws.finishRun(run, input.outcome === "blocked" ? "failed" : "completed"); await ctx.ws.writeNote(run, `M07 主 Agent 目标式执行；保留原目标、所有任务、失败、未执行和限制。最终选择返回 ${input.returnPath}。`);
			return goal;
			});
		},

		async interrupt(runId, input: InterruptInput, authorization?: typeof HOST_STOP_KEY, hostReceipt?: HostStopReceipt) {
			return withGoalDispatch(ctx, runId, async () => {
			const goal = await load(ctx, runId); requireActive(goal);
			if (goal.executionContract?.mode === "continuous" && (authorization !== HOST_STOP_KEY || hostReceipt?.goalRunId !== runId)) throw new HarnessError("m07.continuous", "continuous 目标不接受模型或外部 JSON 的 interrupt；仅受信宿主生命周期事件可归档");
			if (authorization === HOST_STOP_KEY && hostReceipt?.goalRunId === runId) goal.hostStopReceipt = hostReceipt;
			const reason = nonempty(input.reason, "reason");
			const at = nowIso();
			const interrupted: string[] = [];
			for (const task of goal.tasks) {
				if (task.status !== "running") continue;
				task.status = "failed";
				task.returnedAt = at;
				task.executionFailure = `受控中断归档：${reason}`;
				interrupted.push(task.taskId);
			}
			goal.lifecycle = "finished";
			goal.outcome = "blocked";
			goal.finishSummary = `目标在受控中断后归档为 blocked；原因：${reason}`;
			goal.returnPath = input.returnPath ?? "user";
			goal.limitations.push(`受控中断归档：${reason}`);
			goal.goalChecks = goal.successCriteria.map((criterion) => ({ criterion, result: "not_run" as const, evidence: [] }));
			const legacy = !goal.budgetPolicy || !goal.budgetPolicyVersionId || !goal.budgetPolicyFrozenAt;
			if (legacy) goal.limitations.push("旧目标缺少冻结预算策略；中断反馈只登记控制事实与证据位置，未读取证据正文，也未套用当前 active policy。");
			goal.feedbackStatus = "pending";
			goal.feedbackError = { code: "m07.archive-pending", summary: "中断终态已记录，反馈尚未完成；若此状态持续则需要修复交接。" };
			const run = await ctx.ws.readRun("M07", runId);
			for (const id of interrupted) run.failures.push(`${id} 执行失败：受控中断归档：${reason}`);
			run.remarks.push(`目标受控中断归档为 blocked；返回 ${goal.returnPath}。只记录实际中断事实，不自动重跑或假称完成。`);
			try {
				await save(ctx, goal);
				await ctx.ws.finishRun(run, "failed");
			} catch (error) {
				throw new HarnessError("m07.archive-repair-required", `M07 ${runId} 终态写入未完成；检查 goal.json 与 run.json 后修复，不得只关闭其中一方：${(error as Error).message}`);
			}
			let feedbackFailure: unknown;
			try {
				if (legacy) {
					goal.feedbackPath = await writeLegacyInterruptFeedback(ctx, goal);
					goal.feedbackStatus = "control-facts-only";
					goal.feedbackError = { code: "m07.policy-legacy", summary: "旧目标没有冻结策略；仅归档控制事实和证据位置。" };
				} else {
					goal.feedbackPath = await writeFeedback(ctx, goal, snapshotLimits);
					goal.feedbackStatus = "complete";
					delete goal.feedbackError;
				}
			} catch (error) {
				feedbackFailure = error;
				goal.feedbackError = { code: error instanceof HarnessError ? error.code : "m07.feedback-write", summary: (error as Error).message.slice(0, 500) };
				goal.limitations.push("完整反馈生成失败；原控制记录及冻结证据未删除。中断控制事实仅提供证据位置，不表示完整交接或科学验收。");
				try {
					goal.feedbackPath = await writeBoundedFeedbackIndex(ctx, goal, "interrupt");
					goal.feedbackStatus = "control-facts-only";
				} catch (fallbackError) {
					delete goal.feedbackPath;
					goal.feedbackStatus = "failed";
					goal.feedbackError = { code: "m07.archive-repair-required", summary: `完整反馈：${goal.feedbackError.code}；控制事实索引：${fallbackError instanceof HarnessError ? fallbackError.code : "write-failed"}。需按 goal.json 修复交接。` };
				}
			}
			try {
				await save(ctx, goal);
				if (goal.feedbackPath) run.outputs.push({ label: "M07 实际执行反馈包", path: goal.feedbackPath });
				if (feedbackFailure) run.failures.push(`反馈生成失败（${goal.feedbackError?.code ?? "unknown"}）；${goal.feedbackStatus === "control-facts-only" ? "仅有界控制事实可供 M04 读取，原证据须另行核查" : "无反馈包，交接需修复"}`);
				run.remarks.push(`反馈归档状态：${goal.feedbackStatus}；${goal.feedbackStatus === "complete" ? "已生成冻结策略下的完整反馈包" : "未完成科学证据交接"}。`);
				await ctx.ws.writeRun(run);
			} catch (error) {
				throw new HarnessError("m07.archive-repair-required", `M07 ${runId} 反馈归档状态写入未完成；检查 goal.json 与 run.json 后修复：${(error as Error).message}`);
			}
			await ctx.ws.writeNote(run, `M07 目标受控中断归档；running 任务 ${interrupted.join("、") || "无"} 记为 failed；原因：${reason}。`);
			return goal;
			});
		},
		async hostInterrupt(runId, input) {
			if (!HOST_STOP_REASONS.has(input.reasonKind)) throw new HarnessError("m07.host-stop", "未知宿主停止事件");
			if (input.sourceEventId !== undefined && (typeof input.sourceEventId !== "string" || input.sourceEventId.length > 128 || !/^[A-Za-z0-9._:-]+$/.test(input.sourceEventId))) throw new HarnessError("m07.host-stop", "宿主事件 ID 无效");
			const receipt: HostStopReceipt = { version: 1, id: randomUUID(), goalRunId: runId, source: "pi-host", reasonKind: input.reasonKind, observedAt: nowIso(), ...(input.sourceEventId ? { sourceEventId: input.sourceEventId } : {}) };
			const interruptWithAuthority = this.interrupt as (goalRunId: string, request: InterruptInput, key: typeof HOST_STOP_KEY, witness: HostStopReceipt) => Promise<CurrentGoal>;
			return interruptWithAuthority(runId, { reason: `受信宿主生命周期停止：${input.reasonKind}`, returnPath: "user" }, HOST_STOP_KEY, receipt);
		},
		async hostSuspend(runId, input) {
			return withGoalDispatch(ctx, runId, async () => {
			if (!HOST_STOP_REASONS.has(input.reasonKind)) throw new HarnessError("m07.host-stop", "未知宿主停止事件");
			if (input.sourceEventId !== undefined && (typeof input.sourceEventId !== "string" || input.sourceEventId.length > 128 || !/^[A-Za-z0-9._:-]+$/.test(input.sourceEventId))) throw new HarnessError("m07.host-stop", "宿主事件 ID 无效");
			const goal = await load(ctx, runId); requireActive(goal);
			const state = goal.executionState;
			if (!state) throw new HarnessError("m07.recovery", "旧目标缺少执行尝试状态；保留旧归档语义，不自动迁移");
			const attempt = state.attempts.find((item) => item.id === state.activeAttemptId);
			if (!attempt || attempt.state !== "running") throw new HarnessError("m07.recovery", "当前执行尝试不是运行态");
			const receipt: HostStopReceipt = { version: 1, id: randomUUID(), goalRunId: runId, source: "pi-host", reasonKind: input.reasonKind, observedAt: nowIso(), ...(input.sourceEventId ? { sourceEventId: input.sourceEventId } : {}) };
			for (const task of goal.tasks) {
				if (task.status !== "running") continue;
			task.status = task.mode === "execute" ? "unknown" : "failed";
				task.executionFailure = `宿主停止时任务结果未确认：${input.reasonKind}；不得自动重放`;
				task.returnedAt = receipt.observedAt;
				const operation = state.operations.find((item) => item.taskId === task.taskId && ["prepared", "issued"].includes(item.status));
				if (operation) operation.status = operation.status === "issued" ? "unknown" : "not-issued";
			}
			attempt.endedAt = receipt.observedAt;
			attempt.stopReceipt = receipt;
			attempt.state = state.operations.some((item) => item.status === "unknown") || goal.tasks.some((item) => item.status === "unknown") ? "recovery-required" : "suspended";
			const controlDir = path.join(ctx.ws.runDir("M07", runId), "control-checkpoints");
			const controlPath = path.join(controlDir, `${attempt.id}.json`);
			await writeFileAtomic(controlPath, `${JSON.stringify({ version: 1, goalRunId: runId, attemptId: attempt.id, state: attempt.state, goalStatePath: statePath(ctx, runId), taskIds: goal.tasks.map((item) => item.taskId), unresolvedOperationIds: state.operations.filter((item) => item.status === "unknown").map((item) => item.id), knowledgeSnapshot: goal.knowledgeSnapshot, at: receipt.observedAt }, null, 2)}\n`);
			attempt.controlCheckpointPath = controlPath;
			await save(ctx, goal);
			const run = await ctx.ws.readRun("M07", runId);
			run.remarks.push(`执行尝试 ${attempt.id} 因 ${input.reasonKind} ${attempt.state}；目标仍 active，原成功要求未变。控制 checkpoint 是恢复索引，不是 M04 科学验收。`);
			await ctx.ws.writeRun(run);
			return goal;
			});
		},
		async hostRecover(runId, input) {
			// Recovery deliberately does not take over a possibly stale dispatch lock:
			// it proves the old process dead, atomically claims a new attempt, and
			// leaves any residual dispatch lock for exact manual review before work.
			const goal = await load(ctx, runId);
			if (goal.lifecycle !== "active" || !goal.executionState) throw new HarnessError("m07.recovery", "只恢复有版本化 executionState 的 active 目标；旧终态须显式建立 successor");
			const state = goal.executionState;
			const prior = state.attempts.find((item) => item.id === state.activeAttemptId);
			if (!prior || prior.id !== input.expectedAttemptId) throw new HarnessError("m07.recovery", "恢复所指定的旧 attempt 与持久状态不匹配");
			const nextId = nextAttemptId(goal);
			const descriptor = validateRecoveryDescriptor(goal, input.runDescriptor, nextId);
			if (descriptor.instanceId === prior.runDescriptor.instanceId || sameProcess(descriptor.process, prior.runDescriptor.process)) throw new HarnessError("m07.recovery", "恢复必须使用新的独立 Pi 进程与实例身份");
			const newProbe = await (options.probeProcess ?? probeProcessIdentity)(descriptor.process);
			if (newProbe.status !== "alive" || !newProbe.identityMatch) throw new HarnessError("m07.recovery", "新 Pi 进程身份不可验证，拒绝恢复");
			const oldProbe = await (options.probeProcess ?? probeProcessIdentity)(prior.runDescriptor.process);
			if (oldProbe.status !== "dead" || prior.runDescriptor.process.hostId !== descriptor.process.hostId || prior.runDescriptor.process.bootId !== descriptor.process.bootId) throw new HarnessError("m07.recovery", "旧 attempt 的进程仍存活或身份未知，拒绝并行恢复");
			if (prior.state === "running") {
				prior.state = "recovery-required";
				prior.endedAt = nowIso();
				for (const task of goal.tasks.filter((item) => item.status === "running")) {
					task.status = task.mode === "execute" ? "unknown" : "failed";
					task.executionFailure = "旧进程已死，任务响应及外部副作用待对账；不得自动重放";
					task.returnedAt = nowIso();
					const operation = state.operations.find((item) => item.taskId === task.taskId && ["issued", "prepared"].includes(item.status));
					if (operation) operation.status = operation.status === "issued" ? "unknown" : "not-issued";
				}
				const controlPath = path.join(ctx.ws.runDir("M07", runId), "control-checkpoints", `${prior.id}.json`);
				await writeFileAtomic(controlPath, `${JSON.stringify({ version: 1, goalRunId: runId, attemptId: prior.id, state: prior.state, goalStatePath: statePath(ctx, runId), taskIds: goal.tasks.map((item) => item.taskId), unresolvedOperationIds: state.operations.filter((item) => item.status === "unknown").map((item) => item.id), knowledgeSnapshot: goal.knowledgeSnapshot, at: prior.endedAt }, null, 2)}\n`);
				prior.controlCheckpointPath = controlPath;
			} else if (!['suspended', 'recovery-required'].includes(prior.state)) throw new HarnessError("m07.recovery", "旧 attempt 不能恢复");
			frozenPolicy(goal);
			await verifyFrozenWorkflowMethod(ctx, goal, options.registeredExperienceStores);
			await requireCurrentFormalBaseline(ctx, goal);
			const claimsDir = path.join(ctx.ws.runDir("M07", runId), "attempt-claims");
			await mkdir(claimsDir, { recursive: true });
			try { await mkdir(path.join(claimsDir, nextId)); }
			catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new HarnessError("m07.recovery", `执行尝试 ${nextId} 已被另一恢复者占用；核对 goal.json 和 claim 后处理`); throw error; }
			state.attempts.push({ version: 1, id: nextId, state: "running", startedAt: nowIso(), runDescriptor: descriptor });
			state.activeAttemptId = nextId;
			await save(ctx, goal);
			const run = await ctx.ws.readRun("M07", runId);
			run.remarks.push(`新执行尝试 ${nextId} 已在新 Pi 身份启动；旧会话未 resume。未知副作用仍阻断 execute 委派。`);
			await ctx.ws.writeRun(run);
			return goal;
		},
		async hostReconcileOperation(runId, input) {
			return withGoalDispatch(ctx, runId, async () => {
			const goal = await load(ctx, runId);
			if (goal.lifecycle !== "active" || !goal.executionState) throw new HarnessError("m07.operation", "目标无可对账的执行状态");
			const operation = goal.executionState.operations.find((item) => item.id === input.operationId);
			if (!operation || operation.status !== "unknown") throw new HarnessError("m07.operation", "操作不存在或已完成对账");
			const source = await confinedExistingFile(ctx, input.evidencePath);
			const bytes = await readFile(source);
			if (bytes.length > 64 * 1024) throw new HarnessError("m07.operation", "对账回执超过 64 KiB");
			let evidence: { version?: unknown; operationId?: unknown; observationMethod?: unknown; observedStatus?: unknown; observedAt?: unknown; externalId?: unknown };
			try { evidence = JSON.parse(bytes.toString("utf8")); }
			catch { throw new HarnessError("m07.operation", "对账证据必须是可读取的结构化 JSON 回执"); }
			if (evidence.version !== 1 || evidence.operationId !== operation.id || evidence.observationMethod !== "external-query" || !["confirmed", "not-issued", "unknown"].includes(String(evidence.observedStatus)) || typeof evidence.observedAt !== "string" || !evidence.observedAt.trim() || (evidence.observedStatus === "confirmed" && (typeof evidence.externalId !== "string" || !evidence.externalId.trim()))) throw new HarnessError("m07.operation", "对账回执须含匹配 operationId、外部查询方法、明确状态及观察时间；确认执行还需远端 ID");
			const frozen = path.join(ctx.ws.runDir("M07", runId), "operation-receipts", `${operation.id}-${randomUUID()}.json`);
			await writeFileAtomic(frozen, bytes.toString("utf8"));
			operation.evidencePath = frozen;
			operation.observationMethod = "external-query";
			if (typeof evidence.externalId === "string") operation.externalId = evidence.externalId;
			if (evidence.observedStatus === "unknown") { await save(ctx, goal); return goal; }
			operation.status = evidence.observedStatus as "confirmed" | "not-issued";
			operation.resolvedAt = nowIso();
			const task = goal.tasks.find((item) => item.taskId === operation.taskId);
			if (task?.status === "unknown") { task.status = "failed"; task.executionFailure = `原响应丢失，外部查询结果 ${operation.status}；证据 ${frozen}。任务未自动重放或采用。`; }
			await save(ctx, goal);
			return goal;
			});
		},
		async hostCreateSuccessor(runId, input) {
			return withGoalDispatch(ctx, runId, async () => {
			const prior = await load(ctx, runId);
			if (prior.lifecycle !== "finished" || prior.outcome !== "blocked") throw new HarnessError("m07.successor", "仅旧 blocked 终态可显式建立关联后继；原记录保持只读");
			frozenPolicy(prior);
			await verifyFrozenWorkflowMethod(ctx, prior, options.registeredExperienceStores);
			if (prior.knowledgeSnapshot !== (await ctx.store.current())?.id) throw new HarnessError("m07.successor", "原知识快照已不可作为当前基线；先对账，不得悄套新 K");
			await requireCurrentFormalBaseline(ctx, prior);
			const descriptor = parseRunDescriptor(input.runDescriptor);
			const probe = await (options.probeProcess ?? probeProcessIdentity)(descriptor.process);
			if (probe.status !== "alive" || !probe.identityMatch) throw new HarnessError("m07.successor", "新进程身份不可验证");
			if (prior.executionState?.operations.some((item) => item.status === "unknown")) throw new HarnessError("m07.successor", "旧目标有未对账外部动作；先查询确认，不得建立可执行后继");
			try { await mkdir(path.join(ctx.ws.runDir("M07", runId), "successor.claim")); }
			catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new HarnessError("m07.successor", "此旧目标已有后继建立声明；核对原目标和后继运行，不能重复迁移"); throw error; }
			const problem = await readFile(prior.problemSnapshotPath, "utf8");
			const run = await ctx.ws.startRun("M07", [{ label: "原目标冻结问题", path: prior.problemSnapshotPath }], prior.knowledgeSnapshot);
			const frozen = path.join(ctx.ws.runDir("M07", run.runId), "problem-snapshot.md");
			await writeFileAtomic(frozen, problem);
			const newDescriptor: RunDescriptorV1 = { ...descriptor, attemptId: "A001", goalRunId: run.runId, workspaceId: await ctx.store.storeId(), controlDir: ctx.ws.runDir("M07", run.runId) };
			const successor: CurrentGoal = { version: 1, runId: run.runId, lifecycle: "active", startedAt: run.startedAt, updatedAt: run.startedAt, goal: prior.goal, problemRelation: prior.problemRelation, constraints: [...prior.constraints], successCriteria: [...prior.successCriteria], plan: prior.plan, exploratory: prior.exploratory, formalBaseline: prior.formalBaseline, problemSnapshotPath: frozen, knowledgeSnapshot: prior.knowledgeSnapshot, m04BaselineRunId: prior.m04BaselineRunId, baselineHistory: structuredClone(prior.baselineHistory), budgetPolicy: structuredClone(prior.budgetPolicy), budgetPolicyVersionId: prior.budgetPolicyVersionId, budgetPolicyFrozenAt: prior.budgetPolicyFrozenAt, methodBinding: prior.methodBinding ? structuredClone(prior.methodBinding) : undefined, workflowMethod: prior.workflowMethod ? structuredClone(prior.workflowMethod) : undefined, executionContract: prior.executionContract ? structuredClone(prior.executionContract) : undefined, predecessorGoalRunId: prior.runId, executionState: { version: 1, activeAttemptId: "A001", attempts: [{ version: 1, id: "A001", state: "running", startedAt: run.startedAt, runDescriptor: newDescriptor }], operations: [] }, tasks: [], decisions: structuredClone(prior.decisions), limitations: [`继承旧目标 ${prior.runId} 的冻结义务、K、策略和方法；旧任务及证据仍在原记录，须重新检查后采用。`] };
			await save(ctx, successor);
			run.remarks.push(`显式 successor of ${prior.runId}；旧 blocked goal.json 未修改。新目标保留原成功标准和冻结策略。`);
			await ctx.ws.writeRun(run);
			return successor;
			});
		},
	};
}

export type { M07Controller } from "./types.ts";
