import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { prepareWorkflowCodeSource } from "../scripts/prepare-workflow-source.ts";
import { generateSourceCandidate } from "../src/improvement/source-candidate.ts";
import { GenerationStore, validateStrategy } from "../src/improvement/generation.ts";
import { FakeSessionRunner } from "../src/runner/fake.ts";

async function fixture(t: test.TestContext) {
 const root = await mkdtemp(path.join(os.tmpdir(), "source-candidate-"));
 t.after(async () => { const thaw = async (file: string): Promise<void> => {
  const info = await lstat(file); if (info.isSymbolicLink()) return;
  await chmod(file, info.isDirectory() ? 0o700 : 0o600);
  if (info.isDirectory()) for (const name of await readdir(file)) await thaw(path.join(file, name));
 }; await thaw(root); await rm(root, { recursive: true, force: true }); });
 const repository = path.join(root, "repo");
 await mkdir(path.join(repository, "src/m07"), { recursive: true });
 await mkdir(path.join(repository, "src/runtime"), { recursive: true });
 for (const dir of ["extensions", "workflow", "tools"]) {
  await mkdir(path.join(repository, dir));
  await writeFile(path.join(repository, dir, "fixture.txt"), "fixture\n");
 }
 await writeFile(path.join(repository, "src/m07/feedback.ts"), "export function writeFeedback() { return 'old'; }\n");
 await writeFile(path.join(repository, "src/runtime/loaded-source.ts"), "export const loaded = true;\n");
 await writeFile(path.join(repository, "package.json"), "{\"type\":\"module\"}\n");
 await symlink(path.resolve("node_modules"), path.join(repository, "node_modules"), "dir");
 const git = (...args: string[]) => execFileSync("git", ["-C", repository, ...args], { encoding: "utf8" }).trim();
 git("init", "-q"); git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.invalid");
 git("add", "src", "extensions", "workflow", "tools", "package.json"); git("commit", "-qm", "Fixture baseline");
 const parentCommit = git("rev-parse", "HEAD");
 const evidence = path.join(root, "development.txt");
 await writeFile(evidence, "A completed development observation.\n");
 const candidateRoot = path.join(root, "candidate");
 const receiptPath = path.join(root, "receipt.json");
 return { root, repository, parentCommit, evidence, candidateRoot, receiptPath,
  base: { repository, parentCommit, candidateRoot, snapshotRoot: path.join(root, "snapshot"), receiptPath,
   persistDir: path.join(root, "sessions"), model: "fake/improver", writableFiles: ["src/m07/feedback.ts"],
   developmentEvidence: [{ id: "D1", path: evidence }], checks: [{ name: "syntax", executable: process.execPath,
    args: ["-e", "require('fs').readFileSync('src/m07/feedback.ts','utf8').includes('new') || process.exit(1)"] }] } };
}

test("a fake model edits an isolated source tree and produces a private commit and read-only snapshot", async t => {
 const f = await fixture(t);
 const runner = new FakeSessionRunner(async ctx => {
  assert.equal(JSON.parse(ctx.message).developmentBrief, "Investigate the frozen handoff observation");
  await ctx.tools.read({ path: ".source-candidate-evidence/D1.txt" });
  await ctx.tools.edit({ path: "src/m07/feedback.ts", oldText: "'old'", newText: "'new'" });
  return { text: JSON.stringify({ claim: "A handoff behavior may need revision", predictedObservation: "new behavior appears", falsifier: "old behavior persists" }),
   usage: { input: 12, output: 8, totalTokens: 20, cost: 0.001 } };
 });
 const result = await generateSourceCandidate({ ...f.base, runner, developmentBrief: "Investigate the frozen handoff observation" });
 assert.equal(result.status, "committed", result.reason);
 assert.equal(result.engineeringStatus, "passed");
 assert.deepEqual(result.changedFiles, ["src/m07/feedback.ts"]);
 assert.match(result.diff, /'new'/);
 assert.equal(result.usage?.totalTokens, 20);
 assert.equal(result.session?.model, "fake/improver");
 assert.equal(execFileSync("git", ["-C", f.candidateRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(), result.sourceCommit);
 assert.equal(await readFile(path.join(f.repository, "src/m07/feedback.ts"), "utf8"), "export function writeFeedback() { return 'old'; }\n");
 assert.match(await readFile(path.join(result.snapshot!.sourceRoot, "src/m07/feedback.ts"), "utf8"), /'new'/);
 assert.equal(JSON.parse(await readFile(f.receiptPath, "utf8")).sourceCommit, result.sourceCommit);
});

test("full Git status rejects a control file edit even when the confined grant was narrow", async t => {
 const f = await fixture(t);
 const runner = new FakeSessionRunner(async ctx => {
  await assert.rejects(ctx.tools.write({ path: "src/runtime/loaded-source.ts", content: "bad" }), /allowlist/);
  await ctx.tools.edit({ path: "src/m07/feedback.ts", oldText: "'old'", newText: "'new'" });
  await writeFile(path.join(f.candidateRoot, "src/runtime/loaded-source.ts"), "export const loaded = false;\n");
  return JSON.stringify({ claim: "candidate", predictedObservation: "change", falsifier: "no change" });
 });
 const result = await generateSourceCandidate({ ...f.base, runner });
 assert.equal(result.status, "rejected");
 assert.match(result.reason!, /outside the declared source allowlist/);
 assert.ok(result.changedFiles.includes("src/runtime/loaded-source.ts"));
 assert.equal(result.sourceCommit, undefined);
});

test("an empty edit is rejected and a failing engineering check remains visible", async t => {
 const empty = await fixture(t);
 const noEdit = new FakeSessionRunner(() => JSON.stringify({ claim: "no edit", predictedObservation: "none", falsifier: "change" }));
 const rejected = await generateSourceCandidate({ ...empty.base, runner: noEdit });
 assert.equal(rejected.status, "rejected");
 assert.match(rejected.reason!, /no source change/);
 assert.equal(rejected.sourceCommit, undefined);
 const failed = await fixture(t);
 const edit = new FakeSessionRunner(async ctx => {
  await ctx.tools.edit({ path: "src/m07/feedback.ts", oldText: "'old'", newText: "'new'" });
  return JSON.stringify({ claim: "candidate", predictedObservation: "change", falsifier: "no change" });
 });
 const result = await generateSourceCandidate({ ...failed.base, runner: edit,
  checks: [{ name: "offline-failure", executable: process.execPath, args: ["-e", "process.exit(3)"] }] });
 assert.equal(result.status, "committed");
 assert.equal(result.engineeringStatus, "failed");
 assert.equal(result.checks[0]?.exitCode, 3);
 assert.ok(result.sourceCommit);
});

test("source H and I have separate typed bindings and cannot enter the prompt admission path", async t => {
 const f = await fixture(t);
 const store = new GenerationStore(f.root);
 const sourceRoot = path.join(f.root, "prepared");
 const artifact = { version: 1 as const, kind: "source-executor" as const, sourceRoot,
  sourceCommit: f.parentCommit, modulePath: "src/m07/feedback.ts", exportName: "writeFeedback" };
 assert.deepEqual(validateStrategy("executor", artifact), artifact);
 assert.throws(() => validateStrategy("executor", { ...artifact, body: "" }), /pinned source/);
 assert.throws(() => validateStrategy("executor", { ...artifact, modulePath: "../control.ts" }), /modulePath/);
 assert.throws(() => validateStrategy("improver", artifact), /pinned source/);
 const h = await store.writeStrategy({ versionId: "H-source", kind: "executor", artifact, origin: "agent-generated", applicability: ["M07"], limitations: [], state: "research-only" });
 const i = await store.writeStrategy({ versionId: "I-prompt", kind: "improver", artifact: { version: 1, kind: "diagnostic-improver-prompt", body: "Inspect evidence." }, origin: "human-seed", applicability: ["M07"], limitations: [], state: "manual-active" });
 const bundle = await store.writeBundle({ bundleId: "G-source", parents: [], executorVersionId: h.versionId, improverVersionId: i.versionId,
  environmentVersion: "m07-workflow/v1", modelConfig: { improver: "fake/improver", research: "fake/research" }, protocolVersion: "source-test/v1",
  allowedCapabilities: ["m07-evidence-read"], state: "research-only" });
 const bindings = await store.sourceBindings(bundle.bundleId);
 assert.equal(bindings.executor?.sourceCommit, f.parentCommit);
 assert.equal(bindings.improver, undefined);
 await assert.rejects(store.activate(bundle.bundleId, undefined, "local-workflow-handoff-admission", "fake"), /independently verified admission/);
 assert.equal(await store.active(), undefined);
});

test("a prepared source snapshot can import its own candidate builder without scripts", async t => {
 const f = await fixture(t);
 await cp(path.resolve("src"), path.join(f.repository, "src"), { recursive: true, force: true });
 execFileSync("git", ["-C", f.repository, "add", "src"]);
 execFileSync("git", ["-C", f.repository, "commit", "-qm", "Snapshot import fixture"]);
 const commit = execFileSync("git", ["-C", f.repository, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
 const snapshot = await prepareWorkflowCodeSource(f.repository, commit, path.join(f.root, "self-contained-source"));
 const imported = await import(pathToFileURL(path.join(snapshot.sourceRoot, "src/improvement/source-candidate.ts")).href);
 assert.equal(typeof imported.generateSourceCandidate, "function");
});

test("an active builder prompt is aborted and its rejected receipt retains the session", async t => {
 const f = await fixture(t);
 const controller = new AbortController();
 let started!: () => void;
 const seen = new Promise<void>(resolve => { started = resolve; });
 const runner = new FakeSessionRunner(async () => { started(); return new Promise<never>(() => {}); });
 const pending = generateSourceCandidate({ ...f.base, runner, signal: controller.signal });
 await seen; controller.abort();
 const result = await pending;
 assert.equal(result.status, "rejected");
 assert.match(result.reason!, /aborted/);
 assert.equal(result.session?.model, "fake\/improver");
 assert.equal(result.usage?.complete, false);
 assert.equal(result.sourceCommit, undefined);
});

test("a hanging engineering check ends on explicit cancellation", async t => {
 const f = await fixture(t);
 const controller = new AbortController();
 const runner = new FakeSessionRunner(async ctx => {
  await ctx.tools.edit({ path: "src/m07/feedback.ts", oldText: "'old'", newText: "'new'" });
  return JSON.stringify({ claim: "candidate", predictedObservation: "change", falsifier: "no change" });
 });
 const timeout = setTimeout(() => controller.abort(), 800);
 const result = await generateSourceCandidate({ ...f.base, runner, signal: controller.signal,
  checks: [{ name: "hang", executable: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"] }] }
 );
 clearTimeout(timeout);
 assert.equal(result.status, "rejected");
 assert.match(result.reason!, /cancelled/);
});
