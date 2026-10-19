import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { DEFAULT_ADMISSION_POLICY, collectExistingCards, evaluateCardAdmission, readAdmissionReceipts,
	summarizeAdmissionRate, type ExistingCard } from "../../src/knowledge/admission.ts";
import { optimizationDirectionSignature, renderOptimizationCard, validateOptimizationCard,
	type OptimizationCard, type OptimizationCaseCard } from "../../src/knowledge/optimization-card.ts";
import { createFileKnowledgeStore } from "../../src/knowledge/store.ts";
import type { KnowledgeStore } from "../../src/knowledge/types.ts";

const measurement = (speedup: number, extra: Record<string, unknown> = {}) => ({
	baselineMs: 10, candidateMs: 10 / speedup, speedup, repeats: 5, correctness: "verified",
	verifier: "candidate-performance", evidence: ["stages/M07/run/tasks/T001/timing.json"], ...extra,
});

const caseCard = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
	version: 1, kind: "case", operatorCategory: "normalization", canonicalFamily: "layernorm",
	bottleneck: "memory_bound", applicability: { backend: "backend-a", toolchain: "toolchain-1.2", dtype: "float16", structure: ["2d-rowwise"] },
	provenance: { kind: "harness-run", detail: "M07/20261018T000000Z-a1/T001" },
	method: "memory_coalescing",
	diff: { summary: "把两次标量搬运合并成一次连续搬运", before: "copy(a); copy(b);", after: "copy_contiguous(a,b);" },
	rootMechanism: "两次非连续搬运各自触发一次 MTE2 事务",
	causalChain: "合并搬运 → aiv_mte2_ratio 0.81→0.52 → 延迟下降",
	profileEvidence: [{ metric: "aiv_mte2_ratio", value: 0.81 }],
	reusableWhen: "同一 dtype 且尾块可整除时",
	avoidWhen: "尾块需要掩码时不可直接套用，会越界",
	constraints: [{ name: "buffer_bytes", unit: "bytes", limit: 196352, comparison: "at_most", source: "S003" }],
	measurement: measurement(1.4), ...extra,
});

const existing = (card: OptimizationCard, ref = "C010@1", credit = 0): ExistingCard =>
	({ ref, id: ref.split("@")[0], version: Number(ref.split("@")[1]), card: { ...card, credit: { injections: credit, adoptions: credit, benefitSamples: credit } }, protected: false });

function valid(raw: Record<string, unknown>): OptimizationCard {
	const result = validateOptimizationCard(raw);
	assert.equal(result.issues.length, 0, result.issues.join("; "));
	return result.card!;
}

test("a case card must carry a diff, hard constraints, an avoid condition and a consistent measurement", () => {
	valid(caseCard());
	const noAvoid = { ...caseCard() };
	delete noAvoid.avoidWhen;
	assert.match(validateOptimizationCard(noAvoid).issues.join(";"), /avoidWhen/);
	assert.match(validateOptimizationCard(caseCard({ constraints: [] })).issues.join(";"), /硬约束成对/);
	assert.match(validateOptimizationCard(caseCard({ diff: { summary: "只有说明" } })).issues.join(";"), /diff/);
	assert.match(validateOptimizationCard(caseCard({ measurement: measurement(1.4, { speedup: 9 }) })).issues.join(";"), /speedup/);
	// A misspelled field never passes silently as unknown metadata.
	assert.match(validateOptimizationCard(caseCard({ avoid_when: "x" })).issues.join(";"), /不接受的字段/);
	// Hardware numbers need a local citation, not a URL or an absolute path.
	assert.match(validateOptimizationCard(caseCard({ constraints: [{ name: "buffer_bytes", unit: "bytes", limit: 1, comparison: "at_most", source: "https://example.invalid/doc" }] })).issues.join(";"), /本地出处/);
	assert.match(validateOptimizationCard({ ...caseCard(), applicability: { dtype: "float16" } }).issues.join(";"), /backend/);
});

test("avoid, rule, contract and when cards each need their own anchor", () => {
	const base = { version: 1, operatorCategory: "normalization", canonicalFamily: "layernorm", bottleneck: "memory_bound",
		applicability: { backend: "backend-a", toolchain: "toolchain-1.2" }, provenance: { kind: "harness-run", detail: "M07/run" } };
	valid({ ...base, kind: "avoid", excludedDirection: "fusion", profileReason: "融合后 缓冲超限，MTE2 反而上升",
		stopCondition: "若 缓冲预算提高一倍后可重试", attempts: 4, successes: 0 });
	assert.match(validateOptimizationCard({ ...base, kind: "avoid", excludedDirection: "fusion",
		profileReason: "直觉", stopCondition: "无", attempts: 1, successes: 0 }).issues.join(";"), /实测退化|3 次/);
	valid({ ...base, kind: "rule", errorSignature: "no member named 'Scale'", ruleText: "You cannot call BackendA::Scale; it does not exist in this toolchain version",
		frequency: 4, evidence: ["stages/M07/run/compile.log"] });
	valid({ ...base, kind: "contract", api: "BackendA::Add", signature: "void Add(Tensor&, const Tensor&, const Tensor&, int32_t)",
		constraints: [], source: "S007" });
	assert.match(validateOptimizationCard({ ...base, kind: "contract", constraints: [], source: "S007" }).issues.join(";"), /api\+signature|硬约束/);
	valid({ ...base, kind: "when", allowedMethods: ["tiling", "double_buffer"],
		maskWhen: [{ metric: "aiv_mte2_ratio", atLeast: 0.75, masks: ["memory_coalescing"] }], evidence: ["S007"] });
	assert.match(validateOptimizationCard({ ...base, kind: "when", allowedMethods: ["teleport"], maskWhen: [], evidence: ["S007"] }).issues.join(";"), /动作空间/);
});

test("admission applies asymmetric thresholds and refuses the noise band", () => {
	const admit = evaluateCardAdmission({ card: valid(caseCard()), existing: [] });
	assert.equal(admit.verdict, "admit");
	const noise = evaluateCardAdmission({ card: valid(caseCard({ measurement: measurement(1.02) })), existing: [] });
	assert.equal(noise.verdict, "reject");
	assert.match(noise.reasons.join(";"), /噪声带/);
	const regression = evaluateCardAdmission({ card: valid(caseCard({ measurement: measurement(0.5) })), existing: [] });
	assert.match(regression.reasons.join(";"), /负例/);
	const exemplar = evaluateCardAdmission({ card: valid(caseCard({ exemplar: true })), existing: [] });
	assert.match(exemplar.reasons.join(";"), new RegExp(String(DEFAULT_ADMISSION_POLICY.exemplarSpeedup)));
	const single = evaluateCardAdmission({ card: valid(caseCard({ measurement: measurement(1.4, { repeats: 1 }) })), existing: [] });
	assert.match(single.reasons.join(";"), /重复次数/);
	const unverified = evaluateCardAdmission({ card: valid(caseCard({ measurement: measurement(1.4, { correctness: "unverified" }) })), existing: [] });
	assert.match(unverified.reasons.join(";"), /正确性/);
});

test("admission keeps shortcut speedups and self-assigned credit out of the store", () => {
	const shortcut = evaluateCardAdmission({ card: valid(caseCard({
		diff: { summary: "fall back to torch when the shape is small", before: "kernel()", after: "torch.layer_norm()" } })), existing: [] });
	assert.equal(shortcut.verdict, "reject");
	assert.match(shortcut.reasons.join(";"), /捷径/);
	const selfReported = evaluateCardAdmission({ card: valid(caseCard({ measurement: measurement(1.4, { verifier: "model self-report" }) })), existing: [] });
	assert.match(selfReported.reasons.join(";"), /自述/);
	const credited = evaluateCardAdmission({ card: valid(caseCard({ credit: { injections: 0, adoptions: 9, benefitSamples: 0 } })), existing: [] });
	assert.match(credited.reasons.join(";"), /credit/);
});

test("admission deduplicates by direction and bounds a family's capacity", () => {
	const weak = valid(caseCard({ measurement: measurement(1.2) }));
	const strong = valid(caseCard({ measurement: measurement(1.9) }));
	assert.equal(optimizationDirectionSignature(weak), optimizationDirectionSignature(strong));
	const replace = evaluateCardAdmission({ card: strong, existing: [existing(weak)] });
	assert.equal(replace.verdict, "replace");
	assert.equal(replace.replaces, "C010@1");
	const duplicate = evaluateCardAdmission({ card: weak, existing: [existing(strong)] });
	assert.equal(duplicate.verdict, "reject");
	assert.match(duplicate.reasons.join(";"), /近重复/);
	// Same method, different dtype is a different entry, not a duplicate.
	const otherDtype = valid(caseCard({ applicability: { backend: "backend-a", toolchain: "toolchain-1.2", dtype: "float32", structure: ["2d-rowwise"] } }));
	assert.equal(evaluateCardAdmission({ card: otherDtype, existing: [existing(strong)] }).verdict, "admit");
	const full = Array.from({ length: 3 }, (_, index) => existing(valid(caseCard({
		method: (["tiling", "fusion", "vectorization"] as const)[index], measurement: measurement(1.3 + index / 10) })),
		`C02${index}@1`, index));
	const capped = evaluateCardAdmission({ card: valid(caseCard({ method: "layout_change" })), existing: full,
		policy: { ...DEFAULT_ADMISSION_POLICY, familyCapacity: 3 } });
	assert.equal(capped.verdict, "reject");
	assert.match(capped.reasons.join(";"), /容量上限/);
	assert.equal(capped.evictionCandidates?.[0], "C020@1");
});

test("renderOptimizationCard keeps metadata, rationale and artifact separate", () => {
	const text = renderOptimizationCard("C011@1", valid(caseCard()) as OptimizationCaseCard);
	assert.match(text, /Metadata：/);
	assert.match(text, /避免条件：/);
	assert.match(text, /Artifact：/);
	assert.match(text, /1\.400×/);
});

async function fixture(t: TestContext): Promise<{ store: KnowledgeStore; dir: string }> {
	const dir = await mkdtemp(path.join(tmpdir(), "pre-rsi-cards-"));
	t.after(async () => rm(dir, { recursive: true, force: true }));
	const store = createFileKnowledgeStore(dir);
	await store.init();
	return { store, dir };
}

test("the store gate rejects an unanchored card and publishes an anchored one", async (t) => {
	const { store } = await fixture(t);
	const bad = await store.submitProposal({ stage: "M04", runId: "r1", ops: [{ op: "create", type: "C",
		title: "噪声级加速", body: "", fields: { optimization: caseCard({ measurement: measurement(1.01) }) } }] });
	assert.equal(bad.structurallyValid, true, "structure is fine; the gate is a separate, merge-time decision");
	await assert.rejects(store.merge(bad.proposalId), /写回门禁|噪声带/);
	const good = await store.submitProposal({ stage: "M04", runId: "r2", ops: [{ op: "create", type: "C",
		title: "搬运合并", body: "合并两次非连续搬运", usageDecision: "adopted", fields: { optimization: caseCard() } }] });
	const merged = await store.merge(good.proposalId);
	assert.equal(merged.snapshot.records.length, 1);
	const records = await store.list();
	assert.equal(collectExistingCards(records, new Set()).length, 1);
	// A second, weaker card in the same direction cannot be added next to it.
	const duplicate = await store.submitProposal({ stage: "M04", runId: "r3", ops: [{ op: "create", type: "C",
		title: "重复条目", body: "", fields: { optimization: caseCard({ measurement: measurement(1.1) }) } }] });
	await assert.rejects(store.merge(duplicate.proposalId), /近重复/);
});

test("the gate freezes its verdicts so the admission rate can be read back", async (t) => {
	const { store, dir } = await fixture(t);
	const propose = async (runId: string, card: Record<string, unknown>, title: string) => {
		const receipt = await store.submitProposal({ stage: "M04", runId,
			ops: [{ op: "create", type: "C", title, body: "", usageDecision: "adopted", fields: { optimization: card } }] });
		await store.merge(receipt.proposalId).catch(() => undefined);
	};
	await propose("r1", caseCard(), "入库");
	await propose("r2", caseCard({ measurement: measurement(1.01) }), "噪声");
	await propose("r3", caseCard({ method: "tiling", measurement: measurement(1.4, { verifier: "model self-report" }) }), "自述");
	const receipts = await readAdmissionReceipts(dir);
	assert.equal(receipts.length, 3);
	const summary = summarizeAdmissionRate(receipts);
	assert.deepEqual([summary.proposed, summary.admitted, summary.rejected], [3, 1, 2]);
	assert.ok(summary.rate < 1, "a store that admits everything has no gate");
	const selfReported = receipts.find((item) => item.decisions[0].checks.antiCheat === false)!;
	assert.equal(selfReported.decisions[0].verdict, "reject");
	const noisy = receipts.find((item) => item.decisions[0].checks.thresholds === false)!;
	assert.equal(noisy.decisions[0].checks.antiCheat, true);
	assert.ok(receipts.every((item) => item.decisions[0].signature.includes("layernorm")));
});
