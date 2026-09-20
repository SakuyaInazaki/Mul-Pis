#!/usr/bin/env node
/**
 * Research harness CLI.
 *
 *   node src/cli.ts <command> [options]
 *
 * Commands
 *   init                         prepare a workspace (references/, knowledge store, dirs); never writes the config
 *   m01                          独立初始认识
 *   m02 [--m01 <runId>]          候选判据首次准备（与 M01 相同模型的新会话）
 *   m03 [--m01 <runId>] [--m02 <runId>]
 *                                自动跨会话质询：评审出题 → M01 原会话作答 → 同一评审会话评价
 *   m04 --from M03|M06 [--run <runId>] | --feedback <file> [--label <text>] [--fresh]
 *                                纠错与知识状态更新（首轮续接 M01，其后新建研究会话）
 *   m05 [--goal <text> | --goal-file <file>] [--no-browser]
 *                                外部知识获取：检索、开放版本、抓取、下载、PDF 提取、初筛、登记来源
 *   m06 [--source S001 ...] [--full-text] [--requirements <file>]
 *                                每份资料三会话组；整批汇总后交 M04
 *   status                       runs, snapshot, limits
 *   knowledge pack --purpose <text> [--ids C001,K002] [--terms a,b]
 *   knowledge views              regenerate derived views
 *
 * Global options: --workspace <dir> (default: cwd), --runner pi|fake (default pi).
 * The fake runner is for dry runs and tests; it echoes a fixed reply and never calls a model.
 */
import path from "node:path";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createFileKnowledgeStore } from "./knowledge/store.ts";
import { FakeSessionRunner } from "./runner/fake.ts";
import type { SessionRunner } from "./runner/types.ts";
import type { StageContext } from "./stages/context.ts";
import { CONFIG_TEMPLATE, runInit } from "./stages/init.ts";
import { runM01 } from "./stages/m01.ts";
import { runM02 } from "./stages/m02.ts";
import { runM03 } from "./stages/m03.ts";
import { runM04, type M04Feedback } from "./stages/m04.ts";
import { runM05 } from "./stages/m05.ts";
import { runM06 } from "./stages/m06.ts";
import { HarnessError } from "./types.ts";
import { Workspace } from "./workspace.ts";

interface ParsedArgs {
	positional: string[];
	flags: Map<string, string[]>;
}

function parseArgs(argv: string[]): ParsedArgs {
	const positional: string[] = [];
	const flags = new Map<string, string[]>();
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg.startsWith("--")) {
			const name = arg.slice(2);
			const next = argv[i + 1];
			if (next !== undefined && !next.startsWith("--")) {
				flags.set(name, [...(flags.get(name) ?? []), next]);
				i++;
			} else {
				flags.set(name, [...(flags.get(name) ?? []), "true"]);
			}
		} else {
			positional.push(arg);
		}
	}
	return { positional, flags };
}

function flag(args: ParsedArgs, name: string): string | undefined {
	return args.flags.get(name)?.at(-1);
}

function has(args: ParsedArgs, name: string): boolean {
	return args.flags.has(name);
}

async function makeRunner(kind: string): Promise<SessionRunner> {
	if (kind === "fake") {
		return new FakeSessionRunner(({ spec, turnIndex }) => ({
			text:
				spec.role === "reviewer" && turnIndex === 1
					? `（fake runner）${spec.label} 出题演练，没有调用模型。\n\n# 可转发问题\n\n问1（fake）：请说明关键假设。\n\n# 出题说明与判断依据\n\n本段是演练用的出题依据占位文本，不应出现在作答会话中。`
					: `（fake runner）${spec.label} 收到第 ${turnIndex} 条消息，没有调用模型；本文只是演练占位回复。`,
			reads: spec.tools.kind === "read-dir" ? ["source.md"] : [],
		}));
	}
	const mod = await import("./runner/pi.ts");
	return mod.createPiSessionRunner();
}

function usage(): string {
	return `用法：node src/cli.ts <init|m01|m02|m03|m04|m05|m06|status|knowledge> [选项]\n  --workspace <dir>   工作区（默认当前目录）\n  --runner pi|fake    会话运行器（默认 pi）\n详见 src/cli.ts 顶部说明。`;
}

export async function main(argv: string[]): Promise<number> {
	const args = parseArgs(argv);
	const command = args.positional[0];
	if (!command || command === "help" || has(args, "help")) {
		console.log(usage());
		return 0;
	}
	const ws = new Workspace(flag(args, "workspace") ?? process.cwd());
	const store = createFileKnowledgeStore(ws.knowledgeDir);

	if (command === "init") {
		const result = await runInit(ws, store);
		console.log(`已初始化 ${ws.root}`);
		console.log(`新建：${result.created.join("、") || "无"}`);
		console.log(`保留：${result.kept.join("、") || "无"}`);
		if (result.configMissing) {
			console.log(`\n缺少 ${path.basename(ws.configFile)}。请按下面模板创建并填入你选择的模型（harness 不预设模型）：\n${CONFIG_TEMPLATE}`);
		}
		return 0;
	}

	const config = await ws.loadConfig();
	const runner = await makeRunner(flag(args, "runner") ?? "pi");
	const ctx: StageContext = { ws, runner, store, config };

	switch (command) {
		case "m01": {
			const r = await runM01(ctx);
			console.log(`M01 完成：运行 ${r.record.runId}\n产物：${r.record.outputs.map((o) => o.path).join("\n")}`);
			return 0;
		}
		case "m02": {
			const r = await runM02(ctx, { m01RunId: flag(args, "m01") });
			console.log(`M02 完成：运行 ${r.record.runId}${r.snapshotId ? `，候选判据已入库（快照 ${r.snapshotId}）` : ""}`);
			printFailures(r.record.failures);
			return 0;
		}
		case "m03": {
			const r = await runM03(ctx, { m01RunId: flag(args, "m01"), m02RunId: flag(args, "m02") });
			console.log(`M03 完成：运行 ${r.record.runId}\n产物：${r.record.outputs.map((o) => o.path).join("\n")}`);
			return 0;
		}
		case "m04": {
			let feedback: M04Feedback;
			const from = flag(args, "from");
			const file = flag(args, "feedback");
			if (from === "M03" || from === "M06") feedback = { kind: from, runId: flag(args, "run") };
			else if (file) feedback = { kind: "file", label: flag(args, "label") ?? path.basename(file), path: path.resolve(file) };
			else throw new HarnessError("cli.m04", "m04 需要 --from M03|M06 或 --feedback <file>");
			const r = await runM04(ctx, { feedback, freshSession: has(args, "fresh") });
			console.log(`M04 完成：运行 ${r.record.runId}（${r.mode}）${r.snapshotId ? `，已合入快照 ${r.snapshotId}` : "，无知识变化入库"}`);
			printFailures(r.record.failures);
			return 0;
		}
		case "m05": {
			const goalFile = flag(args, "goal-file");
			const goal = goalFile ? await readFile(path.resolve(goalFile), "utf8") : flag(args, "goal");
			const r = await runM05(ctx, { goal, noBrowser: has(args, "no-browser") });
			console.log(`M05 完成：运行 ${r.record.runId}，登记来源 ${r.registered.length ? r.registered.join("、") : "无"}，工具调用 ${r.toolLog.length} 次\n报告：${r.record.outputs.find((o) => o.label === "获取报告")?.path}`);
			printFailures(r.record.failures);
			return 0;
		}
		case "m06": {
			const requirementsFile = flag(args, "requirements");
			const requirements = requirementsFile ? await readFile(path.resolve(requirementsFile), "utf8") : undefined;
			const r = await runM06(ctx, { sources: args.flags.get("source"), fullText: has(args, "full-text"), requirements });
			console.log(`M06 完成：运行 ${r.record.runId}，${r.groups.length} 组，失败 ${r.groups.filter((g) => g.status === "failed").length} 组\n整批汇总：${r.summaryPath}\n下一步：node src/cli.ts m04 --from M06`);
			printFailures(r.record.failures);
			return 0;
		}
		case "status": {
			const snapshot = await store.current();
			const limits = (await store.limits()).filter((l) => !l.liftedAt);
			console.log(`工作区：${ws.root}\n知识快照：${snapshot?.id ?? "无"}（记录 ${snapshot?.records.length ?? 0} 条）\n生效限制：${limits.length}`);
			for (const stage of ["M01", "M02", "M03", "M04", "M05", "M06"]) {
				const runs = await ws.listRuns(stage);
				const latest = runs.length ? await ws.readRun(stage, runs[runs.length - 1]) : undefined;
				console.log(`${stage}：${runs.length} 次${latest ? `，最近 ${latest.runId} ${latest.status}` : ""}`);
			}
			return 0;
		}
		case "knowledge": {
			const sub = args.positional[1];
			if (sub === "pack") {
				const pack = await store.buildPack({ purpose: flag(args, "purpose") ?? "手动查看", ids: flag(args, "ids")?.split(","), terms: flag(args, "terms")?.split(","), includeOpenQuestions: true, maxChars: 60_000 });
				console.log(pack.markdown);
				return 0;
			}
			if (sub === "views") {
				await store.regenerateViews();
				console.log("已重新生成派生视图");
				return 0;
			}
			throw new HarnessError("cli.knowledge", "knowledge 子命令：pack | views");
		}
		default:
			console.log(usage());
			return 2;
	}
}

function printFailures(failures: string[]): void {
	for (const f of failures) console.log(`失败/限制：${f}`);
}

const invokedDirectly = Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
	main(process.argv.slice(2)).then(
		(code) => process.exit(code),
		(error) => {
			if (error instanceof HarnessError) console.error(`错误 [${error.code}]：${error.message}`);
			else console.error(error);
			process.exit(1);
		},
	);
}
