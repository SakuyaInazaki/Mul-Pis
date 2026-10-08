/**
 * Read-only host preparation for an explicit, reusable mission run request.
 * The only public output is an empty-tree control commit descriptor. A caller
 * with an authorized GitHub transport performs the ref mutation separately.
 */
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { classifyPendingAction, type PendingActionV1 } from "../m07/objective-progress.ts";
import { authenticateLatestTerminalCarry, authenticateLatestTerminalInterruption,
	authenticatedSupervisorProjection, authenticatedTerminalInterruptionSupervisorProjection,
	authenticatedIncrementalPrefixBindsPriorBundle,
	authenticatedTerminalInterruptionBindsPriorBundle,
	isAuthenticatedIncrementalPrefixObservation, isAuthenticatedTerminalInterruptionProof,
	REUSABLE_RUN_REQUEST_MESSAGE, type CarryArtifactPayload,
	type AuthenticatedTerminalCarryProof, type CurrentMissionRun,
	type IncrementalPrefixFailure } from "./ledger-continuation.ts";
import { MissionResumeJournal, type ResumeJournalRecord,
	type TestedControlBinding } from "./mission-resume-journal.ts";
import { pendingActionIdentity, planMissionContinuation, type CurrentDerivedActionV1,
	type CurrentInterruptionActionV1, type TerminalInterruptionEvidenceV1,
	type FreshIndependentLaunchContractV1, type ResumeDispatchRecord,
	type TerminalPrefixInterruptionEvidenceV1,
	type SupervisorDecision, type TerminalCarryEvidenceV1, type MissionStatusV1,
	type LinkedUnknownDeliveryV1 } from "./mission-supervisor.ts";
import { validWorkflowRepairState, type WorkflowRepairStateV1 } from "./repair-liveness.ts";
import { readReviewedInterruptedSourceCapability,
	type VerifiedInterruptedSourceCapabilityV1 } from "./interrupted-source-review.ts";
import { readReviewedTerminalPrefixSourceCapability,
	type VerifiedTerminalPrefixSourceCapabilityV1 } from "./terminal-prefix-source-review.ts";
import { readReviewedResultOnlyRepairState, isVerifiedResultOnlyRepairState,
	type VerifiedResultOnlyRepairStateV1 } from "./result-only-repair-review.ts";
import { isVerifiedUnobservedControlSourceCapability,
	readReviewedUnobservedControlSourceCapability } from "./unobserved-control-source-review.ts";
import { ProviderAvailabilityProofError, verifyProviderAvailabilityProof,
	type VerifiedProviderAvailabilityProofV1 } from
	"./provider-availability-proof.ts";

const REPOSITORY = "SakuyaInazaki/Mul-Pis";
const SOURCE_BRANCH = "improve/workflow-learning-reliability";
const CONTROL_BRANCH = "run-requests/workflow-learning-reliability";
const CONTROL_REF = `refs/heads/${CONTROL_BRANCH}` as const;
const SOURCE_REF = `refs/heads/${SOURCE_BRANCH}` as const;
const hex40 = (value: unknown): value is string =>
	typeof value === "string" && /^[0-9a-f]{40}$/.test(value);
export type HostPreparationRefusal = Readonly<{
	code: "source-ci-pending" | "source-ci-completed-without-success" |
		"source-ci-run-absent" | "source-ci-status-unrecognized" |
		"live-github-read-failed" | "live-github-response-invalid" |
		"github-read-credential-unavailable" | "tested-source-ref-invalid" |
		"tested-source-tree-invalid" | "source-ci-list-invalid" |
		"control-ref-unavailable" | "control-ref-uninitialized" |
		"terminal-carry-projection-unavailable" |
		"interruption-source-review-invalid" |
		"terminal-prefix-source-review-invalid" |
		"legacy-action-checkpoint-unavailable" | "control-request-delivery-uncertain" |
		"workflow-repair-plan-invalid" | "workflow-repair-plan-unrelated" |
		"workflow-repair-plan-stale" | "workflow-repair-source-unchanged" |
		"workflow-repair-review-evidence-invalid" |
		"result-only-repair-review-invalid" | "result-only-repair-result-unavailable" |
		"reserved-descriptor-recovery-requires-journal" | "reserved-descriptor-missing" |
		"linked-unknown-delivery-invalid" | "linked-unknown-delivery-observed-run" |
		"linked-unknown-delivery-census-invalid" | "linked-unknown-delivery-source-raced" |
		"linked-unknown-delivery-control-raced" | "linked-unknown-source-review-invalid" |
		"provider-availability-review-invalid" | "provider-availability-review-unrelated";
	stage: "tested-source-ci" | "live-source-ref" | "live-source-commit" |
		"live-control-ref" | "terminal-carry" | "legacy-action" | "dispatch-journal" |
		"workflow-repair-plan" | "interruption-source-review" | "result-only-repair-review" |
		"terminal-prefix-source-review" |
		"linked-unknown-delivery" | "provider-availability-review";
	ciRunId?: string;
	ciStatus?: "requested" | "waiting" | "pending" | "queued" | "in_progress" |
		"completed" | "unrecognized";
	ciConclusion?: "success" | "failure" | "cancelled" | "timed_out" | "skipped" |
		"neutral" | "action_required" | "unrecognized" | null;
	httpStatus?: number;
	/** Static private cause from the balance-proof verifier; no provider body or URL. */
	providerAvailabilityCause?: ProviderAvailabilityProofError["code"];
	providerAvailabilityCheck?: ProviderAvailabilityProofError["check"];
}>;
export class MissionHostPreparationError extends Error {
	readonly refusal: HostPreparationRefusal;
	constructor(refusal: HostPreparationRefusal) {
		super(`mission host adapter refused: ${refusal.code}`);
		this.refusal = refusal;
	}
}
function refuse(code: HostPreparationRefusal["code"],
	stage: HostPreparationRefusal["stage"], httpStatus?: number): never {
	throw new MissionHostPreparationError({ code, stage,
		...(httpStatus === undefined ? {} : { httpStatus }) });
}
function observedCi(row: Record<string, unknown> | undefined):
	Omit<HostPreparationRefusal, "code" | "stage"> {
	if (!row) return {};
	const statuses = ["requested", "waiting", "pending", "queued", "in_progress",
		"completed"] as const;
	const conclusions = ["success", "failure", "cancelled", "timed_out", "skipped",
		"neutral", "action_required"] as const;
	return { ciRunId: String(row.id),
		ciStatus: statuses.find(value => value === row.status) ?? "unrecognized",
		ciConclusion: row.conclusion === null || row.conclusion === undefined ? null :
			conclusions.find(value => value === row.conclusion) ?? "unrecognized" };
}
const isObject = (value: unknown): value is Record<string, unknown> =>
	Boolean(value) && typeof value === "object" && !Array.isArray(value);
const sha = (value: string): string => createHash("sha256").update(value).digest("hex");
const hex64 = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
const exact = (value: unknown, keys: readonly string[]): value is Record<string, unknown> =>
	isObject(value) && Object.keys(value).sort().join("|") === [...keys].sort().join("|");
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const underRepo = (file: string): boolean => {
	const relative = path.relative(repoRoot, file);
	return relative === "" || relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};

/** A private operator review, not a model verdict or a scientific acceptance.
 * References point at actual code and offline regressions in the tested source.
 * No source-file hash manifest or public task payload is introduced. */
export type HostReviewedWorkflowRepairPlanV1 = Readonly<{
	version: 1; kind: "host-reviewed-workflow-repair-plan";
	prior: Readonly<{ source: TerminalCarryEvidenceV1["source"]; sourceTree: string;
		envelopeSha256: string; checkpointSha256: string; contractId: string;
		selectedTupleSha256: string; pendingActionSha256: string }>;
	repair: Readonly<{ stateSha256: string; state: WorkflowRepairStateV1 }>;
	replacement: Readonly<{ testedSourceCommit: string; testedTree: string;
		successfulCi: TestedControlBinding["successfulCi"] }>;
	review: Readonly<{ kind: "operator-code-review";
		strategyClass: "evidence-read-handoff" | "fresh-context-handoff" | "controller-repair-state";
		codeEvidenceRefs: readonly Readonly<{ path: string; symbol: string }>[];
		offlineTests: Readonly<{ command: "npm run typecheck && npm test"; conclusion: "passed";
			sourceCommit: string; tree: string;
			testEvidenceRefs: readonly Readonly<{ path: string; name: string }>[] }> }>;
	boundary: "new-isolated-workspace-no-prior-session-resume";
}>;
declare const verifiedWorkflowRepairPlan: unique symbol;
export type VerifiedWorkflowRepairPlanV1 = HostReviewedWorkflowRepairPlanV1 &
	Readonly<{ [verifiedWorkflowRepairPlan]: true }>;
const verifiedWorkflowRepairPlans = new WeakSet<object>();
/** JSON, structured clones and objects authored by a model cannot mint this brand. */
export function isVerifiedWorkflowRepairPlan(value: unknown): value is VerifiedWorkflowRepairPlanV1 {
	return isObject(value) && verifiedWorkflowRepairPlans.has(value);
}

function validRepairPlan(value: unknown): value is HostReviewedWorkflowRepairPlanV1 {
	if (!exact(value, ["version", "kind", "prior", "repair", "replacement", "review", "boundary"]) ||
		value.version !== 1 || value.kind !== "host-reviewed-workflow-repair-plan" ||
		value.boundary !== "new-isolated-workspace-no-prior-session-resume") return false;
	const { prior, repair, replacement, review } = value;
	if (!exact(prior, ["source", "sourceTree", "envelopeSha256", "checkpointSha256", "contractId",
		"selectedTupleSha256", "pendingActionSha256"]) ||
		!exact(prior.source, ["runId", "runAttempt", "commit"]) ||
		typeof prior.source.runId !== "string" || !/^[1-9][0-9]{0,17}$/.test(prior.source.runId) ||
		!Number.isSafeInteger(prior.source.runAttempt) || Number(prior.source.runAttempt) < 1 ||
		!hex40(prior.source.commit) || !hex40(prior.sourceTree) ||
		!hex64(prior.envelopeSha256) || !hex64(prior.checkpointSha256) ||
		typeof prior.contractId !== "string" || prior.contractId.length < 1 || prior.contractId.length > 256 ||
		!hex64(prior.selectedTupleSha256) || !hex64(prior.pendingActionSha256) ||
		!exact(repair, ["stateSha256", "state"]) || !hex64(repair.stateSha256) ||
		!validWorkflowRepairState(repair.state) || repair.state.strategy !== "workflow-repair-needed" ||
		!exact(replacement, ["testedSourceCommit", "testedTree", "successfulCi"]) ||
		!hex40(replacement.testedSourceCommit) || !hex40(replacement.testedTree) ||
		!exact(replacement.successfulCi, ["workflow", "runId", "runAttempt", "headCommit", "conclusion"]) ||
		replacement.successfulCi.workflow !== "workflow-regression.yml" ||
		typeof replacement.successfulCi.runId !== "string" ||
		!/^[1-9][0-9]{0,17}$/.test(replacement.successfulCi.runId) ||
		replacement.successfulCi.runAttempt !== 1 || replacement.successfulCi.conclusion !== "success" ||
		replacement.successfulCi.headCommit !== replacement.testedSourceCommit ||
		!exact(review, ["kind", "strategyClass", "codeEvidenceRefs", "offlineTests"]) ||
		review.kind !== "operator-code-review" ||
		!["evidence-read-handoff", "fresh-context-handoff", "controller-repair-state"].includes(String(review.strategyClass)))
		return false;
	const codeRefs = review.codeEvidenceRefs;
	const tests = review.offlineTests;
	return Array.isArray(codeRefs) && codeRefs.length > 0 &&
		codeRefs.every(row => exact(row, ["path", "symbol"]) && typeof row.path === "string" &&
			/^src\/(?:runner|stages|m07)\/[A-Za-z0-9_-]+\.ts$/.test(row.path) &&
			typeof row.symbol === "string" && /^[A-Za-z_$][A-Za-z0-9_$.]{0,119}$/.test(row.symbol)) &&
		exact(tests, ["command", "conclusion", "sourceCommit", "tree", "testEvidenceRefs"]) &&
		tests.command === "npm run typecheck && npm test" && tests.conclusion === "passed" &&
		tests.sourceCommit === replacement.testedSourceCommit && tests.tree === replacement.testedTree &&
		Array.isArray(tests.testEvidenceRefs) && tests.testEvidenceRefs.length > 0 &&
		tests.testEvidenceRefs.every(row => exact(row, ["path", "name"]) && typeof row.path === "string" &&
			/^test\/[A-Za-z0-9_-]+\.test\.ts$/.test(row.path) && typeof row.name === "string" &&
			row.name.length > 0 && row.name.length <= 200 && !/[\r\n\0]/.test(row.name));
}

async function readPrivateRepairPlan(file: string): Promise<HostReviewedWorkflowRepairPlanV1> {
	if (!path.isAbsolute(file) || underRepo(file) || underRepo(await realpath(file)))
		refuse("workflow-repair-plan-invalid", "workflow-repair-plan");
	const handle = await open(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
	try {
		const meta = await handle.stat();
		if (!meta.isFile() || (meta.mode & 0o777) !== 0o600 || meta.size < 1 || meta.size > 64 * 1024)
			refuse("workflow-repair-plan-invalid", "workflow-repair-plan");
		const bytes = await handle.readFile();
		if (bytes.length !== meta.size) refuse("workflow-repair-plan-invalid", "workflow-repair-plan");
		let value: unknown;
		try { value = JSON.parse(bytes.toString("utf8")) as unknown; }
		catch { return refuse("workflow-repair-plan-invalid", "workflow-repair-plan"); }
		if (!validRepairPlan(value)) refuse("workflow-repair-plan-invalid", "workflow-repair-plan");
		return value;
	} finally { await handle.close(); }
}

export type PublicResumeRequestDescriptor = Readonly<{
	ref: typeof CONTROL_REF;
	message: typeof REUSABLE_RUN_REQUEST_MESSAGE;
	tree: string;
	parents: readonly string[];
	sourceCommit: string;
	previousControlCommit: string;
	expectedBefore: string;
}>;

export type PreparedResumeRequest = Readonly<{
	decision: SupervisorDecision;
	descriptor?: PublicResumeRequestDescriptor;
	journalKey?: string;
	journalState?: ResumeJournalRecord["state"];
	/** Private, nonauthoritative explanation of a discarded partial observation. */
	incrementalPrefixFailure?: IncrementalPrefixFailure;
}>;

export type PrepareAuthenticatedResumeInput = Readonly<{
	/** Reissue only a descriptor whose identical private intent is still reserved.
	 * The caller must durably markAttempted before any control-ref write. */
	recoverReservedDescriptor?: true;
	source: CurrentMissionRun;
	seedEnvelopeB64: string | undefined;
	publicKeyFile: string;
	githubToken: string | undefined;
	loadCarryArtifact: (identity: { runId: string; artifactId: string }) => Promise<CarryArtifactPayload>;
	/** Existing read-only connector, exact result artifact and live ZIP digest. */
	loadResultEnvelope?: (identity: { runId: string; artifactId: string;
		expectedArchiveSha256: string }) => Promise<Uint8Array>;
	request?: typeof fetch;
	authenticatedHostRead?: Readonly<{ kind: "authenticated-host-github-read"; request: typeof fetch }>;
	expectedSpkiSha256?: string;
	journal: MissionResumeJournal;
	/** Authenticate and plan without creating a local reservation or external request. */
	readOnly?: boolean;
	/** An explicit private operator review outside the checkout, never model output. */
	repairPlanPrivateFile?: string;
	/** Private operator RSA decryption review for a result-only repair diagnostic. */
	resultOnlyRepairReviewPrivateFile?: string;
	/** Mode-0600 operator review of the separate encrypted balance verdict. */
	providerAvailabilityReceiptPrivateFile?: string;
	loadProviderAvailabilityEnvelope?: (identity: { runId: string; artifactId: string;
		expectedArchiveSha256: string }) => Promise<Uint8Array>;
	/** Host review of the exact interrupted source capability, outside the checkout. */
	interruptedSourceReviewPrivateFile?: string;
	/** Private operator review of the exact resultless terminal source and prefix. */
	terminalPrefixSourceReviewPrivateFile?: string;
	/** Explicit exact commit of an accepted old ref update with no observed Actions run.
	 * This requests a distinct, linked fresh intent after authenticated host review. */
	linkedUnknownDeliveryOldControlCommit?: string;
	/** Private mode-0600 operator review of confinement in the old tested source. */
	unobservedControlSourceReviewPrivateFile?: string;
}>;

async function githubJson(url: string, token: string | undefined, request: typeof fetch,
	stage: HostPreparationRefusal["stage"]): Promise<unknown> {
const response = await request(url, { method: "GET", redirect: "error", headers: {
		...(token ? { Authorization: `Bearer ${token}` } : {}),
		Accept: "application/vnd.github+json",
		"X-GitHub-Api-Version": "2022-11-28" } });
	if (!response.ok) refuse("live-github-read-failed", stage, response.status);
	const body = await response.text();
	try { return JSON.parse(body) as unknown; }
	catch { return refuse("live-github-response-invalid", stage, response.status); }
}

/** The same source/CI/control-ref facts checked again by the existing Actions
 * preflight. This function is read-only and never claims a prior run's source
 * is the currently tested source. */
export async function readLiveTestedControlBinding(token: string | undefined,
	request: typeof fetch = fetch, authenticatedHostRead = false): Promise<TestedControlBinding> {
	if ((!token && !authenticatedHostRead) || (token?.length ?? 0) > 4_000)
		refuse("github-read-credential-unavailable", "live-source-ref");
	const base = `https://api.github.com/repos/${REPOSITORY}`;
	const source = await githubJson(`${base}/git/ref/heads/${SOURCE_BRANCH}`, token, request, "live-source-ref");
	const sourceCommit = isObject(source) && isObject(source.object) ? source.object.sha : undefined;
	if (!hex40(sourceCommit)) refuse("tested-source-ref-invalid", "live-source-ref");
	const commit = await githubJson(`${base}/git/commits/${sourceCommit}`, token, request, "live-source-commit");
	const tree = isObject(commit) && commit.sha === sourceCommit && isObject(commit.tree) ? commit.tree.sha : undefined;
	if (!hex40(tree)) refuse("tested-source-tree-invalid", "live-source-commit");
	const ci = await githubJson(`${base}/actions/workflows/workflow-regression.yml/runs?head_sha=${sourceCommit}&per_page=100`,
		token, request, "tested-source-ci");
	const rows = isObject(ci) ? ci.workflow_runs : undefined;
	if (!Array.isArray(rows) || rows.length > 100) refuse("source-ci-list-invalid", "tested-source-ci");
	const matching = rows.filter(row => isObject(row) &&
		Number.isSafeInteger(row.id) && Number(row.id) > 0 &&
		row.head_sha === sourceCommit && row.head_branch === SOURCE_BRANCH &&
		row.event === "push" && row.run_attempt === 1) as Record<string, unknown>[];
	const accepted = matching.find(row => row.status === "completed" && row.conclusion === "success");
	if (!accepted) {
		const newest = (candidates: Record<string, unknown>[]) =>
			candidates.reduce<Record<string, unknown> | undefined>((latest, row) =>
				!latest || Number(row.id) > Number(latest.id) ? row : latest, undefined);
		const pending = newest(matching.filter(row => ["requested", "waiting", "pending",
			"queued", "in_progress"].includes(String(row.status))));
		const completed = newest(matching.filter(row => row.status === "completed"));
		const observed = pending ?? completed ?? newest(matching);
		const code: HostPreparationRefusal["code"] = pending ? "source-ci-pending" :
			completed ? "source-ci-completed-without-success" :
			matching.length ? "source-ci-status-unrecognized" : "source-ci-run-absent";
		throw new MissionHostPreparationError({ code, stage: "tested-source-ci",
			...observedCi(observed) });
	}
	const control = await githubJson(`${base}/git/ref/heads/${CONTROL_BRANCH}`, token, request, "live-control-ref");
	const previous = isObject(control) && isObject(control.object) ? control.object.sha : undefined;
	if (!hex40(previous)) refuse("control-ref-unavailable", "live-control-ref");
	const parents = previous === sourceCommit ? [sourceCommit] : [sourceCommit, previous];
	return { controlRef: CONTROL_REF, message: REUSABLE_RUN_REQUEST_MESSAGE,
		testedSourceCommit: sourceCommit, testedTree: tree,
		successfulCi: { workflow: "workflow-regression.yml", runId: String(accepted.id),
			runAttempt: 1, headCommit: sourceCommit, conclusion: "success" },
		previousControlCommit: previous, parents, expectedBefore: previous,
		sourceRef: SOURCE_REF, sourceRefTip: sourceCommit };
}

const verifiedLinkedUnknownDeliveries = new WeakSet<object>();
/** A process-local host review. Persisted JSON cannot mint this capability. */
export function isVerifiedLinkedUnknownDelivery(value: unknown): value is LinkedUnknownDeliveryV1 {
	return isObject(value) && verifiedLinkedUnknownDeliveries.has(value);
}

async function verifyLinkedUnknownDelivery(input: PrepareAuthenticatedResumeInput,
	binding: TestedControlBinding, old: ResumeJournalRecord): Promise<LinkedUnknownDeliveryV1> {
	const oldSha = input.linkedUnknownDeliveryOldControlCommit;
	if (!hex40(oldSha) || !input.unobservedControlSourceReviewPrivateFile ||
		!["ref-update-attempted", "delivery-unknown"].includes(old.state) ||
		binding.previousControlCommit !== oldSha || old.control.expectedBefore === oldSha ||
		binding.testedSourceCommit === old.control.testedSourceCommit ||
		binding.successfulCi.runId === old.control.successfulCi.runId)
		refuse("linked-unknown-delivery-invalid", "linked-unknown-delivery");
	const request = input.authenticatedHostRead?.request ?? input.request ?? fetch;
	const base = `https://api.github.com/repos/${REPOSITORY}`;
	const oldCommit = await githubJson(`${base}/git/commits/${oldSha}`, input.githubToken,
		request, "linked-unknown-delivery");
	if (!isObject(oldCommit) || oldCommit.sha !== oldSha ||
		!isObject(oldCommit.tree) || oldCommit.tree.sha !== old.control.testedTree ||
		oldCommit.message !== old.control.message || !Array.isArray(oldCommit.parents) ||
		JSON.stringify(oldCommit.parents.map(row => isObject(row) ? row.sha : null)) !==
			JSON.stringify(old.control.parents))
		refuse("linked-unknown-delivery-invalid", "linked-unknown-delivery");
	let sourceReview;
	try {
		sourceReview = await readReviewedUnobservedControlSourceCapability({
			privateReceiptFile: input.unobservedControlSourceReviewPrivateFile,
			oldJournalKey: old.idempotencyKey,
			oldAcceptedControl: { commit: oldSha, tree: old.control.testedTree,
				parents: [...old.control.parents] },
			oldTestedSource: { commit: old.control.testedSourceCommit,
				tree: old.control.testedTree },
			priorCarrySource: old.intentBinding.source,
			priorCarryEnvelopeSha256: old.intentBinding.envelopeSha256,
			readImmutableSourceTree: async commit => {
				const result = await githubJson(`${base}/git/commits/${commit}`,
					input.githubToken, request, "linked-unknown-delivery");
				if (!isObject(result) || result.sha !== commit || !isObject(result.tree) ||
					!hex40(result.tree.sha)) throw new Error("invalid immutable source tree");
				return result.tree.sha;
			},
			readImmutableSourceFile: async (commit, file) => Buffer.from(
				await reviewedSourceText(file, commit, input), "utf8") });
	} catch {
		refuse("linked-unknown-source-review-invalid", "linked-unknown-delivery");
	}
	if (!isVerifiedUnobservedControlSourceCapability(sourceReview) ||
		sourceReview.oldJournalKey !== old.idempotencyKey ||
		sourceReview.oldAcceptedControl.commit !== oldSha)
		refuse("linked-unknown-source-review-invalid", "linked-unknown-delivery");
	// An exact-SHA query with zero returned rows is a complete one-page census at
	// this observation. It does not prove future delivery or old effects absent.
	const census = await githubJson(`${base}/actions/runs?head_sha=${oldSha}&per_page=100&page=1`,
		input.githubToken, request, "linked-unknown-delivery");
	if (!isObject(census) || !Number.isSafeInteger(census.total_count) ||
		Number(census.total_count) < 0 || !Array.isArray(census.workflow_runs))
		refuse("linked-unknown-delivery-census-invalid", "linked-unknown-delivery");
	if (census.total_count !== 0 || census.workflow_runs.length !== 0)
		refuse("linked-unknown-delivery-observed-run", "linked-unknown-delivery");
	const fenced = await readLiveTestedControlBinding(input.githubToken, request,
		input.authenticatedHostRead?.kind === "authenticated-host-github-read");
	if (fenced.sourceRefTip !== binding.sourceRefTip ||
		fenced.testedTree !== binding.testedTree ||
		JSON.stringify(fenced.successfulCi) !== JSON.stringify(binding.successfulCi))
		refuse("linked-unknown-delivery-source-raced", "linked-unknown-delivery");
	if (fenced.previousControlCommit !== binding.previousControlCommit)
		refuse("linked-unknown-delivery-control-raced", "linked-unknown-delivery");
	const finalSource = await githubJson(`${base}/git/ref/heads/${SOURCE_BRANCH}`,
		input.githubToken, request, "linked-unknown-delivery");
	if (!isObject(finalSource) || !isObject(finalSource.object) ||
		finalSource.object.sha !== binding.sourceRefTip)
		refuse("linked-unknown-delivery-source-raced", "linked-unknown-delivery");
	const ancestry = await input.journal.ancestryForAcceptedUnknown(old.idempotencyKey, oldSha);
	const review: LinkedUnknownDeliveryV1 = {
		version: 1, kind: "host-verified-linked-unknown-delivery",
		oldJournalKey: old.idempotencyKey, oldControlCommit: oldSha,
		oldSourceReviewReceiptSha256: sourceReview.receiptSha256,
		oldTestedSourceCommit: old.control.testedSourceCommit,
		oldTestedTree: old.control.testedTree,
		liveControlHead: binding.previousControlCommit!,
		census: { kind: "authenticated-complete-actions-run-census",
			headCommit: oldSha, totalCount: 0, pagesRead: 1,
			sha256: sha(JSON.stringify(census)) },
		ancestry,
		newTestedSourceCommit: binding.testedSourceCommit,
		newTestedTree: binding.testedTree, newSuccessfulCi: { ...binding.successfulCi },
		sourceRefTip: fenced.sourceRefTip,
		accounting: "unquantified", effects: "unknown-unreconciled" };
	freezeReview(review);
	verifiedLinkedUnknownDeliveries.add(review);
	return review;
}

function publicDescriptor(binding: TestedControlBinding): PublicResumeRequestDescriptor {
	if (!binding.previousControlCommit) refuse("control-ref-uninitialized", "live-control-ref");
	return { ref: binding.controlRef, message: binding.message,
		tree: binding.testedTree, parents: [...binding.parents],
		sourceCommit: binding.testedSourceCommit,
		previousControlCommit: binding.previousControlCommit,
		expectedBefore: binding.expectedBefore! };
}

function dispatchRecord(record: ResumeJournalRecord | undefined): ResumeDispatchRecord {
	if (!record) return { state: "not-requested" };
	if (record.state === "reserved") return { state: "reserved", idempotencyKey: record.idempotencyKey };
	if (record.state === "acknowledged") return { state: "acknowledged",
		idempotencyKey: record.idempotencyKey, successorRunId: record.successorRunId! };
	return { state: "delivery-unknown", idempotencyKey: record.idempotencyKey };
}

async function reviewedSourceText(file: string, commit: string,
	input: PrepareAuthenticatedResumeInput, allowMissing = false,
	stage: HostPreparationRefusal["stage"] = "workflow-repair-plan"): Promise<string> {
	const request = input.authenticatedHostRead?.request ?? input.request ?? fetch;
	let row: unknown;
	try {
		row = await githubJson(`https://api.github.com/repos/${REPOSITORY}/contents/${file}?ref=${commit}`,
			input.githubToken, request, stage);
	} catch (error) {
		if (allowMissing && error instanceof MissionHostPreparationError && error.refusal.httpStatus === 404) return "";
		throw error;
	}
	if (!isObject(row) || row.type !== "file" || row.path !== file || row.encoding !== "base64" ||
		typeof row.content !== "string" || row.content.length > 2 * 1024 * 1024 ||
		!Number.isSafeInteger(row.size) || Number(row.size) < 1 || Number(row.size) > 1024 * 1024)
		refuse(stage === "interruption-source-review" ? "interruption-source-review-invalid" :
			"workflow-repair-review-evidence-invalid", stage);
	const encoded = row.content.replace(/\n/g, "");
	const bytes = Buffer.from(encoded, "base64");
	const text = bytes.toString("utf8");
	if (bytes.toString("base64") !== encoded || bytes.length !== row.size ||
		Buffer.byteLength(text, "utf8") !== bytes.length)
		refuse(stage === "interruption-source-review" ? "interruption-source-review-invalid" :
			"workflow-repair-review-evidence-invalid", stage);
	return text;
}

function freezeReview(value: unknown): void {
	if (value && typeof value === "object") {
		for (const child of Object.values(value)) freezeReview(child);
		Object.freeze(value);
	}
}

async function verifyWorkflowRepairPlan(input: PrepareAuthenticatedResumeInput,
	terminalCarry: TerminalCarryEvidenceV1, binding: TestedControlBinding,
	repairStateBytes: string | undefined,
	action: PendingActionV1,
	resultOnlyRepair?: VerifiedResultOnlyRepairStateV1): Promise<VerifiedWorkflowRepairPlanV1> {
	let plan: HostReviewedWorkflowRepairPlanV1;
	try { plan = await readPrivateRepairPlan(input.repairPlanPrivateFile!); }
	catch (error) {
		if (error instanceof MissionHostPreparationError) throw error;
		return refuse("workflow-repair-plan-invalid", "workflow-repair-plan");
	}
	let state: unknown;
	try { state = JSON.parse(repairStateBytes ?? "null") as unknown; }
	catch { return refuse("workflow-repair-plan-stale", "workflow-repair-plan"); }
	if (resultOnlyRepair && (!isVerifiedResultOnlyRepairState(resultOnlyRepair) ||
		resultOnlyRepair.stateBytes !== repairStateBytes))
		refuse("result-only-repair-review-invalid", "result-only-repair-review");
	const prior = plan.prior;
	if (!validWorkflowRepairState(state) || state.strategy !== "workflow-repair-needed" ||
		action.reasonCode !== "workflow-repair-needed" || action.failedStage !== state.stage ||
		!action.evidenceRefs?.includes("repair-state.json") ||
		!repairStateBytes || plan.repair.stateSha256 !== sha(repairStateBytes) ||
		Object.entries(state).some(([key, value]) =>
			(plan.repair.state as unknown as Record<string, unknown>)[key] !== value) ||
		prior.source.runId !== terminalCarry.source.runId ||
		prior.source.runAttempt !== terminalCarry.source.runAttempt ||
		prior.source.commit !== terminalCarry.source.commit ||
		prior.envelopeSha256 !== terminalCarry.envelopeSha256 ||
		prior.checkpointSha256 !== terminalCarry.checkpointSha256 ||
		prior.contractId !== terminalCarry.contractId ||
		prior.selectedTupleSha256 !== terminalCarry.selectedTupleSha256 ||
		prior.pendingActionSha256 !== terminalCarry.pendingActionSha256 ||
		plan.replacement.testedSourceCommit !== binding.testedSourceCommit ||
		plan.replacement.testedTree !== binding.testedTree ||
		Object.entries(binding.successfulCi).some(([key, value]) =>
			(plan.replacement.successfulCi as unknown as Record<string, unknown>)[key] !== value))
		refuse("workflow-repair-plan-stale", "workflow-repair-plan");
	const oldCommit = await githubJson(`https://api.github.com/repos/${REPOSITORY}/git/commits/${prior.source.commit}`,
		input.githubToken, input.authenticatedHostRead?.request ?? input.request ?? fetch, "workflow-repair-plan");
	if (!isObject(oldCommit) || oldCommit.sha !== prior.source.commit || !isObject(oldCommit.tree) ||
		!hex40(oldCommit.tree.sha) || prior.sourceTree !== oldCommit.tree.sha)
		refuse("workflow-repair-plan-stale", "workflow-repair-plan");
	if (binding.testedSourceCommit === prior.source.commit || binding.testedTree === prior.sourceTree)
		refuse("workflow-repair-source-unchanged", "workflow-repair-plan");
	const m04 = state.stage === "m04-judgment";
	const stageFailures = m04 ? ["unread-m07-evidence", "malformed-proposal", "rejected-draft",
		"context-handoff-unavailable", "provider-context-full"] :
		["unread-evidence", "invalid-assessment", "blocked-with-capability", "unsupported-next-task",
			"context-handoff-unavailable", "provider-context-full"];
	const relevantSource = (file: string): boolean => file === "src/runner/repair-liveness.ts" ||
		file === (m04 ? "src/stages/m04.ts" : "src/m07/objective-progress.ts");
	const relevantTest = (file: string): boolean => file === "test/repair-liveness.test.ts" ||
		(m04 ? /^(?:test\/m04-[A-Za-z0-9_-]+|test\/private-m04-transaction)\.test\.ts$/.test(file) :
			file === "test/m07-objective-progress.test.ts");
	if (!stageFailures.includes(state.failure) ||
		(plan.review.strategyClass === "evidence-read-handoff" &&
			!["unread-evidence", "unread-m07-evidence", "context-handoff-unavailable"].includes(state.failure)) ||
		!plan.review.codeEvidenceRefs.some(evidence => relevantSource(evidence.path)) ||
		!plan.review.offlineTests.testEvidenceRefs.some(evidence => relevantTest(evidence.path)))
		refuse("workflow-repair-review-evidence-invalid", "workflow-repair-plan");
	// Check cited source bodies and test references directly. The operator owns
	// the semantic review; changed bytes and passing CI are not scientific proof.
	let changedSourceEvidence = false;
	for (const evidence of plan.review.codeEvidenceRefs) {
		const next = await reviewedSourceText(evidence.path, binding.testedSourceCommit, input);
		const old = await reviewedSourceText(evidence.path, prior.source.commit, input, true);
		if (!next.includes(evidence.symbol))
			refuse("workflow-repair-review-evidence-invalid", "workflow-repair-plan");
		if (next !== old && relevantSource(evidence.path)) changedSourceEvidence = true;
	}
	if (!changedSourceEvidence) refuse("workflow-repair-source-unchanged", "workflow-repair-plan");
	for (const evidence of plan.review.offlineTests.testEvidenceRefs) {
		const text = await reviewedSourceText(evidence.path, binding.testedSourceCommit, input);
		if (!text.includes(`test(${JSON.stringify(evidence.name)}`) &&
			!text.includes(`test('${evidence.name.replace(/'/g, "\\'")}'`))
			refuse("workflow-repair-review-evidence-invalid", "workflow-repair-plan");
	}
	freezeReview(plan);
	verifiedWorkflowRepairPlans.add(plan);
	return plan as VerifiedWorkflowRepairPlanV1;
}

/** Live authentication comes first. Legacy actions are classified NOW from the
 * authenticated checkpoint and remain labelled as current host decisions. */
export async function prepareAuthenticatedResumeRequest(input: PrepareAuthenticatedResumeInput):
	Promise<PreparedResumeRequest> {
	if (input.readOnly && input.recoverReservedDescriptor)
		refuse("reserved-descriptor-recovery-requires-journal", "dispatch-journal");
	if (Boolean(input.linkedUnknownDeliveryOldControlCommit) !==
		Boolean(input.unobservedControlSourceReviewPrivateFile))
		refuse("linked-unknown-source-review-invalid", "linked-unknown-delivery");
	const authenticationInput = {
		source: input.source, seedEnvelopeB64: input.seedEnvelopeB64,
		publicKeyFile: input.publicKeyFile, githubToken: input.githubToken,
		loadCarryArtifact: input.loadCarryArtifact, request: input.request,
		authenticatedHostRead: input.authenticatedHostRead,
		expectedSpkiSha256: input.expectedSpkiSha256 };
	let status: MissionStatusV1;
	let terminalCarry: TerminalCarryEvidenceV1;
	let pendingAction: PendingActionV1 | undefined;
	let terminalInterruption: TerminalInterruptionEvidenceV1 | undefined;
	let terminalPrefixInterruption: TerminalPrefixInterruptionEvidenceV1 | undefined;
	let currentInterruptionAction: CurrentInterruptionActionV1 | undefined;
	let currentPrefixInterruptionAction: import("./mission-supervisor.ts").CurrentPrefixInterruptionActionV1 | undefined;
	let incrementalPrefixFailure: IncrementalPrefixFailure | undefined;
	let priorPrivateBundle: Readonly<Record<string, string>>;
	let terminalProof: AuthenticatedTerminalCarryProof | undefined;
	let authenticatedTerminalCarry: Awaited<ReturnType<typeof authenticateLatestTerminalCarry>> | undefined;
	try {
		const authenticated = await authenticateLatestTerminalCarry(authenticationInput);
		const projected = authenticatedSupervisorProjection(authenticated.proof, authenticated.privateBundle);
		if (!projected) refuse("terminal-carry-projection-unavailable", "terminal-carry");
		({ status, terminalCarry, pendingAction } = projected);
		priorPrivateBundle = authenticated.privateBundle;
		terminalProof = authenticated.proof;
		authenticatedTerminalCarry = authenticated;
	} catch (carryError) {
		let interrupted: Awaited<ReturnType<typeof authenticateLatestTerminalInterruption>>;
		try { interrupted = await authenticateLatestTerminalInterruption(authenticationInput); }
		catch (interruptionError) {
			throw new AggregateError([carryError, interruptionError],
				"terminal carry and interruption authentication both failed");
		}
		const projected = authenticatedTerminalInterruptionSupervisorProjection(
			interrupted.proof, interrupted.priorPrivateBundle);
		if (!projected) refuse("terminal-carry-projection-unavailable", "terminal-carry");
		incrementalPrefixFailure = interrupted.incrementalPrefixFailure;
		status = projected.status;
		pendingAction = undefined;
		priorPrivateBundle = interrupted.priorPrivateBundle;
		const priorAction = projected.pendingAction;
		terminalCarry = { version: 1, kind: "host-verified-terminal-carry",
			source: { runId: projected.priorSource.runId,
				runAttempt: projected.priorSource.runAttempt,
				commit: projected.priorSource.commit },
			envelopeSha256: projected.priorEnvelopeSha256,
			contractId: status.contractId, selectedTupleSha256: status.selectedTupleSha256,
			pendingActionSha256: priorAction ? pendingActionIdentity(priorAction) : null,
			checkpointSha256: projected.checkpointSha256,
			terminal: { runStatus: "completed", jobStatus: "completed",
				providerStepStatus: "completed" } };
		const gap = interrupted.proof.gap;
		if (gap.kind === "opaque-prefix-backed-executed-run-gap") {
			const observation = interrupted.incrementalPrefixObservation;
			if (!isAuthenticatedTerminalInterruptionProof(interrupted.proof) ||
				!authenticatedTerminalInterruptionBindsPriorBundle(interrupted.proof,
					interrupted.priorPrivateBundle) ||
				!observation || !isAuthenticatedIncrementalPrefixObservation(observation) ||
				!authenticatedIncrementalPrefixBindsPriorBundle(observation,
					interrupted.priorPrivateBundle) ||
				observation.source.runId !== gap.source.runId ||
				observation.source.runAttempt !== gap.source.runAttempt ||
				observation.source.commit !== gap.source.commit ||
				observation.artifact.artifactId !== gap.prefixArtifact.artifactId ||
				observation.artifact.archiveSha256 !== gap.prefixArtifact.archiveSha256 ||
				observation.sequence !== gap.prefixSequence ||
				observation.priorCarryEnvelopeSha256 !== terminalCarry.envelopeSha256)
				refuse("terminal-carry-projection-unavailable", "terminal-carry");
			terminalPrefixInterruption = { version: 1,
				kind: "host-verified-terminal-prefix-interruption",
				source: { runId: gap.source.runId, runAttempt: gap.source.runAttempt,
					commit: gap.source.commit }, priorCarrySource: terminalCarry.source,
				priorCarryEnvelopeSha256: gap.priorCarryEnvelopeSha256,
				prefixArtifactId: gap.prefixArtifact.artifactId,
				prefixArchiveSha256: gap.prefixArtifact.archiveSha256,
				prefixSha256: observation.prefixSha256, prefixSequence: observation.sequence,
				terminal: structuredClone(gap.terminal), accounting: "unquantified",
				effects: "unknown-unreconciled", terminationOrigin: "unknown" };
			currentPrefixInterruptionAction = { version: 1,
				kind: "current-host-prefix-interruption-action",
				source: terminalPrefixInterruption.source,
				priorCarryEnvelopeSha256: terminalCarry.envelopeSha256,
				priorCheckpointSha256: projected.checkpointSha256,
				prefixArchiveSha256: terminalPrefixInterruption.prefixArchiveSha256,
				prefixSha256: terminalPrefixInterruption.prefixSha256,
				prefixSequence: terminalPrefixInterruption.prefixSequence,
				action: classifyPendingAction("execution-interrupted",
					{ unresolvedOperationRefs: [...status.unresolvedOperationRefs] }) };
		} else {
			terminalInterruption = { version: 1, kind: "host-verified-terminal-interruption",
				source: { runId: gap.source.runId, runAttempt: gap.source.runAttempt,
					commit: gap.source.commit }, priorCarrySource: terminalCarry.source,
				priorCarryEnvelopeSha256: gap.priorCarryEnvelopeSha256,
				resultArtifactId: gap.resultArtifact.artifactId,
				resultArchiveSha256: gap.resultArtifact.archiveSha256,
				accounting: "unquantified", effects: "unknown-unreconciled",
				terminationOrigin: "unknown" };
			currentInterruptionAction = { version: 1, kind: "current-host-interruption-action",
				source: terminalInterruption.source,
				priorCarryEnvelopeSha256: terminalCarry.envelopeSha256,
				priorCheckpointSha256: projected.checkpointSha256,
				resultArchiveSha256: terminalInterruption.resultArchiveSha256,
				action: classifyPendingAction("execution-interrupted",
					{ unresolvedOperationRefs: [...status.unresolvedOperationRefs] }) };
		}
	}
	if (authenticatedTerminalCarry && !input.readOnly) {
		let journalExists = false;
		try { await lstat(input.journal.directory); journalExists = true; }
		catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		if (journalExists) {
			const carrier = await input.journal.acknowledgedLinkedCarrier({
				runId: authenticatedTerminalCarry.proof.source.runId,
				commit: authenticatedTerminalCarry.proof.source.commit });
			if (carrier && !carrier.carriedUnknownLineage)
				await input.journal.markUnknownLineageCarried(carrier.idempotencyKey,
					authenticatedTerminalCarry);
		}
	}
	const privateObservation = incrementalPrefixFailure ? { incrementalPrefixFailure } : {};
	const anyInterruption = Boolean(terminalInterruption || terminalPrefixInterruption);
	let currentDerivedAction: CurrentDerivedActionV1 | undefined;
	if (!anyInterruption && !pendingAction && status.objectiveOutcome === "incomplete" &&
		status.stopReason === "bounded-run-incomplete" && status.unresolvedOperationRefs.length &&
		terminalCarry.pendingActionSha256 === null) {
		const checkpoint = priorPrivateBundle["objective-checkpoint.json"];
		if (typeof checkpoint !== "string" ||
			terminalCarry.checkpointSha256 !== sha(checkpoint))
			refuse("legacy-action-checkpoint-unavailable", "legacy-action");
		currentDerivedAction = { version: 1, kind: "current-host-derived-action",
			source: terminalCarry.source, envelopeSha256: terminalCarry.envelopeSha256,
			selectedTupleSha256: status.selectedTupleSha256,
			checkpointSha256: terminalCarry.checkpointSha256,
			action: classifyPendingAction("bounded-run-incomplete",
				{ unresolvedOperationRefs: [...status.unresolvedOperationRefs] }) };
	}
	const action = currentInterruptionAction?.action ??
		currentPrefixInterruptionAction?.action ?? pendingAction ?? currentDerivedAction?.action;
	const workflowRepair = !anyInterruption && status.stopReason === "workflow-repair-needed" &&
		action?.reasonCode === "workflow-repair-needed";
	if (input.repairPlanPrivateFile !== undefined && !workflowRepair)
		refuse("workflow-repair-plan-unrelated", "workflow-repair-plan");
	if (input.resultOnlyRepairReviewPrivateFile !== undefined &&
		(!workflowRepair || priorPrivateBundle["repair-state.json"] !== undefined || !terminalProof))
		refuse("result-only-repair-review-invalid", "result-only-repair-review");
	if (input.interruptedSourceReviewPrivateFile !== undefined && !terminalInterruption)
		refuse("interruption-source-review-invalid", "interruption-source-review");
	if (input.terminalPrefixSourceReviewPrivateFile !== undefined && !terminalPrefixInterruption)
		refuse("terminal-prefix-source-review-invalid", "terminal-prefix-source-review");
	if (input.providerAvailabilityReceiptPrivateFile !== undefined &&
		(!status.providerPaymentHold || anyInterruption || !terminalProof ||
			!input.loadProviderAvailabilityEnvelope))
		refuse("provider-availability-review-unrelated", "provider-availability-review");
	if (status.providerPaymentHold && !input.providerAvailabilityReceiptPrivateFile)
		return { decision: planMissionContinuation({ status, terminalCarry, pendingAction,
			terminalInterruption, currentInterruptionAction,
			terminalPrefixInterruption, currentPrefixInterruptionAction,
			dispatchRecord: { state: "not-requested" } }), ...privateObservation };
	if (!action) return { decision: planMissionContinuation({ status, terminalCarry,
		pendingAction, terminalInterruption, currentInterruptionAction,
		terminalPrefixInterruption, currentPrefixInterruptionAction,
		dispatchRecord: { state: "not-requested" } }), ...privateObservation };
	if (terminalInterruption && input.interruptedSourceReviewPrivateFile === undefined)
		return { decision: planMissionContinuation({ status, terminalCarry,
			pendingAction, terminalInterruption, currentInterruptionAction,
			dispatchRecord: { state: "not-requested" } }), ...privateObservation };
	if (terminalPrefixInterruption && input.terminalPrefixSourceReviewPrivateFile === undefined)
		return { decision: planMissionContinuation({ status, terminalCarry,
			pendingAction, terminalPrefixInterruption, currentPrefixInterruptionAction,
			dispatchRecord: { state: "not-requested" } }), ...privateObservation };
	if (workflowRepair && (input.repairPlanPrivateFile === undefined ||
		(priorPrivateBundle["repair-state.json"] === undefined &&
			input.resultOnlyRepairReviewPrivateFile === undefined)))
		return { decision: planMissionContinuation({ status, terminalCarry,
			pendingAction, terminalInterruption, currentInterruptionAction,
			terminalPrefixInterruption, currentPrefixInterruptionAction,
			dispatchRecord: { state: "not-requested" } }), ...privateObservation };
	const binding = await readLiveTestedControlBinding(input.githubToken,
		input.authenticatedHostRead?.request ?? input.request,
		input.authenticatedHostRead?.kind === "authenticated-host-github-read");
	let interruptedSourceReview: VerifiedInterruptedSourceCapabilityV1 | undefined;
	let terminalPrefixSourceReview: VerifiedTerminalPrefixSourceCapabilityV1 | undefined;
	if (terminalInterruption) {
		const oldCommit = await githubJson(`https://api.github.com/repos/${REPOSITORY}/git/commits/${terminalInterruption.source.commit}`,
			input.githubToken, input.authenticatedHostRead?.request ?? input.request ?? fetch,
			"interruption-source-review");
		if (!isObject(oldCommit) || oldCommit.sha !== terminalInterruption.source.commit ||
			!isObject(oldCommit.tree) || !hex40(oldCommit.tree.sha))
			refuse("interruption-source-review-invalid", "interruption-source-review");
		try {
			interruptedSourceReview = await readReviewedInterruptedSourceCapability({
				privateReceiptFile: input.interruptedSourceReviewPrivateFile!,
				interruption: terminalInterruption,
				interruptedSourceTree: oldCommit.tree.sha,
				priorCheckpointSha256: terminalCarry.checkpointSha256!,
				readImmutableSourceFile: async (commit, file) => Buffer.from(
					await reviewedSourceText(file, commit, input, false,
						"interruption-source-review"), "utf8") });
		} catch {
			refuse("interruption-source-review-invalid", "interruption-source-review");
		}
	}
	if (terminalPrefixInterruption) {
		const oldCommit = await githubJson(`https://api.github.com/repos/${REPOSITORY}/git/commits/${terminalPrefixInterruption.source.commit}`,
			input.githubToken, input.authenticatedHostRead?.request ?? input.request ?? fetch,
			"terminal-prefix-source-review");
		if (!isObject(oldCommit) || oldCommit.sha !== terminalPrefixInterruption.source.commit ||
			!isObject(oldCommit.tree) || !hex40(oldCommit.tree.sha))
			refuse("terminal-prefix-source-review-invalid", "terminal-prefix-source-review");
		try {
			terminalPrefixSourceReview = await readReviewedTerminalPrefixSourceCapability({
				privateReceiptFile: input.terminalPrefixSourceReviewPrivateFile!,
				interruption: terminalPrefixInterruption,
				interruptedSourceTree: oldCommit.tree.sha,
				priorCheckpointSha256: terminalCarry.checkpointSha256!,
				readImmutableSourceFile: async (commit, file) => Buffer.from(
					await reviewedSourceText(file, commit, input, false,
						"terminal-prefix-source-review"), "utf8") });
		} catch {
			refuse("terminal-prefix-source-review-invalid", "terminal-prefix-source-review");
		}
	}
	let resultOnlyRepair: VerifiedResultOnlyRepairStateV1 | undefined;
	if (workflowRepair && input.resultOnlyRepairReviewPrivateFile) {
		const artifact = terminalProof?.resultArtifact;
		if (!terminalProof || !artifact || !input.loadResultEnvelope)
			refuse("result-only-repair-result-unavailable", "result-only-repair-review");
		const oldCommit = await githubJson(`https://api.github.com/repos/${REPOSITORY}/git/commits/${terminalCarry.source.commit}`,
			input.githubToken, input.authenticatedHostRead?.request ?? input.request ?? fetch,
			"result-only-repair-review");
		if (!isObject(oldCommit) || oldCommit.sha !== terminalCarry.source.commit ||
			!isObject(oldCommit.tree) || !hex40(oldCommit.tree.sha))
			refuse("result-only-repair-review-invalid", "result-only-repair-review");
		if (input.source.event !== "workflow_dispatch" && input.source.event !== "push")
			refuse("result-only-repair-review-invalid", "result-only-repair-review");
		try {
			const encryptedEnvelopeBytes = await input.loadResultEnvelope({
				runId: artifact.runId, artifactId: artifact.artifactId,
				expectedArchiveSha256: artifact.archiveSha256 });
			resultOnlyRepair = await readReviewedResultOnlyRepairState({
				privateReceiptFile: input.resultOnlyRepairReviewPrivateFile,
				terminalProof, privateBundle: priorPrivateBundle,
				terminalSourceTree: oldCommit.tree.sha, terminalEvent: input.source.event,
				encryptedEnvelopeBytes });
		} catch {
			refuse("result-only-repair-review-invalid", "result-only-repair-review");
		}
	}
	const launch: FreshIndependentLaunchContractV1 = {
		version: 1, kind: "verified-fresh-launch-contract",
		source: terminalInterruption?.source ?? terminalPrefixInterruption?.source ??
			terminalCarry.source,
		envelopeSha256: terminalCarry.envelopeSha256,
		selectedTupleSha256: status.selectedTupleSha256,
		pendingActionSha256: pendingActionIdentity(action),
		testedSourceCommit: binding.testedSourceCommit, testedTree: binding.testedTree,
		requiresRuntimeAttestationBeforeModel: true, mode: "fresh-work-only" };
	let providerAvailabilityProof: VerifiedProviderAvailabilityProofV1 | undefined;
	if (status.providerPaymentHold && input.providerAvailabilityReceiptPrivateFile) {
		try {
			providerAvailabilityProof = await verifyProviderAvailabilityProof({
				privateReceiptFile: input.providerAvailabilityReceiptPrivateFile,
				terminalSource: { runId: terminalCarry.source.runId,
					runAttempt: terminalCarry.source.runAttempt,
					commit: terminalCarry.source.commit },
				terminalEnvelopeSha256: terminalCarry.envelopeSha256,
				terminalWorkflowId: terminalProof!.terminal.workflowId,
				terminalJobId: terminalProof!.terminal.jobId,
				testedSourceCommit: binding.testedSourceCommit,
				request: input.authenticatedHostRead?.request ?? input.request ?? fetch,
				githubToken: input.githubToken,
				authenticatedHostRead: input.authenticatedHostRead?.kind === "authenticated-host-github-read",
				loadEncryptedEnvelope: input.loadProviderAvailabilityEnvelope! });
		} catch (error) {
			if (error instanceof ProviderAvailabilityProofError)
				throw new MissionHostPreparationError({ code: "provider-availability-review-invalid",
					stage: "provider-availability-review", providerAvailabilityCause: error.code,
					...(error.check ? { providerAvailabilityCheck: error.check } : {}) });
			refuse("provider-availability-review-invalid", "provider-availability-review");
		}
	}
	const workflowRepairPlan = workflowRepair ?
		await verifyWorkflowRepairPlan(input, terminalCarry, binding,
			priorPrivateBundle["repair-state.json"] ?? resultOnlyRepair?.stateBytes,
			action, resultOnlyRepair) : undefined;
	let snapshot = { status, terminalCarry, pendingAction, currentDerivedAction,
		terminalInterruption, currentInterruptionAction, interruptedSourceReview,
		terminalPrefixInterruption, currentPrefixInterruptionAction, terminalPrefixSourceReview,
		freshLaunchContract: launch, workflowRepairPlan, providerAvailabilityProof,
		dispatchRecord: { state: "not-requested" } as const,
		linkedUnknownDelivery: undefined as LinkedUnknownDeliveryV1 | undefined };
	if (input.linkedUnknownDeliveryOldControlCommit !== undefined) {
		try { await lstat(input.journal.directory); }
		catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT")
				refuse("linked-unknown-delivery-invalid", "linked-unknown-delivery");
			throw error;
		}
		const unresolved = await input.journal.unresolvedForRef(CONTROL_REF);
		const sameReservedSuccessor = unresolved?.state === "reserved" &&
			unresolved.intentBinding.linkedUnknownDelivery?.oldControlCommit ===
				input.linkedUnknownDeliveryOldControlCommit &&
			unresolved.control.expectedBefore === input.linkedUnknownDeliveryOldControlCommit;
		const oldKey = sameReservedSuccessor ?
			unresolved.intentBinding.linkedUnknownDelivery?.oldJournalKey : unresolved?.idempotencyKey;
		const old = oldKey ? await input.journal.get(oldKey) : undefined;
		if (!old) refuse("linked-unknown-delivery-invalid", "linked-unknown-delivery");
		const linkedUnknownDelivery = await verifyLinkedUnknownDelivery(input, binding, old);
		snapshot = { ...snapshot, linkedUnknownDelivery };
	}
	const prospective = planMissionContinuation(snapshot);
	if (prospective.kind !== "dispatch") return { decision: prospective, ...privateObservation };
	if (input.readOnly) return { decision: prospective, descriptor: publicDescriptor(binding),
		...privateObservation };
	const old = await input.journal.get(prospective.intent.idempotencyKey);
	const unresolved = await input.journal.unresolvedForRef(CONTROL_REF);
	if (unresolved && unresolved.idempotencyKey !== prospective.intent.idempotencyKey &&
		prospective.intent.linkedUnknownDelivery?.oldJournalKey !== unresolved.idempotencyKey)
		refuse("control-request-delivery-uncertain", "dispatch-journal");
	if (input.recoverReservedDescriptor === true && !old)
		refuse("reserved-descriptor-missing", "dispatch-journal");
	if (old) {
		// Re-validate the current tested source and ref against the durable record.
		// A same-key lookup alone would miss a moved source or control ref.
		const matched = await input.journal.reserve(prospective.intent, binding,
			providerAvailabilityProof);
		return { decision: planMissionContinuation({ ...snapshot,
			dispatchRecord: dispatchRecord(matched) }),
			...(input.recoverReservedDescriptor === true && matched.state === "reserved" ?
				{ descriptor: publicDescriptor(binding) } : {}),
			journalKey: matched.idempotencyKey,
			journalState: matched.state, ...privateObservation };
	}
	const reserved = await input.journal.reserve(prospective.intent, binding,
		providerAvailabilityProof);
	return { decision: prospective, descriptor: publicDescriptor(binding),
		journalKey: reserved.idempotencyKey, journalState: reserved.state,
		...privateObservation };
}
