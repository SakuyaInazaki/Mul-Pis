/**
 * Scripted session runner for tests. Records every boundary a stage asks for so
 * tests can assert what each session saw. No model is involved.
 */
import path from "node:path";
import { randomBytes } from "node:crypto";
import { readTextIfExists, writeFileAtomic } from "../workspace.ts";
import type { AssistantTurn, SessionHandle, SessionRef, SessionRunner, SessionSpec, ToolCallRecord, ToolResult, TranscriptMessage } from "./types.ts";

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

	async create(spec: SessionSpec): Promise<SessionHandle> {
		const id = `fake-${randomBytes(4).toString("hex")}`;
		const file = path.join(spec.persistDir, `${spec.label}-${id}.jsonl`);
		const specFile = file.replace(/\.jsonl$/, ".spec.json");
		await writeFileAtomic(specFile, `${JSON.stringify(spec, null, 2)}\n`);
		await writeFileAtomic(file, "");
		const ref: SessionRef = { label: spec.label, role: spec.role, id, model: spec.model, file, specFile };
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
			if (spec.tools.kind === "custom") throw new Error(`fake runner: custom-tool session ${ref.id} cannot be resumed`);
			state = { spec, ref: { ...ref, model: spec.model }, transcript, reads: new Set(), turns: transcript.filter((m) => m.role === "user").length, toolLog: [] };
			this.sessions.set(ref.id, state);
		}
		this.resumed.push(ref);
		return this.handle(state);
	}

	private handle(state: FakeSessionState): SessionHandle {
		return {
			ref: state.ref,
			prompt: async (text: string): Promise<AssistantTurn> => {
				state.transcript.push({ role: "user", text });
				state.turns += 1;
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
				const raw = await this.reply({
					spec: state.spec,
					ref: state.ref,
					userMessages: state.transcript.filter((m) => m.role === "user").map((m) => m.text),
					message: text,
					turnIndex: state.turns,
					tools,
				});
				const reply: FakeReply = typeof raw === "string" ? { text: raw } : raw;
				for (const r of reply.reads ?? []) state.reads.add(r);
				const stopReason = reply.stopReason ?? "stop";
				if (stopReason !== "stop") throw new Error(`session ${state.ref.label} did not stop normally (stopReason=${stopReason})`);
				state.transcript.push({ role: "assistant", text: reply.text });
				await writeFileAtomic(state.ref.file!, state.transcript.map((m) => JSON.stringify(m)).join("\n") + "\n");
				return { text: reply.text, stopReason, toolCalls: reply.reads?.length ?? 0 };
			},
			transcript: () => [...state.transcript],
			readCoverage: () => [...state.reads].sort(),
			toolLog: () => [...state.toolLog],
			dispose: () => {},
		};
	}
}
