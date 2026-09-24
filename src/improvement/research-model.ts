/** One no-tools provider request with a supervisor reservation and a hard runner boundary. */
import type { BudgetLease } from "../experiments/contracts.ts";
import { SharedBudget } from "../experiments/budget.ts";
import type { SessionRunner, SessionSpec, UsageSummary } from "../runner/types.ts";
import { HarnessError } from "../types.ts";
import { timedPrompt } from "./admission.ts";

export interface BoundedModelStep {
 text: string; sessionId: string; specFile?: string; usageSidecar?: string; usage: UsageSummary;
}
export interface PreparedModelRequest {
 spec: SessionSpec;
 message: string;
 /** UTF-8 bytes of the two caller-owned prompt strings, before SDK serialization. */
 promptBytes: number;
 /** Conservative byte ceiling for the serialized provider payload, enforced by Pi. */
 payloadByteCeiling: number;
 /** Conservative input-token reservation, not observed provider usage. */
 inputTokenCeiling: number;
}

/** Compile once for both dry-run checks and dispatch. SDK/provider usage remains separate. */
export function prepareModelRequest(args: { spec: Omit<SessionSpec, "tools" | "strictRequest">; message: string }): PreparedModelRequest {
 const promptBytes = Buffer.byteLength(args.spec.systemPrompt, "utf8") + Buffer.byteLength(args.message, "utf8");
 // The SDK adds a fixed boundary and JSON request envelope. A byte count is a
 // conservative token reservation for these text-only, no-tools requests.
 const payloadByteCeiling = promptBytes + 2_048;
 const inputTokenCeiling = payloadByteCeiling;
 return { spec: { ...args.spec, tools: { kind: "none" }, strictRequest: { maxProviderCallsPerPrompt: 1, maxInputPayloadBytes: payloadByteCeiling } }, message: args.message, promptBytes, payloadByteCeiling, inputTokenCeiling };
}
export async function runBoundedModelStep(args: {
 runner: SessionRunner; budget: SharedBudget; lease: BudgetLease; spec: Omit<SessionSpec, "tools" | "strictRequest">;
 message: string; timeoutMs: number;
}): Promise<BoundedModelStep> {
 const { runner, budget, lease } = args;
 const before = budget.status(lease);
 const prepared = prepareModelRequest(args);
 const { inputTokenCeiling } = prepared;
 if (inputTokenCeiling > before.remaining.inputTokens) throw new HarnessError("improvement.budget", "prepared input exceeds remaining campaign input budget");
 if (before.remaining.outputTokens < 1 || before.remaining.sdkEstimatedCost <= 0) throw new HarnessError("improvement.budget", "campaign output or cost budget exhausted before request");
 const priced = await runner.estimateMaxSdkCost?.(args.spec.model, { maxInputTokens: 1, maxOutputTokens: 1 });
 if (typeof priced !== "number" || !Number.isFinite(priced) || priced <= 0) throw new HarnessError("improvement.budget", "SDK model price is unavailable");
 const handle = await runner.create(prepared.spec);
 let reservation;
 try { reservation = budget.reserveObservedPrompt(lease, { maxInputTokens: inputTokenCeiling }); }
 catch (error) { handle.dispose(); throw error; }
 let settled = false;
 try {
  const turn = await timedPrompt(handle, prepared.message, args.timeoutMs);
  const usage = turn.usage ?? handle.usageSummary();
  budget.settlePrompt(reservation, usage); settled = true;
  if (budget.status(lease).settlement !== "settled" || !usage.complete || !usage.costComplete || usage.reportedEvents < 1) throw new HarnessError("improvement.usage", "provider usage or SDK-estimated cost is incomplete");
  return { text: turn.text, sessionId: handle.ref.id, specFile: handle.ref.specFile, usageSidecar: handle.ref.file?.replace(/\.jsonl$/, ".usage.jsonl"), usage };
 } catch (error) {
  if (!settled) {
   // An aborted request can still settle remotely later. Its lower bound is not a completed total.
   budget.markUnknown(reservation);
  }
  throw error;
 } finally { handle.dispose(); }
}
