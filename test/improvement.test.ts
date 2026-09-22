import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { ImprovementService } from "../src/improvement/service.ts";
import { DEFAULT_BUDGET_POLICY, loadActiveBudgetPolicy, validateBudgetPolicy } from "../src/improvement/policy.ts";
import { FakeSessionRunner, type FakeReplyContext } from "../src/runner/fake.ts";
import { Workspace } from "../src/workspace.ts";

async function fixture(t: TestContext, reply: (ctx: FakeReplyContext) => string | Promise<string>) {
	const root = await mkdtemp(path.join(os.tmpdir(), "pre-rsi-improvement-"));
	t.after(async () => rm(root, { recursive: true, force: true }));
	const ws = new Workspace(root);
	await mkdir(path.join(root, "problem"), { recursive: true });
	await mkdir(ws.sessionsDir, { recursive: true });
	await writeFile(ws.problemFile, "PRIVATE-PROBLEM-CONTENT\n");
	await writeFile(ws.configFile, `${JSON.stringify({ roles: { improver: "fake/user-chosen-improver" }, concurrency: 1 })}\n`);
	const inputs: Array<{ label: string; path: string }> = [];
	for (const [index, size] of [10_000, 20_000, 30_000, 40_000, 50_000].entries()) {
		const input = path.join(root, `private-input-${index}.txt`);
		await writeFile(input, `${index === 0 ? "SENSITIVE-MARKER\n" : ""}${"x".repeat(size)}`);
		inputs.push({ label: "secret", path: input });
	}
	const run = await ws.startRun("M07", inputs);
	run.failures.push("context length exceeded: SECRET-DETAIL");
	await ws.finishRun(run, "failed");
	const runner = new FakeSessionRunner(reply);
	return { root, ws, runner, service: new ImprovementService({ workspaceRoot: root, runner, now: () => new Date("2026-09-23T00:00:00.000Z") }) };
}

const candidate = { version: 1, maxPromptChars: 180_000, maxInlineFileChars: 35_000, maxAggregateInlineChars: 100_000, maxFeedbackChars: 140_000, overflowMode: "manifest-and-defer" } as const;

test("budget improvement freezes anonymous protocol, evaluates a real replay, and promotes atomically", async (t) => {
	const f = await fixture(t, (ctx) => {
		assert.equal(ctx.spec.role, "improver");
		assert.equal(ctx.spec.model, "fake/user-chosen-improver");
		assert.deepEqual(ctx.spec.tools, { kind: "none" });
		assert.doesNotMatch(ctx.message, /PRIVATE|SENSITIVE|SECRET-DETAIL|private-input/);
		return JSON.stringify(candidate);
	});
	const result = await f.service.run();
	assert.equal(result.run.status, "promoted");
	assert.equal(result.evaluation?.passed, true);
	assert.ok((result.evaluation?.reductionRatio ?? 0) >= 0.1);
	assert.deepEqual(await loadActiveBudgetPolicy(f.root), candidate);
	const protocol = JSON.parse(await readFile(result.run.protocolPath, "utf8")) as { samples: Array<{ inputChars: number; failureClasses: string[] }> };
	assert.equal(protocol.samples[0].inputChars, 150_017);
	assert.deepEqual(protocol.samples[0].failureClasses, ["size-or-context-limit"]);
	const receipt = JSON.parse(await readFile(result.run.promotionReceiptPath!, "utf8")) as { state: string; activePointerIsAuthority: boolean };
	assert.deepEqual(receipt, { ...receipt, state: "active", activePointerIsAuthority: true });
});

test("failed paired gates retain the candidate and do not switch active policy", async (t) => {
	const f = await fixture(t, () => JSON.stringify(DEFAULT_BUDGET_POLICY));
	const result = await f.service.run();
	assert.equal(result.run.status, "rejected");
	assert.equal(result.evaluation?.passed, false);
	assert.ok(result.run.candidatePath);
	assert.ok(result.run.evaluationPath);
	assert.deepEqual(await loadActiveBudgetPolicy(f.root), DEFAULT_BUDGET_POLICY);
	assert.equal((await f.service.status()).activeVersionId, undefined);
});

test("unreplayed prompt and feedback caps cannot win by being lowered", async (t) => {
	const unsupported = { ...candidate, maxPromptChars: 100_000, maxFeedbackChars: 4_000 };
	const f = await fixture(t, () => JSON.stringify(unsupported));
	const result = await f.service.run();
	assert.equal(result.run.status, "rejected");
	assert.equal(result.evaluation?.gates.find((gate) => gate.name === "unreplayed-caps-frozen")?.passed, false);
	assert.deepEqual(await loadActiveBudgetPolicy(f.root), DEFAULT_BUDGET_POLICY);
	assert.equal((await f.service.status()).activeVersionId, undefined);
});

test("a second generation cannot cross the absolute inline coverage floor", async (t) => {
	const f = await fixture(t, () => JSON.stringify(candidate));
	assert.equal((await f.service.run()).run.status, "promoted");
	const tooDeferred = { ...candidate, maxInlineFileChars: 25_000 };
	const second = new ImprovementService({ workspaceRoot: f.root, runner: new FakeSessionRunner(() => JSON.stringify(tooDeferred)) });
	const result = await second.run();
	assert.equal(result.run.status, "rejected");
	assert.equal(result.evaluation?.gates.find((gate) => gate.name === "measurable-reduction")?.passed, true);
	assert.equal(result.evaluation?.gates.find((gate) => gate.name === "bounded-new-read-burden")?.passed, true);
	assert.equal(result.evaluation?.gates.find((gate) => gate.name === "absolute-inline-coverage")?.passed, false);
	assert.deepEqual(await loadActiveBudgetPolicy(f.root), candidate);
});

test("two concurrent services allow only one mutation and the rejected attempt cannot overwrite it", async (t) => {
	let release!: () => void;
	let entered!: () => void;
	const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
	const hold = new Promise<void>((resolve) => { release = resolve; });
	const f = await fixture(t, async () => { entered(); await hold; return JSON.stringify(candidate); });
	const first = f.service.run();
	await enteredPromise;
	const second = new ImprovementService({ workspaceRoot: f.root, runner: new FakeSessionRunner(() => JSON.stringify(DEFAULT_BUDGET_POLICY)) });
	await assert.rejects(second.run(), (error: unknown) => (error as { code?: string }).code === "improvement.busy" || (error as { code?: string }).code === "improvement.locked");
	release();
	assert.equal((await first).run.status, "promoted");
	assert.deepEqual(await loadActiveBudgetPolicy(f.root), candidate);
});

test("a residual cross-process lock fails closed with an exact recovery entry", async (t) => {
	const f = await fixture(t, () => JSON.stringify(candidate));
	const lock = path.join(f.root, ".agent", "improvement", "mutation.lock");
	await mkdir(lock, { recursive: true });
	await writeFile(path.join(lock, "owner.json"), JSON.stringify({ pid: 999999, acquiredAt: "unknown" }));
	await assert.rejects(f.service.run(), (error: unknown) => (error as { code?: string }).code === "improvement.locked" && /owner\.json/.test((error as Error).message));
	assert.equal((await f.service.status()).activeVersionId, undefined);
});

test("promotion compares the active pointer with its frozen baseline before commit", async (t) => {
	let workspaceRoot = "";
	const f = await fixture(t, async () => {
		const versionDir = path.join(workspaceRoot, ".agent", "improvement", "versions", "external-version");
		await mkdir(versionDir, { recursive: true });
		await writeFile(path.join(versionDir, "policy.json"), `${JSON.stringify(DEFAULT_BUDGET_POLICY)}\n`);
		await writeFile(path.join(workspaceRoot, ".agent", "improvement", "active.json"), `${JSON.stringify({ version: 1, versionId: "external-version", promotedAt: new Date().toISOString(), runId: "external-run" })}\n`);
		return JSON.stringify(candidate);
	});
	workspaceRoot = f.root;
	await assert.rejects(f.service.run(), (error: unknown) => (error as { code?: string }).code === "improvement.stale-baseline");
	assert.equal((await f.service.status()).activeVersionId, "external-version");
	assert.deepEqual(await loadActiveBudgetPolicy(f.root), DEFAULT_BUDGET_POLICY);
});

test("rollback only switches the active policy pointer", async (t) => {
	const f = await fixture(t, () => JSON.stringify(candidate));
	await f.service.run();
	const problemBefore = await readFile(f.ws.problemFile, "utf8");
	const pointer = await f.service.rollback();
	assert.equal(pointer.versionId, "builtin-default");
	assert.deepEqual(await loadActiveBudgetPolicy(f.root), DEFAULT_BUDGET_POLICY);
	assert.equal(await readFile(f.ws.problemFile, "utf8"), problemBefore);
});

test("active pointer remains authoritative if the final run record was not finalized", async (t) => {
	const f = await fixture(t, () => JSON.stringify(candidate));
	const result = await f.service.run();
	const runFile = path.join(path.dirname(result.run.protocolPath), "run.json");
	await writeFile(runFile, `${JSON.stringify({ ...result.run, status: "candidate-ready", finishedAt: undefined })}\n`);
	const visible = (await f.service.status()).runs.find((run) => run.runId === result.run.runId);
	assert.equal(visible?.status, "promoted");
	assert.ok(visible?.finishedAt);
});

test("policy validation is closed to unknown or incoherent fields", () => {
	assert.throws(() => validateBudgetPolicy({ ...DEFAULT_BUDGET_POLICY, evaluator: "replace" }), /未知字段/);
	assert.throws(() => validateBudgetPolicy({ ...DEFAULT_BUDGET_POLICY, maxInlineFileChars: DEFAULT_BUDGET_POLICY.maxAggregateInlineChars + 1 }), /不能大于/);
});

test("active pointer validation rejects traversal", async (t) => {
	const f = await fixture(t, () => JSON.stringify(candidate));
	const active = path.join(f.root, ".agent", "improvement", "active.json");
	await mkdir(path.dirname(active), { recursive: true });
	await writeFile(active, JSON.stringify({ version: 1, versionId: "../escape", promotedAt: new Date().toISOString(), runId: "x" }));
	await assert.rejects(loadActiveBudgetPolicy(f.root), /active\.json 字段无效/);
});
