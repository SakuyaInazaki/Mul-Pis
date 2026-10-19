import type { SessionCheckpoint, SessionRef } from "../runner/types.ts";
import type { BudgetPolicy } from "../improvement/policy.ts";
import type { KnowledgeRef } from "../knowledge/types.ts";
import type { ExperienceSelection } from "../knowledge/experience-index.ts";
import type { ExperienceRequirementV1, M07WorkflowStrategyV1 } from "../improvement/generation.ts";
import type { RunDescriptorV1 } from "../runtime/run-descriptor.ts";
import type { KnowledgeRetrievalContext } from "../knowledge/retrieval.ts";
import type { CandidateComparisonV1, CandidatePerformanceEvidenceV1 } from "./candidate-diagnostics.ts";
import type { CandidatePolicyDecisionV1, CandidateSearchStateV1, CandidateStrategy } from "./candidate-policy.ts";
import type { PromptLayoutReceiptV1 } from "./prompt-layout.ts";
import type { OperatorCategory } from "./candidate-policy.ts";
import type { OptimizationMethod } from "../knowledge/optimization-card.ts";
import type { FrozenUnderstandingV1 } from "../understanding.ts";
import type { KnowledgeAccessEvent } from "./execution-knowledge.ts";

export type M07TaskMode = "execute" | "check" | "reason";
export type M07TaskStatus = "running" | "returned" | "failed" | "accepted" | "rejected" | "unknown";
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

/** Declared, never host-proven: where this work object is being implemented and
 * what is already known about its headroom. The harness records it so a
 * trajectory can answer "why this abstraction layer" and "why spend here"; the
 * numbers stay model or host declarations with their own stated source. */
export interface SubjectProfileV1 {
	/** Operator class, recorded so a trajectory says what kind of work this was.
	 * It carries no budget and no admission rule. */
	operatorCategory: OperatorCategory;
	implementationSpace: "vendor-library" | "dsl-or-ir" | "handwritten-low-level";
	/** Why this layer rather than the ones above or below it. */
	rationale: string;
	/** How strong the implementation being competed against already is. */
	baselineStrength: "vendor-library" | "framework-default" | "none";
	/** Share of end-to-end runtime, in [0, 1], when it has been measured. */
	endToEndShare?: number;
	/** Remaining headroom and where that estimate comes from. */
	headroom?: { kind: "roofline-ratio" | "sol-gap" | "measured-reference" | "unknown";
		value?: number; source: string };
}

export interface TaskSpecInput {
	objective: string;
	/** Actual object of this task's work; input materials do not change this identity. */
	subjectId?: string;
	/** Required for a candidate-producing execute task under a bound verifier. */
	subjectProfile?: SubjectProfileV1;
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
	/** Applicability hints for automatic knowledge roots; explicit references remain visible. */
	knowledgeContext?: KnowledgeRetrievalContext;
	/** An input path already listed in inputs, frozen for this task's execution. */
	planInput?: string;
	/** Explicit versioned external references, each already present in inputs. Never discovered globally. */
	resourceInputs?: Array<{ id: string; version: string; input: string }>;
	/** Explicit task execution mode: legacy fresh-reviewer repair or same-session candidate feedback. Continuous goals do not imply a mode. Legacy bounded fields map to opt-in until-ready. No process-restart replay. */
	/** Historical records may carry `{maxRounds, deadlineAt}`. Those numbers are
	 * decoded for audit and normalized away: nothing bounds a loop by count. */
	executionLoop?: { mode: "until-ready" | "candidate-episode" } | { maxRounds: number; deadlineAt: string };
	/** Expected JSON output carrying a candidate lesson to M04, never an adopted record. */
	lessonDeltaOutput?: string;
	/** Explicit competitive continuation from a frozen task leaf. Role remains execution. */
	context?: { mode: "fork"; parentRunId: string; parentTaskId: string; checkpointId: string };
	/** Optional candidate declaration; only a trusted host verifier judges its result. */
	candidate?: { sourcePaths: string[]; receiptPaths: string[];
		parentTaskId?: string; changeKind?: "repair" | "structure" | "parameters";
		intent?: "solution" | "diagnostic" };
}

/** Optional host-only task admission. Throw to reject before dispatch creates task files or starts a session. */
export type TaskAdmission = (input: { goal: Readonly<CurrentGoal>; task: Readonly<TaskSpecInput>; workspace: string }) => void | Promise<void>;

export interface CandidateVerificationBindingV1 {
	version: 1;
	id: string;
	verifierVersion: string;
	boundAt: string;
	/** Earlier tasks retain their original review semantics. */
	firstTaskIndex: number;
	/** Explicit host capability; receipt verification alone never grants whole-goal admission. */
	goalAdmission: boolean;
}

export interface CandidateMetricV1 {
	name: string;
	value: number;
	unit: string;
	basisId: string;
	direction: "higher" | "lower";
}

/** Verifier-read facts about an existing external evaluation. IDs and field paths
 * refer to original evidence; this record does not authorize another execution. */
export interface CandidateDiagnosticV1 {
	category: "compile" | "numerical" | "runtime" | "unknown";
	fieldPath: string;
	rawText: string;
	caseId?: string;
}

/** The host's own ruling on one candidate/baseline pair, at the noise scale it
 * measured. A search layer that re-derives "faster" from raw medians picks
 * candidates out of noise; these verdicts are the only admissible answer to
 * "is it actually faster", and they are facts, not negotiable opinions. */
export interface CandidatePerformanceVerdictV1 {
	/** Baseline denominator this verdict is about; a ratio never transfers to another. */
	baseline: string;
	tier?: string;
	verdict: "faster" | "slower" | "tie" | "quarantined";
	/** Paired candidate/baseline ratio median; below 1 means the candidate is faster. */
	pairedRatioMedian: number;
	/** Host threshold derived from the measured dispersion, not a fixed constant. */
	minimumImprovementThreshold: number;
	/** End-to-end admissibility, when the case was measured end to end. */
	endToEndAdmissible?: boolean;
	/** Whether an independent remeasurement agreed with the ruling. */
	confirmed?: boolean;
}

/** Host aggregate per baseline. Coverage and magnitude stay separate numbers,
 * ratios use geometric mean or median, and failures stay in the denominator. */
export interface CandidateAggregateV1 {
	baseline: string;
	declaredCases: number;
	decidableCases: number;
	fasterCases: number;
	successRate?: number;
	geometricMeanSpeedupAllDecidable?: number;
	medianSpeedupAllDecidable?: number;
	geometricMeanSpeedupFasterOnly?: number;
}

export interface CandidateCaseObservationV1 {
	caseId: string;
	status: string;
	correctness: "passed" | "failed" | "unknown";
	/** Kernel-level or end-to-end case, when the host distinguishes them. */
	scope?: "kernel" | "end-to-end";
	/** Diagnostic measurements only. Goal promotion uses top-level metrics. */
	metrics: CandidateMetricV1[];
	/** Platform references such as baselines or hardware bounds, never candidate gains. */
	referenceMeasurements?: Array<Pick<CandidateMetricV1, "name" | "value" | "unit" | "basisId">>;
	/** Optional profiler facts normalized by the host, with original receipt locations. */
	performance?: CandidatePerformanceEvidenceV1;
	/** False when the host refuses to rank on this case at all. */
	performanceDecidable?: boolean;
	performanceUndecidableReason?: string;
	/** Host rulings for this case; absent when the host issues none. */
	verdicts?: CandidatePerformanceVerdictV1[];
	/** Rank agreement across measurement rounds; unstable ordering is not a win. */
	orderingStability?: { kendallTauBMedian?: number; pairwiseFlipRate?: number };
}

export interface CandidateExternalEvaluationV1 {
	externalId: string;
	subjectId: string;
	status: string;
	terminal: boolean;
	capturedAt: string;
	/** Index into CandidateObservationV1.receiptFiles. */
	receiptIndex: number;
	cases: CandidateCaseObservationV1[];
	diagnostics: CandidateDiagnosticV1[];
	/** Host aggregates for this evaluation, never recomputed downstream. */
	aggregate?: CandidateAggregateV1[];
	/** Exact host reasons why no performance comparison is admissible. */
	measurementNotComparable?: string[];
}

export interface CandidateExecutionFactsV1 {
	evaluations: CandidateExternalEvaluationV1[];
}

export interface CandidateObservationV1 {
	version: 1;
	kind: "candidate-observation";
	verifier: { id: string; version: string };
	sourceBinding: "verified" | "unknown";
	correctness: "passed" | "failed" | "unknown";
	stage: string;
	checks: Array<{ criterion: string; result: CheckResult }>;
	/** Candidate-level observations only; fulfilled still requires separate verifyGoal. */
	goalChecks: Array<{ criterion: string; result: CheckResult }>;
	metrics: CandidateMetricV1[];
	/** Host-verified raw evaluation facts; absent for legacy or incapable verifiers. */
	executionFacts?: CandidateExecutionFactsV1;
	limitations: string[];
	sourceFiles: string[];
	receiptFiles: string[];
}

export interface M07EpisodeCandidateV1 {
	id: string;
	parentCandidateId?: string;
	/** Declared derivation from an exact candidate in this goal; not proof of causal reuse. */
	parentRef?: { taskId: string; candidateId: string };
	/** Exact source-byte matches in this goal; a planning fact, not an automatic rejection. */
	identicalSourceRefs?: string[];
	sourceRepetition?: "duplicate_code" | "code_cycle";
	sourcePaths: string[];
	receiptPaths: string[];
	hypothesis: string;
	/** Model-declared applicability and edit description; neither is a host-proven causal claim. */
	conditions?: string[];
	changeSummary?: string;
	/** Mechanical same-basis comparison with the declared parent; never an acceptance decision. */
	parentComparison?: CandidateComparisonV1;
	changeKind: "repair" | "structure" | "parameters";
	/** One enumerated optimization strategy and one exact edit site per candidate. */
	strategy?: CandidateStrategy;
	location?: string;
	/** Model-declared reason for repeating a banned direction; not a host fact. */
	newEvidence?: string;
	intent: "solution" | "diagnostic";
	observation: CandidateObservationV1;
	observationPath: string;
	/** Deterministic host judgement of this observation; never a model claim. */
	policy?: CandidatePolicyDecisionV1;
	/** What the host assembled for the round that followed this observation.
	 * Records the pairing of injected knowledge with the next result; selection
	 * is not adoption and a listed ref is not proof of reading. */
	injection?: { phase: string; status: "ready" | "snapshot-changed" | "unavailable";
		refs: string[]; chars: number };
}

export interface M07CandidateEpisodeV1 {
	version: 1;
	candidates: M07EpisodeCandidateV1[];
	/** Working copies of frozen same-goal candidates, never a new evaluation or adopted fact. */
	checkouts?: Array<{ candidateRef: string }>;
	/** The last evaluated candidate is the exploration point, whether successful or not. */
	currentCandidateId?: string;
	/** Readable, verified local best per subject and exact metric identity; historical rows may omit subjectId. */
	incumbents: Array<{ candidateId: string; metric: CandidateMetricV1; subjectId?: string }>;
	/** Deterministic stall, route and parent facts recomputed after each evaluation. */
	search?: CandidateSearchStateV1;
	/** The method menu the last round's evidence allowed. The next candidate is
	 * held to it: a strategy whose every method was masked is refused. */
	methodDecision?: { status: "table" | "default-menu";
		allowed: OptimizationMethod[];
		masked: Array<{ method: OptimizationMethod; reason: string; sourceRefs: string[] }> };
	/** Episode boundaries where the context was cleared and a distilled record
	 * carried forward. The complete transcript stays in the session log. */
	restarts?: Array<{ at: string; recordPath: string; afterCandidates: number; previousSessionId: string }>;
}

export interface M07BranchSourceV1 {
	version: 1;
	checkpoint: SessionCheckpoint;
	manifestPath: string;
	workSnapshotRoot: string;
	problemSnapshotCopy: string;
}

export interface M07BranchSelectionV1 {
	version: 1;
	parentTaskId: string;
	selectedTaskId?: string;
	rationale: string;
	selectedAt: string;
	/** Compact controller facts only; complete failures, paths and evidence remain on tasks. */
	candidates: Array<{ taskId: string; status: M07TaskStatus; checks: Array<{ criterion: string; result: CheckResult }> }>;
}

export interface M07ExecutionRound {
	index: number;
	operationId: string;
	/** New round records state the real boundary; optional when reading legacy logs. */
	builderContext?: { mode: "fresh" | "continue" | "fork"; reason: string };
	builderReportPath: string;
	/** Observed bytes in the complete formal-work reviewer snapshot. */
	reviewerSnapshotBytes?: number;
	reviewerSnapshotPath?: string;
	/** Host-created report segments, excluded from candidate-output comparison. */
	builderReportHandoffDir?: string;
	reviewerReportPath?: string;
	reviewerSession?: SessionRef;
	verdict?: "ready" | "revise" | "replan" | "blocked";
	feedback?: string;
	completedAt: string;
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

export interface M07OperationV1 {
	version: 1;
	id: string;
	taskId: string;
	/** Historical partial-settled receipts remain readable; new execution does not
	 * create a monetary or call-count local refusal. */
	status: "prepared" | "issued" | "response-received" | "partial-settled" |
		"terminal-response-incomplete" | "unknown" | "confirmed" | "not-issued";
	issuedAt: string;
	resolvedAt?: string;
	evidencePath?: string;
	externalId?: string;
	observationMethod?: "external-query" | "local-tool-log" | "host-local-admission-rejection" |
		"host-terminal-response" | "host-request-contract-preflight";
}

export interface M07AttemptV1 {
	version: 1;
	id: string;
	state: "running" | "suspended" | "recovery-required" | "terminated";
	startedAt: string;
	endedAt?: string;
	runDescriptor: RunDescriptorV1;
	stopReceipt?: HostStopReceipt;
	controlCheckpointPath?: string;
}

export interface M07ExecutionStateV1 {
	version: 1;
	activeAttemptId: string;
	attempts: M07AttemptV1[];
	operations: M07OperationV1[];
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
	/** How this task's prompt was laid out and how deep its history went. */
	promptLayout?: PromptLayoutReceiptV1;
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
	executionRounds?: M07ExecutionRound[];
	loopStopReason?: "ready" | "max-rounds" | "deadline" | "budget-boundary" | "provider-call-limit" |
		"output-limit" | "replan" | "blocked" | "reviewer-invalid" | "request-contract-invalid";
	/** Available only after a stable task completed and its evidence was frozen. */
	branchSource?: M07BranchSourceV1;
	branchUnavailableReason?: string;
	/** Result of a host-only read of frozen source and original platform receipts. */
	candidateObservation?: CandidateObservationV1 & { observationPath: string };
	episode?: M07CandidateEpisodeV1;
	/** Per-call read-only knowledge access, frozen into review evidence. */
	knowledgeAccess?: KnowledgeAccessEvent[];
	planCopy?: string;
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

/** Failed judgments stay negative history; their drafts confer no knowledge authority. */
export interface M04BaselineFailure {
	runId: string;
	transactionState: "no-proposal" | "rejected-draft";
	failures: string[];
	remarks: string[];
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
	/** Host-supplied additions; earlier task and checkpoint snapshots remain unchanged. */
	constraintAdditions?: Array<{ sourceEventId: string; constraints: string[]; recordedAt: string }>;
	successCriteria: string[];
	plan: string;
	exploratory: boolean;
	formalBaseline: boolean;
	problemSnapshotPath: string;
	/** Frozen M01 understanding, with M03's challenge when one exists. Every task
	 * prompt under this goal carries the same bytes near its front. */
	understanding?: FrozenUnderstandingV1;
	knowledgeSnapshot?: string;
	m04BaselineRunId?: string;
	/** Explicitly acknowledged failed suffix, frozen even for an exploratory goal. */
	m04BaselineFailures?: M04BaselineFailure[];
	/** Host-selected original material scope; legacy goals retain workspace raw inputs. */
	checkpointRawScope?: "workspace" | "none";
	/** Optional host-only verifier binding; absent for ordinary and historical goals. */
	candidateVerification?: CandidateVerificationBindingV1;
	baselineHistory: Array<{ at: string; knowledgeSnapshot?: string; m04RunId: string;
		failedM04?: M04BaselineFailure[] }>;
	/** Frozen at begin; later promotion or rollback applies only to a new goal. Optional only for explicit legacy-record detection. */
	budgetPolicy?: BudgetPolicy;
	budgetPolicyVersionId?: string;
	budgetPolicyFrozenAt?: string;
	/** Explicit method identity loaded when this goal began; later pointer changes do not rewrite it. */
	methodBinding?: { versionId: string; contentId?: string };
	/** Host-frozen execution contract; absent on legacy/bounded goals. The model cannot opt out through goal parameters. */
	executionContract?: { version: 1; mode: "continuous"; frozenAt: string };
	/** New goals only. Old goal records keep their original archival semantics. */
	executionState?: M07ExecutionStateV1;
	predecessorGoalRunId?: string;
	/** Controller-created stop event; free-text model claims and tool stdout never populate this. */
	hostStopReceipt?: HostStopReceipt;
	/** Registered only after its frozen files and bounded feedback are durable. */
	checkpoints?: M07CheckpointRecord[];
	/** Frozen checkpoint snapshot only; omitted task evidence remains in the live goal, outside M04's read grant. */
	checkpointScope?: { selectedTaskIds: string[]; omittedTaskIds: string[] };
	branchSelections?: M07BranchSelectionV1[];
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
	begin(input: BeginGoalInput, options?: { executionContract?: "continuous";
		checkpointRawScope?: "workspace" | "none";
		candidateVerification?: { id: string; verifierVersion: string; goalAdmission?: boolean } }): Promise<CurrentGoal>;
	status(runId: string): Promise<CurrentGoal>;
	/** Trusted host only; never exposed through the model-facing research_goal tool. */
	hostAddConstraints(runId: string, input: { sourceEventId: string; constraints: string[] }): Promise<CurrentGoal>;
	/** Trusted host only. Binding never reinterprets existing tasks. */
	hostBindCandidateVerifier(runId: string, options?: { goalAdmission?: boolean }): Promise<CurrentGoal>;
	plan(runId: string, plan: string, options?: { refreshBaseline?: boolean; checkpointId?: string; m04RunId?: string }): Promise<CurrentGoal>;
	checkpoint(runId: string, options?: { taskIds?: string[] }): Promise<M07CheckpointRecord>;
	/** Called after the task and prepared operation are saved, before any runner session starts. */
	delegate(runId: string, task: TaskSpecInput,
		afterPrepared?: (runId: string, taskId: string) => Promise<void>): Promise<M07TaskRecord>;
	/** Select among reviewed candidates. No selection is a valid partial/blocked outcome. */
	selectBranch(runId: string, input: { parentTaskId: string; selectedTaskId?: string; rationale: string }): Promise<CurrentGoal>;
	review(runId: string, input: TaskReviewInput): Promise<M07TaskRecord>;
	decision(runId: string, input: DecisionInput): Promise<CurrentGoal>;
	finish(runId: string, input: FinishInput): Promise<CurrentGoal>;
	interrupt(runId: string, input: InterruptInput): Promise<CurrentGoal>;
	/** Trusted host lifecycle path, not exposed as a model tool. */
	hostInterrupt(runId: string, input: { reasonKind: HostStopReasonKind; sourceEventId?: string }): Promise<CurrentGoal>;
	/** Trusted control surface only; model-facing research_goal never exposes these. */
	hostSuspend(runId: string, input: { reasonKind: HostStopReasonKind; sourceEventId?: string }): Promise<CurrentGoal>;
	hostRecover(runId: string, input: { expectedAttemptId: string; runDescriptor: RunDescriptorV1 }): Promise<CurrentGoal>;
	hostReconcileOperation(runId: string, input: { operationId: string; evidencePath: string }): Promise<CurrentGoal>;
	hostCreateSuccessor(runId: string, input: { runDescriptor: RunDescriptorV1 }): Promise<CurrentGoal>;
}
