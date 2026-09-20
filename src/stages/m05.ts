/**
 * M05 外部知识获取.
 *
 * Boundary (foundation, M05 本轮已对齐): the whole web is in scope (papers, docs, forums,
 * communities); ordinary acquisition runs without per-step human approval; nothing is
 * bought and access controls are never bypassed, paywalled works are sought as open
 * versions; abstracts and relevant passages may be read for screening, which is kept
 * distinct from M06 reading. The stage gives one acquisition session a fixed tool set;
 * every tool call is logged, every search goes to references/search, and only files that
 * were actually obtained can be registered under references/sources.
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { buildM05Message, problemBlock, systemPromptFor } from "../prompts.ts";
import { listSources, readIndex, registerSource, SearchLog, type SourceFile, type SourceKind } from "../references.ts";
import type { CustomToolSpec, ToolCallRecord } from "../runner/types.ts";
import type { AcquisitionBackend } from "../tools/backend.ts";
import { defaultBackend } from "../tools/backend.ts";
import { renderPageTool } from "../tools/pagetool.ts";
import { HarnessError, type StageRunRecord } from "../types.ts";
import { writeFileAtomic } from "../workspace.ts";
import { loadProblemMaterials, recordSession, relPath, sessionSpec, withRun, type StageContext } from "./context.ts";

export interface M05Options {
	/** 本轮知识需求 (the placeholder of P05). Defaults to a generic gap-driven goal. */
	goal?: string;
	backend?: AcquisitionBackend;
	/** Maximum characters returned to the model per tool result. */
	maxToolText?: number;
	noBrowser?: boolean;
}

export interface M05Result {
	record: StageRunRecord;
	report: string;
	registered: string[];
	toolLog: ToolCallRecord[];
}

const SOURCE_KINDS: SourceKind[] = ["paper", "preprint", "webpage", "forum", "dataset", "book", "code", "documentation", "other"];

function clip(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max)}\n…（已截断，共 ${text.length} 字符，可用 read_work_file 分段读取）` : text;
}

function str(args: Record<string, unknown>, key: string, required = true): string {
	const value = args[key];
	if (typeof value === "string" && value.trim()) return value.trim();
	if (required) throw new HarnessError("tool.args", `参数 ${key} 必须是非空字符串`);
	return "";
}

function num(args: Record<string, unknown>, key: string, fallback: number, max: number): number {
	const value = args[key];
	if (value === undefined || value === null) return fallback;
	if (typeof value !== "number" || !Number.isFinite(value) || value < 1) throw new HarnessError("tool.args", `参数 ${key} 必须是正数`);
	return Math.min(Math.floor(value), max);
}

export async function runM05(ctx: StageContext, options: M05Options = {}): Promise<M05Result> {
	const backend = options.backend ?? defaultBackend(ctx.config.tools);
	const goal = options.goal?.trim() || "围绕原始问题、当前认识、候选判据与未决项，补齐能推进研究的外部材料；先判断缺口类型，再有限概览与定点查证。";
	const { materials, inputs } = await loadProblemMaterials(ctx.ws);
	const snapshot = await ctx.store.current();
	const indexBefore = await readIndex(ctx.ws);
	const record = await ctx.ws.startRun("M05", [...inputs, ...(indexBefore ? [{ label: "已有来源索引", path: path.join(ctx.ws.referencesDir, "INDEX.md") }] : [])], snapshot?.id);
	record.remarks.push(...backend.describe());
	const maxToolText = options.maxToolText ?? 6_000;

	return withRun(
		ctx,
		record,
		async () => {
			const workDir = path.join(ctx.ws.referencesDir, "_work", record.runId);
			await mkdir(workDir, { recursive: true });
			const workReal = await realpath(workDir);
			const sourcesRoot = path.join(ctx.ws.referencesDir, "sources");
			await mkdir(sourcesRoot, { recursive: true });
			const sourcesReal = await realpath(sourcesRoot);
			const displayConfinedPath = (resolved: string): string => {
				if (resolved === workReal || resolved.startsWith(`${workReal}${path.sep}`)) return path.join(relPath(ctx, workDir), path.relative(workReal, resolved));
				if (resolved === sourcesReal || resolved.startsWith(`${sourcesReal}${path.sep}`)) return path.join(relPath(ctx, sourcesRoot), path.relative(sourcesReal, resolved));
				return relPath(ctx, resolved);
			};
			const searchLog = await SearchLog.create(ctx.ws, record.runId, goal);
			record.outputs.push({ label: "检索记录", path: searchLog.file });
			const registered: string[] = [];
			const toolLogPath = path.join(ctx.ws.runDir(record.stage, record.runId), "tool-log.jsonl");
			let toolLogText = "";
			const logTool = async (name: string, args: unknown, summary: unknown): Promise<void> => {
				toolLogText += `${JSON.stringify({ at: new Date().toISOString(), name, args, summary })}\n`;
				await writeFileAtomic(toolLogPath, toolLogText);
			};
			let counter = 0;
			const fetchedPages = new Map<string, { links: Array<{ text: string; href: string }>; total?: number; complete?: boolean }>();
			const artifactFacts = new Map<string, { url?: string; title?: string; capturedAt?: string; contentType?: string; kind?: string; derivedFrom?: string }>();
			const browserReports = new Set<string>();
			const nextDir = async (prefix: string): Promise<string> => {
				const dir = path.join(workDir, `${prefix}-${String(++counter).padStart(3, "0")}`);
				await mkdir(dir, { recursive: true });
				return dir;
			};
			const confine = async (requested: string): Promise<string> => {
				const candidates = path.isAbsolute(requested) ? [requested] : [path.resolve(ctx.ws.root, requested), path.resolve(workDir, requested)];
				let resolved: string | undefined;
				for (const candidate of candidates) {
					resolved = await realpath(candidate).catch(() => undefined);
					if (resolved) break;
				}
				if (!resolved) {
					throw new HarnessError("tool.path", `文件不存在：${requested}`);
				}
				const inside = (root: string) => resolved === root || resolved.startsWith(`${root}${path.sep}`);
				if (!inside(workReal) && !inside(sourcesReal)) throw new HarnessError("tool.path", `只能读取本轮工作目录或已登记来源中的文件：${requested}`);
				return resolved;
			};

			const tools: CustomToolSpec[] = [
				{
					name: "web_search",
					description: `检索外部材料。可用来源：${backend.providers.map((p) => `${p.name}（${p.description}）`).join("；")}。返回命中列表（线索，不是证据）。每次检索都会记入检索记录。`,
					params: {
						query: { type: "string", description: "检索式；根据实际读到的术语、同义词和引用链迭代" },
						providers: { type: "string[]", description: `只使用这些来源：${backend.providers.map((p) => p.name).join(", ")}；省略则全部`, optional: true },
						limit: { type: "number", description: "每个来源最多返回条数，默认 10，上限 30", optional: true },
						page: { type: "number", description: "一基页码；仅支持页码的提供方应用", optional: true },
						cursor: { type: "string", description: "提供方上次返回的不透明续查游标", optional: true },
						site: { type: "string", description: "站点/域名限定；Stack Exchange 为站点名，通用网页检索为域名", optional: true },
					},
					async execute(args) {
						const query = str(args, "query");
						const limit = num(args, "limit", 10, 30);
						const page = args.page === undefined ? undefined : num(args, "page", 1, 100_000);
						const cursor = str(args, "cursor", false) || undefined;
						const site = str(args, "site", false) || undefined;
						const wanted = Array.isArray(args.providers) && args.providers.length ? (args.providers as string[]) : backend.providers.map((p) => p.name);
						if (cursor && wanted.length !== 1) throw new HarnessError("tool.args", "cursor 是提供方专属的不透明令牌；使用 cursor 时必须明确且只选择一个 provider");
						const unknown = wanted.filter((name) => !backend.providers.some((provider) => provider.name === name));
						if (unknown.length) throw new HarnessError("tool.args", `未知检索来源：${unknown.join("、")}`);
						const lines: string[] = [];
						const searchDir = await nextDir("search");
						const outcomes: unknown[] = [];
						for (const provider of backend.providers) {
							if (!wanted.includes(provider.name)) continue;
							const at = new Date().toISOString();
							try {
								const outcome = await provider.search(query, { limit, page, cursor, site });
								outcomes.push(outcome);
								await searchLog.append({ at, provider: provider.name, query: outcome.query, site, limit, endpoint: outcome.endpoint, hits: outcome.hits, warnings: outcome.warnings, page: outcome.page, nextPage: outcome.nextPage, cursor: cursor ? "已提供" : undefined, nextCursor: outcome.nextCursor });
								lines.push(`## ${provider.name}（${outcome.hits.length} 条${outcome.page ? `；第 ${outcome.page} 页` : ""}${outcome.nextPage ? `；下一页 ${outcome.nextPage}` : ""}${outcome.nextCursor ? `；下一游标 ${outcome.nextCursor}` : ""}${outcome.warnings.length ? `；警告：${outcome.warnings.join("；")}` : ""}）`);
								outcome.hits.forEach((h, i) => {
									const discussionUrl = (h as typeof h & { discussionUrl?: string }).discussionUrl;
									lines.push(`${i + 1}. ${h.title}\n   URL: ${h.url}${discussionUrl ? `\n   讨论页: ${discussionUrl}` : ""}${h.doi ? `\n   DOI: ${h.doi}` : ""}${h.oaUrl ? `\n   开放版本: ${h.oaUrl}` : ""}${h.date ? `\n   日期: ${h.date}` : ""}${h.authors?.length ? `\n   作者: ${h.authors.slice(0, 6).join(", ")}` : ""}${h.venue ? `\n   来源: ${h.venue}` : ""}${h.snippet ? `\n   摘要片段: ${h.snippet.replace(/\s+/g, " ").slice(0, 400)}` : ""}`);
								});
							} catch (error) {
								outcomes.push({ provider: provider.name, query, limit, page, cursorProvided: Boolean(cursor), site, error: (error as Error).message });
								await searchLog.append({ at, provider: provider.name, query, site, limit, endpoint: "", hits: [], warnings: [`本次有范围的检索失败：${(error as Error).message}`], page, cursor: cursor ? "已提供" : undefined });
								lines.push(`## ${provider.name}：失败 ${(error as Error).message}`);
							}
						}
						const text = lines.join("\n") || "没有可用的检索来源";
						const resultPath = path.join(searchDir, "results.md");
						const outcomePath = path.join(searchDir, "outcomes.json");
						await writeFileAtomic(resultPath, `${text}\n`);
						await writeFileAtomic(outcomePath, `${JSON.stringify(outcomes, null, 2)}\n`);
						await logTool("web_search", { query, providers: wanted, limit, page, cursor: cursor ? "已提供" : undefined, site }, { chars: text.length });
						return { text: `${clip(text, Math.max(500, maxToolText - 260))}\n\n完整展示：${relPath(ctx, resultPath)}；完整结构化结果：${relPath(ctx, outcomePath)}（用 read_work_file 分段读取）`, details: { resultPath, outcomePath, chars: text.length } };
					},
				},
				{
					name: "find_open_access",
					description: "按 DOI 或 arXiv 标识查找合法的开放获取版本（作者稿、预印本、机构库）。不购买、不绕过付费墙。",
					params: { identifier: { type: "string", description: "DOI、doi.org 地址或 arXiv 地址/编号" } },
					async execute(args) {
						const identifier = str(args, "identifier");
						const result = await backend.findOpenAccess(identifier);
						await logTool("find_open_access", { identifier }, result);
						const text = result.found
							? `识别为 ${result.kind}；${result.title ? `题名：${result.title}\n` : ""}开放获取：${result.isOa ? "是" : "否/未知"}\n开放版本地址：${result.oaUrl ?? "无"}\n落地页：${result.landingUrl ?? "无"}\n许可：${result.license ?? "未知"}\n${result.warnings.join("；")}`
							: `未找到：${result.warnings.join("；")}`;
						return { text, details: result };
					},
				},
				{
					name: "fetch_page",
					description: "抓取一个网页为 markdown（Crawl4AI 可用时渲染 JavaScript，否则纯 HTTP）。非 HTML 地址会保存为文件。返回正文开头与元数据；完整内容用 read_work_file 读取。",
					params: { url: { type: "string", description: "http(s) 地址" } },
					async execute(args) {
						const url = str(args, "url");
						if (!/^https?:\/\//i.test(url)) throw new HarnessError("tool.args", "只接受 http(s) 地址");
						const outDir = await nextDir("fetch");
						const result = await backend.fetchPage(url, outDir, { noBrowser: options.noBrowser });
						const pageId = path.basename(outDir);
						if (result.kind === "page") fetchedPages.set(pageId, { links: result.links, total: result.linksTotal, complete: result.linksComplete });
						const fetchFacts = { url: result.finalUrl || result.url, title: result.title || undefined, capturedAt: result.fetchedAt, contentType: result.contentType || undefined };
						if (result.markdownPath) artifactFacts.set(await confine(result.markdownPath), { ...fetchFacts, kind: "markdown" });
						if (result.htmlPath) artifactFacts.set(await confine(result.htmlPath), { ...fetchFacts, kind: "html" });
						if (result.filePath) artifactFacts.set(await confine(result.filePath), { ...fetchFacts, kind: "download" });
						await logTool("fetch_page", { url }, { engine: result.engine, kind: result.kind, status: result.status, bytes: result.bytes, error: result.error, warnings: result.warnings });
						const head = result.markdownPath && existsSync(result.markdownPath) ? await readFile(result.markdownPath, "utf8") : "";
						const text = [
							`引擎：${result.engine}；类型：${result.kind}；HTTP：${result.status ?? "无"}；内容类型：${result.contentType || "未知"}；字节：${result.bytes}`,
							result.title ? `标题：${result.title}` : "",
							result.markdownPath ? `正文文件：${relPath(ctx, result.markdownPath)}` : "",
							result.filePath ? `已保存文件：${relPath(ctx, result.filePath)}（可用 extract_pdf 提取）` : "",
							result.warnings.length ? `警告：${result.warnings.join("；")}` : "",
							result.error ? `错误：${result.error}` : "",
							result.kind === "page" ? `链接集：${pageId}；已保存 ${result.links.length}/${result.linksTotal ?? "总数未知"} 条；${result.linksComplete === true ? "链接提取完整" : result.linksComplete === false ? "链接提取不完整，按警告续取" : "链接提取完整性未知"}。用 list_page_links 分页查看。` : "链接提取：不适用（取得的是文件而非网页）",
							head ? `\n正文开头：\n${clip(head, Math.max(1_000, maxToolText - 800))}` : "",
						].filter(Boolean).join("\n");
						return { text, details: { ...result, links: undefined, pageId, linkCount: result.links.length } };
					},
				},
				{
					name: "list_page_links",
					description: "分页查看 fetch_page 已保存的完整链接集，避免工具输出截断造成盲区。不会自动递归抓取链接。",
					params: { page_id: { type: "string", description: "fetch_page 返回的链接集 ID" }, offset: { type: "number", description: "从第几条开始，默认 0", optional: true }, limit: { type: "number", description: "返回条数，默认 50，上限 200", optional: true } },
					async execute(args) {
						const pageId = str(args, "page_id");
						const page = fetchedPages.get(pageId);
						if (!page) throw new HarnessError("tool.args", `未知链接集：${pageId}`);
						const offset = args.offset === undefined ? 0 : Math.max(0, Math.floor(Number(args.offset)));
						const limit = num(args, "limit", 50, 200);
						const rows = page.links.slice(offset, offset + limit).map((link, index) => `${offset + index + 1}. ${link.text || "（无链接文字）"}\n   ${link.href}`);
						await logTool("list_page_links", { pageId, offset, limit }, { returned: rows.length, retained: page.links.length, total: page.total, complete: page.complete });
						const header = `链接集 ${pageId}：原页识别 ${page.total ?? "未知"} 条，保存 ${page.links.length} 条，${page.complete === true ? "链接提取完整" : page.complete === false ? "链接提取不完整" : "链接提取完整性未知"}；请求范围 ${offset}–${offset + rows.length}`;
						return { text: clip(`${header}\n${rows.join("\n") || "（此范围无链接）"}\n若输出截断，请缩小 limit 并从后续 offset 继续。`, maxToolText) };
					},
				},
				{
					name: "download_file",
					description: "下载文件（如 PDF）到本轮工作目录。只下载合法可访问的地址。",
					params: { url: { type: "string", description: "文件地址" }, filename: { type: "string", description: "保存文件名，可省略", optional: true } },
					async execute(args) {
						const url = str(args, "url");
						if (!/^https?:\/\//i.test(url)) throw new HarnessError("tool.args", "只接受 http(s) 地址");
						const name = (str(args, "filename", false) || path.basename(new URL(url).pathname) || "download").replace(/[^\w.\-]+/g, "_");
						const dir = await nextDir("download");
						const dest = path.join(dir, name.includes(".") ? name : `${name}.bin`);
						const result = await backend.downloadFile(url, dest);
						artifactFacts.set(await confine(result.path), { url: result.finalUrl || result.url, capturedAt: new Date().toISOString(), contentType: result.contentType || undefined, kind: "download" });
						await logTool("download_file", { url, filename: name }, { status: result.status, contentType: result.contentType, bytes: result.bytes, path: relPath(ctx, result.path) });
						return { text: `已下载：${relPath(ctx, result.path)}\nHTTP：${result.status}；内容类型：${result.contentType || "未知"}；字节：${result.bytes}${result.contentType.toLowerCase().includes("pdf") || dest.endsWith(".pdf") ? "\n这是 PDF，可用 extract_pdf 提取文本后阅读" : ""}`, details: result };
					},
				},
				{
					name: "extract_pdf",
					description: "用 pdftotext 把本轮工作目录中的 PDF 文本层提取为 markdown（不运行本地模型；公式、表格、图和扫描件请用 render_pdf_page 查看页面）。返回提取信息与开头文本。",
					params: { path: { type: "string", description: "PDF 路径（fetch_page/download_file 返回的路径）" }, max_pages: { type: "number", description: "只提取前 N 页，用于初筛；省略为全文", optional: true } },
					async execute(args) {
						const pdfPath = await confine(str(args, "path"));
						if (!pdfPath.toLowerCase().endsWith(".pdf")) throw new HarnessError("tool.args", "只接受 .pdf 文件");
						const maxPages = args.max_pages === undefined ? undefined : num(args, "max_pages", 3, 500);
						const outDir = await nextDir("extract");
						const result = await backend.extractPdf(pdfPath, outDir, { maxPages });
						if (result.markdownPath) {
							const sourceFacts = artifactFacts.get(pdfPath);
							artifactFacts.set(await confine(result.markdownPath), { ...sourceFacts, kind: "markdown", derivedFrom: displayConfinedPath(pdfPath) });
						}
						await logTool("extract_pdf", { path: relPath(ctx, pdfPath), maxPages }, { engine: result.engine, pages: result.pages, ocr: result.ocr, truncated: result.truncated, error: result.error, warnings: result.warnings });
						if (result.error || !result.markdownPath) return { text: `提取失败：${result.error ?? "无输出"}；${result.warnings.join("；")}`, details: result };
						const head = await readFile(result.markdownPath, "utf8");
						return { text: `引擎：${result.engine}${result.engineVersion ? ` ${result.engineVersion}` : ""}；页数：${result.pages ?? "未知"}；OCR：${result.ocr ? "是" : "否"}；${result.truncated ? `只提取前 ${maxPages} 页；` : "全文；"}文件：${relPath(ctx, result.markdownPath)}${result.warnings.length ? `\n警告：${result.warnings.join("；")}` : ""}\n\n开头：\n${clip(head, Math.max(1_000, maxToolText - 600))}`, details: result };
					},
				},
				renderPageTool({
					root: workDir,
					tools: ctx.config.tools,
					extraRoots: [sourcesRoot],
					onRendered: ({ pdf, page }) => logTool("render_pdf_page", { file: relPath(ctx, pdf), page }, {}),
				}),
				{
					name: "read_work_file",
					description: "读取本轮工作目录或已登记来源中的文本文件片段，用于初筛摘要、目录、相关段落。不是 M06 的正式阅读。",
					params: { path: { type: "string", description: "文件路径" }, offset: { type: "number", description: "起始字符偏移，默认 0", optional: true }, limit: { type: "number", description: "读取字符数，默认 6000", optional: true } },
					async execute(args) {
						const filePath = await confine(str(args, "path"));
						if (/\.(pdf|png|jpg|jpeg|gif|zip|bin)$/i.test(filePath)) throw new HarnessError("tool.args", "该文件不是文本；PDF 请先 extract_pdf");
						const info = await stat(filePath);
						const text = await readFile(filePath, "utf8");
						const offset = args.offset === undefined ? 0 : Math.max(0, Math.floor(Number(args.offset)));
						const limit = num(args, "limit", 6_000, maxToolText);
						const slice = text.slice(offset, offset + limit);
						await logTool("read_work_file", { path: relPath(ctx, filePath), offset, limit }, { bytes: info.size, returned: slice.length });
						return { text: `文件 ${relPath(ctx, filePath)}（共 ${text.length} 字符，返回 ${offset}–${offset + slice.length}）：\n${slice}` };
					},
				},
				{
					name: "view_work_image",
					description: "直接查看本轮工作目录或已登记来源中的 PNG/JPEG/GIF/WebP 图片，例如交互式浏览器保存的截图。",
					params: { path: { type: "string", description: "图片文件路径" } },
					async execute(args) {
						const imagePath = await confine(str(args, "path"));
						const ext = path.extname(imagePath).toLowerCase();
						const mimeType = ({ ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" } as Record<string, string>)[ext];
						if (!mimeType) throw new HarnessError("tool.args", "只接受 PNG、JPEG、GIF 或 WebP 图片");
						const info = await stat(imagePath);
						if (info.size > 10 * 1024 * 1024) throw new HarnessError("tool.args", `图片为 ${info.size} 字节，超过 10 MiB 的单次查看上限；文件仍保留，可登记或另行缩小后查看`);
						const signature = (await readFile(imagePath)).subarray(0, 12);
						const valid = ext === ".png" ? signature.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) : ext === ".jpg" || ext === ".jpeg" ? signature[0] === 0xff && signature[1] === 0xd8 : ext === ".gif" ? signature.subarray(0, 3).toString("ascii") === "GIF" : signature.subarray(0, 4).toString("ascii") === "RIFF" && signature.subarray(8, 12).toString("ascii") === "WEBP";
						if (!valid) throw new HarnessError("tool.args", "文件扩展名与图片签名不符，拒绝作为图片显示");
						await logTool("view_work_image", { path: relPath(ctx, imagePath) }, { bytes: info.size, mimeType });
						return { text: `图片 ${relPath(ctx, imagePath)}（${info.size} 字节）`, images: [{ path: imagePath, mimeType }] };
					},
				},
				{
					name: "register_source",
					description: "把实际取得的材料正式登记为来源（分配 S 编号、写 source.md、更新索引）。只登记本轮实际取得的文件；PDF 会自动附带提取文本。未取得的材料不登记，只在报告里写为线索或缺口。",
					params: {
						title: { type: "string", description: "标题" },
						kind: { type: "string", description: `类型：${SOURCE_KINDS.join(" | ")}` },
						files: { type: "string[]", description: "本轮取得的文件路径（fetch_page/download_file/extract_pdf 返回的路径）" },
						obtained_range: { type: "string", description: "实际取得范围：全文 / 摘要 / 部分页（写明页数） / 仅元数据" },
						relevance: { type: "string", description: "与当前缺口的关系（登记理由，不是有效性判断）" },
						authors: { type: "string", description: "作者/机构", optional: true },
						identifier: { type: "string", description: "DOI、arXiv 编号等", optional: true },
						url: { type: "string", description: "地址", optional: true },
						version: { type: "string", description: "版本/日期", optional: true },
						completeness: { type: "string", description: "完整性与缺失（缺页、附件未取得等）", optional: true },
						notes: { type: "string", description: "备注", optional: true },
					},
					async execute(args) {
						const kind = str(args, "kind") as SourceKind;
						if (!SOURCE_KINDS.includes(kind)) throw new HarnessError("tool.args", `kind 必须是 ${SOURCE_KINDS.join(" | ")}`);
						if (!Array.isArray(args.files) || !args.files.length) throw new HarnessError("tool.args", "files 必须列出实际取得的文件");
						const files: SourceFile[] = [];
						for (const f of args.files as unknown[]) {
							const resolved = await confine(String(f));
							if (resolved.startsWith(`${sourcesReal}${path.sep}`)) throw new HarnessError("tool.args", `文件已属于已登记来源，不重复登记：${String(f)}`);
							if (browserReports.has(resolved)) throw new HarnessError("tool.args", "browser-use 的 result.md 是模型报告，不是外部原始材料，不能登记；请登记 artifacts 中实际保存的页面、截图或下载件");
							const provenance = artifactFacts.get(resolved);
							const role: SourceFile["role"] = provenance?.kind === "screenshot" ? "page-image" : provenance?.kind === "download" || provenance?.kind === "html" ? "original" : /\.pdf$/i.test(resolved) ? "original" : /extracted\.md$|page\.md$/i.test(resolved) || provenance?.kind === "markdown" ? "extracted" : "other";
							files.push({ path: resolved, role, provenance });
						}
						const pdf = files.find((f) => f.role === "original" && /\.pdf$/i.test(f.path));
						if (pdf && !files.some((f) => f.role === "extracted")) {
							const outDir = await nextDir("extract");
							const extracted = await backend.extractPdf(pdf.path, outDir);
							if (extracted.markdownPath) {
								const sourceFacts = artifactFacts.get(pdf.path);
								const provenance = { ...sourceFacts, kind: "markdown", derivedFrom: displayConfinedPath(pdf.path) };
								artifactFacts.set(await confine(extracted.markdownPath), provenance);
								files.push({ path: extracted.markdownPath, role: "extracted", note: `提取引擎 ${extracted.engine}${extracted.ocr ? "（OCR）" : ""}`, provenance });
							}
							else files.push({ path: pdf.path, role: "other", note: `文本提取失败：${extracted.error ?? "未知"}` });
						}
						const result = await registerSource(ctx.ws, {
							title: str(args, "title"),
							kind,
							authors: str(args, "authors", false) || undefined,
							identifier: str(args, "identifier", false) || undefined,
							url: str(args, "url", false) || undefined,
							version: str(args, "version", false) || undefined,
							obtainedRange: str(args, "obtained_range"),
							completeness: str(args, "completeness", false) || undefined,
							notes: str(args, "notes", false) || undefined,
							relevance: str(args, "relevance"),
							files,
							registeredBy: { stage: "M05", runId: record.runId, session: "M05" },
						});
						registered.push(result.id);
						await logTool("register_source", { title: args.title, kind, files: files.map((f) => relPath(ctx, f.path)) }, { id: result.id });
						await searchLog.appendNote(`- 已登记 ${result.id}：${String(args.title)}（${str(args, "obtained_range")}）`);
						return { text: `已登记 ${result.id}：${relPath(ctx, result.sourceFile)}\n文件：${result.files.map((f) => path.basename(f)).join("、")}`, details: result };
					},
				},
				...(backend.browseInteractive
					? [
							{
								name: "browse_interactive",
								description: "用 browser-use 完成适合交互浏览的定点任务（展开、翻页、站内检索、保留线程上下文、获取附件等）。尊重访问控制且不购买付费内容。result.md 是浏览器 agent 报告，不是原始材料；artifacts 才是可登记的实际材料。",
								params: { url: { type: "string", description: "起始地址" }, task: { type: "string", description: "具体任务与计划取得范围" }, max_steps: { type: "number", description: "最多交互步数", optional: true } },
								async execute(args: Record<string, unknown>) {
									const url = str(args, "url");
									const task = str(args, "task");
									if (!/^https?:\/\//i.test(url)) throw new HarnessError("tool.args", "只接受 http(s) 地址");
									const outDir = await nextDir("browse");
									const maxSteps = args.max_steps === undefined ? undefined : num(args, "max_steps", 20, 200);
									const result = await backend.browseInteractive!(url, task, outDir, { maxSteps });
									if (result.resultPath) browserReports.add(await confine(result.resultPath));
									for (const artifact of result.artifacts ?? []) artifactFacts.set(await confine(artifact.path), { kind: artifact.kind, url: artifact.url, title: artifact.title, capturedAt: artifact.capturedAt, contentType: artifact.contentType });
									await logTool("browse_interactive", { url, task, maxSteps }, { model: result.model, steps: result.steps, artifacts: result.artifacts?.length ?? 0, visitedUrls: result.visitedUrls?.length ?? 0, error: result.error, warnings: result.warnings });
									const artifactLines = (result.artifacts ?? []).map((artifact, i) => `${i + 1}. ${artifact.kind}：${relPath(ctx, artifact.path)}${artifact.url ? `\n   来源：${artifact.url}` : ""}${artifact.contentType ? `；${artifact.contentType}` : ""}`);
									const manifestPath = path.join(outDir, "artifacts.md");
									await writeFileAtomic(manifestPath, `# 浏览器任务取得记录\n\n- 起始地址：${url}\n- 任务：${task}\n- 错误：${result.error ?? "无"}\n- 警告：${result.warnings.join("；") || "无"}\n\n## 实际材料\n\n${artifactLines.join("\n") || "无"}\n\n## 访问地址\n\n${result.visitedUrls?.map((visited) => `- ${visited}`).join("\n") || "未记录"}\n`);
									const text = [`模型：${result.model}；步数：${result.steps ?? "未知"}`, `取得记录：${relPath(ctx, manifestPath)}（完整 artifacts/访问地址可用 read_work_file 分段读取）`, `报告文件（不可作为原始来源登记）：${result.resultPath ? relPath(ctx, result.resultPath) : "无"}`, `实际材料 artifacts（即使任务部分失败也保留）：\n${artifactLines.join("\n") || "无"}`, `访问地址：${result.visitedUrls?.join("、") || "未记录"}`, result.warnings.length ? `警告：${result.warnings.join("；")}` : "", result.error ? `错误：${result.error}` : "", result.resultText ? `\n浏览器报告：\n${result.resultText}` : ""].filter(Boolean).join("\n");
									return { text: clip(text, maxToolText), details: { ...result, manifestPath } };
								},
							} satisfies CustomToolSpec,
						]
					: []),
				{
					name: "list_sources",
					description: "列出已登记的来源索引，避免重复登记。",
					params: {},
					async execute() {
						const index = await readIndex(ctx.ws);
						await logTool("list_sources", {}, { chars: index.length });
						return { text: index || "（尚无登记来源）" };
					},
				},
			];

			const pack = await ctx.store.buildPack({ purpose: `M05 知识获取：${goal.slice(0, 60)}`, includeOpenQuestions: true, types: ["C", "K", "Q", "X"], maxChars: 30_000 });
			const message = await buildM05Message({ goal, problem: problemBlock(materials), knowledgePack: pack.included.length ? pack.markdown : undefined, indexText: indexBefore, providerNames: backend.providers.map((p) => p.name), toolNames: tools.map((t) => t.name) });
			await ctx.ws.writeOutput(record, "message.md", message, "发送给获取会话的完整消息");
			const handle = await ctx.runner.create(sessionSpec(ctx, "M05", "acquisition", systemPromptFor("acquisition"), { kind: "custom", tools }));
			let report: string;
			let toolLog: ToolCallRecord[];
			try {
				recordSession(record, handle);
				const turn = await handle.prompt(message);
				report = turn.text;
				toolLog = handle.toolLog();
			} finally {
				handle.dispose();
			}
			await ctx.ws.writeOutput(record, "acquisition-report.md", report, "获取报告");
			if (existsSync(toolLogPath)) record.outputs.push({ label: "工具调用记录", path: toolLogPath });
			for (const header of ["## 已取得并登记", "## 未解决缺口"]) {
				if (!report.includes(header)) record.failures.push(`获取报告缺少小节“${header}”，需人工核对报告与检索记录`);
			}
			if (!toolLog.length) record.remarks.push("会话没有调用任何工具；报告内容未经检索或抓取，只能视为说明。");
			record.remarks.push(`本轮登记来源：${registered.length ? registered.join("、") : "无"}；工具调用 ${toolLog.length} 次。`);
			const all = await listSources(ctx.ws);
			record.remarks.push(`当前来源总数：${all.length}。下一步：node src/cli.ts m06${registered.length ? ` --source ${registered.join(" --source ")}` : ""}`);
			return { record, report, registered, toolLog };
		},
		() => `按 P05 建立获取会话（工具：检索、开放版本查找、抓取、下载、PDF 提取、初筛读取、登记）。检索式与命中记入 references/search，实际取得的材料登记为 S 编号；未取得的只作线索或缺口。`,
	);
}
