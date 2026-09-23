import type { BudgetPolicy } from "./policy.ts";

/** Anonymous, materialized M07 projection call. Delivery status is tracked separately. */
export interface AnonymousRunSample {
	eventId: string;
	purpose: "task-message" | "feedback";
	policyVersionId: string;
	deliveryStatus: "not-submitted" | "submitted" | "assembled-for-m04";
	inputChars: number;
	inputFileChars: number[];
	inputUtf8Bytes: number;
	observedInlineChars: number;
	failureClasses: string[];
}

export interface ImprovementProtocol {
	version: 2;
	objective: "reduce-observed-inline-payload";
	minimumReductionRatio: number;
	maximumNewDeferredRatio: number;
	minimumInlineCoverageRatio: number;
	requireManifestCoverage: true;
	allowedCandidate: "budget-policy-only";
	baselinePolicy: BudgetPolicy;
	/** Only materialized, replayable M07 projection events enter this array. */
	samples: AnonymousRunSample[];
	unreplayableEvents: number;
	legacyRunsWithoutEvents: number;
	createdAt: string;
}

export interface PolicyReplayResult {
	policy: BudgetPolicy;
	observedSamples: number;
	observedFiles: number;
	totalObservedInputChars: number;
	totalInlineChars: number;
	totalDeferredChars: number;
	maxInlineChars: number;
	manifestedSamples: number;
	manifestedFiles: number;
}

export interface ImprovementEvaluation {
	/** Projection-screen result only. It is never admission evidence. */
	passed: boolean;
	status: "screened" | "rejected" | "insufficient-evidence";
	baseline: PolicyReplayResult;
	candidate: PolicyReplayResult;
	reductionRatio: number;
	gates: Array<{ name: string; passed: boolean; detail: string }>;
}

export interface ImprovementHypothesis {
	mechanism: string;
	prediction: string;
	falsifier: string;
	applicability: string;
	origin: "improver" | "human-seed";
}

export interface CampaignPlan {
	version: 1;
	maxCandidates: number;
	maxTrialCalls: number;
	repetitions: number;
	maxReadbackChars: number;
	maxTotalInputTokens: number;
	maxTotalOutputTokens: number;
	maxTotalCost: number;
	timeoutMs: number;
	caseSetPath?: string;
}

export interface ImprovementAttempt {
	index: number;
	hypothesis?: ImprovementHypothesis;
	candidatePath?: string;
	evaluationPath?: string;
	admissionPath?: string;
	status: "proposing" | "screened" | "rejected" | "inconclusive" | "promoted" | "failed";
	reason?: string;
	historyConsumed: string[];
}

export type ImprovementRunStatus = "proposing" | "candidate-ready" | "screened" | "inconclusive" | "promoted" | "rejected" | "failed";
export interface ImprovementRun {
	version: 2;
	runId: string;
	status: ImprovementRunStatus;
	startedAt: string;
	finishedAt?: string;
	baselineVersionId: string;
	modelConfig?: { improver: string; research: string };
	protocolPath: string;
	baselinePath: string;
	planPath?: string;
	caseSetSnapshotPath?: string;
	candidatePath?: string;
	evaluationPath?: string;
	admissionPath?: string;
	promotionReceiptPath?: string;
	rejectionReason?: string;
	attempts: ImprovementAttempt[];
	stopReason?: string;
	campaignUsage?: { input: number; output: number; cost: number; complete: boolean; usageSettlement: "settled" | "pending-or-unknown"; proposerCalls: number; trialCalls: number; inFlightBudgetMayExceed: true };
	session?: { id: string; label: string; model: string; file?: string; usageSidecar?: string };
}

export interface ImprovementRunResult { run: ImprovementRun; evaluation?: ImprovementEvaluation; activeVersionId?: string }
export interface ImprovementStatus { activeVersionId?: string; activeProvenance?: "local-mechanism-admission" | "legacy-projection-only" | "external-manual-unverified"; previousVersionId?: string; runs: Array<{ runId: string; status: ImprovementRunStatus; startedAt: string; finishedAt?: string }> }
