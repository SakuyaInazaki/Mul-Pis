/** Byte spans in the rendered UTF-8 projection, with an exclusive end. */
export interface HistoryPartByteSpan {
	startByte: number;
	endByte: number;
}

/** A range within one staged part. Byte offsets are local and the end is exclusive. */
export interface HistoryEntryPartRange {
	partIndex: number;
	startByte: number;
	endByte: number;
	/** One-based, inclusive lines touched by this byte range in the part. */
	startLine: number;
	endLine: number;
}

/** A control locator only: claims still require reading the named evidence bytes. */
export interface HistorySupersededVersionLocator {
	/** Zero-based order in the entry's supersededVersions array. */
	versionOrdinal: number;
	/** Names are discovery aids, not evidence-read credit or adopted artifacts. */
	fileNames: string[];
}

/** A control locator only: claims still require reading the named evidence bytes. */
export interface HistoryEntryLocator {
	entryOrdinal: number;
	goalRunId?: string;
	taskId?: string;
	fileNames?: string[];
	/** Older raw artifacts, in stored order; entry.files remains the current authority. */
	supersededVersions?: HistorySupersededVersionLocator[];
	supersededVersionCount?: number;
	/** Absolute byte offsets in the complete rendered projection; end is exclusive. */
	startByte: number;
	endByte: number;
	parts: HistoryEntryPartRange[];
}

type ScanMode = "ordinary" | "root" | "entries" | "entry" | "files" |
	"supersededVersions" | "supersededVersion" | "supersededFiles";
type EntryDraft = Omit<HistoryEntryLocator, "parts">;

const isWhitespace = (byte: number): boolean => byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d;
const isDigit = (byte: number): boolean => byte >= 0x30 && byte <= 0x39;
const isHex = (byte: number): boolean => isDigit(byte) || (byte >= 0x41 && byte <= 0x46) ||
	(byte >= 0x61 && byte <= 0x66);

/**
 * Locate top-level `entries` by JSON syntax, never by a textual ID or substring.
 * The caller retains the original history separately; this projection is a read aid.
 */
export function locateHistoryEntries(renderedUtf8: Uint8Array,
	partByteSpans: readonly HistoryPartByteSpan[]): HistoryEntryLocator[] {
	const bytes = renderedUtf8;
	if (!bytes.length) throw new Error("rendered research history is empty");
	// A byte-level grammar can identify ASCII JSON delimiters even around multibyte
	// characters, while fatal decoding rejects invalid UTF-8 anywhere in a string.
	new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	let previousEnd = 0;
	for (const part of partByteSpans) {
		if (!Number.isSafeInteger(part.startByte) || !Number.isSafeInteger(part.endByte) ||
			part.startByte !== previousEnd || part.endByte <= part.startByte || part.endByte > bytes.length)
			throw new Error("history part byte spans must be contiguous and in bounds");
		previousEnd = part.endByte;
	}
	if (previousEnd !== bytes.length) throw new Error("history part byte spans do not cover the rendered history");

	let offset = 0;
	let sawEntries = false;
	const drafts: EntryDraft[] = [];
	const skipWhitespace = (): void => { while (offset < bytes.length && isWhitespace(bytes[offset]!)) offset++; };
	const fail = (): never => { throw new Error(`malformed rendered research history JSON at byte ${offset}`); };
	const expect = (byte: number): void => { if (bytes[offset] !== byte) fail(); offset++; };
	const stringToken = (decode: boolean): string | undefined => {
		const start = offset;
		expect(0x22);
		while (offset < bytes.length) {
			const current = bytes[offset++]!;
			if (current === 0x22) {
				return decode ? JSON.parse(Buffer.from(bytes.subarray(start, offset)).toString("utf8")) as string : undefined;
			}
			if (current < 0x20) fail();
			if (current !== 0x5c) continue;
			const escaped = bytes[offset++];
			if (escaped === undefined) fail();
			if (escaped === 0x75) {
				for (let index = 0; index < 4; index++) {
					if (!isHex(bytes[offset++] ?? -1)) fail();
				}
			} else if (![0x22, 0x5c, 0x2f, 0x62, 0x66, 0x6e, 0x72, 0x74].includes(escaped)) fail();
		}
		fail();
	};
	const literal = (word: string): void => {
		for (let index = 0; index < word.length; index++) expect(word.charCodeAt(index));
	};
	const numberToken = (): void => {
		if (bytes[offset] === 0x2d) offset++;
		if (bytes[offset] === 0x30) offset++;
		else {
			if (!isDigit(bytes[offset] ?? -1) || bytes[offset] === 0x30) fail();
			while (isDigit(bytes[offset] ?? -1)) offset++;
		}
		if (bytes[offset] === 0x2e) {
			offset++;
			if (!isDigit(bytes[offset] ?? -1)) fail();
			while (isDigit(bytes[offset] ?? -1)) offset++;
		}
		if (bytes[offset] === 0x65 || bytes[offset] === 0x45) {
			offset++;
			if (bytes[offset] === 0x2b || bytes[offset] === 0x2d) offset++;
			if (!isDigit(bytes[offset] ?? -1)) fail();
			while (isDigit(bytes[offset] ?? -1)) offset++;
		}
	};
	const scanValue = (mode: ScanMode = "ordinary", entry?: EntryDraft,
		version?: HistorySupersededVersionLocator): void => {
		skipWhitespace();
		const current = bytes[offset];
		if (mode === "root" || mode === "entry" || mode === "files" ||
			mode === "supersededVersion" || mode === "supersededFiles") {
			if (current !== 0x7b) fail();
		} else if ((mode === "entries" || mode === "supersededVersions") && current !== 0x5b) fail();
		if (current === 0x7b) {
			offset++;
			skipWhitespace();
			if (bytes[offset] === 0x7d) { offset++; return; }
			const seen = mode === "entry" || mode === "files" || mode === "supersededVersion" ||
				mode === "supersededFiles" ? new Set<string>() : undefined;
			for (;;) {
				const key = stringToken(mode !== "ordinary")!;
				if (seen?.has(key)) throw new Error(`duplicate history ${mode} key`);
				seen?.add(key);
				skipWhitespace();
				expect(0x3a);
				skipWhitespace();
				if (mode === "root" && key === "entries") {
					if (sawEntries) throw new Error("duplicate history entries key");
					sawEntries = true;
					scanValue("entries");
				} else if (mode === "entry" && (key === "goalRunId" || key === "taskId")) {
					if (bytes[offset] === 0x22) {
						const value = stringToken(true)!;
						if (key === "goalRunId" && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) entry!.goalRunId = value;
						if (key === "taskId" && /^T\d{3,}$/.test(value)) entry!.taskId = value;
					} else scanValue();
				} else if (mode === "entry" && key === "files") {
					entry!.fileNames = [];
					scanValue("files", entry);
				} else if (mode === "entry" && key === "supersededVersions") {
					entry!.supersededVersions = [];
					scanValue("supersededVersions", entry);
					entry!.supersededVersionCount = entry!.supersededVersions.length;
				} else if (mode === "supersededVersion" && key === "files") {
					version!.fileNames = [];
					scanValue("supersededFiles", entry, version);
				} else {
					if (mode === "files") entry!.fileNames!.push(key);
					if (mode === "supersededFiles") version!.fileNames.push(key);
					scanValue();
				}
				skipWhitespace();
				if (bytes[offset] === 0x7d) { offset++; return; }
				expect(0x2c);
				skipWhitespace();
			}
		}
		if (current === 0x5b) {
			offset++;
			skipWhitespace();
			if (bytes[offset] === 0x5d) { offset++; return; }
			for (;;) {
				if (mode === "entries") {
					const draft: EntryDraft = { entryOrdinal: drafts.length, startByte: offset, endByte: -1 };
					scanValue("entry", draft);
					draft.endByte = offset;
					drafts.push(draft);
				} else if (mode === "supersededVersions") {
					const oldVersion: HistorySupersededVersionLocator = {
						versionOrdinal: entry!.supersededVersions!.length, fileNames: [] };
					scanValue("supersededVersion", entry, oldVersion);
					oldVersion.fileNames.sort();
					entry!.supersededVersions!.push(oldVersion);
				} else scanValue();
				skipWhitespace();
				if (bytes[offset] === 0x5d) { offset++; return; }
				expect(0x2c);
				skipWhitespace();
			}
		}
		if (current === 0x22) { stringToken(false); return; }
		if (current === 0x74) { literal("true"); return; }
		if (current === 0x66) { literal("false"); return; }
		if (current === 0x6e) { literal("null"); return; }
		if (current === 0x2d || isDigit(current ?? -1)) { numberToken(); return; }
		fail();
	};
	scanValue("root");
	skipWhitespace();
	if (offset !== bytes.length || !sawEntries) fail();

	// Newline positions are relative to each part. Count only bytes strictly before
	// the queried byte, so an entry ending at a newline reports the touched line.
	const newlines = partByteSpans.map(part => {
		const positions: number[] = [];
		for (let at = part.startByte; at < part.endByte; at++) if (bytes[at] === 0x0a) positions.push(at - part.startByte);
		return positions;
	});
	const lineAt = (partIndex: number, byte: number): number => {
		const positions = newlines[partIndex]!;
		let low = 0;
		let high = positions.length;
		while (low < high) {
			const middle = Math.floor((low + high) / 2);
			if (positions[middle]! < byte) low = middle + 1;
			else high = middle;
		}
		return low + 1;
	};
	const firstPartAfter = (byte: number): number => {
		let low = 0;
		let high = partByteSpans.length;
		while (low < high) {
			const middle = Math.floor((low + high) / 2);
			if (partByteSpans[middle]!.endByte <= byte) low = middle + 1;
			else high = middle;
		}
		return low;
	};
	return drafts.map(draft => {
		const parts: HistoryEntryPartRange[] = [];
		for (let partIndex = firstPartAfter(draft.startByte); partIndex < partByteSpans.length; partIndex++) {
			const part = partByteSpans[partIndex]!;
			if (part.endByte <= draft.startByte) continue;
			if (part.startByte >= draft.endByte) break;
			const startByte = Math.max(draft.startByte, part.startByte) - part.startByte;
			const endByte = Math.min(draft.endByte, part.endByte) - part.startByte;
			parts.push({ partIndex, startByte, endByte, startLine: lineAt(partIndex, startByte),
				endLine: lineAt(partIndex, endByte - 1) });
		}
		if (!parts.length) throw new Error("history entry is not covered by part byte spans");
		return { ...draft, parts };
	});
}
