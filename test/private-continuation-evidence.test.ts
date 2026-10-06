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

test("continuation rejects changed original source, contract, input identities, or selected historical task", () => {
	const { bundle, binding } = fixture();
	const validate = (value: PrivateContinuationBundle) =>
		offlineChecks.validateContinuationSeed(value, inputNames, binding, originalSource);
	assert.throws(() => offlineChecks.validateContinuationSeed(bundle, inputNames, binding, `${originalSource}changed`));
	assert.throws(() => offlineChecks.validateContinuationSeed(bundle, inputNames, { ...binding, contractId: "other-contract" }, originalSource));
	assert.throws(() => offlineChecks.validateContinuationSeed(bundle, [...inputNames].reverse(), binding, originalSource));
	for (const change of [
		(value: any) => { value.version = 2; },
		(value: any) => { value.contract.id = "other-contract"; },
		(value: any) => { value.contract.createdAt = "not-a-date"; },
		(value: any) => { value.contract.closure = "finite-evidence"; },
		(value: any) => { value.boundedRuns[0].selectedTaskId = "T002"; },
		(value: any) => { value.boundedRuns[0].runId = "other-goal"; },
	]) assert.throws(() => validate(changedFile(bundle, "objective-checkpoint.json", change)));
	assert.throws(() => validate(changedFile(bundle, "original-objective.json", value => { value.goal = "silently replaced goal"; })));
	for (const change of [
		(value: any) => { value.taskId = "T002"; },
		(value: any) => { value.goalRunId = "other-goal"; },
		(value: any) => { value.version = 2; },
		(value: any) => { value.controllerEvidence.reviewStatus = "rejected"; },
	]) assert.throws(() => validate(changedFile(bundle, "workflow-archive.json", change)));
	assert.throws(() => validate(changedFile(bundle, "verification.json", value => { value.status = "failed"; })));
	assert.throws(() => validate(changedFile(bundle, "verification.json", value => { value.version = 2; })));
});

test("continuation accepts historical accepted-task binding without inventing branch selection", () => {
	const { bundle, binding } = fixture();
	const historical = changedFile(bundle, "objective-checkpoint.json", value => {
		delete value.boundedRuns[0].selectedTaskId;
		value.boundedRuns[0].acceptedTaskIds = ["T001"];
	});
	const restored = offlineChecks.validateContinuationSeed(historical, inputNames, binding, originalSource);
	assert.deepEqual(restored.checkpoint.boundedRuns[0].acceptedTaskIds, ["T001"]);
	assert.equal(restored.checkpoint.boundedRuns[0].selectedTaskId, undefined);
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

test("continuation rejects missing selected evidence and mismatched historical knowledge binding", () => {
	const { bundle, binding } = fixture();
	for (const name of ["candidate.cpp", "verification.json", "workflow-archive.json", "objective-checkpoint.json"] as const) {
		const missing = { ...bundle }; delete missing[name];
		assert.throws(() => offlineChecks.validateContinuationSeed(missing, inputNames, binding, originalSource));
	}
	for (const change of [
		(value: any) => { value.version = 2; },
		(value: any) => { value.m04RunId = "other-m04"; },
		(value: any) => { value.adoptedExperienceRefs = [{ storeId: "other-store", recordId: "synthetic-record", version: 1 }]; },
		(value: any) => { value.adoptedExperienceRefs = [{ storeId: "synthetic-store", recordId: "synthetic-record", version: 0 }]; },
	]) assert.throws(() => offlineChecks.validateContinuationSeed(
		changedFile(bundle, "m04-adopted-knowledge.json", change), inputNames, binding, originalSource), /knowledge export/);
});

test("failed new attempt keeps coherent prior tuple and plan while updating the current objective checkpoint", async t => {
	const root = await mkdtemp(path.join(os.tmpdir(), "synthetic-continuation-evidence-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const { bundle, checkpoint, contract } = fixture();
	const priorCopy = structuredClone(bundle);
	const nextCheckpoint = { ...checkpoint, stopReason: "time-boundary",
		boundedRuns: [...checkpoint.boundedRuns, { runId: "synthetic-new-goal", outcome: "partial" }] };
	await writeFile(path.join(root, "candidate.cpp"), "// Synthetic failed new source.\n");
	await writeFile(path.join(root, "verification.json"), json({ version: 1, status: "failed" }));
	await writeFile(path.join(root, "workflow-archive.json"), json({ version: 1, kind: "m07-private-candidate-archive",
		goalRunId: "synthetic-new-goal", taskId: "T002", controllerEvidence: { reviewStatus: "rejected" } }));
	await writeFile(path.join(root, "experiment-plan.json"), json({ rejected: "new-plan" }));
	await writeFile(path.join(root, "original-objective.json"), json(contract));
	await writeFile(path.join(root, "objective-checkpoint.json"), json(nextCheckpoint));
	const receipts = json({ version: 1, receipts: [{ runId: "synthetic-prior-assessment" }, { runId: "synthetic-new-assessment" }] });
	await writeFile(path.join(root, "objective-assessment-receipts.json"), receipts);
	const carry = await offlineChecks.collectContinuationBundle(root, bundle);
	assert.ok(carry);
	for (const name of ["candidate.cpp", "verification.json", "workflow-archive.json", "experiment-plan.json", "m04-adopted-knowledge.json"] as const)
		assert.equal(carry[name], bundle[name]);
	assert.equal(carry["objective-checkpoint.json"], json(nextCheckpoint));
	assert.equal(carry["objective-assessment-receipts.json"], receipts);
	assert.equal(carry["original-objective.json"], bundle["original-objective.json"]);
	assert.deepEqual(bundle, priorCopy);
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

test("historical machine evidence has a lossless range-readable view rather than a truncated long JSON line", () => {
	const largeVerification = JSON.stringify({ samples: "x".repeat(100_000), final: "last recorded value" });
	const history = { version: 1, kind: "untrusted-version-bound-research-history", entries: [
		{ originalContractId: "synthetic-contract", goalRunId: "synthetic-run", taskId: "T001", files: { "verification.json": largeVerification } },
	] };
	const view = offlineChecks.rangeReadableHistory(JSON.stringify(history));
	assert.ok(view.split("\n").every(line => line.length < 3_000));
	const parsed = JSON.parse(view);
	assert.equal(parsed.entries[0].files["verification.json"].segments.join(""), largeVerification);
	assert.equal(parsed.entries[0].files["verification.json"].encoding, "concatenated-utf16-string-segments");
});
