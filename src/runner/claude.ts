/**
 * Claude Code session runner.
 *
 * Third implementation of the `SessionRunner` contract next to
 * `src/runner/pi.ts` (Pi SDK) and `src/runner/fake.ts` (scripted tests). The
 * substrate is the Claude Agent SDK: one workflow session is one Claude Code
 * conversation, continued by resuming its id. Workflow semantics stay in
 * `src/stages/`; nothing here decides stage order, gates, prompts or evidence.
 *
 * Input isolation. Every turn runs with `settingSources: []` and
 * `strictMcpConfig: true`, so no user or project `CLAUDE.md`, skill, plugin or
 * external MCP server is discovered, and `systemPrompt` is passed as a plain
 * string so it replaces the default prompt verbatim. A session therefore sees
 * only `spec.systemPrompt`, the messages its stage sends, and the tools its
 * grant names. The operator's own `~/.claude/CLAUDE.md` is never read, moved or
 * modified; suppression is per turn. `attestLoadout` reads the actual loadout
 * back from a live session so a caller can assert isolation instead of
 * trusting it.
 *
 * Tool grants. `none` allows no tools at all. `execution` allows exactly the
 * built-in tools the grant names, with `root` as the working directory.
 * `read-dir` and `custom` are served by harness-owned tools registered as an
 * in-process MCP server, so every call executes in this process and is logged
 * here. The confined read tool computes its own returned line range, which is
 * what the M04 full-read gate in `src/stages/m04.ts` consumes; the line count
 * is derived exactly as that gate derives it.
 *
 * Declined capabilities. `capabilities`, `checkpoint` and `fork` are absent.
 * `RunnerCapabilities` types its fields as literal `true`, so a runner that
 * cannot yet branch must omit the methods instead of attesting something
 * untrue; `src/context/boundary.ts` then refuses branch requests.
 * `transportDiagnostics`, `providerOutputRequests` and `estimateMaxSdkCost` are
 * absent because the strict-request and campaign accounting paths in
 * `src/runner/pi.ts` inspect real provider HTTP responses and payloads, which
 * this substrate does not expose; those paths keep using the Pi runner rather
 * than being handed synthesized transport evidence.
 */
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { appendFile, lstat, mkdir, readFile, readdir, realpath } from "node:fs/promises";
import { createSdkMcpServer, query, tool } from "@anthropic-ai/claude-agent-sdk";
import type { Options, PermissionResult, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { parseModelSpec } from "../config.ts";
import { HarnessError } from "../types.ts";
import { readTextIfExists, writeFileAtomic } from "../workspace.ts";
import type {
	AssistantTurn, CustomToolSpec, ReadReturnEvent, SessionHandle, SessionRef, SessionRunner,
	SessionSpec, ToolCallRecord, ToolParamSpec, ToolResult, TranscriptMessage, UsageEvent, UsageValues,
} from "./types.ts";
import { summarizeUsage } from "./usage.ts";

/** Provider segment a workspace config must use to select this runner. */
export const CLAUDE_CODE_PROVIDER = "claude-code";

/** In-process MCP server that carries every harness-owned tool for one session. */
const HARNESS_SERVER = "harness";

const LIST_TOOL_NAME = "material_list";
const DEFAULT_READ_TOOL_NAME = "material_read";

/** Lines returned by one confined read when the caller gives no limit. */
const DEFAULT_READ_LIMIT = 2000;

const EXECUTION_TOOL_NAMES: Record<"read" | "write" | "edit" | "bash", string> = {
	read: "Read", write: "Write", edit: "Edit", bash: "Bash",
};

const IMAGE_MIME_TYPES: Record<string, string> = {
	".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
	".gif": "image/gif", ".webp": "image/webp", ".bmp": "image/bmp",
};

/**
 * Line count exactly as `m07ReadGaps` in `src/stages/m04.ts` derives it, so a
 * reported terminal line can satisfy that gate instead of overshooting by the
 * empty element a trailing newline produces.
 */
function lineCountOf(text: string): number {
	return text.split(/\r?\n/).length - (text.endsWith("\n") ? 1 : 0);
}

function isInside(root: string, candidate: string): boolean {
	return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

async function resolveConfinedPath(rootReal: string, requested: string): Promise<string> {
	if (!requested.trim()) throw new Error("material path must not be empty");
	const candidate = path.isAbsolute(requested) ? path.resolve(requested) : path.resolve(rootReal, requested);
	const resolved = await realpath(candidate);
	if (!isInside(rootReal, resolved)) throw new Error("material path resolves outside the granted directory");
	return resolved;
}

function rejectPdf(resolved: string, readName: string): void {
	if (path.extname(resolved).toLowerCase() === ".pdf")
		throw new Error(`PDF reading is not supported by ${readName}; provide an extracted text artifact instead`);
}

function imageMimeType(resolved: string): string | undefined {
	return IMAGE_MIME_TYPES[path.extname(resolved).toLowerCase()];
}

/** Collects what a session's tools actually did, for the handle's evidence accessors. */
interface ToolSink {
	toolLog: ToolCallRecord[];
	readCoverage: Set<string>;
	readReturns: ReadReturnEvent[];
}

/** Content blocks an MCP tool may return to the model. */
type ToolContent = Array<
	| { type: "text"; text: string }
	| { type: "image"; data: string; mimeType: string }
>;

interface ToolCallOutcome {
	// The SDK's tool result type carries an open index signature; matching it here
	// keeps the handlers assignable without casting at every registration site.
	[key: string]: unknown;
	content: ToolContent;
	isError?: boolean;
}

function zodShapeFor(params: Record<string, ToolParamSpec>): Record<string, z.ZodType> {
	const shape: Record<string, z.ZodType> = {};
	for (const [name, spec] of Object.entries(params)) {
		const base = spec.type === "number" ? z.number()
			: spec.type === "boolean" ? z.boolean()
			: spec.type === "string[]" ? z.array(z.string())
			: z.string();
		const described = base.describe(spec.description);
		shape[name] = spec.optional ? described.optional() : described;
	}
	return shape;
}

function textResult(text: string): ToolCallOutcome {
	return { content: [{ type: "text", text }] };
}

/** Wrap a harness tool so every call is logged with its real outcome. */
function logged(
	sink: ToolSink, name: string,
	run: (args: Record<string, unknown>) => Promise<ToolCallOutcome>,
): (args: Record<string, unknown>) => Promise<ToolCallOutcome> {
	return async (args: Record<string, unknown>) => {
		const at = new Date().toISOString();
		try {
			const result = await run(args);
			sink.toolLog.push({ name, args, ok: true, at });
			return result;
		} catch (error) {
			sink.toolLog.push({ name, args, ok: false, at, error: (error as Error).message, errorClass: "tool-error" });
			return { ...textResult(`${name} failed: ${(error as Error).message}`), isError: true };
		}
	};
}

/**
 * Harness-owned confined read and list tools for a `read-dir` grant. The read
 * tool owns its own pagination, so the returned range it reports is computed
 * rather than inferred, and a read that reaches the last line reports
 * `truncated: false` so the M04 terminal-page check can be satisfied.
 */
async function materialTools(root: string, readName: string, sink: ToolSink) {
	const rootReal = await realpath(root);
	if (!(await lstat(rootReal)).isDirectory())
		throw new HarnessError("runner.tools", `read-dir root is not a directory: ${root}`);
	if (readName === LIST_TOOL_NAME)
		throw new HarnessError("runner.tools", `${readName} cannot be the read tool name because it is reserved`);

	const read = tool(
		readName,
		`Read one text file inside the granted directory. Paths are relative to that directory. ` +
		`Optional 1-based "offset" selects the first line and "limit" the number of lines ` +
		`(default ${DEFAULT_READ_LIMIT}). When the reply says lines remain, continue from the stated offset ` +
		`until the final line has been read.`,
		{
			path: z.string().describe("file path relative to the granted directory"),
			offset: z.number().int().min(1).optional().describe("1-based first line to return"),
			limit: z.number().int().min(1).optional().describe("maximum number of lines to return"),
		},
		logged(sink, readName, async (args) => {
			const requested = args as { path: string; offset?: number; limit?: number };
			const requestFields = {
				...(requested.offset !== undefined ? { offset: requested.offset } : {}),
				...(requested.limit !== undefined ? { limit: requested.limit } : {}),
			};
			let relative = "<unresolved>";
			try {
				const resolved = await resolveConfinedPath(rootReal, requested.path);
				rejectPdf(resolved, readName);
				if (!(await lstat(resolved)).isFile()) throw new Error(`${readName} accepts files only`);
				relative = path.relative(rootReal, resolved);
				const bytes = await readFile(resolved);
				sink.readCoverage.add(relative);

				const mime = imageMimeType(resolved);
				if (mime) {
					sink.readReturns.push({
						toolName: readName, status: "returned", path: relative, requested: requestFields,
						returned: { kind: "binary", truncated: false }, at: new Date().toISOString(),
					});
					return { content: [{ type: "image", data: bytes.toString("base64"), mimeType: mime }] };
				}

				const text = bytes.toString("utf8");
				if (bytes.length === 0) {
					sink.readReturns.push({
						toolName: readName, status: "no-content", path: relative, requested: requestFields,
						returned: { kind: "text", truncated: false }, at: new Date().toISOString(),
					});
					return textResult(`${relative} is empty (0 bytes).`);
				}

				const total = lineCountOf(text);
				const startLine = requested.offset ?? 1;
				if (startLine > total) {
					sink.readReturns.push({
						toolName: readName, status: "error", path: relative, requested: requestFields,
						returned: { kind: "unknown" }, error: { kind: "offset-beyond-eof", lineCount: total },
						at: new Date().toISOString(),
					});
					throw new Error(`Offset ${startLine} is beyond end of file (${total} lines total)`);
				}
				const lines = text.split(/\r?\n/).slice(0, total);
				const limit = requested.limit ?? DEFAULT_READ_LIMIT;
				const endLine = Math.min(total, startLine + limit - 1);
				const truncated = endLine < total;
				const body = lines.slice(startLine - 1, endLine)
					.map((line, index) => `${startLine + index}\t${line}`).join("\n");
				sink.readReturns.push({
					toolName: readName, status: "returned", path: relative, requested: requestFields,
					returned: { kind: "text", startLine, endLine, truncated }, at: new Date().toISOString(),
				});
				return textResult(truncated
					? `${body}\n\n[${total - endLine} more lines in file. Use offset=${endLine + 1} to continue.]`
					: body);
			} catch (error) {
				if (!sink.readReturns.some((event) => event.at && event.path === relative &&
					event.requested.offset === requestFields.offset && event.requested.limit === requestFields.limit &&
					event.status === "error")) {
					sink.readReturns.push({
						toolName: readName, status: "error", path: relative, requested: requestFields,
						returned: { kind: "unknown" }, at: new Date().toISOString(),
					});
				}
				throw error;
			}
		}),
	);

	const list = tool(
		LIST_TOOL_NAME,
		"List every file inside the granted directory, as paths relative to it.",
		{},
		logged(sink, LIST_TOOL_NAME, async () => {
			const found: string[] = [];
			const walk = async (dir: string): Promise<void> => {
				for (const entry of await readdir(dir, { withFileTypes: true })) {
					const full = path.join(dir, entry.name);
					if (entry.isDirectory()) await walk(full);
					else if (entry.isFile()) found.push(path.relative(rootReal, full));
				}
			};
			await walk(rootReal);
			found.sort();
			return textResult(found.length ? found.join("\n") : "the granted directory contains no files");
		}),
	);

	return [read, list];
}

function customTool(spec: CustomToolSpec, sink: ToolSink, signal: AbortSignal) {
	return tool(
		spec.name, spec.description, zodShapeFor(spec.params),
		logged(sink, spec.name, async (args) => {
			const result: ToolResult = await spec.execute(args, signal);
			const content: ToolContent = [{ type: "text", text: result.text }];
			for (const image of result.images ?? []) {
				content.push({ type: "image", data: (await readFile(image.path)).toString("base64"), mimeType: image.mimeType });
			}
			return { content };
		}),
	);
}

/** Everything the SDK needs to honour one grant, plus the sink that records it. */
interface ResolvedGrant {
	allowedTools: string[];
	/**
	 * The base set of built-in tools. An empty `allowedTools` means "no
	 * restriction" to the SDK rather than "no tools", so the built-in set is
	 * declared here instead: `[]` disables all built-ins, and a list names
	 * exactly the ones the grant allows.
	 */
	tools: string[];
	cwd?: string;
	mcpServers?: Options["mcpServers"];
}

async function resolveGrant(spec: SessionSpec, sink: ToolSink, signal: AbortSignal): Promise<ResolvedGrant> {
	const grant = spec.tools;
	const qualified = (name: string): string => `mcp__${HARNESS_SERVER}__${name}`;
	if (grant.kind === "none") return { allowedTools: [], tools: [] };
	if (grant.kind === "execution") {
		const names = grant.tools.map((name) => EXECUTION_TOOL_NAMES[name]);
		if (names.some((name) => !name)) throw new HarnessError("runner.tools", `unknown execution tool in the grant for ${spec.label}`);
		return { allowedTools: names, tools: names, cwd: grant.root };
	}
	if (grant.kind === "read-dir") {
		const readName = grant.toolName ?? DEFAULT_READ_TOOL_NAME;
		const tools = [
			...(await materialTools(grant.root, readName, sink)),
			...(grant.extraTools ?? []).map((extra) => customTool(extra, sink, signal)),
		];
		return {
			allowedTools: [readName, LIST_TOOL_NAME, ...(grant.extraTools ?? []).map((extra) => extra.name)].map(qualified),
			tools: [],
			mcpServers: { [HARNESS_SERVER]: createSdkMcpServer({ name: HARNESS_SERVER, version: "1.0.0", tools }) },
		};
	}
	const tools = grant.tools.map((custom) => customTool(custom, sink, signal));
	return {
		allowedTools: grant.tools.map((custom) => qualified(custom.name)),
		tools: [],
		mcpServers: { [HARNESS_SERVER]: createSdkMcpServer({ name: HARNESS_SERVER, version: "1.0.0", tools }) },
	};
}

/**
 * Map the SDK stop vocabulary onto the one the harness already matches on.
 * `pi.ts` raises `runner.stop` with `stopReason=<x>` and
 * `src/m07/objective-progress.ts` tests for `/stopReason=length/`, so a reply
 * truncated by the output limit must say `length` here too.
 */
function normalizeStopReason(result: Record<string, unknown>): string {
	const subtype = typeof result.subtype === "string" ? result.subtype : undefined;
	const raw = typeof result.stop_reason === "string" ? result.stop_reason : undefined;
	if (subtype === "error_max_turns") return "max-turns";
	if (subtype === "error_during_execution") return "error";
	if (raw === "max_tokens") return "length";
	if (raw === "end_turn" || raw === "stop_sequence" || raw === "tool_use") return "stop";
	if (subtype === "success") return "stop";
	return raw ?? "missing";
}

/** Provider-reported counters only; the substrate exposes no provider total. */
function usageFromResult(result: Record<string, unknown>): UsageValues | undefined {
	const raw = result.usage;
	if (!raw || typeof raw !== "object") return undefined;
	const source = raw as Record<string, unknown>;
	const usage: UsageValues = {};
	const take = (key: string, field: keyof UsageValues): void => {
		const value = source[key];
		if (typeof value === "number" && Number.isFinite(value) && value >= 0) usage[field] = value;
	};
	take("input_tokens", "input");
	take("output_tokens", "output");
	take("cache_read_input_tokens", "cacheRead");
	take("cache_creation_input_tokens", "cacheWrite");
	const cost = result.total_cost_usd;
	if (typeof cost === "number" && Number.isFinite(cost) && cost >= 0) usage.cost = cost;
	return Object.keys(usage).length ? usage : undefined;
}

interface ClaudeSessionState {
	spec: SessionSpec;
	ref: SessionRef;
	/** Claude Code conversation id; later turns resume it. */
	conversationId: string;
	started: boolean;
	cwd: string;
	transcript: TranscriptMessage[];
	sink: ToolSink;
	turns: number;
	active: boolean;
	disposed: boolean;
}

export interface ClaudeSessionRunnerOptions {
	/** Working directory for sessions without an execution grant. */
	scratchRoot?: string;
	/** Overrides the Claude Code executable the SDK launches. */
	executable?: Options["executable"];
	signal?: AbortSignal;
}

export class ClaudeSessionRunner implements SessionRunner {
	private readonly options: ClaudeSessionRunnerOptions;
	private readonly states = new Map<string, ClaudeSessionState>();

	constructor(options: ClaudeSessionRunnerOptions = {}) {
		this.options = options;
	}

	async create(spec: SessionSpec): Promise<SessionHandle> {
		// Fail fast on a model string this runner cannot serve, before anything is persisted.
		this.resolveModel(spec.model);
		const id = `claude-${randomBytes(4).toString("hex")}`;
		const file = path.join(spec.persistDir, `${spec.label}-${id}.jsonl`);
		const specFile = file.replace(/\.jsonl$/, ".spec.json");
		await mkdir(spec.persistDir, { recursive: true });
		await writeFileAtomic(specFile, `${JSON.stringify(spec, null, 2)}\n`);
		await writeFileAtomic(file, "");
		const ref: SessionRef = {
			label: spec.label, role: spec.role, id, model: spec.model, file, specFile,
			...(spec.methodBinding ? { methodBinding: spec.methodBinding } : {}),
		};
		this.states.set(id, {
			spec, ref, conversationId: randomUUID(), started: false,
			cwd: await this.sessionCwd(spec, id), transcript: [],
			sink: { toolLog: [], readCoverage: new Set(), readReturns: [] },
			turns: 0, active: false, disposed: false,
		});
		return this.handle(this.states.get(id)!);
	}

	async resume(ref: SessionRef): Promise<SessionHandle> {
		const live = this.states.get(ref.id);
		if (live) {
			if (live.ref.file !== ref.file || live.ref.specFile !== ref.specFile)
				throw new HarnessError("runner.persistence", `session ${ref.id} persisted paths differ from the live record`);
			if (ref.methodBinding && JSON.stringify(ref.methodBinding) !== JSON.stringify(live.spec.methodBinding))
				throw new HarnessError("runner.boundary", `method binding mismatch for ${ref.id}`);
			return this.handle(live);
		}
		const specText = ref.specFile ? await readTextIfExists(ref.specFile) : undefined;
		const transcriptText = ref.file ? await readTextIfExists(ref.file) : undefined;
		if (!specText || transcriptText === undefined)
			throw new HarnessError("runner.persistence", `cannot resume ${ref.id}: persisted spec or transcript is missing`);
		const spec = JSON.parse(specText) as SessionSpec;
		if (spec.model !== ref.model || spec.role !== ref.role || spec.label !== ref.label)
			throw new HarnessError("runner.boundary", `persisted boundary differs for ${ref.id}`);
		if (spec.tools.kind !== "none")
			throw new HarnessError("runner.isolation", `session ${ref.id} with a ${spec.tools.kind} grant is not resumable across processes`);
		const conversationId = await readTextIfExists(ref.file!.replace(/\.jsonl$/, ".conversation"));
		if (!conversationId?.trim())
			throw new HarnessError("runner.persistence", `cannot resume ${ref.id}: conversation id was not persisted`);
		const transcript = transcriptText.split(/\r?\n/).filter((line) => line.trim())
			.map((line) => JSON.parse(line) as TranscriptMessage);
		const state: ClaudeSessionState = {
			spec, ref, conversationId: conversationId.trim(), started: transcript.length > 0,
			cwd: await this.sessionCwd(spec, ref.id), transcript,
			sink: { toolLog: [], readCoverage: new Set(), readReturns: [] },
			turns: transcript.filter((m) => m.role === "user").length, active: false, disposed: false,
		};
		this.states.set(ref.id, state);
		return this.handle(state);
	}

	/**
	 * Read back what a live session actually loaded, so a caller can assert
	 * isolation. This runner states no isolation it has not shown.
	 */
	async attestLoadout(handle: SessionHandle): Promise<{ contextFiles: string; tools: string }> {
		const turn = await handle.prompt(
			"Answer in exactly this format and nothing else:\n" +
			"CONTEXT_FILES=<comma-separated names of any CLAUDE.md, AGENTS.md or other instruction file whose content was provided to you, or NONE>\n" +
			"TOOLS=<comma-separated names of the tools you can call, or NONE>",
		);
		return {
			contextFiles: /CONTEXT_FILES=(.*)/.exec(turn.text)?.[1]?.trim() ?? "",
			tools: /TOOLS=(.*)/.exec(turn.text)?.[1]?.trim() ?? "",
		};
	}

	private resolveModel(raw: string): { modelId: string } {
		const parsed = parseModelSpec(raw);
		if (parsed.provider !== CLAUDE_CODE_PROVIDER)
			throw new HarnessError("runner.model", `this runner only serves ${CLAUDE_CODE_PROVIDER}/<model>; the configured value is ${raw}`);
		if (!parsed.modelId.trim()) throw new HarnessError("runner.model", `model id is empty in ${raw}`);
		return { modelId: parsed.modelId };
	}

	private async sessionCwd(spec: SessionSpec, id: string): Promise<string> {
		if (spec.tools.kind === "execution") return spec.tools.root;
		const base = this.options.scratchRoot ?? path.join(spec.persistDir, ".claude-session");
		const dir = path.join(base, id);
		await mkdir(dir, { recursive: true });
		if ((await readdir(dir)).length !== 0)
			throw new HarnessError("runner.isolation", `session working directory is not empty: ${dir}`);
		return dir;
	}

	private handle(state: ClaudeSessionState): SessionHandle {
		const usageEvents: UsageEvent[] = [];
		const controller = new AbortController();
		let disposed = false;
		let aborted = false;
		return {
			ref: state.ref,
			prompt: async (text: string): Promise<AssistantTurn> => {
				if (disposed || aborted || state.disposed)
					throw new HarnessError("runner.aborted", `session ${state.ref.label} was aborted or disposed`);
				if (state.active) throw new HarnessError("runner.aborted", `session ${state.ref.label} is already active`);
				const { modelId } = this.resolveModel(state.spec.model);
				state.active = true;
				state.transcript.push({ role: "user", text });
				state.turns += 1;
				const promptIndex = state.turns;
				let outcome: "completed" | "failed" | "aborted" = "failed";
				let usage: UsageValues | undefined;
				let stopReason = "missing";
				// Built once on the success path so the recorded evidence is the same
				// object the stage was handed, not a second reconstruction.
				let settled: UsageEvent | undefined;
				const toolsBefore = state.sink.toolLog.length;
				try {
					const signal = this.options.signal ?? controller.signal;
					const grant = await resolveGrant(state.spec, state.sink, signal);
					const allowed = new Set(grant.allowedTools);
					const options: Options = {
						// Per-turn input isolation: no CLAUDE.md, skills or plugins; no external MCP servers.
						settingSources: [],
						strictMcpConfig: true,
						// A plain string replaces the default prompt, so the stage's prompt is used verbatim.
						systemPrompt: state.spec.systemPrompt,
						model: modelId,
						allowedTools: grant.allowedTools,
						tools: grant.tools,
						cwd: grant.cwd ?? state.cwd,
						abortController: controller,
						...(grant.mcpServers ? { mcpServers: grant.mcpServers } : {}),
						...(this.options.executable ? { executable: this.options.executable } : {}),
						...(state.started ? { resume: state.conversationId } : {}),
						...(state.spec.strictRequest?.maxProviderCallsPerPrompt
							? { maxTurns: state.spec.strictRequest.maxProviderCallsPerPrompt } : {}),
						// The grant is the authority: anything outside it is denied, never prompted.
						canUseTool: async (toolName: string, input: Record<string, unknown>): Promise<PermissionResult> =>
							allowed.has(toolName)
								? { behavior: "allow", updatedInput: input }
								: { behavior: "deny", message: `tool ${toolName} is outside the session grant` },
					};

					let result: Record<string, unknown> | undefined;
					let activeTools: string[] | undefined;
					const builtinCalls = new Map<string, { name: string; args: Record<string, unknown>; at: string }>();
					for await (const message of query({ prompt: text, options }) as AsyncIterable<SDKMessage>) {
						const envelope = message as unknown as Record<string, unknown>;
						if (envelope.type === "result") { result = envelope; continue; }
						// The session announces the tool set it actually loaded. The grant is the
						// authority, so the active set must equal it, never exceed it.
						if (envelope.type === "system" && envelope.subtype === "init" && Array.isArray(envelope.tools)) {
							activeTools = (envelope.tools as unknown[]).filter((name): name is string => typeof name === "string");
							const extra = activeTools.filter((name) => !allowed.has(name));
							if (extra.length) {
								controller.abort();
								throw new HarnessError(
									"runner.isolation",
									`session ${state.ref.label} loaded tools outside its ${state.spec.tools.kind} grant: ${extra.join(", ")}`,
								);
							}
							continue;
						}
						// Built-in tool calls are recorded from the stream; harness tools log themselves.
						if (envelope.type === "assistant") {
							const content = (envelope.message as { content?: unknown[] } | undefined)?.content ?? [];
							for (const block of content as Array<Record<string, unknown>>) {
								if (block.type !== "tool_use" || typeof block.name !== "string") continue;
								if (block.name.startsWith(`mcp__${HARNESS_SERVER}__`)) continue;
								builtinCalls.set(String(block.id), {
									name: block.name, args: (block.input as Record<string, unknown>) ?? {},
									at: new Date().toISOString(),
								});
							}
						} else if (envelope.type === "user") {
							const content = (envelope.message as { content?: unknown[] } | undefined)?.content ?? [];
							for (const block of content as Array<Record<string, unknown>>) {
								if (block.type !== "tool_result") continue;
								const call = builtinCalls.get(String(block.tool_use_id));
								if (!call) continue;
								builtinCalls.delete(String(block.tool_use_id));
								state.sink.toolLog.push({
									name: call.name, args: call.args, ok: block.is_error !== true, at: call.at,
									toolCallId: String(block.tool_use_id),
									...(block.is_error === true ? { errorClass: "tool-error" as const } : {}),
								});
							}
						}
					}
					if (!result) throw new HarnessError("runner.stop", `session ${state.ref.label} produced no result message (stopReason=missing)`);

					usage = usageFromResult(result);
					stopReason = normalizeStopReason(result);
					const sessionId = typeof result.session_id === "string" ? result.session_id : undefined;
					if (!state.started) {
						if (!sessionId) throw new HarnessError("runner.persistence", `session ${state.ref.label} returned no conversation id`);
						state.conversationId = sessionId;
						await writeFileAtomic(state.ref.file!.replace(/\.jsonl$/, ".conversation"), `${sessionId}\n`);
						state.started = true;
					} else if (sessionId && sessionId !== state.conversationId) {
						// A resumed turn may be recorded under a new id; keep following the live one.
						state.conversationId = sessionId;
						await writeFileAtomic(state.ref.file!.replace(/\.jsonl$/, ".conversation"), `${sessionId}\n`);
					}
					// A denial is the grant doing its job: the model reached outside it and was
					// refused. Record the attempt and continue; it is not a launch inconsistency.
					for (const denial of Array.isArray(result.permission_denials) ? result.permission_denials : []) {
						const entry = denial as Record<string, unknown>;
						state.sink.toolLog.push({
							name: typeof entry.tool_name === "string" ? entry.tool_name : "<unknown>",
							args: (entry.tool_input as Record<string, unknown>) ?? {},
							ok: false, at: new Date().toISOString(),
							...(typeof entry.tool_use_id === "string" ? { toolCallId: entry.tool_use_id } : {}),
							error: "denied: outside the session tool grant", errorClass: "harness",
						});
					}
					if (result.is_error === true || stopReason !== "stop")
						throw new HarnessError("runner.stop", `session ${state.ref.label} did not stop normally (stopReason=${stopReason})`);
					const reply = result.result;
					if (typeof reply !== "string")
						throw new HarnessError("runner.stop", `session ${state.ref.label} returned no assistant text (stopReason=${stopReason})`);

					state.transcript.push({ role: "assistant", text: reply });
					await writeFileAtomic(state.ref.file!, `${state.transcript.map((m) => JSON.stringify(m)).join("\n")}\n`);
					outcome = "completed";
					settled = this.usageEvent(state, promptIndex, usage, stopReason);
					return {
						text: reply, stopReason,
						toolCalls: state.sink.toolLog.length - toolsBefore,
						usage: summarizeUsage([settled]),
					};
				} finally {
					state.active = false;
					if (aborted) outcome = "aborted";
					const event = settled ?? this.usageEvent(state, promptIndex, usage, stopReason);
					usageEvents.push(event);
					await appendFile(
						state.ref.file!.replace(/\.jsonl$/, ".usage.jsonl"),
						`${JSON.stringify({ version: 1, sessionId: state.ref.id, promptIndex, outcome, events: [event], summary: summarizeUsage([event]) })}\n`,
					);
				}
			},
			transcript: () => [...state.transcript],
			readCoverage: () => [...state.sink.readCoverage].sort(),
			readReturnEvents: () => [...state.sink.readReturns],
			usageEvents: () => [...usageEvents],
			usageSummary: () => summarizeUsage(usageEvents),
			toolLog: () => [...state.sink.toolLog],
			abort: async () => { aborted = true; controller.abort(); },
			dispose: () => { if (disposed) return; disposed = true; state.disposed = true; controller.abort(); },
		};
	}

	private usageEvent(
		state: ClaudeSessionState, promptIndex: number, usage: UsageValues | undefined, stopReason: string,
	): UsageEvent {
		return {
			entryId: `${state.ref.id}-${promptIndex}`,
			kind: "assistant",
			promptIndex,
			at: new Date().toISOString(),
			provider: CLAUDE_CODE_PROVIDER,
			model: state.spec.model,
			stopReason,
			...(usage ? { usage } : {}),
			// The substrate reports no provider total, so totals stay an explicit lower bound.
			status: "unknown",
			costSource: usage?.cost !== undefined ? "sdk-estimate" : "unknown",
			costStatus: usage?.cost !== undefined ? "unpriced" : "unknown",
		};
	}
}

export function createClaudeSessionRunner(options: ClaudeSessionRunnerOptions = {}): SessionRunner {
	return new ClaudeSessionRunner(options);
}
