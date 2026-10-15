import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { linkedEvidence, openBoundedSession } from "../src/context/boundary.ts";
import { FakeSessionRunner } from "../src/runner/fake.ts";
import type { SessionSpec } from "../src/runner/types.ts";
import type { StageRunRecord } from "../src/types.ts";

function record(): StageRunRecord {
	return { stage: "M01", runId: "R001", startedAt: new Date().toISOString(), status: "running", inputs: [], outputs: [], sessions: [], failures: [], remarks: [] };
}

test("fresh and continue route through the runner and persist explicit boundary reasons", async () => {
	const dir = await mkdtemp(path.join(os.tmpdir(), "mul-pis-boundary-"));
	const runner = new FakeSessionRunner(() => "answer");
	const spec: SessionSpec = { label: "actor", role: "execution", model: "fake/model", systemPrompt: "Act on given data.", tools: { kind: "none" }, persistDir: dir };
	const run = record();
	const evidence = linkedEvidence([{ label: "problem", path: path.join(dir, "problem.txt") }]);
	const persist = async () => { await writeFile(path.join(dir, "run.json"), JSON.stringify(run)); };
	const first = await openBoundedSession(runner, run, { mode: "fresh", intent: "new-work", reason: "Independent initial answer", evidence, spec }, persist);
	assert.equal(JSON.parse(await readFile(path.join(dir, "run.json"), "utf8")).sessions[0].boundary.mode, "fresh", "the receipt is durable before the prompt");
	await first.prompt("first");
	first.dispose();
	const resumed = await openBoundedSession(runner, run, { mode: "continue", intent: "causal-continuation", reason: "Same actor answers a follow-up", evidence, parent: first.ref, expectedToolGrantKind: "none" }, persist);
	await resumed.prompt("follow-up");
	resumed.dispose();
	assert.equal(runner.created.length, 1);
	assert.equal(runner.resumed.length, 1);
	assert.deepEqual(run.sessions.map((entry) => entry.boundary?.mode), ["fresh", "continue"]);
	assert.equal(run.sessions[1].boundary?.parent?.sessionId, first.ref.id);
	assert.equal(run.sessions[1].boundary?.reason, "Same actor answers a follow-up");
	assert.deepEqual(run.sessions[1].boundary?.capability, { kind: "none" });
	assert.deepEqual(evidence, [{ version: 1, label: "problem", path: path.join(dir, "problem.txt"), status: "linked" }]);
});

test("a continue operation rejects a different session returned under the same role and model", async () => {
	const dir = await mkdtemp(path.join(os.tmpdir(), "mul-pis-boundary-"));
	const runner = new FakeSessionRunner(() => "answer");
	const spec: SessionSpec = { label: "actor", role: "execution", model: "fake/model", systemPrompt: "Act.", tools: { kind: "none" }, persistDir: dir };
	const run = record();
	const first = await openBoundedSession(runner, run, { mode: "fresh", intent: "new-work", reason: "initial", evidence: [], spec }, async () => {});
	first.dispose();
	runner.resume = async () => runner.create(spec);
	await assert.rejects(openBoundedSession(runner, run, { mode: "continue", intent: "causal-continuation", reason: "must be same session", evidence: [], parent: first.ref, expectedToolGrantKind: "none" }, async () => {}), /exact persisted parent/);
	assert.equal(run.sessions.length, 1);
});
