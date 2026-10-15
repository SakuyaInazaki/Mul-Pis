import { readFile } from "node:fs/promises";
import path from "node:path";
import { WorkflowReader, discoverWorkflowWorkspaces, type ReadOptions } from "./read-model.ts";
import { listConsoles, sendConsoleRequest, startConsole } from "./client.ts";
import type { ConsoleCommand, ConsoleEvent, ConsoleRecord } from "./protocol.ts";
import { defaultCollapsed, renderFrame, hitTest, visibleNodes, knowledgeRecords, type ConsoleFrame, type ConsoleView } from "./render.ts";
import { nodeOverview, nodeDetails } from "./overview.ts";
import { WorkflowKnowledgeReader } from "./knowledge.ts";
import { VisibleSessionReader } from "./session-output.ts";
import { DocumentReader, type DocumentPage } from "./documents.ts";
import { parseMouse } from "./input.ts";
import { safeText } from "./terminal.ts";

const object = (value: unknown): Record<string, any> => value && typeof value === "object" ? value as Record<string, any> : {};
const HELP = [
	"鼠标点击 M01–M09 或知识库；数字 1–9 切阶段，k 打开知识库",
	"Tab 切换树/概况；↑↓ 选择或滚动；Enter 展开；←→ 切阶段",
	"滚轮 / PgUp / PgDn 阅读完整内容；Home / End 到开头/末尾",
	"v 打开完整任务说明、检查或已登记正文 / 成果；Esc 返回",
	"/ 搜索节点或知识",
	"l 查看完整提示与控制回执；r 刷新当前页面",
	"知识库内 s 选择快照，t 切分类；鼠标也可点击分类",
	"1–9 查看 M01–M09；[ ] 切换该阶段运行；a 回到当前运行",
	"w 选择工作区；h 选择宿主；i 输入任务（忙时排入下一轮）",
	"o 打开主会话完整可见回复；Esc 返回概况",
	"p 暂停/继续 Pi 进程；x 中断/停止；q 离开，研究继续",
	"", ":start provider/model    创建工作流主会话，随后输入初始任务",
	":stage M01              在同一宿主执行指定工作流阶段",
	":workflow /path.json    提交 stage / checkpoint / plan / decision 动作",
	":checkpoint             冻结当前目标的反馈 checkpoint",
	":steer 指令              下一个可接收边界引导",
	":continue 指令           解除语义等待并继续同一目标",
	":condition /回执.json | 指令   提交等待条件证据并继续",
	":wait /条件.json         空闲时进入有明确恢复条件的等待",
	":recover 目标ID 旧attempt 模型    在新 Pi 进程恢复目标",
	":pause  :resume  :abort  :stop  :help",
	"输入时 Ctrl+V 预览待发送全文，Esc 返回继续编辑。",
	"Esc 关闭菜单或取消输入。所有回执与实际任务结果分别显示。",
];

export async function runConsoleApp(options: { workspace?: string; root?: string; record?: ConsoleRecord; read?: ReadOptions }): Promise<void> {
	if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("交互控制台需要终端；请使用 console status 或 --once");
	let reader: WorkflowReader | undefined, workspace = options.workspace, record = options.record;
	let knowledgeReader: WorkflowKnowledgeReader | undefined, documentReader: DocumentReader | undefined;
	let knowledgeSnapshotId: string | undefined, knowledgeRevision = 0, lastKnowledgePoll = 0, navigationRevision = 0, refreshAgain = false;
	let readingMode: "document" | "main" | undefined, documentState: { file: string; title: string; offsets: number[]; index: number; page?: DocumentPage } | undefined;
	let lastFrame: ConsoleFrame | undefined;
	let readOptions = options.read ?? {}, eventCursor = 0, lastHostPoll = 0, closing = false, refreshing = false, commandBusy = false;
	let mainBusy = false, followOutput = false, outputTail = "", lastLines: string[] = [], paste = false, pasteBuffer = "", pasteOverflow = false, inputMode = "message", startModel = "", keyBuffer = "";
	let escapeTimer: ReturnType<typeof setTimeout> | undefined;
	let connectionError: string | undefined;
	let popupAction: ((index: number) => void | Promise<void>) | undefined;
	const view: ConsoleView = { collapsed: new Set(), preview: [], previewOffset: 0, mode: "workflow", focus: "tree", connected: false, hostLabel: "未连接运行宿主", recent: [] };
	const log = (text: string) => { view.recent.push(`${new Date().toLocaleTimeString("zh-CN", { hour12: false })}  ${safeText(text)}`); view.recent = view.recent.slice(-80); };
	const draw = () => {
		if (closing) return;
		if (followOutput && readingMode === "main" && view.reading) view.reading.offset = Number.MAX_SAFE_INTEGER;
		lastFrame = renderFrame(view, process.stdout.columns || 100, process.stdout.rows || 32, !process.env.NO_COLOR);
		const lines = lastFrame.lines;
		let out = "";
		if (lastLines.length !== lines.length) out += "\x1b[2J";
		lines.forEach((line, i) => { if (line !== lastLines[i]) out += `\x1b[${i + 1};1H${line}\x1b[K`; });
		if (out) process.stdout.write(out);
		lastLines = lines;
	};
	const openPopup = (title: string, lines: string[], action?: (index: number) => void | Promise<void>) => { view.popup = { title, lines, ...(action ? { selected: 0 } : {}) }; popupAction = action; draw(); };
	const closePopup = () => { view.popup = undefined; popupAction = undefined; lastLines = []; };
	async function preview() {
		if (view.mode === "knowledge") {
			if (view.knowledgeKind === "限制") {
				view.preview = ["现行限制与解除记录", "历史快照不会撤销现行限制。", "", ...(view.knowledge?.limits ?? []).flatMap((l, i) => [`${i + 1}. ${l.target} · ${l.kind}${l.liftedAt ? "（已解除）" : "（生效）"}`, `原因：${l.reason}`, `依据：${l.authority}`, `生效于：${l.since}`, ...(l.liftedAt ? [`解除于：${l.liftedAt}`, `解除原因：${l.liftReason ?? "未记录"}`] : []), ""])];
			} else {
				const records = knowledgeRecords(view);
				if (!records.some(r => r.id === view.knowledgeSelectedId)) view.knowledgeSelectedId = records[0]?.id;
				const selected = records.find(r => r.id === view.knowledgeSelectedId);
				view.preview = selected?.lines ?? ["此分类或筛选条件下没有记录", ...(view.knowledge?.warnings ?? [])];
			}
		} else view.preview = view.snapshot ? nodeOverview(view.snapshot, view.snapshot.nodes.find(n => n.id === view.selectedId)) : ["请选择工作区"];
		if (readingMode === "main" && view.reading) view.reading.lines = (outputTail || "尚未收到可见输出。").split(/\r?\n/);
	}
	async function loadKnowledge(snapshotId?: string) {
		if (!knowledgeReader) throw new Error("请先选择工作区");
		lastKnowledgePoll = Date.now();
		const revision = ++knowledgeRevision, source = knowledgeReader;
		const knowledge = await source.read(snapshotId);
		if (source !== knowledgeReader || revision !== knowledgeRevision) return;
		view.knowledge = knowledge; view.knowledgeCurrent = snapshotId === undefined; knowledgeSnapshotId = snapshotId; await preview(); draw();
	}
	async function selectStage(stage: string) {
		view.mode = "workflow"; view.reading = undefined; readingMode = undefined; documentState = undefined; view.query = undefined;
		readOptions = { stage }; navigationRevision++; view.selectedId = undefined; view.previewOffset = 0; view.focus = "tree";
		await refresh();
	}
	async function showKnowledge() {
		view.mode = "knowledge"; view.reading = undefined; readingMode = undefined; documentState = undefined; navigationRevision++; view.query = undefined; view.previewOffset = 0; view.focus = "tree";
		if (!view.knowledge) await loadKnowledge(); else await preview();
	}
	async function chooseSnapshot() {
		if (!view.knowledge) await loadKnowledge();
		const snapshots = [...(view.knowledge?.snapshots ?? [])].reverse();
		openPopup("知识快照 · 选择后只读浏览", ["跟随 CURRENT 当前快照", ...snapshots.map(s => `${s.id}  ${s.createdAt ?? ""}`)], async i => { closePopup(); view.previewOffset = 0; await loadKnowledge(i ? snapshots[i - 1].id : undefined); });
	}
	async function chooseRun() {
		const runs = [...(view.snapshot?.runs.filter(r => r.stage === view.snapshot?.currentStage) ?? [])].reverse();
		if (!runs.length) { view.notice = "该阶段没有运行记录"; return; }
		openPopup("选择阶段运行", runs.map(r => `${r.runId}  ${r.status}  ${r.startedAt}`), async i => { closePopup(); readOptions = { stage: runs[i].stage, runId: runs[i].runId }; navigationRevision++; view.selectedId = undefined; view.previewOffset = 0; await refresh(); });
	}
	async function loadDocument(index: number) {
		if (!documentState || !documentReader) return;
		const state = documentState, page = await documentReader.read(state.file, state.offsets[index]);
		if (state !== documentState) return;
		state.page = page; state.index = index;
		if (page.nextOffset !== undefined) state.offsets[index + 1] = page.nextOffset;
		readingMode = "document";
		view.reading = { title: state.title, lines: page.text.split(/\r?\n/), offset: 0, pageLabel: `文件段 ${index + 1}${page.nextOffset !== undefined ? " · 后续可继续翻页" : " · 已到文件末段"}`, hasNext: page.nextOffset !== undefined, hasPrevious: index > 0 };
	}
	async function chooseDocument() {
		const snapshot = view.snapshot, node = snapshot?.nodes.find(n => n.id === view.selectedId);
		if (!snapshot || !node) { view.notice = "请先选择有记录的节点"; return; }
		const refs = [...new Map([...(node.outputRefs ?? []), ...(node.artifactRefs ?? [])].map(r => [r.path, r])).values()];
		openPopup("完整记录与正文成果 · 点击或 Enter 阅读", ["节点完整记录（任务说明、检查明细与文件清单）", ...refs.map(r => `${r.label}\n${r.path}`)], async i => {
			closePopup();
			if (i === 0) { readingMode = undefined; view.reading = { title: "节点完整记录", lines: nodeDetails(snapshot, node), offset: 0 }; return; }
			const ref = refs[i - 1];
			if (node.kind === "session" && /\.jsonl$/i.test(ref.path) && workspace) {
				const revision = navigationRevision, source = workspace;
				const messages = await new VisibleSessionReader(source).read(ref.path);
				if (revision !== navigationRevision || source !== workspace) return;
				readingMode = undefined; view.reading = { title: `${ref.label}\n${ref.path}`, lines: messages.length ? messages.flatMap((text, index) => [`──── 可见消息 ${index + 1} ────`, text, ""]) : ["尚无可见的 assistant / tool 输出"], offset: 0 }; return;
			}
			documentState = { file: ref.path, title: `${ref.label}\n${ref.path}`, offsets: [0], index: 0 }; await loadDocument(0);
		});
	}

	async function scroll(delta: number, paging = false) {
		followOutput = false;
		if (view.reading) {
			const max = Math.max(0, (lastFrame?.readerLines ?? 0) - (lastFrame?.readerRows ?? 1));
			view.reading.offset = Math.min(max, view.reading.offset);
			if (paging && delta > 0 && view.reading.offset >= max && view.reading.hasNext && documentState) await loadDocument(documentState.index + 1);
			else if (paging && delta < 0 && view.reading.offset === 0 && view.reading.hasPrevious && documentState) { await loadDocument(documentState.index - 1); draw(); view.reading.offset = Math.max(0, (lastFrame?.readerLines ?? 0) - (lastFrame?.readerRows ?? 1)); }
			else view.reading.offset = Math.max(0, Math.min(max, view.reading.offset + delta));
		} else view.previewOffset = Math.max(0, Math.min(Math.max(0, (lastFrame?.detailLines ?? 0) - (lastFrame?.detailRows ?? 1)), view.previewOffset + delta));
	}
	async function selectRow(delta: number) {
		if (view.mode === "knowledge") { const records = knowledgeRecords(view), i = records.findIndex(r => r.id === view.knowledgeSelectedId); view.knowledgeSelectedId = records[Math.max(0, Math.min(records.length - 1, i + delta))]?.id; }
		else { const rows = visibleNodes(view.snapshot, view.collapsed, view.query), i = rows.findIndex(r => r.node.id === view.selectedId); view.selectedId = rows[Math.max(0, Math.min(rows.length - 1, i + delta))]?.node.id; }
		view.previewOffset = 0; await preview();
	}
	function consumeEvent(event: ConsoleEvent) {
		const e = object(event.value);
		if (e.type === "message_start" && object(e.message).role === "assistant") outputTail = "";
		if (e.type === "agent_start") { mainBusy = true; view.mainState = "执行中"; }
		if (e.type === "agent_end") { mainBusy = false; view.mainState = "本轮已结束"; log("主会话本轮结束；目标状态以控制记录为准"); }
		if (e.type === "tool_execution_start") { view.mainState = `调用 ${safeText(e.toolName)}`; log(`工具开始：${e.toolName}`); }
		if (e.type === "tool_execution_end") log(`工具${e.isError ? "失败" : "返回"}：${e.toolName}`);
		if (e.type === "message_update") {
			const delta = object(e.assistantMessageEvent);
			if (delta.type === "text_delta" && typeof delta.delta === "string") { outputTail += delta.delta; }
		}
		if (e.type === "message_end") {
			const m = object(e.message);
			if (m.role === "assistant") {
				if (m.model) view.mainModel = `${m.provider ? m.provider + "/" : ""}${m.model}`;
				const text = (Array.isArray(m.content) ? m.content : []).filter((x: any) => x.type === "text").map((x: any) => x.text).join("\n");
				if (text) { outputTail = text; log("主会话回复已更新；按 o 阅读可见全文"); }
			}
		}
		if (e.type === "workflow-result") {
			const r = object(e.result); log(r.ok ? `工作流动作完成：${JSON.stringify(r.data)}` : `工作流动作失败：${r.error}`);
			view.notice = r.ok ? "工作流动作已完成，查看节点结果" : undefined;
			if (!r.ok) view.lastError = `工作流动作失败：${safeText(r.error)}`;
		}
		if (e.type === "initial-prompt-error" || e.type === "pi-error") { view.notice = undefined; view.lastError = `宿主：${safeText(e.error ?? e.text ?? e.message)}`; log(view.lastError); }
		if (e.type === "pi-stderr") log(`宿主：${e.text ?? e.message}`);
		if (e.type === "pi-exit") { view.mainState = "进程已退出"; log(`Pi 退出：${e.code ?? e.signal}`); }
	}
	async function refresh() {
		if (closing) return; if (refreshing) { refreshAgain = true; return; } refreshing = true;
		const revision = navigationRevision;
		try {
			if (reader) {
				const source = reader, snapshot = await source.read({ ...readOptions });
				if (revision !== navigationRevision || source !== reader) { refreshAgain = true; return; }
				view.snapshot = snapshot;
				if (!view.selectedId || !view.snapshot.nodes.some(n => n.id === view.selectedId)) {
					view.selectedId = view.snapshot.nodes.find(n => n.status === "running" && n.kind === "task")?.id ?? view.snapshot.nodes.find(n => n.kind === "run")?.id;
					view.collapsed = defaultCollapsed(view.snapshot);
				}
				await preview();
			}
			if (view.mode === "knowledge" && Date.now() - lastKnowledgePoll >= 5_000) await loadKnowledge(knowledgeSnapshotId);
			if (record && Date.now() - lastHostPoll >= 3_000) {
				const polledRecord = record, polledWorkspace = workspace;
				const stillCurrent = () => workspace === polledWorkspace && record?.instanceId === polledRecord.instanceId;
				lastHostPoll = Date.now();
				try {
					const status = await sendConsoleRequest(polledRecord, { command: "status" }); if (!stillCurrent()) return; if (!status.ok) throw new Error(status.error);
					const data = object(status.data); record = object(data.record) as ConsoleRecord;
					if (connectionError && view.lastError === connectionError) view.lastError = undefined;
					connectionError = undefined;
					view.connected = record.state === "running"; view.hostState = object(object(data.control).storedDeclaration).state;
					view.controlTarget = `${record.goalRunId ?? record.instanceId} / ${record.attemptId ?? "未绑定"}`;
					mainBusy = Boolean(data.busy);
					view.hostLabel = `宿主 ${record.instanceId} · ${record.state}`;
					const ev = await sendConsoleRequest(record, { command: "events", since: eventCursor });
					if (!stillCurrent()) return;
					const e = object(ev.data);
					if (e.oldestEvent > eventCursor + 1) log("观测事件有缺口；已重新读取持久状态");
					for (const entry of e.events ?? []) { consumeEvent(entry); eventCursor = entry.sequence; }
					eventCursor = e.nextCursor ?? eventCursor;
					if (view.hostState === "paused") view.mainState = "进程已暂停";
					else if (record.state === "running") {
						const stateResponse = await sendConsoleRequest(record, { command: "get_state" });
						if (!stillCurrent()) return;
						const state = object(object(stateResponse.data).data);
						mainBusy = mainBusy || Boolean(state.isStreaming || state.isCompacting);
						if (state.model) view.mainModel = `${state.model.provider}/${state.model.id}`;
						view.mainState = mainBusy ? "执行中" : "等待指令";
					}
					if (readingMode === "main") await preview();
					if (record.state === "exited" || record.state === "error") { view.mainState = record.state === "exited" ? "进程已退出" : "宿主出错"; view.controlTarget = undefined; record = undefined; }
				} catch (error) { if (!stillCurrent()) return; view.connected = false; view.hostLabel = "宿主连接中断"; connectionError = safeText((error as Error).message); view.lastError = connectionError; }
			}
		} catch (error) { view.lastError = safeText((error as Error).message); }
		finally { refreshing = false; draw(); if (refreshAgain && !closing) { refreshAgain = false; void refresh(); } }
	}
	async function request(command: ConsoleCommand, extra: Record<string, unknown> = {}) {
		if (!record) throw new Error("当前工作区没有连接的宿主；使用 :start provider/model 启动");
		const result = await sendConsoleRequest(record, { command, ...(record.goalRunId ? { goalRunId: record.goalRunId } : {}), ...(record.attemptId ? { attemptId: record.attemptId } : {}), ...extra });
		if (!result.ok) throw new Error(result.error ?? "控制请求被拒绝");
		view.lastError = undefined;
		log(`${command}：${result.accepted ? "宿主已接收，等待实际结果" : "已执行"}`);
		lastHostPoll = 0; await refresh(); return result;
	}
	async function chooseHost() {
		if (!workspace) return;
		const records = await listConsoles(workspace);
		if (!records.length) { view.notice = "没有登记的运行宿主，使用 :start provider/model"; return; }
		openPopup("连接运行宿主", records.map(r => `${r.instanceId} · ${r.state} · ${r.startedAt}`), async index => { record = records[index]; eventCursor = 0; lastHostPoll = 0; outputTail = ""; view.mainModel = undefined; view.mainState = undefined; view.notice = undefined; view.lastError = undefined; closePopup(); await refresh(); });
	}
	async function selectWorkspace(root: string) {
		workspace = root; reader = new WorkflowReader(root); knowledgeReader = new WorkflowKnowledgeReader(root); documentReader = new DocumentReader(root); navigationRevision++; knowledgeRevision++; knowledgeSnapshotId = undefined; view.mode = "workflow"; view.knowledgeKind = undefined; view.knowledge = undefined; view.knowledgeSelectedId = undefined; view.query = undefined; view.workspaceLabel = path.basename(root); readOptions = {}; view.selectedId = undefined; view.collapsed.clear();
		view.reading = undefined; readingMode = undefined; documentState = undefined; view.mainState = undefined; view.mainModel = undefined; view.hostState = undefined; view.controlTarget = undefined; view.notice = undefined; outputTail = ""; mainBusy = false; view.hostLabel = "未连接运行宿主";
		view.previewOffset = 0; view.recent = []; record = (await listConsoles(root)).find(r => r.state === "running"); lastHostPoll = 0; eventCursor = 0; view.connected = false; view.lastError = undefined;
		await refresh();
	}
	async function chooseWorkspace() {
		const workspaces = await discoverWorkflowWorkspaces(options.root ?? process.cwd());
		if (!workspaces.length) { openPopup("没有工作流工作区", ["使用 --workspace 指定已有 research.config.json 的工作区。", "Esc 返回；q 离开。"]); return; }
		openPopup("选择工作流工作区", workspaces.map(w => path.basename(w)), async i => { closePopup(); await selectWorkspace(workspaces[i]); });
	}
	function appendInput(text: string) {
		if (!view.input) return;
		const next = view.input.text + safeText(text);
		if (next.length > 32_000) { view.lastError = "输入超过 32000 字符，本次输入未加入；较长内容请通过文件提交。"; return; }
		view.input.text = next;
	}
	function input(mode: string, label: string, text = "") { inputMode = mode; view.input = { label, text }; view.lastError = undefined; draw(); }
	async function doCommand(text: string) {
		const [cmd, ...parts] = text.trim().replace(/^:/, "").split(/\s+/); const rest = parts.join(" ");
		if (["help", "?", ""].includes(cmd)) { openPopup("工作流控制台 · 帮助", HELP); return; }
		if (cmd === "start") { if (!rest) throw new Error("用法：:start provider/model"); startModel = rest; input("start", `初始任务 · ${rest}`); return; }
		if (cmd === "recover") {
			if (parts.length !== 3 || !workspace || !/^[A-Za-z0-9_-]+$/.test(parts[0])) throw new Error("用法：:recover <目标ID> <旧attempt> <provider/model>");
			const [goalRunId, attemptId, model] = parts;
			const goal = object(JSON.parse(await readFile(path.join(workspace, "stages", "M07", goalRunId, "goal.json"), "utf8")));
			const old = object((goal.executionState?.attempts ?? []).find((a: any) => a.id === attemptId));
			if (goal.executionState?.activeAttemptId !== attemptId || !old.runDescriptor?.controlDir) throw new Error("旧 attempt 不匹配或缺少受信描述文件");
			record = await startConsole({ workspace, goalRunId, recover: true, oldDescriptorFile: path.join(old.runDescriptor.controlDir, "run-descriptor.json"), piArgs: ["--model", model] });
			lastHostPoll = 0; log("已启动新恢复宿主；等待控制器核验"); return;
		}
		if (cmd === "knowledge") { await showKnowledge(); return; }
		if (cmd === "hosts") { await chooseHost(); return; }
		if (cmd === "stage") { if (!/^M0[12356]$/i.test(rest)) throw new Error("裸阶段仅支持 M01/M02/M03/M05/M06；M04/M08/M09 需要 :workflow 文件.json；M07 通过主会话建立目标"); await request("workflow", { action: { kind: "stage", request: { stage: rest.toUpperCase() } } }); return; }
		if (cmd === "workflow") { await request("workflow", { action: JSON.parse(await readFile(path.resolve(rest), "utf8")) }); return; }
		if (cmd === "checkpoint") { if (!record?.goalRunId) throw new Error("当前宿主尚未绑定目标"); await request("workflow", { action: { kind: "checkpoint", runId: record.goalRunId } }); return; }
		if (cmd === "steer") { await request("steer", { message: rest }); return; }
		if (cmd === "continue") { await request("resume_goal", { message: rest }); return; }
		if (cmd === "condition") { const separator = rest.indexOf("|"); if (separator < 1) throw new Error("用法：:condition /回执.json | 后续指令"); await request("resume_condition", { evidencePath: path.resolve(rest.slice(0, separator).trim()), message: rest.slice(separator + 1).trim() }); return; }
		if (cmd === "wait") { if (!record?.goalRunId) throw new Error("当前宿主尚未绑定目标"); const condition = JSON.parse(await readFile(path.resolve(rest), "utf8")); await request("prompt", { message: `[[wait-goal:${record.goalRunId}]] ${JSON.stringify(condition)}` }); return; }
		if (cmd === "pause" || cmd === "resume") { await request(cmd); return; }
		if (cmd === "abort" || cmd === "stop") { openPopup(cmd === "abort" ? "中断当前轮" : "停止当前运行", [`目标：${record?.goalRunId ?? record?.instanceId ?? "未连接"}`, cmd === "abort" ? "当前 M07 尝试可能被挂起，未决操作保留。" : "向核验后的 Pi 进程组发送停止信号。", "执行", "返回"], async i => { closePopup(); if (i === 2) await request(cmd); }); view.popup!.selected = 2; return; }
		throw new Error(`未知命令 ${cmd}；:help 查看帮助`);
	}
	async function submit() {
		if (!view.input || commandBusy) return;
		const text = view.input.text.trim(); view.input = undefined;
		if (inputMode === "search") { view.query = text || undefined; view.previewOffset = 0; await selectRow(0); return; }
		if (!text) return;
		commandBusy = true; view.notice = "正在提交…"; draw();
		try {
			if (inputMode === "command") await doCommand(text);
			else if (inputMode === "start") {
				if (!workspace) throw new Error("请先选择工作区");
				record = await startConsole({ workspace, prompt: text, piArgs: ["--model", startModel] }); lastHostPoll = 0; log("工作流主会话已启动");
			} else {
				await request(mainBusy ? "follow_up" : "prompt", { message: text });
			}
			view.notice = "已提交；控制回执与结果将在界面更新";
		} catch (error) { view.lastError = safeText((error as Error).message); }
		finally { commandBusy = false; await refresh(); draw(); }
	}
	let finish!: () => void;
	const finished = new Promise<void>(resolve => { finish = resolve; });
	const leave = () => { closing = true; finish(); };
	async function key(data: string) {
		const mouse = parseMouse(data);
		if (mouse) {
			if (mouse.release || (view.input && !view.popup) || !lastFrame) return;
			const target = hitTest(lastFrame, mouse.x, mouse.y);
			if (mouse.wheel) {
				if (view.popup) {
					if (popupAction) { view.popup.selected = Math.max(0, Math.min(view.popup.lines.length - 1, (view.popup.selected ?? 0) + mouse.wheel)); view.popup.offset = undefined; }
					else view.popup.offset = Math.max(0, Math.min(Math.max(0, lastFrame.popupLines - lastFrame.popupRows), lastFrame.popupOffset + mouse.wheel * 3));
				} else if (view.reading || target?.action === "detail" || target?.action === "documents" || target?.action === "detail-scroll" || target?.action === "reader-scroll") { view.focus = "detail"; await scroll(mouse.wheel * 3); }
				else if (target?.action === "tree" || target?.action === "node" || target?.action === "node-toggle" || target?.action === "knowledge-record") { view.focus = "tree"; await selectRow(mouse.wheel); }
				return;
			}
			if (!mouse.left || !target) return;
			if (target.action === "key") { await key(target.value!); return; }
			if (target.action === "detail-scroll") { view.focus = "detail"; view.previewOffset = Number(target.value); return; }
			if (target.action === "reader-scroll" && view.reading) { followOutput = false; view.reading.offset = Number(target.value); return; }
			if (target.action === "popup-scroll" && view.popup) { view.popup.offset = Number(target.value); return; }
			if (target.action === "popup") { if (popupAction) await popupAction(Number(target.value)); return; }
			if (target.action === "reader-close") { view.reading = undefined; readingMode = undefined; return; }
			if (target.action === "reader") return;
			if (target.action === "stage") await selectStage(target.value!);
			else if (target.action === "knowledge") await showKnowledge();
			else if (target.action === "runs") await chooseRun();
			else if (target.action === "snapshots") await chooseSnapshot();
			else if (target.action === "documents") await chooseDocument();
			else if (target.action === "kind") { view.knowledgeKind = target.value; view.previewOffset = 0; await preview(); }
			else if (target.action === "node-toggle") { view.selectedId = target.value; view.focus = "tree"; if (view.collapsed.has(target.value!)) view.collapsed.delete(target.value!); else view.collapsed.add(target.value!); view.previewOffset = 0; await preview(); }
			else if (target.action === "node") { view.focus = "tree"; view.selectedId = target.value; view.previewOffset = 0; await preview(); }
			else if (target.action === "knowledge-record") { view.focus = "tree"; view.knowledgeSelectedId = target.value; view.previewOffset = 0; await preview(); }
			else if (target.action === "tree" || target.action === "detail") view.focus = target.action;
			return;
		}
		if (data === "\x03") { if (view.popup) closePopup(); else if (view.input) view.input = undefined; else if (view.reading) { view.reading = undefined; readingMode = undefined; } else leave(); return; }
		const up = data === "\x1b[A", down = data === "\x1b[B", pageUp = data === "\x1b[5~", pageDown = data === "\x1b[6~";
		const home = data === "\x1b[H" || data === "\x1b[1~", end = data === "\x1b[F" || data === "\x1b[4~";
		if (view.popup) {
			if (data === "\x1b" || data === "q") closePopup();
			else if (up || down) {
				if (popupAction) { view.popup.selected = Math.max(0, Math.min(view.popup.lines.length - 1, (view.popup.selected ?? 0) + (up ? -1 : 1))); view.popup.offset = undefined; }
				else view.popup.offset = Math.max(0, Math.min(Math.max(0, (lastFrame?.popupLines ?? 0) - (lastFrame?.popupRows ?? 1)), (lastFrame?.popupOffset ?? 0) + (up ? -1 : 1)));
			} else if (pageUp || pageDown) view.popup.offset = Math.max(0, Math.min(Math.max(0, (lastFrame?.popupLines ?? 0) - (lastFrame?.popupRows ?? 1)), (lastFrame?.popupOffset ?? 0) + (pageUp ? -1 : 1) * (lastFrame?.popupRows ?? 8)));
			else if (home || end) {
				if (popupAction) { view.popup.selected = home ? 0 : view.popup.lines.length - 1; view.popup.offset = undefined; }
				else view.popup.offset = home ? 0 : Number.MAX_SAFE_INTEGER;
			} else if (data === "\r" && popupAction) await popupAction(view.popup.selected ?? 0);
			return;
		}
		if (view.input) {
			if (data === "\x16") { openPopup("待发送内容 · 尚未提交", [view.input.label, "", view.input.text]); return; }
			if (data === "\x1b") view.input = undefined;
			else if (data === "\r") await submit();
			else if (data === "\x7f" || data === "\b") view.input.text = [...view.input.text].slice(0, -1).join("");
			else if (data === "\x15") view.input.text = "";
			else if (!data.includes("\x1b")) appendInput(data);
			return;
		}
		if (view.reading) {
			if (data === "\x1b" || data === "q" || data === "o") { view.reading = undefined; readingMode = undefined; }
			else if (up || down || pageUp || pageDown) await scroll((up || pageUp ? -1 : 1) * (pageUp || pageDown ? lastFrame?.readerRows ?? 8 : 1), pageUp || pageDown);
			else if (home || end) { followOutput = false; view.reading.offset = home ? 0 : Math.max(0, (lastFrame?.readerLines ?? 0) - (lastFrame?.readerRows ?? 1)); }
			else if (data === "f" && readingMode === "main") { followOutput = !followOutput; }
			return;
		}
		if (data === "q") { leave(); return; }
		if (data === "?") { openPopup("工作流控制台 · 帮助", HELP); return; }
		if (data === "l") { view.reading = { title: "完整提示与最近控制回执", lines: [`工作区：${workspace ?? "尚未选择"}`, `搜索条件：${view.query ?? "无"}`, `宿主：${view.hostLabel}`, `主会话：${view.mainState ?? "未连接"}`, `模型：${view.mainModel ?? "未记录"}`, `控制目标：${view.controlTarget ?? "未连接"}`, "", view.lastError ?? "", view.notice ?? "", ...(view.snapshot?.warnings ?? []), ...(view.knowledge?.warnings ?? []), "", ...view.recent], offset: 0 }; readingMode = undefined; return; }
		if (data === "w") { await chooseWorkspace(); return; }
		if (data === "h") { await chooseHost(); return; }
		if (data === "o") { readingMode = "main"; view.reading = { title: "Pi 主会话 · 当前可见回复", lines: [], offset: 0 }; followOutput = true; await preview(); return; }
		if (data === "k") { await showKnowledge(); return; }
		if (data === "v" && view.mode !== "knowledge") { await chooseDocument(); return; }
		if (data === "b" && view.mode !== "knowledge") { await chooseRun(); return; }
		if (data === "s" && view.mode === "knowledge") { await chooseSnapshot(); return; }
		if (data === "/") { input("search", "搜索 · Enter 应用，Esc 取消", view.query ?? ""); return; }
		if (data === "\x1b" && view.query) { view.query = undefined; await selectRow(0); return; }
		if (data === "i") { view.notice = `指令接收：${view.controlTarget ?? "未连接宿主"}；所选历史节点不改变指令目标`; input("message", mainBusy ? "主会话 · 下一轮" : "主会话指令"); return; }
		if (data === ":") { input("command", "控制命令"); return; }
		if (data === "p") { await request(view.hostState === "paused" ? "resume" : "pause"); return; }
		if (data === "x") { openPopup("运行控制", ["中断当前轮（M07 可能挂起）", "停止 Pi 运行", "返回"], async i => { closePopup(); if (i < 2) await doCommand(i === 0 ? "abort" : "stop"); }); return; }
		if (data === "\t") view.focus = view.focus === "tree" ? "detail" : "tree";
		if ((data === "t" && view.mode === "knowledge") || data === "\x1b[C" || data === "\x1b[D") {
			const delta = data === "\x1b[D" ? -1 : 1;
			if (view.mode === "knowledge") { const kinds = ["全部", "C", "K", "E", "J", "Q", "D", "X", "限制"], i = kinds.indexOf(view.knowledgeKind ?? "全部"); view.knowledgeKind = kinds[(i + delta + kinds.length) % kinds.length]; view.previewOffset = 0; await preview(); }
			else await selectStage(`M0${(Number(view.snapshot?.currentStage?.slice(1) ?? 1) - 1 + delta + 9) % 9 + 1}`);
		}
		if (pageUp || pageDown) { view.focus = "detail"; await scroll((pageUp ? -1 : 1) * (lastFrame?.detailRows ?? 8)); }
		if (up || down) { if (view.focus === "detail") await scroll(up ? -1 : 1); else await selectRow(up ? -1 : 1); }
		if (home || end) {
			if (view.focus === "detail") view.previewOffset = home ? 0 : Math.max(0, (lastFrame?.detailLines ?? 0) - (lastFrame?.detailRows ?? 1));
			else await selectRow(home ? -Number.MAX_SAFE_INTEGER : Number.MAX_SAFE_INTEGER);
		}
		if (data === "\r") { if (view.mode === "knowledge") view.focus = "detail"; else if (view.selectedId) { if (view.collapsed.has(view.selectedId)) view.collapsed.delete(view.selectedId); else view.collapsed.add(view.selectedId); } }
		if (/^[1-9]$/.test(data)) await selectStage(`M0${data}`);
		if (data === "a") { view.mode = "workflow"; readOptions = {}; navigationRevision++; view.query = undefined; view.selectedId = undefined; view.previewOffset = 0; await refresh(); }
		if (data === "[" || data === "]") { const runs = view.snapshot?.runs.filter(r => r.stage === view.snapshot?.currentStage) ?? [], i = runs.findIndex(r => r.runId === view.snapshot?.selected?.runId); const r = runs[Math.max(0, Math.min(runs.length - 1, i + (data === "[" ? -1 : 1)))]; if (r) { readOptions = { stage: r.stage, runId: r.runId }; navigationRevision++; view.selectedId = undefined; view.previewOffset = 0; await refresh(); } }
		if (data === "r") { if (view.mode === "knowledge") await loadKnowledge(knowledgeSnapshotId); else await refresh(); }
	}
	const dispatchKey = (value: string) => { void key(value).catch(error => { view.lastError = safeText(error.message); }).finally(draw); };
	const onData = (chunk: string) => {
		clearTimeout(escapeTimer); keyBuffer += chunk;
		while (keyBuffer) {
			if (paste) {
				const end = keyBuffer.indexOf("\x1b[201~");
				if (end < 0) { if (keyBuffer.length > 6) { if (!pasteOverflow) { pasteBuffer += keyBuffer.slice(0, -6); if (pasteBuffer.length > 32_000) { pasteOverflow = true; pasteBuffer = ""; } } keyBuffer = keyBuffer.slice(-6); } return; }
				if (view.input) { if (pasteOverflow) view.lastError = "粘贴超过 32000 字符，整段粘贴未加入；请通过文件提交。"; else appendInput(pasteBuffer + keyBuffer.slice(0, end)); }
				paste = false; pasteBuffer = ""; pasteOverflow = false; keyBuffer = keyBuffer.slice(end + 6); draw(); continue;
			}
			if (keyBuffer.startsWith("\x1b[200~")) { paste = true; keyBuffer = keyBuffer.slice(6); continue; }
			if (keyBuffer[0] === "\x1b") {
				const sequence = /^\x1b\[[0-?]*[ -/]*[@-~]/.exec(keyBuffer)?.[0];
				if (sequence) { keyBuffer = keyBuffer.slice(sequence.length); dispatchKey(sequence); continue; }
				if (keyBuffer.length === 1 || /^\x1b\[[0-?]*$/.test(keyBuffer)) { escapeTimer = setTimeout(() => { const pending = keyBuffer; keyBuffer = ""; dispatchKey(pending); }, 60); return; }
				dispatchKey("\x1b"); keyBuffer = keyBuffer.slice(1); continue;
			}
			const next = String.fromCodePoint(keyBuffer.codePointAt(0)!); keyBuffer = keyBuffer.slice(next.length); dispatchKey(next);
		}
	};
	const resize = () => { lastLines = []; void preview().catch(error => { view.lastError = safeText(error.message); }).finally(draw); };
	const raw = process.stdin.isRaw;
	process.stdin.setRawMode(true); process.stdin.setEncoding("utf8"); process.stdin.resume();
	process.stdout.write("\x1b[?1049h\x1b[?25l\x1b[?2004h\x1b[?1000h\x1b[?1006h");
	process.stdin.on("data", onData); process.stdout.on("resize", resize); process.once("SIGINT", leave); process.once("SIGTERM", leave);
	const timer = setInterval(() => void refresh(), 1_500);
	try {
		if (workspace) { reader = new WorkflowReader(workspace); knowledgeReader = new WorkflowKnowledgeReader(workspace); documentReader = new DocumentReader(workspace); record ??= (await listConsoles(workspace)).find(r => r.state === "running"); await refresh(); }
		else { draw(); await chooseWorkspace(); }
		await finished;
	} finally {
		closing = true; clearInterval(timer); clearTimeout(escapeTimer); process.stdin.off("data", onData); process.stdout.off("resize", resize); process.off("SIGINT", leave); process.off("SIGTERM", leave);
		process.stdin.setRawMode(raw ?? false); process.stdin.pause(); process.stdout.write("\x1b[?1006l\x1b[?1000l\x1b[?2004l\x1b[?25h\x1b[?1049l");
	}
}
