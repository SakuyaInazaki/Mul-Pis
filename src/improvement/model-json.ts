/** Strictly parse one model JSON document, with an optional single complete JSON fence. */
export function parseModelJson(text: string): unknown {
	try { return JSON.parse(text) as unknown; }
	catch { /* A model may put its sole JSON document in a fenced block. */ }
	const lines = text.replace(/\r\n?/gu, "\n").split("\n");
	const fences: Array<{ line: number; marker: string; info: string }> = [];
	for (let line = 0; line < lines.length; line++) {
		const match = /^[ \t]{0,3}(`{3,}|~{3,})([^\n]*)$/u.exec(lines[line]);
		if (match) fences.push({ line, marker: match[1], info: match[2].trim() });
	}
	if (fences.length !== 2 || fences[0].marker !== "```" || fences[0].info.toLowerCase() !== "json" ||
		fences[1].marker !== "```" || fences[1].info !== "" || fences[1].line <= fences[0].line + 1)
		throw new SyntaxError("expected one complete ```json code fence or one raw JSON document");
	const outside = [lines.slice(0, fences[0].line).join("\n").trim(), lines.slice(fences[1].line + 1).join("\n").trim()];
	for (const part of outside) {
		if (!part) continue;
		try { JSON.parse(part); }
		catch { continue; }
		throw new SyntaxError("ambiguous second JSON document outside the sole code fence");
	}
	const body = lines.slice(fences[0].line + 1, fences[1].line).join("\n").trim();
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
