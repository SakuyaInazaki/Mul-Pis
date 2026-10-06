/** Allocate accounting namespaces for each phase before the first request. */
import type { BudgetLease, BudgetLimits } from "./contracts.ts";
import { SharedBudget } from "./budget.ts";
import { HarnessError } from "../types.ts";

export interface PhaseLeases {
	outer: BudgetLease;
	pilot: BudgetLease;
	branches: Array<{ old: BudgetLease; new: BudgetLease }>;
	protected: BudgetLease;
}

export interface PhaseBudgetPlan {
	kind: "executor-quality" | "meta-improvement";
	/** Historical phase monetary fields are accepted but never enforced. */
	outer?: BudgetLimits;
	pilot?: BudgetLimits;
	protected?: BudgetLimits;
	branch?: BudgetLimits;
	searchReplicates: number;
	outcomeReplicates: number;
	admissionCases: ReadonlyArray<{ maxProbeCalls: number }>;
}

const fail = (message: string): never => { throw new HarnessError("improvement.budget", message); };

/**
 * Child leases keep phase usage separate, without monetary admission gates.
 */
export async function reserveResearchPhases(budget: SharedBudget, plan: PhaseBudgetPlan): Promise<PhaseLeases> {
	const root = budget.status();
	if (root.inFlight || Object.values(root.committed).some((value) => value !== 0) || Object.values(root.reserved).some((value) => value !== 0)) fail("phase leases must be allocated before any campaign activity");
	if (!Number.isSafeInteger(plan.searchReplicates) || plan.searchReplicates < 1 || !Number.isSafeInteger(plan.outcomeReplicates) || plan.outcomeReplicates < 1) fail("invalid independent search/outcome replicate counts");
	if (plan.kind === "executor-quality" && plan.searchReplicates !== 1) fail("executor quality uses one outer search and no meta branches");
	if (!plan.admissionCases.length || plan.admissionCases.some((c) => !Number.isSafeInteger(c.maxProbeCalls) || c.maxProbeCalls < 1)) fail("invalid frozen admission case count or probe allowance");
	const outer = budget.createLease(budget.root);
	const pilot = budget.createLease(budget.root, undefined, { clockMode: "active" });
	const branches = Array.from({ length: plan.kind === "meta-improvement" ? plan.searchReplicates : 0 }, () => ({
		old: budget.createLease(budget.root), new: budget.createLease(budget.root),
	}));
	const protectedLease = budget.createLease(budget.root);
	budget.sealRootToPhases();
	return { outer, pilot, branches, protected: protectedLease };
}
