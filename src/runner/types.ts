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
 */
export type ToolGrant =
	| { kind: "none" }
	| { kind: "read-dir"; root: string; toolName?: string; extraTools?: CustomToolSpec[] }
	| { kind: "custom"; tools: CustomToolSpec[] };

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
	execute(args: Record<string, unknown>): Promise<ToolResult>;
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
}

export interface AssistantTurn {
	/** Visible assistant text of the final message of this turn (thinking excluded). */
	text: string;
	stopReason: string;
	toolCalls: number;
	usage?: { input?: number; output?: number; cost?: number };
}

export interface TranscriptMessage {
	role: "user" | "assistant";
	text: string;
}

export interface SessionHandle {
	ref: SessionRef;
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
	/** Every custom tool call made by the model in this session, in order. Empty unless the grant is `custom`. */
	toolLog(): ToolCallRecord[];
	dispose(): void;
}

export interface SessionRunner {
	create(spec: SessionSpec): Promise<SessionHandle>;
	/** Reopen a persisted session with the boundary recorded in `ref.specFile`. */
	resume(ref: SessionRef): Promise<SessionHandle>;
}
