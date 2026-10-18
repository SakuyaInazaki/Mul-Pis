import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createCandidateExecutionTools, pendingCandidateExecutions, type CandidateExecutionBackend, type CandidateExecutionContext, type CandidateExecutionToolOptions } from "../src/m07/candidate-runner.ts";
import { readSearchEvents, rebuildSearchState, searchStateSummary } from "../src/m07/search-state/index.ts";

async function setup(t: { after(fn: () => Promise<void>): void }, backend: CandidateExecutionBackend, evaluate?: CandidateExecutionToolOptions["evaluate"]) {
	const root = await mkdtemp(path.join(tmpdir(), "candidate-runner-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const workDir = path.join(root, "work"); await mkdir(workDir);
	await writeFile(path.join(workDir, "kernel.txt"), "value={{BLOCK}}\n");
	const options: CandidateExecutionToolOptions = { goalRunId: "goal", taskId: "T001", operationId: "O001", subjectId: "subject",
		workDir, journalDir: path.join(root, "candidate-runs"), backend,
		evaluate: evaluate ?? (async args => ({ text: JSON.stringify({ candidateRef: "T001/C001", received: args.receiptPaths }) })) };
	const tools = () => Object.fromEntries(createCandidateExecutionTools(options).map(tool => [tool.name, tool]));
	return { root, workDir, options, tools };
}
const request = { runId: "run1", sourcePaths: ["kernel.txt"], protocolId: "protocol-v1", configJson: '{"dtype":"fp32"}', hypothesis: "evaluate candidate", changeKind: "structure", intent: "solution" };
async function receipt(ctx: CandidateExecutionContext, data: unknown) {
	const file = path.join(ctx.outputDir, "receipt.json"); await writeFile(file, JSON.stringify(data));
	return path.relative(ctx.workDir, file);
}

test("host cascade stops at compilation failure and archives only its explicitly verifiable negative receipt", async t => {
	const calls: string[] = [], evaluated: string[][] = [];
	const backend: CandidateExecutionBackend = { id: "local-fixture", version: "1", stages: [
		{ id: "contract", checks: ["contract"], mode: "local" }, { id: "build", checks: ["compile"], mode: "local" },
		{ id: "correct", checks: ["correctness"], mode: "local" }, { id: "measure", checks: ["measurement"], mode: "local" },
	], async executeStage(ctx) {
		calls.push(ctx.stage.id);
		const journal = JSON.parse(await readFile(path.join(path.dirname(ctx.workDir), "candidate-runs", ctx.runId, "journal.json"), "utf8"));
		assert.equal(journal.state, "running", "intent exists before backend execution");
		assert.equal(journal.stages.at(-1).status, "running");
		assert.equal(ctx.goalRunId, "goal"); assert.equal(ctx.operationId, "O001"); assert.equal(ctx.subjectId, "subject");
		assert.deepEqual(ctx.config, { dtype: "fp32" }); assert.equal(ctx.protocolId, "protocol-v1");
		const p = await receipt(ctx, { status: ctx.stage.id === "build" ? "compile-failed" : "passed" });
		return { status: ctx.stage.id === "build" ? "failed" : "passed", receiptPaths: [p], ...(ctx.stage.id === "build" ? { evaluationReceiptPaths: [p] } : {}) };
	} };
	const h = await setup(t, backend, async args => { evaluated.push(args.receiptPaths as string[]); return { text: "negative verified" }; });
	const result = JSON.parse((await h.tools().candidate_run.execute(request)).text);
	assert.equal(result.status, "failed"); assert.deepEqual(calls, ["contract", "build"]); assert.equal(evaluated.length, 1);
	assert.match(evaluated[0][0], /receipts\/build/); assert.doesNotMatch(evaluated[0][0], /contract/);
	assert.equal(result.evaluation, "negative verified");
	assert.deepEqual(result.unsupportedChecks, []);
});

test("pending delegated judge queries original ID after recreation and keeps the originally frozen source", async t => {
	let submits = 0, queries = 0;
	const backend: CandidateExecutionBackend = { id: "judge-fixture", version: "1", stages: [{ id: "judge", checks: ["compile", "correctness", "measurement"], mode: "delegated" }],
		async executeStage(ctx) { submits++; await ctx.recordExternalId("SID-1"); return { status: "pending", externalId: "SID-1", receiptPaths: [await receipt(ctx, { pending: true })] }; },
		async queryStage(ctx) { queries++; assert.equal(ctx.externalId, "SID-1"); assert.equal(await readFile(ctx.sources[0].absolutePath, "utf8"), "value={{BLOCK}}\n");
			return { status: "passed", externalId: "SID-1", receiptPaths: [await receipt(ctx, { accepted: true, score: 17 })] }; } };
	const h = await setup(t, backend);
	const first = JSON.parse((await h.tools().candidate_run.execute(request)).text);
	assert.equal(first.status, "pending"); assert.equal(first.stages[0].stage.mode, "delegated");
	const pending = await pendingCandidateExecutions({ ...h.options, backend: { ...backend, canQueryStage: () => false } });
	assert.equal(pending.length, 1); assert.equal(pending[0].queryAvailable, false);
	assert.deepEqual(first.unsupportedChecks, ["contract"]);
	await writeFile(path.join(h.workDir, "kernel.txt"), "changed original");
	await assert.rejects(h.tools().candidate_run.execute({ ...request, runId: "renamed" }), /unresolved earlier execution/);
	assert.equal(JSON.parse((await h.tools().candidate_run.execute({ runId: "run1" })).text).status, "pending");
	const resumed = JSON.parse((await h.tools().candidate_run.execute({ runId: "run1", resume: true })).text);
	assert.equal(resumed.status, "completed"); assert.equal(submits, 1); assert.equal(queries, 1);
	assert.equal(resumed.stages[0].receiptCount, 2);
	const recorded = JSON.parse(await readFile(resumed.journalPath, "utf8"));
	assert.equal(recorded.stages[0].receiptSnapshots.length, 2, "both pending and final raw receipt references survive query in the original journal");
	assert.equal(await readFile(path.join(h.root, "candidate-runs/run1/receipts/judge/1/0-receipt.json"), "utf8"), '{"pending":true}', "query does not overwrite prior receipt bytes");
	assert.match(resumed.evaluation, /T001\/C001/);
});

test("interrupted submission without an external ID is not silently retried by a new ID or resume", async t => {
	let calls = 0;
	const backend: CandidateExecutionBackend = { id: "unknown-fixture", version: "1", stages: [{ id: "judge", checks: ["compile", "correctness", "measurement"], mode: "delegated" }],
		async executeStage() { calls++; throw new Error("transport interrupted after send"); } };
	const h = await setup(t, backend);
	assert.equal(JSON.parse((await h.tools().candidate_run.execute(request)).text).status, "unknown");
	assert.equal(JSON.parse((await h.tools().candidate_run.execute({ runId: "run1", resume: true })).text).status, "unknown");
	await assert.rejects(h.tools().candidate_run.execute({ ...request, runId: "new-run" }), /unresolved earlier execution/);
	assert.equal(calls, 1);
});

test("verification failure retries only frozen receipt verification, not completed backend side effects", async t => {
	let executions = 0, evaluations = 0;
	const backend: CandidateExecutionBackend = { id: "verify-fixture", version: "1", stages: [{ id: "judge", checks: ["compile", "correctness", "measurement"], mode: "delegated" }],
		async executeStage(ctx) { executions++; return { status: "passed", receiptPaths: [await receipt(ctx, { accepted: true })] }; } };
	const h = await setup(t, backend, async () => { evaluations++; if (evaluations === 1) throw new Error("verification unavailable"); return { text: "verified" }; });
	assert.equal(JSON.parse((await h.tools().candidate_run.execute(request)).text).evaluationError, "verification unavailable");
	const resumed = JSON.parse((await h.tools().candidate_run.execute({ runId: "run1", resume: true })).text);
	assert.equal(resumed.evaluation, "verified"); assert.equal(executions, 1); assert.equal(evaluations, 2);
});

test("finite numeric sweep materializes every combination without score pruning and can continue an original pending ID", async t => {
	const values: string[] = []; let queries = 0;
	const backend: CandidateExecutionBackend = { id: "sweep-fixture", version: "1", stages: [{ id: "judge", checks: ["compile", "correctness", "measurement"], mode: "delegated" }],
		async executeStage(ctx) {
			values.push(await readFile(ctx.sources[0].absolutePath, "utf8"));
			if (values.length === 2) { await ctx.recordExternalId("second"); return { status: "pending", receiptPaths: [], externalId: "second" }; }
			return { status: "passed", receiptPaths: [await receipt(ctx, { score: values.length === 1 ? 9 : 1 })] };
		}, async queryStage(ctx) { queries++; assert.equal(ctx.externalId, "second"); return { status: "failed", receiptPaths: [await receipt(ctx, { wrong: true })] }; } };
	const h = await setup(t, backend);
	await writeFile(path.join(h.workDir, "kernel.txt"), "b={{BLOCK}} w={{WARPS}}\n");
	const args = { ...request, runId: "sweep", domainsJson: '{"BLOCK":[16,32],"WARPS":[2,4]}' };
	const first = JSON.parse((await h.tools().candidate_sweep.execute(args)).text);
	assert.equal(first.total, 4); assert.equal(first.completed, 1);
	assert.deepEqual(first.resultsPage.rows.map((row: { parameters: unknown; status: string }) =>
		[row.parameters, row.status]), [[{ BLOCK: 16, WARPS: 4 }, "pending"], [{ BLOCK: 16, WARPS: 2 }, "completed"]]);
	assert.deepEqual(first.resultsPage.rows[1].readCandidate,
		{ tool: "candidate_read", args: { candidateRef: "T001/C001" } },
		"a sweep result gives the exact archive reference accepted by candidate_read");
	const readOnly = JSON.parse((await h.tools().candidate_sweep.execute({ runId: "sweep", resultOffset: 1,
		resultLimit: 1 })).text);
	assert.equal(readOnly.resultsPage.total, 2);
	assert.deepEqual(readOnly.resultsPage.rows.map((row: { parameters: unknown }) => row.parameters),
		[{ BLOCK: 16, WARPS: 2 }]);
	assert.equal(values.length, 2, "paging an existing sweep without resume cannot execute a combination");
	await writeFile(path.join(h.workDir, "kernel.txt"), "not the frozen template");
	const recovery = createCandidateExecutionTools({ ...h.options, queryOnly: true }).find(tool => tool.name === "candidate_sweep")!;
	const reconciled = JSON.parse((await recovery.execute({ runId: "sweep", resume: true })).text);
	assert.equal(reconciled.completed, 2);
	assert.deepEqual(reconciled.resultsPage.rows[0].lastStage,
		{ id: "judge", status: "failed" }, "a failed stage remains visible by parameter combination");
	assert.equal(values.length, 2, "host reconciliation queries the original ID but cannot start unexecuted combinations");
	assert.equal(queries, 1);
	const resumed = JSON.parse((await h.tools().candidate_sweep.execute({ runId: "sweep", resume: true })).text);
	assert.equal(resumed.completed, 4); assert.equal(resumed.status, "completed"); assert.equal(queries, 1);
	assert.deepEqual(resumed.readArchive, [
		{ tool: "candidate_list", args: { section: "global-best" } },
		{ tool: "candidate_list", args: { section: "search-leads" } },
	]);
	assert.deepEqual(values, ["b=16 w=2\n", "b=16 w=4\n", "b=32 w=2\n", "b=32 w=4\n"]);
	assert.equal(resumed.resultsPage.total, 4);
	assert.deepEqual(resumed.resultsPage.rows.map((row: { parameters: unknown; protocolId: string;
		sourcePaths: string[] }) => [row.parameters, row.protocolId, row.sourcePaths[0]]), [
		[{ BLOCK: 32, WARPS: 4 }, "protocol-v1", path.join(".candidate-runs", "sweep", "materialized", "4", "kernel.txt")],
		[{ BLOCK: 32, WARPS: 2 }, "protocol-v1", path.join(".candidate-runs", "sweep", "materialized", "3", "kernel.txt")],
		[{ BLOCK: 16, WARPS: 4 }, "protocol-v1", path.join(".candidate-runs", "sweep", "materialized", "2", "kernel.txt")],
		[{ BLOCK: 16, WARPS: 2 }, "protocol-v1", path.join(".candidate-runs", "sweep", "materialized", "1", "kernel.txt")],
	]);
	const older = JSON.parse((await h.tools().candidate_sweep.execute({ runId: "sweep", resultOffset: 2,
		resultLimit: 1 })).text);
	assert.equal(older.resultsPage.nextOffset, 3);
	assert.deepEqual(older.resultsPage.rows[0].parameters, { BLOCK: 16, WARPS: 4 });
	await h.tools().candidate_sweep.execute({ runId: "sweep", resume: true });
	assert.equal(values.length, 4);
});

test("modified execution snapshot prevents later measurement and is not repaired silently", async t => {
	const calls: string[] = [];
	const backend: CandidateExecutionBackend = { id: "tamper-fixture", version: "1", stages: [{ id: "compile", checks: ["compile"], mode: "local" }, { id: "measure", checks: ["correctness", "measurement"], mode: "local" }],
		async executeStage(ctx) { calls.push(ctx.stage.id); await writeFile(ctx.sources[0].absolutePath, "mutated"); return { status: "passed", receiptPaths: [] }; } };
	const h = await setup(t, backend);
	assert.equal(JSON.parse((await h.tools().candidate_run.execute(request)).text).status, "unknown");
	assert.deepEqual(calls, ["compile"]);
});

test("host configuration help is visible and unsupported protocols reject before execution", async t => {
	let calls = 0;
	const backend: CandidateExecutionBackend = { id: "bound-protocol", version: "1", protocolIds: ["protocol-v1"], configurationHelp: "dtype must be fp32",
		stages: [{ id: "contract", checks: ["contract"], mode: "local" }], async executeStage() { calls++; return { status: "passed", receiptPaths: [] }; } };
	const h = await setup(t, backend);
	assert.match(h.tools().candidate_run.params.configJson.description, /dtype must be fp32/);
	assert.match(h.tools().candidate_sweep.description, /protocol-v1/);
	await assert.rejects(h.tools().candidate_run.execute({ ...request, protocolId: "weaker-checks" }), /unsupported protocolId/);
	assert.equal(calls, 0);
});

test("host request validation rejects before any run journal or side effect", async t => {
	let calls = 0;
	const backend: CandidateExecutionBackend = { id: "contract-preflight", version: "1", stages: [{ id: "judge", checks: ["compile", "correctness", "measurement"], mode: "delegated" }],
		validateRequest({ config }) { if (config.dtype !== "fp32") throw new Error("unsupported dtype"); },
		async executeStage(ctx) { calls++; return { status: "passed", receiptPaths: [await receipt(ctx, { accepted: true })] }; } };
	const h = await setup(t, backend);
	await assert.rejects(h.tools().candidate_run.execute({ ...request, configJson: '{"dtype":"wrong"}' }), /unsupported dtype/);
	await assert.rejects(readFile(path.join(h.root, "candidate-runs/run1/journal.json")), { code: "ENOENT" });
	assert.equal(calls, 0);
	assert.equal(JSON.parse((await h.tools().candidate_run.execute(request)).text).status, "completed");
});

test("a background run returns at once, keeps executing, and is collected by the same runId", async t => {
	let release!: () => void;
	const gate = new Promise<void>(resolve => { release = resolve; });
	const started: string[] = [];
	const backend: CandidateExecutionBackend = { id: "slow-fixture", version: "1",
		stages: [{ id: "measure", checks: ["compile", "correctness", "measurement"], mode: "local" }],
		async executeStage(ctx) {
			started.push(ctx.runId);
			if (ctx.runId === "run1") await gate;
			return { status: "passed", receiptPaths: [await receipt(ctx, { ok: ctx.runId })] };
		} };
	const h = await setup(t, backend);
	let drain: (() => Promise<void>) | undefined;
	h.options.backgroundRuns = { register: fn => { drain = fn; } };
	h.options.searchEventLogFile = path.join(h.root, "search-events.jsonl");
	const tools = h.tools();

	const submitted = JSON.parse((await tools.candidate_run.execute({ ...request, background: true })).text);
	assert.equal(submitted.state, "running");
	assert.deepEqual(submitted.collect, { tool: "candidate_run", args: { runId: "run1", collect: true } });
	// The model is free while the host keeps working: a second candidate is submitted
	// before the first one has produced anything.
	const second = JSON.parse((await tools.candidate_run.execute({ ...request, runId: "run2", background: true })).text);
	assert.equal(second.outstanding, 2);
	const listed = JSON.parse((await tools.candidate_run.execute({ collect: true })).text);
	assert.deepEqual(listed.jobs.map((job: { runId: string; state: string }) => [job.runId, job.state]),
		[["run1", "running"], ["run2", "running"]]);
	const pendingCollect = JSON.parse((await tools.candidate_run.execute({ runId: "run1", collect: true })).text);
	assert.equal(pendingCollect.state, "running");
	assert.match(pendingCollect.message, /Still running/);
	await assert.rejects(tools.candidate_run.execute({ ...request, background: true }), /still running; collect it before/);

	release();
	assert(drain);
	await drain();
	assert.deepEqual(started, ["run1", "run2"], "the host still executes candidates one at a time");
	const collected = JSON.parse((await tools.candidate_run.execute({ runId: "run1", collect: true })).text);
	assert.equal(collected.status, "completed");
	assert.equal(JSON.parse((await tools.candidate_run.execute({ runId: "run2", collect: true })).text).status, "completed");

	const { events, skipped } = await readSearchEvents(h.options.searchEventLogFile);
	assert.equal(skipped, 0);
	const state = rebuildSearchState("goal", events);
	assert.deepEqual(state.candidates.map(item => [item.id, item.isBuggy]), [["run1", false], ["run2", false]]);
	assert.deepEqual(state.candidates[0].stages.map(stage => `${stage.stage}:${stage.status}`), ["measure:passed"]);
	assert.equal(state.candidates[0].subjectId, "subject");
	assert.match(String(state.candidates[0].pathRef), /candidate-runs\/run1\/journal\.json$/);
	assert.equal(searchStateSummary(state).background.outstanding, 0);
	assert.deepEqual(events.filter(event => event.kind === "background-queued").map(event => event.candidate?.id), ["run1", "run2"]);
	assert.deepEqual(events.filter(event => event.kind === "background-settled").map(event => event.candidate?.id), ["run1", "run2"]);
});

test("background execution stays off unless the host enables it, and a restarted session collects from the journal", async t => {
	const backend: CandidateExecutionBackend = { id: "plain-fixture", version: "1",
		stages: [{ id: "measure", checks: ["compile", "correctness", "measurement"], mode: "local" }],
		async executeStage(ctx) { return { status: "passed", receiptPaths: [await receipt(ctx, { ok: true })] }; } };
	const h = await setup(t, backend);
	await assert.rejects(h.tools().candidate_run.execute({ ...request, background: true }),
		/did not enable background candidate runs/);
	assert.equal(JSON.parse((await h.tools().candidate_run.execute(request)).text).status, "completed");
	// A new tool instance has no job registry; collect falls back to the durable journal.
	const afterRestart = JSON.parse((await h.tools().candidate_run.execute({ runId: "run1", collect: true })).text);
	assert.equal(afterRestart.status, "completed");
	assert.equal(afterRestart.runId, "run1");
	await assert.rejects(h.tools().candidate_run.execute({ runId: "never-started", collect: true }), /unknown runId/);
});
