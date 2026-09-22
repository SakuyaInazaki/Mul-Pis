import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

type ControlState = "running" | "paused" | "stopping" | "stopped" | "unknown";

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const command = process.argv[2] ?? "status";
const pidFile = argValue("--pid-file");
const stateFile = argValue("--state-file");

function requirePidFile(): string {
  if (pidFile === undefined || pidFile.length === 0) {
    throw new Error("缺少 --pid-file；请指向当前工作流主进程的 run.pid");
  }
  return path.resolve(pidFile);
}

async function readPid(): Promise<number> {
  const text = await readFile(requirePidFile(), "utf8");
  const pid = Number.parseInt(text.trim(), 10);
  if (Number.isInteger(pid) === false || pid <= 0) {
    throw new Error("run.pid 内容不是有效的正整数 PID");
  }
  return pid;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function resolveStateFile(): string {
  return path.resolve(stateFile ?? path.join(path.dirname(requirePidFile()), "control.json"));
}

async function readState(): Promise<Record<string, unknown>> {
  try {
    return JSON.parse(await readFile(resolveStateFile(), "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

async function writeState(state: ControlState, pid: number, reason?: string): Promise<void> {
  const payload = { state, pid, updatedAt: new Date().toISOString(), ...(reason ? { reason } : {}) };
  await writeFile(resolveStateFile(), JSON.stringify(payload, null, 2) + "\n", "utf8");
}

async function main(): Promise<void> {
  const pid = await readPid();
  const alive = isAlive(pid);
  if (command === "status") {
    const state = await readState();
    console.log(JSON.stringify({ command, pid, alive, ...state }, null, 2));
    return;
  }
  if (alive === false) {
    await writeState("stopped", pid, "process not alive");
    throw new Error(`进程 ${pid} 不存在，不能执行 ${command}`);
  }
  if (process.platform === "win32") {
    throw new Error("当前平台不支持 SIGSTOP/SIGCONT/SIGTERM 工作流控制");
  }
  if (command === "pause") {
    process.kill(pid, "SIGSTOP");
    await writeState("paused", pid, "operator pause");
    console.log(JSON.stringify({ command, pid, state: "paused" }, null, 2));
    return;
  }
  if (command === "resume") {
    process.kill(pid, "SIGCONT");
    await writeState("running", pid, "operator resume");
    console.log(JSON.stringify({ command, pid, state: "running" }, null, 2));
    return;
  }
  if (command === "stop") {
    process.kill(pid, "SIGTERM");
    await writeState("stopping", pid, "operator stop");
    console.log(JSON.stringify({ command, pid, state: "stopping" }, null, 2));
    return;
  }
  throw new Error(`未知命令 ${command}；支持 status|pause|resume|stop`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
