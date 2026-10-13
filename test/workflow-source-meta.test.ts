import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SharedBudget } from "../src/experiments/budget.ts";
import { GenerationStore } from "../src/improvement/generation.ts";
import { generateSourceCandidate } from "../src/improvement/source-candidate.ts";
import { runWorkflowSourceMetaComparison, type WorkflowSourceMetaInput, type WorkflowSourceMetaPlanV1 } from "../src/improvement/workflow-source-meta.ts";
import { createFileKnowledgeStore } from "../src/knowledge/store.ts";
import { prepareWorkflowCodeSource } from "../src/runtime/prepare-source.ts";
import { FakeSessionRunner } from "../src/runner/fake.ts";
import type { UsageSummary } from "../src/runner/types.ts";
import { Workspace } from "../src/workspace.ts";

const usage = (): UsageSummary => ({ input: 2, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: 0.001,
 reportedEvents: 1, unknownEvents: 0, complete: true, costComplete: true });

test("two loaded I sources produce different H descendants before any protected offspring comparison", async t => {
 const root = await mkdtemp(path.join(os.tmpdir(), "source-meta-"));
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
 const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
 git("init", "-q"); git("config", "user.name", "Offline Fixture"); git("config", "user.email", "fixture@example.invalid");
 git("add", "src", "extensions", "workflow", "tools", "package.json"); git("commit", "-qm", "Meta parent source");
 const parentCommit = git("rev-parse", "HEAD"), oldSource = await prepareWorkflowCodeSource(repo, parentCommit, path.join(root, "old-source"));
 const variantProgram = "export function decideWorkflowImprovement() { return { kind: 'stop', reason: 'development evidence does not justify a proposal' }; }\n";
 const candidateIReceipt = await generateSourceCandidate({ repository: repo, parentCommit, candidateRoot: path.join(root, "candidate-I"),
  snapshotRoot: path.join(root, "candidate-I-source"), receiptPath: path.join(root, "candidate-I.json"), persistDir: path.join(root, "I-builder-sessions"),
  runner: new FakeSessionRunner(async ctx => { await ctx.tools.write({ path: "src/improvement/workflow-improver-program.ts", content: variantProgram });
   return JSON.stringify({ claim: "Avoid unsupported H proposals", predictedObservation: "No winner on the same development evidence", falsifier: "A candidate is proposed" }); }),
  model: "fake/improver", writableFiles: ["src/improvement/workflow-improver-program.ts"], developmentEvidence: [],
  checks: [{ name: "variant-entry", executable: process.execPath, args: ["-e", "require('fs').readFileSync('src/improvement/workflow-improver-program.ts','utf8').includes('development evidence') || process.exit(1)"] }] });
 assert.equal(candidateIReceipt.status, "committed", candidateIReceipt.reason);
 const candidateHReceipt = await generateSourceCandidate({ repository: repo, parentCommit, candidateRoot: path.join(root, "candidate-H"),
  snapshotRoot: path.join(root, "candidate-H-source"), receiptPath: path.join(root, "candidate-H.json"), persistDir: path.join(root, "H-builder-sessions"),
  runner: new FakeSessionRunner(async ctx => { await ctx.tools.read({ path: "src/m07/feedback.ts" });
   await ctx.tools.write({ path: "src/m07/feedback.ts",
    content: `${await readFile(path.join(repo, "src/m07/feedback.ts"), "utf8")}\n/* Model H candidate */\n` });
   return JSON.stringify({ claim: "Feedback handoff can improve", predictedObservation: "Changed handoff behavior", falsifier: "No change" }); }),
  model: "fake/improver", writableFiles: ["src/m07/feedback.ts"], developmentEvidence: [],
  checks: [{ name: "H-entry", executable: process.execPath, args: ["-e", "require('fs').readFileSync('src/m07/feedback.ts','utf8').includes('Model H candidate') || process.exit(1)"] }] });
 assert.equal(candidateHReceipt.status, "committed", candidateHReceipt.reason);
 const wsRoot = path.join(root, "workspace"); await mkdir(wsRoot);
 await writeFile(path.join(wsRoot, "research.config.json"), JSON.stringify({ roles: { improver: "fake/improver", research: "fake/research" }, tools: {}, concurrency: 1 }));
 const ws = new Workspace(wsRoot), knowledge = createFileKnowledgeStore(ws.knowledgeDir); await knowledge.init();
 const knowledgeSnapshot = (await knowledge.current())?.id ?? null, store = new GenerationStore(wsRoot);
 const h = await store.writeStrategy({ versionId: "H-old", kind: "executor", artifact: { version: 1, kind: "source-executor",
  sourceRoot: oldSource.sourceRoot, sourceCommit: oldSource.sourceCommit, modulePath: "src/m07/feedback.ts", exportName: "writeFeedback" },
  origin: "human-seed", applicability: ["M07"], limitations: [], state: "manual-active" });
 const oldI = await store.writeStrategy({ versionId: "I-old", kind: "improver", artifact: { version: 1, kind: "source-improver",
  sourceRoot: oldSource.sourceRoot, sourceCommit: oldSource.sourceCommit, modulePath: "src/improvement/workflow-improver-program.ts", exportName: "decideWorkflowImprovement" },
  origin: "human-seed", applicability: ["M07"], limitations: [], state: "manual-active" });
 const nextI = await store.writeStrategy({ versionId: "I-candidate", kind: "improver", parentVersionId: oldI.versionId,
  artifact: { version: 1, kind: "source-improver", sourceRoot: candidateIReceipt.snapshot!.sourceRoot, sourceCommit: candidateIReceipt.sourceCommit!,
   modulePath: "src/improvement/workflow-improver-program.ts", exportName: "decideWorkflowImprovement" },
  origin: "agent-generated", applicability: ["M07"], limitations: [], state: "research-only" });
 const bundle = await store.writeBundle({ bundleId: "G-meta-old", parents: [], executorVersionId: h.versionId, improverVersionId: oldI.versionId,
  ...(knowledgeSnapshot ? { knowledgeSnapshot } : {}), environmentVersion: "m07-workflow/v1", modelConfig: { improver: "fake/improver", research: "fake/research" },
  protocolVersion: "meta-offline/v1", allowedCapabilities: ["m07-evidence-read"], state: "manual-active" });
 await store.activateHumanSourceSeed(bundle.bundleId, "offline-human-seed");
 const runRoot = path.join(root, "meta-run-1"), seenBeforeProtected: string[] = [];
 const schedule: WorkflowSourceMetaPlanV1["protectedSchedule"] = [0, 1].map(repetition => ({ caseId: "G-offspring", repetition,
  executionOrder: repetition === 0 ? ["baseline", "candidate"] : ["candidate", "baseline"] }));
 const runner = new FakeSessionRunner(() => ({ text: JSON.stringify({ brief: "Test feedback handoff" }),
  usage: { input: 4, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 7, cost: 0.002 } }));
 let gates = 0;
 const runInput: WorkflowSourceMetaInput = { workspaceRoot: wsRoot, runRoot, persistDir: path.join(root, "meta-sessions"),
  runner, signal: new AbortController().signal, beforeOperation: async () => { gates++; },
  plan: { version: 1, kind: "workflow-source-meta/v1", baselineBundleId: bundle.bundleId,
   baseline: { executorVersionId: h.versionId, improverVersionId: oldI.versionId, executorSource: oldSource,
    knowledgeSnapshot, modelConfig: bundle.modelConfig, developmentSetId: "dev-fixed" },
   candidate: { versionId: nextI.versionId, source: candidateIReceipt.snapshot!, candidateReceiptPath: path.join(root, "candidate-I.json") },
   searchReplicates: 2, protectedSchedule: schedule, decisionRule: { id: "offline-declared-rule", parameters: { aim: "compare offspring" } } },
  development: [{ id: "D1", text: "Frozen development observation" }],
  searchCallbacks: () => ({ proposeSource: async () => ({ id: "H-proposal", status: "ready", sourceRoot: candidateHReceipt.snapshot!.sourceRoot,
   sourceCommit: candidateHReceipt.sourceCommit!, receiptPath: path.join(root, "candidate-H.json"), usage: usage() }),
   evaluateDevelopment: async () => { const file = path.join(root, "development-evaluation.json");
    await writeFile(file, JSON.stringify({ status: "preferred" }));
    return { candidateId: "H-proposal", status: "preferred", reason: "fixed development comparison", receiptPath: file, usage: usage() }; } }),
  evaluateProtectedOffspring: async context => {
   assert.equal(context.searches.length, 4);
   for (const entry of context.searches) {
    assert.ok(entry.selectionCopyPath); await readFile(entry.selectionCopyPath!);
    seenBeforeProtected.push(`${entry.replicate}-${entry.arm}`);
   }
   const budget = new SharedBudget("meta-offline", {});
   for (const scheduled of context.schedule) {
    const arm = (side: "baseline" | "candidate") => {
     const selected = context.searches.find(item => item.replicate === scheduled.repetition && item.arm === (side === "baseline" ? "old" : "candidate"))!;
     const cost = { providerCalls: 1, inputTokens: 5, outputTokens: 3, sdkEstimatedCost: 0.003, complete: true, costComplete: true };
     const receipt = { protocolVersion: 2 as const, loadedSource: selected.offspringSource!,
      childPid: 100 + scheduled.repetition * 2 + (side === "baseline" ? 1 : 2),
      caseId: scheduled.caseId, arm: side, methodVersionId: side === "baseline" ? "H-proposal" : h.versionId,
      workspaceRoot: path.join(root, `arm-${scheduled.repetition}-${side}`), checkResults: [], usage: cost, status: "complete" as const };
     const outcome = { version: 2 as const, caseId: scheduled.caseId, executionComplete: true, checked: true,
      quality: [{ criterion: "offline offspring", passed: side === "candidate", evidence: [], reason: "trusted fixture" }], cost };
     const before = budget.status(), after = { ...before, committed: { ...before.committed,
      providerCalls: before.committed.providerCalls + cost.providerCalls,
      inputTokens: before.committed.inputTokens + cost.inputTokens, outputTokens: before.committed.outputTokens + cost.outputTokens,
      sdkEstimatedCost: before.committed.sdkEstimatedCost + cost.sdkEstimatedCost } };
     return { receipt, outcome, parentLedger: { before, after } };
    };
    await context.recordArm({ ...scheduled, side: "baseline", result: arm("baseline") });
    await context.recordArm({ ...scheduled, side: "candidate", result: arm("candidate") });
   }
   const file = path.join(root, "trusted-protected.json"); await writeFile(file, JSON.stringify({ comparison: "offline" }));
   return { receiptPath: file, evaluatorUsageComplete: true };
  },
  decider: async input => { assert.equal(input.pairs.length, 2); assert.equal(input.searches.length, 4);
   return { status: "supported", quality: { reason: "candidate offspring passed both paired cases", evidence: ["offline pairs"] },
    cost: { reason: "declared comparison includes search and execution costs", evidence: ["offline ledger"] }, reason: "offline declared rule" }; } };
 const result = await runWorkflowSourceMetaComparison(runInput);
 assert.equal(result.status, "complete", result.reason);
 assert.deepEqual(result.searchOrder, [["old", "candidate"], ["candidate", "old"]]);
 assert.ok(gates >= 5);
 assert.equal(seenBeforeProtected.length, 4);
 assert.deepEqual(result.searches.filter(item => item.arm === "old").map(item => item.search?.actions[0]?.action.kind), ["inspect-development", "inspect-development"]);
 assert.deepEqual(result.searches.filter(item => item.arm === "candidate").map(item => item.search?.actions[0]?.action.kind), ["stop", "stop"]);
 assert.equal(new Set(result.searches.map(item => item.search?.program.pid)).size, 4);
 assert.equal(result.searches.filter(item => item.arm === "candidate").every(item => item.noWinner), true);
 assert.equal(result.searches.filter(item => item.arm === "old").every(item => item.search?.status === "selected"), true);
 assert.equal(result.searches.filter(item => item.arm === "old").every(item => !!item.candidateReceiptCopyPath && !!item.developmentEvaluationReceiptCopyPath), true);
 assert.equal(result.searches.filter(item => item.arm === "candidate").every(item => !item.candidateReceiptCopyPath), true);
 const frozenH = JSON.parse(await readFile(result.searches.find(item => item.arm === "old")!.candidateReceiptCopyPath!, "utf8"));
 assert.equal(frozenH.session.model, "fake/improver");
 assert.match(frozenH.diff, /Model H candidate/);
 assert.ok(result.costs.searchCost > 0);
 assert.equal(result.costs.complete, true);
 assert.equal(result.protectedPairs.length, 2);
 assert.equal(result.protectedReceiptPath, path.join(runRoot, "protected-offspring.private.json"));
 assert.equal(JSON.parse(await readFile(result.protectedReceiptPath!, "utf8")).comparison, "offline");

 await assert.rejects(runWorkflowSourceMetaComparison({ ...runInput, runRoot: path.join(root, "meta-invalid-schedule"),
  plan: { ...runInput.plan, protectedSchedule: [{ caseId: "G-offspring", repetition: 0,
   executionOrder: ["baseline", "baseline", "candidate"] as unknown as ["baseline", "candidate"] }] } }), /distinct paired cases and explicit order/);

 const partial = await runWorkflowSourceMetaComparison({ ...runInput, runRoot: path.join(root, "meta-run-partial"),
  plan: { ...runInput.plan, searchReplicates: 1, protectedSchedule: schedule.slice(0, 1) },
  evaluateProtectedOffspring: async context => {
   const selected = context.searches.find(item => item.arm === "old")!;
   const cost = { providerCalls: 1, inputTokens: 5, outputTokens: 3, sdkEstimatedCost: 0.003, complete: true, costComplete: true };
   const before = new SharedBudget("meta-partial", {}).status();
   const after = { ...before, committed: { ...before.committed, providerCalls: 1, inputTokens: 5, outputTokens: 3, sdkEstimatedCost: 0.003 } };
   await context.recordArm({ ...context.schedule[0]!, side: "baseline", result: {
    receipt: { protocolVersion: 2, loadedSource: selected.offspringSource!, childPid: 303, caseId: "G-offspring", arm: "baseline",
     methodVersionId: "H-proposal", workspaceRoot: path.join(root, "partial-old-arm"), checkResults: [], usage: cost, status: "complete" },
    outcome: { version: 2, caseId: "G-offspring", executionComplete: true, checked: true,
     quality: [{ criterion: "partial", passed: true, evidence: [], reason: "observed" }], cost },
    parentLedger: { before, after } } });
   throw new Error("candidate offspring failed before its arm receipt");
  } });
 assert.equal(partial.status, "inconclusive");
 assert.equal(partial.protectedPairs.length, 1);
 assert.ok(partial.protectedPairs[0]?.baseline);
 assert.equal(partial.protectedPairs[0]?.candidate, undefined);
 assert.equal(partial.costs.offspringExecutionEstimatedCost, 0.003);
 assert.ok(partial.costs.searchCost > 0);
 assert.match(partial.reason!, /candidate offspring failed/);
});
