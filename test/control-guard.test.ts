import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { ResearchService } from "../src/pi/service.ts";
import { stageFingerprint } from "../src/pi/retry-guard.ts";
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

test("M04 retry identity distinguishes frozen checkpoints of the same active M07 goal", () => {
	const request = { stage: "M04" as const, feedbackStage: "M07" as const, feedbackRunId: "g1", feedbackCheckpointId: "C001", freshSession: true };
	const first = stageFingerprint(request);
	assert.equal(first, stageFingerprint({ ...request }), "the same checkpoint remains the same correction obligation");
	assert.notEqual(first, stageFingerprint({ ...request, feedbackCheckpointId: "C002" }), "a later frozen evidence batch may be retried independently");
	assert.notEqual(first, stageFingerprint({ ...request, requiredM07ReadPaths: ["evidence/tasks/T001/review-snapshot/lesson-delta.json"] }),
		"requiring full source evidence changes the M04 correction obligation");
});

test("normal shutdown marks only the owned active run failed and late completion cannot overwrite it", async () => {
	const root = await mkdtemp(path.join(tmpdir(), "pre-rsi-interrupt-"));
	await mkdir(path.join(root, "problem", "raw"), { recursive: true });
	await writeFile(path.join(root, "problem", "problem.md"), "problem\n");
	await writeFile(path.join(root, "research.config.json"), `${JSON.stringify({ roles: { execution: "fake/model" }, concurrency: 1 })}\n`);
	let release!: () => void;
	let promptStarted!: () => void;
	const blocked = new Promise<void>((resolve) => { release = resolve; });
	// Shutdown must race only the terminal write, never a session-boundary write
	// that is still legitimately recording a running run.
	const prompting = new Promise<void>((resolve) => { promptStarted = resolve; });
	const service = new ResearchService({ defaultWorkspace: path.join(root, "different-pi-cwd"), runnerFactory: () => new FakeSessionRunner(async () => { promptStarted(); await blocked; return "late answer"; }) });
	await service.init(root);
	const pending = service.runStage({ stage: "M01", workspace: root });
	await prompting;
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

test("a still-running write during shutdown reports the shutdown, not a revived record", async () => {
	const root = await mkdtemp(path.join(tmpdir(), "pre-rsi-shutdown-write-"));
	await mkdir(path.join(root, "problem", "raw"), { recursive: true });
	await writeFile(path.join(root, "problem", "problem.md"), "problem\n");
	await writeFile(path.join(root, "research.config.json"), `${JSON.stringify({ roles: { execution: "fake/model" }, concurrency: 1 })}\n`);
	let shutdownDone!: () => void;
	const shutdown = new Promise<void>((resolve) => { shutdownDone = resolve; });
	let service!: ResearchService;
	// The session boundary receipt is written while the run is still running. If
	// shutdown already owns the operation, that write must fail as a shutdown.
	service = new ResearchService({ defaultWorkspace: root, runnerFactory: () => new FakeSessionRunner(async () => {
		await service.interruptAllActive("test shutdown");
		shutdownDone();
		return "answer after shutdown";
	}) });
	await service.init(root);
	await assert.rejects(service.runStage({ stage: "M01", workspace: root }), /shutting down|不能覆盖为/);
	await shutdown;
	const ws = new Workspace(root);
	const records = await Promise.all((await ws.listRuns("M01")).map((runId) => ws.readRun("M01", runId)));
	assert.equal(records.length, 1);
	assert.equal(records[0].status, "failed");
	assert.match(records[0].failures.join("\n"), /host-shutdown/);
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
