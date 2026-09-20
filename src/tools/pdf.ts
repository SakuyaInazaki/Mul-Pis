/**
 * PDF handling without local ML models.
 * - Text layer: `pdftotext -layout` (poppler) → extracted.md, used for search, quotes and screening.
 * - Pages for a multimodal model: `pdftoppm -png` renders single pages on demand so a reading
 *   session can look at formulas, tables and figures itself. Nothing is downloaded or trained.
 * The engine used is always recorded so the reading record can state what the reader saw.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { ToolsConfig } from "../types.ts";
import { HarnessError } from "../types.ts";
import { writeFileAtomic } from "../workspace.ts";

export interface ExtractResult {
	source: string;
	engine: "pdftotext" | "none";
	engineVersion: string | null;
	pages: number | null;
	ocr: false;
	maxPages: number | null;
	truncated: boolean;
	warnings: string[];
	markdownPath: string | null;
	extractedAt: string;
	error: string | null;
}

export interface ExtractOptions {
	maxPages?: number;
	timeoutMs?: number;
}

function popplerBinary(name: string): string | undefined {
	for (const candidate of [`/opt/homebrew/bin/${name}`, `/usr/local/bin/${name}`, `/usr/bin/${name}`]) if (existsSync(candidate)) return candidate;
	return undefined;
}

function run(binary: string, args: string[], timeoutMs: number): Promise<{ code: number | null; stderr: string; stdout: string }> {
	return new Promise((resolve) => {
		const child = spawn(binary, args, { stdio: ["ignore", "pipe", "pipe"] });
		let stderr = "";
		let stdout = "";
		const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
		child.stdout.on("data", (c) => (stdout += String(c)));
		child.stderr.on("data", (c) => (stderr += String(c)));
		child.on("error", (error) => {
			clearTimeout(timer);
			resolve({ code: null, stderr: `${stderr}\n${error.message}`, stdout });
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			resolve({ code, stderr, stdout });
		});
	});
}

/** Number of pages via pdfinfo, or null when unavailable. */
export async function pdfPageCount(pdfPath: string): Promise<number | null> {
	const binary = popplerBinary("pdfinfo");
	if (!binary) return null;
	const { code, stdout } = await run(binary, [pdfPath], 60_000);
	if (code !== 0) return null;
	const match = /^Pages:\s+(\d+)/m.exec(stdout);
	return match ? Number(match[1]) : null;
}

export async function extractPdf(pdfPath: string, outDir: string, _tools: ToolsConfig, options: ExtractOptions = {}): Promise<ExtractResult> {
	await mkdir(outDir, { recursive: true });
	const extractedAt = new Date().toISOString();
	const result: ExtractResult = {
		source: pdfPath,
		engine: "pdftotext",
		engineVersion: null,
		pages: null,
		ocr: false,
		maxPages: options.maxPages ?? null,
		truncated: false,
		warnings: ["pdftotext 只提取文本层，公式与表格排版可能丢失；扫描件没有文本层，需要用 render_pdf_page 渲染页面由多模态模型阅读"],
		markdownPath: null,
		extractedAt,
		error: null,
	};
	const binary = popplerBinary("pdftotext");
	if (!binary) {
		result.engine = "none";
		result.error = "本机没有 pdftotext（poppler）";
		await writeFileAtomic(path.join(outDir, "extract.json"), `${JSON.stringify(result, null, 2)}\n`);
		return result;
	}
	const total = await pdfPageCount(pdfPath);
	const txtPath = path.join(outDir, "extracted.txt");
	const args = ["-layout"];
	if (options.maxPages) args.push("-l", String(options.maxPages));
	const { code, stderr } = await run(binary, [...args, pdfPath, txtPath], options.timeoutMs ?? 300_000);
	const version = await run(binary, ["-v"], 10_000);
	result.engineVersion = (version.stderr || version.stdout).split(/\r?\n/)[0]?.trim() || null;
	if (stderr.trim()) result.warnings.push(`pdftotext 诊断：${stderr.trim().split(/\r?\n/)[0].slice(0, 160)}（共 ${stderr.trim().split(/\r?\n/).length} 行）`);
	if (code !== 0) {
		result.error = `pdftotext 退出码 ${code ?? "null"}`;
	} else {
		const text = await readFile(txtPath, "utf8");
		const extractedPages = text.split("\f").filter((p) => p.trim()).length;
		result.pages = total ?? (extractedPages || null);
		result.truncated = Boolean(options.maxPages && total && total > options.maxPages);
		if (!text.trim()) result.warnings.push("文本层为空：可能是扫描件，请用 render_pdf_page 渲染页面阅读");
		result.markdownPath = path.join(outDir, "extracted.md");
		await writeFileAtomic(result.markdownPath, `# 提取文本：${path.basename(pdfPath)}\n\n提取引擎：${result.engineVersion ?? "pdftotext"} -layout；提取时间：${extractedAt}；总页数：${total ?? "未知"}${options.maxPages ? `（只提取前 ${options.maxPages} 页）` : ""}。公式与表格以页面图像为准。\n\n${text}\n`);
	}
	await writeFileAtomic(path.join(outDir, "extract.json"), `${JSON.stringify(result, null, 2)}\n`);
	return result;
}

export interface RenderedPage {
	pdf: string;
	page: number;
	path: string;
	dpi: number;
	reused: boolean;
}

/**
 * Render one PDF page to PNG under `<outDir>/pages/<pdf-stem>-p<NNN>.png`. Deterministic names let
 * repeated requests reuse the file. Kept per page so a 75-page paper costs disk only for the pages
 * a reader actually asks to see.
 */
export async function renderPdfPage(pdfPath: string, page: number, outDir: string, tools: ToolsConfig): Promise<RenderedPage> {
	const binary = popplerBinary("pdftoppm");
	if (!binary) throw new HarnessError("pdf.render", "本机没有 pdftoppm（poppler），无法渲染页面");
	if (!Number.isInteger(page) || page < 1) throw new HarnessError("pdf.render", "页码必须是正整数");
	const total = await pdfPageCount(pdfPath);
	if (total !== null && page > total) throw new HarnessError("pdf.render", `页码 ${page} 超出总页数 ${total}`);
	const dpi = tools.pageImageDpi ?? 110;
	const pagesDir = path.join(outDir, "pages");
	await mkdir(pagesDir, { recursive: true });
	const stem = path.parse(pdfPath).name.replace(/[^\w.-]+/g, "_");
	const prefix = path.join(pagesDir, `${stem}-p${String(page).padStart(3, "0")}`);
	const target = `${prefix}.png`;
	if (existsSync(target)) return { pdf: pdfPath, page, path: target, dpi, reused: true };
	const { code, stderr } = await run(binary, ["-png", "-r", String(dpi), "-f", String(page), "-l", String(page), "-singlefile", pdfPath, prefix], 120_000);
	if (code !== 0 || !existsSync(target)) throw new HarnessError("pdf.render", `pdftoppm 失败（退出码 ${code ?? "null"}）：${stderr.trim().slice(0, 200)}`);
	return { pdf: pdfPath, page, path: target, dpi, reused: false };
}
