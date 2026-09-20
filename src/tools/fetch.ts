/**
 * Page fetching for M05. Primary engine: Crawl4AI through tools/py/fetch_page.py (headless
 * Chromium, markdown output). Fallback: plain HTTP with a minimal HTML→text conversion so the
 * stage still works without the Python stack, with the engine recorded honestly in meta.json.
 */
import { mkdir, writeFile } from "node:fs/promises";
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
			base.links = [...html.matchAll(/<a[^>]*href="([^"#]+)"[^>]*>([\s\S]*?)<\/a>/gi)]
				.slice(0, 200)
				.map((m) => ({ text: m[2].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim(), href: safeAbsolute(m[1], base.finalUrl) }))
				.filter((l) => l.href);
			if (!text.trim()) base.error = "页面没有可提取的正文";
		} else {
			const buffer = Buffer.from(await probe.arrayBuffer());
			base.kind = "file";
			base.bytes = buffer.length;
			base.filePath = path.join(outDir, `download${extensionForContentType(contentType, base.finalUrl)}`);
			await writeFile(base.filePath, buffer);
		}
		if (probe.status >= 400) base.error = `HTTP ${probe.status}`;
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
	warnings: string[];
	error: string | null;
}

/**
 * Last-resort interactive fetch through browser-use (tools/py/browser_task.py). Only available when
 * the config names a model for it; the model's API key must be present in the environment. The
 * result is the agent's own report, which stays discovery data until fetched files are read.
 */
export async function browseInteractive(url: string, task: string, outDir: string, tools: ToolsConfig, options: { timeoutMs?: number } = {}): Promise<InteractiveResult> {
	await mkdir(outDir, { recursive: true });
	const base: InteractiveResult = { url, task, model: tools.browserUseModel ?? "", finishedAt: new Date().toISOString(), steps: null, resultText: "", warnings: [], error: null };
	if (!tools.browserUseModel) {
		base.error = "未配置 tools.browserUseModel，交互式浏览器不可用";
		return base;
	}
	const python = venvPython(tools);
	if (!python) {
		base.error = "未安装 Python 工具环境（scripts/setup-tools.sh）";
		return base;
	}
	const run = await runScript(python, path.join(pythonScriptsDir(), "browser_task.py"), ["--url", url, "--task", task, "--out", outDir, "--model", tools.browserUseModel], { timeoutMs: options.timeoutMs ?? 600_000 });
	const meta = (run.json ?? {}) as Record<string, unknown>;
	base.finishedAt = typeof meta.finishedAt === "string" ? meta.finishedAt : base.finishedAt;
	base.steps = typeof meta.steps === "number" ? meta.steps : null;
	base.error = typeof meta.error === "string" ? meta.error : run.code === 0 ? null : `browser_task.py 退出码 ${run.code ?? "null"}${run.timedOut ? "（超时）" : ""}：${run.stderr.trim().slice(-300)}`;
	const resultPath = path.join(outDir, "result.md");
	try {
		base.resultText = await (await import("node:fs/promises")).readFile(resultPath, "utf8");
		base.resultPath = resultPath;
	} catch {
		if (!base.error) base.error = "browser-use 没有写出 result.md";
	}
	return base;
}

function safeAbsolute(href: string, baseUrl: string): string {
	try {
		return new URL(href, baseUrl).toString();
	} catch {
		return "";
	}
}

export { downloadToFile, fetchText };
