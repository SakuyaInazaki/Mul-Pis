import path from "node:path";
import { readTextIfExists } from "../workspace.ts";
import { HarnessError } from "../types.ts";

export interface BudgetPolicy {
	version: 1;
	maxPromptChars: number;
	maxInlineFileChars: number;
	maxAggregateInlineChars: number;
	maxFeedbackChars: number;
	overflowMode: "manifest-and-fail" | "manifest-and-defer";
}

export const DEFAULT_BUDGET_POLICY: BudgetPolicy = Object.freeze({
	version: 1,
	maxPromptChars: 180_000,
	maxInlineFileChars: 48_000,
	maxAggregateInlineChars: 120_000,
	maxFeedbackChars: 140_000,
	overflowMode: "manifest-and-defer",
});

const POLICY_KEYS = new Set(["version", "maxPromptChars", "maxInlineFileChars", "maxAggregateInlineChars", "maxFeedbackChars", "overflowMode"]);

export function validateBudgetPolicy(input: unknown): BudgetPolicy {
	if (!input || typeof input !== "object" || Array.isArray(input)) throw new HarnessError("improvement.policy", "BudgetPolicy 必须是 JSON 对象");
	const value = input as Record<string, unknown>;
	const unknown = Object.keys(value).filter((key) => !POLICY_KEYS.has(key));
	if (unknown.length) throw new HarnessError("improvement.policy", `BudgetPolicy 含未知字段：${unknown.join(", ")}`);
	if (value.version !== 1) throw new HarnessError("improvement.policy", "BudgetPolicy.version 必须为 1");
	const integer = (key: keyof BudgetPolicy, min: number, max: number): number => {
		const item = value[key];
		if (typeof item !== "number" || !Number.isInteger(item) || item < min || item > max) throw new HarnessError("improvement.policy", `${key} 必须是 ${min}–${max} 的整数`);
		return item;
	};
	const policy: BudgetPolicy = {
		version: 1,
		maxPromptChars: integer("maxPromptChars", 8_000, 1_000_000),
		maxInlineFileChars: integer("maxInlineFileChars", 1_000, 250_000),
		maxAggregateInlineChars: integer("maxAggregateInlineChars", 4_000, 500_000),
		maxFeedbackChars: integer("maxFeedbackChars", 4_000, 500_000),
		overflowMode: value.overflowMode === "manifest-and-fail" ? value.overflowMode : value.overflowMode === "manifest-and-defer" ? value.overflowMode : (() => { throw new HarnessError("improvement.policy", "overflowMode 无效"); })(),
	};
	if (policy.maxInlineFileChars > policy.maxAggregateInlineChars) throw new HarnessError("improvement.policy", "maxInlineFileChars 不能大于 maxAggregateInlineChars");
	if (policy.maxAggregateInlineChars > policy.maxPromptChars) throw new HarnessError("improvement.policy", "maxAggregateInlineChars 不能大于 maxPromptChars");
	if (policy.maxFeedbackChars > policy.maxPromptChars) throw new HarnessError("improvement.policy", "maxFeedbackChars 不能大于 maxPromptChars");
	return policy;
}

export interface ActiveBudgetPointer { version: 1; versionId: string; previousVersionId?: string; promotedAt: string; runId: string; provenance?: "local-mechanism-admission" | "legacy-projection-only" | "external-manual-unverified" }

export interface InlineProjection { inline: boolean; inlineChars: number; deferredChars: number; nextAggregateChars: number; reason?: "single-file-limit" | "aggregate-limit" }

/** Runtime and evaluator share this exact all-or-nothing evidence projection. */
export function projectInline(policy: BudgetPolicy, chars: number, aggregateUsed: number): InlineProjection {
	if (!Number.isInteger(chars) || chars < 0 || !Number.isInteger(aggregateUsed) || aggregateUsed < 0) throw new HarnessError("improvement.projection", "chars 与 aggregateUsed 必须是非负整数");
	if (chars > policy.maxInlineFileChars) return { inline: false, inlineChars: 0, deferredChars: chars, nextAggregateChars: aggregateUsed, reason: "single-file-limit" };
	if (aggregateUsed + chars > policy.maxAggregateInlineChars) return { inline: false, inlineChars: 0, deferredChars: chars, nextAggregateChars: aggregateUsed, reason: "aggregate-limit" };
	return { inline: true, inlineChars: chars, deferredChars: 0, nextAggregateChars: aggregateUsed + chars };
}

export function validateActiveBudgetPointer(input: unknown): ActiveBudgetPointer {
	if (!input || typeof input !== "object" || Array.isArray(input)) throw new HarnessError("improvement.active", "active.json 必须是对象");
	const value = input as Record<string, unknown>;
	const safeId = (item: unknown): item is string => typeof item === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(item);
	if (value.version !== 1 || !safeId(value.versionId) || (value.previousVersionId !== undefined && !safeId(value.previousVersionId)) || typeof value.promotedAt !== "string" || typeof value.runId !== "string") throw new HarnessError("improvement.active", "active.json 字段无效");
	if (value.provenance !== undefined && !["local-mechanism-admission", "legacy-projection-only", "external-manual-unverified"].includes(String(value.provenance))) throw new HarnessError("improvement.active", "active.json provenance 无效");
	return value as unknown as ActiveBudgetPointer;
}

export async function loadActiveBudgetPolicy(workspaceRoot: string): Promise<BudgetPolicy> {
	const root = path.resolve(workspaceRoot, ".agent", "improvement");
	const pointerText = await readTextIfExists(path.join(root, "active.json"));
	if (!pointerText) return { ...DEFAULT_BUDGET_POLICY };
	let pointer: ActiveBudgetPointer;
	try { pointer = validateActiveBudgetPointer(JSON.parse(pointerText)); } catch (error) { if (error instanceof HarnessError) throw error; throw new HarnessError("improvement.active", "active.json 不是合法 JSON"); }
	const policyText = await readTextIfExists(path.join(root, "versions", pointer.versionId, "policy.json"));
	if (!policyText) throw new HarnessError("improvement.active", `活动预算策略 ${pointer.versionId} 不存在`);
	try { return validateBudgetPolicy(JSON.parse(policyText)); } catch (error) { if (error instanceof HarnessError) throw error; throw new HarnessError("improvement.active", `活动预算策略无法读取：${(error as Error).message}`); }
}
