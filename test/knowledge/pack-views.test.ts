import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { createFileKnowledgeStore } from "../../src/knowledge/store.ts";
import type { KnowledgeStore, ProposalBatch } from "../../src/knowledge/types.ts";

async function fixture(t: TestContext): Promise<{ dir: string; store: KnowledgeStore }> {
	const dir = await mkdtemp(path.join(tmpdir(), "pre-rsi-pack-"));
	t.after(async () => rm(dir, { recursive: true, force: true }));
	const store = createFileKnowledgeStore(dir);
	await store.init();
	return { dir, store };
}

async function apply(store: KnowledgeStore, batch: ProposalBatch): Promise<void> {
	const receipt = await store.submitProposal(batch);
	assert.equal(receipt.structurallyValid, true, receipt.issues.map((item) => item.message).join("; "));
	await store.merge(receipt.proposalId);
}

test("buildPack honours pinned versions and reports whole-record truncation", async (t) => {
	const { store } = await fixture(t);
	await apply(store, {
		stage: "test",
		runId: "seed",
		ops: [
			{ op: "create", type: "C", title: "Alpha one", body: "A".repeat(260), usageDecision: "adopted" },
			{ op: "create", type: "C", title: "Alpha two", body: "B".repeat(260), usageDecision: "candidate" },
			{ op: "create", type: "C", title: "Alpha three", body: "C".repeat(260), usageDecision: "working_assumption" },
			{ op: "create", type: "Q", title: "开放问题", body: "仍待处理" },
		],
	});
	await apply(store, { stage: "test", runId: "revise", ops: [{ op: "revise", id: "C001", body: "新版正文", reason: "更新" }] });

	const pinned = await store.buildPack({ purpose: "检查旧版", ids: ["C001@1"], includeOpenQuestions: false });
	assert.match(pinned.markdown, /### C001@1 Alpha one/);
	assert.match(pinned.markdown, /入库不等于科学认证；当前可用性是派生判断/);
	assert.equal(pinned.included[0].version, 1);

	const pack = await store.buildPack({ purpose: "截断测试", terms: ["alpha"], includeOpenQuestions: false, maxChars: 700 });
	assert.equal(pack.truncated, true);
	assert(pack.omitted.length > 0);
	assert.match(pack.markdown, /（已按长度截断，未展开：/);
	for (const id of pack.omitted) assert(!pack.markdown.includes(`### ${id}@`));
});

test("regenerateViews rebuilds current understanding, corrections, questions, limits and index", async (t) => {
	const { dir, store } = await fixture(t);
	await apply(store, {
		stage: "test",
		runId: "seed",
		ops: [
			{ op: "create", type: "C", title: "当前认识条目", body: "内容", usageDecision: "candidate" },
			{ op: "create", type: "K", title: "检查判据", body: "判据", usageDecision: "working_assumption" },
			{ op: "create", type: "Q", title: "仍开放", body: "问题" },
		],
	});
	await apply(store, {
		stage: "test",
		runId: "change",
		ops: [
			{ op: "revise", id: "C001", body: "修订内容", reason: "纠正表述" },
			{ op: "decide", id: "K001", usageDecision: "adopted", reason: "本轮采用" },
			{ op: "limit", target: "C001@2", kind: "needs_recheck", reason: "待核对", authority: "reviewer" },
		],
	});
	await store.regenerateViews();

	const understanding = await readFile(path.join(dir, "views", "current-understanding.md"), "utf8");
	const corrections = await readFile(path.join(dir, "views", "corrections.md"), "utf8");
	const questions = await readFile(path.join(dir, "views", "open-questions.md"), "utf8");
	const limits = await readFile(path.join(dir, "views", "limits.md"), "utf8");
	const index = JSON.parse(await readFile(path.join(dir, "_index", "records.json"), "utf8")) as Array<Record<string, unknown>>;
	assert.match(understanding, /C001@2 当前认识条目 — candidate \/ needs_recheck/);
	assert.match(understanding, /K001@2 检查判据 — adopted \/ usable_conditionally/);
	assert.match(corrections, /C001@2.*纠正表述/);
	assert.match(corrections, /D001@1/);
	assert.match(questions, /Q001@1 仍开放/);
	assert.match(limits, /needs_recheck C001@2/);
	assert(index.some((entry) => entry.id === "C001" && entry.version === 2 && entry.availability === "needs_recheck"));
});
