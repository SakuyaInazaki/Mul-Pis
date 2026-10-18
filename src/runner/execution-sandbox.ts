/** macOS write boundary for model-facing execution tools; host tools stay outside it. */
import { spawn } from "node:child_process";
import { lstat, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { HarnessError } from "../types.ts";

const sandboxExecutable = "/usr/bin/sandbox-exec";
const inside = (root: string, file: string) => file === root || file.startsWith(root + path.sep);
const quote = (value: string) => JSON.stringify(value);

async function canonicalPath(requested: string): Promise<string> {
	let ancestor = path.resolve(requested);
	const missing: string[] = [];
	for (;;) {
		try { await lstat(ancestor); break; }
		catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			const parent = path.dirname(ancestor);
			if (parent === ancestor) throw new HarnessError("runner.sandbox-path", "execution path has no existing ancestor");
			missing.unshift(path.basename(ancestor)); ancestor = parent;
		}
	}
	return path.resolve(await realpath(ancestor), ...missing);
}

/** A hard link inside a writable root can mutate a host file outside it by inode.
 * Deny new links and reject inherited links except beneath independently denied paths. */
async function assertNoHardLinks(root: string, protectedPaths: readonly string[]): Promise<void> {
	for (const entry of await readdir(root, { withFileTypes: true })) {
		const file = path.join(root, entry.name);
		if (protectedPaths.some(protectedPath => inside(protectedPath, file))) continue;
		const info = await lstat(file);
		if (info.isSymbolicLink()) continue;
		if (info.isDirectory()) await assertNoHardLinks(file, protectedPaths);
		else if (info.isFile() && info.nlink > 1)
			throw new HarnessError("runner.sandbox", "writable sandbox root contains a hard-linked file");
	}
}

// Only a fixed host program receives mutations. The sandbox, not a pathname
// precheck in the unsandboxed Pi process, enforces the final write boundary.
const mutationProgram = `
import { mkdir, writeFile } from "node:fs/promises";
let input = "";
for await (const part of process.stdin) input += part;
const request = JSON.parse(input);
if (request.kind === "mkdir") await mkdir(request.target, { recursive: true });
else if (request.kind === "write" && typeof request.content === "string")
  await writeFile(request.target, request.content, "utf8");
else throw new Error("invalid confined mutation");
`;

async function runSandbox(profile: string, executable: string, args: string[], cwd: string,
	input?: string): Promise<void> {
	const child = spawn(sandboxExecutable, ["-p", profile, executable, ...args], {
		cwd, env: { PATH: "/usr/bin:/bin", HOME: cwd, TMPDIR: cwd, LANG: "C.UTF-8" },
		stdio: ["pipe", "ignore", "pipe"],
	});
	let diagnostic = "";
	child.stderr.on("data", bytes => { if (diagnostic.length < 1000) diagnostic += String(bytes).slice(0, 1000 - diagnostic.length); });
	child.stdin.on("error", () => undefined);
	const completion = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
		child.once("error", reject);
		child.once("close", (code, signal) => resolve({ code, signal }));
	});
	child.stdin.end(input);
	const result = await completion;
	if (result.code !== 0 || result.signal)
		throw new HarnessError("runner.sandbox", `confined execution failed (${result.signal ?? result.code}): ${diagnostic.slice(0, 240)}`);
}

export interface ExecutionSandbox {
	profile: string;
	/** Canonicalize existing aliases and reject paths outside task work/scratch. */
	file(requested: string, mode: "read" | "write" | "edit" | "mkdir"): Promise<string>;
	mkdir(directory: string): Promise<void>;
	writeFile(file: string, content: string): Promise<void>;
}

/** Stage backends may allow only their fresh output directory, keeping source and journal read-only. */
export async function createMacOSWriteSandboxProfile(input: {
	writableRoots: string[]; protectedPaths?: string[]; cwd: string;
	/** Measurement and correctness runs are offline by contract: a candidate
	 * that can reach the network can fetch a result instead of computing one. */
	denyNetwork?: boolean;
}): Promise<string | undefined> {
	if (process.platform !== "darwin") return undefined;
	if (!input.writableRoots.length) throw new HarnessError("runner.sandbox", "write sandbox needs an allowed directory");
	const protectedPaths = await Promise.all((input.protectedPaths ?? []).map(canonicalPath));
	const roots = await Promise.all(input.writableRoots.map(async root => {
		const resolved = await realpath(root);
		if (!(await lstat(resolved)).isDirectory()) throw new HarnessError("runner.sandbox", "sandbox write root must be a directory");
		await assertNoHardLinks(resolved, protectedPaths);
		return resolved;
	}));
	const profile = `(version 1)\n(allow default)\n(deny signal)\n(deny file-link)\n(deny file-write*)\n` +
		(input.denyNetwork ? `(deny network*)\n` : "") +
		`(allow file-write* ${roots.map(root => `(subpath ${quote(root)})`).join(" ")})\n` +
		`(allow file-write-data (literal "/dev/null"))\n` +
		protectedPaths.map(root => `(deny file-write* (subpath ${quote(root)}))`).join("\n");
	// Fail closed on this host if sandbox-exec is missing or rejects the profile.
	await runSandbox(profile, "/usr/bin/true", [], input.cwd);
	return profile;
}

/** The macOS profile is created per new session. Other platforms retain their existing runner path. */
export async function createExecutionSandbox(work: string, scratch?: string): Promise<ExecutionSandbox | undefined> {
	if (process.platform !== "darwin") return undefined;
	const roots = await Promise.all([work, ...(scratch ? [scratch] : [])].map(root => realpath(root)));
	const protectedPaths = await Promise.all([path.join(work, "inputs"), path.join(work, ".candidate-runs")].map(canonicalPath));
	const profile = (await createMacOSWriteSandboxProfile({ writableRoots: roots, protectedPaths, cwd: work }))!;

	async function file(requested: string, mode: "read" | "write" | "edit" | "mkdir"): Promise<string> {
		if (typeof requested !== "string" || !requested || requested.includes("\0") || requested.startsWith("~"))
			throw new HarnessError("runner.sandbox-path", "execution tool requires a task-local file path");
		const absolute = path.isAbsolute(requested) ? path.resolve(requested) : path.resolve(work, requested);
		const canonical = await canonicalPath(absolute);
		const exists = await lstat(absolute).then(() => true, error => {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
			throw error;
		});
		if (!roots.some(root => inside(root, canonical)) || mode !== "read" && protectedPaths.some(root => inside(root, canonical)))
			throw new HarnessError("runner.sandbox-path", "execution tool path is outside its permitted task area");
		if (mode === "read" || mode === "edit") {
			const info = await lstat(absolute);
			if (!info.isFile() || info.isSymbolicLink())
				throw new HarnessError("runner.sandbox-path", "execution tool target must be a regular file");
		} else if (mode === "write" && exists) {
			const info = await lstat(absolute);
			if (info.isSymbolicLink() || !info.isFile() || info.nlink > 1)
				throw new HarnessError("runner.sandbox-path", "execution write target must be a regular file or absent");
		} else if (mode === "mkdir" && exists && !(await lstat(absolute)).isDirectory())
			throw new HarnessError("runner.sandbox-path", "execution directory target must be a directory or absent");
		return canonical;
	}

	async function mutate(kind: "mkdir" | "write", target: string, content?: string): Promise<void> {
		const validated = await file(target, kind === "mkdir" ? "mkdir" : "write");
		await runSandbox(profile, process.execPath, ["--input-type=module", "-e", mutationProgram], work,
			JSON.stringify({ kind, target: validated, ...(content !== undefined ? { content } : {}) }));
	}
	return { profile, file, mkdir: directory => mutate("mkdir", directory),
		writeFile: (target, content) => mutate("write", target, content) };
}
