import assert from "node:assert/strict";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { createFileKnowledgeStore } from "../../src/knowledge/store.ts";
import type { KnowledgeStore, ProposalBatch } from "../../src/knowledge/types.ts";

async function fixture(t: TestContext): Promise<{ dir: string; store: KnowledgeStore }> {
	const dir = await mkdtemp(path.join(tmpdir(), "pre-rsi-knowledge-"));
	t.after(async () => rm(dir, { recursive: true, force: true }));
	const store = createFileKnowledgeStore(dir);
	await store.init();
	return { dir, store };
}

async function submitAndMerge(store: KnowledgeStore, batch: ProposalBatch) {
	const receipt = await store.submitProposal(batch);
	assert.equal(receipt.structurallyValid, true, receipt.issues.map((item) => item.message).join("; "));
	return store.merge(receipt.proposalId);
}



test("create, revise, decide, close_q, limit and lift_limit keep history", async (t) => {
	const { dir, store } = await fixture(t);
	const first = await submitAndMerge(store, {
		stage: "test",
		runId: "run-1",
		ops: [
			{ op: "create", type: "C", title: "初始认识", body: "第一版", usageDecision: "candidate", handle: "$1" },
			{ op: "create", type: "Q", title: "待回答", body: "问题正文", handle: "$2", refs: [{ rel: "questions", target: "$1" }] },
		],
	});
	assert.equal(first.snapshot.id, "G001");
	assert.deepEqual(
		first.snapshot.records,
		[
			{ id: "C001", version: 1 },
			{ id: "Q001", version: 1 },
		],
	);

	const second = await submitAndMerge(store, {
		stage: "test",
		runId: "run-2",
		baseSnapshot: "G001",
		ops: [
			{ op: "revise", id: "C001", body: "第二版", reason: "补足条件" },
			{ op: "decide", id: "C001", usageDecision: "adopted", reason: "用于当前任务", context: "默认情境" },
			{ op: "close_q", id: "Q001", closeReason: "answered", reason: "已有回答" },
			{ op: "limit", target: "C001", kind: "suspended", reason: "等待复算", authority: "reviewer" },
		],
	});
	assert.equal(second.snapshot.id, "G002");
	assert.deepEqual(second.limitsWrittenFirst, ["C001:suspended"]);
	assert(second.snapshot.activeLimits.includes("C001:suspended"));
	for (const relative of ["records/C001/v1.md", "records/C001/v2.md", "records/C001/v3.md", "records/Q001/v1.md", "records/Q001/v2.md", "records/D001/v1.md"]) {
		await access(path.join(dir, relative));
	}
	const revised = await store.get("C001", 2);
	assert.equal(revised?.supersedes, "C001@1");
	assert(revised?.refs.some((ref) => ref.rel === "replaces" && ref.target === "C001@1"));
	const decided = await store.get("C001");
	assert.equal(decided?.version, 3);
	assert.equal(decided?.usageDecision, "adopted");
	const decision = await store.get("D001");
	assert.match(decision?.body ?? "", /用于当前任务/);
	assert(decision?.refs.some((ref) => ref.target === "C001@2"));
	const question = await store.get("Q001");
	assert.deepEqual(question?.qStatus, { open: false, closeReason: "answered" });
	assert.equal((await store.availability("C001")).availability, "not_allowed");

	await submitAndMerge(store, {
		stage: "test",
		runId: "run-3",
		ops: [
			{ op: "lift_limit", target: "C001", reason: "复算完成", authority: "reviewer" },
			{ op: "create", type: "C", title: "另一认识", body: "不会复用编号" },
		],
	});
	assert.equal((await store.availability("C001")).availability, "usable_conditionally");
	assert.equal((await store.get("C002"))?.title, "另一认识");
	const limits = await store.limits();
	assert.equal(limits.length, 1);
	assert.equal(limits[0].liftReason, "复算完成");
	assert.ok(limits[0].liftedAt);
});




test("withdrawal disables pinned older versions and propagates through dependency chains", async (t) => {
	const { store } = await fixture(t);
	await submitAndMerge(store, { stage: "M04", runId: "seed", ops: [
		{ op: "create", type: "C", title: "上游认识", body: "有条件认识", usageDecision: "adopted", handle: "$claim" },
		{ op: "create", type: "J", title: "依赖论证", body: "引用上游", usageDecision: "adopted", handle: "$argument", refs: [{ rel: "premise_of", target: "$claim" }] },
		{ op: "create", type: "K", title: "下游方法", body: "依赖论证", usageDecision: "adopted", refs: [{ rel: "checks", target: "$argument" }] },
	] });
	const withdrawn = await submitAndMerge(store, { stage: "M04", runId: "withdraw", ops: [{ op: "decide", id: "C001", usageDecision: "withdrawn", reason: "新证据反驳" }] });
	assert(withdrawn.limitsWrittenFirst.includes("C001:withdrawn"));
	assert.equal((await store.availability("C001", 1)).availability, "not_allowed");
	assert.equal((await store.availability("J001", 1)).availability, "needs_recheck");
	assert.equal((await store.availability("K001", 1)).availability, "needs_recheck");
	await submitAndMerge(store, { stage: "M04", runId: "adopt-without-lift", ops: [{ op: "decide", id: "C001", usageDecision: "adopted", reason: "另一个用途" }] });
	assert.equal((await store.availability("C001")).availability, "not_allowed", "a new adopted version does not silently lift an old withdrawal");
});



test("concurrent merges are serial and publish G001 then G002", async (t) => {
	const { dir, store } = await fixture(t);
	const one = await store.submitProposal({ stage: "test", runId: "one", ops: [{ op: "create", type: "C", title: "一", body: "one" }] });
	const two = await store.submitProposal({ stage: "test", runId: "two", ops: [{ op: "create", type: "C", title: "二", body: "two" }] });
	const [first, second] = await Promise.all([store.merge(one.proposalId), store.merge(two.proposalId)]);
	assert.equal(first.snapshot.id, "G001");
	assert.equal(second.snapshot.id, "G002");
	assert.equal((await store.current())?.id, "G002");
	assert.equal((await store.get("C001"))?.title, "一");
	assert.equal((await store.get("C002"))?.title, "二");
	await access(path.join(dir, "snapshots", "G001.json"));
	await access(path.join(dir, "snapshots", "G002.json"));
});
