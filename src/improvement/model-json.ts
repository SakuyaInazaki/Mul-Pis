/** Strictly parse one model JSON document, with an optional single complete JSON fence. */
export function parseModelJson(text: string): unknown {
	try { return JSON.parse(text) as unknown; }
	catch { /* A model may put its sole JSON document in a fenced block. */ }
	const lines = text.replace(/\r\n?/gu, "\n").split("\n");
	const jsonBlocks: Array<{ start: number; end: number }> = [];
	const otherCodeLines = new Set<number>();
	let open: { line: number; marker: string; info: string } | undefined;
	for (let line = 0; line < lines.length; line++) {
		const match = /^[ \t]{0,3}(`{3,}|~{3,})([^\n]*)$/u.exec(lines[line]);
		if (!match) continue;
		if (!open) { open = { line, marker: match[1], info: match[2].trim() }; continue; }
		// A shorter fence or one with an info string is content inside the current block.
		if (match[1][0] !== open.marker[0] || match[1].length < open.marker.length || match[2].trim()) continue;
		if (open.marker === "```" && open.info.toLowerCase() === "json") jsonBlocks.push({ start: open.line, end: line });
		else for (let index = open.line; index <= line; index++) otherCodeLines.add(index);
		open = undefined;
	}
	if (open || jsonBlocks.length !== 1 || jsonBlocks[0].end <= jsonBlocks[0].start + 1)
		throw new SyntaxError("expected one complete ```json code fence or one raw JSON document");
	const [{ start, end }] = jsonBlocks;
	const prose = (from: number, to: number) => lines.slice(from, to)
		.map((line, index) => otherCodeLines.has(from + index) ? "" : line).join("\n").trim();
	const outside = [prose(0, start), prose(end + 1, lines.length)];
	for (const part of outside) {
		for (const paragraph of part.split(/\n\s*\n/u).filter(Boolean)) {
			try { JSON.parse(paragraph); }
			catch { continue; }
			throw new SyntaxError("ambiguous second JSON document outside the sole code fence");
		}
	}
	const body = lines.slice(start + 1, end).join("\n").trim();
	try { return JSON.parse(body) as unknown; }
	catch { throw new SyntaxError("JSON code fence does not contain one valid JSON document"); }
}

/** Preserve the source builder's three required hypothesis fields and ignore optional extras. */
export function parseSourceHypothesis(text: string): { claim: string; predictedObservation: string; falsifier: string } {
	const value = parseModelJson(text);
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("hypothesis must be one JSON object");
	const item = value as Record<string, unknown>;
	const field = (name: "claim" | "predictedObservation" | "falsifier"): string => {
		const part = item[name];
		if (typeof part === "string" && part.trim()) return part;
		if (part && typeof part === "object" && !Array.isArray(part) && Object.keys(part).length) {
			return JSON.stringify(part, (_key, nested) => {
				if (typeof nested === "number" && !Number.isFinite(nested)) throw new TypeError(`hypothesis ${name} contains a nonfinite number`);
				return nested;
			});
		}
		throw new TypeError(`hypothesis ${name} is missing or must be a nonempty string or object`);
	};
	return { claim: field("claim"), predictedObservation: field("predictedObservation"), falsifier: field("falsifier") };
}
