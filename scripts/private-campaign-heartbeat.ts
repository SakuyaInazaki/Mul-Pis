import { writeSync } from "node:fs";

// This is the only campaign-driver text allowed on the public Actions log.
// It reports a responsive Node event loop, not scientific or provider progress.
export const PUBLIC_HEARTBEAT_LINE = "Private campaign process responsive\n";
export const PUBLIC_HEARTBEAT_INTERVAL_MS = 60_000;

type HeartbeatClock = {
	every: (callback: () => void, intervalMs: number) => ReturnType<typeof setInterval>;
	clear: (timer: ReturnType<typeof setInterval>) => void;
};

const realClock: HeartbeatClock = { every: setInterval, clear: clearInterval };

export function startPrivateCampaignHeartbeat(
	enabled = process.env.GITHUB_ACTIONS === "true" && process.env.MULPIS_ACTIONS_PUBLIC_HEARTBEAT_FD === "3",
	write: (line: string) => void = line => { writeSync(3, line); },
	clock: HeartbeatClock = realClock,
): () => void {
	if (!enabled) return () => {};
	const emit = () => {
		try { write(PUBLIC_HEARTBEAT_LINE); }
		catch { /* Observation must never change the campaign outcome. */ }
	};
	emit();
	const timer = clock.every(emit, PUBLIC_HEARTBEAT_INTERVAL_MS);
	timer.unref();
	return () => clock.clear(timer);
}
