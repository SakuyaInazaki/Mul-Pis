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
import { candidateArchive, globalCandidateBest } from "./candidate-archive.ts";

const knowledgeContentLabel = {
	index: "检索索引（不含正文）",
	brief: "知识短卡（不含完整正文）",
	record: "记录正文",
	"artifact-index": "同源任务原件目录（不含原件正文）",
	artifact: "同源任务原件",
	"contract-check": "契约静态检查结果（不含知识正文）",
} as const;

function knowledgeAccessLine(access: NonNullable<CurrentGoal["tasks"][number]["knowledgeAccess"]>[number], displayPath: (file: string) => string): string {
	const range = access.returnedRange;
	const returned = access.status === "returned"
		? range
			? `实际返回${knowledgeContentLabel[range.content]} ${range.unit === "records" ? "记录序号" : "UTF-16"} ${range.offset}–${range.end}/${range.total}${range.offset === 0 && range.end === range.total ? "（该内容完整返回）" : "（仅此范围）"}`
			: "实际返回范围未登记，须核对冻结原始返回"
		: "未返回知识内容";
	return `- 知识访问 ${access.id}/${access.kind}/${access.status}：检索候选及关联引用 ${access.selectedRefs.length} 条（完整列表见冻结记录，不代表本页均已显示或正文已读）；${returned}；冻结原始返回 ${displayPath(access.frozenPath)}；仅表示工具返回，不表示模型忠实使用。`;
}

export async function writeFeedback(ctx: StageContext, goal: CurrentGoal, policy: BudgetPolicy, limits: ProjectionSnapshotLimits, checkpointRoot?: string): Promise<string> {
	const event = await createProjectionObservation(ctx, goal, "feedback", policy, limits);
	try {
	const displayPath = (file: string) => path.relative(checkpointRoot ?? ctx.ws.root, file);
	const archivedCandidates = candidateArchive(goal);
	const lines = [
		"# M07 实际执行反馈包", "", `- 目标：${goal.goal}`, `- 与原问题关系：${goal.problemRelation}`, `- 目标结果：${goal.outcome ?? "进行中"}`, `- 返回路径：${goal.returnPath ?? "未选择"}`, `- 正式基线：${goal.formalBaseline ? "是" : "否（探索性）"}`, `- 知识快照：${goal.knowledgeSnapshot ?? "无"}`, `- 冻结预算策略：${goal.budgetPolicyVersionId}（${goal.budgetPolicyFrozenAt}）`, "",
		...(goal.candidateVerification ? [`- 候选只读核验器：${goal.candidateVerification.id}@${goal.candidateVerification.verifierVersion}；原目标验收：${goal.candidateVerification.goalAdmission ? "全部原条件由宿主独立核验" : "已配置宿主原目标核验时，其客观检查覆盖模型自报；其余条件沿用原 M07 goalChecks 门"}；候选核验绑定仅作用于绑定后新任务。`, ""] : []),
		...(checkpointRoot ? ["- 这是 active 目标的非终态开发 checkpoint；不改变原成功要求，不表示 fulfilled，也不表示 M04 已核验全部证据。", "- 本次 M04 只允许读取本 checkpoint 冻结目录，所有材料路径均相对于该目录。", ""] : []),
		...(goal.checkpointScope ? [`- 本批已选任务 ${goal.checkpointScope.selectedTaskIds.length}：${goal.checkpointScope.selectedTaskIds.slice(0, 20).join("、") || "无"}${goal.checkpointScope.selectedTaskIds.length > 20 ? "（其余见 manifest.json）" : ""}；未选任务 ${goal.checkpointScope.omittedTaskIds.length}：${goal.checkpointScope.omittedTaskIds.slice(0, 20).join("、") || "无"}${goal.checkpointScope.omittedTaskIds.length > 20 ? "（其余见 manifest.json）" : ""}。未选任务的评审证据未交接，完整任务范围见 manifest.json。`, ""] : []),
		...(goal.workflowMethod ? [`- 实际装载的 M07 方法：${goal.workflowMethod.versionId}（${goal.workflowMethod.artifact.slot}）；仅作为研究方法，不改变原成功要求或 M04 科学判断。`, ""] : []),
		...(goal.m04BaselineFailures?.length ? ["## Retained failed M04 feedback", "", failedM04Feedback(goal.m04BaselineFailures), ""] : []),
		"## 原成功要求", "", ...goal.successCriteria.map((x) => `- ${x}`), "", "## 任务与实际证据", "",
	];
	if (goal.workflowMethod?.artifact.slot === "evidence-handoff") lines.push("## 冻结的证据交接方法", "", "以下方法正文曾作为 M07 任务指导；这里保留其版本与内容以供 M04 核对，实际证据与未执行项仍以本包记录为准。", "", goal.workflowMethod.artifact.body, "");
	for (const task of goal.tasks) {
		lines.push(`### ${task.taskId} ${task.objective}`, "", `- 状态：${task.status}`, `- 模式：${task.mode}`, `- 会话报告：${task.reportPath ? displayPath(task.reportPath) : "未产生"}`, `- 实际读取：${task.readCoverage.join("、") || "无可记录读取"}`);
		if (task.candidate) lines.push(`- 候选血统：${task.candidate.parentTaskId ?? "起点"}；改动类别：${task.candidate.changeKind ?? "未标注"}；源码 ${task.candidate.sourcePaths.join("、")}；平台原回执 ${task.candidate.receiptPaths.join("、")}。`);
		if (task.candidateObservation) {
			const observation = task.candidateObservation;
			lines.push(`- 宿主只读核验：${observation.verifier.id}@${observation.verifier.version}；源码/提交绑定 ${observation.sourceBinding}；正确性 ${observation.correctness}；阶段 ${observation.stage}；冻结观察 ${displayPath(observation.observationPath)}。`);
			for (const check of observation.goalChecks) lines.push(`- 候选对原目标的局部观察 ${check.result}：${check.criterion}；不代替最终独立验收。`);
			for (const metric of observation.metrics) lines.push(`- 可比测量：${metric.name}=${metric.value} ${metric.unit}；basis=${metric.basisId}；方向 ${metric.direction}。`);
		}
		if (task.episode) {
			lines.push(`- 候选 episode：${task.episode.candidates.length} 次已有评测只读核验；当前探索 ${task.episode.currentCandidateId ?? "无"}；不表示任务或目标已完成。`);
			for (const checkout of task.episode.checkouts ?? []) lines.push(`- 历史候选取回：${checkout.candidateRef}；仅是工作副本，不是新评测。`);
			for (const candidate of task.episode.candidates) {
				lines.push(`- ${candidate.id}：声明父代 ${candidate.parentRef ? `${candidate.parentRef.taskId}/${candidate.parentRef.candidateId}` : "起点"}；${candidate.changeKind}/${candidate.intent}；假设 ${candidate.hypothesis}；模型声明改动 ${candidate.changeSummary ?? "未提供"}；声明条件 ${candidate.conditions?.join("、") || "未提供"}；源码绑定 ${candidate.observation.sourceBinding}；正确性 ${candidate.observation.correctness}；阶段 ${candidate.observation.stage}；冻结观察 ${displayPath(candidate.observationPath)}。`);
				if (candidate.identicalSourceRefs?.length) lines.push(`- ${candidate.id} 与历史源码字节相同：${candidate.identicalSourceRefs.join("、")}；仅供规划判断，不自动拒绝。`);
				if (candidate.sourceRepetition) lines.push(`- ${candidate.id} 源码重复事实：${candidate.sourceRepetition}；不自动停止或封禁路线。`);
				for (const summary of candidate.parentComparison?.summary ?? []) lines.push(`- ${candidate.id} 相对声明父代的同口径观察：${summary}`);
				for (const metric of candidate.observation.metrics) lines.push(`- ${candidate.id} 测量：${metric.name}=${metric.value} ${metric.unit}；basis=${metric.basisId}；方向 ${metric.direction}。`);
				for (const limitation of candidate.observation.limitations) lines.push(`- ${candidate.id} 限制：${limitation}`);
			}
			for (const best of globalCandidateBest(archivedCandidates.filter(entry => entry.taskId === task.taskId)))
				lines.push(`- 同对象同口径最佳 ${best.candidateRef}：对象=${best.subjectId}；${best.metric.name}=${best.metric.value} ${best.metric.unit}；basis=${best.metric.basisId}；方向 ${best.metric.direction}。`);
		}
		if (task.context) lines.push(`- 竞争分支来源：${task.context.parentRunId}/${task.context.parentTaskId}@${task.context.checkpointId}；继承历史不是知识采用，也不代表旧路径在当前分支仍可操作。`);
		for (const artifact of task.review?.artifacts ?? []) lines.push(`- 产物：${displayPath(artifact.path)}（${artifact.mediaType === "text" ? "文本，纳入下方实际内容" : "二进制，未读取内容"}）`);
		for (const check of task.review?.checks ?? []) lines.push(`- 检查 ${check.result}：${check.criterion}；证据 ${check.evidence.map(displayPath).join("、") || "无"}`);
		for (const failure of task.review?.failures ?? []) lines.push(`- 失败：${failure}`);
		for (const item of task.review?.unexecuted ?? []) lines.push(`- 未执行：${item}`);
		for (const limitation of task.review?.limitations ?? []) lines.push(`- 限制：${limitation}`);
		if (task.review?.independentCheck) lines.push(`- 独立检查：${task.review.independentCheck.taskId}；处置：${task.review.independentCheck.disposition}`);
		if (task.executionFailure) lines.push(`- 执行失败：${task.executionFailure}`);
		for (const access of task.knowledgeAccess ?? []) lines.push(knowledgeAccessLine(access, displayPath));
		if (task.toolLog.length) lines.push(`- 工具日志：${JSON.stringify(task.toolLog)}`);
		lines.push("");
	}
	const latestCandidate = goal.tasks.filter(task => task.candidate || task.episode?.candidates.length).at(-1);
	if (latestCandidate) lines.push("## 候选探索与已验证最佳", "", `- 当前探索工作点：${latestCandidate.taskId}${latestCandidate.episode?.currentCandidateId ? `/${latestCandidate.episode.currentCandidateId}` : ""}；不自动替换已验证最佳。`);
	const best = globalCandidateBest(archivedCandidates);
	if (latestCandidate) lines.push(...(best.length ? best.map(({ candidateRef, metric, subjectId }) => `- 同口径正确性已验证的最佳观测：${candidateRef}；对象=${subjectId}；${metric.name}=${metric.value} ${metric.unit}；basis=${metric.basisId}；方向 ${metric.direction}；任务状态仍见上文。`) : ["- 尚无对象与口径明确、正确性通过的性能观测。"]), "");
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
