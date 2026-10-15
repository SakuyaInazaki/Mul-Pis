import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
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
