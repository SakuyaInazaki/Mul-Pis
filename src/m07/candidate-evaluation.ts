/** A trusted host may only inspect an already returned candidate and its original
 * platform receipts. This interface does not submit, compile, or rerun work. */
import { HarnessError } from "../types.ts";
import { validCandidatePerformanceEvidence } from "./candidate-diagnostics.ts";
import type { CandidateExecutionFactsV1, CandidateMetricV1, CandidateObservationV1, CheckResult, CurrentGoal, M07TaskRecord, TaskCheck } from "./types.ts";

export interface FrozenCandidateFile {
	readonly declaredPath: string;
	readonly originalPath: string;
	readonly frozenPath: string;
}

export interface CandidateVerifier {
	readonly id: string;
	readonly version: string;
	verifyTask(input: Readonly<{ goal: CurrentGoal; task: M07TaskRecord;
		sources: readonly FrozenCandidateFile[];
		receipts: readonly FrozenCandidateFile[] }>): Promise<Readonly<{
		sourceBinding: "verified" | "unknown";
		correctness: "passed" | "failed" | "unknown";
		stage: string;
		/** Only the task criteria the host can objectively decide; other checks remain the reviewer's. */
		checks?: readonly Readonly<{ criterion: string; result: CheckResult }>[];
		/** Optional candidate-local findings; omitted criteria are explicitly not_run. */
		goalChecks?: readonly Readonly<{ criterion: string; result: CheckResult }>[];
		metrics: readonly Readonly<CandidateMetricV1>[];
		/** Existing external evaluation facts independently read by this trusted host. */
		executionFacts?: CandidateExecutionFactsV1;
		limitations: readonly string[];
	}>>;
	/** Independently assess objective original criteria against accepted, frozen evidence.
	 * Returned criteria override caller assertions; goalAdmission requires all criteria. */
	verifyGoal?(input: Readonly<{ goal: CurrentGoal; acceptedEvidencePaths: readonly string[] }>):
		Promise<Readonly<{ checks: readonly Readonly<TaskCheck>[]; limitations: readonly string[] }>>;
}

const safeId = /^[A-Za-z][A-Za-z0-9._:-]{0,95}$/;
const safeVersion = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const shortText = (value: unknown, limit = 512): value is string =>
	typeof value === "string" && value.trim().length > 0 && value.length <= limit && !value.includes("\0");
const validMetric = (metric: CandidateMetricV1): boolean =>
	shortText(metric?.name, 128) && Number.isFinite(metric.value) &&
	shortText(metric.unit, 64) && shortText(metric.basisId, 256) &&
	["higher", "lower"].includes(metric.direction);
function validExecutionFacts(facts: CandidateExecutionFactsV1 | undefined, receiptCount: number): boolean {
	if (facts === undefined) return true;
	if (!facts || !Array.isArray(facts.evaluations) || facts.evaluations.length > receiptCount) return false;
	return facts.evaluations.every(evaluation => evaluation &&
		shortText(evaluation.externalId, 128) && shortText(evaluation.subjectId, 128) &&
		shortText(evaluation.status, 128) && typeof evaluation.terminal === "boolean" &&
		shortText(evaluation.capturedAt, 64) && !Number.isNaN(Date.parse(evaluation.capturedAt)) &&
		Number.isInteger(evaluation.receiptIndex) && evaluation.receiptIndex >= 0 && evaluation.receiptIndex < receiptCount &&
		Array.isArray(evaluation.cases) &&
		evaluation.cases.every(item => item && shortText(item.caseId, 256) && shortText(item.status, 128) &&
			["passed", "failed", "unknown"].includes(item.correctness) &&
			Array.isArray(item.metrics) && item.metrics.every(validMetric) &&
			(item.performance === undefined || validCandidatePerformanceEvidence(item.performance, receiptCount)) &&
			(item.referenceMeasurements === undefined || Array.isArray(item.referenceMeasurements) &&
				item.referenceMeasurements.every(reference => reference && shortText(reference.name, 128) &&
					Number.isFinite(reference.value) && shortText(reference.unit, 64) &&
					shortText(reference.basisId, 256)))) &&
		Array.isArray(evaluation.diagnostics) &&
		evaluation.diagnostics.every(item => item && ["compile", "numerical", "runtime", "unknown"].includes(item.category) &&
			shortText(item.fieldPath, 512) && typeof item.rawText === "string" &&
			item.rawText.length > 0 && !item.rawText.includes("\0") &&
			(item.caseId === undefined || shortText(item.caseId, 256))));
}

export function requireCandidateVerifier(verifier: CandidateVerifier | undefined,
	binding?: { id: string; verifierVersion: string }): CandidateVerifier {
	if (!verifier || !safeId.test(verifier.id) || !safeVersion.test(verifier.version) ||
		typeof verifier.verifyTask !== "function" ||
		(verifier.verifyGoal !== undefined && typeof verifier.verifyGoal !== "function") ||
		(binding && (binding.id !== verifier.id || binding.verifierVersion !== verifier.version)))
		throw new HarnessError("m07.candidate-verifier", "trusted candidate verifier is unavailable or differs from the frozen binding");
	return verifier;
}

export function candidateObservation(result: Awaited<ReturnType<CandidateVerifier["verifyTask"]>>,
	verifier: CandidateVerifier, goal: CurrentGoal, task: M07TaskRecord, sources: readonly FrozenCandidateFile[],
	receipts: readonly FrozenCandidateFile[]): CandidateObservationV1 {
	const hostChecks = result?.checks ?? [];
	if (!result || !["verified", "unknown"].includes(result.sourceBinding) ||
		!["passed", "failed", "unknown"].includes(result.correctness) ||
		!shortText(result.stage, 128) || !Array.isArray(hostChecks) ||
		new Set(hostChecks.map(check => check.criterion)).size !== hostChecks.length ||
		hostChecks.some(check => !task.checks.includes(check.criterion) ||
			!["passed", "failed", "not_run"].includes(check.result)) ||
		(result.goalChecks !== undefined && (!Array.isArray(result.goalChecks) ||
			new Set(result.goalChecks.map(check => check.criterion)).size !== result.goalChecks.length ||
			result.goalChecks.some(check => !goal.successCriteria.includes(check.criterion) ||
				!["passed", "failed", "not_run"].includes(check.result)))) ||
		!Array.isArray(result.metrics) || result.metrics.some(metric => !validMetric(metric)) ||
		!validExecutionFacts(result.executionFacts, receipts.length) ||
		!Array.isArray(result.limitations) || result.limitations.some(item =>
			typeof item !== "string" || item.length > 2048 || item.includes("\0")))
		throw new HarnessError("m07.candidate-verifier", "trusted candidate observation has invalid or incomplete fields");
	return { version: 1, kind: "candidate-observation",
		verifier: { id: verifier.id, version: verifier.version },
		sourceBinding: result.sourceBinding, correctness: result.correctness,
		stage: result.stage, checks: hostChecks.map(check => ({ ...check })),
		goalChecks: goal.successCriteria.map(criterion => result.sourceBinding === "verified" ?
			(result.goalChecks?.find(check => check.criterion === criterion) ?? { criterion, result: "not_run" as const }) :
			{ criterion, result: "not_run" as const }),
		metrics: result.metrics.map(metric => ({ ...metric })),
		...(result.executionFacts ? { executionFacts: { evaluations: result.executionFacts.evaluations.map(evaluation => ({
			...evaluation, cases: evaluation.cases.map(item => ({ ...item, metrics: item.metrics.map(metric => ({ ...metric })),
				...(item.performance ? { performance: structuredClone(item.performance) } : {}),
				...(item.referenceMeasurements ? { referenceMeasurements: item.referenceMeasurements.map(reference => ({ ...reference })) } : {}) })),
			diagnostics: evaluation.diagnostics.map(item => ({ ...item })) })) } } : {}),
		limitations: [...result.limitations],
		sourceFiles: sources.map(file => file.frozenPath),
		receiptFiles: receipts.map(file => file.frozenPath) };
}
