/**
 * Authenticated history classifier for a fresh independent research goal.
 * A prior carry proves the bytes and ancestry of historical receipts. It does
 * not prove that historical actor, provider, M04, or host effects were confined
 * or settled. All prior unknowns stay unknown and old sessions are never reused.
 */
import { createHash } from "node:crypto";
import { canonicalRestartUnknowns, type AuthenticatedRestartCarryFacts,
	type ReviewedRestartEffectPolicy } from "../m07/independent-restart.ts";
import { authenticatedAccountingObservation, authenticatedCarryAncestry,
	authenticatedHistoricalCarryOrigin, authenticatedHistoricalOpaqueRunGaps,
	authenticatedHostEffectEvidence, authenticatedSelectedTransitions,
	type AuthenticatedAccountingObservation, type AuthenticatedSelectedTransition,
	type AuthenticatedCarryForwardOrigin, type AuthenticatedHostEffectEvidence,
	type OpaqueExecutedRunGap } from "./ledger-continuation.ts";
import type { ObjectiveProgressV1 } from "../m07/objective-progress.ts";

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");
const hex64 = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
const commit40 = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{40}$/.test(value);
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 2000;
const qualified = (value: unknown): value is string => typeof value === "string" &&
	/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}\/O\d{3,}$/.test(value);
const record = (value: unknown): value is Record<string, unknown> =>
	Boolean(value) && typeof value === "object" && !Array.isArray(value);
const sameSet = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length &&
	new Set(a).size === a.length && new Set(b).size === b.length && a.every(value => b.includes(value));
const reject = (reason: string): never => { throw new Error(`private restart effect review refused: ${reason}`); };

export interface PrivateCampaignEffectReviewInput {
	facts: AuthenticatedRestartCarryFacts;
	operationRefs: readonly string[];
	privateBundle: Readonly<Record<string, string>>;
	proof: unknown;
	/** Live ledger proof and exact authenticated private bundle, never model JSON. */
	authenticatedBundle: (proof: unknown, bundle: unknown) => boolean;
	/** Live ledger proof binding a source and carry envelope in complete ancestry. */
	bindsAncestor: (proof: unknown, source: { runId: string; runAttempt: number; commit: string },
		envelopeSha256: string) => boolean;
}

type Source = { runId: string; runAttempt: number; commit: string; runNumber?: number };
type Reservation = { receipt: { version: number; kind: string; prior: {
	source: Source; envelopeSha256: string; contractId: string;
	reviewedPolicyId: string; reviewedPolicySha256: string;
	selectedTupleSha256?: string; selectedRunId?: string; selectedTaskId?: string;
	unknownHeldNano: number; committedNano: number;
	accountingObservation?: AuthenticatedAccountingObservation };
	quarantine: { operationRefs: string[]; operationOutcome: string;
		selectedFromFailedAttempt: boolean; historicalGoalOutcomes?: Array<{ runId: string; outcome: string }>;
		historicalEffectState?: string; executionMode?: string };
	freshWorkspace: { workspaceId: string; restartNonce: string } };
	claim: { claimId: string; priorEnvelopeSha256: string; currentRunId: string;
		currentRunAttempt: number; currentCommit: string; currentJobId: string } };
type Binding = { version: number; kind: string; quarantineReceiptSha256: string;
	freshWorkspace: { workspaceId: string; restartNonce: string }; goalRunId: string };
type Ancestry = readonly Readonly<{ source: Readonly<Source>; envelopeSha256: string }>[];
type Evidence = { ancestry: Ancestry; accounting: AuthenticatedAccountingObservation;
	origin?: AuthenticatedCarryForwardOrigin; gaps: readonly OpaqueExecutedRunGap[];
	hostEffect?: AuthenticatedHostEffectEvidence;
	selectedTransitions?: readonly AuthenticatedSelectedTransition[] };

function parseChain(raw: string | undefined, kind: string): unknown[] {
	if (raw === undefined) return [];
	let value: unknown;
	try { value = JSON.parse(raw); } catch { return reject(`invalid ${kind} JSON`); }
	if (!record(value) || value.version !== 1 || value.kind !== kind || !Array.isArray(value.entries))
		reject(`invalid ${kind} chain`);
	return (value as { entries: unknown[] }).entries;
}
function parseCheckpoint(raw: string | undefined): ObjectiveProgressV1 {
	let value: unknown;
	try { value = JSON.parse(raw ?? ""); } catch { return reject("historical checkpoint is unavailable"); }
	if (!record(value) || value.version !== 1 || value.kind !== "original-objective-progress" ||
		!record(value.contract) || !text(value.contract.id) ||
		!Array.isArray(value.boundedRuns) || !record(value.continuation))
		reject("historical original-objective checkpoint is invalid");
	return value as unknown as ObjectiveProgressV1;
}
function selectedTupleSha(bundle: Readonly<Record<string, string>>, checkpoint: ObjectiveProgressV1): string {
	const selected = checkpoint.selectedArtifacts;
	if (!Array.isArray(selected) || selected.length === 0 ||
		selected.some(name => !text(name) || name.length > 128 || typeof bundle[name] !== "string") ||
		new Set(selected).size !== selected.length)
		reject("historical selected tuple is missing or ambiguous");
	return sha256(JSON.stringify(selected.slice().sort().map(name => ({ name,
		sha256: sha256(bundle[name]), bytes: Buffer.byteLength(bundle[name], "utf8") }))));
}
function reviewedTransitionChain(last: Reservation["receipt"], selectedSha: string,
	checkpoint: ObjectiveProgressV1, bundle: Readonly<Record<string, string>>,
	ancestry: Ancestry, transitions: readonly AuthenticatedSelectedTransition[] | undefined,
	archive: Record<string, any>): boolean {
	if (!transitions?.length || !hex64(last.prior.selectedTupleSha256)) return false;
	const lastIndex = ancestry.findIndex(row => sourceMatches(row.source, last.prior.source) &&
		row.envelopeSha256 === last.prior.envelopeSha256);
	if (lastIndex < 0) return false;
	const priorGoalCount = last.quarantine.historicalGoalOutcomes?.length ?? 0;
	let tuple = last.prior.selectedTupleSha256;
	let previousSourceIndex = lastIndex;
	let previousSelectedArtifacts: readonly string[] | undefined;
	let carried = false;
	for (const row of transitions) {
		const sourceIndex = ancestry.findIndex(item => sourceMatches(item.source, row.source) &&
			item.envelopeSha256 === row.envelopeSha256);
		if (sourceIndex < 0) return false;
		if (sourceIndex <= lastIndex) continue;
		if (row.version !== 1 || row.kind !== "host-selected-tuple-transition" ||
			sourceIndex <= previousSourceIndex || sourceIndex < 1 ||
			row.priorEnvelopeSha256 !== ancestry[sourceIndex - 1]?.envelopeSha256 ||
			row.contractId !== checkpoint.contract.id ||
			row.priorSelectedTupleSha256 !== tuple || !hex64(row.selectedTupleSha256) ||
			!Array.isArray(row.priorSelectedArtifacts) || !row.priorSelectedArtifacts.length ||
			new Set(row.priorSelectedArtifacts).size !== row.priorSelectedArtifacts.length ||
			!Array.isArray(row.selectedArtifacts) || !row.selectedArtifacts.length ||
			new Set(row.selectedArtifacts).size !== row.selectedArtifacts.length ||
			(previousSelectedArtifacts !== undefined &&
				JSON.stringify(previousSelectedArtifacts) !== JSON.stringify(row.priorSelectedArtifacts)) ||
			!["no-proposal", "merged"].includes(row.m04State) ||
			checkpoint.boundedRuns.findIndex(goal => goal.runId === row.goalRunId &&
				goal.outcome === "fulfilled" && goal.selectedTaskId === row.taskId &&
				goal.acceptedTaskIds?.includes(row.taskId)) < priorGoalCount)
			return false;
		tuple = row.selectedTupleSha256;
		previousSourceIndex = sourceIndex;
		previousSelectedArtifacts = row.selectedArtifacts;
		carried = true;
	}
	if (!carried || tuple !== selectedSha) return false;
	const latest = transitions.findLast(row => {
		const index = ancestry.findIndex(item => sourceMatches(item.source, row.source) &&
			item.envelopeSha256 === row.envelopeSha256);
		return index > lastIndex;
	});
	return Boolean(latest && latest.goalRunId === archive.goalRunId &&
		latest.taskId === archive.taskId &&
		latest.archiveSha256 === sha256(bundle["workflow-archive.json"] ?? "") &&
		latest.m04RunId === archive.m04?.runId &&
		latest.m04State === archive.m04?.transaction?.state &&
		JSON.stringify(latest.selectedArtifacts) === JSON.stringify(checkpoint.selectedArtifacts));
}
function reviewSelectedTransition(bundle: Readonly<Record<string, string>>, checkpoint: ObjectiveProgressV1,
	selectedSha: string, last: Reservation["receipt"] | undefined,
	bindings: readonly Binding[], effect: AuthenticatedHostEffectEvidence | undefined,
	ancestry: Ancestry, transitions: readonly AuthenticatedSelectedTransition[] | undefined): void {
	if (!last?.prior.selectedTupleSha256 || last.prior.selectedTupleSha256 === selectedSha) return;
	const selected = checkpoint.selectedArtifacts;
	let currentArchive: any, history: any, verification: any, transaction: any;
	try {
		currentArchive = JSON.parse(bundle["workflow-archive.json"]);
		history = JSON.parse(bundle["research-history.json"]);
		verification = JSON.parse(bundle["verification.json"]);
		transaction = JSON.parse(bundle["m04-transaction.json"]);
	} catch { return reject("new selected tuple lacks an authenticated archive transition"); }
	if (!record(currentArchive) || !record(verification) || !record(transaction))
		reject("new selected tuple has an invalid archive transition");
	const selectedRun = checkpoint.boundedRuns.find(run => run.runId === currentArchive?.goalRunId);
	const lastBinding = bindings.find(row => row.quarantineReceiptSha256 === sha256(JSON.stringify(last)));
	const boundPosition = checkpoint.boundedRuns.findIndex(run => run.runId === lastBinding?.goalRunId);
	const selectedPosition = checkpoint.boundedRuns.findIndex(run => run.runId === currentArchive?.goalRunId);
	const currentAccepted = Boolean(effect?.receipt.goals.some(row =>
		row.runId === currentArchive.goalRunId && row.outcome === "fulfilled" &&
		row.tasks.some(task => task.taskId === currentArchive.taskId &&
			task.status === "accepted")));
	const historicallyCertified = reviewedTransitionChain(last, selectedSha, checkpoint,
		bundle, ancestry, transitions, currentArchive);
	const newSelectedGoal = currentArchive?.version === 1 &&
		currentArchive.kind === "m07-private-candidate-archive" &&
		currentArchive.goalOutcome === "fulfilled" && currentArchive.taskStatus === "accepted" &&
		currentArchive.controllerEvidence?.reviewStatus === "accepted" &&
		verification?.version === 1 && verification.status === "passed" &&
		text(bundle["candidate.cpp"]) &&
		currentArchive.m04?.state === "completed" &&
		currentArchive.m04?.transaction?.file === "m04-transaction.json" &&
		currentArchive.m04.transaction.state === transaction?.state &&
		transaction?.version === 1 && transaction.kind === "m04-knowledge-transaction" &&
		transaction.m04RunId === currentArchive.m04.runId &&
		(transaction.state === "no-proposal" ?
			transaction.attempts?.length === 0 &&
			currentArchive.m04.proposalSubmitted === false &&
			currentArchive.m04.snapshotCreated === false :
			transaction.state === "merged" && text(transaction.snapshotId) &&
			currentArchive.m04.proposalSubmitted === true &&
			currentArchive.m04.snapshotCreated === true &&
			currentArchive.m04.snapshotId === transaction.snapshotId) &&
		selectedRun?.outcome === "fulfilled" && selectedRun.selectedTaskId === currentArchive.taskId &&
		selectedRun.acceptedTaskIds?.includes(currentArchive.taskId) &&
		!last.quarantine.historicalGoalOutcomes?.some(row => row.runId === currentArchive.goalRunId) &&
		boundPosition >= 0 && selectedPosition >= boundPosition &&
		(currentAccepted || historicallyCertified);
	if (!newSelectedGoal || !text(last.prior.selectedRunId) || !text(last.prior.selectedTaskId) ||
		!Array.isArray(history?.entries))
		reject("new selected tuple lacks an authenticated accepted goal");
	const prior = history.entries.filter((row: any) => row?.goalRunId === last.prior.selectedRunId &&
		row?.taskId === last.prior.selectedTaskId && record(row.files));
	if (prior.length !== 1 ||
		selected.some(name => typeof prior[0].files[name] !== "string") ||
		sha256(JSON.stringify(selected.slice().sort().map(name => ({ name,
			sha256: sha256(prior[0].files[name]),
			bytes: Buffer.byteLength(prior[0].files[name], "utf8") })))) !== last.prior.selectedTupleSha256)
		reject("prior selected tuple is absent from authenticated history");
}
function sourceMatches(a: Source, b: Source): boolean {
	return a.runId === b.runId && a.runAttempt === b.runAttempt && a.commit === b.commit;
}
function reviewChain(input: PrivateCampaignEffectReviewInput, checkpoint: ObjectiveProgressV1,
	currentRefs: readonly string[], ancestry: Ancestry,
	currentAccounting: AuthenticatedAccountingObservation): { reservations: Reservation[]; bindings: Binding[];
		provenance: Map<string, { sourceCommit: string; evidenceSha256: string }> } {
	const bundle = input.privateBundle;
	const reservations = parseChain(bundle["independent-restart-quarantine.json"],
		"host-independent-restart-reservations") as Reservation[];
	const bindings = parseChain(bundle["independent-restart-goal-binding.json"],
		"host-independent-restart-goal-bindings") as Binding[];
	if ((!reservations.length && bindings.length) || bindings.length > reservations.length)
		reject("reservation and goal-binding chains disagree");
	const runById = new Map(checkpoint.boundedRuns.map(run => [run.runId, run]));
	if (runById.size !== checkpoint.boundedRuns.length)
		reject("historical bounded-run identities repeat");
	const provenance = new Map<string, { sourceCommit: string; evidenceSha256: string }>();
	let priorRefs: string[] = [];
	let priorCommitted = 0;
	let priorHeld = 0;
	let priorAncestryIndex = -1;
	let priorV3Accounting: AuthenticatedAccountingObservation | undefined;
	let priorGoalPrefix: string[] = [];
	let precedingBindingGoal: string | undefined;
	const usedGoals = new Set<string>();
	const usedBindings = new Set<number>();
	for (const [index, entry] of reservations.entries()) {
		const receipt = entry?.receipt, claim = entry?.claim;
		const source = receipt?.prior?.source;
		const refs = receipt?.quarantine?.operationRefs;
		if (![1, 2].includes(receipt?.version) || receipt.kind !== "host-independent-goal-quarantine" ||
			!source || !text(source.runId) || !Number.isSafeInteger(source.runAttempt) ||
			source.runAttempt < 1 || !commit40(source.commit) ||
			!hex64(receipt.prior.envelopeSha256) ||
			!input.bindsAncestor(input.proof, source, receipt.prior.envelopeSha256) ||
			receipt.prior.contractId !== checkpoint.contract.id ||
			!text(receipt.prior.reviewedPolicyId) || !hex64(receipt.prior.reviewedPolicySha256) ||
			(receipt.prior.selectedTupleSha256 !== undefined &&
				!hex64(receipt.prior.selectedTupleSha256)) ||
			!Number.isSafeInteger(receipt.prior.committedNano) || receipt.prior.committedNano < priorCommitted ||
			!Number.isSafeInteger(receipt.prior.unknownHeldNano) || receipt.prior.unknownHeldNano < priorHeld ||
			receipt.prior.unknownHeldNano > receipt.prior.committedNano ||
			receipt.quarantine.operationOutcome !== "unknown" ||
			receipt.quarantine.selectedFromFailedAttempt !== false ||
			!Array.isArray(refs) || refs.some(ref => !qualified(ref)) ||
			new Set(refs).size !== refs.length ||
			priorRefs.some(ref => !refs.includes(ref)) ||
			refs.some(ref => !currentRefs.includes(ref)) ||
			!text(receipt.freshWorkspace?.workspaceId) ||
			!text(receipt.freshWorkspace?.restartNonce) ||
			!text(claim?.claimId) || !text(claim?.currentJobId) ||
			claim.priorEnvelopeSha256 !== receipt.prior.envelopeSha256)
			reject("historical quarantine origin or retained unknowns are invalid");
		if (receipt.version === 2 && (receipt.quarantine.historicalEffectState !== "unknown-unreconciled" ||
			receipt.quarantine.executionMode !== "fresh-work-only"))
			reject("fresh-only historical quarantine is malformed");
		if (receipt.version === 2) {
			const observed = receipt.prior.accountingObservation;
			const fields: Array<keyof AuthenticatedAccountingObservation> =
				["historicalCommittedNano", "historicalUnknownHeldNano", "settledNano",
					"unknownObservedNano", "unpricedRequestCount", "opaqueUnquantifiedRunCount"];
			const v3Fields: Array<keyof AuthenticatedAccountingObservation> =
				["settledNano", "unknownObservedNano", "unpricedRequestCount",
					"opaqueUnquantifiedRunCount"];
			if (!record(observed) || Object.keys(observed).sort().join("|") !== fields.sort().join("|") ||
				fields.some(name => !Number.isSafeInteger(observed[name]) || Number(observed[name]) < 0) ||
				observed.historicalCommittedNano !== receipt.prior.committedNano ||
				observed.historicalUnknownHeldNano !== receipt.prior.unknownHeldNano ||
				v3Fields.some(name => Number(observed[name]) > currentAccounting[name] ||
					Number(observed[name]) < Number(priorV3Accounting?.[name] ?? 0)))
				reject("historical v3 accounting observation was lost or rewritten");
			priorV3Accounting = observed as AuthenticatedAccountingObservation;
		}
		if (index > 0 && refs.filter(ref => !priorRefs.includes(ref)).some(ref =>
			!precedingBindingGoal || !ref.startsWith(`${precedingBindingGoal}/`) ||
			!runById.get(precedingBindingGoal)?.unresolvedOperationIds?.includes(
				ref.slice(precedingBindingGoal.length + 1))))
			reject("historical unknown operation was not introduced by the preceding bound goal");
		const sourcePositions = ancestry.map((row, position) => ({ row, position })).filter(row =>
			sourceMatches(row.row.source, source) && row.row.envelopeSha256 === receipt.prior.envelopeSha256);
		if (sourcePositions.length !== 1 || sourcePositions[0].position <= priorAncestryIndex)
			reject("historical reservation source is missing, repeated, or out of order");
		const sourceIndex = sourcePositions[0].position;
		const next = ancestry[sourceIndex + 1]?.source;
		if (!next || claim.currentRunId !== next.runId || claim.currentRunAttempt !== next.runAttempt ||
			claim.currentCommit !== next.commit)
			reject("historical claims do not form the authenticated source chain");
		priorAncestryIndex = sourceIndex;
		const historicalGoals = receipt.quarantine.historicalGoalOutcomes;
		if (historicalGoals !== undefined && (!Array.isArray(historicalGoals) ||
			new Set(historicalGoals.map(row => row.runId)).size !== historicalGoals.length ||
			historicalGoals.some((row, position) => !text(row.runId) || !text(row.outcome) ||
				checkpoint.boundedRuns[position]?.runId !== row.runId ||
				runById.get(row.runId)?.outcome !== row.outcome) ||
			priorGoalPrefix.some((id, position) => historicalGoals[position]?.runId !== id) ||
			(precedingBindingGoal !== undefined &&
				!historicalGoals.some(row => row.runId === precedingBindingGoal))))
			reject("historical goal outcomes changed after quarantine");
		if (historicalGoals) priorGoalPrefix = historicalGoals.map(row => row.runId);
		const receiptSha = sha256(JSON.stringify(receipt));
		const matches = bindings.map((binding, bindingIndex) => ({ binding, bindingIndex })).filter(row =>
			row.binding?.quarantineReceiptSha256 === receiptSha);
		if (matches.length > 1) reject("historical quarantine has duplicate goal bindings");
		if (matches.length === 1) {
			const { binding, bindingIndex } = matches[0];
			if (binding.version !== 1 || binding.kind !== "host-independent-goal-binding" ||
				binding.freshWorkspace?.workspaceId !== receipt.freshWorkspace.workspaceId ||
				binding.freshWorkspace?.restartNonce !== receipt.freshWorkspace.restartNonce ||
				!text(binding.goalRunId) || !runById.has(binding.goalRunId) ||
				usedGoals.has(binding.goalRunId) || usedBindings.has(bindingIndex) ||
				bindingIndex !== usedBindings.size ||
				historicalGoals?.some(row => row.runId === binding.goalRunId))
				reject("historical goal binding is not a unique fresh goal");
			usedGoals.add(binding.goalRunId);
			usedBindings.add(bindingIndex);
			precedingBindingGoal = binding.goalRunId;
		}
		for (const ref of refs) if (!provenance.has(ref)) provenance.set(ref, {
			sourceCommit: source.commit,
			evidenceSha256: sha256(JSON.stringify({ receiptSha, operationRef: ref })) });
		priorRefs = refs;
		priorCommitted = receipt.prior.committedNano;
		priorHeld = receipt.prior.unknownHeldNano;
	}
	if (usedBindings.size !== bindings.length ||
		priorRefs.some(ref => !currentRefs.includes(ref)) ||
		priorCommitted > input.facts.committedNano || priorHeld > input.facts.unknownHeldNano)
		reject("historical restart chain discarded a binding, unknown, or cost observation");
	return { reservations, bindings, provenance };
}

function reviewCurrentHost(input: PrivateCampaignEffectReviewInput,
	checkpoint: ObjectiveProgressV1, effect: AuthenticatedHostEffectEvidence | undefined,
	priorRefs: readonly string[]): string[] {
	if (!effect) return input.operationRefs.filter(ref => !priorRefs.includes(ref));
	const { receipt, requestAudit } = effect;
	if (!sourceMatches(receipt.source, input.facts.source) ||
		!Array.isArray(receipt.historicalGoalRunIds) || !Array.isArray(receipt.goals) ||
		!Array.isArray(receipt.sessions) || !Array.isArray(receipt.requestIds) ||
		!Array.isArray(requestAudit.requests) ||
		!sameSet(receipt.requestIds, requestAudit.requests.map(row => row.requestId)) ||
		!sameSet([...receipt.historicalGoalRunIds, ...receipt.goals.map(goal => goal.runId)],
			checkpoint.boundedRuns.map(run => run.runId)))
		reject("current host census is incomplete or belongs to another source");
	for (const session of receipt.sessions) {
		if (session.kind === "none" || session.kind === "read-dir") continue;
		if (session.kind !== "confined-execution" || !session.grant ||
			session.grant.version !== 1 || session.grant.kind !== "confined-campaign-files" ||
			session.grant.root !== session.workRoot ||
			!sameSet(session.grant.writableFiles,
				session.grant.writableFiles.includes("experiment-plan.json") ?
					["candidate.cpp", "experiment-plan.json", "lesson-delta.json"] :
					["candidate.cpp", "lesson-delta.json"]))
			reject("current host actor grant exceeds factory-confined files");
	}
	const currentUnknown = receipt.goals.flatMap(goal => goal.operations.filter(row => row.status === "unknown")
		.map(row => `${goal.runId}/${row.id}`));
	const historicalUnknown = input.operationRefs.filter(ref => !currentUnknown.includes(ref));
	if (!sameSet([...historicalUnknown, ...currentUnknown], input.operationRefs) ||
		!sameSet(priorRefs, historicalUnknown) ||
		receipt.goals.some(goal => !sameSet(goal.operations.filter(row => row.status === "unknown")
			.map(row => row.id), checkpoint.boundedRuns.find(run => run.runId === goal.runId)
			?.unresolvedOperationIds ?? [])))
		reject("current host census lost or invented unknown operations");
	return currentUnknown;
}

function reviewCore(input: PrivateCampaignEffectReviewInput, evidence: Evidence): ReviewedRestartEffectPolicy {
	const { facts, privateBundle: bundle } = input;
	if (!input.authenticatedBundle(input.proof, bundle) ||
		!input.bindsAncestor(input.proof, facts.source, facts.envelopeSha256) ||
		!hex64(facts.envelopeSha256) || !commit40(facts.source.commit) ||
		(facts.resultArtifact !== undefined &&
			facts.resultArtifact.digestScope !== "github-artifact-archive"))
		reject("latest source is not bound to an authenticated historical carry");
	const { ancestry, accounting, origin, gaps, hostEffect: effect,
		selectedTransitions } = evidence;
	if (!Array.isArray(ancestry) || !ancestry.length ||
		!sourceMatches(ancestry.at(-1)!.source, facts.source) ||
		ancestry.at(-1)!.envelopeSha256 !== facts.envelopeSha256 ||
		ancestry.some(row => !input.bindsAncestor(input.proof, row.source, row.envelopeSha256)) ||
		new Set(ancestry.map(row => `${row.source.runId}/${row.source.runAttempt}`)).size !== ancestry.length)
		reject("ordered authenticated carry ancestry is incomplete");
	if (!accounting || Object.values(accounting).some(value =>
			!Number.isSafeInteger(value) || value < 0) ||
		accounting.historicalCommittedNano !== facts.committedNano ||
		accounting.historicalUnknownHeldNano !== facts.unknownHeldNano ||
		accounting.opaqueUnquantifiedRunCount !== gaps.length)
		reject("historical and current accounting observations disagree");
	const checkpoint = parseCheckpoint(bundle["objective-checkpoint.json"]);
	let original: unknown;
	try { original = JSON.parse(bundle["original-objective.json"]); }
	catch { return reject("original objective contract is unavailable"); }
	if (JSON.stringify(original) !== JSON.stringify(checkpoint.contract))
		reject("original objective contract changed after authentication");
	const canonical = canonicalRestartUnknowns(checkpoint).operationRefs;
	if (!sameSet(canonical, input.operationRefs))
		reject("unknown operations differ from authenticated checkpoint");
	const selectedSha = selectedTupleSha(bundle, checkpoint);
	const { reservations, bindings, provenance } = reviewChain(input, checkpoint, canonical,
		ancestry, accounting);
	const last = reservations.at(-1)?.receipt;
	reviewSelectedTransition(bundle, checkpoint, selectedSha, last, bindings, effect,
		ancestry, selectedTransitions);
	if (origin && (!input.bindsAncestor(input.proof, origin.source, origin.envelopeSha256) ||
		origin.historicalCommittedNano !== facts.committedNano ||
		origin.historicalUnknownHeldNano !== facts.unknownHeldNano))
		reject("historical accounting origin differs from live ancestry");
	if (gaps.some(gap => gap.kind !== "opaque-executed-run-gap" ||
		gap.accounting !== "unquantified" || gap.carryArtifact !== "absent" ||
		!text(gap.source.runId) || !commit40(gap.source.commit) ||
		!hex64(gap.priorCarryEnvelopeSha256)) ||
		new Set(gaps.map(gap => `${gap.source.runId}/${gap.source.runAttempt}`)).size !== gaps.length)
		reject("historical opaque run gap is not authenticated");
	const currentUnknown = reviewCurrentHost(input, checkpoint, effect,
		last?.quarantine.operationRefs ?? []);
	for (const ref of currentUnknown) if (!provenance.has(ref)) provenance.set(ref, {
		sourceCommit: facts.source.commit,
		evidenceSha256: sha256(JSON.stringify({ source: facts.source,
			resultArtifact: facts.resultArtifact, hostEffect: effect?.receipt, operationRef: ref })) });
	for (const ref of canonical) if (!provenance.has(ref)) provenance.set(ref, {
		sourceCommit: facts.source.commit,
		evidenceSha256: sha256(JSON.stringify({ source: facts.source,
			checkpointSha256: sha256(bundle["objective-checkpoint.json"]), operationRef: ref })) });
	const policyId = "mul-pis-historical-unknown-fresh-only-v2";
	return { sourceCommit: facts.source.commit, policyId,
		policySha256: sha256(JSON.stringify({ policyId, source: facts.source,
			envelopeSha256: facts.envelopeSha256, selectedSha, origin, gaps, accounting,
			selectedTransitions,
			reservationSha256: reservations.map(row => sha256(JSON.stringify(row))),
			bindingSha256: bindings.map(row => sha256(JSON.stringify(row))),
			hostEffect: effect?.receipt, operationRefs: [...canonical].sort() })),
		operationAttestations: [...canonical].sort().map(operationRef => ({ operationRef,
			...provenance.get(operationRef)! })),
		effectClass: "historical-unknown-fresh-only", unknownBillingHeld: true,
		actorThirdPartyMutations: "unknown",
		hostTransport: facts.resultArtifact ? "immutable-versioned-archive" : "none",
		accountingObservation: { ...accounting } };
}

/** Production path: only the ledger's live, exact-bundle proof mints this policy. */
export function reviewPrivateCampaignRestartEffects(input: PrivateCampaignEffectReviewInput): ReviewedRestartEffectPolicy {
	const bundle = input.privateBundle;
	const ancestry = authenticatedCarryAncestry(input.proof, bundle);
	const accounting = authenticatedAccountingObservation(input.proof, bundle);
	if (!ancestry || !accounting) return reject("live authenticated ancestry and accounting are required");
	return reviewCore(input, { ancestry, accounting,
		origin: authenticatedHistoricalCarryOrigin(input.proof, bundle),
		gaps: authenticatedHistoricalOpaqueRunGaps(input.proof, bundle) ?? [],
		hostEffect: authenticatedHostEffectEvidence(input.proof, bundle),
		selectedTransitions: authenticatedSelectedTransitions(input.proof, bundle) });
}

/** Synthetic structural probe; the production entry never accepts injected evidence. */
export const offlineRestartPolicyChecks = {
	reviewWithEvidence(input: PrivateCampaignEffectReviewInput, evidence: Evidence): ReviewedRestartEffectPolicy {
		if (!process.env.NODE_TEST_CONTEXT) reject("offline restart fixture is test-only");
		return reviewCore(input, evidence);
	},
};
