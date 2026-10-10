/** Host-side checks for a narrowly reviewed pre-lineage serial dispatch.
 * Operator effect classifications are explicit in the receipt and pinned to
 * every retained tool record. Missing records or uncertain effects fail closed. */
import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import type { Workspace } from "../workspace.ts";
import type { CurrentGoal, M07TaskRecord } from "./types.ts";
import type { ToolCallRecord } from "../runner/types.ts";
import { localLineageHash } from "./local-dispatch-lineage.ts";

const exact = (value: unknown, keys: string[]): value is Record<string, unknown> =>
	value !== null && typeof value === "object" && !Array.isArray(value) &&
	Object.keys(value).sort().join("|") === keys.sort().join("|");
export const LEGACY_SERIAL_COMMIT = "15ef0a58bef67c601f5f5eafbcc3d517f5065159";
export const LEGACY_SERIAL_TREE = "f03001b8e59627d3f1f2a3665871a7f55b57ff8d";
const serialBlobs = [
	["src/cli.ts", "ff3f869478ec928ebe18ec740769c4d3ed1c0098969ea85092a8e88b9f704f38"],
	["src/m07/local-mission.ts", "50d7a474e925aafb5dea57b103d6a74e4529e4f209b9d6f841ad4cbb58f59b1f"],
	["src/m07/local-original-objective.ts", "785003a89ec1f49df93c80033c676b6ab5485d01a14e4d8ecdc3a83d432340c8"],
	["src/m07/local-m07-adapter.ts", "8bf984af961eca6d8b60cf2984493a409f413d4ba8e7f7d2f361fe7cedac4fa6"],
	["src/m07/controller.ts", "8b16c56b1054545d13af64a105ff281751f541291e6e84a84f3e9a3b831055f3"],
	["src/runner/local-mission-host.ts", "52f7b10c200ed2eb73d7588bbc7d26a7b57e8093d22bd46f1c72cbe76d66ce7b"],
	["src/stages/m04.ts", "45eb386c69ec74b9a08512bacc3a535fd551589490d2f637f18649cdaaebf7b4"],
	["src/runner/pi.ts", "ba7483c2f32d1576c8e5bc423574d5f21ebdfe125925be6946867cde0fed1bb0"],
] as const;
export const LEGACY_SERIAL_AUDIT_SHA256 = localLineageHash(JSON.stringify(serialBlobs));
/** An exact copy of the eight public source files used in the one reviewed
 * pre-lineage run. It lets a shallow or offline checkout verify those bytes
 * without fetching an older Git commit. The commit/tree are historical
 * locators; the pinned archive and per-file hashes are the byte authority. */
const LEGACY_SERIAL_ARCHIVE_SHA256 = "6318f987462d2f93aa90bef84c36ea01e53709067a71c607d89a1c3a9e5b2795";
const LEGACY_SERIAL_ARCHIVE_BYTES = 173621;
export interface LegacyEffectReviewV1 {
	version: 1; kind: "local-legacy-effect-review";
	source: { commit: string; tree: string; serialEntryAuditSha256: string };
	censusSha256: string; toolLogSha256: string; m04SessionSha256: string;
	toolTranscriptCensusSha256: string; pairedToolCallCount: number;
	toolCalls: Array<{ ordinal: number; entrySha256: string;
		result: "returned" | "returned-error"; numericExit: number | null;
		externalEffect: "observed-settled-within-trusted-host-scope";
		childEffect: "no-detected-lingering-process";
		networkEffect: "no-explicit-network-or-background-command" }>;
	childProcess: { kind: "no-detected-lingering-process"; processGroupId: number | null;
		method: "verified-dead-process-group" | "reviewed-tool-and-process-census" };
	network: { kind: "no-explicit-network-or-background-command";
		m07ProviderResponseReceived: true; m04LastRequestNotSent: true;
		m04SettledResponseCount: number; otherOpenRequests: 0 };
	failedToolOrdinals: number[]; numericExitUnknownOrdinals: number[];
	trustLimit: "same-uid-reviewed-observations-no-os-noninterference-proof";
	conclusion: "observed-settled-within-trusted-host-scope";
}
async function bytes(file: string): Promise<Buffer> {
	const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	try {
		const st = await handle.stat();
		if (!st.isFile() || st.nlink !== 1 || st.size < 1 || st.size > 64 * 1024)
			throw new Error("legacy review is not a bounded regular file");
		const value = await handle.readFile();
		if (value.length !== st.size) throw new Error("legacy review changed during read");
		return value;
	} finally { await handle.close(); }
}
export async function verifyLegacySerialSource(archiveFile = path.join(
	path.dirname(fileURLToPath(import.meta.url)), "legacy-reviewed-serial-source-v1.json.gz")): Promise<void> {
	const handle = await open(archiveFile, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	let archive: Buffer;
	try {
		const st = await handle.stat();
		if (!st.isFile() || st.nlink !== 1 || st.size !== LEGACY_SERIAL_ARCHIVE_BYTES)
			throw new Error("legacy serial source archive has the wrong physical identity");
		archive = await handle.readFile();
	} finally { await handle.close(); }
	if (archive.length !== LEGACY_SERIAL_ARCHIVE_BYTES ||
		localLineageHash(archive) !== LEGACY_SERIAL_ARCHIVE_SHA256)
		throw new Error("legacy serial source archive differs from reviewed bytes");
	const value: unknown = JSON.parse(gunzipSync(archive).toString("utf8"));
	if (!exact(value, ["version", "kind", "commit", "tree", "files"]) ||
		value.version !== 1 || value.kind !== "legacy-reviewed-serial-source" ||
		value.commit !== LEGACY_SERIAL_COMMIT || value.tree !== LEGACY_SERIAL_TREE ||
		!Array.isArray(value.files) || value.files.length !== serialBlobs.length)
		throw new Error("legacy serial source manifest differs from reviewed source");
	for (const [index, [file, expected]] of serialBlobs.entries()) {
		const entry: unknown = value.files[index];
		if (!exact(entry, ["path", "sha256", "base64"]) || entry.path !== file ||
			entry.sha256 !== expected || typeof entry.base64 !== "string")
			throw new Error("legacy serial source file identity differs from reviewed source");
		const blob = Buffer.from(entry.base64, "base64");
		if (blob.toString("base64") !== entry.base64 || localLineageHash(blob) !== expected)
			throw new Error("legacy serial source blob differs from reviewed code");
	}
}
export async function fullLocalMissionCensus(ws: Workspace,
	scope: { intentId: string; m07RunId: string;
		priorReviewed?: readonly { intentId: string; m07RunId: string }[] }): Promise<string> {
	const priorIntents = new Set(scope.priorReviewed?.map(row => row.intentId) ?? []);
	const priorM07Runs = new Set(scope.priorReviewed?.map(row => row.m07RunId) ?? []);
	const rows: Array<{ stage: string; runId: string; runSha256: string;
		goalSha256?: string; transactionSha256?: string }> = [];
	for (const stage of ["MISSION", "M07", "M04"]) {
		const stageRoot = path.join(ws.stagesDir, stage);
		let runIds: string[];
		try { runIds = (await readdir(stageRoot)).sort(); }
		catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") { runIds = []; }
			else throw error;
		}
		for (const runId of runIds) {
			const directoryInfo = await lstat(path.join(stageRoot, runId));
			if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink() ||
				!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(runId))
				throw new Error("legacy full-workspace census has an unexpected run entry");
			const directory = ws.runDir(stage, runId);
			const run = await bytesForCensus(path.join(directory, "run.json"));
			const runValue = JSON.parse(run.toString("utf8")) as { stage?: string; runId?: string;
				status?: string };
			if (runValue.stage !== stage || runValue.runId !== runId ||
				!["running", "failed", "completed"].includes(runValue.status ?? ""))
				throw new Error("legacy full-workspace census has an invalid run record");
			if (runValue.status === "running" &&
				!(stage === "MISSION" && (runId === scope.intentId || priorIntents.has(runId)) ||
					stage === "M07" && (runId === scope.m07RunId || priorM07Runs.has(runId))))
				throw new Error("legacy full-workspace census has another running stage");
			const row: (typeof rows)[number] = { stage, runId, runSha256: localLineageHash(run) };
			if (stage === "M07") {
				const goalBytes = await bytesForCensus(path.join(directory, "goal.json"));
				const goal = JSON.parse(goalBytes.toString("utf8")) as CurrentGoal;
				if (goal.version !== 1 || goal.runId !== runId ||
					!["active", "finished"].includes(goal.lifecycle) ||
					!Array.isArray(goal.tasks) || !goal.executionState ||
					goal.executionState.version !== 1 || !Array.isArray(goal.executionState.attempts) ||
					!Array.isArray(goal.executionState.operations) ||
					goal.tasks.some(task => !["accepted", "rejected", "failed", "returned"].includes(task.status)) ||
					goal.executionState.operations.some(op =>
						!["response-received", "confirmed", "not-issued"].includes(op.status)))
					throw new Error("legacy full-workspace census has an unknown M07 task or effect");
				row.goalSha256 = localLineageHash(goalBytes);
			}
			if (stage === "M04") {
				if (runValue.status === "running") throw new Error("legacy census has a running M04 transaction");
				const transactionBytes = await bytesForCensus(path.join(directory, "m04-transaction.json"));
				const tx = JSON.parse(transactionBytes.toString("utf8")) as
					{ version?: number; kind?: string; m04RunId?: string; state?: string; attempts?: unknown[] };
				if (tx.version !== 1 || tx.kind !== "m04-knowledge-transaction" ||
					tx.m04RunId !== runId || !Array.isArray(tx.attempts) ||
					!["no-proposal", "rejected-draft", "merged"].includes(tx.state ?? ""))
					throw new Error("legacy census has an open or unsupported M04 transaction");
				row.transactionSha256 = localLineageHash(transactionBytes);
			}
			rows.push(row);
		}
	}
	return localLineageHash(JSON.stringify(rows));
}
async function bytesForCensus(file: string): Promise<Buffer> {
	const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	try {
		const st = await handle.stat();
		if (!st.isFile() || st.nlink !== 1 || st.size < 1 || st.size > 64 * 1024 * 1024)
			throw new Error("mission census file is unsafe");
		const data = await handle.readFile();
		if (data.length !== st.size) throw new Error("mission census changed while read");
		return data;
	} finally { await handle.close(); }
}
export async function pairedToolTranscript(task: M07TaskRecord): Promise<{
	sha256: string; calls: number; results: number; names: string[] }> {
	const files = [task.session?.file,
		...(task.executionRounds ?? []).map(round => round.reviewerSession?.file)]
		.filter((file): file is string => typeof file === "string");
	if (!files.length || new Set(files).size !== files.length)
		throw new Error("legacy M07 session transcript set is missing or ambiguous");
	const rows: Array<{ fileSha256: string; calls: number; results: number; names: string[] }> = [];
	for (const file of files) {
		const data = await bytesForCensus(file);
		const calls = new Map<string, string>();
		const results = new Set<string>();
		const names: string[] = [];
		for (const line of data.toString("utf8").split("\n").filter(Boolean)) {
			const event = JSON.parse(line) as { type?: string;
				message?: { role?: string; content?: Array<{ type?: string; id?: string; name?: string }>;
					toolCallId?: string } };
			if (event.type !== "message" || !event.message) continue;
			if (event.message.role === "assistant") for (const item of event.message.content ?? []) {
				if (item.type !== "toolCall") continue;
				if (!item.id || !item.name || calls.has(item.id))
					throw new Error("legacy M07 session has duplicate or incomplete tool-call ID");
				calls.set(item.id, item.name);
				names.push(item.name);
			}
			if (event.message.role === "toolResult") {
				const id = event.message.toolCallId;
				if (!id || results.has(id))
					throw new Error("legacy M07 session has duplicate or incomplete tool result");
				results.add(id);
			}
		}
		if (calls.size !== results.size || [...results].some(id => !calls.has(id)))
			throw new Error("legacy M07 session has missing or orphan tool results");
		rows.push({ fileSha256: localLineageHash(data), calls: calls.size,
			results: results.size, names });
	}
	return { sha256: localLineageHash(JSON.stringify(rows)),
		calls: rows.reduce((sum, row) => sum + row.calls, 0),
		results: rows.reduce((sum, row) => sum + row.results, 0),
		names: rows.flatMap(row => row.names) };
}
async function observedM04Responses(file: string): Promise<{
	sha256: string; positiveUsageResponses: number }> {
	const data = await bytesForCensus(file);
	let positiveUsageResponses = 0;
	let zeroUsageErrors = 0;
	for (const line of data.toString("utf8").split("\n").filter(Boolean)) {
		const event = JSON.parse(line) as { type?: string;
			message?: { role?: string; stopReason?: string;
				usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number } } };
		if (event.type !== "message" || event.message?.role !== "assistant") continue;
		const usage = event.message.usage;
		if (!usage || ![usage.input, usage.output, usage.cacheRead, usage.cacheWrite]
			.every(x => x === undefined || Number.isSafeInteger(x) && x >= 0))
			throw new Error("legacy M04 assistant message has incomplete provider usage");
		const amount = (usage.input ?? 0) + (usage.output ?? 0) +
			(usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
		if (amount > 0) positiveUsageResponses++;
		else if (event.message.stopReason === "error") zeroUsageErrors++;
		else throw new Error("legacy M04 has an unaccounted zero-usage assistant response");
	}
	if (zeroUsageErrors !== 1 || positiveUsageResponses < 1)
		throw new Error("legacy M04 terminal error or earlier settled responses are unverified");
	return { sha256: localLineageHash(data), positiveUsageResponses };
}
export async function verifyLegacyEffectReview(input: { ws: Workspace; file: string;
	sha256: string; intentId: string; goal: CurrentGoal; task: M07TaskRecord; m04SessionFile: string;
	probeProcessGroup?: (groupId: number) => Promise<boolean> }): Promise<{
	declaration: LegacyEffectReviewV1; sha256: string; censusSha256: string;
	toolLogSha256: string; m04SessionSha256: string;
	toolTranscriptCensusSha256: string; pairedToolCallCount: number;
	childReviewSha256: string; networkReviewSha256: string;
	failedToolOrdinals: number[]; numericExitUnknownOrdinals: number[] }> {
	const raw = await bytes(input.file);
	const sha256 = localLineageHash(raw);
	if (sha256 !== input.sha256) throw new Error("legacy effect review digest changed");
	const review = JSON.parse(raw.toString("utf8")) as LegacyEffectReviewV1;
	if (!exact(review, ["version", "kind", "source", "censusSha256", "toolLogSha256",
		"m04SessionSha256", "toolTranscriptCensusSha256", "pairedToolCallCount",
		"toolCalls", "childProcess", "network", "failedToolOrdinals",
		"numericExitUnknownOrdinals", "trustLimit", "conclusion"]) ||
		!exact(review.source, ["commit", "tree", "serialEntryAuditSha256"]) ||
		!exact(review.childProcess, ["kind", "processGroupId", "method"]) ||
		!exact(review.network, ["kind", "m07ProviderResponseReceived", "m04LastRequestNotSent",
			"m04SettledResponseCount", "otherOpenRequests"]) ||
		review.version !== 1 || review.kind !== "local-legacy-effect-review" ||
		review.source?.commit !== LEGACY_SERIAL_COMMIT || review.source.tree !== LEGACY_SERIAL_TREE ||
		review.source.serialEntryAuditSha256 !== LEGACY_SERIAL_AUDIT_SHA256 ||
		review.conclusion !== "observed-settled-within-trusted-host-scope" ||
		review.trustLimit !== "same-uid-reviewed-observations-no-os-noninterference-proof")
		throw new Error("legacy source or review conclusion differs");
	await verifyLegacySerialSource();
	const censusSha256 = await fullLocalMissionCensus(input.ws,
		{ intentId: input.intentId, m07RunId: input.goal.runId });
	const m04Observed = await observedM04Responses(input.m04SessionFile);
	const m04SessionSha256 = m04Observed.sha256;
	const toolLog = input.task.toolLog as ToolCallRecord[];
	const paired = await pairedToolTranscript(input.task);
	if (review.censusSha256 !== censusSha256 ||
		review.m04SessionSha256 !== m04SessionSha256 ||
		review.toolTranscriptCensusSha256 !== paired.sha256 ||
		review.pairedToolCallCount !== paired.calls || paired.calls !== paired.results ||
		paired.calls !== toolLog.length ||
		JSON.stringify([...paired.names].sort()) !== JSON.stringify(toolLog.map(row => row.name).sort()) ||
		review.toolLogSha256 !== localLineageHash(JSON.stringify(toolLog)) ||
		!Array.isArray(toolLog) || !Array.isArray(review.toolCalls) ||
		review.toolCalls.length !== toolLog.length)
		throw new Error("legacy workspace or tool census is incomplete");
	const failedToolOrdinals: number[] = [];
	const numericExitUnknownOrdinals: number[] = [];
	for (const [index, entry] of toolLog.entries()) {
		const row = review.toolCalls[index];
		if (entry.ok === false) failedToolOrdinals.push(index + 1);
		if (entry.name === "bash" && row?.numericExit === null) numericExitUnknownOrdinals.push(index + 1);
		if (!exact(row, ["ordinal", "entrySha256", "result", "numericExit",
			"externalEffect", "childEffect", "networkEffect"]) || row.ordinal !== index + 1 ||
			row.entrySha256 !== localLineageHash(JSON.stringify(entry)) ||
			(typeof entry.ok !== "boolean") ||
			row.result !== (entry.ok ? "returned" : "returned-error") ||
			(row.numericExit !== null && (!Number.isSafeInteger(row.numericExit) || row.numericExit < 0)) ||
			(row.numericExit !== null && entry.name !== "bash") ||
			row.externalEffect !== "observed-settled-within-trusted-host-scope" ||
			row.childEffect !== "no-detected-lingering-process" ||
			row.networkEffect !== "no-explicit-network-or-background-command")
			throw new Error("legacy tool call, result, or effect remains uncertain");
	}
	if (JSON.stringify(review.failedToolOrdinals) !== JSON.stringify(failedToolOrdinals) ||
		JSON.stringify(review.numericExitUnknownOrdinals) !== JSON.stringify(numericExitUnknownOrdinals))
		throw new Error("legacy failed-call or numeric-exit limitations differ from the retained tool log");
	const descriptor = input.goal.executionState?.attempts[0]?.runDescriptor;
	const groupId = descriptor?.processGroupId;
	const processCapable = toolLog.some(row => row.name === "bash");
	const groupProof = Number.isSafeInteger(groupId) && groupId! > 0 &&
		review.childProcess?.processGroupId === groupId &&
		review.childProcess?.method === "verified-dead-process-group" &&
		await (input.probeProcessGroup ?? probeDeadGroup)(groupId!);
	const reviewedCensus = review.childProcess?.processGroupId === null &&
		review.childProcess?.method === "reviewed-tool-and-process-census";
	if (review.childProcess?.kind !== "no-detected-lingering-process" ||
		(processCapable ? !groupProof && !reviewedCensus : !reviewedCensus))
		throw new Error("legacy child-process census is incomplete");
	if (review.network?.kind !== "no-explicit-network-or-background-command" ||
		review.network.m07ProviderResponseReceived !== true ||
		review.network.m04LastRequestNotSent !== true || review.network.otherOpenRequests !== 0 ||
		!Number.isSafeInteger(review.network.m04SettledResponseCount) ||
		review.network.m04SettledResponseCount !== m04Observed.positiveUsageResponses ||
		input.goal.executionState?.operations.some(row =>
			!["response-received", "confirmed", "not-issued"].includes(row.status)))
		throw new Error("legacy network or provider effect remains open");
	return { declaration: review, sha256, censusSha256,
		toolLogSha256: review.toolLogSha256, m04SessionSha256,
		toolTranscriptCensusSha256: paired.sha256, pairedToolCallCount: paired.calls,
		childReviewSha256: localLineageHash(JSON.stringify(review.childProcess)),
		networkReviewSha256: localLineageHash(JSON.stringify(review.network)),
		failedToolOrdinals, numericExitUnknownOrdinals };
}
async function probeDeadGroup(groupId: number): Promise<boolean> {
	try { process.kill(-groupId, 0); return false; }
	catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
}
