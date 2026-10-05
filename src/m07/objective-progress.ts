import { randomUUID } from "node:crypto";
import { copyFile, lstat, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { openBoundedSession, type EvidenceBindingV1 } from "../context/boundary.ts";
import type { SessionRunner, SessionSpec } from "../runner/types.ts";
import type { StageRunRecord } from "../types.ts";
import { HarnessError } from "../types.ts";

const MAX_EVIDENCE_BYTES = 256_000;
const MAX_ASSESSMENT_BYTES = 32_000;
const safeName = (value: string) => /^[A-Za-z][A-Za-z0-9._-]{0,79}$/.test(value);
const safeInputName = (value: string) => /^[A-Za-z0-9][A-Za-z0-9 ._()-]{0,119}$/.test(value);
const shortText = (value: unknown, limit: number): value is string =>
	typeof value === "string" && value.trim().length > 0 && value.length <= limit && !value.includes("\0");

/** The caller's original mission is separate from any finite M07 child goal. */
export interface OriginalObjectiveContractV1 {
	version: 1;
	kind: "original-objective";
	id: string;
	createdAt: string;
	goal: string;
	goalSource: "verbatim-private-input" | "user-intent-summary";
	inputNames: string[];
	obligations: Array<{ id: string; description: string }>;
	/** Open-ended strongest-attainable work cannot be closed by a finite pilot's checks. */
	closure: "open-ended" | "finite-evidence";
}

export interface ObjectiveNextTaskV1 {
	objective: string;
	addresses: string[];
	adapterScope: "two-target-existing" | "outside-current-adapter";
}

export interface ModelObjectiveAssessmentV1 {
	version: 1;
	decision: "fulfilled" | "continue" | "blocked";
	rationale: string;
	evidenceRefs: string[];
	unresolvedObligations: string[];
	/** Model-authored open issues from the full original assignment, never a host-chosen strategy list. */
	unresolvedDetails: string[];
	nextTask?: ObjectiveNextTaskV1;
}

export type ObjectiveStopReason = "budget-boundary" | "provider-call-limit" | "accounting-integrity-error" |
	"time-boundary" | "assessment-failed" |
	"assessment-invalid" | "assessment-evidence-unread" | "model-reported-blocked" | "model-closure-unverified" |
	"original-checks-unverified" | "assessment-validation-pending" | "next-task-pending" | "next-task-needs-capability" |
	"objective-reassessment-pending" | "dispatch-failed" | "no-progress" |
	"artifact-capacity-boundary" | "m04-evidence-incomplete" | "bounded-run-incomplete";

export interface ObjectiveProgressV1 {
	version: 1;
	kind: "original-objective-progress";
	contract: OriginalObjectiveContractV1;
	objectiveOutcome: "incomplete" | "fulfilled";
	stopReason: ObjectiveStopReason | null;
	assessment?: ModelObjectiveAssessmentV1 & { sessionId: string; model: string; evidenceRead: string[];
		unreadEvidence: string[] };
	assessmentHistory: Array<{ iteration: number; assessment: NonNullable<ObjectiveProgressV1["assessment"]>;
		stopReason: ObjectiveStopReason; advanced: boolean }>;
	boundedRuns: Array<{ runId: string; outcome: string; selectedTaskId?: string;
		acceptedTaskIds?: string[]; unresolvedOperationIds?: string[] }>;
	selectedArtifacts: string[];
	availableArtifacts: string[];
	continuation: { mode: "explicit-authorized-new-run" | "reconcile-operations-before-new-run";
		unresolvedOperationIds: string[]; unresolvedObligations: string[];
		unresolvedDetails: string[];
		nextTask?: ObjectiveNextTaskV1; requiresOriginalInputs: true; requiresBudgetAdmission: true;
		requiresOperationReconciliation: boolean };
}

/** Reassess the unchanged original goal after every bounded child until an actual stop boundary. */
export async function runOriginalObjectiveLoop(input: {
	maxIterations: number;
	admission: () => "admitted" | ObjectiveStopReason;
	step: (iteration: number) => Promise<{ advanced: boolean; stopReason: ObjectiveStopReason; evidenceRefs?: string[] }>;
}): Promise<{ stopReason: ObjectiveStopReason; steps: Array<{ iteration: number; advanced: boolean;
	stopReason: ObjectiveStopReason; evidenceRefs: string[] }> }> {
	if (!Number.isSafeInteger(input.maxIterations) || input.maxIterations < 1 || input.maxIterations > 64)
		throw new HarnessError("m07.objective", "objective loop capacity must fit the bounded campaign transport");
	const steps: Array<{ iteration: number; advanced: boolean; stopReason: ObjectiveStopReason; evidenceRefs: string[] }> = [];
	for (let iteration = 1; iteration <= input.maxIterations; iteration++) {
		const admission = input.admission();
		if (admission !== "admitted") return { stopReason: admission, steps };
		const result = await input.step(iteration);
		steps.push({ iteration, advanced: result.advanced, stopReason: result.stopReason,
			evidenceRefs: [...(result.evidenceRefs ?? [])] });
		if (!result.advanced || result.stopReason !== "objective-reassessment-pending")
			return { stopReason: result.stopReason, steps };
	}
	return { stopReason: "artifact-capacity-boundary", steps };
}

export function createOriginalObjective(input: {
	goal: string; goalSource: OriginalObjectiveContractV1["goalSource"]; inputNames: string[];
	obligations: Array<{ id: string; description: string }>; closure: OriginalObjectiveContractV1["closure"];
}): OriginalObjectiveContractV1 {
	if (!shortText(input.goal, 4_000) || !Array.isArray(input.inputNames) || !input.inputNames.length ||
		input.inputNames.length > 16 || input.inputNames.some(name => !safeInputName(name)) ||
		new Set(input.inputNames).size !== input.inputNames.length ||
		!Array.isArray(input.obligations) || !input.obligations.length || input.obligations.length > 12 ||
		input.obligations.some(item => !safeName(item.id) || !shortText(item.description, 1_000)) ||
		new Set(input.obligations.map(item => item.id)).size !== input.obligations.length ||
		!["verbatim-private-input", "user-intent-summary"].includes(input.goalSource) ||
		!["open-ended", "finite-evidence"].includes(input.closure))
		throw new HarnessError("m07.objective", "original objective contract is invalid");
	return { version: 1, kind: "original-objective", id: randomUUID(), createdAt: new Date().toISOString(),
		goal: input.goal, goalSource: input.goalSource, inputNames: [...input.inputNames],
		obligations: input.obligations.map(item => ({ ...item })), closure: input.closure };
}

function parseAssessment(text: string, contract: OriginalObjectiveContractV1, evidenceNames: string[]): ModelObjectiveAssessmentV1 {
	if (Buffer.byteLength(text, "utf8") > MAX_ASSESSMENT_BYTES) throw new HarnessError("m07.objective-assessment", "assessment exceeds the bounded output size");
	let value: unknown;
	try { value = JSON.parse(text); } catch { throw new HarnessError("m07.objective-assessment", "assessment is not strict JSON"); }
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new HarnessError("m07.objective-assessment", "assessment object is invalid");
	const raw = value as Record<string, unknown>;
	const ids = new Set(contract.obligations.map(item => item.id));
	const names = new Set(evidenceNames);
	const strings = (item: unknown, allowed: Set<string>, max: number): item is string[] =>
		Array.isArray(item) && item.length <= max && item.every(part => typeof part === "string" && allowed.has(part)) && new Set(item).size === item.length;
	const details = (item: unknown): item is string[] => Array.isArray(item) && item.length <= 12 &&
		item.every(part => shortText(part, 800)) && new Set(item).size === item.length;
	if (raw.version !== 1 || typeof raw.decision !== "string" || !["fulfilled", "continue", "blocked"].includes(raw.decision) ||
		!shortText(raw.rationale, 4_000) || !strings(raw.evidenceRefs, names, 16) ||
		!strings(raw.unresolvedObligations, ids, 12) || !details(raw.unresolvedDetails))
		throw new HarnessError("m07.objective-assessment", "assessment fields are invalid");
	const decision = raw.decision as ModelObjectiveAssessmentV1["decision"];
	let nextTask: ObjectiveNextTaskV1 | undefined;
	if (raw.nextTask !== undefined) {
		if (!raw.nextTask || typeof raw.nextTask !== "object" || Array.isArray(raw.nextTask))
			throw new HarnessError("m07.objective-assessment", "next task object is invalid");
		const task = raw.nextTask as Record<string, unknown>;
		if (!shortText(task.objective, 4_000) || !strings(task.addresses, ids, 12) ||
			typeof task.adapterScope !== "string" ||
			!["two-target-existing", "outside-current-adapter"].includes(task.adapterScope) ||
			!task.addresses.length || task.addresses.some(item => !(raw.unresolvedObligations as string[]).includes(item)))
			throw new HarnessError("m07.objective-assessment", "next task does not address unresolved original obligations");
		nextTask = { objective: task.objective, addresses: task.addresses,
			adapterScope: task.adapterScope as ObjectiveNextTaskV1["adapterScope"] };
	}
	if ((decision === "continue" && (!raw.unresolvedObligations.length || !raw.unresolvedDetails.length || !nextTask)) ||
		(decision === "fulfilled" && (raw.unresolvedObligations.length || raw.unresolvedDetails.length || !raw.evidenceRefs.length || nextTask)) ||
		(decision === "blocked" && (!raw.unresolvedObligations.length || !raw.unresolvedDetails.length || nextTask)))
		throw new HarnessError("m07.objective-assessment", "decision and unresolved obligations conflict");
	return { version: 1, decision, rationale: raw.rationale, evidenceRefs: raw.evidenceRefs,
		unresolvedObligations: raw.unresolvedObligations, unresolvedDetails: raw.unresolvedDetails,
		...(nextTask ? { nextTask } : {}) };
}

export function objectiveProgress(contract: OriginalObjectiveContractV1, input: {
	boundedRuns: ObjectiveProgressV1["boundedRuns"]; selectedArtifacts: string[];
	availableArtifacts?: string[]; unresolvedOperationIds?: string[];
	assessment?: ObjectiveProgressV1["assessment"];
	assessmentHistory?: ObjectiveProgressV1["assessmentHistory"];
	stopReason: ObjectiveStopReason;
	nextTaskDispatched?: boolean;
	/** Only original-level accepted checks, never pilot task checks. */
	originalChecks?: Array<{ obligationId: string; passed: boolean; evidenceRefs: string[] }>;
}): ObjectiveProgressV1 {
	const required = contract.obligations.map(item => item.id);
	const checked = input.originalChecks ?? [];
	const fullOriginalChecks = checked.length === required.length && required.every(id =>
		checked.some(item => item.obligationId === id && item.passed && item.evidenceRefs.length > 0 &&
			item.evidenceRefs.every(ref => input.selectedArtifacts.includes(ref))));
	const fulfilled = contract.closure === "finite-evidence" && input.assessment?.decision === "fulfilled" && fullOriginalChecks &&
		input.assessment.unreadEvidence.length === 0 && input.assessment.evidenceRead.includes("original-objective.json") &&
		input.selectedArtifacts.every(ref => input.assessment!.evidenceRead.includes(ref)) &&
		input.assessment.evidenceRefs.every(ref => input.selectedArtifacts.includes(ref));
	const unresolved = fulfilled ? [] : input.assessment?.unresolvedObligations.length ? input.assessment.unresolvedObligations : required;
	return { version: 1, kind: "original-objective-progress", contract, objectiveOutcome: fulfilled ? "fulfilled" : "incomplete",
		stopReason: fulfilled ? null : input.assessment?.decision === "fulfilled" ?
			contract.closure === "open-ended" ? "model-closure-unverified" : "original-checks-unverified" : input.stopReason,
		...(input.assessment ? { assessment: input.assessment } : {}), boundedRuns: input.boundedRuns,
		assessmentHistory: input.assessmentHistory ? input.assessmentHistory.map(item => ({ ...item })) : [],
		selectedArtifacts: [...input.selectedArtifacts], availableArtifacts: [...(input.availableArtifacts ?? input.selectedArtifacts)],
		continuation: { mode: input.unresolvedOperationIds?.length ? "reconcile-operations-before-new-run" :
			"explicit-authorized-new-run", unresolvedOperationIds: [...(input.unresolvedOperationIds ?? [])],
			unresolvedObligations: unresolved,
			unresolvedDetails: fulfilled ? [] : input.assessment?.unresolvedDetails ?? [],
			...(input.assessment?.nextTask && input.assessment.unreadEvidence.length === 0 && !input.nextTaskDispatched ?
				{ nextTask: input.assessment.nextTask } : {}),
			requiresOriginalInputs: true, requiresBudgetAdmission: true,
			requiresOperationReconciliation: Boolean(input.unresolvedOperationIds?.length) } };
}

/** A fresh, read-only model judgment with a durable boundary receipt, then one validated caller-owned M07 dispatch. */
export async function assessAndAdvanceOriginalObjective<T>(input: {
	contract: OriginalObjectiveContractV1; contractFile: string;
	runner: SessionRunner; sessionSpec: Omit<SessionSpec, "tools">; runRecord: StageRunRecord;
	persistReceipt: () => Promise<void>;
	evidenceRoot: string;
	evidence: Array<{ name: string; file: string }>;
	assessmentAdmission: "admitted" | "budget-boundary" | "time-boundary";
	advanceAdmission: () => "admitted" | ObjectiveStopReason;
	supportedTaskScopes: ObjectiveNextTaskV1["adapterScope"][];
	recordAssessment?: (assessment: NonNullable<ObjectiveProgressV1["assessment"]>) => Promise<void>;
	advance: (task: ObjectiveNextTaskV1) => Promise<T>;
}): Promise<{ assessment?: ObjectiveProgressV1["assessment"]; advanced?: T; stopReason: ObjectiveStopReason }> {
	if (input.assessmentAdmission !== "admitted") return { stopReason: input.assessmentAdmission };
	if (input.sessionSpec.role !== "research" ||
		!input.evidence.length || input.evidence.length > 16 || input.evidence.some(item => !safeName(item.name)) ||
		new Set(input.evidence.map(item => item.name)).size !== input.evidence.length)
		throw new HarnessError("m07.objective", "objective assessment boundary is invalid");
	if (!input.evidence.some(item => item.name === "original-problem.txt") ||
		!input.evidence.some(item => item.name === "candidate.cpp") ||
		!input.evidence.some(item => item.name === "verification.json"))
		throw new HarnessError("m07.objective", "original problem and selected candidate evidence are required");
	const contractBytes = await readFile(input.contractFile);
	if (contractBytes.toString("utf8") !== `${JSON.stringify(input.contract, null, 2)}\n`)
		throw new HarnessError("m07.objective", "original objective contract changed after freezing");
	let total = contractBytes.length;
	const materials: Array<{ name: string; file: string; text: string }> = [];
	for (const item of input.evidence) {
		const info = await lstat(item.file);
		if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_EVIDENCE_BYTES || total + info.size > MAX_EVIDENCE_BYTES)
			throw new HarnessError("m07.objective", "objective evidence is not a bounded regular file");
		const text = await readFile(item.file, "utf8");
		total += Buffer.byteLength(text, "utf8");
		materials.push({ ...item, text });
	}
	await mkdir(input.evidenceRoot, { mode: 0o700 });
	const frozenContract = path.join(input.evidenceRoot, "original-objective.json");
	await copyFile(input.contractFile, frozenContract);
	if (!(await readFile(frozenContract)).equals(contractBytes))
		throw new HarnessError("m07.objective", "frozen original objective changed during copy");
	const evidence: EvidenceBindingV1[] = [
		{ version: 1, label: "frozen original objective", path: frozenContract, status: "frozen-copy", sourceVersion: input.contract.id },
	];
	for (const item of materials) {
		const copy = path.join(input.evidenceRoot, item.name);
		await copyFile(item.file, copy);
		if (!(await readFile(copy)).equals(Buffer.from(item.text, "utf8")))
			throw new HarnessError("m07.objective", "frozen objective evidence changed during copy");
		evidence.push({ version: 1, label: item.name, path: copy, status: "frozen-copy", sourceVersion: input.contract.id });
	}
	const spec: SessionSpec = { ...input.sessionSpec,
		tools: { kind: "read-dir", root: input.evidenceRoot, toolName: "objective_evidence_read" } };
	const handle = await openBoundedSession(input.runner, input.runRecord, {
		mode: "fresh", intent: "independent-judgment", reason: "Assess the original user goal from frozen bounded evidence before choosing further M07 work",
		evidence, spec,
	}, input.persistReceipt);
	try {
		const prompt = ["# Original objective (unchanged)", input.contract.goal,
			"# Original obligations", ...input.contract.obligations.map(item => `${item.id}: ${item.description}`),
			`Closure policy: ${input.contract.closure}. A bounded child goal and accepted candidate do not alone establish original-goal completion.`,
			"The original-input-N.txt files correspond in order to inputNames in original-objective.json; read all of them as authoritative original material.",
			"# Frozen bounded evidence", "Use objective_evidence_read to read the complete original-objective.json and every listed file. If a file is paginated, read every page including the untruncated end. The file names are:",
			...materials.map(item => item.name),
			"Return only strict JSON with version 1, decision (fulfilled, continue, or blocked), rationale, evidenceRefs (file names above), unresolvedObligations (IDs above), unresolvedDetails (your concrete open requirements from the full original assignment), and when continuing nextTask {objective, addresses, adapterScope}. Choose adapterScope two-target-existing only if the proposed work fits edits to the two existing target bodies under the current adapter; otherwise use outside-current-adapter so the proposal is retained without silently narrowing it. Assess honestly. Propose the next scientific work yourself from unresolved original obligations; do not change task permissions or claim a global optimum from a finite pilot."].join("\n\n");
		let response;
		try { response = await handle.prompt(prompt); }
		catch { return { stopReason: "assessment-failed" }; }
		let parsed;
		try { parsed = parseAssessment(response.text, input.contract, materials.map(item => item.name)); }
		catch { return { stopReason: "assessment-invalid" }; }
		const returned = handle.readReturnEvents();
		const complete = (name: string, contents: string): boolean => {
			const lines = contents.split("\n").length - (contents.endsWith("\n") ? 1 : 0);
			const rows = returned.filter(item => item.toolName === "objective_evidence_read" && item.path === name &&
				item.status === "returned" && item.returned.kind === "text" && item.returned.startLine !== undefined &&
				item.returned.endLine !== undefined && item.returned.startLine >= 1 &&
				item.returned.endLine >= item.returned.startLine && item.returned.endLine <= lines);
			const covered = new Set<number>();
			for (const row of rows) for (let line = row.returned.startLine!; line <= row.returned.endLine! && line <= lines; line++) covered.add(line);
			return rows.some(item => item.returned.endLine === lines && item.returned.truncated === false) && covered.size === lines;
		};
		const readMaterials = [{ name: "original-objective.json", text: contractBytes.toString("utf8") }, ...materials];
		const evidenceRead = readMaterials.filter(item => complete(item.name, item.text)).map(item => item.name);
		const unreadEvidence = readMaterials.filter(item => !evidenceRead.includes(item.name)).map(item => item.name);
		const assessment = { ...parsed, sessionId: handle.ref.id, model: handle.ref.model, evidenceRead, unreadEvidence };
		await input.recordAssessment?.(assessment);
		if (unreadEvidence.length) return { assessment, stopReason: "assessment-evidence-unread" };
		if (parsed.decision === "blocked") return { assessment, stopReason: "model-reported-blocked" };
		if (parsed.decision === "fulfilled") return { assessment, stopReason: "model-closure-unverified" };
		if (!input.supportedTaskScopes.includes(parsed.nextTask!.adapterScope))
			return { assessment, stopReason: "next-task-needs-capability" };
		const advanceAdmission = input.advanceAdmission();
		if (advanceAdmission !== "admitted") return { assessment, stopReason: advanceAdmission };
		const advanced = await input.advance(parsed.nextTask!);
		return { assessment, advanced, stopReason: "objective-reassessment-pending" };
	} finally { handle.dispose(); }
}

export async function writeOriginalObjectiveContract(file: string, contract: OriginalObjectiveContractV1): Promise<void> {
	if (path.basename(file) !== "original-objective.json") throw new HarnessError("m07.objective", "original contract file name is invalid");
	await writeFile(file, `${JSON.stringify(contract, null, 2)}\n`, { flag: "wx", mode: 0o600 });
}

export async function writeObjectiveProgress(file: string, progress: ObjectiveProgressV1): Promise<void> {
	if (path.basename(file) !== "objective-checkpoint.json") throw new HarnessError("m07.objective", "objective checkpoint file name is invalid");
	const temporary = `${file}.${process.pid}.tmp`;
	await writeFile(temporary, `${JSON.stringify(progress, null, 2)}\n`, { mode: 0o600 });
	await rename(temporary, file);
}
