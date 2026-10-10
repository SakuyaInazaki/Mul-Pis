import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, symlink, unlink, writeFile } from "node:fs/promises";
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

test("plain checkpoint stays byte-exact through the 4 MiB boundary", async () => fixture(async file => {
	const text = checkpoint(4 * MiB);
	await writeObjectiveCheckpointFile(file, text);
	assert.equal((await readFile(file)).length, 4 * MiB);
	assert.deepEqual(await readObjectiveCheckpointTransport(file), { text, physicalFiles: [file] });
	assert.deepEqual(await readdir(path.dirname(file)), ["objective-checkpoint.json"]);
}));

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

test("interrupted next generation leaves old manifest valid; later publish prunes prior generation", async () => fixture(async file => {
	const old = checkpoint(4 * MiB + 1);
	await writeObjectiveCheckpointFile(file, old);
	const before = await readObjectiveCheckpointTransport(file);
	const orphan = path.join(path.dirname(file),
		"objective-checkpoint.part-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-000001.txt");
	await writeFile(orphan, "incomplete next generation");
	assert.equal(await readObjectiveCheckpointFile(file), old);
	const replacement = checkpoint(4 * MiB + 2);
	await writeObjectiveCheckpointFile(file, replacement);
	assert.equal(await readObjectiveCheckpointFile(file), replacement);
	const names = new Set(await readdir(path.dirname(file)));
	for (const part of before.physicalFiles.slice(1)) assert.equal(names.has(path.basename(part)), false);
	assert.equal(names.has(path.basename(orphan)), true);
	await writeObjectiveCheckpointFile(file, checkpoint(300));
	assert.equal((await readObjectiveCheckpointTransport(file)).physicalFiles.length, 1);
}));

test("replacement refuses an existing incomplete or corrupt generation", async () => fixture(async file => {
	await writeObjectiveCheckpointFile(file, checkpoint(4 * MiB + 1));
	const front = await readFile(file);
	const previousFiles = (await readdir(path.dirname(file))).sort();
	const current = await readObjectiveCheckpointTransport(file);
	await unlink(current.physicalFiles[1]!);
	await assert.rejects(writeObjectiveCheckpointFile(file, checkpoint(300)));
	assert.deepEqual(await readFile(file), front);
	assert.deepEqual((await readdir(path.dirname(file))).sort(),
		previousFiles.filter(name => name !== path.basename(current.physicalFiles[1]!)));
	await writeFile(current.physicalFiles[1]!, Buffer.alloc(MiB, 0));
	await assert.rejects(writeObjectiveCheckpointFile(file, checkpoint(300)), /does not match/);
	assert.deepEqual(await readFile(file), front);
}));

test("64 MiB physical cap rejects oversized update before publication", async () => fixture(async file => {
	const old = checkpoint(4 * MiB + 1);
	await writeObjectiveCheckpointFile(file, old);
	const before = await readObjectiveCheckpointTransport(file);
	await assert.rejects(writeObjectiveCheckpointFile(file, checkpoint(64 * MiB - 1_000)), /byte limit/);
	assert.equal(await readObjectiveCheckpointFile(file), old);
	assert.deepEqual((await readObjectiveCheckpointTransport(file)).physicalFiles, before.physicalFiles);
	const admitted = checkpoint(64 * MiB - 20_000);
	await writeObjectiveCheckpointFile(file, admitted);
	const transport = await readObjectiveCheckpointTransport(file);
	assert.equal(transport.text.length, admitted.length);
	assert.equal(digest(transport.text), digest(admitted));
	const physicalBytes = (await Promise.all(transport.physicalFiles.map(item => readFile(item)))).reduce(
		(sum, bytes) => sum + bytes.length, 0);
	assert.ok(physicalBytes <= 64 * MiB);
}));

test("logical checkpoint kind, malformed manifest and traversal descriptors are rejected", async () => fixture(async file => {
	await assert.rejects(writeObjectiveCheckpointFile(file, '{"version":1,"kind":"other"}'), /kind/);
	await writeObjectiveCheckpointFile(file, checkpoint(4 * MiB + 1));
	const manifest = JSON.parse(await readFile(file, "utf8"));
	manifest.parts[0].name = "../outside.txt";
	await writeFile(file, JSON.stringify(manifest));
	await assert.rejects(readObjectiveCheckpointFile(file), /descriptor/);
}));
