import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { createFileKnowledgeStore } from "../src/knowledge/store.ts";
import { openDefaultLocalMission } from "../src/m07/local-mission.ts";
import { missionLineageFile, readLocalDispatchLineage } from "../src/m07/local-dispatch-lineage.ts";
import { LocalMissionHost } from "../src/runner/local-mission-host.ts";
import type { ObjectiveProgressV1 } from "../src/m07/objective-progress.ts";
import { Workspace } from "../src/workspace.ts";
import { config, retryUnissued, seedUnissued } from "./fixtures/local-mission-unissued-step.ts";

async function fixture(t: TestContext, inChild = false, declaredMaterials = false) {
	const root = await mkdtemp(path.join(tmpdir(), "mission-unissued-assessment-"));
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

test("unknown, orphan, partial lineage, M04 drift or changed assessor evidence keeps the intent held", async t => {
	for (const cause of ["unknown", "orphan", "original-source", "copy", "both", "extra-member", "partial-link", "new-m04"] as const) {
		const f = await fixture(t);
		if (cause === "unknown") {
			const host = await LocalMissionHost.begin({ root: f.missionRoot, missionId: f.id,
				attemptId: "A001", codeRevision: "local-harness-v1" });
			await host.recordUnknownOperation({ operationId: "synthetic-unknown-effect", attemptId: "A001" });
		} else if (cause === "orphan") await mkdir(path.join(f.ws.stagesDir, "M07", "orphan-goal"), { recursive: true });
		else if (cause === "partial-link") {
			const link = missionLineageFile(f.missionRoot, f.intent);
			await mkdir(path.dirname(link), { recursive: true, mode: 0o700 }); await writeFile(link, "partial dispatch edge\n", { mode: 0o600 });
		} else if (cause === "new-m04") {
			const m04 = await f.ws.startRun("M04", []); await f.ws.finishRun(m04, "completed");
		}
		else {
			const mission = await f.ws.readRun("MISSION", f.intent);
			const boundary = mission.sessions.find(row => row.id === f.progress.assessment!.sessionId)!.boundary!;
			const copy = boundary.evidence.find(row => path.basename(row.path) === "original-problem.txt")!.path;
			if (cause === "extra-member") await writeFile(path.join(path.dirname(copy), "unknown-evidence.txt"), "Unrecognized source\n");
			else {
				await writeFile(cause === "copy" ? copy : path.join(f.missionRoot, "evidence", "original-problem.txt"), "Changed original evidence\n");
				if (cause === "both") await writeFile(copy, "Changed original evidence\n");
			}
		}
		const next = await retryUnissued(f.root, f.id);
		assert.equal(next.stopReason, "execution-interrupted", cause);
		assert.equal(next.boundedRuns.length, 0); assert.deepEqual(next.assessment, f.progress.assessment);
		assert.deepEqual(await readFile(f.intentFile), f.intentBytes);
		assert.equal(await readFile(path.join(f.root, "calls.log"), "utf8"), "assessor\n", cause);
	}
});

test("two same-process callers cannot both issue the retained task", async t => {
	const f = await fixture(t);
	const [first, second] = await Promise.all([retryUnissued(f.root, f.id), retryUnissued(f.root, f.id)]);
	assert.deepEqual([first.boundedRuns.length, second.boundedRuns.length].sort(), [0, 1]);
	assert.equal((await f.ws.listRuns("M07")).length, 1);
	assert.equal(await readFile(path.join(f.root, "calls.log"), "utf8"), "assessor\ntask\nm04\n");
	assert.deepEqual(await readFile(f.intentFile), f.intentBytes);
});

test("live original problem and raw material drift cannot reach a new task provider", async t => {
	for (const cause of ["problem", "raw", "extra-raw", "missing-raw"] as const) {
		const f = await fixture(t);
		if (cause === "problem") await writeFile(f.ws.problemFile, "A changed live original claim\n");
		else if (cause === "raw") await writeFile(path.join(f.ws.rawDir, "observation.txt"), "A changed live observation\n");
		else if (cause === "extra-raw") await writeFile(path.join(f.ws.rawDir, "injected.txt"), "New unassessed raw input\n");
		else await rm(path.join(f.ws.rawDir, "observation.txt"));
		await retryUnissued(f.root, f.id).catch(() => undefined);
		const next = await openDefaultLocalMission({ workspaceRoot: f.root }).status(f.id);
		assert.equal(next.stopReason, "execution-interrupted", cause);
		assert.equal(next.boundedRuns.length, 0, cause);
		assert.deepEqual(await f.ws.listRuns("M07"), [], cause);
		assert.equal(await readFile(path.join(f.root, "calls.log"), "utf8"), "assessor\n", cause);
		assert.deepEqual(await readFile(f.intentFile), f.intentBytes);
	}
});

test("raw drift after the adapter reads originals is caught before the task provider opens", async t => {
	const f = await fixture(t);
	const originalRead = Workspace.prototype.readRawInfo;
	let changed = false;
	Workspace.prototype.readRawInfo = async function() {
		const result = await originalRead.call(this);
		if (!changed && this.root === f.ws.root) {
			changed = true;
			await writeFile(path.join(this.rawDir, "observation.txt"), "Changed during the dispatch copy seam\n");
		}
		return result;
	};
	try { await retryUnissued(f.root, f.id).catch(() => undefined); }
	finally { Workspace.prototype.readRawInfo = originalRead; }
	const next = await openDefaultLocalMission({ workspaceRoot: f.root }).status(f.id);
	assert.equal(next.boundedRuns.length, 0);
	assert.equal(next.stopReason, "execution-interrupted");
	assert.equal(await readFile(path.join(f.root, "calls.log"), "utf8"), "assessor\n");
	assert.deepEqual(await readFile(f.intentFile), f.intentBytes);
});

test("saved assessor evidence drift after host proof is caught in the prepared task copies", async t => {
	const f = await fixture(t);
	const mission = await f.ws.readRun("MISSION", f.intent);
	const boundary = mission.sessions.find(row => row.id === f.progress.assessment!.sessionId)!.boundary!;
	const copy = boundary.evidence.find(row => path.basename(row.path) === "original-problem.txt")!.path;
	const originalRead = Workspace.prototype.readProblem;
	let changed = false;
	Workspace.prototype.readProblem = async function() {
		const result = await originalRead.call(this);
		if (!changed && this.root === f.ws.root) {
			changed = true; await writeFile(copy, "Changed saved evidence after proof\n");
		}
		return result;
	};
	try { await retryUnissued(f.root, f.id).catch(() => undefined); }
	finally { Workspace.prototype.readProblem = originalRead; }
	const next = await openDefaultLocalMission({ workspaceRoot: f.root }).status(f.id);
	assert.equal(next.boundedRuns.length, 0);
	assert.equal(next.stopReason, "execution-interrupted");
	assert.equal(await readFile(path.join(f.root, "calls.log"), "utf8"), "assessor\n");
	assert.deepEqual(await readFile(f.intentFile), f.intentBytes);
});

test("CURRENT drift without a later M04 run cannot issue a saved assessment task", async t => {
	const f = await fixture(t);
	const store = createFileKnowledgeStore(f.ws.knowledgeDir);
	const receipt = await store.submitProposal({ stage: "M04", runId: "synthetic-independent-merge",
		ops: [{ op: "create", type: "E", title: "Independent published evidence",
			body: "Synthetic evidence introduced after the retained assessment", usageDecision: "adopted" }] });
	const merged = await store.merge(receipt.proposalId);
	assert.equal((await f.ws.listRuns("M04")).length, 1, "knowledge changed without a new M04 stage record");
	const next = await retryUnissued(f.root, f.id);
	assert.equal(next.stopReason, "execution-interrupted"); assert.equal(next.boundedRuns.length, 0);
	assert.deepEqual(await f.ws.listRuns("M07"), []);
	assert.equal(await readFile(path.join(f.root, "calls.log"), "utf8"), "assessor\n");
	assert.equal((await store.current())?.id, merged.snapshot.id, "failure does not roll knowledge back");
	assert.deepEqual(await readFile(f.intentFile), f.intentBytes);
});

test("a new M04 with the same knowledge epoch after host proof blocks saved task dispatch", async t => {
	const f = await fixture(t);
	const originalRead = Workspace.prototype.readProblem;
	let changed = false;
	Workspace.prototype.readProblem = async function() {
		const result = await originalRead.call(this);
		if (!changed && this.root === f.ws.root) {
			changed = true;
			const m04 = await this.startRun("M04", []);
			await this.finishRun(m04, "completed");
		}
		return result;
	};
	try { await retryUnissued(f.root, f.id).catch(() => undefined); }
	finally { Workspace.prototype.readProblem = originalRead; }
	const next = await openDefaultLocalMission({ workspaceRoot: f.root }).status(f.id);
	assert.equal(next.boundedRuns.length, 0);
	assert.equal(next.stopReason, "execution-interrupted");
	assert.deepEqual(await f.ws.listRuns("M07"), [], "changed M04 identity is detected before begin");
	assert.equal(await readFile(path.join(f.root, "calls.log"), "utf8"), "assessor\n");
	assert.equal(await readFile(path.join(f.ws.knowledgeDir, "CURRENT"), "utf8"), "");
	assert.deepEqual(await readFile(f.intentFile), f.intentBytes);
});

test("M04 creation during task preparation is checked again before provider entry", async t => {
	const f = await fixture(t);
	const originalRead = Workspace.prototype.readRawInfo;
	let reads = 0;
	Workspace.prototype.readRawInfo = async function() {
		const result = await originalRead.call(this);
		if (this.root === f.ws.root && ++reads === 2) {
			const m04 = await this.startRun("M04", []);
			await this.finishRun(m04, "completed");
		}
		return result;
	};
	try { await retryUnissued(f.root, f.id).catch(() => undefined); }
	finally { Workspace.prototype.readRawInfo = originalRead; }
	assert.equal(reads, 2, "the M04 change occurred in the prepared task input recheck");
	const next = await openDefaultLocalMission({ workspaceRoot: f.root }).status(f.id);
	assert.equal(next.boundedRuns.length, 0);
	assert.equal(next.stopReason, "execution-interrupted");
	assert.equal((await f.ws.listRuns("M07")).length, 1, "a prepared goal exists and must stay held");
	assert.equal(await readFile(path.join(f.root, "calls.log"), "utf8"), "assessor\n");
	assert.deepEqual(await readFile(f.intentFile), f.intentBytes);
});

test("retained declared-material mission excludes populated ambient raw from M07 and M04 checkpoints", async t => {
	const f = await fixture(t, false, true);
	const initialContract = JSON.parse((await LocalMissionHost.readInitialContract(f.missionRoot))!.toString("utf8"));
	assert.equal(typeof initialContract.materialManifestSha256, "string");
	assert.equal(initialContract.frozenInputs.filter((row: { name: string }) => row.name.startsWith("original-input-")).length, 0);
	assert.equal(await readFile(path.join(f.ws.rawDir, "observation.txt"), "utf8"), "Original synthetic observation\n");
	const next = await retryUnissued(f.root, f.id);
	assert.equal(next.boundedRuns.length, 1); assert.equal(next.assessmentHistory.length, 1);
	assert.deepEqual(next.assessment, f.progress.assessment);
	assert.equal(await readFile(path.join(f.root, "calls.log"), "utf8"), "assessor\ntask\nm04\n");
	const goal = JSON.parse(await readFile(path.join(f.ws.runDir("M07", next.boundedRuns[0]!.runId), "goal.json"), "utf8"));
	assert.equal(goal.checkpointRawScope, "none");
	assert.equal(goal.tasks[0].inputCopies.some((row: { source: string }) => row.source.startsWith(`${f.ws.rawDir}${path.sep}`)), false);
	const checkpoint = goal.checkpoints[0];
	const manifest = JSON.parse(await readFile(checkpoint.manifestPath, "utf8"));
	assert.deepEqual(manifest.rawFiles, []); assert.deepEqual(manifest.skippedRaw, []);
	assert.equal(manifest.files.some((row: { sourceRelativePath: string }) => row.sourceRelativePath.startsWith("problem/raw/")), false);
	const m04 = await f.ws.latestRun("M04"); assert.equal(m04!.status, "completed");
	const coverage = JSON.parse(await readFile(path.join(f.ws.runDir("M04", m04!.runId), "m07-coverage.json"), "utf8"));
	assert.equal(JSON.stringify(coverage).includes("observation.txt"), false);
	assert.deepEqual(await readFile(f.intentFile), f.intentBytes);
});
