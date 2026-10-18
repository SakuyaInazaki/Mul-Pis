import type { ReadReturnEvent } from "./types.ts";

export interface TextReadCoverage {
	lineCount: number;
	/** One-based inclusive ranges of fully covered lines. */
	coveredRanges: Array<{ start: number; end: number }>;
	missingRanges: Array<{ start: number; end: number }>;
	/** Zero-based half-open UTF-16 file ranges. */
	coveredTextRanges: Array<{ start: number; end: number }>;
	missingTextRanges: Array<{ start: number; end: number }>;
	terminal: boolean;
	complete: boolean;
}

/** Preserve legacy whole-line proof while allowing exact character pages to
 * fill only the part they actually returned. Newline separators belong to
 * their preceding legacy line; a partial long line never covers that line. */
export function textReadCoverage(content: string, relative: string, events: readonly ReadReturnEvent[], toolName: string): TextReadCoverage {
	if (content.length === 0) {
		const complete = events.some(event => event.toolName === toolName && event.path === relative &&
			event.status === "no-content" && event.returned.kind === "text" && event.returned.truncated === false &&
			event.returned.startLine === undefined && event.returned.endLine === undefined &&
			(event.returned.textOffset === undefined && event.returned.textEnd === undefined && event.returned.textTotal === undefined ||
				event.returned.textOffset === 0 && event.returned.textEnd === 0 && event.returned.textTotal === 0));
		return { lineCount: 0, coveredRanges: [], coveredTextRanges: [], missingRanges: [], missingTextRanges: [], terminal: complete, complete };
	}
	const starts = [0];
	for (let index = 0; index < content.length; index++) if (content[index] === "\n") starts.push(index + 1);
	if (!content.endsWith("\n")) starts.push(content.length);
	const lineCount = starts.length - 1;
	const ranges: Array<{ start: number; end: number }> = [];
	let terminal = false;
	for (const event of events) {
		if (event.toolName !== toolName || event.path !== relative ||
			event.status !== "returned" || event.returned.kind !== "text") continue;
		const read = event.returned;
		if (read.textOffset !== undefined || read.textEnd !== undefined || read.textTotal !== undefined) {
			const { textOffset: start, textEnd: end, textTotal: total } = read;
			if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || total !== content.length ||
				start! < 0 || end! <= start! || end! > content.length || read.startLine !== undefined || read.endLine !== undefined) continue;
			ranges.push({ start: start!, end: end! });
			if (end === content.length && read.truncated === false) terminal = true;
		} else {
			const { startLine: start, endLine: end } = read;
			if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start! < 1 || end! < start! || end! > lineCount) continue;
			ranges.push({ start: starts[start! - 1]!, end: starts[end!]! });
			if (end === lineCount && read.truncated === false) terminal = true;
		}
	}
	ranges.sort((a, b) => a.start - b.start || a.end - b.end);
	const coveredTextRanges: Array<{ start: number; end: number }> = [];
	for (const range of ranges) {
		const last = coveredTextRanges.at(-1);
		if (last && range.start <= last.end) last.end = Math.max(last.end, range.end);
		else coveredTextRanges.push({ ...range });
	}
	const missingTextRanges: Array<{ start: number; end: number }> = [];
	let next = 0;
	for (const range of coveredTextRanges) {
		if (range.start > next) missingTextRanges.push({ start: next, end: range.start });
		next = Math.max(next, range.end);
	}
	if (next < content.length) missingTextRanges.push({ start: next, end: content.length });
	const coveredRanges: Array<{ start: number; end: number }> = [], missingRanges: Array<{ start: number; end: number }> = [];
	for (let line = 1; line <= lineCount; line++) {
		const covered = coveredTextRanges.some(range => range.start <= starts[line - 1]! && range.end >= starts[line]!);
		const target = covered ? coveredRanges : missingRanges, last = target.at(-1);
		if (last && last.end === line - 1) last.end = line;
		else target.push({ start: line, end: line });
	}
	return { lineCount, coveredRanges, coveredTextRanges, missingRanges, missingTextRanges, terminal, complete: terminal && missingTextRanges.length === 0 };
}
