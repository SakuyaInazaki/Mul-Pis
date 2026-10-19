export type ConsoleStatus = "pending" | "running" | "waiting" | "suspended" | "stale" | "returned" | "accepted" | "rejected" | "failed" | "unknown" | "completed" | "blocked";
export type ConsoleNodeKind = "stage" | "mission" | "assessment" | "run" | "attempt" | "group" | "barrier" | "task" | "candidate" | "execution" | "round" | "evaluation" | "review" | "checkpoint" | "session" | "tool";

export interface ConsoleRef { label: string; path: string; }
export interface WorkflowNode {
  id: string;
  parentId?: string;
  label: string;
  kind: ConsoleNodeKind;
  status: ConsoleStatus;
  stage?: string;
  runId?: string;
  taskId?: string;
	missionId?: string;
  sessionId?: string;
  model?: string;
  usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number; complete: boolean; costComplete: boolean; reportedEvents: number; unknownEvents: number };
  detail: string[];
  startedAt?: string;
  endedAt?: string;
  lastSeenAt?: string;
  outputRefs: ConsoleRef[];
  artifactRefs: ConsoleRef[];
  checks: Array<{ criterion: string; result: string; evidence: string[] }>;
}
export interface WorkflowEvent { at: string; summary: string; nodeId?: string; }
export interface WorkflowRunSummary { stage: string; runId: string; status: ConsoleStatus; startedAt: string; finishedAt?: string; sessions: number; outputs: number; knowledgeSnapshot?: string; }
export interface WorkflowGoalSummary {
  id: string; title: string; lifecycle: string; outcome?: string; attemptId?: string; attemptState?: string; currentTaskId?: string;
  formalBaseline?: boolean; m04BaselineRunId?: string; knowledgeSnapshot?: string;
  baselineHistory?: Array<{ at: string; m04RunId: string; knowledgeSnapshot?: string }>;
  checkpoints?: Array<{ id: string; createdAt: string; feedbackStatus: "complete" | "indexed"; selectedTaskIds?: string[]; omittedTaskIds?: string[] }>;
  openDecisions: number; returnPath?: string;
  checks: { total: number; passed: number; failed: number; notRun: number };
  tasks: { total: number; running: number; returned: number; accepted: number; rejected: number; failed: number; unknown: number };
  feedbackStatus?: string; stateRefs: ConsoleRef[];
}
/** Deterministic rollup of verdicts, failure accounting and budget. Counts only;
 * it never states that a candidate is good, correct for the goal, or faster. */
export interface WorkflowAuditV1 {
	version: 1;
	generatedAt: string;
	tasks: { total: number; running: number; returned: number; accepted: number; rejected: number; failed: number; unknown: number };
	/** Which verification gate each frozen candidate observation stopped at. */
	gates: Array<{ gate: string; count: number }>;
	/** Agent-declared candidates against what the host verifier actually found. */
	selfAccepted: { declaredByAgent: number; hostPassed: number; hostRefused: number; hostUnjudged: number; controllerRejected: number };
	judgement: { candidates: number; verifiedPassed: number; verifiedFailed: number; unjudged: number };
	failures: { infrastructure: number; policy: number; unclassified: number };
	/** Runner-classified failures, read back from the durable records rather than
	 * reclassified here: tool calls carry their class in the task tool log, and
	 * assessor transport observations carry theirs in the run outputs. */
	classifiedFailures: {
		tools: { infrastructure: number; policy: number; unjudged: number; unrecorded: number };
		transport: { infrastructure: number; policy: number; unjudged: number; unrecorded: number };
		/** Share of classified outcomes nobody could judge; a harness health signal. */
		unjudgedShare: number | null;
		reasons: Array<{ reason: string; count: number }>;
		truncated: boolean;
	};
	/** Deterministic host judgements recorded on each frozen candidate. */
	policy: {
		guards: Array<{ guard: string; count: number }>;
		statuses: Array<{ status: string; count: number }>;
		branches: Array<{ branch: string; count: number }>;
		lanes: Array<{ lane: string; count: number }>;
		phases: Array<{ phase: string; count: number }>;
		/** Candidates that moved the best-so-far pointer. */
		updatesBest: number;
		scored: number;
		scoreMedian: number | null;
		scoreMax: number | null;
		/** Candidates carrying no host policy decision at all. */
		undecided: number;
	};
	/** Per-task search state, recomputed by the search layer after each evaluation. */
	search: {
		tasks: number;
		maxStagnation: number;
		forcedDirectionChanges: number;
		routes: Array<{ route: string; count: number }>;
		signals: Array<{ signal: string; count: number }>;
		bannedDirections: number;
	};
	budget: { sessions: number; input: number; output: number; cacheRead: number; cacheWrite: number; cost: number; usageComplete: boolean; costComplete: boolean; unknownEvents: number };
	profile: {
		changeKinds: Array<{ changeKind: string; count: number }>;
		intents: Array<{ intent: string; count: number }>;
		profilerEvidence: Array<{ evidence: string; count: number }>;
		/** Candidates per host-verified pass; null when nothing has passed yet. */
		candidatesPerVerifiedPass: number | null;
		candidatesPerMillionTokens: number | null;
	};
	notes: string[];
}
export interface WorkflowSnapshot {
  workspace: { root: string; label: string };
  generatedAt: string;
  currentStage?: string;
  currentRunId?: string;
  selected?: { stage: string; runId: string };
  nodes: WorkflowNode[];
  events: WorkflowEvent[];
  runs: WorkflowRunSummary[];
  goal?: WorkflowGoalSummary;
  knowledge: { current?: string; frozen?: string };
  audit: WorkflowAuditV1;
  warnings: string[];
}
