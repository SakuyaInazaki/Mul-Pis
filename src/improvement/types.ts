import type { BudgetPolicy } from "./policy.ts";

export interface AnonymousRunSample {
	stage: string;
	status: "completed" | "failed" | "running";
	inputChars: number;
	inputFileChars: number[];
	outputChars: number;
	failureClasses: string[];
}

export interface ImprovementProtocol {
	version: 1;
	objective: "reduce-observed-inline-payload";
	minimumReductionRatio: number;
	maximumNewDeferredRatio: number;
	minimumInlineCoverageRatio: number;
	requireManifestCoverage: true;
	allowedCandidate: "budget-policy-only";
	baselinePolicy: BudgetPolicy;
	samples: AnonymousRunSample[];
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
	passed: boolean;
	baseline: PolicyReplayResult;
	candidate: PolicyReplayResult;
	reductionRatio: number;
	gates: Array<{ name: string; passed: boolean; detail: string }>;
}

export type ImprovementRunStatus = "proposing" | "candidate-ready" | "promoted" | "rejected" | "failed";
export interface ImprovementRun {
	version: 1;
	runId: string;
	status: ImprovementRunStatus;
	startedAt: string;
	finishedAt?: string;
	baselineVersionId: string;
	protocolPath: string;
	baselinePath: string;
	candidatePath?: string;
	evaluationPath?: string;
	promotionReceiptPath?: string;
	rejectionReason?: string;
	session?: { id: string; label: string; model: string; file?: string };
}

export interface ImprovementRunResult { run: ImprovementRun; evaluation?: ImprovementEvaluation; activeVersionId?: string }
export interface ImprovementStatus { activeVersionId?: string; previousVersionId?: string; runs: Array<{ runId: string; status: ImprovementRunStatus; startedAt: string; finishedAt?: string }> }
