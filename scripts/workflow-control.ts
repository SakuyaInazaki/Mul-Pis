import { execFile } from "node:child_process";
import { open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { promisify } from "node:util";
import { parseRunDescriptor, type TrustedControlStateV1 } from "../src/runtime/run-descriptor.ts";
import { probeProcessIdentity } from "../src/runtime/process-identity.ts";

const execFileAsync = promisify(execFile);
const command = process.argv[2] ?? "status";
function argValue(name: string): string | undefined { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1]; }
const pidFile = argValue("--pid-file");
const descriptorFile = argValue("--descriptor") ?? (pidFile ? path.join(path.dirname(path.resolve(pidFile)), "run-descriptor.json") : undefined);
const stateFile = argValue("--state-file") ?? (descriptorFile ? path.join(path.dirname(path.resolve(descriptorFile)), "control.json") : undefined);

async function readState(): Promise<Record<string, unknown>> {
	if (!stateFile) return {};
	try { const value = JSON.parse(await readFile(stateFile, "utf8")); return value && typeof value === "object" ? value : {}; }
	catch { return {}; }
}

async function observedGroup(pid: number): Promise<number | undefined> {
	try { const { stdout } = await execFileAsync("ps", ["-p", String(pid), "-o", "pgid="], { timeout: 2_000 }); const n = Number(stdout.trim()); return Number.isSafeInteger(n) && n > 0 ? n : undefined; }
	catch { return undefined; }
}

async function observedGroupMembers(pgid: number | undefined): Promise<{ status: "observed" | "unknown"; pids: number[]; reason?: string }> {
	if (!pgid) return { status: "unknown", pids: [], reason: "group id unavailable" };
	try {
		const { stdout } = await execFileAsync("ps", ["-axo", "pid=,pgid="], { timeout: 2_000, maxBuffer: 2_000_000 });
		const pids = stdout.split("\n").map((line) => line.trim().split(/\s+/).map(Number)).filter(([pid, group]) => Number.isSafeInteger(pid) && group === pgid).map(([pid]) => pid).slice(0, 32);
		return { status: "observed", pids };
	} catch { return { status: "unknown", pids: [], reason: "group scan unavailable" }; }
}

async function acquireControlLock(directory: string): Promise<() => Promise<void>> {
	const file = path.join(directory, ".control.lock");
	const handle = await open(file, "wx", 0o600);
	const identity = await handle.stat();
	await handle.writeFile(JSON.stringify({ pid: process.pid, at: new Date().toISOString() }) + "\n");
	await handle.sync();
	return async () => {
		await handle.close();
		try { const current = await stat(file); if (current.dev === identity.dev && current.ino === identity.ino) await unlink(file); }
		catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
	};
}

async function main(): Promise<void> {
	if (!descriptorFile || !stateFile) throw new Error("请提供 --descriptor <run-descriptor.json> 或 --pid-file <run.pid>");
	const release = command === "status" ? async () => {} : await acquireControlLock(path.dirname(path.resolve(descriptorFile)));
	try {
	let descriptor;
	try { descriptor = parseRunDescriptor(JSON.parse(await readFile(descriptorFile, "utf8"))); }
	catch (error) {
		if (command === "status") { console.log(JSON.stringify({ command, storedDeclaration: await readState(), liveObservation: { status: "unknown", reason: "descriptor unavailable" }, identityMatch: false }, null, 2)); return; }
		throw new Error(`运行身份不可用，拒绝控制：${(error as Error).message}`);
	}
	if (path.resolve(descriptor.controlDir) !== path.dirname(path.resolve(descriptorFile))) throw new Error("运行控制目录与描述符不匹配");
	if (path.resolve(stateFile) !== path.join(path.resolve(descriptor.controlDir), "control.json")) throw new Error("控制状态路径与描述符不匹配");
	const storedDeclaration = await readState();
	let pidFileMatch: boolean | undefined;
	if (pidFile) {
		try { pidFileMatch = Number((await readFile(path.resolve(pidFile), "utf8")).trim()) === descriptor.process.pid; }
		catch { pidFileMatch = false; }
	}
	const probe = await probeProcessIdentity(descriptor.process);
	const group = await observedGroup(descriptor.process.pid);
	const members = await observedGroupMembers(descriptor.processGroupId);
	const liveObservation = { ...probe, pid: descriptor.process.pid, processGroupId: group, registeredGroupId: descriptor.processGroupId, groupMembers: members,
		groupState: probe.status === "alive" && probe.identityMatch ? "leader-verified" : members.status === "unknown" ? "unknown" : members.pids.length ? "members-observed-identity-unknown" : probe.status === "dead" ? "no-members-observed" : "unknown" };
	if (command === "status") {
		console.log(JSON.stringify({ command, instanceId: descriptor.instanceId, storedDeclaration, liveObservation, identityMatch: probe.identityMatch && pidFileMatch !== false, ...(pidFile ? { pidFileMatch } : {}) }, null, 2));
		return;
	}
	if (!["pause", "resume", "stop"].includes(command)) throw new Error("支持 status|pause|resume|stop");
	if (process.platform === "win32") throw new Error("当前平台不支持进程组信号控制");
	if (probe.status !== "alive" || !probe.identityMatch) throw new Error(`运行身份未验证，拒绝 ${command}：${probe.reason}`);
	if (pidFileMatch === false) throw new Error("run.pid 与运行描述符不匹配");
	if (!descriptor.processGroupId || descriptor.processGroupId !== descriptor.process.pid || group !== descriptor.processGroupId) throw new Error("独立进程组身份未验证，拒绝控制");
	if (storedDeclaration.version !== 1 || storedDeclaration.instanceId !== descriptor.instanceId) throw new Error("可信控制状态缺失或属于另一个实例");
	const now = Date.now();
	const totalPausedMs = Number.isSafeInteger(storedDeclaration.totalPausedMs) && (storedDeclaration.totalPausedMs as number) >= 0 ? storedDeclaration.totalPausedMs as number : 0;
	const previous = storedDeclaration.state;
	if (command === "pause" && previous !== "running") throw new Error("只有运行中的实例可以暂停");
	if (command === "resume" && previous !== "paused") throw new Error("实例没有可信暂停记录");
	if (command === "resume" && (!Number.isSafeInteger(storedDeclaration.pauseStartedAt) || (storedDeclaration.pauseStartedAt as number) > now)) throw new Error("可信暂停起点缺失");
	const write = async (state: TrustedControlStateV1["state"], paused: number, pauseStartedAt?: number): Promise<void> => {
		const value: TrustedControlStateV1 = { version: 1, instanceId: descriptor.instanceId, state, updatedAt: new Date().toISOString(), totalPausedMs: paused, ...(pauseStartedAt === undefined ? {} : { pauseStartedAt }) };
		const temporary = `${stateFile}.${randomUUID()}.tmp`;
		try { await writeFile(temporary, JSON.stringify(value) + "\n", { encoding: "utf8", flag: "wx" }); await rename(temporary, stateFile); }
		finally { await unlink(temporary).catch(() => undefined); }
	};
	const second = await probeProcessIdentity(descriptor.process);
	if (second.status !== "alive" || !second.identityMatch || await observedGroup(descriptor.process.pid) !== descriptor.processGroupId) throw new Error("运行身份在控制前变化");
	if (command === "pause") {
		await write("paused", totalPausedMs, now);
		try { process.kill(-descriptor.processGroupId, "SIGSTOP"); }
		catch (error) { await write("running", totalPausedMs); throw error; }
	}
	if (command === "resume") {
		process.kill(-descriptor.processGroupId, "SIGCONT");
		try { await write("running", totalPausedMs + Math.max(0, now - Number(storedDeclaration.pauseStartedAt))); }
		catch (error) { try { process.kill(-descriptor.processGroupId, "SIGSTOP"); } catch {} throw error; }
	}
	if (command === "stop") {
		await write("stopping", totalPausedMs);
		try { process.kill(-descriptor.processGroupId, "SIGTERM"); if (previous === "paused") process.kill(-descriptor.processGroupId, "SIGCONT"); }
		catch (error) { await write(previous === "paused" ? "paused" : "running", totalPausedMs, previous === "paused" ? Number(storedDeclaration.pauseStartedAt) : undefined); throw error; }
	}
	console.log(JSON.stringify({ command, instanceId: descriptor.instanceId, liveObservation: { status: "alive", identityMatch: true } }));
	} finally { await release(); }
}

main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
