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

export interface PackState {
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

function renderRecord(record: KnowledgeRecord, availability: AvailabilityReport, limits: Limit[]): string {
	const reasons = availability.reasons.length ? availability.reasons.join("；") : "无";
	const activeLimits = limits.filter((limit) => limitApplies(limit, record));
	const refs = record.refs.length ? record.refs.map((ref) => `${ref.rel} → ${ref.target}`).join("；") : "无";
	const scope = record.scope.length ? record.scope.join("、") : "默认情境";
	const limitText = activeLimits.length
		? activeLimits.map((limit) => `${limit.kind}:${limit.target}（${limit.reason}；授权 ${limit.authority}）`).join("；")
		: "无";
	return [
		`### ${record.id}@${record.version} ${record.title}`,
		"",
		`- 使用决定：${record.usageDecision ?? "未记录"}`,
		`- 依据状况：${record.evidenceStatus ?? "未记录"}`,
		`- 当前可用性：${availability.availability}（${reasons}）`,
		`- 生效限制：${limitText}`,
		`- 情境：${scope}`,
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
	const rendered: Array<{ record: KnowledgeRecord; availability: AvailabilityReport; block: string }> = [];
	for (const record of records) {
		const availability = await state.availability(record.id, record.version);
		rendered.push({ record, availability, block: renderRecord(record, availability, state.limits) });
	}

	const header = [
		"# 局部知识包",
		"",
		`- 快照：${state.snapshot?.id ?? "未发布"}`,
		`- 用途：${query.purpose}`,
		"",
		"入库不等于科学认证；当前可用性是派生判断",
		"",
	].join("\n");

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
	const truncationLine = (): string => (omitted.length ? `\n（已按长度截断，未展开：${omitted.join("、")}）\n` : "");
	let markdown = `${header}${renderBody()}${truncationLine()}`;
	if (query.maxChars !== undefined) {
		while (kept.length && markdown.length > query.maxChars) {
			const removed = kept.pop();
			if (!removed) break;
			omitted.unshift(removed.record.id);
			markdown = `${header}${renderBody()}${truncationLine()}`;
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
