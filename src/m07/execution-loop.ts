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

export function parseRoundReview(raw: string): RoundReview {
	let parsed: unknown;
	try { parsed = JSON.parse(raw.trim().replace(/^```(?:json)?\s*|\s*```$/g, "")); }
	catch { throw new HarnessError("m07.loop-review", "fresh reviewer must return a JSON verdict"); }
	if (!parsed || typeof parsed !== "object") throw new HarnessError("m07.loop-review", "fresh reviewer returned no verdict");
	const result = parsed as Record<string, unknown>;
	if (!["ready", "revise", "replan", "blocked"].includes(String(result.verdict)) || typeof result.feedback !== "string" || !result.feedback.trim() || result.feedback.length > 8_000) throw new HarnessError("m07.loop-review", "fresh reviewer verdict must include bounded feedback");
	return { verdict: result.verdict as RoundReview["verdict"], feedback: result.feedback.trim() };
}
