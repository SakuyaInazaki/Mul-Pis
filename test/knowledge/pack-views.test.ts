import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { createFileKnowledgeStore } from "../../src/knowledge/store.ts";
import { renderKnowledgeIndexRecord, renderKnowledgeRecord } from "../../src/knowledge/pack.ts";
import { retrieveKnowledge } from "../../src/knowledge/retrieval.ts";
import type { KnowledgeStore, ProposalBatch, KnowledgeRecord, Limit } from "../../src/knowledge/types.ts";

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

test("both bounded knowledge packs show complete record fields and local store identity without bypassing capacity", async t => {
	const { store } = await fixture(t);
	const storeId = await store.storeId();
	await apply(store, { stage: "M04", runId: "evidence", ops: [
		{ op: "create", type: "E", title: "Measured source", body: "Checked receipt", usageDecision: "adopted" },
	] });
	await apply(store, { stage: "M04", runId: "method", ops: [
		{ op: "create", type: "K", title: "Tensor method", body: "Use only after reading the source receipt", usageDecision: "adopted",
			fields: { tags: ["numeric", "tensor"], retrieval: { keywords: ["matmul"] }, scientificMetadata: { device: "sample-device", metric: "latency" },
				experience: { version: 1, targetKind: "executor", applicableStages: ["M07"], requiredTags: ["numeric"], excludedTags: ["stale"], requiredRefs: [{ storeId, recordId: "E001", version: 1 }] } } },
	] });
	const ordinary = await store.buildPack({ purpose: "M04", ids: ["K001"], includeOpenQuestions: false });
	const selected = await retrieveKnowledge(store, { purpose: "M04", text: "Tensor method", maxRecords: 2, maxChars: 5_000 });
	for (const markdown of [ordinary.markdown, selected.pack.markdown]) {
		assert(markdown.includes("### K001@1"));
		assert(markdown.includes(`本库 storeId：${storeId}`));
		assert.match(markdown, /原始记录元数据（fields；非采用判断）/);
		assert(markdown.includes(`"storeId":"${storeId}","recordId":"E001","version":1`));
		assert.match(markdown, /"requiredTags":\["numeric"\]/);
		assert.match(markdown, /"tags":\["numeric","tensor"\]/);
		assert.match(markdown, /"retrieval":\{"keywords":\["matmul"\]\}/);
		assert.match(markdown, /"scientificMetadata":\{"device":"sample-device","metric":"latency"\}/);
	}
	const ordinaryTight = await store.buildPack({ purpose: "M04", ids: ["K001"], includeOpenQuestions: false, maxChars: 300 });
	const selectedTight = await retrieveKnowledge(store, { purpose: "M04", text: "Tensor method", maxRecords: 2, maxChars: 300 });
	assert(ordinaryTight.truncated);
	assert(!ordinaryTight.markdown.includes("### K001@1"));
	assert(ordinaryTight.markdown.length <= 300);
	assert(!selectedTight.pack.markdown.includes("### K001@1"));
	assert(selectedTight.pack.markdown.length <= 300);
	const empty = await store.buildPack({ purpose: "M04", types: [], includeOpenQuestions: false });
	await assert.rejects(store.buildPack({ purpose: "M04", ids: ["K001"], includeOpenQuestions: false, maxChars: empty.markdown.length - 1 }),
		/knowledge pack header exceeds character budget/);
	const headerOnly = await store.buildPack({ purpose: "M04", ids: ["K001"], includeOpenQuestions: false, maxChars: empty.markdown.length });
	assert.equal(headerOnly.markdown, empty.markdown);
	assert.deepEqual(headerOnly.omitted, ["K001"]);
	await apply(store, { stage: "M04", runId: "many-methods", ops: Array.from({ length: 40 }, (_, index) => ({
		op: "create" as const, type: "K" as const, title: `Additional method ${index}`, body: "Unexpanded detail", usageDecision: "candidate" as const,
	})) });
	const manyOmitted = await store.buildPack({ purpose: "M04", types: ["K"], includeOpenQuestions: false, maxChars: 200 });
	assert.equal(manyOmitted.omitted.length, 41);
	assert.match(manyOmitted.markdown, /未展开 41 项/);
	assert(manyOmitted.markdown.length <= 200);
});


test("discovery indexes locate restrictions without repeating long reasons across historical versions", () => {
	const record: KnowledgeRecord = { id: "K001", version: 1, type: "K", title: "Conditional method", body: "Original method body",
		fields: { retrieval: { context: { backend: "sample", appliedTransforms: ["staging"] } } },
		refs: [{ rel: "applies_in", target: "X001" }], scope: ["X001"], usageDecision: "adopted",
		createdAt: "2026-10-18T00:00:00Z", source: { stage: "M04", runId: "test" } };
	const reason = "COMPLETE-RESTRICTION-REASON ".repeat(500);
	const limits: Limit[] = [{ target: "K001", kind: "needs_recheck", reason, authority: "M04", since: record.createdAt }];
	const report = { id: record.id, version: 1, availability: "needs_recheck" as const, reasons: [reason] };
	const index = Array.from({ length: 20 }, (_, i) => renderKnowledgeIndexRecord({ ...record, version: i + 1 },
		{ ...report, version: i + 1 }, limits, 20)).join("\n");
	assert.doesNotMatch(index, /COMPLETE-RESTRICTION-REASON|Original method body/);
	assert.match(index, /"kind":"needs_recheck","target":"K001","count":1/);
	assert.match(index, /"rel":"applies_in","target":"X001"/);
	assert.match(index, /"appliedTransforms":\["staging"\]/);
	assert.match(index, /K001@20/);
	assert.ok(index.length < reason.length * 2, "historical discovery must not repeat each full restriction reason");
	assert.ok(renderKnowledgeRecord(record, report, limits, 20).includes(reason), "full record rendering still exposes complete restriction reasons");
});
