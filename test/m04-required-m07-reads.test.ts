import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { createFileKnowledgeStore } from "../src/knowledge/store.ts";
import { createM07Controller } from "../src/m07/controller.ts";
import { FakeSessionRunner } from "../src/runner/fake.ts";
import type { ReadReturnEvent } from "../src/runner/types.ts";
import { runM04 } from "../src/stages/m04.ts";
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
	const session = [...fake.sessions.values()].find(item => item.spec.label === "M04-research");
	const message = session?.transcript[0]?.text ?? "";
	for (const item of f.relative) assert.ok(message.includes(item));
	assert.match(message, /完整读取/);
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
