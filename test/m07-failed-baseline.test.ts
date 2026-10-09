import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { createFileKnowledgeStore } from "../src/knowledge/store.ts";
import { createM07Controller } from "../src/m07/controller.ts";
import { createLocalM07Adapter, LOCAL_M07_REASON_SCOPE } from "../src/m07/local-m07-adapter.ts";
import { createOriginalObjective } from "../src/m07/objective-progress.ts";
import type { LocalObjectiveFrozenEvidence } from "../src/m07/local-original-objective.ts";
import { FakeSessionRunner } from "../src/runner/fake.ts";
import { runM04 } from "../src/stages/m04.ts";
import type { StageContext } from "../src/stages/context.ts";
import type { StageRunRecord } from "../src/types.ts";
import { Workspace } from "../src/workspace.ts";

const begin = { goal: "Check the original claim", problemRelation: "Necessary original check",
	constraints: ["Keep the original evidence"], successCriteria: ["Evidence is checked"], plan: "Investigate" };
async function fixture(t: TestContext) {
	const root = await mkdtemp(path.join(tmpdir(), "m07-failed-baseline-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const ws = new Workspace(root);
	await mkdir(ws.rawDir, { recursive: true });
	await writeFile(ws.problemFile, "Original synthetic claim\n");
	const store = createFileKnowledgeStore(ws.knowledgeDir); await store.init();
	const runner = new FakeSessionRunner(({ spec }) => spec.label === "M04-research" ?
		"New checkpoint judged independently; no knowledge proposal." : "Original claim remains unverified.");
	const ctx: StageContext = { ws, store, runner, config: { roles: {
		execution: "fake/execution", research: "fake/research", reviewer: "fake/reviewer" }, concurrency: 1, tools: {} } };
	return { ws, store, runner, ctx, controller: createM07Controller(ctx) };
}
async function failed(t: Awaited<ReturnType<typeof fixture>>, state = "no-proposal", attempts: unknown[] = []) {
	const run = await t.ws.startRun("M04", [], (await t.store.current())?.id);
	run.failures.push("Independent judgment failed; its candidate remains unselected.");
	await t.ws.writeOutput(run, "m04-transaction.json", JSON.stringify({ version: 1,
		kind: "m04-knowledge-transaction", m04RunId: run.runId, state, attempts,
		updatedAt: new Date().toISOString() }), "M04 知识事务状态");
	await t.ws.finishRun(run, "failed");
	return run;
}
async function rejected(f: Awaited<ReturnType<typeof fixture>>) {
	const run = await f.ws.startRun("M04", []);
	const receipt = await f.store.submitProposal({ stage: "M04", runId: run.runId,
		ops: [{ op: "create", type: "E", title: "Invalid draft" }] as never });
	assert.equal(receipt.structurallyValid, false);
	const proposalFile = path.relative(f.ws.root, receipt.file).replaceAll("\\", "/");
	const validation = { version: 1, kind: "m04-proposal-validation", m04RunId: run.runId,
		proposalId: receipt.proposalId, proposalFile, structurallyValid: false, issues: receipt.issues };
	await f.ws.writeOutput(run, "proposal-validation-0001.json", JSON.stringify(validation), "知识提案结构校验回执 1");
	await f.ws.writeOutput(run, "m04-transaction.json", JSON.stringify({ version: 1,
		kind: "m04-knowledge-transaction", m04RunId: run.runId, state: "rejected-draft",
		currentProposalId: receipt.proposalId, updatedAt: new Date().toISOString(), attempts: [{ ordinal: 1,
			proposalId: receipt.proposalId, proposalFile, receiptFile: "proposal-validation-0001.json",
			state: "rejected-draft", structurallyValid: false, issues: receipt.issues }] }), "M04 知识事务状态");
	run.failures.push("A structural draft was rejected; no merge was attempted.");
	await f.ws.finishRun(run, "failed");
	return run;
}
async function adapterInputs(f: Awaited<ReturnType<typeof fixture>>) {
	const root = path.join(f.ws.root, "trusted-host-checkpoint"); await mkdir(root);
	const evidence = path.join(root, "original-evidence.txt"); await writeFile(evidence, "Original retained evidence\n");
	const contract = createOriginalObjective({ goal: "Resolve the synthetic original claim",
		goalSource: "verbatim-private-input", inputNames: ["original-evidence.txt"],
		obligations: [{ id: "claim", description: "Evidence is checked" }], closure: "open-ended" });
	const contractFile = path.join(root, "contract.json"); await writeFile(contractFile, JSON.stringify(contract));
	const frozen: LocalObjectiveFrozenEvidence = { contractFile, evidenceRoot: root,
		evidence: [{ name: "original-evidence.txt", file: evidence }],
		capabilities: [{ scope: LOCAL_M07_REASON_SCOPE, available: true, description: "Local reasoning", limits: [] }],
		selectedArtifacts: [], unresolvedOperationIds: [] };
	return { ctx: f.ctx, controller: f.controller, runM04, contract, frozen,
		task: { objective: "Investigate retained evidence", addresses: ["claim"], adapterScope: LOCAL_M07_REASON_SCOPE } };
}

test("default built-in adapter starts exploratory M07 then fresh M04 after the only failed no-proposal M04", async t => {
	const f = await fixture(t); const old = await failed(f);
	const oldBytes = await readFile(path.join(f.ws.runDir("M04", old.runId), "run.json"));
	const result = await createLocalM07Adapter().advance(await adapterInputs(f));
	const goal = await f.controller.status(result.runId);
	assert.equal(goal.exploratory, true); assert.equal(goal.formalBaseline, false);
	assert.equal(goal.m04BaselineRunId, undefined); assert.equal(goal.knowledgeSnapshot, undefined);
	assert.deepEqual(goal.m04BaselineFailures?.map(item => [item.runId, item.transactionState]), [[old.runId, "no-proposal"]]);
	assert.deepEqual(result.acceptedTaskIds, []); assert.equal(result.selectedTaskId, undefined);
	assert.equal(goal.tasks[0]!.status, "rejected");
	assert.match([...f.runner.sessions.values()][0]!.transcript[0]!.text, /Retained failed M04 feedback/);
	assert.match(await readFile(goal.checkpoints![0]!.feedbackPath, "utf8"), /candidate remains unselected/);
	assert.equal((await f.ws.latestRun("M04"))?.status, "completed");
	assert.equal((await f.ws.listRuns("M04")).length, 2);
	assert.deepEqual(await readFile(path.join(f.ws.runDir("M04", old.runId), "run.json")), oldBytes);
	assert.equal(await f.store.current(), undefined);
});

test("rejected-only failed M04 retains negative feedback and never publishes its draft", async t => {
	const f = await fixture(t); const old = await rejected(f);
	const result = await createLocalM07Adapter().advance(await adapterInputs(f));
	const goal = await f.controller.status(result.runId);
	assert.equal(goal.m04BaselineFailures?.[0]?.transactionState, "rejected-draft");
	assert.equal((await f.ws.readRun("M04", old.runId)).status, "failed");
	assert.equal(await f.store.current(), undefined); assert.deepEqual(await f.store.list(), []);
	assert.equal(goal.formalBaseline, false);
});

test("matching committed baseline requires explicit acknowledgement of a newer failed suffix", async t => {
	const f = await fixture(t);
	const prior = await f.ws.startRun("M04", []); await f.ws.finishRun(prior, "completed");
	const existing = await f.controller.begin(begin); const old = await failed(f);
	await assert.rejects(f.controller.delegate(existing.runId, { objective: "Old goal", inputs: [],
		expectedOutputs: [], checks: ["Evidence is checked"], mode: "reason" }), /失败 M04 历史已变化/);
	const fresh = await f.controller.begin(begin);
	assert.equal(fresh.formalBaseline, true); assert.equal(fresh.m04BaselineRunId, prior.runId);
	assert.equal(fresh.m04BaselineFailures?.[0]?.runId, old.runId);
	assert.equal(fresh.baselineHistory[0]?.failedM04?.[0]?.runId, old.runId);
	await f.controller.delegate(fresh.runId, { objective: "Fresh goal", inputs: [],
		expectedOutputs: [], checks: ["Evidence is checked"], mode: "reason" });
});

test("unknown, merge-pending, missing or contradictory failure evidence prevents all fresh adapter sessions", async t => {
	for (const state of ["unknown", "merge-intent", "merged", "missing", "contradictory"] as const) {
		const f = await fixture(t); const old = await failed(f, state === "missing" || state === "contradictory" ? "no-proposal" : state);
		if (state === "missing") await rm(path.join(f.ws.runDir("M04", old.runId), "m04-transaction.json"));
		if (state === "contradictory") await writeFile(path.join(f.ws.knowledgeDir, "proposals", "P0001.json"), JSON.stringify({ id: "P0001", stage: "M04", runId: old.runId, ops: [] }));
		await assert.rejects(createLocalM07Adapter().advance(await adapterInputs(f)), /未证明没有知识采用/);
		await assert.rejects(f.controller.begin({ ...begin, exploratory: true }), /未证明没有知识采用/,
			"explicit exploration cannot bypass transaction reconciliation");
		assert.equal(f.runner.created.length, 0); assert.deepEqual(await f.ws.listRuns("M07"), []);
	}
});

test("unexplained CURRENT change and pending merge block continuity instead of hiding it as exploration", async t => {
	for (const cause of ["changed-current", "pending-merge"] as const) {
		const f = await fixture(t);
		const prior = await f.ws.startRun("M04", []); await f.ws.finishRun(prior, "completed");
		await failed(f);
		if (cause === "changed-current") {
			const receipt = await f.store.submitProposal({ stage: "M04", runId: "synthetic-independent-merge",
				ops: [{ op: "create", type: "E", title: "Published independent evidence", body: "Synthetic evidence", usageDecision: "adopted" }] });
			await f.store.merge(receipt.proposalId);
		} else await writeFile(path.join(f.ws.knowledgeDir, "proposals", "P0001.intent.json"), JSON.stringify({ version: 1, status: "prepared", proposalId: "P0001" }));
		await assert.rejects(createLocalM07Adapter().advance(await adapterInputs(f)), /快照不一致|尚未对账/);
		assert.equal(f.runner.created.length, 0); assert.deepEqual(await f.ws.listRuns("M07"), []);
	}
});

test("rejected draft with changed receipt or merge evidence cannot be skipped", async t => {
	for (const cause of ["receipt", "merge"] as const) {
		const f = await fixture(t); const old: StageRunRecord = await rejected(f);
		if (cause === "receipt") await writeFile(path.join(f.ws.runDir("M04", old.runId), "proposal-validation-0001.json"), "{}");
		else await writeFile(path.join(f.ws.knowledgeDir, "proposals", "P0001.intent.json"), "{}");
		await assert.rejects(f.controller.begin(begin), /未证明没有知识采用/);
		assert.equal(f.runner.created.length, 0);
	}
});

test("a settled latest failure cannot hide an older unresolved failed transaction", async t => {
	const f = await fixture(t);
	const prior = await f.ws.startRun("M04", []); await f.ws.finishRun(prior, "completed");
	await failed(f, "unknown"); await failed(f);
	await assert.rejects(createLocalM07Adapter().advance(await adapterInputs(f)), /unknown or merge-pending/);
	assert.equal(f.runner.created.length, 0);
});

test("unreadable or invalid CURRENT never looks like an empty knowledge epoch", async t => {
	for (const cause of ["missing", "invalid", "symlink"] as const) {
		const f = await fixture(t); await failed(f);
		const current = path.join(f.ws.knowledgeDir, "CURRENT");
		if (cause === "missing") await rm(current);
		else if (cause === "invalid") await writeFile(current, "unresolved-knowledge");
		else {
			await rm(current);
			const { symlink } = await import("node:fs/promises");
			await symlink(f.ws.problemFile, current);
		}
		await assert.rejects(createLocalM07Adapter().advance(await adapterInputs(f)));
		assert.equal(f.runner.created.length, 0); assert.deepEqual(await f.ws.listRuns("M07"), []);
	}
});
