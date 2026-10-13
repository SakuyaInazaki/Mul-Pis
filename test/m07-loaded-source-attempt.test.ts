import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { prepareWorkflowCodeSource } from "../scripts/prepare-workflow-source.ts";

async function writableDirectories(target: string): Promise<void> {
	const info = await lstat(target);
	if (!info.isDirectory()) return;
	await chmod(target, 0o700);
	for (const name of await readdir(target)) await writableDirectories(path.join(target, name));
}

test("M07 records the loaded commit per attempt and fresh recovery keeps frozen goal state", async t => {
	const root = await realpath(await mkdtemp(path.join(tmpdir(), "m07-source-attempt-")));
	const previousRoot = process.env.PRE_RSI_SOURCE_ROOT;
	const previousRevision = process.env.PRE_RSI_CODE_REVISION;
	t.after(async () => {
		if (previousRoot === undefined) delete process.env.PRE_RSI_SOURCE_ROOT; else process.env.PRE_RSI_SOURCE_ROOT = previousRoot;
		if (previousRevision === undefined) delete process.env.PRE_RSI_CODE_REVISION; else process.env.PRE_RSI_CODE_REVISION = previousRevision;
		await writableDirectories(root); await rm(root, { recursive: true, force: true });
	});
	const repo = path.join(root, "repo"), work = path.join(root, "work");
	await mkdir(repo); await mkdir(work);
	for (const dir of ["src", "extensions", "workflow", "tools"]) await cp(path.resolve(dir), path.join(repo, dir), { recursive: true });
	await cp(path.resolve("package.json"), path.join(repo, "package.json"));
	await symlink(await realpath("node_modules"), path.join(repo, "node_modules"), "dir");
	const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
	git("init", "-q"); git("config", "user.name", "Offline Fixture"); git("config", "user.email", "fixture@example.invalid");
	await writeFile(path.join(repo, "src/source-version-fixture.ts"), 'export const fixture = "A";\n');
	git("add", "src", "extensions", "workflow", "tools", "package.json"); git("commit", "-qm", "Fixture source A");
	const a = git("rev-parse", "HEAD");
	const sourceA = await prepareWorkflowCodeSource(repo, a, path.join(root, "source-A"));
	await writeFile(path.join(repo, "src/source-version-fixture.ts"), 'export const fixture = "B";\n');
	git("add", "src/source-version-fixture.ts"); git("commit", "-qm", "Fixture source B");
	const b = git("rev-parse", "HEAD");
	const sourceB = await prepareWorkflowCodeSource(repo, b, path.join(root, "source-B"));
	const load = async (sourceRoot: string, relative: string) => import(pathToFileURL(path.join(sourceRoot, relative)).href);
	const [aWorkspace, aStore, aController, aFake] = await Promise.all([
		load(sourceA.sourceRoot, "src/workspace.ts"), load(sourceA.sourceRoot, "src/knowledge/store.ts"),
		load(sourceA.sourceRoot, "src/m07/controller.ts"), load(sourceA.sourceRoot, "src/runner/fake.ts"),
	]);
	const wsA = new aWorkspace.Workspace(work);
	await mkdir(path.dirname(wsA.problemFile), { recursive: true });
	await writeFile(wsA.problemFile, "Bounded offline question\n");
	const storeA = aStore.createFileKnowledgeStore(wsA.knowledgeDir); await storeA.init();
	const config = { roles: { execution: "fake/execution", reviewer: "fake/reviewer", research: "fake/research" }, concurrency: 1, tools: {} };
	const oldProcess = { hostId: "fixture-host", bootId: "fixture-boot", pid: 41001, processStartToken: "birth-A" };
	process.env.PRE_RSI_SOURCE_ROOT = sourceA.sourceRoot; process.env.PRE_RSI_CODE_REVISION = a;
	const controllerA = aController.createM07Controller({ ws: wsA, store: storeA, runner: new aFake.FakeSessionRunner(() => "unused"), config },
		{ processIdentity: async () => oldProcess });
	const goal = await controllerA.begin({ goal: "Check one mechanism", problemRelation: "Direct test", constraints: ["Keep the question"],
		successCriteria: ["Record checked evidence"], plan: "Collect then check", exploratory: true });
	const old = goal.executionState!.attempts[0].runDescriptor;
	assert.equal(old.codeRevision, a);
	assert.deepEqual(old.loadedSource, { sourceRoot: sourceA.sourceRoot, sourceCommit: a });
	const persistedA = JSON.parse(await readFile(path.join(wsA.runDir("M07", goal.runId), "goal.json"), "utf8"));
	assert.deepEqual(persistedA.executionState.attempts[0].runDescriptor.loadedSource, old.loadedSource);

	const [bWorkspace, bStore, bController, bFake] = await Promise.all([
		load(sourceB.sourceRoot, "src/workspace.ts"), load(sourceB.sourceRoot, "src/knowledge/store.ts"),
		load(sourceB.sourceRoot, "src/m07/controller.ts"), load(sourceB.sourceRoot, "src/runner/fake.ts"),
	]);
	const wsB = new bWorkspace.Workspace(work);
	const storeB = bStore.createFileKnowledgeStore(wsB.knowledgeDir);
	process.env.PRE_RSI_SOURCE_ROOT = sourceB.sourceRoot; process.env.PRE_RSI_CODE_REVISION = b;
	const newProcess = { ...oldProcess, pid: 41002, processStartToken: "birth-B" };
	const runnerB = new bFake.FakeSessionRunner(() => "offline returned report");
	const controllerB = bController.createM07Controller({ ws: wsB, store: storeB, runner: runnerB, config },
		{ probeProcess: async (identity: typeof oldProcess) => identity.pid === oldProcess.pid ?
			{ status: "dead", identityMatch: false, reason: "old host exited" } :
			{ status: "alive", identityMatch: true, reason: "new host running" } });
	const task = { objective: "Offline check", inputs: [], expectedOutputs: [], checks: ["Record observation"], mode: "reason" as const };
	await assert.rejects(controllerB.delegate(goal.runId, task), /当前加载的工作流源码与运行中 attempt 不一致/);
	await assert.rejects(controllerB.review(goal.runId, { taskId: "T999", checks: [], artifacts: [] }), /当前加载的工作流源码与运行中 attempt 不一致/);
	assert.equal(runnerB.sessions.size, 0);
	assert.equal((await controllerB.status(goal.runId)).tasks.length, 0);
	const next = { ...old, instanceId: "new-instance", attemptId: "A002", codeRevision: b,
		loadedSource: { sourceRoot: sourceB.sourceRoot, sourceCommit: b }, process: newProcess };
	await assert.rejects(controllerB.hostRecover(goal.runId, { expectedAttemptId: "A001", runDescriptor: { ...next, codeRevision: a,
		loadedSource: old.loadedSource } }), /source claim differs|loaded source invalid/);
	const recovered = await controllerB.hostRecover(goal.runId, { expectedAttemptId: "A001", runDescriptor: next });
	assert.equal(recovered.executionState?.activeAttemptId, "A002");
	assert.equal(recovered.executionState?.attempts[0].runDescriptor.loadedSource?.sourceCommit, a);
	assert.equal(recovered.executionState?.attempts[1].runDescriptor.loadedSource?.sourceCommit, b);
	assert.deepEqual(recovered.successCriteria, goal.successCriteria);
	assert.equal(recovered.knowledgeSnapshot, goal.knowledgeSnapshot);
	assert.deepEqual(recovered.methodBinding, goal.methodBinding);
	const delegated = await controllerB.delegate(goal.runId, task);
	assert.equal(delegated.status, "returned");
	assert.equal(runnerB.sessions.size, 1);
	await assert.rejects(controllerB.review(goal.runId, { taskId: "T999", checks: [], artifacts: [] }), /未知任务 T999/);
	const persistedB = JSON.parse(await readFile(path.join(wsB.runDir("M07", goal.runId), "goal.json"), "utf8"));
	assert.deepEqual(persistedB.executionState.attempts.map((attempt: { runDescriptor: { codeRevision: string } }) => attempt.runDescriptor.codeRevision), [a, b]);
	assert.equal(persistedB.tasks.length, 1);
});
