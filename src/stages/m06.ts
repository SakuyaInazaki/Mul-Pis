/**
 * M06 阅读、核对与项目适用性.
 *
 * Boundary (foundation, M06 本轮已对齐 + 暂定批次规则): every material gets three
 * independent sessions run in order (read → check → applicability); different
 * materials may run in parallel; all applicability sessions receive the same
 * project state; the batch is handed to M04 only after every included group has
 * returned; failures are recorded with their actual scope and never dropped.
 * The reading and checking sessions only get a read-only tool rooted at the
 * material directory; the applicability session gets no tools.
 */
import { existsSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { buildM06ApplicabilityMessage, buildM06CheckMessage, buildM06ReadMessage, problemBlock, section, systemPromptFor } from "../prompts.ts";
import { renderPageTool } from "../tools/pagetool.ts";
import { HarnessError, type InputRef, type StageRunRecord } from "../types.ts";
import { readTextIfExists } from "../workspace.ts";
import { loadProblemMaterials, readOutput, recordSession, relPath, sessionSpec, withRun, type StageContext } from "./context.ts";

export interface M06Options {
	/** Source ids under references/sources (e.g. S001). Empty means every registered source. */
	sources?: string[];
	/** Reading requirements text handed to every reader (optional). */
	requirements?: string;
	/** Require complete reading of the whole material. */
	fullText?: boolean;
	purpose?: string;
}

export interface M06Group {
	sourceId: string;
	title: string;
	dir: string;
	status: "completed" | "failed";
	failure?: string;
	reading?: string;
	readCoverage: string[];
	/** PDF pages the reader/checker rendered and looked at, as `file#page`. */
	renderedPages: string[];
	check?: string;
	checkCoverage: string[];
	applicability?: string;
	outputs: Array<{ label: string; path: string }>;
}

export interface M06Result {
	record: StageRunRecord;
	groups: M06Group[];
	summaryPath: string;
}

async function discoverSources(ctx: StageContext, wanted?: string[]): Promise<Array<{ id: string; dir: string; title: string }>> {
	const root = path.join(ctx.ws.referencesDir, "sources");
	if (!existsSync(root)) throw new HarnessError("m06.sources", `没有资料目录 ${root}；请先登记来源（references/sources/S编号/source.md）`);
	const names = (await readdir(root)).filter((n) => /^S\d+/.test(n)).sort();
	const ids = wanted && wanted.length ? wanted : names;
	const sources: Array<{ id: string; dir: string; title: string }> = [];
	for (const id of ids) {
		const dir = path.join(root, id);
		if (!existsSync(dir) || !(await stat(dir)).isDirectory()) throw new HarnessError("m06.sources", `来源 ${id} 不存在：${dir}`);
		const sourceMd = await readTextIfExists(path.join(dir, "source.md"));
		if (!sourceMd) throw new HarnessError("m06.sources", `来源 ${id} 缺少 source.md，未登记的材料不进入阅读`);
		const heading = sourceMd.split(/\r?\n/).find((l) => l.startsWith("#"))?.replace(/^#+\s*/, "").trim();
		sources.push({ id, dir, title: heading || id });
	}
	if (!sources.length) throw new HarnessError("m06.sources", "没有可处理的来源");
	return sources;
}

async function buildProjectState(ctx: StageContext, materialsBlock: string, purpose: string): Promise<{ text: string; note: string }> {
	const pack = await ctx.store.buildPack({ purpose, includeOpenQuestions: true, types: ["C", "K", "Q", "X"], maxChars: 40_000 });
	let extra = "";
	if (!pack.included.length) {
		const m01 = await ctx.ws.latestCompletedRun("M01");
		const m02 = await ctx.ws.latestCompletedRun("M02");
		const parts: string[] = [];
		if (m01) parts.push(section("初始认识（尚未入库，M01 完整产出）", (await readOutput(m01, "初始认识")).text));
		if (m02) parts.push(section("候选判据（M02 完整产出）", (await readOutput(m02, "候选判据")).text));
		extra = parts.join("\n\n");
	}
	const text = [materialsBlock, pack.included.length ? section("当前知识状态（局部知识包）", pack.markdown) : "", extra].filter(Boolean).join("\n\n");
	return { text, note: pack.snapshot ? `知识快照 ${pack.snapshot}` : "知识库为空，使用 M01/M02 产出作为当前状态" };
}

export async function runM06(ctx: StageContext, options: M06Options = {}): Promise<M06Result> {
	const sources = await discoverSources(ctx, options.sources);
	const { materials, inputs: problemInputs } = await loadProblemMaterials(ctx.ws);
	const snapshot = await ctx.store.current();
	const inputs: InputRef[] = [...problemInputs, ...sources.map((s) => ({ label: `来源 ${s.id}`, path: s.dir }))];
	const record = await ctx.ws.startRun("M06", inputs, snapshot?.id);
	const purpose = options.purpose ?? "M06 项目适用性判断";

	return withRun(
		ctx,
		record,
		async () => {
			const state = await buildProjectState(ctx, problemBlock(materials), purpose);
			await ctx.ws.writeOutput(record, "project-state.md", state.text, "本批统一使用的当前项目状态");
			record.remarks.push(`适用性分析统一使用同一项目状态：${state.note}`);

			const groups: M06Group[] = sources.map((s) => ({ sourceId: s.id, title: s.title, dir: s.dir, status: "failed", readCoverage: [], renderedPages: [], checkCoverage: [], outputs: [] }));
			const limit = Math.max(1, ctx.config.concurrency);
			let next = 0;
			const worker = async (): Promise<void> => {
				while (next < groups.length) {
					const group = groups[next++];
					await processGroup(ctx, record, group, options, state.text);
				}
			};
			await Promise.all(Array.from({ length: Math.min(limit, groups.length) }, worker));

			const failed = groups.filter((g) => g.status === "failed");
			for (const g of failed) record.failures.push(`资料组 ${g.sourceId} 未完成：${g.failure}`);
			const summary = renderBatchSummary(ctx, groups);
			const summaryRef = await ctx.ws.writeOutput(record, "batch-summary.md", summary, "整批汇总");
			await ctx.ws.writeOutput(record, "batch.json", JSON.stringify(groups.map(({ reading, check, applicability, ...rest }) => rest), null, 2), "整批结构化结果");
			record.remarks.push(`共 ${groups.length} 组，完成 ${groups.length - failed.length} 组，失败 ${failed.length} 组；整批一起交给 M04（m04 --from M06）。`);
			return { record, groups, summaryPath: summaryRef.path };
		},
		() => "按来源分组，每组依次运行阅读、核对、适用性三个独立会话；阅读与核对会话只持有限定在材料目录的只读工具；适用性会话使用同一份项目状态。失败组保留实际范围；整批汇总后交给 M04，不逐篇先处理。",
	);
}

async function processGroup(ctx: StageContext, record: StageRunRecord, group: M06Group, options: M06Options, projectState: string): Promise<void> {
	const source = { id: group.sourceId, title: group.title };
	const pageTool = () =>
		renderPageTool({
			root: group.dir,
			tools: ctx.config.tools,
			onRendered: ({ pdf, page }) => {
				const key = `${path.basename(pdf)}#${page}`;
				if (!group.renderedPages.includes(key)) group.renderedPages.push(key);
			},
		});
	try {
		const reader = await ctx.runner.create(sessionSpec(ctx, `M06-${group.sourceId}-reader`, "reader", systemPromptFor("reader"), { kind: "read-dir", root: group.dir, toolName: "material_read", extraTools: [pageTool()] }));
		try {
			recordSession(record, reader);
			const turn = await reader.prompt(buildM06ReadMessage({ ...source, requirements: options.requirements, fullText: options.fullText ?? false }));
			group.reading = turn.text;
			group.readCoverage = reader.readCoverage();
			group.outputs.push(await ctx.ws.writeOutput(record, `${group.sourceId}/reading.md`, turn.text, `${group.sourceId} 阅读记录`));
		} finally {
			reader.dispose();
		}
		if (!group.readCoverage.length && !group.renderedPages.length) {
			throw new HarnessError("m06.read", "阅读会话没有实际读取材料文件，也没有查看任何页面");
		}

		const checker = await ctx.runner.create(sessionSpec(ctx, `M06-${group.sourceId}-checker`, "checker", systemPromptFor("checker"), { kind: "read-dir", root: group.dir, toolName: "material_read", extraTools: [pageTool()] }));
		try {
			recordSession(record, checker);
			const turn = await checker.prompt(buildM06CheckMessage(source, group.reading));
			group.check = turn.text;
			group.checkCoverage = checker.readCoverage();
			group.outputs.push(await ctx.ws.writeOutput(record, `${group.sourceId}/check.md`, turn.text, `${group.sourceId} 核对记录`));
		} finally {
			checker.dispose();
		}

		const applicability = await ctx.runner.create(sessionSpec(ctx, `M06-${group.sourceId}-applicability`, "applicability", systemPromptFor("applicability"), { kind: "none" }));
		try {
			recordSession(record, applicability);
			const verified = `${group.reading}\n\n${section("核对记录", group.check)}`;
			const turn = await applicability.prompt(buildM06ApplicabilityMessage(source, verified, projectState));
			group.applicability = turn.text;
			group.outputs.push(await ctx.ws.writeOutput(record, `${group.sourceId}/applicability.md`, turn.text, `${group.sourceId} 适用性分析`));
		} finally {
			applicability.dispose();
		}
		group.status = "completed";
	} catch (error) {
		group.status = "failed";
		group.failure = (error as Error).message;
	}
}

function renderBatchSummary(ctx: StageContext, groups: M06Group[]): string {
	const lines: string[] = ["# M06 整批汇总", "", "本汇总只是把各资料组的实际产物放在一起交给 M04；所有建议均待 M04 处理，入库前不构成项目认识。", ""];
	for (const g of groups) {
		lines.push(`## ${g.sourceId}：${g.title}`, "", `- 状态：${g.status === "completed" ? "完成" : `失败：${g.failure}`}`);
		lines.push(`- 阅读实际读取文件：${g.readCoverage.length ? g.readCoverage.join("、") : "无"}`);
		lines.push(`- 查看过的 PDF 页面：${g.renderedPages.length ? g.renderedPages.join("、") : "无"}`);
		lines.push(`- 核对实际读取文件：${g.checkCoverage.length ? g.checkCoverage.join("、") : "无"}`);
		for (const o of g.outputs) lines.push(`- ${o.label}：${relPath(ctx, o.path)}`);
		if (g.applicability) {
			lines.push("", "### 适用性分析与处理建议", "", g.applicability.trim());
		}
		lines.push("");
	}
	const failed = groups.filter((g) => g.status === "failed");
	lines.push("## 失败或缺口", "", failed.length ? failed.map((g) => `- ${g.sourceId}：${g.failure}`).join("\n") : "- 无");
	return lines.join("\n");
}
