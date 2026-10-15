import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { generateSourceCandidate } from "../src/improvement/source-candidate.ts";
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
  return { text: ["The feedback handoff deserves a targeted source change.", "```ts",
   "export const note = { source: 'M07' };", "```", "```json",
   JSON.stringify({ claim: "A handoff behavior may need revision", predictedObservation: "new behavior appears", falsifier: "old behavior persists", optionalNote: "additional commentary remains compatible" }),
   "```"].join("\n"), usage: { input: 12, output: 8, totalTokens: 20, cost: 0.001 } };
 });
 const result = await generateSourceCandidate({ ...f.base, runner, developmentBrief: "Investigate the frozen handoff observation" });
 assert.equal(result.status, "committed", result.reason);
 assert.deepEqual(result.hypothesis, { claim: "A handoff behavior may need revision", predictedObservation: "new behavior appears", falsifier: "old behavior persists" });
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

test("builder corrects a prose-plus-raw-JSON handoff in the same session and commits the checked edit", async t => {
 const f = await fixture(t);
 const hypothesis = { claim: "The handoff omits evidence", predictedObservation: "The new behavior appears", falsifier: "The omission persists" };
 const first = `I edited the feedback source.\n${JSON.stringify(hypothesis)}`;
 let turns = 0;
 const runner = new FakeSessionRunner(async ctx => {
  turns++;
  if (turns === 1) {
   await ctx.tools.read({ path: ".source-candidate-evidence/D1.txt" });
   await ctx.tools.edit({ path: "src/m07/feedback.ts", oldText: "'old'", newText: "'new'" });
   return { text: first, usage: { input: 11, output: 7, cacheRead: 0, cacheWrite: 0, totalTokens: 18, cost: 0.001 } };
  }
  assert.equal(turns, 2);
  assert.match(ctx.message, /expected one complete/);
  assert.match(ctx.message, /Do not call tools or edit source/);
  return { text: JSON.stringify(hypothesis), usage: { input: 5, output: 7, cacheRead: 0, cacheWrite: 0, totalTokens: 12, cost: 0.002 } };
 });
 const result = await generateSourceCandidate({ ...f.base, runner });
 assert.equal(result.status, "committed", result.reason);
 assert.equal(result.engineeringStatus, "passed");
 assert.equal(turns, 2);
 assert.equal(runner.created.length, 1);
 assert.deepEqual(result.hypothesis, hypothesis);
 assert.equal(result.hypothesisRawText, first);
 assert.equal(result.hypothesisCorrectionRawText, JSON.stringify(hypothesis));
 assert.equal(result.usage?.totalTokens, 30);
 assert.equal(result.usage?.cost, 0.003);
 assert.equal(result.usage?.reportedEvents, 2);
 assert.equal(result.usage?.unknownEvents, 0);
 assert.equal(result.usage?.complete, true);
 assert.equal(result.usage?.costComplete, true);
 assert.deepEqual(result.toolLog?.map(item => item.name), ["read", "edit"]);
 assert.ok(result.sourceCommit);
 assert.equal(execFileSync("git", ["-C", f.candidateRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(), result.sourceCommit);
 assert.equal(JSON.parse(await readFile(f.receiptPath, "utf8")).hypothesisCorrectionRawText, JSON.stringify(hypothesis));
});

test("a second invalid handoff or provider error rejects the candidate", async t => {
 for (const failure of ["invalid", "provider"] as const) {
  const f = await fixture(t);
  const first = "Edited source.\n{\"claim\":\"hypothesis\"}";
  let turns = 0;
  const runner = new FakeSessionRunner(async ctx => {
   turns++;
   if (turns === 1) {
    await ctx.tools.edit({ path: "src/m07/feedback.ts", oldText: "'old'", newText: "'new'" });
    return { text: first, usage: { input: 8, output: 4, cacheRead: 0, cacheWrite: 0, totalTokens: 12, cost: 0.001 } };
   }
   assert.equal(turns, 2);
   if (failure === "provider") throw new Error("offline correction provider failure");
   return { text: "still no JSON", usage: { input: 3, output: 4, cacheRead: 0, cacheWrite: 0, totalTokens: 7, cost: 0.002 } };
  });
  const result = await generateSourceCandidate({ ...f.base, runner });
  assert.equal(result.status, "rejected");
  assert.equal(result.engineeringStatus, "unverified");
  assert.equal(result.hypothesisRawText, first);
  assert.equal(result.hypothesisCorrectionRawText, failure === "invalid" ? "still no JSON" : undefined);
  assert.match(result.reason!, failure === "invalid" ? /expected one complete/ : /offline correction provider failure/);
  assert.equal(result.usage?.totalTokens, failure === "provider" ? 12 : 19);
  assert.equal(result.usage?.reportedEvents, failure === "provider" ? 1 : 2);
  assert.equal(result.usage?.unknownEvents, failure === "provider" ? 1 : 0);
  assert.equal(result.usage?.complete, failure !== "provider");
  assert.equal(result.usage?.costComplete, failure !== "provider");
  assert.equal(result.toolLog?.length, 1);
  assert.equal(result.sourceCommit, undefined);
  assert.equal(turns, 2);
 }
});

test("a structured builder hypothesis preserves every nested field without another model turn", async t => {
 const f = await fixture(t);
 const claim = { statement: "The handoff can omit relevant evidence", mechanism: { step: "M07 to M04", caveat: "Author report only" } };
 const predictedObservation = { tasks: [{ taskId: "development-1", observation: "Evidence appears" },
  { taskId: "development-2", observation: "Source attribution remains" }], expected: { status: "visible", count: 2 } };
 const raw = ["Candidate edited.", "```json", JSON.stringify({ claim, predictedObservation,
  falsifier: { condition: "Omission persists", checks: ["report", "knowledge"] } }), "```"].join("\n");
 let turns = 0;
 const runner = new FakeSessionRunner(async ctx => {
  turns++;
  await ctx.tools.edit({ path: "src/m07/feedback.ts", oldText: "'old'", newText: "'new'" });
  return { text: raw, usage: { input: 15, output: 10, totalTokens: 25, cost: 0.002 } };
 });
 const result = await generateSourceCandidate({ ...f.base, runner });
 assert.equal(result.status, "committed", result.reason);
 assert.equal(turns, 1);
 assert.deepEqual(JSON.parse(result.hypothesis!.claim), claim);
 assert.deepEqual(JSON.parse(result.hypothesis!.predictedObservation), predictedObservation);
 assert.deepEqual(JSON.parse(result.hypothesis!.falsifier), { condition: "Omission persists", checks: ["report", "knowledge"] });
 assert.equal(result.hypothesisRawText, raw);
 assert.equal(result.usage?.totalTokens, 25);
 assert.equal(result.engineeringStatus, "passed");
 assert.equal(JSON.parse(await readFile(f.receiptPath, "utf8")).hypothesisRawText, raw);
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
