import { createHash, createPublicKey, constants, verify } from "node:crypto";
import { readFile } from "node:fs/promises";
import { HarnessError } from "../types.ts";

export const MISSION_ID = "mul-pis-private-original-objective-2026-10-05";
export const MISSION_REPOSITORY = "SakuyaInazaki/Mul-Pis";
export const MISSION_TOTAL_CNY = 30;
export const MISSION_ARTIFACT = "confidential-campaign-envelope";
export const ONE_USE_PUSH_MARKER = "Repair shared total ledger and retain interrupted workflow state (mul-pis-20261005-mission-run1)";
const PUBLIC_KEY_SPKI_SHA256 = "095541a341d91f128aa9cd1f0c6d34f6b7291fc5d667365ef5a67efd42fd0d23";

export interface SignedMissionLedgerPayloadV1 {
	version: 1;
	kind: "mul-pis-private-mission-ledger";
	missionId: typeof MISSION_ID;
	repository: typeof MISSION_REPOSITORY;
	globalMaxCny: typeof MISSION_TOTAL_CNY;
	priorCommittedCny: number;
	revision: number;
	previous: { runId: string; runAttempt: number; artifactId: string; artifactName: typeof MISSION_ARTIFACT };
}

type GithubRun = { id?: number; run_number?: number; run_attempt?: number; workflow_id?: number;
	status?: string; head_branch?: string; head_sha?: string; event?: string;
	actor?: { login?: string }; head_commit?: { message?: string } };
type GithubArtifact = { id?: number; name?: string; expired?: boolean; workflow_run?: { id?: number } };
type GithubJob = { name?: string; status?: string; conclusion?: string;
	steps?: Array<{ name?: string; status?: string; conclusion?: string }> };

function reject(reason: string): never { throw new HarnessError("runner.mission-ledger", reason); }
function record(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
	return Object.keys(value).sort().join("|") === [...keys].sort().join("|");
}
function positiveId(value: unknown): value is string {
	return typeof value === "string" && /^[1-9][0-9]{0,17}$/.test(value);
}
function base64(value: unknown, maxBytes: number): Buffer {
	if (typeof value !== "string" || value.length > Math.ceil(maxBytes * 4 / 3) + 4 ||
		!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) reject("ledger envelope encoding is invalid");
	const decoded = Buffer.from(value, "base64");
	if (!decoded.length || decoded.length > maxBytes || decoded.toString("base64") !== value)
		reject("ledger envelope bytes are invalid");
	return decoded;
}
async function githubJson(url: string, token: string, request: typeof fetch): Promise<Record<string, unknown>> {
	let response: Response;
	try { response = await request(url, { method: "GET", redirect: "error", signal: AbortSignal.timeout(15_000),
		headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}` } }); }
	catch { return reject("GitHub run freshness check could not complete"); }
	if (response.status !== 200) reject("GitHub run freshness check was not accepted");
	let value: unknown;
	try { value = await response.json(); } catch { return reject("GitHub run freshness response is invalid"); }
	if (!record(value)) reject("GitHub run freshness response is invalid");
	return value;
}

/** Signed carry plus GitHub run-order proof; the private signing key is never loaded here. */
export async function verifySignedMissionLedger(input: {
	envelopeB64: string | undefined; publicKeyFile: string; githubToken: string | undefined;
	current: { repository: string | undefined; runId: string | undefined; runAttempt: string | undefined;
		actor: string | undefined; event: string | undefined; ref: string | undefined;
		sha: string | undefined; manualAuthorized: string | undefined };
	request?: typeof fetch;
	/** Offline fixture key identity only; production caller omits this override. */
	expectedSpkiSha256?: string;
}): Promise<SignedMissionLedgerPayloadV1> {
	const isManual = input.current.event === "workflow_dispatch";
	const isPush = input.current.event === "push";
	if (input.current.repository !== MISSION_REPOSITORY || input.current.actor !== "SakuyaInazaki" ||
		(!isManual && !isPush) || (isManual && input.current.manualAuthorized !== "true") ||
		input.current.ref !== "refs/heads/improve/workflow-learning-reliability" ||
		input.current.runAttempt !== "1" || !positiveId(input.current.runId) ||
		!input.current.sha || !/^[0-9a-f]{40}$/.test(input.current.sha) ||
		!input.githubToken || input.githubToken.length > 4_000)
		reject("current Actions identity is not admitted for the mission ledger");
	const envelopeBytes = base64(input.envelopeB64, 8_000);
	let envelope: unknown;
	try { envelope = JSON.parse(envelopeBytes.toString("utf8")); }
	catch { return reject("signed mission ledger envelope is invalid"); }
	if (!record(envelope) || !exactKeys(envelope, ["payload_b64", "signature_b64"]))
		reject("signed mission ledger envelope fields are invalid");
	const payloadBytes = base64(envelope.payload_b64, 4_000);
	const signature = base64(envelope.signature_b64, 1_000);
	const publicKey = createPublicKey(await readFile(input.publicKeyFile));
	const spki = publicKey.export({ type: "spki", format: "der" });
	if (createHash("sha256").update(spki).digest("hex") !==
		(input.expectedSpkiSha256 ?? PUBLIC_KEY_SPKI_SHA256) ||
		!verify("sha256", payloadBytes, { key: publicKey, padding: constants.RSA_PKCS1_PSS_PADDING,
			saltLength: 32 }, signature)) reject("signed mission ledger authentication failed");
	let parsed: unknown;
	try { parsed = JSON.parse(payloadBytes.toString("utf8")); }
	catch { return reject("signed mission ledger payload is invalid"); }
	if (!record(parsed) || !exactKeys(parsed, ["version", "kind", "missionId", "repository", "globalMaxCny",
		"priorCommittedCny", "revision", "previous"]) || !record(parsed.previous) ||
		!exactKeys(parsed.previous, ["runId", "runAttempt", "artifactId", "artifactName"]))
		reject("signed mission ledger payload fields are invalid");
	const payload = parsed as unknown as SignedMissionLedgerPayloadV1;
	if (payload.version !== 1 || payload.kind !== "mul-pis-private-mission-ledger" ||
		payload.missionId !== MISSION_ID || payload.repository !== MISSION_REPOSITORY ||
		payload.globalMaxCny !== MISSION_TOTAL_CNY ||
		!Number.isFinite(payload.priorCommittedCny) || payload.priorCommittedCny < 0 ||
		!Number.isSafeInteger(payload.revision) || payload.revision < 1 ||
		!positiveId(payload.previous.runId) || payload.previous.runId === input.current.runId ||
		payload.previous.runAttempt !== 1 || !positiveId(payload.previous.artifactId) ||
		payload.previous.artifactName !== MISSION_ARTIFACT)
		reject("signed mission ledger mission or prior commitment is invalid");
	const request = input.request ?? fetch;
	const base = `https://api.github.com/repos/${MISSION_REPOSITORY}/actions`;
	const listing = await githubJson(`${base}/workflows/manual-private-campaign.yml/runs?per_page=100`, input.githubToken, request);
	const runs = listing.workflow_runs;
	if (!Array.isArray(runs) || runs.length < 2 || runs.length > 100) reject("workflow run freshness listing is incomplete");
	const current = runs.find(item => record(item) && String((item as GithubRun).id) === input.current.runId) as GithubRun | undefined;
	const previous = runs.find(item => record(item) && String((item as GithubRun).id) === payload.previous.runId) as GithubRun | undefined;
	if (!current || !previous || !Number.isSafeInteger(current.run_number) || !Number.isSafeInteger(previous.run_number) ||
		previous.run_number! >= current.run_number! || current.run_attempt !== 1 ||
		previous.run_attempt !== payload.previous.runAttempt || previous.status !== "completed" ||
		current.workflow_id !== previous.workflow_id ||
		current.event !== input.current.event || current.head_sha !== input.current.sha ||
		current.actor?.login !== input.current.actor ||
		(isPush && current.head_commit?.message !== ONE_USE_PUSH_MARKER) ||
		current.head_branch !== "improve/workflow-learning-reliability" ||
		previous.head_branch !== current.head_branch)
		reject("signed mission ledger does not name the immediately previous completed workflow run");
	const intervening = runs.filter(item => record(item) && Number.isSafeInteger((item as GithubRun).run_number) &&
		(item as GithubRun).run_number! > previous.run_number! &&
		(item as GithubRun).run_number! < current.run_number!) as GithubRun[];
	if (intervening.length !== current.run_number! - previous.run_number! - 1 || intervening.length > 10 ||
		new Set(intervening.map(item => item.run_number)).size !== intervening.length)
		reject("workflow run gap cannot be proved nonbillable");
	for (const skipped of intervening) {
		if (!Number.isSafeInteger(skipped.id) || skipped.status !== "completed" ||
			skipped.workflow_id !== current.workflow_id || skipped.run_attempt !== 1)
			reject("intervening workflow run is not settled");
		const jobs = await githubJson(`${base}/runs/${skipped.id}/jobs?per_page=100`, input.githubToken, request);
		if (!Array.isArray(jobs.jobs) || jobs.jobs.length !== 1 || !record(jobs.jobs[0]))
			reject("intervening workflow job disposition is unknown");
		const job = jobs.jobs[0] as GithubJob;
		const campaignStep = job.steps?.find(step => step.name === "Run bounded private campaign");
		const provedNoProvider = job.conclusion === "skipped" ||
			(campaignStep?.status === "completed" && campaignStep.conclusion === "skipped");
		if (job.name !== "private-campaign" || job.status !== "completed" || !provedNoProvider)
			reject("intervening workflow may have executed a billable job");
	}
	const artifacts = await githubJson(`${base}/runs/${payload.previous.runId}/artifacts?per_page=100`, input.githubToken, request);
	if (!Array.isArray(artifacts.artifacts) || !artifacts.artifacts.some(item => {
		const found = item as GithubArtifact;
		return record(item) && String(found.id) === payload.previous.artifactId &&
			found.name === MISSION_ARTIFACT && found.expired === false &&
			found.workflow_run?.id === previous.id;
	})) reject("signed mission ledger previous encrypted artifact is not available");
	return payload;
}
