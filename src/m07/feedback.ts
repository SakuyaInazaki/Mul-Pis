import { existsSync } from "node:fs";
import path from "node:path";
import { HarnessError } from "../types.ts";
import { writeFileAtomic } from "../workspace.ts";
import { mediaType } from "../media.ts";
import type { StageContext } from "../stages/context.ts";
import type { CurrentGoal } from "./types.ts";
import { projectInline, type BudgetPolicy } from "../improvement/policy.ts";
import { writeProjectionEvent, type ProjectionMaterialV1, type ProjectionSnapshotLimits } from "../improvement/observations.ts";
import { failedM04Feedback } from "./formal-baseline.ts";
import { captureMaterial, createProjectionObservation, omissionLine, projectionMaterial } from "./projection.ts";

export async function writeFeedback(ctx: StageContext, goal: CurrentGoal, policy: BudgetPolicy, limits: ProjectionSnapshotLimits, checkpointRoot?: string): Promise<string> {
	const event = await createProjectionObservation(ctx, goal, "feedback", policy, limits);
	try {
	const displayPath = (file: string) => path.relative(checkpointRoot ?? ctx.ws.root, file);
	const lines = [
		"# M07 实际执行反馈包", "", `- 目标：${goal.goal}`, `- 与原问题关系：${goal.problemRelation}`, `- 目标结果：${goal.outcome ?? "进行中"}`, `- 返回路径：${goal.returnPath ?? "未选择"}`, `- 正式基线：${goal.formalBaseline ? "是" : "否（探索性）"}`, `- 知识快照：${goal.knowledgeSnapshot ?? "无"}`, `- 冻结预算策略：${goal.budgetPolicyVersionId}（${goal.budgetPolicyFrozenAt}）`, "",
		...(checkpointRoot ? ["- 这是 active 目标的非终态开发 checkpoint；不改变原成功要求，不表示 fulfilled，也不表示 M04 已核验全部证据。", "- 本次 M04 只允许读取本 checkpoint 冻结目录，所有材料路径均相对于该目录。", ""] : []),
		...(goal.checkpointScope ? [`- 本批已选任务 ${goal.checkpointScope.selectedTaskIds.length}：${goal.checkpointScope.selectedTaskIds.slice(0, 20).join("、") || "无"}${goal.checkpointScope.selectedTaskIds.length > 20 ? "（其余见 manifest.json）" : ""}；未选任务 ${goal.checkpointScope.omittedTaskIds.length}：${goal.checkpointScope.omittedTaskIds.slice(0, 20).join("、") || "无"}${goal.checkpointScope.omittedTaskIds.length > 20 ? "（其余见 manifest.json）" : ""}。未选任务的评审证据未交接，完整任务范围见 manifest.json。`, ""] : []),
		...(goal.workflowMethod ? [`- 实际装载的 M07 方法：${goal.workflowMethod.versionId}（${goal.workflowMethod.artifact.slot}）；仅作为研究方法，不改变原成功要求或 M04 科学判断。`, ""] : []),
		...(goal.m04BaselineFailures?.length ? ["## Retained failed M04 feedback", "", failedM04Feedback(goal.m04BaselineFailures), ""] : []),
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
