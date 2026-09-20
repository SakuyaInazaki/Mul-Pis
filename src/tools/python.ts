/** Run the Python adapter scripts (Crawl4AI, browser-use) from the local venv. */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ToolsConfig } from "../types.ts";

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export function pythonScriptsDir(): string {
	return path.join(REPO_ROOT, "tools", "py");
}

/** Path to the venv interpreter, or undefined when the Python tool stack is not installed. */
export function venvPython(tools: ToolsConfig): string | undefined {
	const venv = tools.pythonVenv ? path.resolve(tools.pythonVenv) : path.join(REPO_ROOT, ".venv");
	const candidate = path.join(venv, "bin", "python");
	return existsSync(candidate) ? candidate : undefined;
}

export interface ScriptRun {
	code: number | null;
	stdout: string;
	stderr: string;
	/** Parsed JSON from the last non-empty stdout line, when present. */
	json?: Record<string, unknown>;
	timedOut: boolean;
}

export function runScript(python: string, script: string, args: string[], options: { cwd?: string; timeoutMs?: number; env?: Record<string, string> } = {}): Promise<ScriptRun> {
	return new Promise((resolve) => {
		const child = spawn(python, ["-I", script, ...args], { cwd: options.cwd ?? REPO_ROOT, env: { ...process.env, ...(options.env ?? {}) }, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGTERM");
			setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
		}, options.timeoutMs ?? 300_000);
		child.stdout.on("data", (chunk) => (stdout += String(chunk)));
		child.stderr.on("data", (chunk) => (stderr += String(chunk)));
		child.on("error", (error) => {
			clearTimeout(timer);
			resolve({ code: null, stdout, stderr: `${stderr}\n${error.message}`, timedOut });
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			let json: Record<string, unknown> | undefined;
			const lines = stdout.split(/\r?\n/).filter((l) => l.trim());
			for (let i = lines.length - 1; i >= 0; i--) {
				try {
					const parsed = JSON.parse(lines[i]);
					if (parsed && typeof parsed === "object") {
						json = parsed as Record<string, unknown>;
						break;
					}
				} catch {
					/* not JSON, keep looking */
				}
			}
			resolve({ code, stdout, stderr, json, timedOut });
		});
	});
}
