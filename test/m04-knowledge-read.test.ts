import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createFileKnowledgeStore } from "../src/knowledge/store.ts";
import { FakeSessionRunner } from "../src/runner/fake.ts";
import { runM04 } from "../src/stages/m04.ts";
import { Workspace } from "../src/workspace.ts";

test("fresh M04 can page a published record by ID and sees live dependency limits", async t => {
	const root = await mkdtemp(path.join(os.tmpdir(), "m04-knowledge-read-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const ws = new Workspace(root);
	await mkdir(path.dirname(ws.problemFile), { recursive: true });
	await writeFile(ws.problemFile, "Synthetic operator question\n");
	const feedbackPath = path.join(root, "feedback.md");
	await writeFile(feedbackPath, "Review the stated condition.\n");
	const store = createFileKnowledgeStore(ws.knowledgeDir);
	await store.init();
	const apply = async (ops: Parameters<typeof store.submitProposal>[0]["ops"]) => {
		const receipt = await store.submitProposal({ stage: "test", runId: "knowledge-read", ops });
		assert.equal(receipt.structurallyValid, true, receipt.issues.map(item => item.message).join("; "));
		await store.merge(receipt.proposalId);
	};
	await apply([{ op: "create", type: "X", title: "Specific context", body: "Only measured context", usageDecision: "adopted" }]);
	await apply([{ op: "create", type: "J", title: "Conditional argument", body: "Long reasoning ".repeat(1000),
		scope: ["X001"], usageDecision: "adopted" }]);
	await apply([{ op: "limit", target: "X001", kind: "needs_recheck", reason: "Context changed", authority: "test evidence" }]);
	await apply([{ op: "create", type: "J", title: "Counterevidence requiring inspection", body: "COUNTEREVIDENCE-BODY-IS-NOT-AUTOMATICALLY-READ",
		refs: [{ rel: "refutes", target: "J001@1" }] }]);
	const pages: string[] = [];
	const runner = new FakeSessionRunner(async ({ tools }) => {
		assert.equal(typeof tools.knowledge_read, "function");
		const first = await tools.knowledge_read({ id: "J001", offset: 0, limit: 5000 });
		pages.push(first.text);
		assert.match(first.text, /J001@1/);
		assert.match(first.text, /X001@1：needs_recheck/);
		assert.match(first.text, /下一页 offset=5000/);
		assert.match(first.text, /J002@1：exploratory_only/);
		assert.doesNotMatch(first.text, /COUNTEREVIDENCE-BODY-IS-NOT-AUTOMATICALLY-READ/);
		// Live limits can be published before CURRENT; the next page must show them.
		await writeFile(path.join(ws.knowledgeDir, "limits.json"), JSON.stringify([
			...await store.limits(), { target: "J001", kind: "withdrawn", reason: "New live counterevidence", authority: "M04", since: new Date().toISOString() },
		]));
		const next = await tools.knowledge_read({ id: "J001", offset: 5000, limit: 12000 });
		pages.push(next.text);
		assert.match(next.text, /已到末尾/);
		assert.match(next.text, /J001@1；可用性：not_allowed/);
		assert.match(next.text, /New live counterevidence/);
		assert.match(next.text, /J002@1：exploratory_only/);
		assert.equal((first.details as { total: number }).total, (next.details as { total: number }).total,
			"live warning changes must not shift immutable record page offsets");
		const counterevidence = await tools.knowledge_read({ id: "J002" });
		assert.match(counterevidence.text, /COUNTEREVIDENCE-BODY-IS-NOT-AUTOMATICALLY-READ/);
		const absent = await tools.knowledge_read({ id: "C999" });
		assert.match(absent.text, /未在本次 M04 知识快照发布/);
		return "The context needs recheck; no knowledge proposal.";
	});
	const result = await runM04({ ws, store, runner, config: { roles: { execution: "fake/execution", reviewer: "fake/reviewer", research: "fake/research" }, concurrency: 1, tools: {} } },
		{ feedback: { kind: "file", label: "Synthetic review", path: feedbackPath }, freshSession: true });
	assert.equal(result.record.status, "completed");
	assert.equal(pages.length, 2);
	const logRef = result.record.outputs.find(item => item.label === "知识按 ID 补读范围");
	assert.ok(logRef);
	const log = JSON.parse(await readFile(logRef.path, "utf8"));
	assert.deepEqual(log.calls.map((call: { id: string; status: string; offset: number }) => [call.id, call.status, call.offset]),
		[["J001", "returned", 0], ["J001", "returned", 5000], ["J002", "returned", 0], ["C999", "not-in-snapshot", 0]]);
	assert.equal(log.calls[0].version, 1);
	assert.equal(log.calls[0].end, 5000);
	assert.equal(log.calls[1].end, log.calls[1].total);
	assert.ok(log.calls[1].end < 17000, "the actual end is smaller than offset plus requested limit");
	assert.ok(log.calls.every((call: { sessionId: string; sessionGeneration: number }) =>
		call.sessionId === log.finalSessionId && call.sessionGeneration === 1));
	assert.equal(runner.created.find(spec => spec.label === "M04-research")?.tools.kind, "custom");
});

test("M04 can discover an initial-pack omission by a later symptom and page stable record ordinals", async t => {
	const root = await mkdtemp(path.join(os.tmpdir(), "m04-knowledge-select-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const ws = new Workspace(root);
	await mkdir(path.dirname(ws.problemFile), { recursive: true });
	await writeFile(ws.problemFile, "Synthetic operator question\n");
	const feedbackPath = path.join(root, "feedback.md");
	await writeFile(feedbackPath, "Review the unrelated stated condition.\n");
	const store = createFileKnowledgeStore(ws.knowledgeDir);
	await store.init();
	const proposal = await store.submitProposal({ stage: "test", runId: "select-audit", ops: [
		{ op: "create", type: "K", title: "needle copy-wait case A", body: "ORIGINAL-A-BODY",
			fields: { retrieval: { context: { backend: "cuda" } } } },
		{ op: "create", type: "K", title: "needle copy-wait case B", body: "ORIGINAL-B-BODY",
			fields: { retrieval: { context: { backend: "cuda" } }, avoid_when: "already synchronized" } },
	] });
	assert.equal(proposal.structurallyValid, true);
	await store.merge(proposal.proposalId);
	const runner = new FakeSessionRunner(async ({ tools, ref }) => {
		assert.equal(typeof tools.knowledge_select, "function");
		await assert.rejects(tools.knowledge_select({ query: "needle copy-wait", contextJson: '{"backend":"cuda","structure":"staged-copy"}' }),
			/structure\/appliedTransforms\/symptoms must be string\[\]/);
		const contextJson = '{"backend":"cuda","structure":["staged-copy"],"symptoms":["copy-wait"]}';
		const first = await tools.knowledge_select({ query: "needle copy-wait", contextJson, offset: 0, limit: 1 });
		assert.match(first.text, /K001@1/);
		assert.doesNotMatch(first.text, /K002@1/, "only the requested discovery record is rendered");
		assert.match(first.text, /下一页 offset=1/);
		assert.doesNotMatch(first.text, /ORIGINAL-A-BODY|ORIGINAL-B-BODY/);
		assert.deepEqual((first.details as { returnedRefs: string[] }).returnedRefs, ["K001@1"]);
		await writeFile(path.join(ws.knowledgeDir, "limits.json"), JSON.stringify([
			{ target: "K002", kind: "withdrawn", reason: "New live contrary result", authority: "test", since: new Date().toISOString() },
		]));
		const second = await tools.knowledge_select({ query: "needle copy-wait", contextJson, offset: 1, limit: 1 });
		assert.deepEqual((second.details as { returnedRefs: string[] }).returnedRefs, ["K002@1"]);
		assert.equal((first.details as { total: number }).total, (second.details as { total: number }).total);
		assert.match(second.text, /not_allowed|needs_recheck/);
		assert.match(second.text, /"kind":"withdrawn","target":"K002"/);
		assert.doesNotMatch(second.text, /ORIGINAL-B-BODY/);
		const read = await tools.knowledge_read({ id: "K002" });
		assert.match(read.text, /ORIGINAL-B-BODY/);
		assert.match(read.text, /New live contrary result/);
		return `Found K002@1 and read its original body in ${ref.id}; no knowledge proposal.`;
	});
	const result = await runM04({ ws, store, runner, config: { roles: { execution: "fake/execution", reviewer: "fake/reviewer", research: "fake/research" }, concurrency: 1, tools: {} } },
		{ feedback: { kind: "file", label: "Synthetic review", path: feedbackPath }, freshSession: true });
	const initial = result.record.outputs.find(item => item.label === "提供给研究会话的局部知识包")!;
	assert.doesNotMatch(await readFile(initial.path, "utf8"), /K001@1|K002@1/);
	const selectionLog = result.record.outputs.find(item => item.label === "知识会话内检索范围")!;
	const log = JSON.parse(await readFile(selectionLog.path, "utf8"));
	assert.deepEqual(log.calls.map((call: { returnedRefs: string[] }) => call.returnedRefs), [["K001@1"], ["K002@1"]]);
	assert.ok(log.calls.every((call: { query: string; context: { backend: string; structure: string[]; symptoms: string[] }; sessionId: string; sessionGeneration: number }) =>
		call.query === "needle copy-wait" && call.context.backend === "cuda" && call.context.structure[0] === "staged-copy" &&
		call.context.symptoms[0] === "copy-wait" && call.sessionId === log.finalSessionId && call.sessionGeneration === 1));
});

test("M04 can page only an accepted historical checkpoint artifact and audits the actual session", async t => {
	const root = await mkdtemp(path.join(os.tmpdir(), "m04-knowledge-artifact-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const ws = new Workspace(root);
	await mkdir(path.dirname(ws.problemFile), { recursive: true });
	await writeFile(ws.problemFile, "Synthetic operator question\n");
	const feedbackPath = path.join(root, "feedback.md");
	await writeFile(feedbackPath, "Read old evidence before deciding.\n");
	const store = createFileKnowledgeStore(ws.knowledgeDir);
	await store.init();
	const previousRun = await ws.startRun("M04", []);
	await ws.finishRun(previousRun, "completed");
	const m04Id = previousRun.runId, m07Id = "20261017T000000Z-abcd", checkpointId = "C001", taskId = "T001";
	const proposal = await store.submitProposal({ stage: "M04", runId: m04Id, ops: [
		{ op: "create", type: "E", title: "Prior frozen evidence", body: "See accepted code", fields: { task: taskId, artifact: "src/kernel.cpp" } },
		{ op: "create", type: "E", title: "Prior receipt index", body: "A numeric receipt is not an artifact path",
			fields: { task: taskId, readReceipts: [42], readSources: ["002-kernel.src"] } },
		{ op: "create", type: "E", title: "Prior multi-task record", body: "Only selected accepted tasks may be inspected",
			fields: { tasks: [taskId, "T002"] } },
	] });
	assert.equal(proposal.structurallyValid, true);
	await store.merge(proposal.proposalId);
	const m04Dir = path.join(root, "stages", "M04", m04Id), m07Dir = path.join(root, "stages", "M07", m07Id);
	const workDir = path.join(m07Dir, "tasks", taskId, "work");
	const reviewPath = path.join(m07Dir, "tasks", taskId, "review-snapshot", "001-kernel.cpp");
	const checkpointRoot = path.join(m07Dir, "checkpoints", checkpointId);
	const frozen = path.join(checkpointRoot, "evidence", "tasks", taskId, "review-snapshot", "001-kernel.cpp");
	const sourceRelative = `evidence/tasks/${taskId}/review-snapshot/002-kernel.src`;
	const frozenSource = path.join(checkpointRoot, sourceRelative);
	await mkdir(m04Dir, { recursive: true });
	await mkdir(path.dirname(frozen), { recursive: true });
	await writeFile(path.join(m04Dir, "m07-source.json"), JSON.stringify({ m07RunId: m07Id, checkpointId, selectedTaskIds: [taskId] }));
	await writeFile(path.join(m07Dir, "goal.json"), JSON.stringify({ runId: m07Id, tasks: [{ taskId, workDir,
		review: { artifacts: [{ sourcePath: path.join(workDir, "src", "kernel.cpp"), path: reviewPath, mediaType: "text" }] } }] }));
	await writeFile(path.join(checkpointRoot, "goal.json"), JSON.stringify({ runId: m07Id, tasks: [{ taskId, status: "accepted",
		review: { artifacts: [{ path: frozen, mediaType: "text" }, { path: frozenSource, mediaType: "binary" }] } }] }));
	await writeFile(path.join(checkpointRoot, "manifest.json"), JSON.stringify({ m07RunId: m07Id, checkpointId, selectedTaskIds: [taskId],
		files: [{ sourceRelativePath: path.relative(root, reviewPath), relativePath: path.relative(checkpointRoot, frozen) },
			{ sourceRelativePath: `stages/M07/${m07Id}/tasks/${taskId}/review-snapshot/002-kernel.src`, relativePath: sourceRelative }] }));
	await writeFile(frozen, "FROZEN-PRIOR-EVIDENCE\n");
	await writeFile(frozenSource, "FROZEN-LEGACY-SOURCE\n");
	const runner = new FakeSessionRunner(async ({ ref, tools }) => {
		assert.equal(typeof tools.knowledge_artifact_read, "function");
		const original = await tools.knowledge_read({ id: "E001" });
		assert.match(original.text, /src\/kernel\.cpp/);
		const first = await tools.knowledge_artifact_read({ id: "E001", offset: 0, limit: 8 });
		const next = await tools.knowledge_artifact_read({ id: "E001", offset: 8, limit: 100 });
		assert.match(first.text, /FROZEN-P/);
		assert.match(next.text, /RIOR-EVIDENCE/);
		assert.equal((first.details as { total: number }).total, (next.details as { total: number }).total);
		const listing = await tools.knowledge_artifact_read({ id: "E002", list: true, offset: 0, limit: 30 });
		assert.equal((listing.details as { contentKind: string }).contentKind, "artifact-index");
		assert.doesNotMatch(listing.text, /FROZEN-LEGACY-SOURCE/);
		const later = await tools.knowledge_artifact_read({ id: "E002", list: true,
			offset: (listing.details as { end: number }).end, limit: 1000 });
		assert.match(later.text, /002-kernel\.src/);
		const evidence = await tools.knowledge_artifact_read({ id: "E002", artifact: sourceRelative });
		assert.match(evidence.text, /FROZEN-LEGACY-SOURCE/);
		await assert.rejects(tools.knowledge_artifact_read({ id: "E002", artifact: "42" }), /exact listed text file/);
		const multi = await tools.knowledge_artifact_read({ id: "E003", list: true });
		assert.match(multi.text, /T001\/review-snapshot/);
		assert.match(multi.text, /"taskId":"T002".*not selected/);
		assert.equal((multi.details as { contentKind: string }).contentKind, "artifact-index");
		await writeFile(path.join(m04Dir, "m07-source.json"), JSON.stringify({ m07RunId: m07Id, checkpointId, selectedTaskIds: [] }));
		await assert.rejects(tools.knowledge_artifact_read({ id: "E001" }), /does not select this task/);
		return `Read the accepted prior artifact in ${ref.id}; no knowledge proposal.`;
	});
	const result = await runM04({ ws, store, runner, config: { roles: { execution: "fake/execution", reviewer: "fake/reviewer", research: "fake/research" }, concurrency: 1, tools: {} } },
		{ feedback: { kind: "file", label: "Synthetic review", path: feedbackPath }, freshSession: true });
	assert.equal(result.record.status, "completed");
	const ref = result.record.outputs.find(item => item.label === "知识历史附件实际读取范围")!;
	const log = JSON.parse(await readFile(ref.path, "utf8"));
	assert.deepEqual(log.calls.map((call: { status: string; offset: number; list?: boolean }) => [call.status, call.offset, call.list === true]),
		[["returned", 0, false], ["returned", 8, false], ["returned", 0, true], ["returned", 30, true],
			["returned", 0, false], ["failed", 0, false], ["returned", 0, true], ["failed", 0, false]]);
	assert.ok(log.calls.every((call: { sessionId: string; sessionGeneration: number }) => call.sessionId === log.finalSessionId && call.sessionGeneration === 1));
	assert.equal(log.calls[0].source, `${m04Id}/${checkpointId}/${taskId}`);
});

test("M04 without a published knowledge context has no knowledge read tool", async t => {
	const root = await mkdtemp(path.join(os.tmpdir(), "m04-empty-knowledge-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const ws = new Workspace(root);
	await mkdir(path.dirname(ws.problemFile), { recursive: true });
	await writeFile(ws.problemFile, "Synthetic question\n");
	const feedbackPath = path.join(root, "feedback.md");
	await writeFile(feedbackPath, "No knowledge yet.\n");
	const store = createFileKnowledgeStore(ws.knowledgeDir);
	await store.init();
	const runner = new FakeSessionRunner(({ tools }) => {
		assert.equal(tools.knowledge_read, undefined);
		assert.equal(tools.knowledge_select, undefined);
		return "No knowledge proposal.";
	});
	const result = await runM04({ ws, store, runner, config: { roles: { execution: "fake/execution", reviewer: "fake/reviewer", research: "fake/research" }, concurrency: 1, tools: {} } },
		{ feedback: { kind: "file", label: "Synthetic review", path: feedbackPath }, freshSession: true });
	assert.equal(result.record.status, "completed");
	assert.equal(runner.created.find(spec => spec.label === "M04-research")?.tools.kind, "none");
	assert.equal(result.record.outputs.some(item => item.label === "知识按 ID 补读范围"), false);
});


test("knowledge read audit keeps actual versions and session ownership after fresh judgment repair", async t => {
	const root = await mkdtemp(path.join(os.tmpdir(), "m04-knowledge-read-repair-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const ws = new Workspace(root);
	await mkdir(path.dirname(ws.problemFile), { recursive: true });
	await writeFile(ws.problemFile, "Synthetic question\n");
	const feedbackPath = path.join(root, "feedback.md");
	await writeFile(feedbackPath, "Review recorded knowledge.\n");
	const store = createFileKnowledgeStore(ws.knowledgeDir);
	await store.init();
	for (const ops of [
		[{ op: "create" as const, type: "K" as const, title: "Existing knowledge", body: "Original body" }],
		[{ op: "revise" as const, id: "K001", body: "Second version body", reason: "Recorded revision" }],
	]) {
		const proposal = await store.submitProposal({ stage: "M04", runId: "read-audit", ops });
		assert.equal(proposal.structurallyValid, true);
		await store.merge(proposal.proposalId);
	}
	let firstSessionId: string | undefined;
	const runner = new FakeSessionRunner(async ({ ref, turnIndex, tools }) => {
		firstSessionId ??= ref.id;
		const selection = await tools.knowledge_select({ query: "Existing knowledge" });
		assert.match(selection.text, /K001@2/);
		const response = await tools.knowledge_read({ id: "K001", offset: 0, limit: 12000 });
		assert.match(response.text, /K001@2/);
		if (ref.id === firstSessionId) {
			assert.ok(turnIndex <= 2, "unchanged malformed judgment must switch to a fresh context");
			return "```knowledge-proposals\n{\n```";
		}
		return "No knowledge proposal after reading the current record.";
	});
	const result = await runM04({ ws, store, runner, config: { roles: { execution: "fake/execution", reviewer: "fake/reviewer", research: "fake/research" }, concurrency: 1, tools: {} } },
		{ feedback: { kind: "file", label: "Synthetic review", path: feedbackPath }, freshSession: true });
	const logRef = result.record.outputs.find(item => item.label === "知识按 ID 补读范围")!;
	const log = JSON.parse(await readFile(logRef.path, "utf8"));
	assert.equal(log.calls.length, 3);
	assert.deepEqual(log.calls.map((call: { sessionGeneration: number }) => call.sessionGeneration), [1, 1, 2]);
	assert.deepEqual(log.calls.map((call: { sessionId: string }) => call.sessionId),
		[firstSessionId, firstSessionId, log.finalSessionId]);
	assert.notEqual(firstSessionId, log.finalSessionId);
	assert.ok(log.calls.every((call: { version: number; end: number; total: number; limit: number }) =>
		call.version === 2 && call.end === call.total && call.end < call.limit));
	const selectionRef = result.record.outputs.find(item => item.label === "知识会话内检索范围")!;
	const selectionLog = JSON.parse(await readFile(selectionRef.path, "utf8"));
	assert.deepEqual(selectionLog.calls.map((call: { sessionGeneration: number }) => call.sessionGeneration), [1, 1, 2]);
	assert.deepEqual(selectionLog.calls.map((call: { sessionId: string }) => call.sessionId),
		[firstSessionId, firstSessionId, selectionLog.finalSessionId]);
	assert.ok(selectionLog.calls.every((call: { returnedRefs: string[] }) => call.returnedRefs.includes("K001@2")));
});
