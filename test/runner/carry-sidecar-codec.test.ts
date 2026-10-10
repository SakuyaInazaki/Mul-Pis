import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { CARRY_LOGICAL_BYTES, CARRY_SEGMENT_RAW_BYTES, carrySidecarName,
	decodeCarrySidecars, encodeCarrySidecars, validCarrySidecarManifest } from
	"../../src/runner/carry-sidecar-codec.ts";

const binding = { key: Buffer.alloc(32, 7), seedDigest: "a".repeat(64),
	parentDigest: "b".repeat(64), source: { runId: "31", runAttempt: 1,
		runNumber: 31, commit: "c".repeat(40) } };
function open(encoded: ReturnType<typeof encodeCarrySidecars>,
	changes: Partial<typeof binding> = {}, parts = encoded.sidecars) {
	const map = new Map(parts.map(part => [part.name, part.bytes]));
	return decodeCarrySidecars({ ...binding, ...changes, manifest: encoded.manifest,
		load: name => { const bytes = map.get(name); if (!bytes) throw Error("missing"); return bytes; } });
}

test("sidecars losslessly carry a large logical history across bounded encrypted files", () => {
	const raw = Buffer.from(JSON.stringify({ version: 3,
		privateBundle: { "research-history.json": randomBytes(3_200_000).toString("base64"),
			"objective-checkpoint.json": "checkpoint" } }), "utf8");
	assert.ok(raw.length > 4 * 1024 * 1024);
	const encoded = encodeCarrySidecars({ ...binding, plaintext: raw });
	assert.equal(encoded.manifest.segmentCount, Math.ceil(raw.length / CARRY_SEGMENT_RAW_BYTES));
	assert.deepEqual(encoded.sidecars.map(part => part.name),
		encoded.sidecars.map((_, index) => carrySidecarName(index)));
	assert.ok(encoded.sidecars.every(part => part.bytes.length < CARRY_SEGMENT_RAW_BYTES + 4096));
	assert.deepEqual(open(encoded), raw);
});

test("sidecars reject missing, tampered, reordered, truncated and other-source parts", () => {
	const encoded = encodeCarrySidecars({ ...binding, plaintext: randomBytes(2_100_000) });
	assert.throws(() => open(encoded, {}, encoded.sidecars.slice(1)), /required sidecar/);
	const flipped = encoded.sidecars.map(part => ({ ...part, bytes: Buffer.from(part.bytes) }));
	flipped[1]!.bytes[30] ^= 1;
	assert.throws(() => open(encoded, {}, flipped), /authentication failed/);
	const swapped = encoded.sidecars.map(part => ({ ...part }));
	[swapped[0]!.bytes, swapped[1]!.bytes] = [swapped[1]!.bytes, swapped[0]!.bytes];
	assert.throws(() => open(encoded, {}, swapped), /authentication failed/);
	const truncated = encoded.sidecars.map(part => ({ ...part }));
	truncated[0]!.bytes = truncated[0]!.bytes.subarray(0, -1);
	assert.throws(() => open(encoded, {}, truncated), /authentication failed/);
	assert.throws(() => open(encoded, { source: { ...binding.source, runId: "32" } }),
		/authentication failed/);
});

test("sidecar manifest rejects huge counts and length before loading or allocation", () => {
	const encoded = encodeCarrySidecars({ ...binding, plaintext: Buffer.from("payload") });
	let loaded = 0;
	const load = () => { loaded++; throw Error("must not load"); };
	for (const manifest of [
		{ ...encoded.manifest, plaintextBytes: Number.MAX_SAFE_INTEGER,
			segmentCount: Math.ceil(Number.MAX_SAFE_INTEGER / CARRY_SEGMENT_RAW_BYTES) },
		{ ...encoded.manifest, plaintextBytes: CARRY_LOGICAL_BYTES + 1,
			segmentCount: Math.ceil((CARRY_LOGICAL_BYTES + 1) / CARRY_SEGMENT_RAW_BYTES) },
		{ ...encoded.manifest, segmentCount: 999999 },
	]) {
		assert.equal(validCarrySidecarManifest(manifest), false);
		assert.throws(() => decodeCarrySidecars({ ...binding, manifest, load }),
			/sidecar manifest is invalid/);
	}
	assert.equal(loaded, 0);
});

test("sidecar decompression rejects an authenticated inflation bomb", () => {
	// A full-size zero chunk compresses to a tiny ciphertext yet still expands
	// only to its declared 1 MiB. A mismatch in total manifest length fails.
	const encoded = encodeCarrySidecars({ ...binding,
		plaintext: Buffer.alloc(CARRY_SEGMENT_RAW_BYTES + 1) });
	assert.deepEqual(open(encoded), Buffer.alloc(CARRY_SEGMENT_RAW_BYTES + 1));
	const forged = { ...encoded, manifest: { ...encoded.manifest,
		plaintextBytes: CARRY_SEGMENT_RAW_BYTES } };
	assert.throws(() => open(forged), /sidecar manifest is invalid/);
});
