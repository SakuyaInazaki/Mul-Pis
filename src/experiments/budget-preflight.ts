/** Allocate every paid phase before the first request; this does not start child wall clocks. */
import { MAX_EXECUTOR_EPISODE_ACTIONS, type BudgetLease, type BudgetLimits } from "./contracts.ts";
import { SharedBudget } from "./budget.ts";
import { HarnessError } from "../types.ts";

export interface PhaseLeases {
	outer: BudgetLease;
	pilot: BudgetLease;
	branches: Array<{ old: BudgetLease; new: BudgetLease }>;
	protected: BudgetLease;
	protectedMaxProviderCalls: number;
}

export interface PhaseBudgetPlan {
	kind: "executor-quality" | "meta-improvement";
	outer: BudgetLimits;
	pilot: BudgetLimits;
	protected: BudgetLimits;
	branch?: BudgetLimits;
	searchReplicates: number;
	outcomeReplicates: number;
	admissionCases: ReadonlyArray<{ maxProbeCalls: number }>;
}

const QUOTA_KEYS = ["maxProviderCalls", "maxInputTokens", "maxOutputTokens", "maxSdkEstimatedCost", "maxProbeCalls", "maxCpuMillis", "maxWallMillis"] as const;
const fail = (message: string): never => { throw new HarnessError("improvement.budget", message); };

/**
 * Child leases are disjoint by construction: the caller must use only the returned
 * leases for the named phases. Root status continues to report actual spend, while
 * this preflight accounts for all child ceilings before any model can be called.
 */
export async function reserveResearchPhases(budget: SharedBudget, plan: PhaseBudgetPlan): Promise<PhaseLeases> {
	const root = budget.status();
	if (root.settlement !== "settled" || Object.values(root.committed).some((value) => value !== 0) || Object.values(root.reserved).some((value) => value !== 0)) fail("phase ceilings must be allocated before any campaign spend");
	if (!Number.isSafeInteger(plan.searchReplicates) || plan.searchReplicates < 1 || plan.searchReplicates > 10 || !Number.isSafeInteger(plan.outcomeReplicates) || plan.outcomeReplicates < 1 || plan.outcomeReplicates > 10) fail("invalid independent search/outcome replicate counts");
	if (plan.kind === "executor-quality" && (plan.branch !== undefined || plan.searchReplicates !== 1)) fail("executor quality uses one outer search and no meta branches");
	if (plan.kind === "meta-improvement" && !plan.branch) fail("matched meta branches require an explicit per-arm ceiling");
	if (!plan.admissionCases.length || plan.admissionCases.length > 32 || plan.admissionCases.some((c) => !Number.isSafeInteger(c.maxProbeCalls) || c.maxProbeCalls < 1 || c.maxProbeCalls > 16)) fail("invalid frozen admission case count or probe allowance");
	const episodeCalls = plan.admissionCases.reduce((sum, c) => sum + Math.min(MAX_EXECUTOR_EPISODE_ACTIONS, c.maxProbeCalls + 2, 8), 0);
	const protectedMaxProviderCalls = 2 * plan.searchReplicates * plan.outcomeReplicates * episodeCalls;
	if (!Number.isSafeInteger(protectedMaxProviderCalls) || protectedMaxProviderCalls > 10_000) fail("protected call upper bound is invalid");
	if (plan.protected.maxProviderCalls < protectedMaxProviderCalls) fail(`protected maxProviderCalls ceiling cannot cover every permitted G request: required ${protectedMaxProviderCalls}, declared ${plan.protected.maxProviderCalls}`);
	const branchCopies = plan.kind === "meta-improvement" ? 2 * plan.searchReplicates : 0;
	for (const key of QUOTA_KEYS) {
		const total = plan.outer[key] + plan.pilot[key] + plan.protected[key] + branchCopies * (plan.branch?.[key] ?? 0);
		if (!Number.isFinite(total) || total < 0 || total > root.limits[key]) fail(`reserved phase ${key} ceilings exceed the shared root: required ${total}, root limit ${root.limits[key]}`);
	}
	const outer = budget.createLease(budget.root, plan.outer);
	// Pilot episodes are interleaved with outer decisions. Count only their active
	// execution intervals; the root continues to count real elapsed wall time.
	const pilot = budget.createLease(budget.root, plan.pilot, { clockMode: "active" });
	const branches = Array.from({ length: plan.kind === "meta-improvement" ? plan.searchReplicates : 0 }, () => ({
		old: budget.createLease(budget.root, plan.branch!), new: budget.createLease(budget.root, plan.branch!),
	}));
	const protectedLease = budget.createLease(budget.root, plan.protected);
	budget.sealRootToPhases();
	return { outer, pilot, branches, protected: protectedLease, protectedMaxProviderCalls };
}
