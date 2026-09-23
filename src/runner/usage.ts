import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { UsageEvent, UsageSummary, UsageValues } from "./types.ts";

const FIELDS = ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const;

function finite(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function values(raw: unknown): { usage?: UsageValues; complete: boolean } {
	if (!raw || typeof raw !== "object") return { complete: false };
	const value = raw as Record<string, unknown>;
	const usage: UsageValues = {};
	for (const key of FIELDS) {
		const number = finite(value[key]);
		if (number !== undefined) usage[key] = number;
	}
	const rawCost = value.cost;
	const cost = finite(typeof rawCost === "object" && rawCost !== null ? (rawCost as Record<string, unknown>).total : rawCost);
	if (cost !== undefined) usage.cost = cost;
	return { usage, complete: FIELDS.every((key) => usage[key] !== undefined) && cost !== undefined };
}

/** Convert newly appended entries once; never use the compacted agent-state messages for billing. */
export function usageEventsFromEntries(entries: readonly SessionEntry[], promptIndex: number, priced: boolean): UsageEvent[] {
	const events: UsageEvent[] = [];
	const seen = new Set<string>();
	for (const entry of entries) {
		if (seen.has(entry.id)) continue;
		seen.add(entry.id);
		let kind: UsageEvent["kind"];
		let rawUsage: unknown;
		let provider: string | undefined;
		let model: string | undefined;
		let stopReason: string | undefined;
		if (entry.type === "message" && entry.message.role === "assistant") {
			kind = "assistant";
			rawUsage = entry.message.usage;
			provider = entry.message.provider;
			model = entry.message.model;
			stopReason = entry.message.stopReason;
		} else if (entry.type === "message" && entry.message.role === "toolResult" && entry.message.usage) {
			kind = "tool-result";
			rawUsage = entry.message.usage;
		} else if (entry.type === "compaction" || entry.type === "branch_summary") {
			kind = entry.type === "compaction" ? "compaction" : "branch-summary";
			rawUsage = entry.usage;
		} else continue;
		const reported = values(rawUsage);
		const zeroFailure = kind === "assistant" && (stopReason === "error" || stopReason === "aborted") &&
			FIELDS.every((key) => reported.usage?.[key] === 0) && reported.usage?.cost === 0;
		events.push({
			entryId: entry.id, kind, promptIndex, at: entry.timestamp,
			...(provider ? { provider } : {}), ...(model ? { model } : {}),
			...(stopReason ? { stopReason } : {}),
			...(reported.usage ? { usage: reported.usage } : {}),
			status: reported.complete && !zeroFailure ? "reported" : "unknown",
			costSource: reported.usage?.cost !== undefined ? "sdk-estimate" : "unknown",
			costStatus: reported.usage?.cost === undefined ? "unknown" : kind === "tool-result" ? "unknown" : priced ? "priced" : "unpriced",
		});
	}
	return events;
}

export function summarizeUsage(events: readonly UsageEvent[]): UsageSummary {
	const summary: UsageSummary = {
		input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0,
		reportedEvents: 0, unknownEvents: 0, complete: true, costComplete: true,
	};
	for (const event of events) {
		if (event.status === "reported") summary.reportedEvents++;
		else { summary.unknownEvents++; summary.complete = false; }
		if (event.costStatus !== "priced" || event.status !== "reported") summary.costComplete = false;
		for (const field of [...FIELDS, "cost"] as const) summary[field] += event.usage?.[field] ?? 0;
	}
	return summary;
}
