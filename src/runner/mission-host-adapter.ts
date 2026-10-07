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
function refuse(reason: string): never {
	throw new Error(`mission host adapter refused: ${reason}`);
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

async function githubJson(url: string, token: string | undefined, request: typeof fetch): Promise<unknown> {
const response = await request(url, { method: "GET", redirect: "error", headers: {
		...(token ? { Authorization: `Bearer ${token}` } : {}),
		Accept: "application/vnd.github+json",
		"X-GitHub-Api-Version": "2022-11-28" } });
	if (!response.ok) refuse("live GitHub source or CI verification failed");
	const body = await response.text();
	try { return JSON.parse(body) as unknown; }
	catch { return refuse("live GitHub verification response is invalid"); }
}

/** The same source/CI/control-ref facts checked again by the existing Actions
 * preflight. This function is read-only and never claims a prior run's source
 * is the currently tested source. */
export async function readLiveTestedControlBinding(token: string | undefined,
	request: typeof fetch = fetch, authenticatedHostRead = false): Promise<TestedControlBinding> {
	if ((!token && !authenticatedHostRead) || (token?.length ?? 0) > 4_000)
		refuse("GitHub read credential is unavailable");
	const base = `https://api.github.com/repos/${REPOSITORY}`;
	const source = await githubJson(`${base}/git/ref/heads/${SOURCE_BRANCH}`, token, request);
	const sourceCommit = isObject(source) && isObject(source.object) ? source.object.sha : undefined;
	if (!hex40(sourceCommit)) refuse("tested source ref is invalid");
	const commit = await githubJson(`${base}/git/commits/${sourceCommit}`, token, request);
	const tree = isObject(commit) && isObject(commit.tree) ? commit.tree.sha : undefined;
	if (!hex40(tree)) refuse("tested source tree is invalid");
	const ci = await githubJson(`${base}/actions/workflows/workflow-regression.yml/runs?head_sha=${sourceCommit}&per_page=100`,
		token, request);
	const rows = isObject(ci) ? ci.workflow_runs : undefined;
	if (!Array.isArray(rows) || rows.length > 100) refuse("source CI listing is invalid");
	const accepted = rows.find(row => isObject(row) &&
		Number.isSafeInteger(row.id) && Number(row.id) > 0 &&
		row.head_sha === sourceCommit && row.head_branch === SOURCE_BRANCH &&
		row.event === "push" && row.run_attempt === 1 &&
		row.status === "completed" && row.conclusion === "success");
	if (!isObject(accepted)) refuse("tested source lacks successful offline CI");
	const control = await githubJson(`${base}/git/ref/heads/${CONTROL_BRANCH}`, token, request);
	const previous = isObject(control) && isObject(control.object) ? control.object.sha : undefined;
	if (!hex40(previous)) refuse("control ref is unavailable for an explicit request");
	const parents = previous === sourceCommit ? [sourceCommit] : [sourceCommit, previous];
	return { controlRef: CONTROL_REF, message: REUSABLE_RUN_REQUEST_MESSAGE,
		testedSourceCommit: sourceCommit, testedTree: tree,
		successfulCi: { workflow: "workflow-regression.yml", runId: String(accepted.id),
			runAttempt: 1, headCommit: sourceCommit, conclusion: "success" },
		previousControlCommit: previous, parents, expectedBefore: previous,
		sourceRef: SOURCE_REF, sourceRefTip: sourceCommit };
}

function publicDescriptor(binding: TestedControlBinding): PublicResumeRequestDescriptor {
	if (!binding.previousControlCommit) refuse("control ref must be initialized first");
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
	if (!projected) refuse("terminal carry projection is unavailable");
	const { status, terminalCarry, pendingAction } = projected;
	let currentDerivedAction: CurrentDerivedActionV1 | undefined;
	if (!pendingAction && status.objectiveOutcome === "incomplete" &&
		status.stopReason === "bounded-run-incomplete" && status.unresolvedOperationRefs.length &&
		terminalCarry.pendingActionSha256 === null) {
		const checkpoint = authenticated.privateBundle["objective-checkpoint.json"];
		if (typeof checkpoint !== "string" ||
			terminalCarry.checkpointSha256 !== sha(checkpoint))
			refuse("legacy action lacks exact authenticated checkpoint bytes");
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
		refuse("another control request has uncertain delivery");
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
