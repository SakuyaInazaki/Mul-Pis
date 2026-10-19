/**
 * Replay an identical evaluation instead of paying for it again.
 *
 * Nearly all of the wall clock in this workflow is the evaluator, not the
 * model: import and compilation dominate, correctness is next, and the timing
 * loop itself is the smallest part. Re-running a candidate the host has already
 * evaluated, byte for byte, under the same contract and protocol, buys nothing.
 *
 * The key is the whole reason this is safe. It covers the normalized source,
 * the backend and its version, the protocol, the subject, the stage, the
 * contract digest and the case set, so a replayed receipt cannot describe a
 * different contract, case table or stage. A replayed stage is
 * marked as such: it is evidence that this code was evaluated, never a second
 * independent measurement to average in.
 */
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, copyFile, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { CandidateExecutionCheck } from "./candidate-runner.ts";

export interface EvaluationCacheKeyParts {
	backendId: string;
	backendVersion: string;
	protocolId: string;
	subjectId: string;
	stageId: string;
	/** Digest of the candidate after the contract's own AST normalization. */
	sourceDigest: string;
	contractDigest: string;
	caseSetId: string;
}

export interface EvaluationCacheEntryV1 {
	version: 1;
	kind: "local-operator-cache-entry";
	key: string;
	parts: EvaluationCacheKeyParts;
	status: "passed" | "failed";
	summary: string;
	performedChecks?: CandidateExecutionCheck[];
	/** Receipt file names stored beside this entry, in their original order. */
	receiptNames: string[];
	evaluationReceiptNames: string[];
	capturedAt: string;
	sourceRunId: string;
}

export interface EvaluationCacheStatsV1 {
	version: 1;
	kind: "local-operator-cache-stats";
	hits: number;
	misses: number;
	storedEntries: number;
	/** Wall clock the host spent on executed stages, by stage id. */
	executedMsByStage: Record<string, number>;
	/** Wall clock a replay stood in for, by stage id. */
	replacedMsByStage: Record<string, number>;
}

const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** A receipt path relative to the stage output directory. Nested worker logs
 * belong to the same stage result, so they are kept, but only as plain
 * relative segments: no absolute path, no traversal, no symlinked name. */
function storable(name: string): boolean {
	const parts = name.split("/");
	return parts.length <= 8 && parts.every(part => SEGMENT.test(part)) && !path.isAbsolute(name);
}

export function evaluationCacheKey(parts: EvaluationCacheKeyParts): string {
	return createHash("sha256").update(JSON.stringify([
		parts.backendId, parts.backendVersion, parts.protocolId, parts.subjectId, parts.stageId,
		parts.sourceDigest, parts.contractDigest, parts.caseSetId,
	])).digest("hex");
}

/** A content-addressed directory of past stage results. Everything it stores is
 * host-written; nothing a candidate produced reaches it except frozen receipt
 * bytes that were already retained in the journal. */
export class EvaluationCache {
	readonly #root: string;
	#stats: EvaluationCacheStatsV1 = { version: 1, kind: "local-operator-cache-stats", hits: 0, misses: 0,
		storedEntries: 0, executedMsByStage: {}, replacedMsByStage: {} };

	constructor(root: string) {
		if (!path.isAbsolute(root)) throw new Error("evaluation cache directory must be absolute");
		this.#root = root;
	}

	get stats(): EvaluationCacheStatsV1 {
		return { ...this.#stats, executedMsByStage: { ...this.#stats.executedMsByStage },
			replacedMsByStage: { ...this.#stats.replacedMsByStage } };
	}

	recordExecution(stageId: string, elapsedMs: number): void {
		this.#stats.executedMsByStage[stageId] = (this.#stats.executedMsByStage[stageId] ?? 0) + elapsedMs;
	}

	async read(key: string): Promise<EvaluationCacheEntryV1 | undefined> {
		const file = path.join(this.#root, key, "entry.json");
		let parsed: EvaluationCacheEntryV1;
		try { parsed = JSON.parse(await readFile(file, "utf8")) as EvaluationCacheEntryV1; }
		catch { this.#stats.misses++; return undefined; }
		if (parsed?.kind !== "local-operator-cache-entry" || parsed.version !== 1 || parsed.key !== key ||
			!Array.isArray(parsed.receiptNames) || parsed.receiptNames.some(name => !storable(name)) ||
			!Array.isArray(parsed.evaluationReceiptNames) ||
			parsed.evaluationReceiptNames.some(name => !parsed.receiptNames.includes(name))) {
			this.#stats.misses++;
			return undefined;
		}
		for (const name of parsed.receiptNames)
			if (!await access(path.join(this.#root, key, name), constants.R_OK).then(() => true, () => false)) {
				this.#stats.misses++;
				return undefined;
			}
		this.#stats.hits++;
		this.#stats.replacedMsByStage[parsed.parts.stageId] =
			(this.#stats.replacedMsByStage[parsed.parts.stageId] ?? 0) + (this.#stats.executedMsByStage[parsed.parts.stageId] ?? 0);
		return parsed;
	}

	/** Copy a replayed entry's receipts into this run's output directory, so the
	 * journal freezes its own bytes exactly as it would for an executed stage. */
	async restore(entry: EvaluationCacheEntryV1, outputDir: string): Promise<string[]> {
		await mkdir(outputDir, { recursive: true });
		const restored: string[] = [];
		for (const name of entry.receiptNames) {
			const target = path.join(outputDir, name);
			await mkdir(path.dirname(target), { recursive: true });
			await copyFile(path.join(this.#root, entry.key, name), target);
			restored.push(target);
		}
		return restored;
	}

	/** Store one stage's receipts. A partially written entry is never published:
	 * the directory is renamed into place only once every file is in it. */
	async store(key: string, parts: EvaluationCacheKeyParts, input: {
		status: "passed" | "failed"; summary: string; performedChecks?: readonly CandidateExecutionCheck[];
		receipts: Array<{ name: string; file: string }>; evaluationNames: string[]; runId: string;
	}): Promise<EvaluationCacheEntryV1 | undefined> {
		if (input.receipts.some(item => !storable(item.name))) return undefined;
		if (new Set(input.receipts.map(item => item.name)).size !== input.receipts.length) return undefined;
		const final = path.join(this.#root, key);
		if (await access(final, constants.R_OK).then(() => true, () => false)) return undefined;
		const staging = path.join(this.#root, `.staging-${key}-${process.pid}`);
		await mkdir(staging, { recursive: true });
		try {
			for (const item of input.receipts) {
				const target = path.join(staging, item.name);
				await mkdir(path.dirname(target), { recursive: true });
				await copyFile(item.file, target);
			}
			const entry: EvaluationCacheEntryV1 = { version: 1, kind: "local-operator-cache-entry", key, parts,
				status: input.status, summary: input.summary,
				...(input.performedChecks ? { performedChecks: [...input.performedChecks] } : {}),
				receiptNames: input.receipts.map(item => item.name), evaluationReceiptNames: [...input.evaluationNames],
				capturedAt: new Date().toISOString(), sourceRunId: input.runId };
			await writeFile(path.join(staging, "entry.json"), `${JSON.stringify(entry, null, 2)}\n`, { flag: "wx" });
			await rename(staging, final);
			this.#stats.storedEntries++;
			return entry;
		} catch {
			await rm(staging, { recursive: true, force: true });
			return undefined;
		}
	}

	/** Entry count on disk, for a report that has to answer "how much was saved". */
	async size(): Promise<number> {
		try {
			return (await readdir(this.#root, { withFileTypes: true }))
				.filter(entry => entry.isDirectory() && !entry.name.startsWith(".")).length;
		} catch { return 0; }
	}
}
