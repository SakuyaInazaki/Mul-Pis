/**
 * Session runner abstraction.
 *
 * A "session" is one model conversation with its own message history and an
 * explicit input boundary. Stages create sessions through this interface so the
 * workflow semantics (which session sees what) live in `src/stages/` and the Pi
 * SDK wiring lives in `src/runner/pi.ts`. Tests use `src/runner/fake.ts`.
 */
import type { Role } from "../types.ts";

/**
 * What a session may touch besides the text it is given.
 * - `none`: pure reasoning, no tools at all (M01, M02, M03 answering, first M04).
 * - `read-dir`: a read-only file tool restricted to one directory (M06 material reading,
 *   later M04 rounds reading the knowledge pack directory). Nothing outside `root` is reachable.
 * - `execution`: selected Pi-native file/shell tools with `root` as their cwd. This is capability
 *   selection, not an OS sandbox; in particular, bash retains the current process permissions.
 */
export type ToolGrant =
	| { kind: "none" }
	| { kind: "read-dir"; root: string; toolName?: string; extraTools?: CustomToolSpec[] }
	| { kind: "custom"; tools: CustomToolSpec[] }
	| { kind: "execution"; root: string; tools: Array<"read" | "write" | "edit" | "bash"> };

export interface ToolParamSpec {
	type: "string" | "number" | "boolean" | "string[]";
	description: string;
	optional?: boolean;
}

export interface ToolResult {
	/** Text returned to the model. */
	text: string;
	/** Image files returned to a multimodal model alongside the text (e.g. rendered PDF pages). */
	images?: Array<{ path: string; mimeType: string }>;
	details?: unknown;
}

/**
 * A harness-defined tool handed to one session (M05 acquisition tools). The runner maps it to
 * the SDK's tool definition; the `execute` function stays in the controller so every call can be
 * logged and confined. Sessions with custom tools are single-use: they cannot be resumed.
 */
export interface CustomToolSpec {
	name: string;
	description: string;
	params: Record<string, ToolParamSpec>;
	execute(args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult>;
}

export interface ToolCallRecord {
	name: string;
	args: Record<string, unknown>;
	ok: boolean;
	at: string;
	error?: string;
}

export interface SessionSpec {
	/** Human label used in file names and run records, e.g. `M01`, `M03-reviewer`, `M06-S001-reader`. */
	label: string;
	role: Role;
	/** `provider/model[:thinking]` resolved from the workspace config for `role`. */
	model: string;
	/** Full system prompt. The runner must use it verbatim and must not append discovered resources. */
	systemPrompt: string;
	tools: ToolGrant;
	/** Directory where the session transcript and its spec are persisted. */
	persistDir: string;
	/** Explicit, frozen method identity. It never enables resource discovery. */
	methodBinding?: { versionId: string; contentId?: string };
	/** Explicit opt-in for the L5 one-request path. The optional output cap is retained for bounded runner callers. */
	strictRequest?: { maxProviderCallsPerPrompt: 1; maxOutputTokens?: number; maxInputPayloadBytes: number };
}

/** Enough to reopen a persisted session with the same boundary. */
export interface SessionRef {
	label: string;
	role: Role;
	id: string;
	model: string;
	/** Transcript file (JSONL for the Pi runner). */
	file?: string;
	/** Persisted `SessionSpec` used to rebuild the identical boundary on resume. */
	specFile?: string;
	methodBinding?: SessionSpec["methodBinding"];
}

/** Provider-reported units only. Missing values remain unknown, never inferred from text size. */
export interface UsageValues {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	totalTokens?: number;
	cost?: number;
}

export interface UsageEvent {
	entryId: string;
	kind: "assistant" | "tool-result" | "compaction" | "branch-summary";
	promptIndex: number;
	at: string;
	provider?: string;
	model?: string;
	stopReason?: string;
	usage?: UsageValues;
	status: "reported" | "unknown";
	/** Pi calculates cost from its local model price table; this is not a provider invoice. */
	costSource?: "sdk-estimate" | "unknown";
	costStatus?: "priced" | "unpriced" | "unknown";
}

export interface UsageSummary extends Required<UsageValues> {
	reportedEvents: number;
	unknownEvents: number;
	/** False means the numerical totals are only a reported lower bound. */
	complete: boolean;
	/** False when model pricing is absent/zero or an event has unknown cost. */
	costComplete: boolean;
}

export interface ReadReturnEvent {
	toolName: string;
	status: "returned" | "no-content" | "error";
	/** Granted-root-relative path. */
	path: string;
	requested: { offset?: number; limit?: number };
	/** One-based inclusive text lines actually sent to the model. */
	returned: { startLine?: number; endLine?: number; truncated?: boolean; kind: "text" | "binary" | "unknown" };
	at: string;
}

export interface AssistantTurn {
	/** Visible assistant text of the final message of this turn (thinking excluded). */
	text: string;
	stopReason: string;
	toolCalls: number;
	usage?: UsageSummary;
}

export interface TranscriptMessage {
	role: "user" | "assistant";
	text: string;
}

export interface SessionHandle {
	ref: SessionRef;
	/** Attach an explicit persisted run membership without inferring from labels. */
	setRunContext?(context: { stage: string; runId: string }): void;
	/**
	 * Send one user message and wait for the assistant to finish.
	 * Rejects when the model did not stop normally (error, abort, length) so a stage
	 * never records a truncated or failed reply as a stage output.
	 */
	prompt(text: string): Promise<AssistantTurn>;
	/** Visible user/assistant text in order. Thinking and tool payloads are excluded. */
	transcript(): TranscriptMessage[];
	/** Files actually read through a `read-dir` grant, relative to its root. Empty for `none`. */
	readCoverage(): string[];
	/** Successful read-dir tool returns; file access alone does not imply full coverage. */
	readReturnEvents(): ReadReturnEvent[];
	/** New usage events observed through this handle, excluding history before resume. */
	usageEvents(): UsageEvent[];
	usageSummary(): UsageSummary;
	/** Abort the active prompt and prevent further prompts on this handle. */
	abort(): Promise<void>;
	/** Every harness-defined or execution tool call made by the model in this session, in order. */
	toolLog(): ToolCallRecord[];
	dispose(): void;
}

export interface SessionRunner {
	create(spec: SessionSpec): Promise<SessionHandle>;
	/** Worst-case Pi price-table estimate for one bounded text request; absent/undefined fails admission closed. */
	estimateMaxSdkCost?(modelRaw: string, caps: { maxInputTokens: number; maxOutputTokens: number }): Promise<number | undefined>;
	/** Reopen a persisted session with the boundary recorded in `ref.specFile`. */
	resume(ref: SessionRef): Promise<SessionHandle>;
}
