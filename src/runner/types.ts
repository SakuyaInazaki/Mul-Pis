/**
 * Session runner abstraction.
 *
 * A "session" is one model conversation with its own message history and an
 * explicit input boundary. Stages create sessions through this interface so the
 * workflow semantics (which session sees what) live in `src/stages/` and the Pi
 * SDK wiring lives in `src/runner/pi.ts`. Tests use `src/runner/fake.ts`.
 */
import type { Role } from "../types.ts";
import type { EvidenceBindingV1 } from "../context/boundary.ts";
import type { DeepSeekRequestViolation } from "./deepseek-request-contract.ts";

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
	errorClass?: "harness" | "filesystem" | "tool-error";
	errorCode?: string;
	/** Bounded, redacted host diagnostic for a failed factory-confined read only. */
	errorMessage?: string;
	resultMetadata?: { kind: "confined-utf8-read"; relativePath: string;
		utf8Bytes: number; truncated: false };
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
	/** Controller/runner-derived, persisted authority for audited campaign custom file tools. */
	toolAuthority?: { version: 1; kind: "confined-campaign-files"; root: string; writableFiles: string[] };
	/** Directory where the session transcript and its spec are persisted. */
	persistDir: string;
	/** Explicit, frozen method identity. It never enables resource discovery. */
	methodBinding?: { versionId: string; contentId?: string };
	/** Opt-in request guard. A campaign reserves actual serialized input bytes; tool-free strict callers may still set a fixed input cap. */
	strictRequest?: { maxProviderCallsPerPrompt?: number; maxOutputTokens?: number; maxInputPayloadBytes?: number };
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
	/** Committed true-fork receipt. Its absence never implies a fork. */
	lineageFile?: string;
}

/** A persisted, completed Pi leaf copied before any child may start. */
export interface SessionCheckpoint {
	version: 1;
	id: string;
	sourceSessionId: string;
	sourceSessionFile: string;
	sourceSpecFile: string;
	/** Runner-owned byte copy of the parent's grant and model spec. */
	sourceSpecSnapshot: string;
	snapshotFile: string;
	leafId: string;
	model: string;
	inputManifest: string;
	/** Runner-owned byte copy of the controller's manifest at checkpoint time. */
	manifestSnapshot: string;
	runId: string;
	taskId?: string;
	frozenAt: string;
	snapshotBytes: number;
}

export interface ForkRequest {
	checkpoint: SessionCheckpoint;
	spec: SessionSpec;
	evidenceBindings: EvidenceBindingV1[];
	workspaceBinding?: ForkWorkspaceBindingV1;
	reason: string;
}

/** Controller-frozen authority for copying one task workspace into an independent branch. */
export interface ForkWorkspaceBindingV1 {
	version: 1;
	parentRoot: string;
	authorizedChildRootBase: string;
	childWorkLeaf: string;
	childRoot: string;
	ownerMarkerPath: string;
	frozenEvidenceRoot: string;
	files: Array<{ sourcePath: string; frozenPath: string; childPath: string; bytes: number }>;
}

export interface RunnerCapabilities {
	version: 1;
	fresh: true;
	continue: true;
	persistedLineage: true;
	forkAtFrozenLeaf: true;
	grantKinds: ToolGrant["kind"][];
	modelCompatibility: "exact-model-only";
	multimodalHistory: "model-dependent";
	parallelPromptLeases: "single-process";
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

/** Private, redacted host-observed failure facts for one Pi provider request. Null means unavailable. */
export interface TransportFailureDiagnostic {
	version: 1;
	promptIndex: number;
	requestId?: string;
	phase: "request" | "response-body" | "provider-stream" | "unknown";
	httpStatus: number | null;
	responseStarted: boolean | null;
	bytesRead: number | null;
	abortSource: "host-signal" | "handle" | "sdk-signal" | null;
	/** Exact, allowlisted JSON error values observed on a non-2xx response; never free-form text. */
	providerErrorCode: string | null;
	providerErrorType: string | null;
	/** Host-classified, bounded cause; unknown when the provider metadata is ambiguous. */
	providerErrorReasonClass?: "context-window" | "input-schema" | "tool-reasoning" |
		"insufficient-balance" | "unknown";
	/** Arithmetic checked from the provider's complete context-limit sentence; no provider text or request ID. */
	providerContextOverflow?: { contextWindow: number; messagesTokens: number; completionTokens: number;
		requestedTokens: number; allowedCompletionTokens: number };
	/** Validated server x-request-id, if it is a UUID or hexadecimal identifier. */
	providerRequestId: string | null;
	errorCodes: string[];
	/** Encrypted private result only. Never copy into a model-facing carry or public log. */
	privateProviderError?: { code: string | null; type: string | null; message: string | null;
		param: string | null; numericLimits: Record<string, number> };
	/** Static request-schema rejection of one attempted payload. */
	requestContractViolation?: DeepSeekRequestViolation;
	requestContractMessageIndex?: number | null;
	attemptedRequestNotSent?: true;
	/** True only when this entire prompt had no earlier reserved provider request. */
	wholePromptNotIssued?: true;
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
	/** Redacted failures from this live handle only; no prompt, body, URL, or raw SDK error text. */
	transportDiagnostics?(): TransportFailureDiagnostic[];
	/** Abort the active prompt and prevent further prompts on this handle. */
	abort(): Promise<void>;
	/** Every harness-defined or execution tool call made by the model in this session, in order. */
	toolLog(): ToolCallRecord[];
	dispose(): void;
}

export interface SessionRunner {
	create(spec: SessionSpec): Promise<SessionHandle>;
	capabilities?(): RunnerCapabilities;
	/** Live factory-backed attestation; persisted JSON alone cannot authorize a custom-tool narrowing claim. */
	attestConfinedGrant?(handle: SessionHandle): Promise<NonNullable<SessionSpec["toolAuthority"]> | undefined>;
	/** Refuse a live, failed, or unsettled parent and freeze exact source bytes. */
	checkpoint?(handle: SessionHandle, envelope: { inputManifest: string; runId: string; taskId?: string; externalOperationsSettled: boolean }): Promise<SessionCheckpoint>;
	/** A new persisted Pi history from the checkpoint leaf, with independent grants. */
	fork?(request: ForkRequest): Promise<SessionHandle>;
	/** Worst-case Pi price-table estimate for one bounded text request; absent/undefined fails admission closed. */
	estimateMaxSdkCost?(modelRaw: string, caps: { maxInputTokens: number; maxOutputTokens: number }): Promise<number | undefined>;
	/** Reopen a persisted session with the boundary recorded in `ref.specFile`. */
	resume(ref: SessionRef): Promise<SessionHandle>;
}
