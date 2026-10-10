import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
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
const departedReaper: ProcessIdentityV1 = { ...current, pid: 9003, processStartToken: "33" };
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

async function seedPendingClaim(f: Awaited<ReturnType<typeof fixture>>,
	owner = departedReaper): Promise<void> {
	const info = await stat(f.file);
	const claim = path.join(f.dir, ".delegate-recovery-claims", "C000001");
	await mkdir(claim, { recursive: true, mode: 0o700 });
	await writeFile(path.join(claim, "owner.json"), `${JSON.stringify({ version: 1,
		kind: "m07-dispatch-recovery-claim", goalRunId: f.goal.runId, sequence: 1,
		owner, target: { dev: info.dev, ino: info.ino, owner: departed } })}\n`,
		{ mode: 0o600 });
}

test("an active dispatch publishes complete owner bytes before entering its body", async t => {
	let entered!: () => void;
	let release!: () => void;
	const inPrompt = new Promise<void>(resolve => { entered = resolve; });
	const allowReturn = new Promise<void>(resolve => { release = resolve; });
	const f = await fixture(t, async () => { entered(); await allowReturn; return "bounded report"; });
	const task = f.controller.delegate(f.goal.runId, { objective: "Read the fixed question",
		inputs: [], expectedOutputs: [], checks: ["Question read"], mode: "reason" });
	await inPrompt;
	assert.equal(await readFile(f.file, "utf8"), lockBytes(f.goal.runId, current));
	assert.equal((await stat(f.file)).mode & 0o777, 0o600);
	await assert.rejects(recoverM07DispatchLock({ ws: f.ws, runId: f.goal.runId,
		expectedOwner: current, currentIdentity: async () => current,
		probePrior: async () => ({ status: "alive", identityMatch: true, reason: "live" }) }),
		/live, reused, or uncertain/);
	release();
	assert.equal((await task).status, "returned");
	assert.equal((await readdir(f.dir)).includes(".delegate-lock"), false);
});

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

test("two reapers cannot both claim one dead lock", async t => {
	const f = await fixture(t);
	await writeFile(f.file, lockBytes(f.goal.runId), { mode: 0o600 });
	let entered!: () => void;
	let release!: () => void;
	const insideProbe = new Promise<void>(resolve => { entered = resolve; });
	const allowProbe = new Promise<void>(resolve => { release = resolve; });
	const first = recoverM07DispatchLock({ ws: f.ws, runId: f.goal.runId,
		expectedOwner: departed, currentIdentity: async () => current,
		probePrior: async () => { entered(); await allowProbe; return dead(); } });
	await insideProbe;
	await assert.rejects(recoverM07DispatchLock({ ws: f.ws, runId: f.goal.runId,
		expectedOwner: departed, currentIdentity: async () => current,
		probePrior: async owner => owner.pid === current.pid ?
			{ status: "alive", identityMatch: true, reason: "active reaper" } : dead() }),
		/recovery claimer is live/);
	assert.equal(await readFile(f.file, "utf8"), lockBytes(f.goal.runId));
	release();
	await first;
});

test("a dead recovery claimer is succeeded after crash at claim publication or lock removal", async t => {
	for (const removed of [false, true]) {
		const f = await fixture(t);
		await writeFile(f.file, lockBytes(f.goal.runId), { mode: 0o600 });
		await seedPendingClaim(f);
		if (removed) await rm(f.file);
		await recoverM07DispatchLock({ ws: f.ws, runId: f.goal.runId,
			expectedOwner: departed, currentIdentity: async () => current,
			probePrior: dead });
		const claims = path.join(f.dir, ".delegate-recovery-claims");
		assert.equal((await readdir(claims)).filter(name => /^C\d+$/.test(name)).length, 2);
		const terminal = JSON.parse(await readFile(path.join(claims, "C000002", "terminal.json"), "utf8"));
		assert.equal(terminal.result, "released");
		await recoverM07DispatchLock({ ws: f.ws, runId: f.goal.runId,
			expectedOwner: departed, currentIdentity: async () => current,
			probePrior: dead });
		assert.equal((await readdir(claims)).filter(name => /^C\d+$/.test(name)).length, 2,
			"an exact retry reads the terminal instead of publishing another claim");
		await f.controller.plan(f.goal.runId, "Work after recovered claim");
	}
});

test("a third owner can recover the proved dead second owner's dispatch lock", async t => {
	const f = await fixture(t);
	const third: ProcessIdentityV1 = { ...current, pid: 9004, processStartToken: "44" };
	await writeFile(f.file, lockBytes(f.goal.runId, departedReaper), { mode: 0o600 });
	await assert.rejects(recoverM07DispatchLock({ ws: f.ws, runId: f.goal.runId,
		expectedOwner: departed, currentIdentity: async () => third, probePrior: dead }),
		/expected attempt/);
	assert.equal(await readFile(f.file, "utf8"), lockBytes(f.goal.runId, departedReaper));
	await recoverM07DispatchLock({ ws: f.ws, runId: f.goal.runId,
		expectedOwner: departed, verifiedRecoveryOwners: [departedReaper],
		currentIdentity: async () => third, probePrior: dead });
	assert.equal((await readdir(f.dir)).includes(".delegate-lock"), false);
	const claim = JSON.parse(await readFile(path.join(f.dir,
		".delegate-recovery-claims", "C000001", "owner.json"), "utf8"));
	assert.deepEqual(claim.target.owner, departedReaper);
});

test("an unpublished recovery preparation is inert while a malformed published claim holds", async t => {
	const f = await fixture(t);
	const claims = path.join(f.dir, ".delegate-recovery-claims");
	const orphan = path.join(claims, ".prepare-11111111-1111-1111-1111-111111111111");
	await mkdir(orphan, { recursive: true, mode: 0o700 });
	await writeFile(path.join(orphan, "owner.json"), "partial", { mode: 0o600 });
	await f.controller.plan(f.goal.runId, "Unpublished claim cannot hold the goal");
	await mkdir(path.join(claims, "C000001"), { mode: 0o700 });
	await assert.rejects(f.controller.plan(f.goal.runId, "Malformed published claim holds"),
		/recovery claim owner is missing/);
});

test("live, reused and unknown recovery claimers cannot be succeeded", async t => {
	for (const observation of [
		{ status: "alive", identityMatch: true, reason: "live" },
		{ status: "unknown", identityMatch: false, reason: "pid reused" },
		{ status: "unknown", identityMatch: false, reason: "probe unavailable" },
	] as ProcessProbe[]) {
		const f = await fixture(t);
		await writeFile(f.file, lockBytes(f.goal.runId), { mode: 0o600 });
		await seedPendingClaim(f);
		await assert.rejects(recoverM07DispatchLock({ ws: f.ws, runId: f.goal.runId,
			expectedOwner: departed, currentIdentity: async () => current,
			probePrior: async owner => owner.pid === departedReaper.pid ? observation : dead() }),
			/recovery claimer is live, reused, or uncertain/);
		assert.equal(await readFile(f.file, "utf8"), lockBytes(f.goal.runId));
		assert.deepEqual((await readdir(path.join(f.dir, ".delegate-recovery-claims")))
			.filter(name => /^C\d+$/.test(name)), ["C000001"]);
	}
});

test("live, reused, unknown, changed and foreign owners remain locked", async t => {
	const f = await fixture(t);
	for (const probe of [
		{ status: "alive", identityMatch: true, reason: "live" },
		{ status: "unknown", identityMatch: false, reason: "reused pid" },
		{ status: "unknown", identityMatch: false, reason: "cannot inspect" },
	] as ProcessProbe[]) {
		await writeFile(f.file, lockBytes(f.goal.runId), { flag: "wx", mode: 0o600 });
		await assert.rejects(recoverM07DispatchLock({ ws: f.ws, runId: f.goal.runId,
			expectedOwner: departed, currentIdentity: async () => current,
			probePrior: async () => probe }), /live, reused, or uncertain/);
		assert.equal(await readFile(f.file, "utf8"), lockBytes(f.goal.runId));
		await rm(f.file);
	}
	await writeFile(f.file, lockBytes(f.goal.runId), { mode: 0o600 });
	await assert.rejects(recoverM07DispatchLock({ ws: f.ws, runId: f.goal.runId,
		expectedOwner: departed, currentIdentity: async () => ({ ...current, bootId: "other-boot" }),
		probePrior: dead }), /another host or boot/);
	await assert.rejects(recoverM07DispatchLock({ ws: f.ws, runId: f.goal.runId,
		expectedOwner: { ...departed, processStartToken: "wrong" },
		currentIdentity: async () => current, probePrior: dead }), /expected attempt/);
	await assert.rejects(recoverM07DispatchLock({ ws: f.ws, runId: "unrelated-run",
		expectedOwner: departed, currentIdentity: async () => current, probePrior: dead }));
	assert.equal(await readFile(f.file, "utf8"), lockBytes(f.goal.runId));
});

test("malformed legacy lock and live recovery claim fail closed", async t => {
	const f = await fixture(t);
	await mkdir(f.file);
	await assert.rejects(recoverM07DispatchLock({ ws: f.ws, runId: f.goal.runId,
		expectedOwner: departed, currentIdentity: async () => current,
		probePrior: dead }), /legacy or malformed/);
	await assert.rejects(f.controller.plan(f.goal.runId, "No overwrite"), /another process/);
	await rm(f.file, { recursive: true });
	await writeFile(f.file, lockBytes(f.goal.runId), { mode: 0o600 });
	await seedPendingClaim(f, current);
	await assert.rejects(recoverM07DispatchLock({ ws: f.ws, runId: f.goal.runId,
		expectedOwner: departed, currentIdentity: async () => current,
		probePrior: async owner => owner.pid === current.pid ?
			{ status: "alive", identityMatch: true, reason: "active reaper" } : dead() }),
		/recovery claimer is live/);
	await assert.rejects(f.controller.plan(f.goal.runId, "No bypass"), /recovery is active/);
	assert.equal(await readFile(f.file, "utf8"), lockBytes(f.goal.runId));
});

test("inode or owner changes during proof prevent stale cleanup", async t => {
	const f = await fixture(t);
	await writeFile(f.file, lockBytes(f.goal.runId), { mode: 0o600 });
	const replacement: ProcessIdentityV1 = { ...departed, pid: 9003, processStartToken: "33" };
	await assert.rejects(recoverM07DispatchLock({ ws: f.ws, runId: f.goal.runId,
		expectedOwner: departed, currentIdentity: async () => current,
		probePrior: async () => {
			await rm(f.file);
			await writeFile(f.file, lockBytes(f.goal.runId, replacement), { mode: 0o600 });
			return dead();
		} }), /changed during recovery/);
	assert.equal(await readFile(f.file, "utf8"), lockBytes(f.goal.runId, replacement));
});
