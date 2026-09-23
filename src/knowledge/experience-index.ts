/** Explicit, bounded views over the existing knowledge store; never an adoption path. */
import type { KnowledgeRecord, KnowledgeRef, KnowledgeStore } from "./types.ts";

export type ExperienceTargetKind = "executor" | "improver";

export interface ExperienceApplicability {
	stage: string;
	tags: string[];
	/** Pinned X records describing the caller's current context. */
	contextRefs?: KnowledgeRef[];
}

export interface ExperienceQuery {
	targetKind: ExperienceTargetKind;
	applicability: ExperienceApplicability;
	/** No semantic search or implicit old-task injection in this first version. */
	requestedRefs: KnowledgeRef[];
	expectedSnapshotId?: string;
	maxRecords: number;
	maxChars: number;
}

export interface ExperienceSelection {
	status: "ready" | "incomplete" | "none";
	markdown: string;
	selected: Array<{ ref: KnowledgeRef; dependencyRefs: KnowledgeRef[] }>;
	omitted: Array<{ ref: KnowledgeRef; reason: string }>;
	checkedSnapshots: Array<{ storeId: string; snapshotId?: string }>;
	limitsCheckedAt: string;
}

export interface ExperienceProvider {
	select(query: ExperienceQuery): Promise<ExperienceSelection>;
}

interface ExperienceDefinition {
	version: 1;
	targetKind: ExperienceTargetKind;
	applicableStages: string[];
	requiredTags: string[];
	excludedTags: string[];
	requiredRefs: KnowledgeRef[];
}

const recordIdPattern = /^[CKEJQDX]\d{3,}$/;
const storeIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const key = (ref: KnowledgeRef) => `${ref.storeId}/${ref.recordId}@${ref.version}`;
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isStrings = (value: unknown): value is string[] => Array.isArray(value) && value.length <= 64 && value.every((item) => typeof item === "string" && !!item.trim() && item.length <= 240);

export function isKnowledgeRef(value: unknown): value is KnowledgeRef {
	return isObject(value) && typeof value.storeId === "string" && storeIdPattern.test(value.storeId) &&
		typeof value.recordId === "string" && recordIdPattern.test(value.recordId) &&
		Number.isSafeInteger(value.version) && (value.version as number) > 0;
}

function definition(record: KnowledgeRecord): ExperienceDefinition | undefined {
	const value = record.fields.experience;
	if (!isObject(value) || value.version !== 1 || (value.targetKind !== "executor" && value.targetKind !== "improver") ||
		!isStrings(value.applicableStages) || !isStrings(value.requiredTags) || !isStrings(value.excludedTags) ||
			!Array.isArray(value.requiredRefs) || value.requiredRefs.length > 100 || !value.requiredRefs.every(isKnowledgeRef)) return undefined;
	return value as unknown as ExperienceDefinition;
}

function contextMatches(record: KnowledgeRecord, ref: KnowledgeRef, query: ExperienceQuery, model: ExperienceDefinition): boolean {
	if (!model.applicableStages.includes(query.applicability.stage)) return false;
	const tags = new Set(query.applicability.tags);
	if (model.requiredTags.some((tag) => !tags.has(tag)) || model.excludedTags.some((tag) => tags.has(tag))) return false;
	const contexts = query.applicability.contextRefs ?? [];
	return record.scope.every((id) => contexts.some((context) => context.storeId === ref.storeId && context.recordId === id));
}

function renderRecord(ref: KnowledgeRef, record: KnowledgeRecord): string {
	return [
		`### ${ref.storeId}/${record.id}@${record.version} ${record.title}`,
		`- 类型：${record.type}；使用决定：${record.usageDecision ?? "未记录"}；依据状况：${record.evidenceStatus ?? "未记录"}`,
		`- 情境：${record.scope.join("、") || "项目默认情境"}`,
		`- 关系：${record.refs.map((item) => `${item.rel} → ${item.target}`).join("；") || "无"}`,
		"",
		record.body.trim(),
		"",
	].join("\n");
}

/** External stores are only visible when a caller explicitly registers their exact identity. */
export function createExperienceProvider(localStore: KnowledgeStore, registeredStores: ReadonlyMap<string, KnowledgeStore> = new Map()): ExperienceProvider {
		return {
			async select(query): Promise<ExperienceSelection> {
				const checkedAt = new Date().toISOString();
				const empty = (status: ExperienceSelection["status"], omitted: ExperienceSelection["omitted"] = []): ExperienceSelection => ({ status, markdown: "", selected: [], omitted, checkedSnapshots: [], limitsCheckedAt: checkedAt });
				const contexts = query.applicability?.contextRefs ?? [];
				if (!Array.isArray(query.requestedRefs) || query.requestedRefs.length > 100 || !isStrings(query.applicability?.tags) ||
					!Array.isArray(contexts) || contexts.length > 100 || !contexts.every(isKnowledgeRef) ||
					typeof query.applicability.stage !== "string" || !query.applicability.stage.trim() || query.applicability.stage.length > 80 ||
					!Number.isSafeInteger(query.maxRecords) || query.maxRecords < 1 || query.maxRecords > 100 ||
					!Number.isSafeInteger(query.maxChars) || query.maxChars < 1 || query.maxChars > 100_000) throw new Error("invalid experience selection bounds or context");
				if (!query.requestedRefs.length) return empty("none");
				if (query.requestedRefs.length > query.maxRecords) return empty("incomplete", [{ ref: query.requestedRefs[0], reason: "selection-record-budget-exceeded" }]);
			const invalid = query.requestedRefs.filter((ref) => !isKnowledgeRef(ref));
			if (invalid.length) return empty("incomplete", invalid.map((ref) => ({ ref, reason: "invalid-reference" })));
			const localId = await localStore.storeId();
			const stores = new Map<string, KnowledgeStore>(registeredStores);
			stores.set(localId, localStore);
			const checkedSnapshots: ExperienceSelection["checkedSnapshots"] = [];
			const initialState = new Map<string, string>();
			const storeFor = async (ref: KnowledgeRef): Promise<KnowledgeStore | undefined> => {
				const store = stores.get(ref.storeId);
				if (!store || await store.storeId() !== ref.storeId) return undefined;
				if (!initialState.has(ref.storeId)) {
					const snapshot = (await store.current())?.id ?? "";
					initialState.set(ref.storeId, JSON.stringify({ snapshot, limits: await store.limits() }));
					checkedSnapshots.push({ storeId: ref.storeId, snapshotId: snapshot || undefined });
				}
				return store;
			};
			const omitted: ExperienceSelection["omitted"] = [];
			const records = new Map<string, { ref: KnowledgeRef; record: KnowledgeRecord }>();
			const selected: ExperienceSelection["selected"] = [];
			const visiting = new Set<string>();
			const checked = new Set<string>();
			const visit = async (ref: KnowledgeRef): Promise<boolean> => {
				const identity = key(ref);
				if (visiting.has(identity)) { omitted.push({ ref, reason: "dependency-cycle" }); return false; }
				if (checked.has(identity)) return true;
				if (visiting.size + checked.size >= query.maxRecords) { omitted.push({ ref, reason: "selection-record-budget-exceeded" }); return false; }
				const store = await storeFor(ref);
				if (!store) { omitted.push({ ref, reason: "store-not-registered-or-identity-mismatch" }); return false; }
				const record = await store.get(ref.recordId, ref.version);
				if (!record) { omitted.push({ ref, reason: "record-or-version-unavailable" }); return false; }
				const availability = await store.availability(ref.recordId, ref.version);
				if (availability.availability !== "usable_conditionally") { omitted.push({ ref, reason: `availability:${availability.availability}` }); return false; }
				const nestedDefinition = definition(record);
				if (record.fields.experience !== undefined && (!nestedDefinition || nestedDefinition.targetKind !== query.targetKind || !contextMatches(record, ref, query, nestedDefinition))) { omitted.push({ ref, reason: "dependent-experience-not-applicable" }); return false; }
				visiting.add(identity);
				const nested = nestedDefinition?.requiredRefs ?? [];
				const scoped: KnowledgeRef[] = [];
				for (const scopeId of record.scope) {
					const context = (query.applicability.contextRefs ?? []).find((item) => isKnowledgeRef(item) && item.storeId === ref.storeId && item.recordId === scopeId);
					if (!context) { omitted.push({ ref, reason: `missing-context:${scopeId}` }); visiting.delete(identity); return false; }
					scoped.push(context);
				}
				for (const dependency of [...nested, ...scoped]) if (!await visit(dependency)) { visiting.delete(identity); return false; }
				visiting.delete(identity);
				checked.add(identity);
				records.set(identity, { ref, record });
				return true;
			};
			for (const ref of query.requestedRefs) {
				const store = await storeFor(ref);
				if (!store) { omitted.push({ ref, reason: "store-not-registered-or-identity-mismatch" }); continue; }
				const record = await store.get(ref.recordId, ref.version);
				const model = record && definition(record);
				if (!record || !model) { omitted.push({ ref, reason: "not-an-experience-record" }); continue; }
				if (model.targetKind !== query.targetKind || !contextMatches(record, ref, query, model)) { omitted.push({ ref, reason: "not-applicable" }); continue; }
				if (!await visit(ref)) continue;
				selected.push({ ref, dependencyRefs: [...model.requiredRefs, ...(query.applicability.contextRefs ?? []).filter((item) => record.scope.includes(item.recordId) && item.storeId === ref.storeId)] });
			}
			const localSnapshot = checkedSnapshots.find((item) => item.storeId === localId)?.snapshotId;
			if (query.expectedSnapshotId && localSnapshot !== query.expectedSnapshotId) omitted.push({ ref: query.requestedRefs[0], reason: "snapshot-mismatch" });
			for (const [storeId, state] of initialState) {
				const store = stores.get(storeId)!;
				const after = JSON.stringify({ snapshot: (await store.current())?.id ?? "", limits: await store.limits() });
				if (state !== after) omitted.push({ ref: query.requestedRefs[0], reason: `knowledge-changed-during-selection:${storeId}` });
			}
			if (omitted.length) return { ...empty("incomplete", omitted), checkedSnapshots };
			const header = "# 有界方法经验包\n\n所选记录仅在声明条件与当前限制下可供参考；入库和装载不证明科学正确、忠实使用或收益。\n\n";
				let markdown = header;
				for (const { ref, record } of records.values()) {
					if (record.body.length > query.maxChars) return { ...empty("incomplete", [{ ref, reason: "selection-budget-exceeded" }]), checkedSnapshots };
					const block = renderRecord(ref, record);
					if (markdown.length + block.length + 1 > query.maxChars) return { ...empty("incomplete", [{ ref, reason: "selection-budget-exceeded" }]), checkedSnapshots };
					markdown += `${block}\n`;
				}
				if (records.size > query.maxRecords || markdown.length > query.maxChars) return { ...empty("incomplete", query.requestedRefs.map((ref) => ({ ref, reason: "selection-budget-exceeded" }))), checkedSnapshots };
			return { status: "ready", markdown, selected, omitted: [], checkedSnapshots, limitsCheckedAt: checkedAt };
		},
	};
}
