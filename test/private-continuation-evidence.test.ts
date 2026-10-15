import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { offlineChecks } from "../scripts/manual-private-campaign.ts";
import { createOriginalObjective, objectiveProgress } from "../src/m07/objective-progress.ts";
import type { PrivateContinuationBundle } from "../src/runner/ledger-continuation.ts";

// These are transport/identity fixtures, never private source or scientific implementations.
const originalSource = "// Synthetic original source identity only.\n";
const inputNames = ["instructions.txt", "original.cpp", "task.md"];
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

function fixture() {
	const contract = { ...createOriginalObjective({
		goal: "Complete the synthetic original objective while retaining prior observations",
		goalSource: "user-intent-summary", inputNames,
		obligations: [{ id: "original", description: "Resolve the original synthetic obligation" }],
		closure: "open-ended",
	}), id: "synthetic-contract", createdAt: "2026-01-02T03:04:05.000Z" };
	const assessment = {
		version: 1 as const, decision: "continue" as const,
		rationale: "Bounded evidence does not close the original objective",
		evidenceRefs: ["candidate.cpp", "verification.json"], unresolvedObligations: ["original"],
		unresolvedDetails: ["A further synthetic measurement remains"],
		nextTask: { objective: "Measure the unresolved synthetic case", addresses: ["original"],
			adapterScope: "registered-csr-experiment" as const },
		sessionId: "synthetic-session", model: "fake/research",
		evidenceRead: ["original-objective.json", "candidate.cpp", "verification.json"], unreadEvidence: [],
	};
	const checkpoint = objectiveProgress(contract, {
		boundedRuns: [{ runId: "synthetic-prior-goal", outcome: "fulfilled", selectedTaskId: "T001" }],
		selectedArtifacts: ["candidate.cpp", "verification.json", "workflow-archive.json"],
		assessment, assessmentHistory: [{ iteration: 1, assessment, stopReason: "next-task-pending", advanced: false }],
		stopReason: "next-task-pending",
	});
	const archive = {
		version: 1, kind: "m07-private-candidate-archive", goalRunId: "synthetic-prior-goal", taskId: "T001",
		controllerEvidence: { reviewStatus: "accepted" }, m04: { runId: "synthetic-prior-m04" },
	};
	const knowledge = { version: 1, kind: "m04-published-knowledge-export", m04RunId: "synthetic-prior-m04",
		storeId: "synthetic-store", records: [], adoptedExperienceRefs: [] };
	const bundle: PrivateContinuationBundle = {
		"candidate.cpp": "// Synthetic accepted candidate bytes.\n",
		"verification.json": json({ version: 1, status: "passed", independent: { status: "passed" } }),
		"workflow-archive.json": json(archive), "objective-checkpoint.json": json(checkpoint),
		"original-objective.json": json(contract), "m04-adopted-knowledge.json": json(knowledge),
		"experiment-plan.json": json({ registeredStrategies: ["synthetic_1", "synthetic_2"], cases: [] }),
		"objective-assessment-receipts.json": json({ version: 1, receipts: [{ runId: "synthetic-prior-assessment" }] }),
	};
	const binding = { contractId: contract.id, sourceSha256: createHash("sha256").update(originalSource).digest("hex") };
	return { bundle, binding, contract, checkpoint, archive, knowledge };
}

function changedFile(bundle: PrivateContinuationBundle, name: keyof PrivateContinuationBundle,
	change: (value: any) => void): PrivateContinuationBundle {
	const value = JSON.parse(bundle[name]!);
	change(value);
	return { ...bundle, [name]: json(value) };
}

test("authenticated continuation preserves the exact legacy objective without inserting current overrides", () => {
	const { bundle, binding, contract, checkpoint, archive } = fixture();
	const before = structuredClone(bundle);
	assert.equal(Object.hasOwn(contract, "userOverrides"), false);
	const restored = offlineChecks.validateContinuationSeed(bundle, inputNames, binding, originalSource);
	assert.deepEqual(restored.checkpoint, checkpoint);
	assert.deepEqual(restored.archive, archive);
	assert.equal(Object.hasOwn(restored.checkpoint.contract, "userOverrides"), false);
	assert.deepEqual(bundle, before);
	assert.equal(restored.checkpoint.objectiveOutcome, "incomplete");
	assert.deepEqual(restored.checkpoint.assessmentHistory, checkpoint.assessmentHistory);
});

test("continuation blocks unresolved operations recorded at either controller level", () => {
	const { bundle, binding } = fixture();
	for (const change of [
		(value: any) => { value.continuation.requiresOperationReconciliation = true; },
		(value: any) => { value.continuation.unresolvedOperationIds = ["synthetic-operation"]; },
		(value: any) => { value.boundedRuns[0].unresolvedOperationIds = ["synthetic-operation"]; },
	]) assert.throws(() => offlineChecks.validateContinuationSeed(
		changedFile(bundle, "objective-checkpoint.json", change), inputNames, binding, originalSource), /reconciliation/);
});

test("accepted new evidence is carried as its own tuple rather than mixed with prior source", async t => {
	const root = await mkdtemp(path.join(os.tmpdir(), "synthetic-continuation-selection-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const { bundle, checkpoint, archive } = fixture();
	const current: PrivateContinuationBundle = { ...bundle,
		"candidate.cpp": "// Synthetic newly accepted source.\n",
		"verification.json": json({ version: 1, status: "passed", observation: "new synthetic evidence" }),
		"workflow-archive.json": json({ ...archive, goalRunId: "synthetic-new-goal", taskId: "T002" }),
		"objective-checkpoint.json": json({ ...checkpoint, boundedRuns: [...checkpoint.boundedRuns,
			{ runId: "synthetic-new-goal", outcome: "fulfilled", selectedTaskId: "T002" }] }),
		"experiment-plan.json": json({ registeredStrategies: ["synthetic_1", "synthetic_2", "synthetic_3"], cases: [] }),
	};
	for (const [name, text] of Object.entries(current)) await writeFile(path.join(root, name), text!);
	const carry = await offlineChecks.collectContinuationBundle(root, bundle);
	const { "research-history.json": historyText, ...selected } = carry!;
	assert.deepEqual(selected, current);
	const history = JSON.parse(historyText!);
	assert.equal(history.kind, "untrusted-version-bound-research-history");
	assert.equal(history.entries.length, 1);
	assert.equal(history.entries[0].originalContractId, checkpoint.contract.id);
	assert.equal(history.entries[0].goalRunId, archive.goalRunId);
	assert.equal(history.entries[0].files["candidate.cpp"], bundle["candidate.cpp"]);
	assert.equal(history.entries[0].files["experiment-plan.json"], bundle["experiment-plan.json"]);
	assert.equal(history.entries[0].files["m04-adopted-knowledge.json"], bundle["m04-adopted-knowledge.json"]);
});

test("unbound new acceptance cannot replace prior tuple and unsafe files cannot enter carry", async t => {
	const root = await mkdtemp(path.join(os.tmpdir(), "synthetic-continuation-safety-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const { bundle, archive } = fixture();
	for (const [name, text] of Object.entries(bundle)) await writeFile(path.join(root, name), text!);
	await writeFile(path.join(root, "candidate.cpp"), "// Synthetic source with wrong historical task.\n");
	await writeFile(path.join(root, "workflow-archive.json"), json({ ...archive, taskId: "T009" }));
	const retained = await offlineChecks.collectContinuationBundle(root, bundle);
	assert.equal(retained?.["candidate.cpp"], bundle["candidate.cpp"]);
	assert.equal(retained?.["workflow-archive.json"], bundle["workflow-archive.json"]);
	assert.equal(await offlineChecks.collectContinuationBundle(root), undefined);
	await rm(path.join(root, "candidate.cpp"));
	await symlink(path.join(root, "verification.json"), path.join(root, "candidate.cpp"));
	await assert.rejects(offlineChecks.collectContinuationBundle(root, bundle), /bounded regular file/);
});
