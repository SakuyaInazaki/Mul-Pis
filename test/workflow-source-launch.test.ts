import assert from "node:assert/strict";
import { execFile, execFileSync, spawn } from "node:child_process";
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import test from "node:test";
import { prepareWorkflowCodeSource } from "../scripts/prepare-workflow-source.ts";

const exec = promisify(execFile);
const launcher = path.resolve("scripts/run-workflow-source.ts");
async function writableDirectories(file: string): Promise<void> {
	const info = await lstat(file);
	if (info.isDirectory()) {
		await chmod(file, 0o700);
		for (const entry of await readdir(file)) await writableDirectories(path.join(file, entry));
	}
}
async function fixture(t: test.TestContext) {
	const root = await realpath(await mkdtemp(path.join(tmpdir(), "workflow-source-launch-")));
	t.after(async () => { await writableDirectories(root); await rm(root, { recursive: true, force: true }); });
	const repo = path.join(root, "repo"), workspace = path.join(root, "workspace");
	await mkdir(workspace);
	for (const part of ["src/runtime", "extensions", "workflow", "tools", ".agent/private"]) await mkdir(path.join(repo, part), { recursive: true });
	await cp(path.resolve("src/runtime"), path.join(repo, "src/runtime"), { recursive: true });
	await writeFile(path.join(repo, "package.json"), '{"type":"module"}');
	await writeFile(path.join(repo, "extensions/research.ts"), "// fixture extension\n");
	await writeFile(path.join(repo, "workflow/rules.md"), "retained workflow\n");
	await writeFile(path.join(repo, "tools/tool.py"), "# retained adapter\n");
	await writeFile(path.join(repo, ".agent/private/account.json"), "synthetic private fixture\n");
	await symlink(await realpath("node_modules"), path.join(repo, "node_modules"), "dir");
	await writeFile(path.join(repo, "src/cli.ts"), `import { verifyLoadedSource } from './runtime/loaded-source.ts';
import { createInterface } from 'node:readline';
const binding=await verifyLoadedSource(import.meta.url);
const {version}=await import('./version.ts');
console.log(JSON.stringify({binding,version,args:process.argv.slice(2),cwd:process.cwd()}));
if(process.argv.includes('hold')) {
 const lines=createInterface({input:process.stdin});
 for await(const line of lines) { const late=await import('./late.ts'); console.log(JSON.stringify({binding,version:late.version})); break; }
 lines.close();
}
`);
	const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
	git("init", "-q");git("config", "user.name", "Offline Fixture");git("config", "user.email", "fixture@example.invalid");
	const commit = async (version: string) => {
		for (const file of ["version.ts", "late.ts"]) await writeFile(path.join(repo, "src", file), `export const version=${JSON.stringify(version)};\n`);
		git("add", "src", "extensions", "workflow", "tools", "package.json");git("commit", "-qm", `Source ${version}`);return git("rev-parse", "HEAD");
	};
	return { root, repo, workspace, git, commit };
}

test("prepared A keeps loaded and later-imported source A while checkout and new launch advance to B", async t => {
	const f = await fixture(t), a = await f.commit("A");
	const snapshotA = await prepareWorkflowCodeSource(f.repo, a, path.join(f.root, "source-A"));
	assert.equal((await lstat(path.join(snapshotA.sourceRoot, "src/cli.ts"))).mode & 0o222, 0);
	await assert.rejects(readFile(path.join(snapshotA.sourceRoot, ".agent/private/account.json")), { code: "ENOENT" });
	await assert.rejects(lstat(path.join(snapshotA.sourceRoot, ".git")), { code: "ENOENT" });
	assert.equal(await realpath(path.join(snapshotA.sourceRoot, "node_modules")), await realpath("node_modules"));
	const child = spawn(process.execPath, [launcher, snapshotA.sourceRoot, f.workspace, "harness", "hold"], { stdio: ["pipe", "pipe", "pipe"] });
	let stderr = "";child.stderr.on("data", chunk => { stderr += chunk; });
	const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
	const exit = new Promise<number | null>((resolve, reject) => { child.once("exit", resolve);child.once("error", reject); });
	t.after(() => { if (child.exitCode === null) child.kill("SIGTERM"); });
	const before = JSON.parse((await lines.next()).value!);
	assert.equal(before.version, "A");assert.equal(before.binding.sourceCommit, a);assert.equal(before.cwd, f.workspace);
	const b = await f.commit("B"), snapshotB = await prepareWorkflowCodeSource(f.repo, b, path.join(f.root, "source-B"));
	child.stdin.end("continue\n");
	const after = JSON.parse((await lines.next()).value!);
	assert.equal(after.version, "A");assert.deepEqual(after.binding, before.binding);
	assert.equal(await exit, 0, stderr);
	const fresh = JSON.parse((await exec(process.execPath, [launcher, snapshotB.sourceRoot, f.workspace, "harness", "status"], { env: { ...process.env, PRE_RSI_SOURCE_ROOT: snapshotA.sourceRoot, PRE_RSI_CODE_REVISION: a } })).stdout);
	assert.equal(fresh.version, "B");assert.equal(fresh.binding.sourceCommit, b);
	assert.deepEqual(JSON.parse(await readFile(path.join(snapshotA.sourceRoot, ".workflow-source.json"), "utf8")), snapshotA);
});

test("preparation uses an explicit commit and rejects indirect tracked source without replacing a destination", async t => {
	const f = await fixture(t), revision = await f.commit("A"), target = path.join(f.root, "source");
	await assert.rejects(prepareWorkflowCodeSource(f.repo, "HEAD", target), /full reviewed commit/);
	const receipt = await prepareWorkflowCodeSource(f.repo, revision, target);
	await assert.rejects(prepareWorkflowCodeSource(f.repo, revision, target), { code: "EEXIST" });
	assert.deepEqual(JSON.parse(await readFile(path.join(target, ".workflow-source.json"), "utf8")), receipt);
	await symlink("version.ts", path.join(f.repo, "src/indirect.ts"));
	const indirect = await f.commit("indirect");
	await assert.rejects(prepareWorkflowCodeSource(f.repo, indirect, path.join(f.root, "indirect-source")), /regular files only/);
});


test("launcher rejects a false source descriptor before the target process starts", async t => {
	const f = await fixture(t), revision = await f.commit("A");
	const snapshot = await prepareWorkflowCodeSource(f.repo, revision, path.join(f.root, "source"));
	await assert.rejects(exec(process.execPath, [launcher, snapshot.sourceRoot, f.workspace, "pi", "--mode", "json"],
		{ env: { ...process.env, PRE_RSI_RECOVER_GOAL_RUN_ID: "fixture-goal", PRE_RSI_RUN_DESCRIPTOR_FILE: "" } }), (error: unknown) => {
			const failure = error as { stdout: string; stderr: string };
			assert.equal(failure.stdout, "");
			assert.match(failure.stderr, /requires a run descriptor before launch/);
			return true;
		});
	const descriptorFile = path.join(f.root, "descriptor.json");
	const differentCommit = "b".repeat(40);
	await writeFile(descriptorFile, JSON.stringify({ version: 1, instanceId: "fixture", attemptId: "A001", workspaceId: "workspace", codeRevision: differentCommit,
		loadedSource: { sourceRoot: snapshot.sourceRoot, sourceCommit: differentCommit }, controlDir: f.workspace,
		process: { hostId: "fixture", bootId: "fixture", pid: 123, processStartToken: "fixture" } }));
	await assert.rejects(exec(process.execPath, [launcher, snapshot.sourceRoot, f.workspace, "harness", "status"],
		{ env: { ...process.env, PRE_RSI_RUN_DESCRIPTOR_FILE: descriptorFile } }), (error: unknown) => {
			const failure = error as { stdout: string; stderr: string };
			assert.equal(failure.stdout, ""); // The fixture target prints immediately on start.
			assert.match(failure.stderr, /source claim differs from the actually loaded source/);
			return true;
		});
});
