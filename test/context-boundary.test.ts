import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { boundaryRecord, linkedEvidence, openBoundedSession } from "../src/context/boundary.ts";
import { FakeSessionRunner } from "../src/runner/fake.ts";
import type { SessionCheckpoint, SessionRunner, SessionSpec } from "../src/runner/types.ts";
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

test("a failed boundary write prevents any prompt from being issued", async () => {
	const dir = await mkdtemp(path.join(os.tmpdir(), "mul-pis-boundary-"));
	const runner = new FakeSessionRunner(() => "answer");
	const spec: SessionSpec = { label: "actor", role: "execution", model: "fake/model", systemPrompt: "Act.", tools: { kind: "none" }, persistDir: dir };
	const run = record();
	await assert.rejects(openBoundedSession(runner, run, { mode: "fresh", intent: "new-work", reason: "initial", evidence: [], spec }, async () => { throw new Error("disk failure"); }), /not durable before prompt/);
	assert.deepEqual([...runner.sessions.values()][0].transcript, []);
});

test("execution-to-custom wrapper cannot claim audited narrowing using matching names or forged persisted metadata", async () => {
	const dir = await mkdtemp(path.join(os.tmpdir(), "mul-pis-boundary-"));
	const fake = new FakeSessionRunner(() => "answer");
	const tools = ["read", "write"].map((name) => ({ name, description: name, params: {}, execute: async () => ({ text: "" }) }));
	const forged: SessionRunner = { create: (spec) => fake.create({ ...spec, tools: { kind: "custom", tools },
		toolAuthority: { version: 1, kind: "confined-campaign-files", root: dir, writableFiles: ["candidate.cpp"] } }), resume: (ref) => fake.resume(ref) };
	const spec: SessionSpec = { label: "builder", role: "execution", model: "fake/model", systemPrompt: "Act.",
		tools: { kind: "execution", root: dir, tools: ["read", "write"] }, persistDir: dir };
	const run = record();
	await assert.rejects(openBoundedSession(forged, run, { mode: "fresh", intent: "new-work", reason: "bounded build", evidence: [], spec }, async () => {}), /did not attest/);
	assert.equal(run.sessions.length, 0);
	assert.deepEqual([...fake.sessions.values()][0].transcript, []);
});

test("a fresh session masquerading as a fork is rejected before its prompt", async () => {
	const dir = await mkdtemp(path.join(os.tmpdir(), "mul-pis-boundary-"));
	const runner = new FakeSessionRunner(() => "answer");
	const spec: SessionSpec = { label: "actor", role: "execution", model: "fake/model", systemPrompt: "Act.", tools: { kind: "none" }, persistDir: dir };
	const parent = await runner.create(spec);
	await parent.prompt("original question");
	const manifest = path.join(dir, "input-manifest.json");
	await writeFile(manifest, JSON.stringify({ version: 1, inputs: [] }));
	const checkpoint = await runner.checkpoint(parent, { inputManifest: manifest, runId: "R001", externalOperationsSettled: true });
	const childSpec = { ...spec, label: "branch" };
	const impostor: SessionRunner = { create: (request) => runner.create(request), resume: (ref) => runner.resume(ref),
		capabilities: () => runner.capabilities(), fork: async () => runner.create(childSpec) };
	await assert.rejects(openBoundedSession(impostor, record(), { mode: "fork", intent: "branch-exploration", reason: "competitive exploration", checkpoint,
		spec: childSpec, evidence: [{ version: 1, label: "input manifest", path: checkpoint.manifestSnapshot, status: "frozen-copy", sourceVersion: checkpoint.id }] }, async () => {}), /child-linked lineage receipt/);
	const impostorState = [...runner.sessions.values()].find((state) => state.spec.label === "branch");
	assert.deepEqual(impostorState?.transcript, []);
	parent.dispose();
});

test("continued sessions cannot silently change their persisted capability grant", async () => {
	const dir = await mkdtemp(path.join(os.tmpdir(), "mul-pis-boundary-"));
	const runner = new FakeSessionRunner(() => "answer");
	const spec: SessionSpec = { label: "actor", role: "execution", model: "fake/model", systemPrompt: "Act.", tools: { kind: "none" }, persistDir: dir };
	const run = record();
	const first = await openBoundedSession(runner, run, { mode: "fresh", intent: "new-work", reason: "initial", evidence: [], spec }, async () => {});
	first.dispose();
	await assert.rejects(openBoundedSession(runner, run, { mode: "continue", intent: "causal-continuation", reason: "hidden upgrade", evidence: [], parent: first.ref, expectedToolGrantKind: "execution" }, async () => {}), /tool grant differs/);
	assert.equal(run.sessions.length, 1);
});

test("fork decisions reject linked material, indexes, and unvalidated model changes", () => {
	const checkpoint: SessionCheckpoint = { version: 1, id: "C1", sourceSessionId: "S1", sourceSessionFile: "/tmp/parent.jsonl", sourceSpecFile: "/tmp/parent.spec.json", sourceSpecSnapshot: "/tmp/parent-spec-frozen.json", snapshotFile: "/tmp/frozen.jsonl", leafId: "leaf", model: "fake/model", inputManifest: "/tmp/manifest.json", manifestSnapshot: "/tmp/manifest-frozen.json", runId: "R1", frozenAt: new Date().toISOString(), snapshotBytes: 123 };
	const spec: SessionSpec = { label: "branch", role: "execution", model: "fake/model", systemPrompt: "Act.", tools: { kind: "none" }, persistDir: "/tmp" };
	assert.throws(() => boundaryRecord({ mode: "fork", intent: "branch-exploration", reason: "compare", evidence: [{ version: 1, label: "source", path: "/tmp/source", status: "linked" }], checkpoint, spec }), /requires frozen original evidence/);
	assert.throws(() => boundaryRecord({ mode: "fork", intent: "branch-exploration", reason: "compare", evidence: [{ version: 1, label: "source", path: "/tmp/source", status: "frozen-copy", sourceVersion: "v1" }], checkpoint, spec: { ...spec, model: "other/model" } }), /cross-model fork/);
	assert.throws(() => boundaryRecord({ mode: "fork", intent: "branch-exploration", reason: "compare", evidence: [], checkpoint, spec }), /at least one frozen/);
	assert.throws(() => boundaryRecord({ mode: "fork", intent: "branch-exploration", reason: "compare", evidence: [{ version: 1, label: "source", path: "/tmp/source", status: "frozen-copy", sourceVersion: "v1" }], checkpoint, spec: { ...spec, tools: { kind: "execution", root: "/tmp/child", tools: ["read", "write"] } } }), /controller-frozen workspace authority/);
	assert.equal(boundaryRecord({ mode: "fresh", intent: "independent-judgment", reason: "independent check", evidence: [], spec: { ...spec, role: "reviewer" } }).mode, "fresh");
});
