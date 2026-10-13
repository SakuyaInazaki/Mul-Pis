/** Start a new process from a prepared source snapshot; preserve existing runs. */
import { spawn } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { WorkflowCodeSnapshot } from "./prepare-workflow-source.ts";
import { verifyActiveWorkflowSourceForLaunch } from "../src/improvement/research-service.ts";

/** Resolve only the active executor source. I remains an independent research-driver binding. */
export async function activeWorkflowExecutorSource(workspaceRoot: string): Promise<{ sourceRoot: string; sourceCommit: string; versionId: string }> {
	return verifyActiveWorkflowSourceForLaunch(workspaceRoot);
}

export async function workflowSourceCommand(source: string, workspace: string, target: string, args: string[]) {
	if (target !== "harness" && target !== "pi") throw new Error("Target must be harness or pi");
	if (target === "pi" && (process.env.PRE_RSI_RECOVER_GOAL_RUN_ID || process.env.PRE_RSI_CONTINUATION_GOAL_RUN_ID) && !process.env.PRE_RSI_RUN_DESCRIPTOR_FILE)
		throw new Error("A bound Pi continuation or recovery requires a run descriptor before launch");
	const workspaceRoot = await realpath(workspace);
	const activeSource = source === "@active" ? await activeWorkflowExecutorSource(workspaceRoot) : undefined;
	const sourceRoot = await realpath(activeSource?.sourceRoot ?? source);
	if (workspaceRoot === sourceRoot || workspaceRoot.startsWith(sourceRoot + path.sep)) throw new Error("Research workspace must be outside the read-only source snapshot");
	const receipt = JSON.parse(await readFile(path.join(sourceRoot, ".workflow-source.json"), "utf8")) as WorkflowCodeSnapshot;
	const { verifyLoadedSource, verifyDescriptorLoadedSource } = await import(pathToFileURL(path.join(sourceRoot, "src/runtime/loaded-source.ts")).href);
	const entry = path.join(sourceRoot, target === "harness" ? "src/cli.ts" : "src/pi/extension.ts");
	const binding = await verifyLoadedSource(pathToFileURL(entry).href, sourceRoot, receipt.sourceCommit);
	if (!binding || binding.sourceCommit !== receipt.sourceCommit) throw new Error("Prepared source could not be verified");
	if (activeSource && binding.sourceCommit !== activeSource.sourceCommit) throw new Error("Active H source changed during launcher binding");
	if (process.env.PRE_RSI_RUN_DESCRIPTOR_FILE) {
		const { parseRunDescriptor } = await import(pathToFileURL(path.join(sourceRoot, "src/runtime/run-descriptor.ts")).href);
		const descriptor = parseRunDescriptor(JSON.parse(await readFile(process.env.PRE_RSI_RUN_DESCRIPTOR_FILE, "utf8")));
		await verifyDescriptorLoadedSource(descriptor, pathToFileURL(entry), sourceRoot, receipt.sourceCommit);
	}
	let childArgs: string[];
	if (target === "harness") {
		if (args.some(arg => arg === "--workspace" || arg.startsWith("--workspace="))) throw new Error("Use the launcher's workspace argument");
		childArgs = [entry, ...args, "--workspace", workspaceRoot];
	} else {
		if (args.some(arg => ["-e", "--extension", "--model", "--provider"].includes(arg) || /^(--extension|--model|--provider)=/.test(arg))) throw new Error("The prepared source supplies the extension and the workspace supplies the model");
		const config = JSON.parse(await readFile(path.join(workspaceRoot, "research.config.json"), "utf8"));
		if (typeof config.roles?.research !== "string" || !config.roles.research.trim()) throw new Error("Workspace research model is not configured");
		childArgs = [path.join(sourceRoot, "node_modules/@earendil-works/pi-coding-agent/dist/cli.js"), "--offline", "--no-extensions", "--extension", path.join(sourceRoot, "extensions/research.ts"), "--model", config.roles.research, ...args];
	}
	if (activeSource && JSON.stringify(await activeWorkflowExecutorSource(workspaceRoot)) !== JSON.stringify(activeSource))
		throw new Error("Active workflow source changed before launch");
	return { childArgs, cwd: workspaceRoot, env: { ...process.env, PRE_RSI_SOURCE_ROOT: sourceRoot, PRE_RSI_CODE_REVISION: binding.sourceCommit,
		...(activeSource ? { PRE_RSI_ACTIVE_H_VERSION_ID: activeSource.versionId } : {}) } };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const [source, workspace, target, ...args] = process.argv.slice(2);
	if (!source || !workspace || !target) throw new Error("Usage: node scripts/run-workflow-source.ts <source-directory|@active> <workspace> <harness|pi> [arguments...]");
	const launch = await workflowSourceCommand(source, workspace, target, args);
	const detached = process.platform !== "win32";
	const child = spawn(process.execPath, launch.childArgs, { cwd: launch.cwd, env: launch.env, stdio: "inherit", detached });
	for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, () => {
		if (!child.pid) return;
		try { if (detached) process.kill(-child.pid, signal); else child.kill(signal); }
		catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
	});
	child.once("error", error => { console.error(error.message); process.exitCode = 1; });
	child.once("exit", (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
}
