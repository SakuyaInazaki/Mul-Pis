import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { createFileKnowledgeStore } from "../src/knowledge/store.ts";
import { createM07Controller } from "../src/m07/controller.ts";
import { candidateSearchSnapshot } from "../src/m07/candidate-archive.ts";
import type { CandidateVerifier } from "../src/m07/candidate-evaluation.ts";
import type { CandidateExecutionBackend } from "../src/m07/candidate-runner.ts";
import { FakeSessionRunner } from "../src/runner/fake.ts";
import type { StageContext } from "../src/stages/context.ts";
import { Workspace } from "../src/workspace.ts";
import { HarnessError } from "../src/types.ts";
import type { ToolCallRecord } from "../src/runner/types.ts";

async function setup(reply: ConstructorParameters<typeof FakeSessionRunner>[0], verifier: CandidateVerifier, backend?: CandidateExecutionBackend) {
	const root = await mkdtemp(path.join(tmpdir(), "m07-episode-"));
	const ws = new Workspace(root);
	await mkdir(path.dirname(ws.problemFile), { recursive: true });
	await writeFile(ws.problemFile, "Optimize the original operator without changing its checks.\n");
	const store = createFileKnowledgeStore(ws.knowledgeDir); await store.init();
	const baseline = await ws.startRun("M04", [{ label: "problem", path: ws.problemFile }]);
	await ws.finishRun(baseline, "completed");
	const runner = new FakeSessionRunner(reply);
	const ctx: StageContext = { ws, store, runner, config: { roles: { execution: "fake/execution", reviewer: "fake/reviewer", research: "fake/research" }, concurrency: 1, tools: {} } };
	const controller = createM07Controller(ctx, { candidateVerifier: verifier, ...(backend ? { candidateExecutionBackend: backend } : {}) });
	const goal = await controller.begin({ goal: "Correct and optimize operator", problemRelation: "direct", constraints: ["same interface"], successCriteria: ["original criterion"], plan: "test candidates" },
		{ candidateVerification: { id: verifier.id, verifierVersion: verifier.version }, ...(backend ? { executionContract: "continuous" as const } : {}) });
	return { root, ws, runner, controller, goal };
}

test("a numerical failure can be repaired inside one builder session without fresh reviewer or repeated host evaluation", async t => {
	let calls = 0;
	let finalFinding: "passed" | "incorrect" | "unbound" | "goal-failed" = "passed";
	const verifier: CandidateVerifier = { id: "host:episode-repair", version: "1", async verifyTask({ task, sources, receipts }) {
		calls++;
		assert.deepEqual(task.candidate?.sourcePaths, ["kernel.py"]);
		assert.deepEqual(task.candidate?.receiptPaths, ["receipt.json"]);
		const receipt = JSON.parse(await readFile(receipts[0].frozenPath, "utf8")) as { status: string };
		const source = await readFile(sources[0].frozenPath, "utf8");
		return { sourceBinding: finalFinding === "unbound" ? "unknown" : "verified",
			correctness: receipt.status === "passed" && source === "repaired" && finalFinding !== "incorrect" ? "passed" : "failed",
			stage: receipt.status === "passed" ? "performance" : "numerical", metrics: [], limitations: [],
			goalChecks: finalFinding === "goal-failed" ? [{ criterion: "original criterion", result: "failed" }] : [] };
	} };
	const harness = await setup(async ({ spec, tools }) => {
		if (spec.tools.kind !== "execution") return "report";
		await writeFile(path.join(spec.tools.root, "kernel.py"), "broken");
		await writeFile(path.join(spec.tools.root, "receipt.json"), '{"status":"failed"}');
		const first = JSON.parse((await tools.candidate_evaluate({ sourcePaths: ["kernel.py"], receiptPaths: ["receipt.json"], hypothesis: "check numerical mismatch", changeKind: "repair", intent: "diagnostic" })).text) as { candidateId: string; observation: { correctness: string } };
		assert.equal(first.observation.correctness, "failed");
		await writeFile(path.join(spec.tools.root, "kernel.py"), "repaired");
		await writeFile(path.join(spec.tools.root, "receipt.json"), '{"status":"passed"}');
		const second = JSON.parse((await tools.candidate_evaluate({ sourcePaths: ["kernel.py"], receiptPaths: ["receipt.json"], hypothesis: "repair mismatch", changeKind: "repair", intent: "diagnostic", parentCandidateId: first.candidateId })).text) as { candidateId: string; observation: { correctness: string } };
		assert.equal(second.observation.correctness, finalFinding === "incorrect" ? "failed" : "passed");
		await copyFile(path.join(spec.tools.root, "kernel.py"), path.join(spec.tools.root, "selected.py"));
		await copyFile(path.join(spec.tools.root, "receipt.json"), path.join(spec.tools.root, "selected-receipt.json"));
		return "Repaired candidate is ready for task review.";
	}, verifier);
	t.after(() => rm(harness.root, { recursive: true, force: true }));
	const task = await harness.controller.delegate(harness.goal.runId, { objective: "repair and evaluate", mode: "execute", inputs: [], expectedOutputs: ["selected.py", "selected-receipt.json"], checks: ["candidate checked"], executionLoop: { mode: "candidate-episode" }, candidate: { sourcePaths: ["selected.py"], receiptPaths: ["selected-receipt.json"] } });
	assert.equal(task.status, "returned", task.executionFailure);
	assert.deepEqual(task.episode?.candidates.map(item => item.observation.correctness), ["failed", "passed"]);
	assert.deepEqual(task.episode?.candidates.map(item => item.intent), ["diagnostic", "diagnostic"]);
	assert.equal(task.candidate?.intent ?? "solution", "solution", "the final task retains solution acceptance requirements");
	assert.equal(harness.runner.created.filter(spec => spec.role === "reviewer").length, 0);
	const reviewed = await harness.controller.review(harness.goal.runId, { taskId: task.taskId, artifacts: [], checks: [{ criterion: "candidate checked", result: "passed", evidence: [task.reportPath!] }] });
	assert.equal(reviewed.status, "accepted");
	assert.equal(calls, 2, "review reuses exact frozen episode evidence instead of re-running verification");
	assert.ok(reviewed.review?.artifacts.some(item => item.path === reviewed.episode?.candidates[0].observationPath));
	const checkpoint = await harness.controller.checkpoint(harness.goal.runId);
	const frozenGoal = JSON.parse(await readFile(checkpoint.goalSnapshotPath, "utf8")) as { tasks: Array<{ episode?: { candidates: Array<{ observationPath: string; observation: { sourceFiles: string[]; receiptFiles: string[] } }> } }> };
	const frozenCandidate = frozenGoal.tasks[0].episode?.candidates[0];
	assert.ok(frozenCandidate);
	assert.ok(frozenCandidate.observationPath.startsWith(checkpoint.rootDir));
	assert.ok(frozenCandidate.observation.sourceFiles.every(file => file.startsWith(checkpoint.rootDir)));
	const observationText = await readFile(frozenCandidate.observationPath, "utf8");
	assert.doesNotMatch(observationText, /tasks\/T\d+\/episode\//, "M04 handoff observation uses portable review file references");
	for (const [finding, failure] of [
		["incorrect", /Host correctness is failed/],
		["unbound", /Host could not bind/],
		["goal-failed", /original goal criterion is not met/],
	] as const) {
		finalFinding = finding;
		const next = await harness.controller.delegate(harness.goal.runId, { objective: "review diagnostic evidence as a final solution", mode: "execute", inputs: [],
			expectedOutputs: ["selected.py", "selected-receipt.json"], checks: ["candidate checked"], executionLoop: { mode: "candidate-episode" },
			candidate: { sourcePaths: ["selected.py"], receiptPaths: ["selected-receipt.json"] } });
		assert.equal(next.status, "returned", next.executionFailure);
		const callsBeforeReview: number = calls;
		const rejected = await harness.controller.review(harness.goal.runId, { taskId: next.taskId, artifacts: [],
			checks: [{ criterion: "candidate checked", result: "passed", evidence: [next.reportPath!] }] });
		assert.equal(rejected.status, "rejected", finding);
		assert.match(rejected.review!.failures.join("\n"), failure);
		assert.equal(rejected.candidateObservation?.observationPath, rejected.episode?.candidates[1].observationPath,
			"matching diagnostic evidence reaches the final task's host acceptance checks");
		assert.equal(calls, callsBeforeReview, "a rejected final task also reuses its exact frozen observation");
	}
});

test("controller grants the host execution cascade to a running episode and reviews its verified receipt", async t => {
	const calls: string[] = [];
	let verifications = 0;
	const backend: CandidateExecutionBackend = { id: "controller-host-pipeline", version: "1", stages: [
		{ id: "contract", checks: ["contract"], mode: "local" },
		{ id: "compile", checks: ["compile"], mode: "local" },
		{ id: "judge", checks: ["correctness", "measurement"], mode: "delegated" },
	], async executeStage(ctx) {
		calls.push(ctx.stage.id);
		assert.equal(ctx.taskId, "T001");
		assert.equal(ctx.operationId, "O001", "a runtime operation is bound before the host tool runs");
		assert.equal(await readFile(ctx.sources[0].absolutePath, "utf8"), "candidate source");
		if (ctx.stage.id === "judge") {
			await ctx.recordExternalId("SID-1");
			const pending = path.join(ctx.outputDir, "pending.json");
			await writeFile(pending, '{"status":"pending","externalId":"SID-1"}');
			return { status: "pending", performedChecks: [], receiptPaths: [path.relative(ctx.workDir, pending)], externalId: "SID-1" };
		}
		const receipt = path.join(ctx.outputDir, "stage.json");
		await writeFile(receipt, JSON.stringify({ stage: ctx.stage.id, correctness: "passed", latency: 5 }));
		const relative = path.relative(ctx.workDir, receipt);
		return { status: "passed", performedChecks: ctx.stage.checks, receiptPaths: [relative], evaluationReceiptPaths: [] };
	}, async queryStage(ctx) {
		calls.push(`query:${ctx.stage.id}`);
		assert.equal(ctx.externalId, "SID-1", "the original external ID is queried without another submission");
		const receipt = path.join(ctx.outputDir, "evaluation.json");
		await writeFile(receipt, JSON.stringify({ stage: ctx.stage.id, correctness: "passed", latency: 5 }));
		const relative = path.relative(ctx.workDir, receipt);
		return { status: "passed", performedChecks: ctx.stage.checks, receiptPaths: [relative],
			evaluationReceiptPaths: [relative], externalId: ctx.externalId };
	} };
	const verifier: CandidateVerifier = { id: "host:controller-runner", version: "1", async verifyTask({ sources, receipts }) {
		verifications++;
		assert.equal(await readFile(sources[0].frozenPath, "utf8"), "candidate source");
		assert.equal(receipts.length, 1, "only the judge receipt reaches independent candidate verification");
		const receipt = JSON.parse(await readFile(receipts[0].frozenPath, "utf8")) as { stage: string; latency: number };
		assert.equal(receipt.stage, "judge");
		return { sourceBinding: "verified", correctness: "passed", stage: "performance", metrics: [
			{ name: "latency", value: receipt.latency, unit: "ms", basisId: "fixture-basis", direction: "lower" } ], limitations: [] };
	} };
	let builderTurns = 0;
	let harness!: Awaited<ReturnType<typeof setup>>;
	harness = await setup(async ({ spec, tools }) => {
		if (spec.tools.kind !== "execution") return "review report";
		assert.equal(typeof tools.candidate_run, "function", "the controller granted the real host execution tool");
		builderTurns++;
		if (builderTurns === 1) {
			await writeFile(path.join(spec.tools.root, "kernel.py"), "candidate source");
			const result = JSON.parse((await tools.candidate_run({ runId: "trial1", sourcePaths: ["kernel.py"],
				protocolId: "fixture-protocol", configJson: "{}", hypothesis: "verify and measure",
				changeKind: "structure", intent: "solution" })).text) as { status: string; evaluation?: string };
			assert.equal(result.status, "pending");
			assert.equal(result.evaluation, undefined);
			return "The original judge ID is pending; this model turn returned normally.";
		}
		const live = JSON.parse(await readFile(path.join(harness.ws.runDir("M07", harness.goal.runId), "goal.json"), "utf8")) as {
			tasks: Array<{ status: string }>; executionState: { operations: Array<{ status: string }> } };
		assert.equal(live.tasks.length, 1);
		assert.equal(live.tasks[0].status, "running", "a pending host execution is not a returned task");
		assert.equal(live.executionState.operations[0].status, "issued", "the original operation remains unresolved until queried");
		const result = JSON.parse((await tools.candidate_run({ runId: "trial1", resume: true })).text) as { status: string; evaluation?: string };
		assert.equal(result.status, "completed");
		assert.ok(result.evaluation, "the final original receipt reached candidate_evaluate");
		return "The original ID was queried and its receipt independently observed.";
	}, verifier, backend);
	t.after(() => rm(harness.root, { recursive: true, force: true }));
	assert.equal(harness.goal.executionContract?.mode, "continuous");
	assert.ok(harness.goal.executionState?.activeAttemptId, "the goal has a live runtime attempt");
	const task = await harness.controller.delegate(harness.goal.runId, { objective: "run scoped candidate pipeline", mode: "execute",
		inputs: [], expectedOutputs: ["kernel.py"], checks: ["candidate was observed"], executionLoop: { mode: "candidate-episode" } });
	assert.equal(task.status, "returned", task.executionFailure);
	assert.deepEqual(calls, ["contract", "compile", "judge", "query:judge"]);
	assert.equal(builderTurns, 2, "pending state resumed in the same builder session after a normal turn return");
	assert.equal(harness.runner.created.filter(spec => spec.role === "execution").length, 1);
	assert.equal((await harness.controller.status(harness.goal.runId)).tasks.length, 1, "no new task bypasses the pending operation");
	assert.equal(verifications, 1);
	assert.equal(task.episode?.candidates[0].observation.correctness, "passed");
	const reviewed = await harness.controller.review(harness.goal.runId, { taskId: task.taskId,
		artifacts: [task.reportPath!], checks: [{ criterion: "candidate was observed", result: "passed", evidence: [task.reportPath!] }] });
	assert.equal(reviewed.status, "accepted");
	assert.equal(reviewed.episode?.candidates[0].observation.correctness, "passed");
	assert.equal((await harness.controller.status(harness.goal.runId)).lifecycle, "active", "a checked candidate does not itself fulfill the original goal");
});

test("a failed candidate freeze retains its bytes and later candidates use unused identities", async t => {
	const verifier: CandidateVerifier = { id: "host:freeze-retry", version: "1", async verifyTask() {
		return { sourceBinding: "verified", correctness: "passed", stage: "performance", metrics: [], limitations: [] };
	} };
	const harness = await setup(async ({ spec, tools }) => {
		if (spec.tools.kind !== "execution") return "report";
		const workRoot = spec.tools.root;
		const episodeRoot = path.join(path.dirname(workRoot), "episode");
		const evaluate = (hypothesis: string) => tools.candidate_evaluate({ sourcePaths: ["kernel.py"],
			receiptPaths: ["receipt.json"], hypothesis, changeKind: "structure", intent: "solution" });
		await writeFile(path.join(workRoot, "kernel.py"), "first frozen source");
		await assert.rejects(evaluate("missing receipt"), /ENOENT/);
		const failedSource = path.join(episodeRoot, "C001", "sources", "000-kernel.py");
		assert.equal(await readFile(failedSource, "utf8"), "first frozen source");
		await writeFile(path.join(workRoot, "kernel.py"), "second source");
		await writeFile(path.join(workRoot, "receipt.json"), '{"status":"passed"}');
		const second = JSON.parse((await evaluate("complete receipt")).text) as { candidateId: string };
		assert.equal(second.candidateId, "C002");
		await writeFile(path.join(workRoot, "kernel.py"), "third source");
		const third = JSON.parse((await evaluate("next complete candidate")).text) as { candidateId: string };
		assert.equal(third.candidateId, "C003");
		assert.equal(await readFile(failedSource, "utf8"), "first frozen source");
		const archive = JSON.parse((await tools.candidate_list({})).text) as { candidates: Array<{ candidateRef: string }> };
		assert.deepEqual(archive.candidates.map(item => item.candidateRef), ["T001/C002", "T001/C003"]);
		return "The failed freeze was retained; two complete candidates were recorded.";
	}, verifier);
	t.after(() => rm(harness.root, { recursive: true, force: true }));
	const task = await harness.controller.delegate(harness.goal.runId, { objective: "retain failed freeze and evaluate successors",
		mode: "execute", inputs: [], expectedOutputs: ["kernel.py", "receipt.json"], checks: ["complete candidates recorded"],
		executionLoop: { mode: "candidate-episode" } });
	assert.equal(task.status, "returned", task.executionFailure);
	assert.deepEqual(task.episode?.candidates.map(item => item.id), ["C002", "C003"]);
	const reviewed = await harness.controller.review(harness.goal.runId, { taskId: task.taskId,
		artifacts: [task.reportPath!], checks: [{ criterion: "complete candidates recorded", result: "passed", evidence: [task.reportPath!] }] });
	assert.equal(reviewed.status, "accepted");
	const checkpoint = await harness.controller.checkpoint(harness.goal.runId);
	const frozenGoal = JSON.parse(await readFile(checkpoint.goalSnapshotPath, "utf8")) as {
		tasks: Array<{ episode?: { candidates: Array<{ id: string; observationPath: string }> } }> };
	assert.deepEqual(frozenGoal.tasks[0].episode?.candidates.map(item => item.id), ["C002", "C003"]);
	assert.ok(frozenGoal.tasks[0].episode?.candidates.every(item => item.observationPath.startsWith(checkpoint.rootDir)));
});

test("a slower correct exploration parent can lead to a faster child without regressing a same-basis incumbent", async t => {
	const verifier: CandidateVerifier = { id: "host:episode-performance", version: "1", async verifyTask({ receipts }) {
		const receipt = JSON.parse(await readFile(receipts[0].frozenPath, "utf8")) as { latency: number; basis: string; subject?: string };
		return { sourceBinding: "verified", correctness: "passed", stage: "performance", metrics: [{ name: "latency", value: receipt.latency, unit: "ms", basisId: receipt.basis, direction: "lower" }],
			...(receipt.subject ? { executionFacts: { evaluations: [{ externalId: "foreign-evaluation", subjectId: receipt.subject,
				status: "Accepted", terminal: true, capturedAt: "2026-10-18T00:00:00Z", receiptIndex: 0, cases: [], diagnostics: [] }] } } : {}),
			limitations: [] };
	} };
	const harness = await setup(async ({ spec, tools }) => {
		if (spec.tools.kind !== "execution") return "report";
		const workRoot = spec.tools.root;
		const evaluate = async (label: string, latency: number, basis: string, parentCandidateId?: string, subject?: string,
			intent: "solution" | "diagnostic" = "solution") => {
			await writeFile(path.join(workRoot, "kernel.py"), label);
			await writeFile(path.join(workRoot, "receipt.json"), JSON.stringify({ latency, basis, subject }));
			return JSON.parse((await tools.candidate_evaluate({ sourcePaths: ["kernel.py"], receiptPaths: ["receipt.json"], hypothesis: label, changeKind: "structure", intent, ...(parentCandidateId ? { parentCandidateId } : {}) })).text) as { candidateId: string;
				incumbents: Array<{ candidateId: string; subjectId?: string; metric: { basisId: string } }>;
				searchBrief: { focus: { basisId?: string }; readLeads: { args: { section: string; basisId?: string } } } };
		};
		const slow = await evaluate("slow valid parent", 10, "A");
		await evaluate("faster child", 8, "A", slow.candidateId);
		await evaluate("slower branch", 12, "A", slow.candidateId);
		const latest = await evaluate("different basis", 1, "B", slow.candidateId);
		assert.equal(latest.searchBrief.focus.basisId, undefined, "no case-level facts means no inferred case basis");
		const foreign = await evaluate("foreign receipt", 0.1, "A", undefined, "another-operator");
		assert.deepEqual(foreign.incumbents.map(item => [item.subjectId, item.metric.basisId, item.candidateId]),
			[["operator", "A", "C002"], ["operator", "B", "C004"]],
			"a faster metric for another subject cannot replace this task's local best");
		const diagnostic = await evaluate("correct diagnostic experiment", 7, "A", undefined, undefined, "diagnostic");
		assert.deepEqual(diagnostic.incumbents.map(item => [item.subjectId, item.metric.basisId, item.candidateId]),
			[["operator", "A", "C006"], ["operator", "B", "C004"]],
			"a verified correct diagnostic experiment improves the local incumbent despite its intent label");
		const leadPage = JSON.parse((await tools.candidate_list({ section: "search-leads" })).text) as { total: number; rows: unknown[] };
		assert.equal(leadPage.total, 0, "top-level metrics alone do not fabricate case-level Pareto evidence");
		const restored = JSON.parse((await tools.candidate_checkout({ candidateRef: `T001/${slow.candidateId}` })).text) as { sourcePaths: string[] };
		assert.equal(await readFile(path.join(workRoot, restored.sourcePaths[0]), "utf8"), "slow valid parent");
		return "All six actual receipt observations were recorded.";
	}, verifier);
	t.after(() => rm(harness.root, { recursive: true, force: true }));
	const task = await harness.controller.delegate(harness.goal.runId, { objective: "explore valid candidates", subjectId: "operator", mode: "execute", inputs: [], expectedOutputs: ["kernel.py", "receipt.json"], checks: ["candidate history recorded"], executionLoop: { mode: "candidate-episode" } });
	assert.equal(task.status, "returned", task.executionFailure);
	assert.equal(task.episode?.currentCandidateId, "C006");
	assert.equal(task.episode?.candidates[1].parentCandidateId, "C001");
	assert.equal(task.episode?.candidates.length, 6, "foreign observation remains in the original history");
	assert.deepEqual(task.episode?.candidates.map(item => item.policy?.guard),
		["keep", "keep", "revert", "accept", "accept", "keep"],
		"the host decides every candidate's guard state deterministically");
	assert.deepEqual(task.episode?.candidates.map(item => item.policy?.phase),
		["bootstrap", "tuning", "tuning", "tuning", "bootstrap", "tuning"],
		"bootstrap ends per subject, so the foreign subject starts its own");
	assert.equal(task.episode?.candidates[2].policy?.requiredFix.length, 1,
		"a regression names exactly one must-fix item");
	assert.deepEqual(task.episode?.incumbents.map(item => [item.subjectId, item.metric.basisId, item.candidateId]),
		[["operator", "A", "C006"], ["operator", "B", "C004"]]);
	const reviewed = await harness.controller.review(harness.goal.runId, { taskId: task.taskId, artifacts: [task.reportPath!], checks: [{ criterion: "candidate history recorded", result: "passed", evidence: [task.reportPath!] }] });
	assert.equal(reviewed.status, "accepted");
	assert.ok(reviewed.review?.artifacts.some(item => item.path === reviewed.episode?.candidates[1].observationPath));
});

test("repeated-source feedback uses frozen bytes and unique external results without rerunning evaluation", async t => {
	let calls = 0;
	const verifier: CandidateVerifier = { id: "host:repeat", version: "1", async verifyTask({ receipts }) {
		calls++;
		const result = JSON.parse(await readFile(receipts[0].frozenPath, "utf8")) as { id: string; score: number };
		return { sourceBinding: "verified", correctness: "passed", stage: "performance",
			metrics: [{ name: "score", value: result.score, unit: "points", direction: "higher", basisId: "score-v1" }],
			executionFacts: { evaluations: [{ externalId: result.id, subjectId: "operator", status: "Accepted", terminal: true,
				capturedAt: "2026-10-18T00:00:00Z", receiptIndex: 0, diagnostics: [], cases: [{ caseId: "small", status: "Accepted",
					correctness: "passed", metrics: [{ name: "latency", value: 100 - result.score, unit: "us", direction: "lower", basisId: "device-context" }] }] }] },
			limitations: [] };
	} };
	const harness = await setup(async ({ spec, tools }) => {
		if (spec.tools.kind !== "execution") return "report";
		const workRoot = spec.tools.root;
		const evaluate = async (file: string, source: string, id: string, score: number) => {
			await writeFile(path.join(workRoot, file), source);
			await writeFile(path.join(workRoot, "receipt.json"), JSON.stringify({ id, score }));
			return JSON.parse((await tools.candidate_evaluate({ sourcePaths: [file], receiptPaths: ["receipt.json"],
				hypothesis: "inspect retained observations", changeKind: "parameters", intent: "solution" })).text);
		};
		await evaluate("first.py", "original", "result-one", 90);
		const repeated = await evaluate("renamed.py", "original", "result-two", 92);
		assert.equal(repeated.searchBrief.repeatedSourceObservationCount, 2);
		assert.equal(repeated.searchBrief.repeatedSourceObservations[0].measurements, undefined, "immediate feedback is a summary");
		await evaluate("renamed.py", "original", "result-two", 92);
		await evaluate("changed.py", "changed!", "result-three", 99);
		const page = JSON.parse((await tools.candidate_list({ ...repeated.searchBrief.readRepeatedSourceObservations.args, limit: 1 })).text);
		assert.equal(page.section, "repeated-source");
		assert.equal(page.total, 2);
		assert.equal(page.nextOffset, 1);
		assert.deepEqual([page.rows[0].sourceGroupRef, page.rows[0].count, page.rows[0].min, page.rows[0].median, page.rows[0].max],
			["T001/C001", 2, 90, 91, 92]);
		assert.deepEqual(page.rows[0].measurements[1].candidateRefs, ["T001/C002", "T001/C003"]);
		const next = JSON.parse((await tools.candidate_list({ section: "repeated-source", offset: page.nextOffset, limit: 1 })).text);
		assert.equal(next.rows[0].scope, "case");
		assert.equal(next.nextOffset, null);
		assert.equal(JSON.parse((await tools.candidate_list({ section: "repeated-source", basisId: "missing" })).text).total, 0);
		const all = JSON.parse((await tools.candidate_list({})).text);
		assert.deepEqual(all.candidates.map((item: { sourceGroupRef: string }) => item.sourceGroupRef),
			["T001/C001", "T001/C001", "T001/C001", "T001/C004"]);
		assert.equal(all.globalBest[0].metric.value, 99, "descriptive repetitions do not change the score criterion or best");
		return "Inspected original frozen observations.";
	}, verifier);
	t.after(() => rm(harness.root, { recursive: true, force: true }));
	const task = await harness.controller.delegate(harness.goal.runId, { objective: "inspect repeated measurements", subjectId: "operator",
		mode: "execute", inputs: [], expectedOutputs: ["changed.py", "receipt.json"], checks: ["evidence retained"], executionLoop: { mode: "candidate-episode" } });
	assert.equal(task.status, "returned", task.executionFailure);
	assert.equal(calls, 4, "archive reads reuse the four original verifier calls");
});

test("a later task can retrieve a near miss and derive from an exact frozen parent while preserving global best by basis", async t => {
	const verifier: CandidateVerifier = { id: "host:cross-task", version: "1", async verifyTask({ sources, receipts }) {
		const source = await readFile(sources[0].frozenPath, "utf8");
		const receipt = JSON.parse(await readFile(receipts[0].frozenPath, "utf8")) as { status: string; latency?: number; basis?: string };
		return { sourceBinding: "verified", correctness: receipt.status === "passed" && source !== "broken" ? "passed" : "failed",
			stage: receipt.status === "passed" ? "performance" : "numerical",
			metrics: receipt.latency === undefined ? [] : [{ name: "latency", value: receipt.latency, unit: "ms", basisId: receipt.basis!, direction: "lower" }],
			limitations: [] };
	} };
	let taskNumber = 0;
	const harness = await setup(async ({ spec, tools }) => {
		if (spec.tools.kind !== "execution") return "report";
		const workRoot = spec.tools.root;
		taskNumber++;
		if (taskNumber === 1) {
			await writeFile(path.join(workRoot, "kernel.py"), "broken");
			await writeFile(path.join(workRoot, "receipt.json"), JSON.stringify({ status: "failed" }));
			await tools.candidate_evaluate({ sourcePaths: ["kernel.py"], receiptPaths: ["receipt.json"], hypothesis: "near miss", changeKind: "repair", intent: "diagnostic" });
			await writeFile(path.join(workRoot, "kernel.py"), "slow correct");
			await writeFile(path.join(workRoot, "receipt.json"), JSON.stringify({ status: "passed", latency: 10, basis: "A" }));
			await tools.candidate_evaluate({ sourcePaths: ["kernel.py"], receiptPaths: ["receipt.json"], hypothesis: "safe baseline", changeKind: "structure", intent: "solution" });
			return "Recorded a negative and a valid baseline.";
		}
		if (taskNumber === 3) {
			const evaluate = async (source: string) => {
				await writeFile(path.join(workRoot, "kernel.py"), source);
				await writeFile(path.join(workRoot, "receipt.json"), JSON.stringify({ status: "passed", latency: 10, basis: "A" }));
				return JSON.parse((await tools.candidate_evaluate({ sourcePaths: ["kernel.py"], receiptPaths: ["receipt.json"],
					hypothesis: source, changeKind: "structure", intent: "solution" })).text) as {
					candidateRef: string; identicalSourceRefs: string[]; sourceRepetition: string | null };
			};
			const firstForOtherSubject = await evaluate("slow correct");
			assert.ok(firstForOtherSubject.identicalSourceRefs.includes("T001/C002"), "cross-subject byte identity remains visible");
			assert.equal(firstForOtherSubject.sourceRepetition, null, "another subject's source is not a cycle for this subject");
			await evaluate("new subject route");
			assert.equal((await evaluate("slow correct")).sourceRepetition, "code_cycle", "returning to this subject's older source is a cycle");
			assert.equal((await evaluate("slow correct")).sourceRepetition, "duplicate_code", "the immediately repeated source remains a duplicate");
			return "Cross-subject bytes and same-subject repetition were distinguished.";
		}
		const list = JSON.parse((await tools.candidate_list({})).text) as { candidates: Array<{ candidateRef: string }>; globalBest: Array<{ candidateRef: string; metric: { basisId: string } }> };
		assert.deepEqual(list.candidates.map(item => item.candidateRef), ["T001/C001", "T001/C002"]);
		assert.deepEqual(list.globalBest.map(item => [item.metric.basisId, item.candidateRef]), [["A", "T001/C002"]]);
		const secondPage = JSON.parse((await tools.candidate_list({ offset: 1, limit: 1 })).text) as { total: number; candidates: Array<{ candidateRef: string }>; nextOffset: number | null };
		assert.equal(secondPage.total, 2);
		assert.deepEqual(secondPage.candidates.map(item => item.candidateRef), ["T001/C002"]);
		assert.equal(secondPage.nextOffset, null);
		const nearMiss = JSON.parse((await tools.candidate_read({ candidateRef: "T001/C001" })).text) as { sources: Array<{ fileIndex: number; bytes: number }>; observation: { correctness: string } };
		assert.equal(nearMiss.observation.correctness, "failed");
		assert.equal(nearMiss.sources[0].fileIndex, 0);
		const nearMissSource = JSON.parse((await tools.candidate_read({ candidateRef: "T001/C001", kind: "source", fileIndex: 0, offset: 0, limit: 3 })).text) as { text: string; nextOffset: number };
		assert.equal(nearMissSource.text, "bro");
		const nearMissRemainder = JSON.parse((await tools.candidate_read({ candidateRef: "T001/C001", kind: "source", fileIndex: 0, offset: nearMissSource.nextOffset })).text) as { text: string };
		assert.equal(nearMissSource.text + nearMissRemainder.text, "broken");
		const nearMissCopy = JSON.parse((await tools.candidate_checkout({ candidateRef: "T001/C001" })).text) as { sourcePaths: string[]; receiptPaths: string[] };
		assert.equal(await readFile(path.join(workRoot, nearMissCopy.sourcePaths[0]), "utf8"), "broken");
		assert.equal(JSON.parse(await readFile(path.join(workRoot, nearMissCopy.receiptPaths[0]), "utf8")).status, "failed");
		const baselineCopy = JSON.parse((await tools.candidate_checkout({ candidateRef: "T001/C002" })).text) as { sourcePaths: string[] };
		assert.equal(await readFile(path.join(workRoot, baselineCopy.sourcePaths[0]), "utf8"), "slow correct");
		await writeFile(path.join(workRoot, "kernel.py"), "faster correct");
		await writeFile(path.join(workRoot, "receipt.json"), JSON.stringify({ status: "passed", latency: 8, basis: "A" }));
		const first = JSON.parse((await tools.candidate_evaluate({ sourcePaths: ["kernel.py"], receiptPaths: ["receipt.json"],
			hypothesis: "a structural edit improves A", changeKind: "structure", intent: "solution", parentCandidateId: "T001/C002",
			conditions: ["basis A", "same evaluation target"], changeSummary: "replace slow path" })).text) as {
			candidateRef: string; parentRef: { taskId: string; candidateId: string };
			parentComparison: { comparableMetrics: Array<{ parentValue: number; candidateValue: number; improved: boolean }> };
		};
		assert.equal(first.candidateRef, "T002/C001");
		assert.deepEqual(first.parentRef, { taskId: "T001", candidateId: "C002" });
		assert.deepEqual(first.parentComparison.comparableMetrics.map(item => [item.parentValue, item.candidateValue, item.improved]), [[10, 8, true]]);
		await writeFile(path.join(workRoot, "receipt.json"), JSON.stringify({ status: "passed", latency: 1, basis: "B" }));
		const second = JSON.parse((await tools.candidate_evaluate({ sourcePaths: ["kernel.py"], receiptPaths: ["receipt.json"],
			hypothesis: "measure another basis", changeKind: "parameters", intent: "solution", parentCandidateId: "T002/C001" })).text) as { identicalSourceRefs: string[]; sourceRepetition: string };
		assert.ok(second.identicalSourceRefs.includes("T002/C001"), "equal bytes are recorded without rejecting a new receipt");
		assert.equal(second.sourceRepetition, "duplicate_code");
		const updated = JSON.parse((await tools.candidate_list({})).text) as { globalBest: Array<{ candidateRef: string; metric: { basisId: string } }> };
		assert.deepEqual(updated.globalBest.map(item => [item.metric.basisId, item.candidateRef]), [["A", "T002/C001"], ["B", "T002/C002"]]);
		return "A new candidate improved A; B remains separate.";
	}, verifier);
	t.after(() => rm(harness.root, { recursive: true, force: true }));
	const first = await harness.controller.delegate(harness.goal.runId, { objective: "find baseline and near miss", subjectId: "operator", mode: "execute", inputs: [], expectedOutputs: ["kernel.py", "receipt.json"], checks: ["candidate history recorded"], executionLoop: { mode: "candidate-episode" } });
	const firstReview = await harness.controller.review(harness.goal.runId, { taskId: first.taskId, artifacts: [first.reportPath!], checks: [{ criterion: "candidate history recorded", result: "passed", evidence: [first.reportPath!] }] });
	assert.equal(firstReview.status, "accepted");
	const second = await harness.controller.delegate(harness.goal.runId, { objective: "continue from prior candidate", subjectId: "operator", mode: "execute", inputs: [], expectedOutputs: ["kernel.py", "receipt.json"], checks: ["candidate history recorded"], executionLoop: { mode: "candidate-episode" } });
	assert.equal(second.status, "returned", second.executionFailure);
	assert.deepEqual(second.episode?.checkouts?.map(item => item.candidateRef), ["T001/C001", "T001/C002"]);
	assert.deepEqual(second.episode?.candidates[0].conditions, ["basis A", "same evaluation target"]);
	assert.equal(second.episode?.candidates[0].changeSummary, "replace slow path");
	const secondReview = await harness.controller.review(harness.goal.runId, { taskId: second.taskId, artifacts: [second.reportPath!], checks: [{ criterion: "candidate history recorded", result: "passed", evidence: [second.reportPath!] }] });
	assert.equal(secondReview.status, "accepted");
	const checkpoint = await harness.controller.checkpoint(harness.goal.runId);
	const frozenGoal = JSON.parse(await readFile(checkpoint.goalSnapshotPath, "utf8")) as { tasks: Array<{ episode?: { candidates: Array<{ parentRef?: { taskId: string; candidateId: string }; observationPath: string }> } }> };
	assert.deepEqual(frozenGoal.tasks[1].episode?.candidates[0].parentRef, { taskId: "T001", candidateId: "C002" });
	assert.ok(frozenGoal.tasks[1].episode?.candidates[0].observationPath.startsWith(checkpoint.rootDir));
	const third = await harness.controller.delegate(harness.goal.runId, { objective: "try the same bytes on another subject", subjectId: "another-operator", mode: "execute", inputs: [], expectedOutputs: ["kernel.py", "receipt.json"], checks: ["candidate history recorded"], executionLoop: { mode: "candidate-episode" } });
	assert.equal(third.status, "returned", third.executionFailure);
});

test("checkout preserves a frozen multi-file candidate's relative imports in an independent writable folder", async t => {
	const verifier: CandidateVerifier = { id: "host:multi-file", version: "1", async verifyTask({ sources, receipts }) {
		assert.equal(sources.length, 2);
		assert.equal(receipts.length, 1);
		return { sourceBinding: "verified", correctness: "passed", stage: "performance", metrics: [], limitations: [] };
	} };
	const backend: CandidateExecutionBackend = { id: "host:multi-file-runner", version: "1", stages: [
		{ id: "judge", checks: ["correctness", "measurement"], mode: "local" },
	], async executeStage(ctx) {
		const receipt = path.join(ctx.outputDir, "evaluation.json");
		await writeFile(receipt, '{"status":"passed"}\n');
		const relative = path.relative(ctx.workDir, receipt);
		return { status: "passed", performedChecks: ctx.stage.checks,
			receiptPaths: [relative], evaluationReceiptPaths: [relative] };
	} };
	let invocation = 0;
	const harness = await setup(async ({ spec, tools }) => {
		if (spec.tools.kind !== "execution") return "report";
		invocation++;
		const root = spec.tools.root;
		if (invocation === 1) {
			await mkdir(path.join(root, "src"), { recursive: true });
			await mkdir(path.join(root, "include"), { recursive: true });
			await writeFile(path.join(root, "src/kernel.mjs"), 'import { value } from "../include/common.mjs"; export default value + 1;\n');
			await writeFile(path.join(root, "include/common.mjs"), "export const value = 41;\n");
			await writeFile(path.join(root, "receipts.json"), '{"status":"passed"}\n');
			await tools.candidate_evaluate({ sourcePaths: ["src/kernel.mjs", "include/common.mjs"], receiptPaths: ["receipts.json"],
				hypothesis: "same relative import tree", changeKind: "structure", intent: "solution" });
			return "Frozen two-file candidate.";
		}
		if (invocation === 2) {
			const outside = await mkdtemp(path.join(tmpdir(), "m07-checkout-escape-"));
			const link = path.join(root, "candidate-checkouts");
			try {
				await symlink(outside, link, "dir");
				await assert.rejects(tools.candidate_checkout({ candidateRef: "T001/C001" }), /checkout directory is not a real directory/);
				assert.deepEqual(await readdir(outside), []);
			} finally {
				await rm(link, { force: true });
				await rm(outside, { recursive: true, force: true });
			}
		}
		const checkout = JSON.parse((await tools.candidate_checkout({ candidateRef: invocation === 3 ? "T002/C001" : "T001/C001" })).text) as {
			sourcePaths: string[]; receiptPaths: string[];
		};
		const kernel = checkout.sourcePaths.find(file => file.endsWith("/sources/src/kernel.mjs"));
		const header = checkout.sourcePaths.find(file => file.endsWith("/sources/include/common.mjs"));
		assert.ok(kernel && header);
		assert.equal(path.resolve(root, path.dirname(kernel), "../include/common.mjs"), path.resolve(root, header));
		assert.equal((await import(pathToFileURL(path.join(root, kernel)).href)).default, 42);
		if (invocation === 2) assert.match(checkout.receiptPaths[0], /\/receipts\/receipts\.json$/);
		assert.equal(JSON.parse(await readFile(path.join(root, checkout.receiptPaths[0]), "utf8")).status, "passed");
		if (invocation === 2) {
			const result = JSON.parse((await tools.candidate_run({ runId: "second-generation", sourcePaths: checkout.sourcePaths,
				protocolId: "fixture", configJson: "{}", hypothesis: "same linked code through host runner",
				changeKind: "structure", intent: "solution", parentCandidateId: "T001/C001" })).text) as { status: string; evaluation?: string };
			assert.equal(result.status, "completed");
			assert.ok(result.evaluation);
		}
		if (invocation === 3) {
			assert.equal(checkout.sourcePaths.filter(file => file.includes("candidate-checkouts/")).length, 2);
			assert.ok(checkout.sourcePaths.every(file => file.split("candidate-checkouts/").length === 2), "one current checkout container only");
			assert.ok(checkout.sourcePaths.every(file => !file.includes(".candidate-runs/")), "runner snapshots are not nested into logical sources");
			await writeFile(path.join(root, "checkout2.md"), "Second generation retained the original source layout.\n");
			return "Checked out the next generation without nesting host containers.";
		}
		await writeFile(path.join(root, "checkout.md"), "The copied module resolves its original relative import.\n");
		return "Checked out the original executable file layout.";
	}, verifier, backend);
	t.after(() => rm(harness.root, { recursive: true, force: true }));
	const first = await harness.controller.delegate(harness.goal.runId, { objective: "freeze linked files", mode: "execute", inputs: [],
		expectedOutputs: ["src/kernel.mjs", "include/common.mjs", "receipts.json"], checks: ["candidate recorded"], executionLoop: { mode: "candidate-episode" } });
	assert.equal(first.status, "returned", first.executionFailure);
	await harness.controller.review(harness.goal.runId, { taskId: first.taskId, artifacts: [first.reportPath!],
		checks: [{ criterion: "candidate recorded", result: "passed", evidence: [first.reportPath!] }] });
	const second = await harness.controller.delegate(harness.goal.runId, { objective: "reuse linked files", mode: "execute", inputs: [],
		expectedOutputs: ["checkout.md"], checks: ["layout restored"], executionLoop: { mode: "candidate-episode" } });
	assert.equal(second.status, "returned", second.executionFailure);
	await harness.controller.review(harness.goal.runId, { taskId: second.taskId, artifacts: [second.reportPath!],
		checks: [{ criterion: "layout restored", result: "passed", evidence: [second.reportPath!] }] });
	const third = await harness.controller.delegate(harness.goal.runId, { objective: "restore second-generation linked files", mode: "execute", inputs: [],
		expectedOutputs: ["checkout2.md"], checks: ["layout stable"], executionLoop: { mode: "candidate-episode" } });
	assert.equal(third.status, "returned", third.executionFailure);
	const retained = await harness.controller.status(harness.goal.runId);
	assert.deepEqual((await candidateSearchSnapshot(retained)).available.map(entry => entry.sourceGroupRef),
		["T001/C001", "T001/C001"], "host checkout containers do not alter the original multi-file identity");
	// Only the in-memory declaration changes: identical bytes with a different
	// import layout must not become one repeated-source observation group.
	retained.tasks[1].episode!.candidates[0].sourcePaths = ["other/kernel.mjs", "include/common.mjs"];
	assert.deepEqual((await candidateSearchSnapshot(retained)).available.map(entry => entry.sourceGroupRef),
		["T001/C001", "T002/C001"]);
});

test("large case and diagnostic feedback is indexed while candidate_read retains every original fact", async t => {
	const rawText = `compiler output\n${"line with details\n".repeat(5000)}TAIL: original diagnostic evidence`;
	const facts = { evaluations: [{ externalId: "existing-42", subjectId: "operator", status: "WrongAnswer", terminal: true,
		capturedAt: "2026-10-18T00:00:00Z", receiptIndex: 0,
		cases: Array.from({ length: 500 }, (_, index) => ({ caseId: `case-${index}`, status: index === 499 ? "WrongAnswer" : "Accepted",
			correctness: index === 499 ? "failed" as const : "passed" as const,
			metrics: [{ name: "latency", value: index + 1, unit: "us", basisId: "original", direction: "lower" as const }] })),
		diagnostics: Array.from({ length: 30 }, (_, index) => ({ category: index === 29 ? "numerical" as const : "compile" as const,
			fieldPath: `diagnostics[${index}].text`, caseId: "case-499", rawText: index === 0 ? rawText : `original evidence ${index}` })),
	}] };
	const receipt = JSON.stringify(facts);
	let calls = 0;
	const verifier: CandidateVerifier = { id: "host:large-feedback", version: "1", async verifyTask() {
		calls++;
		return { sourceBinding: "verified", correctness: "failed", stage: "numerical", metrics: [
			{ name: "score", value: 91.8, unit: "points", basisId: "original", direction: "higher" }],
			goalChecks: [{ criterion: "original criterion", result: "failed" }],
			executionFacts: facts, limitations: ["The original correctness check failed."] };
	} };
	const harness = await setup(async ({ spec, tools }) => {
		if (spec.tools.kind !== "execution") return "report";
		await writeFile(path.join(spec.tools.root, "kernel.py"), "candidate");
		await writeFile(path.join(spec.tools.root, "receipt.json"), receipt);
		const result = await tools.candidate_evaluate({ sourcePaths: ["kernel.py"], receiptPaths: ["receipt.json"],
			hypothesis: "inspect a large negative result", changeKind: "repair", intent: "solution" });
		assert.ok(result.text.length < 22000, "immediate feedback must not repeat the raw receipt or all case bodies");
		const projected = JSON.parse(result.text);
		assert.equal(projected.observation.correctness, "failed");
		assert.equal(projected.observation.goalChecks[0].result, "failed");
		assert.equal(projected.observation.metrics[0].value, 91.8);
		assert.equal(projected.diagnosticSummary.stage, "mixed-failure");
		assert.equal(projected.diagnosticSummary.cases.failed, 1);
		assert.equal(projected.diagnosticSummary.diagnostics.compile, 29);
		assert.equal(projected.diagnosticSummary.omittedDiagnosticLocations, 24);
		assert.deepEqual(projected.incumbents, [], "reported score cannot admit a failed candidate");
		assert.equal(projected.searchBrief.focus.subjectId, "operator");
		assert.equal(projected.searchBrief.focus.basisId, undefined,
			"the default view must not assume all cases share one measurement basis");
		assert.equal(projected.searchBrief.independentLeadCount, 499);
		assert.equal(projected.searchBrief.leads[0].bindings[0].solutionParentEligible, false,
			"a passed case in a failed candidate is diagnostic, not a solved parent");
		const focusedLeads = JSON.parse((await tools.candidate_list(projected.searchBrief.readLeads.args)).text);
		assert.equal(focusedLeads.total, 499);
		assert.equal(focusedLeads.rows[0].candidateRefs[0], projected.candidateRef);
		const evaluation = projected.observation.executionFacts.evaluations[0];
		assert.equal(evaluation.cases.total, 500);
		assert.equal(evaluation.cases.correctnessCounts.failed, 1);
		assert.equal(evaluation.cases.index[0].caseId, "case-499", "late negative case remains visible");
		assert.equal(evaluation.cases.omittedIndexEntries, 500 - evaluation.cases.index.length);
		assert.equal(evaluation.diagnostics.total, 30);
		assert.ok(evaluation.diagnostics.omittedIndexEntries > 0);
		assert.ok(evaluation.diagnostics.index.some((item: { category: string }) => item.category === "numerical"));
		assert.ok(evaluation.diagnostics.omittedRawTextChars > rawText.length - 400);
		assert.doesNotMatch(result.text, /TAIL: original diagnostic evidence/);
		const readAll = async (kind: string) => {
			let offset = 0, joined = "";
			while (true) {
				const page = JSON.parse((await tools.candidate_read({ candidateRef: projected.candidateRef, kind, offset, limit: 12000 })).text);
				assert.equal(page.returnedRange.offset, offset);
				joined += page.text;
				if (page.nextOffset === null) { assert.equal(joined.length, page.returnedRange.total); break; }
				offset = page.nextOffset;
			}
			return joined;
		};
		const complete = await readAll(projected.projection.read.args.kind);
		assert.equal(complete.length, projected.projection.fullObservationChars);
		assert.deepEqual(JSON.parse(complete).observation.executionFacts, facts);
		assert.equal(JSON.parse(complete).diagnosticSummary.diagnosticLocations.length, 30);
		const search = JSON.parse((await tools.candidate_list({ section: "case-frontiers", limit: 1 })).text);
		assert.equal(search.search.caseFrontierCount, 499);
		assert.equal(search.total, 499);
		assert.equal(search.rows.length, 1);
		assert.equal(search.nextOffset, 1);
		assert.equal(search.rows[0].frontierCount, 1);
		const members = JSON.parse((await tools.candidate_list({ section: "case-members", caseIndex: 0, limit: 1 })).text);
		assert.equal(members.total, 1);
		assert.equal(members.rows[0].candidateRef, projected.candidateRef);
		assert.equal(await readAll("receipt"), receipt, "original receipt is independently readable without truncation");
		return "Read the full negative evidence through the existing range tool.";
	}, verifier);
	t.after(() => rm(harness.root, { recursive: true, force: true }));
	const task = await harness.controller.delegate(harness.goal.runId, { objective: "inspect original large feedback", mode: "execute", inputs: [],
		expectedOutputs: ["kernel.py", "receipt.json"], checks: ["candidate recorded"], executionLoop: { mode: "candidate-episode" } });
	assert.equal(task.status, "returned", task.executionFailure);
	assert.equal(calls, 1, "paging evidence must not trigger another host evaluation");
	assert.deepEqual(task.episode?.candidates[0].observation.executionFacts, facts);
});

test("unqueryable candidate results hand control back after queued tools settle, retaining evidence for host reconciliation", { timeout: 10_000 }, async t => {
	for (const toolName of ["candidate_run", "candidate_sweep"] as const) await t.test(toolName, async t => {
		let submissions = 0, aborts = 0, builderTurns = 0, backendActive = false, disposed = false;
		let toolOutcomes: string[] = [];
		let finishTools!: () => void;
		const toolsSettled = new Promise<void>(resolve => { finishTools = resolve; });
		const backend: CandidateExecutionBackend = { id: "host:unknown-without-id", version: "1", stages: [
			{ id: "judge", checks: ["compile", "correctness", "measurement"], mode: "delegated" },
		], async executeStage(ctx) {
			submissions++; backendActive = true;
			try {
				const file = path.join(ctx.outputDir, "unknown.json");
				await writeFile(file, '{"submissionRequestSent":true,"safeToRetry":false,"status":"unknown"}\n');
				return { status: "unknown", receiptPaths: [path.relative(ctx.workDir, file)], evaluationReceiptPaths: [] };
			} finally { backendActive = false; }
		} };
		const verifier: CandidateVerifier = { id: "host:unknown-verifier", version: "1", async verifyTask() {
			throw new Error("unknown execution must not be evaluated");
		} };
		const harness = await setup(async ({ spec, tools }) => {
			if (spec.tools.kind !== "execution") return "report";
			builderTurns++;
			await writeFile(path.join(spec.tools.root, "kernel.txt"), toolName === "candidate_sweep" ? "tile={{tile}}\n" : "original candidate bytes");
			if (builderTurns > 1) return "A separately authorized task can continue after host reconciliation.";
			const request = { runId: "original-run", sourcePaths: ["kernel.txt"], protocolId: "original-protocol",
				configJson: "{}", hypothesis: "measure original candidate", changeKind: "structure", intent: "solution",
				...(toolName === "candidate_sweep" ? { domainsJson: '{"tile":[1,2]}' } : {}) };
			try {
				// Both wrappers are entered before the internally serialized backend runs.
				// The second call rejects after the first returns its unknown result.
				const results = await Promise.allSettled([tools[toolName](request),
					tools.candidate_run({ ...request, runId: "queued-new-run" })]);
				toolOutcomes = results.map(result => result.status);
			} finally { finishTools(); }
			return new Promise<never>(() => {}); // The child does not voluntarily end its prompt.
		}, verifier, backend);
		t.after(() => rm(harness.root, { recursive: true, force: true }));
		const create = harness.runner.create.bind(harness.runner);
		harness.runner.create = async (...args) => {
			const handle = await create(...args);
			return { ...handle, prompt: async (message: string) => {
				try { return await handle.prompt(message); }
				catch (error) {
					if (toolName === "candidate_sweep" && aborts) throw new HarnessError("runner.aborted",
						"session fixture was aborted during prompt; SDK abort failed: fixture SDK abort failure");
					throw error;
				}
			}, abort: async () => {
				aborts++;
				assert.equal(backendActive, false, "never abort an executing external stage");
				await handle.abort();
				if (toolName === "candidate_run") throw new Error("fixture abort acknowledgement failed");
			}, dispose: () => { disposed = true; handle.dispose(); } };
		};
		const taskSpec = { objective: "measure candidate", mode: "execute" as const, inputs: [], expectedOutputs: ["kernel.txt"],
			checks: ["candidate recorded"], executionLoop: { mode: "candidate-episode" as const } };
		const failed = await harness.controller.delegate(harness.goal.runId, taskSpec);
		await toolsSettled;
		assert.deepEqual(toolOutcomes, ["fulfilled", "rejected"]);
		assert.equal(failed.status, "failed");
		assert.match(failed.executionFailure!, /不能按原 ID 查询；宿主已交还规划层对账/);
		if (toolName === "candidate_run") assert.match(failed.executionFailure!, /child abort failed: fixture abort acknowledgement failed/);
		else assert.match(failed.executionFailure!, /child prompt terminated: .*SDK abort failed: fixture SDK abort failure/);
		assert.equal(aborts, 1); assert.equal(submissions, 1); assert.equal(builderTurns, 1);
		assert.equal(disposed, true, "the child handle is disposed before main can reconcile");
		const toolLog = failed.toolLog.filter((call): call is Pick<ToolCallRecord, "name" | "ok"> =>
			typeof call === "object" && call !== null && "name" in call && typeof call.name === "string" &&
			"ok" in call && typeof call.ok === "boolean");
		assert.equal(toolLog.filter(call => call.name === toolName && call.ok).length, 1);
		assert.ok(toolLog.some(call => call.name === "candidate_run" && !call.ok), "the queued rejection remains logged");
		const goal = await harness.controller.status(harness.goal.runId);
		const operationId = goal.executionState!.operations[0].id;
		assert.equal(goal.executionState!.operations[0].status, "unknown");
		assert.equal(goal.lifecycle, "active", "a child recovery boundary must not stop the original goal");
		const journalPath = path.join(harness.ws.runDir("M07", goal.runId), "tasks", failed.taskId, "candidate-runs", "original-run",
			...(toolName === "candidate_sweep" ? ["runs", "1"] : []), "journal.json");
		const journal = JSON.parse(await readFile(journalPath, "utf8"));
		assert.equal(journal.state, "unknown"); assert.equal(journal.stages[0].externalId, undefined);
		const receiptPath = journal.stages[0].receiptSnapshots[0].frozenPath as string;
		const receipt = await readFile(receiptPath, "utf8");
		assert.equal(JSON.parse(receipt).safeToRetry, false);
		await assert.rejects(harness.controller.delegate(goal.runId, taskSpec), /未知|未终态/);
		// Simulate the existing trusted observer's independently proven not-issued
		// transition; the controller alone must not infer it from the failed request.
		journal.state = "failed"; journal.stages[0].status = "failed";
		journal.stages[0].result = { status: "failed", receiptPaths: [], evaluationReceiptPaths: [] };
		await writeFile(journalPath, JSON.stringify(journal));
		const evidencePath = path.join(harness.root, "host-not-issued.json");
		await writeFile(evidencePath, JSON.stringify({ version: 1, operationId, observationMethod: "external-query",
			observedStatus: "not-issued", observedAt: new Date().toISOString() }));
		const reconciled = await harness.controller.hostReconcileOperation(goal.runId, { operationId, evidencePath });
		assert.equal(reconciled.executionState!.operations[0].status, "not-issued");
		assert.equal(reconciled.tasks[0].executionFailure, failed.executionFailure);
		assert.equal(await readFile(receiptPath, "utf8"), receipt, "the original uncertain receipt is preserved");
		assert.equal((await harness.controller.delegate(goal.runId, taskSpec)).status, "returned");
		assert.equal(submissions, 1, "host reconciliation never replays or submits the candidate");
	});
});

test("host reconciliation queries a failed task's original candidate ID and unlocks dispatch only after terminal verification", async t => {
	let submissions = 0, queries = 0, verifications = 0, builderTurns = 0;
	const backend: CandidateExecutionBackend = { id: "host:recover-existing", version: "1", stages: [
		{ id: "judge", checks: ["compile", "correctness", "measurement"], mode: "delegated" },
	], async executeStage(ctx) {
		submissions++;
		await ctx.recordExternalId("SID-original");
		const file = path.join(ctx.outputDir, "pending.json");
		await writeFile(file, JSON.stringify({ id: "SID-original", status: "pending" }));
		return { status: "pending", externalId: "SID-original", receiptPaths: [path.relative(ctx.workDir, file)] };
	}, async queryStage(ctx) {
		queries++;
		assert.equal(ctx.externalId, "SID-original");
		assert.equal(await readFile(ctx.sources[0].absolutePath, "utf8"), "original candidate bytes");
		const status = queries === 1 ? "pending" as const : "passed" as const;
		const file = path.join(ctx.outputDir, `query-${queries}.json`);
		await writeFile(file, JSON.stringify({ id: "SID-original", status }));
		const relative = path.relative(ctx.workDir, file);
		return { status, externalId: "SID-original", receiptPaths: [relative], evaluationReceiptPaths: status === "passed" ? [relative] : [] };
	} };
	const verifier: CandidateVerifier = { id: "host:recovered-verifier", version: "1", async verifyTask({ sources, receipts }) {
		verifications++;
		assert.equal(await readFile(sources[0].frozenPath, "utf8"), "original candidate bytes");
		assert.deepEqual(JSON.parse(await readFile(receipts[0].frozenPath, "utf8")), { id: "SID-original", status: "passed" });
		return { sourceBinding: "verified", correctness: "passed", stage: "performance", metrics: [], limitations: [] };
	} };
	const harness = await setup(async ({ spec, tools }) => {
		if (spec.tools.kind !== "execution") return "report";
		builderTurns++;
		if (builderTurns === 1) {
			await writeFile(path.join(spec.tools.root, "kernel.txt"), "original candidate bytes");
			const result = JSON.parse((await tools.candidate_run({ runId: "original-run", sourcePaths: ["kernel.txt"], protocolId: "original-protocol",
				configJson: "{}", hypothesis: "measure original candidate", changeKind: "structure", intent: "solution" })).text);
			assert.equal(result.status, "pending");
			throw new Error("builder session lost after submission");
		}
		const archived = JSON.parse((await tools.candidate_list({})).text);
		assert.ok(JSON.stringify(archived).includes("T001/C001"), "a new task can reuse the host-recovered candidate");
		await writeFile(path.join(spec.tools.root, "next.md"), "Inspected the recovered candidate without resubmission.\n");
		return "Continue from the verified historical evidence.";
	}, verifier, backend);
	t.after(() => rm(harness.root, { recursive: true, force: true }));
	const taskSpec = { objective: "measure candidate", mode: "execute" as const, inputs: [], expectedOutputs: ["kernel.txt"],
		checks: ["candidate recorded"], executionLoop: { mode: "candidate-episode" as const } };
	const failed = await harness.controller.delegate(harness.goal.runId, taskSpec);
	assert.equal(failed.status, "failed");
	assert.match(failed.executionFailure!, /builder session lost/);
	assert.equal(failed.branchSource, undefined);
	const failedSession = failed.session!.id, failedAt = failed.returnedAt, failure = failed.executionFailure;
	const before = await harness.controller.status(harness.goal.runId);
	const operationId = before.executionState!.operations[0].id;
	assert.equal(before.executionState!.operations[0].status, "unknown");
	const evidencePath = path.join(harness.root, "existing-submission-observation.json");
	await writeFile(evidencePath, JSON.stringify({ version: 1, operationId, observationMethod: "external-query",
		observedStatus: "confirmed", observedAt: new Date().toISOString(), externalId: "SID-original" }));
	const stillPending = await harness.controller.hostReconcileOperation(harness.goal.runId, { operationId, evidencePath });
	assert.equal(stillPending.executionState!.operations[0].status, "unknown", "confirmed submission is not a terminal evaluation");
	assert.equal(stillPending.tasks[0].status, "failed");
	assert.equal(stillPending.tasks[0].episode!.candidates.length, 0);
	assert.equal(verifications, 0);
	await assert.rejects(harness.controller.delegate(harness.goal.runId, taskSpec), /未终态|未知/);
	assert.equal(harness.runner.created.filter(spec => spec.role === "execution").length, 1);
	const recovered = await harness.controller.hostReconcileOperation(harness.goal.runId, { operationId, evidencePath });
	assert.equal(recovered.executionState!.operations[0].status, "confirmed");
	assert.equal(recovered.tasks.length, 1, "reconciliation does not dispatch or replay a task");
	assert.equal(recovered.tasks[0].status, "failed", "historical task status is not rewritten as success");
	assert.equal(recovered.tasks[0].session!.id, failedSession);
	assert.equal(recovered.tasks[0].returnedAt, failedAt);
	assert.equal(recovered.tasks[0].executionFailure, failure);
	assert.equal(recovered.tasks[0].episode!.candidates.length, 1);
	const candidate = recovered.tasks[0].episode!.candidates[0];
	assert.equal(candidate.observation.sourceBinding, "verified");
	assert.equal(candidate.observation.correctness, "passed");
	assert.equal(JSON.parse(await readFile(candidate.observationPath, "utf8")).observation.correctness, "passed");
	assert.equal(submissions, 1); assert.equal(queries, 2); assert.equal(verifications, 1); assert.equal(builderTurns, 1);
	const next = await harness.controller.delegate(harness.goal.runId, { ...taskSpec, objective: "reuse recovered candidate", expectedOutputs: ["next.md"] });
	assert.equal(next.status, "returned", next.executionFailure);
	assert.equal(next.taskId, "T002");
	assert.equal(builderTurns, 2); assert.equal(submissions, 1); assert.equal(queries, 2);
});
