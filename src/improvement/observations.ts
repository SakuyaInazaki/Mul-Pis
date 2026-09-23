import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import type { Workspace } from "../workspace.ts";
import { nowIso, writeFileAtomic } from "../workspace.ts";
import { projectInline, type BudgetPolicy } from "./policy.ts";

/** A projection call, not a stage-wide estimate or a claim about scientific use. */
export interface ProjectionMaterialV1 {
	ordinal: number;
	role: "task-input" | "task-report" | "artifact" | "check-evidence" | "independent-check";
	mediaType: "text" | "binary";
	/** Workspace-relative source, kept only in the private run record. */
	sourcePath: string;
	/** Original caller input, when sourcePath is a task-local copy. */
	originPath?: string;
	/** M07-run-relative controller-owned copy of the bytes measured at projection time. */
	snapshotPath?: string;
	availability: "available" | "missing" | "unreadable" | "changed";
	snapshotStatus: "captured" | "budget-exceeded" | "unavailable";
	captureReason?: "per-material" | "per-call" | "per-run";
	/** Reads after this projection, especially execute/bash, may use a changed work copy. */
	laterReadVersion: "unknown";
	utf8Bytes?: number;
	utf16CodeUnits?: number;
	snapshotMtimeMs?: number;
	aggregateBefore?: number;
	aggregateAfter?: number;
	decision: "inline" | "deferred" | "binary" | "unavailable";
	reason?: "single-file-limit" | "aggregate-limit" | "overflow-mode" | "unavailable";
}

export interface ProjectionEventV1 {
	version: 1;
	eventId: string;
	createdAt: string;
	callOrdinal: number;
	purpose: "task-message" | "feedback";
	m07RunId: string;
	taskId?: string;
	policyVersionId: string;
	policy: BudgetPolicy;
	methodBinding?: { versionId: string; contentId?: string };
	/** File-level provider tokens are not available at projection time. */
	tokenMeasurement: { unit: "provider-token"; status: "unavailable" };
	providerUsageSessionId?: string;
	captureBudget: { perMaterialBytes: number; perCallBytes: number; perRunBytes: number; usedRunBytesAtStart: number; usedCallBytes: number };
	projectionStatus: "materialized" | "budget-failed" | "unavailable";
	/** Submitted is the runner prompt boundary; assembled means M04 prepared its prompt. */
	deliveryStatus: "not-submitted" | "submitted" | "assembled-for-m04";
	assembledBy?: { stage: "M04"; runId: string };
	outputPath?: string;
	materials: ProjectionMaterialV1[];
}

export interface ProjectionSnapshotLimits { perMaterialBytes: number; perCallBytes: number; perRunBytes: number }
export const DEFAULT_PROJECTION_SNAPSHOT_LIMITS: Readonly<ProjectionSnapshotLimits> = Object.freeze({ perMaterialBytes: 8 * 1024 * 1024, perCallBytes: 16 * 1024 * 1024, perRunBytes: 64 * 1024 * 1024 });

/** Count existing controller copies so repeated calls cannot reset the run budget. */
export async function capturedRunBytes(ws: Workspace, runId: string): Promise<number> {
	const root = path.join(ws.runDir("M07", runId), "projection-materials");
	let total = 0;
	const walk = async (dir: string): Promise<void> => {
		const entries = await readdir(dir, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
			if (error.code === "ENOENT") return [];
			throw error;
		});
		for (const entry of entries) {
			const file = path.join(dir, entry.name);
			if (entry.isDirectory()) await walk(file);
			else if (entry.isFile()) total += (await lstat(file)).size;
		}
	};
	await walk(root);
	return total;
}

function eventDir(ws: Workspace, runId: string): string {
	return path.join(ws.runDir("M07", runId), "projection-events");
}

export async function nextProjectionOrdinal(ws: Workspace, runId: string): Promise<number> {
	const names = await readdir(eventDir(ws, runId)).catch((error: NodeJS.ErrnoException) => {
		if (error.code === "ENOENT") return [];
		throw error;
	});
	return Math.max(0, ...names.map((name) => Number(/^([0-9]+)-/.exec(name)?.[1] ?? 0))) + 1;
}

export function newProjectionEvent(input: Omit<ProjectionEventV1, "version" | "eventId" | "createdAt">): ProjectionEventV1 {
	return { version: 1, eventId: randomUUID(), createdAt: nowIso(), ...input };
}

export async function writeProjectionEvent(ws: Workspace, event: ProjectionEventV1): Promise<void> {
	const dir = eventDir(ws, event.m07RunId);
	await mkdir(dir, { recursive: true });
	const name = `${String(event.callOrdinal).padStart(4, "0")}-${event.purpose}-${event.eventId}.json`;
	await writeFileAtomic(path.join(dir, name), `${JSON.stringify(event, null, 2)}\n`);
}

/** Rechecks private snapshots: a missing or visibly changed copy cannot be replayed. */
export async function readProjectionEvents(ws: Workspace, runId: string): Promise<ProjectionEventV1[]> {
	const dir = eventDir(ws, runId);
	const names = await readdir(dir).catch((error: NodeJS.ErrnoException) => {
		if (error.code === "ENOENT") return [];
		throw error;
	});
	const events: ProjectionEventV1[] = [];
	const runRoot = await realpath(ws.runDir("M07", runId));
	for (const name of names.filter((item) => item.endsWith(".json")).sort()) {
		const event = JSON.parse(await readFile(path.join(dir, name), "utf8")) as ProjectionEventV1;
		if (event.version !== 1 || event.m07RunId !== runId) throw new Error(`Invalid M07 projection event ${name}`);
		for (const material of event.materials) {
			if (material.availability !== "available" || material.snapshotStatus !== "captured" || !material.snapshotPath) continue;
			const absolute = path.resolve(ws.runDir("M07", runId), material.snapshotPath);
			const relative = path.relative(ws.runDir("M07", runId), absolute);
			if (relative.startsWith("..") || path.isAbsolute(relative)) { material.availability = "unreadable"; continue; }
			try {
				const info = await lstat(absolute);
				const resolved = await realpath(absolute);
				const within = path.relative(runRoot, resolved);
				if (within.startsWith("..") || path.isAbsolute(within)) { material.availability = "unreadable"; continue; }
				if (!info.isFile() || info.size !== material.utf8Bytes || (material.snapshotMtimeMs !== undefined && info.mtimeMs !== material.snapshotMtimeMs)) { material.availability = "changed"; continue; }
				const file = await open(resolved, "r");
				await file.close();
			} catch (error) {
				material.availability = (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unreadable";
			}
		}
		events.push(event);
	}
	return events;
}

/** Called only when M04 assembled the feedback-bearing prompt. */
export async function markFeedbackAssembled(ws: Workspace, m07RunId: string, feedbackPath: string, m04RunId: string): Promise<void> {
	const dir = eventDir(ws, m07RunId);
	const relativeFeedback = path.relative(ws.runDir("M07", m07RunId), feedbackPath);
	const names = (await readdir(dir).catch((error: NodeJS.ErrnoException) => {
		if (error.code === "ENOENT") return [];
		throw error;
	})).filter((name) => name.endsWith(".json")).sort().reverse();
	for (const name of names) {
		const event = JSON.parse(await readFile(path.join(dir, name), "utf8")) as ProjectionEventV1;
		if (event.purpose !== "feedback" || event.projectionStatus !== "materialized" || event.outputPath !== relativeFeedback) continue;
		event.deliveryStatus = "assembled-for-m04";
		event.assembledBy = { stage: "M04", runId: m04RunId };
		await writeProjectionEvent(ws, event);
		return;
	}
	// Legacy feedback may have no projection event. It remains unusable for replay.
}

export function replayability(event: ProjectionEventV1): { replayable: boolean; reason?: string } {
	if (event.projectionStatus !== "materialized") return { replayable: false, reason: `projection-${event.projectionStatus}` };
	let aggregate = 0;
	for (const [index, material] of event.materials.entries()) {
		if (material.ordinal !== index) return { replayable: false, reason: "material-order" };
		if (material.availability !== "available" || material.snapshotStatus !== "captured" || !material.snapshotPath) return { replayable: false, reason: `material-${material.snapshotStatus}-${material.availability}` };
		if (!Number.isSafeInteger(material.utf8Bytes) || material.utf8Bytes! < 0) return { replayable: false, reason: "bytes-unavailable" };
		if (material.mediaType === "binary") continue;
		if (!Number.isSafeInteger(material.utf16CodeUnits) || material.utf16CodeUnits! < 0) return { replayable: false, reason: "utf16-unavailable" };
		const expected = projectInline(event.policy, material.utf16CodeUnits!, aggregate);
		if (material.aggregateBefore !== aggregate || material.aggregateAfter !== expected.nextAggregateChars || material.decision !== (expected.inline ? "inline" : "deferred") || material.reason !== expected.reason) return { replayable: false, reason: "projection-mismatch" };
		aggregate = expected.nextAggregateChars;
	}
	return { replayable: true };
}
