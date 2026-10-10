import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import test from "node:test";
import { downloadCarryArtifact } from "../src/runner/ledger-continuation.ts";
import { MISSION_REPOSITORY } from "../src/runner/signed-mission-ledger.ts";
import { ARTIFACT_PARTITION_MANIFEST_FILE, artifactPartitionPartFile,
	finalizePartitionManifest, isOpenedPartitionManifest, openPartitionManifest,
	partitionEncryptedFiles, restorePartitionFiles, sealPartitionManifest,
	validatePartitionArtifactCensus, validPartitionManifest,
	type ArtifactTransportSource } from "../src/runner/private-artifact-partition.ts";

const source: ArtifactTransportSource = { repository: MISSION_REPOSITORY, runId: "7003", runAttempt: 1,
	commit: "c".repeat(40), event: "workflow_dispatch" };
const name = "confidential-mission-prefix-7003-1-2";
const seedDigest = "d".repeat(64);
const missionKey = Buffer.alloc(32, 37);
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
function zipOne(label: string, content: Buffer): Buffer {
	const name = Buffer.from(label);
	const local = Buffer.alloc(30);
	local.writeUInt32LE(0x04034b50, 0);
	local.writeUInt32LE(content.length, 18); local.writeUInt32LE(content.length, 22);
	local.writeUInt16LE(name.length, 26);
	const central = Buffer.alloc(46);
	central.writeUInt32LE(0x02014b50, 0);
	central.writeUInt32LE(content.length, 20); central.writeUInt32LE(content.length, 24);
	central.writeUInt16LE(name.length, 28);
	const cdOffset = local.length + name.length + content.length;
	const eocd = Buffer.alloc(22);
	eocd.writeUInt32LE(0x06054b50, 0);
	eocd.writeUInt16LE(1, 8); eocd.writeUInt16LE(1, 10);
	eocd.writeUInt32LE(central.length + name.length, 12);
	eocd.writeUInt32LE(cdOffset, 16);
	return Buffer.concat([local, name, content, central, name, eocd]);
}

test("encrypted multipart index restores exact files and binds reordered source fields", () => {
	const raw = randomBytes(17 * 1024 * 1024);
	const prepared = partitionEncryptedFiles({ source, artifactName: name,
		files: { "incremental-control-prefix.json": raw } });
	assert.equal(prepared.chunks.length, 2);
	assert.equal(prepared.chunks[0].bytes.length, 16 * 1024 * 1024);
	assert.equal(prepared.chunks[1].fileName, artifactPartitionPartFile(1));
	const uploads = prepared.chunks.map(chunk => ({ index: chunk.index,
		artifactId: String(8000 + chunk.index), archiveSha256: String(chunk.index).repeat(64) }));
	const manifest = finalizePartitionManifest(prepared, uploads);
	const sealed = sealPartitionManifest({ manifest, missionKey, seedDigest });
	assert.equal(ARTIFACT_PARTITION_MANIFEST_FILE, "private-artifact-transport.enc.json");
	assert.doesNotMatch(sealed, /incremental-control-prefix\.json|"parts"|"artifactId"/);
	const reorderedSource = { event: source.event, commit: source.commit,
		runAttempt: source.runAttempt, runId: source.runId, repository: source.repository };
	const reorderedManifest = { ...manifest, source: reorderedSource };
	assert.equal(validPartitionManifest(reorderedManifest, source, name), true);
	assert.equal(validPartitionManifest({ ...manifest,
		source: { ...reorderedSource, commit: "e".repeat(40) } }, source, name), false);
	const opened = openPartitionManifest({ raw: sealed, missionKey, seedDigest,
		expectedSource: source, expectedArtifactName: name });
	assert.equal(isOpenedPartitionManifest(opened), true);
	assert.equal(isOpenedPartitionManifest({ ...opened }), false);
	const census = opened.chunks.map(part => ({ id: Number(part.artifactId),
		name: part.artifactName, expired: false, digest: `sha256:${part.archiveSha256}`,
		workflow_run: { id: 7003, head_sha: source.commit } }));
	validatePartitionArtifactCensus(opened, census);
	assert.throws(() => validatePartitionArtifactCensus(opened,
		[{ ...census[0], expired: true }, census[1]]), /unavailable|digest/);
	const restored = restorePartitionFiles(opened, prepared.chunks.map(chunk => chunk.bytes),
		source, name);
	assert.deepEqual(restored["incremental-control-prefix.json"], raw);
	const wrong = prepared.chunks.map(chunk => Buffer.from(chunk.bytes));
	wrong[0][0] ^= 1;
	assert.throws(() => restorePartitionFiles(opened, wrong, source, name), /chunk bytes differ/);
	const outer = JSON.parse(sealed);
	outer.source.commit = "e".repeat(40);
	assert.throws(() => openPartitionManifest({ raw: JSON.stringify(outer), missionKey,
		seedDigest, expectedSource: source, expectedArtifactName: name }), /outer source/);
});

test("direct downloader authenticates encrypted 17MiB multipart index before fetching parts", async () => {
	const raw = Buffer.alloc(17 * 1024 * 1024, 0x61);
	const prepared = partitionEncryptedFiles({ source, artifactName: name,
		files: { "incremental-control-prefix.json": raw } });
	const archives = new Map<string, Buffer>();
	const rows: object[] = [];
	const uploads = prepared.chunks.map(chunk => {
		const id = String(8100 + chunk.index);
		const zip = zipOne(chunk.fileName, chunk.bytes);
		archives.set(id, zip);
		rows.push({ id: Number(id), name: chunk.artifactName, expired: false,
			digest: `sha256:${sha256(zip)}`,
			workflow_run: { id: 7003, head_sha: source.commit } });
		return { index: chunk.index, artifactId: id, archiveSha256: sha256(zip) };
	});
	const manifest = finalizePartitionManifest(prepared, uploads);
	const sealed = sealPartitionManifest({ manifest, missionKey, seedDigest });
	const rootZip = zipOne(ARTIFACT_PARTITION_MANIFEST_FILE, Buffer.from(sealed));
	archives.set("8200", rootZip);
	rows.push({ id: 8200, name, expired: false, digest: `sha256:${sha256(rootZip)}`,
		workflow_run: { id: 7003, head_sha: source.commit } });
	const request: typeof fetch = async url => {
		const address = String(url);
		if (address.includes("/runs/7003/artifacts?"))
			return new Response(JSON.stringify({ total_count: rows.length, artifacts: rows }));
		const match = /\/actions\/artifacts\/([1-9][0-9]*)\/zip$/.exec(address);
		if (!match) throw Error("unexpected synthetic request");
		const bytes = archives.get(match[1]);
		if (!bytes) throw Error("unexpected synthetic artifact");
		return new Response(bytes);
	};
	const loaded = await downloadCarryArtifact({ githubToken: "synthetic-token",
		artifactId: "8200", expectedArchiveSha256: sha256(rootZip),
		missionKey, seedDigest, expectedSource: source, expectedArtifactName: name, request });
	if (typeof loaded === "string" || !("incrementalControlPrefix" in loaded) ||
		typeof loaded.incrementalControlPrefix !== "string")
		throw Error("expected multipart restored prefix");
	assert.equal(sha256(Buffer.from(loaded.incrementalControlPrefix)), sha256(raw));
	assert.equal(isOpenedPartitionManifest(loaded.transportIndex), true);
	assert.deepEqual([...archives.keys()], ["8100", "8101", "8200"]);
});
