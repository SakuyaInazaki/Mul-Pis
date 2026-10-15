import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { openDefaultLocalMission } from "../src/m07/local-mission.ts";
import { readLocalDispatchLineage } from "../src/m07/local-dispatch-lineage.ts";
import { LocalMissionHost } from "../src/runner/local-mission-host.ts";
import type { ObjectiveProgressV1 } from "../src/m07/objective-progress.ts";
import { Workspace } from "../src/workspace.ts";
import { retryUnissued, seedUnissued } from "./fixtures/local-mission-unissued-step.ts";

async function fixture(t: TestContext, inChild = false, declaredMaterials = false) {
	const root = await realpath(await mkdtemp(path.join(tmpdir(), "mission-unissued-assessment-")));
	t.after(() => rm(root, { recursive: true, force: true }));
	const script = path.join(import.meta.dirname, "fixtures", "local-mission-unissued-step.ts");
	let id: string;
	if (inChild) {
		const child = spawnSync(process.execPath, [script, "seed", root], { encoding: "utf8", timeout: 30_000 });
		assert.equal(child.status, 0, child.stderr); id = child.stdout.trim();
	} else id = await seedUnissued(root, declaredMaterials);
	const ws = new Workspace(root), missionRoot = path.join(ws.agentDir, "missions", id);
	const progress = await openDefaultLocalMission({ workspaceRoot: root }).status(id);
	const intent = progress.continuation.unresolvedOperationIds[0]!;
	const intentFile = path.join(ws.runDir("MISSION", intent), "run.json");
	return { root, script, id, ws, missionRoot, progress, intent, intentFile,
		intentBytes: await readFile(intentFile), status: await LocalMissionHost.status(missionRoot) };
}

test("default composition reuses the admitted assessment and same unissued intent without a paid reassessment", async t => {
	const f = await fixture(t);
	assert.equal(f.progress.stopReason, "execution-interrupted");
	assert.equal(f.progress.assessmentHistory.length, 1);
	assert.equal((await f.ws.readRun("MISSION", f.intent)).status, "failed");
	assert.deepEqual(await f.ws.listRuns("M07"), []);
	assert.equal((await f.ws.listRuns("M04")).length, 1);
	assert.equal(await readFile(path.join(f.ws.knowledgeDir, "CURRENT"), "utf8"), "");
	const next = await retryUnissued(f.root, f.id);
	assert.equal(next.boundedRuns.length, 1); assert.equal(next.selectedArtifacts.length, 0);
	assert.equal(next.objectiveOutcome, "incomplete"); assert.equal(next.assessmentHistory.length, 1);
	assert.deepEqual(next.assessment, f.progress.assessment);
	assert.deepEqual(next.assessmentHistory, f.progress.assessmentHistory);
	assert.deepEqual(next.continuation.unresolvedOperationIds, []);
	assert.deepEqual(await readFile(f.intentFile), f.intentBytes);
	assert.equal(await readFile(path.join(f.root, "calls.log"), "utf8"), "assessor\ntask\nm04\n");
	const runId = next.boundedRuns[0]!.runId;
	const link = await readLocalDispatchLineage({ missionRoot: f.missionRoot,
		m07Dir: f.ws.runDir("M07", runId), intentId: f.intent });
	assert.equal(link.lineage.intentId, f.intent);
	assert.equal(link.lineage.assessorTaskSha256.length, 64);
	const goal = JSON.parse(await readFile(path.join(f.ws.runDir("M07", runId), "goal.json"), "utf8"));
	assert.equal(goal.exploratory, true); assert.equal(goal.formalBaseline, false);
	assert.equal(goal.m04BaselineFailures.length, 1);
});

test("kill after re-owned checkpoint permits a new process to issue the saved task once", async t => {
	const f = await fixture(t, true);
	const killed = spawnSync(process.execPath, [f.script, "kill-after-reowner", f.root], {
		encoding: "utf8", timeout: 30_000 });
	assert.equal(killed.signal, "SIGKILL", killed.stderr);
	const afterKill = await LocalMissionHost.status(f.missionRoot);
	assert.equal(afterKill.latestCheckpoint?.sha256, f.status.latestCheckpoint?.sha256,
		"re-owned checkpoint must preserve every held progress byte");
	assert.equal(afterKill.currentAttempt?.attemptId, "A002");
	assert.deepEqual(await f.ws.listRuns("M07"), []);
	assert.equal(await readFile(path.join(f.root, "calls.log"), "utf8"), "assessor\n");
	const retry = spawnSync(process.execPath, [f.script, "retry", f.root], { encoding: "utf8", timeout: 30_000 });
	assert.equal(retry.status, 0, retry.stderr);
	const next = JSON.parse(retry.stdout) as ObjectiveProgressV1;
	assert.equal(next.boundedRuns.length, 1); assert.deepEqual(next.assessment, f.progress.assessment);
	assert.deepEqual(await readFile(f.intentFile), f.intentBytes);
	assert.equal(await readFile(path.join(f.root, "calls.log"), "utf8"), "assessor\ntask\nm04\n");
	const link = await readLocalDispatchLineage({ missionRoot: f.missionRoot,
		m07Dir: f.ws.runDir("M07", next.boundedRuns[0]!.runId), intentId: f.intent });
	assert.equal(link.lineage.oldAttempt.attemptId, "A003");
	assert.equal(link.lineage.intentCheckpoint.sequence, afterKill.latestCheckpoint!.sequence + 1);
});
