/** Manual, billable, PUBLIC-ONLY M01 validation. Never point this at lab material. */
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createFileKnowledgeStore } from "../src/knowledge/store.ts";
import { ResearchService } from "../src/pi/service.ts";
import { PiSessionRunner } from "../src/runner/pi.ts";
import type { SessionRunner } from "../src/runner/types.ts";
import { runInit } from "../src/stages/init.ts";
import { HarnessError } from "../src/types.ts";
import { Workspace } from "../src/workspace.ts";

export const SMOKE_MODEL = "deepseek/deepseek-flash:low";
export const MAX_INPUT_PAYLOAD_BYTES = 12_000;
export const MAX_OUTPUT_TOKENS = 8_192;
// The provider reported 2,049 output tokens for a 2,048-token request cap in
// the diagnostic run. Reserve a little extra for accounting variance.
export const OBSERVED_OUTPUT_MARGIN_TOKENS = 32;
export const MAX_PROVIDER_CALLS = 1;
export const MAX_CNY_ESTIMATE = 2.1;
// An intentionally pessimistic planning rate, not a billing guarantee.
const USD_PER_MILLION_TOKENS_CEILING = 10;
const CNY_PER_USD_CEILING = 10;
export const MAX_PLANNING_CNY =
  ((MAX_INPUT_PAYLOAD_BYTES + MAX_OUTPUT_TOKENS + OBSERVED_OUTPUT_MARGIN_TOKENS) * USD_PER_MILLION_TOKENS_CEILING / 1_000_000) * CNY_PER_USD_CEILING;

export interface PublicUsage {
  provider: "deepseek";
  model: "deepseek-flash";
  observedAssistantEvents: 1;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  sdkEstimatedUsdCost: number;
  usageComplete: true;
  sdkCostComplete: true;
}

type SmokePhase = "preflight" | "model-setup" | "m01-stage" | "usage-audit" | "cleanup";

const SAFE_HARNESS_CODES = new Set([
  "runner.model", "runner.stop", "runner.persistence", "runner.isolation", "runner.tools",
  "config.missing", "config.model", "config.roles", "config.role-unset", "problem.missing",
  "prompt.missing", "run.interrupted", "m07.busy",
]);
const SAFE_STOP_REASONS = new Set(["stop", "length", "error", "aborted", "toolUse"]);
const SAFE_OUTCOMES = new Set(["completed", "failed", "aborted"]);

function safeNonnegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** Diagnostics are reconstructed from an allowlist, never copied from SDK errors or transcripts. */
export function safeFailure(error: unknown, phase: SmokePhase, rawUsage?: unknown): Record<string, unknown> {
  const report: Record<string, unknown> = { check: "public-m01", ok: false, phase };
  if (error instanceof HarnessError && SAFE_HARNESS_CODES.has(error.code)) report.harnessCode = error.code;
  // Provider/HTTP errors vary by SDK. Numeric status is safe; their messages are not.
  let cause: unknown = error;
  for (let index = 0; index < 3 && cause && typeof cause === "object"; index++) {
    const candidate = cause as { status?: unknown; statusCode?: unknown; cause?: unknown };
    const status = candidate.status ?? candidate.statusCode;
    if (typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599) {
      report.httpStatus = status;
      break;
    }
    cause = candidate.cause;
  }
  if (rawUsage && typeof rawUsage === "object" && !Array.isArray(rawUsage)) {
    const row = rawUsage as Record<string, unknown>;
    if (typeof row.outcome === "string" && SAFE_OUTCOMES.has(row.outcome)) report.promptOutcome = row.outcome;
    const summary = row.summary && typeof row.summary === "object" && !Array.isArray(row.summary)
      ? row.summary as Record<string, unknown> : undefined;
    if (summary) {
      for (const [source, target] of [
        ["input", "inputTokens"], ["output", "outputTokens"], ["cacheRead", "cacheReadTokens"],
        ["cacheWrite", "cacheWriteTokens"], ["totalTokens", "totalTokens"],
        ["reportedEvents", "reportedEvents"], ["unknownEvents", "unknownEvents"],
        ["cost", "sdkEstimatedUsdCost"],
      ] as const) {
        const number = safeNonnegative(summary[source]);
        if (number !== undefined) report[target] = number;
      }
      if (typeof summary.complete === "boolean") report.usageComplete = summary.complete;
      if (typeof summary.costComplete === "boolean") report.sdkCostComplete = summary.costComplete;
    }
    if (Array.isArray(row.events) && row.events.length === 1) {
      const event = row.events[0];
      if (event && typeof event === "object" && !Array.isArray(event)) {
        const raw = event as Record<string, unknown>;
        if (raw.kind === "assistant" && typeof raw.stopReason === "string" && SAFE_STOP_REASONS.has(raw.stopReason)) report.stopReason = raw.stopReason;
      }
    }
  }
  return report;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("usage record is missing");
  return value as Record<string, unknown>;
}

function count(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || !Number.isInteger(value)) {
    throw new Error("SDK token usage is incomplete");
  }
  return value;
}

/** Return only approved scalar fields. Never serialize the source usage row. */
export function publicUsageFromSidecar(raw: unknown): PublicUsage {
  const row = object(raw);
  const events = row.events;
  const summary = object(row.summary);
  if (row.version !== 1 || row.promptIndex !== 1 || row.outcome !== "completed" || !Array.isArray(events) || events.length !== 1 ||
      summary.complete !== true || summary.costComplete !== true || summary.reportedEvents !== 1 || summary.unknownEvents !== 0) {
    throw new Error("SDK usage evidence is incomplete");
  }
  const event = object(events[0]);
  if (event.kind !== "assistant" || event.status !== "reported" || event.costStatus !== "priced" ||
      event.provider !== "deepseek" || event.model !== "deepseek-flash" || event.stopReason !== "stop") {
    throw new Error("unexpected SDK usage event");
  }
  const cost = summary.cost;
  if (typeof cost !== "number" || !Number.isFinite(cost) || cost < 0) throw new Error("SDK cost estimate is missing");
  if (count(summary.output) > MAX_OUTPUT_TOKENS + OBSERVED_OUTPUT_MARGIN_TOKENS) {
    throw new Error("observed output exceeded accounting reserve");
  }
  return {
    provider: "deepseek", model: "deepseek-flash", observedAssistantEvents: 1,
    inputTokens: count(summary.input), outputTokens: count(summary.output),
    cacheReadTokens: count(summary.cacheRead), cacheWriteTokens: count(summary.cacheWrite),
    totalTokens: count(summary.totalTokens), sdkEstimatedUsdCost: cost,
    usageComplete: true, sdkCostComplete: true,
  };
}

export function assertPreflight(): void {
  if (MAX_PROVIDER_CALLS !== 1 || MAX_PLANNING_CNY > MAX_CNY_ESTIMATE || MAX_CNY_ESTIMATE >= 30) {
    throw new Error("smoke budget preflight failed");
  }
}

// The pinned Pi SDK may still catalog the retired V4 name. This local, secret-free
// profile selects the current official API ID without touching a global Pi profile.
export const MODEL_PROFILE = {
  providers: {
    deepseek: {
      models: [{
        id: "deepseek-flash", name: "DeepSeek V4.1 Flash", api: "openai-completions",
        baseUrl: "https://api.deepseek.com", reasoning: true, input: ["text"],
        cost: { input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0 },
        contextWindow: 1_000_000, maxTokens: 384_000,
        compat: { supportsStore: false, supportsDeveloperRole: false, maxTokensField: "max_tokens", requiresReasoningContentOnAssistantMessages: true, thinkingFormat: "deepseek" },
        thinkingLevelMap: { low: "low", high: "high", max: "max" },
      }],
    },
  },
} as const;

export function boundedStageRunner(runtime: ModelRuntime, signal: AbortSignal): SessionRunner {
  const actual = new PiSessionRunner({ modelRuntime: runtime, signal });
  return {
    estimateMaxSdkCost: (model, caps) => actual.estimateMaxSdkCost(model, caps),
    create: (spec) => {
      if (spec.label !== "M01" || spec.model !== SMOKE_MODEL || spec.tools.kind !== "none") {
        throw new Error("smoke supports only one tool-free M01 session");
      }
      return actual.create({ ...spec, strictRequest: {
        maxProviderCallsPerPrompt: 1, maxOutputTokens: MAX_OUTPUT_TOKENS,
        maxInputPayloadBytes: MAX_INPUT_PAYLOAD_BYTES,
      } });
    },
    resume: async () => { throw new Error("smoke cannot resume a session"); },
  };
}

async function failedRunUsage(ws: Workspace): Promise<unknown> {
  const ids = await ws.listRuns("M01");
  if (ids.length !== 1) return undefined;
  const record = await ws.readRun("M01", ids[0]);
  const sessionFile = record.sessions[0]?.file;
  if (!sessionFile?.endsWith(".jsonl") || !path.resolve(sessionFile).startsWith(`${path.resolve(ws.sessionsDir)}${path.sep}`)) return undefined;
  const text = await readFile(sessionFile.replace(/\.jsonl$/, ".usage.jsonl"), "utf8");
  const rows = text.trim().split("\n");
  return rows.length === 1 ? JSON.parse(rows[0]) as unknown : undefined;
}

async function run(): Promise<void> {
  let phase: SmokePhase = "preflight";
  let temp: string | undefined;
  let ws: Workspace | undefined;
  let success: Record<string, unknown> | undefined;
  let failure: Record<string, unknown> | undefined;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 90_000);
  try {
    assertPreflight();
    const key = process.env.DEEPSEEK_API_KEY;
    if (!key || !key.trim()) throw new Error("DEEPSEEK_API_KEY is absent");
    temp = await mkdtemp(path.join(os.tmpdir(), "mul-pis-public-smoke-"));
    phase = "model-setup";
    const profile = path.join(temp, "profile");
    await mkdir(profile, { mode: 0o700 });
    await writeFile(path.join(profile, "models.json"), JSON.stringify(MODEL_PROFILE), { mode: 0o600 });
    const runtime = await ModelRuntime.create({
      modelsPath: path.join(profile, "models.json"), authPath: path.join(profile, "auth.json"),
      modelsStorePath: path.join(profile, "models-store.json"), allowModelNetwork: false, refreshOnCreate: false,
    });
    const model = runtime.getModel("deepseek", "deepseek-flash");
    if (model?.provider !== "deepseek" || model.id !== "deepseek-flash" ||
        model.api !== "openai-completions" || model.baseUrl !== "https://api.deepseek.com") {
      throw new Error("unexpected model or endpoint");
    }
    const runner = boundedStageRunner(runtime, controller.signal);
    const sdkEstimate = await runner.estimateMaxSdkCost?.(SMOKE_MODEL, {
      maxInputTokens: MAX_INPUT_PAYLOAD_BYTES, maxOutputTokens: MAX_OUTPUT_TOKENS + OBSERVED_OUTPUT_MARGIN_TOKENS,
    });
    if (sdkEstimate === undefined || !Number.isFinite(sdkEstimate) || sdkEstimate * CNY_PER_USD_CEILING > MAX_CNY_ESTIMATE) {
      throw new Error("SDK pricing preflight failed");
    }
    await runtime.setRuntimeApiKey("deepseek", key);
    ws = new Workspace(path.join(temp, "workspace"));
    await runInit(ws, createFileKnowledgeStore(ws.knowledgeDir));
    await writeFile(ws.configFile, JSON.stringify({ roles: { execution: SMOKE_MODEL }, concurrency: 1 }), { mode: 0o600 });
    await writeFile(ws.problemFile, "Generic public smoke: explain why 2 + 3 = 5, briefly. This is a connectivity check only.\n", { mode: 0o600 });
    const service = new ResearchService({ defaultWorkspace: ws.root, runnerFactory: () => runner,
      promptTimeoutMs: 90_000, stallTimeoutMs: 60_000, progressIntervalMs: 0 });
    phase = "m01-stage";
    const result = await service.runStage({ stage: "M01" }, controller.signal) as { record: { status: string; sessions: Array<{ file?: string }> }; output: string };
    if (result.record.status !== "completed" || result.record.sessions.length !== 1 || !result.output.trim()) {
      throw new Error("M01 did not return a nonempty result");
    }
    phase = "usage-audit";
    const sessionFile = result.record.sessions[0]?.file;
    if (!sessionFile?.endsWith(".jsonl") || !path.resolve(sessionFile).startsWith(`${path.resolve(ws.sessionsDir)}${path.sep}`)) {
      throw new Error("Pi usage sidecar is unavailable");
    }
    const usageText = await readFile(sessionFile.replace(/\.jsonl$/, ".usage.jsonl"), "utf8");
    const usageRows = usageText.trim().split("\n");
    if (usageRows.length !== 1) throw new Error("expected one Pi usage row");
    const observedUsage = publicUsageFromSidecar(JSON.parse(usageRows[0]));
    success = { check: "public-m01", ok: true, stage: "M01", model: SMOKE_MODEL,
      providerCallsMaximum: MAX_PROVIDER_CALLS, planningCnyMaximum: Number(MAX_PLANNING_CNY.toFixed(4)), observedUsage };
  } catch (error) {
    const rawUsage = ws ? await failedRunUsage(ws).catch(() => undefined) : undefined;
    failure = safeFailure(error, phase, rawUsage);
  } finally {
    clearTimeout(timer);
    if (temp) {
      try { await rm(temp, { recursive: true, force: true }); }
      catch { success = undefined; failure = safeFailure(undefined, "cleanup"); }
    }
  }
  if (success && !failure) process.stdout.write(JSON.stringify(success) + "\n");
  else {
    process.stderr.write(JSON.stringify(failure ?? safeFailure(undefined, "preflight")) + "\n");
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  const mode = process.argv[2];
  if (mode === "--check") {
    assertPreflight();
    process.stdout.write(JSON.stringify({ check: "offline-preflight", ok: true, planningCnyMaximum: Number(MAX_PLANNING_CNY.toFixed(4)) }) + "\n");
  } else if (mode === "--run") {
    run().catch(() => {
      // Last-resort fixed message; never print provider errors, prompts, paths or credentials.
      process.stderr.write(JSON.stringify(safeFailure(undefined, "preflight")) + "\n");
      process.exitCode = 1;
    });
  } else {
    process.stderr.write("usage: node scripts/manual-env-m01-smoke.ts <--check|--run>\n");
    process.exitCode = 2;
  }
}
