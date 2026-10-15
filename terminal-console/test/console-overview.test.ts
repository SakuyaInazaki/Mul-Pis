import assert from "node:assert/strict";
import test from "node:test";
import { nodeDetails, nodeIdentity, nodeOverview, statusLabel } from "../src/console/overview.ts";
import type { WorkflowNode, WorkflowSnapshot } from "../src/console/model.ts";

function makeNode(overrides: Partial<WorkflowNode> = {}): WorkflowNode {
	return { id: "task:g:T001", label: "T001 · 验证完整的科学目标及其限制", kind: "task", status: "returned",
		stage: "M07", runId: "g", taskId: "T001", detail: [], outputRefs: [], artifactRefs: [], checks: [], ...overrides };
}
function makeSnapshot(node: WorkflowNode): WorkflowSnapshot {
	return { workspace: { root: "/work", label: "work" }, generatedAt: "2026-10-14T00:00:00Z", nodes: [node], events: [], runs: [],
		goal: { id: "g", title: "完整目标：探明 A 是否成立，保留所有边界条件", lifecycle: "finished", outcome: "incomplete",
			checks: { total: 2, passed: 1, failed: 1, notRun: 0 }, tasks: { total: 1, running: 0, returned: 1, accepted: 0, rejected: 0, failed: 0, unknown: 0 }, openDecisions: 0, stateRefs: [] },
		knowledge: {}, warnings: [] };
}

test("overview keeps the recorded first title line while details retain full text and file names", () => {
	const completeTitle = "验证完整的科学目标及其限制，涵盖所有已登记的关键条件";
	const objective = `${completeTitle}\n背景：${"完整背景内容".repeat(200)}\n执行指令：逐项核对`;
	const node = makeNode({ label: `T001 · ${objective}`, checks: [{ criterion: "证据齐备", result: "passed", evidence: ["/work/not-read-evidence.md"] },
		{ criterion: "反例排查", result: "failed", evidence: [] }],
		artifactRefs: [{ label: "证据", path: "/work/results/complete-original-filename-with-many-parts.json" }],
		outputRefs: [{ label: "任务报告", path: "/work/reports/full-report.md" }],
		usage: { input: 31, output: 7, cacheRead: 4, cacheWrite: 1, cost: 0.03, complete: false, costComplete: false, reportedEvents: 2, unknownEvents: 1 } });
	const overview = nodeOverview(makeSnapshot(node), node).join("\n");
	const details = nodeDetails(makeSnapshot(node), node).join("\n");
	assert.match(overview, new RegExp(`任务标题：${completeTitle}`));
	assert.match(overview, /状态：任务已返回，待审查/);
	assert.match(overview, /检查：2 项/);
	assert.match(overview, /登记成果：1 项/);
	assert.match(overview, /输入 31、输出 7/);
	assert.match(overview, /完整任务说明、检查明细与文件清单：按 v 阅读/);
	assert(overview.split("\n").length < 20);
	assert.doesNotMatch(overview, /完整背景内容|执行指令|证据齐备|complete-original-filename|full-report/);
	assert(details.includes(objective));
	assert.match(details, /通过：1 项/);
	assert.match(details, /失败：1 项/);
	assert.match(details, /complete-original-filename-with-many-parts\.json/);
	assert.match(details, /full-report\.md/);
	assert.match(details, /证据：\/work\/not-read-evidence\.md/);
	assert.doesNotMatch(overview, /not-read-evidence/);
	assert.doesNotMatch(details, /…|\.\.\./);
	assert.equal(nodeIdentity(node), "任务 T001");
});

test("M07 run distinguishes goal outcome from completed run and never imports another goal", () => {
	const run = makeNode({ id: "run:M07:g", kind: "run", label: "M07 · g", taskId: undefined, status: "completed" });
	const lines = nodeOverview(makeSnapshot(run), run).join("\n");
	assert.match(lines, /状态：运行已结束/);
	assert.match(lines, /目标标题：完整目标：探明 A 是否成立，保留所有边界条件/);
	assert.match(lines, /目标结果：目标未完成/);
	assert.match(nodeDetails(makeSnapshot(run), run).join("\n"), /完整目标：\n完整目标：探明 A 是否成立，保留所有边界条件/);
	assert.equal(nodeIdentity(run), "M07运行 · g");
	const other = makeNode({ ...run, id: "run:M07:other", runId: "other" });
	assert.doesNotMatch(nodeOverview(makeSnapshot(other), other).join("\n"), /目标标题：/);
});

test("M07 overview stays short while details retain checkpoint and baseline history", () => {
	const run = makeNode({ id: "run:M07:g", kind: "run", label: "M07 · g", taskId: undefined });
	const snap = makeSnapshot(run);
	snap.goal!.outcome = "partial";
	snap.goal!.m04BaselineRunId = "m2";
	snap.goal!.knowledgeSnapshot = "G002";
	snap.goal!.formalBaseline = true;
	snap.goal!.baselineHistory = [{ at: "t1", m04RunId: "m1", knowledgeSnapshot: "G001" }, { at: "t2", m04RunId: "m2", knowledgeSnapshot: "G002" }];
	snap.goal!.checkpoints = [{ id: "C001", createdAt: "t1", feedbackStatus: "indexed", selectedTaskIds: ["T001"], omittedTaskIds: ["T002"] }];
	snap.goal!.feedbackStatus = "control-facts-only";
	snap.goal!.openDecisions = 2;
	snap.goal!.returnPath = "M04";
	const overview = nodeOverview(snap, run).join("\n");
	const details = nodeDetails(snap, run).join("\n");
	assert.match(overview, /目标结果：部分完成/);
	assert.match(overview, /当前基线：M04 m2 · 知识 G002/);
	assert.match(overview, /最近反馈快照：C001 · 有界索引.*选 1\/省 1/);
	assert.match(overview, /目标反馈：仅控制事实 · 待决定 2 项/);
	assert.match(overview, /返回方向：M04/);
	assert.doesNotMatch(overview, /T001|T002|基线历史/);
	assert.match(details, /基线历史：[\s\S]*M04 m1[\s\S]*M04 m2/);
	assert.match(details, /已选任务：T001[\s\S]*省略任务：T002/);
	assert.match(details, /非目标终态，不证明 M04 已完整读取/);
});

test("multiline goal title stays brief in overview and complete in details", () => {
	const run = makeNode({ id: "run:M07:g", kind: "run", label: "M07 · g", taskId: undefined });
	const snap = makeSnapshot(run);
	snap.goal!.title = `首行目标，保持完整的研究边界\n${"后续背景段落".repeat(150)}`;
	const overview = nodeOverview(snap, run).join("\n");
	assert.match(overview, /目标标题：首行目标，保持完整的研究边界/);
	assert.doesNotMatch(overview, /后续背景段落/);
	assert(nodeDetails(snap, run).join("\n").includes(snap.goal!.title));
});

test("large recorded failure lists remain complete in numbered sections", () => {
	const failures = Array.from({ length: 103 }, (_, i) => `失败项 ${i + 1}：保留完整原因与证据编号 E${i + 1}`);
	const node = makeNode({ detail: failures });
	const overview = nodeOverview(makeSnapshot(node), node);
	const lines = nodeDetails(makeSnapshot(node), node);
	assert(overview.length < 20);
	assert(!overview.some(x => x.includes("失败项 1")));
	assert(lines.some(x => x.includes("第 1–25 条")));
	assert(lines.some(x => x.includes("第 101–103 条")));
	for (const failure of failures) assert(lines.some(x => x.includes(failure)), failure);
	assert.doesNotMatch(lines.join("\n"), /…|\.\.\./);
});

test("identity retains source and session identity while statuses preserve review semantics", () => {
	assert.equal(nodeIdentity(makeNode({ id: "group:r:S002", kind: "group", label: "多来源资料", taskId: undefined })), "S002 · 多来源资料");
	assert.equal(nodeIdentity(makeNode({ id: "session:s-123", kind: "session", label: "M06-S002-reader", taskId: undefined, sessionId: "s-123" })), "M06-S002-reader · s-123");
	assert.equal(statusLabel(makeNode({ status: "accepted" })), "任务已接受");
	assert.equal(statusLabel(makeNode({ kind: "tool", status: "returned" })), "调用已返回");
	assert.equal(statusLabel(makeNode({ kind: "session", status: "completed" })), "会话已结束");
});
