/** Lossless physical storage for one objective checkpoint. The manifest provides
 * transport integrity only; it does not validate the checkpoint's scientific claims. */
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { HarnessError } from "../types.ts";

const PLAIN_BYTES = 4 * 1024 * 1024;
const PART_BYTES = 1024 * 1024;
const TRANSPORT_BYTES = 64 * 1024 * 1024;
const MANIFEST_KIND = "objective-checkpoint-multipart";
const ENCODING = "utf8-concatenate-in-order";
const GENERATION = /^[0-9a-f]{32}$/;
const SHA256 = /^[0-9a-f]{64}$/;

interface Part { name: string; bytes: number; sha256: string }
interface Manifest {
	version: 1;
	kind: typeof MANIFEST_KIND;
	encoding: typeof ENCODING;
	generation: string;
	totalBytes: number;
	sha256: string;
	parts: Part[];
}

export interface ObjectiveCheckpointTransport {
	/** The original JSON text, byte-for-byte after UTF-8 encoding. */
	text: string;
	/** Absolute paths: objective-checkpoint.json first, then its current parts. */
	physicalFiles: string[];
}

function invalid(message: string): never {
	throw new HarnessError("m07.objective", message);
}

function sha256(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function object(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
	return Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}

function checkpointJson(text: string): void {
	let value: unknown;
	try { value = JSON.parse(text); }
	catch { return invalid("objective checkpoint is not JSON"); }
	if (!object(value) || value.version !== 1 || value.kind !== "original-objective-progress")
		invalid("objective checkpoint JSON kind is invalid");
}

function utf8(bytes: Buffer): string {
	try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
	catch { return invalid("objective checkpoint is not UTF-8"); }
}

function checkpointPath(file: string): string {
	if (path.basename(file) !== "objective-checkpoint.json")
		invalid("objective checkpoint file name is invalid");
	return path.resolve(file);
}

async function privateDirectory(file: string): Promise<void> {
	const info = await lstat(path.dirname(file));
	if (!info.isDirectory() || info.isSymbolicLink())
		invalid("objective checkpoint directory is not a regular directory");
}

/** Read no more than the physical file bound, through a no-follow file handle. */
async function readBounded(file: string, limit: number): Promise<Buffer> {
	let handle;
	try {
		handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
		const info = await handle.stat();
		if (!info.isFile() || info.size < 1 || info.size > limit || !Number.isSafeInteger(info.size))
			invalid("objective checkpoint physical file is not a bounded regular file");
		const bytes = Buffer.alloc(info.size);
		let offset = 0;
		while (offset < bytes.length) {
			const result = await handle.read(bytes, offset, bytes.length - offset, offset);
			if (result.bytesRead === 0) invalid("objective checkpoint physical file changed during read");
			offset += result.bytesRead;
		}
		const extra = Buffer.alloc(1);
		if ((await handle.read(extra, 0, 1, offset)).bytesRead !== 0 ||
			(await handle.stat()).size !== info.size)
			invalid("objective checkpoint physical file changed during read");
		return bytes;
	} catch (error) {
		if (error instanceof HarnessError) throw error;
		return invalid("objective checkpoint physical file is missing or invalid");
	} finally { await handle?.close(); }
}

function partName(generation: string, index: number): string {
	return `objective-checkpoint.part-${generation}-${String(index).padStart(6, "0")}.txt`;
}

function parseManifest(value: Record<string, unknown>, physicalBytes: number): Manifest {
	if (!exactKeys(value, ["version", "kind", "encoding", "generation", "totalBytes", "sha256", "parts"]) ||
		value.version !== 1 || value.kind !== MANIFEST_KIND || value.encoding !== ENCODING ||
		typeof value.generation !== "string" || !GENERATION.test(value.generation) ||
		typeof value.sha256 !== "string" || !SHA256.test(value.sha256) ||
		!Number.isSafeInteger(value.totalBytes) || (value.totalBytes as number) <= PLAIN_BYTES ||
		(value.totalBytes as number) > TRANSPORT_BYTES || !Array.isArray(value.parts) ||
		value.parts.length < 5 || value.parts.length > 64 ||
		value.parts.length !== Math.ceil((value.totalBytes as number) / PART_BYTES) ||
		physicalBytes > PART_BYTES)
		invalid("objective checkpoint multipart manifest is invalid");
	const generation = value.generation as string;
	const parts: Part[] = [];
	let sum = 0;
	for (let index = 0; index < value.parts.length; index++) {
		const row: unknown = value.parts[index];
		if (!object(row) || !exactKeys(row, ["name", "bytes", "sha256"]) ||
			row.name !== partName(generation, index + 1) ||
			!Number.isSafeInteger(row.bytes) || (row.bytes as number) < 1 || (row.bytes as number) > PART_BYTES ||
			(index < value.parts.length - 1 && row.bytes !== PART_BYTES) ||
			typeof row.sha256 !== "string" || !SHA256.test(row.sha256))
			invalid("objective checkpoint multipart part descriptor is invalid");
		parts.push(row as unknown as Part);
		sum += row.bytes as number;
	}
	if (sum !== value.totalBytes || sum + physicalBytes > TRANSPORT_BYTES)
		invalid("objective checkpoint multipart transport exceeds its byte limit");
	return value as unknown as Manifest;
}

/** Verify every current physical file before exposing any logical checkpoint text.
 * Unreferenced generations left by an interrupted write are ignored. */
export async function readObjectiveCheckpointTransport(file: string): Promise<ObjectiveCheckpointTransport> {
	const target = checkpointPath(file);
	await privateDirectory(target);
	const front = await readBounded(target, PLAIN_BYTES);
	let parsed: unknown;
	const frontText = utf8(front);
	try { parsed = JSON.parse(frontText); }
	catch { return invalid("objective checkpoint is not JSON"); }
	if (!object(parsed) || parsed.kind !== MANIFEST_KIND) {
		// Historical single-file checkpoints were accepted as raw JSON and may
		// predate the current kind field. Their authority checks live above this
		// physical reader; only newly written multipart payloads use this schema.
		return { text: frontText, physicalFiles: [target] };
	}
	const manifest = parseManifest(parsed, front.length);
	const directory = path.dirname(target);
	const expected = new Set(manifest.parts.map(part => part.name));
	const activePrefix = `objective-checkpoint.part-${manifest.generation}-`;
	for (const name of await readdir(directory)) {
		if (name.startsWith(activePrefix) && !expected.has(name))
			invalid("objective checkpoint has an unexpected active-generation part");
	}
	const buffers: Buffer[] = [];
	const physicalFiles = [target];
	for (const part of manifest.parts) {
		const partFile = path.join(directory, part.name);
		const bytes = await readBounded(partFile, PART_BYTES);
		if (bytes.length !== part.bytes || sha256(bytes) !== part.sha256)
			invalid("objective checkpoint multipart part does not match its manifest");
		buffers.push(bytes);
		physicalFiles.push(partFile);
	}
	const whole = Buffer.concat(buffers, manifest.totalBytes);
	if (whole.length !== manifest.totalBytes || sha256(whole) !== manifest.sha256)
		invalid("objective checkpoint multipart payload does not match its manifest");
	const text = utf8(whole);
	checkpointJson(text);
	return { text, physicalFiles };
}

export async function readObjectiveCheckpointFile(file: string): Promise<string> {
	return (await readObjectiveCheckpointTransport(file)).text;
}

async function writeNewFile(file: string, bytes: Buffer): Promise<void> {
	const handle = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
	try { await handle.writeFile(bytes); await handle.sync(); }
	finally { await handle.close(); }
}

async function syncDirectory(directory: string): Promise<void> {
	const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
	try { await handle.sync(); }
	finally { await handle.close(); }
}

/** Publish the manifest last, so an interrupted write leaves the previous
 * checkpoint authoritative. Old listed parts are removed only after publish. */
export async function writeObjectiveCheckpointFile(file: string, text: string): Promise<void> {
	const target = checkpointPath(file);
	if (typeof text !== "string") invalid("objective checkpoint text is invalid");
	const size = Buffer.byteLength(text, "utf8");
	if (size > TRANSPORT_BYTES) invalid("objective checkpoint exceeds the transport byte limit");
	checkpointJson(text);
	const bytes = Buffer.from(text, "utf8");
	if (utf8(bytes) !== text) invalid("objective checkpoint text is not exact UTF-8");
	await privateDirectory(target);
	let existing = false;
	try {
		const info = await lstat(target);
		if (!info.isFile() || info.isSymbolicLink()) invalid("objective checkpoint target is not a regular file");
		existing = true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	// An existing checkpoint is authoritative until a complete replacement is ready.
	// An incomplete or altered old generation must be repaired explicitly.
	const priorParts = existing ? (await readObjectiveCheckpointTransport(target)).physicalFiles.slice(1) : [];
	const directory = path.dirname(target);
	const generation = randomUUID().replaceAll("-", "");
	const temporary = `${target}.${generation}.tmp`;
	const newParts: string[] = [];
	let published = false;
	try {
		let front = bytes;
		if (bytes.length > PLAIN_BYTES) {
			const parts: Part[] = [];
			for (let start = 0, index = 1; start < bytes.length; start += PART_BYTES, index++) {
				const content = bytes.subarray(start, Math.min(start + PART_BYTES, bytes.length));
				parts.push({ name: partName(generation, index), bytes: content.length, sha256: sha256(content) });
			}
			const manifest: Manifest = { version: 1, kind: MANIFEST_KIND, encoding: ENCODING,
				generation, totalBytes: bytes.length, sha256: sha256(bytes), parts };
			front = Buffer.from(`${JSON.stringify(manifest)}\n`, "utf8");
			if (parts.length > 64 || front.length > PART_BYTES || front.length + bytes.length > TRANSPORT_BYTES)
				invalid("objective checkpoint multipart transport exceeds its byte limit");
			for (let index = 0; index < parts.length; index++) {
				const partFile = path.join(directory, parts[index]!.name);
				await writeNewFile(partFile, bytes.subarray(index * PART_BYTES, Math.min((index + 1) * PART_BYTES, bytes.length)));
				newParts.push(partFile);
			}
			await syncDirectory(directory);
		}
		await writeNewFile(temporary, front);
		await rename(temporary, target);
		published = true;
		await syncDirectory(directory);
	} finally {
		await unlink(temporary).catch(() => undefined);
		if (!published) for (const part of newParts) await unlink(part).catch(() => undefined);
	}
	for (const part of priorParts) await unlink(part).catch(() => undefined);
}
