import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { prepareWorkflowCodeSource } from "../scripts/prepare-workflow-source.ts";
import { runWorkflowSourceSearch } from "../src/improvement/workflow-source-search.ts";
import { openWorkflowImproverProcess } from "../src/improvement/workflow-improver-process.ts";
import type { LoadedSourceV1 } from "../src/runtime/loaded-source.ts";
import type { UsageSummary } from "../src/runner/types.ts";
import { FakeSessionRunner } from "../src/runner/fake.ts";
import { writeControlledSourceImproverSeed } from "./fixtures/source-improver-test-seed.ts";

const completeUsage = (): UsageSummary => ({ input: 2, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: 0.001,
 reportedEvents: 1, unknownEvents: 0, complete: true, costComplete: true });

async function fixture(t: test.TestContext) {
 const root = await mkdtemp(path.join(os.tmpdir(), "workflow-source-search-"));
 t.after(async () => { const thaw = async (file: string): Promise<void> => {
  const info = await lstat(file); if (info.isSymbolicLink()) return;
  await chmod(file, info.isDirectory() ? 0o700 : 0o600);
  if (info.isDirectory()) for (const name of await readdir(file)) await thaw(path.join(file, name));
 }; await thaw(root); await rm(root, { recursive: true, force: true }); });
 const repo = path.join(root, "repo"); await mkdir(repo);
 await cp(path.resolve("src"), path.join(repo, "src"), { recursive: true });
 for (const dir of ["extensions", "workflow", "tools"]) { await mkdir(path.join(repo, dir)); await writeFile(path.join(repo, dir, "fixture.txt"), "fixture\n"); }
 await cp(path.resolve("package.json"), path.join(repo, "package.json"));
 await symlink(path.resolve("node_modules"), path.join(repo, "node_modules"), "dir");
 // Keep a controlled improver for the search lifecycle cases.
 await writeControlledSourceImproverSeed(repo);
 const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
 git("init", "-q"); git("config", "user.name", "Offline Fixture"); git("config", "user.email", "fixture@example.invalid");
 git("add", "src", "extensions", "workflow", "tools", "package.json"); git("commit", "-qm", "Seed I source");
 const seed = await prepareWorkflowCodeSource(repo, git("rev-parse", "HEAD"), path.join(root, "seed-source"));
 const workspaceRoot = path.join(root, "workspace"); await mkdir(workspaceRoot);
 await writeFile(path.join(workspaceRoot, "research.config.json"), JSON.stringify({ roles: { improver: "fake/improver" }, tools: {}, concurrency: 1 }));
 return { root, repo, seed, workspaceRoot };
}

function runArgs(f: Awaited<ReturnType<typeof fixture>>, source: LoadedSourceV1, suffix: string, runner: FakeSessionRunner) {
 const usage = completeUsage();
 return { workspaceRoot: f.workspaceRoot, persistDir: path.join(f.root, `sessions-${suffix}`), receiptPath: path.join(f.root, `search-${suffix}.json`),
  source, improverVersionId: `I-${suffix}`, runner, signal: new AbortController().signal,
  editTarget: { kind: "H-executor" as const, objective: "Improve development evidence handoff", writableFiles: ["src/m07/feedback.ts"] },
  baseline: { bundleId: `G-${suffix}`, executorVersionId: `H-${suffix}`, executorSource: f.seed, developmentSetId: `D-${suffix}` },
  development: [{ id: "D1", text: "First frozen development observation" }, { id: "D2", text: "Second frozen development observation" }],
  proposeSource: async (request: { brief: string; model: string; editTarget: { kind: string; writableFiles: string[] }; evidence: Array<{ id: string; text: string }> }) => {
   assert.ok(request.editTarget.kind && request.editTarget.writableFiles.length === 1);
   assert.ok(request.brief.length > 0); assert.ok(request.evidence.length > 0); assert.equal(request.model, "fake/improver");
   const receiptPath = path.join(f.root, `candidate-${suffix}.json`);
   await writeFile(receiptPath, JSON.stringify({ version: 1, status: "committed", engineeringStatus: "passed",
    sourceCommit: source.sourceCommit, snapshot: { sourceRoot: source.sourceRoot, sourceCommit: source.sourceCommit } }));
   return { id: `C-${suffix}`, status: "ready" as const, sourceRoot: source.sourceRoot, sourceCommit: source.sourceCommit, receiptPath, usage };
  },
  evaluateDevelopment: async (request: { candidate: { id: string } }) => { const receiptPath = path.join(f.root, `evaluation-${suffix}.json`);
   await writeFile(receiptPath, JSON.stringify({ version: 1, candidateId: request.candidate.id }));
   return { candidateId: request.candidate.id, status: "preferred" as const,
    reason: "development comparator preferred candidate", receiptPath, usage }; },
 };
}


test("source evaluation stays pending on disk until it settles", async t => {
 const f = await fixture(t);
 let release!: () => void;
 let entered!: () => void;
 const held = new Promise<void>(resolve => { release = resolve; });
 const started = new Promise<void>(resolve => { entered = resolve; });
 const runner = new FakeSessionRunner(() => ({ text: JSON.stringify({ brief: "Investigate evidence handoff" }),
   usage: { input: 4, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 7, cost: 0.002 } }));
 const base = runArgs(f, f.seed, "pending-evaluation", runner);
 const run = runWorkflowSourceSearch({ ...base,
  evaluateDevelopment: async request => {
   entered(); await held;
   return base.evaluateDevelopment(request);
  } });
 try {
  await started;
  const saved = JSON.parse(await readFile(base.receiptPath, "utf8"));
  assert.equal(saved.status, "running");
  assert.equal(saved.actions.at(-1).action.kind, "evaluate-development");
  assert.equal(saved.actions.at(-1).outcome, "pending");
  assert.equal(saved.selectionReceiptPath, undefined);
 } finally { release(); }
 const result = await run;
 assert.equal(result.status, "selected", result.reason);
 assert.equal(result.actions.find(item => item.action.kind === "evaluate-development")?.outcome, "completed");
 assert.equal(JSON.parse(await readFile(base.receiptPath, "utf8")).actions.find((item: { action: { kind: string } }) =>
  item.action.kind === "evaluate-development").outcome, "completed");
 assert.ok(result.actions.every(item => item.outcome !== "pending"));
 assert.ok(JSON.parse(await readFile(result.selectionReceiptPath!, "utf8")).actions.every((item: { outcome: string }) =>
  item.outcome !== "pending"));
});

test("an I source cannot select an unregistered or unevaluated candidate", async t => {
 const f = await fixture(t);
 const program = path.join(f.repo, "src/improvement/workflow-improver-program.ts");
 await writeFile(program, "export function decideWorkflowImprovement() { return {kind:'stop',candidateId:'ghost',reason:'unearned selection'}; }\n");
 const git = (...args: string[]) => execFileSync("git", ["-C", f.repo, ...args], { encoding: "utf8" }).trim();
 git("add", "src/improvement/workflow-improver-program.ts"); git("commit", "-qm", "Invalid selection fixture");
 const source = await prepareWorkflowCodeSource(f.repo, git("rev-parse", "HEAD"), path.join(f.root, "invalid-source"));
 const runner = new FakeSessionRunner(() => "unused");
 const result = await runWorkflowSourceSearch(runArgs(f, source, "invalid", runner));
 assert.equal(result.status, "incomplete");
 assert.match(result.reason!, /not registered and development-evaluated/);
 assert.equal(result.selectedCandidateId, undefined);
 assert.equal(result.modelSessions.length, 0);
});

test("invalid model JSON is a development observation that the same I source can repair", async t => {
 const f = await fixture(t);
 let calls = 0;
 const runner = new FakeSessionRunner(ctx => { if (calls === 1) assert.equal(JSON.parse(ctx.message).priorObservations[0].text, "not JSON");
  return { text: ++calls === 1 ? "not JSON" : JSON.stringify({ brief: "Investigate handoff" }),
  usage: { input: 4, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 7, cost: 0.002 } }; });
 const args = runArgs(f, f.seed, "repair", runner);
 const result = await runWorkflowSourceSearch({ ...args, evaluateDevelopment: async request => {
  const receiptPath = path.join(f.root, "rejected-evaluation.json"); await writeFile(receiptPath, JSON.stringify({ candidateId: request.candidate.id }));
  return { candidateId: request.candidate.id, status: "rejected", reason: "development comparator rejected candidate", receiptPath, usage: completeUsage() };
 } });
 assert.equal(result.status, "no-winner");
 assert.deepEqual(result.modelSessions.map(item => item.status), ["parse-error", "returned"]);
 assert.equal(result.modelSessions[0]?.usage?.complete, true);
 assert.equal(result.selectedCandidateId, undefined);
});

test("a provider failure is recorded as unsettled and cannot become a complete no-winner", async t => {
 const f = await fixture(t);
 const runner = new FakeSessionRunner(() => { throw new Error("offline provider failure"); });
 const result = await runWorkflowSourceSearch(runArgs(f, f.seed, "provider-failure", runner));
 assert.equal(result.status, "incomplete");
 assert.equal(result.modelSessions[0]?.status, "provider-failed");
 assert.equal(result.usage.usageUnknown, true);
 assert.equal(result.selectedCandidateId, undefined);
 assert.match(result.actions.find(item => item.action.kind === "ask-model")?.reason ?? "", /offline provider failure/);
});

test("a nonsettling loaded I decision is killed by the caller signal", async t => {
 const f = await fixture(t);
 const program = path.join(f.repo, "src/improvement/workflow-improver-program.ts");
 await writeFile(program, "export function decideWorkflowImprovement() { return new Promise(() => {}); }\n");
 const git = (...args: string[]) => execFileSync("git", ["-C", f.repo, ...args], { encoding: "utf8" }).trim();
 git("add", "src/improvement/workflow-improver-program.ts"); git("commit", "-qm", "Nonsettling I fixture");
 const source = await prepareWorkflowCodeSource(f.repo, git("rev-parse", "HEAD"), path.join(f.root, "nonsettling-source"));
 const controller = new AbortController();
 const process = await openWorkflowImproverProcess(source, "I-nonsettling", controller.signal);
 const decision = process.decide({ version: 1, improverVersionId: "I-nonsettling", availableDevelopmentIds: [],
  inspectedDevelopment: [], modelObservations: [], candidates: [], evaluations: [], operationFailures: [] });
 controller.abort();
 await assert.rejects(decision, /exited before completing decision/);
 await process.close();
});
