/**
 * Host-only migration of a repair diagnostic from a decrypted result when the
 * exact terminal AEAD carry omitted that optional file. The result never gains
 * authority over research, accounting, or the carried pending action.
 */
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { authenticatedSupervisorProjection, type AuthenticatedTerminalCarryProof,
	type PrivateContinuationBundle } from "./ledger-continuation.ts";
import { pendingActionIdentity } from "./mission-supervisor.ts";
import { validWorkflowRepairState, type WorkflowRepairStateV1 } from "./repair-liveness.ts";

const hex40 = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{40}$/.test(v);
const hex64 = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{64}$/.test(v);
const object = (v: unknown): v is Record<string, unknown> =>
	!!v && typeof v === "object" && !Array.isArray(v);
const exact = (v: unknown, keys: readonly string[]): v is Record<string, unknown> =>
	object(v) && Object.keys(v).sort().join("|") === [...keys].sort().join("|");
const digest = (v: Uint8Array | string): string => createHash("sha256").update(v).digest("hex");
const checkout = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
function inside(file: string, root: string): boolean {
	const relative = path.relative(root, file);
	return relative === "" || relative !== ".." && !relative.startsWith(`..${path.sep}`) &&
		!path.isAbsolute(relative);
}
type Source = Readonly<{ runId: string; runAttempt: number; commit: string }>;
const sameSource = (a: Source, b: Source): boolean => a.runId === b.runId &&
	a.runAttempt === b.runAttempt && a.commit === b.commit;
const validSource = (v: unknown): v is Source => exact(v, ["runId", "runAttempt", "commit"]) &&
	typeof v.runId === "string" && /^[1-9][0-9]{0,17}$/.test(v.runId) &&
	Number.isSafeInteger(v.runAttempt) && Number(v.runAttempt) > 0 && hex40(v.commit);

/** The operator obtained these bytes by decrypting the named RSA envelope
 * privately and reviewed only the repair-state file. */
export type ResultOnlyRepairReviewReceiptV1 = Readonly<{
	version: 1; kind: "host-reviewed-result-only-repair-state";
	prior: Readonly<{ source: Source; sourceTree: string; carryEnvelopeSha256: string;
		checkpointSha256: string; contractId: string; selectedTupleSha256: string;
		pendingActionSha256: string }>;
	result: Readonly<{ artifactId: string; archiveSha256: string;
		envelopeSha256: string; envelopeFile: "private-campaign-outcome.enc.json" }>;
	repair: Readonly<{ file: "repair-state.json"; bytesUtf8: string; sha256: string }>;
	review: Readonly<{ kind: "operator-rsa-decryption-review";
		conclusion: "control-only-repair-state-reviewed";
		researchResultUse: "untrusted-no-scientific-adoption" }>;
}>;

declare const verifiedResultOnlyRepair: unique symbol;
export type VerifiedResultOnlyRepairStateV1 = Readonly<{
	stateBytes: string; state: WorkflowRepairStateV1; receiptSha256: string;
	resultEnvelopeSha256: string;
	[verifiedResultOnlyRepair]: true;
}>;
const verified = new WeakSet<object>();
export function isVerifiedResultOnlyRepairState(value: unknown): value is VerifiedResultOnlyRepairStateV1 {
	return !!value && typeof value === "object" && verified.has(value);
}
export class ResultOnlyRepairReviewError extends Error {
	readonly code: "invalid-receipt" | "unrelated-receipt" | "envelope-mismatch" |
		"carried-action-mismatch";
	constructor(code: ResultOnlyRepairReviewError["code"]) {
		super(`result-only repair review refused: ${code}`);
		this.code = code;
	}
}
const reject = (code: ResultOnlyRepairReviewError["code"]): never => {
	throw new ResultOnlyRepairReviewError(code);
};

function validReceipt(v: unknown): v is ResultOnlyRepairReviewReceiptV1 {
	if (!exact(v, ["version", "kind", "prior", "result", "repair", "review"]) ||
		v.version !== 1 || v.kind !== "host-reviewed-result-only-repair-state") return false;
	const p = v.prior, a = v.result, r = v.repair, review = v.review;
	return exact(p, ["source", "sourceTree", "carryEnvelopeSha256", "checkpointSha256",
		"contractId", "selectedTupleSha256", "pendingActionSha256"]) && validSource(p.source) &&
		hex40(p.sourceTree) && hex64(p.carryEnvelopeSha256) && hex64(p.checkpointSha256) &&
		typeof p.contractId === "string" && p.contractId.length > 0 && p.contractId.length <= 256 &&
		hex64(p.selectedTupleSha256) && hex64(p.pendingActionSha256) &&
		exact(a, ["artifactId", "archiveSha256", "envelopeSha256", "envelopeFile"]) &&
		typeof a.artifactId === "string" && /^[1-9][0-9]{0,17}$/.test(a.artifactId) &&
		hex64(a.archiveSha256) && hex64(a.envelopeSha256) &&
		a.envelopeFile === "private-campaign-outcome.enc.json" &&
		exact(r, ["file", "bytesUtf8", "sha256"]) && r.file === "repair-state.json" &&
		typeof r.bytesUtf8 === "string" && Buffer.byteLength(r.bytesUtf8) > 0 &&
		Buffer.byteLength(r.bytesUtf8) <= 64 * 1024 && hex64(r.sha256) &&
		exact(review, ["kind", "conclusion", "researchResultUse"]) &&
		review.kind === "operator-rsa-decryption-review" &&
		review.conclusion === "control-only-repair-state-reviewed" &&
		review.researchResultUse === "untrusted-no-scientific-adoption";
}

async function readReceipt(file: string): Promise<{ receipt: ResultOnlyRepairReviewReceiptV1;
	receiptSha256: string }> {
	if (!path.isAbsolute(file)) reject("invalid-receipt");
	let handle;
	try {
		const [actual, root] = await Promise.all([realpath(file), realpath(checkout)]);
		if (inside(file, root) || inside(actual, root)) reject("invalid-receipt");
		handle = await open(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
		const before = await handle.stat();
		if (!before.isFile() || (before.mode & 0o777) !== 0o600 || before.size < 1 ||
			before.size > 64 * 1024) reject("invalid-receipt");
		const bytes = await handle.readFile();
		const after = await handle.stat();
		if (bytes.length !== before.size || after.size !== before.size ||
			after.mtimeMs !== before.mtimeMs) reject("invalid-receipt");
		let value: unknown;
		try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
		catch { return reject("invalid-receipt"); }
		if (!validReceipt(value)) return reject("invalid-receipt");
		return { receipt: value, receiptSha256: digest(bytes) };
	} catch (error) {
		if (error instanceof ResultOnlyRepairReviewError) throw error;
		return reject("invalid-receipt");
	} finally { await handle?.close(); }
}

function validEncryptedEnvelope(bytes: Uint8Array, source: Source,
	terminalEvent: string): boolean {
	if (!(bytes instanceof Uint8Array) || bytes.length < 1 || bytes.length > 132 * 1024 * 1024)
		return false;
	let value: unknown;
	try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
	catch { return false; }
	if (!exact(value, ["format", "key_wrap", "content_cipher", "recipient_spki_sha256",
		"metadata", "wrapped_key_b64", "nonce_b64", "ciphertext_b64"]) ||
		value.format !== "mul-pis-private-campaign-v1" || value.key_wrap !== "RSA-3072-OAEP-SHA256" ||
		value.content_cipher !== "AES-256-GCM" || !hex64(value.recipient_spki_sha256) ||
		!exact(value.metadata, ["repository", "run_id", "run_attempt", "commit", "event"]) ||
		value.metadata.repository !== "SakuyaInazaki/Mul-Pis" ||
		value.metadata.run_id !== source.runId ||
		value.metadata.run_attempt !== String(source.runAttempt) ||
		value.metadata.commit !== source.commit ||
		value.metadata.event !== terminalEvent) return false;
	const decoded = (encoded: unknown): Buffer | undefined => {
		if (typeof encoded !== "string" || encoded.length < 4 ||
			!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded))
			return undefined;
		const raw = Buffer.from(encoded, "base64");
		return raw.toString("base64") === encoded ? raw : undefined;
	};
	const wrapped = decoded(value.wrapped_key_b64), nonce = decoded(value.nonce_b64);
	const ciphertext = decoded(value.ciphertext_b64);
	if (!wrapped || wrapped.length !== 384 || !nonce || nonce.length !== 12 ||
		!ciphertext || ciphertext.length < 16 || ciphertext.length > 96 * 1024 * 1024 + 16)
		return false;
	return true;
}

/** The process-local brand is minted only after the actual connector-returned
 * encrypted result bytes are compared to a private operator decryption review,
 * the live terminal artifact identity, and the authenticated AEAD action. */
export async function readReviewedResultOnlyRepairState(input: Readonly<{
	privateReceiptFile: string;
	terminalProof: AuthenticatedTerminalCarryProof;
	privateBundle: PrivateContinuationBundle;
	terminalSourceTree: string;
	terminalEvent: "workflow_dispatch" | "push";
	encryptedEnvelopeBytes: Uint8Array;
}>): Promise<VerifiedResultOnlyRepairStateV1> {
	const projected = authenticatedSupervisorProjection(input.terminalProof, input.privateBundle);
	const resultArtifact = input.terminalProof.resultArtifact;
	if (!projected || !resultArtifact ||
		input.privateBundle["repair-state.json"] !== undefined ||
		!hex40(input.terminalSourceTree)) return reject("carried-action-mismatch");
	const { terminalCarry, pendingAction } = projected;
	if (!pendingAction || projected.status.stopReason !== "workflow-repair-needed" ||
		pendingAction.reasonCode !== "workflow-repair-needed" ||
		!pendingAction.evidenceRefs?.includes("repair-state.json") ||
		terminalCarry.pendingActionSha256 !== pendingActionIdentity(pendingAction))
		return reject("carried-action-mismatch");
	const { receipt, receiptSha256 } = await readReceipt(input.privateReceiptFile);
	const p = receipt.prior, a = receipt.result;
	if (!sameSource(p.source, terminalCarry.source) || p.sourceTree !== input.terminalSourceTree ||
		p.carryEnvelopeSha256 !== terminalCarry.envelopeSha256 ||
		p.checkpointSha256 !== terminalCarry.checkpointSha256 ||
		p.contractId !== terminalCarry.contractId ||
		p.selectedTupleSha256 !== terminalCarry.selectedTupleSha256 ||
		p.pendingActionSha256 !== terminalCarry.pendingActionSha256 ||
		a.artifactId !== resultArtifact.artifactId ||
		a.archiveSha256 !== resultArtifact.archiveSha256)
		reject("unrelated-receipt");
	if (!validEncryptedEnvelope(input.encryptedEnvelopeBytes, p.source, input.terminalEvent) ||
		digest(input.encryptedEnvelopeBytes) !== a.envelopeSha256)
		reject("envelope-mismatch");
	const bytes = receipt.repair.bytesUtf8;
	let state: unknown;
	try { state = JSON.parse(bytes) as unknown; }
	catch { return reject("invalid-receipt"); }
	if (digest(bytes) !== receipt.repair.sha256 || !validWorkflowRepairState(state) ||
		state.strategy !== "workflow-repair-needed" || state.stage !== pendingAction.failedStage ||
		(state.stage === "m04-judgment" ?
			!["unread-m07-evidence", "malformed-proposal", "rejected-draft",
				"context-handoff-unavailable", "provider-context-full"].includes(state.failure) :
			!["unread-evidence", "invalid-assessment", "blocked-with-capability",
				"unsupported-next-task", "context-handoff-unavailable", "provider-context-full"].includes(state.failure)))
		return reject("carried-action-mismatch");
	const result = Object.freeze({ stateBytes: bytes, state: Object.freeze({ ...state }),
		receiptSha256, resultEnvelopeSha256: a.envelopeSha256 });
	verified.add(result);
	return result as VerifiedResultOnlyRepairStateV1;
}
