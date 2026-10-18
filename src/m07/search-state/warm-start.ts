/**
 * Cross-session warm start.
 *
 * A new variant of an operator that was already optimised in an earlier run
 * should not begin from nothing: the earlier run's best verified implementation
 * and the evidence behind it are on disk, and finding them costs one directory
 * scan. What this module returns is a set of leads — a candidate reference, the
 * metric that made it best, and the exact paths to its frozen evidence — never
 * a claim that the old result still holds.
 *
 * A measurement only means something on the chip and toolchain that produced
 * it, so a lead from a different platform is reported as not comparable rather
 * than silently reused, and a lead from a run that never recorded its platform
 * is reported as unknown.
 */
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { candidateArchive, globalCandidateBest } from "../candidate-archive.ts";
import type { CandidateMetricV1, CurrentGoal } from "../types.ts";
import { readSearchEvents } from "./events.ts";

export interface WarmStartLeadV1 {
	runId: string;
	taskId: string;
	candidateRef: string;
	subjectId?: string;
	metric: CandidateMetricV1;
	correctness: "passed" | "failed" | "unknown";
	/** Frozen host observation for this candidate. */
	observationPath: string;
	/** Task work directory the candidate was produced in. */
	workDir: string;
	sourcePaths: string[];
	platform?: { id: string; chip: string; toolchain: string };
	/** False when the platform differs from the requested one or was never recorded. */
	comparable: boolean;
}

export interface WarmStartQueryV1 {
	/** Directory holding one subdirectory per M07 run, usually `<workspace>/stages/M07`. */
	m07Dir: string;
	/** The run being planned now; its own history is not a prior run. */
	excludeRunId?: string;
	subjectId?: string;
	/** Current target platform; leads from another chip or toolchain are marked incomparable. */
	platform?: { chip: string; toolchain: string };
	/** Report leads that are not comparable instead of dropping them. */
	includeIncomparable?: boolean;
	limit?: number;
	maxRuns?: number;
}

export interface WarmStartResultV1 {
	leads: WarmStartLeadV1[];
	scannedRuns: number;
	/** Runs whose goal file was absent, unreadable or of a foreign shape. */
	skippedRuns: number;
	/** Leads dropped because they came from another platform or an unrecorded one. */
	incomparableDropped: number;
}

const DEFAULT_LIMIT = 8;
const DEFAULT_MAX_RUNS = 25;

async function readGoal(file: string): Promise<CurrentGoal | undefined> {
	let text: string;
	try { text = await readFile(file, "utf8"); }
	catch { return undefined; }
	let value: unknown;
	try { value = JSON.parse(text) as unknown; }
	catch { return undefined; }
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const goal = value as Partial<CurrentGoal>;
	if (typeof goal.runId !== "string" || !goal.runId || !Array.isArray(goal.tasks)) return undefined;
	return goal as CurrentGoal;
}

async function runPlatform(runDir: string): Promise<{ id: string; chip: string; toolchain: string } | undefined> {
	const { events } = await readSearchEvents(path.join(runDir, "search-events.jsonl"));
	for (let index = events.length - 1; index >= 0; index--) if (events[index].platform) return events[index].platform;
	return undefined;
}

/**
 * Scan recent runs for their best verified candidates. Newest runs first, with
 * an explicit bound: a warm start that walks an unbounded history is a new
 * source of latency, not a shortcut.
 */
export async function collectWarmStartLeads(query: WarmStartQueryV1): Promise<WarmStartResultV1> {
	const limit = Math.max(1, query.limit ?? DEFAULT_LIMIT);
	const maxRuns = Math.max(1, query.maxRuns ?? DEFAULT_MAX_RUNS);
	let names: string[];
	try { names = (await readdir(query.m07Dir, { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name); }
	catch { return { leads: [], scannedRuns: 0, skippedRuns: 0, incomparableDropped: 0 }; }
	const runIds = names.filter(name => name !== query.excludeRunId).sort().reverse().slice(0, maxRuns);
	const leads: WarmStartLeadV1[] = [];
	let scannedRuns = 0;
	let skippedRuns = 0;
	let incomparableDropped = 0;
	for (const runId of runIds) {
		const runDir = path.join(query.m07Dir, runId);
		const goal = await readGoal(path.join(runDir, "goal.json"));
		if (!goal) { skippedRuns++; continue; }
		scannedRuns++;
		let entries: ReturnType<typeof candidateArchive>;
		try { entries = candidateArchive(goal); }
		catch { skippedRuns++; continue; }
		if (!entries.length) continue;
		const platform = await runPlatform(runDir);
		const comparable = Boolean(platform && query.platform &&
			platform.chip === query.platform.chip && platform.toolchain === query.platform.toolchain) ||
			(!query.platform && platform !== undefined);
		const byRef = new Map(entries.map(entry => [entry.ref, entry]));
		for (const best of globalCandidateBest(entries)) {
			const entry = byRef.get(best.candidateRef);
			if (!entry) continue;
			if (query.subjectId && entry.subjectId !== query.subjectId) continue;
			if (!comparable && !query.includeIncomparable) { incomparableDropped++; continue; }
			leads.push({
				runId: goal.runId, taskId: entry.taskId, candidateRef: entry.ref,
				...(entry.subjectId ? { subjectId: entry.subjectId } : {}),
				metric: best.metric, correctness: entry.observation.correctness,
				observationPath: entry.observationPath, workDir: entry.workDir,
				sourcePaths: [...entry.sourcePaths],
				...(platform ? { platform } : {}), comparable,
			});
			if (leads.length >= limit) return { leads, scannedRuns, skippedRuns, incomparableDropped };
		}
	}
	return { leads, scannedRuns, skippedRuns, incomparableDropped };
}

/** One line per lead, including why it may not be reusable. */
export function describeWarmStartLeads(result: WarmStartResultV1): string[] {
	return result.leads.map(lead =>
		`${lead.candidateRef} from run ${lead.runId} task ${lead.taskId}` +
		`${lead.subjectId ? ` subject ${lead.subjectId}` : ""}: ${lead.metric.name}=${lead.metric.value}${lead.metric.unit}` +
		` (${lead.metric.direction} is better, basis ${lead.metric.basisId}, correctness ${lead.correctness})` +
		`${lead.platform ? ` on ${lead.platform.chip}/${lead.platform.toolchain}` : " with no recorded platform"}` +
		`${lead.comparable ? "" : " — NOT comparable to the current platform; re-measure before using the number"}`);
}
