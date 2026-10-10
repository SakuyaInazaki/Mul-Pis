import { execFile } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import os from "node:os";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** A PID is usable only together with its host, boot and observed birth token. */
export interface ProcessIdentityV1 {
	hostId: string;
	bootId: string;
	pid: number;
	processStartToken: string;
}

export interface ProcessProbe {
	status: "alive" | "dead" | "unknown";
	identityMatch: boolean;
	reason: string;
}

async function bootId(): Promise<string> {
	if (process.platform === "linux") return (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
	if (process.platform === "darwin") {
		const { stdout } = await execFileAsync("sysctl", ["-n", "kern.boottime"], { timeout: 2_000 });
		return stdout.trim();
	}
	throw new Error("boot identity is unavailable on this platform");
}

function parseLinuxStat(stat: string, pid: number): { state: string; startToken: string } {
	const close = stat.lastIndexOf(")");
	if (!stat.startsWith(`${pid} (`) || close < 0 || stat[close + 1] !== " ") {
		throw new Error("process stat unavailable");
	}
	const tail = stat.slice(close + 2).trim().split(/\s+/);
	const state = tail[0]; // field 3
	const startToken = tail[19]; // field 22
	if (!state || !/^[A-Za-z]$/.test(state) || !startToken || !/^\d+$/.test(startToken)) {
		throw new Error("process state or start tick unavailable");
	}
	return { state, startToken };
}

async function linuxStat(pid: number, taskDir?: string): Promise<{ state: string; startToken: string }> {
	return parseLinuxStat(await readFile(taskDir ? `${taskDir}/${pid}/stat` : `/proc/${pid}/stat`, "utf8"), pid);
}

async function startToken(pid: number): Promise<string> {
	if (process.platform === "linux") return (await linuxStat(pid)).startToken;
	if (process.platform === "darwin") {
		// libproc's proc_bsdinfo has microsecond birth fields. `ps lstart` only has
		// second resolution and is insufficient for a PID-reuse control decision.
		const code = `import ctypes,struct,sys\nlib=ctypes.CDLL('/usr/lib/libproc.dylib')\nlib.proc_pidinfo.argtypes=[ctypes.c_int,ctypes.c_int,ctypes.c_uint64,ctypes.c_void_p,ctypes.c_int]\nb=ctypes.create_string_buffer(136)\nn=lib.proc_pidinfo(int(sys.argv[1]),3,0,b,136)\nif n!=136 or struct.unpack_from('=I',b.raw,12)[0]!=int(sys.argv[1]): sys.exit(2)\ns,u=struct.unpack_from('=QQ',b.raw,120)\nif s<=0 or u>=1000000: sys.exit(3)\nprint(f'{s}:{u}')`;
		const { stdout } = await execFileAsync("python3", ["-c", code, String(pid)], { timeout: 2_000 });
		const token = stdout.trim();
		if (!/^\d+:\d+$/.test(token)) throw new Error("precise process start unavailable");
		return token;
	}
	throw new Error("process start identity unavailable on this platform");
}

/** A zombie group leader can still have live threads. Any incomplete scan is unknown. */
async function linuxZombieGroupState(pid: number, start: string): Promise<"dead" | "alive" | "unknown"> {
	const taskDir = `/proc/${pid}/task`;
	const first = (await readdir(taskDir)).sort();
	if (!first.includes(String(pid)) || first.some(tid => !/^\d+$/.test(tid))) return "unknown";
	const states = await Promise.all(first.map(async tid => {
		const stat = await linuxStat(Number(tid), taskDir);
		return { tid, ...stat };
	}));
	if (states.find(item => item.tid === String(pid))?.startToken !== start) return "unknown";
	const second = (await readdir(taskDir)).sort();
	if (first.length !== second.length || first.some((tid, index) => tid !== second[index])) return "unknown";
	// Recheck the leader after enumeration, so PID reuse during the scan cannot
	// turn a different process's task list into evidence about this owner.
	if ((await linuxStat(pid)).startToken !== start) return "unknown";
	return states.every(item => item.state === "Z" || item.state === "X" || item.state === "x")
		? "dead" : "alive";
}

export async function readCurrentProcessIdentity(pid = process.pid): Promise<ProcessIdentityV1> {
	if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("invalid process pid");
	const [boot, birth] = await Promise.all([bootId(), startToken(pid)]);
	if (!boot || !birth) throw new Error("process identity unavailable");
	return { hostId: os.hostname(), bootId: boot, pid, processStartToken: birth };
}

/** Unknown includes reused PIDs, remote hosts, insufficient permissions and probe failures. */
export async function probeProcessIdentity(identity: ProcessIdentityV1): Promise<ProcessProbe> {
	if (!identity || !Number.isSafeInteger(identity.pid) || identity.pid <= 0 || !identity.hostId || !identity.bootId || !identity.processStartToken) {
		return { status: "unknown", identityMatch: false, reason: "invalid identity" };
	}
	if (identity.hostId !== os.hostname()) return { status: "unknown", identityMatch: false, reason: "other host" };
	let currentBoot: string;
	try { currentBoot = await bootId(); }
	catch { return { status: "unknown", identityMatch: false, reason: "boot identity unavailable" }; }
	if (identity.bootId !== currentBoot) return { status: "dead", identityMatch: false, reason: "other boot" };
	try { process.kill(identity.pid, 0); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ESRCH") return { status: "dead", identityMatch: false, reason: "process absent" };
		return { status: "unknown", identityMatch: false, reason: "liveness unavailable" };
	}
	try {
		const observed = process.platform === "linux" ? await linuxStat(identity.pid) : null;
		const currentStart = observed?.startToken ?? await startToken(identity.pid);
		if (currentStart !== identity.processStartToken) return { status: "unknown", identityMatch: false, reason: "pid reused or identity changed" };
		if (observed?.state === "Z") {
			const group = await linuxZombieGroupState(identity.pid, currentStart);
			if (group === "unknown") return { status: "unknown", identityMatch: false, reason: "thread state unavailable" };
			if (group === "dead") return { status: "dead", identityMatch: false, reason: "process zombie" };
		}
		return { status: "alive", identityMatch: true, reason: "identity verified" };
	} catch { return { status: "unknown", identityMatch: false, reason: "start token unavailable" }; }
}
