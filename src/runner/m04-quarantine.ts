/** A missing portable M04 transaction leaves the old proposal outcome unknown.
 * This host-only record permits fresh independent work; it is never an import,
 * a no-merge finding, a fee adjustment, or permission to resume an old session.
 */
import { createHash } from "node:crypto";
import path from "node:path";
import { authenticatedHostEffectEvidence, authenticatedPriorCarryBindsAncestor,
	authenticatedPriorCarryBindsBundle, isAuthenticatedPriorCarryProof,
	type AuthenticatedHostEffectEvidence, type AuthenticatedPriorCarryProof,
	type PrivateContinuationBundle } from "./ledger-continuation.ts";

export const M04_TRANSACTION_QUARANTINE_FILE = "m04-transaction-quarantine.json";
type Source = AuthenticatedPriorCarryProof["source"];
export type M04TransactionQuarantineEntryV1 = Readonly<{
	source: Readonly<Source>; envelopeSha256: string; contractId: string;
	goalRunId: string; taskId: string; m04RunId: string;
	state: "unknown-unreconciled"; route: "fresh-work-only";
	proposalSubmitted: boolean; selectedTupleSha256: string;
	inheritedOperationRefs: string[];
}>;
export type M04TransactionQuarantineV1 = Readonly<{
	version: 1; kind: "unresolved-historical-m04-quarantine";
	entries: M04TransactionQuarantineEntryV1[];
}>;
const freshOnlyQuarantines = new WeakMap<object, string>();
export type FreshM04QuarantineBoundary = Readonly<{
	campaignRoot: string; workspaceRoot: string; storeRoot: string;
	storeEmpty: true; sessionCensusEmpty: true;
	sessionMode: "no-prior-session-resume";
	grantProfile: "private-confined-read-dir";
	externalWriteTools: false; sharedStore: false; selectedRevalidated: true;
}>;

function reject(message: string): never { throw new Error(`M04 fresh-work quarantine: ${message}`); }
function object(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function keys(value: Record<string, unknown>, names: readonly string[]): boolean {
	return Object.keys(value).sort().join("|") === [...names].sort().join("|");
}
function id(value: unknown): value is string {
	return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value);
}
function hex(value: unknown, count: number): value is string {
	return typeof value === "string" && new RegExp(`^[0-9a-f]{${count}}$`).test(value);
}
function sha(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function json(value: unknown): Record<string, unknown> {
	if (typeof value !== "string") reject("required authenticated control file is missing");
	let parsed: unknown;
	try { parsed = JSON.parse(value); } catch { reject("authenticated control JSON is invalid"); }
	if (!object(parsed)) reject("authenticated control JSON is not an object");
	return parsed;
}
function sameSet(a: readonly string[], b: readonly string[]): boolean {
	return a.length === b.length && new Set(a).size === a.length &&
		new Set(b).size === b.length && a.every(value => b.includes(value));
}
function selection(bundle: PrivateContinuationBundle, checkpoint: Record<string, unknown>): string {
	const selected = checkpoint.selectedArtifacts;
	if (!Array.isArray(selected) || !selected.length || !selected.every(id) ||
		new Set(selected).size !== selected.length ||
		selected.some(name => typeof bundle[name as keyof PrivateContinuationBundle] !== "string"))
		reject("selected tuple is missing or ambiguous");
	return sha(JSON.stringify([...selected].sort().map(name => {
		const body = bundle[name as keyof PrivateContinuationBundle]!;
		return { name, sha256: sha(body), bytes: Buffer.byteLength(body, "utf8") };
	})));
}
function inheritedRefs(checkpoint: Record<string, unknown>): string[] {
	if (!Array.isArray(checkpoint.boundedRuns) || !object(checkpoint.continuation) ||
		!Array.isArray(checkpoint.continuation.unresolvedOperationIds))
		reject("historical unresolved-operation census is missing");
	const refs: string[] = [];
	for (const run of checkpoint.boundedRuns) {
		if (!object(run) || !id(run.runId) ||
			(run.unresolvedOperationIds !== undefined && !Array.isArray(run.unresolvedOperationIds)))
			reject("historical bounded-run operation census is invalid");
		for (const operationId of (run.unresolvedOperationIds ?? []) as unknown[]) {
			if (typeof operationId !== "string" || !/^O\d{3,}$/.test(operationId))
				reject("historical operation identity is invalid");
			refs.push(`${run.runId}/${operationId}`);
		}
	}
	const continuation = checkpoint.continuation.unresolvedOperationIds;
	if (!Array.isArray(continuation) || !continuation.every(value => typeof value === "string") ||
		!sameSet(refs, continuation)) reject("historical unresolved operation references changed");
	return refs;
}
type Target = { contractId: string; goalRunId: string; taskId: string; m04RunId: string;
	proposalSubmitted: boolean; selectedTupleSha256: string; inheritedOperationRefs: string[] };
function latestTarget(bundle: PrivateContinuationBundle): Target | undefined {
	const checkpoint = json(bundle["objective-checkpoint.json"]);
	if (checkpoint.version !== 1 || checkpoint.kind !== "original-objective-progress" ||
		checkpoint.objectiveOutcome !== "incomplete" || !object(checkpoint.contract) ||
		!id(checkpoint.contract.id) || !Array.isArray(checkpoint.boundedRuns))
		reject("original objective checkpoint is invalid");
	const latest = checkpoint.boundedRuns.at(-1);
	if (!object(latest) || latest.outcome !== "fulfilled" || !id(latest.runId) ||
		!/^T\d{3,}$/.test(String(latest.selectedTaskId))) return undefined;
	const history = json(bundle["research-history.json"]);
	if (history.version !== 1 || history.kind !== "untrusted-version-bound-research-history" ||
		!Array.isArray(history.entries)) reject("research history is invalid");
	const matches = history.entries.filter(row => object(row) &&
		row.goalRunId === latest.runId && row.taskId === latest.selectedTaskId);
	if (matches.length !== 1 || !object(matches[0]) ||
		matches[0].originalContractId !== checkpoint.contract.id || !object(matches[0].files))
		reject("latest fulfilled goal has no unique contract-bound archive");
	const files = matches[0].files;
	const archive = json(files["workflow-archive.json"]);
	if (archive.version !== 1 || archive.kind !== "m07-private-candidate-archive" ||
		archive.goalRunId !== latest.runId || archive.taskId !== latest.selectedTaskId ||
		archive.goalOutcome !== "fulfilled" || archive.taskStatus !== "accepted" ||
		!object(archive.controllerEvidence) || archive.controllerEvidence.reviewStatus !== "accepted" ||
		!object(archive.m04)) reject("latest archive contradicts accepted fulfilled goal");
	if (archive.m04.state !== "failed") return undefined;
	if (archive.m04.transaction !== undefined || files["m04-transaction.json"] !== undefined) {
		if (!object(archive.m04.transaction) ||
			files["m04-transaction.json"] === undefined)
			reject("portable M04 transaction declaration and payload disagree");
		return undefined;
	}
	if (typeof archive.m04.proposalSubmitted !== "boolean" ||
		archive.m04.snapshotCreated !== false || !id(archive.m04.runId) ||
		bundle["m04-transaction.json"] !== undefined &&
			json(bundle["m04-transaction.json"]).m04RunId === archive.m04.runId)
		reject("failed M04 lacks a safe missing-transaction boundary");
	if (!object(archive.m04.knowledgeExport) || archive.m04.knowledgeExport.state !== "none" ||
		files["m04-adopted-knowledge.json"] !== undefined ||
		!Array.isArray(archive.m04.adoptedExperienceRefs) ||
		archive.m04.adoptedExperienceRefs.length !== 0 || archive.m04.snapshotId !== undefined)
		reject("failed M04 may have exported or adopted knowledge");
	if (latest.unresolvedOperationIds !== undefined &&
		(!Array.isArray(latest.unresolvedOperationIds) || latest.unresolvedOperationIds.length !== 0))
		reject("latest goal has unresolved execution operations");
	const selectedTupleSha256 = selection(bundle, checkpoint);
	const reservations = json(bundle["independent-restart-quarantine.json"]);
	if (reservations.version !== 1 || reservations.kind !== "host-independent-restart-reservations" ||
		!Array.isArray(reservations.entries) || !reservations.entries.length ||
		!object(reservations.entries.at(-1)) ||
		!object(reservations.entries.at(-1).receipt) ||
		!object(reservations.entries.at(-1).receipt.prior) ||
		reservations.entries.at(-1).receipt.prior.selectedTupleSha256 !== selectedTupleSha256)
		reject("failed M04 changed the previously selected tuple");
	const selectedArchive = json(bundle["workflow-archive.json"]);
	if (selectedArchive.goalRunId === latest.runId ||
		selectedArchive.taskId === latest.selectedTaskId && selectedArchive.goalRunId === latest.runId)
		reject("disputed latest goal was installed as the selected tuple");
	return { contractId: checkpoint.contract.id as string, goalRunId: latest.runId as string,
		taskId: latest.selectedTaskId as string, m04RunId: archive.m04.runId as string,
		proposalSubmitted: archive.m04.proposalSubmitted as boolean,
		selectedTupleSha256, inheritedOperationRefs: inheritedRefs(checkpoint) };
}
function fresh(boundary: FreshM04QuarantineBoundary): void {
	if (!object(boundary) || !keys(boundary, ["campaignRoot", "workspaceRoot", "storeRoot",
		"storeEmpty", "sessionCensusEmpty", "sessionMode", "grantProfile",
		"externalWriteTools", "sharedStore", "selectedRevalidated"]) ||
		boundary.storeEmpty !== true || boundary.sessionCensusEmpty !== true ||
		boundary.sessionMode !== "no-prior-session-resume" ||
		boundary.grantProfile !== "private-confined-read-dir" ||
		boundary.externalWriteTools !== false || boundary.sharedStore !== false ||
		boundary.selectedRevalidated !== true ||
		typeof boundary.campaignRoot !== "string" ||
		path.basename(boundary.campaignRoot).startsWith("mulpis-private-campaign-") !== true ||
		boundary.campaignRoot !== path.resolve(boundary.campaignRoot) ||
		boundary.workspaceRoot !== path.join(boundary.campaignRoot, "workspace") ||
		boundary.storeRoot !== path.join(boundary.workspaceRoot, ".agent", "knowledge"))
		reject("current run lacks a fresh isolated workspace, store, and safe grant boundary");
}
function validEntry(value: unknown): value is M04TransactionQuarantineEntryV1 {
	if (!object(value) || !keys(value, ["source", "envelopeSha256", "contractId", "goalRunId",
		"taskId", "m04RunId", "state", "route", "proposalSubmitted", "selectedTupleSha256",
		"inheritedOperationRefs"]) || !object(value.source) ||
		!keys(value.source, ["runId", "runAttempt", "runNumber", "commit"]) ||
		!id(value.source.runId) || !Number.isSafeInteger(value.source.runAttempt) ||
		Number(value.source.runAttempt) < 1 || !Number.isSafeInteger(value.source.runNumber) ||
		Number(value.source.runNumber) < 1 || !hex(value.source.commit, 40) ||
		!hex(value.envelopeSha256, 64) || !id(value.contractId) || !id(value.goalRunId) ||
		!/^T\d{3,}$/.test(String(value.taskId)) || !id(value.m04RunId) ||
		value.state !== "unknown-unreconciled" || value.route !== "fresh-work-only" ||
		typeof value.proposalSubmitted !== "boolean" || !hex(value.selectedTupleSha256, 64) ||
		!Array.isArray(value.inheritedOperationRefs) ||
		value.inheritedOperationRefs.some(ref => typeof ref !== "string" ||
			!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}\/O\d{3,}$/.test(ref))) return false;
	return new Set(value.inheritedOperationRefs).size === value.inheritedOperationRefs.length;
}
function parseQuarantine(raw: unknown): M04TransactionQuarantineV1 {
	const parsed = json(raw);
	if (!keys(parsed, ["version", "kind", "entries"]) || parsed.version !== 1 ||
		parsed.kind !== "unresolved-historical-m04-quarantine" ||
		!Array.isArray(parsed.entries) || parsed.entries.some(entry => !validEntry(entry)))
		reject("quarantine receipt is malformed");
	return parsed as M04TransactionQuarantineV1;
}
function authenticated(proof: unknown, bundle: unknown): asserts proof is AuthenticatedPriorCarryProof {
	if (!isAuthenticatedPriorCarryProof(proof) || proof.version !== 2 ||
		!authenticatedPriorCarryBindsBundle(proof, bundle))
		reject("live authenticated carry and exact private bundle are required");
}
/** Validate a serialized receipt, including exact ancestry and retained unknowns.
 * Historical M04 effects remain unknown even when this returns successfully. */
export function validateM04TransactionQuarantine(input: { proof: unknown;
	bundle: PrivateContinuationBundle }): M04TransactionQuarantineV1 | undefined {
	authenticated(input.proof, input.bundle);
	const raw = input.bundle[M04_TRANSACTION_QUARANTINE_FILE as keyof PrivateContinuationBundle];
	if (raw === undefined) return undefined;
	const quarantine = parseQuarantine(raw);
	const checkpoint = json(input.bundle["objective-checkpoint.json"]);
	const currentRefs = inheritedRefs(checkpoint);
	const seen = new Set<string>();
	for (const entry of quarantine.entries) {
		const key = `${entry.source.runId}/${entry.goalRunId}/${entry.taskId}/${entry.m04RunId}`;
		if (seen.has(key) || !authenticatedPriorCarryBindsAncestor(input.proof, entry.source,
			entry.envelopeSha256) || !object(checkpoint.contract) ||
			checkpoint.contract.id !== entry.contractId ||
			entry.inheritedOperationRefs.some(ref => !currentRefs.includes(ref)))
			reject("quarantine receipt does not bind retained historical effects");
		seen.add(key);
		const target = targetByIdentity(input.bundle, entry.goalRunId, entry.taskId);
		if (!target || target.contractId !== entry.contractId ||
			target.m04RunId !== entry.m04RunId || target.proposalSubmitted !== entry.proposalSubmitted)
			reject("quarantine target archive is no longer exact");
	}
	return quarantine;
}
function targetByIdentity(bundle: PrivateContinuationBundle, goalRunId: string, taskId: string):
	{ contractId: string; m04RunId: string; proposalSubmitted: boolean } | undefined {
	const history = json(bundle["research-history.json"]);
	if (!Array.isArray(history.entries)) reject("historical archive is missing");
	const matches = history.entries.filter(row => object(row) && row.goalRunId === goalRunId && row.taskId === taskId);
	if (matches.length !== 1 || !object(matches[0]) || !object(matches[0].files)) return undefined;
	const archive = json(matches[0].files["workflow-archive.json"]);
	const m04 = archive.m04;
	if (!object(m04) || archive.goalRunId !== goalRunId || archive.taskId !== taskId ||
		archive.goalOutcome !== "fulfilled" || archive.taskStatus !== "accepted" ||
		m04.state !== "failed" || m04.snapshotCreated !== false ||
		typeof m04.proposalSubmitted !== "boolean" || !id(m04.runId) ||
		m04.transaction !== undefined || matches[0].files["m04-transaction.json"] !== undefined)
		return undefined;
	return { contractId: String(matches[0].originalContractId), m04RunId: m04.runId,
		proposalSubmitted: m04.proposalSubmitted };
}
/** Caller must obtain the descriptor from live host checks before the first
 * current-run model call. The descriptor is a guard, not old-effect authority. */
export function buildUnresolvedHistoricalM04Quarantine(input: { proof: unknown;
	bundle: PrivateContinuationBundle; freshBoundary: FreshM04QuarantineBoundary;
	hostEffect?: AuthenticatedHostEffectEvidence }): M04TransactionQuarantineV1 | undefined {
	authenticated(input.proof, input.bundle);
	const effect = authenticatedHostEffectEvidence(input.proof, input.bundle);
	const prior = validateM04TransactionQuarantine({ proof: input.proof, bundle: input.bundle });
	if (input.hostEffect && input.hostEffect !== effect)
		reject("caller-supplied host effect evidence is not live authenticated");
	return buildFromAuthenticatedFacts(input.proof, input.bundle, input.freshBoundary, effect, prior);
}
function buildFromAuthenticatedFacts(proof: AuthenticatedPriorCarryProof,
	bundle: PrivateContinuationBundle, boundary: FreshM04QuarantineBoundary,
	effect: AuthenticatedHostEffectEvidence | undefined,
	prior: M04TransactionQuarantineV1 | undefined): M04TransactionQuarantineV1 | undefined {
	const target = latestTarget(bundle);
	if (!target) return undefined;
	fresh(boundary);
	const effectsCensused = Boolean(effect) &&
		effect!.receipt.source.runId === proof.source.runId &&
		effect!.receipt.source.runAttempt === proof.source.runAttempt &&
		effect!.receipt.source.commit === proof.source.commit &&
		effect!.requestAudit.requests.every(row => row.responseReceived === true &&
			row.status !== "in-flight" && typeof row.sessionId === "string" &&
			effect!.receipt.sessions.some(session => session.sessionId === row.sessionId)) &&
		effect!.receipt.goals.every(goal => goal.operations.every(operation =>
			operation.status === "response-received")) &&
		effect!.receipt.sessions.every(session => session.kind === "none" ||
			session.kind === "read-dir" || session.kind === "confined-execution" &&
			effect!.receipt.goals.some(goal => goal.tasks.some(task => task.mode === "execute" &&
				task.sessionId === session.sessionId && task.taskId === session.taskId &&
				goal.runId === session.goalRunId)));
	// A complete current host census may corroborate the archived target. When
	// an emergency carry lacks that census, the authenticated archive can only
	// support UNKNOWN fresh work. It never authorizes import or old-effect review.
	if (effect && !effectsCensused)
		reject("latest provider, controller, or session census is incomplete or contradicts the archive");
	const existing = prior?.entries.find(row => row.goalRunId === target.goalRunId &&
		row.taskId === target.taskId && row.m04RunId === target.m04RunId);
	if (existing && existing.contractId === target.contractId &&
		existing.proposalSubmitted === target.proposalSubmitted &&
		existing.selectedTupleSha256 === target.selectedTupleSha256 &&
		sameSet(existing.inheritedOperationRefs, target.inheritedOperationRefs)) {
		freshOnlyQuarantines.set(prior!, JSON.stringify(prior));
		return prior;
	}
	if (effect) {
		const goal = effect.receipt.goals.find(row => row.runId === target.goalRunId);
		if (!goal || goal.outcome !== "fulfilled" || !goal.tasks.some(task => task.taskId === target.taskId &&
			task.mode === "execute" && task.status === "accepted"))
			reject("latest accepted goal contradicts the authenticated host census");
	}
	const entry: M04TransactionQuarantineEntryV1 = { source: proof.source,
		envelopeSha256: proof.envelopeSha256, contractId: target.contractId,
		goalRunId: target.goalRunId, taskId: target.taskId, m04RunId: target.m04RunId,
		state: "unknown-unreconciled", route: "fresh-work-only",
		proposalSubmitted: target.proposalSubmitted,
		selectedTupleSha256: target.selectedTupleSha256,
		inheritedOperationRefs: target.inheritedOperationRefs };
	const entries = prior?.entries ?? [];
	if (existing) reject("duplicate target changed its quarantine facts");
	const quarantine = { version: 1 as const, kind: "unresolved-historical-m04-quarantine" as const,
		entries: [...entries, entry] };
	freshOnlyQuarantines.set(quarantine, JSON.stringify(quarantine));
	return quarantine;
}

/** Structural fixture only; production callers cannot bypass the live verifier. */
export const offlineM04QuarantineChecks = {
	build(input: { proof: AuthenticatedPriorCarryProof; bundle: PrivateContinuationBundle;
		freshBoundary: FreshM04QuarantineBoundary; hostEffect?: AuthenticatedHostEffectEvidence;
		prior?: M04TransactionQuarantineV1 }): M04TransactionQuarantineV1 | undefined {
		if (!process.env.NODE_TEST_CONTEXT) reject("offline quarantine fixture is test-only");
		return buildFromAuthenticatedFacts(input.proof, input.bundle, input.freshBoundary,
			input.hostEffect, input.prior);
	},
};

export function hasFreshOnlyM04QuarantineForLatest(quarantine: M04TransactionQuarantineV1 | undefined,
	bundle: PrivateContinuationBundle): boolean {
	if (!quarantine || freshOnlyQuarantines.get(quarantine) !== JSON.stringify(quarantine)) return false;
	const latest = latestTarget(bundle);
	return Boolean(latest && quarantine.entries.some(entry => entry.goalRunId === latest.goalRunId &&
		entry.taskId === latest.taskId && entry.m04RunId === latest.m04RunId &&
		entry.contractId === latest.contractId && entry.state === "unknown-unreconciled" &&
		entry.route === "fresh-work-only"));
}
