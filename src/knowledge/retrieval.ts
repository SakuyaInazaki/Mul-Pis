/** Deterministic selection over the published knowledge snapshot. Relevance is not authority. */
import { HarnessError } from "../types.ts";
import { renderKnowledgeRecord } from "./pack.ts";
import type { AvailabilityReport, KnowledgePack, KnowledgeRecord, KnowledgeStore, Limit, RecordType } from "./types.ts";

export interface KnowledgeRetrievalRequest {
	purpose: string;
	/** Current objective, problem, feedback, or source goals; no model-generated synonyms. */
	text: string;
	/** Existing local IDs, optionally pinned as C001@2. These and their necessary premises cannot be dropped. */
	requiredIds?: string[];
	maxRecords: number;
	maxChars: number;
	/** Restrict relevance roots, not their necessary premises or warning records. */
	types?: RecordType[];
	/** M07 execution must load method experience only through ExperienceProvider. */
	excludeExperience?: boolean;
}

export interface KnowledgeRetrievalSelection {
	status: "ready" | "incomplete";
	pack: KnowledgePack;
	rankedRefs: string[];
	omitted: Array<{ ref: string; reason: string }>;
	snapshot?: string;
	/** Exact live-limit value validated against the store at selection return. */
	limits: Limit[];
	limitsCheckedAt: string;
}

interface Item { record: KnowledgeRecord; report: AvailabilityReport; block: string }
const key = (record: KnowledgeRecord): string => `${record.id}@${record.version}`;
const targetPattern = /^([CKEJQDX]\d{3,})(?:@(\d+))?$/;
const necessaryRelations = new Set(["applies_in"]);
const warningRelations = new Set(["refutes", "limits", "questions", "replaces", "handles"]);
const associationRelations = new Set(["supports", "checks"]);
const ignoredWords = new Set(["the", "and", "for", "with", "from", "this", "that", "are", "was", "were", "have", "has", "not", "run", "task", "source", "result", "status"]);

function terms(text: string): string[] {
	const found = new Set<string>();
	// Rank against the whole request. The output pack is bounded separately;
	// dropping tail terms here can make a relevant record impossible to find.
	for (const match of text.toLocaleLowerCase().matchAll(/[\p{Script=Han}]+|[a-z][a-z0-9_.-]{2,}|[0-9][a-z0-9_.-]{2,}/gu)) {
		const token = match[0];
		if (/[\p{Script=Han}]/u.test(token)) {
			if (token.length <= 6) found.add(token);
			else for (let i = 0; i + 2 <= token.length; i += 1) found.add(token.slice(i, i + 2));
		} else if (!ignoredWords.has(token)) found.add(token);
	}
	return [...found];
}

function strings(value: unknown): string {
	if (typeof value === "string") return value;
	if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string").join(" ");
	return "";
}

function score(record: KnowledgeRecord, words: string[]): number {
	const title = record.title.toLocaleLowerCase();
	const body = record.body.toLocaleLowerCase();
	const retrieval = record.fields.retrieval;
	const retrievalFields = typeof retrieval === "object" && retrieval !== null && !Array.isArray(retrieval) ? retrieval as Record<string, unknown> : {};
	const metadata = [record.scope.join(" "), strings(record.fields.tags), strings(record.fields.keywords), strings(record.fields.symptoms), strings(record.fields.component),
		strings(retrievalFields.tags), strings(retrievalFields.keywords), strings(retrievalFields.symptoms), strings(retrievalFields.component)].join(" ").toLocaleLowerCase();
	let total = 0;
	for (const word of words) {
		if (record.id.toLocaleLowerCase() === word.split("@")[0]) total += 20;
		if (title.includes(word)) total += 10;
		if (metadata.includes(word)) total += 5;
		if (body.includes(word)) total += Math.min(3, body.split(word).length - 1);
	}
	if (record.type === "Q" && record.qStatus?.open !== false && total) total += 2;
	if ((record.type === "D" || record.type === "J") && total) total += 1;
	return total;
}

/** Select relevant records as complete dependency groups. Never silently truncate required records. */
export async function retrieveKnowledge(store: KnowledgeStore, request: KnowledgeRetrievalRequest): Promise<KnowledgeRetrievalSelection> {
	if (!request.purpose.trim() || !Number.isSafeInteger(request.maxRecords) || request.maxRecords < 1 || request.maxRecords > 500 ||
		!Number.isSafeInteger(request.maxChars) || request.maxChars < 1 || request.maxChars > 1_000_000 ||
		!Array.isArray(request.requiredIds ?? []) || (request.requiredIds?.length ?? 0) > 100)
		throw new HarnessError("knowledge.retrieve", "invalid knowledge retrieval request or bounds");
	const snapshot = await store.current();
	const initialLimits = await store.limits();
	const checkedAt = new Date().toISOString();
	const localId = await store.storeId();
	const latest = await store.list();
	const byId = new Map(latest.map((record) => [record.id, record]));
	const reports = new Map<string, AvailabilityReport>();
	const resolved = new Map<string, KnowledgeRecord>(latest.map((record) => [key(record), record]));
	const omitted: KnowledgeRetrievalSelection["omitted"] = [];
	const selected = new Map<string, Item>();
	const words = terms(request.text);
	const prefix = `# 局部知识包\n\n- 快照：${snapshot?.id ?? "未发布"}\n- 用途：${request.purpose}\n\n入库不等于科学认证；相关性不是采用许可，当前可用性是实时派生判断。\n\n`;
	if (prefix.length > request.maxChars) throw new HarnessError("knowledge.retrieve", "knowledge retrieval header exceeds character budget");
	const omissionLine = (items: KnowledgeRetrievalSelection["omitted"]): string => items.length ? `\n（未展开 ${items.length} 项；请按 ID 补读：${items.slice(0, 20).map((item) => item.ref).join("、")}${items.length > 20 ? " 等" : ""}）\n` : "";
	let renderedLength = prefix.length;
	const fetch = async (target: string): Promise<KnowledgeRecord | undefined> => {
		const parsed = targetPattern.exec(target);
		if (!parsed) return undefined;
		const id = parsed[1], version = parsed[2] ? Number(parsed[2]) : undefined;
		const local = version === undefined ? byId.get(id) : resolved.get(`${id}@${version}`);
		if (local) return local;
		const record = await store.get(id, version);
		if (record) resolved.set(key(record), record);
		return record;
	};
	let publishedHistory: Promise<{ records: KnowledgeRecord[]; error?: string }> | undefined;
	const historicalRecords = (): Promise<{ records: KnowledgeRecord[]; error?: string }> => {
		publishedHistory ??= (async () => {
			// Reverse premise and warning edges live on their source versions. A
			// revision may remove an edge while the older published version still
			// matters to a pinned historical target.
			const records: KnowledgeRecord[] = [];
			for (const record of latest) for (let version = 1; version <= record.version; version++) {
				const historical = version === record.version ? record : await store.get(record.id, version);
				if (!historical) return { records: [], error: `historical-premise-unavailable:${record.id}@${version}` };
				records.push(historical);
			}
			return { records };
		})();
		return publishedHistory;
	};
	const dependencies = async (record: KnowledgeRecord): Promise<{ targets: string[]; error?: string }> => {
		const found = new Set<string>();
		for (const scope of record.scope) found.add(scope);
		for (const ref of record.refs) if (necessaryRelations.has(ref.rel)) found.add(ref.target);
		if (record.type === "J") {
			const history = await historicalRecords();
			if (history.error) return { targets: [], error: history.error };
			for (const candidate of history.records) for (const ref of candidate.refs) {
				if (ref.rel === "premise_of" && (ref.target === key(record) || (ref.target === record.id && byId.get(record.id)?.version === record.version))) found.add(key(candidate));
			}
		}
		const experience = record.fields.experience as { requiredRefs?: Array<{storeId: string; recordId: string; version: number}> } | undefined;
		for (const ref of experience?.requiredRefs ?? []) {
			if (ref.storeId !== localId) found.add(`external:${ref.storeId}/${ref.recordId}@${ref.version}`);
			else found.add(`${ref.recordId}@${ref.version}`);
		}
		return { targets: [...found] };
	};
	const group = async (root: KnowledgeRecord): Promise<{ records: KnowledgeRecord[]; error?: string }> => {
		const members = new Map<string, KnowledgeRecord>();
		const visiting = new Set<string>();
		const visit = async (record: KnowledgeRecord): Promise<string | undefined> => {
			const identity = key(record);
			if (request.excludeExperience && record.fields.experience !== undefined) return `experience-requires-explicit-provider:${identity}`;
			if (members.has(identity)) return;
			if (visiting.has(identity)) return `dependency-cycle:${identity}`;
			visiting.add(identity);
			const required = await dependencies(record);
			if (required.error) return required.error;
			for (const target of required.targets) {
				const dependency = await fetch(target);
				if (!dependency) return `missing-dependency:${target}`;
				const issue = await visit(dependency);
				if (issue) return issue;
			}
			visiting.delete(identity);
			members.set(identity, record);
		};
		const error = await visit(root);
		return { records: [...members.values()], error };
	};
	const targetMatches = (target: string, record: KnowledgeRecord): boolean =>
		target === key(record) || (target === record.id && byId.get(record.id)?.version === record.version);
	const bundle = async (root: KnowledgeRecord): Promise<{ records: KnowledgeRecord[]; error?: string }> => {
		const history = await historicalRecords();
		if (history.error) return { records: [], error: history.error };
		const members = new Map<string, KnowledgeRecord>();
		const pending = [root];
		while (pending.length) {
			const next = pending.shift()!;
			if (members.has(key(next))) continue;
			const closure = await group(next);
			if (closure.error) return { records: [], error: closure.error };
			for (const record of closure.records) if (!members.has(key(record))) {
				members.set(key(record), record);
				for (const warning of history.records) {
					if (request.excludeExperience && warning.fields.experience !== undefined) continue;
					if (warning.refs.some((ref) => warningRelations.has(ref.rel) && targetMatches(ref.target, record))) pending.push(warning);
				}
			}
		}
		return { records: [...members.values()] };
	};
	const add = async (root: KnowledgeRecord, mandatory: boolean): Promise<boolean> => {
		const identity = key(root);
		if (selected.has(identity)) return true;
		const closure = await bundle(root);
		if (closure.error) { omitted.push({ ref: identity, reason: closure.error }); return false; }
		const additions: Item[] = [];
		for (const record of closure.records) {
			if (selected.has(key(record))) continue;
			let report = reports.get(key(record));
			if (!report) { report = await store.availability(record.id, record.version); reports.set(key(record), report); }
			additions.push({ record, report, block: renderKnowledgeRecord(record, report, initialLimits) });
		}
		const addedLength = additions.reduce((sum, item) => sum + item.block.length + 1, 0);
		if (selected.size + additions.length > request.maxRecords || renderedLength + addedLength + omissionLine(omitted).length > request.maxChars) {
			omitted.push({ ref: identity, reason: mandatory ? "required-group-over-budget" : "group-over-budget" });
			return false;
		}
		for (const item of additions) { selected.set(key(item.record), item); resolved.set(key(item.record), item.record); }
		renderedLength += addedLength;
		return true;
	};
	const addAssociations = async (newRoots: string[]): Promise<void> => {
		const roots = newRoots.map((identity) => resolved.get(identity)).filter((record): record is KnowledgeRecord => !!record);
		const history = await historicalRecords();
		if (history.error) return;
		for (const record of history.records) {
			if (selected.has(key(record)) || (request.excludeExperience && record.fields.experience !== undefined)) continue;
			if (record.refs.some((ref) => associationRelations.has(ref.rel) && roots.some((root) => targetMatches(ref.target, root)))) await add(record, false);
		}
	};
	let complete = true;
	for (const id of request.requiredIds ?? []) {
		const record = await fetch(id);
		if (!record) { omitted.push({ ref: id, reason: "required-record-not-published" }); complete = false; continue; }
		if (!await add(record, true)) complete = false;
	}
	const allowed = new Set(request.types ?? ["C", "K", "E", "J", "Q", "D", "X"]);
	const candidates = latest.filter((record) => allowed.has(record.type) && (!request.excludeExperience || record.fields.experience === undefined)).map((record) => ({ record, relevance: score(record, words) })).filter((item) => item.relevance > 0);
	candidates.sort((a, b) => b.relevance - a.relevance || a.record.id.localeCompare(b.record.id));
	for (const { record } of candidates) if (!selected.has(key(record))) {
		const before = new Set(selected.keys());
		if (await add(record, false)) await addAssociations([...selected.keys()].filter((identity) => !before.has(identity)));
	}
	// Explicit roots may have supporting arguments or checks with no lexical match.
	await addAssociations([...selected.keys()]);
	const history = await historicalRecords();
	if (history.error) {
		complete = false;
		omitted.push({ ref: "published-history", reason: history.error });
	}
	const chosen = [...selected.values()];
	const body = chosen.map((item) => item.block).join("\n");
	let markdown = `${prefix}${body}${omissionLine(omitted)}`;
	if (markdown.length > request.maxChars) {
		// Omission metadata is useful, but never allowed to break the hard character limit.
		markdown = `${prefix}${body}`;
	}
	const current = await store.current();
	const finalLimits = await store.limits();
	if (current?.id !== snapshot?.id || JSON.stringify(finalLimits) !== JSON.stringify(initialLimits))
		throw new HarnessError("knowledge.retrieve", "knowledge snapshot or live limits changed during retrieval; reselect");
	const pack: KnowledgePack = { snapshot: snapshot?.id, purpose: request.purpose, markdown, included: chosen.map((item) => ({ id: item.record.id, version: item.record.version, availability: item.report.availability })), omitted: omitted.map((item) => item.ref), truncated: omitted.length > 0 };
	return { status: complete ? "ready" : "incomplete", pack, rankedRefs: chosen.map((item) => key(item.record)), omitted, snapshot: snapshot?.id, limits: structuredClone(initialLimits), limitsCheckedAt: checkedAt };
}
