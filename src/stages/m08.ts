import { cp, lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadPrompt, section, systemPromptFor } from "../prompts.ts";
import { renderPageTool } from "../tools/pagetool.ts";
import { HarnessError, type Role, type StageRunRecord } from "../types.ts";
import { recordSession, sessionSpec, withRun, type StageContext } from "./context.ts";
import { freezeArtifacts, type ArtifactSelection, type FrozenArtifactManifest } from "./artifacts.ts";

export type M08ReviewMode = "read-only" | "execute";
export interface M08Task { id: string; instruction: string; mode?: M08ReviewMode }
export interface M08Reviewer { id: string; role: Role; mode?: M08ReviewMode }
export interface M08Options {
	materials: ArtifactSelection[];
	selfChecks: M08Task[];
	reviewers: M08Reviewer[];
	unprovidedScopes?: string[];
	previousRunId?: string;
	changeSummary?: string;
	affectedScope?: string;
}
export interface M08MemberResult { id: string; role: Role | "selfcheck"; status: "completed" | "failed"; report?: string; coverage: string[]; renderedPages: string[]; failure?: string }
export interface M08Result { record: StageRunRecord; manifest: FrozenArtifactManifest; selfChecks: M08MemberResult[]; reviews: M08MemberResult[]; bundlePath?: string }

function validate(options: M08Options): void {
	if (!options.materials.length) throw new HarnessError("m08.materials", "M08 必须显式选择至少一项成果材料");
	if (!options.selfChecks.length) throw new HarnessError("m08.selfchecks", "M08 必须由调用方拆出至少一项自查任务");
	if (!options.reviewers.length) throw new HarnessError("m08.reviewers", "M08 必须显式选择至少一名外审及其配置角色");
	const members = [...options.selfChecks, ...options.reviewers];
	for (const x of members) if (!/^[\p{L}\p{N}][\p{L}\p{N}._-]*$/u.test(x.id)) throw new HarnessError("m08.member", `M08 成员 id 必须是单个安全路径段：${x.id}`);
	if (new Set(members.map((x) => x.id)).size !== members.length) throw new HarnessError("m08.member", "M08 自查与外审成员 id 必须联合唯一");
	if (options.previousRunId && (!options.changeSummary?.trim() || !options.affectedScope?.trim())) throw new HarnessError("m08.recheck", "复审指定 previousRunId 时必须同时说明 changeSummary 与 affectedScope");
	if (options.previousRunId && !/^[\p{L}\p{N}][\p{L}\p{N}._-]*$/u.test(options.previousRunId)) throw new HarnessError("m08.recheck", "previousRunId 必须是单个安全路径段");
}

export async function runM08(ctx: StageContext, options: M08Options): Promise<M08Result> {
	validate(options);
	if (options.previousRunId) await ctx.ws.readRun("M08", options.previousRunId);
	const selectedMaterials = options.materials.map((item) => ({ ...item, path: path.isAbsolute(item.path) ? path.resolve(item.path) : path.resolve(ctx.ws.root, item.path) }));
	const problem = await ctx.ws.readProblem();
	const raw = await ctx.ws.readRawInfo();
	const snapshot = await ctx.store.current();
	const inputs = [{ label: "原始问题", path: problem.path }, ...raw.items.map((x) => ({ label: `必要原始信息 ${x.name}`, path: x.path })), ...selectedMaterials.map((x) => ({ label: x.label, path: x.path }))];
	const record = await ctx.ws.startRun("M08", inputs, snapshot?.id);
	return withRun(ctx, record, async () => {
		const runDir = ctx.ws.runDir("M08", record.runId);
		const staging = path.join(runDir, "frozen");
		await mkdir(staging, { recursive: true });
		const generated: ArtifactSelection[] = [];
		const fixedProblem = path.join(runDir, "fixed-problem.md");
		await writeFile(fixedProblem, problem.content, "utf8");
		generated.push({ label: "本轮固定原始问题", path: fixedProblem, sourceCategory: "original-problem", providedScope: "全文" });
		for (const item of raw.items) generated.push({ label: `必要原始信息 ${item.name}`, path: item.path, sourceCategory: "raw-input", providedScope: "全文" });
		const pack = await ctx.store.buildPack({ purpose: `M08 ${record.runId} 固定知识快照`, includeOpenQuestions: true, types: ["C", "K", "E", "J", "Q", "D", "X"], maxChars: 1_000_000_000 });
		if (pack.snapshot !== snapshot?.id) throw new HarnessError("m08.snapshot-race", `知识快照在固定期间变化：运行记录为 ${snapshot?.id ?? "无"}，知识包为 ${pack.snapshot ?? "无"}；请重新运行 M08`);
		await ctx.ws.writeOutput(record, "knowledge-pack-coverage.json", JSON.stringify({ snapshot: pack.snapshot, included: pack.included, omitted: pack.omitted, truncated: pack.truncated }, null, 2), "固定知识包覆盖");
		const packPath = path.join(runDir, "fixed-knowledge.md");
		await writeFile(packPath, pack.markdown, "utf8");
		generated.push({ label: `当前知识快照 ${snapshot?.id ?? "无"}`, path: packPath, sourceCategory: "knowledge-snapshot", providedScope: pack.truncated ? `截断；未展开 ${pack.omitted.join(", ")}` : "当前发布快照完整展开" });
		const gaps = [...(options.unprovidedScopes ?? []), ...raw.skipped.map((x) => `必要原始信息未提供（非文本）：${x}`)];
		const manifest = await freezeArtifacts(staging, [...generated, ...selectedMaterials], gaps, record.runId);
		const manifestRef = await ctx.ws.writeOutput(record, "manifest.json", JSON.stringify(manifest, null, 2), "固定材料清单");
		record.remarks.push("本轮重新复制全部选定材料；未生成文件哈希，且不会静默沿用旧审查材料。");
		if (options.previousRunId) await ctx.ws.writeOutput(record, "recheck.json", JSON.stringify({ previousRunId: options.previousRunId, changeSummary: options.changeSummary, affectedScope: options.affectedScope }, null, 2), "复审追踪");

		const selfChecks = await mapLimit(options.selfChecks, ctx.config.concurrency, async (task) => runMember(ctx, record, manifest, task.id, "selfcheck", task.mode ?? "read-only", await selfMessage(task, manifest)));
		const selfFailures = selfChecks.filter((x) => x.status === "failed");
		if (selfFailures.length) {
			await writeAggregate(ctx, record, manifest, selfChecks, [], options.reviewers.map((x) => x.id));
			throw new HarnessError("m08.selfcheck-failed", `自查未全部成功：${selfFailures.map((x) => x.id).join("、")}；外审未启动`);
		}
		const reviewJobs = await Promise.all(options.reviewers.map(async (reviewer) => ({ reviewer, message: await reviewMessage(reviewer.id, manifest) })));
		const reviews = await mapLimit(reviewJobs, ctx.config.concurrency, ({ reviewer, message }) => runMember(ctx, record, manifest, reviewer.id, reviewer.role, reviewer.mode ?? "read-only", message));
		const failed = reviews.filter((x) => x.status === "failed");
		if (failed.length) { await writeAggregate(ctx, record, manifest, selfChecks, reviews, []); throw new HarnessError("m08.review-failed", `选定外审未全部成功：${failed.map((x) => x.id).join("、")}；本批不能完成或进入 M04`); }
		const bundle = renderBundle(record, manifest, selfChecks, reviews, options);
		const bundleRef = await ctx.ws.writeOutput(record, "review-bundle.md", bundle, "M08 审查反馈包");
		await ctx.ws.writeOutput(record, "review-bundle.json", JSON.stringify({ m08RunId: record.runId, manifestPath: manifestRef.path, previousRunId: options.previousRunId, changeSummary: options.changeSummary, affectedScope: options.affectedScope, selfChecks, reviews }, null, 2), "M08 审查反馈结构");
		record.remarks.push("完成只表示选定自查与外审全部返回；不表示科研通过，不投票，也不自动进入下一阶段。");
		return { record, manifest, selfChecks, reviews, bundlePath: bundleRef.path };
	}, () => "固定原问题、必要原始信息、当前知识快照和调用方显式选定的成果材料；自查全部成功后才让每名外审在独立新会话读取同一版本；保存完整报告、实际读取范围、失败与未提供范围。完成不等于科研通过。" );
}

async function runMember(ctx: StageContext, record: StageRunRecord, manifest: FrozenArtifactManifest, id: string, role: Role | "selfcheck", mode: M08ReviewMode, message: string): Promise<M08MemberResult> {
	const renderedPages: string[] = [];
	const page = renderPageTool({ root: manifest.rootDir, outputDir: path.join(ctx.ws.runDir("M08", record.runId), "rendered-pages", `${role}-${id}`), tools: ctx.config.tools, onRendered: ({ pdf, page }) => { renderedPages.push(`${path.relative(manifest.rootDir, pdf)}#${page}`); } });
	const actualRole: Role = role === "selfcheck" ? "reviewer" : role;
	const result: M08MemberResult = { id, role, status: "failed", coverage: [], renderedPages };
	let handle;
	try {
		let tools;
		if (mode === "execute") {
			const before = await readTreeBytes(manifest.rootDir);
			const work = path.join(ctx.ws.runDir("M08", record.runId), "verification", `${role}-${id}`);
			await cp(manifest.rootDir, work, { recursive: true, force: false, errorOnExist: true });
			tools = { kind: "execution" as const, root: work, tools: ["read", "write", "edit", "bash"] as Array<"read" | "write" | "edit" | "bash"> };
			message += `\n\n本任务获准在独立核验副本 ${work} 内按需运行检查；不得修改正式固定材料。没有执行的检查必须写为未执行。`;
			const execHandle = await ctx.runner.create(sessionSpec(ctx, `M08-${role}-${id}`, actualRole, systemPromptFor(actualRole, role === "selfcheck" ? "你执行主 Agent 拆分的 P08M 独立自查，只报告有材料依据的发现、实际读取范围和未决。" : undefined), tools));
			handle = execHandle; recordSession(record, execHandle);
			const turn = await execHandle.prompt(message);
			result.report = turn.text; result.coverage = execHandle.readCoverage();
			await assertTreeBytes(manifest.rootDir, before);
			if (!result.coverage.length && !execHandle.toolLog().length) throw new HarnessError("m08.no-read", `${id} 没有实际读取固定材料或执行核验工具`);
			result.status = "completed";
			return result;
		} else tools = { kind: "read-dir" as const, root: manifest.rootDir, toolName: "review_material_read", extraTools: [page] };
		handle = await ctx.runner.create(sessionSpec(ctx, `M08-${role}-${id}`, actualRole, systemPromptFor(actualRole, role === "selfcheck" ? "你执行主 Agent 拆分的 P08M 独立自查，只报告有材料依据的发现、实际读取范围和未决。" : undefined), tools));
		recordSession(record, handle);
		const turn = await handle.prompt(message);
		result.report = turn.text;
		result.coverage = handle.readCoverage();
		if (!result.coverage.length && !renderedPages.length && !handle.toolLog().length) throw new HarnessError("m08.no-read", `${id} 没有实际读取固定材料或执行核验工具`);
		result.status = "completed";
	} catch (error) { result.failure = (error as Error).message; record.failures.push(`${role} ${id} 失败：${result.failure}`); }
	finally {
		try {
			if (result.report !== undefined) await ctx.ws.writeOutput(record, `${role}/${id}.md`, result.report, `${role === "selfcheck" ? "自查" : "外审"} ${id} 完整报告`);
			await ctx.ws.writeOutput(record, `${role}/${id}-coverage.json`, JSON.stringify({ status: result.status, failure: result.failure, files: result.coverage, renderedPages, tools: handle?.toolLog() ?? [] }, null, 2), `${role === "selfcheck" ? "自查" : "外审"} ${id} 实际读取范围`);
			if (handle?.toolLog().length) await ctx.ws.writeOutput(record, `${role}/${id}-tool-log.json`, JSON.stringify(handle.toolLog(), null, 2), `${role === "selfcheck" ? "自查" : "外审"} ${id} 核验工具记录`);
		} finally { handle?.dispose(); }
	}
	return result;
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
	const results = new Array<R>(items.length); let next = 0;
	async function worker(): Promise<void> { while (next < items.length) { const i = next++; results[i] = await fn(items[i]); } }
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker)); return results;
}

async function writeAggregate(ctx: StageContext, record: StageRunRecord, manifest: FrozenArtifactManifest, selfChecks: M08MemberResult[], reviews: M08MemberResult[], notStartedReviewers: string[]): Promise<void> {
	await ctx.ws.writeOutput(record, "failed-batch.json", JSON.stringify({ m08RunId: record.runId, manifestPath: path.join(manifest.rootDir, "manifest.json"), selfChecks, reviews, notStartedReviewers }, null, 2), "M08 失败批次汇总");
}

async function readTreeBytes(root: string): Promise<Map<string, Buffer>> {
	const out = new Map<string, Buffer>();
	async function walk(dir: string): Promise<void> { for (const name of (await readdir(dir)).sort()) { const absolute = path.join(dir, name); const info = await lstat(absolute); const rel = path.relative(root, absolute); if (info.isSymbolicLink()) throw new HarnessError("m08.frozen-symlink", `固定材料出现符号链接：${rel}`); if (info.isDirectory()) await walk(absolute); else if (info.isFile()) out.set(rel, await readFile(absolute)); } }
	await walk(root); return out;
}
async function assertTreeBytes(root: string, before: Map<string, Buffer>): Promise<void> { const after = await readTreeBytes(root); if (after.size !== before.size || [...before].some(([name, bytes]) => !after.get(name)?.equals(bytes))) throw new HarnessError("m08.frozen-mutated", "核验期间固定材料发生字节变化，不能声称审查了同一版本"); }

function list(manifest: FrozenArtifactManifest): string { return manifest.entries.map((x) => `- ${x.label} [${x.sourceCategory}]：${x.relativePath}；提供范围：${x.providedScope ?? "未说明"}`).join("\n") + `\n- 未提供范围：${manifest.unprovidedScopes.length ? manifest.unprovidedScopes.join("；") : "无已声明项"}`; }
const ACCEPTANCE_SCOPE_CONTRACT = "验收范围以固定原始问题、用户明确澄清与授权为基准。材料列出的可选语言、工具、方法或接口不自动意味着必须全部实现。如提出新的验收项，必须定位到原要求，或说明它为何是验证已有要求的必要检查；不得将评审偏好自动升级为用户义务。本项目不要求文件哈希核验，已有内容、版本固定或一致性检查不自动新增哈希义务。";
async function selfMessage(task: M08Task, manifest: FrozenArtifactManifest): Promise<string> { return [await loadPrompt("P08M"), section(`本轮独立自查任务 ${task.id}`, task.instruction), section("固定材料清单", list(manifest)), ACCEPTANCE_SCOPE_CONTRACT, "必须直接使用只读工具核对固定材料。完整报告末尾列出实际读取文件、PDF页、未读取与无法判断范围；不得把清单或摘要当已核对事实。"].join("\n\n"); }
async function reviewMessage(id: string, manifest: FrozenArtifactManifest): Promise<string> { const problem = manifest.entries.find((x) => x.sourceCategory === "original-problem")!; return [await loadPrompt("P08E"), section("固定原始问题（先据此独立理解目标）", `请先读取 ${problem.relativePath} 全文。`), section(`外审 ${id} 可读的同版本实际材料`, list(manifest)), ACCEPTANCE_SCOPE_CONTRACT, "不得读取或推断其他评审意见及内部自查报告。必须直接读取实际材料，并在末尾报告读取文件、PDF页、未读范围与工具限制。"].join("\n\n"); }
function renderBundle(record: StageRunRecord, manifest: FrozenArtifactManifest, selfChecks: M08MemberResult[], reviews: M08MemberResult[], options: M08Options): string { const block = (title: string, xs: M08MemberResult[]) => [`## ${title}`, ...xs.flatMap((x) => [`### ${x.id}`, `- 状态：${x.status}`, `- 实际读取：${x.coverage.join("、") || "无"}`, `- PDF 页面：${x.renderedPages.join("、") || "无"}`, "", x.report ?? `失败：${x.failure}`])].join("\n"); return [`# M08 审查反馈包`, "", `- M08 运行：${record.runId}`, `- 固定知识快照：${record.knowledgeSnapshot ?? "无"}`, `- 前次运行：${options.previousRunId ?? "无"}`, `- 变化：${options.changeSummary ?? "首次审查"}`, `- 影响范围：${options.affectedScope ?? "本轮全部选定材料"}`, "", "完成只表示选定成员全部返回；以下意见待 M04 实质处理，不构成投票或科研通过。", "", "## 固定材料与披露", list(manifest), "", block("内部独立自查", selfChecks), "", block("外部审查", reviews)].join("\n"); }
