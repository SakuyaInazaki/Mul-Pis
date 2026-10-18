/** One live builder session can inspect many already-run candidate evaluations. */
import { copyFile, lstat, mkdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import type { CustomToolSpec } from "../runner/types.ts";
import { HarnessError } from "../types.ts";
import { writeFileAtomic } from "../workspace.ts";
import { candidateObservation, type CandidateVerifier, type FrozenCandidateFile } from "./candidate-evaluation.ts";
import { availableCandidateByRef, candidateArchive, candidateSearchSnapshot, candidateSubjectId, globalCandidateBest, identicalSourceRefs } from "./candidate-archive.ts";
import { candidateSearchBrief, candidateSearchFocus } from "./candidate-search.ts";
import { compareCandidateObservations, projectCandidateFeedback, summarizeCandidateDiagnostics } from "./candidate-diagnostics.ts";
import { CANDIDATE_STRATEGIES, candidateSearchState, candidateStrategyMenu, candidateStrategyStats,
	candidateBudgetLedger, decideCandidate, DEFAULT_SEARCH_BUDGET, requireAllowedAction,
	requireBudget, requireUnbannedDirection,
	type CandidateChangeKind, type CandidateStrategy } from "./candidate-policy.ts";
import { isSafeRelativeOutputPath } from "./expected-output.ts";
import type { CandidateObservationV1, CurrentGoal, M07TaskRecord } from "./types.ts";

const within = (root: string, file: string) => file === root || file.startsWith(root + path.sep);

export function createCandidateEpisodeTool(input: {
	goal: CurrentGoal;
	task: M07TaskRecord;
	verifier: CandidateVerifier;
	save: () => Promise<void>;
}): CustomToolSpec {
	let tail: Promise<void> = Promise.resolve();
	const run = async (args: Record<string, unknown>): Promise<{ text: string }> => {
		const { goal, task, verifier } = input;
		const stringPaths = (value: unknown, label: string): string[] => {
			if (!Array.isArray(value) || value.length === 0 || value.some(item => typeof item !== "string" || !isSafeRelativeOutputPath(item) || item === ".") || new Set(value).size !== value.length)
				throw new HarnessError("m07.candidate", `${label} must contain distinct exact relative file paths`);
			return value as string[];
		};
		const sourcePaths = stringPaths(args.sourcePaths, "sourcePaths");
		const receiptPaths = stringPaths(args.receiptPaths, "receiptPaths");
		if (new Set([...sourcePaths, ...receiptPaths]).size !== sourcePaths.length + receiptPaths.length)
			throw new HarnessError("m07.candidate", "source and receipt paths must be distinct");
		if (typeof args.hypothesis !== "string" || !args.hypothesis.trim() || args.hypothesis.length > 4000 ||
			!["repair", "structure", "parameters"].includes(String(args.changeKind)) ||
			!["solution", "diagnostic"].includes(String(args.intent)))
			throw new HarnessError("m07.candidate", "hypothesis, changeKind and intent are required");
		if (args.conditions !== undefined && (!Array.isArray(args.conditions) || args.conditions.length > 32 ||
			args.conditions.some(item => typeof item !== "string" || !item.trim() || item.length > 1000)))
			throw new HarnessError("m07.candidate", "conditions must be concise declared applicability statements");
		if (args.changeSummary !== undefined && (typeof args.changeSummary !== "string" || !args.changeSummary.trim() || args.changeSummary.length > 4000))
			throw new HarnessError("m07.candidate", "changeSummary must describe the declared edit");
		if (!CANDIDATE_STRATEGIES.includes(args.strategy as CandidateStrategy))
			throw new HarnessError("m07.candidate-action", `strategy must be one of: ${CANDIDATE_STRATEGIES.join(", ")}`);
		if (typeof args.location !== "string" || !args.location.trim() || args.location.length > 300)
			throw new HarnessError("m07.candidate-action", "location must name the exact declared edit site, for example kernel.c or kernel.c:tile_loop");
		if (args.newEvidence !== undefined && (typeof args.newEvidence !== "string" || !args.newEvidence.trim() || args.newEvidence.length > 1000))
			throw new HarnessError("m07.candidate-action", "newEvidence must state what changed since the banned direction was measured");
		const action = { changeKind: args.changeKind as CandidateChangeKind,
			strategy: args.strategy as CandidateStrategy, location: args.location.trim() };
		const locationFile = action.location.includes(":") ? action.location.slice(0, action.location.indexOf(":")) : action.location;
		const locationDetail = action.location.slice(locationFile.length + 1);
		// A host runner evaluates frozen copies, so the declared site may name the
		// original file while the submitted path carries the runner's prefix.
		const locationSource = sourcePaths.find(item => item === locationFile || item.endsWith(`/${locationFile}`));
		if (!locationSource)
			throw new HarnessError("m07.candidate-action", `location must name one declared source file: ${sourcePaths.join(", ")}`);
		const episode = task.episode;
		if (!episode) throw new HarnessError("m07.candidate", "candidate episode was not initialized");
		// Stage order and stall bans are checked before any host work, so a blocked
		// action costs nothing and the refusal text is the same every time.
		const priorArchive = candidateArchive(goal, task.taskId);
		const priorState = candidateSearchState(priorArchive, { subjectId: task.subjectId, taskId: task.taskId });
		const parentCandidateId = args.parentCandidateId;
		let parentRef: { taskId: string; candidateId: string } | undefined;
		let parentObservation: CandidateObservationV1 | undefined;
		let parentSubjectId: string | undefined;
		if (parentCandidateId !== undefined) {
			if (typeof parentCandidateId !== "string") throw new HarnessError("m07.candidate", "parentCandidateId must be an exact candidate reference");
			if (/^C\d{3,}$/.test(parentCandidateId)) {
				if (!episode.candidates.some(item => item.id === parentCandidateId))
					throw new HarnessError("m07.candidate", "local parentCandidateId must name an earlier candidate in this episode");
				parentRef = { taskId: task.taskId, candidateId: parentCandidateId };
				const parent = await availableCandidateByRef(goal, `${task.taskId}/${parentCandidateId}`, task.taskId);
				parentObservation = parent.observation;
				parentSubjectId = parent.subjectId;
			} else {
				const parent = await availableCandidateByRef(goal, parentCandidateId, task.taskId);
				parentRef = { taskId: parent.taskId, candidateId: parent.candidateId };
				parentObservation = parent.observation;
				parentSubjectId = parent.subjectId;
			}
		}
		requireAllowedAction({ ...action, phase: priorState.phase,
			parentVerifiedCorrect: parentObservation?.sourceBinding === "verified" &&
				parentObservation.correctness === "passed" });
		requireUnbannedDirection(priorState, action, args.newEvidence as string | undefined);
		const searchBudget = goal.searchBudget ?? DEFAULT_SEARCH_BUDGET;
		requireBudget(candidateBudgetLedger(priorArchive, { taskId: task.taskId,
			subjectId: task.subjectId, policy: searchBudget }),
			{ changeKind: action.changeKind, lane: action.changeKind === "repair" ||
				priorState.phase === "bootstrap" ? "repair" : "optimization" });
		const episodeRoot = path.join(path.dirname(task.workDir), "episode");
		await mkdir(episodeRoot, { recursive: true });
		let nextNumber = episode.candidates.reduce((max, candidate) =>
			Math.max(max, Number(candidate.id.slice(1))), 0) + 1;
		const { id, root } = await (async () => {
			for (;;) {
				if (!Number.isSafeInteger(nextNumber)) throw new HarnessError("m07.candidate", "candidate identity overflow");
				const id = `C${String(nextNumber).padStart(3, "0")}`;
				const root = path.join(episodeRoot, id);
				try { await mkdir(root); return { id, root }; }
				catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
					nextNumber++;
				}
			}
		})();
		const workRoot = await realpath(task.workDir);
		const frozen = async (declared: string[], kind: "sources" | "receipts"): Promise<FrozenCandidateFile[]> => {
			const files: FrozenCandidateFile[] = [];
			for (let index = 0; index < declared.length; index++) {
				const declaredPath = declared[index];
				const source = path.resolve(workRoot, declaredPath);
				if (!within(workRoot, source)) throw new HarnessError("m07.candidate", "candidate path escaped work directory");
				const info = await lstat(source);
				if (!info.isFile() || info.isSymbolicLink()) throw new HarnessError("m07.candidate", `candidate path is not a regular file: ${declaredPath}`);
				const originalPath = await realpath(source);
				if (!within(workRoot, originalPath)) throw new HarnessError("m07.candidate", "candidate path escaped work directory");
				const target = path.join(root, kind, `${String(index).padStart(3, "0")}-${path.basename(source)}`);
				await mkdir(path.dirname(target), { recursive: true });
				await copyFile(originalPath, target);
				if (!(await readFile(originalPath)).equals(await readFile(target))) throw new HarnessError("m07.candidate", "candidate file changed while freezing evidence");
				files.push({ declaredPath, originalPath, frozenPath: await realpath(target) });
			}
			return files;
		};
		const sources = await frozen(sourcePaths, "sources");
		const receipts = await frozen(receiptPaths, "receipts");
		// Cheap static check before any host cost: the declared edit site must
		// actually exist in the frozen source it names.
		if (locationDetail) {
			const file = sources.find(item => item.declaredPath === locationSource)!;
			const text = (await readFile(file.frozenPath)).toString("utf8");
			const lines = /^\d+(?:-\d+)?$/.test(locationDetail)
				? locationDetail.split("-").map(Number) : undefined;
			const present = lines
				? lines.every(line => line >= 1 && line <= text.split("\n").length) && (lines[1] ?? lines[0]) >= lines[0]
				: text.includes(locationDetail);
			if (!present) throw new HarnessError("m07.candidate-action",
				`the declared location ${action.location} is not in the submitted source; name an existing symbol or line range`);
		}
		const identicalRefs = await identicalSourceRefs(goal, task.taskId, sources.map(file => file.frozenPath));
		const lastRef = episode.candidates.at(-1)?.id;
		let result: Awaited<ReturnType<CandidateVerifier["verifyTask"]>>;
		const evaluationTask = structuredClone(task);
		evaluationTask.candidate = { sourcePaths, receiptPaths,
			changeKind: args.changeKind as "repair" | "structure" | "parameters",
			intent: args.intent as "solution" | "diagnostic" };
		try { result = await verifier.verifyTask({ goal: structuredClone(goal), task: evaluationTask, sources, receipts }); }
		catch (error) { result = { sourceBinding: "unknown", correctness: "unknown", stage: "verification-unavailable", metrics: [], limitations: [`Host candidate verification failed: ${(error as Error).message}`] }; }
		for (const file of [...sources, ...receipts])
			if (!(await readFile(file.originalPath)).equals(await readFile(file.frozenPath)))
				throw new HarnessError("m07.candidate", "candidate source or receipt changed during verification");
		let observation: CandidateObservationV1;
		try { observation = candidateObservation(result, verifier, goal, task, sources, receipts); }
		catch (error) { observation = candidateObservation({ sourceBinding: "unknown", correctness: "unknown",
			stage: "verification-unavailable", metrics: [],
			limitations: [`Host candidate observation is unusable: ${(error as Error).message}`] },
			verifier, goal, task, sources, receipts); }
		const currentSubjectId = candidateSubjectId(task.subjectId, observation);
		const historical = new Map(candidateArchive(goal, task.taskId).map(entry => [entry.ref, entry]));
		const sourceRepetition = lastRef && identicalRefs.includes(`${task.taskId}/${lastRef}`) ? "duplicate_code" :
			currentSubjectId && identicalRefs.some(ref => {
				const entry = historical.get(ref);
				return entry && candidateSubjectId(entry.subjectId, entry.observation) === currentSubjectId;
			}) ? "code_cycle" : undefined;
		const parentComparison = parentObservation ? compareCandidateObservations(parentObservation, observation,
			{ parentSubjectId, candidateSubjectId: task.subjectId }) : undefined;
		const diagnosticSummary = summarizeCandidateDiagnostics(observation, parentComparison, parentObservation);
		const observationPath = path.join(root, "observation.json");
		const observationFacts = { version: 1, id, parentCandidateId, parentRef,
			identicalSourceRefs: identicalRefs, sourceRepetition, sourcePaths, receiptPaths, hypothesis: args.hypothesis,
			conditions: args.conditions, changeSummary: args.changeSummary, changeKind: action.changeKind,
			strategy: action.strategy, location: action.location, newEvidence: args.newEvidence,
			intent: args.intent, parentComparison, diagnosticSummary, observation };
		// The frozen record must exist before the archive snapshot reads it, so the
		// new candidate takes part in byte grouping exactly as every earlier one.
		await writeFileAtomic(observationPath, `${JSON.stringify(observationFacts, null, 2)}\n`);
		episode.candidates.push({ id, ...(parentCandidateId ? { parentCandidateId } : {}),
			...(parentRef ? { parentRef } : {}), ...(identicalRefs.length ? { identicalSourceRefs: identicalRefs } : {}),
			...(sourceRepetition ? { sourceRepetition } : {}),
			sourcePaths, receiptPaths, hypothesis: args.hypothesis as string,
			...(args.conditions ? { conditions: args.conditions as string[] } : {}),
			...(args.changeSummary ? { changeSummary: args.changeSummary as string } : {}),
			...(parentComparison ? { parentComparison } : {}),
			changeKind: action.changeKind, strategy: action.strategy, location: action.location,
			...(args.newEvidence ? { newEvidence: args.newEvidence as string } : {}),
			intent: args.intent as "solution" | "diagnostic", observation, observationPath });
		episode.currentCandidateId = id;
		const searchSnapshot = await candidateSearchSnapshot(goal, task.taskId);
		const record = episode.candidates.at(-1)!;
		// The judgement compares this observation with the goal's earlier readable
		// candidates only; the new row itself is never its own incumbent or seed.
		const decision = decideCandidate({ observation, diagnostics: diagnosticSummary,
			changeKind: record.changeKind, intent: record.intent, subjectId: currentSubjectId,
			taskId: task.taskId, ...(parentRef ? { parentTaskId: parentRef.taskId } : {}),
			history: searchSnapshot.available.filter(entry => entry.ref !== `${task.taskId}/${id}`) });
		record.policy = decision;
		// The snapshot entry was built before the judgement existed; the stall state
		// must see this candidate's own guard, lane and failure signature.
		const archived = searchSnapshot.available.find(entry => entry.ref === `${task.taskId}/${id}`);
		if (archived) archived.policy = decision;
		episode.search = candidateSearchState(searchSnapshot.available, { subjectId: currentSubjectId,
			taskId: task.taskId, limits: searchBudget.routeLimits });
		episode.budget = candidateBudgetLedger(searchSnapshot.available, { taskId: task.taskId,
			subjectId: currentSubjectId, policy: searchBudget });
		// Derive the local display from the same readable, subject-isolated evidence as
		// candidate_list. Historical candidates remain intact even if a file is missing.
		episode.incumbents = globalCandidateBest(searchSnapshot.available.filter(entry => entry.taskId === task.taskId))
			.map(best => ({ candidateId: best.candidateRef.slice(task.taskId.length + 1), metric: best.metric,
				...(best.subjectId ? { subjectId: best.subjectId } : {}) }));
		const observationText = `${JSON.stringify({ ...observationFacts, decision }, null, 2)}\n`;
		await writeFileAtomic(observationPath, observationText);
		await input.save();
		const searchBrief = candidateSearchBrief(searchSnapshot.facts, searchSnapshot.available,
			candidateSearchFocus(searchSnapshot.available, task.subjectId));
		return { text: JSON.stringify({ candidateId: id, candidateRef: `${task.taskId}/${id}`, searchBrief,
			parentCandidateId: parentCandidateId ?? null,
			parentRef: parentRef ?? null, ...projectCandidateFeedback(observation, parentComparison),
			diagnosticSummary: { stage: diagnosticSummary.stage, hostStage: diagnosticSummary.hostStage,
				terminalEvaluations: diagnosticSummary.terminalEvaluations,
				nonterminalEvaluations: diagnosticSummary.nonterminalEvaluations,
				cases: diagnosticSummary.cases, diagnostics: diagnosticSummary.diagnostics,
				parentMeasuredChange: diagnosticSummary.parentMeasuredChange,
				profilerInterpretation: diagnosticSummary.profilerInterpretation,
				diagnosticLocations: diagnosticSummary.diagnosticLocations.slice(0, 6),
				omittedDiagnosticLocations: Math.max(0, diagnosticSummary.diagnosticLocations.length - 6),
				profileInterpretations: diagnosticSummary.profileInterpretations.slice(0, 3).map(({ counters, ...profile }) => ({
					...profile, counterCount: counters.length, counters: counters.slice(0, 3), omittedCounters: Math.max(0, counters.length - 3) })),
				omittedProfileInterpretations: Math.max(0, diagnosticSummary.profileInterpretations.length - 3),
				referenceContrastCount: diagnosticSummary.referenceContrasts.length,
				timingComparisons: diagnosticSummary.timingComparisons.slice(0, 3),
				omittedTimingComparisons: Math.max(0, diagnosticSummary.timingComparisons.length - 3),
				inspection: diagnosticSummary.inspection },
			identicalSourceRefs: identicalRefs, sourceRepetition: sourceRepetition ?? null,
			projection: { kind: "indexed", fullObservationPath: observationPath,
				fullObservationChars: observationText.length, units: "utf16",
				read: { tool: "candidate_read", args: { candidateRef: `${task.taskId}/${id}`, kind: "observation", offset: 0, limit: 6000 } },
				message: "Case rows retain measurements within display space and prioritize failed/unknown cases. Parent case deltas show negative/unknown cases and regressions first. Diagnostic indexes show a first entry per category before others within display space. Counts include omitted entries. JSON paths refer to the full frozen observation; diagnostic fieldPath refers to its original receipt (candidate_read kind:receipt, fileIndex:receiptIndex). Use returned nextOffset to continue file reads. A preview/index is not full reading or causal interpretation; all original facts and parent comparisons are retained." },
			currentCandidateId: episode.currentCandidateId, incumbents: episode.incumbents,
			search: episode.search, budget: episode.budget,
			strategyStats: candidateStrategyStats(searchSnapshot.available, currentSubjectId),
			nextStrategyMenu: candidateStrategyMenu({ phase: episode.search.phase, route: episode.search.route,
				seed: `${goal.runId}|${task.taskId}|${episode.candidates.length}` }),
			decision: { guard: decision.guard, status: decision.status, branch: decision.branch,
				lane: decision.lane, phase: decision.phase,
				score: decision.score, tier: decision.tier, updatesBest: decision.updatesBest,
				seedRef: decision.seedRef ?? null, seedSpeedup: decision.seedSpeedup ?? null,
				incumbentComparison: decision.incumbentComparison.slice(0, 4),
				omittedIncumbentComparisons: Math.max(0, decision.incumbentComparison.length - 4),
				requiredFix: decision.requiredFix, advisory: decision.advisory, reasons: decision.reasons,
				message: "The guard state, admission status, branch decision, score and best-so-far pointer are deterministic host decisions over the frozen observations; they are not negotiable and do not need a model verdict. keep advances the best; accept keeps a correct working point without advancing it; revert means continue from the named verified candidate instead of this source; reject means the result could not be bound or judged at all. The score is a bounded ranking signal over this goal's candidates, not a goal acceptance." },
			message: observation.sourceBinding === "unknown" || observation.correctness === "unknown"
				? "Existing result is unknown. Inspect or reconcile its original operation and receipt before considering any new side effect; do not infer that resubmission is safe."
				: "This records an existing evaluation only. Parent, conditions and change summary are model declarations, not host-proven causality. Equal source bytes are planning facts, not a rejection. A negative finding can guide repair, but does not satisfy the original goal; exploration parent and verified incumbent remain separate." }) };
	};
	return {
		name: "candidate_evaluate",
		description: "Freeze candidate source and original receipt files already in this task's work directory, then obtain immediate trusted host observations and the host's deterministic judgement. One candidate declares one strategy at one location. This tool never submits, compiles or reruns a candidate.",
		params: {
			sourcePaths: { type: "string[]", description: "Exact relative source file paths in this task work directory" },
			receiptPaths: { type: "string[]", description: "Exact relative original platform receipt file paths" },
			hypothesis: { type: "string", description: "What this candidate tests or changes" },
			changeKind: { type: "string", description: "repair, structure, or parameters" },
			intent: { type: "string", description: "solution or diagnostic" },
			parentCandidateId: { type: "string", description: "Earlier local Cxxx or exact same-goal Txxx/Cxxx candidate reference, if declared as parent", optional: true },
			conditions: { type: "string[]", description: "Optional model-declared applicability or prerequisites; not host-verified causal facts", optional: true },
			changeSummary: { type: "string", description: "Optional model-declared description of the actual source change", optional: true },
			strategy: { type: "string", description: `One enumerated optimization strategy: ${CANDIDATE_STRATEGIES.join(", ")}` },
			location: { type: "string", description: "The exact edit site: one declared source path, optionally with :symbol or :line or :from-to inside it" },
			newEvidence: { type: "string", description: "Only when repeating a banned direction after a stall: what measured evidence changed since", optional: true },
		},
		execute(args) {
			const current = tail.then(() => run(args));
			tail = current.then(() => undefined, () => undefined);
			return current;
		},
	};
}
