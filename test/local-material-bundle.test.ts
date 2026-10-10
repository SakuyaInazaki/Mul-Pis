import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { freezeArtifacts } from "../src/stages/artifacts.ts";
import { freezeLocalMaterialBundle, readLocalMaterialBundle,
	type LocalMaterialGap,
	validateLocalMaterialSelections } from "../src/m07/local-material-bundle.ts";

async function fixture(t: TestContext) {
	const parent = await mkdtemp(path.join(os.tmpdir(), "mulpis-material-bundle-"));
	t.after(() => rm(parent, { recursive: true, force: true }));
	return { parent, root: path.join(parent, "bundle") };
}

test("declared original, text projection and page image freeze exact bytes with honest gaps", async t => {
	const f = await fixture(t);
	const pdf = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(37, 0)]);
	const extracted = "π".repeat(450_100);
	const page = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]);
	await writeFile(path.join(f.parent, "article.pdf"), pdf);
	await writeFile(path.join(f.parent, "article.md"), extracted);
	await writeFile(path.join(f.parent, "page.png"), page);
	const selection = [
		{ kind: "declared-file", label: "Original article", path: "article.pdf",
			role: "original", providedScope: "pages 1–2", provenance: { url: "https://example.org/article",
				contentType: "application/pdf" } },
		{ kind: "declared-file", label: "Extracted text", path: "article.md",
			role: "extracted", providedScope: "selected text", provenance: {
				kind: "markdown", derivedFrom: "article.pdf" } },
		{ kind: "declared-file", label: "Page image", path: "page.png",
			role: "page-image", providedScope: "page 2" },
	] as const;
	assert.equal(validateLocalMaterialSelections(selection), true);
	const bundle = await freezeLocalMaterialBundle({ root: f.root, baseDir: f.parent,
		selections: selection, unprovidedScopes: ["page 3 not supplied"] });
	assert.deepEqual((await readLocalMaterialBundle(f.root)).items,
		bundle.manifest.items);
	assert.equal(bundle.manifest.semanticCoverage, "unverified");
	assert.equal(bundle.manifest.assessorRead, false);
	assert.equal(bundle.manifest.items[0].text, false);
	assert.equal(bundle.manifest.items[1].text, true);
	assert.ok(bundle.manifest.items[1].parts.length >= 2);
	for (const part of bundle.manifest.items[1].parts) {
		const bytes = await readFile(path.join(f.root, part.file));
		assert.doesNotThrow(() => new TextDecoder("utf-8", { fatal: true }).decode(bytes));
	}
	assert.ok(bundle.assessorEvidence.some(row => row.role === "index"));
	assert.ok(bundle.assessorEvidence.some(row => row.role === "extracted"));
	assert.ok(!bundle.assessorEvidence.some(row => row.role === "page-image"));
	const codes = new Set(bundle.gaps.map(gap => gap.code));
	for (const code of ["not-read", "nontext", "projection-only", "partial-coverage",
		"coverage-unverified", "unprovided"] as LocalMaterialGap["code"][])
		assert.ok(codes.has(code), code);
	const index = (await Promise.all(bundle.indexFiles.map(file => readFile(file, "utf8")))).join("");
	assert.match(index, /does not mean read, checked, or scientifically complete/);
	assert.ok(!index.includes(extracted.slice(0, 100)));
	assert.deepEqual(Buffer.concat(await Promise.all(bundle.manifest.items[0].parts.map(part =>
		readFile(path.join(f.root, part.file))))), pdf);
	assert.deepEqual(Buffer.concat(await Promise.all(bundle.manifest.items[2].parts.map(part =>
		readFile(path.join(f.root, part.file))))), page);
});

test("registered source fallback preserves prose and marks missing structured roles", async t => {
	const f = await fixture(t);
	const sourceDir = path.join(f.parent, "references", "sources", "S001");
	await mkdir(sourceDir, { recursive: true });
	await writeFile(path.join(sourceDir, "source.md"),
		"# Synthetic source\n- 实际取得范围：摘要\n- 图像未阅读\n");
	await writeFile(path.join(sourceDir, "source.pdf"), Buffer.from("%PDF\0synthetic"));
	const bundle = await freezeLocalMaterialBundle({ root: f.root, selections: [
		{ kind: "registered-source", workspaceRoot: f.parent, sourceId: "S001" } ] });
	assert.equal(bundle.manifest.items.length, 2);
	assert.equal(bundle.manifest.items[1].role, "unknown");
	assert.ok(bundle.gaps.some(gap => gap.code === "registration-prose-only"));
	assert.equal(bundle.manifest.items[0].text, true);
	assert.equal(bundle.manifest.items[0].sourceIdentity,
		"registered:S001:source.md");
	const detailed = await freezeLocalMaterialBundle({ root: path.join(f.parent, "detailed"),
		selections: [{ kind: "registered-source", workspaceRoot: f.parent,
			sourceId: "S001", obtainedRange: "abstract only", files: [{
				path: path.join(sourceDir, "source.pdf"), role: "original",
				provenance: { url: "https://example.org/source.pdf",
					contentType: "application/pdf" } }] }] });
	assert.equal(detailed.manifest.items[1].role, "original");
	assert.equal(detailed.manifest.items[1].provenance?.contentType,
		"application/pdf");
	assert.ok(!detailed.gaps.some(gap => gap.code === "registration-prose-only"));
});

test("M08 frozen selection keeps category, declared scope and unprovided gaps", async t => {
	const f = await fixture(t);
	const source = path.join(f.parent, "submitted.txt");
	await writeFile(source, "synthetic submitted result\n");
	const m08 = await freezeArtifacts(path.join(f.parent, "m08-frozen"), [
		{ label: "Submitted result", path: source, sourceCategory: "result",
			providedScope: "section 2" } ], ["appendix unavailable"], "M08-synthetic");
	const bundle = await freezeLocalMaterialBundle({ root: f.root, selections: [
		{ kind: "m08-manifest", label: "M08 reviewed materials",
			manifestFile: path.join(m08.rootDir, "manifest.json"),
			entryRelativePaths: [m08.entries[0].relativePath] } ] });
	assert.equal(bundle.manifest.items.length, 1);
	assert.equal(bundle.manifest.items[0].providedScope, "section 2");
	assert.match(bundle.manifest.items[0].sourceIdentity, /^m08:M08-synthetic:/);
	assert.ok(bundle.gaps.some(gap => gap.code === "unprovided" &&
		gap.detail.includes("appendix unavailable")));
	await assert.rejects(freezeLocalMaterialBundle({ root: path.join(f.parent, "bad"),
		selections: [{ kind: "m08-manifest", label: "M08 selection",
			manifestFile: path.join(m08.rootDir, "manifest.json"),
			entryRelativePaths: ["materials/not-present"] }] }), /missing or ambiguous/);
});

test("missing, symlinked, malformed and altered evidence never verifies", async t => {
	const f = await fixture(t);
	assert.equal(validateLocalMaterialSelections([{ kind: "declared-file", label: "x",
		path: "x", role: "invented" }]), false);
	const outside = path.join(f.parent, "outside.txt");
	await writeFile(outside, "outside");
	await symlink(outside, path.join(f.parent, "link.txt"));
	await assert.rejects(freezeLocalMaterialBundle({ root: f.root, baseDir: f.parent,
		selections: [{ kind: "declared-file", label: "link", path: "link.txt" }] }),
		/not a regular/);
	const bundle = await freezeLocalMaterialBundle({ root: f.root, baseDir: f.parent,
		selections: [{ kind: "declared-file", label: "text", path: "outside.txt",
			role: "extracted" }] });
	const part = path.join(f.root, bundle.manifest.items[0].parts[0].file);
	await writeFile(part, "changed");
	await assert.rejects(readLocalMaterialBundle(f.root), /bytes changed/);
});

test("assessor index cannot silently erase nontext and unread coverage gaps", async t => {
	const f = await fixture(t);
	await writeFile(path.join(f.parent, "scan.pdf"), Buffer.from("%PDF\0binary"));
	const bundle = await freezeLocalMaterialBundle({ root: f.root, baseDir: f.parent,
		selections: [{ kind: "declared-file", label: "Original scan",
			path: "scan.pdf", role: "original" }] });
	const index = await readFile(bundle.indexFile, "utf8");
	assert.match(index, /nontext/);
	await writeFile(bundle.indexFile, index.replace("nontext", "omitted"));
	await assert.rejects(readLocalMaterialBundle(f.root), /index differs/);
});

test("invalid extracted UTF-8 is preserved byte-for-byte as nontext with an explicit gap", async t => {
	const f = await fixture(t);
	const bad = Buffer.from([0x68, 0x69, 0xff, 0x00]);
	await writeFile(path.join(f.parent, "extracted.md"), bad);
	const bundle = await freezeLocalMaterialBundle({ root: f.root, baseDir: f.parent,
		selections: [{ kind: "declared-file", label: "Failed extraction",
			path: "extracted.md", role: "extracted" }] });
	assert.equal(bundle.manifest.items[0].text, false);
	assert.equal(bundle.manifest.items[0].textProjectionInvalid, true);
	assert.ok(bundle.gaps.some(gap => gap.code === "invalid-text-projection"));
	assert.deepEqual(await readFile(path.join(f.root, bundle.manifest.items[0].parts[0].file)), bad);
	assert.deepEqual((await readLocalMaterialBundle(f.root)).items[0].sha256,
		bundle.manifest.items[0].sha256);
});
