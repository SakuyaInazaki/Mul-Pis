/** Offline validation for browser-use artifacts. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, it } from "node:test";
import { httpFetchPage, validateBrowserArtifacts } from "../src/tools/fetch.ts";

const execFileAsync = promisify(execFile);

describe("browser artifacts", () => {
	it("accepts regular output files and rejects traversal and symlinks", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "pre-rsi-browser-artifacts-"));
		const pages = path.join(root, "pages");
		await mkdir(pages);
		await writeFile(path.join(pages, "page-001.html"), "<p>observed</p>");
		const outside = path.join(root, "..", `${path.basename(root)}-outside.txt`);
		await writeFile(outside, "outside");
		await symlink(outside, path.join(pages, "linked.html"));
		const warnings: string[] = [];

		const artifacts = await validateBrowserArtifacts([
			{ path: "pages/page-001.html", kind: "html", url: "https://example.test/", capturedAt: "2026-09-20T00:00:00Z" },
			{ path: outside, kind: "download" },
			{ path: "pages/linked.html", kind: "html" },
			{ path: "pages/missing.png", kind: "screenshot" },
			{ path: "pages/page-001.html", kind: "unknown" },
		], root, warnings);

		assert.equal(artifacts.length, 1);
		assert.equal(artifacts[0].kind, "html");
		assert.equal(artifacts[0].path, await realpath(path.join(pages, "page-001.html")));
		assert.equal(warnings.length, 3);
	});

	it("captures changed same-URL states and links without network access", async () => {
		const python = path.resolve(".venv/bin/python");
		const testFile = path.resolve("tools/py/test_browser_artifacts.py");
		const { stdout, stderr } = await execFileAsync(python, ["-I", testFile], { cwd: path.resolve(".") });
		assert.match(`${stdout}${stderr}`, /Ran 5 tests/);
		assert.match(`${stdout}${stderr}`, /OK/);
	});

	it("does not claim complete links for failures or non-HTML downloads", async () => {
		const originalFetch = globalThis.fetch;
		try {
			globalThis.fetch = async () => new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-type": "application/pdf" } });
			const fileDir = await mkdtemp(path.join(tmpdir(), "pre-rsi-file-fetch-"));
			const fileResult = await httpFetchPage("https://example.test/file.pdf", fileDir);
			assert.equal(fileResult.kind, "file");
			assert.equal(fileResult.linksTotal, undefined);
			assert.equal(fileResult.linksComplete, undefined);

			globalThis.fetch = async () => { throw new Error("offline failure"); };
			const failedDir = await mkdtemp(path.join(tmpdir(), "pre-rsi-failed-fetch-"));
			const failedResult = await httpFetchPage("https://example.test/failure", failedDir);
			assert.match(failedResult.error ?? "", /offline failure/);
			assert.equal(failedResult.linksTotal, undefined);
			assert.equal(failedResult.linksComplete, undefined);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("keeps HTTP error pages for diagnosis without claiming complete target-page links", async () => {
		const originalFetch = globalThis.fetch;
		try {
			for (const status of [403, 404, 429]) {
				globalThis.fetch = async () => new Response(`<html><title>Error ${status}</title><a href="/help">help</a></html>`, { status, headers: { "content-type": "text/html" } });
				const outDir = await mkdtemp(path.join(tmpdir(), `pre-rsi-http-${status}-`));
				const result = await httpFetchPage(`https://example.test/${status}`, outDir);
				assert.equal(result.status, status);
				assert.equal(result.linksComplete, false);
				assert.equal(result.linksTotal, 1);
				assert.match(result.error ?? "", new RegExp(`HTTP ${status}`));
				assert.ok(result.htmlPath && result.markdownPath, "error response artifacts remain available for diagnosis");
				assert.match(result.warnings.join("\n"), /不声明目标页链接提取完整/);
			}
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});
