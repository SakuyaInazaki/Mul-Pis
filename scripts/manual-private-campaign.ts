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
import { runMeasuredEvidenceHandoff } from "../src/m07/evidence-finalization.ts";
import { assessAndAdvanceOriginalObjective, createOriginalObjective, objectiveProgress, runOriginalObjectiveLoop,
	writeObjectiveProgress, writeOriginalObjectiveContract } from "../src/m07/objective-progress.ts";
import type { ObjectiveProgressV1, ObjectiveStopReason } from "../src/m07/objective-progress.ts";
import type { CurrentGoal, M07TaskRecord, TaskSpecInput } from "../src/m07/types.ts";
import { runM04 } from "../src/stages/m04.ts";
import { createPiSessionRunner } from "../src/runner/pi.ts";
import type { SessionCheckpoint, SessionHandle, SessionRunner, SessionSpec } from "../src/runner/types.ts";
import { DeepSeekCampaignBudget } from "../src/runner/deepseek-campaign.ts";
import { createConfinedCampaignFileTools } from "../src/runner/confined-campaign-files.ts";
import { archivePrivateM07Task, recordPrivateM04Outcome } from "../src/workflow-archive/m07-private.ts";
import { buildCsrChecker } from "../src/workflow-archive/csr-checker.ts";
import { createExperienceProvider } from "../src/knowledge/experience-index.ts";
import type { KnowledgeRef, KnowledgeStore } from "../src/knowledge/types.ts";
import type { StageRunRecord } from "../src/types.ts";

const MODEL = "deepseek/deepseek-flash:low";
const MAX_CNY = 2.8;
const CAMPAIGN_MS = 20 * 60_000;
const BUILDER_PHASE_MS = 7 * 60_000;
const M04_PHASE_MS = 5 * 60_000;
const BUILDER_ROUNDS = 2;
const MAX_PROVIDER_CALLS = 64;
const FLAGS = ["-O2", "-std=c++17", "-fopenmp", "-pthread"];
const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHECKS = [
	"The two target parallel implementations in this bounded adapter pass are substantively different and adapter-frozen non-target source is preserved",
	"Original program checker and controller-owned independent finite full-row mutation checker pass on several CPU-only configurations",
	"Measured per-kernel timings are compared with the preserved original baselines; within the bounded rounds the candidate strategies are improved or selected for the strongest observed performance, with any lack of gain recorded honestly and no global-optimality claim",
];
const ARCHIVE_EVIDENCE_FILES = ["candidate.cpp", "verification.json", "lesson-delta.json", "review-decision.json",
	...Array.from({ length: 8 }, (_, index) => index + 1).flatMap(index => [
		`round-${index}-candidate.cpp`, `round-${index}-verification.json`,
		`round-${index}-reviewer-feedback.txt`, `round-${index}-reviewer-report.md`,
	])];
let statusOutputDir: string | undefined;
let statusRunId: string | undefined;
let statusBudget: DeepSeekCampaignBudget | undefined;
let statusPhase = "preflight";
let statusTaskTelemetry: Record<string, unknown> | undefined;
let statusBranchTelemetry: Record<string, unknown> | undefined;
let statusRuntimeKey: string | undefined;
let statusCredentialProbe: { httpStatus: number | null; accepted: boolean } | undefined;
let statusAuthSource: "runtime" | "unexpected" | undefined;
let statusSdkAuthMatch: boolean | undefined;
let statusArchiveFailure: string | undefined;

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
function privateExceptionDiagnostic(error: unknown, runtimeKey: string | undefined):
	{ code: string; category: string; message: string | null } {
	const raw = error instanceof Error ? error.message : undefined;
	const candidateCode = error && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
	const code = typeof candidateCode === "string" && /^[A-Za-z][A-Za-z0-9._-]{0,63}$/.test(candidateCode) &&
		privateFailureMessage(candidateCode, runtimeKey) === candidateCode ?
		candidateCode : "unavailable";
	return { code, category: taskFailureCategory(raw), message: privateFailureMessage(raw, runtimeKey) ?? null };
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
	const tasks = goal.tasks.filter(item => item.mode === "execute").slice(0, 2);
	if (!tasks.length) return;
	await archivePrivateM07Task({ goal, task: tasks[0], destination: outputDir });
	if (tasks[1]) {
		const temporary = await mkdtemp(path.join(os.tmpdir(), "mulpis-private-fallback-"));
		try {
			await archivePrivateM07Task({ goal, task: tasks[1], destination: temporary });
			await exportPrefixedArchive(temporary, outputDir, "branch-child");
		} finally { await rm(temporary, { recursive: true, force: true }); }
	}
}
async function forkReceiptMatches(file: string | undefined, checkpoint: SessionCheckpoint, childSessionId: string | undefined): Promise<boolean> {
	if (!file || !childSessionId) return false;
	try {
		const info = await lstat(file);
		if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > 128_000) return false;
		const receipt = JSON.parse(await readFile(file, "utf8")) as Record<string, any>;
		return receipt.version === 1 && receipt.state === "committed" && receipt.intent === "branch-exploration" &&
			receipt.checkpoint?.id === checkpoint.id && receipt.checkpoint?.leafId === checkpoint.leafId &&
			receipt.parent?.sessionId === checkpoint.sourceSessionId && receipt.parent?.leafId === checkpoint.leafId &&
			receipt.child?.sessionId === childSessionId && receipt.child?.sessionId !== checkpoint.sourceSessionId &&
			receipt.inheritedUsageBilled === false;
	} catch { return false; }
}
async function contextLineageSummary(file: string | undefined, checkpoint: SessionCheckpoint,
	childSessionId: string | undefined, childModel: string | undefined,
	expectedProblemSnapshotCopy: string, expectedModel = MODEL): Promise<Record<string, unknown>> {
	const identityMatches = await forkReceiptMatches(file, checkpoint, childSessionId);
	let evidenceBindingCount = 0, workspaceBindingFileCount = 0;
	let frozenManifestBinding = false, frozenProblemBinding = false, workspaceBindingPresent = false;
	if (identityMatches && file) {
		try {
			const receipt = JSON.parse(await readFile(file, "utf8")) as Record<string, any>;
			const bindings = receipt.evidenceBindings;
			const workspace = receipt.workspaceBinding;
			evidenceBindingCount = Array.isArray(bindings) ? bindings.length : 0;
			workspaceBindingFileCount = Array.isArray(workspace?.files) ? workspace.files.length : 0;
			frozenManifestBinding = evidenceBindingCount === 2 && bindings[0]?.status === "frozen-copy" &&
				bindings[0]?.path === checkpoint.manifestSnapshot && bindings[0]?.sourceVersion === checkpoint.id;
			frozenProblemBinding = evidenceBindingCount === 2 && path.isAbsolute(expectedProblemSnapshotCopy) &&
				Boolean(checkpoint.taskId) && bindings[1]?.status === "frozen-copy" &&
				bindings[1]?.path === expectedProblemSnapshotCopy &&
				bindings[1]?.sourceVersion === `${checkpoint.runId}/${checkpoint.taskId}`;
			workspaceBindingPresent = workspace?.version === 1 && workspaceBindingFileCount > 0;
		} catch { /* Only finite, allowlisted scalar fields leave the workspace. */ }
	}
	const exactModel = checkpoint.model === expectedModel && childModel === expectedModel;
	const verified = identityMatches && frozenManifestBinding && frozenProblemBinding && workspaceBindingPresent && exactModel;
	return { version: 1, kind: "private-context-lineage-summary", state: verified ? "verified" : "unverified",
		checkpointId: checkpoint.id, parentSessionId: checkpoint.sourceSessionId, frozenLeafId: checkpoint.leafId,
		childSessionId: childSessionId ?? null, intent: "branch-exploration", model: expectedModel,
		evidenceBindingCount, workspaceBindingFileCount,
		driverChecks: { committedExactLineage: identityMatches, exactModel,
			frozenManifestBinding, frozenProblemBinding, workspaceBindingPresent },
		limitation: "Counts and a committed receipt identify the fork; this summary does not reprint or independently reread the inherited transcript." };
}
/** Flat encrypted-transport layout; the renamed manifest is an index, not a default loader input. */
async function exportPrefixedArchive(sourceDir: string, outputDir: string,
	prefix: string): Promise<void> {
	if (!(["initial", "followon", "branch-parent", "branch-child"].includes(prefix) ||
		/^iteration-(?:[1-9]|[1-5][0-9]|6[0-4])$/.test(prefix))) fail("unsupported private archive transport prefix");
	for (const name of ARCHIVE_EVIDENCE_FILES) if (existsSync(path.join(sourceDir, name)))
		await copyFile(path.join(sourceDir, name), path.join(outputDir, `${prefix}-${name}`));
	const archive = JSON.parse(await readFile(path.join(sourceDir, "workflow-archive.json"), "utf8")) as Record<string, any>;
	for (const item of archive.files ?? []) item.name = `${prefix}-${item.name}`;
	for (const item of archive.controllerEvidence?.rounds ?? []) {
		if (item.candidate?.file) item.candidate.file = `${prefix}-${item.candidate.file}`;
		if (item.verification?.file) item.verification.file = `${prefix}-${item.verification.file}`;
		if (item.feedbackFile) item.feedbackFile = `${prefix}-${item.feedbackFile}`;
		if (item.reviewerReport?.file) item.reviewerReport.file = `${prefix}-${item.reviewerReport.file}`;
	}
	if (archive.controllerEvidence?.reviewDecision?.file) archive.controllerEvidence.reviewDecision.file = `${prefix}-${archive.controllerEvidence.reviewDecision.file}`;
	if (archive.m04?.knowledgeExport?.state === "complete") {
		if (archive.m04.knowledgeExport.file !== "m04-adopted-knowledge.json" ||
			!existsSync(path.join(sourceDir, "m04-adopted-knowledge.json")))
			fail("complete M04 knowledge export is unavailable for prefixed archive");
		await copyFile(path.join(sourceDir, "m04-adopted-knowledge.json"),
			path.join(outputDir, `${prefix}-m04-adopted-knowledge.json`));
		archive.m04.knowledgeExport.file = `${prefix}-m04-adopted-knowledge.json`;
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
function safeTargetDirectives(body: string): boolean {
	const conditionals: Array<{ elseSeen: boolean }> = [];
	for (const match of body.matchAll(/^\s*#\s*([^\n]*)/gm)) {
		const directive = match[1].trim();
		if (/^pragma\s+omp\b/.test(directive)) continue;
		if (/^(?:ifdef\s+_OPENMP|if\s+defined\s*(?:\(\s*_OPENMP\s*\)|_OPENMP))\s*$/.test(directive)) {
			conditionals.push({ elseSeen: false }); continue;
		}
		if (directive === "else" && conditionals.length && !conditionals.at(-1)!.elseSeen) {
			conditionals.at(-1)!.elseSeen = true; continue;
		}
		if (directive === "endif" && conditionals.length) { conditionals.pop(); continue; }
		return false;
	}
	return conditionals.length === 0;
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
	if (bodies.some(body => body && !safeTargetDirectives(body)))
		return { ok: false, reason: "required target body contains an unsafe or unbalanced preprocessor directive", targetCount: targets.length };
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
			let completeTerminalPage = false;
			for (const item of relevant) {
				if (item.path !== relevant[0].path) continue;
				const start = item.returned!.startLine as number, end = item.returned!.endLine as number;
				if (start < 1 || end < start || end > totalLines) continue;
				for (let line = start; line <= end; line++) covered[line - 1] = true;
				if (end === totalLines && item.returned?.truncated === false) completeTerminalPage = true;
			}
			if (!covered.length || !completeTerminalPage || covered.some(flag => !flag)) return { complete: false, paths };
			paths.push(relevant[0].path as string);
		}
		return { complete: true, paths };
	} catch { return { complete: false, paths: [] }; }
}
function selectedM07ReviewReadPaths(goalRoot: string, task: M07TaskRecord): string[] {
	if (task.status !== "accepted" || !task.review || !/^T\d{3,}$/.test(task.taskId))
		fail("selected M07 task lacks an accepted frozen review");
	return ["candidate.cpp", "verification.json", "lesson-delta.json"].map(name => {
		const source = path.join(task.workDir, name);
		const artifacts = task.review!.artifacts.filter(item => item.sourcePath === source);
		if (artifacts.length !== 1) fail("selected M07 review evidence is missing or ambiguous");
		const relative = path.relative(goalRoot, artifacts[0].path).replaceAll("\\", "/");
		const escaped = name.replace(".", "\\.");
		if (!new RegExp(`^tasks/${task.taskId}/review-snapshot/\\d{3}-${escaped}$`).test(relative))
			fail("selected M07 review evidence is outside the expected frozen task snapshot");
		return relative;
	});
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
function chooseForkWinner(parentAccepted: boolean, forkAccepted: boolean, sourceChanged: boolean,
	comparison: { state?: string; medianRatio?: number; minRatio?: number }): "parent" | "fork" | undefined {
	if (forkAccepted && (!parentAccepted || (sourceChanged && comparison.state === "measured" &&
		comparison.medianRatio !== undefined && comparison.medianRatio > 1.03 &&
		comparison.minRatio !== undefined && comparison.minRatio >= 0.95))) return "fork";
	return parentAccepted ? "parent" : undefined;
}
function chooseFollowOnCandidate(previousAccepted: boolean, followOnAccepted: boolean, sourceChanged: boolean,
	comparison: { state?: string; medianRatio?: number; minRatio?: number }): boolean {
	return followOnAccepted && (!previousAccepted || (sourceChanged && comparison.state === "measured" &&
		comparison.medianRatio !== undefined && comparison.medianRatio > 1.03 &&
		comparison.minRatio !== undefined && comparison.minRatio >= 0.95));
}
function firstM07Accepted(acceptedWinner: boolean, finishedOutcome: unknown): boolean {
	return acceptedWinner && finishedOutcome === "fulfilled";
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
		maxProviderCalls: MAX_PROVIDER_CALLS, maxProviderCallsPerPrompt: 32,
		maxOutputTokens: 64_000, outputAccountingMarginTokens: 32,
		maxInputCnyPerMillionTokens: 4, maxCacheReadCnyPerMillionTokens: 0.2,
		maxOutputCnyPerMillionTokens: 16, cnyPerUsdCeiling: 10 });
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
		const originalObjective = createOriginalObjective({
			goal: "Find the strongest currently attainable strategy for the supplied private optimization problem, supported by correctness and measured performance across the permitted search space.",
			goalSource: "user-intent-summary", inputNames: found.files,
			obligations: [
				{ id: "original-task", description: "Address the full supplied original task and user intent; the original private materials control the scientific requirements, and the model must state specific unresolved requirements from them." },
			], closure: "open-ended",
		});
		const objectiveContractFile = path.join(outputDir, "original-objective.json");
		const objectiveCheckpointFile = path.join(outputDir, "objective-checkpoint.json");
		await writeOriginalObjectiveContract(objectiveContractFile, originalObjective);
		await writeObjectiveProgress(objectiveCheckpointFile, objectiveProgress(originalObjective,
			{ boundedRuns: [], selectedArtifacts: [], stopReason: "bounded-run-incomplete" }));
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
			const confinedSpec = async (spec: SessionSpec): Promise<SessionSpec> => {
				if (spec.tools.kind !== "execution") return spec;
				if (!/^M07-T\d+$/.test(spec.label)) fail("unexpected execution session");
				const tools = await createConfinedCampaignFileTools(spec.tools.root,
					{ writableFiles: ["candidate.cpp", "lesson-delta.json"] });
				return { ...spec, tools: { kind: "custom", tools } };
			};
			const checkedHandle = (handle: SessionHandle, workDir: string): SessionHandle => ({
				...handle, prompt: async (message: string) => {
						const candidate = path.join(workDir, "candidate.cpp");
						const verification = path.join(workDir, "verification.json");
						const previousPhase = statusPhase;
						const turn = await runMeasuredEvidenceHandoff({ handle,
							implementationPrompt: message, sourceFile: candidate, evidenceFile: verification,
							measure: async () => {
								statusPhase = "host-verification";
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
								await writeFile(verification, JSON.stringify(result, null, 2), { mode: 0o600 });
							},
							finalizationPrompt: "Evidence-finalization phase for this same M07 task. The host just measured the current candidate and wrote verification.json. Use the read tool to read the complete current verification.json before making claims; earlier reports and measurements may describe a different candidate or timing run. You may read candidate.cpp and lesson-delta.json, and update only lesson-delta.json. Do not write or edit candidate.cpp or verification.json. Report the exact current measured facts, including shape-dependent winners, regressions and limitations, without inventing or reusing stale numbers. The lesson-delta.json schema is version 1 with action none, propose, amend or contradict and an evidencePaths array of at most 20 relative task paths. A proposal needs a nonempty observation and applicability and at least one evidence path such as verification.json. Amend or contradict additionally requires an exact pinned priorRef with storeId, recordId and integer version; if no such adopted prior record is available, use propose or none. None can use an empty evidencePaths array. This is only a pending lesson candidate; do not claim M04 adoption. Your response is the final evidence-grounded report for the fresh reviewer: aim below 4,000 characters, cite decisive measured values and caveats, and do not copy the full verification file. No code changes.",
							readToolName: "read", onFinalization: () => { statusPhase = "evidence-finalization"; },
						});
						statusPhase = previousPhase;
						return turn;
					},
			});
			const runner: SessionRunner = {
				capabilities: () => actual.capabilities(),
				attestConfinedGrant: handle => actual.attestConfinedGrant(handle),
				create: async spec => {
					const transformed = await confinedSpec(spec);
					const handle = await actual.create(transformed);
					return spec.tools.kind === "execution" ? checkedHandle(handle, spec.tools.root) : handle;
				},
				checkpoint: (handle, envelope) => actual.checkpoint(handle, envelope),
				fork: async request => {
					const transformed = await confinedSpec(request.spec);
					const handle = await actual.fork({ ...request, spec: transformed });
					return request.spec.tools.kind === "execution" ? checkedHandle(handle, request.spec.tools.root) : handle;
				},
				resume: ref => actual.resume(ref),
			};
			const controller = createM07Controller({ ws, store, runner, config: await ws.loadConfig() });
			const goal = await controller.begin({ goal: "Seek the strongest measured C++ parallel optimization attainable within this bounded private campaign, using the original inputs and preserved baselines.",
				problemRelation: `Bounded child of original objective ${originalObjective.id}: ${originalObjective.goal}. Code and machine-readable correctness/performance scope only.`,
				constraints: ["Use only the supplied private inputs and configured DeepSeek model.",
					"This bounded adapter run edits only two existing target bodies and preserves the other source, main and built-in checker. The supplied problem allows a broader strategy search; this run measures only the two-target pass.",
					"No prose report, screenshots, presentation, or personal reflection; no fabricated measurements."],
				successCriteria: CHECKS,
				plan: "Continue one bounded builder through reviewer feedback, fork one measured competing refinement from its settled leaf, independently review both candidates, and select the observed winner before M04.",
				exploratory: true });
			runId = goal.runId;
			statusRunId = runId;
			statusPhase = "m07-begun";
			statusPhase = "model-dispatch";
			const initialSpec: TaskSpecInput = { mode: "execute",
				objective: "Read the copied original inputs. Within this bounded two-target pass, replace the existing TODO parallel implementations with genuinely different OpenMP strategies in a complete candidate.cpp. Keep the other source and original checker/main for this adapter's trusted comparison. The supplied problem allows further strategies; report the scope actually tested. Examine host-generated verification.json after a round, compare actual per-kernel timings with original baselines, and use any remaining bounded round to improve or select the strongest observed valid candidate. If no gain is observed, say so; do not claim a global optimum. Write a bounded candidate lesson-delta.json with actual observation, applicability and evidencePaths, or action none when the evidence supports no lesson. This lesson is pending M04, never self-adopted. Use only the provided confined read/write/edit tools; do not call shell or network. The host creates verification.json after your turn; do not write it. Do not create prose deliverables.",
				inputs: found.files.map(x => `problem/raw/${x}`), expectedOutputs: ["candidate.cpp", "lesson-delta.json"], lessonDeltaOutput: "lesson-delta.json", checks: CHECKS,
				executionLoop: { maxRounds: BUILDER_ROUNDS, deadlineAt: new Date(Math.min(Date.now() + BUILDER_PHASE_MS, campaignStopAt - 9 * 60_000)).toISOString() } };
			const task = await controller.delegate(runId, initialSpec);
			statusPhase = "parent-task-returned";
			statusTaskTelemetry = await taskTelemetry(ws, task, runtimeKey);
			const parentCandidate = path.join(task.workDir, "candidate.cpp");
			const parentVerification = path.join(task.workDir, "verification.json");
			let parentResult: Record<string, unknown> | undefined;
			try { parentResult = JSON.parse(await readFile(parentVerification, "utf8")) as Record<string, unknown>; } catch { /* no parent verification */ }
			const accepted = task.status === "returned" && task.loopStopReason === "ready" && parentResult?.status === "passed";
			if (task.status === "returned" && task.reportPath) {
				statusPhase = "parent-review";
				const review = await controller.review(runId, { taskId: task.taskId,
					checks: CHECKS.map((criterion, i) => ({ criterion, result: accepted ? "passed" : "failed",
						evidence: accepted ? [i === 0 ? parentCandidate : parentVerification] : [] })),
					artifacts: [task.reportPath, ...(existsSync(parentCandidate) ? [parentCandidate] : []), ...(existsSync(parentVerification) ? [parentVerification] : [])],
					failures: accepted ? [] : ["bounded candidate did not pass all observed checks"] });
				if (accepted && review.status !== "accepted") fail("M07 review did not accept candidate");
			}
			statusPhase = "parent-reviewed";
			let branchTask: Awaited<ReturnType<typeof controller.delegate>> | undefined;
			let branchAccepted = false;
			let branchExerciseComplete = false;
			let branchComparison: { state?: string; medianRatio?: number; minRatio?: number } = { state: "unavailable" };
			let branchState: Record<string, unknown> = { state: "not_run", reason: "no settled source checkpoint or remaining campaign boundary" };
			let winner = accepted ? task : undefined;
			if (task.branchSource && !budget.snapshot().stopped && !abort.signal.aborted && Date.now() + 5 * 60_000 < campaignStopAt) {
				followOnPriorVerification = parentResult;
				statusPhase = "fork-dispatch";
				const forked = await controller.delegate(runId, { ...initialSpec,
					context: { mode: "fork", parentRunId: runId, parentTaskId: task.taskId,
						checkpointId: task.branchSource.checkpoint.id },
					executionLoop: { maxRounds: BUILDER_ROUNDS, deadlineAt: new Date(Math.min(Date.now() + 4 * 60_000,
						campaignStopAt - 5 * 60_000)).toISOString() } });
				branchTask = forked;
				statusPhase = "fork-task-returned";
				statusBranchTelemetry = await taskTelemetry(ws, forked, runtimeKey);
				const branchCandidate = path.join(forked.workDir, "candidate.cpp");
				const branchVerification = path.join(forked.workDir, "verification.json");
				let branchResult: Record<string, unknown> | undefined;
				try { branchResult = JSON.parse(await readFile(branchVerification, "utf8")) as Record<string, unknown>; } catch { /* no branch verification */ }
				branchComparison = (branchResult?.priorCandidateComparison as typeof branchComparison | undefined) ?? { state: "unavailable" };
				branchAccepted = forked.status === "returned" && forked.loopStopReason === "ready" && branchResult?.status === "passed";
				let forkReviewStatus = forked.status;
				if (forked.status === "returned" && forked.reportPath) {
					statusPhase = "fork-review";
					const reviewed = await controller.review(runId, { taskId: forked.taskId,
						checks: CHECKS.map((criterion, i) => ({ criterion, result: branchAccepted ? "passed" : "failed",
							evidence: branchAccepted ? [i === 0 ? branchCandidate : branchVerification] : [] })),
						artifacts: [forked.reportPath, ...(existsSync(branchCandidate) ? [branchCandidate] : []),
							...(existsSync(branchVerification) ? [branchVerification] : [])],
						failures: branchAccepted ? [] : ["forked candidate did not pass all observed checks"] });
					forkReviewStatus = reviewed.status;
					if (branchAccepted && reviewed.status !== "accepted") fail("forked M07 review did not accept candidate");
				}
				statusPhase = "fork-reviewed";
				const sourceChanged = !existsSync(parentCandidate) || !existsSync(branchCandidate) ||
					!(await readFile(parentCandidate)).equals(await readFile(branchCandidate));
				const preference = chooseForkWinner(accepted, branchAccepted, sourceChanged, branchComparison);
				winner = preference === "fork" ? forked : preference === "parent" ? task : undefined;
				const lineageSummary = await contextLineageSummary(forked.session?.lineageFile,
					task.branchSource.checkpoint, forked.session?.id, forked.session?.model,
					task.branchSource.problemSnapshotCopy);
				await writeFile(path.join(outputDir, "context-lineage.json"), `${JSON.stringify(lineageSummary, null, 2)}\n`, { mode: 0o600 });
				const trueForkReceipt = lineageSummary.state === "verified";
				if (["accepted", "rejected", "failed"].includes(forkReviewStatus)) {
					statusPhase = "branch-selection";
					await controller.selectBranch(runId, { parentTaskId: task.taskId,
						...(winner ? { selectedTaskId: winner.taskId } : {}),
						rationale: winner ? "Select the ordinarily reviewed candidate with the strongest bounded host-owned timing and no material regression; unproven speedups are not promoted." :
							"Neither candidate met the ordinary M07 review and bounded independent checks." });
					branchExerciseComplete = trueForkReceipt;
				}
				statusPhase = "branch-selected";
				branchState = { state: branchExerciseComplete ? "completed" : "incomplete", parentTaskId: task.taskId,
					forkTaskId: forked.taskId, checkpointId: task.branchSource.checkpoint.id,
					parentSessionId: task.branchSource.checkpoint.sourceSessionId, forkSessionId: forked.session?.id ?? null,
					trueForkReceipt,
					parentAccepted: accepted, forkAccepted: branchAccepted, sourceChanged,
					measuredGainSupported: sourceChanged && accepted && preference === "fork",
					measuredComparison: branchComparison,
					selectedTaskId: winner?.taskId ?? null, taskTelemetry: statusBranchTelemetry };
			}
			const acceptedWinner = branchExerciseComplete && Boolean(winner);
			const selectedTask = winner ?? task;
			let candidate = path.join(selectedTask.workDir, "candidate.cpp");
			let verificationPath = path.join(selectedTask.workDir, "verification.json");
			statusPhase = "first-goal-finishing";
			const finished = await controller.finish(runId, { outcome: acceptedWinner ? "fulfilled" : "partial", returnPath: "user",
				summary: acceptedWinner ? "M07 builder, true refinement fork, fresh reviews and measured branch selection completed." :
					"M07 attempt or true branch selection was incomplete.",
				goalChecks: CHECKS.map((criterion, i) => ({ criterion, result: acceptedWinner ? "passed" : "not_run",
					evidence: acceptedWinner ? [i === 0 ? candidate : verificationPath] : [] })),
				limitations: ["The workflow-owned independent checker covers bounded shapes, mutations and threads; it is not exhaustive proof of correctness or optimality."] });
			const firstGoalReady = firstM07Accepted(acceptedWinner, finished.outcome);
			statusPhase = "first-goal-finished";
			const frozenGoal = await controller.status(runId);
			const frozenTask = frozenGoal.tasks.find(item => item.taskId === selectedTask.taskId);
			if (!frozenTask) fail("finished M07 task identity is unavailable for private archive");
			const selectedM04ReadPaths = firstGoalReady ? selectedM07ReviewReadPaths(ws.runDir("M07", runId), frozenTask) : [];
			statusPhase = "private-archive";
			const privateArchive = await archivePrivateM07Task({ goal: frozenGoal, task: frozenTask, destination: outputDir });
			const parentArchiveDir = path.join(campaignRoot, "branch-parent-archive");
			await archivePrivateM07Task({ goal: frozenGoal, task: frozenGoal.tasks.find(item => item.taskId === task.taskId)!,
				destination: parentArchiveDir });
			await exportPrefixedArchive(parentArchiveDir, outputDir, "branch-parent");
			if (branchTask) {
				const childArchiveDir = path.join(campaignRoot, "branch-child-archive");
				await archivePrivateM07Task({ goal: frozenGoal, task: frozenGoal.tasks.find(item => item.taskId === branchTask.taskId)!,
					destination: childArchiveDir });
				await exportPrefixedArchive(childArchiveDir, outputDir, "branch-child");
			}
			let finalArchive = privateArchive;
			let selectedCandidateSource: "initial" | "fork" | "followon" | "none" = firstGoalReady ?
				selectedTask.taskId === task.taskId ? "initial" : "fork" : "none";
			let m04: { status: "completed" | "failed" | "not_run"; runId?: string; proposalSubmitted?: boolean;
				snapshotCreated?: boolean; evidenceReturned?: boolean; adoptedExperienceRefs?: KnowledgeRef[];
				failure?: ReturnType<typeof privateExceptionDiagnostic> } = { status: "not_run" };
			if (firstGoalReady && branchExerciseComplete && !budget.snapshot().stopped && !abort.signal.aborted) {
				statusPhase = "m04-dispatch";
				const m04Abort = new AbortController();
				const m04Timer = setTimeout(() => m04Abort.abort(), M04_PHASE_MS);
				try {
					const m04Runner = createPiSessionRunner({ modelRuntime: runtime,
						signal: AbortSignal.any([abort.signal, m04Abort.signal]), campaignBudget: budget });
					const processed = await runM04({ ws, store, runner: m04Runner, config: await ws.loadConfig() },
						{ feedback: { kind: "M07", runId }, freshSession: true,
							requiredM07ReadPaths: selectedM04ReadPaths,
							purpose: "Adjudicate bounded M07 candidate lessons and limits" });
					const complete = processed.record.status === "completed" && processed.record.failures.length === 0;
					const coverage = firstGoalReady ? await m04EvidenceReturned(processed.record, selectedTask.taskId) :
						{ complete: false, paths: [] };
					m04 = { status: complete ? "completed" : "failed", runId: processed.record.runId,
						proposalSubmitted: Boolean(processed.proposalId), snapshotCreated: Boolean(processed.snapshotId),
						evidenceReturned: coverage.complete && selectedM04ReadPaths.every(item => coverage.paths.includes(item)),
						adoptedExperienceRefs: complete ? await adoptedExperienceRefs(store, processed.record.runId,
							coverage.complete && selectedM04ReadPaths.every(item => coverage.paths.includes(item))) : [] };
				} catch (error) { m04 = { status: "failed", adoptedExperienceRefs: [],
					failure: privateExceptionDiagnostic(error, runtimeKey) }; }
				finally { clearTimeout(m04Timer); }
			}
			const archivedM04 = await recordPrivateM04Outcome(outputDir, { state: m04.status === "not_run" ? "not-run" : m04.status,
				...(m04.runId ? { runId: m04.runId } : {}), proposalSubmitted: m04.proposalSubmitted ?? false,
				snapshotCreated: m04.snapshotCreated ?? false, adoptedExperienceRefs: m04.adoptedExperienceRefs ?? [] }, store);
			const knowledgeExport = archivedM04.m04?.knowledgeExport ?? { state: "incomplete", reason: "M04 export state unavailable" };
			const m04AdoptedExperienceCount = m04.runId ? (await store.list()).filter(record =>
				record.source.stage === "M04" && record.source.runId === m04.runId &&
				record.usageDecision === "adopted" && record.fields.experience !== undefined).length : 0;
			const m04SelectedReadContractSatisfied = m04.evidenceReturned === true;
			const m04AdoptionReadContractSatisfied = m04AdoptedExperienceCount === 0 || m04.evidenceReturned === true;
			const reusableRefs = m04.evidenceReturned && knowledgeExport.state === "complete" ?
				(m04.adoptedExperienceRefs ?? []).filter(ref => (archivedM04.m04?.adoptedExperienceRefs ?? []).some(exported =>
					exported.storeId === ref.storeId && exported.recordId === ref.recordId && exported.version === ref.version)) : [];
			let followOn: Record<string, unknown> = { state: "not_run", reason: "M04, seed, budget or time boundary unavailable" };
			const followOnAttempts: Array<Record<string, unknown>> = [];
			let followOnSourceChanged: boolean | null = null;
			let objectiveAssessment: ObjectiveProgressV1["assessment"];
			let latestAssessmentAdvanced = false;
			const assessmentHistory: ObjectiveProgressV1["assessmentHistory"] = [];
			const objectiveReceipts: Array<Record<string, unknown>> = [];
			let objectiveStopReason: ObjectiveStopReason = "bounded-run-incomplete";
			let currentM04Status = m04.status;
			let currentM04Read = m04SelectedReadContractSatisfied;
			let currentKnowledgeExport = knowledgeExport;
			let currentReusableRefs = reusableRefs;
			let currentKnowledgeFile = existsSync(path.join(outputDir, "m04-adopted-knowledge.json")) ?
				path.join(outputDir, "m04-adopted-knowledge.json") : undefined;
			let currentSelectedGoalRunId = runId!;
			let currentSelectedTaskId = selectedTask.taskId;
			let latestAttemptEvidence: Array<{ name: string; file: string }> = [];
			const loop = await runOriginalObjectiveLoop({ maxIterations: MAX_PROVIDER_CALLS,
				admission: () => {
					if (budget.snapshot().stopped) return budget.snapshot().stopReason === "ceiling" ?
						"budget-boundary" : "bounded-run-incomplete";
					if (abort.signal.aborted || Date.now() + 90_000 >= campaignStopAt) return "time-boundary";
					if (currentM04Status === "failed") return "m04-evidence-incomplete";
					if (!firstGoalReady || currentM04Status !== "completed" || currentKnowledgeExport.state === "incomplete" ||
						!currentM04Read || !existsSync(candidate) || !existsSync(verificationPath)) return "bounded-run-incomplete";
					return "admitted";
				},
				step: async iteration => {
				let advancedThisIteration = false;
				let assessmentThisIteration = false;
				let activeFollowOnGoalId: string | undefined;
				let activeFollowOnTaskId: string | undefined;
				statusPhase = "original-objective-assessment";
				try {
					const objectiveRecord = await ws.startRun("M07Objective", [
						{ label: "Frozen original objective", path: objectiveContractFile },
						{ label: "Original private problem", path: ws.problemFile },
						{ label: "Selected bounded candidate", path: candidate },
						{ label: "Selected bounded verification", path: verificationPath },
					]);
					const saveObjectiveReceipt = async () => {
						await ws.writeRun(objectiveRecord);
						const receipt = {
							version: 1, kind: "m07-original-objective-assessment", runId: objectiveRecord.runId,
							status: objectiveRecord.status, sessions: objectiveRecord.sessions.map(item => ({
								sessionId: item.id, role: item.role, model: item.model,
								boundaryMode: item.boundary?.mode ?? "unknown", boundaryIntent: item.boundary?.intent ?? "unknown",
								toolGrantKind: item.boundary?.toolGrantKind ?? "unknown",
								evidenceLabels: item.boundary?.evidence.map(entry => entry.label) ?? [],
							})),
						};
						await writeFile(path.join(outputDir, "objective-assessment-receipt.json"),
							JSON.stringify(receipt, null, 2), { mode: 0o600 });
						const receiptIndex = objectiveReceipts.findIndex(item => item.runId === objectiveRecord.runId);
						if (receiptIndex >= 0) objectiveReceipts[receiptIndex] = receipt;
						else objectiveReceipts.push(receipt);
						await writeFile(path.join(outputDir, "objective-assessment-receipts.json"),
							JSON.stringify({ version: 1, kind: "m07-original-objective-assessment-receipts",
								receipts: objectiveReceipts }, null, 2), { mode: 0o600 });
					};
					const evidence = [
						{ name: "original-problem.txt", file: ws.problemFile },
						...found.files.map((name, index) => ({ name: `original-input-${index + 1}.txt`,
							file: path.join(ws.rawDir, name) })),
						{ name: "candidate.cpp", file: candidate },
						{ name: "verification.json", file: verificationPath },
						{ name: "workflow-archive.json", file: path.join(outputDir, "workflow-archive.json") },
						...(currentKnowledgeFile ? [{ name: "m04-knowledge.json", file: currentKnowledgeFile }] : []),
						...latestAttemptEvidence,
					];
					const assessmentAdmission = "admitted";
					let objectiveStep;
					try { objectiveStep = await assessAndAdvanceOriginalObjective({
						contract: originalObjective, contractFile: objectiveContractFile,
						runner: actual, runRecord: objectiveRecord, persistReceipt: saveObjectiveReceipt,
						sessionSpec: { label: `M07-original-objective-assessment-${iteration}`, role: "research", model: MODEL,
							systemPrompt: "Independently assess the original research goal using the frozen evidence. Read the complete supplied files before proposing further work. Return only the requested structured judgment; acknowledge uncertainty, bounded search scope and failed checks. Do not invent measurements or treat M04 adoption as proof of performance.",
							persistDir: ws.sessionsDir },
						evidenceRoot: path.join(campaignRoot, `objective-evidence-${iteration}`), evidence,
						assessmentAdmission,
						advanceAdmission: () => budget.snapshot().stopped ?
							budget.snapshot().stopReason === "ceiling" ? "budget-boundary" : "assessment-failed" :
							abort.signal.aborted || Date.now() + 90_000 >= campaignStopAt ? "time-boundary" : "admitted",
						supportedTaskScopes: ["two-target-existing"],
						recordAssessment: async assessment => {
							objectiveAssessment = assessment;
							assessmentThisIteration = true;
							assessmentHistory.push({ iteration, assessment, stopReason: "assessment-validation-pending", advanced: false });
							await writeObjectiveProgress(objectiveCheckpointFile, objectiveProgress(originalObjective,
								{ boundedRuns: [{ runId: runId!, outcome: finished.outcome ?? "unknown",
									...(firstGoalReady ? { selectedTaskId: selectedTask.taskId } : {}) }],
									selectedArtifacts: ["candidate.cpp", "verification.json", "workflow-archive.json"],
									assessment, assessmentHistory, stopReason: "assessment-validation-pending" }));
						},
						advance: async proposal => {
							statusPhase = "model-proposed-m07-dispatch";
						const prior = JSON.parse(await readFile(verificationPath, "utf8")) as Record<string, unknown>;
							followOnPriorVerification = prior;
							const seedDir = path.join(ws.root, "objective-seeds");
							await mkdir(seedDir, { recursive: true, mode: 0o700 });
							const seedPath = path.join(seedDir, `prior-candidate-seed-${iteration}.json`);
							const summary = Array.isArray(prior.originalCheckerRuns) ? prior.originalCheckerRuns.map((row: Record<string, unknown>) => ({
								args: row.args, exitCode: row.exitCode, reportedKernelMs: row.reportedKernelMs })) : [];
							await writeFile(seedPath, JSON.stringify({ version: 1, sourceGoalRunId: currentSelectedGoalRunId, sourceTaskId: currentSelectedTaskId,
								status: prior.status, independent: prior.independent, measuredCases: summary }, null, 2), { mode: 0o600 });
							const secondGoal = await controller.begin({
								goal: `Bounded continuation of original objective ${originalObjective.id}: ${proposal.objective}`,
								problemRelation: `Model-proposed work addressing unresolved original obligations ${proposal.addresses.join(", ")}; original goal: ${originalObjective.goal}`,
								constraints: ["Prior candidate and measurements are development evidence, not adopted truth.",
									"Use only M04-adopted pinned experience refs that pass current applicability and live-limit checks.",
									"Keep this adapter's two-target scope and preserve non-target code and built-in checker; no prose report or personal reflection."],
								successCriteria: CHECKS,
								plan: `Investigate the model-proposed next work against the original unresolved obligations: ${proposal.addresses.join(", ")}. Inspect prior candidate and measurements, then run one fresh bounded builder/reviewer loop.`,
								exploratory: false,
							});
							activeFollowOnGoalId = secondGoal.runId;
						const proposedRefs = currentReusableRefs;
							const tags = ["execute", "numeric", "cpu", "cpp-parallel"];
							const selection = await createExperienceProvider(store).select({ targetKind: "executor",
								applicability: { stage: "M07", tags }, requestedRefs: proposedRefs,
								expectedSnapshotId: secondGoal.knowledgeSnapshot, maxRecords: 24, maxChars: 24_000 });
							const pinnedRefs = selection.status === "ready" ? proposedRefs : [];
						const seedInputs = [path.relative(ws.root, candidate), path.relative(ws.root, seedPath)];
							const secondTask = await controller.delegate(secondGoal.runId, { mode: "execute",
								objective: `${proposal.objective}\n\nInspect the supplied prior candidate and prior-candidate-seed.json as untrusted development evidence. Address original obligations ${proposal.addresses.join(", ")}. Produce a complete candidate.cpp under the adapter's fixed source scope, write a pending lesson-delta.json or action none, and report negative or mixed measured results honestly. Use only confined read/write/edit; the host writes verification.json; no shell, network or prose deliverables.`,
								inputs: [...found.files.map(x => `problem/raw/${x}`), ...seedInputs],
								expectedOutputs: ["candidate.cpp", "lesson-delta.json"], lessonDeltaOutput: "lesson-delta.json", checks: CHECKS,
								...(pinnedRefs.length ? { experienceRefs: pinnedRefs, experienceTags: tags } : {}),
								executionLoop: { maxRounds: 2, deadlineAt: new Date(Math.min(Date.now() + BUILDER_PHASE_MS, campaignStopAt - 45_000)).toISOString() },
							});
							activeFollowOnTaskId = secondTask.taskId;
							return { secondGoal, secondTask, proposedRefs, selection, pinnedRefs };
						},
					});
						objectiveRecord.outputs.push({ label: "Original objective checkpoint", path: objectiveCheckpointFile });
						await ws.finishRun(objectiveRecord, objectiveStep.assessment?.unreadEvidence.length === 0 ? "completed" : "failed");
						await saveObjectiveReceipt();
					} catch (error) {
						objectiveRecord.failures.push("Original objective assessment or model-proposed bounded dispatch failed");
						await ws.finishRun(objectiveRecord, "failed").catch(() => undefined);
						await saveObjectiveReceipt().catch(() => undefined);
						throw error;
					}
					objectiveAssessment = objectiveStep.assessment;
					latestAssessmentAdvanced = Boolean(objectiveStep.advanced);
					objectiveStopReason = objectiveStep.stopReason === "assessment-failed" && budget.snapshot().stopReason === "ceiling" ?
						"budget-boundary" : objectiveStep.stopReason === "assessment-failed" &&
						(abort.signal.aborted || Date.now() >= campaignStopAt) ? "time-boundary" : objectiveStep.stopReason;
					if (assessmentHistory.at(-1)?.iteration === iteration) {
						assessmentHistory[assessmentHistory.length - 1].stopReason = objectiveStopReason;
						assessmentHistory[assessmentHistory.length - 1].advanced = Boolean(objectiveStep.advanced);
					}
					if (objectiveStep.advanced) {
						statusPhase = "post-m04-followon";
						const { secondGoal, secondTask, proposedRefs, selection, pinnedRefs } = objectiveStep.advanced;
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
						if (!nextFrozenTask) fail("model-proposed M07 task identity unavailable for private archive");
						const nextArchiveDir = path.join(campaignRoot, `iteration-${iteration}-archive`);
						await archivePrivateM07Task({ goal: nextFrozenGoal, task: nextFrozenTask, destination: nextArchiveDir });
						let nextM04: typeof m04 = { status: "not_run" };
						if (secondReady && nextFrozenTask.review && !budget.snapshot().stopped && !abort.signal.aborted) {
							statusPhase = "model-proposed-m04-dispatch";
							const requiredPaths = selectedM07ReviewReadPaths(ws.runDir("M07", secondGoal.runId), nextFrozenTask);
							const m04Abort = new AbortController();
							const m04Timer = setTimeout(() => m04Abort.abort(), M04_PHASE_MS);
							try {
								const m04Runner = createPiSessionRunner({ modelRuntime: runtime,
									signal: AbortSignal.any([abort.signal, m04Abort.signal]), campaignBudget: budget });
								const processed = await runM04({ ws, store, runner: m04Runner, config: await ws.loadConfig() },
									{ feedback: { kind: "M07", runId: secondGoal.runId }, freshSession: true,
										requiredM07ReadPaths: requiredPaths,
										purpose: "Adjudicate the latest model-proposed bounded M07 result" });
								const coverage = await m04EvidenceReturned(processed.record, secondTask.taskId);
								const complete = processed.record.status === "completed" && processed.record.failures.length === 0 &&
									coverage.complete && requiredPaths.every(item => coverage.paths.includes(item));
								nextM04 = { status: complete ? "completed" : "failed", runId: processed.record.runId,
									proposalSubmitted: Boolean(processed.proposalId), snapshotCreated: Boolean(processed.snapshotId),
									evidenceReturned: complete,
									adoptedExperienceRefs: complete ? await adoptedExperienceRefs(store, processed.record.runId, true) : [] };
							} catch (error) { nextM04 = { status: "failed", adoptedExperienceRefs: [],
								failure: privateExceptionDiagnostic(error, runtimeKey) }; }
							finally { clearTimeout(m04Timer); }
						}
						const nextArchive = await recordPrivateM04Outcome(nextArchiveDir,
							{ state: nextM04.status === "not_run" ? "not-run" : nextM04.status,
								...(nextM04.runId ? { runId: nextM04.runId } : {}),
								proposalSubmitted: nextM04.proposalSubmitted ?? false,
								snapshotCreated: nextM04.snapshotCreated ?? false,
								adoptedExperienceRefs: nextM04.adoptedExperienceRefs ?? [] }, store);
						const iterationPrefix = `iteration-${iteration}`;
						await exportPrefixedArchive(nextArchiveDir, outputDir, iterationPrefix);
						latestAttemptEvidence = [{ name: "latest-attempt-archive.json",
							file: path.join(outputDir, `workflow-${iterationPrefix}-archive.json`) },
							...(existsSync(path.join(outputDir, `${iterationPrefix}-candidate.cpp`)) ?
								[{ name: "latest-attempt.cpp", file: path.join(outputDir, `${iterationPrefix}-candidate.cpp`) }] : []),
							...(existsSync(path.join(outputDir, `${iterationPrefix}-verification.json`)) ?
								[{ name: "latest-attempt-verification.json", file: path.join(outputDir, `${iterationPrefix}-verification.json`) }] : [])];
						const sourceChanged = !existsSync(candidate) || !existsSync(nextCandidate) ||
							!(await readFile(candidate)).equals(await readFile(nextCandidate));
						const chooseFollowOn = chooseFollowOnCandidate(selectedCandidateSource !== "none",
							secondFinished.outcome === "fulfilled" && secondReady && nextM04.status === "completed", sourceChanged,
							comparison as { state?: string; medianRatio?: number; minRatio?: number });
						let promoted = false;
						if (chooseFollowOn && nextArchive.files.some(item => item.name === "candidate.cpp" && item.status === "present") &&
							nextArchive.files.some(item => item.name === "verification.json" && item.status === "present")) {
							if (selectedCandidateSource !== "followon") await exportPrefixedArchive(outputDir, outputDir, "initial");
							for (const name of [...ARCHIVE_EVIDENCE_FILES, "workflow-archive.json", "m04-adopted-knowledge.json"]) {
								await rm(path.join(outputDir, name), { force: true });
								if (existsSync(path.join(nextArchiveDir, name))) await copyFile(path.join(nextArchiveDir, name), path.join(outputDir, name));
							}
							finalArchive = nextArchive;
							selectedCandidateSource = "followon";
							candidate = nextCandidate;
							verificationPath = nextVerification;
							currentSelectedGoalRunId = secondGoal.runId;
							currentSelectedTaskId = secondTask.taskId;
							promoted = true;
						}
						followOnSourceChanged = sourceChanged;
						if (secondReady) {
							currentM04Status = nextM04.status;
							currentM04Read = nextM04.evidenceReturned === true;
							currentKnowledgeExport = nextArchive.m04?.knowledgeExport ?? { state: "incomplete" };
							currentReusableRefs = nextM04.evidenceReturned && currentKnowledgeExport.state === "complete" ?
								(nextM04.adoptedExperienceRefs ?? []).filter(ref => (nextArchive.m04?.adoptedExperienceRefs ?? []).some(exported =>
									exported.storeId === ref.storeId && exported.recordId === ref.recordId && exported.version === ref.version)) : [];
							currentKnowledgeFile = existsSync(path.join(nextArchiveDir, "m04-adopted-knowledge.json")) ?
								path.join(nextArchiveDir, "m04-adopted-knowledge.json") : undefined;
						}
						followOn = { state: "completed", iteration, goalRunId: secondGoal.runId,
							taskId: secondTask.taskId, m07Outcome: secondFinished.outcome,
							priorCandidateProvided: true, priorEvidenceProvided: true, adoptedRefsEligible: proposedRefs.length,
							experienceSelectionStatus: selection.status, pinnedRefs, loadedExperience: Boolean(secondTask.experienceSelection?.loadedAt),
							faithfulUse: "unknown", causalBenefit: "unknown", measuredComparison: comparison,
							candidateSelected: promoted, selectedCandidateSource,
							sourceChanged: followOnSourceChanged,
							noChangeOutcome: followOnSourceChanged === false ? "identical-source-kept-previous" : null,
							m04: nextM04,
							knowledgeMode: pinnedRefs.length ? "m04-adopted-pinned" : "prior-artifact-only",
							archiveTransportLayout: "prefixed-flat-index" };
						followOnAttempts.push(followOn);
						advancedThisIteration = true;
						objectiveStopReason = "objective-reassessment-pending";
						if (assessmentHistory.at(-1)?.iteration === iteration)
							assessmentHistory[assessmentHistory.length - 1].stopReason = objectiveStopReason;
					}
				} catch (error) { objectiveStopReason = budget.snapshot().stopReason === "ceiling" ? "budget-boundary" :
					abort.signal.aborted || Date.now() >= campaignStopAt ? "time-boundary" :
					assessmentThisIteration ? "dispatch-failed" : "assessment-failed";
					if (assessmentHistory.at(-1)?.iteration === iteration)
						assessmentHistory[assessmentHistory.length - 1].stopReason = objectiveStopReason;
					let failedAttemptArchive = "unavailable";
					if (activeFollowOnGoalId) {
						try {
							const failedGoal = await controller.status(activeFollowOnGoalId);
							const failedTask = failedGoal.tasks.find(item => item.taskId === activeFollowOnTaskId) ??
								failedGoal.tasks.findLast(item => item.mode === "execute");
							if (failedTask) {
								activeFollowOnTaskId = failedTask.taskId;
								const failedDir = path.join(campaignRoot, `iteration-${iteration}-archive`);
								await archivePrivateM07Task({ goal: failedGoal, task: failedTask, destination: failedDir });
								await exportPrefixedArchive(failedDir, outputDir, `iteration-${iteration}`);
								failedAttemptArchive = `workflow-iteration-${iteration}-archive.json`;
							}
						} catch { statusArchiveFailure = "model-proposed-attempt-archive-failed"; }
					}
					followOn = { state: "failed", iteration, ...(activeFollowOnGoalId ? { goalRunId: activeFollowOnGoalId } : {}),
						...(activeFollowOnTaskId ? { taskId: activeFollowOnTaskId } : {}),
						archive: failedAttemptArchive, priorCandidateProvided: true,
						failure: privateExceptionDiagnostic(error, runtimeKey), faithfulUse: "unknown", causalBenefit: "unknown" };
					if (activeFollowOnGoalId) followOnAttempts.push(followOn);
				}
				return { advanced: advancedThisIteration, stopReason: objectiveStopReason,
					evidenceRefs: latestAttemptEvidence.map(item => item.name) };
				},
			});
			objectiveStopReason = loop.stopReason;
			statusPhase = "workflow-finished";
			const finalCandidateVerified = selectedCandidateSource !== "none" &&
				finalArchive.controllerEvidence.reviewStatus === "accepted" &&
				Boolean(finalArchive.controllerEvidence.reviewDecision?.file && existsSync(path.join(outputDir, "review-decision.json"))) &&
				["candidate.cpp", "verification.json"].every(name =>
					finalArchive.files.some(item => item.name === name && item.status === "present") &&
					existsSync(path.join(outputDir, name)));
			const durableKnowledge = knowledgeExport.state !== "incomplete" &&
				(!m04.adoptedExperienceRefs?.length || knowledgeExport.state === "complete");
			const followOnCompleted = followOn.state === "completed" && followOn.m07Outcome === "fulfilled";
			const boundedRunOutcome = firstGoalReady && finalCandidateVerified && m04.status === "completed" && durableKnowledge &&
				m04SelectedReadContractSatisfied && currentM04Status === "completed" && currentM04Read &&
				currentKnowledgeExport.state !== "incomplete" && branchExerciseComplete &&
				followOnCompleted ? "fulfilled" : "partial";
			if (boundedRunOutcome === "partial" && objectiveStopReason === "bounded-run-incomplete" &&
				budget.snapshot().stopReason === "ceiling")
				objectiveStopReason = "budget-boundary";
			const boundedRuns = [{ runId: runId!, outcome: finished.outcome ?? "unknown",
				...(firstGoalReady ? { selectedTaskId: selectedTask.taskId } : {}) },
				...followOnAttempts.filter(item => typeof item.goalRunId === "string").map(item => ({
					runId: String(item.goalRunId), outcome: String(item.m07Outcome ?? "unknown"),
					...(item.candidateSelected === true ? { selectedTaskId: String(item.taskId) } : {}) }))];
			const objectiveCheckpoint = objectiveProgress(originalObjective, { boundedRuns,
				selectedArtifacts: finalCandidateVerified ? ["candidate.cpp", "verification.json", "workflow-archive.json"] : [],
				...(objectiveAssessment ? { assessment: objectiveAssessment } : {}), assessmentHistory,
				nextTaskDispatched: latestAssessmentAdvanced, stopReason: objectiveStopReason });
			await writeObjectiveProgress(objectiveCheckpointFile, objectiveCheckpoint);
			const campaignOutcome = objectiveCheckpoint.objectiveOutcome;
			await saveStatus({ outcome: campaignOutcome, boundedRunOutcome,
				originalObjective: { id: originalObjective.id, outcome: objectiveCheckpoint.objectiveOutcome,
					stopReason: objectiveCheckpoint.stopReason, checkpointFile: "objective-checkpoint.json",
					goalSource: originalObjective.goalSource, continuation: objectiveCheckpoint.continuation.mode },
				m07Outcome: finished.outcome, taskStatus: task.status,
				loopStopReason: task.loopStopReason, taskTelemetry: statusTaskTelemetry,
				credentialProbe: statusCredentialProbe, sdkAuthSource: statusAuthSource,
				sdkAuthMatch: statusSdkAuthMatch,
				workflowArchive: { state: "saved", firstTaskId: task.taskId,
					selectedM07TaskId: firstGoalReady ? selectedTask.taskId : null,
					finalTaskId: finalArchive.taskId,
					lessonState: privateArchive.lesson.state, trustedAdoption: false, m04,
					knowledgeExport, m04EvidenceReturned: m04.evidenceReturned ?? false,
					m04AdoptedExperienceCount, m04AdoptionReadContractSatisfied,
					m04SelectedReadContractSatisfied },
				branch: branchState, branchExerciseComplete, firstGoalReady,
				followOn, followOnAttempts, objectiveLoop: loop, selectedCandidateSource, finalCandidateVerified,
				...(statusArchiveFailure ? { archiveFailure: statusArchiveFailure } : {}),
				independentValidation: finalCandidateVerified ? "bounded-workflow-checker-passed" : "not-complete",
				validationLimit: "Finite bounded cases are not exhaustive correctness or global-optimality proof" });
			console.log(JSON.stringify({ status: "private-campaign-bounded-run-ended", outcome: campaignOutcome,
				boundedRunOutcome, stopReason: objectiveCheckpoint.stopReason, budget: budget.snapshot() }));
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
		try { await preserveCandidate(new Workspace(path.join(campaignRoot, "workspace")), runId, outputDir); }
		catch {
			statusArchiveFailure = "bounded-fallback-archive-failed";
			await saveStatus({ outcome: "incomplete", archiveFailure: "bounded-fallback-archive-failed",
				independentValidation: "not-complete" }).catch(() => undefined);
			process.exitCode = 1;
		}
		await rm(campaignRoot, { recursive: true, force: true });
	}
}

export const offlineChecks = { sourceShape, deriveRuntimeCases, m04EvidenceReturned, inputs, stageProbe, verifierScratch,
	privateFailureMessage, privateExceptionDiagnostic, credentialProbe, parseCheckerOutput, compareCandidateTimings,
	chooseForkWinner, chooseFollowOnCandidate, firstM07Accepted,
	forkReceiptMatches, contextLineageSummary, selectedM07ReviewReadPaths, exportPrefixedArchive, preserveCandidate };

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main().catch(async error => {
		const preProvider = ["preflight", "isolated-preflight-passed", "workspace-init", "private-inputs-staged",
			"original-source-smoke", "source-and-isolation-preflight-passed"].includes(statusPhase);
		const diagnostic = privateExceptionDiagnostic(error, statusRuntimeKey);
		try { await saveStatus({ outcome: "incomplete", errorCategory: "campaign-exception",
			...(preProvider ? { privateDiagnostic: error instanceof SandboxPreflightError
				? error.privateDiagnostic : error instanceof Error ? error.message.slice(-2000) : "unknown pre-provider failure" } : {}),
			...(!preProvider ? { privateDiagnostic: diagnostic.message,
				exceptionCode: diagnostic.code, exceptionCategory: diagnostic.category } : {}),
			...(statusTaskTelemetry ? { taskTelemetry: statusTaskTelemetry } : {}),
			...(statusBranchTelemetry ? { branchTaskTelemetry: statusBranchTelemetry } : {}),
			...(statusArchiveFailure ? { archiveFailure: statusArchiveFailure } : {}),
			...(statusCredentialProbe ? { credentialProbe: statusCredentialProbe } : {}),
			...(statusAuthSource ? { sdkAuthSource: statusAuthSource } : {}),
			...(statusSdkAuthMatch !== undefined ? { sdkAuthMatch: statusSdkAuthMatch } : {}),
			independentValidation: "not-complete" }); } catch { /* transport synthesizes an incomplete status */ }
		// Never print the model response, source, input paths, credential, or raw provider errors.
		console.error(JSON.stringify({ status: "private-campaign-failed", category: "campaign-exception" }));
		process.exitCode = 1;
	});
}
