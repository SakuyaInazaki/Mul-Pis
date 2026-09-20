import { lstat, mkdir, mkdtemp, readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import {
	createAgentSession,
	createReadToolDefinition,
	DefaultResourceLoader,
	ModelRuntime,
	resolveCliModel,
	SessionManager,
	SettingsManager,
	type AgentSession,
	type CreateAgentSessionOptions,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { parseModelSpec } from "../config.ts";
import { HarnessError } from "../types.ts";
import { writeFileAtomic } from "../workspace.ts";
import type { AssistantTurn, CustomToolSpec, SessionHandle, SessionRef, SessionRunner, SessionSpec, ToolCallRecord, TranscriptMessage } from "./types.ts";

const SCRATCH_PREFIX = ".pi-session-";
const EMPTY_AGENT_DIR = ".empty-agent-dir";
const LIST_TOOL_NAME = "material_list";

type SessionLike = Pick<
	AgentSession,
	"prompt" | "messages" | "dispose" | "getActiveToolNames" | "sessionId" | "sessionFile"
>;

export interface PiSessionRunnerOptions {
	modelRuntime?: ModelRuntime;
	createSession?: typeof createAgentSession;
}

interface MaterialTools {
	tools: ToolDefinition<any, any>[];
	names: string[];
	readCoverage: Set<string>;
}

function isInside(root: string, candidate: string): boolean {
	return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

async function resolveConfinedPath(rootReal: string, requested: string): Promise<string> {
	if (!requested.trim()) throw new Error("material path must not be empty");
	const candidate = path.isAbsolute(requested) ? path.resolve(requested) : path.resolve(rootReal, requested);
	const resolved = await realpath(candidate);
	if (!isInside(rootReal, resolved)) {
		throw new Error("material path resolves outside the granted directory");
	}
	return resolved;
}

function rejectPdf(resolved: string): void {
	if (path.extname(resolved).toLowerCase() === ".pdf") {
		throw new Error("PDF reading is not supported by material_read; provide an extracted text artifact instead");
	}
}

function imageMimeType(resolved: string): string | undefined {
	const extension = path.extname(resolved).toLowerCase();
	return (
		{
			".png": "image/png",
			".jpg": "image/jpeg",
			".jpeg": "image/jpeg",
			".gif": "image/gif",
			".webp": "image/webp",
			".bmp": "image/bmp",
		} as Record<string, string>
	)[extension];
}

async function createMaterialTools(root: string, requestedReadName?: string): Promise<MaterialTools> {
	const rootReal = await realpath(root);
	const rootStat = await lstat(rootReal);
	if (!rootStat.isDirectory()) throw new HarnessError("runner.tools", `read-dir root is not a directory: ${root}`);

	const readName = requestedReadName ?? "material_read";
	if (readName === LIST_TOOL_NAME) {
		throw new HarnessError("runner.tools", `${readName} cannot be used as the read tool name because it is reserved`);
	}
	const readCoverage = new Set<string>();
	const baseRead = createReadToolDefinition(rootReal, {
		operations: {
			access: async (requested) => {
				const resolved = await resolveConfinedPath(rootReal, requested);
				rejectPdf(resolved);
				const stat = await lstat(resolved);
				if (!stat.isFile()) throw new Error(`${readName} accepts files only`);
			},
			readFile: async (requested) => {
				const resolved = await resolveConfinedPath(rootReal, requested);
				rejectPdf(resolved);
				const contents = await readFile(resolved);
				readCoverage.add(path.relative(rootReal, resolved));
				return contents;
			},
			detectImageMimeType: async (requested) => {
				const resolved = await resolveConfinedPath(rootReal, requested);
				return imageMimeType(resolved);
			},
		},
	});
	const materialRead: typeof baseRead = {
		...baseRead,
		name: readName,
		label: readName,
		// Pi normally prefers ctx.cwd over the tool factory cwd. Rebase the
		// context so relative material paths do not resolve in the empty scratch cwd.
		execute: (toolCallId, params, signal, onUpdate, ctx) =>
			baseRead.execute(
				toolCallId,
				params,
				signal,
				onUpdate,
				{ ...ctx, cwd: rootReal },
			),
	};
	const materialList: ToolDefinition<any, any> = {
		name: LIST_TOOL_NAME,
		label: LIST_TOOL_NAME,
		description: "List a directory inside the granted material directory.",
		parameters: Type.Object({ path: Type.Optional(Type.String({ description: "Material-root-relative directory" })) }),
		async execute(_toolCallId, params) {
			const resolved = await resolveConfinedPath(rootReal, (params as { path?: string }).path ?? ".");
			const stat = await lstat(resolved);
			if (!stat.isDirectory()) throw new Error(`${LIST_TOOL_NAME} accepts directories only`);
			const entries = await readdir(resolved, { withFileTypes: true });
			return {
				content: [
					{
						type: "text",
						text: entries
							.map((entry) => `${entry.isDirectory() ? "dir" : "file"}\t${entry.name}`)
							.join("\n"),
					},
				],
				details: { path: path.relative(rootReal, resolved) || "." },
			};
		},
	};
	return { tools: [materialRead, materialList], names: [readName, LIST_TOOL_NAME], readCoverage };
}

function customToolsToPi(tools: CustomToolSpec[], log: ToolCallRecord[]): ToolDefinition<any, any>[] {
	return tools.map((tool) => {
		const properties: Record<string, any> = {};
		for (const [name, param] of Object.entries(tool.params)) {
			const options = { description: param.description };
			const base =
				param.type === "string"
					? Type.String(options)
					: param.type === "number"
						? Type.Number(options)
						: param.type === "boolean"
							? Type.Boolean(options)
							: Type.Array(Type.String(), options);
			properties[name] = param.optional ? Type.Optional(base) : base;
		}
		const definition: ToolDefinition<any, any> = {
			name: tool.name,
			label: tool.name,
			description: tool.description,
			parameters: Type.Object(properties),
			async execute(_toolCallId, params) {
				const args = (params ?? {}) as Record<string, unknown>;
				const at = new Date().toISOString();
				try {
					const result = await tool.execute(args);
					log.push({ name: tool.name, args, ok: true, at });
					const content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [{ type: "text", text: result.text }];
					for (const image of result.images ?? []) {
						content.push({ type: "image", data: (await readFile(image.path)).toString("base64"), mimeType: image.mimeType });
					}
					return { content, details: result.details ?? {} };
				} catch (error) {
					log.push({ name: tool.name, args, ok: false, at, error: (error as Error).message });
					throw error;
				}
			},
		};
		return definition;
	});
}

function visibleText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((block): block is { type: "text"; text: string } => {
			const candidate = block as { type?: unknown; text?: unknown };
			return candidate.type === "text" && typeof candidate.text === "string";
		})
		.map((block) => block.text)
		.join("\n");
}

function transcriptOf(messages: readonly unknown[]): TranscriptMessage[] {
	const transcript: TranscriptMessage[] = [];
	for (const raw of messages) {
		const message = raw as { role?: unknown; content?: unknown };
		if (message.role !== "user" && message.role !== "assistant") continue;
		transcript.push({ role: message.role, text: visibleText(message.content) });
	}
	return transcript;
}

function turnResult(messages: readonly unknown[], label: string): AssistantTurn {
	const assistants = messages.filter(
		(message): message is {
			role: "assistant";
			content?: unknown;
			stopReason?: string;
			errorMessage?: string;
			usage?: { input?: number; output?: number; cost?: number | { total?: number } };
		} => (message as { role?: unknown }).role === "assistant",
	);
	const last = assistants.at(-1);
	if (!last) throw new HarnessError("runner.stop", `session ${label} produced no assistant message`);
	if (last.stopReason !== "stop") {
		const detail = last.errorMessage ? `: ${last.errorMessage}` : "";
		throw new HarnessError(
			"runner.stop",
			`session ${label} did not stop normally (stopReason=${last.stopReason ?? "missing"})${detail}`,
		);
	}
	let toolCalls = 0;
	for (const assistant of assistants) {
		if (!Array.isArray(assistant.content)) continue;
		toolCalls += assistant.content.filter((block) => (block as { type?: unknown }).type === "toolCall").length;
	}
	const rawCost = last.usage?.cost;
	const cost = typeof rawCost === "number" ? rawCost : rawCost?.total;
	return {
		text: visibleText(last.content),
		stopReason: last.stopReason,
		toolCalls,
		...(last.usage
			? { usage: { input: last.usage.input, output: last.usage.output, cost } }
			: {}),
	};
}

function specFileFor(sessionFile: string): string {
	if (!sessionFile.endsWith(".jsonl")) {
		throw new HarnessError("runner.persistence", `Pi session file is not JSONL: ${sessionFile}`);
	}
	return sessionFile.replace(/\.jsonl$/, ".spec.json");
}

function parsePersistedSpec(text: string, specFile: string): SessionSpec {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		throw new HarnessError("runner.persistence", `invalid session spec ${specFile}: ${(error as Error).message}`);
	}
	if (!parsed || typeof parsed !== "object") {
		throw new HarnessError("runner.persistence", `invalid session spec ${specFile}: expected an object`);
	}
	return parsed as SessionSpec;
}

export class PiSessionRunner implements SessionRunner {
	private readonly options: PiSessionRunnerOptions;
	private runtimePromise?: Promise<ModelRuntime>;

	constructor(options: PiSessionRunnerOptions = {}) {
		this.options = options;
	}

	async create(spec: SessionSpec): Promise<SessionHandle> {
		await mkdir(spec.persistDir, { recursive: true });
		const cwd = await mkdtemp(path.join(spec.persistDir, SCRATCH_PREFIX));
		const sessionManager = SessionManager.create(cwd, spec.persistDir);
		return this.buildHandle(spec, sessionManager, cwd, true);
	}

	async resume(ref: SessionRef): Promise<SessionHandle> {
		if (!ref.file || !ref.specFile) {
			throw new HarnessError("runner.persistence", `session ${ref.label} is missing its file or specFile`);
		}
		let specText: string;
		try {
			specText = await readFile(ref.specFile, "utf8");
		} catch (error) {
			throw new HarnessError("runner.persistence", `cannot read session spec ${ref.specFile}: ${(error as Error).message}`);
		}
		const spec = parsePersistedSpec(specText, ref.specFile);
		if (spec.tools.kind === "custom" || (spec.tools.kind === "read-dir" && spec.tools.extraTools?.length)) {
			throw new HarnessError("runner.persistence", `session ${ref.label} used harness-defined tools and cannot be resumed`);
		}
		const sessionManager = SessionManager.open(ref.file, spec.persistDir);
		const cwd = sessionManager.getCwd();
		await this.assertResumeScratch(cwd, spec.persistDir);
		return this.buildHandle(spec, sessionManager, cwd, false);
	}

	private getRuntime(): Promise<ModelRuntime> {
		this.runtimePromise ??= this.options.modelRuntime
			? Promise.resolve(this.options.modelRuntime)
			: ModelRuntime.create();
		return this.runtimePromise;
	}

	private async resolveModel(spec: SessionSpec): Promise<{
		model: NonNullable<CreateAgentSessionOptions["model"]>;
		thinkingLevel: CreateAgentSessionOptions["thinkingLevel"];
		modelRuntime: ModelRuntime;
	}> {
		try {
			const parsed = parseModelSpec(spec.model);
			const modelRuntime = await this.getRuntime();
			const resolved = resolveCliModel({ cliModel: spec.model, modelRuntime });
			if (resolved.error || !resolved.model) {
				throw new Error(resolved.error ?? `model not found: ${spec.model}`);
			}
			if (resolved.model.provider !== parsed.provider || resolved.model.id !== parsed.modelId) {
				throw new Error(
					`model resolved unexpectedly as ${resolved.model.provider}/${resolved.model.id}; expected ${parsed.provider}/${parsed.modelId}`,
				);
			}
			return { model: resolved.model, thinkingLevel: parsed.thinkingLevel, modelRuntime };
		} catch (error) {
			if (error instanceof HarnessError && error.code === "runner.model") throw error;
			throw new HarnessError("runner.model", `cannot resolve ${spec.model}: ${(error as Error).message}`);
		}
	}

	private async buildHandle(
		spec: SessionSpec,
		sessionManager: SessionManager,
		cwd: string,
		persistSpec: boolean,
	): Promise<SessionHandle> {
		const emptyAgentDir = path.join(spec.persistDir, EMPTY_AGENT_DIR);
		await mkdir(emptyAgentDir, { recursive: true });
		if ((await readdir(emptyAgentDir)).length !== 0) {
			throw new HarnessError("runner.isolation", `runner agent directory is not empty: ${emptyAgentDir}`);
		}

		const settingsManager = SettingsManager.inMemory({});
		const loader = new DefaultResourceLoader({
			cwd,
			agentDir: emptyAgentDir,
			settingsManager,
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
			systemPromptOverride: () => spec.systemPrompt,
			appendSystemPromptOverride: () => [],
		});
		await loader.reload();

		const resolved = await this.resolveModel(spec);
		let materialTools: MaterialTools = { tools: [], names: [], readCoverage: new Set() };
		const toolLog: ToolCallRecord[] = [];
		if (spec.tools.kind === "read-dir") {
			materialTools = await createMaterialTools(spec.tools.root, spec.tools.toolName);
			if (spec.tools.extraTools?.length) {
				const extra = customToolsToPi(spec.tools.extraTools, toolLog);
				materialTools = { ...materialTools, tools: [...materialTools.tools, ...extra], names: [...materialTools.names, ...extra.map((d) => d.name)] };
			}
		} else if (spec.tools.kind === "custom") {
			const definitions = customToolsToPi(spec.tools.tools, toolLog);
			materialTools = { tools: definitions, names: definitions.map((d) => d.name), readCoverage: new Set() };
		}
		const noTools = spec.tools.kind === "none" ? "all" : "builtin";
		const createSession = this.options.createSession ?? createAgentSession;
		const created = await createSession({
			cwd,
			agentDir: emptyAgentDir,
			model: resolved.model,
			thinkingLevel: resolved.thinkingLevel,
			modelRuntime: resolved.modelRuntime,
			noTools,
			tools: materialTools.names,
			...(materialTools.tools.length > 0 ? { customTools: materialTools.tools } : {}),
			resourceLoader: loader,
			sessionManager,
			settingsManager,
		});
		const session: SessionLike = created.session;
		const active = [...session.getActiveToolNames()].sort();
		const expected = [...materialTools.names].sort();
		if (active.length !== expected.length || active.some((name, index) => name !== expected[index])) {
			session.dispose();
			throw new HarnessError(
				"runner.tools",
				`unsafe active tool set for ${spec.label}: ${active.join(",") || "(empty)"}; expected ${expected.join(",") || "(empty)"}`,
			);
		}
		const sessionFile = session.sessionFile;
		if (!sessionFile) {
			session.dispose();
			throw new HarnessError("runner.persistence", `Pi did not allocate a session file for ${spec.label}`);
		}
		const specFile = specFileFor(sessionFile);
		if (persistSpec) await writeFileAtomic(specFile, `${JSON.stringify(spec, null, 2)}\n`);
		const ref: SessionRef = {
			label: spec.label,
			role: spec.role,
			id: session.sessionId,
			model: spec.model,
			file: sessionFile,
			specFile,
		};
		return {
			ref,
			prompt: async (text): Promise<AssistantTurn> => {
				const before = session.messages.length;
				await session.prompt(text);
				return turnResult(session.messages.slice(before), spec.label);
			},
			transcript: () => transcriptOf(session.messages),
			readCoverage: () => [...materialTools.readCoverage].sort(),
			toolLog: () => [...toolLog],
			dispose: () => session.dispose(),
		};
	}

	private async assertResumeScratch(cwd: string, persistDir: string): Promise<void> {
		let persistReal: string;
		let cwdReal: string;
		try {
			[persistReal, cwdReal] = await Promise.all([realpath(persistDir), realpath(cwd)]);
		} catch (error) {
			throw new HarnessError("runner.isolation", `cannot restore isolated session cwd ${cwd}: ${(error as Error).message}`);
		}
		if (!isInside(persistReal, cwdReal) || path.dirname(cwdReal) !== persistReal || !path.basename(cwdReal).startsWith(SCRATCH_PREFIX)) {
			throw new HarnessError("runner.isolation", `session cwd is outside the runner scratch boundary: ${cwd}`);
		}
		if ((await readdir(cwdReal)).length !== 0) {
			throw new HarnessError("runner.isolation", `session scratch directory is not empty: ${cwd}`);
		}
	}
}

export function createPiSessionRunner(options: PiSessionRunnerOptions = {}): PiSessionRunner {
	return new PiSessionRunner(options);
}
