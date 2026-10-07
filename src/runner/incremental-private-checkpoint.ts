import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes, randomUUID } from "node:crypto";
import { lstat, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { isNativeCnyPricingRecord } from "./deepseek-cny-pricing.ts";
import type { DeepSeekCampaignBudget } from "./deepseek-campaign.ts";
import { MISSION_ID } from "./signed-mission-ledger.ts";
import { HarnessError } from "../types.ts";

const hex64 = /^[0-9a-f]{64}$/;
const commit = /^[0-9a-f]{40}$/;
const id = /^[A-Za-z0-9._:-]{1,128}$/;
const hash = (bytes: string | Buffer): string => createHash("sha256").update(bytes).digest("hex");
const journalKeys = new WeakMap<object, Buffer>();
type Projected = Readonly<{ audit: ReturnType<typeof projectAudit>;
	effects: ReturnType<typeof projectEffects>; objectiveCheckpointJson?: string }>;
const journalLast = new WeakMap<object, Projected>();
export type IncrementalCheckpointFailureStage = "envelope" | "source" |
	"authentication" | "decoded-schema" | "monotonic-regression" | "file-io";
export type IncrementalCheckpointFailureReason =
	"invalid-json" | "invalid-format" | "encoded-field-invalid" |
	"binding-mismatch" | "key-invalid" | "tag-verification-failed" |
	"payload-json-invalid" | "payload-structure-invalid" |
	"request-audit-invalid" | "host-effect-invalid" | "objective-checkpoint-invalid" |
	"request-prefix-regressed" | "host-effect-prefix-regressed" |
	"file-bound-exceeded" | "storage-io-failed" | "unsafe-output-path" |
	"existing-prefix-mismatch" | "publish-failed";
/** The message is safe for public logs; stage/reason are private control facts. */
export class IncrementalCheckpointError extends HarnessError {
	readonly stage: IncrementalCheckpointFailureStage;
	readonly reason: IncrementalCheckpointFailureReason;
	constructor(stage: IncrementalCheckpointFailureStage,
		reason: IncrementalCheckpointFailureReason) {
		super(`runner.incremental-checkpoint.${stage}.${reason}`,
			"private incremental checkpoint is incomplete");
		this.name = "IncrementalCheckpointError";
		this.stage = stage;
		this.reason = reason;
	}
}
function diagnostic(error: unknown, stage: IncrementalCheckpointFailureStage,
	reason: IncrementalCheckpointFailureReason): IncrementalCheckpointError {
	return error instanceof IncrementalCheckpointError ? error :
		new IncrementalCheckpointError(stage, reason);
}
function decodedB64(value: unknown, max: number): Buffer {
	if (typeof value !== "string" || !value.length || value.length % 4 !== 0 ||
		value.length > Math.ceil(max * 4 / 3) + 4)
		fail("envelope", "encoded-field-invalid");
	const paddingAt = value.indexOf("=");
	const dataEnd = paddingAt < 0 ? value.length : paddingAt;
	if (value.length - dataEnd > 2) fail("envelope", "encoded-field-invalid");
	for (let index = 0; index < dataEnd; index++) {
		const code = value.charCodeAt(index);
		if (!((code >= 65 && code <= 90) || (code >= 97 && code <= 122) ||
			(code >= 48 && code <= 57) || code === 43 || code === 47))
			fail("envelope", "encoded-field-invalid");
	}
	for (let index = dataEnd; index < value.length; index++)
		if (value.charCodeAt(index) !== 61) fail("envelope", "encoded-field-invalid");
	const result = Buffer.from(value, "base64");
	if (result.length > max || result.toString("base64") !== value)
		fail("envelope", "encoded-field-invalid");
	return result;
}
function deriveKey(key: Buffer, source: IncrementalCheckpointSource): Buffer {
	if (!Buffer.isBuffer(key) || key.length !== 32) fail("authentication", "key-invalid");
	return Buffer.from(hkdfSync("sha256", key, Buffer.from(source.priorEnvelopeSha256, "hex"),
		"mul-pis-incremental-control-prefix-v1", 32));
}
function aad(source: IncrementalCheckpointSource, sequence: number,
	previousCheckpointSha256: string | null): Buffer {
	return Buffer.from(JSON.stringify([MISSION_ID, source.repository, source.runId,
		source.runAttempt, source.commit, source.event, source.priorEnvelopeSha256, sequence,
		previousCheckpointSha256]), "utf8");
}
function sameSource(value: unknown, expected: IncrementalCheckpointSource): boolean {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const source = value as Record<string, unknown>;
	return Object.keys(source).sort().join("|") === ["repository", "runId",
		"runAttempt", "commit", "event", "priorEnvelopeSha256"].sort().join("|") &&
		source.repository === expected.repository && source.runId === expected.runId &&
		source.runAttempt === expected.runAttempt && source.commit === expected.commit &&
		source.event === expected.event &&
		source.priorEnvelopeSha256 === expected.priorEnvelopeSha256;
}

/** A partial checkpoint is evidence only. It never licenses replay or adoption. */
export type HostEffectPrefixObservationV1 = Readonly<{
	version: 1; kind: "host-effect-prefix-observation";
	complete: false; selectionAuthority: false;
	source: { runId: string; runAttempt: number; commit: string };
	priorEnvelopeSha256: string; historicalGoalRunIds: string[];
	/** Only controller rows already persisted at capture time. */
	goals: Array<{ runId: string; outcome: string;
		tasks: Array<{ taskId: string; mode: "execute" | "check" | "reason"; status: string; sessionId: string }>;
		operations: Array<{ id: string; taskId: string; status: string }> }>;
	/** A session may precede its goal/task row. Its grant is still recorded. */
	sessions: Array<{ sessionId: string; kind: "none" | "read-dir" | "confined-execution";
		goalRunId?: string; taskId?: string; workRoot?: string;
		grant?: { version: 1; kind: "confined-campaign-files"; root: string;
			writableFiles: string[] } }>;
	requestIds: string[];
}>;
export type IncrementalCheckpointInput = Readonly<{
	requestAudit: ReturnType<DeepSeekCampaignBudget["requestAccountingAuditSnapshot"]>;
	hostEffects: HostEffectPrefixObservationV1;
	/** The latest controller-written text, if a complete control checkpoint exists. */
	objectiveCheckpointJson?: string;
}>;
export type IncrementalCheckpointSource = Readonly<{
	repository: string; runId: string; runAttempt: number; commit: string;
	event: "push" | "workflow_dispatch"; priorEnvelopeSha256: string;
}>;
export type IncrementalCheckpointEvent = "initial" | "request-reserved" |
	"request-observed" | "host-effect-observed" | "control-observed";
export const INCREMENTAL_CHECKPOINT_FILE = "incremental-control-prefix.json";
export type StoredIncrementalCheckpoint = Readonly<{
	sequence: number; file: typeof INCREMENTAL_CHECKPOINT_FILE; sha256: string;
}>;
/** Optional additional sink. Local storage remains the primary transport seam. */
export type IncrementalCheckpointPublisher = (input: Readonly<{
	file: string; sha256: string; sequence: number;
}>) => Promise<void>;

/** Decode only after the caller has authenticated the mission key and source. */
export function openIncrementalControlPrefix(raw: string, key: Buffer,
	expectedSource: IncrementalCheckpointSource): Readonly<{
	sequence: number; previousCheckpointSha256: string | null;
	event: IncrementalCheckpointEvent;
	requestAudit: IncrementalCheckpointInput["requestAudit"];
	hostEffects: HostEffectPrefixObservationV1;
	objectiveCheckpointJson?: string;
	replayAllowed: false; scientificAcceptance: "unreviewed";
}> {
	try {
		if (Buffer.byteLength(raw, "utf8") > 64 * 1024 * 1024)
			fail("file-io", "file-bound-exceeded");
		let root: Record<string, unknown>;
		try { root = JSON.parse(raw) as Record<string, unknown>; }
		catch { return fail("envelope", "invalid-json"); }
		if (!root || Object.keys(root).sort().join("|") !==
			["status", "incrementalControlEnvelope"].sort().join("|") ||
			root.status !== "incomplete" || !root.incrementalControlEnvelope ||
			typeof root.incrementalControlEnvelope !== "object")
			fail("envelope", "invalid-format");
		const envelope = root.incrementalControlEnvelope as Record<string, unknown>;
		if (Object.keys(envelope).sort().join("|") !== ["version", "kind", "source",
			"sequence", "previousCheckpointSha256", "nonceB64", "ciphertextB64",
			"tagB64"].sort().join("|") || envelope.version !== 1 ||
			envelope.kind !== "mul-pis-authenticated-incremental-control-prefix")
			fail("envelope", "invalid-format");
		if (!sameSource(envelope.source, expectedSource)) fail("source", "binding-mismatch");
		if (
			!Number.isSafeInteger(envelope.sequence) || Number(envelope.sequence) < 1 ||
			(envelope.previousCheckpointSha256 !== null &&
				(typeof envelope.previousCheckpointSha256 !== "string" ||
				!hex64.test(envelope.previousCheckpointSha256))))
			fail("envelope", "invalid-format");
		const nonce = decodedB64(envelope.nonceB64, 12), tag = decodedB64(envelope.tagB64, 16);
		if (nonce.length !== 12 || tag.length !== 16)
			fail("envelope", "encoded-field-invalid");
		const ciphertext = decodedB64(envelope.ciphertextB64, 48 * 1024 * 1024);
		let plaintext: Buffer;
		const derived = deriveKey(key, expectedSource);
		try {
			const cipher = createDecipheriv("aes-256-gcm", derived, nonce);
			cipher.setAAD(aad(expectedSource, Number(envelope.sequence),
				envelope.previousCheckpointSha256 as string | null));
			cipher.setAuthTag(tag);
			plaintext = Buffer.concat([cipher.update(ciphertext), cipher.final()]);
		} catch { return fail("authentication", "tag-verification-failed"); }
		let payload: Record<string, unknown>;
		try { payload = JSON.parse(plaintext.toString("utf8")) as Record<string, unknown>; }
		catch { return fail("decoded-schema", "payload-json-invalid"); }
		if (!payload || typeof payload !== "object" || Array.isArray(payload) ||
			Object.keys(payload).sort().join("|") !== ["version", "kind", "source",
				"sequence", "previousCheckpointSha256", "event", "requestAudit",
				"hostEffects", "replayAllowed", "scientificAcceptance",
				...(payload.objectiveCheckpointJson === undefined ? [] : ["objectiveCheckpointJson"])]
				.sort().join("|") || payload.version !== 1 ||
			payload.kind !== "mul-pis-incremental-private-control-checkpoint" ||
			payload.sequence !== envelope.sequence ||
			payload.previousCheckpointSha256 !== envelope.previousCheckpointSha256 ||
			!sameSource(payload.source, expectedSource) ||
			payload.replayAllowed !== false || payload.scientificAcceptance !== "unreviewed" ||
			!["initial", "request-reserved", "request-observed", "host-effect-observed",
				"control-observed"].includes(String(payload.event)))
			fail("decoded-schema", "payload-structure-invalid");
		let requestAudit: ReturnType<typeof projectAudit>;
		try { requestAudit = projectAudit(payload.requestAudit as IncrementalCheckpointInput["requestAudit"]); }
		catch { return fail("decoded-schema", "request-audit-invalid"); }
		let hostEffects: ReturnType<typeof projectEffects>;
		try { hostEffects = projectEffects(payload.hostEffects as HostEffectPrefixObservationV1,
			expectedSource, requestAudit.requests.map(row => row.requestId)); }
		catch { return fail("decoded-schema", "host-effect-invalid"); }
		if (payload.objectiveCheckpointJson !== undefined &&
			!validObjectiveCheckpoint(payload.objectiveCheckpointJson))
			fail("decoded-schema", "objective-checkpoint-invalid");
		return { sequence: Number(envelope.sequence),
			previousCheckpointSha256: envelope.previousCheckpointSha256 as string | null,
			event: payload.event as IncrementalCheckpointEvent, requestAudit, hostEffects,
			...(payload.objectiveCheckpointJson === undefined ? {} :
				{ objectiveCheckpointJson: payload.objectiveCheckpointJson as string }),
			replayAllowed: false, scientificAcceptance: "unreviewed" };
	} catch (error) { throw diagnostic(error, "decoded-schema", "payload-structure-invalid"); }
}

function fail(stage: IncrementalCheckpointFailureStage = "decoded-schema",
	reason: IncrementalCheckpointFailureReason = "payload-structure-invalid"): never {
	throw new IncrementalCheckpointError(stage, reason);
}
function finiteNonnegative(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
function natural(value: unknown): value is number {
	return Number.isSafeInteger(value) && Number(value) >= 0;
}
function text(value: unknown, max = 4096): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= max;
}
function validObjectiveCheckpoint(value: unknown): value is string {
	if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > 4 * 1024 * 1024)
		return false;
	try { return JSON.parse(value)?.kind === "original-objective-progress"; }
	catch { return false; }
}
function projectAudit(input: IncrementalCheckpointInput["requestAudit"]) {
	if (input.version !== 3 || input.kind !== "accounting-only-request-audit" ||
		!Array.isArray(input.requests) || !finiteNonnegative(input.settledCny) ||
		!finiteNonnegative(input.unknownObservedCny) || !natural(input.unpricedRequestCount) ||
		(input.pricingProfile !== undefined && !isNativeCnyPricingRecord(input.pricingProfile))) fail();
	const seen = new Set<string>();
	const requests = input.requests.map(row => {
		if (!id.test(row.requestId) || seen.has(row.requestId) || !hex64.test(row.sessionId) ||
			!natural(row.inputPayloadBytes) || row.inputPayloadBytes === 0 ||
			!natural(row.maxOutputTokens) || row.maxOutputTokens === 0 ||
			typeof row.responseReceived !== "boolean" ||
			!["settled", "unknown", "in-flight"].includes(row.status) ||
			(row.settledCny !== null && !finiteNonnegative(row.settledCny)) ||
			(row.unknownObservedCny !== null && !finiteNonnegative(row.unknownObservedCny)) ||
			(row.status === "settled" && !row.responseReceived) ||
			(row.status === "settled" && row.unknownObservedCny !== null) ||
			(row.status !== "settled" && row.settledCny !== null) ||
			(row.contextRejected === true && row.responseReceived !== true) ||
			(row.retryOfRequestId !== undefined && !id.test(row.retryOfRequestId))) fail();
		seen.add(row.requestId);
		const usage = row.reportedUsage;
		if (usage && (![usage.input, usage.output, usage.cacheRead, usage.cacheWrite,
			usage.totalTokens].every(natural) ||
			(usage.reportedUsdCost !== null && !finiteNonnegative(usage.reportedUsdCost)) ||
			(usage.costStatus !== null && !text(usage.costStatus, 32)))) fail();
		const overflow = row.contextOverflow;
		if (Boolean(overflow) !== (row.contextRejected === true)) fail();
		if (overflow && (!row.contextRejected || ![overflow.contextWindow,
			overflow.messagesTokens, overflow.completionTokens, overflow.requestedTokens,
			overflow.allowedCompletionTokens].every(natural))) fail();
		return { requestId: row.requestId, sessionId: row.sessionId,
			responseReceived: row.responseReceived, inputPayloadBytes: row.inputPayloadBytes,
			maxOutputTokens: row.maxOutputTokens,
			...(row.contextRejected ? { contextRejected: true as const } : {}),
			...(overflow ? { contextOverflow: { contextWindow: overflow.contextWindow,
				messagesTokens: overflow.messagesTokens, completionTokens: overflow.completionTokens,
				requestedTokens: overflow.requestedTokens,
				allowedCompletionTokens: overflow.allowedCompletionTokens } } : {}),
			...(row.retryOfRequestId ? { retryOfRequestId: row.retryOfRequestId } : {}),
			status: row.status, settledCny: row.settledCny,
			unknownObservedCny: row.unknownObservedCny,
			reportedUsage: usage ? { input: usage.input, output: usage.output,
				cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite,
				totalTokens: usage.totalTokens, reportedUsdCost: usage.reportedUsdCost,
				costStatus: usage.costStatus } : null };
	});
	if (requests.some(row => row.retryOfRequestId && !seen.has(row.retryOfRequestId)) ||
		input.settledCny !== requests.reduce((sum, row) => sum + (row.settledCny ?? 0), 0) ||
		input.unknownObservedCny !== requests.reduce((sum, row) => sum + (row.unknownObservedCny ?? 0), 0) ||
		input.unpricedRequestCount !== requests.filter(row =>
			row.settledCny === null && row.unknownObservedCny === null).length) fail();
	return { version: 3 as const, kind: "accounting-only-request-audit" as const,
		requests, settledCny: input.settledCny,
		unknownObservedCny: input.unknownObservedCny,
		unpricedRequestCount: input.unpricedRequestCount,
		...(input.pricingProfile ? { pricingProfile: structuredClone(input.pricingProfile) } : {}) };
}
function projectEffects(input: HostEffectPrefixObservationV1, source: IncrementalCheckpointSource,
	requestIds: readonly string[]) {
	if (input.version !== 1 || input.kind !== "host-effect-prefix-observation" ||
		input.complete !== false || input.selectionAuthority !== false ||
		input.source.runId !== source.runId || input.source.runAttempt !== source.runAttempt ||
		input.source.commit !== source.commit ||
		input.priorEnvelopeSha256 !== source.priorEnvelopeSha256 ||
		!Array.isArray(input.requestIds) || !Array.isArray(input.historicalGoalRunIds) ||
		!Array.isArray(input.goals) || !Array.isArray(input.sessions) ||
		JSON.stringify(input.requestIds) !== JSON.stringify(requestIds)) fail();
	const goalIds = new Set<string>();
	const goals = input.goals.map(goal => {
		if (!text(goal.runId, 128) || goalIds.has(goal.runId) ||
			!["active", "partial", "blocked", "fulfilled"].includes(goal.outcome) ||
			!Array.isArray(goal.tasks) || !Array.isArray(goal.operations)) fail();
		goalIds.add(goal.runId);
		return { runId: goal.runId, outcome: goal.outcome,
			tasks: goal.tasks.map(task => {
				if (!text(task.taskId, 128) || !["execute", "check", "reason"].includes(task.mode) ||
					!["running", "returned", "failed", "accepted", "rejected", "unknown"]
						.includes(task.status) ||
					(task.sessionId !== "" && !hex64.test(task.sessionId))) fail();
				return { taskId: task.taskId, mode: task.mode, status: task.status,
					sessionId: task.sessionId };
			}), operations: goal.operations.map(operation => {
				if (!text(operation.id, 128) || !text(operation.taskId, 128) ||
					!["prepared", "issued", "response-received", "partial-settled",
						"terminal-response-incomplete", "unknown", "confirmed", "not-issued"]
						.includes(operation.status)) fail();
				return { id: operation.id, taskId: operation.taskId, status: operation.status };
			}) };
	});
	const sessions = input.sessions.map(session => {
		if (!hex64.test(session.sessionId) || !["none", "read-dir", "confined-execution"].includes(session.kind)) fail();
		const grant = session.grant;
		if ((session.kind === "confined-execution" &&
			(!grant || !text(session.taskId, 128) || !text(session.workRoot))) ||
			(session.kind !== "confined-execution" && (grant || session.workRoot || session.taskId))) fail();
		if (grant && (grant.version !== 1 || grant.kind !== "confined-campaign-files" ||
			!text(grant.root) || !Array.isArray(grant.writableFiles) ||
			grant.writableFiles.some(file => !text(file)) ||
			new Set(grant.writableFiles).size !== grant.writableFiles.length)) fail();
		if (session.goalRunId !== undefined && !text(session.goalRunId, 128)) fail();
		return { sessionId: session.sessionId, kind: session.kind,
			...(session.goalRunId ? { goalRunId: session.goalRunId } : {}),
			...(session.taskId ? { taskId: session.taskId } : {}),
			...(session.workRoot ? { workRoot: session.workRoot } : {}),
			...(grant ? { grant: { version: 1 as const,
				kind: "confined-campaign-files" as const, root: grant.root,
				writableFiles: [...grant.writableFiles] } } : {}) };
	});
	return { version: 1 as const, kind: "host-effect-prefix-observation" as const,
		complete: false as const, selectionAuthority: false as const,
		source: { runId: source.runId, runAttempt: source.runAttempt, commit: source.commit },
		priorEnvelopeSha256: source.priorEnvelopeSha256,
		historicalGoalRunIds: input.historicalGoalRunIds.map(value => {
			if (!text(value, 128)) fail(); return value;
		}), goals, sessions, requestIds: [...requestIds] };
}
/** A snapshot may skip intermediate controller saves. Follow only controller
 * state edges, including their transitive paths, with no ordering by label. */
function forwardStatus(before: string, after: string,
	edges: Readonly<Record<string, readonly string[]>>): boolean {
	if (before === after) return true;
	const visited = new Set([before]);
	const queue = [before];
	while (queue.length) {
		const current = queue.shift()!;
		for (const next of edges[current] ?? []) {
			if (next === after) return true;
			if (!visited.has(next)) { visited.add(next); queue.push(next); }
		}
	}
	return false;
}
const goalEdges: Readonly<Record<string, readonly string[]>> = {
	active: ["partial", "blocked", "fulfilled"],
};
const taskEdges: Readonly<Record<string, readonly string[]>> = {
	running: ["returned", "failed", "unknown"],
	returned: ["accepted", "rejected"],
	unknown: ["failed"],
};
const operationEdges: Readonly<Record<string, readonly string[]>> = {
	prepared: ["issued", "not-issued"],
	issued: ["response-received", "partial-settled", "terminal-response-incomplete",
		"unknown", "not-issued"],
	unknown: ["confirmed", "not-issued"],
};
function retainsPrefix(prior: Projected, next: Projected): void {
	const before = prior.audit.requests, after = next.audit.requests;
	if (after.length < before.length || before.some((row, index) => {
		const current = after[index];
		return !current || current.requestId !== row.requestId ||
			current.sessionId !== row.sessionId ||
			current.inputPayloadBytes !== row.inputPayloadBytes ||
			current.maxOutputTokens !== row.maxOutputTokens ||
			current.retryOfRequestId !== row.retryOfRequestId ||
			(row.status !== "in-flight" && current.status === "in-flight") ||
			(row.responseReceived && !current.responseReceived) ||
			(row.contextRejected && (!current.contextRejected ||
				JSON.stringify(current.contextOverflow) !== JSON.stringify(row.contextOverflow))) ||
			(row.status === "settled" && row.settledCny !== null &&
				(current.status !== "settled" || current.settledCny !== row.settledCny)) ||
			(row.status === "unknown" && (current.status !== "unknown" ||
				(row.unknownObservedCny !== null &&
					current.unknownObservedCny !== row.unknownObservedCny))) ||
			(row.reportedUsage !== null &&
				JSON.stringify(current.reportedUsage) !== JSON.stringify(row.reportedUsage));
	})) fail("monotonic-regression", "request-prefix-regressed");
	const old = prior.effects, current = next.effects;
	if (current.historicalGoalRunIds.length < old.historicalGoalRunIds.length ||
		old.historicalGoalRunIds.some((id, index) => current.historicalGoalRunIds[index] !== id) ||
		old.goals.some(goal => {
			const newer = current.goals.find(row => row.runId === goal.runId);
			return !newer || !forwardStatus(goal.outcome, newer.outcome, goalEdges) ||
				goal.tasks.some(task =>
				!newer.tasks.some(row => row.taskId === task.taskId && row.mode === task.mode &&
					(task.sessionId === "" || row.sessionId === task.sessionId) &&
					forwardStatus(task.status, row.status, taskEdges))) ||
				goal.operations.some(operation => !newer.operations.some(row =>
					row.id === operation.id && row.taskId === operation.taskId &&
					forwardStatus(operation.status, row.status, operationEdges)));
		}) || old.sessions.some(session => !current.sessions.some(row =>
			row.sessionId === session.sessionId && row.kind === session.kind &&
			(session.goalRunId === undefined || row.goalRunId === session.goalRunId) &&
			(session.taskId === undefined || row.taskId === session.taskId) &&
			(session.workRoot === undefined || row.workRoot === session.workRoot) &&
			JSON.stringify(row.grant) === JSON.stringify(session.grant))))
		fail("monotonic-regression", "host-effect-prefix-regressed");
}

/**
 * Keeps one complete host-control prefix in an existing wrapper allowlist file.
 * The caller must await record() at each required boundary. An abrupt process
 * kill leaves the old complete file or the new complete file; it says nothing
 * about an unobserved suffix. Survival beyond the job also requires the
 * workflow's existing always() encryption and artifact upload to run.
 */
export class IncrementalPrivateCheckpointJournal {
	private sequence = 0;
	private currentSha256: string | null = null;
	private failure: IncrementalCheckpointError | undefined;
	private tail: Promise<void> = Promise.resolve();
	private readonly options: Readonly<{
		source: IncrementalCheckpointSource; outputDir: string;
		publish?: IncrementalCheckpointPublisher;
	}>;
	constructor(options: Readonly<{
		source: IncrementalCheckpointSource; outputDir: string; authenticatedMissionKey: Buffer;
		publish?: IncrementalCheckpointPublisher;
	}>) {
		const { authenticatedMissionKey, ...safeOptions } = options;
		this.options = { ...safeOptions, source: { ...options.source } };
		const source = options.source;
		if (!text(source.repository, 160) || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(source.repository) ||
			!/^\d+$/.test(source.runId) || !Number.isSafeInteger(source.runAttempt) ||
			source.runAttempt < 1 || !commit.test(source.commit) ||
			!["push", "workflow_dispatch"].includes(source.event) ||
			!hex64.test(source.priorEnvelopeSha256)) fail("source", "binding-mismatch");
		journalKeys.set(this, deriveKey(authenticatedMissionKey, source));
	}

	/** Failure is sticky: the caller must not start the next dependent effect. */
	record(event: IncrementalCheckpointEvent,
		input: IncrementalCheckpointInput): Promise<StoredIncrementalCheckpoint> {
		if (this.failure) return Promise.reject(this.failure);
		if (!["initial", "request-reserved", "request-observed", "host-effect-observed",
			"control-observed"].includes(event)) return Promise.reject(
			new IncrementalCheckpointError("decoded-schema", "payload-structure-invalid"));
		// Project immediately, before another concurrent caller mutates its source.
		let audit: ReturnType<typeof projectAudit>;
		let effects: ReturnType<typeof projectEffects>;
		let objectiveCheckpointJson: string | undefined;
		try { audit = projectAudit(input.requestAudit); }
		catch {
			this.failure = new IncrementalCheckpointError("decoded-schema", "request-audit-invalid");
			return Promise.reject(this.failure);
		}
		try {
			effects = projectEffects(input.hostEffects, this.options.source,
				audit.requests.map(row => row.requestId));
		} catch {
			this.failure = new IncrementalCheckpointError("decoded-schema", "host-effect-invalid");
			return Promise.reject(this.failure);
		}
		try {
			objectiveCheckpointJson = input.objectiveCheckpointJson;
			if (objectiveCheckpointJson !== undefined &&
				!validObjectiveCheckpoint(objectiveCheckpointJson))
				fail("decoded-schema", "objective-checkpoint-invalid");
		} catch (error) {
			this.failure = diagnostic(error, "decoded-schema", "objective-checkpoint-invalid");
			return Promise.reject(this.failure);
		}
		const work = this.tail.then(async (): Promise<StoredIncrementalCheckpoint> => {
			if (this.failure) throw this.failure;
			const prior = journalLast.get(this);
			const projected: Projected = { audit, effects,
				...(objectiveCheckpointJson === undefined ?
					(prior?.objectiveCheckpointJson === undefined ? {} :
						{ objectiveCheckpointJson: prior.objectiveCheckpointJson }) :
					{ objectiveCheckpointJson }) };
			if (prior) retainsPrefix(prior, projected);
			const directory = this.options.outputDir;
			const file = path.join(directory, INCREMENTAL_CHECKPOINT_FILE);
			const temporary = path.join(directory, `.incremental-control-prefix.pending-${randomUUID()}`);
			let handle: Awaited<ReturnType<typeof open>> | undefined;
			try {
				const directoryInfo = await lstat(directory);
				if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink() ||
					(directoryInfo.mode & 0o077) !== 0)
					fail("file-io", "unsafe-output-path");
				try {
					const priorInfo = await lstat(file);
					if (!priorInfo.isFile() || priorInfo.isSymbolicLink() ||
						this.currentSha256 === null ||
						hash(await readFile(file)) !== this.currentSha256)
						fail("file-io", "existing-prefix-mismatch");
				} catch (error) {
					if (!(error instanceof Error && "code" in error && error.code === "ENOENT" &&
						this.currentSha256 === null)) throw error;
				}
				const sequence = this.sequence + 1;
				const payload = { version: 1 as const,
						kind: "mul-pis-incremental-private-control-checkpoint" as const,
						source: { ...this.options.source }, sequence,
						previousCheckpointSha256: this.currentSha256,
						event, requestAudit: audit, hostEffects: effects,
						...(projected.objectiveCheckpointJson === undefined ? {} :
							{ objectiveCheckpointJson: projected.objectiveCheckpointJson }),
						replayAllowed: false as const, scientificAcceptance: "unreviewed" as const };
				const nonce = randomBytes(12);
				const key = journalKeys.get(this);
				if (!key) fail("authentication", "key-invalid");
				const cipher = createCipheriv("aes-256-gcm", key, nonce);
				cipher.setAAD(aad(this.options.source, sequence, this.currentSha256));
				const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"),
					cipher.final()]);
				const document = { status: "incomplete" as const,
					incrementalControlEnvelope: { version: 1 as const,
						kind: "mul-pis-authenticated-incremental-control-prefix" as const,
						source: { ...this.options.source }, sequence,
						previousCheckpointSha256: this.currentSha256,
						nonceB64: nonce.toString("base64"),
						ciphertextB64: ciphertext.toString("base64"),
						tagB64: cipher.getAuthTag().toString("base64") } };
				const bytes = `${JSON.stringify(document)}\n`;
				// Existing RSA wrapper transport has a 64 MiB per-file safety bound.
				if (Buffer.byteLength(bytes, "utf8") > 64 * 1024 * 1024)
					fail("file-io", "file-bound-exceeded");
				handle = await open(temporary, "wx", 0o600);
				await handle.writeFile(bytes, "utf8");
				await handle.sync();
				await handle.close(); handle = undefined;
				await rename(temporary, file);
				const directoryHandle = await open(directory, "r");
				try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
				const sha256 = hash(bytes);
				this.sequence = sequence;
				this.currentSha256 = sha256;
				journalLast.set(this, projected);
				try { await this.options.publish?.({ file, sha256, sequence }); }
				catch { fail("file-io", "publish-failed"); }
				return { sequence, file: INCREMENTAL_CHECKPOINT_FILE, sha256 };
			} finally {
				await handle?.close().catch(() => undefined);
				await rm(temporary, { force: true }).catch(() => undefined);
			}
		}).catch(error => {
			this.failure = diagnostic(error, "file-io", "storage-io-failed");
			throw this.failure;
		});
		this.tail = work.then(() => undefined, () => undefined);
		return work;
	}
}
