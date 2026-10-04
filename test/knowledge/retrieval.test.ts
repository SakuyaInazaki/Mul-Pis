import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createFileKnowledgeStore } from "../../src/knowledge/store.ts";
import { retrieveKnowledge } from "../../src/knowledge/retrieval.ts";
import type { KnowledgeRecord, KnowledgeStore, ProposalOp } from "../../src/knowledge/types.ts";

async function fixture(t: { after: (callback: () => Promise<void>) => void }): Promise<KnowledgeStore> {
	const dir = await mkdtemp(path.join(tmpdir(), "knowledge-retrieval-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const store = createFileKnowledgeStore(dir);
	await store.init();
	return store;
}

async function apply(store: KnowledgeStore, ops: ProposalOp[]): Promise<void> {
	const receipt = await store.submitProposal({ stage: "test", runId: "retrieval", ops });
	assert.equal(receipt.structurallyValid, true, receipt.issues.map((issue) => issue.message).join("; "));
	await store.merge(receipt.proposalId);
}

test("retrieval selects relevant evidence and warnings before unrelated positives, without all open Q", async (t) => {
	const store = await fixture(t);
	await apply(store, [{ op: "create", type: "C", title: "tensor optimization", body: "Primary claim", usageDecision: "adopted" }]);
	await apply(store, [
		{ op: "create", type: "Q", title: "Unrelated question", body: "about another subject" },
		{ op: "create", type: "Q", title: "Critical caveat", body: "A caution", refs: [{ rel: "questions", target: "C001" }] },
		{ op: "create", type: "C", title: "tensor secondary", body: "A".repeat(500), usageDecision: "adopted" },
	]);
	await apply(store, [{ op: "create", type: "D", title: "Caveat disposition", body: "Pending resolution", refs: [{ rel: "handles", target: "Q002" }] }]);
	const selection = await retrieveKnowledge(store, { purpose: "M04", text: "tensor optimization", maxRecords: 3, maxChars: 5_000 });
	assert.equal(selection.status, "ready");
	assert.deepEqual(selection.pack.included.map((item) => item.id), ["C001", "Q002", "D001"]);
	assert(!selection.pack.markdown.includes("Unrelated question"));
	assert(selection.pack.markdown.length <= 5_000);
	const required = await retrieveKnowledge(store, { purpose: "M07", text: "", requiredIds: ["C001"], maxRecords: 2, maxChars: 5_000 });
	assert.equal(required.status, "incomplete", "a required claim cannot hide its directly linked Q/D warnings under a tight budget");
	assert(required.omitted.some((item) => item.ref === "C001@1" && item.reason === "required-group-over-budget"));
});

test("required records keep scoped context and scientific premises as an atomic group", async (t) => {
	const store = await fixture(t);
	await apply(store, [{ op: "create", type: "X", title: "GPU context", body: "specific platform" }]);
	await apply(store, [{ op: "create", type: "J", title: "Argument", body: "reasoning", scope: ["X001"], usageDecision: "adopted" }]);
	await apply(store, [
		{ op: "create", type: "E", title: "Measured evidence", body: "numbers", refs: [{ rel: "premise_of", target: "J001" }], usageDecision: "adopted" },
	]);
	const bounded = await retrieveKnowledge(store, { purpose: "M07", text: "", requiredIds: ["J001"], maxRecords: 2, maxChars: 5_000 });
	assert.equal(bounded.status, "incomplete");
	assert.equal(bounded.pack.included.length, 0);
	assert(bounded.omitted.some((item) => item.reason === "required-group-over-budget"));
	const complete = await retrieveKnowledge(store, { purpose: "M07", text: "", requiredIds: ["J001"], maxRecords: 3, maxChars: 5_000 });
	assert.equal(complete.status, "ready");
	assert.deepEqual(new Set(complete.pack.included.map((item) => item.id)), new Set(["X001", "E001", "J001"]));
});

test("an optional positive is skipped when its warning cannot fit, and support cannot appear without its refutation", async (t) => {
	const store = await fixture(t);
	await apply(store, [{ op: "create", type: "C", title: "tensor claim", body: "a positive proposal", usageDecision: "adopted" }]);
	await apply(store, [
		{ op: "create", type: "Q", title: "Claim caveat", body: "a material uncertainty", refs: [{ rel: "questions", target: "C001" }] },
		{ op: "create", type: "C", title: "tensor alternative", body: "another idea", usageDecision: "candidate" },
		{ op: "create", type: "J", title: "Supporting argument", body: "reasoning", refs: [{ rel: "supports", target: "C001" }], usageDecision: "adopted" },
	]);
	await apply(store, [{ op: "create", type: "J", title: "Refutation", body: "counterargument", refs: [{ rel: "refutes", target: "J001" }] }]);
	const tooTight = await retrieveKnowledge(store, { purpose: "M04", text: "tensor claim", maxRecords: 1, maxChars: 5_000 });
	assert(!tooTight.pack.included.some((item) => item.id === "C001"));
	assert(tooTight.omitted.some((item) => item.ref === "C001@1" && item.reason === "group-over-budget"));
	const supportTight = await retrieveKnowledge(store, { purpose: "M04", text: "tensor claim", maxRecords: 3, maxChars: 5_000 });
	assert(!supportTight.pack.included.some((item) => item.id === "J001"), "the support must be omitted if its refutation cannot fit");
	assert(supportTight.omitted.some((item) => item.ref === "J001@1" && item.reason === "group-over-budget"));
	const enough = await retrieveKnowledge(store, { purpose: "M04", text: "tensor claim", maxRecords: 4, maxChars: 5_000 });
	assert.deepEqual(enough.pack.included.map((item) => item.id), ["C001", "Q001", "J001", "J002"]);
});

test("pinned historical arguments retain premises and warnings whose latest versions removed the links", async (t) => {
	const store = await fixture(t);
	await apply(store, [{ op: "create", type: "J", title: "Historical argument", body: "original reasoning" }]);
	await apply(store, [
		{ op: "create", type: "E", title: "Original evidence", body: "evidence", refs: [{ rel: "premise_of", target: "J001@1" }] },
		{ op: "create", type: "J", title: "Original counterargument", body: "warning", refs: [{ rel: "refutes", target: "J001@1" }] },
	]);
	await apply(store, [
		{ op: "revise", id: "E001", refs: [], reason: "later version no longer supplies that premise" },
		{ op: "revise", id: "J002", refs: [], reason: "later version no longer carries the old warning" },
	]);
	const selection = await retrieveKnowledge(store, { purpose: "historical review", text: "", requiredIds: ["J001@1"], maxRecords: 10, maxChars: 10_000 });
	assert.equal(selection.status, "ready");
	assert(selection.rankedRefs.includes("E001@1"), "the original premise must remain in the closure");
	assert(selection.rankedRefs.includes("J002@1"), "the original refutation must remain visible");
});

test("historical scan limit fails the selection even when no IDs were required", async (t) => {
	const store = await fixture(t);
	const oversized: KnowledgeRecord = {
		id: "C001", type: "C", version: 2_001, title: "tensor", body: "claim", fields: {}, refs: [], scope: [],
		createdAt: "2026-10-04T00:00:00Z", source: { stage: "test", runId: "seed" },
	};
	store.list = async () => [oversized];
	const result = await retrieveKnowledge(store, { purpose: "M04", text: "tensor", maxRecords: 4, maxChars: 5_000 });
	assert.equal(result.status, "incomplete");
	assert(result.omitted.some((item) => item.reason === "historical-premise-scan-over-budget"));
	assert.equal(result.pack.included.length, 0);
});

test("pinned historical claims can retrieve an older supporting argument", async (t) => {
	const store = await fixture(t);
	await apply(store, [{ op: "create", type: "C", title: "Old claim", body: "claim" }]);
	await apply(store, [{ op: "create", type: "J", title: "Old support", body: "support", refs: [{ rel: "supports", target: "C001@1" }] }]);
	await apply(store, [{ op: "revise", id: "J001", refs: [], reason: "revised support" }]);
	const selection = await retrieveKnowledge(store, { purpose: "historical review", text: "", requiredIds: ["C001@1"], maxRecords: 10, maxChars: 10_000 });
	assert.equal(selection.status, "ready");
	assert(selection.rankedRefs.includes("J001@1"));
});

test("withdrawn limits remain visible and experience cannot enter M07 generic packs", async (t) => {
	const store = await fixture(t);
	await apply(store, [
		{ op: "create", type: "C", title: "tensor deprecated", body: "retired", usageDecision: "adopted" },
		{ op: "create", type: "C", title: "tensor lesson", body: "method", usageDecision: "adopted", fields: { experience: { version: 1 } } },
	]);
	await apply(store, [{ op: "limit", target: "C001", kind: "withdrawn", reason: "counterexample", authority: "test" }]);
	const selection = await retrieveKnowledge(store, { purpose: "M04", text: "tensor", maxRecords: 4, maxChars: 5_000 });
	assert(selection.pack.markdown.includes("not_allowed"));
	assert(selection.pack.markdown.includes("withdrawn:C001"));
	const executor = await retrieveKnowledge(store, { purpose: "M07", text: "tensor lesson", excludeExperience: true, maxRecords: 4, maxChars: 5_000 });
	assert(!executor.pack.included.some((item) => item.id === "C002"));
	const explicit = await retrieveKnowledge(store, { purpose: "M07", text: "", excludeExperience: true, requiredIds: ["C002"], maxRecords: 4, maxChars: 5_000 });
	assert.equal(explicit.status, "incomplete");
});
