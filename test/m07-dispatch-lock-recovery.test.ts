import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { createFileKnowledgeStore } from "../src/knowledge/store.ts";
import { createM07Controller, recoverM07DispatchLock } from "../src/m07/controller.ts";
import { FakeSessionRunner } from "../src/runner/fake.ts";
import type { ProcessIdentityV1, ProcessProbe } from "../src/runtime/process-identity.ts";
import type { StageContext } from "../src/stages/context.ts";
import { Workspace } from "../src/workspace.ts";

const current: ProcessIdentityV1 = { hostId: "test-host", bootId: "test-boot", pid: 9002,
	processStartToken: "22" };
const departed: ProcessIdentityV1 = { ...current, pid: 9001, processStartToken: "11" };
const dead = async (): Promise<ProcessProbe> =>
	({ status: "dead", identityMatch: false, reason: "absent" });
const lockBytes = (runId: string, owner = departed) =>
	`${JSON.stringify({ version: 1, kind: "m07-goal-dispatch-lock", goalRunId: runId, owner })}\n`;

async function fixture(t: TestContext, prompt?: () => Promise<string>) {
	const root = await mkdtemp(path.join(os.tmpdir(), "m07-dispatch-lock-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const ws = new Workspace(root);
	await mkdir(path.dirname(ws.problemFile), { recursive: true });
	await writeFile(ws.problemFile, "Fixed question\n");
	const store = createFileKnowledgeStore(ws.knowledgeDir);
	await store.init();
	const ctx: StageContext = { ws, store,
		runner: new FakeSessionRunner(async () => {
			if (!prompt) throw new Error("lock tests must not start a model");
			return prompt();
		}),
		config: { roles: { execution: "fake/execution" }, concurrency: 1, tools: {} } };
	const controller = createM07Controller(ctx, { processIdentity: async () => current });
	const goal = await controller.begin({ goal: "Check a fixed question", problemRelation: "Test fixture",
		constraints: ["Keep the question fixed"], successCriteria: ["Check it"],
		plan: "Original plan", exploratory: true });
	const dir = ws.runDir("M07", goal.runId);
	const file = path.join(dir, ".delegate-lock");
	return { ws, controller, goal, dir, file };
}


test("an orphan preparation cannot seize a goal; a published dead owner needs explicit recovery", async t => {
	const f = await fixture(t);
	await writeFile(path.join(f.dir, ".delegate-lock.prepare-crashed"), "partial", { mode: 0o600 });
	await f.controller.plan(f.goal.runId, "First plan");
	assert.equal((await readdir(f.dir)).includes(".delegate-lock"), false);
	await writeFile(f.file, lockBytes(f.goal.runId), { mode: 0o600 });
	await assert.rejects(f.controller.plan(f.goal.runId, "Must remain blocked"), /dispatch|another process/i);
	assert.equal((await f.controller.status(f.goal.runId)).plan, "First plan");
	await recoverM07DispatchLock({ ws: f.ws, runId: f.goal.runId, expectedOwner: departed,
		currentIdentity: async () => current, probePrior: dead });
	assert.equal((await readdir(f.dir)).includes(".delegate-lock"), false);
	await f.controller.plan(f.goal.runId, "After exact lock recovery");
	assert.equal((await f.controller.status(f.goal.runId)).plan, "After exact lock recovery");
});
