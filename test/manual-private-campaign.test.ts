import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir, stat, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { offlineChecks } from "../scripts/manual-private-campaign.ts";

test("one-use campaign push guard cannot also dispatch a second paid run manually", async () => {
	const workflow = await readFile(new URL("../.github/workflows/manual-private-campaign.yml", import.meta.url), "utf8");
	const gate = workflow.split("  private-campaign:\n")[1]?.split("    runs-on:")[0] ?? "";
	assert.match(workflow, /on:\n  push:\n    branches:\n      - improve\/workflow-learning-reliability/);
	assert.match(gate, /github\.event_name == 'push'/);
	assert.match(gate, /mul-pis-20261005-lab-resume2/);
	assert.doesNotMatch(gate, /workflow_dispatch|authorize_bounded_run|lab-resume1/);
	assert.match(workflow, /description: "Authorize one DeepSeek campaign up to 21 CNY/);
});

test("generic private campaign source-shape gate preserves non-target bodies", () => {
	const original = `static void baseline() { int x = 1; (void)x; }
// TODO first
static void targetA() { baseline(); }
// TODO second
static void targetB() { baseline(); }
static bool check() { return true; }
int main() { return check() ? 0 : 1; }
`;
	const candidate = original
		.replace("static void targetA() { baseline(); }", "static void targetA() {\n#pragma omp parallel\n { } }")
		.replace("static void targetB() { baseline(); }", "static void targetB() {\n#pragma omp parallel for\n for (int i = 0; i < 1; ++i) { } }");
	assert.equal(offlineChecks.sourceShape(original, candidate).ok, true);
	assert.equal(offlineChecks.sourceShape(original, candidate.replace("int x = 1", "int x = 2")).ok, false);
	assert.equal(offlineChecks.sourceShape(original, original).ok, false);
	assert.equal(offlineChecks.sourceShape(original, candidate.replace("#pragma omp parallel", "#define checker_run main\n#pragma omp parallel")).ok, false);
});

test("host checker protocol rejects extra output and candidate-reported timing cannot drive comparison", () => {
	const metadata = { timing: { repeats: 16, shapes: [[1024, 509], [4096, 2047]], threadCounts: [1, 4] } } as any;
	const rows = [1024, 4096].flatMap((size, index) => [1, 4].flatMap(threads => [1, 2].map(target =>
		`CSR_TIMING target=${target} rows=${size} cols=${index ? 2047 : 509} threads=${threads} repeats=16 elapsed_ns=${1000 * target}`)));
	assert.equal(offlineChecks.parseCheckerOutput([...rows, "CSR_CHECK_PASS"].join("\n"), metadata).status, "passed");
	assert.equal(offlineChecks.parseCheckerOutput(["OpenMP 0.001 ms", ...rows, "CSR_CHECK_PASS"].join("\n"), metadata).status, "failed");
	assert.equal(offlineChecks.parseCheckerOutput([...rows.slice(1), "CSR_CHECK_PASS"].join("\n"), metadata).status, "failed");
	const timings = offlineChecks.parseCheckerOutput([...rows, "CSR_CHECK_PASS"].join("\n"), metadata).timings;
	const baseline = { independent: { status: "passed", timings } };
	const spoof = { independent: { status: "passed", timings }, originalCheckerRuns: [{ reportedKernelMs: [{ label: "OpenMP", ms: 0.001 }] }] };
	assert.equal(offlineChecks.compareCandidateTimings(baseline, spoof).medianRatio, 1);
});

test("prefixed archive references its transported files and fallback keeps promoted canonical candidate", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "mulpis-flat-archive-fixture-"));
	const source = path.join(root, "source"), output = path.join(root, "output");
	try {
		await mkdir(source); await mkdir(output);
		await writeFile(path.join(source, "candidate.cpp"), "// second candidate\n");
		await writeFile(path.join(source, "round-1-candidate.cpp"), "// second round\n");
		await writeFile(path.join(source, "workflow-archive.json"), JSON.stringify({
			files: [{ name: "candidate.cpp", status: "present" }],
			controllerEvidence: { rounds: [{ candidate: { file: "round-1-candidate.cpp" }, verification: { status: "missing" } }] },
		}));
		await offlineChecks.exportPrefixedArchive(source, output, "followon");
		const index = JSON.parse(await readFile(path.join(output, "workflow-followon-archive.json"), "utf8"));
		assert.equal(index.files[0].name, "followon-candidate.cpp");
		assert.equal(index.controllerEvidence.rounds[0].candidate.file, "followon-round-1-candidate.cpp");
		assert.equal(index.transportLayout.defaultArchiveLoaderCompatible, false);
		await writeFile(path.join(output, "candidate.cpp"), "// promoted second candidate\n");
		await writeFile(path.join(output, "workflow-archive.json"), "{}\n");
		await offlineChecks.preserveCandidate({} as any, "R001", output);
		assert.equal(await readFile(path.join(output, "candidate.cpp"), "utf8"), "// promoted second candidate\n");
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("runtime benchmark cases derive bounded default, uniform and heavier shapes from private source text", () => {
	const text = `struct ToyParameters { int first = 100; int second = 500; int third = 8; int fourth = 4; int fifth = 100; int workers = 2; int loops = 10; };
	if (arg == "--alpha") { p.first = read_int_arg(argc, argv, i, arg); }
	if (arg == "--beta") { p.second = read_int_arg(argc, argv, i, arg); }
	if (arg == "--gamma") { p.third = read_int_arg(argc, argv, i, arg); }
	if (arg == "--delta") { p.fourth = read_int_arg(argc, argv, i, arg); }
	if (arg == "--epsilon") { p.fifth = read_int_arg(argc, argv, i, arg); }
	if (arg == "--worker-count") { p.workers = read_int_arg(argc, argv, i, arg); }
	if (arg == "--loop-count") { p.loops = read_int_arg(argc, argv, i, arg); }`;
	const cases = offlineChecks.deriveRuntimeCases(text);
	assert.equal(cases?.length, 9);
	assert.deepEqual(cases?.[0], ["--worker-count", "1", "--loop-count", "10"]);
	assert.ok(cases?.[3].includes("--delta") && cases[3].includes("0"));
	assert.ok(cases?.[6].includes("--beta") && cases[6].includes("1000"));
	assert.equal(offlineChecks.deriveRuntimeCases(text.replace('"--worker-count"', '"--removed"').replace('p.workers', 'p.missing')), undefined);
});

test("generic private campaign accepts only one C++ and two flat text inputs", async () => {
	const directory = await mkdtemp(path.join(os.tmpdir(), "mulpis-private-input-fixture-"));
	try {
		await writeFile(path.join(directory, "fixture.cpp"), "int main() { return 0; }\n");
		await writeFile(path.join(directory, "guide.md"), "fixture\n");
		await writeFile(path.join(directory, "notes.txt"), "fixture\n");
		assert.equal((await offlineChecks.inputs(directory)).files.length, 3);
		await mkdir(path.join(directory, "nested"));
		await assert.rejects(offlineChecks.inputs(directory));
	} finally { await rm(directory, { recursive: true, force: true }); }
});

test("isolation probe remains readable by the sandbox UID under umask 077", async () => {
	const directory = await mkdtemp(path.join(os.tmpdir(), "mulpis-private-probe-fixture-"));
	const previous = process.umask(0o077);
	try {
		await offlineChecks.stageProbe(directory);
		assert.equal((await stat(path.join(directory, "probe.cpp"))).mode & 0o777, 0o644);
	} finally {
		process.umask(previous);
		await rm(directory, { recursive: true, force: true });
	}
});

test("checker bind source is top-level temporary storage, not under private 0700 workspace", async () => {
	const scratch = await offlineChecks.verifierScratch("original");
	try {
		assert.equal(path.dirname(scratch), os.tmpdir());
		assert.equal((await stat(scratch)).mode & 0o777, 0o777);
	} finally { await rm(scratch, { recursive: true, force: true }); }
});

test("private task failure diagnostic redacts exact key and authorization tokens", () => {
	const key = "sk-SYNTHETICPRIVATE123456";
	const message = `request failed Authorization: Bearer ${key}\nnext Bearer sk-ANOTHERSYNTHETIC777`;
	const redacted = offlineChecks.privateFailureMessage(message, key);
	assert.ok(redacted);
	assert.equal(redacted.includes(key), false);
	assert.equal(redacted.includes("sk-ANOTHERSYNTHETIC777"), false);
	assert.match(redacted, /REDACTED_KEY/);
});

test("private diagnostic redacts a key crossing the 4000-character output boundary", () => {
	const key = "sk-SYNTHETICBOUNDARYSECRET123456";
	const message = "x".repeat(3995) + key + " trailing diagnostic";
	const redacted = offlineChecks.privateFailureMessage(message, key);
	assert.ok(redacted);
	assert.equal(redacted.length, 4000);
	assert.equal(redacted.includes(key), false);
	assert.equal(redacted.slice(-5).includes("sk-"), false);
});

test("read-only credential probe uses one official model-list request and stores only status", async () => {
	let calls = 0;
	const mocked = (async (url: string | URL | Request, init?: RequestInit) => {
		calls++;
		assert.equal(String(url), "https://api.deepseek.com/models");
		assert.equal(init?.method, "GET");
		assert.equal(init?.redirect, "error");
		assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer sk-SYNTHETIC_TEST_KEY");
		return new Response(null, { status: 200 });
	}) as typeof fetch;
	assert.deepEqual(await offlineChecks.credentialProbe("sk-SYNTHETIC_TEST_KEY", mocked),
		{ httpStatus: 200, accepted: true });
	assert.equal(calls, 1);
	const rejected = (async () => new Response(null, { status: 401 })) as typeof fetch;
	assert.deepEqual(await offlineChecks.credentialProbe("sk-SYNTHETIC_TEST_KEY", rejected),
		{ httpStatus: 401, accepted: false });
});

test("M04 evidence coverage requires exact task files and complete returned text ranges", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "mulpis-m04-coverage-fixture-"));
	try {
		const evidence = path.join(root, "tasks", "T001", "review-snapshot");
		await mkdir(evidence, { recursive: true });
		for (const [index, name] of ["candidate.cpp", "verification.json", "lesson-delta.json"].entries())
			await writeFile(path.join(evidence, `${String(index + 1).padStart(3, "0")}-${name}`), "one\ntwo\n");
		const source = path.join(root, "m07-source.json"), coverage = path.join(root, "m07-coverage.json");
		await writeFile(source, JSON.stringify({ rootDir: root }));
		const paths = ["candidate.cpp", "verification.json", "lesson-delta.json"].map((name, index) =>
			`tasks/T001/review-snapshot/${String(index + 1).padStart(3, "0")}-${name}`);
		const ranges = paths.map(file => ({ path: file, status: "returned", returned: { kind: "text", startLine: 1, endLine: 2, truncated: false } }));
		const record = { outputs: [{ label: "M07 处理来源", path: source },
			{ label: "M07 回流证据实际访问范围", path: coverage }] } as any;
		await writeFile(coverage, JSON.stringify({ returnedRanges: ranges }));
		assert.equal((await offlineChecks.m04EvidenceReturned(record, "T001")).complete, true);
		await writeFile(coverage, JSON.stringify({ returnedRanges: [{ ...ranges[0], returned: { kind: "text", startLine: 1, endLine: 1 } }, ...ranges.slice(1)] }));
		assert.equal((await offlineChecks.m04EvidenceReturned(record, "T001")).complete, false);
		await writeFile(coverage, JSON.stringify({ returnedRanges: [{ ...ranges[0], status: "error" }, ...ranges.slice(1)] }));
		assert.equal((await offlineChecks.m04EvidenceReturned(record, "T001")).complete, false);
		await writeFile(coverage, JSON.stringify({ returnedRanges: [{ ...ranges[0], path: paths[0].replace("T001", "T002") }, ...ranges.slice(1)] }));
		assert.equal((await offlineChecks.m04EvidenceReturned(record, "T001")).complete, false);
	} finally { await rm(root, { recursive: true, force: true }); }
});
