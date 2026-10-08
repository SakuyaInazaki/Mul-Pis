/** Host-only proof that a separate, later Actions balance check reported availability.
 * The private receipt asserts an operator decrypted the exact encrypted envelope;
 * it has no authority over the campaign's research, actions, or accounting.
 */
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPOSITORY = "SakuyaInazaki/Mul-Pis";
const REQUEST_BRANCH = "run-requests/provider-balance-availability";
const REQUEST_MESSAGE = "Check provider availability";
const WORKFLOW = "provider-balance-check.yml";
const WORKFLOW_NAME = "Confidential provider balance check";
const ARTIFACT = "confidential-provider-balance-envelope";
const ENVELOPE_FILE = "provider-balance.enc.json";
const RECIPIENT_SPKI = "095541a341d91f128aa9cd1f0c6d34f6b7291fc5d667365ef5a67efd42fd0d23";
const checkout = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const exact = (v: unknown, keys: readonly string[]): v is Record<string, unknown> =>
	object(v) && Object.keys(v).sort().join("|") === [...keys].sort().join("|");
const id = (v: unknown): v is string => typeof v === "string" && /^[1-9][0-9]{0,17}$/.test(v);
const sha40 = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{40}$/.test(v);
const sha64 = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{64}$/.test(v);
const digest = (v: Uint8Array): string => createHash("sha256").update(v).digest("hex");
const timestamp = (v: unknown): number | undefined => {
	if (typeof v !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(v)) return;
	const date = Date.parse(v);
	return Number.isFinite(date) ? date : undefined;
};
type Source = Readonly<{ runId: string; runAttempt: number; commit: string }>;
const source = (v: unknown): v is Source => exact(v, ["runId", "runAttempt", "commit"]) &&
	id(v.runId) && Number.isSafeInteger(v.runAttempt) && Number(v.runAttempt) > 0 && sha40(v.commit);
const sameSource = (a: Source, b: Source): boolean => a.runId === b.runId &&
	a.runAttempt === b.runAttempt && a.commit === b.commit;
const inside = (file: string, root: string): boolean => {
	const relative = path.relative(root, file);
	return relative === "" || relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};

export type ProviderAvailabilityReviewReceiptV1 = Readonly<{
	version: 1; kind: "host-reviewed-provider-availability";
	terminal: Readonly<{ source: Source; envelopeSha256: string }>;
	probe: Readonly<{ source: Source; workflowId: string; jobId: string;
		artifactId: string; archiveSha256: string; envelopeSha256: string;
		envelopeFile: typeof ENVELOPE_FILE; testedSourceCommit: string;
		requestNonce: string }>;
	verdict: Readonly<{ kind: "provider-balance-availability"; version: 1;
		availability: "available" }>;
	review: Readonly<{ kind: "operator-rsa-decryption-review";
		conclusion: "exact-envelope-available" }>;
}>;

declare const verifiedProviderAvailability: unique symbol;
export type VerifiedProviderAvailabilityProofV1 = Readonly<{
	version: 1; kind: "host-verified-provider-availability";
	terminalSource: Source; terminalEnvelopeSha256: string;
	testedSourceCommit: string; probeSource: Source; workflowId: string;
	jobId: string; artifactId: string; archiveSha256: string;
	envelopeSha256: string; receiptSha256: string; availability: "available";
	[verifiedProviderAvailability]: true;
}>;
const verified = new WeakSet<object>();
export function isVerifiedProviderAvailabilityProof(value: unknown): value is VerifiedProviderAvailabilityProofV1 {
	return !!value && typeof value === "object" && verified.has(value);
}
export class ProviderAvailabilityProofError extends Error {
	readonly code: "invalid-receipt" | "unrelated-receipt" | "live-source-invalid" |
		"probe-not-fresh" | "artifact-invalid" | "envelope-invalid";
	constructor(code: ProviderAvailabilityProofError["code"]) {
		super(`provider availability proof refused: ${code}`);
		this.code = code;
	}
}
const reject = (code: ProviderAvailabilityProofError["code"]): never => {
	throw new ProviderAvailabilityProofError(code);
};

function receiptValid(v: unknown): v is ProviderAvailabilityReviewReceiptV1 {
	if (!exact(v, ["version", "kind", "terminal", "probe", "verdict", "review"]) ||
		v.version !== 1 || v.kind !== "host-reviewed-provider-availability" ||
		!exact(v.terminal, ["source", "envelopeSha256"]) || !source(v.terminal.source) ||
		!sha64(v.terminal.envelopeSha256) ||
		!exact(v.probe, ["source", "workflowId", "jobId", "artifactId", "archiveSha256",
			"envelopeSha256", "envelopeFile", "testedSourceCommit", "requestNonce"]) ||
		!source(v.probe.source) || !id(v.probe.workflowId) || !id(v.probe.jobId) ||
		!id(v.probe.artifactId) || !sha64(v.probe.archiveSha256) ||
		!sha64(v.probe.envelopeSha256) || v.probe.envelopeFile !== ENVELOPE_FILE ||
		!sha40(v.probe.testedSourceCommit) || typeof v.probe.requestNonce !== "string" ||
		!/^[0-9a-f]{32}$/.test(v.probe.requestNonce) ||
		!exact(v.verdict, ["kind", "version", "availability"]) ||
		v.verdict.kind !== "provider-balance-availability" || v.verdict.version !== 1 ||
		v.verdict.availability !== "available" ||
		!exact(v.review, ["kind", "conclusion"]) ||
		v.review.kind !== "operator-rsa-decryption-review" ||
		v.review.conclusion !== "exact-envelope-available") return false;
	return true;
}

async function readReceipt(file: string): Promise<{ receipt: ProviderAvailabilityReviewReceiptV1;
	receiptSha256: string }> {
	if (!path.isAbsolute(file)) reject("invalid-receipt");
	let handle;
	try {
		const [actual, root] = await Promise.all([realpath(file), realpath(checkout)]);
		if (inside(file, root) || inside(actual, root)) reject("invalid-receipt");
		handle = await open(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
		const before = await handle.stat();
		if (!before.isFile() || (before.mode & 0o777) !== 0o600 || before.size < 1 ||
			before.size > 16 * 1024) reject("invalid-receipt");
		const bytes = await handle.readFile();
		const after = await handle.stat();
		if (bytes.length !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs)
			reject("invalid-receipt");
		let value: unknown;
		try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
		catch { return reject("invalid-receipt"); }
		if (!receiptValid(value)) return reject("invalid-receipt");
		return { receipt: value, receiptSha256: digest(bytes) };
	} catch (error) {
		if (error instanceof ProviderAvailabilityProofError) throw error;
		return reject("invalid-receipt");
	} finally { await handle?.close(); }
}

function decoded(value: unknown): Buffer | undefined {
	if (typeof value !== "string" || !value.length || value.length % 4 !== 0 ||
		!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return;
	const bytes = Buffer.from(value, "base64");
	return bytes.toString("base64") === value ? bytes : undefined;
}
function envelopeValid(bytes: Uint8Array, probe: Source): boolean {
	if (!(bytes instanceof Uint8Array) || bytes.length < 1 || bytes.length > 64 * 1024) return false;
	let v: unknown;
	try { v = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
	catch { return false; }
	if (!exact(v, ["format", "key_wrap", "content_cipher", "recipient_spki_sha256",
		"metadata", "wrapped_key_b64", "nonce_b64", "ciphertext_b64"]) ||
		v.format !== "mul-pis-provider-balance-v1" || v.key_wrap !== "RSA-3072-OAEP-SHA256" ||
		v.content_cipher !== "AES-256-GCM" || v.recipient_spki_sha256 !== RECIPIENT_SPKI ||
		!exact(v.metadata, ["repository", "run_id", "run_attempt", "commit", "event"]) ||
		v.metadata.repository !== REPOSITORY || v.metadata.run_id !== probe.runId ||
		v.metadata.run_attempt !== String(probe.runAttempt) ||
		v.metadata.commit !== probe.commit || v.metadata.event !== "push") return false;
	const wrapped = decoded(v.wrapped_key_b64), nonce = decoded(v.nonce_b64);
	const ciphertext = decoded(v.ciphertext_b64);
	return !!wrapped && wrapped.length === 384 && !!nonce && nonce.length === 12 &&
		!!ciphertext && ciphertext.length >= 16 && ciphertext.length <= 4096;
}

async function githubJson(input: Readonly<{ url: string; request: typeof fetch;
	githubToken?: string; authenticatedHostRead?: boolean }>): Promise<Record<string, unknown>> {
	if ((!input.githubToken && !input.authenticatedHostRead) ||
		(input.githubToken?.length ?? 0) > 4000) reject("live-source-invalid");
	let response: Response;
	try { response = await input.request(input.url, { method: "GET", redirect: "error",
		headers: { Accept: "application/vnd.github+json",
			...(input.githubToken ? { Authorization: `Bearer ${input.githubToken}` } : {}) } }); }
	catch { return reject("live-source-invalid"); }
	if (!response.ok) reject("live-source-invalid");
	let value: unknown;
	try { value = await response.json(); }
	catch { return reject("live-source-invalid"); }
	if (!object(value)) reject("live-source-invalid");
	return value as Record<string, unknown>;
}

/** Require an authenticated later manual check, exact live artifact identity,
 * and a private decryption review of that artifact's exact envelope bytes. */
export async function verifyProviderAvailabilityProof(input: Readonly<{
	privateReceiptFile: string;
	terminalSource: Source; terminalEnvelopeSha256: string;
	terminalWorkflowId: string; terminalJobId: string;
	testedSourceCommit: string; request: typeof fetch; githubToken?: string;
	authenticatedHostRead?: boolean;
	loadEncryptedEnvelope: (identity: { runId: string; artifactId: string;
		expectedArchiveSha256: string }) => Promise<Uint8Array>;
}>): Promise<VerifiedProviderAvailabilityProofV1> {
	if (!source(input.terminalSource) || !sha64(input.terminalEnvelopeSha256) ||
		!id(input.terminalWorkflowId) || !id(input.terminalJobId) ||
		!sha40(input.testedSourceCommit)) reject("live-source-invalid");
	const { receipt, receiptSha256 } = await readReceipt(input.privateReceiptFile);
	if (!sameSource(receipt.terminal.source, input.terminalSource) ||
		receipt.terminal.envelopeSha256 !== input.terminalEnvelopeSha256 ||
		receipt.probe.testedSourceCommit !== input.testedSourceCommit)
		reject("unrelated-receipt");
	const base = `https://api.github.com/repos/${REPOSITORY}`;
	const get = (suffix: string) => githubJson({ url: `${base}${suffix}`, request: input.request,
		githubToken: input.githubToken, authenticatedHostRead: input.authenticatedHostRead });
	const workflow = await get(`/actions/workflows/${WORKFLOW}`);
	if (!id(workflow.id === undefined ? undefined : String(workflow.id)) ||
		workflow.name !== WORKFLOW_NAME ||
		workflow.path !== `.github/workflows/${WORKFLOW}` || workflow.state !== "active")
		reject("live-source-invalid");
	const workflowId = String(workflow.id);
	if (receipt.probe.workflowId !== workflowId) reject("unrelated-receipt");
	const p = receipt.probe;
	const requestRef = await get(`/git/ref/heads/${REQUEST_BRANCH}`);
	if (!object(requestRef.object) || requestRef.object.sha !== p.source.commit)
		reject("live-source-invalid");
	const requestCommit = await get(`/git/commits/${p.source.commit}`);
	const testedCommit = await get(`/git/commits/${input.testedSourceCommit}`);
	const expectedMessage = `${REQUEST_MESSAGE}\n\n` +
		`Terminal-Run-Id: ${input.terminalSource.runId}\n` +
		`Terminal-Run-Attempt: ${input.terminalSource.runAttempt}\n` +
		`Terminal-Commit: ${input.terminalSource.commit}\n` +
		`Terminal-Envelope-SHA256: ${input.terminalEnvelopeSha256}\n` +
		`Request-Nonce: ${p.requestNonce}\n`;
	if (testedCommit.sha !== input.testedSourceCommit || !sha40(testedCommit.tree &&
		object(testedCommit.tree) ? testedCommit.tree.sha : undefined) ||
		requestCommit.sha !== p.source.commit || requestCommit.message !== expectedMessage ||
		!object(requestCommit.tree) || !object(testedCommit.tree) ||
		requestCommit.tree.sha !== testedCommit.tree.sha ||
		!Array.isArray(requestCommit.parents) || requestCommit.parents.length < 1 ||
		requestCommit.parents.length > 2 || !object(requestCommit.parents[0]) ||
		requestCommit.parents[0].sha !== input.testedSourceCommit ||
		(requestCommit.parents.length === 2 && (!object(requestCommit.parents[1]) ||
			!sha40(requestCommit.parents[1].sha) ||
			requestCommit.parents[1].sha === input.testedSourceCommit)))
		reject("live-source-invalid");
	const heldRun = await get(`/actions/runs/${input.terminalSource.runId}`);
	const heldJob = await get(`/actions/jobs/${input.terminalJobId}`);
	if (heldRun.id !== Number(input.terminalSource.runId) ||
		heldRun.run_attempt !== input.terminalSource.runAttempt ||
		heldRun.workflow_id !== Number(input.terminalWorkflowId) ||
		heldRun.head_sha !== input.terminalSource.commit || heldRun.status !== "completed" ||
		heldJob.id !== Number(input.terminalJobId) ||
		heldJob.run_id !== Number(input.terminalSource.runId) ||
		heldJob.run_attempt !== input.terminalSource.runAttempt ||
		heldJob.head_sha !== input.terminalSource.commit ||
		heldJob.name !== "private-campaign" || heldJob.status !== "completed")
		reject("live-source-invalid");
	const heldCompleted = timestamp(heldJob.completed_at);
	if (heldCompleted === undefined) reject("live-source-invalid");
	const probeRun = await get(`/actions/runs/${p.source.runId}`);
	if (probeRun.id !== Number(p.source.runId) || probeRun.run_attempt !== p.source.runAttempt ||
		p.source.runAttempt !== 1 ||
		probeRun.workflow_id !== Number(workflowId) || probeRun.name !== WORKFLOW_NAME ||
		probeRun.display_title !== WORKFLOW_NAME ||
		probeRun.head_branch !== REQUEST_BRANCH || probeRun.head_sha !== p.source.commit ||
		probeRun.event !== "push" || !object(probeRun.actor) ||
		probeRun.actor.login !== "SakuyaInazaki" ||
		probeRun.status !== "completed" || probeRun.conclusion !== "success")
		reject("live-source-invalid");
	const probeCreated = timestamp(probeRun.created_at);
	if (probeCreated === undefined || probeCreated <= heldCompleted!)
		reject("probe-not-fresh");
	const jobs = await get(`/actions/runs/${p.source.runId}/jobs?per_page=100`);
	if (!Array.isArray(jobs.jobs) || jobs.total_count !== 1 || jobs.jobs.length !== 1)
		reject("live-source-invalid");
	const job = (jobs.jobs as unknown[])[0];
	if (!object(job) || job.id !== Number(p.jobId) || job.run_id !== Number(p.source.runId) ||
		job.run_attempt !== p.source.runAttempt || job.head_sha !== p.source.commit ||
		job.name !== "provider-balance-check" ||
		job.status !== "completed" || job.conclusion !== "success")
		reject("live-source-invalid");
	const required = ["Verify exact source and accepted offline CI",
		"Check once and seal availability", "Upload ciphertext only"];
	const steps = (job as Record<string, unknown>).steps;
	if (!Array.isArray(steps) || required.some(name =>
		(steps as unknown[]).filter(step => object(step) && step.name === name &&
			step.status === "completed" && step.conclusion === "success").length !== 1))
		reject("live-source-invalid");
	const probeStarted = timestamp((job as Record<string, unknown>).started_at);
	if (probeStarted === undefined || probeStarted <= heldCompleted!)
		reject("probe-not-fresh");
	const artifacts = await get(`/actions/runs/${p.source.runId}/artifacts?per_page=100`);
	if (!Array.isArray(artifacts.artifacts) || artifacts.total_count !== 1 ||
		artifacts.artifacts.length !== 1) reject("artifact-invalid");
	const artifact = (artifacts.artifacts as unknown[])[0];
	if (!object(artifact) || artifact.id !== Number(p.artifactId) || artifact.name !== ARTIFACT ||
		artifact.expired !== false || artifact.digest !== `sha256:${p.archiveSha256}` ||
		!object(artifact.workflow_run) || artifact.workflow_run.id !== Number(p.source.runId) ||
		artifact.workflow_run.head_sha !== p.source.commit)
		reject("artifact-invalid");
	let bytes: Uint8Array;
	try { bytes = await input.loadEncryptedEnvelope({ runId: p.source.runId,
		artifactId: p.artifactId, expectedArchiveSha256: p.archiveSha256 }); }
	catch { return reject("artifact-invalid"); }
	if (!envelopeValid(bytes, p.source) || digest(bytes) !== p.envelopeSha256)
		reject("envelope-invalid");
	const proof = Object.freeze({ version: 1 as const,
		kind: "host-verified-provider-availability" as const,
		terminalSource: Object.freeze({ ...input.terminalSource }),
		terminalEnvelopeSha256: input.terminalEnvelopeSha256,
		testedSourceCommit: input.testedSourceCommit,
		probeSource: Object.freeze({ ...p.source }), workflowId, jobId: p.jobId,
		artifactId: p.artifactId, archiveSha256: p.archiveSha256,
		envelopeSha256: p.envelopeSha256, receiptSha256, availability: "available" as const });
	verified.add(proof);
	return proof as VerifiedProviderAvailabilityProofV1;
}
