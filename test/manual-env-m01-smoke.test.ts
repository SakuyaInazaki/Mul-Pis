import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { MAX_INPUT_PAYLOAD_BYTES, MODEL_PROFILE, SMOKE_MODEL, boundedStageRunner } from "../scripts/manual-env-m01-smoke.ts";
import { verifyDeepSeekProviderOutputLimit } from "../src/runner/deepseek-provider-limits.ts";

test("public M01 applies only the input-byte guard and keeps the live provider output maximum", async (t) => {
  const provider = await verifyDeepSeekProviderOutputLimit({ apiKey: "synthetic-offline-key", request: async () => new Response(JSON.stringify({
    object: "list", data: [{ id: "deepseek-flash", object: "model", name: "DeepSeek-V4.1-Flash",
      context_window: 1_048_576, max_output_tokens: 393_216 }],
  }), { status: 200 }) });
  const dir = await mkdtemp(path.join(os.tmpdir(), "mul-pis-public-smoke-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const modelsPath = path.join(dir, "models.json");
  await writeFile(modelsPath, JSON.stringify({ providers: { deepseek: { models: [{ ...MODEL_PROFILE.providers.deepseek.models[0],
    maxTokens: provider.maxOutputTokens, contextWindow: provider.contextWindow }] } } }));
  const runtime = await ModelRuntime.create({ modelsPath, authPath: path.join(dir, "auth.json"),
    modelsStorePath: path.join(dir, "models-store.json"), allowModelNetwork: false, refreshOnCreate: false });
  assert.equal(runtime.getModel("deepseek", "deepseek-flash")?.maxTokens, provider.maxOutputTokens);
  assert.throws(() => boundedStageRunner(runtime, { ...provider }), /live-verified/);
  const runner = boundedStageRunner(runtime, provider);
  const handle = await runner.create({ label: "M01", role: "execution", model: SMOKE_MODEL,
    systemPrompt: "Offline fixed public test", tools: { kind: "none" }, persistDir: path.join(dir, "sessions"),
    strictRequest: { maxOutputTokens: 1, maxInputPayloadBytes: 100 } });
  t.after(() => handle.dispose());
  assert(handle.ref.specFile);
  const persisted = JSON.parse(await readFile(handle.ref.specFile, "utf8")) as Record<string, unknown>;
  assert.deepEqual(persisted.strictRequest, { maxInputPayloadBytes: MAX_INPUT_PAYLOAD_BYTES });
  assert.equal(persisted.model, SMOKE_MODEL);
  assert.equal("campaignBudget" in runner, false);
  assert.throws(() => runner.create({ label: "M02", role: "execution", model: SMOKE_MODEL,
    systemPrompt: "Offline", tools: { kind: "none" }, persistDir: path.join(dir, "other") }), /only one tool-free M01/);
});
