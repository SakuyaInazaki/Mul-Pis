import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { classifyPendingAction } from "../src/m07/objective-progress.ts";
import { REUSABLE_RUN_REQUEST_MESSAGE } from "../src/runner/ledger-continuation.ts";
import { MissionResumeJournal, type TestedControlBinding } from
	"../src/runner/mission-resume-journal.ts";
import { pendingActionIdentity, planMissionContinuation, type ResumeIntent,
	type SupervisorSnapshot } from "../src/runner/mission-supervisor.ts";

const hash = (s: string): string => createHash("sha256").update(s).digest("hex");
function canonical(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
		.map(([key, part]) => `${JSON.stringify(key)}:${canonical(part)}`).join(",")}}`;
}
const source = { runId: "7002", runAttempt: 1, commit: "b".repeat(40) };
function intentFor(reason: "assessment-failed" | "model-reported-blocked" = "assessment-failed"):
	ResumeIntent {
	const action = classifyPendingAction(reason);
	const status = { version: 1 as const, kind: "host-redacted-mission-status" as const,
		contractId: "private-contract", objectiveOutcome: "incomplete" as const,
		stopReason: reason, selectedTupleSha256: hash("tuple"),
		unresolvedOperationRefs: [], pendingAction: action };
	const snapshot: SupervisorSnapshot = { status, pendingAction: action,
		dispatchRecord: { state: "not-requested" },
		terminalCarry: { version: 1, kind: "host-verified-terminal-carry", source,
			envelopeSha256: hash("envelope"), contractId: status.contractId,
			selectedTupleSha256: status.selectedTupleSha256,
			pendingActionSha256: pendingActionIdentity(action),
			terminal: { runStatus: "completed", jobStatus: "completed",
				providerStepStatus: "completed" } } };
	const decision = planMissionContinuation(snapshot);
	assert.equal(decision.kind, "dispatch");
	if (decision.kind !== "dispatch") throw Error("fixture is not dispatchable");
	return decision.intent;
}
const binding = (sourceCommit = "c".repeat(40), tree = "d".repeat(40)):
	TestedControlBinding => ({
	controlRef: "refs/heads/run-requests/workflow-learning-reliability",
	message: REUSABLE_RUN_REQUEST_MESSAGE, testedSourceCommit: sourceCommit,
	testedTree: tree,
	successfulCi: { workflow: "workflow-regression.yml", runId: "9001",
		runAttempt: 1, headCommit: sourceCommit, conclusion: "success" },
	previousControlCommit: "e".repeat(40),
	parents: [sourceCommit, "e".repeat(40)], expectedBefore: "e".repeat(40),
	sourceRef: "refs/heads/improve/workflow-learning-reliability",
	sourceRefTip: sourceCommit,
});
async function fixture(t: TestContext) {
	const dir = await mkdtemp(path.join(os.tmpdir(), "mission-journal-"));
	t.after(async () => rm(dir, { recursive: true, force: true }));
	return { dir, journal: new MissionResumeJournal(path.join(dir, "private")) };
}


test("a crash after attempt and unknown delivery cannot cause a second update", async t => {
	const { journal } = await fixture(t), intent = intentFor();
	await journal.reserve(intent, binding());
	await journal.markAttempted(intent.idempotencyKey);
	const restarted = new MissionResumeJournal(journal.directory);
	assert.equal((await restarted.get(intent.idempotencyKey))?.state, "ref-update-attempted");
	await assert.rejects(restarted.markAttempted(intent.idempotencyKey), /cannot be reissued/);
	await restarted.markDeliveryUnknown(intent.idempotencyKey);
	assert.equal((await new MissionResumeJournal(journal.directory).unresolvedForRef(binding().controlRef))?.state,
		"delivery-unknown");
	await assert.rejects(restarted.reserve(intentFor("model-reported-blocked"), binding()),
		/unresolved reservation/);
	const accepted = await restarted.acknowledge(intent.idempotencyKey, {
		kind: "read-only-accepted-control", controlRef: binding().controlRef,
		controlCommit: "f".repeat(40), tree: binding().testedTree,
		parents: binding().parents, message: binding().message, successorRunId: "9003" });
	assert.equal(accepted.state, "acknowledged");
	assert.equal((await restarted.unresolvedForRef(binding().controlRef)), undefined);
	await assert.rejects(restarted.reserve(intentFor("model-reported-blocked"), binding()),
		/acknowledged tip/);
	const next = { ...binding(), previousControlCommit: "f".repeat(40),
		parents: [binding().testedSourceCommit, "f".repeat(40)], expectedBefore: "f".repeat(40) };
	assert.equal((await restarted.reserve(intentFor("model-reported-blocked"), next)).state,
		"reserved");
});
