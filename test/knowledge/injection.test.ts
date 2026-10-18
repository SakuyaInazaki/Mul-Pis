import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { decideMethods, renderMethodMenu } from "../../src/knowledge/decision-table.ts";
import { assembleInjection, INJECTION_PLANS, planInjection } from "../../src/knowledge/injection.ts";
import { loadPriorLibrary, selectPrior } from "../../src/knowledge/prior-library.ts";
import { validateOptimizationCard, type OptimizationCard } from "../../src/knowledge/optimization-card.ts";
import { createFileKnowledgeStore } from "../../src/knowledge/store.ts";
import type { KnowledgeStore, ProposalOp } from "../../src/knowledge/types.ts";

const context = { backend: "ascend-c", toolchain: "CANN-8.0", dtype: "float16" };

function card(raw: Record<string, unknown>): OptimizationCard {
	const result = validateOptimizationCard(raw);
	assert.equal(result.issues.length, 0, result.issues.join("; "));
	return result.card!;
}

const base = { version: 1, operatorCategory: "normalization", canonicalFamily: "layernorm",
	applicability: context, provenance: { kind: "harness-run", detail: "M07/run/T001" } };

const caseCard = (method: string, speedup = 1.4, extra: Record<string, unknown> = {}) => card({ ...base, kind: "case",
	bottleneck: "memory_bound", method,
	diff: { summary: `应用 ${method}`, before: "a", after: "b" },
	rootMechanism: "非连续搬运触发额外事务", causalChain: `${method} → aiv_mte2_ratio 下降 → 延迟下降`,
	profileEvidence: [{ metric: "aiv_mte2_ratio", value: 0.81 }],
	reusableWhen: "同 dtype 且尾块可整除", avoidWhen: "尾块需要掩码时不可套用",
	constraints: [{ name: "ub_bytes", unit: "bytes", limit: 196352, comparison: "at_most", source: "S003" }],
	measurement: { baselineMs: 10, candidateMs: 10 / speedup, speedup, repeats: 5, correctness: "verified",
		verifier: "candidate-performance", evidence: ["stages/M07/run/timing.json"] }, ...extra });

const avoidCard = (method: string) => card({ ...base, kind: "avoid", bottleneck: "memory_bound",
	excludedDirection: method, profileReason: "融合后 UB 超限，MTE2 反升", stopCondition: "UB 预算提高到 256KB 可重试",
	attempts: 4, successes: 0 });

const whenCard = () => card({ ...base, kind: "when", bottleneck: "memory_bound",
	allowedMethods: ["layout_change", "buffer_reuse"],
	maskWhen: [{ metric: "aiv_vec_ratio", atLeast: 0.75, masks: ["vectorization"] }], evidence: ["S003"] });

const ruleCard = () => card({ ...base, kind: "rule", bottleneck: "compile_failure",
	errorSignature: "no member named 'Softmax'", ruleText: "You cannot call AscendC::Softmax in this CANN version",
	frequency: 4, evidence: ["stages/M07/run/compile.log"] });

test("the decision table ranks measured methods first and names why each one is allowed", () => {
	const decision = decideMethods({ bottleneck: "memory_bound", context,
		cards: [{ ref: "C001@1", card: caseCard("memory_coalescing", 1.8) }, { ref: "C002@1", card: whenCard() }] });
	assert.equal(decision.status, "table");
	assert.equal(decision.allowed[0].method, "memory_coalescing");
	assert.match(decision.allowed[0].reason, /1\.800×/);
	assert.ok(decision.allowed.some((item) => item.method === "layout_change"));
	assert.ok(renderMethodMenu(decision, "memory_bound").includes("本轮允许的优化方向"));
});

test("the negative layer, saturated metrics and already applied transforms mask directions", () => {
	const decision = decideMethods({
		bottleneck: "memory_bound",
		context: { ...context, appliedTransforms: ["buffer_reuse"] },
		metrics: [{ metric: "aiv_vec_ratio", value: 0.9 }, { metric: "aiv_mte2_ratio", value: 0.95 }],
		policy: { saturation: 0.75, maxMethods: 3, maskRules: [{ metric: "aiv_mte2_ratio", masks: ["memory_coalescing"] }] },
		cards: [{ ref: "C003@1", card: avoidCard("fusion") }, { ref: "C004@1", card: whenCard() }],
	});
	const masked = new Map(decision.masked.map((item) => [item.method, item.reason]));
	assert.match(masked.get("fusion") ?? "", /负层已排除/);
	assert.match(masked.get("memory_coalescing") ?? "", /饱和阈值/);
	assert.match(masked.get("buffer_reuse") ?? "", /已应用/);
	assert.match(masked.get("vectorization") ?? "", /aiv_vec_ratio/);
	assert.ok(!decision.allowed.some((item) => ["fusion", "memory_coalescing", "buffer_reuse", "vectorization"].includes(item.method)));
});

test("a compile or numerical failure is not a tuning problem", () => {
	for (const bottleneck of ["compile_failure", "numerical_error"] as const) {
		const decision = decideMethods({ bottleneck, context, cards: [] });
		assert.equal(decision.status, "blocked");
		assert.equal(decision.allowed.length, 0);
	}
	const unknown = decideMethods({ bottleneck: "unknown", context, cards: [] });
	assert.equal(unknown.status, "default-menu");
	assert.match(unknown.allowed[0].reason, /默认项而非实测结论/);
});

test("the frozen prior is layered, hard filtered by backend and bounded", async (t) => {
	const root = await mkdtemp(path.join(tmpdir(), "pre-rsi-prior-"));
	t.after(async () => rm(root, { recursive: true, force: true }));
	const write = async (layer: string, name: string, metadata: Record<string, unknown>, body: string): Promise<void> => {
		await mkdir(path.join(root, layer), { recursive: true });
		await writeFile(path.join(root, layer, name),
			`---\n${Object.entries(metadata).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join("\n")}\n---\n${body}\n`);
	};
	await write("L2", "ub.md", { layer: "L2", title: "UB 容量", applicability: { backend: "ascend-c", toolchain: "CANN-8.0" }, source: "S003" }, "UB 上限按芯片型号从实机读取。");
	await write("L2", "other-backend.md", { layer: "L2", title: "别的后端", applicability: { backend: "cuda", toolchain: "12.4" }, source: "S004" }, "不适用。");
	await write("L3", "tiling.md", { layer: "L3", title: "tiling 公式", applicability: { backend: "ascend-c", toolchain: "CANN-8.0" }, source: "docs/tiling.md" }, "tileLength = AlignUp(...)");
	await write("L2", "broken.md", { layer: "L2", title: "缺出处", applicability: { backend: "ascend-c", toolchain: "CANN-8.0" }, source: "https://example.invalid/x" }, "没有本地出处。");
	const library = await loadPriorLibrary(root);
	assert.equal(library.entries.length, 3);
	assert.match(library.rejected[0].reason, /source/);
	const selection = selectPrior(library, { layers: ["L2", "L3"], context, maxEntries: 5, maxChars: 10_000 });
	assert.deepEqual(selection.included.map((item) => item.title), ["UB 容量", "tiling 公式"]);
	assert.ok(selection.omitted.some((item) => item.reason.includes("情境不匹配")));
	const tiny = selectPrior(library, { layers: ["L2", "L3"], context, maxEntries: 1, maxChars: 10_000 });
	assert.equal(tiny.included.length, 1);
	assert.ok(tiny.omitted.some((item) => item.reason.includes("条数上限")));
});

async function storeWithCards(t: TestContext): Promise<{ store: KnowledgeStore; dir: string }> {
	const dir = await mkdtemp(path.join(tmpdir(), "pre-rsi-injection-"));
	t.after(async () => rm(dir, { recursive: true, force: true }));
	const store = createFileKnowledgeStore(path.join(dir, "knowledge"));
	await store.init();
	const ops: ProposalOp[] = [
		{ op: "create", type: "C", title: "搬运合并案例", body: "layernorm 搬运合并", usageDecision: "adopted",
			fields: { optimization: caseCard("memory_coalescing", 1.8) as unknown as Record<string, unknown> } },
		{ op: "create", type: "C", title: "融合负例", body: "融合在该形状下退化", usageDecision: "adopted",
			fields: { optimization: avoidCard("fusion") as unknown as Record<string, unknown> } },
		{ op: "create", type: "K", title: "Softmax 幻觉 API 规则", body: "编译失败规则", usageDecision: "adopted",
			fields: { optimization: ruleCard() as unknown as Record<string, unknown> } },
		{ op: "create", type: "C", title: "纯叙述记录", body: "layernorm 的一般性讨论，没有结构化卡片", usageDecision: "adopted" },
	];
	const receipt = await store.submitProposal({ stage: "M04", runId: "r1", ops });
	assert.equal(receipt.structurallyValid, true, receipt.issues.map((item) => item.message).join("; "));
	await store.merge(receipt.proposalId);
	return { store, dir };
}

test("each phase injects only its own card kinds inside its own bounds", async (t) => {
	const { store } = await storeWithCards(t);
	const mutation = await assembleInjection({ store, phase: "mutation", purpose: "变异护栏",
		text: "layernorm 搬运 融合 Softmax", context });
	assert.ok(!mutation.receipt.cardRefs.length || mutation.markdown.includes("[avoid]") || mutation.markdown.includes("[rule]"));
	assert.ok(!mutation.markdown.includes("[case]"), "mutation 阶段不注入范例，避免结构漂移");
	assert.ok(mutation.receipt.omitted.some((item) => item.reason.startsWith("phase-filter")));
	assert.ok(mutation.markdown.length <= INJECTION_PLANS.mutation.maxChars + 2_000);

	const bootstrap = await assembleInjection({ store, phase: "bootstrap", purpose: "冷启动",
		text: "layernorm 搬运 融合 Softmax", context, bottleneck: "memory_bound", canonicalFamily: "layernorm" });
	assert.ok(bootstrap.markdown.includes("[case]"));
	assert.ok(bootstrap.markdown.includes("本轮允许的优化方向"));
	assert.equal(bootstrap.receipt.methodMenu?.status, "table");
	assert.ok(bootstrap.receipt.methodMenu?.masked.includes("fusion"));

	// Narrative records only reach the stages that ask for them.
	const judgment = await assembleInjection({ store, phase: "judgment", purpose: "M04 处理", text: "纯叙述 layernorm", context });
	assert.ok(judgment.receipt.injectedRefs.length >= 1);
	const tuning = await assembleInjection({ store, phase: "performance-tuning", purpose: "调优", text: "纯叙述 layernorm", context });
	assert.ok(tuning.receipt.omitted.some((item) => item.reason === "phase-filter:narrative"));
});

test("required records are never dropped by a phase filter or a budget", async (t) => {
	const { store } = await storeWithCards(t);
	const narrative = (await store.list()).find((record) => record.title === "纯叙述记录")!;
	const result = await assembleInjection({ store, phase: "performance-tuning", purpose: "调优",
		text: "无关查询", context, requiredIds: [narrative.id],
		plan: planInjection("performance-tuning", { maxRecords: 1, maxChars: 10 }) });
	assert.ok(result.receipt.injectedRefs.includes(`${narrative.id}@${narrative.version}`));
	assert.equal(result.receipt.phase, "performance-tuning");
	assert.equal(result.receipt.snapshot, (await store.current())?.id);
});

test("an error signature looks a rule up exactly, and structured keys fuse with lexical ranking", async (t) => {
	const { store } = await storeWithCards(t);
	// The round's text never mentions the rule; its exact symbol does the work.
	const compile = await assembleInjection({ store, phase: "compile-fix", purpose: "修编译",
		text: "候选无法通过编译", context,
		errorSignatures: ["kernel.cpp:12:5: error: no member named 'Softmax' in namespace 'AscendC'"] });
	assert.ok(compile.markdown.includes("[rule]"));
	assert.ok(compile.receipt.cardRefs.some((ref) => compile.markdown.includes(ref)));

	// A withdrawn rule is not looked up: live limits still decide.
	const rule = (await store.list()).find((record) => record.title.includes("Softmax"))!;
	const receipt = await store.submitProposal({ stage: "M04", runId: "r2",
		ops: [{ op: "decide", id: rule.id, usageDecision: "withdrawn", reason: "CANN 版本更新后该符号已存在" }] });
	await store.merge(receipt.proposalId);
	const after = await assembleInjection({ store, phase: "compile-fix", purpose: "修编译",
		text: "候选无法通过编译", context,
		errorSignatures: ["error: no member named 'Softmax' in namespace 'AscendC'"] });
	assert.ok(after.receipt.omitted.some((item) => item.reason === "rule-lookup:not-allowed"));
	assert.ok(!after.markdown.includes("[rule]"));
});

test("structured key matches lift a card that the lexical route ranks low", async (t) => {
	const { store } = await storeWithCards(t);
	const tuning = await assembleInjection({ store, phase: "performance-tuning", purpose: "调优",
		text: "layernorm", context, bottleneck: "memory_bound", canonicalFamily: "layernorm",
		operatorCategory: "normalization", plan: planInjection("performance-tuning", { maxRecords: 1 }) });
	// Both the case and the avoid card match lexically; the structured route puts
	// the one that matches family, category and bottleneck first.
	assert.equal(tuning.receipt.injectedRefs.length, 1);
	assert.equal(tuning.receipt.cardRefs.length, 1);
	assert.ok(tuning.markdown.includes("[case]") || tuning.markdown.includes("[avoid]"));
	// The menu still masks the ruled-out direction even when its card did not fit
	// into this phase's one-record budget.
	assert.equal(tuning.receipt.methodMenu?.status, "table");
	assert.ok(tuning.receipt.methodMenu?.masked.includes("fusion"));
});
