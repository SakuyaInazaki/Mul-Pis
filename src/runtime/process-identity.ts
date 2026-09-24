import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
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

async function startToken(pid: number): Promise<string> {
	if (process.platform === "linux") {
		const stat = await readFile(`/proc/${pid}/stat`, "utf8");
		const tail = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
		const token = tail[19]; // field 22, after pid and comm
		if (!token || !/^\d+$/.test(token)) throw new Error("process start tick unavailable");
		return token;
	}
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
		const currentStart = await startToken(identity.pid);
		if (currentStart !== identity.processStartToken) return { status: "unknown", identityMatch: false, reason: "pid reused or identity changed" };
		return { status: "alive", identityMatch: true, reason: "identity verified" };
	} catch { return { status: "unknown", identityMatch: false, reason: "start token unavailable" }; }
}
