import { createHash } from "node:crypto";
import { mkdir, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { writeFileAtomic } from "../workspace.ts";

export type TelemetryActivity = "active" | "idle" | "ended";

export interface SessionTelemetry {
	version: 1;
	id: string;
	kind: "controller" | "agent";
	label: string;
	role?: string;
	model?: string;
	stage?: string;
	runId?: string;
	activity: TelemetryActivity;
	startedAt: string;
	lastSeenAt: string;
	endedAt?: string;
	tools: string[];
	outcome?: "completed" | "failed" | "aborted";
}

function safeId(id: string): string {
	return createHash("sha256").update(id).digest("hex");
}

export function telemetryDir(workspace: string): string {
	return path.join(workspace, ".agent", "telemetry");
}

export class TelemetryWriter {
	readonly workspace: string;
	readonly id: string;
	private record: SessionTelemetry;
	private timer?: NodeJS.Timeout;

	private constructor(workspace: string, record: SessionTelemetry) {
		this.workspace = workspace;
		this.id = record.id;
		this.record = record;
	}

	static async start(workspace: string, input: Omit<SessionTelemetry, "version" | "activity" | "startedAt" | "lastSeenAt" | "endedAt">): Promise<TelemetryWriter> {
		const now = new Date().toISOString();
		const previous = await readTelemetry(workspace, input.id);
		const writer = new TelemetryWriter(workspace, {
			version: 1, ...input, tools: [...new Set(input.tools)].sort(), activity: "active",
			startedAt: previous?.startedAt ?? now, lastSeenAt: now,
		});
		await writer.flush();
		writer.timer = setInterval(() => {
			if (writer.record.activity !== "ended") void writer.heartbeat(writer.record.activity).catch(() => undefined);
		}, 5_000);
		writer.timer.unref();
		return writer;
	}

	async heartbeat(activity: Exclude<TelemetryActivity, "ended"> = "active", tools?: string[], outcome?: SessionTelemetry["outcome"]): Promise<void> {
		this.record.activity = activity;
		this.record.lastSeenAt = new Date().toISOString();
		delete this.record.endedAt;
		if (tools) this.record.tools = [...new Set(tools)].sort();
		if (outcome) this.record.outcome = outcome;
		else if (activity === "active") delete this.record.outcome;
		await this.flush();
	}

	async setRunContext(stage: string, runId: string): Promise<void> {
		this.record.stage = stage;
		this.record.runId = runId;
		this.record.lastSeenAt = new Date().toISOString();
		await this.flush();
	}

	async end(): Promise<void> {
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
		const now = new Date().toISOString();
		this.record.activity = "ended";
		this.record.lastSeenAt = now;
		this.record.endedAt = now;
		await this.flush();
	}

	private async flush(): Promise<void> {
		const dir = telemetryDir(this.workspace);
		await mkdir(dir, { recursive: true });
		await writeFileAtomic(path.join(dir, `${safeId(this.id)}.json`), `${JSON.stringify(this.record, null, 2)}\n`);
	}
}

function valid(value: unknown): value is SessionTelemetry {
	if (!value || typeof value !== "object") return false;
	const x = value as Partial<SessionTelemetry>;
	return x.version === 1 && typeof x.id === "string" && (x.kind === "controller" || x.kind === "agent") &&
		typeof x.label === "string" && (x.activity === "active" || x.activity === "idle" || x.activity === "ended") &&
		typeof x.startedAt === "string" && typeof x.lastSeenAt === "string" && Array.isArray(x.tools) && x.tools.every((name) => typeof name === "string");
}

export async function readTelemetry(workspace: string, id: string): Promise<SessionTelemetry | undefined> {
	try {
		const parsed: unknown = JSON.parse(await readFile(path.join(telemetryDir(workspace), `${safeId(id)}.json`), "utf8"));
		return valid(parsed) ? parsed : undefined;
	} catch { return undefined; }
}

export async function listTelemetry(workspace: string): Promise<SessionTelemetry[]> {
	let names: string[];
	try { names = await readdir(telemetryDir(workspace)); } catch { return []; }
	const records = await Promise.all(names.filter((name) => name.endsWith(".json")).map(async (name) => {
		try { const parsed: unknown = JSON.parse(await readFile(path.join(telemetryDir(workspace), name), "utf8")); return valid(parsed) ? parsed : undefined; }
		catch { return undefined; }
	}));
	return records.filter((item): item is SessionTelemetry => Boolean(item));
}
