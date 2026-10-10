/**
 * Present an authenticated prior objective checkpoint through individually
 * bounded, read-only evidence files. The index is a locator: reconstructing its
 * parts grants no new authority to the checkpoint or to a model assessment.
 */
import { constants } from "node:fs";
import { lstat, mkdir, open } from "node:fs/promises";
import path from "node:path";
import { HarnessError } from "../types.ts";

const MAX_EVIDENCE_BYTES = 1_000_000;
export const PRIOR_OBJECTIVE_CHECKPOINT_INDEX = "prior-objective-checkpoint-index.json";

export interface PriorObjectiveCheckpointEvidence {
	indexName: string;
	partNames: string[];
	evidence: Array<{ name: string; file: string }>;
}

interface Part {
	name: string;
	startByte: number;
	endByte: number;
	bytes: number;
}

function invalid(message: string): never {
	throw new HarnessError("m07.prior-checkpoint-evidence", message);
}

function prepare(originalBytes: Uint8Array): {
	indexBytes: Buffer;
	parts: Array<Part & { content: Buffer }>;
} {
	const original = Buffer.from(originalBytes);
	let decoded: string;
	try { decoded = new TextDecoder("utf-8", { fatal: true }).decode(original); }
	catch { return invalid("prior objective checkpoint is not UTF-8"); }
	try { JSON.parse(decoded); }
	catch { return invalid("prior objective checkpoint is not JSON"); }
	const parts: Array<Part & { content: Buffer }> = [];
	for (let start = 0; start < original.length;) {
		let end = Math.min(start + MAX_EVIDENCE_BYTES, original.length);
		if (end < original.length) {
			while (end > start && (original[end]! & 0xc0) === 0x80) end--;
		}
		if (end <= start) invalid("prior objective checkpoint has no bounded UTF-8 partition");
		const name = `prior-objective-checkpoint-part-${String(parts.length + 1).padStart(6, "0")}.txt`;
		parts.push({ name, startByte: start, endByte: end,
			bytes: end - start, content: original.subarray(start, end) });
		start = end;
	}
	const index = {
		version: 1,
		kind: "prior-objective-checkpoint-part-index",
		interpretation: "locator-only; this is the authenticated prior checkpoint, not a new model decision",
		encoding: "utf8-concatenate-in-order-without-separators",
		originalName: "objective-checkpoint.json",
		totalBytes: original.length,
		parts: parts.map(({ name, startByte, endByte, bytes }) => ({ name, startByte, endByte, bytes })),
	};
	const indexBytes = Buffer.from(`${JSON.stringify(index, null, 2)}\n`, "utf8");
	if (indexBytes.length > MAX_EVIDENCE_BYTES)
		invalid("prior objective checkpoint index exceeds the evidence file bound");
	return { indexBytes, parts };
}

async function readBoundedRegular(file: string): Promise<Buffer> {
	let handle;
	try {
		handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
		const info = await handle.stat();
		if (!info.isFile() || info.size > MAX_EVIDENCE_BYTES)
			invalid("prior objective checkpoint evidence is not a bounded regular file");
		const bytes = await handle.readFile();
		if (bytes.length > MAX_EVIDENCE_BYTES)
			invalid("prior objective checkpoint evidence exceeds the file bound");
		return bytes;
	} catch {
		return invalid("prior objective checkpoint evidence is missing or invalid");
	} finally {
		await handle?.close();
	}
}

/** Verify both the locator and full byte reconstruction against the supplied
 * authenticated original; sizes or an index alone never authenticate content. */
export async function verifyPriorObjectiveCheckpointEvidence(
	directory: string, originalBytes: Uint8Array,
): Promise<PriorObjectiveCheckpointEvidence> {
	const original = Buffer.from(originalBytes);
	const expected = prepare(original);
	const indexName = PRIOR_OBJECTIVE_CHECKPOINT_INDEX;
	const indexFile = path.join(directory, indexName);
	if (!(await readBoundedRegular(indexFile)).equals(expected.indexBytes))
		invalid("prior objective checkpoint index differs from the original partition");
	const evidence = [{ name: indexName, file: indexFile }];
	const recovered: Buffer[] = [];
	for (const part of expected.parts) {
		const file = path.join(directory, part.name);
		const bytes = await readBoundedRegular(file);
		if (bytes.length !== part.bytes)
			invalid("prior objective checkpoint part size differs from the original partition");
		recovered.push(bytes);
		evidence.push({ name: part.name, file });
	}
	if (!Buffer.concat(recovered).equals(original))
		invalid("prior objective checkpoint parts differ from the authenticated original");
	return { indexName, partNames: expected.parts.map(part => part.name), evidence };
}

async function writeNewRegular(file: string, bytes: Buffer): Promise<void> {
	const handle = await open(file, constants.O_WRONLY | constants.O_CREAT |
		constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
	try { await handle.writeFile(bytes); }
	finally { await handle.close(); }
}

/** Stage a private byte-preserving partition and authenticate it before use.
 * The caller keeps the original checkpoint unchanged in its private output. */
export async function stagePriorObjectiveCheckpointEvidence(
	directory: string, originalBytes: Uint8Array,
): Promise<PriorObjectiveCheckpointEvidence> {
	const original = Buffer.from(originalBytes);
	const prepared = prepare(original);
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const directoryInfo = await lstat(directory);
	if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink())
		invalid("prior objective checkpoint evidence directory is invalid");
	for (const part of prepared.parts)
		await writeNewRegular(path.join(directory, part.name), part.content);
	await writeNewRegular(path.join(directory, PRIOR_OBJECTIVE_CHECKPOINT_INDEX), prepared.indexBytes);
	return verifyPriorObjectiveCheckpointEvidence(directory, original);
}
