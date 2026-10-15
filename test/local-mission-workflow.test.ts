import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createFileKnowledgeStore } from "../src/knowledge/store.ts";
import { registerTrustedLocalMissionEvaluator } from "../src/m07/local-mission-evaluator.ts";
import { openDefaultLocalMission } from "../src/m07/local-mission.ts";
import { readLocalDispatchLineage } from "../src/m07/local-dispatch-lineage.ts";
import { publicLocalMissionStatus } from "../src/m07/local-original-objective.ts";
import { FakeSessionRunner } from "../src/runner/fake.ts";
import type { ReadReturnEvent } from "../src/runner/types.ts";
import { runInit } from "../src/stages/init.ts";
import { HarnessError } from "../src/types.ts";
import { Workspace } from "../src/workspace.ts";

function lines(bytes: Buffer): number {
	const text = bytes.toString("utf8");
	return text.split("\n").length - Number(text.endsWith("\n"));
}

test("local mission freezes authored inputs, reviews a bounded reason result, and reopens without replay", async t => {
	registerTrustedLocalMissionEvaluator({ id: "test:unselected-open-report", version: "1",
		supportedObligationTypes: ["synthetic-open"],
		async preflight() { return { available: true }; },
		async evaluate({ contract, observationOutputDir }) {
			const name = "observation-unverified.json";
			await writeFile(path.join(observationOutputDir, name), "{\"verified\":false}\n", { mode: 0o600 });
			return { checks: contract.obligations.map(item => ({ obligationId: item.id,
				result: "not_run" as const, evidenceRefs: [name], limitations: ["Unverified report"] })),
				observations: [{ name, kind: "json" }], limitations: ["Synthetic report only"] };
		} });
	const root = await mkdtemp(path.join(os.tmpdir(), "local-mission-workflow-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const canonicalRoot = await realpath(root);
	const missionRoot = canonicalRoot.startsWith(`/private/var${path.sep}`) ?
		canonicalRoot.slice("/private".length) : root;
	const ws = new Workspace(root);
	await mkdir(ws.rawDir, { recursive: true });
	const problemBytes = Buffer.from("Synthetic original question remains open.\n", "utf8");
	const rawBytes = Buffer.from("Original supplied observation, not a selected answer.\n", "utf8");
	await writeFile(ws.problemFile, problemBytes);
	await writeFile(path.join(ws.rawDir, "observation.txt"), rawBytes);
	await runInit(ws, createFileKnowledgeStore(ws.knowledgeDir));
	const goal = "Find a supported answer to the synthetic original question";
	const obligation = "Show evidence that answers the complete original question";
	const claim = "The complete original answer remains unverified";
	const issue = { id: "original-gap", claim, status: "open", classification: "explicit-requirement",
		sourceRefs: [{ sourceId: "original-problem.txt", startLine: 1, endLine: 1 }],
		implication: "A bounded reason task could identify missing evidence" };
	let missionId = "";
	let originalContractBytes = Buffer.alloc(0);
	let assessorCalls = 0, m07Calls = 0, m04Calls = 0;
	let m04ReadRoot = "";
	const observedReadBytes: Array<Map<string, Buffer>> = [];
	const runner = new FakeSessionRunner(async ({ spec, message }) => {
		if (spec.label.startsWith("local-original-objective-")) {
			assessorCalls++;
			if (assessorCalls > 4)
				throw new DOMException("Synthetic stop after a repeated blocked verdict", "AbortError");
			assert.equal(spec.role, "research");
			assert.equal(spec.tools.kind, "read-dir");
			if (spec.tools.kind !== "read-dir") throw new Error("assessor lacks frozen read grant");
			const files = new Map<string, Buffer>();
			for (const name of await readdir(spec.tools.root)) {
				const file = path.join(spec.tools.root, name);
				if ((await stat(file)).isFile()) files.set(name, await readFile(file));
			}
			observedReadBytes.push(files);
			assert(files.get("original-objective.json")?.equals(originalContractBytes));
			assert(files.get("original-problem.txt")?.equals(problemBytes));
			assert(files.get("original-input-1.txt")?.equals(rawBytes));
			const readReturns: ReadReturnEvent[] = [...files].map(([name, bytes]) => ({
				toolName: "objective_evidence_read", status: "returned", path: name, requested: {},
				returned: { kind: "text", startLine: 1, endLine: lines(bytes), truncated: false },
				at: new Date().toISOString() }));
			if (assessorCalls === 1) return { text: JSON.stringify({ version: 1,
				decision: "continue", rationale: "The original criterion is still open.",
				evidenceRefs: ["original-problem.txt"], unresolvedObligations: ["answer"],
				unresolvedDetails: [claim], groundedAssessment: {
					version: 1, kind: "grounded-assessment-proposal", contractId: missionId,
					missionStatus: "open", issues: [issue], legacyOpenDetails: [],
					nextTask: { objective: "Inspect the original question and its missing evidence",
						obligationIds: ["answer"], addresses: [issue.id], adapterScope: "local-m07-reason",
						decisionChangingHypothesis: "Reasoning can identify whether the supplied material settles the question",
						expectedEvidence: "A reviewed report on the unresolved original criterion",
						sourceRefs: issue.sourceRefs } } }), readReturns };
			assert(files.has("prior-run-1-feedback-1.txt"), "second assessor must receive frozen bounded feedback");
			return { text: JSON.stringify({ version: 1, decision: "blocked",
				rationale: "The reviewed bounded report remains unselected and does not settle the original criterion.",
				evidenceRefs: ["prior-run-1-feedback-1.txt"], unresolvedObligations: ["answer"],
				unresolvedDetails: [claim], groundedAssessment: {
					version: 1, kind: "grounded-assessment-proposal", contractId: missionId,
					missionStatus: "open", issues: [issue], legacyOpenDetails: [claim] } }), readReturns };
		}
		if (spec.label.startsWith("M07-")) {
			m07Calls++;
			assert.notEqual(spec.tools.kind, "execution");
			return "Synthetic bounded reasoning found a negative, unselected result.";
		}
		if (spec.label === "M04-research") {
			m04Calls++;
			assert.equal(spec.tools.kind, "read-dir");
			if (spec.tools.kind !== "read-dir") throw new Error("M04 read grant missing");
			const readRoot = spec.tools.root;
			m04ReadRoot = readRoot;
			const readReturns: ReadReturnEvent[] = [];
			async function visit(folder: string): Promise<void> {
				for (const name of await readdir(folder)) {
					const file = path.join(folder, name);
					if ((await stat(file)).isDirectory()) { await visit(file); continue; }
					const bytes = await readFile(file);
					if (bytes.length) readReturns.push({ toolName: "m07_evidence_read", status: "returned",
						path: path.relative(readRoot, file).replaceAll("\\", "/"), requested: {},
						returned: { kind: "text", startLine: 1, endLine: lines(bytes), truncated: false },
						at: new Date().toISOString() });
				}
			}
			await visit(readRoot);
			return { text: "The negative bounded report is unselected; no original criterion was verified.",
				readReturns };
		}
		throw new Error(`unexpected model-free session ${spec.label}`);
	});
	const config = { roles: { research: "fake/research", execution: "fake/execution" },
		localMission: { evaluatorId: "test:unselected-open-report" },
		concurrency: 1, tools: {} };
	const mission = openDefaultLocalMission({ workspaceRoot: missionRoot, runner, config });
	const initial = await mission.begin({ version: 1, kind: "local-original-objective-request",
		goal, goalSource: "verbatim-private-input", obligations: [{ id: "answer", description: obligation,
			type: "synthetic-open" }],
		closure: "open-ended" });
	missionId = initial.contract.id;
	originalContractBytes = await readFile(path.join(ws.agentDir, "missions", missionId,
		"evidence", "original-objective.json"));
	assert.deepEqual(initial.contract.inputNames, ["problem.md", "observation.txt"]);
	assert.deepEqual(initial.contract.obligations, [{ id: "answer", description: obligation,
		type: "synthetic-open" }]);
	assert.equal(initial.contract.goal, goal);
	const final = await mission.run(missionId);
	assert(assessorCalls >= 2, JSON.stringify({ stopReason: final.stopReason,
		assessmentHistory: final.assessmentHistory.length, boundedRuns: final.boundedRuns.length,
		pending: final.continuation.pendingAction?.kind }));
	assert.equal(m07Calls, 1);
	assert.equal(m04Calls, 1);
	assert.equal(final.assessmentHistory.length, 2);
	assert.equal(final.assessmentHistory[0]?.assessment?.decision, "continue");
	assert.equal(final.assessmentHistory[1]?.assessment?.decision, "blocked");
	assert.equal(final.stopReason, "cancelled",
		"only the fixture's explicit abort can end an actionable original criterion");
	assert.equal(final.objectiveOutcome, "incomplete");
	assert.deepEqual(final.selectedArtifacts, []);
	assert.deepEqual(final.continuation.unresolvedObligations, ["answer"]);
	assert.equal(final.boundedRuns.length, 1);
	assert.deepEqual(final.boundedRuns[0]!.acceptedTaskIds, []);
	assert.equal((await ws.listRuns("M07")).length, 1);
	assert.equal((await ws.listRuns("M04")).length, 1);
	const m07Dir = ws.runDir("M07", final.boundedRuns[0]!.runId);
	const linkedRaw = JSON.parse(await readFile(path.join(m07Dir, "mission-dispatch-link.json"), "utf8")) as
		{ intentId: string; taskId: string; m07RunId: string };
	const linked = await readLocalDispatchLineage({ missionRoot: path.join(ws.agentDir, "missions", missionId),
		m07Dir, intentId: linkedRaw.intentId });
	assert.equal(linked.lineage.m07RunId, final.boundedRuns[0]!.runId);
	assert.equal(linked.lineage.taskId, "T001");
	assert.equal(linked.lineage.intentId, linkedRaw.intentId);
	const goalRecord = JSON.parse(await readFile(path.join(ws.runDir("M07", final.boundedRuns[0]!.runId),
		"goal.json"), "utf8")) as { tasks: Array<{ mode: string; status: string;
		checks: string[]; review?: { checks: Array<{ result: string }> } }>;
		checkpoints: Array<{ feedbackPath: string; rootDir: string }> };
	assert.equal(goalRecord.tasks[0]!.mode, "reason");
	assert.equal(goalRecord.tasks[0]!.status, "rejected");
	assert.deepEqual(goalRecord.tasks[0]!.checks, [obligation]);
	assert.deepEqual(goalRecord.tasks[0]!.review?.checks.map(check => check.result), ["not_run"]);
	assert.equal(m04ReadRoot, goalRecord.checkpoints.at(-1)!.rootDir);
	const feedbackBytes = await readFile(goalRecord.checkpoints.at(-1)!.feedbackPath);
	assert(feedbackBytes.equals(observedReadBytes[1]!.get("prior-run-1-feedback-1.txt")!));
	assert.equal(runner.resumed.length, 0, "M04 and both assessors used fresh sessions");
	const reopened = openDefaultLocalMission({ workspaceRoot: missionRoot });
	assert.deepEqual(await reopened.status(missionId), final);
	assert.equal(path.isAbsolute(m04ReadRoot), true);
	assert.equal(m04ReadRoot.startsWith(`${canonicalRoot}${path.sep}`), true);
	assert.deepEqual(await openDefaultLocalMission({ workspaceRoot: canonicalRoot }).status(missionId), final);
	assert.equal((await ws.listRuns("M07")).length, 1, "status never replays a bounded task");
	const publicStatus = JSON.stringify(publicLocalMissionStatus(final));
	assert(!publicStatus.includes(goal));
	assert(!publicStatus.includes(obligation));
	assert(!publicStatus.includes(claim));
	assert(!publicStatus.includes(problemBytes.toString("utf8").trim()));
	assert(!publicStatus.includes("negative, unselected"));
});

const failureKind = "runner-length" as const;
test("live failed no-proposal M04 runner-length becomes frozen feedback and dispatches distinct work", async t => {
	const evaluatorId = `test:live-failed-m04-${failureKind}`;
	registerTrustedLocalMissionEvaluator({ id: evaluatorId, version: "1",
		supportedObligationTypes: ["synthetic-open"],
		async preflight() { return { available: true }; },
		async evaluate({ contract, observationOutputDir }) {
			const name = "observation-result.txt";
			await writeFile(path.join(observationOutputDir, name), "No original closure was proved.\n",
				{ mode: 0o600 });
			return { checks: contract.obligations.map(item => ({ obligationId: item.id,
				result: "not_run" as const, evidenceRefs: [name], limitations: ["Unselected"] })),
				observations: [{ name, kind: "text" }], limitations: ["Unselected"] };
		} });
	const root = await mkdtemp(path.join(os.tmpdir(), "local-live-failed-m04-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const ws = new Workspace(root);
	await mkdir(path.dirname(ws.problemFile), { recursive: true });
	await writeFile(ws.problemFile, "Synthetic original problem stays open.\n");
	await runInit(ws, createFileKnowledgeStore(ws.knowledgeDir));
	let missionId = "", assessorCalls = 0, builderCalls = 0, m04Calls = 0;
	let failureEvidence = "";
	const events = async (folder: string, toolName: string): Promise<ReadReturnEvent[]> => {
		const returned: ReadReturnEvent[] = [];
		async function visit(dir: string): Promise<void> {
			for (const name of await readdir(dir)) {
				const file = path.join(dir, name);
				if ((await stat(file)).isDirectory()) { await visit(file); continue; }
				const bytes = await readFile(file);
				if (bytes.length) returned.push({ toolName, status: "returned",
					path: path.relative(folder, file).replaceAll("\\", "/"), requested: {},
					returned: { kind: "text", startLine: 1, endLine: lines(bytes), truncated: false },
					at: new Date().toISOString() });
			}
		}
		await visit(folder);
		return returned;
	};
	const sourceRefs = [{ sourceId: "original-problem.txt", startLine: 1, endLine: 1 }];
	const issue = { id: "open-question", claim: "The original problem is unresolved", status: "open",
		classification: "explicit-requirement", sourceRefs,
		implication: "Another bounded investigation can supply different evidence" };
	const runner = new FakeSessionRunner(async ({ spec }) => {
		if (spec.label.startsWith("local-original-objective-")) {
			assessorCalls++;
			if (assessorCalls > 6)
				throw new DOMException("Synthetic stop after repeated blocked verdicts", "AbortError");
			assert.equal(spec.tools.kind, "read-dir");
			if (spec.tools.kind !== "read-dir") throw new Error("assessor read boundary missing");
			const files = await readdir(spec.tools.root);
			if (assessorCalls === 2) {
				const name = files.find(item => item === "prior-run-1-m04-failure-1.txt");
				assert(name, "failed M04 must be frozen for the next assessor");
				failureEvidence = await readFile(path.join(spec.tools.root, name), "utf8");
				assert.match(failureEvidence, failureKind === "runner-length" ?
					/stopReason=length/ : /line offset beyond end of file/);
				assert.match(failureEvidence, /"transactionState": "no-proposal"/);
			}
			const iteration = Number(spec.label.match(/-(\d+)$/)?.[1]);
			const decision = iteration <= 2 ? "continue" : "blocked";
			return { text: JSON.stringify({ version: 1, decision,
				rationale: "The original criterion remains open; use a different bounded task after failure.",
				evidenceRefs: iteration === 1 ? ["original-problem.txt"] :
					[iteration === 2 ? "prior-run-1-m04-failure-1.txt" : "prior-run-2-feedback-1.txt"],
				unresolvedObligations: ["answer"], unresolvedDetails: [issue.claim],
				groundedAssessment: { version: 1, kind: "grounded-assessment-proposal",
					contractId: missionId, missionStatus: "open", issues: [issue],
					legacyOpenDetails: iteration === 1 ? [] : [issue.claim],
					...(decision === "continue" ? { nextTask: {
						objective: iteration === 1 ? "Investigate avenue one" : "Investigate avenue two",
						obligationIds: ["answer"], addresses: [issue.id], adapterScope: "local-m07-reason",
						decisionChangingHypothesis: iteration === 1 ? "Avenue one might resolve it" :
							"Avenue two might resolve it after the failed read",
						expectedEvidence: "A reviewed bounded report", sourceRefs } } : {}) } }),
				readReturns: await events(spec.tools.root, "objective_evidence_read") };
		}
		if (spec.label.startsWith("M07-")) { builderCalls++; return `Builder result ${builderCalls}`; }
		if (spec.label === "M04-research") {
			m04Calls++;
			if (m04Calls === 1) throw failureKind === "runner-length" ?
				new HarnessError("runner.stop", "session M04-research did not stop normally (stopReason=length)") :
				new Error("line offset beyond end of file; provider prose said cancelled");
			assert.equal(spec.tools.kind, "read-dir");
			if (spec.tools.kind !== "read-dir") throw new Error("M04 read boundary missing");
			return { text: "Second bounded result was considered; no proposal.",
				readReturns: await events(spec.tools.root, "m07_evidence_read") };
		}
		throw new Error(`unexpected session ${spec.label}`);
	});
	const mission = openDefaultLocalMission({ workspaceRoot: root, runner,
		config: { roles: { research: "fake/research", execution: "fake/execution" },
			localMission: { evaluatorId }, concurrency: 1, tools: {} } });
	const started = await mission.begin({ version: 1, kind: "local-original-objective-request",
		goal: "Answer the original problem", goalSource: "verbatim-private-input",
		obligations: [{ id: "answer", description: "Resolve original question", type: "synthetic-open" }],
		closure: "open-ended" });
	missionId = started.contract.id;
	const result = await mission.run(missionId);
	assert(assessorCalls >= 3);
	assert.equal(builderCalls, 2);
	assert.equal(m04Calls, 2);
	assert.equal(result.boundedRuns.length, 2);
	assert.notEqual(result.boundedRuns[0]!.runId, result.boundedRuns[1]!.runId);
	assert(result.boundedRuns[0]!.failedM04RunId);
	assert.equal((await ws.readRun("M04", result.boundedRuns[0]!.failedM04RunId!)).status, "failed");
	assert.equal(result.boundedRuns[0]!.outcome, "partial");
	assert.equal(result.continuation.unresolvedOperationIds.length, 0);
	assert.deepEqual(result.selectedArtifacts, []);
	assert.match(failureEvidence, /"selected": false/);
	assert.equal((await ws.listRuns("MISSION")).length, 3);
	assert.deepEqual(await openDefaultLocalMission({ workspaceRoot: root }).status(missionId), result);
});
