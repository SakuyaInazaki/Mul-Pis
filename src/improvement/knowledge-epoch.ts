/** An explicit, between-campaign handoff from a completed M04 merge to a new K binding. */
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { createExperienceProvider, isKnowledgeRef, verifyRequiredKnowledge } from "../knowledge/experience-index.ts";
import { createFileKnowledgeStore } from "../knowledge/store.ts";
import type { KnowledgeStore } from "../knowledge/types.ts";
import { HarnessError } from "../types.ts";
import { Workspace } from "../workspace.ts";
import { GenerationStore, isM07WorkflowStrategy, type ActiveGenerationPointerV1, type GenerationBundleV1, type StrategyRecordV1 } from "./generation.ts";

export interface KnowledgeEpochAdvanceArgs {
	workspaceRoot: string;
	generationStore: GenerationStore;
	m04RunId: string;
	expectedActiveBundleId: string;
	registeredExperienceStores?: ReadonlyMap<string, KnowledgeStore>;
}

export interface KnowledgeEpochAdvanceResult {
	bundle: GenerationBundleV1;
	pointer: ActiveGenerationPointerV1;
	fromSnapshot?: string;
	toSnapshot: string;
	m04RunId: string;
}

const runIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

async function assertNoRunningCampaign(store: GenerationStore): Promise<void> {
	const runsDir = path.join(store.root, "runs");
	let names: string[];
	try { names = await readdir(runsDir); }
	catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
	for (const name of names) {
		if (!runIdPattern.test(name)) continue;
		let state: unknown;
		try { state = JSON.parse(await readFile(path.join(runsDir, name, "run.json"), "utf8")); }
		catch { throw new HarnessError("improvement.knowledge-epoch", `campaign ${name} has no readable final state`); }
		if (!state || typeof state !== "object" || !Object.hasOwn(state, "status")) throw new HarnessError("improvement.knowledge-epoch", `campaign ${name} has invalid state`);
		if ((state as { status: unknown }).status === "running") throw new HarnessError("improvement.knowledge-epoch", `campaign ${name} is still active or needs explicit recovery`);
	}
}

async function verifyMethodRequirements(workspaceRoot: string, records: StrategyRecordV1[], snapshotId: string, registeredStores: ReadonlyMap<string, KnowledgeStore>): Promise<void> {
	const knowledge = createFileKnowledgeStore(new Workspace(workspaceRoot).knowledgeDir);
	await knowledge.init();
	const provider = createExperienceProvider(knowledge, registeredStores);
	const necessary = new Map<string, StrategyRecordV1["requiredKnowledgeRefs"][number]>();
	for (const record of records) {
		for (const targetKind of ["executor", "improver"] as const) {
			const requestedRefs = record.requiredExperienceRefs.filter((item) => item.targetKind === targetKind).map((item) => item.ref);
			if (!requestedRefs.length) continue;
			const artifact = record.artifact;
			const workflow = targetKind === "executor" && isM07WorkflowStrategy(artifact);
			const selection = await provider.select({ targetKind, applicability: workflow
				? { stage: "M07", tags: [artifact.slot] }
				: { stage: "method-research", tags: ["cpu-response-identification"] }, requestedRefs, expectedSnapshotId: snapshotId, maxRecords: 100, maxChars: 100_000 });
			if (selection.status !== "ready" || selection.selected.length !== requestedRefs.length) throw new HarnessError("improvement.knowledge-epoch", "inherited method experience is unavailable or inapplicable at the new knowledge snapshot");
		}
		for (const ref of record.requiredKnowledgeRefs) necessary.set(`${ref.storeId}/${ref.recordId}@${ref.version}`, ref);
	}
	await verifyRequiredKnowledge(workspaceRoot, [...necessary.values()], snapshotId, registeredStores);
}

/** Caller holds the ResearchService mutation lock. No old bundle or run is rewritten. */
export async function advanceKnowledgeEpochInLock(args: KnowledgeEpochAdvanceArgs): Promise<KnowledgeEpochAdvanceResult> {
	if (!runIdPattern.test(args.m04RunId) || !runIdPattern.test(args.expectedActiveBundleId)) throw new HarnessError("improvement.knowledge-epoch", "invalid run or bundle id");
	await assertNoRunningCampaign(args.generationStore);
	const ws = new Workspace(args.workspaceRoot);
	const active = await args.generationStore.active();
	if (!active || active.bundle.bundleId !== args.expectedActiveBundleId) throw new HarnessError("improvement.stale-baseline", "active generation changed before knowledge epoch advance");
	const m04 = await ws.readRun("M04", args.m04RunId);
	if (m04.stage !== "M04" || m04.runId !== args.m04RunId || m04.status !== "completed" || m04.failures.length) throw new HarnessError("improvement.knowledge-epoch", "M04 run is not a clean completed decision");
	const mergeOutput = m04.outputs.find((output) => output.label === "合入结果");
	const expectedMergePath = path.join(ws.runDir("M04", args.m04RunId), "merge.json");
	if (!mergeOutput || path.resolve(mergeOutput.path) !== expectedMergePath) throw new HarnessError("improvement.knowledge-epoch", "M04 run has no verified merge output");
	let merged: { proposalId?: unknown; snapshot?: { id?: unknown } };
	try { merged = JSON.parse(await readFile(expectedMergePath, "utf8")) as typeof merged; }
	catch { throw new HarnessError("improvement.knowledge-epoch", "M04 merge output is unreadable"); }
	const snapshotId = merged.snapshot?.id;
	if (typeof snapshotId !== "string" || !/^G\d{3,}$/.test(snapshotId) || typeof merged.proposalId !== "string") throw new HarnessError("improvement.knowledge-epoch", "M04 merge receipt is invalid");
	const knowledge = createFileKnowledgeStore(ws.knowledgeDir);
	await knowledge.init();
	const current = await knowledge.current();
	if (!current || current.id !== snapshotId || !current.proposals.includes(merged.proposalId)) throw new HarnessError("improvement.knowledge-epoch", "M04 merge is not the current published knowledge snapshot");
	if (active.bundle.knowledgeSnapshot === snapshotId) throw new HarnessError("improvement.knowledge-epoch", "knowledge epoch is already bound to this snapshot");
	const [executor, improver] = await Promise.all([args.generationStore.readStrategy(active.bundle.executorVersionId), args.generationStore.readStrategy(active.bundle.improverVersionId)]);
	await verifyMethodRequirements(ws.root, [executor, improver], snapshotId, args.registeredExperienceStores ?? new Map());
	const stillActive = await args.generationStore.active();
	if (!stillActive || stillActive.pointer.runId !== active.pointer.runId || stillActive.bundle.bundleId !== active.bundle.bundleId || (await knowledge.current())?.id !== snapshotId) throw new HarnessError("improvement.stale-baseline", "knowledge or active method changed during epoch verification");
	const bundle = await args.generationStore.writeBundle({ bundleId: args.generationStore.newId("bundle"), parents: [active.bundle.bundleId], executorVersionId: active.bundle.executorVersionId, improverVersionId: active.bundle.improverVersionId, knowledgeSnapshot: snapshotId, environmentVersion: active.bundle.environmentVersion, modelConfig: active.bundle.modelConfig, protocolVersion: active.bundle.protocolVersion, allowedCapabilities: active.bundle.allowedCapabilities, state: active.bundle.state });
	const pointer = await args.generationStore.activate(bundle.bundleId, active.pointer, "knowledge-epoch-advance", `knowledge-epoch-${args.m04RunId}`);
	return { bundle, pointer, fromSnapshot: active.bundle.knowledgeSnapshot, toSnapshot: snapshotId, m04RunId: args.m04RunId };
}

export interface MethodDependencyTransitionArgs {
	workspaceRoot: string;
	generationStore: GenerationStore;
	m04RunId: string;
	expectedActiveBundleId: string;
	methodVersionId: string;
	decisionRef: import("../knowledge/types.ts").KnowledgeRef;
	registeredExperienceStores?: ReadonlyMap<string, KnowledgeStore>;
}

/** Only structured necessary scientific premises are discharged; historic experience obligations remain. */
export async function transitionMethodKnowledgeDependenciesInLock(args: MethodDependencyTransitionArgs): Promise<{ bundle: GenerationBundleV1; pointer: ActiveGenerationPointerV1; newMethodVersionId: string }> {
	if (!runIdPattern.test(args.m04RunId) || !runIdPattern.test(args.expectedActiveBundleId) || !runIdPattern.test(args.methodVersionId) || !isKnowledgeRef(args.decisionRef)) throw new HarnessError("improvement.dependency-transition", "invalid transition identity");
	await assertNoRunningCampaign(args.generationStore);
	const ws = new Workspace(args.workspaceRoot);
	const active = await args.generationStore.active();
	if (!active || active.bundle.bundleId !== args.expectedActiveBundleId || ![active.bundle.executorVersionId, active.bundle.improverVersionId].includes(args.methodVersionId)) throw new HarnessError("improvement.stale-baseline", "target method is not active in the expected bundle");
	const knowledge = createFileKnowledgeStore(ws.knowledgeDir);
	await knowledge.init();
	if (args.decisionRef.storeId !== await knowledge.storeId()) throw new HarnessError("improvement.dependency-transition", "decision must be published by the local M04 store");
	const m04 = await ws.readRun("M04", args.m04RunId);
	const mergeOutput = m04.outputs.find((item) => item.label === "合入结果");
	const mergePath = path.join(ws.runDir("M04", args.m04RunId), "merge.json");
	if (m04.stage !== "M04" || m04.runId !== args.m04RunId || m04.status !== "completed" || m04.failures.length || !mergeOutput || path.resolve(mergeOutput.path) !== mergePath) throw new HarnessError("improvement.dependency-transition", "decision source is not a clean completed M04 merge");
	let merge: { proposalId?: unknown; snapshot?: { id?: unknown } };
	try { merge = JSON.parse(await readFile(mergePath, "utf8")) as typeof merge; }
	catch { throw new HarnessError("improvement.dependency-transition", "M04 merge receipt is unreadable"); }
	if (typeof merge.proposalId !== "string" || typeof merge.snapshot?.id !== "string" || !/^G\d{3,}$/.test(merge.snapshot.id)) throw new HarnessError("improvement.dependency-transition", "M04 merge receipt is invalid");
	const current = await knowledge.current();
	let decisionSnapshot: { id?: unknown; proposals?: unknown };
	try { decisionSnapshot = JSON.parse(await readFile(path.join(ws.knowledgeDir, "snapshots", `${merge.snapshot.id}.json`), "utf8")) as typeof decisionSnapshot; }
	catch { throw new HarnessError("improvement.dependency-transition", "M04 decision snapshot is unavailable"); }
	if (!current || current.id !== merge.snapshot.id || decisionSnapshot.id !== merge.snapshot.id || !Array.isArray(decisionSnapshot.proposals) || !decisionSnapshot.proposals.includes(merge.proposalId)) throw new HarnessError("improvement.dependency-transition", "M04 decision is not the current published knowledge snapshot");
	const decision = await knowledge.get(args.decisionRef.recordId, args.decisionRef.version);
	if (!decision || decision.type !== "D" || decision.source.stage !== "M04" || decision.source.runId !== args.m04RunId || (await knowledge.availability(decision.id, decision.version)).availability !== "usable_conditionally") throw new HarnessError("improvement.dependency-transition", "decision is not an adopted usable M04 D record");
	const data = decision.fields.methodDependencyTransition as Record<string, unknown> | undefined;
	if (!data || data.version !== 1 || data.methodVersionId !== args.methodVersionId || !Array.isArray(data.remove) || !Array.isArray(data.add) || !Array.isArray(data.evidenceRefs) || !data.evidenceRefs.length || !isKnowledgeRef(data.revalidationRef) || ![...data.remove, ...data.add, ...data.evidenceRefs].every(isKnowledgeRef) || data.remove.length + data.add.length > 100 || data.evidenceRefs.length > 20) throw new HarnessError("improvement.dependency-transition", "M04 D record lacks exact bounded method/ref/evidence/revalidation decision");
	const removed = data.remove as import("../knowledge/types.ts").KnowledgeRef[];
	const added = data.add as import("../knowledge/types.ts").KnowledgeRef[];
	const evidence = data.evidenceRefs as import("../knowledge/types.ts").KnowledgeRef[];
	const revalidation = data.revalidationRef as import("../knowledge/types.ts").KnowledgeRef;
	const refKey = (ref: import("../knowledge/types.ts").KnowledgeRef) => `${ref.storeId}/${ref.recordId}@${ref.version}`;
	if (!removed.length || new Set([...removed, ...added].map(refKey)).size !== removed.length + added.length || new Set(evidence.map(refKey)).size !== evidence.length) throw new HarnessError("improvement.dependency-transition", "decision refs contain no removal or duplicate identities");
	const old = await args.generationStore.readStrategy(args.methodVersionId);
	const oldRefs = new Map(old.requiredKnowledgeRefs.map((ref) => [refKey(ref), ref]));
	if (removed.some((ref) => !oldRefs.has(refKey(ref))) || added.some((ref) => oldRefs.has(refKey(ref)))) throw new HarnessError("improvement.dependency-transition", "M04 decision does not exactly change active necessary refs");
	const stores = new Map(args.registeredExperienceStores);
	stores.set(await knowledge.storeId(), knowledge);
	for (const ref of [...evidence, revalidation]) {
		const source = stores.get(ref.storeId);
		const record = source && await source.storeId() === ref.storeId ? await source.get(ref.recordId, ref.version) : undefined;
		if (!record || record.type !== "E" || (await source!.availability(ref.recordId, ref.version)).availability !== "usable_conditionally") throw new HarnessError("improvement.dependency-transition", `evidence or revalidation record is unavailable: ${refKey(ref)}`);
		if (refKey(ref) === refKey(revalidation)) {
			const check = record.fields.methodRevalidation as Record<string, unknown> | undefined;
			if (!check || check.version !== 1 || check.methodVersionId !== args.methodVersionId || check.result !== "passed") throw new HarnessError("improvement.dependency-transition", "revalidation E does not attest this exact method version");
		}
	}
	for (const ref of removed) oldRefs.delete(refKey(ref));
	for (const ref of added) oldRefs.set(refKey(ref), ref);
	const nextRefs = [...oldRefs.values()];
	await verifyRequiredKnowledge(ws.root, nextRefs, current.id, args.registeredExperienceStores);
	const [h, i] = await Promise.all([args.generationStore.readStrategy(active.bundle.executorVersionId), args.generationStore.readStrategy(active.bundle.improverVersionId)]);
	await verifyMethodRequirements(ws.root, [h.versionId === old.versionId ? { ...h, requiredKnowledgeRefs: nextRefs } : h, i.versionId === old.versionId ? { ...i, requiredKnowledgeRefs: nextRefs } : i], current.id, args.registeredExperienceStores ?? new Map());
	if ((await knowledge.current())?.id !== current.id || (await args.generationStore.active())?.pointer.runId !== active.pointer.runId) throw new HarnessError("improvement.stale-baseline", "knowledge or active method changed during transition");
	const newMethodVersionId = args.generationStore.newId(old.kind === "executor" ? "H-dependency" : "I-dependency");
	await args.generationStore.writeStrategy({ versionId: newMethodVersionId, kind: old.kind, artifact: old.artifact, parentVersionId: old.versionId, origin: old.origin, applicability: old.applicability, limitations: old.limitations, sourceExperienceRefs: old.sourceExperienceRefs, requiredExperienceRefs: old.requiredExperienceRefs, requiredKnowledgeRefs: nextRefs,
		dependencyTransition: { version: 1, decisionRef: args.decisionRef, removedRefs: removed, addedRefs: added, evidenceRefs: evidence, revalidationRef: revalidation, at: new Date().toISOString() }, state: "manual-active" });
	const bundle = await args.generationStore.writeBundle({ bundleId: args.generationStore.newId("bundle"), parents: [active.bundle.bundleId], executorVersionId: old.kind === "executor" ? newMethodVersionId : active.bundle.executorVersionId, improverVersionId: old.kind === "improver" ? newMethodVersionId : active.bundle.improverVersionId, knowledgeSnapshot: current.id, environmentVersion: active.bundle.environmentVersion, modelConfig: active.bundle.modelConfig, protocolVersion: active.bundle.protocolVersion, allowedCapabilities: active.bundle.allowedCapabilities, state: "manual-active" });
	const pointer = await args.generationStore.activate(bundle.bundleId, active.pointer, "method-dependency-transition", `dependency-transition-${args.m04RunId}`);
	return { bundle, pointer, newMethodVersionId };
}
