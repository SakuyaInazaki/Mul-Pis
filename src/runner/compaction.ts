/**
 * Cliff context compaction.
 *
 * Long sessions keep the context untouched until it crosses one threshold, then
 * drop it once, mechanically: nothing is rewritten, nothing is sent to a model,
 * and an already compacted block is never compacted again. Deleting and
 * truncating keeps the surviving bytes identical to what the model already saw,
 * so the provider prefix cache stays valid and no summary can invent facts.
 *
 * Everything the cliff removes from the live context is appended to a digest
 * file first, so a later session can read back what was dropped instead of
 * re-running the tools that produced it.
 */
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { ExtensionFactory, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";

export interface CliffCompactionPolicy {
	/** Context size that triggers the single drop. The one knob meant for A/B scans. */
	thresholdTokens: number;
	/** Budget Pi keeps free below the context window. */
	reserveTokens: number;
	/** Newest tokens kept byte-identical. */
	keepRecentTokens: number;
	/** The opening task statement is kept verbatim up to this length. */
	taskChars: number;
	/** Older assistant thinking is truncated to this many characters. */
	thinkingChars: number;
	/** Older tool calls are reduced to a signature of this length. */
	toolCallChars: number;
	/** Tool results longer than this are dropped whole rather than truncated. */
	toolResultChars: number;
	/** Upper bound on retained failure signatures per compaction. */
	failureSignatures: number;
}

/** Frozen per new session; old sessions without this entry retain Pi defaults. */
export const WORKFLOW_COMPACTION: CliffCompactionPolicy = {
	thresholdTokens: 200_000, reserveTokens: 16_384, keepRecentTokens: 20_000, taskChars: 8_000,
	thinkingChars: 300, toolCallChars: 150, toolResultChars: 500, failureSignatures: 16,
};
const ENTRY = "workflow_compaction";
const MARKER = "<compacted-history>";

/**
 * The threshold is the only value worth scanning per model, so it is the only
 * one an operator can override. The override is host-owned: a model-facing bash
 * child never receives this variable.
 */
export function compactionPolicyFromEnvironment(env: NodeJS.ProcessEnv = process.env): CliffCompactionPolicy {
	const raw = env.PRE_RSI_CONTEXT_THRESHOLD_TOKENS;
	if (raw === undefined) return { ...WORKFLOW_COMPACTION };
	const parsed = Number(raw);
	if (!Number.isSafeInteger(parsed) || parsed < 16_384)
		throw new Error("PRE_RSI_CONTEXT_THRESHOLD_TOKENS must be an integer of at least 16384 tokens");
	return { ...WORKFLOW_COMPACTION, thresholdTokens: parsed };
}

export function sessionCompactionPolicy(manager: Pick<SessionManager, "getSessionId" | "getEntries" | "appendCustomEntry">, fresh: boolean,
	policy: CliffCompactionPolicy = WORKFLOW_COMPACTION): CliffCompactionPolicy | undefined {
	const sessionId = manager.getSessionId();
	for (const entry of manager.getEntries()) {
		if (entry.type !== "custom" || entry.customType !== ENTRY) continue;
		const data = entry.data as { sessionId: string; policy: CliffCompactionPolicy };
		if (data.sessionId === sessionId) return data.policy;
	}
	if (!fresh) return undefined;
	const frozen = { ...policy };
	manager.appendCustomEntry(ENTRY, { sessionId, policy: frozen });
	return frozen;
}

/** Use Pi's native threshold checks, including between tool batches. */
export function workflowCompactionSettings(contextWindow: number, policy: CliffCompactionPolicy = WORKFLOW_COMPACTION): ReturnType<SettingsManager["getCompactionSettings"]> {
	return {
		enabled: true,
		reserveTokens: Math.max(policy.reserveTokens, contextWindow - policy.thresholdTokens),
		keepRecentTokens: policy.keepRecentTokens,
	};
}

/** The fields of Pi's CompactionPreparation this module reads. */
export interface CliffPreparation {
	firstKeptEntryId: string;
	messagesToSummarize: readonly unknown[];
	turnPrefixMessages: readonly unknown[];
	isSplitTurn: boolean;
	tokensBefore: number;
	previousSummary?: string;
	fileOps: { read: ReadonlySet<string>; written: ReadonlySet<string>; edited: ReadonlySet<string> };
}

export interface CliffDigestRecordV1 {
	version: 1;
	at: string;
	sessionId?: string;
	reason: string;
	firstKeptEntryId: string;
	tokensBefore: number;
	droppedMessages: number;
	droppedChars: number;
	/** Exactly the text that replaced the dropped messages in the live context. */
	summary: string;
	readFiles: string[];
	modifiedFiles: string[];
	/** Bounded, verbatim-prefix failure signatures, so a restart does not retry them blind. */
	failureSignatures: string[];
}

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function clip(text: string, limit: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length <= limit ? flat : `${flat.slice(0, limit)}…[+${flat.length - limit}]`;
}

function signature(name: string, args: unknown, limit: number): string {
	const fields = record(args);
	const rendered = fields ? Object.keys(fields).sort().map(key => `${key}=${clip(String(fields[key] ?? ""), 48)}`).join(", ") : "";
	return clip(`${name}(${rendered})`, limit);
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map(block => {
		const item = record(block);
		return item?.type === "text" && typeof item.text === "string" ? item.text : "";
	}).join("\n").trim();
}

interface RenderedMessage {
	line: string;
	chars: number;
	failure?: string;
}

function renderMessage(message: unknown, policy: CliffCompactionPolicy, first: boolean): RenderedMessage | undefined {
	const item = record(message);
	if (!item) return undefined;
	if (item.role === "user") {
		const text = textOf(item.content);
		if (text.startsWith(MARKER)) return undefined;
		// The opening task statement is the one message kept whole, bounded only
		// so that a single oversized first prompt cannot defeat the cliff.
		return { line: `user: ${clip(text, first ? policy.taskChars : policy.toolResultChars)}`, chars: text.length };
	}
	if (item.role === "assistant") {
		const blocks = Array.isArray(item.content) ? item.content : [];
		const parts: string[] = [];
		let chars = 0;
		for (const block of blocks) {
			const entry = record(block);
			if (!entry) continue;
			if (entry.type === "text" && typeof entry.text === "string") {
				chars += entry.text.length;
				if (entry.text.trim()) parts.push(clip(entry.text, policy.toolResultChars));
			} else if (entry.type === "thinking" && typeof entry.thinking === "string") {
				chars += entry.thinking.length;
				if (entry.thinking.trim()) parts.push(`thinking: ${clip(entry.thinking, policy.thinkingChars)}`);
			} else if (entry.type === "toolCall" && typeof entry.name === "string") {
				parts.push(`call ${signature(entry.name, entry.arguments, policy.toolCallChars)}`);
			}
		}
		return parts.length ? { line: `assistant: ${parts.join(" | ")}`, chars } : undefined;
	}
	if (item.role === "toolResult") {
		const name = typeof item.toolName === "string" ? item.toolName : "tool";
		const text = textOf(item.content);
		const failed = item.isError === true;
		if (text.length > policy.toolResultChars)
			return { line: `result ${name}: [dropped ${text.length} chars]${failed ? " (error)" : ""}`, chars: text.length,
				...(failed ? { failure: `${name}: ${clip(text, policy.toolResultChars)}` } : {}) };
		return { line: `result ${name}${failed ? " (error)" : ""}: ${clip(text, policy.toolResultChars)}`, chars: text.length,
			...(failed ? { failure: `${name}: ${clip(text, policy.toolResultChars)}` } : {}) };
	}
	return undefined;
}

function fileLists(fileOps: CliffPreparation["fileOps"]): { readFiles: string[]; modifiedFiles: string[] } {
	const modified = new Set([...fileOps.written, ...fileOps.edited]);
	return {
		readFiles: [...fileOps.read].filter(file => !modified.has(file)).sort(),
		modifiedFiles: [...modified].sort(),
	};
}

export interface CliffCompactionResult {
	summary: string;
	firstKeptEntryId: string;
	tokensBefore: number;
	details: { readFiles: string[]; modifiedFiles: string[] };
	droppedMessages: number;
	droppedChars: number;
	failureSignatures: string[];
}

/**
 * Build the replacement block for everything Pi is about to drop. Pure, so the
 * same transcript always produces the same bytes and no provider call is made.
 */
export function cliffCompaction(preparation: CliffPreparation, policy: CliffCompactionPolicy = WORKFLOW_COMPACTION): CliffCompactionResult {
	if (!preparation.firstKeptEntryId) throw new Error("cliff compaction requires a first kept entry id");
	const lines: string[] = [];
	const failures: string[] = [];
	let droppedMessages = 0;
	let droppedChars = 0;
	let firstUser = true;
	const render = (messages: readonly unknown[]): void => {
		for (const message of messages) {
			const rendered = renderMessage(message, policy, firstUser && record(message)?.role === "user");
			if (!rendered) continue;
			if (record(message)?.role === "user") firstUser = false;
			droppedMessages++;
			droppedChars += rendered.chars;
			lines.push(rendered.line);
			if (rendered.failure && failures.length < policy.failureSignatures) failures.push(rendered.failure);
		}
	};
	render(preparation.messagesToSummarize);
	if (preparation.isSplitTurn && preparation.turnPrefixMessages.length) {
		lines.push("-- current turn prefix --");
		render(preparation.turnPrefixMessages);
	}
	const details = fileLists(preparation.fileOps);
	// A previous cliff block is carried forward byte-identical: compacting a
	// compaction is what turns a transcript into a summary of a summary.
	const carried = preparation.previousSummary?.trim();
	const body = [
		MARKER,
		`${droppedMessages} earlier messages were deleted or truncated here without rewriting; full text stays in the session transcript and the compaction digest.`,
		...(carried ? ["", carried] : []),
		"",
		...lines,
		"",
		`files read: ${details.readFiles.join(", ") || "none"}`,
		`files modified: ${details.modifiedFiles.join(", ") || "none"}`,
		"</compacted-history>",
	].join("\n");
	return { summary: body, firstKeptEntryId: preparation.firstKeptEntryId, tokensBefore: preparation.tokensBefore,
		details, droppedMessages, droppedChars, failureSignatures: failures };
}

export interface CliffDigestSink {
	/** Absolute path of the append-only digest file for this session. */
	file: string;
	sessionId?: string;
}

/** Append the dropped segment before it leaves the live context. */
export async function appendCliffDigest(sink: CliffDigestSink, result: CliffCompactionResult, reason: string,
	now = new Date()): Promise<CliffDigestRecordV1> {
	const entry: CliffDigestRecordV1 = {
		version: 1, at: now.toISOString(), ...(sink.sessionId ? { sessionId: sink.sessionId } : {}),
		reason, firstKeptEntryId: result.firstKeptEntryId, tokensBefore: result.tokensBefore,
		droppedMessages: result.droppedMessages, droppedChars: result.droppedChars, summary: result.summary,
		readFiles: result.details.readFiles, modifiedFiles: result.details.modifiedFiles,
		failureSignatures: result.failureSignatures,
	};
	await mkdir(path.dirname(sink.file), { recursive: true });
	await appendFile(sink.file, `${JSON.stringify(entry)}\n`, "utf8");
	return entry;
}

/**
 * Replace Pi's model-written summary with the deterministic cliff block. Pi's
 * own threshold, retry and overflow handling stay in charge of when to compact.
 */
export function workflowCompactionExtension(policy: CliffCompactionPolicy = WORKFLOW_COMPACTION,
	sink?: () => CliffDigestSink | undefined): ExtensionFactory {
	return (pi) => {
		pi.on("session_before_compact", async (event) => {
			const result = cliffCompaction(event.preparation, policy);
			let summary = result.summary;
			const target = sink?.();
			if (target) {
				try {
					await appendCliffDigest(target, result, event.reason);
				} catch (error) {
					// Losing the digest must stay visible: the context drop is the one
					// moment where unrecorded evidence becomes unrecoverable.
					summary = `${summary}\n\n[host could not append the compaction digest: ${(error as NodeJS.ErrnoException)?.code ?? "unknown"}]`;
				}
			}
			return { compaction: { summary, firstKeptEntryId: result.firstKeptEntryId,
				tokensBefore: result.tokensBefore, details: result.details } };
		});
	};
}
