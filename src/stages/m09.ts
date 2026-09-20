/**
 * M09 explanation, delivery verification, and bounded closure.
 *
 * This stage packages only the immutable material frozen by one named M08 run,
 * after one named M04 run has processed that M08 feedback. It creates two fresh
 * sessions: an explanation task and an independent check of the actual delivery
 * copy. A returned model report (or a successful command) is evidence of the
 * reported coverage only; it is never promoted to scientific or reproduction
 * success by this controller.
 */
import { spawn } from "node:child_process";
import { cp, lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { HarnessError, type StageRunRecord } from "../types.ts";
import { renderPageTool } from "../tools/pagetool.ts";
import { pdfPageCount } from "../tools/pdf.ts";
import type { CustomToolSpec, ToolGrant } from "../runner/types.ts";
import { loadPrompt } from "../prompts.ts";
import { recordSession, requireCompletedRun, sessionSpec, withRun, type StageContext } from "./context.ts";
import { readFrozenArtifactManifest, type FrozenArtifactManifest } from "./artifacts.ts";

export type ReproductionMode = "read-only" | "specified-checks" | "full-recomputation";

export interface M09Options {
	m08RunId: string;
	m04RunId: string;
	recipient: string;
	purpose: string;
	deliveryScope: {
		/** Manifest relative paths to deliver. The choice is a main-agent/user decision. */
		included: string[];
		excluded: string[];
		limitations: string[];
	};
	reproduction: {
		mode: ReproductionMode;
		/** Exact user/main-agent-authorised shell commands, one command per item; never invented by M09. */
		instructions: string[];
		authorizedExecution: boolean;
		/** Optional explicitly required PDF pages; omitted means every page of included PDFs. */
		pdfPages?: Array<{ path: string; pages: number[] }>;
	};
	/** Records intent to stop this current goal after the receipt; it does not stop Pi or tasks. */
	closureRequested?: boolean;
}

export interface M09ClosureArtifact {
	m09RunId: string;
	status: "current-goal-returned";
	closureRequested: boolean;
	researchCompletion: "not-decided-by-m09";
	deliveryStatus: "checked";
	version: { m08RunId: string; m04RunId: string; manifestPath: string };
	recipient: string;
	purpose: string;
	deliveryScope: M09Options["deliveryScope"];
	reproduction: {
		mode: ReproductionMode;
		status: "not-executed" | "commands-executed-completeness-not-certified";
		authorizedExecution: boolean;
		instructions: string[];
		actualToolCalls: number;
		/** A truthful boundary: command completion alone does not establish reproduction. */
		interpretation: string;
	};
	artifacts: { explanation: string; deliveryRoot: string; verificationReport: string; sourceTrace: string };
	limitations: string[];
	recoveryEntry: string;
	runningTasks: Array<{ stage: string; runId: string; status: StageRunRecord["status"] }>;
	automaticActionsNotTaken: string[];
}

export interface M09Result {
	record: StageRunRecord;
	closure: M09ClosureArtifact;
	explanation: string;
	verification: string;
}

function nonEmpty(value: string, name: string): string {
	const clean = value.trim();
	if (!clean) throw new HarnessError("m09.options", `${name} 不能为空`);
	return clean;
}

function stringList(value: unknown, name: string): string[] {
	if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) throw new HarnessError("m09.options", `${name} 必须是非空字符串组成的数组`);
	return value.map((item) => item.trim());
}

function outputPath(run: StageRunRecord, label: string): string {
	const output = run.outputs.find((item) => item.label === label);
	if (!output) throw new HarnessError("m09.input", `${run.stage} 运行 ${run.runId} 缺少“${label}”`);
	return output.path;
}

function isWithin(root: string, target: string): boolean {
	const relative = path.relative(path.resolve(root), path.resolve(target));
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function normalizeRelative(value: string): string {
	const normalized = path.normalize(value.trim());
	if (!value.trim() || normalized === "." || path.isAbsolute(normalized) || normalized.startsWith(`..${path.sep}`) || normalized === "..") {
		throw new HarnessError("m09.scope", `非法交付相对路径：${value}`);
	}
	return normalized;
}

async function validatePair(m08: StageRunRecord, m04: StageRunRecord): Promise<{ feedbackPath: string; source: { m08RunId: string; manifestPath: string; reviewBundlePath: string } }> {
	const feedback = outputPath(m08, "M08 审查反馈包");
	const manifest = outputPath(m08, "固定材料清单");
	const refersToFeedback = m04.inputs.some((input) => path.resolve(input.path) === path.resolve(feedback));
	if (!refersToFeedback) {
		throw new HarnessError("m09.pair", `M04 运行 ${m04.runId} 没有处理 M08 运行 ${m08.runId} 的审查反馈包`);
	}
	const proposalFailure = m04.failures.find((failure) => /知识提案.*(?:未入库|未合入|失败|校验)/.test(failure));
	if (proposalFailure) throw new HarnessError("m09.m04-proposal", `M04 知识提案处理失败，不能交付：${proposalFailure}`);
	const sourceOutput = m04.outputs.find((output) => output.label === "M08 处理来源");
	if (!sourceOutput) throw new HarnessError("m09.pair", "指定 M04 缺少已校验的 M08 处理来源");
	const source = JSON.parse(await readFile(sourceOutput.path, "utf8")) as { m08RunId: string; manifestPath: string; reviewBundlePath: string };
	if (typeof source.m08RunId !== "string" || typeof source.manifestPath !== "string" || typeof source.reviewBundlePath !== "string") throw new HarnessError("m09.pair", "M04 的 M08 处理来源结构无效");
	if (source.m08RunId !== m08.runId || path.resolve(source.manifestPath) !== path.resolve(manifest) || path.resolve(source.reviewBundlePath) !== path.resolve(feedback)) throw new HarnessError("m09.pair", "M04 的 M08 处理来源与指定 M08 实际清单/反馈包不一致");
	return { feedbackPath: feedback, source };
}

interface M08Disposition {
	m08RunId: string;
	status: "ready" | "partial" | "rework" | "needs_evidence" | "unresolved";
	deliverablePaths: string[];
	limitations: string[];
	rationale: string;
}

interface SessionGate {
	status: "checked" | "needs_fix" | "blocked";
	scope: string[];
	unresolved: string[];
	evidence: string[];
}

function parseBlock<T>(text: string, name: string): T {
	const match = text.match(new RegExp("```" + name + "\\s*\\n([\\s\\S]*?)\\n```"));
	if (!match) throw new HarnessError("m09.structured", `缺少 ${name} 机器可读块`);
	try { return JSON.parse(match[1]) as T; }
	catch (error) { throw new HarnessError("m09.structured", `${name} 不是合法 JSON：${(error as Error).message}`); }
}

async function dispositionFrom(m04: StageRunRecord, m08RunId: string): Promise<M08Disposition> {
	const sourceOutput = m04.outputs.find((output) => output.label === "M08 处理来源");
	const dispositionOutput = m04.outputs.find((output) => output.label === "M08 用途处置");
	if (!sourceOutput || !dispositionOutput) throw new HarnessError("m09.disposition", "指定 M04 缺少已校验的 M08 处理来源或用途处置文件");
	let source: { m08RunId?: string; manifestPath?: string; reviewBundlePath?: string };
	let value: M08Disposition;
	try {
		source = JSON.parse(await readFile(sourceOutput.path, "utf8")) as { m08RunId?: string };
		value = JSON.parse(await readFile(dispositionOutput.path, "utf8")) as M08Disposition;
	} catch (error) { throw new HarnessError("m09.disposition", `M04 的已校验 M08 处置文件不是合法 JSON：${(error as Error).message}`); }
	if (typeof source.m08RunId !== "string" || typeof source.manifestPath !== "string" || typeof source.reviewBundlePath !== "string" || source.m08RunId !== m08RunId) throw new HarnessError("m09.disposition", `M04 处理来源属于 ${source.m08RunId ?? "未知"}，不是指定 M08 ${m08RunId}`);
		if (value.m08RunId !== m08RunId || typeof value.rationale !== "string" || !value.rationale.trim()) {
			throw new HarnessError("m09.disposition", "M04 的 m08-disposition 结构或 M08 配对无效");
		}
		value.deliverablePaths = stringList(value.deliverablePaths, "m08-disposition.deliverablePaths");
		value.limitations = stringList(value.limitations, "m08-disposition.limitations");
		if (!(["ready", "partial", "rework", "needs_evidence", "unresolved"] as string[]).includes(value.status)) throw new HarnessError("m09.disposition", `未知 M08 处置状态：${value.status}`);
		if (value.status !== "ready" && value.status !== "partial") throw new HarnessError("m09.disposition", `M08 处置状态为 ${value.status}，不能进入交付收口`);
	return value;
}

async function assertKnowledgeCurrent(ctx: StageContext, m04: StageRunRecord): Promise<void> {
	const merge = m04.outputs.find((item) => item.label === "合入结果");
	let handledSnapshot = m04.knowledgeSnapshot;
	if (merge) {
		const parsed = JSON.parse(await readFile(merge.path, "utf8")) as { snapshot?: { id?: string } };
		handledSnapshot = parsed.snapshot?.id ?? handledSnapshot;
	}
	const current = await ctx.store.current();
	if ((current?.id ?? undefined) !== handledSnapshot) {
		throw new HarnessError("m09.knowledge-changed", `M04 处理后的知识版本为 ${handledSnapshot ?? "无"}，当前为 ${current?.id ?? "无"}；需先说明新限制/撤回影响并由 M04 复核`);
	}
	const limits = await ctx.store.limits();
	const activeTargets = limits.filter((limit) => !limit.liftedAt).map((limit) => `${limit.target}:${limit.kind}`).sort();
	const snapshotTargets = [...(current?.activeLimits ?? [])].sort();
	const sameTargets = activeTargets.length === snapshotTargets.length && activeTargets.every((target, index) => target === snapshotTargets[index]);
	const handledAt = m04.finishedAt ? Date.parse(m04.finishedAt) : Number.NaN;
	const changedAfterM04 = limits.some((limit) => Date.parse(limit.since) > handledAt || (!!limit.liftedAt && Date.parse(limit.liftedAt) > handledAt));
	if (!sameTargets || changedAfterM04) {
		throw new HarnessError("m09.limits-changed", "当前停用/撤回/需复核限制未被指定 M04 的处理版本覆盖；不能沿用旧交付结论");
	}
}

async function copyDelivery(
	manifest: FrozenArtifactManifest,
	included: string[],
	deliveryRoot: string,
): Promise<Array<{ relativePath: string; frozenPath: string; deliveryPath: string }>> {
	const byRelative = new Map(manifest.entries.map((entry) => [path.normalize(entry.relativePath), entry]));
	const selected = [...new Set(included.map(normalizeRelative))];
	if (!selected.length) throw new HarnessError("m09.scope", "交付范围 included 至少要明确列出一个固定材料路径");
	const trace: Array<{ relativePath: string; frozenPath: string; deliveryPath: string }> = [];
	for (const relativePath of selected) {
		const entry = byRelative.get(relativePath);
		if (!entry) throw new HarnessError("m09.scope", `交付路径不在 M08 固定材料清单：${relativePath}`);
		if (!isWithin(manifest.rootDir, entry.frozenPath)) throw new HarnessError("m09.manifest", `固定材料越出 manifest rootDir：${entry.frozenPath}`);
		const info = await lstat(entry.frozenPath).catch(() => undefined);
		if (info?.isSymbolicLink()) throw new HarnessError("m09.symlink", `固定材料不接受符号链接：${entry.frozenPath}`);
		if (!info || (!info.isFile() && !info.isDirectory())) throw new HarnessError("m09.manifest", `固定材料不是可复制文件或目录：${entry.frozenPath}`);
		const deliveryPath = path.join(deliveryRoot, relativePath);
		if (!isWithin(deliveryRoot, deliveryPath)) throw new HarnessError("m09.scope", `交付目标越界：${relativePath}`);
		await mkdir(path.dirname(deliveryPath), { recursive: true });
		await cp(entry.frozenPath, deliveryPath, { recursive: info.isDirectory(), errorOnExist: true });
		trace.push({ relativePath, frozenPath: entry.frozenPath, deliveryPath });
	}
	return trace;
}

async function runningFacts(ctx: StageContext, ownRunId: string): Promise<M09ClosureArtifact["runningTasks"]> {
	const facts: M09ClosureArtifact["runningTasks"] = [];
	for (const stage of ["M01", "M02", "M03", "M04", "M05", "M06", "M07", "M08", "M09"]) for (const runId of await ctx.ws.listRuns(stage)) {
		if (stage === "M09" && runId === ownRunId) continue;
		const run = await ctx.ws.readRun(stage, runId);
		if (run.status === "running") facts.push({ stage, runId, status: run.status });
	}
	return facts;
}

async function byteSnapshot(root: string): Promise<Map<string, Buffer>> {
	const result = new Map<string, Buffer>();
	async function walk(dir: string): Promise<void> {
		for (const name of (await readdir(dir)).sort()) {
			const target = path.join(dir, name); const info = await lstat(target);
			if (info.isSymbolicLink()) throw new HarnessError("m09.symlink", `交付/复核副本不接受符号链接：${target}`);
			if (info.isDirectory()) await walk(target);
			else if (info.isFile()) result.set(path.relative(root, target), await readFile(target));
		}
	}
	await walk(root); return result;
}

async function expandedFiles(root: string, entries: string[]): Promise<string[]> {
	const files = [...(await byteSnapshot(root)).keys()];
	return files.filter((file) => entries.some((entry) => file === entry || file.startsWith(`${entry}${path.sep}`)));
}

function changedFiles(before: Map<string, Buffer>, after: Map<string, Buffer>): string[] {
	return [...new Set([...before.keys(), ...after.keys()])].filter((key) => !before.get(key)?.equals(after.get(key) ?? Buffer.alloc(0)) || !after.has(key)).sort();
}

function changedOriginalFiles(before: Map<string, Buffer>, after: Map<string, Buffer>): string[] {
	return [...before.keys()].filter((key) => !after.has(key) || !before.get(key)!.equals(after.get(key)!)).sort();
}

function validateGate(value: SessionGate, label: string, expectedScope: string[]): void {
	if (!value || !(["checked", "needs_fix", "blocked"] as string[]).includes(value.status)) throw new HarnessError("m09.structured", `${label} 结果结构无效`);
	value.scope = stringList(value.scope, `${label}.scope`); value.unresolved = Array.isArray(value.unresolved) ? value.unresolved.map((x) => nonEmpty(String(x), `${label}.unresolved`)) : (() => { throw new HarnessError("m09.structured", `${label}.unresolved 必须是数组`); })(); value.evidence = stringList(value.evidence, `${label}.evidence`);
	if (value.scope.length !== expectedScope.length || value.scope.some((item, index) => item !== expectedScope[index])) throw new HarnessError("m09.scope", `${label} scope 必须与 included 的规范顺序完全一致`);
	if (value.status !== "checked") throw new HarnessError("m09.gate", `${label} 返回 ${value.status}，不能形成收口回执`);
	if (value.unresolved.length) throw new HarnessError("m09.gate", `${label} checked 仍含 unresolved，不能收口`);
}

export interface ReproductionRecord { index: number; command: string; cwd: string; startedAt: string; finishedAt: string; exitCode: number | null; stdout: string; stderr: string; logPath: string }

export function createReproductionTool(commands: string[], cwd: string, logDir: string, records: Map<number, ReproductionRecord>): CustomToolSpec {
	return {
		name: "run_reproduction_check",
		description: "运行主 Agent 预先授权的一项复现检查。只能传指令列表中的 index；重复 index 返回已保存结果。",
		params: { index: { type: "number", description: "预声明命令的零基序号" } },
		async execute(args, signal) {
			const index = args.index;
			if (typeof index !== "number" || !Number.isInteger(index) || index < 0 || index >= commands.length) throw new HarnessError("m09.command-index", "index 不在预声明复现命令范围内");
			const existing = records.get(index); if (existing) return { text: `该命令已运行，复用日志 ${existing.logPath}，exitCode=${existing.exitCode}`, details: existing };
			if (signal?.aborted) throw new HarnessError("m09.command-aborted", `命令 ${index} 在启动前已取消，未创建子进程`);
			const command = commands[index]; const startedAt = new Date().toISOString();
			const result = await new Promise<{ exitCode: number | null; stdout: string; stderr: string }>((resolve) => {
				const grouped = process.platform !== "win32";
				const child = spawn(command, { cwd, shell: true, detached: grouped, stdio: ["ignore", "pipe", "pipe"] }); let stdout = ""; let stderr = "";
				let aborted = false; let settled = false;
				const finish = (value: { exitCode: number | null; stdout: string; stderr: string }) => { if (settled) return; settled = true; signal?.removeEventListener("abort", abort); resolve(value); };
				const abort = () => { aborted = true; try { if (grouped && child.pid) process.kill(-child.pid, "SIGTERM"); else child.kill("SIGTERM"); } catch { child.kill("SIGTERM"); } };
				signal?.addEventListener("abort", abort, { once: true });
				if (signal?.aborted) abort();
				child.stdout.on("data", (chunk) => { stdout += String(chunk); }); child.stderr.on("data", (chunk) => { stderr += String(chunk); });
				child.on("error", (error) => finish({ exitCode: null, stdout, stderr: `${stderr}${stderr ? "\n" : ""}${error.message}${aborted ? "\n已取消" : ""}` }));
				child.on("close", (exitCode) => finish({ exitCode: aborted ? null : exitCode, stdout, stderr: `${stderr}${aborted ? `${stderr ? "\n" : ""}已取消` : ""}` }));
			});
			const finishedAt = new Date().toISOString(); await mkdir(logDir, { recursive: true }); const logPath = path.join(logDir, `${String(index).padStart(3, "0")}.json`);
			const record: ReproductionRecord = { index, command, cwd, startedAt, finishedAt, ...result, logPath };
			await writeFile(logPath, `${JSON.stringify(record, null, 2)}\n`, "utf8"); records.set(index, record);
			return { text: `命令 ${index} 已结束，exitCode=${result.exitCode}，完整 stdout/stderr：${logPath}`, details: record };
		},
	};
}

async function requiredPdfCoverage(root: string, files: string[], declared?: Array<{ path: string; pages: number[] }>): Promise<{ required: string[]; omitted: string[] }> {
	const declaration = new Map((declared ?? []).map((item) => [normalizeRelative(item.path), item.pages]));
	const required: string[] = []; const omitted: string[] = [];
	for (const relative of files.filter((item) => item.toLowerCase().endsWith(".pdf"))) {
		const total = await pdfPageCount(path.join(root, relative));
		if (!total) throw new HarnessError("m09.pdf", `无法确定 PDF 总页数，不能验证覆盖：${relative}`);
		const pages = declaration.get(relative) ?? Array.from({ length: total }, (_, index) => index + 1);
		if (!pages.length || pages.some((page) => !Number.isInteger(page) || page < 1 || page > total)) throw new HarnessError("m09.pdf", `PDF 页范围无效：${relative}`);
		for (const page of [...new Set(pages)].sort((a, b) => a - b)) required.push(`${relative}#${page}`);
		for (let page = 1; page <= total; page++) if (!pages.includes(page)) omitted.push(`${relative}#${page}`);
	}
	for (const key of declaration.keys()) if (!files.includes(key) || !key.toLowerCase().endsWith(".pdf")) throw new HarnessError("m09.pdf", `PDF 页范围不属于 included PDF：${key}`);
	return { required, omitted };
}

export async function runM09(ctx: StageContext, options: M09Options): Promise<M09Result> {
	nonEmpty(options.recipient, "recipient");
	nonEmpty(options.purpose, "purpose");
	const included = stringList(options.deliveryScope?.included, "deliveryScope.included").map(normalizeRelative);
	const excluded = stringList(options.deliveryScope?.excluded ?? [], "deliveryScope.excluded").map(normalizeRelative);
	const limitations = stringList(options.deliveryScope?.limitations ?? [], "deliveryScope.limitations");
	if (new Set(included).size !== included.length || new Set(excluded).size !== excluded.length) throw new HarnessError("m09.scope", "included/excluded 不能重复");
	if (included.some((item) => excluded.includes(item))) throw new HarnessError("m09.scope", "included 与 excluded 必须互斥");
	options.deliveryScope = { included, excluded, limitations };
	options.reproduction.instructions = stringList(options.reproduction.instructions ?? [], "reproduction.instructions");
	if (options.reproduction.mode === "read-only") {
		if (options.reproduction.authorizedExecution || options.reproduction.instructions.length) {
			throw new HarnessError("m09.reproduction", "read-only 模式不能附带执行授权或操作指令");
		}
	} else if (!options.reproduction.authorizedExecution || !options.reproduction.instructions.length || options.reproduction.instructions.some((x) => !x.trim())) {
		throw new HarnessError("m09.reproduction", `${options.reproduction.mode} 必须有明确执行授权和非空操作指令`);
	}

	const m08 = await requireCompletedRun(ctx, "M08", options.m08RunId);
	const m04 = await requireCompletedRun(ctx, "M04", options.m04RunId);
	const pair = await validatePair(m08, m04);
	await assertKnowledgeCurrent(ctx, m04);
	const disposition = await dispositionFrom(m04, m08.runId);
	const manifestPath = outputPath(m08, "固定材料清单");
	const expectedFrozenRoot = path.join(ctx.ws.runDir("M08", m08.runId), "frozen");
	const manifest = await readFrozenArtifactManifest(manifestPath, { m08RunId: m08.runId, rootDir: expectedFrozenRoot });
	const manifestPaths = manifest.entries.map((entry) => normalizeRelative(entry.relativePath));
	for (const item of disposition.deliverablePaths) if (!manifestPaths.includes(normalizeRelative(item))) throw new HarnessError("m09.disposition", `M04 可交付路径不在固定清单：${item}`);
	const allowed = new Set(disposition.deliverablePaths.map(normalizeRelative));
	for (const requested of options.deliveryScope.included.map(normalizeRelative)) if (!allowed.has(requested)) throw new HarnessError("m09.scope", `M04 未判定该路径可交付：${requested}`);

	const record = await ctx.ws.startRun("M09", [
		{ label: "M08 固定材料清单", path: manifestPath },
		{ label: "M08 审查反馈包", path: pair.feedbackPath },
		...m04.outputs.map((item) => ({ label: `M04 ${item.label}`, path: item.path })),
	]);
	return withRun(ctx, record, async () => {
		const runDir = ctx.ws.runDir("M09", record.runId);
		const deliveryRoot = path.join(runDir, "delivery");
		await mkdir(deliveryRoot, { recursive: true });
		const trace = await copyDelivery(manifest, included, deliveryRoot);
		const tracePath = (await ctx.ws.writeOutput(record, "source-trace.json", JSON.stringify({ m08RunId: m08.runId, manifestPath, entries: trace }, null, 2), "交付源到副本追踪")).path;

		const m04Text = await Promise.all(m04.outputs.map(async (item) => `\n## ${item.label}\n${await readFile(item.path, "utf8")}`));
		const p09 = await loadPrompt("P09");
		const problemEntry = manifest.entries.find((entry) => entry.sourceCategory === "original-problem");
		if (!problemEntry) throw new HarnessError("m09.manifest", "固定材料缺少原始问题");
		const organizerRequired = await expandedFiles(manifest.rootDir, [normalizeRelative(problemEntry.relativePath), ...included]);
		const organizerPdfCoverage = await requiredPdfCoverage(manifest.rootDir, organizerRequired, options.reproduction.pdfPages);
		const organizerPrompt = `${p09}\n\n---\n\n你是 M09 独立成果整理任务。只根据下面同一版 M08 固定材料、M08 审查反馈及其 M04 处置，形成可独立阅读的说明。不得新增科学结论、扩大结论、补造历史或把需返工内容包装成已通过。必须用工具根 ${manifest.rootDir} 内的 relativePath 实际读取固定原问题与 included 范围。PDF 必须查看页：${JSON.stringify(organizerPdfCoverage.required)}；明确未覆盖页：${JSON.stringify(organizerPdfCoverage.omitted)}。末尾给出严格 JSON 的 m09-delivery fenced block，scope 必须严格等于 ${JSON.stringify(included)}，字段为 status、scope、unresolved、evidence。接收者：${options.recipient}\n用途：${options.purpose}\n明确交付范围：${JSON.stringify(options.deliveryScope)}\nM04机器处置（supplied-in-message）：${JSON.stringify(disposition)}\n固定材料清单：${manifestPath}\n实际交付副本：${deliveryRoot}\nM04处置：${m04Text.join("\n")}`;
		const organizerPages: string[] = [];
		const organizerPageTool = renderPageTool({ root: manifest.rootDir, tools: ctx.config.tools, outputDir: path.join(runDir, "organizer-pages"), onRendered: ({ pdf, page }) => { organizerPages.push(`${path.relative(manifest.rootDir, pdf)}#${page}`); } });
		const organizer = await ctx.runner.create(sessionSpec(ctx, "M09-organizer", "execution", "按 P09 整理既有成果；只重组说明，不作新的科学判断。", { kind: "read-dir", root: manifest.rootDir, extraTools: [organizerPageTool] }));
		let explanation = "";
		let organizerCoverage: string[] = [];
		let organizerFailure: unknown;
		try {
			recordSession(record, organizer);
			explanation = (await organizer.prompt(organizerPrompt)).text;
		} catch (error) { organizerFailure = error; }
		finally { organizerCoverage = organizer.readCoverage(); organizer.dispose(); }
		const explanationPath = (await ctx.ws.writeOutput(record, "explanation.md", explanation!, "成果说明")).path;
		await ctx.ws.writeOutput(record, "organizer-coverage.json", JSON.stringify({ readCoverage: organizerCoverage, renderedPdfPages: organizerPages, requiredPdfPages: organizerPdfCoverage.required, failure: organizerFailure instanceof Error ? organizerFailure.message : undefined }, null, 2), "成果整理实际覆盖");
		if (organizerFailure) throw organizerFailure;
		const deliveryGate = parseBlock<SessionGate>(explanation!, "m09-delivery"); validateGate(deliveryGate, "整理任务", included);
		const organizerEvidence = new Set([...organizerCoverage, ...organizerPages]);
		const badOrganizerEvidence = deliveryGate.evidence.filter((item) => !organizerEvidence.has(item));
		if (!deliveryGate.evidence.length || badOrganizerEvidence.length) throw new HarnessError("m09.coverage", `整理任务 evidence 未映射实际读取材料：${badOrganizerEvidence.join("、") || "为空"}`);
		for (const needed of organizerRequired) if (!organizerCoverage.includes(needed) && !organizerPages.some((page) => page.startsWith(`${needed}#`))) throw new HarnessError("m09.coverage", `整理任务未实际读取：${needed}`);
		for (const page of organizerPdfCoverage.required) if (!organizerPages.includes(page)) throw new HarnessError("m09.coverage", `整理任务未实际查看 PDF 页：${page}`);
		const deliveredExplanation = path.join(deliveryRoot, "DELIVERY.md");
		await writeFile(deliveredExplanation, explanation!, "utf8");

		let checkRoot = deliveryRoot;
		if (options.reproduction.mode !== "read-only") {
			checkRoot = path.join(runDir, "verification-copy");
			await cp(deliveryRoot, checkRoot, { recursive: true, errorOnExist: true });
			record.remarks.push("计算复核使用交付副本的独立 copy；execution grant 是工具能力选择，不是 OS hard sandbox。");
		}
		const deliveryBefore = await byteSnapshot(deliveryRoot);
		const verificationBefore = await byteSnapshot(checkRoot);
		const deliveryFiles = [...deliveryBefore.keys()];
		const pdfCoverage = await requiredPdfCoverage(deliveryRoot, deliveryFiles, options.reproduction.pdfPages);
		const checkerPrompt = `${p09}\n\n---\n\n你是 fresh M09 独立交付复核任务。必须用工具读取 DELIVERY.md 和 included 实际材料，核查交付约定、路径、依赖、配置、版本、入口和真实执行覆盖；这不是重做 M08 科学审查。PDF要求页：${JSON.stringify(pdfCoverage.required)}；未覆盖页：${JSON.stringify(pdfCoverage.omitted)}。末尾给出严格 JSON 的 m09-verification fenced block，scope 必须严格等于 ${JSON.stringify(included)}，字段为 status、scope、unresolved、evidence。实际交付副本：${deliveryRoot}\n复核工作副本：${checkRoot}\n源追踪：${tracePath}\n模式：${options.reproduction.mode}\n预授权命令（只能调用 run_reproduction_check(index)）：${JSON.stringify(options.reproduction.instructions)}\nexit 0 只说明命令完成，不证明科学正确或完整复现。`;
		const checkerPages: string[] = [];
		const checkerPageTool = renderPageTool({ root: checkRoot, tools: ctx.config.tools, outputDir: path.join(runDir, "verification-pages"), onRendered: ({ pdf, page }) => { checkerPages.push(`${path.relative(checkRoot, pdf)}#${page}`); } });
		const reproductionRecords = new Map<number, ReproductionRecord>();
		const runCheck = createReproductionTool(options.reproduction.instructions, checkRoot, path.join(runDir, "reproduction-logs"), reproductionRecords);
		const grant: ToolGrant = options.reproduction.mode === "read-only"
			? { kind: "read-dir", root: deliveryRoot, extraTools: [checkerPageTool] }
			: { kind: "read-dir", root: checkRoot, extraTools: [checkerPageTool, runCheck] };
		const checker = await ctx.runner.create(sessionSpec(ctx, "M09-checker", "checker", "按 P09 复核实际交付副本并忠实报告覆盖；不判定新的科学结论。", grant));
		let verification = "";
		let actualToolCalls = 0;
		let readCoverage: string[] = [];
		let checkerToolLog: ReturnType<typeof checker.toolLog> = [];
		let checkerFailure: unknown;
		try {
			recordSession(record, checker);
			verification = (await checker.prompt(checkerPrompt)).text;
		} catch (error) { checkerFailure = error; }
		finally { checkerToolLog = checker.toolLog(); actualToolCalls = checkerToolLog.length; readCoverage = checker.readCoverage(); checker.dispose(); }
		const verificationPath = (await ctx.ws.writeOutput(record, "verification.md", verification!, "实际交付副本复核报告")).path;
		const preliminaryCoverage = { readCoverage, renderedPdfPages: checkerPages, requiredPdfPages: pdfCoverage.required, omittedPdfPages: pdfCoverage.omitted, toolLog: checkerToolLog, reproductionRecords: [...reproductionRecords.values()], failure: checkerFailure instanceof Error ? checkerFailure.message : undefined };
		await ctx.ws.writeOutput(record, "verification-coverage.json", JSON.stringify(preliminaryCoverage, null, 2), "交付复核实际覆盖");
		if (checkerFailure) throw checkerFailure;
		let verificationGate: SessionGate;
		verificationGate = parseBlock<SessionGate>(verification!, "m09-verification");
		validateGate(verificationGate, "交付复核任务", included);
		const expectedReads = [...deliveryBefore.keys()].filter((item) => !item.toLowerCase().endsWith(".pdf"));
		const missingReads = expectedReads.filter((item) => !readCoverage.includes(item));
		if (missingReads.length) throw new HarnessError("m09.coverage", `复核未实际读取交付范围：${missingReads.join("、")}`);
		for (const page of pdfCoverage.required) if (!checkerPages.includes(page)) throw new HarnessError("m09.coverage", `复核未实际查看 PDF 页：${page}`);
		const deliveryAfter = await byteSnapshot(deliveryRoot);
		const deliveryChanged = changedFiles(deliveryBefore, deliveryAfter);
		if (deliveryChanged.length) throw new HarnessError("m09.delivery-mutated", `复核期间实际交付副本发生变化：${deliveryChanged.join("、")}`);
		const verificationAfter = await byteSnapshot(checkRoot);
		const verificationChanges = changedFiles(verificationBefore, verificationAfter);
		const originalVerificationMutations = changedOriginalFiles(verificationBefore, verificationAfter);
		await ctx.ws.writeOutput(record, "verification-final-state.json", JSON.stringify({ verificationCopyChanges: verificationChanges, originalVerificationMutations, deliveryCopyChanges: deliveryChanged, reproductionRecords: [...reproductionRecords.values()] }, null, 2), "交付复核最终状态");
		if (originalVerificationMutations.length) throw new HarnessError("m09.verification-input-mutated", `核验命令修改或删除了原交付文件：${originalVerificationMutations.join("、")}`);
		const executed = [...reproductionRecords.values()].sort((a, b) => a.index - b.index);
		if (options.reproduction.mode !== "read-only" && (executed.length !== options.reproduction.instructions.length || executed.some((item, index) => item.index !== index || item.exitCode !== 0))) throw new HarnessError("m09.reproduction-failed", "预声明复现命令未全部实际执行并以 exit 0 完成；详见逐项日志");
		const evidenceUniverse = new Set([...readCoverage, ...checkerPages, ...verificationChanges, ...executed.flatMap((item) => [`command:${item.index}`, item.logPath])]);
		const invalidEvidence = verificationGate.evidence.filter((item) => !evidenceUniverse.has(item));
		if (!verificationGate.evidence.length || invalidEvidence.length) throw new HarnessError("m09.coverage", `复核 evidence 未映射实际读取、工具或产物：${invalidEvidence.join("、") || "为空"}`);
		const reproductionStatus: M09ClosureArtifact["reproduction"]["status"] = executed.length ? "commands-executed-completeness-not-certified" : "not-executed";
		const runningTasks = await runningFacts(ctx, record.runId);
		await assertKnowledgeCurrent(ctx, m04);
		const closure: M09ClosureArtifact = {
			m09RunId: record.runId,
			status: "current-goal-returned",
			closureRequested: options.closureRequested ?? false,
			researchCompletion: "not-decided-by-m09",
			deliveryStatus: "checked",
			version: { m08RunId: m08.runId, m04RunId: m04.runId, manifestPath },
			recipient: options.recipient,
			purpose: options.purpose,
			deliveryScope: options.deliveryScope,
			reproduction: {
				...options.reproduction,
				status: reproductionStatus,
				actualToolCalls: executed.length,
				interpretation: "只记录实际覆盖；工具调用或 exit 0 不自动证明科学正确、结果一致或完整复现。",
			},
			artifacts: { explanation: explanationPath, deliveryRoot, verificationReport: verificationPath, sourceTrace: tracePath },
			limitations: [...new Set([...disposition.limitations, ...options.deliveryScope.limitations, ...verificationGate.unresolved])],
			recoveryEntry: explanationPath,
			runningTasks,
			automaticActionsNotTaken: ["公开", "投稿", "外发", "压缩打包", "启动下一目标", "启动 RSI", "关闭 Pi", "停止或结清 M07 任务"],
		};
		await ctx.ws.writeOutput(record, "closure.json", JSON.stringify(closure, null, 2), "M09 收口回执");
		record.remarks.push("只结束当前目标的工作意图；未关闭 Pi，未改变其他目标或运行任务。研究完成度不由 M09 自动判定。");
		return { record, closure, explanation: explanation!, verification: verification! };
	}, () => `基于指定 M08 ${m08.runId} 固定材料及明确配对的 M04 ${m04.runId} 处置，复制实际交付副本，分别建立 fresh 整理与交付复核会话；记录真实复核覆盖、限制、恢复入口和运行任务事实。未自动公开、投稿、外发、压包、启动下一目标或 RSI。`);
}
