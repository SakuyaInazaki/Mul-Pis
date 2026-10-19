/** Bounded distillation of one candidate episode, written at an episode
 * boundary so the next session can start on a clean context without losing
 * what the previous one established.
 *
 * Everything here is derived from host records - the frozen candidate
 * decisions, the runner's compaction log and the platform gate log - never
 * from a model summary. Each field has an explicit cap, because the point of
 * the record is that it is small enough to replace a transcript. The basis
 * measures the restart as an improvement in ten of fifteen trials but does not
 * separate "summarise" from "clear the context", so this is a configured
 * option, not an unconditional behaviour. */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { writeFileAtomic } from "../workspace.ts";
import type { CandidateArchiveEntry } from "./candidate-archive.ts";
import { candidateSearchState, subjectHistory } from "./candidate-policy.ts";
import { globalCandidateBest } from "./candidate-archive.ts";
import type { CandidateStrategy } from "./candidate-policy.ts";

/** Evaluations between boundary restarts when the workspace configures none.
 * A cadence for clearing context, not a limit on how many may be run. */
export const DEFAULT_EPISODE_RESTART_EVALUATIONS = 8;

const MAX_ITEMS = 8;
const MAX_TEXT = 300;

export interface EpisodeRecordV1 {
	version: 1;
	kind: "m07-episode-record";
	runId: string;
	taskId: string;
	/** Episode index within this task: E1 is written at the first boundary. */
	episode: number;
	at: string;
	subjectId?: string;
	/** Parameter and structure facts the next session must not rediscover. */
	parameters: string[];
	boundaryRequirements: string[];
	phasePredicates: string[];
	numericConstraints: string[];
	/** Exact host failure signatures seen in this episode, deduplicated. */
	failureSignatures: string[];
	/** The verified best and the strategy family that produced it. */
	bestCandidateFamily?: { candidateRef: string; strategy?: CandidateStrategy; metric: string };
	/** Directions already measured as fruitless, with what they cost. */
	rejectedDirections: Array<{ changeKind: string; strategy?: string; location?: string;
		candidateRef: string; reason: string }>;
	/** Counts only; the complete transcript stays in the session JSONL. */
	observed: { candidates: number; promoted: number; reverted: number; excluded: number };
}

const bounded = (value: string): string => value.length > MAX_TEXT ? `${value.slice(0, MAX_TEXT - 1)}…` : value;

function unique(values: Iterable<string>, limit = MAX_ITEMS): string[] {
	const result: string[] = [];
	for (const value of values) {
		const text = bounded(value.trim());
		if (text && !result.includes(text)) result.push(text);
		if (result.length >= limit) break;
	}
	return result;
}

/** Lines a JSONL log contributes, read defensively: a missing or partly written
 * log must not stop a boundary from being recorded. */
async function jsonLines(file: string): Promise<Array<Record<string, unknown>>> {
	let text: string;
	try { text = await readFile(file, "utf8"); } catch { return []; }
	const rows: Array<Record<string, unknown>> = [];
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		try {
			const value = JSON.parse(line) as unknown;
			if (value && typeof value === "object" && !Array.isArray(value)) rows.push(value as Record<string, unknown>);
		} catch { /* A truncated final line is not an error at a boundary. */ }
	}
	return rows;
}

export interface EpisodeDistillInput {
	runId: string;
	taskId: string;
	episode: number;
	subjectId?: string;
	at: string;
	/** Same-goal candidate archive; only this task's rows are distilled. */
	history: readonly CandidateArchiveEntry[];
	/** Runner compaction log for the session that is ending, when it exists. */
	compactionLog?: string;
	/** Platform gate log for rejected contract violations, when it exists. */
	platformLog?: string;
}

export async function distillEpisode(input: EpisodeDistillInput): Promise<EpisodeRecordV1> {
	const plan = input.history.filter(entry => entry.taskId === input.taskId);
	const state = candidateSearchState(input.history, { subjectId: input.subjectId, taskId: input.taskId });
	const best = globalCandidateBest(subjectHistory(input.history, input.subjectId))[0];
	const bestEntry = best && plan.find(entry => entry.ref === best.candidateRef);
	const compaction = input.compactionLog ? await jsonLines(input.compactionLog) : [];
	const platform = input.platformLog ? await jsonLines(input.platformLog) : [];
	const signatureSources = [
		...plan.flatMap(entry => entry.policy?.failureSignature ? [entry.policy.failureSignature] : []),
		...compaction.flatMap(row => Array.isArray(row.failureSignatures)
			? (row.failureSignatures as unknown[]).filter((item): item is string => typeof item === "string") : []),
	];
	const parameters = plan.flatMap(entry => entry.changeKind === "parameters" && entry.changeSummary
		? [`${entry.ref}: ${entry.changeSummary}`] : []);
	const numericConstraints = platform.flatMap(row => typeof row.constraint === "string" ? [row.constraint] : []);
	const boundaryRequirements = platform.flatMap(row => typeof row.violation === "string" ? [row.violation] : []);
	const phasePredicates = [
		`phase=${state.phase}`,
		`route=${state.route}`,
		...(state.signals.length ? [`stall=${state.signals.join(",")}`] : []),
	];
	return { version: 1, kind: "m07-episode-record", runId: input.runId, taskId: input.taskId,
		episode: input.episode, at: input.at, ...(input.subjectId ? { subjectId: input.subjectId } : {}),
		parameters: unique(parameters), boundaryRequirements: unique(boundaryRequirements),
		phasePredicates: unique(phasePredicates), numericConstraints: unique(numericConstraints),
		failureSignatures: unique(signatureSources),
		...(best ? { bestCandidateFamily: { candidateRef: best.candidateRef,
			...(bestEntry?.strategy ? { strategy: bestEntry.strategy } : {}),
			metric: `${best.metric.name}=${best.metric.value} ${best.metric.unit} (${best.metric.basisId})` } } : {}),
		rejectedDirections: state.bannedDirections.slice(0, MAX_ITEMS).map(item => ({ changeKind: item.changeKind,
			...(item.strategy ? { strategy: item.strategy } : {}),
			...(item.location ? { location: item.location } : {}),
			candidateRef: item.candidateRef, reason: bounded(item.reason) })),
		observed: { candidates: plan.length,
			promoted: plan.filter(entry => entry.policy?.guard === "keep").length,
			reverted: plan.filter(entry => entry.policy?.guard === "revert").length,
			excluded: plan.filter(entry => entry.policy?.guard === "reject").length } };
}

export async function writeEpisodeRecord(root: string, record: EpisodeRecordV1): Promise<string> {
	const file = path.join(root, ".agent", "context", "episodes", record.runId,
		`${record.taskId}-E${record.episode}.json`);
	await writeFileAtomic(file, `${JSON.stringify(record, null, 2)}\n`);
	return file;
}

/** The whole restart message: the task's own definition plus this record. No
 * transcript, no earlier prompts, and an explicit statement of what the record
 * is - otherwise a restart reads as a fresh task with amnesia. */
export function episodeRestartMessage(taskMessage: string, record: EpisodeRecordV1): string {
	const lines = [
		`# Episode ${record.episode} restart`,
		"",
		"The previous session for this same authorized task ended at an episode boundary and its context was cleared. Everything the host established is below; the complete transcript stays archived in the session log and is not required reading. The task, its checks and the original goal are unchanged.",
		"",
		`- Candidates evaluated so far: ${record.observed.candidates} (promoted ${record.observed.promoted}, reverted ${record.observed.reverted}, pre-check rejected ${record.observed.excluded}).`,
		...(record.bestCandidateFamily
			? [`- Verified best: ${record.bestCandidateFamily.candidateRef}${record.bestCandidateFamily.strategy ? ` via ${record.bestCandidateFamily.strategy}` : ""}; ${record.bestCandidateFamily.metric}. Retrieve it with candidate_archive action=checkout rather than rewriting it from memory.`]
			: ["- No verified best yet: this subject is still in bootstrap."]),
		...(record.phasePredicates.length ? [`- State: ${record.phasePredicates.join("; ")}.`] : []),
		...(record.failureSignatures.length ? [`- Failure signatures already seen: ${record.failureSignatures.join(" | ")}.`] : []),
		...(record.parameters.length ? [`- Parameter findings: ${record.parameters.join(" | ")}.`] : []),
		...(record.numericConstraints.length ? [`- Numeric constraints: ${record.numericConstraints.join(" | ")}.`] : []),
		...(record.boundaryRequirements.length ? [`- Boundary requirements: ${record.boundaryRequirements.join(" | ")}.`] : []),
		...(record.rejectedDirections.length
			? [`- Directions already measured as fruitless: ${record.rejectedDirections.map(item => `${item.changeKind}/${item.strategy ?? "?"}@${item.location ?? "?"} (${item.candidateRef}: ${item.reason})`).join(" | ")}. Repeating one needs new evidence.`]
			: []),
		"",
		"Continue the same task from here.",
		"",
		taskMessage,
	];
	return lines.join("\n");
}
