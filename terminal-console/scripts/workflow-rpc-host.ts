/** Event-driven, long-lived Pi RPC entry for a bound research workspace. */
import { spawn } from "node:child_process";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Readable, Writable } from "node:stream";

export interface RpcHostOptions {
	workspace: string;
	goalRunId?: string;
	descriptorFile?: string;
	recover?: boolean;
	piArgs?: string[];
}

export function rpcHostUsage(): string {
	return "Usage: npm run workflow:rpc -- --workspace <workspace> [--goal <runId> --descriptor <run-descriptor.json> --recover] [-- <Pi model/options>]\nSend Pi RPC JSONL prompt commands on stdin. A semantic wait resumes only with [[resume-goal:<runId>]] followed by a concrete user input; dependency/authorization waits use [[resume-condition:<runId>]] with JSON evidencePath/message. EOF shuts the session down.\n";
}

export function parseRpcHostArgs(argv: string[]): RpcHostOptions {
	const separator = argv.indexOf("--");
	const control = separator < 0 ? argv : argv.slice(0, separator);
	const piArgs = separator < 0 ? [] : argv.slice(separator + 1);
	if (control.includes("--help") || control.includes("-h")) throw new Error(rpcHostUsage());
	const flag = (name: string): string | undefined => {
		const index = control.indexOf(name);
		if (index < 0) return undefined;
		const value = control[index + 1];
		if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
		return value;
	};
	const workspace = flag("--workspace");
	const goalRunId = flag("--goal");
	const descriptorFile = flag("--descriptor");
	const recover = control.includes("--recover");
	if (!workspace) throw new Error(rpcHostUsage());
	if (!!goalRunId !== !!descriptorFile || (goalRunId && !recover) || (recover && !goalRunId)) throw new Error("An existing goal requires --goal, --descriptor and --recover together; a new goal needs only --workspace.");
	if (piArgs.some((arg) => ["--mode", "-e", "--extension"].includes(arg))) throw new Error("RPC mode and the research extension are fixed by this entry.");
	return { workspace, ...(goalRunId ? { goalRunId } : {}), ...(descriptorFile ? { descriptorFile } : {}), ...(recover ? { recover } : {}), piArgs };
}

export async function runRpcHost(options: RpcHostOptions, io: { stdin: Readable; stdout: Writable; stderr: Writable } = process, piCliFile?: string): Promise<number> {
	const workspace = await realpath(options.workspace);
	const extensionFile = path.resolve(import.meta.dirname, "../extensions/research.ts");
	const cliFile = piCliFile ?? path.resolve(path.dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))), "bundle/cli.js");
	const env: NodeJS.ProcessEnv = { ...process.env, PRE_RSI_CONTINUATION_WORKSPACE: workspace };
	if (options.goalRunId) {
		env.PRE_RSI_CONTINUATION_GOAL_RUN_ID = options.goalRunId;
		env.PRE_RSI_RECOVER_GOAL_RUN_ID = options.goalRunId;
		env.PRE_RSI_RUN_DESCRIPTOR_FILE = await realpath(options.descriptorFile!);
	} else {
		delete env.PRE_RSI_CONTINUATION_GOAL_RUN_ID;
		delete env.PRE_RSI_RECOVER_GOAL_RUN_ID;
		delete env.PRE_RSI_RUN_DESCRIPTOR_FILE;
	}
	const child = spawn(process.execPath, [cliFile, "--mode", "rpc", "-e", extensionFile, ...(options.piArgs ?? [])], { cwd: workspace, env, stdio: ["pipe", "pipe", "pipe"] });
	io.stdin.pipe(child.stdin);
	child.stdout.pipe(io.stdout, { end: false });
	child.stderr.pipe(io.stderr, { end: false });
	return await new Promise<number>((resolve, reject) => {
		child.once("error", reject);
		child.once("exit", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
	});
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	try {
		const options = parseRpcHostArgs(process.argv.slice(2));
		process.exitCode = await runRpcHost(options);
	} catch (error) {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 1;
	}
}
