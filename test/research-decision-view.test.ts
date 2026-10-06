import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { ResearchImprovementService } from "../src/improvement/research-service.ts";
import { validateResearchAction } from "../src/improvement/policy-host.ts";
import type { ResearchCampaignPlanV1 } from "../src/improvement/research-types.ts";
import { FakeSessionRunner } from "../src/runner/fake.ts";

const usage = { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 150, cost: 0.001 };
const development = { version: 1, split: "development", cases: [{ id: "dev-a", version: 1, truthHypothesisId: "h1", hypotheses: [
 { id: "h1", formula: { kind: "affine", slope: 1, intercept: 4 } },
 { id: "h2", formula: { kind: "quadratic", coefficient: 1, intercept: 4 } },
], initialX: [0], allowedProbeX: [2], maxProbeCalls: 1, tolerance: 0.01, units: { x: "s", y: "m" } }] };
const campaign = (maxDecisions: number): ResearchCampaignPlanV1 => ({ version: 1, experimentKind: "executor-quality", target: "executor", developmentCaseSetPath: "development.json",
 maxDecisions, maxCandidates: 1, maxInspectActions: 2, maxReadbackChars: 300, admissionRepetitions: 2, maxFeedbackItems: 8,
 perPromptTimeoutMs: 10_000,
 budget: { maxProviderCalls: 20, maxInputTokens: 200_000, maxSdkEstimatedCost: 10, maxProbeCalls: 20, maxCpuMillis: 100_000, maxWallMillis: 500_000 },
 experienceRefs: [], experienceMaxRecords: 0, experienceMaxChars: 0 });

async function fixture(t: TestContext, respond: (view: Record<string, any>) => object, executorBody = "Use visible observations.") {
 const root = await mkdtemp(path.join(tmpdir(), "pre-rsi-decision-view-"));
 t.after(() => rm(root, { recursive: true, force: true }));
 await writeFile(path.join(root, "research.config.json"), JSON.stringify({ roles: { default: "fake/default", improver: "fake/improver", research: "fake/research" }, concurrency: 1 }));
 await writeFile(path.join(root, "development.json"), JSON.stringify(development));
 const views: Array<Record<string, any>> = [];
 const runner = new FakeSessionRunner((ctx) => {
  assert.equal(ctx.spec.role, "improver");
  const view = JSON.parse(ctx.message.slice(ctx.message.indexOf("\n") + 1));
  views.push(view);
  return { text: JSON.stringify(respond(view)), usage };
 });
 const service = new ResearchImprovementService({ workspaceRoot: root, runner });
 await service.bootstrap({ version: 1, executor: { version: 1, kind: "cpu-numerical-prompt", body: executorBody },
  improver: { version: 1, kind: "diagnostic-improver-prompt", body: "Choose bounded research actions." }, applicability: ["cpu-response-identification"] });
 return { service, views };
}

const proposal = { kind: "propose", target: "executor", body: "Probe before selecting a response hypothesis.", hypothesis: {
 claim: "probe improves discrimination", predictedObservation: "one hypothesis remains", falsifier: "several remain", applicability: ["cpu-response-identification"], motivatingEvidenceIds: [] } };

test("I can explicitly stop without a winner without a cumulative readback quota in its view", async (t) => {
 const f = await fixture(t, (view) => view.lastActionResult ? { kind: "stop", reason: "no supported candidate" } : proposal);
 const result = await f.service.run(campaign(3));
 assert.equal(result.status, "research-only");
 assert.equal(result.developmentTerminal, "no-winner");
 assert.equal(result.outcome, "completed-no-candidate");
 assert.match(result.stopReason ?? "", /explicitly stopped/);
 assert.ok(f.views.every((v) => !("remainingActions" in v)));
 assert.equal(f.views[1].lastActionResult.kind, "propose");
 assert.equal(f.views[1].lastActionResult.outcome, "executed");
 assert.ok(f.views[1].lastActionResult.candidateId);
});

test("legacy decision count cannot end I search; model can stop after a duplicate rejection", async (t) => {
 const f = await fixture(t, (view) => view.lastActionResult?.outcome === "rejected" ? { kind: "stop", reason: "candidate did not change" } : proposal);
 const result = await f.service.run(campaign(1));
 assert.equal(result.status, "research-only");
 assert.equal(result.developmentTerminal, "no-winner");
 assert.equal(result.outcome, "completed-no-candidate");
 assert.equal(f.views.length, 3);
 assert.match(f.views[2].lastActionResult.reason, /repeated candidate body/);
 assert.equal(result.selectedCandidateId, undefined);
});

test("recoverable inspect pagination error returns a bounded rejection receipt", async (t) => {
 const f = await fixture(t, (view) => !view.lastActionResult
  ? { kind: "inspect", read: { object: "method", id: view.current.executorVersionId, start: 99_999, maxChars: 100 } }
  : { kind: "stop", reason: "no further inspection needed" });
 const result = await f.service.run(campaign(2));
 assert.equal(result.outcome, "completed-no-candidate");
 assert.equal("remainingActions" in f.views[1], false);
 assert.equal(f.views[1].lastActionResult.kind, "inspect");
 assert.equal(f.views[1].lastActionResult.outcome, "rejected");
 assert.match(f.views[1].lastActionResult.reason, /inspect start is past registered object/);
});

test("repeated bounded inspections can exceed the old 40,000-character campaign ceiling", async (t) => {
 let reads = 0;
 const f = await fixture(t, (view) => reads++ < 11
  ? { kind: "inspect", read: { object: "method", id: view.current.executorVersionId, start: 0, maxChars: 4_000 } }
  : { kind: "stop", reason: "eleven full method reads observed" }, "x".repeat(4_000));
 const result = await f.service.run({ ...campaign(1), maxReadbackChars: 1 });
 assert.equal(result.outcome, "completed-no-candidate", result.stopReason ?? "");
 assert.equal(result.inspections?.length, 11);
 assert.equal(result.inspections?.reduce((sum, item) => sum + item.text.length, 0), 44_000);
 assert.ok(result.inspections?.every((item) => item.text.length === 4_000));
 assert.ok(f.views.every((view) => !("remainingActions" in view)));
 assert.throws(() => validateResearchAction({ kind: "inspect", read: { object: "method", id: f.views[0].current.executorVersionId, start: 0, maxChars: 4_001 } }, f.views[0] as never), /bounded inspect request/);
});

test("recent feedback window reports omissions without dropping registered history", async (t) => {
 const f = await fixture(t, (view) => !view.lastActionResult
  ? { kind: "probe", x: 2, rationale: "separate the hypotheses" }
  : { kind: "stop", reason: "development observation recorded" });
 const result = await f.service.run({ ...campaign(2), maxFeedbackItems: 1 });
 assert.equal(result.outcome, "completed-no-candidate");
 assert.deepEqual(f.views.map((view) => view.feedbackWindow), [
  { total: 1, visible: 1, omitted: 0 },
  { total: 2, visible: 1, omitted: 1 },
 ]);
 assert.equal(f.views[1].cases[0].feedbackCount, 2);
});
