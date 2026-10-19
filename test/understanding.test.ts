import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { freezeUnderstanding, latestUnderstanding, understandingBlock,
	UNDERSTANDING_LIMITS } from "../src/understanding.ts";
import { Workspace } from "../src/workspace.ts";

async function workspace(t: TestContext): Promise<Workspace> {
	const root = await mkdtemp(path.join(tmpdir(), "understanding-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	await mkdir(path.join(root, "problem", "raw"), { recursive: true });
	return new Workspace(root);
}

async function completed(ws: Workspace, stage: string, label: string, name: string, text: string): Promise<string> {
	const record = await ws.startRun(stage, []);
	await ws.writeOutput(record, name, text, label);
	await ws.finishRun(record, "completed");
	return record.runId;
}

test("the latest completed M01 understanding is read, with M03's challenge when there is one", async t => {
	const ws = await workspace(t);
	assert.equal(await latestUnderstanding(ws), undefined, "no M01 run means no invented understanding");
	const first = await completed(ws, "M01", "初始认识", "initial-understanding.md", "第一次认识\n");
	const second = await completed(ws, "M01", "初始认识", "initial-understanding.md", "第二次认识，更完整\n");
	assert.notEqual(first, second);
	const onlyM01 = (await latestUnderstanding(ws))!;
	assert.equal(onlyM01.m01RunId, second, "the latest completed run wins");
	assert.equal(onlyM01.understanding, "第二次认识，更完整");
	assert.equal(onlyM01.evaluation, undefined);
	const m03 = await completed(ws, "M03", "逐题评价", "evaluation.md", "质询：第三点缺证据\n");
	const withM03 = (await latestUnderstanding(ws))!;
	assert.equal(withM03.m03RunId, m03);
	assert.equal(withM03.evaluation, "质询：第三点缺证据");
});

test("a running or output-less run never contributes, and long material is bounded with its omission stated", async t => {
	const ws = await workspace(t);
	const unfinished = await ws.startRun("M01", []);
	await ws.writeOutput(unfinished, "initial-understanding.md", "未完成的认识\n", "初始认识");
	assert.equal(await latestUnderstanding(ws), undefined, "an unfinished M01 run is not an understanding");
	const empty = await ws.startRun("M01", []);
	await ws.finishRun(empty, "completed");
	assert.equal(await latestUnderstanding(ws), undefined, "a completed run without the output contributes nothing");
	const long = "认".repeat(UNDERSTANDING_LIMITS.understanding + 500);
	await completed(ws, "M01", "初始认识", "initial-understanding.md", long);
	const source = (await latestUnderstanding(ws))!;
	assert.equal(source.understanding.length, UNDERSTANDING_LIMITS.understanding);
	assert.equal(source.understandingOmitted, 500);
	const block = understandingBlock(source, ws.root);
	assert.match(block, /另有 500 字符未显示，需要时读原文/);
	assert.match(block, /不是已核验事实/);
	assert.ok(!block.includes(ws.root), "paths are workspace-relative so the bytes do not depend on where it lives");
});

test("freezing writes the exact bytes a later round reads", async t => {
	const ws = await workspace(t);
	await completed(ws, "M01", "初始认识", "initial-understanding.md", "认识正文\n");
	await completed(ws, "M03", "逐题评价", "evaluation.md", "质询正文\n");
	const source = (await latestUnderstanding(ws))!;
	const snapshotPath = path.join(ws.root, "frozen-understanding.md");
	const frozen = await freezeUnderstanding(ws, source, snapshotPath);
	assert.equal(frozen.kind, "m07-understanding-snapshot");
	assert.equal(frozen.snapshotPath, snapshotPath);
	assert.equal(frozen.understandingChars, "认识正文".length);
	assert.equal(frozen.evaluationChars, "质询正文".length);
	const bytes = await readFile(snapshotPath, "utf8");
	assert.equal(bytes, `${understandingBlock(source, ws.root)}\n`);
	// A later M01 run must not change what this goal already froze.
	await completed(ws, "M01", "初始认识", "initial-understanding.md", "后来的认识\n");
	assert.equal(await readFile(snapshotPath, "utf8"), bytes);
	await writeFile(path.join(ws.root, "unused.md"), "");
});
