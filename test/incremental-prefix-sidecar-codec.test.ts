import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { decodeHistoricalPrefixSidecars, encodeHistoricalPrefixSidecars,
	PREFIX_LOGICAL_BYTES, PREFIX_SIDECAR_FILE_BYTES,
	validHistoricalPrefixSidecarManifest } from "../src/runner/incremental-prefix-sidecar-codec.ts";
import { MISSION_REPOSITORY } from "../src/runner/signed-mission-ledger.ts";

const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

test("near-64MiB historical prefix remains byte-exact through 1MiB sealed segments", () => {
	const binding = { key: Buffer.alloc(32, 19), seedDigest: "a".repeat(64),
		source: { runId: "7003", runAttempt: 1, runNumber: 3, commit: "c".repeat(40) },
		event: "workflow_dispatch" as const, priorCarryEnvelopeSha256: "b".repeat(64),
		artifact: { repository: MISSION_REPOSITORY, artifactId: "9702",
			artifactName: "confidential-mission-prefix-7003-1-2", runId: "7003",
			archiveSha256: "d".repeat(64), digestScope: "github-artifact-archive" as const },
		sequence: 2 };
	const original = Buffer.alloc(PREFIX_LOGICAL_BYTES - 32, 0x67);
	const encoded = encodeHistoricalPrefixSidecars({ ...binding, plaintext: original });
	assert.equal(validHistoricalPrefixSidecarManifest(encoded.manifest), true);
	assert.equal(encoded.manifest.segmentCount, 64);
	assert.equal(encoded.manifest.plaintextBytes, PREFIX_LOGICAL_BYTES - 32);
	assert.ok(encoded.sidecars.every(part => part.bytes.length <= PREFIX_SIDECAR_FILE_BYTES));
	const bytes = new Map(encoded.sidecars.map(part => [part.name, part.bytes]));
	const restored = decodeHistoricalPrefixSidecars({ ...binding, manifest: encoded.manifest,
		load: name => { const part = bytes.get(name); if (!part) throw Error("missing"); return part; } });
	assert.equal(restored.length, original.length);
	assert.equal(hash(restored), hash(original));
	const first = encoded.sidecars[0];
	bytes.set(first.name, Buffer.from(first.bytes));
	bytes.get(first.name)![12] ^= 1;
	assert.throws(() => decodeHistoricalPrefixSidecars({ ...binding, manifest: encoded.manifest,
		load: name => { const part = bytes.get(name); if (!part) throw Error("missing"); return part; } }),
		/authentication/);
});
