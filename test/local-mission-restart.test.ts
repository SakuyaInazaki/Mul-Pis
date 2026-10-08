import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openDefaultLocalMission } from "../src/m07/local-mission.ts";
import { LocalMissionHost } from "../src/runner/local-mission-host.ts";
import { FakeSessionRunner } from "../src/runner/fake.ts";
import { runInit } from "../src/stages/init.ts";
import { createFileKnowledgeStore } from "../src/knowledge/store.ts";
import { Workspace } from "../src/workspace.ts";

test("a new local process reopens a clean original objective before any model work", async t => {
	const root = await mkdtemp(path.join(os.tmpdir(), "local-mission-process-restart-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const ws = new Workspace(root);
	await mkdir(path.dirname(ws.problemFile), { recursive: true });
	await writeFile(ws.problemFile, "Synthetic original task remains open\n");
	await runInit(ws, createFileKnowledgeStore(ws.knowledgeDir));
	await writeFile(ws.configFile, JSON.stringify({ roles: { research: "fake/research",
		execution: "fake/execution" }, concurrency: 1 }));
	const request = path.join(root, "original.json");
	await writeFile(request, JSON.stringify({ version: 1,
		kind: "local-original-objective-request", goal: "Resolve the synthetic task",
		goalSource: "verbatim-private-input", obligations: [{ id: "answer",
			description: "Provide verified evidence for the synthetic task" }],
		closure: "open-ended" }));
	const started = spawnSync(process.execPath, ["src/cli.ts", "mission", "start", "--workspace",
		root, "--runner", "fake", "--original", request], { cwd: path.resolve("."),
		encoding: "utf8", timeout: 30_000 });
	assert.equal(started.status, 0, started.stderr);
	const missionId = (JSON.parse(started.stdout) as { missionId: string }).missionId;
	const missionRoot = path.join(ws.agentDir, "missions", missionId);
	assert.equal((await LocalMissionHost.status(missionRoot)).currentAttempt?.attemptId, "A001");
	let prompts = 0;
	const runner = new FakeSessionRunner(() => { prompts++; return "Synthetic malformed assessor response"; });
	const mission = openDefaultLocalMission({ workspaceRoot: root, runner,
		config: await ws.loadConfig() });
	const result = await mission.step(missionId);
	assert(prompts > 0, "a clean cross-process boundary admits the fresh read-only assessor");
	assert.equal(result.objectiveOutcome, "incomplete");
	const status = await LocalMissionHost.status(missionRoot);
	assert.equal(status.currentAttempt?.attemptId, "A002");
	assert.deepEqual(status.interruptedAttemptIds, ["A001"]);
	assert.deepEqual(status.unresolvedOperationIds, []);
});
