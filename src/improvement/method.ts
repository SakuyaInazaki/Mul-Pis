/** Transferable budget method metadata. Import never imports scientific workspace knowledge. */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { HarnessError } from "../types.ts";
import { readTextIfExists } from "../workspace.ts";
import { validateActiveBudgetPointer, validateBudgetPolicy, type BudgetPolicy } from "./policy.ts";

export interface MethodPackageV1 {
 version: 1;
 methodType: "budget-policy";
 sourceVersionId: string;
 policy: BudgetPolicy;
 applicability: string;
 provenance: "local-mechanism-admission" | "legacy-projection-only";
 admissionSummary?: { scope: "local-mechanism-projection-readback"; caseSetSplit: "development" | "admission"; checkedCases: number; queryCount: number; baselineCost: number; candidateCost: number };
}
export function validateMethodPackage(value: unknown): MethodPackageV1 {
 if (!value || typeof value !== "object" || Array.isArray(value)) throw new HarnessError("improvement.method", "method package must be an object");
 const item = value as Record<string, unknown>;
 const allowed = new Set(["version", "methodType", "sourceVersionId", "policy", "applicability", "provenance", "admissionSummary"]);
 if (Object.keys(item).some((key) => !allowed.has(key))) throw new HarnessError("improvement.method", "method package has unsupported fields");
 if (item.version !== 1 || item.methodType !== "budget-policy" || typeof item.sourceVersionId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(item.sourceVersionId) || typeof item.applicability !== "string" || !item.applicability.trim() || !["local-mechanism-admission", "legacy-projection-only"].includes(String(item.provenance))) throw new HarnessError("improvement.method", "invalid method package");
 const policy = validateBudgetPolicy(item.policy);
 const summary = item.admissionSummary;
 if (summary !== undefined) {
  if (!summary || typeof summary !== "object" || (summary as Record<string, unknown>).scope !== "local-mechanism-projection-readback") throw new HarnessError("improvement.method", "invalid admission summary");
 }
 return { version: 1, methodType: "budget-policy", sourceVersionId: item.sourceVersionId, policy, applicability: item.applicability, provenance: item.provenance, ...(summary ? { admissionSummary: summary } : {}) } as MethodPackageV1;
}
export async function readMethodPackage(file: string): Promise<MethodPackageV1> {
 let parsed: unknown;
 try { parsed = JSON.parse(await readFile(file, "utf8")); } catch (error) { throw new HarnessError("improvement.method", `cannot read method package: ${(error as Error).message}`); }
 return validateMethodPackage(parsed);
}
export async function loadActiveMethodBinding(workspaceRoot: string): Promise<{ versionId: string; contentId?: string }> {
 const text = await readTextIfExists(path.join(workspaceRoot, ".agent", "improvement", "active.json"));
 if (!text) return { versionId: "builtin-default" };
 let pointer: unknown;
 try { pointer = JSON.parse(text); } catch { throw new HarnessError("improvement.active", "active.json is not valid JSON"); }
 return { versionId: validateActiveBudgetPointer(pointer).versionId };
}
