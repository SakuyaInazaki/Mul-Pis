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
import { runWorkflowSourceSearch } from "../src/improvement/workflow-source-search.ts";
import { generateSourceCandidate } from "../src/improvement/source-candidate.ts";
import { openWorkflowImproverProcess } from "../src/improvement/workflow-improver-process.ts";
import type { WorkflowSourceDeciderV2 } from "../src/improvement/workflow-source-confirmation.ts";
import type { WorkflowTrustedEvaluatorV2 } from "../src/improvement/workflow-result-evaluator.ts";
import { activeWorkflowExecutorSource, workflowSourceCommand } from "../scripts/run-workflow-source.ts";
import { assertFirstWorkflowSourceAllowlist, executeWorkflowSourceArm, executeWorkflowSourceArmV2 } from "../src/improvement/workflow-source-arm.ts";
import { evaluateWorkflowOutcomeV2 } from "../src/improvement/workflow-result-evaluator.ts";
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
 const crashReply = path.join(root, "crash-reply.mjs");
 await writeFile(crashReply, "export default function reply() { process.exit(23); }\n");
 const crashBudget = new SharedBudget("crashed-source-arm", {});
 await assert.rejects(executeWorkflowSourceArm(sourceA, { ...args, root: path.join(root, "crashed-arm"), arm: "baseline" },
  { ...options, budget: crashBudget, lease: crashBudget.root, fakeReplyModule: crashReply }), /process failed/);
 assert.equal(crashBudget.status().inFlight, false);
 assert.equal(crashBudget.status().usageUnknown, true);
	const failedReply = path.join(root, "failed-provider-reply.mjs");
	await writeFile(failedReply, `export default function reply() { return { text: "partial answer", stopReason: "error", usage: { input: 17, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 20, cost: 0.007 } }; }\n`);
	const failedBudget = new SharedBudget("failed-provider-arm", {});
	const failedArm = await executeWorkflowSourceArm(sourceA, { ...args, root: path.join(root, "failed-provider-arm"), arm: "baseline" },
		{ ...options, budget: failedBudget, lease: failedBudget.root, fakeReplyModule: failedReply });
	assert.equal(failedArm.status, "inconclusive");
	assert.equal(failedArm.usage.providerCalls, 1);
	assert.equal(failedArm.usage.inputTokens, 17);
	assert.equal(failedArm.usage.outputTokens, 3);
	assert.equal(failedArm.usage.sdkEstimatedCost, 0.007);
	assert.equal(failedArm.usage.complete, false);
	assert.deepEqual(failedBudget.status().committed, {
		providerCalls: 1, inputTokens: 17, outputTokens: 3, sdkEstimatedCost: 0.007, probeCalls: 0, cpuMillis: 0,
	});
	assert.equal(failedBudget.status().usageUnknown, true);
	assert.equal(failedBudget.status().inFlight, false);

 // V2 gives each child only original obligations and source paths. The private G is evaluated after M04.
 await mkdir(path.join(sourceData.root, "evidence"));
 await writeFile(path.join(sourceData.root, "evidence", "source.txt"), `${"source fact and limiting condition\n".repeat(2_000)}`);
 const hidden = "PRIVATE_EXPECTED_ADOPTION_9d24";
 const visible = { id: "outcome", goal: { goal: "Assess the source evidence", problemRelation: "Direct research evidence", constraints: ["Preserve limitations"],
  successCriteria: ["Correctly decide whether the evidence supports adoption"], plan: "Read and assess evidence", exploratory: false },
  task: { objective: "Report the source evidence for M04 judgment", inputs: ["evidence/source.txt"], expectedOutputs: [],
   checks: ["M07 evidence report returned"], mode: "reason" as const }, requiredEvidence: ["evidence/source.txt"] };
 const v2Case = { version: 2 as const, visible, evaluation: { groundTruth: { privateMarker: hidden, expectedAdoption: true } } };
 const evaluator = async ({ groundTruth, transaction, readEvidence }: { groundTruth: unknown; transaction: { state: string }; readEvidence: Array<{ frozenPath: string }> }) => [
  { criterion: "M04 adopted the supported result", passed: transaction.state === "merged" && (groundTruth as { expectedAdoption: boolean }).expectedAdoption,
   evidence: readEvidence.map(item => item.frozenPath), reason: transaction.state === "merged" ? "Published knowledge transition" : "M04 made no knowledge adoption" },
 ];
 const createV2Reply = async (file: string, includeRead: boolean) => writeFile(file, `import fs from "node:fs"; import path from "node:path";
export default function reply({spec,message}) {
 if (message.includes(${JSON.stringify(hidden)}) || spec.systemPrompt.includes(${JSON.stringify(hidden)})) throw new Error("private G leaked to model");
 if (spec.role !== "research") return { text: "# Evidence report\\n\\n## Source fact\\nCorrect source fact appears in M07 report.\\n\\n### Limitation\\nThe observation has a limiting condition.", usage: { input:100, output:20, cacheRead:0, cacheWrite:0, totalTokens:120, cost:0.001 } };
 const goal = JSON.parse(fs.readFileSync(path.join(spec.tools.root,"goal.json"),"utf8"));
 const artifact = goal.tasks[0].review.artifacts[1].path;
 const relative = path.relative(spec.tools.root, artifact);
 const lines = fs.readFileSync(artifact,"utf8").trimEnd().split(/\\r?\\n/).length;
 return { text: "M04 records no proposal after reviewing the source.",
  readReturns: ${includeRead ? `[{ toolName:"m07_evidence_read",status:"returned",path:relative,requested:{},returned:{kind:"text",startLine:1,endLine:lines,truncated:false},at:new Date().toISOString() }]` : "[]"},
  usage: { input:100, output:20, cacheRead:0, cacheWrite:0, totalTokens:120, cost:0.001 } };
}\n`);
 const v2Reply = path.join(root, "v2-reply.mjs"); await createV2Reply(v2Reply, true);
 const v2Budget = new SharedBudget("v2-outcome", {});
 const v2Options = { runnerKind: "fake" as const, fakeReplyModule: v2Reply, budget: v2Budget, lease: v2Budget.root,
  beforePrompt: async () => undefined, evaluator, baselineSource: sourceA };
 const v2Args = { ...args, caseInput: v2Case, root: path.join(root, "v2-arm"), arm: "candidate" as const };
 await assert.rejects(executeWorkflowSourceArm(sourceA, { ...v2Args, caseInput: v2Case as never }, v2Options), /private evaluator data cannot enter source arm IPC/);
 const measured = await executeWorkflowSourceArmV2(sourceB, v2Args, v2Options);
 assert.equal(measured.receipt.status, "complete", measured.receipt.reason);
 assert.equal(measured.outcome.executionComplete, true);
 assert.equal(measured.outcome.checked, true, measured.outcome.reason);
 assert.equal(measured.outcome.quality.find(item => item.criterion === "M04 adopted the supported result")?.passed, false,
  "a correct phrase in M07 cannot pass when M04 did not adopt the supported result");
 assert.ok(measured.outcome.quality.some(item => item.criterion.startsWith("M04 read required evidence") && item.passed));

 const missingReply = path.join(root, "v2-missing-read.mjs"); await createV2Reply(missingReply, false);
 const missingBudget = new SharedBudget("v2-missing", {});
 const missing = await executeWorkflowSourceArmV2(sourceA, { ...v2Args, root: path.join(root, "v2-missing"), arm: "baseline" },
  { ...v2Options, fakeReplyModule: missingReply, budget: missingBudget, lease: missingBudget.root });
 assert.equal(missing.receipt.status, "complete", missing.receipt.reason);
 assert.equal(missing.outcome.checked, false);
 assert.ok(missing.outcome.quality.some(item => item.criterion.startsWith("M04 read required evidence") && item.passed === false));

 const wsV2 = new Workspace(measured.receipt.workspaceRoot);
 const liveGoalFile = path.join(wsV2.runDir("M07", measured.receipt.m07RunId!), "goal.json");
 const liveGoal = JSON.parse(await readFile(liveGoalFile, "utf8"));
 liveGoal.checkpoints.find((item: { id: string }) => item.id === measured.receipt.checkpointId).feedbackStatus = "indexed";
 await writeFile(liveGoalFile, JSON.stringify(liveGoal));
 const indexed = await evaluateWorkflowOutcomeV2(v2Case, { ...measured.receipt, feedbackStatus: "indexed" }, evaluator, bundle.knowledgeSnapshot);
 assert.equal(indexed.executionComplete, true);
 assert.equal(indexed.checked, true, indexed.reason);
 assert.ok(indexed.quality.some(item => item.criterion.startsWith("M04 read required evidence") && item.passed));

 await writeFile(path.join(repo, "src/improvement/workflow-adapter.ts"), `${await readFile(path.join(repo, "src/improvement/workflow-adapter.ts"), "utf8")}\n// Disallowed candidate control edit.\n`);
 git("add", "src/improvement/workflow-adapter.ts"); git("commit", "-qm", "Fixture disallowed control edit");
 const disallowed = await prepareWorkflowCodeSource(repo, git("rev-parse", "HEAD"), path.join(root, "code-disallowed"));
 await assert.rejects(assertFirstWorkflowSourceAllowlist(sourceA, disallowed), /non-allowlisted source file: src\/improvement\/workflow-adapter\.ts/);

 // A source-backed I selection is frozen before the private admission set opens.
 const seedData = new Workspace(path.join(root, "confirmation-data"));
 await mkdir(path.dirname(seedData.problemFile), { recursive: true });
 await writeFile(seedData.problemFile, "固定原问题与证据。\n");
 await writeFile(seedData.configFile, await readFile(sourceData.configFile));
 const seedKnowledge = createFileKnowledgeStore(seedData.knowledgeDir); await seedKnowledge.init();
 const seedK = (await seedKnowledge.current())?.id;
 const seedFormal = await seedData.startRun("M04", [{ label: "原问题", path: seedData.problemFile }], seedK);
 await seedData.finishRun(seedFormal, "completed");
 await mkdir(path.join(seedData.root, "evidence"));
 await writeFile(path.join(seedData.root, "evidence", "case.txt"), "Observed source fact and limitation.\n");
 const seeded = new ResearchImprovementService({ workspaceRoot: seedData.root, runner: new FakeSessionRunner(() => "unused") });
 const seedBundle = await seeded.bootstrap({ version: 1,
  executor: { version: 1, kind: "m07-workflow-prompt", slot: "evidence-handoff", body: "Retain the source evidence." },
  improver: { version: 1, kind: "source-improver", sourceRoot: sourceA.sourceRoot, sourceCommit: sourceA.sourceCommit,
   modulePath: "src/improvement/workflow-improver-program.ts", exportName: "decideWorkflowImprovement" }, applicability: ["M07"] });
 const seedStore = new GenerationStore(seedData.root);
 const candidate = await seedStore.writeStrategy({ versionId: "H-fixture-candidate", kind: "executor", parentVersionId: seedBundle.executorVersionId,
  artifact: { version: 1, kind: "source-executor", sourceRoot: sourceB.sourceRoot, sourceCommit: sourceB.sourceCommit,
   modulePath: "src/m07/feedback.ts", exportName: "writeFeedback" }, origin: "agent-generated", applicability: ["M07"], limitations: [], state: "research-only" });
 const candidateReceiptPath = path.join(root, "candidate-receipt.json");
 await writeFile(candidateReceiptPath, JSON.stringify({ version: 1, status: "committed", engineeringStatus: "passed", session: { id: "fake-model-session" }, parentCommit: sourceA.sourceCommit,
  sourceCommit: sourceB.sourceCommit, snapshot: sourceB, changedFiles: ["src/m07/feedback.ts"] }));
 const evaluationReceiptPath = path.join(root, "development-evaluation.json");
 await writeFile(evaluationReceiptPath, JSON.stringify({ candidateId: "candidate-1", status: "preferred", reason: "offline fixture" }));
 const usage = { input: 2, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: 0.001,
  reportedEvents: 1, unknownEvents: 0, complete: true, costComplete: true };
 const searchPath = path.join(root, "source-search.json");
 const bindingA = { sourceRoot: sourceA.sourceRoot, sourceCommit: sourceA.sourceCommit };
 const bindingB = { sourceRoot: sourceB.sourceRoot, sourceCommit: sourceB.sourceCommit };
 const search = await runWorkflowSourceSearch({ workspaceRoot: seedData.root, persistDir: path.join(root, "search-sessions"), receiptPath: searchPath,
  signal: new AbortController().signal,
  source: bindingA, improverVersionId: seedBundle.improverVersionId,
  editTarget: { kind: "H-executor", objective: "Improve development evidence handoff", writableFiles: ["src/m07/feedback.ts"] },
  runner: new FakeSessionRunner(() => ({
   text: JSON.stringify({ brief: "Improve evidence handoff." }), usage: { input: 4, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 7, cost: 0.002 } })),
  baseline: { bundleId: seedBundle.bundleId, executorVersionId: seedBundle.executorVersionId, executorSource: bindingA, developmentSetId: "dev-fixture" },
  development: [{ id: "dev-1", text: "The original feedback is long." }],
  proposeSource: async () => ({ id: "candidate-1", status: "ready", sourceRoot: sourceB.sourceRoot, sourceCommit: sourceB.sourceCommit,
   receiptPath: candidateReceiptPath, usage }),
  evaluateDevelopment: async () => ({ candidateId: "candidate-1", status: "preferred", reason: "offline fixture preference", receiptPath: evaluationReceiptPath, usage }) });
 assert.equal(search.status, "selected", search.reason);
 const admissionCase = { version: 2 as const, visible: { id: "admission-1", goal: visible.goal,
  task: { ...visible.task, inputs: ["evidence/case.txt"] }, requiredEvidence: ["evidence/case.txt"] },
  evaluation: { groundTruth: { expectedAdoption: false } } };
 const admissionPath = path.join(root, "private-admission.json");
 await writeFile(admissionPath, JSON.stringify({ version: 2, split: "admission", cases: [admissionCase] }));
 const confirmPlan = { version: 2, kind: "workflow-source-confirmation/v2", baselineBundleId: seedBundle.bundleId,
  formalRunId: seedFormal.runId, sources: { baseline: bindingA, candidate: bindingB }, experimentRoot: path.join(root, "protected-pairs"),
  admissionCaseSetPath: admissionPath, repetitions: 2,
  selection: { version: 2, kind: "workflow-source-selection/v2", developmentRunId: search.runId, candidateVersionId: candidate.versionId,
   candidateReceiptPath, searchSelectionPath: search.selectionReceiptPath!, reason: search.reason!, developmentCaseIds: search.developmentIds },
  decisionRule: { id: "offline-fixture-declared-rule", parameters: {} } };
 const confirmControl: { sourceRunnerOptions: { runnerKind: "fake"; fakeReplyModule: string }; evaluator: WorkflowTrustedEvaluatorV2; decider: WorkflowSourceDeciderV2 } = {
  sourceRunnerOptions: { runnerKind: "fake", fakeReplyModule: v2Reply },
  evaluator: async ({ transaction }) => [{ criterion: "M04 retained the unsupported result", passed: transaction.state !== "merged",
   evidence: [transaction.state], reason: "The fixture expects no adopted claim." }],
  decider: async ({ declaration, pairs }) => {
   assert.equal(declaration.id, "offline-fixture-declared-rule");
   const quality = pairs.every(pair => [pair.baseline, pair.candidate].every(arm => arm!.outcome.quality.every(check => check.passed)));
   const cost = pairs.every(pair => pair.candidate!.outcome.cost.sdkEstimatedCost <= pair.baseline!.outcome.cost.sdkEstimatedCost);
   return { status: quality && cost ? "supported" : "rejected", quality: { reason: "fixture quality", evidence: [String(quality)] },
    cost: { reason: "fixture observed cost", evidence: [String(cost)] }, reason: "predeclared offline fixture decision" };
  } };
 const confirmation = await seeded.confirmWorkflowSources(confirmPlan, confirmControl);
 assert.equal(confirmation.status, "complete", confirmation.reason);
 assert.equal(confirmation.decision?.status, "supported");
 assert.deepEqual(confirmation.pairs.map(pair => pair.executionOrder), [["baseline", "candidate"], ["candidate", "baseline"]]);
 assert.equal(new Set(confirmation.pairs.flatMap(pair => [pair.baseline!.receipt.workspaceRoot, pair.candidate!.receipt.workspaceRoot])).size, 4);
 await assert.rejects(seeded.adoptWorkflowSourceConfirmation(search.runId), /ENOENT|confirmation/,
  "a development search run cannot be adopted as a protected confirmation");
 const savedRunPath = path.join(seedStore.root, "source-confirmations", confirmation.runId, "run.json");
 const savedRun = await readFile(savedRunPath, "utf8");
 const partial = JSON.parse(savedRun); partial.pairs.pop();
 await writeFile(savedRunPath, JSON.stringify(partial));
 await assert.rejects(seeded.adoptWorkflowSourceConfirmation(confirmation.runId), /missing or duplicate pairs/);
 const mismatch = JSON.parse(savedRun); mismatch.pairs[0].candidate.receipt.loadedSource.sourceCommit = sourceA.sourceCommit;
 await writeFile(savedRunPath, JSON.stringify(mismatch));
 await assert.rejects(seeded.adoptWorkflowSourceConfirmation(confirmation.runId), /source-mismatched arm/);
 await writeFile(savedRunPath, savedRun);
 const activeFile = path.join(seedStore.root, "active.json"), savedPointer = await readFile(activeFile, "utf8");
 const stale = JSON.parse(savedPointer); stale.runId = "concurrent-change";
 await writeFile(activeFile, JSON.stringify(stale));
 await assert.rejects(seeded.adoptWorkflowSourceConfirmation(confirmation.runId), /active generation changed/);
 await writeFile(activeFile, savedPointer);
 const adopted = await seeded.adoptWorkflowSourceConfirmation(confirmation.runId);
 assert.equal(adopted.bundle.executorVersionId, candidate.versionId);
 assert.equal(adopted.bundle.improverVersionId, seedBundle.improverVersionId);
 assert.equal((await activeWorkflowExecutorSource(seedData.root)).sourceCommit, sourceB.sourceCommit);
 const launch = await workflowSourceCommand("@active", seedData.root, "harness", ["status"]);
 assert.equal(launch.env.PRE_RSI_CODE_REVISION, sourceB.sourceCommit);
 assert.equal(confirmation.pairs[0].baseline!.receipt.loadedSource.sourceCommit, sourceA.sourceCommit,
  "the already completed baseline arm retains its loaded source");

 // A second generation compares the active source H to one new H while retaining the same source I and K.
 git("reset", "--hard", commitB);
 await writeFile(path.join(repo, "src/m07/feedback.ts"), `${await readFile(path.join(repo, "src/m07/feedback.ts"), "utf8")}\n// Independent fixture source C.\n`);
 git("add", "src/m07/feedback.ts"); git("commit", "-qm", "Fixture source C");
 const sourceC = await prepareWorkflowCodeSource(repo, git("rev-parse", "HEAD"), path.join(root, "code-C"));
 const candidateC = await seedStore.writeStrategy({ versionId: "H-fixture-generation-two", kind: "executor", parentVersionId: candidate.versionId,
  artifact: { version: 1, kind: "source-executor", sourceRoot: sourceC.sourceRoot, sourceCommit: sourceC.sourceCommit,
   modulePath: "src/m07/feedback.ts", exportName: "writeFeedback" }, origin: "agent-generated", applicability: ["M07"], limitations: [], state: "research-only" });
 const candidateCReceipt = path.join(root, "candidate-C-receipt.json");
 await writeFile(candidateCReceipt, JSON.stringify({ version: 1, status: "committed", engineeringStatus: "passed", session: { id: "fake-model-session-C" },
  parentCommit: sourceB.sourceCommit, sourceCommit: sourceC.sourceCommit, snapshot: sourceC,
  writableFiles: ["src/m07/feedback.ts"], changedFiles: ["src/m07/feedback.ts"], diff: "offline fixture feedback change" }));
 const evaluationCReceipt = path.join(root, "development-C-evaluation.json");
 await writeFile(evaluationCReceipt, JSON.stringify({ candidateId: "candidate-C", status: "preferred", reason: "offline fixture" }));
 const searchC = await runWorkflowSourceSearch({ workspaceRoot: seedData.root, persistDir: path.join(root, "search-C-sessions"),
  receiptPath: path.join(root, "source-search-C.json"), signal: new AbortController().signal,
  source: bindingA, improverVersionId: seedBundle.improverVersionId,
  editTarget: { kind: "H-executor", objective: "Improve development evidence handoff", writableFiles: ["src/m07/feedback.ts"] },
  runner: new FakeSessionRunner(() => ({
   text: JSON.stringify({ brief: "Improve source H again." }), usage: { input: 4, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 7, cost: 0.002 } })),
  baseline: { bundleId: adopted.bundle.bundleId, executorVersionId: candidate.versionId, executorSource: bindingB, developmentSetId: "dev-fixture-2" },
  development: [{ id: "dev-2", text: "Second-generation development observation." }],
  proposeSource: async () => ({ id: "candidate-C", status: "ready", sourceRoot: sourceC.sourceRoot, sourceCommit: sourceC.sourceCommit,
   receiptPath: candidateCReceipt, usage }),
  evaluateDevelopment: async () => ({ candidateId: "candidate-C", status: "preferred", reason: "offline fixture preference", receiptPath: evaluationCReceipt, usage }) });
 assert.equal(searchC.status, "selected", searchC.reason);
 const confirmationC = await seeded.confirmWorkflowSources({ ...confirmPlan, baselineBundleId: adopted.bundle.bundleId,
  sources: { baseline: bindingB, candidate: { sourceRoot: sourceC.sourceRoot, sourceCommit: sourceC.sourceCommit } },
  experimentRoot: path.join(root, "protected-pairs-C"), selection: { ...confirmPlan.selection, developmentRunId: searchC.runId,
   candidateVersionId: candidateC.versionId, candidateReceiptPath: candidateCReceipt, searchSelectionPath: searchC.selectionReceiptPath!,
   developmentCaseIds: searchC.developmentIds, reason: searchC.reason! } }, confirmControl);
 assert.equal(confirmationC.status, "complete", confirmationC.reason);
 assert.equal(confirmationC.decision?.status, "supported");
 const adoptedC = await seeded.adoptWorkflowSourceConfirmation(confirmationC.runId);
 assert.equal(adoptedC.bundle.improverVersionId, seedBundle.improverVersionId);
 assert.equal((await activeWorkflowExecutorSource(seedData.root)).sourceCommit, sourceC.sourceCommit);
 await seeded.rollback();
 assert.equal((await seedStore.active())?.bundle.bundleId, adopted.bundle.bundleId);
 assert.equal((await activeWorkflowExecutorSource(seedData.root)).sourceCommit, sourceB.sourceCommit);
 assert.equal(confirmationC.pairs[0].candidate!.receipt.loadedSource.sourceCommit, sourceC.sourceCommit,
  "rollback changes later launches without rewriting a completed arm");

 // I adoption compares actual offspring M07→M04 arms, and changes only the later I program.
 const stopProgram = "export function decideWorkflowImprovement() { return { kind: 'stop', reason: 'No supported source proposal from development evidence' }; }\n";
 const iReceiptPath = path.join(root, "candidate-I-receipt.json");
 const iReceipt = await generateSourceCandidate({ repository: repo, parentCommit: commitA,
  candidateRoot: path.join(root, "I-candidate-tree"), snapshotRoot: path.join(root, "I-candidate-source"),
  receiptPath: iReceiptPath, persistDir: path.join(root, "I-builder-sessions"),
  runner: new FakeSessionRunner(async context => { await context.tools.write({ path: "src/improvement/workflow-improver-program.ts", content: stopProgram });
   return { text: JSON.stringify({ claim: "Stop without a justified candidate", predictedObservation: "No H offspring selected", falsifier: "A candidate is selected" }),
    usage: { input: 5, output: 4, cacheRead: 0, cacheWrite: 0, totalTokens: 9, cost: 0.002 } }; }),
  model: "fake/improver", writableFiles: ["src/improvement/workflow-improver-program.ts"], developmentEvidence: [],
  checks: [{ name: "source-I-entry", executable: process.execPath, args: ["-e", "require('fs').readFileSync('src/improvement/workflow-improver-program.ts','utf8').includes('No supported source proposal') || process.exit(1)"] }] });
 assert.equal(iReceipt.status, "committed", iReceipt.reason);
 const newI = await seedStore.writeStrategy({ versionId: "I-fixture-candidate", kind: "improver", parentVersionId: seedBundle.improverVersionId,
  artifact: { version: 1, kind: "source-improver", sourceRoot: iReceipt.snapshot!.sourceRoot, sourceCommit: iReceipt.sourceCommit!,
   modulePath: "src/improvement/workflow-improver-program.ts", exportName: "decideWorkflowImprovement" },
  origin: "agent-generated", applicability: ["M07"], limitations: [], state: "research-only" });
 const metaRunner = new FakeSessionRunner(() => ({ text: JSON.stringify({ brief: "Test another H source handoff." }),
  usage: { input: 4, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 7, cost: 0.002 } }));
 const metaService = new ResearchImprovementService({ workspaceRoot: seedData.root, runner: metaRunner });
 const metaActive = (await seedStore.active())!;
 const metaPlan = { version: 1 as const, kind: "workflow-source-meta/v1" as const, baselineBundleId: metaActive.bundle.bundleId,
  baseline: { executorVersionId: metaActive.bundle.executorVersionId, improverVersionId: metaActive.bundle.improverVersionId,
   executorSource: bindingB, knowledgeSnapshot: metaActive.bundle.knowledgeSnapshot ?? null,
   modelConfig: metaActive.bundle.modelConfig, developmentSetId: "offline-I-comparison" },
  candidate: { versionId: newI.versionId, source: { sourceRoot: iReceipt.snapshot!.sourceRoot, sourceCommit: iReceipt.sourceCommit! }, candidateReceiptPath: iReceiptPath },
  searchReplicates: 2, protectedSchedule: [0, 1].map(repetition => ({ caseId: admissionCase.visible.id, repetition,
   executionOrder: (repetition === 0 ? ["baseline", "candidate"] : ["candidate", "baseline"]) as ["baseline", "candidate"] | ["candidate", "baseline"] })),
  decisionRule: { id: "offline-fixture-I-cost-rule", parameters: {} } };
 const meta = await metaService.compareWorkflowSourceMeta({ persistDir: path.join(root, "I-meta-sessions"), signal: new AbortController().signal,
  plan: metaPlan, development: [{ id: "dev-I", text: "A candidate H may not be needed for this evidence." }],
  searchCallbacks: ({ arm, replicate }) => ({
   proposeSource: async () => ({ id: `H-from-old-I-${replicate}`, status: "ready", sourceRoot: sourceC.sourceRoot,
    sourceCommit: sourceC.sourceCommit, receiptPath: candidateCReceipt, usage }),
   evaluateDevelopment: async request => { const receiptPath = path.join(root, `old-I-development-${replicate}.json`);
    await writeFile(receiptPath, JSON.stringify({ candidateId: request.candidate.id, status: "preferred", reason: "offline preference" }));
    return { candidateId: request.candidate.id, status: "preferred", reason: "offline preference", receiptPath, usage }; } }),
  evaluateProtectedOffspring: async context => {
   const active = (await seedStore.active())!, h = await seedStore.readStrategy(active.bundle.executorVersionId),
    i = await seedStore.readStrategy(active.bundle.improverVersionId);
   const metaBudget = new SharedBudget("I-meta-offspring", {});
   for (const scheduled of context.schedule) {
    const pair = { ...scheduled } as import("../src/improvement/workflow-source-confirmation.ts").WorkflowSourcePairV2;
    for (const side of scheduled.executionOrder) {
     const selected = context.searches.find(item => item.replicate === scheduled.repetition && item.arm === (side === "baseline" ? "old" : "candidate"))!;
     const before = metaBudget.status();
     const result = await executeWorkflowSourceArmV2(selected.offspringSource!, {
      sourceWorkspaceRoot: seedData.root, root: path.join(root, `I-meta-${scheduled.repetition}-${side}`),
      bundle: active.bundle, h, i, caseInput: admissionCase, arm: side, builtinBaseline: false, formalRunId: seedFormal.runId },
      { runnerKind: "fake", fakeReplyModule: v2Reply, budget: metaBudget, lease: metaBudget.root,
       beforePrompt: async () => undefined, evaluator: confirmControl.evaluator, baselineSource: bindingB });
     pair[side] = { ...result, parentLedger: { before, after: metaBudget.status() } };
    }
    await context.recordPair(pair);
   }
   await context.recordEvaluatorUsage(usage);
   const receiptPath = path.join(root, "I-meta-private-checker.json");
   await writeFile(receiptPath, JSON.stringify({ checked: true, origin: "offline fixture" }));
   return { receiptPath, evaluatorUsageComplete: true };
  },
  decider: async ({ declaration, pairs, searches, costs }) => {
   assert.equal(declaration.id, "offline-fixture-I-cost-rule");
   const quality = pairs.every(pair => [pair.baseline, pair.candidate].every(arm => arm!.outcome.quality.every(check => check.passed)));
   const oldCost = searches.filter(item => item.arm === "old").reduce((n, item) => n + item.search!.usage.totals.cost, 0);
   const newCost = searches.filter(item => item.arm === "candidate").reduce((n, item) => n + item.search!.usage.totals.cost, 0);
   const supported = quality && costs.complete && newCost < oldCost;
   return { status: supported ? "supported" : "rejected", quality: { reason: "offline equal quality", evidence: [String(quality)] },
    cost: { reason: "offline search cost comparison", evidence: [String(oldCost), String(newCost)] }, reason: "predeclared offline I fixture rule" };
  } });
 assert.equal(meta.status, "complete", meta.reason);
 assert.equal(meta.decision?.status, "supported");
 assert.equal(meta.searches.filter(item => item.arm === "candidate").every(item => item.noWinner), true);
 assert.equal(meta.searches.filter(item => item.arm === "old").every(item => item.search?.status === "selected"), true);
 const metaRunPath = path.join(seedStore.root, "source-meta", meta.runId, "run.json");
 const savedMetaRun = await readFile(metaRunPath, "utf8");
	const frozenHCandidatePath = meta.searches.find(item => item.arm === "old")!.candidateReceiptCopyPath!;
	const frozenHCandidate = await readFile(frozenHCandidatePath, "utf8");
	await writeFile(frozenHCandidatePath, JSON.stringify({ ...JSON.parse(frozenHCandidate), parentCommit: sourceA.sourceCommit }));
	await assert.rejects(metaService.adoptWorkflowSourceMeta(meta.runId), /frozen H candidate/);
	await writeFile(frozenHCandidatePath, frozenHCandidate);
	const frozenDevelopmentPath = meta.searches.find(item => item.arm === "old")!.developmentEvaluationReceiptCopyPath!;
	const frozenDevelopment = await readFile(frozenDevelopmentPath, "utf8");
	await writeFile(frozenDevelopmentPath, JSON.stringify({ ...JSON.parse(frozenDevelopment), status: "rejected" }));
	await assert.rejects(metaService.adoptWorkflowSourceMeta(meta.runId), /frozen H candidate/);
	await writeFile(frozenDevelopmentPath, frozenDevelopment);
 const missingMeta = JSON.parse(savedMetaRun); missingMeta.protectedPairs.pop();
 await writeFile(metaRunPath, JSON.stringify(missingMeta));
 await assert.rejects(metaService.adoptWorkflowSourceMeta(meta.runId), /denominator is incomplete/);
 const forgedMeta = JSON.parse(savedMetaRun); forgedMeta.searches[0].offspringSource.sourceCommit = sourceB.sourceCommit;
 await writeFile(metaRunPath, JSON.stringify(forgedMeta));
 await assert.rejects(metaService.adoptWorkflowSourceMeta(meta.runId), /selected H offspring lacks|source-mismatched/);
	const forgedLedger = JSON.parse(savedMetaRun); forgedLedger.protectedPairs[0].baseline.parentLedger.after.committed.inputTokens += 1;
	await writeFile(metaRunPath, JSON.stringify(forgedLedger));
	await assert.rejects(metaService.adoptWorkflowSourceMeta(meta.runId), /parent provider ledger|incomplete, reused, or source-mismatched/);
 const unmeteredMeta = JSON.parse(savedMetaRun); unmeteredMeta.costs.protectedEvaluatorUsageComplete = false;
 await writeFile(metaRunPath, JSON.stringify(unmeteredMeta));
 await assert.rejects(metaService.adoptWorkflowSourceMeta(meta.runId), /frozen decision|usage/);
 await writeFile(metaRunPath, savedMetaRun);
 const metaPointerPath = path.join(seedStore.root, "active.json"), metaPointer = await readFile(metaPointerPath, "utf8");
 const shiftedMetaPointer = JSON.parse(metaPointer); shiftedMetaPointer.runId = "other-active-generation";
 await writeFile(metaPointerPath, JSON.stringify(shiftedMetaPointer));
 await assert.rejects(metaService.adoptWorkflowSourceMeta(meta.runId), /active H\/I\/K\/model differs/);
 await writeFile(metaPointerPath, metaPointer);
 const adoptedI = await metaService.adoptWorkflowSourceMeta(meta.runId);
 assert.equal(adoptedI.bundle.executorVersionId, candidate.versionId);
 assert.equal(adoptedI.bundle.improverVersionId, newI.versionId);
 assert.equal((await activeWorkflowExecutorSource(seedData.root)).sourceCommit, sourceB.sourceCommit);
 const openedI = await openWorkflowImproverProcess({ sourceRoot: iReceipt.snapshot!.sourceRoot, sourceCommit: iReceipt.sourceCommit! }, newI.versionId);
 try { assert.equal((await openedI.decide({ version: 1, improverVersionId: newI.versionId, availableDevelopmentIds: ["dev-next"],
  inspectedDevelopment: [], modelObservations: [], candidates: [], evaluations: [], operationFailures: [] }) as { kind: string }).kind, "stop"); }
 finally { await openedI.close(); }
 await metaService.rollback();
 assert.equal((await seedStore.active())?.bundle.improverVersionId, seedBundle.improverVersionId);
 assert.equal((await activeWorkflowExecutorSource(seedData.root)).sourceCommit, sourceB.sourceCommit);
});
