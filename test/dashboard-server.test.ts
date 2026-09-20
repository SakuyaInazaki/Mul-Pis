import assert from "node:assert/strict";
import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { startDashboardServer } from "../src/dashboard/server.ts";

async function fixture(): Promise<{ project: string; workspace: string }> {
	const project = await mkdtemp(path.join(tmpdir(), "pre-rsi-dashboard-"));
	const workspace = path.join(project, "workspaces", "sample");
	await mkdir(path.join(workspace, "stages", "M01", "run-one"), { recursive: true });
	await writeFile(path.join(workspace, "research.config.json"), JSON.stringify({ roles: {}, concurrency: 1, tools: {} }));
	await writeFile(path.join(workspace, "stages", "M01", "run-one", "run.json"), JSON.stringify({
		stage: "M01", runId: "run-one", startedAt: "2026-09-20T00:00:00.000Z", finishedAt: "2026-09-20T00:01:00.000Z",
		status: "completed", inputs: [], sessions: [], outputs: [], failures: [], remarks: [],
	}));
	return { project, workspace };
}

test("dashboard exposes opaque workspace IDs and safe state on loopback", async () => {
	const { project, workspace } = await fixture();
	const publicDir = path.join(project, "public");
	await mkdir(publicDir); await writeFile(path.join(publicDir, "index.html"), "dashboard");
	const running = await startDashboardServer({ root: project, port: 0, publicDir });
	try {
		assert.equal(running.host, "127.0.0.1");
		const listing = await fetch(`${running.url}api/workspaces`);
		assert.equal(listing.status, 200);
		assert.equal(listing.headers.get("cache-control"), "no-store");
		const body = await listing.json() as { workspaces: Array<{ id: string; label: string; path?: string }>; selected?: string };
		assert.equal(body.workspaces.length, 1);
		assert.equal(body.workspaces[0].label, "sample");
		assert.equal(body.workspaces[0].path, undefined);
		assert.ok(!JSON.stringify(body).includes(workspace));
		const stateResponse = await fetch(`${running.url}api/state?workspace=${body.workspaces[0].id}`);
		assert.equal(stateResponse.status, 200);
		const state = await stateResponse.json() as { schemaVersion: number; nodes: Array<{ stage?: string }> };
		assert.equal(state.schemaVersion, 1);
		assert.ok(state.nodes.some((node) => node.stage === "M01"));
		assert.ok(!JSON.stringify(state).includes(workspace));
	} finally { await running.close(); }
});

test("dashboard rejects arbitrary workspace paths, foreign origins, writes, and traversal", async () => {
	const { project } = await fixture();
	const publicDir = path.join(project, "public");
	await mkdir(publicDir); await writeFile(path.join(publicDir, "index.html"), "dashboard");
	const running = await startDashboardServer({ root: project, port: 0, publicDir });
	try {
		assert.equal((await fetch(`${running.url}api/state?workspace=/tmp`)).status, 404);
		assert.equal((await fetch(`${running.url}api/workspaces`, { headers: { Origin: "https://example.test" } })).status, 403);
		assert.equal((await fetch(`${running.url}api/workspaces`, { method: "POST" })).status, 405);
		assert.ok([403, 404].includes((await fetch(`${running.url}%2e%2e/package.json`)).status));
		assert.equal(await (await fetch(running.url)).text(), "dashboard");
	} finally { await running.close(); }
});

test("dashboard refuses metadata symlinks that escape a registered workspace", async () => {
	const { project, workspace } = await fixture();
	const outside = path.join(project, "outside-secret.json");
	await writeFile(outside, JSON.stringify({ stage: "M01", runId: "secret", status: "completed", sessions: [{ label: "DO_NOT_LEAK" }] }));
	await mkdir(path.join(workspace, "stages", "M02", "linked"), { recursive: true });
	await symlink(outside, path.join(workspace, "stages", "M02", "linked", "run.json"));
	const publicDir = path.join(project, "public"); await mkdir(publicDir); await writeFile(path.join(publicDir, "index.html"), "dashboard");
	const running = await startDashboardServer({ root: project, port: 0, publicDir });
	try {
		const listing = await (await fetch(`${running.url}api/workspaces`)).json() as { workspaces: Array<{ id: string }> };
		const response = await fetch(`${running.url}api/state?workspace=${listing.workspaces[0].id}`);
		assert.equal(response.status, 500);
		assert.ok(!(await response.text()).includes("DO_NOT_LEAK"));
	} finally { await running.close(); }
});
