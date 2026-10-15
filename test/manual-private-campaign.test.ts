import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { offlineChecks } from "../scripts/manual-private-campaign.ts";
import { Workspace } from "../src/workspace.ts";
import { sealCampaignCarry } from "../src/runner/emergency-carry.ts";

test("stagnant assessment and M04 repair stay incomplete while retaining no-merge facts", () => {
	const fullRead = { unreadEvidence: [] } as any;
	assert.equal(offlineChecks.objectiveAssessmentRunCompleted(fullRead,
		"workflow-repair-needed"), false);
	assert.equal(offlineChecks.objectiveAssessmentRunCompleted(fullRead,
		"assessment-failed"), false);
	assert.equal(offlineChecks.objectiveAssessmentRunCompleted(fullRead,
		"objective-reassessment-pending"), true);
	assert.equal(offlineChecks.importM04EffectDisposition({ status: "failed",
		transactionState: "rejected-draft", proposalSubmitted: true,
		snapshotCreated: false, threw: true, repairNeeded: true }), "workflow-repair-needed");
	assert.equal(offlineChecks.failedM04StopReason("failed", "rejected-draft", true),
		"workflow-repair-needed");
	assert.equal(offlineChecks.importM04EffectDisposition({ status: "failed",
		transactionState: "merge-intent", proposalSubmitted: true,
		snapshotCreated: false, threw: true, repairNeeded: true }), "pending-merge-reconciliation");
	assert.equal(offlineChecks.failedM04StopReason("failed", "merge-intent", true),
		"m04-transaction-unresolved");
	const contract = { version: 1 as const, kind: "original-objective" as const,
		id: "synthetic-repair-contract", createdAt: "2030-01-01T00:00:00Z",
		goal: "Synthetic objective", goalSource: "user-intent-summary" as const,
		inputNames: ["input.txt"], obligations: [{ id: "remaining", description: "Continue checking" }],
		closure: "open-ended" as const };
	for (const stage of ["objective-assessment", "m04-judgment"] as const) {
		const progress = offlineChecks.campaignObjectiveProgress(contract, [], {
			boundedRuns: [], selectedArtifacts: [], stopReason: "workflow-repair-needed",
			pendingActionFacts: offlineChecks.workflowRepairActionFacts(stage) });
		assert.equal(progress.objectiveOutcome, "incomplete");
		assert.equal(progress.continuation.nextTask, undefined);
		assert.equal(progress.continuation.pendingAction?.kind, "repair-workflow-state");
		assert.equal(progress.continuation.pendingAction?.failedStage, stage);
		assert.deepEqual(progress.continuation.pendingAction?.evidenceRefs, ["repair-state.json"]);
		assert.equal(progress.continuation.pendingAction?.humanRequired, undefined);
	}
});

test("private driver checkpoints keep inherited and current unknown operations in a host pending action", () => {
	const contract = { version: 1 as const, kind: "original-objective" as const,
		id: "synthetic-contract", createdAt: "2030-01-01T00:00:00Z", goal: "Synthetic research goal",
		goalSource: "user-intent-summary" as const, inputNames: ["synthetic.txt"],
		obligations: [{ id: "quality", description: "Continue checking the result" }],
		closure: "open-ended" as const };
	const checkpoint = offlineChecks.campaignObjectiveProgress(contract,
		["prior-goal/O001", "prior-goal/O002"], {
			boundedRuns: [{ runId: "current-goal", outcome: "active", unresolvedOperationIds: ["O003"] }],
			selectedArtifacts: ["candidate.cpp", "verification.json", "workflow-archive.json"],
			unresolvedOperationIds: ["current-goal/O003"], stopReason: "dispatch-failed" });
	assert.equal(checkpoint.objectiveOutcome, "incomplete");
	assert.equal(checkpoint.stopReason, "dispatch-failed");
	assert.deepEqual(checkpoint.continuation.unresolvedOperationIds,
		["prior-goal/O001", "prior-goal/O002", "current-goal/O003"]);
	assert.equal(checkpoint.continuation.pendingAction?.author, "host");
	assert.equal(checkpoint.continuation.pendingAction?.kind, "reconcile-m07-operation");
	assert.equal(checkpoint.continuation.pendingAction?.safety, "no-replay-until-reconciled");
	assert.deepEqual(checkpoint.continuation.pendingAction?.target?.operationRefs,
		checkpoint.continuation.unresolvedOperationIds);
	assert.equal(checkpoint.continuation.pendingAction?.humanRequired, undefined);
	const cancelled = offlineChecks.campaignObjectiveProgress(contract, [], {
		boundedRuns: [], selectedArtifacts: [], stopReason: "cancelled" });
	assert.equal(cancelled.continuation.pendingAction, undefined);
});

test("host checker protocol rejects extra output and candidate-reported timing cannot drive comparison", () => {
	const metadata = { timing: { repeats: 16, shapes: [[1024, 509], [4096, 2047]], threadCounts: [1, 4] } } as any;
	const rows = [1024, 4096].flatMap((size, index) => [1, 4].flatMap(threads => [1, 2].map(target =>
		`CSR_TIMING target=${target} rows=${size} cols=${index ? 2047 : 509} threads=${threads} repeats=16 elapsed_ns=${1000 * target}`)));
	assert.equal(offlineChecks.parseCheckerOutput([...rows, "CSR_CHECK_PASS"].join("\n"), metadata).status, "passed");
	assert.equal(offlineChecks.parseCheckerOutput(["OpenMP 0.001 ms", ...rows, "CSR_CHECK_PASS"].join("\n"), metadata).status, "failed");
	assert.equal(offlineChecks.parseCheckerOutput([...rows.slice(1), "CSR_CHECK_PASS"].join("\n"), metadata).status, "failed");
	const timings = offlineChecks.parseCheckerOutput([...rows, "CSR_CHECK_PASS"].join("\n"), metadata).timings;
	const baseline = { independent: { status: "passed", timings } };
	const spoof = { independent: { status: "passed", timings }, originalCheckerRuns: [{ reportedKernelMs: [{ label: "OpenMP", ms: 0.001 }] }] };
	assert.equal(offlineChecks.compareCandidateTimings(baseline, spoof).medianRatio, 1);
});

test("same-goal branch selection keeps the verified faster parent when the fork regresses", () => {
	assert.equal(offlineChecks.chooseForkWinner(true, true, true, { state: "measured", medianRatio: 0.9, minRatio: 0.8 }), "parent");
	assert.equal(offlineChecks.chooseForkWinner(true, true, true, { state: "measured", medianRatio: 1.08, minRatio: 0.91 }), "parent");
	assert.equal(offlineChecks.chooseForkWinner(true, true, true, { state: "measured", medianRatio: 1.08, minRatio: 0.97 }), "fork");
	assert.equal(offlineChecks.chooseForkWinner(true, true, false, { state: "measured", medianRatio: 1.08, minRatio: 0.97 }), "parent");
	assert.equal(offlineChecks.chooseForkWinner(false, true, false, { state: "unavailable" }), "fork");
	assert.equal(offlineChecks.chooseForkWinner(false, false, true, { state: "unavailable" }), undefined);
});

test("an accepted measured candidate stays unselected until M04 and its read/export finish", () => {
	const favorable = { state: "measured", medianRatio: 1.25, minRatio: 1.02 };
	const retain = offlineChecks.retainPriorSelectionUntilM04Ready;
	for (const m04 of [
		{ status: "failed", fullSelectedRead: true, knowledgeExportState: "none" },
		{ status: "completed", fullSelectedRead: false, knowledgeExportState: "none" },
		{ status: "completed", fullSelectedRead: true, knowledgeExportState: "incomplete" },
	] as const) assert.equal(retain(m04, true, true, true, favorable), true);
	assert.equal(retain({ status: "completed", fullSelectedRead: true,
		knowledgeExportState: "complete" }, true, true, true, favorable), false);
});

test("settled no-report M07 failure starts a linked fresh task from the selected prior and can reach acceptance", () => {
	const goal = { runId: "R001", goal: "Preserve the original research objective",
		problemRelation: "Original objective", constraints: ["preserve source provenance"],
		successCriteria: ["verified source", "measured result"], plan: "Compare measured candidates",
		tasks: [{ taskId: "T001", mode: "execute", status: "failed", review: undefined,
			executionFailure: "HTTP 502; hidden sk-synthetic-secret", loopStopReason: "output-limit" }],
		executionState: { operations: [{ id: "O001", taskId: "T001", status: "response-received" },
			{ id: "O002", taskId: "T001", status: "partial-settled" }] } } as any;
	const feedback = offlineChecks.settledFailedM07RepairFeedback(goal, "T001",
		{ winner: false, stopped: false, aborted: false });
	assert.equal(feedback?.kind, "m07-settled-failed-task-feedback");
	assert.equal(feedback?.failureCategory, "http-502");
	assert.deepEqual(feedback?.operations, [{ operationId: "O001", status: "response-received" },
		{ operationId: "O002", status: "partial-settled" }]);
	assert.doesNotMatch(JSON.stringify(feedback), /synthetic-secret/);
	const selectedPrior = "/isolated/workspace/objective-seeds/prior-candidate.cpp";
	const spec = { mode: "execute", objective: "Improve this measured candidate",
		inputs: [selectedPrior], expectedOutputs: ["candidate.cpp", "lesson-delta.json"],
		checks: ["verified source", "measured result"], executionLoop: { mode: "until-ready" } } as any;
	const repair = offlineChecks.freshM07RepairPlan(goal, "R001", spec,
		["/isolated/workspace/objective-seeds/review-repair-1.json"], [], "settled-failed");
	assert.equal(repair.goal.goal, goal.goal);
	assert.deepEqual(repair.goal.successCriteria, goal.successCriteria);
	assert.match(repair.goal.problemRelation, /Linked fresh repair.*R001/);
	assert.deepEqual(repair.task.checks, spec.checks);
	assert.deepEqual(repair.task.expectedOutputs, spec.expectedOutputs);
	assert.deepEqual(repair.task.inputs[0], selectedPrior);
	assert.equal(repair.task.context, undefined);
	assert.equal(repair.task.parentTaskId, undefined);
	assert.equal(repair.task.supersedesTaskId, undefined);
	assert.match(repair.task.objective, /do not replay or resume/);
	const acceptedSuccessor = { runId: "R002", tasks: [{ taskId: "T001", status: "accepted" }], outcome: "fulfilled" };
	assert.equal(offlineChecks.firstM07Accepted(acceptedSuccessor.tasks[0].status === "accepted",
		acceptedSuccessor.outcome), true);
});

test("unknown M07 operation or task prevents fresh settled-failure repair", () => {
	const goal = { runId: "R001", tasks: [{ taskId: "T001", mode: "execute", status: "failed" }],
		executionState: { operations: [{ id: "O001", taskId: "T001", status: "unknown" }] } } as any;
	const eligible = (value: any) => offlineChecks.settledFailedM07RepairFeedback(value, "T001",
		{ winner: false, stopped: false, aborted: false });
	assert.equal(eligible(goal), undefined);
	assert.equal(eligible({ ...goal, executionState: { operations: [{ ...goal.executionState.operations[0], status: "issued" }] } }), undefined);
	assert.equal(eligible({ ...goal, executionState: { operations: [{ ...goal.executionState.operations[0], status: "response-received" }] },
		tasks: [...goal.tasks, { taskId: "T002", mode: "execute", status: "unknown" }] }), undefined);
});

test("host effect receipt captures complete task and live session census without replaying a prior receipt", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "mulpis-host-effect-fixture-"));
	try {
		const ws = new Workspace(path.join(root, "workspace"));
		const goalDir = ws.runDir("M07", "R001");
		await mkdir(goalDir, { recursive: true });
		await writeFile(path.join(goalDir, "run.json"), "{}\n");
		await writeFile(path.join(goalDir, "goal.json"), JSON.stringify({ runId: "R001", outcome: "active",
			tasks: [{ taskId: "T001", mode: "execute", status: "rejected", session: { id: "builder" } }],
			executionState: { operations: [{ id: "O001", taskId: "T001", status: "response-received" }] } }));
		const grant = { version: 1 as const, kind: "confined-campaign-files" as const,
			root: path.join(goalDir, "tasks", "T001", "work"), writableFiles: ["candidate.cpp", "lesson-delta.json"] };
		const receipt = await offlineChecks.buildHostEffectReceipt({ ws,
			source: { runId: "1001", runAttempt: 1, commit: "a".repeat(40) },
			priorEnvelopeSha256: "b".repeat(64), historicalGoalRunIds: ["R000"],
			requestIds: ["request-1"], sessions: new Map([
				["builder", { sessionId: "builder", grantKind: "confined-execution" as const,
					taskId: "T001", workRoot: grant.root, grant }],
			]) });
		assert.deepEqual(receipt.goals[0].tasks.map(item => item.status), ["rejected"]);
		assert.deepEqual(receipt.goals[0].operations.map(item => item.status), ["response-received"]);
		assert.deepEqual(receipt.sessions[0].grant, grant);
		const prior = { "candidate.cpp": "// selected\n", "host-effect-receipt.json": JSON.stringify(receipt) };
		const output = path.join(root, "output");
		await mkdir(output);
		assert.equal((await offlineChecks.collectContinuationBundle(output, prior))?.["host-effect-receipt.json"], undefined);
		await writeFile(path.join(output, "host-effect-receipt.json"), `${JSON.stringify(receipt)}\n`);
		assert.equal((await offlineChecks.collectContinuationBundle(output, prior))?.["host-effect-receipt.json"],
			`${JSON.stringify(receipt)}\n`);
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("private task failure diagnostic redacts exact key and authorization tokens", () => {
	const key = "sk-SYNTHETICPRIVATE123456";
	const message = `request failed Authorization: Bearer ${key}\nnext Bearer sk-ANOTHERSYNTHETIC777`;
	const redacted = offlineChecks.privateFailureMessage(message, key);
	assert.ok(redacted);
	assert.equal(redacted.includes(key), false);
	assert.equal(redacted.includes("sk-ANOTHERSYNTHETIC777"), false);
	assert.match(redacted, /REDACTED_KEY/);
});

test("collection failure forces emergency carry even when zero-request normal seal would succeed", () => {
	const collectionFailure = offlineChecks.privateCollectionDiagnostic(
		new Error("research continuation exceeds the authenticated carry capacity"));
	let normalCalls = 0, emergencyCalls = 0;
	const input = { settledCny: 0, unknownObservedCny: 0, unpricedRequestCount: 0,
		requestAudit: { version: 3, kind: "accounting-only-request-audit", requests: [],
			settledCny: 0, unknownObservedCny: 0, unpricedRequestCount: 0 } } as any;
	const sealed = sealCampaignCarry({
		sealCurrent: () => { normalCalls++; return { envelopeB64: "incorrect-normal", sidecars: {},
			observedSettledCny: 0, observedUnknownHeldCny: 0, unpricedRequestCount: 0 }; },
		sealEmergencyCurrent: received => { emergencyCalls++; assert.equal(received, input);
			return { envelopeB64: "synthetic-emergency", sidecars: {}, observedSettledCny: 0,
				observedUnknownHeldCny: 0, unpricedRequestCount: 0 }; },
	}, input, offlineChecks.privateSealOptions(collectionFailure));
	assert.equal(normalCalls, 0);
	assert.equal(emergencyCalls, 1);
	assert.equal(sealed.mode, "emergency-effects-unreviewed");
	if (sealed.mode !== "emergency-effects-unreviewed") return;
	assert.equal(sealed.forcedReason, "research-collection-incomplete");
	const status = offlineChecks.privateEmergencyStatusDiagnostics(collectionFailure, sealed);
	assert.equal(status.archiveFailure, "research-continuation-collection-failed-emergency-preserved");
	assert.equal(status.collectionFailure?.stage, "research-continuation-collection");
	assert.equal(status.collectionFailure?.kind, "host-invariant");
	assert.equal(status.collectionFailure?.invariantClass, "capacity");
	assert.equal(status.collectionFailure?.message,
		"research continuation exceeds the authenticated carry capacity");
	assert.equal("normalSealFailure" in status, false);
});

test("M04 evidence coverage requires exact task files and complete returned text ranges", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "mulpis-m04-coverage-fixture-"));
	try {
		const evidence = path.join(root, "tasks", "T001", "review-snapshot");
		await mkdir(evidence, { recursive: true });
		for (const [index, name] of ["candidate.cpp", "verification.json", "lesson-delta.json"].entries())
			await writeFile(path.join(evidence, `${String(index + 1).padStart(3, "0")}-${name}`), "one\ntwo\n");
		const source = path.join(root, "m07-source.json"), coverage = path.join(root, "m07-coverage.json");
		await writeFile(source, JSON.stringify({ rootDir: root }));
		const paths = ["candidate.cpp", "verification.json", "lesson-delta.json"].map((name, index) =>
			`tasks/T001/review-snapshot/${String(index + 1).padStart(3, "0")}-${name}`);
		const ranges = paths.map(file => ({ path: file, status: "returned", returned: { kind: "text", startLine: 1, endLine: 2, truncated: false } }));
		const record = { outputs: [{ label: "M07 处理来源", path: source },
			{ label: "M07 回流证据实际访问范围", path: coverage }] } as any;
		await writeFile(coverage, JSON.stringify({ returnedRanges: ranges }));
		assert.equal((await offlineChecks.m04EvidenceReturned(record, "T001")).complete, true);
		await writeFile(coverage, JSON.stringify({ returnedRanges: [{ ...ranges[0], returned: { kind: "text", startLine: 1, endLine: 1 } }, ...ranges.slice(1)] }));
		assert.equal((await offlineChecks.m04EvidenceReturned(record, "T001")).complete, false);
		await writeFile(coverage, JSON.stringify({ returnedRanges: [{ ...ranges[0], status: "error" }, ...ranges.slice(1)] }));
		assert.equal((await offlineChecks.m04EvidenceReturned(record, "T001")).complete, false);
		await writeFile(coverage, JSON.stringify({ returnedRanges: [{ ...ranges[0], returned: { ...ranges[0].returned, truncated: true } }, ...ranges.slice(1)] }));
		assert.equal((await offlineChecks.m04EvidenceReturned(record, "T001")).complete, false);
		await writeFile(coverage, JSON.stringify({ returnedRanges: [{ ...ranges[0], path: paths[0].replace("T001", "T002") }, ...ranges.slice(1)] }));
		assert.equal((await offlineChecks.m04EvidenceReturned(record, "T001")).complete, false);
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("registered comparison uses fresh compatible case metrics and cannot hide cold-call regression", () => {
	const row = (target: number, medianNs: number, coldNs: number) => ({ kind: "strategy", target,
		caseId: "shape-a", rows: 4, cols: 8, ordinaryNnz: 2, heavyRows: 1, heavyNnz: 5, seed: 7, threads: 1,
		requestedThreads: 1, actualThreads: "not_observed",
		warmups: 1, repeats: 3, medianNs, coldNs });
	const evidence = (rows: object[], metric = "isolated-worker-roundtrip") => ({ registeredExperiment: { status: "passed", metric, timings: rows, freshProcessPerSelection: true,
		threadPolicy: { threadsMeaning: "requested-default-and-openmp-cap", actualThreads: "not_observed", description: "synthetic fixed thread policy" },
		compileFlags: ["-O2"], accounting: "first-call-and-warmups-separate-from-steady-state", measurementAuthority: "parent-clock-and-raw-output-comparison",
		baselineIsolation: "independently-compiled-immutable-original", runtimeFiles: "read-only-evaluator-with-separate-writable-scratch" } });
	const prior = evidence([row(1, 100, 200), row(2, 120, 240)]);
	const broader = evidence([row(1, 90, 190), row(2, 110, 220), row(3, 50, 100)]);
	const compared = offlineChecks.compareCandidateTimings(prior, broader);
	assert.equal(compared.state, "measured");
	assert.deepEqual(compared.ratios, [2, 2]);
	assert.match(compared.scope!, /exact-case-with-cold-cost/);
	assert.equal(offlineChecks.compareCandidateTimings(prior, evidence([row(1, 50, 100)], "kernel-only")).state, "unavailable");
	assert.equal(offlineChecks.compareCandidateTimings(prior, evidence([{ ...row(1, 50, 100), seed: 9 }])).state, "unavailable");
	const differentFlags = evidence([row(1, 50, 100)]);
	differentFlags.registeredExperiment.compileFlags = ["-O0"];
	assert.equal(offlineChecks.compareCandidateTimings(prior, differentFlags).state, "unavailable");
	const missingPolicy = evidence([row(1, 50, 100)]) as any;
	delete missingPolicy.registeredExperiment.threadPolicy;
	assert.equal(offlineChecks.compareCandidateTimings(prior, missingPolicy).state, "unavailable");
	const oldRows = evidence([{ ...row(1, 50, 100), actualThreads: undefined }]);
	assert.equal(offlineChecks.compareCandidateTimings(prior, oldRows).state, "unavailable");
	const regression = offlineChecks.compareCandidateTimings(prior, evidence([row(1, 50, 500)]));
	assert.equal(offlineChecks.chooseFollowOnCandidate(true, true, true, regression), false);
});
