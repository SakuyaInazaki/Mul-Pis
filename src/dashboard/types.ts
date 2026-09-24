export type DashboardActivity = "active" | "idle" | "ended" | "unknown";
export type DashboardDisplayGroup = "active" | "idle" | "archived" | "unknown";
export type DashboardStatus = "active" | "idle" | "archived" | "unknown" | "completed" | "failed" | "warning";

export interface DashboardNode {
	id: string;
	kind: "controller" | "stage" | "agent";
	label: string;
	stage?: string;
	runId?: string;
	model?: string;
	role?: string;
	status: DashboardStatus;
	activity: DashboardActivity;
	displayGroup: DashboardDisplayGroup;
	lastSeenAt?: string;
	startedAt?: string;
	endedAt?: string;
	tools?: string[];
	failureCount?: number;
	outcome?: "completed" | "failed" | "aborted";
	/** M07 control state is independent of the persisted run status. */
	attemptId?: string;
	attemptState?: "running" | "suspended" | "recovery-required" | "terminated" | "legacy-untracked";
	unresolvedOperationIds?: string[];
	unresolvedTaskIds?: string[];
}

export interface DashboardEdge {
	id: string;
	source: string;
	target: string;
	relation: "membership" | "parent-task" | "supersedes" | "stage-navigation";
}

export interface DashboardState {
	schemaVersion: 1;
	generatedAt: string;
	workspace: { id: string; label: string; initialized: boolean };
	nodes: DashboardNode[];
	edges: DashboardEdge[];
	limitations: string[];
}

export interface DashboardWorkspaceSummary {
	id: string;
	label: string;
	initialized: boolean;
}
