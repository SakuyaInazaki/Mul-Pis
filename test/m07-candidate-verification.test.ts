import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createFileKnowledgeStore } from "../src/knowledge/store.ts";
import { createM07Controller } from "../src/m07/controller.ts";
import { writeFeedback } from "../src/m07/feedback.ts";
import { DEFAULT_PROJECTION_SNAPSHOT_LIMITS } from "../src/improvement/observations.ts";
import type { CandidateVerifier } from "../src/m07/candidate-evaluation.ts";
import { FakeSessionRunner } from "../src/runner/fake.ts";
import type { StageContext } from "../src/stages/context.ts";
import { Workspace } from "../src/workspace.ts";

test("host candidate findings override self-report while full goal verification remains independent", async t => {
	const root = await mkdtemp(path.join(tmpdir(), "m07-candidate-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const ws = new Workspace(root);
	await mkdir(path.dirname(ws.problemFile), { recursive: true });
	await writeFile(ws.problemFile, "Optimize the original operator task.\n");
	const store = createFileKnowledgeStore(ws.knowledgeDir); await store.init();
	const baseline = await ws.startRun("M04", [{ label: "problem", path: ws.problemFile }]);
	await ws.finishRun(baseline, "completed");
	let candidateNumber = 0;
	const runner = new FakeSessionRunner(async ({ spec }) => {
		if (spec.tools.kind === "execution") {
			candidateNumber++;
			await writeFile(path.join(spec.tools.root, "kernel.py"), `candidate ${candidateNumber}\n`);
			await writeFile(path.join(spec.tools.root, "receipt.json"), JSON.stringify({ candidateNumber, result: candidateNumber === 1 ? "incorrect" : "correct" }));
			await writeFile(path.join(spec.tools.root, "lesson.json"), JSON.stringify({ version: 1, action: "propose", observation: `candidate ${candidateNumber} observed`, applicability: "this task", evidencePaths: ["receipt.json"] }));
		}
		return "The candidate is successful.";
	});
	let goalVerdict: "failed" | "passed" = "failed";
	let checkedSource = "";
	const verifier: CandidateVerifier = {
		id: "host:test-candidate", version: "1",
		async verifyTask({ task, sources, receipts }) {
			assert.equal(sources.length, 1); assert.equal(receipts.length, 1);
			checkedSource = await readFile(sources[0].frozenPath, "utf8");
			const raw = JSON.parse(await readFile(receipts[0].frozenPath, "utf8")) as { result: string };
			assert.equal(task.candidate?.sourcePaths[0], "kernel.py");
			return { sourceBinding: "verified", correctness: raw.result === "correct" ? "passed" : "failed",
				stage: raw.result === "correct" ? "performance" : "numerical",
				checks: raw.result === "correct" ? [{ criterion: "candidate checked", result: "passed" as const }] : [],
				metrics: raw.result === "correct" ? [{ name: "score", value: 0.8, unit: "score", basisId: "same-task-and-platform", direction: "higher" }] : [],
				limitations: [] };
		},
		async verifyGoal({ goal, acceptedEvidencePaths }) {
			assert.equal(goal.successCriteria.length, 2);
			const evidence = acceptedEvidencePaths.find(item => item.endsWith("candidate-observation.json"));
			assert.ok(evidence);
			return { checks: goal.successCriteria.map(criterion => ({ criterion,
				result: criterion === "reach original target" ? goalVerdict : "passed", evidence: [evidence] })), limitations: [] };
		},
	};
	const ctx: StageContext = { ws, store, runner, config: { roles: { execution: "fake/execution", reviewer: "fake/reviewer", research: "fake/research" }, concurrency: 1, tools: {} } };
	const controller = createM07Controller(ctx, { candidateVerifier: verifier });
	const goal = await controller.begin({ goal: "Original operator target", problemRelation: "direct", constraints: ["same task"], successCriteria: ["correctness", "reach original target"], plan: "explore" }, { candidateVerification: { id: verifier.id, verifierVersion: verifier.version, goalAdmission: true } });
	const spec = (parentTaskId?: string, intent: "solution" | "diagnostic" = "solution") => ({ objective: "evaluate one candidate", subjectId: "original-operator", mode: "execute" as const, inputs: [], expectedOutputs: ["kernel.py", "receipt.json", "lesson.json"], lessonDeltaOutput: "lesson.json", checks: [intent === "diagnostic" ? "failure recorded" : "candidate checked"], candidate: { sourcePaths: ["kernel.py"], receiptPaths: ["receipt.json"], intent, ...(parentTaskId ? { parentTaskId, changeKind: "structure" as const } : {}) } });
	const first = await controller.delegate(goal.runId, spec(undefined, "diagnostic"));
	const negative = await controller.review(goal.runId, { taskId: first.taskId, artifacts: [], checks: [{ criterion: "failure recorded", result: "passed", evidence: [first.reportPath!] }] });
	assert.equal(negative.status, "accepted", "a verified negative can complete a diagnostic task");
	assert.equal(negative.candidateObservation?.correctness, "failed");
	assert.equal(negative.review?.checks[0].result, "passed");
	assert.ok(negative.review?.artifacts.some(item => item.sourcePath?.endsWith("lesson.json")), "lesson delta itself reaches frozen evidence");
	const second = await controller.delegate(goal.runId, spec(first.taskId));
	const accepted = await controller.review(goal.runId, { taskId: second.taskId, artifacts: [], checks: [{ criterion: "candidate checked", result: "passed", evidence: [second.reportPath!] }] });
	assert.equal(accepted.status, "accepted");
	assert.equal(checkedSource, "candidate 2\n");
	assert.equal(accepted.candidateObservation?.metrics[0].basisId, "same-task-and-platform");
	const claimed = { outcome: "fulfilled" as const, summary: "model claims success", returnPath: "M04" as const,
		goalChecks: goal.successCriteria.map(criterion => ({ criterion, result: "passed" as const, evidence: [accepted.reportPath!] })) };
	await assert.rejects(controller.finish(goal.runId, claimed), /fulfilled/);
	goalVerdict = "passed";
	const finished = await controller.finish(goal.runId, claimed);
	assert.equal(finished.outcome, "fulfilled");
	assert.equal(finished.goalChecks?.every(check => check.result === "passed"), true);
	const feedback = await readFile(finished.feedbackPath!, "utf8");
	assert.match(feedback, /当前探索工作点/);
	assert.match(feedback, /同口径正确性已验证的最佳观测/);
	const projected = structuredClone(finished);
	const accessPath = path.join(root, "synthetic-knowledge-access.json");
	projected.tasks[0].knowledgeAccess = [
		{ id: "K0001", kind: "select", at: "2026-10-18T00:00:00Z", snapshot: "G001", status: "returned",
			selectedRefs: Array.from({ length: 84 }, (_, index) => `E${String(index + 1).padStart(3, "0")}@1`),
			frozenPath: accessPath, returnedRange: { offset: 0, end: 6000, total: 83395, content: "brief" } },
		{ id: "K0002", kind: "read", at: "2026-10-18T00:00:01Z", snapshot: "G001", status: "returned",
			selectedRefs: ["E001@1"], frozenPath: accessPath,
			returnedRange: { offset: 0, end: 3861, total: 3861, content: "record" } },
		{ id: "K0003", kind: "artifact", at: "2026-10-18T00:00:02Z", snapshot: "G001", status: "returned",
			selectedRefs: ["E001@1"], frozenPath: accessPath,
			returnedRange: { offset: 0, end: 507, total: 507, content: "artifact-index" } },
		{ id: "K0004", kind: "artifact", at: "2026-10-18T00:00:03Z", snapshot: "G001", status: "returned",
			selectedRefs: ["E001@1"], frozenPath: accessPath,
			returnedRange: { offset: 0, end: 8000, total: 8999, content: "artifact" } },
		{ id: "K0005", kind: "read", at: "2026-10-18T00:00:04Z", snapshot: "G001", status: "failed",
			selectedRefs: [], frozenPath: accessPath },
		{ id: "K0006", kind: "read", at: "2026-10-18T00:00:05Z", snapshot: "G001", status: "returned",
			selectedRefs: ["E001@1"], frozenPath: accessPath },
		{ id: "K0007", kind: "select", at: "2026-10-18T00:00:06Z", snapshot: "G001", status: "returned",
			selectedRefs: Array.from({ length: 84 }, (_, index) => `E${String(index + 1).padStart(3, "0")}@1`),
			returnedRefs: ["E013@1", "E014@1"], frozenPath: accessPath,
			returnedRange: { offset: 12, end: 14, total: 84, content: "index", unit: "records" } },
	];
	const projectedFeedback = await readFile(await writeFeedback(ctx, projected, projected.budgetPolicy!, DEFAULT_PROJECTION_SNAPSHOT_LIMITS), "utf8");
	assert.match(projectedFeedback, /K0001\/select\/returned：检索候选及关联引用 84 条.*实际返回知识短卡（不含完整正文） UTF-16 0–6000\/83395（仅此范围）/);
	assert.doesNotMatch(projectedFeedback, /选择 E001@1.*E084@1/);
	assert.match(projectedFeedback, /K0002\/read\/returned：.*实际返回记录正文 UTF-16 0–3861\/3861（该内容完整返回）/);
	assert.match(projectedFeedback, /K0003\/artifact\/returned：.*实际返回同源任务原件目录（不含原件正文） UTF-16 0–507\/507（该内容完整返回）/);
	assert.match(projectedFeedback, /K0004\/artifact\/returned：.*实际返回同源任务原件 UTF-16 0–8000\/8999（仅此范围）/);
	assert.match(projectedFeedback, /K0005\/read\/failed：.*未返回知识内容/);
	assert.match(projectedFeedback, /K0006\/read\/returned：.*实际返回范围未登记，须核对冻结原始返回/);
	assert.match(projectedFeedback, /K0007\/select\/returned：检索候选及关联引用 84 条.*实际返回检索索引（不含正文） 记录序号 12–14\/84（仅此范围）/);
});

test("partial host goal admission retains failed exploration without hiding unmet original checks", async t => {
	const root = await mkdtemp(path.join(tmpdir(), "m07-goal-admission-history-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const ws = new Workspace(root);
	await mkdir(path.dirname(ws.problemFile), { recursive: true });
	await writeFile(ws.problemFile, "Reach the original operator target.\n");
	const store = createFileKnowledgeStore(ws.knowledgeDir); await store.init();
	const baseline = await ws.startRun("M04", [{ label: "problem", path: ws.problemFile }]);
	await ws.finishRun(baseline, "completed");
	const runner = new FakeSessionRunner(async ({ spec }) => {
		if (spec.tools.kind === "execution") {
			await writeFile(path.join(spec.tools.root, "kernel.txt"), "different successful route\n");
			await writeFile(path.join(spec.tools.root, "receipt.json"), '{"accepted":true}\n');
		}
		return "Task report";
	});
	let goalVerdict: "failed" | "passed" = "failed";
	let knowledgeVerdict: "failed" | "passed" = "passed";
	let citeRejected = false;
	let rejectedEvidence = "";
	const verifier: CandidateVerifier = { id: "host:goal-admission-history", version: "1",
		async verifyTask({ task }) { return { sourceBinding: "verified", correctness: "passed", stage: "performance",
			checks: task.checks.map(criterion => ({ criterion, result: "passed" as const })), metrics: [], limitations: [] }; },
		async verifyGoal({ goal, acceptedEvidencePaths }) {
			assert.equal(goal.successCriteria.length, 2);
			assert.ok(!acceptedEvidencePaths.includes(rejectedEvidence), "a rejected probe is not goal evidence");
			const accepted = acceptedEvidencePaths.find(file => file.endsWith("candidate-observation.json"));
			assert.ok(accepted);
			return { checks: [{ criterion: "reach original score", result: goalVerdict,
				evidence: [citeRejected ? rejectedEvidence : accepted] }], limitations: [] };
		} };
	const ctx: StageContext = { ws, store, runner, config: { roles: { execution: "fake/execution", reviewer: "fake/reviewer", research: "fake/research" }, concurrency: 1, tools: {} } };
	const controller = createM07Controller(ctx, { candidateVerifier: verifier });
	const goal = await controller.begin({ goal: "Original target", problemRelation: "direct", constraints: ["same operator"],
		successCriteria: ["reach original score", "assess scientific evidence"], plan: "explore then verify" },
		{ candidateVerification: { id: verifier.id, verifierVersion: verifier.version, goalAdmission: false }, executionContract: "continuous" });
	const probe = await controller.delegate(goal.runId, { objective: "test an unrelated hypothesis", mode: "reason", inputs: [],
		expectedOutputs: [], checks: ["hypothesis supported"] });
	const rejected = await controller.review(goal.runId, { taskId: probe.taskId, artifacts: [probe.reportPath!],
		checks: [{ criterion: "hypothesis supported", result: "failed", evidence: [probe.reportPath!] }] });
	assert.equal(rejected.status, "rejected");
	assert.equal(rejected.candidateObservation, undefined);
	rejectedEvidence = rejected.review!.frozenReportPath;
	const candidate = await controller.delegate(goal.runId, { objective: "measure a different successful route", mode: "execute",
		inputs: [], expectedOutputs: ["kernel.txt", "receipt.json"], checks: ["candidate checked"],
		candidate: { sourcePaths: ["kernel.txt"], receiptPaths: ["receipt.json"] } });
	const accepted = await controller.review(goal.runId, { taskId: candidate.taskId, artifacts: [],
		checks: [{ criterion: "candidate checked", result: "passed", evidence: [candidate.reportPath!] }] });
	assert.equal(accepted.status, "accepted");
	const claim = { outcome: "fulfilled" as const, summary: "original target reached", returnPath: "M04" as const,
		goalChecks: [{ criterion: "reach original score", result: "passed" as const, evidence: [accepted.reportPath!] },
			{ criterion: "assess scientific evidence", result: knowledgeVerdict, evidence: [accepted.reportPath!] }] };
	await assert.rejects(controller.finish(goal.runId, claim), /fulfilled.*reach original score: failed/);
	goalVerdict = "passed";
	knowledgeVerdict = "failed";
	await assert.rejects(controller.finish(goal.runId, { ...claim,
		goalChecks: claim.goalChecks.map(check => check.criterion === "assess scientific evidence" ?
			{ ...check, result: knowledgeVerdict } : check) }), /fulfilled 要求每项原目标成功标准均通过/);
	knowledgeVerdict = "passed";
	citeRejected = true;
	await assert.rejects(controller.finish(goal.runId, claim), /目标验收证据不来自当前有效且已接受任务/);
	citeRejected = false;
	const finished = await controller.finish(goal.runId, claim);
	assert.equal(finished.outcome, "fulfilled");
	assert.equal(finished.tasks.find(task => task.taskId === probe.taskId)?.status, "rejected");
	assert.equal(finished.tasks.find(task => task.taskId === probe.taskId)?.review?.checks[0]?.result, "failed");
	assert.ok(!finished.goalChecks?.[0]?.evidence.includes(rejectedEvidence));
	const ordinary = await controller.begin({ goal: "Traditional research target", problemRelation: "direct", constraints: ["same operator"],
		successCriteria: ["scientific conclusion supported"], plan: "ordinary review" });
	const oldProbe = await controller.delegate(ordinary.runId, { objective: "separate failed probe", mode: "reason", inputs: [],
		expectedOutputs: [], checks: ["probe passed"] });
	assert.equal((await controller.review(ordinary.runId, { taskId: oldProbe.taskId, artifacts: [oldProbe.reportPath!],
		checks: [{ criterion: "probe passed", result: "failed", evidence: [oldProbe.reportPath!] }] })).status, "rejected");
	const finalStudy = await controller.delegate(ordinary.runId, { objective: "different supported study", mode: "reason",
		inputs: [], expectedOutputs: [], checks: ["study reviewed"] });
	assert.equal((await controller.review(ordinary.runId, { taskId: finalStudy.taskId, artifacts: [finalStudy.reportPath!],
		checks: [{ criterion: "study reviewed", result: "passed", evidence: [finalStudy.reportPath!] }] })).status, "accepted");
	const pending = await controller.delegate(ordinary.runId, { objective: "unreviewed follow-up", mode: "reason",
		inputs: [], expectedOutputs: [], checks: ["follow-up supported"] });
	const ordinaryClaim = { outcome: "fulfilled" as const, summary: "original conclusion supported",
		returnPath: "M04" as const, goalChecks: [{ criterion: "scientific conclusion supported", result: "passed" as const,
			evidence: [finalStudy.reportPath!] }] };
	await assert.rejects(controller.finish(ordinary.runId, ordinaryClaim), /尚未审查的 returned 任务/);
	assert.equal((await controller.review(ordinary.runId, { taskId: pending.taskId, artifacts: [pending.reportPath!],
		checks: [{ criterion: "follow-up supported", result: "failed", evidence: [pending.reportPath!] }] })).status, "rejected");
	const ordinaryFinished = await controller.finish(ordinary.runId, ordinaryClaim);
	assert.equal(ordinaryFinished.outcome, "fulfilled");
	assert.equal(ordinaryFinished.tasks.find(task => task.taskId === oldProbe.taskId)?.status, "rejected");
});

test("host binding on an active ordinary goal applies only to later candidate tasks", async t => {
	const root = await mkdtemp(path.join(tmpdir(), "m07-candidate-bind-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const ws = new Workspace(root);
	await mkdir(path.dirname(ws.problemFile), { recursive: true });
	await writeFile(ws.problemFile, "Original task\n");
	const store = createFileKnowledgeStore(ws.knowledgeDir); await store.init();
	const baseline = await ws.startRun("M04", [{ label: "problem", path: ws.problemFile }]);
	await ws.finishRun(baseline, "completed");
	const runner = new FakeSessionRunner(async ({ spec }) => {
		if (spec.tools.kind === "execution") {
			await writeFile(path.join(spec.tools.root, "source.txt"), "later source");
			await writeFile(path.join(spec.tools.root, "receipt.txt"), "later receipt");
		}
		return "report";
	});
	let assessments = 0;
	const verifier: CandidateVerifier = { id: "host:later-only", version: "1", async verifyTask({ task }) {
		assessments++;
		return { sourceBinding: "verified", correctness: "passed", stage: "measured",
			checks: task.checks.map(criterion => ({ criterion, result: assessments === 1 ? "failed" as const : "passed" as const })), metrics: [], limitations: [] };
	} };
	const ctx: StageContext = { ws, store, runner, config: { roles: { execution: "fake/execution", reviewer: "fake/reviewer", research: "fake/research" }, concurrency: 1, tools: {} } };
	const controller = createM07Controller(ctx, { candidateVerifier: verifier });
	const goal = await controller.begin({ goal: "Keep original goal", problemRelation: "direct", constraints: ["unchanged"], successCriteria: ["original criterion"], plan: "continue" });
	const earlier = await controller.delegate(goal.runId, { objective: "read-only diagnosis", inputs: [], expectedOutputs: [], checks: ["diagnosis captured"], mode: "reason" });
	assert.equal(earlier.status, "returned");
	const bound = await controller.hostBindCandidateVerifier(goal.runId);
	assert.equal(bound.candidateVerification?.firstTaskIndex, 1);
	assert.equal(bound.successCriteria[0], "original criterion");
	const normal = await controller.review(goal.runId, { taskId: earlier.taskId, artifacts: [earlier.reportPath!], checks: [{ criterion: "diagnosis captured", result: "passed", evidence: [earlier.reportPath!] }] });
	assert.equal(normal.status, "accepted");
	assert.equal(normal.candidateObservation, undefined);
	const later = await controller.delegate(goal.runId, { objective: "later measured candidate", mode: "execute", inputs: [], expectedOutputs: ["source.txt", "receipt.txt"], checks: ["candidate checked"], candidate: { sourcePaths: ["source.txt"], receiptPaths: ["receipt.txt"] } });
	const assessed = await controller.review(goal.runId, { taskId: later.taskId, artifacts: [], checks: [{ criterion: "candidate checked", result: "passed", evidence: [later.reportPath!] }] });
	assert.equal(assessed.status, "rejected", "host-known contrary finding defeats a model-passed check");
	assert.equal(assessed.review?.checks[0].result, "failed");
	assert.equal(assessed.candidateObservation?.verifier.id, verifier.id);
	const successor = await controller.delegate(goal.runId, { objective: "later measured candidate", mode: "execute", inputs: [], expectedOutputs: ["source.txt", "receipt.txt"], checks: ["candidate checked"], candidate: { sourcePaths: ["source.txt"], receiptPaths: ["receipt.txt"], parentTaskId: later.taskId, changeKind: "repair" } });
	const accepted = await controller.review(goal.runId, { taskId: successor.taskId, artifacts: [], checks: [{ criterion: "candidate checked", result: "passed", evidence: [successor.reportPath!] }] });
	assert.equal(accepted.status, "accepted");
	const finished = await controller.finish(goal.runId, { outcome: "fulfilled", summary: "original checks complete", returnPath: "M04", goalChecks: [{ criterion: "original criterion", result: "passed", evidence: [accepted.reportPath!] }] });
	assert.equal(finished.outcome, "fulfilled", "receipt-only binding does not require a whole-goal adapter");
});

test("objective host checks override claimed success without taking over scientific criteria", async t => {
	const root = await mkdtemp(path.join(tmpdir(), "m07-objective-admission-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const ws = new Workspace(root);
	await mkdir(path.dirname(ws.problemFile), { recursive: true });
	await writeFile(ws.problemFile, "Original operator task\n");
	const store = createFileKnowledgeStore(ws.knowledgeDir); await store.init();
	const baseline = await ws.startRun("M04", []); await ws.finishRun(baseline, "completed");
	const runner = new FakeSessionRunner(async ({ spec }) => {
		if (spec.tools.kind === "execution") {
			await writeFile(path.join(spec.tools.root, "kernel.txt"), "source");
			await writeFile(path.join(spec.tools.root, "receipt.json"), "{\"score\":8}");
		}
		return "candidate evidence returned";
	});
	let objectiveResult: "failed" | "passed" = "failed";
	let returnNoHostChecks = true;
	const verifier: CandidateVerifier = { id: "host:objective", version: "1",
		async verifyTask() { return { sourceBinding: "verified", correctness: "passed", stage: "performance",
			metrics: [], limitations: [] }; },
		async verifyGoal({ acceptedEvidencePaths }) {
			if (returnNoHostChecks) return { checks: [], limitations: [] };
			return { checks: [{ criterion: "original score threshold", result: objectiveResult,
				evidence: [acceptedEvidencePaths.find(file => file.endsWith("candidate-observation.json"))!] }], limitations: [] };
		} };
	const ctx: StageContext = { ws, store, runner, config: { roles: { execution: "fake/execution", research: "fake/research" }, concurrency: 1, tools: {} } };
	const controller = createM07Controller(ctx, { candidateVerifier: verifier });
	const goal = await controller.begin({ goal: "Original goal", problemRelation: "direct", constraints: ["Preserve the original operator semantics"],
		successCriteria: ["original score threshold", "scientific evidence considered"], plan: "optimize" },
		{ candidateVerification: { id: verifier.id, verifierVersion: verifier.version, goalAdmission: false }, executionContract: "continuous" });
	const task = await controller.delegate(goal.runId, { mode: "execute", objective: "measure", inputs: [],
		expectedOutputs: ["kernel.txt", "receipt.json"], checks: ["measurement retained"],
		candidate: { sourcePaths: ["kernel.txt"], receiptPaths: ["receipt.json"], intent: "diagnostic" } });
	const accepted = await controller.review(goal.runId, { taskId: task.taskId, artifacts: [],
		checks: [{ criterion: "measurement retained", result: "passed", evidence: [task.reportPath!] }] });
	assert.equal(accepted.candidate?.intent, "diagnostic", "an exploration label cannot replace original-goal host admission");
	const claim = { outcome: "fulfilled" as const, summary: "claimed done", returnPath: "M04" as const,
		goalChecks: goal.successCriteria.map(criterion => ({ criterion, result: "passed" as const, evidence: [accepted.reportPath!] })) };
	const receiptOnly = createM07Controller(ctx, { candidateVerifier: { id: verifier.id, version: verifier.version, verifyTask: verifier.verifyTask } });
	await assert.rejects(receiptOnly.finish(goal.runId, claim), /continuous candidate goal fulfillment requires independent host verification/);
	await assert.rejects(controller.finish(goal.runId, claim), /host goal verification omitted or altered original criteria/);
	returnNoHostChecks = false;
	await assert.rejects(controller.finish(goal.runId, claim), /fulfilled.*original score threshold: failed/);
	assert.equal((await controller.status(goal.runId)).lifecycle, "active");
	objectiveResult = "passed";
	const finished = await controller.finish(goal.runId, claim);
	assert.equal(finished.outcome, "fulfilled");
	assert.equal(finished.goalChecks?.find(check => check.criterion === "scientific evidence considered")?.result, "passed");
});
