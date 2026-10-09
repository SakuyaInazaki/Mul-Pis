import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { createFileKnowledgeStore } from "../src/knowledge/store.ts";
import { createM07Controller } from "../src/m07/controller.ts";
import { FakeSessionRunner } from "../src/runner/fake.ts";
import type { ReadReturnEvent, SessionHandle } from "../src/runner/types.ts";
import { WorkflowRepairNeededError, type WorkflowRepairStateV1 } from "../src/runner/repair-liveness.ts";
import { assertFullM07Reads, runM04, type M04InvalidJudgmentEvent } from "../src/stages/m04.ts";
import { runM01 } from "../src/stages/m01.ts";
import { exportPortableM04Transaction } from "../src/workflow-archive/m04-transaction.ts";
import type { StageContext } from "../src/stages/context.ts";
import { Workspace } from "../src/workspace.ts";
import { HarnessError } from "../src/types.ts";

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

function emptyRead(relative: string): ReadReturnEvent {
	return { toolName: "m07_evidence_read", status: "no-content", path: relative, requested: {},
		returned: { kind: "text", truncated: false }, at: new Date().toISOString() };
}

test("M04 accepts only an exact untruncated no-content text return for empty required evidence", async t => {
	const f = await fixture(t);
	const root = f.ws.runDir("M07", f.goal.runId);
	const relative = f.relative[0];
	await writeFile(path.join(root, relative), "");
	const valid = emptyRead(relative);
	await assertFullM07Reads(root, [relative], [valid]);
	const invalid: Array<[string, ReadReturnEvent[]]> = [
		["no read", []],
		["wrong path", [{ ...valid, path: f.relative[1] }]],
		["wrong tool", [{ ...valid, toolName: "material_read" }]],
		["read error", [{ ...valid, status: "error" }]],
		["truncated return", [{ ...valid, returned: { kind: "text", truncated: true } }]],
		["binary return", [{ ...valid, returned: { kind: "binary", truncated: false } }]],
		["fabricated line range", [{ ...valid, returned: { kind: "text", startLine: 1, endLine: 1, truncated: false } }]],
		["incomplete line range", [{ ...valid, returned: { kind: "text", startLine: 1, truncated: false } }]],
		["returned without lines", [{ ...valid, status: "returned" }]],
		["missing truncation proof", [{ ...valid, returned: { kind: "text" } }]],
	];
	for (const [reason, events] of invalid) await assert.rejects(
		assertFullM07Reads(root, [relative], events),
		(error: unknown) => error instanceof HarnessError && error.code === "m04.m07-evidence", reason);
});

test("default M04 entry completes when a required frozen file is exactly empty and was read", async t => {
	const f = await fixture(t);
	await writeFile(path.join(f.ws.runDir("M07", f.goal.runId), f.relative[0]), "");
	const fake = new FakeSessionRunner(() => ({ text: "No transferable lesson; no knowledge proposal.",
		readReturns: [emptyRead(f.relative[0]), ...returnedRanges(f.relative.slice(1))] }));
	f.ctx.runner = fake;
	const result = await runM04(f.ctx, { feedback: { kind: "M07", runId: f.goal.runId }, freshSession: true,
		requiredM07ReadPaths: f.relative });
	assert.equal(result.record.status, "completed");
	assert.equal(result.proposalId, undefined);
	assert.equal([...fake.sessions.values()].find(item => item.spec.label === "M04-research")?.turns, 1);
	const coveragePath = result.record.outputs.find(item => item.label === "M07 回流证据实际访问范围")?.path;
	assert.ok(coveragePath);
	const coverage = JSON.parse(await readFile(coveragePath, "utf8")) as { returnedRanges: ReadReturnEvent[] };
	assert.deepEqual(coverage.returnedRanges.map(item => [item.path, item.status]),
		[[f.relative[0], "no-content"], [f.relative[1], "returned"], [f.relative[2], "returned"]]);
});

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

test("every invalid M04 reply reaches the private callback before another prompt", async t => {
	const f = await fixture(t);
	const raw = ["Read proof remains incomplete despite this judgment.",
		"```knowledge-proposals\n{broken\n```",
		"```knowledge-proposals\n[{\"op\":\"create\",\"type\":\"K\",\"title\":\"\",\"body\":\"\"}]\n```"];
	const events: M04InvalidJudgmentEvent[] = [];
	const fake = new FakeSessionRunner(({ turnIndex }) => {
		assert.equal(events.length, turnIndex - 1, "each invalid reply is captured before the next prompt");
		if (turnIndex === 1) return { text: raw[0], readReturns: returnedRanges(f.relative.slice(0, 1)) };
		if (turnIndex === 2) return { text: raw[1], readReturns: returnedRanges(f.relative.slice(1)) };
		if (turnIndex === 3) return { text: raw[2], readReturns: [] };
		return "Final independent judgment: no supported proposal.";
	});
	f.ctx.runner = fake;
	const before = (await f.store.current())?.id;
	const result = await runM04(f.ctx, { feedback: { kind: "M07", runId: f.goal.runId },
		freshSession: true, requiredM07ReadPaths: f.relative,
		onInvalidJudgment: async event => { events.push(event); } });
	assert.deepEqual(events.map(event => event.rawResponse), raw);
	assert.deepEqual(events.map(event => event.validation.code),
		["m04.m07-evidence", "m04.proposal-invalid-json", "m04.proposal-structure"]);
	assert.deepEqual(events.map(event => event.attempt), [1, 2, 3]);
	assert.ok(events.every(event => event.stage === "m04-judgment" && event.generation === 1 &&
		event.sessionId === events[0].sessionId));
	assert.deepEqual(events[0].coverage.map(item => item.complete), [true, false, false]);
	assert.deepEqual(events[0].coverage[0].coveredRanges, [{ start: 1, end: 2 }]);
	assert.ok(events[1].coverage.every(item => item.complete));
	assert.equal(events[0].validation.path, f.relative[1]);
	assert.equal(events[1].validation.path, "knowledge-proposals");
	assert.match(JSON.stringify(events[2].validation.detail), /create\.title/);
	assert.ok(events.every(event => event.transcriptPath === undefined || typeof event.transcriptPath === "string"));
	assert.equal(result.snapshotId, undefined);
	assert.equal((await f.store.current())?.id, before);
	assert.deepEqual(result.proposalAttempts.map(item => item.state), ["rejected-draft"]);
	assert.equal(result.record.outputs.some(item => item.label === "合入结果"), false);
	assert.equal(await readFile(result.record.outputs.find(item => item.label === "处理结果")!.path, "utf8"),
		"Final independent judgment: no supported proposal.\n");
});

test("failed M04 private diagnostic write prevents another prompt and knowledge adoption", async t => {
	const f = await fixture(t);
	const invalid = "```knowledge-proposals\n{broken\n```";
	const fake = new FakeSessionRunner(() => ({ text: invalid, readReturns: returnedRanges(f.relative) }));
	f.ctx.runner = fake;
	const before = (await f.store.current())?.id;
	await assert.rejects(runM04(f.ctx, { feedback: { kind: "M07", runId: f.goal.runId },
		freshSession: true, requiredM07ReadPaths: f.relative,
		onInvalidJudgment: async () => { throw new Error("private diagnostic unavailable"); } }),
		/private diagnostic unavailable/);
	assert.equal([...fake.sessions.values()][0].turns, 1);
	assert.equal((await f.store.current())?.id, before);
	const records = await Promise.all((await f.ws.listRuns("M04")).map(id => f.ws.readRun("M04", id)));
	const failed = records.find(record => record.status === "failed" &&
		record.outputs.some(item => item.label === "M04 知识事务状态"))!;
	const tx = JSON.parse(await readFile(failed.outputs.find(item => item.label === "M04 知识事务状态")!.path, "utf8"));
	assert.equal(tx.state, "no-proposal");
	assert.deepEqual(tx.attempts, []);
	assert.equal(failed.outputs.some(item => item.label === "处理结果"), false);
});

test("failed diagnostic after structural rejection retains the exact draft and blocks retry", async t => {
	const f = await fixture(t);
	const invalid = "```knowledge-proposals\n[{\"op\":\"create\",\"type\":\"K\",\"title\":\"\",\"body\":\"\"}]\n```";
	let submissions = 0, merges = 0;
	const submit = f.store.submitProposal.bind(f.store), merge = f.store.merge.bind(f.store);
	f.store.submitProposal = async batch => { submissions += 1; return submit(batch); };
	f.store.merge = async id => { merges += 1; return merge(id); };
	const fake = new FakeSessionRunner(() => ({ text: invalid, readReturns: returnedRanges(f.relative) }));
	f.ctx.runner = fake;
	const before = (await f.store.current())?.id;
	await assert.rejects(runM04(f.ctx, { feedback: { kind: "M07", runId: f.goal.runId },
		freshSession: true, requiredM07ReadPaths: f.relative,
		onInvalidJudgment: async event => {
			assert.equal(event.rawResponse, invalid);
			assert.equal(event.validation.code, "m04.proposal-structure");
			throw new Error("private draft diagnostic unavailable");
		} }), /private draft diagnostic unavailable/);
	assert.equal([...fake.sessions.values()][0].turns, 1);
	assert.equal(submissions, 1);
	assert.equal(merges, 0);
	assert.equal((await f.store.current())?.id, before);
	const records = await Promise.all((await f.ws.listRuns("M04")).map(id => f.ws.readRun("M04", id)));
	const failed = records.find(record => record.status === "failed" &&
		record.outputs.some(item => item.label === "M04 知识事务状态"))!;
	const tx = JSON.parse(await readFile(failed.outputs.find(item => item.label === "M04 知识事务状态")!.path, "utf8"));
	assert.equal(tx.state, "rejected-draft");
	assert.equal(tx.attempts.length, 1);
	assert.equal(tx.attempts[0].state, "rejected-draft");
	const receipt = JSON.parse(await readFile(path.join(path.dirname(failed.outputs.find(item =>
		item.label === "M04 知识事务状态")!.path), tx.attempts[0].receiptFile), "utf8"));
	assert.deepEqual(receipt.issues, tx.attempts[0].issues);
	assert.equal(failed.outputs.some(item => item.label === "处理结果" || item.label === "合入结果"), false);
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

test("M04 rejects a third-operation experience string ref and accepts its same-session pinned correction", async t => {
	const f = await fixture(t);
	const storeId = await f.store.storeId();
	const evidence = await f.store.submitProposal({ stage: "M04", runId: "prior", ops: [
		{ op: "create", type: "E", title: "Existing evidence", body: "Synthetic pinned input", usageDecision: "adopted" },
	] });
	assert.equal(evidence.structurallyValid, true);
	await f.store.merge(evidence.proposalId);
	const before = (await f.store.current())!.id;
	const ops = (requiredRefs: unknown) => [
		{ op: "create", type: "C", title: "Synthetic observation", body: "Bounded observation" },
		{ op: "create", type: "J", title: "Synthetic rationale", body: "Bounded rationale" },
		{ op: "create", type: "K", title: "Reusable method", body: "Synthetic method", usageDecision: "candidate",
			fields: { experience: { version: 1, targetKind: "executor", applicableStages: ["M07"],
				requiredTags: [], excludedTags: [], requiredRefs } } },
	];
	const response = (requiredRefs: unknown) => `\`\`\`knowledge-proposals\n${JSON.stringify(ops(requiredRefs))}\n\`\`\``;
	const captured: M04InvalidJudgmentEvent[] = [];
	const fake = new FakeSessionRunner(({ turnIndex, message }) => {
		if (turnIndex === 1) {
			assert.match(message, /\{storeId,recordId,version\}/);
			assert.match(message, /字符串无效/);
			return { text: response(["K001@1"]), readReturns: returnedRanges(f.relative) };
		}
		assert.equal(captured.length, 1);
		assert.match(message, /fields\.experience\.requiredRefs\[0\]/);
		assert.match(message, /\{storeId,recordId,version\}/);
		return { text: response([{ storeId, recordId: "E001", version: 1 }]), readReturns: [] };
	});
	f.ctx.runner = fake;
	const result = await runM04(f.ctx, { feedback: { kind: "M07", runId: f.goal.runId },
		freshSession: true, requiredM07ReadPaths: f.relative,
		onInvalidJudgment: async event => { captured.push(event); } });
	assert.deepEqual(result.proposalAttempts.map(item => item.state), ["rejected-draft", "merged"]);
	assert.equal(captured[0].validation.code, "m04.proposal-structure");
	const issues = result.proposalAttempts[0].issues;
	assert(issues.some(issue => issue.opIndex === 2 &&
		issue.message.includes("fields.experience.requiredRefs[0]") &&
		issue.message.includes("{storeId,recordId,version}")));
	assert.notEqual(result.snapshotId, before);
	assert.deepEqual((await f.store.get("K001"))?.fields.experience, {
		version: 1, targetKind: "executor", applicableStages: ["M07"], requiredTags: [],
		excludedTags: [], requiredRefs: [{ storeId, recordId: "E001", version: 1 }],
	});
	assert.equal([...fake.sessions.values()].find(item => item.spec.label === "M04-research")?.turns, 2);
});

test("M04 rejects hostile extra keys in an experience ref without merging", async t => {
	const f = await fixture(t);
	const before = (await f.store.current())?.id;
	const fake = new FakeSessionRunner(({ turnIndex, message }) => {
		if (turnIndex === 1) return { text: `\`\`\`knowledge-proposals\n${JSON.stringify([{
			op: "create", type: "K", title: "Synthetic method", body: "Synthetic evidence",
			fields: { experience: { version: 1, targetKind: "executor", applicableStages: ["M07"],
				requiredTags: [], excludedTags: [], requiredRefs: [{ storeId: "00000000-0000-4000-8000-000000000000",
					recordId: "E001", version: 1, secretPayload: "do-not-repeat-this-value" }] } },
		}])}\n\`\`\``, readReturns: returnedRanges(f.relative) };
		assert.match(message, /fields\.experience\.requiredRefs\[0\]/);
		assert.match(message, /only \{storeId,recordId,version\}/);
		assert.doesNotMatch(message, /do-not-repeat-this-value|secretPayload/);
		return "Corrected judgment: no supported knowledge proposal.";
	});
	f.ctx.runner = fake;
	const result = await runM04(f.ctx, { feedback: { kind: "M07", runId: f.goal.runId },
		freshSession: true, requiredM07ReadPaths: f.relative });
	assert.deepEqual(result.proposalAttempts.map(item => item.state), ["rejected-draft"]);
	assert(result.proposalAttempts[0].issues.some(issue => issue.message.includes("fields.experience.requiredRefs[0]")));
	assert.equal(result.snapshotId, undefined);
	assert.equal((await f.store.current())?.id, before);
	assert.equal(await f.store.get("K001"), undefined);
});

test("repeated malformed proposal changes context without submitting malformed content", async t => {
	const f = await fixture(t);
	let firstSessionId: string | undefined;
	const privateFragment = "private-model-fragment-123";
	const states: WorkflowRepairStateV1[] = [];
	const valid = `\`\`\`knowledge-proposals\n${JSON.stringify([{
		op: "create", type: "K", title: "Fresh bounded candidate", body: "Synthetic evidence only",
		usageDecision: "candidate" }])}\n\`\`\``;
	const fake = new FakeSessionRunner(({ ref, turnIndex, message }) => {
		firstSessionId ??= ref.id;
		if (ref.id === firstSessionId) return { text: `\`\`\`knowledge-proposals\n${privateFragment}-${turnIndex}\n\`\`\``,
			readReturns: turnIndex === 1 ? returnedRanges(f.relative) : [] };
		assert.match(message, /fresh independent M04 judgment/);
		assert.doesNotMatch(message, new RegExp(privateFragment));
		return { text: valid, readReturns: returnedRanges(f.relative) };
	});
	f.ctx.runner = fake;
	const result = await runM04(f.ctx, { feedback: { kind: "M07", runId: f.goal.runId },
		freshSession: true, requiredM07ReadPaths: f.relative,
		onRepairState: async state => { states.push(state); } });
	assert.ok(result.snapshotId);
	assert.deepEqual(result.proposalAttempts.map(item => item.state), ["merged"]);
	assert.deepEqual([...fake.sessions.values()].map(item => item.turns), [2, 1]);
	assert.ok(states.some(item => item.failure === "malformed-proposal" && item.strategy === "fresh-context"));
	const receipt = await readFile(result.record.outputs.find(item => item.label === "M04 修复状态")!.path, "utf8");
	assert.doesNotMatch(receipt, new RegExp(privateFragment));
});

test("identical invalid drafts reuse their receipt before fresh valid correction and one merge", async t => {
	const f = await fixture(t);
	let firstSessionId: string | undefined;
	let submissions = 0, merges = 0;
	const captured: M04InvalidJudgmentEvent[] = [];
	const invalidRaw: string[] = [];
	const submit = f.store.submitProposal.bind(f.store), merge = f.store.merge.bind(f.store);
	f.store.submitProposal = async batch => { submissions += 1; return submit(batch); };
	f.store.merge = async id => { merges += 1; return merge(id); };
	const invalid = [{ op: "create", type: "K", title: "", body: "" }];
	const valid = [{ op: "create", type: "K", title: "Fresh candidate", body: "Synthetic bounded evidence", usageDecision: "candidate" }];
	const fake = new FakeSessionRunner(({ ref, turnIndex, message }) => {
		firstSessionId ??= ref.id;
		if (ref.id === firstSessionId) {
			assert.equal(captured.length, turnIndex - 1);
			const ops = turnIndex === 1 ? invalid : [{ body: "", title: "", type: "K", op: "create" }];
			const text = `\`\`\`knowledge-proposals\n${JSON.stringify(ops)}\n\`\`\``;
			invalidRaw.push(text);
			return { text,
				readReturns: turnIndex === 1 ? returnedRanges(f.relative) : [] };
		}
		assert.match(message, /rejected draft remains historical evidence/);
		return { text: `\`\`\`knowledge-proposals\n${JSON.stringify(valid)}\n\`\`\``, readReturns: returnedRanges(f.relative) };
	});
	f.ctx.runner = fake;
	const result = await runM04(f.ctx, { feedback: { kind: "M07", runId: f.goal.runId },
		freshSession: true, requiredM07ReadPaths: f.relative,
		onInvalidJudgment: async event => { captured.push(event); } });
	assert.equal(submissions, 2, "one rejected draft and one corrected draft, with no duplicate submission");
	assert.equal(merges, 1);
	assert.deepEqual(result.proposalAttempts.map(item => item.state), ["rejected-draft", "merged"]);
	assert.equal(result.proposalId, result.proposalAttempts[1].proposalId);
	assert.notEqual(result.proposalAttempts[0].proposalId, result.proposalAttempts[1].proposalId);
	assert.deepEqual([...fake.sessions.values()].map(item => item.turns), [2, 1]);
	assert.deepEqual(captured.map(event => event.rawResponse), invalidRaw);
	assert.notEqual(captured[0].rawResponse, captured[1].rawResponse);
	assert.deepEqual(captured.map(event => event.validation.code),
		["m04.proposal-structure", "m04.proposal-structure"]);
	assert.deepEqual(captured.map(event => [event.generation, event.attempt]), [[1, 1], [1, 2]]);
	assert.ok(captured.every(event => event.sessionId === firstSessionId &&
		event.coverage.every(item => item.complete)));
	const draftIds = captured.map(event => (event.validation.detail as { proposalId: string }).proposalId);
	assert.equal(draftIds[0], draftIds[1], "the same rejected receipt is reused without another submission");
});

test("different invalid draft prose with unchanged structural issues cannot evade fresh repair", async t => {
	const f = await fixture(t);
	let firstSessionId: string | undefined;
	const fake = new FakeSessionRunner(({ ref, turnIndex }) => {
		firstSessionId ??= ref.id;
		if (ref.id !== firstSessionId) return { text: "Fresh judgment: evidence supports no knowledge proposal.", readReturns: returnedRanges(f.relative) };
		return { text: `\`\`\`knowledge-proposals\n${JSON.stringify([{
			op: "create", type: "K", title: "", body: `Changing speculative prose ${turnIndex}`,
		}])}\n\`\`\``, readReturns: turnIndex === 1 ? returnedRanges(f.relative) : [] };
	});
	f.ctx.runner = fake;
	const result = await runM04(f.ctx, { feedback: { kind: "M07", runId: f.goal.runId },
		freshSession: true, requiredM07ReadPaths: f.relative });
	assert.equal(result.snapshotId, undefined);
	assert.equal(result.proposalAttempts.length, 2, "distinct rejected draft identities remain exact historical evidence");
	assert.ok(result.proposalAttempts.every(item => item.state === "rejected-draft"));
	assert.deepEqual([...fake.sessions.values()].map(item => item.turns), [2, 1]);
});

test("real structural correction allows a further fresh strategy for the new failure state", async t => {
	const f = await fixture(t);
	const sessionIds: string[] = [];
	const fake = new FakeSessionRunner(({ ref, turnIndex }) => {
		if (!sessionIds.includes(ref.id)) sessionIds.push(ref.id);
		const context = sessionIds.indexOf(ref.id);
		const ops = context === 0 ? [{ op: "create", type: "K", title: "", body: null }] :
			context === 1 ? [{ op: "create", type: "K", title: "", body: "Corrected body structure" }] :
			[{ op: "create", type: "K", title: "Corrected candidate", body: "Synthetic bounded evidence", usageDecision: "candidate" }];
		return { text: `\`\`\`knowledge-proposals\n${JSON.stringify(ops)}\n\`\`\``,
			readReturns: turnIndex === 1 ? returnedRanges(f.relative) : [] };
	});
	f.ctx.runner = fake;
	const result = await runM04(f.ctx, { feedback: { kind: "M07", runId: f.goal.runId },
		freshSession: true, requiredM07ReadPaths: f.relative });
	assert.ok(result.snapshotId);
	assert.deepEqual([...fake.sessions.values()].map(item => item.turns), [2, 2, 1]);
	assert.deepEqual(result.proposalAttempts.map(item => item.state), ["rejected-draft", "rejected-draft", "merged"]);
});

test("JSON syntax correction to a wrong top-level type is new format progress", async t => {
	const f = await fixture(t);
	const fake = new FakeSessionRunner(({ turnIndex }) => ({
		text: turnIndex === 1 ? "```knowledge-proposals\n{broken\n```" :
			turnIndex === 2 ? "```knowledge-proposals\n{}\n```" : "Corrected judgment: no supported knowledge proposal.",
		readReturns: turnIndex === 1 ? returnedRanges(f.relative) : [],
	}));
	f.ctx.runner = fake;
	const result = await runM04(f.ctx, { feedback: { kind: "M07", runId: f.goal.runId },
		freshSession: true, requiredM07ReadPaths: f.relative });
	assert.equal(result.record.status, "completed");
	assert.equal(fake.created.length, 1);
	assert.equal([...fake.sessions.values()][0].turns, 3);
	assert.deepEqual(result.proposalAttempts, []);
});

test("shuffling invalid operations and receipt order cannot disguise unchanged structural defects", async t => {
	const f = await fixture(t);
	let firstSessionId: string | undefined;
	const badTitle = { op: "create", type: "K", title: "", body: "Synthetic body" };
	const badBody = { op: "create", type: "K", title: "Synthetic title", body: null };
	const submit = f.store.submitProposal.bind(f.store);
	let submissions = 0;
	f.store.submitProposal = async batch => {
		submissions += 1;
		const receipt = await submit(batch);
		return { ...receipt, issues: submissions % 2 === 0 ? [...receipt.issues].reverse() : receipt.issues };
	};
	const fake = new FakeSessionRunner(({ ref, turnIndex }) => {
		firstSessionId ??= ref.id;
		if (ref.id !== firstSessionId) return { text: "Fresh judgment: no supported proposal.", readReturns: returnedRanges(f.relative) };
		return { text: `\`\`\`knowledge-proposals\n${JSON.stringify(turnIndex === 1 ? [badTitle, badBody] : [badBody, badTitle])}\n\`\`\``,
			readReturns: turnIndex === 1 ? returnedRanges(f.relative) : [] };
	});
	f.ctx.runner = fake;
	const result = await runM04(f.ctx, { feedback: { kind: "M07", runId: f.goal.runId },
		freshSession: true, requiredM07ReadPaths: f.relative });
	assert.equal(submissions, 2);
	assert.equal(result.snapshotId, undefined);
	assert.deepEqual([...fake.sessions.values()].map(item => item.turns), [2, 1]);
});

test("M01 continuation lazily prepares a snapshot-bound fresh context and reports its actual mode", async t => {
	const root = await mkdtemp(path.join(os.tmpdir(), "m04-m01-repair-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const ws = new Workspace(root);
	await mkdir(path.dirname(ws.problemFile), { recursive: true });
	await writeFile(ws.problemFile, "Original frozen M01 problem\n");
	const feedbackPath = path.join(root, "feedback.md");
	await writeFile(feedbackPath, "Frozen independent feedback\n");
	const store = createFileKnowledgeStore(ws.knowledgeDir); await store.init();
	const fake = new FakeSessionRunner(({ spec, turnIndex, message }) => {
		if (spec.label === "M01" && turnIndex === 1) return "M01 private causal reasoning marker";
		if (spec.label === "M01") {
			assert.doesNotMatch(message, /^# 局部知识包/m);
			assert.equal(reads, 0, "original continuation must not require knowledge retrieval");
			return "```knowledge-proposals\n{broken\n```";
		}
		assert.match(message, /Original frozen M01 problem/);
		assert.match(message, /# 局部知识包/);
		assert.doesNotMatch(message, /M01 private causal reasoning marker/);
		return "Fresh independent judgment: no knowledge operation.";
	});
	const ctx: StageContext = { ws, store, runner: fake, config: {
		roles: { execution: "fake/execution", reviewer: "fake/reviewer", research: "fake/research" }, concurrency: 1, tools: {} } };
	await runM01(ctx);
	let reads = 0;
	const list = store.list.bind(store);
	store.list = async (...args) => { reads += 1; return list(...args); };
	const result = await runM04(ctx, { feedback: { kind: "file", label: "Independent feedback", path: feedbackPath } });
	assert.equal(result.mode, "research-session");
	assert.equal(result.record.sessions[0].boundary?.mode, "continue");
	assert.equal(result.record.sessions[1].boundary?.mode, "fresh");
	assert.equal(fake.created.at(-1)?.tools.kind, "none");
	assert.ok(reads > 0, "snapshot-bound knowledge is loaded only for the fresh handoff");
	assert.deepEqual([...fake.sessions.values()].map(item => item.turns), [3, 1]);
});

test("unavailable knowledge retrieval only blocks an M01 fresh handoff, preserving original admission", async t => {
	for (const needsRepair of [false, true]) await t.test(needsRepair ? "fresh handoff" : "original judgment", async child => {
		const root = await mkdtemp(path.join(os.tmpdir(), "m04-m01-admission-"));
		child.after(() => rm(root, { recursive: true, force: true }));
		const ws = new Workspace(root);
		await mkdir(path.dirname(ws.problemFile), { recursive: true });
		await writeFile(ws.problemFile, "Original question\n");
		const feedbackPath = path.join(root, "feedback.md");
		await writeFile(feedbackPath, "Independent feedback\n");
		const store = createFileKnowledgeStore(ws.knowledgeDir); await store.init();
		const fake = new FakeSessionRunner(({ turnIndex }) => turnIndex === 1 ? "Initial M01 reasoning" :
			needsRepair ? "```knowledge-proposals\n{broken\n```" : "No supported knowledge proposal.");
		const ctx: StageContext = { ws, store, runner: fake, config: {
			roles: { execution: "fake/execution", reviewer: "fake/reviewer", research: "fake/research" }, concurrency: 1, tools: {} } };
		await runM01(ctx);
		store.list = async () => { throw new HarnessError("m04.knowledge", "private synthetic knowledge retrieval unavailable"); };
		const action = runM04(ctx, { feedback: { kind: "file", label: "Independent feedback", path: feedbackPath } });
		if (needsRepair) {
			await assert.rejects(action, error => error instanceof WorkflowRepairNeededError);
			const runs = await Promise.all((await ws.listRuns("M04")).map(id => ws.readRun("M04", id)));
			const transaction = JSON.parse(await readFile(runs[0].outputs.find(item => item.label === "M04 知识事务状态")!.path, "utf8"));
			assert.equal(transaction.state, "no-proposal");
			assert.deepEqual(transaction.attempts, []);
		} else {
			const result = await action;
			assert.equal(result.mode, "continue-m01");
			assert.equal(result.record.status, "completed");
		}
		assert.equal(fake.created.length, 1, "a failed fresh handoff cannot create a replacement session");
	});
});

test("repeated ineffective fresh judgment leaves typed open repair and an exact rejected transaction", async t => {
	const f = await fixture(t);
	const before = (await f.store.current())?.id;
	const invalid = `\`\`\`knowledge-proposals\n${JSON.stringify([{
		op: "create", type: "K", title: "", body: "Private rejected evidence" }])}\n\`\`\``;
	const states: WorkflowRepairStateV1[] = [];
	const fake = new FakeSessionRunner(({ turnIndex }) => ({ text: invalid,
		readReturns: turnIndex === 1 ? returnedRanges(f.relative) : [] }));
	f.ctx.runner = fake;
	await assert.rejects(runM04(f.ctx, { feedback: { kind: "M07", runId: f.goal.runId },
		freshSession: true, requiredM07ReadPaths: f.relative,
		onRepairState: async state => { states.push(state); } }), error =>
		error instanceof WorkflowRepairNeededError && error.code === "runner.workflow-repair-needed" && error.stage === "m04-judgment");
	assert.equal((await f.store.current())?.id, before);
	assert.deepEqual([...fake.sessions.values()].map(item => item.turns), [2, 1]);
	const runs = await Promise.all((await f.ws.listRuns("M04")).map(id => f.ws.readRun("M04", id)));
	const failed = runs.find(item => item.outputs.some(output => output.label === "M04 修复状态"))!;
	assert.equal(failed.status, "failed");
	const transaction = JSON.parse(await readFile(failed.outputs.find(item => item.label === "M04 知识事务状态")!.path, "utf8"));
	assert.equal(transaction.state, "rejected-draft");
	assert.equal(transaction.attempts.length, 1);
	assert.equal(transaction.snapshotId, undefined);
	assert.equal(transaction.attempts[0].state, "rejected-draft");
	assert.equal(failed.outputs.some(item => item.label === "合入结果"), false);
	assert.equal(states.at(-1)?.strategy, "workflow-repair-needed");
});

test("unread evidence stagnation preserves the driver-visible typed error after saving coverage", async t => {
	const f = await fixture(t);
	const fake = new FakeSessionRunner(() => "Provisional judgment without returned evidence.");
	f.ctx.runner = fake;
	await assert.rejects(runM04(f.ctx, { feedback: { kind: "M07", runId: f.goal.runId },
		freshSession: true, requiredM07ReadPaths: f.relative }), error => {
		assert.ok(error instanceof WorkflowRepairNeededError);
		assert.equal(error.code, "runner.workflow-repair-needed");
		assert.equal(error.stage, "m04-judgment");
		return true;
	});
	assert.deepEqual([...fake.sessions.values()].map(item => item.turns), [2, 1]);
	const runs = await Promise.all((await f.ws.listRuns("M04")).map(id => f.ws.readRun("M04", id)));
	const failed = runs.find(item => item.outputs.some(output => output.label === "M04 修复状态"))!;
	const transaction = JSON.parse(await readFile(failed.outputs.find(item => item.label === "M04 知识事务状态")!.path, "utf8"));
	assert.equal(transaction.state, "no-proposal");
	assert.deepEqual(transaction.attempts, []);
	const coverage = JSON.parse(await readFile(failed.outputs.find(item => item.label === "M07 回流证据实际访问范围")!.path, "utf8"));
	assert.equal(coverage.promptOutcome, "failed");
	assert.deepEqual(coverage.returnedRanges, []);
	const repair = JSON.parse(await readFile(failed.outputs.find(item => item.label === "M04 修复状态")!.path, "utf8"));
	assert.equal(repair.failure, "unread-m07-evidence");
	assert.equal(repair.strategy, "workflow-repair-needed");
});

test("unavailable fresh read-only context leaves typed open repair without store side effects", async t => {
	const f = await fixture(t);
	const states: WorkflowRepairStateV1[] = [];
	const fake = new FakeSessionRunner(() => "```knowledge-proposals\n{broken\n```");
	const create = fake.create.bind(fake);
	fake.create = async spec => {
		if (fake.created.length) throw new HarnessError("context.capability", "private synthetic host handoff failure");
		return { ...await create(spec), readReturnEvents: () => returnedRanges(f.relative) };
	};
	f.ctx.runner = fake;
	await assert.rejects(runM04(f.ctx, { feedback: { kind: "M07", runId: f.goal.runId },
		freshSession: true, requiredM07ReadPaths: f.relative,
		onRepairState: async state => { states.push(state); } }), error => {
		assert.ok(error instanceof WorkflowRepairNeededError);
		assert.doesNotMatch(error.message, /private synthetic host/);
		return true;
	});
	assert.equal(fake.created.length, 1);
	assert.equal(states.at(-1)?.failure, "context-handoff-unavailable");
	assert.equal(states.at(-1)?.strategy, "workflow-repair-needed");
	const runs = await Promise.all((await f.ws.listRuns("M04")).map(id => f.ws.readRun("M04", id)));
	const failed = runs.find(item => item.outputs.some(output => output.label === "M04 修复状态"))!;
	const transaction = JSON.parse(await readFile(failed.outputs.find(item => item.label === "M04 知识事务状态")!.path, "utf8"));
	assert.equal(transaction.state, "no-proposal");
	assert.deepEqual(transaction.attempts, []);
	assert.ok(failed.failures.some(item => item.includes("private synthetic host handoff failure")));
});

test("transient fresh-session creation failures retain their original transport classification", async t => {
	const f = await fixture(t);
	const transient = new Error("synthetic transient session I/O failure");
	const states: WorkflowRepairStateV1[] = [];
	const fake = new FakeSessionRunner(() => "```knowledge-proposals\n{broken\n```");
	const create = fake.create.bind(fake);
	fake.create = async spec => {
		if (fake.created.length) throw transient;
		return { ...await create(spec), readReturnEvents: () => returnedRanges(f.relative) };
	};
	f.ctx.runner = fake;
	await assert.rejects(runM04(f.ctx, { feedback: { kind: "M07", runId: f.goal.runId },
		freshSession: true, requiredM07ReadPaths: f.relative,
		onRepairState: async state => { states.push(state); } }), error => error === transient);
	assert.equal(states.some(item => item.strategy === "workflow-repair-needed"), false);
	assert.equal(fake.created.length, 1);
	const runs = await Promise.all((await f.ws.listRuns("M04")).map(id => f.ws.readRun("M04", id)));
	const failed = runs.find(item => item.outputs.some(output => output.label === "M04 修复状态"))!;
	const transaction = JSON.parse(await readFile(failed.outputs.find(item => item.label === "M04 知识事务状态")!.path, "utf8"));
	assert.equal(transaction.state, "no-proposal");
	assert.deepEqual(transaction.attempts, []);
});

test("fresh M04 judgment rejects reused identity, inherited transcript, and inherited read proof", async t => {
	for (const fault of ["reused-identity", "inherited-transcript", "inherited-read-proof"] as const)
		await t.test(fault, async child => {
			const f = await fixture(child);
			const states: WorkflowRepairStateV1[] = [];
			const fake = new FakeSessionRunner(({ turnIndex }) => ({
				text: "```knowledge-proposals\n{broken\n```",
				readReturns: turnIndex === 1 ? returnedRanges(f.relative) : [],
			}));
			const create = fake.create.bind(fake);
			let original: SessionHandle | undefined;
			fake.create = async spec => {
				if (!original) return original = await create(spec);
				if (fault === "reused-identity") return original;
				const handle = await create(spec);
				if (fault === "inherited-transcript") return { ...handle,
					transcript: () => [{ role: "assistant", text: "Inherited provisional judgment" }] };
				return { ...handle, readReturnEvents: () => returnedRanges(f.relative) };
			};
			f.ctx.runner = fake;
			await assert.rejects(runM04(f.ctx, { feedback: { kind: "M07", runId: f.goal.runId },
				freshSession: true, requiredM07ReadPaths: f.relative,
				onRepairState: async state => { states.push(state); } }), error => error instanceof WorkflowRepairNeededError);
			assert.equal(states.at(-1)?.failure, "context-handoff-unavailable");
			assert.equal(states.at(-1)?.strategy, "workflow-repair-needed");
			assert.equal([...fake.sessions.values()][0].turns, 2);
			assert.ok([...fake.sessions.values()].slice(1).every(item => item.turns === 0 && item.disposed));
			const runs = await Promise.all((await f.ws.listRuns("M04")).map(id => f.ws.readRun("M04", id)));
			const failed = runs.find(item => item.outputs.some(output => output.label === "M04 修复状态"))!;
			const transaction = JSON.parse(await readFile(failed.outputs.find(item => item.label === "M04 知识事务状态")!.path, "utf8"));
			assert.equal(transaction.state, "no-proposal");
			assert.deepEqual(transaction.attempts, []);
		});
});

test("observed required evidence size changes block acceptance with typed open repair", async t => {
	const f = await fixture(t);
	const proposal = `\`\`\`knowledge-proposals\n${JSON.stringify([{
		op: "create", type: "K", title: "Unacceptable changed-input candidate", body: "Synthetic body",
		usageDecision: "candidate" }])}\n\`\`\``;
	const fake = new FakeSessionRunner(async () => {
		await writeFile(path.join(f.ws.runDir("M07", f.goal.runId), f.relative[0]), "changed\ninput\nextra\n");
		return { text: proposal, readReturns: returnedRanges(f.relative) };
	});
	f.ctx.runner = fake;
	await assert.rejects(runM04(f.ctx, { feedback: { kind: "M07", runId: f.goal.runId },
		freshSession: true, requiredM07ReadPaths: f.relative }), error => error instanceof WorkflowRepairNeededError);
	assert.equal(fake.created.length, 1);
	const runs = await Promise.all((await f.ws.listRuns("M04")).map(id => f.ws.readRun("M04", id)));
	const failed = runs.find(item => item.outputs.some(output => output.label === "M04 修复状态"))!;
	const transaction = JSON.parse(await readFile(failed.outputs.find(item => item.label === "M04 知识事务状态")!.path, "utf8"));
	assert.equal(transaction.state, "no-proposal");
	assert.deepEqual(transaction.attempts, []);
	assert.equal(failed.outputs.some(item => item.label.startsWith("知识提案草案")), false);
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
