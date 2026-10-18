/**
 * Search state rebuilt from the event log.
 *
 * Every function here is pure: the same events always produce the same state,
 * so a console can redraw the whole tree, a restarted process can continue from
 * the log alone, and an audit can be repeated without the writer being present.
 * Nothing in this module reads or writes files.
 */
import type { SearchCandidateFactsV1, SearchEventV1 } from "./events.ts";

export interface SearchCandidateNodeV1 {
	id: string;
	parentId?: string;
	subjectId?: string;
	/** Last host-decided score seen for this candidate. */
	score?: number;
	isBuggy: boolean;
	pathRef?: string;
	status?: string;
	verdict?: { decision: "accept" | "keep" | "reject" | "revert"; reason?: string };
	firstSeen: string;
	lastSeen: string;
	/** Stage outcomes in order, which is where compile/correctness/measurement time goes. */
	stages: Array<{ stage: string; status?: string; at: string }>;
	events: number;
}

export interface SearchTaskNodeV1 {
	taskId: string;
	startedAt?: string;
	finishedAt?: string;
	rounds: number;
	candidates: string[];
}

export interface SearchStateV1 {
	runId: string;
	candidates: SearchCandidateNodeV1[];
	tasks: SearchTaskNodeV1[];
	/** Last value seen per counter name; counters are cumulative at the writer. */
	counters: Record<string, number>;
	/** Highest round observed, which is the budget unit the basis asks for. */
	rounds: number;
	stalls: number;
	backgroundQueued: number;
	backgroundSettled: number;
	platforms: Array<{ id: string; chip: string; toolchain: string }>;
	events: number;
}

function node(id: string, at: string): SearchCandidateNodeV1 {
	return { id, isBuggy: false, firstSeen: at, lastSeen: at, stages: [], events: 0 };
}

function applyCandidate(target: SearchCandidateNodeV1, facts: SearchCandidateFactsV1, at: string, kind: SearchEventV1["kind"]): void {
	target.lastSeen = at;
	target.events++;
	if (facts.parentId !== undefined) target.parentId = facts.parentId;
	if (facts.subjectId !== undefined) target.subjectId = facts.subjectId;
	if (facts.score !== undefined) target.score = facts.score;
	if (facts.isBuggy !== undefined) target.isBuggy = facts.isBuggy;
	if (facts.pathRef !== undefined) target.pathRef = facts.pathRef;
	if (facts.status !== undefined) target.status = facts.status;
	if (kind === "candidate-stage" && facts.stage !== undefined)
		target.stages.push({ stage: facts.stage, ...(facts.status !== undefined ? { status: facts.status } : {}), at });
}

/** Fold the ordered events into the state they describe. */
export function rebuildSearchState(runId: string, events: readonly SearchEventV1[]): SearchStateV1 {
	const candidates = new Map<string, SearchCandidateNodeV1>();
	const tasks = new Map<string, SearchTaskNodeV1>();
	const platforms = new Map<string, { id: string; chip: string; toolchain: string }>();
	const counters: Record<string, number> = {};
	const state: SearchStateV1 = { runId, candidates: [], tasks: [], counters, rounds: 0, stalls: 0,
		backgroundQueued: 0, backgroundSettled: 0, platforms: [], events: 0 };
	for (const event of events) {
		if (event.runId !== runId) continue;
		state.events++;
		if (event.round !== undefined && event.round > state.rounds) state.rounds = event.round;
		if (event.counters) for (const [key, value] of Object.entries(event.counters)) counters[key] = value;
		if (event.platform) platforms.set(`${event.platform.id}\0${event.platform.chip}\0${event.platform.toolchain}`, event.platform);
		if (event.kind === "stall") state.stalls++;
		if (event.kind === "background-queued") state.backgroundQueued++;
		if (event.kind === "background-settled") state.backgroundSettled++;
		if (event.taskId) {
			const task = tasks.get(event.taskId) ?? { taskId: event.taskId, rounds: 0, candidates: [] };
			if (event.kind === "task-started" && !task.startedAt) task.startedAt = event.at;
			if (event.kind === "task-finished") task.finishedAt = event.at;
			if (event.round !== undefined && event.round > task.rounds) task.rounds = event.round;
			tasks.set(event.taskId, task);
		}
		if (!event.candidate) continue;
		const existing = candidates.get(event.candidate.id) ?? node(event.candidate.id, event.at);
		applyCandidate(existing, event.candidate, event.at, event.kind);
		if (event.verdict) existing.verdict = event.verdict;
		candidates.set(event.candidate.id, existing);
		if (event.taskId) {
			const task = tasks.get(event.taskId);
			if (task && !task.candidates.includes(event.candidate.id)) task.candidates.push(event.candidate.id);
		}
	}
	state.candidates = [...candidates.values()];
	state.tasks = [...tasks.values()];
	state.platforms = [...platforms.values()];
	return state;
}

export function searchCandidate(state: SearchStateV1, id: string): SearchCandidateNodeV1 | undefined {
	return state.candidates.find(item => item.id === id);
}

/** Parents first, closest last. A cycle stops the walk instead of hanging. */
export function candidateAncestors(state: SearchStateV1, id: string): SearchCandidateNodeV1[] {
	const chain: SearchCandidateNodeV1[] = [];
	const seen = new Set<string>([id]);
	let current = searchCandidate(state, id)?.parentId;
	while (current && !seen.has(current)) {
		seen.add(current);
		const parent = searchCandidate(state, current);
		if (!parent) break;
		chain.unshift(parent);
		current = parent.parentId;
	}
	return chain;
}

export function candidateSiblings(state: SearchStateV1, id: string): SearchCandidateNodeV1[] {
	const self = searchCandidate(state, id);
	if (!self) return [];
	return state.candidates.filter(item => item.id !== id && item.parentId === self.parentId);
}

export function candidateChildren(state: SearchStateV1, id: string): SearchCandidateNodeV1[] {
	return state.candidates.filter(item => item.parentId === id);
}

export interface SearchBestOptions {
	subjectId?: string;
	limit?: number;
	/** Include candidates the host marked buggy; off by default. */
	includeBuggy?: boolean;
}

/**
 * Highest scored candidates first. Only candidates that carry a host-decided
 * score are ranked: an unscored candidate is unknown, not average.
 */
export function bestCandidates(state: SearchStateV1, options: SearchBestOptions = {}): SearchCandidateNodeV1[] {
	const limit = options.limit ?? 8;
	return state.candidates
		.filter(item => item.score !== undefined && (options.includeBuggy || !item.isBuggy) &&
			(!options.subjectId || item.subjectId === options.subjectId))
		.sort((left, right) => (right.score ?? 0) - (left.score ?? 0) || left.id.localeCompare(right.id))
		.slice(0, Math.max(1, limit));
}

/** A compact projection for a console or a report: the tree plus its counters. */
export function searchStateSummary(state: SearchStateV1): {
	runId: string; rounds: number; stalls: number; events: number;
	candidates: number; buggy: number; scored: number; tasks: number;
	background: { queued: number; settled: number; outstanding: number };
	platforms: Array<{ id: string; chip: string; toolchain: string }>;
	counters: Record<string, number>;
} {
	return {
		runId: state.runId, rounds: state.rounds, stalls: state.stalls, events: state.events,
		candidates: state.candidates.length,
		buggy: state.candidates.filter(item => item.isBuggy).length,
		scored: state.candidates.filter(item => item.score !== undefined).length,
		tasks: state.tasks.length,
		background: { queued: state.backgroundQueued, settled: state.backgroundSettled,
			outstanding: Math.max(0, state.backgroundQueued - state.backgroundSettled) },
		platforms: state.platforms, counters: state.counters,
	};
}
