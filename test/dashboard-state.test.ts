import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { readDashboardState } from "../src/dashboard/state.ts";
import { TelemetryWriter } from "../src/dashboard/telemetry.ts";
import { Workspace } from "../src/workspace.ts";

test("dashboard snapshot separates fresh, idle, archived, and legacy unknown state", async () => {
	const root = await mkdtemp(path.join(tmpdir(), "pre-rsi-dashboard-"));
	const ws = new Workspace(root);
	await mkdir(ws.sessionsDir, { recursive: true });
	const activeRun = await ws.startRun("M01", []);
	activeRun.sessions.push({ id: "live", label: "live agent", role: "execution", model: "fake/live" });
	await ws.writeRun(activeRun);
	const oldRun = await ws.startRun("M02", []);
	oldRun.sessions.push({ id: "legacy", label: "legacy agent", role: "reviewer", model: "fake/old" });
	await ws.finishRun(oldRun, "completed");
	const live = await TelemetryWriter.start(root, { id: "live", kind: "agent", label: "live agent", role: "execution", model: "fake/live", tools: ["read"] });
	await live.heartbeat("idle");
	const ended = await TelemetryWriter.start(root, { id: "ended", kind: "agent", label: "ended agent", role: "checker", model: "fake/end", tools: [] });
	await ended.end();

	const state = await readDashboardState(ws, { now: new Date(), freshnessMs: 60_000 });
	assert.equal(state.workspace.label, path.basename(root));
	assert.equal(JSON.stringify(state).includes(root), false, "snapshot must not expose the absolute workspace path");
	assert.equal(state.nodes.find((node) => node.id === "agent:live")?.displayGroup, "idle");
	assert.equal(state.nodes.find((node) => node.id === "agent:legacy")?.displayGroup, "archived");
	assert.equal(state.nodes.find((node) => node.id === "agent:ended")?.displayGroup, "archived");
	assert.equal(state.nodes.find((node) => node.id === `stage:M01:${activeRun.runId}`)?.status, "idle");
	assert.deepEqual(state.nodes.find((node) => node.id === "agent:live")?.tools, ["read"]);
	await live.end();
});

test("fresh explicit membership activates a running stage before run.sessions is persisted", async () => {
	const root = await mkdtemp(path.join(tmpdir(), "pre-rsi-dashboard-active-"));
	const ws = new Workspace(root);
	const run = await ws.startRun("M05", []);
	const live = await TelemetryWriter.start(root, { id: "new-live", kind: "agent", label: "acquirer", role: "acquisition", model: "fake/live", tools: ["search"] });
	await live.setRunContext("M05", run.runId);
	const state = await readDashboardState(ws, { now: new Date(), freshnessMs: 60_000 });
	assert.equal(state.nodes.find((node) => node.id === `stage:M05:${run.runId}`)?.status, "active");
	assert.ok(state.edges.some((edge) => edge.source === `stage:M05:${run.runId}` && edge.target === "agent:new-live"));
	await live.end();
});

test("a session in a legacy running run is unknown without fresh telemetry", async () => {
	const root = await mkdtemp(path.join(tmpdir(), "pre-rsi-dashboard-legacy-running-"));
	const ws = new Workspace(root);
	const run = await ws.startRun("M02", []);
	run.sessions.push({ id: "old-running", label: "old", role: "execution", model: "fake/old" });
	await ws.writeRun(run);
	const state = await readDashboardState(ws);
	assert.equal(state.nodes.find((node) => node.id === "agent:old-running")?.displayGroup, "unknown");
});

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
