import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { createFileKnowledgeStore } from "../src/knowledge/store.ts";
import { FakeSessionRunner } from "../src/runner/fake.ts";
import { runM06 } from "../src/stages/m06.ts";
import { extractSourceKnowledge, sourceExtractionInstruction } from "../src/stages/source-knowledge.ts";
import type { StageContext } from "../src/stages/context.ts";
import { Workspace } from "../src/workspace.ts";

const contractCard = {
	version: 1, kind: "contract", operatorCategory: "normalization", canonicalFamily: "layernorm",
	bottleneck: "compile_failure", applicability: { backend: "ascend-c", toolchain: "CANN-8.0" },
	provenance: { kind: "external-source", detail: "S001 第 3 节" },
	api: "AscendC::Add", signature: "void Add(LocalTensor<T>&, const LocalTensor<T>&, int32_t)",
	constraints: [{ name: "ub_bytes", unit: "bytes", limit: 196352, comparison: "at_most", source: "S001" }],
	source: "S001",
};

const block = (value: unknown): string => "```knowledge-card\n" + JSON.stringify(value, null, 2) + "\n```";

test("source extraction keeps validated cards, rejects unanchored ones and records the depth", () => {
	const text = ["适用性：支持", "## 阅读深度", "深度：L2", "升级理由：需与本项目 msprof 结果对照才能判断搬运占比",
		"## 可执行化产出", block(contractCard),
		block({ ...contractCard, source: "https://example.invalid/doc" })].join("\n\n");
	const extraction = extractSourceKnowledge(text);
	assert.equal(extraction.depth, "L2");
	assert.match(extraction.depthReason ?? "", /msprof/);
	assert.equal(extraction.conclusion, "actionable");
	assert.equal(extraction.cards.filter((item) => item.card).length, 1);
	assert.match(extraction.cards.find((item) => !item.card)!.issues.join(";"), /本地出处/);
	assert.deepEqual(extraction.issues, []);

	// A source that yields nothing usable is inconclusive, not a failure.
	const empty = extractSourceKnowledge("适用性：仅类比启发\n\n## 阅读深度\n\n深度：L1\n\n## 可执行化产出\n\n无");
	assert.equal(empty.conclusion, "inconclusive");
	assert.equal(empty.cards.length, 0);
	assert.deepEqual(empty.issues, []);

	// Escalating past pattern triage requires a stated reason, and a missing
	// declaration is reported rather than guessed.
	assert.match(extractSourceKnowledge("深度：L3").issues.join(";"), /升级理由/);
	assert.match(extractSourceKnowledge("没有声明").issues.join(";"), /深度/);
	assert.match(extractSourceKnowledge("## 可执行化产出\n\n```knowledge-card\n{ not json\n```").cards[0].issues.join(";"), /JSON/);
	assert.ok(sourceExtractionInstruction("S001").includes("S001"));
});

async function fixture(t: TestContext): Promise<StageContext> {
	const root = await mkdtemp(path.join(tmpdir(), "m06-extraction-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const ws = new Workspace(root);
	await mkdir(path.dirname(ws.problemFile), { recursive: true });
	await writeFile(ws.problemFile, "把 layernorm 算子跑得更快。\n");
	for (const id of ["S001", "S002"]) {
		const dir = path.join(ws.referencesDir, "sources", id);
		await mkdir(dir, { recursive: true });
		await writeFile(path.join(dir, "source.md"), `# ${id} 登记材料\n`);
		await writeFile(path.join(dir, "paper.md"), "接口与约束说明\n");
	}
	const store = createFileKnowledgeStore(ws.knowledgeDir);
	await store.init();
	return { ws, store, runner: new FakeSessionRunner(() => ""),
		config: { roles: { reader: "fake/reader", checker: "fake/checker", applicability: "fake/applicability" }, concurrency: 1, tools: {} } };
}

test("M06 freezes a validated extraction per source and marks an unusable source inconclusive", async (t) => {
	const ctx = await fixture(t);
	ctx.runner = new FakeSessionRunner(({ spec, message }) => {
		if (spec.label.endsWith("-reader")) return { text: "阅读记录\n\n## 实际阅读范围\n\npaper.md\n\n## 疑点与缺口\n\n无", reads: ["paper.md"] };
		if (spec.label.endsWith("-checker")) return { text: "核对：忠实\n\n## 实际核对范围\n\npaper.md", reads: ["paper.md"] };
		assert.ok(message.includes("## 可执行化产出"), "applicability session is told what structure to produce");
		return spec.label.includes("S001")
			? ["适用性：支持", "## 处理建议", "无", "## 阅读深度", "深度：L1", "## 可执行化产出", block(contractCard),
				block({ ...contractCard, api: undefined, signature: undefined, constraints: [] })].join("\n\n")
			: ["适用性：只有类比启发", "## 处理建议", "无", "## 阅读深度", "深度：L1", "## 可执行化产出", "无"].join("\n\n");
	});
	const result = await runM06(ctx, { sources: ["S001", "S002"] });
	const [first, second] = result.groups;
	assert.equal(first.status, "completed");
	assert.equal(first.depth, "L1");
	assert.equal(first.conclusion, "actionable");
	assert.equal(first.extraction?.accepted, 1);
	assert.equal(first.extraction?.rejected, 1);
	assert.equal(second.conclusion, "inconclusive");
	assert.equal(second.extraction?.accepted, 0);

	const frozen = first.outputs.find((item) => item.label === "S001 结构化抽取（宿主校验结果）")!;
	const report = JSON.parse(await readFile(frozen.path, "utf8")) as { conclusion: string; accepted: Array<{ cardKind: string }>; rejected: Array<{ issues: string[] }> };
	assert.equal(report.conclusion, "actionable");
	assert.deepEqual(report.accepted.map((item) => item.cardKind), ["contract"]);
	assert.match(report.rejected[0].issues.join(";"), /api\+signature|硬约束/);

	const summary = await readFile(result.summaryPath, "utf8");
	assert.match(summary, /阅读深度：L1/);
	assert.match(summary, /结构化抽取：inconclusive/);
	// Extraction is a structural check; nothing was adopted into the store.
	assert.equal((await ctx.store.list()).length, 0);
});
