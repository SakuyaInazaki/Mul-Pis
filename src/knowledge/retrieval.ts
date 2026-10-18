/** Deterministic selection over the published knowledge snapshot. Relevance is not authority. */
import { HarnessError } from "../types.ts";
import { renderKnowledgeIndexRecord, renderKnowledgeRecord } from "./pack.ts";
import { isNecessaryPremise } from "./relations.ts";
import type { AvailabilityReport, KnowledgePack, KnowledgeRecord, KnowledgeStore, Limit, RecordType } from "./types.ts";

/** Explicit observations about this retrieval, not inferred from prose or record titles.
 * Records may use the same shape at fields.retrieval.context: their scalars
 * declare required applicability settings, NOT merely where evidence was collected.
 * Put incidental source-platform/version provenance in other fields instead.
 * Arrays describe positive features, never an exhaustive list of what exists.
 * Values use exact, case-sensitive labels; no aliases or version ranges. */
export interface KnowledgeRetrievalContext {
	stage?: string;
	backend?: string;
	toolchain?: string;
	dtype?: string;
	layout?: string;
	structure?: string[];
	appliedTransforms?: string[];
	symptoms?: string[];
}

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
	/** Brief projects literal evidence/conditions; index omits bodies. Both can
	 * traverse the full published catalogue. Bounds limit materialization, not
	 * a fixed top-k recommendation policy. */
	/** Internal discovery projection: retain ordered identities and status without
	 * rendering every matching card before a caller chooses a record page. */
	view?: "full" | "brief" | "index" | "refs";
	/** Exact record reading: expand required dependency/warning groups without
	 * adding unrelated relevance roots. Current supporting/checking records of
	 * explicit roots are also shown; historical versions remain addressable by ID. */
	onlyRequired?: boolean;
	/** Only explicit scalar conflicts filter automatic relevance roots. Required
	 * records, premises and warnings stay visible with their contextual caveats. */
	context?: KnowledgeRetrievalContext;
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
const ignoredWords = new Set(["the", "and", "for", "with", "from", "this", "that", "are", "was", "were", "have", "has", "not", "run", "task", "source", "result", "status",
	"to", "of", "in", "on", "at", "as", "by", "is", "it", "be", "or", "if", "an", "we", "do"]);
// These short connective words alone do not identify a scientific mechanism.
// Exact API/error tokens and more specific Chinese terms remain searchable.
const ignoredHanWords = new Set(["是否", "条件"]);
const scalarContextKeys = ["stage", "backend", "toolchain", "dtype", "layout"] as const;
const featureContextKeys = ["structure", "appliedTransforms", "symptoms"] as const;
const contextKeys = new Set<string>([...scalarContextKeys, ...featureContextKeys]);
const contextLabel = (value: unknown): value is string => typeof value === "string" &&
	value.trim().length > 0 && !/[\u0000-\u001f\u007f]/u.test(value);

function isRetrievalContext(value: unknown): value is KnowledgeRetrievalContext {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return false;
	const fields = value as Record<string, unknown>;
	return Object.keys(fields).every(key => contextKeys.has(key)) &&
		scalarContextKeys.every(key => fields[key] === undefined || contextLabel(fields[key])) &&
		featureContextKeys.every(key => fields[key] === undefined ||
			Array.isArray(fields[key]) && fields[key].every(contextLabel));
}

/** Shared by tool/schema callers; unknown or malformed request fields are not silently ignored. */
export function validateKnowledgeRetrievalContext(value: unknown): KnowledgeRetrievalContext | undefined {
	if (value === undefined) return undefined;
	if (!isRetrievalContext(value)) throw new HarnessError("knowledge.retrieve", "invalid explicit retrieval context");
	return structuredClone(value);
}

interface ContextMatch { matches: string[]; conflicts: string[]; unknown: string[]; malformed: boolean }

function matchContext(record: KnowledgeRecord, context: KnowledgeRetrievalContext): ContextMatch {
	const result: ContextMatch = { matches: [], conflicts: [], unknown: [], malformed: false };
	const retrieval = record.fields.retrieval;
	const raw = retrieval && typeof retrieval === "object" && !Array.isArray(retrieval)
		? (retrieval as Record<string, unknown>).context : undefined;
	if (raw === undefined) { result.unknown.push("record-context"); return result; }
	// Legacy or malformed metadata never becomes a guessed exclusion rule.
	if (!isRetrievalContext(raw)) { result.malformed = true; return result; }
	for (const key of scalarContextKeys) {
		const expected = raw[key], observed = context[key];
		if (expected === undefined) continue;
		if (observed === undefined) result.unknown.push(key);
		else if (expected === observed) result.matches.push(key);
		else result.conflicts.push(key);
	}
	for (const key of featureContextKeys) {
		const expected = raw[key];
		if (!expected?.length) continue;
		const observed = new Set(context[key] ?? []);
		for (const label of new Set(expected)) {
			if (observed.has(label)) result.matches.push(`${key}:${label}`);
			else result.unknown.push(`${key}:${label}`);
		}
	}
	return result;
}

function contextCaveat(match: ContextMatch): string {
	return [
		"- 检索情境只影响相关性，不改变原记录的采用、适用条件或生效限制。",
		...(match.conflicts.length ? [`- 明确情境不匹配：${match.conflicts.join("、")}；本条因显式读取或证据关系保留，不据此认定当前可应用。`] : []),
		...(match.unknown.length ? [`- 尚未核实的情境：${match.unknown.join("、")}；缺少信息不等于条件成立或不成立。`] : []),
		...(match.malformed ? ["- 条目检索情境格式未知；未据此过滤，须核对原始元数据和证据。"] : []),
	].join("\n");
}

/** A bare warning target follows only the current version; a pinned target keeps its historical meaning. */
export function warningPointsToRecord(warning: KnowledgeRecord, target: KnowledgeRecord, latestVersion?: number): boolean {
	return warning.refs.some((ref) => warningRelations.has(ref.rel) &&
		(ref.target === `${target.id}@${target.version}` || (ref.target === target.id && latestVersion === target.version)));
}

/** Reverse edges can live on older published source versions; unpublished files never enter this view. */
export async function publishedKnowledgeHistory(store: KnowledgeStore, latest: KnowledgeRecord[]): Promise<{ records: KnowledgeRecord[]; error?: string }> {
	const records: KnowledgeRecord[] = [];
	for (const record of latest) for (let version = 1; version <= record.version; version++) {
		const historical = version === record.version ? record : await store.get(record.id, version);
		if (!historical) return { records: [], error: `historical-premise-unavailable:${record.id}@${version}` };
		records.push(historical);
	}
	return { records };
}

function lexicalTokens(text: string): string[] {
	const found: string[] = [];
	// Keep qualified API names intact as well as their components. Chinese
	// bigrams match a short query inside a longer sentence without an ML model.
	for (const match of text.toLocaleLowerCase().matchAll(/[\p{Script=Han}]+|[a-z_][a-z0-9_]*(?:(?:::|\.)[a-z_][a-z0-9_]*)*|[0-9][a-z0-9_.-]{2,}/gu)) {
		const token = match[0];
		if (/[\p{Script=Han}]/u.test(token)) {
			if (token.length <= 6 && !ignoredHanWords.has(token)) found.push(token);
			for (let i = 0; i + 2 <= token.length; i++) {
				const word = token.slice(i, i + 2);
				if (!ignoredHanWords.has(word)) found.push(word);
			}
		} else {
			// Short diagnostic/API symbols can be the entire query (for example a
			// two-letter timing field). Keep them under the same IDF weighting as
			// longer terms while discarding common English connectives above.
			if (token.length >= 2 && !ignoredWords.has(token)) found.push(token);
			if (token.includes(".") || token.includes("::")) for (const part of token.split(/::|\./u))
				if (part.length >= 2 && !ignoredWords.has(part)) found.push(part);
		}
	}
	return found;
}

function terms(text: string): string[] { return [...new Set(lexicalTokens(text))]; }

function strings(value: unknown): string {
	if (typeof value === "string") return value;
	if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string").join(" ");
	return "";
}

interface LexicalProfile { record: KnowledgeRecord; title: Map<string, number>; metadata: Map<string, number>; body: Map<string, number>; length: number; normalizedTitle: string; normalizedMetadata: string; normalizedBody: string }
function frequencies(value: string): Map<string, number> {
	const result = new Map<string, number>();
	for (const token of lexicalTokens(value)) result.set(token, (result.get(token) ?? 0) + 1);
	return result;
}
function lexicalProfile(record: KnowledgeRecord): LexicalProfile {
	const retrieval = record.fields.retrieval;
	const retrievalFields = typeof retrieval === "object" && retrieval !== null && !Array.isArray(retrieval) ? retrieval as Record<string, unknown> : {};
	const declaredContext = isRetrievalContext(retrievalFields.context) ? retrievalFields.context : undefined;
	// Index declared applicability and diagnostic signatures, not only the title
	// or the operator name. These are literal recorded fields, never inferred
	// synonyms or newly asserted scientific conditions.
	const metadata = [record.scope.join(" "), strings(record.fields.tags), strings(record.fields.keywords), strings(record.fields.symptoms), strings(record.fields.component),
		strings(record.fields.api), strings(record.fields.apis), strings(record.fields.symbols), strings(record.fields.errorSignature), strings(record.fields.errorSignatures),
		strings(record.fields.bottleneck), strings(record.fields.canonical_family), strings(record.fields.profiling_signal), strings(record.fields.retrieval_keywords),
		strings(retrievalFields.tags), strings(retrievalFields.keywords), strings(retrievalFields.symptoms), strings(retrievalFields.component),
		strings(retrievalFields.api), strings(retrievalFields.symbols), strings(retrievalFields.errorSignature),
		...(declaredContext ? [...scalarContextKeys, ...featureContextKeys].map(field => strings(declaredContext[field])) : [])].join(" ");
	const title = frequencies(record.title), metadataTerms = frequencies(metadata), body = frequencies(record.body);
	return { record, title, metadata: metadataTerms, body,
		length: Math.max(1, [...title.values(), ...metadataTerms.values(), ...body.values()].reduce((sum, count) => sum + count, 0)),
		normalizedTitle: record.title.toLocaleLowerCase().replace(/\s+/gu, " "),
		normalizedMetadata: metadata.toLocaleLowerCase().replace(/\s+/gu, " "),
		normalizedBody: record.body.toLocaleLowerCase().replace(/\s+/gu, " ") };
}

/** Field-weighted BM25: IDF prevents generic long notes from drowning an exact
 * diagnostic/API match; length and TF are measured over the published corpus. */
function score(profile: LexicalProfile, words: string[], frequenciesByTerm: Map<string, number>, averageLength: number,
	corpusSize: number, phrase: string): number {
	const { record } = profile;
	let total = 0;
	for (const word of words) {
		if (record.id.toLocaleLowerCase() === word.split("@")[0]) total += 30;
		const idf = Math.log(1 + (corpusSize - (frequenciesByTerm.get(word) ?? 0) + 0.5) / ((frequenciesByTerm.get(word) ?? 0) + 0.5));
		const tf = (profile.title.get(word) ?? 0) * 6 + (profile.metadata.get(word) ?? 0) * 3 + (profile.body.get(word) ?? 0);
		if (!tf) continue;
		const normalization = 1.2 * (0.25 + 0.75 * profile.length / averageLength);
		total += idf * tf * 2.2 / (tf + normalization);
		if (word.includes(".") || word.includes("::") || word.includes("_"))
			total += idf * ((profile.title.has(word) ? 5 : 0) + (profile.metadata.has(word) ? 3 : 0) + (profile.body.has(word) ? 1 : 0));
	}
	if (phrase.length >= 12 && words.length >= 2) {
		if (profile.normalizedTitle.includes(phrase)) total += 8;
		else if (profile.normalizedMetadata.includes(phrase)) total += 5;
		else if (profile.normalizedBody.includes(phrase)) total += 2;
	}
	if (record.type === "Q" && record.qStatus?.open !== false && total) total += 2;
	if ((record.type === "D" || record.type === "J") && total) total += 1;
	return total;
}

/** Literal, bounded projection for decisions in progress. The original remains
 * available through knowledge_read; no prose is paraphrased into a new claim. */
export function renderKnowledgeBriefRecord(record: KnowledgeRecord, availability: AvailabilityReport, limits: Limit[], latestVersion?: number): string {
	const field = (name: string): string | undefined => typeof record.fields[name] === "string" ? String(record.fields[name]).trim() : undefined;
	const excerpt = (value: string, max = 220): string => value.length <= max ? value : `${value.slice(0, max)}…（按 ID 读取原文）`;
	const active = limits.filter(limit => !limit.liftedAt && (limit.target === record.id || limit.target === `${record.id}@${record.version}`));
	const limitCounts = new Map<string, number>();
	for (const item of active) {
		const label = `${item.kind}:${item.target}`;
		limitCounts.set(label, (limitCounts.get(label) ?? 0) + 1);
	}
	const context = record.fields.retrieval && typeof record.fields.retrieval === "object" && !Array.isArray(record.fields.retrieval)
		? (record.fields.retrieval as Record<string, unknown>).context : undefined;
	const paragraphs = record.body.trim().split(/\n\s*\n/u);
	const body = paragraphs.find(part => part.trim()) ?? "";
	const statedLimit = field("limitations") ?? paragraphs.find(part => /^\s*(?:限制|局限|limitations?)\s*[:：]/iu.test(part));
	const boundaryParagraphs = paragraphs.filter(part => part !== body && /(?:适用|前提|条件|限制|局限|避免|反例|失败|风险|precondition|applicable|avoid|do.not.apply|limitation|counterexample|risk)/iu.test(part));
	const questionStatus = record.type !== "Q" || !record.qStatus ? undefined : record.qStatus.open ? "开放" :
		`已关闭（原因 ${record.qStatus.closeReason ?? "未登记"}${record.qStatus.closedBy ? `；关闭者 ${record.qStatus.closedBy}` : ""}）；关闭不等于正文命题已获证实，残余问题仍以原文为准`;
	return [`### ${record.id}@${record.version} ${record.title}`,
		`- 登记来源：${record.source.stage}/${record.source.runId}${field("task") ? ` · 任务 ${field("task")}` : ""}；来源登记不等于原始证据已读`,
		`- 阶段/适用前提：${context === undefined ? "未结构化登记；须读原文核对" : JSON.stringify(context)}；scope：${record.scope.join("、") || "未限定"}`,
		...(field("bottleneck") ? [`- 瓶颈（原字段）：${excerpt(field("bottleneck")!)}`] : []),
		...(field("canonical_family") ? [`- 结构模式（原字段）：${excerpt(field("canonical_family")!)}`] : []),
		...(field("profiling_signal") ? [`- 性能信号（原字段）：${excerpt(field("profiling_signal")!)}`] : []),
		`- 原文片段：${excerpt(body.replace(/\s+/gu, " ")) || "无"}`,
		...boundaryParagraphs.slice(0, 2).map(part => `- 原文边界/反例片段：${excerpt(part.replace(/\s+/gu, " "), 180)}`),
		...(paragraphs.length > 1 ? ["- 正文尚有未展开内容；不能据此短卡认定已核对全文。"] : []),
		...(field("mechanism") ? [`- 原理（原字段）：${excerpt(field("mechanism")!)}`] : []),
		...(field("conditions") ? [`- 条件（原字段）：${excerpt(field("conditions")!)}`] : []),
		...(field("reusable_when") ? [`- 可复用条件（原字段）：${excerpt(field("reusable_when")!)}`] : []),
		...(field("avoid_when") ? [`- 避免条件（原字段）：${excerpt(field("avoid_when")!)}`] : []),
		...(field("do_not_apply_when") ? [`- 不适用条件（原字段）：${excerpt(field("do_not_apply_when")!)}`] : []),
		...(field("risk") ? [`- 风险（原字段）：${excerpt(field("risk")!)}`] : []),
		...(statedLimit ? [`- 原文限制：${excerpt(statedLimit.replace(/\s+/gu, " "), 180)}`] : []),
		...(questionStatus ? [`- 问题状态：${questionStatus}`] : []),
		`- 证据/决定：${record.evidenceStatus ? excerpt(record.evidenceStatus, 180) : "未登记"}；${record.usageDecision ?? "未记录"}；当前 ${availability.availability}`,
		...(field("evidence") ? [`- 证据入口（原字段）：${excerpt(field("evidence")!, 180)}（须读取核对）`] : []),
		...(field("artifact") ? [`- 原记录成果路径：${field("artifact")}（路径自身不授权读取）`] : []),
		...(field("candidate") ? [`- 原记录候选源码：${excerpt(field("candidate")!, 180)}（精确冻结映射须调用 knowledge_artifact_read）`] : []),
		...(Array.isArray(record.fields.artifacts) ? [`- 原记录成果路径：${record.fields.artifacts.length} 项；${excerpt(record.fields.artifacts.filter((item): item is string => typeof item === "string").slice(0, 2).join("、"), 180)}；完整路径见 knowledge_read，指定路径可调用 knowledge_artifact_read`] : []),
		`- 负例/关系：${record.type === "E" || record.type === "Q" || record.type === "X" ? `类型 ${record.type}；` : ""}${record.refs.map(ref => `${ref.rel}→${ref.target}${ref.inputRole ? `（输入作用：${ref.inputRole}）` : ""}`).join("、") || "无"}`,
		`- 生效限制：${active.length ? [...limitCounts].map(([label, count]) => `${label}${count > 1 ? `×${count}` : ""}`).join("、") : "无"}；完整原因 ${availability.reasons.length} 条，须按 ID 读取`,
		...(latestVersion && latestVersion !== record.version ? [`- 历史版本；当前发布 ${record.id}@${latestVersion}`] : []),
		"- 仅供阶段判断；使用前读原文、完整限制及必要证据。", ""].join("\n");
}

/** Render one already selected record with the same context caveats as a pack. */
export function renderSelectedKnowledgeRecord(record: KnowledgeRecord, availability: AvailabilityReport, limits: Limit[],
	latestVersion: number | undefined, view: "brief" | "index", context?: KnowledgeRetrievalContext): string {
	const block = view === "brief" ? renderKnowledgeBriefRecord(record, availability, limits, latestVersion)
		: renderKnowledgeIndexRecord(record, availability, limits, latestVersion);
	return context ? `${block}${contextCaveat(matchContext(record, context))}\n` : block;
}

/** Select relevant records as complete dependency groups. Never silently truncate required records. */
export async function retrieveKnowledge(store: KnowledgeStore, request: KnowledgeRetrievalRequest): Promise<KnowledgeRetrievalSelection> {
	if (!request.purpose.trim() || !Number.isSafeInteger(request.maxRecords) || request.maxRecords < 1 || ((request.view === undefined || request.view === "full") && request.maxRecords > 500) ||
		!Number.isSafeInteger(request.maxChars) || request.maxChars < 1 || ((request.view === undefined || request.view === "full") && request.maxChars > 1_000_000) ||
		(request.view !== undefined && !["full", "brief", "index", "refs"].includes(request.view)) ||
		(request.onlyRequired !== undefined && typeof request.onlyRequired !== "boolean") ||
		!Array.isArray(request.requiredIds ?? []) || ((request.view === undefined || request.view === "full") && (request.requiredIds?.length ?? 0) > 100))
		throw new HarnessError("knowledge.retrieve", "invalid knowledge retrieval request or bounds");
	const context = validateKnowledgeRetrievalContext(request.context);
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
	const profiles = latest.map(lexicalProfile);
	const documentFrequencies = new Map<string, number>();
	for (const profile of profiles) for (const word of new Set([...profile.title.keys(), ...profile.metadata.keys(), ...profile.body.keys()]))
		documentFrequencies.set(word, (documentFrequencies.get(word) ?? 0) + 1);
	const averageLength = profiles.length ? profiles.reduce((sum, profile) => sum + profile.length, 0) / profiles.length : 1;
	const phrase = request.text.toLocaleLowerCase().trim().replace(/\s+/gu, " ");
	const prefix = `# 局部知识包\n\n- 快照：${snapshot?.id ?? "未发布"}\n- 本库 storeId：${localId}\n- 用途：${request.purpose}\n${context ? `- 本次明确检索情境：${JSON.stringify(context)}\n` : ""}\n入库不等于科学认证；相关性不是采用许可，当前可用性是实时派生判断。${context ? "负经验仅在原记录条件和证据范围内成立，不因召回而成为全局禁令。" : ""}\n\n`;
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
		publishedHistory ??= publishedKnowledgeHistory(store, latest);
		return publishedHistory;
	};
	const dependencies = async (record: KnowledgeRecord): Promise<{ targets: string[]; error?: string }> => {
		const found = new Set<string>();
		for (const scope of record.scope) found.add(scope);
		for (const ref of record.refs) if (necessaryRelations.has(ref.rel)) found.add(ref.target);
		if (record.type === "J") {
			for (const ref of record.refs) if (isNecessaryPremise(ref)) found.add(ref.target);
			const history = await historicalRecords();
			if (history.error) return { targets: [], error: history.error };
			for (const candidate of history.records) for (const ref of candidate.refs) {
				if ((candidate.type === "C" || candidate.type === "E") && isNecessaryPremise(ref) &&
					(ref.target === key(record) || (ref.target === record.id && byId.get(record.id)?.version === record.version))) found.add(key(candidate));
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
					if (warningPointsToRecord(warning, record, byId.get(record.id)?.version)) pending.push(warning);
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
		if (context && !mandatory) {
			// Necessary context/premises constrain an automatic root too. Reverse
			// warnings are deliberately excluded from this applicability check:
			// an out-of-context warning must remain evidence, not suppress a claim.
			const premises = await group(root);
			const conflicts = premises.records.flatMap(record => matchContext(record, context).conflicts
				.map(field => `${key(record)}:${field}`));
			if (conflicts.length) {
				omitted.push({ ref: identity, reason: `context-mismatch:${conflicts.join(",")}` });
				return false;
			}
		}
		const additions: Item[] = [];
		for (const record of closure.records) {
			if (selected.has(key(record))) continue;
			let report = reports.get(key(record));
			if (!report) { report = await store.availability(record.id, record.version); reports.set(key(record), report); }
			let block: string;
			if (request.view === "refs") block = "";
			else if (request.view === "index" || request.view === "brief")
				block = renderSelectedKnowledgeRecord(record, report, initialLimits, byId.get(record.id)?.version, request.view, context);
			else {
				const full = renderKnowledgeRecord(record, report, initialLimits, byId.get(record.id)?.version);
				block = context ? `${full}${contextCaveat(matchContext(record, context))}\n` : full;
			}
			additions.push({ record, report, block });
		}
		const addedLength = request.view === "refs" ? 0 : additions.reduce((sum, item) => sum + item.block.length + 1, 0);
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
		// Reverse support/check links are discovery aids, not necessary premises or
		// warnings. For an explicit root, expose current supporting records without
		// expanding every superseded version of one argument. The full published
		// history remains available through explicit ID/version reads.
		for (const record of latest) {
			if (selected.has(key(record)) || (request.excludeExperience && record.fields.experience !== undefined)) continue;
			if (record.refs.some((ref) => associationRelations.has(ref.rel) && roots.some((root) => targetMatches(ref.target, root)))) await add(record, false);
		}
	};
	const addLocalPremises = async (): Promise<void> => {
		const argumentsInView = [...selected.values()].map((item) => item.record).filter((record) => record.type === "J");
		if (!argumentsInView.length) return;
		const history = await historicalRecords();
		if (history.error) return;
		for (const argument of argumentsInView) {
			for (const ref of argument.refs) if (ref.rel === "premise_of" && !isNecessaryPremise(ref)) {
				const input = await fetch(ref.target);
				if (input) await add(input, false);
			}
			for (const candidate of history.records) {
				if (candidate.type !== "C" && candidate.type !== "E") continue;
				if (candidate.refs.some((ref) => ref.rel === "premise_of" && !isNecessaryPremise(ref) && targetMatches(ref.target, argument)))
					await add(candidate, false);
			}
		}
	};
	let complete = true;
	for (const id of request.requiredIds ?? []) {
		const record = await fetch(id);
		if (!record) { omitted.push({ ref: id, reason: "required-record-not-published" }); complete = false; continue; }
		if (!await add(record, true)) complete = false;
	}
	// The caller asked for these roots; their direct supporting/checking records
	// are useful context. An automatically matched broad conclusion does not by
	// itself authorize pulling in every historical evidence sibling.
	if (request.requiredIds?.length) await addAssociations([...selected.keys()]);
	const allowed = new Set(request.types ?? ["C", "K", "E", "J", "Q", "D", "X"]);
	const candidates = (request.onlyRequired ? [] : profiles).filter(({ record }) => allowed.has(record.type) && (!request.excludeExperience || record.fields.experience === undefined)).flatMap((profile) => {
		const { record } = profile;
		const match = context ? matchContext(record, context) : undefined;
		const lexicalRelevance = score(profile, words, documentFrequencies, averageLength, profiles.length, phrase);
		// With an explicit topic, a generic context label (for example stage)
		// ranks lexical hits but does not summon every record from that stage.
		// A context-only request remains an intentional way to browse by context.
		const relevance = words.length && lexicalRelevance <= 0 ? 0 : lexicalRelevance + (match?.matches.length ?? 0) * 5;
		if (relevance <= 0) return [];
		if (match?.conflicts.length && !selected.has(key(record))) {
			omitted.push({ ref: key(record), reason: `context-mismatch:${match.conflicts.join(",")}` });
			return [];
		}
		return [{ record, relevance }];
	});
	candidates.sort((a, b) => b.relevance - a.relevance || a.record.id.localeCompare(b.record.id));
	for (const { record } of candidates) if (!selected.has(key(record))) await add(record, false);
	// Local and temporary assumptions remain visible with their input role, but
	// cannot force an adopted-fact dependency or a record-level limit.
	await addLocalPremises();
	// A filtered root may still be required by a selected record. The complete
	// evidence group wins over relevance filtering, with caveats rendered above.
	for (let i = omitted.length - 1; i >= 0; i--) if (selected.has(omitted[i].ref) &&
		omitted[i].reason.startsWith("context-mismatch:")) omitted.splice(i, 1);
	const history = await historicalRecords();
	if (history.error) {
		complete = false;
		omitted.push({ ref: "published-history", reason: history.error });
	}
	const chosen = [...selected.values()];
	const body = request.view === "refs" ? "" : chosen.map((item) => item.block).join("\n");
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
