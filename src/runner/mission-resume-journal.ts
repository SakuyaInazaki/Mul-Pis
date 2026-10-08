/**
 * Private, offline reservation journal for a host that launches fresh mission
 * runs. In particular, a crash after markAttempted is an uncertain delivery,
 * even when no HTTP response was received. This module makes no connector calls.
 */
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, readdir, rename, rm } from "node:fs/promises";
import { hostname } from "node:os";
import path from "node:path";
import { pendingActionIdentity, type ResumeIntent } from "./mission-supervisor.ts";
import { authenticatedTerminalUnknownControlDeliveries,
	REUSABLE_RUN_REQUEST_MESSAGE, type AuthenticatedTerminalCarryResult } from "./ledger-continuation.ts";
import { isVerifiedProviderAvailabilityProof,
	type VerifiedProviderAvailabilityProofV1 } from "./provider-availability-proof.ts";

const CONTROL_REF = "refs/heads/run-requests/workflow-learning-reliability";
const SOURCE_REF = "refs/heads/improve/workflow-learning-reliability";
const hex40 = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{40}$/.test(v);
const hex64 = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const runId = (v: unknown): v is string => typeof v === "string" && /^[1-9][0-9]{0,17}$/.test(v);
const digest = (v: string): string => createHash("sha256").update(v).digest("hex");
const refuse = (why: string): never => { throw new Error(`mission resume journal refused: ${why}`); };

/** Only these fields may enter the public control request. The journal keeps
 * its relation to the private mission intent in a mode-0700 directory. */
export type TestedControlBinding = Readonly<{
	controlRef: typeof CONTROL_REF;
	message: typeof REUSABLE_RUN_REQUEST_MESSAGE;
	testedSourceCommit: string;
	testedTree: string;
	successfulCi: Readonly<{ workflow: string; runId: string; runAttempt: number;
		headCommit: string; conclusion: "success" }>;
	previousControlCommit: string | null;
	parents: readonly string[];
	expectedBefore: string | null;
	sourceRef: typeof SOURCE_REF;
	sourceRefTip: string;
}>;

export type ResumeJournalState = "reserved" | "ref-update-attempted" |
	"delivery-unknown" | "acknowledged" | "reconciled-not-delivered";
type ActionProvenance = NonNullable<ResumeIntent["actionProvenance"]>;
export type ProviderAvailabilityAuditV1 = Readonly<{
	kind: "host-verified-provider-availability-audit";
	receiptSha256: string; terminalSource: Readonly<{ runId: string;
		runAttempt: number; commit: string }>; terminalEnvelopeSha256: string;
	testedSourceCommit: string; probeSource: Readonly<{ runId: string;
		runAttempt: number; commit: string }>;
	workflowId: string; jobId: string; artifactId: string;
	archiveSha256: string; envelopeSha256: string;
}>;
export type ResumeJournalRecord = Readonly<{
	version: 1;
	idempotencyKey: string;
	intentBinding: Readonly<{ source: ResumeIntent["source"]; envelopeSha256: string;
		contractId: string; selectedTupleSha256: string; pendingActionSha256: string;
		actionKind: ResumeIntent["actionKind"]; actionProvenance?: ActionProvenance;
		terminalInterruption?: ResumeIntent["terminalInterruption"];
		interruptedSourceReview?: ResumeIntent["interruptedSourceReview"];
		workflowRepair?: ResumeIntent["workflowRepair"];
		linkedUnknownDelivery?: ResumeIntent["linkedUnknownDelivery"] }>;
	control: TestedControlBinding;
	/** First verified positive probe used for this intent. Private provenance, outside stable idempotency. */
	providerAvailabilityAudit?: ProviderAvailabilityAuditV1;
	state: ResumeJournalState;
	negativeReconciliations: number;
	successorRunId?: string;
	observedControlCommit?: string;
	/** Authenticated successor carry sealed this exact uncertain-control ancestry.
	 * Historical delivery, effects, and accounting remain UNKNOWN. */
	carriedUnknownLineage?: Readonly<{ kind: "host-authenticated-unknown-control-lineage";
		carrierRunId: string; carrierControlCommit: string; envelopeSha256: string;
		ancestry: readonly Readonly<{ oldJournalKey: string; oldControlCommit: string }>[] }>;
}>;

/** A read-only verifier external to this module must establish this exact
 * control commit and Actions run from the live source, then supply the facts. */
export type AcceptedControlObservation = Readonly<{
	kind: "read-only-accepted-control";
	controlRef: string; controlCommit: string; tree: string;
	parents: readonly string[]; message: string;
	successorRunId: string;
}>;

/** Only a separate read-only negative reconciliation can release an uncertain
 * attempt. It must cover the exact prior ref tip and the full run census. */
export type NotDeliveredObservation = Readonly<{
	kind: "read-only-not-delivered";
	controlRef: string; observedHead: string | null;
	matchingRunCount: 0; pendingDeliveryExcluded: true;
}>;

function canonical(value: unknown): string {
	if (value === null || typeof value === "boolean" || typeof value === "string")
		return JSON.stringify(value);
	if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype)
		return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
			.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
	return refuse("unsupported binding value");
}

function repairBinding(value: ResumeIntent["workflowRepair"]): ResumeIntent["workflowRepair"] {
	if (value === undefined) return undefined;
	if (!hex64(value?.reviewedPlanSha256) || !hex40(value.testedSourceCommit) || !hex40(value.testedTree) ||
		value.successfulCi?.workflow !== "workflow-regression.yml" || !runId(value.successfulCi.runId) ||
		value.successfulCi.runAttempt !== 1 || value.successfulCi.headCommit !== value.testedSourceCommit ||
		value.successfulCi.conclusion !== "success") refuse("invalid workflow repair binding");
	return { reviewedPlanSha256: value.reviewedPlanSha256, testedSourceCommit: value.testedSourceCommit,
		testedTree: value.testedTree, successfulCi: { workflow: value.successfulCi.workflow,
			runId: value.successfulCi.runId, runAttempt: value.successfulCi.runAttempt,
			headCommit: value.successfulCi.headCommit, conclusion: "success" } };
}

function provenanceBinding(value: ActionProvenance | undefined): ActionProvenance | undefined {
	if (value === undefined) return undefined;
	if (value.kind === "current-host-derived" &&
		Object.keys(value).sort().join("|") === "checkpointSha256|kind" &&
		hex64(value.checkpointSha256))
		return { kind: "current-host-derived", checkpointSha256: value.checkpointSha256 };
	if (value.kind === "current-host-interruption" &&
		Object.keys(value).sort().join("|") === "kind|priorCheckpointSha256|resultArchiveSha256" &&
		hex64(value.priorCheckpointSha256) && hex64(value.resultArchiveSha256))
		return { kind: "current-host-interruption",
			priorCheckpointSha256: value.priorCheckpointSha256,
			resultArchiveSha256: value.resultArchiveSha256 };
	return refuse("invalid action provenance");
}

function interruptionBinding(value: ResumeIntent["terminalInterruption"],
	source: ResumeIntent["source"], envelopeSha256: string): ResumeIntent["terminalInterruption"] {
	if (value === undefined) return undefined;
	if (Object.keys(value).sort().join("|") !== ["version", "kind", "source", "priorCarrySource",
		"priorCarryEnvelopeSha256", "resultArtifactId", "resultArchiveSha256", "accounting",
		"effects", "terminationOrigin"].sort().join("|") ||
		value.version !== 1 || value.kind !== "host-verified-terminal-interruption" ||
		value.accounting !== "unquantified" || value.effects !== "unknown-unreconciled" ||
		value.terminationOrigin !== "unknown" || !runId(value.resultArtifactId) ||
		!hex64(value.resultArchiveSha256) || !hex64(value.priorCarryEnvelopeSha256) ||
		value.priorCarryEnvelopeSha256 !== envelopeSha256 ||
		!runId(value.source?.runId) || value.source.runAttempt !== source.runAttempt ||
		value.source.runId !== source.runId || value.source.commit !== source.commit ||
		!runId(value.priorCarrySource?.runId) || value.priorCarrySource.runId === source.runId ||
		!Number.isSafeInteger(value.priorCarrySource.runAttempt) ||
		value.priorCarrySource.runAttempt < 1 || !hex40(value.priorCarrySource.commit))
		refuse("terminal interruption binding is invalid");
	return { version: 1, kind: "host-verified-terminal-interruption",
		source: { ...value.source }, priorCarrySource: { ...value.priorCarrySource },
		priorCarryEnvelopeSha256: value.priorCarryEnvelopeSha256,
		resultArtifactId: value.resultArtifactId,
		resultArchiveSha256: value.resultArchiveSha256,
		accounting: "unquantified", effects: "unknown-unreconciled", terminationOrigin: "unknown" };
}

function interruptedSourceReviewBinding(value: ResumeIntent["interruptedSourceReview"],
	source: ResumeIntent["source"]): ResumeIntent["interruptedSourceReview"] {
	if (value === undefined) return undefined;
	if (Object.keys(value).sort().join("|") !== "receiptSha256|source|sourceTree" ||
		!hex64(value.receiptSha256) || !hex40(value.sourceTree) ||
		Object.keys(value.source ?? {}).sort().join("|") !== "commit|runAttempt|runId" ||
		value.source.runId !== source.runId ||
		value.source.runAttempt !== source.runAttempt ||
		value.source.commit !== source.commit)
		refuse("interrupted source review binding is invalid");
	return { source: { runId: value.source.runId, runAttempt: value.source.runAttempt,
		commit: value.source.commit }, sourceTree: value.sourceTree,
		receiptSha256: value.receiptSha256 };
}

function linkedUnknownDeliveryBinding(value: ResumeIntent["linkedUnknownDelivery"]):
	ResumeIntent["linkedUnknownDelivery"] {
	if (value === undefined) return undefined;
	if (Object.keys(value).sort().join("|") !== ["version", "kind", "oldJournalKey",
		"oldSourceReviewReceiptSha256",
		"oldControlCommit", "oldTestedSourceCommit", "oldTestedTree", "liveControlHead",
		"census", "ancestry", "newTestedSourceCommit", "newTestedTree", "newSuccessfulCi",
		"sourceRefTip", "accounting", "effects"].sort().join("|") ||
		value.version !== 1 || value.kind !== "host-verified-linked-unknown-delivery" ||
		!hex64(value.oldJournalKey) || !hex64(value.oldSourceReviewReceiptSha256) ||
		!hex40(value.oldControlCommit) ||
		!hex40(value.oldTestedSourceCommit) || !hex40(value.oldTestedTree) ||
		!hex40(value.liveControlHead) || value.liveControlHead !== value.oldControlCommit ||
		!hex40(value.newTestedSourceCommit) || !hex40(value.newTestedTree) ||
		value.newTestedSourceCommit === value.oldTestedSourceCommit ||
		value.sourceRefTip !== value.newTestedSourceCommit ||
		value.accounting !== "unquantified" || value.effects !== "unknown-unreconciled" ||
		Object.keys(value.census ?? {}).sort().join("|") !==
			"headCommit|kind|pagesRead|sha256|totalCount" ||
		value.census.kind !== "authenticated-complete-actions-run-census" ||
		value.census.headCommit !== value.oldControlCommit || value.census.totalCount !== 0 ||
		value.census.pagesRead !== 1 || !hex64(value.census.sha256) ||
		!Array.isArray(value.ancestry) || value.ancestry.length < 1 ||
		value.ancestry.some(row => Object.keys(row ?? {}).sort().join("|") !==
			"oldControlCommit|oldJournalKey" || !hex64(row.oldJournalKey) ||
			!hex40(row.oldControlCommit)) ||
		new Set(value.ancestry.map(row => row.oldJournalKey)).size !== value.ancestry.length ||
		new Set(value.ancestry.map(row => row.oldControlCommit)).size !== value.ancestry.length ||
		value.ancestry.at(-1)?.oldJournalKey !== value.oldJournalKey ||
		value.ancestry.at(-1)?.oldControlCommit !== value.oldControlCommit ||
		Object.keys(value.newSuccessfulCi ?? {}).sort().join("|") !==
			"conclusion|headCommit|runAttempt|runId|workflow" ||
		value.newSuccessfulCi.workflow !== "workflow-regression.yml" ||
		!runId(value.newSuccessfulCi.runId) || value.newSuccessfulCi.runAttempt !== 1 ||
		value.newSuccessfulCi.headCommit !== value.newTestedSourceCommit ||
		value.newSuccessfulCi.conclusion !== "success")
		refuse("invalid linked unknown-delivery binding");
	return { version: 1, kind: "host-verified-linked-unknown-delivery",
		oldJournalKey: value.oldJournalKey, oldControlCommit: value.oldControlCommit,
		oldSourceReviewReceiptSha256: value.oldSourceReviewReceiptSha256,
		oldTestedSourceCommit: value.oldTestedSourceCommit, oldTestedTree: value.oldTestedTree,
		liveControlHead: value.liveControlHead, census: { ...value.census },
		ancestry: value.ancestry.map(row => ({ ...row })),
		newTestedSourceCommit: value.newTestedSourceCommit,
		newTestedTree: value.newTestedTree, newSuccessfulCi: { ...value.newSuccessfulCi },
		sourceRefTip: value.sourceRefTip, accounting: "unquantified",
		effects: "unknown-unreconciled" };
}

function intentBinding(intent: ResumeIntent): ResumeJournalRecord["intentBinding"] {
	const actionProvenance = provenanceBinding(intent.actionProvenance);
	const workflowRepair = repairBinding(intent.workflowRepair);
	const terminalInterruption = interruptionBinding(intent.terminalInterruption,
		intent.source, intent.envelopeSha256);
	const interruptedSourceReview = interruptedSourceReviewBinding(intent.interruptedSourceReview,
		intent.source);
	const linkedUnknownDelivery = linkedUnknownDeliveryBinding(intent.linkedUnknownDelivery);
	if (Boolean(terminalInterruption) !== (actionProvenance?.kind === "current-host-interruption") ||
		Boolean(terminalInterruption) !== Boolean(interruptedSourceReview) ||
		terminalInterruption && actionProvenance?.kind === "current-host-interruption" &&
		terminalInterruption.resultArchiveSha256 !== actionProvenance.resultArchiveSha256)
		refuse("interruption action provenance is invalid");
	if (intent?.version !== 1 || intent.kind !== "fresh-independent-mission-resume" ||
		!runId(intent.source?.runId) || !Number.isSafeInteger(intent.source.runAttempt) ||
		intent.source.runAttempt < 1 || !hex40(intent.source.commit) ||
		!hex64(intent.idempotencyKey) || !hex64(intent.envelopeSha256) ||
		!hex64(intent.selectedTupleSha256) || !hex64(intent.pendingActionSha256) ||
		!intent.contractId || intent.boundary !== "new-isolated-workspace-no-prior-session-resume" ||
		pendingActionIdentity(intent.pendingAction) !== intent.pendingActionSha256 ||
		intent.pendingAction.kind !== intent.actionKind ||
		(intent.pendingAction.reasonCode === "workflow-repair-needed") !== Boolean(workflowRepair))
		refuse("invalid or changed private intent");
	const source = { runId: intent.source.runId, runAttempt: intent.source.runAttempt,
		commit: intent.source.commit };
	const expected = digest(canonical({ ...(actionProvenance ? { actionProvenance } : {}),
		source,
		envelopeSha256: intent.envelopeSha256, contractId: intent.contractId,
		selectedTupleSha256: intent.selectedTupleSha256,
		pendingActionSha256: intent.pendingActionSha256,
		...(terminalInterruption ? { terminalInterruption } : {}),
		...(interruptedSourceReview ? { interruptedSourceReview } : {}),
		...(workflowRepair ? { workflowRepair } : {}),
		...(linkedUnknownDelivery ? { linkedUnknownDelivery } : {}) }));
	// A linked request has a new identity even when its scientific action is unchanged.
	if (expected !== intent.idempotencyKey) refuse("idempotency key does not bind the intent");
	return { source, envelopeSha256: intent.envelopeSha256,
		contractId: intent.contractId, selectedTupleSha256: intent.selectedTupleSha256,
		pendingActionSha256: intent.pendingActionSha256, actionKind: intent.actionKind,
		...(actionProvenance ? { actionProvenance } : {}),
		...(terminalInterruption ? { terminalInterruption } : {}),
		...(interruptedSourceReview ? { interruptedSourceReview } : {}),
		...(workflowRepair ? { workflowRepair } : {}),
		...(linkedUnknownDelivery ? { linkedUnknownDelivery } : {}) };
}

function controlBinding(input: TestedControlBinding): TestedControlBinding {
	if (input?.controlRef !== CONTROL_REF || input.message !== REUSABLE_RUN_REQUEST_MESSAGE ||
		input.sourceRef !== SOURCE_REF || !hex40(input.testedSourceCommit) ||
		!hex40(input.testedTree) || input.sourceRefTip !== input.testedSourceCommit ||
		(input.previousControlCommit !== null && !hex40(input.previousControlCommit)) ||
		input.expectedBefore !== input.previousControlCommit ||
		!Array.isArray(input.parents) ||
		canonical(input.parents) !== canonical(input.previousControlCommit === null ||
			input.previousControlCommit === input.testedSourceCommit ?
			[input.testedSourceCommit] : [input.testedSourceCommit, input.previousControlCommit]) ||
		!input.successfulCi || !runId(input.successfulCi.runId) ||
		!Number.isSafeInteger(input.successfulCi.runAttempt) || input.successfulCi.runAttempt < 1 ||
		input.successfulCi.conclusion !== "success" ||
		input.successfulCi.workflow !== "workflow-regression.yml" ||
		input.successfulCi.headCommit !== input.testedSourceCommit)
		refuse("control descriptor does not bind a tested empty-tree request");
	return { controlRef: CONTROL_REF, message: REUSABLE_RUN_REQUEST_MESSAGE,
		testedSourceCommit: input.testedSourceCommit, testedTree: input.testedTree,
		successfulCi: { workflow: input.successfulCi.workflow, runId: input.successfulCi.runId,
			runAttempt: input.successfulCi.runAttempt,
			headCommit: input.successfulCi.headCommit, conclusion: "success" },
		previousControlCommit: input.previousControlCommit,
		parents: [...input.parents], expectedBefore: input.expectedBefore,
		sourceRef: SOURCE_REF, sourceRefTip: input.sourceRefTip };
}

function validProviderAvailabilityAudit(value: unknown,
	privateBinding: ResumeJournalRecord["intentBinding"],
	control: TestedControlBinding): value is ProviderAvailabilityAuditV1 {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const v = value as ProviderAvailabilityAuditV1;
	const keys = ["kind", "receiptSha256", "terminalSource", "terminalEnvelopeSha256",
		"testedSourceCommit", "probeSource", "workflowId", "jobId", "artifactId",
		"archiveSha256", "envelopeSha256"];
	const validSource = (s: typeof v.terminalSource) => s &&
		Object.keys(s).sort().join("|") === "commit|runAttempt|runId" &&
		runId(s.runId) && Number.isSafeInteger(s.runAttempt) && s.runAttempt > 0 && hex40(s.commit);
	return Object.keys(v).sort().join("|") === keys.sort().join("|") &&
		v.kind === "host-verified-provider-availability-audit" &&
		hex64(v.receiptSha256) && validSource(v.terminalSource) &&
		validSource(v.probeSource) && hex64(v.terminalEnvelopeSha256) &&
		hex40(v.testedSourceCommit) && runId(v.workflowId) && runId(v.jobId) &&
		runId(v.artifactId) && hex64(v.archiveSha256) && hex64(v.envelopeSha256) &&
		v.terminalSource.runId === privateBinding.source.runId &&
		v.terminalSource.runAttempt === privateBinding.source.runAttempt &&
		v.terminalSource.commit === privateBinding.source.commit &&
		v.terminalEnvelopeSha256 === privateBinding.envelopeSha256 &&
		v.testedSourceCommit === control.testedSourceCommit;
}

function providerAvailabilityAudit(proof: VerifiedProviderAvailabilityProofV1 | undefined,
	privateBinding: ResumeJournalRecord["intentBinding"],
	control: TestedControlBinding): ProviderAvailabilityAuditV1 | undefined {
	if (!proof) return;
	if (!isVerifiedProviderAvailabilityProof(proof))
		refuse("provider availability proof is not host verified");
	const audit: ProviderAvailabilityAuditV1 = {
		kind: "host-verified-provider-availability-audit",
		receiptSha256: proof.receiptSha256,
		terminalSource: { runId: proof.terminalSource.runId,
			runAttempt: proof.terminalSource.runAttempt, commit: proof.terminalSource.commit },
		terminalEnvelopeSha256: proof.terminalEnvelopeSha256,
		testedSourceCommit: proof.testedSourceCommit,
		probeSource: { runId: proof.probeSource.runId,
			runAttempt: proof.probeSource.runAttempt, commit: proof.probeSource.commit },
		workflowId: proof.workflowId, jobId: proof.jobId, artifactId: proof.artifactId,
		archiveSha256: proof.archiveSha256, envelopeSha256: proof.envelopeSha256 };
	if (!validProviderAvailabilityAudit(audit, privateBinding, control))
		refuse("provider availability proof does not bind the reserved intent");
	return audit;
}

async function syncDir(dir: string): Promise<void> {
	const handle = await open(dir, "r");
	try { await handle.sync(); } finally { await handle.close(); }
}

async function atomicJson(file: string, value: unknown): Promise<void> {
	const dir = path.dirname(file);
	const temp = path.join(dir, `.tmp-${randomUUID()}`);
	const handle = await open(temp, "wx", 0o600);
	try { await handle.writeFile(`${JSON.stringify(value)}\n`); await handle.sync(); }
	finally { await handle.close(); }
	try { await rename(temp, file); await syncDir(dir); }
	finally { await rm(temp, { force: true }); }
}

async function privateDirectory(dir: string): Promise<void> {
	if (!path.isAbsolute(dir)) refuse("private directory must be absolute");
	await mkdir(dir, { recursive: true, mode: 0o700 });
	const meta = await lstat(dir);
	if (!meta.isDirectory() || (meta.mode & 0o077) !== 0)
		refuse("private directory must be a non-symlink mode-0700 directory");
}

async function readRecord(file: string): Promise<ResumeJournalRecord> {
	const info = await lstat(file);
	if (!info.isFile() || (info.mode & 0o077) !== 0) refuse("record permissions are unsafe");
	const value = JSON.parse(await readFile(file, "utf8")) as ResumeJournalRecord;
	if (value?.version !== 1 || !hex64(value.idempotencyKey) ||
		path.basename(file) !== `${value.idempotencyKey}.json` ||
		!["reserved", "ref-update-attempted", "delivery-unknown", "acknowledged",
			"reconciled-not-delivered"].includes(value.state) || !value.intentBinding || !value.control ||
		!Number.isSafeInteger(value.negativeReconciliations) || value.negativeReconciliations < 0)
		refuse("stored record is invalid");
	if (canonical(controlBinding(value.control)) !== canonical(value.control))
		refuse("stored control descriptor has unexpected fields");
	const bound = value.intentBinding;
	if (value.providerAvailabilityAudit !== undefined &&
		!validProviderAvailabilityAudit(value.providerAvailabilityAudit, bound, value.control))
		refuse("stored provider availability audit is invalid");
	const workflowRepair = repairBinding(bound.workflowRepair);
	const terminalInterruption = interruptionBinding(bound.terminalInterruption,
		bound.source, bound.envelopeSha256);
	const interruptedSourceReview = interruptedSourceReviewBinding(bound.interruptedSourceReview,
		bound.source);
	const linkedUnknownDelivery = linkedUnknownDeliveryBinding(bound.linkedUnknownDelivery);
	if (workflowRepair && (workflowRepair.testedSourceCommit !== value.control.testedSourceCommit ||
		workflowRepair.testedTree !== value.control.testedTree ||
		canonical(workflowRepair.successfulCi) !== canonical(value.control.successfulCi)))
		refuse("stored workflow repair does not bind the tested control source");
	if (!runId(bound.source?.runId) || !Number.isSafeInteger(bound.source.runAttempt) ||
		bound.source.runAttempt < 1 || !hex40(bound.source.commit) ||
		!hex64(bound.envelopeSha256) || !hex64(bound.selectedTupleSha256) ||
		!hex64(bound.pendingActionSha256) || typeof bound.contractId !== "string" ||
		!bound.contractId || typeof bound.actionKind !== "string" || !bound.actionKind ||
		(bound.actionKind === "repair-workflow-state" && !workflowRepair) ||
		(Boolean(workflowRepair) && !["repair-workflow-state", "reconcile-m07-operation",
			"reconcile-m04-transaction"].includes(bound.actionKind)) ||
		(workflowRepair !== undefined && canonical(workflowRepair) !== canonical(bound.workflowRepair)) ||
		(bound.actionProvenance !== undefined &&
			canonical(provenanceBinding(bound.actionProvenance)) !== canonical(bound.actionProvenance)) ||
		Boolean(terminalInterruption) !==
			(bound.actionProvenance?.kind === "current-host-interruption") ||
		Boolean(terminalInterruption) !== Boolean(interruptedSourceReview) ||
		(interruptedSourceReview !== undefined &&
			canonical(interruptedSourceReview) !== canonical(bound.interruptedSourceReview)) ||
		(linkedUnknownDelivery !== undefined &&
			canonical(linkedUnknownDelivery) !== canonical(bound.linkedUnknownDelivery)) ||
		terminalInterruption && bound.actionProvenance?.kind === "current-host-interruption" &&
			terminalInterruption.resultArchiveSha256 !== bound.actionProvenance.resultArchiveSha256)
		refuse("stored private intent binding is invalid");
	const expected = digest(canonical({ ...(bound.actionProvenance ?
		{ actionProvenance: bound.actionProvenance } : {}), source: bound.source,
		envelopeSha256: bound.envelopeSha256, contractId: bound.contractId,
		selectedTupleSha256: bound.selectedTupleSha256,
		pendingActionSha256: bound.pendingActionSha256,
		...(terminalInterruption ? { terminalInterruption } : {}),
		...(interruptedSourceReview ? { interruptedSourceReview } : {}),
		...(workflowRepair ? { workflowRepair } : {}),
		...(linkedUnknownDelivery ? { linkedUnknownDelivery } : {}) }));
	if (expected !== value.idempotencyKey) refuse("stored idempotency binding changed");
	if (linkedUnknownDelivery &&
		(linkedUnknownDelivery.oldJournalKey === value.idempotencyKey ||
		linkedUnknownDelivery.newTestedSourceCommit !== value.control.testedSourceCommit ||
		linkedUnknownDelivery.newTestedTree !== value.control.testedTree ||
		canonical(linkedUnknownDelivery.newSuccessfulCi) !== canonical(value.control.successfulCi) ||
		linkedUnknownDelivery.liveControlHead !== value.control.expectedBefore ||
		linkedUnknownDelivery.sourceRefTip !== value.control.sourceRefTip))
		refuse("stored linked control binding changed");
	if (value.state === "acknowledged" ?
		!runId(value.successorRunId) || !hex40(value.observedControlCommit) ||
		value.observedControlCommit === value.control.expectedBefore :
		value.successorRunId !== undefined || value.observedControlCommit !== undefined)
		refuse("stored acknowledgment is invalid");
	if (value.carriedUnknownLineage !== undefined &&
		(value.state !== "acknowledged" || !linkedUnknownDelivery ||
		Object.keys(value.carriedUnknownLineage).sort().join("|") !==
			"ancestry|carrierControlCommit|carrierRunId|envelopeSha256|kind" ||
		value.carriedUnknownLineage.kind !== "host-authenticated-unknown-control-lineage" ||
		value.carriedUnknownLineage.carrierRunId !== value.successorRunId ||
		value.carriedUnknownLineage.carrierControlCommit !== value.observedControlCommit ||
		!hex64(value.carriedUnknownLineage.envelopeSha256) ||
		canonical(value.carriedUnknownLineage.ancestry) !== canonical(linkedUnknownDelivery.ancestry)))
		refuse("stored unknown-control carry is invalid");
	return value;
}

function expectedLinkedAncestry(records: readonly ResumeJournalRecord[],
	old: ResumeJournalRecord, oldSha: string):
	readonly Readonly<{ oldJournalKey: string; oldControlCommit: string }>[] {
	const backwards: Array<{ oldJournalKey: string; oldControlCommit: string }> = [];
	const seen = new Set<string>();
	let cursor: ResumeJournalRecord | undefined = old;
	let commit = oldSha;
	while (cursor) {
		if (seen.has(cursor.idempotencyKey)) refuse("linked ancestry has a cycle");
		seen.add(cursor.idempotencyKey);
		backwards.push({ oldJournalKey: cursor.idempotencyKey, oldControlCommit: commit });
		const previous: NonNullable<ResumeJournalRecord["intentBinding"]["linkedUnknownDelivery"]> |
			undefined = cursor.intentBinding.linkedUnknownDelivery;
		if (!previous) break;
		if (previous.liveControlHead !== cursor.control.expectedBefore ||
			previous.newTestedSourceCommit !== cursor.control.testedSourceCommit ||
			previous.newTestedTree !== cursor.control.testedTree ||
			canonical(previous.newSuccessfulCi) !== canonical(cursor.control.successfulCi))
			refuse("linked ancestry has an inconsistent control binding");
		commit = previous.oldControlCommit;
		cursor = records.find(record => record.idempotencyKey === previous.oldJournalKey);
		if (!cursor) refuse("linked ancestry is missing a predecessor");
	}
	const ancestry = backwards.reverse();
	for (let i = 1; i < ancestry.length; i++) {
		const descendant = records.find(record => record.idempotencyKey === ancestry[i]!.oldJournalKey)!;
		if (canonical(descendant.intentBinding.linkedUnknownDelivery?.ancestry) !==
			canonical(ancestry.slice(0, i)))
			refuse("linked ancestry changed across reservations");
	}
	return ancestry;
}

function supersededOldKeys(records: readonly ResumeJournalRecord[]): Set<string> {
	const keys = new Set<string>();
	for (const record of records) {
		const link = record.intentBinding.linkedUnknownDelivery;
		if (link && ["reserved", "ref-update-attempted", "delivery-unknown"].includes(record.state))
			for (const ancestor of link.ancestry) keys.add(ancestor.oldJournalKey);
		if (record.state === "acknowledged" && record.carriedUnknownLineage)
			for (const ancestor of record.carriedUnknownLineage.ancestry)
				keys.add(ancestor.oldJournalKey);
	}
	return keys;
}

/** Process-local writes are serialized by an exclusive directory lock. A dead
 * owner is identified by Linux boot ID and process birth time before recovery. */
export class MissionResumeJournal {
	readonly directory: string;
	constructor(directory: string) { this.directory = directory; }
	private file(key: string): string {
		if (!hex64(key)) refuse("invalid idempotency key");
		return path.join(this.directory, `${key}.json`);
	}
	private async owner(): Promise<{ host: string; pid: number; boot: string; start: string }> {
		const boot = (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
		const body = await readFile(`/proc/${process.pid}/stat`, "utf8");
		return { host: hostname(), pid: process.pid, boot,
			start: body.slice(body.lastIndexOf(") ") + 2).split(" ")[19] };
	}
	private async ownerAlive(owner: { host: string; pid: number; boot: string; start: string }): Promise<boolean> {
		if (!Number.isSafeInteger(owner.pid) || owner.pid < 1 || !owner.boot || !owner.start ||
			!owner.host)
			refuse("lock owner identity is invalid");
		if (owner.host !== hostname()) refuse("lock belongs to a different host");
		if ((await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim() !== owner.boot)
			return false;
		try {
			const body = await readFile(`/proc/${owner.pid}/stat`, "utf8");
			return body.slice(body.lastIndexOf(") ") + 2).split(" ")[19] === owner.start;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
			throw error;
		}
	}
	private async lock<T>(work: () => Promise<T>): Promise<T> {
		await privateDirectory(this.directory);
		const lock = path.join(this.directory, ".lock");
		for (;;) {
			const candidate = path.join(this.directory, `.lock-candidate-${randomUUID()}`);
			await mkdir(candidate, { mode: 0o700 });
			await atomicJson(path.join(candidate, "owner.json"), await this.owner());
			await syncDir(candidate);
			try { await rename(candidate, lock); }
			catch (error) {
				await rm(candidate, { recursive: true, force: true });
				if (!["EEXIST", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
				// Another process owns the lock. Inspect that owner below.
				let owner: { host: string; pid: number; boot: string; start: string };
				try { owner = JSON.parse(await readFile(path.join(lock, "owner.json"), "utf8")); }
				catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
					await new Promise(resolve => setTimeout(resolve, 20)); continue;
				}
				if (!(await this.ownerAlive(owner))) {
					const recovery = path.join(this.directory, ".lock-recovery");
					try { await mkdir(recovery, { mode: 0o700 }); }
					catch (error) {
						if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
						await new Promise(resolve => setTimeout(resolve, 20)); continue;
					}
					try {
						const current = JSON.parse(await readFile(path.join(lock, "owner.json"), "utf8"));
						if (canonical(current) === canonical(owner) && !(await this.ownerAlive(current))) {
							await rm(lock, { recursive: true }); await syncDir(this.directory);
						}
					} catch (error) {
						if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
					} finally { await rm(recovery, { recursive: true }); }
				}
				await new Promise(resolve => setTimeout(resolve, 20));
				continue;
			}
			await syncDir(this.directory);
			try { return await work(); }
			finally { await rm(lock, { recursive: true }); await syncDir(this.directory); }
		}
	}
	private async records(): Promise<ResumeJournalRecord[]> {
		const names = await readdir(this.directory);
		return Promise.all(names.filter(name => /^[a-f0-9]{64}\.json$/.test(name))
			.map(name => readRecord(path.join(this.directory, name))));
	}
	async get(key: string): Promise<ResumeJournalRecord | undefined> {
		return this.lock(async () => {
			try { return await readRecord(this.file(key)); }
			catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
		});
	}
	async unresolvedForRef(ref: string): Promise<ResumeJournalRecord | undefined> {
		return this.lock(async () => {
			const records = await this.records();
			const linkedOldKeys = supersededOldKeys(records);
			return records.find(record =>
			record.control.controlRef === ref && record.state !== "acknowledged" &&
			record.state !== "reconciled-not-delivered" &&
			!linkedOldKeys.has(record.idempotencyKey));
		});
	}
	async linkedSuccessorFor(oldKey: string): Promise<ResumeJournalRecord | undefined> {
		if (!hex64(oldKey)) refuse("invalid old journal key");
		return this.lock(async () => {
			const matches = (await this.records()).filter(record =>
				record.intentBinding.linkedUnknownDelivery?.oldJournalKey === oldKey);
			if (matches.length > 1) refuse("old request has multiple linked successors");
			return matches[0];
		});
	}
	async acknowledgedLinkedCarrier(run: { runId: string; commit: string }):
		Promise<ResumeJournalRecord | undefined> {
		if (!runId(run.runId) || !hex40(run.commit)) refuse("invalid carrier query");
		return this.lock(async () => {
			const matches = (await this.records()).filter(record =>
				record.state === "acknowledged" && Boolean(record.intentBinding.linkedUnknownDelivery) &&
				record.successorRunId === run.runId && record.observedControlCommit === run.commit);
			if (matches.length > 1) refuse("multiple linked carriers match one run");
			return matches[0];
		});
	}
	async ancestryForAcceptedUnknown(oldKey: string, oldControlCommit: string):
		Promise<readonly Readonly<{ oldJournalKey: string; oldControlCommit: string }>[]> {
		if (!hex64(oldKey) || !hex40(oldControlCommit)) refuse("invalid linked ancestry query");
		return this.lock(async () => {
			const records = await this.records();
			const old = records.find(record => record.idempotencyKey === oldKey);
			if (!old) return refuse("linked predecessor is not an uncertain attempt");
			if (!["ref-update-attempted", "delivery-unknown"].includes(old.state))
				refuse("linked predecessor is not an uncertain attempt");
			return expectedLinkedAncestry(records, old, oldControlCommit);
		});
	}
	/** Only an authenticated terminal carry for the acknowledged linked request
	 * releases the ancestry's dispatch block. It never settles their effects. */
	async markUnknownLineageCarried(carrierKey: string,
		carry: AuthenticatedTerminalCarryResult): Promise<ResumeJournalRecord> {
		return this.lock(async () => {
			const records = await this.records();
			const carrier = records.find(record => record.idempotencyKey === carrierKey);
			const lineage = carrier?.intentBinding.linkedUnknownDelivery?.ancestry;
			const rows = authenticatedTerminalUnknownControlDeliveries(carry.proof, carry.privateBundle);
			if (!carrier || !lineage || !rows)
				return refuse("authenticated carry does not seal the exact unknown-control lineage");
			if (carrier.state !== "acknowledged" ||
				carry.proof.source.runId !== carrier.successorRunId ||
				carry.proof.source.commit !== carrier.observedControlCommit ||
				rows.length < lineage.length ||
				new Set(rows.map(row => row.controlCommit)).size !== rows.length ||
				rows.some(row => row.observedRunsAtAdmission !== 0 ||
					row.effects !== "unknown-unreconciled" || row.accounting !== "unquantified") ||
				lineage.some((ancestor, i) => {
					const row = rows[rows.length - lineage.length + i];
					const historical = records.find(record =>
						record.idempotencyKey === ancestor.oldJournalKey);
					return !row || !historical || historical.state !== "delivery-unknown" ||
						row.controlCommit !== ancestor.oldControlCommit ||
						row.testedSourceCommit !== historical.control.testedSourceCommit ||
						row.testedSourceTree !== historical.control.testedTree ||
						row.previousControlParent !== historical.control.previousControlCommit ||
						row.admittedBy.runId !== carry.proof.source.runId ||
						row.admittedBy.runAttempt !== carry.proof.source.runAttempt ||
						row.admittedBy.commit !== carry.proof.source.commit ||
						row.observedRunsAtAdmission !== 0 ||
						row.effects !== "unknown-unreconciled" || row.accounting !== "unquantified";
				})) refuse("authenticated carry does not seal the exact unknown-control lineage");
			const receipt: NonNullable<ResumeJournalRecord["carriedUnknownLineage"]> = {
				kind: "host-authenticated-unknown-control-lineage",
				carrierRunId: carry.proof.source.runId,
				carrierControlCommit: carry.proof.source.commit,
				envelopeSha256: carry.proof.envelopeSha256,
				ancestry: lineage.map(row => ({ ...row })) };
			if (carrier.carriedUnknownLineage) {
				if (canonical(carrier.carriedUnknownLineage) !== canonical(receipt))
					refuse("conflicting authenticated unknown-control carry");
				return carrier;
			}
			const updated = { ...carrier, carriedUnknownLineage: receipt };
			await atomicJson(this.file(carrierKey), updated);
			return updated;
		});
	}
	async reserve(intent: ResumeIntent, binding: TestedControlBinding,
		providerAvailabilityProof?: VerifiedProviderAvailabilityProofV1): Promise<ResumeJournalRecord> {
		const privateBinding = intentBinding(intent), control = controlBinding(binding);
		const availabilityAudit = providerAvailabilityAudit(providerAvailabilityProof,
			privateBinding, control);
		if (privateBinding.workflowRepair &&
			(privateBinding.workflowRepair.testedSourceCommit !== control.testedSourceCommit ||
				privateBinding.workflowRepair.testedTree !== control.testedTree ||
				canonical(privateBinding.workflowRepair.successfulCi) !== canonical(control.successfulCi)))
			refuse("workflow repair does not bind the tested control source");
		return this.lock(async () => {
			const records = await this.records();
			const old = records.find(record => record.idempotencyKey === intent.idempotencyKey);
			if (old) {
				if (canonical(old.intentBinding) !== canonical(privateBinding) ||
					canonical(old.control) !== canonical(control)) refuse("same key has a different binding");
				if (canonical(old.providerAvailabilityAudit ?? null) !==
					canonical(availabilityAudit ?? null) &&
					(!old.providerAvailabilityAudit || !availabilityAudit))
					refuse("same key has a different provider availability audit");
				// A fresh positive recheck may supersede an expired probe for the
				// same intent. Its existing state still controls delivery. Keep the
				// first receipt for durable audit.
				return old;
			}
			const linked = privateBinding.linkedUnknownDelivery;
			let oldLinked: ResumeJournalRecord | undefined;
			if (linked) {
				oldLinked = records.find(record => record.idempotencyKey === linked.oldJournalKey);
				if (!oldLinked || !["ref-update-attempted", "delivery-unknown"].includes(oldLinked.state) ||
					oldLinked.control.controlRef !== control.controlRef ||
					oldLinked.control.expectedBefore === linked.oldControlCommit ||
					oldLinked.control.testedSourceCommit !== linked.oldTestedSourceCommit ||
					oldLinked.control.testedTree !== linked.oldTestedTree ||
					control.expectedBefore !== linked.oldControlCommit ||
					control.testedSourceCommit !== linked.newTestedSourceCommit ||
					control.testedTree !== linked.newTestedTree ||
					canonical(control.successfulCi) !== canonical(linked.newSuccessfulCi) ||
					control.sourceRefTip !== linked.sourceRefTip ||
					control.successfulCi.runId === oldLinked.control.successfulCi.runId ||
					canonical(linked.ancestry) !==
						canonical(expectedLinkedAncestry(records, oldLinked, linked.oldControlCommit)) ||
					["source", "envelopeSha256", "contractId", "selectedTupleSha256",
						"pendingActionSha256", "actionKind", "actionProvenance",
						"terminalInterruption", "interruptedSourceReview"].some(field =>
						canonical((privateBinding as unknown as Record<string, unknown>)[field] ?? null) !==
						canonical((oldLinked!.intentBinding as unknown as Record<string, unknown>)[field] ?? null)))
					refuse("linked request does not bind the old uncertain attempt");
			}
			const superseded = supersededOldKeys(records);
			if (records.some(record => record.control.controlRef === control.controlRef &&
				record.state !== "acknowledged" && record.state !== "reconciled-not-delivered" &&
				record.idempotencyKey !== oldLinked?.idempotencyKey &&
				!superseded.has(record.idempotencyKey)))
				refuse("control ref has an unresolved reservation");
			if (oldLinked && records.some(record =>
				record.intentBinding.linkedUnknownDelivery?.oldJournalKey === oldLinked.idempotencyKey))
				refuse("old request already has a linked successor");
			const acknowledged = records.filter(record => record.control.controlRef === control.controlRef &&
				record.state === "acknowledged");
			if (acknowledged.length) {
				const tips = acknowledged.filter(record => !acknowledged.some(next =>
					next.control.previousControlCommit === record.observedControlCommit));
				if (tips.length !== 1 ||
					(oldLinked?.control.previousControlCommit ?? control.previousControlCommit) !==
						tips[0]!.observedControlCommit)
					refuse("control ref does not continue the acknowledged tip");
			}
			const fresh: ResumeJournalRecord = { version: 1,
				idempotencyKey: intent.idempotencyKey, intentBinding: privateBinding,
				control, state: "reserved", negativeReconciliations: 0,
				...(availabilityAudit ? { providerAvailabilityAudit: availabilityAudit } : {}) };
			if (oldLinked?.state === "ref-update-attempted")
				await atomicJson(this.file(oldLinked.idempotencyKey),
					{ ...oldLinked, state: "delivery-unknown" });
			await atomicJson(this.file(intent.idempotencyKey), fresh);
			return fresh;
		});
	}
	private async transition(key: string, update: (old: ResumeJournalRecord,
		records: readonly ResumeJournalRecord[]) => ResumeJournalRecord): Promise<ResumeJournalRecord> {
		return this.lock(async () => {
			const old = await readRecord(this.file(key));
			const next = update(old, await this.records());
			if (next !== old) await atomicJson(this.file(key), next);
			return next;
		});
	}
	/** Persist this before sending a ref update. A restarted adapter must treat
	 * this state as delivery-unknown, and must never invoke the update again. */
	markAttempted(key: string): Promise<ResumeJournalRecord> {
		return this.transition(key, old => old.state === "reserved" ?
			{ ...old, state: "ref-update-attempted" } :
			refuse("ref update cannot be reissued from this state"));
	}
	markDeliveryUnknown(key: string): Promise<ResumeJournalRecord> {
		return this.transition(key, old => old.state === "ref-update-attempted" ?
			{ ...old, state: "delivery-unknown" } : old.state === "delivery-unknown" ? old :
			refuse("unknown delivery requires an attempted ref update"));
	}
	/** The caller must independently verify the live control ref and run. */
	acknowledge(key: string, observed: AcceptedControlObservation): Promise<ResumeJournalRecord> {
		return this.transition(key, (old, records) => {
			if (records.some(record =>
				record.intentBinding.linkedUnknownDelivery?.oldJournalKey === key))
				refuse("a linked old request remains delivery-unknown");
			if (old.state === "acknowledged") {
				if (old.successorRunId === observed.successorRunId &&
					old.observedControlCommit === observed.controlCommit) return old;
				return refuse("conflicting acknowledgment");
			}
			if (old.state !== "ref-update-attempted" && old.state !== "delivery-unknown")
				refuse("acknowledgment has no attempted ref update");
			if (observed.kind !== "read-only-accepted-control" ||
				observed.controlRef !== old.control.controlRef || !hex40(observed.controlCommit) ||
				observed.controlCommit === old.control.expectedBefore ||
				observed.tree !== old.control.testedTree ||
				canonical(observed.parents) !== canonical(old.control.parents) ||
				observed.message !== old.control.message || !runId(observed.successorRunId) ||
				observed.successorRunId === old.intentBinding.source.runId)
				refuse("read-only acknowledgment does not match the control request");
			return { ...old, state: "acknowledged", successorRunId: observed.successorRunId,
				observedControlCommit: observed.controlCommit };
		});
	}
	/** A negative read-only reconciliation can release an uncertain attempt.
	 * The host verifier must prove pending delivery is excluded. */
	reconcileNotDelivered(key: string, observed: NotDeliveredObservation): Promise<ResumeJournalRecord> {
		return this.transition(key, (old, records) => {
			if (records.some(record =>
				record.intentBinding.linkedUnknownDelivery?.oldJournalKey === key))
				refuse("a linked old request remains delivery-unknown");
			if (old.state === "reconciled-not-delivered") return old;
			if (old.state === "acknowledged") refuse("an acknowledged request cannot be negated");
			if (observed.kind !== "read-only-not-delivered" ||
				observed.controlRef !== old.control.controlRef ||
				observed.observedHead !== old.control.expectedBefore ||
				observed.matchingRunCount !== 0 || observed.pendingDeliveryExcluded !== true)
				refuse("negative reconciliation does not exclude delivery");
			return { ...old, state: "reconciled-not-delivered",
				negativeReconciliations: old.negativeReconciliations + 1 };
		});
	}
	/** Re-arm only the exact original request after a durable negative read-only
	 * reconciliation. A different intent may have acquired the ref meanwhile. */
	async rearmAfterReconciliation(key: string): Promise<ResumeJournalRecord> {
		return this.lock(async () => {
			const old = await readRecord(this.file(key));
			if ((await this.records()).some(record =>
				record.intentBinding.linkedUnknownDelivery?.oldJournalKey === key))
				refuse("a linked old request cannot be rearmed");
			if (old.state !== "reconciled-not-delivered" || old.negativeReconciliations < 1)
				refuse("request has no negative reconciliation");
			const records = await this.records();
			if (records.some(record => record.idempotencyKey !== key &&
				record.control.controlRef === old.control.controlRef &&
				record.state !== "acknowledged" && record.state !== "reconciled-not-delivered"))
				refuse("control ref has another unresolved reservation");
			const acknowledged = records.filter(record => record.control.controlRef === old.control.controlRef &&
				record.state === "acknowledged");
			if (acknowledged.length) {
				const tips = acknowledged.filter(record => !acknowledged.some(next =>
					next.control.previousControlCommit === record.observedControlCommit));
				if (tips.length !== 1 || tips[0]!.observedControlCommit !== old.control.previousControlCommit)
					refuse("control ref tip changed after reconciliation");
			}
			const next: ResumeJournalRecord = { ...old, state: "reserved" };
			await atomicJson(this.file(key), next);
			return next;
		});
	}
}
