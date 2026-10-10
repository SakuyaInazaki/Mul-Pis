import { HarnessError } from "../types.ts";

export type DeepSeekRequestViolation =
	"request-shape" | "message-shape" | "tool-call-shape" | "duplicate-tool-call"
	| "orphan-tool-result" | "duplicate-tool-result" | "incomplete-tool-results"
	| "thinking-tool-choice" | "missing-reasoning" | "unsigned-reasoning" | "reasoning-replay-mismatch";

/** Static, host-side diagnostics only. Never retain input objects, tool IDs or text. */
export class DeepSeekRequestContractError extends HarnessError {
	readonly issued = false;
	readonly violation: DeepSeekRequestViolation;
	readonly messageIndex: number | null;
	constructor(violation: DeepSeekRequestViolation, messageIndex: number | null = null) {
		super("runner.deepseek-request-contract", `DeepSeek request not issued: ${violation}. Repair the request history or provider adapter before retrying; do not discard history or fabricate reasoning/tool results.`);
		this.name = "DeepSeekRequestContractError";
		this.violation = violation;
		this.messageIndex = messageIndex;
	}
}

function object(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function reject(violation: DeepSeekRequestViolation, index: number | null = null): never {
	throw new DeepSeekRequestContractError(violation, index);
}

export interface DeepSeekRequestContractOptions {
	/** Original Pi Context.messages, used to catch reasoning lost during conversion.
	 * Omit only when the caller has no source history; wire validation cannot prove provenance. */
	sourceMessages?: readonly unknown[];
}

/** Validate the FINAL serialized Chat Completions payload, before reservation/fetch.
 * Read-only: no empty-reasoning substitution, synthetic results or null normalization.
 * DeepSeek's Chat schema permits assistant content:null; the OMP integration guide
 * recommends non-null content, so null alone is deliberately not an error here.
 * Sources: https://api-docs.deepseek.com/api/create-chat-completion/
 * https://api-docs.deepseek.com/guides/thinking_mode/
 */
export function assertDeepSeekRequestContract(
	serializedPayload: string, options: DeepSeekRequestContractOptions = {},
): void {
	let payload: unknown;
	try { payload = JSON.parse(serializedPayload); } catch { reject("request-shape"); }
	if (!object(payload) || !Array.isArray(payload.messages) || payload.messages.length === 0)
		reject("request-shape");
	const thinking = !object(payload.thinking) || payload.thinking.type !== "disabled";
	if (thinking && payload.tool_choice !== undefined && payload.tool_choice !== null &&
		payload.tool_choice !== "auto" && payload.tool_choice !== "none") reject("thinking-tool-choice");
	const hasTools = Object.hasOwn(payload, "tools");
	if (hasTools && !Array.isArray(payload.tools)) reject("request-shape");
	const needsReasoning = thinking && hasTools;
	const callIds = new Set<string>();
	const completed = new Set<string>();
	const pending = new Set<string>();
	const wireReasoning: string[] = [];
	for (let i = 0; i < payload.messages.length; i++) {
		const message: unknown = payload.messages[i];
		if (!object(message) || !["system", "user", "assistant", "tool"].includes(String(message.role)))
			reject("message-shape", i);
		if (message.role !== "tool" && pending.size > 0) reject("incomplete-tool-results", i);
		if (message.role === "assistant") {
			if (message.content !== null && typeof message.content !== "string") reject("message-shape", i);
			if (needsReasoning && typeof message.reasoning_content !== "string") reject("missing-reasoning", i);
			if (typeof message.reasoning_content === "string") wireReasoning.push(message.reasoning_content);
			if (message.tool_calls !== undefined) {
				if (!Array.isArray(message.tool_calls) || message.tool_calls.length === 0) reject("tool-call-shape", i);
				for (const call of message.tool_calls) {
					if (!object(call) || typeof call.id !== "string" || call.id.length === 0 || call.type !== "function" ||
						!object(call.function) || typeof call.function.name !== "string" || call.function.name.length === 0 ||
						typeof call.function.arguments !== "string") reject("tool-call-shape", i);
					if (callIds.has(call.id)) reject("duplicate-tool-call", i);
					callIds.add(call.id);
					pending.add(call.id);
				}
			}
		} else if (message.role === "tool") {
			if (typeof message.tool_call_id !== "string" || typeof message.content !== "string") reject("message-shape", i);
			if (completed.has(message.tool_call_id)) reject("duplicate-tool-result", i);
			if (!pending.has(message.tool_call_id)) reject("orphan-tool-result", i);
			pending.delete(message.tool_call_id);
			completed.add(message.tool_call_id);
		} else if (message.role === "system") {
			if (typeof message.content !== "string") reject("message-shape", i);
		} else if (typeof message.content !== "string" && !Array.isArray(message.content)) reject("message-shape", i);
	}
	if (pending.size > 0) reject("incomplete-tool-results");
	if (needsReasoning && options.sourceMessages) {
		// Match source reasoning in order, without exposing it in any diagnostic.
		let cursor = 0;
		for (let i = 0; i < options.sourceMessages.length; i++) {
			const source = options.sourceMessages[i];
			if (!object(source) || source.role !== "assistant" || source.stopReason === "error" ||
				source.stopReason === "aborted" || !Array.isArray(source.content)) continue;
			const blocks = source.content.filter((block): block is Record<string, unknown> =>
				object(block) && block.type === "thinking" && typeof block.thinking === "string" && block.thinking.trim().length > 0);
			if (blocks.length === 0) continue;
			if (blocks.some(block => block.thinkingSignature !== "reasoning_content")) reject("unsigned-reasoning", i);
			const expected = blocks.map(block => block.thinking).join("\n");
			while (cursor < wireReasoning.length && wireReasoning[cursor] !== expected) cursor++;
			if (cursor === wireReasoning.length) reject("reasoning-replay-mismatch", i);
			cursor++;
		}
	}
}
