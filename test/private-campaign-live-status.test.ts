import assert from "node:assert/strict";
import test from "node:test";
import { bestEffortLiveControlObserver, actionsLiveControlFrameSink,
	LIVE_REQUEST_SAMPLE_MS } from "../scripts/private-campaign-live-status.ts";
import type { StoredIncrementalCheckpoint, IncrementalCheckpointInput } from
	"../src/runner/incremental-private-checkpoint.ts";
import type { LiveControlFrameEmission } from "../src/runner/live-control-frame.ts";

const stored = (sequence: number): StoredIncrementalCheckpoint => ({ sequence,
	file: "incremental-control-prefix.json", sha256: sequence.toString(16).padStart(64, "0") });
const audit = (received: readonly boolean[]): IncrementalCheckpointInput["requestAudit"] => ({
	version: 3, kind: "accounting-only-request-audit",
	requests: received.map((responseReceived, index) => ({ requestId: `synthetic-${index + 1}`,
		sessionId: "c".repeat(64), inputPayloadBytes: 1, maxOutputTokens: 1,
		responseReceived, status: "unknown" as const,
		settledCny: null, unknownObservedCny: null, reportedUsage: null })),
	settledCny: 0, unknownObservedCny: 0, unpricedRequestCount: received.length,
});
const effects = (tasks = 0, taskStatus = "running", goalOutcome = "active",
	operationStatus = "issued"):
	IncrementalCheckpointInput["hostEffects"] => ({
	version: 1, kind: "host-effect-prefix-observation", complete: false,
	selectionAuthority: false, source: { runId: "1", runAttempt: 1, commit: "a".repeat(40) },
	priorEnvelopeSha256: "b".repeat(64), historicalGoalRunIds: [], requestIds: [], sessions: [],
	goals: [{ runId: "synthetic-goal", outcome: goalOutcome,
		tasks: Array.from({ length: tasks }, (_, index) => ({ taskId: `T${index + 1}`,
			mode: "execute" as const, status: taskStatus, sessionId: "c".repeat(64) })),
		operations: [{ id: "O1", taskId: "T1", status: operationStatus }] }],
});
const tick = async () => { for (let i = 0; i < 4; i++) await Promise.resolve(); };

test("only committed, changed control status emits immediately; request-only changes are sampled", async () => {
	const writes: LiveControlFrameEmission[] = [];
	let now = 1_000, fire: (() => void) | undefined, cancellations = 0;
	const observer = bestEffortLiveControlObserver({ enabled: true,
		openWriter: async () => ({ emit: async value => { writes.push(value); } }),
		clock: { now: () => now,
			later: callback => { fire = callback; return { unref() {} } as ReturnType<typeof setTimeout>; },
			clear: () => { cancellations++; fire = undefined; } } });
	observer.committed(stored(1), "initial", audit([]), effects());
	await tick();
	assert.equal(writes.length, 1);
	assert.deepEqual(writes[0], { sequence: 1, checkpointSha256: stored(1).sha256,
		committedCheckpointBoundary: "initial", requestCount: 0, responseReceivedCount: 0,
		goalCount: 1, goalOutcomeCounts: { active: 1, partial: 0, blocked: 0,
			fulfilled: 0 }, taskCount: 0,
		taskStatusCounts: { running: 0, returned: 0, failed: 0,
			accepted: 0, rejected: 0, unknown: 0 }, operationCount: 1,
		operationStatusCounts: { prepared: 0, issued: 1,
			"response-received": 0, "partial-settled": 0,
			"terminal-response-incomplete": 0, unknown: 0, confirmed: 0,
			"not-issued": 0 },
		observedAt: new Date(1_000).toISOString() });
	now += 1_000;
	observer.committed(stored(2), "request-reserved", audit([false]), effects());
	await tick();
	assert.equal(writes.length, 1, "the research request continues while observation is sampled");
	assert.ok(fire);
	now += LIVE_REQUEST_SAMPLE_MS;
	fire!();
	await tick();
	assert.equal(writes.at(-1)?.sequence, 2);
	assert.equal(writes.at(-1)?.requestCount, 1);
	observer.committed(stored(3), "control-observed", audit([true]), effects(1));
	await tick();
	assert.equal(writes.at(-1)?.sequence, 3);
	assert.equal(writes.at(-1)?.responseReceivedCount, 1);
	assert.equal(writes.at(-1)?.taskCount, 1);
	observer.committed(stored(4), "control-observed", audit([true]), effects(1, "accepted", "active"));
	await tick();
	assert.equal(writes.at(-1)?.sequence, 4,
		"same total with a task decision emits immediately");
	assert.equal(writes.at(-1)?.taskStatusCounts.accepted, 1);
	observer.committed(stored(5), "control-observed", audit([true]),
		effects(1, "accepted", "blocked"));
	await tick();
	assert.equal(writes.at(-1)?.goalOutcomeCounts.blocked, 1,
		"same total with a blocked goal emits immediately");
	observer.committed(stored(6), "control-observed", audit([true]),
		effects(1, "accepted", "blocked", "confirmed"));
	await tick();
	assert.equal(writes.at(-1)?.operationStatusCounts.confirmed, 1,
		"same total with a changed operation state emits immediately");
	observer.committed(stored(7), "control-observed", audit([true]),
		effects(1, "accepted", "blocked", "confirmed"));
	await tick();
	assert.equal(writes.length, 6, "unchanged controller facts coalesce without an artifact");
	assert.ok(cancellations >= 1);
});

test("observer init and sink errors never reject the committing caller", async () => {
	let opened = 0;
	const failedInit = bestEffortLiveControlObserver({ enabled: true,
		openWriter: async () => { opened++; throw Error("synthetic observer unavailable"); } });
	assert.doesNotThrow(() => failedInit.committed(stored(1), "initial", audit([]), effects()));
	await tick();
	assert.doesNotThrow(() => failedInit.committed(stored(2), "control-observed", audit([]), effects(1)));
	await tick();
	assert.equal(opened, 1, "a failed observer is disabled without retry pressure");
	const failedSink = bestEffortLiveControlObserver({ enabled: true,
		openWriter: async () => ({ emit: async () => { throw Error("synthetic pipe closed"); } }) });
	assert.doesNotThrow(() => failedSink.committed(stored(1), "initial", audit([]), effects()));
	await tick();
	assert.doesNotThrow(() => failedSink.committed(stored(2), "control-observed", audit([]), effects(1)));
	assert.doesNotThrow(() => actionsLiveControlFrameSink(false)("opaque ciphertext"));
	const disabled = bestEffortLiveControlObserver({ enabled: false,
		openWriter: async () => { throw Error("disabled observer must not initialize"); } });
	assert.doesNotThrow(() => disabled.committed(stored(1), "initial", audit([]), effects()));
});
