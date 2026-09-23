/** Explicit transfer of bounded strategy data. Import is manual, never proof of admission. */
import { readFile, stat } from "node:fs/promises";
import { HarnessError } from "../types.ts";
import { writeFileAtomic } from "../workspace.ts";
import { GenerationStore, type ActiveGenerationPointerV1, type ExperienceRequirementV1, type GenerationBundleV1, type ResearchStrategy, type StrategyKind, type StrategyRecordV1, validateExperienceRequirements, validateStrategy } from "./generation.ts";

export interface MethodPackageV2 {
 version: 2;
 methodType: StrategyKind;
 sourceVersionId: string;
 sourceBundleId?: string;
 parentVersionId?: string;
 artifact: ResearchStrategy;
 origin: "human-seed" | "agent-generated" | "external-manual-unverified";
 applicability: string[];
 limitations: string[];
 sourceExperienceRefs: ExperienceRequirementV1[];
 requiredExperienceRefs: ExperienceRequirementV1[];
 /** Informational only: the importing workspace has not independently checked these claims. */
 sourceScope: "research-only" | "local-executor-quality" | "local-meta-improvement" | "manual";
}
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
function id(value: unknown, name: string): string {
 if (typeof value !== "string" || !ID.test(value)) throw new HarnessError("improvement.method-v2", `${name} is invalid`);
 return value;
}
function boundedStrings(value: unknown, name: string): string[] {
 if (!Array.isArray(value) || value.length > 16 || !value.every((x) => typeof x === "string" && !!x.trim() && x.length <= 240)) throw new HarnessError("improvement.method-v2", `${name} is invalid`);
 return value;
}
export function validateMethodPackageV2(input: unknown): MethodPackageV2 {
 if (!input || typeof input !== "object" || Array.isArray(input)) throw new HarnessError("improvement.method-v2", "package must be an object");
 const item = input as Record<string, unknown>;
 const allowed = new Set(["version", "methodType", "sourceVersionId", "sourceBundleId", "parentVersionId", "artifact", "origin", "applicability", "limitations", "sourceExperienceRefs", "requiredExperienceRefs", "sourceScope"]);
 if (Object.keys(item).some((key) => !allowed.has(key)) || item.version !== 2 || !["executor", "improver"].includes(String(item.methodType)) || !["human-seed", "agent-generated", "external-manual-unverified"].includes(String(item.origin)) || !["research-only", "local-executor-quality", "local-meta-improvement", "manual"].includes(String(item.sourceScope))) throw new HarnessError("improvement.method-v2", "unsupported package schema");
 id(item.sourceVersionId, "sourceVersionId"); if (item.sourceBundleId !== undefined) id(item.sourceBundleId, "sourceBundleId"); if (item.parentVersionId !== undefined) id(item.parentVersionId, "parentVersionId");
 const sourceExperienceRefs = validateExperienceRequirements(item.sourceExperienceRefs, "sourceExperienceRefs");
 const requiredExperienceRefs = validateExperienceRequirements(item.requiredExperienceRefs, "requiredExperienceRefs");
 if (sourceExperienceRefs.some((source) => !requiredExperienceRefs.some((required) => JSON.stringify(source) === JSON.stringify(required)))) throw new HarnessError("improvement.method-v2", "source experience cannot be omitted from required refs");
 return { ...item, artifact: validateStrategy(item.methodType as StrategyKind, item.artifact), applicability: boundedStrings(item.applicability, "applicability"), limitations: boundedStrings(item.limitations, "limitations"), sourceExperienceRefs, requiredExperienceRefs } as MethodPackageV2;
}
export async function readMethodPackageV2(file: string): Promise<MethodPackageV2> {
 let raw: unknown;
 try { if ((await stat(file)).size > 64_000) throw new Error("package exceeds 64 KB"); raw = JSON.parse(await readFile(file, "utf8")); } catch (error) { throw new HarnessError("improvement.method-v2", `cannot read package: ${(error as Error).message}`); }
 return validateMethodPackageV2(raw);
}
export async function exportMethodPackageV2(store: GenerationStore, strategyVersionId: string, sourceScope: MethodPackageV2["sourceScope"], outputPath: string): Promise<MethodPackageV2> {
 const record = await store.readStrategy(strategyVersionId);
 const pkg: MethodPackageV2 = { version: 2, methodType: record.kind, sourceVersionId: record.versionId, artifact: record.artifact, origin: record.origin, applicability: record.applicability, limitations: record.limitations, sourceExperienceRefs: record.sourceExperienceRefs, requiredExperienceRefs: record.requiredExperienceRefs, sourceScope,
  ...(record.parentVersionId ? { parentVersionId: record.parentVersionId } : {}) };
 // Deliberately no case inputs, answers, traces, workspace paths or alleged passed flag.
 await writeFileAtomic(outputPath, `${JSON.stringify(pkg, null, 2)}\n`);
 return pkg;
}
/** Calling this is an explicit manual activation, with unverified external provenance. */
export async function bindMethodPackageV2(store: GenerationStore, packagePath: string, previous: { pointer: ActiveGenerationPointerV1; bundle: GenerationBundleV1 }, runId: string): Promise<{ strategy: StrategyRecordV1; bundle: GenerationBundleV1 }> {
 const pkg = await readMethodPackageV2(packagePath);
 const versionId = store.newId(`imported-${pkg.methodType}`);
 const strategy = await store.writeStrategy({ versionId, kind: pkg.methodType, artifact: pkg.artifact, origin: "external-manual-unverified", applicability: pkg.applicability, limitations: pkg.limitations, sourceExperienceRefs: pkg.sourceExperienceRefs, requiredExperienceRefs: pkg.requiredExperienceRefs, state: "manual-active" });
 const bundle = await store.writeBundle({ bundleId: store.newId("bundle"), parents: [previous.bundle.bundleId], executorVersionId: pkg.methodType === "executor" ? versionId : previous.bundle.executorVersionId, improverVersionId: pkg.methodType === "improver" ? versionId : previous.bundle.improverVersionId,
  knowledgeSnapshot: previous.bundle.knowledgeSnapshot, environmentVersion: previous.bundle.environmentVersion, modelConfig: previous.bundle.modelConfig, protocolVersion: previous.bundle.protocolVersion, allowedCapabilities: previous.bundle.allowedCapabilities, state: "manual-active" });
 await store.activate(bundle.bundleId, previous.pointer, "external-manual-unverified", runId);
 return { strategy, bundle };
}
