import { HarnessError } from "../types.ts";
import { CARRY_LOGICAL_BYTES } from "./carry-sidecar-codec.ts";

function fail(reason: string): never { throw new HarnessError("campaign.historical-archive-integrity", reason); }

type HistoricalArchiveVersion = { interpretation?: string; files: Record<string, string> };
const HISTORICAL_ARCHIVE_ENTRY_KEYS = new Set([
	"originalContractId", "goalRunId", "taskId", "interpretation", "files", "supersededVersions",
]);

function assertHistoricalArchiveRevisionShape(entry: Record<string, any>): void {
	if (!entry || typeof entry !== "object" || Array.isArray(entry) ||
		Object.keys(entry).some(key => !HISTORICAL_ARCHIVE_ENTRY_KEYS.has(key)))
		throw new HarnessError("campaign.historical-archive-integrity",
			"same-task historical archive has unsupported outer metadata");
}

function historicalArchiveFiles(value: unknown): Record<string, string> {
	if (!value || typeof value !== "object" || Array.isArray(value))
		fail("same-task historical archive has no files");
	const files = value as Record<string, unknown>;
	for (const [name, content] of Object.entries(files))
		if (!name || name.includes("/") || name.includes("\\") || typeof content !== "string")
			fail("same-task historical archive file is invalid");
	return files as Record<string, string>;
}

function historicalArchiveVersions(entry: Record<string, any>): HistoricalArchiveVersion[] {
	if (entry.supersededVersions === undefined) return [];
	if (!Array.isArray(entry.supersededVersions)) fail("same-task historical versions are invalid");
	return entry.supersededVersions.map((version: unknown) => {
		if (!version || typeof version !== "object" || Array.isArray(version) ||
			!(["files", "files,interpretation"].includes(Object.keys(version).sort().join(","))) ||
			(Object.hasOwn(version, "interpretation") &&
				typeof (version as Record<string, unknown>).interpretation !== "string"))
			fail("same-task historical version is invalid");
		return { ...(Object.hasOwn(version, "interpretation") ?
			{ interpretation: (version as HistoricalArchiveVersion).interpretation } : {}),
			files: historicalArchiveFiles((version as HistoricalArchiveVersion).files) };
	});
}

function historicalArchiveSnapshot(entry: Record<string, any>): HistoricalArchiveVersion {
	if (Object.hasOwn(entry, "interpretation") && typeof entry.interpretation !== "string")
		fail("same-task historical interpretation is invalid");
	return { ...(Object.hasOwn(entry, "interpretation") ? { interpretation: entry.interpretation } : {}),
		files: historicalArchiveFiles(entry.files) };
}

function sameHistoricalSnapshot(a: HistoricalArchiveVersion, b: HistoricalArchiveVersion): boolean {
	const aNames = Object.keys(a.files).sort(), bNames = Object.keys(b.files).sort();
	return a.interpretation === b.interpretation && aNames.length === bNames.length &&
		aNames.every((name, index) => name === bNames[index] && a.files[name] === b.files[name]);
}

function historicalArchiveFacts(entry: Record<string, any>, version: HistoricalArchiveVersion) {
	let archive: Record<string, any>;
	try { archive = JSON.parse(version.files["workflow-archive.json"]); }
	catch { return fail("same-task historical archive manifest is invalid"); }
	if (archive?.version !== 1 || archive.kind !== "m07-private-candidate-archive" ||
		archive.goalRunId !== entry.goalRunId || archive.taskId !== entry.taskId)
		fail("same-task historical archive identity differs from its entry");
	const m04 = archive.m04 ?? { state: "not-run" };
	const stateRank = { "not-run": 0, failed: 1, completed: 2 }[m04.state as "not-run" | "failed" | "completed"];
	if (stateRank === undefined || (m04.proposalSubmitted !== undefined && typeof m04.proposalSubmitted !== "boolean") ||
		(m04.snapshotCreated !== undefined && typeof m04.snapshotCreated !== "boolean"))
		fail("same-task historical M04 state is invalid");
	if (version.files["m04-transaction.json"] &&
		(!m04.transaction || m04.transaction.state === undefined ||
			typeof m04.transaction.file !== "string" ||
			!m04.transaction.file.endsWith("m04-transaction.json")))
		fail("same-task historical M04 transaction is undeclared");
	return { stateRank, proposal: Number(m04.proposalSubmitted === true), snapshot: Number(m04.snapshotCreated === true),
		runId: typeof m04.runId === "string" ? m04.runId : undefined,
		exportComplete: m04.knowledgeExport?.state === "complete",
		transactionPresent: typeof version.files["m04-transaction.json"] === "string" };
}

function checkHistoricalArchiveProgression(entry: Record<string, any>, earlier: HistoricalArchiveVersion,
	later: HistoricalArchiveVersion): void {
	for (const name of ["candidate.cpp", "verification.json", "experiment-plan.json"])
		if (earlier.files[name] !== later.files[name]) fail(`same-task historical archives disagree on ${name}`);
	if (earlier.files["m04-transaction.json"] && later.files["m04-transaction.json"] &&
		earlier.files["m04-transaction.json"] !== later.files["m04-transaction.json"])
		fail("same-task historical M04 transaction bytes conflict");
	const old = historicalArchiveFacts(entry, earlier), next = historicalArchiveFacts(entry, later);
	if (next.stateRank < old.stateRank || next.proposal < old.proposal || next.snapshot < old.snapshot)
		fail("same-task historical M04 version rollback or outcomes conflict");
	if (next.stateRank === old.stateRank && next.proposal === old.proposal && next.snapshot === old.snapshot &&
		old.runId && next.runId && old.runId !== next.runId)
		fail("same-task historical M04 run identity conflicts");
	if (old.transactionPresent && !next.transactionPresent)
		fail("same-task historical M04 transaction evidence was dropped");
}

function validateHistoricalArchiveVersions(entry: Record<string, any>): HistoricalArchiveVersion[] {
	const versions = historicalArchiveVersions(entry);
	const files = historicalArchiveFiles(entry.files);
	if (Buffer.byteLength(JSON.stringify(entry), "utf8") > CARRY_LOGICAL_BYTES)
		fail("same-task historical entry exceeds the physical carry bound");
	if (!versions.length) return versions;
	const timeline = [...versions, historicalArchiveSnapshot(entry)];
	for (let index = 1; index < timeline.length; index++) {
		if (timeline.slice(0, index).some(prior => sameHistoricalSnapshot(prior, timeline[index]!)))
			fail("same-task historical version is repeated");
		checkHistoricalArchiveProgression(entry, timeline[index - 1]!, timeline[index]!);
	}
	return versions;
}

/** Reinsert an authenticated earlier entry without changing the current evidence authority.
 * Authentication and matching against the sealed predecessor are caller obligations. */
export function restoreHistoricalArchivePredecessor(current: Record<string, any>, predecessor: Record<string, any>): Record<string, any> {
	assertHistoricalArchiveRevisionShape(current);
	assertHistoricalArchiveRevisionShape(predecessor);
	const currentVersions = validateHistoricalArchiveVersions(current);
	const predecessorVersions = validateHistoricalArchiveVersions(predecessor);
	if (current.goalRunId !== predecessor.goalRunId || current.taskId !== predecessor.taskId ||
		current.originalContractId !== predecessor.originalContractId ||
		typeof current.originalContractId !== "string" || typeof current.goalRunId !== "string" ||
		!/^T\d{3,}$/.test(String(current.taskId)))
		fail("same-task historical archives disagree on original contract or identity");
	// Older histories also contain intentionally partial, unselected attempts.
	// An identical authenticated entry needs no scientific tuple or M04 comparison;
	// retain it exactly. A changed same-task state still needs those proofs below.
	if (JSON.stringify(current) === JSON.stringify(predecessor)) return current;
	const currentTimeline = [...currentVersions, historicalArchiveSnapshot(current)];
	const predecessorTimeline = [...predecessorVersions, historicalArchiveSnapshot(predecessor)];
	historicalArchiveFacts(current, currentTimeline.at(-1)!);
	historicalArchiveFacts(predecessor, predecessorTimeline.at(-1)!);
	for (const name of ["candidate.cpp", "verification.json", "experiment-plan.json"])
		if (typeof currentTimeline.at(-1)!.files[name] !== "string" ||
			typeof predecessorTimeline.at(-1)!.files[name] !== "string")
			fail(`same-task historical archives lack ${name}`);
	let overlap = 0;
	for (let length = Math.min(currentTimeline.length, predecessorTimeline.length); length > 0; length--)
		if (predecessorTimeline.slice(-length).every((version, index) =>
			sameHistoricalSnapshot(version, currentTimeline[index]!))) { overlap = length; break; }
	const merged = [...predecessorTimeline, ...currentTimeline.slice(overlap)];
	if (!overlap && merged.some((version, index) => merged.slice(0, index).some(prior =>
		sameHistoricalSnapshot(prior, version)))) fail("same-task historical version order conflicts");
	for (let index = 1; index < merged.length; index++)
		checkHistoricalArchiveProgression(current, merged[index - 1]!, merged[index]!);
	const result = { ...current, supersededVersions: merged.slice(0, -1) };
	validateHistoricalArchiveVersions(result);
	return result;
}

/** One goal/task has one current state, with exact older revisions kept as untrusted data. */
export function retainHistoricalArchiveEntry(entries: Array<Record<string, any>>, incoming: Record<string, any>): void {
	const incomingVersions = validateHistoricalArchiveVersions(incoming);
	const index = entries.findIndex(entry => entry.goalRunId === incoming.goalRunId && entry.taskId === incoming.taskId);
	if (index < 0) { entries.push(incoming); return; }
	const existing = entries[index];
	const oldVersions = validateHistoricalArchiveVersions(existing);
	if (existing.originalContractId !== incoming.originalContractId)
		fail("same-task historical archives disagree on original contract");
	const oldCurrent = historicalArchiveSnapshot(existing), newCurrent = historicalArchiveSnapshot(incoming);
	for (const name of ["candidate.cpp", "verification.json", "experiment-plan.json"])
		if (oldCurrent.files[name] !== newCurrent.files[name]) fail(`same-task historical archives disagree on ${name}`);
	if (oldCurrent.files["m04-transaction.json"] && newCurrent.files["m04-transaction.json"] &&
		oldCurrent.files["m04-transaction.json"] !== newCurrent.files["m04-transaction.json"])
		fail("same-task historical M04 transaction bytes conflict");
	const old = historicalArchiveFacts(existing, oldCurrent), next = historicalArchiveFacts(incoming, newCurrent);
	const dominates = (a: typeof old, b: typeof old) => a.stateRank >= b.stateRank &&
		a.proposal >= b.proposal && a.snapshot >= b.snapshot;
	if (!dominates(old, next) && !dominates(next, old)) fail("same-task historical M04 outcomes conflict");
	const oldStrict = old.stateRank > next.stateRank || old.proposal > next.proposal || old.snapshot > next.snapshot;
	const nextStrict = next.stateRank > old.stateRank || next.proposal > old.proposal || next.snapshot > old.snapshot;
	if (!oldStrict && !nextStrict && old.runId && next.runId && old.runId !== next.runId)
		fail("same-task historical M04 run identity conflicts");
	if (nextStrict && old.transactionPresent && !next.transactionPresent)
		fail("same-task historical M04 transaction evidence was dropped");
	const replace = nextStrict || (!oldStrict && !nextStrict && ((!old.runId && next.runId) ||
		(!old.exportComplete && next.exportComplete) ||
		(!old.transactionPresent && next.transactionPresent)));
	if (!replace) {
		if (incomingVersions.length) {
			const oldTimeline = [...oldVersions, oldCurrent], newTimeline = [...incomingVersions, newCurrent];
			if (newTimeline.length > oldTimeline.length || !newTimeline.every((version, index) =>
				sameHistoricalSnapshot(version, oldTimeline[index]!)))
				fail("same-task historical version rollback or divergence");
		}
		return;
	}
	assertHistoricalArchiveRevisionShape(existing);
	assertHistoricalArchiveRevisionShape(incoming);
	const oldTimeline = [...oldVersions, oldCurrent];
	if (incomingVersions.length && (incomingVersions.length !== oldTimeline.length ||
		!incomingVersions.every((version, index) => sameHistoricalSnapshot(version, oldTimeline[index]!))))
		fail("same-task historical version rollback or divergence");
	const replacement = { ...incoming, supersededVersions: [...oldTimeline] };
	validateHistoricalArchiveVersions(replacement);
	entries[index] = replacement;
}

/** Reconcile plaintext entries only after the caller has authenticated both carry sources. */
export function reconcileHistoricalResearchEntries(currentEntries: unknown[], olderEntries: unknown[]):
	Array<Record<string, any>> {
	const entries = currentEntries.map(entry => structuredClone(entry)) as Array<Record<string, any>>;
	const identities = new Set<string>();
	for (const entry of entries) {
		if (!entry || typeof entry !== "object" || typeof entry.goalRunId !== "string" ||
			typeof entry.taskId !== "string") fail("authenticated current history entry identity is invalid");
		const identity = JSON.stringify([entry.goalRunId, entry.taskId]);
		if (identities.has(identity)) fail("authenticated current history entry identity is repeated");
		identities.add(identity);
	}
	const oldIdentities = new Set<string>();
	for (const oldEntry of olderEntries) {
		if (!oldEntry || typeof oldEntry !== "object")
			fail("authenticated predecessor history entry identity is invalid");
		const oldRow = oldEntry as Record<string, any>;
		if (typeof oldRow.goalRunId !== "string" || typeof oldRow.taskId !== "string")
			fail("authenticated predecessor history entry identity is invalid");
		const identity = JSON.stringify([oldRow.goalRunId, oldRow.taskId]);
		if (oldIdentities.has(identity)) fail("authenticated predecessor history entry identity is repeated");
		oldIdentities.add(identity);
		const index = entries.findIndex(entry =>
			entry.goalRunId === oldRow.goalRunId && entry.taskId === oldRow.taskId);
		if (index < 0) entries.push(structuredClone(oldRow));
		else entries[index] = restoreHistoricalArchivePredecessor(entries[index]!, oldRow);
	}
	return entries;
}
