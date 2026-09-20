/** Page rendering without ML models: pdftoppm. Uses the local research PDF when present, otherwise skips. */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { renderPageTool } from "../src/tools/pagetool.ts";
import { extractPdf, renderPdfPage } from "../src/tools/pdf.ts";

const PDF = path.resolve(import.meta.dirname, "..", "resources", "2609.11873v1.pdf");

describe("pdf pages", { skip: !existsSync(PDF) ? "local research PDF not present" : false }, () => {
	it("renders one page on demand, reuses it, refuses out-of-root files and returns an image", async () => {
		const dir = await mkdtemp(path.join(os.tmpdir(), "harness-pdf-"));
		try {
			const first = await renderPdfPage(PDF, 1, dir, {});
			assert.ok(existsSync(first.path) && first.path.endsWith("pages/2609.11873v1-p001.png"));
			assert.equal(first.reused, false);
			const again = await renderPdfPage(PDF, 1, dir, {});
			assert.equal(again.reused, true);
			await assert.rejects(renderPdfPage(PDF, 9999, dir, {}), /超出总页数/);
			const rendered: string[] = [];
			const tool = renderPageTool({ root: dir, tools: {}, extraRoots: [path.dirname(PDF)], onRendered: ({ page }) => void rendered.push(String(page)) });
			const result = await tool.execute({ file: PDF, page: 2 });
			assert.ok(result.images?.[0]?.path.endsWith("-p002.png"));
			assert.deepEqual(rendered, ["2"]);
			await assert.rejects(tool.execute({ file: "/etc/hosts", page: 1 }), /只能渲染|只接受/);
			const text = await extractPdf(PDF, path.join(dir, "text"), {}, { maxPages: 1 });
			assert.equal(text.engine, "pdftotext");
			assert.equal(text.pages, 75);
			assert.equal(text.truncated, true);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
