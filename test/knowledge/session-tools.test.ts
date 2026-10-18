import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { activeLimitsFor, assertStableKnowledge, characterRange, recordDependencyIndex, renderOriginalRecord,
	resolveSnapshotRecord, selectKnowledgePage, snapshotRecordBudget } from "../../src/knowledge/session-tools.ts";
import { createFileKnowledgeStore } from "../../src/knowledge/store.ts";
import type { KnowledgeStore, ProposalOp } from "../../src/knowledge/types.ts";

async function fixture(t: TestContext): Promise<KnowledgeStore> {
	const dir = await mkdtemp(path.join(tmpdir(), "pre-rsi-session-tools-"));
	t.after(async () => rm(dir, { recursive: true, force: true }));
	const store = createFileKnowledgeStore(dir);
	await store.init();
	const ops: ProposalOp[] = [
		{ op: "create", type: "C", title: "搬运合并", body: "合并非连续搬运可降低 MTE2 事务", usageDecision: "adopted" },
		{ op: "create", type: "J", title: "条件论证", body: "只在尾块可整除时成立",
			refs: [{ rel: "limits", target: "$claim" }] },
	];
	ops[0] = { ...ops[0], handle: "$claim" } as ProposalOp;
	const receipt = await store.submitProposal({ stage: "M04", runId: "r1", ops });
	assert.equal(receipt.structurallyValid, true, receipt.issues.map((item) => item.message).join("; "));
	await store.merge(receipt.proposalId);
	return store;
}

test("a selection page is bounded by record ordinals and reports the exact refs it returned", async (t) => {
	const store = await fixture(t);
	const snapshot = await store.current();
	assert.equal(snapshotRecordBudget(snapshot), 2);
	const page = await selectKnowledgePage(store, { purpose: "test", text: "搬运", snapshot,
		offset: 0, limit: 1, view: "index", scope: "test" });
	assert.equal(page.total, page.refs.length);
	assert.equal(page.returnedRefs.length, 1);
	assert.equal(page.blocks.length, 1);
	assert.ok(page.blocks[0].includes(page.returnedRefs[0]));
	const second = await selectKnowledgePage(store, { purpose: "test", text: "搬运", snapshot,
		offset: 1, limit: 1, view: "brief", scope: "test" });
	assert.notDeepEqual(second.returnedRefs, page.returnedRefs);
	await assert.rejects(selectKnowledgePage(store, { purpose: "test", text: "搬运", snapshot,
		offset: page.total + 1, limit: 1, view: "index", scope: "test" }), /exceeds selection length/);
});

test("version resolution stays inside the frozen snapshot and paging is explicit about the end", async (t) => {
	const store = await fixture(t);
	const snapshot = await store.current();
	const resolved = await resolveSnapshotRecord(store, snapshot, "C001", undefined, "test");
	assert.equal(resolved.status, "resolved");
	assert.equal(resolved.status === "resolved" && resolved.resolved.ref, "C001@1");
	for (const [id, version] of [["C001", 2], ["C999", undefined]] as const)
		assert.equal((await resolveSnapshotRecord(store, snapshot, id, version, "test")).status, "not-in-snapshot");
	const record = resolved.status === "resolved" ? resolved.resolved.record : undefined;
	const content = renderOriginalRecord(record!, "# 原件", ["- 附加行"]);
	assert.match(content, /^# 原件\n- 附加行\n- 原始元数据/u);
	assert.ok(!content.includes('"body"'), "the body is rendered once, not also inside the metadata JSON");
	assert.deepEqual(characterRange(content, 0, 5), { offset: 0, end: 5, total: content.length });
	assert.deepEqual(characterRange(content, content.length, 5), { offset: content.length, end: content.length, total: content.length });
	assert.equal(characterRange(content, content.length + 1, 5), undefined);
});

test("stability and live limits are evaluated against the store, not against a cached copy", async (t) => {
	const store = await fixture(t);
	const snapshot = await store.current();
	const selection = await recordDependencyIndex(store, snapshot, "C001@1", "test");
	await assertStableKnowledge(store, snapshot?.id, selection.limits, "test");
	const receipt = await store.submitProposal({ stage: "M04", runId: "r2",
		ops: [{ op: "limit", target: "C001", kind: "suspended", reason: "等待复算", authority: "user" }] });
	await store.merge(receipt.proposalId);
	await assert.rejects(assertStableKnowledge(store, snapshot?.id, selection.limits, "test"), /snapshot changed/);
	const current = await store.current();
	await assert.rejects(assertStableKnowledge(store, current?.id, selection.limits, "test"), /limits changed/);
	assert.equal(activeLimitsFor(await store.limits(), ["C001@1"]).length, 1);
	assert.equal(activeLimitsFor(await store.limits(), ["J001@1"]).length, 0);
});
