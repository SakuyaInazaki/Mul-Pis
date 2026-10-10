import assert from "node:assert/strict";
import { appendFile, mkdtemp, open, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { appendPrivateAssessorDiagnostic } from "../src/runner/private-assessor-diagnostic.ts";

const input = (attempt: number, transcriptPath?: string) => ({ sessionId: "session-123",
	generation: 2, attempt, rawResponse: `private invalid response ${attempt}\n`,
	validation: { code: "m07.objective-assessment", message: "assessment fields are invalid",
		path: "groundedAssessment", detail: "invalid static schema branch" },
	coverage: [{ sourceId: "original-objective.json", required: true,
		coveredRanges: [[1, 2] as [number, number]], complete: false }], transcriptPath });

test("appends every raw invalid response and snapshots exact session bytes in private files", async t => {
	const root = await mkdtemp(path.join(tmpdir(), "assessor-diagnostic-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const transcript = path.join(root, "local-session.jsonl");
	const transcriptBytes = Buffer.from("{\"private\":\"transcript contents\"}\n", "utf8");
	await writeFile(transcript, transcriptBytes);
	const first = await appendPrivateAssessorDiagnostic(root, input(1, transcript));
	const second = await appendPrivateAssessorDiagnostic(root, { ...input(2, path.join(root, "missing.jsonl")),
		sessionId: "session-456" });
	assert.equal(first.diagnosticName, "assessor-diagnostic-000001.json");
	assert.equal(first.transcriptName, "assessor-transcript-000001.bin");
	assert.equal(first.transcriptStatus, "snapshotted");
	assert.equal(second.diagnosticName, "assessor-diagnostic-000002.json");
	assert.equal(second.transcriptStatus, "missing");
	assert.equal(second.transcriptName, undefined);
	assert.deepEqual(await readFile(path.join(root, first.transcriptName!)), transcriptBytes);
	const firstRecord = JSON.parse(await readFile(path.join(root, first.diagnosticName), "utf8"));
	const secondRecord = JSON.parse(await readFile(path.join(root, second.diagnosticName), "utf8"));
	assert.equal(firstRecord.rawResponse, input(1).rawResponse);
	assert.equal(firstRecord.attempt, 1);
	assert.deepEqual(firstRecord.validation, input(1).validation);
	assert.equal(firstRecord.transcript.name, first.transcriptName);
	assert.equal(secondRecord.rawResponse, input(2).rawResponse);
	assert.deepEqual(secondRecord.transcript, { status: "unavailable", reason: "missing" });
	for (const name of [first.diagnosticName, first.transcriptName!, second.diagnosticName])
		assert.equal((await stat(path.join(root, name))).mode & 0o777, 0o600);
	assert.equal((await stat(root)).mode & 0o777, 0o700);
});

test("later invalid turns retain raw replies while sharing one frozen session transcript", async t => {
	const root = await mkdtemp(path.join(tmpdir(), "assessor-diagnostic-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const transcript = path.join(root, "live-session.jsonl");
	await writeFile(transcript, "first private turn\n");
	const first = await appendPrivateAssessorDiagnostic(root, input(1, transcript));
	await appendFile(transcript, "second private turn\n");
	const second = await appendPrivateAssessorDiagnostic(root, input(2, transcript));
	assert.equal(first.transcriptStatus, "snapshotted");
	assert.equal(second.transcriptStatus, "previously-snapshotted");
	assert.equal(second.transcriptName, undefined);
	const stored = JSON.parse(await readFile(path.join(root, second.diagnosticName), "utf8"));
	assert.equal(stored.rawResponse, input(2).rawResponse);
	assert.deepEqual(stored.transcript, { status: "previously-snapshotted",
		name: first.transcriptName, scope: "first-rejected-turn" });
	assert.equal((await readdir(root)).filter(name => /^assessor-transcript-[0-9]+\.bin$/.test(name)).length, 1);
});

test("concurrent appends reserve distinct monotone slots without an attempt-count gate", async t => {
	const root = await mkdtemp(path.join(tmpdir(), "assessor-diagnostic-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const results = await Promise.all(Array.from({ length: 12 }, (_, n) =>
		appendPrivateAssessorDiagnostic(root, input(n + 1))));
	assert.equal(new Set(results.map(item => item.diagnosticName)).size, results.length);
	const records = await Promise.all(results.map(async item =>
		JSON.parse(await readFile(path.join(root, item.diagnosticName), "utf8"))));
	assert.deepEqual(records.map(item => item.attempt).sort((a, b) => a - b),
		Array.from({ length: 12 }, (_, n) => n + 1));
	assert.equal((await readdir(root)).filter(name => name.startsWith("assessor-diagnostic-")).length, 12);
});

test("a symlink transcript is recorded unavailable and never followed", async t => {
	const root = await mkdtemp(path.join(tmpdir(), "assessor-diagnostic-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const target = path.join(root, "private-target");
	const shortcut = path.join(root, "transcript-link");
	await writeFile(target, "private transcript");
	await symlink(target, shortcut);
	const result = await appendPrivateAssessorDiagnostic(root, input(1, shortcut));
	assert.equal(result.transcriptStatus, "not-regular");
	assert.equal(result.transcriptName, undefined);
	const record = JSON.parse(await readFile(path.join(root, result.diagnosticName), "utf8"));
	assert.deepEqual(record.transcript, { status: "unavailable", reason: "not-regular" });
});

test("a real result-transport byte boundary refuses the new diagnostic explicitly", async t => {
	const root = await mkdtemp(path.join(tmpdir(), "assessor-diagnostic-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	for (const [name, size] of [["candidate.cpp", 60 * 1024 * 1024],
		["verification.json", 30 * 1024 * 1024]] as const) {
		const handle = await open(path.join(root, name), "wx", 0o600);
		try { await handle.truncate(size); } finally { await handle.close(); }
	}
	await assert.rejects(appendPrivateAssessorDiagnostic(root, {
		...input(1), rawResponse: "x".repeat(8 * 1024 * 1024) }), error =>
		error instanceof Error && "code" in error && error.code === "physical-result-bound");
	assert.equal((await readdir(root)).filter(name => /^assessor-diagnostic-[0-9]+\.json$/.test(name)).length, 0);
});
