/** The console wire protocol intentionally exposes only workflow session controls. */
import type { ConsoleWorkflowAction } from "../../../src/pi/console-bridge.ts";
import type { ProcessIdentityV1 } from "../../../src/runtime/process-identity.ts";
import type { ConsoleSource } from "./source.ts";
export const MAX_FRAME_BYTES = 256 * 1024;
export const MAX_EVENT_BYTES = 64 * 1024;
export const MAX_EVENTS = 256;

export type ConsoleCommand = "status" | "events" | "prompt" | "steer" | "follow_up" | "abort" | "get_state" | "pause" | "resume" | "stop" | "workflow" | "workflow_result";
export interface ConsoleRequest {
	requestId: string;
	instanceId: string;
	command: ConsoleCommand;
	goalRunId?: string;
	attemptId?: string;
	message?: string;
	since?: number;
	action?: ConsoleWorkflowAction;
	workflowRequestId?: string;
}
export interface ConsoleResponse {
	requestId: string;
	ok: boolean;
	/** RPC acceptance or queueing is not research completion. */
	accepted?: boolean;
	data?: unknown;
	error?: string;
}
export interface ConsoleEvent { sequence: number; at: string; value: unknown }
export interface ConsoleRecord {
	version: 1;
	instanceId: string;
	workspace: string;
	socketPath: string;
	hostPid: number;
	hostProcess?: ProcessIdentityV1;
	piPid?: number;
	descriptorFile: string;
	controlDir: string;
	startedAt: string;
	state: "starting" | "running" | "exited" | "error";
	source: ConsoleSource;
	model: string;
	/** Canonical Pi entry loaded for this console; absent on older records. */
	hostExtensionFile?: string;
	workflowBridge?: boolean;
	goalRunId?: string;
	attemptId?: string;
	exitCode?: number | null;
	exitSignal?: NodeJS.Signals | null;
	error?: string;
}

export function parseConsoleRequest(value: unknown): ConsoleRequest {
	if (!value || typeof value !== "object") throw new Error("invalid console request");
	const item = value as Partial<ConsoleRequest>;
	const commands: ConsoleCommand[] = ["status", "events", "prompt", "steer", "follow_up", "abort", "get_state", "pause", "resume", "stop", "workflow", "workflow_result"];
	if (typeof item.requestId !== "string" || !/^[\w-]{1,100}$/.test(item.requestId) || typeof item.instanceId !== "string" || !/^[\w-]{1,100}$/.test(item.instanceId) || !commands.includes(item.command as ConsoleCommand)) throw new Error("invalid console request identity or command");
	for (const name of ["goalRunId", "attemptId", "message"] as const) if (item[name] !== undefined && typeof item[name] !== "string") throw new Error(`invalid ${name}`);
	if (item.since !== undefined && (!Number.isSafeInteger(item.since) || item.since < 0)) throw new Error("invalid event cursor");
	if (item.action !== undefined && (!item.action || typeof item.action !== "object" || Array.isArray(item.action))) throw new Error("invalid workflow action");
	if (item.workflowRequestId !== undefined && (typeof item.workflowRequestId !== "string" || !/^[a-f0-9-]{36}$/.test(item.workflowRequestId))) throw new Error("invalid workflow request id");
	return item as ConsoleRequest;
}
