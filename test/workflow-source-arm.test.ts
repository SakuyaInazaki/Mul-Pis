import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { prepareWorkflowCodeSource } from "../scripts/prepare-workflow-source.ts";
import { SharedBudget } from "../src/experiments/budget.ts";
import { GenerationStore } from "../src/improvement/generation.ts";
import { ResearchImprovementService } from "../src/improvement/research-service.ts";
import { executeWorkflowSourceArm } from "../src/improvement/workflow-source-arm.ts";
import { FakeSessionRunner } from "../src/runner/fake.ts";
import { createFileKnowledgeStore } from "../src/knowledge/store.ts";
import { Workspace } from "../src/workspace.ts";

async function makeWritable(file: string): Promise<void> {
 const info = await lstat(file);
 if (info.isSymbolicLink()) return;
 if (info.isDirectory()) { await chmod(file, 0o700); for (const name of await readdir(file)) await makeWritable(path.join(file, name)); }
 else await chmod(file, 0o600);
}

test("fixed A/B source arms run M07→M04 in separate child processes with one frozen H/K/model", async t => {
 const root = await mkdtemp(path.join(os.tmpdir(), "workflow-source-arm-"));
 t.after(async () => { await makeWritable(root); await rm(root, { recursive: true, force: true }); });
 const repo = path.join(root, "repo");
 await mkdir(repo);
 for (const part of ["src", "extensions", "workflow", "tools"]) await cp(path.resolve(part), path.join(repo, part), { recursive: true });
 await cp(path.resolve("package.json"), path.join(repo, "package.json"));
 await symlink(path.resolve("node_modules"), path.join(repo, "node_modules"), "dir");
 const git = (...parts: string[]) => execFileSync("git", ["-C", repo, ...parts], { encoding: "utf8" }).trim();
 git("init", "-q"); git("config", "user.name", "Offline Fixture"); git("config", "user.email", "fixture@example.invalid");
 git("add", "src", "extensions", "workflow", "tools", "package.json"); git("commit", "-qm", "Fixture source A");
 const commitA = git("rev-parse", "HEAD");
 const sourceA = await prepareWorkflowCodeSource(repo, commitA, path.join(root, "code-A"));
 await writeFile(path.join(repo, "src/m07/feedback.ts"), `${await readFile(path.join(repo, "src/m07/feedback.ts"), "utf8")}\n// Independent fixture source B.\n`);
 git("add", "src/m07/feedback.ts"); git("commit", "-qm", "Fixture source B");
 const commitB = git("rev-parse", "HEAD");
 const sourceB = await prepareWorkflowCodeSource(repo, commitB, path.join(root, "code-B"));
 const sourceData = new Workspace(path.join(root, "research-data"));
 await mkdir(path.dirname(sourceData.problemFile), { recursive: true });
 await writeFile(sourceData.problemFile, "固定原问题与证据。\n");
 await writeFile(sourceData.configFile, JSON.stringify({ roles: { default: "fake/default", execution: "fake/execution", reviewer: "fake/reviewer", improver: "fake/improver", research: "fake/research" }, concurrency: 1, tools: {} }));
 const knowledge = createFileKnowledgeStore(sourceData.knowledgeDir); await knowledge.init();
 const k = (await knowledge.current())?.id;
 const formal = await sourceData.startRun("M04", [{ label: "原问题", path: sourceData.problemFile }], k);
 await sourceData.finishRun(formal, "completed");
 const research = new ResearchImprovementService({ workspaceRoot: sourceData.root, runner: new FakeSessionRunner(() => "unused") });
 const bundle = await research.bootstrap({ version: 1, executor: { version: 1, kind: "m07-workflow-prompt", slot: "evidence-handoff", body: "忠实交接固定证据与限制。" }, improver: { version: 1, kind: "diagnostic-improver-prompt", body: "分析开发反馈。" }, applicability: ["M07"] });
 const store = new GenerationStore(sourceData.root);
 const h = await store.readStrategy(bundle.executorVersionId), i = await store.readStrategy(bundle.improverVersionId);
 const fakeReplyModule = path.join(root, "offline-reply.mjs");
 await writeFile(fakeReplyModule, `export default function reply({spec}) { return { text: spec.role === "research" ? "已处理冻结 M07 证据。" : "原始证据完整。", usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 120, cost: 0.001 } }; }\n`);
 const caseInput = { id: "fixture", goal: { goal: "核对交接", problemRelation: "直接关联", constraints: ["原目标不变"], successCriteria: ["保留原始证据"], plan: "固定交接", exploratory: false }, task: { objective: "交接固定证据", inputs: [], expectedOutputs: [], checks: ["证据完整"], mode: "reason" as const }, checks: [{ criterion: "证据完整", contains: ["证据完整"], forbids: ["伪造"] }] };
 const budget = new SharedBudget("source-arm-test", {});
 let beforePrompts = 0;
 const options = { runnerKind: "fake" as const, fakeReplyModule, budget, lease: budget.root, beforePrompt: async () => { beforePrompts++; } };
 const args = { sourceWorkspaceRoot: sourceData.root, bundle, h, i, caseInput, builtinBaseline: false, formalRunId: formal.runId };
 const a = await executeWorkflowSourceArm(sourceA, { ...args, root: path.join(root, "arm-A"), arm: "baseline" }, options);
 const b = await executeWorkflowSourceArm(sourceB, { ...args, root: path.join(root, "arm-B"), arm: "candidate" }, options);
 assert.equal(a.status, "complete", a.reason);
 assert.equal(b.status, "complete", b.reason);
 assert.notEqual(a.childPid, b.childPid);
 assert.equal(a.loadedSource.sourceCommit, commitA);
 assert.equal(b.loadedSource.sourceCommit, commitB);
 assert.equal(a.methodVersionId, b.methodVersionId);
 assert.equal(a.checkResults[0]?.passed, true);
 assert.equal(b.checkResults[0]?.passed, true);
 assert.equal(beforePrompts, 4);
 assert.equal(budget.status().committed.providerCalls, 4);
 for (const arm of [a, b]) {
  const ws = new Workspace(arm.workspaceRoot);
  const savedGoal = JSON.parse(await readFile(path.join(ws.runDir("M07", arm.m07RunId!), "goal.json"), "utf8"));
  assert.equal(savedGoal.knowledgeSnapshot, k);
  assert.equal(savedGoal.workflowMethod.versionId, h.versionId);
  assert.equal(savedGoal.executionState.attempts[0].runDescriptor.loadedSource.sourceCommit, arm.loadedSource.sourceCommit);
  const m04 = await ws.readRun("M04", arm.m04RunId!);
  assert.equal(m04.sessions[0]?.model, "fake/research");
 }
 const casesPath = path.join(sourceData.root, "source-cases.json");
 await writeFile(casesPath, JSON.stringify({ version: 1, split: "development", cases: [caseInput] }));
 const activeBefore = await readFile(path.join(store.root, "active.json"), "utf8");
 const comparison = await research.compareWorkflowSources({ version: 1, kind: "m07-source-comparison/v1", caseSetPath: "source-cases.json",
  experimentRoot: path.join(root, "source-comparison"), baseline: "active-h", repetitions: 2,
  sources: { baseline: { sourceRoot: sourceA.sourceRoot, sourceCommit: sourceA.sourceCommit },
   candidate: { sourceRoot: sourceB.sourceRoot, sourceCommit: sourceB.sourceCommit } } }, { runnerKind: "fake", fakeReplyModule });
 assert.equal(comparison.status, "complete", comparison.stopReason);
 assert.equal(comparison.pairs.length, 2);
 assert.deepEqual(comparison.pairs.map(pair => pair.executionOrder), [["A", "A2"], ["A2", "A"]]);
 const comparedArms = comparison.pairs.flatMap(pair => [pair.armA, pair.armA2]);
 assert.equal(new Set(comparedArms.map(arm => arm.childPid)).size, 4);
 assert.deepEqual(comparedArms.map(arm => arm.loadedSource?.sourceCommit), [commitA, commitB, commitA, commitB]);
 assert.ok(comparedArms.every(arm => arm.methodVersionId === h.versionId && arm.status === "complete"));
 assert.equal(await readFile(path.join(store.root, "active.json"), "utf8"), activeBefore);
 const beforeBad = beforePrompts;
 await assert.rejects(executeWorkflowSourceArm({ ...sourceA, sourceCommit: commitB }, { ...args, root: path.join(root, "bad-arm"), arm: "baseline" }, options), /source revision differs|different|source arm/);
 assert.equal(beforePrompts, beforeBad);
 await assert.rejects(executeWorkflowSourceArm(sourceA, { ...args, root: path.join(root, "bad-runner"), arm: "baseline" }, { ...options, fakeReplyModule: path.join(root, "missing-reply.mjs") }), /Cannot find module|source arm/);
 assert.equal(budget.status().inFlight, false);
 const crashReply = path.join(root, "crash-reply.mjs");
 await writeFile(crashReply, "export default function reply() { process.exit(23); }\n");
 const crashBudget = new SharedBudget("crashed-source-arm", {});
 await assert.rejects(executeWorkflowSourceArm(sourceA, { ...args, root: path.join(root, "crashed-arm"), arm: "baseline" },
  { ...options, budget: crashBudget, lease: crashBudget.root, fakeReplyModule: crashReply }), /process failed/);
 assert.equal(crashBudget.status().inFlight, false);
 assert.equal(crashBudget.status().usageUnknown, true);
});
