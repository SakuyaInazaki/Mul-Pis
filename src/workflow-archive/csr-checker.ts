/** A controller-owned CSR validator generated from private inputs at runtime. */

export interface CsrExperimentCase {
	id: string;
	rows: number;
	cols: number;
	normalNnz: number;
	longRows: number;
	longNnz: number;
	seed: number;
	threadCounts: readonly number[];
	warmups: number;
	repeats: number;
}

export interface CsrExperimentPlan {
	registeredStrategies: readonly string[];
	cases: readonly CsrExperimentCase[];
}

export interface CsrCheckerMetadata {
	matrixType: string;
	targets: readonly string[];
	maxStrategies: number;
	baselines: { serial: string; stdThread: string };
	absTolerance: string;
	relTolerance: string;
	candidateInclude: string;
	threadCounts: readonly [1, 2, 4];
	shapes: readonly (readonly [number, number])[];
	mutationPasses: 2;
	threadPolicy: typeof CSR_THREAD_POLICY;
	timing: { marker: "CSR_TIMING"; cases: readonly CsrExperimentCase[];
		accounting: "first-call-and-warmups-separate-from-steady-state"; freshProcessPerSelection: true;
		inputValuesMutatedBetweenCalls: true; perfScope: "one-selected-kernel-plus-host-generation-and-validation";
		metric: "isolated-worker-roundtrip"; startupSeparate: true; trust: "parent-clock-and-raw-output-comparison";
		baselineIsolation: "independently-compiled-immutable-original"; runtimeFiles: "read-only-evaluator-with-separate-writable-scratch";
		threadsMeaning: "requested-default-and-openmp-cap"; actualThreads: "not_observed" };
}

export interface CsrChecker { source: string; workerSource: string; baselineWorkerSource: string; metadata: CsrCheckerMetadata }

export interface CsrValidationDiagnostic {
	kind: "csr-validation-diagnostic";
	phase: "source-validation";
	ruleId: string;
	disposition: "unsupported-capability" | "rejected-source";
	message: string;
	functionName?: string;
	source: { name: "candidate.cpp"; line: number; column: number; startOffset: number; endOffset: number;
		offsetEncoding: "utf16"; excerpt: string };
	offendingToken: string;
	directive?: string;
	policy: string;
	nextAction: string;
	compilationStatus: "not_run";
	correctnessStatus: "not_run";
	measurementStatus: "not_run";
}

export class CsrValidationError extends Error {
	readonly diagnostic: CsrValidationDiagnostic;
	constructor(diagnostic: CsrValidationDiagnostic) {
		super(`${diagnostic.ruleId} at ${diagnostic.source.name}:${diagnostic.source.line}:${diagnostic.source.column}` +
			`${diagnostic.functionName ? ` in ${diagnostic.functionName}` : ""}: ${diagnostic.message}` +
			` Offending source: ${diagnostic.offendingToken}. Candidate compilation, correctness and measurement were not run.`);
		this.name = "CsrValidationError";
		this.diagnostic = diagnostic;
	}
}

export function getCsrValidationDiagnostic(error: unknown): CsrValidationDiagnostic | undefined {
	return error instanceof CsrValidationError ? error.diagnostic : undefined;
}

function rejectSource(source: string, token: { start: number; end: number; text: string },
	ruleId: string, message: string, policy: string, nextAction: string, functionName?: string,
	disposition: CsrValidationDiagnostic["disposition"] = "rejected-source"): never {
	const before = source.slice(0, token.start);
	const lineStart = source.lastIndexOf("\n", token.start - 1) + 1;
	const lineEnd = source.indexOf("\n", token.start);
	throw new CsrValidationError({ kind: "csr-validation-diagnostic", phase: "source-validation", ruleId,
		disposition, message, functionName,
		source: { name: "candidate.cpp", line: before.split("\n").length, column: token.start - lineStart + 1,
			startOffset: token.start, endOffset: token.end, offsetEncoding: "utf16",
			excerpt: source.slice(lineStart, lineEnd < 0 ? source.length : lineEnd).slice(0, 800) },
		offendingToken: token.text.slice(0, 800), ...(token.text.startsWith("#") ? { directive: token.text.slice(0, 800) } : {}),
		policy, nextAction, compilationStatus: "not_run", correctnessStatus: "not_run", measurementStatus: "not_run" });
}

/** Engineering execution bounds, not a claim that this covers the scientific task. */
export const CSR_EXPERIMENT_LIMITS = Object.freeze({
	maxStrategies: 16, maxCases: 6, maxRows: 20_000, maxCols: 200_000,
	maxNnz: 2_000_000, minRepeats: 3, maxRepeats: 50, minWarmups: 1, maxWarmups: 8,
	maxThreadChoices: 4, maxThreads: 16, maxTimedWork: 200_000_000, maxSourceBytes: 512_000,
	workerAddressSpaceBytes: 2 * 1024 * 1024 * 1024, workerCpuSeconds: 60, protocolTimeoutMs: 15_000,
});

export const CSR_THREAD_POLICY = Object.freeze({
	threadsMeaning: "requested-default-and-openmp-cap" as const,
	actualThreads: "not_observed" as const,
	description: "Host parallel num_threads, scheduling clauses and ordinary OpenMP team-size runtime controls are permitted. Each worker starts with OMP_THREAD_LIMIT equal to the tested requested-thread budget, bounding its OpenMP contention group; the default team size starts at that budget, dynamic adjustment starts disabled and active nesting starts at one level. Strategies may use fewer threads or adjust these defaults within the runtime cap. The threads field is the requested default/cap, not an observation of actual team sizes or all operating-system threads. Memory, CPU and protocol limits remain separate. Teams/offload constructs require a separate capability decision.",
});

export interface CsrTaskContract {
	matrixType: string;
	strategyPrefix: string;
	originalTargets: readonly string[];
	maxStrategies: number;
	baselines: { serial: string; stdThread: string };
	limits: typeof CSR_EXPERIMENT_LIMITS;
	sourceScope: string;
	timingScope: string;
	metric: "isolated-worker-roundtrip";
	threadPolicy: typeof CSR_THREAD_POLICY;
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z_0-9]*$/;
const SHAPES = [[1, 1], [7, 5], [19, 23], [32, 11]] as const;
const MAX_STRATEGY_SAFETY_CAP = CSR_EXPERIMENT_LIMITS.maxStrategies;
const MAX_TIMED_WORK = CSR_EXPERIMENT_LIMITS.maxTimedWork;

interface CppToken { text: string; start: number; end: number }
/** A fail-closed lexical boundary; deliberately not a general C++ parser or an OS sandbox. */
function cppTokens(source: string): CppToken[] {
	if (Buffer.byteLength(source) > CSR_EXPERIMENT_LIMITS.maxSourceBytes || /\\\r?\n|\?\?\/|<%|%>|%:/.test(source))
		throw new Error("source exceeds bound or uses unsupported translation-phase syntax");
	const tokens: CppToken[] = [];
	let index = 0;
	while (index < source.length) {
		const start = index;
		if (/\s/.test(source[index])) { ++index; continue; }
		if (source.startsWith("//", index)) { const end = source.indexOf("\n", index); index = end < 0 ? source.length : end; continue; }
		if (source.startsWith("/*", index)) {
			const end = source.indexOf("*/", index + 2);
			if (end < 0) throw new Error("unterminated C++ comment");
			index = end + 2; continue;
		}
		const raw = /^(?:u8|u|U|L)?R"([^ ()\\\t\r\n]{0,16})\(/.exec(source.slice(index));
		if (raw) {
			const end = source.indexOf(`)${raw[1]}"`, index + raw[0].length);
			if (end < 0) throw new Error("unterminated C++ raw literal");
			index = end + raw[1].length + 2;
		} else if (source[index] === '"' || source[index] === "'") {
			const quote = source[index++]; let closed = false;
			while (index < source.length) {
				if (source[index] === "\\") { index += 2; continue; }
				if (source[index++] === quote) { closed = true; break; }
			}
			if (!closed) throw new Error("unterminated C++ literal");
		} else if (source[index] === "#") {
			if (source.slice(source.lastIndexOf("\n", index - 1) + 1, index).trim())
				throw new Error("unsupported C++ preprocessor token");
			const end = source.indexOf("\n", index); index = end < 0 ? source.length : end;
		} else {
			const word = /^[A-Za-z_][A-Za-z_0-9]*|^(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?[A-Za-z_0-9]*|^(?:<<|>>|::|->|&&|\|\||==|!=|<=|>=|\+\+|--|\+=|-=|\*=|\/=)/.exec(source.slice(index));
			index += word ? word[0].length : 1;
		}
		tokens.push({ text: source.slice(start, index), start, end: index });
	}
	return tokens;
}
function closeToken(tokens: CppToken[], open: number): number {
	const pairs: Record<string, string> = { "{": "}", "(": ")", "[": "]" };
	const close = pairs[tokens[open]?.text];
	if (!close) throw new Error("unsupported C++ delimiter");
	const stack = [close];
	for (let i = open + 1; i < tokens.length; ++i) {
		const text = tokens[i].text;
		if (Object.hasOwn(pairs, text)) stack.push(pairs[text]);
		else if (["}", ")", "]"].includes(text)) {
			if (stack.pop() !== text) throw new Error("unbalanced C++ delimiter");
			if (!stack.length) return i;
		}
	}
	throw new Error("unbalanced C++ source");
}
interface SourceUnit { start: number; end: number; name?: string; bodyOpen?: number; bodyClose?: number; tokens: CppToken[] }
function sourceUnits(tokens: CppToken[]): SourceUnit[] {
	const units: SourceUnit[] = [];
	for (let cursor = 0; cursor < tokens.length;) {
		const start = cursor;
		if (tokens[cursor].text.startsWith("#")) { units.push({ start, end: ++cursor, tokens: tokens.slice(start, cursor) }); continue; }
		let finished = false;
		for (; cursor < tokens.length; ++cursor) {
			if (tokens[cursor].text === ";") { ++cursor; finished = true; break; }
			if (tokens[cursor].text !== "{") continue;
			const bodyOpen = cursor, bodyClose = closeToken(tokens, cursor);
			const header = tokens.slice(start, bodyOpen);
			const paren = header.findIndex(token => token.text === "(");
			const name = paren > 0 && header.at(-1)?.text === ")" && IDENTIFIER.test(header[paren - 1].text)
				? header[paren - 1].text : undefined;
			cursor = bodyClose + 1;
			if (!name && tokens[cursor]?.text === ";") ++cursor;
			units.push({ start, end: cursor, name, bodyOpen, bodyClose, tokens: tokens.slice(start, cursor) });
			finished = true; break;
		}
		if (!finished) throw new Error("unsupported trailing C++ source");
		if (units.at(-1)?.start !== start) units.push({ start, end: cursor, tokens: tokens.slice(start, cursor) });
	}
	return units;
}
function tokenText(tokens: readonly CppToken[]): string { return JSON.stringify(tokens.map(token => token.text)); }

function escapeRegExp(text: string): string { return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function uniqueMatch(source: string, expression: RegExp, message: string): RegExpMatchArray {
	const matches = [...source.matchAll(expression)];
	if (matches.length !== 1) throw new Error(message);
	return matches[0];
}
function bracedBody(source: string, start: number): string {
	const open = source.indexOf("{", start);
	if (open < 0) throw new Error("missing function body");
	let depth = 0;
	for (let i = open; i < source.length; ++i) {
		if (source[i] === "{") ++depth;
		else if (source[i] === "}" && --depth === 0) return source.slice(open, i + 1);
	}
	throw new Error("unbalanced function body");
}
function requiredTolerance(starter: string, name: "abs_tol" | "rel_tol"): string {
	const number = "([+]?(?:[0-9]+(?:\\.[0-9]*)?|\\.[0-9]+)(?:[eE][+-]?[0-9]+)?)";
	const match = uniqueMatch(starter, new RegExp(`\\b${name}\\s*=\\s*${number}\\b`, "g"),
		`cannot derive unique starter ${name}`);
	if (!Number.isFinite(Number(match[1])) || Number(match[1]) < 0) throw new Error(`invalid starter ${name}`);
	return match[1];
}
function originalNames(starter: string, taskText: string) {
	const todo = ([1, 2] as const).map(ordinal => {
		const marker = uniqueMatch(starter, new RegExp(`\\/\\/[^\\n]*\\bTODO\\s*${ordinal}\\s*:`, "g"),
			`expected one TODO ${ordinal} marker`);
		const after = starter.slice(marker.index! + marker[0].length, marker.index! + marker[0].length + 1200);
		const signature = after.match(/\bstatic\s+void\s+([A-Za-z_]\w*)\s*\(\s*const\s+([A-Za-z_]\w*)\s*&/);
		if (!signature) throw new Error(`cannot derive TODO ${ordinal} signature`);
		return { name: signature[1], matrixType: signature[2] };
	});
	if (todo[0].matrixType !== todo[1].matrixType) throw new Error("TODO CSR types differ");
	const suffix = /^(.*)_1$/.exec(todo[0].name);
	if (!suffix || todo[1].name !== `${suffix[1]}_2`) throw new Error("TODO names must use consecutive numbered suffixes");
	const prefix = suffix[1];
	if (!IDENTIFIER.test(prefix) || !IDENTIFIER.test(todo[0].matrixType)) throw new Error("invalid derived identifier");
	if (!new RegExp(`\\bstruct\\s+${escapeRegExp(todo[0].matrixType)}\\s*\\{`).test(starter))
		throw new Error("derived CSR struct declaration is missing");
	const matrixStruct = uniqueMatch(starter,
		new RegExp(`\\bstruct\\s+${escapeRegExp(todo[0].matrixType)}\\s*\\{([\\s\\S]*?)\\};`, "g"),
		"cannot derive unique CSR struct fields");
	const dimensions = [...matrixStruct[1].matchAll(/\bint\s+([A-Za-z_]\w*)\s*=\s*0\s*;/g)]
		.map(match => match[1]);
	const integerVectors = [...matrixStruct[1].matchAll(/\bstd::vector<int>\s+([A-Za-z_]\w*)\s*;/g)]
		.map(match => match[1]);
	const valueVectors = [...matrixStruct[1].matchAll(/\bstd::vector<double>\s+([A-Za-z_]\w*)\s*;/g)]
		.map(match => match[1]);
	if (dimensions.length !== 2 || integerVectors.length !== 2 || valueVectors.length !== 1 ||
		new Set([...dimensions, ...integerVectors, ...valueVectors]).size !== 5)
		throw new Error("unsupported CSR struct field layout");
	const matrixFields = { rows: dimensions[0], cols: dimensions[1], offsets: integerVectors[0],
		columns: integerVectors[1], values: valueVectors[0] };
	const taskBounds = [
		...taskText.matchAll(new RegExp(`上限为\\s*(?:\\x60)?${escapeRegExp(prefix)}_(\\d+)\\b`, "g")),
		...taskText.matchAll(new RegExp(`(?:^|[.\\n])\\s*(?:you\\s+may\\s+)?register\\s+(?:at\\s+most|up\\s+to)\\s+(?:\\x60)?${escapeRegExp(prefix)}_(\\d+)\\b`, "gi")),
		...taskText.matchAll(new RegExp(`最多注册\\s*(\\d+)\\s*个\\s*(?:\\x60)?${escapeRegExp(prefix)}_\\*`, "g")),
	].map(match => Number(match[1]));
	const maxStrategies = taskBounds[0];
	if (!Number.isSafeInteger(maxStrategies) || maxStrategies < 2 || maxStrategies > MAX_STRATEGY_SAFETY_CAP ||
		taskBounds.some(value => value !== maxStrategies))
		throw new Error("cannot derive a unique bounded strategy maximum from task text");
	const firstTodo = /\/\/[^\n]*\bTODO\s*1\s*:/.exec(starter);
	const beforeTodo = starter.slice(0, firstTodo!.index);
	const matrix = escapeRegExp(todo[0].matrixType);
	const baselines = [...beforeTodo.matchAll(new RegExp(`\\bstatic\\s+void\\s+([A-Za-z_]\\w*)\\s*\\(\\s*const\\s+${matrix}\\s*&[\\s\\S]*?\\)\\s*\\{`, "g"))]
		.map(match => ({ name: match[1], arity: (match[0].match(/,/g) ?? []).length + 1 }));
	const serial = baselines.filter(item => item.arity === 3);
	const stdThread = baselines.filter(item => item.arity === 4);
	if (serial.length !== 1 || stdThread.length !== 1) throw new Error("cannot derive unique serial/std::thread references");
	const generator = uniqueMatch(starter,
		new RegExp(`\\bstatic\\s+${matrix}\\s+([A-Za-z_]\\w*)\\s*\\(\\s*const\\s+([A-Za-z_]\\w*)\\s*&`, "g"),
		"cannot derive unique original matrix generator");
	const options = uniqueMatch(starter,
		new RegExp(`\\bstruct\\s+${escapeRegExp(generator[2])}\\s*\\{([\\s\\S]*?)\\};`, "g"),
		"cannot derive unique original generator options");
	const numericOptions = [...options[1].matchAll(/\bint\s+([A-Za-z_]\w*)\s*=\s*\d+\s*;/g)].map(match => match[1]);
	const unsignedOptions = [...options[1].matchAll(/\bunsigned\s+([A-Za-z_]\w*)\s*=\s*\d+u?\s*;/g)].map(match => match[1]);
	if (numericOptions.length < 7 || numericOptions.length > 12 || unsignedOptions.length !== 1 ||
		new Set([...numericOptions, ...unsignedOptions]).size !== numericOptions.length + 1)
		throw new Error("unsupported original generator option shape");
	const generatorBody = bracedBody(starter, generator.index!);
	const usesOption = (field: string) => new RegExp(`\\boptions\\.${escapeRegExp(field)}\\b`).test(generatorBody);
	if (!new RegExp(`\\b\\w+\\.${escapeRegExp(matrixFields.rows)}\\s*=\\s*options\\.${escapeRegExp(numericOptions[0])}\\b`).test(generatorBody) ||
		!new RegExp(`\\b\\w+\\.${escapeRegExp(matrixFields.cols)}\\s*=\\s*options\\.${escapeRegExp(numericOptions[1])}\\b`).test(generatorBody) ||
		!numericOptions.slice(2, 5).every(usesOption) || !usesOption(unsignedOptions[0]))
		throw new Error("unsupported original generator field mapping");
	const vectorGenerator = uniqueMatch(starter,
		/\bstatic\s+std::vector<double>\s+([A-Za-z_]\w*)\s*\(\s*int\s+\w+\s*,\s*unsigned\s+\w+\s*\)/g,
		"cannot derive unique original vector generator");
	const resultChecker = uniqueMatch(starter,
		/\bstatic\s+bool\s+([A-Za-z_]\w*)\s*\(\s*const\s+std::vector<double>\s*&[^,]+,\s*const\s+std::vector<double>\s*&[^,]+,\s*double\s+abs_tol\s*=/g,
		"cannot derive unique original result checker");
	return { prefix, matrixType: todo[0].matrixType, matrixFields,
		maxStrategies, serial: serial[0].name, stdThread: stdThread[0].name,
		optionsType: generator[2], optionFields: numericOptions.slice(0, 5), seedField: unsignedOptions[0],
		matrixGenerator: generator[1], vectorGenerator: vectorGenerator[1], resultChecker: resultChecker[1] };
}

export function inspectCsrTaskContract(starterSource: string, taskText: string): CsrTaskContract {
	const names = originalNames(starterSource, taskText);
	validateCsrCandidateSource(starterSource, starterSource, taskText, [`${names.prefix}_1`, `${names.prefix}_2`]);
	requiredTolerance(starterSource, "abs_tol"); requiredTolerance(starterSource, "rel_tol");
	return { matrixType: names.matrixType, strategyPrefix: names.prefix,
		originalTargets: [`${names.prefix}_1`, `${names.prefix}_2`], maxStrategies: names.maxStrategies,
		baselines: { serial: names.serial, stdThread: names.stdThread }, limits: CSR_EXPERIMENT_LIMITS,
		metric: "isolated-worker-roundtrip",
		threadPolicy: CSR_THREAD_POLICY,
		sourceScope: "Original declarations, generators, serial/std::thread references, checker and benchmark remain immutable. Edit the original student bodies and main; add bounded static functions or plain struct definitions. No new globals, includes, macros, external linkage, constructors with global instances, kernel-side I/O, process control or benchmark hooks; main may print results but is excluded from the trusted checker. This lexical source gate is not a memory-safety proof or a security sandbox. Unsupported source extensions remain an explicit task gap.",
		timingScope: "A separate worker receives only bounded CSR/input packets and returns raw output values; the immutable parent owns comparison, status and clocks. Baselines are compiled independently from the immutable original, using the identical worker protocol. Evaluation files/binaries must be read-only at runtime, with separate writable scratch. Use a fresh parent process per --timing selector. Startup is separate. First-call, warmup and repeated samples measure persistent-worker round-trip time, including input serialization, IPC, worker input checks, kernel/preprocessing and output transfer. This is not kernel-only time. Values and inputs change between calls to reject cached answers. Whole-process perf additionally includes host generation and validation. First-call cost and startup cannot be silently discarded when making end-to-end claims.",
	};
}

function safeExtensionTokens(tokens: CppToken[], immutableFunctionNames: readonly string[], source: string,
	functionName?: string, mainBody = false): void {
	const conditionals: Array<{ token: CppToken; elseSeen: boolean }> = [];
	const attribute = tokens.find((token, i) => token.text === "[" && tokens[i + 1]?.text === "[");
	if (attribute) rejectSource(source, attribute, "source.cpp.unsupported-attribute", "C++ attributes are outside this adapter's supported source surface",
		"Attributes can alter linkage, initialization or compilation; this adapter does not validate them.",
		"Request a capability decision for the exact attribute rather than changing the scientific strategy blindly.", functionName, "unsupported-capability");
	for (const token of tokens) {
		const text = token.text;
		if (text === "_OPENMP") continue;
		// Main may register experiments and print ordinary results, but is never part of trusted validation.
		if (mainBody && /^(?:cout|cerr|clog|printf|fprintf|puts|putchar|stdout|stderr|benchmark_ms|omp_set_num_threads)$/.test(text)) continue;
		if (text.startsWith("#")) {
			const directive = text.slice(1).trim();
			if (/^pragma\s+omp\s+(?:parallel|for|simd|sections|section|single|master|critical|atomic|barrier|task|taskgroup|taskwait|taskyield|ordered|flush)\b/.test(directive)) continue;
			if (/^pragma\s+omp\b/.test(directive)) rejectSource(source, token, "source.openmp.unsupported-construct",
				"This OpenMP construct is outside the currently supported host-CPU execution surface",
				"Host parallel/loop/task constructs and their thread-selection clauses are supported. Teams/offload/declare constructs require a separate capability decision; this is not a correctness result.",
				"Report this exact construct as a capability gap. Do not infer that schedule chunks or num_threads are forbidden.", functionName, "unsupported-capability");
			if (/^(?:ifdef\s+_OPENMP|if\s+defined\s*(?:\(\s*_OPENMP\s*\)|_OPENMP))\s*$/.test(directive)) {
				conditionals.push({ token, elseSeen: false }); continue;
			}
			if (directive === "else" && conditionals.length && !conditionals.at(-1)!.elseSeen) { conditionals.at(-1)!.elseSeen = true; continue; }
			if (directive === "endif" && conditionals.length) { conditionals.pop(); continue; }
			rejectSource(source, token, "source.preprocessor.unsupported-directive", "Preprocessor directive is not admitted by this source boundary",
				"Added includes, macro definitions and arbitrary conditionals are not supported; balanced _OPENMP conditionals and the documented host OpenMP pragmas are supported.",
				"Inspect the exact directive and location shown here. If the task requires it, request adapter support instead of guessing which strategy to rewrite.", functionName, "unsupported-capability");
		}
		if (/^(?:extern|friend|asm|__asm|__asm__|__attribute__|__declspec|alignas|thread_local|operator|_Pragma)$/.test(text) ||
			text === "[[" || /^(?:checker_|csr_check_|__|_[A-Z]|pthread_)/.test(text) ||
			/^(?:putchar|putc|fputc|fputs|fputws|putwchar|fputwc|fwrite|fflush)(?:_unlocked)?$/.test(text) ||
			/^(?:detach|setbuf|setvbuf|setbuffer|setlinebuf|perror|ioctl|prctl|ptrace|mmap|mprotect|process_vm_readv|process_vm_writev)$/.test(text) ||
			/^(?:main|benchmark_ms|chrono|steady_clock|system_clock|high_resolution_clock|clock|clock_gettime|timespec_get|gettimeofday|rdtsc|printf|fprintf|sprintf|snprintf|vprintf|vfprintf|vsprintf|vsnprintf|wprintf|fwprintf|swprintf|vwprintf|vfwprintf|vswprintf|puts|fputs|putchar|fputc|putc|fputws|putwchar|fputwc|fwrite|write|writev|cout|cerr|clog|cin|wcout|wcerr|wclog|wcin|stdout|stderr|stdin|streambuf|ofstream|ifstream|fstream|freopen|fopen|open|close|dup|dup2|syscall|dlsym|dlopen|system|popen|fork|vfork|execve|execl|exit|_Exit|_exit|quick_exit|abort|atexit|at_quick_exit|signal|sigaction|raise|kill|getenv|setenv|putenv|unsetenv|setlocale|fesetround|feenableexcept)$/.test(text) ||
			immutableFunctionNames.includes(text))
			rejectSource(source, token, "source.facility.forbidden-token", `Candidate extension references a forbidden host or benchmark facility: ${text}`,
				"Candidate kernels cannot access host I/O, process control, clocks, immutable checker/generator entry points or runtime controls that defeat the resource boundary.",
				"Review this exact token in its function. Use the host measurement interface for clocks and output; report a capability gap when required functionality is unavailable.", functionName);
	}
	if (conditionals.length) rejectSource(source, conditionals[0].token, "source.preprocessor.unbalanced-conditional",
		"An _OPENMP conditional opened here is not closed inside this function", "Preprocessor conditionals must remain balanced inside each candidate function.",
		"Close the conditional in the same function and rerun source validation; compilation and measurement have not started.", functionName);
}

/** Adds lexical host-facility protection to the separate legacy structural checker; never replaces it. */
export function validateCsrTargetBodies(starterSource: string, candidateSource: string): void {
	const descriptors = [1, 2].map(ordinal => {
		const marker = uniqueMatch(starterSource, new RegExp(`\\/\\/[^\\n]*\\bTODO\\s*${ordinal}\\s*:`, "g"),
			`expected one TODO ${ordinal} marker`);
		const after = starterSource.slice(marker.index! + marker[0].length, marker.index! + marker[0].length + 1200);
		const signature = /\b(?:static\s+)?void\s+([A-Za-z_]\w*)\s*\(\s*const\s+([A-Za-z_]\w*)\s*&/.exec(after);
		if (!signature) throw new Error("unsupported original target signature");
		return { name: signature[1], matrixType: signature[2] };
	});
	const targets = descriptors.map(item => item.name);
	if (descriptors[0].matrixType !== descriptors[1].matrixType) throw new Error("inconsistent target matrix types");
	const originalUnits = sourceUnits(cppTokens(starterSource));
	const candidateTokens = cppTokens(candidateSource), units = sourceUnits(candidateTokens);
	const baselineSignature = new RegExp(`^(?:static )?void [A-Za-z_]\\w* \\( const ${escapeRegExp(descriptors[0].matrixType)} &`);
	const forbidden = originalUnits.filter(unit => unit.name && !targets.includes(unit.name) &&
		!baselineSignature.test(unit.tokens.map(token => token.text).join(" "))).map(unit => unit.name!);
	for (const name of targets) {
		const matching = units.filter(unit => unit.name === name);
		if (matching.length !== 1) throw new Error("missing or repeated original target");
		const unit = matching[0];
		safeExtensionTokens(candidateTokens.slice(unit.bodyOpen! + 1, unit.bodyClose), forbidden, candidateSource, name);
	}
}

/** Central preservation gate. Returned source excludes candidate main from host validation. */
export function validateCsrCandidateSource(starterSource: string, candidateSource: string,
	taskText: string, registeredStrategies: readonly string[]): { ok: true; reason: string; targetCount: number; checkerCandidateSource: string } {
	const names = originalNames(starterSource, taskText);
	const originalTokens = cppTokens(starterSource), candidateTokens = cppTokens(candidateSource);
	const originalUnits = sourceUnits(originalTokens), candidateUnits = sourceUnits(candidateTokens);
	const originalTargets = [`${names.prefix}_1`, `${names.prefix}_2`];
	if (!Array.isArray(registeredStrategies) || registeredStrategies.length < 2 || registeredStrategies.length > names.maxStrategies ||
		registeredStrategies.some((name, i) => name !== `${names.prefix}_${i + 1}`))
		throw new Error("invalid bounded strategy registry");
	const originalFunctions = originalUnits.filter(unit => unit.name).map(unit => unit.name!);
	const forbiddenFunctions = originalFunctions.filter(name => ![...originalTargets, names.serial, names.stdThread].includes(name));
	const addedNames: string[] = [];
	let originalCursor = 0;
	let candidateMain: SourceUnit | undefined;
	for (const unit of candidateUnits) {
		const original = originalUnits[originalCursor];
		if (original && unit.name === original.name && (originalTargets.includes(unit.name ?? "") || unit.name === "main")) {
			const originalHeader = originalTokens.slice(original.start, original.bodyOpen! + 1);
			const candidateHeader = candidateTokens.slice(unit.start, unit.bodyOpen! + 1);
			if (tokenText(originalHeader) !== tokenText(candidateHeader)) rejectSource(candidateSource, candidateTokens[unit.start],
				"source.preservation.original-signature", "Candidate changed an original function signature",
				"The original function interfaces remain immutable; student bodies and supported extensions may change.",
				"Restore the original signature at this location, preserving the intended body implementation.", unit.name);
			if (unit.name === "main") {
				candidateMain = unit;
				safeExtensionTokens(candidateTokens.slice(unit.bodyOpen! + 1, unit.bodyClose), [], candidateSource, unit.name, true);
			}
			else safeExtensionTokens(candidateTokens.slice(unit.bodyOpen! + 1, unit.bodyClose), forbiddenFunctions, candidateSource, unit.name);
			++originalCursor; continue;
		}
		if (original && tokenText(unit.tokens) === tokenText(original.tokens)) { ++originalCursor; continue; }
		if (unit.name && unit.tokens[0].text === "static" && !originalFunctions.includes(unit.name) &&
			!addedNames.includes(unit.name) && !unit.name.startsWith("checker_") && !unit.name.startsWith("csr_check_")) {
			addedNames.push(unit.name);
			safeExtensionTokens(unit.tokens, forbiddenFunctions, candidateSource, unit.name);
			continue;
		}
		// Plain type declarations allow local preprocessing layouts, but no global objects or initialization.
		if (unit.tokens[0]?.text === "struct" && IDENTIFIER.test(unit.tokens[1]?.text ?? "") && unit.tokens[2]?.text === "{" &&
			unit.bodyClose !== undefined && unit.end === unit.bodyClose + 2 && unit.tokens.at(-1)?.text === ";") {
			const staticStorage = unit.tokens.find(token => token.text === "static");
			if (staticStorage) rejectSource(candidateSource, staticStorage, "source.storage.added-static-member",
				"An added struct introduces static storage", "Added layout structs cannot introduce global/static initialization outside a measured call.",
				"Report the required storage lifetime as a capability gap; the host has not compiled or measured this source.", undefined, "unsupported-capability");
			safeExtensionTokens(unit.tokens, forbiddenFunctions, candidateSource); continue;
		}
		rejectSource(candidateSource, candidateTokens[unit.start], "source.preservation.immutable-region",
			"Candidate changed frozen original source or added an unsupported top-level declaration",
			"Original types, generators, references, checker and benchmark are immutable; only declared student bodies, main and supported static functions/layout structs may change.",
			"Compare this source location with the immutable original. Restore the frozen region or report the required new declaration as a capability gap.", unit.name);
	}
	if (originalCursor !== originalUnits.length || !candidateMain) throw new Error("candidate omitted frozen original source");
	const actualStrategies = [...originalTargets, ...addedNames.filter(name => new RegExp(`^${escapeRegExp(names.prefix)}_\\d+$`).test(name))];
	if (actualStrategies.length !== registeredStrategies.length || new Set(actualStrategies).size !== actualStrategies.length ||
		actualStrategies.some(name => !registeredStrategies.includes(name)))
		throw new Error("every added student strategy must be registered exactly once");
	const mainOpen = candidateTokens[candidateMain.bodyOpen!].start, mainEnd = candidateTokens[candidateMain.bodyClose!].end;
	return { ok: true, reason: "immutable original code preserved; registered strategy extensions validated", targetCount: registeredStrategies.length,
		checkerCandidateSource: candidateSource.slice(0, mainOpen) + "{ return 0; }" + candidateSource.slice(mainEnd) };
}

function checkedPlan(starter: string, candidate: string, taskText: string, plan: CsrExperimentPlan) {
	const names = originalNames(starter, taskText);
	if (!plan || Object.keys(plan).sort().join(",") !== "cases,registeredStrategies" ||
		!Array.isArray(plan.registeredStrategies) || !Array.isArray(plan.cases))
		throw new Error("experiment plan must contain registered strategies and cases");
	const targets = [...plan.registeredStrategies];
	if (targets.length < 2 || targets.length > names.maxStrategies ||
		Object.keys(plan.registeredStrategies).length !== targets.length ||
		targets.some((name, index) => name !== `${names.prefix}_${index + 1}`))
		throw new Error("strategy registry must start with original targets and use consecutive suffixes");
	const preserved = validateCsrCandidateSource(starter, candidate, taskText, targets);
	const candidateCode = cppTokens(candidate).reduce((text, token) => {
		const value = /^(?:u8|u|U|L)?(?:R?"|')/.test(token.text) ? " ".repeat(token.text.length) : token.text;
		return text + " ".repeat(token.start - text.length) + value;
	}, "");
	const allDefinitions = [...candidateCode.matchAll(new RegExp(`\\b(?:static\\s+)?(?:inline\\s+)?void\\s+(${escapeRegExp(names.prefix)}_(\\d+))\\s*\\(`, "g"))]
		.map(match => match[1]);
	const declared = [...candidateCode.matchAll(new RegExp(`\\bstatic\\s+void\\s+(${escapeRegExp(names.prefix)}_(\\d+))\\s*\\(`, "g"))];
	const declaredNames = declared.map(match => match[1]);
	if (new Set(allDefinitions).size !== allDefinitions.length || allDefinitions.length !== targets.length ||
		allDefinitions.some(name => !targets.includes(name)) ||
		new Set(declaredNames).size !== declaredNames.length || declaredNames.length !== targets.length ||
		declaredNames.some(name => !targets.includes(name))) throw new Error("all student strategy definitions must be registered exactly once");
	for (const target of targets) {
		const signature = new RegExp(`\\bstatic\\s+void\\s+${escapeRegExp(target)}\\s*\\(\\s*const\\s+${escapeRegExp(names.matrixType)}\\s*&[^,]*,\\s*const\\s+std::vector<double>\\s*&[^,]*,\\s*std::vector<double>\\s*&[^)]*\\)\\s*\\{`, "g");
		uniqueMatch(candidateCode, signature, `ambiguous or unsupported signature for ${target}`);
	}
	if (plan.cases.length < 1 || plan.cases.length > 6 || Object.keys(plan.cases).length !== plan.cases.length)
		throw new Error("plan needs one to six dense cases");
	const ids = new Set<string>();
	let timedWork = 0;
	const cases = plan.cases.map(value => {
		if (!value || Object.keys(value).sort().join(",") !==
			"cols,id,longNnz,longRows,normalNnz,repeats,rows,seed,threadCounts,warmups" ||
			typeof value.id !== "string" || !/^[a-z][a-z0-9_-]{0,31}$/.test(value.id) || ids.has(value.id))
			throw new Error("invalid or repeated case id");
		ids.add(value.id);
		const integer = (number: number, min: number, max: number) => Number.isSafeInteger(number) && number >= min && number <= max;
		if (!integer(value.rows, 1, 20_000) || !integer(value.cols, 1, 200_000) ||
			!integer(value.normalNnz, 0, value.cols) || !integer(value.longRows, 0, value.rows) ||
			!integer(value.longNnz, 0, value.cols) || !integer(value.seed, 0, 0xffffffff) ||
			!integer(value.warmups, 1, 8) || !integer(value.repeats, 3, 50) ||
			!Array.isArray(value.threadCounts) || value.threadCounts.length < 1 || value.threadCounts.length > 4 ||
			Object.keys(value.threadCounts).length !== value.threadCounts.length ||
			new Set(value.threadCounts).size !== value.threadCounts.length ||
			value.threadCounts.some((thread: number) => !integer(thread, 1, 16))) throw new Error(`invalid bounded case ${value.id}`);
		const nnz = value.longRows * value.longNnz + (value.rows - value.longRows) * value.normalNnz;
		if (nnz < 1 || nnz > 2_000_000) throw new Error(`case ${value.id} exceeds nonzero bound`);
		// Include the first-call sample in the operation bound as well as warmups and repetitions.
		timedWork += nnz * value.threadCounts.length * (1 + value.warmups + value.repeats) * (targets.length + 2);
		return { ...value, threadCounts: [...value.threadCounts] };
	});
	if (timedWork > MAX_TIMED_WORK) throw new Error("plan exceeds total timed-work bound");
	return { names, targets, cases, checkerCandidateSource: preserved.checkerCandidateSource };
}

/** Reject ambiguous strategy registries and unsupported source shapes before generating C++. */
export function validateCsrStrategyPlan(starterSource: string, candidateSource: string,
	taskText: string, plan: CsrExperimentPlan): CsrCheckerMetadata {
	return buildCsrChecker(starterSource, candidateSource, taskText, plan).metadata;
}

export function buildCsrChecker(starterSource: string, candidateSource: string, taskText: string,
	plan: CsrExperimentPlan, candidateInclude = "candidate.cpp"): CsrChecker {
	if (!/^[A-Za-z_][A-Za-z_0-9.-]*\.cpp$/.test(candidateInclude) || candidateInclude.includes(".."))
		throw new Error("candidate include must be a local C++ basename");
	const { names, targets, cases, checkerCandidateSource } = checkedPlan(starterSource, candidateSource, taskText, plan);
	const absTolerance = requiredTolerance(starterSource, "abs_tol");
	const relTolerance = requiredTolerance(starterSource, "rel_tol");
	const metadata: CsrCheckerMetadata = {
		matrixType: names.matrixType, targets, maxStrategies: names.maxStrategies,
		baselines: { serial: names.serial, stdThread: names.stdThread },
		absTolerance, relTolerance, candidateInclude,
		threadCounts: [1, 2, 4], shapes: SHAPES, mutationPasses: 2, threadPolicy: CSR_THREAD_POLICY,
		timing: { marker: "CSR_TIMING", cases, accounting: "first-call-and-warmups-separate-from-steady-state", freshProcessPerSelection: true,
			inputValuesMutatedBetweenCalls: true, perfScope: "one-selected-kernel-plus-host-generation-and-validation",
			metric: "isolated-worker-roundtrip", startupSeparate: true, trust: "parent-clock-and-raw-output-comparison",
			baselineIsolation: "independently-compiled-immutable-original", runtimeFiles: "read-only-evaluator-with-separate-writable-scratch",
			threadsMeaning: "requested-default-and-openmp-cap", actualThreads: "not_observed" },
	};
	const caseCpp = cases.map(value => `    {"${value.id}", ${value.rows}, ${value.cols}, ${value.normalNnz}, ${value.longRows}, ${value.longNnz}, ${value.seed}u, {${value.threadCounts.join(", ")}}, ${value.warmups}, ${value.repeats}}`).join(",\n");
	const targetCpp = targets.map((name, index) => `    {"strategy", ${index + 1}, "${name}", [](const ${names.matrixType}& a, const std::vector<double>& x, std::vector<double>& y, int) { ${name}(a, x, y); }}`).join(",\n");
	const makeWorkerSource = (includedSource: string, includeName: string, studentEntries: string) =>
		`// Isolated worker: raw bounded inputs and outputs only. No trusted status or clocks.
#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cerrno>
#include <limits>
#include <stdexcept>
#include <vector>
#include <unistd.h>
#include <omp.h>
#define main csr_check_original_main
#line 1 "${includeName}"
${includedSource}
#undef main
#line 1 "csr-candidate-worker.cpp"
using WorkerFn = void (*)(const ${names.matrixType}&, const std::vector<double>&, std::vector<double>&, int);
struct WorkerEntry { const char* kind; int target; const char* name; WorkerFn call; };
static const std::vector<WorkerEntry> worker_entries = {
    {"serial", 0, "${names.serial}", [](const ${names.matrixType}& a, const std::vector<double>& x, std::vector<double>& y, int) { ${names.serial}(a, x, y); }},
    {"std_thread", 0, "${names.stdThread}", [](const ${names.matrixType}& a, const std::vector<double>& x, std::vector<double>& y, int threads) { ${names.stdThread}(a, x, y, threads); }},
${studentEntries}
};
static bool worker_read(void* buffer, std::size_t size, bool allow_eof = false) {
    auto* bytes = static_cast<unsigned char*>(buffer); std::size_t done = 0;
    while (done < size) {
        const auto count = ::read(STDIN_FILENO, bytes + done, size - done);
        if (count == 0 && !done && allow_eof) return false;
        if (count < 0 && errno == EINTR) continue;
        if (count <= 0) throw std::runtime_error("incomplete worker input");
        done += static_cast<std::size_t>(count);
    }
    return true;
}
static void worker_write(const void* buffer, std::size_t size) {
    const auto* bytes = static_cast<const unsigned char*>(buffer); std::size_t done = 0;
    while (done < size) {
        const auto count = ::write(STDOUT_FILENO, bytes + done, size - done);
        if (count < 0 && errno == EINTR) continue;
        if (count <= 0) throw std::runtime_error("worker output failed");
        done += static_cast<std::size_t>(count);
    }
}
int main(int argc, char** argv) {
    try {
        if (argc != 2) return 2;
        const int index = std::stoi(argv[1]);
        if (index < 0 || index >= static_cast<int>(worker_entries.size())) return 2;
        const unsigned char ready = 82; worker_write(&ready, 1);
        for (;;) {
            std::uint32_t header[5];
            if (!worker_read(header, sizeof(header), true)) break;
            const auto rows = header[1], cols = header[2], nnz = header[3], threads = header[4];
            if (header[0] != 0x43535231u || rows < 1 || rows > ${CSR_EXPERIMENT_LIMITS.maxRows} ||
                cols < 1 || cols > ${CSR_EXPERIMENT_LIMITS.maxCols} || nnz > ${CSR_EXPERIMENT_LIMITS.maxNnz} ||
                threads < 1 || threads > ${CSR_EXPERIMENT_LIMITS.maxThreads}) return 2;
            ${names.matrixType} a;
            a.${names.matrixFields.rows} = static_cast<int>(rows); a.${names.matrixFields.cols} = static_cast<int>(cols);
            a.${names.matrixFields.offsets}.resize(rows + 1); a.${names.matrixFields.columns}.resize(nnz); a.${names.matrixFields.values}.resize(nnz);
            std::vector<double> x(cols), y(rows, std::numeric_limits<double>::quiet_NaN());
            worker_read(a.${names.matrixFields.offsets}.data(), (rows + 1) * sizeof(int));
            worker_read(a.${names.matrixFields.columns}.data(), nnz * sizeof(int));
            worker_read(a.${names.matrixFields.values}.data(), nnz * sizeof(double));
            worker_read(x.data(), cols * sizeof(double));
            if (a.${names.matrixFields.offsets}.front() != 0 || a.${names.matrixFields.offsets}.back() != static_cast<int>(nnz)) return 2;
            for (std::size_t i = 1; i < a.${names.matrixFields.offsets}.size(); ++i)
                if (a.${names.matrixFields.offsets}[i] < a.${names.matrixFields.offsets}[i - 1]) return 2;
            for (const int col : a.${names.matrixFields.columns}) if (col < 0 || col >= static_cast<int>(cols)) return 2;
            const auto prior = a; const auto prior_x = x;
            const auto* y_address = y.data();
            omp_set_dynamic(0); omp_set_max_active_levels(1); omp_set_num_threads(static_cast<int>(threads));
            worker_entries[static_cast<std::size_t>(index)].call(a, x, y, static_cast<int>(threads));
            if (a.${names.matrixFields.rows} != prior.${names.matrixFields.rows} || a.${names.matrixFields.cols} != prior.${names.matrixFields.cols} ||
                a.${names.matrixFields.offsets} != prior.${names.matrixFields.offsets} || a.${names.matrixFields.columns} != prior.${names.matrixFields.columns} ||
                a.${names.matrixFields.values} != prior.${names.matrixFields.values} || x != prior_x || y.size() != rows || y.data() != y_address) return 3;
            // Only raw values leave this worker. They are untrusted until the parent compares every row.
            worker_write(y.data(), rows * sizeof(double));
        }
        return 0;
    } catch (...) { return 2; }
}
`;
	const workerSource = makeWorkerSource(checkerCandidateSource, candidateInclude, targetCpp);
	const baselineWorkerSource = makeWorkerSource(starterSource, "immutable-original.cpp", "");
	const source = `// Generated from private inputs; compile with OpenMP and pthread support.
#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <iostream>
#include <limits>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>
#include <omp.h>
#include <cerrno>
#include <csignal>
#include <set>
#include <fcntl.h>
#include <poll.h>
#include <sys/prctl.h>
#include <sys/resource.h>
#include <sys/syscall.h>
#include <sys/wait.h>
#include <unistd.h>
#define main csr_check_original_main
#line 1 "immutable-original.cpp"
${starterSource}
#undef main
#line 1 "trusted-csr-checker.cpp"

static_assert(sizeof(${names.matrixType}) > 0, "derived CSR type must exist");
struct CheckerEntry { const char* kind; int target; const char* name; int worker_index; };
struct CheckerCase {
    const char* id; int rows, cols, ordinary_nnz, heavy_rows, heavy_nnz; unsigned seed;
    std::vector<int> threads; int warmups, repeats;
};
static const std::vector<CheckerEntry> checker_entries = {
    {"serial", 0, "${names.serial}", 0}, {"std_thread", 0, "${names.stdThread}", 1},
${targets.map((name, index) => `    {"strategy", ${index + 1}, "${name}", ${index + 2}}`).join(",\n")}
};
static const std::vector<CheckerCase> checker_cases = {
${caseCpp}
};

// This process contains only immutable source. Candidate code runs after exec in a separate address space.
class CheckerWorker {
    pid_t pid = -1; int input = -1, output = -1;
    static void transfer(int fd, void* buffer, std::size_t bytes, bool writing) {
        auto* data = static_cast<unsigned char*>(buffer); std::size_t done = 0;
        const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(15);
        while (done < bytes) {
            if (std::chrono::steady_clock::now() > deadline) throw std::runtime_error("worker protocol deadline exceeded");
            struct pollfd descriptor { fd, static_cast<short>(writing ? POLLOUT : POLLIN), 0 };
            const int polled = ::poll(&descriptor, 1, 1000);
            if (polled < 0 && errno == EINTR) continue;
            if (polled < 0) throw std::runtime_error("worker protocol poll failed");
            if (!polled) continue;
            const auto count = writing ? ::write(fd, data + done, bytes - done) : ::read(fd, data + done, bytes - done);
            if (count < 0 && (errno == EINTR || errno == EAGAIN)) continue;
            if (count <= 0) throw std::runtime_error("worker protocol incomplete or worker rejected input/output mutation");
            done += static_cast<std::size_t>(count);
        }
    }
    void send(const void* buffer, std::size_t bytes) { transfer(input, const_cast<void*>(buffer), bytes, true); }
public:
    std::int64_t startup_ns = 0;
    explicit CheckerWorker(int index, int requested_threads) {
        if (requested_threads < 1 || requested_threads > ${CSR_EXPERIMENT_LIMITS.maxThreads})
            throw std::runtime_error("requested OpenMP thread budget is outside the execution cap");
        const auto started = std::chrono::steady_clock::now();
        int to_worker[2], from_worker[2];
        if (::pipe2(to_worker, O_CLOEXEC) || ::pipe2(from_worker, O_CLOEXEC)) throw std::runtime_error("worker pipes unavailable");
        const std::string target = std::to_string(index);
        const std::string thread_limit = std::to_string(requested_threads);
        const char* binary = index < 2 ? "./baseline-worker" : "./candidate-worker";
        pid = ::fork();
        if (pid == 0) {
            if (::prctl(PR_SET_PDEATHSIG, SIGKILL) != 0 || ::getppid() == 1) ::_exit(126);
            const struct rlimit memory_limit { 2ull * 1024 * 1024 * 1024, 2ull * 1024 * 1024 * 1024 };
            const struct rlimit cpu_limit { 60, 60 }, core_limit { 0, 0 };
            if (::setrlimit(RLIMIT_AS, &memory_limit) || ::setrlimit(RLIMIT_CPU, &cpu_limit) ||
                ::setrlimit(RLIMIT_CORE, &core_limit) || ::prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0)) ::_exit(126);
            // Set the OpenMP contention-group cap before the runtime is loaded by exec.
            if (::setenv("OMP_THREAD_LIMIT", thread_limit.c_str(), 1) ||
                ::setenv("OMP_NUM_THREADS", thread_limit.c_str(), 1) ||
                ::setenv("OMP_DYNAMIC", "FALSE", 1) || ::setenv("OMP_MAX_ACTIVE_LEVELS", "1", 1)) ::_exit(126);
            if (::dup2(to_worker[0], STDIN_FILENO) < 0 || ::dup2(from_worker[1], STDOUT_FILENO) < 0) ::_exit(126);
            if (::syscall(SYS_close_range, 3u, ~0u, 0u) != 0) ::_exit(126);
            ::execl(binary, binary, target.c_str(), static_cast<char*>(nullptr));
            ::_exit(127);
        }
        ::close(to_worker[0]); ::close(from_worker[1]);
        input = to_worker[1]; output = from_worker[0];
        if (pid < 0) { cleanup(); throw std::runtime_error("worker process unavailable"); }
        if (::fcntl(input, F_SETFL, O_NONBLOCK) < 0 || ::fcntl(output, F_SETFL, O_NONBLOCK) < 0) {
            cleanup(); throw std::runtime_error("worker pipe bounds unavailable");
        }
        try {
            unsigned char ready = 0; transfer(output, &ready, 1, false);
            if (ready != 82) throw std::runtime_error("invalid worker startup protocol");
            startup_ns = std::chrono::duration_cast<std::chrono::nanoseconds>(std::chrono::steady_clock::now() - started).count();
        } catch (...) { cleanup(); throw; }
    }
    CheckerWorker(const CheckerWorker&) = delete;
    CheckerWorker& operator=(const CheckerWorker&) = delete;
    ~CheckerWorker() { cleanup(); }
    void cleanup() {
        if (input >= 0) { ::close(input); input = -1; }
        if (output >= 0) { ::close(output); output = -1; }
        if (pid > 0) { ::kill(pid, SIGKILL); int status = 0; while (::waitpid(pid, &status, 0) < 0 && errno == EINTR) {} pid = -1; }
    }
    void finish() {
        ::close(input); input = -1;
        const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(15);
        for (;;) {
            if (std::chrono::steady_clock::now() > deadline) throw std::runtime_error("worker shutdown deadline exceeded");
            struct pollfd descriptor { output, POLLIN, 0 }; const int polled = ::poll(&descriptor, 1, 1000);
            if (polled < 0 && errno == EINTR) continue;
            if (polled < 0) throw std::runtime_error("worker shutdown poll failed");
            if (!polled) continue;
            unsigned char extra; const auto count = ::read(output, &extra, 1);
            if (count < 0 && (errno == EINTR || errno == EAGAIN)) continue;
            if (count != 0) throw std::runtime_error("worker returned excess raw output");
            break;
        }
        ::close(output); output = -1;
        int status = 0;
        for (;;) {
            const auto waited = ::waitpid(pid, &status, WNOHANG);
            if (waited == pid) break;
            if (waited < 0 && errno != EINTR) throw std::runtime_error("worker status unavailable");
            if (std::chrono::steady_clock::now() > deadline) throw std::runtime_error("worker exit deadline exceeded");
            ::poll(nullptr, 0, 1);
        }
        pid = -1;
        if (!WIFEXITED(status) || WEXITSTATUS(status) != 0) throw std::runtime_error("worker failed after output");
    }
    void call(const ${names.matrixType}& a, const std::vector<double>& x, std::vector<double>& y, int threads) {
        const std::uint32_t header[] = { 0x43535231u, static_cast<std::uint32_t>(a.${names.matrixFields.rows}),
            static_cast<std::uint32_t>(a.${names.matrixFields.cols}), static_cast<std::uint32_t>(a.${names.matrixFields.values}.size()), static_cast<std::uint32_t>(threads) };
        send(header, sizeof(header));
        send(a.${names.matrixFields.offsets}.data(), a.${names.matrixFields.offsets}.size() * sizeof(int));
        send(a.${names.matrixFields.columns}.data(), a.${names.matrixFields.columns}.size() * sizeof(int));
        send(a.${names.matrixFields.values}.data(), a.${names.matrixFields.values}.size() * sizeof(double));
        send(x.data(), x.size() * sizeof(double));
        transfer(output, y.data(), y.size() * sizeof(double), false);
    }
};

static ${names.matrixType} checker_small_matrix(int rows, int cols) {
    ${names.matrixType} matrix;
    matrix.${names.matrixFields.rows} = rows; matrix.${names.matrixFields.cols} = cols;
    matrix.${names.matrixFields.offsets}.assign(static_cast<std::size_t>(rows) + 1, 0);
    for (int row = 0; row < rows; ++row) {
        const int count = row % 7 == 0 && rows > 1 ? 0 : row % 5 == 0 ? 31 : 1 + (row * 3) % 6;
        for (int slot = 0; slot < count; ++slot) {
            matrix.${names.matrixFields.columns}.push_back((row * 13 + slot * 7 + slot * slot) % cols);
            matrix.${names.matrixFields.values}.push_back(static_cast<double>((row * 17 + slot * 11) % 29 - 14) / 13.0);
        }
        matrix.${names.matrixFields.offsets}[static_cast<std::size_t>(row) + 1] = static_cast<int>(matrix.${names.matrixFields.values}.size());
    }
    return matrix;
}
static ${names.matrixType} checker_case_matrix(const CheckerCase& c) {
    ${names.optionsType} options;
    options.${names.optionFields[0]} = c.rows; options.${names.optionFields[1]} = c.cols;
    options.${names.optionFields[2]} = c.ordinary_nnz;
    options.${names.optionFields[3]} = c.heavy_rows; options.${names.optionFields[4]} = c.heavy_nnz;
    options.${names.seedField} = c.seed;
    return ${names.matrixGenerator}(options);
}
static std::vector<double> checker_case_vector(const CheckerCase& c) {
    return ${names.vectorGenerator}(c.cols, c.seed);
}
static std::vector<double> checker_small_vector(int cols) {
    std::vector<double> x(static_cast<std::size_t>(cols));
    for (int col = 0; col < cols; ++col)
        x[static_cast<std::size_t>(col)] = static_cast<double>((col * 19) % 31 - 15) / 17.0;
    return x;
}
// This row oracle is independent of all candidate functions, including the original serial function.
static std::vector<double> checker_reference(const ${names.matrixType}& a, const std::vector<double>& x) {
    std::vector<double> expected(static_cast<std::size_t>(a.${names.matrixFields.rows}));
    for (int row = 0; row < a.${names.matrixFields.rows}; ++row) {
        double sum = 0.0;
        for (int p = a.${names.matrixFields.offsets}[row]; p < a.${names.matrixFields.offsets}[row + 1]; ++p)
            sum += a.${names.matrixFields.values}[static_cast<std::size_t>(p)] * x[static_cast<std::size_t>(a.${names.matrixFields.columns}[static_cast<std::size_t>(p)])];
        expected[static_cast<std::size_t>(row)] = sum;
    }
    return expected;
}
static void checker_mutate(${names.matrixType}& a, std::vector<double>& x, int pass) {
    for (std::size_t p = 0; p < a.${names.matrixFields.values}.size(); ++p)
        a.${names.matrixFields.values}[p] = pass == 1 ? a.${names.matrixFields.values}[p] * -0.75 + static_cast<double>(static_cast<int>(p % 5) - 2) / 17.0
                                : a.${names.matrixFields.values}[p] * 0.5 + static_cast<double>(static_cast<int>(p % 7) - 3) / 19.0;
    for (std::size_t j = 0; j < x.size(); ++j)
        x[j] = pass == 1 ? x[j] * 1.25 - static_cast<double>(static_cast<int>(j % 7) - 3) / 23.0
                         : -x[j] + static_cast<double>(static_cast<int>(j % 5) - 2) / 29.0;
}
static void checker_validate(CheckerWorker& worker, const CheckerEntry& entry, ${names.matrixType}& a, std::vector<double>& x,
                             std::vector<double>& y, int threads, const char* phase) {
    const auto expected = checker_reference(a, x);
    const auto prior_values = a.${names.matrixFields.values}; const auto prior_x = x;
    const auto prior_rows = a.${names.matrixFields.offsets}; const auto prior_cols = a.${names.matrixFields.columns};
    const auto* value_address = a.${names.matrixFields.values}.data(); const auto* x_address = x.data();
    const auto* output_address = y.data();
    const int rows = a.${names.matrixFields.rows}, cols = a.${names.matrixFields.cols};
    std::fill(y.begin(), y.end(), std::numeric_limits<double>::quiet_NaN());
    omp_set_dynamic(0); omp_set_max_active_levels(1); omp_set_num_threads(threads);
    worker.call(a, x, y, threads);
    if (a.${names.matrixFields.rows} != rows || a.${names.matrixFields.cols} != cols || y.size() != static_cast<std::size_t>(rows) ||
        a.${names.matrixFields.values}.data() != value_address || x.data() != x_address || y.data() != output_address ||
        a.${names.matrixFields.values} != prior_values || x != prior_x || a.${names.matrixFields.offsets} != prior_rows || a.${names.matrixFields.columns} != prior_cols)
        throw std::runtime_error(std::string(entry.name) + ": changed input or output buffer during " + phase);
    for (int row = 0; row < rows; ++row) {
        const double actual = y[static_cast<std::size_t>(row)], wanted = expected[static_cast<std::size_t>(row)];
        const double error = std::abs(wanted - actual), scale = std::max(1.0, std::abs(wanted));
        if (!std::isfinite(wanted) || !std::isfinite(actual) || error > ${absTolerance} + ${relTolerance} * scale)
            throw std::runtime_error(std::string(entry.name) + ": mismatch/nonfinite/unwritten row=" +
                std::to_string(row) + " shape=" + std::to_string(rows) + "x" + std::to_string(cols) +
                " threads=" + std::to_string(threads) + " phase=" + phase);
    }
    if (!${names.resultChecker}(expected, y)) throw std::runtime_error(std::string(entry.name) + ": original checker rejected output");
}
static void checker_correctness(CheckerWorker& worker, const CheckerEntry& entry, ${names.matrixType} a,
                                std::vector<double> x, int threads) {
    std::vector<double> y(static_cast<std::size_t>(a.${names.matrixFields.rows}));
    for (int pass = 0; pass < 3; ++pass) {
        if (pass) checker_mutate(a, x, pass);
        checker_validate(worker, entry, a, x, y, threads, pass == 0 ? "original" : "mutated");
    }
}
struct CheckerTiming { std::int64_t startup_ns = 0, cold_ns = 0; std::vector<std::int64_t> warmups, samples; };
static CheckerTiming checker_time(const CheckerEntry& entry, const CheckerCase& c, int threads) {
    CheckerWorker worker(entry.worker_index, threads);
    ${names.matrixType} a = checker_case_matrix(c);
    std::vector<double> x = checker_case_vector(c), y(static_cast<std::size_t>(c.rows));
    CheckerTiming timing; timing.startup_ns = worker.startup_ns;
    timing.samples.reserve(static_cast<std::size_t>(c.repeats));
    for (int rep = -c.warmups - 1; rep < c.repeats; ++rep) {
        if (rep != -c.warmups - 1) checker_mutate(a, x, rep % 2 == 0 ? 1 : 2);
        const auto expected = checker_reference(a, x);
        const auto prior_values = a.${names.matrixFields.values}; const auto prior_x = x;
        const auto prior_rows = a.${names.matrixFields.offsets}; const auto prior_cols = a.${names.matrixFields.columns};
        const auto* value_address = a.${names.matrixFields.values}.data(); const auto* x_address = x.data();
        const auto* output_address = y.data();
        std::fill(y.begin(), y.end(), std::numeric_limits<double>::quiet_NaN());
        omp_set_dynamic(0); omp_set_max_active_levels(1); omp_set_num_threads(threads);
        const auto start = std::chrono::steady_clock::now();
        worker.call(a, x, y, threads);
        const auto stop = std::chrono::steady_clock::now();
        if (a.${names.matrixFields.rows} != c.rows || a.${names.matrixFields.cols} != c.cols || y.size() != static_cast<std::size_t>(c.rows) ||
            a.${names.matrixFields.values}.data() != value_address || x.data() != x_address || y.data() != output_address ||
            a.${names.matrixFields.values} != prior_values || x != prior_x || a.${names.matrixFields.offsets} != prior_rows || a.${names.matrixFields.columns} != prior_cols)
            throw std::runtime_error(std::string(entry.name) + ": changed input or output buffer during timing");
        for (int row = 0; row < c.rows; ++row) {
            const double actual = y[static_cast<std::size_t>(row)], wanted = expected[static_cast<std::size_t>(row)];
            const double error = std::abs(wanted - actual), scale = std::max(1.0, std::abs(wanted));
            if (!std::isfinite(wanted) || !std::isfinite(actual) || error > ${absTolerance} + ${relTolerance} * scale)
                throw std::runtime_error(std::string(entry.name) + ": timed mismatch row=" + std::to_string(row));
        }
        if (!${names.resultChecker}(expected, y)) throw std::runtime_error(std::string(entry.name) + ": original checker rejected timed output");
        const auto elapsed = std::chrono::duration_cast<std::chrono::nanoseconds>(stop - start).count();
        if (elapsed <= 0) throw std::runtime_error("nonpositive monotonic-clock duration");
        if (rep == -c.warmups - 1) timing.cold_ns = elapsed;
        else if (rep < 0) timing.warmups.push_back(elapsed);
        else timing.samples.push_back(elapsed);
    }
    worker.finish();
    return timing;
}
static void checker_emit(const CheckerEntry& entry, const CheckerCase& c, int threads,
                         const CheckerTiming& timing) {
    const auto& samples = timing.samples;
    auto sorted = samples;
    std::sort(sorted.begin(), sorted.end());
    const auto median = sorted.size() % 2 ? sorted[sorted.size() / 2]
        : (sorted[sorted.size() / 2 - 1] + sorted[sorted.size() / 2]) / 2;
    std::cout << "CSR_TIMING case=" << c.id << " kind=" << entry.kind << " target=" << entry.target
              << " name=" << entry.name << " rows=" << c.rows << " cols=" << c.cols
              << " ordinary_nnz=" << c.ordinary_nnz << " heavy_rows=" << c.heavy_rows
              << " heavy_nnz=" << c.heavy_nnz << " seed=" << c.seed << " threads=" << threads
              << " warmups=" << c.warmups << " repeats=" << c.repeats
              << " min_ns=" << sorted.front() << " median_ns=" << median
              << " max_ns=" << sorted.back() << " startup_ns=" << timing.startup_ns << " cold_ns=" << timing.cold_ns << " warmup_samples_ns=";
    for (std::size_t i = 0; i < timing.warmups.size(); ++i) std::cout << (i ? "," : "") << timing.warmups[i];
    std::cout << " samples_ns=";
    for (std::size_t i = 0; i < samples.size(); ++i) std::cout << (i ? "," : "") << samples[i];
    std::cout << '\\n';
}
int main(int argc, char** argv) {
    try {
        // Fail closed unless the candidate process cannot inspect this parent through /proc or ptrace.
        if (::prctl(PR_SET_DUMPABLE, 0) != 0) throw std::runtime_error("parent memory boundary unavailable");
        ::signal(SIGPIPE, SIG_IGN);
        const bool check_only = argc == 1 || (argc == 2 && std::string(argv[1]) == "--check");
        const CheckerCase* selected_case = nullptr;
        const CheckerEntry* selected_entry = nullptr;
        int selected_threads = 0;
        if (argc != 1 && argc != 5 && !check_only) throw std::invalid_argument("expected --check or --timing case kind:target threads");
        if (argc == 5) {
            if (std::string(argv[1]) != "--timing") throw std::invalid_argument("unknown checker option");
            for (const auto& c : checker_cases) if (c.id == std::string(argv[2])) selected_case = &c;
            for (const auto& entry : checker_entries)
                if (std::string(entry.kind) + ":" + std::to_string(entry.target) == argv[3]) selected_entry = &entry;
            const std::string thread_text = argv[4];
            for (const auto& c : checker_cases) if (&c == selected_case)
                for (int threads : c.threads) if (thread_text == std::to_string(threads)) selected_threads = threads;
            if (!selected_case || !selected_entry || !selected_threads) throw std::invalid_argument("unknown timing selection");
        }
        if (!check_only) for (const auto& c : checker_cases) {
            if (selected_case && selected_case != &c) continue;
            for (int threads : c.threads) {
                if (selected_threads && selected_threads != threads) continue;
                for (const auto& entry : checker_entries) {
                    if (selected_entry && selected_entry != &entry) continue;
                    checker_emit(entry, c, threads, checker_time(entry, c, threads));
                }
            }
        }
        if (!selected_entry) {
        std::set<int> checked_thread_budgets {1, 2, 4};
        for (const auto& c : checker_cases) for (const int threads : c.threads) checked_thread_budgets.insert(threads);
        for (const auto& entry : checker_entries) {
          for (const int threads : checked_thread_budgets) {
            CheckerWorker worker(entry.worker_index, threads);
            for (const auto& shape : std::vector<std::pair<int, int>>{{1, 1}, {7, 5}, {19, 23}, {32, 11}})
                if (threads == 1 || threads == 2 || threads == 4)
                    checker_correctness(worker, entry, checker_small_matrix(shape.first, shape.second),
                        checker_small_vector(shape.second), threads);
            for (const auto& c : checker_cases) {
                if (std::find(c.threads.begin(), c.threads.end(), threads) == c.threads.end()) continue;
                const auto a = checker_case_matrix(c); const auto x = checker_case_vector(c);
                checker_correctness(worker, entry, a, x, threads);
            }
            worker.finish();
          }
        }
        }
        std::cout << "CSR_CHECK_PASS\\n";
        return 0;
    } catch (const std::exception& error) {
        std::cerr << error.what() << '\\n';
        return 1;
    }
}
`;
	return { source, workerSource, baselineWorkerSource, metadata };
}
