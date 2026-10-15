import { spawn, execFile, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer, type Socket } from "node:net";
import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { parseConsoleRequest, MAX_EVENT_BYTES, MAX_EVENTS, MAX_FRAME_BYTES, type ConsoleEvent, type ConsoleRecord, type ConsoleRequest, type ConsoleResponse } from "./protocol.ts";
import type { PiBootstrap } from "./pi-process.ts";
import { readCurrentProcessIdentity } from "../runtime/process-identity.ts";
import { parseRunDescriptor } from "../runtime/run-descriptor.ts";
import { acquireConsoleWorkspaceOwner } from "./ownership.ts";

const execFileAsync = promisify(execFile);
const commands = new Set(["prompt", "steer", "follow_up", "abort", "get_state"]);
function sanitizeEvent(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sanitizeEvent).filter((item) => item !== undefined);
	if (!value || typeof value !== "object") return value;
	const item = value as Record<string, unknown>;
	if (typeof item.type === "string" && /thinking|reasoning/i.test(item.type)) return undefined;
	const safe: Record<string, unknown> = {};
	for (const [key, child] of Object.entries(item)) {
		if (/thinking|reasoning/i.test(key)) continue;
		const cleaned = sanitizeEvent(child);
		if (cleaned !== undefined) safe[key] = cleaned;
	}
	return safe;
}
export interface ConsoleHostOptions { workspace: string; instanceId: string; socketPath: string; controlDir: string; recordFile: string; prompt?: string; piArgs?: string[]; goalRunId?: string; oldDescriptorFile?: string; recover?: boolean; piCliFile?: string; piEntryFile?: string }
export function boundConsoleRecord(record: ConsoleRecord, descriptor: { goalRunId?: string; attemptId?: string }): ConsoleRecord {
	return record.goalRunId === descriptor.goalRunId && record.attemptId === descriptor.attemptId ? record : { ...record, goalRunId: descriptor.goalRunId, attemptId: descriptor.attemptId };
}

function bounded(value: unknown): unknown {
	const json = JSON.stringify(value);
	return Buffer.byteLength(json) <= MAX_EVENT_BYTES ? value : { type: "truncated", originalBytes: Buffer.byteLength(json), preview: json.slice(0, 4_000) };
}
async function atomicJson(file: string, value: unknown): Promise<void> {
	const temporary = `${file}.${randomUUID()}.tmp`;
	try { await writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 }); await rename(temporary, file); }
	finally { await rm(temporary, { force: true }).catch(() => undefined); }
}
function textFrame(socket: Socket, response: ConsoleResponse): void {
	if (socket.destroyed) return;
	const frame = `${JSON.stringify(response)}\n`;
	socket.end(Buffer.byteLength(frame) <= MAX_FRAME_BYTES ? frame : `${JSON.stringify({ requestId: response.requestId, ok: false, error: "console response exceeds frame limit" })}\n`);
}
function validPiArgs(args: string[]): void {
	if (args.some((arg) => ["--mode", "-e", "--extension", "--cwd"].some((flag) => arg === flag || arg.startsWith(`${flag}=`)))) throw new Error("Pi mode, extension and workspace are fixed by the console host");
}

export async function runConsoleHost(options: ConsoleHostOptions): Promise<void> {
	const workspace = await realpath(options.workspace);
	if (path.resolve(options.controlDir) !== path.join(workspace, ".agent", "console", "instances", options.instanceId)) throw new Error("invalid control directory");
	if (path.resolve(options.recordFile) !== path.join(options.controlDir, "instance.json")) throw new Error("invalid record path");
	if (!/^[a-f0-9-]{36}$/.test(options.instanceId)) throw new Error("invalid instance id");
	if (options.socketPath !== path.join("/tmp", `prsi-console-${process.getuid?.() ?? "user"}-${options.instanceId}`, "rpc.sock")) throw new Error("invalid private socket path");
	if (Boolean(options.goalRunId) !== Boolean(options.recover) || Boolean(options.goalRunId) !== Boolean(options.oldDescriptorFile)) throw new Error("existing goal requires goalRunId, oldDescriptorFile and recover together");
	validPiArgs(options.piArgs ?? []);
	const releaseOwner = await acquireConsoleWorkspaceOwner(workspace, options.instanceId);
	await mkdir(options.controlDir, { recursive: true, mode: 0o700 });
	if (!(await lstat(options.controlDir)).isDirectory()) throw new Error("control directory is not a directory");
	await chmod(options.controlDir, 0o700);
	const socketDirectory = path.dirname(options.socketPath);
	await mkdir(socketDirectory, { recursive: true, mode: 0o700 });
	const socketDirStat = await lstat(socketDirectory);
	if (!socketDirStat.isDirectory() || socketDirStat.uid !== process.getuid?.()) throw new Error("socket directory is not private to this user");
	await chmod(socketDirectory, 0o700);
	const socketStat = await import("node:fs/promises").then((fs) => fs.lstat(options.socketPath).catch(() => undefined));
	if (socketStat) throw new Error("socket path already exists");
	const cliFile = options.piCliFile ?? path.resolve(path.dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))), "bundle/cli.js");
	const extensionFile = path.resolve(import.meta.dirname, "../../extensions/research.ts");
	const bootstrap: PiBootstrap = { cliFile, extensionFile, workspace, controlDir: options.controlDir, instanceId: options.instanceId, piArgs: options.piArgs ?? [], ...(options.goalRunId ? { goalRunId: options.goalRunId } : {}), ...(options.recover ? { recover: true } : {}), ...(options.oldDescriptorFile ? { oldDescriptorFile: options.oldDescriptorFile } : {}) };
	await atomicJson(path.join(options.controlDir, "bootstrap.json"), bootstrap);
	let record: ConsoleRecord = { version: 1, instanceId: options.instanceId, workspace, socketPath: options.socketPath, hostPid: process.pid, hostProcess: await readCurrentProcessIdentity(), descriptorFile: path.join(options.controlDir, "run-descriptor.json"), controlDir: options.controlDir, startedAt: new Date().toISOString(), state: "starting", ...(options.goalRunId ? { goalRunId: options.goalRunId } : {}) };
	await atomicJson(options.recordFile, record);
	const events: ConsoleEvent[] = [];
	const workflowPending = new Set<string>();
	let sequence = 0;
	const addEvent = (value: unknown): void => { const cleaned = sanitizeEvent(value); if (cleaned === undefined) return; events.push({ sequence: ++sequence, at: new Date().toISOString(), value: bounded(cleaned) }); if (events.length > MAX_EVENTS) events.shift(); };
	const pendingPi = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
	const workflowRpc = new Map<string, string>();
	const workflowAcked = new Set<string>();
	const responses = new Map<string, { fingerprint: string; result: Promise<ConsoleResponse> }>();
	let pi: ChildProcessWithoutNullStreams | undefined;
	let piExited = false;
	let rpcBuffer = Buffer.alloc(0);
	let inFlight = 0;
	let exitResolved: (() => void) | undefined;
	const exitPromise = new Promise<void>((resolve) => { exitResolved = resolve; });
	const onRpcLine = (line: string): void => {
		let value: Record<string, unknown>;
		try { value = JSON.parse(line) as Record<string, unknown>; } catch { addEvent({ type: "invalid-pi-frame" }); return; }
		if (value.type === "response" && typeof value.id === "string" && workflowRpc.has(value.id)) {
			const requestId = workflowRpc.get(value.id)!;
			workflowRpc.delete(value.id);
			if (value.success === true) { if (workflowPending.has(requestId)) workflowAcked.add(requestId); addEvent({ type: "workflow-rpc-ack", requestId }); }
			else if (workflowPending.has(requestId)) void failWorkflow(requestId, typeof value.error === "string" ? value.error : "Pi rejected workflow command");
			return;
		}
		if (value.type === "response" && typeof value.id === "string" && pendingPi.has(value.id)) {
			const pending = pendingPi.get(value.id)!; clearTimeout(pending.timer); pendingPi.delete(value.id); pending.resolve(value);
		} else {
			addEvent(value);
			if (value.type === "agent_end") for (const requestId of workflowAcked) setTimeout(() => { void completeMissingWorkflow(requestId); }, 1_000).unref();
		}
	};
	const responsePath = (id: string): string => path.join(options.controlDir, "responses", `${id}.json`);
	const clearWorkflowTracking = (id: string): void => {
		workflowPending.delete(id);
		workflowAcked.delete(id);
		for (const [rpcId, requestId] of workflowRpc) if (requestId === id) workflowRpc.delete(rpcId);
	};
	const failWorkflow = async (id: string, message: string): Promise<void> => {
		try { await writeFile(responsePath(id), `${JSON.stringify({ version: 1, requestId: id, ok: false, error: message })}\n`, { mode: 0o600, flag: "wx" }); }
		catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") addEvent({ type: "workflow-receipt-write-error", requestId: id, message: String(error) }); }
		clearWorkflowTracking(id);
		addEvent({ type: "workflow-result", requestId: id, result: { version: 1, requestId: id, ok: false, error: message } });
	};
	const completeMissingWorkflow = async (id: string): Promise<void> => {
		if (!workflowAcked.has(id) || !workflowPending.has(id)) return;
		try { await lstat(responsePath(id)); } catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") await failWorkflow(id, "Pi turn ended without a workflow controller receipt; action outcome is unknown");
		}
	};
	const readWorkflowResponse = async (id: string): Promise<unknown> => {
		const file = responsePath(id);
		const info = await lstat(file);
		if (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0 || info.size > MAX_FRAME_BYTES) throw new Error("untrusted workflow response file");
		return JSON.parse(await readFile(file, "utf8"));
	};
	const readCancellationReceipt = async (id: string): Promise<{ version: 1; requestId: string; ok: boolean; cancelled: boolean; error?: string }> => {
		const file = path.join(options.controlDir, "responses", `${id}.cancel.json`);
		const info = await lstat(file);
		if (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0 || info.size > 4_096) throw new Error("untrusted workflow cancellation receipt");
		const value = JSON.parse(await readFile(file, "utf8")) as { version?: number; requestId?: string; ok?: boolean; cancelled?: boolean; error?: string };
		if (value.version !== 1 || value.requestId !== id || typeof value.ok !== "boolean" || typeof value.cancelled !== "boolean" || (value.error !== undefined && typeof value.error !== "string")) throw new Error("invalid workflow cancellation receipt");
		return value as { version: 1; requestId: string; ok: boolean; cancelled: boolean; error?: string };
	};
	const workflowScan = setInterval(() => {
		for (const id of workflowPending) void readWorkflowResponse(id).then((result) => {
			clearWorkflowTracking(id);
			addEvent({ type: "workflow-result", requestId: id, result: bounded(result) });
		}).catch(() => undefined);
	}, 500);
	workflowScan.unref();
	const rpc = (type: string, message?: string): Promise<unknown> => {
		if (!pi || (record.state !== "running" && !(record.state === "starting" && type === "get_commands"))) throw new Error("Pi process is not running");
		const id = randomUUID();
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => { pendingPi.delete(id); reject(new Error("Pi RPC response timeout; command outcome is unknown")); }, 30_000);
			pendingPi.set(id, { resolve, reject, timer });
			pi!.stdin.write(`${JSON.stringify({ id, type, ...(message === undefined ? {} : { message }) })}\n`, (error) => { if (error) { clearTimeout(timer); pendingPi.delete(id); reject(error); } });
		});
	};
	const control = async (command: "status" | "pause" | "resume" | "stop"): Promise<unknown> => {
		const script = path.resolve(import.meta.dirname, "../../scripts/workflow-control.ts");
		const { stdout } = await execFileAsync(process.execPath, [script, command, "--descriptor", record.descriptorFile], { timeout: 15_000, maxBuffer: 200_000 });
		return JSON.parse(stdout);
	};
	let recordWrite = Promise.resolve();
	const update = (changes: Partial<ConsoleRecord>): Promise<void> => {
		record = { ...record, ...changes };
		const snapshot = record;
		recordWrite = recordWrite.then(() => atomicJson(options.recordFile, snapshot));
		return recordWrite;
	};
	const checkTarget = async (request: ConsoleRequest): Promise<void> => {
		if (request.instanceId !== record.instanceId) throw new Error("instance mismatch");
		const descriptor = JSON.parse(await readFile(record.descriptorFile, "utf8")) as { goalRunId?: string; attemptId?: string };
		const next = boundConsoleRecord(record, descriptor);
		if (next !== record) await update({ goalRunId: next.goalRunId, attemptId: next.attemptId });
		if (request.goalRunId && request.goalRunId !== record.goalRunId) throw new Error("goal mismatch");
		if (request.attemptId && descriptor.attemptId !== request.attemptId) throw new Error("attempt mismatch");
	};
	const execute = async (request: ConsoleRequest): Promise<ConsoleResponse> => {
		try {
			await checkTarget(request);
			if (request.command === "status") return { requestId: request.requestId, ok: true, data: { record, control: await control("status").catch((error) => ({ unavailable: String(error) })), busy: inFlight > 0 || workflowPending.size > 0, latestEvent: sequence } };
			if (request.command === "events") {
				const selected: ConsoleEvent[] = [];
				let used = 0;
				for (const event of events) {
					if (event.sequence <= (request.since ?? 0)) continue;
					const size = Buffer.byteLength(JSON.stringify(event));
					if (used + size > MAX_FRAME_BYTES - 12_000) break;
					selected.push(event); used += size;
				}
				return { requestId: request.requestId, ok: true, data: { events: selected, nextCursor: selected.at(-1)?.sequence ?? (request.since ?? 0), latestEvent: sequence, oldestEvent: events[0]?.sequence ?? sequence } };
			}
			if (request.command === "workflow_result") {
				const id = request.workflowRequestId;
				if (!id) throw new Error("workflow request id required");
				try { return { requestId: request.requestId, ok: true, data: { complete: true, result: await readWorkflowResponse(id) } }; }
				catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { requestId: request.requestId, ok: true, data: piExited ? { complete: true, result: { version: 1, requestId: id, ok: false, error: "Pi exited before a controller receipt; workflow outcome is unknown" } } : { complete: false } }; throw error; }
			}
			if (["pause", "resume", "stop"].includes(request.command)) {
				const action = request.command as "pause" | "resume" | "stop";
				const result = await control(action);
				if (action === "stop") {
					await Promise.race([exitPromise, new Promise<void>((_, reject) => setTimeout(() => reject(new Error("stop signal sent; Pi exit was not observed")), 10_000))]);
				}
				return { requestId: request.requestId, ok: true, data: { control: result, state: record.state } };
			}
			if ((inFlight > 0 || workflowPending.size > 0) && request.command !== "abort" && request.command !== "get_state") throw new Error("another control request is in progress");
			if (request.command === "abort" && workflowPending.size > 0) {
				const targets = [...workflowPending];
				const receipts: { version: 1; requestId: string; ok: boolean; cancelled: boolean; error?: string }[] = [];
				for (const id of targets) {
					const ackFailure = rpc("prompt", `/workflow-console-cancel ${id}`).then((value) => {
						const response = value as { success?: boolean; error?: string };
						if (response.success !== true) throw new Error(response.error ?? "Pi rejected workflow cancellation command");
						return new Promise<never>(() => undefined);
					});
					const deadline = Date.now() + 10_000;
					const receipt = await Promise.race([ackFailure, (async () => {
						// The command's RPC acknowledgment is not proof that cancellation reached the stage.
						while (Date.now() < deadline) {
							try { return await readCancellationReceipt(id); }
							catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
							await new Promise((resolve) => setTimeout(resolve, 50));
						}
						throw new Error(`workflow cancellation receipt timeout for ${id}; outcome is unknown`);
					})()]);
					receipts.push(receipt);
					addEvent({ type: "workflow-cancellation", requestId: id, receipt });
				}
				const failed = receipts.find((receipt) => !receipt.ok || !receipt.cancelled);
				return failed ? { requestId: request.requestId, ok: false, data: { receipts }, error: failed.error ?? "workflow cancellation was not accepted" } : { requestId: request.requestId, ok: true, accepted: true, data: { receipts, completion: "workflow_result" } };
			}
			if (request.command === "workflow") {
				if (!/^[a-f0-9-]{36}$/.test(request.requestId) || !request.action || typeof request.action.kind !== "string" || !["stage", "status", "checkpoint", "plan", "decision"].includes(request.action.kind)) throw new Error("invalid workflow request");
				const descriptor = JSON.parse(await readFile(record.descriptorFile, "utf8")) as { workspaceId: string; attemptId: string };
				if (request.attemptId !== descriptor.attemptId) throw new Error("workflow requires current attempt");
				const requestDir = path.join(options.controlDir, "requests");
				await mkdir(requestDir, { mode: 0o700, recursive: true });
				const responseDir = path.join(options.controlDir, "responses");
				await mkdir(responseDir, { mode: 0o700, recursive: true });
				await chmod(requestDir, 0o700); await chmod(responseDir, 0o700);
				const file = path.join(requestDir, `${request.requestId}.json`);
				await writeFile(file, `${JSON.stringify({ version: 1, requestId: request.requestId, instanceId: record.instanceId, workspace: record.workspace, workspaceId: descriptor.workspaceId, attemptId: descriptor.attemptId, ...(record.goalRunId ? { goalRunId: record.goalRunId } : {}), action: request.action })}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
				workflowPending.add(request.requestId);
				inFlight++;
				try {
					if (!pi || record.state !== "running") throw new Error("Pi process is not running");
					const rpcId = randomUUID();
					workflowRpc.set(rpcId, request.requestId);
					await new Promise<void>((resolve, reject) => pi!.stdin.write(`${JSON.stringify({ id: rpcId, type: "prompt", message: `/workflow-console ${request.requestId}` })}\n`, (error) => error ? reject(error) : resolve()));
					return { requestId: request.requestId, ok: true, accepted: true, data: { requestId: request.requestId, queued: true, completion: "workflow_result" } };
				} catch (error) { workflowPending.delete(request.requestId); for (const [rpcId, id] of workflowRpc) if (id === request.requestId) workflowRpc.delete(rpcId); throw error;
				} finally { inFlight--; }
			}
			if (request.command === "resume_goal" || request.command === "resume_condition") {
				if (!record.goalRunId || request.goalRunId !== record.goalRunId || !request.attemptId) throw new Error("resume requires the bound goal and attempt");
			}
			if (["prompt", "steer", "follow_up", "resume_goal", "resume_condition"].includes(request.command) && (!request.message?.trim() || request.message.length > 32_000)) throw new Error("message is missing or too long");
			if (request.command === "resume_condition" && (!request.evidencePath || !path.isAbsolute(request.evidencePath))) throw new Error("resume condition requires an absolute evidence path");
			let message = request.message;
			if (request.command === "resume_goal") message = `[[resume-goal:${record.goalRunId}]] ${message}`;
			if (request.command === "resume_condition") message = `[[resume-condition:${record.goalRunId}]] ${JSON.stringify({ evidencePath: request.evidencePath, message })}`;
			const type = request.command === "resume_goal" || request.command === "resume_condition" ? "prompt" : request.command;
			if (!commands.has(type)) throw new Error("unsupported command");
			inFlight++;
			try {
				const result = await rpc(type, message) as { success?: boolean; error?: string };
				return { requestId: request.requestId, ok: result.success === true, accepted: result.success === true, data: result, ...(result.success === true ? {} : { error: result.error ?? "Pi rejected command" }) };
			} finally { inFlight--; }
		} catch (error) { return { requestId: request.requestId, ok: false, error: error instanceof Error ? error.message : String(error) }; }
	};
	const server = createServer((socket) => {
		socket.setTimeout(35_000, () => socket.destroy());
		let buffer = Buffer.alloc(0);
		socket.on("data", (chunk: Buffer) => {
			buffer = Buffer.concat([buffer, chunk]);
			if (buffer.length > MAX_FRAME_BYTES) { socket.destroy(); return; }
			const end = buffer.indexOf(10);
			if (end < 0) return;
			const line = buffer.subarray(0, end).toString("utf8");
			buffer = Buffer.alloc(0);
			let request: ConsoleRequest;
			try { request = parseConsoleRequest(JSON.parse(line)); }
			catch (error) { textFrame(socket, { requestId: "invalid", ok: false, error: String(error) }); return; }
			const fingerprint = JSON.stringify(request);
			let prior = responses.get(request.requestId);
			if (prior && prior.fingerprint !== fingerprint) { textFrame(socket, { requestId: request.requestId, ok: false, error: "requestId reused with different content" }); return; }
			if (!prior) {
				prior = { fingerprint, result: execute(request) };
				responses.set(request.requestId, prior);
				if (responses.size > 512) responses.delete(responses.keys().next().value!);
			}
			void prior.result.then((value) => textFrame(socket, value));
		});
	});
	await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(options.socketPath, resolve); });
	await chmod(options.socketPath, 0o600);
	let finalizing = false;
	const finalize = (): void => {
		if (finalizing) return;
		finalizing = true;
		void (async () => {
			server.close();
			clearInterval(workflowScan);
			await rm(options.socketPath, { force: true }).catch(() => undefined);
			if (piExited) await releaseOwner();
		})().catch(() => undefined);
	};
	try {
		pi = spawn(process.execPath, [options.piEntryFile ?? path.resolve(import.meta.dirname, "pi-process.ts"), path.join(options.controlDir, "bootstrap.json")], { cwd: workspace, detached: true, stdio: ["pipe", "pipe", "pipe"] });
		pi.stdout.on("data", (chunk: Buffer) => {
			rpcBuffer = Buffer.concat([rpcBuffer, chunk]);
			let end: number;
			while ((end = rpcBuffer.indexOf(10)) >= 0) {
				if (end > MAX_FRAME_BYTES) addEvent({ type: "oversize-pi-frame" });
				else onRpcLine(rpcBuffer.subarray(0, end).toString("utf8"));
				rpcBuffer = rpcBuffer.subarray(end + 1);
			}
			if (rpcBuffer.length > MAX_FRAME_BYTES) { addEvent({ type: "oversize-pi-frame" }); rpcBuffer = Buffer.alloc(0); }
		});
		pi.stderr.on("data", (chunk: Buffer) => { addEvent({ type: "pi-stderr", text: chunk.toString("utf8").slice(0, 4_000) }); });
		pi.on("error", (error) => {
			addEvent({ type: "pi-error", message: error.message });
			void update({ state: "error", error: error.message });
			if (!pi?.pid) { piExited = true; exitResolved?.(); setTimeout(finalize, 100).unref(); }
		});
		pi.on("exit", (code, signal) => {
			piExited = true;
			for (const pending of pendingPi.values()) { clearTimeout(pending.timer); pending.reject(new Error("Pi exited before RPC response")); }
			pendingPi.clear();
			addEvent({ type: "pi-exit", code, signal });
			void update({ state: record.state === "error" ? "error" : "exited", exitCode: code, exitSignal: signal }).catch((error) => addEvent({ type: "record-error", message: String(error) })).finally(() => setTimeout(finalize, 1_500));
			exitResolved?.();
		});
		await update({ piPid: pi.pid });
		let descriptorReady = false;
		for (let i = 0; i < 100 && !piExited; i++) { try { await readFile(record.descriptorFile); descriptorReady = true; break; } catch { await new Promise((resolve) => setTimeout(resolve, 50)); } }
		if (!descriptorReady || piExited) throw new Error("Pi process exited before its trusted descriptor was ready");
		const initialDescriptor = parseRunDescriptor(JSON.parse(await readFile(record.descriptorFile, "utf8")));
		if (initialDescriptor.instanceId !== record.instanceId || initialDescriptor.controlDir !== record.controlDir || initialDescriptor.process.pid !== pi.pid) throw new Error("Pi trusted descriptor does not match this console instance");
		const commands = await rpc("get_commands") as { success?: boolean; data?: { commands?: { name?: string; source?: string }[] } };
		if (commands.success !== true || !["workflow-console", "workflow-console-cancel"].every((name) => commands.data?.commands?.some((item) => item.name === name && item.source === "extension"))) throw new Error("Pi workflow-console bridge did not register");
		await update({ state: "running", goalRunId: initialDescriptor.goalRunId, attemptId: initialDescriptor.attemptId });
		if (options.prompt) {
			try {
				const response = await rpc("prompt", options.prompt) as { success?: boolean; error?: string };
				if (response.success === true) addEvent({ type: "initial-prompt-ack", response });
				else addEvent({ type: "initial-prompt-error", message: response.error ?? "Pi rejected initial prompt", response });
			}
			catch (error) { addEvent({ type: "initial-prompt-error", message: String(error) }); }
		}
	} catch (error) {
		await update({ state: "error", error: String(error) });
		if (pi?.pid && !piExited) { try { process.kill(-pi.pid, "SIGTERM"); } catch {} }
		await Promise.race([exitPromise, new Promise<void>((resolve) => setTimeout(resolve, 3_000))]);
		finalize();
		throw error;
	}
	let shuttingDown = false;
	const shutdown = (): void => {
		if (shuttingDown) return;
		shuttingDown = true;
		void (async () => {
			if (record.state === "running") await control("stop").catch(() => undefined);
			await Promise.race([exitPromise, new Promise<void>((resolve) => setTimeout(resolve, 5_000))]);
			finalize();
		})().catch(() => undefined);
	};
	process.on("SIGTERM", shutdown);
	process.on("SIGINT", shutdown);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const config = JSON.parse(await readFile(process.argv[2], "utf8")) as ConsoleHostOptions;
	await runConsoleHost(config).catch((error) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
}
