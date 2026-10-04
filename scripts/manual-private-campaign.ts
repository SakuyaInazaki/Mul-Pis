/**
 * Generic private-input M07 campaign for a manually dispatched, isolated runner.
 * No assignment text or starter source is embedded in this public entrypoint.
 * All private inputs are loaded at runtime from --input-dir and never printed.
 */
import { existsSync } from "node:fs";
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { Workspace } from "../src/workspace.ts";
import { runInit } from "../src/stages/init.ts";
import { createFileKnowledgeStore } from "../src/knowledge/store.ts";
import { createM07Controller } from "../src/m07/controller.ts";
import { createPiSessionRunner } from "../src/runner/pi.ts";
import { DeepSeekCampaignBudget } from "../src/runner/deepseek-campaign.ts";
import { createConfinedCampaignFileTools } from "../src/runner/confined-campaign-files.ts";

const MODEL = "deepseek/deepseek-flash:low";
const MAX_CNY = 25;
const CAMPAIGN_MS = 9 * 60_000;
const FLAGS = ["-O2", "-std=c++17", "-fopenmp", "-pthread"];
const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHECKS = [
	"Required parallel implementations are substantively different and original non-target functions are preserved",
	"Original program checker exits successfully on several CPU-only configurations",
	"Measured per-kernel timings are compared with the preserved original baselines; within the bounded rounds the candidate strategies are improved or selected for the strongest observed performance, with any lack of gain recorded honestly and no global-optimality claim",
];
let statusOutputDir: string | undefined;
let statusRunId: string | undefined;
let statusBudget: DeepSeekCampaignBudget | undefined;
let statusPhase = "preflight";

async function saveStatus(value: Record<string, unknown>): Promise<void> {
	if (!statusOutputDir) return;
	await mkdir(statusOutputDir, { recursive: true, mode: 0o700 });
	const target = path.join(statusOutputDir, "campaign-status.json");
	const temporary = `${target}.${process.pid}.tmp`;
	await writeFile(temporary, JSON.stringify({ version: 1, runId: statusRunId ?? null,
		phase: statusPhase, budget: statusBudget?.snapshot() ?? { status: "unavailable" }, ...value }, null, 2),
		{ mode: 0o600 });
	await rename(temporary, target);
}
async function preserveCandidate(ws: Workspace, runId: string | undefined, outputDir: string): Promise<void> {
	if (!runId) return;
	const workDir = path.join(ws.runDir("M07", runId), "tasks", "T001", "work");
	for (const name of ["candidate.cpp", "verification.json"]) {
		const source = path.join(workDir, name);
		if (existsSync(source) && (await lstat(source)).isFile()) await copyFile(source, path.join(outputDir, name));
	}
}

function fail(message: string): never { throw new Error(message); }
class SandboxPreflightError extends Error {
	readonly privateDiagnostic: string;
	constructor(diagnostic: string) { super("isolated preflight failed"); this.privateDiagnostic = diagnostic; }
}
function arg(name: string): string {
	const index = process.argv.indexOf(name);
	if (index < 0 || index + 1 >= process.argv.length) fail(`missing ${name}`);
	return path.resolve(process.argv[index + 1]);
}
function cleanEnv(): NodeJS.ProcessEnv {
	return { PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "C.UTF-8", HOME: "/nonexistent", TMPDIR: "/tmp" };
}
function isolated(command: string, args: string[], timeout: number, mountedWork?: string) {
	return spawnSync("sudo", ["-n", "bwrap", "--unshare-user", "--unshare-net", "--unshare-pid", "--unshare-ipc",
		"--uid", "65534", "--gid", "65534", "--die-with-parent", "--clearenv",
		"--setenv", "PATH", "/usr/bin:/bin", "--setenv", "LANG", "C.UTF-8",
		"--ro-bind", "/usr", "/usr", "--symlink", "usr/bin", "/bin", "--symlink", "usr/lib", "/lib",
		"--symlink", "usr/lib64", "/lib64", "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp",
		...(mountedWork ? ["--bind", mountedWork, "/work", "--chdir", "/work"] : []),
		"--", command, ...args],
		{ encoding: "utf8", timeout, maxBuffer: 100_000, env: cleanEnv() });
}
async function requireIsolation(): Promise<void> {
	const id = isolated("/usr/bin/id", ["-u"], 15_000);
	if (id.status !== 0 || id.stdout.trim() !== "65534")
		throw new SandboxPreflightError(`uid probe: ${(id.stderr ?? "").slice(-2000)}`);
	const environment = isolated("/usr/bin/env", [], 15_000);
	if (environment.status !== 0 || /(?:KEY|TOKEN|SECRET|PASSWORD|AUTH)=/i.test(environment.stdout))
		throw new SandboxPreflightError(`environment probe: ${(environment.stderr ?? "").slice(-2000)}`);
	const scratch = await mkdtemp(path.join(os.tmpdir(), "mulpis-sandbox-preflight-"));
	try {
		await chmod(scratch, 0o777);
		await stageProbe(scratch);
		const compileProbe = isolated("/usr/bin/g++", [...FLAGS, "/work/probe.cpp", "-o", "/work/probe-bin"], 30_000, scratch);
		if (compileProbe.status !== 0)
			throw new SandboxPreflightError(`compiler probe: ${(compileProbe.stderr ?? "").slice(-2000)}`);
		const runProbe = isolated("/work/probe-bin", [], 15_000, scratch);
		if (runProbe.status !== 0)
			throw new SandboxPreflightError(`executable probe: ${(runProbe.stderr ?? "").slice(-2000)}`);
	} finally { await rm(scratch, { recursive: true, force: true }); }
}
async function stageProbe(scratch: string): Promise<void> {
	const source = path.join(scratch, "probe.cpp");
	await writeFile(source, "#include <omp.h>\nint main() { return omp_get_max_threads() > 0 ? 0 : 1; }\n",
		{ mode: 0o644 });
	// Actions uses umask 077; mode on creation alone would leave an unreadable 0600 file for sandbox UID 65534.
	await chmod(source, 0o644);
}
async function verifierScratch(kind: "original" | "candidate"): Promise<string> {
	const directory = await mkdtemp(path.join(os.tmpdir(), `mulpis-${kind}-check-`));
	await chmod(directory, 0o777);
	return directory;
}
function extractBody(source: string, name: string): string | null {
	const declaration = new RegExp(`\\b${name}\\s*\\(`, "g");
	let match: RegExpExecArray | null;
	while ((match = declaration.exec(source))) {
		const open = source.indexOf("{", match.index + match[0].length);
		if (open < 0 || source.slice(match.index, open).includes(";")) continue;
		let depth = 0;
		for (let index = open; index < source.length; index++) {
			if (source[index] === "{") depth++;
			else if (source[index] === "}" && --depth === 0) return source.slice(open + 1, index);
		}
	}
	return null;
}
function sourceShape(original: string, candidate: string): { ok: boolean; reason: string; targetCount: number } {
	const targets = [...original.matchAll(/\/\/\s*TODO[^\n]*\n\s*static\s+void\s+([A-Za-z_]\w*)\s*\(/g)].map(x => x[1]);
	if (targets.length < 2) return { ok: false, reason: "could not derive two original implementation targets", targetCount: targets.length };
	for (const name of ["main", ...[...original.matchAll(/static\s+(?:bool|void)\s+([A-Za-z_]\w*)\s*\(/g)].map(x => x[1]).filter(x => !targets.includes(x))]) {
		const before = extractBody(original, name), after = extractBody(candidate, name);
		if (!before || !after || before.replace(/\s+/g, "") !== after.replace(/\s+/g, ""))
			return { ok: false, reason: `original non-target function changed: ${name}`, targetCount: targets.length };
	}
	const bodies = targets.map(x => extractBody(candidate, x));
	if (bodies.some(x => !x || !/#\s*pragma\s+omp\b/.test(x)))
		return { ok: false, reason: "a required target lacks an OpenMP directive", targetCount: targets.length };
	if (bodies[0]!.replace(/\s+/g, "") === bodies[1]!.replace(/\s+/g, ""))
		return { ok: false, reason: "required target bodies are identical", targetCount: targets.length };
	return { ok: true, reason: "structural preservation checks passed; substantive difference also needs reviewer judgment", targetCount: targets.length };
}
async function checkCandidate(original: string, candidate: string, scratch: string) {
	const originalText = await readFile(original, "utf8");
	const shape = sourceShape(originalText, await readFile(candidate, "utf8"));
	await mkdir(scratch, { recursive: true, mode: 0o700 });
	await chmod(scratch, 0o777);
	await copyFile(candidate, path.join(scratch, "candidate.cpp"));
	await chmod(path.join(scratch, "candidate.cpp"), 0o644);
	const compiled = path.join(scratch, "candidate-bin");
	const build = isolated("/usr/bin/g++", [...FLAGS, "/work/candidate.cpp", "-o", "/work/candidate-bin"], 90_000, scratch);
	const verification: Record<string, unknown> = {
		version: 1, status: "failed", sourceShape: shape,
		compile: { success: build.status === 0, flags: FLAGS,
			stdoutTail: (build.stdout ?? "").slice(-4000), stderrTail: (build.stderr ?? "").slice(-8000) },
		originalCheckerRuns: [], environment: { platform: os.platform(), release: os.release(),
			cpuModel: os.cpus()[0]?.model ?? "unknown", availableParallelism: os.availableParallelism() },
		limitation: "Program exit status is the original built-in checker, not an independent finite-output proof.",
	};
	if (build.status !== 0) return verification;
	// These CLI cases are used only when the private original source demonstrates support.
	const cases = [[], ["--threads", "1", "--repeats", "10"], ["--threads", "2", "--repeats", "10"],
		["--threads", "4", "--repeats", "10"]];
	if (!originalText.includes('"--threads"') || !originalText.includes('"--repeats"'))
		return { ...verification, status: "failed", reason: "required runtime options unavailable in original source" };
	const runs = [];
	for (const args of cases) {
		const started = process.hrtime.bigint();
		const run = isolated("/work/candidate-bin", args, 60_000, scratch);
		const isolatedProcessWallMs = Number(process.hrtime.bigint() - started) / 1e6;
		const reportedKernelMs = (run.stdout ?? "").split(/\r?\n/).flatMap(line => {
			const match = /^\s*(.*?)\s+([0-9]+(?:\.[0-9]+)?)\s+ms\s*$/.exec(line);
			return match ? [{ label: match[1].trim(), ms: Number(match[2]) }] : [];
		});
		runs.push({ args, exitCode: run.status, isolatedProcessWallMs,
			reportedKernelMs, timingInterpretation: "isolatedProcessWallMs includes process startup; reportedKernelMs is the preserved original program's per-kernel timing",
			stdout: (run.stdout ?? "").slice(0, 12_000),
			stderrTail: run.status === 0 ? undefined : (run.stderr ?? "").slice(-1000) });
	}
	verification.originalCheckerRuns = runs;
	verification.status = shape.ok && runs.every(x => x.exitCode === 0 && x.reportedKernelMs.length >= 3)
		? "passed" : "failed";
	return verification;
}

async function inputs(inputDir: string) {
	const entries = await readdir(inputDir, { withFileTypes: true });
	const sources = entries.filter(x => x.name.endsWith(".cpp"));
	const texts = entries.filter(x => /\.(?:md|txt)$/i.test(x.name));
	if (entries.length !== 3 || sources.length !== 1 || texts.length !== 2 ||
		entries.length !== sources.length + texts.length || entries.some(x => !x.isFile() || x.name.startsWith(".")))
		fail("input bundle must contain exactly three regular flat files: one C++ source and two text files");
	for (const entry of entries) {
		const full = path.join(inputDir, entry.name), info = await lstat(full);
		if (!info.isFile() || info.isSymbolicLink() || info.size > 512_000 || info.size < 1) fail("invalid private input file");
	}
	return { source: sources[0].name, files: entries.map(x => x.name).sort() };
}

async function main() {
	const inputDir = arg("--input-dir"), outputDir = arg("--output-dir");
	statusOutputDir = outputDir;
	await mkdir(outputDir, { recursive: true, mode: 0o700 });
	const runtimeKey = process.env.DEEPSEEK_API_KEY;
	delete process.env.DEEPSEEK_API_KEY;
	if (!runtimeKey?.trim()) fail("DeepSeek credential absent");
	const found = await inputs(inputDir);
	await requireIsolation(); // fail before any provider call
	statusPhase = "isolated-preflight-passed";
	const campaignRoot = await mkdtemp(path.join(os.tmpdir(), "mulpis-private-campaign-"));
	let runId: string | undefined;
	const budget = new DeepSeekCampaignBudget({ model: MODEL, endpoint: "https://api.deepseek.com", maxCny: MAX_CNY,
		maxProviderCalls: 32, maxProviderCallsPerPrompt: 10, maxInputPayloadBytes: 96_000,
		maxOutputTokens: 16_000, outputAccountingMarginTokens: 32,
		maxInputCnyPerMillionTokens: 4, maxOutputCnyPerMillionTokens: 16, cnyPerUsdCeiling: 10 });
	statusBudget = budget;
	try {
		const ws = new Workspace(path.join(campaignRoot, "workspace"));
		statusPhase = "workspace-init";
		const store = createFileKnowledgeStore(ws.knowledgeDir);
		await runInit(ws, store);
		for (const name of found.files) await copyFile(path.join(inputDir, name), path.join(ws.rawDir, name));
		statusPhase = "private-inputs-staged";
		await writeFile(ws.problemFile,
			"Private C++ parallel-programming task. Use only the supplied original inputs. Produce optimized source and machine-readable correctness/performance observations. Do not produce a prose report, screenshots, presentation, or personal reflection. Do not invent measurements.\n" +
			(await readFile(path.join(ws.rawDir, found.files.find(x => /\.md$/i.test(x)) ?? found.files.find(x => /\.txt$/i.test(x))!), "utf8")),
			{ mode: 0o600 });
		await writeFile(ws.configFile, JSON.stringify({ roles: { execution: MODEL, reviewer: MODEL }, concurrency: 1, tools: {} }), { mode: 0o600 });
		const originalPath = path.join(ws.rawDir, found.source);
		const originalText = await readFile(originalPath, "utf8");
		const targetCount = [...originalText.matchAll(/\/\/\s*TODO[^\n]*\n\s*static\s+void\s+([A-Za-z_]\w*)\s*\(/g)].length;
		if (targetCount < 2 || !originalText.includes('"--threads"') || !originalText.includes('"--repeats"'))
			fail("private source does not satisfy bounded campaign preflight contract");
		statusPhase = "original-source-smoke";
		// The separate /tmp directory has no 0700 campaignRoot ancestor, so sandbox UID 65534 can traverse its bind source.
		const originalScratch = await verifierScratch("original");
		let originalSmoke;
		try { originalSmoke = await checkCandidate(originalPath, originalPath, originalScratch); }
		finally { await rm(originalScratch, { recursive: true, force: true }); }
		await writeFile(path.join(outputDir, "verification.json"),
			JSON.stringify({ kind: "original-preflight", result: originalSmoke }, null, 2), { mode: 0o600 });
		if ((originalSmoke.compile as { success?: boolean } | undefined)?.success !== true || !Array.isArray(originalSmoke.originalCheckerRuns) ||
			originalSmoke.originalCheckerRuns.length !== 4 || originalSmoke.originalCheckerRuns.some(x => x.exitCode !== 0))
			throw new SandboxPreflightError("original source compile/check failed; inspect encrypted verification.json");
		statusPhase = "source-and-isolation-preflight-passed";
		statusPhase = "model-route-setup";
		const profile = path.join(campaignRoot, "profile");
		await mkdir(profile, { mode: 0o700 });
		const modelsPath = path.join(profile, "models.json");
		const models = { providers: { deepseek: { models: [{ id: "deepseek-flash", name: "DeepSeek Flash",
			api: "openai-completions", baseUrl: "https://api.deepseek.com", reasoning: true, input: ["text"],
			cost: { input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0 },
			contextWindow: 1_000_000, maxTokens: 384_000,
			compat: { supportsStore: false, supportsDeveloperRole: false, maxTokensField: "max_tokens",
				requiresReasoningContentOnAssistantMessages: true, thinkingFormat: "deepseek" },
			thinkingLevelMap: { low: "low", high: "high", max: "max" },
		}] } } };
		await writeFile(modelsPath, JSON.stringify(models), { mode: 0o600 });
		const runtime = await ModelRuntime.create({ modelsPath, authPath: path.join(profile, "auth.json"),
			modelsStorePath: path.join(profile, "models-store.json"), allowModelNetwork: false, refreshOnCreate: false });
		await runtime.setRuntimeApiKey("deepseek", runtimeKey);
		const resolved = runtime.getModel("deepseek", "deepseek-flash");
		if (resolved?.provider !== "deepseek" || resolved.id !== "deepseek-flash" ||
			resolved.api !== "openai-completions" || resolved.baseUrl !== "https://api.deepseek.com") fail("unexpected model route");
		const abort = new AbortController();
		const timer = setTimeout(() => abort.abort(), CAMPAIGN_MS);
		try {
			const actual = createPiSessionRunner({ modelRuntime: runtime, signal: abort.signal, campaignBudget: budget });
			const runner = {
				create: async (spec: any) => {
					if (spec.tools.kind !== "execution") return actual.create(spec);
					if (!/^M07-T\d+$/.test(spec.label)) fail("unexpected execution session");
					const workDir = spec.tools.root;
					const tools = await createConfinedCampaignFileTools(workDir, { writableFiles: ["candidate.cpp"] });
					const handle = await actual.create({ ...spec, tools: { kind: "custom", tools } });
					return { ...handle, prompt: async (message: string) => {
						const turn = await handle.prompt(message);
						const candidate = path.join(workDir, "candidate.cpp");
						let result: Record<string, unknown> = { version: 1, status: "failed", reason: "candidate missing" };
						if (existsSync(candidate)) {
							const candidateScratch = await verifierScratch("candidate");
							try { result = await checkCandidate(originalPath, candidate, candidateScratch); }
							finally { await rm(candidateScratch, { recursive: true, force: true }); }
						}
						result.originalBaselineRuns = originalSmoke.originalCheckerRuns;
						await writeFile(path.join(workDir, "verification.json"), JSON.stringify(result, null, 2), { mode: 0o600 });
						return turn;
					} };
				},
				resume: (ref: any) => actual.resume(ref),
			};
			const controller = createM07Controller({ ws, store, runner, config: await ws.loadConfig() });
			const goal = await controller.begin({ goal: "Seek the strongest measured C++ parallel optimization attainable within this bounded private campaign, using the original inputs and preserved baselines.",
				problemRelation: "Code and machine-readable correctness/performance scope of the supplied private problem.",
				constraints: ["Use only the supplied private inputs and configured DeepSeek model.",
					"Preserve the original non-target implementations, main and built-in checker.",
					"No prose report, screenshots, presentation, or personal reflection; no fabricated measurements."],
				successCriteria: CHECKS,
				plan: "Use one bounded M07 builder and fresh reviewer loop. A host-owned isolated compile/run check enters each reviewer snapshot. Accept only frozen source and observed results.",
				exploratory: true });
			runId = goal.runId;
			statusRunId = runId;
			statusPhase = "m07-begun";
			statusPhase = "model-dispatch";
			const task = await controller.delegate(runId, { mode: "execute",
				objective: "Read the copied original inputs. Replace the required TODO parallel implementations with genuinely different OpenMP strategies in a complete candidate.cpp. Preserve all original non-target functions and the built-in checker/main. Examine host-generated verification.json after a round, compare actual per-kernel timings with original baselines, and use any remaining bounded round to improve or select the strongest observed valid candidate. If no gain is observed, say so; do not claim a global optimum. Use only the provided confined read/write/edit tools; do not call shell or network. The host creates verification.json after your turn; do not write it. Do not create prose deliverables.",
				inputs: found.files.map(x => `problem/raw/${x}`), expectedOutputs: ["candidate.cpp"], checks: CHECKS,
				executionLoop: { maxRounds: 2, deadlineAt: new Date(Date.now() + CAMPAIGN_MS - 60_000).toISOString() } });
			const candidate = path.join(task.workDir, "candidate.cpp");
			const verificationPath = path.join(task.workDir, "verification.json");
			if (existsSync(candidate)) await copyFile(candidate, path.join(outputDir, "candidate.cpp"));
			if (existsSync(verificationPath)) await copyFile(verificationPath, path.join(outputDir, "verification.json"));
			let verified = false;
			if (existsSync(verificationPath)) {
				const result = JSON.parse(await readFile(verificationPath, "utf8"));
				verified = result.status === "passed";
			}
			const accepted = task.status === "returned" && task.loopStopReason === "ready" && verified;
			if (task.status === "returned" && task.reportPath) {
				const review = await controller.review(runId, { taskId: task.taskId,
					checks: CHECKS.map((criterion, i) => ({ criterion, result: accepted ? "passed" : "failed",
						evidence: accepted ? [i === 0 ? candidate : verificationPath] : [] })),
					artifacts: [task.reportPath, ...(existsSync(candidate) ? [candidate] : []), ...(existsSync(verificationPath) ? [verificationPath] : [])],
					failures: accepted ? [] : ["bounded candidate did not pass all observed checks"] });
				if (accepted && review.status !== "accepted") fail("M07 review did not accept candidate");
			}
			const finished = await controller.finish(runId, { outcome: accepted ? "fulfilled" : "partial", returnPath: "user",
				summary: accepted ? "Bounded M07 builder/reviewer and original checker runs completed." : "Bounded M07 attempt was incomplete or failed checks.",
				goalChecks: CHECKS.map((criterion, i) => ({ criterion, result: accepted ? "passed" : "not_run",
					evidence: accepted ? [i === 0 ? candidate : verificationPath] : [] })),
				limitations: ["Original built-in checker is not independent finite-output validation; private post-run validation remains necessary."] });
			statusPhase = "m07-finished";
			await saveStatus({ outcome: finished.outcome, taskStatus: task.status,
				loopStopReason: task.loopStopReason, independentValidation: "pending-private-post-run" });
			console.log(JSON.stringify({ status: "private-campaign-complete", outcome: finished.outcome, budget: budget.snapshot() }));
		} finally { clearTimeout(timer); }
	} finally {
		await preserveCandidate(new Workspace(path.join(campaignRoot, "workspace")), runId, outputDir).catch(() => undefined);
		await rm(campaignRoot, { recursive: true, force: true });
	}
}

export const offlineChecks = { sourceShape, inputs, stageProbe, verifierScratch };

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main().catch(async error => {
		const preProvider = ["preflight", "isolated-preflight-passed", "workspace-init", "private-inputs-staged",
			"original-source-smoke", "source-and-isolation-preflight-passed"].includes(statusPhase);
		try { await saveStatus({ outcome: "incomplete", errorCategory: "campaign-exception",
			...(preProvider ? { privateDiagnostic: error instanceof SandboxPreflightError
				? error.privateDiagnostic : error instanceof Error ? error.message.slice(-2000) : "unknown pre-provider failure" } : {}),
			independentValidation: "not-complete" }); } catch { /* transport synthesizes an incomplete status */ }
		// Never print the model response, source, input paths, credential, or raw provider errors.
		console.error(JSON.stringify({ status: "private-campaign-failed", category: "campaign-exception" }));
		process.exitCode = 1;
	});
}
