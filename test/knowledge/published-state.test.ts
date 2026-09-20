/**
 * T32 (手册验收用例): a merge interrupted after record files were written but before
 * CURRENT moved must leave readers on the previous complete state, and the next merge
 * must still be able to proceed.
 */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { createFileKnowledgeStore } from "../../src/knowledge/store.ts";

describe("published state and interrupted merges", () => {
	let dir: string;
	const store = () => createFileKnowledgeStore(path.join(dir, "knowledge"));

	before(async () => {
		dir = await mkdtemp(path.join(os.tmpdir(), "harness-published-"));
		await store().init();
	});
	after(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("hides unpublished version files and lets the next merge replace them", async () => {
		const s = store();
		const receipt = await s.submitProposal({ stage: "T", runId: "r1", ops: [{ op: "create", type: "C", title: "C one", body: "v1 body", usageDecision: "candidate" }] });
		assert.ok(receipt.structurallyValid);
		const merged = await s.merge(receipt.proposalId);
		assert.equal(merged.snapshot.id, "G001");

		// Simulate an interrupted merge: v2 written, CURRENT never moved.
		const v1 = await readFile(path.join(dir, "knowledge", "records", "C001", "v1.md"), "utf8");
		await writeFile(path.join(dir, "knowledge", "records", "C001", "v2.md"), v1.replace('version: 1', 'version: 2').replace("v1 body", "orphan body"));
		// And an orphan record directory that no snapshot lists.
		await mkdir(path.join(dir, "knowledge", "records", "C002"), { recursive: true });
		await writeFile(path.join(dir, "knowledge", "records", "C002", "v1.md"), v1.replace('id: "C001"', 'id: "C002"'));

		const current = await s.get("C001");
		assert.equal(current?.version, 1, "readers stay on the published version");
		assert.equal(await s.get("C001", 2), undefined, "unpublished version is invisible");
		assert.equal(await s.get("C002"), undefined, "orphan record is invisible");
		assert.deepEqual((await s.list()).map((r) => r.id), ["C001"]);

		const pack = await s.buildPack({ purpose: "t" });
		assert.ok(pack.markdown.includes("v1 body") && !pack.markdown.includes("orphan body"));

		const revise = await s.submitProposal({ stage: "T", runId: "r2", ops: [{ op: "revise", id: "C001", body: "v2 real body", reason: "test" }] });
		assert.ok(revise.structurallyValid, revise.issues.map((i) => i.message).join(";"));
		const result = await s.merge(revise.proposalId);
		assert.equal(result.snapshot.id, "G002");
		assert.ok(result.warnings.some((w) => w.includes("残留版本")), "overwrite of the orphan is reported");
		assert.equal((await s.get("C001"))?.body, "v2 real body");

		// A published version can never be overwritten.
		const again = await s.submitProposal({ stage: "T", runId: "r3", ops: [{ op: "create", type: "C", title: "C three", body: "x" }] });
		await s.merge(again.proposalId);
		assert.equal((await s.get("C001"))?.version, 2);
		assert.equal((await s.get("C001", 1))?.body, "v1 body", "history stays readable");
	});
});
