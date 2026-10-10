/** Scoped, host-authenticated disposition of one returned local dispatch.
 * The declaration is evidence to check, never authorization by itself. */
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { createInterface } from "node:readline";
import type { Workspace } from "../workspace.ts";
import type { CurrentGoal, M07TaskRecord } from "./types.ts";
import { fullLocalMissionCensus } from "./local-legacy-review.ts";

const digest = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
const hex = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
const exact = (value: unknown, keys: string[]): value is Record<string, unknown> =>
	value !== null && typeof value === "object" && !Array.isArray(value) &&
	Object.keys(value).sort().join("|") === keys.sort().join("|");
async function stable(file: string): Promise<Buffer> {
	const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	try {
		const before = await handle.stat();
		if (!before.isFile() || before.nlink !== 1 || before.size < 1 || before.size > 64 * 1024)
			throw new Error("failed M04 effect evidence is not bounded regular data");
		const value = await handle.readFile();
		const after = await handle.stat();
		if (value.length !== before.size || after.dev !== before.dev || after.ino !== before.ino ||
			after.size !== before.size || after.mtimeMs !== before.mtimeMs)
			throw new Error("failed M04 effect evidence changed during read");
		return value;
	} finally { await handle.close(); }
}
/** Transport transcripts have no scientific byte ceiling; hash in constant memory. */
export async function hashStableHistoricalFile(file: string): Promise<string> {
	const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	try {
		const before = await handle.stat();
		if (!before.isFile() || before.nlink !== 1 || before.size < 1)
			throw new Error("historical transcript is not regular data");
		const state = createHash("sha256");
		const buffer = Buffer.allocUnsafe(1024 * 1024);
		let offset = 0;
		while (offset < before.size) {
			const { bytesRead } = await handle.read(buffer, 0,
				Math.min(buffer.length, before.size - offset), offset);
			if (bytesRead < 1) throw new Error("historical transcript changed during read");
			state.update(buffer.subarray(0, bytesRead));
			offset += bytesRead;
		}
		const after = await handle.stat();
		if (offset !== before.size || after.dev !== before.dev || after.ino !== before.ino ||
			after.size !== before.size || after.mtimeMs !== before.mtimeMs)
			throw new Error("historical transcript changed during read");
		return state.digest("hex");
	} finally { await handle.close(); }
}
/** Count exact tool-call/result pairs without a whole-transcript buffer. */
export async function pairedHistoricalToolTranscript(task: M07TaskRecord): Promise<{
	sha256: string; calls: number; results: number; names: string[] }> {
	const rounds = task.executionRounds ?? [];
	if (!Array.isArray(rounds) || rounds.some(row =>
		row === null || typeof row !== "object" || Array.isArray(row)))
		throw new Error("historical tool transcript set is missing or ambiguous");
	const referenced: unknown[] = [task.session, ...rounds.map(row => row?.reviewerSession)];
	// Only an omitted reviewer reference is optional. A present malformed
	// reference must never disappear from the authenticated transcript set.
	if (referenced[0] === undefined || referenced.some((row, index) =>
		(index === 0 || row !== undefined) && (row === null || typeof row !== "object" ||
			Array.isArray(row) || typeof (row as { id?: unknown }).id !== "string" ||
			!(row as { id: string }).id ||
			typeof (row as { file?: unknown }).file !== "string" ||
			!(row as { file: string }).file)))
		throw new Error("historical tool transcript set is missing or ambiguous");
	const sessions = referenced.filter((row): row is { id: string; file: string } => row !== undefined);
	if (new Set(sessions.map(row => row.file)).size !== sessions.length)
		throw new Error("historical tool transcript set is missing or ambiguous");
	const rows: Array<{ fileSha256: string; calls: number; results: number; names: string[] }> = [];
	for (const session of sessions) {
		const file = session.file!;
		const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
		try {
			const before = await handle.stat();
			if (!before.isFile() || before.nlink !== 1 || before.size < 1)
				throw new Error("historical tool transcript is not regular data");
			const calls = new Map<string, string>();
			const results = new Set<string>();
			const names: string[] = [];
			const stream = handle.createReadStream({ autoClose: false });
			const contentHash = createHash("sha256");
			let readBytes = 0;
			stream.on("data", (chunk: Buffer) => { contentHash.update(chunk); readBytes += chunk.length; });
			const lines = createInterface({ input: stream, crlfDelay: Infinity });
			let headerSeen = false;
			let messageSeen = false;
			for await (const line of lines) {
				if (!line) continue;
				const event = JSON.parse(line) as { type?: string; id?: unknown;
					parentSession?: unknown; message?: {
					role?: string; content?: Array<{ type?: string; id?: string; name?: string }>;
					toolCallId?: string } };
				// Old imported transcripts may lack a session header. An explicit
				// ancestor header cannot be attributed to this one task's current
				// execution session without the separate fork lineage protocol.
				if (event.type === "session") {
					if (headerSeen || messageSeen || event.id !== session.id || event.parentSession !== undefined)
						throw new Error("historical tool transcript has a foreign or ancestor session");
					headerSeen = true;
					continue;
				}
				if (event.type !== "message" || !event.message) continue;
				messageSeen = true;
				if (event.message.role === "assistant") for (const item of event.message.content ?? []) {
					if (item.type !== "toolCall") continue;
					if (!item.id || !item.name || calls.has(item.id))
						throw new Error("historical transcript has duplicate or incomplete tool-call ID");
					calls.set(item.id, item.name); names.push(item.name);
				}
				if (event.message.role === "toolResult") {
					const id = event.message.toolCallId;
					if (!id || !calls.has(id) || results.has(id))
						throw new Error("historical transcript has duplicate or incomplete tool result");
					results.add(id);
				}
			}
			const after = await handle.stat();
			if (readBytes !== before.size || after.dev !== before.dev || after.ino !== before.ino ||
				after.size !== before.size || after.mtimeMs !== before.mtimeMs ||
				calls.size !== results.size || [...results].some(id => !calls.has(id)))
				throw new Error("historical transcript changed or has an unmatched tool result");
			rows.push({ fileSha256: contentHash.digest("hex"),
				calls: calls.size, results: results.size, names });
		} finally { await handle.close(); }
	}
	return { sha256: digest(JSON.stringify(rows)),
		calls: rows.reduce((sum, row) => sum + row.calls, 0),
		results: rows.reduce((sum, row) => sum + row.results, 0),
		names: rows.flatMap(row => row.names) };
}

export interface FailedM04EffectReviewV1 {
	version: 1; kind: "local-failed-m04-effect-review";
	scope: { missionId: string; intentId: string; oldCheckpointSha256: string;
		m07RunId: string; taskId: string; operationId: string; checkpointId: string; m04RunId: string };
	workspaceCensusSha256: string; toolLogSha256: string;
	toolTranscriptCensusSha256: string; pairedToolCallCount: number;
	evaluatorReceiptSha256: string;
	m04Sessions: Array<{ id: string; fileSha256: string }>;
	m04TransactionSha256: string;
	toolCalls: Array<{ ordinal: number; entrySha256: string;
		result: "returned" | "returned-error"; numericExit: number | null;
		effect: "observed-settled" }>;
	childProcesses: "no-detected-lingering-process";
	backgroundWork: "no-unsettled-work";
	/** Request completion and billing may remain unknown; provider-side work must be inference only. */
	providerRequests: "inference-only-no-hosted-work";
	providerAccounting: "unreconciled";
	knowledgeWrite: "none-observed";
	otherOpenMutatingOperations: 0;
	trustLimit: "same-uid-host-observation-no-os-isolation-proof";
	conclusion: "observed-settled-within-reviewed-scope";
}

export function validFailedM04EffectReview(value: unknown): value is FailedM04EffectReviewV1 {
	if (!exact(value, ["version", "kind", "scope", "workspaceCensusSha256", "toolLogSha256",
		"toolTranscriptCensusSha256", "pairedToolCallCount", "evaluatorReceiptSha256",
		"m04Sessions", "m04TransactionSha256", "toolCalls", "childProcesses",
		"backgroundWork", "providerRequests", "providerAccounting", "knowledgeWrite",
		"otherOpenMutatingOperations",
		"trustLimit", "conclusion"]) ||
		!exact(value.scope, ["missionId", "intentId", "oldCheckpointSha256", "m07RunId",
			"taskId", "operationId", "checkpointId", "m04RunId"]) ||
		value.version !== 1 || value.kind !== "local-failed-m04-effect-review" ||
		Object.entries(value.scope).some(([key, item]) => key === "oldCheckpointSha256" ? !hex(item) :
			typeof item !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(item)) ||
		![value.workspaceCensusSha256, value.toolLogSha256, value.toolTranscriptCensusSha256,
			value.evaluatorReceiptSha256, value.m04TransactionSha256].every(hex) ||
		!Array.isArray(value.m04Sessions) || !value.m04Sessions.length ||
		value.m04Sessions.some(row => !exact(row, ["id", "fileSha256"]) ||
			typeof row.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(row.id) ||
			!hex(row.fileSha256)) ||
		new Set(value.m04Sessions.map(row => row.id)).size !== value.m04Sessions.length ||
		!Number.isSafeInteger(value.pairedToolCallCount) || Number(value.pairedToolCallCount) < 0 ||
		!Array.isArray(value.toolCalls) || value.toolCalls.length !== value.pairedToolCallCount ||
		value.toolCalls.some((row, index) => !exact(row, ["ordinal", "entrySha256", "result", "numericExit", "effect"]) ||
			row.ordinal !== index + 1 || !hex(row.entrySha256) ||
			!["returned", "returned-error"].includes(String(row.result)) ||
			(row.numericExit !== null && (!Number.isSafeInteger(row.numericExit) ||
				Number(row.numericExit) < 0)) ||
			row.effect !== "observed-settled") ||
		value.childProcesses !== "no-detected-lingering-process" ||
		value.backgroundWork !== "no-unsettled-work" ||
		value.providerRequests !== "inference-only-no-hosted-work" ||
		value.providerAccounting !== "unreconciled" ||
		value.knowledgeWrite !== "none-observed" || value.otherOpenMutatingOperations !== 0 ||
		value.trustLimit !== "same-uid-host-observation-no-os-isolation-proof" ||
		value.conclusion !== "observed-settled-within-reviewed-scope") return false;
	return true;
}

export async function verifyFailedM04EffectReview(input: { ws: Workspace; file: string;
	sha256: string; missionId: string; intentId: string; oldCheckpointSha256: string;
	goal: CurrentGoal; task: M07TaskRecord; operationId: string; checkpointId: string;
	m04RunId: string; m04Sessions: Array<{ id: string; file: string }>;
	m04TransactionSha256: string;
	evaluatorReceiptSha256: string;
	priorReviewed: readonly { intentId: string; m07RunId: string }[];
	verifyTrustedEffects: (review: FailedM04EffectReviewV1) => Promise<void>;
}): Promise<{ review: FailedM04EffectReviewV1; sha256: string }> {
	const data = await stable(input.file);
	const sha256 = digest(data);
	const review: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(data));
	if (!validFailedM04EffectReview(review) || sha256 !== input.sha256 ||
		JSON.stringify(review.scope) !== JSON.stringify({ missionId: input.missionId,
			intentId: input.intentId, oldCheckpointSha256: input.oldCheckpointSha256,
			m07RunId: input.goal.runId, taskId: input.task.taskId,
			operationId: input.operationId, checkpointId: input.checkpointId,
			m04RunId: input.m04RunId }))
		throw new Error("failed M04 effect review scope or digest differs");
	const paired = await pairedHistoricalToolTranscript(input.task);
	const log = input.task.toolLog as Array<{ name: string; ok: boolean;
		resultMetadata?: { kind?: string; exitCode?: number } }>;
	if (!Array.isArray(log) || paired.calls !== paired.results || paired.calls !== log.length ||
		paired.sha256 !== review.toolTranscriptCensusSha256 ||
		paired.calls !== review.pairedToolCallCount ||
		JSON.stringify([...paired.names].sort()) !== JSON.stringify(log.map(row => row.name).sort()) ||
		digest(JSON.stringify(log)) !== review.toolLogSha256 ||
		JSON.stringify(await Promise.all(input.m04Sessions.map(async row => ({ id: row.id,
			fileSha256: await hashStableHistoricalFile(row.file) })))) !== JSON.stringify(review.m04Sessions) ||
		review.m04TransactionSha256 !== input.m04TransactionSha256 ||
		review.evaluatorReceiptSha256 !== input.evaluatorReceiptSha256 ||
		await fullLocalMissionCensus(input.ws, { intentId: input.intentId,
			m07RunId: input.goal.runId, priorReviewed: input.priorReviewed }) !== review.workspaceCensusSha256)
		throw new Error("failed M04 tool, session, or workspace census differs");
	for (const [index, entry] of log.entries()) {
		const row = review.toolCalls[index]!;
		const recordedExit = entry.resultMetadata?.kind === "host-process-exit" &&
			Number.isSafeInteger(entry.resultMetadata.exitCode) &&
			Number(entry.resultMetadata.exitCode) >= 0 ? entry.resultMetadata.exitCode : null;
		if (typeof entry.name !== "string" || typeof entry.ok !== "boolean" ||
			row.entrySha256 !== digest(JSON.stringify(entry)) ||
			row.result !== (entry.ok ? "returned" : "returned-error") ||
			row.numericExit !== recordedExit)
			throw new Error("failed M04 call/result effect remains unreviewed");
	}
	// A same-user declaration is never a host observation. The caller must
	// authenticate the actual scoped effects, child and background census.
	await input.verifyTrustedEffects(review);
	return { review, sha256 };
}
