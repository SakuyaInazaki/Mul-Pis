import assert from "node:assert/strict";
import test from "node:test";
import { hitTest, renderFrame, visibleNodes, workflowFocus, type ConsoleFrame, type ConsoleView } from "../src/console/render.ts";
import { nodeOverview } from "../src/console/overview.ts";
import { textWidth } from "../src/console/terminal.ts";
import type { WorkflowNode, WorkflowSnapshot } from "../src/console/model.ts";

const SIZES: Array<[number, number]> = [[36, 16], [48, 16], [80, 18], [85, 24], [86, 24], [120, 40], [200, 55]];
const LONG_WORKSPACE = "非常长的研究工作区名称".repeat(12) + "工作区末尾标记";
const LONG_RUN = "R-" + "运行编号".repeat(35) + "运行末尾标记";
const LONG_NOTICE = "控制消息".repeat(70) + "提示末尾标记";

function node(id: string, status: WorkflowNode["status"] = "running"): WorkflowNode {
	return { id, label: id, taskId: id, kind: "task", status, detail: [], outputRefs: [], artifactRefs: [], checks: [] };
}

function snapshot(nodes: WorkflowNode[] = [node("T01")]): WorkflowSnapshot {
	return {
		workspace: { root: "/test", label: LONG_WORKSPACE }, generatedAt: "2026-10-15T00:00:00Z",
		currentStage: "M07", currentRunId: LONG_RUN, nodes, events: [], runs: [], knowledge: {}, warnings: [],
	};
}

function view(overrides: Partial<ConsoleView> = {}): ConsoleView {
	return {
		snapshot: snapshot(), selectedId: "T01", collapsed: new Set(), preview: ["概况", LONG_WORKSPACE, LONG_RUN],
		previewOffset: 0, focus: "tree", connected: false, hostLabel: "只读快照", recent: [],
		lastError: LONG_NOTICE, ...overrides,
	};
}

function lineAt(frame: ConsoleFrame, y: number): string { return frame.lines[y] ?? ""; }

function assertFrameGeometry(frame: ConsoleFrame, width: number, height: number): void {
	assert.equal(frame.lines.length, height);
	for (const line of frame.lines) {
		assert.equal(textWidth(line), width, `every rendered row must occupy exactly ${width} terminal cells`);
		assert.doesNotMatch(line, /…/, "the renderer must wrap or offer scrolling instead of ellipsizing text");
	}
	for (const target of frame.targets) {
		assert.ok(target.x >= 0 && target.y >= 0 && target.width > 0 && target.height > 0);
		assert.ok(target.x + target.width <= width && target.y + target.height <= height);
	}
}

test("long heading and control message leave a usable body at boundary sizes", () => {
	for (const [width, height] of SIZES) {
		const frame = renderFrame(view(), width, height, false);
		assertFrameGeometry(frame, width, height);
		const screen = frame.lines.join("\n");
		assert.match(screen, /MUL-PIS/);
		assert.match(screen, /T01/, `${width}x${height}: a selected node must remain visible`);
		assert.match(screen, /执行中/, `${width}x${height}: its complete state must remain visible`);
		assert.match(screen, /l/, `${width}x${height}: the full-message command must remain discoverable`);
		for (let stage = 1; stage <= 9; stage++) {
			const value = `M0${stage}`;
			const target = frame.targets.find(t => t.action === "stage" && t.value === value);
			assert.ok(target, `${width}x${height}: ${value} must remain clickable`);
			assert.ok(lineAt(frame, target.y).includes(value), `${value} hit row must display ${value}`);
			assert.equal(hitTest(frame, target.x, target.y)?.action, "stage");
		}
		const knowledge = frame.targets.find(t => t.action === "knowledge");
		assert.ok(knowledge, `${width}x${height}: knowledge must remain clickable`);
		assert.match(lineAt(frame, knowledge.y), /知识/);
		assert.equal(hitTest(frame, knowledge.x, knowledge.y)?.action, "knowledge");
		for (const target of frame.targets.filter(t => t.action === "node" || t.action === "node-toggle")) {
			assert.match(lineAt(frame, target.y), /T01|执行中/, `${width}x${height}: a node target must not hide beneath another region`);
			assert.equal(hitTest(frame, target.x, target.y)?.action, target.action);
		}
	}
});

test("a short terminal keeps selected identity and full state together without color", () => {
	for (const [width, height] of [[36, 16], [48, 16], [80, 18]] as const) {
		const nodes = [node("T01", "completed"), node("T02", "blocked")];
		const frame = renderFrame(view({ snapshot: snapshot(nodes), selectedId: "T02" }), width, height, false);
		assertFrameGeometry(frame, width, height);
		const selectedRow = frame.lines.find(line => line.includes("T02"));
		assert.ok(selectedRow, `${width}x${height}: selected identity must be visible`);
		assert.match(selectedRow, /已阻塞/, `${width}x${height}: full state belongs on the same compact row`);
		assert.match(selectedRow, /[>›▶▸◆]/, `${width}x${height}: selection must have a visible non-color indicator`);
	}
	const nodes = Array.from({ length: 80 }, (_, i) => node(`T${String(i + 1).padStart(3, "0")}`, "accepted"));
	const base = view({ snapshot: snapshot(nodes), selectedId: "T001" });
	const frame = renderFrame(base, 120, 30, false);
	const track = frame.targets.filter(t => t.action === "node" && t.width === 1);
	assert.equal(track[0]?.value, "T001");
	assert.equal(track.at(-1)?.value, "T080", "clicking the bottom of the tree track must reach the final node");
	assert.match(renderFrame({ ...base, selectedId: track.at(-1)?.value }, 120, 30, false).lines.join("\n"), /T080/);
});

test("first frame follows the persisted running task through old attempts and keeps manual focus on refresh", () => {
	const run: WorkflowNode = { ...node("run:M07:g"), kind: "run", taskId: undefined, status: "running", runId: "g" };
	const attempts: WorkflowNode[] = Array.from({ length: 13 }, (_, i) => ({ ...node(`attempt:g:A${String(i + 1).padStart(3, "0")}`, "unknown"),
		kind: "attempt", taskId: undefined, parentId: run.id, runId: "g" }));
	const history: WorkflowNode[] = Array.from({ length: 208 }, (_, i) => ({ ...node(`task:g:T${String(i + 1).padStart(3, "0")}`, "accepted"),
		taskId: `T${String(i + 1).padStart(3, "0")}`, parentId: run.id, runId: "g" }));
	const active: WorkflowNode = { ...node("task:g:T209", "stale"), taskId: "T209", parentId: history.at(-1)!.id, runId: "g" };
	const snap = snapshot([run, ...attempts, ...history, active]);
	snap.goal = { id: "g", title: "目标", lifecycle: "active", attemptId: "A013", attemptState: "running", currentTaskId: "T209",
		openDecisions: 0, checks: { total: 0, passed: 0, failed: 0, notRun: 0 },
		tasks: { total: 209, running: 1, returned: 0, accepted: 208, rejected: 0, failed: 0, unknown: 0 }, stateRefs: [] };
	const initial = workflowFocus(snap);
	assert.equal(initial.selectedId, active.id);
	assert(!initial.collapsed.has(history.at(-1)!.id), "the active task's accepted parent must open");
	assert(visibleNodes(snap, initial.collapsed).some(item => item.node.id === active.id));
	const preview = nodeOverview(snap, active);
	assert.match(preview.join("\n"), /当前执行尝试：A013/);
	assert.match(renderFrame(view({ snapshot: snap, selectedId: initial.selectedId, collapsed: initial.collapsed, preview }), 120, 24, false).lines.join("\n"), /T209/);
	const manualFolds = new Set([history.at(-1)!.id]);
	const afterRefresh = workflowFocus(snap, history[0].id, manualFolds);
	assert.equal(afterRefresh.selectedId, history[0].id);
	assert.equal(afterRefresh.collapsed, manualFolds, "a refresh must not reopen user-folded branches");
});

test("the complete end of a long title and overview stays reachable by scrolling", () => {
	const tail = "概况正文唯一末尾标记";
	for (const [width, height] of [[36, 16], [48, 16], [85, 24], [86, 24], [120, 40]] as const) {
		const base = view({ focus: "detail", preview: [LONG_WORKSPACE, LONG_RUN, LONG_NOTICE, tail] });
		let frame = renderFrame(base, width, height, false);
		assertFrameGeometry(frame, width, height);
		assert.ok(frame.detailLines >= frame.detailRows);
		let found = false;
		for (let offset = 0; offset <= frame.detailLines - frame.detailRows; offset += frame.detailRows) {
			frame = renderFrame({ ...base, previewOffset: offset }, width, height, false);
			if (frame.lines.join("\n").includes(tail)) { found = true; break; }
		}
		assert.ok(found, `${width}x${height}: final overview text must be reachable by paging`);
	}
});

test("a long selectable popup reaches its unique tail and masks underlying hit targets", () => {
	const tail = "弹窗选项唯一末尾标记";
	const base = view({ popup: { title: "选择正文成果", lines: ["成果路径 " + "甲乙丙丁".repeat(600) + tail, "第二项"], selected: 0, offset: 0 } });
	for (const [width, height] of [[36, 16], [48, 18], [120, 40]] as const) {
		let frame = renderFrame(base, width, height, false);
		assertFrameGeometry(frame, width, height);
		assert.ok(frame.popupLines > frame.popupRows);
		frame = renderFrame({ ...base, popup: { ...base.popup!, offset: frame.popupLines - frame.popupRows } }, width, height, false);
		assert.match(frame.lines.join("\n"), /弹窗选项唯一末尾标记|第二项/, `${width}x${height}: final option text must be reachable`);
		assert.ok(frame.targets.some(t => t.action === "popup"));
		assert.ok(frame.targets.every(t => t.action === "popup" || t.action === "popup-scroll"), "underlying navigation must not remain clickable through a popup");
	}
});
