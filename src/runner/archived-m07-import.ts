/**
 * Select an authenticated, unselected historical M07 candidate as input to a
 * NEW provenance-check goal. The archive is context, not a recovered M07 run,
 * a current review, or permission to adopt its pending lesson.
 */
import { chmod, lstat, mkdtemp, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { authenticatedPriorCarryBindsBundle, type PrivateContinuationBundle } from "./ledger-continuation.ts";

const imported = new WeakSet<object>();
// These are the existing private archive producer's FILES limits, not a new
// campaign quota. Manifest byte identity is checked again below.
const maxBytes = { "candidate.cpp": 128_000, "verification.json": 1_000_000,
	"experiment-plan.json": 16_000 } as const;

export interface ArchivedM07ImportV1 {
	readonly version: 1;
	readonly kind: "untrusted-archived-m07-import";
	readonly originalContractId: string;
	readonly historicalGoalRunId: string;
	readonly historicalTaskId: string;
	readonly historicalReviewClaim: "accepted-archive-claim-only";
	readonly historicalLessonAuthority: "unavailable";
	readonly historicalReviewSnapshotAuthority: "unavailable";
	readonly candidate: Readonly<{ text: string; bytes: number }>;
	readonly verification: Readonly<{ text: string; bytes: number }>;
	readonly plan?: Readonly<{ text: string; bytes: number }>;
}

export interface HistoricalM04EvidenceIndexV1 {
	version: 1;
	kind: "historical-provenance-m04-evidence-index";
	originalContractId: string;
	sourceGoalRunId: string;
	sourceTaskId: string;
	m04: { runId: string; status: "completed"; proposalSubmitted: boolean;
		snapshotCreated: boolean; exportState: "complete" | "none"; recordCount?: number };
	historyLocation: { entryIndex: number; archiveFileKey: "workflow-archive.json";
		knowledgeExportFileKey?: "m04-adopted-knowledge.json" };
	interpretation: "historical-published-evidence-only-not-live-adopted-knowledge";
}

type Input = { proof: unknown; bundle: PrivateContinuationBundle; contractId: string;
	goalRunId: string; taskId: string; expectedChecks: readonly string[] };

function reject(reason: string): never { throw new Error(`archived M07 import: ${reason}`); }
function object(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
/** Accepted execute tasks need actual settled response receipts, not an absent census. */
export function acceptedArchivedOperationCensus(value: unknown): boolean {
	if (!Array.isArray(value) || !value.length) return false;
	const ids = new Set<string>();
	for (const item of value) {
		if (!object(item) || typeof item.operationId !== "string" ||
			!/^O\d{3,}$/.test(item.operationId) || ids.has(item.operationId) ||
			item.status !== "response-received") return false;
		ids.add(item.operationId);
	}
	return true;
}
function parseJson(value: unknown, label: string): Record<string, unknown> {
	if (typeof value !== "string") return reject(`${label} missing`);
	try { const parsed: unknown = JSON.parse(value); if (object(parsed)) return parsed; }
	catch { /* invalid historical input */ }
	return reject(`${label} invalid`);
}
function exactText(value: unknown, name: keyof typeof maxBytes): Readonly<{ text: string; bytes: number }> {
	if (typeof value !== "string" || !value || value.includes("\0")) return reject(`${name} missing or invalid`);
	const bytes = Buffer.byteLength(value, "utf8");
	if (bytes < 1 || bytes > maxBytes[name]) return reject(`${name} exceeds archive bound`);
	return Object.freeze({ text: value, bytes });
}
function fileEntry(archive: Record<string, unknown>, name: string): Record<string, unknown> {
	const rows = archive.files;
	if (!Array.isArray(rows)) return reject("archive file manifest missing");
	const matches = rows.filter(row => object(row) && row.name === name);
	if (matches.length !== 1 || !object(matches[0])) return reject(`${name} archive declaration missing or ambiguous`);
	return matches[0];
}
function requireFile(archive: Record<string, unknown>, files: Record<string, unknown>,
	name: keyof typeof maxBytes): Readonly<{ text: string; bytes: number }> {
	const entry = fileEntry(archive, name);
	if (entry.status !== "present" || !Number.isSafeInteger(entry.bytes) || Number(entry.bytes) < 1)
		return reject(`${name} is not a present archived file`);
	const found = exactText(files[name], name);
	if (found.bytes !== entry.bytes) return reject(`${name} differs from archived byte identity`);
	return found;
}

/** Metadata-only pointer into the exact authenticated history. It never loads
 * archived knowledge into the current store or claims a new scientific review. */
export function historicalM04EvidenceIndex(input: { proof: unknown;
	bundle: PrivateContinuationBundle }): HistoricalM04EvidenceIndexV1 | undefined {
	if (!authenticatedPriorCarryBindsBundle(input.proof, input.bundle))
		return reject("live authenticated carry binding is required for historical M04 index");
	if (input.bundle["research-history.json"] === undefined) return undefined;
	const checkpoint = parseJson(input.bundle["objective-checkpoint.json"], "objective checkpoint");
	const history = parseJson(input.bundle["research-history.json"], "research history");
	if (checkpoint.version !== 1 || checkpoint.kind !== "original-objective-progress" ||
		!object(checkpoint.contract) || typeof checkpoint.contract.id !== "string" ||
		!Array.isArray(checkpoint.boundedRuns) || history.version !== 1 ||
		history.kind !== "untrusted-version-bound-research-history" || !Array.isArray(history.entries))
		return reject("historical M04 index contract, checkpoint, or history invalid");
	for (let runIndex = checkpoint.boundedRuns.length - 1; runIndex >= 0; runIndex--) {
		const run = checkpoint.boundedRuns[runIndex];
		if (!object(run) || run.outcome !== "fulfilled" || typeof run.runId !== "string") continue;
		const entries = history.entries.map((entry, index) => ({ entry, index })).filter(({ entry }) =>
			object(entry) && entry.goalRunId === run.runId && /^T\d{3,}$/.test(String(entry.taskId)));
		for (const { entry: raw, index } of entries) {
			const entry = raw as Record<string, unknown>;
			if (!object(entry.files) || typeof entry.files["workflow-archive.json"] !== "string") continue;
			const archive = parseJson(entry.files["workflow-archive.json"], "provenance workflow archive");
			if (!object(archive.transportLayout) || archive.transportLayout.kind !== "prefixed-flat-index" ||
				archive.transportLayout.prefix !== "provenance-import") continue;
			if (entry.originalContractId !== checkpoint.contract.id || archive.goalRunId !== run.runId ||
				archive.taskId !== entry.taskId || archive.goalOutcome !== "fulfilled" ||
				archive.taskStatus !== "accepted" || !object(archive.controllerEvidence) ||
				archive.controllerEvidence.reviewStatus !== "accepted" ||
				!(run.selectedTaskId === entry.taskId || Array.isArray(run.acceptedTaskIds) &&
					run.acceptedTaskIds.includes(entry.taskId)) ||
					!Array.isArray(run.unresolvedOperationIds ?? []) ||
					(run.unresolvedOperationIds as unknown[] | undefined)?.length)
				return reject("historical provenance goal and bounded run do not bind");
			if (!object(archive.m04) || archive.m04.state !== "completed") continue;
			if (typeof archive.m04.runId !== "string" || !archive.m04.runId ||
				typeof archive.m04.proposalSubmitted !== "boolean" ||
				typeof archive.m04.snapshotCreated !== "boolean" ||
				!object(archive.m04.knowledgeExport))
				return reject("completed historical M04 control outcome is incomplete");
			const exportState = archive.m04.knowledgeExport.state;
			if (exportState !== "complete" && exportState !== "none")
				return reject("completed historical M04 export state is incomplete or invalid");
			let recordCount: number | undefined;
			let knowledgeExportFileKey: "m04-adopted-knowledge.json" | undefined;
			if (exportState === "complete") {
				if (archive.m04.knowledgeExport.file !== "provenance-import-m04-adopted-knowledge.json" ||
					!Number.isSafeInteger(archive.m04.knowledgeExport.recordCount) ||
					Number(archive.m04.knowledgeExport.recordCount) < 0)
					return reject("historical M04 export declaration does not bind");
				const payload = parseJson(entry.files["m04-adopted-knowledge.json"],
					"historical M04 knowledge export");
				if (payload.version !== 1 || payload.kind !== "m04-published-knowledge-export" ||
					payload.m04RunId !== archive.m04.runId || !Array.isArray(payload.records) ||
					payload.records.length !== archive.m04.knowledgeExport.recordCount)
					return reject("historical M04 knowledge export and archive disagree");
				recordCount = payload.records.length;
				knowledgeExportFileKey = "m04-adopted-knowledge.json";
			} else if (entry.files["m04-adopted-knowledge.json"] !== undefined)
				return reject("undeclared historical M04 knowledge export supplied");
			return { version: 1, kind: "historical-provenance-m04-evidence-index",
				originalContractId: checkpoint.contract.id, sourceGoalRunId: run.runId,
				sourceTaskId: entry.taskId as string, m04: { runId: archive.m04.runId,
					status: "completed", proposalSubmitted: archive.m04.proposalSubmitted,
					snapshotCreated: archive.m04.snapshotCreated, exportState,
					...(recordCount !== undefined ? { recordCount } : {}) },
				historyLocation: { entryIndex: index, archiveFileKey: "workflow-archive.json",
					...(knowledgeExportFileKey ? { knowledgeExportFileKey } : {}) },
				interpretation: "historical-published-evidence-only-not-live-adopted-knowledge" };
		}
	}
	return undefined;
}

/** Pure validation: no filesystem mutation, model call, or scientific adoption. */
export function validateArchivedM07Import(input: Input): ArchivedM07ImportV1 {
	if (!authenticatedPriorCarryBindsBundle(input.proof, input.bundle))
		return reject("live authenticated carry binding is required");
	if (!input.contractId || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(input.goalRunId) ||
		!/^T\d{3,}$/.test(input.taskId) || !Array.isArray(input.expectedChecks) ||
		!input.expectedChecks.length || input.expectedChecks.some(item => typeof item !== "string" || !item.trim()) ||
		new Set(input.expectedChecks).size !== input.expectedChecks.length)
		return reject("requested contract, task, or checks invalid");
	const original = parseJson(input.bundle["original-objective.json"], "original objective");
	const checkpoint = parseJson(input.bundle["objective-checkpoint.json"], "objective checkpoint");
	const contract = checkpoint.contract;
	if (original.version !== 1 || original.kind !== "original-objective" || original.id !== input.contractId ||
		!object(contract) || JSON.stringify(contract) !== JSON.stringify(original))
		return reject("original contract and checkpoint do not bind");
	if (checkpoint.version !== 1 || checkpoint.kind !== "original-objective-progress" ||
		!Array.isArray(checkpoint.boundedRuns)) return reject("objective checkpoint invalid");
	const matchingRuns = checkpoint.boundedRuns.filter(row => object(row) && row.runId === input.goalRunId);
	if (matchingRuns.length !== 1 || !object(matchingRuns[0]) || matchingRuns[0].outcome !== "fulfilled" ||
		matchingRuns[0].selectedTaskId !== input.taskId ||
		!Array.isArray(matchingRuns[0].unresolvedOperationIds ?? []) ||
		(matchingRuns[0].unresolvedOperationIds as unknown[] | undefined)?.length)
		return reject("historical selected run is not fulfilled and settled");
	const continuation = checkpoint.continuation;
	if (!object(continuation) || !Array.isArray(continuation.unresolvedOperationIds))
		return reject("continuation operation references unavailable");
	if (continuation.unresolvedOperationIds.some(ref => typeof ref !== "string" ||
		!/^([A-Za-z0-9][A-Za-z0-9._-]*\/)?O\d{3,}$/.test(ref) ||
		ref.startsWith(`${input.goalRunId}/`) || !ref.includes("/")))
		return reject("target or unqualified unresolved operation remains");
	const history = parseJson(input.bundle["research-history.json"], "research history");
	if (history.version !== 1 || history.kind !== "untrusted-version-bound-research-history" ||
		!Array.isArray(history.entries)) return reject("research history invalid");
	const matches = history.entries.filter(entry => object(entry) &&
		entry.goalRunId === input.goalRunId && entry.taskId === input.taskId);
	if (matches.length !== 1 || !object(matches[0]) || matches[0].originalContractId !== input.contractId ||
		!object(matches[0].files)) return reject("historical entry is missing, ambiguous, or bound to another contract");
	const files = matches[0].files as Record<string, unknown>;
	const archive = parseJson(files["workflow-archive.json"], "historical workflow archive");
	const control = archive.controllerEvidence;
	if (archive.version !== 1 || archive.kind !== "m07-private-candidate-archive" ||
		archive.goalRunId !== input.goalRunId || archive.taskId !== input.taskId ||
		archive.goalOutcome !== "fulfilled" || archive.taskStatus !== "accepted" ||
		!object(control) || control.reviewStatus !== "accepted" ||
		!Array.isArray(control.reviewChecks) || control.reviewChecks.length !== input.expectedChecks.length ||
		control.reviewChecks.some((item, index) => !object(item) ||
			item.criterion !== input.expectedChecks[index] || item.result !== "passed") ||
		!object(archive.knowledgeReuse) || archive.knowledgeReuse.trustedAdoption !== false ||
		archive.knowledgeReuse.adoptionPath !== "M04" ||
		!object(archive.m04) || archive.m04.state !== "failed" ||
		archive.m04.proposalSubmitted !== false || archive.m04.snapshotCreated !== false)
		return reject("archive is not an unadopted accepted/fulfilled task awaiting failed M04");
	if (!acceptedArchivedOperationCensus(control.operationOutcomes))
		return reject("accepted historical task lacks a complete settled operation census");
	const candidate = requireFile(archive, files, "candidate.cpp");
	const verification = requireFile(archive, files, "verification.json");
	const checked = parseJson(verification.text, "historical verification");
	if (checked.version !== 1 || checked.status !== "passed" ||
		!object(checked.independent) || checked.independent.status !== "passed")
		return reject("historical verification did not report independent pass");
	const planEntry = fileEntry(archive, "experiment-plan.json");
	const plan = planEntry.status === "present" ? requireFile(archive, files, "experiment-plan.json") : undefined;
	if (planEntry.status !== "present" && planEntry.status !== "missing")
		return reject("historical plan declaration invalid");
	if (!plan && files["experiment-plan.json"] !== undefined) return reject("undeclared historical plan supplied");
	if (plan) parseJson(plan.text, "historical experiment plan");
	const descriptor: ArchivedM07ImportV1 = Object.freeze({ version: 1,
		kind: "untrusted-archived-m07-import", originalContractId: input.contractId,
		historicalGoalRunId: input.goalRunId, historicalTaskId: input.taskId,
		historicalReviewClaim: "accepted-archive-claim-only",
		historicalLessonAuthority: "unavailable", historicalReviewSnapshotAuthority: "unavailable",
		candidate, verification, ...(plan ? { plan } : {}) });
	imported.add(descriptor);
	return descriptor;
}

/** Writes only fresh untrusted import inputs. Never creates an M07 run or review. */
export async function stageArchivedM07Import(descriptor: ArchivedM07ImportV1, trustedWorkspaceDir: string): Promise<{
	root: string; candidatePath: string; verificationPath: string; planPath?: string; provenancePath: string;
}> {
	if (!imported.has(descriptor) || !path.isAbsolute(trustedWorkspaceDir))
		return reject("validated descriptor and absolute trusted workspace directory required");
	for (const item of [descriptor.candidate, descriptor.verification, descriptor.plan].filter(Boolean))
		if (Buffer.byteLength(item!.text, "utf8") !== item!.bytes)
			return reject("descriptor bytes changed before staging");
	const info = await lstat(trustedWorkspaceDir);
	if (!info.isDirectory() || info.isSymbolicLink()) return reject("trusted workspace directory is unsafe");
	const destination = await mkdtemp(path.join(await realpath(trustedWorkspaceDir), "archived-m07-import-"));
	await chmod(destination, 0o700);
	const candidatePath = path.join(destination, "candidate.cpp");
	const verificationPath = path.join(destination, "verification.json");
	const planPath = descriptor.plan ? path.join(destination, "experiment-plan.json") : undefined;
	const provenancePath = path.join(destination, "import-provenance.json");
	await writeFile(candidatePath, descriptor.candidate.text, { mode: 0o600, flag: "wx" });
	await writeFile(verificationPath, descriptor.verification.text, { mode: 0o600, flag: "wx" });
	if (planPath) await writeFile(planPath, descriptor.plan!.text, { mode: 0o600, flag: "wx" });
	await writeFile(provenancePath, `${JSON.stringify({ version: 1, kind: descriptor.kind,
		originalContractId: descriptor.originalContractId, historicalGoalRunId: descriptor.historicalGoalRunId,
		historicalTaskId: descriptor.historicalTaskId,
		candidateBytes: descriptor.candidate.bytes, verificationBytes: descriptor.verification.bytes,
		...(descriptor.plan ? { planBytes: descriptor.plan.bytes } : {}),
		historicalReviewClaim: descriptor.historicalReviewClaim,
		historicalLessonAuthority: descriptor.historicalLessonAuthority,
		historicalReviewSnapshotAuthority: descriptor.historicalReviewSnapshotAuthority,
		interpretation: "Untrusted input to a new goal; revalidate and review afresh before M04." }, null, 2)}\n`,
		{ mode: 0o600, flag: "wx" });
	return { root: destination, candidatePath, verificationPath, ...(planPath ? { planPath } : {}), provenancePath };
}
