import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { createFileKnowledgeStore } from "../src/knowledge/store.ts";
import { createM07Controller } from "../src/m07/controller.ts";
import { FakeSessionRunner } from "../src/runner/fake.ts";
import type { ReadReturnEvent } from "../src/runner/types.ts";
import { type WorkflowRepairStateV1 } from "../src/runner/repair-liveness.ts";
import { runM04, type M04InvalidJudgmentEvent } from "../src/stages/m04.ts";

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













test("M04 replaces unchanged missing-page repair with fresh judgment and redoes full read proof", async t => {
	const f = await fixture(t);
	const diagnostics: M04InvalidJudgmentEvent[] = [];
	const provisional = `\`\`\`knowledge-proposals\n${JSON.stringify([
		{ op: "create", type: "K", title: "Provisional method", body: "Unsupported provisional claim", usageDecision: "adopted" },
	])}\n\`\`\``;
	let firstSessionId: string | undefined;
	const states: WorkflowRepairStateV1[] = [];
	const fake = new FakeSessionRunner(({ ref, turnIndex, message }) => {
		firstSessionId ??= ref.id;
		if (ref.id === firstSessionId) {
			if (turnIndex === 2) assert.match(message, /untruncated final page/);
			return { text: provisional, readReturns: turnIndex === 1 ? [
				{ toolName: "m07_evidence_read", status: "returned", path: f.relative[0], requested: {},
					returned: { kind: "text", startLine: 1, endLine: 1, truncated: true }, at: new Date().toISOString() },
				...returnedRanges(f.relative.slice(1)),
			] : [] };
		}
		if (turnIndex === 1) {
			assert.match(message, /fresh independent M04 judgment/);
			assert.match(message, /previous-session returned ranges do not satisfy/);
			assert.match(message, /Synthetic question/);
			return { text: provisional, readReturns: [{ toolName: "m07_evidence_read", status: "returned", path: f.relative[0],
				requested: {}, returned: { kind: "text", startLine: 2, endLine: 2, truncated: false },
				at: new Date().toISOString() }] };
		}
		assert.match(message, /1-1/);
		for (const item of f.relative.slice(1)) assert.ok(message.includes(item), "prior complete files must be read again");
		return { text: "No transferable lesson after complete evidence review; no knowledge proposal.",
			readReturns: returnedRanges(f.relative) };
	});
	f.ctx.runner = fake;
	const before = (await f.store.current())?.id;
	const result = await runM04(f.ctx, { feedback: { kind: "M07", runId: f.goal.runId }, freshSession: true,
		requiredM07ReadPaths: f.relative, onRepairState: async state => { states.push(state); },
		onInvalidJudgment: async event => { diagnostics.push(event); } });
	assert.equal(result.record.status, "completed");
	assert.equal(result.proposalId, undefined, "provisional proposal must never be merged");
	assert.equal((await f.store.current())?.id, before);
	assert.equal(fake.created.filter(spec => spec.label === "M04-research").length, 2);
	const sessions = [...fake.sessions.values()];
	assert.deepEqual(sessions.map(item => item.turns), [2, 2]);
	assert.deepEqual(sessions[0].spec.tools, sessions[1].spec.tools);
	assert.ok(sessions.every(item => item.disposed));
	assert.ok(states.some(item => item.strategy === "fresh-context" && item.sessionGeneration === 2));
	assert.equal(states.some(item => item.strategy === "workflow-repair-needed"), false);
	const coverage = JSON.parse(await readFile(result.record.outputs.find(item => item.label === "M07 回流证据实际访问范围")!.path, "utf8"));
	assert.equal(coverage.sessionId, sessions[1].ref.id);
	assert.equal(coverage.earlierSessions[0].sessionId, sessions[0].ref.id);
	assert.equal(coverage.returnedRanges.length, 4, "final proof must contain only fresh-session returns");
	assert.deepEqual(diagnostics.map(event => [event.generation, event.attempt]), [[1, 1], [1, 2], [2, 1]]);
	assert.equal(diagnostics[2].sessionId, sessions[1].ref.id);
	assert.deepEqual(diagnostics[2].coverage.map(item => item.coveredRanges),
		[[{ start: 2, end: 2 }], [], []], "a fresh judgment cannot inherit earlier read ranges");
	assert.ok(diagnostics[2].coverage.every(item => !item.complete));
});
