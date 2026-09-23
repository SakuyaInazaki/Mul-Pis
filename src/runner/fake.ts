/**
 * Scripted session runner for tests. Records every boundary a stage asks for so
 * tests can assert what each session saw. No model is involved.
 */
import path from "node:path";
import { randomBytes } from "node:crypto";
import { readTextIfExists, writeFileAtomic } from "../workspace.ts";
import type { AssistantTurn, SessionHandle, SessionRef, SessionRunner, SessionSpec, ToolCallRecord, ToolResult, TranscriptMessage, UsageEvent, UsageValues } from "./types.ts";
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
	stopReason?: string;
	usage?: UsageValues;
}

export type FakeReplyFn = (ctx: FakeReplyContext) => FakeReply | string | Promise<FakeReply | string>;

interface FakeSessionState {
	spec: SessionSpec;
	ref: SessionRef;
	transcript: TranscriptMessage[];
	reads: Set<string>;
	turns: number;
	toolLog: ToolCallRecord[];
}

export class FakeSessionRunner implements SessionRunner {
	readonly sessions = new Map<string, FakeSessionState>();
	readonly created: SessionSpec[] = [];
	readonly resumed: SessionRef[] = [];
	private readonly reply: FakeReplyFn;

	constructor(reply: FakeReplyFn) {
		this.reply = reply;
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
		const state: FakeSessionState = { spec, ref, transcript: [], reads: new Set(), turns: 0, toolLog: [] };
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
			state = { spec, ref: { ...ref, model: spec.model }, transcript, reads: new Set(), turns: transcript.filter((m) => m.role === "user").length, toolLog: [] };
			this.sessions.set(ref.id, state);
		}
		if (state.spec.tools.kind === "custom" || state.spec.tools.kind === "execution" || (state.spec.tools.kind === "read-dir" && state.spec.tools.extraTools?.length)) {
			throw new Error(`fake runner: non-resumable tool session ${ref.id} cannot be resumed`);
		}
		if (ref.methodBinding && JSON.stringify(ref.methodBinding) !== JSON.stringify(state.spec.methodBinding)) throw new Error(`fake runner: method binding mismatch for ${ref.id}`);
		this.resumed.push(ref);
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
				const stopReason = reply.stopReason ?? "stop";
				if (stopReason !== "stop") throw new Error(`session ${state.ref.label} did not stop normally (stopReason=${stopReason})`);
				state.transcript.push({ role: "assistant", text: reply.text });
				await writeFileAtomic(state.ref.file!, state.transcript.map((m) => JSON.stringify(m)).join("\n") + "\n");
				outcome = "completed";
				return { text: reply.text, stopReason, toolCalls: reply.reads?.length ?? 0,
					usage: summarizeUsage([{ entryId: `${state.ref.id}-${state.turns}`, kind: "assistant", promptIndex: state.turns, at: new Date().toISOString(), usage: replyUsage, status: replyUsage && ["input", "output", "cacheRead", "cacheWrite", "totalTokens", "cost"].every((key) => Number.isFinite(replyUsage?.[key as keyof UsageValues])) ? "reported" : "unknown", costSource: replyUsage?.cost !== undefined ? "sdk-estimate" : "unknown", costStatus: replyUsage?.cost !== undefined ? "priced" : "unknown" }]) };
				} finally {
					rejectActive = undefined;
					if (aborted) outcome = "aborted";
					const event: UsageEvent = { entryId: `${state.ref.id}-${state.turns}`, kind: "assistant", promptIndex: state.turns, at: new Date().toISOString(), ...(replyUsage ? { usage: replyUsage } : {}), status: replyUsage && ["input", "output", "cacheRead", "cacheWrite", "totalTokens", "cost"].every((key) => Number.isFinite(replyUsage?.[key as keyof UsageValues])) ? "reported" : "unknown", costSource: replyUsage?.cost !== undefined ? "sdk-estimate" : "unknown", costStatus: replyUsage?.cost !== undefined ? "priced" : "unknown" };
					usageEvents.push(event);
					await import("node:fs/promises").then(({ appendFile }) => appendFile(state.ref.file!.replace(/\.jsonl$/, ".usage.jsonl"), `${JSON.stringify({ version: 1, sessionId: state.ref.id, promptIndex: state.turns, outcome, events: [event], summary: summarizeUsage([event]) })}\n`));
				}
			},
			transcript: () => [...state.transcript],
			readCoverage: () => [...state.reads].sort(),
			readReturnEvents: () => [],
			usageEvents: () => [...usageEvents],
			usageSummary: () => summarizeUsage(usageEvents),
			toolLog: () => [...state.toolLog],
			abort: async () => { aborted = true; rejectActive?.(new Error(`session ${state.ref.label} was aborted`)); },
			dispose: () => { if (disposed) return; disposed = true; rejectActive?.(new Error(`session ${state.ref.label} was disposed`)); },
		};
	}
}
