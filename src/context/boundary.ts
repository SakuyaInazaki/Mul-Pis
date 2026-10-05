/**
 * Controller-owned conversation boundaries. A role chooses a responsibility and
 * configured model; it does not decide whether history should be inherited.
 * Evidence paths below are references, not proof that a model read their bytes.
 */
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import type { ForkWorkspaceBindingV1, SessionCheckpoint, SessionHandle, SessionRef, SessionRunner, SessionSpec, ToolGrant } from "../runner/types.ts";
import { HarnessError, type InputRef, type Role, type StageRunRecord } from "../types.ts";

const receiptWrites = new WeakMap<StageRunRecord, Promise<void>>();

export interface EvidenceBindingV1 {
	version: 1;
	label: string;
	path: string;
	/** `linked` may change, `index` only points to material, `frozen-copy` preserves source bytes. */
	status: "linked" | "index" | "frozen-copy";
	/** Controller-assigned source version or checkpoint identity, not an invented content hash. */
	sourceVersion?: string;
}

export interface ContextBoundaryRecordV1 {
	version: 1;
	mode: "fresh" | "continue" | "fork";
	intent: "new-work" | "independent-judgment" | "causal-continuation" | "branch-exploration";
	reason: string;
	actorRole: Role;
	model: string;
	toolGrantKind: ToolGrant["kind"];
	/** If an audited runner wrapper narrows/replaces the requested grant, keep both facts. */
	requestedCapability?: { kind: ToolGrant["kind"]; root?: string; toolNames?: string[] };
	capability?: { kind: ToolGrant["kind"]; root?: string; toolNames?: string[]; writableFiles?: string[] };
	evidence: EvidenceBindingV1[];
	parent?: { sessionId: string; sessionFile?: string; leafId?: string };
	workspaceBinding?: { parentRoot: string; authorizedChildRootBase: string; childRoot: string; frozenEvidenceRoot: string; mappedFiles: number };
}

export type ContextBoundaryRequest =
	| { mode: "fresh"; intent: "new-work" | "independent-judgment"; reason: string; evidence: EvidenceBindingV1[]; spec: SessionSpec }
	| { mode: "continue"; intent: "causal-continuation"; reason: string; evidence: EvidenceBindingV1[]; parent: SessionRef; expectedToolGrantKind: ToolGrant["kind"] }
	| { mode: "fork"; intent: "branch-exploration"; reason: string; evidence: EvidenceBindingV1[]; checkpoint: SessionCheckpoint; spec: SessionSpec; workspaceBinding?: ForkWorkspaceBindingV1 };

export function linkedEvidence(inputs: readonly InputRef[]): EvidenceBindingV1[] {
	return inputs.map((input) => ({ version: 1, label: input.label, path: input.path, status: "linked" }));
}

function capabilityReceipt(grant: ToolGrant): NonNullable<ContextBoundaryRecordV1["capability"]> {
	if (grant.kind === "none") return { kind: "none" };
	if (grant.kind === "execution") return { kind: "execution", root: grant.root, toolNames: [...grant.tools].sort() };
	if (grant.kind === "read-dir") return { kind: "read-dir", root: grant.root, toolNames: [grant.toolName ?? "material_read", "material_list", ...(grant.extraTools ?? []).map((item) => item.name)].sort() };
	return { kind: "custom", toolNames: grant.tools.map((item) => item.name).sort() };
}

function validate(request: ContextBoundaryRequest): void {
	if (!request.reason.trim()) throw new HarnessError("context.boundary", "session boundary requires an explicit reason");
	const allowedIntent = request.mode === "fresh" ? ["new-work", "independent-judgment"] : request.mode === "continue" ? ["causal-continuation"] : ["branch-exploration"];
	if (!allowedIntent.includes(request.intent)) throw new HarnessError("context.boundary", "context intent conflicts with the requested history boundary");
	if (!Array.isArray(request.evidence) || request.evidence.some((item) => item.version !== 1 || !item.label.trim() || !item.path.trim() || !["linked", "index", "frozen-copy"].includes(item.status) || (item.status === "frozen-copy" && !item.sourceVersion?.trim()))) {
		throw new HarnessError("context.evidence", "session evidence bindings are invalid");
	}
	if (request.mode === "continue" && (!request.parent.id.trim() || !request.parent.file || !request.parent.specFile)) throw new HarnessError("context.parent", "continued session requires a persisted parent identity and spec");
	if (request.mode === "fork") {
		if (request.checkpoint.version !== 1 || !request.checkpoint.id || !request.checkpoint.snapshotFile || !request.checkpoint.leafId || !request.checkpoint.inputManifest || !request.checkpoint.runId) throw new HarnessError("context.fork", "fork requires a frozen checkpoint and leaf");
		if (!request.evidence.length) throw new HarnessError("context.fork", "fork requires at least one frozen original evidence binding");
		if (request.evidence.some((item) => item.status !== "frozen-copy")) throw new HarnessError("context.fork", "fork requires frozen original evidence, not linked mutable files or an index");
		if (request.spec.model !== request.checkpoint.model) throw new HarnessError("context.fork", "cross-model fork is not validated; use a fresh explicit evidence handoff");
		if ((request.spec.tools.kind === "execution" || request.spec.tools.kind === "custom") && !request.workspaceBinding) throw new HarnessError("context.fork", "writable fork requires controller-frozen workspace authority");
	}
}

export function boundaryRecord(request: ContextBoundaryRequest): ContextBoundaryRecordV1 {
	validate(request);
	const base = request.mode === "continue"
		? { actorRole: request.parent.role, model: request.parent.model, toolGrantKind: request.expectedToolGrantKind }
		: { actorRole: request.spec.role, model: request.spec.model, toolGrantKind: request.spec.tools.kind };
	return {
		version: 1, mode: request.mode, intent: request.intent, reason: request.reason, ...base,
		...(request.mode === "continue" ? {} : { capability: capabilityReceipt(request.spec.tools) }),
		evidence: request.evidence.map((item) => ({ ...item })),
		...(request.mode === "fresh" ? {} : request.mode === "continue"
			? { parent: { sessionId: request.parent.id, sessionFile: request.parent.file } }
			: { parent: { sessionId: request.checkpoint.sourceSessionId, sessionFile: request.checkpoint.sourceSessionFile, leafId: request.checkpoint.leafId } }),
		...(request.mode === "fork" && request.workspaceBinding ? { workspaceBinding: { parentRoot: request.workspaceBinding.parentRoot,
			authorizedChildRootBase: request.workspaceBinding.authorizedChildRootBase, childRoot: request.workspaceBinding.childRoot,
			frozenEvidenceRoot: request.workspaceBinding.frozenEvidenceRoot, mappedFiles: request.workspaceBinding.files.length } } : {}),
	};
}

async function verifyContinuedSpec(request: Extract<ContextBoundaryRequest, { mode: "continue" }>): Promise<SessionSpec> {
	let spec: SessionSpec;
	try { spec = JSON.parse(await readFile(request.parent.specFile!, "utf8")) as SessionSpec; }
	catch (error) { throw new HarnessError("context.parent", `cannot verify continued session spec: ${(error as Error).message}`); }
	if (spec.label !== request.parent.label || spec.role !== request.parent.role || spec.model !== request.parent.model || spec.tools?.kind !== request.expectedToolGrantKind) {
		throw new HarnessError("context.parent", "continued session role, model, or tool grant differs from persisted spec");
	}
	return spec;
}

async function actualSpec(handle: SessionHandle): Promise<SessionSpec> {
	if (!handle.ref.specFile) throw new HarnessError("context.persistence", "runner did not persist the effective session spec");
	let spec: SessionSpec;
	try { spec = JSON.parse(await readFile(handle.ref.specFile, "utf8")) as SessionSpec; }
	catch (error) { throw new HarnessError("context.persistence", `cannot inspect effective session spec: ${(error as Error).message}`); }
	if (!spec.tools || !["none", "read-dir", "custom", "execution"].includes(spec.tools.kind) || spec.role !== handle.ref.role || spec.model !== handle.ref.model) throw new HarnessError("context.persistence", "effective session spec differs from runner identity");
	return spec;
}

async function verifiedConfinedNarrowing(runner: SessionRunner, handle: SessionHandle, requested: Extract<ToolGrant, { kind: "execution" }>, effective: SessionSpec): Promise<NonNullable<ContextBoundaryRecordV1["capability"]>> {
	const requestedNames = new Set(requested.tools);
	if (!(requestedNames.has("read") || requestedNames.has("bash")) || !(requestedNames.has("write") || requestedNames.has("bash"))) throw new HarnessError("context.capability", "confined custom file tools would add read or write authority absent from the requested execution grant");
	const attested = await runner.attestConfinedGrant?.(handle);
	if (!attested || attested.version !== 1 || attested.kind !== "confined-campaign-files" ||
		JSON.stringify(attested) !== JSON.stringify(effective.toolAuthority) || !Array.isArray(attested.writableFiles) ||
		attested.writableFiles.length < 1 || attested.writableFiles.length > 16) throw new HarnessError("context.capability", "runner did not attest the effective custom grant from its confined tool factory");
	const canonicalRequested = await realpath(requested.root);
	const canonicalActual = await realpath(attested.root);
	if (canonicalRequested !== canonicalActual || canonicalActual !== attested.root || new Set(attested.writableFiles).size !== attested.writableFiles.length ||
		attested.writableFiles.some((item) => !item || path.isAbsolute(item) || item.split(/[\\/]/).some((part) => !part || part === "." || part === "..") || path.resolve(canonicalActual, item) === canonicalActual)) {
		throw new HarnessError("context.capability", "attested custom root or write allowlist differs from the controller-created execution workspace");
	}
	return { ...capabilityReceipt(effective.tools), root: canonicalActual, writableFiles: [...attested.writableFiles] };
}

/** Shared structural check; the Pi and fake backends separately verify history contents. */
async function verifyCommittedLineage(handle: SessionHandle, request: Extract<ContextBoundaryRequest, { mode: "fork" }>): Promise<void> {
	const file = handle.ref.file;
	const lineageFile = handle.ref.lineageFile;
	if (!file || !file.endsWith(".jsonl") || !lineageFile || path.resolve(lineageFile) !== file.replace(/\.jsonl$/, ".lineage.json")) throw new HarnessError("context.fork", "runner did not provide a child-linked lineage receipt");
	const info = await lstat(lineageFile);
	if (!info.isFile() || info.isSymbolicLink()) throw new HarnessError("context.fork", "fork lineage receipt is not a regular private file");
	let lineage: Record<string, any>;
	try { lineage = JSON.parse(await readFile(lineageFile, "utf8")) as Record<string, any>; }
	catch (error) { throw new HarnessError("context.fork", `fork lineage receipt cannot be read: ${(error as Error).message}`); }
	const checks = {
		state: lineage.version === 1 && lineage.state === "committed" && lineage.intent === "branch-exploration",
		checkpoint: JSON.stringify(lineage.checkpoint) === JSON.stringify(request.checkpoint),
		parent: lineage.parent?.sessionId === request.checkpoint.sourceSessionId && lineage.parent?.sessionFile === request.checkpoint.sourceSessionFile && lineage.parent?.leafId === request.checkpoint.leafId,
		child: lineage.child?.sessionId === handle.ref.id && lineage.child?.sessionFile === file,
		reason: lineage.reason === request.reason,
		evidence: JSON.stringify(lineage.evidenceBindings) === JSON.stringify(request.evidence),
		workspace: JSON.stringify(lineage.workspaceBinding) === JSON.stringify(request.workspaceBinding),
	};
	const invalid = Object.entries(checks).filter(([, valid]) => !valid).map(([name]) => name);
	if (invalid.length) throw new HarnessError("context.fork", `fork lineage receipt mismatches: ${invalid.join(",")}`);
}

/** Actual dispatcher: stage callers must use this rather than recording an unused policy. */
export async function openBoundedSession(runner: SessionRunner, record: StageRunRecord, request: ContextBoundaryRequest, persistReceipt: () => Promise<void>): Promise<SessionHandle> {
	if (typeof persistReceipt !== "function") throw new HarnessError("context.persistence", "session boundary requires a durable receipt writer before provider use");
	const boundary = boundaryRecord(request);
	let handle: SessionHandle;
	if (request.mode === "fresh") handle = await runner.create(request.spec);
	else if (request.mode === "continue") { const spec = await verifyContinuedSpec(request); boundary.capability = capabilityReceipt(spec.tools); handle = await runner.resume(request.parent); }
	else {
		const capabilities = runner.capabilities?.();
		if (!runner.fork || capabilities?.version !== 1 || !capabilities.persistedLineage || !capabilities.forkAtFrozenLeaf || capabilities.modelCompatibility !== "exact-model-only" || !capabilities.grantKinds.includes(request.spec.tools.kind)) throw new HarnessError("context.fork", "runner does not attest true frozen-leaf branching for this model and tool grant");
		handle = await runner.fork({ checkpoint: request.checkpoint, spec: request.spec, evidenceBindings: request.evidence, reason: request.reason,
			...(request.workspaceBinding ? { workspaceBinding: request.workspaceBinding } : {}) });
	}
	if (handle.ref.role !== boundary.actorRole || handle.ref.model !== boundary.model) {
		handle.dispose();
		throw new HarnessError("context.boundary", "runner returned a session with the wrong role or model");
	}
	if (request.mode === "fork" && (handle.ref.id === request.checkpoint.sourceSessionId || handle.ref.file === request.checkpoint.snapshotFile || handle.ref.file === request.checkpoint.sourceSessionFile)) {
		handle.dispose();
		throw new HarnessError("context.fork", "runner did not create an independent branch session");
	}
	if (request.mode === "fork") {
		try { await verifyCommittedLineage(handle, request); }
		catch (error) { handle.dispose(); throw error; }
	}
	if (request.mode === "continue" && (handle.ref.id !== request.parent.id || handle.ref.file !== request.parent.file || handle.ref.specFile !== request.parent.specFile)) {
		handle.dispose();
		throw new HarnessError("context.parent", "runner did not continue the exact persisted parent session");
	}
	let effective: SessionSpec;
	try { effective = await actualSpec(handle); }
	catch (error) { handle.dispose(); throw error; }
	const requestedCapability = boundary.capability;
	let actualCapability = capabilityReceipt(effective.tools);
	if (request.mode !== "continue" && requestedCapability && JSON.stringify(requestedCapability) !== JSON.stringify(actualCapability)) {
		if (!(requestedCapability.kind === "execution" && actualCapability.kind === "custom" && request.spec.tools.kind === "execution")) {
			handle.dispose();
			throw new HarnessError("context.capability", "runner changed the requested tool authority without a supported narrowing route");
		}
		try { actualCapability = await verifiedConfinedNarrowing(runner, handle, request.spec.tools, effective); }
		catch (error) { handle.dispose(); throw error; }
		boundary.requestedCapability = requestedCapability;
	}
	boundary.toolGrantKind = actualCapability.kind;
	boundary.capability = actualCapability;
	record.sessions.push({ label: handle.ref.label, role: handle.ref.role, id: handle.ref.id, file: handle.ref.file, model: handle.ref.model, boundary });
	handle.setRunContext?.({ stage: record.stage, runId: record.runId });
	const previous = receiptWrites.get(record) ?? Promise.resolve();
	const write = previous.catch(() => undefined).then(persistReceipt);
	receiptWrites.set(record, write);
	try { await write; }
	catch (error) { handle.dispose(); throw new HarnessError("context.persistence", `session boundary receipt was not durable before prompt: ${(error as Error).message}`); }
	return handle;
}
