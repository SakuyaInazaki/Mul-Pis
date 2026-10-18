/** Read-only, stage-aware access to the task's existing knowledge epoch.
 * The files here are call evidence, not a second knowledge/selection store. */
import { mkdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { RETRIEVAL_SCALAR_KEYS, validateKnowledgeRetrievalContext, type KnowledgeRetrievalContext } from "../knowledge/retrieval.ts";
import { recordDependencyIndex, renderOriginalRecord, selectKnowledgePage } from "../knowledge/session-tools.ts";
import { readOptimizationCard, type OptimizationCard } from "../knowledge/optimization-card.ts";
import { checkCandidate, type ConstraintObservation } from "../knowledge/static-checks.ts";
import type { KnowledgeStore, Limit, Snapshot } from "../knowledge/types.ts";
import type { CustomToolSpec, ToolResult } from "../runner/types.ts";
import { HarnessError } from "../types.ts";
import { writeFileAtomic } from "../workspace.ts";

export interface KnowledgeAccessEvent {
	id: string;
	kind: "select" | "read" | "artifact" | "check";
	at: string;
	snapshot?: string;
	status: "returned" | "failed";
	selectedRefs: string[];
	/** Only records whose discovery cards were returned on this selection page. */
	returnedRefs?: string[];
	/** Host-owned JSON containing the request, exact returned page/text and access state. */
	frozenPath: string;
	returnedRange?: { offset: number; end: number; total: number; content: "index" | "brief" | "record" | "artifact" | "artifact-index" | "contract-check"; unit?: "records" };
}

export interface ExecutionKnowledgeOptions {
	store: KnowledgeStore;
	expectedSnapshot?: string;
	requiredIds: readonly string[];
	context?: KnowledgeRetrievalContext;
	archiveDir: string;
	/** Enables exact M04-published, checkpoint-frozen artifact reading. */
	workspaceRoot?: string;
	/** Task work directory. Enables the pre-compile contract check on files the
	 * execution session itself wrote; it is never a second read tool. */
	candidateRoot?: string;
	beforeAccess?(): Promise<void>;
	onAccess(event: KnowledgeAccessEvent): Promise<void>;
}

const refPattern = /^([CKEJQDX]\d{3,})(?:@(\d+))?$/;
const contextKeys = ["stage", "backend", "toolchain", "dtype", "layout", "structure", "appliedTransforms", "symptoms"] as const;
const contextParams: CustomToolSpec["params"] = Object.fromEntries(contextKeys.map(key => [key, {
	type: ["structure", "appliedTransforms", "symptoms"].includes(key) ? "string[]" : "string",
	description: `Optional explicit ${key}; omit unknown values. This is applicability, not source provenance.`, optional: true,
}])) as CustomToolSpec["params"];
const rangeParams: CustomToolSpec["params"] = {
	offset: { type: "number", description: "UTF-16 character offset, default 0", optional: true },
	limit: { type: "number", description: "Returned page size in UTF-16 characters, default 6000, at most 12000; continue at returned end", optional: true },
};
const selectRangeParams: CustomToolSpec["params"] = {
	offset: { type: "number", description: "Result record ordinal, default 0", optional: true },
	limit: { type: "number", description: "Records on this page, default 12, at most 100; continue at returned end", optional: true },
};

function inside(root: string, target: string): boolean {
	const relative = path.relative(root, target);
	return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

type ArtifactRecord = { source: { stage: string; runId: string }; fields: Record<string, unknown> };
type AcceptedArtifact = { taskId: string; relativePath: string; sourceRelativePath?: string; path: string };
type ExcludedTask = { taskId: string; reason: string };
const safeRelative = (value: unknown): value is string => typeof value === "string" && value.length > 0 &&
	!path.isAbsolute(value) && value.split(/[\\/]/u).every(part => !!part && part !== "." && part !== "..");

/** One authority path for both catalogue discovery and exact reads. A record's
 * prose or unverified receipt number never grants access to a task file. */
async function acceptedArtifactRows(workspaceRoot: string, record: ArtifactRecord): Promise<{
	root: string; m07Dir: string; m07RunId: string; taskIds: string[]; source: string;
	acceptedTaskIds: string[]; excluded: ExcludedTask[]; rows: AcceptedArtifact[];
}> {
	const declared = record.fields.task === undefined ? record.fields.tasks : [record.fields.task];
	const taskIds = Array.isArray(declared) ? declared : [];
	if (record.source.stage !== "M04" || !/^\d{8}T\d{6}Z-[a-z0-9]+$/u.test(record.source.runId) ||
		!taskIds.length || taskIds.some(item => typeof item !== "string" || !/^T\d{3,}$/u.test(item)) ||
		new Set(taskIds).size !== taskIds.length)
		throw new HarnessError("m07.knowledge", "record has no exact M04 source task identity");
	const root = await realpath(workspaceRoot);
	const m04Dir = path.join(root, "stages", "M04", record.source.runId);
	if (!inside(root, await realpath(m04Dir))) throw new HarnessError("m07.knowledge", "M04 source escapes workspace");
	const run = JSON.parse(await readFile(path.join(m04Dir, "run.json"), "utf8")) as { status?: string; runId?: string };
	if (run.status !== "completed" || run.runId !== record.source.runId) throw new HarnessError("m07.knowledge", "source M04 run is not completed");
	const source = JSON.parse(await readFile(path.join(m04Dir, "m07-source.json"), "utf8")) as { m07RunId?: string; checkpointId?: string; selectedTaskIds?: string[] };
	if (!source.m07RunId || !/^[\w-]+$/u.test(source.m07RunId) || !source.checkpointId || !/^C\d{3,}$/u.test(source.checkpointId))
		throw new HarnessError("m07.knowledge", "M04 source has no selected checkpoint");
	const m07Dir = path.join(root, "stages", "M07", source.m07RunId);
	if (!inside(root, await realpath(m07Dir))) throw new HarnessError("m07.knowledge", "M07 source escapes workspace");
	const checkpointRoot = path.join(m07Dir, "checkpoints", source.checkpointId);
	const realCheckpointRoot = await realpath(checkpointRoot);
	if (!inside(root, realCheckpointRoot)) throw new HarnessError("m07.knowledge", "checkpoint escapes workspace");
	const frozenGoal = JSON.parse(await readFile(path.join(checkpointRoot, "goal.json"), "utf8")) as { runId?: string; tasks?: Array<{ taskId?: string; status?: string; review?: { artifacts?: Array<{ path?: string }> } }> };
	const manifest = JSON.parse(await readFile(path.join(checkpointRoot, "manifest.json"), "utf8")) as { m07RunId?: string; checkpointId?: string; selectedTaskIds?: string[]; files?: Array<{ sourceRelativePath?: string; relativePath?: string }> };
	if (manifest.m07RunId !== source.m07RunId || manifest.checkpointId !== source.checkpointId || frozenGoal.runId !== source.m07RunId)
		throw new HarnessError("m07.knowledge", "checkpoint does not match the M04 source");
	const rows: AcceptedArtifact[] = [];
	const seen = new Set<string>();
	const acceptedTaskIds: string[] = [], excluded: ExcludedTask[] = [];
	for (const taskId of taskIds) {
		if (!source.selectedTaskIds?.includes(taskId) || !manifest.selectedTaskIds?.includes(taskId)) {
			excluded.push({ taskId, reason: "not selected by both M04 source and checkpoint" });
			continue;
		}
		const frozenTask = frozenGoal.tasks?.find(item => item.taskId === taskId);
		if (frozenTask?.status !== "accepted" || !Array.isArray(frozenTask.review?.artifacts)) {
			excluded.push({ taskId, reason: "selected task has no accepted frozen review" });
			continue;
		}
		acceptedTaskIds.push(taskId);
		const reviewedPaths = await Promise.all((frozenTask.review?.artifacts ?? []).map(async item =>
			typeof item.path === "string" ? await realpath(item.path).catch(() => null) : null));
		const reviewed = new Set(reviewedPaths.filter((value): value is string => !!value));
		for (const item of manifest.files ?? []) {
			const relativePath = item.relativePath;
			if (!safeRelative(relativePath) || !relativePath.startsWith(`evidence/tasks/${taskId}/review-snapshot/`)) continue;
			if (seen.has(relativePath)) throw new HarnessError("m07.knowledge", "selected checkpoint has duplicate artifact paths");
			const frozen = await realpath(path.join(checkpointRoot, relativePath)).catch(() => null);
			if (!frozen || !inside(realCheckpointRoot, frozen) || !reviewed.has(frozen)) continue;
			seen.add(relativePath);
			rows.push({ taskId, relativePath, ...(safeRelative(item.sourceRelativePath) ? { sourceRelativePath: item.sourceRelativePath } : {}), path: frozen });
		}
	}
	if (!acceptedTaskIds.length) throw new HarnessError("m07.knowledge", "M04 source does not select this task or checkpoint has no accepted selected task");
	return { root, m07Dir, m07RunId: source.m07RunId, taskIds, source: `${record.source.runId}/${source.checkpointId}`,
		acceptedTaskIds, excluded, rows };
}

export function textArtifact(bytes: Uint8Array): boolean {
	try { return !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
	catch { return false; }
}

/** Catalogue entries are same-source accepted review files, not assertions that
 * each one supports this particular knowledge claim. */
export async function publishedArtifactCatalogue(workspaceRoot: string, record: ArtifactRecord): Promise<{ paths: string[]; source: string; excluded: ExcludedTask[] }> {
	const accepted = await acceptedArtifactRows(workspaceRoot, record);
	const paths: string[] = [];
	for (const row of accepted.rows) if (textArtifact(await readFile(row.path))) paths.push(row.relativePath);
	return { paths: paths.sort(), source: `${accepted.source}/${accepted.acceptedTaskIds.join(",")}`, excluded: accepted.excluded };
}

/** A model-authored fields.artifact is only a lookup hint. Authorization comes
 * from the published M04 source, accepted task review, and checkpoint manifest. */
export async function publishedArtifact(workspaceRoot: string, record: ArtifactRecord, requested?: unknown): Promise<{ path: string; source: string }> {
	const registered = [
		...(typeof record.fields.artifact === "string" ? [{ kind: "source" as const, value: record.fields.artifact }] : []),
		...(typeof record.fields.candidate === "string" ? [{ kind: "candidate" as const, value: record.fields.candidate }] : []),
		...(Array.isArray(record.fields.artifacts) ? record.fields.artifacts.filter((value): value is string => typeof value === "string")
			.map(value => ({ kind: "checkpoint" as const, value })) : []),
	];
	const choices = requested === undefined ? registered : registered.filter(item => item.value === requested);
	const selected = choices.length === 1 ? choices[0] : undefined;
	if (!selected && requested === undefined)
		throw new HarnessError("m07.knowledge", "record has no unique exact M04 artifact reference; specify a registered artifact when needed");
	const accepted = await acceptedArtifactRows(workspaceRoot, record);
	if (requested !== undefined && accepted.rows.some(item => item.relativePath === requested)) {
		const row = accepted.rows.find(item => item.relativePath === requested);
		if (!row || !textArtifact(await readFile(row.path))) throw new HarnessError("m07.knowledge", "artifact is not an exact listed text file in the accepted M04 checkpoint");
		return { path: row.path, source: `${accepted.source}/${row.taskId}` };
	}
	if (!selected) throw new HarnessError("m07.knowledge", "artifact is not an exact listed text file in the accepted M04 checkpoint");
	const artifact = selected.value;
	if (!safeRelative(artifact)) throw new HarnessError("m07.knowledge", "record has no unique exact M04 artifact reference; specify a registered artifact when needed");
	let rows: AcceptedArtifact[];
	if (selected.kind === "checkpoint") rows = accepted.rows.filter(item => item.relativePath === artifact);
	else {
		if (accepted.taskIds.length !== 1)
			throw new HarnessError("m07.knowledge", "record names multiple source tasks; use list:true and an exact checkpoint-relative artifact path");
		const taskId = accepted.taskIds[0];
		// The original task tree may be gone after M04. Its saved goal paths only
		// identify a manifest entry; the selected checkpoint supplies authority.
		const historicalPath = (value: string): string => {
			const resolved = path.resolve(value), requestedRoot = path.resolve(workspaceRoot);
			if (inside(accepted.root, resolved)) return resolved;
			if (inside(requestedRoot, resolved)) return path.join(accepted.root, path.relative(requestedRoot, resolved));
			throw new HarnessError("m07.knowledge", "historical task path escapes workspace");
		};
		const goal = JSON.parse(await readFile(path.join(accepted.m07Dir, "goal.json"), "utf8")) as { runId?: string; tasks?: Array<{ taskId?: string; workDir?: string; review?: { artifacts?: Array<{ path?: string; sourcePath?: string; mediaType?: string }> } }> };
		const task = goal.tasks?.find(item => item.taskId === taskId);
		const expectedWorkDir = path.join(accepted.m07Dir, "tasks", taskId, "work");
		if (goal.runId !== accepted.m07RunId || !task?.workDir || historicalPath(task.workDir) !== expectedWorkDir)
			throw new HarnessError("m07.knowledge", "source task mapping is unavailable");
		const original = path.resolve(expectedWorkDir, artifact);
		if (!inside(expectedWorkDir, original)) throw new HarnessError("m07.knowledge", "artifact escapes task work directory");
		const matches = task.review?.artifacts?.filter(item => typeof item.sourcePath === "string" &&
			(selected.kind === "candidate" && !artifact.includes("/") && !artifact.includes("\\")
				? path.basename(item.sourcePath) === artifact
				: historicalPath(item.sourcePath) === original)) ?? [];
		const reviewRoot = path.join(accepted.m07Dir, "tasks", taskId, "review-snapshot");
		if (matches.length !== 1 || !matches[0].path || !inside(reviewRoot, historicalPath(matches[0].path)))
			throw new HarnessError("m07.knowledge", "artifact was not uniquely frozen in the accepted review");
		const relativeReview = path.relative(accepted.root, historicalPath(matches[0].path));
		rows = accepted.rows.filter(item => item.sourceRelativePath === relativeReview);
	}
	if (rows.length !== 1) throw new HarnessError("m07.knowledge", "artifact is not in the selected M04 checkpoint");
	if (!textArtifact(await readFile(rows[0].path)))
		throw new HarnessError("m07.knowledge", "artifact is not an exact listed text file in the accepted M04 checkpoint");
	return { path: rows[0].path, source: `${accepted.source}/${rows[0].taskId}` };
}

function range(args: Record<string, unknown>): { offset: number; limit: number } {
	const offset = args.offset ?? 0, limit = args.limit ?? 6000;
	if (!Number.isSafeInteger(offset) || Number(offset) < 0 || !Number.isSafeInteger(limit) || Number(limit) < 1 || Number(limit) > 12000)
		throw new HarnessError("m07.knowledge", "invalid knowledge page range");
	return { offset: Number(offset), limit: Number(limit) };
}

function context(args: Record<string, unknown>): KnowledgeRetrievalContext | undefined {
	const values = Object.fromEntries(contextKeys.filter(key => args[key] !== undefined).map(key => [key, args[key]]));
	return Object.keys(values).length ? validateKnowledgeRetrievalContext(values) : undefined;
}

/** No model calls, writes to the authoritative store, implicit experience loading,
 * snapshot refresh, or filesystem discovery. Native read is not this boundary. */
export function createExecutionKnowledgeTools(options: ExecutionKnowledgeOptions): CustomToolSpec[] {
	const { store } = options;
	const requiredIds = [...options.requiredIds];
	const initialContext = validateKnowledgeRetrievalContext(options.context);
	let sequence = 0;
	let tail: Promise<void> = Promise.resolve();
	let selectPage: { request: string; refs: string; limits: string } | undefined;
	const snapshot = async (): Promise<Snapshot | undefined> => {
		const current = await store.current();
		if (current?.id !== options.expectedSnapshot)
			throw new HarnessError("m07.knowledge", "knowledge snapshot differs from the frozen goal; this tool cannot refresh it");
		return current;
	};
	const stable = async (limits: Limit[]): Promise<void> => {
		await snapshot();
		if (JSON.stringify(await store.limits()) !== JSON.stringify(limits))
			throw new HarnessError("m07.knowledge", "live knowledge limits changed while reading; retry against their current state");
	};
	// One record's required dependencies and reverse warnings, shared with M04
	// through src/knowledge/session-tools.ts. Paging controls the response, so no
	// fixed top-k/body pack is imposed on changing stages.
	const index = async (args: Record<string, unknown>, required: string[]) => {
		const current = await snapshot();
		const explicitContext = { ...initialContext, ...context(args) };
		const result = await recordDependencyIndex(store, current, required[0], "M07 execution knowledge access",
			Object.keys(explicitContext).length ? explicitContext : undefined, "refs");
		await stable(result.limits);
		return result;
	};
	/** Contract cards published in the frozen snapshot, filtered by live
	 * availability and by the task's declared context: a constraint from another
	 * backend or toolchain must never reject this candidate. */
	const contractCards = async (): Promise<Array<{ ref: string; card: OptimizationCard }>> => {
		const current = await snapshot();
		const rows: Array<{ ref: string; card: OptimizationCard }> = [];
		for (const entry of current?.records ?? []) {
			const record = await store.get(entry.id, entry.version);
			if (!record) continue;
			const card = readOptimizationCard(record.fields);
			if (!card || card.kind !== "contract") continue;
			const conflict = RETRIEVAL_SCALAR_KEYS.some(key => {
				const declared = card.applicability[key], observed = initialContext?.[key];
				return declared !== undefined && observed !== undefined && declared !== observed;
			});
			if (conflict) continue;
			if ((await store.availability(record.id, record.version)).availability === "not_allowed") continue;
			rows.push({ ref: `${entry.id}@${entry.version}`, card });
		}
		return rows;
	};
	const resolve = async (ref: unknown) => {
		if (typeof ref !== "string" || !refPattern.test(ref)) throw new HarnessError("m07.knowledge", "ref must be a published record ID, optionally pinned");
		const [, id, versionText] = refPattern.exec(ref)!;
		const current = await snapshot();
		const latest = current?.records.find(item => item.id === id)?.version;
		const version = versionText ? Number(versionText) : latest;
		if (!latest || !version || !Number.isSafeInteger(version) || version > latest || version < 1)
			throw new HarnessError("m07.knowledge", "requested record version is not in the frozen knowledge snapshot");
		const record = await store.get(id, version);
		if (!record) throw new HarnessError("m07.knowledge", "published knowledge record is unavailable");
		if (record.fields.experience !== undefined) throw new HarnessError("m07.knowledge", "method experience requires the existing explicit pinned ExperienceProvider path");
		return { record, latest, ref: `${id}@${version}` };
	};
	type Result = { content: string; selectedRefs: string[]; limits: Limit[]; contentKind: "index" | "brief" | "record" | "artifact" | "artifact-index" | "contract-check";
		safety: unknown; extra?: unknown; recordPage?: { offset: number; end: number; total: number; returnedRefs: string[] } };
	const liveSafety = (selection: Awaited<ReturnType<typeof index>>, limitRefs: readonly string[] = selection.rankedRefs) => ({ status: selection.status,
		requiredIds, availability: selection.pack.included, omitted: selection.omitted,
		activeLimits: selection.limits.filter(limit => !limit.liftedAt && limitRefs.some(ref => ref === limit.target || ref.split("@")[0] === limit.target)),
		notice: "Use knowledge_read on the listed dependency/warning refs and knowledge_select for their discovery index. Their bodies and conditions remain unread until explicitly read. Compare declared prerequisites with the current context before applying; selection is not adoption. Full live limits below apply on every record page." });
	const audited = (kind: KnowledgeAccessEvent["kind"], operation: (args: Record<string, unknown>) => Promise<Result>) =>
		(args: Record<string, unknown>): Promise<ToolResult> => {
			const run = async (): Promise<ToolResult> => {
				const id = `K${String(++sequence).padStart(4, "0")}`;
				const event: KnowledgeAccessEvent = { id, kind, at: new Date().toISOString(), snapshot: options.expectedSnapshot,
					status: "failed", selectedRefs: [], frozenPath: path.join(options.archiveDir, `${id}.json`) };
				let result: Result | undefined, response: ToolResult | undefined, failure: unknown;
				try {
					await options.beforeAccess?.();
					result = await operation(args);
					const selectionRequest = kind === "select" ? JSON.stringify({ text: args.text, requiredIds: args.requiredIds,
						format: args.format ?? "brief", context: { ...initialContext, ...context(args) } }) : undefined;
					event.selectedRefs = result.selectedRefs;
					if (result.recordPage) {
						const { offset, end, total, returnedRefs } = result.recordPage;
						const refs = JSON.stringify(result.selectedRefs), limits = JSON.stringify(result.limits);
						if (offset > 0 && (!selectPage || selectPage.request !== selectionRequest || selectPage.refs !== refs || selectPage.limits !== limits))
							throw new HarnessError("m07.knowledge", "knowledge selection changed or has no first page; restart at offset=0 with the current live limits");
						event.returnedRange = { offset, end, total, content: result.contentKind, unit: "records" };
						event.returnedRefs = returnedRefs;
						await stable(result.limits);
						if (offset === 0) selectPage = { request: selectionRequest!, refs, limits };
						event.status = "returned";
						response = { text: `Knowledge select ${id}; snapshot=${options.expectedSnapshot ?? "unpublished"}; record ordinals ${offset}-${end}/${total}; ${end < total ? `continue offset=${end}` : "end"}. Returned refs ${JSON.stringify(returnedRefs)}. Candidate refs are discovery only; bodies/artifacts are not read or adopted.\nDiscovery status (not paginated): ${JSON.stringify(result.safety)}\n${result.content}`,
							details: { ...event.returnedRange, snapshot: options.expectedSnapshot, selectedRefs: result.selectedRefs, returnedRefs } };
					} else {
						const requested = range(args);
						if (requested.offset > result.content.length) throw new HarnessError("m07.knowledge", `offset beyond content length ${result.content.length}`);
						const end = Math.min(result.content.length, requested.offset + requested.limit);
						event.returnedRange = { offset: requested.offset, end, total: result.content.length, content: result.contentKind };
						await stable(result.limits);
						event.status = "returned";
						response = { text: `Knowledge ${kind} ${id}; snapshot=${options.expectedSnapshot ?? "unpublished"}; UTF-16 ${requested.offset}-${end}/${result.content.length}; ${end < result.content.length ? `continue offset=${end}` : "end"}. Only this paged content range was exposed; discovery status or live record restrictions are shown separately. Referenced bodies/artifacts are not automatically read or adopted.\nLive record restrictions (not paginated): ${JSON.stringify(result.safety)}\n${result.content.slice(requested.offset, end)}`,
							details: { ...event.returnedRange, snapshot: options.expectedSnapshot, selectedRefs: result.selectedRefs } };
					}
				} catch (error) { failure = error; }
				await mkdir(options.archiveDir, { recursive: true });
				const { frozenPath: _location, ...portableEvent } = event;
				await writeFileAtomic(event.frozenPath, `${JSON.stringify({ version: 1, ...portableEvent, request: args,
					...(response ? { returnedText: response.text } : { error: failure instanceof Error ? failure.message : "Knowledge access failed" }),
					...(result ? { safety: result.safety, ...(result.extra === undefined ? {} : { extra: result.extra }),
						...(kind === "select" ? {} : { frozenContent: result.content }), liveLimits: result.limits } : {}) }, null, 2)}\n`);
				await options.onAccess(structuredClone(event));
				if (failure) throw failure;
				return response!;
			};
			const current = tail.then(run);
			tail = current.then(() => undefined, () => undefined);
			return current;
		};
	const tools: CustomToolSpec[] = [{
		name: "knowledge_select",
		description: "Search the frozen knowledge snapshot by stage and concrete symptoms. Return one numbered record page of short literal cards with exact refs; format=index gives discovery metadata. Continue at the returned record offset for the same query/context and unchanged live limits; after a change restart at offset=0. Read original records and restrictions before use.",
		params: { text: { type: "string", description: "Current concrete question, error symbols or bottleneck; may be empty when context is supplied" },
			requiredIds: { type: "string[]", description: "Optional exact records; task-required records always remain included", optional: true },
			format: { type: "string", description: "brief (default) or index", optional: true }, ...contextParams, ...selectRangeParams },
		execute: audited("select", async args => {
			if (typeof args.text !== "string" || (args.requiredIds !== undefined && (!Array.isArray(args.requiredIds) || args.requiredIds.some(ref => typeof ref !== "string" || !refPattern.test(ref)))))
				throw new HarnessError("m07.knowledge", "invalid knowledge query or required references");
			if (args.format !== undefined && args.format !== "brief" && args.format !== "index") throw new HarnessError("m07.knowledge", "invalid knowledge format");
			const offset = args.offset ?? 0, limit = args.limit ?? 12;
			if (!Number.isSafeInteger(offset) || Number(offset) < 0 || !Number.isSafeInteger(limit) || Number(limit) < 1 || Number(limit) > 100)
				throw new HarnessError("m07.knowledge", "invalid knowledge record page range");
			const view = args.format === "index" ? "index" : "brief";
			const explicitContext = { ...initialContext, ...context(args) };
			const page = await selectKnowledgePage(store, { purpose: "M07 execution knowledge access",
				text: typeof args.text === "string" ? args.text : "", snapshot: await snapshot(),
				...(Object.keys(explicitContext).length ? { context: explicitContext } : {}),
				requiredIds: [...requiredIds, ...((args.requiredIds ?? []) as string[])], excludeExperience: true,
				offset: Number(offset), limit: Number(limit), view, scope: "m07.knowledge" });
			const selection = page.selection;
			const refs = page.refs, end = page.end, returnedRefs = page.returnedRefs, blocks = page.blocks;
			const activeLimits = liveSafety(selection).activeLimits;
			const limitKinds = { suspended: 0, withdrawn: 0, needs_recheck: 0 };
			for (const limit of activeLimits) limitKinds[limit.kind]++;
			return { content: `${blocks.join("\n")}${selection.omitted.length ? `\n未纳入 ${selection.omitted.length} 项；原因示例：${JSON.stringify(selection.omitted.slice(0, 20))}` : ""}`,
				selectedRefs: refs, limits: selection.limits, contentKind: view,
				recordPage: { offset: Number(offset), end, total: refs.length, returnedRefs },
				safety: { status: selection.status, selectedCount: selection.rankedRefs.length, omittedCount: selection.omitted.length,
					activeLimitCount: activeLimits.length, limitKinds,
					notice: "Discovery page only. Only returnedRefs have cards on this page; selectedRefs is the candidate set. Before applying any entry, call knowledge_read for its body and complete live restrictions. Continue at the next record offset; unreturned entries are not read or adopted." },
				extra: { omitted: selection.omitted, limitsCheckedAt: selection.limitsCheckedAt } };
		}),
	}, {
		name: "knowledge_read",
		description: "Read a specific original knowledge record, including complete fields/artifact references, in pages. Required dependencies and warnings remain indexed; live limits are rechecked. Does not read referenced files or load H/I experience.",
		params: { ref: { type: "string", description: "Record ID or pinned ID, e.g. K001@1, from the frozen snapshot" }, ...contextParams, ...rangeParams },
		execute: audited("read", async args => {
			const target = await resolve(args.ref);
			const selection = await index(args, [target.ref]);
			// Incomplete applicability is not a ban on inspecting an already published
			// original. Preserve the failed closure and its omissions, without admitting use.
			const selectedRefs = [...new Set([target.ref, ...selection.rankedRefs])];
			const published = new Map((await snapshot())?.records.map(item => [item.id, item.version]) ?? []);
			const limitRefs = [...new Set([...selectedRefs, ...requiredIds, ...target.record.scope,
				...target.record.refs.map(ref => ref.target), ...selection.omitted.map(item => item.ref)].flatMap(ref => {
				const match = refPattern.exec(ref);
				if (!match) return [];
				const version = match[2] ?? published.get(match[1]);
				return version === undefined ? [ref] : [`${match[1]}@${version}`];
			}))];
			const restrictions = liveSafety(selection, limitRefs);
			if (selection.status !== "ready" || !selection.rankedRefs.includes(target.ref))
				restrictions.notice = "The dependency/warning group is incomplete; inspect status and omissions (including cycles) below. This returns the published original for read-only diagnosis, not permission to apply it. Related records may still require inspection. " + restrictions.notice;
			const availability = await store.availability(target.record.id, target.record.version);
			const retrieval = target.record.fields.retrieval;
			const declaredContext = retrieval && typeof retrieval === "object" && !Array.isArray(retrieval)
				? (retrieval as Record<string, unknown>).context : undefined;
			// Keep the paged original independent of query context and live state;
			// otherwise changing either between calls silently shifts later offsets.
			const content = renderOriginalRecord(target.record, `# Original knowledge record ${target.ref}`);
			return { content, selectedRefs, limits: selection.limits, contentKind: "record",
				safety: { ...restrictions, currentRecord: { ref: target.ref, availability,
					scope: target.record.scope, refs: target.record.refs, retrievalContext: declaredContext },
					context: { ...initialContext, ...context(args) } },
				extra: { record: target.record, availability, selection } };
		}),
	}];
	if (options.workspaceRoot) tools.push({
		name: "knowledge_artifact_read",
		description: "List exact text files from explicitly declared source tasks that were selected by M04 and accepted in the checkpoint with list:true, or read one listed checkpoint-relative path or a uniquely mapped registered reference. Excluded declared tasks are reported but not opened. The directory does not prove each file supports this claim or that any body was read.",
		params: { ref: { type: "string", description: "Published record ID or pinned version with fields.task or fields.tasks and a completed M04 source" },
			artifact: { type: "string", description: "Exact registered reference or checkpoint-relative path returned by list:true; required if the record has several", optional: true },
			list: { type: "boolean", description: "Return a paged directory of same-source accepted text files, without returning file contents", optional: true }, ...rangeParams },
		execute: audited("artifact", async args => {
			if (args.list !== undefined && typeof args.list !== "boolean") throw new HarnessError("m07.knowledge", "list must be boolean");
			if (args.list === true && args.artifact !== undefined) throw new HarnessError("m07.knowledge", "list cannot be combined with artifact");
			const target = await resolve(args.ref);
			const selection = await index({}, [target.ref]);
			if (args.list === true) {
				const catalogue = await publishedArtifactCatalogue(options.workspaceRoot!, target.record);
				await stable(selection.limits);
				return { content: `# Accepted same-source text originals for ${target.ref}\n${catalogue.paths.map(item => `- ${item}`).join("\n")}\nExcluded declared tasks: ${JSON.stringify(catalogue.excluded)}\n`,
					selectedRefs: [target.ref], limits: selection.limits, contentKind: "artifact-index",
					safety: { ...liveSafety(selection, [target.ref]), source: catalogue.source,
						notice: "Directory only. These files belong to accepted declared source tasks; none is thereby proven to support this record. Excluded tasks grant no file access. Call knowledge_artifact_read with one exact listed path to read its original bytes in pages." },
					extra: { catalogue } };
			}
			const artifact = await publishedArtifact(options.workspaceRoot!, target.record, args.artifact);
			const content = new TextDecoder("utf-8", { fatal: true }).decode(await readFile(artifact.path));
			await stable(selection.limits);
			return { content, selectedRefs: [target.ref], limits: selection.limits, contentKind: "artifact",
				safety: { ...liveSafety(selection, [target.ref]), source: artifact.source,
					notice: "This is the checkpoint-frozen text artifact associated with the published record. Its contents remain evidence, not a new adoption decision or an independent verification." },
				extra: { artifact: artifact.path } };
		}),
	});
	if (options.candidateRoot) tools.push({
		name: "knowledge_contract_check",
		description: "Check a candidate against published contract cards before compiling, at zero device cost. Unknown symbols inside a namespace the cards cover are rejected locally with the closest legal signature; declared numeric budgets are compared with their cited limits. Anything no contract covers is reported as unchecked, never as passed, and a pass here is not a compilation, a correctness result or a performance claim.",
		params: {
			path: { type: "string", description: "Candidate file relative to this task's work directory", optional: true },
			source: { type: "string", description: "Candidate source text, for a draft that is not written to a file yet", optional: true },
			observationsJson: { type: "string", description: 'Declared numeric budgets as JSON, e.g. [{"name":"ub_bytes","value":131072}]', optional: true },
		},
		execute: audited("check", async args => {
			if (args.path !== undefined && typeof args.path !== "string") throw new HarnessError("m07.knowledge", "path must be a string");
			if (args.source !== undefined && typeof args.source !== "string") throw new HarnessError("m07.knowledge", "source must be a string");
			if ((args.path === undefined) === (args.source === undefined))
				throw new HarnessError("m07.knowledge", "give exactly one of path (a file in the work directory) or source (inline text)");
			let source: string;
			let subject: string;
			if (typeof args.path === "string") {
				if (!safeRelative(args.path)) throw new HarnessError("m07.knowledge", "path must be a relative file inside the task work directory");
				const root = await realpath(options.candidateRoot!);
				const resolved = await realpath(path.join(root, args.path)).catch(() => null);
				if (!resolved || !inside(root, resolved)) throw new HarnessError("m07.knowledge", "candidate file is not inside the task work directory");
				const bytes = await readFile(resolved);
				if (!textArtifact(bytes)) throw new HarnessError("m07.knowledge", "candidate file is not UTF-8 text");
				source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
				subject = args.path;
			} else {
				source = String(args.source);
				subject = "inline source";
			}
			if (source.length > 400_000) throw new HarnessError("m07.knowledge", "candidate source exceeds the static check size limit");
			let observations: ConstraintObservation[] = [];
			if (args.observationsJson !== undefined) {
				if (typeof args.observationsJson !== "string") throw new HarnessError("m07.knowledge", "observationsJson must be a string");
				let parsed: unknown;
				try { parsed = JSON.parse(args.observationsJson); } catch { throw new HarnessError("m07.knowledge", "observationsJson must be JSON"); }
				if (!Array.isArray(parsed) || !parsed.every(item => !!item && typeof item === "object" && !Array.isArray(item) &&
					typeof (item as ConstraintObservation).name === "string" && Number.isFinite((item as ConstraintObservation).value)))
					throw new HarnessError("m07.knowledge", 'observationsJson must be [{"name":"...","value":123}]');
				observations = parsed as ConstraintObservation[];
			}
			const limits = await store.limits();
			const cards = await contractCards();
			const report = checkCandidate({ source, observations }, cards.map(item => ({ card: item.card })));
			await stable(limits);
			const content = [`# 契约静态检查 ${subject}`,
				`- 结论：${report.status}（reject=本地驳回，pass=覆盖范围内全部通过，inconclusive=缺少可用契约或未声明数值）`,
				`- 使用的契约卡：${cards.length ? cards.map(item => item.ref).join("、") : "无"}`,
				`- 已对照符号：${report.checkedSymbols.join("、") || "无"}`,
				`- 无契约覆盖、未作判定的符号：${report.uncoveredSymbols.join("、") || "无"}`,
				"", ...report.findings.map(item => `- [${item.code}] ${item.message}；witness ${item.witness}${item.suggestion ? `；最接近的合法签名 ${item.suggestion}` : ""}`),
				report.findings.length ? "" : "- 覆盖范围内没有发现问题。",
				"检查只覆盖已登记契约卡描述的命名空间与数值约束；通过不等于可编译、数值正确或更快。"].join("\n");
			return { content, selectedRefs: cards.map(item => item.ref), limits, contentKind: "contract-check",
				safety: { status: report.status, contracts: cards.length, findings: report.findings.length,
					uncovered: report.uncoveredSymbols.length,
					notice: "Static pre-compile check only. It does not read the knowledge bodies behind these cards, does not compile, and does not adopt anything." },
				extra: { report } };
		}),
	});
	return tools;
}
