import { copyFile, lstat, mkdir, readFile, realpath } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { loadPrompt, section, systemPromptFor } from "../prompts.ts";
import { HarnessError } from "../types.ts";
import { nowIso, writeFileAtomic } from "../workspace.ts";
import { recordSession, sessionSpec, type StageContext } from "../stages/context.ts";
import type { BeginGoalInput, CurrentGoal, DecisionInput, EvidenceFile, FinishInput, M07Controller, M07TaskRecord, TaskCheck, TaskReviewInput, TaskSpecInput } from "./types.ts";

const STATE = "goal.json";
const TEXT_EXTENSIONS = new Set([".txt", ".md", ".markdown", ".json", ".jsonl", ".csv", ".tsv", ".yaml", ".yml", ".toml", ".xml", ".html", ".htm", ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".py", ".rs", ".go", ".java", ".c", ".cc", ".cpp", ".h", ".hpp", ".sh", ".zsh", ".fish", ".sql", ".tex"]);

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

function sameSupersededObligation(next: TaskSpecInput, previous: M07TaskRecord): boolean {
	return next.objective.trim() === previous.objective && next.mode === previous.mode && Boolean(next.requireIndependentCheck) === Boolean(previous.requireIndependentCheck) && sameStrings(next.checks, previous.checks) && sameStrings(next.expectedOutputs, previous.expectedOutputs);
}

function inside(root: string, candidate: string): boolean {
	return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

function statePath(ctx: StageContext, runId: string): string {
	return path.join(ctx.ws.runDir("M07", runId), STATE);
}

function mediaType(file: string): "text" | "binary" {
	return TEXT_EXTENSIONS.has(path.extname(file).toLowerCase()) ? "text" : "binary";
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

async function taskMessage(ctx: StageContext, goal: CurrentGoal, task: TaskSpecInput, copies: M07TaskRecord["inputCopies"], knowledgePack?: string): Promise<string> {
	const actualInputs: string[] = [];
	for (const item of copies) {
		if (item.mediaType === "text") actualInputs.push(section(`输入副本：${path.basename(item.copy)}`, await readFile(item.copy, "utf8")));
		else actualInputs.push(section(`输入副本：${path.basename(item.copy)}`, "二进制输入；本消息未读取其内容，只有具备相应工具且实际读取后才能声称覆盖。"));
	}
	const boundary = [
		section("冻结的当前目标", goal.goal),
		section("与原问题关系", goal.problemRelation),
		section("不可变约束", goal.constraints.map((x) => `- ${x}`).join("\n")),
		section("原目标成功要求（本任务不得改写）", goal.successCriteria.map((x) => `- ${x}`).join("\n")),
		section("本任务", `${task.objective}\n\n模式：${task.mode}`),
		section("显式输入副本", copies.map((x) => `- ${path.relative(path.dirname(x.copy), x.copy)}（源：${path.relative(ctx.ws.root, x.source)}；${x.mediaType}）`).join("\n") || "无"),
		...actualInputs,
		section("预期产物", task.expectedOutputs.map((x) => `- ${x}`).join("\n") || "无"),
		section("待检查事项", task.checks.map((x) => `- ${x}`).join("\n") || "无"),
	];
	if (knowledgePack) boundary.push(section("本任务局部知识包", knowledgePack));
	boundary.push("会话返回只表示任务已返回，不表示成果被主 Agent 接受。请如实列出实际动作、产物、失败、未执行项和限制。");
	return boundary.join("\n\n");
}

async function writeFeedback(ctx: StageContext, goal: CurrentGoal): Promise<string> {
	const lines = [
		"# M07 实际执行反馈包", "", `- 目标：${goal.goal}`, `- 与原问题关系：${goal.problemRelation}`, `- 目标结果：${goal.outcome ?? "进行中"}`, `- 返回路径：${goal.returnPath ?? "未选择"}`, `- 正式基线：${goal.formalBaseline ? "是" : "否（探索性）"}`, `- 知识快照：${goal.knowledgeSnapshot ?? "无"}`, "",
		"## 原成功要求", "", ...goal.successCriteria.map((x) => `- ${x}`), "", "## 任务与实际证据", "",
	];
	for (const task of goal.tasks) {
		lines.push(`### ${task.taskId} ${task.objective}`, "", `- 状态：${task.status}`, `- 模式：${task.mode}`, `- 会话报告：${task.reportPath ? path.relative(ctx.ws.root, task.reportPath) : "未产生"}`, `- 实际读取：${task.readCoverage.join("、") || "无可记录读取"}`);
		for (const artifact of task.review?.artifacts ?? []) lines.push(`- 产物：${path.relative(ctx.ws.root, artifact.path)}（${artifact.mediaType === "text" ? "文本，纳入下方实际内容" : "二进制，未读取内容"}）`);
		for (const check of task.review?.checks ?? []) lines.push(`- 检查 ${check.result}：${check.criterion}；证据 ${check.evidence.map((p) => path.relative(ctx.ws.root, p)).join("、") || "无"}`);
		for (const failure of task.review?.failures ?? []) lines.push(`- 失败：${failure}`);
		for (const item of task.review?.unexecuted ?? []) lines.push(`- 未执行：${item}`);
		for (const limitation of task.review?.limitations ?? []) lines.push(`- 限制：${limitation}`);
		if (task.review?.independentCheck) lines.push(`- 独立检查：${task.review.independentCheck.taskId}；处置：${task.review.independentCheck.disposition}`);
		if (task.executionFailure) lines.push(`- 执行失败：${task.executionFailure}`);
		if (task.toolLog.length) lines.push(`- 工具日志：${JSON.stringify(task.toolLog)}`);
		lines.push("");
	}
	lines.push("## 实际材料内容", "");
	const materialPaths = new Set<string>();
	for (const task of goal.tasks) {
		if (task.review) materialPaths.add(await realpath(task.review.frozenReportPath));
		else if (task.reportPath && existsSync(task.reportPath)) materialPaths.add(await realpath(task.reportPath));
		for (const artifact of task.review?.artifacts ?? []) materialPaths.add(await realpath(artifact.path));
		for (const check of task.review?.checks ?? []) for (const evidence of check.evidence) materialPaths.add(await realpath(evidence));
		if (task.review?.independentCheck) materialPaths.add(await realpath(task.review.independentCheck.report));
	}
	for (const materialPath of materialPaths) {
		if (mediaType(materialPath) === "binary") { lines.push(`### ${path.relative(ctx.ws.root, materialPath)}`, "", "二进制材料未被本反馈包读取；只记录其存在，不能据此声称覆盖内容。", ""); continue; }
		lines.push(`### ${path.relative(ctx.ws.root, materialPath)}`, "", await readFile(materialPath, "utf8"), "");
	}
	lines.push("## 原目标验收", "", ...(goal.goalChecks?.map((c) => `- ${c.result}：${c.criterion}；证据 ${c.evidence.map((p) => path.relative(ctx.ws.root, p)).join("、") || "无"}`) ?? ["- 未验收"]), "", "## 用户决定事项", "", ...(goal.decisions.length ? goal.decisions.map((d) => `- ${d.status}：${d.question}${d.decision ? `；决定：${d.decision}` : ""}`) : ["- 无"]), "", "## 总结与限制", "", goal.finishSummary ?? "尚未结束", ...goal.limitations.map((x) => `- ${x}`));
	const target = path.join(ctx.ws.runDir("M07", goal.runId), "m04-feedback.md");
	await writeFileAtomic(target, lines.join("\n"));
	return target;
}

export function createM07Controller(ctx: StageContext): M07Controller {
	return {
		async begin(input) {
			nonempty(input.goal, "goal"); nonempty(input.problemRelation, "problemRelation"); nonempty(input.plan, "plan");
			if (!input.constraints.length || !input.successCriteria.length) throw new HarnessError("m07.input", "constraints 与 successCriteria 必须明确且非空");
			input.constraints = normalizedUnique(input.constraints, "constraint"); input.successCriteria = normalizedUnique(input.successCriteria, "success criterion");
			const problem = await ctx.ws.readProblem();
			const snapshot = await ctx.store.current();
			const m04 = await ctx.ws.latestCompletedRun("M04");
			if (!m04 && !input.exploratory) throw new HarnessError("m07.baseline", "没有已完成 M04 基线；只能显式 exploratory=true 开始探索性 M07，不能声称正式结论");
			const record = await ctx.ws.startRun("M07", [{ label: "原始问题", path: problem.path }], snapshot?.id);
			const frozen = path.join(ctx.ws.runDir("M07", record.runId), "problem-snapshot.md");
			await writeFileAtomic(frozen, problem.content);
			const exploratory = input.exploratory === true || !m04;
			const goal: CurrentGoal = { version: 1, runId: record.runId, lifecycle: "active", startedAt: record.startedAt, updatedAt: record.startedAt, goal: input.goal.trim(), problemRelation: input.problemRelation.trim(), constraints: input.constraints.map((x) => nonempty(x, "constraint")), successCriteria: input.successCriteria.map((x) => nonempty(x, "success criterion")), plan: input.plan.trim(), exploratory, formalBaseline: !!m04 && !exploratory, problemSnapshotPath: frozen, knowledgeSnapshot: snapshot?.id, m04BaselineRunId: m04?.runId, baselineHistory: m04 ? [{ at: record.startedAt, knowledgeSnapshot: snapshot?.id, m04RunId: m04.runId }] : [], tasks: [], decisions: [], limitations: [] };
			await save(ctx, goal);
			return goal;
		},

		status: (runId) => load(ctx, runId),

		async plan(runId, plan, options) {
			const goal = await load(ctx, runId); requireActive(goal); goal.plan = nonempty(plan, "plan");
			if (options?.refreshBaseline) {
				const m04 = await ctx.ws.latestCompletedRun("M04"); if (!m04) throw new HarnessError("m07.baseline", "没有可用于刷新基线的已完成 M04 运行");
				const snapshot = await ctx.store.current(); goal.m04BaselineRunId = m04.runId; goal.knowledgeSnapshot = snapshot?.id; goal.formalBaseline = true; goal.baselineHistory.push({ at: nowIso(), knowledgeSnapshot: snapshot?.id, m04RunId: m04.runId });
			}
			await save(ctx, goal); return goal;
		},

		async delegate(runId, spec) {
			const goal = await load(ctx, runId); requireActive(goal); nonempty(spec.objective, "task objective");
			spec = { ...spec, objective: spec.objective.trim(), inputs: normalizedUnique(spec.inputs, "task input"), expectedOutputs: normalizedUnique(spec.expectedOutputs, "expected output"), checks: normalizedUnique(spec.checks, "task check") };
			if (!spec.checks.length) throw new HarnessError("m07.task", "每个任务必须定义至少一项实际检查；推导可用会话报告作为证据");
			if (spec.mode === "execute" && !spec.expectedOutputs.length) throw new HarnessError("m07.task", "execute 任务必须声明至少一个预期产物");
			if (spec.parentTaskId && !goal.tasks.some((t) => t.taskId === spec.parentTaskId)) throw new HarnessError("m07.task", `未知 parentTaskId ${spec.parentTaskId}`);
			const resolvedInputs: string[] = []; for (const requested of spec.inputs) resolvedInputs.push(await confinedExistingFile(ctx, requested));
			if (spec.supersedesTaskId) { const previous = goal.tasks.find((t) => t.taskId === spec.supersedesTaskId); if (!previous) throw new HarnessError("m07.task", `未知 supersedesTaskId ${spec.supersedesTaskId}`); const previousInputs = previous.inputCopies.map((item) => item.source).sort(); const nextInputs = [...resolvedInputs].sort(); if (!sameSupersededObligation(spec, previous) || !sameStrings(nextInputs, previousInputs)) throw new HarnessError("m07.task", "supersedes 只能替代 objective/mode/独立检查要求/inputs/checks/expectedOutputs 完全相同的旧任务义务"); }
			const dependencies = [spec.parentTaskId, spec.supersedesTaskId].filter(Boolean) as string[];
			if (goal.decisions.some((d) => d.status === "open" && d.relatedTaskIds.some((id) => dependencies.includes(id)))) throw new HarnessError("m07.decision", "该任务依赖待用户决定事项；可继续不受影响的任务，但不能推进此依赖分支");
			const id = taskId(goal), dir = path.join(ctx.ws.runDir("M07", runId), "tasks", id), workDir = path.join(dir, "work"), inputsDir = path.join(workDir, "inputs");
			await mkdir(inputsDir, { recursive: true });
			const copies: M07TaskRecord["inputCopies"] = [];
			for (let i = 0; i < resolvedInputs.length; i++) { const source = resolvedInputs[i]; const copy = path.join(inputsDir, uniqueName(i, source)); await copyFile(source, copy); copies.push({ source, copy, mediaType: mediaType(source) }); }
			let pack: string | undefined;
			if (spec.knowledgeIds?.length) pack = (await ctx.store.buildPack({ purpose: `M07 ${id}`, ids: spec.knowledgeIds, includeOpenQuestions: true, maxChars: 60_000 })).markdown;
			const expectedOutputPaths = spec.expectedOutputs.map((x) => { const resolved = path.resolve(workDir, x); if (!inside(workDir, resolved)) throw new HarnessError("m07.path", `预期产物路径逃逸任务目录：${x}`); return resolved; });
			const role = spec.mode === "check" ? "reviewer" : "execution";
			const tools = spec.mode === "execute" ? { kind: "execution" as const, root: workDir, tools: ["read", "write", "edit", "bash"] as Array<"read" | "write" | "edit" | "bash"> } : spec.mode === "check" ? { kind: "read-dir" as const, root: workDir } : { kind: "none" as const };
			const message = await taskMessage(ctx, goal, spec, copies, pack);
			await writeFileAtomic(path.join(dir, "message.md"), message);
			const task: M07TaskRecord = { ...spec, taskId: id, status: "running", createdAt: nowIso(), returnedAt: "", workDir, inputCopies: copies, expectedOutputPaths, readCoverage: [], toolLog: [], knowledgeSnapshot: goal.knowledgeSnapshot, m04BaselineRunId: goal.m04BaselineRunId };
			goal.tasks.push(task); await save(ctx, goal);
			let handle;
			try {
				handle = await ctx.runner.create(sessionSpec(ctx, `M07-${id}`, role, systemPromptFor(role), tools)); task.session = handle.ref; await save(ctx, goal);
				const report = (await handle.prompt(message)).text; const reportPath = path.join(dir, "report.md"); await writeFileAtomic(reportPath, report);
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
			for (const expected of task.expectedOutputPaths) {
				const actualExpected = existsSync(expected) ? await realpath(expected) : undefined;
				if (!actualExpected || !artifacts.some((a) => a.sourcePath === actualExpected)) failures.push(`预期产物未实际提交：${path.relative(task.workDir, expected)}`);
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
			if (goal.tasks.some((task) => task.status === "running")) throw new HarnessError("m07.finish", "存在状态未知的 running 任务；本版只能查看且不能结束目标、自动重跑或假称已停止");
			if (input.goalChecks.length !== goal.successCriteria.length || goal.successCriteria.some((criterion) => !input.goalChecks.some((c) => c.criterion === criterion))) throw new HarnessError("m07.finish", "必须逐项映射原目标 successCriteria，不能以子任务状态代替目标验收");
			const acceptedEvidence = new Map<string, string>(); for (const task of goal.tasks.filter((item) => item.status === "accepted")) { if (task.reportPath && task.review) { const frozen = await realpath(task.review.frozenReportPath); acceptedEvidence.set(frozen, frozen); if (existsSync(task.reportPath)) acceptedEvidence.set(await realpath(task.reportPath), frozen); } for (const artifact of task.review?.artifacts ?? []) { const frozen = await realpath(artifact.path); acceptedEvidence.set(frozen, frozen); if (artifact.sourcePath && existsSync(artifact.sourcePath)) acceptedEvidence.set(await realpath(artifact.sourcePath), frozen); } for (const check of task.review?.checks ?? []) for (const evidence of check.evidence) { const frozen = await realpath(evidence); acceptedEvidence.set(frozen, frozen); } }
			const canonicalGoalChecks: TaskCheck[] = []; for (const check of input.goalChecks) { const evidence: string[] = []; for (const item of check.evidence) { const resolved = await confinedExistingFile(ctx, item); const frozen = acceptedEvidence.get(resolved); if (input.outcome === "fulfilled" && !frozen) throw new HarnessError("m07.finish", `目标验收证据不来自已接受任务：${item}`); if (frozen && resolved !== frozen && !(await readFile(resolved)).equals(await readFile(frozen))) throw new HarnessError("m07.finish", `已接受成果在验收后发生变化：${item}`); evidence.push(frozen ?? resolved); } canonicalGoalChecks.push({ ...check, evidence }); }
			const byId = new Map(goal.tasks.map((item) => [item.taskId, item])); const superseded = new Set<string>();
			for (const accepted of goal.tasks.filter((item) => item.status === "accepted")) { let prior = accepted.supersedesTaskId; while (prior && !superseded.has(prior)) { superseded.add(prior); prior = byId.get(prior)?.supersedesTaskId; } }
			const effectiveTasks = goal.tasks.filter((item) => !superseded.has(item.taskId));
			if (input.outcome === "fulfilled") { if (canonicalGoalChecks.some((c) => c.result !== "passed" || !c.evidence.length)) throw new HarnessError("m07.finish", "fulfilled 要求每项原目标成功标准均通过并有实际文件证据"); if (goal.decisions.some((d) => d.status === "open")) throw new HarnessError("m07.finish", "存在待用户决定事项，不能标记 fulfilled"); if (effectiveTasks.some((t) => t.status !== "accepted")) throw new HarnessError("m07.finish", "存在未接受且未被合法替代的任务，不能标记 fulfilled"); if (!goal.tasks.length) throw new HarnessError("m07.finish", "没有实际任务，不能标记 fulfilled"); }
			goal.goalChecks = canonicalGoalChecks;
			goal.lifecycle = "finished"; goal.outcome = input.outcome; goal.finishSummary = nonempty(input.summary, "summary"); goal.returnPath = input.returnPath; goal.limitations.push(...(input.limitations ?? [])); goal.feedbackPath = await writeFeedback(ctx, goal); await save(ctx, goal);
			const run = await ctx.ws.readRun("M07", runId); run.outputs.push({ label: "M07 实际执行反馈包", path: goal.feedbackPath }); run.remarks.push(`目标结果 ${input.outcome}；主 Agent 选择返回 ${input.returnPath}。会话返回不等于科学验收。`); for (const t of goal.tasks) { if (t.session) run.sessions.push({ label: t.session.label, role: t.session.role, id: t.session.id, file: t.session.file, model: t.session.model }); if (t.executionFailure) run.failures.push(`${t.taskId} 执行失败：${t.executionFailure}`); if (t.review) { for (const f of t.review.failures) run.failures.push(`${t.taskId}：${f}`); for (const u of t.review.unexecuted) run.failures.push(`${t.taskId} 未执行：${u}`); } } await ctx.ws.finishRun(run, input.outcome === "blocked" ? "failed" : "completed"); await ctx.ws.writeNote(run, `M07 主 Agent 目标式执行；保留原目标、所有任务、失败、未执行和限制。最终选择返回 ${input.returnPath}。`);
			return goal;
		},
	};
}

export type { M07Controller } from "./types.ts";
