import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { createLocalOperatorBackend } from "../src/m07/local-operator-backend.ts";
import { createCandidateExecutionTools } from "../src/m07/candidate-runner.ts";
import { createFileKnowledgeStore } from "../src/knowledge/store.ts";
import { createM07Controller } from "../src/m07/controller.ts";
import type { CandidateVerifier } from "../src/m07/candidate-evaluation.ts";
import type { CurrentGoal, M07TaskRecord } from "../src/m07/types.ts";
import { FakeSessionRunner } from "../src/runner/fake.ts";
import type { StageContext } from "../src/stages/context.ts";
import { Workspace } from "../src/workspace.ts";

const contract = `
SPEC = {
 "protocolId": "numeric-tree-test-v1", "kernelSymbol": "kernel",
 "allowedImports": ["math"], "apiTargets": ["math.sqrt"], "forbiddenRuntimeTargets": ["math.fsum"],
 "cases": [{"id": "zero-boundary", "input": [0.0], "shape": [1], "scope": "kernel",
            "axes": {"shape": "1", "dtype": "float64", "boundary": "zero"}, "seed": 11},
           {"id": "nonzero", "input": [float(i % 97) + 1.0 for i in range(16381)], "shape": [16381], "scope": "end-to-end",
            "axes": {"shape": "prime-vector", "dtype": "float64", "boundary": "non-power-of-two"}, "seed": 17},
           {"id": "held-out", "input": [float(i % 31) + 0.5 for i in range(1021)], "shape": [1021], "scope": "kernel",
            "set": "certification", "bitExact": "task-library",
            "axes": {"shape": "prime-small", "dtype": "float64", "boundary": "prime"}, "seed": 23}],
 "tolerance": {"mode": "reference-repeat", "repeats": 2, "rtol": 0.0, "sigmaMultiplier": 3.0},
 "timing": {"warmup": 10, "repeats": 30, "minimumSampleSeconds": 0.0001},
 "baselineTiers": {"task-naive": "naive", "task-library": "library"},
 "measurementEnvironment": {"environmentId": "test-cpu", "clockPolicy": "unpinned-test-host",
                            "precision": "float64-exact", "cacheState": "warm"},
 "workerTimeoutSeconds": 20, "workerOutputBytes": 40000000
}
def reference(values): return [x ** 0.5 for x in values]
def naive(values): return [(x ** 0.5) + 0.0 + 0.0 + 0.0 + 0.0 for x in values]
def root(value): return value ** 0.5
def library(values): return [root(x) + 0.0 + 0.0 + 0.0 for x in values]
def invoke(candidate, values): return candidate.kernel(values)
def synchronize(): pass  # Explicit CPU synchronous task contract.
def noop(values): return [0.0 for _ in values]
baselines = {"task-naive": naive, "task-library": library}
`;
const candidate = `import math\ndef kernel(values): return [math.sqrt(x) for x in values]\n`;
type Observation = Awaited<ReturnType<CandidateVerifier["verifyTask"]>>;

async function fixture(t: { after(fn: () => Promise<void>): void; skip(message: string): void }, contractText = contract, source = candidate,
	subjectId = "numeric-tree", workerEnvironment?: Record<string, string>, pythonExecutable?: string) {
	if (process.platform !== "darwin") { t.skip("This concrete worker test requires the implemented macOS write boundary"); return; }
	const python = pythonExecutable ?? process.env.PRE_RSI_TEST_PYTHON ?? "/opt/homebrew/bin/python3";
	try { await access(python); } catch { t.skip("Explicit local Python interpreter is unavailable"); return; }
	const root = await mkdtemp(path.join(tmpdir(), "local-operator-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const taskDir = path.join(root, "tasks", "T001"), workDir = path.join(taskDir, "work");
	await mkdir(workDir, { recursive: true });
	const contractPath = path.join(root, "contract.py");
	await writeFile(contractPath, contractText); await writeFile(path.join(workDir, "candidate.py"), source);
	const { backend, verifier, auditChecks, certifyCandidate } = await createLocalOperatorBackend({ id: "local-test", version: "1", protocolId: "numeric-tree-test-v1", subjectId,
		pythonExecutable: python, contractPath, ...(workerEnvironment ? { workerEnvironment } : {}) });
	const observations: Observation[] = [];
	const goal = { runId: "local-goal" } as CurrentGoal;
	const task = { taskId: "T001", workDir, subjectId } as M07TaskRecord;
	let lastInput: Parameters<CandidateVerifier["verifyTask"]>[0] | undefined;
	const tools = createCandidateExecutionTools({ goalRunId: goal.runId, taskId: task.taskId, operationId: "O001", subjectId: task.subjectId,
		workDir, journalDir: path.join(taskDir, "candidate-runs"), backend,
		evaluate: async args => {
			const files = (paths: unknown) => (paths as string[]).map(relative => ({ declaredPath: relative,
				originalPath: path.join(workDir, relative), frozenPath: path.join(workDir, relative) }));
			lastInput = { goal, task, sources: files(args.sourcePaths), receipts: files(args.receiptPaths) };
			const observation = await verifier.verifyTask(lastInput);
			observations.push(observation);
			return { text: JSON.stringify(observation) };
		} });
	const run = async (runId = "trial") => {
		const output = JSON.parse((await tools[0].execute({ runId, sourcePaths: ["candidate.py"], protocolId: "numeric-tree-test-v1",
			hypothesis: "exercise independent task checks", changeKind: "repair", intent: "solution" })).text);
		return { output, journal: JSON.parse(await readFile(path.join(taskDir, "candidate-runs", runId, "journal.json"), "utf8")) };
	};
	return { root, workDir, backend, verifier, auditChecks, certifyCandidate, observations, run, tools, lastInput: () => lastInput! };
}

test("local task backend executes real reference/no-op/baseline workers and freezes per-case measurement evidence", async t => {
	const helperCandidate = "import math\ndef scalar(value): return math.sqrt(value)\ndef kernel(values):\n output = list(map(scalar, values))\n output[0] = output[0]\n return output\n";
	const h = await fixture(t, contract, helperCandidate); if (!h) return;
	assert.match(h.backend.configurationHelp!, /Host-bound subjectId: "numeric-tree"/);
	assert.equal(h.verifier.verifyGoal, undefined);
	assert.match(h.backend.configurationHelp!, /Original-goal host verification: unconfigured/);
	const wrongSubjectTools = createCandidateExecutionTools({ goalRunId: "local-goal", taskId: "T001", operationId: "O001", subjectId: "another-subject",
		workDir: h.workDir, journalDir: path.join(h.workDir, "..", "candidate-runs"), backend: h.backend,
		evaluate: async () => { throw new Error("wrong subject must never reach evaluation"); } });
	await assert.rejects(wrongSubjectTools[0].execute({ runId: "wrong-subject", sourcePaths: ["candidate.py"], protocolId: "numeric-tree-test-v1",
		hypothesis: "mismatched subject", changeKind: "repair", intent: "solution" }), /subjectId does not match/);
	await assert.rejects(access(path.join(h.workDir, "..", "candidate-runs", "wrong-subject", "journal.json")), { code: "ENOENT" });
	const { journal } = await h.run();
	assert.equal(journal.state, "completed");
	assert.deepEqual(journal.stages.map((s: { status: string }) => s.status), ["passed", "passed", "passed", "passed"]);
	const observed = h.observations.at(-1)!;
	assert.equal(observed.sourceBinding, "verified"); assert.equal(observed.correctness, "passed");
	assert.equal(observed.metrics.length, 3, "only the decidable case retains raw elapsed and round-paired baseline ratios");
	assert.ok(observed.metrics.every(item => item.name.endsWith(":nonzero")),
		"a case below the declared minimum measurable duration contributes no metric at all");
	assert.ok(observed.metrics.some(item => item.name === "candidate/baseline:task-naive:nonzero" && item.unit === "ratio"));
	assert.ok(observed.metrics.some(item => item.name === "candidate/baseline:task-library:nonzero"),
		"every speedup carries both declared baseline tiers");
	assert.equal(JSON.parse(observed.metrics[0].basisId)[3], "numeric-tree");
	assert.equal(JSON.parse(observed.metrics[0].basisId)[4], "ip2", "interleaved timing must not share legacy batch basis");
	assert.equal(JSON.parse(observed.metrics[0].basisId)[6], "test-cpu", "a measured number is scoped to its declared environment");
	assert.equal(observed.executionFacts!.evaluations[0].cases[1].performance!.timingSamplesSeconds!.values.length, 30);
	assert.equal(observed.executionFacts!.evaluations[0].cases[1].referenceMeasurements![0].name, "task-naive");
	assert.match(observed.limitations!.join(" "), /declared environment test-cpu/);
	assert.match(observed.limitations!.join(" "), /task-naive=naive, task-library=library/);
	assert.match(observed.limitations!.join(" "), /zero-boundary \(shortest measured median is below/);
	const raw = JSON.parse(await readFile(h.lastInput().receipts[0].frozenPath, "utf8"));
	assert.equal(raw.timingExecution, "interleaved-persistent-v2");
	assert.equal(raw.cases[1].calibration.mode, "reference-repeat");
	assert.equal(raw.cases[1].measurementOrder.length, 30);
	assert.deepEqual(raw.cases[1].measurementOrder[0], ["candidate", "baseline:task-naive", "baseline:task-library"]);
	assert.deepEqual(raw.cases[1].measurementOrder[1], ["baseline:task-library", "baseline:task-naive", "candidate"]);
	assert.equal(raw.cases[1].baselines["task-naive"].pairedCandidateToBaselineRatios.length, 30);
	assert.equal(raw.cases[1].decisions["task-naive"].verdict, "faster");
	assert.equal(raw.cases[1].decisions["task-library"].endToEndAdmissible, true);
	assert.ok(raw.cases[1].decisions["task-naive"].minimumImprovementThreshold > 1);
	assert.ok(raw.cases[1].orderingStability.pairwiseFlipRate !== null);
	assert.equal(raw.cases[0].performanceDecidable, false);
	assert.ok(raw.aggregate["task-naive"].geometricMeanSpeedupAllDecidable > 1);
	assert.equal(raw.aggregate["task-naive"].declaredCases, 2);
	assert.ok(!JSON.stringify(raw).includes("\"input\"") && !("caseDescriptors" in raw), "a measurement receipt must not carry the declared case values");
	assert.equal(observed.executionFacts!.evaluations[0].cases[1].performance!.pairedBaselineRatios![0].values.length, 30);
	const correctnessSnapshot = journal.stages[2].receiptSnapshots.find((f: { originalPath: string }) => f.originalPath.endsWith("/evaluation.json"));
	const checked = JSON.parse(await readFile(correctnessSnapshot.frozenPath, "utf8"));
	assert.equal(checked.cases[0].degenerate, true, "a legitimate degenerate case is recorded, not called cheating");
	assert.equal(checked.cases[1].degenerate, false);
	assert.equal(checked.cases[1].variants[0].noopSensitive, true);
	assert.equal(checked.cases[1].acceptedVariants, 3, "the sign variant is dropped: the reference itself cannot evaluate it");
	assert.equal(checked.cases[1].rejectedVariants, 1);
	assert.equal(checked.cases[1].variants[1].variantId, "d2-large");
	assert.equal(checked.cases[1].variants[0].determinism.identical, true);
	assert.equal(checked.cases[1].replacedApiClean, true);
	assert.equal(checked.integrity.decidingCases, 1);
	assert.equal(checked.integrity.degenerateCases, 1);
	assert.equal(checked.integrity.passedWithFunctionalChecks, true);
	assert.equal(checked.noopDetected, true);
	assert.ok(!JSON.stringify(checked).includes("\"input\"") && !("caseDescriptors" in checked), "a correctness receipt must not carry the declared case values");
	const savedInput = h.lastInput();
	const mislabeled = await h.verifier.verifyTask({ ...savedInput, task: { ...savedInput.task, subjectId: "another-subject" } });
	assert.equal(mislabeled.sourceBinding, "unknown", "a correct receipt cannot authorize another subject");
	assert.equal(mislabeled.correctness, "unknown");
	assert.deepEqual(mislabeled.metrics, []);
	assert.match(mislabeled.limitations!.join(" "), /host-bound local operator subject/);
	assert.equal(observed.executionFacts!.evaluations[0].subjectId, "numeric-tree");
	await writeFile(path.join(h.workDir, "candidate.py"), candidate.replace("math.sqrt(x)", "math.sqrt(x) + {{OFFSET}}"));
	const swept = JSON.parse((await h.tools[1].execute({ runId: "parameters", sourcePaths: ["candidate.py"],
		protocolId: "numeric-tree-test-v1", hypothesis: "enumerate declared toy offsets", intent: "solution", domainsJson: '{"OFFSET":[0,1]}' })).text);
	assert.equal(swept.status, "completed"); assert.equal(swept.completed, 2);
	assert.deepEqual(h.observations.slice(-2).map(item => item.correctness), ["passed", "failed"]);
	assert.ok(h.observations.slice(-2).every(item => item.sourceBinding === "verified"));
	// Missing predecessor must not be accepted solely because measurement JSON says passed.
	journal.stages[2].status = "failed";
	await writeFile(path.join(h.workDir, "..", "candidate-runs", "trial", "journal.json"), JSON.stringify(journal));
	assert.equal((await h.verifier.verifyTask(savedInput)).sourceBinding, "unknown");
});

test("host Python goal function admits an accepted continuous candidate only from reverified evidence", async t => {
	const goalContract = contract + `
def verify_goal(criteria, observations):
 checks = []
 for criterion in criteria:
  found = next((item for item in observations if item["observation"]["correctness"] == "passed" and
   len(item["observation"]["executionFacts"]["evaluations"][0]["cases"]) == 2), None)
  result = "passed" if found and criterion == "original target" else "failed"
  evidence = [found["observationPath"]] if found else []
  if criterion == "forged evidence": evidence = ["/tmp/not-accepted-evidence"]
  checks.append({"criterion": criterion, "result": result, "evidence": evidence})
 return {"checks": checks, "limitations": []}
`;
	const h = await fixture(t, goalContract); if (!h) return;
	assert.equal(typeof h.verifier.verifyGoal, "function");
	const ws = new Workspace(h.root);
	await mkdir(path.dirname(ws.problemFile), { recursive: true });
	await writeFile(ws.problemFile, "Original local operator target\n");
	const store = createFileKnowledgeStore(ws.knowledgeDir); await store.init();
	const baseline = await ws.startRun("M04", [{ label: "problem", path: ws.problemFile }]);
	await ws.finishRun(baseline, "completed");
	const runner = new FakeSessionRunner(async ({ spec, tools }) => {
		if (spec.tools.kind === "execution") {
			await writeFile(path.join(spec.tools.root, "candidate.py"), candidate);
			const result = await tools.candidate_run({ runId: "local-goal-test", sourcePaths: ["candidate.py"],
				protocolId: "numeric-tree-test-v1", hypothesis: "check the original target", changeKind: "repair",
				strategy: "repair", location: "candidate.py", intent: "solution" });
			assert.match(result.text, /completed/);
		}
		return "Frozen local candidate evidence returned";
	});
	const ctx: StageContext = { ws, store, runner, config: { roles: { execution: "fake/execution", reviewer: "fake/reviewer", research: "fake/research" }, concurrency: 1, tools: {} } };
	const controller = createM07Controller(ctx, { candidateVerifier: h.verifier, candidateExecutionBackend: h.backend });
	const goal = await controller.begin({ goal: "Original local operator target", problemRelation: "direct", constraints: ["same task"],
		successCriteria: ["original target"], plan: "measure" },
		{ candidateVerification: { id: h.verifier.id, verifierVersion: h.verifier.version, goalAdmission: false }, executionContract: "continuous" });
	const task = await controller.delegate(goal.runId, { mode: "execute", subjectProfile: { operatorCategory: "norm-reduce", implementationSpace: "handwritten-low-level", rationale: "test fixture", baselineStrength: "none" }, objective: "evaluate one local candidate", subjectId: "numeric-tree",
		inputs: [], expectedOutputs: ["candidate.py"], checks: ["measurement retained"], executionLoop: { mode: "candidate-episode" } });
	const accepted = await controller.review(goal.runId, { taskId: task.taskId, artifacts: [task.reportPath!],
		checks: [{ criterion: "measurement retained", result: "passed", evidence: [task.reportPath!] }] });
	assert.equal(accepted.status, "accepted");
	assert.equal(accepted.episode?.candidates[0].observation.correctness, "passed");
	const evidence = accepted.review!.artifacts.map(item => item.path);
	const observationPath = accepted.episode!.candidates[0].observationPath;
	assert.ok(evidence.includes(observationPath), "the accepted episode observation is a frozen review artifact");
	const failed = await h.verifier.verifyGoal!({ goal: { ...goal, tasks: [accepted], successCriteria: ["unmet original target"] },
		acceptedEvidencePaths: evidence });
	assert.equal(failed.checks[0].result, "failed", "the fixed host function can reject an unmet original criterion");
	await assert.rejects(h.verifier.verifyGoal!({ goal: { ...goal, tasks: [accepted] },
		acceptedEvidencePaths: [accepted.review!.frozenReportPath] }), /no accepted candidate has reverified/);
	await assert.rejects(h.verifier.verifyGoal!({ goal: { ...goal, tasks: [accepted], successCriteria: ["forged evidence"] },
		acceptedEvidencePaths: evidence }), /criterion or evidence outside accepted/);
	const finished = await controller.finish(goal.runId, { outcome: "fulfilled", summary: "host goal criterion passed", returnPath: "M04",
		goalChecks: [{ criterion: "original target", result: "passed", evidence: [accepted.reportPath!] }] });
	assert.equal(finished.outcome, "fulfilled");
	assert.equal(finished.goalChecks?.[0].criterion, "original target");
	assert.equal(finished.goalChecks?.[0].evidence[0], observationPath);
});

test("a partial no-op crash cannot be hidden by another sensitive case; API arity failure stops before compilation", async t => {
	const booleanContract = contract
		.replace('"tolerance": {"mode": "reference-repeat", "repeats": 2, "rtol": 0.0, "sigmaMultiplier": 3.0}',
			'"tolerance": {"mode": "fixed", "atol": 1.0, "rtol": 0.0}')
		.replace('def reference(values): return [x ** 0.5 for x in values]',
			'def reference(values): return {"nested": {"mask": [True for _ in values]}, "value": [10.0 + x ** 0.5 for x in values]}')
		.replace('def noop(values): return [0.0 for _ in values]',
			'def noop(values): return {"nested": {"mask": [False for _ in values]}, "value": [0.0 for _ in values]}');
	const booleanCandidate = 'import math\ndef kernel(values): return {"nested": {"mask": [False for _ in values]}, "value": [10.0 + math.sqrt(x) for x in values]}\n';
	const boolean = await fixture(t, booleanContract, booleanCandidate); if (!boolean) return;
	const booleanRun = await boolean.run();
	assert.equal(booleanRun.journal.stages.length, 3);
	assert.equal(booleanRun.journal.stages[2].stage.id, "correctness");
	assert.equal(boolean.observations.at(-1)!.correctness, "failed");
	const booleanSnapshot = booleanRun.journal.stages[2].receiptSnapshots.find((file: { originalPath: string }) => file.originalPath.endsWith("/evaluation.json"));
	const booleanReceipt = JSON.parse(await readFile(booleanSnapshot.frozenPath, "utf8"));
	const booleanVariant = booleanReceipt.cases[0].variants[0];
	assert.equal(booleanVariant.calibration.atol, 1);
	assert.equal(booleanVariant.calibration.magnitudeToAtol, 10, "the tolerance hole self-check records the reference magnitude ratio");
	assert.equal(booleanVariant.calibration.toleranceAdequate, true);
	assert.equal(booleanReceipt.noopDetected, true);
	assert.equal(booleanVariant.noop.passed, false, "the numerical field still detects a no-op under atol 1");
	assert.ok(booleanVariant.noop.errors.some((error: { location: string; kind: string }) =>
		error.location === "output.value[0]" && error.kind === "numerical"));
	assert.ok(booleanVariant.comparisons[0].errors.some((error: { location: string; kind: string }) =>
		error.location === "output.nested.mask[0]" && error.kind === "boolean"));
	assert.equal(booleanVariant.comparisons[0].errors.some((error: { location: string }) =>
		error.location.startsWith("output.value")), false, "the candidate numerical field matches the reference");
	assert.deepEqual(booleanVariant.comparisons[0].boundingBox, [{ depth: 0, firstIndex: 0, lastIndex: 0 }],
		"a numerical witness carries the index range of the mismatching leaves");
	assert.equal(booleanVariant.comparisons[0].mismatchRatio, 0.5);
	assert.equal(JSON.stringify(booleanVariant.comparisons[0]).includes("\"expected\""), false,
		"a witness locates the failure without handing back reference values");
	const h = await fixture(t, contract.replace("def noop(values): return [0.0 for _ in values]", 'def noop(values):\n if values == [0.0]: raise RuntimeError("no-op unavailable")\n return [0.0 for _ in values]'));
	if (!h) return;
	const { journal } = await h.run();
	assert.equal(journal.state, "failed"); assert.equal(journal.stages.length, 3);
	assert.equal(h.observations.at(-1)!.correctness, "unknown");
	assert.match(JSON.stringify(h.observations.at(-1)!.executionFacts), /no-op unavailable/);
	const raw = JSON.parse(await readFile(h.lastInput().receipts[0].frozenPath, "utf8"));
	assert.equal(raw.noopDetected, true, "one sensitive case does not excuse another uncompleted ghost check");
	assert.equal(raw.inconclusive, true);
	const bad = await fixture(t, contract, "import math\ndef kernel(values): return [math.sqrt(x, 2) for x in values]\n");
	if (!bad) return;
	const failed = await bad.run();
	assert.equal(failed.journal.stages.length, 1);
	assert.equal(failed.journal.stages[0].status, "failed");
	assert.match(JSON.stringify(bad.observations.at(-1)!.executionFacts), /too many positional arguments/);
	for (const expression of ["__import__('sys')", "eval('1 + 1')", "open('contract.py').read()", "object.__subclasses__()", "m = math\n m.sqrt = lambda x: x"] ) {
		const bypass = await fixture(t, contract, `import math\ndef kernel(values):\n ${expression}\n return values\n`); if (!bypass) return;
		const rejected = await bypass.run();
		assert.equal(rejected.journal.stages.length, 1, "dynamic execution, file access, reflection and aliased attribute mutation stop before candidate execution");
		assert.equal(rejected.journal.state, "failed");
		assert.match(JSON.stringify(bypass.observations.at(-1)!.executionFacts), /candidate capability is forbidden/);
	}
	for (const [source, api] of [
		["import math\ndef kernel(values): return [math.sin(x) for x in values]\n", "math.sin"],
		["import math\ndef kernel(values): return list(map(math.sin, values))\n", "math.sin"],
		["import math\nsum = math.sin\ndef kernel(values): return [sum(x) for x in values]\n", "sum"],
		["import math\ndef helper(x): return math.sqrt(x)\ndef apply(helper, values): return [helper(x) for x in values]\ndef kernel(values): return apply(math.sin, values)\n", "helper"],
		["import math\n@math.sin\ndef kernel(values): return values\n", "math.sin"],
		["import math\nclass Kernel(metaclass=math.sin): pass\ndef kernel(values): return values\n", "math.sin"],
	]) {
		const unresolved = await fixture(t, contract, source); if (!unresolved) return;
		assert.equal((await unresolved.run()).journal.stages.length, 1, "unconfirmed direct, rebound and implicit calls stop before candidate loading");
		assert.equal(unresolved.observations.at(-1)!.correctness, "unknown");
		const unresolvedReceipt = JSON.parse(await readFile(unresolved.lastInput().receipts[0].frozenPath, "utf8"));
		assert.equal(unresolvedReceipt.api.inconclusive, true);
		assert.ok(unresolvedReceipt.api.unresolvedCalls.some((call: { api: string }) => call.api === api));
	}
	// Host-side fault injection keeps testing bounded pipe cleanup even though
	// candidates themselves no longer receive process/I/O capabilities.
	const inherited = await fixture(t, contract + `
import os, time
def invoke(candidate, values):
 read_end, write_end = os.pipe()
 child = os.fork()
 if child == 0:
  os.close(read_end)
  os.setsid()
  os.write(write_end, b"ready")
  os.close(write_end)
  time.sleep(1)  # Finite fixture descendant, retaining stdout/stderr after parent exit.
  os._exit(0)
 os.close(write_end)
 os.read(read_end, 5)
 os.close(read_end)
 return candidate.kernel(values)
`);
	if (!inherited) return;
	const dangling = await inherited.run();
	assert.equal(dangling.journal.state, "failed");
	assert.equal(dangling.journal.stages.length, 3, "inherited pipe descriptors cannot hang or reach measurement");
	assert.match(JSON.stringify(inherited.observations.at(-1)!.executionFacts), /output channels remained open/);
});

test("declared and host-classified calls retain API diagnostics before isolated correctness checks", async t => {
	// This fixture's candidate is deliberately expensive, so it needs baselines
	// that are slower still; the declared tiers and everything else stay put.
	const slowBaselines = (text: string) => text.replace('baselines = {"task-naive": naive, "task-library": library}',
		'def slow_naive(values):\n output = []\n for x in values:\n  value = 0.0\n  for _ in range(2):\n   value = x ** 0.5\n  output.append(value)\n return output\n' +
		'def slow_library(values):\n output = []\n for x in values:\n  value = 0.0\n  for _ in range(3):\n   value = x ** 0.5\n  output.append(value)\n return output\n' +
		'baselines = {"task-naive": slow_naive, "task-library": slow_library}');
	const declared = slowBaselines(contract.replace('"apiTargets": ["math.sqrt"]', '"apiTargets": ["math.sqrt", "math.log"]'));
	const source = "import math\ndef kernel(values): return [math.sqrt(*(x,)) + math.log(1.0) for x in values]\n";
	const h = await fixture(t, declared, source); if (!h) return;
	const { journal } = await h.run();
	assert.equal(journal.state, "completed");
	assert.deepEqual(journal.stages.map((stage: { status: string }) => stage.status), ["passed", "passed", "passed", "passed"]);
	assert.equal(h.observations.at(-1)!.correctness, "passed");
	const contractSnapshot = journal.stages[0].receiptSnapshots.find((file: { originalPath: string }) => file.originalPath.endsWith("/evaluation.json"));
	const receipt = JSON.parse(await readFile(contractSnapshot.frozenPath, "utf8"));
	assert.equal(receipt.api.inconclusive, false);
	assert.deepEqual(receipt.api.unresolvedCalls, []);
	assert.ok(receipt.api.runtimeChecks.some((call: { api: string; reason: string }) =>
		call.api === "math.log" && call.reason === "environment signature unavailable"));
	assert.ok(receipt.api.runtimeChecks.some((call: { api: string; reason: string }) =>
		call.api === "math.sqrt" && call.reason === "dynamic argument expansion"));
	const copySource = "import math\ndef kernel(values): return [math.sqrt(x) for x in values.copy()]\n";
	const withoutClassifier = await fixture(t, contract, copySource); if (!withoutClassifier) return;
	assert.equal((await withoutClassifier.run()).journal.stages.length, 1, "an object method stays unresolved without host classification");
	assert.equal(withoutClassifier.observations.at(-1)!.correctness, "unknown");
	const copyContract = contract + `
def classify_candidate_call(source, node, usage):
 import ast
 target = node.func if isinstance(node, ast.Call) else node
 if usage == "call" and isinstance(target, ast.Attribute) and isinstance(target.value, ast.Name) and target.value.id == "values" and target.attr == "copy":
  return {"allowed": True, "reason": "host permits a read-only copy of the task input list"}
 return {"allowed": False, "reason": "method is outside this task's input-copy contract"}
`;
	const approved = await fixture(t, copyContract, copySource); if (!approved) return;
	const approvedRun = await approved.run();
	assert.equal(approvedRun.journal.state, "completed");
	assert.deepEqual(approvedRun.journal.stages.map((stage: { status: string }) => stage.status), ["passed", "passed", "passed", "passed"]);
	assert.equal(approved.observations.at(-1)!.correctness, "passed");
	const approvedSnapshot = approvedRun.journal.stages[0].receiptSnapshots.find((file: { originalPath: string }) => file.originalPath.endsWith("/evaluation.json"));
	const approvedReceipt = JSON.parse(await readFile(approvedSnapshot.frozenPath, "utf8"));
	assert.ok(approvedReceipt.api.runtimeChecks.some((call: { api: string; hostReason: string; line: number; column: number }) =>
		call.api === "values.copy" && /read-only copy/.test(call.hostReason) && call.line === 2 && Number.isInteger(call.column)));
	const unapproved = await fixture(t, copyContract,
		"import math\ndef kernel(values): return [math.sqrt(x) for x in values if values.count(x) >= 1]\n"); if (!unapproved) return;
	const unapprovedRun = await unapproved.run();
	assert.equal(unapprovedRun.journal.stages.length, 1);
	const unapprovedSnapshot = unapprovedRun.journal.stages[0].receiptSnapshots.find((file: { originalPath: string }) => file.originalPath.endsWith("/evaluation.json"));
	const unapprovedReceipt = JSON.parse(await readFile(unapprovedSnapshot.frozenPath, "utf8"));
	assert.ok(unapprovedReceipt.api.unresolvedCalls.some((call: { api: string; hostReason: string }) =>
		call.api === "values.count" && /outside this task/.test(call.hostReason)));
	const rebound = await fixture(t, copyContract,
		"import math\ndef kernel(values):\n values = list(values)\n return [math.sqrt(x) for x in values.copy()]\n"); if (!rebound) return;
	const reboundRun = await rebound.run();
	assert.equal(reboundRun.journal.state, "completed", "a local object assignment may be classified by the trusted host");
	assert.equal(rebound.observations.at(-1)!.correctness, "passed");
	const permissiveContract = contract + `
def classify_candidate_call(source, node, usage):
 return {"allowed": True, "reason": "deliberately permissive fixture to test non-overridable binding checks"}
`;
	for (const rebindingSource of [
		"import math\ndef kernel(values):\n math = values\n return [math.sqrt(x) for x in values]\n",
		"import math\ndef kernel(values):\n sqrt = math.sqrt\n return [sqrt(x) for x in values]\n",
	]) {
		const binding = await fixture(t, permissiveContract, rebindingSource); if (!binding) return;
		assert.equal((await binding.run()).journal.stages.length, 1,
			"imported aliases and directly rebound function names remain blocked before a permissive host hook");
	}
	for (const classifier of [
		'def classify_candidate_call(source, node, usage): raise RuntimeError("host classifier unavailable")\n',
		'def classify_candidate_call(source, node, usage): return {"allowed": "yes", "reason": "invalid verdict"}\n',
	]) {
		const invalid = await fixture(t, contract + classifier, copySource); if (!invalid) return;
		const invalidRun = await invalid.run();
		assert.equal(invalidRun.journal.stages.length, 1);
		const invalidSnapshot = invalidRun.journal.stages[0].receiptSnapshots.find((file: { originalPath: string }) => file.originalPath.endsWith("/evaluation.json"));
		const invalidReceipt = JSON.parse(await readFile(invalidSnapshot.frozenPath, "utf8"));
		assert.equal(invalidReceipt.api.inconclusive, true);
		assert.ok(invalidReceipt.api.unresolvedCalls.some((call: { api: string; hostClassifierError: string }) =>
			call.api === "values.copy" && call.hostClassifierError));
	}
});

test("worker output completeness and every timing sample are checked outside the candidate process", async t => {
	// Deliberately malformed worker protocol injected by the trusted fixture,
	// not by relaxing the candidate's module-mutation boundary.
	const forged = (change: string) => contract + `
def invoke(candidate, values):
 import json
 original_dumps = json.dumps
 def altered(value, *args, **kwargs):
  if isinstance(value, dict) and "outputs" in value:
   ${change}
  return original_dumps(value, *args, **kwargs)
 json.dumps = altered
 return candidate.kernel(values)
`;
	const missing = await fixture(t, forged('value["outputs"] = []')); if (!missing) return;
	const empty = await missing.run();
	assert.equal(empty.journal.stages.length, 3);
	assert.equal(missing.observations.at(-1)!.correctness, "failed");
	assert.match(JSON.stringify(missing.observations.at(-1)!.executionFacts), /expected exactly 3 output observations/);
	for (const replacement of ['[]', '[0.0, 1.0]']) {
		const invalid = await fixture(t, forged(`if value["samplesSeconds"]: value["samplesSeconds"] = ${replacement}`));
		if (!invalid) return;
		const result = await invalid.run();
		assert.equal(result.journal.stages.at(-1).stage.id, "measurement");
		assert.equal(result.journal.state, "failed");
		const observed = invalid.observations.at(-1)!;
		assert.equal(observed.correctness, "passed", "invalid timing does not erase the observed correct outputs");
		assert.deepEqual(observed.metrics, []);
		assert.ok(observed.executionFacts!.evaluations[0].cases.every(row => !row.performance && !row.metrics.length));
		assert.match(JSON.stringify(observed.executionFacts), /finite positive timing samples/);
	}
});

test("host contract compiles once and executes the frozen native library for correctness and timing", async t => {
	if (process.platform !== "darwin") { t.skip("Uses the concrete macOS write isolation and host C compiler"); return; }
	try { await access("/usr/bin/cc"); } catch { t.skip("Host C compiler is unavailable"); return; }
	const nativeContract = contract + `
import ast, ctypes, pathlib, subprocess, sys
def compile_candidate(source_path, build_dir):
 tree = ast.parse(pathlib.Path(source_path).read_text())
 source = next(ast.literal_eval(node.value) for node in tree.body if isinstance(node, ast.Assign) and any(isinstance(target, ast.Name) and target.id == "NATIVE_SOURCE" for target in node.targets))
 artifact = pathlib.Path(build_dir) / "kernel.dylib"
 # Fixed host command; stderr flows into the bounded worker's retained log.
 compiled = subprocess.run(["/usr/bin/cc", "-dynamiclib", "-x", "c", "-", "-o", str(artifact)], input=source, text=True, stdout=sys.stderr, stderr=sys.stderr)
 return {"passed": compiled.returncode == 0, "diagnostics": "native compiler exit " + str(compiled.returncode), "artifacts": ["kernel.dylib"] if compiled.returncode == 0 else []}
def bind_compiled(candidate, build_dir):
 library = ctypes.CDLL(str(pathlib.Path(build_dir) / "kernel.dylib"))
 library.kernel.argtypes = [ctypes.c_double]
 library.kernel.restype = ctypes.c_double
 candidate._compiled_library = library
 candidate.kernel = lambda values: [library.kernel(x) for x in values]
`;
	// The Python entry cannot pass on its own: the task binder must consume the
	// actual compiler output. This is native CPU evidence, not GPU acceptance.
	const source = 'def kernel(values): raise RuntimeError("native artifact was not bound")\nNATIVE_SOURCE = "#include <math.h>\\ndouble kernel(double x) { return sqrt(x); }"\n';
	const good = await fixture(t, nativeContract, source); if (!good) return;
	const passed = await good.run();
	assert.equal(good.observations.at(-1)!.correctness, "passed");
	assert.match(good.observations.at(-1)!.limitations!.join(" "), /supplied to bind_compiled/);
	const compile = passed.journal.stages[1];
	const receipt = JSON.parse(await readFile(compile.receiptSnapshots.find((item: { originalPath: string }) => item.originalPath.endsWith("/evaluation.json")).frozenPath, "utf8"));
	assert.equal(receipt.nativeCompilation.passed, true);
	const artifact = compile.receiptSnapshots.find((item: { originalPath: string }) => item.originalPath.endsWith("/compilation-artifacts/kernel.dylib"));
	assert.ok(artifact, "compiled bytes enter the existing stage receipt snapshots");
	assert.ok((await readFile(artifact.frozenPath)).length > 0);
	for (const stage of passed.journal.stages.slice(2)) {
		const consumed = stage.receiptSnapshots.find((item: { originalPath: string }) => item.originalPath.includes("/compiled-inputs-") && item.originalPath.endsWith("/kernel.dylib"));
		assert.ok(consumed, "each execution stage retains the actual supplied native input");
		assert.deepEqual(await readFile(consumed.frozenPath), await readFile(artifact.frozenPath));
	}
	const bad = await fixture(t, nativeContract, source.replace("return sqrt(x);", "not valid C;")); if (!bad) return;
	const failed = await bad.run();
	assert.equal(failed.journal.stages.length, 2, "native compilation failure cannot enter correctness or measurement");
	assert.equal(failed.journal.state, "failed");
	assert.match(JSON.stringify(bad.observations.at(-1)!.executionFacts), /native compiler exit/);
	assert.ok(failed.journal.stages[1].receiptSnapshots.some((item: { originalPath: string }) => item.originalPath.endsWith("/stderr.txt")));
	const wrong = await fixture(t, nativeContract, source.replace("return sqrt(x);", "return x * x;")); if (!wrong) return;
	const numerical = await wrong.run();
	assert.equal(numerical.journal.stages[1].status, "passed");
	assert.equal(numerical.journal.stages.length, 3);
	assert.equal(wrong.observations.at(-1)!.correctness, "failed", "successful native compilation cannot mask incorrect compiled computation");
});

test("invalid or timed-out baselines never relabel a correct candidate or create a performance incumbent", async t => {
	const invalid = contract.replace('baselines = {"task-naive": naive, "task-library": library}', 'def wrong(values): return [7.0 for _ in values]\nbaselines = {"invalid": wrong, "task-library": library}')
		.replace('"baselineTiers": {"task-naive": "naive", "task-library": "library"}', '"baselineTiers": {"invalid": "naive", "task-library": "library"}');
	const h = await fixture(t, invalid, candidate, "different-numeric-task"); if (!h) return;
	const { journal } = await h.run();
	assert.equal(journal.state, "failed"); assert.equal(journal.stages.at(-1).stage.id, "measurement");
	const observed = h.observations.at(-1)!;
	assert.equal(observed.correctness, "passed"); assert.deepEqual(observed.metrics, []);
	assert.ok(observed.executionFacts!.evaluations[0].cases.every(item => item.correctness === "passed" && !item.metrics.length));
	assert.ok(observed.executionFacts!.evaluations[0].diagnostics.every(item => item.category === "unknown"),
		"an incomparable named baseline is not a candidate numerical error");
	assert.ok(observed.executionFacts!.evaluations[0].cases.every(item => JSON.parse(item.performance!.basisId)[3] === "different-numeric-task"), "even retained incomparable timing is scoped to the actual subject");
	const stalled = contract.replace('baselines = {"task-naive": naive, "task-library": library}', 'def stalled(values):\n while True: pass\nbaselines = {"stalled": stalled, "task-library": library}')
		.replace('"baselineTiers": {"task-naive": "naive", "task-library": "library"}', '"baselineTiers": {"stalled": "naive", "task-library": "library"}')
		.replace('"workerTimeoutSeconds": 20', '"workerTimeoutSeconds": 1');
	const timeout = await fixture(t, stalled); if (!timeout) return;
	await timeout.run();
	assert.equal(timeout.observations.at(-1)!.correctness, "passed");
	assert.deepEqual(timeout.observations.at(-1)!.metrics, []);
	assert.match(JSON.stringify(timeout.observations.at(-1)!.executionFacts), /timed out/);
	assert.equal(timeout.observations.at(-1)!.executionFacts!.evaluations[0].diagnostics[0].category, "unknown",
		"a baseline worker timeout remains a measurement-availability gap");
	const failedBaseline = JSON.parse(await readFile(timeout.lastInput().receipts[0].frozenPath, "utf8"));
	assert.equal(failedBaseline.cases[0].failureRole, "baseline:stalled");
	assert.equal(failedBaseline.cases[0].correctnessFromPreviousStage, true);
});

test("host-selected runtime environment reaches the same independent worker roles", async t => {
	if (process.platform !== "darwin") { t.skip("This concrete worker test requires the implemented macOS write boundary"); return; }
	const basePython = process.env.PRE_RSI_TEST_PYTHON ?? "/opt/homebrew/bin/python3";
	try { await access(basePython); } catch { t.skip("Explicit local Python interpreter is unavailable"); return; }
	const environmentRoot = await mkdtemp(path.join(tmpdir(), "operator-venv-"));
	t.after(() => rm(environmentRoot, { recursive: true, force: true }));
	const venv = path.join(environmentRoot, "venv"), venvPython = path.join(venv, "bin", "python");
	await promisify(execFile)(basePython, ["-m", "venv", "--without-pip", "--symlinks", venv]);
	assert.equal((await lstat(venvPython)).isSymbolicLink(), true, "the regression must exercise a venv interpreter symlink");
	const environmentContract = contract.replace(
		"def synchronize(): pass  # Explicit CPU synchronous task contract.",
		"import os, pathlib, sys\ndef synchronize():\n if os.environ.get('PRE_RSI_EXECUTION_MARKER') != 'bound': raise RuntimeError('worker environment differs from host selection')\n if not pathlib.Path(sys.prefix).samefile(" + JSON.stringify(venv) + "): raise RuntimeError('worker interpreter escaped the host virtualenv')") +
		"\nimport pathlib, sys\nif not pathlib.Path(sys.prefix).samefile(" + JSON.stringify(venv) + "): raise RuntimeError('contract interpreter escaped the host virtualenv')\n";
	const h = await fixture(t, environmentContract, candidate, "numeric-tree", { PRE_RSI_EXECUTION_MARKER: "bound" }, venvPython);
	if (!h) return;
	const { journal } = await h.run("environment-bound");
	assert.equal(journal.state, "completed");
	assert.deepEqual(journal.stages.map((stage: { status: string }) => stage.status),
		["passed", "passed", "passed", "passed"]);
});

test("task-owned parameter rejection stops before compile while hook errors stay inconclusive", async t => {
	const constrained = `${contract}\ndef validate_parameters(parameters):\n if parameters.get('OFFSET') == 0:\n  return {'valid': False, 'reason': 'OFFSET must be positive'}\n if parameters.get('OFFSET') == 2:\n  raise RuntimeError('constraint service unavailable')\n return True\n`;
	const h = await fixture(t, constrained); if (!h) return;
	const execute = async (runId: string, offset: number) => JSON.parse((await h.tools[0].execute({ runId,
		sourcePaths: ["candidate.py"], protocolId: "numeric-tree-test-v1", configJson: JSON.stringify({ parameters: { OFFSET: offset } }),
		hypothesis: "check task parameter constraint", changeKind: "parameters", intent: "solution" })).text);
	await execute("invalid-parameter", 0);
	const rejected = JSON.parse(await readFile(path.join(h.workDir, "..", "candidate-runs", "invalid-parameter", "journal.json"), "utf8"));
	assert.deepEqual(rejected.stages.map((stage: { stage: { id: string } }) => stage.stage.id), ["contract"]);
	const rejectedReceipt = rejected.stages[0].receiptSnapshots.find((file: { originalPath: string }) => file.originalPath.endsWith("/evaluation.json"));
	const rejectedFacts = JSON.parse(await readFile(rejectedReceipt.frozenPath, "utf8"));
	assert.deepEqual(rejectedFacts.parameterValidation, { valid: false, reason: "OFFSET must be positive" });
	assert.equal(rejectedFacts.inconclusive, undefined);
	assert.equal(h.observations.at(-1)?.correctness, "unknown");
	assert.equal(h.observations.at(-1)?.executionFacts?.evaluations[0].diagnostics[0].category, "unknown");
	await execute("parameter-hook-error", 2);
	const uncertain = JSON.parse(await readFile(path.join(h.workDir, "..", "candidate-runs", "parameter-hook-error", "journal.json"), "utf8"));
	assert.deepEqual(uncertain.stages.map((stage: { stage: { id: string } }) => stage.stage.id), ["contract"]);
	const uncertainReceipt = uncertain.stages[0].receiptSnapshots.find((file: { originalPath: string }) => file.originalPath.endsWith("/evaluation.json"));
	const uncertainFacts = JSON.parse(await readFile(uncertainReceipt.frozenPath, "utf8"));
	assert.equal(uncertainFacts.inconclusive, true);
	assert.match(uncertainFacts.error, /constraint service unavailable/);
	assert.equal(h.observations.at(-1)?.correctness, "unknown");
	assert.equal(h.observations.at(-1)?.executionFacts?.evaluations[0].diagnostics[0].category, "unknown");
	await execute("valid-parameter", 1);
	const accepted = JSON.parse(await readFile(path.join(h.workDir, "..", "candidate-runs", "valid-parameter", "journal.json"), "utf8"));
	assert.equal(accepted.state, "completed");
});

test("the frozen measurement protocol and its declarations are not negotiable", async t => {
	if (process.platform !== "darwin") { t.skip("This concrete worker test requires the implemented macOS write boundary"); return; }
	const python = process.env.PRE_RSI_TEST_PYTHON ?? "/opt/homebrew/bin/python3";
	try { await access(python); } catch { t.skip("Explicit local Python interpreter is unavailable"); return; }
	const root = await mkdtemp(path.join(tmpdir(), "local-operator-protocol-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	let index = 0;
	const reject = async (text: string, expected: RegExp) => {
		const contractPath = path.join(root, `contract-${index++}.py`);
		await writeFile(contractPath, text);
		await assert.rejects(createLocalOperatorBackend({ id: "local-test", version: "1", protocolId: "numeric-tree-test-v1",
			subjectId: "numeric-tree", pythonExecutable: python, contractPath }), expected);
	};
	await reject(contract.replace('"warmup": 10', '"warmup": 2'), /frozen timing protocol floor/);
	await reject(contract.replace('"repeats": 30', '"repeats": 5'), /frozen timing protocol floor/);
	await reject(contract.replace(', "minimumSampleSeconds": 0.0001', ""), /minimumSampleSeconds/);
	await reject(contract.replace('"minimumSampleSeconds": 0.0001', '"minimumSampleSeconds": 0.000001'), /minimumSampleSeconds/);
	await reject(contract.replace('"scope": "end-to-end"', '"scope": "kernel"'), /at least one iteration case must measure the end-to-end scope/);
	await reject(contract.replace('"scope": "kernel"', '"scope": "whole-program"'), /must declare scope kernel or end-to-end/);
	await reject(contract.replace('"axes": {"shape": "1", "dtype": "float64", "boundary": "zero"}, ', ""), /coverage axes/);
	await reject(contract.replace('"baselineTiers": {"task-naive": "naive", "task-library": "library"}',
		'"baselineTiers": {"task-naive": "naive", "task-library": "naive"}'), /two denominators/);
	await reject(contract.replace('"cacheState": "warm"', '"cacheState": "whatever"'), /measurementEnvironment/);
	await reject(contract.replace(', "forbiddenRuntimeTargets": ["math.fsum"]', ""), /forbiddenRuntimeTargets/);
	// Two cases that differ only in their values cover one axis combination.
	await reject(contract
		.replace('"axes": {"shape": "prime-vector", "dtype": "float64", "boundary": "non-power-of-two"}',
			'"axes": {"shape": "1", "dtype": "float64", "boundary": "zero"}')
		.replace('"axes": {"shape": "prime-small", "dtype": "float64", "boundary": "prime"}',
			'"axes": {"shape": "1", "dtype": "float64", "boundary": "zero"}'), /two distinct declared axis combinations/);
	await reject(contract.replace('"set": "certification", "bitExact": "task-library",', ""),
		/at least one case must be reserved for certification/);
	await reject(contract.replace('"bitExact": "task-library"', '"bitExact": "no-such-baseline"'),
		/bitExact must name one of the declared baselines/);
});

test("a tolerance that cannot separate a degenerate output decides nothing", async t => {
	// Reference outputs near 1e-6 under atol 1e-2: returning zero would pass.
	const hollow = contract
		.replace('"tolerance": {"mode": "reference-repeat", "repeats": 2, "rtol": 0.0, "sigmaMultiplier": 3.0}',
			'"tolerance": {"mode": "fixed", "atol": 0.01, "rtol": 0.0}')
		.replace("def reference(values): return [x ** 0.5 for x in values]",
			"def reference(values): return [(x ** 0.5) * 1e-6 for x in values]");
	const zeroCandidate = "import math\ndef kernel(values): return [math.sqrt(x) * 0.0 for x in values]\n";
	const h = await fixture(t, hollow, zeroCandidate); if (!h) return;
	const { journal } = await h.run();
	assert.equal(journal.state, "failed");
	assert.equal(journal.stages.at(-1).stage.id, "correctness");
	const receipt = JSON.parse(await readFile(h.lastInput().receipts[0].frozenPath, "utf8"));
	const variant = receipt.cases[1].variants[0];
	assert.equal(variant.accepted, false);
	assert.equal(variant.calibration.toleranceAdequate, false);
	assert.ok(variant.calibration.magnitudeToAtol < 10);
	assert.match(variant.skipped, /degenerate output/);
	assert.equal(receipt.cases[1].rejectedVariants, 4, "no variant of this case can tell a real result from zero");
	assert.equal(receipt.inconclusive, true, "an undecidable suite is never reported as a pass");
	assert.equal(h.observations.at(-1)!.correctness, "unknown");
	assert.deepEqual(h.observations.at(-1)!.metrics, []);
});

test("repeat determinism and the replaced-library call count are checked before any timing", async t => {
	const flaky = "import math\ncalls = [0]\ndef kernel(values):\n calls[0] = calls[0] + 1\n return [math.sqrt(x) + float(calls[0] % 2) for x in values]\n";
	const unstable = await fixture(t, contract, flaky); if (!unstable) return;
	const unstableRun = await unstable.run();
	assert.equal(unstableRun.journal.stages.at(-1).stage.id, "correctness");
	assert.equal(unstableRun.journal.state, "failed");
	const unstableReceipt = JSON.parse(await readFile(unstable.lastInput().receipts[0].frozenPath, "utf8"));
	assert.equal(unstableReceipt.cases[1].variants[0].determinism.repeats, 3);
	assert.equal(unstableReceipt.cases[1].variants[0].determinism.identical, false);
	assert.equal(unstableReceipt.integrity.nondeterministicCases, 2, "every declared case repeats its own input three times");
	const delegating = "import math\ndef kernel(values): return [math.fsum([math.sqrt(x)]) for x in values]\n";
	const replaced = await fixture(t, contract.replace('"apiTargets": ["math.sqrt"]', '"apiTargets": ["math.sqrt", "math.fsum"]'),
		delegating); if (!replaced) return;
	const replacedRun = await replaced.run();
	assert.equal(replacedRun.journal.state, "failed");
	const replacedReceipt = JSON.parse(await readFile(replaced.lastInput().receipts[0].frozenPath, "utf8"));
	assert.equal(replacedReceipt.cases[1].replacedApiClean, false);
	assert.ok(replacedReceipt.cases[1].replacedApiCalls["math.fsum"] > 0);
	assert.equal(replacedReceipt.integrity.replacedApiCases, 2);
	assert.equal(replacedReceipt.integrity.passedWithNumericComparisonOnly, true,
		"numeric comparison alone would have accepted a candidate that still calls the library it replaces");
	assert.equal(replacedReceipt.integrity.passedWithFunctionalChecks, false);
	assert.match(replaced.observations.at(-1)!.limitations!.join(" "), /Numeric comparison alone would have passed this candidate: true/);
});

test("the check suite scores itself against the faults the task declares", async t => {
	const audited = contract + `
MUTANTS = {
 "arithmetic-returns-zero": {"family": "arithmetic", "source": "import math\\ndef kernel(values): return [math.sqrt(x) * 0.0 for x in values]\\n"},
 "precision-truncated": {"family": "precision", "source": "import math\\ndef kernel(values): return [float(int(math.sqrt(x) * 1024.0)) / 1024.0 for x in values]\\n"},
 "boundary-drops-last": {"family": "boundary", "source": "import math\\ndef kernel(values):\\n output = [math.sqrt(x) for x in values]\\n return output[:-1] + [0.0] if output else output\\n"},
 "synchronization-order-dependent": {"family": "synchronization", "source": "import math\\nstate = [0.0]\\ndef kernel(values):\\n state[0] = state[0] + 1.0\\n return [math.sqrt(x) + (state[0] - 1.0) for x in values]\\n"},
 "control-calls-replaced-library": {"family": "control", "source": "import math\\ndef kernel(values): return [math.fsum([math.sqrt(x)]) for x in values]\\n"},
 "control-correct": {"family": "control", "source": "import math\\ndef kernel(values): return [math.sqrt(x) for x in values]\\n"},
}
`.replace('"apiTargets": ["math.sqrt"]', '"apiTargets": ["math.sqrt", "math.fsum"]');
	const h = await fixture(t, audited.replace('"apiTargets": ["math.sqrt"]', '"apiTargets": ["math.sqrt", "math.fsum"]'));
	if (!h) return;
	const report = await h.auditChecks();
	assert.equal(report.kind, "local-operator-mutation-report");
	assert.equal(report.declared, 6);
	const byName = Object.fromEntries(report.mutants.map(item => [item.name, item]));
	for (const name of ["arithmetic-returns-zero", "precision-truncated", "boundary-drops-last",
		"synchronization-order-dependent", "control-calls-replaced-library"])
		assert.equal(byName[name].detected, true, `${name} must not escape the checks`);
	assert.equal(byName["control-correct"].detected, false, "a known-correct implementation must not be reported as a detected fault");
	assert.equal(report.detected, 5);
	// Escape rates are reported per fault family: the published numbers differ
	// by an order of magnitude between families, so one overall rate hides them.
	assert.equal(report.families.precision.declared, 1);
	assert.equal(report.families.precision.escapeRate, 0);
	assert.equal(report.families.boundary.escapeRate, 0);
	assert.equal(report.families.synchronization.escapeRate, 0);
	assert.equal(report.families.control.escapeRate, 0.5, "the known-correct control is expected not to be flagged");
	assert.ok(report.taskAudit.cases.some((item: { caseId: string; degenerateByRule: string[] }) =>
		item.caseId === "zero-boundary" && item.degenerateByRule.includes("insensitive-to-input")),
		"the task audit names its own degenerate case before any candidate is judged");
	assert.ok(report.taskAudit.cases.some((item: { caseId: string; degenerateByRule: string[] }) =>
		item.caseId === "nonzero" && item.degenerateByRule.length === 0));
	assert.match(report.limitation, /faults nobody wrote down/);
});

test("the reserved certification set is spent once by the host and never reaches the candidate", async t => {
	const h = await fixture(t); if (!h) return;
	const { journal } = await h.run();
	assert.equal(journal.state, "completed");
	for (const stage of journal.stages) {
		for (const snapshot of stage.receiptSnapshots ?? []) {
			if (!snapshot.originalPath.endsWith("/evaluation.json")) continue;
			const receipt = JSON.parse(await readFile(snapshot.frozenPath, "utf8"));
			assert.equal(JSON.stringify(receipt).includes("held-out"), false,
				"a case reserved for certification appears in no receipt the candidate can read");
			if (receipt.caseSummaries) {
					assert.deepEqual(receipt.caseSummaries.map((item: { id: string }) => item.id), ["zero-boundary", "nonzero"]);
				assert.equal(receipt.certificationCases, 1);
			}
		}
	}
	const certified = await h.certifyCandidate(path.join(h.workDir, "candidate.py"));
	assert.equal(certified.kind, "local-operator-certification");
	assert.equal(certified.iterationCases, 2);
	assert.equal(certified.certificationCases, 1);
	assert.ok(certified.cases.some(item => item.caseId === "held-out" && item.set === "certification" && item.passed));
	assert.equal(certified.conditionalCorrectness, 1);
	assert.equal(certified.passed, true);
	assert.match(certified.limitation, /makes no performance claim/);
	// A candidate that is correct within tolerance but diverges bit for bit from
	// the path the task declares equivalent must not be certified.
	const drifting = "import math\ndef kernel(values): return [math.sqrt(x) * (1.0 + 2.0 ** -40) for x in values]\n";
	const drifted = await fixture(t, contract, drifting); if (!drifted) return;
	const report = await drifted.certifyCandidate(path.join(drifted.workDir, "candidate.py"));
	assert.equal(report.passed, false);
	assert.ok(report.conditionalCorrectness! < 1);
	assert.ok(report.cases.some(item => item.caseId === "held-out" && !item.passed));
});

test("a task may tighten a published decision threshold but never relax one", async t => {
	if (process.platform !== "darwin") { t.skip("This concrete worker test requires the implemented macOS write boundary"); return; }
	const python = process.env.PRE_RSI_TEST_PYTHON ?? "/opt/homebrew/bin/python3";
	try { await access(python); } catch { t.skip("Explicit local Python interpreter is unavailable"); return; }
	const root = await mkdtemp(path.join(tmpdir(), "local-operator-policy-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	let index = 0;
	const build = async (text: string) => {
		const contractPath = path.join(root, `contract-${index++}.py`);
		await writeFile(contractPath, text);
		return createLocalOperatorBackend({ id: "local-test", version: "1", protocolId: "numeric-tree-test-v1",
			subjectId: "numeric-tree", pythonExecutable: python, contractPath });
	};
	const withPolicy = (policy: string) => contract.replace('"workerTimeoutSeconds": 20',
		`"decisionPolicy": ${policy}, "workerTimeoutSeconds": 20`);
	await assert.rejects(build(withPolicy('{"endToEndNoiseMargin": 1.5}')), /looser than the published default 1\.03/);
	await assert.rejects(build(withPolicy('{"quarantineRatio": 0.01}')), /looser than the published default/);
	await assert.rejects(build(withPolicy('{"determinismRepeats": 1}')), /looser than the published default 3/);
	await assert.rejects(build(withPolicy('{"unknownKnob": 1}')), /may only override/);
	const strict = await build(withPolicy('{"endToEndNoiseMargin": 1.0, "determinismRepeats": 4}'));
	assert.ok(strict.backend, "a stricter threshold is accepted and recorded");
});

test("an evaluation worker cannot reach the network", async t => {
	// The static layer already refuses a socket import from the candidate, so
	// the reach is attempted from trusted task code inside the same worker.
	const reaching = contract.replace("def synchronize(): pass  # Explicit CPU synchronous task contract.",
		"import socket\ndef synchronize():\n probe = socket.socket()\n probe.settimeout(1)\n try:\n  probe.connect((\"127.0.0.1\", 9))\n except OSError as error:\n  raise RuntimeError('worker network is closed: ' + type(error).__name__)\n finally:\n  probe.close()");
	const h = await fixture(t, reaching); if (!h) return;
	const { journal } = await h.run();
	assert.equal(journal.state, "failed");
	// PermissionError, not the ConnectionRefusedError an ordinary closed port
	// would give: the sandbox refused the socket, nothing else did.
	assert.match(JSON.stringify(h.observations.at(-1)!.executionFacts), /worker network is closed: PermissionError/);
});
