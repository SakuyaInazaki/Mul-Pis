import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";

let activeSessions = 0;
let writeQueue = Promise.resolve();

export function sessionOpened(): void { activeSessions++; }
export function sessionClosed(): void { activeSessions = Math.max(0, activeSessions - 1); }

/** Best-effort, content-free process samples. They cannot attribute an OS memory warning. */
export function sampleRunnerResources(persistDir: string, event: "create" | "prompt-end" | "dispose"): Promise<void> {
	if (path.basename(persistDir) !== "sessions" || path.basename(path.dirname(persistDir)) !== ".agent") return Promise.resolve();
	const telemetryDir = path.join(path.dirname(persistDir), "telemetry");
	const memory = process.memoryUsage();
	const sample = {
		at: new Date().toISOString(), pid: process.pid, event, activeSessions,
		rss: memory.rss, heapUsed: memory.heapUsed,
		external: memory.external, arrayBuffers: memory.arrayBuffers,
	};
	writeQueue = writeQueue.then(async () => {
		try {
			await mkdir(telemetryDir, { recursive: true });
			await appendFile(path.join(telemetryDir, `runner-resources-${process.pid}.jsonl`), `${JSON.stringify(sample)}\n`);
		} catch { /* Observability must not change research outcomes. */ }
	});
	return writeQueue;
}
