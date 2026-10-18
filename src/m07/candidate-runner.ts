/** Host-bound execution; models choose candidates, never executable backend code. */
import { copyFile, lstat, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import type { CustomToolSpec, ToolResult } from "../runner/types.ts";
import { HarnessError } from "../types.ts";
import { writeFileAtomic } from "../workspace.ts";
import { isSafeRelativeOutputPath } from "./expected-output.ts";
import { openSearchEventLog, type SearchEventInput } from "./search-state/index.ts";

export type CandidateExecutionCheck = "contract" | "compile" | "correctness" | "measurement";
export interface CandidateExecutionStage {
	id: string;
	checks: CandidateExecutionCheck[];
	/** A delegated judge is responsible for its own internal cascade, not a claimed local check. */
	mode: "local" | "delegated";
}
export interface CandidateExecutionStageResult {
	status: "passed" | "failed" | "pending" | "unknown";
	/** Checks actually observed by this result, when the backend can identify them; not inferred from capability. */
	performedChecks?: CandidateExecutionCheck[];
	/** Exact original evidence paths, relative to workDir. */
	receiptPaths: string[];
	/** Only actual evaluation receipts go to candidate_evaluate. Explicitly set for early failures. */
	evaluationReceiptPaths?: string[];
	externalId?: string;
	summary?: string;
}
export interface CandidateExecutionContext {
	goalRunId: string;
	taskId: string;
	operationId: string;
	subjectId?: string;
	runId: string;
	workDir: string;
	sourcePaths: string[];
	sources: Array<{ declaredPath: string; absolutePath: string; frozenPath: string }>;
	config: Record<string, unknown>;
	protocolId: string;
	stage: CandidateExecutionStage;
	outputDir: string;
	signal?: AbortSignal;
	/** Await immediately when the backend learns an external operation ID, before further I/O. */
	recordExternalId(id: string): Promise<void>;
}
export interface CandidateExecutionBackend {
	id: string;
	version: string;
	/** Host-authored help; never an executable/model-selected backend registration. */
	configurationHelp?: string;
	protocolIds?: string[];
	/** Pure host contract validation; runs before creating a new execution journal or calling a backend stage. */
	validateRequest?(request: { protocolId: string; sourcePaths: string[]; config: Record<string, unknown>; subjectId?: string }): void | Promise<void>;
	canQueryStage?(stageId: string): boolean;
	stages: CandidateExecutionStage[];
	executeStage(context: CandidateExecutionContext): Promise<CandidateExecutionStageResult>;
	/** Read/reconcile this original ID only. Must never submit another candidate. */
	queryStage?(context: CandidateExecutionContext & { externalId: string }): Promise<CandidateExecutionStageResult>;
}
export interface CandidateExecutionToolOptions {
	goalRunId: string;
	taskId: string;
	operationId: string;
	subjectId?: string;
	workDir: string;
	/** Host-owned, outside workDir; e.g. sibling candidate-runs/. */
	journalDir: string;
	backend: CandidateExecutionBackend;
	/** Host recovery queries original IDs only; never executes unstarted stages or sweep combinations. */
	queryOnly?: boolean;
	/** Append-only search log for this goal run. Absent means the search records nothing. */
	searchEventLogFile?: string;
	/**
	 * Opt-in background execution. The host receives a drain function and must await
	 * it before ending a prompt, because a run that outlives the prompt would leave
	 * the controller reasoning about an operation nobody is waiting for.
	 */
	backgroundRuns?: { register(drain: () => Promise<void>): void; max?: number };
	evaluate(args: Record<string, unknown>): Promise<ToolResult>;
}
type Request = {
	sourcePaths: string[]; config: Record<string, unknown>; protocolId: string;
	hypothesis: string; changeKind: "repair" | "structure" | "parameters"; intent: "solution" | "diagnostic";
	/** Forwarded unchanged to candidate_evaluate, which owns their validation. */
	strategy?: string; location?: string; newEvidence?: string;
	parentCandidateId?: string; conditions?: string[]; changeSummary?: string;
};
type StageEntry = { attempts?: number; receiptSnapshots?: Array<{ originalPath: string; frozenPath: string; evaluationPath: string }>; stage: CandidateExecutionStage; status: "running" | CandidateExecutionStageResult["status"];
	externalId?: string; result?: CandidateExecutionStageResult; error?: string };
type Journal = {
	version: 1; kind: "candidate"; runId: string; goalRunId: string; taskId: string; operationId: string; subjectId?: string;
	backend: { id: string; version: string; stages: CandidateExecutionStage[] }; request: Request;
	state: "prepared" | "running" | "pending" | "unknown" | "failed" | "completed";
	sources: CandidateExecutionContext["sources"]; stages: StageEntry[];
	createdAt: string; updatedAt: string; evaluation?: ToolResult; evaluationError?: string;
};
type SweepJournal = { version: 1; kind: "sweep"; runId: string; binding: string; request: Request;
	domains: Record<string, number[]>; total: number; nextIndex: number; templatePaths: string[]; updatedAt: string };
const checks: CandidateExecutionCheck[] = ["contract", "compile", "correctness", "measurement"];
const inside = (root: string, file: string) => file.startsWith(root + path.sep);
function fail(message: string): never { throw new HarnessError("m07.candidate.execution", message); }
const identity = (value: unknown): string => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value)
	? value : fail("runId/stage identity must use letters, numbers, underscore or hyphen");
const json = (value: unknown) => JSON.stringify(value, null, 2) + "\n";
function objectJson(value: unknown, label: string): Record<string, unknown> {
	if (typeof value !== "string") return fail(`${label} must be a JSON object string`);
	let parsed: unknown;
	try { parsed = JSON.parse(value); } catch { return fail(`${label} is not valid JSON`); }
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return fail(`${label} must be an object`);
	return parsed as Record<string, unknown>;
}
function requestFrom(args: Record<string, unknown>): Request {
	if (!Array.isArray(args.sourcePaths) || !args.sourcePaths.length || args.sourcePaths.some(p => typeof p !== "string" || !isSafeRelativeOutputPath(p) || p === ".") || new Set(args.sourcePaths).size !== args.sourcePaths.length)
		return fail("sourcePaths must be distinct task-relative regular files");
	if (typeof args.protocolId !== "string" || !args.protocolId.trim() || typeof args.hypothesis !== "string" || !args.hypothesis.trim() || args.hypothesis.length > 4000 ||
		!["repair", "structure", "parameters"].includes(String(args.changeKind)) || !["solution", "diagnostic"].includes(String(args.intent)))
		return fail("protocolId, hypothesis, changeKind and intent are required");
	if (args.parentCandidateId !== undefined && (typeof args.parentCandidateId !== "string" || !args.parentCandidateId.trim())) return fail("invalid parentCandidateId");
	if (args.conditions !== undefined && (!Array.isArray(args.conditions) || args.conditions.length > 32 || args.conditions.some(v => typeof v !== "string" || !v.trim() || v.length > 1000))) return fail("invalid conditions");
	if (args.changeSummary !== undefined && (typeof args.changeSummary !== "string" || !args.changeSummary.trim() || args.changeSummary.length > 4000)) return fail("invalid changeSummary");
	return { sourcePaths: args.sourcePaths as string[], config: objectJson(args.configJson ?? "{}", "configJson"), protocolId: args.protocolId,
		hypothesis: args.hypothesis, changeKind: args.changeKind as Request["changeKind"], intent: args.intent as Request["intent"],
		...(args.parentCandidateId !== undefined ? { parentCandidateId: args.parentCandidateId as string } : {}),
		...(args.conditions !== undefined ? { conditions: args.conditions as string[] } : {}),
		...(args.changeSummary !== undefined ? { changeSummary: args.changeSummary as string } : {}),
		...(args.strategy !== undefined ? { strategy: args.strategy as string } : {}),
		...(args.location !== undefined ? { location: args.location as string } : {}),
		...(args.newEvidence !== undefined ? { newEvidence: args.newEvidence as string } : {}) };
}
async function regular(root: string, relative: string): Promise<string> {
	if (!isSafeRelativeOutputPath(relative) || relative === ".") return fail("invalid evidence path");
	const file = path.resolve(root, relative);
	const stat = await lstat(file);
	if (!inside(root, file) || !stat.isFile() || stat.isSymbolicLink() || !inside(root, await realpath(file))) return fail(`not a regular file inside workDir: ${relative}`);
	return file;
}
async function safeDirectory(root: string, directory: string): Promise<void> {
	if (!inside(root, directory)) fail("output directory escaped task root");
	// Resolve each existing component before creating anything through it.
	let current = root;
	for (const part of path.relative(root, directory).split(path.sep)) {
		current = path.join(current, part);
		try { await mkdir(current); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
		if (!(await lstat(current)).isDirectory() || !inside(root, await realpath(current))) fail("output directory is not confined");
	}
}
async function readJson<T>(file: string): Promise<T | undefined> {
	try { return JSON.parse(await readFile(file, "utf8")) as T; }
	catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}
export interface PendingCandidateExecution {
	runId: string;
	journalPath: string;
	state: "running" | "pending" | "unknown";
	externalId?: string;
	stageId?: string;
	queryAvailable: boolean;
	resume: { tool: "candidate_run" | "candidate_sweep"; runId: string; resume: true };
}
/** Read only known journal slots; never parse model source files named journal.json. */
export async function pendingCandidateExecutions(input: {
	journalDir: string; goalRunId: string; taskId: string; operationId: string;
	backend?: CandidateExecutionBackend;
}): Promise<PendingCandidateExecution[]> {
	const pending: PendingCandidateExecution[] = [];
	const directories = async (dir: string) => {
		try { return (await readdir(dir, { withFileTypes: true })).filter(item => item.isDirectory() && !item.isSymbolicLink()); }
		catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
	};
	const inspect = async (file: string, resume: PendingCandidateExecution["resume"]) => {
		const journal = await readJson<Journal>(file);
		if (!journal || journal.kind !== "candidate") return;
		if (journal.goalRunId !== input.goalRunId || journal.taskId !== input.taskId || journal.operationId !== input.operationId) return;
		if (!["running", "pending", "unknown"].includes(journal.state)) return;
		const active = journal.stages.at(-1);
		pending.push({ runId: journal.runId, journalPath: file, state: journal.state as PendingCandidateExecution["state"],
			stageId: active?.stage.id, externalId: active?.externalId,
			queryAvailable: Boolean(active?.externalId && input.backend?.queryStage && input.backend.id === journal.backend.id && input.backend.version === journal.backend.version &&
				JSON.stringify(input.backend.stages) === JSON.stringify(journal.backend.stages) &&
				(!input.backend.canQueryStage || input.backend.canQueryStage(active.stage.id))), resume });
	};
	for (const entry of await directories(input.journalDir)) {
		const root = path.join(input.journalDir, entry.name), file = path.join(root, "journal.json");
		const journal = await readJson<Journal | SweepJournal>(file);
		if (journal?.kind === "candidate") await inspect(file, { tool: "candidate_run", runId: entry.name, resume: true });
		else if (journal?.kind === "sweep") for (const child of await directories(path.join(root, "runs")))
			await inspect(path.join(root, "runs", child.name, "journal.json"), { tool: "candidate_sweep", runId: entry.name, resume: true });
	}
	return pending;
}

function validateBackend(backend: CandidateExecutionBackend): void {
	if (!backend.id || !backend.version || !backend.stages.length) fail("host backend must identify its actual stages");
	if (backend.protocolIds && (!backend.protocolIds.length || backend.protocolIds.some(id => typeof id !== "string" || !id.trim()) || new Set(backend.protocolIds).size !== backend.protocolIds.length)) fail("backend protocolIds must be distinct nonempty IDs");
	let previous = -1;
	const seen = new Set<string>();
	for (const stage of backend.stages) {
		identity(stage.id);
		if (seen.has(stage.id) || !["local", "delegated"].includes(stage.mode) || !stage.checks.length) fail("invalid backend stage");
		seen.add(stage.id);
		for (const check of stage.checks) {
			const order = checks.indexOf(check);
			if (order < 0 || order <= previous) fail("host backend stages must follow contract/compile/correctness/measurement order without duplicates");
			previous = order;
		}
	}
}

/** Two executable tools; there is no model-selected callback, executable command, or backend module field. */
export function createCandidateExecutionTools(options: CandidateExecutionToolOptions): CustomToolSpec[] {
	validateBackend(options.backend);
	const backendIdentity = { id: options.backend.id, version: options.backend.version, stages: structuredClone(options.backend.stages) };
	const binding = JSON.stringify([options.goalRunId, options.taskId, options.operationId, options.subjectId, backendIdentity]);
	const protocolIds = options.backend.protocolIds ? [...options.backend.protocolIds] : undefined;
	const backendHelp = ` Backend: ${options.backend.id}@${options.backend.version}.` +
		(protocolIds ? ` Supported protocolIds: ${protocolIds.join(", ")}.` : "") +
		(options.backend.configurationHelp ? ` Configuration: ${options.backend.configurationHelp}` : "");
	function validateProtocol(protocolId: string) {
		if (protocolIds && !protocolIds.includes(protocolId)) fail(`unsupported protocolId: ${protocolId}; use ${protocolIds.join(", ")}`);
	}
	const events = options.searchEventLogFile ? openSearchEventLog(options.searchEventLogFile) : undefined;
	let eventLogError: string | undefined;
	/** A log that cannot be written is reported to the model, never silently dropped,
	 * and never fails the execution it was only describing. */
	const record = async (event: Omit<SearchEventInput, "runId">): Promise<void> => {
		if (!events) return;
		try { await events.append({ ...event, runId: options.goalRunId, taskId: options.taskId }); }
		catch (error) { eventLogError = (error as Error).message; }
	};
	let tail: Promise<void> = Promise.resolve();
	const serial = (run: (args: Record<string, unknown>, signal?: AbortSignal) => Promise<ToolResult>) =>
		(args: Record<string, unknown>, signal?: AbortSignal) => {
			const next = tail.then(() => run(args, signal)); tail = next.then(() => undefined, () => undefined); return next;
		};
	async function roots() {
		const work = await realpath(options.workDir);
		await mkdir(options.journalDir, { recursive: true });
		const journals = await realpath(options.journalDir);
		if (journals === work || inside(work, journals)) fail("execution journal must be outside model workDir");
		return { work, journals };
	}
	async function save(file: string, journal: Journal | SweepJournal) {
		journal.updatedAt = new Date().toISOString(); await writeFileAtomic(file, json(journal));
	}
	async function unresolved(dir: string, except: string): Promise<string | undefined> {
		return (await pendingCandidateExecutions({ journalDir: dir, goalRunId: options.goalRunId,
			taskId: options.taskId, operationId: options.operationId, backend: options.backend }))
			.find(item => item.journalPath !== except)?.journalPath;
	}
	async function freezeSources(request: Request, root: string, work: string, runId: string) {
		const sources: Journal["sources"] = [];
		for (const declaredPath of request.sourcePaths) {
			const original = await regular(work, declaredPath);
			const frozenPath = path.join(root, "sources", declaredPath);
			const absolutePath = path.join(work, ".candidate-runs", runId, "sources", declaredPath);
			await mkdir(path.dirname(frozenPath), { recursive: true });
			await copyFile(original, frozenPath);
			if (!(await readFile(original)).equals(await readFile(frozenPath))) fail("source changed while taking execution snapshot");
			await safeDirectory(work, path.dirname(absolutePath));
			const bytes = await readFile(frozenPath);
			try { await writeFile(absolutePath, bytes, { flag: "wx" }); }
			catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST" || !(await readFile(await regular(work, path.relative(work, absolutePath)))).equals(bytes)) throw error;
			}
			await regular(work, path.relative(work, absolutePath));
			sources.push({ declaredPath, absolutePath, frozenPath });
		}
		return sources;
	}
	async function verifySources(journal: Journal, work: string) {
		for (const source of journal.sources) {
			await regular(work, path.relative(work, source.absolutePath));
			if (!(await readFile(source.absolutePath)).equals(await readFile(source.frozenPath))) fail("execution snapshot was modified; no further stage or verification is authorized");
		}
	}
	function projection(journal: Journal, file: string): ToolResult {
		return { text: JSON.stringify({ runId: journal.runId, status: journal.state, journalPath: file,
			...(eventLogError ? { eventLogError } : {}),
			backend: journal.backend, unsupportedChecks: checks.filter(check => !journal.backend.stages.some(stage => stage.checks.includes(check))),
			stages: journal.stages.map(entry => ({ stage: entry.stage, status: entry.status, attempts: entry.attempts,
				externalId: entry.externalId, performedChecks: entry.result?.performedChecks,
				receiptCount: entry.receiptSnapshots?.length ?? 0, error: entry.error, summary: entry.result?.summary })),
			evaluation: journal.evaluation?.text,
			evaluationError: journal.evaluationError,
			message: ["pending", "unknown", "running"].includes(journal.state)
				? "This run is unresolved, not a goal stop. Use this same runId with resume:true to query its original externalId. No automatic resubmission. If no ID was recorded, reconcile the original operation through host recovery."
				: "Checks and delegated coverage are backend facts. Candidate verification and goal admission remain separate; original receipts and execution journal are retained." }) };
	}
	async function runOne(args: Record<string, unknown>, signal?: AbortSignal, override?: { root: string; request: Request }): Promise<ToolResult> {
		const runId = identity(args.runId), { work, journals } = await roots();
		const root = override?.root ?? path.join(journals, runId), file = path.join(root, "journal.json");
		let journal = await readJson<Journal>(file);
		if (journal) {
			if (journal.kind !== "candidate" || journal.goalRunId !== options.goalRunId || journal.taskId !== options.taskId || journal.operationId !== options.operationId || journal.subjectId !== options.subjectId || JSON.stringify(journal.backend) !== JSON.stringify(backendIdentity)) fail("existing run belongs to a different host binding; cannot execute or query");
			validateProtocol(journal.request.protocolId);
			if (args.resume !== true) return projection(journal, file);
		} else {
			if (args.resume === true || options.queryOnly) fail("unknown runId; recovery never starts a new side effect");
			const blocked = await unresolved(journals, file); if (blocked) fail(`unresolved earlier execution: ${blocked}; query its original ID before new execution`);
			const request = override?.request ?? requestFrom(args);
			validateProtocol(request.protocolId);
			await options.backend.validateRequest?.({ protocolId: request.protocolId, sourcePaths: [...request.sourcePaths], config: structuredClone(request.config), subjectId: options.subjectId });
			await mkdir(root, { recursive: Boolean(override) });
			const sources = await freezeSources(request, root, work, runId);
			journal = { version: 1, kind: "candidate", runId, goalRunId: options.goalRunId, taskId: options.taskId,
				operationId: options.operationId, ...(options.subjectId ? { subjectId: options.subjectId } : {}), backend: backendIdentity,
				request, sources, stages: [], state: "prepared", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
			await save(file, journal);
			await record({ kind: "candidate-submitted", candidate: { id: runId, pathRef: file,
				...(request.parentCandidateId ? { parentId: request.parentCandidateId } : {}),
				...(options.subjectId ? { subjectId: options.subjectId } : {}), status: "prepared" },
				detail: { changeKind: request.changeKind, intent: request.intent,
					...(request.strategy ? { strategy: request.strategy } : {}) } });
		}
		const active = journal;
		for (let index = 0; index < backendIdentity.stages.length; index++) {
			const stage = backendIdentity.stages[index];
			let entry = active.stages[index];
			if (entry?.status === "passed") continue;
			if (entry?.status === "failed") break;
			if (signal?.aborted) break;
			const querying = entry !== undefined;
			if (!querying && options.queryOnly) break;
			if (querying && (!entry!.externalId || !options.backend.queryStage || (options.backend.canQueryStage && !options.backend.canQueryStage(stage.id)))) return projection(active, file);
			const blocked = await unresolved(journals, file); if (blocked) fail(`unresolved earlier execution: ${blocked}`);
			await verifySources(active, work);
			const outputDir = path.join(work, ".candidate-runs", runId, "stages", stage.id);
			await safeDirectory(work, outputDir);
			if (!inside(work, await realpath(outputDir))) fail("backend output directory escaped task workDir");
			if (!entry) { entry = { stage, status: "running" }; active.stages.push(entry); }
			const current = entry;
			current.status = "running"; current.attempts = (current.attempts ?? 0) + 1; active.state = "running";
			await save(file, active); // Durable intent precedes every side effect or original-ID query.
			const context: CandidateExecutionContext = { goalRunId: options.goalRunId, taskId: options.taskId, operationId: options.operationId,
				subjectId: options.subjectId, runId, workDir: work, sourcePaths: active.sources.map(source => path.relative(work, source.absolutePath)),
				sources: structuredClone(active.sources), config: structuredClone(active.request.config), protocolId: active.request.protocolId,
				stage: structuredClone(stage), outputDir, signal,
				async recordExternalId(id) {
					if (typeof id !== "string" || !id.trim() || (current.externalId && current.externalId !== id)) fail("backend attempted to replace an original external ID");
					current.externalId = id; await save(file, active);
				} };
			try {
				const result = querying ? await options.backend.queryStage!({ ...context, externalId: current.externalId! }) : await options.backend.executeStage(context);
				if (result.externalId) await context.recordExternalId(result.externalId);
				if (!["passed", "failed", "pending", "unknown"].includes(result.status) || !Array.isArray(result.receiptPaths)) fail("invalid backend stage result");
				if (result.performedChecks && (!Array.isArray(result.performedChecks) || result.performedChecks.some(check => !stage.checks.includes(check)))) fail("backend performedChecks exceeds its declared stage coverage");
				for (const receipt of result.receiptPaths) await regular(work, receipt);
				if (result.evaluationReceiptPaths?.some(receipt => !result.receiptPaths.includes(receipt))) fail("evaluation receipts must belong to this stage's original receipts");
				await verifySources(active, work);
				const snapshots: NonNullable<StageEntry["receiptSnapshots"]> = [];
				for (let receiptIndex = 0; receiptIndex < result.receiptPaths.length; receiptIndex++) {
					const originalPath = result.receiptPaths[receiptIndex], original = await regular(work, originalPath);
					const suffix = path.join(stage.id, String(current.attempts), `${receiptIndex}-${path.basename(original)}`);
					const frozenPath = path.join(root, "receipts", suffix);
					const target = path.join(work, ".candidate-runs", runId, "receipts", suffix);
					await mkdir(path.dirname(frozenPath), { recursive: true });
					await copyFile(original, frozenPath);
					if (!(await readFile(original)).equals(await readFile(frozenPath))) fail("stage receipt changed while freezing");
					await safeDirectory(work, path.dirname(target));
					await writeFile(target, await readFile(frozenPath), { flag: "wx" });
					snapshots.push({ originalPath, frozenPath, evaluationPath: path.relative(work, target) });
				}
				current.receiptSnapshots = [...(current.receiptSnapshots ?? []), ...snapshots];
				current.status = result.status; current.result = structuredClone(result); delete current.error;
				active.state = result.status === "passed" ? "prepared" : result.status;
				await save(file, active);
			} catch (error) {
				current.status = "unknown"; current.error = (error as Error).message; active.state = "unknown";
				await save(file, active); return projection(active, file);
			}
			await record({ kind: "candidate-stage", candidate: { id: runId, stage: stage.id, status: current.status,
				...(options.subjectId ? { subjectId: options.subjectId } : {}) },
				...(current.externalId ? { detail: { externalId: current.externalId } } : {}) });
			if (current.status !== "passed") break;
		}
		if (active.stages.length === backendIdentity.stages.length && active.stages.every(stage => stage.status === "passed")) active.state = "completed";
		await save(file, active);
		const final = active.stages.at(-1);
		const evaluationReceipts = final?.result?.evaluationReceiptPaths ?? (final?.stage.checks.includes("measurement") ? final.result?.receiptPaths : undefined);
		if (!active.evaluation && evaluationReceipts?.length && (active.state === "completed" || active.state === "failed")) {
			try {
				await verifySources(active, work);
				const receiptPaths: string[] = [];
				for (const receipt of evaluationReceipts) {
					const snapshot = final?.receiptSnapshots?.findLast(item => item.originalPath === receipt);
					if (!snapshot) return fail("evaluation receipt snapshot is missing");
					const actual = await regular(work, snapshot.evaluationPath);
					if (!(await readFile(actual)).equals(await readFile(snapshot.frozenPath))) fail("evaluation receipt snapshot was modified");
					receiptPaths.push(snapshot.evaluationPath);
				}
				active.evaluation = await options.evaluate({ ...active.request, sourcePaths: active.sources.map(source => path.relative(work, source.absolutePath)), receiptPaths });
				delete active.evaluationError;
			} catch (error) { active.evaluationError = (error as Error).message; }
			await save(file, active);
		}
		await record({ kind: "candidate-evaluated", candidate: { id: runId, pathRef: file, status: active.state,
			isBuggy: active.state !== "completed" || Boolean(active.evaluationError),
			...(options.subjectId ? { subjectId: options.subjectId } : {}) },
			...(active.evaluationError ? { detail: { evaluationError: active.evaluationError } } : {}) });
		return projection(active, file);
	}
	async function sweep(args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult> {
		const readArchive = [
			{ tool: "candidate_list", args: { section: "global-best" } },
			{ tool: "candidate_list", args: { section: "search-leads" } },
		];
		const resultOffset = args.resultOffset ?? 0, resultLimit = args.resultLimit ?? 10;
		if (!Number.isSafeInteger(resultOffset) || Number(resultOffset) < 0 ||
			!Number.isSafeInteger(resultLimit) || Number(resultLimit) < 1 || Number(resultLimit) > 100)
			fail("resultOffset/resultLimit must be a nonnegative offset and page length 1..100");
		const runId = identity(args.runId), { work, journals } = await roots();
		const root = path.join(journals, runId), file = path.join(root, "journal.json");
		const valuesAt = (manifest: SweepJournal, index: number) => {
			const values: Record<string, number> = {}; let remainder = index;
			for (const [key, domain] of Object.entries(manifest.domains).reverse()) {
				values[key] = domain[remainder % domain.length]; remainder = Math.floor(remainder / domain.length);
			}
			return values;
		};
		const resultsPage = async (manifest: SweepJournal) => {
			const current = manifest.nextIndex < manifest.total ? await readJson<Journal>(path.join(root, "runs",
				String(manifest.nextIndex + 1), "journal.json")) : undefined;
			const started = manifest.nextIndex + (current ? 1 : 0);
			const offset = Math.min(started, Number(resultOffset));
			const end = Math.min(started, offset + Number(resultLimit));
			const rows: Array<Record<string, unknown>> = [];
			for (let position = offset; position < end; position++) {
				const index = started - position - 1, childId = `${runId}--${index + 1}`;
				const childPath = path.join(root, "runs", String(index + 1), "journal.json");
				const child = await readJson<Journal>(childPath);
				const values = valuesAt(manifest, index);
				const sourcePaths = manifest.request.sourcePaths.map(source => path.join(".candidate-runs", runId,
					"materialized", String(index + 1), source));
				if (!child || child.kind !== "candidate" || child.runId !== childId || child.goalRunId !== options.goalRunId ||
					child.taskId !== options.taskId || child.operationId !== options.operationId || child.subjectId !== options.subjectId ||
					JSON.stringify(child.backend) !== JSON.stringify(backendIdentity) ||
					child.request.protocolId !== manifest.request.protocolId ||
					JSON.stringify(child.request.sourcePaths) !== JSON.stringify(sourcePaths) ||
					JSON.stringify(child.request.config) !== JSON.stringify({ ...manifest.request.config, parameters: values }))
					fail(`sweep child ${childId} does not match its frozen source, protocol, parameters or host binding`);
				let evaluated: Record<string, unknown> | undefined;
				try {
					const parsed = child.evaluation?.text && JSON.parse(child.evaluation.text);
					if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) evaluated = parsed as Record<string, unknown>;
				} catch { /* The original evaluation text remains in the child journal. */ }
				const ref = evaluated?.candidateRef;
				const candidateRef = typeof ref === "string" && ref.startsWith(`${options.taskId}/`) &&
					/^C\d{3,}$/.test(ref.slice(options.taskId.length + 1)) ? ref : undefined;
				const observation = evaluated?.observation && typeof evaluated.observation === "object" &&
					!Array.isArray(evaluated.observation) ? evaluated.observation as Record<string, unknown> : undefined;
				const stage = child.stages.at(-1);
				rows.push({ index, runId: childId, parameters: values, protocolId: child.request.protocolId,
					sourcePaths, status: child.state, journalPath: childPath,
					...(stage ? { lastStage: { id: stage.stage.id, status: stage.status,
						performedChecks: stage.result?.performedChecks, summary: stage.result?.summary,
						error: stage.error } } : {}),
					...(candidateRef ? { candidateRef, readCandidate: { tool: "candidate_read", args: { candidateRef } } } : {}),
					...(observation ? { sourceBinding: observation.sourceBinding, correctness: observation.correctness,
						metricCount: Array.isArray(observation.metrics) ? observation.metrics.length : undefined } : {}),
					...(child.evaluationError ? { evaluationError: child.evaluationError } : {}) });
			}
			return { order: "newest-first", total: started, offset, end,
				nextOffset: end < started ? end : null, rows };
		};
		let manifest = await readJson<SweepJournal>(file);
		if (!manifest) {
			if (args.resume === true || options.queryOnly) fail("unknown sweep runId");
			const request = requestFrom({ ...args, changeKind: "parameters", strategy: "numerical-parameters" });
			validateProtocol(request.protocolId);
			await options.backend.validateRequest?.({ protocolId: request.protocolId, sourcePaths: [...request.sourcePaths], config: structuredClone(request.config), subjectId: options.subjectId });
			const raw = objectJson(args.domainsJson, "domainsJson"), domains: Record<string, number[]> = {};
			let total = 1;
			for (const [key, values] of Object.entries(raw)) {
				if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(key) || !Array.isArray(values) || !values.length || values.some(value => typeof value !== "number" || !Number.isFinite(value)) || new Set(values).size !== values.length) fail("each parameter domain must be a nonempty array of distinct finite numbers");
				domains[key] = values; total *= values.length;
				if (!Number.isSafeInteger(total)) fail("parameter product exceeds exact integer indexing; split the explicit domain");
			}
			if (!Object.keys(domains).length) fail("parameter domains must not be empty");
			await mkdir(root);
			const templatePaths: string[] = [];
			for (const source of request.sourcePaths) {
				const original = await regular(work, source), target = path.join(root, "templates", source);
				await mkdir(path.dirname(target), { recursive: true }); await copyFile(original, target);
				if (!(await readFile(original)).equals(await readFile(target))) fail("template changed while freezing");
				templatePaths.push(target);
			}
			const templates = await Promise.all(templatePaths.map(file => readFile(file, "utf8")));
			for (const key of Object.keys(domains)) if (!templates.some(text => text.includes(`{{${key}}}`))) fail(`parameter ${key} has no template placeholder`);
			for (const template of templates) for (const match of template.matchAll(/\{\{([A-Za-z][A-Za-z0-9_]*)\}\}/g)) if (!Object.hasOwn(domains, match[1])) fail(`template parameter ${match[1]} lacks a domain`);
			manifest = { version: 1, kind: "sweep", runId, binding, request, domains, total, nextIndex: 0, templatePaths, updatedAt: new Date().toISOString() };
			await save(file, manifest);
		} else if (manifest.kind !== "sweep") fail("runId is already a candidate run");
		else if (manifest.binding !== binding) fail("existing sweep belongs to a different host binding");
		else if (args.resume !== true) return { text: JSON.stringify({ runId, total: manifest.total, completed: manifest.nextIndex,
			journalPath: file, resultsPage: await resultsPage(manifest), readArchive,
			message: "This is a read-only page of the existing sweep. Use resume:true to continue the declared sweep; existing combinations are never submitted twice." }) };
		validateProtocol(manifest.request.protocolId);
		let last: ToolResult | undefined;
		for (; manifest.nextIndex < manifest.total;) {
			if (signal?.aborted) break;
			const index = manifest.nextIndex, childId = `${runId}--${index + 1}`;
			const childRoot = path.join(root, "runs", String(index + 1));
			const existing = await readJson<Journal>(path.join(childRoot, "journal.json"));
			if (!existing && options.queryOnly) break;
			const values = valuesAt(manifest, index);
			const sourcePaths: string[] = [];
			if (!existing) for (let i = 0; i < manifest.templatePaths.length; i++) {
				const relative = path.join(".candidate-runs", runId, "materialized", String(index + 1), manifest.request.sourcePaths[i]);
				const target = path.join(work, relative);
				await safeDirectory(work, path.dirname(target));
				const template = await readFile(manifest.templatePaths[i], "utf8");
				const text = template.replace(/\{\{([A-Za-z][A-Za-z0-9_]*)\}\}/g, (_, key: string) => String(values[key]));
				try { await writeFile(target, text, { flag: "wx" }); }
				catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "EEXIST" || await readFile(await regular(work, relative), "utf8") !== text) throw error;
				}
				sourcePaths.push(relative);
			}
			await mkdir(path.dirname(childRoot), { recursive: true });
			last = await runOne({ runId: childId, resume: Boolean(existing) }, signal, { root: childRoot,
				request: { ...manifest.request, sourcePaths, config: { ...manifest.request.config, parameters: values } } });
			const child = await readJson<Journal>(path.join(childRoot, "journal.json"));
			if (!child || !["completed", "failed"].includes(child.state) || child.evaluationError) break;
			manifest.nextIndex++; await save(file, manifest);
		}
		return { text: JSON.stringify({ runId, total: manifest.total, completed: manifest.nextIndex, journalPath: file,
			status: manifest.nextIndex === manifest.total ? "completed" : "incomplete", last: last?.text,
			resultsPage: await resultsPage(manifest), readArchive,
			message: "last is the most recently executed combination, not the best result. resultsPage links each recorded parameter vector to its candidateRef when evaluation produced one; candidate_read can inspect that exact frozen candidate. Page older combinations with resultOffset/resultLimit and omit resume for a read-only view. Use readArchive to inspect verified bests by subject/basis and case-local leads. All declared combinations remain recorded; no performance pruning or goal-wide budget. Resume this runId to query any unresolved original ID and continue unstarted combinations. Stages without verifiable evaluation receipts remain execution evidence only." }) };
	}
	type BackgroundJob = { runId: string; tool: string; startedAt: string; promise: Promise<ToolResult>;
		/** Resolves only after the outcome has also been recorded. */
		completion: Promise<void>;
		settled?: { at: string; result?: ToolResult; error?: string } };
	const jobs = new Map<string, BackgroundJob>();
	const maxBackground = Math.max(1, options.backgroundRuns?.max ?? 4);
	const outstanding = () => [...jobs.values()].filter(job => !job.settled);
	const drain = async (): Promise<void> => {
		// Settled or rejected, every background run is awaited: a prompt must not end
		// while the host is still producing side effects nobody is waiting for.
		while (outstanding().length) await Promise.allSettled(outstanding().map(job => job.completion));
	};
	options.backgroundRuns?.register(drain);
	const jobView = (job: BackgroundJob) => ({ runId: job.runId, tool: job.tool, startedAt: job.startedAt,
		state: job.settled ? (job.settled.error ? "failed" : "settled") : "running",
		...(job.settled ? { finishedAt: job.settled.at, ...(job.settled.error ? { error: job.settled.error } : {}) } : {}) });
	const startBackground = (tool: string, args: Record<string, unknown>, signal: AbortSignal | undefined,
		run: (args: Record<string, unknown>, signal?: AbortSignal) => Promise<ToolResult>): ToolResult => {
		if (!options.backgroundRuns) fail("this host did not enable background candidate runs");
		const runId = identity(args.runId);
		const existing = jobs.get(runId);
		if (existing && !existing.settled) fail(`background run ${runId} is still running; collect it before submitting it again`);
		if (outstanding().length >= maxBackground) fail(`at most ${maxBackground} background runs may be outstanding; collect one first`);
		const promise = serial(run)({ ...args, background: undefined, collect: undefined }, signal);
		const completion = promise.then(
			result => { job.settled = { at: new Date().toISOString(), result }; },
			error => { job.settled = { at: new Date().toISOString(), error: (error as Error).message }; },
		).then(() => record({ kind: "background-settled", candidate: { id: runId, status: job.settled?.error ? "failed" : "settled",
			...(job.settled?.error ? { isBuggy: true } : {}) },
			...(job.settled?.error ? { detail: { error: job.settled.error } } : {}) }));
		const job: BackgroundJob = { runId, tool, startedAt: new Date().toISOString(), promise, completion };
		jobs.set(runId, job);
		void record({ kind: "background-queued", candidate: { id: runId,
			...(options.subjectId ? { subjectId: options.subjectId } : {}), status: "queued" },
			detail: { tool, outstanding: outstanding().length } });
		// Settled jobs are kept so a later collect is idempotent; the oldest are pruned.
		for (const [key, value] of [...jobs.entries()].slice(0, Math.max(0, jobs.size - 32)))
			if (value.settled) jobs.delete(key);
		return { text: JSON.stringify({ runId, state: "running", outstanding: outstanding().length,
			collect: { tool, args: { runId, collect: true } },
			message: "The host is executing this run. Keep working on other candidates, then collect this runId. Nothing is resubmitted by collecting." }) };
	};
	const collectBackground = async (args: Record<string, unknown>, signal: AbortSignal | undefined,
		run: (args: Record<string, unknown>, signal?: AbortSignal) => Promise<ToolResult>): Promise<ToolResult> => {
		if (args.runId === undefined)
			return { text: JSON.stringify({ jobs: [...jobs.values()].map(jobView), outstanding: outstanding().length }) };
		const runId = identity(args.runId);
		const job = jobs.get(runId);
		// Without a live job this is an ordinary read of the durable journal, which is
		// also what a restarted process sees. Collect never starts anything.
		if (!job) {
			const { journals } = await roots();
			try { await lstat(path.join(journals, runId)); }
			catch { fail(`unknown runId ${runId}: nothing was submitted in this session and no execution journal exists`); }
			return serial(run)({ runId }, signal);
		}
		if (!job.settled) return { text: JSON.stringify({ ...jobView(job), outstanding: outstanding().length,
			message: "Still running. Collect again later; the journal keeps the durable state either way." }) };
		if (job.settled.error) fail(`background run ${runId} failed: ${job.settled.error}`);
		return job.settled.result!;
	};
	const withBackground = (tool: string, run: (args: Record<string, unknown>, signal?: AbortSignal) => Promise<ToolResult>) =>
		async (args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult> => {
			if (args.collect === true) return collectBackground(args, signal, run);
			if (args.background === true) return startBackground(tool, args, signal, run);
			return serial(run)(args, signal);
		};
	const common: CustomToolSpec["params"] = {
		runId: { type: "string", description: "Unique task-local execution identity; reuse with resume:true to query, never to resubmit" },
		resume: { type: "boolean", optional: true, description: "Query the existing original external ID and continue only unstarted stages/combinations" },
		sourcePaths: { type: "string[]", optional: true, description: "New run: exact task-relative source files; sweep templates use {{PARAMETER}} numeric placeholders" },
		configJson: { type: "string", optional: true, description: "New run: backend-specific JSON configuration object; the host validates its contract." + backendHelp },
		protocolId: { type: "string", optional: true, description: "New run: exact host-supported measurement/validation protocol binding." + (protocolIds ? ` Allowed: ${protocolIds.join(", ")}` : "") },
		hypothesis: { type: "string", optional: true, description: "New run: what the candidate or declared parameter sweep tests" },
		changeKind: { type: "string", optional: true, description: "New candidate_run: repair, structure, or parameters" },
		intent: { type: "string", optional: true, description: "New run: solution or diagnostic" },
		parentCandidateId: { type: "string", optional: true, description: "Optional exact local Cxxx or archived Txxx/Cxxx parent" },
		conditions: { type: "string[]", optional: true, description: "Declared applicability, not a host-proven conclusion" },
		changeSummary: { type: "string", optional: true, description: "Declared source change" },
		strategy: { type: "string", optional: true, description: "New run: the one enumerated optimization strategy candidate_evaluate requires" },
		location: { type: "string", optional: true, description: "New run: the one exact edit site candidate_evaluate requires" },
		newEvidence: { type: "string", optional: true, description: "Only when repeating a direction the host banned after a stall" },
		background: { type: "boolean", optional: true, description: "Submit and return immediately; the host keeps executing while you work on another candidate. Collect the same runId later." },
		collect: { type: "boolean", optional: true, description: "Report a background run submitted in this session, returning its result once finished; omit runId to list background runs. Collecting never resubmits." },
	};
	return [{ name: "candidate_run", description: "Execute the host-bound backend against frozen source bytes with durable stage intent, then call existing candidate_evaluate. Unknown external operations require original-ID query; no automatic retry." + backendHelp, params: common, execute: withBackground("candidate_run", runOne) },
		{ name: "candidate_sweep", description: "Materialize and evaluate every combination of explicitly declared finite numeric template parameters through the same host backend, without a model call for each number. An existing runId without resume reads paged parameter-to-candidate results without execution. No fixed search width or score pruning." + backendHelp, params: { ...common,
			domainsJson: { type: "string", optional: true, description: "New sweep: JSON object mapping placeholder names to explicit finite numeric arrays" },
			resultOffset: { type: "number", optional: true, description: "Read-only result page offset in newest-first order, default 0" },
			resultLimit: { type: "number", optional: true, description: "Result page length, default 10, at most 100; this does not limit the sweep" } }, execute: withBackground("candidate_sweep", sweep) }];
}
