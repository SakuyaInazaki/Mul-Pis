/** Read-only, narrow recovery observation for an interrupted M07 builder.
 * It never asserts completion of the model turn or of remote side effects. */
import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { lstat, open, realpath } from "node:fs/promises";
import readline from "node:readline";
import path from "node:path";
import { probeProcessIdentity } from "../runtime/process-identity.ts";
import { readManagedBashSessionEvidence, type ManagedBashReceiptV1 } from "../runner/managed-bash.ts";
import type { CurrentGoal } from "./types.ts";

export interface ManagedLocalFailureObservation {
	version: 1;
	kind: "scoped-managed-bash-failure";
	sessionId: string;
	toolCallId: string;
	receiptId: string;
	exitCode: number;
	/** Scope is deliberately narrower than the whole M07 operation. */
	localProcess: "terminated-nonzero";
	modelResponse: "unknown";
	remoteOrDetachedEffects: "unknown";
}

interface TranscriptCalls { calls: Map<string, { name: string; commandSha256: string | null;
	pathSha256: string | null }>;
	results: Map<string, boolean>; }

async function inspectTranscript(file: string, sessionId: string): Promise<TranscriptCalls> {
	const info = await lstat(file);
	if (!info.isFile()) throw new Error("Pi session transcript is not a regular file");
	const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
	const opened = await handle.stat();
	if (!opened.isFile() || opened.ino !== info.ino || opened.dev !== info.dev || opened.size !== info.size) {
		await handle.close(); throw new Error("Pi session transcript changed during open");
	}
	const tail = Buffer.alloc(1);
	if (opened.size < 2 || (await handle.read(tail, 0, 1, opened.size - 1)).bytesRead !== 1 || tail[0] !== 10) {
		await handle.close(); throw new Error("Pi session transcript has an incomplete final line");
	}
	const calls = new Map<string, { name: string; commandSha256: string | null;
		pathSha256: string | null }>();
	const results = new Map<string, boolean>();
	const lines = readline.createInterface({ input: handle.createReadStream({ autoClose: false }), crlfDelay: Infinity });
	let headerSeen = false;
	try {
		for await (const line of lines) {
			if (!line) continue;
			const event = JSON.parse(line) as { type?: unknown; id?: unknown; parentSession?: unknown;
				message?: { role?: unknown;
				content?: unknown; toolCallId?: unknown; isError?: unknown } };
			if (!headerSeen) {
				if (event.type !== "session" || event.id !== sessionId)
					throw new Error("Pi session transcript header differs");
				if (event.parentSession !== undefined)
					throw new Error("forked Pi session needs verified lineage attribution");
				headerSeen = true; continue;
			}
			if (event.type === "session") throw new Error("Pi session transcript has duplicate header");
			if (event.type !== "message" || !event.message) continue;
			const message = event.message;
			if (message.role === "assistant") {
				if (!Array.isArray(message.content)) throw new Error("Pi assistant content is incomplete");
				for (const item of message.content) {
					if (!item || typeof item !== "object" || (item as { type?: unknown }).type !== "toolCall") continue;
					const id = (item as { id?: unknown }).id;
					const name = (item as { name?: unknown }).name;
					const args = (item as { arguments?: unknown }).arguments;
					if (typeof id !== "string" || !id || typeof name !== "string" || !name || calls.has(id))
						throw new Error("Pi tool call is duplicate or incomplete");
					const command = args && typeof args === "object" && !Array.isArray(args) &&
						typeof (args as { command?: unknown }).command === "string" ?
						(args as { command: string }).command : null;
					const requestedPath = args && typeof args === "object" && !Array.isArray(args) &&
						typeof (args as { path?: unknown }).path === "string" ?
						(args as { path: string }).path : null;
					calls.set(id, { name, commandSha256: command === null ? null :
						createHash("sha256").update(command, "utf8").digest("hex"),
						pathSha256: requestedPath === null ? null :
							createHash("sha256").update(requestedPath, "utf8").digest("hex") });
				}
			} else if (message.role === "toolResult") {
				if (typeof message.toolCallId !== "string" || !message.toolCallId ||
					!calls.has(message.toolCallId) ||
					typeof message.isError !== "boolean" || results.has(message.toolCallId))
						throw new Error("Pi tool result is duplicate or incomplete");
				results.set(message.toolCallId, message.isError);
			}
		}
	} finally {
		lines.close();
		const after = await handle.stat();
		await handle.close();
		if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ino !== opened.ino)
			throw new Error("Pi session transcript changed during read");
	}
	if (!headerSeen) throw new Error("Pi session transcript header is missing");
	if ([...results.keys()].some(id => !calls.has(id))) throw new Error("Pi session has an orphan tool result");
	return { calls, results };
}

export interface ManagedExecutionCallObservation {
	toolCallId: string;
	name: "bash" | "read" | "write" | "edit";
	/** Hash of the exact model argument; never a confinement claim. */
	argumentSha256: string;
	toolResult: "returned" | "is-error" | "missing";
	bashReceiptId: string | null;
	bashProcessExitCode: number | null;
	bashToolOutcome: ManagedBashReceiptV1["toolOutcome"] | null;
	localLifecycle: "terminal" | "unknown";
}

export interface ManagedExecutionSessionCensus {
	calls: ManagedExecutionCallObservation[];
	/** Names of interrupted atomic writes; no status is inferred from temp bytes. */
	pendingReceiptIds: string[];
}

/** Enumerate every persisted Pi tool call, including typed file operations.
 * A missing tool result or bash receipt is retained as unknown. This census
 * does not certify the model response or effects outside the local process. */
export async function inspectManagedExecutionSession(input: {
	persistDir: string; sessionId: string; sessionFile: string;
}): Promise<ManagedExecutionSessionCensus> {
	const transcript = await inspectTranscript(input.sessionFile, input.sessionId);
	const { receipts, pendingReceiptIds } = await readManagedBashSessionEvidence(input.persistDir, input.sessionId);
	const byCall = new Map<string, ManagedBashReceiptV1>();
	for (const receipt of receipts) {
		if (byCall.has(receipt.toolCallId)) throw new Error("duplicate managed bash receipt for Pi call");
		byCall.set(receipt.toolCallId, receipt);
	}
	if ([...byCall.keys()].some(id => transcript.calls.get(id)?.name !== "bash"))
		throw new Error("managed bash receipt has no matching Pi call");
	const observed: ManagedExecutionCallObservation[] = [];
	for (const [toolCallId, call] of transcript.calls) {
		if (!["bash", "read", "write", "edit"].includes(call.name))
			throw new Error("unexpected Pi tool in execution session");
		const receipt = byCall.get(toolCallId);
		if (call.name === "bash" && receipt && receipt.commandSha256 !== call.commandSha256)
			throw new Error("managed bash command differs from Pi call");
		if (call.name !== "bash" && call.pathSha256 === null)
			throw new Error("typed Pi file call has no path argument");
		const result = transcript.results.get(toolCallId);
		if (receipt && result !== undefined &&
			((receipt.toolOutcome === "returned" && result) ||
				(receipt.toolOutcome === "is-error" && !result) ||
				(receipt.toolOutcome === "threw" && !result)))
			throw new Error("managed bash result differs from Pi tool result");
		const localLifecycle = call.name === "bash" ?
			receipt?.processExit ? "terminal" : "unknown" :
			result === undefined ? "unknown" : "terminal";
		observed.push({ toolCallId,
			name: call.name as ManagedExecutionCallObservation["name"],
			argumentSha256: call.name === "bash" ? call.commandSha256 ?? "" : call.pathSha256 ?? "",
			toolResult: result === undefined ? "missing" : result ? "is-error" : "returned",
			bashReceiptId: receipt?.id ?? null,
			bashProcessExitCode: receipt?.processExit?.exitCode ?? null,
			bashToolOutcome: receipt?.toolOutcome ?? null, localLifecycle });
	}
	return { calls: observed, pendingReceiptIds };
}

export interface M07ManagedOperationObservation {
	version: 1;
	kind: "m07-managed-operation-call-census";
	goalRunId: string;
	operationId: string;
	taskId: string;
	sessionId: string;
	calls: ManagedExecutionCallObservation[];
	pendingReceiptIds: string[];
	modelResponse: "unknown";
	remoteOrDetachedEffects: "unknown";
}

/** Bind a persisted M07 operation to its exact Pi session and execution grant.
 * Loop rounds share a Pi session and need separate round attribution, so this
 * reader refuses them rather than attaching historical calls to one round. */
export async function inspectM07ManagedOperation(goal: CurrentGoal, operationId: string):
	Promise<M07ManagedOperationObservation | null> {
	const operation = goal.executionState?.operations.find(item => item.id === operationId);
	const task = goal.tasks.find(item => item.taskId === operation?.taskId);
	const session = task?.session;
	if (!operation || !task || task.mode !== "execute" || task.executionLoop ||
		goal.executionState?.operations.filter(item => item.taskId === task.taskId).length !== 1 ||
		!session?.file || !session.specFile || !session.id || session.lineageFile ||
		!session.file.endsWith(".jsonl") ||
		session.specFile !== session.file.replace(/\.jsonl$/, ".spec.json")) return null;
	const siblingLineage = session.file.replace(/\.jsonl$/, ".lineage.json");
	try { await lstat(siblingLineage); return null; }
	catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
	const file = await open(session.specFile,
		constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
	let spec: { persistDir?: unknown; tools?: { kind?: unknown; root?: unknown } };
	try {
		const stat = await file.stat();
		if (!stat.isFile()) throw new Error("Pi execution spec is not a regular file");
		const bytes = await file.readFile();
		spec = JSON.parse(bytes.toString("utf8")) as typeof spec;
		if (`${JSON.stringify(spec, null, 2)}\n` !== bytes.toString("utf8"))
			throw new Error("Pi execution spec is not canonical");
	} finally { await file.close(); }
	if (spec.tools?.kind !== "execution" || typeof spec.tools.root !== "string" ||
		typeof spec.persistDir !== "string" ||
		path.resolve(spec.persistDir) !== path.dirname(session.file) ||
		await realpath(spec.tools.root) !== await realpath(task.workDir))
		throw new Error("Pi execution spec differs from M07 task binding");
	const census = await inspectManagedExecutionSession({ persistDir: spec.persistDir,
		sessionId: session.id, sessionFile: session.file });
	return { version: 1, kind: "m07-managed-operation-call-census",
		goalRunId: goal.runId, operationId, taskId: task.taskId, sessionId: session.id,
		calls: census.calls, pendingReceiptIds: census.pendingReceiptIds,
		modelResponse: "unknown", remoteOrDetachedEffects: "unknown" };
}

/** The caller must separately prove that this is the exact old task session,
 * old process died, frozen task inputs and operation ID are unchanged, and
 * no provider request or other external operation remains in flight. */
export async function inspectSingleForegroundBashFailure(input: {
	persistDir: string; sessionId: string; sessionFile: string; workDir: string;
}): Promise<ManagedLocalFailureObservation | null> {
	const { receipts, pendingReceiptIds } = await readManagedBashSessionEvidence(input.persistDir, input.sessionId);
	if (pendingReceiptIds.length) return null;
	if (receipts.length !== 1) return null;
	const receipt: ManagedBashReceiptV1 = receipts[0]!;
	const transcript = await inspectTranscript(input.sessionFile, input.sessionId);
	const call = transcript.calls.get(receipt.toolCallId);
	if (transcript.calls.size !== 1 || call?.name !== "bash" ||
		call.commandSha256 !== receipt.commandSha256 ||
		transcript.results.size > 1 ||
		(transcript.results.size === 1 && transcript.results.get(receipt.toolCallId) !== true) ||
		receipt.cwd !== path.resolve(input.workDir) || receipt.sessionId !== input.sessionId ||
		receipt.backend !== "managed-posix" || receipt.spawn !== "observed" ||
		!receipt.processIdentity || !receipt.processExit ||
		receipt.processExit.abortSource !== "none" || receipt.processExit.signal !== null ||
		receipt.processExit.exitCode === null || receipt.processExit.exitCode <= 0 ||
		receipt.toolOutcome !== "threw" || receipt.toolErrorKind !== "nonzero-exit" ||
		receipt.groupObservation !== "none-observed" || receipt.outputBytesAtExit === null)
		return null;
	const probe = await probeProcessIdentity(receipt.processIdentity);
	if (probe.status !== "dead" || probe.identityMatch) return null;
	return { version: 1, kind: "scoped-managed-bash-failure",
		sessionId: input.sessionId, toolCallId: receipt.toolCallId, receiptId: receipt.id,
		exitCode: receipt.processExit.exitCode, localProcess: "terminated-nonzero",
		modelResponse: "unknown", remoteOrDetachedEffects: "unknown" };
}
