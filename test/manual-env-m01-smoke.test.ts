import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { MAX_CNY_ESTIMATE, MAX_INPUT_PAYLOAD_BYTES, MODEL_PROFILE, SMOKE_MODEL, assertPreflight, boundedStageRunner, publicUsageFromSidecar, safeFailure } from "../scripts/manual-env-m01-smoke.ts";
import { verifyDeepSeekProviderOutputLimit } from "../src/runner/deepseek-provider-limits.ts";
import { HarnessError } from "../src/types.ts";

test("public M01 smoke has a monetary ceiling without a workflow call or output cap", () => {
  assertPreflight();
  assert.equal(SMOKE_MODEL, "deepseek/deepseek-flash:low");
  assert.equal(MAX_INPUT_PAYLOAD_BYTES, 12_000);
  assert.equal(MODEL_PROFILE.providers.deepseek.models[0].maxTokens, 393_216);
  assert.ok(MAX_CNY_ESTIMATE < 30);
});

test("public M01 reserves the live provider maximum per transport before spending", async () => {
  const provider = await verifyDeepSeekProviderOutputLimit({ apiKey: "synthetic-offline-key", request: async () => new Response(JSON.stringify({
    object: "list", data: [{ id: "deepseek-flash", object: "model", name: "DeepSeek-V4.1-Flash",
      context_window: 1_048_576, max_output_tokens: 393_216 }],
  }), { status: 200 }) });
  const runner = boundedStageRunner({} as ModelRuntime, provider);
  assert.equal(runner.campaignBudget.strictRequest.maxProviderCallsPerPrompt, undefined);
  assert.equal(runner.campaignBudget.strictRequest.maxOutputTokens, provider.maxOutputTokens);
  assert.equal(runner.campaignBudget.strictRequest.maxInputPayloadBytes, MAX_INPUT_PAYLOAD_BYTES);
  const lease = runner.campaignBudget.beginPrompt("offline", "first");
  assert.throws(() => runner.campaignBudget.reserve(lease, 100, "offline-request"), /CNY|ceiling|affordable/i);
  assert.equal(runner.campaignBudget.snapshot().reservations, 0);
});

test("isolated profile resolves the current official DeepSeek model offline", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mul-pis-profile-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const modelsPath = path.join(dir, "models.json");
  await writeFile(modelsPath, JSON.stringify(MODEL_PROFILE));
  const runtime = await ModelRuntime.create({ modelsPath, authPath: path.join(dir, "auth.json"),
    modelsStorePath: path.join(dir, "models-store.json"), allowModelNetwork: false, refreshOnCreate: false });
  const model = runtime.getModel("deepseek", "deepseek-flash");
  assert.equal(model?.id, "deepseek-flash");
  assert.equal(model?.api, "openai-completions");
  assert.equal(model?.baseUrl, "https://api.deepseek.com");
});

test("observed SDK usage prints only whitelisted scalars and rejects incomplete evidence", () => {
  const row = {
    version: 1, promptIndex: 1, outcome: "completed", rawPrompt: "SECRET_PROMPT",
    events: [{ kind: "assistant", status: "reported", costStatus: "priced", provider: "deepseek",
      model: "deepseek-flash", stopReason: "stop", rawResponse: "SECRET_RESPONSE" }],
    summary: { complete: true, costComplete: true, reportedEvents: 1, unknownEvents: 0,
      input: 100, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 120, cost: 0.0001,
      privatePath: "SECRET_PATH" },
  };
  const publicUsage = publicUsageFromSidecar(row);
  assert.deepEqual(publicUsage, { provider: "deepseek", model: "deepseek-flash", observedAssistantEvents: 1,
    inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0,
    totalTokens: 120, sdkEstimatedUsdCost: 0.0001, usageComplete: true, sdkCostComplete: true });
  assert.doesNotMatch(JSON.stringify(publicUsage), /SECRET_PROMPT|SECRET_RESPONSE|SECRET_PATH/);
  assert.throws(() => publicUsageFromSidecar({ ...row, summary: { ...row.summary, complete: false } }));
  assert.throws(() => publicUsageFromSidecar({ ...row, summary: { ...row.summary, cost: undefined } }));
  assert.throws(() => publicUsageFromSidecar({ ...row, events: [] }));
  assert.equal(publicUsageFromSidecar({ ...row, summary: { ...row.summary, output: 50_000 } }).outputTokens, 50_000);
  const multi = { ...row, events: [{ ...row.events[0], stopReason: "toolUse" }, row.events[0]],
    summary: { ...row.summary, reportedEvents: 2, input: 200, output: 40, totalTokens: 240, cost: 0.0002 } };
  assert.equal(publicUsageFromSidecar(multi).observedAssistantEvents, 2);
});

test("live-failure diagnostics reveal only whitelisted code, status and numeric usage", () => {
  const error = new HarnessError("runner.stop", "SECRET_PROMPT sk-SECRET provider body");
  Object.assign(error, { cause: { status: 429, message: "SECRET_RESPONSE" } });
  const usage = { outcome: "failed", prompt: "SECRET_PROMPT", events: [{ kind: "assistant", stopReason: "length", content: "SECRET_RESPONSE" }],
    summary: { complete: true, costComplete: true, reportedEvents: 1, unknownEvents: 0,
      input: 500, output: 2048, cacheRead: 0, cacheWrite: 0, totalTokens: 2548, cost: 0.001,
      privatePath: "SECRET_PATH" } };
  const diagnostic = safeFailure(error, "m01-stage", usage);
  assert.deepEqual(diagnostic, { check: "public-m01", ok: false, phase: "m01-stage", harnessCode: "runner.stop",
    httpStatus: 429, promptOutcome: "failed", inputTokens: 500, outputTokens: 2048,
    cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 2548, reportedEvents: 1,
    unknownEvents: 0, sdkEstimatedUsdCost: 0.001, usageComplete: true, sdkCostComplete: true,
    stopReason: "length" });
  assert.doesNotMatch(JSON.stringify(diagnostic), /SECRET_PROMPT|SECRET_RESPONSE|SECRET_PATH|sk-SECRET/);
  const unknown = safeFailure(new HarnessError("SECRET_CODE", "SECRET_MESSAGE"), "m01-stage", {
    outcome: "SECRET_OUTCOME", events: [{ kind: "assistant", stopReason: "SECRET_STOP" }],
    summary: { input: "SECRET_COUNT" },
  });
  assert.deepEqual(unknown, { check: "public-m01", ok: false, phase: "m01-stage" });
  assert.deepEqual(safeFailure(new HarnessError("runner.campaign", "SECRET_COST_CONTEXT"), "m01-stage"),
    { check: "public-m01", ok: false, phase: "m01-stage", harnessCode: "runner.campaign" });
});

test("manual run fails closed on a missing environment key without exposing details", async () => {
  const command = promisify(execFile);
  await assert.rejects(command(process.execPath, ["scripts/manual-env-m01-smoke.ts", "--run"], {
    cwd: process.cwd(), env: { ...process.env, DEEPSEEK_API_KEY: "" }, timeout: 20_000,
  }), (error: unknown) => {
    const failure = error as { stdout?: string; stderr?: string };
    assert.equal(failure.stdout, "");
    assert.match(failure.stderr ?? "", /"ok":false,"phase":"preflight"/);
    assert.doesNotMatch(failure.stderr ?? "", /api\.deepseek\.com|sk-|Generic public smoke/);
    return true;
  });
});
