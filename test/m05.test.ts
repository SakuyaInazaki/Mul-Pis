/**
 * M05 contract tests with a stub backend and a scripted acquisition session:
 * searches are logged, only obtained files can be registered, PDFs get extracted text,
 * paths outside the run's work directory are refused, and the registered source is
 * consumable by M06.
 */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { createFileKnowledgeStore } from "../src/knowledge/store.ts";
import { FakeSessionRunner, type FakeReplyContext } from "../src/runner/fake.ts";
import type { StageContext } from "../src/stages/context.ts";
import { runInit } from "../src/stages/init.ts";
import { runM05 } from "../src/stages/m05.ts";
import { runM06 } from "../src/stages/m06.ts";
import type { AcquisitionBackend } from "../src/tools/backend.ts";
import { writeFileAtomic, Workspace } from "../src/workspace.ts";

function stubBackend(): AcquisitionBackend {
	return {
		providers: [
			{
				name: "stubalex",
				description: "stub scholarly provider",
				async search(query, { limit }) {
					return {
						provider: "stubalex",
						query,
						limit,
						endpoint: "stub://works",
						warnings: [],
						hits: [{ provider: "stubalex", title: "Paper A on mechanism A", url: "https://example.org/a", doi: "10.1000/xyz", oaUrl: "https://example.org/a.pdf", date: "2025", authors: ["Ann"] }],
					};
				},
			},
		],
		async fetchPage(url, outDir) {
			const markdownPath = path.join(outDir, "page.md");
			await writeFileAtomic(markdownPath, `# Paper A\n\nAbstract: mechanism A explains B under condition W.\n`);
			return { url, finalUrl: url, status: 200, title: "Paper A", fetchedAt: "2026-09-20T00:00:00Z", engine: "http", kind: "page", contentType: "text/html", bytes: 100, markdownPath, links: [], warnings: [], error: null };
		},
		async downloadFile(url, destPath) {
			await mkdir(path.dirname(destPath), { recursive: true });
			await writeFile(destPath, "%PDF-1.4 fake");
			return { url, finalUrl: url, status: 200, contentType: "application/pdf", bytes: 13, path: destPath };
		},
		async extractPdf(pdfPath, outDir, options) {
			const markdownPath = path.join(outDir, "extracted.md");
			await writeFileAtomic(markdownPath, `Extracted text of ${path.basename(pdfPath)}${options?.maxPages ? ` (first ${options.maxPages} pages)` : ""}\n`);
			return { source: pdfPath, engine: "pdftotext", engineVersion: "stub", pages: 5, ocr: false, maxPages: options?.maxPages ?? null, truncated: Boolean(options?.maxPages), warnings: [], markdownPath, extractedAt: "2026-09-20T00:00:00Z", error: null };
		},
		async findOpenAccess(input) {
			return { input, kind: "doi", found: true, isOa: true, oaUrl: "https://example.org/a.pdf", landingUrl: "https://example.org/a", warnings: [] };
		},
		describe: () => ["stub backend"],
	};
}

describe("M05 acquisition stage", () => {
	let root: string;
	let ws: Workspace;
	let ctx: StageContext;
	const seen: Record<string, unknown> = {};

	async function acquisitionReply(ctx: FakeReplyContext): Promise<string> {
		const t = ctx.tools;
		seen.search = (await t.web_search({ query: "mechanism A explains B", limit: 5 })).text;
		seen.oa = (await t.find_open_access({ identifier: "https://doi.org/10.1000/xyz" })).text;
		const page = await t.fetch_page({ url: "https://example.org/a" });
		seen.page = page.text;
		const download = await t.download_file({ url: "https://example.org/a.pdf", filename: "a.pdf" });
		const pdfPath = (download.details as { path: string }).path;
		const extract = await t.extract_pdf({ path: pdfPath, max_pages: 2 });
		const extractedPath = (extract.details as { markdownPath: string }).markdownPath;
		seen.read = (await t.read_work_file({ path: extractedPath, limit: 200 })).text;
		try {
			await t.read_work_file({ path: "/etc/hosts" });
			seen.outside = "allowed";
		} catch (error) {
			seen.outside = (error as Error).message;
		}
		try {
			await t.register_source({ title: "Ghost", kind: "paper", files: [], obtained_range: "全文", relevance: "x" });
			seen.ghost = "allowed";
		} catch (error) {
			seen.ghost = (error as Error).message;
		}
		const registered = await t.register_source({ title: "Paper A on mechanism A", kind: "paper", files: [pdfPath], obtained_range: "全文", relevance: "直接讨论机制 A 的条件", identifier: "10.1000/xyz", url: "https://example.org/a", authors: "Ann", version: "2025" });
		seen.registered = registered.text;
		seen.index = (await t.list_sources({})).text;
		return "## 本轮知识需求与检索式\n\nmechanism A explains B\n\n## 已取得并登记\n\n- S001：全文；优先阅读\n\n## 线索但未取得\n\n无\n\n## 未解决缺口与续查建议\n\n无\n\n## 资源边界与未覆盖\n\n无\n\n## 本轮实际读到的内容\n\nextracted.md 开头一行";
	}

	before(async () => {
		root = await mkdtemp(path.join(os.tmpdir(), "harness-m05-"));
		ws = new Workspace(root);
		await mkdir(ws.rawDir, { recursive: true });
		await writeFile(ws.problemFile, "# 原始问题\n\n研究机制 A 是否解释现象 B。\n");
		await writeFile(ws.configFile, JSON.stringify({ roles: { default: "fake/model-x", acquisition: "fake/model-acq" } }));
		const store = createFileKnowledgeStore(ws.knowledgeDir);
		await runInit(ws, store);
		const runner = new FakeSessionRunner(async (c) => {
			if (c.spec.label === "M05") return acquisitionReply(c);
			if (c.spec.label.endsWith("-reader")) return { text: "阅读记录\n\n## 实际阅读范围\n\nextracted.md\n\n## 疑点与缺口\n\n无", reads: ["extracted.md"] };
			if (c.spec.label.endsWith("-checker")) return { text: "核对：忠实\n\n## 实际核对范围\n\n全部", reads: ["extracted.md"] };
			return { text: "适用性：支持\n\n## 处理建议\n\n无" };
		});
		ctx = { ws, runner, store, config: await ws.loadConfig() };
	});

	after(async () => {
		await rm(root, { recursive: true, force: true });
	});

	it("runs the acquisition session with confined tools and registers only obtained files", async () => {
		const result = await runM05(ctx, { goal: "补齐机制 A 的条件依据", backend: stubBackend() });
		assert.equal(result.record.status, "completed");
		assert.deepEqual(result.registered, ["S001"]);
		assert.deepEqual(result.record.failures, []);
		const spec = (ctx.runner as FakeSessionRunner).created.find((s) => s.label === "M05")!;
		assert.equal(spec.role, "acquisition");
		assert.equal(spec.model, "fake/model-acq");
		assert.equal(spec.tools.kind, "custom");
		assert.ok(String(seen.search).includes("Paper A on mechanism A") && String(seen.search).includes("开放版本"));
		assert.ok(String(seen.oa).includes("a.pdf"));
		assert.ok(String(seen.page).includes("Abstract: mechanism A"));
		assert.ok(String(seen.read).includes("first 2 pages"));
		assert.ok(String(seen.outside).includes("只能读取"), "paths outside the work dir are refused");
		assert.ok(String(seen.ghost).includes("files 必须列出"), "registration without obtained files is refused");
		assert.ok(String(seen.index).includes("S001"));
		// source record
		const dir = path.join(ws.referencesDir, "sources", "S001");
		const sourceMd = await readFile(path.join(dir, "source.md"), "utf8");
		assert.ok(sourceMd.includes("# Paper A on mechanism A"));
		assert.ok(sourceMd.includes("实际取得范围：全文"));
		assert.ok(sourceMd.includes("10.1000/xyz"));
		assert.ok(existsSync(path.join(dir, "a.pdf")));
		assert.ok(existsSync(path.join(dir, "extracted.md")), "PDF registration attaches extracted text");
		assert.ok(sourceMd.includes("extracted.md（extracted；提取引擎 pdftotext"));
		const index = await readFile(path.join(ws.referencesDir, "INDEX.md"), "utf8");
		assert.ok(index.includes("| S001 | Paper A on mechanism A |"));
		// search log and tool log
		const searchLog = await readFile(result.record.outputs.find((o) => o.label === "检索记录")!.path, "utf8");
		assert.ok(searchLog.includes("检索式：mechanism A explains B") && searchLog.includes("stub://works") && searchLog.includes("已登记 S001"));
		const toolLog = (await readFile(result.record.outputs.find((o) => o.label === "工具调用记录")!.path, "utf8")).trim().split("\n");
		assert.ok(toolLog.length >= 8, `expected ≥8 logged calls, got ${toolLog.length}`);
		assert.ok(result.toolLog.some((c) => c.name === "read_work_file" && !c.ok), "refused call is logged as failed");
		const report = await readFile(result.record.outputs.find((o) => o.label === "获取报告")!.path, "utf8");
		assert.ok(report.includes("## 已取得并登记"));
		assert.ok(result.record.remarks.some((r) => r.includes("m06 --source S001")));
	});

	it("hands the registered source to M06", async () => {
		const result = await runM06(ctx, { sources: ["S001"] });
		assert.equal(result.groups[0].status, "completed");
		assert.deepEqual(result.groups[0].readCoverage, ["extracted.md"]);
	});
});
