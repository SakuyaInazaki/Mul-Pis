import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { createExperienceProvider } from "../../src/knowledge/experience-index.ts";
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

test("stable store identity prevents cross-workspace C001 collisions and requires explicit registration", async (t) => {
	const one = await fixture(t), two = await fixture(t);
	assert.equal((await createFileKnowledgeStore(one.dir).storeId()), one.storeId);
	assert.notEqual(one.storeId, two.storeId);
	await apply(one.store, [{ op: "create", type: "C", title: "本库认识", body: "与外库相反", usageDecision: "adopted", fields: { experience: experience("executor", [], []) } }]);
	await apply(two.store, [{ op: "create", type: "C", title: "外库认识", body: "与本库相反", usageDecision: "adopted", fields: { experience: experience("executor", [], []) } }]);
	const external = ref(two.storeId, "C001");
	const unregistered = await createExperienceProvider(one.store).select(query([external]));
	assert.equal(unregistered.status, "incomplete");
	assert.match(unregistered.omitted[0].reason, /store-not-registered/);
	const registered = await createExperienceProvider(one.store, new Map([[two.storeId, two.store]])).select(query([external]));
	assert.equal(registered.status, "ready");
	assert.match(registered.markdown, /外库认识/);
	assert.doesNotMatch(registered.markdown, /本库认识/);
	assert.deepEqual(registered.selected[0].ref, external);
	const wrongRegistration = await createExperienceProvider(one.store, new Map([[two.storeId, one.store]])).select(query([external]));
	assert.equal(wrongRegistration.status, "incomplete");
	const overRequested = await createExperienceProvider(one.store, new Map([[two.storeId, two.store]])).select(query([ref(one.storeId, "C001"), external], { maxRecords: 1 }));
	assert.equal(overRequested.status, "incomplete");
	assert.equal(overRequested.markdown, "");
	await assert.rejects(createExperienceProvider(one.store).select(query([ref(one.storeId, "C001")], { applicability: { stage: "M07", tags: ["x".repeat(241)] } })), /bounds or context/);
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
	assert.equal((await provider.select(query([selected], { maxRecords: 3 }))).status, "incomplete");
	assert.equal((await provider.select(query([selected], { maxChars: 120 }))).markdown, "");
	assert.equal((await provider.select(query([selected], { applicability: { stage: "M07", tags: ["execute"], contextRefs: [ref(storeId, "X001")] } }))).status, "incomplete");
	await apply(store, [{ op: "decide", id: "E001", usageDecision: "withdrawn", reason: "反馈失效" }]);
	const revoked = await provider.select(query([selected]));
	assert.equal(revoked.status, "incomplete");
	assert.equal(revoked.markdown, "");
	assert.match(revoked.omitted.map((item) => item.reason).join(" "), /availability:not_allowed/);
	assert.equal((await store.get("E001", 1))?.body, "测量仅在给定环境成立", "withdrawn evidence remains readable for historical review");
});

test("cycles and unknown foreign dependencies fail closed within record bounds", async (t) => {
	const { store, storeId } = await fixture(t);
	await apply(store, [
		{ op: "create", type: "K", title: "甲", body: "A", usageDecision: "adopted", fields: { experience: experience("executor", [ref(storeId, "K002")]) } },
		{ op: "create", type: "K", title: "乙", body: "B", usageDecision: "adopted", fields: { experience: experience("executor", [ref(storeId, "K001")]) } },
	]);
	const cycle = await createExperienceProvider(store).select(query([ref(storeId, "K001")]));
	assert.equal(cycle.status, "incomplete");
	assert.match(cycle.omitted.map((item) => item.reason).join(" "), /dependency-cycle/);
	await apply(store, [{ op: "create", type: "K", title: "未知外库", body: "C", usageDecision: "adopted", fields: { experience: experience("executor", [ref("00000000-0000-4000-8000-000000000000", "E001")]) } }]);
	const missing = await createExperienceProvider(store).select(query([ref(storeId, "K003")]));
	assert.equal(missing.status, "incomplete");
	assert.match(missing.omitted.map((item) => item.reason).join(" "), /store-not-registered/);
});
