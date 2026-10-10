import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { createFileKnowledgeStore } from "../src/knowledge/store.ts";
import { openDefaultLocalMission } from "../src/m07/local-mission.ts";
import { readLocalMaterialBundle } from "../src/m07/local-material-bundle.ts";
import { FakeSessionRunner } from "../src/runner/fake.ts";
import { runInit } from "../src/stages/init.ts";
import { Workspace } from "../src/workspace.ts";

async function fixture(t: TestContext) {
	const root = await mkdtemp(path.join(os.tmpdir(), "local-mission-media-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const ws = new Workspace(root);
	await mkdir(ws.rawDir, { recursive: true });
	await writeFile(ws.problemFile, "User's complete original question\n");
	await writeFile(path.join(ws.rawDir, "incidental.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
	await runInit(ws, createFileKnowledgeStore(ws.knowledgeDir));
	const sourceDir = path.join(root, "selected");
	await mkdir(sourceDir);
	const pdf = path.join(sourceDir, "original.pdf");
	const projection = path.join(sourceDir, "extracted.md");
	const pdfBytes = Buffer.from("%PDF-1.4\nsynthetic original bytes\n", "utf8");
	const projectionBytes = Buffer.from("Extracted text covers a known portion of the PDF.\n", "utf8");
	await writeFile(pdf, pdfBytes);
	await writeFile(projection, projectionBytes);
	const request = { version: 1 as const, kind: "local-original-objective-request" as const,
		goal: "Answer the original question using supplied sources", goalSource: "verbatim-private-input" as const,
		obligations: [{ id: "answer", description: "Support the complete answer",
			type: "file-sha256", expectedSha256: "0".repeat(64) }],
		closure: "open-ended" as const,
		materials: [
			{ kind: "declared-file" as const, label: "Original PDF", path: pdf,
				role: "original" as const, providedScope: "unknown" },
			{ kind: "declared-file" as const, label: "PDF text projection", path: projection,
				role: "extracted" as const, providedScope: "partial" },
		] };
	return { root, ws, pdf, projection, pdfBytes, projectionBytes, request };
}

test("declared binary original and text projection survive the local host without false read credit", async t => {
	const f = await fixture(t);
	let prompts = 0;
	const runner = new FakeSessionRunner(async ({ spec }) => {
		prompts++;
		if (prompts > 4)
			throw new DOMException("Synthetic stop after material handoff checks", "AbortError");
		assert.equal(spec.tools.kind, "read-dir");
		if (spec.tools.kind !== "read-dir") throw new Error("expected read-dir");
		const names = await readdir(spec.tools.root);
		assert(names.includes("material-index-1.md"));
		assert(names.includes("M0002-part-1.txt"));
		assert(!names.some(name => name.endsWith(".pdf") || name.endsWith(".bin")));
		const index = await readFile(path.join(spec.tools.root, "material-index-1.md"), "utf8");
		assert.match(index, /nontext/);
		assert.match(index, /projection-only/);
		assert.match(index, /coverage-unverified/);
		assert.equal(await readFile(path.join(spec.tools.root, "M0002-part-1.txt"), "utf8"),
			f.projectionBytes.toString("utf8"));
		return "synthetic deliberately invalid assessment";
	});
	const mission = openDefaultLocalMission({ workspaceRoot: f.root, runner,
		config: { roles: { research: "fake/research", execution: "fake/execution" },
			localMission: { evaluatorId: "host:file-sha256" },
			concurrency: 1, tools: {} } });
	const started = await mission.begin(f.request);
	assert.deepEqual(started.contract.inputNames, ["Original PDF", "PDF text projection"]);
	const materialRoot = path.join(f.ws.agentDir, "missions", started.contract.id, "materials");
	const manifest = await readLocalMaterialBundle(materialRoot);
	assert.equal(manifest.items.length, 2);
	assert.deepEqual(manifest.items.map(item => item.role), ["original", "extracted"]);
	assert((await readFile(path.join(materialRoot, manifest.items[0]!.parts[0]!.file)))
		.equals(f.pdfBytes));
	assert((await readFile(path.join(materialRoot, manifest.items[1]!.parts[0]!.file)))
		.equals(f.projectionBytes));
	const result = await mission.step(started.contract.id);
	assert(prompts > 0);
	assert.equal(result.stopReason, "cancelled");
	assert.equal(result.objectiveOutcome, "incomplete");
});

test("changed selected projection or coverage index blocks reassessment before a model call", async t => {
	for (const target of ["projection", "index"] as const) {
		const f = await fixture(t);
		let prompts = 0;
		const mission = openDefaultLocalMission({ workspaceRoot: f.root,
			runner: new FakeSessionRunner(() => { prompts++; return "unused"; }),
			config: { roles: { research: "fake/research", execution: "fake/execution" },
				concurrency: 1, tools: {} } });
		const started = await mission.begin(f.request);
		const bundle = path.join(f.ws.agentDir, "missions", started.contract.id, "materials");
		const manifest = await readLocalMaterialBundle(bundle);
		const file = target === "projection" ? manifest.items[1]!.parts[0]!.file : manifest.indexFiles[0]!;
		await writeFile(path.join(bundle, file), "altered provenance or selected projection\n");
		await assert.rejects(mission.step(started.contract.id));
		assert.equal(prompts, 0);
	}
});

test("missing declared projection has no committed mission or model call", async t => {
	const f = await fixture(t);
	await rm(f.projection);
	let prompts = 0;
	const mission = openDefaultLocalMission({ workspaceRoot: f.root,
		runner: new FakeSessionRunner(() => { prompts++; return "unused"; }),
		config: { roles: { research: "fake/research", execution: "fake/execution" },
			concurrency: 1, tools: {} } });
	await assert.rejects(mission.begin(f.request));
	assert.equal(prompts, 0);
});
