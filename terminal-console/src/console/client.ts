import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import { chmod, lstat, mkdir, readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MAX_FRAME_BYTES, type ConsoleRecord, type ConsoleRequest, type ConsoleResponse } from "./protocol.ts";
import type { ConsoleHostOptions } from "./host.ts";
import { probeProcessIdentity } from "../../../src/runtime/process-identity.ts";
import { assertRecoverableConsoleHostExtension, configuredConsoleModel, resolveConsoleHostExtension, resolveConsoleSource, type ConsoleSource } from "./source.ts";

export interface StartConsoleOptions { workspace: string; prompt?: string; goalRunId?: string; oldDescriptorFile?: string; recover?: boolean; hostExtensionFile?: string }
export async function resolveConsoleStartExtension(workspace: string, source: ConsoleSource, requested?: string, oldDescriptorFile?: string): Promise<string> {
	if (!oldDescriptorFile) return resolveConsoleHostExtension(source, requested);
	const oldFile = await realpath(oldDescriptorFile);
	const oldControlDir = path.dirname(oldFile);
	const instanceId = path.basename(oldControlDir);
	const instancesDir = path.join(workspace, ".agent", "console", "instances");
	if (path.basename(oldFile) !== "run-descriptor.json" || path.dirname(oldControlDir) !== instancesDir || !/^[a-f0-9-]{36}$/.test(instanceId)) {
		const selected = await resolveConsoleHostExtension(source, requested);
		assertRecoverableConsoleHostExtension(source, selected);
		return selected;
	}
	const oldRecord = JSON.parse(await readFile(path.join(oldControlDir, "instance.json"), "utf8")) as ConsoleRecord;
	if (oldRecord.version !== 1 || oldRecord.instanceId !== instanceId || oldRecord.workspace !== workspace ||
		oldRecord.controlDir !== oldControlDir || oldRecord.descriptorFile !== oldFile || JSON.stringify(oldRecord.source) !== JSON.stringify(source))
		throw new Error("old console record does not match the recovery source and descriptor");
	if (oldRecord.hostExtensionFile !== undefined && typeof oldRecord.hostExtensionFile !== "string") throw new Error("old console host extension path is invalid");
	const inherited = await resolveConsoleHostExtension(source, oldRecord.hostExtensionFile);
	if (requested && await resolveConsoleHostExtension(source, requested) !== inherited)
		throw new Error("recovery must reuse the old console host extension entry");
	assertRecoverableConsoleHostExtension(source, inherited);
	return inherited;
}
function expectedSocketPath(instanceId: string): string { return path.join("/tmp", `prsi-console-${process.getuid?.() ?? "user"}-${instanceId}`, "rpc.sock"); }
async function verifyConnection(record: ConsoleRecord): Promise<void> {
	if (!/^[a-f0-9-]{36}$/.test(record.instanceId) || record.socketPath !== expectedSocketPath(record.instanceId)) throw new Error("console record has an unexpected socket path");
	if (record.controlDir !== path.join(record.workspace, ".agent", "console", "instances", record.instanceId) || record.descriptorFile !== path.join(record.controlDir, "run-descriptor.json")) throw new Error("console record has an unexpected control path");
	if (!record.hostProcess || record.hostPid !== record.hostProcess.pid) throw new Error("console host identity is unavailable");
	const probe = await probeProcessIdentity(record.hostProcess);
	if (probe.status !== "alive" || !probe.identityMatch) throw new Error(`console host identity changed: ${probe.reason}`);
	const directory = await lstat(path.dirname(record.socketPath));
	const socket = await lstat(record.socketPath);
	if (!directory.isDirectory() || directory.uid !== process.getuid?.() || (directory.mode & 0o777) !== 0o700 || !socket.isSocket() || socket.uid !== process.getuid?.() || (socket.mode & 0o777) !== 0o600) throw new Error("console socket is not private to this user");
}
export async function listConsoles(workspace: string): Promise<ConsoleRecord[]> {
	const root = path.join(await realpath(workspace), ".agent", "console", "instances");
	const names = await readdir(root).catch(() => []);
	const records: ConsoleRecord[] = [];
	for (const name of names) {
		try {
			const item = JSON.parse(await readFile(path.join(root, name, "instance.json"), "utf8")) as ConsoleRecord;
			if (item.version === 1 && item.instanceId === name && item.workspace === await realpath(workspace) && item.controlDir === path.join(root, name) && item.descriptorFile === path.join(root, name, "run-descriptor.json") && item.socketPath === expectedSocketPath(name)) {
				const observed = item.hostProcess ? await probeProcessIdentity(item.hostProcess) : undefined;
				records.push(observed && (observed.status !== "alive" || !observed.identityMatch) && item.state === "running" ? { ...item, state: "error", error: `host unavailable: ${observed.reason}` } : item);
			}
		} catch { /* malformed or partial record is not controllable */ }
	}
	return records.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

export async function startConsole(options: StartConsoleOptions): Promise<ConsoleRecord> {
	if (Boolean(options.goalRunId) !== Boolean(options.recover) || Boolean(options.goalRunId) !== Boolean(options.oldDescriptorFile)) throw new Error("existing goal requires goalRunId, oldDescriptorFile and recover together");
	const workspace = await realpath(options.workspace);
	const source = await resolveConsoleSource(workspace);
	const model = await configuredConsoleModel(workspace);
	const hostExtensionFile = await resolveConsoleStartExtension(workspace, source, options.hostExtensionFile, options.oldDescriptorFile);
	const instanceId = randomUUID();
	const controlDir = path.join(workspace, ".agent", "console", "instances", instanceId);
	const socketPath = expectedSocketPath(instanceId);
	const socketDirectory = path.dirname(socketPath);
	await mkdir(controlDir, { recursive: true, mode: 0o700 });
	await chmod(controlDir, 0o700);
	await mkdir(socketDirectory, { mode: 0o700 });
	await chmod(socketDirectory, 0o700);
	const config: ConsoleHostOptions = { workspace, instanceId, controlDir, socketPath, recordFile: path.join(controlDir, "instance.json"), source, model, hostExtensionFile, ...(options.prompt ? { prompt: options.prompt } : {}), ...(options.goalRunId ? { goalRunId: options.goalRunId } : {}), ...(options.oldDescriptorFile ? { oldDescriptorFile: options.oldDescriptorFile } : {}), ...(options.recover ? { recover: true } : {}) };
	const configFile = path.join(controlDir, "host-options.json");
	await writeFile(configFile, `${JSON.stringify(config)}\n`, { mode: 0o600, flag: "wx" });
	const host = spawn(process.execPath, [fileURLToPath(new URL("./host.ts", import.meta.url)), configFile], { cwd: workspace, detached: true, stdio: "ignore" });
	let spawnError: Error | undefined;
	let hostExit: number | null | undefined;
	host.once("error", (error) => { spawnError = error; });
	host.once("exit", (code) => { hostExit = code; });
	host.unref();
	for (let i = 0; i < 400; i++) {
		if (spawnError) throw spawnError;
		if (hostExit !== undefined) throw new Error(`console host exited before ready (code ${hostExit}); inspect ${config.recordFile} and workspace owner.lock`);
		try {
			const record = JSON.parse(await readFile(config.recordFile, "utf8")) as ConsoleRecord;
			if (record.state === "error") throw new Error(`console host failed: ${record.error ?? "unknown error"}`);
			if (record.state === "exited") throw new Error(`console host failed: Pi exited during startup (${record.exitCode ?? record.exitSignal ?? "unknown"}); inspect ${config.recordFile}`);
			if (record.state === "running" && (await stat(record.descriptorFile)).isFile()) return record;
		} catch (error) { if (error instanceof Error && error.message.startsWith("console host failed:")) throw error; }
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	throw new Error(`console host did not become ready; inspect ${config.recordFile}`);
}

export async function connectConsole(record: ConsoleRecord, request: ConsoleRequest, timeoutMs = 35_000): Promise<ConsoleResponse> {
	await verifyConnection(record);
	const socketPath = record.socketPath;
	return new Promise((resolve, reject) => {
		const socket = createConnection(socketPath);
		let settled = false;
		let bytes = Buffer.alloc(0);
		const fail = (error: Error): void => { if (!settled) { settled = true; socket.destroy(); reject(error); } };
		socket.setTimeout(timeoutMs, () => fail(new Error("console socket timeout")));
		socket.once("error", fail);
		socket.once("connect", () => socket.write(`${JSON.stringify(request)}\n`));
		socket.once("close", () => { if (!settled) fail(new Error("console socket closed before response")); });
		socket.on("data", (chunk: Buffer) => {
			bytes = Buffer.concat([bytes, chunk]);
			if (bytes.length > MAX_FRAME_BYTES) { fail(new Error("console response too large")); return; }
			const end = bytes.indexOf(10);
			if (end < 0) return;
			try {
				const value = JSON.parse(bytes.subarray(0, end).toString("utf8")) as ConsoleResponse;
				if (value.requestId !== request.requestId) throw new Error("console response id mismatch");
				settled = true; socket.end(); resolve(value);
			} catch (error) { fail(error as Error); }
		});
	});
}

export async function sendConsoleRequest(record: ConsoleRecord, input: Omit<ConsoleRequest, "requestId" | "instanceId"> & { requestId?: string }): Promise<ConsoleResponse> {
	return connectConsole(record, { ...input, requestId: input.requestId ?? randomUUID(), instanceId: record.instanceId });
}
