/** Exact same-goal candidate references derived from existing frozen task records. */
import { constants } from "node:fs";
import { copyFile, lstat, mkdir, mkdtemp, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { CustomToolSpec } from "../runner/types.ts";
import { HarnessError } from "../types.ts";
import { isSafeRelativeOutputPath } from "./expected-output.ts";
import type { CandidateMetricV1, CandidateObservationV1, CurrentGoal, M07TaskRecord } from "./types.ts";
import type { CandidateComparisonV1 } from "./candidate-diagnostics.ts";
import type { CandidatePolicyDecisionV1, CandidateStrategy } from "./candidate-policy.ts";
import { analyzeCandidateSearch, candidateSearchBrief, candidateSearchFocus, scopedRepeatedSourceObservations, scopedSearchLeads } from "./candidate-search.ts";

export interface CandidateArchiveEntry {
	ref: string;
	taskId: string;
	subjectId?: string;
	candidateId: string;
	taskStatus: M07TaskRecord["status"];
	intent: "solution" | "diagnostic";
	changeKind?: "repair" | "structure" | "parameters";
	strategy?: CandidateStrategy;
	location?: string;
	hypothesis?: string;
	conditions?: string[];
	changeSummary?: string;
	parentRef?: { taskId: string; candidateId: string };
	parentComparison?: CandidateComparisonV1;
	/** Deterministic host judgement recorded with the candidate, when available. */
	policy?: CandidatePolicyDecisionV1;
	identicalSourceRefs?: string[];
	/** Derived from readable frozen bytes for this snapshot; never persisted as evidence. */
	sourceGroupRef?: string;
	sourceRepetition?: "duplicate_code" | "code_cycle";
	sourcePaths: string[];
	receiptPaths: string[];
	observation: CandidateObservationV1;
	observationPath: string;
	workDir: string;
}

const within = (root: string, file: string) => file === root || file.startsWith(`${root}${path.sep}`);
const metricKey = (metric: CandidateMetricV1) => JSON.stringify([metric.name, metric.unit, metric.basisId, metric.direction]);

/** A task's declared work object may fill in a legacy observation, but must
 * never override a different or multi-subject host observation. */
export function candidateSubjectId(declared: string | undefined, observation: CandidateObservationV1): string | undefined {
	const observed = [...new Set(observation.executionFacts?.evaluations.map(item => item.subjectId) ?? [])];
	if (observed.length > 1 || observed.length === 1 && declared && observed[0] !== declared) return undefined;
	return observed[0] ?? declared;
}

/** A checkout writes under model-writable workDir: never traverse an existing
 * symlink while creating its host-owned output directories. */
async function checkoutDirectory(root: string, directory: string): Promise<void> {
	if (!within(root, directory)) throw new HarnessError("m07.candidate-archive", "checkout directory escaped task workDir");
	const rootInfo = await lstat(root);
	if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || await realpath(root) !== root)
		throw new HarnessError("m07.candidate-archive", "checkout root is not a canonical directory");
	let current = root;
	for (const part of path.relative(root, directory).split(path.sep)) {
		if (!part) continue;
		current = path.join(current, part);
		try { await mkdir(current); }
		catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
		const info = await lstat(current);
		if (!info.isDirectory() || info.isSymbolicLink() || !within(root, await realpath(current)))
			throw new HarnessError("m07.candidate-archive", "checkout directory is not a real directory inside task workDir");
	}
}

/** Remove only shared host-generated containers, leaving the candidate's multi-file layout intact. */
function logicalCheckoutSources(paths: readonly string[], checkoutRefs: ReadonlySet<string>): string[] {
	let current = [...paths];
	for (;;) {
		const first = current[0];
		if (!first) return current;
		const runner = first.match(/^\.candidate-runs\/[A-Za-z0-9][A-Za-z0-9_-]*\/(?:sources|materialized\/[1-9]\d*)\//);
		const checkout = first.match(/^candidate-checkouts\/(T\d{3,})-(C\d{3,}|final)-[^/]+\/sources\//);
		const prefix = runner?.[0] ?? (checkout && checkoutRefs.has(`${checkout[1]}/${checkout[2]}`) ? checkout[0] : undefined);
		if (!prefix || !current.every(item => item.startsWith(prefix) && item.length > prefix.length)) return current;
		current = current.map(item => item.slice(prefix.length));
	}
}

/** A returned negative episode is useful search evidence even when its task review rejects it. */
export function candidateArchive(goal: CurrentGoal, currentTaskId?: string): CandidateArchiveEntry[] {
	const entries: CandidateArchiveEntry[] = [];
	for (const task of goal.tasks) {
		if ((task.status === "running" || task.status === "unknown") && task.taskId !== currentTaskId) continue;
		for (const candidate of task.episode?.candidates ?? []) entries.push({
			ref: `${task.taskId}/${candidate.id}`, taskId: task.taskId, subjectId: task.subjectId, candidateId: candidate.id,
			taskStatus: task.status, intent: candidate.intent, changeKind: candidate.changeKind,
			strategy: candidate.strategy, location: candidate.location,
			hypothesis: candidate.hypothesis, conditions: candidate.conditions,
			changeSummary: candidate.changeSummary, parentRef: candidate.parentRef ??
				(candidate.parentCandidateId && /^C\d{3,}$/.test(candidate.parentCandidateId) ?
					{ taskId: task.taskId, candidateId: candidate.parentCandidateId } : undefined),
			parentComparison: candidate.parentComparison, policy: candidate.policy,
			identicalSourceRefs: candidate.identicalSourceRefs,
			sourceRepetition: candidate.sourceRepetition,
			sourcePaths: candidate.sourcePaths,
			receiptPaths: candidate.receiptPaths, observation: candidate.observation,
			observationPath: candidate.observationPath, workDir: task.workDir,
		});
		if (!task.episode?.candidates.length && task.candidate && task.candidateObservation) entries.push({
			ref: `${task.taskId}/final`, taskId: task.taskId, subjectId: task.subjectId, candidateId: "final",
			taskStatus: task.status, intent: task.candidate.intent ?? "solution",
			changeKind: task.candidate.changeKind, sourcePaths: task.candidate.sourcePaths,
			receiptPaths: task.candidate.receiptPaths, observation: task.candidateObservation,
			observationPath: task.candidateObservation.observationPath, workDir: task.workDir,
		});
	}
	return entries;
}

export function candidateByRef(goal: CurrentGoal, ref: string, currentTaskId?: string): CandidateArchiveEntry {
	if (!/^T\d{3,}\/(?:C\d{3,}|final)$/.test(ref))
		throw new HarnessError("m07.candidate-archive", "candidateRef must be an exact same-goal task/candidate reference");
	const entry = candidateArchive(goal, currentTaskId).find(item => item.ref === ref);
	if (!entry) throw new HarnessError("m07.candidate-archive", `candidateRef is unavailable in this goal: ${ref}`);
	return entry;
}

async function frozenFiles(entry: CandidateArchiveEntry): Promise<{ sources: string[]; receipts: string[]; observation: string }> {
	const root = await realpath(path.dirname(entry.workDir));
	const validate = async (file: string) => {
		if (!path.isAbsolute(file))
			throw new HarnessError("m07.candidate-archive", "candidate evidence must use a frozen absolute path");
		const info = await lstat(file);
		if (!info.isFile() || info.isSymbolicLink())
			throw new HarnessError("m07.candidate-archive", "candidate evidence is not a regular frozen file");
		const resolved = await realpath(file);
		if (!within(root, resolved)) throw new HarnessError("m07.candidate-archive", "candidate evidence resolved outside its task directory");
		return resolved;
	};
	if (entry.sourcePaths.length !== entry.observation.sourceFiles.length ||
		entry.receiptPaths.length !== entry.observation.receiptFiles.length)
		throw new HarnessError("m07.candidate-archive", "candidate declaration and frozen file mapping differ");
	return { sources: await Promise.all(entry.observation.sourceFiles.map(validate)),
		receipts: await Promise.all(entry.observation.receiptFiles.map(validate)),
		observation: await validate(entry.observationPath) };
}

export async function availableCandidateByRef(goal: CurrentGoal, ref: string,
	currentTaskId?: string): Promise<CandidateArchiveEntry> {
	const entry = candidateByRef(goal, ref, currentTaskId);
	await frozenFiles(entry);
	return entry;
}

export function globalCandidateBest(entries: readonly CandidateArchiveEntry[]): Array<{ candidateRef: string; metric: CandidateMetricV1; subjectId?: string }> {
	const best = new Map<string, { candidateRef: string; metric: CandidateMetricV1; subjectId?: string }>();
	const readings: Array<{ entry: CandidateArchiveEntry; subjectId: string; metric: CandidateMetricV1;
		measurementKey?: string }> = [];
	const measuredValues = new Map<string, number>();
	const conflictingMeasurements = new Set<string>();
	for (const entry of entries) {
		if (entry.observation.sourceBinding !== "verified" || entry.observation.correctness !== "passed") continue;
		const subjectId = candidateSubjectId(entry.subjectId, entry.observation);
		if (!subjectId) continue;
		const terminal = entry.observation.executionFacts?.evaluations.filter(item => item.terminal && item.externalId.trim()) ?? [];
		const metricCounts = new Map<string, number>();
		for (const metric of entry.observation.metrics) metricCounts.set(metricKey(metric), (metricCounts.get(metricKey(metric)) ?? 0) + 1);
		for (const metric of entry.observation.metrics) {
			const identity = metricKey(metric);
			if (metricCounts.get(identity) !== 1 || !Number.isFinite(metric.value)) continue;
			// Only one exact terminal evaluation can identify this top-level reading.
			// A verifier reparse of that ID is not another physical measurement.
			const measurementKey = terminal.length === 1 && terminal[0].subjectId === subjectId
				? JSON.stringify([entry.observation.verifier.id, terminal[0].externalId, subjectId, identity]) : undefined;
			readings.push({ entry, subjectId, metric, measurementKey });
			if (measurementKey) {
				const prior = measuredValues.get(measurementKey);
				if (prior !== undefined && prior !== metric.value) conflictingMeasurements.add(measurementKey);
				else measuredValues.set(measurementKey, metric.value);
			}
		}
	}
	for (const { entry, subjectId, metric, measurementKey } of readings) {
		if (measurementKey && conflictingMeasurements.has(measurementKey)) continue;
		const key = JSON.stringify([subjectId, metricKey(metric)]);
		const prior = best.get(key);
		if (!prior || (metric.direction === "higher" ? metric.value > prior.metric.value : metric.value < prior.metric.value))
			best.set(key, { candidateRef: entry.ref, metric, subjectId });
	}
	return [...best.values()];
}

/** A single available snapshot is shared by list and immediate episode feedback. */
export async function candidateSearchSnapshot(goal: CurrentGoal, currentTaskId?: string) {
	const all = candidateArchive(goal, currentTaskId);
	const available: CandidateArchiveEntry[] = [];
	const checkoutRefs = new Set(all.map(entry => entry.ref));
	const sourceGroups = new Map<string, Array<{ ref: string; bytes: Buffer[] }>>();
	for (const entry of all) {
		try {
			const files = await frozenFiles(entry);
			available.push(entry);
			if (!files.sources.length) continue;
			const bytes = await Promise.all(files.sources.map(file => readFile(file)));
			// A single file may have been renamed on checkout. Multi-file candidates
			// also require the same relative layout, because imports can depend on it.
			const layout = files.sources.length === 1 ? [] : logicalCheckoutSources(entry.sourcePaths, checkoutRefs);
			const key = JSON.stringify([layout, bytes.map(value => value.length)]);
			const groups = sourceGroups.get(key) ?? [];
			const match = groups.find(group => group.bytes.every((value, index) => value.equals(bytes[index])));
			entry.sourceGroupRef = match?.ref ?? entry.ref;
			if (!match) { groups.push({ ref: entry.ref, bytes }); sourceGroups.set(key, groups); }
		}
		catch { /* Unavailable frozen files cannot establish byte identity. */ }
	}
	return { all, available, facts: analyzeCandidateSearch(available), best: globalCandidateBest(available) };
}

/** Exact bytes only: equal code can still have different behavior under another harness. */
export async function identicalSourceRefs(goal: CurrentGoal, currentTaskId: string,
	newSources: readonly string[]): Promise<string[]> {
	const currentBytes = await Promise.all(newSources.map(file => readFile(file)));
	const matches: string[] = [];
	for (const entry of candidateArchive(goal, currentTaskId)) {
		if (entry.observation.sourceFiles.length !== currentBytes.length) continue;
		try {
			const files = await frozenFiles(entry);
			if ((await Promise.all(files.sources.map((file, index) => readFile(file).then(bytes => bytes.equals(currentBytes[index]))))).every(Boolean))
				matches.push(entry.ref);
		} catch { /* An unavailable historical artifact cannot establish byte identity. */ }
	}
	return matches;
}

export function createCandidateArchiveTools(input: {
	goal: CurrentGoal;
	task: M07TaskRecord;
	save: () => Promise<void>;
}): CustomToolSpec[] {
	const readRef = (args: Record<string, unknown>) => {
		if (typeof args.candidateRef !== "string") throw new HarnessError("m07.candidate-archive", "candidateRef is required");
		return candidateByRef(input.goal, args.candidateRef, input.task.taskId);
	};
	const page = (args: Record<string, unknown>, defaultLimit: number, maxLimit: number) => {
		const offset = args.offset ?? 0, limit = args.limit ?? defaultLimit;
		if (!Number.isSafeInteger(offset) || Number(offset) < 0 || !Number.isSafeInteger(limit) || Number(limit) < 1 || Number(limit) > maxLimit)
			throw new HarnessError("m07.candidate-archive", `offset and limit must be nonnegative integer offset and page length 1..${maxLimit}`);
		return { offset: Number(offset), limit: Number(limit) };
	};
	const summary = (entry: CandidateArchiveEntry) => ({
		verifier: entry.observation.verifier, sourceBinding: entry.observation.sourceBinding,
		correctness: entry.observation.correctness, stage: entry.observation.stage,
		checks: entry.observation.checks, goalChecks: entry.observation.goalChecks,
		metrics: entry.observation.metrics, limitations: entry.observation.limitations,
		executionFacts: entry.observation.executionFacts?.evaluations.map(evaluation => ({
			externalId: evaluation.externalId, subjectId: evaluation.subjectId,
			status: evaluation.status, terminal: evaluation.terminal,
			capturedAt: evaluation.capturedAt, receiptIndex: evaluation.receiptIndex,
			caseCount: evaluation.cases.length, diagnosticCount: evaluation.diagnostics.length,
		})),
	});
	return [
		{
			name: "candidate_list",
			description: "Page through this goal's frozen candidates and read-only search facts. Sections: candidates, global-best, search-leads, repeated-source, case-frontiers, case-members, parents, repetition, local-no-gain. Search leads and repeated-source observations focus on the current subject by default; exact subject/basis filters and paging expose other scopes. No evaluation is run.",
			params: {
				section: { type: "string", description: "Optional candidates (default), global-best, search-leads, repeated-source, case-frontiers, case-members, parents, repetition, or local-no-gain", optional: true },
				caseIndex: { type: "number", description: "Required zero-based case-frontier index for section=case-members", optional: true },
				subjectId: { type: "string", description: "Exact subject filter for search-leads or repeated-source; otherwise use current task/latest measured subject", optional: true },
				basisId: { type: "string", description: "Optional exact measurement basis filter for search-leads or repeated-source; omitted by default so leads from different cases remain visible", optional: true },
				offset: { type: "number", description: "Candidate index offset, default 0", optional: true },
				limit: { type: "number", description: "Section page length, default 50, at most 200; continue at nextOffset", optional: true },
			},
			async execute(args) {
				const { offset, limit } = page(args, 50, 200);
				const section = args.section ?? "candidates";
				if (typeof section !== "string" || !["candidates", "global-best", "search-leads", "repeated-source", "case-frontiers", "case-members", "parents", "repetition", "local-no-gain"].includes(section))
					throw new HarnessError("m07.candidate-archive", "unknown candidate list section");
				if (args.caseIndex !== undefined && section !== "case-members")
					throw new HarnessError("m07.candidate-archive", "caseIndex is only valid for case-members");
				if ((args.subjectId !== undefined || args.basisId !== undefined) && section !== "search-leads" && section !== "repeated-source")
					throw new HarnessError("m07.candidate-archive", "subjectId and basisId are only valid for search-leads or repeated-source");
				if ((args.subjectId !== undefined && (typeof args.subjectId !== "string" || !args.subjectId.trim())) ||
					(args.basisId !== undefined && (typeof args.basisId !== "string" || !args.basisId.trim())))
					throw new HarnessError("m07.candidate-archive", "subjectId and basisId must be nonempty exact strings");
				const snapshot = await candidateSearchSnapshot(input.goal, input.task.taskId);
				const { all, available, facts, best } = snapshot;
				const availableRefs = new Set(available.map(entry => entry.ref));
				const candidates = [] as Array<Record<string, unknown>>;
				const start = Math.min(all.length, offset);
				const end = Math.min(all.length, start + limit);
				for (let index = 0; index < all.length; index++) {
					const entry = all[index];
					if (index < start || index >= end) continue;
					const preview = (value: string | undefined, max: number) => value && value.length > max ? `${value.slice(0, max)}…` : value;
					candidates.push({ candidateRef: entry.ref, taskStatus: entry.taskStatus, intent: entry.intent,
						changeKind: entry.changeKind, hypothesis: preview(entry.hypothesis, 240),
						conditions: entry.conditions?.slice(0, 4).map(value => preview(value, 200)), omittedConditions: Math.max(0, (entry.conditions?.length ?? 0) - 4),
						changeSummary: preview(entry.changeSummary, 240),
						parentRef: entry.parentRef, identicalSourceRefs: entry.identicalSourceRefs?.slice(0, 8),
						omittedIdenticalSourceRefs: Math.max(0, (entry.identicalSourceRefs?.length ?? 0) - 8),
						sourceRepetition: entry.sourceRepetition, sourceGroupRef: entry.sourceGroupRef,
						sourceBinding: entry.observation.sourceBinding, correctness: entry.observation.correctness,
						stage: entry.observation.stage, metrics: entry.observation.metrics.slice(0, 8),
						metricCount: entry.observation.metrics.length, omittedMetrics: Math.max(0, entry.observation.metrics.length - 8),
						sourcePaths: entry.sourcePaths.slice(0, 8), omittedSourcePaths: Math.max(0, entry.sourcePaths.length - 8),
						receiptPaths: entry.receiptPaths.slice(0, 8), omittedReceiptPaths: Math.max(0, entry.receiptPaths.length - 8),
						frozenAvailable: availableRefs.has(entry.ref) });
				}
				const focus = candidateSearchFocus(available, input.task.subjectId);
				const searchBrief = candidateSearchBrief(facts, available, focus);
				const search = { availableCandidates: available.length, caseFrontierCount: facts.perCaseFrontiers.length,
					independentLeadCount: facts.searchLeads.length,
					repeatedSourceObservationCount: facts.repeatedSourceObservations.length,
					parentCount: facts.explorationParents.length, repetitionCount: facts.repetition.length,
					localNoMeasuredGainCount: facts.localNoMeasuredGain.length,
					changeHistory: facts.changeHistory, limitations: facts.limitations,
					sections: ["global-best", "search-leads", "repeated-source", "case-frontiers", "case-members", "parents", "repetition", "local-no-gain"] };
				if (section !== "candidates") {
					let rows: unknown[];
					if (section === "global-best") rows = best;
					else if (section === "search-leads" || section === "repeated-source") {
						const selected = { subjectId: (args.subjectId as string | undefined) ?? focus.subjectId,
							basisId: args.basisId as string | undefined };
						rows = section === "search-leads" ? scopedSearchLeads(facts, available, selected)
							: scopedRepeatedSourceObservations(facts, selected, available);
					}
					else if (section === "case-frontiers") rows = facts.perCaseFrontiers.map((item, index) => ({
						caseIndex: index, subjectId: item.subjectId, caseId: item.caseId,
						dimensions: item.dimensions.slice(0, 8), omittedDimensions: Math.max(0, item.dimensions.length - 8),
						frontierCount: item.frontierRefs.length, independentMeasurementCount: item.independentMeasurementCount,
						frontierMeasurementCount: item.frontierMeasurements.length, dominatedCount: item.dominated.length,
						frontierPreview: item.frontierRefs.slice(0, 8), omittedFrontierPreview: Math.max(0, item.frontierRefs.length - 8),
						readMembers: { section: "case-members", caseIndex: index, offset: 0, limit: 50 } }));
					else if (section === "case-members") {
						if (!Number.isSafeInteger(args.caseIndex) || Number(args.caseIndex) < 0 || Number(args.caseIndex) >= facts.perCaseFrontiers.length)
							throw new HarnessError("m07.candidate-archive", "caseIndex must select a listed case frontier");
						const item = facts.perCaseFrontiers[Number(args.caseIndex)];
						rows = [...item.frontierMeasurements.flatMap(measurement => measurement.candidateRefs.map(candidateRef => ({
							candidateRef, status: "frontier", externalId: measurement.externalId,
							sharedMeasurementRefs: measurement.candidateRefs.filter(ref => ref !== candidateRef),
							independentCompetitors: measurement.independentCompetitors }))),
							...item.dominated.map(dominated => ({ candidateRef: dominated.candidateRef, status: "dominated",
								dominatedByCount: dominated.by.length, dominatedByPreview: dominated.by.slice(0, 8),
								omittedDominators: Math.max(0, dominated.by.length - 8) }))];
					} else if (section === "parents") rows = facts.explorationParents;
					else if (section === "repetition") rows = facts.repetition.map(item => ({ candidateRef: item.candidateRef,
						kind: item.kind, identicalSourceCount: item.identicalSourceRefs.length,
						identicalSourcePreview: item.identicalSourceRefs.slice(0, 8),
						omittedIdenticalSources: Math.max(0, item.identicalSourceRefs.length - 8) }));
					else rows = facts.localNoMeasuredGain;
					const first = Math.min(rows.length, offset), last = Math.min(rows.length, first + limit);
					return { text: JSON.stringify({ section, ...(section === "case-members" ? { caseIndex: args.caseIndex } : {}),
						total: rows.length, offset: first, end: last, nextOffset: last < rows.length ? last : null,
						rows: rows.slice(first, last), search,
						...(["search-leads", "repeated-source"].includes(section) ? { focus: { subjectId: args.subjectId ?? focus.subjectId,
							...(args.basisId === undefined ? {} : { basisId: args.basisId }) } } : {}),
						message: "These are observed, case-local search facts over readable frozen candidates. They do not select a parent, prove a speedup, impose a route ban, or satisfy the original goal." }) };
				}
				return { text: JSON.stringify({ searchBrief, total: all.length, offset: start, end,
					nextOffset: end < all.length ? end : null, candidates,
					globalBest: best.slice(0, 20), globalBestTotal: best.length,
					globalBestNextOffset: best.length > 20 ? 20 : null, search,
					globalBestScope: "available host-verified candidates on the same metric basis and known subject; unknown/mismatched subject, multi-subject aggregates and legacy tasks excluded.",
					message: "Best covers available host-verified archive entries per comparable metric/basis, not legacy tasks without observations or the whole goal. Search sections are paged with section, offset and limit; case-frontier members require caseIndex. Negative observations remain available for repair." }) };
			},
		},
		{
			name: "candidate_read",
			description: "Read one exact same-goal candidate's observation summary, or page one frozen source, original receipt or observation JSON file. No evaluation is run.",
			params: {
				candidateRef: { type: "string", description: "Exact reference from candidate_list, such as T001/C002" },
				kind: { type: "string", description: "Optional source, receipt or observation; omit for metadata summary", optional: true },
				fileIndex: { type: "number", description: "Zero-based source or receipt file index, default 0", optional: true },
				offset: { type: "number", description: "UTF-16 character offset for one file, default 0", optional: true },
				limit: { type: "number", description: "UTF-16 character page length, default 6000, at most 12000", optional: true },
			},
			async execute(args) {
				const entry = readRef(args);
				const files = await frozenFiles(entry);
				const metadata = { candidateRef: entry.ref, taskStatus: entry.taskStatus,
					intent: entry.intent, changeKind: entry.changeKind, hypothesis: entry.hypothesis,
					conditions: entry.conditions, changeSummary: entry.changeSummary,
					parentRef: entry.parentRef, parentComparison: entry.parentComparison && {
						summary: entry.parentComparison.summary,
						comparableMetricCount: entry.parentComparison.comparableMetrics.length,
						caseChangeCount: entry.parentComparison.caseChanges.length,
					},
					identicalSourceRefs: entry.identicalSourceRefs, sourceRepetition: entry.sourceRepetition,
				};
				if (args.kind === undefined) {
					if (args.fileIndex !== undefined || args.offset !== undefined || args.limit !== undefined)
						throw new HarnessError("m07.candidate-archive", "kind is required for file paging");
					return { text: JSON.stringify({ ...metadata, observation: summary(entry),
						sources: await Promise.all(files.sources.map(async (file, index) => ({ fileIndex: index, declaredPath: entry.sourcePaths[index], bytes: (await stat(file)).size }))),
						receipts: await Promise.all(files.receipts.map(async (file, index) => ({ fileIndex: index, declaredPath: entry.receiptPaths[index], bytes: (await stat(file)).size }))),
						observationFile: { kind: "observation", bytes: (await stat(files.observation)).size },
						message: "This is a summary. Use kind/source|receipt|observation with fileIndex and offset/limit to read original text in pages; a returned path alone does not mean it was read." }) };
				}
				if (!["source", "receipt", "observation"].includes(String(args.kind)))
					throw new HarnessError("m07.candidate-archive", "kind must be source, receipt or observation");
				const index = args.fileIndex ?? 0;
				if (!Number.isSafeInteger(index) || Number(index) < 0 ||
					(args.kind === "observation" && index !== 0))
					throw new HarnessError("m07.candidate-archive", "fileIndex must select one frozen file");
				const selected = args.kind === "source" ? files.sources[Number(index)] :
					args.kind === "receipt" ? files.receipts[Number(index)] : files.observation;
				if (!selected) throw new HarnessError("m07.candidate-archive", "fileIndex is outside this candidate's frozen files");
				const { offset, limit } = page(args, 6000, 12000);
				const original = await readFile(selected, "utf8");
				const start = Math.min(original.length, offset);
				const end = Math.min(original.length, start + limit);
				return { text: JSON.stringify({ candidateRef: entry.ref, kind: args.kind, fileIndex: Number(index),
					declaredPath: args.kind === "source" ? entry.sourcePaths[Number(index)] :
						args.kind === "receipt" ? entry.receiptPaths[Number(index)] : "observation.json",
					returnedRange: { offset: start, end, total: original.length, units: "utf16" },
					nextOffset: end < original.length ? end : null, text: original.slice(start, end),
					message: "Only this file range was returned; it is historical evidence and not a new evaluation." }) };
			},
		},
		{
			name: "candidate_checkout",
			description: "Copy one exact same-goal frozen candidate into this task's work directory as a writable starting point. Historical receipts are evidence only; after edits, obtain a new platform result before candidate_evaluate. No submission or evaluation is run.",
			params: { candidateRef: { type: "string", description: "Exact reference from candidate_list, such as T001/C002" } },
			async execute(args) {
				const entry = readRef(args);
				const files = await frozenFiles(entry);
				const checkoutRefs = new Set(input.goal.tasks.flatMap(task => task.episode?.checkouts?.map(item => item.candidateRef) ?? []));
				const logicalSources = logicalCheckoutSources(entry.sourcePaths, checkoutRefs);
				const workInfo = await lstat(input.task.workDir);
				if (!workInfo.isDirectory() || workInfo.isSymbolicLink())
					throw new HarnessError("m07.candidate-archive", "task workDir is not a real directory");
				const workRoot = await realpath(input.task.workDir);
				const base = path.join(workRoot, "candidate-checkouts");
				await checkoutDirectory(workRoot, base);
				const folder = await mkdtemp(path.join(base, `${entry.taskId}-${entry.candidateId}-`));
				if (!(await lstat(folder)).isDirectory() || !within(workRoot, await realpath(folder)))
					throw new HarnessError("m07.candidate-archive", "checkout folder escaped task workDir");
				const targets = new Set<string>();
				const copy = async (source: string, kind: "sources" | "receipts", declared: string) => {
					if (!isSafeRelativeOutputPath(declared) || declared === ".")
						throw new HarnessError("m07.candidate-archive", "candidate declaration is not a safe relative checkout path");
					const targetRoot = path.join(folder, kind);
					const target = path.resolve(targetRoot, declared);
					if (!within(targetRoot, target))
						throw new HarnessError("m07.candidate-archive", "candidate checkout path escaped its independent folder");
					if (targets.has(target)) throw new HarnessError("m07.candidate-archive", "candidate checkout paths collide");
					targets.add(target);
					await checkoutDirectory(folder, path.dirname(target));
					await copyFile(source, target, constants.COPYFILE_EXCL);
					const copied = await lstat(target);
					if (!copied.isFile() || copied.isSymbolicLink() || !within(folder, await realpath(target)))
						throw new HarnessError("m07.candidate-archive", "checkout file escaped its independent folder");
					if (!(await readFile(source)).equals(await readFile(target)))
						throw new HarnessError("m07.candidate-archive", "candidate changed while making a working copy");
					return path.relative(workRoot, target);
				};
				const sourcePaths = await Promise.all(files.sources.map((file, index) => copy(file, "sources", logicalSources[index])));
				const receiptPaths = await Promise.all(files.receipts.map((file, index) => copy(file, "receipts", entry.receiptPaths[index])));
				input.task.episode?.checkouts?.push({ candidateRef: entry.ref });
				if (input.task.episode && !input.task.episode.checkouts)
					input.task.episode.checkouts = [{ candidateRef: entry.ref }];
				await input.save();
				return { text: JSON.stringify({ candidateRef: entry.ref, sourcePaths, receiptPaths,
					parentObservation: summary(entry),
					message: "Working copies are historical source and receipt bytes. This checkout does not prove a new experiment or bind a modified source to the old receipt; parent lineage is a declared hypothesis." }) };
			},
		},
	];
}
