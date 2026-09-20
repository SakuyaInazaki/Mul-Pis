/**
 * `render_pdf_page`: lets a session look at one PDF page as an image. The page is rendered with
 * pdftoppm (no ML models) under `<root>/pages/` and returned to the model as an image block, so a
 * multimodal model can read formulas, tables and figures that the text layer loses.
 */
import { realpath } from "node:fs/promises";
import path from "node:path";
import type { CustomToolSpec } from "../runner/types.ts";
import { HarnessError, type ToolsConfig } from "../types.ts";
import { renderPdfPage } from "./pdf.ts";

export interface RenderPageToolOptions {
	/** Directory the PDF must live in and where `pages/` is created. */
	root: string;
	tools: ToolsConfig;
	/** Called after each successful render (for coverage records). */
	onRendered?: (info: { pdf: string; page: number; imagePath: string }) => Promise<void> | void;
	/** Extra confinement roots (e.g. an M05 work directory) whose PDFs may also be rendered; pages go next to the PDF. */
	extraRoots?: string[];
}

export function renderPageTool(options: RenderPageToolOptions): CustomToolSpec {
	return {
		name: "render_pdf_page",
		description: "把 PDF 的某一页渲染成图片并直接返回给你查看（用于公式、表格、图、扫描件）。文本层见 extracted.md；每次只渲染一页，图片保存在材料目录的 pages/ 下。",
		params: {
			file: { type: "string", description: "PDF 文件名或路径（材料目录内）" },
			page: { type: "number", description: "页码，从 1 开始" },
		},
		async execute(args) {
			const file = typeof args.file === "string" ? args.file.trim() : "";
			const page = typeof args.page === "number" ? args.page : Number(args.page);
			if (!file) throw new HarnessError("tool.args", "file 必须是 PDF 路径");
			const roots = await Promise.all([options.root, ...(options.extraRoots ?? [])].map((r) => realpath(r)));
			const candidate = path.isAbsolute(file) ? file : path.resolve(options.root, file);
			const resolved = await realpath(candidate).catch(() => {
				throw new HarnessError("tool.path", `文件不存在：${file}`);
			});
			const home = roots.find((r) => resolved === r || resolved.startsWith(`${r}${path.sep}`));
			if (!home) throw new HarnessError("tool.path", `只能渲染材料目录内的 PDF：${file}`);
			if (!resolved.toLowerCase().endsWith(".pdf")) throw new HarnessError("tool.args", "只接受 .pdf 文件");
			const outDir = home === roots[0] ? options.root : path.dirname(resolved);
			const rendered = await renderPdfPage(resolved, page, outDir, options.tools);
			await options.onRendered?.({ pdf: resolved, page, imagePath: rendered.path });
			return {
				text: `已渲染 ${path.basename(resolved)} 第 ${page} 页（${rendered.dpi} dpi${rendered.reused ? "，复用已有图片" : ""}）：${path.relative(options.root, rendered.path) || rendered.path}。下面是该页图像。`,
				images: [{ path: rendered.path, mimeType: "image/png" }],
				details: rendered,
			};
		},
	};
}
