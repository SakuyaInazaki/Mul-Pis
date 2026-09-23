/** One no-tools provider request with a supervisor reservation and a hard runner boundary. */
import type { BudgetLease } from "../experiments/contracts.ts";
import { SharedBudget } from "../experiments/budget.ts";
import type { SessionRunner, SessionSpec, UsageSummary } from "../runner/types.ts";
import { HarnessError } from "../types.ts";
import { timedPrompt } from "./admission.ts";

export interface BoundedModelStep {
 text: string; sessionId: string; specFile?: string; usageSidecar?: string; usage: UsageSummary;
}
export async function runBoundedModelStep(args: {
 runner: SessionRunner; budget: SharedBudget; lease: BudgetLease; spec: Omit<SessionSpec, "tools" | "strictRequest">;
 message: string; timeoutMs: number; maxOutputTokens: number; maxInputTokens?: number;
}): Promise<BoundedModelStep> {
 const { runner, budget, lease } = args;
 const before = budget.status(lease);
 const maxOutputTokens = args.maxOutputTokens;
 if (!Number.isSafeInteger(args.maxOutputTokens) || args.maxOutputTokens < 1) throw new HarnessError("improvement.budget", "explicit per-prompt output limit is required");
 const payloadBytes = Buffer.byteLength(args.spec.systemPrompt, "utf8") + Buffer.byteLength(args.message, "utf8") + 8_192;
 if (args.message.length > 40_000 || args.spec.systemPrompt.length > 8_000 || payloadBytes > before.remaining.inputTokens || maxOutputTokens > before.remaining.outputTokens || (args.maxInputTokens !== undefined && payloadBytes > args.maxInputTokens)) throw new HarnessError("improvement.budget", "bounded model input/output budget exhausted before request");
 const priceLookup = runner as SessionRunner & { estimateMaxSdkCost?: (model: string, caps: { maxInputTokens: number; maxOutputTokens: number }) => Promise<number | undefined> };
 const priced = await priceLookup.estimateMaxSdkCost?.(args.spec.model, { maxInputTokens: payloadBytes, maxOutputTokens });
 const maxSdkEstimatedCost = priced === undefined ? undefined : Math.ceil(priced * 1_000_000_000) / 1_000_000_000;
 if (maxSdkEstimatedCost === undefined || maxSdkEstimatedCost <= 0 || maxSdkEstimatedCost > before.remaining.sdkEstimatedCost) throw new HarnessError("improvement.budget", "model price is unavailable or cost reservation exceeds caller cap");
 const spec: SessionSpec = { ...args.spec, tools: { kind: "none" }, strictRequest: { maxProviderCallsPerPrompt: 1, maxOutputTokens, maxInputPayloadBytes: payloadBytes } };
 const handle = await runner.create(spec);
 let reservation;
 try { reservation = budget.reservePrompt(lease, { maxInputTokens: payloadBytes, maxOutputTokens, maxSdkEstimatedCost }); }
 catch (error) { handle.dispose(); throw error; }
 let settled = false;
 try {
  const turn = await timedPrompt(handle, args.message, args.timeoutMs);
  const usage = turn.usage ?? handle.usageSummary();
  budget.settlePrompt(reservation, usage); settled = true;
  if (budget.status(lease).settlement !== "settled" || !usage.complete || !usage.costComplete || usage.reportedEvents < 1) throw new HarnessError("improvement.usage", "provider usage or SDK-estimated cost is incomplete");
  if (turn.text.length > 16_000) throw new HarnessError("improvement.reply", "model reply exceeds bounded action size");
  return { text: turn.text, sessionId: handle.ref.id, specFile: handle.ref.specFile, usageSidecar: handle.ref.file?.replace(/\.jsonl$/, ".usage.jsonl"), usage };
 } catch (error) {
  if (!settled) {
   // An aborted request can still settle remotely later. Its lower bound is not a completed total.
   budget.markUnknown(reservation);
  }
  throw error;
 } finally { handle.dispose(); }
}
