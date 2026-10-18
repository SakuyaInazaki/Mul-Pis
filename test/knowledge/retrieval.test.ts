import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createFileKnowledgeStore } from "../../src/knowledge/store.ts";
import { retrieveKnowledge, validateKnowledgeRetrievalContext } from "../../src/knowledge/retrieval.ts";
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

test("J-owned premises are mandatory while local assumptions remain visible with their role", async (t) => {
	const store = await fixture(t);
	await apply(store, [
		{ op: "create", type: "E", handle: "$necessary", title: "Necessary measurement", body: "Observed result", usageDecision: "adopted" },
		{ op: "create", type: "E", handle: "$hypothetical", title: "Hypothetical input", body: "Only inside a proof", usageDecision: "adopted" },
		{ op: "create", type: "J", title: "Argument with distinct inputs", body: "Argument", usageDecision: "adopted",
			refs: [{ rel: "premise_of", target: "$necessary", inputRole: "data" },
				{ rel: "premise_of", target: "$hypothetical", inputRole: "temporary_assumption" }] },
	]);
	const necessary = await retrieveKnowledge(store, { purpose: "M07", text: "", requiredIds: ["J001"], maxRecords: 2, maxChars: 5_000 });
	assert.equal(necessary.status, "ready");
	assert.deepEqual(new Set(necessary.pack.included.map((item) => item.id)), new Set(["E001", "J001"]));
	assert(necessary.omitted.some((item) => item.ref === "E002@1" && item.reason === "group-over-budget"));
	const visible = await retrieveKnowledge(store, { purpose: "M07", text: "", requiredIds: ["J001"], maxRecords: 3, maxChars: 5_000 });
	assert.deepEqual(new Set(visible.pack.included.map((item) => item.id)), new Set(["E001", "E002", "J001"]));
	assert.match(visible.pack.markdown, /premise_of → E002（输入作用：temporary_assumption）/);
});

test("explicit context filters incompatible roots and ranks the matching stage without excluding legacy records", async (t) => {
	const store = await fixture(t);
	await apply(store, [
		{ op: "create", type: "K", title: "repair", body: "legacy repair evidence" },
		{ op: "create", type: "K", title: "repair", body: "wrong backend", fields: { retrieval: { context: { backend: "cuda" } } } },
		{ op: "create", type: "K", title: "repair", body: "numerical repair", fields: { retrieval: { context: { stage: "numerical-repair", backend: "ascend-c", toolchain: "CANN-8.5", dtype: "fp16", layout: "ND" } } } },
		{ op: "create", type: "K", title: "repair", body: "compile repair", fields: { retrieval: { context: { stage: "compile-repair", backend: "ascend-c" } } } },
	]);
	const selection = await retrieveKnowledge(store, { purpose: "repair", text: "repair", maxRecords: 10, maxChars: 20_000,
		context: { stage: "numerical-repair", backend: "ascend-c", toolchain: "CANN-8.5", dtype: "fp16", layout: "ND" } });
	assert.deepEqual(selection.rankedRefs, ["K003@1", "K001@1"]);
	assert(selection.omitted.some(item => item.ref === "K002@1" && item.reason === "context-mismatch:backend"));
	assert(selection.omitted.some(item => item.ref === "K004@1" && item.reason === "context-mismatch:stage"));
	assert.match(selection.pack.markdown, /record-context/);
	assert.match(selection.pack.markdown, /负经验仅在原记录条件和证据范围内成立/);
});

test("structure and symptom overlap can retrieve a concrete pattern without guessing absent features", async (t) => {
	const store = await fixture(t);
	await apply(store, [
		{ op: "create", type: "K", title: "schedule", body: "we measured a dependency", fields: { retrieval: { context: {
			structure: ["staged-copy"], appliedTransforms: ["double-buffer"], symptoms: ["copy-wait", "tail-error"],
		} }, avoid_when: "only the recorded earlier structure failed", evidence: "E001@1" } },
	]);
	const selection = await retrieveKnowledge(store, { purpose: "symptom", text: "", maxRecords: 5, maxChars: 8_000,
		context: { structure: ["staged-copy"], appliedTransforms: [], symptoms: ["copy-wait"] } });
	assert.deepEqual(selection.rankedRefs, ["K001@1"]);
	assert.match(selection.pack.markdown, /appliedTransforms:double-buffer/);
	assert.match(selection.pack.markdown, /symptoms:tail-error/);
	assert.match(selection.pack.markdown, /only the recorded earlier structure failed/);
	assert.match(selection.pack.markdown, /E001@1/);
	assert(!selection.omitted.some(item => item.reason.startsWith("context-mismatch:")));
});

test("a generic stage boosts topical records without recalling unrelated stage records", async t => {
	const store = await fixture(t);
	await apply(store, [
		{ op: "create", type: "E", title: "CUDA prologue measurement", body: "prologue overhead", fields: { retrieval: { context: { stage: "performance" } } } },
		{ op: "create", type: "E", title: "Unrelated campaign ledger", body: "separate campaign", fields: { retrieval: { context: { stage: "performance" } } } },
	]);
	const topical = await retrieveKnowledge(store, { purpose: "candidate", text: "CUDA prologue", context: { stage: "performance" }, maxRecords: 10, maxChars: 10_000 });
	assert.deepEqual(topical.rankedRefs, ["E001@1"]);
	const browse = await retrieveKnowledge(store, { purpose: "stage browse", text: "", context: { stage: "performance" }, maxRecords: 10, maxChars: 10_000 });
	assert.deepEqual(new Set(browse.rankedRefs), new Set(["E001@1", "E002@1"]));
});

test("automatic broad conclusions do not pull unrelated support siblings ahead of topical records", async t => {
	const store = await fixture(t);
	await apply(store, [{ op: "create", type: "D", title: "CUDA prologue decision", body: "current decision" }]);
	await apply(store, [
		{ op: "create", type: "E", title: "Old campaign ledger", body: "unrelated accounting", refs: [{ rel: "supports", target: "D001" }] },
		{ op: "create", type: "K", title: "CUDA prologue technique", body: "measured technique" },
	]);
	const topical = await retrieveKnowledge(store, { purpose: "candidate", text: "CUDA prologue", maxRecords: 10, maxChars: 10_000 });
	assert.deepEqual(new Set(topical.rankedRefs), new Set(["D001@1", "K001@1"]));
	const explicit = await retrieveKnowledge(store, { purpose: "decision evidence", text: "", requiredIds: ["D001"], onlyRequired: true, maxRecords: 10, maxChars: 10_000 });
	assert.deepEqual(new Set(explicit.rankedRefs), new Set(["D001@1", "E001@1"]));
});

test("specific API error evidence ranks before a broad long note without hiding the latter", async (t) => {
	const store = await fixture(t);
	await apply(store, [
		{ op: "create", type: "K", title: "CUDA troubleshooting overview", body:
			`${"Generic scheduling and invalid argument guidance. ".repeat(600)} torch.cuda.synchronize was mentioned once.` },
		{ op: "create", type: "K", title: "torch.cuda.synchronize invalid argument", body:
			"The recorded call failed at this API boundary; inspect the original stack and context before changing code.",
			fields: { api: "torch.cuda.synchronize", errorSignature: "invalid argument" } },
	]);
	const selected = await retrieveKnowledge(store, { purpose: "compile diagnosis", text: "torch.cuda.synchronize invalid argument",
		maxRecords: 2, maxChars: 100_000, view: "brief" });
	assert.deepEqual(selected.rankedRefs, ["K002@1", "K001@1"]);
	assert.equal(selected.omitted.length, 0);
});

test("two-character diagnostic and API symbols remain searchable without recalling English connectives", async t => {
	const store = await fixture(t);
	await apply(store, [
		{ op: "create", type: "E", title: "TK <= TH timing branch", body: "Measured the tk and th fields in the original receipt." },
		{ op: "create", type: "K", title: "io.read failure", body: "The API call failed before dispatch." },
		{ op: "create", type: "E", title: "General background", body: "To be or not to be; in and of the result." },
	]);
	const request = { purpose: "diagnose", maxRecords: 5, maxChars: 10_000 };
	assert.deepEqual((await retrieveKnowledge(store, { ...request, text: "tk<=th" })).rankedRefs, ["E001@1"]);
	assert.deepEqual((await retrieveKnowledge(store, { ...request, text: "io" })).rankedRefs, ["K001@1"]);
	assert.deepEqual((await retrieveKnowledge(store, { ...request, text: "to of in" })).rankedRefs, []);
});

test("diagnostic fields and declared structure retrieve cross-operator knowledge", async t => {
	const store = await fixture(t);
	await apply(store, [
		{ op: "create", type: "K", title: "unrelated operator family", body: "A measured edit in another operator.",
			fields: { bottleneck: "copy wait pipeline stall", canonical_family: "merged tail loop",
				retrieval: { context: { structure: ["staged-copy"], symptoms: ["copy-wait"] } } } },
		{ op: "create", type: "K", title: "copy operation overview", body: "generic background without a measured mechanism" },
	]);
	const selected = await retrieveKnowledge(store, { purpose: "diagnose", text: "copy wait pipeline stall", view: "brief",
		maxRecords: 2, maxChars: 8_000, context: { structure: ["staged-copy"], symptoms: ["copy-wait"] } });
	assert.equal(selected.rankedRefs[0], "K001@1");
	assert.match(selected.pack.markdown, /merged tail loop/);
});

test("brief preserves later boundary evidence as an original excerpt", async t => {
	const store = await fixture(t);
	await apply(store, [{ op: "create", type: "K", title: "conditional method", body:
		"A measured improvement was recorded.\n\nAvoid when the tail is already merged: this trial regressed.\n\nVerification requires the original latency receipt.",
		fields: { reusable_when: "only after the copy stage is split", do_not_apply_when: "already merged tail", risk: "alignment failure" } }]);
	const selected = await retrieveKnowledge(store, { purpose: "inspect", text: "conditional method", view: "brief", maxRecords: 1, maxChars: 8_000 });
	assert.match(selected.pack.markdown, /原文边界\/反例片段：Avoid when the tail is already merged/);
	assert.match(selected.pack.markdown, /可复用条件（原字段）：only after the copy stage is split/);
	assert.match(selected.pack.markdown, /不适用条件（原字段）：already merged tail/);
	assert.match(selected.pack.markdown, /正文尚有未展开内容/);
});

test("brief exposes a closed question without treating closure as proof of its historical wording", async t => {
	const store = await fixture(t);
	await apply(store, [{ op: "create", type: "Q", title: "Does this timing rule always hold?", body: "The original question remains as historical text." }]);
	await apply(store, [{ op: "close_q", id: "Q001", closeReason: "answered", reason: "Only the recorded setting was answered" }]);
	const selected = await retrieveKnowledge(store, { purpose: "inspect question", text: "timing rule", view: "brief", maxRecords: 2, maxChars: 8_000 });
	assert.match(selected.pack.markdown, /Q001@2.*Does this timing rule always hold/);
	assert.match(selected.pack.markdown, /问题状态：已关闭（原因 answered）/);
	assert.match(selected.pack.markdown, /关闭不等于正文命题已获证实/);
});

test("explicit roots retain incompatible premises, scoped warnings and live limits with contextual caveats", async (t) => {
	const store = await fixture(t);
	await apply(store, [{ op: "create", type: "X", title: "Original platform", body: "platform evidence",
		fields: { retrieval: { context: { backend: "cuda" } } } }]);
	await apply(store, [{ op: "create", type: "K", title: "copy strategy", body: "candidate strategy", scope: ["X001"], usageDecision: "adopted" }]);
	await apply(store, [{ op: "create", type: "J", title: "negative experiment", body: "Failure only with the original unaligned input; no global prohibition.",
		fields: { retrieval: { context: { dtype: "fp32" } }, evidence: "original-receipt.json" },
		refs: [{ rel: "limits", target: "K001" }] },
		{ op: "limit", target: "K001", kind: "needs_recheck", reason: "revalidate after layout change", authority: "J001" }]);
	const request = { purpose: "new platform", text: "copy strategy", maxRecords: 10, maxChars: 20_000,
		context: { backend: "ascend-c", dtype: "fp16" } };
	const automatic = await retrieveKnowledge(store, request);
	assert(!automatic.pack.included.some(item => item.id === "K001"));
	assert(automatic.omitted.some(item => item.ref === "K001@1" && item.reason.includes("X001@1:backend")));
	const explicit = await retrieveKnowledge(store, { ...request, requiredIds: ["K001"] });
	const refsOnly = await retrieveKnowledge(store, { ...request, requiredIds: ["K001"], view: "refs" });
	assert.equal(explicit.status, "ready");
	assert.deepEqual(refsOnly.rankedRefs, explicit.rankedRefs);
	assert.deepEqual(refsOnly.pack.included, explicit.pack.included);
	assert.deepEqual(refsOnly.limits, explicit.limits);
	assert.deepEqual(refsOnly.omitted, explicit.omitted);
	assert.doesNotMatch(refsOnly.pack.markdown, /candidate strategy|original-receipt\.json|no global prohibition/);
	assert.deepEqual(new Set(explicit.rankedRefs), new Set(["X001@1", "K001@1", "J001@1"]));
	assert.equal(explicit.pack.included.find(item => item.id === "K001")?.availability, "needs_recheck");
	assert.match(explicit.pack.markdown, /明确情境不匹配：backend/);
	assert.match(explicit.pack.markdown, /明确情境不匹配：dtype/);
	assert.match(explicit.pack.markdown, /original-receipt.json/);
	assert.match(explicit.pack.markdown, /no global prohibition/);
	assert.equal(explicit.limits.length, 1);
	assert(!explicit.omitted.some(item => explicit.rankedRefs.includes(item.ref)));
});

test("an incompatible warning is still read with a matching root and does not suppress that root", async (t) => {
	const store = await fixture(t);
	await apply(store, [{ op: "create", type: "K", title: "vector repair", body: "matching implementation", fields: { retrieval: { context: { dtype: "fp16" } } } }]);
	await apply(store, [{ op: "create", type: "J", title: "vector failure", body: "observed only in fp32", fields: { retrieval: { context: { dtype: "fp32" } } }, refs: [{ rel: "refutes", target: "K001" }] }]);
	const selection = await retrieveKnowledge(store, { purpose: "repair", text: "vector", maxRecords: 5, maxChars: 10_000, context: { dtype: "fp16" } });
	assert.deepEqual(new Set(selection.rankedRefs), new Set(["K001@1", "J001@1"]));
	assert.match(selection.pack.markdown, /observed only in fp32/);
	assert.match(selection.pack.markdown, /明确情境不匹配：dtype/);
	assert(!selection.omitted.some(item => item.ref === "J001@1"));
});

test("unknown and malformed record context cannot become an inferred hard exclusion", async (t) => {
	const store = await fixture(t);
	await apply(store, [
		{ op: "create", type: "K", title: "repair", body: "known backend but caller has no backend", fields: { retrieval: { context: { backend: "cuda" } } } },
		{ op: "create", type: "K", title: "repair", body: "legacy schema", fields: { retrieval: { context: { backend: ["cuda", "ascend-c"] } } } },
		{ op: "create", type: "K", title: "repair", body: "uses CUDA in prose; prose is not a condition" },
	]);
	const selection = await retrieveKnowledge(store, { purpose: "repair", text: "repair", maxRecords: 10, maxChars: 10_000, context: { symptoms: ["compile-error"] } });
	assert.equal(selection.rankedRefs.length, 3);
	assert.match(selection.pack.markdown, /尚未核实的情境：backend/);
	assert.match(selection.pack.markdown, /条目检索情境格式未知/);
	assert(!selection.omitted.length);
	const otherBackend = await retrieveKnowledge(store, { purpose: "repair", text: "repair", maxRecords: 10, maxChars: 10_000, context: { backend: "ascend-c" } });
	assert(!otherBackend.rankedRefs.includes("K001@1"));
	assert(otherBackend.rankedRefs.includes("K002@1"));
	assert(otherBackend.rankedRefs.includes("K003@1"));
});

test("context does not bypass atomic group size limits", async (t) => {
	const store = await fixture(t);
	await apply(store, [{ op: "create", type: "X", title: "context", body: "condition", fields: { retrieval: { context: { backend: "cuda" } } } }]);
	await apply(store, [{ op: "create", type: "K", title: "repair", body: "strategy", scope: ["X001"] }]);
	const result = await retrieveKnowledge(store, { purpose: "repair", text: "", requiredIds: ["K001"], maxRecords: 1, maxChars: 8_000, context: { backend: "ascend-c" } });
	assert.equal(result.status, "incomplete");
	assert.equal(result.pack.included.length, 0);
	assert(result.omitted.some(item => item.reason === "required-group-over-budget"));
});

test("request context is explicit and defensively copied", () => {
	assert.equal(validateKnowledgeRetrievalContext(undefined), undefined);
	const source = { backend: "cuda", appliedTransforms: ["staged-copy"] };
	const copy = validateKnowledgeRetrievalContext(source)!;
	source.appliedTransforms.push("new-mutation");
	assert.deepEqual(copy.appliedTransforms, ["staged-copy"]);
	for (const value of [null, [], { backend: "" }, { stage: "compile\nrepair" }, { symptoms: "compile-error" }, { inferredBackend: "cuda" }])
		assert.throws(() => validateKnowledgeRetrievalContext(value), /invalid explicit retrieval context/);
});
