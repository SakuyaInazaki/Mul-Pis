import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { copySnapshotBounded } from "../src/m07/projection.ts";

async function scratch(t: TestContext): Promise<string> {
	const root = await mkdtemp(path.join(tmpdir(), "m07-projection-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	return root;
}

test("exclusive snapshot collision retains the prior bytes", async t => {
	const root = await scratch(t);
	const source = path.join(root, "source.txt"), snapshot = path.join(root, "snapshot.txt");
	await writeFile(source, "new bytes\n");
	await writeFile(snapshot, "prior bytes\n");
	await assert.rejects(copySnapshotBounded(source, snapshot, 100), { code: "EEXIST" });
	assert.equal(await readFile(snapshot, "utf8"), "prior bytes\n");
});

test("over-budget streaming removes only the partial snapshot", async t => {
	const root = await scratch(t);
	const source = path.join(root, "source.bin"), snapshot = path.join(root, "snapshot.bin");
	await writeFile(source, Buffer.alloc(128 * 1024, 0x61));
	await assert.rejects(copySnapshotBounded(source, snapshot, 80 * 1024), /projection snapshot budget exceeded/);
	await assert.rejects(stat(snapshot), { code: "ENOENT" });
});

test("source stream failure removes the target opened by this call", async t => {
	const root = await scratch(t);
	const source = path.join(root, "absent.txt"), snapshot = path.join(root, "snapshot.txt");
	await assert.rejects(copySnapshotBounded(source, snapshot, 100), { code: "ENOENT" });
	await assert.rejects(stat(snapshot), { code: "ENOENT" });
});

test("normal bounded copy preserves source bytes", async t => {
	const root = await scratch(t);
	const source = path.join(root, "source.txt"), snapshot = path.join(root, "snapshot.txt");
	const content = "normal copy\n";
	await writeFile(source, content);
	assert.equal(await copySnapshotBounded(source, snapshot, 100), Buffer.byteLength(content));
	assert.equal(await readFile(snapshot, "utf8"), content);
});
