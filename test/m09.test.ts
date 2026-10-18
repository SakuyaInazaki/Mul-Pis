import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { createFileKnowledgeStore } from "../src/knowledge/store.ts";
import { FakeSessionRunner } from "../src/runner/fake.ts";
import type { StageContext } from "../src/stages/context.ts";
import { runM09, type M09Options } from "../src/stages/m09.ts";
import { HarnessError } from "../src/types.ts";
import { Workspace } from "../src/workspace.ts";
import { writeCandidateGoal } from "./helpers/candidate-goal.ts";

const gate = (name: string, scope: string[], evidence: string[]) => `\n\n\`\`\`${name}\n${JSON.stringify({ status: "checked", scope, unresolved: [], evidence })}\n\`\`\``;

async function fixture(t: TestContext) {
	const root = await mkdtemp(path.join(tmpdir(), "pre-rsi-m09-"));
	t.after(async () => rm(root, { recursive: true, force: true }));
	const ws = new Workspace(root); const store = createFileKnowledgeStore(ws.knowledgeDir); await store.init();
	const snapshot = await store.current();
	const material = path.join(root, "result.txt"); await writeFile(material, "fixed result\n");
	const m08 = await ws.startRun("M08", [{ label: "result", path: material }], snapshot?.id);
	const frozenRoot = path.join(ws.runDir("M08", m08.runId), "frozen"); const relativePath = "materials/001-result/result.txt"; const frozen = path.join(frozenRoot, relativePath);
	await mkdir(path.dirname(frozen), { recursive: true }); await writeFile(frozen, "fixed result\n");
	const problemPath = "materials/000-problem/problem.md"; const frozenProblem = path.join(frozenRoot, problemPath); await mkdir(path.dirname(frozenProblem), { recursive: true }); await writeFile(frozenProblem, "fixed problem\n");
	const manifest = { version: 1, m08RunId: m08.runId, rootDir: frozenRoot, createdAt: new Date().toISOString(), entries: [{ label: "problem", path: frozenProblem, sourceCategory: "original-problem", originalPath: frozenProblem, frozenPath: frozenProblem, relativePath: problemPath, kind: "file" }, { label: "result", path: material, sourceCategory: "result", originalPath: material, frozenPath: frozen, relativePath, kind: "file" }], unprovidedScopes: [] };
	const manifestRef = await ws.writeOutput(m08, "manifest.json", JSON.stringify(manifest), "固定材料清单");
	const feedback = await ws.writeOutput(m08, "review.md", "review feedback", "M08 审查反馈包"); await ws.finishRun(m08, "completed");
	const m04 = await ws.startRun("M04", [{ label: "M08 审查反馈包", path: feedback.path }], snapshot?.id);
	await ws.writeOutput(m04, "m08-source.json", JSON.stringify({ m08RunId: m08.runId, manifestPath: manifestRef.path, reviewBundlePath: feedback.path }), "M08 处理来源");
	await ws.writeOutput(m04, "m08-disposition.json", JSON.stringify({ m08RunId: m08.runId, status: "ready", deliverablePaths: [relativePath], limitations: ["只交付固定结果"], rationale: "指定范围可交付" }), "M08 用途处置");
	await ws.writeOutput(m04, "processing.md", "M04 processed", "处理结果"); await ws.finishRun(m04, "completed");
	const runner = new FakeSessionRunner(({ spec }) => spec.label === "M09-organizer"
		? { text: `独立说明，不新增结论。${gate("m09-delivery", [relativePath], [relativePath])}`, reads: [problemPath, relativePath] }
		: { text: `复核报告。${gate("m09-verification", [relativePath], ["DELIVERY.md", relativePath])}`,
			reads: ["DELIVERY.md", relativePath, path.join(".m09-control", "source-trace.json")] });
	const ctx: StageContext = { ws, store, runner, config: { roles: { execution: "fake/execution", checker: "fake/checker" }, concurrency: 1, tools: {} } };
	const options: M09Options = { m08RunId: m08.runId, m04RunId: m04.runId, recipient: "后续研究者", purpose: "继续核查", deliveryScope: { included: [relativePath], excluded: [], limitations: [] }, reproduction: { mode: "read-only", instructions: [], authorizedExecution: false }, closureRequested: true };
	return { root, ws, store, runner, ctx, options, m08, m04, relativePath };
}

test("M09 copies the exact fixed source and checks the actual delivery copy", async (t) => {
	const f = await fixture(t); const result = await runM09(f.ctx, f.options);
	assert.equal(result.record.status, "completed");
	assert.equal(await readFile(path.join(result.closure.artifacts.deliveryRoot, f.relativePath), "utf8"), "fixed result\n");
	assert.equal(result.closure.deliveryStatus, "checked");
	assert.equal(result.closure.reproduction.status, "not-executed");
	assert.deepEqual(f.runner.created.map((x) => [x.label, x.role]), [["M09-organizer", "execution"], ["M09-checker", "checker"]]);
});

test("M09 rejects an M04 run that did not process this exact M08 batch", async (t) => {
	const f = await fixture(t); const unrelated = path.join(f.root, "other-review.md"); await writeFile(unrelated, "other");
	f.m04.inputs = [{ label: "other", path: unrelated }]; await f.ws.writeRun(f.m04);
	await assert.rejects(runM09(f.ctx, f.options), (error: unknown) => error instanceof HarnessError && error.code === "m09.pair");
});

test("M09 rejects stale knowledge state and proposal-processing failures", async (t) => {
	const stale = await fixture(t); await stale.store.submitProposal({ stage: "test", runId: "new", session: "test", ops: [], summary: "new snapshot" }).then(async (x) => stale.store.merge(x.proposalId));
	await assert.rejects(runM09(stale.ctx, stale.options), (error: unknown) => error instanceof HarnessError && error.code === "m09.knowledge-changed");
	const failed = await fixture(t); failed.m04.failures.push("知识提案未合入：结构校验未通过"); await failed.ws.writeRun(failed.m04);
	await assert.rejects(runM09(failed.ctx, failed.options), (error: unknown) => error instanceof HarnessError && error.code === "m09.m04-proposal");
});

test("M09 refuses a delivery whose candidate is not the historical best, and records the comparison", async (t) => {
	const superseded = await fixture(t);
	// The delivered material is byte-identical to the slower archived candidate.
	await writeCandidateGoal(superseded.ws, "g", "S1", [
		{ id: "C001", source: "fixed result\n", value: 2, externalId: "E001" },
		{ id: "C002", source: "faster result\n", value: 1, externalId: "E002" },
	]);
	await assert.rejects(runM09(superseded.ctx, superseded.options),
		(error: unknown) => error instanceof HarnessError && error.code === "m09.superseded-delivery");

	const best = await fixture(t);
	await writeCandidateGoal(best.ws, "g", "S1", [
		{ id: "C001", source: "slower result\n", value: 2, externalId: "E001" },
		{ id: "C002", source: "fixed result\n", value: 1, externalId: "E002" },
	]);
	const result = await runM09(best.ctx, best.options);
	assert.equal(result.closure.deliveryStatus, "checked");
	assert.deepEqual(result.closure.deliveryEvidence.deliveredCandidateRefs, ["g/T001/C002"]);
	assert.equal(result.closure.deliveryEvidence.best[0].delivered, true);
	assert.equal(result.closure.deliveryEvidence.measurement.metricsWithReference, 1);
});
