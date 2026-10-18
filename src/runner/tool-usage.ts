/**
 * Tool-call accounting.
 *
 * A tool surface is only as good as what it is actually used for, and the shape
 * of that use is cheap to measure and otherwise invisible: how many calls each
 * tool receives, how often a call fails and whose failure it was, and whether a
 * code change is followed by an actual evaluation or by more editing. The last
 * one is the signal the evidence is clearest about — a run that edits for a long
 * time without measuring is not searching, it is guessing.
 */
import type { FailureClass } from "./failure-class.ts";
import type { ToolCallRecord } from "./types.ts";

export interface ToolUsageEntryV1 {
	name: string;
	calls: number;
	failures: number;
	failureClasses: Partial<Record<FailureClass, number>>;
}

export interface ToolUsageSummaryV1 {
	version: 1;
	calls: number;
	distinctTools: number;
	tools: ToolUsageEntryV1[];
	/** Calls that changed files in the work directory. */
	mutations: number;
	/** Mutations followed by an evaluation call before the next mutation. */
	mutationsEvaluated: number;
	/** Evaluation calls of any kind. */
	evaluations: number;
	failures: Partial<Record<FailureClass, number>>;
}

const MUTATING = new Set(["write", "edit", "multi_edit", "apply_patch"]);
/** Host tools that actually run or verify a candidate, by prefix. */
const EVALUATION_PREFIX = "candidate_";
const EVALUATION_EXACT = new Set(["candidate_run", "candidate_sweep", "candidate_evaluate"]);

function isEvaluation(name: string): boolean {
	return EVALUATION_EXACT.has(name) || (name.startsWith(EVALUATION_PREFIX) && !name.startsWith("candidate_list") &&
		!name.startsWith("candidate_read") && !name.startsWith("candidate_checkout"));
}

export function summarizeToolCalls(records: readonly ToolCallRecord[]): ToolUsageSummaryV1 {
	const tools = new Map<string, ToolUsageEntryV1>();
	const failures: Partial<Record<FailureClass, number>> = {};
	let mutations = 0;
	let mutationsEvaluated = 0;
	let evaluations = 0;
	let pendingMutation = false;
	for (const record of records) {
		const entry = tools.get(record.name) ?? { name: record.name, calls: 0, failures: 0, failureClasses: {} };
		entry.calls++;
		if (!record.ok) {
			entry.failures++;
			if (record.failureClass) {
				entry.failureClasses[record.failureClass] = (entry.failureClasses[record.failureClass] ?? 0) + 1;
				failures[record.failureClass] = (failures[record.failureClass] ?? 0) + 1;
			}
		}
		tools.set(record.name, entry);
		if (MUTATING.has(record.name) && record.ok) {
			mutations++;
			pendingMutation = true;
		} else if (isEvaluation(record.name)) {
			evaluations++;
			if (pendingMutation) { mutationsEvaluated++; pendingMutation = false; }
		}
	}
	return {
		version: 1, calls: records.length, distinctTools: tools.size,
		tools: [...tools.values()].sort((left, right) => right.calls - left.calls || left.name.localeCompare(right.name)),
		mutations, mutationsEvaluated, evaluations, failures,
	};
}
