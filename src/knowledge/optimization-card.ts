/**
 * Structured optimization knowledge cards (`fields.optimization`).
 *
 * The seven record types carry *what the project believes and why*. They do not
 * carry *how an operator was made faster*: that needs a diff, the conditions it
 * holds under, the conditions it must not be reused under, the profile evidence
 * behind the explanation, and a measurement that was produced by the host rather
 * than claimed by a model. A free-form `fields` object cannot be retrieved,
 * deduplicated, gated or masked deterministically, so this module gives that
 * knowledge an exact shape and validates it before it can be merged.
 *
 * Nothing here decides whether a card is scientifically correct. It decides
 * whether the card is *checkable*: every claim either carries an anchor the
 * harness can re-read (a measurement receipt, a local document path, a counted
 * attempt history) or the card is rejected.
 */
import { RETRIEVAL_FEATURE_KEYS, RETRIEVAL_SCALAR_KEYS, isKnowledgeRetrievalContext,
	type KnowledgeRetrievalContext } from "./retrieval.ts";

/** The legal action space. Cards and the decision table share it so that a card
 * can be masked, excluded or counted without parsing prose. */
export const OPTIMIZATION_METHODS = ["tiling", "double_buffer", "memory_coalescing", "pipeline_reorder",
	"buffer_reuse", "fusion", "vectorization", "layout_change", "precision_mode", "launch_config",
	"algorithm_change"] as const;
export type OptimizationMethod = (typeof OPTIMIZATION_METHODS)[number];

/** Deterministic bottleneck signatures. `unknown` is allowed and never masked:
 * a missing diagnosis must not silently look like a diagnosed one. */
export const BOTTLENECK_SIGNATURES = ["memory_bound", "compute_bound", "latency_bound", "launch_bound",
	"sync_bound", "compile_failure", "numerical_error", "unknown"] as const;
export type BottleneckSignature = (typeof BOTTLENECK_SIGNATURES)[number];

export const OPTIMIZATION_CARD_KINDS = ["case", "avoid", "rule", "contract", "when"] as const;
export type OptimizationCardKind = (typeof OPTIMIZATION_CARD_KINDS)[number];

/** Where the card came from. It selects which anchor the card must carry, not
 * how much the card is trusted. */
export const OPTIMIZATION_PROVENANCE_KINDS = ["harness-run", "rewind", "vendor-mining", "external-source"] as const;
export type OptimizationProvenanceKind = (typeof OPTIMIZATION_PROVENANCE_KINDS)[number];

export interface OptimizationProvenance {
	kind: OptimizationProvenanceKind;
	/** Exact origin: an M07 run/task, a rewind step, a vendor path, an S id. */
	detail: string;
}

/** Host-produced timing. A model's own report is not a measurement: `verifier`
 * names the host component that produced the numbers and `evidence` lists the
 * receipts that can be re-read. */
export interface OptimizationMeasurement {
	baselineMs: number;
	candidateMs: number;
	/** baselineMs / candidateMs; revalidated here so a card cannot state one
	 * number and carry another. */
	speedup: number;
	repeats: number;
	correctness: "verified" | "failed" | "unverified";
	verifier: string;
	/** Workspace-relative evidence paths or registered source ids (`S003`). */
	evidence: string[];
}

/** One machine-checkable hard constraint. `limit` is the numeric budget and
 * `unit` its unit; both must come from `source`, never from model recall. */
export interface OptimizationConstraint {
	name: string;
	/** `bytes`, `elements`, `count`, `ratio`. */
	unit: string;
	limit: number;
	/** How the observed value must compare with `limit`. */
	comparison: "at_most" | "at_least" | "multiple_of" | "equals";
	/** Local citation: workspace-relative path or registered source id. */
	source: string;
}

export interface OptimizationDiff {
	summary: string;
	/** Workspace-relative path of the frozen diff/artifact, when one exists. */
	path?: string;
	/** Minimal before/after fragments; only the changed region, never a whole kernel. */
	before?: string;
	after?: string;
}

export interface OptimizationMetric {
	metric: string;
	value: number;
	unit?: string;
}

export interface OptimizationCredit {
	/** Times the card actually entered a prompt. */
	injections: number;
	/** Times a later adopted record cited it. */
	adoptions: number;
	/** Measured outcomes recorded after an injection. */
	benefitSamples: number;
}

interface CardCommon {
	version: 1;
	kind: OptimizationCardKind;
	operatorCategory: string;
	canonicalFamily: string;
	bottleneck: BottleneckSignature;
	/** Required retrieval key: stage/backend/toolchain/dtype/layout plus
	 * structure/appliedTransforms/symptoms. Backend and toolchain are mandatory
	 * because a cross-backend example fails silently. */
	applicability: KnowledgeRetrievalContext;
	provenance: OptimizationProvenance;
	credit?: OptimizationCredit;
}

export interface OptimizationCaseCard extends CardCommon {
	kind: "case";
	method: OptimizationMethod;
	diff: OptimizationDiff;
	rootMechanism: string;
	/** Code change → metric movement → latency change. No speculation. */
	causalChain: string;
	profileEvidence: OptimizationMetric[];
	reusableWhen: string;
	avoidWhen: string;
	/** Hard constraints that must be carried with the example. */
	constraints: OptimizationConstraint[];
	measurement: OptimizationMeasurement;
	/** Marks the card as a few-shot exemplar; admission applies a higher bar. */
	exemplar?: boolean;
}

export interface OptimizationAvoidCard extends CardCommon {
	kind: "avoid";
	/** The direction that was ruled out, as an action-space member. */
	excludedDirection: OptimizationMethod;
	/** Observed regression factor (candidate/baseline latency ratio), >= 1. */
	lossMagnitude?: number;
	profileReason: string;
	stopCondition: string;
	attempts: number;
	successes: number;
	measurement?: OptimizationMeasurement;
}

export interface OptimizationRuleCard extends CardCommon {
	kind: "rule";
	/** Compiler/runtime error symbol this rule is keyed by. */
	errorSignature: string;
	/** One short imperative sentence, e.g. "You cannot ...". */
	ruleText: string;
	/** How many independent failures produced it. */
	frequency: number;
	evidence: string[];
}

export interface OptimizationContractCard extends CardCommon {
	kind: "contract";
	/** Exact API symbol, when the card carries a signature. */
	api?: string;
	signature?: string;
	constraints: OptimizationConstraint[];
	/** Local citation for the whole card: path or registered source id. */
	source: string;
}

export interface OptimizationWhenCard extends CardCommon {
	kind: "when";
	allowedMethods: OptimizationMethod[];
	/** Mask a method once the named metric is already at least this value. */
	maskWhen: Array<{ metric: string; atLeast: number; masks: OptimizationMethod[] }>;
	evidence: string[];
}

export type OptimizationCard = OptimizationCaseCard | OptimizationAvoidCard | OptimizationRuleCard
	| OptimizationContractCard | OptimizationWhenCard;

export const SHORT_FIELD_LIMIT = 240;
export const PROSE_FIELD_LIMIT = 1200;
const SOURCE_ID = /^S\d{3,}$/u;

const isObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);
const isFinitePositive = (value: unknown): value is number =>
	typeof value === "number" && Number.isFinite(value) && value > 0;
const isCount = (value: unknown): value is number =>
	typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

function text(value: unknown, limit: number): value is string {
	return typeof value === "string" && !!value.trim() && value.length <= limit;
}

/** A local citation is either a registered source id or a relative workspace
 * path. An absolute path, a URL or a bare claim is not a citation. */
export function isLocalCitation(value: unknown): value is string {
	if (typeof value !== "string" || !value.trim() || value.length > SHORT_FIELD_LIMIT) return false;
	if (SOURCE_ID.test(value)) return true;
	if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(value) || value.startsWith("/") || /^[A-Za-z]:[\\/]/u.test(value)) return false;
	return value.split(/[\\/]/u).every(part => !!part && part !== "." && part !== "..");
}

const COMMON_KEYS = ["version", "kind", "operatorCategory", "canonicalFamily", "bottleneck", "applicability", "provenance", "credit"] as const;
const KIND_KEYS: Record<OptimizationCardKind, readonly string[]> = {
	case: ["method", "diff", "rootMechanism", "causalChain", "profileEvidence", "reusableWhen", "avoidWhen", "constraints", "measurement", "exemplar"],
	avoid: ["excludedDirection", "lossMagnitude", "profileReason", "stopCondition", "attempts", "successes", "measurement"],
	rule: ["errorSignature", "ruleText", "frequency", "evidence"],
	contract: ["api", "signature", "constraints", "source"],
	when: ["allowedMethods", "maskWhen", "evidence"],
};

function citations(value: unknown, label: string, issues: string[]): void {
	if (!Array.isArray(value) || !value.length || !value.every(isLocalCitation))
		issues.push(`${label} 必须是非空数组，每项为已登记来源 ID（S003）或工作区相对路径，不接受绝对路径、URL 或空串`);
}

function constraintIssues(value: unknown, label: string, issues: string[], required: boolean): void {
	if (!Array.isArray(value)) { issues.push(`${label} 必须是数组`); return; }
	if (required && !value.length) issues.push(`${label} 不能为空：示例必须与硬约束成对给出`);
	for (const [index, item] of value.entries()) {
		const at = `${label}[${index}]`;
		if (!isObject(item)) { issues.push(`${at} 必须是对象`); continue; }
		for (const key of Object.keys(item))
			if (!["name", "unit", "limit", "comparison", "source"].includes(key)) issues.push(`${at} 含未知字段`);
		if (!text(item.name, 80)) issues.push(`${at}.name 必须是不超过 80 字符的非空字符串`);
		if (!text(item.unit, 24)) issues.push(`${at}.unit 必须是不超过 24 字符的非空字符串`);
		if (typeof item.limit !== "number" || !Number.isFinite(item.limit)) issues.push(`${at}.limit 必须是有限数值`);
		if (!["at_most", "at_least", "multiple_of", "equals"].includes(String(item.comparison)))
			issues.push(`${at}.comparison 必须是 at_most、at_least、multiple_of 或 equals`);
		if (!isLocalCitation(item.source)) issues.push(`${at}.source 必须是本地出处（已登记来源 ID 或工作区相对路径）；硬件常数不得只凭模型记忆`);
	}
}

function measurementIssues(value: unknown, label: string, issues: string[]): void {
	if (!isObject(value)) { issues.push(`${label} 必须是对象`); return; }
	for (const key of Object.keys(value))
		if (!["baselineMs", "candidateMs", "speedup", "repeats", "correctness", "verifier", "evidence"].includes(key))
			issues.push(`${label} 含未知字段`);
	const baseline = value.baselineMs, candidate = value.candidateMs, speedup = value.speedup;
	if (!isFinitePositive(baseline)) issues.push(`${label}.baselineMs 必须是正数（毫秒）`);
	if (!isFinitePositive(candidate)) issues.push(`${label}.candidateMs 必须是正数（毫秒）`);
	if (!isFinitePositive(speedup)) issues.push(`${label}.speedup 必须是正数`);
	if (isFinitePositive(baseline) && isFinitePositive(candidate) && isFinitePositive(speedup) &&
		Math.abs(speedup - baseline / candidate) > 0.01 * speedup)
		issues.push(`${label}.speedup 与 baselineMs/candidateMs 不一致（允许 1% 误差）`);
	if (typeof value.repeats !== "number" || !Number.isSafeInteger(value.repeats) || value.repeats < 1)
		issues.push(`${label}.repeats 必须是不小于 1 的整数`);
	if (!["verified", "failed", "unverified"].includes(String(value.correctness)))
		issues.push(`${label}.correctness 必须是 verified、failed 或 unverified`);
	if (!text(value.verifier, 80)) issues.push(`${label}.verifier 必须写明产出该数值的宿主校验组件；模型自述不是测量`);
	citations(value.evidence, `${label}.evidence`, issues);
}

/** Structure only. Whether the card is scientifically right is never decided here. */
export function validateOptimizationCard(value: unknown): { card?: OptimizationCard; issues: string[] } {
	const issues: string[] = [];
	if (!isObject(value)) return { issues: ["fields.optimization 必须是对象，含 version、kind、operatorCategory、canonicalFamily、bottleneck、applicability 与 provenance"] };
	if (value.version !== 1) issues.push("fields.optimization.version 必须是 1");
	const kind = value.kind;
	if (typeof kind !== "string" || !OPTIMIZATION_CARD_KINDS.includes(kind as OptimizationCardKind))
		return { issues: [...issues, `fields.optimization.kind 必须是 ${OPTIMIZATION_CARD_KINDS.join(" | ")}`] };
	const allowed = new Set<string>([...COMMON_KEYS, ...KIND_KEYS[kind as OptimizationCardKind]]);
	for (const key of Object.keys(value)) if (!allowed.has(key)) issues.push(`fields.optimization 含该 kind 不接受的字段（检查拼写，例如 avoid_when 应为 avoidWhen）`);
	if (!text(value.operatorCategory, 80)) issues.push("fields.optimization.operatorCategory 必须是不超过 80 字符的非空字符串");
	if (!text(value.canonicalFamily, 80)) issues.push("fields.optimization.canonicalFamily 必须是不超过 80 字符的非空字符串");
	if (typeof value.bottleneck !== "string" || !BOTTLENECK_SIGNATURES.includes(value.bottleneck as BottleneckSignature))
		issues.push(`fields.optimization.bottleneck 必须是 ${BOTTLENECK_SIGNATURES.join(" | ")}`);
	if (!isKnowledgeRetrievalContext(value.applicability)) issues.push("fields.optimization.applicability 必须是合法检索情境对象（stage/backend/toolchain/dtype/layout 为非空字符串，structure/appliedTransforms/symptoms 为非空字符串数组）");
	else {
		const context = value.applicability;
		if (!context.backend) issues.push("fields.optimization.applicability.backend 必填：跨后端复用是静默失效的主要来源");
		if (!context.toolchain) issues.push("fields.optimization.applicability.toolchain 必填：同一后端不同工具链版本的约束不通用");
	}
	if (!isObject(value.provenance)) issues.push("fields.optimization.provenance 必须是对象，含 kind 与 detail");
	else {
		for (const key of Object.keys(value.provenance)) if (key !== "kind" && key !== "detail") issues.push("fields.optimization.provenance 含未知字段");
		if (typeof value.provenance.kind !== "string" || !OPTIMIZATION_PROVENANCE_KINDS.includes(value.provenance.kind as OptimizationProvenanceKind))
			issues.push(`fields.optimization.provenance.kind 必须是 ${OPTIMIZATION_PROVENANCE_KINDS.join(" | ")}`);
		if (!text(value.provenance.detail, SHORT_FIELD_LIMIT)) issues.push("fields.optimization.provenance.detail 必须写明确切来源（运行/任务、rewind 步骤、厂商路径或来源 ID）");
		else if (value.provenance.kind === "harness-run" && !/(?:M0\d|T\d{3,}|\d{8}T\d{6}Z)/u.test(String(value.provenance.detail)))
			issues.push("provenance.kind=\"harness-run\" 时 detail 必须含确切轨迹标识（运行 ID 或任务 ID），否则无法回溯来源轨迹");
	}
	if (value.credit !== undefined) {
		if (!isObject(value.credit)) issues.push("fields.optimization.credit 必须是对象");
		else {
			for (const key of Object.keys(value.credit)) if (!["injections", "adoptions", "benefitSamples"].includes(key)) issues.push("fields.optimization.credit 含未知字段");
			for (const key of ["injections", "adoptions", "benefitSamples"] as const)
				if (!isCount(value.credit[key])) issues.push(`fields.optimization.credit.${key} 必须是非负整数`);
		}
	}
	validateKindFields(kind as OptimizationCardKind, value, issues);
	return issues.length ? { issues } : { card: value as unknown as OptimizationCard, issues };
}

function methodList(value: unknown, label: string, issues: string[]): void {
	if (!Array.isArray(value) || !value.length) { issues.push(`${label} 必须是非空方法数组`); return; }
	if (new Set(value).size !== value.length) issues.push(`${label} 不能有重复方法`);
	for (const item of value)
		if (typeof item !== "string" || !OPTIMIZATION_METHODS.includes(item as OptimizationMethod))
			issues.push(`${label} 只能取合法动作空间：${OPTIMIZATION_METHODS.join(" | ")}`);
}

function validateKindFields(kind: OptimizationCardKind, value: Record<string, unknown>, issues: string[]): void {
	if (kind === "case") {
		// An example is dtype- and shape-specific: copying one across dtypes or
		// ranks is exactly how a tiling constant silently becomes a buffer overrun.
		const applicability = isKnowledgeRetrievalContext(value.applicability) ? value.applicability : undefined;
		if (applicability && !applicability.dtype) issues.push("案例卡的 applicability.dtype 必填：跨 dtype 照抄 tiling 是最常见的静默失效");
		if (applicability && !applicability.structure?.length) issues.push("案例卡的 applicability.structure 必填：至少写明 rank 或形状结构假设（如 2d-rowwise）");
		if (typeof value.method !== "string" || !OPTIMIZATION_METHODS.includes(value.method as OptimizationMethod))
			issues.push(`fields.optimization.method 必须是合法动作空间之一：${OPTIMIZATION_METHODS.join(" | ")}`);
		if (!isObject(value.diff)) issues.push("fields.optimization.diff 必须是对象，含 summary 与 path 或 before/after");
		else {
			for (const key of Object.keys(value.diff)) if (!["summary", "path", "before", "after"].includes(key)) issues.push("fields.optimization.diff 含未知字段");
			if (!text(value.diff.summary, PROSE_FIELD_LIMIT)) issues.push("fields.optimization.diff.summary 必须是非空字符串，只描述最小责任区域");
			if (value.diff.path !== undefined && !isLocalCitation(value.diff.path)) issues.push("fields.optimization.diff.path 必须是工作区相对路径或已登记来源 ID");
			for (const key of ["before", "after"] as const)
				if (value.diff[key] !== undefined && (typeof value.diff[key] !== "string" || !String(value.diff[key]).trim() || String(value.diff[key]).length > 4000))
					issues.push(`fields.optimization.diff.${key} 必须是不超过 4000 字符的非空片段，只截改动部分`);
			if (value.diff.path === undefined && (value.diff.before === undefined || value.diff.after === undefined))
				issues.push("fields.optimization.diff 必须给出 path，或同时给出 before 与 after 的改动片段");
		}
		for (const key of ["rootMechanism", "causalChain", "reusableWhen", "avoidWhen"] as const)
			if (!text(value[key], PROSE_FIELD_LIMIT)) issues.push(`fields.optimization.${key} 必须是不超过 ${PROSE_FIELD_LIMIT} 字符的非空字符串；avoidWhen 记录什么时候不能用，不得省略`);
		if (!Array.isArray(value.profileEvidence) || !value.profileEvidence.length) issues.push("fields.optimization.profileEvidence 必须是非空数组：因果链必须落到具体指标名与数值");
		else for (const [index, item] of value.profileEvidence.entries()) {
			const at = `fields.optimization.profileEvidence[${index}]`;
			if (!isObject(item)) { issues.push(`${at} 必须是对象`); continue; }
			for (const key of Object.keys(item)) if (!["metric", "value", "unit"].includes(key)) issues.push(`${at} 含未知字段`);
			if (!text(item.metric, 80)) issues.push(`${at}.metric 必须是指标名`);
			if (typeof item.value !== "number" || !Number.isFinite(item.value)) issues.push(`${at}.value 必须是有限数值`);
			if (item.unit !== undefined && !text(item.unit, 24)) issues.push(`${at}.unit 必须是不超过 24 字符的非空字符串`);
		}
		constraintIssues(value.constraints, "fields.optimization.constraints", issues, true);
		measurementIssues(value.measurement, "fields.optimization.measurement", issues);
		if (value.exemplar !== undefined && typeof value.exemplar !== "boolean") issues.push("fields.optimization.exemplar 必须是布尔值");
		return;
	}
	if (kind === "avoid") {
		if (typeof value.excludedDirection !== "string" || !OPTIMIZATION_METHODS.includes(value.excludedDirection as OptimizationMethod))
			issues.push(`fields.optimization.excludedDirection 必须是合法动作空间之一：${OPTIMIZATION_METHODS.join(" | ")}`);
		if (value.lossMagnitude !== undefined && (typeof value.lossMagnitude !== "number" || !Number.isFinite(value.lossMagnitude) || value.lossMagnitude < 1))
			issues.push("fields.optimization.lossMagnitude 必须是不小于 1 的退化倍数");
		for (const key of ["profileReason", "stopCondition"] as const)
			if (!text(value[key], PROSE_FIELD_LIMIT)) issues.push(`fields.optimization.${key} 必须是非空字符串：否定理由要有 profile 支撑，并写明什么测量结果会推翻它`);
		if (typeof value.attempts !== "number" || !Number.isSafeInteger(value.attempts) || value.attempts < 1)
			issues.push("fields.optimization.attempts 必须是不小于 1 的整数");
		if (!isCount(value.successes) || (typeof value.attempts === "number" && (value.successes as number) > value.attempts))
			issues.push("fields.optimization.successes 必须是不超过 attempts 的非负整数");
		if (value.measurement !== undefined) measurementIssues(value.measurement, "fields.optimization.measurement", issues);
		else if (typeof value.attempts !== "number" || value.attempts < 3)
			issues.push("负例必须有实测退化证据，或至少 3 次独立尝试的统计；两者都没有时不得入库");
		return;
	}
	if (kind === "rule") {
		if (!text(value.errorSignature, SHORT_FIELD_LIMIT)) issues.push("fields.optimization.errorSignature 必须是确切的编译/运行错误符号");
		if (!text(value.ruleText, SHORT_FIELD_LIMIT)) issues.push(`fields.optimization.ruleText 必须是一句不超过 ${SHORT_FIELD_LIMIT} 字符的硬规则`);
		if (typeof value.frequency !== "number" || !Number.isSafeInteger(value.frequency) || value.frequency < 1)
			issues.push("fields.optimization.frequency 必须是观察到的独立失败次数（整数，不小于 1）");
		citations(value.evidence, "fields.optimization.evidence", issues);
		return;
	}
	if (kind === "contract") {
		if (value.api !== undefined && !text(value.api, SHORT_FIELD_LIMIT)) issues.push("fields.optimization.api 必须是确切符号名");
		if (value.signature !== undefined && !text(value.signature, 480)) issues.push("fields.optimization.signature 必须是确切签名字符串");
		constraintIssues(value.constraints ?? [], "fields.optimization.constraints", issues, false);
		if (!isLocalCitation(value.source)) issues.push("fields.optimization.source 必须是本地出处：已登记来源 ID 或工作区相对路径；联网检索结果不作主信息源");
		const hasSignature = value.api !== undefined && value.signature !== undefined;
		const hasConstraint = Array.isArray(value.constraints) && value.constraints.length > 0;
		if (!hasSignature && !hasConstraint) issues.push("契约卡必须给出 api+signature，或至少一条硬约束");
		return;
	}
	methodList(value.allowedMethods, "fields.optimization.allowedMethods", issues);
	if (value.maskWhen !== undefined) {
		if (!Array.isArray(value.maskWhen)) issues.push("fields.optimization.maskWhen 必须是数组");
		else for (const [index, item] of value.maskWhen.entries()) {
			const at = `fields.optimization.maskWhen[${index}]`;
			if (!isObject(item)) { issues.push(`${at} 必须是对象`); continue; }
			for (const key of Object.keys(item)) if (!["metric", "atLeast", "masks"].includes(key)) issues.push(`${at} 含未知字段`);
			if (!text(item.metric, 80)) issues.push(`${at}.metric 必须是指标名`);
			if (typeof item.atLeast !== "number" || !Number.isFinite(item.atLeast)) issues.push(`${at}.atLeast 必须是有限数值`);
			methodList(item.masks, `${at}.masks`, issues);
		}
	}
	citations(value.evidence, "fields.optimization.evidence", issues);
}

/** Read a validated card off a record's fields. Invalid or absent metadata is
 * never guessed into a card: it simply is not one. */
export function readOptimizationCard(fields: Record<string, unknown>): OptimizationCard | undefined {
	if (!Object.hasOwn(fields, "optimization")) return undefined;
	return validateOptimizationCard(fields.optimization).card;
}

/** Deterministic identity of "what this card says to do, under what conditions".
 * Two cards with the same signature are the same entry for deduplication. */
export function optimizationDirectionSignature(card: OptimizationCard): string {
	const context = card.applicability;
	const scalars = RETRIEVAL_SCALAR_KEYS.map(key => `${key}=${context[key] ?? ""}`).join("|");
	const features = RETRIEVAL_FEATURE_KEYS.map(key => `${key}=${[...(context[key] ?? [])].sort().join(",")}`).join("|");
	const action = card.kind === "case" ? card.method
		: card.kind === "avoid" ? card.excludedDirection
		: card.kind === "rule" ? card.errorSignature
		: card.kind === "contract" ? `${card.api ?? ""}#${card.constraints.map(item => item.name).sort().join(",")}`
		: [...card.allowedMethods].sort().join(",");
	return [card.kind, card.operatorCategory, card.canonicalFamily, card.bottleneck, action, scalars, features].join("::");
}

function clip(value: string, max: number): string {
	return value.length <= max ? value : `${value.slice(0, max)}…（按 ID 读取原文）`;
}

/** Three sections, in this order: Metadata (what it applies to), Rationale (why
 * it worked and where it must not be reused), Artifact (the exact change).
 * Flattening these into prose is what the evidence says costs the most. */
export function renderOptimizationCard(id: string, card: OptimizationCard): string {
	const context = card.applicability;
	const metadata = [`算子类别 ${card.operatorCategory}`, `结构族 ${card.canonicalFamily}`, `瓶颈 ${card.bottleneck}`,
		...RETRIEVAL_SCALAR_KEYS.flatMap(key => context[key] ? [`${key} ${context[key]}`] : []),
		...RETRIEVAL_FEATURE_KEYS.flatMap(key => context[key]?.length ? [`${key} ${context[key]!.join("/")}`] : [])].join("；");
	const lines = [`### ${id} [${card.kind}] ${card.canonicalFamily}/${card.operatorCategory}`,
		`- Metadata：${metadata}；来源 ${card.provenance.kind}`];
	if (card.kind === "case") {
		lines.push(`- Rationale：方法 ${card.method}；机制 ${clip(card.rootMechanism, SHORT_FIELD_LIMIT)}；因果链 ${clip(card.causalChain, SHORT_FIELD_LIMIT)}`,
			`- profile 证据：${card.profileEvidence.map(item => `${item.metric}=${item.value}${item.unit ?? ""}`).join("、")}`,
			`- 实测：${card.measurement.speedup.toFixed(3)}×（${card.measurement.baselineMs}ms→${card.measurement.candidateMs}ms，${card.measurement.repeats} 次，正确性 ${card.measurement.correctness}，校验 ${card.measurement.verifier}）`,
			`- 可复用条件：${clip(card.reusableWhen, SHORT_FIELD_LIMIT)}`,
			`- 避免条件：${clip(card.avoidWhen, SHORT_FIELD_LIMIT)}`,
			`- 硬约束：${card.constraints.map(item => `${item.name} ${item.comparison} ${item.limit}${item.unit}（出处 ${item.source}）`).join("；")}`,
			`- Artifact：${card.diff.path ? `diff ${card.diff.path}` : "内联改动片段"}；${clip(card.diff.summary, SHORT_FIELD_LIMIT)}`);
	} else if (card.kind === "avoid") {
		lines.push(`- Rationale：已排除方向 ${card.excludedDirection}；原因 ${clip(card.profileReason, SHORT_FIELD_LIMIT)}`,
			`- 损失幅度：${card.lossMagnitude === undefined ? "未实测" : `${card.lossMagnitude.toFixed(3)}× 退化`}；尝试 ${card.attempts} 次、成功 ${card.successes} 次`,
			`- 停止条件：${clip(card.stopCondition, SHORT_FIELD_LIMIT)}`,
			"- Artifact：无（负例只记录被否方向与证据，不保留可复制代码）");
	} else if (card.kind === "rule") {
		lines.push(`- Rationale：错误签名 ${clip(card.errorSignature, 120)}；观察到 ${card.frequency} 次`,
			`- 规则：${card.ruleText}`, `- Artifact：证据 ${card.evidence.join("、")}`);
	} else if (card.kind === "contract") {
		lines.push(`- Rationale：出处 ${card.source}${card.api ? `；API ${card.api}` : ""}`,
			...(card.signature ? [`- 签名：${clip(card.signature, 480)}`] : []),
			...(card.constraints.length ? [`- 硬约束：${card.constraints.map(item => `${item.name} ${item.comparison} ${item.limit}${item.unit}（出处 ${item.source}）`).join("；")}`] : []),
			"- Artifact：契约卡只给签名与数值约束，不给可直接粘贴的实现");
	} else {
		lines.push(`- Rationale：允许方法 ${card.allowedMethods.join("、")}`,
			`- 屏蔽规则：${card.maskWhen.length ? card.maskWhen.map(item => `${item.metric} ≥ ${item.atLeast} 时屏蔽 ${item.masks.join("、")}`).join("；") : "无"}`,
			`- Artifact：证据 ${card.evidence.join("、")}`);
	}
	lines.push("- 卡片是条件化结论，不是采用许可；使用前核对当前情境、必要依赖与生效限制。", "");
	return lines.join("\n");
}
