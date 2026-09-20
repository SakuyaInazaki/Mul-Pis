import { open, mkdir, readFile, readdir, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { HarnessError } from "../types.ts";
import { nowIso, readTextIfExists, writeFileAtomic } from "../workspace.ts";
import { buildKnowledgePack } from "./pack.ts";
import { regenerateKnowledgeViews } from "./views.ts";
import type {
	AvailabilityReport,
	ImpactItem,
	KnowledgePack,
	KnowledgeRecord,
	KnowledgeStore,
	Limit,
	ListFilter,
	MergeResult,
	PackQuery,
	ProposalBatch,
	ProposalOp,
	ProposalReceipt,
	QCloseReason,
	RecordType,
	Ref,
	RelType,
	Snapshot,
	UsageDecision,
	ValidationIssue,
} from "./types.ts";
import { RECORD_TYPES } from "./types.ts";

const REL_TYPES: readonly RelType[] = ["premise_of", "supports", "refutes", "limits", "questions", "checks", "handles", "replaces", "splits", "applies_in", "located_in"];
const USAGE_DECISIONS: readonly UsageDecision[] = ["candidate", "working_assumption", "adopted", "suspended", "withdrawn", "replaced"];
const CLOSE_REASONS: readonly QCloseReason[] = ["answered", "not_valid", "duplicate", "out_of_scope", "shelved"];
const LIMIT_KINDS: readonly Limit["kind"][] = ["suspended", "withdrawn", "needs_recheck"];
const INPUT_ROLES = ["condition", "local_assumption", "temporary_assumption", "definition", "data", "adopted_result"] as const;
const IMPACT_RELATIONS: readonly RelType[] = ["premise_of", "supports", "refutes", "limits", "checks", "applies_in"];
const LOCK_STALE_MS = 10 * 60 * 1000;

const RULES_TEXT = `# 知识库工作规则

七类对象：C 认识条目、K 候选判据、E 依据项、J 论证记录、Q 质疑与未决、D 处理与修订决定、X 研究情境。

三种状态必须分开：依据状况、历史使用决定、当前可用性。入库不等于科学认证；当前可用性由记录与生效限制派生。

关系只在规定的权威位置写入；实质修订产生新版本；影响分析只传播“需检查”；停用优先登记；全部修改经单一串行入口合入。索引与视图由权威记录生成，不可手改为另一套事实。
`;

const EMPTY_VIEW_FILES: Readonly<Record<string, string>> = {
	"current-understanding.md": "# 当前认识\n\n- 无\n",
	"corrections.md": "# 处理、纠正与修订\n\n- 无\n",
	"open-questions.md": "# 开放质疑与未决问题\n\n- 无\n",
	"limits.md": "# 当前限制\n\n- 无\n",
};

interface RecordIndex {
	id: string;
	type: RecordType;
	versions: number[];
	latestVersion: number;
}

interface VirtualEntry {
	type: RecordType;
	versions: Set<number>;
	latestVersion: number;
	qOpen?: boolean;
}

interface ValidationState {
	entries: Map<string, VirtualEntry>;
	activeLimitTargets: string[];
}

interface PlannedIds {
	handles: Map<string, string>;
	decisionIds: Map<number, string>;
}

interface ChangedTarget {
	id: string;
	version?: number;
	allVersions: boolean;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function errorCode(error: unknown): string | undefined {
	return isObject(error) && typeof error.code === "string" ? error.code : undefined;
}

async function exists(filePath: string): Promise<boolean> {
	try {
		await stat(filePath);
		return true;
	} catch (error) {
		if (errorCode(error) === "ENOENT") return false;
		throw error;
	}
}

async function writeIfMissing(filePath: string, content: string): Promise<void> {
	await mkdir(path.dirname(filePath), { recursive: true });
	try {
		const handle = await open(filePath, "wx");
		try {
			await handle.writeFile(content, "utf8");
			await handle.sync();
		} finally {
			await handle.close();
		}
	} catch (error) {
		if (errorCode(error) !== "EEXIST") throw error;
	}
}

async function writeExclusive(filePath: string, content: string): Promise<void> {
	await mkdir(path.dirname(filePath), { recursive: true });
	try {
		const handle = await open(filePath, "wx");
		try {
			await handle.writeFile(content, "utf8");
			await handle.sync();
		} finally {
			await handle.close();
		}
	} catch (error) {
		if (errorCode(error) === "EEXIST") throw new HarnessError("knowledge.exists", `拒绝覆盖已有文件 ${filePath}`);
		throw error;
	}
}

async function readJson<T>(filePath: string): Promise<T> {
	try {
		return JSON.parse(await readFile(filePath, "utf8")) as T;
	} catch (error) {
		if (error instanceof SyntaxError) throw new HarnessError("knowledge.corrupt", `JSON 文件无法解析：${filePath}`);
		throw error;
	}
}

function jsonLine(key: string, value: unknown): string {
	return `${key}: ${JSON.stringify(value ?? null)}`;
}

function serialiseRecord(record: KnowledgeRecord): string {
	return [
		"---",
		jsonLine("id", record.id),
		jsonLine("type", record.type),
		jsonLine("version", record.version),
		jsonLine("title", record.title),
		jsonLine("createdAt", record.createdAt),
		jsonLine("source", record.source),
		jsonLine("evidenceStatus", record.evidenceStatus),
		jsonLine("usageDecision", record.usageDecision),
		jsonLine("scope", record.scope),
		jsonLine("supersedes", record.supersedes),
		jsonLine("reason", record.reason),
		jsonLine("qStatus", record.qStatus),
		jsonLine("fields", record.fields),
		jsonLine("refs", record.refs),
		"---",
		record.body,
	].join("\n");
}

function parseRecord(text: string, filePath: string): KnowledgeRecord {
	const lines = text.split(/\r?\n/);
	if (lines[0] !== "---") throw new HarnessError("knowledge.corrupt", `记录缺少前置信息：${filePath}`);
	const end = lines.indexOf("---", 1);
	if (end < 0) throw new HarnessError("knowledge.corrupt", `记录前置信息未闭合：${filePath}`);
	const metadata: Record<string, unknown> = {};
	for (const line of lines.slice(1, end)) {
		const separator = line.indexOf(":");
		if (separator < 1) throw new HarnessError("knowledge.corrupt", `记录前置信息格式错误：${filePath}`);
		const key = line.slice(0, separator);
		try {
			metadata[key] = JSON.parse(line.slice(separator + 1).trim()) as unknown;
		} catch {
			throw new HarnessError("knowledge.corrupt", `记录字段 ${key} 无法解析：${filePath}`);
		}
	}
	if (!isNonEmptyString(metadata.id) || !RECORD_TYPES.includes(metadata.type as RecordType) || typeof metadata.version !== "number" || !isNonEmptyString(metadata.title)) {
		throw new HarnessError("knowledge.corrupt", `记录身份字段无效：${filePath}`);
	}
	return {
		id: metadata.id,
		type: metadata.type as RecordType,
		version: metadata.version,
		title: metadata.title,
		body: lines.slice(end + 1).join("\n"),
		fields: isObject(metadata.fields) ? metadata.fields : {},
		refs: Array.isArray(metadata.refs) ? (metadata.refs as Ref[]) : [],
		evidenceStatus: typeof metadata.evidenceStatus === "string" ? metadata.evidenceStatus : undefined,
		usageDecision: USAGE_DECISIONS.includes(metadata.usageDecision as UsageDecision) ? (metadata.usageDecision as UsageDecision) : undefined,
		scope: Array.isArray(metadata.scope) ? metadata.scope.filter((item): item is string => typeof item === "string") : [],
		qStatus: isObject(metadata.qStatus) && typeof metadata.qStatus.open === "boolean" ? (metadata.qStatus as KnowledgeRecord["qStatus"]) : undefined,
		createdAt: typeof metadata.createdAt === "string" ? metadata.createdAt : "",
		source: isObject(metadata.source) ? (metadata.source as KnowledgeRecord["source"]) : { stage: "unknown", runId: "unknown" },
		supersedes: typeof metadata.supersedes === "string" ? metadata.supersedes : undefined,
		reason: typeof metadata.reason === "string" ? metadata.reason : undefined,
	};
}

function parseRecordTarget(value: string): { id: string; version?: number } | undefined {
	const match = /^([CKEJQDX]\d{3,})(?:@(\d+))?$/.exec(value);
	if (!match) return undefined;
	return { id: match[1], version: match[2] ? Number(match[2]) : undefined };
}

function splitSymbolicTarget(value: string): { key: string; version?: number } | undefined {
	const handle = /^(\$[A-Za-z0-9_-]+)(?:@(\d+))?$/.exec(value);
	if (handle) return { key: handle[1], version: handle[2] ? Number(handle[2]) : undefined };
	const actual = parseRecordTarget(value);
	return actual ? { key: actual.id, version: actual.version } : undefined;
}

function resolveHandle(value: string, handles: Map<string, string>): string {
	const parsed = splitSymbolicTarget(value);
	if (!parsed || !parsed.key.startsWith("$")) return value;
	const id = handles.get(parsed.key);
	if (!id) return value;
	return parsed.version ? `${id}@${parsed.version}` : id;
}

function addReplaceRef(refs: Ref[], target: string): Ref[] {
	return refs.some((ref) => ref.rel === "replaces" && ref.target === target) ? refs : [...refs, { rel: "replaces", target }];
}

function activeLimitLabel(limit: Limit): string {
	return `${limit.target}:${limit.kind}`;
}

function unknownFields(value: Record<string, unknown>, allowed: readonly string[]): string[] {
	const known = new Set(allowed);
	return Object.keys(value).filter((key) => !known.has(key));
}

function issue(issues: ValidationIssue[], message: string, opIndex?: number): void {
	issues.push({ level: "error", message, opIndex });
}

function validateStringArray(value: unknown, label: string, issues: ValidationIssue[], opIndex: number): value is string[] {
	if (value === undefined) return true;
	if (!Array.isArray(value) || value.some((item) => !isNonEmptyString(item))) {
		issue(issues, `${label} 必须是非空字符串数组`, opIndex);
		return false;
	}
	return true;
}

function cloneVirtualEntries(source: Map<string, VirtualEntry>): Map<string, VirtualEntry> {
	return new Map([...source].map(([key, entry]) => [key, { ...entry, versions: new Set(entry.versions) }]));
}

function validateTarget(value: unknown, state: ValidationState, handlesOnlyEarlier: boolean, issues: ValidationIssue[], opIndex: number, label: string): VirtualEntry | undefined {
	if (!isNonEmptyString(value)) {
		issue(issues, `${label} 必须是记录 id 或 id@version`, opIndex);
		return undefined;
	}
	const parsed = splitSymbolicTarget(value);
	if (!parsed) {
		issue(issues, `${label} 格式无效：${value}`, opIndex);
		return undefined;
	}
	const entry = state.entries.get(parsed.key);
	if (!entry || (parsed.key.startsWith("$") && !handlesOnlyEarlier)) {
		issue(issues, `${label} 不存在：${value}`, opIndex);
		return undefined;
	}
	if (parsed.version !== undefined && !entry.versions.has(parsed.version)) {
		issue(issues, `${label} 版本不存在：${value}`, opIndex);
		return undefined;
	}
	return entry;
}

function validateRefs(value: unknown, state: ValidationState, issues: ValidationIssue[], opIndex: number): void {
	if (value === undefined) return;
	if (!Array.isArray(value)) {
		issue(issues, "refs 必须是数组", opIndex);
		return;
	}
	for (const [refIndex, candidate] of value.entries()) {
		if (!isObject(candidate)) {
			issue(issues, `refs[${refIndex}] 必须是对象`, opIndex);
			continue;
		}
		const extras = unknownFields(candidate, ["rel", "target", "inputRole", "note"]);
		if (extras.length) issue(issues, `refs[${refIndex}] 含未知字段：${extras.join(", ")}`, opIndex);
		if (!REL_TYPES.includes(candidate.rel as RelType)) issue(issues, `refs[${refIndex}] 的关系类型无效`, opIndex);
		validateTarget(candidate.target, state, true, issues, opIndex, `refs[${refIndex}].target`);
		if (candidate.inputRole !== undefined && !INPUT_ROLES.includes(candidate.inputRole as (typeof INPUT_ROLES)[number])) issue(issues, `refs[${refIndex}] 的 inputRole 无效`, opIndex);
		if (candidate.note !== undefined && typeof candidate.note !== "string") issue(issues, `refs[${refIndex}] 的 note 必须是字符串`, opIndex);
	}
}

function validateScope(value: unknown, state: ValidationState, issues: ValidationIssue[], opIndex: number): void {
	if (!validateStringArray(value, "scope", issues, opIndex) || value === undefined) return;
	for (const target of value) {
		const entry = validateTarget(target, state, true, issues, opIndex, "scope 情境");
		if (entry && entry.type !== "X") issue(issues, `scope 只能引用 X 记录：${target}`, opIndex);
	}
}

function bumpVirtual(entry: VirtualEntry): void {
	entry.latestVersion += 1;
	entry.versions.add(entry.latestVersion);
}

function validateBatchStructure(batch: ProposalBatch, initial: ValidationState): ValidationIssue[] {
	const issues: ValidationIssue[] = [];
	const rawBatch = batch as unknown;
	if (!isObject(rawBatch)) return [{ level: "error", message: "提案必须是对象" }];
	const batchExtras = unknownFields(rawBatch, ["id", "stage", "runId", "session", "baseSnapshot", "ops", "summary", "createdAt"]);
	if (batchExtras.length) issue(issues, `提案含未知字段：${batchExtras.join(", ")}`);
	if (!isNonEmptyString(rawBatch.stage)) issue(issues, "stage 必须是非空字符串");
	if (!isNonEmptyString(rawBatch.runId)) issue(issues, "runId 必须是非空字符串");
	if (rawBatch.session !== undefined && typeof rawBatch.session !== "string") issue(issues, "session 必须是字符串");
	if (rawBatch.baseSnapshot !== undefined && !/^G\d{3,}$/.test(String(rawBatch.baseSnapshot))) issue(issues, "baseSnapshot 格式无效");
	if (rawBatch.summary !== undefined && typeof rawBatch.summary !== "string") issue(issues, "summary 必须是字符串");
	if (!Array.isArray(rawBatch.ops)) {
		issue(issues, "ops 必须是数组");
		return issues;
	}

	const state: ValidationState = { entries: cloneVirtualEntries(initial.entries), activeLimitTargets: [...initial.activeLimitTargets] };
	for (const [opIndex, rawOp] of rawBatch.ops.entries()) {
		if (!isObject(rawOp) || typeof rawOp.op !== "string") {
			issue(issues, "操作必须是含 op 的对象", opIndex);
			continue;
		}
		if (rawOp.op === "create") {
			const extras = unknownFields(rawOp, ["op", "type", "title", "body", "fields", "refs", "evidenceStatus", "usageDecision", "scope", "reason", "handle"]);
			if (extras.length) issue(issues, `create 含未知字段：${extras.join(", ")}`, opIndex);
			const validType = RECORD_TYPES.includes(rawOp.type as RecordType);
			if (!validType) issue(issues, "create.type 无效", opIndex);
			if (!isNonEmptyString(rawOp.title)) issue(issues, "create.title 必须是非空字符串", opIndex);
			if (typeof rawOp.body !== "string") issue(issues, "create.body 必须是字符串", opIndex);
			if (rawOp.fields !== undefined && !isObject(rawOp.fields)) issue(issues, "create.fields 必须是对象", opIndex);
			if (rawOp.evidenceStatus !== undefined && typeof rawOp.evidenceStatus !== "string") issue(issues, "create.evidenceStatus 必须是字符串", opIndex);
			if (rawOp.usageDecision !== undefined && !USAGE_DECISIONS.includes(rawOp.usageDecision as UsageDecision)) issue(issues, "create.usageDecision 无效", opIndex);
			if (rawOp.reason !== undefined && typeof rawOp.reason !== "string") issue(issues, "create.reason 必须是字符串", opIndex);
			validateRefs(rawOp.refs, state, issues, opIndex);
			validateScope(rawOp.scope, state, issues, opIndex);
			if (rawOp.handle !== undefined) {
				if (!isNonEmptyString(rawOp.handle) || !/^\$[A-Za-z0-9_-]+$/.test(rawOp.handle)) issue(issues, "create.handle 格式无效", opIndex);
				else if (state.entries.has(rawOp.handle)) issue(issues, `create.handle 重复：${rawOp.handle}`, opIndex);
				else if (validType) state.entries.set(rawOp.handle, { type: rawOp.type as RecordType, versions: new Set([1]), latestVersion: 1, qOpen: rawOp.type === "Q" ? true : undefined });
			}
			continue;
		}

		if (rawOp.op === "revise") {
			const extras = unknownFields(rawOp, ["op", "id", "title", "body", "fields", "refs", "evidenceStatus", "scope", "reason"]);
			if (extras.length) issue(issues, `revise 含未知字段：${extras.join(", ")}`, opIndex);
			const target = validateTarget(rawOp.id, state, true, issues, opIndex, "revise.id");
			if (typeof rawOp.id === "string" && rawOp.id.includes("@")) issue(issues, "revise.id 必须是裸 id", opIndex);
			if (!isNonEmptyString(rawOp.reason)) issue(issues, "revise.reason 必须是非空字符串", opIndex);
			if (rawOp.title !== undefined && !isNonEmptyString(rawOp.title)) issue(issues, "revise.title 必须是非空字符串", opIndex);
			if (rawOp.body !== undefined && typeof rawOp.body !== "string") issue(issues, "revise.body 必须是字符串", opIndex);
			if (rawOp.fields !== undefined && !isObject(rawOp.fields)) issue(issues, "revise.fields 必须是对象", opIndex);
			if (rawOp.evidenceStatus !== undefined && typeof rawOp.evidenceStatus !== "string") issue(issues, "revise.evidenceStatus 必须是字符串", opIndex);
			validateRefs(rawOp.refs, state, issues, opIndex);
			validateScope(rawOp.scope, state, issues, opIndex);
			if (target) bumpVirtual(target);
			continue;
		}

		if (rawOp.op === "decide") {
			const extras = unknownFields(rawOp, ["op", "id", "usageDecision", "reason", "context"]);
			if (extras.length) issue(issues, `decide 含未知字段：${extras.join(", ")}`, opIndex);
			const target = validateTarget(rawOp.id, state, true, issues, opIndex, "decide.id");
			if (typeof rawOp.id === "string" && rawOp.id.includes("@")) issue(issues, "decide.id 必须是裸 id", opIndex);
			if (!USAGE_DECISIONS.includes(rawOp.usageDecision as UsageDecision)) issue(issues, "decide.usageDecision 无效", opIndex);
			if (!isNonEmptyString(rawOp.reason)) issue(issues, "decide.reason 必须是非空字符串", opIndex);
			if (rawOp.context !== undefined && typeof rawOp.context !== "string") issue(issues, "decide.context 必须是字符串", opIndex);
			if (target) bumpVirtual(target);
			continue;
		}

		if (rawOp.op === "close_q") {
			const extras = unknownFields(rawOp, ["op", "id", "closeReason", "reason"]);
			if (extras.length) issue(issues, `close_q 含未知字段：${extras.join(", ")}`, opIndex);
			const target = validateTarget(rawOp.id, state, true, issues, opIndex, "close_q.id");
			if (typeof rawOp.id === "string" && rawOp.id.includes("@")) issue(issues, "close_q.id 必须是裸 id", opIndex);
			if (target?.type !== "Q") issue(issues, "close_q 目标必须是 Q", opIndex);
			if (target?.qOpen === false) issue(issues, "close_q 目标已经关闭", opIndex);
			if (!CLOSE_REASONS.includes(rawOp.closeReason as QCloseReason)) issue(issues, "close_q.closeReason 无效", opIndex);
			if (!isNonEmptyString(rawOp.reason)) issue(issues, "close_q.reason 必须是非空字符串", opIndex);
			if (target) {
				bumpVirtual(target);
				target.qOpen = false;
			}
			continue;
		}

		if (rawOp.op === "limit") {
			const extras = unknownFields(rawOp, ["op", "target", "kind", "reason", "authority"]);
			if (extras.length) issue(issues, `limit 含未知字段：${extras.join(", ")}`, opIndex);
			validateTarget(rawOp.target, state, true, issues, opIndex, "limit.target");
			if (!LIMIT_KINDS.includes(rawOp.kind as Limit["kind"])) issue(issues, "limit.kind 无效", opIndex);
			if (!isNonEmptyString(rawOp.reason)) issue(issues, "limit.reason 必须是非空字符串", opIndex);
			if (!isNonEmptyString(rawOp.authority)) issue(issues, "limit.authority 必须是非空字符串", opIndex);
			if (isNonEmptyString(rawOp.target)) state.activeLimitTargets.push(rawOp.target);
			continue;
		}

		if (rawOp.op === "lift_limit") {
			const extras = unknownFields(rawOp, ["op", "target", "reason", "authority"]);
			if (extras.length) issue(issues, `lift_limit 含未知字段：${extras.join(", ")}`, opIndex);
			validateTarget(rawOp.target, state, true, issues, opIndex, "lift_limit.target");
			if (!isNonEmptyString(rawOp.reason)) issue(issues, "lift_limit.reason 必须是非空字符串", opIndex);
			if (!isNonEmptyString(rawOp.authority)) issue(issues, "lift_limit.authority 必须是非空字符串", opIndex);
			if (isNonEmptyString(rawOp.target)) {
				const found = state.activeLimitTargets.some((target) => target === rawOp.target);
				if (!found) issue(issues, `lift_limit 没有匹配的生效限制：${rawOp.target}`, opIndex);
				state.activeLimitTargets = state.activeLimitTargets.filter((target) => target !== rawOp.target);
			}
			continue;
		}

		issue(issues, `未知操作：${rawOp.op}`, opIndex);
	}
	return issues;
}

export class FileKnowledgeStore implements KnowledgeStore {
	readonly dir: string;
	private mergeTail: Promise<void> = Promise.resolve();
	private submitTail: Promise<void> = Promise.resolve();

	constructor(dir: string) {
		this.dir = path.resolve(dir);
	}

	async init(): Promise<void> {
		for (const child of ["records", "proposals", "snapshots", "views", "_index"]) await mkdir(path.join(this.dir, child), { recursive: true });
		await writeIfMissing(path.join(this.dir, "RULES.md"), RULES_TEXT);
		await writeIfMissing(path.join(this.dir, "CURRENT"), "");
		await writeIfMissing(path.join(this.dir, "limits.json"), "[]\n");
		for (const [name, content] of Object.entries(EMPTY_VIEW_FILES)) await writeIfMissing(path.join(this.dir, "views", name), content);
		await writeIfMissing(path.join(this.dir, "_index", "records.json"), "[]\n");
	}

	async current(): Promise<Snapshot | undefined> {
		const id = (await readTextIfExists(path.join(this.dir, "CURRENT")))?.trim();
		if (!id) return undefined;
		const filePath = path.join(this.dir, "snapshots", `${id}.json`);
		if (!(await exists(filePath))) throw new HarnessError("knowledge.current", `CURRENT 指向不存在的快照 ${id}`);
		return readJson<Snapshot>(filePath);
	}

	/** Readers see only what CURRENT publishes; version files beyond the published state (interrupted merges) are invisible. */
	async get(id: string, version?: number): Promise<KnowledgeRecord | undefined> {
		if (!/^[CKEJQDX]\d{3,}$/.test(id)) return undefined;
		const publishedVersion = (await this.publishedVersions()).get(id);
		if (publishedVersion === undefined) return undefined;
		const selectedVersion = version ?? publishedVersion;
		if (!Number.isInteger(selectedVersion) || selectedVersion < 1 || selectedVersion > publishedVersion) return undefined;
		const filePath = path.join(this.dir, "records", id, `v${selectedVersion}.md`);
		const text = await readTextIfExists(filePath);
		return text === undefined ? undefined : parseRecord(text, filePath);
	}

	async list(filter: ListFilter = {}): Promise<KnowledgeRecord[]> {
		const ids = [...(await this.publishedVersions()).keys()].sort();
		const records: KnowledgeRecord[] = [];
		for (const id of ids) {
			const record = await this.get(id);
			if (!record) continue;
			if (filter.type && record.type !== filter.type) continue;
			if (filter.openOnly && !(record.type === "Q" && record.qStatus?.open !== false)) continue;
			records.push(record);
		}
		return records.sort((left, right) => left.id.localeCompare(right.id));
	}

	async limits(): Promise<Limit[]> {
		const filePath = path.join(this.dir, "limits.json");
		if (!(await exists(filePath))) return [];
		return readJson<Limit[]>(filePath);
	}

	async availability(id: string, version?: number): Promise<AvailabilityReport> {
		const record = await this.get(id, version);
		if (!record) return { id, version: version ?? 0, availability: "unrecorded", reasons: [`未记录 ${version ? `${id}@${version}` : id}`] };
		const active = (await this.limits()).filter((limit) => !limit.liftedAt && this.limitApplies(limit, record));
		const blocking = active.filter((limit) => limit.kind === "suspended" || limit.kind === "withdrawn");
		const decisionBlocked = record.usageDecision === "suspended" || record.usageDecision === "withdrawn" || record.usageDecision === "replaced";
		if (blocking.length || decisionBlocked) {
			const reasons = blocking.map((limit) => `生效限制 ${limit.kind}:${limit.target}：${limit.reason}`);
			if (decisionBlocked) reasons.push(`历史使用决定为 ${record.usageDecision}`);
			return { id, version: record.version, availability: "not_allowed", reasons };
		}
		const rechecks = active.filter((limit) => limit.kind === "needs_recheck");
		if (rechecks.length) return { id, version: record.version, availability: "needs_recheck", reasons: rechecks.map((limit) => `生效限制 needs_recheck:${limit.target}：${limit.reason}`) };
		if (record.usageDecision === "adopted") return { id, version: record.version, availability: "usable_conditionally", reasons: ["使用决定为 adopted，且没有生效限制"] };
		return { id, version: record.version, availability: "exploratory_only", reasons: [`使用决定为 ${record.usageDecision ?? "未记录"}`] };
	}

	async submitProposal(batch: ProposalBatch): Promise<ProposalReceipt> {
		let release!: () => void;
		const previous = this.submitTail;
		this.submitTail = new Promise<void>((resolve) => {
			release = resolve;
		});
		await previous;
		try {
			await this.init();
			const proposalId = await this.nextSequence("proposals", /^P(\d{4,})\.json$/, "P", 4);
			const persisted: ProposalBatch = { ...batch, id: proposalId, createdAt: nowIso() };
			const state = await this.validationState();
			const issues = validateBatchStructure(persisted, state);
			await this.validateBaseSnapshot(persisted, issues, false);
			const file = path.join(this.dir, "proposals", `${proposalId}.json`);
			await writeExclusive(file, `${JSON.stringify(persisted, null, 2)}\n`);
			return { proposalId, file, issues, structurallyValid: !issues.some((item) => item.level === "error") };
		} finally {
			release();
		}
	}

	async merge(proposalId: string): Promise<MergeResult> {
		const run = this.mergeTail.then(
			() => this.mergeOnce(proposalId),
			() => this.mergeOnce(proposalId),
		);
		this.mergeTail = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	async buildPack(query: PackQuery): Promise<KnowledgePack> {
		const latest = await this.list();
		return buildKnowledgePack(query, {
			snapshot: await this.current(),
			latest,
			resolve: (id, version) => this.get(id, version),
			availability: (id, version) => this.availability(id, version),
			limits: await this.limits(),
		});
	}

	async regenerateViews(): Promise<void> {
		await this.init();
		await regenerateKnowledgeViews({
			dir: this.dir,
			records: await this.list(),
			history: await this.allRecordVersions(),
			limits: await this.limits(),
			availability: (id, version) => this.availability(id, version),
		});
	}

	private async mergeOnce(proposalId: string): Promise<MergeResult> {
		await this.init();
		if (!/^P\d{4,}$/.test(proposalId)) throw new HarnessError("merge.proposal", `提案 id 无效：${proposalId}`);
		const proposalFile = path.join(this.dir, "proposals", `${proposalId}.json`);
		if (!(await exists(proposalFile))) throw new HarnessError("merge.proposal", `找不到提案 ${proposalId}`);
		const lockWarnings: string[] = [];
		await this.acquireLock(lockWarnings);
		try {
			const resultFile = path.join(this.dir, "proposals", `${proposalId}.result.json`);
			if (await exists(resultFile)) {
				const prior = await readJson<MergeResult | { rejected?: boolean }>(resultFile);
				if ("snapshot" in prior) return prior;
				throw new HarnessError("merge.invalid", `提案 ${proposalId} 已被拒绝`);
			}
			const proposal = await readJson<ProposalBatch>(proposalFile);
			const state = await this.validationState();
			const issues = validateBatchStructure(proposal, state);
			await this.validateBaseSnapshot(proposal, issues, true);
			const errors = issues.filter((item) => item.level === "error");
			if (errors.length) {
				await writeFileAtomic(resultFile, `${JSON.stringify({ proposalId, rejected: true, rejectedAt: nowIso(), issues }, null, 2)}\n`);
				throw new HarnessError("merge.invalid", `提案 ${proposalId} 在当前状态校验失败：${errors.map((item) => item.message).join("；")}`);
			}

			const warnings = [...lockWarnings, ...issues.filter((item) => item.level === "warning").map((item) => item.message)];
			const plannedIds = await this.planIds(proposal.ops);
			const mergeTime = nowIso();
			const originalLimits = await this.limits();
			const nextLimits = originalLimits.map((limit) => ({ ...limit }));
			const limitsWrittenFirst: string[] = [];
			const applied: Array<{ opIndex: number; result: string }> = [];
			const changedTargets: ChangedTarget[] = [];

			for (const [opIndex, op] of proposal.ops.entries()) {
				if (op.op === "limit") {
					const target = resolveHandle(op.target, plannedIds.handles);
					const limit: Limit = { target, kind: op.kind, reason: op.reason, authority: op.authority, since: mergeTime };
					nextLimits.push(limit);
					limitsWrittenFirst.push(activeLimitLabel(limit));
					const parsed = parseRecordTarget(target);
					if (parsed) changedTargets.push({ id: parsed.id, version: parsed.version, allVersions: parsed.version === undefined });
					applied.push({ opIndex, result: `限制已登记 ${activeLimitLabel(limit)}` });
				} else if (op.op === "lift_limit") {
					const target = resolveHandle(op.target, plannedIds.handles);
					let lifted = 0;
					for (const limit of nextLimits) {
						if (!limit.liftedAt && limit.target === target) {
							limit.liftedAt = mergeTime;
							limit.liftReason = op.reason;
							lifted += 1;
						}
					}
					applied.push({ opIndex, result: `已解除 ${target} 的 ${lifted} 条限制（授权 ${op.authority}）` });
				}
			}
			if (proposal.ops.some((op) => op.op === "limit" || op.op === "lift_limit")) {
				await writeFileAtomic(path.join(this.dir, "limits.json"), `${JSON.stringify(nextLimits, null, 2)}\n`);
			}

			const latest = new Map((await this.list()).map((record) => [record.id, record]));
			const recordsToWrite: Array<{ opIndex: number; record: KnowledgeRecord }> = [];
			for (const [opIndex, op] of proposal.ops.entries()) {
				if (op.op === "limit" || op.op === "lift_limit") continue;
				if (op.op === "create") {
					const id = op.handle ? plannedIds.handles.get(op.handle) : this.unhandledCreateId(plannedIds, opIndex);
					if (!id) throw new HarnessError("merge.internal", `没有为 create 操作 ${opIndex} 分配 id`);
					const record: KnowledgeRecord = {
						id,
						type: op.type,
						version: 1,
						title: op.title,
						body: op.body,
						fields: op.fields ?? {},
						refs: this.resolveRefs(op.refs ?? [], plannedIds.handles),
						evidenceStatus: op.evidenceStatus,
						usageDecision: op.usageDecision,
						scope: (op.scope ?? []).map((target) => resolveHandle(target, plannedIds.handles)),
						qStatus: op.type === "Q" ? { open: true } : undefined,
						createdAt: mergeTime,
						source: { stage: proposal.stage, runId: proposal.runId, session: proposal.session },
						reason: op.reason,
					};
					latest.set(id, record);
					recordsToWrite.push({ opIndex, record });
					applied.push({ opIndex, result: `已创建 ${id}@1` });
					continue;
				}

				const resolvedId = resolveHandle(op.id, plannedIds.handles);
				const previous = latest.get(resolvedId);
				if (!previous) throw new HarnessError("merge.internal", `当前状态缺少已校验目标 ${resolvedId}`);
				const oldTarget = `${previous.id}@${previous.version}`;
				if (op.op === "revise") {
					const record: KnowledgeRecord = {
						...previous,
						version: previous.version + 1,
						title: op.title ?? previous.title,
						body: op.body ?? previous.body,
						fields: op.fields ?? previous.fields,
						refs: addReplaceRef(this.resolveRefs(op.refs ?? previous.refs, plannedIds.handles), oldTarget),
						evidenceStatus: op.evidenceStatus ?? previous.evidenceStatus,
						scope: (op.scope ?? previous.scope).map((target) => resolveHandle(target, plannedIds.handles)),
						createdAt: mergeTime,
						source: { stage: proposal.stage, runId: proposal.runId, session: proposal.session },
						supersedes: oldTarget,
						reason: op.reason,
					};
					latest.set(record.id, record);
					recordsToWrite.push({ opIndex, record });
					changedTargets.push({ id: previous.id, version: previous.version, allVersions: false });
					applied.push({ opIndex, result: `已修订 ${record.id}@${record.version}` });
					continue;
				}

				if (op.op === "decide") {
					const record: KnowledgeRecord = {
						...previous,
						version: previous.version + 1,
						refs: addReplaceRef([...previous.refs], oldTarget),
						usageDecision: op.usageDecision,
						createdAt: mergeTime,
						source: { stage: proposal.stage, runId: proposal.runId, session: proposal.session },
						supersedes: oldTarget,
						reason: op.reason,
					};
					latest.set(record.id, record);
					recordsToWrite.push({ opIndex, record });
					changedTargets.push({ id: previous.id, version: previous.version, allVersions: false });
					const decisionId = plannedIds.decisionIds.get(opIndex);
					if (!decisionId) throw new HarnessError("merge.internal", `没有为 decide 操作 ${opIndex} 分配 D id`);
					const decision: KnowledgeRecord = {
						id: decisionId,
						type: "D",
						version: 1,
						title: `使用决定：${record.id} → ${op.usageDecision}`,
						body: [`对象：${oldTarget}`, `决定：${op.usageDecision}`, `理由：${op.reason}`, `情境：${op.context ?? "项目默认情境"}`].join("\n\n"),
						fields: { target: oldTarget, decision: op.usageDecision, context: op.context ?? "项目默认情境" },
						refs: [{ rel: previous.type === "Q" ? "handles" : "replaces", target: oldTarget }],
						usageDecision: "adopted",
						scope: [],
						createdAt: mergeTime,
						source: { stage: proposal.stage, runId: proposal.runId, session: proposal.session },
						reason: op.reason,
					};
					latest.set(decision.id, decision);
					recordsToWrite.push({ opIndex, record: decision });
					applied.push({ opIndex, result: `已决定 ${record.id}@${record.version}，决定记录 ${decision.id}@1` });
					continue;
				}

				const record: KnowledgeRecord = {
					...previous,
					version: previous.version + 1,
					refs: addReplaceRef([...previous.refs], oldTarget),
					qStatus: { open: false, closeReason: op.closeReason },
					createdAt: mergeTime,
					source: { stage: proposal.stage, runId: proposal.runId, session: proposal.session },
					supersedes: oldTarget,
					reason: op.reason,
				};
				latest.set(record.id, record);
				recordsToWrite.push({ opIndex, record });
				changedTargets.push({ id: previous.id, version: previous.version, allVersions: false });
				applied.push({ opIndex, result: `已关闭 ${record.id}@${record.version}（${op.closeReason}）` });
			}

			for (const item of recordsToWrite) await this.writeRecord(item.record, warnings);

			const impacts = this.findImpacts([...latest.values()], changedTargets);
			for (const impact of impacts) {
				const target = `${impact.id}@${impact.version}`;
				if (nextLimits.some((limit) => !limit.liftedAt && limit.kind === "needs_recheck" && limit.target === target)) continue;
				nextLimits.push({ target, kind: "needs_recheck", reason: `依赖项在 ${proposalId} 中变更或受限：${impact.via}`, authority: `impact:${proposalId}`, since: mergeTime });
			}
			if (nextLimits.length !== originalLimits.length || proposal.ops.some((op) => op.op === "lift_limit")) {
				await writeFileAtomic(path.join(this.dir, "limits.json"), `${JSON.stringify(nextLimits, null, 2)}\n`);
			}

			const snapshotId = await this.nextSequence("snapshots", /^G(\d{3,})\.json$/, "G", 3);
			const snapshot: Snapshot = {
				id: snapshotId,
				createdAt: mergeTime,
				records: [...latest.values()].sort((left, right) => left.id.localeCompare(right.id)).map((record) => ({ id: record.id, version: record.version })),
				activeLimits: nextLimits.filter((limit) => !limit.liftedAt).map(activeLimitLabel).sort(),
				proposals: [proposalId],
				note: proposal.summary,
			};
			await writeExclusive(path.join(this.dir, "snapshots", `${snapshotId}.json`), `${JSON.stringify(snapshot, null, 2)}\n`);
			await writeFileAtomic(path.join(this.dir, "CURRENT"), `${snapshotId}\n`);
			const result: MergeResult = { proposalId, snapshot, applied: applied.sort((left, right) => left.opIndex - right.opIndex), impacts, limitsWrittenFirst, warnings };
			await writeFileAtomic(resultFile, `${JSON.stringify(result, null, 2)}\n`);
			return result;
		} finally {
			await this.releaseLock();
		}
	}

	private async recordIds(): Promise<string[]> {
		const recordsDir = path.join(this.dir, "records");
		if (!(await exists(recordsDir))) return [];
		return (await readdir(recordsDir, { withFileTypes: true }))
			.filter((entry) => entry.isDirectory() && /^[CKEJQDX]\d{3,}$/.test(entry.name))
			.map((entry) => entry.name)
			.sort();
	}

	private async readRecordIndex(id: string): Promise<RecordIndex | undefined> {
		const filePath = path.join(this.dir, "records", id, "index.json");
		if (await exists(filePath)) return readJson<RecordIndex>(filePath);
		const recordDir = path.join(this.dir, "records", id);
		if (!(await exists(recordDir))) return undefined;
		const versions = (await readdir(recordDir))
			.map((name) => /^v(\d+)\.md$/.exec(name))
			.filter((match): match is RegExpExecArray => match !== null)
			.map((match) => Number(match[1]))
			.sort((left, right) => left - right);
		if (!versions.length) return undefined;
		const firstText = await readFile(path.join(recordDir, `v${versions[0]}.md`), "utf8");
		const first = parseRecord(firstText, path.join(recordDir, `v${versions[0]}.md`));
		return { id, type: first.type, versions, latestVersion: versions[versions.length - 1] };
	}

	private async writeRecord(record: KnowledgeRecord, warnings: string[]): Promise<void> {
		const recordDir = path.join(this.dir, "records", record.id);
		await mkdir(recordDir, { recursive: true });
		const filePath = path.join(recordDir, `v${record.version}.md`);
		if (await exists(filePath)) {
			const publishedVersion = (await this.publishedVersions()).get(record.id);
			if (publishedVersion !== undefined && record.version <= publishedVersion) {
				throw new HarnessError("knowledge.exists", `拒绝覆盖已发布的记录版本 ${record.id}@${record.version}`);
			}
			// A leftover from an interrupted merge: never published, so it may be replaced. Recorded, not hidden.
			warnings.push(`覆盖了未发布的残留版本文件 ${record.id}@${record.version}`);
			await writeFileAtomic(filePath, serialiseRecord(record));
		} else {
			await writeExclusive(filePath, serialiseRecord(record));
		}
		const existing = await this.readRecordIndex(record.id);
		const versions = [...new Set([...(existing?.versions ?? []), record.version])].sort((left, right) => left - right);
		const index: RecordIndex = { id: record.id, type: record.type, versions, latestVersion: versions[versions.length - 1] };
		await writeFileAtomic(path.join(recordDir, "index.json"), `${JSON.stringify(index, null, 2)}\n`);
	}

	private async validationState(): Promise<ValidationState> {
		const entries = new Map<string, VirtualEntry>();
		for (const [id, publishedVersion] of await this.publishedVersions()) {
			const latest = await this.get(id);
			if (!latest) continue;
			const versions = new Set(Array.from({ length: publishedVersion }, (_, index) => index + 1));
			entries.set(id, { type: latest.type, versions, latestVersion: publishedVersion, qOpen: latest.type === "Q" ? latest.qStatus?.open !== false : undefined });
		}
		return { entries, activeLimitTargets: (await this.limits()).filter((limit) => !limit.liftedAt).map((limit) => limit.target) };
	}

	/** Every published version (1..published) of every published record. */
	private async allRecordVersions(): Promise<KnowledgeRecord[]> {
		const records: KnowledgeRecord[] = [];
		for (const [id, publishedVersion] of [...(await this.publishedVersions())].sort(([a], [b]) => a.localeCompare(b))) {
			for (let version = 1; version <= publishedVersion; version += 1) {
				const record = await this.get(id, version);
				if (record) records.push(record);
			}
		}
		return records;
	}

	/** id → latest version listed by the CURRENT snapshot. Empty when nothing is published. */
	private async publishedVersions(): Promise<Map<string, number>> {
		const current = await this.current();
		return new Map((current?.records ?? []).map((item) => [item.id, item.version]));
	}

	private async validateBaseSnapshot(batch: ProposalBatch, issues: ValidationIssue[], duringMerge: boolean): Promise<void> {
		if (!batch.baseSnapshot) return;
		const baseFile = path.join(this.dir, "snapshots", `${batch.baseSnapshot}.json`);
		if (!(await exists(baseFile))) {
			issue(issues, `基线快照不存在：${batch.baseSnapshot}`);
			return;
		}
		const current = await this.current();
		if (!current) {
			issue(issues, `当前没有已发布快照，不能使用基线 ${batch.baseSnapshot}`);
			return;
		}
		if (duringMerge && current.id !== batch.baseSnapshot) {
			const baseNumber = Number(batch.baseSnapshot.slice(1));
			const currentNumber = Number(current.id.slice(1));
			if (baseNumber < currentNumber) issues.push({ level: "warning", message: "基线快照已过时，已在当前状态重查" });
			else issue(issues, `基线快照 ${batch.baseSnapshot} 晚于当前快照 ${current.id}`);
		}
	}

	private async nextSequence(subdir: string, pattern: RegExp, prefix: string, width: number): Promise<string> {
		const dir = path.join(this.dir, subdir);
		await mkdir(dir, { recursive: true });
		let maximum = 0;
		for (const name of await readdir(dir)) {
			const match = pattern.exec(name);
			if (match) maximum = Math.max(maximum, Number(match[1]));
		}
		return `${prefix}${String(maximum + 1).padStart(width, "0")}`;
	}

	private async planIds(ops: ProposalOp[]): Promise<PlannedIds> {
		const maxima = new Map<RecordType, number>(RECORD_TYPES.map((type) => [type, 0]));
		for (const id of await this.recordIds()) {
			const type = id[0] as RecordType;
			maxima.set(type, Math.max(maxima.get(type) ?? 0, Number(id.slice(1))));
		}
		const handles = new Map<string, string>();
		const decisionIds = new Map<number, string>();
		for (const [opIndex, op] of ops.entries()) {
			if (op.op === "create") {
				const next = (maxima.get(op.type) ?? 0) + 1;
				maxima.set(op.type, next);
				const id = `${op.type}${String(next).padStart(3, "0")}`;
				if (op.handle) handles.set(op.handle, id);
				handles.set(`__op_${opIndex}`, id);
			} else if (op.op === "decide") {
				const next = (maxima.get("D") ?? 0) + 1;
				maxima.set("D", next);
				decisionIds.set(opIndex, `D${String(next).padStart(3, "0")}`);
			}
		}
		return { handles, decisionIds };
	}

	private unhandledCreateId(planned: PlannedIds, opIndex: number): string | undefined {
		return planned.handles.get(`__op_${opIndex}`);
	}

	private resolveRefs(refs: Ref[], handles: Map<string, string>): Ref[] {
		return refs.map((ref) => ({ ...ref, target: resolveHandle(ref.target, handles) }));
	}

	private limitApplies(limit: Limit, record: KnowledgeRecord): boolean {
		const target = parseRecordTarget(limit.target);
		return Boolean(target && target.id === record.id && (target.version === undefined || target.version === record.version));
	}

	private findImpacts(records: KnowledgeRecord[], changed: ChangedTarget[]): ImpactItem[] {
		const impacts: ImpactItem[] = [];
		const seen = new Set<string>();
		for (const record of records) {
			for (const ref of record.refs) {
				if (!IMPACT_RELATIONS.includes(ref.rel)) continue;
				const target = parseRecordTarget(ref.target);
				if (!target) continue;
				const matches = changed.some((item) => {
					if (item.id !== target.id) return false;
					if (item.allVersions) return true;
					return target.version === undefined || target.version === item.version;
				});
				if (!matches) continue;
				const via = `${ref.rel} ${ref.target}`;
				const key = `${record.id}@${record.version}|${via}`;
				if (seen.has(key)) continue;
				seen.add(key);
				impacts.push({ id: record.id, version: record.version, via, mark: "needs_recheck" });
			}
		}
		return impacts.sort((left, right) => left.id.localeCompare(right.id) || left.via.localeCompare(right.via));
	}

	private async acquireLock(warnings: string[]): Promise<void> {
		const lockFile = path.join(this.dir, ".merge.lock");
		for (let attempt = 0; attempt < 100; attempt += 1) {
			try {
				const handle = await open(lockFile, "wx");
				try {
					await handle.writeFile(`${JSON.stringify({ pid: process.pid, time: nowIso() }, null, 2)}\n`, "utf8");
					await handle.sync();
				} finally {
					await handle.close();
				}
				return;
			} catch (error) {
				if (errorCode(error) !== "EEXIST") throw error;
				try {
					const info = await stat(lockFile);
					if (Date.now() - info.mtimeMs > LOCK_STALE_MS) {
						await unlink(lockFile);
						warnings.push("检测到超过 10 分钟的合入锁，已覆盖");
						continue;
					}
				} catch (statError) {
					if (errorCode(statError) === "ENOENT") continue;
					throw statError;
				}
				await new Promise<void>((resolve) => setTimeout(resolve, 100));
			}
		}
		throw new HarnessError("merge.locked", "知识库合入锁正在使用中");
	}

	private async releaseLock(): Promise<void> {
		try {
			await unlink(path.join(this.dir, ".merge.lock"));
		} catch (error) {
			if (errorCode(error) !== "ENOENT") throw error;
		}
	}
}

export function createFileKnowledgeStore(dir: string): KnowledgeStore {
	return new FileKnowledgeStore(dir);
}
