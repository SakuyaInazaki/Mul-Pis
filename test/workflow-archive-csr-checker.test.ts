import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildCsrChecker } from "../src/workflow-archive/csr-checker.ts";

// Deliberately synthetic names and input. Private lab content is never a fixture.
function fixture(secondBody: string): string {
	return `#include <iostream>
#include <vector>
struct ToyCompressedRows {
  int rows = 0, cols = 0;
  std::vector<int> row_ptr, col_idx;
  std::vector<double> values;
};
static void toy_reference(const ToyCompressedRows& a, const std::vector<double>& x, std::vector<double>& y) {
  for (int r = 0; r < a.rows; ++r) {
    double sum = 0;
    for (int p = a.row_ptr[r]; p < a.row_ptr[r+1]; ++p) sum += a.values[p] * x[a.col_idx[p]];
    y[r] = sum;
  }
}
// TODO 1: test target
static void toy_first(const ToyCompressedRows& a, const std::vector<double>& x, std::vector<double>& y) {
  toy_reference(a, x, y);
}
// TODO 2: test target
static void toy_second(const ToyCompressedRows& a, const std::vector<double>& x, std::vector<double>& y) {
  ${secondBody}
}
static bool toy_check(const std::vector<double>& a, const std::vector<double>& b,
                      double abs_tol = 1e-10, double rel_tol = 1e-10) { return a == b; }
int main() { return 0; }
`;
}

async function compiledCheck(candidate: string): Promise<{ compile: ReturnType<typeof spawnSync>; run?: ReturnType<typeof spawnSync> }> {
	const root = await mkdtemp(path.join(os.tmpdir(), "csr-checker-synthetic-"));
	try {
		const checker = buildCsrChecker(fixture("toy_reference(a, x, y);"));
		await writeFile(path.join(root, "checker.cpp"), checker.source);
		await writeFile(path.join(root, "candidate.cpp"), candidate);
		const compile = spawnSync("g++", ["-std=c++17", "-fopenmp", "-O0", "-pthread", "checker.cpp", "-o", "check"],
			{ cwd: root, encoding: "utf8", timeout: 20_000 });
		if (compile.status !== 0) return { compile };
		const run = spawnSync(path.join(root, "check"), [], { cwd: root, encoding: "utf8", timeout: 10_000 });
		return { compile, run };
	} finally { await rm(root, { recursive: true, force: true }); }
}

test("checker derives names, tolerance, and finite bounded coverage at runtime", () => {
	const result = buildCsrChecker(fixture("toy_reference(a, x, y);"));
	assert.equal(result.metadata.matrixType, "ToyCompressedRows");
	assert.deepEqual(result.metadata.targets, ["toy_first", "toy_second"]);
	assert.equal(result.metadata.absTolerance, "1e-10");
	assert.equal(result.metadata.relTolerance, "1e-10");
	assert.deepEqual(result.metadata.threadCounts, [1, 2, 4]);
	assert.equal(result.metadata.shapes.length, 4);
	assert.equal(result.metadata.mutationPasses, 2);
	assert.equal(result.metadata.timing.marker, "CSR_TIMING");
	assert.deepEqual(result.metadata.timing.shapes, [[1024, 509], [4096, 2047]]);
	assert.deepEqual(result.metadata.timing.threadCounts, [1, 4]);
	assert.equal(result.metadata.timing.warmups, 2);
	assert.equal(result.metadata.timing.repeats, 16);
	assert.match(result.source, /#include "candidate\.cpp"/);
	assert.match(result.source, /CSR_CHECK_PASS/);
	const changedTolerance = buildCsrChecker(fixture("toy_reference(a, x, y);")
		.replace("abs_tol = 1e-10", "abs_tol = 2e-8")
		.replace("rel_tol = 1e-10", "rel_tol = 3e-9"));
	assert.match(changedTolerance.source, /error > 2e-8 \+ 3e-9 \* scale/);
	assert.throws(() => buildCsrChecker(fixture("toy_reference(a, x, y);"), "../outside.cpp"));
	assert.throws(() => buildCsrChecker(fixture("toy_reference(a, x, y);").replace("// TODO 2:", "// OMITTED:")));
});

test("independent checker passes synthetic correct implementation", async t => {
	if (spawnSync("g++", ["--version"]).error) { t.skip("g++ unavailable"); return; }
	const result = await compiledCheck(fixture("toy_reference(a, x, y);"));
	assert.equal(result.compile.status, 0, result.compile.stderr?.toString());
	assert.equal(result.run?.status, 0, String(result.run?.stderr));
	const lines = String(result.run?.stdout).trim().split("\n");
	assert.equal(lines.at(-1), "CSR_CHECK_PASS");
	assert.equal(lines.filter(line => line.startsWith("CSR_TIMING ")).length, 8);
	for (const line of lines.slice(0, -1))
		assert.match(line, /^CSR_TIMING target=[12] rows=(1024|4096) cols=(509|2047) threads=[14] repeats=16 elapsed_ns=[1-9]\d*$/);
});

test("candidate's fake benchmark print cannot substitute for host timing records", async t => {
	if (spawnSync("g++", ["--version"]).error) { t.skip("g++ unavailable"); return; }
	const result = await compiledCheck(fixture('std::cout << "OpenMP 0.001 ms\\n"; toy_reference(a, x, y);'));
	assert.equal(result.compile.status, 0, result.compile.stderr?.toString());
	assert.equal(result.run?.status, 0, String(result.run?.stderr));
	const lines = String(result.run?.stdout).trim().split("\n");
	assert.ok(lines.includes("OpenMP 0.001 ms"));
	assert.equal(lines.filter(line => /^CSR_TIMING /.test(line)).length, 8);
	assert.equal(lines.at(-1), "CSR_CHECK_PASS");
	for (const line of lines.filter(line => /^CSR_TIMING /.test(line)))
		assert.match(line, /^CSR_TIMING target=[12] rows=(1024|4096) cols=(509|2047) threads=[14] repeats=16 elapsed_ns=[1-9]\d*$/);
});

test("independent checker detects stale cache after in-place mutation", async t => {
	if (spawnSync("g++", ["--version"]).error) { t.skip("g++ unavailable"); return; }
	const candidate = fixture(`static bool ready = false;
    static std::vector<double> cached;
    if (!ready) { toy_reference(a, x, y); cached = y; ready = true; }
    else y = cached;`);
	const result = await compiledCheck(candidate);
	assert.equal(result.compile.status, 0, result.compile.stderr?.toString());
	assert.equal(result.run?.status, 1);
	assert.match(String(result.run?.stderr), /mismatch\/nonfinite\/unwritten.*pass=1/);
	assert.doesNotMatch(String(result.run?.stdout), /CSR_CHECK_PASS/);
});

test("independent checker rejects a nonfinite output", async t => {
	if (spawnSync("g++", ["--version"]).error) { t.skip("g++ unavailable"); return; }
	const result = await compiledCheck(fixture("toy_reference(a, x, y); y[0] = 0.0 / 0.0;"));
	assert.equal(result.compile.status, 0, result.compile.stderr?.toString());
	assert.equal(result.run?.status, 1);
	assert.match(String(result.run?.stderr), /mismatch\/nonfinite\/unwritten.*row=0/);
});

test("independent checker rejects an unwritten output", async t => {
	if (spawnSync("g++", ["--version"]).error) { t.skip("g++ unavailable"); return; }
	const candidate = fixture(`std::vector<double> temporary(y.size());
    toy_reference(a, x, temporary);
    for (std::size_t row = 0; row + 1 < y.size(); ++row) y[row] = temporary[row];`);
	const result = await compiledCheck(candidate);
	assert.equal(result.compile.status, 0, result.compile.stderr?.toString());
	assert.equal(result.run?.status, 1);
	assert.match(String(result.run?.stderr), /mismatch\/nonfinite\/unwritten.*row=0/);
});
