import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { createExperienceProvider, discoverLocalM07Experiences } from "../../src/knowledge/experience-index.ts";
import { createFileKnowledgeStore } from "../../src/knowledge/store.ts";
import type { KnowledgeRef, KnowledgeStore, ProposalBatch } from "../../src/knowledge/types.ts";

async function fixture(t: TestContext): Promise<{ dir: string; store: KnowledgeStore; storeId: string }> {
	const dir = await mkdtemp(path.join(tmpdir(), "pre-rsi-experience-"));
	t.after(async () => rm(dir, { recursive: true, force: true }));
	const store = createFileKnowledgeStore(dir);
	await store.init();
	return { dir, store, storeId: await store.storeId() };
}

async function apply(store: KnowledgeStore, ops: ProposalBatch["ops"]): Promise<void> {
	const receipt = await store.submitProposal({ stage: "M04", runId: "feedback", ops });
	assert.equal(receipt.structurallyValid, true, receipt.issues.map((item) => item.message).join("; "));
	await store.merge(receipt.proposalId);
}

const ref = (storeId: string, recordId: string, version = 1): KnowledgeRef => ({ storeId, recordId, version });
const experience = (targetKind: "executor" | "improver", requiredRefs: KnowledgeRef[], requiredTags: string[] = []) => ({
	version: 1, targetKind, applicableStages: [targetKind === "executor" ? "M07" : "improvement"],
	requiredTags, excludedTags: [], requiredRefs,
});
const query = (requestedRefs: KnowledgeRef[], extra: Record<string, unknown> = {}) => ({
	targetKind: "executor" as const, applicability: { stage: "M07", tags: ["execute", "numeric"], contextRefs: requestedRefs.map((item) => ref(item.storeId, "X001")) },
	requestedRefs, maxRecords: 5, maxChars: 10_000, ...extra,
});


test("bounded selection keeps pinned evidence, argument and context together; live withdrawal blocks reuse", async (t) => {
	const { store, storeId } = await fixture(t);
	await apply(store, [
		{ op: "create", type: "E", title: "实测反馈", body: "测量仅在给定环境成立", usageDecision: "adopted" },
		{ op: "create", type: "J", title: "条件论证", body: "解释证据范围", usageDecision: "adopted" },
		{ op: "create", type: "X", title: "适用情境", body: "数值任务", usageDecision: "adopted" },
	]);
	const dependencies = [ref(storeId, "E001"), ref(storeId, "J001"), ref(storeId, "X001")];
	await apply(store, [{ op: "create", type: "K", title: "方法经验", body: "遇到该类偏差时先检查测量条件", usageDecision: "adopted", scope: ["X001"], fields: { experience: experience("executor", dependencies, ["numeric"]) } }]);
	const selected = ref(storeId, "K001");
	const provider = createExperienceProvider(store);
	const ready = await provider.select(query([selected], { expectedSnapshotId: (await store.current())!.id }));
	assert.equal(ready.status, "ready");
	assert.equal(ready.selected.length, 1);
	for (const name of ["实测反馈", "条件论证", "适用情境", "方法经验"]) assert.match(ready.markdown, new RegExp(name));
	assert.match(ready.markdown, /"requiredTags":\["numeric"\]/);
	assert.match(ready.markdown, new RegExp(`"storeId":"${storeId}","recordId":"E001","version":1`));
	await apply(store, [{ op: "decide", id: "E001", usageDecision: "withdrawn", reason: "反馈失效" }]);
	const revoked = await provider.select(query([selected]));
	assert.equal(revoked.status, "incomplete");
	assert.equal(revoked.markdown, "");
	assert.match(revoked.omitted.map((item) => item.reason).join(" "), /availability:not_allowed/);
	assert.equal((await store.get("E001", 1))?.body, "测量仅在给定环境成立", "withdrawn evidence remains readable for historical review");
});

test("versioned X scope matches only its pinned version through experience dependencies", async (t) => {
	const { store, storeId } = await fixture(t);
	await apply(store, [{ op: "create", type: "X", title: "版本化情境", body: "初始情境", usageDecision: "adopted" }]);
	await apply(store, [{ op: "create", type: "E", title: "限定证据", body: "只适用于情境第一版", usageDecision: "adopted", scope: ["X001@1"] }]);
	await apply(store, [
		{ op: "create", type: "K", title: "限定经验", body: "使用限定证据", usageDecision: "adopted", scope: ["X001@1"], fields: { experience: experience("executor", [ref(storeId, "E001")]) } },
		{ op: "create", type: "K", title: "裸 ID 情境", body: "允许任一现行版本", usageDecision: "adopted", scope: ["X001"], fields: { experience: experience("executor", []) } },
	]);
	const provider = createExperienceProvider(store);
	const withContext = (recordId: string, contextRefs: KnowledgeRef[]) => query([ref(storeId, recordId)], {
		applicability: { stage: "M07", tags: ["execute", "numeric"], contextRefs },
	});
	const oldContext = ref(storeId, "X001", 1);
	const ready = await provider.select(withContext("K001", [oldContext]));
	assert.equal(ready.status, "ready");
	assert.match(ready.markdown, /限定证据/);
	assert.deepEqual(ready.selected[0].dependencyRefs, [ref(storeId, "E001"), oldContext]);
	assert.equal((await provider.select(withContext("K001", []))).status, "incomplete");
	await apply(store, [{ op: "revise", id: "X001", body: "后续情境", reason: "条件变化" }]);
	assert.equal((await provider.select(withContext("K001", [ref(storeId, "X001", 2)]))).status, "incomplete");
	const bareScope = await provider.select(withContext("K002", [ref(storeId, "X001", 2), ref(storeId, "X001", 999)]));
	assert.equal(bareScope.status, "ready", "bare X scope still accepts a live pinned version");
	assert.deepEqual(bareScope.selected[0].dependencyRefs, [ref(storeId, "X001", 2)], "dependency list contains only the actually checked context");
});



test("experience selection checks applies_in and carries historical counterevidence within the original bounds", async (t) => {
	const { store, storeId } = await fixture(t);
	await apply(store, [{ op: "create", type: "X", title: "固定算子情境", body: "仅当前 dtype 和 layout", usageDecision: "adopted" }]);
	await apply(store, [{ op: "create", type: "K", title: "有条件的方法", body: "先检查布局", usageDecision: "adopted",
		refs: [{ rel: "applies_in", target: "X001@1" }], fields: { experience: experience("executor", []) } }]);
	const selected = ref(storeId, "K001");
	const provider = createExperienceProvider(store);
	const withoutContext = await provider.select(query([selected], {
		applicability: { stage: "M07", tags: ["execute"], contextRefs: [] },
	}));
	assert.equal(withoutContext.status, "incomplete");
	assert.match(withoutContext.omitted.map((item) => item.reason).join(" "), /missing-context:X001@1/);
	const discovered = await discoverLocalM07Experiences(store, { tags: [], contextRefs: [ref(storeId, "X001")] });
	assert.deepEqual(discovered.candidates[0].scope, ["X001@1"], "discovery shows the applies_in condition it checked");

	await apply(store, [
		{ op: "create", type: "J", title: "候选反证", body: "该实现曾在边界 shape 失败", usageDecision: "candidate",
			refs: [{ rel: "refutes", target: "K001@1" }, { rel: "limits", target: "K001@1" }] },
		{ op: "create", type: "Q", title: "未决范围", body: "别的 layout 是否仍适用", usageDecision: "candidate",
			refs: [{ rel: "questions", target: "K001@1" }] },
	]);
	await apply(store, [
		{ op: "create", type: "E", title: "反证原始回执", body: "边界输入与对应失败回执", usageDecision: "candidate",
			refs: [{ rel: "premise_of", target: "J001@1", inputRole: "data" }] },
		{ op: "create", type: "D", title: "问题处置记录", body: "该问题仍待复核", usageDecision: "candidate",
			refs: [{ rel: "handles", target: "Q001@1" }] },
		{ op: "revise", id: "K001", body: "新版本缩小了适用范围", reason: "后续范围修订" },
	]);
	const request = query([selected], { maxRecords: 7 });
	const ready = await provider.select(request);
	assert.equal(ready.status, "ready");
	assert.deepEqual(ready.selected[0].dependencyRefs, [ref(storeId, "X001")]);
	assert.deepEqual(ready.selected[0].scientificRequiredRefs, [], "context dependencies do not become inherited scientific requirements");
	for (const text of ["候选反证", "未决范围", "反证原始回执", "问题处置记录", "新版本缩小了适用范围"])
		assert.match(ready.markdown, new RegExp(text));
	assert.match(ready.markdown, /使用决定：candidate/);
	assert.match(ready.markdown, /当前可用性：exploratory_only/);
	assert.match(ready.markdown, /版本身份：历史版本/);
	const bounded = await provider.select({ ...request, maxRecords: 6 });
	assert.equal(bounded.status, "incomplete", "counterevidence must not be silently dropped to fit the record budget");
	assert.equal(bounded.markdown, "");
	const short = await provider.select({ ...request, maxChars: ready.markdown.length - 1 });
	assert.equal(short.status, "incomplete", "counterevidence must not be silently dropped to fit the character budget");
	assert.equal(short.markdown, "");
});

test("local M07 discovery shows only bounded eligible pinned methods and leaves loading explicit", async t => {
	const { store, storeId } = await fixture(t);
	await apply(store, [
		{ op: "create", type: "X", title: "当前数值情境", body: "限定边界", usageDecision: "adopted" },
		{ op: "create", type: "E", title: "可复核证据", body: "方法成立的前提", usageDecision: "adopted" },
	]);
	await apply(store, [
		{ op: "create", type: "K", title: "限定方法", body: "仅在该情境中使用", usageDecision: "adopted", scope: ["X001@1"],
			fields: { experience: experience("executor", [ref(storeId, "E001")], ["numeric"]) } },
		{ op: "create", type: "K", title: "未经采纳的候选", body: "不可装载", usageDecision: "candidate",
			fields: { experience: experience("executor", []) } },
		{ op: "create", type: "K", title: "另一个任务条件", body: "需要别的标签", usageDecision: "adopted",
			fields: { experience: experience("executor", [], ["other"]) } },
		...Array.from({ length: 25 }, (_, i) => ({ op: "create" as const, type: "K" as const,
			title: `通用方法 ${i}`, body: "已采纳、未限定情境", usageDecision: "adopted" as const,
			fields: { experience: experience("executor", []) } })),
	]);
	const provider = createExperienceProvider(store);
	const contextRefs = [ref(storeId, "X001")];
	const found = await discoverLocalM07Experiences(store, { tags: ["numeric"], contextRefs });
	assert.equal(found.snapshotId, (await store.current())?.id);
	assert.equal(found.candidates.length, 24);
	assert.equal(found.omittedCount, 2, "only eligible matches beyond the display cap count as omitted");
	assert.equal(found.nextOffset, 24);
	const tail = await discoverLocalM07Experiences(store, { tags: ["numeric"], contextRefs, offset: found.nextOffset });
	assert.equal(tail.snapshotId, found.snapshotId);
	assert.equal(tail.candidates.length, 2);
	assert.equal(tail.omittedCount, 0);
	assert.equal(tail.nextOffset, undefined);
	assert(!tail.candidates.some(item => found.candidates.some(first => first.ref.recordId === item.ref.recordId)));
	assert(!tail.candidates.some(item => item.title === "未经采纳的候选" || item.title === "另一个任务条件"));
	assert.deepEqual(found.candidates[0].ref, ref(storeId, "K001"));
	assert.deepEqual(found.candidates[0].requiredRefs, [ref(storeId, "E001")]);
	const manyConditions = await discoverLocalM07Experiences(store, {
		tags: [...Array.from({ length: 100 }, (_, index) => `irrelevant-${index}`), "numeric"],
		contextRefs: [...Array.from({ length: 100 }, () => ref(storeId, "X999")), ref(storeId, "X001")],
	});
	assert.deepEqual(manyConditions.candidates[0].ref, ref(storeId, "K001"));
	assert(!found.candidates.some(item => item.title === "未经采纳的候选" || item.title === "另一个任务条件"));
	assert.equal((await provider.select(query([found.candidates[0].ref], { expectedSnapshotId: found.snapshotId }))).status, "ready");
	const wrongContext = await discoverLocalM07Experiences(store, { tags: ["numeric"], contextRefs: [] });
	assert(!wrongContext.candidates.some(item => item.ref.recordId === "K001"));
	assert.equal(wrongContext.omittedCount, 1);
	await apply(store, [{ op: "decide", id: "E001", usageDecision: "withdrawn", reason: "依赖已撤回" }]);
	const revoked = await discoverLocalM07Experiences(store, { tags: ["numeric"], contextRefs });
	assert(!revoked.candidates.some(item => item.ref.recordId === "K001"));
	assert.equal(revoked.omittedCount, 1);
	await assert.rejects(discoverLocalM07Experiences(store, { tags: ["numeric"], offset: -1 }), /invalid bounded experience/);
});
