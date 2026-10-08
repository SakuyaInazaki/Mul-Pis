import { writeSync } from "node:fs";
import { createLiveControlFrameWriter } from "../../../src/runner/live-control-frame.ts";

const forbidden = Object.keys(process.env).some(key => /^ACTIONS_/.test(key) ||
	["GITHUB_OUTPUT", "GITHUB_ENV", "GITHUB_PATH", "GITHUB_STEP_SUMMARY", "NODE_OPTIONS",
		"SMOKE_RUNTIME_CANARY"].includes(key));
if (forbidden || process.env.MULPIS_ACTIONS_PRIVATE_PROGRESS_FD !== "4") process.exit(97);

const source = { repository: process.env.GITHUB_REPOSITORY, runId: process.env.GITHUB_RUN_ID,
	runAttempt: Number(process.env.GITHUB_RUN_ATTEMPT), commit: process.env.GITHUB_SHA,
	event: process.env.GITHUB_EVENT_NAME, priorEnvelopeSha256: process.argv[4] };
const writer = await createLiveControlFrameWriter({
	seedEnvelopeB64: process.env.MULPIS_MISSION_LEDGER_B64,
	publicKeyFile: process.argv[2], expectedSpkiSha256: process.argv[3], source,
	emitFrame: line => { writeSync(4, `${line}\n`); },
});
await writer.emit({ sequence: 1, committedCheckpointBoundary: "initial",
	checkpointSha256: process.argv[5], requestCount: 0, responseReceivedCount: 0,
	goalCount: 0, goalOutcomeCounts: { active: 0, partial: 0, blocked: 0, fulfilled: 0 },
	taskCount: 0, taskStatusCounts: { running: 0, returned: 0, failed: 0,
		accepted: 0, rejected: 0, unknown: 0 }, operationCount: 0,
	operationStatusCounts: { prepared: 0, issued: 0, "response-received": 0,
		"partial-settled": 0, "terminal-response-incomplete": 0, unknown: 0,
		confirmed: 0, "not-issued": 0 }, observedAt: new Date().toISOString() });
process.exit(23);
