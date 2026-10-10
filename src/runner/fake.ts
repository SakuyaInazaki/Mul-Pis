/**
 * Scripted session runner for tests. Records every boundary a stage asks for so
 * tests can assert what each session saw. No model is involved.
 */
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import { readTextIfExists, writeFileAtomic } from "../workspace.ts";
import type { AssistantTurn, ForkRequest, ReadReturnEvent, RunnerCapabilities, SessionCheckpoint, SessionHandle, SessionRef, SessionRunner, SessionSpec, ToolCallRecord, ToolResult, TranscriptMessage, UsageEvent, UsageValues } from "./types.ts";
import { summarizeUsage } from "./usage.ts";

export interface FakeReplyContext {
	spec: SessionSpec;
	ref: SessionRef;
	/** All user messages sent to this session so far, including the current one. */
	userMessages: string[];
	/** The message being answered. */
	message: string;
	turnIndex: number;
	/** Custom tools granted to this session; a scripted reply may call them to simulate the model. */
	tools: Record<string, (args: Record<string, unknown>) => Promise<ToolResult>>;
}

export interface FakeReply {
	text: string;
	/** Files the fake "read" through its read-dir grant (relative to root). */
	reads?: string[];
	/** Exact returned ranges for coverage-sensitive offline stage tests. */
	readReturns?: ReadReturnEvent[];
	stopReason?: string;
	usage?: UsageValues;
}

export type FakeReplyFn = (ctx: FakeReplyContext) => FakeReply | string | Promise<FakeReply | string>;

/** Offline CLI integration can install a scripted runner from trusted process
 * bootstrap code. Objective JSON and model output cannot select this factory. */
let trustedCliFakeRunnerFactory: (() => SessionRunner) | undefined;
export function registerTrustedCliFakeRunnerFactory(factory: () => SessionRunner): void {
	if (typeof factory !== "function" || trustedCliFakeRunnerFactory)
		throw new Error("trusted CLI fake runner factory is invalid or already registered");
	trustedCliFakeRunnerFactory = factory;
}
export function createTrustedCliFakeRunner(): SessionRunner | undefined {
	return trustedCliFakeRunnerFactory?.();
}

interface FakeSessionState {
	spec: SessionSpec;
	ref: SessionRef;
	transcript: TranscriptMessage[];
	reads: Set<string>;
	readReturns: ReadReturnEvent[];
	turns: number;
	toolLog: ToolCallRecord[];
	active: boolean;
	freezing: boolean;
	completed: boolean;
	disposed: boolean;
}

export class FakeSessionRunner implements SessionRunner {
	readonly sessions = new Map<string, FakeSessionState>();
	readonly created: SessionSpec[] = [];
	readonly resumed: SessionRef[] = [];
	private readonly reply: FakeReplyFn;

	constructor(reply: FakeReplyFn) {
		this.reply = reply;
	}

	capabilities(): RunnerCapabilities {
		return { version: 1, fresh: true, continue: true, persistedLineage: true, forkAtFrozenLeaf: true, grantKinds: ["none", "read-dir", "custom", "execution"], modelCompatibility: "exact-model-only", multimodalHistory: "model-dependent", parallelPromptLeases: "single-process" };
	}

	async estimateMaxSdkCost(_modelRaw: string, caps: { maxInputTokens: number; maxOutputTokens: number }): Promise<number | undefined> {
		if (!Number.isInteger(caps.maxInputTokens) || caps.maxInputTokens < 1 || !Number.isInteger(caps.maxOutputTokens) || caps.maxOutputTokens < 1) return undefined;
		return (caps.maxInputTokens + caps.maxOutputTokens) / 1_000_000;
	}

	async create(spec: SessionSpec): Promise<SessionHandle> {
		const id = `fake-${randomBytes(4).toString("hex")}`;
		const file = path.join(spec.persistDir, `${spec.label}-${id}.jsonl`);
		const specFile = file.replace(/\.jsonl$/, ".spec.json");
		await writeFileAtomic(specFile, `${JSON.stringify(spec, null, 2)}\n`);
		await writeFileAtomic(file, "");
		const ref: SessionRef = { label: spec.label, role: spec.role, id, model: spec.model, file, specFile, ...(spec.methodBinding ? { methodBinding: spec.methodBinding } : {}) };
		const state: FakeSessionState = { spec, ref, transcript: [], reads: new Set(), readReturns: [], turns: 0, toolLog: [], active: false, freezing: false, completed: false, disposed: false };
		this.sessions.set(id, state);
		this.created.push(spec);
		return this.handle(state);
	}

	async resume(ref: SessionRef): Promise<SessionHandle> {
		let state = this.sessions.get(ref.id);
		if (!state) {
			// Another process created it: rebuild from the persisted spec and transcript.
			const specText = ref.specFile ? await readTextIfExists(ref.specFile) : undefined;
			const transcriptText = ref.file ? await readTextIfExists(ref.file) : undefined;
			if (!specText || transcriptText === undefined) throw new Error(`fake runner: unknown session ${ref.id}`);
			const spec = JSON.parse(specText) as SessionSpec;
			const transcript = transcriptText
				.split(/\r?\n/)
				.filter((line) => line.trim())
				.map((line) => JSON.parse(line) as TranscriptMessage);
			state = { spec, ref: { ...ref, model: spec.model }, transcript, reads: new Set(), readReturns: [], turns: transcript.filter((m) => m.role === "user").length, toolLog: [], active: false, freezing: false, completed: transcript.at(-1)?.role === "assistant", disposed: false };
			this.sessions.set(ref.id, state);
		}
		if (state.spec.tools.kind === "custom" || state.spec.tools.kind === "execution" || (state.spec.tools.kind === "read-dir" && state.spec.tools.extraTools?.length)) {
			throw new Error(`fake runner: non-resumable tool session ${ref.id} cannot be resumed`);
		}
		if (state.ref.lineageFile || ref.lineageFile) {
			const lineageFile = state.ref.lineageFile;
			if (!lineageFile || (ref.lineageFile && ref.lineageFile !== lineageFile)) throw new Error(`fake runner: fork lineage reference differs for ${ref.id}`);
			let lineage: { state?: string; child?: { sessionId?: string; sessionFile?: string } };
			try { lineage = JSON.parse(await readFile(lineageFile, "utf8")); }
			catch { throw new Error(`fake runner: fork lineage receipt is missing for ${ref.id}`); }
			if (lineage.state !== "committed" || lineage.child?.sessionId !== ref.id || lineage.child?.sessionFile !== ref.file) throw new Error(`fake runner: fork lineage receipt is not committed for ${ref.id}`);
		}
		if (ref.methodBinding && JSON.stringify(ref.methodBinding) !== JSON.stringify(state.spec.methodBinding)) throw new Error(`fake runner: method binding mismatch for ${ref.id}`);
		this.resumed.push(ref);
		return this.handle(state);
	}

	async checkpoint(handle: SessionHandle, envelope: { inputManifest: string; runId: string; taskId?: string; externalOperationsSettled: boolean }): Promise<SessionCheckpoint> {
		const state = this.sessions.get(handle.ref.id);
		if (!state || state.ref !== handle.ref || state.active || state.freezing || state.disposed || !state.completed || state.transcript.at(-1)?.role !== "assistant") throw new Error("fake runner: checkpoint requires an idle completed parent handle");
		if (!envelope.externalOperationsSettled) throw new Error("fake runner: unknown external operations block checkpoint");
		if (!envelope.runId.trim() || !envelope.inputManifest.trim() || !(await stat(envelope.inputManifest)).isFile()) throw new Error("fake runner: frozen input manifest is missing");
		state.freezing = true;
		try {
			if (await readFile(state.ref.specFile!, "utf8") !== `${JSON.stringify(state.spec, null, 2)}\n`) throw new Error("fake runner: parent persisted spec differs from the active grant");
			const id = randomUUID();
			const snapshotDir = path.join(state.spec.persistDir, ".checkpoints");
			await mkdir(snapshotDir, { recursive: true });
			const snapshotFile = path.join(snapshotDir, `${id}.jsonl`);
			const sourceSpecSnapshot = path.join(snapshotDir, `${id}.parent-spec.json`);
			const manifestSnapshot = path.join(snapshotDir, `${id}.manifest.json`);
			await copyFile(state.ref.file!, snapshotFile);
			await copyFile(state.ref.specFile!, sourceSpecSnapshot);
			await copyFile(envelope.inputManifest, manifestSnapshot);
			const checkpoint: SessionCheckpoint = { version: 1, id, sourceSessionId: state.ref.id, sourceSessionFile: state.ref.file!, sourceSpecFile: state.ref.specFile!, sourceSpecSnapshot, snapshotFile, leafId: `${state.ref.id}-assistant-${state.turns}`, model: state.ref.model, inputManifest: envelope.inputManifest, manifestSnapshot, runId: envelope.runId, ...(envelope.taskId ? { taskId: envelope.taskId } : {}), frozenAt: new Date().toISOString(), snapshotBytes: (await stat(snapshotFile)).size };
			await writeFileAtomic(path.join(snapshotDir, `${id}.checkpoint.json`), `${JSON.stringify(checkpoint, null, 2)}\n`);
			return checkpoint;
		} finally { state.freezing = false; }
	}

	async fork(request: ForkRequest): Promise<SessionHandle> {
		const { checkpoint, evidenceBindings, reason } = request;
		const spec = request.spec;
		if (checkpoint.version !== 1 || !reason.trim() || checkpoint.model !== spec.model) throw new Error("fake runner: invalid or cross-model fork");
		const stored = JSON.parse(await readFile(path.join(path.dirname(checkpoint.snapshotFile), `${checkpoint.id}.checkpoint.json`), "utf8")) as SessionCheckpoint;
		if (JSON.stringify(stored) !== JSON.stringify(checkpoint) || (await stat(checkpoint.snapshotFile)).size !== checkpoint.snapshotBytes) throw new Error("fake runner: checkpoint receipt or snapshot changed");
		if (!(await readFile(checkpoint.inputManifest)).equals(await readFile(checkpoint.manifestSnapshot))) throw new Error("fake runner: frozen manifest changed");
		if (!(await readFile(checkpoint.sourceSpecFile)).equals(await readFile(checkpoint.sourceSpecSnapshot))) throw new Error("fake runner: parent spec changed");
		const currentSource = await readFile(checkpoint.sourceSessionFile);
		const snapshotSource = await readFile(checkpoint.snapshotFile);
		if (currentSource.length < snapshotSource.length || !currentSource.subarray(0, snapshotSource.length).equals(snapshotSource)) throw new Error("fake runner: checkpoint source history changed");
		const parentSpec = JSON.parse(await readFile(checkpoint.sourceSpecSnapshot, "utf8")) as SessionSpec;
		if (parentSpec.model !== checkpoint.model) throw new Error("fake runner: parent model differs from checkpoint");
		const parentTools = parentSpec.tools;
		const childTools = spec.tools;
		if (childTools.kind !== "none") {
			if (parentTools.kind !== childTools.kind) throw new Error("fake runner: fork cannot elevate tool authority");
			if (childTools.kind === "custom" || childTools.kind === "read-dir") throw new Error("fake runner: fork cannot elevate unaudited custom or frozen read authority");
			const sourceNames = parentTools.kind === "read-dir" ? ["material_read", "material_list", ...(parentTools.extraTools ?? []).map((tool) => tool.name)] : parentTools.kind === "execution" ? parentTools.tools : parentTools.kind === "custom" ? parentTools.tools.map((tool) => tool.name) : [];
			const targetNames: string[] = childTools.kind === "execution" ? childTools.tools : [];
			if (targetNames.some((name) => !sourceNames.includes(name))) throw new Error("fake runner: fork cannot elevate tool authority");
		}
		if (!Array.isArray(evidenceBindings) || evidenceBindings.length === 0 || evidenceBindings.some((binding) => binding.version !== 1 || binding.status !== "frozen-copy" || !binding.label.trim() || !binding.path.trim() || !binding.sourceVersion?.trim())) throw new Error("fake runner: fork requires frozen evidence bindings");
		for (const binding of evidenceBindings) await realpath(binding.path);
		if (childTools.kind === "execution") {
			const childRoot = await realpath(childTools.root);
			const overlaps = (a: string, b: string): boolean => a === b || a.startsWith(`${b}${path.sep}`) || b.startsWith(`${a}${path.sep}`);
			if (parentTools.kind === "execution") {
				const binding = request.workspaceBinding;
				const parentRoot = await realpath(parentTools.root);
				const manifest = JSON.parse(await readFile(checkpoint.manifestSnapshot, "utf8")) as { forkWorkspaceAuthority?: unknown };
				if (!binding || binding.version !== 1 || !manifest.forkWorkspaceAuthority) throw new Error("fake runner: writable fork requires frozen workspace authority");
				const { childRoot: _childRoot, ownerMarkerPath: _ownerMarkerPath, files: _files, ...authorized } = binding;
				if (JSON.stringify(manifest.forkWorkspaceAuthority) !== JSON.stringify({ ...authorized, files: binding.files.map(({ sourcePath, frozenPath, bytes }) => ({ sourcePath, frozenPath, bytes })) })) throw new Error("fake runner: workspace binding differs from frozen manifest");
				const base = await realpath(binding.authorizedChildRootBase);
				const relative = path.relative(base, childRoot).split(path.sep);
				if (binding.parentRoot !== parentRoot || binding.childRoot !== childRoot || overlaps(childRoot, parentRoot) || overlaps(childRoot, await realpath(binding.frozenEvidenceRoot)) || relative.length !== 2 || relative[1] !== binding.childWorkLeaf || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(relative[0])) throw new Error("fake runner: child root is not an independent authorized task work root");
				const owner = JSON.parse(await readFile(binding.ownerMarkerPath, "utf8")) as { checkpointId?: string; childRoot?: string; parentRoot?: string; childContainer?: string };
				if (binding.ownerMarkerPath !== path.join(childRoot, "fork-owner.json") || owner.checkpointId !== checkpoint.id || owner.childRoot !== childRoot || owner.parentRoot !== parentRoot || owner.childContainer !== relative[0]) throw new Error("fake runner: child work owner marker differs from checkpoint");
				for (const file of binding.files) if (!(await readFile(file.frozenPath)).equals(await readFile(file.childPath))) throw new Error("fake runner: child work file differs from frozen source");
			}
			for (const binding of evidenceBindings) if (overlaps(childRoot, await realpath(binding.path))) throw new Error("fake runner: frozen evidence must be outside child writable root");
		}
		const source = (await readFile(checkpoint.snapshotFile, "utf8")).split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as TranscriptMessage);
		if (source.at(-1)?.role !== "assistant" || checkpoint.leafId !== `${checkpoint.sourceSessionId}-assistant-${source.filter((m) => m.role === "user").length}`) throw new Error("fake runner: checkpoint leaf changed");
		await mkdir(spec.persistDir, { recursive: true });
		const childScratch = await mkdtemp(path.join(spec.persistDir, ".pi-session-"));
		const id = `fake-${randomBytes(4).toString("hex")}`;
		const file = path.join(spec.persistDir, `${spec.label}-${id}.jsonl`);
		const specFile = file.replace(/\.jsonl$/, ".spec.json");
		const lineageFile = file.replace(/\.jsonl$/, ".lineage.json");
		const ref: SessionRef = { label: spec.label, role: spec.role, id, model: spec.model, file, specFile, lineageFile, ...(spec.methodBinding ? { methodBinding: spec.methodBinding } : {}) };
		try {
			await writeFileAtomic(file, `${source.map((m) => JSON.stringify(m)).join("\n")}\n`);
			await writeFileAtomic(specFile, `${JSON.stringify(spec, null, 2)}\n`);
			await writeFileAtomic(lineageFile, `${JSON.stringify({ version: 1, state: "committed", intent: "branch-exploration", checkpoint, parent: { sessionId: checkpoint.sourceSessionId, sessionFile: checkpoint.sourceSessionFile, leafId: checkpoint.leafId, toolGrantKind: parentTools.kind }, child: { sessionId: id, sessionFile: file, scratch: childScratch, toolGrantKind: childTools.kind, ...(spec.tools.kind === "execution" ? { workRoot: spec.tools.root } : {}) }, reason, evidenceBindings, workspaceBinding: request.workspaceBinding, inheritedUsageBilled: false, createdAt: new Date().toISOString() }, null, 2)}\n`);
		} catch (error) { await Promise.all([rm(file, { force: true }), rm(specFile, { force: true }), rm(lineageFile, { force: true }), rm(childScratch, { recursive: true, force: true })]); throw error; }
		const state: FakeSessionState = { spec, ref, transcript: source, reads: new Set(), readReturns: [], turns: source.filter((m) => m.role === "user").length, toolLog: [], active: false, freezing: false, completed: false, disposed: false };
		this.sessions.set(id, state);
		this.created.push(spec);
		return this.handle(state);
	}

	private handle(state: FakeSessionState): SessionHandle {
		const usageEvents: UsageEvent[] = [];
		let disposed = false;
		let aborted = false;
		let rejectActive: ((error: Error) => void) | undefined;
		return {
			ref: state.ref,
			prompt: async (text: string): Promise<AssistantTurn> => {
				if (disposed || aborted) throw new Error(`session ${state.ref.label} was aborted or disposed`);
				if (state.freezing || state.active) throw new Error(`session ${state.ref.label} is active or being checkpointed`);
				state.active = true;
				state.completed = false;
				state.transcript.push({ role: "user", text });
				state.turns += 1;
				let outcome: "completed" | "failed" | "aborted" = "failed";
				let replyUsage: UsageValues | undefined;
				try {
				const tools: FakeReplyContext["tools"] = {};
				const granted = state.spec.tools.kind === "custom" ? state.spec.tools.tools : state.spec.tools.kind === "read-dir" ? (state.spec.tools.extraTools ?? []) : [];
				{
					for (const tool of granted) {
						tools[tool.name] = async (args) => {
							const at = new Date().toISOString();
							try {
								const result = await tool.execute(args);
								state.toolLog.push({ name: tool.name, args, ok: true, at });
								return result;
							} catch (error) {
								state.toolLog.push({ name: tool.name, args, ok: false, at, error: (error as Error).message });
								throw error;
							}
						};
					}
				}
				const raw = await Promise.race([this.reply({
					spec: state.spec,
					ref: state.ref,
					userMessages: state.transcript.filter((m) => m.role === "user").map((m) => m.text),
					message: text,
					turnIndex: state.turns,
					tools,
				}), new Promise<never>((_resolve, reject) => { rejectActive = reject; })]);
				const reply: FakeReply = typeof raw === "string" ? { text: raw } : raw;
				replyUsage = reply.usage;
				for (const r of reply.reads ?? []) state.reads.add(r);
				state.readReturns.push(...(reply.readReturns ?? []));
				const stopReason = reply.stopReason ?? "stop";
				if (stopReason !== "stop") throw new Error(`session ${state.ref.label} did not stop normally (stopReason=${stopReason})`);
				state.transcript.push({ role: "assistant", text: reply.text });
				await writeFileAtomic(state.ref.file!, state.transcript.map((m) => JSON.stringify(m)).join("\n") + "\n");
				outcome = "completed";
				state.completed = true;
				return { text: reply.text, stopReason, toolCalls: reply.reads?.length ?? 0,
					usage: summarizeUsage([{ entryId: `${state.ref.id}-${state.turns}`, kind: "assistant", promptIndex: state.turns, at: new Date().toISOString(), usage: replyUsage, status: replyUsage && ["input", "output", "cacheRead", "cacheWrite", "totalTokens"].every((key) => Number.isFinite(replyUsage?.[key as keyof UsageValues])) ? "reported" : "unknown", costSource: replyUsage?.cost !== undefined ? "sdk-estimate" : "unknown", costStatus: replyUsage?.cost !== undefined ? "priced" : "unknown" }]) };
				} finally {
					rejectActive = undefined;
					state.active = false;
					if (aborted) outcome = "aborted";
					const event: UsageEvent = { entryId: `${state.ref.id}-${state.turns}`, kind: "assistant", promptIndex: state.turns, at: new Date().toISOString(), ...(replyUsage ? { usage: replyUsage } : {}), status: replyUsage && ["input", "output", "cacheRead", "cacheWrite", "totalTokens"].every((key) => Number.isFinite(replyUsage?.[key as keyof UsageValues])) ? "reported" : "unknown", costSource: replyUsage?.cost !== undefined ? "sdk-estimate" : "unknown", costStatus: replyUsage?.cost !== undefined ? "priced" : "unknown" };
					usageEvents.push(event);
					await import("node:fs/promises").then(({ appendFile }) => appendFile(state.ref.file!.replace(/\.jsonl$/, ".usage.jsonl"), `${JSON.stringify({ version: 1, sessionId: state.ref.id, promptIndex: state.turns, outcome, events: [event], summary: summarizeUsage([event]) })}\n`));
				}
			},
			transcript: () => [...state.transcript],
			readCoverage: () => [...state.reads].sort(),
			readReturnEvents: () => [...state.readReturns],
			usageEvents: () => [...usageEvents],
			usageSummary: () => summarizeUsage(usageEvents),
			toolLog: () => [...state.toolLog],
			abort: async () => { aborted = true; rejectActive?.(new Error(`session ${state.ref.label} was aborted`)); },
			dispose: () => { if (disposed) return; disposed = true; state.disposed = true; rejectActive?.(new Error(`session ${state.ref.label} was disposed`)); },
		};
	}
}
