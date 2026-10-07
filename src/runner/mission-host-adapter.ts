/**
 * Read-only host preparation for an explicit, reusable mission run request.
 * The only public output is an empty-tree control commit descriptor. A caller
 * with an authorized GitHub transport performs the ref mutation separately.
 */
import { createHash } from "node:crypto";
import { classifyPendingAction } from "../m07/objective-progress.ts";
import { authenticateLatestTerminalCarry, authenticatedSupervisorProjection,
	REUSABLE_RUN_REQUEST_MESSAGE, type CarryArtifactPayload,
	type CurrentMissionRun } from "./ledger-continuation.ts";
import { MissionResumeJournal, type ResumeJournalRecord,
	type TestedControlBinding } from "./mission-resume-journal.ts";
import { pendingActionIdentity, planMissionContinuation, type CurrentDerivedActionV1,
	type FreshIndependentLaunchContractV1, type ResumeDispatchRecord,
	type SupervisorDecision } from "./mission-supervisor.ts";

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
		"legacy-action-checkpoint-unavailable" | "control-request-delivery-uncertain";
	stage: "tested-source-ci" | "live-source-ref" | "live-source-commit" |
		"live-control-ref" | "terminal-carry" | "legacy-action" | "dispatch-journal";
	ciRunId?: string;
	ciStatus?: "requested" | "waiting" | "pending" | "queued" | "in_progress" |
		"completed" | "unrecognized";
	ciConclusion?: "success" | "failure" | "cancelled" | "timed_out" | "skipped" |
		"neutral" | "action_required" | "unrecognized" | null;
	httpStatus?: number;
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
}>;

export type PrepareAuthenticatedResumeInput = Readonly<{
	source: CurrentMissionRun;
	seedEnvelopeB64: string | undefined;
	publicKeyFile: string;
	githubToken: string | undefined;
	loadCarryArtifact: (identity: { runId: string; artifactId: string }) => Promise<CarryArtifactPayload>;
	request?: typeof fetch;
	authenticatedHostRead?: Readonly<{ kind: "authenticated-host-github-read"; request: typeof fetch }>;
	expectedSpkiSha256?: string;
	journal: MissionResumeJournal;
	/** Authenticate and plan without creating a local reservation or external request. */
	readOnly?: boolean;
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
	const tree = isObject(commit) && isObject(commit.tree) ? commit.tree.sha : undefined;
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

/** Live authentication comes first. Legacy actions are classified NOW from the
 * authenticated checkpoint and remain labelled as current host decisions. */
export async function prepareAuthenticatedResumeRequest(input: PrepareAuthenticatedResumeInput):
	Promise<PreparedResumeRequest> {
	const authenticated = await authenticateLatestTerminalCarry({
		source: input.source, seedEnvelopeB64: input.seedEnvelopeB64,
		publicKeyFile: input.publicKeyFile, githubToken: input.githubToken,
		loadCarryArtifact: input.loadCarryArtifact, request: input.request,
		authenticatedHostRead: input.authenticatedHostRead,
		expectedSpkiSha256: input.expectedSpkiSha256 });
	const projected = authenticatedSupervisorProjection(authenticated.proof, authenticated.privateBundle);
	if (!projected) refuse("terminal-carry-projection-unavailable", "terminal-carry");
	const { status, terminalCarry, pendingAction } = projected;
	let currentDerivedAction: CurrentDerivedActionV1 | undefined;
	if (!pendingAction && status.objectiveOutcome === "incomplete" &&
		status.stopReason === "bounded-run-incomplete" && status.unresolvedOperationRefs.length &&
		terminalCarry.pendingActionSha256 === null) {
		const checkpoint = authenticated.privateBundle["objective-checkpoint.json"];
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
	const action = pendingAction ?? currentDerivedAction?.action;
	if (!action) return { decision: planMissionContinuation({ status, terminalCarry,
		pendingAction, dispatchRecord: { state: "not-requested" } }) };
	const binding = await readLiveTestedControlBinding(input.githubToken,
		input.authenticatedHostRead?.request ?? input.request,
		input.authenticatedHostRead?.kind === "authenticated-host-github-read");
	const launch: FreshIndependentLaunchContractV1 = {
		version: 1, kind: "verified-fresh-launch-contract",
		source: terminalCarry.source, envelopeSha256: terminalCarry.envelopeSha256,
		selectedTupleSha256: status.selectedTupleSha256,
		pendingActionSha256: pendingActionIdentity(action),
		testedSourceCommit: binding.testedSourceCommit, testedTree: binding.testedTree,
		requiresRuntimeAttestationBeforeModel: true, mode: "fresh-work-only" };
	const snapshot = { status, terminalCarry, pendingAction, currentDerivedAction,
		freshLaunchContract: launch, dispatchRecord: { state: "not-requested" } as const };
	const prospective = planMissionContinuation(snapshot);
	if (prospective.kind !== "dispatch") return { decision: prospective };
	if (input.readOnly) return { decision: prospective, descriptor: publicDescriptor(binding) };
	const old = await input.journal.get(prospective.intent.idempotencyKey);
	const unresolved = await input.journal.unresolvedForRef(CONTROL_REF);
	if (unresolved && unresolved.idempotencyKey !== prospective.intent.idempotencyKey)
		refuse("control-request-delivery-uncertain", "dispatch-journal");
	if (old) {
		// Re-validate the current tested source and ref against the durable record.
		// A same-key lookup alone would miss a moved source or control ref.
		const matched = await input.journal.reserve(prospective.intent, binding);
		return { decision: planMissionContinuation({ ...snapshot,
			dispatchRecord: dispatchRecord(matched) }), journalKey: matched.idempotencyKey,
			journalState: matched.state };
	}
	const reserved = await input.journal.reserve(prospective.intent, binding);
	return { decision: prospective, descriptor: publicDescriptor(binding),
		journalKey: reserved.idempotencyKey, journalState: reserved.state };
}
