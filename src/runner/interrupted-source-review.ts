/**
 * Private, host-reviewed authority for a fresh attempt after a terminal
 * executed run with no carry. File references establish which immutable bytes
 * the operator reviewed; their presence is not a semantic safety proof.
 */
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { TerminalInterruptionEvidenceV1 } from "./mission-supervisor.ts";

type Source = TerminalInterruptionEvidenceV1["source"];
export type InterruptedSourceReviewRole =
	"m07-builder-confined-writes" | "objective-assessor-read-only" |
	"m04-reviewer-read-only" | "m07-reviewer-read-only" |
	"fresh-workspace-store" | "host-execution-confinement" |
	"encrypted-output-provider";
const roles: readonly InterruptedSourceReviewRole[] = [
	"m07-builder-confined-writes", "objective-assessor-read-only",
	"m04-reviewer-read-only", "m07-reviewer-read-only",
	"fresh-workspace-store", "host-execution-confinement",
	"encrypted-output-provider"
];
/** Separately names the writable builder and each read-only review role. */
export type InterruptedSourceGrantV2 = Readonly<{
	mode: "fresh-only-confined-effects";
	oldResultUse: "untrusted-no-replay-no-adoption";
	m07BuilderToolGrant: "factory-confined-task-file-writes";
	objectiveAssessorToolGrant: "read-only";
	m04ReviewerToolGrant: "read-only";
	m07ReviewerToolGrant: "read-only";
	state: "fresh-workspace-empty-store-no-resume";
	outputTransport: "encrypted-fixed";
	providerInference: "fixed-configured-provider";
}>;
export type InterruptedSourceReviewReceiptV2 = Readonly<{
	version: 2;
	kind: "host-reviewed-interrupted-source-capability";
	prior: Readonly<{
		source: Source;
		sourceTree: string;
		priorCarrySource: TerminalInterruptionEvidenceV1["priorCarrySource"];
		priorCarryEnvelopeSha256: string;
		priorCheckpointSha256: string;
		resultArtifactId: string;
		resultArchiveSha256: string;
	}>;
	review: Readonly<{
		kind: "operator-code-review";
		conclusion: "approved-for-fresh-only-execution";
		codeEvidenceRefs: readonly Readonly<{ role: InterruptedSourceReviewRole; path: string; symbol: string }>[];
		testEvidenceRefs: readonly Readonly<{ role: InterruptedSourceReviewRole; path: string; name: string }>[];
	}>;
	grant: InterruptedSourceGrantV2;
}>;
declare const verifiedInterruptedSource: unique symbol;
export type VerifiedInterruptedSourceCapabilityV2 = Readonly<{
	source: Source;
	sourceTree: string;
	grant: InterruptedSourceGrantV2;
	receiptSha256: string;
	[verifiedInterruptedSource]: true;
}>;
const verified = new WeakSet<object>();
export function isVerifiedInterruptedSourceCapability(value: unknown): value is VerifiedInterruptedSourceCapabilityV2 {
	return !!value && typeof value === "object" && verified.has(value);
}

export type ReviewInterruptedSourceInput = Readonly<{
	privateReceiptFile: string;
	interruption: TerminalInterruptionEvidenceV1;
	/** The caller checked this tree against the immutable interrupted GitHub commit. */
	interruptedSourceTree: string;
	/** From the authenticated preceding AEAD checkpoint, not the opaque result. */
	priorCheckpointSha256: string;
	/** Host read of a file at the exact immutable interrupted commit. */
	readImmutableSourceFile: (commit: string, file: string) => Promise<Uint8Array>;
}>;

export class InterruptedSourceReviewError extends Error {
	readonly code: "invalid-receipt" | "unrelated-receipt" | "evidence-unavailable";
	constructor(code: "invalid-receipt" | "unrelated-receipt" | "evidence-unavailable") {
		super(`interrupted source review refused: ${code}`);
		this.code = code;
	}
}
const reject = (code: InterruptedSourceReviewError["code"]): never => { throw new InterruptedSourceReviewError(code); };
const object = (value: unknown): value is Record<string, unknown> =>
	!!value && typeof value === "object" && !Array.isArray(value);
const exact = (value: unknown, keys: readonly string[]): value is Record<string, unknown> =>
	object(value) && Object.keys(value).sort().join("|") === [...keys].sort().join("|");
const hex40 = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{40}$/.test(value);
const hex64 = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
const numericId = (value: unknown): value is string => typeof value === "string" && /^[1-9][0-9]{0,17}$/.test(value);
function source(value: unknown): value is Source {
	return exact(value, ["runId", "runAttempt", "commit"]) && numericId(value.runId) &&
		Number.isSafeInteger(value.runAttempt) && Number(value.runAttempt) > 0 && hex40(value.commit);
}
function sameSource(a: Source, b: Source): boolean {
	return a.runId === b.runId && a.runAttempt === b.runAttempt && a.commit === b.commit;
}
const codePath = (value: unknown): value is string => typeof value === "string" && (
	/^src\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.ts$/.test(value) ||
	/^scripts\/[A-Za-z0-9_-]+\.(?:ts|py)$/.test(value) ||
	/^\.github\/workflows\/[A-Za-z0-9_-]+\.yml$/.test(value));
const testPath = (value: unknown): value is string => typeof value === "string" &&
	(/^test\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.test\.ts$/.test(value) ||
	/^test\/[A-Za-z0-9_-]+_test\.py$/.test(value));
const refText = (value: unknown): value is string => typeof value === "string" &&
	value.length > 0 && !/[\r\n\0]/.test(value);
function validReceipt(value: unknown): value is InterruptedSourceReviewReceiptV2 {
	if (!exact(value, ["version", "kind", "prior", "review", "grant"]) || value.version !== 2 ||
		value.kind !== "host-reviewed-interrupted-source-capability") return false;
	const p = value.prior, r = value.review, g = value.grant;
	if (!exact(p, ["source", "sourceTree", "priorCarrySource", "priorCarryEnvelopeSha256",
		"priorCheckpointSha256", "resultArtifactId", "resultArchiveSha256"]) ||
		!source(p.source) || !source(p.priorCarrySource) || !hex40(p.sourceTree) ||
		!hex64(p.priorCarryEnvelopeSha256) || !hex64(p.priorCheckpointSha256) ||
		!numericId(p.resultArtifactId) || !hex64(p.resultArchiveSha256) ||
		!exact(g, ["mode", "oldResultUse", "m07BuilderToolGrant",
			"objectiveAssessorToolGrant", "m04ReviewerToolGrant", "m07ReviewerToolGrant", "state",
			"outputTransport", "providerInference"]) ||
		g.mode !== "fresh-only-confined-effects" ||
		g.oldResultUse !== "untrusted-no-replay-no-adoption" ||
		g.m07BuilderToolGrant !== "factory-confined-task-file-writes" ||
		g.objectiveAssessorToolGrant !== "read-only" ||
		g.m04ReviewerToolGrant !== "read-only" ||
		g.m07ReviewerToolGrant !== "read-only" ||
		g.state !== "fresh-workspace-empty-store-no-resume" ||
		g.outputTransport !== "encrypted-fixed" || g.providerInference !== "fixed-configured-provider" ||
		!exact(r, ["kind", "conclusion", "codeEvidenceRefs", "testEvidenceRefs"]) ||
		r.kind !== "operator-code-review" || r.conclusion !== "approved-for-fresh-only-execution" ||
		!Array.isArray(r.codeEvidenceRefs) || !Array.isArray(r.testEvidenceRefs) ||
		r.codeEvidenceRefs.length < roles.length ||
		r.testEvidenceRefs.length < roles.length) return false;
	const codeRefs = r.codeEvidenceRefs as unknown[];
	const testRefs = r.testEvidenceRefs as unknown[];
	if (!codeRefs.every(x => exact(x, ["role", "path", "symbol"]) &&
		roles.includes(x.role as InterruptedSourceReviewRole) && codePath(x.path) && refText(x.symbol)) ||
		!testRefs.every(x => exact(x, ["role", "path", "name"]) &&
			roles.includes(x.role as InterruptedSourceReviewRole) && testPath(x.path) && refText(x.name))) return false;
	return roles.every(role => codeRefs.some(x => (x as { role?: unknown }).role === role) &&
		testRefs.some(x => (x as { role?: unknown }).role === role)) &&
		new Set(codeRefs.map(x => JSON.stringify(x))).size === codeRefs.length &&
		new Set(testRefs.map(x => JSON.stringify(x))).size === testRefs.length;
}

const checkout = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
function inside(file: string, root: string): boolean {
	const relative = path.relative(root, file);
	return relative === "" || relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
async function readPrivateReceipt(file: string): Promise<{ receipt: InterruptedSourceReviewReceiptV2; digest: string }> {
	if (!path.isAbsolute(file)) reject("invalid-receipt");
	let handle;
	try {
		const [actual, root] = await Promise.all([realpath(file), realpath(checkout)]);
		if (inside(actual, root) || inside(file, root)) reject("invalid-receipt");
		handle = await open(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
		const before = await handle.stat();
		if (!before.isFile() || (before.mode & 0o777) !== 0o600 || before.size < 1 ||
			before.size > 64 * 1024) reject("invalid-receipt");
		const bytes = await handle.readFile();
		const after = await handle.stat();
		if (bytes.length !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs)
			reject("invalid-receipt");
		let parsed: unknown;
		try { parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
		catch { return reject("invalid-receipt"); }
		if (!validReceipt(parsed)) return reject("invalid-receipt");
		return { receipt: parsed, digest: createHash("sha256").update(bytes).digest("hex") };
	} catch (error) {
		if (error instanceof InterruptedSourceReviewError) throw error;
		return reject("invalid-receipt");
	} finally { await handle?.close(); }
}

/** Caller authenticates the terminal interruption and GitHub commit/tree first.
 * This validates the private operator receipt and resolves its references at
 * those exact source bytes. Only the operator judges the code's semantics. */
export async function readReviewedInterruptedSourceCapability(input: ReviewInterruptedSourceInput):
	Promise<VerifiedInterruptedSourceCapabilityV2> {
	const { receipt, digest } = await readPrivateReceipt(input.privateReceiptFile);
	const interruption = input.interruption;
	if (interruption?.version !== 1 || interruption.kind !== "host-verified-terminal-interruption" ||
		!source(interruption.source) || !source(interruption.priorCarrySource) ||
		!hex64(interruption.priorCarryEnvelopeSha256) || !numericId(interruption.resultArtifactId) ||
		!hex64(interruption.resultArchiveSha256) || !hex40(input.interruptedSourceTree) ||
		!hex64(input.priorCheckpointSha256) || interruption.accounting !== "unquantified" ||
		interruption.effects !== "unknown-unreconciled" || interruption.terminationOrigin !== "unknown" ||
		interruption.source.runId === interruption.priorCarrySource.runId)
		reject("unrelated-receipt");
	const p = receipt.prior;
	if (!sameSource(p.source, interruption.source) || p.sourceTree !== input.interruptedSourceTree ||
		!sameSource(p.priorCarrySource, interruption.priorCarrySource) ||
		p.priorCarryEnvelopeSha256 !== interruption.priorCarryEnvelopeSha256 ||
		p.priorCheckpointSha256 !== input.priorCheckpointSha256 ||
		p.resultArtifactId !== interruption.resultArtifactId ||
		p.resultArchiveSha256 !== interruption.resultArchiveSha256)
		reject("unrelated-receipt");
	const texts = new Map<string, string>();
	const read = async (file: string): Promise<string> => {
		const cached = texts.get(file);
		if (cached !== undefined) return cached;
		try {
			const bytes = await input.readImmutableSourceFile(p.source.commit, file);
			if (!(bytes instanceof Uint8Array) || bytes.length < 1 || bytes.length > 1024 * 1024)
				reject("evidence-unavailable");
			const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
			texts.set(file, text);
			return text;
		} catch { return reject("evidence-unavailable"); }
	};
	for (const ref of receipt.review.codeEvidenceRefs) {
		if (!(await read(ref.path)).includes(ref.symbol)) reject("evidence-unavailable");
	}
	for (const ref of receipt.review.testEvidenceRefs) {
		const content = await read(ref.path);
		if (!content.includes(ref.name)) reject("evidence-unavailable");
	}
	const grant = Object.freeze({ ...receipt.grant });
	const result = Object.freeze({ source: Object.freeze({ ...p.source }), sourceTree: p.sourceTree,
		grant, receiptSha256: digest });
	verified.add(result);
	return result as VerifiedInterruptedSourceCapabilityV2;
}
