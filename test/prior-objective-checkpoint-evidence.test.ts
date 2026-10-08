import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PRIOR_OBJECTIVE_CHECKPOINT_INDEX, stagePriorObjectiveCheckpointEvidence,
	verifyPriorObjectiveCheckpointEvidence } from "../src/m07/prior-objective-checkpoint-evidence.ts";

async function fixture(t: { after(fn: () => Promise<void>): void }) {
	const directory = await mkdtemp(path.join(os.tmpdir(), "prior-objective-checkpoint-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	// A multibyte code point crosses ordinary byte cuts in this synthetic JSON.
	const original = Buffer.from(`${JSON.stringify({ version: 1,
		kind: "synthetic-prior-checkpoint", payload: "🙂".repeat(500_000) })}\n`, "utf8");
	assert.ok(original.length > 1_960_000);
	return { directory, original };
}

test("large prior checkpoint partitions into bounded UTF-8 text and reconstructs exact bytes", async t => {
	const { directory, original } = await fixture(t);
	const staged = await stagePriorObjectiveCheckpointEvidence(directory, original);
	assert.equal(staged.indexName, PRIOR_OBJECTIVE_CHECKPOINT_INDEX);
	assert.ok(staged.partNames.length >= 2);
	assert.deepEqual(staged.evidence.map(item => item.name), [staged.indexName, ...staged.partNames]);
	const indexBytes = await readFile(path.join(directory, staged.indexName));
	assert.ok(indexBytes.length <= 1_000_000);
	const index = JSON.parse(indexBytes.toString("utf8"));
	assert.equal(index.totalBytes, original.length);
	assert.equal(index.encoding, "utf8-concatenate-in-order-without-separators");
	assert.deepEqual(index.parts.map((item: { name: string }) => item.name), staged.partNames);
	const parts = await Promise.all(staged.partNames.map(name => readFile(path.join(directory, name))));
	for (const part of parts) {
		assert.ok(part.length <= 1_000_000);
		assert.doesNotThrow(() => new TextDecoder("utf-8", { fatal: true }).decode(part));
	}
	assert.deepEqual(Buffer.concat(parts), original);
	assert.deepEqual(await verifyPriorObjectiveCheckpointEvidence(directory, original), staged);
});

test("same-size tampering in one staged part fails full byte authentication", async t => {
	const { directory, original } = await fixture(t);
	const staged = await stagePriorObjectiveCheckpointEvidence(directory, original);
	const file = path.join(directory, staged.partNames[0]!);
	const changed = await readFile(file);
	changed[100] = changed[100] === 0x58 ? 0x59 : 0x58;
	await writeFile(file, changed);
	await assert.rejects(verifyPriorObjectiveCheckpointEvidence(directory, original),
		/prior objective checkpoint parts differ/);
});

test("missing part and changed index fail before evidence can be returned", async t => {
	const { directory, original } = await fixture(t);
	const staged = await stagePriorObjectiveCheckpointEvidence(directory, original);
	const file = path.join(directory, staged.partNames.at(-1)!);
	await rm(file);
	await assert.rejects(verifyPriorObjectiveCheckpointEvidence(directory, original),
		/prior objective checkpoint evidence is missing or invalid/);
	await writeFile(file, original.subarray(1_000_000));
	await writeFile(path.join(directory, staged.indexName), Buffer.from("{}\n"));
	await assert.rejects(verifyPriorObjectiveCheckpointEvidence(directory, original),
		/prior objective checkpoint index differs/);
});

test("a symlink cannot substitute for a staged regular part", async t => {
	const { directory, original } = await fixture(t);
	const staged = await stagePriorObjectiveCheckpointEvidence(directory, original);
	const file = path.join(directory, staged.partNames[0]!);
	const alternate = path.join(directory, "alternate.txt");
	await writeFile(alternate, await readFile(file));
	await rm(file);
	await symlink(alternate, file);
	await assert.rejects(verifyPriorObjectiveCheckpointEvidence(directory, original),
		/prior objective checkpoint evidence is missing or invalid/);
});
