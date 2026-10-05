/**
 * Private M07 result archive. It records candidate evidence and a pending
 * lesson, not an adopted scientific fact. The caller keeps the destination
 * private and returns it only through an authorized encrypted transport.
 */
import { chmod, copyFile, lstat, mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { CurrentGoal, M07TaskRecord } from "../m07/types.ts";
import { isSafeRelativeOutputPath } from "../m07/expected-output.ts";
import { isKnowledgeRef } from "../knowledge/experience-index.ts";
import type { KnowledgeRecord, KnowledgeRef, KnowledgeStore, Limit, Snapshot } from "../knowledge/types.ts";

const ARCHIVE_NAME = "workflow-archive.json";
/** Fixed name for the private transport allowlist; never publish this file directly. */
export const M04_KNOWLEDGE_EXPORT_NAME = "m04-adopted-knowledge.json";
const MAX_ROUNDS = 8;
const MAX_KNOWLEDGE_RECORDS = 48;
const MAX_KNOWLEDGE_BYTES = 256_000;
const FILES = [
	{ name: "candidate.cpp", maxBytes: 128_000 },
	{ name: "verification.json", maxBytes: 256_000 },
	{ name: "lesson-delta.json", maxBytes: 16_000 },
] as const;

export interface PrivateM07ArchiveV1 {
	version: 1;
	kind: "m07-private-candidate-archive";
	goalRunId: string;
	taskId: string;
	createdAt: string;
	goalOutcome: "active" | "partial" | "blocked" | "fulfilled";
	taskStatus: M07TaskRecord["status"];
	loopStopReason?: M07TaskRecord["loopStopReason"];
	files: Array<{ name: typeof FILES[number]["name"]; status: "present" | "missing" | "invalid"; bytes?: number }>;
	controllerEvidence: {
		rounds: Array<{ index: number; verdict: "ready" | "revise" | "replan" | "blocked" | "unavailable";
			feedback?: string; feedbackStatus: "present" | "missing" | "excluded";
			candidate: { status: "present" | "missing" | "invalid"; file?: string; bytes?: number };
			verification: { status: "present" | "missing" | "invalid"; file?: string; bytes?: number } }>;
		reviewChecks: Array<{ criterion: string; result: "passed" | "failed" | "not_run" }>;
		reviewStatus: "accepted" | "rejected" | "unreviewed";
	};
	lesson: { state: "pending-m04" | "none" | "missing" | "invalid"; action?: "propose" | "amend" | "contradict"; evidencePaths?: string[] };
	m04?: { state: "not-run" | "completed" | "failed"; runId?: string; proposalSubmitted?: boolean; snapshotCreated?: boolean;
		adoptedExperienceRefs?: KnowledgeRef[];
		knowledgeExport?: { state: "complete" | "none" | "incomplete"; file?: typeof M04_KNOWLEDGE_EXPORT_NAME; recordCount?: number; reason?: string } };
	knowledgeReuse: { trustedAdoption: false; adoptionPath: "M04"; nextUse: "explicit-candidate-context-only" };
}

/** A frozen, bounded copy of actual published knowledge, not an import authorization. */
export interface PrivateM04KnowledgeExportV1 {
	version: 1;
	kind: "m04-published-knowledge-export";
	m04RunId: string;
	storeId: string;
	exportedAt: string;
	snapshot: Snapshot;
	m04SourceRefs: KnowledgeRef[];
	/** Targets of limits published in this M04 snapshot, including pre-existing records. */
	m04LimitTargetRefs: KnowledgeRef[];
	/** Eligible at export only; reuse still requires explicit selection and live revalidation. */
	adoptedExperienceRefs: KnowledgeRef[];
	records: Array<{ ref: KnowledgeRef; record: KnowledgeRecord; availabilityAtExport: string }>;
	dependencies: Array<{ from: KnowledgeRef; to: KnowledgeRef; kind: "required" | "scope" | "relation" }>;
	activeLimits: Limit[];
	limitHistory: Limit[];
	provenance: { scope: "published-m04-source-records-and-required-dependencies"; liveLimitsCheckedAt: string;
		restore: "explicit-provenance-and-live-limit-check-required" };
}

function inside(root: string, file: string): boolean { return file.startsWith(`${root}${path.sep}`); }

function safeFeedback(value: unknown): string | undefined {
	if (typeof value !== "string" || !value.trim() || value.length > 2_000 || value.split("\n").length > 8) return undefined;
	// Reviewer feedback is one structured field, never a raw reviewer or builder transcript.
	if (/(?:authorization\s*:|bearer\s+\S+|api[_-]?key\s*[:=]|password\s*[:=]|-----BEGIN [A-Z ]*PRIVATE KEY-----|sk-[A-Za-z0-9_-]{6,}|tool[_ -]?call\s*[:=])/i.test(value)) return undefined;
	return value;
}

function safeVerification(raw: Buffer): Record<string, unknown> | undefined {
	let parsed: Record<string, unknown>;
	try { parsed = JSON.parse(raw.toString("utf8")) as Record<string, unknown>; }
	catch { return undefined; }
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
	const copy = (value: unknown, keys: string[]): Record<string, unknown> | undefined => {
		if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
		return Object.fromEntries(keys.filter(key => ["string", "number", "boolean"].includes(typeof (value as Record<string, unknown>)[key]))
			.map(key => [key, (value as Record<string, unknown>)[key]]));
	};
	const boundedStatus = (value: unknown) => typeof value === "string" && /^[a-z_-]{1,32}$/.test(value) ? value : undefined;
	const metric = (value: unknown) => {
		if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
		const item = value as Record<string, unknown>;
		if (typeof item.label !== "string" || item.label.length > 80 || item.label.includes("\n") ||
			!safeFeedback(item.label) || typeof item.ms !== "number" || !Number.isFinite(item.ms) || item.ms < 0 || item.ms > 1e9) return undefined;
		return { label: item.label, ms: item.ms };
	};
	const numeric = (value: unknown, min: number, max: number, integer = false): value is number =>
		typeof value === "number" && Number.isFinite(value) && value >= min && value <= max && (!integer || Number.isSafeInteger(value));
	const trustedTimings = (value: unknown) => {
		if (!Array.isArray(value) || (value.length !== 0 && value.length !== 8)) return undefined;
		const rows = [];
		const seen = new Set<string>();
		for (const entry of value) {
			if (!entry || typeof entry !== "object" || Array.isArray(entry)) return undefined;
			const item = entry as Record<string, unknown>;
			if (!numeric(item.target, 1, 2, true) || !numeric(item.rows, 1, 1_000_000, true) ||
				!numeric(item.cols, 1, 1_000_000, true) || !numeric(item.threads, 1, 4, true) ||
				![1, 4].includes(item.threads) || !numeric(item.repeats, 1, 10_000, true) ||
				!numeric(item.elapsedNs, 1, Number.MAX_SAFE_INTEGER, true)) return undefined;
			const key = `${item.target}:${item.rows}:${item.cols}:${item.threads}`;
			if (seen.has(key)) return undefined;
			seen.add(key);
			rows.push({ target: item.target, rows: item.rows, cols: item.cols, threads: item.threads,
				repeats: item.repeats, elapsedNs: item.elapsedNs });
		}
		return rows;
	};
	const comparison = (value: unknown) => {
		if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
		const item = value as Record<string, unknown>;
		if (item.state === "unavailable") return { state: "unavailable" };
		if (item.state !== "measured" || !Array.isArray(item.ratios) || item.ratios.length !== 8 ||
			!item.ratios.every(ratio => numeric(ratio, 0, 1e9)) ||
			!numeric(item.medianRatio, 0, 1e9) || !numeric(item.minRatio, 0, 1e9)) return undefined;
		return { state: "measured", ratios: [...item.ratios], medianRatio: item.medianRatio, minRatio: item.minRatio };
	};
	const independent = parsed.independent && typeof parsed.independent === "object" && !Array.isArray(parsed.independent)
		? parsed.independent as Record<string, unknown> : undefined;
	const timings = independent?.timings === undefined ? undefined : trustedTimings(independent.timings);
	const baselineIndependent = parsed.originalBaselineIndependent && typeof parsed.originalBaselineIndependent === "object" &&
		!Array.isArray(parsed.originalBaselineIndependent) ? parsed.originalBaselineIndependent as Record<string, unknown> : undefined;
	const baselineTimings = baselineIndependent?.timings === undefined ? undefined : trustedTimings(baselineIndependent.timings);
	const originalComparison = parsed.originalHostComparison === undefined ? undefined : comparison(parsed.originalHostComparison);
	const priorComparison = parsed.priorCandidateComparison === undefined ? undefined : comparison(parsed.priorCandidateComparison);
	if ((independent?.timings !== undefined && !timings) || (independent?.status === "passed" && independent.timings !== undefined && timings?.length !== 8) ||
		(parsed.originalBaselineIndependent !== undefined && (baselineIndependent?.status !== "passed" || baselineTimings?.length !== 8)) ||
		(parsed.originalHostComparison !== undefined && !originalComparison) || (parsed.priorCandidateComparison !== undefined && !priorComparison)) return undefined;
	// Deliberate allowlist: no command arguments, stdout/stderr, tool logs or session material.
	const summary = {
		...(typeof parsed.version === "number" ? { version: parsed.version } : {}),
		...(boundedStatus(parsed.status) ? { status: boundedStatus(parsed.status) } : {}),
		...(copy(parsed.sourceShape, ["ok", "targetCount"]) ? { sourceShape: copy(parsed.sourceShape, ["ok", "targetCount"]) } : {}),
		...(copy(parsed.compile, ["success"]) ? { compile: copy(parsed.compile, ["success"]) } : {}),
		...(independent ? { independent: { ...copy(independent, ["mutationPasses"]),
			...(boundedStatus(independent.status) ? { status: boundedStatus(independent.status) } : {}),
			...(timings ? { timings } : {}) } } : {}),
		...(baselineTimings ? { originalBaselineIndependent: { status: "passed", timings: baselineTimings } } : {}),
		...(originalComparison ? { originalHostComparison: originalComparison } : {}),
		...(priorComparison ? { priorCandidateComparison: priorComparison } : {}),
		...(Array.isArray(parsed.originalCheckerRuns) ? { originalCheckerRuns: parsed.originalCheckerRuns.slice(0, 16).map(run => ({
			...copy(run, ["exitCode", "isolatedProcessWallMs"]),
			...(Array.isArray((run as Record<string, unknown>)?.reportedKernelMs) ? {
				reportedKernelMs: ((run as Record<string, unknown>).reportedKernelMs as unknown[]).slice(0, 12).map(metric).filter(Boolean),
			} : {}),
		})) } : {}),
	};
	return boundedStatus(parsed.status) && exportSafe(summary) ? summary : undefined;
}

async function archiveRoundArtifact(sourceRoot: string | undefined, index: number, kind: "candidate" | "verification", destination: string): Promise<{ status: "present" | "missing" | "invalid"; file?: string; bytes?: number }> {
	if (!sourceRoot) return { status: "missing" };
	const name = kind === "candidate" ? "candidate.cpp" : "verification.json";
	let source;
	try { source = await privateFile(sourceRoot, name, kind === "candidate" ? 128_000 : 256_000); }
	catch { return { status: "invalid" }; }
	if (!source) return { status: "missing" };
	const file = `round-${index}-${name}`;
	const target = path.join(destination, file), temporary = `${target}.${process.pid}.tmp`;
	if (kind === "candidate") {
		if (!exportSafe((await readFile(source.source)).toString("utf8"))) return { status: "invalid" };
		await copyFile(source.source, temporary);
		await chmod(temporary, 0o600);
	} else {
		const summary = safeVerification(await readFile(source.source));
		if (!summary) return { status: "invalid" };
		await writeFile(temporary, `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
	}
	await rename(temporary, target);
	return { status: "present", file, bytes: (await lstat(target)).size };
}

async function archiveRounds(task: M07TaskRecord, destination: string): Promise<PrivateM07ArchiveV1["controllerEvidence"]["rounds"]> {
	const rounds = task.executionRounds ?? [];
	if (rounds.length > MAX_ROUNDS) throw new Error("M07 archive has too many execution rounds");
	const seen = new Set<number>();
	const result: PrivateM07ArchiveV1["controllerEvidence"]["rounds"] = [];
	const parentReal = await realpath(path.dirname(task.workDir));
	for (const round of rounds) {
		if (!Number.isSafeInteger(round.index) || round.index < 1 || round.index > MAX_ROUNDS || seen.has(round.index))
			throw new Error("M07 archive has invalid execution round index");
		seen.add(round.index);
		// The snapshot must be the controller's known sibling, not a path supplied by model output.
		const expected = path.join(path.dirname(task.workDir), `round-${round.index}-snapshot`);
		let snapshot: string | undefined;
		if (round.reviewerSnapshotPath && path.resolve(round.reviewerSnapshotPath) === path.resolve(expected)) {
			try {
				const info = await lstat(expected), resolved = await realpath(expected);
				if (info.isDirectory() && !info.isSymbolicLink() && inside(parentReal, resolved)) snapshot = expected;
			} catch { /* A missing or invalid reviewer snapshot is explicitly recorded below. */ }
		}
		const feedback = safeFeedback(round.feedback);
		result.push({ index: round.index, verdict: round.verdict ?? "unavailable",
			...(feedback ? { feedback } : {}),
			feedbackStatus: feedback ? "present" : round.feedback ? "excluded" : "missing",
			candidate: await archiveRoundArtifact(snapshot, round.index, "candidate", destination),
			verification: await archiveRoundArtifact(snapshot, round.index, "verification", destination) });
	}
	return result;
}

async function privateFile(root: string, name: string, maxBytes: number): Promise<{ source: string; bytes: number } | undefined> {
	const source = path.join(root, name);
	let info;
	try { info = await lstat(source); }
	catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
	if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > maxBytes) throw new Error(`invalid bounded archive file: ${name}`);
	const rootReal = await realpath(root);
	const sourceReal = await realpath(source);
	if (!inside(rootReal, sourceReal)) throw new Error(`archive file escapes task work directory: ${name}`);
	return { source, bytes: info.size };
}

async function lessonState(raw: Buffer, workDir: string): Promise<PrivateM07ArchiveV1["lesson"]> {
	let delta: Record<string, unknown>;
	try { delta = JSON.parse(raw.toString("utf8")) as Record<string, unknown>; }
	catch { return { state: "invalid" }; }
	if (delta.version !== 1 || !["none", "propose", "amend", "contradict"].includes(String(delta.action)) ||
		!Array.isArray(delta.evidencePaths) || delta.evidencePaths.length > 20 ||
		delta.evidencePaths.some(item => typeof item !== "string" || !isSafeRelativeOutputPath(item)))
		return { state: "invalid" };
	if (delta.action === "none") return { state: "none" };
	if (typeof delta.observation !== "string" || !delta.observation.trim() ||
		typeof delta.applicability !== "string" || !delta.applicability.trim() || !delta.evidencePaths.length)
		return { state: "invalid" };
	if ((delta.action === "amend" || delta.action === "contradict") &&
		(!delta.priorRef || typeof delta.priorRef !== "object" || typeof (delta.priorRef as Record<string, unknown>).storeId !== "string" ||
			typeof (delta.priorRef as Record<string, unknown>).recordId !== "string" ||
			!Number.isInteger((delta.priorRef as Record<string, unknown>).version))) return { state: "invalid" };
	const rootReal = await realpath(workDir);
	for (const item of delta.evidencePaths as string[]) {
		try {
			const evidence = await realpath(path.join(workDir, item));
			if (!inside(rootReal, evidence) || !(await lstat(evidence)).isFile()) return { state: "invalid" };
		} catch { return { state: "invalid" }; }
	}
	return { state: "pending-m04", action: delta.action as "propose" | "amend" | "contradict",
		evidencePaths: delta.evidencePaths as string[] };
}

/** Copy only explicit bounded work products, never session/auth/profile files. */
export async function archivePrivateM07Task(input: {
	goal: CurrentGoal; task: M07TaskRecord; destination: string;
}): Promise<PrivateM07ArchiveV1> {
	const { goal, task } = input;
	if (task.taskId !== goal.tasks.find(item => item.taskId === task.taskId)?.taskId || !/^T\d{3,}$/.test(task.taskId))
		throw new Error("task is not part of the supplied M07 goal");
	await mkdir(input.destination, { recursive: true, mode: 0o700 });
	const files: PrivateM07ArchiveV1["files"] = [];
	let lesson: PrivateM07ArchiveV1["lesson"] = { state: "missing" };
	for (const item of FILES) {
		let source;
		try { source = await privateFile(task.workDir, item.name, item.maxBytes); }
		catch { files.push({ name: item.name, status: "invalid" }); if (item.name === "lesson-delta.json") lesson = { state: "invalid" }; continue; }
		if (!source) { files.push({ name: item.name, status: "missing" }); continue; }
		if (item.name === "lesson-delta.json") {
			const raw = await readFile(source.source);
			lesson = exportSafe(raw.toString("utf8")) ? await lessonState(raw, task.workDir) : { state: "invalid" };
			if (lesson.state === "invalid") { files.push({ name: item.name, status: "invalid" }); continue; }
		}
		if (item.name === "candidate.cpp" && !exportSafe((await readFile(source.source)).toString("utf8"))) {
			files.push({ name: item.name, status: "invalid" }); continue;
		}
		const target = path.join(input.destination, item.name);
		const temporary = `${target}.${process.pid}.tmp`;
		if (item.name === "verification.json") {
			const summary = safeVerification(await readFile(source.source));
			if (!summary) { files.push({ name: item.name, status: "invalid" }); continue; }
			await writeFile(temporary, `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
		} else {
			await copyFile(source.source, temporary);
			await chmod(temporary, 0o600);
		}
		await rename(temporary, target);
		files.push({ name: item.name, status: "present", bytes: (await lstat(target)).size });
	}
	const archive: PrivateM07ArchiveV1 = {
		version: 1, kind: "m07-private-candidate-archive", goalRunId: goal.runId, taskId: task.taskId,
		createdAt: new Date().toISOString(), goalOutcome: goal.lifecycle === "finished" ? (goal.outcome ?? "partial") : "active",
		taskStatus: task.status, ...(task.loopStopReason ? { loopStopReason: task.loopStopReason } : {}), files,
		controllerEvidence: {
			rounds: await archiveRounds(task, input.destination),
			reviewChecks: (task.review?.checks ?? []).map(check => ({ criterion: check.criterion, result: check.result })),
			reviewStatus: task.status === "accepted" ? "accepted" : task.status === "rejected" ? "rejected" : "unreviewed",
		},
		lesson,
		m04: { state: "not-run" },
		knowledgeReuse: { trustedAdoption: false, adoptionPath: "M04", nextUse: "explicit-candidate-context-only" },
	};
	const target = path.join(input.destination, ARCHIVE_NAME);
	const temporary = `${target}.${process.pid}.tmp`;
	await writeFile(temporary, `${JSON.stringify(archive, null, 2)}\n`, { mode: 0o600 });
	await rename(temporary, target);
	return archive;
}

const refKey = (ref: KnowledgeRef) => `${ref.storeId}/${ref.recordId}@${ref.version}`;

function exportSafe(value: unknown): boolean {
	const text = JSON.stringify(value);
	return text.length <= MAX_KNOWLEDGE_BYTES &&
		!/(?:"(?:password|passwd|secret|credential|authorization|api[_-]?key|access[_-]?token|tool[_-]?args?|transcript|messages|args|arguments)"\s*:|(?:password|passwd|secret|credential|authorization|api[_-]?key|access[_-]?token)\s*[:=]|bearer\s+\S+|-----BEGIN [A-Z ]*PRIVATE KEY-----|sk-[A-Za-z0-9_-]{6,}|(?:\\n|^)\s*(?:assistant|user|system|tool)\s*:)/i.test(text);
}

function experienceDefinition(record: KnowledgeRecord): { requiredRefs: KnowledgeRef[]; targetKind: string; applicableStages: string[]; requiredTags: string[] } | undefined {
	const value = record.fields.experience;
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const definition = value as Record<string, unknown>;
	if (definition.version !== 1 || (definition.targetKind !== "executor" && definition.targetKind !== "improver") ||
		!Array.isArray(definition.applicableStages) || !definition.applicableStages.every(item => typeof item === "string" && item.length <= 80) ||
		!Array.isArray(definition.requiredTags) || !definition.requiredTags.every(item => typeof item === "string" && item.length <= 240) ||
		!Array.isArray(definition.requiredRefs) || definition.requiredRefs.length > MAX_KNOWLEDGE_RECORDS ||
		!definition.requiredRefs.every(isKnowledgeRef)) return undefined;
	return { requiredRefs: definition.requiredRefs as KnowledgeRef[], targetKind: definition.targetKind,
		applicableStages: definition.applicableStages as string[], requiredTags: definition.requiredTags as string[] };
}

async function exportM04Knowledge(destination: string, m04: NonNullable<PrivateM07ArchiveV1["m04"]>, store?: KnowledgeStore): Promise<{
	status: NonNullable<NonNullable<PrivateM07ArchiveV1["m04"]>["knowledgeExport"]>;
	refs: KnowledgeRef[];
}> {
	const incomplete = (reason: string) => ({ status: { state: "incomplete" as const, reason }, refs: [] });
	if (m04.state !== "completed") return { status: { state: "none" }, refs: [] };
	if (!m04.runId || !store) return incomplete("M04 run identity or knowledge store unavailable");
	try {
		const storeId = await store.storeId();
		const snapshot = await store.current();
		if (!snapshot || !/^G\d{3,}$/.test(snapshot.id) || snapshot.records.length > 2_000)
			return incomplete("bounded published M04 snapshot unavailable");
		const initialLimits = await store.limits();
		if (initialLimits.length > 2_000) return incomplete("knowledge limit history exceeds bounded export");
		const m04SourceRefs: KnowledgeRef[] = [];
		for (const item of snapshot.records) {
			const record = await store.get(item.id, item.version);
			if (!record) return incomplete("published snapshot record unavailable");
			if (record.source.stage !== "M04" || record.source.runId !== m04.runId) continue;
			m04SourceRefs.push({ storeId, recordId: record.id, version: record.version });
			if (m04SourceRefs.length > MAX_KNOWLEDGE_RECORDS) return incomplete("too many published M04 source records");
		}
		const m04LimitTargetRefs: KnowledgeRef[] = [];
		for (const limit of initialLimits.filter(item => item.since === snapshot.createdAt)) {
			const match = /^([CKEJQDX]\d{3,})(?:@(\d+))?$/.exec(limit.target);
			if (!match) return incomplete("published M04 limit target is invalid");
			const published = snapshot.records.find(item => item.id === match[1]);
			const version = match[2] ? Number(match[2]) : published?.version;
			if (!version || !Number.isSafeInteger(version) || version < 1) return incomplete("published M04 limit target is unavailable");
			const ref = { storeId, recordId: match[1], version };
			if (!m04LimitTargetRefs.some(item => refKey(item) === refKey(ref))) m04LimitTargetRefs.push(ref);
		}
		if (!m04SourceRefs.length && !m04LimitTargetRefs.length && !m04.snapshotCreated) return { status: { state: "none" }, refs: [] };
		const records = new Map<string, PrivateM04KnowledgeExportV1["records"][number]>();
		const dependencies: PrivateM04KnowledgeExportV1["dependencies"] = [];
		const visiting = new Set<string>();
		const visit = async (ref: KnowledgeRef): Promise<boolean> => {
			const identity = refKey(ref);
			if (records.has(identity)) return true;
			if (ref.storeId !== storeId || visiting.size + records.size >= MAX_KNOWLEDGE_RECORDS) return false;
			if (visiting.has(identity)) return false;
			visiting.add(identity);
			const record = await store.get(ref.recordId, ref.version);
			if (!record || record.refs.length > 100 || record.scope.length > 64 || !exportSafe(record)) { visiting.delete(identity); return false; }
			const availability = await store.availability(ref.recordId, ref.version);
			const sanitized: KnowledgeRecord = { ...record, source: { stage: record.source.stage, runId: record.source.runId } };
			if (!exportSafe(sanitized)) { visiting.delete(identity); return false; }
			const model = record.fields.experience === undefined ? undefined : experienceDefinition(record);
			if (record.fields.experience !== undefined && !model) { visiting.delete(identity); return false; }
			const required = model?.requiredRefs ?? [];
			const scoped: KnowledgeRef[] = [];
			for (const scopeId of record.scope) {
				const published = snapshot.records.find(item => item.id === scopeId);
				if (!published || !/^X\d{3,}$/.test(scopeId)) { visiting.delete(identity); return false; }
				scoped.push({ storeId, recordId: scopeId, version: published.version });
			}
			const related: KnowledgeRef[] = [];
			for (const relation of record.refs) {
				const match = /^([CKEJQDX]\d{3,})(?:@(\d+))?$/.exec(relation.target);
				if (!match) { visiting.delete(identity); return false; }
				const published = snapshot.records.find(item => item.id === match[1]);
				const version = match[2] ? Number(match[2]) : published?.version;
				if (!version || !Number.isSafeInteger(version) || version < 1) { visiting.delete(identity); return false; }
				related.push({ storeId, recordId: match[1], version });
			}
			for (const [kind, refs] of [["required", required], ["scope", scoped], ["relation", related]] as const) for (const child of refs) {
				dependencies.push({ from: ref, to: child, kind });
				if (!await visit(child)) { visiting.delete(identity); return false; }
			}
			visiting.delete(identity);
			records.set(identity, { ref, record: sanitized, availabilityAtExport: availability.availability });
			return true;
		};
		for (const ref of [...m04SourceRefs, ...m04LimitTargetRefs])
			if (!await visit(ref)) return incomplete("M04 dependency or limit target unavailable, unsafe, cyclic or over budget");
		const adopted: KnowledgeRef[] = [];
		for (const ref of m04SourceRefs) {
			const item = records.get(refKey(ref))!;
			const model = experienceDefinition(item.record);
			if (!model || item.record.usageDecision !== "adopted" || item.availabilityAtExport !== "usable_conditionally" ||
				model.targetKind !== "executor" || !model.applicableStages.includes("M07") || item.record.scope.length) continue;
			if (model.requiredRefs.some(required => records.get(refKey(required))?.availabilityAtExport !== "usable_conditionally")) continue;
			adopted.push(ref);
			if (adopted.length > 24) return incomplete("too many live applicable M04 experience records");
		}
		const after = await store.current();
		if (after?.id !== snapshot.id || JSON.stringify(await store.limits()) !== JSON.stringify(initialLimits))
			return incomplete("knowledge snapshot or live limits changed during export");
		const document: PrivateM04KnowledgeExportV1 = {
			version: 1, kind: "m04-published-knowledge-export", m04RunId: m04.runId, storeId,
			exportedAt: new Date().toISOString(), snapshot,
			m04SourceRefs, m04LimitTargetRefs, adoptedExperienceRefs: adopted, records: [...records.values()], dependencies,
			activeLimits: initialLimits.filter(limit => !limit.liftedAt), limitHistory: initialLimits,
			provenance: { scope: "published-m04-source-records-and-required-dependencies", liveLimitsCheckedAt: new Date().toISOString(),
				restore: "explicit-provenance-and-live-limit-check-required" },
		};
		const serialized = `${JSON.stringify(document, null, 2)}\n`;
		if (Buffer.byteLength(serialized) > MAX_KNOWLEDGE_BYTES || !exportSafe(document)) return incomplete("M04 knowledge export is unsafe or exceeds byte budget");
		const target = path.join(destination, M04_KNOWLEDGE_EXPORT_NAME), temporary = `${target}.${process.pid}.tmp`;
		await writeFile(temporary, serialized, { mode: 0o600 });
		await rename(temporary, target);
		return { status: { state: "complete", file: M04_KNOWLEDGE_EXPORT_NAME, recordCount: records.size }, refs: adopted };
	} catch {
		return incomplete("M04 knowledge could not be safely exported");
	}
}

/** Record the actual M04 outcome without converting a candidate lesson into an adopted fact. */
export async function recordPrivateM04Outcome(destination: string, m04: NonNullable<PrivateM07ArchiveV1["m04"]>, store?: KnowledgeStore): Promise<PrivateM07ArchiveV1> {
	const loaded = await loadPrivateM07Archive(destination);
	const archive = loaded.archive;
	if (!["not-run", "completed", "failed"].includes(m04.state) ||
		(m04.runId !== undefined && (typeof m04.runId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(m04.runId))) ||
		(m04.adoptedExperienceRefs !== undefined && (!Array.isArray(m04.adoptedExperienceRefs) || m04.adoptedExperienceRefs.length > 24 ||
			m04.adoptedExperienceRefs.some(ref => typeof ref.storeId !== "string" || typeof ref.recordId !== "string" || !/^[CKEJQDX]\d{3,}$/.test(ref.recordId) || !Number.isSafeInteger(ref.version) || ref.version < 1))))
		throw new Error("invalid bounded M04 archive outcome");
	const exported = await exportM04Knowledge(destination, m04, store);
	// A repeated outcome must not leave a formerly complete payload under the fixed
	// transport filename when the new provenance check is incomplete.
	if (exported.status.state !== "complete") {
		const target = path.join(destination, M04_KNOWLEDGE_EXPORT_NAME);
		let present = false;
		try { await lstat(target); present = true; }
		catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
		if (present) {
			const temporary = `${target}.${process.pid}.tmp`;
			await writeFile(temporary, `${JSON.stringify({ version: 1, kind: "m04-knowledge-export-status",
				state: exported.status.state, reason: exported.status.reason ?? "no published M04 knowledge selected" }, null, 2)}\n`, { mode: 0o600 });
			await rename(temporary, target);
		}
	}
	archive.m04 = { state: m04.state, ...(m04.runId ? { runId: m04.runId } : {}),
		...(m04.proposalSubmitted !== undefined ? { proposalSubmitted: m04.proposalSubmitted } : {}),
		...(m04.snapshotCreated !== undefined ? { snapshotCreated: m04.snapshotCreated } : {}),
		adoptedExperienceRefs: exported.refs, knowledgeExport: exported.status };
	archive.knowledgeReuse = { trustedAdoption: false, adoptionPath: "M04", nextUse: "explicit-candidate-context-only" };
	const target = path.join(destination, ARCHIVE_NAME), temporary = `${target}.${process.pid}.tmp`;
	await writeFile(temporary, `${JSON.stringify(archive, null, 2)}\n`, { mode: 0o600 });
	await rename(temporary, target);
	return archive;
}

/** Prior archives are data, never implicit trusted knowledge or execution authority. */
export async function loadPrivateM07Archive(directory: string): Promise<{ archive: PrivateM07ArchiveV1; candidate?: string; verification?: string; lesson?: string;
	roundFiles: Array<{ index: number; candidate?: string; verification?: string }>; m04Knowledge?: string }> {
	const root = await realpath(directory);
	const manifest = await privateFile(root, ARCHIVE_NAME, 32_000);
	if (!manifest) throw new Error("private M07 archive manifest is missing");
	const archive = JSON.parse(await readFile(manifest.source, "utf8")) as PrivateM07ArchiveV1;
	if (archive.version !== 1 || archive.kind !== "m07-private-candidate-archive" ||
		archive.knowledgeReuse?.trustedAdoption !== false || archive.knowledgeReuse?.adoptionPath !== "M04" ||
		!/^T\d{3,}$/.test(archive.taskId) || typeof archive.goalRunId !== "string" || !archive.goalRunId)
		throw new Error("private M07 archive identity or pending-adoption state is invalid");
	const result: { archive: PrivateM07ArchiveV1; candidate?: string; verification?: string; lesson?: string;
		roundFiles: Array<{ index: number; candidate?: string; verification?: string }>; m04Knowledge?: string } = { archive, roundFiles: [] };
	for (const item of FILES) {
		if (archive.files.find(file => file.name === item.name)?.status !== "present") continue;
		const source = await privateFile(root, item.name, item.maxBytes);
		if (!source) throw new Error(`archived file is missing: ${item.name}`);
		if (item.name === "candidate.cpp") result.candidate = source.source;
		if (item.name === "verification.json") result.verification = source.source;
		if (item.name === "lesson-delta.json") result.lesson = source.source;
	}
	if (!Array.isArray(archive.controllerEvidence?.rounds) || archive.controllerEvidence.rounds.length > MAX_ROUNDS)
		throw new Error("private M07 archive round manifest is invalid");
	const seen = new Set<number>();
	for (const round of archive.controllerEvidence.rounds) {
		if (!Number.isSafeInteger(round.index) || round.index < 1 || round.index > MAX_ROUNDS || seen.has(round.index))
			throw new Error("private M07 archive round identity is invalid");
		seen.add(round.index);
		const found: { index: number; candidate?: string; verification?: string } = { index: round.index };
		for (const kind of ["candidate", "verification"] as const) {
			const file = round[kind];
			if (!file || !["present", "missing", "invalid"].includes(file.status)) throw new Error("private M07 archive round file status is invalid");
			if (file.status !== "present") continue;
			const expected = `round-${round.index}-${kind === "candidate" ? "candidate.cpp" : "verification.json"}`;
			if (file.file !== expected) throw new Error("private M07 archive round file identity is invalid");
			const source = await privateFile(root, expected, kind === "candidate" ? 128_000 : 256_000);
			if (!source || source.bytes !== file.bytes) throw new Error("private M07 archive round file is missing or changed");
			found[kind] = source.source;
		}
		result.roundFiles.push(found);
	}
	if (archive.m04?.knowledgeExport?.state === "complete") {
		if (archive.m04.knowledgeExport.file !== M04_KNOWLEDGE_EXPORT_NAME) throw new Error("private M04 knowledge export file identity is invalid");
		const source = await privateFile(root, M04_KNOWLEDGE_EXPORT_NAME, MAX_KNOWLEDGE_BYTES);
		if (!source) throw new Error("private M04 knowledge export is missing");
		const document = JSON.parse(await readFile(source.source, "utf8")) as PrivateM04KnowledgeExportV1;
		if (document.version !== 1 || document.kind !== "m04-published-knowledge-export" ||
			document.m04RunId !== archive.m04.runId || !Array.isArray(document.adoptedExperienceRefs) ||
			!document.adoptedExperienceRefs.every(isKnowledgeRef) || !Array.isArray(document.records) ||
			document.records.length !== archive.m04.knowledgeExport.recordCount || !exportSafe(document))
			throw new Error("private M04 knowledge export is invalid");
		result.m04Knowledge = source.source;
	}
	return result;
}
