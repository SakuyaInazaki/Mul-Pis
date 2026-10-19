import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createFileKnowledgeStore } from "../src/knowledge/store.ts";
import { retrieveKnowledge } from "../src/knowledge/retrieval.ts";
import type { KnowledgeStore, ProposalOp } from "../src/knowledge/types.ts";
import { createExecutionKnowledgeTools, type ExecutionKnowledgeOptions, type KnowledgeAccessEvent } from "../src/m07/execution-knowledge.ts";
import { createM07Controller } from "../src/m07/controller.ts";
import { FakeSessionRunner } from "../src/runner/fake.ts";
import type { StageContext } from "../src/stages/context.ts";
import { Workspace } from "../src/workspace.ts";

async function apply(store: KnowledgeStore, ops: ProposalOp[]) {
	const proposal = await store.submitProposal({ stage: "M04", runId: "knowledge-access", ops });
	assert.equal(proposal.structurallyValid, true, JSON.stringify(proposal.issues));
	await store.merge(proposal.proposalId);
}

async function setup(t: { after(callback: () => Promise<void>): void }, ops: ProposalOp[]) {
	const root = await mkdtemp(path.join(tmpdir(), "m07-knowledge-access-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const store = createFileKnowledgeStore(path.join(root, "knowledge"));
	await store.init();
	await apply(store, ops);
	const snapshot = (await store.current())!.id;
	const events: KnowledgeAccessEvent[] = [];
	const makeTools = (extra: Partial<ExecutionKnowledgeOptions> = {}) => Object.fromEntries(createExecutionKnowledgeTools({
		store, expectedSnapshot: snapshot, requiredIds: [], archiveDir: path.join(root, "access"),
		onAccess: async event => { events.push(event); }, ...extra,
	}).map(tool => [tool.name, tool]));
	return { root, store, snapshot, events, makeTools };
}

test("phase queries change roots without dropping task requirements or warning dependencies", async t => {
	const f = await setup(t, [
		{ op: "create", type: "K", title: "compile", body: "compile body", fields: { retrieval: { context: { stage: "compile-repair" } } } },
		{ op: "create", type: "K", title: "performance", body: "performance body", fields: { retrieval: { context: { stage: "performance" } } } },
		{ op: "create", type: "K", title: "required", body: "always inspect the original conditions" },
	]);
	await apply(f.store, [{ op: "create", type: "J", title: "conditional negative", body: "Only failed before staging; not a global prohibition", refs: [{ rel: "limits", target: "K002" }] }]);
	const tools = f.makeTools({ expectedSnapshot: (await f.store.current())!.id, requiredIds: ["K003"] });
	await tools.knowledge_select.execute({ text: "", stage: "compile-repair" });
	assert.deepEqual(new Set(f.events.at(-1)!.selectedRefs), new Set(["K001@1", "K003@1"]));
	await tools.knowledge_select.execute({ text: "", stage: "performance" });
	assert.deepEqual(new Set(f.events.at(-1)!.selectedRefs), new Set(["K002@1", "K003@1", "J001@1"]));
	const read = await tools.knowledge_read.execute({ ref: "J001", stage: "performance" });
	assert.match(read.text, /Only failed before staging; not a global prohibition/);
	assert.match(read.text, /K003/);
});

test("an unscoped selection does not invent an empty applicability context", async t => {
	const f = await setup(t, [{ op: "create", type: "K", title: "specific API", body: "recorded API evidence" }]);
	const tools = f.makeTools();
	const result = await tools.knowledge_select.execute({ text: "specific API" });
	assert.match(result.text, /K001@1/);
	assert.doesNotMatch(result.text, /本次明确检索情境：\{\}|record-context/);
});

test("index discovery does not inject long bodies; explicit record pages freeze full fields and actual return coverage", async t => {
	const body = "unread body ".repeat(7000) + "END-OF-ORIGINAL-BODY";
	const f = await setup(t, [{ op: "create", type: "K", title: "staged copy", body,
		fields: { artifact: "original/source.cpp", avoid_when: "no staging", retrieval: { context: { structure: ["staged-copy"] } } } }]);
	const tools = f.makeTools();
	const brief = await tools.knowledge_select.execute({ text: "", structure: ["staged-copy"] });
	assert.match(brief.text, /登记来源：M04\//);
	assert.match(brief.text, /避免条件（原字段）：no staging/);
	assert.match(brief.text, /原文片段：unread body/);
	assert.doesNotMatch(brief.text, /END-OF-ORIGINAL-BODY/);
	const selected = await tools.knowledge_select.execute({ text: "", structure: ["staged-copy"], format: "index" });
	assert.doesNotMatch(selected.text, /unread body|END-OF-ORIGINAL-BODY/);
	assert.match(selected.text, /staged-copy/);
	await tools.knowledge_read.execute({ ref: "K001", limit: 800 });
	const first = f.events.at(-1)!;
	assert.equal(first.returnedRange!.end, 800);
	assert.equal(first.returnedRange!.unit, undefined, "original record reads retain UTF-16 character offsets");
	const frozen = JSON.parse(await readFile(first.frozenPath, "utf8"));
	assert.equal(frozen.extra.record.body, body);
	assert.equal(frozen.extra.record.fields.artifact, "original/source.cpp");
	assert.doesNotMatch(frozen.returnedText, /END-OF-ORIGINAL-BODY/);
	const offset = frozen.frozenContent.indexOf("END-OF-ORIGINAL-BODY");
	assert.ok(offset > 60_000);
	const last = await tools.knowledge_read.execute({ ref: "K001@1", offset, limit: 100 });
	assert.match(last.text, /END-OF-ORIGINAL-BODY/);
	assert.equal(f.events.at(-1)!.returnedRange!.offset, offset);
});

test("live deactivation is visible on every page without refreshing the frozen snapshot", async t => {
	const f = await setup(t, [{ op: "create", type: "K", title: "repair", body: "historical evidence remains readable", usageDecision: "adopted" }]);
	const tools = f.makeTools();
	await tools.knowledge_read.execute({ ref: "K001" });
	// Model the store's deactivation-first publication window: limits precede CURRENT.
	await writeFile(path.join(f.root, "knowledge", "limits.json"), JSON.stringify([{ target: "K001", kind: "withdrawn", reason: "new contrary evidence", authority: "M04", since: new Date().toISOString() }]));
	const limited = await tools.knowledge_read.execute({ ref: "K001", offset: 1, limit: 1 });
	assert.match(limited.text, /not_allowed/);
	assert.match(limited.text, /new contrary evidence/);
	assert.equal((await f.store.current())!.id, f.snapshot);
	const frozen = JSON.parse(await readFile(f.events.at(-1)!.frozenPath, "utf8"));
	assert.equal(frozen.liveLimits[0].kind, "withdrawn");
});

test("record page offsets survive phase and live-limit changes while each page shows current conditions", async t => {
	const f = await setup(t, [{ op: "create", type: "K", title: "conditional optimization",
		body: "Original evidence line.\n".repeat(700), usageDecision: "adopted",
		fields: { retrieval: { context: { stage: "performance", backend: "test-backend" } } } }]);
	const tools = f.makeTools({ context: { stage: "compile-repair", backend: "test-backend" } });
	await tools.knowledge_read.execute({ ref: "K001", stage: "performance", limit: 800 });
	const first = JSON.parse(await readFile(f.events.at(-1)!.frozenPath, "utf8"));
	await writeFile(path.join(f.root, "knowledge", "limits.json"), JSON.stringify([
		{ target: "K001", kind: "withdrawn", reason: "New contrary condition", authority: "M04", since: new Date().toISOString() },
	]));
	// Omit stage on the continuation: the task's initial context applies, but
	// neither that different caveat nor the new limit may change record offsets.
	const secondResult = await tools.knowledge_read.execute({ ref: "K001", offset: 800, limit: 800 });
	const second = JSON.parse(await readFile(f.events.at(-1)!.frozenPath, "utf8"));
	assert.equal(second.frozenContent, first.frozenContent);
	assert.equal(second.returnedRange.total, first.returnedRange.total);
	assert.deepEqual([second.returnedRange.offset, second.returnedRange.end], [800, 1600]);
	assert.ok(secondResult.text.endsWith(first.frozenContent.slice(800, 1600)));
	assert.match(secondResult.text, /New contrary condition/);
	assert.match(secondResult.text, /not_allowed/);
	assert.equal(second.safety.context.stage, "compile-repair");
	assert.equal(second.safety.currentRecord.retrievalContext.stage, "performance");
	assert.match(secondResult.text, /Compare declared prerequisites with the current context/);
	assert.equal(second.returnedIndex, undefined, "record pages must not append the entire discovery index");
	assert.equal(second.extra.record.fields.retrieval.context.backend, "test-backend");
});

test("a later snapshot and unpublished future versions cannot enter execution knowledge access", async t => {
	const f = await setup(t, [{ op: "create", type: "K", title: "original", body: "original epoch" }]);
	const tools = f.makeTools();
	await assert.rejects(tools.knowledge_read.execute({ ref: "K001@2" }), /not in the frozen/);
	await apply(f.store, [{ op: "revise", id: "K001", body: "NEW-EPOCH-CONTENT", reason: "revision" }]);
	await assert.rejects(tools.knowledge_select.execute({ text: "original" }), /differs from the frozen/);
	await assert.rejects(tools.knowledge_read.execute({ ref: "K001" }), /differs from the frozen/);
	assert.equal(f.events.at(-1)!.status, "failed");
	assert.doesNotMatch(await readFile(f.events.at(-1)!.frozenPath, "utf8"), /NEW-EPOCH-CONTENT/);
});

test("ordinary knowledge tools never implicitly load method experience", async t => {
	const f = await setup(t, [{ op: "create", type: "K", title: "method", body: "METHOD-BODY", fields: { experience: {
		version: 1, targetKind: "executor", applicableStages: ["M07"], requiredTags: [], excludedTags: [], requiredRefs: [],
	} } }]);
	const tools = f.makeTools();
	const selected = await tools.knowledge_select.execute({ text: "method" });
	assert.doesNotMatch(selected.text, /METHOD-BODY/);
	assert.deepEqual(f.events.at(-1)!.selectedRefs, []);
	await assert.rejects(tools.knowledge_read.execute({ ref: "K001" }), /ExperienceProvider/);
});

test("record artifact paths remain metadata and never implicitly read external evidence", async t => {
	const f = await setup(t, [{ op: "create", type: "E", title: "evidence", body: "see unregistered.txt", fields: { artifact: "unregistered.txt" } }]);
	await writeFile(path.join(f.root, "unregistered.txt"), "EXTERNAL-EVIDENCE-NOT-READ\n");
	const tools = f.makeTools();
	assert.deepEqual(Object.keys(tools).sort(), ["knowledge_read", "knowledge_select"]);
	const result = await tools.knowledge_read.execute({ ref: "E001" });
	assert.match(result.text, /unregistered\.txt/);
	assert.match(result.text, /Referenced bodies\/artifacts are not automatically read or adopted/);
	assert.doesNotMatch(result.text, /EXTERNAL-EVIDENCE-NOT-READ/);
	const frozen = JSON.parse(await readFile(f.events.at(-1)!.frozenPath, "utf8"));
	assert.equal(frozen.extra.record.fields.artifact, "unregistered.txt");
	assert.equal(frozen.returnedRange.content, "record");
	assert.doesNotMatch(frozen.frozenContent, /EXTERNAL-EVIDENCE-NOT-READ/);
});

test("artifact read follows an accepted M04 checkpoint binding rather than a record path alone", async t => {
	const root = await mkdtemp(path.join(tmpdir(), "m07-knowledge-artifact-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const store = createFileKnowledgeStore(path.join(root, ".agent", "knowledge"));
	await store.init();
	const m04Id = "20261018T000000Z-abcd", m07Id = "20261017T000000Z-abcd", checkpointId = "C001", taskId = "T001";
	const proposal = await store.submitProposal({ stage: "M04", runId: m04Id, ops: [
		{ op: "create", type: "E", title: "frozen code", body: "Original evidence has a source file.", fields: { task: taskId, artifact: "src/kernel.cpp" } },
		{ op: "create", type: "E", title: "legacy candidate", body: "Original evidence has a candidate source file.", fields: { task: taskId, candidate: "kernel.cpp" } },
		{ op: "create", type: "E", title: "checkpoint artifacts", body: "Original evidence lists frozen artifacts.", fields: { task: taskId,
			artifacts: [`evidence/tasks/${taskId}/review-snapshot/001-kernel.cpp`, `evidence/tasks/${taskId}/review-snapshot/999-unknown.cpp`] } },
		{ op: "create", type: "E", title: "legacy receipt index", body: "Only a numeric receipt and source label were recorded.",
			fields: { task: taskId, readReceipts: [42], readSources: ["002-kernel.src"] } },
		{ op: "create", type: "E", title: "two accepted tasks and excluded declarations", body: "Multi-task evidence is selected per task.",
			fields: { tasks: [taskId, "T003", "T002", "T004"], readReceipts: [42] } },
		{ op: "create", type: "E", title: "registered binary checkpoint path", body: "A registered path still has to be text.",
			fields: { task: taskId, artifacts: [`evidence/tasks/${taskId}/review-snapshot/003-binary.dat`] } },
		{ op: "create", type: "E", title: "legacy source with binary media metadata", body: "The frozen source bytes decide readability.",
			fields: { task: taskId, candidate: "kernel.src" } },
	] });
	assert.equal(proposal.structurallyValid, true);
	await store.merge(proposal.proposalId);
	const m04Dir = path.join(root, "stages", "M04", m04Id), m07Dir = path.join(root, "stages", "M07", m07Id);
	const taskDir = path.join(m07Dir, "tasks", taskId), workDir = path.join(taskDir, "work"), reviewPath = path.join(taskDir, "review-snapshot", "001-kernel.cpp");
	const sourceReviewPath = path.join(taskDir, "review-snapshot", "002-kernel.src");
	const checkpointRoot = path.join(m07Dir, "checkpoints", checkpointId);
	const frozen = path.join(checkpointRoot, "evidence", "tasks", taskId, "review-snapshot", "001-kernel.cpp");
	const sourceRelative = `evidence/tasks/${taskId}/review-snapshot/002-kernel.src`;
	const frozenSource = path.join(checkpointRoot, sourceRelative);
	const binaryRelative = `evidence/tasks/${taskId}/review-snapshot/003-binary.dat`;
	const frozenBinary = path.join(checkpointRoot, binaryRelative);
	const otherRelative = "evidence/tasks/T002/review-snapshot/001-other.txt";
	const frozenOther = path.join(checkpointRoot, otherRelative);
	const secondRelative = "evidence/tasks/T003/review-snapshot/001-second.txt";
	const frozenSecond = path.join(checkpointRoot, secondRelative);
	const rejectedRelative = "evidence/tasks/T004/review-snapshot/001-rejected.txt";
	const frozenRejected = path.join(checkpointRoot, rejectedRelative);
	await mkdir(path.dirname(frozen), { recursive: true });
	await mkdir(path.dirname(frozenOther), { recursive: true });
	await mkdir(path.dirname(frozenSecond), { recursive: true });
	await mkdir(path.dirname(frozenRejected), { recursive: true });
	await mkdir(m04Dir, { recursive: true });
	await writeFile(path.join(m04Dir, "run.json"), JSON.stringify({ runId: m04Id, status: "completed" }));
	await writeFile(path.join(m04Dir, "m07-source.json"), JSON.stringify({ m07RunId: m07Id, checkpointId, selectedTaskIds: [taskId, "T003", "T004"] }));
	await writeFile(path.join(m07Dir, "goal.json"), JSON.stringify({ runId: m07Id, tasks: [{ taskId, workDir,
		review: { artifacts: [{ sourcePath: path.join(workDir, "src", "kernel.cpp"), path: reviewPath, mediaType: "text" },
			{ sourcePath: path.join(workDir, "src", "kernel.src"), path: sourceReviewPath, mediaType: "binary" }] } }] }));
	await writeFile(path.join(checkpointRoot, "goal.json"), JSON.stringify({ runId: m07Id, tasks: [{ taskId, status: "accepted",
		review: { artifacts: [{ path: frozen, mediaType: "text" }, { path: frozenSource, mediaType: "binary" }, { path: frozenBinary, mediaType: "binary" }] } },
		{ taskId: "T002", status: "accepted", review: { artifacts: [{ path: frozenOther, mediaType: "text" }] } },
		{ taskId: "T003", status: "accepted", review: { artifacts: [{ path: frozenSecond, mediaType: "text" }] } },
		{ taskId: "T004", status: "rejected", review: { artifacts: [{ path: frozenRejected, mediaType: "text" }] } }] }));
	await writeFile(path.join(checkpointRoot, "manifest.json"), JSON.stringify({ m07RunId: m07Id, checkpointId, selectedTaskIds: [taskId, "T003", "T004"],
		files: [{ sourceRelativePath: path.relative(root, reviewPath), relativePath: path.relative(checkpointRoot, frozen) },
			{ sourceRelativePath: path.relative(root, sourceReviewPath), relativePath: sourceRelative },
			{ sourceRelativePath: "stages/M07/old/tasks/T001/review-snapshot/003-binary.dat", relativePath: binaryRelative },
			{ sourceRelativePath: "stages/M07/old/tasks/T002/review-snapshot/001-other.txt", relativePath: otherRelative },
			{ sourceRelativePath: "stages/M07/old/tasks/T003/review-snapshot/001-second.txt", relativePath: secondRelative },
			{ sourceRelativePath: "stages/M07/old/tasks/T004/review-snapshot/001-rejected.txt", relativePath: rejectedRelative }] }));
	await writeFile(frozen, "FROZEN-CODE-BYTES\n");
	await writeFile(frozenSource, "FROZEN-SOURCE-BYTES\n");
	await writeFile(frozenBinary, Buffer.from([0, 1, 2]));
	await writeFile(frozenOther, "OTHER-TASK-SECRET\n");
	await writeFile(frozenSecond, "SECOND-ACCEPTED-TASK\n");
	await writeFile(frozenRejected, "REJECTED-TASK-SECRET\n");
	const events: KnowledgeAccessEvent[] = [];
	const tools = Object.fromEntries(createExecutionKnowledgeTools({ store, workspaceRoot: root, expectedSnapshot: (await store.current())!.id,
		requiredIds: [], archiveDir: path.join(root, "access"), onAccess: async event => { events.push(event); } }).map(tool => [tool.name, tool]));
	const result = await tools.knowledge_artifact_read.execute({ ref: "E001", limit: 100 });
	assert.match(result.text, /FROZEN-CODE-BYTES/);
	assert.equal(events.at(-1)?.returnedRange?.content, "artifact");
	assert.match((await tools.knowledge_artifact_read.execute({ ref: "E002", limit: 100 })).text, /FROZEN-CODE-BYTES/);
	assert.match((await tools.knowledge_artifact_read.execute({ ref: "E007", limit: 100 })).text, /FROZEN-SOURCE-BYTES/);
	await assert.rejects(tools.knowledge_artifact_read.execute({ ref: "E003" }), /specify a registered artifact/);
	assert.match((await tools.knowledge_artifact_read.execute({ ref: "E003", artifact: `evidence/tasks/${taskId}/review-snapshot/001-kernel.cpp`, limit: 100 })).text, /FROZEN-CODE-BYTES/);
	const listed = await tools.knowledge_artifact_read.execute({ ref: "E004", list: true, limit: 35 });
	const listingEvent = events.at(-1)!;
	assert.equal(listingEvent.returnedRange?.content, "artifact-index");
	assert.doesNotMatch(listed.text, /FROZEN-(?:CODE|SOURCE)-BYTES|OTHER-TASK-SECRET/);
	const listing = JSON.parse(await readFile(listingEvent.frozenPath, "utf8"));
	assert.match(listing.frozenContent, /002-kernel\.src/);
	assert.doesNotMatch(listing.frozenContent, /003-binary\.dat|T002\/review-snapshot|OTHER-TASK-SECRET/);
	const continued = await tools.knowledge_artifact_read.execute({ ref: "E004", list: true, offset: listingEvent.returnedRange!.end, limit: 1000 });
	assert.match(continued.text, /002-kernel\.src/);
	assert.match((await tools.knowledge_artifact_read.execute({ ref: "E004", artifact: sourceRelative, limit: 100 })).text, /FROZEN-SOURCE-BYTES/);
	await assert.rejects(tools.knowledge_artifact_read.execute({ ref: "E004", artifact: "42" }), /exact listed text file/);
	await assert.rejects(tools.knowledge_artifact_read.execute({ ref: "E004", artifact: binaryRelative }), /exact listed text file/);
	await assert.rejects(tools.knowledge_artifact_read.execute({ ref: "E004", artifact: otherRelative }), /exact listed text file/);
	const multi = await tools.knowledge_artifact_read.execute({ ref: "E005", list: true, limit: 12000 });
	assert.match(multi.text, /T001\/review-snapshot/);
	assert.match(multi.text, /T003\/review-snapshot/);
	assert.match(multi.text, /"taskId":"T002".*not selected/);
	assert.match(multi.text, /"taskId":"T004".*no accepted/);
	assert.doesNotMatch(multi.text, /T002\/review-snapshot|T004\/review-snapshot|SECOND-ACCEPTED-TASK|REJECTED-TASK-SECRET/);
	const second = await tools.knowledge_artifact_read.execute({ ref: "E005", artifact: secondRelative });
	assert.match(second.text, /SECOND-ACCEPTED-TASK/);
	assert.match(second.text, new RegExp(`${m04Id}/${checkpointId}/T003`));
	await assert.rejects(tools.knowledge_artifact_read.execute({ ref: "E005", artifact: otherRelative }), /exact listed text file/);
	await assert.rejects(tools.knowledge_artifact_read.execute({ ref: "E005", artifact: rejectedRelative }), /exact listed text file/);
	await assert.rejects(tools.knowledge_artifact_read.execute({ ref: "E006" }), /exact listed text file/);
	await assert.rejects(tools.knowledge_artifact_read.execute({ ref: "E006", artifact: binaryRelative }), /exact listed text file/);
	await writeFile(path.join(m04Dir, "m07-source.json"), JSON.stringify({ m07RunId: m07Id, checkpointId, selectedTaskIds: [] }));
	await assert.rejects(tools.knowledge_artifact_read.execute({ ref: "E001" }), /does not select this task/);
	await assert.rejects(tools.knowledge_artifact_read.execute({ ref: "E004", list: true }), /does not select this task/);
});

test("episode receives an initial brief and preserves actual knowledge calls through review and checkpoint", async t => {
	const root = await mkdtemp(path.join(tmpdir(), "episode-knowledge-wiring-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const ws = new Workspace(root);
	await mkdir(path.dirname(ws.problemFile), { recursive: true });
	await writeFile(ws.problemFile, "Repair an operator using applicable evidence.");
	const store = createFileKnowledgeStore(ws.knowledgeDir);
	await store.init();
	await apply(store, [{ op: "create", type: "K", title: "repair knowledge", body: `A concrete repair observation: ${"context ".repeat(32)}BODY-ONLY-AFTER-EXPLICIT-READ`,
		fields: { retrieval: { context: { backend: "test-backend", stage: "compile-repair" } } } }]);
	const baseline = await ws.startRun("M04", [{ label: "problem", path: ws.problemFile }]);
	baseline.knowledgeSnapshot = (await store.current())!.id;
	await ws.finishRun(baseline, "completed");
	const runner = new FakeSessionRunner(async ({ message, tools, spec }) => {
		assert.doesNotMatch(message, /BODY-ONLY-AFTER-EXPLICIT-READ/);
		assert.match(message, /A concrete repair observation/);
		assert.match(message, /knowledge_select/);
		assert.ok(tools.candidate_evaluate);
		await tools.knowledge_select({ text: "repair", stage: "compile-repair" });
		const read = await tools.knowledge_read({ ref: "K001" });
		assert.match(read.text, /BODY-ONLY-AFTER-EXPLICIT-READ/);
		assert.match(read.text, /test-backend/);
		assert.equal(spec.tools.kind, "execution");
		if (spec.tools.kind === "execution") await writeFile(path.join(spec.tools.root, "knowledge-review.txt"), read.text);
		return "Read the original conditional repair knowledge; no candidate was evaluated.";
	});
	const ctx: StageContext = { ws, store, runner, config: { roles: { execution: "fake/execution", reviewer: "fake/reviewer", research: "fake/research" }, concurrency: 1, tools: {} } };
	const verifier = { id: "host:test-knowledge", version: "1", async verifyTask() {
		throw new Error("knowledge access must not invoke candidate verification");
	} };
	const controller = createM07Controller(ctx, { candidateVerifier: verifier });
	const goal = await controller.begin({ goal: "repair knowledge", problemRelation: "direct", constraints: ["Preserve the original operator contract"], successCriteria: ["original criterion"], plan: "inspect knowledge" },
		{ candidateVerification: { id: verifier.id, verifierVersion: verifier.version } });
	const task = await controller.delegate(goal.runId, { objective: "read relevant repair knowledge", mode: "execute", subjectProfile: { operatorCategory: "norm-reduce", implementationSpace: "handwritten-low-level", rationale: "test fixture", baselineStrength: "none" }, inputs: [], expectedOutputs: ["knowledge-review.txt"], checks: ["read original knowledge"], knowledgeIds: ["K001"], knowledgeContext: { backend: "test-backend" }, executionLoop: { mode: "candidate-episode" } });
	assert.equal(task.knowledgeAccess?.length, 2);
	const reviewed = await controller.review(goal.runId, { taskId: task.taskId, artifacts: [task.reportPath!], checks: [{ criterion: "read original knowledge", result: "passed", evidence: [task.reportPath!] }] });
	assert.equal(reviewed.status, "accepted");
	for (const access of reviewed.knowledgeAccess!) assert.ok(reviewed.review!.artifacts.some(item => item.path === access.frozenPath));
	const checkpoint = await controller.checkpoint(goal.runId);
	const frozen = JSON.parse(await readFile(checkpoint.goalSnapshotPath, "utf8"));
	const access = frozen.tasks[0].knowledgeAccess[1];
	assert.ok(access.frozenPath.startsWith(checkpoint.rootDir));
	const record = JSON.parse(await readFile(access.frozenPath, "utf8"));
	assert.match(record.returnedText, /BODY-ONLY-AFTER-EXPLICIT-READ/);
	assert.equal(record.frozenPath, undefined, "portable call evidence has no stale self-path");
});

test("a valid large required knowledge group uses a paged episode preview without losing the admission check", async t => {
	const root = await mkdtemp(path.join(tmpdir(), "episode-large-required-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const ws = new Workspace(root);
	await mkdir(path.dirname(ws.problemFile), { recursive: true });
	await writeFile(ws.problemFile, "Inspect required operator knowledge.");
	const store = createFileKnowledgeStore(ws.knowledgeDir);
	await store.init();
	await apply(store, [{ op: "create", type: "K", title: "required operator evidence", body: "Original required evidence." }]);
	await apply(store, Array.from({ length: 160 }, (_, index) => ({ op: "create" as const, type: "J" as const,
		title: `Conditional warning ${index}: ${"specific context ".repeat(8)}`,
		body: `A bounded warning that must remain visible with its premise. ${"Inspect the original evidence. ".repeat(8)}`,
		refs: [{ rel: "limits" as const, target: "K001" }] })));
	const brief = await retrieveKnowledge(store, { purpose: "M07 large group", text: "", requiredIds: ["K001"],
		maxRecords: Number.MAX_SAFE_INTEGER, maxChars: 60_000, view: "brief", excludeExperience: true });
	assert.equal(brief.status, "incomplete");
	assert.ok(brief.omitted.some(item => item.reason === "required-group-over-budget"));
	const baseline = await ws.startRun("M04", [{ label: "problem", path: ws.problemFile }]);
	baseline.knowledgeSnapshot = (await store.current())!.id;
	await ws.finishRun(baseline, "completed");
	const runner = new FakeSessionRunner(async ({ message, tools, spec }) => {
		assert.match(message, /完整必要依赖\/警告组已在宿主只读校验/);
		assert.match(message, /索引 UTF-16 0-\d+\/\d+/);
		assert.ok(tools.knowledge_select && tools.knowledge_read);
		const selected = await tools.knowledge_select({ text: "", format: "index", limit: 12 });
		assert.match(selected.text, /Discovery status .*"status":"ready"/);
		const original = await tools.knowledge_read({ ref: "K001", limit: 6000 });
		assert.match(original.text, /Original required evidence/);
		assert.equal(spec.tools.kind, "execution");
		if (spec.tools.kind === "execution") await writeFile(path.join(spec.tools.root, "knowledge-review.txt"), original.text);
		return "Read a page of the required original; remaining warning bodies need separate inspection.";
	});
	const ctx: StageContext = { ws, store, runner, config: { roles: { execution: "fake/execution", reviewer: "fake/reviewer", research: "fake/research" }, concurrency: 1, tools: {} } };
	const verifier = { id: "host:large-knowledge", version: "1", async verifyTask() { throw new Error("not evaluating a candidate"); } };
	const controller = createM07Controller(ctx, { candidateVerifier: verifier });
	const goal = await controller.begin({ goal: "inspect required knowledge", problemRelation: "direct", constraints: ["preserve original conditions"], successCriteria: ["original criterion"], plan: "inspect" },
		{ candidateVerification: { id: verifier.id, verifierVersion: verifier.version } });
	const task = await controller.delegate(goal.runId, { objective: "read required knowledge", mode: "execute", subjectProfile: { operatorCategory: "norm-reduce", implementationSpace: "handwritten-low-level", rationale: "test fixture", baselineStrength: "none" }, inputs: [], expectedOutputs: ["knowledge-review.txt"],
		checks: ["read original knowledge"], knowledgeIds: ["K001"], executionLoop: { mode: "candidate-episode" } });
	assert.equal(task.status, "returned");
	assert.equal(task.knowledgeAccess?.length, 2);
	const missing = await retrieveKnowledge(store, { purpose: "M07 missing group", text: "", requiredIds: ["K999"],
		maxRecords: Number.MAX_SAFE_INTEGER, maxChars: Number.MAX_SAFE_INTEGER, view: "index", excludeExperience: true });
	assert.equal(missing.status, "incomplete");
	assert.ok(missing.omitted.some(item => item.reason === "required-record-not-published"));
});


test("discovery pages stay compact and traversable while explicit reads retain full live restriction reasons", async t => {
	const f = await setup(t, Array.from({ length: 12 }, (_, index) => ({ op: "create" as const, type: "K" as const,
		title: `indexed method ${index}`, body: `Original stable body ${index}. `.repeat(100), usageDecision: "adopted" as const })));
	const reason = "FULL-LIMIT-REASON: detailed contrary evidence. ".repeat(120);
	const limits = Array.from({ length: 12 }, (_, index) => ({ target: `K${String(index + 1).padStart(3, "0")}`,
		kind: "needs_recheck", reason, authority: "M04", since: "2026-10-18T00:00:00Z" }));
	await writeFile(path.join(f.root, "knowledge", "limits.json"), JSON.stringify(limits));
	const tools = f.makeTools();
	const firstResult = await tools.knowledge_select.execute({ text: "indexed method", format: "index", limit: 3 });
	const first = JSON.parse(await readFile(f.events.at(-1)!.frozenPath, "utf8"));
	assert.ok(firstResult.text.length < 4000, "a discovery page adds only a small status header, not all availability/limits");
	assert.doesNotMatch(firstResult.text, /FULL-LIMIT-REASON/);
	assert.equal(first.safety.selectedCount, 12);
	assert.equal(first.safety.limitKinds.needs_recheck, 12);
	assert.equal(first.safety.availability, undefined);
	assert.equal(first.safety.activeLimits, undefined);
	assert.deepEqual(first.returnedRefs, first.selectedRefs.slice(0, 3));
	assert.deepEqual(first.returnedRange, { offset: 0, end: 3, total: 12, content: "index", unit: "records" });
	assert.equal(first.frozenContent, undefined, "a discovery page does not freeze the entire rendered catalogue");
	assert.equal(first.extra.selection, undefined);
	assert.deepEqual(first.liveLimits, limits);
	const returnedRefs = [...first.returnedRefs];
	let offset = first.returnedRange.end;
	while (offset < first.returnedRange.total) {
		const result = await tools.knowledge_select.execute({ text: "indexed method", format: "index", offset, limit: 3 });
		const frozen = JSON.parse(await readFile(f.events.at(-1)!.frozenPath, "utf8"));
		assert.deepEqual(frozen.selectedRefs, first.selectedRefs);
		assert.deepEqual(frozen.returnedRefs, first.selectedRefs.slice(offset, frozen.returnedRange.end));
		for (const ref of frozen.returnedRefs) assert.ok(result.text.includes(`### ${ref} `));
		returnedRefs.push(...frozen.returnedRefs);
		offset = frozen.returnedRange.end;
	}
	assert.deepEqual(returnedRefs, first.selectedRefs, "every discovered ref remains reachable by record pagination");
	const readResult = await tools.knowledge_read.execute({ ref: "K001", limit: 10 });
	const original = JSON.parse(await readFile(f.events.at(-1)!.frozenPath, "utf8"));
	assert.ok(readResult.text.includes(reason), "explicit record pages retain the complete limit reason");
	assert.equal(original.safety.currentRecord.availability.availability, "needs_recheck");
	assert.equal(original.safety.activeLimits[0].reason, reason);
	assert.equal(original.returnedIndex, undefined);
	assert.doesNotMatch(readResult.text, /### K/);
	await writeFile(path.join(f.root, "knowledge", "limits.json"), JSON.stringify([...limits,
		{ target: "K001", kind: "withdrawn", reason: "NEW-COUNTEREVIDENCE", authority: "M04", since: "2026-10-18T00:01:00Z" }]));
	const nextResult = await tools.knowledge_read.execute({ ref: "K001", offset: 10, limit: 10 });
	const next = JSON.parse(await readFile(f.events.at(-1)!.frozenPath, "utf8"));
	assert.equal(next.frozenContent, original.frozenContent);
	assert.equal(next.returnedRange.offset, 10);
	assert.equal(next.returnedRange.end, 20);
	assert.match(nextResult.text, /NEW-COUNTEREVIDENCE/);
	assert.equal(next.safety.currentRecord.availability.availability, "not_allowed");
});

test("discovery continuation rejects a changed query context or live-limit rendering", async t => {
	const f = await setup(t, [
		{ op: "create", type: "K", title: "staged copy issue one", body: "Original evidence one" },
		{ op: "create", type: "K", title: "staged copy issue two", body: "Original evidence two" },
	]);
	const tools = f.makeTools({ context: { stage: "compile-repair" } });
	const first = await tools.knowledge_select.execute({ text: "staged copy", format: "index", limit: 1 });
	assert.match(first.text, /continue offset=1/);
	await assert.rejects(tools.knowledge_select.execute({ text: "staged copy", format: "index", stage: "performance", offset: 1, limit: 1 }), /restart at offset=0/);
	await writeFile(path.join(f.root, "knowledge", "limits.json"), JSON.stringify([
		{ target: "K001", kind: "withdrawn", reason: "New contrary evidence", authority: "M04", since: "2026-10-18T00:00:00Z" },
	]));
	await assert.rejects(tools.knowledge_select.execute({ text: "staged copy", format: "index", offset: 1, limit: 1 }), /restart at offset=0/);
	const restarted = await tools.knowledge_select.execute({ text: "staged copy", format: "index", offset: 0, limit: 1 });
	assert.match(restarted.text, /K001@1/);
	assert.match(restarted.text, /withdrawn|not_allowed/);
});


test("an incomplete dependency cycle does not block original reading or hide root and related live limits", async t => {
	const f = await setup(t, [{ op: "create", type: "X", title: "First context", body: "Original first context" }]);
	await apply(f.store, [{ op: "create", type: "X", title: "Second context", body: "Original second context", scope: ["X001"] }]);
	await apply(f.store, [{ op: "revise", id: "X001", body: "CYCLIC-ORIGINAL-BODY ".repeat(150), scope: ["X002"], reason: "Record the circular premise for diagnosis" }]);
	const frozenSnapshot = (await f.store.current())!.id;
	const limits = [...await f.store.limits(),
		{ target: "X001", kind: "withdrawn", reason: "ROOT-RESTRICTION-MUST-REMAIN", authority: "M04", since: "2026-10-18T00:00:00Z" },
		{ target: "X002@1", kind: "needs_recheck", reason: "RELATED-RESTRICTION-MUST-REMAIN", authority: "M04", since: "2026-10-18T00:00:00Z" }];
	await writeFile(path.join(f.root, "knowledge", "limits.json"), JSON.stringify(limits));
	const tools = f.makeTools({ expectedSnapshot: frozenSnapshot });
	const firstResult = await tools.knowledge_read.execute({ ref: "X001", limit: 1000 });
	const first = JSON.parse(await readFile(f.events.at(-1)!.frozenPath, "utf8"));
	assert.equal(first.status, "returned");
	assert.equal(first.safety.status, "incomplete");
	assert.match(JSON.stringify(first.safety.omitted), /dependency-cycle/);
	assert.deepEqual(first.extra.selection.rankedRefs, [], "the incomplete retrieval was not promoted to a ready selection");
	assert.deepEqual(first.selectedRefs, ["X001@2"], "the actual original read remains identified");
	assert.match(firstResult.text, /CYCLIC-ORIGINAL-BODY/);
	assert.match(firstResult.text, /read-only diagnosis, not permission to apply/);
	assert.match(firstResult.text, /ROOT-RESTRICTION-MUST-REMAIN/);
	assert.match(firstResult.text, /RELATED-RESTRICTION-MUST-REMAIN/);
	assert.equal(first.safety.currentRecord.availability.availability, "not_allowed");
	const nextResult = await tools.knowledge_read.execute({ ref: "X001@2", offset: 1000, limit: 1000 });
	const next = JSON.parse(await readFile(f.events.at(-1)!.frozenPath, "utf8"));
	assert.equal(next.frozenContent, first.frozenContent);
	assert.deepEqual([next.returnedRange.offset, next.returnedRange.end], [1000, 2000]);
	assert.ok(nextResult.text.endsWith(first.frozenContent.slice(1000, 2000)));
	assert.match(nextResult.text, /dependency-cycle/);
	assert.match(nextResult.text, /ROOT-RESTRICTION-MUST-REMAIN/);
	assert.match(nextResult.text, /RELATED-RESTRICTION-MUST-REMAIN/);
	assert.deepEqual(await f.store.limits(), limits);
	assert.equal((await f.store.current())!.id, frozenSnapshot);
});

test("the contract check rejects an unknown API and an over-budget tile before any compile", async t => {
	const contract = {
		version: 1, kind: "contract", operatorCategory: "normalization", canonicalFamily: "layernorm",
		bottleneck: "compile_failure", applicability: { backend: "backend-a", toolchain: "toolchain-1.2" },
		provenance: { kind: "external-source", detail: "S007 头文件" },
		api: "BackendA::Add", signature: "void Add(Tensor&, const Tensor&, int32_t)",
		constraints: [{ name: "buffer_bytes", unit: "bytes", limit: 196352, comparison: "at_most", source: "S007" }],
		source: "S007",
	};
	const foreign = { ...contract, applicability: { backend: "cuda", toolchain: "12.4" }, api: "cuda::Mul",
		signature: "void Mul(float*, const float*, int)", constraints: [] };
	const f = await setup(t, [
		{ op: "create", type: "K", title: "Add 契约", body: "签名来自本地头文件副本", usageDecision: "adopted", fields: { optimization: contract } },
		{ op: "create", type: "K", title: "别的后端契约", body: "不适用于本任务", usageDecision: "adopted", fields: { optimization: foreign } },
	]);
	const work = path.join(f.root, "work");
	await mkdir(work, { recursive: true });
	await writeFile(path.join(work, "kernel.cpp"), "BackendA::Add(dst, src, n);\nBackendA::Scale(dst, src);\n");
	const tools = f.makeTools({ candidateRoot: work, context: { backend: "backend-a", toolchain: "toolchain-1.2" } });
	const rejected = await tools.knowledge_contract_check.execute({ path: "kernel.cpp",
		observationsJson: JSON.stringify([{ name: "buffer_bytes", value: 262144 }]) });
	assert.match(rejected.text, /结论：reject/);
	assert.match(rejected.text, /BackendA::Scale/);
	assert.match(rejected.text, /最接近的合法签名 void Add/);
	assert.match(rejected.text, /buffer_bytes=262144bytes/);
	// The other backend's contract card is never used to judge this candidate.
	assert.doesNotMatch(rejected.text, /cuda::Mul/);
	const event = f.events.at(-1)!;
	assert.equal(event.kind, "check");
	assert.equal(event.status, "returned");
	assert.equal(event.returnedRange?.content, "contract-check");
	assert.deepEqual(event.selectedRefs, ["K001@1"]);
	const frozen = JSON.parse(await readFile(event.frozenPath, "utf8")) as { safety: { status: string; findings: number } };
	assert.equal(frozen.safety.status, "reject");
	assert.equal(frozen.safety.findings, 2);

	const passing = await tools.knowledge_contract_check.execute({ source: "BackendA::Add(a, b, c);",
		observationsJson: JSON.stringify([{ name: "buffer_bytes", value: 1024 }]) });
	assert.match(passing.text, /结论：pass/);
	await assert.rejects(tools.knowledge_contract_check.execute({ path: "../escape.cpp" }), /work directory/);
	await assert.rejects(tools.knowledge_contract_check.execute({}), /exactly one/);
});
