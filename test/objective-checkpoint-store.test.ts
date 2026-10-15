import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readObjectiveCheckpointFile, readObjectiveCheckpointTransport,
	writeObjectiveCheckpointFile } from "../src/m07/objective-checkpoint-store.ts";

const MiB = 1024 * 1024;
const prefix = '{"version":1,"kind":"original-objective-progress","payload":"';
const suffix = '"}';
const checkpoint = (size: number): string => prefix + "x".repeat(size - prefix.length - suffix.length) + suffix;
const digest = (text: string): string => createHash("sha256").update(text).digest("hex");

async function fixture<T>(run: (file: string) => Promise<T>): Promise<T> {
	const directory = await mkdtemp(path.join(os.tmpdir(), "objective-checkpoint-store-"));
	try { return await run(path.join(directory, "objective-checkpoint.json")); }
	finally { await rm(directory, { recursive: true, force: true }); }
}


test("multipart preserves byte-exact UTF-8, ordered hashes and private physical bounds", async () => fixture(async file => {
	const text = prefix + "π".repeat(2 * MiB + 1) + suffix;
	await writeObjectiveCheckpointFile(file, text);
	const transport = await readObjectiveCheckpointTransport(file);
	assert.equal(transport.text, text);
	assert.ok(transport.physicalFiles.length >= 6);
	const manifest = JSON.parse(await readFile(file, "utf8"));
	assert.equal(manifest.kind, "objective-checkpoint-multipart");
	assert.equal(manifest.sha256, digest(text));
	assert.equal(manifest.totalBytes, Buffer.byteLength(text));
	assert.ok((await readFile(file)).length <= MiB);
	for (const part of transport.physicalFiles.slice(1))
		assert.ok((await readFile(part)).length <= MiB);
	assert.equal(await readObjectiveCheckpointFile(file), text);
}));

test("missing, tampered, symlinked and extra current parts all fail closed", async () => fixture(async file => {
	const text = checkpoint(4 * MiB + 1);
	await writeObjectiveCheckpointFile(file, text);
	const { physicalFiles } = await readObjectiveCheckpointTransport(file);
	const first = physicalFiles[1]!;
	const original = await readFile(first);
	await unlink(first);
	await assert.rejects(readObjectiveCheckpointFile(file));
	await writeFile(first, original);
	const changed = Buffer.from(original);
	changed[0] ^= 1;
	await writeFile(first, changed);
	await assert.rejects(readObjectiveCheckpointFile(file), /does not match/);
	await unlink(first);
	await symlink(physicalFiles[2]!, first);
	await assert.rejects(readObjectiveCheckpointFile(file));
	await unlink(first);
	await writeFile(first, original);
	const manifest = JSON.parse(await readFile(file, "utf8"));
	const extra = path.join(path.dirname(file),
		`objective-checkpoint.part-${manifest.generation}-000006.txt`);
	await writeFile(extra, "extra");
	await assert.rejects(readObjectiveCheckpointFile(file), /unexpected active-generation/);
}));
