/** Offline reader for one downloaded, encrypted Actions live-control frame.
 * The output remains partial control evidence: it grants no research adoption,
 * completion, or fee-settlement authority.
 * Usage: node scripts/read-live-control-frame.ts --frame FRAME.ndjson
 *   --seed SIGNED_SEED.txt --source SOURCE.json --public-key MISSION.pem
 *   --output PRIVATE_STATUS.json
 */
import { constants } from "node:fs";
import { lstat, open, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TextDecoder } from "node:util";
import { createLiveControlFrameReader, LIVE_CONTROL_FRAME_BYTES,
	type LiveControlFrameSource } from "../src/runner/live-control-frame.ts";

const FRAME_FILE_BYTES = LIVE_CONTROL_FRAME_BYTES + 2; // Optional final CRLF.
const SEED_FILE_BYTES = 48 * 1024 + 2;
const SOURCE_FILE_BYTES = 4096;
const REQUIRED = ["--frame", "--seed", "--source", "--public-key", "--output"] as const;

function fail(): never { throw new Error("live control frame input is invalid"); }
function parseArgs(args: string[]): Record<(typeof REQUIRED)[number], string> {
	if (args.length !== REQUIRED.length * 2) fail();
	const found = new Map<string, string>();
	for (let index = 0; index < args.length; index += 2) {
		if (!(REQUIRED as readonly string[]).includes(args[index]) || !args[index + 1] ||
			found.has(args[index])) fail();
		found.set(args[index], args[index + 1]);
	}
	if (found.size !== REQUIRED.length) fail();
	return Object.fromEntries(found) as Record<(typeof REQUIRED)[number], string>;
}
async function boundedBytes(handle: FileHandle, maxBytes: number): Promise<Buffer> {
	const stat = await handle.stat();
	if (!stat.isFile() || stat.size > maxBytes) fail();
	const bytes = Buffer.alloc(maxBytes + 1);
	let used = 0;
	while (used < bytes.length) {
		const result = await handle.read(bytes, used, bytes.length - used, null);
		if (result.bytesRead === 0) break;
		used += result.bytesRead;
	}
	if (used > maxBytes) fail();
	return bytes.subarray(0, used);
}
function utf8(bytes: Buffer): string {
	try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
	catch { return fail(); }
}
async function readPublicFile(file: string, maxBytes: number): Promise<string> {
	const before = await lstat(file);
	if (!before.isFile()) fail();
	const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const opened = await handle.stat();
		if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) fail();
		return utf8(await boundedBytes(handle, maxBytes));
	}
	finally { await handle.close(); }
}
async function readSeedFile(file: string): Promise<string> {
	const before = await lstat(file);
	if (!before.isFile() || before.isSymbolicLink() || (before.mode & 0o777) !== 0o600) fail();
	const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const opened = await handle.stat();
		if (!opened.isFile() || (opened.mode & 0o777) !== 0o600 ||
			opened.dev !== before.dev || opened.ino !== before.ino) fail();
		return utf8(await boundedBytes(handle, SEED_FILE_BYTES)).replace(/\r?\n$/, "");
	} finally { await handle.close(); }
}

/** The fingerprint override exists only for offline synthetic fixtures. The
 * command entry point always uses the pinned production mission key. */
export async function readLiveControlFrameFile(args: string[],
	expectedSpkiSha256?: string): Promise<void> {
	const paths = parseArgs(args);
	const frame = (await readPublicFile(paths["--frame"], FRAME_FILE_BYTES)).replace(/\r?\n$/, "");
	if (!frame.length || Buffer.byteLength(frame, "utf8") > LIVE_CONTROL_FRAME_BYTES) fail();
	const seedEnvelopeB64 = await readSeedFile(paths["--seed"]);
	let source: unknown;
	try { source = JSON.parse(await readPublicFile(paths["--source"], SOURCE_FILE_BYTES)); }
	catch { return fail(); }
	const reader = await createLiveControlFrameReader({ seedEnvelopeB64,
		publicKeyFile: paths["--public-key"], source: source as LiveControlFrameSource,
		expectedSpkiSha256 });
	const result = reader.read(frame);
	const output = JSON.stringify({ version: 1, kind: "authenticated-live-control-observation",
		source, sequence: result.sequence, missedSequences: result.missedSequences,
		status: result.status });
	const destination = await open(paths["--output"],
		constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
	try {
		await destination.chmod(0o600);
		await destination.writeFile(`${output}\n`, { encoding: "utf8" });
	} finally { await destination.close(); }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
	await readLiveControlFrameFile(process.argv.slice(2)).catch(() => {
		process.stderr.write("Live control frame could not be authenticated or saved.\n");
		process.exitCode = 1;
	});
}
