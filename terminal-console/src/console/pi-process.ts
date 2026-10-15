/** Entry executed by the actual Pi child before loading the Pi CLI in this same process. */
import { readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { readCurrentProcessIdentity } from "../runtime/process-identity.ts";
import { parseRunDescriptor, type RunDescriptorV1, type TrustedControlStateV1 } from "../runtime/run-descriptor.ts";
import type { ProcessIdentityV1 } from "../runtime/process-identity.ts";

export interface PiBootstrap { cliFile: string; extensionFile: string; workspace: string; controlDir: string; instanceId: string; piArgs: string[]; goalRunId?: string; recover?: boolean; oldDescriptorFile?: string }
const sameProcess = (a: ProcessIdentityV1, b: ProcessIdentityV1): boolean => a.hostId === b.hostId && a.bootId === b.bootId && a.pid === b.pid && a.processStartToken === b.processStartToken;

export async function recoveryIdentity(config: PiBootstrap): Promise<{ workspaceId: string; attemptId: string; codeRevision: string }> {
	if (!config.recover || !config.goalRunId || !config.oldDescriptorFile || !/^[A-Za-z0-9_-]+$/.test(config.goalRunId)) throw new Error("recovery requires a named M07 goal and old descriptor");
	const workspace = await realpath(config.workspace);
	const oldFile = await realpath(config.oldDescriptorFile);
	if (!oldFile.startsWith(`${workspace}${path.sep}`)) throw new Error("old run descriptor is outside the workspace");
	const previous = parseRunDescriptor(JSON.parse(await readFile(oldFile, "utf8")));
	const goal = JSON.parse(await readFile(path.join(workspace, "stages", "M07", config.goalRunId, "goal.json"), "utf8")) as { runId?: string; lifecycle?: string; executionState?: { activeAttemptId?: string; attempts?: { id: string; runDescriptor: RunDescriptorV1 }[] } };
	const attempts = goal.executionState?.attempts;
	const active = attempts?.find((item) => item.id === goal.executionState?.activeAttemptId);
	const first = attempts?.[0];
	if (goal.runId !== config.goalRunId || goal.lifecycle !== "active" || !first?.runDescriptor.workspaceId || !active || previous.goalRunId !== config.goalRunId || previous.attemptId !== active.id || previous.instanceId !== active.runDescriptor.instanceId || !sameProcess(previous.process, active.runDescriptor.process)) throw new Error("old descriptor does not match the active M07 attempt");
	return { workspaceId: first.runDescriptor.workspaceId, attemptId: `A${String(attempts!.length + 1).padStart(3, "0")}`, codeRevision: active.runDescriptor.codeRevision };
}

export async function bootstrapPi(config: PiBootstrap): Promise<RunDescriptorV1> {
	const recovery = config.recover ? await recoveryIdentity(config) : undefined;
	const descriptor: RunDescriptorV1 = { version: 1, instanceId: config.instanceId, attemptId: recovery?.attemptId ?? "A001", workspaceId: recovery?.workspaceId ?? path.resolve(config.workspace), ...(config.goalRunId ? { goalRunId: config.goalRunId } : {}), codeRevision: recovery?.codeRevision ?? "unrecorded", controlDir: config.controlDir, processGroupId: process.pid, process: await readCurrentProcessIdentity() };
	const state: TrustedControlStateV1 = { version: 1, instanceId: config.instanceId, state: "running", updatedAt: new Date().toISOString(), totalPausedMs: 0 };
	await writeFile(path.join(config.controlDir, "run-descriptor.json"), `${JSON.stringify(descriptor)}\n`, { mode: 0o600 });
	await writeFile(path.join(config.controlDir, "control.json"), `${JSON.stringify(state)}\n`, { mode: 0o600 });
	await writeFile(path.join(config.controlDir, "run.pid"), `${process.pid}\n`, { mode: 0o600 });
	process.env.PRE_RSI_RUN_INSTANCE_ID = config.instanceId;
	process.env.PRE_RSI_CONTROL_STATE_FILE = path.join(config.controlDir, "control.json");
	process.env.PRE_RSI_RUN_DESCRIPTOR_FILE = path.join(config.controlDir, "run-descriptor.json");
	process.env.MUL_PIS_CONSOLE_CONTROL_DIR = config.controlDir;
	process.env.PRE_RSI_CONTINUATION_WORKSPACE = config.workspace;
	if (config.goalRunId) process.env.PRE_RSI_CONTINUATION_GOAL_RUN_ID = config.goalRunId;
	else delete process.env.PRE_RSI_CONTINUATION_GOAL_RUN_ID;
	if (config.recover && config.goalRunId) process.env.PRE_RSI_RECOVER_GOAL_RUN_ID = config.goalRunId;
	else delete process.env.PRE_RSI_RECOVER_GOAL_RUN_ID;
	process.argv = [process.execPath, config.cliFile, "--mode", "rpc", "-e", config.extensionFile, ...config.piArgs];
	await import(pathToFileURL(config.cliFile).href);
	return descriptor;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const config = JSON.parse(await readFile(process.argv[2], "utf8")) as PiBootstrap;
	await bootstrapPi(config).catch((error) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
}
