import type { SessionRef } from "../runner/types.ts";
import type { BudgetPolicy } from "../improvement/policy.ts";
import type { KnowledgeRef } from "../knowledge/types.ts";
import type { ExperienceSelection } from "../knowledge/experience-index.ts";
import type { ExperienceRequirementV1, M07WorkflowStrategyV1 } from "../improvement/generation.ts";

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
	/** Explicitly bind the active workflow H; CPU executor methods are not accepted. */
	workflowMethodVersionId?: string;
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
	/** Explicit, pinned method experience references; never auto-loaded in M01/M06. */
	experienceRefs?: KnowledgeRef[];
	experienceContextRefs?: KnowledgeRef[];
	experienceTags?: string[];
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

export type HostStopReasonKind = "request-aborted" | "provider-error" | "session-shutdown" | "no-progress";

export interface HostStopReceipt {
	version: 1;
	id: string;
	goalRunId: string;
	source: "pi-host";
	reasonKind: HostStopReasonKind;
	observedAt: string;
	sourceEventId?: string;
}

export interface M07CheckpointRecord {
	id: string;
	createdAt: string;
	rootDir: string;
	goalSnapshotPath: string;
	feedbackPath: string;
	manifestPath: string;
	feedbackStatus: "complete" | "indexed";
	sourceGoalUpdatedAt: string;
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
	/** Selection is not proof of faithful use or causal benefit. */
	experienceSelection?: ExperienceSelection & { loadedAt?: string; invocationStatus: "unknown"; faithfulUse: "unknown"; causalBenefit: "unknown" };
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
	/** Explicit method identity loaded when this goal began; later pointer changes do not rewrite it. */
	methodBinding?: { versionId: string; contentId?: string };
	/** Host-frozen execution contract; absent on legacy/bounded goals. The model cannot opt out through goal parameters. */
	executionContract?: { version: 1; mode: "continuous"; frozenAt: string };
	/** Controller-created stop event; free-text model claims and tool stdout never populate this. */
	hostStopReceipt?: HostStopReceipt;
	/** Registered only after its frozen files and bounded feedback are durable. */
	checkpoints?: M07CheckpointRecord[];
	/** Frozen checkpoint snapshot only; omitted task evidence remains in the live goal, outside M04's read grant. */
	checkpointScope?: { selectedTaskIds: string[]; omittedTaskIds: string[] };
	/** Controller-frozen method body. Later pointer changes never hot-replace it. */
	workflowMethod?: { versionId: string; artifact: M07WorkflowStrategyV1; requiredExperienceRefs: ExperienceRequirementV1[]; requiredKnowledgeRefs: KnowledgeRef[] };
	tasks: M07TaskRecord[];
	decisions: UserDecision[];
	outcome?: GoalOutcome;
	finishSummary?: string;
	returnPath?: ReturnPath;
	limitations: string[];
	goalChecks?: TaskCheck[];
	feedbackPath?: string;
	/** Interrupt archival handoff state. A control-facts-only file is not a complete M04 feedback package. */
	feedbackStatus?: "pending" | "complete" | "indexed" | "control-facts-only" | "failed";
	feedbackError?: { code: string; summary: string };
}

export interface M07Controller {
	begin(input: BeginGoalInput, options?: { executionContract?: "continuous" }): Promise<CurrentGoal>;
	status(runId: string): Promise<CurrentGoal>;
	plan(runId: string, plan: string, options?: { refreshBaseline?: boolean; checkpointId?: string; m04RunId?: string }): Promise<CurrentGoal>;
	checkpoint(runId: string, options?: { taskIds?: string[] }): Promise<M07CheckpointRecord>;
	delegate(runId: string, task: TaskSpecInput): Promise<M07TaskRecord>;
	review(runId: string, input: TaskReviewInput): Promise<M07TaskRecord>;
	decision(runId: string, input: DecisionInput): Promise<CurrentGoal>;
	finish(runId: string, input: FinishInput): Promise<CurrentGoal>;
	interrupt(runId: string, input: InterruptInput): Promise<CurrentGoal>;
	/** Trusted host lifecycle path, not exposed as a model tool. */
	hostInterrupt(runId: string, input: { reasonKind: HostStopReasonKind; sourceEventId?: string }): Promise<CurrentGoal>;
}
