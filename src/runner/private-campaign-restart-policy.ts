/**
 * Host adapter for two reviewed, immutable private-campaign execution revisions.
 * The generic M07 restart gate remains repository- and task-agnostic. This file
 * classifies effects only; it never reconciles an M07 operation or releases cost.
 */
import { createHash } from "node:crypto";
import type { AuthenticatedRestartCarryFacts, ReviewedRestartEffectPolicy } from "../m07/independent-restart.ts";

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");
const hex64 = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
const commit40 = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{40}$/.test(value);
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 2000;
const sameSet = (a: string[], b: readonly string[]) => a.length === b.length &&
	new Set(a).size === a.length && new Set(b).size === b.length && a.every(value => b.includes(value));
const reject = (reason: string): never => { throw new Error(`private restart effect review refused: ${reason}`); };

const PRIOR_POLICY = Object.freeze({ version: 1,
	policyId: "mul-pis-legacy-confined-private-campaign-v1",
	sourceCommit: "2fe7f132370b4598c942625fad1a7e9129978eaa",
	reviewedBoundary: "Pi execution sessions received only confined text-file read/write/edit tools; built-in shell and network tools were not granted. The host verifier ran in a non-root bubblewrap user, network, PID and IPC namespace. Host output went only through the fixed encrypted Actions result archive. Provider billing remains unknown and held.",
	effectClass: "confined-ephemeral-local", actorThirdPartyMutations: "none",
	hostTransport: "immutable-versioned-archive" });

const CURRENT_POLICY = Object.freeze({ version: 1,
	policyId: "mul-pis-confined-private-campaign-independent-restart-v2",
	sourceCommit: "242bb0c205ef0d6fb0bf76dd53a2c3d62e55ef66",
	reviewedBoundary: "The immutable source retained the factory-attested read/write/edit-only actor grant, Pi built-in-tool disablement and exact active-tool check. Candidate compilation and execution remained in the non-root network/PID/IPC-isolated sandbox with read-only evaluated work. New host-only recovery and evidence tools did not grant actor shell or network effects. Output transport remained the fixed encrypted versioned Actions artifact; provider billing is separately held where unknown.",
	effectClass: "confined-ephemeral-local", actorThirdPartyMutations: "none",
	hostTransport: "immutable-versioned-archive" });

/** Public source-review fingerprint used to verify a sealed earlier quarantine. */
export const PRIOR_REVIEWED_POLICY_SHA256 = sha256(JSON.stringify(PRIOR_POLICY));

interface PriorReservation {
	receipt: {
		version: 1; kind: "host-independent-goal-quarantine"; prior: {
			source: { runId: string; runAttempt: number; commit: string };
			envelopeSha256: string; contractId: string; reviewedPolicyId: string;
			reviewedPolicySha256: string; unknownHeldNano: number; committedNano: number };
		quarantine: { operationRefs: string[]; operationOutcome: "unknown";
			selectedFromFailedAttempt: false };
		freshWorkspace: { workspaceId: string; restartNonce: string };
	};
	claim: { claimId: string; priorEnvelopeSha256: string; currentRunId: string;
		currentRunAttempt: number; currentCommit: string; currentJobId: string };
}
interface PriorBinding {
	version: 1; kind: "host-independent-goal-binding"; quarantineReceiptSha256: string;
	freshWorkspace: { workspaceId: string; restartNonce: string }; goalRunId: string;
}

function chain(raw: string | undefined, kind: string): unknown[] {
	if (typeof raw !== "string") return reject(`missing ${kind} chain`);
	let value: Record<string, unknown>;
	try { value = JSON.parse(raw) as Record<string, unknown>; }
	catch { return reject(`invalid ${kind} chain JSON`); }
	if (value.version !== 1 || value.kind !== kind || !Array.isArray(value.entries) ||
		value.entries.length < 1 || value.entries.length > 64) return reject(`invalid ${kind} chain`);
	return value.entries as unknown[];
}

/** Exact source of the old selected tuple is preserved in the authenticated carry. */
export interface PrivateCampaignEffectReviewInput {
	facts: AuthenticatedRestartCarryFacts;
	operationRefs: readonly string[];
	privateBundle: Readonly<Record<string, string>>;
	proof: unknown;
	/** Inject the ledger's live-brand-and-bundle predicate. */
	authenticatedBundle: (proof: unknown, bundle: unknown) => boolean;
	/** Inject the ledger's live-brand ancestry predicate; raw JSON cannot authorize origin. */
	bindsAncestor: (proof: unknown, source: { runId: string; runAttempt: number; commit: string },
		envelopeSha256: string) => boolean;
}

/** Only the reviewed source pair and a fully linked inherited quarantine are admitted. */
export function reviewPrivateCampaignRestartEffects(input: PrivateCampaignEffectReviewInput): ReviewedRestartEffectPolicy {
	const { facts, operationRefs, privateBundle: bundle } = input;
	if (!input.authenticatedBundle(input.proof, bundle)) reject("bundle is not authenticated by live ledger proof");
	if (facts.source.commit !== CURRENT_POLICY.sourceCommit || facts.resultArtifact.digestScope !== "github-artifact-archive" ||
		facts.unknownHeldNano < 1 || !operationRefs.length || new Set(operationRefs).size !== operationRefs.length)
		reject("latest source or unknown charge is outside reviewed scope");
	let checkpoint: { contract?: { id?: string }; boundedRuns?: Array<{ runId?: string; outcome?: string;
		unresolvedOperationIds?: string[] }> };
	try { checkpoint = JSON.parse(bundle["objective-checkpoint.json"]); }
	catch { return reject("historical objective checkpoint is unavailable"); }
	if (!text(checkpoint.contract?.id) || !Array.isArray(checkpoint.boundedRuns))
		reject("historical objective checkpoint is invalid");
	const contractId = checkpoint.contract?.id;
	const boundedRuns = checkpoint.boundedRuns ?? [];
	const reservations = chain(bundle["independent-restart-quarantine.json"],
		"host-independent-restart-reservations") as PriorReservation[];
	const bindings = chain(bundle["independent-restart-goal-binding.json"],
		"host-independent-restart-goal-bindings") as PriorBinding[];
	const qualifying: Array<{ reservation: PriorReservation; binding: PriorBinding; receiptSha256: string }> = [];
	for (const reservation of reservations) {
		const receipt = reservation?.receipt, claim = reservation?.claim;
		if (receipt?.version !== 1 || receipt.kind !== "host-independent-goal-quarantine" ||
			!Array.isArray(receipt.quarantine?.operationRefs) || !receipt.quarantine.operationRefs.length ||
			new Set(receipt.quarantine.operationRefs).size !== receipt.quarantine.operationRefs.length ||
			receipt.quarantine.operationOutcome !== "unknown" ||
			receipt.quarantine.selectedFromFailedAttempt !== false ||
			!text(receipt.prior?.contractId) || receipt.prior.contractId !== contractId ||
			!commit40(receipt.prior.source?.commit) || !hex64(receipt.prior.envelopeSha256) ||
			receipt.prior.reviewedPolicyId !== PRIOR_POLICY.policyId ||
			receipt.prior.reviewedPolicySha256 !== PRIOR_REVIEWED_POLICY_SHA256 ||
			!Number.isSafeInteger(receipt.prior.unknownHeldNano) || receipt.prior.unknownHeldNano < 1 ||
			receipt.prior.unknownHeldNano > facts.unknownHeldNano ||
			!Number.isSafeInteger(receipt.prior.committedNano) ||
			receipt.prior.committedNano < receipt.prior.unknownHeldNano ||
			receipt.prior.committedNano > facts.committedNano ||
			!text(receipt.freshWorkspace?.workspaceId) ||
			!text(receipt.freshWorkspace.restartNonce) ||
			receipt.prior.source.commit !== PRIOR_POLICY.sourceCommit ||
			!input.bindsAncestor(input.proof, receipt.prior.source, receipt.prior.envelopeSha256) ||
			!text(claim?.claimId) || !text(claim.currentJobId) ||
			claim.priorEnvelopeSha256 !== receipt.prior.envelopeSha256 ||
			claim.currentRunId !== facts.source.runId ||
			claim.currentRunAttempt !== facts.source.runAttempt ||
			claim.currentCommit !== facts.source.commit)
			reject("inherited quarantine origin is not bound to authenticated ancestry");
		const receiptSha256 = sha256(JSON.stringify(receipt));
		const matches = bindings.filter(binding => binding?.version === 1 &&
			binding.kind === "host-independent-goal-binding" &&
			binding.quarantineReceiptSha256 === receiptSha256 &&
			binding.freshWorkspace?.workspaceId === receipt.freshWorkspace?.workspaceId &&
			binding.freshWorkspace?.restartNonce === receipt.freshWorkspace?.restartNonce &&
			text(binding.goalRunId));
		if (matches.length !== 1) reject("inherited quarantine has no unique fresh-goal binding");
		qualifying.push({ reservation, binding: matches[0], receiptSha256 });
	}
	// This reviewed adapter covers the one immediately preceding independent run.
	if (qualifying.length !== 1 || bindings.length !== 1)
		reject("reviewed policy does not cover this quarantine chain shape");
	const { reservation, binding, receiptSha256 } = qualifying[0];
	const currentGoal = boundedRuns.find(run => run.runId === binding.goalRunId);
	const currentOperationIds = currentGoal?.unresolvedOperationIds ?? [];
	if (!currentGoal || currentGoal.outcome !== "active" ||
		!Array.isArray(currentGoal.unresolvedOperationIds) || !currentOperationIds.length)
		reject("new unknown lacks the bound active goal");
	const oldRefs = reservation.receipt.quarantine.operationRefs;
	const newRefs = operationRefs.filter(ref => ref.startsWith(`${binding.goalRunId}/`));
	if (!sameSet(newRefs, currentOperationIds.map(id => `${binding.goalRunId}/${id}`)) ||
		!sameSet([...oldRefs, ...newRefs], operationRefs) ||
		oldRefs.some(ref => ref.startsWith(`${binding.goalRunId}/`)) ||
		oldRefs.some(ref => !boundedRuns.some(run =>
			(run.unresolvedOperationIds ?? []).map(id => `${run.runId}/${id}`).includes(ref))))
		reject("old and new unknown effects do not partition exactly");
	const currentPolicySha256 = sha256(JSON.stringify(CURRENT_POLICY));
	const operationAttestations = [
		...oldRefs.map(operationRef => ({ operationRef,
			sourceCommit: reservation.receipt.prior.source.commit,
			evidenceSha256: sha256(JSON.stringify({ receiptSha256,
				bindingSha256: sha256(JSON.stringify(binding)), operationRef })) })),
		...newRefs.map(operationRef => ({ operationRef, sourceCommit: facts.source.commit,
			evidenceSha256: sha256(JSON.stringify({ currentPolicySha256, operationRef,
				boundGoalRunId: binding.goalRunId,
				resultArtifact: facts.resultArtifact })) })),
	];
	return { sourceCommit: facts.source.commit, policyId: CURRENT_POLICY.policyId,
		policySha256: sha256(JSON.stringify({ currentPolicySha256, receiptSha256,
			bindingSha256: sha256(JSON.stringify(binding)) })),
		operationAttestations, effectClass: "confined-ephemeral-local",
		unknownBillingHeld: true, actorThirdPartyMutations: "none",
		hostTransport: "immutable-versioned-archive" };
}
