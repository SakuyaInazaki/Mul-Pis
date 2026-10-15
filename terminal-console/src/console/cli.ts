#!/usr/bin/env node
import { nodeOverview } from "./overview.ts";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { runConsoleApp } from "./app.ts";
import { listConsoles, sendConsoleRequest, startConsole } from "./client.ts";
import { WorkflowReader, type ReadOptions } from "./read-model.ts";
import { defaultCollapsed, renderConsole, type ConsoleView } from "./render.ts";
import type { ConsoleCommand, ConsoleRecord } from "./protocol.ts";
import type { ConsoleWorkflowAction } from "../pi/console-bridge.ts";

export const HELP = `MUL-PIS 工作流终端控制台

  npm run console -- [--workspace DIR]       打开工作区选择器/交互界面
  npm run console -- --workspace DIR --once  输出一次真实工作流状态
  npm run console -- status --workspace DIR --json
  npm run console -- start --workspace DIR --model PROVIDER/MODEL --prompt-file FILE
  npm run console -- attach --workspace DIR [--instance ID]
  npm run console -- send --workspace DIR --message-file FILE [--delivery prompt|steer|follow_up]
  npm run console -- workflow --workspace DIR --action-file FILE
  npm run console -- pause|resume|abort|stop --workspace DIR
  npm run console -- recover --workspace DIR --goal ID --old-descriptor FILE --model PROVIDER/MODEL

  --detach             启动后返回，独立宿主继续运行
  --goal ID            选择 M07 目标
  --stage M01…M09      选择阶段
  --run ID             选择阶段运行
  --root DIR           工作区选择器的项目根目录
  --width N --height N 单次文本视图大小（默认 120 × 40）
  --json               status 的结构化只读快照（包含工作区内部路径）

界面：点击或 1–9 切阶段，k 知识库，v 完整正文，滚轮 / PgUp PgDn 滚动，
      ↑↓ 选择，Enter 展开，Tab 换栏，←→ 切阶段，o 主会话输出，
      i 发送指令，: 控制命令，p 暂停/继续，x 中断/停止，q 离开，? 帮助。
退出界面不终止宿主；abort / stop 操作会影响正在执行的研究。
角色模型沿用工作区配置；启动主会话必须显式指定模型。
`;

const BOOL = new Set(["help", "once", "json", "detach"]);
const VALUE = new Set(["workspace", "root", "instance", "goal", "stage", "run", "width", "height", "model", "prompt-file", "message-file", "delivery", "action-file", "old-descriptor"]);
const COMMANDS = new Set(["open", "status", "start", "attach", "send", "workflow", "pause", "resume", "abort", "stop", "recover"]);
export function parseConsoleArgs(argv: string[]): { command: string; flags: Map<string, string> } {
	let command = "open", positional = false; const flags = new Map<string, string>();
	for (let i = 0; i < argv.length; i++) {
		const token = argv[i];
		if (token === "-h") { flags.set("help", "true"); continue; }
		if (!token.startsWith("--")) { if (positional || !COMMANDS.has(token)) throw new Error(`未知命令：${token}`); command = token; positional = true; continue; }
		const equal = token.indexOf("="), name = token.slice(2, equal < 0 ? undefined : equal);
		if (flags.has(name)) throw new Error(`重复选项：--${name}`);
		if (BOOL.has(name)) { if (equal >= 0) throw new Error(`--${name} 不接受值`); flags.set(name, "true"); }
		else if (VALUE.has(name)) { const value = equal < 0 ? argv[++i] : token.slice(equal + 1); if (!value || value.startsWith("--")) throw new Error(`--${name} 缺少值`); flags.set(name, value); }
		else throw new Error(`未知选项：--${name}`);
	}
	if (flags.has("stage") && !/^M0[1-9]$/.test(flags.get("stage")!)) throw new Error("--stage 必须是 M01–M09");
	if (flags.has("run") && !flags.has("stage")) throw new Error("--run 必须同时指定 --stage");
	if (flags.has("goal") && (flags.has("stage") || flags.has("run"))) throw new Error("--goal 与 --stage/--run 不可混用");
	for (const key of ["goal", "run"]) if (flags.has(key) && !/^[A-Za-z0-9_-]+$/.test(flags.get(key)!)) throw new Error(`--${key} 不是有效运行 ID`);
	for (const key of ["width", "height"]) if (flags.has(key) && !/^[1-9]\d{0,3}$/.test(flags.get(key)!)) throw new Error(`--${key} 必须是正整数`);
	if ((flags.has("once") || flags.has("json")) && !["open", "status"].includes(command)) throw new Error("--once / --json 仅用于查看状态");
	return { command, flags };
}
async function boundedText(file: string): Promise<string> {
	if ((await stat(file)).size > 128 * 1024) throw new Error("输入文件超过 128 KiB，请提交更小的指令或动作");
	return readFile(file, "utf8");
}
async function pickRecord(workspace: string, instance?: string): Promise<ConsoleRecord> {
	const records = await listConsoles(workspace);
	const matches = instance ? records.filter(r => r.instanceId.startsWith(instance)) : records.filter(r => r.state === "running");
	if (matches.length !== 1) throw new Error(matches.length ? "多个宿主匹配，请指定 --instance" : "没有可连接宿主，请先 start 或选择有效 --instance");
	return matches[0];
}
export async function main(argv = process.argv.slice(2)): Promise<void> {
	const { command, flags: f } = parseConsoleArgs(argv);
	if (f.has("help")) { process.stdout.write(HELP); return; }
	const interactive = process.stdin.isTTY && process.stdout.isTTY;
	const workspace = f.has("workspace") ? await realpath(f.get("workspace")!) : undefined;
	const read: ReadOptions = { goalRunId: f.get("goal"), stage: f.get("stage"), runId: f.get("run") };
	if (command === "open" && !f.has("once") && !f.has("json")) { await runConsoleApp({ workspace, root: f.get("root"), read }); return; }
	if (!workspace) throw new Error("此命令需要 --workspace DIR");
	if (!(await stat(path.join(workspace, "research.config.json"))).isFile()) throw new Error("指定目录不是已配置的工作流工作区");
	if (command === "status" || f.has("once") || f.has("json")) {
		const reader = new WorkflowReader(workspace), snapshot = await reader.read(read);
		if (f.has("json")) { process.stdout.write(JSON.stringify(snapshot, null, 2) + "\n"); return; }
		const selectedId = snapshot.nodes.find(n => n.kind === "run")?.id;
		const view: ConsoleView = { snapshot, selectedId, collapsed: defaultCollapsed(snapshot), preview: nodeOverview(snapshot, snapshot.nodes.find(n => n.id === selectedId)), previewOffset: 0, focus: "tree", connected: false, hostLabel: "只读工作区快照", recent: [] };
		process.stdout.write(renderConsole(view, Number(f.get("width") ?? 120), Number(f.get("height") ?? 40), false).join("\n") + "\n"); return;
	}
	let record: ConsoleRecord;
	if (command === "start" || command === "recover") {
		const model = f.get("model"); if (!model) throw new Error("启动主会话必须显式指定 --model PROVIDER/MODEL");
		if (command === "start" && !f.get("prompt-file")) throw new Error("start 需要 --prompt-file FILE 指定初始任务");
		if (command === "recover" && (!f.get("goal") || !f.get("old-descriptor"))) throw new Error("recover 需要 --goal ID --old-descriptor FILE");
		if (command === "start" && (f.has("goal") || f.has("old-descriptor"))) throw new Error("已有目标请使用 recover；start 创建新的主会话");
		record = await startConsole({ workspace, piArgs: ["--model", model], ...(command === "start" ? { prompt: await boundedText(f.get("prompt-file")!) } : { goalRunId: f.get("goal")!, oldDescriptorFile: path.resolve(f.get("old-descriptor")!), recover: true }) });
		if (!interactive || f.has("detach")) { process.stdout.write(`宿主已启动：${record.instanceId}\n重新连接：npm run console -- attach --workspace ${JSON.stringify(workspace)} --instance ${record.instanceId}\n`); return; }
		await runConsoleApp({ workspace, record, read }); return;
	}
	record = await pickRecord(workspace, f.get("instance"));
	if (command === "attach") { await runConsoleApp({ workspace, record, read }); return; }
	const observed = await sendConsoleRequest(record, { command: "status" });
	if (!observed.ok) throw new Error(observed.error ?? "无法核验当前宿主绑定");
	const current = observed.data as { record?: ConsoleRecord };
	if (!current.record) throw new Error("宿主没有返回当前绑定");
	record = current.record;
	let control = command as ConsoleCommand;
	let extra: { message?: string; action?: ConsoleWorkflowAction } = {};
	if (command === "send") {
		if (!f.has("message-file")) throw new Error("send 需要 --message-file FILE");
		const delivery = f.get("delivery") ?? "prompt"; if (!["prompt", "steer", "follow_up"].includes(delivery)) throw new Error("--delivery 必须是 prompt、steer 或 follow_up");
		control = delivery as ConsoleCommand; extra.message = await boundedText(f.get("message-file")!);
	}
	if (command === "workflow") { if (!f.has("action-file")) throw new Error("workflow 需要 --action-file FILE"); extra.action = JSON.parse(await boundedText(f.get("action-file")!)); }
	const result = await sendConsoleRequest(record, { command: control, goalRunId: record.goalRunId, attemptId: record.attemptId, ...extra });
	if (!result.ok) throw new Error(result.error ?? "控制请求失败");
	process.stdout.write(JSON.stringify(result, null, 2) + "\n");
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) void main().catch(error => { process.stderr.write(`console: ${String(error.message).replace(/[\x00-\x1f\x7f]/g, " ")}\n`); process.exitCode = 1; });
