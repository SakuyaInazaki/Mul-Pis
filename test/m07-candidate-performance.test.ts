import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { captureNcuProfile, parseMsprofKernelCsv, parseMsprofStepCsv, parseNcuRawCsv } from "../src/m07/candidate-performance.ts";
import { validCandidatePerformanceEvidence } from "../src/m07/candidate-diagnostics.ts";

test("ncu raw CSV keeps exact launch and field provenance without inventing a bottleneck", () => {
	const csv = [
		'"ID","Kernel Name","Metric Name","Metric Unit","Metric Value"',
		'"0","kernel_a","gpu__time_duration.sum","ns","5000"',
		'"0","kernel_a","sm__throughput.avg.pct_of_peak_sustained_elapsed","%","41.5"',
		'"1","kernel_b","gpu__time_duration.sum","ns","9000"',
	].join("\n");
	assert.equal(parseNcuRawCsv(csv, { basisId: "shape:a", receiptIndex: 0 }).status, "ambiguous");
	const result = parseNcuRawCsv(csv, { basisId: "shape:a", receiptIndex: 0, launchId: "0" });
	assert.equal(result.status, "parsed");
	assert.equal(result.binding, "unverified");
	assert.equal(result.evidence?.elapsedSeconds?.value, 0.000005);
	assert.equal(result.evidence?.elapsedSeconds?.fieldPath, "csv.row:2.Metric Value");
	assert.deepEqual(result.evidence?.counters?.map(counter => [counter.name, counter.value, counter.unit]),
		[["sm__throughput.avg.pct_of_peak_sustained_elapsed", 41.5, "%"]]);
	assert.equal(validCandidatePerformanceEvidence(result.evidence!, 1), true);
	assert.equal(parseNcuRawCsv(`${csv}\n"0","kernel_a","gpu__time_duration.sum","ns","6000"`,
		{ basisId: "shape:a", receiptIndex: 0, launchId: "0" }).status, "ambiguous");
});

test("msprof separates selected kernel duration from whole-step Computing samples", () => {
	const kernel = [
		'"Step Id","Task ID","Name","Duration(us)","aiv_mte2_ratio","cube_utilization(%)"',
		'"4","17","kernel_a","20","0.31","64"',
		'"4","18","kernel_b","25","0.29","60"',
	].join("\n");
	assert.equal(parseMsprofKernelCsv(kernel, { basisId: "kernel:a", receiptIndex: 0 }).status, "ambiguous");
	const selected = parseMsprofKernelCsv(kernel, { basisId: "kernel:a", receiptIndex: 0, taskId: "17" });
	assert.equal(selected.evidence?.elapsedSeconds?.value, 20e-6);
	assert.deepEqual(selected.evidence?.counters?.map(counter => [counter.name, counter.value, counter.unit]),
		[["aiv_mte2_ratio", 0.31, "reported-ratio"], ["cube_utilization(%)", 64, "%"]]);
	const stepCsv = '"Device_id","Step","Computing"\n"0","4","100"\n"0","5","110"\n';
	assert.equal(parseMsprofStepCsv(stepCsv, { basisId: "whole-step", receiptIndex: 1 }).status, "unavailable",
		"a plain Computing heading does not itself identify its time unit");
	const step = parseMsprofStepCsv(stepCsv, { basisId: "whole-step", receiptIndex: 1, unit: "us", deviceId: "0" });
	assert.equal(step.status, "parsed");
	assert.equal(step.evidence?.elapsedSeconds, undefined);
	const samples = step.evidence!.timingSamplesSeconds!.values;
	assert.equal(samples.length, 2);
	for (const [index, expected] of [0.0001, 0.00011].entries()) assert(Math.abs(samples[index] - expected) < 1e-15);
	assert(Math.abs(parseMsprofStepCsv(stepCsv, { basisId: "whole-step", receiptIndex: 1,
		unit: "us", stepId: "4", deviceId: "0" }).evidence!.timingSamplesSeconds!.values[0] - 0.0001) < 1e-15);
});

test("host-selected environment reaches a profiler capture target", async t => {
	if (process.platform === "win32") { t.skip("POSIX fake profiler requires /bin/sh"); return; }
	const directory = await mkdtemp(path.join(tmpdir(), "ncu-env-test-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const executable = path.join(directory, "ncu");
	await writeFile(executable, `#!/bin/sh\n[ "$PRE_RSI_EXECUTION_MARKER" = "bound" ] || exit 19\nwhile [ "$#" -gt 0 ]; do\n if [ "$1" = "--export" ]; then\n  shift\n  : > "$1.ncu-rep"\n  exit 0\n fi\n shift\ndone\nexit 20\n`);
	await chmod(executable, 0o700);
	const result = await captureNcuProfile({ executable: "/bin/true", argv: [], cwd: directory,
		reportBase: path.join(directory, "capture"), timeoutMs: 5000,
		environment: { PATH: `${directory}${path.delimiter}${process.env.PATH ?? "/usr/bin:/bin"}`,
			PRE_RSI_EXECUTION_MARKER: "bound", HOME: directory, TMPDIR: directory, LANG: "C.UTF-8" } });
	assert.equal(result.status, "captured");
});
