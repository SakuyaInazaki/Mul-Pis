import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, realpath, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { createFileKnowledgeStore } from "../src/knowledge/store.ts";
import { openDefaultLocalMission } from "../src/m07/local-mission.ts";
import { FakeSessionRunner } from "../src/runner/fake.ts";
import { LocalMissionHost } from "../src/runner/local-mission-host.ts";
import type { ReadReturnEvent } from "../src/runner/types.ts";
import { runM04 } from "../src/stages/m04.ts";
import { runInit } from "../src/stages/init.ts";
import { Workspace } from "../src/workspace.ts";

const answer = "A synthetic finite answer with exact bytes.\n";
const digest = createHash("sha256").update(answer).digest("hex");
const lineCount = (text: string) => text.split(/\r?\n/).length - Number(text.endsWith("\n"));
const selectedCandidate = (names: readonly string[]) => names.find(name =>
	/^candidate-001-[0-9a-f]{16}\.md$/.test(name));
const selectedDigest = (names: readonly string[]) => names.find(name =>
	/^observation-digests-[0-9a-f]{16}\.json$/.test(name));
function assertExactSelection(names: readonly string[]): void {
	assert.equal(names.length, 2);
	assert(selectedCandidate(names));
	assert(selectedDigest(names));
}


function cliWithTrustedPreload(root: string, action: "start" | "run" | "resume" | "status",
	argument: string, twoStep = false, expectedStatus = 0) {
	const env = { ...process.env };
	for (const name of Object.keys(env)) if (/KEY|TOKEN|SECRET|PASSWORD/i.test(name)) delete env[name];
	if (twoStep) env.MULPIS_SYNTHETIC_TWO_STEP = "1";
	const repo = path.join(import.meta.dirname, "..");
	const child = spawnSync(process.execPath, ["--import", path.join(import.meta.dirname,
		"fixtures", "trusted-cli-evaluator-preload.ts"), path.join(repo, "src", "cli.ts"),
		"mission", action, "--workspace", root,
		...(action === "status" ? [] : ["--runner", "fake"]),
		...(action === "start" ? ["--original", argument] : ["--mission", argument])],
		{ cwd: repo, env, encoding: "utf8" });
	assert.equal(child.status, expectedStatus, `${action}: ${child.stderr}\n${child.stdout}`);
	return JSON.parse(child.stdout.trim()) as Record<string, unknown>;
}

async function readMissionCheckpoint(root: string, missionId: string) {
	const bytes = await LocalMissionHost.readLatestCheckpoint(path.join(root, ".agent", "missions", missionId));
	assert(bytes);
	return JSON.parse(bytes.toString("utf8")) as {
		assessmentHistory: unknown[]; boundedRuns: Array<{ runId: string }>;
		continuation: { unresolvedOperationIds: string[] }; stopReason: string;
	};
}

async function readEvents(root: string, toolName: string): Promise<ReadReturnEvent[]> {
	const events: ReadReturnEvent[] = [];
	async function visit(dir: string): Promise<void> {
		for (const name of await readdir(dir)) {
			const file = path.join(dir, name);
			if ((await stat(file)).isDirectory()) { await visit(file); continue; }
			const text = await readFile(file, "utf8");
			if (!text.length) {
				events.push({ toolName, status: "no-content",
					path: path.relative(root, file).replaceAll("\\", "/"),
					requested: {}, returned: { kind: "text", truncated: false },
					at: new Date().toISOString() });
				continue;
			}
			events.push({ toolName, status: "returned", path: path.relative(root, file).replaceAll("\\", "/"),
				requested: {}, returned: { kind: "text", startLine: 1,
					endLine: lineCount(text), truncated: false }, at: new Date().toISOString() });
		}
	}
	await visit(root);
	return events;
}

async function finiteFixture(t: TestContext) {
	const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "local-evaluator-finite-")));
	t.after(() => rm(root, { recursive: true, force: true }));
	const ws = new Workspace(root);
	await mkdir(path.dirname(ws.problemFile), { recursive: true });
	await writeFile(ws.problemFile, "Produce the exact synthetic finite answer.\n");
	const store = createFileKnowledgeStore(ws.knowledgeDir);
	await runInit(ws, store);
	const config = { roles: { research: "fake/research", execution: "fake/execution" },
		localMission: { evaluatorId: "host:file-sha256" }, concurrency: 1, tools: {} };
	let missionId = "";
	let assessorCalls = 0, m04Calls = 0, builderCalls = 0;
	const runner = new FakeSessionRunner(async ({ spec }) => {
		if (spec.label === "M04-research") {
			m04Calls++;
			return spec.tools.kind === "read-dir" ? {
				text: "Independent synthetic M04 read the frozen review materials; no knowledge proposal.",
				readReturns: await readEvents(spec.tools.root, "m07_evidence_read") } :
				"Initial synthetic M04 baseline; no knowledge proposal.";
		}
		if (spec.label.startsWith("M07-")) {
			builderCalls++;
			return answer;
		}
		if (spec.label.startsWith("local-original-objective-")) {
			assessorCalls++;
			assert.equal(spec.tools.kind, "read-dir");
			if (spec.tools.kind !== "read-dir") throw new Error("assessor lacks frozen evidence");
			const readReturns = await readEvents(spec.tools.root, "objective_evidence_read");
			const candidateName = selectedCandidate(await readdir(spec.tools.root));
			const issue = { id: "finite-gap", claim: "Exact answer has not been checked", status: "open",
				classification: "explicit-requirement", sourceRefs: [{ sourceId: "original-problem.txt",
					startLine: 1, endLine: 1 }], implication: "A checked candidate can settle this task" };
			return { text: JSON.stringify(assessorCalls === 1 ? {
				version: 1, decision: "continue", rationale: "The exact answer still needs a candidate.",
				evidenceRefs: ["original-problem.txt"], unresolvedObligations: ["answer"],
				unresolvedDetails: [issue.claim], groundedAssessment: { version: 1,
					kind: "grounded-assessment-proposal", contractId: missionId,
					missionStatus: "open", issues: [issue], legacyOpenDetails: [],
					nextTask: { objective: "Produce the exact synthetic answer", obligationIds: ["answer"],
						addresses: [issue.id], adapterScope: "local-m07-reason",
						decisionChangingHypothesis: "An exact result can settle the finite obligation",
						expectedEvidence: "A digest checked candidate", sourceRefs: issue.sourceRefs } } } : {
				version: 1, decision: "fulfilled", rationale: "The selected byte-exact result closes the finite requirement.",
				evidenceRefs: [candidateName], unresolvedObligations: [], unresolvedDetails: [],
				groundedAssessment: { version: 1, kind: "grounded-assessment-proposal",
					contractId: missionId, missionStatus: "open", legacyOpenDetails: [],
					issues: [{ ...issue, status: "resolved", resolution: {
						explanation: "The selected exact result resolves the original requirement.",
						evidenceRefs: [{ sourceId: candidateName, startLine: 1, endLine: 1 }] } }] } }),
				readReturns };
		}
		throw new Error(`unexpected fake session ${spec.label}`);
	});
	await runM04({ ws, runner, store, config }, { feedback: { kind: "file",
		label: "Synthetic baseline", path: ws.problemFile }, freshSession: true });
	const mission = openDefaultLocalMission({ workspaceRoot: root, runner, config });
	const started = await mission.begin({ version: 1, kind: "local-original-objective-request",
		goal: "Produce the exact synthetic finite answer", goalSource: "verbatim-private-input",
		obligations: [{ id: "answer", description: "Produce exact answer bytes",
			type: "file-sha256", expectedSha256: digest }],
		closure: "finite-evidence" });
	missionId = started.contract.id;
	return { root, config, mission, missionId,
		get assessorCalls() { return assessorCalls; },
		get m04Calls() { return m04Calls; }, get builderCalls() { return builderCalls; } };
}

test("default host completes a finite exact-file objective only after evaluator, M07 and full M04 review", async t => {
	const f = await finiteFixture(t);
	const first = await f.mission.step(f.missionId);
	assert.equal(first.objectiveOutcome, "incomplete");
	assertExactSelection(first.selectedArtifacts);
	assert.equal(first.stopReason, "objective-reassessment-pending");
	assert.equal(first.pendingM04Review, undefined);
	assert.equal(f.assessorCalls, 1);
	assert.equal(f.builderCalls, 1);
	assert.equal(f.m04Calls, 2);
	const finished = await f.mission.step(f.missionId);
	assert.equal(finished.objectiveOutcome, "fulfilled", JSON.stringify({ stopReason: finished.stopReason,
		selected: finished.selectedArtifacts, bounded: finished.boundedRuns, assessmentHistory: finished.assessmentHistory,
		assessorCalls: f.assessorCalls, m04Calls: f.m04Calls, builderCalls: f.builderCalls }));
	assert.equal(finished.boundedRuns.length, 1);
	assert.equal(finished.boundedRuns[0]!.acceptedTaskIds?.length, 1);
	assert.equal(finished.boundedRuns[0]!.selectionProofGap, undefined);
	assertExactSelection(finished.selectedArtifacts);
	assert.equal(f.assessorCalls, 2);
	assert.equal(f.builderCalls, 1);
	assert.equal(f.m04Calls, 2);
	const reopened = openDefaultLocalMission({ workspaceRoot: f.root, runner: new FakeSessionRunner(() => {
		throw new Error("restart must not prompt"); }), config: f.config });
	assert.deepEqual(await reopened.status(f.missionId), finished);
	assert.deepEqual(await reopened.step(f.missionId), finished);
});

test("a new process recovers selected bytes, M04 evidence and review before finite closure", async t => {
	const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "local-evaluator-process-restart-")));
	t.after(() => rm(root, { recursive: true, force: true }));
	const env = { ...process.env };
	for (const name of Object.keys(env)) if (/KEY|TOKEN|SECRET|PASSWORD/i.test(name)) delete env[name];
	const child = spawnSync(process.execPath, [path.join(import.meta.dirname,
		"fixtures", "local-evaluator-first-process.ts"), root],
		{ cwd: path.join(import.meta.dirname, ".."), env, encoding: "utf8" });
	assert.equal(child.status, 0, child.stderr);
	const { missionId } = JSON.parse(child.stdout.trim()) as { missionId: string };
	const config = { roles: { research: "fake/research", execution: "fake/execution" },
		localMission: { evaluatorId: "host:file-sha256" }, concurrency: 1, tools: {} };
	let calls = 0;
	const runner = new FakeSessionRunner(async ({ spec }) => {
		calls++;
		assert(spec.label.startsWith("local-original-objective-"));
		assert.equal(spec.tools.kind, "read-dir");
		if (spec.tools.kind !== "read-dir") throw new Error("restart assessor lacks frozen grant");
		const candidateName = selectedCandidate(await readdir(spec.tools.root));
		const issue = { id: "finite-gap", claim: "Exact answer has not been checked",
			status: "resolved", classification: "explicit-requirement",
			sourceRefs: [{ sourceId: "original-problem.txt", startLine: 1, endLine: 1 }],
			implication: "A checked candidate can settle this task",
			resolution: { explanation: "The selected exact result resolves the original requirement.",
			evidenceRefs: [{ sourceId: candidateName!, startLine: 1, endLine: 1 }] } };
		return { text: JSON.stringify({ version: 1, decision: "fulfilled",
			rationale: "Selected exact bytes settle this finite task.",
			evidenceRefs: [candidateName!], unresolvedObligations: [], unresolvedDetails: [],
			groundedAssessment: { version: 1, kind: "grounded-assessment-proposal",
				contractId: missionId, missionStatus: "open", issues: [issue],
				legacyOpenDetails: [] } }),
			readReturns: await readEvents(spec.tools.root, "objective_evidence_read") };
	});
	const mission = openDefaultLocalMission({ workspaceRoot: root, runner, config });
	const final = await mission.step(missionId);
	assert.equal(final.objectiveOutcome, "fulfilled");
	assert.equal(calls, 1);
	assertExactSelection(final.selectedArtifacts);
});


test("real CLI start, run and resume load trusted preloader and select a host-created non-CSR observation", async t => {
	const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "local-evaluator-cli-preload-")));
	t.after(() => rm(root, { recursive: true, force: true }));
	const ws = new Workspace(root);
	await mkdir(path.dirname(ws.problemFile), { recursive: true });
	await writeFile(ws.problemFile, "Produce a synthetic byte-count candidate.\n");
	const store = createFileKnowledgeStore(ws.knowledgeDir);
	await runInit(ws, store);
	const config = { roles: { research: "fake/research", execution: "fake/execution" },
		localMission: { evaluatorId: "test:byte-observation" }, concurrency: 1, tools: {} };
	await writeFile(ws.configFile, `${JSON.stringify(config, null, 2)}\n`);
	const baselineRunner = new FakeSessionRunner(() => "Offline initial M04 baseline; no proposal.");
	await runM04({ ws, runner: baselineRunner, store, config }, { feedback: { kind: "file",
		label: "Synthetic baseline", path: ws.problemFile }, freshSession: true });
	const requestFile = path.join(root, "original-request.json");
	await writeFile(requestFile, `${JSON.stringify({ version: 1,
		kind: "local-original-objective-request", goal: "Produce a synthetic byte-count candidate",
		goalSource: "verbatim-private-input", obligations: [{ id: "answer",
			description: "Produce a measured synthetic candidate", type: "test-byte-count" }],
		closure: "finite-evidence" }, null, 2)}\n`);
	const started = cliWithTrustedPreload(root, "start", requestFile);
	const missionId = started.missionId as string;
	assert.match(missionId, /^[0-9a-f-]{36}$/);
	const finished = cliWithTrustedPreload(root, "run", missionId);
	assert.equal(finished.objectiveOutcome, "fulfilled", JSON.stringify(finished));
	assert.equal(cliWithTrustedPreload(root, "resume", missionId).objectiveOutcome, "fulfilled");
	assert.equal(cliWithTrustedPreload(root, "status", missionId).objectiveOutcome, "fulfilled");
	const storedBytes = await LocalMissionHost.readLatestCheckpoint(path.join(ws.agentDir,
		"missions", missionId));
	assert(storedBytes);
	const stored = JSON.parse(storedBytes.toString("utf8")) as { boundedRuns: Array<{ runId: string }> };
	const runId = stored.boundedRuns[0]!.runId;
	const selection = JSON.parse(await readFile(path.join(ws.agentDir, "missions", missionId,
		"evidence", `selection-review-${runId}.json`), "utf8")) as {
		selectedArtifacts: Array<{ name: string; file: string }>;
		hostEvidence: { requiredM07ReadPaths: string[]; m04CoverageSha256: string } };
	const observation = selection.selectedArtifacts.find(item => item.name.startsWith("observation-byte-count-"));
	assert(observation);
	const log = JSON.parse(await readFile(observation.file, "utf8")) as { kind: string;
		observed: Array<{ bytes: number }> };
	assert.equal(log.kind, "synthetic-byte-count-observation");
	assert(log.observed[0]!.bytes > 0);
	assert(selection.hostEvidence.requiredM07ReadPaths.some(item =>
		item.includes("observation-byte-count.json")));
	await chmod(observation.file, 0o600);
	await writeFile(observation.file, "changed selected host observation\n");
	const env = { ...process.env };
	for (const name of Object.keys(env)) if (/KEY|TOKEN|SECRET|PASSWORD/i.test(name)) delete env[name];
	const repo = path.join(import.meta.dirname, "..");
	const invalidStatus = spawnSync(process.execPath, ["--import", path.join(import.meta.dirname,
		"fixtures", "trusted-cli-evaluator-preload.ts"), path.join(repo, "src", "cli.ts"),
		"mission", "status", "--workspace", root, "--mission", missionId],
		{ cwd: repo, env, encoding: "utf8" });
	assert.notEqual(invalidStatus.status, 0);
	assert.match(invalidStatus.stderr, /fulfilled checkpoint was recorded.*current evidence is invalid/i);
});

test("fresh CLI resumes dispatch one settled M07/M04 at a time and hold on unknown effects", async t => {
	const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "local-evaluator-cli-steps-")));
	t.after(() => rm(root, { recursive: true, force: true }));
	const ws = new Workspace(root);
	await mkdir(path.dirname(ws.problemFile), { recursive: true });
	await writeFile(ws.problemFile, "Produce two distinct synthetic candidates.\n");
	const store = createFileKnowledgeStore(ws.knowledgeDir);
	await runInit(ws, store);
	const config = { roles: { research: "fake/research", execution: "fake/execution" },
		localMission: { evaluatorId: "test:byte-observation" }, concurrency: 1, tools: {} };
	await writeFile(ws.configFile, `${JSON.stringify(config, null, 2)}\n`);
	await runM04({ ws, runner: new FakeSessionRunner(() => "Offline baseline; no proposal."),
		store, config }, { feedback: { kind: "file", label: "Synthetic baseline",
			path: ws.problemFile }, freshSession: true });
	const requestFile = path.join(root, "original-request.json");
	await writeFile(requestFile, `${JSON.stringify({ version: 1,
		kind: "local-original-objective-request", goal: "Produce two distinct synthetic candidates",
		goalSource: "verbatim-private-input", obligations: [{ id: "answer",
			description: "Produce measured synthetic candidates", type: "test-byte-count" }],
		closure: "open-ended" }, null, 2)}\n`);
	const missionId = cliWithTrustedPreload(root, "start", requestFile, true).missionId as string;
	const baselineM04 = (await ws.listRuns("M04")).length;
	const first = cliWithTrustedPreload(root, "resume", missionId, true);
	const firstCheckpoint = await readMissionCheckpoint(root, missionId);
	assert.equal(first.objectiveOutcome, "incomplete");
	assert.equal(firstCheckpoint.boundedRuns.length, 1);
	assert.equal((await ws.listRuns("M07")).length, 1);
	assert.equal((await ws.listRuns("M04")).length, baselineM04 + 1);
	assert.equal((await ws.listRuns("MISSION")).length, 1);
	const firstRunId = firstCheckpoint.boundedRuns[0]!.runId;
	const firstGoalFile = path.join(ws.runDir("M07", firstRunId), "goal.json");
	const firstGoalBytes = await readFile(firstGoalFile);
	const firstGoal = JSON.parse(firstGoalBytes.toString("utf8")) as {
		lifecycle: string; tasks: Array<{ objective: string; status: string }> };
	assert.equal(firstGoal.lifecycle, "finished");
	assert.equal(firstGoal.tasks[0]!.status, "accepted");

	const second = cliWithTrustedPreload(root, "resume", missionId, true);
	const secondCheckpoint = await readMissionCheckpoint(root, missionId);
	assert.equal(second.objectiveOutcome, "incomplete");
	assert.equal(secondCheckpoint.boundedRuns.length, 2);
	assert.equal(secondCheckpoint.boundedRuns[0]!.runId, firstRunId);
	assert.equal((await ws.listRuns("M07")).length, 2);
	assert.equal((await ws.listRuns("M04")).length, baselineM04 + 2);
	assert.equal((await ws.listRuns("MISSION")).length, 2);
	assert.deepEqual(await readFile(firstGoalFile), firstGoalBytes, "fresh owner did not replay first task");
	const secondRunId = secondCheckpoint.boundedRuns[1]!.runId;
	assert.notEqual(secondRunId, firstRunId);
	const secondGoal = JSON.parse(await readFile(path.join(ws.runDir("M07", secondRunId),
		"goal.json"), "utf8")) as { lifecycle: string;
			tasks: Array<{ objective: string; status: string }> };
	assert.equal(secondGoal.lifecycle, "finished");
	assert.equal(secondGoal.tasks[0]!.status, "accepted");
	assert.notEqual(secondGoal.tasks[0]!.objective, firstGoal.tasks[0]!.objective);
	for (const runId of await ws.listRuns("M04"))
		assert.equal((await ws.readRun("M04", runId)).status, "completed");

	const repo = path.join(import.meta.dirname, "..");
	const env = { ...process.env };
	for (const name of Object.keys(env)) if (/KEY|TOKEN|SECRET|PASSWORD/i.test(name)) delete env[name];
	const injected = spawnSync(process.execPath, [path.join(import.meta.dirname, "fixtures",
		"local-mission-record-unknown.ts"), root, missionId],
		{ cwd: repo, env, encoding: "utf8", timeout: 30_000 });
	assert.equal(injected.status, 0, injected.stderr);
	const held = cliWithTrustedPreload(root, "resume", missionId, true, 1);
	const heldCheckpoint = await readMissionCheckpoint(root, missionId);
	assert.equal(held.stopReason, "execution-interrupted");
	assert(heldCheckpoint.continuation.unresolvedOperationIds.includes("synthetic-unsettled-effect"));
	assert.equal(heldCheckpoint.assessmentHistory.length, secondCheckpoint.assessmentHistory.length);
	assert.equal(heldCheckpoint.boundedRuns.length, 2);
	assert.equal((await ws.listRuns("MISSION")).length, 2, "unknown effect blocked assessor");
	assert.equal((await ws.listRuns("M07")).length, 2, "unknown effect blocked dispatch");
	assert.equal((await ws.listRuns("M04")).length, baselineM04 + 2);
});
