import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildCsrChecker, type CsrExperimentPlan } from "../src/workflow-archive/csr-checker.ts";

// Synthetic source only. Private task inputs and strategy implementations are never fixtures.
const linuxCompiledOnly = { skip: process.platform !== "linux" ? "compiled checker requires Linux pipe2, prctl, and /proc semantics" : false };
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
async function compiledCheck(source: string, args: string[] = [], selectedPlan = plan, selections: string[][] = []) {
	const root = await mkdtemp(path.join(os.tmpdir(), "csr-checker-synthetic-"));
	try {
		const checker = buildCsrChecker(starter(), source, task, selectedPlan);
		await writeFile(path.join(root, "checker.cpp"), checker.source);
		await writeFile(path.join(root, "candidate.cpp"), source);
		await writeFile(path.join(root, "worker.cpp"), checker.workerSource);
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

test("independent checker validates and times serial, std::thread, and a registered candidate", linuxCompiledOnly, async t => {
	if (spawnSync("g++", ["--version"]).error) { t.skip("g++ unavailable"); return; }
	const selections = ["serial:0", "std_thread:0", "strategy:3"].map(selector => ["--timing", "skew_a", selector, "2"]);
	const result = await compiledCheck(candidate(), ["--check"], plan, selections);
	assert.equal(result.compile.status, 0, String(result.compile.stderr));
	assert.equal(result.run?.status, 0, String(result.run?.stderr));
	assert.equal(result.run?.stdout, "CSR_CHECK_PASS\n");
	assert.equal(result.runs.length, 3);
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

test("new strategy cannot pass with stale, nonfinite, or unwritten output", linuxCompiledOnly, async t => {
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

test("input mutation and output replacement fail independent verification", linuxCompiledOnly, async t => {
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
