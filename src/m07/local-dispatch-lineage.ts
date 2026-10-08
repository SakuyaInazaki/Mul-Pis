/** Immutable two-sided local dispatch edge. Either missing side is unproven. */
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, readFile } from "node:fs/promises";
import path from "node:path";
import type { LocalMissionAttempt } from "../runner/local-mission-host.ts";
import type { ObjectiveNextTaskV1 } from "./objective-progress.ts";
import type { ProcessIdentityV1 } from "../runtime/process-identity.ts";

export interface LocalDispatchLineageV1 {
	version: 1; kind: "local-mission-m07-dispatch-lineage";
	missionId: string; intentId: string; oldAttempt: LocalMissionAttempt;
	intentCheckpoint: { sequence: number; sha256: string };
	m07RunId: string; taskId: string; assessorTaskSha256: string;
	m07TaskInputsSha256: string; m07TaskChecksSha256: string;
	m07Owner: ProcessIdentityV1;
}
export const localLineageHash = (value: Buffer | string): string =>
	createHash("sha256").update(value).digest("hex");
export const localLineageBytes = (value: LocalDispatchLineageV1): Buffer =>
	Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
export const assessorTaskHash = (task: ObjectiveNextTaskV1): string =>
	localLineageHash(JSON.stringify(task));
const exact = (value: unknown, keys: string[]): value is Record<string, unknown> =>
	value !== null && typeof value === "object" && !Array.isArray(value) &&
	Object.keys(value).sort().join("|") === keys.sort().join("|");
export const missionLineageFile = (root: string, intentId: string): string =>
	path.join(root, "dispatch-links", `${intentId}.json`);
export const missionLineageCommitFile = (root: string, intentId: string): string =>
	path.join(root, "dispatch-links", `${intentId}.commit.json`);
export const goalLineageFile = (m07Dir: string): string =>
	path.join(m07Dir, "mission-dispatch-link.json");
async function exclusive(file: string, bytes: Buffer): Promise<void> {
	await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
	const handle = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
	try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
	const dir = await open(path.dirname(file), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
	try { await dir.sync(); } finally { await dir.close(); }
}
/** Called at the controller's durable task-allocation seam, before runner creation. */
export async function recordLocalDispatchLineage(input: {
	missionRoot: string; m07Dir: string; lineage: LocalDispatchLineageV1;
}): Promise<void> {
	const bytes = localLineageBytes(input.lineage);
	if (bytes.length > 64 * 1024) throw new Error("local dispatch lineage exceeds control byte bound");
	for (const file of [missionLineageFile(input.missionRoot, input.lineage.intentId),
		goalLineageFile(input.m07Dir)]) {
		try { await exclusive(file, bytes); }
		catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST" ||
				!(await readFile(file)).equals(bytes)) throw error;
		}
	}
	const commitFile = missionLineageCommitFile(input.missionRoot, input.lineage.intentId);
	const commitBytes = Buffer.from(`${JSON.stringify({ version: 1,
		kind: "local-mission-m07-dispatch-commit", intentId: input.lineage.intentId,
		lineageSha256: localLineageHash(bytes) })}\n`, "utf8");
	try { await exclusive(commitFile, commitBytes); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST" ||
			!(await readFile(commitFile)).equals(commitBytes)) throw error;
	}
}
/** A partial pair cannot turn a guessed MISSION→M07 association into authority. */
export async function readLocalDispatchLineage(input: {
	missionRoot: string; m07Dir: string; intentId: string;
}): Promise<{ lineage: LocalDispatchLineageV1; sha256: string }> {
	const files = [missionLineageFile(input.missionRoot, input.intentId),
		goalLineageFile(input.m07Dir), missionLineageCommitFile(input.missionRoot, input.intentId)];
	const chunks = await Promise.all(files.map(async file => {
		const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
		try {
			const before = await handle.stat();
			if (!before.isFile() || before.nlink !== 1 || before.size < 1 || before.size > 64 * 1024)
				throw new Error("local dispatch lineage file is unsafe");
			const bytes = await handle.readFile();
			if (bytes.length !== before.size) throw new Error("local dispatch lineage changed during read");
			return bytes;
		} finally { await handle.close(); }
	}));
	if (!chunks[0].equals(chunks[1])) throw new Error("local dispatch lineage sides differ");
	const lineage = JSON.parse(chunks[0].toString("utf8")) as LocalDispatchLineageV1;
	const commit = JSON.parse(chunks[2].toString("utf8")) as
		{ version?: number; kind?: string; intentId?: string; lineageSha256?: string };
	if (!exact(lineage, ["version", "kind", "missionId", "intentId", "oldAttempt",
		"intentCheckpoint", "m07RunId", "taskId", "assessorTaskSha256",
		"m07TaskInputsSha256", "m07TaskChecksSha256", "m07Owner"]) ||
		!exact(commit, ["version", "kind", "intentId", "lineageSha256"]) ||
		lineage.version !== 1 || lineage.kind !== "local-mission-m07-dispatch-lineage" ||
		lineage.intentId !== input.intentId ||
		!chunks[0].equals(localLineageBytes(lineage)) || commit.version !== 1 ||
		commit.kind !== "local-mission-m07-dispatch-commit" || commit.intentId !== input.intentId ||
		commit.lineageSha256 !== localLineageHash(chunks[0]) ||
		!chunks[2].equals(Buffer.from(`${JSON.stringify(commit)}\n`, "utf8")))
		throw new Error("local dispatch lineage is invalid");
	return { lineage, sha256: localLineageHash(chunks[0]) };
}
