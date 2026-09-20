import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { createFileKnowledgeStore } from "../src/knowledge/store.ts";
import { FakeSessionRunner } from "../src/runner/fake.ts";
import type { StageContext } from "../src/stages/context.ts";
import { runInit } from "../src/stages/init.ts";
import { runM05 } from "../src/stages/m05.ts";
import type { AcquisitionBackend } from "../src/tools/backend.ts";
import { writeFileAtomic, Workspace } from "../src/workspace.ts";

describe("M05 task-scoped coverage and continuation", () => {
	let root: string;
	let ctx: StageContext;
	const seen: Record<string, string> = {};

	before(async () => {
		root = await mkdtemp(path.join(os.tmpdir(), "harness-m05-coverage-"));
		const ws = new Workspace(root);
		await mkdir(ws.rawDir, { recursive: true });
		await writeFile(ws.problemFile, "# 原始问题\n\n查找任意站点的讨论证据。\n");
		await writeFile(ws.configFile, JSON.stringify({ roles: { default: "fake/default", acquisition: "fake/acquisition" } }));
		const store = createFileKnowledgeStore(ws.knowledgeDir);
		await runInit(ws, store);
		let searchOptions: unknown = {};
		const backend: AcquisitionBackend = {
			providers: [{ name: "general", description: "arbitrary general web", async search(query, options) { searchOptions = options; return { provider: "general", query: `${query} site:example.net`, limit: options.limit, page: options.page, nextPage: 4, nextCursor: "cursor-4", endpoint: "stub://general", warnings: [], hits: Array.from({ length: 15 }, (_, i) => ({ provider: "general", title: `Result ${i}`, url: `https://example.net/r/${i}` })) }; } }, { name: "community", description: "community", async search(query, options) { return { provider: "community", query, limit: options.limit, endpoint: "stub://community", warnings: [], hits: [] }; } }],
			async fetchPage(url, outDir) {
				const markdownPath = path.join(outDir, "page.md");
				await writeFileAtomic(markdownPath, "# Thread\n\ncontext and replies\n");
				const links = Array.from({ length: 83 }, (_, i) => ({ text: `reply ${i}`, href: `${url}/${i}` }));
				return { url, finalUrl: url, status: 200, title: "Thread", fetchedAt: "2026-09-20T00:00:00Z", engine: "http", kind: "page", contentType: "text/html", bytes: 10, markdownPath, links, linksTotal: 83, linksComplete: true, warnings: [], error: null };
			},
			async browseInteractive(url, task, outDir, options) {
				const resultPath = path.join(outDir, "result.md");
				const pagePath = path.join(outDir, "thread.html");
				const screenshotPath = path.join(outDir, "thread.png");
				await writeFile(resultPath, "agent summary");
				await writeFile(pagePath, "<article>thread and replies</article>");
				await writeFile(screenshotPath, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]));
				return { url, task, model: "stub/browser", finishedAt: "2026-09-20T00:00:00Z", steps: options?.maxSteps ?? null, resultPath, resultText: "agent summary", artifacts: [{ path: pagePath, kind: "html", url: `${url}/thread`, capturedAt: "2026-09-20T00:00:00Z", contentType: "text/html" }, { path: screenshotPath, kind: "screenshot", url: `${url}/thread`, contentType: "image/png" }], visitedUrls: [url, `${url}/thread`], warnings: ["attachment missing"], error: "stopped after partial capture" };
			},
			async downloadFile() { throw new Error("unused"); }, async extractPdf() { throw new Error("unused"); }, async findOpenAccess(input) { return { input, kind: "unknown", found: false, isOa: false, warnings: [] }; }, describe: () => ["stub coverage backend"],
		};
		const runner = new FakeSessionRunner(async ({ tools }) => {
			const browser = await tools.browse_interactive({ url: "https://example.net", task: "capture thread context and replies", max_steps: 7 });
			seen.browser = browser.text;
			const details = browser.details as { resultPath: string; artifacts: Array<{ path: string }> };
			const displayedArtifacts = [...browser.text.matchAll(/^\d+\. (?:html|screenshot)：(references\/[^\n]+)/gm)].map((match) => match[1]);
			assert.equal(displayedArtifacts.length, 2, "browser text exposes round-trippable workspace-relative paths");
			seen.image = (await tools.view_work_image({ path: displayedArtifacts[1] })).text;
			try { await tools.register_source({ title: "report", kind: "forum", files: [details.resultPath], obtained_range: "report", relevance: "x" }); } catch (error) { seen.reportRejected = (error as Error).message; }
			const registered = await tools.register_source({ title: "Captured discussion", kind: "forum", files: displayedArtifacts, obtained_range: "thread page and screenshot; attachment missing", completeness: "partial", relevance: "discussion context", url: "https://example.net/thread" });
			seen.registered = registered.text;
			const fetched = await tools.fetch_page({ url: "https://example.net/thread" });
			const pageId = (fetched.details as { pageId: string }).pageId;
			seen.links = (await tools.list_page_links({ page_id: pageId, offset: 60, limit: 20 })).text;
			const displayedPage = /正文文件：(references\/[^\n]+)/.exec(fetched.text)?.[1];
			assert.ok(displayedPage);
			seen.pageRead = (await tools.read_work_file({ path: displayedPage, limit: 100 })).text;
			seen.fetchRegistered = (await tools.register_source({ title: "Fetched thread", kind: "forum", files: [displayedPage], obtained_range: "saved page markdown", relevance: "thread text" })).text;
			seen.search = (await tools.web_search({ query: "topic", providers: ["general"], page: 3, cursor: "cursor-3", site: "example.net", limit: 15 })).text;
			try { await tools.web_search({ query: "bad cursor", cursor: "provider-token" }); } catch (error) { seen.cursorRejected = (error as Error).message; }
			seen.searchOptions = JSON.stringify(searchOptions);
			return "## 本轮知识需求与检索式\n\ntopic\n## 已取得并登记\n\nS001\n## 线索但未取得\n\n无\n## 未解决缺口与续查建议\n\n附件\n## 资源边界与未覆盖\n\n计划 thread；取得 page/screenshot；缺 attachment\n## 本轮实际读到的内容\n\nthread context";
		});
		ctx = { ws, runner, store, config: await ws.loadConfig() };
		(ctx as StageContext & { backend?: AcquisitionBackend }).backend = backend;
		await runM05(ctx, { backend, maxToolText: 1_200 });
	});

	after(async () => rm(root, { recursive: true, force: true }));

	it("allows browser acquisition first and preserves partial artifacts with provenance", async () => {
		assert.match(seen.browser, /实际材料 artifacts/);
		assert.match(seen.browser, /stopped after partial capture/);
		assert.match(seen.image, /thread\.png/);
		assert.match(seen.reportRejected, /模型报告/);
		const source = await readFile(path.join(ctx.ws.referencesDir, "sources", "S001", "source.md"), "utf8");
		assert.match(source, /thread\.html（original；类型 html；来源 https:\/\/example\.net\/thread/);
		assert.match(source, /thread\.png（page-image；类型 screenshot/);
		const fetched = await readFile(path.join(ctx.ws.referencesDir, "sources", "S002", "source.md"), "utf8");
		assert.match(fetched, /page\.md（extracted；类型 markdown；来源 https:\/\/example\.net\/thread/);
	});

	it("continues searches and exposes links beyond the first fifty", () => {
		assert.match(seen.searchOptions, /"page":3/);
		assert.match(seen.searchOptions, /"cursor":"cursor-3"/);
		assert.match(seen.searchOptions, /"site":"example.net"/);
		assert.match(seen.search, /下一页 4/);
		assert.match(seen.links, /reply 60/);
		assert.match(seen.links, /reply 79/);
		assert.match(seen.pageRead, /context and replies/);
		assert.match(seen.cursorRejected, /只选择一个 provider/);
	});
});
