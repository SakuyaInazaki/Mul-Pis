import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createExperienceProvider } from "../../src/knowledge/experience-index.ts";
import { createFileKnowledgeStore } from "../../src/knowledge/store.ts";
import type { ProposalBatch } from "../../src/knowledge/types.ts";

test("experience fields reject malformed pinned refs before merge while freeform K remains valid", async t => {
	const dir = await mkdtemp(path.join(tmpdir(), "experience-validation-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const store = createFileKnowledgeStore(dir);
	await store.init();
	const storeId = await store.storeId();
	const draft = async (ops: ProposalBatch["ops"]) => store.submitProposal({ stage: "M04", runId: "synthetic", ops });
	const typed = (requiredRefs: unknown) => ({ version: 1, targetKind: "executor",
		applicableStages: ["M07"], requiredTags: [], excludedTags: [], requiredRefs });

	const legacy = await draft([{ op: "create", type: "K", title: "旧式自由字段", body: "仍可入库",
		fields: { object: "measurement", method: "compare" } }]);
	assert.equal(legacy.structurallyValid, true);
	await store.merge(legacy.proposalId);
	const before = (await store.current())!.id;

	const stringRef = await draft([{ op: "create", type: "K", title: "坏依赖", body: "只测试结构",
		fields: { experience: typed(["K001@1"]) } }]);
	assert.equal(stringRef.structurallyValid, false);
	assert(stringRef.issues.some(issue => issue.opIndex === 0 &&
		issue.message.includes("fields.experience.requiredRefs[0]") &&
		issue.message.includes("{storeId,recordId,version}")));
	await assert.rejects(store.merge(stringRef.proposalId), /merge.invalid|当前状态校验失败/);
	assert.equal((await store.current())!.id, before);

	const badDefinition = await draft([{ op: "create", type: "K", title: "缺失字段", body: "只测试结构",
		fields: { experience: { version: 1, targetKind: "executor", applicableStages: ["M07"],
			requiredTags: [], excludedTags: [], requiredRefs: "K001@1" } } }]);
	assert.equal(badDefinition.structurallyValid, false);
	assert(badDefinition.issues.some(issue => issue.message.includes("fields.experience.requiredRefs")));
	const badTypes = await draft([{ op: "create", type: "K", title: "错误类型", body: "只测试结构",
		fields: { experience: { version: 2, targetKind: "other", applicableStages: "M07",
			requiredTags: [], excludedTags: [], requiredRefs: [] } } }]);
	assert.equal(badTypes.structurallyValid, false);
	assert(badTypes.issues.some(issue => issue.message.includes("fields.experience.version")));
	assert(badTypes.issues.some(issue => issue.message.includes("fields.experience.targetKind")));
	assert(badTypes.issues.some(issue => issue.message.includes("fields.experience.applicableStages")));

	const badRevision = await draft([{ op: "revise", id: "K001", reason: "synthetic correction",
		fields: { experience: typed([{ storeId, recordId: "K001", version: "1" }]) } }]);
	assert.equal(badRevision.structurallyValid, false);
	assert(badRevision.issues.some(issue => issue.message.includes("fields.experience.requiredRefs[0].version")));
	await assert.rejects(store.merge(badRevision.proposalId), /merge.invalid|当前状态校验失败/);
	assert.equal((await store.get("K001"))!.version, 1);

	const valid = await draft([{ op: "create", type: "K", title: "合法经验", body: "只测试结构",
		fields: { experience: typed([{ storeId, recordId: "K001", version: 1 }]) } }]);
	assert.equal(valid.structurallyValid, true, valid.issues.map(issue => issue.message).join("; "));
	await store.merge(valid.proposalId);
	assert.equal((await store.get("K002"))!.title, "合法经验");
	const empty = await draft([{ op: "revise", id: "K002", reason: "no dependency",
		fields: { experience: typed([]) } }]);
	assert.equal(empty.structurallyValid, true, empty.issues.map(issue => issue.message).join("; "));
});

test("experience definitions with more than 64 valid stages and tags can merge and be selected", async t => {
	const dir = await mkdtemp(path.join(tmpdir(), "experience-many-tags-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const store = createFileKnowledgeStore(dir);
	await store.init();
	const storeId = await store.storeId();
	const stages = ["M07", ...Array.from({ length: 70 }, (_, index) => `stage-${index}`)];
	const tags = Array.from({ length: 70 }, (_, index) => `tag-${index}`);
	const receipt = await store.submitProposal({ stage: "M04", runId: "synthetic", ops: [{
		op: "create", type: "K", title: "Broad historical method", body: "Synthetic method",
		usageDecision: "adopted", fields: { experience: { version: 1, targetKind: "executor",
			applicableStages: stages, requiredTags: tags, excludedTags: [], requiredRefs: [] } },
	}] });
	assert.equal(receipt.structurallyValid, true, receipt.issues.map(issue => issue.message).join("; "));
	await store.merge(receipt.proposalId);
	const selection = await createExperienceProvider(store).select({ targetKind: "executor",
		applicability: { stage: "M07", tags },
		requestedRefs: [{ storeId, recordId: "K001", version: 1 }],
		maxRecords: 2, maxChars: 10_000 });
	assert.equal(selection.status, "ready");
	assert.equal(selection.selected.length, 1);
});
