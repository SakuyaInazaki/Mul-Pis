import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { ResearchService } from "../src/pi/service.ts";
import { failureSignature, stageFingerprint, stageInputVersion } from "../src/pi/retry-guard.ts";
import { FakeSessionRunner } from "../src/runner/fake.ts";
import { Workspace } from "../src/workspace.ts";

test("same stage obligation can be retried after repeated identical failures", async () => {
	const root = await mkdtemp(path.join(tmpdir(), "pre-rsi-retry-"));
	await mkdir(path.join(root, "problem", "raw"), { recursive: true });
	await writeFile(path.join(root, "problem", "problem.md"), "problem\n");
	await writeFile(path.join(root, "research.config.json"), `${JSON.stringify({ roles: { execution: "fake/model" }, concurrency: 1 })}\n`);
	const service = new ResearchService({ defaultWorkspace: root, runnerFactory: () => new FakeSessionRunner(() => { throw new Error("same offline failure"); }) });
	await service.init(root);
	await assert.rejects(service.runStage({ stage: "M01" }), /same offline failure/);
	await assert.rejects(service.runStage({ stage: "M01" }), /same offline failure/);
	await assert.rejects(service.runStage({ stage: "M01" }), /same offline failure/);
	assert.equal((await service.status(root)).stages.M01.count, 3);
});

test("completed run records with failures count as failed attempts", () => {
	assert.ok(failureSignature({ record: { status: "completed", failures: ["knowledge merge failed"] } }));
	assert.equal(failureSignature({ record: { status: "completed", failures: [] } }), undefined);
	assert.equal(
		failureSignature({ record: { stage: "M09", status: "failed", failures: ["未实际读取 /tmp/run-a/source.json"] } }),
		failureSignature({ record: { stage: "M09", status: "failed", failures: ["没有读取 /tmp/run-b/trace.json，coverage 不完整"] } }),
	);
});

test("M04 retry identity distinguishes frozen checkpoints of the same active M07 goal", () => {
	const request = { stage: "M04" as const, feedbackStage: "M07" as const, feedbackRunId: "g1", feedbackCheckpointId: "C001", freshSession: true };
	const first = stageFingerprint(request);
	assert.equal(first, stageFingerprint({ ...request }), "the same checkpoint remains the same correction obligation");
	assert.notEqual(first, stageFingerprint({ ...request, feedbackCheckpointId: "C002" }), "a later frozen evidence batch may be retried independently");
});

test("M03 retry identity follows the resolved upstream runs and configured reviewer pool", async () => {
	const root = await mkdtemp(path.join(tmpdir(), "pre-rsi-m03-identity-"));
	await mkdir(path.join(root, "problem", "raw"), { recursive: true });
	await writeFile(path.join(root, "problem", "problem.md"), "problem\n");
	const config = (pool: Array<{ id: string; model: string }>) => writeFile(path.join(root, "research.config.json"), `${JSON.stringify({ roles: {}, m03Reviewers: pool, concurrency: 1 })}\n`);
	await config([{ id: "R1", model: "fake/model" }]);
	const ws = new Workspace(root); const m01 = await ws.startRun("M01", []); await ws.finishRun(m01, "completed"); const m02 = await ws.startRun("M02", []); await ws.finishRun(m02, "completed");
	const request = { stage: "M03" as const };
	const first = stageFingerprint(request, await stageInputVersion(root, request));
	assert.equal(first, stageFingerprint(request, await stageInputVersion(root, request)), "same pool and resolved inputs remain the same obligation");
	await config([{ id: "R2", model: "fake/model" }]);
	const renamed = stageFingerprint(request, await stageInputVersion(root, request));
	assert.equal(renamed, first, "renaming a provenance label does not change the obligation");
	await config([{ id: "R2", model: "fake/other" }]);
	assert.notEqual(stageFingerprint(request, await stageInputVersion(root, request)), renamed, "the actual model is part of identity");
	await config([{ id: "R2", model: "fake/model" }, { id: "R3", model: "fake/model" }]);
	assert.notEqual(stageFingerprint(request, await stageInputVersion(root, request)), first, "adding another same-model session changes the obligation");
	await config([{ id: "R1", model: "fake/model" }]);
	const next = await ws.startRun("M02", []); await ws.finishRun(next, "completed");
	assert.notEqual(stageFingerprint(request, await stageInputVersion(root, request)), first, "a new resolved upstream run changes the obligation");
});

test("latest completed run uses persisted millisecond timestamps instead of run-id suffix order", async () => {
	const root = await mkdtemp(path.join(tmpdir(), "pre-rsi-latest-run-"));
	const ws = new Workspace(root);
	const base = { status: "completed" as const, inputs: [], sessions: [], outputs: [], failures: [], remarks: [] };
	await ws.writeRun({ ...base, stage: "M01", runId: "20260920T120000Z-zzzz", startedAt: "2026-09-20T12:00:00.100Z", finishedAt: "2026-09-20T12:00:00.200Z" });
	await ws.writeRun({ ...base, stage: "M01", runId: "20260920T120000Z-aaaa", startedAt: "2026-09-20T12:00:00.300Z", finishedAt: "2026-09-20T12:00:00.400Z" });
	assert.equal((await ws.latestCompletedRun("M01"))?.runId, "20260920T120000Z-aaaa");
});

test("normal shutdown marks only the owned active run failed and late completion cannot overwrite it", async () => {
	const root = await mkdtemp(path.join(tmpdir(), "pre-rsi-interrupt-"));
	await mkdir(path.join(root, "problem", "raw"), { recursive: true });
	await writeFile(path.join(root, "problem", "problem.md"), "problem\n");
	await writeFile(path.join(root, "research.config.json"), `${JSON.stringify({ roles: { execution: "fake/model" }, concurrency: 1 })}\n`);
	let release!: () => void;
	const blocked = new Promise<void>((resolve) => { release = resolve; });
	const service = new ResearchService({ defaultWorkspace: path.join(root, "different-pi-cwd"), runnerFactory: () => new FakeSessionRunner(async () => { await blocked; return "late answer"; }) });
	await service.init(root);
	const pending = service.runStage({ stage: "M01", workspace: root });
	while ((await service.status(root)).stages.M01.count === 0) await new Promise((resolve) => setTimeout(resolve, 2));
	const ws = new Workspace(root);
	const foreign = await ws.startRun("M01", []);
	await service.interruptAllActive("test shutdown");
	release();
	await assert.rejects(pending, /不能覆盖为 completed/);
	const records = await Promise.all((await ws.listRuns("M01")).map((runId) => ws.readRun("M01", runId)));
	const owned = records.find((record) => record.runId !== foreign.runId)!;
	assert.equal(owned.status, "failed");
	assert.match(owned.failures.join("\n"), /host-shutdown/);
	assert.equal((await ws.readRun("M01", foreign.runId)).status, "running");
});

test("shutdown waits for a visible owned start before registration and rejects later starts", async t => {
	const root = await mkdtemp(path.join(tmpdir(), "pre-rsi-start-race-"));
	await mkdir(path.join(root, "problem", "raw"), { recursive: true });
	await writeFile(path.join(root, "problem", "problem.md"), "problem\n");
	await writeFile(path.join(root, "research.config.json"),
		`${JSON.stringify({ roles: { execution: "fake/model" }, concurrency: 1 })}\n`);
	const original = Workspace.prototype.startRun;
	let visible!: () => void, releaseStart!: () => void;
	const visiblePromise = new Promise<void>(resolve => { visible = resolve; });
	const delayedStart = new Promise<void>(resolve => { releaseStart = resolve; });
	let releasePrompt!: () => void;
	const blockedPrompt = new Promise<void>(resolve => { releasePrompt = resolve; });
	Workspace.prototype.startRun = async function(stage, inputs, knowledgeSnapshot) {
		const record = await original.call(this, stage, inputs, knowledgeSnapshot);
		if (stage === "M01" && inputs.length) { visible(); await delayedStart; }
		return record;
	};
	t.after(() => { Workspace.prototype.startRun = original; releaseStart(); releasePrompt(); });
	const service = new ResearchService({ defaultWorkspace: root,
		runnerFactory: () => new FakeSessionRunner(async () => {
			await blockedPrompt;
			return "late answer";
		}) });
	await service.init(root);
	const pending = service.runStage({ stage: "M01", workspace: root });
	await visiblePromise;
	const ws = new Workspace(root);
	const foreign = await ws.startRun("M01", []);
	const shutdown = service.interruptAllActive("test registration gap");
	// The owned start is visible on disk, but the service has not received its
	// returned record. Shutdown must retain ownership of exactly that start.
	releaseStart();
	await shutdown;
	releasePrompt();
	await assert.rejects(pending, /不能覆盖为|已经结束/);
	const runs = await Promise.all((await ws.listRuns("M01")).map(id => ws.readRun("M01", id)));
	assert.equal(runs.find(run => run.runId !== foreign.runId)?.status, "failed");
	assert.equal((await ws.readRun("M01", foreign.runId)).status, "running");
});

test("a stale stage write and completion cannot reopen a shutdown-failed run", async () => {
	const root = await mkdtemp(path.join(tmpdir(), "pre-rsi-terminal-race-"));
	const ws = new Workspace(root);
	const started = await ws.startRun("M01", []);
	const stale = await ws.readRun("M01", started.runId);
	const failed = await ws.finishRunIfRunning("M01", started.runId, "failed", current => {
		current.failures.push("host-shutdown");
		return current;
	});
	assert.equal(failed?.status, "failed");
	await assert.rejects(ws.writeRun(stale), /不能覆盖为 running/);
	await assert.rejects(ws.finishRun(stale, "completed"), /已经结束/);
	const persisted = await ws.readRun("M01", started.runId);
	assert.equal(persisted.status, "failed");
	assert.deepEqual(persisted.failures, ["host-shutdown"]);
});

test("corrupt persisted run state is never treated as a fresh record by a late writer", async () => {
	const root = await mkdtemp(path.join(tmpdir(), "pre-rsi-corrupt-run-"));
	const ws = new Workspace(root);
	const started = await ws.startRun("M01", []);
	const file = path.join(ws.runDir("M01", started.runId), "run.json");
	await writeFile(file, "{broken");
	await assert.rejects(ws.writeRun(started), SyntaxError);
	await assert.rejects(ws.finishRun(started, "completed"), SyntaxError);
	assert.equal(await readFile(file, "utf8"), "{broken");
	await writeFile(file, "");
	await assert.rejects(ws.writeRun(started), SyntaxError);
	await assert.rejects(ws.finishRun(started, "completed"), SyntaxError);
	assert.equal(await readFile(file, "utf8"), "");
});

test("symlink aliases of one run share a single terminal transition", async t => {
	const root = await mkdtemp(path.join(tmpdir(), "pre-rsi-alias-source-"));
	const aliasParent = await mkdtemp(path.join(tmpdir(), "pre-rsi-alias-parent-"));
	const alias = path.join(aliasParent, "workspace-link");
	await symlink(root, alias, "dir");
	t.after(async () => { await rm(aliasParent, { recursive: true, force: true }); });
	const direct = new Workspace(root), throughAlias = new Workspace(alias);
	const started = await direct.startRun("M01", []);
	const [failed, completed] = await Promise.all([
		direct.finishRunIfRunning("M01", started.runId, "failed", old => {
			old.failures.push("host-shutdown");
			return old;
		}),
		throughAlias.finishRunIfRunning("M01", started.runId, "completed", old => old),
	]);
	assert.equal(Number(Boolean(failed)) + Number(Boolean(completed)), 1,
		"aliases must not each win a terminal transition for one physical run");
	const persisted = await direct.readRun("M01", started.runId);
	assert.equal(persisted.status, failed ? "failed" : "completed");
});
