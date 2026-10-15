/** Explicit, bounded views over the existing knowledge store; never an adoption path. */
import type { KnowledgeRecord, KnowledgeRef, KnowledgeStore } from "./types.ts";
import { createFileKnowledgeStore, parseRecordTarget } from "./store.ts";
import { publishedKnowledgeHistory, warningPointsToRecord } from "./retrieval.ts";
import { renderKnowledgeRecord } from "./pack.ts";
import { HarnessError } from "../types.ts";
import path from "node:path";
import { isKnowledgeRef, validateExperienceDefinition, type ExperienceDefinition, type ExperienceTargetKind } from "./experience-schema.ts";

export { isKnowledgeRef } from "./experience-schema.ts";
export type { ExperienceTargetKind } from "./experience-schema.ts";

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
	/** Verify all pinned applicability and live limits without constructing a model-visible pack. */
	verificationOnly?: boolean;
}

export interface ExperienceSelection {
	status: "ready" | "incomplete" | "none";
	markdown: string;
	selected: Array<{ ref: KnowledgeRef; dependencyRefs: KnowledgeRef[]; scientificRequiredRefs: KnowledgeRef[] }>;
	omitted: Array<{ ref: KnowledgeRef; reason: string }>;
	checkedSnapshots: Array<{ storeId: string; snapshotId?: string }>;
	limitsCheckedAt: string;
}

export interface ExperienceProvider {
	select(query: ExperienceQuery): Promise<ExperienceSelection>;
}

export interface LocalM07ExperienceDiscovery {
	snapshotId?: string;
	targetKind: "executor";
	stage: "M07";
	tags: string[];
	contextRefs: KnowledgeRef[];
	candidates: Array<{ ref: KnowledgeRef; title: string; scope: string[];
		requiredTags: string[]; excludedTags: string[]; requiredRefs: KnowledgeRef[] }>;
	/** Eligible matches after this page's 24 displayed candidates; skipped and ineligible records are not counted. */
	omittedCount: number;
	/** Offset for the next page of conditionally matching records in the same ordered view. */
	nextOffset?: number;
}

const key = (ref: KnowledgeRef) => `${ref.storeId}/${ref.recordId}@${ref.version}`;
const isStrings = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === "string" && !!item.trim() && item.length <= 240);

function definition(record: KnowledgeRecord): ExperienceDefinition | undefined {
	return validateExperienceDefinition(record.fields.experience).definition;
}

/** Read-only discovery over this store's published latest records. Explicit task refs remain required. */
export async function discoverLocalM07Experiences(localStore: KnowledgeStore, request: { tags: string[]; contextRefs?: KnowledgeRef[]; offset?: number }): Promise<LocalM07ExperienceDiscovery> {
	const contextRefs = request.contextRefs ?? [];
	const offset = request.offset ?? 0;
	if (!isStrings(request.tags) || !Array.isArray(contextRefs) || !contextRefs.every(isKnowledgeRef) ||
		!Number.isSafeInteger(offset) || offset < 0)
		throw new HarnessError("experience.discovery", "invalid bounded experience tags, pinned context refs, or offset");
	const snapshotId = (await localStore.current())?.id;
	const limitsAtStart = JSON.stringify(await localStore.limits());
	const storeId = await localStore.storeId();
	const provider = createExperienceProvider(localStore);
	const candidates: LocalM07ExperienceDiscovery["candidates"] = [];
	let omittedCount = 0;
	let eligibleSeen = 0;
	for (const record of await localStore.list()) {
		const model = definition(record);
		if (!model || model.targetKind !== "executor" || !model.applicableStages.includes("M07")) continue;
		const ref = { storeId, recordId: record.id, version: record.version };
		const selection = await provider.select({ targetKind: "executor",
			applicability: { stage: "M07", tags: ["execute", ...request.tags], contextRefs },
			requestedRefs: [ref], expectedSnapshotId: snapshotId, maxRecords: 100, maxChars: 1,
			verificationOnly: true });
		if (selection.status !== "ready") continue;
		if (eligibleSeen++ < offset) continue;
		if (candidates.length === 24) { omittedCount++; continue; }
		candidates.push({ ref, title: record.title,
			scope: [...new Set([...record.scope, ...record.refs.filter((item) => item.rel === "applies_in").map((item) => item.target)])],
			requiredTags: [...model.requiredTags], excludedTags: [...model.excludedTags], requiredRefs: [...model.requiredRefs] });
	}
	if ((await localStore.current())?.id !== snapshotId || JSON.stringify(await localStore.limits()) !== limitsAtStart)
		throw new HarnessError("experience.discovery", "knowledge snapshot or live limits changed during discovery");
	return { snapshotId, targetKind: "executor", stage: "M07", tags: [...request.tags], contextRefs: [...contextRefs], candidates, omittedCount,
		...(omittedCount ? { nextOffset: offset + candidates.length } : {}) };
}

function matchesScopedContext(scopeTarget: string, storeId: string, context: KnowledgeRef): boolean {
	const target = parseRecordTarget(scopeTarget);
	return !!target && context.storeId === storeId && context.recordId === target.id &&
		(target.version === undefined || context.version === target.version);
}

function contextMatches(record: KnowledgeRecord, ref: KnowledgeRef, query: ExperienceQuery, model: ExperienceDefinition): boolean {
	if (!model.applicableStages.includes(query.applicability.stage)) return false;
	const tags = new Set(query.applicability.tags);
	if (model.requiredTags.some((tag) => !tags.has(tag)) || model.excludedTags.some((tag) => tags.has(tag))) return false;
	const contexts = query.applicability.contextRefs ?? [];
	return record.scope.every((id) => contexts.some((context) => matchesScopedContext(id, ref.storeId, context)));
}

/** External stores are only visible when a caller explicitly registers their exact identity. */
export function createExperienceProvider(localStore: KnowledgeStore, registeredStores: ReadonlyMap<string, KnowledgeStore> = new Map()): ExperienceProvider {
	return {
		async select(query): Promise<ExperienceSelection> {
			const checkedAt = new Date().toISOString();
			const empty = (status: ExperienceSelection["status"], omitted: ExperienceSelection["omitted"] = []): ExperienceSelection => ({ status, markdown: "", selected: [], omitted, checkedSnapshots: [], limitsCheckedAt: checkedAt });
			const contexts = query.applicability?.contextRefs ?? [];
			if (!Array.isArray(query.requestedRefs) || query.verificationOnly !== true && query.requestedRefs.length > 100 || !isStrings(query.applicability?.tags) ||
				!Array.isArray(contexts) || query.verificationOnly !== true && contexts.length > 100 || !contexts.every(isKnowledgeRef) ||
				typeof query.applicability.stage !== "string" || !query.applicability.stage.trim() || query.applicability.stage.length > 80 ||
				!Number.isSafeInteger(query.maxRecords) || query.maxRecords < 1 || query.verificationOnly !== true && query.maxRecords > 100 ||
				!Number.isSafeInteger(query.maxChars) || query.maxChars < 1 || query.maxChars > 100_000) throw new Error("invalid experience selection bounds or context");
			if (!query.requestedRefs.length) return empty("none");
			if (query.verificationOnly !== true && query.requestedRefs.length > query.maxRecords) return empty("incomplete", [{ ref: query.requestedRefs[0], reason: "selection-record-budget-exceeded" }]);
			const invalid = query.requestedRefs.filter((ref) => !isKnowledgeRef(ref));
			if (invalid.length) return empty("incomplete", invalid.map((ref) => ({ ref, reason: "invalid-reference" })));
			const localId = await localStore.storeId();
			const stores = new Map<string, KnowledgeStore>(registeredStores);
			stores.set(localId, localStore);
			const checkedSnapshots: ExperienceSelection["checkedSnapshots"] = [];
			const initialState = new Map<string, string>();
			const captureStore = async (storeId: string, store: KnowledgeStore): Promise<void> => {
				if (initialState.has(storeId)) return;
				const snapshot = (await store.current())?.id ?? "";
				initialState.set(storeId, JSON.stringify({ snapshot, limits: await store.limits() }));
				checkedSnapshots.push({ storeId, snapshotId: snapshot || undefined });
			};
			// The local K epoch constrains selection even when every requested record
			// comes from an explicitly registered external store.
			await captureStore(localId, localStore);
			const storeFor = async (ref: KnowledgeRef): Promise<KnowledgeStore | undefined> => {
				const store = stores.get(ref.storeId);
				if (!store || await store.storeId() !== ref.storeId) return undefined;
				await captureStore(ref.storeId, store);
				return store;
			};
			const omitted: ExperienceSelection["omitted"] = [];
			const records = new Map<string, { ref: KnowledgeRef; record: KnowledgeRecord; dependencyRefs: KnowledgeRef[] }>();
			const warnings = new Map<string, { ref: KnowledgeRef; record: KnowledgeRecord }>();
			const selected: ExperienceSelection["selected"] = [];
			const visiting = new Set<string>();
			const checked = new Set<string>();
			const contextDependencies = (record: KnowledgeRecord, ref: KnowledgeRef): KnowledgeRef[] | undefined => {
				const targets = [...record.scope, ...record.refs.filter((item) => item.rel === "applies_in").map((item) => item.target)];
				const matched = new Map<string, KnowledgeRef>();
				for (const target of targets) {
					const context = contexts.find((item) => matchesScopedContext(target, ref.storeId, item));
					if (!context) { omitted.push({ ref, reason: `missing-context:${target}` }); return undefined; }
					matched.set(key(context), context);
				}
				return [...matched.values()];
			};
			const visit = async (ref: KnowledgeRef): Promise<boolean> => {
				const identity = key(ref);
				if (visiting.has(identity)) { omitted.push({ ref, reason: "dependency-cycle" }); return false; }
				if (checked.has(identity)) return true;
				if (query.verificationOnly !== true && visiting.size + checked.size >= query.maxRecords) { omitted.push({ ref, reason: "selection-record-budget-exceeded" }); return false; }
				const store = await storeFor(ref);
				if (!store) { omitted.push({ ref, reason: "store-not-registered-or-identity-mismatch" }); return false; }
				const record = await store.get(ref.recordId, ref.version);
				if (!record) { omitted.push({ ref, reason: "record-or-version-unavailable" }); return false; }
				const availability = await store.availability(ref.recordId, ref.version);
				if (availability.availability !== "usable_conditionally") { omitted.push({ ref, reason: `availability:${availability.availability}` }); return false; }
				const nestedDefinition = definition(record);
				if (record.fields.experience !== undefined && (!nestedDefinition || nestedDefinition.targetKind !== query.targetKind || !contextMatches(record, ref, query, nestedDefinition))) { omitted.push({ ref, reason: "dependent-experience-not-applicable" }); return false; }
				visiting.add(identity);
				const scoped = contextDependencies(record, ref);
				if (!scoped) { visiting.delete(identity); return false; }
				const dependencies = new Map<string, KnowledgeRef>();
				for (const dependency of [...(nestedDefinition?.requiredRefs ?? []), ...scoped]) dependencies.set(key(dependency), dependency);
				for (const dependency of dependencies.values()) if (!await visit(dependency)) { visiting.delete(identity); return false; }
				visiting.delete(identity);
				checked.add(identity);
				records.set(identity, { ref, record, dependencyRefs: [...dependencies.values()] });
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
				const scientificRequired = new Map<string, KnowledgeRef>();
				const collectRequired = (recordRef: KnowledgeRef): void => {
					const item = records.get(key(recordRef));
					const nested = item && definition(item.record);
					for (const required of nested?.requiredRefs ?? []) {
						if (scientificRequired.has(key(required))) continue;
						scientificRequired.set(key(required), required);
						collectRequired(required);
					}
				};
				collectRequired(ref);
				selected.push({ ref, dependencyRefs: records.get(key(ref))!.dependencyRefs, scientificRequiredRefs: [...scientificRequired.values()] });
			}
			// A warning is evidence about a selected version, not an adopted
			// method. Keep its historical decision and premises visible even if
			// its own usageDecision is candidate or exploratory.
			const histories = new Map<string, Promise<{ latest: Map<string, number>; records: KnowledgeRecord[]; error?: string }>>();
			const publishedHistory = (storeId: string): Promise<{ latest: Map<string, number>; records: KnowledgeRecord[]; error?: string }> => {
				let history = histories.get(storeId);
				if (!history) {
					history = (async () => {
						const store = stores.get(storeId)!;
						const latest = await store.list();
						const versions = new Map(latest.map((record) => [record.id, record.version]));
						return { latest: versions, ...await publishedKnowledgeHistory(store, latest) };
					})();
					histories.set(storeId, history);
				}
				return history;
			};
			const warningVisiting = new Set<string>();
			const visitWarning = async (ref: KnowledgeRef): Promise<boolean> => {
				const identity = key(ref);
				if (records.has(identity) || warnings.has(identity)) return true;
				if (warningVisiting.has(identity)) { omitted.push({ ref, reason: "warning-dependency-cycle" }); return false; }
				const store = await storeFor(ref);
				if (!store) { omitted.push({ ref, reason: "warning-store-unavailable" }); return false; }
				const record = await store.get(ref.recordId, ref.version);
				if (!record) { omitted.push({ ref, reason: "warning-record-unavailable" }); return false; }
				const history = await publishedHistory(ref.storeId);
				if (history.error) { omitted.push({ ref, reason: history.error }); return false; }
				warningVisiting.add(identity);
				const dependencies = new Map<string, KnowledgeRef>();
				for (const target of [...record.scope, ...record.refs.filter((item) => item.rel === "applies_in").map((item) => item.target)]) {
					const parsed = parseRecordTarget(target);
					const version = parsed && (parsed.version ?? history.latest.get(parsed.id));
					if (!parsed || !version) { omitted.push({ ref, reason: `warning-premise-unavailable:${target}` }); warningVisiting.delete(identity); return false; }
					const dependency = { storeId: ref.storeId, recordId: parsed.id, version };
					dependencies.set(key(dependency), dependency);
				}
				if (record.type === "J") for (const candidate of history.records) {
					if (candidate.refs.some((item) => item.rel === "premise_of" &&
						(item.target === `${record.id}@${record.version}` || (item.target === record.id && history.latest.get(record.id) === record.version)))) {
						const dependency = { storeId: ref.storeId, recordId: candidate.id, version: candidate.version };
						dependencies.set(key(dependency), dependency);
					}
				}
				for (const dependency of definition(record)?.requiredRefs ?? []) dependencies.set(key(dependency), dependency);
				for (const dependency of dependencies.values()) if (!await visitWarning(dependency)) { warningVisiting.delete(identity); return false; }
				warningVisiting.delete(identity);
				warnings.set(identity, { ref, record });
				return true;
			};
			const pending = [...records.values()].map(({ ref, record }) => ({ ref, record }));
			const searched = new Set<string>();
			while (query.verificationOnly !== true && pending.length && !omitted.length) {
				const target = pending.shift()!;
				if (searched.has(key(target.ref))) continue;
				searched.add(key(target.ref));
				const history = await publishedHistory(target.ref.storeId);
				if (history.error) { omitted.push({ ref: target.ref, reason: history.error }); break; }
				for (const warning of history.records) {
					if (!warningPointsToRecord(warning, target.record, history.latest.get(target.record.id))) continue;
					const ref = { storeId: target.ref.storeId, recordId: warning.id, version: warning.version };
					if (!await visitWarning(ref)) break;
				}
				for (const item of warnings.values()) if (!searched.has(key(item.ref))) pending.push(item);
			}
			const localSnapshot = checkedSnapshots.find((item) => item.storeId === localId)?.snapshotId;
			if (query.expectedSnapshotId && localSnapshot !== query.expectedSnapshotId) omitted.push({ ref: query.requestedRefs[0], reason: "snapshot-mismatch" });
			if (omitted.length) return { ...empty("incomplete", omitted), checkedSnapshots };
			let markdown = "";
			if (query.verificationOnly !== true) {
				if (records.size + warnings.size > query.maxRecords) return { ...empty("incomplete", query.requestedRefs.map((ref) => ({ ref, reason: "selection-budget-exceeded" }))), checkedSnapshots };
				markdown = "# 有界方法经验包\n\n所选记录仅在声明条件与当前限制下可供参考；标签和情境是调用方声明，入库和装载不证明科学正确、忠实使用或收益。反向警示保留原使用决定和证据状态，不自动停用或采纳经验。\n\n";
				for (const group of [records, warnings]) {
					if (group === warnings && warnings.size) markdown += "\n## 反向警示及其前提\n\n";
					for (const { ref, record } of group.values()) {
						const store = stores.get(ref.storeId)!;
						const availability = await store.availability(ref.recordId, ref.version);
						const limits = await store.limits();
						const history = await publishedHistory(ref.storeId);
						const block = `- 来源库：${ref.storeId}\n${renderKnowledgeRecord(record, availability, limits, history.latest.get(record.id))}\n`;
						if (markdown.length + block.length > query.maxChars) return { ...empty("incomplete", [{ ref, reason: "selection-budget-exceeded" }]), checkedSnapshots };
						markdown += block;
					}
				}
			}
			for (const [storeId, state] of initialState) {
				const store = stores.get(storeId)!;
				const after = JSON.stringify({ snapshot: (await store.current())?.id ?? "", limits: await store.limits() });
				if (state !== after) return { ...empty("incomplete", [{ ref: query.requestedRefs[0], reason: `knowledge-changed-during-selection:${storeId}` }]), checkedSnapshots };
			}
			return { status: "ready", markdown, selected, omitted: [], checkedSnapshots, limitsCheckedAt: checkedAt };
		},
	};
}

/** Check pinned scientific premises without requiring them to be experience records. */
export async function verifyRequiredKnowledge(workspaceRoot: string, refs: KnowledgeRef[], expectedSnapshotId?: string, registeredStores: ReadonlyMap<string, KnowledgeStore> = new Map()): Promise<void> {
	if (!Array.isArray(refs) || !refs.every(isKnowledgeRef)) throw new HarnessError("knowledge.required", "necessary knowledge refs must be valid pinned references");
	if (!refs.length) return;
	const local = createFileKnowledgeStore(path.join(path.resolve(workspaceRoot), ".agent", "knowledge"));
	await local.init();
	const localId = await local.storeId();
	const stores = new Map(registeredStores);
	stores.set(localId, local);
	const before = new Map<string, string>();
	const localSnapshot = (await local.current())?.id;
	if (expectedSnapshotId !== undefined && localSnapshot !== expectedSnapshotId) throw new HarnessError("knowledge.required", "necessary knowledge snapshot changed");
	before.set(localId, JSON.stringify({ snapshot: localSnapshot, limits: await local.limits() }));
	for (const ref of refs) {
		const store = stores.get(ref.storeId);
		if (!store || await store.storeId() !== ref.storeId) throw new HarnessError("knowledge.required", `necessary knowledge store is not registered: ${ref.storeId}`);
		if (!before.has(ref.storeId)) {
			const snapshot = (await store.current())?.id;
			before.set(ref.storeId, JSON.stringify({ snapshot, limits: await store.limits() }));
		}
		const record = await store.get(ref.recordId, ref.version);
		const availability = await store.availability(ref.recordId, ref.version);
		if (!record || availability.availability !== "usable_conditionally") throw new HarnessError("knowledge.required", `necessary knowledge is unavailable: ${ref.storeId}/${ref.recordId}@${ref.version}`);
	}
	for (const [storeId, state] of before) {
		const store = stores.get(storeId)!;
		const after = JSON.stringify({ snapshot: (await store.current())?.id, limits: await store.limits() });
		if (state !== after) throw new HarnessError("knowledge.required", `necessary knowledge changed during check: ${storeId}`);
	}
}
