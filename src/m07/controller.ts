import { createReadStream, createWriteStream } from "node:fs";
import { randomUUID } from "node:crypto";
import { copyFile, lstat, mkdir, readFile, readdir, realpath, stat, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import { loadPrompt, section, systemPromptFor } from "../prompts.ts";
import { HarnessError } from "../types.ts";
import { nowIso, readTextIfExists, writeFileAtomic } from "../workspace.ts";
import { isTextFile, mediaType } from "../media.ts";
import { recordSession, sessionSpec, type StageContext } from "../stages/context.ts";
import { isSafeRelativeOutputPath, resolveExpectedOutputFiles } from "./expected-output.ts";
import type { BeginGoalInput, CurrentGoal, DecisionInput, EvidenceFile, FinishInput, HostStopReasonKind, HostStopReceipt, InterruptInput, M07CheckpointRecord, M07Controller, M07TaskRecord, TaskCheck, TaskReviewInput, TaskSpecInput } from "./types.ts";
import type { StageRunRecord } from "../types.ts";
import { loadActiveBudgetPolicy, projectInline, validateActiveBudgetPointer, validateBudgetPolicy, type BudgetPolicy } from "../improvement/policy.ts";
import { capturedRunBytes, DEFAULT_PROJECTION_SNAPSHOT_LIMITS, newProjectionEvent, nextProjectionOrdinal, writeProjectionEvent, type ProjectionEventV1, type ProjectionMaterialV1, type ProjectionSnapshotLimits } from "../improvement/observations.ts";
import { createExperienceProvider, verifyRequiredKnowledge } from "../knowledge/experience-index.ts";
import type { KnowledgeRef, KnowledgeStore } from "../knowledge/types.ts";
import { GenerationStore, isM07WorkflowStrategy } from "../improvement/generation.ts";

const STATE = "goal.json";
const HOST_STOP_KEY = Symbol("m07-host-stop");
const HOST_STOP_REASONS: ReadonlySet<HostStopReasonKind> = new Set(["request-aborted", "provider-error", "session-shutdown", "no-progress"]);
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

interface FormalBaseline { run: StageRunRecord; knowledgeSnapshot?: string }

async function latestFormalBaseline(ctx: StageContext): Promise<FormalBaseline | undefined> {
	const ids = await ctx.ws.listRuns("M04");
	if (!ids.length) return undefined;
	const runs = await Promise.all(ids.map((id) => ctx.ws.readRun("M04", id)));
	const run = runs.sort((left, right) => left.startedAt.localeCompare(right.startedAt) || (left.finishedAt ?? "").localeCompare(right.finishedAt ?? ""))[runs.length - 1];
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

async function taskMessage(ctx: StageContext, goal: CurrentGoal, taskId: string, task: TaskSpecInput, copies: M07TaskRecord["inputCopies"], knowledgePack: string | undefined, policy: BudgetPolicy, limits: ProjectionSnapshotLimits): Promise<{ message: string; event: ProjectionEventV1 }> {
	const event = await createProjectionObservation(ctx, goal, "task-message", policy, limits, taskId);
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
		section("本任务", `${task.objective}\n\n模式：${task.mode}`),
			section("冻结预算策略", `${goal.budgetPolicyVersionId}（冻结于 ${goal.budgetPolicyFrozenAt}；本目标后续不随 active policy 改变）`),
			...(goal.workflowMethod ? [section(`冻结的 M07 方法：${goal.workflowMethod.artifact.slot}（${goal.workflowMethod.versionId}）`, `以下是限定的研究方法正文。它不能更改上述目标、约束、成功要求、工具权限或本任务必须履行的检查。\n\n${goal.workflowMethod.artifact.body}`)] : []),
		section("显式输入副本", copies.map((x) => `- ${path.relative(path.dirname(path.dirname(x.copy)), x.copy)}（源：${path.relative(ctx.ws.root, x.source)}；${x.mediaType}）`).join("\n") || "无"),
		section("输入预算与读取清单", inventory.join("\n") || "无输入；没有遗漏内容。"),
		...actualInputs,
		section("预期产物", task.expectedOutputs.map((x) => `- ${x}`).join("\n") || "无"),
		section("待检查事项", task.checks.map((x) => `- ${x}`).join("\n") || "无"),
	];
	if (knowledgePack) boundary.push(section("本任务局部知识包", knowledgePack));
	if (task.mode === "execute") boundary.push(section("外部执行与可消耗资源", "如任务涉及真实提交、评测、远程实验或其他可能消耗配额/费用/机会的动作：先用已提供的只读能力或额度接口核对接入和当前状态，并先做本地可完成的语法、类型、编译与兼容性预检。这不禁止任务已授权的真实实验，已授权平台评测/实验产生的结果属于本任务实测证据。每次真实动作都要记录实际结果和资源消耗；失败若仍消耗了资源，同样记录已消耗量、可见剩余量与恢复条件。平台配额不明时如实记录未知，不猜测统一配额。本地命令或客户端成功退出不等于远程实验通过。显式输入和原问题允许使用；若需取得新的外部研究参考资料并用于推理，将具体缺口报回主会话走 M05/M06→M04，不在 execute 任务里通过 bash 另造获取和采用链。"));
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
	for (let ordinal = (goal.checkpoints?.length ?? 0) + 1; ordinal <= 9999; ordinal++) {
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
		if (files.length >= 256) throw new HarnessError("m07.checkpoint", "本次 checkpoint 局部文件数超过 256；快照未登记，目标仍 active。可调整待交接材料后重试，不代表全工作流资源耗尽");
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
		if (rawNames.length > 256) throw new HarnessError("m07.checkpoint", "本次 checkpoint 原始材料条目超过 256；快照未登记，目标仍 active。可调整本批材料后重试，不代表全工作流资源耗尽");
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
		if (!selected.has(task.taskId)) { delete task.reportPath; delete task.review; continue; }
		if (!task.review) { delete task.reportPath; continue; }
		task.review.frozenReportPath = await remap(task.review.frozenReportPath);
		task.reportPath = task.review.frozenReportPath;
		for (const artifact of task.review.artifacts) { artifact.path = await remap(artifact.path); delete artifact.sourcePath; }
		for (const check of task.review.checks) check.evidence = await Promise.all(check.evidence.map(remap));
		if (task.review.independentCheck) task.review.independentCheck.report = await remap(task.review.independentCheck.report);
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

export function createM07Controller(ctx: StageContext, options: { projectionSnapshotLimits?: ProjectionSnapshotLimits; registeredExperienceStores?: ReadonlyMap<string, KnowledgeStore> } = {}): M07Controller {
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
			const goal: CurrentGoal = { version: 1, runId: record.runId, lifecycle: "active", startedAt: record.startedAt, updatedAt: record.startedAt, goal: input.goal.trim(), problemRelation: input.problemRelation.trim(), constraints: input.constraints.map((x) => nonempty(x, "constraint")), successCriteria: input.successCriteria.map((x) => nonempty(x, "success criterion")), plan: input.plan.trim(), exploratory, formalBaseline: !!baseline && !exploratory, problemSnapshotPath: frozen, knowledgeSnapshot: baseline?.knowledgeSnapshot, m04BaselineRunId: baseline?.run.runId, baselineHistory: baseline ? [{ at: record.startedAt, knowledgeSnapshot: baseline.knowledgeSnapshot, m04RunId: baseline.run.runId }] : [], budgetPolicy: budget.policy, budgetPolicyVersionId: budget.versionId, budgetPolicyFrozenAt: record.startedAt, methodBinding: { versionId: workflowMethod?.versionId ?? budget.versionId }, ...(workflowMethod ? { workflowMethod } : {}), ...(beginOptions?.executionContract === "continuous" ? { executionContract: { version: 1 as const, mode: "continuous" as const, frozenAt: record.startedAt } } : {}), tasks: [], decisions: [], limitations: [] };
			await save(ctx, goal);
			return goal;
		},

		status: (runId) => load(ctx, runId),

		async plan(runId, plan, planOptions) {
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
		},

		async checkpoint(runId, checkpointOptions) {
			const goal = await load(ctx, runId); requireActive(goal);
			frozenPolicy(goal);
			if (goal.tasks.some((task) => task.status === "running")) throw new HarnessError("m07.checkpoint", "存在 running 任务，不能冻结非终态反馈");
			const requested = checkpointOptions?.taskIds;
			if (requested !== undefined && (!Array.isArray(requested) || requested.length === 0 || requested.length > 256 || requested.some((id) => typeof id !== "string" || !/^T\d{3,}$/.test(id)) || new Set(requested).size !== requested.length || requested.some((id) => !goal.tasks.some((task) => task.taskId === id)))) throw new HarnessError("m07.checkpoint", "taskIds 必须是非空、去重、属于当前目标的任务列表，且每批最多 256 项");
			const selectedTaskIds = requested ?? goal.tasks.map((task) => task.taskId);
			await verifyFrozenWorkflowMethod(ctx, goal, options.registeredExperienceStores);
			return freezeCheckpoint(ctx, goal, snapshotLimits, selectedTaskIds);
		},

			async delegate(runId, spec) {
				const goal = await load(ctx, runId); requireActive(goal); nonempty(spec.objective, "task objective");
				await verifyFrozenWorkflowMethod(ctx, goal, options.registeredExperienceStores, spec);
			const policy = frozenPolicy(goal);
			await requireCurrentFormalBaseline(ctx, goal);
			spec = { ...spec, objective: spec.objective.trim(), inputs: normalizedUnique(spec.inputs, "task input"), expectedOutputs: normalizedUnique(spec.expectedOutputs, "expected output"), checks: normalizedUnique(spec.checks, "task check") };
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
			const resolvedInputs: string[] = []; for (const requested of spec.inputs) resolvedInputs.push(await confinedExistingFile(ctx, requested));
			if (spec.supersedesTaskId) { const previous = goal.tasks.find((t) => t.taskId === spec.supersedesTaskId); if (!previous) throw new HarnessError("m07.task", `未知 supersedesTaskId ${spec.supersedesTaskId}`); const previousInputs = previous.inputCopies.map((item) => item.source).sort(); const nextInputs = [...resolvedInputs].sort(); if (!sameSupersededObligation(spec, previous) || !sameStrings(nextInputs, previousInputs)) throw new HarnessError("m07.task", "supersedes 只能替代 objective、兼容 mode（可升级到更强能力）、独立检查要求、inputs、checks 与 expectedOutputs 相同或不降低义务的旧任务"); }
			const dependencies = [spec.parentTaskId, spec.supersedesTaskId].filter(Boolean) as string[];
			if (goal.decisions.some((d) => d.status === "open" && d.relatedTaskIds.some((id) => dependencies.includes(id)))) throw new HarnessError("m07.decision", "该任务依赖待用户决定事项；可继续不受影响的任务，但不能推进此依赖分支");
			const id = taskId(goal), dir = path.join(ctx.ws.runDir("M07", runId), "tasks", id), workDir = path.join(dir, "work"), inputsDir = path.join(workDir, "inputs");
			await mkdir(inputsDir, { recursive: true });
			const copies: M07TaskRecord["inputCopies"] = [];
			for (let i = 0; i < resolvedInputs.length; i++) { const source = resolvedInputs[i]; const copy = path.join(inputsDir, uniqueName(i, source)); await copyFile(source, copy); copies.push({ source, copy, mediaType: mediaType(source) }); }
			let pack: string | undefined;
			if (spec.knowledgeIds?.length) {
				for (const requested of spec.knowledgeIds) {
					const parsed = /^([CKEJQDX]\d{3,})(?:@(\d+))?$/.exec(requested);
					if (parsed && (await ctx.store.get(parsed[1], parsed[2] ? Number(parsed[2]) : undefined))?.fields.experience !== undefined) throw new HarnessError("m07.experience", `方法经验 ${requested} 必须通过固定 storeId、recordId、version 与适用性选择入口加载`);
				}
				pack = (await ctx.store.buildPack({ purpose: `M07 ${id}`, ids: spec.knowledgeIds, includeOpenQuestions: true, maxChars: 60_000 })).markdown;
			}
			let experienceSelection: M07TaskRecord["experienceSelection"];
			if (spec.experienceRefs?.length) {
				const selection = await createExperienceProvider(ctx.store, options.registeredExperienceStores).select({ targetKind: "executor", applicability: { stage: "M07", tags: [spec.mode, ...(spec.experienceTags ?? [])], contextRefs: spec.experienceContextRefs }, requestedRefs: spec.experienceRefs, expectedSnapshotId: goal.knowledgeSnapshot, maxRecords: 24, maxChars: 24_000 });
				if (selection.status !== "ready") throw new HarnessError("m07.experience", `显式方法经验不可装载：${selection.omitted.map((item) => `${item.ref.storeId}/${item.ref.recordId}@${item.ref.version}:${item.reason}`).join("；") || selection.status}`);
				experienceSelection = { ...selection, invocationStatus: "unknown", faithfulUse: "unknown", causalBenefit: "unknown" };
				pack = [pack, selection.markdown].filter(Boolean).join("\n\n");
			}
			const expectedOutputPaths = spec.expectedOutputs.map((x) => { const resolved = path.resolve(workDir, x); if (!inside(workDir, resolved)) throw new HarnessError("m07.path", `预期产物路径逃逸任务目录：${x}`); return resolved; });
			const role = spec.mode === "check" ? "reviewer" : "execution";
			const tools = spec.mode === "execute" ? { kind: "execution" as const, root: workDir, tools: ["read", "write", "edit", "bash"] as Array<"read" | "write" | "edit" | "bash"> } : { kind: "read-dir" as const, root: workDir };
			const { message, event } = await taskMessage(ctx, goal, id, spec, copies, pack, policy, snapshotLimits);
			await writeFileAtomic(path.join(dir, "message.md"), message);
			const task: M07TaskRecord = { ...spec, taskId: id, status: "running", createdAt: nowIso(), returnedAt: "", workDir, inputCopies: copies, expectedOutputPaths, readCoverage: [], toolLog: [], knowledgeSnapshot: goal.knowledgeSnapshot, m04BaselineRunId: goal.m04BaselineRunId, experienceSelection };
			goal.tasks.push(task); await save(ctx, goal);
			let handle;
			try {
				const session = sessionSpec(ctx, `M07-${id}`, role, systemPromptFor(role), tools);
				if (goal.methodBinding) session.methodBinding = goal.methodBinding;
				handle = await ctx.runner.create(session); task.session = handle.ref; await save(ctx, goal);
				event.deliveryStatus = "submitted"; event.providerUsageSessionId = handle.ref.id; await writeProjectionEvent(ctx.ws, event);
				const report = (await handle.prompt(message)).text; if (task.experienceSelection) task.experienceSelection.loadedAt = nowIso(); const reportPath = path.join(dir, "report.md"); await writeFileAtomic(reportPath, report);
				task.reportPath = reportPath; task.status = "returned";
			} catch (error) {
				task.status = "failed"; task.executionFailure = (error as Error).message;
			} finally {
				if (handle) { task.readCoverage = handle.readCoverage(); task.toolLog = handle.toolLog(); handle.dispose(); }
				task.returnedAt = nowIso(); await save(ctx, goal);
			}
			return task;
		},

		async review(runId, input) {
			const goal = await load(ctx, runId); requireActive(goal); const task = goal.tasks.find((t) => t.taskId === input.taskId); if (!task) throw new HarnessError("m07.task", `未知任务 ${input.taskId}`);
			if (goal.decisions.some((d) => d.status === "open" && d.relatedTaskIds.includes(task.taskId))) throw new HarnessError("m07.decision", "该任务关联待用户决定事项，不能采用；不受影响任务仍可继续");
			if (task.status !== "returned") throw new HarnessError("m07.review", `任务 ${task.taskId} 状态为 ${task.status}，不能评审采用`);
			const taskRoot = await realpath(path.dirname(task.workDir)); const reportReal = task.reportPath ? await realpath(task.reportPath) : undefined;
			if (!input.artifacts.length || !input.checks.length) throw new HarnessError("m07.review", "不能用空 artifacts 或空 checks 接受任务；reason/check 可提交自动保存的 report.md");
			const snapshotDir = path.join(path.dirname(task.workDir), "review-snapshot"); await mkdir(snapshotDir, { recursive: true });
			const frozenBySource = new Map<string, string>(); let frozenIndex = 0;
			const freeze = async (source: string): Promise<string> => { const found = frozenBySource.get(source); if (found) return found; const target = path.join(snapshotDir, uniqueName(frozenIndex++, source)); await copyFile(source, target); const frozen = await realpath(target); frozenBySource.set(source, frozen); return frozen; };
			if (!reportReal) throw new HarnessError("m07.review", "任务没有可冻结的会话报告");
			const frozenReportPath = await freeze(reportReal);
			const artifacts: EvidenceFile[] = []; for (const p of input.artifacts) { const resolved = await confinedExistingFile(ctx, p); if (!inside(taskRoot, resolved) && resolved !== reportReal) throw new HarnessError("m07.review", `成果不属于任务固定目录或会话报告：${p}`); artifacts.push({ path: await freeze(resolved), sourcePath: resolved, mediaType: mediaType(resolved), readCoverage: mediaType(resolved) === "text" ? "recorded-not-reviewed" : "unread-binary" }); }
			const checks: TaskCheck[] = []; for (const check of input.checks) { if (!task.checks.includes(check.criterion)) throw new HarnessError("m07.review", `检查不属于任务定义：${check.criterion}`); const evidence = []; for (const p of check.evidence) { const resolved = await confinedExistingFile(ctx, p); if (!inside(taskRoot, resolved) && resolved !== reportReal) throw new HarnessError("m07.review", `检查证据不属于任务固定目录或会话报告：${p}`); evidence.push(await freeze(resolved)); } if (check.result === "passed" && !evidence.length) throw new HarnessError("m07.review", `通过检查必须有实际文件证据：${check.criterion}`); checks.push({ ...check, evidence }); }
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
				const type = mediaType(source);
				artifacts.push({ path: await freeze(source), sourcePath: source, mediaType: type, readCoverage: type === "text" ? "recorded-not-reviewed" : "unread-binary" });
			};
			const expectedOutputs = await resolveExpectedOutputFiles(task.workDir, task.expectedOutputPaths);
			for (const expected of expectedOutputs) {
				if (expected.error) { failures.push(expected.error); continue; }
				for (const file of expected.files) await addExpectedArtifact(file);
			}
			const accepted = checks.every((c) => c.result === "passed") && !failures.length && !unexecuted.length;
			task.status = accepted ? "accepted" : "rejected"; task.review = { at: nowIso(), frozenReportPath, checks, artifacts, failures, unexecuted, limitations, independentCheck: input.independentCheck };
			await save(ctx, goal); return task;
		},

		async decision(runId, input) {
			const goal = await load(ctx, runId); requireActive(goal);
			for (const id of input.relatedTaskIds) if (!goal.tasks.some((t) => t.taskId === id)) throw new HarnessError("m07.decision", `未知相关任务 ${id}`);
			if (input.action === "request") goal.decisions.push({ id: `U${String(goal.decisions.length + 1).padStart(3, "0")}`, status: "open", question: nonempty(input.question ?? "", "question"), relatedTaskIds: input.relatedTaskIds, requestedAt: nowIso() });
			else { const open = goal.decisions.find((d) => d.status === "open" && d.relatedTaskIds.join("|") === input.relatedTaskIds.join("|")); if (!open) throw new HarnessError("m07.decision", "没有匹配的待用户决定事项"); open.status = "resolved"; open.decision = nonempty(input.decision ?? "", "decision"); open.resolvedAt = nowIso(); }
			await save(ctx, goal); return goal;
		},

		async finish(runId, input) {
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
			if (input.goalChecks.length !== goal.successCriteria.length || goal.successCriteria.some((criterion) => !input.goalChecks.some((c) => c.criterion === criterion))) throw new HarnessError("m07.finish", "必须逐项映射原目标 successCriteria，不能以子任务状态代替目标验收");
			const acceptedEvidence = new Map<string, string>(); for (const task of goal.tasks.filter((item) => item.status === "accepted")) { if (task.reportPath && task.review) { const frozen = await realpath(task.review.frozenReportPath); acceptedEvidence.set(frozen, frozen); if (existsSync(task.reportPath)) acceptedEvidence.set(await realpath(task.reportPath), frozen); } for (const artifact of task.review?.artifacts ?? []) { const frozen = await realpath(artifact.path); acceptedEvidence.set(frozen, frozen); if (artifact.sourcePath && existsSync(artifact.sourcePath)) acceptedEvidence.set(await realpath(artifact.sourcePath), frozen); } for (const check of task.review?.checks ?? []) for (const evidence of check.evidence) { const frozen = await realpath(evidence); acceptedEvidence.set(frozen, frozen); } }
			const canonicalGoalChecks: TaskCheck[] = []; for (const check of input.goalChecks) { const evidence: string[] = []; for (const item of check.evidence) { const resolved = await confinedExistingFile(ctx, item); const frozen = acceptedEvidence.get(resolved); if (input.outcome === "fulfilled" && !frozen) throw new HarnessError("m07.finish", `目标验收证据不来自已接受任务：${item}`); if (frozen && resolved !== frozen && !(await readFile(resolved)).equals(await readFile(frozen))) throw new HarnessError("m07.finish", `已接受成果在验收后发生变化：${item}`); evidence.push(frozen ?? resolved); } canonicalGoalChecks.push({ ...check, evidence }); }
			const byId = new Map(goal.tasks.map((item) => [item.taskId, item])); const superseded = new Set<string>();
			for (const accepted of goal.tasks.filter((item) => item.status === "accepted")) { let prior = accepted.supersedesTaskId; while (prior && !superseded.has(prior)) { superseded.add(prior); prior = byId.get(prior)?.supersedesTaskId; } }
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
			const run = await ctx.ws.readRun("M07", runId); run.outputs.push({ label: "M07 实际执行反馈包", path: goal.feedbackPath }); run.remarks.push(`目标结果 ${input.outcome}；主 Agent 选择返回 ${input.returnPath}。会话返回不等于科学验收。反馈状态 ${goal.feedbackStatus}；索引不代表 M04 已读取原证据。`); for (const t of goal.tasks) { if (t.session) run.sessions.push({ label: t.session.label, role: t.session.role, id: t.session.id, file: t.session.file, model: t.session.model }); if (t.executionFailure) run.failures.push(`${t.taskId} 执行失败：${t.executionFailure}`); if (t.review) { for (const f of t.review.failures) run.failures.push(`${t.taskId}：${f}`); for (const u of t.review.unexecuted) run.failures.push(`${t.taskId} 未执行：${u}`); } } await ctx.ws.finishRun(run, input.outcome === "blocked" ? "failed" : "completed"); await ctx.ws.writeNote(run, `M07 主 Agent 目标式执行；保留原目标、所有任务、失败、未执行和限制。最终选择返回 ${input.returnPath}。`);
			return goal;
		},

		async interrupt(runId, input: InterruptInput, authorization?: typeof HOST_STOP_KEY, hostReceipt?: HostStopReceipt) {
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
		},
		async hostInterrupt(runId, input) {
			if (!HOST_STOP_REASONS.has(input.reasonKind)) throw new HarnessError("m07.host-stop", "未知宿主停止事件");
			if (input.sourceEventId !== undefined && (typeof input.sourceEventId !== "string" || input.sourceEventId.length > 128 || !/^[A-Za-z0-9._:-]+$/.test(input.sourceEventId))) throw new HarnessError("m07.host-stop", "宿主事件 ID 无效");
			const receipt: HostStopReceipt = { version: 1, id: randomUUID(), goalRunId: runId, source: "pi-host", reasonKind: input.reasonKind, observedAt: nowIso(), ...(input.sourceEventId ? { sourceEventId: input.sourceEventId } : {}) };
			const interruptWithAuthority = this.interrupt as (goalRunId: string, request: InterruptInput, key: typeof HOST_STOP_KEY, witness: HostStopReceipt) => Promise<CurrentGoal>;
			return interruptWithAuthority(runId, { reason: `受信宿主生命周期停止：${input.reasonKind}`, returnPath: "user" }, HOST_STOP_KEY, receipt);
		},
	};
}

export type { M07Controller } from "./types.ts";
