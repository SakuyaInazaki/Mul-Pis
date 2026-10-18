import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { collectWarmStartLeads, describeWarmStartLeads, openSearchEventLog } from "../src/m07/search-state/index.ts";

function candidate(id: string, latency: number, subjectId: string): Record<string, unknown> {
	return {
		id, intent: "solution", changeKind: "structure", sourcePaths: ["kernel.cpp"], receiptPaths: ["receipt.json"],
		observationPath: "/frozen/observation.json",
		observation: {
			version: 1, kind: "candidate-observation", verifier: { id: "host:test", version: "1" },
			sourceBinding: "verified", correctness: "passed", stage: "measurement", checks: [], goalChecks: [],
			metrics: [{ name: "latency", value: latency, unit: "ms", basisId: `basis:${subjectId}`, direction: "lower" }],
			limitations: [], sourceFiles: ["/frozen/kernel.cpp"], receiptFiles: ["/frozen/receipt.json"],
			executionFacts: { evaluations: [{ externalId: `${id}-ext`, subjectId, status: "Completed", terminal: true,
				capturedAt: "2026-10-18T00:00:00.000Z", receiptIndex: 0, cases: [], diagnostics: [] }] },
		},
	};
}

async function priorRun(m07Dir: string, runId: string, options: { subjectId: string; latencies: number[];
	platform?: { id: string; chip: string; toolchain: string } }): Promise<void> {
	const runDir = path.join(m07Dir, runId);
	await mkdir(runDir, { recursive: true });
	const goal = { version: 1, runId, status: "finished", tasks: [{
		taskId: "T001", status: "accepted", workDir: path.join(runDir, "tasks", "T001", "work"),
		subjectId: options.subjectId,
		episode: { version: 1, incumbents: [],
			candidates: options.latencies.map((latency, index) => candidate(`C00${index + 1}`, latency, options.subjectId)) },
	}] };
	await writeFile(path.join(runDir, "goal.json"), `${JSON.stringify(goal, null, 2)}\n`);
	if (options.platform) {
		const log = openSearchEventLog(path.join(runDir, "search-events.jsonl"), { writer: "historic" });
		await log.append({ runId, kind: "task-started", taskId: "T001", platform: options.platform });
	}
}

async function workspace(t: TestContext): Promise<string> {
	const root = await mkdtemp(path.join(tmpdir(), "pre-rsi-warm-start-"));
	t.after(async () => { await rm(root, { recursive: true, force: true }); });
	const m07Dir = path.join(root, "stages", "M07");
	await mkdir(m07Dir, { recursive: true });
	return m07Dir;
}

const DEVICE_A = { id: "device-a", chip: "Device A rev 2", toolchain: "Toolchain 8.3" };

test("a new run finds the best verified candidate of earlier runs with its evidence paths", async t => {
	const m07Dir = await workspace(t);
	await priorRun(m07Dir, "20261017T090000Z-aaaa", { subjectId: "gemm", latencies: [9, 4], platform: DEVICE_A });
	await priorRun(m07Dir, "20261018T090000Z-bbbb", { subjectId: "softmax", latencies: [7], platform: DEVICE_A });
	const result = await collectWarmStartLeads({ m07Dir, excludeRunId: "20261018T120000Z-current",
		platform: { chip: DEVICE_A.chip, toolchain: DEVICE_A.toolchain } });
	assert.equal(result.scannedRuns, 2);
	assert.equal(result.skippedRuns, 0);
	// Newest run first, and only the best candidate per subject and metric.
	assert.deepEqual(result.leads.map(lead => [lead.runId, lead.candidateRef, lead.metric.value]), [
		["20261018T090000Z-bbbb", "T001/C001", 7],
		["20261017T090000Z-aaaa", "T001/C002", 4],
	]);
	assert.equal(result.leads[1].observationPath, "/frozen/observation.json");
	assert.deepEqual(result.leads[1].sourcePaths, ["kernel.cpp"]);
	assert.equal(result.leads[1].comparable, true);
	assert.match(describeWarmStartLeads(result)[1], /T001\/C002 from run 20261017T090000Z-aaaa task T001 subject gemm: latency=4ms \(lower is better, basis basis:gemm, correctness passed\)/);

	const onlyGemm = await collectWarmStartLeads({ m07Dir, subjectId: "gemm",
		platform: { chip: DEVICE_A.chip, toolchain: DEVICE_A.toolchain } });
	assert.deepEqual(onlyGemm.leads.map(lead => lead.candidateRef), ["T001/C002"]);
	const bounded = await collectWarmStartLeads({ m07Dir, limit: 1,
		platform: { chip: DEVICE_A.chip, toolchain: DEVICE_A.toolchain } });
	assert.equal(bounded.leads.length, 1);
	// The run being planned is not its own prior run.
	assert.equal((await collectWarmStartLeads({ m07Dir, excludeRunId: "20261018T090000Z-bbbb",
		platform: { chip: DEVICE_A.chip, toolchain: DEVICE_A.toolchain } })).leads.every(lead => lead.runId !== "20261018T090000Z-bbbb"), true);
});

test("a measurement from another platform is never quietly reused", async t => {
	const m07Dir = await workspace(t);
	await priorRun(m07Dir, "20261017T090000Z-aaaa", { subjectId: "gemm", latencies: [4],
		platform: { id: "device-b", chip: "Device B", toolchain: "Toolchain 9.0" } });
	await priorRun(m07Dir, "20261016T090000Z-cccc", { subjectId: "gemm", latencies: [3] });
	const strict = await collectWarmStartLeads({ m07Dir, platform: { chip: DEVICE_A.chip, toolchain: DEVICE_A.toolchain } });
	assert.deepEqual(strict.leads, []);
	assert.equal(strict.incomparableDropped, 2);
	const shown = await collectWarmStartLeads({ m07Dir, includeIncomparable: true,
		platform: { chip: DEVICE_A.chip, toolchain: DEVICE_A.toolchain } });
	assert.deepEqual(shown.leads.map(lead => [lead.runId, lead.comparable]), [
		["20261017T090000Z-aaaa", false], ["20261016T090000Z-cccc", false]]);
	const described = describeWarmStartLeads(shown);
	assert.match(described[0], /on Device B\/Toolchain 9\.0 — NOT comparable/);
	assert.match(described[1], /with no recorded platform — NOT comparable/);
});

test("unreadable or foreign run directories are counted, not fatal", async t => {
	const m07Dir = await workspace(t);
	await priorRun(m07Dir, "20261017T090000Z-aaaa", { subjectId: "gemm", latencies: [4], platform: DEVICE_A });
	await mkdir(path.join(m07Dir, "20261017T100000Z-dddd"), { recursive: true });
	await writeFile(path.join(m07Dir, "20261017T100000Z-dddd", "goal.json"), "{ broken");
	await mkdir(path.join(m07Dir, "20261017T110000Z-eeee"), { recursive: true });
	const result = await collectWarmStartLeads({ m07Dir, platform: { chip: DEVICE_A.chip, toolchain: DEVICE_A.toolchain } });
	assert.equal(result.scannedRuns, 1);
	assert.equal(result.skippedRuns, 2);
	assert.equal(result.leads.length, 1);
	assert.deepEqual(await collectWarmStartLeads({ m07Dir: path.join(m07Dir, "absent") }),
		{ leads: [], scannedRuns: 0, skippedRuns: 0, incomparableDropped: 0 });
});
