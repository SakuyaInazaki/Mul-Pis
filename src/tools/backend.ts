/**
 * The acquisition backend bundles the external capabilities M05 may use. Stages depend on
 * this interface so tests can inject stubs and so every provider stays replaceable
 * (browser-use and Crawl4AI plus public search endpoints; PDFs via poppler only; none is hard-wired).
 */
import type { ToolsConfig } from "../types.ts";
import { downloadToFile, type DownloadResult } from "./http.ts";
import { browseInteractive, fetchPage, type FetchOptions, type FetchResult, type InteractiveResult } from "./fetch.ts";
import { findOpenAccess, type OpenAccessResult } from "./openaccess.ts";
import { extractPdf, type ExtractOptions, type ExtractResult } from "./pdf.ts";
import { providersFor, type SearchProvider } from "./search.ts";

export interface AcquisitionBackend {
	providers: SearchProvider[];
	fetchPage(url: string, outDir: string, options?: FetchOptions): Promise<FetchResult>;
	downloadFile(url: string, destPath: string): Promise<DownloadResult>;
	extractPdf(pdfPath: string, outDir: string, options?: ExtractOptions): Promise<ExtractResult>;
	findOpenAccess(idOrUrl: string): Promise<OpenAccessResult>;
	/** Interactive browser agent (browser-use). Absent when no model is configured for it. */
	browseInteractive?(url: string, task: string, outDir: string): Promise<InteractiveResult>;
	/** Human-readable description of what is actually available (engines, providers), for the run record. */
	describe(): string[];
}

export function defaultBackend(tools: ToolsConfig): AcquisitionBackend {
	const providers = providersFor(tools);
	return {
		providers,
		fetchPage: (url, outDir, options) => fetchPage(url, outDir, tools, options),
		downloadFile: (url, destPath) => downloadToFile(url, destPath),
		extractPdf: (pdfPath, outDir, options) => extractPdf(pdfPath, outDir, tools, options),
		findOpenAccess: (idOrUrl) => findOpenAccess(idOrUrl, tools.openAlexMailto),
		...(tools.browserUseModel ? { browseInteractive: (url: string, task: string, outDir: string) => browseInteractive(url, task, outDir, tools) } : {}),
		describe: () => [
			`检索来源：${providers.map((p) => p.name).join("、")}${tools.braveApiKey ? "" : "（未配置 Brave 密钥；通用网页检索走无密钥的 DuckDuckGo，尽力而为）"}`,
			`网页抓取：${tools.pythonVenv || "默认 .venv"} 中的 Crawl4AI 可用时优先，否则纯 HTTP`,
			`PDF：pdftotext 文本层 + pdftoppm 按需渲染页面图像供多模态模型阅读（不运行本地模型）`,
			`交互式浏览器：${tools.browserUseModel ? `browser-use（${tools.browserUseModel}）` : "未配置 browser-use 模型，不可用"}`,
		],
	};
}
