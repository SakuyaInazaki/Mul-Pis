/** Control-only receipts for ineffective model repairs. Raw model responses,
 * evidence paths and proposal bodies remain in the private workspace.
 */
import { createHash } from "node:crypto";
import { HarnessError } from "../types.ts";

export type WorkflowRepairStage = "objective-assessment" | "m04-judgment";
export type WorkflowRepairFailure =
	"unread-evidence" | "invalid-assessment" | "blocked-with-capability" |
	"unsupported-next-task" | "unread-m07-evidence" | "malformed-proposal" |
	"unavailable-task-source" |
	"rejected-draft" | "context-handoff-unavailable" | "provider-context-full";
export type WorkflowRepairStrategy = "same-session-feedback" | "fresh-context" |
	"workflow-repair-needed";

export type WorkflowRepairStateV1 = Readonly<{
	version: 1;
	kind: "workflow-repair-state";
	stage: WorkflowRepairStage;
	failure: WorkflowRepairFailure;
	evidenceFingerprint: string;
	planFingerprint: string;
	responseFingerprint: string | null;
	strategy: WorkflowRepairStrategy;
	sessionGeneration: number;
}>;
const stages: readonly WorkflowRepairStage[] = ["objective-assessment", "m04-judgment"];
const failures: readonly WorkflowRepairFailure[] = ["unread-evidence", "invalid-assessment",
	"blocked-with-capability", "unsupported-next-task", "unread-m07-evidence",
	"unavailable-task-source",
	"malformed-proposal", "rejected-draft", "context-handoff-unavailable", "provider-context-full"];
const strategies: readonly WorkflowRepairStrategy[] = ["same-session-feedback", "fresh-context",
	"workflow-repair-needed"];
const digest = /^[0-9a-f]{64}$/;

export function validWorkflowRepairState(value: unknown): value is WorkflowRepairStateV1 {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const row = value as Record<string, unknown>;
	return Object.keys(row).sort().join("|") === ["version", "kind", "stage", "failure",
		"evidenceFingerprint", "planFingerprint", "responseFingerprint", "strategy",
		"sessionGeneration"].sort().join("|") &&
		row.version === 1 && row.kind === "workflow-repair-state" &&
		stages.includes(row.stage as WorkflowRepairStage) &&
		failures.includes(row.failure as WorkflowRepairFailure) &&
		strategies.includes(row.strategy as WorkflowRepairStrategy) &&
		typeof row.evidenceFingerprint === "string" && digest.test(row.evidenceFingerprint) &&
		typeof row.planFingerprint === "string" && digest.test(row.planFingerprint) &&
		(row.responseFingerprint === null ||
			typeof row.responseFingerprint === "string" && digest.test(row.responseFingerprint)) &&
		Number.isSafeInteger(row.sessionGeneration) && Number(row.sessionGeneration) >= 1;
}

/** Fingerprints are private comparison aids, never scientific or read proof. */
export function workflowRepairFingerprint(value: unknown): string {
	const json = JSON.stringify(value);
	if (typeof json !== "string") throw new HarnessError("runner.workflow-repair", "repair fingerprint input is invalid");
	return createHash("sha256").update(json).digest("hex");
}

export function workflowRepairState(input: Omit<WorkflowRepairStateV1, "version" | "kind">):
	WorkflowRepairStateV1 {
	const result: WorkflowRepairStateV1 = { version: 1, kind: "workflow-repair-state", ...input };
	if (!validWorkflowRepairState(result))
		throw new HarnessError("runner.workflow-repair", "repair state is invalid");
	return result;
}

export class WorkflowRepairNeededError extends HarnessError {
	readonly stage: WorkflowRepairStage;
	readonly cause?: unknown;
	constructor(stage: WorkflowRepairStage, cause?: unknown) {
		super("runner.workflow-repair-needed", "verified repair strategy made no progress; stage remains open");
		this.stage = stage;
		if (cause !== undefined) this.cause = cause;
	}
}
