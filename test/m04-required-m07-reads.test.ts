import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { createFileKnowledgeStore } from "../src/knowledge/store.ts";
import { createM07Controller } from "../src/m07/controller.ts";
import { FakeSessionRunner } from "../src/runner/fake.ts";
import type { ReadReturnEvent } from "../src/runner/types.ts";
import { runM04 } from "../src/stages/m04.ts";
import { exportPortableM04Transaction } from "../src/workflow-archive/m04-transaction.ts";
import type { StageContext } from "../src/stages/context.ts";
import { Workspace } from "../src/workspace.ts";

async function fixture(t: TestContext) {
	const root = await mkdtemp(path.join(os.tmpdir(), "m04-required-m07-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const ws = new Workspace(root);
	await mkdir(path.dirname(ws.problemFile), { recursive: true });
	await writeFile(ws.problemFile, "Synthetic question\n");
	const store = createFileKnowledgeStore(ws.knowledgeDir); await store.init();
	const prior = await ws.startRun("M04", []); await ws.finishRun(prior, "completed");
	const runner = new FakeSessionRunner(() => "Synthetic report");
	const ctx: StageContext = { ws, store, runner, config: { roles: { execution: "fake/execution", reviewer: "fake/reviewer", research: "fake/research" }, concurrency: 1, tools: {} } };
	const controller = createM07Controller(ctx);
	const goal = await controller.begin({ goal: "Synthetic bounded task", problemRelation: "Direct", constraints: ["Keep evidence frozen"], successCriteria: ["Evidence checked"], plan: "Inspect evidence" });
	await controller.delegate(goal.runId, { objective: "Produce feedback", inputs: [], expectedOutputs: [], checks: ["Evidence checked"], mode: "reason" });
	await controller.finish(goal.runId, { outcome: "partial", summary: "Synthetic evidence for M04", returnPath: "M04",
		goalChecks: [{ criterion: "Evidence checked", result: "not_run", evidence: [] }] });
	const relative = ["candidate.cpp", "verification.json", "lesson-delta.json"].map((name, index) =>
		`tasks/T001/review-snapshot/${String(index + 1).padStart(3, "0")}-${name}`);
	for (const item of relative) {
		const file = path.join(ws.runDir("M07", goal.runId), item);
		await mkdir(path.dirname(file), { recursive: true });
		await writeFile(file, "first\nsecond\n");
	}
	return { ws, store, ctx, goal, relative };
}

function returnedRanges(relative: string[], terminalTruncated = false): ReadReturnEvent[] {
	return relative.map((item, index) => ({ toolName: "m07_evidence_read", status: "returned", path: item,
		requested: {}, returned: { kind: "text", startLine: 1, endLine: 2,
			truncated: terminalTruncated && index === 0 }, at: new Date().toISOString() }));
}

test("M04 can choose no proposal after full selected M07 reads and sees exact paths in its message", async t => {
	const f = await fixture(t);
	const fake = new FakeSessionRunner(() => "No transferable lesson; no knowledge proposal.");
	const create = fake.create.bind(fake);
	fake.create = async spec => ({ ...await create(spec), readReturnEvents: () => returnedRanges(f.relative) });
	f.ctx.runner = fake;
	const result = await runM04(f.ctx, { feedback: { kind: "M07", runId: f.goal.runId }, freshSession: true,
		requiredM07ReadPaths: f.relative });
	assert.equal(result.record.status, "completed");
	assert.equal(result.proposalId, undefined);
	const transactionPath = result.record.outputs.find(item => item.label === "M04 知识事务状态")?.path;
	assert.ok(transactionPath);
	const transaction = JSON.parse(await readFile(transactionPath, "utf8"));
	assert.equal(transaction.state, "no-proposal");
	assert.deepEqual(transaction.attempts, []);
	const session = [...fake.sessions.values()].find(item => item.spec.label === "M04-research");
	assert.equal(session?.turns, 1, "a missing proposal block is a valid no-proposal result");
	const message = session?.transcript[0]?.text ?? "";
	for (const item of f.relative) assert.ok(message.includes(item));
	assert.match(message, /完整读取/);
});

test("a failed first M04 prompt leaves an exact no-proposal receipt for fresh adjudication", async t => {
	const f = await fixture(t);
	const snapshot = await f.store.current();
	f.ctx.runner = new FakeSessionRunner(() => { throw new Error("synthetic prompt transport failure"); });
	await assert.rejects(runM04(f.ctx, { feedback: { kind: "M07", runId: f.goal.runId },
		freshSession: true, requiredM07ReadPaths: f.relative }), /synthetic prompt transport failure/);
	const records = await Promise.all((await f.ws.listRuns("M04")).map(id => f.ws.readRun("M04", id)));
	const failed = records.find(record => record.status === "failed" &&
		record.outputs.some(item => item.label === "M04 知识事务状态"));
	assert.ok(failed);
	const txFile = failed.outputs.find(item => item.label === "M04 知识事务状态")!.path;
	const tx = JSON.parse(await readFile(txFile, "utf8"));
	assert.equal(tx.state, "no-proposal");
	assert.deepEqual(tx.attempts, []);
	assert.equal(tx.currentProposalId, undefined);
	assert.equal(tx.snapshotId, undefined);
	assert.equal((await f.store.current())?.id, snapshot?.id);
	const destination = path.join(f.ws.root, "private-m04-transport");
	await mkdir(destination);
	const portable = await exportPortableM04Transaction({ ws: f.ws,
		m04RunId: failed.runId, destination });
	assert.equal(portable.state, "no-proposal");
	assert.deepEqual(portable.attempts, []);

	const next = new FakeSessionRunner(() => ({
		text: "Fresh adjudication: evidence does not support a knowledge proposal.",
		readReturns: returnedRanges(f.relative),
	}));
	f.ctx.runner = next;
	const fresh = await runM04(f.ctx, { feedback: { kind: "M07", runId: f.goal.runId },
		freshSession: true, requiredM07ReadPaths: f.relative });
	assert.equal(fresh.record.status, "completed");
	assert.equal(fresh.proposalAttempts.length, 0);
	assert.equal((await f.store.current())?.id, snapshot?.id);
	assert.equal(next.created.filter(spec => spec.label === "M04-research").length, 1);
});

test("malformed explicit proposal JSON gets same-session format repair only after full M07 reads", async t => {
	const f = await fixture(t);
	const before = (await f.store.current())?.id;
	const fake = new FakeSessionRunner(({ turnIndex, message }) => {
		if (turnIndex === 1) return { text: "Provisional judgement.\n```knowledge-proposals\n{broken\n```",
			readReturns: returnedRanges(f.relative) };
		assert.match(message, /not a valid JSON array/);
		assert.match(message, /No proposal was submitted or merged/);
		assert.doesNotMatch(message, /\{broken/,
			"format feedback must not echo raw malformed content");
		return "Revised complete judgement: no supported transferable knowledge operation.";
	});
	f.ctx.runner = fake;
	const result = await runM04(f.ctx, { feedback: { kind: "M07", runId: f.goal.runId },
		freshSession: true, requiredM07ReadPaths: f.relative });
	assert.equal(result.record.status, "completed");
	assert.equal(result.proposalId, undefined);
	assert.equal((await f.store.current())?.id, before);
	assert.equal(fake.created.filter(spec => spec.label === "M04-research").length, 1);
	assert.equal([...fake.sessions.values()].find(item => item.spec.label === "M04-research")?.turns, 2);
	const processed = result.record.outputs.find(item => item.label === "处理结果");
	assert.ok(processed);
	assert.match(await readFile(processed.path, "utf8"),
		/Revised complete judgement/);
	assert.equal(result.record.outputs.some(item => item.label === "知识提案"), false);
});

test("structurally invalid draft gets exact receipt and same-session correction without merge", async t => {
	const f = await fixture(t);
	const invalid = `\`\`\`knowledge-proposals\n${JSON.stringify([{
		op: "create", type: "K", title: "", body: "" }])}\n\`\`\``;
	const fake = new FakeSessionRunner(({ turnIndex, message }) => {
		if (turnIndex === 1) return { text: invalid, readReturns: returnedRanges(f.relative) };
		assert.match(message, /private draft and rejected it on structural validation/);
		assert.match(message, /create\.title/);
		return "Revised complete judgment: no supported knowledge operation.";
	});
	f.ctx.runner = fake;
	const prior = (await f.store.current())?.id;
	const result = await runM04(f.ctx, { feedback: { kind: "M07", runId: f.goal.runId },
		freshSession: true, requiredM07ReadPaths: f.relative });
	assert.ok(result.proposalId, "a parsed array reached draft-only structural validation");
	assert.equal(result.snapshotId, undefined);
	assert.equal((await f.store.current())?.id, prior);
	assert.equal([...fake.sessions.values()].find(item => item.spec.label === "M04-research")?.turns, 2);
	assert.equal(result.proposalAttempts.length, 1);
	assert.equal(result.proposalAttempts[0].state, "rejected-draft");
	const txPath = result.record.outputs.find(item => item.label === "M04 知识事务状态")?.path;
	assert.ok(txPath);
	const tx = JSON.parse(await readFile(txPath, "utf8"));
	assert.equal(tx.state, "rejected-draft");
	assert.equal(tx.attempts[0].proposalId, result.proposalId);
	assert.ok(tx.attempts[0].issues.some((item: { message: string }) => item.message.includes("create.title")));
	const receipt = JSON.parse(await readFile(path.join(path.dirname(txPath), tx.attempts[0].receiptFile), "utf8"));
	assert.deepEqual(receipt.issues, tx.attempts[0].issues);
	assert.equal(result.record.outputs.some(item => item.label === "合入结果"), false);
});

test("a corrected structural draft merges once and retains rejected draft identity", async t => {
	const f = await fixture(t);
	const invalid = `\`\`\`knowledge-proposals\n${JSON.stringify([{
		op: "create", type: "K", title: "", body: "" }])}\n\`\`\``;
	const valid = `\`\`\`knowledge-proposals\n${JSON.stringify([{
		op: "create", type: "K", title: "Synthetic bounded method", body: "Finite synthetic observation",
		usageDecision: "candidate" }])}\n\`\`\``;
	const fake = new FakeSessionRunner(({ turnIndex }) => ({
		text: turnIndex === 1 ? invalid : valid,
		readReturns: turnIndex === 1 ? returnedRanges(f.relative) : [],
	}));
	f.ctx.runner = fake;
	const result = await runM04(f.ctx, { feedback: { kind: "M07", runId: f.goal.runId },
		freshSession: true, requiredM07ReadPaths: f.relative });
	assert.ok(result.snapshotId, "only the corrected valid proposal reaches merge");
	assert.equal(result.proposalAttempts.length, 2);
	assert.equal(result.proposalAttempts[0].state, "rejected-draft");
	assert.equal(result.proposalAttempts[1].state, "merged");
	assert.equal(result.proposalId, result.proposalAttempts[1].proposalId);
	const txPath = result.record.outputs.find(item => item.label === "M04 知识事务状态")?.path;
	assert.ok(txPath);
	const tx = JSON.parse(await readFile(txPath, "utf8"));
	assert.equal(tx.state, "merged");
	assert.equal(tx.snapshotId, result.snapshotId);
	assert.equal(result.record.outputs.filter(item => item.label.startsWith("知识提案草案 ")).length, 2);
	assert.equal(result.record.outputs.filter(item => item.label === "M04 知识事务状态").length, 1);
});

test("merge exception leaves durable merge intent and does not retry in the model session", async t => {
	const f = await fixture(t);
	const valid = `\`\`\`knowledge-proposals\n${JSON.stringify([{
		op: "create", type: "K", title: "Synthetic bounded method", body: "Finite synthetic observation",
		usageDecision: "candidate" }])}\n\`\`\``;
	const fake = new FakeSessionRunner(() => ({ text: valid, readReturns: returnedRanges(f.relative) }));
	f.ctx.runner = fake;
	f.store.merge = async () => { throw new Error("synthetic merge outcome unknown"); };
	await assert.rejects(runM04(f.ctx, { feedback: { kind: "M07", runId: f.goal.runId },
		freshSession: true, requiredM07ReadPaths: f.relative }), /synthetic merge outcome unknown/);
	const runs = await Promise.all((await f.ws.listRuns("M04")).map(id => f.ws.readRun("M04", id)));
	const attempt = runs.find(run => run.outputs.some(item => item.label === "M04 知识事务状态"));
	assert.ok(attempt);
	const txPath = attempt.outputs.find(item => item.label === "M04 知识事务状态")!.path;
	const tx = JSON.parse(await readFile(txPath, "utf8"));
	assert.equal(tx.state, "merge-intent");
	assert.equal(tx.snapshotId, undefined);
	assert.equal(tx.attempts.length, 1);
	assert.equal(tx.attempts[0].state, "merge-intent");
	assert.equal([...fake.sessions.values()].find(item => item.spec.label === "M04-research")?.turns, 1);
});

test("M04 rejects an adopted proposal before merge when a required read tool reports an error", async t => {
	const f = await fixture(t);
	const proposal = `\`\`\`knowledge-proposals\n${JSON.stringify([
		{ op: "create", type: "K", title: "Synthetic method", body: "Bounded synthetic method", usageDecision: "adopted" },
	])}\n\`\`\``;
	const fake = new FakeSessionRunner(({ turnIndex }) => ({ text: proposal,
		readReturns: turnIndex === 1 ? returnedRanges(f.relative, true) : [{
			toolName: "m07_evidence_read", status: "error", path: f.relative[0], requested: {},
			returned: { kind: "unknown" }, at: new Date().toISOString(),
		}] }));
	f.ctx.runner = fake;
	const snapshot = await f.store.current();
	await assert.rejects(runM04(f.ctx, { feedback: { kind: "M07", runId: f.goal.runId }, freshSession: true,
		requiredM07ReadPaths: f.relative }), /not returned.*full/);
	assert.equal((await f.store.current())?.id, snapshot?.id);
	const runs = await f.ws.listRuns("M04");
	const records = await Promise.all(runs.map(id => f.ws.readRun("M04", id)));
	const attempt = records.find(record => record.outputs.some(item => item.label === "M07 回流证据实际访问范围"));
	assert.ok(attempt);
	assert.equal(attempt.status, "failed");
	assert.equal(attempt.outputs.some(item => item.label === "知识提案"), false);
});

test("M04 repeats same-session missing-page feedback and uses only the final fully read judgement", async t => {
	const f = await fixture(t);
	const provisional = `\`\`\`knowledge-proposals\n${JSON.stringify([
		{ op: "create", type: "K", title: "Provisional method", body: "Unsupported provisional claim", usageDecision: "adopted" },
	])}\n\`\`\``;
	const fake = new FakeSessionRunner(({ turnIndex, message }) => {
		if (turnIndex > 1) assert.match(message, /untruncated final page/);
		if (turnIndex === 3) assert.match(message, /previous repair turn added no complete read proof/);
		return { text: turnIndex < 3 ? provisional : "No transferable lesson after complete evidence review; no knowledge proposal.",
			readReturns: turnIndex === 1 ? [
				{ toolName: "m07_evidence_read", status: "returned", path: f.relative[0], requested: {},
					returned: { kind: "text", startLine: 1, endLine: 1, truncated: true }, at: new Date().toISOString() },
				...returnedRanges(f.relative.slice(1)),
			] : turnIndex === 3 ? [{ toolName: "m07_evidence_read", status: "returned", path: f.relative[0],
				requested: {}, returned: { kind: "text", startLine: 2, endLine: 2, truncated: false },
				at: new Date().toISOString() }] : [] };
	});
	f.ctx.runner = fake;
	const before = (await f.store.current())?.id;
	const result = await runM04(f.ctx, { feedback: { kind: "M07", runId: f.goal.runId }, freshSession: true,
		requiredM07ReadPaths: f.relative });
	assert.equal(result.record.status, "completed");
	assert.equal(result.proposalId, undefined, "provisional proposal must never be merged");
	assert.equal((await f.store.current())?.id, before);
	assert.equal(fake.created.filter(spec => spec.label === "M04-research").length, 1);
	assert.equal([...fake.sessions.values()].find(item => item.spec.label === "M04-research")?.turns, 3);
});

test("malformed provisional M04 output cannot end the read repair or create a proposal", async t => {
	const f = await fixture(t);
	const fake = new FakeSessionRunner(({ turnIndex, message }) => {
		if (turnIndex === 1) return { text: "```knowledge-proposals\nnot JSON\n```", readReturns: [] };
		assert.match(message, /Next missing returned range/);
		return { text: "No supported knowledge proposal after reading the frozen files.",
			readReturns: returnedRanges(f.relative) };
	});
	f.ctx.runner = fake;
	const before = (await f.store.current())?.id;
	const result = await runM04(f.ctx, { feedback: { kind: "M07", runId: f.goal.runId }, freshSession: true,
		requiredM07ReadPaths: f.relative });
	assert.equal(result.record.status, "completed");
	assert.equal(result.proposalId, undefined);
	assert.equal((await f.store.current())?.id, before);
	assert.equal([...fake.sessions.values()].find(item => item.spec.label === "M04-research")?.turns, 2);
});

test("M04 verifies more than twelve required frozen evidence files without weakening full-read checks", async t => {
	const f = await fixture(t);
	const required = [...f.relative];
	for (let index = 0; index < 10; index++) {
		const relative = `tasks/T001/review-snapshot/${String(index + 4).padStart(3, "0")}-extra-${index}.txt`;
		await writeFile(path.join(f.ws.runDir("M07", f.goal.runId), relative), "first\nsecond\n");
		required.push(relative);
	}
	const fake = new FakeSessionRunner(() => "No transferable lesson; no knowledge proposal.");
	const create = fake.create.bind(fake);
	fake.create = async spec => ({ ...await create(spec), readReturnEvents: () => returnedRanges(required) });
	f.ctx.runner = fake;
	const result = await runM04(f.ctx, { feedback: { kind: "M07", runId: f.goal.runId }, freshSession: true,
		requiredM07ReadPaths: required });
	assert.equal(result.record.status, "completed");
	assert.equal(required.length, 13);
});

test("M04 checks complete returned ranges for evidence exceeding 100,000 lines", async t => {
	const f = await fixture(t);
	const totalLines = 100_001;
	await writeFile(path.join(f.ws.runDir("M07", f.goal.runId), f.relative[0]), "x\n".repeat(totalLines));
	const fake = new FakeSessionRunner(() => "No transferable lesson; no knowledge proposal.");
	const create = fake.create.bind(fake);
	fake.create = async spec => ({ ...await create(spec), readReturnEvents: () => [{
		toolName: "m07_evidence_read", status: "returned", path: f.relative[0], requested: {},
		returned: { kind: "text", startLine: 1, endLine: totalLines, truncated: false }, at: new Date().toISOString(),
	}] });
	f.ctx.runner = fake;
	const result = await runM04(f.ctx, { feedback: { kind: "M07", runId: f.goal.runId }, freshSession: true,
		requiredM07ReadPaths: [f.relative[0]] });
	assert.equal(result.record.status, "completed");
});
