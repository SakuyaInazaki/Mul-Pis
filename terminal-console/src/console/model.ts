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
  warnings: string[];
}
