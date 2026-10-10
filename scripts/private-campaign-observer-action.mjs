/** A local JavaScript action is required for GitHub's artifact runtime env.
 * It starts the trusted observer with those credentials; only the observer's
 * tightly allowlisted research child receives campaign inputs. */
import { spawn } from "node:child_process";
import { closeSync, openSync, writeSync } from "node:fs";
import { appendFile, lstat, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { constants as osConstants } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_HEARTBEAT_LINE = "Private campaign process responsive\n";

function relayFixedHeartbeat(stream, publicFd) {
	if (!stream) return;
	let fragment = Buffer.alloc(0);
	let discard = false;
	stream.on("data", chunk => {
		let start = 0;
		for (let index = 0; index < chunk.length; index++) {
			if (chunk[index] !== 10) continue;
			const part = chunk.subarray(start, index);
			if (!discard && fragment.length + part.length <= 128 &&
				Buffer.concat([fragment, part]).toString("utf8") + "\n" === PUBLIC_HEARTBEAT_LINE) {
				try { writeSync(publicFd, PUBLIC_HEARTBEAT_LINE); } catch {}
			}
			fragment = Buffer.alloc(0);
			discard = false;
			start = index + 1;
		}
		if (start < chunk.length && !discard) {
			const tail = chunk.subarray(start);
			if (fragment.length + tail.length > 128) { fragment = Buffer.alloc(0); discard = true; }
			else fragment = Buffer.concat([fragment, tail]);
		}
	});
	stream.on("error", () => {});
}

function exitCode(code, signal) {
	return code ?? (signal && osConstants.signals[signal] ? 128 + osConstants.signals[signal] : 1);
}

export async function runPrivateCampaignAction({
	env = process.env,
	spawnObserver = spawn,
	observerScript = path.join(HERE, "private-campaign-observer.ts"),
	publicFd = 1,
} = {}) {
	const temporary = env.RUNNER_TEMP;
	const input = env.INPUT_DIR;
	const outputFile = env.GITHUB_OUTPUT;
	if (!temporary || !path.isAbsolute(temporary) || !input || !outputFile)
		throw new Error("private campaign action inputs are unavailable");
	const outputDir = path.join(temporary, "private-campaign-output");
	await mkdir(outputDir, { recursive: true, mode: 0o700 });
	const receiptDir = await mkdtemp(path.join(temporary, "private-campaign-observer-"));
	const receiptFile = path.join(receiptDir, "driver-exit.json");
	let child;
	let observerCode;
	try {
		const stdout = openSync(path.join(temporary, "private-campaign-observer-stdout"), "w", 0o600);
		const stderr = openSync(path.join(temporary, "private-campaign-observer-stderr"), "w", 0o600);
		try {
			child = spawnObserver(process.execPath, [observerScript,
				"--input-dir", input, "--output-dir", outputDir,
				"--stdout", path.join(temporary, "private-campaign-stdout"),
				"--stderr", path.join(temporary, "private-campaign-stderr"),
				"--driver-exit-file", receiptFile],
				// The observer receives the Actions runtime env, but its research
				// child receives only the explicit allowlist. FD3 is gated below.
				{ env, stdio: ["inherit", stdout, stderr, "pipe"], detached: process.platform !== "win32" });
		} finally { closeSync(stdout); closeSync(stderr); }
		relayFixedHeartbeat(child.stdio[3], publicFd);
		observerCode = await new Promise(resolve => {
			let settled = false;
			child.once("error", () => { if (!settled) { settled = true; resolve(1); } });
			child.once("exit", (status, signal) => {
				if (!settled) { settled = true; resolve(exitCode(status, signal)); }
			});
		});
	} catch { observerCode = 1; }
	let receipt;
	try {
		const text = await readFile(receiptFile, "utf8");
		if (Buffer.byteLength(text, "utf8") <= 256) receipt = JSON.parse(text);
	} catch {}
	const verified = receipt && Object.keys(receipt).sort().join("|") ===
		["version", "kind", "driverExitCode", "childSignal"].sort().join("|") &&
		receipt.version === 1 && receipt.kind === "private-campaign-driver-exit" &&
		Number.isInteger(receipt.driverExitCode) && receipt.driverExitCode >= 0 &&
		receipt.driverExitCode <= 255 && receipt.driverExitCode === observerCode &&
		(receipt.childSignal === null || typeof receipt.childSignal === "string" &&
			Object.hasOwn(osConstants.signals, receipt.childSignal));
	// The observer owns a separate process group. Stop any descendants that
	// outlived it before final encryption reads the result directory.
	if (child?.pid && process.platform !== "win32") {
		try { process.kill(-child.pid, "SIGKILL"); } catch {}
	}
	let fallbackWritten = false;
	let existingStatus = false;
	try {
		await writeFile(path.join(outputDir, "campaign-status.json"),
			`${JSON.stringify(verified ? { driver_exit_code: receipt.driverExitCode,
				status: "incomplete",
				...(receipt.driverExitCode === 0 ? { observer: "campaign-status-missing" } : {}) } : { status: "incomplete",
				observer: "driver-outcome-unobserved" })}\n`,
			{ flag: "wx", mode: 0o600 });
		fallbackWritten = true;
	} catch (error) {
		if (error?.code !== "EEXIST") throw error;
		try {
			const info = await lstat(path.join(outputDir, "campaign-status.json"));
			existingStatus = info.isFile() && !info.isSymbolicLink() && info.size > 0;
		} catch {}
	}
	const result = verified && !(receipt.driverExitCode === 0 && (fallbackWritten || !existingStatus)) ?
		String(receipt.driverExitCode) : "unknown";
	await appendFile(outputFile, `driver_exit_code=${result}\n`);
	// Child failure is reported by the final generic step after ciphertext upload.
	return { driverExitCode: result, observerExitCode: observerCode };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		await runPrivateCampaignAction();
		process.exit(0);
	} catch {
		// No exception details may enter the public Actions log.
		process.exit(1);
	}
}
