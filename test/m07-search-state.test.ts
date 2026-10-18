import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { bestCandidates, candidateAncestors, candidateChildren, candidateSiblings, openSearchEventLog,
	readSearchEvents, rebuildSearchState, searchCandidate, searchStateSummary } from "../src/m07/search-state/index.ts";

async function logFile(t: TestContext): Promise<string> {
	const root = await mkdtemp(path.join(tmpdir(), "pre-rsi-search-state-"));
	t.after(async () => { await rm(root, { recursive: true, force: true }); });
	return path.join(root, "nested", "search-events.jsonl");
}

test("two writers append to one log without losing or interleaving events", async t => {
	const file = await logFile(t);
	const one = openSearchEventLog(file, { writer: "alpha", now: () => Date.parse("2026-10-18T00:00:00.000Z") });
	const two = openSearchEventLog(file, { writer: "beta", now: () => Date.parse("2026-10-18T00:00:00.000Z") });
	await Promise.all([
		...Array.from({ length: 20 }, (_, index) => one.append({ runId: "R1", kind: "candidate-submitted",
			candidate: { id: `A${index}` } })),
		...Array.from({ length: 20 }, (_, index) => two.append({ runId: "R1", kind: "candidate-submitted",
			candidate: { id: `B${index}` } })),
	]);
	const { events, skipped } = await readSearchEvents(file);
	assert.equal(skipped, 0);
	assert.equal(events.length, 40);
	// Each writer's own sequence is monotonic, and the read order is total and stable.
	assert.deepEqual(events.filter(event => event.writer === "alpha").map(event => event.seq),
		Array.from({ length: 20 }, (_, index) => index + 1));
	assert.deepEqual(events.map(event => `${event.writer}:${event.seq}`),
		(await readSearchEvents(file)).events.map(event => `${event.writer}:${event.seq}`));
	assert.equal(events[0].writer, "alpha");
	assert.equal(events[20].writer, "beta");
});

test("a crash-truncated tail is reported, never guessed at", async t => {
	const file = await logFile(t);
	const log = openSearchEventLog(file, { writer: "alpha" });
	await log.append({ runId: "R1", kind: "task-started", taskId: "T001" });
	await log.append({ runId: "R1", kind: "candidate-submitted", taskId: "T001", candidate: { id: "C001" } });
	const text = await readFile(file, "utf8");
	await writeFile(file, `${text}{"version":1,"seq":3,"writer":"alpha","at":"2026-`, "utf8");
	const { events, skipped } = await readSearchEvents(file);
	assert.equal(events.length, 2);
	assert.equal(skipped, 1);
	// A foreign or out-of-contract line is skipped the same way.
	await writeFile(file, `${text}{"version":2,"seq":9,"writer":"x","at":"2026-10-18T00:00:00.000Z","runId":"R1","kind":"task-started"}\n`, "utf8");
	assert.equal((await readSearchEvents(file)).skipped, 1);
	assert.deepEqual(await readSearchEvents(path.join(path.dirname(file), "absent.jsonl")), { events: [], skipped: 0 });
});

test("the state is a function of the events, including the candidate tree", async t => {
	const file = await logFile(t);
	const log = openSearchEventLog(file, { writer: "alpha" });
	await log.append({ runId: "R1", kind: "task-started", taskId: "T001", round: 1 });
	await log.append({ runId: "R1", kind: "candidate-submitted", taskId: "T001", round: 1,
		candidate: { id: "C001", subjectId: "gemm", pathRef: "runs/C001/journal.json" },
		platform: { id: "device-a", chip: "Device A", toolchain: "Toolchain 8.3" } });
	await log.append({ runId: "R1", kind: "candidate-stage", taskId: "T001", round: 1,
		candidate: { id: "C001", stage: "compile", status: "passed" } });
	await log.append({ runId: "R1", kind: "candidate-evaluated", taskId: "T001", round: 1,
		candidate: { id: "C001", score: 0.6, isBuggy: false, status: "completed" },
		verdict: { decision: "keep", reason: "first verified candidate" },
		counters: { candidates: 1, infrastructureFailures: 0 } });
	await log.append({ runId: "R1", kind: "candidate-submitted", taskId: "T001", round: 2,
		candidate: { id: "C002", parentId: "C001", subjectId: "gemm" } });
	await log.append({ runId: "R1", kind: "candidate-evaluated", taskId: "T001", round: 2,
		candidate: { id: "C002", score: 0.8 }, counters: { candidates: 2 } });
	await log.append({ runId: "R1", kind: "candidate-submitted", taskId: "T001", round: 2,
		candidate: { id: "C003", parentId: "C001", isBuggy: true, score: 0.1 } });
	await log.append({ runId: "R1", kind: "stall", taskId: "T001", round: 3, detail: { signal: "no_progress" } });
	// Another run's events in the same file never leak into this run's state.
	await log.append({ runId: "R2", kind: "candidate-submitted", candidate: { id: "C001", score: 0.99 } });

	const { events } = await readSearchEvents(file);
	const state = rebuildSearchState("R1", events);
	assert.equal(state.candidates.length, 3);
	assert.equal(state.rounds, 3);
	assert.equal(state.stalls, 1);
	assert.deepEqual(state.counters, { candidates: 2, infrastructureFailures: 0 });
	assert.deepEqual(state.platforms, [{ id: "device-a", chip: "Device A", toolchain: "Toolchain 8.3" }]);
	const first = searchCandidate(state, "C001");
	assert.equal(first?.score, 0.6);
	assert.equal(first?.verdict?.decision, "keep");
	assert.deepEqual(first?.stages.map(stage => `${stage.stage}:${stage.status}`), ["compile:passed"]);
	assert.equal(first?.pathRef, "runs/C001/journal.json");
	assert.deepEqual(candidateChildren(state, "C001").map(item => item.id), ["C002", "C003"]);
	assert.deepEqual(candidateAncestors(state, "C002").map(item => item.id), ["C001"]);
	assert.deepEqual(candidateSiblings(state, "C002").map(item => item.id), ["C003"]);
	assert.deepEqual(state.tasks[0].candidates, ["C001", "C002", "C003"]);
	// Buggy and unscored candidates are not ranked as if they were merely average.
	assert.deepEqual(bestCandidates(state).map(item => item.id), ["C002", "C001"]);
	assert.deepEqual(bestCandidates(state, { includeBuggy: true }).map(item => item.id), ["C002", "C001", "C003"]);
	assert.deepEqual(bestCandidates(state, { subjectId: "gemm" }).map(item => item.id), ["C002", "C001"]);
	const summary = searchStateSummary(state);
	assert.deepEqual([summary.candidates, summary.buggy, summary.scored, summary.rounds, summary.stalls], [3, 1, 3, 3, 1]);
	// Rebuilding from the same log twice gives the same state.
	assert.deepEqual(rebuildSearchState("R1", (await readSearchEvents(file)).events), state);
});

test("a restarted process continues from the log alone", async t => {
	const file = await logFile(t);
	const before = openSearchEventLog(file, { writer: "first-process" });
	await before.append({ runId: "R1", kind: "task-started", taskId: "T001", round: 1 });
	await before.append({ runId: "R1", kind: "candidate-submitted", taskId: "T001", round: 1, candidate: { id: "C001" } });
	await before.append({ runId: "R1", kind: "background-queued", taskId: "T001", candidate: { id: "C002" } });

	// The process dies here: the queued run never settled.
	const recovered = rebuildSearchState("R1", (await readSearchEvents(file)).events);
	assert.equal(searchStateSummary(recovered).background.outstanding, 1);
	const after = openSearchEventLog(file, { writer: "second-process" });
	await after.append({ runId: "R1", kind: "background-settled", taskId: "T001", round: 2,
		candidate: { id: "C002", score: 0.5, status: "completed" } });
	const resumed = rebuildSearchState("R1", (await readSearchEvents(file)).events);
	assert.equal(searchStateSummary(resumed).background.outstanding, 0);
	assert.equal(resumed.rounds, 2);
	assert.equal(searchCandidate(resumed, "C002")?.score, 0.5);
});

test("one line stays one write, and an unknown kind is refused", async t => {
	const file = await logFile(t);
	const log = openSearchEventLog(file, { writer: "alpha" });
	await log.append({ runId: "R1", kind: "candidate-evaluated", candidate: { id: "C001" },
		detail: { note: "x".repeat(40_000), "not a name": "dropped", kept: true } });
	const first = (await readFile(file, "utf8")).split("\n").filter(Boolean);
	assert.equal(first.length, 1);
	const detail = JSON.parse(first[0]).detail as Record<string, unknown>;
	// Each field is clipped and keys that are not plain names are dropped.
	assert.equal(String(detail.note).length, 401);
	assert.equal(detail.kept, true);
	assert.equal("not a name" in detail, false);
	// The whole-line bound is the backstop when many fields are each legal.
	await log.append({ runId: "R1", kind: "candidate-evaluated", candidate: { id: "C002" },
		detail: Object.fromEntries(Array.from({ length: 24 }, (_, index) => [`field${index}`, "y".repeat(400)])) });
	const lines = (await readFile(file, "utf8")).split("\n").filter(Boolean);
	assert.equal(lines.length, 2);
	assert.equal(lines.every(line => Buffer.byteLength(line, "utf8") <= 8_192), true);
	assert.deepEqual(JSON.parse(lines[1]).detail, { trimmed: true });
	await assert.rejects(log.append({ runId: "R1", kind: "invented" as never }), /unknown search event kind/);
	await assert.rejects(log.append({ runId: "R1", kind: "verdict",
		verdict: { decision: "promote" as never } }), /unknown search verdict decision/);
	assert.equal((await readSearchEvents(file)).events.length, 2);
});
