/** Resolve the actual research source before a console-owned Pi process starts. */
import { execFile } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { GenerationStore } from "../../../src/improvement/generation.ts";
import { verifyActiveWorkflowSourceForLaunch } from "../../../src/improvement/research-service.ts";
import { resolveRoleModel } from "../../../src/config.ts";
import { Workspace } from "../../../src/workspace.ts";

const execFileAsync = promisify(execFile);
const repository = path.resolve(fileURLToPath(new URL("../../../", import.meta.url)));

export interface ConsoleSource {
	mode: "active-prepared" | "builtin";
	root: string;
	revision: string;
	versionId?: string;
	dirty?: boolean;
}

export async function resolveConsoleHostExtension(source: ConsoleSource, requested?: string): Promise<string> {
	const file = await realpath(requested ? path.resolve(requested) : path.join(source.root, "extensions", "research.ts"));
	if (!(await stat(file)).isFile()) throw new Error("host extension entry is not a file");
	if (source.mode === "active-prepared") {
		const relative = path.relative(source.root, file);
		if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) ||
			!["src", "extensions", "workflow", "tools"].includes(relative.split(path.sep)[0]))
			throw new Error("prepared host extension entry must be inside a verified source directory");
	}
	return file;
}

export function assertRecoverableConsoleHostExtension(source: ConsoleSource, file: string): void {
	if (source.mode !== "builtin") return;
	const relative = path.relative(source.root, file);
	if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) ||
		!["src", "extensions", "workflow", "tools", "terminal-console"].includes(relative.split(path.sep)[0]))
		throw new Error("external builtin host extension is outside the revision-bound source; recovery cannot prove the same entry");
}

export async function configuredConsoleModel(workspace: string): Promise<string> {
	return resolveRoleModel(await new Workspace(workspace).loadConfig(), "research");
}

export async function resolveConsoleSource(workspace: string): Promise<ConsoleSource> {
	const root = await realpath(workspace);
	const active = await new GenerationStore(root).active();
	if (active?.bundle.environmentVersion === "m07-workflow/v1") {
		const bound = await verifyActiveWorkflowSourceForLaunch(root);
		return { mode: "active-prepared", root: bound.sourceRoot,
			revision: bound.sourceCommit, versionId: bound.versionId };
	}
	const sourceRoot = await realpath(repository);
	const { stdout: revision } = await execFileAsync("git", ["-C", sourceRoot, "rev-parse", "HEAD"]);
	const { stdout: changes } = await execFileAsync("git", ["-C", sourceRoot, "status", "--porcelain", "--", "src", "extensions", "workflow", "tools", "terminal-console", "package.json"]);
	return { mode: "builtin", root: sourceRoot, revision: revision.trim(), dirty: changes.length > 0 };
}
