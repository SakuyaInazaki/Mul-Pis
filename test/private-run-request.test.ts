import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("offline run-request descriptor supports initial and later fast-forward control commits", async t => {
	const dir = await mkdtemp(path.join(os.tmpdir(), "mul-pis-run-request-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
	git("init", "-q"); git("config", "user.name", "Offline Test");
	git("config", "user.email", "offline@example.invalid");
	await writeFile(path.join(dir, "source.txt"), "first\n");
	git("add", "source.txt"); git("commit", "-qm", "source one");
	const sourceOne = git("rev-parse", "HEAD");
	const script = fileURLToPath(new URL("../scripts/prepare-private-run-request.ts", import.meta.url));
	const descriptor = (source: string, prior?: string) => JSON.parse(execFileSync(process.execPath,
		[script, "--source", source, ...(prior ? ["--previous-control", prior] : [])],
		{ cwd: dir, encoding: "utf8" }));
	const initial = descriptor(sourceOne, sourceOne);
	assert.deepEqual(initial.parents, [sourceOne]);
	assert.equal(initial.message, "Run confidential workflow");
	assert.equal(initial.ref, "refs/heads/run-requests/workflow-learning-reliability");
	const priorControl = git("commit-tree", initial.tree, "-p", sourceOne, "-m", initial.message);
	await writeFile(path.join(dir, "source.txt"), "second\n");
	git("add", "source.txt"); git("commit", "-qm", "source two");
	const sourceTwo = git("rev-parse", "HEAD");
	const statusBefore = git("status", "--porcelain");
	const next = descriptor(sourceTwo, priorControl);
	assert.deepEqual(next.parents, [sourceTwo, priorControl]);
	assert.equal(next.tree, git("rev-parse", `${sourceTwo}^{tree}`));
	assert.equal(git("status", "--porcelain"), statusBefore, "descriptor must not mutate the repo");
});
