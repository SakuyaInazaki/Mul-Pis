/** Versioned, data-only methods for the bounded method-research laboratory. */
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import type { ExecutorStrategyV1 } from "../experiments/contracts.ts";
import type { KnowledgeRef } from "../knowledge/types.ts";
import { isKnowledgeRef } from "../knowledge/experience-index.ts";
import { HarnessError } from "../types.ts";
import { nowIso, readTextIfExists, writeFileAtomic } from "../workspace.ts";

export interface ImproverStrategyV1 { version: 1; kind: "diagnostic-improver-prompt"; body: string }
/** A workflow method is a separate H capability, never a CPU-case strategy. */
export interface M07WorkflowStrategyV1 { version: 1; kind: "m07-workflow-prompt"; slot: "research-check" | "evidence-handoff"; body: string }
export type ResearchStrategy = ExecutorStrategyV1 | M07WorkflowStrategyV1 | ImproverStrategyV1;
export function isCpuExecutorStrategy(value: ResearchStrategy): value is ExecutorStrategyV1 { return value.kind === "cpu-numerical-prompt"; }
export function isM07WorkflowStrategy(value: ResearchStrategy): value is M07WorkflowStrategyV1 { return value.kind === "m07-workflow-prompt"; }
export type StrategyKind = "executor" | "improver";
export type StrategyOrigin = "human-seed" | "agent-generated" | "external-manual-unverified";
export interface ExperienceRequirementV1 { targetKind: StrategyKind; ref: KnowledgeRef }
export interface DependencyTransitionV1 {
 version: 1; decisionRef: KnowledgeRef; removedRefs: KnowledgeRef[]; addedRefs: KnowledgeRef[];
 evidenceRefs: KnowledgeRef[]; revalidationRef: KnowledgeRef; at: string;
}
export interface StrategyRecordV1 {
 version: 1; versionId: string; kind: StrategyKind; artifact: ResearchStrategy;
 parentVersionId?: string; origin: StrategyOrigin; createdAt: string;
 applicability: string[]; limitations: string[];
 /** References actually loaded while generating this body; this is provenance, not proof of use. */
 sourceExperienceRefs: ExperienceRequirementV1[];
 /** Conservative inherited live-stop obligations; a candidate cannot self-delete them. */
 requiredExperienceRefs: ExperienceRequirementV1[];
 /** Pinned scientific premises, distinct from consulted method experience. */
 requiredKnowledgeRefs: KnowledgeRef[];
 /** Immutable provenance for an explicit controller-checked dependency transition. */
 dependencyTransition?: DependencyTransitionV1;
 /** A candidate can be exercised for research without becoming active. */
 state: "research-only" | "admitted" | "manual-active";
}
export interface GenerationBundleV1 {
 version: 1; bundleId: string; parents: string[]; executorVersionId: string; improverVersionId: string;
 knowledgeSnapshot?: string; environmentVersion: string; modelConfig: { improver: string; research: string };
 protocolVersion: string; allowedCapabilities: Array<"cpu-probe" | "no-tools-model" | "m07-evidence-read">;
 state: "research-only" | "admitted" | "manual-active"; createdAt: string;
}
export interface ActiveGenerationPointerV1 {
 version: 1; bundleId: string; previousBundleId?: string; previousProvenance?: ActiveGenerationPointerV1["provenance"]; activatedAt: string;
	provenance: "local-executor-admission" | "local-workflow-handoff-admission" | "local-meta-admission" | "human-seed" | "external-manual-unverified" | "knowledge-epoch-advance" | "method-dependency-transition";
 runId: string;
}
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
function safeId(value: unknown, field: string): string {
 if (typeof value !== "string" || !SAFE_ID.test(value)) throw new HarnessError("improvement.generation", `${field} is not a safe identifier`);
 return value;
}
function boundedBody(value: unknown, field: string): string {
 if (typeof value !== "string" || !value.trim() || value.length > 4_000 || /\0/.test(value)) throw new HarnessError("improvement.strategy", `${field} must be 1–4000 characters`);
 return value.trim();
}
function boundedStrings(value: unknown, field: string, max = 16): string[] {
 if (!Array.isArray(value) || value.length > max || !value.every((item) => typeof item === "string" && item.trim().length > 0 && item.length <= 240)) throw new HarnessError("improvement.strategy", `${field} must be a bounded string array`);
 return value;
}
export function validateExperienceRequirements(value: unknown, field: string): ExperienceRequirementV1[] {
 if (!Array.isArray(value) || value.length > 40 || !value.every((x) => x && typeof x === "object" && ["executor", "improver"].includes(x.targetKind) && isKnowledgeRef(x.ref))) throw new HarnessError("improvement.generation", `${field} must be at most 40 pinned experience references`);
 const seen = new Set(value.map((x) => `${x.targetKind}:${x.ref.storeId}/${x.ref.recordId}@${x.ref.version}`));
 if (seen.size !== value.length) throw new HarnessError("improvement.generation", `${field} contains duplicate references`);
 return value as ExperienceRequirementV1[];
}
export function validateStrategy(kind: StrategyKind, input: unknown): ResearchStrategy {
 if (!input || typeof input !== "object" || Array.isArray(input)) throw new HarnessError("improvement.strategy", "strategy must be an object");
 const value = input as Record<string, unknown>;
 if (value.version !== 1) throw new HarnessError("improvement.strategy", "unsupported strategy schema");
 if (kind === "executor" && value.kind === "m07-workflow-prompt") {
  if (Object.keys(value).some((key) => !["version", "kind", "slot", "body"].includes(key)) || !["research-check", "evidence-handoff"].includes(String(value.slot))) throw new HarnessError("improvement.strategy", "invalid M07 workflow method slot");
  return { version: 1, kind: "m07-workflow-prompt", slot: value.slot, body: boundedBody(value.body, "body") } as M07WorkflowStrategyV1;
 }
 if (Object.keys(value).some((key) => !["version", "kind", "body"].includes(key)) || value.kind !== (kind === "executor" ? "cpu-numerical-prompt" : "diagnostic-improver-prompt")) throw new HarnessError("improvement.strategy", "unsupported strategy schema");
 return { version: 1, kind: value.kind, body: boundedBody(value.body, "body") } as ResearchStrategy;
}
export function validateStrategyRecord(input: unknown): StrategyRecordV1 {
 if (!input || typeof input !== "object" || Array.isArray(input)) throw new HarnessError("improvement.generation", "strategy record must be an object");
 const item = input as Record<string, unknown>;
 if (Object.keys(item).some((key) => !["version", "versionId", "kind", "artifact", "parentVersionId", "origin", "createdAt", "applicability", "limitations", "sourceExperienceRefs", "requiredExperienceRefs", "requiredKnowledgeRefs", "dependencyTransition", "state"].includes(key)) || item.version !== 1 || !["executor", "improver"].includes(String(item.kind)) || !["human-seed", "agent-generated", "external-manual-unverified"].includes(String(item.origin)) || !["research-only", "admitted", "manual-active"].includes(String(item.state)) || typeof item.createdAt !== "string") throw new HarnessError("improvement.generation", "invalid strategy record");
 safeId(item.versionId, "versionId"); if (item.parentVersionId !== undefined) safeId(item.parentVersionId, "parentVersionId");
 const sourceExperienceRefs = validateExperienceRequirements(item.sourceExperienceRefs ?? [], "sourceExperienceRefs");
 const requiredExperienceRefs = validateExperienceRequirements(item.requiredExperienceRefs ?? [], "requiredExperienceRefs");
 const requiredKnowledgeRefs = item.requiredKnowledgeRefs ?? [];
 if (!Array.isArray(requiredKnowledgeRefs) || requiredKnowledgeRefs.length > 100 || !requiredKnowledgeRefs.every(isKnowledgeRef) || new Set(requiredKnowledgeRefs.map((ref) => `${ref.storeId}/${ref.recordId}@${ref.version}`)).size !== requiredKnowledgeRefs.length) throw new HarnessError("improvement.generation", "requiredKnowledgeRefs must be bounded distinct pinned references");
 if (item.dependencyTransition !== undefined) {
  const transition = item.dependencyTransition as Record<string, unknown>;
  if (!transition || typeof transition !== "object" || Array.isArray(transition) || Object.keys(transition).some((key) => !["version", "decisionRef", "removedRefs", "addedRefs", "evidenceRefs", "revalidationRef", "at"].includes(key)) || transition.version !== 1 || !isKnowledgeRef(transition.decisionRef) || !isKnowledgeRef(transition.revalidationRef) || typeof transition.at !== "string" || !Array.isArray(transition.removedRefs) || !Array.isArray(transition.addedRefs) || !Array.isArray(transition.evidenceRefs) || transition.removedRefs.length + transition.addedRefs.length > 100 || transition.evidenceRefs.length < 1 || transition.evidenceRefs.length > 20 || ![...transition.removedRefs, ...transition.addedRefs, ...transition.evidenceRefs].every(isKnowledgeRef)) throw new HarnessError("improvement.generation", "invalid method dependency transition provenance");
 }
 return { ...item, artifact: validateStrategy(item.kind as StrategyKind, item.artifact), applicability: boundedStrings(item.applicability, "applicability"), limitations: boundedStrings(item.limitations, "limitations"), sourceExperienceRefs, requiredExperienceRefs, requiredKnowledgeRefs } as StrategyRecordV1;
}
export function validateGenerationBundle(input: unknown): GenerationBundleV1 {
 if (!input || typeof input !== "object" || Array.isArray(input)) throw new HarnessError("improvement.generation", "bundle must be an object");
 const item = input as Record<string, unknown>;
 if (item.version !== 1 || !Array.isArray(item.parents) || item.parents.length > 4 || !item.parents.every((x) => typeof x === "string" && SAFE_ID.test(x)) || !["research-only", "admitted", "manual-active"].includes(String(item.state)) || typeof item.createdAt !== "string" || typeof item.environmentVersion !== "string" || typeof item.protocolVersion !== "string" || !item.modelConfig || typeof item.modelConfig !== "object") throw new HarnessError("improvement.generation", "invalid bundle");
 safeId(item.bundleId, "bundleId"); safeId(item.executorVersionId, "executorVersionId"); safeId(item.improverVersionId, "improverVersionId");
 if (item.knowledgeSnapshot !== undefined) safeId(item.knowledgeSnapshot, "knowledgeSnapshot");
 const models = item.modelConfig as Record<string, unknown>;
 if (typeof models.improver !== "string" || typeof models.research !== "string" || !Array.isArray(item.allowedCapabilities) || item.allowedCapabilities.some((x: unknown) => !["cpu-probe", "no-tools-model", "m07-evidence-read"].includes(String(x)))) throw new HarnessError("improvement.generation", "invalid bundle model/capabilities");
 return item as unknown as GenerationBundleV1;
}
export function validateActiveGenerationPointer(input: unknown): ActiveGenerationPointerV1 {
 if (!input || typeof input !== "object" || Array.isArray(input)) throw new HarnessError("improvement.generation", "invalid active generation pointer");
 const item = input as Record<string, unknown>;
	if (item.version !== 1 || typeof item.activatedAt !== "string" || typeof item.runId !== "string" || !["local-executor-admission", "local-workflow-handoff-admission", "local-meta-admission", "human-seed", "external-manual-unverified", "knowledge-epoch-advance", "method-dependency-transition"].includes(String(item.provenance)) || (item.previousProvenance !== undefined && !["local-executor-admission", "local-workflow-handoff-admission", "local-meta-admission", "human-seed", "external-manual-unverified", "knowledge-epoch-advance", "method-dependency-transition"].includes(String(item.previousProvenance)))) throw new HarnessError("improvement.generation", "invalid active generation pointer");
 safeId(item.bundleId, "bundleId"); if (item.previousBundleId !== undefined) safeId(item.previousBundleId, "previousBundleId");
 return item as unknown as ActiveGenerationPointerV1;
}

export class GenerationStore {
 readonly root: string;
 constructor(workspaceRoot: string) { this.root = path.join(path.resolve(workspaceRoot), ".agent", "improvement", "research"); }
 private strategyPath(id: string): string { return path.join(this.root, "strategies", `${safeId(id, "versionId")}.json`); }
 private bundlePath(id: string): string { return path.join(this.root, "bundles", `${safeId(id, "bundleId")}.json`); }
 private pointerPath(): string { return path.join(this.root, "active.json"); }
 newId(prefix: string): string { return `${prefix}-${new Date().toISOString().replace(/[-:.]/g, "")}-${randomBytes(3).toString("hex")}`; }
 async writeStrategy(input: Omit<StrategyRecordV1, "version" | "createdAt" | "sourceExperienceRefs" | "requiredExperienceRefs" | "requiredKnowledgeRefs" | "dependencyTransition"> & Partial<Pick<StrategyRecordV1, "sourceExperienceRefs" | "requiredExperienceRefs" | "requiredKnowledgeRefs" | "dependencyTransition">>): Promise<StrategyRecordV1> {
  const record = validateStrategyRecord({ version: 1, createdAt: nowIso(), ...input });
  const file = this.strategyPath(record.versionId);
  if (existsSync(file)) throw new HarnessError("improvement.generation", "strategy version already exists");
  await writeFileAtomic(file, `${JSON.stringify(record, null, 2)}\n`); return record;
 }
 async readStrategy(id: string): Promise<StrategyRecordV1> {
  const text = await readTextIfExists(this.strategyPath(id)); if (!text) throw new HarnessError("improvement.generation", `strategy ${id} does not exist`);
  const record = validateStrategyRecord(JSON.parse(text)); if (record.versionId !== id) throw new HarnessError("improvement.generation", "strategy identity mismatch"); return record;
 }
 async writeBundle(input: Omit<GenerationBundleV1, "version" | "createdAt">): Promise<GenerationBundleV1> {
  const bundle = validateGenerationBundle({ version: 1, createdAt: nowIso(), ...input });
  if (existsSync(this.bundlePath(bundle.bundleId))) throw new HarnessError("improvement.generation", "bundle version already exists");
  const [h, i] = await Promise.all([this.readStrategy(bundle.executorVersionId), this.readStrategy(bundle.improverVersionId)]);
  if (h.kind !== "executor" || i.kind !== "improver") throw new HarnessError("improvement.generation", "bundle strategy kinds are incompatible");
  await writeFileAtomic(this.bundlePath(bundle.bundleId), `${JSON.stringify(bundle, null, 2)}\n`); return bundle;
 }
 async readBundle(id: string): Promise<GenerationBundleV1> {
  const text = await readTextIfExists(this.bundlePath(id)); if (!text) throw new HarnessError("improvement.generation", `bundle ${id} does not exist`);
  const bundle = validateGenerationBundle(JSON.parse(text)); if (bundle.bundleId !== id) throw new HarnessError("improvement.generation", "bundle identity mismatch"); return bundle;
 }
 async active(): Promise<{ pointer: ActiveGenerationPointerV1; bundle: GenerationBundleV1 } | undefined> {
  const text = await readTextIfExists(this.pointerPath()); if (!text) return undefined;
  const pointer = validateActiveGenerationPointer(JSON.parse(text)); return { pointer, bundle: await this.readBundle(pointer.bundleId) };
 }
 /** The atomic pointer replacement is the activation commit point; caller holds mutation lock. */
 async activate(bundleId: string, previous: ActiveGenerationPointerV1 | undefined, provenance: ActiveGenerationPointerV1["provenance"], runId: string): Promise<ActiveGenerationPointerV1> {
  await this.readBundle(bundleId);
  const current = (await this.active())?.pointer;
  if ((current?.bundleId ?? null) !== (previous?.bundleId ?? null) || (current?.runId ?? null) !== (previous?.runId ?? null)) throw new HarnessError("improvement.stale-baseline", "active generation changed during evaluation");
  const pointer: ActiveGenerationPointerV1 = { version: 1, bundleId, ...(previous ? { previousBundleId: previous.bundleId, previousProvenance: previous.provenance } : {}), activatedAt: nowIso(), provenance, runId };
  await writeFileAtomic(this.pointerPath(), `${JSON.stringify(pointer, null, 2)}\n`); return pointer;
 }
 async rollback(): Promise<ActiveGenerationPointerV1> {
  const current = (await this.active())?.pointer;
  if (!current?.previousBundleId) throw new HarnessError("improvement.rollback", "no previous research generation");
  await this.readBundle(current.previousBundleId);
  return this.activate(current.previousBundleId, current, current.previousProvenance ?? "external-manual-unverified", `rollback-${this.newId("research")}`);
 }
 async listBundles(): Promise<string[]> { await mkdir(path.join(this.root, "bundles"), { recursive: true }); return (await readdir(path.join(this.root, "bundles"))).filter((x) => x.endsWith(".json")).map((x) => x.slice(0, -5)); }
}
