import type { CurrentGoal, M07AttemptV1 } from "./types.ts";

/** Control facts only; a run may remain running while its current attempt is suspended. */
export function summarizeGoalExecution(goal: CurrentGoal): {
	attemptId?: string;
	attemptState: M07AttemptV1["state"] | "legacy-untracked";
	unresolvedOperationIds: string[];
	unresolvedTaskIds: string[];
} {
	const state = goal.executionState;
	const attempt = state?.attempts?.find((item) => item.id === state.activeAttemptId);
	return {
		attemptId: attempt?.id,
		attemptState: attempt?.state ?? "legacy-untracked",
		unresolvedOperationIds: state?.operations?.filter((item) => item.status === "unknown").map((item) => item.id) ?? [],
		unresolvedTaskIds: (goal.tasks ?? []).filter((item) => item.status === "unknown").map((item) => item.taskId),
	};
}
