import { HarnessError } from "../types.ts";
import type { SessionHandle } from "../runner/types.ts";

export class TaskDeadlineError extends Error {
	constructor() { super("M07 task deadline elapsed; active session abort requested, external effects remain unconfirmed"); }
}

/** A wall deadline is shared by builder and fresh reviewers. Abort is requested, not presumed complete. */
export async function promptBeforeDeadline(handle: SessionHandle, message: string, deadlineMs: number): Promise<string> {
	const remaining = deadlineMs - Date.now();
	if (remaining <= 0) throw new TaskDeadlineError();
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		const timeout = new Promise<never>((_resolve, reject) => {
			timer = setTimeout(() => {
			void handle.abort().catch(() => undefined);
			reject(new TaskDeadlineError());
			}, remaining);
		});
		return (await Promise.race([handle.prompt(message), timeout])).text;
	} finally { if (timer) clearTimeout(timer); }
}

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
	if (Buffer.byteLength(text, "utf8") > 512_000) throw new HarnessError("m07.loop-review", "fresh reviewer verdict exceeds the bounded JSON size");
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
		typeof result.feedback !== "string" || !result.feedback.trim() || Buffer.byteLength(result.feedback, "utf8") > 512_000)
		throw new HarnessError("m07.loop-review", "fresh reviewer verdict must include bounded feedback");
	return { verdict: result.verdict as RoundReview["verdict"], feedback: result.feedback.trim() };
}
