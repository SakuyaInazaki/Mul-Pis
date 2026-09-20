import path from "node:path";
import type { AvailabilityReport, KnowledgeRecord, Limit, RecordType } from "./types.ts";
import { RECORD_TYPES } from "./types.ts";
import { writeFileAtomic } from "../workspace.ts";

export interface ViewState {
	dir: string;
	/** Latest version of each record, used by current-state views and the index. */
	records: KnowledgeRecord[];
	/** Every immutable version, used by the historical corrections view. */
	history: KnowledgeRecord[];
	limits: Limit[];
	availability(id: string, version?: number): Promise<AvailabilityReport>;
}

function compareRecords(left: KnowledgeRecord, right: KnowledgeRecord): number {
	const typeOrder = (type: RecordType): number => RECORD_TYPES.indexOf(type);
	return typeOrder(left.type) - typeOrder(right.type) || left.id.localeCompare(right.id) || left.version - right.version;
}

function withFinalNewline(text: string): string {
	return text.endsWith("\n") ? text : `${text}\n`;
}

/** Rebuild every derived view from record files and limits.json. */
export async function regenerateKnowledgeViews(state: ViewState): Promise<void> {
	const records = [...state.records].sort(compareRecords);
	const reports = new Map<string, AvailabilityReport>();
	for (const record of records) reports.set(record.id, await state.availability(record.id, record.version));

	const understanding = records.filter(
		(record) =>
			(record.type === "C" || record.type === "K") &&
			(record.usageDecision === "adopted" || record.usageDecision === "working_assumption" || record.usageDecision === "candidate"),
	);
	const understandingText = [
		"# 当前认识",
		"",
		"本视图由权威记录生成；当前可用性是派生判断。",
		"",
		...(understanding.length
			? understanding.map((record) => {
					const report = reports.get(record.id);
					return `- ${record.id}@${record.version} ${record.title} — ${record.usageDecision} / ${report?.availability ?? "unrecorded"}`;
				})
			: ["- 无"]),
	].join("\n");

	const corrections = [...state.history].filter((record) => record.type === "D" || record.version > 1).sort(compareRecords);
	const correctionsText = [
		"# 处理、纠正与修订",
		"",
		...(corrections.length
			? corrections.map((record) => `- ${record.id}@${record.version} ${record.title} — ${record.reason ?? "未记录原因"}${record.supersedes ? `；替代 ${record.supersedes}` : ""}`)
			: ["- 无"]),
	].join("\n");

	const questions = records.filter((record) => record.type === "Q" && record.qStatus?.open !== false);
	const questionsText = [
		"# 开放质疑与未决问题",
		"",
		...(questions.length ? questions.map((record) => `- ${record.id}@${record.version} ${record.title}\n\n  ${record.body.trim()}`) : ["- 无"]),
	].join("\n");

	const activeLimits = state.limits.filter((limit) => !limit.liftedAt);
	const limitsText = [
		"# 当前限制",
		"",
		...(activeLimits.length
			? activeLimits.map((limit) => `- ${limit.kind} ${limit.target} — ${limit.reason}（授权：${limit.authority}；生效：${limit.since}）`)
			: ["- 无"]),
	].join("\n");

	const index = records.map((record) => ({
		id: record.id,
		type: record.type,
		version: record.version,
		title: record.title,
		usageDecision: record.usageDecision ?? null,
		availability: reports.get(record.id)?.availability ?? "unrecorded",
	}));

	await writeFileAtomic(path.join(state.dir, "views", "current-understanding.md"), withFinalNewline(understandingText));
	await writeFileAtomic(path.join(state.dir, "views", "corrections.md"), withFinalNewline(correctionsText));
	await writeFileAtomic(path.join(state.dir, "views", "open-questions.md"), withFinalNewline(questionsText));
	await writeFileAtomic(path.join(state.dir, "views", "limits.md"), withFinalNewline(limitsText));
	await writeFileAtomic(path.join(state.dir, "_index", "records.json"), `${JSON.stringify(index, null, 2)}\n`);
}
