import { HarnessError } from "../types.ts";

export interface RoundReview {
	verdict: "ready" | "revise" | "replan" | "blocked";
	feedback: string;
}

/** Repair only literal line breaks/tabs inside a quoted JSON string. Never infer a verdict from prose. */
function escapeLiteralStringControls(input: string): string {
	let quoted = false, escaped = false, output = "";
	for (let index = 0; index < input.length; index++) {
		const char = input[index];
		if (!quoted) { if (char === '"') quoted = true; output += char; continue; }
		if (escaped) { output += char; escaped = false; continue; }
		if (char === "\\") { output += char; escaped = true; continue; }
		if (char === '"') { output += char; quoted = false; continue; }
		if (char === "\r") { output += "\\r"; continue; }
		if (char === "\n") { output += "\\n"; continue; }
		if (char === "\t") { output += "\\t"; continue; }
		output += char;
	}
	return output;
}

export function parseRoundReview(raw: string): RoundReview {
	const text = raw.trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
	let parsed: unknown;
	try { parsed = JSON.parse(text); }
	catch {
		const recovered = escapeLiteralStringControls(text);
		if (recovered === text) throw new HarnessError("m07.loop-review", "fresh reviewer must return a JSON verdict");
		try { parsed = JSON.parse(recovered); }
		catch { throw new HarnessError("m07.loop-review", "fresh reviewer must return a JSON verdict"); }
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new HarnessError("m07.loop-review", "fresh reviewer returned no verdict");
	const result = parsed as Record<string, unknown>;
	if (typeof result.verdict !== "string" || !["ready", "revise", "replan", "blocked"].includes(result.verdict) ||
		typeof result.feedback !== "string" || !result.feedback.trim())
		throw new HarnessError("m07.loop-review", "fresh reviewer verdict must include nonempty feedback");
	return { verdict: result.verdict as RoundReview["verdict"], feedback: result.feedback.trim() };
}
