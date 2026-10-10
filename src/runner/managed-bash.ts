/** Host-owned evidence for Pi's local bash tool. A receipt describes one shell
 * process and what the host observed; it never certifies remote side effects. */
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, readdir, rename, mkdir, unlink, lstat } from "node:fs/promises";
import path from "node:path";
import { createLocalBashOperations, getShellConfig, type BashOperations } from "@earendil-works/pi-coding-agent";
import { readCurrentProcessIdentity, type ProcessIdentityV1 } from "../runtime/process-identity.ts";

export interface ManagedBashReceiptV1 {
	version: 1;
	kind: "managed-local-bash";
	id: string;
	sessionId: string;
	toolCallId: string;
	commandSha256: string;
	cwd: string;
	preparedAt: string;
	spawn: "not-attempted" | "attempted" | "observed";
	pid: number | null;
	processIdentity: ProcessIdentityV1 | null;
	processGroupId: number | null;
	processExit: { exitCode: number | null; signal: NodeJS.Signals | null;
		abortSource: "none" | "signal" | "timeout"; observedAt: string } | null;
	toolOutcome: "unknown" | "returned" | "is-error" | "threw";
	toolErrorKind: "none" | "nonzero-exit" | "aborted" | "timeout" | "transport-or-tool";
	backend: "managed-posix" | "pi-local-fallback";
	/** Directory fsync is unavailable through this backend on Windows. */
	durability: "file-and-directory-sync" | "file-sync-only";
	/** Exact output bytes handed to Pi before the tool returned. A detached
	 * writer may append after this boundary; no pipe-close claim is made. */
	outputBytesAtExit: number | null;
	/** This is an observation of the spawned process group, not a complete
	 * descendant census: a child can escape its group or start remote work. */
	groupObservation: "unknown" | "members-observed" | "none-observed";
	remoteOrDetachedEffects: "unknown";
}

export interface ManagedBashCall {
	file: string;
	receipt: ManagedBashReceiptV1;
}

/** Rename plus file and directory sync make each transition recoverable after
 * a host process failure. An absent terminal transition always stays unknown. */
async function durableWrite(file: string, value: ManagedBashReceiptV1): Promise<void> {
	const directory = path.dirname(file);
	await mkdir(directory, { recursive: true });
	const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
	const handle = await open(temporary, "wx", 0o600);
	try { await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8"); await handle.sync(); }
	finally { await handle.close(); }
	await rename(temporary, file);
	if (process.platform !== "win32") {
		const dir = await open(directory, "r");
		try { await dir.sync(); }
		finally { await dir.close(); }
	}
}

export async function prepareManagedBashCall(directory: string, sessionId: string, toolCallId: string,
	command: string, cwd: string): Promise<ManagedBashCall> {
	const id = randomUUID();
	const file = path.join(directory, `${id}.json`);
	const receipt: ManagedBashReceiptV1 = {
		version: 1, kind: "managed-local-bash", id, sessionId, toolCallId,
		commandSha256: createHash("sha256").update(command, "utf8").digest("hex"),
		cwd, preparedAt: new Date().toISOString(), spawn: "not-attempted",
		pid: null, processIdentity: null, processGroupId: null,
		processExit: null, toolOutcome: "unknown", toolErrorKind: "none",
		backend: process.platform === "win32" ? "pi-local-fallback" : "managed-posix",
		durability: process.platform === "win32" ? "file-sync-only" : "file-and-directory-sync",
		outputBytesAtExit: null, groupObservation: "unknown",
		remoteOrDetachedEffects: "unknown",
	};
	await durableWrite(file, receipt);
	return { file, receipt };
}

async function update(call: ManagedBashCall, change: Partial<ManagedBashReceiptV1>): Promise<void> {
	const next = { ...call.receipt, ...change };
	await durableWrite(call.file, next);
	call.receipt = next;
}

export async function finishManagedBashCall(call: ManagedBashCall,
	result: "returned" | "is-error" | "threw",
	errorKind: ManagedBashReceiptV1["toolErrorKind"] = "none"): Promise<void> {
	await update(call, { toolOutcome: result, toolErrorKind: errorKind });
}

/** A zero signal to the process group is a portable POSIX liveness probe.
 * Only ESRCH proves no current member in this PGID. A positive result cannot
 * be narrowed by a procfs scan: procfs may hide live members while showing a
 * zombie. No result covers descendants that changed groups or remote work. */
export async function observeManagedProcessGroup(pgid: number, dependencies: {
	platform?: NodeJS.Platform;
	signalGroup?: (pgid: number) => void;
} = {}): Promise<ManagedBashReceiptV1["groupObservation"]> {
	if (!Number.isSafeInteger(pgid) || pgid <= 0) return "unknown";
	const platform = dependencies.platform ?? process.platform;
	if (platform === "win32") return "unknown";
	try { (dependencies.signalGroup ?? (id => process.kill(-id, 0)))(pgid); }
	catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ESRCH") return "none-observed";
		if (code !== "EPERM") return "unknown";
	}
	return "members-observed";
}

/** The caller supplies the exact Pi call context. Pi still owns formatting and
 * nonzero exit handling; this backend owns only execution and evidence. */
export function managedLocalBashOperations(call: () => ManagedBashCall | undefined): BashOperations {
	const fallback = createLocalBashOperations();
	return { exec: async (command, cwd, { onData, signal, timeout, env }) => {
		const current = call();
		if (!current || current.receipt.commandSha256 !== createHash("sha256").update(command, "utf8").digest("hex") ||
			current.receipt.cwd !== cwd) throw new Error("managed bash call context differs");
		if (signal?.aborted) throw new Error("aborted");
		if (timeout !== undefined && (!Number.isFinite(timeout) || timeout <= 0 || timeout * 1000 > 2_147_483_647))
			throw new Error("Invalid timeout: must be a positive finite number within the timer range");
		if (process.platform === "win32") {
			await update(current, { spawn: "attempted" });
			const result = await fallback.exec(command, cwd, { onData, signal, timeout, env });
			await update(current, { processExit: { exitCode: result.exitCode, signal: null,
				abortSource: "none", observedAt: new Date().toISOString() } });
			return result;
		}
		await update(current, { spawn: "attempted" });
		const shell = getShellConfig();
		const stdin = shell.commandTransport === "stdin";
		// Capture to an unlinked host file. A detached descendant can keep stdout
		// open indefinitely; a pipe-close wait would hang or lose the shell's last
		// bytes. Read through the exact file-size boundary after shell exit.
		const outputFile = path.join(path.dirname(current.file), `${current.receipt.id}.output-${randomUUID()}`);
		const output = await open(outputFile, "wx+", 0o600);
		try { await unlink(outputFile); }
		catch (error) { await output.close(); throw error; }
		let child;
		try {
			child = spawn(shell.shell, stdin ? shell.args : [...shell.args, command], {
				cwd, env, detached: true, stdio: [stdin ? "pipe" : "ignore", output.fd, output.fd], windowsHide: true,
			});
		} catch (error) { await output.close(); throw error; }
		if (stdin) { child.stdin?.on("error", () => undefined); child.stdin?.end(command); }
		const exitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
			child.once("error", reject);
			child.once("exit", (code, endingSignal) => resolve({ code, signal: endingSignal }));
		});
		void exitPromise.catch(() => undefined);
		let outputOffset = 0;
		let pendingPump: Promise<void> = Promise.resolve();
		const pump = (limit?: number): Promise<void> => {
			pendingPump = pendingPump.then(async () => {
				const end = limit ?? (await output.stat()).size;
				while (outputOffset < end) {
					const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, end - outputOffset));
					const { bytesRead } = await output.read(buffer, 0, buffer.length, outputOffset);
					if (bytesRead <= 0) throw new Error("managed bash output changed during drain");
					outputOffset += bytesRead;
					onData(buffer.subarray(0, bytesRead));
				}
			});
			return pendingPump;
		};
		const outputPoll = setInterval(() => { void pump().catch(() => undefined); }, 50);
		const pid = child.pid ?? null;
		const birth = pid === null ? null : await readCurrentProcessIdentity(pid).catch(() => null);
		// A crash between spawn and this synced write retains 'attempted': unknown.
		if (pid !== null) {
			try { await update(current, { spawn: "observed", pid,
				processIdentity: birth, processGroupId: pid }); }
			catch (error) {
				try { process.kill(-pid, "SIGKILL"); } catch { /* exit races */ }
				clearInterval(outputPoll);
				await output.close();
				throw error;
			}
		}
		let abortSource: "none" | "signal" | "timeout" = "none";
		let timer: NodeJS.Timeout | undefined;
		const killGroup = (source: "signal" | "timeout") => {
			if (abortSource !== "none") return;
			abortSource = source;
			if (pid !== null) {
				try { process.kill(-pid, "SIGKILL"); }
				catch { try { child.kill("SIGKILL"); } catch { /* exit races */ } }
			}
		};
		const abort = () => killGroup("signal");
		if (signal) signal.addEventListener("abort", abort, { once: true });
		if (signal?.aborted) abort();
		if (timeout !== undefined) timer = setTimeout(() => killGroup("timeout"), timeout * 1000);
		try {
			const exited = await exitPromise;
			clearInterval(outputPoll);
			await pendingPump;
			const outputBytesAtExit = (await output.stat()).size;
			await pump(outputBytesAtExit);
			const groupObservation = pid === null ? "unknown" : await observeManagedProcessGroup(pid);
			await update(current, { processExit: { exitCode: exited.code, signal: exited.signal,
				abortSource, observedAt: new Date().toISOString() }, groupObservation, outputBytesAtExit });
			if ((abortSource as string) === "signal") throw new Error("aborted");
			if ((abortSource as string) === "timeout") throw new Error(`timeout:${timeout}`);
			return { exitCode: exited.code };
		} finally {
			clearInterval(outputPoll);
			await output.close();
			if (timer) clearTimeout(timer);
			if (signal) signal.removeEventListener("abort", abort);
		}
	} };
}

export async function readManagedBashReceipt(file: string): Promise<ManagedBashReceiptV1> {
	const before = await lstat(file);
	if (!before.isFile() || (process.platform !== "win32" && (before.mode & 0o077) !== 0) || before.size > 16_384)
		throw new Error("managed bash receipt is not a private regular file");
	const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
	let bytes: Buffer;
	try {
		const observed = await handle.stat();
		if (!observed.isFile() || observed.dev !== before.dev || observed.ino !== before.ino ||
			observed.size !== before.size) throw new Error("managed bash receipt changed during open");
		bytes = await handle.readFile();
		const after = await handle.stat();
		if (after.size !== observed.size || after.mtimeMs !== observed.mtimeMs || after.ino !== observed.ino)
			throw new Error("managed bash receipt changed during read");
	} finally { await handle.close(); }
	let value: ManagedBashReceiptV1;
	try { value = JSON.parse(bytes.toString("utf8")) as ManagedBashReceiptV1; }
	catch { throw new Error("invalid managed bash receipt JSON"); }
	const exact = (item: unknown, keys: string[]): boolean => item !== null && typeof item === "object" && !Array.isArray(item) &&
		Object.keys(item as object).sort().join("\0") === keys.sort().join("\0");
	const safeText = (item: unknown, max: number): item is string =>
		typeof item === "string" && item.length > 0 && item.length <= max && !item.includes("\0");
	const identity = value.processIdentity;
	const processExit = value.processExit;
	if (!exact(value, ["version", "kind", "id", "sessionId", "toolCallId", "commandSha256", "cwd",
		"preparedAt", "spawn", "pid", "processIdentity", "processGroupId", "processExit", "toolOutcome",
		"toolErrorKind", "backend", "durability", "outputBytesAtExit", "groupObservation", "remoteOrDetachedEffects"]) ||
		value.version !== 1 || value.kind !== "managed-local-bash" ||
		!(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value.id)) ||
		!/^[A-Za-z0-9._-]{1,128}$/.test(value.sessionId) || !safeText(value.toolCallId, 512) ||
		!/^[0-9a-f]{64}$/.test(value.commandSha256) || !safeText(value.cwd, 4096) || !path.isAbsolute(value.cwd) ||
		!safeText(value.preparedAt, 64) || !Number.isFinite(Date.parse(value.preparedAt)) ||
		!["not-attempted", "attempted", "observed"].includes(value.spawn) ||
		(value.pid !== null && (!Number.isSafeInteger(value.pid) || value.pid <= 0)) ||
		(value.processGroupId !== null && (!Number.isSafeInteger(value.processGroupId) || value.processGroupId <= 0)) ||
		(identity !== null && (!exact(identity, ["hostId", "bootId", "pid", "processStartToken"]) ||
			!safeText(identity.hostId, 256) || !safeText(identity.bootId, 256) ||
			identity.pid !== value.pid || !safeText(identity.processStartToken, 256))) ||
		(processExit !== null && (!exact(processExit, ["exitCode", "signal", "abortSource", "observedAt"]) ||
			(processExit.exitCode !== null && (!Number.isSafeInteger(processExit.exitCode) || processExit.exitCode < 0)) ||
			(processExit.signal !== null && !/^SIG[A-Z0-9]+$/.test(processExit.signal)) ||
			!["none", "signal", "timeout"].includes(processExit.abortSource) ||
			!safeText(processExit.observedAt, 64) || !Number.isFinite(Date.parse(processExit.observedAt)))) ||
		!["unknown", "returned", "is-error", "threw"].includes(value.toolOutcome) ||
		!["none", "nonzero-exit", "aborted", "timeout", "transport-or-tool"].includes(value.toolErrorKind) ||
		!["managed-posix", "pi-local-fallback"].includes(value.backend) ||
		!["file-and-directory-sync", "file-sync-only"].includes(value.durability) ||
		(value.backend === "pi-local-fallback" && value.durability !== "file-sync-only") ||
		(value.backend === "managed-posix" && value.durability !== "file-and-directory-sync") ||
		(value.outputBytesAtExit !== null && (!Number.isSafeInteger(value.outputBytesAtExit) || value.outputBytesAtExit < 0)) ||
		!["unknown", "members-observed", "none-observed"].includes(value.groupObservation) ||
		value.remoteOrDetachedEffects !== "unknown" ||
		(value.spawn !== "observed" && (value.pid !== null || value.processIdentity !== null || value.processGroupId !== null)) ||
		(value.spawn === "observed" && (value.pid === null || value.processGroupId !== value.pid)) ||
		(value.backend === "pi-local-fallback" && (value.pid !== null || value.groupObservation !== "unknown")) ||
		(value.processExit !== null && value.spawn === "not-attempted") ||
		(value.toolOutcome === "unknown" && value.toolErrorKind !== "none") ||
		(value.toolOutcome !== "threw" && value.toolErrorKind !== "none") ||
		`${JSON.stringify(value)}\n` !== bytes.toString("utf8"))
		throw new Error("invalid managed bash receipt");
	return value;
}

/** Recovery reads only the durable records for one exact persisted Pi session.
 * Orphan .tmp files and missing terminal transitions cannot prove completion. */
export interface ManagedBashSessionEvidence {
	receipts: ManagedBashReceiptV1[];
	/** An interrupted atomic replacement. Its bytes are not trusted; only the
	 * last committed .json transition is evidence. */
	pendingReceiptIds: string[];
}

export async function readManagedBashSessionEvidence(persistDir: string, sessionId: string):
	Promise<ManagedBashSessionEvidence> {
	if (!/^[A-Za-z0-9._-]{1,128}$/.test(sessionId)) throw new Error("invalid managed bash session ID");
	const directory = path.join(persistDir, "host-execution-receipts", sessionId);
	const directoryStat = await lstat(directory).catch(error => {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	});
	if (directoryStat === null) return { receipts: [], pendingReceiptIds: [] };
	if (!directoryStat.isDirectory()) throw new Error("managed bash receipt directory is not a directory");
	let names: string[];
	names = await readdir(directory);
	const receipts: ManagedBashReceiptV1[] = [];
	const pendingReceiptIds: string[] = [];
	for (const name of names.sort()) {
		const pending = /^([0-9a-f-]{36})\.json\.[1-9]\d*\.[0-9a-f-]{36}\.tmp$/.exec(name);
		if (pending) {
			pendingReceiptIds.push(pending[1]);
			continue;
		}
		if (!/^[0-9a-f-]{36}\.json$/.test(name)) throw new Error("unexpected managed bash receipt member");
		const receipt = await readManagedBashReceipt(path.join(directory, name));
		if (receipt.sessionId !== sessionId || `${receipt.id}.json` !== name)
			throw new Error("managed bash receipt session binding differs");
		receipts.push(receipt);
	}
	return { receipts, pendingReceiptIds };
}

export async function readManagedBashSessionReceipts(persistDir: string, sessionId: string):
	Promise<ManagedBashReceiptV1[]> {
	return (await readManagedBashSessionEvidence(persistDir, sessionId)).receipts;
}
