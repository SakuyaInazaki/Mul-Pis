/**
 * Append-only search event log.
 *
 * Control state for a search was written as whole files that each save
 * overwrites, so a crash could lose a round of structure rather than the last
 * write, and nothing could be reconstructed independently of the writer. This
 * log is the opposite: every participant appends single JSON lines and never
 * rewrites, so the state is a function of the events and two processes writing
 * at once cannot lose each other's work.
 *
 * Ordering is explicit rather than global. Each writer stamps its own monotonic
 * sequence, and readers sort by (timestamp, writer, sequence), which is a total
 * order that does not require a lock on the shared file. Counters are expressed
 * in rounds, because a token or wall-clock figure stops being comparable the
 * moment the model or the machine changes.
 */
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";

export type SearchEventKind =
	| "task-started" | "task-finished"
	| "candidate-submitted" | "candidate-stage" | "candidate-evaluated"
	| "verdict" | "stall" | "budget"
	| "background-queued" | "background-settled"
	| "context-compacted" | "episode-restarted" | "warm-start";

export interface SearchCandidateFactsV1 {
	id: string;
	parentId?: string;
	subjectId?: string;
	/** Host-decided ranking signal when one exists; never invented by this log. */
	score?: number;
	isBuggy?: boolean;
	/** Where the evidence for this candidate lives, relative to the workspace or absolute. */
	pathRef?: string;
	stage?: string;
	status?: string;
}

export interface SearchEventV1 {
	version: 1;
	/** Monotonic per writer. (at, writer, seq) is the total order. */
	seq: number;
	writer: string;
	at: string;
	runId: string;
	taskId?: string;
	kind: SearchEventKind;
	/** Rounds, not tokens or seconds: the only budget unit that survives a model change. */
	round?: number;
	candidate?: SearchCandidateFactsV1;
	verdict?: { decision: "accept" | "keep" | "reject" | "revert"; reason?: string };
	counters?: Record<string, number>;
	detail?: Record<string, string | number | boolean>;
}

export type SearchEventInput = Omit<SearchEventV1, "version" | "seq" | "writer" | "at"> & { at?: string };

const KINDS = new Set<string>([
	"task-started", "task-finished", "candidate-submitted", "candidate-stage", "candidate-evaluated",
	"verdict", "stall", "budget", "background-queued", "background-settled",
	"context-compacted", "episode-restarted", "warm-start",
]);
const DECISIONS = new Set(["accept", "keep", "reject", "revert"]);
const NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
/** One line must stay one write; oversized detail is trimmed rather than split. */
const MAX_LINE_BYTES = 8_192;
const MAX_DETAIL_ENTRIES = 24;

function short(value: unknown, limit: number): string | undefined {
	if (typeof value !== "string") return undefined;
	const text = value.replace(/[\r\n\0]+/g, " ").trim();
	if (!text) return undefined;
	return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}

function finite(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function boundedDetail(detail: Record<string, string | number | boolean> | undefined): Record<string, string | number | boolean> | undefined {
	if (!detail) return undefined;
	const entries = Object.entries(detail).slice(0, MAX_DETAIL_ENTRIES);
	const bounded: Record<string, string | number | boolean> = {};
	for (const [key, value] of entries) {
		if (!NAME.test(key)) continue;
		if (typeof value === "boolean") bounded[key] = value;
		else if (typeof value === "number") { const number = finite(value); if (number !== undefined) bounded[key] = number; }
		else { const text = short(value, 400); if (text !== undefined) bounded[key] = text; }
	}
	return Object.keys(bounded).length ? bounded : undefined;
}

function normalizeCandidate(candidate: SearchCandidateFactsV1 | undefined): SearchCandidateFactsV1 | undefined {
	if (!candidate) return undefined;
	const id = short(candidate.id, 128);
	if (!id) return undefined;
	return {
		id,
		...(short(candidate.parentId, 128) ? { parentId: short(candidate.parentId, 128)! } : {}),
		...(short(candidate.subjectId, 128) ? { subjectId: short(candidate.subjectId, 128)! } : {}),
		...(finite(candidate.score) !== undefined ? { score: finite(candidate.score)! } : {}),
		...(candidate.isBuggy === undefined ? {} : { isBuggy: candidate.isBuggy === true }),
		...(short(candidate.pathRef, 1_024) ? { pathRef: short(candidate.pathRef, 1_024)! } : {}),
		...(short(candidate.stage, 128) ? { stage: short(candidate.stage, 128)! } : {}),
		...(short(candidate.status, 128) ? { status: short(candidate.status, 128)! } : {}),
	};
}

function counters(value: Record<string, number> | undefined): Record<string, number> | undefined {
	if (!value) return undefined;
	const bounded: Record<string, number> = {};
	for (const [key, number] of Object.entries(value).slice(0, MAX_DETAIL_ENTRIES)) {
		const safe = finite(number);
		if (safe !== undefined && NAME.test(key)) bounded[key] = safe;
	}
	return Object.keys(bounded).length ? bounded : undefined;
}

export interface SearchEventLog {
	readonly file: string;
	readonly writer: string;
	append(event: SearchEventInput): Promise<SearchEventV1>;
}

export interface SearchEventLogOptions {
	/** Stable identity of this writer; defaults to pid plus a per-open nonce. */
	writer?: string;
	now?: () => number;
}

/**
 * Open a log for appending. Opening never reads or rewrites the file, so any
 * number of processes may hold it at once.
 */
export function openSearchEventLog(file: string, options: SearchEventLogOptions = {}): SearchEventLog {
	const writer = options.writer ?? `${process.pid.toString(36)}-${randomUUID().slice(0, 8)}`;
	const now = options.now ?? (() => Date.now());
	let seq = 0;
	// Appends from this process are queued so sequence numbers stay monotonic
	// and one line is always written by one call.
	let tail: Promise<void> = Promise.resolve();
	return {
		file, writer,
		append(input) {
			const next = tail.then(async () => {
				if (!KINDS.has(input.kind)) throw new Error(`unknown search event kind: ${input.kind}`);
				if (input.verdict && !DECISIONS.has(input.verdict.decision)) throw new Error("unknown search verdict decision");
				const event: SearchEventV1 = {
					version: 1, seq: ++seq, writer, at: input.at ?? new Date(now()).toISOString(),
					runId: short(input.runId, 128) ?? "unknown", kind: input.kind,
					...(short(input.taskId, 128) ? { taskId: short(input.taskId, 128)! } : {}),
					...(finite(input.round) !== undefined ? { round: finite(input.round)! } : {}),
					...(normalizeCandidate(input.candidate) ? { candidate: normalizeCandidate(input.candidate)! } : {}),
					...(input.verdict ? { verdict: { decision: input.verdict.decision,
						...(short(input.verdict.reason, 400) ? { reason: short(input.verdict.reason, 400)! } : {}) } } : {}),
					...(counters(input.counters) ? { counters: counters(input.counters)! } : {}),
					...(boundedDetail(input.detail) ? { detail: boundedDetail(input.detail)! } : {}),
				};
				let line = `${JSON.stringify(event)}\n`;
				if (Buffer.byteLength(line, "utf8") > MAX_LINE_BYTES) {
					delete event.detail;
					line = `${JSON.stringify({ ...event, detail: { trimmed: true } })}\n`;
				}
				await mkdir(path.dirname(file), { recursive: true });
				await appendFile(file, line, "utf8");
				return event;
			});
			tail = next.then(() => undefined, () => undefined);
			return next;
		},
	};
}

export interface SearchEventReadV1 {
	events: SearchEventV1[];
	/** Lines that could not be used: a crash-truncated tail, or a foreign shape. */
	skipped: number;
}

function parse(line: string): SearchEventV1 | undefined {
	let value: unknown;
	try { value = JSON.parse(line) as unknown; } catch { return undefined; }
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const row = value as Partial<SearchEventV1>;
	if (row.version !== 1 || typeof row.seq !== "number" || !Number.isSafeInteger(row.seq) ||
		typeof row.writer !== "string" || !row.writer || typeof row.at !== "string" ||
		Number.isNaN(Date.parse(row.at)) || typeof row.runId !== "string" || !row.runId ||
		typeof row.kind !== "string" || !KINDS.has(row.kind)) return undefined;
	return row as SearchEventV1;
}

/** Read the whole log. A partially written final line is reported, never guessed at. */
export async function readSearchEvents(file: string): Promise<SearchEventReadV1> {
	let text: string;
	try { text = await readFile(file, "utf8"); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { events: [], skipped: 0 };
		throw error;
	}
	const events: SearchEventV1[] = [];
	let skipped = 0;
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		const event = parse(line);
		if (event) events.push(event); else skipped++;
	}
	events.sort((left, right) => left.at.localeCompare(right.at) || left.writer.localeCompare(right.writer) || left.seq - right.seq);
	return { events, skipped };
}
