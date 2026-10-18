import type { WorkflowNode, WorkflowSnapshot } from "./model.ts";
import { knowledgeStatusLabel, type KnowledgeView } from "./knowledge.ts";
import { nodeIdentity, statusLabel } from "./overview.ts";
import { Screen, pad, safeText, textWidth, wrap, type Line, type Tone } from "./terminal.ts";

export const STAGE_LABELS = ["初识", "判据", "质询", "判断", "获取", "阅读", "执行", "审查", "交付"];
export const KNOWLEDGE_KINDS = ["全部", "C", "K", "E", "J", "Q", "D", "X", "限制"];
export interface ConsoleView {
	snapshot?: WorkflowSnapshot;
	workspaceLabel?: string;
	selectedId?: string;
	collapsed: Set<string>;
	preview: string[];
	previewOffset: number;
	focus: "tree" | "detail";
	mode?: "workflow" | "knowledge";
	knowledge?: KnowledgeView;
	knowledgeCurrent?: boolean;
	knowledgeKind?: string;
	knowledgeSelectedId?: string;
	query?: string;
	connected: boolean;
	hostLabel: string;
	hostState?: string;
	mainState?: string;
	mainModel?: string;
	controlTarget?: string;
	lastError?: string;
	notice?: string;
	recent: string[];
	input?: { label: string; text: string };
	popup?: { title: string; lines: string[]; selected?: number; offset?: number };
	reading?: { title: string; lines: string[]; offset: number; pageLabel?: string; hasNext?: boolean; hasPrevious?: boolean };
}
export interface HitTarget { x: number; y: number; width: number; height: number; action: "stage" | "knowledge" | "node" | "node-toggle" | "knowledge-record" | "kind" | "tree" | "detail" | "runs" | "snapshots" | "documents" | "popup" | "reader" | "reader-close" | "key" | "detail-scroll" | "reader-scroll" | "popup-scroll"; value?: string }
export interface ConsoleFrame { lines: string[]; targets: HitTarget[]; detailRows: number; detailLines: number; readerRows: number; readerLines: number; popupRows: number; popupLines: number; popupOffset: number }
export function defaultCollapsed(snapshot: WorkflowSnapshot): Set<string> { return new Set(snapshot.nodes.filter(n => (n.kind === "task" || n.kind === "session") && n.status !== "running").map(n => n.id)); }
/** Choose the persisted active task once; later refreshes keep the reader's selection and folds. */
export function workflowFocus(snapshot: WorkflowSnapshot, selectedId?: string, collapsed?: Set<string>): { selectedId?: string; collapsed: Set<string> } {
	const byId = new Map(snapshot.nodes.map(node => [node.id, node]));
	if (selectedId && byId.has(selectedId)) return { selectedId, collapsed: collapsed ?? defaultCollapsed(snapshot) };
	const current = snapshot.goal?.currentTaskId ? snapshot.nodes.find(node => node.kind === "task" &&
		node.runId === snapshot.goal?.id && node.taskId === snapshot.goal?.currentTaskId) : undefined;
	const selected = current ?? snapshot.nodes.find(node => node.kind === "task" && node.status === "running") ??
		snapshot.nodes.find(node => node.kind === "run");
	const folds = defaultCollapsed(snapshot);
	for (let node = selected; node?.parentId; node = byId.get(node.parentId)) folds.delete(node.parentId);
	return { selectedId: selected?.id, collapsed: folds };
}
export function visibleNodes(snapshot: WorkflowSnapshot | undefined, collapsed: Set<string>, query = ""): Array<{ node: WorkflowNode; depth: number }> {
	if (!snapshot) return [];
	let nodes = snapshot.nodes.filter(n => n.kind !== "stage");
	const byId = new Map(nodes.map(n => [n.id, n]));
	if (query) {
		const included = new Set<string>(), term = query.toLocaleLowerCase();
		for (const node of nodes) if (`${node.label} ${node.taskId ?? ""} ${node.status}`.toLocaleLowerCase().includes(term)) {
			let n: WorkflowNode | undefined = node;
			while (n && !included.has(n.id)) { included.add(n.id); n = n.parentId ? byId.get(n.parentId) : undefined; }
		}
		nodes = nodes.filter(n => included.has(n.id));
	}
	const ids = new Set(nodes.map(n => n.id)), children = new Map<string, WorkflowNode[]>();
	for (const node of nodes) if (node.parentId) { const list = children.get(node.parentId) ?? []; list.push(node); children.set(node.parentId, list); }
	const result: Array<{ node: WorkflowNode; depth: number }> = [], seen = new Set<string>();
	function visit(n: WorkflowNode, depth: number) { if (seen.has(n.id)) return; seen.add(n.id); result.push({ node: n, depth }); if (query || !collapsed.has(n.id)) for (const child of children.get(n.id) ?? []) visit(child, depth + 1); }
	for (const root of nodes.filter(n => !n.parentId || !ids.has(n.parentId))) visit(root, 0);
	return result;
}
export function knowledgeRecords(view: ConsoleView) { return (view.knowledge?.records ?? []).filter(r => (view.knowledgeKind === undefined || view.knowledgeKind === "全部" || view.knowledgeKind === r.kind) && (!view.query || `${r.id} ${r.title} ${r.body}`.toLocaleLowerCase().includes(view.query.toLocaleLowerCase()))); }
export function wrappedLines(lines: string[], width: number): string[] { return lines.flatMap(line => String(line).split(/\r?\n/).flatMap(part => wrap(part, Math.max(1, width)))); }
function tone(n: WorkflowNode): Tone { return n.status === "running" ? "cyan" : ["accepted", "completed"].includes(n.status) ? "green" : ["failed", "rejected"].includes(n.status) ? "red" : ["waiting", "suspended", "returned", "blocked"].includes(n.status) ? "yellow" : "dim"; }
function marker(n: WorkflowNode): string { return ["accepted", "completed"].includes(n.status) ? "✓" : n.status === "running" ? "●" : ["failed", "rejected"].includes(n.status) ? "×" : "·"; }
export function hitTest(frame: ConsoleFrame, x: number, y: number): HitTarget | undefined { return frame.targets.findLast(t => x >= t.x && x < t.x + t.width && y >= t.y && y < t.y + t.height); }

interface TreeLine extends Line { id: string; first: boolean; toggle?: number; stateAt?: number; stateText?: string; stateTone?: Tone }
function selectedTone(tone: Tone): Tone { return tone === "green" ? "selectedGreen" : tone === "red" ? "selectedRed" : tone === "yellow" ? "selectedYellow" : "selectedDim"; }
function knowledgeAvailabilityLabel(value: string | undefined): string {
	switch (value) {
		case "usable_conditionally": return "有条件可用";
		case "exploratory_only": return "仅供探索";
		case "needs_recheck": return "需复查";
		case "not_allowed": return "不可使用";
		case "unrecorded": return "当前未发布";
		default: return "实时状态未核";
	}
}
function knowledgeTone(availability: string | undefined): Tone {
	return availability === "usable_conditionally" ? "green" : availability === "not_allowed" ? "red" :
		availability === "needs_recheck" || availability === "exploratory_only" ? "yellow" : "dim";
}
function identityInTree(n: WorkflowNode): string { return n.kind === "run" ? `${n.stage ?? "工作流"} 阶段运行` : n.kind === "session" ? n.label || "会话" : nodeIdentity(n); }
function readingLines(raw: string[], width: number, overview = false): Line[] {
	return raw.flatMap(line => line.split(/\r?\n/).flatMap(text => {
		const tone: Tone = /^(?:节点：|任务标题：|目标标题：|#{1,3} |正文：|限制明细：|完整记录元数据：)/.test(text) ? "heading"
			: overview && /^(?:阶段：|运行：|会话：|开始：|结束：|最近心跳：)/.test(text) ? "dim"
			: /^本记录直接限制：/.test(text) && !text.endsWith("无") ? "yellow" : "plain";
		return wrap(text.replace(/\t/g, "    "), width).map(text => ({ text, tone }));
	}));
}

/** Bounded chrome, scrollable content, and hit regions built from the same layout. */
export function renderFrame(view: ConsoleView, width: number, height: number, color = true): ConsoleFrame {
	width = Math.max(1, Math.floor(width)); height = Math.max(1, Math.floor(height));
	const frame: ConsoleFrame = { lines: [], targets: [], detailRows: 1, detailLines: 0, readerRows: 1, readerLines: 0, popupRows: 1, popupLines: 0, popupOffset: 0 };
	if (width < 36 || height < 16) { frame.lines = Array.from({ length: height }, (_, i) => pad(wrappedLines(["请放大终端至 36 列 × 16 行；q 离开"], width)[i] ?? "", width)); return frame; }
	const screen = new Screen(width, height), snap = view.snapshot, compact = width < 86 || height < 24, knowledge = view.mode === "knowledge";
	const hit = (action: HitTarget["action"], x: number, y: number, w: number, h = 1, value?: string) => {
		if (x >= 0 && y >= 0 && w > 0 && h > 0 && x + w <= width && y + h <= height) frame.targets.push({ action, x, y, width: w, height: h, value });
	};
	const scrollbar = (x: number, y: number, h: number, total: number, shown: number, offset: number, action?: HitTarget["action"], ids?: string[]) => {
		if (total <= shown || h < 2) return;
		const thumb = Math.max(1, Math.floor(h * shown / total)), max = Math.max(1, total - shown), top = Math.round((h - thumb) * Math.min(max, offset) / max);
		for (let i = 0; i < h; i++) { screen.write(x, y + i, i >= top && i < top + thumb ? "┃" : "│", i >= top && i < top + thumb ? "cyan" : "border"); const to = Math.round(i * (ids ? ids.length - 1 : max) / (h - 1)); if (action) hit(action, x, y + i, 1, 1, ids ? ids[to] : String(to)); }
	};
	const buttons = (items: { text: string; action: HitTarget["action"]; value?: string; active?: boolean; tone?: Tone }[], startY: number) => {
		let x = 1, y = startY;
		for (const item of items) { const w = textWidth(item.text); if (x + w > width - 1) { x = 1; y++; } screen.write(x, y, item.text, item.active ? "selected" : item.tone ?? "dim"); hit(item.action, x, y, w, 1, item.value); x += w + 1; }
		return y + 1;
	};
	const fallbackDetails: string[] = [];
	let y = 0;
	screen.write(1, y++, compact ? "MUL-PIS · 算子优化" : "MUL-PIS  /  算子优化工作流", "heading");
	const connection = view.connected ? `● 已连接 · ${view.mainState ?? "Pi 主会话"}` : "○ 历史浏览 · 未连接宿主";
	const connectionText = textWidth(connection) <= width - 2 ? connection : "● 已连接 · l 查看运行信息";
	screen.write(1, y++, connectionText, view.connected ? "green" : "dim");
	if (!compact) { const text = "[w 工作区] [? 帮助]", x = width - textWidth(text) - 1; screen.write(x, 0, text, "dim"); hit("key", x, 0, 10, 1, "w"); hit("key", x + 11, 0, 8, 1, "?"); y++; }
	y = buttons(Array.from({ length: 10 }, (_, i) => {
		const stage = `M0${i + 1}`, n = snap?.nodes.find(n => n.kind === "stage" && n.stage === stage);
		return { text: i === 9 ? compact ? "[知识]" : "[k 知识库]" : compact ? `[${stage}]` : `[${n ? marker(n) : "·"} ${stage} ${STAGE_LABELS[i]}]`, action: i === 9 ? "knowledge" as const : "stage" as const, value: stage, active: i === 9 ? knowledge : !knowledge && snap?.currentStage === stage };
	}), y);
	const workspace = snap?.workspace.label ?? view.workspaceLabel ?? "未选择工作区";
	const subtitle = knowledge ? `${workspace} / 知识快照 ${view.knowledge?.snapshotId ?? "尚未载入"}${view.knowledgeCurrent ? " · CURRENT" : ""}  [s 快照]`
		: `${workspace} / ${snap?.currentStage ?? "工作流"}  ${snap?.currentRunId ?? "暂无运行记录"}  [b 运行]`;
	if (textWidth(subtitle) <= width - 2) screen.write(1, y, subtitle, "purple");
	else { screen.write(1, y, knowledge ? `知识快照 ${view.knowledge?.snapshotId ?? "无"} · s 切换` : `${snap?.currentStage ?? "工作流"} · b 运行 · l 工作区`, "purple"); fallbackDetails.push(`工作区：${workspace}`, ...(!knowledge ? [`运行：${snap?.currentRunId ?? "暂无运行记录"}`] : [])); }
	hit(knowledge ? "snapshots" : "runs", 1, y++, width - 2);
	if (knowledge) {
		const names: Record<string, string> = { C: "认识", K: "判据", E: "依据", J: "论证", Q: "质疑", D: "决定", X: "情境" };
		y = buttons(KNOWLEDGE_KINDS.map(kind => ({ text: `[${kind === "全部" && compact ? "全" : kind}${!compact && names[kind] ? ` ${names[kind]}` : ""}]`, action: "kind", value: kind, active: (view.knowledgeKind ?? "全部") === kind })), y);
	} else if (!compact) {
		const nodes = snap?.nodes.filter(n => n.kind !== "stage") ?? [], tasks = nodes.filter(n => n.kind === "task"), sessions = nodes.filter(n => n.kind === "session");
		const pieces = tasks.length ? [`任务 ${tasks.length}`, `执行中 ${tasks.filter(n => n.status === "running").length}`, `待审查 ${tasks.filter(n => n.status === "returned").length}`, `已接受 ${tasks.filter(n => n.status === "accepted").length}`] : [`会话 ${sessions.length}`, `活动 ${sessions.filter(n => n.status === "running").length}`, `登记成果 ${nodes.filter(n => n.kind === "run").reduce((sum, n) => sum + new Set(n.artifactRefs.map(r => r.path)).size, 0)}`];
		screen.write(1, y++, pieces.join("   ·   "), "dim");
	}
	if (view.query && !compact) screen.write(1, y++, "筛选已开启 · / 修改 · Esc 清除 · l 查看条件", "yellow");
	const footerRows = compact ? 3 : 4, bottom = height - footerRows, bodyY = y, bodyH = bottom - bodyY;
	const single = width < 86, treeW = single ? width : Math.min(58, Math.max(30, Math.floor(width * .34))), detailX = single ? 0 : treeW + 1, detailW = single ? width : width - detailX;
	if (bodyH >= 4) {
		if (!single || view.focus === "tree") {
			const contentWidth = treeW - 4, rows: TreeLine[] = [], selectedId = knowledge ? view.knowledgeSelectedId : view.selectedId;
			const append = (id: string, identity: string, state: string, stateTone: Tone, prefix = "", expandable = "") => {
				const selected = id === selectedId, lead = selected ? "› " : "  ", label = `${lead}${prefix}${expandable}${identity}`, full = `${label}  ${state}`, baseTone: Tone = selected ? "selected" : "plain";
				if (textWidth(full) <= contentWidth) rows.push({ id, text: full, first: true, tone: baseTone, ...(expandable ? { toggle: textWidth(lead + prefix) } : {}), stateAt: textWidth(label) + 2, stateText: state, stateTone: selected ? selectedTone(stateTone) : stateTone });
				else { const wrapped = wrappedLines([label], contentWidth); wrapped.forEach((text, i) => rows.push({ id, text, first: i === 0, tone: baseTone, ...(i === 0 && expandable ? { toggle: textWidth(lead + prefix) } : {}) })); rows.push({ id, text: `${lead}${state}`, first: false, tone: selected ? selectedTone(stateTone) : stateTone }); }
			};
			let count = 0;
			if (knowledge) {
				if (view.knowledgeKind === "限制") { append("limits", "现行限制", `${view.knowledge?.limits.filter(l => !l.liftedAt).length ?? 0} 生效`, "yellow"); count = 1; }
				else { const records = knowledgeRecords(view); count = records.length; for (const r of records) append(r.id, `${r.id} @${r.version}`,
					`${knowledgeStatusLabel(r.status)} · ${knowledgeAvailabilityLabel(r.availability?.availability)}`, knowledgeTone(r.availability?.availability)); }
			} else {
				const visible = visibleNodes(snap, view.collapsed, view.query), children = new Set(snap?.nodes.map(n => n.parentId)), last: boolean[] = [];
				count = visible.length;
				visible.forEach(({ node, depth }, i) => {
					let isLast = true; for (let j = i + 1; j < visible.length; j++) { if (visible[j].depth < depth) break; if (visible[j].depth === depth) { isLast = false; break; } }
					const prefix = depth ? last.slice(1, depth).map(end => end ? "   " : "│  ").join("") + (isLast ? "└─ " : "├─ ") : "";
					last[depth] = isLast; last.length = depth + 1;
					append(node.id, identityInTree(node), `${marker(node)} ${statusLabel(node)}`, tone(node), prefix, children.has(node.id) ? view.collapsed.has(node.id) ? "▸ " : "▾ " : "");
				});
			}
			const available = bodyH - 3, selected = Math.max(0, rows.findIndex(r => r.id === selectedId));
			let from = Math.max(0, Math.min(selected - Math.floor(available / 3), rows.length - available));
			while (from > 0 && !rows[from].first && selected - (from - 1) < available) from--;
			const shown: Line[] = rows.slice(from, from + available);
			if (!rows.length) shown.push({ text: view.query ? "没有匹配记录 · Esc 清除筛选" : knowledge ? "此分类暂无记录" : "该阶段尚无记录", tone: "dim" });
			while (shown.length < available) shown.push({ text: "" });
			const ordinal = [...new Set(rows.map(r => r.id))].indexOf(selectedId ?? "") + 1;
			shown.push({ text: `${ordinal > 0 ? `${ordinal} / ` : ""}${count} ${knowledge ? "条记录" : "个节点"}  ↑↓ 选择`, tone: "dim" });
			screen.box(0, bodyY, treeW, bodyH, `${knowledge ? "知识目录" : "调度结构"}${view.focus === "tree" ? " · 选择" : ""}`, shown, view.focus === "tree" ? "cyan" : "border");
			hit("tree", 0, bodyY, treeW, bodyH);
			rows.slice(from, from + available).forEach((row, index) => { const y = bodyY + 1 + index; if (row.stateText) screen.write(2 + row.stateAt!, y, row.stateText, row.stateTone); hit(knowledge ? "knowledge-record" : "node", 1, y, treeW - 2, 1, row.id); if (row.toggle !== undefined && row.toggle < contentWidth) hit("node-toggle", 2 + row.toggle, y, 1, 1, row.id); });
			scrollbar(treeW - 1, bodyY + 1, available, rows.length, available, from, knowledge ? "knowledge-record" : "node", rows.map(r => r.id));
		}
		if (!single || view.focus === "detail") {
			const body = [...view.preview, ...(fallbackDetails.length ? ["", ...fallbackDetails] : [])], lines = readingLines(body, detailW - 4, !knowledge), available = bodyH - (knowledge ? 3 : 4);
			frame.detailRows = Math.max(1, available); frame.detailLines = lines.length;
			const offset = Math.max(0, Math.min(view.previewOffset, Math.max(0, lines.length - frame.detailRows))), shown = lines.slice(offset, offset + frame.detailRows);
			while (shown.length < frame.detailRows) shown.push({ text: "" });
			shown.push({ text: `${lines.length ? offset + 1 : 0}–${Math.min(offset + frame.detailRows, lines.length)} / ${lines.length} 行   滚轮阅读`, tone: "dim" });
			if (!knowledge) shown.push({ text: "[v 完整记录 / 正文成果]", tone: "cyan" });
			screen.box(detailX, bodyY, detailW, bodyH, `${knowledge ? "知识内容" : "概况"}${view.focus === "detail" ? " · 阅读" : ""}`, shown, view.focus === "detail" ? "cyan" : "border");
			hit("detail", detailX, bodyY, detailW, bodyH);
			if (!knowledge) hit("documents", detailX + 1, bodyY + bodyH - 2, detailW - 2);
			scrollbar(detailX + detailW - 1, bodyY + 1, frame.detailRows, lines.length, frame.detailRows, offset, "detail-scroll");
		}
	} else { screen.write(1, Math.min(bodyY, bottom - 1), "放大终端可显示内容 · v 全文", "yellow"); }
	const message = view.lastError ?? view.notice ?? (knowledge ? view.knowledge?.warnings[0] : snap?.warnings[0]);
	const prompt = message ? textWidth(message) <= width - 4 && !/[\r\n]/.test(message) ? `${view.lastError ? "!" : "·"} ${message}` : `${view.lastError ? "! 操作未完成" : "! 有提示"} · l 阅读完整信息` : view.query ? "筛选中 · / 修改 · Esc 清除" : compact ? "Tab 换栏 · / 搜索 · ? 帮助" : "↑↓ 选择   Enter 展开   Tab 换栏   / 搜索   l 完整消息";
	screen.write(1, bottom, prompt, message ? view.lastError ? "red" : "yellow" : "dim"); hit("key", 1, bottom, width - 2, 1, "l");
	if (view.input) { const lines = wrappedLines([`${view.input.label} > ${view.input.text}▏`], width - 2), available = compact ? 1 : 2; lines.slice(-available).forEach((text, i) => screen.write(1, bottom + 1 + i, text, "cyan")); }
	else {
		const keys = compact ? [{ text: "[i 指令]", value: "i" }, { text: "[: 命令]", value: ":" }, { text: "[o 输出]", value: "o" }] : [{ text: "[i 发送指令]", value: "i" }, { text: "[: 控制命令]", value: ":" }, { text: "[o 主会话输出]", value: "o" }, { text: "[/ 搜索]", value: "/" }];
		buttons(keys.map(k => ({ ...k, action: "key" as const })), bottom + 1);
	}
	const controls = view.input ? compact ? "^V 全文 · Enter 发送 · Esc 取消" : "Ctrl+V 预览全文   Enter 发送   Esc 取消输入" : compact ? "p 暂停/继续  x 控制  q 离开" : "p 暂停/继续   x 中断/停止   q 离开界面（宿主继续）";
	screen.write(1, height - 1, controls, "dim");
	if (view.reading) {
		frame.targets = [];
		const readerY = 2, h = height - 3, readerW = Math.min(width, 116), readerX = Math.floor((width - readerW) / 2);
		for (let row = readerY; row < height; row++) screen.write(0, row, " ".repeat(width));
		const lines = readingLines([view.reading.title, "", ...view.reading.lines], readerW - 4);
		frame.readerRows = h - 4; frame.readerLines = lines.length;
		const offset = Math.max(0, Math.min(view.reading.offset, Math.max(0, lines.length - frame.readerRows))), content = lines.slice(offset, offset + frame.readerRows);
		while (content.length < frame.readerRows) content.push({ text: "" });
		const segment = view.reading.pageLabel ? `${/文件段 \d+/.exec(view.reading.pageLabel)?.[0] ?? ""} · ${view.reading.hasNext ? "PgDn 下一段" : "末段"}` : "";
		content.push({ text: `${offset + 1}–${Math.min(lines.length, offset + frame.readerRows)} / ${lines.length} 行  ${segment}`, tone: "dim" }, { text: "↑↓ 滚动 · PgUp/PgDn 翻页 · [Esc 返回]", tone: "cyan" });
		screen.box(readerX, readerY, readerW, h, "全文阅读", content, "cyan");
		hit("reader", readerX, readerY, readerW, h); hit("reader-close", readerX + 1, readerY + h - 2, readerW - 2);
		scrollbar(readerX + readerW - 1, readerY + 1, frame.readerRows, lines.length, frame.readerRows, offset, "reader-scroll");
	}
	if (view.popup) {
		frame.targets = [];
		const pw = Math.min(width - 4, 104), ph = height - 4, px = Math.floor((width - pw) / 2), py = 2;
		const rows: Array<{ text: string; index?: number; tone?: Tone }> = [...wrappedLines([view.popup.title], pw - 4).map(text => ({ text, tone: "heading" as Tone })), { text: "" }, ...view.popup.lines.flatMap((text, index) => wrappedLines([`${index === view.popup!.selected ? "› " : "  "}${text}`], pw - 4).map(text => ({ text, index })))];
		const available = ph - 3; frame.popupRows = available; frame.popupLines = rows.length;
		const selected = view.popup.selected === undefined ? undefined : rows.findIndex(r => r.index === view.popup!.selected);
		let offset = Math.max(0, Math.min(view.popup.offset ?? 0, Math.max(0, rows.length - available)));
		if (selected !== undefined && view.popup.offset === undefined) { if (selected >= offset + available) offset = Math.min(selected, Math.max(0, rows.length - available)); }
		frame.popupOffset = offset;
		for (let row = py; row < py + ph; row++) screen.write(px, row, " ".repeat(pw));
		const visible = rows.slice(offset, offset + available), content: Line[] = visible.map(r => ({ text: r.text, tone: r.index !== undefined && r.index === view.popup!.selected ? "selected" : r.tone }));
		while (content.length < available) content.push({ text: "" });
		content.push({ text: pw < 60 ? "↑↓ 选择 · Enter 确定 · Esc 返回" : "↑↓ 选择 / 滚动   PgUp/PgDn 翻页   Enter 确定   Esc 返回", tone: "dim" });
		screen.box(px, py, pw, ph, "选择 / 查看", content, "cyan");
		visible.forEach((r, i) => { if (r.index !== undefined) hit("popup", px + 1, py + 1 + i, pw - 2, 1, String(r.index)); });
		scrollbar(px + pw - 1, py + 1, available, rows.length, available, offset, "popup-scroll");
	}
	frame.lines = screen.lines(color); return frame;
}
export function renderConsole(view: ConsoleView, width: number, height: number, color = true): string[] { return renderFrame(view, width, height, color).lines; }
