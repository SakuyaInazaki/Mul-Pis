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
 "allowedImports": ["math"], "apiTargets": ["math.sqrt"],
 "cases": [{"id": "zero-boundary", "input": [0.0], "shape": [1], "distribution": "zero", "seed": 11},
           {"id": "nonzero", "input": [1.0, 4.0, 9.0], "shape": [3], "distribution": "positive-square", "seed": 17}],
 "tolerance": {"mode": "reference-repeat", "repeats": 2, "rtol": 0.0, "sigmaMultiplier": 3.0},
 "timing": {"warmup": 0, "repeats": 2}, "workerTimeoutSeconds": 10, "workerOutputBytes": 1000000
}
def reference(values): return [x ** 0.5 for x in values]
def invoke(candidate, values): return candidate.kernel(values)
def synchronize(): pass  # Explicit CPU synchronous task contract.
def noop(values): return [0.0 for _ in values]
baselines = {"task-reference": reference}
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
	const { backend, verifier } = await createLocalOperatorBackend({ id: "local-test", version: "1", protocolId: "numeric-tree-test-v1", subjectId,
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
	return { root, workDir, backend, verifier, observations, run, tools, lastInput: () => lastInput! };
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
	assert.equal(observed.metrics.length, 4, "each case retains raw elapsed and round-paired baseline ratio");
	assert.ok(observed.metrics.some(item => item.name === "candidate/baseline:task-reference:nonzero" && item.unit === "ratio"));
	assert.equal(JSON.parse(observed.metrics[0].basisId)[3], "numeric-tree");
	assert.equal(JSON.parse(observed.metrics[0].basisId)[4], "ip2", "interleaved timing must not share legacy batch basis");
	assert.equal(observed.executionFacts!.evaluations[0].cases[1].performance!.timingSamplesSeconds!.values.length, 2);
	assert.equal(observed.executionFacts!.evaluations[0].cases[1].referenceMeasurements![0].name, "task-reference");
	const raw = JSON.parse(await readFile(h.lastInput().receipts[0].frozenPath, "utf8"));
	assert.equal(raw.timingExecution, "interleaved-persistent-v2");
	assert.equal(raw.cases[1].calibration.mode, "reference-repeat");
	assert.deepEqual(raw.cases[1].measurementOrder, [["candidate", "baseline:task-reference"],
		["baseline:task-reference", "candidate"]]);
	assert.equal(raw.cases[1].baselines["task-reference"].pairedCandidateToBaselineRatios.length, 2);
	assert.equal(observed.executionFacts!.evaluations[0].cases[1].performance!.pairedBaselineRatios![0].values.length, 2);
	const correctnessSnapshot = journal.stages[2].receiptSnapshots.find((f: { originalPath: string }) => f.originalPath.endsWith("/evaluation.json"));
	const checked = JSON.parse(await readFile(correctnessSnapshot.frozenPath, "utf8"));
	assert.equal(checked.cases[0].noop.passed, true, "a legitimate degenerate case is not called cheating");
	assert.equal(checked.cases[1].noop.passed, false);
	assert.equal(checked.noopDetected, true);
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
				protocolId: "numeric-tree-test-v1", hypothesis: "check the original target", changeKind: "repair", intent: "solution" });
			assert.match(result.text, /completed/);
		}
		return "Frozen local candidate evidence returned";
	});
	const ctx: StageContext = { ws, store, runner, config: { roles: { execution: "fake/execution", reviewer: "fake/reviewer", research: "fake/research" }, concurrency: 1, tools: {} } };
	const controller = createM07Controller(ctx, { candidateVerifier: h.verifier, candidateExecutionBackend: h.backend });
	const goal = await controller.begin({ goal: "Original local operator target", problemRelation: "direct", constraints: ["same task"],
		successCriteria: ["original target"], plan: "measure" },
		{ candidateVerification: { id: h.verifier.id, verifierVersion: h.verifier.version, goalAdmission: false }, executionContract: "continuous" });
	const task = await controller.delegate(goal.runId, { mode: "execute", objective: "evaluate one local candidate", subjectId: "numeric-tree",
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
	assert.equal(booleanReceipt.cases[0].calibration.atol, 1);
	assert.equal(booleanReceipt.noopDetected, true);
	assert.equal(booleanReceipt.cases[0].noop.passed, false, "the numerical field still detects a no-op under atol 1");
	assert.ok(booleanReceipt.cases[0].noop.errors.some((error: { location: string; kind: string }) =>
		error.location === "output.value[0]" && error.kind === "numerical"));
	assert.ok(booleanReceipt.cases[0].comparisons[0].errors.some((error: { location: string; kind: string }) =>
		error.location === "output.nested.mask[0]" && error.kind === "boolean"));
	assert.equal(booleanReceipt.cases[0].comparisons[0].errors.some((error: { location: string }) =>
		error.location.startsWith("output.value")), false, "the candidate numerical field matches the reference");
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
	const declared = contract.replace('"apiTargets": ["math.sqrt"]', '"apiTargets": ["math.sqrt", "math.log"]');
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
	assert.match(JSON.stringify(missing.observations.at(-1)!.executionFacts), /expected exactly 1 output observations/);
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
	const invalid = contract.replace('baselines = {"task-reference": reference}', 'def wrong(values): return [7.0 for _ in values]\nbaselines = {"invalid": wrong}');
	const h = await fixture(t, invalid, candidate, "different-numeric-task"); if (!h) return;
	const { journal } = await h.run();
	assert.equal(journal.state, "failed"); assert.equal(journal.stages.at(-1).stage.id, "measurement");
	const observed = h.observations.at(-1)!;
	assert.equal(observed.correctness, "passed"); assert.deepEqual(observed.metrics, []);
	assert.ok(observed.executionFacts!.evaluations[0].cases.every(item => item.correctness === "passed" && !item.metrics.length));
	assert.ok(observed.executionFacts!.evaluations[0].diagnostics.every(item => item.category === "unknown"),
		"an incomparable named baseline is not a candidate numerical error");
	assert.ok(observed.executionFacts!.evaluations[0].cases.every(item => JSON.parse(item.performance!.basisId)[3] === "different-numeric-task"), "even retained incomparable timing is scoped to the actual subject");
	const stalled = contract.replace('baselines = {"task-reference": reference}', 'def stalled(values):\n while True: pass\nbaselines = {"stalled": stalled}')
		.replace('"workerTimeoutSeconds": 10', '"workerTimeoutSeconds": 1');
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
