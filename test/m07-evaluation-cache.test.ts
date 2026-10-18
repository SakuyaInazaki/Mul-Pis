import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { EvaluationCache, evaluationCacheKey,
	type EvaluationCacheKeyParts } from "../src/m07/evaluation-cache.ts";

const parts: EvaluationCacheKeyParts = { backendId: "local-test", backendVersion: "1",
	protocolId: "numeric-tree-test-v1", subjectId: "numeric-tree", stageId: "measurement",
	sourceDigest: "a".repeat(64), contractDigest: "b".repeat(64), platformKey: "device-a/cann-8",
	protocolVersion: "device-a-timing-1", caseSetId: "c1,c2" };

async function workspace(t: { after(fn: () => Promise<void>): void }): Promise<string> {
	const root = await mkdtemp(path.join(tmpdir(), "evaluation-cache-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	return root;
}

test("every part of the key changes it, so a replay cannot describe another run", () => {
	const base = evaluationCacheKey(parts);
	for (const key of Object.keys(parts) as Array<keyof EvaluationCacheKeyParts>)
		assert.notEqual(evaluationCacheKey({ ...parts, [key]: `${parts[key]}-changed` }), base,
			`${key} must take part in the key: a receipt from another ${key} is not this candidate's result`);
	assert.equal(evaluationCacheKey({ ...parts }), base, "the same inputs give the same key");
});

test("a stored stage replays its whole receipt tree, including nested worker logs", async t => {
	const root = await workspace(t);
	const stage = path.join(root, "stage");
	await mkdir(path.join(stage, "worker-logs", "candidate"), { recursive: true });
	await writeFile(path.join(stage, "evaluation.json"), '{"kind":"local-operator-evaluation"}\n');
	await writeFile(path.join(stage, "worker-logs", "candidate", "stdout.jsonl"), "{}\n");
	const cache = new EvaluationCache(path.join(root, "cache"));
	const key = evaluationCacheKey(parts);
	const stored = await cache.store(key, parts, { status: "passed", summary: "measurement: passed",
		performedChecks: ["measurement"],
		receipts: [{ name: "evaluation.json", file: path.join(stage, "evaluation.json") },
			{ name: "worker-logs/candidate/stdout.jsonl", file: path.join(stage, "worker-logs", "candidate", "stdout.jsonl") }],
		evaluationNames: ["evaluation.json"], runId: "trial" });
	assert.equal(stored?.sourceRunId, "trial");
	assert.equal(await cache.size(), 1);
	// A second write of the same key never half-replaces the first entry.
	assert.equal(await cache.store(key, parts, { status: "failed", summary: "x",
		receipts: [{ name: "evaluation.json", file: path.join(stage, "evaluation.json") }],
		evaluationNames: ["evaluation.json"], runId: "later" }), undefined);

	const replay = await mkdtemp(path.join(root, "replay-"));
	const entry = await cache.read(key);
	assert.equal(entry?.status, "passed");
	const restored = await cache.restore(entry!, replay);
	assert.equal(restored.length, 2);
	assert.equal(await readFile(path.join(replay, "evaluation.json"), "utf8"), '{"kind":"local-operator-evaluation"}\n');
	assert.equal(await readFile(path.join(replay, "worker-logs", "candidate", "stdout.jsonl"), "utf8"), "{}\n");
	assert.equal(cache.stats.hits, 1);
});

test("an unknown key, a damaged entry and an escaping name are misses, never guesses", async t => {
	const root = await workspace(t);
	const stage = path.join(root, "stage");
	await mkdir(stage, { recursive: true });
	await writeFile(path.join(stage, "evaluation.json"), "{}\n");
	const cache = new EvaluationCache(path.join(root, "cache"));
	assert.equal(await cache.read(evaluationCacheKey(parts)), undefined);
	assert.equal(cache.stats.misses, 1);
	assert.equal(await cache.store("k2", parts, { status: "passed", summary: "s",
		receipts: [{ name: "../escape.json", file: path.join(stage, "evaluation.json") }],
		evaluationNames: ["../escape.json"], runId: "trial" }), undefined,
		"a receipt name that leaves the entry is refused rather than normalized");
	const key = evaluationCacheKey(parts);
	await cache.store(key, parts, { status: "passed", summary: "s",
		receipts: [{ name: "evaluation.json", file: path.join(stage, "evaluation.json") }],
		evaluationNames: ["evaluation.json"], runId: "trial" });
	await rm(path.join(root, "cache", key, "evaluation.json"));
	assert.equal(await cache.read(key), undefined, "an entry whose receipt vanished cannot be replayed");
	assert.equal(cache.stats.misses, 2);
});

test("the profile separates time actually spent from time a replay stood in for", async t => {
	const root = await workspace(t);
	const stage = path.join(root, "stage");
	await mkdir(stage, { recursive: true });
	await writeFile(path.join(stage, "evaluation.json"), "{}\n");
	const cache = new EvaluationCache(path.join(root, "cache"));
	cache.recordExecution("measurement", 4_000);
	cache.recordExecution("measurement", 2_000);
	assert.equal(cache.stats.executedMsByStage.measurement, 6_000);
	const key = evaluationCacheKey(parts);
	await cache.store(key, parts, { status: "passed", summary: "s",
		receipts: [{ name: "evaluation.json", file: path.join(stage, "evaluation.json") }],
		evaluationNames: ["evaluation.json"], runId: "trial" });
	await cache.read(key);
	assert.equal(cache.stats.hits, 1);
	assert.equal(cache.stats.replacedMsByStage.measurement, 6_000,
		"a replay is credited with the measured cost of running that stage, so a run can say what it saved");
});
