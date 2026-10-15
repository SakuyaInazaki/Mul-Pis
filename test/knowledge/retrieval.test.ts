import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createFileKnowledgeStore } from "../../src/knowledge/store.ts";
import { retrieveKnowledge } from "../../src/knowledge/retrieval.ts";
import type { KnowledgeStore, ProposalOp } from "../../src/knowledge/types.ts";

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
