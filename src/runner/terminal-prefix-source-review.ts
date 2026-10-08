/** Private operator review of the exact source of a resultless, prefix-backed
 * terminal run. The prefix is only partial control evidence. This grants one
 * fresh confined attempt and never adopts old research, effects, or fees. */
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { TerminalPrefixInterruptionEvidenceV1 } from "./mission-supervisor.ts";
import type { InterruptedSourceReviewRole } from
	"./interrupted-source-review.ts";

type Source = TerminalPrefixInterruptionEvidenceV1["source"];
export type TerminalPrefixSourceReviewRole = InterruptedSourceReviewRole |
	"periodic-prefix-transport" | "trusted-artifact-runtime-parent" |
	"child-runtime-credential-exclusion";
/** M07 builder sessions use factory-confined local tools. Only the separate
 * assessor and M04 reviewer sessions are read-only. */
export type TerminalPrefixSourceGrantV1 = Readonly<{
	mode: "fresh-only-confined-effects";
	oldResultUse: "untrusted-no-replay-no-adoption";
	m07Tools: "factory-confined-local";
	assessorAndM04ReviewerSessions: "read-only";
	state: "fresh-workspace-empty-store-no-resume";
	outputTransport: "encrypted-fixed";
	providerInference: "fixed-configured-provider";
}>;
/** The operator must review each semantic boundary in the interrupted commit.
 * Paths are evidence references, not a fixed source-layout or run-specific pin. */
const roles: readonly TerminalPrefixSourceReviewRole[] = ["m07-local-tool-confinement",
	"read-only-model-sessions", "fresh-workspace-store", "host-execution-confinement",
	"encrypted-output-provider", "periodic-prefix-transport",
	"trusted-artifact-runtime-parent", "child-runtime-credential-exclusion"];
export type TerminalPrefixSourceReviewReceiptV1 = Readonly<{
	version: 1; kind: "host-reviewed-terminal-prefix-source-capability";
	prior: Readonly<{ interruption: TerminalPrefixInterruptionEvidenceV1;
		sourceTree: string; priorCheckpointSha256: string }>;
	review: Readonly<{ kind: "operator-code-review";
		conclusion: "approved-for-fresh-only-execution";
		codeEvidenceRefs: readonly Readonly<{ role: TerminalPrefixSourceReviewRole;
			path: string; symbol: string }>[];
		testEvidenceRefs: readonly Readonly<{ role: TerminalPrefixSourceReviewRole;
			path: string; name: string }>[] }>;
	grant: TerminalPrefixSourceGrantV1;
}>;
declare const terminalPrefixSourceBrand: unique symbol;
export type VerifiedTerminalPrefixSourceCapabilityV1 = Readonly<{
	source: Source; sourceTree: string; grant: TerminalPrefixSourceGrantV1;
	receiptSha256: string; [terminalPrefixSourceBrand]: true;
}>;
const branded = new WeakSet<object>();
export function isVerifiedTerminalPrefixSourceCapability(value: unknown):
	value is VerifiedTerminalPrefixSourceCapabilityV1 {
	return !!value && typeof value === "object" && branded.has(value);
}
export class TerminalPrefixSourceReviewError extends Error {
	readonly code: "invalid-receipt" | "unrelated-receipt" | "evidence-unavailable";
	constructor(code: "invalid-receipt" | "unrelated-receipt" |
		"evidence-unavailable") {
		super(`terminal prefix source review refused: ${code}`);
		this.code = code;
	}
}
const reject = (code: TerminalPrefixSourceReviewError["code"]): never => {
	throw new TerminalPrefixSourceReviewError(code);
};
const object = (v: unknown): v is Record<string, unknown> =>
	!!v && typeof v === "object" && !Array.isArray(v);
const exact = (v: unknown, keys: readonly string[]): v is Record<string, unknown> =>
	object(v) && Object.keys(v).sort().join("|") === [...keys].sort().join("|");
const hex40 = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{40}$/.test(v);
const hex64 = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{64}$/.test(v);
const codePath = (v: unknown): v is string => typeof v === "string" &&
	(/^src\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.ts$/.test(v) ||
	/^scripts\/[A-Za-z0-9_-]+\.(?:ts|py|mjs|yml)$/.test(v) ||
	/^\.github\/workflows\/[A-Za-z0-9_-]+\.yml$/.test(v));
const testPath = (v: unknown): v is string => typeof v === "string" &&
	(/^test\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.test\.ts$/.test(v) ||
	/^test\/[A-Za-z0-9_-]+_test\.py$/.test(v));
const ref = (v: unknown): v is string => typeof v === "string" &&
	v.length > 0 && !/[\r\n\0]/.test(v);
function canonical(v: unknown): string {
	if (v === null || typeof v === "string" || typeof v === "boolean") return JSON.stringify(v);
	if (typeof v === "number" && Number.isFinite(v)) return JSON.stringify(v);
	if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
	if (object(v)) return `{${Object.entries(v).sort(([a], [b]) => a.localeCompare(b))
		.map(([k, item]) => `${JSON.stringify(k)}:${canonical(item)}`).join(",")}}`;
	return reject("invalid-receipt");
}
function validReceipt(v: unknown): v is TerminalPrefixSourceReviewReceiptV1 {
	if (!exact(v, ["version", "kind", "prior", "review", "grant"]) || v.version !== 1 ||
		v.kind !== "host-reviewed-terminal-prefix-source-capability" ||
		!exact(v.prior, ["interruption", "sourceTree", "priorCheckpointSha256"]) ||
		!hex40(v.prior.sourceTree) || !hex64(v.prior.priorCheckpointSha256) ||
		!exact(v.review, ["kind", "conclusion", "codeEvidenceRefs", "testEvidenceRefs"]) ||
		v.review.kind !== "operator-code-review" ||
		v.review.conclusion !== "approved-for-fresh-only-execution" ||
		!Array.isArray(v.review.codeEvidenceRefs) ||
		!Array.isArray(v.review.testEvidenceRefs) ||
		!exact(v.grant, ["mode", "oldResultUse", "m07Tools",
			"assessorAndM04ReviewerSessions", "state",
			"outputTransport", "providerInference"]) ||
		v.grant.mode !== "fresh-only-confined-effects" ||
		v.grant.oldResultUse !== "untrusted-no-replay-no-adoption" ||
		v.grant.m07Tools !== "factory-confined-local" ||
		v.grant.assessorAndM04ReviewerSessions !== "read-only" ||
		v.grant.state !== "fresh-workspace-empty-store-no-resume" ||
		v.grant.outputTransport !== "encrypted-fixed" ||
		v.grant.providerInference !== "fixed-configured-provider") return false;
	const code = v.review.codeEvidenceRefs as unknown[];
	const tests = v.review.testEvidenceRefs as unknown[];
	return code.length >= roles.length && tests.length >= roles.length &&
		code.every(x => exact(x, ["role", "path", "symbol"]) &&
			roles.includes(x.role as TerminalPrefixSourceReviewRole) && codePath(x.path) && ref(x.symbol)) &&
		tests.every(x => exact(x, ["role", "path", "name"]) &&
			roles.includes(x.role as TerminalPrefixSourceReviewRole) && testPath(x.path) && ref(x.name)) &&
		roles.every(role => code.some(x => (x as {role?: unknown}).role === role) &&
			tests.some(x => (x as {role?: unknown}).role === role)) &&
		new Set(code.map(canonical)).size === code.length &&
		new Set(tests.map(canonical)).size === tests.length;
}
const checkout = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
function inside(file: string, root: string): boolean {
	const relative = path.relative(root, file);
	return relative === "" || relative !== ".." && !relative.startsWith(`..${path.sep}`) &&
		!path.isAbsolute(relative);
}
export async function readReviewedTerminalPrefixSourceCapability(input: Readonly<{
	privateReceiptFile: string; interruption: TerminalPrefixInterruptionEvidenceV1;
	interruptedSourceTree: string; priorCheckpointSha256: string;
	readImmutableSourceFile: (commit: string, file: string) => Promise<Uint8Array>;
}>): Promise<VerifiedTerminalPrefixSourceCapabilityV1> {
	const file = input.privateReceiptFile;
	if (!path.isAbsolute(file)) reject("invalid-receipt");
	let receipt: TerminalPrefixSourceReviewReceiptV1;
	let digest: string;
	let handle;
	try {
		const [actual, root] = await Promise.all([realpath(file), realpath(checkout)]);
		if (inside(actual, root) || inside(file, root)) reject("invalid-receipt");
		handle = await open(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
		const before = await handle.stat();
		if (!before.isFile() || (before.mode & 0o777) !== 0o600 ||
			before.size < 1 || before.size > 64 * 1024) reject("invalid-receipt");
		const bytes = await handle.readFile();
		const after = await handle.stat();
		if (bytes.length !== before.size || after.size !== before.size ||
			after.mtimeMs !== before.mtimeMs) reject("invalid-receipt");
		const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
		if (!validReceipt(parsed)) return reject("invalid-receipt");
		receipt = parsed; digest = createHash("sha256").update(bytes).digest("hex");
	} catch (error) {
		if (error instanceof TerminalPrefixSourceReviewError) throw error;
		return reject("invalid-receipt");
	} finally { await handle?.close(); }
	if (!hex40(input.interruptedSourceTree) || !hex64(input.priorCheckpointSha256) ||
		canonical(receipt.prior.interruption) !== canonical(input.interruption) ||
		receipt.prior.sourceTree !== input.interruptedSourceTree ||
		receipt.prior.priorCheckpointSha256 !== input.priorCheckpointSha256)
		reject("unrelated-receipt");
	const texts = new Map<string, string>();
	const read = async (sourceFile: string): Promise<string> => {
		if (texts.has(sourceFile)) return texts.get(sourceFile)!;
		try {
			const bytes = await input.readImmutableSourceFile(input.interruption.source.commit, sourceFile);
			if (!(bytes instanceof Uint8Array) || bytes.length < 1 || bytes.length > 1024 * 1024)
				reject("evidence-unavailable");
			const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
			texts.set(sourceFile, text); return text;
		} catch { return reject("evidence-unavailable"); }
	};
	for (const item of receipt.review.codeEvidenceRefs)
		if (!(await read(item.path)).includes(item.symbol)) reject("evidence-unavailable");
	for (const item of receipt.review.testEvidenceRefs)
		if (!(await read(item.path)).includes(item.name)) reject("evidence-unavailable");
	const result = Object.freeze({ source: Object.freeze({ ...input.interruption.source }),
		sourceTree: receipt.prior.sourceTree, grant: Object.freeze({ ...receipt.grant }),
		receiptSha256: digest });
	branded.add(result);
	return result as VerifiedTerminalPrefixSourceCapabilityV1;
}
