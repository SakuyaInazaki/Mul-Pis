import type {
	AvailabilityReport,
	KnowledgePack,
	KnowledgeRecord,
	Limit,
	PackQuery,
	RecordType,
	Snapshot,
} from "./types.ts";
import { RECORD_TYPES } from "./types.ts";
import { HarnessError } from "../types.ts";

export interface PackState {
	storeId: string;
	snapshot?: Snapshot;
	latest: KnowledgeRecord[];
	resolve(id: string, version?: number): Promise<KnowledgeRecord | undefined>;
	availability(id: string, version?: number): Promise<AvailabilityReport>;
	limits: Limit[];
}

function parseRequestedId(value: string): { id: string; version?: number } {
	const match = /^([CKEJQDX]\d{3,})(?:@(\d+))?$/.exec(value);
	if (!match) return { id: value };
	return { id: match[1], version: match[2] ? Number(match[2]) : undefined };
}

function limitApplies(limit: Limit, record: KnowledgeRecord): boolean {
	if (limit.liftedAt) return false;
	const [id, versionText] = limit.target.split("@");
	return id === record.id && (!versionText || Number(versionText) === record.version);
}

function recordKey(record: KnowledgeRecord): string {
	return `${record.id}@${record.version}`;
}

function compareRecords(left: KnowledgeRecord, right: KnowledgeRecord): number {
	const typeOrder = (type: RecordType): number => RECORD_TYPES.indexOf(type);
	return typeOrder(left.type) - typeOrder(right.type) || left.id.localeCompare(right.id) || left.version - right.version;
}

export function renderKnowledgeRecord(record: KnowledgeRecord, availability: AvailabilityReport, limits: Limit[], latestVersion?: number): string {
	const reasons = availability.reasons.length ? availability.reasons.join("；") : "无";
	const activeLimits = limits.filter((limit) => limitApplies(limit, record));
	const refs = record.refs.length ? record.refs.map((ref) => `${ref.rel} → ${ref.target}`).join("；") : "无";
	const scope = record.scope.length ? record.scope.join("、") : "默认情境";
	const limitText = activeLimits.length
		? activeLimits.map((limit) => `${limit.kind}:${limit.target}（${limit.reason}；授权 ${limit.authority}）`).join("；")
		: "无";
	const versionText = latestVersion !== undefined && record.version < latestVersion
		? `- 版本身份：历史版本；当前发布版本 ${record.id}@${latestVersion}。下列状态属于本版本，请查当前版本了解最新状态。`
		: "- 版本身份：当前发布版本";
	const questionText = record.type === "Q"
		? record.qStatus?.open === false
			? `- 本版本问题状态：已关闭（原因：${record.qStatus.closeReason ?? "未记录"}）；下方正文保留历史措辞，关闭不代表命题已证实。`
			: "- 本版本问题状态：开放"
		: undefined;
	return [
		`### ${record.id}@${record.version} ${record.title}`,
		"",
		versionText,
		...(questionText ? [questionText] : []),
		...(record.reason ? [`- 版本原因：${record.reason}`] : []),
		...(record.supersedes ? [`- 替代版本：${record.supersedes}`] : []),
		`- 使用决定：${record.usageDecision ?? "未记录"}`,
		`- 依据状况：${record.evidenceStatus ?? "未记录"}`,
		`- 当前可用性：${availability.availability}（${reasons}）`,
		`- 生效限制：${limitText}`,
		`- 情境：${scope}`,
		`- 原始记录元数据（fields；非采用判断）：${JSON.stringify(record.fields)}`,
		`- 关系：${refs}`,
		"",
		record.body.trim(),
		"",
	].join("\n");
}

/** Render a bounded, self-describing knowledge pack from authoritative records. */
export async function buildKnowledgePack(query: PackQuery, state: PackState): Promise<KnowledgePack> {
	const selected = new Map<string, KnowledgeRecord>();
	const hasExplicitSelection = Boolean(query.ids?.length || query.terms?.length);

	for (const requested of query.ids ?? []) {
		const parsed = parseRequestedId(requested);
		const record = await state.resolve(parsed.id, parsed.version);
		if (record) selected.set(recordKey(record), record);
	}

	const terms = (query.terms ?? []).map((term) => term.toLocaleLowerCase()).filter(Boolean);
	if (terms.length) {
		for (const record of state.latest) {
			const haystack = `${record.title}\n${record.body}`.toLocaleLowerCase();
			if (terms.some((term) => haystack.includes(term))) selected.set(recordKey(record), record);
		}
	}

	if (!hasExplicitSelection) {
		const types = new Set(query.types ?? RECORD_TYPES);
		for (const record of state.latest) {
			if (types.has(record.type)) selected.set(recordKey(record), record);
		}
	}

	if (query.includeOpenQuestions !== false) {
		for (const record of state.latest) {
			if (record.type === "Q" && record.qStatus?.open !== false) selected.set(recordKey(record), record);
		}
	}

	const records = [...selected.values()].sort(compareRecords);
	const latestVersions = new Map(state.latest.map((record) => [record.id, record.version]));
	const rendered: Array<{ record: KnowledgeRecord; availability: AvailabilityReport; block: string }> = [];
	for (const record of records) {
		const availability = await state.availability(record.id, record.version);
		rendered.push({ record, availability, block: renderKnowledgeRecord(record, availability, state.limits, latestVersions.get(record.id)) });
	}

	const header = [
		"# 局部知识包",
		"",
		`- 快照：${state.snapshot?.id ?? "未发布"}`,
		`- 本库 storeId：${state.storeId}`,
		`- 用途：${query.purpose}`,
		"",
		"入库不等于科学认证；当前可用性是派生判断",
		"",
	].join("\n");
	if (query.maxChars !== undefined && header.length > query.maxChars)
		throw new HarnessError("knowledge.pack", "knowledge pack header exceeds character budget");

	const kept = [...rendered];
	const omitted: string[] = [];
	const renderBody = (): string => {
		const groups: string[] = [];
		for (const type of RECORD_TYPES) {
			const blocks = kept.filter((item) => item.record.type === type).map((item) => item.block);
			if (blocks.length) groups.push(`## ${type}\n\n${blocks.join("\n")}`);
		}
		return groups.join("\n");
	};
	const renderMarkdown = (): string => {
		const base = `${header}${renderBody()}`;
		if (!omitted.length) return base;
		const detailed = `\n（已按长度截断，未展开：${omitted.join("、")}）\n`;
		if (query.maxChars === undefined || base.length + detailed.length <= query.maxChars) return base + detailed;
		const compact = `\n（未展开 ${omitted.length} 项）\n`;
		if (base.length + compact.length <= query.maxChars || kept.length) return base + compact;
		return base;
	};
	let markdown = renderMarkdown();
	if (query.maxChars !== undefined) {
		while (kept.length && markdown.length > query.maxChars) {
			const removed = kept.pop();
			if (!removed) break;
			omitted.unshift(removed.record.id);
			markdown = renderMarkdown();
		}
	}

	return {
		snapshot: state.snapshot?.id,
		purpose: query.purpose,
		markdown,
		included: kept.map((item) => ({ id: item.record.id, version: item.record.version, availability: item.availability.availability })),
		omitted,
		truncated: omitted.length > 0,
	};
}
