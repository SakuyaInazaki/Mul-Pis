import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { createFileKnowledgeStore } from "../src/knowledge/store.ts";
import { FakeSessionRunner } from "../src/runner/fake.ts";
import type { ReadReturnEvent } from "../src/runner/types.ts";
import { runM04 } from "../src/stages/m04.ts";
import { runM06 } from "../src/stages/m06.ts";
import type { StageContext } from "../src/stages/context.ts";
import { Workspace } from "../src/workspace.ts";

async function fixture(t: TestContext): Promise<{ ctx: StageContext; sourceDir: string }> {
	const root = await mkdtemp(path.join(tmpdir(), "m06-evidence-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const ws = new Workspace(root);
	await mkdir(path.dirname(ws.problemFile), { recursive: true });
	await writeFile(ws.problemFile, "Check a conditional claim.\n");
	const sourceDir = path.join(ws.referencesDir, "sources", "S001");
	await mkdir(sourceDir, { recursive: true });
	await writeFile(path.join(sourceDir, "source.md"), "# Registered source\n");
	await writeFile(path.join(sourceDir, "paper.md"), "premise\nlimitation\n");
	const store = createFileKnowledgeStore(ws.knowledgeDir);
	await store.init();
	const config = { roles: { reader: "fake/reader", checker: "fake/checker", applicability: "fake/applicability", research: "fake/research" }, concurrency: 1, tools: {} };
	return { ctx: { ws, store, runner: new FakeSessionRunner(() => ""), config }, sourceDir };
}

function readEvent(file: string, startLine: number, endLine: number, truncated = false): ReadReturnEvent {
	return { toolName: "material_read", status: "returned", path: file, requested: {},
		returned: { kind: "text", startLine, endLine, truncated }, at: new Date().toISOString() };
}

test("M06 fullText does not accept one returned page as complete registered text", async t => {
	const { ctx, sourceDir } = await fixture(t);
	ctx.runner = new FakeSessionRunner(({ spec }) => spec.label.endsWith("-reader")
		? { text: "Reader claims complete text", reads: ["paper.md"], readReturns: [
			readEvent("source.md", 1, 1), readEvent("paper.md", 1, 1, true)] }
		: "Independent check");
	const result = await runM06(ctx, { sources: ["S001"], fullText: true });
	assert.equal(result.groups[0]!.status, "failed");
	assert.match(result.groups[0]!.failure!, /paper\.md/);
	assert(result.record.outputs.some((item) => item.label === "S001 阅读实际返回范围"));
	const text = "# Frozen source\n" + JSON.stringify({ original: "证据".repeat(20000) }) + "\n";
	await writeFile(path.join(sourceDir, "paper.md"), text);
	const pages: ReadReturnEvent[] = [];
	for (let offset = 0; offset < text.length; offset += 16000) {
		const end = Math.min(text.length, offset + 16000);
		pages.push({ toolName: "material_read", status: "returned", path: "paper.md", requested: { textOffset: offset },
			returned: { kind: "text", textOffset: offset, textEnd: end, textTotal: text.length, truncated: end < text.length },
			at: new Date().toISOString() });
	}
	const omitted = pages[1];
	for (const complete of [false, true]) {
		ctx.runner = new FakeSessionRunner(({ spec }) => spec.label.endsWith("-reader")
			? { text: "Read the frozen original in character pages", reads: ["source.md", "paper.md"], readReturns: [
				readEvent("source.md", 1, 1), ...pages.filter(page => complete || page !== omitted)] }
			: "Independent check");
		const paged = await runM06(ctx, { sources: ["S001"], fullText: true });
		assert.equal(paged.groups[0]!.status, complete ? "completed" : "failed");
		if (!complete) assert.match(paged.groups[0]!.failure!, /paper\.md/);
	}
});

test("M06 freezes registered sources and M04 can inspect their reading and check reports", async t => {
	const { ctx, sourceDir } = await fixture(t);
	const runner = new FakeSessionRunner(({ spec }) => {
		if (spec.label.endsWith("-reader")) return { text: "Reading with scope", reads: ["source.md", "paper.md"], readReturns: [
			readEvent("source.md", 1, 1), readEvent("paper.md", 1, 1, true), readEvent("paper.md", 2, 2)] };
		if (spec.label.endsWith("-checker")) return { text: "Independent check found limitation", reads: ["paper.md"] };
		if (spec.label.endsWith("-applicability")) return "Conditional applicability";
		return { text: "No knowledge proposal after checking the frozen source.", reads: ["manifest.json", "reports/S001/reading.md", "reports/S001/check.md"] };
	});
	ctx.runner = runner;
	const m06 = await runM06(ctx, { sources: ["S001"], fullText: true });
	assert.equal(m06.groups[0]!.status, "completed");
	await writeFile(path.join(sourceDir, "paper.md"), "later changed original\n");
	assert.equal(await readFile(path.join(m06.groups[0]!.dir, "paper.md"), "utf8"), "premise\nlimitation\n");
	const m04 = await runM04(ctx, { feedback: { kind: "M06", runId: m06.record.runId } });
	assert.equal(m04.mode, "research-session");
	const spec = runner.created.findLast((item) => item.label === "M04-research")!;
	assert.equal(spec.tools.kind, "read-dir");
	if (spec.tools.kind === "read-dir") {
		assert.equal(spec.tools.toolName, "m06_evidence_read");
		assert.equal(spec.tools.root, path.join(ctx.ws.runDir("M06", m06.record.runId), "frozen"));
	}
	const message = [...runner.sessions.values()].findLast((item) => item.spec.label === "M04-research")!.transcript[0]!.text;
	assert.match(message, /reports\/S001\/reading\.md/);
	assert.match(message, /reports\/S001\/check\.md/);
});

test("M04 retains a legacy M06 report while marking present-day source copies and missing files", async t => {
	const { ctx, sourceDir } = await fixture(t);
	const old = await ctx.ws.startRun("M06", [{ label: "旧时登记来源 S001", path: sourceDir }]);
	await ctx.ws.writeOutput(old, "batch-summary.md", "Historical M06 conclusion with an unresolved condition.", "整批汇总");
	await ctx.ws.writeOutput(old, "S001/reading.md", "Historical reading report.", "S001 阅读记录");
	await ctx.ws.writeOutput(old, "S001/check.md", "Historical check report.", "S001 核对记录");
	const missing = await ctx.ws.writeOutput(old, "S001/missing.txt", "Former attachment.", "S001 已失附件");
	await ctx.ws.finishRun(old, "completed");
	await rm(missing.path);
	await writeFile(path.join(sourceDir, "paper.md"), "current source version only\n");
	const runner = new FakeSessionRunner(() => "Historical conclusion remains conditional; no knowledge proposal.");
	ctx.runner = runner;
	const m04 = await runM04(ctx, { feedback: { kind: "M06", runId: old.runId } });
	assert.equal(m04.record.status, "completed");
	const spec = runner.created.find((item) => item.label === "M04-research")!;
	assert.equal(spec.tools.kind, "read-dir");
	if (spec.tools.kind === "read-dir") {
		assert.equal(spec.tools.toolName, "m06_evidence_read");
		const manifest = JSON.parse(await readFile(path.join(spec.tools.root, "manifest.json"), "utf8"));
		assert.equal(manifest.stage, "M04");
		assert.equal(manifest.runId, m04.record.runId);
		const source = manifest.entries.find((item: { sourceCategory: string }) => item.sourceCategory === "historical-input");
		assert.equal(await readFile(path.join(source.frozenPath, "paper.md"), "utf8"), "current source version only\n");
	}
	const prompt = [...runner.sessions.values()].find((item) => item.spec.label === "M04-research")!.transcript[0]!.text;
	assert.match(prompt, /当前原材料版本未证实与旧阅读时同版/);
	assert.match(prompt, /已失附件/);
});
