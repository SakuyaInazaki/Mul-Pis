/**
 * `when` knowledge: a deterministic table from (bottleneck signature, already
 * applied transforms, saturated resources, ruled-out directions) to the set of
 * methods that may be tried next.
 *
 * The point is not that the table is smarter than a model. The point is that
 * the choice is a code path: it can be logged, counted, masked and argued with
 * a metric value, and a direction the negative layer already ruled out cannot
 * come back three rounds later. Free-text strategy talk cannot do any of that.
 *
 * The table never invents a diagnosis. With no bottleneck signature it says so
 * and returns the full menu, and during compile/numerical failures it returns
 * nothing at all: a kernel that does not build is not a tuning problem.
 */
import { OPTIMIZATION_METHODS, type BottleneckSignature, type OptimizationCard, type OptimizationMethod } from "./optimization-card.ts";
import { RETRIEVAL_SCALAR_KEYS, type KnowledgeRetrievalContext } from "./retrieval.ts";

/** Built-in menus. They are a starting point for a backend with no `when`
 * cards yet, not a calibrated policy: as soon as the store has cards for a
 * family, the cards decide. */
const DEFAULT_MENU: Record<BottleneckSignature, readonly OptimizationMethod[]> = {
	memory_bound: ["memory_coalescing", "layout_change", "buffer_reuse", "double_buffer", "fusion"],
	compute_bound: ["tiling", "vectorization", "precision_mode", "algorithm_change"],
	latency_bound: ["double_buffer", "pipeline_reorder", "launch_config", "fusion"],
	launch_bound: ["fusion", "launch_config"],
	sync_bound: ["pipeline_reorder", "fusion", "buffer_reuse"],
	compile_failure: [],
	numerical_error: [],
	unknown: OPTIMIZATION_METHODS,
};

export interface DecisionPolicy {
	/** A resource already at this utilisation is not worth optimising further. */
	saturation: number;
	/** Methods offered per round. The evidence favours a short menu. */
	maxMethods: number;
	/** Metric name → methods it masks once saturated. Platform specific, so it
	 * is supplied rather than hard-coded; `when` cards carry their own rules. */
	maskRules?: ReadonlyArray<{ metric: string; masks: readonly OptimizationMethod[] }>;
}

export const DEFAULT_DECISION_POLICY: DecisionPolicy = { saturation: 0.75, maxMethods: 3 };

export interface DecisionMetric { metric: string; value: number }

export interface MethodDecisionRequest {
	bottleneck: BottleneckSignature;
	context: KnowledgeRetrievalContext;
	canonicalFamily?: string;
	operatorCategory?: string;
	/** Deterministic profiler readings, already interpreted upstream. Ratios are
	 * expressed in the same unit as `policy.saturation`. */
	metrics?: readonly DecisionMetric[];
	/** Published cards; only `when`, `avoid` and `case` cards are consulted. */
	cards: ReadonlyArray<{ ref: string; card: OptimizationCard }>;
	policy?: DecisionPolicy;
}

export interface MethodOption {
	method: OptimizationMethod;
	/** Why this method, now. Cites the metric or card the choice rests on. */
	reason: string;
	sourceRefs: string[];
}

export interface MethodDecision {
	/** `table` when published `when` cards matched, `default-menu` otherwise. */
	status: "table" | "default-menu" | "blocked";
	allowed: MethodOption[];
	masked: Array<{ method: OptimizationMethod; reason: string; sourceRefs: string[] }>;
}

/** Same rule as retrieval: only an explicitly declared scalar can conflict.
 * A missing label is unknown, never a match and never an exclusion. */
function compatible(card: OptimizationCard, context: KnowledgeRetrievalContext): boolean {
	return RETRIEVAL_SCALAR_KEYS.every((key) => {
		const declared = card.applicability[key], observed = context[key];
		return declared === undefined || observed === undefined || declared === observed;
	});
}

function familyMatch(card: OptimizationCard, request: MethodDecisionRequest): boolean {
	if (request.canonicalFamily && card.canonicalFamily !== request.canonicalFamily) return false;
	if (request.operatorCategory && card.operatorCategory !== request.operatorCategory) return false;
	return true;
}

export function decideMethods(request: MethodDecisionRequest): MethodDecision {
	const policy = request.policy ?? DEFAULT_DECISION_POLICY;
	const metrics = request.metrics ?? [];
	const relevant = request.cards.filter(({ card }) => compatible(card, request.context) && familyMatch(card, request));
	const masked: MethodDecision["masked"] = [];
	const maskedMethods = new Map<OptimizationMethod, { reason: string; sourceRefs: string[] }>();
	const mask = (method: OptimizationMethod, reason: string, sourceRefs: string[] = []): void => {
		if (maskedMethods.has(method)) return;
		maskedMethods.set(method, { reason, sourceRefs });
		masked.push({ method, reason, sourceRefs });
	};

	if (request.bottleneck === "compile_failure" || request.bottleneck === "numerical_error") {
		for (const method of OPTIMIZATION_METHODS)
			mask(method, `当前失败阶段为 ${request.bottleneck}，先修正确性，不在本阶段做性能方法选择`);
		return { status: "blocked", allowed: [], masked };
	}

	// 1. Directions the negative layer already ruled out, with their recorded reason.
	for (const { ref, card } of relevant) if (card.kind === "avoid")
		mask(card.excludedDirection, `负层已排除：${card.profileReason.slice(0, 160)}；停止条件 ${card.stopCondition.slice(0, 120)}`, [ref]);

	// 2. Saturated resources: optimising them further has no headroom to recover.
	const saturated = metrics.filter((item) => item.value >= policy.saturation);
	for (const rule of policy.maskRules ?? []) {
		const hit = saturated.find((item) => item.metric === rule.metric);
		if (hit) for (const method of rule.masks) mask(method, `${hit.metric}=${hit.value} 已达饱和阈值 ${policy.saturation}，该方向无回收余量`);
	}
	for (const { ref, card } of relevant) if (card.kind === "when")
		for (const rule of card.maskWhen) {
			const hit = metrics.find((item) => item.metric === rule.metric && item.value >= rule.atLeast);
			if (hit) for (const method of rule.masks) mask(method, `${hit.metric}=${hit.value} 已达条目登记阈值 ${rule.atLeast}`, [ref]);
		}

	// 3. Transforms already applied to this candidate.
	for (const applied of request.context.appliedTransforms ?? [])
		if ((OPTIMIZATION_METHODS as readonly string[]).includes(applied))
			mask(applied as OptimizationMethod, "本候选已应用该方向；重复微调多数无效，换方向或给出新的指标理由");

	const whenCards = relevant.filter(({ card }) => card.kind === "when" && card.bottleneck === request.bottleneck);
	const ordered: Array<{ method: OptimizationMethod; reason: string; sourceRefs: string[] }> = [];
	const push = (method: OptimizationMethod, reason: string, sourceRefs: string[]): void => {
		if (maskedMethods.has(method) || ordered.some((item) => item.method === method)) return;
		ordered.push({ method, reason, sourceRefs });
	};

	// 4. Measured cases in this family rank first: they carry a real number.
	const measured = relevant.filter((item): item is { ref: string; card: Extract<OptimizationCard, { kind: "case" }> } =>
		item.card.kind === "case" && item.card.bottleneck === request.bottleneck)
		.sort((left, right) => right.card.measurement.speedup - left.card.measurement.speedup);
	for (const { ref, card } of measured)
		push(card.method, `同族同瓶颈实测 ${card.measurement.speedup.toFixed(3)}×（${ref}）；适用条件：${card.reusableWhen.slice(0, 120)}`, [ref]);

	for (const { ref, card } of whenCards) if (card.kind === "when")
		for (const method of card.allowedMethods) push(method, `决策表条目 ${ref} 对瓶颈 ${request.bottleneck} 列出的允许方法`, [ref]);

	const status: MethodDecision["status"] = whenCards.length || measured.length ? "table" : "default-menu";
	for (const method of DEFAULT_MENU[request.bottleneck])
		push(method, `内置 ${request.bottleneck} 菜单；本库尚无该情境的 when/case 条目，属默认项而非实测结论`, []);

	return { status, allowed: ordered.slice(0, Math.max(1, policy.maxMethods)), masked };
}

/** Render the menu for a prompt. Methods are an enumerated choice with a stated
 * reason; the masked list is shown so a ruled-out direction is visibly ruled
 * out rather than silently missing. */
export function renderMethodMenu(decision: MethodDecision, bottleneck: BottleneckSignature): string {
	const lines = [`## 本轮允许的优化方向（确定性决策表，瓶颈 ${bottleneck}，来源 ${decision.status}）`];
	if (decision.status === "blocked") lines.push("- 当前阶段不做性能方向选择：先让候选编译通过且数值正确。");
	else if (!decision.allowed.length) lines.push("- 没有可用方向：全部方向已被负层或饱和指标屏蔽；需要新的诊断或改变前置结构后再议。");
	else for (const option of decision.allowed)
		lines.push(`- ${option.method}：${option.reason}${option.sourceRefs.length ? `（条目 ${option.sourceRefs.join("、")}）` : ""}`);
	if (decision.masked.length)
		lines.push(`- 已屏蔽：${decision.masked.map((item) => `${item.method}（${item.reason.slice(0, 120)}${item.sourceRefs.length ? `；${item.sourceRefs.join("、")}` : ""}）`).join("；")}`);
	lines.push("- 菜单是允许集合，不是预测收益；选定方向后仍须以本轮实测与正确性校验为准。", "");
	return lines.join("\n");
}
