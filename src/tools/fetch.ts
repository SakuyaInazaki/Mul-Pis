/**
 * Page fetching for M05. Primary engine: Crawl4AI through tools/py/fetch_page.py (headless
 * Chromium, markdown output). Fallback: plain HTTP with a minimal HTML→text conversion so the
 * stage still works without the Python stack, with the engine recorded honestly in meta.json.
 */
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ToolsConfig } from "../types.ts";
import { writeFileAtomic } from "../workspace.ts";
import { extensionForContentType, fetchText, htmlToText, downloadToFile } from "./http.ts";
import { pythonScriptsDir, runScript, venvPython } from "./python.ts";

export interface FetchResult {
	url: string;
	finalUrl: string;
	status: number | null;
	title: string;
	fetchedAt: string;
	engine: "crawl4ai" | "http";
	kind: "page" | "file";
	contentType: string;
	bytes: number;
	markdownPath?: string;
	htmlPath?: string;
	filePath?: string;
	links: Array<{ text: string; href: string }>;
	linksTotal?: number;
	linksComplete?: boolean;
	warnings: string[];
	error: string | null;
}

export interface FetchOptions {
	timeoutMs?: number;
	/** Skip the browser engine even if installed. */
	noBrowser?: boolean;
}

export async function fetchPage(url: string, outDir: string, tools: ToolsConfig, options: FetchOptions = {}): Promise<FetchResult> {
	await mkdir(outDir, { recursive: true });
	const python = options.noBrowser ? undefined : venvPython(tools);
	if (python) {
		const args = [url, "--out", outDir, "--timeout", String(Math.ceil((options.timeoutMs ?? 60_000) / 1000))];
		const run = await runScript(python, path.join(pythonScriptsDir(), "fetch_page.py"), args, { timeoutMs: (options.timeoutMs ?? 60_000) + 60_000 });
		if (run.json && typeof run.json.engine === "string") {
			const meta = run.json as unknown as FetchResult;
			meta.warnings = Array.isArray(meta.warnings) ? meta.warnings : [];
			if (run.timedOut) meta.warnings.push("抓取脚本超时被终止");
			return meta;
		}
		const fallback = await httpFetchPage(url, outDir, options);
		fallback.warnings.push(`Crawl4AI 脚本未返回结果（exit ${run.code ?? "null"}），已退回纯 HTTP 抓取：${run.stderr.trim().slice(-300)}`);
		return fallback;
	}
	return httpFetchPage(url, outDir, options);
}

export async function httpFetchPage(url: string, outDir: string, options: FetchOptions = {}): Promise<FetchResult> {
	const fetchedAt = new Date().toISOString();
	const base: FetchResult = { url, finalUrl: url, status: null, title: "", fetchedAt, engine: "http", kind: "page", contentType: "", bytes: 0, links: [], warnings: ["使用纯 HTTP 抓取，未渲染 JavaScript；动态页面内容可能缺失"], error: null };
	try {
		const probe = await fetch(url, { method: "GET", redirect: "follow", signal: AbortSignal.timeout(options.timeoutMs ?? 60_000), headers: { "user-agent": "pre-rsi-research-harness/0.1" } });
		const contentType = probe.headers.get("content-type") ?? "";
		base.status = probe.status;
		base.finalUrl = probe.url || url;
		base.contentType = contentType;
		if (contentType.toLowerCase().includes("html")) {
			const html = await probe.text();
			const { title, text } = htmlToText(html);
			base.title = title;
			base.bytes = Buffer.byteLength(html);
			base.htmlPath = path.join(outDir, "page.html");
			base.markdownPath = path.join(outDir, "page.md");
			await writeFile(base.htmlPath, html, "utf8");
			await writeFile(base.markdownPath, `# ${title || url}\n\n来源：${base.finalUrl}\n抓取时间：${fetchedAt}\n\n${text}\n`, "utf8");
			const allLinks = deduplicateHttpLinks(
				[...html.matchAll(/<a\b[^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a>/gi)]
					.map((m) => ({ text: decodeHtmlEntities(m[4].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim()), href: safeAbsolute(decodeHtmlEntities(m[1] ?? m[2] ?? m[3] ?? ""), base.finalUrl) }))
					.filter((link) => /^https?:\/\//i.test(link.href)),
			);
			base.linksTotal = allLinks.length;
			base.links = allLinks;
			base.linksComplete = probe.status < 400;
			if (!text.trim()) base.error = "页面没有可提取的正文";
		} else {
			const buffer = Buffer.from(await probe.arrayBuffer());
			base.kind = "file";
			base.bytes = buffer.length;
			base.filePath = path.join(outDir, `download${extensionForContentType(contentType, base.finalUrl)}`);
			await writeFile(base.filePath, buffer);
		}
		if (probe.status >= 400) {
			base.error = `HTTP ${probe.status}`;
			base.warnings.push(`目标页返回 HTTP ${probe.status}；已保存响应页供诊断，但不声明目标页链接提取完整`);
		}
	} catch (error) {
		base.error = (error as Error).message;
	}
	await writeFileAtomic(path.join(outDir, "meta.json"), `${JSON.stringify(base, null, 2)}\n`);
	return base;
}

export interface InteractiveResult {
	url: string;
	task: string;
	model: string;
	finishedAt: string;
	steps: number | null;
	resultPath?: string;
	resultText: string;
	artifacts: BrowserArtifact[];
	visitedUrls: string[];
	complete?: boolean;
	warnings: string[];
	error: string | null;
}

export interface BrowserArtifact {
	path: string;
	kind: "html" | "markdown" | "screenshot" | "download";
	url?: string;
	title?: string;
	capturedAt?: string;
	contentType?: string;
}

/**
 * Interactive acquisition through browser-use. Raw observed pages, screenshots, and downloads are
 * returned separately from result.md, which is only the browser agent's summary.
 */
export async function browseInteractive(url: string, task: string, outDir: string, tools: ToolsConfig, options: { timeoutMs?: number; maxSteps?: number } = {}): Promise<InteractiveResult> {
	await mkdir(outDir, { recursive: true });
	const base: InteractiveResult = { url, task, model: tools.browserUseModel ?? "", finishedAt: new Date().toISOString(), steps: null, resultText: "", artifacts: [], visitedUrls: [], warnings: [], error: null };
	if (!tools.browserUseModel) {
		base.error = "未配置 tools.browserUseModel，交互式浏览器不可用";
		return base;
	}
	const python = venvPython(tools);
	if (!python) {
		base.error = "未安装 Python 工具环境（scripts/setup-tools.sh）";
		return base;
	}
	const args = ["--url", url, "--task", task, "--out", outDir, "--model", tools.browserUseModel];
	if (options.maxSteps !== undefined) args.push("--max-steps", String(options.maxSteps));
	const run = await runScript(python, path.join(pythonScriptsDir(), "browser_task.py"), args, { timeoutMs: options.timeoutMs ?? 600_000 });
	let meta = (run.json ?? {}) as Record<string, unknown>;
	try {
		meta = JSON.parse(await readFile(path.join(outDir, "meta.json"), "utf8")) as Record<string, unknown>;
	} catch {
		/* A preflight failure may occur before metadata exists. */
	}
	base.finishedAt = typeof meta.finishedAt === "string" ? meta.finishedAt : base.finishedAt;
	base.steps = typeof meta.steps === "number" ? meta.steps : null;
	base.visitedUrls = Array.isArray(meta.visitedUrls) ? meta.visitedUrls.filter((item): item is string => typeof item === "string") : [];
	base.warnings = Array.isArray(meta.warnings) ? meta.warnings.filter((item): item is string => typeof item === "string") : [];
	if (typeof meta.complete === "boolean") base.complete = meta.complete;
	base.artifacts = await validateBrowserArtifacts(meta.artifacts, outDir, base.warnings);
	if (run.timedOut) base.warnings.push("browser-use 超时被终止；已保留超时前逐步写入的页面和下载，任务完整性未知");
	base.error = typeof meta.error === "string" ? meta.error : run.code === 0 ? null : `browser_task.py 退出码 ${run.code ?? "null"}${run.timedOut ? "（超时）" : ""}：${run.stderr.trim().slice(-300)}`;
	const resultPath = path.join(outDir, "result.md");
	try {
		base.resultText = await readFile(resultPath, "utf8");
		base.resultPath = resultPath;
	} catch {
		if (!base.error) base.error = "browser-use 没有写出 result.md";
	}
	return base;
}

export async function validateBrowserArtifacts(value: unknown, outDir: string, warnings: string[] = []): Promise<BrowserArtifact[]> {
	if (!Array.isArray(value)) return [];
	const root = await realpath(outDir);
	const artifacts: BrowserArtifact[] = [];
	for (const item of value) {
		if (!item || typeof item !== "object") continue;
		const candidate = item as Record<string, unknown>;
		if (typeof candidate.path !== "string" || !["html", "markdown", "screenshot", "download"].includes(String(candidate.kind))) continue;
		const absolute = path.resolve(root, candidate.path);
		try {
			const stat = await lstat(absolute);
			const resolved = await realpath(absolute);
			if (stat.isSymbolicLink() || !stat.isFile() || (resolved !== root && !resolved.startsWith(`${root}${path.sep}`))) throw new Error("outside output directory or symlink");
			artifacts.push({
				path: resolved,
				kind: candidate.kind as BrowserArtifact["kind"],
				...(typeof candidate.url === "string" ? { url: candidate.url } : {}),
				...(typeof candidate.title === "string" ? { title: candidate.title } : {}),
				...(typeof candidate.capturedAt === "string" ? { capturedAt: candidate.capturedAt } : {}),
				...(typeof candidate.contentType === "string" ? { contentType: candidate.contentType } : {}),
			});
		} catch {
			warnings.push(`忽略了输出目录外、符号链接或不存在的浏览器产物：${candidate.path}`);
		}
	}
	return artifacts;
}

function deduplicateHttpLinks(links: Array<{ text: string; href: string }>): Array<{ text: string; href: string }> {
	const byHref = new Map<string, { text: string; href: string }>();
	for (const link of links) if (!byHref.has(link.href)) byHref.set(link.href, link);
	return [...byHref.values()];
}

function safeAbsolute(href: string, baseUrl: string): string {
	try {
		return new URL(href, baseUrl).toString();
	} catch {
		return "";
	}
}

function decodeHtmlEntities(value: string): string {
	return value.replace(/&(#x[0-9a-f]+|#\d+|amp|quot|apos|lt|gt);/gi, (entity, token: string) => {
		const named: Record<string, string> = { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">" };
		const lower = token.toLowerCase();
		if (lower in named) return named[lower];
		const code = lower.startsWith("#x") ? Number.parseInt(lower.slice(2), 16) : Number.parseInt(lower.slice(1), 10);
		return Number.isFinite(code) ? String.fromCodePoint(code) : entity;
	});
}

export { downloadToFile, fetchText };
