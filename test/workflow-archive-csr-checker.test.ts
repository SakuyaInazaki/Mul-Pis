import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildCsrChecker, CsrValidationError, CSR_EXPERIMENT_LIMITS, getCsrValidationDiagnostic, inspectCsrTaskContract, validateCsrCandidateSource, validateCsrTargetBodies, type CsrExperimentPlan } from "../src/workflow-archive/csr-checker.ts";

// Synthetic source only. Private task inputs and strategy implementations are never fixtures.
const task = "Register at most toy_strategy_5; original functions are toy_strategy_1 and toy_strategy_2.";
const plan: CsrExperimentPlan = {
	registeredStrategies: ["toy_strategy_1", "toy_strategy_2", "toy_strategy_3"],
	cases: [{ id: "skew_a", rows: 19, cols: 23, normalNnz: 2, longRows: 2, longNnz: 13,
		seed: 11, threadCounts: [1, 2], warmups: 1, repeats: 3 }],
};
function starter(): string {
	return `#include <algorithm>
#include <cmath>
#include <cstdint>
#include <iostream>
#include <limits>
#include <string>
#include <thread>
#include <vector>
struct ToyCompressedRows {
  int height = 0;
  int width = 0;
  std::vector<int> offsets;
  std::vector<int> columns;
  std::vector<double> weights;
};
struct ToyOptions {
  int height = 1;
  int width = 1;
  int ordinary_width = 1;
  int special_count = 0;
  int special_width = 0;
  int workers = 1;
  int trials = 1;
  unsigned random_seed = 0;
};
static ToyCompressedRows toy_matrix(const ToyOptions& options) {
  ToyCompressedRows a; a.height = options.height; a.width = options.width;
  a.offsets.assign(options.height + 1, 0);
  for (int r = 0; r < options.height; ++r) {
    const int count = r < options.special_count ? options.special_width : options.ordinary_width;
    for (int k = 0; k < count; ++k) {
      a.columns.push_back((r * 7 + k * 3 + options.random_seed) % options.width);
      a.weights.push_back(static_cast<double>((r + k) % 7 - 3) / 5.0);
    }
    a.offsets[r + 1] = static_cast<int>(a.weights.size());
  }
  return a;
}
static std::vector<double> toy_vector(int size, unsigned seed) {
  std::vector<double> x(size);
  for (int k = 0; k < size; ++k) x[k] = static_cast<double>((k + seed) % 9 - 4) / 7.0;
  return x;
}
static void toy_serial(const ToyCompressedRows& a, const std::vector<double>& x, std::vector<double>& y) {
  for (int r = 0; r < a.height; ++r) {
    double sum = 0;
    for (int p = a.offsets[r]; p < a.offsets[r+1]; ++p) sum += a.weights[p] * x[a.columns[p]];
    y[r] = sum;
  }
}
static void toy_thread(const ToyCompressedRows& a, const std::vector<double>& x, std::vector<double>& y, int threads) {
  std::vector<std::thread> workers;
  for (int t = 0; t < threads; ++t) workers.emplace_back([&, t]() {
    for (int r = t; r < a.height; r += threads) {
      double sum = 0;
      for (int p = a.offsets[r]; p < a.offsets[r+1]; ++p) sum += a.weights[p] * x[a.columns[p]];
      y[r] = sum;
    }
  });
  for (auto& worker : workers) worker.join();
}
// TODO 1: fill in first strategy.
static void toy_strategy_1(const ToyCompressedRows& a, const std::vector<double>& x, std::vector<double>& y) {
  toy_serial(a, x, y);
}
// TODO 2: fill in second strategy.
static void toy_strategy_2(const ToyCompressedRows& a, const std::vector<double>& x, std::vector<double>& y) {
  toy_serial(a, x, y);
}
static bool toy_check(const std::vector<double>& expected, const std::vector<double>& actual,
                      double abs_tol = 1e-10, double rel_tol = 1e-10) { return expected == actual; }
int main() { return 0; }
`;
}
function candidate(body = "toy_serial(a, x, y);"): string {
	return `${starter()}
static void toy_strategy_3(const ToyCompressedRows& a, const std::vector<double>& x, std::vector<double>& y) {
  ${body}
}
`;
}
function fiveStrategies(): string {
	return `${candidate()}
static void toy_strategy_4(const ToyCompressedRows& a, const std::vector<double>& x, std::vector<double>& y) {
  toy_serial(a, x, y);
}
static void toy_strategy_5(const ToyCompressedRows& a, const std::vector<double>& x, std::vector<double>& y) {
  toy_serial(a, x, y);
}
`;
}
async function compiledCheck(source: string, args: string[] = [], selectedPlan = plan, selections: string[][] = [], workerOverride?: string) {
	const root = await mkdtemp(path.join(os.tmpdir(), "csr-checker-synthetic-"));
	try {
		const checker = buildCsrChecker(starter(), source, task, selectedPlan);
		await writeFile(path.join(root, "checker.cpp"), checker.source);
		await writeFile(path.join(root, "candidate.cpp"), source);
		await writeFile(path.join(root, "worker.cpp"), workerOverride ?? checker.workerSource);
		await writeFile(path.join(root, "baseline-worker.cpp"), checker.baselineWorkerSource);
		const baselineCompile = spawnSync("g++", ["-std=c++17", "-fopenmp", "-O2", "-pthread", "baseline-worker.cpp", "-o", "baseline-worker"],
			{ cwd: root, encoding: "utf8", timeout: 20_000 });
		if (baselineCompile.status !== 0) return { compile: baselineCompile, run: undefined, runs: [] };
		const workerCompile = spawnSync("g++", ["-std=c++17", "-fopenmp", "-O2", "-pthread", "worker.cpp", "-o", "candidate-worker"],
			{ cwd: root, encoding: "utf8", timeout: 20_000 });
		if (workerCompile.status !== 0) return { compile: workerCompile, run: undefined, runs: [] };
		const compile = spawnSync("g++", ["-std=c++17", "-fopenmp", "-O2", "-pthread", "checker.cpp", "-o", "check"],
			{ cwd: root, encoding: "utf8", timeout: 20_000 });
		if (compile.status !== 0) return { compile, run: undefined, runs: [] };
		return { compile, run: spawnSync(path.join(root, "check"), args,
			{ cwd: root, encoding: "utf8", timeout: 10_000 }),
			runs: selections.map(selection => spawnSync(path.join(root, "check"), selection,
				{ cwd: root, encoding: "utf8", timeout: 10_000 })) };
	} finally { await rm(root, { recursive: true, force: true }); }
}

test("checker derives bounded registry and model-authored cases", () => {
	const result = buildCsrChecker(starter(), candidate(), task, plan);
	assert.equal(result.metadata.matrixType, "ToyCompressedRows");
	assert.deepEqual(result.metadata.targets, plan.registeredStrategies);
	assert.equal(result.metadata.maxStrategies, 5);
	assert.deepEqual(result.metadata.baselines, { serial: "toy_serial", stdThread: "toy_thread" });
	assert.deepEqual(result.metadata.timing.cases, plan.cases);
	assert.match(result.workerSource, /#line 1 "candidate\.cpp"/);
	assert.match(result.source, /#line 1 "immutable-original\.cpp"/);
	assert.doesNotMatch(result.source, /static void toy_strategy_3/);
	assert.equal(result.metadata.timing.metric, "isolated-worker-roundtrip");
	assert.doesNotMatch(result.source, /#include "candidate\.cpp"/);
	assert.throws(() => buildCsrChecker(starter(), candidate(), task, plan, "../outside.cpp"));
	assert.throws(() => buildCsrChecker(starter(), candidate(), task, { ...plan, registeredStrategies: ["toy_strategy_1", "toy_strategy_2"] }));
	assert.throws(() => buildCsrChecker(starter(), candidate(), task, { ...plan, registeredStrategies: ["toy_strategy_1", "toy_strategy_3"] }));
	assert.throws(() => buildCsrChecker(starter(), candidate(), "no upper bound", plan));
	assert.throws(() => buildCsrChecker(starter(), candidate(),
		"Register at most toy_strategy_3. toy_strategy_5 is disallowed.",
		{ ...plan, registeredStrategies: [...plan.registeredStrategies, "toy_strategy_4", "toy_strategy_5"] }));
	assert.equal(buildCsrChecker(starter(), candidate(),
		"Register at most toy_strategy_3. toy_strategy_5 is disallowed.", plan).metadata.maxStrategies, 3);
	assert.throws(() => buildCsrChecker(starter(), candidate(), task, { ...plan, cases: [{ ...plan.cases[0], repeats: 500 }] }));
});

test("independent checker times serial, std::thread, and every registered strategy", async t => {
	if (spawnSync("g++", ["--version"]).error) { t.skip("g++ unavailable"); return; }
	const selections = ["serial:0", "std_thread:0", "strategy:1", "strategy:2", "strategy:3"].flatMap(selector =>
		[1, 2].map(thread => ["--timing", "skew_a", selector, String(thread)]));
	const result = await compiledCheck(candidate(), ["--check"], plan, selections);
	assert.equal(result.compile.status, 0, String(result.compile.stderr));
	assert.equal(result.run?.status, 0, String(result.run?.stderr));
	assert.equal(result.run?.stdout, "CSR_CHECK_PASS\n");
	assert.equal(result.runs.length, 10);
	const lines = result.runs.map(run => {
		assert.equal(run.status, 0, String(run.stderr));
		assert.equal(run.stdout.trim().split("\n").at(-1), "CSR_CHECK_PASS");
		return run.stdout.trim().split("\n")[0];
	});
	for (const line of lines) {
		assert.match(line, /^CSR_TIMING case=skew_a kind=(serial|std_thread|strategy) target=[0-3] name=toy_[a-z0-9_]+ rows=19 cols=23 ordinary_nnz=2 heavy_rows=2 heavy_nnz=13 seed=11 threads=[12] warmups=1 repeats=3 min_ns=\d+ median_ns=\d+ max_ns=\d+ startup_ns=\d+ cold_ns=\d+ warmup_samples_ns=\d+ samples_ns=\d+,\d+,\d+$/);
	}
	assert.ok(lines.some(line => line.includes("kind=strategy target=3 name=toy_strategy_3")));
});

test("single-strategy timing selection emits one host record after validation", async t => {
	if (spawnSync("g++", ["--version"]).error) { t.skip("g++ unavailable"); return; }
	const result = await compiledCheck(candidate(), ["--timing", "skew_a", "strategy:3", "2"]);
	assert.equal(result.compile.status, 0, String(result.compile.stderr));
	assert.equal(result.run?.status, 0, String(result.run?.stderr));
	const lines = String(result.run?.stdout).trim().split("\n");
	assert.equal(lines.length, 2);
	assert.match(lines[0], /^CSR_TIMING case=skew_a kind=strategy target=3 name=toy_strategy_3 .* threads=2 /);
	assert.equal(lines[1], "CSR_CHECK_PASS");
});

test("checker covers every permitted registered strategy through the task maximum", async t => {
	if (spawnSync("g++", ["--version"]).error) { t.skip("g++ unavailable"); return; }
	const all: CsrExperimentPlan = { ...plan,
		registeredStrategies: [...plan.registeredStrategies, "toy_strategy_4", "toy_strategy_5"] };
	const result = await compiledCheck(fiveStrategies(), ["--check"], all,
		[["--timing", "skew_a", "strategy:5", "1"]]);
	assert.equal(result.compile.status, 0, String(result.compile.stderr));
	assert.equal(result.run?.status, 0, String(result.run?.stderr));
	const lines = String(result.run?.stdout).trim().split("\n");
	assert.deepEqual(lines, ["CSR_CHECK_PASS"]);
	assert.equal(result.runs[0]?.status, 0);
	assert.match(String(result.runs[0]?.stdout), /kind=strategy target=5 name=toy_strategy_5/);
});

test("new strategy cannot pass with stale, nonfinite, or unwritten output", async t => {
	if (spawnSync("g++", ["--version"]).error) { t.skip("g++ unavailable"); return; }
	for (const body of [
		"static bool ready = false; static std::vector<double> cache; if (!ready) { toy_serial(a, x, y); cache = y; ready = true; } else y = cache;",
		"toy_serial(a, x, y); y[0] = 0.0 / 0.0;",
		"std::vector<double> temporary(y.size()); toy_serial(a, x, temporary); for (std::size_t r = 1; r < y.size(); ++r) y[r] = temporary[r];",
	]) {
		const result = await compiledCheck(candidate(body));
		assert.equal(result.compile.status, 0, String(result.compile.stderr));
		assert.equal(result.run?.status, 1);
		assert.match(String(result.run?.stderr), /toy_strategy_3: mismatch\/nonfinite\/unwritten/);
		assert.doesNotMatch(String(result.run?.stdout), /CSR_CHECK_PASS/);
	}
});

test("capability inspection is input-derived and does not create a research plan", () => {
	const contract = inspectCsrTaskContract(starter(), task);
	assert.deepEqual(contract.originalTargets, ["toy_strategy_1", "toy_strategy_2"]);
	assert.equal(contract.maxStrategies, 5);
	assert.deepEqual(contract.limits, CSR_EXPERIMENT_LIMITS);
	assert.equal("cases" in contract, false);
	assert.match(contract.sourceScope, /not a memory-safety proof/);
	assert.match(contract.timingScope, /first-call cost/i);
	assert.equal(inspectCsrTaskContract(starter(),
		"Register at most toy_strategy_3. Do not register up to toy_strategy_9. toy_strategy_15 is forbidden.").maxStrategies, 3);
	assert.throws(() => inspectCsrTaskContract(starter(), "Do not register up to toy_strategy_9."));
	assert.throws(() => inspectCsrTaskContract(starter(), "Register at most toy_strategy_3. Register up to toy_strategy_4."));
});

test("central gate preserves originals and rejects benchmark tampering and global initialization", () => {
	const attacks = [
		candidate().replace("return expected == actual;", "return true;"),
		candidate().replace("a.height = options.height", "a.height = options.height + 1"),
		candidate().replace("double sum = 0;", "double sum = 1;"),
		candidate() + "\nstatic int eager = []() { return 0; }();\n",
		candidate() + "\nstruct Boot { Boot() {} } boot;\n",
		candidate() + "\nstruct Boot { inline static int x = 7; };\n",
		candidate() + "\n#define isfinite(x) true\n",
		candidate('std::cout << "CSR_CHECK_PASS\\n"; toy_serial(a, x, y);'),
		candidate('std::exit(0);'),
		candidate('const char* p = \"CSR_CHECK_PASS\\\\n\"; while (*p) putchar_unlocked(*p++); fflush(nullptr); pthread_exit(nullptr);'),
		candidate('extern int clock_gettime(int, void*); toy_serial(a, x, y);'),
		candidate('auto x = std::chrono::steady_clock::now(); toy_serial(a, x, y);'),
		candidate('[[gnu::constructor]]; toy_serial(a, x, y);'),
		candidate('#define private public\n toy_serial(a, x, y);'),
		candidate('_Pragma("GCC optimize(\"fast-math\")") toy_serial(a, x, y);'),
		candidate('#pragma GCC optimize("fast-math")\n toy_serial(a, x, y);'),
		candidate('toy_serial(a, x, y);').replace('static void toy_strategy_3', 'void toy_strategy_3'),
	];
	for (const attack of attacks) assert.throws(() => buildCsrChecker(starter(), attack, task, plan));
	assert.throws(() => buildCsrChecker(starter(), candidate('toy_serial(a, x, y); \\\nstd::exit(0);'), task, plan));
});

test("helper functions, local preprocessing layouts, comments and main registration edits are supported", async t => {
	const helper = 'struct ToyScratch { std::vector<int> index; };\nstatic void toy_helper(const ToyCompressedRows& a, const std::vector<double>& x, std::vector<double>& y) { toy_serial(a, x, y); }\n';
	const source = candidate('/* } static void toy_strategy_9() {} */\nconst char* label = R"tag({ // } )tag";\n(void)label; ToyScratch scratch; toy_helper(a, x, y);')
		.replace('// TODO 1:', helper + '// TODO 1:')
		.replace('int main() { return 0; }', 'int main() { std::cout << "model-generated registration output"; return 7; }');
	const shape = validateCsrCandidateSource(starter(), source, task, plan.registeredStrategies);
	assert.equal(shape.targetCount, 3);
	assert.doesNotMatch(shape.checkerCandidateSource, /model-generated registration output/);
	if (spawnSync("g++", ["--version"]).error) { t.skip("g++ unavailable"); return; }
	const result = await compiledCheck(source, ["--check"]);
	assert.equal(result.compile.status, 0, String(result.compile.stderr));
	assert.equal(result.run?.status, 0, String(result.run?.stderr));
	assert.equal(result.run?.stdout, "CSR_CHECK_PASS\n");
});

test("single-target measurement invokes no other candidate strategy and records setup", async t => {
	if (spawnSync("g++", ["--version"]).error) { t.skip("g++ unavailable"); return; }
	// A deliberately bad third strategy must fail the full gate but cannot contaminate a serial-only measurement.
	const result = await compiledCheck(candidate('y[0] = std::numeric_limits<double>::infinity();'), ["--check"], plan,
		[["--timing", "skew_a", "serial:0", "1"], ["--timing", "skew_a", "strategy:3", "1"],
		 ["--timing", "skew_a", "strategy:9", "1"], ["--timing", "skew_a", "serial:0", "99"]]);
	assert.equal(result.compile.status, 0, String(result.compile.stderr));
	assert.equal(result.run?.status, 1);
	assert.equal(result.runs[0].status, 0, String(result.runs[0].stderr));
	assert.match(String(result.runs[0].stdout), /kind=serial target=0.*cold_ns=[1-9]\d* warmup_samples_ns=[1-9]\d* samples_ns=/);
	for (const run of result.runs.slice(1)) {
		assert.equal(run.status, 1);
		assert.doesNotMatch(String(run.stdout), /CSR_CHECK_PASS/);
	}
});

test("input mutation and output replacement fail independent verification", async t => {
	if (spawnSync("g++", ["--version"]).error) { t.skip("g++ unavailable"); return; }
	for (const body of [
		'toy_serial(a, x, y); const_cast<ToyCompressedRows&>(a).weights[0] += 1;',
		'toy_serial(a, x, y); std::vector<double> copy = y; y.swap(copy);',
	]) {
		const result = await compiledCheck(candidate(body), ["--check"]);
		assert.equal(result.compile.status, 0, String(result.compile.stderr));
		assert.equal(result.run?.status, 1);
		assert.match(String(result.run?.stderr), /input\/output mutation|changed input or output buffer/);
	}
});

test("bounded schema rejects extra fields, sparse arrays, invalid scalars and excessive work", () => {
	const invalidPlans = [
		{ ...plan, arbitrary: true },
		{ ...plan, cases: [{ ...plan.cases[0], rows: NaN }] },
		{ ...plan, cases: [{ ...plan.cases[0], repeats: Infinity }] },
		{ ...plan, cases: [{ ...plan.cases[0], seed: -1 }] },
		{ ...plan, cases: [{ ...plan.cases[0], threadCounts: [1, 1] }] },
		{ ...plan, cases: [{ ...plan.cases[0], id: { toString: () => "fake" } }] },
		{ ...plan, cases: new Array(2) },
		{ ...plan, cases: [{ ...plan.cases[0], rows: 20_000, cols: 200_000,
			normalNnz: 100, longRows: 0, threadCounts: [1, 2, 3, 4], repeats: 50 }] },
	];
	for (const invalid of invalidPlans) assert.throws(() => buildCsrChecker(starter(), candidate(), task, invalid as CsrExperimentPlan));
});


test("legacy lexical guard supplements its unchanged structural boundary", () => {
	validateCsrTargetBodies(starter(), starter());
	for (const body of ['std::exit(0);', 'putchar_unlocked(65);', 'pthread_exit(nullptr);', 'toy_check(y, y);',
		'#define isfinite(x) true\n toy_serial(a, x, y);']) {
		const modified = starter().replace('  toy_serial(a, x, y);', body);
		assert.throws(() => validateCsrTargetBodies(starter(), modified));
	}
});


test("trusted source contains only original code and ignores worker status text as a protocol failure", async t => {
	if (spawnSync("g++", ["--version"]).error) { t.skip("g++ unavailable"); return; }
	const generated = buildCsrChecker(starter(), candidate('const double isolated_only_marker = 1; toy_serial(a, x, y);'), task, plan);
	assert.doesNotMatch(generated.source, /isolated_only_marker/);
	assert.match(generated.workerSource, /isolated_only_marker/);
	assert.doesNotMatch(generated.baselineWorkerSource, /isolated_only_marker|static void toy_strategy_3/);
	assert.match(generated.baselineWorkerSource, /#line 1 "immutable-original\.cpp"/);
	assert.equal(generated.metadata.timing.baselineIsolation, "independently-compiled-immutable-original");
	assert.equal(generated.metadata.timing.runtimeFiles, "read-only-evaluator-with-separate-writable-scratch");
	assert.match(generated.source, /PR_SET_DUMPABLE/);
	assert.match(generated.source, /RLIMIT_AS/);
	assert.equal(generated.metadata.timing.trust, "parent-clock-and-raw-output-comparison");
	// A deliberately invalid worker fixture tests framing, not any candidate strategy.
	const malformed = '#include <unistd.h>\nint main() { const char text[] = "CSR_CHECK_PASS\\n"; write(1, text, sizeof(text) - 1); return 0; }';
	const result = await compiledCheck(candidate(), ["--check"], plan,
		[["--timing", "skew_a", "serial:0", "1"], ["--timing", "skew_a", "std_thread:0", "1"]], malformed);
	assert.equal(result.compile.status, 0, String(result.compile.stderr));
	assert.equal(result.run?.status, 1);
	assert.doesNotMatch(String(result.run?.stdout), /CSR_CHECK_PASS|CSR_TIMING/);
	assert.match(String(result.run?.stderr), /startup protocol/);
	for (const baseline of result.runs) {
		assert.equal(baseline.status, 0, String(baseline.stderr));
		assert.match(String(baseline.stdout), /^CSR_TIMING .*kind=(serial|std_thread) target=0 .*startup_ns=\d+ cold_ns=\d+/);
		assert.match(String(baseline.stdout), /CSR_CHECK_PASS\n$/);
	}
});

test("truncated raw output cannot pass parent-side comparison", async t => {
	if (spawnSync("g++", ["--version"]).error) { t.skip("g++ unavailable"); return; }
	const truncated = '#include <unistd.h>\nint main() { const char ready = 82; write(1, &ready, 1); return 0; }';
	const result = await compiledCheck(candidate(), ["--check"], plan, [], truncated);
	assert.equal(result.compile.status, 0, String(result.compile.stderr));
	assert.equal(result.run?.status, 1);
	assert.doesNotMatch(String(result.run?.stdout), /CSR_CHECK_PASS|CSR_TIMING/);
	assert.match(String(result.run?.stderr), /protocol incomplete/);
});

test("source diagnostics identify the exact construct and state that measurement never ran", () => {
	const source = candidate("#pragma omp teams thread_limit(2)\n { toy_serial(a, x, y); }");
	const offset = source.indexOf("#pragma omp teams");
	assert.throws(() => buildCsrChecker(starter(), source, task, plan), error => {
		assert.ok(error instanceof CsrValidationError);
		const diagnostic = getCsrValidationDiagnostic(error)!;
		assert.equal(diagnostic.ruleId, "source.openmp.unsupported-construct");
		assert.equal(diagnostic.disposition, "unsupported-capability");
		assert.equal(diagnostic.functionName, "toy_strategy_3");
		assert.equal(diagnostic.source.startOffset, offset);
		assert.equal(diagnostic.source.line, source.slice(0, offset).split("\n").length);
		assert.equal(diagnostic.source.column, offset - source.lastIndexOf("\n", offset) );
		assert.equal(diagnostic.directive, "#pragma omp teams thread_limit(2)");
		assert.equal(diagnostic.offendingToken, diagnostic.directive);
		assert.equal(diagnostic.compilationStatus, "not_run");
		assert.equal(diagnostic.correctnessStatus, "not_run");
		assert.equal(diagnostic.measurementStatus, "not_run");
		assert.match(diagnostic.nextAction, /capability gap/);
		assert.match(error.message, /candidate\.cpp:\d+:\d+ in toy_strategy_3/);
		assert.match(error.message, /measurement were not run/);
		return true;
	});
	assert.equal(getCsrValidationDiagnostic(new Error("unrelated")), undefined);
});

test("forbidden token and immutable-region diagnostics retain source locations", () => {
	const source = candidate("auto stamp = std::chrono::steady_clock::now(); toy_serial(a, x, y);");
	assert.throws(() => buildCsrChecker(starter(), source, task, plan), error => {
		const diagnostic = getCsrValidationDiagnostic(error)!;
		assert.equal(diagnostic.ruleId, "source.facility.forbidden-token");
		assert.equal(diagnostic.offendingToken, "chrono");
		assert.equal(diagnostic.source.startOffset, source.indexOf("chrono"));
		assert.equal(diagnostic.functionName, "toy_strategy_3");
		return true;
	});
	const changed = candidate().replace("return expected == actual;", "return false;");
	assert.throws(() => buildCsrChecker(starter(), changed, task, plan), error => {
		const diagnostic = getCsrValidationDiagnostic(error)!;
		assert.equal(diagnostic.ruleId, "source.preservation.immutable-region");
		assert.equal(diagnostic.functionName, "toy_check");
		assert.match(diagnostic.source.excerpt, /static bool toy_check/);
		return true;
	});
});

test("host parallel thread-selection and schedule clauses pass with explicit runtime caps", async t => {
	const source = candidate(`
#ifdef _OPENMP
  const int workers = omp_get_max_threads();
  omp_set_num_threads(workers);
  omp_set_dynamic(0);
  #pragma omp parallel num_threads(workers)
  {
    #pragma omp single
    toy_serial(a, x, y);
  }
  #pragma omp parallel for schedule(static, 3) num_threads(workers)
  for (int i = 0; i < 0; ++i) {}
#else
  toy_serial(a, x, y);
#endif
`);
	const checker = buildCsrChecker(starter(), source, task, plan);
	assert.equal(checker.metadata.threadPolicy.actualThreads, "not_observed");
	assert.equal(checker.metadata.timing.threadsMeaning, "requested-default-and-openmp-cap");
	assert.match(checker.metadata.threadPolicy.description, /contention group/);
	assert.match(checker.source, /setenv\("OMP_THREAD_LIMIT", thread_limit\.c_str\(\), 1\)/);
	if (spawnSync("g++", ["--version"]).error) { t.skip("g++ unavailable"); return; }
	const result = await compiledCheck(source, ["--check"], plan, [["--timing", "skew_a", "strategy:3", "2"]]);
	assert.equal(result.compile.status, 0, String(result.compile.stderr));
	assert.equal(result.run?.status, 0, String(result.run?.stderr));
	assert.equal(result.runs[0].status, 0, String(result.runs[0].stderr));
});

test("OpenMP runtime cap is installed before worker startup and can coexist with explicit team requests", async t => {
	if (spawnSync("g++", ["--version"]).error) { t.skip("g++ unavailable"); return; }
	// This is a protocol/resource fixture, not an optimization strategy.
	const source = candidate(`
  if (omp_get_thread_limit() != 2) throw std::runtime_error("thread cap was not installed");
  int observed = 0;
  #pragma omp parallel num_threads(6)
  {
    #pragma omp single
    observed = omp_get_num_threads();
  }
  if (observed < 1 || observed > 2) throw std::runtime_error("thread cap was not enforced");
  toy_serial(a, x, y);
`);
	const result = await compiledCheck(source, ["--timing", "skew_a", "strategy:3", "2"]);
	assert.equal(result.compile.status, 0, String(result.compile.stderr));
	assert.equal(result.run?.status, 0, String(result.run?.stderr));
	assert.match(String(result.run?.stdout), /threads=2/);
});
