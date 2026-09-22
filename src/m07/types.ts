import type { SessionRef } from "../runner/types.ts";
import type { BudgetPolicy } from "../improvement/policy.ts";

export type M07TaskMode = "execute" | "check" | "reason";
export type M07TaskStatus = "running" | "returned" | "failed" | "accepted" | "rejected";
export type CheckResult = "passed" | "failed" | "not_run";
export type GoalOutcome = "partial" | "blocked" | "fulfilled";
export type ReturnPath = "M04" | "M05" | "M06" | "M08" | "continue" | "user";

export interface BeginGoalInput {
	goal: string;
	problemRelation: string;
	constraints: string[];
	successCriteria: string[];
	plan: string;
	exploratory?: boolean;
}

export interface TaskSpecInput {
	objective: string;
	inputs: string[];
	expectedOutputs: string[];
	checks: string[];
	mode: M07TaskMode;
	parentTaskId?: string;
	supersedesTaskId?: string;
	requireIndependentCheck?: boolean;
	knowledgeIds?: string[];
}

export interface TaskCheck {
	criterion: string;
	result: CheckResult;
	evidence: string[];
}

export interface TaskReviewInput {
	taskId: string;
	checks: TaskCheck[];
	artifacts: string[];
	failures?: string[];
	unexecuted?: string[];
	limitations?: string[];
	/** Independent check task whose report and findings were actually considered. */
	independentCheck?: { taskId: string; report: string; disposition: string };
}

export interface DecisionInput {
	action: "request" | "resolve";
	question?: string;
	decision?: string;
	relatedTaskIds: string[];
}

export interface FinishInput {
	outcome: GoalOutcome;
	summary: string;
	returnPath: ReturnPath;
	limitations?: string[];
	goalChecks: TaskCheck[];
}

export interface InterruptInput {
	reason: string;
	returnPath?: ReturnPath;
}

export interface EvidenceFile {
	path: string;
	/** Original submitted path; `path` is the frozen review copy. */
	sourcePath?: string;
	mediaType: "text" | "binary";
	readCoverage: "recorded-not-reviewed" | "unread-binary";
}

export interface M07TaskRecord extends TaskSpecInput {
	taskId: string;
	status: M07TaskStatus;
	createdAt: string;
	returnedAt: string;
	workDir: string;
	inputCopies: Array<{ source: string; copy: string; mediaType: "text" | "binary" }>;
	expectedOutputPaths: string[];
	session?: SessionRef;
	reportPath?: string;
	readCoverage: string[];
	executionFailure?: string;
	toolLog: unknown[];
	knowledgeSnapshot?: string;
	m04BaselineRunId?: string;
	review?: {
		at: string;
		/** Frozen copy of this task's session report at review time. */
		frozenReportPath: string;
		checks: TaskCheck[];
		artifacts: EvidenceFile[];
		failures: string[];
		unexecuted: string[];
		limitations: string[];
		independentCheck?: { taskId: string; report: string; disposition: string };
	};
}

export interface UserDecision {
	id: string;
	status: "open" | "resolved";
	question: string;
	relatedTaskIds: string[];
	requestedAt: string;
	decision?: string;
	resolvedAt?: string;
}

export interface CurrentGoal {
	version: 1;
	runId: string;
	lifecycle: "active" | "finished";
	startedAt: string;
	updatedAt: string;
	goal: string;
	problemRelation: string;
	constraints: string[];
	successCriteria: string[];
	plan: string;
	exploratory: boolean;
	formalBaseline: boolean;
	problemSnapshotPath: string;
	knowledgeSnapshot?: string;
	m04BaselineRunId?: string;
	baselineHistory: Array<{ at: string; knowledgeSnapshot?: string; m04RunId: string }>;
	/** Frozen at begin; later promotion or rollback applies only to a new goal. Optional only for explicit legacy-record detection. */
	budgetPolicy?: BudgetPolicy;
	budgetPolicyVersionId?: string;
	budgetPolicyFrozenAt?: string;
	tasks: M07TaskRecord[];
	decisions: UserDecision[];
	outcome?: GoalOutcome;
	finishSummary?: string;
	returnPath?: ReturnPath;
	limitations: string[];
	goalChecks?: TaskCheck[];
	feedbackPath?: string;
}

export interface M07Controller {
	begin(input: BeginGoalInput): Promise<CurrentGoal>;
	status(runId: string): Promise<CurrentGoal>;
	plan(runId: string, plan: string, options?: { refreshBaseline?: boolean }): Promise<CurrentGoal>;
	delegate(runId: string, task: TaskSpecInput): Promise<M07TaskRecord>;
	review(runId: string, input: TaskReviewInput): Promise<M07TaskRecord>;
	decision(runId: string, input: DecisionInput): Promise<CurrentGoal>;
	finish(runId: string, input: FinishInput): Promise<CurrentGoal>;
	interrupt(runId: string, input: InterruptInput): Promise<CurrentGoal>;
}
