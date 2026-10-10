import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test, { type TestContext } from "node:test";
import { createFileKnowledgeStore } from "../src/knowledge/store.ts";
import { createM07Controller } from "../src/m07/controller.ts";
import { evaluateLocalM07Task, readLocalEvaluatorAttempt,
	readPreparedLocalEvaluatorInput,
	reconcileEnteredLocalEvaluatorAttempt, recoverReturnedLocalM07Task,
	type LocalEvaluatorRunInput } from "../src/m07/local-evaluator-run.ts";
import { registerTrustedLocalMissionEvaluator } from "../src/m07/local-mission-evaluator.ts";
import { createOriginalObjective } from "../src/m07/objective-progress.ts";
import { FakeSessionRunner } from "../src/runner/fake.ts";
import type { StageContext } from "../src/stages/context.ts";
import { Workspace } from "../src/workspace.ts";

const answer = "Synthetic journal candidate.\n";
const sha = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");

async function fixture(t: TestContext): Promise<{ input: LocalEvaluatorRunInput; root: string;
	sessionCalls: { model: number; builder: number } }> {
	const root = await mkdtemp(path.join(os.tmpdir(), "local-evaluator-journal-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const ws = new Workspace(root);
	await mkdir(path.dirname(ws.problemFile), { recursive: true });
	await writeFile(ws.problemFile, "Synthetic request.\n");
	const store = createFileKnowledgeStore(ws.knowledgeDir);
	await store.init();
	const baseline = await ws.startRun("M04", [{ label: "request", path: ws.problemFile }]);
	await ws.finishRun(baseline, "completed");
	const sessionCalls = { model: 0, builder: 0 };
	const ctx: StageContext = { ws, store, runner: new FakeSessionRunner(({ spec }) => {
		sessionCalls.model++;
		if (spec.label.startsWith("M07-")) sessionCalls.builder++;
		return "unused";
	}),
		config: { roles: { execution: "fake/execution", reviewer: "fake/reviewer",
			research: "fake/research" }, concurrency: 1, tools: {} } };
	const controller = createM07Controller(ctx);
	const contract = createOriginalObjective({ goal: "Check synthetic bytes",
		goalSource: "verbatim-private-input", inputNames: ["request.txt"],
		obligations: [{ id: "answer", description: "Check synthetic answer", type: "journal-test",
			expectedSha256: sha(answer) }], closure: "finite-evidence" });
	const goal = await controller.begin({ goal: contract.goal, problemRelation: "Synthetic",
		constraints: ["Synthetic only"], successCriteria: [contract.obligations[0]!.description],
		plan: "One local check" });
	const task = await controller.delegate(goal.runId, { objective: "Check candidate",
		mode: "reason", inputs: [goal.problemSnapshotPath], expectedOutputs: [],
		checks: [contract.obligations[0]!.description] });
	assert(task.reportPath);
	await writeFile(task.reportPath, answer);
	return { root, sessionCalls, input: { contract, goal: await controller.status(goal.runId), task,
		evidence: [], evaluatorId: undefined, frozenOriginalInputs: [], capabilities: [] } };
}

async function stagePrepared(input: LocalEvaluatorRunInput): Promise<string> {
	const taskRoot = path.dirname(input.task.workDir);
	const sourceFile = input.task.reportPath!;
	const bytes = await readFile(sourceFile);
	const name = `candidate-001${path.extname(sourceFile) || ".bin"}`;
	const snapshotDir = path.join(taskRoot, "evaluator-snapshot");
	await mkdir(snapshotDir, { mode: 0o700 }).catch(error => {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
	});
	const file = path.join(snapshotDir, name);
	await writeFile(file, bytes, { mode: 0o400, flag: "wx" }).catch(error => {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
	});
	await chmod(file, 0o400);
	await mkdir(path.join(taskRoot, "host-evaluator-output"), { mode: 0o700 });
	await mkdir(path.join(taskRoot, "host-evaluator-snapshot"), { mode: 0o700 });
	const journalDir = path.join(taskRoot, "host-evaluator-attempt");
	await mkdir(journalDir, { mode: 0o700 });
	const frozenEvidence = await Promise.all(input.evidence.map(async item => {
		const evidenceBytes = await readFile(item.file);
		return { ...item, bytes: evidenceBytes.length, sha256: sha(evidenceBytes) };
	}));
	const prepared = { version: 1, kind: "local-evaluator-prepared-input",
		missionId: input.contract.id, runId: input.goal.runId, taskId: input.task.taskId,
		evaluator: { id: input.evaluatorId!, version: "1" },
		candidate: [{ name, file, sourceFile, bytes: bytes.length, sha256: sha(bytes) }],
		frozenEvidence, resolvedFailures: [] };
	const raw = `${JSON.stringify(prepared)}\n`;
	await writeFile(path.join(journalDir, "prepared.json"), raw, { mode: 0o400 });
	await writeFile(path.join(journalDir, "prepared.sha256"), `${sha(raw)}\n`, { mode: 0o400 });
	return journalDir;
}

test("durable returned result retries exact host finalization without evaluator or preflight", async t => {
	const { input } = await fixture(t);
	const id = `test:journal-${randomUUID()}`;
	let calls = 0;
	let preflightAvailable = true;
	registerTrustedLocalMissionEvaluator({ id, version: "1", supportedObligationTypes: ["journal-test"],
		async preflight() { return { available: preflightAvailable }; },
		async evaluate({ candidate, observationOutputDir }) {
			calls++;
			await writeFile(path.join(observationOutputDir, "observation-note.txt"), "Observed once.\n",
				{ flag: "wx", mode: 0o600 });
			await writeFile(candidate[0]!.sourceFile, "Changed after return.\n");
			return { checks: [{ obligationId: "answer", result: "passed", evidenceRefs: [candidate[0]!.name],
				limitations: [] }], observations: [{ name: "observation-note.txt", kind: "text" }],
				limitations: [] };
		} });
	input.evaluatorId = id;
	await assert.rejects(evaluateLocalM07Task(input), /candidate bytes changed/);
	assert.equal(calls, 1);
	await assert.rejects(readLocalEvaluatorAttempt(input), /candidate bytes changed after evaluation/);
	await writeFile(input.task.reportPath!, answer);
	assert.equal((await readLocalEvaluatorAttempt(input)).state, "returned");
	preflightAvailable = false;
	const outcome = await recoverReturnedLocalM07Task(input);
	assert.equal(outcome.receipt.checks[0]!.result, "passed");
	assert.equal(calls, 1);
	assert.deepEqual((await evaluateLocalM07Task(input)).receipt, outcome.receipt);
	assert.equal(calls, 1);
});

test("empty schema errors recover a durable return with host-only receipt work", async t => {
	const { input, sessionCalls } = await fixture(t);
	const id = `test:journal-${randomUUID()}`;
	let evaluatorCalls = 0;
	let preflightCalls = 0;
	registerTrustedLocalMissionEvaluator({ id, version: "1", supportedObligationTypes: ["journal-test"],
		async preflight() { preflightCalls++; return { available: true }; },
		async evaluate({ candidate, observationOutputDir }) {
			evaluatorCalls++;
			await writeFile(path.join(observationOutputDir, "observation-note.txt"), "Observed once.\n",
				{ flag: "wx", mode: 0o600 });
			await writeFile(candidate[0]!.sourceFile, "Changed after return.\n");
			return { checks: [{ obligationId: "answer", result: "passed" as const,
				evidenceRefs: [candidate[0]!.name], limitations: [], schemaErrors: [] }],
				observations: [{ name: "observation-note.txt", kind: "text" as const }], limitations: [] };
		} });
	input.evaluatorId = id;
	await assert.rejects(evaluateLocalM07Task(input), /candidate bytes changed/);
	await writeFile(input.task.reportPath!, answer);
	assert.equal((await readLocalEvaluatorAttempt(input)).state, "returned");
	const taskRoot = path.dirname(input.task.workDir);
	const journal = path.join(taskRoot, "host-evaluator-attempt", "returned.json");
	const goalFile = path.join(taskRoot, "..", "..", "goal.json");
	const beforeReturn = await readFile(journal);
	const beforeGoal = await readFile(goalFile);
	const goalBefore = JSON.parse(beforeGoal.toString("utf8")) as
		{ branchSelections?: unknown[]; tasks: Array<{ review?: unknown }> };
	assert.deepEqual(goalBefore.branchSelections ?? [], []);
	assert.equal(goalBefore.tasks[0]?.review, undefined);
	const beforeCalls = { ...sessionCalls, evaluator: evaluatorCalls, preflight: preflightCalls };
	const outcome = await recoverReturnedLocalM07Task(input);
	assert.deepEqual(outcome.receipt.checks[0]!.schemaErrors, []);
	assert.equal(outcome.receipt.checks[0]!.result, "passed");
	assert.deepEqual(await readFile(journal), beforeReturn);
	assert.deepEqual(await readFile(goalFile), beforeGoal,
		"host receipt recovery must not select a scientific candidate");
	assert.equal(sessionCalls.builder - beforeCalls.builder, 0);
	assert.equal(sessionCalls.model - beforeCalls.model, 0);
	assert.equal(evaluatorCalls - beforeCalls.evaluator, 0);
	assert.equal(preflightCalls - beforeCalls.preflight, 0);
});

test("durable returned schema errors and unsupported results still fail closed", async t => {
	for (const variant of ["malformed", "passed-nonempty", "unsupported-status"] as const)
		await t.test(variant, async sub => {
			const { input, sessionCalls } = await fixture(sub);
			const id = `test:journal-${randomUUID()}`;
			let evaluatorCalls = 0;
			registerTrustedLocalMissionEvaluator({ id, version: "1",
				supportedObligationTypes: ["journal-test"],
				async preflight() { return { available: true }; },
				async evaluate({ candidate }) {
					evaluatorCalls++;
					return { checks: [{ obligationId: "answer",
						result: (variant === "unsupported-status" ? "approved" : "passed") as "passed",
						evidenceRefs: [candidate[0]!.name], limitations: [],
						schemaErrors: (variant === "malformed" ? "invalid" :
							variant === "passed-nonempty" ? [{ artifact: "candidate.json",
								path: "$.answer", message: "Synthetic shape error." }] : []) as never }],
						observations: [], limitations: [] };
				} });
			input.evaluatorId = id;
			await assert.rejects(evaluateLocalM07Task(input),
				variant === "unsupported-status" ? /mismatched mission, task or checks/ :
					/invalid schema-error feedback/);
			assert.equal((await readLocalEvaluatorAttempt(input)).state, "returned");
			const taskRoot = path.dirname(input.task.workDir);
			const journal = path.join(taskRoot, "host-evaluator-attempt", "returned.json");
			const returnedBytes = await readFile(journal);
			const beforeCalls = { ...sessionCalls, evaluator: evaluatorCalls };
			await assert.rejects(recoverReturnedLocalM07Task(input),
				variant === "unsupported-status" ? /mismatched mission, task or checks/ :
					/invalid schema-error feedback/);
			assert.deepEqual(await readFile(journal), returnedBytes);
			await assert.rejects(readFile(path.join(input.task.workDir,
				"local-evaluator-receipt.json")), { code: "ENOENT" });
			assert.equal(sessionCalls.builder - beforeCalls.builder, 0);
			assert.equal(sessionCalls.model - beforeCalls.model, 0);
			assert.equal(evaluatorCalls - beforeCalls.evaluator, 0);
		});
});

test("returned output tamper and missing journal member fail closed", async t => {
	const { input } = await fixture(t);
	const id = `test:journal-${randomUUID()}`;
	let calls = 0;
	registerTrustedLocalMissionEvaluator({ id, version: "1", supportedObligationTypes: ["journal-test"],
		async preflight() { return { available: true }; },
		async evaluate({ candidate, observationOutputDir }) {
			calls++;
			await writeFile(path.join(observationOutputDir, "observation-note.txt"), "Observed once.\n",
				{ flag: "wx", mode: 0o600 });
			return { checks: [{ obligationId: "answer", result: "passed", evidenceRefs: [candidate[0]!.name],
				limitations: [] }], observations: [{ name: "observation-note.txt", kind: "text" }],
				limitations: [] };
		} });
	input.evaluatorId = id;
	await evaluateLocalM07Task(input);
	const taskRoot = path.dirname(input.task.workDir);
	const output = path.join(taskRoot, "host-evaluator-output", "observation-note.txt");
	await writeFile(output, "Tampered once.\n");
	await assert.rejects(recoverReturnedLocalM07Task(input), /returned observation bytes changed/);
	assert.equal(calls, 1);
	await writeFile(output, "Observed once.\n");
	await unlink(path.join(taskRoot, "host-evaluator-attempt", "returned.sha256"));
	assert.equal((await readLocalEvaluatorAttempt(input)).state, "returned-uncommitted");
	await assert.rejects(recoverReturnedLocalM07Task(input), /no durable returned/);
	await assert.rejects(evaluateLocalM07Task(input), /cannot be re-run/);
	assert.equal(calls, 1);
});

test("pre-entry exact orphan snapshot is reused before one evaluator entry", async t => {
	const { input } = await fixture(t);
	const id = `test:journal-${randomUUID()}`;
	let calls = 0;
	registerTrustedLocalMissionEvaluator({ id, version: "1", supportedObligationTypes: ["journal-test"],
		async preflight() { return { available: true }; },
		async evaluate({ candidate }) { calls++; return { checks: [{ obligationId: "answer",
			result: "failed", evidenceRefs: [], limitations: [] }], observations: [], limitations: [] }; } });
	input.evaluatorId = id;
	const dir = path.join(path.dirname(input.task.workDir), "evaluator-snapshot");
	await mkdir(dir, { mode: 0o700 });
	const orphan = path.join(dir, `candidate-001${path.extname(input.task.reportPath!) || ".bin"}`);
	await writeFile(orphan, await readFile(input.task.reportPath!), { mode: 0o400 });
	await chmod(orphan, 0o400);
	const journalDir = await stagePrepared(input);
	await writeFile(path.join(journalDir, "entered.json"), "{\"version\":1,", { mode: 0o400 });
	await writeFile(path.join(journalDir, "entered.sha256.pending"), "", { mode: 0o400 });
	assert.equal((await readLocalEvaluatorAttempt(input)).state, "pre-entry");
	const outcome = await evaluateLocalM07Task(input);
	assert.equal(outcome.receipt.checks[0]!.result, "failed");
	assert.equal(calls, 1);
});

test("trusted typed reconciliation freezes partial output as negative-only review", async t => {
	const { input } = await fixture(t);
	const id = `test:journal-${randomUUID()}`;
	let proof = false;
	registerTrustedLocalMissionEvaluator({ id, version: "1", supportedObligationTypes: ["journal-test"],
		async preflight() { return { available: true }; },
		async evaluate({ observationOutputDir }) {
			await writeFile(path.join(observationOutputDir, "observation-partial.json"), Buffer.from([0xff, 0x00, 0x7b]),
				{ flag: "wx", mode: 0o600 });
			throw new Error("opaque synthetic evaluator failure");
		},
		async reconcileEvaluation(attempt) {
			return proof ? { state: "settled-failure", proof: { attemptId: attempt.attemptId,
				process: attempt.process, operationId: attempt.attemptId, childProcesses: [],
				settledEffect: "no-effect", evidence: "No external operation was started. SECRET_HOST_ONLY_SENTINEL" } } :
				{ state: "pending" };
		} });
	input.evaluatorId = id;
	await assert.rejects(evaluateLocalM07Task(input), /opaque synthetic/);
	assert.equal((await readLocalEvaluatorAttempt(input)).state, "threw");
	assert.equal((await reconcileEnteredLocalEvaluatorAttempt(input)).state, "pending");
	proof = true;
	const settled = await reconcileEnteredLocalEvaluatorAttempt(input);
	assert.equal(settled.state, "settled-failure");
	if (settled.state !== "settled-failure") return;
	assert(settled.review.checks.every(check => check.result === "not_run"));
	assert.equal(settled.review.artifacts.length, 1);
	assert.doesNotMatch(await readFile(settled.review.artifacts[0]!, "utf8"), /SECRET_HOST_ONLY_SENTINEL/);
	assert.equal(settled.settled.partialOutputs[0]!.sha256, sha(Buffer.from([0xff, 0x00, 0x7b])));
	await assert.rejects(evaluateLocalM07Task(input), /cannot be re-run/);
});


test("invalid normal return leaves a durable boundary for same-owner trusted reconciliation", async t => {
	const { input } = await fixture(t);
	const id = `test:journal-${randomUUID()}`;
	let calls = 0;
	registerTrustedLocalMissionEvaluator({ id, version: "1", supportedObligationTypes: ["journal-test"],
		async preflight() { return { available: true }; },
		async evaluate({ candidate, observationOutputDir }) {
			calls++;
			await writeFile(path.join(observationOutputDir, "observation-invalid.json"), "{",
				{ flag: "wx", mode: 0o600 });
			return { checks: [{ obligationId: "answer", result: "passed",
				evidenceRefs: [candidate[0]!.name], limitations: [] }],
				observations: [{ name: "observation-invalid.json", kind: "json" }], limitations: [] };
		},
		async reconcileEvaluation(attempt) { return { state: "settled-failure", proof: {
			attemptId: attempt.attemptId, process: attempt.process, operationId: attempt.attemptId,
			childProcesses: [], settledEffect: "contained", evidence: "Invalid local output is contained." } }; } });
	input.evaluatorId = id;
	await assert.rejects(evaluateLocalM07Task(input), /declared JSON observation is invalid/);
	assert.equal((await readLocalEvaluatorAttempt(input)).state, "returned-uncommitted");
	await assert.rejects(evaluateLocalM07Task(input), /cannot be re-run/);
	const settled = await reconcileEnteredLocalEvaluatorAttempt(input);
	assert.equal(settled.state, "settled-failure");
	if (settled.state === "settled-failure") assert(settled.review.checks.every(check => check.result === "not_run"));
	assert.equal(calls, 1);
});


test("new process uses prepared locator after half-written entered JSON and evaluates once", async t => {
	const { input, root } = await fixture(t);
	const id = `test:journal-${randomUUID()}`;
	registerTrustedLocalMissionEvaluator({ id, version: "1", supportedObligationTypes: ["journal-test"],
		async preflight() { return { available: true }; },
		async evaluate() { throw new Error("parent process must not evaluate"); } });
	input.evaluatorId = id;
	const journalDir = await stagePrepared(input);
	await writeFile(path.join(journalDir, "entered.json"), "{\"version\":1,", { mode: 0o400 });
	await writeFile(path.join(journalDir, "entered.sha256.pending"), "", { mode: 0o400 });
	const prepared = await readPreparedLocalEvaluatorInput(input);
	assert.deepEqual(prepared?.frozenEvidence, []);
	assert.equal((await readLocalEvaluatorAttempt(input)).state, "pre-entry");
	const counter = path.join(root, "evaluator-call-count.txt");
	const moduleUrl = pathToFileURL(path.join(import.meta.dirname, "..", "src", "m07",
		"local-evaluator-run.ts")).href;
	const evaluatorUrl = pathToFileURL(path.join(import.meta.dirname, "..", "src", "m07",
		"local-mission-evaluator.ts")).href;
	const program = `import {appendFile} from 'node:fs/promises';
const {registerTrustedLocalMissionEvaluator} = await import(process.argv[3]);
const {evaluateLocalM07Task,readPreparedLocalEvaluatorInput} = await import(process.argv[2]);
const input = JSON.parse(process.argv[1]);
registerTrustedLocalMissionEvaluator({id:input.evaluatorId,version:'1',supportedObligationTypes:['journal-test'],
 async preflight(){return {available:true}},
 async evaluate(){await appendFile(process.argv[4],'x');return {checks:[{obligationId:'answer',result:'failed',evidenceRefs:[],limitations:[]}],observations:[],limitations:[]}}});
const prepared = await readPreparedLocalEvaluatorInput(input);
input.evidence = prepared.frozenEvidence.map(({name,file})=>({name,file}));
const result = await evaluateLocalM07Task(input);
console.log(JSON.stringify({result:result.receipt.checks[0].result}));`;
	const child = spawnSync(process.execPath, ["--input-type=module", "-e", program,
		JSON.stringify(input), moduleUrl, evaluatorUrl, counter],
		{ cwd: path.join(import.meta.dirname, ".."), encoding: "utf8", timeout: 30_000 });
	assert.equal(child.status, 0, child.stderr);
	assert.deepEqual(JSON.parse(child.stdout.trim()), { result: "failed" });
	assert.equal(await readFile(counter, "utf8"), "x");
	const recovered = await readLocalEvaluatorAttempt(input);
	assert.equal(recovered.state, "returned");
	if (recovered.state === "returned") {
		assert.notEqual(recovered.attempt.process.pid, process.pid);
		assert.equal(recovered.attempt.process.pid, child.pid);
	}
});


test("prepared locator fails closed when frozen evidence bytes drift", async t => {
	const { input, root } = await fixture(t);
	const id = `test:journal-${randomUUID()}`;
	registerTrustedLocalMissionEvaluator({ id, version: "1", supportedObligationTypes: ["journal-test"],
		async preflight() { return { available: true }; },
		async evaluate() { throw new Error("must not evaluate"); } });
	input.evaluatorId = id;
	const evidence = path.join(root, "frozen-evidence.txt");
	await writeFile(evidence, "Frozen synthetic evidence.\n");
	input.evidence = [{ name: "frozen-evidence.txt", file: evidence }];
	await stagePrepared(input);
	assert.deepEqual((await readPreparedLocalEvaluatorInput(input))?.frozenEvidence.map(item => item.name),
		["frozen-evidence.txt"]);
	await writeFile(evidence, "Changed synthetic evidence.\n");
	await assert.rejects(readPreparedLocalEvaluatorInput(input), /prepared evidence bytes changed/);
});

test("half-written prepared staging and unsealed JSON have no trusted locator or evaluator entry", async t => {
	const { input } = await fixture(t);
	const id = `test:journal-${randomUUID()}`;
	let calls = 0;
	registerTrustedLocalMissionEvaluator({ id, version: "1", supportedObligationTypes: ["journal-test"],
		async preflight() { return { available: true }; },
		async evaluate() { calls++; throw new Error("must not evaluate"); } });
	input.evaluatorId = id;
	const root = path.dirname(input.task.workDir);
	await mkdir(path.join(root, "host-evaluator-output"), { mode: 0o700 });
	await mkdir(path.join(root, "host-evaluator-snapshot"), { mode: 0o700 });
	const journalDir = path.join(root, "host-evaluator-attempt");
	await mkdir(journalDir, { mode: 0o700 });
	const staging = path.join(journalDir, "prepared.json.pending");
	await writeFile(staging, "{\"version\":1,", { mode: 0o400 });
	assert.equal(await readPreparedLocalEvaluatorInput(input), undefined);
	let state = await readLocalEvaluatorAttempt(input);
	assert.equal(state.state, "pre-entry-unlocated");
	if (state.state === "pre-entry-unlocated")
		assert.deepEqual(state.orphanMembers, [{ name: "prepared.json.pending",
			sha256: sha("{\"version\":1,") }]);
	await assert.rejects(evaluateLocalM07Task(input), /cannot be re-run/);
	assert.equal(calls, 0);
	await unlink(staging);
	await writeFile(path.join(journalDir, "prepared.json"), "{\"version\":1,", { mode: 0o400 });
	await writeFile(path.join(journalDir, "prepared.sha256.pending"), "", { mode: 0o400 });
	assert.equal(await readPreparedLocalEvaluatorInput(input), undefined);
	state = await readLocalEvaluatorAttempt(input);
	assert.equal(state.state, "pre-entry-unlocated");
	if (state.state === "pre-entry-unlocated")
		assert.deepEqual(state.orphanMembers.map(item => item.name),
			["prepared.json", "prepared.sha256.pending"]);
	assert.equal(calls, 0);
	await writeFile(path.join(root, "host-evaluator-output", "observation-leak.txt"),
		"Unexpected pre-entry output.\n", { mode: 0o600 });
	await assert.rejects(readLocalEvaluatorAttempt(input), /observation members are missing or extra/);
});

test("complete unsealed prepared bytes are verified and sealed before evaluator entry", async t => {
	const { input } = await fixture(t);
	const id = `test:journal-${randomUUID()}`;
	let calls = 0;
	registerTrustedLocalMissionEvaluator({ id, version: "1", supportedObligationTypes: ["journal-test"],
		async preflight() { return { available: true }; },
		async evaluate() { calls++; return { checks: [{ obligationId: "answer", result: "failed",
			evidenceRefs: [], limitations: [] }], observations: [], limitations: [] }; } });
	input.evaluatorId = id;
	const dir = await stagePrepared(input);
	await unlink(path.join(dir, "prepared.sha256"));
	await writeFile(path.join(dir, "prepared.sha256.pending"), "", { mode: 0o400 });
	assert(await readPreparedLocalEvaluatorInput(input));
	assert.equal((await readLocalEvaluatorAttempt(input)).state, "pre-entry");
	const outcome = await evaluateLocalM07Task(input);
	assert.equal(outcome.receipt.checks[0]!.result, "failed");
	assert.equal(calls, 1);
	assert.equal((await readLocalEvaluatorAttempt(input)).state, "returned");
});
