/** Read-only profiler import. Parsing a file does not bind it to candidate source
 * bytes: a trusted host must freeze the export and establish that relationship
 * before attaching the returned evidence to an observation. */
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, lstat, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { CandidatePerformanceEvidenceV1, MeasuredPerformanceQuantityV1 } from "./candidate-diagnostics.ts";

export interface ProfilerProbeV1 {
	tool: "ncu" | "msprof";
	status: "available" | "unavailable" | "unknown";
	toolObserved: boolean;
	deviceObserved: boolean;
	reason: string;
}

export interface ParsedProfilerEvidenceV1 {
	status: "parsed" | "unavailable" | "ambiguous";
	source: "ncu-csv" | "ncu-report" | "msprof-kernel" | "msprof-step";
	/** Remains unbound until the host verifies the frozen export and candidate. */
	binding: "unverified";
	reason: string;
	evidence?: CandidatePerformanceEvidenceV1;
	selected?: string;
}

interface CsvRow { cells: string[]; row: number }
function csvRows(text: string): CsvRow[] {
	const rows: CsvRow[] = [];
	let cells: string[] = [], cell = "", quoted = false, start = 1, line = 1;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (quoted) {
			if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
			else if (ch === '"') quoted = false;
			else { cell += ch; if (ch === "\n") line++; }
		} else if (ch === '"') quoted = true;
		else if (ch === ",") { cells.push(cell); cell = ""; }
		else if (ch === "\n") { cells.push(cell.replace(/\r$/u, "")); rows.push({ cells, row: start }); cells = []; cell = ""; line++; start = line; }
		else cell += ch;
	}
	if (quoted) throw new Error("unterminated CSV quoted field");
	if (cell || cells.length) { cells.push(cell.replace(/\r$/u, "")); rows.push({ cells, row: start }); }
	return rows;
}

function table(text: string, required: readonly string[]): { header: string[]; rows: CsvRow[] } | null {
	let rows: CsvRow[];
	try { rows = csvRows(text); }
	catch { return null; }
	const index = rows.findIndex(row => required.every(column => row.cells.map(cell => cell.trim().replace(/^\uFEFF/u, "")).includes(column)));
	if (index < 0) return null;
	const header = rows[index].cells.map(cell => cell.trim().replace(/^\uFEFF/u, ""));
	return { header, rows: rows.slice(index + 1).filter(row => row.cells.length === header.length &&
		!required.every(column => row.cells.includes(column))) };
}

function number(value: string): number | null {
	const trimmed = value.trim().replace(/,/gu, "");
	if (!trimmed || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/iu.test(trimmed)) return null;
	const parsed = Number(trimmed);
	return Number.isFinite(parsed) ? parsed : null;
}

function seconds(value: number, unit: string): number | null {
	const factor = ({ ns: 1e-9, nsecond: 1e-9, nanosecond: 1e-9,
		us: 1e-6, "µs": 1e-6, "μs": 1e-6, microsecond: 1e-6,
		ms: 1e-3, millisecond: 1e-3, s: 1, second: 1 } as Record<string, number>)[unit.trim().toLowerCase()];
	const result = factor === undefined ? null : value * factor;
	return result !== null && Number.isFinite(result) && result > 0 ? result : null;
}

function entry(row: CsvRow, header: string[], column: string): string {
	return row.cells[header.indexOf(column)] ?? "";
}
function quantity(value: number, receiptIndex: number, row: CsvRow, column: string): MeasuredPerformanceQuantityV1 {
	return { value, receiptIndex, fieldPath: `csv.row:${row.row}.${column}` };
}
function context(basisId: string, receiptIndex: number): boolean {
	return !!basisId.trim() && basisId.length <= 256 && Number.isSafeInteger(receiptIndex) && receiptIndex >= 0;
}
const ncuCounters = new Set([
	"sm__throughput.avg.pct_of_peak_sustained_elapsed",
	"dram__throughput.avg.pct_of_peak_sustained_elapsed",
	"gpu__compute_memory_throughput.avg.pct_of_peak_sustained_elapsed",
	"lts__t_sector_hit_rate.pct",
	"smsp__issue_active.avg.pct_of_peak_sustained_active",
	"smsp__warps_eligible.avg.per_cycle_active",
]);

/** Accept the raw CLI CSV shape (`ncu --page raw --csv --print-units base
 * --print-metric-name name`) and exactly one profiled launch. */
export function parseNcuRawCsv(text: string, input: { basisId: string; receiptIndex: number; launchId?: string }): ParsedProfilerEvidenceV1 {
	const fail = (status: "unavailable" | "ambiguous", reason: string): ParsedProfilerEvidenceV1 =>
		({ status, source: "ncu-csv", binding: "unverified", reason });
	if (!context(input.basisId, input.receiptIndex)) return fail("unavailable", "basisId and frozen receipt index are required");
	const data = table(text, ["ID", "Kernel Name", "Metric Name", "Metric Unit", "Metric Value"]);
	if (!data) return fail("unavailable", "ncu raw metric columns are absent");
	const launches = new Map<string, CsvRow[]>();
	for (const row of data.rows) {
		const id = entry(row, data.header, "ID").trim(), kernel = entry(row, data.header, "Kernel Name").trim();
		if (!id || !kernel) continue;
		const key = JSON.stringify([id, kernel]);
		launches.set(key, [...(launches.get(key) ?? []), row]);
	}
	const matching = [...launches.entries()].filter(([key]) => input.launchId === undefined || JSON.parse(key)[0] === input.launchId);
	if (!matching.length) return fail("unavailable", "no matching profiled launch");
	if (matching.length !== 1) return fail("ambiguous", "multiple profiled launches; specify the exact launch ID");
	const [key, rows] = matching[0];
	const evidence: CandidatePerformanceEvidenceV1 = { basisId: input.basisId };
	const counters: NonNullable<CandidatePerformanceEvidenceV1["counters"]> = [];
	const seen = new Set<string>();
	for (const row of rows) {
		const name = entry(row, data.header, "Metric Name").trim();
		if (name !== "gpu__time_duration.sum" && !ncuCounters.has(name)) continue;
		if (seen.has(name)) return fail("ambiguous", `selected launch repeats ${name}; no metric value was chosen`);
		seen.add(name);
		const unit = entry(row, data.header, "Metric Unit").trim();
		const value = number(entry(row, data.header, "Metric Value"));
		if (value === null) continue;
		if (name === "gpu__time_duration.sum") {
			const elapsed = seconds(value, unit);
			if (elapsed !== null) evidence.elapsedSeconds = quantity(elapsed, input.receiptIndex, row, "Metric Value");
		} else if (ncuCounters.has(name) && unit)
			counters.push({ ...quantity(value, input.receiptIndex, row, "Metric Value"), name, unit });
	}
	if (counters.length) evidence.counters = counters;
	if (!evidence.elapsedSeconds && !counters.length) return fail("unavailable", "selected launch has no recognized numeric duration or diagnostic counters");
	return { status: "parsed", source: "ncu-csv", binding: "unverified", selected: key,
		reason: "Raw ncu values were normalized; profiler export and candidate source are not bound by this parser.", evidence };
}

const msprofCounters = ["aic_mac_ratio", "aic_mte2_ratio", "aiv_vec_ratio", "aiv_mte2_ratio",
	"aiv_scalar_ratio", "aiv_mte3_ratio", "cube_utilization(%)"] as const;
function durationColumn(header: string[]): string | undefined {
	return header.find(column => /^Duration\((?:u|µ|μ)s\)$/iu.test(column));
}

/** kernel_details.csv is per operator; never silently sum unrelated kernels. */
export function parseMsprofKernelCsv(text: string, input: { basisId: string; receiptIndex: number;
	kernelName?: string; taskId?: string; stepId?: string }): ParsedProfilerEvidenceV1 {
	const fail = (status: "unavailable" | "ambiguous", reason: string): ParsedProfilerEvidenceV1 =>
		({ status, source: "msprof-kernel", binding: "unverified", reason });
	if (!context(input.basisId, input.receiptIndex)) return fail("unavailable", "basisId and frozen receipt index are required");
	const data = table(text, ["Name", "Task ID"]);
	const duration = data && durationColumn(data.header);
	if (!data || !duration) return fail("unavailable", "msprof kernel name, task ID, or duration column is absent");
	const matches = data.rows.filter(row =>
		(input.kernelName === undefined || entry(row, data.header, "Name") === input.kernelName) &&
		(input.taskId === undefined || entry(row, data.header, "Task ID") === input.taskId) &&
		(input.stepId === undefined || entry(row, data.header, "Step Id") === input.stepId));
	if (!matches.length) return fail("unavailable", "no matching msprof kernel row");
	if (matches.length !== 1) return fail("ambiguous", "multiple msprof kernel rows; specify kernel, task and step identity");
	const row = matches[0], microseconds = number(entry(row, data.header, duration));
	if (microseconds === null || microseconds <= 0) return fail("unavailable", "selected kernel has no positive duration");
	const evidence: CandidatePerformanceEvidenceV1 = { basisId: input.basisId,
		elapsedSeconds: quantity(microseconds / 1e6, input.receiptIndex, row, duration) };
	const counters: NonNullable<CandidatePerformanceEvidenceV1["counters"]> = [];
	for (const name of msprofCounters) {
		const column = data.header.find(header => header.toLowerCase() === name.toLowerCase());
		if (!column) continue;
		const value = number(entry(row, data.header, column));
		if (value === null) continue;
		counters.push({ ...quantity(value, input.receiptIndex, row, column), name: column,
			unit: name.endsWith("(%)") ? "%" : "reported-ratio" });
	}
	if (counters.length) evidence.counters = counters;
	return { status: "parsed", source: "msprof-kernel", binding: "unverified",
		selected: JSON.stringify({ name: entry(row, data.header, "Name"), taskId: entry(row, data.header, "Task ID"),
			stepId: entry(row, data.header, "Step Id") }),
		reason: "Selected NPU kernel duration and reported counters were normalized; source binding is still required.", evidence };
}

/** step_trace_time.csv Computing is a whole-step timing basis, not kernel time.
 * Huawei documents plain "Computing" as µs for current exports, but a plain
 * header does not carry that unit: the importing host must state its source unit. */
export function parseMsprofStepCsv(text: string, input: { basisId: string; receiptIndex: number;
	stepId?: string; deviceId?: string; unit?: "ns" | "us" | "ms" | "s" }): ParsedProfilerEvidenceV1 {
	const fail = (status: "unavailable" | "ambiguous", reason: string): ParsedProfilerEvidenceV1 =>
		({ status, source: "msprof-step", binding: "unverified", reason });
	if (!context(input.basisId, input.receiptIndex)) return fail("unavailable", "basisId and frozen receipt index are required");
	const computingColumns = ["Computing", "Computing(ns)", "Computing(us)", "Computing(µs)", "Computing(μs)", "Computing(ms)", "Computing(s)"];
	const found = computingColumns.map(column => ({ column, data: table(text, [column]) })).find(item => item.data);
	if (!found?.data) return fail("unavailable", "msprof step Computing column is absent");
	const { data, column } = found;
	const unit = column === "Computing" ? input.unit : column.slice("Computing(".length, -1);
	if (!unit) return fail("unavailable", "Computing has no unit in its header; supply the documented export unit explicitly");
	const stepColumn = ["Step", "Step Id", "Step ID"].find(candidate => data.header.includes(candidate));
	if (input.stepId !== undefined && !stepColumn)
		return fail("unavailable", "step selector was supplied but this CSV has no step ID column");
	if (input.deviceId !== undefined && !data.header.includes("Device_id"))
		return fail("unavailable", "device selector was supplied but this CSV has no Device_id column");
	const rows = data.rows.filter(row =>
		(input.stepId === undefined || entry(row, data.header, stepColumn!) === input.stepId) &&
		(input.deviceId === undefined || entry(row, data.header, "Device_id") === input.deviceId));
	if (!rows.length) return fail("unavailable", "no matching msprof step rows");
	if (data.header.includes("Device_id") && new Set(rows.map(row => entry(row, data.header, "Device_id"))).size > 1)
		return fail("ambiguous", "multiple devices share this export; select one Device_id");
	const values = rows.map(row => {
		const value = number(entry(row, data.header, column));
		return value === null ? null : seconds(value, unit);
	});
	if (values.some(value => value === null))
		return fail("unavailable", "matching steps have missing or invalid Computing time");
	return { status: "parsed", source: "msprof-step", binding: "unverified",
		reason: `Computing is a whole-step measurement in ${unit}, not an individual kernel duration.`,
		evidence: { basisId: input.basisId, timingSamplesSeconds: {
			values: values as number[], receiptIndex: input.receiptIndex,
			fieldPath: `csv.column:${column}${input.stepId === undefined ? "" : `;step:${input.stepId}`}${input.deviceId === undefined ? "" : `;device:${input.deviceId}`}` } } };
}

async function command(binary: string, args: string[], timeoutMs = 5_000, cwd?: string,
	signal?: AbortSignal, environment?: Record<string, string>): Promise<{
	status: "ok" | "missing" | "failed"; stdout: string; stderr: string; exitCode: number | null }> {
	return new Promise(resolve => {
		let stdout = "", stderr = "", settled = false;
		const child = spawn(binary, args, { cwd, ...(environment ? { env: environment } : {}),
			detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
		const stop = () => {
			try {
				if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL");
				else child.kill("SIGKILL");
			} catch { /* Already exited; close still settles the command. */ }
		};
		const finish = (status: "ok" | "missing" | "failed", exitCode: number | null) => {
			if (!settled) { settled = true; resolve({ status, stdout, stderr, exitCode }); }
		};
		const timer = setTimeout(stop, timeoutMs);
		signal?.addEventListener("abort", stop, { once: true });
		if (signal?.aborted) stop();
		child.stdout.on("data", chunk => { stdout += String(chunk); });
		child.stderr.on("data", chunk => { stderr += String(chunk); });
		child.on("error", error => { clearTimeout(timer); signal?.removeEventListener("abort", stop);
			finish((error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "failed", null); });
		child.on("close", code => { clearTimeout(timer); signal?.removeEventListener("abort", stop);
			finish(code === 0 && !signal?.aborted ? "ok" : "failed", code); });
	});
}

/** Probe commands only; no profiling, GPU work, or candidate execution. */
export async function probeGpuProfilers(): Promise<ProfilerProbeV1[]> {
	const onPath = async (binary: string): Promise<boolean> => {
		for (const directory of (process.env.PATH ?? "").split(path.delimiter).filter(Boolean))
			if (await access(path.join(directory, binary), constants.X_OK).then(() => true, () => false)) return true;
		return false;
	};
	const checks: Array<{ tool: ProfilerProbeV1["tool"]; binary: string; device: string; args: string[] }> = [
		{ tool: "ncu", binary: "ncu", device: "nvidia-smi", args: ["-L"] },
		{ tool: "msprof", binary: "msprof", device: "npu-smi", args: ["info"] },
	];
	return Promise.all(checks.map(async check => {
		const [toolObserved, device] = await Promise.all([onPath(check.binary), command(check.device, check.args)]);
		const deviceObserved = device.status === "ok" && !!device.stdout.trim();
		const status: ProfilerProbeV1["status"] = toolObserved && deviceObserved ? "available" :
			!toolObserved || device.status === "missing" || device.status === "ok" && !deviceObserved ? "unavailable" : "unknown";
		return { tool: check.tool, status, toolObserved, deviceObserved,
			reason: status === "available" ? "Profiler binary is executable and device inventory responded; profiling permissions and target coverage remain untested." :
				`${check.binary}: ${toolObserved ? "present" : "absent"}; ${check.device}: ${device.status}${device.status === "ok" && !deviceObserved ? " (no device listed)" : ""}` };
	}));
}

/** Import an existing .ncu-rep using the installed NVIDIA CLI; does not launch
 * the profiled program. The export text remains the host's evidence to freeze. */
export async function importNcuReport(reportPath: string, input: { basisId: string; receiptIndex: number;
	launchId?: string }): Promise<ParsedProfilerEvidenceV1> {
	if (!/\.ncu-rep(?:z)?$/iu.test(reportPath))
		return { status: "unavailable", source: "ncu-report", binding: "unverified", reason: "expected an existing Nsight Compute report" };
	const output = await command("ncu", ["--import", reportPath, "--page", "raw", "--csv", "--print-units", "base", "--print-metric-name", "name"], 30_000);
	if (output.status !== "ok") return { status: "unavailable", source: "ncu-report", binding: "unverified",
		reason: `ncu report import ${output.status}; no profile values were inferred` };
	const parsed = parseNcuRawCsv(output.stdout, input);
	return { ...parsed, source: "ncu-report" };
}

/** Materialize the exact CLI raw CSV from an existing binary report for host
 * freezing. Import does not rerun the target program or choose a launch. */
export async function exportNcuReportCsv(reportPath: string, csvPath: string): Promise<{
	status: "exported" | "unavailable"; csvPath?: string; reason: string }> {
	const report = await lstat(reportPath).catch(() => null);
	if (!/\.ncu-rep(?:z)?$/iu.test(reportPath) || !report?.isFile() || report.isSymbolicLink() ||
		!path.isAbsolute(csvPath) || !csvPath.endsWith(".csv"))
		return { status: "unavailable", reason: "existing regular Nsight Compute report and absolute new CSV path are required" };
	const output = await command("ncu", ["--import", reportPath, "--page", "raw", "--csv", "--print-units", "base", "--print-metric-name", "name"], 30_000);
	if (output.status !== "ok" || !table(output.stdout, ["ID", "Kernel Name", "Metric Name", "Metric Unit", "Metric Value"]))
		return { status: "unavailable", reason: `ncu raw report export ${output.status}; expected metric columns are absent or import failed` };
	try { await writeFile(csvPath, output.stdout, { flag: "wx", mode: 0o600 }); }
	catch { return { status: "unavailable", reason: "CSV destination already exists or cannot be written" }; }
	return { status: "exported", csvPath, reason: "Raw ncu CSV was preserved; candidate source and launch binding remain host responsibilities." };
}

export interface HostNcuCapturePlanV1 {
	/** All fields are constructed by the host, independently of model tool input. */
	executable: string;
	argv: readonly string[];
	cwd: string;
	reportBase: string;
	timeoutMs: number;
	/** Exact host-selected target environment, also used to launch ncu. */
	environment?: Record<string, string>;
	signal?: AbortSignal;
}

export interface HostNcuCaptureResultV1 {
	status: "captured" | "unavailable" | "failed";
	reportPath?: string;
	exitCode: number | null;
	startedAt: string;
	finishedAt: string;
	reason: string;
	/** Retain as process evidence in a host-owned receipt; never treat as a correctness result. */
	stdout: string;
	stderr: string;
}

/** Capture only when a trusted host explicitly calls this with its fixed target
 * command. This never chooses, rewrites, or validates the candidate program. */
export async function captureNcuProfile(plan: HostNcuCapturePlanV1): Promise<HostNcuCaptureResultV1> {
	const startedAt = new Date().toISOString();
	const invalid = !path.isAbsolute(plan.executable) || !path.isAbsolute(plan.cwd) ||
		!path.isAbsolute(plan.reportBase) || !Number.isSafeInteger(plan.timeoutMs) || plan.timeoutMs < 1 ||
		!Array.isArray(plan.argv) || plan.argv.some(arg => typeof arg !== "string" || arg.includes("\0")) ||
		(plan.environment !== undefined && (!plan.environment || typeof plan.environment !== "object" ||
			Array.isArray(plan.environment) || Object.entries(plan.environment).some(([name, value]) =>
				!(/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) || typeof value !== "string" || value.includes("\0"))));
	if (invalid) return { status: "unavailable", exitCode: null, startedAt, finishedAt: new Date().toISOString(),
		reason: "host capture plan needs absolute paths, fixed argv, and a positive timeout", stdout: "", stderr: "" };
	const expected = `${plan.reportBase}.ncu-rep`;
	if (await stat(expected).then(() => true, () => false))
		return { status: "unavailable", exitCode: null, startedAt, finishedAt: new Date().toISOString(),
			reason: "profile report path already exists", stdout: "", stderr: "" };
	const result = await command("ncu", ["--target-processes", "all", "--set", "basic", "--export", plan.reportBase,
		"--", plan.executable, ...plan.argv], plan.timeoutMs, plan.cwd, plan.signal, plan.environment);
	const reportExists = await stat(expected).then(info => info.isFile(), () => false);
	return { status: result.status === "ok" && reportExists ? "captured" : result.status === "missing" ? "unavailable" : "failed",
		...(reportExists ? { reportPath: expected } : {}), exitCode: result.exitCode,
		startedAt, finishedAt: new Date().toISOString(),
		reason: result.status === "ok" && reportExists ? "ncu report captured; source, launch and receipt binding still require host verification" :
			result.status === "missing" ? "ncu binary is unavailable" :
			result.status === "ok" ? "ncu exited without the expected report" : "ncu or the profiled program failed; any partial report is not a correctness result",
		stdout: result.stdout, stderr: result.stderr };
}

/** Convenience entry point for existing CSV files; caller retains the original
 * file and supplies a receipt index only after freezing it. */
export async function readProfilerCsv(kind: "ncu-csv" | "msprof-kernel" | "msprof-step", filePath: string,
	input: { basisId: string; receiptIndex: number; launchId?: string; kernelName?: string; taskId?: string; stepId?: string;
		deviceId?: string; unit?: "ns" | "us" | "ms" | "s" }): Promise<ParsedProfilerEvidenceV1> {
	let text: string;
	try { text = await readFile(filePath, "utf8"); }
	catch { return { status: "unavailable", source: kind, binding: "unverified", reason: "profiler CSV could not be read" }; }
	try {
		return kind === "ncu-csv" ? parseNcuRawCsv(text, input) : kind === "msprof-kernel" ?
			parseMsprofKernelCsv(text, input) : parseMsprofStepCsv(text, input);
	} catch (error) {
		return { status: "unavailable", source: kind, binding: "unverified",
			reason: error instanceof Error ? error.message : "CSV parsing failed" };
	}
}
