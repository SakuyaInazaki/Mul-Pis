import path from "node:path";
import type { ConsoleStatus, WorkflowNode, WorkflowSnapshot } from "./model.ts";

const STATE: Record<ConsoleStatus, string> = {
	pending: "未启动", running: "执行中", waiting: "等待", suspended: "已挂起",
	stale: "心跳过期", returned: "已返回，待审查", accepted: "已接受", rejected: "未接受",
	failed: "失败", unknown: "状态未知", completed: "已完成", blocked: "已阻塞",
};

/** A completed run or returned session does not certify a fulfilled research goal. */
export function statusLabel(node: WorkflowNode): string {
	if (node.kind === "tool" && node.status === "returned") return "调用已返回";
	if (node.kind === "session" && node.status === "completed") return "会话已结束";
	if (node.kind === "run" && node.status === "completed") return "运行已结束";
	if (node.kind === "task" && node.status === "returned") return "任务已返回，待审查";
	if (node.kind === "task" && node.status === "accepted") return "任务已接受";
	if (node.kind === "execution" && node.status === "completed") return "执行阶段已结束";
	return STATE[node.status] ?? node.status;
}

function taskObjective(node: WorkflowNode): string {
	if (!node.taskId) return node.label;
	// The reader prefixes each task label with its ID. Remove only that exact decoration.
	const prefix = `${node.taskId} · `;
	return node.label.startsWith(prefix) ? node.label.slice(prefix.length) : node.label;
}

/** Short identity for the tree; long task objectives belong in the selected document. */
export function nodeIdentity(node: WorkflowNode): string {
	switch (node.kind) {
		case "stage": return node.stage ?? node.label;
		case "mission": return `原目标 · ${node.missionId ?? node.id}`;
		case "attempt": return node.label;
		case "assessment": return node.label;
		case "run": return `${node.stage ?? "运行"}运行 · ${node.runId ?? node.id}`;
		case "task": return node.taskId ? `任务 ${node.taskId}` : `任务 ${node.id}`;
		case "candidate": return node.label;
		case "execution": return node.label;
		case "round": return node.label;
		case "evaluation": return node.label;
		case "review": return node.label;
		case "checkpoint": return node.label;
		case "session": return `${node.label || "会话"} · ${node.sessionId ?? node.id}`;
		case "group": {
			const sourceId = node.id.startsWith("group:") ? node.id.split(":").slice(2).join(":") : "";
			return sourceId && !node.label.includes(sourceId) ? `${sourceId} · ${node.label}` : node.label;
		}
		case "barrier": {
			const parts = node.id.split(":");
			const source = parts.length > 3 && /^S\d+$/i.test(parts[2]) ? `${parts[2]} · ` : "";
			return `${source}${node.label}`;
		}
		case "tool": return `${node.label} · ${node.id.split(":").at(-1) ?? node.id}`;
	}
}

function goalOutcome(outcome: string | undefined): string {
	switch (outcome) {
		case "fulfilled": return "目标已满足（记录结果）";
		case "partial": return "部分完成";
		case "incomplete": return "目标未完成";
		case "failed": return "目标失败";
		case "blocked": return "目标受阻";
		default: return outcome ?? "未记录目标结果";
	}
}

function feedbackLabel(status: string | undefined): string {
	switch (status) {
		case "pending": return "待生成";
		case "complete": return "完整反馈已登记";
		case "indexed": return "有界索引（需按范围读取证据）";
		case "control-facts-only": return "仅控制事实";
		case "failed": return "生成失败";
		default: return status ?? "未登记";
	}
}

function addGoalSummary(lines: string[], goal: NonNullable<WorkflowSnapshot["goal"]>): void {
	if (goal.m04BaselineRunId || goal.knowledgeSnapshot) lines.push(`当前基线：M04 ${goal.m04BaselineRunId ?? "未登记"} · 知识 ${goal.knowledgeSnapshot ?? "无"}${goal.formalBaseline === false ? "（探索性）" : ""}`);
	const latest = goal.checkpoints?.at(-1);
	if (latest) lines.push(`最近反馈快照：${latest.id} · ${feedbackLabel(latest.feedbackStatus)}${latest.selectedTaskIds ? ` · 选 ${latest.selectedTaskIds.length}/省 ${latest.omittedTaskIds?.length ?? 0} 项任务` : " · 范围未读取"} · 共 ${goal.checkpoints!.length} 次`);
	if (goal.feedbackStatus || goal.openDecisions) lines.push(`目标反馈：${feedbackLabel(goal.feedbackStatus)} · 待决定 ${goal.openDecisions} 项`);
	if (goal.returnPath) lines.push(`返回方向：${goal.returnPath}`);
}

function addGoalHistory(lines: string[], goal: NonNullable<WorkflowSnapshot["goal"]>): void {
	addGoalSummary(lines, goal);
	if (goal.baselineHistory?.length) {
		lines.push("基线历史：");
		for (const item of goal.baselineHistory) lines.push(`  ${item.at} · M04 ${item.m04RunId} · 知识 ${item.knowledgeSnapshot ?? "无"}`);
	}
	if (goal.checkpoints?.length) {
		lines.push("反馈快照历史（非目标终态，不证明 M04 已完整读取）：");
		for (const item of goal.checkpoints) {
			lines.push(`  ${item.id} · ${item.createdAt} · ${feedbackLabel(item.feedbackStatus)}`);
			if (item.selectedTaskIds) lines.push(`    已选任务：${item.selectedTaskIds.join("、") || "无"}`, `    省略任务：${item.omittedTaskIds?.join("、") || "无"}`);
			else lines.push("    冻结范围不可读取");
		}
	}
}

function resultLabel(result: string): string {
	switch (result) {
		case "passed": return "通过";
		case "failed": return "失败";
		case "not_run": return "未运行";
		default: return result || "未知";
	}
}

function addChecks(lines: string[], node: WorkflowNode): void {
	if (!node.checks.length) return;
	const groups = new Map<string, WorkflowNode["checks"]>();
	for (const check of node.checks) {
		const label = resultLabel(check.result);
		groups.set(label, [...(groups.get(label) ?? []), check]);
	}
	lines.push("检查明细：");
	for (const [result, criteria] of groups) {
		lines.push(`  ${result}：${criteria.length} 项`);
		for (const check of criteria) {
			lines.push(`    ${check.criterion}`);
			for (const evidence of check.evidence) lines.push(`      证据：${evidence}`);
		}
	}
}

function addRefs(lines: string[], label: string, refs: WorkflowNode["outputRefs"]): void {
	if (!refs.length) return;
	const unique = [...new Map(refs.map(ref => [ref.path, ref])).values()];
	lines.push(`${label}文件名：`);
	for (const ref of unique) lines.push(`  ${ref.label || path.basename(ref.path)}`, `    ${ref.path}`);
}

function addDetail(lines: string[], detail: string[]): void {
	if (!detail.length) return;
	lines.push(`状态说明：${detail.length} 条`);
	// Keep every recorded item, but divide large failure lists into navigable sections.
	for (let start = 0; start < detail.length; start += 25) {
		const end = Math.min(detail.length, start + 25);
		if (detail.length > 25) lines.push(`  第 ${start + 1}–${end} 条`);
		for (let i = start; i < end; i++) {
			const parts = detail[i].split(/\r?\n/);
			lines.push(`  ${i + 1}. ${parts[0]}`);
			for (const part of parts.slice(1)) lines.push(`     ${part}`);
		}
	}
}

/** Full control-record document. It never opens outputRefs, artifactRefs, or report text. */
export function nodeDetails(snapshot: WorkflowSnapshot, node?: WorkflowNode): string[] {
	const lines: string[] = [];
	if (!node) {
		lines.push(`工作区：${snapshot.workspace.label}`);
		if (snapshot.currentStage) lines.push(`当前阶段：${snapshot.currentStage}`);
		if (snapshot.currentRunId) lines.push(`当前运行：${snapshot.currentRunId}`);
		if (snapshot.goal) {
			lines.push(`目标：${snapshot.goal.title}`);
			lines.push(`目标生命周期：${snapshot.goal.lifecycle}`);
			lines.push(`目标结果：${goalOutcome(snapshot.goal.outcome)}`);
			addGoalHistory(lines, snapshot.goal);
		}
		return lines;
	}

	lines.push(`节点：${nodeIdentity(node)}`);
	lines.push(`状态：${statusLabel(node)}`);
	const goal = node.kind === "run" && node.stage === "M07" && snapshot.goal?.id === node.runId ? snapshot.goal : undefined;
	if (goal) {
		lines.push(`目标生命周期：${goal.lifecycle}`);
		lines.push(`目标结果：${goalOutcome(goal.outcome)}`);
		addGoalHistory(lines, goal);
		if (goal.attemptId) lines.push(`执行尝试：${goal.attemptId}${goal.attemptState ? ` · ${goal.attemptState}` : ""}`);
		lines.push(`目标检查：${goal.checks.total} 项（通过 ${goal.checks.passed}、失败 ${goal.checks.failed}、未运行 ${goal.checks.notRun}）`);
		lines.push(`委派任务：${goal.tasks.total} 项（执行中 ${goal.tasks.running}、已返回 ${goal.tasks.returned}、已接受 ${goal.tasks.accepted}、未接受 ${goal.tasks.rejected}、失败 ${goal.tasks.failed}、未知 ${goal.tasks.unknown}）`);
	}
	if (node.stage) lines.push(`阶段：${node.stage}`);
	if (node.runId) lines.push(`运行：${node.runId}`);
	if (node.taskId) lines.push(`任务 ID：${node.taskId}`);
	if (node.missionId) lines.push(`原目标 ID：${node.missionId}`);
	if (node.sessionId) lines.push(`会话：${node.sessionId}`);
	if (node.model) lines.push(`模型：${node.model}`);
	if (node.startedAt) lines.push(`开始：${node.startedAt}`);
	if (node.endedAt) lines.push(`结束：${node.endedAt}`);
	if (node.lastSeenAt) lines.push(`最近心跳：${node.lastSeenAt}`);
	if (node.usage) {
		const u = node.usage;
		lines.push(`用量：输入 ${u.input}、输出 ${u.output}、缓存读取 ${u.cacheRead}、缓存写入 ${u.cacheWrite}${u.complete ? "" : "（记录不完整）"}`);
		lines.push(`计费记录：${u.cost}${u.costComplete ? "" : "（不完整）"}；已报告事件 ${u.reportedEvents}、未知事件 ${u.unknownEvents}`);
	}
	const countByResult = new Map<string, number>();
	for (const check of node.checks) countByResult.set(resultLabel(check.result), (countByResult.get(resultLabel(check.result)) ?? 0) + 1);
	lines.push(`检查：${node.checks.length} 项${countByResult.size ? `（${[...countByResult].map(([name, count]) => `${name} ${count}`).join("、")}）` : ""}`);
	const artifacts = [...new Set(node.artifactRefs.map(ref => ref.path))];
	const otherOutputs = node.outputRefs.filter(ref => !artifacts.includes(ref.path));
	lines.push(`登记成果：${artifacts.length} 项`);
	if (otherOutputs.length) lines.push(`其他输出：${new Set(otherOutputs.map(ref => ref.path)).size} 项`);
	if (node.kind === "task") lines.push("完整任务说明：", ...taskObjective(node).split(/\r?\n/));
	if (goal) lines.push("完整目标：", ...goal.title.split(/\r?\n/));
	addChecks(lines, node);
	addRefs(lines, "登记成果", node.artifactRefs);
	addRefs(lines, "其他输出", otherOutputs);
	addDetail(lines, node.detail);
	return lines;
}

function firstRecordedLine(value: string): string {
	return value.split(/\r?\n/).find(line => line.trim().length > 0)?.trim() ?? "";
}

/** Brief control-record overview; v opens the complete registered text. */
export function nodeOverview(snapshot: WorkflowSnapshot, node?: WorkflowNode): string[] {
	if (!node) {
		const lines = [`工作区：${snapshot.workspace.label}`];
		if (snapshot.currentStage) lines.push(`当前阶段：${snapshot.currentStage}`);
		if (snapshot.currentRunId) lines.push(`当前运行：${snapshot.currentRunId}`);
		if (snapshot.goal) {
			lines.push(`目标标题：${firstRecordedLine(snapshot.goal.title)}`);
			lines.push(`目标生命周期：${snapshot.goal.lifecycle}`);
			lines.push(`目标结果：${goalOutcome(snapshot.goal.outcome)}`);
			addGoalSummary(lines, snapshot.goal);
		}
		return lines;
	}
	const lines = [`节点：${nodeIdentity(node)}`, `状态：${statusLabel(node)}`];
	const goal = node.kind === "run" && node.stage === "M07" && snapshot.goal?.id === node.runId ? snapshot.goal : undefined;
	if (node.kind === "task") lines.push(`任务标题：${firstRecordedLine(taskObjective(node))}`);
	else if (goal) lines.push(`目标标题：${firstRecordedLine(goal.title)}`);
	if (goal) {
		lines.push(`目标生命周期：${goal.lifecycle}`);
		lines.push(`目标结果：${goalOutcome(goal.outcome)}`);
		addGoalSummary(lines, goal);
		lines.push(`目标检查：${goal.checks.total} 项（通过 ${goal.checks.passed}、失败 ${goal.checks.failed}、未运行 ${goal.checks.notRun}）`);
		if (goal.attemptId) lines.push(`执行尝试：${goal.attemptId}${goal.attemptState ? ` · ${goal.attemptState}` : ""}`);
	}
	if (node.stage && node.kind !== "run") lines.push(`阶段：${node.stage}`);
	if (node.runId && node.kind !== "run") lines.push(`运行：${node.runId}`);
	if (node.kind === "task" && snapshot.goal && node.runId === snapshot.goal.id && node.taskId === snapshot.goal.currentTaskId && snapshot.goal.attemptId)
		lines.push(`当前执行尝试：${snapshot.goal.attemptId}${snapshot.goal.attemptState ? ` · ${snapshot.goal.attemptState}` : ""}`);
	if (node.sessionId) lines.push(`会话：${node.sessionId}`);
	if (node.model) lines.push(`模型：${node.model}`);
	if (node.startedAt) lines.push(`开始：${node.startedAt}`);
	if (node.endedAt) lines.push(`结束：${node.endedAt}`);
	if (node.lastSeenAt) lines.push(`最近心跳：${node.lastSeenAt}`);
	if (node.usage) {
		const u = node.usage;
		lines.push(`用量：输入 ${u.input}、输出 ${u.output}、缓存读取 ${u.cacheRead}、缓存写入 ${u.cacheWrite}${u.complete ? "" : "（记录不完整）"}`);
	}
	const counts = new Map<string, number>();
	for (const check of node.checks) counts.set(resultLabel(check.result), (counts.get(resultLabel(check.result)) ?? 0) + 1);
	lines.push(`检查：${node.checks.length} 项${counts.size ? `（${[...counts].map(([name, n]) => `${name} ${n}`).join("、")}）` : ""}`);
	const artifacts = new Set(node.artifactRefs.map(ref => ref.path));
	lines.push(`登记成果：${artifacts.size} 项`);
	const otherOutputs = new Set(node.outputRefs.filter(ref => !artifacts.has(ref.path)).map(ref => ref.path));
	if (otherOutputs.size) lines.push(`其他输出：${otherOutputs.size} 项`);
	lines.push("完整任务说明、检查明细与文件清单：按 v 阅读");
	return lines;
}
