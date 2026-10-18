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

test("lift_limit can select one exact authority without clearing other limits or historical decisions", async (t) => {
	const { store } = await fixture(t);
	await submitAndMerge(store, { stage: "M04", runId: "seed", ops: [{ op: "create", type: "C", title: "Claim", body: "Evidence", usageDecision: "adopted" }] });
	await submitAndMerge(store, { stage: "M04", runId: "overlap", ops: [
		{ op: "limit", target: "C001", kind: "needs_recheck", reason: "Derived impact", authority: "impact:Pold" },
		{ op: "limit", target: "C001", kind: "suspended", reason: "Independent review", authority: "M04-review" },
	] });
	const unknown = await store.submitProposal({ stage: "M04", runId: "unknown", ops: [{ op: "lift_limit", target: "C001", limitAuthority: "impact:missing", reason: "No such source", authority: "M04" }] });
	assert.equal(unknown.structurallyValid, false);
	assert(unknown.issues.some((item) => item.message.includes("没有匹配的生效限制")));
	await submitAndMerge(store, { stage: "M04", runId: "select", ops: [{ op: "lift_limit", target: "C001", limitAuthority: "impact:Pold", reason: "Rechecked impact", authority: "M04" }] });
	let active = (await store.limits()).filter((limit) => limit.target === "C001" && !limit.liftedAt);
	assert.deepEqual(active.map((limit) => limit.authority), ["M04-review"]);
	assert.equal((await store.availability("C001")).availability, "not_allowed");
	const sameBatch = await submitAndMerge(store, { stage: "M04", runId: "same-batch", ops: [
		{ op: "limit", target: "C001", kind: "needs_recheck", reason: "New derived impact", authority: "impact:Pnew" },
		{ op: "limit", target: "C001", kind: "suspended", reason: "Second independent review", authority: "other-review" },
		{ op: "lift_limit", target: "C001", limitAuthority: "impact:Pnew", reason: "Checked this source", authority: "M04" },
	] });
	assert(sameBatch.snapshot.activeLimits.includes("C001:suspended"));
	active = (await store.limits()).filter((limit) => limit.target === "C001" && !limit.liftedAt);
	assert.deepEqual(active.map((limit) => limit.authority), ["M04-review", "other-review"]);
	await submitAndMerge(store, { stage: "M04", runId: "decision-and-select", ops: [
		{ op: "decide", id: "C001", usageDecision: "withdrawn", reason: "Withdraw pending review" },
		{ op: "limit", target: "C001", kind: "needs_recheck", reason: "Unrelated impact", authority: "impact:Pnext" },
		{ op: "lift_limit", target: "C001", limitAuthority: "impact:Pnext", reason: "Checked only the impact", authority: "M04" },
		{ op: "decide", id: "C001", usageDecision: "adopted", reason: "New use decision does not waive withdrawal" },
	] });
	active = (await store.limits()).filter((limit) => limit.target === "C001" && !limit.liftedAt);
	assert(active.some((limit) => limit.authority.startsWith("decision:")));
	assert(!((await store.limits()).some((limit) => limit.authority === "historical-decision:C001" && !!limit.liftedAt)));
	assert.equal((await store.availability("C001")).availability, "not_allowed");
	await submitAndMerge(store, { stage: "M04", runId: "legacy-all", ops: [{ op: "lift_limit", target: "C001", reason: "All independent restrictions reviewed", authority: "M04" }] });
	assert.equal((await store.availability("C001")).availability, "usable_conditionally");
	assert((await store.limits()).some((limit) => limit.authority === "historical-decision:C001" && !!limit.liftedAt));
});

test("a same-batch deactivation and full lift records the historical-decision release", async (t) => {
	const { store } = await fixture(t);
	const unresolvedHistoricalSource = await store.submitProposal({ stage: "M04", runId: "unresolved-handle", ops: [
		{ op: "create", type: "C", title: "Unassigned", body: "No published ID", handle: "$c" },
		{ op: "decide", id: "$c", usageDecision: "withdrawn", reason: "Stop use" },
		{ op: "lift_limit", target: "$c", limitAuthority: "historical-decision:$c", reason: "Unresolvable authority", authority: "M04" },
	] });
	assert.equal(unresolvedHistoricalSource.structurallyValid, false);
	assert(unresolvedHistoricalSource.issues.some((item) => item.message.includes("正式 ID 分配后")));
	await submitAndMerge(store, { stage: "M04", runId: "seed", ops: [{ op: "create", type: "C", title: "Claim", body: "Evidence", usageDecision: "adopted" }] });
	const merged = await submitAndMerge(store, { stage: "M04", runId: "reconsider", ops: [
		{ op: "decide", id: "C001", usageDecision: "withdrawn", reason: "Temporarily stop use" },
		{ op: "lift_limit", target: "C001", reason: "Reviewed all restrictions", authority: "M04" },
		{ op: "decide", id: "C001", usageDecision: "adopted", reason: "Re-adopt after review" },
	] });
	assert(merged.limitsWrittenFirst.includes("C001:withdrawn"));
	assert((await store.limits()).some((limit) => limit.authority === `decision:${merged.proposalId}` && !!limit.liftedAt));
	assert((await store.limits()).some((limit) => limit.authority === "historical-decision:C001" && !!limit.liftedAt));
	assert.equal((await store.availability("C001")).availability, "usable_conditionally");
});




test("withdrawal disables pinned older versions and propagates through dependency chains", async (t) => {
	const { store } = await fixture(t);
	await submitAndMerge(store, { stage: "M04", runId: "seed", ops: [
		{ op: "create", type: "C", title: "上游认识", body: "有条件认识", usageDecision: "adopted", handle: "$claim" },
		{ op: "create", type: "C", title: "下游主张", body: "由论证支持", usageDecision: "adopted", handle: "$conclusion" },
		{ op: "create", type: "J", title: "依赖论证", body: "引用上游", usageDecision: "adopted", handle: "$argument", refs: [{ rel: "premise_of", target: "$claim" }, { rel: "supports", target: "$conclusion" }] },
		{ op: "create", type: "K", title: "下游方法", body: "依赖论证", usageDecision: "adopted", refs: [{ rel: "checks", target: "$argument" }] },
	] });
	const withdrawn = await submitAndMerge(store, { stage: "M04", runId: "withdraw", ops: [{ op: "decide", id: "C001", usageDecision: "withdrawn", reason: "新证据反驳" }] });
	assert(withdrawn.limitsWrittenFirst.includes("C001:withdrawn"));
	assert.equal((await store.availability("C001", 1)).availability, "not_allowed");
	assert.equal((await store.availability("J001", 1)).availability, "needs_recheck");
	assert.equal((await store.availability("C002", 1)).availability, "needs_recheck", "affected argument reaches its supported claim");
	assert.equal((await store.availability("K001", 1)).availability, "usable_conditionally", "a check relation does not invalidate the criterion itself");
	assert(withdrawn.warnings.some((warning) => warning.includes("K001@1 checks J001")));
	await submitAndMerge(store, { stage: "M04", runId: "adopt-without-lift", ops: [{ op: "decide", id: "C001", usageDecision: "adopted", reason: "另一个用途" }] });
	assert.equal((await store.availability("C001")).availability, "not_allowed", "a new adopted version does not silently lift an old withdrawal");
});

test("a changed X context reaches records that depend on it only through scope", async (t) => {
	const { store } = await fixture(t);
	await submitAndMerge(store, { stage: "M04", runId: "scope-seed", ops: [
		{ op: "create", type: "X", title: "Specific backend context", body: "Versioned conditions", usageDecision: "adopted" },
	] });
	await submitAndMerge(store, { stage: "M04", runId: "scope-dependents", ops: [
		{ op: "create", type: "J", handle: "$scoped", title: "Scoped conclusion", body: "Only in this context", scope: ["X001@1"], usageDecision: "adopted" },
		{ op: "create", type: "K", title: "Dependent check", body: "Uses the scoped conclusion", refs: [{ rel: "checks", target: "$scoped" }], usageDecision: "adopted" },
	] });
	const changed = await submitAndMerge(store, { stage: "M04", runId: "scope-withdraw", ops: [
		{ op: "decide", id: "X001", usageDecision: "withdrawn", reason: "Context conditions no longer hold" },
	] });
	assert(changed.impacts.some((item) => item.id === "J001" && item.via === "applies_in X001@1"));
	assert(!changed.impacts.some((item) => item.id === "K001"));
	assert.equal((await store.availability("J001", 1)).availability, "needs_recheck");
	assert.equal((await store.availability("K001", 1)).availability, "usable_conditionally");
	assert(changed.warnings.some((warning) => warning.includes("K001@1 checks J001")));
});

test("scope impacts respect pinned context versions and do not clear downstream limits implicitly", async (t) => {
	const { store } = await fixture(t);
	await submitAndMerge(store, { stage: "M04", runId: "context-v1", ops: [
		{ op: "create", type: "X", title: "Context", body: "First conditions", usageDecision: "adopted" },
	] });
	await submitAndMerge(store, { stage: "M04", runId: "context-v2", ops: [
		{ op: "revise", id: "X001", body: "Second conditions", reason: "A separately versioned context" },
	] });
	await submitAndMerge(store, { stage: "M04", runId: "versioned-scopes", ops: [
		{ op: "create", type: "J", title: "First context only", body: "Retained first-version evidence", scope: ["X001@1"], usageDecision: "adopted" },
		{ op: "create", type: "J", handle: "$second", title: "Second context only", body: "Second-version evidence", scope: ["X001@2"], usageDecision: "adopted" },
		{ op: "create", type: "J", title: "Unpinned context", body: "Must recheck when its context changes", scope: ["X001"], usageDecision: "adopted" },
		{ op: "create", type: "K", title: "Second-context method", body: "Depends on the second-context argument", refs: [{ rel: "checks", target: "$second" }], usageDecision: "adopted" },
	] });
	const limited = await submitAndMerge(store, { stage: "M04", runId: "limit-context-v2", ops: [
		{ op: "limit", target: "X001@2", kind: "suspended", reason: "Second conditions need verification", authority: "M04" },
	] });
	assert(!limited.impacts.some(item => item.id === "J001"), "a limit on X@2 does not affect a scope pinned to X@1");
	assert(limited.impacts.some(item => item.id === "J002" && item.via === "applies_in X001@2"));
	assert(limited.impacts.some(item => item.id === "J003" && item.via === "applies_in X001"));
	assert(!limited.impacts.some(item => item.id === "K001"));
	assert.equal((await store.availability("J001", 1)).availability, "usable_conditionally");
	await submitAndMerge(store, { stage: "M04", runId: "revalidate-context-v2", ops: [
		{ op: "lift_limit", target: "X001@2", reason: "The context itself was revalidated", authority: "M04" },
	] });
	assert.equal((await store.availability("X001", 2)).availability, "usable_conditionally");
	for (const id of ["J002", "J003"])
		assert.equal((await store.availability(id, 1)).availability, "needs_recheck", "lifting the context's limit does not certify its dependent arguments or method");
	assert.equal((await store.availability("K001", 1)).availability, "usable_conditionally");
});

test("same-merge bare references bind the published version while old pins and limits still propagate", async (t) => {
	const { store } = await fixture(t);
	await submitAndMerge(store, { stage: "M04", runId: "impact-seed", ops: [
		{ op: "create", type: "C", handle: "$base", title: "Baseline claim", body: "First version" },
		{ op: "create", type: "J", handle: "$old", title: "Earlier argument", body: "An existing bare premise", refs: [{ rel: "premise_of", target: "$base" }] },
		{ op: "create", type: "K", title: "Earlier check", body: "Checks the earlier argument", refs: [{ rel: "checks", target: "$old" }] },
	] });
	const revised = await submitAndMerge(store, { stage: "M04", runId: "impact-atomic-revise", ops: [
		{ op: "create", type: "J", handle: "$fresh", title: "Fresh argument", body: "Written with the new version", refs: [{ rel: "premise_of", target: "C001" }] },
		{ op: "create", type: "J", handle: "$pinned", title: "Old-version argument", body: "Explicitly pins the old version", refs: [{ rel: "premise_of", target: "C001@1" }] },
		{ op: "create", type: "K", title: "Fresh argument check", body: "Checks the new argument", refs: [{ rel: "checks", target: "$fresh" }] },
		{ op: "revise", id: "J001", body: "Revised argument for the published claim", reason: "Reassessed in this atomic proposal" },
		{ op: "revise", id: "C001", body: "Second version", reason: "Revised in this atomic proposal" },
	] });
	const revisedIds = new Set(revised.impacts.map(item => `${item.id}@${item.version}`));
	assert.deepEqual(revisedIds, new Set(["J001@1", "J003@1"]));
	assert.equal((await store.availability("J002", 1)).availability, "exploratory_only");
	assert.equal((await store.availability("J001", 2)).availability, "exploratory_only");
	assert.equal((await store.availability("J003", 1)).availability, "needs_recheck", "old explicit pins retain conservative review on upstream revision");
	assert.equal((await store.availability("K001", 1)).availability, "exploratory_only");
	assert(revised.warnings.some((warning) => warning.includes("K001@1 checks J001")));

	const pinnedLimit = await submitAndMerge(store, { stage: "M04", runId: "impact-current-limit", ops: [
		{ op: "create", type: "J", title: "Current-version argument", body: "New premise under limit", refs: [{ rel: "premise_of", target: "C001" }] },
		{ op: "limit", target: "C001@2", kind: "suspended", reason: "Current version requires recheck", authority: "M04" },
	] });
	assert(pinnedLimit.impacts.some(item => item.id === "J004" && item.via === "premise_of C001"));
	assert(!pinnedLimit.impacts.some(item => item.id === "J003"), "an old-version pin does not follow a version-specific limit on v2");
	assert.equal((await store.availability("J004", 1)).availability, "needs_recheck");

	const allVersions = await submitAndMerge(store, { stage: "M04", runId: "impact-all-versions", ops: [
		{ op: "create", type: "J", title: "Fresh argument under broad limit", body: "Still affected by an all-version limit", refs: [{ rel: "premise_of", target: "C001" }] },
		{ op: "limit", target: "C001", kind: "suspended", reason: "All versions now limited", authority: "M04" },
	] });
	assert(allVersions.impacts.some(item => item.id === "J005" && item.via === "premise_of C001"));
	assert(allVersions.impacts.some(item => item.id === "J003" && item.via === "premise_of C001@1"));
	assert.equal((await store.availability("J005", 1)).availability, "needs_recheck");
	const withdrawal = await submitAndMerge(store, { stage: "M04", runId: "impact-withdrawal", ops: [
		{ op: "create", type: "J", title: "Fresh argument during withdrawal", body: "A new bare premise is still affected", refs: [{ rel: "premise_of", target: "C001" }] },
		{ op: "decide", id: "C001", usageDecision: "withdrawn", reason: "The claim is withdrawn across versions" },
	] });
	assert(withdrawal.impacts.some(item => item.id === "J006" && item.via === "premise_of C001"));
	assert.equal((await store.availability("J006", 1)).availability, "needs_recheck");
});

test("premise ownership and explicit required refs propagate, while local assumptions do not", async (t) => {
	const { store } = await fixture(t);
	const storeId = await store.storeId();
	await submitAndMerge(store, { stage: "M04", runId: "premise-roles", ops: [
		{ op: "create", type: "E", handle: "$input", title: "Frozen measurement", body: "Observed bytes", usageDecision: "adopted" },
		{ op: "create", type: "C", handle: "$claim", title: "Supported claim", body: "Derived result", usageDecision: "adopted" },
		{ op: "create", type: "J", handle: "$forward", title: "Argument owns its input", body: "Uses measurement", usageDecision: "adopted",
			refs: [{ rel: "premise_of", target: "$input", inputRole: "data" }, { rel: "supports", target: "$claim" }] },
		{ op: "create", type: "J", handle: "$reverse", title: "Input owns the relation", body: "Other argument", usageDecision: "adopted" },
		{ op: "create", type: "E", title: "Second measurement", body: "Reverse stored input", usageDecision: "adopted",
			refs: [{ rel: "premise_of", target: "$reverse", inputRole: "data" }] },
		{ op: "create", type: "J", title: "Local assumption", body: "Hypothetical case", usageDecision: "adopted",
			refs: [{ rel: "premise_of", target: "$input", inputRole: "local_assumption" }] },
		{ op: "create", type: "J", title: "Temporary assumption", body: "Proof by contradiction", usageDecision: "adopted",
			refs: [{ rel: "premise_of", target: "$input", inputRole: "temporary_assumption" }] },
		{ op: "create", type: "K", title: "Explicitly required measurement", body: "Task rule", usageDecision: "adopted",
			fields: { experience: { version: 1, targetKind: "executor", applicableStages: ["M07"], requiredTags: [], excludedTags: [],
				requiredRefs: [{ storeId, recordId: "E001", version: 1 }] } } },
	] });
	const first = await submitAndMerge(store, { stage: "M04", runId: "limit-input-one", ops: [
		{ op: "limit", target: "E001@1", kind: "suspended", reason: "Measurement unavailable", authority: "M04" },
	] });
	for (const id of ["J001", "C001", "K001"]) assert(first.impacts.some((item) => item.id === id));
	for (const id of ["J003", "J004"]) assert(!first.impacts.some((item) => item.id === id));
	assert(first.warnings.some((warning) => warning.includes("J003@1 premise_of E001") && warning.includes("local_assumption")));
	assert(first.warnings.some((warning) => warning.includes("J004@1 premise_of E001") && warning.includes("temporary_assumption")));
	assert.equal((await store.availability("C001", 1)).availability, "needs_recheck", "affected J reaches the claim it supports");
	const second = await submitAndMerge(store, { stage: "M04", runId: "limit-input-two", ops: [
		{ op: "limit", target: "E002@1", kind: "suspended", reason: "Other measurement unavailable", authority: "M04" },
	] });
	assert(second.impacts.some((item) => item.id === "J002" && item.via === "premise_of E002@1"));
});

test("ordinary support and check associations warn without invalidating their source records", async (t) => {
	const { store } = await fixture(t);
	await submitAndMerge(store, { stage: "M04", runId: "relations", ops: [
		{ op: "create", type: "C", handle: "$claim", title: "Claim", body: "First version", usageDecision: "adopted" },
		{ op: "create", type: "E", title: "Raw observation", body: "Immutable reading", usageDecision: "adopted", refs: [{ rel: "supports", target: "$claim" }] },
		{ op: "create", type: "J", title: "Supporting argument", body: "Reasoning", usageDecision: "adopted", refs: [{ rel: "supports", target: "$claim" }] },
		{ op: "create", type: "K", title: "Check", body: "Criterion", usageDecision: "adopted", refs: [{ rel: "checks", target: "$claim" }] },
	] });
	const result = await submitAndMerge(store, { stage: "M04", runId: "claim-revised", ops: [
		{ op: "revise", id: "C001", body: "Narrower claim", reason: "New conditions" },
	] });
	assert(!result.impacts.some((item) => ["E001", "J001", "K001"].includes(item.id)));
	for (const relation of ["E001@1 supports C001", "J001@1 supports C001", "K001@1 checks C001"])
		assert(result.warnings.some((warning) => warning.includes(relation)));
	for (const id of ["E001", "J001", "K001"])
		assert.equal((await store.availability(id, 1)).availability, "usable_conditionally");
});

test("historical bare output links stay on the pre-merge versions when both ends are revised", async (t) => {
	const { store } = await fixture(t);
	await submitAndMerge(store, { stage: "M04", runId: "paired-seed", ops: [
		{ op: "create", type: "C", handle: "$claim", title: "Claim", body: "Old claim", usageDecision: "adopted" },
		{ op: "create", type: "J", handle: "$argument", title: "Argument", body: "Old argument", usageDecision: "adopted", refs: [{ rel: "supports", target: "$claim" }] },
		{ op: "create", type: "E", title: "Evidence", body: "Old input", usageDecision: "adopted", refs: [{ rel: "premise_of", target: "$argument", inputRole: "data" }] },
	] });
	const paired = await submitAndMerge(store, { stage: "M04", runId: "paired-revise", ops: [
		{ op: "revise", id: "E001", body: "New input", reason: "New frozen evidence" },
		{ op: "revise", id: "J001", body: "New argument", reason: "Reviewed the new input" },
		{ op: "revise", id: "C001", body: "New claim", reason: "Reviewed the argument" },
	] });
	assert(paired.impacts.some((item) => item.id === "J001" && item.version === 1 && item.via === "premise_of E001@1"));
	assert(paired.impacts.some((item) => item.id === "C001" && item.version === 1 && item.via === "supports J001@1"));
	assert(!paired.impacts.some((item) => item.id === "J001" && item.version === 2));
	assert(!paired.impacts.some((item) => item.id === "C001" && item.version === 2));
	const current = await submitAndMerge(store, { stage: "M04", runId: "current-forward", ops: [
		{ op: "create", type: "J", title: "New dependent argument", body: "Uses current evidence", usageDecision: "adopted",
			refs: [{ rel: "premise_of", target: "E001" }, { rel: "supports", target: "C001" }] },
		{ op: "limit", target: "E001@2", kind: "needs_recheck", reason: "Current evidence must be rechecked", authority: "M04" },
	] });
	assert(current.impacts.some((item) => item.id === "J002" && item.via === "premise_of E001"));
	assert(current.impacts.some((item) => item.id === "C001" && item.version === 2 && item.via === "supports J002@1"));
	assert(!current.impacts.some((item) => item.id === "C001" && item.version === 1 && item.via === "supports J002@1"));
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
