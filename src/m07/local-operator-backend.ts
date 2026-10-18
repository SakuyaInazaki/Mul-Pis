/** Concrete task-contract Python evaluator. Host configuration, never model-selected commands. */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { promisify } from "node:util";
import { copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createMacOSWriteSandboxProfile } from "../runner/execution-sandbox.ts";
import { createCandidateCommandBackend } from "./candidate-command-backend.ts";
import type { CandidateExecutionBackend, CandidateExecutionContext,
	CandidateExecutionStageResult } from "./candidate-runner.ts";
import type { CandidateVerifier, FrozenCandidateFile } from "./candidate-evaluation.ts";
import type { CandidateCaseObservationV1, CandidateDiagnosticV1, CandidateMetricV1 } from "./types.ts";
import { captureNcuProfile, exportNcuReportCsv, parseNcuRawCsv } from "./candidate-performance.ts";
import { loadPlatformProfile, type PlatformProfileV1 } from "../platform/profile.ts";
import { diagnosePlatformOutput } from "../platform/diagnostics.ts";
import { acquireDeviceLease } from "../platform/device-lease.ts";
import { derivePlatformTaskBinding, describePlatformTaskBinding,
	type PlatformTaskBindingV1 } from "./platform-task-contract.ts";
import { EvaluationCache, evaluationCacheKey, type EvaluationCacheKeyParts } from "./evaluation-cache.ts";
import { checkCandidate, type StaticCheckReport } from "../knowledge/static-checks.ts";
import { validateOptimizationCard, type OptimizationCard } from "../knowledge/optimization-card.ts";

export interface LocalOperatorBackendOptions {
	id: string;
	version: string;
	protocolId: string;
	/** Exact subject authorized by this host's fixed task contract, never model-selected. */
	subjectId: string;
	pythonExecutable: string;
	/** Trusted task module; SPEC/reference/baselines define the science. Optional
	 * compile_candidate(source_path, build_dir) and bind_compiled(candidate, build_dir)
	 * compile once and bind the frozen products for correctness and measurement.
	 * An optional classify_candidate_call(source, AST node, usage) can classify
	 * task-specific call shapes (usage: call, callback or metaclass). It must
	 * return {allowed: bool, reason: nonempty string}; approved shapes still
	 * require isolated runtime checks. */
	contractPath: string;
	/** Non-macOS hosts must supply an actual isolation command, never an empty fallback.
	 * The host is responsible for this prefix's policy. macOS uses the built-in write sandbox. */
	workerIsolationPrefix?: readonly [string, ...string[]];
	/** Host-selected runtime variables shared by independent workers and profiler capture.
	 * HOME and TMPDIR remain private to each worker scratch directory. */
	workerEnvironment?: Record<string, string>;
	/** Optional real NCU capture, additional to unprofiled timing. Never chosen by candidate config. */
	profiling?: { caseId: string; launchId?: string; timeoutMs: number };
	/** Host-probed platform profile. When present it, not the task contract,
	 * fixes the timing protocol, the dtype tolerance and the case table; the
	 * contract may only agree with it. */
	platformProfilePath?: string;
	/** Which declared dtype the derived tolerance comes from. */
	platformDtype?: string;
	/** Cases the candidate may iterate on; the rest of the table certifies. */
	platformPublicCases?: number;
	/** Frozen published knowledge cards. Their API signatures and hard numeric
	 * constraints become a pre-compile gate rather than a tool the session may
	 * remember to call. */
	knowledgeCardsPath?: string;
	/** Directory for replaying identical evaluations instead of re-measuring. */
	evaluationCacheDir?: string;
}

interface LocalDecision {
	tier: string;
	verdict: "faster" | "slower" | "tie" | "quarantined";
	pairedRatioMedian: number;
	minimumImprovementThreshold: number;
	endToEndAdmissible?: boolean;
	confirmed?: boolean;
}
interface LocalCase {
	caseId: string;
	scope?: "kernel" | "end-to-end";
	orderingStability?: { kendallTauBMedian?: number; pairwiseFlipRate?: number };
	passed: boolean;
	degenerate?: boolean;
	performanceDecidable?: boolean;
	performanceUndecidableReason?: string;
	replacedApiClean?: boolean;
	decisions?: Record<string, LocalDecision>;
	correctnessFromPreviousStage?: boolean;
	failureRole?: string;
	samplesSeconds?: number[];
	comparisons?: unknown[];
	error?: string;
	measurementError?: string;
	baselines?: Record<string, { samplesSeconds: number[]; comparisons: unknown[]; pairedCandidateToBaselineRatios?: number[] }>;
}
interface LocalIntegrity {
	declaredCases: number;
	decidingCases: number;
	degenerateCases: number;
	rejectedVariants: number;
	nondeterministicCases: number;
	replacedApiCases: number;
	passedWithFunctionalChecks: boolean;
	passedWithNumericComparisonOnly: boolean;
}
interface LocalReceipt {
	version: number;
	kind: string;
	identity: { goalRunId: string; taskId: string; operationId: string; runId: string; subjectId?: string };
	protocolId: string;
	stage: string;
	capturedAt: string;
	contractSha256?: string;
	compilationScope?: "python-only" | "task-native-and-python";
	nativeCompilation?: { passed: boolean; diagnostics: string; artifacts?: string[]; retainedArtifacts?: string[] };
	parameterValidation?: { valid: boolean; reason: string };
	timingProtocol?: { repeats: number; warmup: number; minimumSampleSeconds: number };
	timingExecution?: string;
	measurementEnvironment?: { environmentId: string; clockPolicy: string; precision: string; cacheState: "cold" | "warm" };
	platformBinding?: { profileId: string; chip: string; toolchain: string; protocolVersion: string;
		latencySource: string; metricSource: string; unalignedFraction: number };
	baselineTiers?: Record<string, string>;
	hiddenVariants?: string[];
	passed: boolean;
	inconclusive?: boolean;
	correctnessPassed?: boolean;
	measurementComparable?: boolean | null;
	measurementNotComparable?: string[];
	aggregate?: Record<string, { declaredCases: number; decidableCases: number; fasterCases: number;
		successRate?: number | null; geometricMeanSpeedupAllDecidable?: number | null;
		medianSpeedupAllDecidable?: number | null; geometricMeanSpeedupFasterOnly?: number | null }>;
	integrity?: LocalIntegrity;
	error?: string;
	api?: { unresolvedCalls?: unknown[] };
	caseSummaries?: Array<{ id: string; scope: string }>;
	cases?: LocalCase[];
	profile?: { caseId: string; status: string; reason: string; csvPath?: string; reportPath?: string; launchId?: string };
}
interface BoundJournal {
	kind: string;
	subjectId?: string;
	goalRunId: string;
	taskId: string;
	operationId: string;
	runId: string;
	backend: { id: string; version: string };
	sources: Array<{ frozenPath: string }>;
	stages: Array<{ stage: { id: string }; status: string; receiptSnapshots?: Array<{ originalPath: string; frozenPath: string }> }>;
}
const script = fileURLToPath(new URL("../../scripts/local-operator-stage.py", import.meta.url));

/** Host-frozen published cards. An entry the card schema rejects is dropped
 * rather than guessed at: a gate built on a malformed card would reject real
 * candidates for the wrong reason. */
function parseKnowledgeCards(value: unknown): Array<{ ref: string; card: OptimizationCard }> {
	if (!Array.isArray(value)) throw new Error("knowledge cards file must contain an array");
	const cards: Array<{ ref: string; card: OptimizationCard }> = [];
	for (const [index, item] of value.entries()) {
		if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`knowledge card ${index} is not an object`);
		const entry = item as { ref?: unknown; card?: unknown };
		if (typeof entry.ref !== "string" || !entry.ref.trim()) throw new Error(`knowledge card ${index} has no ref`);
		const parsed = validateOptimizationCard(entry.card);
		if (!parsed.card) throw new Error(`knowledge card ${entry.ref} is invalid: ${parsed.issues.join("; ")}`);
		cards.push({ ref: entry.ref, card: parsed.card });
	}
	return cards;
}
const runHostCommand = promisify(execFile);
const stages = ["contract", "compile", "correctness", "measurement"] as const;
const timingExecution = "interleaved-persistent-v2";
const median = (values: number[]) => { const sorted = [...values].sort((a, b) => a - b), i = Math.floor(sorted.length / 2);
	return sorted.length % 2 ? sorted[i] : (sorted[i - 1] + sorted[i]) / 2; };
const safeId = (value: string) => /^[A-Za-z0-9][A-Za-z0-9_-]*$/u.test(value);
const inside = (root: string, file: string) => file.startsWith(root + path.sep);

export interface LocalOperatorMutationReportV1 {
	version: 1;
	kind: "local-operator-mutation-report";
	protocolId: string;
	mutants: Array<{ name: string; family: string; static: boolean; staticRejection?: string;
		correctnessPassed?: boolean; inconclusive?: boolean; detected: boolean }>;
	declared: number;
	detected: number;
	detectionRate: number | null;
	/** Escape rates differ by an order of magnitude between fault families, so
	 * one overall number is not an answer. */
	families: Record<string, { declared: number; detected: number; escapeRate: number }>;
	/** Properties of the task itself: a reference that cannot grade anything. */
	taskAudit: { cases: Array<{ caseId: string; set: string; outputRange: number | null;
		outputStdev?: number; meanMagnitude: number | null; inputSensitive?: boolean;
		referenceVersusGolden?: number; degenerateByRule: string[]; error?: string }>;
		degenerateCases: string[] };
	limitation: string;
}

export interface LocalOperatorCertificationV1 {
	version: 1;
	kind: "local-operator-certification";
	protocolId: string;
	iterationCases: number;
	certificationCases: number;
	cases: Array<{ caseId: string; set: string; scope: string; passed: boolean;
		degenerate?: boolean; inconclusive: boolean }>;
	decidableCases: number;
	passedCases: number;
	conditionalCorrectness: number | null;
	passed: boolean;
	limitation: string;
}

export interface LocalOperatorEvaluationProfileV1 {
	version: 1;
	kind: "local-operator-evaluation-profile";
	/** Hallucinated APIs rejected locally, and how often a nearest legal
	 * signature could be offered with the rejection. */
	apiGate: { rejected: number; checked: number; suggested: number; nearestSignatureRate: number | null };
	cache?: { hits: number; misses: number; storedEntries: number; entriesOnDisk: number;
		executedMsByStage: Record<string, number>; replacedMsByStage: Record<string, number> };
	platform?: { profileId: string; protocolVersion: string };
}

/** Returns the host bindings plus the audit and certification entry points; no
 * service/controller protocol is added. */
export async function createLocalOperatorBackend(options: LocalOperatorBackendOptions): Promise<{
	backend: CandidateExecutionBackend; verifier: CandidateVerifier;
	auditChecks(): Promise<LocalOperatorMutationReportV1>;
	certifyCandidate(sourcePath: string): Promise<LocalOperatorCertificationV1>;
	evaluationProfile(): Promise<LocalOperatorEvaluationProfileV1>;
}> {
	for (const value of [options.pythonExecutable, options.contractPath]) if (!path.isAbsolute(value)) throw new Error("local operator host paths must be absolute");
	if (!/^[A-Za-z][A-Za-z0-9._:-]{0,95}$/u.test(options.id) || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(options.version) ||
		!options.protocolId || options.protocolId.length > 160) throw new Error("invalid local operator host identity");
	if (`${options.id}:${options.version}:${options.protocolId}`.length > 170 || options.protocolId.includes("\0"))
		throw new Error("local operator measurement basis must leave space for exact task case identity");
	if (typeof options.subjectId !== "string" || !options.subjectId.trim() || options.subjectId.length > 128 || options.subjectId.includes("\0"))
		throw new Error("local operator host configuration requires an explicit subjectId of at most 128 characters");
	const subjectId = options.subjectId;
	if (options.workerIsolationPrefix && (!path.isAbsolute(options.workerIsolationPrefix[0]) || options.workerIsolationPrefix.some(value => !value || value.includes("\0"))))
		throw new Error("worker isolation prefix must be a fixed absolute host executable and arguments");
	if (options.workerEnvironment !== undefined && (!options.workerEnvironment || typeof options.workerEnvironment !== "object" ||
		Array.isArray(options.workerEnvironment) || Object.entries(options.workerEnvironment).some(([name, value]) =>
			!(/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) || name === "HOME" || name === "TMPDIR" ||
			typeof value !== "string" || value.includes("\0"))))
		throw new Error("workerEnvironment must be a host-owned string map without HOME or TMPDIR overrides");
	const workerEnvironment = { PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "C.UTF-8", ...options.workerEnvironment };
	if (options.profiling && (!options.profiling.caseId || !Number.isFinite(options.profiling.timeoutMs) || options.profiling.timeoutMs <= 0))
		throw new Error("profiling needs an explicit caseId and positive capture timeout");
	const contractPath = await realpath(options.contractPath);
	await realpath(options.pythonExecutable); // Validate the host entrypoint without discarding a virtualenv symlink.
	const python = options.pythonExecutable;
	const contractSource = await readFile(contractPath, "utf8");
	const contractDigest = createHash("sha256").update(Buffer.from(contractSource, "utf8")).digest("hex");
	const assertContract = async () => { if (await readFile(contractPath, "utf8") !== contractSource) throw new Error("host operator contract changed; bind a new version before executing"); };
	// The platform profile, when the host supplies one, is the measurement
	// contract: the binding below is what the evaluator enforces, and the task
	// contract is only allowed to agree with it.
	const platformProfile = options.platformProfilePath === undefined ? undefined :
		await loadPlatformProfile(options.platformProfilePath);
	if (platformProfile && !options.platformDtype)
		throw new Error("a bound platform profile needs an explicit platformDtype for its tolerance");
	const platformBinding = platformProfile ?
		derivePlatformTaskBinding(platformProfile, { dtype: options.platformDtype!,
			...(options.platformPublicCases === undefined ? {} : { publicCases: options.platformPublicCases }) }) : undefined;
	// A published card's API signatures and hard numeric budgets are a local,
	// zero-device rejection. Frozen once here, they cannot drift mid-run, and
	// they are a gate rather than a tool the session may remember to call.
	const knowledgeCards = options.knowledgeCardsPath === undefined ? undefined :
		parseKnowledgeCards(JSON.parse(await readFile(options.knowledgeCardsPath, "utf8")));
	const cache = options.evaluationCacheDir === undefined ? undefined :
		new EvaluationCache(options.evaluationCacheDir);
	if (cache) await mkdir(options.evaluationCacheDir!, { recursive: true });
	const gateCounters = { rejected: 0, checked: 0, suggested: 0 };
	const capabilityScratch = await mkdtemp(path.join(tmpdir(), "local-operator-capability-"));
	const capabilityOutput = await (async () => {
		try {
			// The binding reaches validation even here: a contract that declares a
			// platform tolerance cannot be loaded without the profile behind it.
			if (platformBinding) await writeFile(path.join(capabilityScratch, "worker-options.json"),
				JSON.stringify({ platformBinding }), { flag: "wx" });
			return await runHostCommand(python, ["-I", script, "--goal-capability", contractPath,
				...(platformBinding ? [path.join(capabilityScratch, "worker-options.json")] : [])],
			{ timeout: 30_000, maxBuffer: 1_000_000,
				env: { ...workerEnvironment, HOME: capabilityScratch, TMPDIR: capabilityScratch } }); }
		finally { await rm(capabilityScratch, { recursive: true, force: true }); }
	})();
	await assertContract();
	const goalCapability = JSON.parse(capabilityOutput.stdout) as { configured?: unknown; workerTimeoutSeconds?: unknown;
		workerOutputBytes?: unknown; measurementEnvironment?: { environmentId?: unknown } };
	if (typeof goalCapability.configured !== "boolean" || typeof goalCapability.workerTimeoutSeconds !== "number" ||
		!Number.isFinite(goalCapability.workerTimeoutSeconds) || goalCapability.workerTimeoutSeconds <= 0 ||
		!Number.isSafeInteger(goalCapability.workerOutputBytes) || (goalCapability.workerOutputBytes as number) <= 0 ||
		typeof goalCapability.measurementEnvironment?.environmentId !== "string" ||
		!goalCapability.measurementEnvironment.environmentId.trim() ||
		goalCapability.measurementEnvironment.environmentId.length > 64)
		throw new Error("host operator goal capability is invalid");
	const goalTimeoutSeconds = goalCapability.workerTimeoutSeconds;
	const goalOutputBytes = goalCapability.workerOutputBytes as number;
	// A measured number is only comparable within the environment that produced
	// it, so the declared environment identity is part of every basis.
	const environmentId = goalCapability.measurementEnvironment.environmentId;
	// A latency only compares with another latency taken under the same
	// protocol version, so that version is part of the basis itself.
	const protocolScope = platformBinding ? `${options.protocolId}@${platformBinding.protocolVersion}` : options.protocolId;
	const basisFor = (scope: string, kind = "case") => JSON.stringify([options.id, options.version, protocolScope, subjectId, kind, scope, environmentId]);
	if (basisFor("x".repeat(80), "profile").length > 256)
		throw new Error("local host measurement identity including subjectId and declared environment must fit the 256-character basis contract with an 80-character case id; choose concise host identity fields");
	const backend: CandidateExecutionBackend = {
		id: options.id, version: options.version, protocolIds: [options.protocolId],
		configurationHelp: `Host-bound subjectId: ${JSON.stringify(subjectId)}. One Python candidate module. The host task contract fixes case shapes/distributions/seeds, reference, allowed APIs, kernel symbol, tolerance, synchronization and named baselines; optional classify_candidate_call may approve exact task-owned call shapes for isolated runtime validation, and optional compile_candidate runs its real native compiler before correctness. Original-goal host verification: ${goalCapability.configured ? "configured by verify_goal" : "unconfigured; a continuous candidate goal cannot be fulfilled through this entry"}. configJson may contain only parameters; the trusted contract can reject a tuple before compilation. No model-selected subject, commands or validation rules.`,
		stages: stages.map(id => ({ id, mode: "local", checks: [id] })),
		async validateRequest(request) {
			await assertContract();
			if (request.subjectId !== subjectId) throw new Error("candidate task subjectId does not match the host-bound local operator subject");
			if (request.protocolId !== options.protocolId || request.sourcePaths.length !== 1 || Object.keys(request.config).some(key => key !== "parameters"))
				throw new Error("local operator request must use its bound protocol, one source, and no evaluation overrides");
		},
		async executeStage(ctx) {
			if (ctx.subjectId !== subjectId) throw new Error("candidate execution subjectId does not match the host-bound local operator subject");
			await assertContract();
			await mkdir(ctx.outputDir, { recursive: true });
			const startedAtMs = Date.now();
			const receiptIdentity = { goalRunId: ctx.goalRunId, taskId: ctx.taskId, operationId: ctx.operationId,
				runId: ctx.runId, subjectId };
			// A published signature table rejects a hallucinated API here, before
			// a compiler is started: the local rejection costs nothing, and the
			// finding carries the nearest legal signature with it.
			if (ctx.stage.id === "contract" && knowledgeCards?.length) {
				const source = await readFile(ctx.sources[0].frozenPath, "utf8");
				const report = checkCandidate({ source }, knowledgeCards);
				gateCounters.checked += report.checkedSymbols.length;
				if (report.status === "reject") {
					gateCounters.rejected++;
					gateCounters.suggested += report.findings.filter(item => item.suggestion).length;
					return writeGateRejection(ctx, receiptIdentity, report);
				}
			}
			// An identical candidate, contract, platform and protocol has already
			// been evaluated: replay that receipt rather than spend the device
			// again. The entry is marked, so no statistic counts it twice.
			const cacheParts = cache ? await cacheKeyFor(ctx) : undefined;
			const cacheKey = cacheParts && evaluationCacheKey(cacheParts);
			if (cache && cacheKey) {
				const entry = await cache.read(cacheKey);
				if (entry) {
					const restored = await cache.restore(entry, ctx.outputDir);
					return { status: entry.status,
						summary: `${entry.summary} (replayed from an identical evaluation recorded ${entry.capturedAt})`,
						receiptPaths: restored.map(file => path.relative(ctx.workDir, file)),
						evaluationReceiptPaths: entry.evaluationReceiptNames.map(name =>
							path.relative(ctx.workDir, path.join(ctx.outputDir, name))),
						...(entry.performedChecks ? { performedChecks: entry.performedChecks } : {}) };
				}
			}
			// Reuse exact compile-stage snapshots, never discover candidate-written
			// artifacts or silently recompile during correctness or measurement.
			const compiledInputs: Array<{ file: string; frozenPath: string }> = [];
			let compiledBuildDir: string | undefined;
			if (ctx.stage.id === "correctness" || ctx.stage.id === "measurement") {
				const journal = await authority(ctx.workDir, ctx);
				const compiled = journal.stages[1];
				if (compiled?.stage.id !== "compile" || compiled.status !== "passed") throw new Error("artifact loading requires the passed compile journal");
				const snapshots = compiled.receiptSnapshots ?? [];
				const evaluations = snapshots.filter(item => path.basename(item.originalPath) === "evaluation.json");
				if (evaluations.length !== 1) throw new Error("compile receipt must be uniquely bound");
				const receipt = JSON.parse(await readFile(evaluations[0].frozenPath, "utf8")) as LocalReceipt;
				if (receipt.contractSha256 !== contractDigest || receipt.protocolId !== options.protocolId || receipt.identity.runId !== ctx.runId || !receipt.passed)
					throw new Error("compile artifacts belong to a different contract/run");
				if (receipt.compilationScope === "task-native-and-python") {
					const native = receipt.nativeCompilation;
					if (!native?.passed || !native.artifacts?.length || native.artifacts.length !== native.retainedArtifacts?.length)
						throw new Error("native compiler omitted its successful artifact manifest");
					compiledBuildDir = await mkdtemp(path.join(ctx.outputDir, "compiled-inputs-"));
					for (const [index, relative] of native.artifacts.entries()) {
						if (path.isAbsolute(relative) || relative.split(/[\\/]/u).some(part => !part || part === "." || part === "..")) throw new Error("invalid compiled artifact tree path");
						const bound = snapshots.filter(item => path.resolve(ctx.workDir, item.originalPath) === native.retainedArtifacts![index]);
						if (bound.length !== 1) throw new Error("compiled artifact lacks a unique frozen stage receipt");
						const file = path.join(compiledBuildDir, relative);
						await mkdir(path.dirname(file), { recursive: true });
						await copyFile(bound[0].frozenPath, file);
						compiledInputs.push({ file, frozenPath: bound[0].frozenPath });
					}
				}
			}
			const assertCompiledInputs = async () => {
				for (const item of compiledInputs) if (!(await readFile(item.file)).equals(await readFile(item.frozenPath)))
					throw new Error("native compile artifact changed during execution");
			};
			await assertCompiledInputs();
			const scratchRoot = await mkdtemp(path.join(ctx.outputDir, "workers-"));
			const logsRoot = await mkdtemp(path.join(ctx.outputDir, "worker-logs-"));
			const profile = options.workerIsolationPrefix ? undefined : await createMacOSWriteSandboxProfile({ writableRoots: [scratchRoot], cwd: scratchRoot, denyNetwork: true });
			const commandPrefix = options.workerIsolationPrefix ? [...options.workerIsolationPrefix] : profile ? ["/usr/bin/sandbox-exec", "-p", profile] : undefined;
			if (!commandPrefix) throw new Error("local operator workers require an available write isolation mechanism; no unsandboxed fallback");
			const workerOptions = path.join(ctx.outputDir, `worker-options-${path.basename(scratchRoot)}.json`);
			await writeFile(workerOptions, JSON.stringify({ scratchRoot, logsRoot, commandPrefix, compiledBuildDir,
				workerEnvironment, platformBinding }), { flag: "wx" });
			const command = { argv: [python, "-I", script, contractPath, workerOptions] as [string, ...string[]],
				cwd: ctx.outputDir, env: { ...workerEnvironment, HOME: scratchRoot, TMPDIR: scratchRoot } };
			const adapter = createCandidateCommandBackend({ id: options.id, version: options.version,
				stages: stages.map(id => ({ id, mode: "local", checks: [id], execute: command })) });
			// Only the timing stage needs a quiet machine. Holding the device for
			// import, compilation and correctness as well would serialize the
			// expensive part of the run for no gain in measurement fidelity.
			const lease = ctx.stage.id === "measurement" && platformProfile?.deviceSerialization ?
				await acquireDeviceLease({ file: path.resolve(ctx.workDir, platformProfile.deviceSerialization.leaseFile),
					platformId: platformProfile.id, purpose: `measurement ${ctx.runId}`,
					timeoutMs: platformProfile.deviceSerialization.timeoutMs }) : undefined;
			const result = await (async () => {
				try { return await adapter.executeStage(ctx); }
				finally { if (lease) await lease.release(); }
			})();
			cache?.recordExecution(ctx.stage.id, Date.now() - startedAtMs);
			const retainLogs = async (directory: string): Promise<void> => {
				for (const entry of await readdir(directory, { withFileTypes: true })) {
					const file = path.join(directory, entry.name);
					if (entry.isDirectory()) await retainLogs(file);
					else if (entry.isFile()) result.receiptPaths.push(path.relative(ctx.workDir, file));
				}
			};
			await retainLogs(logsRoot);
			result.receiptPaths.push(...compiledInputs.map(item => path.relative(ctx.workDir, item.file)));
			await assertContract();
			if (options.profiling && ctx.stage.id === "measurement" && result.status === "passed") {
				const receiptPath = path.join(ctx.workDir, result.evaluationReceiptPaths![0]);
				const receipt = JSON.parse(await readFile(receiptPath, "utf8")) as LocalReceipt;
				const summary = receipt.caseSummaries?.find(item => item.id === options.profiling!.caseId);
				if (!summary) throw new Error("host profiler case is absent from the task contract");
				const profileDir = await mkdtemp(path.join(path.dirname(receiptPath), "profile-"));
				// The contract materializes its own case input: declared values
				// never pass through a retained receipt the candidate can read.
				const input = path.join(profileDir, "input.json");
				await runHostCommand(python, ["-I", script, "--case-input", contractPath, summary.id, input, compiledBuildDir ?? ""],
					{ timeout: 30_000, maxBuffer: 1_000_000, env: { ...workerEnvironment, HOME: scratchRoot, TMPDIR: scratchRoot } });
				const invocation = [...commandPrefix, python, "-I", script, "--worker", contractPath, ctx.sources[0].frozenPath, "candidate", "--worker-input", input];
				const capture = await captureNcuProfile({ executable: invocation[0], argv: invocation.slice(1), cwd: scratchRoot,
					environment: { ...workerEnvironment, HOME: scratchRoot, TMPDIR: scratchRoot },
					reportBase: path.join(profileDir, "capture"), timeoutMs: options.profiling.timeoutMs, signal: ctx.signal });
				await rm(input, { force: true });
				receipt.profile = { caseId: summary.id, status: capture.status, reason: capture.reason,
					...(options.profiling.launchId ? { launchId: options.profiling.launchId } : {}) };
				const captureLog = path.join(profileDir, "capture.json");
				await writeFile(captureLog, JSON.stringify(capture), { flag: "wx" });
				result.receiptPaths.push(path.relative(ctx.workDir, captureLog));
				if (capture.reportPath) {
					const csv = path.join(profileDir, "raw.csv");
					const exported = await exportNcuReportCsv(capture.reportPath, csv);
					result.receiptPaths.push(path.relative(ctx.workDir, capture.reportPath));
					receipt.profile.reportPath = path.relative(ctx.workDir, capture.reportPath);
					if (exported.status === "exported") {
						receipt.profile.csvPath = path.relative(ctx.workDir, csv);
						result.receiptPaths.push(receipt.profile.csvPath);
						result.evaluationReceiptPaths!.push(receipt.profile.csvPath);
					} else receipt.profile.reason += `; ${exported.reason}`;
				}
				await writeFile(receiptPath, JSON.stringify(receipt, null, 2) + "\n");
				await assertContract();
			}
			await assertCompiledInputs();
			if (cache && cacheKey && cacheParts) {
				// Everything this stage produced, including its nested worker logs,
				// keeps its place under the output directory. A partial entry would
				// replay a stage whose own evidence is missing, so an entry is only
				// stored when every receipt belongs to this stage's tree.
				const root = path.resolve(ctx.outputDir);
				const within = (relative: string): string | undefined => {
					const file = path.resolve(ctx.workDir, relative);
					const inside = path.relative(root, file);
					return inside && !inside.startsWith("..") && !path.isAbsolute(inside) ? inside : undefined;
				};
				const names = result.receiptPaths.map(relative => ({ name: within(relative),
					file: path.resolve(ctx.workDir, relative) }));
				const evaluations = (result.evaluationReceiptPaths ?? []).map(within);
				if (names.length && evaluations.length && names.every(item => item.name !== undefined) &&
					evaluations.every(name => name !== undefined))
					await cache.store(cacheKey, cacheParts, { status: result.status === "passed" ? "passed" : "failed",
						summary: result.summary ?? ctx.stage.id, ...(result.performedChecks ? { performedChecks: result.performedChecks } : {}),
						receipts: names as Array<{ name: string; file: string }>,
						evaluationNames: evaluations as string[], runId: ctx.runId });
			}
			return result;
		},
	};

	/** The cache key's source digest is the parsed program, so a comment or a
	 * reformat does not look like new work. The contract supplies it, because
	 * the contract is what would actually run. */
	async function normalizedSourceDigest(file: string): Promise<string> {
		const output = await runHostCommand(python, ["-I", script, "--normalize-source", file],
			{ timeout: 30_000, maxBuffer: 1_000_000, env: { ...workerEnvironment, HOME: tmpdir(), TMPDIR: tmpdir() } });
		const parsed = JSON.parse(output.stdout) as { sha256?: unknown };
		if (typeof parsed.sha256 !== "string" || !/^[0-9a-f]{64}$/u.test(parsed.sha256))
			throw new Error("source normalization did not return a digest");
		return parsed.sha256;
	}

	async function cacheKeyFor(ctx: CandidateExecutionContext): Promise<EvaluationCacheKeyParts> {
		return { backendId: options.id, backendVersion: options.version, protocolId: options.protocolId,
			subjectId, stageId: ctx.stage.id,
			sourceDigest: await normalizedSourceDigest(ctx.sources[0].frozenPath),
			contractDigest,
			platformKey: platformBinding ? `${platformBinding.chip}/${platformBinding.toolchain}` : "unbound",
			protocolVersion: platformBinding?.protocolVersion ?? "unversioned",
			caseSetId: platformBinding ? platformBinding.cases.map(item => item.id).join(",") : "contract" };
	}

	/** A gate rejection is a real stage result with its own frozen receipt, so
	 * the cascade stops here and the findings reach the next round as evidence. */
	async function writeGateRejection(ctx: CandidateExecutionContext, identity: LocalReceipt["identity"],
		report: StaticCheckReport): Promise<CandidateExecutionStageResult> {
		const receipt: LocalReceipt & { knowledgeGate: StaticCheckReport } = {
			version: 1, kind: "local-operator-evaluation", identity, protocolId: options.protocolId,
			stage: ctx.stage.id, capturedAt: new Date().toISOString(), contractSha256: contractDigest,
			passed: false, inconclusive: false,
			error: `published API contract rejected this candidate before compilation: ${report.findings.map(item => item.witness).join(", ")}`,
			knowledgeGate: report,
		};
		const file = path.join(ctx.outputDir, "evaluation.json");
		await writeFile(file, `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx" });
		const relative = path.relative(ctx.workDir, file);
		return { status: "failed", summary: `${ctx.stage.id}: rejected by the published API contract before compilation`,
			receiptPaths: [relative], evaluationReceiptPaths: [relative], performedChecks: ctx.stage.checks };
	}

	async function authority(taskWork: string, identity: LocalReceipt["identity"]): Promise<BoundJournal> {
		const { runId, taskId, goalRunId, operationId } = identity;
		if (identity.subjectId !== subjectId) throw new Error("local receipt subject differs from the host-bound subject");
		if (![runId, taskId, operationId, goalRunId].every(safeId)) throw new Error("invalid original local execution identity");
		const root = await realpath(path.join(path.dirname(taskWork), "candidate-runs"));
		const files = [path.join(root, runId, "journal.json")];
		const sweep = /^(.*)--([1-9]\d*)$/u.exec(runId);
		if (sweep && safeId(sweep[1])) files.push(path.join(root, sweep[1], "runs", sweep[2], "journal.json"));
		for (const file of files) {
			let journal: BoundJournal;
			try { if (!inside(root, await realpath(file))) continue; journal = JSON.parse(await readFile(file, "utf8")); }
			catch { continue; }
			if (journal.kind === "candidate" && journal.runId === runId && journal.goalRunId === goalRunId && journal.taskId === taskId &&
				journal.operationId === operationId && journal.subjectId === subjectId && journal.backend.id === options.id && journal.backend.version === options.version) return journal;
		}
		throw new Error("no exact host local execution journal");
	}
	const verifier: CandidateVerifier = {
		id: options.id, version: options.version,
		async verifyTask({ goal, task, sources, receipts }) {
			const unknown = (reason: string) => ({ sourceBinding: "unknown" as const, correctness: "unknown" as const,
				stage: "local-evidence-unavailable", metrics: [], limitations: [reason.slice(0, 1800)] });
			try {
				if (task.subjectId !== subjectId) return unknown("task subjectId differs from the host-bound local operator subject");
				await assertContract();
				let receipt: LocalReceipt | undefined, receiptIndex = -1;
				for (let index = 0; index < receipts.length; index++) {
					try {
						const parsed = JSON.parse(await readFile(receipts[index].frozenPath, "utf8")) as LocalReceipt;
						if (parsed.kind === "local-operator-evaluation") { if (receipt) throw new Error("multiple evaluation receipts"); receipt = parsed; receiptIndex = index; }
					} catch (error) { if (!(error instanceof SyntaxError)) throw error; }
				}
				if (!receipt || receipt.version !== 1 || receipt.protocolId !== options.protocolId || receipt.contractSha256 !== contractDigest ||
					receipt.identity.goalRunId !== goal.runId || receipt.identity.taskId !== task.taskId || receipt.identity.subjectId !== task.subjectId)
					return unknown("receipt is not bound to this goal/task, source contract or protocol");
				if (receipt.timingExecution !== undefined && receipt.timingExecution !== timingExecution)
					return unknown("measurement receipt declares an unrecognized timing execution protocol");
				const journal = await authority(task.workDir, receipt.identity);
				const stageIndex = stages.findIndex(stage => stage === receipt!.stage);
				if (stageIndex < 0 || journal.stages[stageIndex]?.stage.id !== receipt.stage ||
					journal.stages[stageIndex].status !== (receipt.passed ? "passed" : "failed") ||
					journal.stages.slice(0, stageIndex).some((item, index) => item.stage.id !== stages[index] || item.status !== "passed"))
					return unknown("receipt did not pass through the declared host cascade");
				const frozen = journal.stages[stageIndex].receiptSnapshots ?? [];
				for (const file of receipts) if (!await Promise.all(frozen.map(async item => (await readFile(item.frozenPath)).equals(await readFile(file.frozenPath)))).then(matches => matches.some(Boolean)))
					return unknown("candidate receipt differs from the original host-journal stage bytes");
				if (sources.length !== journal.sources.length || !await Promise.all(sources.map(async (source, index) =>
					(await readFile(source.frozenPath)).equals(await readFile(journal.sources[index].frozenPath)))).then(matches => matches.every(Boolean)))
					return unknown("candidate source differs from the host-executed snapshot");
				if (receipt.stage === "measurement" && receipt.cases?.some(row => row.correctnessFromPreviousStage)) {
					const prior = journal.stages[2]?.receiptSnapshots?.filter(item => path.basename(item.originalPath) === "evaluation.json") ?? [];
					if (prior.length !== 1) return unknown("baseline-failure correctness lacks its unique preceding receipt");
					const priorReceipt = JSON.parse(await readFile(prior[0].frozenPath, "utf8")) as LocalReceipt;
					if (priorReceipt.stage !== "correctness" || !priorReceipt.passed || priorReceipt.contractSha256 !== contractDigest ||
						priorReceipt.identity.runId !== receipt.identity.runId ||
						receipt.cases.some(row => row.correctnessFromPreviousStage &&
							!priorReceipt.cases?.some(earlier => earlier.caseId === row.caseId && earlier.passed)))
						return unknown("baseline-failure correctness is not supported by the passed predecessor");
				}
				const basis = basisFor("", "evaluation");
				const inconclusive = Boolean(receipt.inconclusive);
				const scientific = ["correctness", "measurement"].includes(receipt.stage);
				const baselineIncomparable = receipt.stage === "measurement" && receipt.correctnessPassed === true && receipt.measurementComparable === false;
				const correctness = baselineIncomparable ? "passed" as const : !scientific || inconclusive ? "unknown" as const : receipt.passed ? "passed" as const : "failed" as const;
				const cases: CandidateCaseObservationV1[] = [], diagnostics: CandidateDiagnosticV1[] = [];
				const metric = (name: string, value: number, basisId = basis): CandidateMetricV1 => ({ name, value, unit: "s", basisId, direction: "lower" });
				const validSamples = (values: unknown): values is number[] => Array.isArray(values) &&
					Number.isSafeInteger(receipt!.timingProtocol?.repeats) && values.length === receipt!.timingProtocol!.repeats && values.length > 0 &&
					values.every(value => typeof value === "number" && Number.isFinite(value) && value > 0);
				for (const [index, row] of (receipt.cases ?? []).entries()) {
					const samples = validSamples(row.samplesSeconds) ? row.samplesSeconds : [];
					// A case the host declared undecidable (too short to measure, a
					// failed baseline, an unconfirmed or quarantined ratio) contributes
					// no metric at all, so no later layer can rank on it.
					const comparable = receipt.stage === "measurement" && receipt.measurementComparable === true &&
						!inconclusive && row.performanceDecidable === true;
					// ip2 is the compact basis token for interleaved-persistent-v2.
					// It fits the existing 256-character basis envelope even at the
					// previously permitted maximum case/host identity lengths.
					const caseBasis = basisFor(row.caseId, receipt.timingExecution === timingExecution ? "ip2" : "case");
					const pairedBaselines = Object.entries(receipt.timingExecution === timingExecution ? row.baselines ?? {} : {}).filter(([, value]) =>
						validSamples(value.pairedCandidateToBaselineRatios) && value.pairedCandidateToBaselineRatios.every(ratio => ratio > 0));
					// The host's own rulings travel with the case: a later layer must not
					// re-derive "faster" from medians at a different noise scale.
					const verdicts = Object.entries(row.decisions ?? {})
						.filter(([, value]) => value && ["faster", "slower", "tie", "quarantined"].includes(value.verdict) &&
							Number.isFinite(value.pairedRatioMedian) && Number.isFinite(value.minimumImprovementThreshold))
						.map(([name, value]) => ({ baseline: name, ...(value.tier ? { tier: value.tier } : {}),
							verdict: value.verdict, pairedRatioMedian: value.pairedRatioMedian,
							minimumImprovementThreshold: value.minimumImprovementThreshold,
							...(value.endToEndAdmissible === undefined ? {} : { endToEndAdmissible: value.endToEndAdmissible }),
							...(value.confirmed === undefined ? {} : { confirmed: value.confirmed }) }));
					const item: CandidateCaseObservationV1 = { caseId: row.caseId, status: inconclusive ? "inconclusive" : row.passed ? "passed" : "failed",
						...(row.scope ? { scope: row.scope } : {}),
						...(row.performanceDecidable === undefined ? {} : { performanceDecidable: row.performanceDecidable }),
						...(row.performanceUndecidableReason ? { performanceUndecidableReason: row.performanceUndecidableReason } : {}),
						...(verdicts.length ? { verdicts } : {}),
						...(row.orderingStability ? { orderingStability: row.orderingStability } : {}),
						correctness: inconclusive && !baselineIncomparable ? "unknown" : row.passed ? "passed" : "failed",
						metrics: comparable && samples.length ? [metric("elapsed", median(samples), caseBasis),
							...pairedBaselines.map(([name, value]) => ({ name: `candidate/baseline:${name}`, value: median(value.pairedCandidateToBaselineRatios!),
								unit: "ratio", basisId: caseBasis, direction: "lower" as const }))] : [],
						referenceMeasurements: Object.entries(row.baselines ?? {}).filter(([, value]) => validSamples(value.samplesSeconds) &&
							value.comparisons.length === value.samplesSeconds.length && value.comparisons.every(item => (item as { passed?: boolean })?.passed === true))
							.map(([name, value]) => ({ name, value: median(value.samplesSeconds), unit: "s", basisId: caseBasis })) };
					if (samples.length) item.performance = { basisId: caseBasis,
						elapsedSeconds: { value: median(samples), receiptIndex, fieldPath: `cases[${index}].samplesSeconds:median` },
						timingSamplesSeconds: { values: samples, receiptIndex, fieldPath: `cases[${index}].samplesSeconds` },
						...(pairedBaselines.length ? { pairedBaselineRatios: pairedBaselines.map(([name, value]) => ({ name,
							values: value.pairedCandidateToBaselineRatios!, receiptIndex,
							fieldPath: `cases[${index}].baselines[${JSON.stringify(name)}].pairedCandidateToBaselineRatios` })) } : {}) };
					if (!row.passed || inconclusive) {
						const numericalFailure = row.comparisons?.some(value => (value as { passed?: unknown })?.passed === false) === true;
						const category: CandidateDiagnosticV1["category"] = row.error
							? row.failureRole === "candidate" ? "runtime" : "unknown"
							: numericalFailure ? "numerical" : "unknown";
						diagnostics.push({ category, caseId: row.caseId, fieldPath: `cases[${index}]`, rawText: JSON.stringify(row) });
					}
					cases.push(item);
				}
				const environment = receipt.measurementEnvironment;
				const integrity = receipt.integrity;
				const limitations = [receipt.compilationScope === "task-native-and-python"
					? "Task-contract finite numeric JSON evaluation. Native artifacts from compile_candidate are frozen and supplied to bind_compiled before candidate/no-op execution; compiler diagnostics and artifact bytes remain in stage receipts. Device kernel participation remains task-specific."
					: "Task-contract Python evaluation; finite numeric JSON outputs. Compile means Python bytecode validation only; no native compiler was bound.",
					"Timing is synchronized by the task function. Measurement rounds use serial alternating independent persistent workers and named task baselines; host/device isolation, clocks and suitability of task cases are not inferred from a passing result.",
					"No-op sensitivity and replaced-API call counts establish that the declared kernel is reached and that the library entry points it replaces were not called; they do not prove what share of device time runs inside it."];
				if (platformBinding) limitations.push(...describePlatformTaskBinding(platformBinding).map(item => item.slice(0, 1800)));
				if (receipt.platformBinding && receipt.platformBinding.protocolVersion !== platformBinding?.protocolVersion)
					return unknown("receipt was produced under a different platform measurement protocol version");
				if (environment) limitations.push(`Numbers hold only for declared environment ${environment.environmentId} (clocks: ${environment.clockPolicy}; cache state: ${environment.cacheState}; precision policy: ${environment.precision}); they cannot be quoted for another machine, toolchain or precision policy.`.slice(0, 1800));
				if (receipt.baselineTiers) limitations.push(`Baseline denominators by declared tier: ${Object.entries(receipt.baselineTiers).map(([name, tier]) => `${name}=${tier}`).join(", ")}. A ratio against one tier does not transfer to another.`.slice(0, 1800));
				if (receipt.hiddenVariants?.length) limitations.push(`Correctness was judged on the declared values and the host value-only variants ${receipt.hiddenVariants.join(", ")}; variants the reference or a known-correct baseline could not evaluate were dropped rather than charged to the candidate.`.slice(0, 1800));
				if (integrity) limitations.push(`Integrity counters: ${integrity.decidingCases}/${integrity.declaredCases} cases decide, ${integrity.degenerateCases} degenerate, ${integrity.rejectedVariants} variants rejected, ${integrity.nondeterministicCases} nondeterministic, ${integrity.replacedApiCases} calling a replaced library API. Numeric comparison alone would have passed this candidate: ${integrity.passedWithNumericComparisonOnly}; with the functional checks: ${integrity.passedWithFunctionalChecks}.`.slice(0, 1800));
				if (receipt.measurementNotComparable?.length) limitations.push(`No performance comparison: ${receipt.measurementNotComparable.join("; ")}.`.slice(0, 1800));
				if (receipt.cases?.some(row => row.performanceDecidable === false))
					limitations.push(`Cases excluded from performance selection: ${receipt.cases.filter(row => row.performanceDecidable === false).map(row => `${row.caseId}${row.performanceUndecidableReason ? ` (${row.performanceUndecidableReason})` : ""}`).join("; ")}.`.slice(0, 1800));
				if (platformProfile && diagnostics.length) {
					// Cold-start failures are not one bucket: the published split is
					// three quarters syntax-level, a fifth hardware-level and a few
					// percent numeric, and each routes somewhere different.
					const diagnosis = diagnosePlatformOutput(platformProfile, diagnostics.map(item => item.rawText).join("\n"));
					const counts = new Map<string, number>();
					for (const item of diagnosis.classes) counts.set(item.class, (counts.get(item.class) ?? 0) + 1);
					if (counts.size) limitations.push(`Platform failure classes: ${[...counts].map(([name, value]) => `${name}=${value}`).join(", ")}.`.slice(0, 1800));
					for (const hint of diagnosis.symbolHints)
						limitations.push(`Rejected symbol ${hint.used}; nearest legal signatures: ${hint.nearest.join(", ") || "none in the probed surface"}.`.slice(0, 1800));
				}
				if (receipt.api?.unresolvedCalls?.length) limitations.push("Some API calls lack a task-selected mechanically resolvable signature; inspect the raw API diagnostic.");
				if (receipt.nativeCompilation && !receipt.nativeCompilation.passed) diagnostics.push({ category: "compile", fieldPath: "nativeCompilation", rawText: JSON.stringify(receipt.nativeCompilation) });
				if (receipt.parameterValidation?.valid === false) diagnostics.push({ category: "unknown", fieldPath: "parameterValidation",
					rawText: JSON.stringify(receipt.parameterValidation) });
				if (receipt.error || inconclusive) diagnostics.push({ category: receipt.stage === "compile" ? "compile" : "unknown",
						fieldPath: receipt.error ? "error" : "inconclusive", rawText: receipt.error ?? (baselineIncomparable ? "Candidate outputs passed, but candidate timing or a task baseline lacks complete valid measurements; no performance comparison or incumbent promotion." : "Task cases did not completely establish no-op sensitivity or a declared API signature could not be checked.") });
				if (receipt.profile) {
					const profile = receipt.profile;
					const csvOriginal = profile.csvPath ? frozen.filter(file => path.resolve(task.workDir, profile.csvPath!) === file.originalPath) : [];
					const evaluationOriginal = frozen.find(file => path.basename(file.originalPath) === "evaluation.json");
					const csvPath = profile.csvPath && path.resolve(task.workDir, profile.csvPath);
					const evaluationDirectory = evaluationOriginal && path.dirname(path.resolve(task.workDir, evaluationOriginal.originalPath));
					let csvIndex = -1;
					if (profile.status === "captured" && csvOriginal.length === 1 && csvPath && evaluationDirectory && inside(evaluationDirectory, csvPath) &&
						path.basename(path.dirname(csvPath)).startsWith("profile-") && path.basename(csvPath) === "raw.csv") {
						const bytes = await readFile(csvOriginal[0].frozenPath);
						const matches = await Promise.all(receipts.map(async file => bytes.equals(await readFile(file.frozenPath))));
						if (matches.filter(Boolean).length === 1) csvIndex = matches.indexOf(true);
					}
					if (csvIndex >= 0) {
						const parsed = parseNcuRawCsv(await readFile(receipts[csvIndex].frozenPath, "utf8"), { basisId: basisFor(profile.caseId, "profile"), receiptIndex: csvIndex,
							...(profile.launchId ? { launchId: profile.launchId } : {}) });
						const item = cases.find(row => row.caseId === profile.caseId);
						if (item?.correctness === "passed" && parsed.status === "parsed" && parsed.evidence && item.performance)
							item.performance.profiledLaunch = parsed.evidence;
						if (item?.correctness === "passed" && parsed.status === "parsed" && parsed.evidence)
							limitations.push("Structured NCU performance describes the selected instrumented launch, a different basis from unprofiled invocation timing; unprofiled samples and baselines remain in the evaluation receipt and case metrics.");
						limitations.push(`NCU capture/import: ${parsed.status}; ${parsed.reason}`.slice(0, 1800));
					} else limitations.push(`NCU capture: ${profile.status}; ${profile.reason}`.slice(0, 1800));
				}
				// Per-case measurements remain separately comparable; no invented aggregate or acceptance threshold.
				const metrics = correctness === "passed" ? cases.flatMap(item => item.metrics.map(value => ({ ...value, name: `${value.name}:${item.caseId}` }))) : [];
				// The host already reported rate, faster-only and whole-set numbers;
				// carrying them forward keeps a later layer from inventing its own.
				const aggregate = Object.entries(receipt.aggregate ?? {})
					.filter(([, value]) => value && Number.isSafeInteger(value.declaredCases) && Number.isSafeInteger(value.decidableCases))
					.map(([baseline, value]) => ({ baseline, declaredCases: value.declaredCases, decidableCases: value.decidableCases,
						fasterCases: Number.isSafeInteger(value.fasterCases) ? value.fasterCases : 0,
						...(typeof value.successRate === "number" ? { successRate: value.successRate } : {}),
						...(typeof value.geometricMeanSpeedupAllDecidable === "number" ? { geometricMeanSpeedupAllDecidable: value.geometricMeanSpeedupAllDecidable } : {}),
						...(typeof value.medianSpeedupAllDecidable === "number" ? { medianSpeedupAllDecidable: value.medianSpeedupAllDecidable } : {}),
						...(typeof value.geometricMeanSpeedupFasterOnly === "number" ? { geometricMeanSpeedupFasterOnly: value.geometricMeanSpeedupFasterOnly } : {}) }));
				return { sourceBinding: "verified", correctness, stage: inconclusive ? `${receipt.stage}:inconclusive` : receipt.stage,
					metrics, limitations, executionFacts: { evaluations: [{ externalId: receipt.identity.runId,
						subjectId, status: inconclusive ? "inconclusive" : receipt.passed ? "passed" : "failed",
						terminal: true, capturedAt: receipt.capturedAt, receiptIndex, cases, diagnostics,
						...(aggregate.length ? { aggregate } : {}),
						...(receipt.measurementNotComparable?.length ? { measurementNotComparable: receipt.measurementNotComparable } : {}) }] } };
			} catch (error) { return unknown((error as Error).message); }
		},
		...(goalCapability.configured ? { async verifyGoal({ goal, acceptedEvidencePaths }) {
			await assertContract();
			const accepted = new Set(await Promise.all(acceptedEvidencePaths.map(item => realpath(item))));
			const eligible = new Set<string>();
			const observations: Array<{ taskId: string; observationPath: string; observation: Awaited<ReturnType<CandidateVerifier["verifyTask"]>>;
				receipt: LocalReceipt }> = [];
			const seen = new Set<string>();
			for (const task of goal.tasks.filter(item => item.status === "accepted" && item.subjectId === subjectId)) {
				const candidates = [
					...(task.candidateObservation && task.candidate ? [{ observation: task.candidateObservation,
						observationPath: task.candidateObservation.observationPath, sourcePaths: task.candidate.sourcePaths,
						receiptPaths: task.candidate.receiptPaths }] : []),
					...(task.episode?.candidates ?? []).map(item => ({ observation: item.observation, observationPath: item.observationPath,
						sourcePaths: item.sourcePaths, receiptPaths: item.receiptPaths })),
				];
				for (const candidate of candidates) {
					const observationPath = await realpath(candidate.observationPath);
					if (!accepted.has(observationPath) || seen.has(observationPath)) continue;
					seen.add(observationPath);
					const recorded = JSON.parse(await readFile(observationPath, "utf8")) as Record<string, unknown>;
					const sourceFiles = candidate.observation.sourceFiles, receiptFiles = candidate.observation.receiptFiles;
					const expectedFiles = (files: readonly string[], declared: readonly string[]): FrozenCandidateFile[] => {
						if (files.length !== declared.length) throw new Error("candidate declaration differs from frozen file count");
						return files.map((file, index) => {
							const originalPath = path.resolve(task.workDir, declared[index]);
							if (!inside(task.workDir, originalPath)) throw new Error("candidate original file escaped its task work directory");
							return { declaredPath: declared[index], originalPath, frozenPath: file };
						});
					};
					const episode = recorded.sourceFilesRelativeToObservationDir === true;
					if (episode && (!isDeepStrictEqual(recorded.sourcePaths, candidate.sourcePaths) ||
						!isDeepStrictEqual(recorded.receiptPaths, candidate.receiptPaths)))
						throw new Error("accepted episode declaration differs from its frozen observation");
					const portable = episode ? recorded.observation as Record<string, unknown> : recorded;
					const { observationPath: _storedPath, ...stored } = candidate.observation as typeof candidate.observation & { observationPath?: string };
					const normalized = episode && portable && Array.isArray(portable.sourceFiles) && Array.isArray(portable.receiptFiles) ? {
						...portable,
						sourceFiles: (portable.sourceFiles as string[]).map(file => path.join(path.dirname(observationPath), file)),
						receiptFiles: (portable.receiptFiles as string[]).map(file => path.join(path.dirname(observationPath), file)),
					} : portable;
					if (!isDeepStrictEqual(normalized, stored) || stored.verifier.id !== options.id || stored.verifier.version !== options.version)
						throw new Error("accepted candidate observation differs from its frozen source/receipt references");
					const checked = await verifier.verifyTask({ goal, task, sources: expectedFiles(sourceFiles, candidate.sourcePaths),
						receipts: expectedFiles(receiptFiles, candidate.receiptPaths) });
					if (checked.sourceBinding !== "verified" || checked.correctness !== candidate.observation.correctness ||
						checked.stage !== candidate.observation.stage || !isDeepStrictEqual(checked.metrics, candidate.observation.metrics) ||
						!isDeepStrictEqual(checked.executionFacts, candidate.observation.executionFacts))
						throw new Error("accepted candidate did not reproduce its frozen host verification");
					eligible.add(observationPath);
					for (const file of [...sourceFiles, ...receiptFiles]) {
						const resolved = await realpath(file);
						if (accepted.has(resolved)) eligible.add(resolved);
					}
					const evaluationReceipts: LocalReceipt[] = [];
					for (const file of receiptFiles) {
						try {
							const value = JSON.parse(await readFile(file, "utf8")) as LocalReceipt;
							if (value.kind === "local-operator-evaluation") evaluationReceipts.push(value);
						} catch (error) { if (!(error instanceof SyntaxError)) throw error; }
					}
					if (evaluationReceipts.length !== 1) throw new Error("accepted candidate lacks one exact local evaluation receipt");
					observations.push({ taskId: task.taskId, observationPath, observation: checked, receipt: evaluationReceipts[0] });
				}
			}
			if (!observations.length) throw new Error("no accepted candidate has reverified frozen local operator evidence");
			const root = await mkdtemp(path.join(path.dirname(goal.problemSnapshotPath), "goal-verification-"));
			const scratchRoot = await mkdtemp(path.join(root, "workers-"));
			const logsRoot = await mkdtemp(path.join(root, "worker-logs-"));
			const profile = options.workerIsolationPrefix ? undefined : await createMacOSWriteSandboxProfile({ writableRoots: [scratchRoot], cwd: scratchRoot, denyNetwork: true });
			const commandPrefix = options.workerIsolationPrefix ? [...options.workerIsolationPrefix] : profile ? ["/usr/bin/sandbox-exec", "-p", profile] : undefined;
			if (!commandPrefix) throw new Error("local operator goal verification requires the bound worker write isolation");
			const workerOptions = path.join(root, "worker-options.json"), request = path.join(root, "request.json");
			await writeFile(workerOptions, JSON.stringify({ scratchRoot, logsRoot, commandPrefix,
				workerEnvironment, platformBinding }), { flag: "wx" });
			await writeFile(request, JSON.stringify({ criteria: goal.successCriteria, observations }), { flag: "wx" });
			const output = await runHostCommand(python, ["-I", script, "--verify-goal", contractPath, workerOptions, request],
				{ cwd: root, timeout: Math.min(2_147_483_647, Math.ceil(goalTimeoutSeconds * 1000) + 10_000),
					maxBuffer: goalOutputBytes + 1_000_000,
					env: { ...workerEnvironment, HOME: scratchRoot, TMPDIR: scratchRoot } });
			await assertContract();
			const result = JSON.parse(output.stdout) as { checks?: unknown; limitations?: unknown };
			if (!Array.isArray(result.checks) || !Array.isArray(result.limitations) ||
				result.checks.some((check: unknown) => !check || typeof check !== "object" ||
					!goal.successCriteria.includes((check as { criterion?: string }).criterion ?? "") ||
					!Array.isArray((check as { evidence?: unknown }).evidence) ||
					(check as { evidence: unknown[] }).evidence.some(item => typeof item !== "string" || !eligible.has(item))))
				throw new Error("host verify_goal returned a criterion or evidence outside accepted reverified observations");
			return result as Awaited<ReturnType<NonNullable<CandidateVerifier["verifyGoal"]>>>;
		} } : {}),
	};
	/** One host-owned side run of the contract: the mutation audit and the
	 * certification pass share the same isolation and the same argv shape. */
	async function hostRun(prefix: string, label: string, extra: string[] = []): Promise<string> {
		await assertContract();
		const root = await mkdtemp(path.join(tmpdir(), `local-operator-${label}-`));
		try {
			const scratchRoot = await mkdtemp(path.join(root, "workers-"));
			const logsRoot = await mkdtemp(path.join(root, "worker-logs-"));
			const profile = options.workerIsolationPrefix ? undefined :
				await createMacOSWriteSandboxProfile({ writableRoots: [scratchRoot], cwd: scratchRoot, denyNetwork: true });
			const commandPrefix = options.workerIsolationPrefix ? [...options.workerIsolationPrefix] :
				profile ? ["/usr/bin/sandbox-exec", "-p", profile] : undefined;
			if (!commandPrefix) throw new Error(`${label} requires the bound worker write isolation`);
			const workerOptions = path.join(root, "worker-options.json");
			await writeFile(workerOptions, JSON.stringify({ scratchRoot, logsRoot, commandPrefix, workerEnvironment, platformBinding }), { flag: "wx" });
			const output = await runHostCommand(python, ["-I", script, prefix, contractPath, workerOptions, ...extra],
				{ cwd: root, timeout: Math.min(2_147_483_647, Math.ceil(goalTimeoutSeconds * 1000) + 600_000),
					maxBuffer: goalOutputBytes + 1_000_000,
					env: { ...workerEnvironment, HOME: scratchRoot, TMPDIR: scratchRoot } });
			await assertContract();
			return output.stdout;
		} finally { await rm(root, { recursive: true, force: true }); }
	}

	/** Run the task's declared faults through the same cascade a candidate goes
	 * through. A check suite whose own escape rate is unknown is not evidence. */
	async function auditChecks(): Promise<LocalOperatorMutationReportV1> {
		const report = JSON.parse(await hostRun("--mutation-report", "audit")) as LocalOperatorMutationReportV1;
		if (report.kind !== "local-operator-mutation-report" || report.protocolId !== options.protocolId ||
			!Array.isArray(report.mutants) || report.mutants.length !== report.declared)
			throw new Error("mutation audit returned a report for another contract");
		return report;
	}

	/** Spend the reserved certification set on one already accepted candidate.
	 * The candidate never iterated against these cases and never sees them. */
	async function certifyCandidate(sourcePath: string): Promise<LocalOperatorCertificationV1> {
		if (!path.isAbsolute(sourcePath)) throw new Error("certification needs the absolute accepted source path");
		const report = JSON.parse(await hostRun("--certify", "certify",
			[await realpath(sourcePath)])) as LocalOperatorCertificationV1;
		if (report.kind !== "local-operator-certification" || report.protocolId !== options.protocolId ||
			!Array.isArray(report.cases) || !report.certificationCases)
			throw new Error("certification returned a report for another contract");
		return report;
	}
	/** What this host actually spent and what it avoided spending. Without it a
	 * run cannot answer where its device time went or how much was replayed. */
	async function evaluationProfile(): Promise<LocalOperatorEvaluationProfileV1> {
		return { version: 1, kind: "local-operator-evaluation-profile",
			apiGate: { ...gateCounters, nearestSignatureRate: gateCounters.rejected ? gateCounters.suggested / gateCounters.rejected : null },
			cache: cache ? { ...cache.stats, entriesOnDisk: await cache.size() } : undefined,
			platform: platformBinding ? { profileId: platformBinding.profileId,
				protocolVersion: platformBinding.protocolVersion } : undefined };
	}
	return { backend, verifier, auditChecks, certifyCandidate, evaluationProfile };
}
