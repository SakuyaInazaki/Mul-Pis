import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
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
	const runner = new FakeSessionRunner(async ({ spec }) => {
		if (spec.label.startsWith("local-original-objective-")) {
			assessorCalls++;
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
	const mission = openDefaultLocalMission({ workspaceRoot: root, runner, config });
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
	assert.equal(final.stopReason, "workflow-repair-needed",
		"a repeated blocked verdict cannot end an actionable original criterion");
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
	const reopened = openDefaultLocalMission({ workspaceRoot: root });
	assert.deepEqual(await reopened.status(missionId), final);
	assert.equal((await ws.listRuns("M07")).length, 1, "status never replays a bounded task");
	const publicStatus = JSON.stringify(publicLocalMissionStatus(final));
	assert(!publicStatus.includes(goal));
	assert(!publicStatus.includes(obligation));
	assert(!publicStatus.includes(claim));
	assert(!publicStatus.includes(problemBytes.toString("utf8").trim()));
	assert(!publicStatus.includes("negative, unselected"));
});

test("default assessor can pass a bounded task check while the original open-ended obligation remains unresolved", async t => {
	registerTrustedLocalMissionEvaluator({ id: "test:bounded-task-open-goal", version: "1",
		supportedObligationTypes: ["synthetic-open"],
		async preflight() { return { available: true }; },
		async evaluate({ contract, observationOutputDir }) {
			await writeFile(path.join(observationOutputDir, "observation-bounded.txt"),
				"The declared bounded check passed; the broader question remains open.\n", { mode: 0o600 });
			return { observations: [{ name: "observation-bounded.txt", kind: "text" }],
				checks: contract.obligations.map(item => ({ obligationId: item.id,
					result: item.id === "bounded" ? "passed" as const : "unknown" as const,
					evidenceRefs: ["observation-bounded.txt"],
					limitations: ["No result establishes the broader question"] })),
				limitations: ["The broad obligation remains unverified"] };
		} });
	const root = await mkdtemp(path.join(os.tmpdir(), "local-mission-bounded-check-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const ws = new Workspace(root);
	await mkdir(path.dirname(ws.problemFile), { recursive: true });
	await writeFile(ws.problemFile, "Check one bounded fact while a broad question remains open.\n");
	await runInit(ws, createFileKnowledgeStore(ws.knowledgeDir));
	const bounded = "Verify the declared bounded fact against the supplied observation";
	const broad = "Find the strongest answer across the open search space";
	let missionId = "";
	let prompts = 0;
	const readAll = async (directory: string, toolName: string): Promise<ReadReturnEvent[]> => {
		const events: ReadReturnEvent[] = [];
		const visit = async (folder: string): Promise<void> => {
			for (const name of await readdir(folder)) {
				const file = path.join(folder, name);
				if ((await stat(file)).isDirectory()) { await visit(file); continue; }
				const bytes = await readFile(file);
				if (bytes.length) events.push({ toolName, status: "returned",
					path: path.relative(directory, file).replaceAll("\\", "/"), requested: {},
					returned: { kind: "text", startLine: 1, endLine: lines(bytes), truncated: false },
					at: new Date().toISOString() });
			}
		};
		await visit(directory); return events;
	};
	const runner = new FakeSessionRunner(async ({ spec, message }) => {
		if (spec.label.startsWith("local-original-objective-")) {
			prompts++;
			assert(message.includes("each selected original obligation becomes a mandatory check"));
			assert(message.includes("You may choose a strict subset"));
			assert.equal(spec.tools.kind, "read-dir");
			if (spec.tools.kind !== "read-dir") throw new Error("assessor read grant missing");
			const refs = [{ sourceId: "original-problem.txt", startLine: 1, endLine: 1 }];
			const issues = [
				{ id: "bounded-issue", claim: "The bounded fact is not yet verified", status: "open",
					classification: "explicit-requirement", sourceRefs: refs,
					implication: "A local observation can settle this check" },
				{ id: "broad-issue", claim: "The broad search remains open", status: "open",
					classification: "explicit-requirement", sourceRefs: refs,
					implication: "Finite local evidence cannot close the search" },
			];
			return { text: JSON.stringify({ version: 1, decision: "continue",
				rationale: "Test the bounded fact and retain the broader question as open.",
				evidenceRefs: ["original-problem.txt"], unresolvedObligations: ["bounded", "broad"],
				unresolvedDetails: issues.map(item => item.claim), groundedAssessment: { version: 1,
					kind: "grounded-assessment-proposal", contractId: missionId,
					missionStatus: "open", issues, legacyOpenDetails: [],
					nextTask: { objective: "Test only the declared bounded fact",
						obligationIds: ["bounded"], addresses: ["bounded-issue"],
						adapterScope: "local-m07-reason",
						decisionChangingHypothesis: "The local observation can pass the bounded check",
						expectedEvidence: "A host result for the bounded fact", sourceRefs: refs } } }),
				readReturns: await readAll(spec.tools.root, "objective_evidence_read") };
		}
		if (spec.label.startsWith("M07-")) return "A bounded result with a remaining broad gap.";
		if (spec.label === "M04-research") {
			assert.equal(spec.tools.kind, "read-dir");
			if (spec.tools.kind !== "read-dir") throw new Error("M04 read grant missing");
			return { text: "The bounded check passed; the broad search stays open.",
				readReturns: await readAll(spec.tools.root, "m07_evidence_read") };
		}
		throw new Error(`unexpected fake session ${spec.label}`);
	});
	const mission = openDefaultLocalMission({ workspaceRoot: root, runner,
		config: { roles: { research: "fake/research", execution: "fake/execution" },
			localMission: { evaluatorId: "test:bounded-task-open-goal" }, concurrency: 1, tools: {} } });
	const started = await mission.begin({ version: 1, kind: "local-original-objective-request",
		goal: "Resolve the original bounded and broad questions", goalSource: "verbatim-private-input",
		obligations: [{ id: "bounded", description: bounded, type: "synthetic-open" },
			{ id: "broad", description: broad, type: "synthetic-open" }], closure: "open-ended" });
	missionId = started.contract.id;
	const progress = await mission.step(missionId);
	assert.equal(prompts, 1);
	assert.equal(progress.objectiveOutcome, "incomplete");
	assert.deepEqual(progress.assessment?.unresolvedObligations, ["bounded", "broad"]);
	assert.equal(progress.boundedRuns.length, 1);
	const goal = JSON.parse(await readFile(path.join(ws.runDir("M07", progress.boundedRuns[0]!.runId),
		"goal.json"), "utf8")) as { successCriteria: string[]; tasks: Array<{ checks: string[];
		status: string }> };
	assert.deepEqual(goal.successCriteria, [bounded]);
	assert.deepEqual(goal.tasks[0]?.checks, [bounded]);
	assert.equal(goal.tasks[0]?.status, "accepted");
	const receipt = JSON.parse(await readFile(path.join(ws.runDir("M07", progress.boundedRuns[0]!.runId),
		"tasks/T001/work/local-evaluator-receipt.json"), "utf8")) as
		{ checks: Array<{ obligationId: string; result: string }> };
	assert.deepEqual(receipt.checks.map(item => [item.obligationId, item.result]),
		[["bounded", "passed"], ["broad", "unknown"]]);
});

test("local host repair evidence refuses assessment before the first model prompt", async t => {
	const root = await mkdtemp(path.join(os.tmpdir(), "local-mission-lock-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const ws = new Workspace(root);
	await mkdir(path.dirname(ws.problemFile), { recursive: true });
	await writeFile(ws.problemFile, "Synthetic original question\n");
	await runInit(ws, createFileKnowledgeStore(ws.knowledgeDir));
	let prompts = 0;
	const runner = new FakeSessionRunner(() => { prompts++; return "No task"; });
	const mission = openDefaultLocalMission({ workspaceRoot: root, runner,
		config: { roles: { research: "fake/research", execution: "fake/execution" },
			concurrency: 1, tools: {} } });
	const started = await mission.begin({ version: 1, kind: "local-original-objective-request",
		goal: "Answer the synthetic question", goalSource: "verbatim-private-input",
		obligations: [{ id: "answer", description: "Support the answer" }], closure: "open-ended" });
	const lock = path.join(ws.agentDir, "missions", started.contract.id, ".writer.lock");
	await writeFile(lock, "synthetic incomplete prior mutation\n", { mode: 0o600 });
	await assert.rejects(mission.step(started.contract.id), /unresolved durable-write repair/);
	assert.equal(prompts, 0);
	assert.equal((await ws.listRuns("MISSION")).length, 0);
});

test("changed frozen original bytes cannot silently alter a restarted mission", async t => {
	const root = await mkdtemp(path.join(os.tmpdir(), "local-mission-original-change-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const ws = new Workspace(root);
	await mkdir(path.dirname(ws.problemFile), { recursive: true });
	await writeFile(ws.problemFile, "Original fixed task\n");
	await runInit(ws, createFileKnowledgeStore(ws.knowledgeDir));
	let prompts = 0;
	const mission = openDefaultLocalMission({ workspaceRoot: root,
		runner: new FakeSessionRunner(() => { prompts++; return "unused"; }),
		config: { roles: { research: "fake/research", execution: "fake/execution" },
			concurrency: 1, tools: {} } });
	const started = await mission.begin({ version: 1, kind: "local-original-objective-request",
		goal: "Answer the original fixed task", goalSource: "verbatim-private-input",
		obligations: [{ id: "answer", description: "Prove the original answer" }],
		closure: "open-ended" });
	const frozen = path.join(ws.agentDir, "missions", started.contract.id,
		"evidence", "original-problem.txt");
	await writeFile(frozen, "Different fixed task\n");
	await assert.rejects(mission.step(started.contract.id), /original input differs from committed host evidence/);
	assert.equal(prompts, 0);
});

test("binary original input is refused before a local mission gains host authority", async t => {
	const root = await mkdtemp(path.join(os.tmpdir(), "local-mission-binary-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const ws = new Workspace(root);
	await mkdir(ws.rawDir, { recursive: true });
	await writeFile(ws.problemFile, "Synthetic original question\n");
	await writeFile(path.join(ws.rawDir, "image.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1]));
	await runInit(ws, createFileKnowledgeStore(ws.knowledgeDir));
	const mission = openDefaultLocalMission({ workspaceRoot: root });
	await assert.rejects(mission.begin({ version: 1, kind: "local-original-objective-request",
		goal: "Answer the synthetic question", goalSource: "verbatim-private-input",
		obligations: [{ id: "answer", description: "Support the answer" }], closure: "open-ended" }),
		error => { assert.doesNotMatch(String(error), /image\.png|PNG/); return true; });
	const missionsRoot = path.join(ws.agentDir, "missions");
	const missions = await readdir(missionsRoot).catch(error => {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	});
	assert.deepEqual(missions, [], "no mission is committed for unreadable original input");
});
