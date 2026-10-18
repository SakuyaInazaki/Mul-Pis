/**
 * The shared core behind the in-session knowledge tools.
 *
 * M04 and M07 both expose `knowledge_select`, `knowledge_read` and
 * `knowledge_artifact_read`, and both had their own copy of the same logic:
 * compute the selection over the frozen snapshot, validate a record-ordinal or
 * character range, resolve a version, render the page, and verify that neither
 * the snapshot nor the live limits moved while the page was being produced. Two
 * copies of a safety property is one copy too many — a fix to one of them is a
 * silent gap in the other.
 *
 * This module owns that logic once. The stages keep their own tool wrappers,
 * because their audit records, their wording and their failure handling legitimately
 * differ; what they no longer keep is their own version of the rules.
 */
import { HarnessError } from "../types.ts";
import { renderSelectedKnowledgeRecord, retrieveKnowledge,
	type KnowledgeRetrievalContext, type KnowledgeRetrievalSelection } from "./retrieval.ts";
import type { AvailabilityReport, KnowledgeRecord, KnowledgeStore, Limit, Snapshot } from "./types.ts";

export const KNOWLEDGE_REF = /^([CKEJQDX]\d{3,})(?:@(\d+))?$/u;

/** Materialising every published version is bounded by the snapshot itself. */
export function snapshotRecordBudget(snapshot: Snapshot | undefined): number {
	return Math.max(1, (snapshot?.records ?? []).reduce((total, item) => total + item.version, 0));
}

/** The one stability rule: a page is only valid if the snapshot it was built
 * from is still current and the live limits rendered with it still hold. */
export async function assertStableKnowledge(store: KnowledgeStore, expectedSnapshot: string | undefined,
	limits: Limit[], scope: string): Promise<void> {
	if ((await store.current())?.id !== expectedSnapshot)
		throw new HarnessError(scope, "knowledge snapshot changed; this tool cannot refresh it");
	if (JSON.stringify(await store.limits()) !== JSON.stringify(limits))
		throw new HarnessError(scope, "live knowledge limits changed while reading; retry against their current state");
}

export interface SelectionPageRequest {
	purpose: string;
	text: string;
	snapshot: Snapshot | undefined;
	context?: KnowledgeRetrievalContext;
	requiredIds?: readonly string[];
	excludeExperience?: boolean;
	offset: number;
	limit: number;
	view: "brief" | "index";
	scope: string;
}

export interface SelectionPage {
	selection: KnowledgeRetrievalSelection;
	refs: string[];
	offset: number;
	end: number;
	total: number;
	returnedRefs: string[];
	blocks: string[];
}

/** Discovery over the whole frozen catalogue, returned one record page at a
 * time. Paging controls the response size; it is not a top-k policy. */
export async function selectKnowledgePage(store: KnowledgeStore, request: SelectionPageRequest): Promise<SelectionPage> {
	const selection = await retrieveKnowledge(store, {
		purpose: request.purpose, text: request.text, view: "refs",
		...(request.context ? { context: request.context } : {}),
		...(request.requiredIds?.length ? { requiredIds: [...new Set(request.requiredIds)] } : {}),
		...(request.excludeExperience ? { excludeExperience: true } : {}),
		maxRecords: snapshotRecordBudget(request.snapshot), maxChars: Number.MAX_SAFE_INTEGER,
	});
	await assertStableKnowledge(store, request.snapshot?.id, selection.limits, request.scope);
	const refs = selection.rankedRefs;
	if (request.offset > refs.length)
		throw new HarnessError(request.scope, `record offset ${request.offset} exceeds selection length ${refs.length}`);
	const end = Math.min(refs.length, request.offset + request.limit);
	const returnedRefs = refs.slice(request.offset, end);
	const published = new Map((request.snapshot?.records ?? []).map((item) => [item.id, item.version]));
	const blocks: string[] = [];
	for (const ref of returnedRefs) {
		const parsed = KNOWLEDGE_REF.exec(ref);
		if (!parsed?.[2]) throw new HarnessError(request.scope, `invalid published record reference ${ref}`);
		const record = await store.get(parsed[1], Number(parsed[2]));
		if (!record) throw new HarnessError(request.scope, `published knowledge record unavailable: ${ref}`);
		blocks.push(renderSelectedKnowledgeRecord(record, await store.availability(record.id, record.version),
			selection.limits, published.get(record.id), request.view, request.context));
	}
	await assertStableKnowledge(store, request.snapshot?.id, selection.limits, request.scope);
	return { selection, refs, offset: request.offset, end, total: refs.length, returnedRefs, blocks };
}

/** Required dependencies, reverse warnings and live limits for one record, as
 * an index. It never adds unrelated relevance roots. */
export async function recordDependencyIndex(store: KnowledgeStore, snapshot: Snapshot | undefined,
	ref: string, purpose: string, context?: KnowledgeRetrievalContext,
	view: "refs" | "index" = "index"): Promise<KnowledgeRetrievalSelection> {
	return retrieveKnowledge(store, { purpose, text: "", requiredIds: [ref], view, onlyRequired: true,
		...(context ? { context } : {}), maxRecords: snapshotRecordBudget(snapshot), maxChars: Number.MAX_SAFE_INTEGER });
}

export interface ResolvedKnowledgeRecord {
	record: KnowledgeRecord;
	ref: string;
	version: number;
	/** Latest published version of this id in the frozen snapshot. */
	latest: number;
	availability: AvailabilityReport;
}

export type RecordResolution =
	| { status: "resolved"; resolved: ResolvedKnowledgeRecord }
	/** The id or version is not in this frozen snapshot. Callers decide whether
	 * that is an error or an answer; it is never silently treated as absent. */
	| { status: "not-in-snapshot"; id: string; requestedVersion?: number };

export async function resolveSnapshotRecord(store: KnowledgeStore, snapshot: Snapshot | undefined,
	id: string, requestedVersion: number | undefined, scope: string): Promise<RecordResolution> {
	const latest = (snapshot?.records ?? []).find((item) => item.id === id)?.version;
	const version = requestedVersion ?? latest;
	if (!latest || !version || !Number.isSafeInteger(version) || version > latest || version < 1)
		return { status: "not-in-snapshot", id, ...(requestedVersion === undefined ? {} : { requestedVersion }) };
	const record = await store.get(id, version);
	if (!record) throw new HarnessError(scope, `published knowledge record unavailable: ${id}@${version}`);
	return { status: "resolved", resolved: { record, ref: `${id}@${version}`, version, latest,
		availability: await store.availability(id, version) } };
}

/** The immutable original, independent of query context and live state: a
 * change in either must not shift the next offset or hide a warning behind it. */
export function renderOriginalRecord(record: KnowledgeRecord, heading: string, extra: readonly string[] = []): string {
	const { body, ...metadata } = record;
	return [heading, ...extra, `- 原始元数据（fields；非采用判断）：${JSON.stringify(metadata)}`, "", body].join("\n");
}

export interface CharacterRange { offset: number; end: number; total: number }

export function characterRange(content: string, offset: number, limit: number): CharacterRange | undefined {
	if (offset > content.length) return undefined;
	return { offset, end: Math.min(content.length, offset + limit), total: content.length };
}

/** Active limits touching any of these refs, bare or pinned. */
export function activeLimitsFor(limits: readonly Limit[], refs: readonly string[]): Limit[] {
	return limits.filter((limit) => !limit.liftedAt &&
		refs.some((ref) => limit.target === ref || limit.target === ref.split("@")[0]));
}
