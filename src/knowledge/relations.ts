import type { Ref } from "./types.ts";

/** A local or temporary assumption belongs to an argument, not to the
 * project's adopted facts. Legacy premise refs without a role remain inputs. */
export function isNecessaryPremise(ref: Ref): boolean {
	return ref.rel === "premise_of" && ref.inputRole !== "local_assumption" && ref.inputRole !== "temporary_assumption";
}
