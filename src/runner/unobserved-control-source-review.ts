/**
 * Private operator review for an accepted control commit whose Actions run was
 * not observed at admission. The review only licenses a fresh confined source
 * attempt. Historical execution, effects, charges and science remain unknown.
 * The operator judges semantics; this module checks identities and cited bytes.
 */
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

type Source = Readonly<{ runId: string; runAttempt: number; commit: string }>;
type CommitTree = Readonly<{ commit: string; tree: string }>;
type AcceptedControl = Readonly<{ commit: string; tree: string; parents: readonly string[] }>;

export type UnobservedControlSourceReviewRole =
	"host-native-execution-confinement" | "m07-local-tool-grant" |
	"fresh-workspace-store" | "session-constraints" |
	"encrypted-output-provider-transport";
const roles: readonly UnobservedControlSourceReviewRole[] = [
	"host-native-execution-confinement", "m07-local-tool-grant",
	"fresh-workspace-store", "session-constraints",
	"encrypted-output-provider-transport"
];
type CodeRef = Readonly<{ role: UnobservedControlSourceReviewRole; path: string;
	symbol: string }>;
type TestRef = Readonly<{ role: UnobservedControlSourceReviewRole; path: string;
	name: string }>;

export type UnobservedControlSourceReviewReceiptV1 = Readonly<{
	version: 1;
	kind: "host-reviewed-unobserved-control-source-capability";
	prior: Readonly<{
		oldJournalKey: string;
		oldAcceptedControl: AcceptedControl;
		oldTestedSource: CommitTree;
		priorCarrySource: Source;
		priorCarryEnvelopeSha256: string;
	}>;
	review: Readonly<{
		kind: "operator-code-review";
		conclusion: "approved-for-fresh-only-execution";
		codeEvidenceRefs: readonly CodeRef[];
		testEvidenceRefs: readonly TestRef[];
	}>;
	grant: Readonly<{
		mode: "fresh-only-confined-effects";
		oldExecution: "unknown-may-run-later";
		oldAccounting: "unquantified";
		oldScience: "untrusted-no-adoption";
		m07Tools: "factory-confined-local";
		/** M04/objective and review roles; M07 builders use the confined tool grant. */
		researchAndReviewerSessions: "read-only";
		state: "fresh-workspace-empty-store-no-resume";
		outputTransport: "encrypted-fixed";
		providerInference: "fixed-configured-provider";
	}>;
}>;

declare const verifiedUnobservedControlSource: unique symbol;
export type VerifiedUnobservedControlSourceCapabilityV1 = Readonly<{
	oldJournalKey: string;
	oldAcceptedControl: AcceptedControl;
	oldTestedSource: CommitTree;
	priorCarrySource: Source;
	priorCarryEnvelopeSha256: string;
	receiptSha256: string;
	[verifiedUnobservedControlSource]: true;
}>;
const verified = new WeakSet<object>();
export function isVerifiedUnobservedControlSourceCapability(value: unknown):
	value is VerifiedUnobservedControlSourceCapabilityV1 {
	return !!value && typeof value === "object" && verified.has(value);
}

export type ReviewUnobservedControlSourceInput = Readonly<{
	privateReceiptFile: string;
	oldJournalKey: string;
	oldAcceptedControl: AcceptedControl;
	oldTestedSource: CommitTree;
	priorCarrySource: Source;
	priorCarryEnvelopeSha256: string;
	/** Authenticated read of the tree at the immutable old tested source commit. */
	readImmutableSourceTree: (commit: string) => Promise<string>;
	/** Authenticated read of a file at that same immutable commit. */
	readImmutableSourceFile: (commit: string, file: string) => Promise<Uint8Array>;
}>;

export class UnobservedControlSourceReviewError extends Error {
	readonly code: "invalid-receipt" | "unrelated-receipt" | "evidence-unavailable";
	constructor(code: UnobservedControlSourceReviewError["code"]) {
		super(`unobserved control source review refused: ${code}`);
		this.code = code;
	}
}
const reject = (code: UnobservedControlSourceReviewError["code"]): never => {
	throw new UnobservedControlSourceReviewError(code);
};
const object = (v: unknown): v is Record<string, unknown> =>
	!!v && typeof v === "object" && !Array.isArray(v);
const exact = (v: unknown, keys: readonly string[]): v is Record<string, unknown> =>
	object(v) && Object.keys(v).sort().join("|") === [...keys].sort().join("|");
const hex40 = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{40}$/.test(v);
const hex64 = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{64}$/.test(v);
const numericId = (v: unknown): v is string => typeof v === "string" && /^[1-9][0-9]{0,17}$/.test(v);
const sha256 = (v: Uint8Array): string => createHash("sha256").update(v).digest("hex");
function source(v: unknown): v is Source {
	return exact(v, ["runId", "runAttempt", "commit"]) && numericId(v.runId) &&
		Number.isSafeInteger(v.runAttempt) && Number(v.runAttempt) > 0 && hex40(v.commit);
}
function commitTree(v: unknown): v is CommitTree {
	return exact(v, ["commit", "tree"]) && hex40(v.commit) && hex40(v.tree);
}
function control(v: unknown): v is AcceptedControl {
	return exact(v, ["commit", "tree", "parents"]) && hex40(v.commit) && hex40(v.tree) &&
		Array.isArray(v.parents) && (v.parents.length === 1 || v.parents.length === 2) &&
		v.parents.every(hex40) && new Set(v.parents).size === v.parents.length;
}
function coherent(controlCommit: AcceptedControl, tested: CommitTree): boolean {
	return controlCommit.commit !== tested.commit && controlCommit.tree === tested.tree &&
		controlCommit.parents[0] === tested.commit &&
		!controlCommit.parents.includes(controlCommit.commit);
}
const codePath = (v: unknown): v is string => typeof v === "string" && (
	/^src\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.ts$/.test(v) ||
	/^scripts\/[A-Za-z0-9_-]+\.(?:ts|py)$/.test(v) ||
	/^\.github\/workflows\/[A-Za-z0-9_-]+\.yml$/.test(v));
const testPath = (v: unknown): v is string => typeof v === "string" && (
	/^test\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.test\.ts$/.test(v) ||
	/^test\/[A-Za-z0-9_-]+_test\.py$/.test(v));
const marker = (v: unknown): v is string => typeof v === "string" &&
	v.length >= 4 && v.length <= 200 && !/[\r\n\0]/.test(v);
function refsValid(refs: unknown, kind: "code" | "test"): boolean {
	if (!Array.isArray(refs) || refs.length < roles.length) return false;
	if (!refs.every(ref => exact(ref, ["role", "path", kind === "code" ? "symbol" : "name"]) &&
		roles.includes(ref.role as UnobservedControlSourceReviewRole) &&
		(kind === "code" ? codePath(ref.path) && marker(ref.symbol) :
			testPath(ref.path) && marker(ref.name)))) return false;
	return roles.every(role => refs.some(ref => ref.role === role)) &&
		new Set(refs.map(ref => JSON.stringify(ref))).size === refs.length;
}
function validReceipt(v: unknown): v is UnobservedControlSourceReviewReceiptV1 {
	if (!exact(v, ["version", "kind", "prior", "review", "grant"]) || v.version !== 1 ||
		v.kind !== "host-reviewed-unobserved-control-source-capability") return false;
	const p = v.prior, r = v.review, g = v.grant;
	return exact(p, ["oldJournalKey", "oldAcceptedControl", "oldTestedSource",
		"priorCarrySource", "priorCarryEnvelopeSha256"]) &&
		hex64(p.oldJournalKey) && control(p.oldAcceptedControl) && commitTree(p.oldTestedSource) &&
		coherent(p.oldAcceptedControl, p.oldTestedSource) && source(p.priorCarrySource) &&
		hex64(p.priorCarryEnvelopeSha256) &&
		exact(r, ["kind", "conclusion", "codeEvidenceRefs", "testEvidenceRefs"]) &&
		r.kind === "operator-code-review" && r.conclusion === "approved-for-fresh-only-execution" &&
		refsValid(r.codeEvidenceRefs, "code") && refsValid(r.testEvidenceRefs, "test") &&
		exact(g, ["mode", "oldExecution", "oldAccounting", "oldScience", "m07Tools",
			"researchAndReviewerSessions", "state", "outputTransport", "providerInference"]) &&
		g.mode === "fresh-only-confined-effects" && g.oldExecution === "unknown-may-run-later" &&
		g.oldAccounting === "unquantified" && g.oldScience === "untrusted-no-adoption" &&
		g.m07Tools === "factory-confined-local" &&
		g.researchAndReviewerSessions === "read-only" &&
		g.state === "fresh-workspace-empty-store-no-resume" &&
		g.outputTransport === "encrypted-fixed" && g.providerInference === "fixed-configured-provider";
}

const checkout = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
function inside(file: string, root: string): boolean {
	const relative = path.relative(root, file);
	return relative === "" || relative !== ".." && !relative.startsWith(`..${path.sep}`) &&
		!path.isAbsolute(relative);
}
async function readPrivateReceipt(file: string): Promise<{
	receipt: UnobservedControlSourceReviewReceiptV1; digest: string }> {
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
		let parsed: unknown;
		try { parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
		catch { return reject("invalid-receipt"); }
		if (!validReceipt(parsed)) return reject("invalid-receipt");
		return { receipt: parsed, digest: sha256(bytes) };
	} catch (error) {
		if (error instanceof UnobservedControlSourceReviewError) throw error;
		return reject("invalid-receipt");
	} finally { await handle?.close(); }
}

/** The caller authenticates the journal, accepted commit and prior carry. */
export async function readReviewedUnobservedControlSourceCapability(
	input: ReviewUnobservedControlSourceInput): Promise<VerifiedUnobservedControlSourceCapabilityV1> {
	const { receipt, digest } = await readPrivateReceipt(input.privateReceiptFile);
	const p = receipt.prior;
	if (!hex64(input.oldJournalKey) || !control(input.oldAcceptedControl) ||
		!commitTree(input.oldTestedSource) || !coherent(input.oldAcceptedControl, input.oldTestedSource) ||
		!source(input.priorCarrySource) || !hex64(input.priorCarryEnvelopeSha256) ||
		p.oldJournalKey !== input.oldJournalKey ||
		p.oldAcceptedControl.commit !== input.oldAcceptedControl.commit ||
		p.oldAcceptedControl.tree !== input.oldAcceptedControl.tree ||
		JSON.stringify(p.oldAcceptedControl.parents) !== JSON.stringify(input.oldAcceptedControl.parents) ||
		p.oldTestedSource.commit !== input.oldTestedSource.commit ||
		p.oldTestedSource.tree !== input.oldTestedSource.tree ||
		p.priorCarrySource.runId !== input.priorCarrySource.runId ||
		p.priorCarrySource.runAttempt !== input.priorCarrySource.runAttempt ||
		p.priorCarrySource.commit !== input.priorCarrySource.commit ||
		p.priorCarryEnvelopeSha256 !== input.priorCarryEnvelopeSha256)
		reject("unrelated-receipt");
	try {
		if (await input.readImmutableSourceTree(p.oldTestedSource.commit) !== p.oldTestedSource.tree)
			reject("evidence-unavailable");
	} catch { return reject("evidence-unavailable"); }
	const cache = new Map<string, Uint8Array>();
	const read = async (file: string): Promise<Uint8Array> => {
		const cached = cache.get(file);
		if (cached) return cached;
		try {
			const bytes = await input.readImmutableSourceFile(p.oldTestedSource.commit, file);
			if (!(bytes instanceof Uint8Array) || bytes.length < 1 || bytes.length > 1024 * 1024)
				reject("evidence-unavailable");
			cache.set(file, bytes);
			return bytes;
		} catch { return reject("evidence-unavailable"); }
	};
	const containsMarker = (bytes: Uint8Array, text: string): boolean => {
		try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes).includes(text); }
		catch { return false; }
	};
	for (const ref of receipt.review.codeEvidenceRefs) {
		const bytes = await read(ref.path);
		if (!containsMarker(bytes, ref.symbol))
			reject("evidence-unavailable");
	}
	for (const ref of receipt.review.testEvidenceRefs) {
		const bytes = await read(ref.path);
		if (!containsMarker(bytes, ref.name))
			reject("evidence-unavailable");
	}
	const result = Object.freeze({ oldJournalKey: p.oldJournalKey,
		oldAcceptedControl: Object.freeze({ ...p.oldAcceptedControl,
			parents: Object.freeze([...p.oldAcceptedControl.parents]) }),
		oldTestedSource: Object.freeze({ ...p.oldTestedSource }),
		priorCarrySource: Object.freeze({ ...p.priorCarrySource }),
		priorCarryEnvelopeSha256: p.priorCarryEnvelopeSha256, receiptSha256: digest });
	verified.add(result);
	return result as VerifiedUnobservedControlSourceCapabilityV1;
}
