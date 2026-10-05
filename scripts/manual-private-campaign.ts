/**
 * Generic private-input M07 campaign for a manually dispatched, isolated runner.
 * No assignment text or starter source is embedded in this public entrypoint.
 * All private inputs are loaded at runtime from --input-dir and never printed.
 */
import { existsSync } from "node:fs";
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { Workspace } from "../src/workspace.ts";
import { runInit } from "../src/stages/init.ts";
import { createFileKnowledgeStore } from "../src/knowledge/store.ts";
import { createM07Controller } from "../src/m07/controller.ts";
import type { CurrentGoal } from "../src/m07/types.ts";
import { runM04 } from "../src/stages/m04.ts";
import { createPiSessionRunner } from "../src/runner/pi.ts";
import { DeepSeekCampaignBudget } from "../src/runner/deepseek-campaign.ts";
import { createConfinedCampaignFileTools } from "../src/runner/confined-campaign-files.ts";
import { archivePrivateM07Task, recordPrivateM04Outcome } from "../src/workflow-archive/m07-private.ts";
import { buildCsrChecker } from "../src/workflow-archive/csr-checker.ts";
import { createExperienceProvider } from "../src/knowledge/experience-index.ts";
import type { KnowledgeRef, KnowledgeStore } from "../src/knowledge/types.ts";
import type { StageRunRecord } from "../src/types.ts";

const MODEL = "deepseek/deepseek-flash:low";
const MAX_CNY = 21;
const CAMPAIGN_MS = 20 * 60_000;
const BUILDER_PHASE_MS = 7 * 60_000;
const M04_PHASE_MS = 5 * 60_000;
const FLAGS = ["-O2", "-std=c++17", "-fopenmp", "-pthread"];
const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHECKS = [
	"Required parallel implementations are substantively different and original non-target functions are preserved",
	"Original program checker and controller-owned independent finite full-row mutation checker pass on several CPU-only configurations",
	"Measured per-kernel timings are compared with the preserved original baselines; within the bounded rounds the candidate strategies are improved or selected for the strongest observed performance, with any lack of gain recorded honestly and no global-optimality claim",
];
let statusOutputDir: string | undefined;
let statusRunId: string | undefined;
let statusBudget: DeepSeekCampaignBudget | undefined;
let statusPhase = "preflight";
let statusTaskTelemetry: Record<string, unknown> | undefined;
let statusRuntimeKey: string | undefined;
let statusCredentialProbe: { httpStatus: number | null; accepted: boolean } | undefined;
let statusAuthSource: "runtime" | "unexpected" | undefined;
let statusSdkAuthMatch: boolean | undefined;

async function credentialProbe(key: string, request: typeof fetch = fetch): Promise<{ httpStatus: number | null; accepted: boolean }> {
	const response = await request("https://api.deepseek.com/models", {
		method: "GET", redirect: "error", signal: AbortSignal.timeout(20_000),
		headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
	});
	await response.body?.cancel().catch(() => undefined);
	return { httpStatus: Number.isInteger(response.status) ? response.status : null, accepted: response.status === 200 };
}

function privateFailureMessage(raw: unknown, runtimeKey: string | undefined): string | undefined {
	if (typeof raw !== "string" || !raw || !runtimeKey) return undefined;
	let value = raw.replaceAll(runtimeKey, "[REDACTED_KEY]")
		.replace(/sk-[A-Za-z0-9_-]{6,}/gi, "[REDACTED_KEY]")
		.replace(/Bearer\s+[^\s'"\r\n]+/gi, "Bearer [REDACTED_KEY]")
		.replace(/Authorization\s*[:=]\s*[^\r\n]+/gi, "Authorization: [REDACTED_KEY]");
	value = value.slice(0, 4000);
	if (value.includes(runtimeKey) || /sk-[A-Za-z0-9_-]{6,}/i.test(value) ||
		/Bearer\s+(?!\[REDACTED_KEY\])/i.test(value)) return undefined;
	return value;
}
function taskFailureCategory(raw: unknown): string {
	if (typeof raw !== "string") return "none";
	const http = /(?:HTTP|status(?: code)?)[ :=]+(400|401|402|403|404|408|409|413|422|429|500|502|503|504)\b/i.exec(raw);
	if (http) return `http-${http[1]}`;
	if (/campaign call or CNY planning ceiling exhausted/i.test(raw)) return "campaign-ceiling";
	if (/provider payload exceeds the campaign boundary|input payload exceeds/i.test(raw)) return "payload-ceiling";
	if (/provider usage or call outcome is incomplete/i.test(raw)) return "usage-incomplete";
	if (/stopReason=length|output cap/i.test(raw)) return "output-limit";
	if (/abort|deadline|timeout/i.test(raw)) return "abort-or-deadline";
	if (/unsafe active tool set|campaign file|custom tool|tool execution/i.test(raw)) return "tool-grant";
	if (/model.*not found|model.*resolved|model route/i.test(raw)) return "model-resolution";
	if (/did not stop normally|runner.stop/i.test(raw)) return "sdk-stop";
	return "unclassified";
}
async function taskTelemetry(ws: Workspace, task: any, runtimeKey: string | undefined): Promise<Record<string, unknown>> {
	const failure = privateFailureMessage(task.executionFailure, runtimeKey);
	const sessionFile = typeof task.session?.file === "string" ? path.resolve(task.session.file) : undefined;
	let usage: Array<Record<string, unknown>> = [];
	if (sessionFile?.startsWith(path.resolve(ws.sessionsDir) + path.sep) && sessionFile.endsWith(".jsonl")) {
		const usageFile = sessionFile.replace(/\.jsonl$/, ".usage.jsonl");
		try {
			const rows = (await readFile(usageFile, "utf8")).split(/\r?\n/).filter(Boolean);
			usage = rows.slice(-12).map(line => {
				const row = JSON.parse(line) as Record<string, any>;
				const summary = row.summary ?? {};
				const eventRows = Array.isArray(row.events) ? row.events : [];
				return { outcome: ["completed", "failed", "aborted"].includes(row.outcome) ? row.outcome : "unknown",
					promptIndex: Number.isSafeInteger(row.promptIndex) ? row.promptIndex : null,
					usage: Object.fromEntries(["input", "output", "cacheRead", "cacheWrite", "totalTokens", "cost",
						"reportedEvents", "unknownEvents"].filter(key => typeof summary[key] === "number" && Number.isFinite(summary[key]))
						.map(key => [key, summary[key]])),
					complete: summary.complete === true, costComplete: summary.costComplete === true,
					events: eventRows.map((event: Record<string, unknown>) => ({
						kind: ["assistant", "tool-result", "compaction", "branch-summary"].includes(String(event.kind)) ? event.kind : "unknown",
						status: ["reported", "unknown"].includes(String(event.status)) ? event.status : "unknown",
						stopReason: ["stop", "toolUse", "error", "aborted", "length"].includes(String(event.stopReason)) ? event.stopReason : "other",
					})),
				};
			});
		} catch { usage = [{ status: "unavailable" }]; }
	}
	return { taskId: typeof task.taskId === "string" ? task.taskId : null,
		status: ["running", "returned", "failed", "accepted", "rejected", "unknown"].includes(task.status) ? task.status : "unknown",
		loopStopReason: typeof task.loopStopReason === "string" ? task.loopStopReason : null,
		failureCategory: taskFailureCategory(task.executionFailure),
		failure: failure ?? null, failureDiagnosticStatus: failure ? "redacted-private" : "unavailable",
		sessionCreated: Boolean(sessionFile), roundCount: Array.isArray(task.executionRounds) ? task.executionRounds.length : 0,
		tools: Array.isArray(task.toolLog) ? task.toolLog.map((item: Record<string, unknown>) => ({
			name: ["read", "write", "edit", "material_read", "material_list"].includes(String(item.name)) ? item.name : "other",
			ok: item.ok === true })) : [],
		usage };
}

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
	if (!runId || existsSync(path.join(outputDir, "workflow-archive.json"))) return;
	const goalFile = path.join(ws.runDir("M07", runId), "goal.json");
	if (!existsSync(goalFile)) return;
	const goal = JSON.parse(await readFile(goalFile, "utf8")) as CurrentGoal;
	const task = goal.tasks.at(-1);
	if (task) await archivePrivateM07Task({ goal, task, destination: outputDir });
}
/** Flat encrypted-transport layout; the renamed manifest is an index, not a default loader input. */
async function exportPrefixedArchive(sourceDir: string, outputDir: string, prefix: "initial" | "followon"): Promise<void> {
	const fileNames = ["candidate.cpp", "verification.json", "lesson-delta.json",
		"round-1-candidate.cpp", "round-1-verification.json", "round-2-candidate.cpp", "round-2-verification.json"];
	for (const name of fileNames) if (existsSync(path.join(sourceDir, name)))
		await copyFile(path.join(sourceDir, name), path.join(outputDir, `${prefix}-${name}`));
	const archive = JSON.parse(await readFile(path.join(sourceDir, "workflow-archive.json"), "utf8")) as Record<string, any>;
	for (const item of archive.files ?? []) item.name = `${prefix}-${item.name}`;
	for (const item of archive.controllerEvidence?.rounds ?? []) {
		if (item.candidate?.file) item.candidate.file = `${prefix}-${item.candidate.file}`;
		if (item.verification?.file) item.verification.file = `${prefix}-${item.verification.file}`;
	}
	archive.transportLayout = { kind: "prefixed-flat-index", prefix, defaultArchiveLoaderCompatible: false };
	await writeFile(path.join(outputDir, `workflow-${prefix}-archive.json`), JSON.stringify(archive, null, 2), { mode: 0o600 });
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
function targetBodySpan(source: string, name: string): { start: number; end: number } | undefined {
	const declaration = new RegExp(`\\bstatic\\s+void\\s+${name}\\s*\\(`).exec(source);
	if (!declaration) return undefined;
	const open = source.indexOf("{", declaration.index + declaration[0].length);
	if (open < 0 || source.slice(declaration.index, open).includes(";")) return undefined;
	let depth = 0;
	for (let index = open; index < source.length; index++) {
		if (source[index] === "{") depth++;
		else if (source[index] === "}" && --depth === 0) return { start: open, end: index + 1 };
	}
	return undefined;
}
function outsideTargets(source: string, targets: string[]): string | undefined {
	const spans = targets.map(name => targetBodySpan(source, name));
	if (spans.some(span => !span)) return undefined;
	let text = source;
	for (const span of (spans as Array<{ start: number; end: number }>).sort((a, b) => b.start - a.start))
		text = text.slice(0, span.start) + "{}" + text.slice(span.end);
	return text.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "").replace(/\s+/g, "");
}
function sourceShape(original: string, candidate: string): { ok: boolean; reason: string; targetCount: number } {
	const targets = [...original.matchAll(/\/\/\s*TODO[^\n]*\n\s*static\s+void\s+([A-Za-z_]\w*)\s*\(/g)].map(x => x[1]);
	if (targets.length < 2) return { ok: false, reason: "could not derive two original implementation targets", targetCount: targets.length };
	if (!outsideTargets(original, targets) || outsideTargets(original, targets) !== outsideTargets(candidate, targets))
		return { ok: false, reason: "candidate changed code or preprocessor directives outside the required target bodies", targetCount: targets.length };
	for (const name of ["main", ...[...original.matchAll(/static\s+(?:bool|void)\s+([A-Za-z_]\w*)\s*\(/g)].map(x => x[1]).filter(x => !targets.includes(x))]) {
		const before = extractBody(original, name), after = extractBody(candidate, name);
		if (!before || !after || before.replace(/\s+/g, "") !== after.replace(/\s+/g, ""))
			return { ok: false, reason: `original non-target function changed: ${name}`, targetCount: targets.length };
	}
	const bodies = targets.map(x => extractBody(candidate, x));
	if (bodies.some(body => body && [...body.matchAll(/^\s*#\s*([^\n]*)/gm)].some(match => !/^pragma\s+omp\b/.test(match[1].trim()))))
		return { ok: false, reason: "required target body contains a non-OpenMP preprocessor directive", targetCount: targets.length };
	if (bodies.some(x => !x || !/#\s*pragma\s+omp\b/.test(x)))
		return { ok: false, reason: "a required target lacks an OpenMP directive", targetCount: targets.length };
	if (bodies[0]!.replace(/\s+/g, "") === bodies[1]!.replace(/\s+/g, ""))
		return { ok: false, reason: "required target bodies are identical", targetCount: targets.length };
	return { ok: true, reason: "structural preservation checks passed; substantive difference also needs reviewer judgment", targetCount: targets.length };
}
function deriveRuntimeCases(original: string): string[][] | undefined {
	const candidates = [...original.matchAll(/\bstruct\s+[A-Za-z_]\w*\s*\{([\s\S]*?)\};/g)]
		.map(match => [...match[1].matchAll(/\bint\s+([A-Za-z_]\w*)\s*=\s*(\d+)\s*;/g)]
			.map(item => ({ field: item[1], value: Number(item[2]) })))
		.filter(fields => fields.length >= 7 && fields.length <= 12);
	if (candidates.length !== 1) return undefined;
	const fields = candidates[0];
	const parsedFlags = new Map<string, string>();
	for (const match of original.matchAll(/\barg\s*==\s*"(--[A-Za-z0-9-]+)"\s*\)\s*\{\s*[A-Za-z_]\w*\.([A-Za-z_]\w*)\s*=\s*read_int_arg\s*\(/g))
		parsedFlags.set(match[2], match[1]);
	if (fields.slice(0, 7).some(item => !parsedFlags.has(item.field) || !Number.isSafeInteger(item.value))) return undefined;
	const [first, second, third, fourth, fifth, thread, repeat] = fields;
	if (first.value < 1 || first.value > 20_000 || second.value < 1 || second.value > 200_000 ||
		third.value < 0 || third.value > 200 || fourth.value < 0 || fourth.value > first.value ||
		fifth.value < 0 || fifth.value > second.value || thread.value < 1 || repeat.value < 1) return undefined;
	const shape = (values: number[]) => values.flatMap((value, index) => [parsedFlags.get(fields[index].field)!, String(value)]);
	const uniform = shape([Math.min(first.value * 2, 20_000), second.value, third.value, 0, 0]);
	const broadSecond = Math.min(second.value * 2, 200_000);
	const heavier = shape([Math.min(first.value * 2, 20_000), broadSecond,
		Math.max(1, Math.floor(third.value / 2)), Math.max(1, Math.floor(fourth.value / 2)),
		Math.min(broadSecond, Math.max(1, fifth.value * 4))]);
	const cases: string[][] = [];
	for (const base of [[], uniform, heavier]) for (const threads of [1, 2, 4])
		cases.push([...base, parsedFlags.get(thread.field)!, String(threads), parsedFlags.get(repeat.field)!, "10"]);
	return cases;
}
async function m04EvidenceReturned(record: StageRunRecord, taskId: string): Promise<{ complete: boolean; paths: string[] }> {
	const coverage = record.outputs.find(item => item.label === "M07 回流证据实际访问范围");
	const source = record.outputs.find(item => item.label === "M07 处理来源");
	if (!coverage || !source || !/^T\d{3,}$/.test(taskId)) return { complete: false, paths: [] };
	try {
		const parsed = JSON.parse(await readFile(coverage.path, "utf8")) as { returnedRanges?: Array<{
			path?: unknown; status?: unknown; returned?: { kind?: unknown; startLine?: unknown; endLine?: unknown; truncated?: unknown } }> };
		const sourceInfo = JSON.parse(await readFile(source.path, "utf8")) as { rootDir?: unknown };
		if (typeof sourceInfo.rootDir !== "string" || !Array.isArray(parsed.returnedRanges)) return { complete: false, paths: [] };
		const root = await realpath(sourceInfo.rootDir);
		const paths: string[] = [];
		for (const name of ["candidate.cpp", "verification.json", "lesson-delta.json"]) {
			const exactEvidencePath = (value: unknown): value is string => {
				if (typeof value !== "string") return false;
				const parts = value.replaceAll("\\", "/").split("/");
				return parts.length === 4 && parts[0] === "tasks" && parts[1] === taskId &&
					parts[2] === "review-snapshot" && /^\d{3}-/.test(parts[3]) && parts[3].slice(4) === name;
			};
			const relevant = parsed.returnedRanges.filter(item => exactEvidencePath(item.path) &&
				item.status === "returned" && item.returned?.kind === "text" &&
				Number.isSafeInteger(item.returned.startLine) && Number.isSafeInteger(item.returned.endLine));
			if (!relevant.length) return { complete: false, paths };
			const file = await realpath(path.join(root, relevant[0].path as string));
			if (!file.startsWith(root + path.sep) || !(await lstat(file)).isFile()) return { complete: false, paths };
			const content = await readFile(file, "utf8");
			const totalLines = content.split(/\r?\n/).length - (content.endsWith("\n") ? 1 : 0);
			const covered = Array.from({ length: totalLines }, () => false);
			for (const item of relevant) {
				if (item.path !== relevant[0].path) continue;
				const start = item.returned!.startLine as number, end = item.returned!.endLine as number;
				if (start < 1 || end < start || end > totalLines) continue;
				for (let line = start; line <= end; line++) covered[line - 1] = true;
			}
			if (!covered.length || covered.some(flag => !flag)) return { complete: false, paths };
			paths.push(relevant[0].path as string);
		}
		return { complete: true, paths };
	} catch { return { complete: false, paths: [] }; }
}
async function adoptedExperienceRefs(store: KnowledgeStore, m04RunId: string, evidenceReturned: boolean): Promise<KnowledgeRef[]> {
	if (!evidenceReturned) return [];
	const storeId = await store.storeId();
	const records = await store.list();
	const refs: KnowledgeRef[] = [];
	for (const record of records) {
		const experience = record.fields.experience as Record<string, unknown> | undefined;
		if (record.source.stage !== "M04" || record.source.runId !== m04RunId || record.usageDecision !== "adopted" ||
			!experience || experience.version !== 1 || experience.targetKind !== "executor" ||
			!Array.isArray(experience.applicableStages) || !experience.applicableStages.includes("M07")) continue;
		if ((await store.availability(record.id, record.version)).availability !== "usable_conditionally") continue;
		refs.push({ storeId, recordId: record.id, version: record.version });
	}
	return refs.slice(0, 24);
}
type TrustedTiming = { target: number; rows: number; cols: number; threads: number; repeats: number; elapsedNs: number };
function compareCandidateTimings(previous: unknown, current: unknown): { state: "measured" | "unavailable"; ratios?: number[]; medianRatio?: number; minRatio?: number } {
	const trusted = (value: unknown): TrustedTiming[] | undefined => {
		if (!value || typeof value !== "object") return undefined;
		const independent = (value as Record<string, unknown>).independent;
		if (!independent || typeof independent !== "object" || (independent as Record<string, unknown>).status !== "passed") return undefined;
		const timings = (independent as Record<string, unknown>).timings;
		return Array.isArray(timings) && timings.length === 8 ? timings : undefined;
	};
	const before = trusted(previous), after = trusted(current);
	if (!before || !after) return { state: "unavailable" };
	const ratios: number[] = [];
	for (const item of before) {
		const next = after.find(other => other.target === item.target && other.rows === item.rows &&
			other.cols === item.cols && other.threads === item.threads && other.repeats === item.repeats);
		const prior = item.elapsedNs;
		if (!next || !Number.isSafeInteger(prior) || prior < 1 || !Number.isSafeInteger(next.elapsedNs) || next.elapsedNs < 1)
			return { state: "unavailable" };
		ratios.push(Number((prior / next.elapsedNs).toFixed(3)));
	}
	if (ratios.length !== 8 || new Set(before.map(item => `${item.target}:${item.rows}:${item.cols}:${item.threads}`)).size !== 8)
		return { state: "unavailable" };
	const sorted = [...ratios].sort((a, b) => a - b);
	return { state: "measured", ratios, medianRatio: (sorted[3] + sorted[4]) / 2, minRatio: sorted[0] };
}
function parseCheckerOutput(stdout: string, metadata: ReturnType<typeof buildCsrChecker>["metadata"]):
	{ status: "passed" | "failed"; timings: TrustedTiming[] } {
	const lines = stdout.trim().split(/\r?\n/);
	const pass = lines.filter(line => line === "CSR_CHECK_PASS").length === 1 && lines.at(-1) === "CSR_CHECK_PASS";
	const timingLines = lines.filter(line => line.startsWith("CSR_TIMING"));
	const timings: TrustedTiming[] = [];
	for (const line of timingLines) {
		const match = /^CSR_TIMING target=([12]) rows=(\d+) cols=(\d+) threads=([14]) repeats=(\d+) elapsed_ns=(\d+)$/.exec(line);
		if (!match) return { status: "failed", timings: [] };
		const [target, rows, cols, threads, repeats, elapsedNs] = match.slice(1).map(Number);
		if (![target, rows, cols, threads, repeats, elapsedNs].every(Number.isSafeInteger) || elapsedNs < 1 ||
			repeats !== metadata.timing.repeats ||
			!metadata.timing.shapes.some(shape => shape[0] === rows && shape[1] === cols) ||
			!metadata.timing.threadCounts.includes(threads as 1 | 4)) return { status: "failed", timings: [] };
		timings.push({ target, rows, cols, threads, repeats, elapsedNs });
	}
	const keys = timings.map(item => `${item.target}:${item.rows}:${item.cols}:${item.threads}`);
	return { status: pass && lines.length === 9 && timingLines.length === 8 && timings.length === 8 &&
		new Set(keys).size === 8 ? "passed" : "failed", timings };
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
		originalCheckerRuns: [], independent: { status: "not_run" }, environment: { platform: os.platform(), release: os.release(),
			cpuModel: os.cpus()[0]?.model ?? "unknown", availableParallelism: os.availableParallelism() },
		limitation: "Program exit status is the original built-in checker, not an independent finite-output proof.",
	};
	if (build.status !== 0) return verification;
	// These CLI cases are used only when the private original source demonstrates support.
	const cases = deriveRuntimeCases(originalText);
	if (!cases)
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
	try {
		const checker = buildCsrChecker(originalText);
		await writeFile(path.join(scratch, "checker.cpp"), checker.source, { mode: 0o644 });
		await chmod(path.join(scratch, "checker.cpp"), 0o644);
		const compiledChecker = isolated("/usr/bin/g++", ["-O0", "-std=c++17", "-fopenmp", "-pthread",
			"/work/checker.cpp", "-o", "/work/independent-checker"], 90_000, scratch);
		if (compiledChecker.status !== 0) verification.independent = { status: "compile_failed",
			stderrTail: (compiledChecker.stderr ?? "").slice(-4000) };
		else {
			const checked = isolated("/work/independent-checker", [], 60_000, scratch);
			const parsed = parseCheckerOutput(checked.stdout ?? "", checker.metadata);
			verification.independent = { status: checked.status === 0 ? parsed.status : "failed", timings: parsed.timings,
				threadCounts: checker.metadata.threadCounts, shapes: checker.metadata.shapes,
				mutationPasses: checker.metadata.mutationPasses, timing: checker.metadata.timing,
				stderrTail: checked.status === 0 ? undefined : (checked.stderr ?? "").slice(-1000) };
		}
	} catch { verification.independent = { status: "unavailable" }; }
	verification.status = shape.ok && runs.every(x => x.exitCode === 0 && x.reportedKernelMs.length >= 3) &&
		(verification.independent as { status?: string }).status === "passed"
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
	statusRuntimeKey = runtimeKey;
	statusPhase = "credential-probe";
	try { statusCredentialProbe = await credentialProbe(runtimeKey); }
	catch { statusCredentialProbe = { httpStatus: null, accepted: false }; }
	if (!statusCredentialProbe.accepted) {
		if (statusCredentialProbe.httpStatus === 401 || statusCredentialProbe.httpStatus === 403)
			fail("DeepSeek credential rejected by read-only model-list endpoint");
		fail("DeepSeek credential probe did not complete successfully");
	}
	statusPhase = "credential-verified";
	const found = await inputs(inputDir);
	await requireIsolation(); // fail before any provider call
	statusPhase = "isolated-preflight-passed";
	const campaignRoot = await mkdtemp(path.join(os.tmpdir(), "mulpis-private-campaign-"));
	let runId: string | undefined;
	const budget = new DeepSeekCampaignBudget({ model: MODEL, endpoint: "https://api.deepseek.com", maxCny: MAX_CNY,
		maxProviderCalls: 32, maxProviderCallsPerPrompt: 10,
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
		await writeFile(ws.configFile, JSON.stringify({ roles: { execution: MODEL, reviewer: MODEL, research: MODEL }, concurrency: 1, tools: {} }), { mode: 0o600 });
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
			originalSmoke.originalCheckerRuns.length !== 9 || originalSmoke.originalCheckerRuns.some(x => x.exitCode !== 0) ||
			(originalSmoke.independent as { status?: string } | undefined)?.status !== "passed")
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
		statusAuthSource = runtime.getProviderAuthStatus("deepseek").source === "runtime" ? "runtime" : "unexpected";
		if (statusAuthSource !== "runtime") fail("SDK runtime credential source did not verify");
		const resolved = runtime.getModel("deepseek", "deepseek-flash");
		if (resolved?.provider !== "deepseek" || resolved.id !== "deepseek-flash" ||
			resolved.api !== "openai-completions" || resolved.baseUrl !== "https://api.deepseek.com") fail("unexpected model route");
		statusSdkAuthMatch = (await runtime.getAuth(resolved))?.auth.apiKey === runtimeKey;
		if (!statusSdkAuthMatch) fail("SDK model credential resolution did not verify");
		const abort = new AbortController();
		const campaignStopAt = Date.now() + CAMPAIGN_MS;
		const timer = setTimeout(() => abort.abort(), CAMPAIGN_MS);
		try {
			const actual = createPiSessionRunner({ modelRuntime: runtime, signal: abort.signal, campaignBudget: budget });
			let followOnPriorVerification: unknown;
			const runner = {
				create: async (spec: any) => {
					if (spec.tools.kind !== "execution") return actual.create(spec);
					if (!/^M07-T\d+$/.test(spec.label)) fail("unexpected execution session");
					const workDir = spec.tools.root;
					const tools = await createConfinedCampaignFileTools(workDir, { writableFiles: ["candidate.cpp", "lesson-delta.json"] });
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
						result.originalBaselineIndependent = {
							status: (originalSmoke.independent as { status?: string }).status,
							timings: (originalSmoke.independent as { timings?: TrustedTiming[] }).timings,
						};
						result.originalHostComparison = compareCandidateTimings(originalSmoke, result);
						if (result.status === "passed" && (result.originalHostComparison as { state?: string }).state !== "measured")
							result.status = "failed";
						if (followOnPriorVerification) result.priorCandidateComparison = compareCandidateTimings(followOnPriorVerification, result);
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
				objective: "Read the copied original inputs. Replace the required TODO parallel implementations with genuinely different OpenMP strategies in a complete candidate.cpp. Preserve all original non-target functions and the built-in checker/main. Examine host-generated verification.json after a round, compare actual per-kernel timings with original baselines, and use any remaining bounded round to improve or select the strongest observed valid candidate. If no gain is observed, say so; do not claim a global optimum. Write a bounded candidate lesson-delta.json with actual observation, applicability and evidencePaths, or action none when the evidence supports no lesson. This lesson is pending M04, never self-adopted. Use only the provided confined read/write/edit tools; do not call shell or network. The host creates verification.json after your turn; do not write it. Do not create prose deliverables.",
				inputs: found.files.map(x => `problem/raw/${x}`), expectedOutputs: ["candidate.cpp", "lesson-delta.json"], lessonDeltaOutput: "lesson-delta.json", checks: CHECKS,
				executionLoop: { maxRounds: 2, deadlineAt: new Date(Math.min(Date.now() + BUILDER_PHASE_MS, campaignStopAt - 8 * 60_000)).toISOString() } });
			statusTaskTelemetry = await taskTelemetry(ws, task, runtimeKey);
			const candidate = path.join(task.workDir, "candidate.cpp");
			const verificationPath = path.join(task.workDir, "verification.json");
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
				limitations: ["The workflow-owned independent checker covers bounded shapes, mutations and threads; it is not exhaustive proof of correctness or optimality."] });
			const frozenGoal = await controller.status(runId);
			const frozenTask = frozenGoal.tasks.find(item => item.taskId === task.taskId);
			if (!frozenTask) fail("finished M07 task identity is unavailable for private archive");
			const privateArchive = await archivePrivateM07Task({ goal: frozenGoal, task: frozenTask, destination: outputDir });
			let finalArchive = privateArchive;
			let selectedCandidateSource: "initial" | "followon" | "none" = finished.outcome === "fulfilled" && accepted ? "initial" : "none";
			let m04: { status: "completed" | "failed" | "not_run"; runId?: string; proposalSubmitted?: boolean;
				snapshotCreated?: boolean; evidenceReturned?: boolean; adoptedExperienceRefs?: KnowledgeRef[] } = { status: "not_run" };
			if (!budget.snapshot().stopped && !abort.signal.aborted) {
				const m04Abort = new AbortController();
				const m04Timer = setTimeout(() => m04Abort.abort(), M04_PHASE_MS);
				try {
					const m04Runner = createPiSessionRunner({ modelRuntime: runtime,
						signal: AbortSignal.any([abort.signal, m04Abort.signal]), campaignBudget: budget });
					const processed = await runM04({ ws, store, runner: m04Runner, config: await ws.loadConfig() },
						{ feedback: { kind: "M07", runId }, freshSession: true, purpose: "Adjudicate bounded M07 candidate lessons and limits" });
					const complete = processed.record.status === "completed" && processed.record.failures.length === 0;
					const coverage = await m04EvidenceReturned(processed.record, task.taskId);
					m04 = { status: complete ? "completed" : "failed", runId: processed.record.runId,
						proposalSubmitted: Boolean(processed.proposalId), snapshotCreated: Boolean(processed.snapshotId),
						evidenceReturned: coverage.complete,
						adoptedExperienceRefs: complete ? await adoptedExperienceRefs(store, processed.record.runId, coverage.complete) : [] };
				} catch { m04 = { status: "failed", adoptedExperienceRefs: [] }; }
				finally { clearTimeout(m04Timer); }
			}
			const archivedM04 = await recordPrivateM04Outcome(outputDir, { state: m04.status === "not_run" ? "not-run" : m04.status,
				...(m04.runId ? { runId: m04.runId } : {}), proposalSubmitted: m04.proposalSubmitted ?? false,
				snapshotCreated: m04.snapshotCreated ?? false, adoptedExperienceRefs: m04.adoptedExperienceRefs ?? [] }, store);
			const knowledgeExport = archivedM04.m04?.knowledgeExport ?? { state: "incomplete", reason: "M04 export state unavailable" };
			const m04AdoptedExperienceCount = m04.runId ? (await store.list()).filter(record =>
				record.source.stage === "M04" && record.source.runId === m04.runId &&
				record.usageDecision === "adopted" && record.fields.experience !== undefined).length : 0;
			const m04AdoptionReadContractSatisfied = m04AdoptedExperienceCount === 0 || m04.evidenceReturned === true;
			const reusableRefs = m04.evidenceReturned && knowledgeExport.state === "complete" ?
				(m04.adoptedExperienceRefs ?? []).filter(ref => (archivedM04.m04?.adoptedExperienceRefs ?? []).some(exported =>
					exported.storeId === ref.storeId && exported.recordId === ref.recordId && exported.version === ref.version)) : [];
			let followOn: Record<string, unknown> = { state: "not_run", reason: "M04, seed, budget or time boundary unavailable" };
			if (m04.status === "completed" && existsSync(candidate) && existsSync(verificationPath) &&
				!budget.snapshot().stopped && !abort.signal.aborted && Date.now() + 90_000 < campaignStopAt) {
				try {
					const prior = JSON.parse(await readFile(verificationPath, "utf8")) as Record<string, unknown>;
					followOnPriorVerification = prior;
					const seedPath = path.join(ws.runDir("M07", runId), "prior-candidate-seed.json");
					const summary = Array.isArray(prior.originalCheckerRuns) ? prior.originalCheckerRuns.map((row: Record<string, unknown>) => ({
						args: row.args, exitCode: row.exitCode, reportedKernelMs: row.reportedKernelMs })) : [];
					await writeFile(seedPath, JSON.stringify({ version: 1, sourceGoalRunId: runId, sourceTaskId: task.taskId,
						status: prior.status, independent: prior.independent, measuredCases: summary }, null, 2), { mode: 0o600 });
					const secondGoal = await controller.begin({
						goal: "Conditionally refine the prior measured candidate using explicit frozen evidence and only applicable M04-adopted experience.",
						problemRelation: "Fresh M07 continuation of the same private optimization problem after completed M04 adjudication.",
						constraints: ["Prior candidate and measurements are development evidence, not adopted truth.",
							"Use only M04-adopted pinned experience refs that pass current applicability and live-limit checks.",
							"Preserve original non-target code and built-in checker; no prose report or personal reflection."],
						successCriteria: CHECKS,
						plan: "Explicitly inspect prior candidate and bounded measurements, then perform one fresh bounded builder/reviewer loop. Distinguish loaded knowledge, actual use and measured benefit.",
						exploratory: false,
					});
					const proposedRefs = reusableRefs;
					const tags = ["execute", "numeric", "cpu", "cpp-parallel"];
					const selection = await createExperienceProvider(store).select({ targetKind: "executor",
						applicability: { stage: "M07", tags }, requestedRefs: proposedRefs,
						expectedSnapshotId: secondGoal.knowledgeSnapshot, maxRecords: 24, maxChars: 24_000 });
					const pinnedRefs = selection.status === "ready" ? proposedRefs : [];
					const seedInputs = [path.relative(ws.root, candidate), path.relative(ws.root, seedPath),
						...(existsSync(path.join(task.workDir, "lesson-delta.json")) ? [path.relative(ws.root, path.join(task.workDir, "lesson-delta.json"))] : [])];
					const secondTask = await controller.delegate(secondGoal.runId, { mode: "execute",
						objective: "Inspect the explicitly supplied prior candidate and prior-candidate-seed.json; they are untrusted development evidence. If applicable M04 experience is loaded, assess it against this task rather than assuming it is beneficial. Produce a complete candidate.cpp that is independently correct and seek the strongest measured performance across the supplied CPU cases; report negative or mixed results honestly. Write lesson-delta.json as a pending candidate or action none. Use only confined read/write/edit; host generates verification.json before fresh reviewer inspection; no shell/network or prose deliverables.",
						inputs: [...found.files.map(x => `problem/raw/${x}`), ...seedInputs],
						expectedOutputs: ["candidate.cpp", "lesson-delta.json"], lessonDeltaOutput: "lesson-delta.json", checks: CHECKS,
						...(pinnedRefs.length ? { experienceRefs: pinnedRefs, experienceTags: tags } : {}),
						executionLoop: { maxRounds: 2, deadlineAt: new Date(Math.min(Date.now() + BUILDER_PHASE_MS, campaignStopAt - 45_000)).toISOString() },
					});
					const nextCandidate = path.join(secondTask.workDir, "candidate.cpp");
					const nextVerification = path.join(secondTask.workDir, "verification.json");
					let nextResult: Record<string, unknown> | undefined;
					try { nextResult = JSON.parse(await readFile(nextVerification, "utf8")) as Record<string, unknown>; } catch { /* no verified follow-on */ }
					const comparison = nextResult?.priorCandidateComparison ?? { state: "unavailable" };
					const secondReady = secondTask.status === "returned" && secondTask.loopStopReason === "ready" && nextResult?.status === "passed";
					if (secondTask.status === "returned" && secondTask.reportPath) {
						const reviewed = await controller.review(secondGoal.runId, { taskId: secondTask.taskId,
							checks: CHECKS.map((criterion, index) => ({ criterion, result: secondReady ? "passed" : "failed",
								evidence: secondReady ? [index === 0 ? nextCandidate : nextVerification] : [] })),
							artifacts: [secondTask.reportPath, ...(existsSync(nextCandidate) ? [nextCandidate] : []),
								...(existsSync(nextVerification) ? [nextVerification] : [])],
							failures: secondReady ? [] : ["follow-on candidate did not pass all bounded checks"] });
						if (secondReady && reviewed.status !== "accepted") fail("follow-on M07 review did not accept candidate");
					}
					const secondFinished = await controller.finish(secondGoal.runId, { outcome: secondReady ? "fulfilled" : "partial",
						returnPath: "user", summary: secondReady ? "Fresh bounded follow-on checked prior context and produced verified candidate." :
							"Fresh bounded follow-on did not complete all checks.",
						goalChecks: CHECKS.map((criterion, index) => ({ criterion, result: secondReady ? "passed" : "not_run",
							evidence: secondReady ? [index === 0 ? nextCandidate : nextVerification] : [] })),
						limitations: ["Prior archive/context and loaded experience do not by themselves establish faithful use or scientific benefit."] });
					const nextFrozenGoal = await controller.status(secondGoal.runId);
					const nextFrozenTask = nextFrozenGoal.tasks.find(item => item.taskId === secondTask.taskId);
					if (nextFrozenTask) {
						const nextArchiveDir = path.join(campaignRoot, "followon-archive");
						const nextArchive = await archivePrivateM07Task({ goal: nextFrozenGoal, task: nextFrozenTask, destination: nextArchiveDir });
						await exportPrefixedArchive(nextArchiveDir, outputDir, "followon");
						const comparisonValue = comparison as { state?: string; medianRatio?: number; minRatio?: number };
						const chooseFollowOn = secondFinished.outcome === "fulfilled" && secondReady &&
							(selectedCandidateSource === "none" || (comparisonValue.state === "measured" &&
							comparisonValue.medianRatio !== undefined && comparisonValue.medianRatio > 1.03 &&
							comparisonValue.minRatio !== undefined && comparisonValue.minRatio >= 0.95));
						if (chooseFollowOn && nextArchive.files.some(item => item.name === "candidate.cpp" && item.status === "present") &&
							nextArchive.files.some(item => item.name === "verification.json" && item.status === "present")) {
							await exportPrefixedArchive(outputDir, outputDir, "initial");
							for (const name of ["candidate.cpp", "verification.json", "lesson-delta.json", "round-1-candidate.cpp",
								"round-1-verification.json", "round-2-candidate.cpp", "round-2-verification.json", "workflow-archive.json"]) {
								await rm(path.join(outputDir, name), { force: true });
								if (existsSync(path.join(nextArchiveDir, name))) await copyFile(path.join(nextArchiveDir, name), path.join(outputDir, name));
							}
							finalArchive = nextArchive;
							selectedCandidateSource = "followon";
						}
					}
					followOn = { state: "completed", goalRunId: secondGoal.runId, m07Outcome: secondFinished.outcome,
						priorCandidateProvided: true, priorEvidenceProvided: true, adoptedRefsEligible: proposedRefs.length,
						experienceSelectionStatus: selection.status, pinnedRefs, loadedExperience: Boolean(secondTask.experienceSelection?.loadedAt),
						faithfulUse: "unknown", causalBenefit: "unknown", measuredComparison: comparison,
						candidateSelected: selectedCandidateSource === "followon", selectedCandidateSource,
						knowledgeMode: pinnedRefs.length ? "m04-adopted-pinned" : "prior-artifact-only",
						archiveTransportLayout: "prefixed-flat-index" };
				} catch { followOn = { state: "failed", priorCandidateProvided: true, faithfulUse: "unknown", causalBenefit: "unknown" }; }
			}
			statusPhase = "workflow-finished";
			const finalCandidateVerified = selectedCandidateSource !== "none";
			const durableKnowledge = knowledgeExport.state !== "incomplete" &&
				(!m04.adoptedExperienceRefs?.length || knowledgeExport.state === "complete");
			const followOnCompleted = followOn.state === "completed" && followOn.m07Outcome === "fulfilled";
			const campaignOutcome = finalCandidateVerified && m04.status === "completed" && durableKnowledge &&
				m04AdoptionReadContractSatisfied &&
				followOnCompleted ? "fulfilled" : "partial";
			await saveStatus({ outcome: campaignOutcome, m07Outcome: finished.outcome, taskStatus: task.status,
				loopStopReason: task.loopStopReason, taskTelemetry: statusTaskTelemetry,
				credentialProbe: statusCredentialProbe, sdkAuthSource: statusAuthSource,
				sdkAuthMatch: statusSdkAuthMatch,
				workflowArchive: { state: "saved", firstTaskId: privateArchive.taskId, finalTaskId: finalArchive.taskId,
					lessonState: privateArchive.lesson.state, trustedAdoption: false, m04,
					knowledgeExport, m04EvidenceReturned: m04.evidenceReturned ?? false,
					m04AdoptedExperienceCount, m04AdoptionReadContractSatisfied },
				followOn, selectedCandidateSource, finalCandidateVerified,
				independentValidation: finalCandidateVerified ? "bounded-workflow-checker-passed" : "not-complete",
				validationLimit: "Finite bounded cases are not exhaustive correctness or global-optimality proof" });
			console.log(JSON.stringify({ status: "private-campaign-complete", outcome: campaignOutcome, budget: budget.snapshot() }));
			if (campaignOutcome !== "fulfilled") process.exitCode = 1;
		} finally { clearTimeout(timer); }
	} finally {
		if (runId && !statusTaskTelemetry) {
			try {
				const goalFile = path.join(new Workspace(path.join(campaignRoot, "workspace")).runDir("M07", runId), "goal.json");
				const goal = JSON.parse(await readFile(goalFile, "utf8"));
				const lastTask = Array.isArray(goal.tasks) ? goal.tasks.at(-1) : undefined;
				if (lastTask) statusTaskTelemetry = await taskTelemetry(new Workspace(path.join(campaignRoot, "workspace")), lastTask, statusRuntimeKey);
			} catch { statusTaskTelemetry = { status: "unavailable" }; }
		}
		await preserveCandidate(new Workspace(path.join(campaignRoot, "workspace")), runId, outputDir).catch(() => undefined);
		await rm(campaignRoot, { recursive: true, force: true });
	}
}

export const offlineChecks = { sourceShape, deriveRuntimeCases, m04EvidenceReturned, inputs, stageProbe, verifierScratch,
	privateFailureMessage, credentialProbe, parseCheckerOutput, compareCandidateTimings, exportPrefixedArchive, preserveCandidate };

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main().catch(async error => {
		const preProvider = ["preflight", "isolated-preflight-passed", "workspace-init", "private-inputs-staged",
			"original-source-smoke", "source-and-isolation-preflight-passed"].includes(statusPhase);
		try { await saveStatus({ outcome: "incomplete", errorCategory: "campaign-exception",
			...(preProvider ? { privateDiagnostic: error instanceof SandboxPreflightError
				? error.privateDiagnostic : error instanceof Error ? error.message.slice(-2000) : "unknown pre-provider failure" } : {}),
			...(statusTaskTelemetry ? { taskTelemetry: statusTaskTelemetry } : {}),
			...(statusCredentialProbe ? { credentialProbe: statusCredentialProbe } : {}),
			...(statusAuthSource ? { sdkAuthSource: statusAuthSource } : {}),
			...(statusSdkAuthMatch !== undefined ? { sdkAuthMatch: statusSdkAuthMatch } : {}),
			independentValidation: "not-complete" }); } catch { /* transport synthesizes an incomplete status */ }
		// Never print the model response, source, input paths, credential, or raw provider errors.
		console.error(JSON.stringify({ status: "private-campaign-failed", category: "campaign-exception" }));
		process.exitCode = 1;
	});
}
