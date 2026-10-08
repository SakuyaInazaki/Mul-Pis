/** Trusted, host-registered finite-objective checks. A model cannot nominate
 * executable code or turn an evaluator observation into M07/M04 authority. */
import type { OriginalObjectiveContractV1 } from "./objective-progress.ts";
import type { ObjectiveCapabilityV1 } from "./objective-progress.ts";
import { HarnessError } from "../types.ts";
import { writeFile } from "node:fs/promises";
import path from "node:path";

export type LocalEvaluationResult = "passed" | "failed" | "not_run" | "unknown";
export interface LocalEvaluatorCheck {
	obligationId: string;
	result: LocalEvaluationResult;
	/** Candidate snapshot names, not arbitrary filesystem paths. */
	evidenceRefs: string[];
	limitations: string[];
}
export interface LocalCandidateSnapshot {
	name: string;
	/** Host-owned immutable-by-contract copy, rehashed after evaluate. */
	file: string;
	sourceFile: string;
	bytes: number;
	sha256: string;
}
export interface LocalFrozenOriginalIdentity {
	name: string; bytes: number; sha256: string; sourceIdentity?: string;
}
/** Admitted evaluator output is text so M04 can read its exact frozen bytes. */
export interface LocalEvaluatorObservationDeclaration {
	name: string;
	kind: "text" | "json";
}
export interface LocalMissionEvaluator {
	readonly id: string;
	readonly version: string;
	readonly supportedObligationTypes: readonly string[];
	preflight(input: Readonly<{ contract: OriginalObjectiveContractV1;
		frozenOriginalInputs: readonly Readonly<LocalFrozenOriginalIdentity>[];
		capabilities: readonly Readonly<ObjectiveCapabilityV1>[] }>): Promise<Readonly<{
		available: boolean; reason?: string }>>;
	evaluate(input: Readonly<{ contract: OriginalObjectiveContractV1; missionId: string;
		runId: string; taskId: string; candidate: readonly Readonly<LocalCandidateSnapshot>[];
		frozenEvidence: readonly Readonly<{ name: string; file: string }>[];
		observationOutputDir: string }>):
		Promise<Readonly<{ checks: readonly Readonly<LocalEvaluatorCheck>[];
			observations: readonly Readonly<LocalEvaluatorObservationDeclaration>[];
			limitations: readonly string[] }>>;
}

const registry = new Map<string, LocalMissionEvaluator>();
const safeId = /^[A-Za-z][A-Za-z0-9._:-]{0,95}$/;
const safeVersion = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Registration happens in trusted host code, never from objective JSON. */
export function registerTrustedLocalMissionEvaluator(evaluator: LocalMissionEvaluator): void {
	if (!safeId.test(evaluator.id) || !safeVersion.test(evaluator.version) ||
		!Array.isArray(evaluator.supportedObligationTypes) ||
		!evaluator.supportedObligationTypes.length ||
		new Set(evaluator.supportedObligationTypes).size !== evaluator.supportedObligationTypes.length ||
		evaluator.supportedObligationTypes.some(type => !safeId.test(type)) ||
		typeof evaluator.preflight !== "function" || typeof evaluator.evaluate !== "function")
		throw new HarnessError("local.evaluator.registry", "trusted evaluator declaration is invalid");
	const existing = registry.get(evaluator.id);
	if (existing && existing !== evaluator)
		throw new HarnessError("local.evaluator.registry", "trusted evaluator ID is already registered");
	registry.set(evaluator.id, evaluator);
}

export function trustedLocalMissionEvaluator(id: string | undefined): LocalMissionEvaluator | undefined {
	return id ? registry.get(id) : undefined;
}

/** A narrow production example: byte-exact deliverables. It asserts only the
 * declared digest, and has no authority over other scientific obligations. */
const exactFileEvaluator: LocalMissionEvaluator = {
	id: "host:file-sha256", version: "1", supportedObligationTypes: ["file-sha256"],
	async preflight({ contract }) {
		return contract.obligations.every(item => item.type === "file-sha256" &&
			/^[0-9a-f]{64}$/.test(item.expectedSha256 ?? "")) ?
			{ available: true } : { available: false,
				reason: "each obligation needs type file-sha256 and an expectedSha256 digest" };
	},
	async evaluate({ contract, candidate, observationOutputDir }) {
		const observationName = "observation-digests.json";
		await writeFile(path.join(observationOutputDir, observationName),
			`${JSON.stringify({ kind: "exact-candidate-digests", candidate: candidate.map(file =>
				({ name: file.name, bytes: file.bytes, sha256: file.sha256 })) }, null, 2)}\n`,
			{ flag: "wx", mode: 0o600 });
		const checks = contract.obligations.map(item => {
			const matches = candidate.filter(file => file.sha256 === item.expectedSha256);
			return { obligationId: item.id, result: matches.length ? "passed" as const : "failed" as const,
				evidenceRefs: [...matches.map(file => file.name), observationName],
				limitations: ["Only exact candidate bytes were checked; no broader scientific claim was evaluated."] };
		});
		return { checks, observations: [{ name: observationName, kind: "json" }],
			limitations: ["Exact-byte evaluation only."] };
	},
};
registerTrustedLocalMissionEvaluator(exactFileEvaluator);
