import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { clip, pad, safeText, Screen, textWidth, wrap } from "../src/console/terminal.ts";
import { hitTest, renderConsole, renderFrame, visibleNodes, type ConsoleView } from "../src/console/render.ts";
import { parseMouse } from "../src/console/input.ts";
import { main, parseConsoleArgs } from "../src/console/cli.ts";
import type { WorkflowNode, WorkflowSnapshot } from "../src/console/model.ts";

const run = promisify(execFile);
function node(id: string, parentId?: string): WorkflowNode {
	return { id, ...(parentId ? { parentId } : {}), label: id, kind: "task", status: "running", detail: [], outputRefs: [], artifactRefs: [], checks: [] };
}
function snapshot(nodes: WorkflowNode[]): WorkflowSnapshot {
	return { workspace: { root: "/test", label: "工作区" }, generatedAt: "2026-10-14T00:00:00Z", currentStage: "M07", nodes, events: [], runs: [], knowledge: {}, warnings: [] };
}
function view(snap: WorkflowSnapshot, overrides: Partial<ConsoleView> = {}): ConsoleView {
	return { snapshot: snap, selectedId: snap.nodes[0]?.id, collapsed: new Set(), preview: [], previewOffset: 0, focus: "tree", connected: false, hostLabel: "只读快照", recent: [], ...overrides };
}

test("terminal measures CJK and emoji cells while stripping injected control sequences", () => {
	assert.equal(textWidth("A中🙂B"), 6);
	assert.equal(clip("甲乙", 3), "甲…");
	assert.equal(textWidth(pad("甲", 5)), 5);
	assert.deepEqual(wrap("中A中B", 3), ["中A", "中B"]);
	const hostile = "正\x1b[31m红\x1b[0m\u202e逆\n下一行";
	assert.equal(safeText(hostile), "正红 逆 下一行");
	const screen = new Screen(8, 2);
	screen.write(0, 0, hostile, "plain");
	for (const line of screen.lines(false)) {
		assert.equal(textWidth(line), 8);
		assert.doesNotMatch(line, /\x1b|\u202e|\n/);
	}
	// A modal can start in the second cell of a CJK glyph underneath it.
	screen.write(0, 1, "甲乙丙丁"); screen.write(1, 1, "xy");
	assert.equal(textWidth(screen.lines(false)[1]), 8);
});

test("collapsed ancestors hide descendants without removing unrelated nodes", () => {
	const snap = snapshot([node("root"), node("child", "root"), node("grandchild", "child"), node("other")]);
	assert.deepEqual(visibleNodes(snap, new Set(["root"])).map(x => x.node.id), ["root", "other"]);
	assert.deepEqual(visibleNodes(snap, new Set()).map(x => x.node.id), ["root", "child", "grandchild", "other"]);
});

test("narrow terminal renders selected detail and main-session output without overflow", () => {
	const snap = snapshot([node("root")]);
	const details = renderConsole(view(snap, { focus: "detail", preview: ["证据：甲乙", "检查通过"] }), 48, 18, false);
	assert.equal(details.length, 18);
	assert.match(details.join("\n"), /证据：甲乙/);
	assert.match(details.join("\n"), /检查通过/);
	for (const line of details) assert.equal(textWidth(line), 48);
	const mainOutput = renderConsole(view(snap, { focus: "detail", reading: { title: "Pi 主会话实时输出", lines: ["Pi 主会话返回：结论仍待核查"], offset: 0 } }), 120, 32, false);
	assert.match(mainOutput.join("\n"), /主会话实时输出/);
	assert.match(mainOutput.join("\n"), /结论仍待核查/);
	const tiny = renderConsole(view(snap), 24, 6, false);
	assert.equal(tiny.length, 6); for (const line of tiny) assert.equal(textWidth(line), 24);
});

test("navigation and document hit rows agree with rendered rows at common terminal sizes", () => {
	const snap = snapshot([node("root")]);
	for (const [width, height] of [[48, 18], [80, 24], [120, 40], [200, 55]]) {
		const frame = renderFrame(view(snap, { focus: "detail", preview: ["完整正文甲乙"], notice: "检查完成" }), width, height, false);
		assert.equal(frame.lines.length, height);
		for (const line of frame.lines) { assert.equal(textWidth(line), width); assert.doesNotMatch(line, /…/); }
		for (const target of frame.targets) {
			assert.ok(target.x >= 0 && target.y >= 0 && target.x + target.width <= width && target.y + target.height <= height);
			assert.equal(hitTest(frame, target.x, target.y)?.action, target.action);
		}
		for (let i = 1; i <= 9; i++) assert.ok(frame.targets.some(t => t.action === "stage" && t.value === `M0${i}`));
		assert.ok(frame.targets.some(t => t.action === "knowledge"));
		const doc = frame.targets.find(t => t.action === "documents");
		assert.ok(doc);
		assert.match(frame.lines[doc.y], /完整记录/);
	}
	assert.deepEqual(parseMouse("\x1b[<0;2;3M"), { x: 1, y: 2, wheel: 0, release: false, left: true });
	const tree = renderFrame(view(snapshot([node("parent"), node("child", "parent")]), { focus: "tree" }), 48, 18, false);
	const toggle = tree.targets.find(t => t.action === "node-toggle" && t.value === "parent");
	assert.ok(toggle);
	assert.equal(hitTest(tree, toggle.x, toggle.y)?.action, "node-toggle");
});

test("long detail, reader, and popup text is reachable through row offsets", () => {
	const snap = snapshot([node("root")]);
	const content = Array.from({ length: 45 }, (_, i) => `第${i + 1}行 唯一内容 ${"甲乙丙丁".repeat(15)}${i === 44 ? " 末尾标记" : ""}`);
	let frame = renderFrame(view(snap, { focus: "detail", preview: content }), 48, 18, false);
	assert.ok(frame.detailLines > frame.detailRows);
	frame = renderFrame(view(snap, { focus: "detail", preview: content, previewOffset: frame.detailLines - frame.detailRows }), 48, 18, false);
	assert.match(frame.lines.join("\n"), /末尾标记/);
	const title = "长标题".repeat(30);
	const reader = view(snap, { reading: { title, lines: content, offset: 0 } });
	frame = renderFrame(reader, 48, 18, false);
	assert.ok(frame.readerRows >= 8);
	assert.ok(frame.readerLines > frame.readerRows);
	reader.reading!.offset = frame.readerLines - frame.readerRows;
	frame = renderFrame(reader, 48, 18, false);
	assert.match(frame.lines.join("\n"), /末尾标记/);
	const popup = view(snap, { popup: { title: "选择文档", lines: ["选项：" + "漫长内容".repeat(90)], selected: 0, offset: 0 } });
	frame = renderFrame(popup, 48, 18, false);
	assert.ok(frame.popupLines > frame.popupRows);
	popup.popup!.offset = frame.popupLines - frame.popupRows;
	frame = renderFrame(popup, 48, 18, false);
	assert.match(frame.lines.join("\n"), /漫长内容/);
	assert.ok(frame.targets.some(t => t.action === "popup" && t.value === "0"));
});

test("CLI rejects malformed and contradictory control arguments before execution", async () => {
	assert.throws(() => parseConsoleArgs(["start", "--once"]), /--once/);
	assert.throws(() => parseConsoleArgs(["workflow", "--json"]), /--once \/ --json/);
	assert.throws(() => parseConsoleArgs(["status", "--stage", "M00"]), /M01–M09/);
	assert.throws(() => parseConsoleArgs(["status", "--run", "R001"]), /同时指定 --stage/);
	assert.throws(() => parseConsoleArgs(["status", "--goal", "G001", "--stage", "M07"]), /不可混用/);
	assert.throws(() => parseConsoleArgs(["start", "--workspace"]), /缺少值/);
	assert.throws(() => parseConsoleArgs(["status", "--workspace", "/a", "--workspace", "/b"]), /重复选项/);
	const root = await mkdtemp(path.join(tmpdir(), "console-terminal-cli-"));
	try {
		await writeFile(path.join(root, "research.config.json"), "{}\n");
		await assert.rejects(main(["start", "--workspace", root, "--model", "provider/model", "--prompt-file", "task.txt", "--goal", "G1"]), /已有目标请使用 recover/);
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("once and JSON status read actual persisted runs without changing workspace files", async () => {
	const root = await mkdtemp(path.join(tmpdir(), "console-terminal-status-"));
	try {
		await writeFile(path.join(root, "research.config.json"), "{}\n");
		const runFile = path.join(root, "stages", "M01", "R001", "run.json");
		await mkdir(path.dirname(runFile), { recursive: true });
		await writeFile(runFile, `${JSON.stringify({ stage: "M01", runId: "R001", status: "completed", startedAt: "2026-10-14T00:00:00Z", finishedAt: "2026-10-14T00:01:00Z", inputs: [], sessions: [], outputs: [], failures: [], remarks: [] })}\n`);
		const before = (await readdir(root, { recursive: true })).sort();
		const original = await readFile(runFile, "utf8");
		const cli = path.resolve("src/console/cli.ts");
		const once = await run(process.execPath, [cli, "--workspace", root, "--once"], { cwd: path.resolve("."), maxBuffer: 1_000_000 });
		assert.match(once.stdout, /M01/);
		assert.match(once.stdout, /R001/);
		const status = await run(process.execPath, [cli, "status", "--workspace", root, "--json"], { cwd: path.resolve("."), maxBuffer: 1_000_000 });
		const parsed = JSON.parse(status.stdout) as WorkflowSnapshot;
		assert.equal(parsed.currentRunId, "R001");
		assert.equal(parsed.runs.find(x => x.stage === "M01")?.status, "completed");
		assert.deepEqual((await readdir(root, { recursive: true })).sort(), before);
		assert.equal(await readFile(runFile, "utf8"), original);
	} finally { await rm(root, { recursive: true, force: true }); }
});
