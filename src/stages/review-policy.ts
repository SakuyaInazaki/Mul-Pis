/**
 * The three semantic boundaries a declarative M08/M09 spec has to actually
 * execute: what constitutes rejection, who declares a verification tolerance,
 * and which material the reviewing sessions must not see.
 *
 * All three are host code. A review session can report what it read, and a
 * command can exit 0, but neither decides whether a submission is acceptable:
 * the basis is blunt about this — integrity gates rejected 12.5%–33.3% of the
 * submissions a workflow had already accepted itself, and the certification
 * material only works while the thing being certified has never seen it.
 *
 * Nothing here interprets content. Patterns are matched, numbers are compared,
 * files are either in the reviewed tree or in the hidden one.
 */
import { spawn } from "node:child_process";
import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { HarnessError } from "../types.ts";

/* ---------------------------------------------------------------- anti-cheat */

export interface AntiCheatPattern {
	id: string;
	/** Regular expression source, applied per line, case-insensitive. */
	pattern: string;
	/** Relative path selectors (`*` within a segment, `**` across segments). */
	appliesTo: string[];
	/** Why this is a rejection, in the caller's own words. */
	reason: string;
}

/** `blocked`: present anywhere it applies → reject. `required`: absent from a
 * file it applies to → reject. Both are declared by the caller; the stage never
 * invents one and never softens one. */
export interface AntiCheatPolicyV1 {
	blocked: AntiCheatPattern[];
	required: AntiCheatPattern[];
}

/** What a caller may write: either list alone is enough. The parser fills the
 * other one, so the scan never has to ask whether a list exists. */
export interface AntiCheatPolicyInput {
	blocked?: AntiCheatPattern[];
	required?: AntiCheatPattern[];
}

export interface AntiCheatFinding {
	patternId: string;
	kind: "blocked-match" | "required-missing";
	file: string;
	line?: number;
	/** Bounded excerpt of the matched line: the witness, not the whole file. */
	excerpt?: string;
	reason: string;
}

export interface AntiCheatReportV1 {
	version: 1;
	kind: "anti-cheat-scan";
	at: string;
	/** `not-declared` is distinct from `pass`: no policy means nothing was checked. */
	verdict: "pass" | "reject" | "not-declared";
	scope: string;
	scannedFiles: string[];
	/** Files the scan could not read as text. They are reported, never assumed clean. */
	unscannedFiles: Array<{ file: string; reason: string }>;
	findings: AntiCheatFinding[];
}

const MAX_SCAN_BYTES = 2 * 1024 * 1024;
const MAX_LINE = 4000;
const EXCERPT = 200;

const isObject = (value: unknown): value is Record<string, unknown> =>
	Boolean(value) && typeof value === "object" && !Array.isArray(value);

function patternList(value: unknown, label: string): AntiCheatPattern[] {
	if (value === undefined) return [];
	if (!Array.isArray(value)) throw new HarnessError("stage.anti-cheat", `${label} 必须是数组`);
	const seen = new Set<string>();
	return value.map((item, index) => {
		const at = `${label}[${index}]`;
		if (!isObject(item)) throw new HarnessError("stage.anti-cheat", `${at} 必须是对象`);
		for (const key of Object.keys(item))
			if (!["id", "pattern", "appliesTo", "reason"].includes(key)) throw new HarnessError("stage.anti-cheat", `${at} 含未知字段`);
		const id = item.id, pattern = item.pattern, reason = item.reason;
		if (typeof id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(id)) throw new HarnessError("stage.anti-cheat", `${at}.id 必须是简单标识符`);
		if (seen.has(id)) throw new HarnessError("stage.anti-cheat", `${at}.id 重复：${id}`);
		seen.add(id);
		if (typeof pattern !== "string" || !pattern.trim() || pattern.length > 400) throw new HarnessError("stage.anti-cheat", `${at}.pattern 必须是不超过 400 字符的非空正则`);
		try { new RegExp(pattern, "iu"); } catch { throw new HarnessError("stage.anti-cheat", `${at}.pattern 不是合法正则`); }
		if (typeof reason !== "string" || !reason.trim() || reason.length > 400) throw new HarnessError("stage.anti-cheat", `${at}.reason 必须写明为什么构成拒绝`);
		if (!Array.isArray(item.appliesTo) || !item.appliesTo.length ||
			item.appliesTo.some(entry => typeof entry !== "string" || !entry.trim() || entry.length > 200 ||
				path.isAbsolute(entry) || entry.split(/[\\/]/u).includes("..")))
			throw new HarnessError("stage.anti-cheat", `${at}.appliesTo 必须是非空的相对路径选择器数组`);
		return { id, pattern, reason: reason.trim(), appliesTo: (item.appliesTo as string[]).map(entry => entry.trim()) };
	});
}

export function parseAntiCheatPolicy(value: unknown): AntiCheatPolicyV1 | undefined {
	if (value === undefined) return undefined;
	if (!isObject(value)) throw new HarnessError("stage.anti-cheat", "antiCheat 必须是含 blocked / required 的对象");
	for (const key of Object.keys(value)) if (!["blocked", "required"].includes(key)) throw new HarnessError("stage.anti-cheat", "antiCheat 含未知字段");
	const policy = { blocked: patternList(value.blocked, "antiCheat.blocked"), required: patternList(value.required, "antiCheat.required") };
	if (!policy.blocked.length && !policy.required.length)
		throw new HarnessError("stage.anti-cheat", "antiCheat 至少要声明一条 blocked 或 required 模式；空策略请整体省略");
	return policy;
}

/** Glob semantics: a double star followed by a separator matches zero or more
 * leading segments, a bare double star crosses separators, a single star stays
 * inside one segment, `?` is one character, everything else is literal. The
 * zero-segment case matters: a policy that selects every Python file must not
 * silently skip the ones at the root of the reviewed tree. */
export function matchesSelector(relativePath: string, selector: string): boolean {
	const normalized = relativePath.split(path.sep).join("/");
	const pattern = selector.split(path.sep).join("/");
	let source = "";
	for (let index = 0; index < pattern.length; index++) {
		if (pattern.startsWith("**/", index)) { source += "(?:.*/)?"; index += 2; continue; }
		if (pattern.startsWith("**", index)) { source += ".*"; index += 1; continue; }
		const character = pattern[index];
		if (character === "*") { source += "[^/]*"; continue; }
		if (character === "?") { source += "[^/]"; continue; }
		source += character.replace(/[.+^${}()|[\]\\]/u, "\\$&");
	}
	return new RegExp(`^${source}$`, "u").test(normalized);
}

async function textFiles(root: string): Promise<{ files: string[]; unscanned: Array<{ file: string; reason: string }> }> {
	const files: string[] = [];
	const unscanned: Array<{ file: string; reason: string }> = [];
	const walk = async (dir: string): Promise<void> => {
		for (const name of (await readdir(dir)).sort()) {
			const absolute = path.join(dir, name);
			const relative = path.relative(root, absolute);
			const info = await lstat(absolute);
			if (info.isSymbolicLink()) throw new HarnessError("stage.anti-cheat", `被扫描目录出现符号链接：${relative}`);
			if (info.isDirectory()) { await walk(absolute); continue; }
			if (!info.isFile()) continue;
			if (info.size > MAX_SCAN_BYTES) { unscanned.push({ file: relative, reason: `超过 ${MAX_SCAN_BYTES} 字节的扫描上限` }); continue; }
			files.push(relative);
		}
	};
	await walk(root);
	return { files, unscanned };
}

/** Deterministic scan with a witness per finding. An undeclared policy returns
 * `not-declared`, which is a result and not a pass. */
export async function scanAntiCheat(root: string, scope: string, policy?: AntiCheatPolicyV1): Promise<AntiCheatReportV1> {
	const at = new Date().toISOString();
	if (!policy) return { version: 1, kind: "anti-cheat-scan", at, verdict: "not-declared", scope, scannedFiles: [], unscannedFiles: [], findings: [] };
	const { files, unscanned } = await textFiles(root);
	const scanned: string[] = [];
	const findings: AntiCheatFinding[] = [];
	const satisfiedRequired = new Map<string, Set<string>>();
	for (const file of files) {
		const applicable = [...policy.blocked, ...policy.required].filter(pattern =>
			pattern.appliesTo.some(selector => matchesSelector(file, selector)));
		if (!applicable.length) continue;
		let content: string;
		try { content = new TextDecoder("utf-8", { fatal: true }).decode(await readFile(path.join(root, file))); }
		catch { unscanned.push({ file, reason: "不是 UTF-8 文本，模式检查未覆盖" }); continue; }
		scanned.push(file);
		const lines = content.split(/\r?\n/u);
		for (const pattern of applicable) {
			const expression = new RegExp(pattern.pattern, "iu");
			const blocked = policy.blocked.includes(pattern);
			let hit: { line: number; excerpt: string } | undefined;
			for (const [index, line] of lines.entries()) {
				if (line.length > MAX_LINE) { unscanned.push({ file: `${file}#L${index + 1}`, reason: `单行超过 ${MAX_LINE} 字符，未做模式匹配` }); continue; }
				if (!expression.test(line)) continue;
				hit = { line: index + 1, excerpt: line.trim().slice(0, EXCERPT) };
				break;
			}
			if (blocked && hit)
				findings.push({ patternId: pattern.id, kind: "blocked-match", file, line: hit.line, excerpt: hit.excerpt, reason: pattern.reason });
			if (!blocked) {
				const satisfied = satisfiedRequired.get(pattern.id) ?? new Set<string>();
				if (hit) satisfied.add(file);
				satisfiedRequired.set(pattern.id, satisfied);
				if (!hit) findings.push({ patternId: pattern.id, kind: "required-missing", file, reason: pattern.reason });
			}
		}
	}
	for (const pattern of policy.required) {
		if (satisfiedRequired.has(pattern.id)) continue;
		findings.push({ patternId: pattern.id, kind: "required-missing", file: pattern.appliesTo.join("、"),
			reason: `${pattern.reason}（没有任何被扫描文件落在该选择器内）` });
	}
	return { version: 1, kind: "anti-cheat-scan", at, verdict: findings.length ? "reject" : "pass",
		scope, scannedFiles: scanned, unscannedFiles: unscanned, findings };
}

export function renderAntiCheatFindings(report: AntiCheatReportV1): string {
	return report.findings.map(item => `${item.kind === "blocked-match" ? "命中禁止模式" : "缺少必需模式"} ${item.patternId}：${item.file}${item.line ? `:${item.line}` : ""}${item.excerpt ? `（${item.excerpt}）` : ""}；${item.reason}`).join("；");
}

/* ---------------------------------------------------------------- tolerance */

/** A tolerance is declared by the caller in the stage spec and nowhere else.
 * The reviewed material cannot propose the threshold it will be judged by, and
 * the reviewing session cannot relax one: both are exactly how an unexplained
 * 1e-2 becomes a place to hide. */
export interface ToleranceDeclarationV1 {
	id: string;
	/** The observation key this threshold judges. */
	metric: string;
	comparison: "at_most" | "at_least";
	value: number;
	/** How the number was obtained. Mandatory: a threshold with no stated basis
	 * is the failure mode the basis warns about, not a convention. */
	basis: string;
	/** Caller identity recorded with the verdict. */
	declaredBy: string;
	/** Per-case relaxations, each capped relative to the base value. */
	relaxations?: Array<{ case: string; value: number; reason: string }>;
}

/** A per-case relaxation beyond this factor is not a tolerance any more. */
export const MAX_RELAXATION_FACTOR = 10;

export function parseToleranceDeclarations(value: unknown, label = "tolerances"): ToleranceDeclarationV1[] {
	if (value === undefined) return [];
	if (!Array.isArray(value) || !value.length) throw new HarnessError("stage.tolerance", `${label} 必须是非空数组；没有容差请整体省略`);
	const seen = new Set<string>();
	return value.map((item, index) => {
		const at = `${label}[${index}]`;
		if (!isObject(item)) throw new HarnessError("stage.tolerance", `${at} 必须是对象`);
		for (const key of Object.keys(item))
			if (!["id", "metric", "comparison", "value", "basis", "declaredBy", "relaxations"].includes(key))
				throw new HarnessError("stage.tolerance", `${at} 含未知字段`);
		const { id, metric, comparison, value: threshold, basis, declaredBy } = item as Record<string, unknown>;
		if (typeof id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(id)) throw new HarnessError("stage.tolerance", `${at}.id 必须是简单标识符`);
		if (seen.has(id)) throw new HarnessError("stage.tolerance", `${at}.id 重复：${id}`);
		seen.add(id);
		if (typeof metric !== "string" || !metric.trim() || metric.length > 120) throw new HarnessError("stage.tolerance", `${at}.metric 必须是观测键名`);
		if (comparison !== "at_most" && comparison !== "at_least") throw new HarnessError("stage.tolerance", `${at}.comparison 必须是 at_most 或 at_least`);
		if (typeof threshold !== "number" || !Number.isFinite(threshold)) throw new HarnessError("stage.tolerance", `${at}.value 必须是有限数值`);
		if (typeof basis !== "string" || !basis.trim() || basis.length > 400) throw new HarnessError("stage.tolerance", `${at}.basis 必须写明这个阈值是怎么来的`);
		if (typeof declaredBy !== "string" || !declaredBy.trim() || declaredBy.length > 120) throw new HarnessError("stage.tolerance", `${at}.declaredBy 必须写明由谁声明`);
		const relaxations = (item as Record<string, unknown>).relaxations;
		if (relaxations !== undefined) {
			if (!Array.isArray(relaxations)) throw new HarnessError("stage.tolerance", `${at}.relaxations 必须是数组`);
			for (const [relaxIndex, relax] of relaxations.entries()) {
				const where = `${at}.relaxations[${relaxIndex}]`;
				if (!isObject(relax)) throw new HarnessError("stage.tolerance", `${where} 必须是对象`);
				for (const key of Object.keys(relax)) if (!["case", "value", "reason"].includes(key)) throw new HarnessError("stage.tolerance", `${where} 含未知字段`);
				if (typeof relax.case !== "string" || !relax.case.trim()) throw new HarnessError("stage.tolerance", `${where}.case 必须是非空字符串`);
				if (typeof relax.value !== "number" || !Number.isFinite(relax.value)) throw new HarnessError("stage.tolerance", `${where}.value 必须是有限数值`);
				if (typeof relax.reason !== "string" || !relax.reason.trim()) throw new HarnessError("stage.tolerance", `${where}.reason 必须写明放宽理由`);
				const limit = comparison === "at_most" ? threshold * MAX_RELAXATION_FACTOR : threshold / MAX_RELAXATION_FACTOR;
				const beyond = comparison === "at_most" ? relax.value > limit : relax.value < limit;
				if (beyond) throw new HarnessError("stage.tolerance", `${where}.value 超出基准值的 ${MAX_RELAXATION_FACTOR} 倍封顶`);
			}
		}
		return { id, metric: metric.trim(), comparison, value: threshold, basis: basis.trim(), declaredBy: declaredBy.trim(),
			...(relaxations ? { relaxations: relaxations as ToleranceDeclarationV1["relaxations"] } : {}) };
	});
}

export interface ToleranceObservation { metric: string; value: number; case?: string }

export interface ToleranceResult {
	id: string;
	metric: string;
	case?: string;
	observed?: number;
	threshold: number;
	comparison: ToleranceDeclarationV1["comparison"];
	status: "pass" | "fail" | "missing";
	declaredBy: string;
	basis: string;
}

export interface ToleranceReportV1 {
	version: 1;
	kind: "tolerance-evaluation";
	at: string;
	/** Disjunctive: any failing declaration fails the whole evaluation, and a
	 * missing observation is inconclusive rather than quietly passing. */
	verdict: "pass" | "fail" | "inconclusive" | "not-declared";
	observationsFile?: string;
	results: ToleranceResult[];
}

/** Observations come from a machine-readable file the authorized commands
 * produced, never from a session's prose. Both shapes are accepted: a flat
 * `{metric: value}` map, or a list of `{metric, value, case}` rows. */
export function parseObservations(value: unknown, file: string): ToleranceObservation[] {
	const rows: ToleranceObservation[] = [];
	if (Array.isArray(value)) {
		for (const [index, item] of value.entries()) {
			if (!isObject(item) || typeof item.metric !== "string" || !item.metric.trim() ||
				typeof item.value !== "number" || !Number.isFinite(item.value) ||
				(item.case !== undefined && (typeof item.case !== "string" || !item.case.trim())))
				throw new HarnessError("stage.tolerance", `${file} 第 ${index} 项不是 {metric, value, case?} 观测`);
			rows.push({ metric: item.metric.trim(), value: item.value, ...(item.case ? { case: String(item.case).trim() } : {}) });
		}
		return rows;
	}
	if (!isObject(value)) throw new HarnessError("stage.tolerance", `${file} 必须是观测数组或 {metric: value} 对象`);
	for (const [metric, observed] of Object.entries(value)) {
		if (typeof observed !== "number" || !Number.isFinite(observed))
			throw new HarnessError("stage.tolerance", `${file} 的 ${metric} 不是有限数值`);
		rows.push({ metric, value: observed });
	}
	return rows;
}

export function evaluateTolerances(observations: readonly ToleranceObservation[],
	declarations: readonly ToleranceDeclarationV1[], observationsFile?: string): ToleranceReportV1 {
	const at = new Date().toISOString();
	if (!declarations.length) return { version: 1, kind: "tolerance-evaluation", at, verdict: "not-declared", results: [],
		...(observationsFile ? { observationsFile } : {}) };
	const results: ToleranceResult[] = [];
	for (const declaration of declarations) {
		const matching = observations.filter(item => item.metric === declaration.metric);
		if (!matching.length) {
			results.push({ id: declaration.id, metric: declaration.metric, threshold: declaration.value,
				comparison: declaration.comparison, status: "missing", declaredBy: declaration.declaredBy, basis: declaration.basis });
			continue;
		}
		for (const observation of matching) {
			const relaxation = observation.case
				? declaration.relaxations?.find(item => item.case === observation.case) : undefined;
			const threshold = relaxation?.value ?? declaration.value;
			const ok = declaration.comparison === "at_most" ? observation.value <= threshold : observation.value >= threshold;
			results.push({ id: declaration.id, metric: declaration.metric, ...(observation.case ? { case: observation.case } : {}),
				observed: observation.value, threshold, comparison: declaration.comparison,
				status: ok ? "pass" : "fail", declaredBy: declaration.declaredBy, basis: declaration.basis });
		}
	}
	const verdict = results.some(item => item.status === "fail") ? "fail"
		: results.some(item => item.status === "missing") ? "inconclusive" : "pass";
	return { version: 1, kind: "tolerance-evaluation", at, verdict, results, ...(observationsFile ? { observationsFile } : {}) };
}

export function renderToleranceFailures(report: ToleranceReportV1): string {
	return report.results.filter(item => item.status !== "pass")
		.map(item => `${item.id}（${item.metric}${item.case ? `/${item.case}` : ""}）：${item.status === "missing" ? "没有对应观测值" : `实测 ${item.observed} 不满足 ${item.comparison} ${item.threshold}`}；阈值由 ${item.declaredBy} 声明，依据 ${item.basis}`).join("；");
}

/* -------------------------------------------- certification (hidden material) */

/** Certification material is frozen by M08 outside every session's tool root
 * and used once, by the host, before delivery. Its whole value is that the work
 * being certified was produced without seeing it. */
export interface CertificationSpecV1 {
	/** Caller-authorized commands. The host runs them itself, after the review
	 * and delivery sessions have ended and been judged. */
	commands: string[];
	/** Machine-readable observations the commands must leave behind, relative to
	 * the certification run root. */
	observationsFile: string;
	tolerances: ToleranceDeclarationV1[];
}

export interface HostCommandRecord {
	index: number;
	command: string;
	cwd: string;
	startedAt: string;
	finishedAt: string;
	exitCode: number | null;
	stdout: string;
	stderr: string;
}

export interface CertificationReportV1 {
	version: 1;
	kind: "certification-run";
	at: string;
	verdict: "pass" | "fail" | "inconclusive" | "not-declared";
	/** How many hidden files took part, without naming them in a session-visible place. */
	hiddenMaterialFiles: number;
	commands: HostCommandRecord[];
	tolerance: ToleranceReportV1;
	/** The counter the basis asks for by name: the engine refusing what the
	 * sessions had already accepted. */
	engineRejectedSessionAcceptance: boolean;
	notes: string[];
}

const MAX_CAPTURED_OUTPUT = 20_000;

function clipOutput(value: string): string {
	return value.length <= MAX_CAPTURED_OUTPUT ? value : `${value.slice(0, MAX_CAPTURED_OUTPUT)}\n…（输出已截断，共 ${value.length} 字符）`;
}

export function parseCertificationSpec(value: unknown): CertificationSpecV1 | undefined {
	if (value === undefined) return undefined;
	if (!isObject(value)) throw new HarnessError("stage.certification", "certification 必须是对象");
	for (const key of Object.keys(value))
		if (!["commands", "observationsFile", "tolerances"].includes(key)) throw new HarnessError("stage.certification", "certification 含未知字段");
	if (!Array.isArray(value.commands) || !value.commands.length ||
		value.commands.some(item => typeof item !== "string" || !item.trim() || item.length > 4000))
		throw new HarnessError("stage.certification", "certification.commands 必须是非空的授权命令数组");
	const observationsFile = value.observationsFile;
	if (typeof observationsFile !== "string" || !observationsFile.trim() || path.isAbsolute(observationsFile) ||
		observationsFile.split(/[\\/]/u).includes(".."))
		throw new HarnessError("stage.certification", "certification.observationsFile 必须是认证运行根下的相对路径");
	const tolerances = parseToleranceDeclarations(value.tolerances, "certification.tolerances");
	if (!tolerances.length) throw new HarnessError("stage.certification", "certification 必须声明至少一条容差；没有判据的重跑不构成认证");
	return { commands: (value.commands as string[]).map(item => item.trim()), observationsFile: observationsFile.trim(), tolerances };
}

/** Run the authorized commands in order and stop at the first failure. No
 * session is attached: this is the engine's own rerun. */
export async function runHostCommands(commands: readonly string[], cwd: string, signal?: AbortSignal): Promise<HostCommandRecord[]> {
	const records: HostCommandRecord[] = [];
	for (const [index, command] of commands.entries()) {
		if (signal?.aborted) throw new HarnessError("stage.certification", `认证命令 ${index} 启动前已取消`);
		const startedAt = new Date().toISOString();
		const result = await new Promise<{ exitCode: number | null; stdout: string; stderr: string }>((resolve) => {
			const grouped = process.platform !== "win32";
			const child = spawn(command, { cwd, shell: true, detached: grouped, stdio: ["ignore", "pipe", "pipe"] });
			let stdout = "", stderr = "", settled = false, aborted = false;
			const finish = (value: { exitCode: number | null; stdout: string; stderr: string }): void => {
				if (settled) return;
				settled = true;
				signal?.removeEventListener("abort", abort);
				resolve(value);
			};
			const abort = (): void => {
				aborted = true;
				try { if (grouped && child.pid) process.kill(-child.pid, "SIGTERM"); else child.kill("SIGTERM"); }
				catch { child.kill("SIGTERM"); }
			};
			signal?.addEventListener("abort", abort, { once: true });
			if (signal?.aborted) abort();
			child.stdout.on("data", chunk => { stdout += String(chunk); });
			child.stderr.on("data", chunk => { stderr += String(chunk); });
			child.on("error", error => finish({ exitCode: null, stdout, stderr: `${stderr}${stderr ? "\n" : ""}${error.message}` }));
			child.on("close", exitCode => finish({ exitCode: aborted ? null : exitCode, stdout, stderr }));
		});
		records.push({ index, command, cwd, startedAt, finishedAt: new Date().toISOString(),
			exitCode: result.exitCode, stdout: clipOutput(result.stdout), stderr: clipOutput(result.stderr) });
		if (result.exitCode !== 0) break;
	}
	return records;
}

/** Read the observations the commands produced and judge them against the
 * declared tolerances. A missing file is inconclusive, never a pass. */
export async function certifyRun(root: string, spec: CertificationSpecV1, commands: HostCommandRecord[],
	hiddenMaterialFiles: number, sessionsAccepted: boolean): Promise<CertificationReportV1> {
	const at = new Date().toISOString();
	const notes: string[] = [];
	let tolerance: ToleranceReportV1;
	const failedCommand = commands.find(item => item.exitCode !== 0);
	if (failedCommand) {
		notes.push(`认证命令 ${failedCommand.index} 以 exitCode=${failedCommand.exitCode} 结束，后续命令未执行`);
		tolerance = evaluateTolerances([], spec.tolerances, spec.observationsFile);
	} else {
		const file = path.join(root, spec.observationsFile);
		let observations: ToleranceObservation[] | undefined;
		try { observations = parseObservations(JSON.parse(await readFile(file, "utf8")), spec.observationsFile); }
		catch (error) { notes.push(`无法读取认证观测文件 ${spec.observationsFile}：${(error as Error).message}`); }
		tolerance = evaluateTolerances(observations ?? [], spec.tolerances, spec.observationsFile);
	}
	const verdict: CertificationReportV1["verdict"] = failedCommand ? "fail" : tolerance.verdict === "not-declared" ? "inconclusive" : tolerance.verdict;
	if (verdict !== "pass") notes.push("认证用材料只参与这一次宿主重跑；评审与整理会话从未读取它们。");
	return { version: 1, kind: "certification-run", at, verdict, hiddenMaterialFiles, commands, tolerance,
		engineRejectedSessionAcceptance: verdict !== "pass" && sessionsAccepted, notes };
}
