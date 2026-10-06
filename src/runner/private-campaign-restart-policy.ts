/**
 * Host adapter for two reviewed, immutable private-campaign execution revisions.
 * The generic M07 restart gate remains repository- and task-agnostic. This file
 * classifies effects only; it never reconciles an M07 operation or releases cost.
 */
import { createHash } from "node:crypto";
import type { AuthenticatedRestartCarryFacts, ReviewedRestartEffectPolicy } from "../m07/independent-restart.ts";
import { authenticatedCarryForwardOrigin, authenticatedHostEffectEvidence,
	authenticatedLegacyV3RunReview, type AuthenticatedLegacyV3RunReview } from "./ledger-continuation.ts";

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

const INHERITED_ONLY_POLICY = Object.freeze({ version: 1,
	policyId: "mul-pis-confined-private-campaign-inherited-only-v3",
	sourceCommit: "2efc466b42757bfdc33a8c21ab053f2e786abf14",
	reviewedBoundary: "The immutable source retained the factory-attested confined read/write/edit actor tools, disabled built-in shell/network tools, exact active-tool check, isolated read-only checker execution, and fixed encrypted Actions archives. Its new budget/output-cap handling and host-certified settled local stops did not grant the actor new tools or persistent third-party effects. The latest bounded goal has a partial-settled local stop and no new unknown operation; historical unknown outcomes and billing holds remain unchanged.",
	effectClass: "confined-ephemeral-local", actorThirdPartyMutations: "none",
	hostTransport: "immutable-versioned-archive" });

const LENGTH_SETTLED_POLICY = Object.freeze({ version: 1,
	policyId: "mul-pis-confined-private-campaign-length-settled-v4",
	sourceCommit: "fafd5051e18f4f10a5897cf507c49d92641384d3",
	reviewedBoundary: "The immutable source retained factory-attested confined file tools, disabled Pi built-in shell/network tools, sandboxed read-only checker execution and encrypted Actions transport. Its latest actor response ended at a received, settled provider length limit; that answer and task are incomplete. Earlier unknown operations and billing holds remain quarantined without scientific acceptance.",
	effectClass: "confined-ephemeral-local", actorThirdPartyMutations: "none",
	hostTransport: "immutable-versioned-archive" });

const ONE_TIME_LEGACY_V3_POLICY = Object.freeze({ version: 1,
	policyId: "mul-pis-reviewed-run-37490692145-one-time-v1",
	runId: "37490692145", requestCommit: "f9d29bfd58449dba072c80f62a7db524f0a668c4",
	reviewedFirstParent: "00d4309390bb06536abbe5e86f97213298e901a0",
	reviewedBoundary: "The authenticated Actions request commit has the reviewed source as its first parent and the same tree. Host-reviewed source confined the actor to factory-attested candidate, lesson and registered-plan file tools, disabled Pi built-ins and extensions, and ran the fixed checker as non-root under network-isolated bubblewrap. The one-time restart additionally requires exact terminal, accounting, controller-operation and unselected-history receipts. Historical unknown billing remains held. This review is not scientific acceptance.",
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
			selectedFromFailedAttempt: false;
			historicalGoalOutcomes?: Array<{ runId: string; outcome: string }> };
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
		value.entries.length < 1) return reject(`invalid ${kind} chain`);
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

function reviewInheritedOnly(input: PrivateCampaignEffectReviewInput,
	checkpoint: { contract?: { id?: string }; boundedRuns?: Array<{ runId?: string; outcome?: string;
		unresolvedOperationIds?: string[] }> }, reservations: PriorReservation[], bindings: PriorBinding[]): ReviewedRestartEffectPolicy {
	const { facts, operationRefs } = input;
	if (reservations.length !== 2 || bindings.length !== 2)
		reject("inherited-only policy requires exactly two sealed quarantine/binding links");
	const first = reservations[0], second = reservations[1];
	const firstReceipt = first?.receipt, secondReceipt = second?.receipt;
	const firstClaim = first?.claim, secondClaim = second?.claim;
	const firstBinding = bindings[0], secondBinding = bindings[1];
	if (firstReceipt?.version !== 1 || firstReceipt.kind !== "host-independent-goal-quarantine" ||
		secondReceipt?.version !== 1 || secondReceipt.kind !== "host-independent-goal-quarantine" ||
		firstReceipt.quarantine?.operationOutcome !== "unknown" ||
		secondReceipt.quarantine?.operationOutcome !== "unknown" ||
		firstReceipt.quarantine.selectedFromFailedAttempt !== false ||
		secondReceipt.quarantine.selectedFromFailedAttempt !== false ||
		!Array.isArray(firstReceipt.quarantine.operationRefs) ||
		!Array.isArray(secondReceipt.quarantine.operationRefs) ||
		!firstReceipt.quarantine.operationRefs.length || !secondReceipt.quarantine.operationRefs.length ||
		new Set(firstReceipt.quarantine.operationRefs).size !== firstReceipt.quarantine.operationRefs.length ||
		new Set(secondReceipt.quarantine.operationRefs).size !== secondReceipt.quarantine.operationRefs.length ||
		!text(checkpoint.contract?.id) ||
		firstReceipt.prior?.contractId !== checkpoint.contract.id ||
		secondReceipt.prior?.contractId !== checkpoint.contract.id)
		reject("inherited-only receipt chain is malformed or changed the original obligation");
	const firstReceiptSha = sha256(JSON.stringify(firstReceipt));
	const secondReceiptSha = sha256(JSON.stringify(secondReceipt));
	const firstBindingSha = sha256(JSON.stringify(firstBinding));
	const secondBindingSha = sha256(JSON.stringify(secondBinding));
	if (firstBinding?.version !== 1 || firstBinding.kind !== "host-independent-goal-binding" ||
		secondBinding?.version !== 1 || secondBinding.kind !== "host-independent-goal-binding" ||
		firstBinding.quarantineReceiptSha256 !== firstReceiptSha ||
		secondBinding.quarantineReceiptSha256 !== secondReceiptSha ||
		firstBinding.freshWorkspace?.workspaceId !== firstReceipt.freshWorkspace?.workspaceId ||
		firstBinding.freshWorkspace?.restartNonce !== firstReceipt.freshWorkspace?.restartNonce ||
		secondBinding.freshWorkspace?.workspaceId !== secondReceipt.freshWorkspace?.workspaceId ||
		secondBinding.freshWorkspace?.restartNonce !== secondReceipt.freshWorkspace?.restartNonce ||
		!text(firstBinding.goalRunId) || !text(secondBinding.goalRunId) ||
		firstBinding.goalRunId === secondBinding.goalRunId)
		reject("inherited-only goal bindings are not exact append-only links");
	const priorPolicySha = PRIOR_REVIEWED_POLICY_SHA256;
	const currentPolicySha = sha256(JSON.stringify(CURRENT_POLICY));
	const secondReviewedSha = sha256(JSON.stringify({ currentPolicySha256: currentPolicySha,
		receiptSha256: firstReceiptSha, bindingSha256: firstBindingSha }));
	if (firstReceipt.prior?.source?.commit !== PRIOR_POLICY.sourceCommit ||
		secondReceipt.prior?.source?.commit !== CURRENT_POLICY.sourceCommit ||
		firstReceipt.prior.reviewedPolicyId !== PRIOR_POLICY.policyId ||
		firstReceipt.prior.reviewedPolicySha256 !== priorPolicySha ||
		secondReceipt.prior.reviewedPolicyId !== CURRENT_POLICY.policyId ||
		secondReceipt.prior.reviewedPolicySha256 !== secondReviewedSha ||
		!hex64(firstReceipt.prior.envelopeSha256) || !hex64(secondReceipt.prior.envelopeSha256) ||
		!input.bindsAncestor(input.proof, firstReceipt.prior.source, firstReceipt.prior.envelopeSha256) ||
		!input.bindsAncestor(input.proof, secondReceipt.prior.source, secondReceipt.prior.envelopeSha256))
		reject("inherited-only source-policy origins are not authenticated ancestors");
	if (!text(firstClaim?.claimId) || !text(secondClaim?.claimId) ||
		!text(firstClaim.currentJobId) || !text(secondClaim.currentJobId) ||
		firstClaim.priorEnvelopeSha256 !== firstReceipt.prior.envelopeSha256 ||
		secondClaim.priorEnvelopeSha256 !== secondReceipt.prior.envelopeSha256 ||
		firstClaim.currentRunId !== secondReceipt.prior.source.runId ||
		firstClaim.currentRunAttempt !== secondReceipt.prior.source.runAttempt ||
		firstClaim.currentCommit !== secondReceipt.prior.source.commit ||
		secondClaim.currentRunId !== facts.source.runId ||
		secondClaim.currentRunAttempt !== facts.source.runAttempt ||
		secondClaim.currentCommit !== facts.source.commit)
		reject("inherited-only claims do not form the authenticated source chain");
	const holds = [firstReceipt.prior.unknownHeldNano, secondReceipt.prior.unknownHeldNano, facts.unknownHeldNano];
	const committed = [firstReceipt.prior.committedNano, secondReceipt.prior.committedNano, facts.committedNano];
	if (holds.some(value => !Number.isSafeInteger(value) || value < 1) ||
		committed.some(value => !Number.isSafeInteger(value) || value < 0) ||
		holds[0] > holds[1] || holds[1] > holds[2] ||
		committed[0] > committed[1] || committed[1] > committed[2])
		reject("inherited-only quarantine would release unknown billing or rewrite committed cost");
	const priorGoal = checkpoint.boundedRuns?.find(run => run.runId === firstBinding.goalRunId);
	const latestGoal = checkpoint.boundedRuns?.find(run => run.runId === secondBinding.goalRunId);
	const newlyUnknownAtFirstRestart = (priorGoal?.unresolvedOperationIds ?? [])
		.map(id => `${firstBinding.goalRunId}/${id}`);
	if (priorGoal?.outcome !== "active" || !newlyUnknownAtFirstRestart.length ||
		latestGoal?.outcome !== "partial" || (latestGoal.unresolvedOperationIds?.length ?? 0) !== 0 ||
		!sameSet([...firstReceipt.quarantine.operationRefs, ...newlyUnknownAtFirstRestart],
			secondReceipt.quarantine.operationRefs) ||
		!sameSet(secondReceipt.quarantine.operationRefs, operationRefs) ||
		firstReceipt.quarantine.operationRefs.some(ref =>
			!checkpoint.boundedRuns?.some(run => (run.unresolvedOperationIds ?? [])
				.map(id => `${run.runId}/${id}`).includes(ref))))
		reject("inherited-only policy found an unaccounted or newly unknown goal operation");
	let history: { version?: number; kind?: string; entries?: Array<{ goalRunId?: string;
		files?: Record<string, string> }> };
	try { history = JSON.parse(input.privateBundle["research-history.json"]); }
	catch { return reject("inherited-only latest local stop lacks host archive history"); }
	const historyEntries = history.entries?.filter(item => item.goalRunId === secondBinding.goalRunId) ?? [];
	if (history.version !== 1 || history.kind !== "untrusted-version-bound-research-history" ||
		historyEntries.length !== 1 || typeof historyEntries[0].files?.["workflow-archive.json"] !== "string")
		reject("inherited-only latest local stop lacks a unique bound host archive");
	let archive: { version?: number; kind?: string; goalRunId?: string; goalOutcome?: string;
		taskStatus?: string; loopStopReason?: string; m04?: { state?: string };
		controllerEvidence?: { reviewStatus?: string; operationOutcomes?: Array<{ operationId?: string; status?: string;
			localStop?: { settledProviderRequestCount?: number; rejectedBeforeTransport?: boolean;
				stopReason?: string; effectScope?: string } }> } };
	try { archive = JSON.parse(historyEntries[0].files!["workflow-archive.json"]); }
	catch { return reject("inherited-only latest local stop host archive is invalid"); }
	const operationOutcomes = archive.controllerEvidence?.operationOutcomes ?? [];
	const localStop = operationOutcomes[0]?.localStop;
	if (archive.version !== 1 || archive.kind !== "m07-private-candidate-archive" ||
		archive.goalRunId !== secondBinding.goalRunId || archive.goalOutcome !== "partial" ||
		archive.taskStatus !== "failed" || archive.loopStopReason !== "budget-boundary" ||
		archive.m04?.state !== "not-run" || archive.controllerEvidence?.reviewStatus !== "unreviewed" ||
		operationOutcomes.length !== 1 ||
		!/^O\d{3,}$/.test(operationOutcomes[0]?.operationId ?? "") ||
		operationOutcomes[0].status !== "partial-settled" ||
		!Number.isSafeInteger(localStop?.settledProviderRequestCount) ||
		Number(localStop?.settledProviderRequestCount) < 1 ||
		localStop?.rejectedBeforeTransport !== true ||
		localStop.stopReason !== "total-cny-ceiling" ||
		localStop.effectScope !== "factory-attested-confined-file-tools")
		reject("inherited-only latest goal lacks the certified confined local-stop boundary");
	const operationAttestations = [
		...firstReceipt.quarantine.operationRefs.map(operationRef => ({ operationRef,
			sourceCommit: firstReceipt.prior.source.commit,
			evidenceSha256: sha256(JSON.stringify({ firstReceiptSha, firstBindingSha, operationRef })) })),
		...newlyUnknownAtFirstRestart.map(operationRef => ({ operationRef,
			sourceCommit: secondReceipt.prior.source.commit,
			evidenceSha256: sha256(JSON.stringify({ secondReceiptSha, secondBindingSha,
				secondReviewedSha, operationRef })) })),
	];
	const inheritedPolicySha = sha256(JSON.stringify(INHERITED_ONLY_POLICY));
	return { sourceCommit: facts.source.commit, policyId: INHERITED_ONLY_POLICY.policyId,
		policySha256: sha256(JSON.stringify({ inheritedPolicySha, firstReceiptSha, secondReceiptSha,
			firstBindingSha, secondBindingSha })), operationAttestations,
		effectClass: "confined-ephemeral-local", unknownBillingHeld: true,
		actorThirdPartyMutations: "none", hostTransport: "immutable-versioned-archive" };
}

function reviewLengthSettled(input: PrivateCampaignEffectReviewInput,
	checkpoint: { contract?: { id?: string }; boundedRuns?: Array<{ runId?: string; outcome?: string;
		unresolvedOperationIds?: string[] }> }, reservations: PriorReservation[], bindings: PriorBinding[]): ReviewedRestartEffectPolicy {
	const { facts, operationRefs } = input;
	if (reservations.length !== 3 || bindings.length !== 3)
		reject("length-settled policy requires exactly three sealed quarantine/binding links");
	const third = reservations[2], receipt = third?.receipt, claim = third?.claim, binding = bindings[2];
	if (receipt?.version !== 1 || receipt.kind !== "host-independent-goal-quarantine" ||
		receipt.prior?.source?.commit !== INHERITED_ONLY_POLICY.sourceCommit ||
		!Number.isSafeInteger(receipt.prior.committedNano) ||
		!Number.isSafeInteger(receipt.prior.unknownHeldNano) ||
		receipt.prior.unknownHeldNano < 1 ||
		receipt.quarantine?.operationOutcome !== "unknown" ||
		receipt.quarantine.selectedFromFailedAttempt !== false ||
		!sameSet(receipt.quarantine.operationRefs ?? [], operationRefs) ||
		!input.bindsAncestor(input.proof, receipt.prior.source, receipt.prior.envelopeSha256))
		reject("third quarantine does not bind the authenticated inherited-only source");
	const prefixFacts = { ...facts, source: { ...receipt.prior.source },
		committedNano: receipt.prior.committedNano, unknownHeldNano: receipt.prior.unknownHeldNano };
	const prefix = reviewInheritedOnly({ ...input, facts: prefixFacts }, checkpoint,
		reservations.slice(0, 2), bindings.slice(0, 2));
	if (receipt.prior.reviewedPolicyId !== prefix.policyId ||
		receipt.prior.reviewedPolicySha256 !== prefix.policySha256 ||
		receipt.prior.contractId !== checkpoint.contract?.id ||
		facts.unknownHeldNano !== receipt.prior.unknownHeldNano ||
		facts.committedNano < receipt.prior.committedNano ||
		facts.source.commit !== LENGTH_SETTLED_POLICY.sourceCommit)
		reject("third quarantine changes inherited effects or historical commitments");
	const receiptSha = sha256(JSON.stringify(receipt));
	const bindingSha = sha256(JSON.stringify(binding));
	if (binding?.version !== 1 || binding.kind !== "host-independent-goal-binding" ||
		binding.quarantineReceiptSha256 !== receiptSha ||
		binding.freshWorkspace?.workspaceId !== receipt.freshWorkspace?.workspaceId ||
		binding.freshWorkspace?.restartNonce !== receipt.freshWorkspace?.restartNonce ||
		!text(binding.goalRunId) ||
		!text(claim?.claimId) || !text(claim?.currentJobId) ||
		claim.priorEnvelopeSha256 !== receipt.prior.envelopeSha256 ||
		claim.currentRunId !== facts.source.runId ||
		claim.currentRunAttempt !== facts.source.runAttempt ||
		claim.currentCommit !== facts.source.commit)
		reject("third quarantine claim or goal binding is not exact");
	const latest = checkpoint.boundedRuns?.find(run => run.runId === binding.goalRunId);
	if (latest?.outcome !== "partial" || (latest.unresolvedOperationIds?.length ?? 0) !== 0 ||
		operationRefs.some(ref => ref.startsWith(`${binding.goalRunId}/`)))
		reject("latest goal introduced an unresolved operation");
	let history: { version?: number; kind?: string; entries?: Array<{ goalRunId?: string;
		files?: Record<string, string> }> };
	try { history = JSON.parse(input.privateBundle["research-history.json"]); }
	catch { return reject("length-settled source lacks authenticated host archive history"); }
	const matches = history.entries?.filter(item => item.goalRunId === binding.goalRunId) ?? [];
	if (history.version !== 1 || history.kind !== "untrusted-version-bound-research-history" ||
		matches.length !== 1 || typeof matches[0].files?.["workflow-archive.json"] !== "string")
		reject("length-settled source lacks one bound host archive");
	let archive: any;
	try { archive = JSON.parse(matches[0].files!["workflow-archive.json"]); }
	catch { return reject("length-settled host archive is invalid"); }
	const outcomes = archive?.controllerEvidence?.operationOutcomes;
	const terminal = Array.isArray(outcomes) && outcomes.length === 1 ? outcomes[0]?.terminalResponse : undefined;
	if (archive?.version !== 1 || archive.kind !== "m07-private-candidate-archive" ||
		archive.goalRunId !== binding.goalRunId || archive.goalOutcome !== "partial" ||
		archive.taskStatus !== "failed" || archive.loopStopReason !== "output-limit" ||
		archive.m04?.state !== "not-run" || archive.controllerEvidence?.reviewStatus !== "unreviewed" ||
		!Array.isArray(outcomes) || outcomes.length !== 1 ||
		outcomes[0]?.status !== "terminal-response-incomplete" ||
		!/^O\d{3,}$/.test(outcomes[0]?.operationId ?? "") ||
		!Number.isSafeInteger(terminal?.settledProviderRequestCount) ||
		terminal.settledProviderRequestCount < 1 || terminal.responseReceived !== true ||
		terminal.terminalStopReason !== "length" || terminal.taskComplete !== false ||
		terminal.effectScope !== "factory-attested-confined-file-tools")
		reject("latest goal lacks the received, settled, confined length-stop receipt");
	const policySha = sha256(JSON.stringify(LENGTH_SETTLED_POLICY));
	return { sourceCommit: facts.source.commit, policyId: LENGTH_SETTLED_POLICY.policyId,
		policySha256: sha256(JSON.stringify({ policySha, prefix: prefix.policySha256,
			receiptSha, bindingSha, terminal })), operationAttestations: prefix.operationAttestations,
		effectClass: "confined-ephemeral-local", unknownBillingHeld: true,
		actorThirdPartyMutations: "none", hostTransport: "immutable-versioned-archive" };
}

type FourthLinkCheckpoint = { contract?: { id?: string }; objectiveOutcome?: string;
	assessment?: { decision?: string }; boundedRuns?: Array<{ runId?: string; outcome?: string;
		selectedTaskId?: string; acceptedTaskIds?: string[]; unresolvedOperationIds?: string[] }> };

/** A sealed link from the exact zero-activity control wrapper to the exact
 * pre-census run. Future reviews may apply this to the historical six-run
 * prefix; a live one-time admission must also pass its zero-activity brand. */
function reviewFourthZeroWrapperLink(input: PrivateCampaignEffectReviewInput,
	checkpoint: FourthLinkCheckpoint, reservations: PriorReservation[], bindings: PriorBinding[],
	historicalCommittedNano: number, historicalUnknownHeldNano: number,
	immediateZeroActivitySource?: AuthenticatedLegacyV3RunReview["immediateZeroActivitySource"]): {
	oldIds: string[]; newGoalId: string; fourthReceiptSha: string; fourthBindingSha: string;
	fourthClaim: PriorReservation["claim"] } {
	const fourth = reservations[3], receipt = fourth?.receipt, claim = fourth?.claim;
	const binding = bindings[3];
	if (reservations.length !== 4 || bindings.length !== 4 ||
		receipt?.version !== 1 || receipt.kind !== "host-independent-goal-quarantine" ||
		receipt.prior?.source?.runId !== "37485015330" ||
		receipt.prior.source.runAttempt !== 1 ||
		receipt.prior.source.commit !== "1ca70ade2e2a7aa4d2655aca93ba806161e012b7" ||
		!hex64(receipt.prior.envelopeSha256) ||
		(immediateZeroActivitySource !== undefined && (
			receipt.prior.source.runId !== immediateZeroActivitySource.source.runId ||
			receipt.prior.source.runAttempt !== immediateZeroActivitySource.source.runAttempt ||
			receipt.prior.source.commit !== immediateZeroActivitySource.source.commit ||
			receipt.prior.envelopeSha256 !== immediateZeroActivitySource.envelopeSha256)) ||
		receipt.prior.contractId !== checkpoint.contract?.id ||
		receipt.prior.reviewedPolicyId !== "mul-pis-v3-no-model-activity-carry-forward-v1" ||
		!hex64(receipt.prior.reviewedPolicySha256) ||
		receipt.prior.committedNano !== historicalCommittedNano ||
		receipt.prior.unknownHeldNano !== historicalUnknownHeldNano ||
		receipt.quarantine?.operationOutcome !== "unknown" ||
		receipt.quarantine.selectedFromFailedAttempt !== false ||
		!sameSet(receipt.quarantine.operationRefs ?? [], input.operationRefs) ||
		!input.bindsAncestor(input.proof, receipt.prior.source, receipt.prior.envelopeSha256))
		reject("fourth quarantine is not the authenticated zero-activity control ancestor");
	const fourthReceiptSha = sha256(JSON.stringify(receipt));
	const fourthBindingSha = sha256(JSON.stringify(binding));
	if (binding?.version !== 1 || binding.kind !== "host-independent-goal-binding" ||
		binding.quarantineReceiptSha256 !== fourthReceiptSha ||
		binding.freshWorkspace?.workspaceId !== receipt.freshWorkspace?.workspaceId ||
		binding.freshWorkspace?.restartNonce !== receipt.freshWorkspace?.restartNonce ||
		!text(binding.goalRunId) || !text(claim?.claimId) || !text(claim?.currentJobId) ||
		claim.priorEnvelopeSha256 !== receipt.prior.envelopeSha256 ||
		claim.currentRunId !== ONE_TIME_LEGACY_V3_POLICY.runId || claim.currentRunAttempt !== 1 ||
		claim.currentCommit !== ONE_TIME_LEGACY_V3_POLICY.requestCommit)
		reject("fourth quarantine claim or goal binding is not exact");
	const historical = receipt.quarantine.historicalGoalOutcomes;
	const oldIds = (historical ?? []).map(row => row.runId);
	const runs = checkpoint.boundedRuns ?? [];
	if (!Array.isArray(historical) || historical.length !== 5 ||
		!text(bindings[2]?.goalRunId) || oldIds.at(-1) !== bindings[2]?.goalRunId ||
		new Set(oldIds).size !== oldIds.length ||
		historical.some((row, index) => !text(row.runId) || !text(row.outcome) ||
			runs[index]?.runId !== row.runId || runs[index]?.outcome !== row.outcome) ||
		runs.length !== 6 || new Set(runs.map(row => row.runId)).size !== runs.length ||
		runs.at(-1)?.runId !== binding.goalRunId ||
		checkpoint.objectiveOutcome !== "incomplete" || checkpoint.assessment?.decision === "fulfilled")
		reject("one-time run altered historical goals or original-objective disposition");
	const newGoal = runs.at(-1);
	if (!newGoal || !text(newGoal.runId) || newGoal.outcome !== "active" ||
		newGoal.selectedTaskId !== undefined || (newGoal.acceptedTaskIds?.length ?? 0) !== 0 ||
		!Array.isArray(newGoal.unresolvedOperationIds) || newGoal.unresolvedOperationIds.length !== 0 ||
		input.operationRefs.some(ref => ref.startsWith(`${newGoal.runId}/`)))
		reject("one-time run has a new selected, accepted, or unresolved goal effect");
	return { oldIds, newGoalId: newGoal!.runId!, fourthReceiptSha, fourthBindingSha,
		fourthClaim: claim! };
}

/** The branded verifier establishes immutable source and accounting provenance;
 * this one-time classifier additionally insists that the new work remains
 * rejected, unselected development evidence. It does not review model claims. */
export function reviewOneTimeLegacyV3Effects(input: PrivateCampaignEffectReviewInput,
	review: AuthenticatedLegacyV3RunReview,
	checkpoint: { contract?: { id?: string }; objectiveOutcome?: string; assessment?: { decision?: string };
		boundedRuns?: Array<{ runId?: string; outcome?: string; selectedTaskId?: string;
			acceptedTaskIds?: string[]; unresolvedOperationIds?: string[] }> },
	reservations: PriorReservation[], bindings: PriorBinding[]): ReviewedRestartEffectPolicy {
	const { facts, operationRefs, privateBundle: bundle } = input;
	const { origin, requestAudit } = review;
	if (facts.source.runId !== ONE_TIME_LEGACY_V3_POLICY.runId || facts.source.runAttempt !== 1 ||
		facts.source.commit !== ONE_TIME_LEGACY_V3_POLICY.requestCommit ||
		review.reviewedSourceCommit !== ONE_TIME_LEGACY_V3_POLICY.reviewedFirstParent ||
		origin.source.commit !== LENGTH_SETTLED_POLICY.sourceCommit ||
		facts.committedNano !== origin.historicalCommittedNano ||
		facts.unknownHeldNano !== origin.historicalUnknownHeldNano ||
		!Number.isSafeInteger(facts.committedNano) || facts.committedNano < facts.unknownHeldNano ||
		!Number.isSafeInteger(facts.unknownHeldNano) || facts.unknownHeldNano < 1 ||
		reservations.length !== 4 || bindings.length !== 4 ||
		review.unknownObservedAddedNano !== 0 || review.unpricedAddedCount !== 0 ||
		!Number.isSafeInteger(review.settledAddedNano) || review.settledAddedNano < 1 ||
		requestAudit.version !== 3 || requestAudit.kind !== "accounting-only-request-audit" ||
		requestAudit.requests.length !== 130 || requestAudit.unpricedRequestCount !== 0 ||
		requestAudit.unknownObservedCny !== 0 ||
		requestAudit.requests.some(row => row.status !== "settled" || row.settledCny === null ||
			row.unknownObservedCny !== null))
		reject("one-time run source, inherited commitments, or settled request census differs from review");
	const { oldIds, newGoalId, fourthReceiptSha, fourthBindingSha, fourthClaim } =
		reviewFourthZeroWrapperLink(input, checkpoint, reservations, bindings,
			origin.historicalCommittedNano, origin.historicalUnknownHeldNano,
			review.immediateZeroActivitySource);
	const runs = checkpoint.boundedRuns ?? [];
	const oldCheckpoint = { ...checkpoint, boundedRuns: runs.filter(row => oldIds.includes(row.runId ?? "")) };
	const historicalFacts: AuthenticatedRestartCarryFacts = { ...facts,
		source: { ...origin.source }, envelopeSha256: origin.envelopeSha256,
		committedNano: origin.historicalCommittedNano,
		unknownHeldNano: origin.historicalUnknownHeldNano };
	const prefix = reviewLengthSettled({ ...input, facts: historicalFacts }, oldCheckpoint,
		reservations.slice(0, 3), bindings.slice(0, 3));
	let history: { version?: number; kind?: string; entries?: Array<{ originalContractId?: string;
		goalRunId?: string; taskId?: string; files?: Record<string, string> }> };
	try { history = JSON.parse(bundle["research-history.json"]); }
	catch { return reject("one-time run lacks its encrypted untrusted research history"); }
	const entries = history.entries ?? [];
	const current = entries.filter(row => row.goalRunId === newGoalId);
	if (history.version !== 1 || history.kind !== "untrusted-version-bound-research-history" ||
		!Array.isArray(history.entries) ||
		new Set(entries.map(row => `${row.goalRunId}/${row.taskId}`)).size !== entries.length ||
		entries.some(row => !oldIds.includes(row.goalRunId ?? "") && row.goalRunId !== newGoalId) ||
		current.length !== 2 || !sameSet(current.map(row => row.taskId ?? ""), ["T001", "T002"]))
		reject("one-time run history does not contain exactly two version-bound new tasks");
	for (const [taskId, expectedIds] of [["T001", ["O001", "O002", "O003", "O004"]],
		["T002", ["O005", "O006", "O007"]]] as const) {
		const entry = current.find(row => row.taskId === taskId);
		if (entry?.originalContractId !== checkpoint.contract?.id ||
			typeof entry?.files?.["workflow-archive.json"] !== "string")
			reject("one-time run task lacks a bound host archive");
		let archive: any;
		try { archive = JSON.parse(entry!.files!["workflow-archive.json"]); }
		catch { return reject("one-time run task archive is invalid"); }
		const outcomes = archive?.controllerEvidence?.operationOutcomes;
		if (archive?.version !== 1 || archive.kind !== "m07-private-candidate-archive" ||
			archive.goalRunId !== newGoalId || archive.taskId !== taskId ||
			archive.goalOutcome !== "active" || archive.taskStatus !== "rejected" ||
			archive.controllerEvidence?.reviewStatus !== "rejected" || archive.m04?.state !== "not-run" ||
			!Array.isArray(outcomes) || outcomes.length !== expectedIds.length ||
			!sameSet(outcomes.map((row: any) => row?.operationId), expectedIds) ||
			outcomes.some((row: any) => row.status !== "response-received"))
			reject("one-time run task is not a rejected, response-received, unadopted archive");
	}
	let selected: any;
	try { selected = JSON.parse(bundle["workflow-archive.json"]); }
	catch { return reject("one-time run selected tuple is unavailable"); }
	if (!oldIds.includes(selected?.goalRunId) || selected?.controllerEvidence?.reviewStatus !== "accepted")
		reject("one-time run would promote a rejected task into the selected tuple");
	const policyId = ONE_TIME_LEGACY_V3_POLICY.policyId;
	return { sourceCommit: facts.source.commit, policyId,
		policySha256: sha256(JSON.stringify({ policy: ONE_TIME_LEGACY_V3_POLICY,
			resultArtifact: facts.resultArtifact, source: facts.source,
			historicalPolicy: prefix.policySha256, fourthReceiptSha, fourthBindingSha,
			fourthClaim, immediate: review.immediateZeroActivitySource, audit: requestAudit,
			newArchives: current.map(row => sha256(row.files!["workflow-archive.json"])) })),
		operationAttestations: prefix.operationAttestations,
		effectClass: "confined-ephemeral-local", unknownBillingHeld: true,
		actorThirdPartyMutations: "none", hostTransport: "immutable-versioned-archive" };
}

/** Only the reviewed source pair and a fully linked inherited quarantine are admitted. */
export function reviewPrivateCampaignRestartEffects(input: PrivateCampaignEffectReviewInput): ReviewedRestartEffectPolicy {
	const { facts, operationRefs, privateBundle: bundle } = input;
	if (!input.authenticatedBundle(input.proof, bundle)) reject("bundle is not authenticated by live ledger proof");
	const carryForward = authenticatedCarryForwardOrigin(input.proof, bundle);
	const hostEffect = authenticatedHostEffectEvidence(input.proof, bundle);
	const oneTimeLegacyV3 = authenticatedLegacyV3RunReview(input.proof, bundle);
	if (!(facts.source.commit === CURRENT_POLICY.sourceCommit ||
		facts.source.commit === INHERITED_ONLY_POLICY.sourceCommit ||
		facts.source.commit === LENGTH_SETTLED_POLICY.sourceCommit || carryForward || hostEffect || oneTimeLegacyV3) ||
		facts.resultArtifact.digestScope !== "github-artifact-archive" ||
		facts.unknownHeldNano < 1 || !operationRefs.length || new Set(operationRefs).size !== operationRefs.length)
		reject("latest source or unknown charge is outside reviewed scope");
	let checkpoint: { contract?: { id?: string }; objectiveOutcome?: string; selectedArtifacts?: string[];
		boundedRuns?: Array<{ runId?: string; outcome?: string; selectedTaskId?: string;
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
	if (hostEffect) {
		const { origin, receipt, requestAudit, reviewedEffectAncestry } = hostEffect;
		const emptyNoGoal = requestAudit.requests.length === 0 && receipt.goals.length === 0 &&
			receipt.sessions.every(session => session.kind === "none" || session.kind === "read-dir") &&
			receipt.requestIds.length === 0 &&
			reviewedEffectAncestry.at(-1)?.abandonedWithoutGoal === true;
		const oneTimeAncestor = reviewedEffectAncestry[0]?.source.runId === ONE_TIME_LEGACY_V3_POLICY.runId &&
			reviewedEffectAncestry[0]?.source.runAttempt === 1 &&
			reviewedEffectAncestry[0]?.source.commit === ONE_TIME_LEGACY_V3_POLICY.requestCommit;
		const baseLinks = oneTimeAncestor ? 4 : 3;
		if (origin.source.commit !== LENGTH_SETTLED_POLICY.sourceCommit ||
			facts.committedNano !== origin.historicalCommittedNano ||
			facts.unknownHeldNano !== origin.historicalUnknownHeldNano ||
			reservations.length !== baseLinks + reviewedEffectAncestry.length ||
			bindings.length !== baseLinks + reviewedEffectAncestry.filter(row => !row.abandonedWithoutGoal).length ||
			receipt.source.runId !== facts.source.runId ||
			receipt.source.runAttempt !== facts.source.runAttempt ||
			receipt.source.commit !== facts.source.commit ||
			(!emptyNoGoal && (receipt.goals.length < 1 || requestAudit.requests.length < 1)))
			reject("host-effect census is outside the authenticated historical restart scope");
		const historical = reservations[2]?.receipt?.quarantine?.historicalGoalOutcomes;
		const originalGoalIds = [...(historical ?? []).map(row => row.runId), bindings[2]?.goalRunId];
		const latestReview = reservations.at(-1)?.receipt?.quarantine?.historicalGoalOutcomes;
		const priorGoalIds = reviewedEffectAncestry.length ?
			(latestReview ?? []).map(row => row.runId) : originalGoalIds;
		if (!Array.isArray(historical) || !historical.length ||
			!text(bindings[2]?.goalRunId) ||
			(reviewedEffectAncestry.length > 0 && (!Array.isArray(latestReview) || !latestReview.length)) ||
			!sameSet(priorGoalIds, receipt.historicalGoalRunIds) ||
			!sameSet([...priorGoalIds, ...receipt.goals.map(goal => goal.runId)],
				boundedRuns.map(row => row.runId ?? "")) ||
			(latestReview ?? []).some(row => boundedRuns.find(saved => saved.runId === row.runId)?.outcome !== row.outcome) ||
			receipt.goals.some(goal => (boundedRuns.find(row => row.runId === goal.runId)?.unresolvedOperationIds?.length ?? 0) !== 0))
			reject("host-effect census changed historical goals or left a new goal unresolved");
		const historicalCheckpoint = { ...checkpoint, boundedRuns: boundedRuns.filter(row =>
			originalGoalIds.includes(row.runId ?? "")) };
		const historicalFacts: AuthenticatedRestartCarryFacts = { ...facts,
			source: { ...origin.source }, envelopeSha256: origin.envelopeSha256,
			committedNano: origin.historicalCommittedNano,
			unknownHeldNano: origin.historicalUnknownHeldNano };
		const reviewed = reviewLengthSettled({ ...input, facts: historicalFacts },
			historicalCheckpoint, reservations.slice(0, 3), bindings.slice(0, 3));
		if (oneTimeAncestor) {
			const prefix = { ...checkpoint, boundedRuns: boundedRuns.slice(0, 6) };
			const fourth = reviewFourthZeroWrapperLink(input, prefix,
				reservations.slice(0, 4), bindings.slice(0, 4),
				origin.historicalCommittedNano, origin.historicalUnknownHeldNano);
			if (fourth.newGoalId !== receipt.historicalGoalRunIds[5] ||
				reviewedEffectAncestry[0].source.runId !== reservations[4]?.receipt?.prior?.source?.runId)
				reject("one-time reviewed-effect ancestry does not follow its zero-activity fourth link");
		}
		if (new Set(bindings.map(row => row?.goalRunId)).size !== bindings.length)
			reject("reviewed-effect ancestry repeats a fresh goal binding");
		let boundLinkIndex = baseLinks;
		for (const [index, ancestor] of reviewedEffectAncestry.entries()) {
			const current = reservations[baseLinks + index];
			const binding = ancestor.abandonedWithoutGoal ? undefined : bindings[boundLinkIndex++];
			const saved = current?.receipt, claim = current?.claim;
			if (saved?.version !== 1 || saved.kind !== "host-independent-goal-quarantine" ||
				saved.prior?.source?.runId !== ancestor.source.runId ||
				saved.prior.source.runAttempt !== ancestor.source.runAttempt ||
				saved.prior.source.commit !== ancestor.source.commit ||
				saved.prior.envelopeSha256 !== ancestor.envelopeSha256 ||
				saved.prior.reviewedPolicySha256 !== ancestor.reviewedPolicySha256 ||
				saved.prior.unknownHeldNano !== facts.unknownHeldNano ||
				saved.prior.committedNano !== facts.committedNano ||
				saved.quarantine?.operationOutcome !== "unknown" ||
				saved.quarantine.selectedFromFailedAttempt !== false ||
				!sameSet(saved.quarantine.operationRefs ?? [], operationRefs) ||
				(ancestor.abandonedWithoutGoal ? bindings.some(row =>
					row?.quarantineReceiptSha256 === sha256(JSON.stringify(saved))) :
					binding?.version !== 1 || binding.kind !== "host-independent-goal-binding" ||
					binding.quarantineReceiptSha256 !== sha256(JSON.stringify(saved)) ||
					binding.freshWorkspace?.workspaceId !== saved.freshWorkspace?.workspaceId ||
					binding.freshWorkspace?.restartNonce !== saved.freshWorkspace?.restartNonce ||
					!text(binding.goalRunId) ||
					!boundedRuns.some(row => row.runId === binding.goalRunId) ||
					(saved.quarantine.historicalGoalOutcomes ?? []).some(row => row.runId === binding.goalRunId)) ||
				!text(claim?.claimId) || !text(claim?.currentJobId))
				reject("reviewed-effect ancestry lacks an exact append-only quarantine link");
		}
		if (emptyNoGoal) {
			if (checkpoint.objectiveOutcome === "fulfilled" ||
				!sameSet(priorGoalIds, boundedRuns.map(row => row.runId ?? "")))
				reject("abandoned restart changed an objective goal without a host session");
			const policyId = "mul-pis-complete-host-no-goal-census-v1";
			return { sourceCommit: facts.source.commit, policyId,
				policySha256: sha256(JSON.stringify({ policyId, source: facts.source,
					envelope: facts.envelopeSha256, resultArtifact: facts.resultArtifact,
					historicalPolicy: reviewed.policySha256, receipt, reviewedEffectAncestry })),
				operationAttestations: reviewed.operationAttestations,
				effectClass: "confined-ephemeral-local", unknownBillingHeld: true,
				actorThirdPartyMutations: "none", hostTransport: "immutable-versioned-archive" };
		}
		let history: { version?: number; kind?: string;
			entries?: Array<{ goalRunId?: string; taskId?: string; files?: Record<string, string> }> };
		try { history = JSON.parse(bundle["research-history.json"]); }
		catch { return reject("host-effect census lacks authenticated task archives"); }
		if (history.version !== 1 || history.kind !== "untrusted-version-bound-research-history" ||
			!Array.isArray(history.entries)) reject("host-effect task history is invalid");
		const newGoalIds = receipt.goals.map(goal => goal.runId);
		const newEntries = history.entries!.filter(entry => newGoalIds.includes(entry.goalRunId ?? ""));
		const executeTasks = receipt.goals.flatMap(goal => goal.tasks.filter(task => task.mode === "execute")
			.map(task => ({ goal, task })));
		let selectedArchive: any;
		try { selectedArchive = JSON.parse(bundle["workflow-archive.json"]); }
		catch { return reject("selected task archive is invalid"); }
		const selectedNew = newGoalIds.includes(selectedArchive?.goalRunId) ? selectedArchive : undefined;
		if (selectedNew && (selectedNew?.version !== 1 ||
			selectedNew.kind !== "m07-private-candidate-archive" ||
			selectedNew.controllerEvidence?.reviewStatus !== "accepted" ||
			checkpoint.boundedRuns?.find(row => row.runId === selectedNew.goalRunId)?.selectedTaskId !== selectedNew.taskId ||
			!checkpoint.selectedArtifacts?.includes("candidate.cpp") ||
			!checkpoint.selectedArtifacts?.includes("verification.json") ||
			!checkpoint.selectedArtifacts?.includes("workflow-archive.json") ||
			!bundle["candidate.cpp"] || !bundle["verification.json"]))
			reject("new selected task lacks a coherent accepted tuple");
		if (checkpoint.objectiveOutcome === "fulfilled" ||
			newEntries.length !== executeTasks.length - (selectedNew ? 1 : 0) ||
			executeTasks.length < 1 ||
			new Set(newEntries.map(entry => `${entry.goalRunId}/${entry.taskId}`)).size !== newEntries.length)
			reject("host-effect census does not cover every new execute task archive");
		for (const { goal, task } of executeTasks) {
			if (!["accepted", "rejected", "failed"].includes(task.status))
				reject("host-effect census contains a nonterminal new task");
			const entries = newEntries.filter(entry => entry.goalRunId === goal.runId &&
				entry.taskId === task.taskId && typeof entry.files?.["workflow-archive.json"] === "string");
			const isSelected = selectedNew?.goalRunId === goal.runId && selectedNew?.taskId === task.taskId;
			if (entries.length !== (isSelected ? 0 : 1))
				reject("host-effect census lacks one exact new task archive");
			let archive: any;
			try { archive = isSelected ? selectedNew : JSON.parse(entries[0].files!["workflow-archive.json"]); }
			catch { return reject("host-effect task archive is invalid"); }
			const outcomes = archive?.controllerEvidence?.operationOutcomes;
			const expected = goal.operations.filter(operation => operation.taskId === task.taskId);
			if (archive?.version !== 1 || archive.kind !== "m07-private-candidate-archive" ||
				archive.goalRunId !== goal.runId || archive.taskId !== task.taskId ||
				archive.taskStatus !== task.status || archive.goalOutcome !== goal.outcome ||
				archive.controllerEvidence?.reviewStatus !== (task.status === "accepted" ? "accepted" :
					task.status === "rejected" ? "rejected" : "unreviewed") ||
				(task.status !== "accepted" && archive.m04?.state !== "not-run") || !Array.isArray(outcomes) ||
				outcomes.length !== expected.length ||
				new Set(outcomes.map((row: any) => row?.operationId)).size !== outcomes.length ||
				expected.some(operation => !outcomes.some((row: any) =>
					row?.operationId === operation.id && row.status === operation.status)))
				reject("host-effect archive differs from the settled controller census");
		}
		const policyId = "mul-pis-complete-host-effect-census-v1";
		return { sourceCommit: facts.source.commit, policyId,
			policySha256: sha256(JSON.stringify({ policyId, source: facts.source,
				envelope: facts.envelopeSha256, resultArtifact: facts.resultArtifact,
				historicalPolicy: reviewed.policySha256, receipt })),
			operationAttestations: reviewed.operationAttestations,
			effectClass: "confined-ephemeral-local", unknownBillingHeld: true,
			actorThirdPartyMutations: "none", hostTransport: "immutable-versioned-archive" };
	}
	if (oneTimeLegacyV3)
		return reviewOneTimeLegacyV3Effects(input, oneTimeLegacyV3, checkpoint,
			reservations, bindings);
	if (carryForward) {
		if (carryForward.source.commit !== LENGTH_SETTLED_POLICY.sourceCommit ||
			facts.unknownHeldNano !== carryForward.historicalUnknownHeldNano ||
			facts.committedNano !== carryForward.historicalCommittedNano ||
			!Number.isSafeInteger(facts.committedNano) || facts.committedNano < facts.unknownHeldNano ||
			reservations.length !== 3 || bindings.length !== 3)
			reject("v3 carry-forward changed historical commitments or reviewed source");
		const historical = reservations[2]?.receipt?.quarantine?.historicalGoalOutcomes;
		const expectedGoals = [...(historical ?? []).map(row => row.runId), bindings[2]?.goalRunId];
		if (!Array.isArray(historical) || !historical.length ||
			historical.some(row => !text(row.runId) || !text(row.outcome)) ||
			!text(bindings[2]?.goalRunId) ||
			!sameSet(expectedGoals, boundedRuns.map(row => row.runId ?? "")) ||
			historical.some(row => boundedRuns.find(saved => saved.runId === row.runId)?.outcome !== row.outcome))
			reject("v3 carry-forward added or changed a historical research goal");
		let history: { entries?: Array<{ goalRunId?: string }> };
		try { history = JSON.parse(bundle["research-history.json"]); }
		catch { return reject("v3 carry-forward history is unavailable"); }
		if (!Array.isArray(history.entries) ||
			new Set(history.entries.map(row => row.goalRunId)).size !== history.entries.length ||
			history.entries.some(row =>
			!text(row.goalRunId) || !expectedGoals.includes(row.goalRunId)))
			reject("v3 carry-forward added unreviewed research history");
		const historicalFacts: AuthenticatedRestartCarryFacts = { ...facts,
			source: { ...carryForward.source }, envelopeSha256: carryForward.envelopeSha256,
			committedNano: carryForward.historicalCommittedNano,
			unknownHeldNano: carryForward.historicalUnknownHeldNano };
		const reviewed = reviewLengthSettled({ ...input, facts: historicalFacts }, checkpoint,
			reservations, bindings);
		const policyId = "mul-pis-v3-no-model-activity-carry-forward-v1";
		return { sourceCommit: facts.source.commit, policyId,
			policySha256: sha256(JSON.stringify({ policyId, actualSource: facts.source,
				actualEnvelope: facts.envelopeSha256, resultArtifact: facts.resultArtifact,
				terminal: facts.terminal.observationDigest, historicalPolicy: reviewed.policySha256 })),
			operationAttestations: reviewed.operationAttestations,
			effectClass: "confined-ephemeral-local", unknownBillingHeld: true,
			actorThirdPartyMutations: "none", hostTransport: "immutable-versioned-archive" };
	}
	if (facts.source.commit === INHERITED_ONLY_POLICY.sourceCommit)
		return reviewInheritedOnly(input, checkpoint, reservations, bindings);
	if (facts.source.commit === LENGTH_SETTLED_POLICY.sourceCommit)
		return reviewLengthSettled(input, checkpoint, reservations, bindings);
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
