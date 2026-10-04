import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { MAX_CNY_ESTIMATE, MAX_INPUT_PAYLOAD_BYTES, MAX_OUTPUT_TOKENS, MAX_PLANNING_CNY, MODEL_PROFILE, SMOKE_MODEL, assertPreflight, publicUsageFromSidecar } from "../scripts/manual-env-m01-smoke.ts";

test("public M01 smoke has a conservative single-call planning ceiling", () => {
  assertPreflight();
  assert.equal(SMOKE_MODEL, "deepseek/deepseek-flash:low");
  assert.equal(MAX_INPUT_PAYLOAD_BYTES, 12_000);
  assert.equal(MAX_OUTPUT_TOKENS, 2_048);
  assert.ok(MAX_PLANNING_CNY <= MAX_CNY_ESTIMATE);
  assert.ok(MAX_CNY_ESTIMATE < 30);
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
});

test("manual run fails closed on a missing environment key without exposing details", async () => {
  const command = promisify(execFile);
  await assert.rejects(command(process.execPath, ["scripts/manual-env-m01-smoke.ts", "--run"], {
    cwd: process.cwd(), env: { ...process.env, DEEPSEEK_API_KEY: "" }, timeout: 20_000,
  }), (error: unknown) => {
    const failure = error as { stdout?: string; stderr?: string };
    assert.equal(failure.stdout, "");
    assert.match(failure.stderr ?? "", /"ok":false/);
    assert.doesNotMatch(failure.stderr ?? "", /api\.deepseek\.com|sk-|Generic public smoke/);
    return true;
  });
});
