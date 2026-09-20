import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { main } from "../src/cli.ts";
import { Workspace } from "../src/workspace.ts";

async function capture(action: () => Promise<number>): Promise<{ code: number; output: string }> {
	const lines: string[] = [];
	const original = console.log;
	console.log = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
	try { return { code: await action(), output: lines.join("\n") }; }
	finally { console.log = original; }
}

test("CLI help exposes explicit M08/M09 entrypoints", async () => {
	const result = await capture(() => main(["help"]));
	assert.equal(result.code, 0);
	assert.match(result.output, /m08/);
	assert.match(result.output, /m09/);
	assert.match(result.output, /不会自动发布/);
});

test("CLI status lists M08/M09 and limitations without model config", async () => {
	const root = await mkdtemp(path.join(tmpdir(), "pre-rsi-cli-status-"));
	await capture(() => main(["init", "--workspace", root]));
	const result = await capture(() => main(["status", "--workspace", root]));
	assert.equal(result.code, 0);
	assert.match(result.output, /M08：0 次/);
	assert.match(result.output, /M09：0 次/);
	assert.match(result.output, /full-recomputation 请求不等于已完整复现/);
});

test("CLI M08 reads explicit JSON inputs and runs the real stage with the fake runner", async () => {
	const root = await mkdtemp(path.join(tmpdir(), "pre-rsi-cli-m08-"));
	await capture(() => main(["init", "--workspace", root]));
	await mkdir(path.join(root, "problem", "raw"), { recursive: true });
	await writeFile(path.join(root, "problem", "problem.md"), "CLI 审查问题\n");
	await writeFile(path.join(root, "research.config.json"), `${JSON.stringify({ roles: { reviewer: "fake/reviewer" }, concurrency: 1 })}\n`);
	const artifact = path.join(root, "artifact.md");
	await writeFile(artifact, "待审查成果\n");
	const materials = path.join(root, "materials.json"), checks = path.join(root, "checks.json"), reviewers = path.join(root, "reviewers.json");
	await writeFile(materials, `${JSON.stringify([{ label: "成果", path: artifact, sourceCategory: "result", providedScope: "全文" }])}\n`);
	await writeFile(checks, `${JSON.stringify([{ id: "scope", instruction: "核对目标同一性" }])}\n`);
	await writeFile(reviewers, `${JSON.stringify([{ id: "external", role: "reviewer" }])}\n`);
	const result = await capture(() => main(["m08", "--workspace", root, "--runner", "fake", "--materials", materials, "--self-checks", checks, "--reviewers", reviewers]));
	assert.equal(result.code, 0);
	assert.match(result.output, /M08 已结束：.*状态 completed/);
	assert.match(result.output, /review-bundle\.md/);
});

test("CLI M09 reaches the real stage and fails closed on the generic fake report", async () => {
	const root = await mkdtemp(path.join(tmpdir(), "pre-rsi-cli-m09-"));
	await capture(() => main(["init", "--workspace", root]));
	await writeFile(path.join(root, "research.config.json"), `${JSON.stringify({ roles: { execution: "fake/execution", checker: "fake/checker" }, concurrency: 1 })}\n`);
	const ws = new Workspace(root);
	const material = path.join(root, "result.txt"); await writeFile(material, "fixed result\n");
	const m08 = await ws.startRun("M08", []);
	const frozenRoot = path.join(ws.runDir("M08", m08.runId), "frozen");
	const relativePath = "materials/001-result/result.txt";
	const frozen = path.join(frozenRoot, relativePath); await mkdir(path.dirname(frozen), { recursive: true }); await writeFile(frozen, "fixed result\n");
	const problemRelative = "materials/000-problem/problem.md";
	const problem = path.join(frozenRoot, problemRelative); await mkdir(path.dirname(problem), { recursive: true }); await writeFile(problem, "fixed problem\n");
	const manifest = { version: 1, m08RunId: m08.runId, rootDir: frozenRoot, createdAt: new Date().toISOString(), entries: [
		{ label: "problem", path: problem, sourceCategory: "original-problem", originalPath: problem, frozenPath: problem, relativePath: problemRelative, kind: "file" },
		{ label: "result", path: material, sourceCategory: "result", originalPath: material, frozenPath: frozen, relativePath, kind: "file" },
	], unprovidedScopes: [] };
	const manifestRef = await ws.writeOutput(m08, "manifest.json", JSON.stringify(manifest), "固定材料清单");
	const feedback = await ws.writeOutput(m08, "review.md", "review", "M08 审查反馈包"); await ws.finishRun(m08, "completed");
	const m04 = await ws.startRun("M04", [{ label: "M08 审查反馈包", path: feedback.path }]);
	await ws.writeOutput(m04, "m08-source.json", JSON.stringify({ m08RunId: m08.runId, manifestPath: manifestRef.path, reviewBundlePath: feedback.path }), "M08 处理来源");
	await ws.writeOutput(m04, "m08-disposition.json", JSON.stringify({ m08RunId: m08.runId, status: "ready", deliverablePaths: [relativePath], limitations: [], rationale: "bounded" }), "M08 用途处置");
	await ws.finishRun(m04, "completed");
	const deliveryScope = path.join(root, "delivery.json"), reproduction = path.join(root, "reproduction.json");
	await writeFile(deliveryScope, JSON.stringify({ included: [relativePath], excluded: [], limitations: [] }));
	await writeFile(reproduction, JSON.stringify({ mode: "read-only", instructions: [], authorizedExecution: false }));
	await assert.rejects(capture(() => main(["m09", "--workspace", root, "--runner", "fake", "--m08", m08.runId, "--m04", m04.runId, "--recipient", "reader", "--purpose", "inspect", "--delivery-scope", deliveryScope, "--reproduction", reproduction])), /m09-delivery/);
	const ids = await ws.listRuns("M09");
	assert.equal(ids.length, 1);
	assert.equal((await ws.readRun("M09", ids[0])).status, "failed");
});
