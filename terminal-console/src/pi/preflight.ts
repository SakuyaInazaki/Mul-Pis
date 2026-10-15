import { execFile } from "node:child_process";
import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { nowIso, writeFileAtomic } from "../workspace.ts";

const execFileAsync = promisify(execFile);

export interface PreflightCheck {
    name: string;
    status: "available" | "unavailable" | "unknown";
    detail: string;
}

export async function runResearchPreflight(workspaceRoot: string, options: { execFile?: typeof execFileAsync } = {}): Promise<{
    version: 1;
    at: string;
    workspace: string;
    checks: PreflightCheck[];
    reportPath: string;
}> {
    const exec = options.execFile ?? execFileAsync;
    const command = async (name: string, args: string[]): Promise<PreflightCheck> => {
        try {
            const result = await exec(name, args, { timeout: 5_000, maxBuffer: 200_000 });
            return { name, status: "available", detail: String(result.stdout).trim().slice(0, 1000) };
        } catch (error) {
            return { name, status: "unavailable", detail: (error as Error).message.slice(0, 500) };
        }
    };
    const checks: PreflightCheck[] = [];
    checks.push(await command("node", ["--version"]));
    checks.push(await command("python3", ["--version"]));
    checks.push(await command("nvcc", ["--version"]));
    checks.push(await command("nvidia-smi", ["-L"]));
    checks.push(await command("git", ["--version"]));
    const platformDir = path.join(workspaceRoot, "platform");
    try {
        const info = await stat(platformDir);
        checks.push({ name: "platform-material", status: info.isDirectory() ? "available" : "unavailable", detail: platformDir + " (presence only; channel not verified)" });
    } catch {
        checks.push({ name: "platform-material", status: "unavailable", detail: platformDir });
    }
    checks.push({ name: "platform-channel", status: "unknown", detail: "not probed by local preflight" });
    const at = nowIso();
    const dir = path.join(workspaceRoot, ".agent", "preflight");
    await mkdir(dir, { recursive: true });
    const report = { version: 1 as const, at, workspace: workspaceRoot, checks };
    const reportPath = path.join(dir, "latest.json");
    await writeFileAtomic(reportPath, JSON.stringify({ ...report, reportPath }, null, 2) + "\n");
    return { ...report, reportPath };
}
