/** Deterministic static-to-dynamic layout for an M07 task prompt.
 *
 * A prompt whose stable parts move between rounds pays for the move twice:
 * the provider cannot reuse a cached prefix, and the model sees the same facts
 * in a different place each time. The order here is fixed and the dynamic
 * elements are sorted deterministically, so two rounds that differ only in
 * their feedback share a byte-identical prefix.
 *
 * The receipt is the observable half: how many characters each section cost,
 * how deep the history went and how much of it was left out. Those are the
 * numbers a later history-depth scan needs; this module does not choose a
 * depth, it only applies and records the configured one. */

export type PromptSectionKind = "instruction" | "understanding" | "hardware" | "knowledge" |
	"history" | "dynamic";

/** Fixed order. Static first, dynamic last; never reordered by content. */
export const PROMPT_SECTION_ORDER: readonly PromptSectionKind[] =
	["instruction", "understanding", "hardware", "knowledge", "history", "dynamic"];

export interface PromptSectionV1 {
	key: string;
	kind: PromptSectionKind;
	text: string;
}

export interface PromptLayoutReceiptV1 {
	version: 1;
	kind: "m07-prompt-layout";
	sections: Array<{ key: string; kind: PromptSectionKind; chars: number }>;
	historyDepth: number;
	historyIncluded: number;
	historyOmitted: number;
	totalChars: number;
}

export const DEFAULT_HISTORY_DEPTH = 4;

export function validateHistoryDepth(value: unknown): number {
	if (value === undefined) return DEFAULT_HISTORY_DEPTH;
	if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 100)
		throw new Error("promptLayout.historyDepth must be an integer in 0-100");
	return value;
}

/** Lay out one prompt. History entries past the configured depth are dropped
 * from the newest end backwards, so the most recent rounds survive; the count
 * of dropped entries stays in the receipt rather than disappearing. */
export function layoutPrompt(sections: readonly PromptSectionV1[],
	options: { historyDepth: number }): { text: string; receipt: PromptLayoutReceiptV1 } {
	const history = sections.filter(item => item.kind === "history");
	const keptHistory = options.historyDepth <= 0 ? [] : history.slice(-options.historyDepth);
	const ordered: PromptSectionV1[] = [];
	for (const kind of PROMPT_SECTION_ORDER)
		for (const item of sections) {
			if (item.kind !== kind) continue;
			if (kind === "history" && !keptHistory.includes(item)) continue;
			if (item.text.trim()) ordered.push(item);
		}
	const text = ordered.map(item => item.text).join("\n\n");
	return { text, receipt: { version: 1, kind: "m07-prompt-layout",
		sections: ordered.map(item => ({ key: item.key, kind: item.kind, chars: item.text.length })),
		historyDepth: options.historyDepth, historyIncluded: keptHistory.length,
		historyOmitted: history.length - keptHistory.length, totalChars: text.length } };
}
