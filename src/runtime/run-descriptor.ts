import { readFileSync } from "node:fs";
import type { ProcessIdentityV1 } from "./process-identity.ts";

export interface RunDescriptorV1 {
	version: 1;
	instanceId: string;
	attemptId: string;
	workspaceId: string;
	goalRunId?: string;
	codeRevision: string;
	controlDir: string;
	processGroupId?: number;
	process: ProcessIdentityV1;
}

export interface TrustedControlStateV1 {
	version: 1;
	instanceId: string;
	state: "running" | "paused" | "stopping" | "stopped";
	updatedAt: string;
	totalPausedMs: number;
	pauseStartedAt?: number;
}

export function parseRunDescriptor(value: unknown): RunDescriptorV1 {
	if (!value || typeof value !== "object") throw new Error("run descriptor missing");
	const d = value as Partial<RunDescriptorV1>;
	if (d.version !== 1 || !d.instanceId || !d.attemptId || !d.workspaceId || !d.codeRevision || !d.controlDir ||
		!d.process?.hostId || !d.process.bootId || !d.process.processStartToken || !Number.isSafeInteger(d.process.pid) || d.process.pid <= 0) {
		throw new Error("run descriptor invalid");
	}
	return d as RunDescriptorV1;
}

export function readTrustedPauseMs(now = Date.now(), file = process.env.PRE_RSI_CONTROL_STATE_FILE, instanceId = process.env.PRE_RSI_RUN_INSTANCE_ID): number {
	if (!file || !instanceId) return 0;
	try {
		const state = JSON.parse(readFileSync(file, "utf8")) as Partial<TrustedControlStateV1>;
		if (state.version !== 1 || state.instanceId !== instanceId || !Number.isSafeInteger(state.totalPausedMs) || state.totalPausedMs! < 0) return 0;
		if (state.state === "paused" && Number.isSafeInteger(state.pauseStartedAt) && state.pauseStartedAt! <= now) {
			return state.totalPausedMs! + now - state.pauseStartedAt!;
		}
		return state.totalPausedMs!;
	} catch { return 0; }
}
