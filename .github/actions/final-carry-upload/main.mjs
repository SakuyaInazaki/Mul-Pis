/** Trusted final carry transport. The manifest is the last artifact attempted;
 * a missing or uncertain part cannot become a completed mission carry. */
import { constants as fsConstants } from "node:fs";
import { mkdtemp, open, readdir, rm, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ARTIFACT_PARTITION_MANIFEST_FILE, ARTIFACT_PARTITION_PAYLOAD_BYTES,
	MAX_ARTIFACT_PARTITION_STREAM_BYTES, finalizePartitionManifest,
	partitionEncryptedFiles, sealPartitionManifest, validArtifactPartitionFileName } from
	"../../../src/runner/private-artifact-partition.ts";
import { authenticateSignedMissionSeed } from
	"../../../src/runner/signed-mission-ledger.ts";
import { CARRY_ARTIFACT_NAME, CARRY_FILE_NAME,
	authenticateSealedCarryFilesForUpload } from
	"../../../src/runner/ledger-continuation.ts";
import { CARRY_SEGMENT_FILE_BYTES } from "../../../src/runner/carry-sidecar-codec.ts";
import { PREFIX_SIDECAR_FILE_BYTES } from
	"../../../src/runner/incremental-prefix-sidecar-codec.ts";
import { INCREMENTAL_CHECKPOINT_FILE, openIncrementalControlPrefix } from
	"../../../src/runner/incremental-private-checkpoint.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MAIN_PART = /^ledger-continuation\.part-([0-9]{8})\.enc$/;
const PREFIX_PART = /^ledger-incremental-prefix-([1-9][0-9]{0,17})-([1-9][0-9]*)-([1-9][0-9]*)\.part-([0-9]{8})\.enc$/;
// The producer bounds the complete on-disk JSON wrapper at eight MiB.
const ROOT_MAX_BYTES = 8 * 1024 * 1024;
const PREFIX_MAX_BYTES = 64 * 1024 * 1024;
const encodedMax = bytes => Math.ceil(bytes / 3) * 4;

function validSource(env) {
	const attempt = Number(env.GITHUB_RUN_ATTEMPT);
	const source = { repository: env.GITHUB_REPOSITORY, runId: env.GITHUB_RUN_ID,
		runAttempt: attempt, commit: env.GITHUB_SHA, event: env.GITHUB_EVENT_NAME };
	if (source.repository !== "SakuyaInazaki/Mul-Pis" ||
		!/^([1-9][0-9]{0,17})$/.test(source.runId ?? "") ||
		!Number.isSafeInteger(attempt) || attempt < 1 ||
		!/^([0-9a-f]{40})$/.test(source.commit ?? "") ||
		!(["push", "workflow_dispatch"].includes(source.event)))
		throw new Error("final carry source is invalid");
	return source;
}

function fileLimit(name) {
	if (name === CARRY_FILE_NAME) return ROOT_MAX_BYTES;
	if (name === INCREMENTAL_CHECKPOINT_FILE) return PREFIX_MAX_BYTES;
	if (MAIN_PART.test(name)) return encodedMax(CARRY_SEGMENT_FILE_BYTES);
	if (PREFIX_PART.test(name)) return encodedMax(PREFIX_SIDECAR_FILE_BYTES);
	throw new Error("final carry file name is invalid");
}

function ensureContiguous(names) {
	const groups = new Map();
	for (const name of names) {
		const main = MAIN_PART.exec(name);
		const prefix = PREFIX_PART.exec(name);
		if (!main && !prefix) continue;
		const key = main ? "main" : prefix.slice(1, 4).join("-");
		const index = Number(main ? main[1] : prefix[4]);
		const items = groups.get(key) ?? [];
		items.push(index);
		groups.set(key, items);
	}
	for (const items of groups.values()) {
		items.sort((a, b) => a - b);
		if (items.some((index, position) => index !== position))
			throw new Error("final carry part sequence is incomplete");
	}
}

async function readOne(outputDir, name) {
	const target = path.join(outputDir, name);
	const handle = await open(target,
		fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
	try {
		const before = await handle.stat();
		if (!before.isFile() || before.nlink !== 1 || (before.mode & 0o077) !== 0 ||
			before.size < 1 || before.size > fileLimit(name))
			throw new Error("final carry file is unsafe");
		const bytes = await handle.readFile();
		const after = await handle.stat();
		if (bytes.length !== before.size || after.size !== before.size ||
			after.mtimeMs !== before.mtimeMs)
			throw new Error("final carry file changed during read");
		return bytes;
	} finally { await handle.close(); }
}

async function readCarryFiles(outputDir) {
	const entries = await readdir(outputDir);
	const names = entries.filter(name => validArtifactPartitionFileName(name)).sort();
	if (entries.some(name =>
		(name.startsWith("ledger-continuation.part-") ||
			name.startsWith("ledger-incremental-prefix-")) && !names.includes(name)))
		throw new Error("final carry has an invalid part name");
	if (!names.length || !names.includes(CARRY_FILE_NAME) &&
		!names.includes(INCREMENTAL_CHECKPOINT_FILE))
		throw new Error("final carry root is absent");
	if (!names.includes(CARRY_FILE_NAME) && names.some(name =>
		name !== INCREMENTAL_CHECKPOINT_FILE))
		throw new Error("final carry sidecar has no root");
	ensureContiguous(names);
	const files = Object.create(null);
	let length = 0;
	for (const name of names) {
		const bytes = await readOne(outputDir, name);
		if (bytes.length > MAX_ARTIFACT_PARTITION_STREAM_BYTES - length)
			throw new Error("final carry physical stream bound exceeded");
		files[name] = bytes;
		length += bytes.length;
	}
	return { files, names, length };
}

function uploadedPart(response) {
	if (!response || !Number.isSafeInteger(response.id) || response.id < 1 ||
		!/^([1-9][0-9]{0,17})$/.test(String(response.id)) ||
		typeof response.digest !== "string" ||
		!(/^[0-9a-f]{64}$/.test(response.digest) ||
			/^sha256:[0-9a-f]{64}$/.test(response.digest)))
		throw new Error("final carry part upload result is incomplete");
	return { artifactId: String(response.id),
		archiveSha256: response.digest.startsWith("sha256:") ?
			response.digest.slice(7) : response.digest };
}

function authenticateCurrentPrefix(bytes, missionKey, source) {
	let raw;
	let priorEnvelopeSha256;
	try {
		raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		priorEnvelopeSha256 = JSON.parse(raw)?.incrementalControlEnvelope?.source?.priorEnvelopeSha256;
	} catch { throw new Error("final carry current prefix encoding is invalid"); }
	if (typeof priorEnvelopeSha256 !== "string" || !/^[0-9a-f]{64}$/.test(priorEnvelopeSha256))
		throw new Error("final carry current prefix source is invalid");
	openIncrementalControlPrefix(raw, missionKey,
		{ ...source, priorEnvelopeSha256 });
}

async function actionsClient() {
	const { DefaultArtifactClient } = await import("@actions/artifact");
	return new DefaultArtifactClient();
}

/** The injected client is used only for offline tests. Never print a private
 * path, chunk byte, caught exception, or backend response to Actions logs. */
export async function uploadFinalCarry({ env = process.env, artifactClient,
	publicKeyFile = path.resolve(HERE, "../../../scripts/campaign-output-public.pem"),
	expectedSpkiSha256 } = {}) {
	const source = validSource(env);
	if (!env.RUNNER_TEMP || !path.isAbsolute(env.RUNNER_TEMP))
		throw new Error("final carry temporary directory is unavailable");
	const outputDir = path.join(env.RUNNER_TEMP, "private-campaign-output");
	const { files, names, length } = await readCarryFiles(outputDir);
	const seed = await authenticateSignedMissionSeed({
		envelopeB64: env.MULPIS_MISSION_LEDGER_B64, publicKeyFile, expectedSpkiSha256 });
	const missionKey = seed.derivePrivateKey("mul-pis-ledger-continuation-v1");
	if (files[CARRY_FILE_NAME]) {
		const runNumber = Number(env.GITHUB_RUN_NUMBER);
		if (!Number.isSafeInteger(runNumber) || runNumber < 1)
			throw new Error("final carry run number is invalid");
		authenticateSealedCarryFilesForUpload({ files, missionKey,
			seedDigest: seed.seedDigest,
			source: { runId: source.runId, runAttempt: source.runAttempt,
				runNumber, commit: source.commit } });
	}
	if (files[INCREMENTAL_CHECKPOINT_FILE])
		authenticateCurrentPrefix(files[INCREMENTAL_CHECKPOINT_FILE], missionKey, source);
	const client = artifactClient ?? await actionsClient();
	const hasSidecars = names.some(name => name !== CARRY_FILE_NAME &&
		name !== INCREMENTAL_CHECKPOINT_FILE);
	if (!hasSidecars && length <= ARTIFACT_PARTITION_PAYLOAD_BYTES) {
		const result = await client.uploadArtifact(CARRY_ARTIFACT_NAME,
			names.map(name => path.join(outputDir, name)), outputDir, { retentionDays: 1 });
		if (!result || !Number.isSafeInteger(result.id) || result.id < 1)
			throw new Error("legacy final carry upload result is incomplete");
		return { multipart: false, partCount: 0, rootArtifactId: result.id };
	}
	const prepared = partitionEncryptedFiles({ source, artifactName: CARRY_ARTIFACT_NAME, files });
	const temporary = await mkdtemp(path.join(env.RUNNER_TEMP, "private-carry-parts-"));
	const uploads = [];
	try {
		for (const chunk of prepared.chunks) {
			const chunkFile = path.join(temporary, chunk.fileName);
			await writeFile(chunkFile, chunk.bytes, { mode: 0o600, flag: "wx" });
			// An ambiguous rejection ends the sequence. Never retry a name that might
			// already exist, and never publish the root index in that case.
			const receipt = uploadedPart(await client.uploadArtifact(chunk.artifactName,
				[chunkFile], temporary, { retentionDays: 1, compressionLevel: 0 }));
			uploads.push({ index: chunk.index, ...receipt });
			await unlink(chunkFile);
		}
		const manifest = finalizePartitionManifest(prepared, uploads);
		const sealedManifest = sealPartitionManifest({ manifest, missionKey,
			seedDigest: seed.seedDigest });
		const manifestFile = path.join(temporary, ARTIFACT_PARTITION_MANIFEST_FILE);
		await writeFile(manifestFile, `${sealedManifest}\n`,
			{ mode: 0o600, flag: "wx" });
		const root = await client.uploadArtifact(CARRY_ARTIFACT_NAME,
			[manifestFile], temporary, { retentionDays: 1 });
		if (!root || !Number.isSafeInteger(root.id) || root.id < 1)
			throw new Error("final carry root upload result is incomplete");
		return { multipart: true, partCount: uploads.length, rootArtifactId: root.id };
	} finally { await rm(temporary, { recursive: true, force: true }); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try { await uploadFinalCarry(); }
	catch {
		process.stderr.write("Encrypted mission continuation upload failed\n");
		process.exitCode = 1;
	}
}
