import type { ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { summarizeUsage, usageEventsFromEntries } from "../runner/usage.ts";
import type { UsageEvent } from "../runner/types.ts";

type UsageContext = Pick<ExtensionContext, "cwd" | "sessionManager" | "model">;
type Phase = "session-start" | "session-switch" | "agent-end" | "session-shutdown";

interface LedgerRow {
	version: 1;
	classification: "pi-main-orchestration";
	sessionId: string;
	phase: Phase;
	at: string;
	promptIndex: number;
	processedEntryIds: string[];
	events: UsageEvent[];
	summary: ReturnType<typeof summarizeUsage>;
	/** This is an SDK-visible estimate, never a provider invoice or Codex development cost. */
	accountingScope: "sdk-visible-session-entries";
}

interface BoundSession {
	id: string;
	cwd: string;
	file: string;
	ctx: UsageContext;
	seen: Set<string>;
	events: UsageEvent[];
	promptIndex: number;
	pendingAgent: boolean;
}

function safeSessionId(id: string): string {
	return id.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function priceKnown(ctx: UsageContext, event: UsageEvent): boolean {
	const model = ctx.model;
	return !!model && model.cost.input > 0 && model.cost.output > 0 &&
		(!event.model || event.model === model.id) && (!event.provider || event.provider === model.provider);
}

/**
 * Content-free ledger for the Pi controller itself. Child-role sessions have
 * separate runner ledgers. No hook can observe provider usage that Pi omitted.
 */
export function createMainUsageLedger() {
	let bound: BoundSession | undefined;
	let queue = Promise.resolve();
	const serialize = (operation: () => Promise<void>): Promise<void> => {
		const work = queue.then(operation);
		queue = work.catch(() => undefined);
		return work;
	};

	async function bind(ctx: UsageContext): Promise<BoundSession | undefined> {
		const id = ctx.sessionManager.getSessionId();
		if (!id || !existsSync(path.join(ctx.cwd, ".agent"))) return undefined;
		const file = path.join(ctx.cwd, ".agent", "telemetry", `pi-main-usage-${safeSessionId(id)}.jsonl`);
		if (bound?.id === id && bound.file === file) {
			bound.ctx = ctx;
			return bound;
		}
		const next: BoundSession = { id, cwd: ctx.cwd, file, ctx, seen: new Set(), events: [], promptIndex: 0, pendingAgent: false };
		// A cwd switch within this process retains the entry watermark. The new
		// workspace ledger then contains only newly observed entries.
		if (bound?.id === id) next.seen = new Set(bound.seen);
		try {
			const previous = await readFile(file, "utf8");
			for (const line of previous.split(/\r?\n/)) {
				if (!line) continue;
				const row = JSON.parse(line) as LedgerRow;
				if (row.version !== 1 || row.sessionId !== id || !Array.isArray(row.processedEntryIds) || !Array.isArray(row.events)) {
					throw new Error(`invalid Pi main usage ledger: ${file}`);
				}
				for (const entryId of row.processedEntryIds) next.seen.add(entryId);
				next.events.push(...row.events);
				next.promptIndex = Math.max(next.promptIndex, row.promptIndex);
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		bound = next;
		return next;
	}

	async function flush(state: BoundSession, phase: Phase): Promise<void> {
		const entries = state.ctx.sessionManager.getEntries() as SessionEntry[];
		const fresh = entries.filter((entry) => !state.seen.has(entry.id));
		const promptIndex = state.promptIndex;
		const events = usageEventsFromEntries(fresh, promptIndex, false).map((event) => {
			if (event.costStatus === "unknown" || event.usage?.cost === undefined) return event;
			return { ...event, costStatus: priceKnown(state.ctx, event) ? "priced" as const : "unknown" as const };
		});
		if ((phase === "agent-end" || phase === "session-switch" || phase === "session-shutdown") && state.pendingAgent && !events.some((event) => event.kind === "assistant")) {
			events.push({ entryId: `main-unobserved-${state.id}-${promptIndex}`, kind: "assistant", promptIndex, at: new Date().toISOString(), status: "unknown", costSource: "unknown", costStatus: "unknown" });
		}
		if (!fresh.length && !events.length) return;
		const row: LedgerRow = {
			version: 1, classification: "pi-main-orchestration", sessionId: state.id,
			phase, at: new Date().toISOString(), promptIndex,
			processedEntryIds: fresh.map((entry) => entry.id), events,
			summary: summarizeUsage([...state.events, ...events]), accountingScope: "sdk-visible-session-entries",
		};
		await mkdir(path.dirname(state.file), { recursive: true });
		await appendFile(state.file, `${JSON.stringify(row)}\n`);
		for (const entry of fresh) state.seen.add(entry.id);
		state.events.push(...events);
		if (phase !== "session-start") state.pendingAgent = false;
	}

	return {
		sessionStart: (ctx: UsageContext) => serialize(async () => {
			if (bound && (bound.id !== ctx.sessionManager.getSessionId() || bound.cwd !== ctx.cwd)) await flush(bound, "session-switch");
			const state = await bind(ctx);
			if (state) await flush(state, "session-start");
		}),
		agentStart: (ctx: UsageContext) => serialize(async () => { const state = await bind(ctx); if (state) { state.promptIndex++; state.pendingAgent = true; } }),
		agentEnd: (ctx: UsageContext) => serialize(async () => { const state = await bind(ctx); if (state) await flush(state, "agent-end"); }),
		sessionShutdown: (ctx: UsageContext) => serialize(async () => { const state = await bind(ctx); if (state) await flush(state, "session-shutdown"); }),
	};
}
