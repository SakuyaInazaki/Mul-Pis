import type { UsageSummary } from "../runner/types.ts";
import type { KnowledgeRef } from "../knowledge/types.ts";

/** These are proposed experimental objects, not a claim of L5 capability. */
export type ArtifactRef = Readonly<{ storeId: string; id: string; version: string }>;
export type { KnowledgeRef };
export type ExperimentKind = "mechanism-cost" | "executor-quality" | "meta-improvement";
export type MeasurementStatus = "measured" | "not-run" | "failed" | "pending" | "unknown";

/** The first H is a data-only prompt policy actually loaded into a Pi session. */
export interface ExecutorStrategyV1 {
	version: 1;
	kind: "cpu-numerical-prompt";
	body: string;
}

export interface BudgetLease {
	id: string;
	rootCampaignId: string;
	parentLeaseId?: string;
}

export interface BudgetLimits {
	maxProviderCalls: number;
	maxInputTokens: number;
	maxOutputTokens: number;
	/** Cap on Pi SDK price-table estimates, not a provider invoice. */
	maxSdkEstimatedCost: number;
	maxProbeCalls: number;
	maxCpuMillis: number;
	maxWallMillis: number;
}

export interface BudgetStatus {
	limits: BudgetLimits;
	/** Includes reservations for still-in-flight calls. */
	committed: { providerCalls: number; inputTokens: number; outputTokens: number; sdkEstimatedCost: number; probeCalls: number; cpuMillis: number };
	reserved: { inputTokens: number; outputTokens: number; sdkEstimatedCost: number };
	remaining: { providerCalls: number; inputTokens: number; outputTokens: number; sdkEstimatedCost: number; probeCalls: number; cpuMillis: number; wallMillis: number };
	settlement: "settled" | "pending-or-unknown" | "exceeded";
}

export interface PromptReservation {
	id: string;
	leaseId: string;
	maxInputTokens: number;
	maxOutputTokens: number;
	maxSdkEstimatedCost: number;
}

export interface ExperimentStart {
	id: string;
	caseId: string;
	environmentVersion: string;
	inputSnapshotId: string;
	seed: string;
}

export interface NumericObservation {
	x: number;
	y: number;
	xUnit: string;
	yUnit: string;
	source: "initial" | "probe";
}

export interface PublicHypothesis {
	id: string;
	/** Fixed data-only formula, never executable candidate code. */
	formula: { kind: "affine"; slope: number; intercept: number } | { kind: "quadratic"; coefficient: number; intercept: number };
}

export interface PublicTask {
	version: 1;
	caseId: string;
	objective: "identify-response-mechanism";
	hypotheses: PublicHypothesis[];
	initialObservations: NumericObservation[];
	allowedProbeX: number[];
	maxProbeCalls: number;
	/** No private world ID, oracle, or held-out outcome belongs here. */
	units: { x: string; y: string };
}

export type ScientificAction =
	| { kind: "probe"; actionId: string; x: number }
	| { kind: "submit"; actionId: string; hypothesisId: string; explanation?: string }
	| { kind: "stop"; actionId: string; reason: string };

export interface ExperimentLineage {
	/** Explicit caller references, checked by the controller before linking. */
	m07RunId?: string;
	m04RunId?: string;
	knowledgeRefs?: KnowledgeRef[];
}

/** Public development feedback. Hypotheses about causes are not environment facts. */
export interface DevelopmentFeedback {
	version: 1;
	id: string;
	startId: string;
	actionId: string;
	status: "observed" | "supported-by-observations" | "contradicted" | "underdetermined" | "invalid" | "resource-exhausted" | "timed-out" | "stopped";
	observations: NumericObservation[];
	remainingProbeCalls: number;
	checks: Array<{ name: string; status: MeasurementStatus; detail?: string }>;
	evidence: ArtifactRef[];
	lineage?: ExperimentLineage;
	/** Independent truth and hidden held-out checks are never serialized here. */
	visibility: "development";
}

export interface EnvironmentHealthReport {
	usable: boolean;
	checks: Array<{ name: "positive" | "negative" | "initially-plausible" | "ambiguous" | "discriminating-probe" | "unidentifiable-stop" | "premature-stop" | "reset" | "resource" | "invalid-action" | "timeout"; passed: boolean; applicability?: "not-applicable"; detail?: string }>;
}

export interface DevelopmentEnvironment {
	healthCheck(): Promise<EnvironmentHealthReport>;
	prepare(seed: string): Promise<ExperimentStart>;
	fork(start: ExperimentStart): Promise<ExperimentStart>;
	publicTask(start: ExperimentStart): PublicTask;
	runProbe(start: ExperimentStart, action: Extract<ScientificAction, { kind: "probe" }>, lease: BudgetLease): Promise<DevelopmentFeedback>;
	evaluateDevelopment(start: ExperimentStart, action: Extract<ScientificAction, { kind: "submit" }>, lease: BudgetLease): Promise<DevelopmentFeedback>;
	stop(start: ExperimentStart, action: Extract<ScientificAction, { kind: "stop" }>): Promise<DevelopmentFeedback>;
}

/** Only a trusted controller may hold this interface. Never pass it to a model session. */
export interface ProtectedEvaluator {
	evaluate(start: ExperimentStart, hypothesisId: string): Promise<{ status: "accepted" | "rejected" | "inconclusive"; evidence: ArtifactRef[] }>;
	evaluateStop(start: ExperimentStart): Promise<{ status: "justified-unknown" | "premature-stop" | "inconclusive"; quality: "partial" | "none"; evidence: ArtifactRef[] }>;
}

export interface ModelStepResult {
	action: ScientificAction;
	usage: UsageSummary;
	sessionId: string;
	usageSidecar?: string;
}
