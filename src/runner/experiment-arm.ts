/**
 * Which orchestration arm this run is executing.
 *
 * The evidence on multi-agent orchestration is contradictory: the parts that
 * are reproducible are context isolation, token efficiency and an independent
 * reviewer, not speed. Writing the multi-role topology in as the only possible
 * architecture makes the question unanswerable, so the arm is a host-owned knob
 * that can be flipped to a single-agent control without touching code, and it is
 * recorded with the run so a later comparison knows which arm produced it.
 *
 * This module only resolves and records the choice. What a control arm does
 * differently — how many roles a task opens — belongs to the search layer that
 * owns the loop.
 */
export type ExperimentArm = "multi-role" | "single-agent";

export const EXPERIMENT_ARMS: readonly ExperimentArm[] = ["multi-role", "single-agent"];

/**
 * Read the arm from the host environment. A model-facing shell is rebuilt
 * without this variable, so a run cannot relabel its own arm.
 */
export function experimentArmFromEnvironment(env: NodeJS.ProcessEnv = process.env): ExperimentArm {
	const value = env.PRE_RSI_EXPERIMENT_ARM;
	if (value === undefined) return "multi-role";
	if (!EXPERIMENT_ARMS.includes(value as ExperimentArm))
		throw new Error(`PRE_RSI_EXPERIMENT_ARM must be one of ${EXPERIMENT_ARMS.join(", ")}`);
	return value as ExperimentArm;
}
