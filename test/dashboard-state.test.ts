import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { readDashboardState } from "../src/dashboard/state.ts";
import { TelemetryWriter } from "../src/dashboard/telemetry.ts";
import { Workspace } from "../src/workspace.ts";

test("fresh resumed telemetry outranks an old completed membership", async () => {
	const root = await mkdtemp(path.join(tmpdir(), "pre-rsi-dashboard-resume-"));
	const ws = new Workspace(root);
	const oldRun = await ws.startRun("M01", []);
	oldRun.sessions.push({ id: "resumed", label: "researcher", role: "research", model: "fake/model" });
	await ws.finishRun(oldRun, "completed");
	const currentRun = await ws.startRun("M03", []);
	currentRun.sessions.push({ id: "resumed", label: "researcher", role: "research", model: "fake/model" });
	await ws.writeRun(currentRun);
	const live = await TelemetryWriter.start(root, { id: "resumed", kind: "agent", label: "researcher", role: "research", model: "fake/model", tools: [] });
	await live.setRunContext("M03", currentRun.runId);
	const state = await readDashboardState(ws, { now: new Date(), freshnessMs: 60_000 });
	const agent = state.nodes.find((node) => node.id === "agent:resumed");
	assert.equal(agent?.status, "active");
	assert.equal(agent?.stage, "M03", "fresh telemetry retains the explicit current run attribution");
	assert.equal(agent?.runId, currentRun.runId);
	assert.ok(state.edges.some((edge) => edge.source === `stage:M01:${oldRun.runId}` && edge.target === "agent:resumed"));
	assert.ok(state.edges.some((edge) => edge.source === `stage:M03:${currentRun.runId}` && edge.target === "agent:resumed"));
	assert.equal(state.nodes.find((node) => node.id === `stage:M03:${currentRun.runId}`)?.status, "active");
	await live.end();
});

test("completed runs with failures are warnings and telemetry never exposes payload fields", async () => {
	const root = await mkdtemp(path.join(tmpdir(), "pre-rsi-dashboard-warning-"));
	const ws = new Workspace(root);
	const run = await ws.startRun("M03", []);
	run.failures.push("private failure details");
	await ws.finishRun(run, "completed");
	await mkdir(path.join(root, ".agent", "telemetry"), { recursive: true });
	await writeFile(path.join(root, ".agent", "telemetry", "malformed.json"), JSON.stringify({ prompt: "secret", toolArgs: { token: "secret" } }));
	const state = await readDashboardState(root);
	const node = state.nodes.find((item) => item.id === `stage:M03:${run.runId}`)!;
	assert.equal(node.status, "warning");
	assert.equal(node.failureCount, 1);
	assert.doesNotMatch(JSON.stringify(state), /private failure details|toolArgs|token/);
});

test("dashboard exposes a suspended M07 attempt even when the run and telemetry remain running", async () => {
	const root = await mkdtemp(path.join(tmpdir(), "pre-rsi-dashboard-m07-attempt-"));
	const ws = new Workspace(root);
	const run = await ws.startRun("M07", []);
	await writeFile(path.join(ws.runDir("M07", run.runId), "goal.json"), JSON.stringify({ runId: run.runId, lifecycle: "active", tasks: [{ taskId: "T001", status: "unknown" }], executionState: { version: 1, activeAttemptId: "A001", attempts: [{ id: "A001", state: "recovery-required" }], operations: [{ id: "O001", status: "unknown" }] } }));
	const live = await TelemetryWriter.start(root, { id: "stale-owner", kind: "agent", label: "stale owner", role: "execution", model: "fake/live", tools: [] });
	await live.setRunContext("M07", run.runId);
	const state = await readDashboardState(ws, { now: new Date(), freshnessMs: 60_000 });
	const node = state.nodes.find((item) => item.id === `stage:M07:${run.runId}`)!;
	assert.equal(node.attemptId, "A001");
	assert.equal(node.attemptState, "recovery-required");
	assert.deepEqual(node.unresolvedOperationIds, ["O001"]);
	assert.deepEqual(node.unresolvedTaskIds, ["T001"]);
	assert.equal(node.status, "unknown", "fresh session telemetry cannot turn a stopped attempt into an active M07 stage");
	await live.end();
});
