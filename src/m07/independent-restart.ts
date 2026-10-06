/**
 * Host-only admission for an independent goal after a terminal, confined attempt.
 * This is deliberately separate from M07 operation reconciliation and attempt recovery.
 * The old checkpoint is read but never edited; its operations remain unknown.
 *
 * The caller owns authentication of the carry, terminal-run observation, source-policy
 * review, fresh candidate validation, and durable one-use receipt storage. None of
 * those facts may be supplied by an execution model or inferred from a tool log.
 */
import { createHash } from "node:crypto";
import type { ObjectiveProgressV1 } from "./objective-progress.ts";

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");
const digest = (value: unknown): string => sha256(JSON.stringify(value));
const bundleDigest = (bundle: Record<string, string>): string =>
	digest(Object.fromEntries(Object.entries(bundle).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)));
const hex64 = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
const text = (value: unknown, max = 512): value is string =>
	typeof value === "string" && value.length > 0 && value.length <= max && !value.includes("\0");
const sameSet = (left: string[], right: string[]): boolean =>
	left.length === right.length && new Set(left).size === left.length &&
	new Set(right).size === right.length && left.every(item => right.includes(item));

export interface AuthenticatedRestartCarryFacts {
	source: { runId: string; runAttempt: number; commit: string };
	currentRun: { runId: string; runAttempt: number; commit: string };
	/** SHA-256 of the authenticated encrypted carry envelope, not a caller-authored label. */
	envelopeSha256: string;
	/** SHA-256 of sorted-key JSON privateBundle as returned by the carry verifier. */
	privateBundleSha256: string;
	terminal: { state: "terminal"; sourceRunId: string; sourceRunAttempt: number;
		observationDigest: string; observedAt: string };
	resultArtifact: { immutableRef: string; digestScope: string; sha256: string };
	/** Authenticated cumulative upper bound. Unknown usage is already included. */
	committedNano: number;
	unknownHeldNano: number;
}

export interface ReviewedRestartEffectPolicy {
	/** Exact immutable source revision reviewed by the adapter's host-policy registry. */
	sourceCommit: string;
	policyId: string;
	policySha256: string;
	/** Each unknown is covered by its own source review or prior sealed quarantine. */
	operationAttestations: Array<{ operationRef: string; sourceCommit: string; evidenceSha256: string }>;
	effectClass: "confined-ephemeral-local";
	/** Provider billing is held; any fixed host archival transport is versioned and immutable. */
	unknownBillingHeld: true;
	actorThirdPartyMutations: "none";
	hostTransport: "immutable-versioned-archive" | "none";
}

export interface RevalidatedRestartSelection {
	contractId: string;
	selectedRunId: string;
	selectedTaskId: string;
	/** Digest supplied by the core to the independent adapter checker. */
	tupleSha256: string;
	/** Fresh checker output digest. Prior recorded timings are not fresh evidence. */
	currentValidationSha256: string;
	status: "passed";
}

export interface IndependentRestartInput {
	/** Opaque, runtime-authenticated proof. Raw JSON or model-authored copies must fail. */
	authenticatedCarryProof: unknown;
	/** Exact privateBundle returned with that authenticated proof. */
	privateBundle: Record<string, string>;
	/** New isolated workspace and nonce, allocated before any new provider request. */
	freshWorkspace: { workspaceId: string; restartNonce: string };
	/** Historical failed source is unavailable to this runner, but the sealed output remains referenced. */
	failedHistory: { state: "unavailable"; reason: string; immutableArtifactRef: string;
		digestScope: string; artifactSha256: string };
}

export interface IndependentRestartReceiptV1 {
	version: 1;
	kind: "host-independent-goal-quarantine";
	issuedAt: string;
	reuseKey: string;
	prior: { source: AuthenticatedRestartCarryFacts["source"]; envelopeSha256: string;
		privateBundleSha256: string; checkpointSha256: string; contractId: string;
		selectedRunId: string; selectedTaskId: string; selectedTupleSha256: string;
		terminalObservationSha256: string; reviewedPolicyId: string; reviewedPolicySha256: string;
		committedNano: number; unknownHeldNano: number };
	quarantine: { operationRefs: string[]; historicalGoalOutcomes: Array<{ runId: string; outcome: string }>;
		operationOutcome: "unknown"; selectedFromFailedAttempt: false;
		/** Input-only duplicate aliases; checkpoint bytes remain unchanged and hashed. */
		legacyQualifiedAliases?: Array<{ bareOperationId: string; qualifiedOperationRef: string }>;
		failedHistory: IndependentRestartInput["failedHistory"] };
	freshWorkspace: IndependentRestartInput["freshWorkspace"];
	currentValidationSha256: string;
}

export interface IndependentRestartReservation {
	receipt: IndependentRestartReceiptV1;
	receiptRef: string;
	receiptSha256: string;
	quarantinedOperationRefs: string[];
}

export interface IndependentRestartGoalBindingV1 {
	version: 1;
	kind: "host-independent-goal-binding";
	quarantineReceiptSha256: string;
	freshWorkspace: IndependentRestartInput["freshWorkspace"];
	goalRunId: string;
}

export interface BoundIndependentRestartGoal {
	reservation: IndependentRestartReservation;
	binding: IndependentRestartGoalBindingV1;
	bindingRef: string;
	bindingSha256: string;
}

export interface IndependentRestartHost<Proof> {
	/** Private runtime brand check plus normalization, provided by the carry verifier. */
	authenticatedFacts(proof: unknown): AuthenticatedRestartCarryFacts | undefined;
	/** Adapter-reviewed immutable source/effect policy; must not read model text as authority. */
	reviewEffects(facts: AuthenticatedRestartCarryFacts,
		operationRefs: readonly string[]): Promise<ReviewedRestartEffectPolicy>;
	/** Re-run the selected source against current trusted checks before new dispatch. */
	revalidateSelection(input: { privateBundle: Readonly<Record<string, string>>;
		checkpoint: Readonly<ObjectiveProgressV1>; tupleSha256: string }): Promise<RevalidatedRestartSelection>;
	/**
	 * Atomically claim reuseKey within this run and persist the receipt into the next
	 * authenticated carry. Cross-run one-use needs serialized workflow admission and
	 * full-history carry freshness; a local mkdir alone is insufficient.
	 */
	commitOneUse(receipt: Readonly<IndependentRestartReceiptV1>): Promise<{
		receiptRef: string; receiptSha256: string;
		claim: { claimId: string; priorEnvelopeSha256: string; currentRunId: string;
			currentRunAttempt: number; currentCommit: string; currentJobId: string };
	}>;
}

function fail(message: string): never { throw new Error(`independent restart refused: ${message}`); }

/**
 * One legacy writer duplicated a current operation as both Oxxx and run/Oxxx.
 * Accept that shape only when the bounded runs identify exactly one active
 * origin and the qualified form is already present. Do not remove or settle the
 * operation in the historical checkpoint; return a canonical view for policy.
 */
export function canonicalRestartUnknowns(checkpoint: ObjectiveProgressV1): {
	operationRefs: string[]; aliases: Array<{ bareOperationId: string; qualifiedOperationRef: string }>;
} {
	const historicalRefs = checkpoint.boundedRuns.flatMap(run =>
		(run.unresolvedOperationIds ?? []).map(id => `${run.runId}/${id}`));
	const continuationRefs = checkpoint.continuation.unresolvedOperationIds;
	if (!historicalRefs.length || new Set(historicalRefs).size !== historicalRefs.length ||
		new Set(continuationRefs).size !== continuationRefs.length ||
		!checkpoint.boundedRuns.some(run => run.outcome === "active" &&
			(run.unresolvedOperationIds?.length ?? 0) > 0))
		fail("unknown operations are missing, duplicated, or hidden in historical state");
	const qualified: string[] = [];
	const aliases: Array<{ bareOperationId: string; qualifiedOperationRef: string }> = [];
	for (const ref of continuationRefs) {
		if (!text(ref) || ref.includes("\0"))
			fail("unknown operation reference is invalid");
		if (ref.includes("/")) {
			if (!historicalRefs.includes(ref))
				fail("continuation names an operation absent from historical bounded runs");
			qualified.push(ref);
			continue;
		}
		const origins = checkpoint.boundedRuns.filter(run => run.outcome === "active" &&
			run.unresolvedOperationIds?.includes(ref));
		if (origins.length !== 1 || !continuationRefs.includes(`${origins[0].runId}/${ref}`))
			fail("bare operation lacks one active, qualified historical origin");
		aliases.push({ bareOperationId: ref, qualifiedOperationRef: `${origins[0].runId}/${ref}` });
	}
	if (!sameSet(qualified, historicalRefs))
		fail("qualified continuation operations do not exactly match historical bounded runs");
	return { operationRefs: qualified, aliases };
}

/**
 * Admits only a new, independently validated goal. This does not modify a prior
 * M07 goal, settle an operation, release billing reserves, or adopt old output.
 */
const reserved = new WeakSet<IndependentRestartReservation>();
const bound = new WeakSet<IndependentRestartReservation>();

export async function reserveIndependentRestart<Proof>(input: IndependentRestartInput,
	host: IndependentRestartHost<Proof>): Promise<IndependentRestartReservation> {
	const facts = host.authenticatedFacts(input.authenticatedCarryProof);
	if (!facts) fail("carry proof is not runtime authenticated");
	if (!text(facts.source.runId) || !Number.isSafeInteger(facts.source.runAttempt) || facts.source.runAttempt < 1 ||
		!(/^[0-9a-f]{40}$/).test(facts.source.commit) || !hex64(facts.envelopeSha256) ||
		!hex64(facts.privateBundleSha256) || facts.privateBundleSha256 !== bundleDigest(input.privateBundle))
		fail("authenticated source or bundle binding is invalid");
	if (!text(facts.currentRun.runId) || facts.currentRun.runId === facts.source.runId ||
		!Number.isSafeInteger(facts.currentRun.runAttempt) || facts.currentRun.runAttempt < 1 ||
		!(/^[0-9a-f]{40}$/).test(facts.currentRun.commit))
		fail("fresh host run identity is invalid");
	if (facts.terminal.state !== "terminal" || facts.terminal.sourceRunId !== facts.source.runId ||
		facts.terminal.sourceRunAttempt !== facts.source.runAttempt ||
		!hex64(facts.terminal.observationDigest) || !Number.isFinite(Date.parse(facts.terminal.observedAt)))
		fail("prior execution is not independently proven terminal");
	if (![facts.committedNano, facts.unknownHeldNano].every(value => Number.isSafeInteger(value) && value >= 0) ||
		facts.unknownHeldNano === 0 || facts.unknownHeldNano > facts.committedNano)
		fail("unknown provider cost was not retained in the authenticated upper bound");
	if (!text(input.freshWorkspace.workspaceId) || !text(input.freshWorkspace.restartNonce) ||
		input.freshWorkspace.workspaceId === facts.source.runId)
		fail("fresh workspace and restart nonce are required");
	if (input.failedHistory.state !== "unavailable" || !text(input.failedHistory.reason, 1000) ||
		!text(input.failedHistory.immutableArtifactRef, 2000) || !text(input.failedHistory.digestScope) ||
		!hex64(input.failedHistory.artifactSha256) ||
		input.failedHistory.immutableArtifactRef !== facts.resultArtifact.immutableRef ||
		input.failedHistory.digestScope !== facts.resultArtifact.digestScope ||
		input.failedHistory.artifactSha256 !== facts.resultArtifact.sha256)
		fail("unread failed history must have an immutable artifact reference and explicit gap");

	const checkpointText = input.privateBundle["objective-checkpoint.json"];
	if (typeof checkpointText !== "string") fail("authenticated bundle lacks objective checkpoint");
	let checkpoint: ObjectiveProgressV1;
	try { checkpoint = JSON.parse(checkpointText) as ObjectiveProgressV1; }
	catch { return fail("objective checkpoint is invalid JSON"); }
	if (checkpoint?.version !== 1 || checkpoint.kind !== "original-objective-progress" ||
		checkpoint.contract?.version !== 1 || checkpoint.contract.kind !== "original-objective" ||
		!text(checkpoint.contract.id) || !Array.isArray(checkpoint.boundedRuns) ||
		!Array.isArray(checkpoint.selectedArtifacts) || !checkpoint.selectedArtifacts.length ||
		!Array.isArray(checkpoint.continuation?.unresolvedOperationIds) ||
		checkpoint.continuation.requiresOperationReconciliation !== true)
		fail("checkpoint does not preserve unresolved original-goal state");
	let originalContract: unknown;
	try { originalContract = JSON.parse(input.privateBundle["original-objective.json"]); }
	catch { return fail("authenticated bundle lacks original contract"); }
	if (JSON.stringify(originalContract) !== JSON.stringify(checkpoint.contract))
		fail("original contract and historical checkpoint disagree");
	const { operationRefs: unresolved, aliases } = canonicalRestartUnknowns(checkpoint);
	for (const name of checkpoint.selectedArtifacts)
		if (!text(name, 128) || typeof input.privateBundle[name] !== "string")
			fail("selected historical tuple is incomplete");
	const tupleSha256 = digest(checkpoint.selectedArtifacts.slice().sort().map(name =>
		({ name, sha256: sha256(input.privateBundle[name]), bytes: Buffer.byteLength(input.privateBundle[name], "utf8") })));
	const selection = await host.revalidateSelection({ privateBundle: input.privateBundle,
		checkpoint, tupleSha256 });
	if (selection.status !== "passed" || selection.contractId !== checkpoint.contract.id ||
		selection.tupleSha256 !== tupleSha256 || !hex64(selection.currentValidationSha256) ||
		!checkpoint.boundedRuns.some(run => run.runId === selection.selectedRunId &&
			run.selectedTaskId === selection.selectedTaskId &&
			run.acceptedTaskIds?.includes(selection.selectedTaskId) &&
			!run.unresolvedOperationIds?.length))
		fail("old accepted tuple was not independently revalidated");
	const policy = await host.reviewEffects(facts, unresolved);
	if (policy.sourceCommit !== facts.source.commit || !text(policy.policyId) ||
		!hex64(policy.policySha256) ||
		!Array.isArray(policy.operationAttestations) ||
		!sameSet(policy.operationAttestations.map(item => item.operationRef), unresolved) ||
		policy.operationAttestations.some(item => !(/^[0-9a-f]{40}$/).test(item.sourceCommit) ||
			!hex64(item.evidenceSha256)) ||
		policy.effectClass !== "confined-ephemeral-local" || policy.unknownBillingHeld !== true ||
		policy.actorThirdPartyMutations !== "none" ||
		!["immutable-versioned-archive", "none"].includes(policy.hostTransport))
		fail("source-policy review does not cover every unknown effect");

	const receipt: IndependentRestartReceiptV1 = {
		version: 1, kind: "host-independent-goal-quarantine", issuedAt: new Date().toISOString(),
		reuseKey: digest({ kind: "host-independent-goal-quarantine", source: facts.source,
			envelopeSha256: facts.envelopeSha256, operationRefs: [...unresolved].sort() }),
		prior: { source: { ...facts.source }, envelopeSha256: facts.envelopeSha256,
			privateBundleSha256: facts.privateBundleSha256, checkpointSha256: sha256(checkpointText),
			contractId: checkpoint.contract.id, selectedRunId: selection.selectedRunId,
			selectedTaskId: selection.selectedTaskId, selectedTupleSha256: tupleSha256,
			terminalObservationSha256: facts.terminal.observationDigest,
			reviewedPolicyId: policy.policyId, reviewedPolicySha256: policy.policySha256,
			committedNano: facts.committedNano, unknownHeldNano: facts.unknownHeldNano },
		quarantine: { operationRefs: [...unresolved].sort(),
			historicalGoalOutcomes: checkpoint.boundedRuns.map(run => ({ runId: run.runId, outcome: run.outcome })),
			operationOutcome: "unknown", selectedFromFailedAttempt: false,
			...(aliases.length ? { legacyQualifiedAliases: aliases } : {}),
			failedHistory: { ...input.failedHistory } },
		freshWorkspace: { ...input.freshWorkspace }, currentValidationSha256: selection.currentValidationSha256,
	};
	const receiptSha256 = digest(receipt);
	const committed = await host.commitOneUse(receipt);
	if (!text(committed.receiptRef, 2000) || committed.receiptSha256 !== receiptSha256 ||
		!text(committed.claim?.claimId) || !text(committed.claim.currentJobId) ||
		committed.claim.priorEnvelopeSha256 !== facts.envelopeSha256 ||
		committed.claim.currentRunId !== facts.currentRun.runId ||
		committed.claim.currentRunAttempt !== facts.currentRun.runAttempt ||
		committed.claim.currentCommit !== facts.currentRun.commit)
		fail("durable one-use receipt was not verified");
	const reservation = { receipt, receiptRef: committed.receiptRef,
		receiptSha256, quarantinedOperationRefs: [...unresolved].sort() };
	reserved.add(reservation);
	return reservation;
}

/** Bind the actual fresh M07 goal after model assessment, before any execute delegation. */
export async function bindIndependentRestartGoal(reservation: IndependentRestartReservation,
	goalRunId: string, persistBinding: (binding: Readonly<IndependentRestartGoalBindingV1>) =>
		Promise<{ bindingRef: string; bindingSha256: string }>): Promise<BoundIndependentRestartGoal> {
	if (!reserved.has(reservation) || bound.has(reservation)) fail("reservation is absent or already bound");
	if (digest(reservation.receipt) !== reservation.receiptSha256 ||
		!sameSet(reservation.quarantinedOperationRefs, reservation.receipt.quarantine.operationRefs))
		fail("reservation changed after its host claim");
	if (!text(goalRunId) || goalRunId === reservation.receipt.prior.source.runId ||
		goalRunId === reservation.receipt.prior.selectedRunId ||
		reservation.receipt.quarantine.historicalGoalOutcomes.some(run => run.runId === goalRunId))
		fail("new goal aliases historical identity");
	const binding: IndependentRestartGoalBindingV1 = { version: 1, kind: "host-independent-goal-binding",
		quarantineReceiptSha256: reservation.receiptSha256,
		freshWorkspace: { ...reservation.receipt.freshWorkspace }, goalRunId };
	const bindingSha256 = digest(binding);
	const committed = await persistBinding(binding);
	if (!text(committed.bindingRef, 2000) || committed.bindingSha256 !== bindingSha256)
		fail("fresh goal binding was not persisted");
	bound.add(reservation);
	return { reservation, binding, bindingRef: committed.bindingRef, bindingSha256 };
}
