/**
 * Private host bridge. In --connector-stdio mode a caller handles each printed
 * public GitHub GET through its existing read-only connector. Only the final
 * public commit descriptor may be copied into a GitHub create-commit call.
 * No ref update or model request occurs here.
 */
import { createInterface } from "node:readline";
import { createHash } from "node:crypto";
import { lstat, open, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { prepareAuthenticatedResumeRequest } from "../src/runner/mission-host-adapter.ts";
import { MissionResumeJournal } from "../src/runner/mission-resume-journal.ts";
import type { CurrentMissionRun } from "../src/runner/ledger-continuation.ts";
import { HarnessError } from "../src/types.ts";

type Args = { source: string; seed: string; publicKey: string;
	journalDir: string; outputPrivate: string; readOnly: boolean };
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
class PrivateBridgeError extends Error {
	readonly reasonCode: string;
	constructor(reasonCode: string) { super(reasonCode); this.reasonCode = reasonCode; }
}
function underRepo(file: string): boolean {
	const relative = path.relative(repoRoot, file);
	return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) &&
		!path.isAbsolute(relative));
}
function parseArgs(values: string[]): Args {
	const option = new Map<string, string>();
	let connectorStdio = false;
	let readOnly = false;
	for (let i = 0; i < values.length; i++) {
		const name = values[i]!;
		if (name === "--connector-stdio") { connectorStdio = true; continue; }
		if (name === "--read-only") { readOnly = true; continue; }
		if (!name.startsWith("--") || option.has(name) || i + 1 >= values.length)
			throw new Error("invalid private resume arguments");
		option.set(name, values[++i]!);
	}
	const keys = ["--source", "--seed", "--public-key", "--journal-dir", "--output-private"];
	if (!connectorStdio || option.size !== keys.length || keys.some(key => !option.has(key)) ||
		[...option.keys()].some(key => !keys.includes(key)))
		throw new Error("missing private resume arguments");
	const result = { source: option.get("--source")!, seed: option.get("--seed")!,
		publicKey: option.get("--public-key")!, journalDir: option.get("--journal-dir")!,
		outputPrivate: option.get("--output-private")!, readOnly };
	if (Object.entries(result).some(([key, value]) => key !== "readOnly" &&
		!path.isAbsolute(String(value)))) throw new Error("private resume paths must be absolute");
	if (underRepo(result.journalDir) || underRepo(result.outputPrivate))
		throw new Error("private resume records must be outside the source repository");
	return result;
}

/** All requests remain on the fixed repository's public metadata REST surface.
 * The connector response is trusted as the read-only GitHub account result. */
function connectorBridge(): { request: typeof fetch;
	artifact: (identity: { runId: string; artifactId: string }) => Promise<string>;
	close: () => void } {
	const pending = new Map<number, { kind: "github-get" | "artifact-file";
		resolve: (value: unknown) => void;
		reject: (error: Error) => void }>();
	let closed = false;
	const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
	lines.on("line", line => {
		let reply: { id?: unknown; status?: unknown; body?: unknown;
			file?: unknown; sha256?: unknown };
		try { reply = JSON.parse(line) as typeof reply; }
		catch { return; }
		if (!Number.isSafeInteger(reply.id)) return;
		const awaiting = pending.get(Number(reply.id));
		if (!awaiting) return;
		pending.delete(Number(reply.id));
		if (awaiting.kind === "github-get") {
			if (!Number.isSafeInteger(reply.status) || Number(reply.status) < 200 ||
				Number(reply.status) > 599 || reply.file !== undefined) {
				awaiting.reject(new Error("GitHub connector response status is invalid")); return;
			}
			awaiting.resolve(new Response(JSON.stringify(reply.body), { status: Number(reply.status) }));
		} else {
			if (typeof reply.file !== "string" || !path.isAbsolute(reply.file) ||
				typeof reply.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(reply.sha256) ||
				reply.body !== undefined || reply.status !== undefined) {
				awaiting.reject(new Error("artifact file reply is invalid")); return;
			}
			awaiting.resolve({ file: reply.file, sha256: reply.sha256 });
		}
	});
	lines.on("close", () => {
		closed = true;
		for (const awaiting of pending.values())
			awaiting.reject(new PrivateBridgeError("authenticated-github-connector-stdin-closed"));
		pending.clear();
	});
	let nextId = 0;
	const request: typeof fetch = async (input): Promise<Response> => {
		if (closed || process.stdin.readableEnded)
			throw new PrivateBridgeError("authenticated-github-connector-stdin-closed");
		const url = String(input);
		if (!url.startsWith("https://api.github.com/repos/SakuyaInazaki/Mul-Pis/"))
			throw new Error("private resume requested an unexpected GitHub URL");
		const id = ++nextId;
		const response = new Promise<Response>((resolve, reject) => pending.set(id,
			{ kind: "github-get", resolve: value => resolve(value as Response), reject }));
		process.stdout.write(`${JSON.stringify({ kind: "github-get", id, url })}\n`);
		return response;
	};
	const artifact = async (identity: { runId: string; artifactId: string }): Promise<string> => {
		if (closed || process.stdin.readableEnded)
			throw new PrivateBridgeError("authenticated-github-connector-stdin-closed");
		const id = ++nextId;
		const reply = new Promise<{ file: string; sha256: string }>((resolve, reject) =>
			pending.set(id, { kind: "artifact-file", resolve: value =>
				resolve(value as { file: string; sha256: string }), reject }));
		process.stdout.write(`${JSON.stringify({ kind: "artifact-file", id,
			runId: identity.runId, artifactId: identity.artifactId })}\n`);
		const observed = await reply;
		const meta = await lstat(observed.file);
		if (!meta.isFile() || (meta.mode & 0o077) !== 0 || meta.size > 8 * 1024 * 1024)
			throw new Error("artifact file is not private and regular");
		const bytes = await readFile(observed.file);
		if (createHash("sha256").update(bytes).digest("hex") !== observed.sha256)
			throw new Error("artifact file changed after connector verification");
		const outer = JSON.parse(bytes.toString("utf8")) as unknown;
		if (!outer || typeof outer !== "object" || Array.isArray(outer) ||
			Object.keys(outer).length !== 1 ||
			typeof (outer as { envelopeB64?: unknown }).envelopeB64 !== "string")
			throw new Error("artifact file format is invalid");
		return (outer as { envelopeB64: string }).envelopeB64;
	};
	return { request, artifact, close: () => lines.close() };
}

/** The second argument is used only by synthetic signed-seed tests. The CLI
 * below always uses the mission's pinned production signing key. */
export async function runPrivateResumeBridge(values: string[],
	testOnly?: Readonly<{ expectedSpkiSha256: string }>): Promise<void> {
	const args = parseArgs(values);
	if (underRepo(await realpath(path.dirname(args.outputPrivate))) ||
		underRepo(await realpath(path.dirname(args.journalDir))))
		throw new Error("private resume directory resolves inside the source repository");
	const seedInfo = await lstat(args.seed);
	if (!seedInfo.isFile() || (seedInfo.mode & 0o077) !== 0)
		throw new Error("signed mission seed file is not private and regular");
	const source = JSON.parse(await readFile(args.source, "utf8")) as CurrentMissionRun;
	if (source?.manualAuthorized !== "true")
		throw new PrivateBridgeError("source-authorization-flag-missing");
	const seedEnvelopeB64 = (await readFile(args.seed, "utf8")).trim();
	const bridge = connectorBridge();
	let result: Awaited<ReturnType<typeof prepareAuthenticatedResumeRequest>>;
	try {
		result = await prepareAuthenticatedResumeRequest({ source, seedEnvelopeB64,
			publicKeyFile: args.publicKey,
			...(testOnly ? { expectedSpkiSha256: testOnly.expectedSpkiSha256 } : {}),
			githubToken: undefined,
			authenticatedHostRead: { kind: "authenticated-host-github-read", request: bridge.request },
			loadCarryArtifact: identity => bridge.artifact(identity),
			journal: new MissionResumeJournal(args.journalDir), readOnly: args.readOnly });
	} finally { bridge.close(); }
	if (!args.readOnly) {
		const handle = await open(args.outputPrivate, "wx", 0o600);
		try { await handle.writeFile(`${JSON.stringify(result)}\n`); await handle.sync(); }
		finally { await handle.close(); }
	}
	process.stdout.write(`${JSON.stringify(result.descriptor ?
		{ kind: args.readOnly ? "planned-read-only" : "prepared", descriptor: result.descriptor } :
		{ kind: "no-dispatch", decisionKind: result.decision.kind })}\n`);
}

async function savePrivateFailure(values: string[], error: unknown): Promise<void> {
	const index = values.indexOf("--output-private");
	const target = index >= 0 ? values[index + 1] : undefined;
	if (!target || !path.isAbsolute(target) || underRepo(target) ||
		underRepo(await realpath(path.dirname(target)))) return;
	const diagnostic = error instanceof PrivateBridgeError ?
		{ code: error.reasonCode } : error instanceof HarnessError &&
		/^(?:runner\.ledger-continuation|runner\.signed-mission-ledger|runner\.mission)/.test(error.code) &&
		/^[A-Za-z0-9 .,;:()_\-]{1,250}$/.test(error.message) ?
		{ code: error.code, detail: error.message } :
		{ code: "unclassified-host-preparation-error" };
	const handle = await open(target, "wx", 0o600);
	try { await handle.writeFile(`${JSON.stringify({ version: 1,
		kind: "private-resume-preparation-diagnostic", ...diagnostic })}\n`); await handle.sync(); }
	finally { await handle.close(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const values = process.argv.slice(2);
	runPrivateResumeBridge(values).catch(async error => {
		try { await savePrivateFailure(values, error); } catch { /* Preserve the original failure. */ }
		process.stderr.write("private resume preparation failed; no control request was sent; inspect private diagnostic\n");
		process.exitCode = 1;
	});
}
