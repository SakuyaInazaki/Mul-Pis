import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir, stat, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import test from "node:test";
import { offlineChecks } from "../scripts/manual-private-campaign.ts";
import { reserveIndependentRestart } from "../src/m07/independent-restart.ts";
import { verifyDeepSeekCnyBilling } from "../src/runner/deepseek-cny-pricing.ts";
import { isVerifiedDeepSeekAvailability } from "../src/runner/deepseek-availability.ts";
import { verifyDeepSeekProviderOutputLimit } from "../src/runner/deepseek-provider-limits.ts";
import { Workspace } from "../src/workspace.ts";
import { HarnessError } from "../src/types.ts";
import { sealCampaignCarry } from "../src/runner/emergency-carry.ts";
import { encodeCarrySidecars, decodeCarrySidecars } from "../src/runner/carry-sidecar-codec.ts";
import { CARRY_SEGMENT_FILE_BYTES } from "../src/runner/carry-sidecar-codec.ts";
import { validatePriorGroundingIndex } from "../src/m07/assessor-grounding.ts";
import { runOriginalObjectiveLoop } from "../src/m07/objective-progress.ts";
import { PrivateAssessorDiagnosticError } from "../src/runner/private-assessor-diagnostic.ts";

test("shared-total campaign requires explicit manual admission and signed cumulative ledger", async () => {
 const workflow = await readFile(new URL("../.github/workflows/manual-private-campaign.yml", import.meta.url), "utf8");
 const gate = workflow.split("  private-campaign:\n")[1]?.split("    runs-on:")[0] ?? "";
 const triggers = workflow.split(/^on:\s*$/m)[1]?.split(/^permissions:\s*$/m)[0] ?? "";
 assert.deepEqual([...triggers.matchAll(/^  ([A-Za-z_][\w-]*):/gm)].map(match => match[1]),
  ["push", "workflow_dispatch"]);
 assert.ok(triggers.includes("run-requests/workflow-learning-reliability"));
 assert.doesNotMatch(triggers, /^\s+- improve\/workflow-learning-reliability\s*$/m);
 assert.ok(gate.includes("github.repository == 'SakuyaInazaki/Mul-Pis'"));
 assert.ok(gate.includes("github.actor == 'SakuyaInazaki'"));
 assert.ok(gate.includes("github.run_attempt == 1"));
 assert.ok(gate.includes("github.event_name == 'workflow_dispatch'"));
 assert.ok(gate.includes("github.ref == 'refs/heads/improve/workflow-learning-reliability'"));
 assert.ok(gate.includes("inputs.authorize_bounded_run == true"));
 assert.ok(workflow.includes("MULPIS_MISSION_LEDGER_B64: ${{ secrets.MULPIS_MISSION_LEDGER_B64 }}"));
 assert.doesNotMatch(workflow, /inputs\.mission_ledger_b64/);
 assert.ok(workflow.includes("github.event.head_commit.message == 'Run confidential workflow'"));
 assert.ok(workflow.includes("github.ref == 'refs/heads/run-requests/workflow-learning-reliability'"));
 assert.ok(workflow.includes("Verify reusable control-branch request and accepted source CI"));
 assert.ok(workflow.includes("git rev-parse HEAD^{tree}"));
 assert.ok(workflow.includes("workflow-regression.yml/runs"));
 assert.ok(workflow.includes("MULPIS_RUN_REQUEST_BEFORE: ${{ github.event.before }}"));
 assert.ok(workflow.includes("GITHUB_TOKEN: ${{ github.token }}"));
 assert.ok(workflow.includes("  actions: read"));
 assert.doesNotMatch(workflow, /up to [0-9.]+ CNY/);
});

test("production campaign forwards the live carry archive digest to its downloader", async () => {
	const source = await readFile(new URL("../scripts/manual-private-campaign.ts", import.meta.url), "utf8");
	assert.match(source,
		/loadCarryArtifact:\s*\(\{\s*artifactId,\s*expectedArchiveSha256\s*\}\)\s*=>\s*downloadCarryArtifact\(\{\s*githubToken:[^}]*artifactId,\s*expectedArchiveSha256\s*\}\)/);
});

test("both private original-objective assessor stages persist validation failures", async () => {
	const source = await readFile(new URL("../scripts/manual-private-campaign.ts", import.meta.url), "utf8");
	const callbacks = [...source.matchAll(/recordValidationFailure:\s*diagnostic\s*=>\s*saveAssessorValidationDiagnostic\(outputDir,\s*diagnostic\)/g)];
	assert.equal(callbacks.length, 2);
	assert.match(source, /assessorDiagnosticFailure:\s*statusAssessorDiagnosticFailure/);
	assert.match(source,
		/secondGoal\.runId,\s*nextArchiveDir,\s*outputDir,\s*`iteration-\$\{iteration\}`/);
});

test("frozen host capability rows ground unavailable scopes without granting dispatch", () => {
	const adapters = [
		{ scope: "two-target-existing", available: false, description: "Prior adapter", limits: ["diagnostic only"] },
		{ scope: "registered-csr-experiment", available: true, description: "Current adapter", limits: ["CPU"] },
		{ scope: "outside-current-adapter", available: false, description: "No executor", limits: ["no grant"] },
	];
	const unavailable = offlineChecks.observedUnavailableCapabilities(adapters,
		["GPU execution", "privileged hardware counters"],
		{ maxThreads: 4, maxTimedWork: 200_000_000, minRepeats: 3 });
	const scopes = unavailable.map(row => row.scope);
	assert.deepEqual(scopes, ["two-target-existing", "outside-current-adapter",
		"host.unavailable.observation-1", "host.unavailable.observation-2",
		"host.unavailable.above-max-threads", "host.unavailable.above-max-timed-work",
		"host.unavailable.below-min-repeats"]);
	assert.ok(unavailable.every(row => !row.available));
	const serialized = `${JSON.stringify({ version: 1, unavailableCapabilities: unavailable }, null, 2)}\n`;
	const locators = offlineChecks.frozenCapabilityLocators(serialized, unavailable);
	const lines = serialized.split("\n");
	for (const scope of scopes) {
		const ref = locators[scope];
		assert.equal(ref.sourceId, "host-capabilities.json");
		assert.equal(ref.startLine, ref.endLine);
		assert.equal(lines[ref.startLine - 1]!.trim(), `"scope": ${JSON.stringify(scope)},`);
	}
	const adapterIds = new Set(adapters.map(row => row.scope));
	const runtime = [...adapters, ...unavailable.filter(row => !adapterIds.has(row.scope))];
	const supported = offlineChecks.OBJECTIVE_SUPPORTED_TASK_SCOPES;
	assert.deepEqual(supported, ["two-target-existing", "registered-csr-experiment"]);
	for (const row of unavailable)
		assert.equal(Boolean(runtime.find(item => item.scope === row.scope)?.available &&
			supported.includes(row.scope as "two-target-existing" | "registered-csr-experiment")), false);
});

test("driver retains the initiating private validator cause when diagnostic storage fails", async t => {
	const root = await mkdtemp(path.join(os.tmpdir(), "mulpis-assessor-status-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const blockedOutput = path.join(root, "not-an-output-directory");
	await writeFile(blockedOutput, "file");
	await assert.rejects(offlineChecks.saveAssessorValidationDiagnostic(blockedOutput, {
		sessionId: "synthetic-session", generation: 2, attempt: 3,
		rawResponse: "PRIVATE_INVALID_REPLY_MARKER",
		validation: { code: "m07.objective-assessment",
			message: "prior grounding delta is invalid", path: "$.groundedAssessmentDelta.nextTask",
			detail: "assessor-grounding: next task needs a feasible scope and decision-changing hypothesis" },
		coverage: [{ sourceId: "original-objective.json", required: true,
			coveredRanges: [[1, 2]], complete: true }]
	}), error => error instanceof Error && "code" in error && error.code === "invalid-root");
	const status = offlineChecks.assessorDiagnosticFailureSnapshot();
	assert.deepEqual(status, { code: "invalid-root", generation: 2, attempt: 3,
		validatorCode: "m07.objective-assessment", validatorMessage: "prior grounding delta is invalid",
		validatorPath: "$.groundedAssessmentDelta.nextTask",
		validatorDetail: "assessor-grounding: next task needs a feasible scope and decision-changing hypothesis" });
	assert(!JSON.stringify(status).includes("PRIVATE_INVALID_REPLY_MARKER"));
});

test("private diagnostic failure retains only fixed OS codes, never error text or paths", () => {
	for (const code of ["EACCES", "ENOSPC"] as const) {
		const raw = Object.assign(new Error("private location and reply text"), { code,
			path: "/private/model/reply" });
		assert.deepEqual(offlineChecks.assessorDiagnosticFailureCause(raw),
			{ code: "unclassified-write-failure", osErrorCode: code });
		assert.deepEqual(offlineChecks.assessorDiagnosticFailureCause(
			new PrivateAssessorDiagnosticError("write-failed", raw)),
			{ code: "write-failed", osErrorCode: code });
	}
	for (const value of [45, { secret: "private" }, "RAW_PRIVATE_PATH", null]) {
		const raw = Object.assign(new Error("private location"), { code: value });
		assert.deepEqual(offlineChecks.assessorDiagnosticFailureCause(raw),
			{ code: "unclassified-write-failure" });
	}
	assert.deepEqual(offlineChecks.assessorDiagnosticFailureCause(
		{ get code(): never { throw new Error("private getter"); } }),
		{ code: "unclassified-write-failure" });
});

test("failed research collection retains typed unresolved M04 quarantine for emergency carry", () => {
	const old = { "candidate.cpp": "synthetic selected source" };
	const typed = '{"version":1,"kind":"unresolved-historical-m04-quarantine","entries":[]}';
	const retained = offlineChecks.collectorFailureBundle(old, undefined, typed);
	assert.equal(retained?.["candidate.cpp"], old["candidate.cpp"]);
	assert.equal(retained?.["m04-transaction-quarantine.json"], typed);
});

test("both private assessor stages register frozen source roles and retain prior issue identity", () => {
	const contract = { version: 1 as const, kind: "original-objective" as const,
		id: "synthetic-grounding-contract", createdAt: "2030-01-01T00:00:00Z",
		goal: "Synthetic research goal", goalSource: "user-intent-summary" as const,
		inputNames: ["input.txt"], obligations: [{ id: "core", description: "Compare strategy" }],
		closure: "open-ended" as const };
	const previous = offlineChecks.campaignObjectiveProgress(contract, [], {
		boundedRuns: [], selectedArtifacts: ["candidate.cpp", "verification.json", "workflow-archive.json"],
		stopReason: "assessment-validation-pending" });
	previous.continuation.unresolvedDetails = ["Legacy unclassified observation"];
	const evidence = [
		{ name: "host-capabilities.json", file: "/synthetic/capabilities" },
		{ name: "original-problem.txt", file: "/synthetic/problem" },
		{ name: "original-input-1.txt", file: "/synthetic/input" },
		{ name: "candidate.cpp", file: "/synthetic/candidate" },
		{ name: "workflow-archive.json", file: "/synthetic/archive" }];
	const first = offlineChecks.assessorGroundingPolicy(evidence, previous);
	assert.equal(first.require, true);
	assert.deepEqual(first.sourceKinds, {
		"host-capabilities.json": "host-capability", "original-problem.txt": "supplied-task",
		"original-input-1.txt": "supplied-task", "candidate.cpp": "selected-evidence",
		"workflow-archive.json": "selected-evidence" });
	assert.deepEqual(first.legacyOpenDetails, ["Legacy unclassified observation"]);
	assert.deepEqual(first.previousIssues, []);
	assert.deepEqual(first.newEvidenceSourceIds, ["host-capabilities.json"]);
	const latest = { groundedAssessment: { legacyOpenDetails: ["Legacy unclassified observation"],
		issues: [{ id: "issue-1" }] } } as any;
	const later = offlineChecks.assessorGroundingPolicy(evidence, previous, latest);
	assert.deepEqual(later.previousIssues.map(issue => issue.id), ["issue-1"]);
	assert.deepEqual(later.legacyOpenDetails, first.legacyOpenDetails);
	const selected = offlineChecks.assessorGroundingPolicy(evidence, previous, latest, true);
	assert.deepEqual(selected.newEvidenceSourceIds,
		["candidate.cpp", "workflow-archive.json"]);
	const access = offlineChecks.assessorEvidenceAccess([...evidence,
		{ name: "prior-research-history-index.json", file: "/synthetic/history-index" },
		{ name: "prior-research-history-part-000001.txt", file: "/synthetic/history-part" }]);
	assert.equal(access["original-problem.txt"], "required");
	assert.equal(access["candidate.cpp"], "required");
	assert.equal(access["prior-research-history-index.json"], "required");
	assert.equal(access["prior-research-history-part-000001.txt"], "retrievable");
});

test("prior assessor issue memory is frozen in indexed bounded parts without prompt echo", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "mulpis-grounding-index-"));
	try {
		const legacyOpenDetails = ["Earlier unclassified method observation"];
		const previousIssues = [{ id: "issue-1", claim: "Synthetic verification gap",
			status: "open" as const, classification: "necessary-verification" as const,
			sourceRefs: [{ sourceId: "original-problem.txt", startLine: 1, endLine: 1 }],
			implication: "The result claim needs a check", claimAtRisk: "Synthetic result" }];
		const staged = await offlineChecks.stagePriorGroundingRecords(root,
			{ legacyOpenDetails, previousIssues });
		const indexText = await readFile(staged.evidence[0]!.file, "utf8");
		const parts = Object.fromEntries(await Promise.all(staged.evidence.slice(1).map(async row =>
			[row.name, await readFile(row.file, "utf8")] as const)));
		const locators = validatePriorGroundingIndex(indexText, parts,
			{ legacyOpenDetails, previousIssues });
		assert.deepEqual(locators["issue-1"], { sourceId: staged.priorGroundingIndex.partNames[0],
			startLine: 2, endLine: 2 });
		assert((await Promise.all(staged.evidence.map(async row =>
			(await stat(row.file)).size))).every(size => size <= 1_000_000));
		assert.equal(offlineChecks.assessorEvidenceAccess(staged.evidence)[staged.evidence[0]!.name],
			"required");
		assert.equal(offlineChecks.assessorEvidenceAccess(staged.evidence)[staged.evidence[1]!.name],
			"retrievable");
	} finally { await rm(root, { recursive: true, force: true }); }
});

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

test("observed read-only transport failure cannot become a new optimizer task", () => {
	const contract = { version: 1 as const, kind: "original-objective" as const,
		id: "synthetic-contract", createdAt: "2030-01-01T00:00:00Z", goal: "Synthetic research goal",
		goalSource: "user-intent-summary" as const, inputNames: ["synthetic.txt"],
		obligations: [{ id: "quality", description: "Continue checking the result" }],
		closure: "open-ended" as const };
	const checkpoint = (diagnosticCount: number,
		stage: "read-only-assessor" | "m07-execution", unknowns: string[] = []) =>
		offlineChecks.campaignObjectiveProgress(contract, [], { boundedRuns: [],
			selectedArtifacts: ["candidate.cpp", "verification.json", "workflow-archive.json"],
			stopReason: "dispatch-failed", unresolvedOperationIds: unknowns,
			pendingActionFacts: offlineChecks.observedTransportActionFacts("dispatch-failed",
				Array.from({ length: diagnosticCount }, (_, index) => ({ requestId: `request-${index}` })) as any,
				{ version: 3, kind: "accounting-only-request-audit", requests: [] } as any, stage) });
	assert.equal(checkpoint(1, "read-only-assessor").continuation.pendingAction?.kind,
		"retry-transport");
	assert.equal(checkpoint(0, "read-only-assessor").continuation.pendingAction?.kind,
		"retry-readonly-assessment");
	assert.equal(checkpoint(0, "m07-execution").continuation.pendingAction?.kind,
		"fresh-m07-task");
	assert.equal(checkpoint(1, "m07-execution", ["goal/O001"]).continuation.pendingAction?.kind,
		"reconcile-m07-operation");
});

test("recovered context rejection does not recast a later stage failure as transport failure", () => {
	const diagnostics = [{ requestId: "rejected-400" }];
	const audit = { version: 3, kind: "accounting-only-request-audit", requests: [
		{ requestId: "rejected-400", contextRejected: true, responseReceived: true,
			reportedUsage: null },
		{ requestId: "reserved-retry", retryOfRequestId: "rejected-400",
			responseReceived: true, reportedUsage: { totalTokens: 14 } },
	] };
	const unrelatedFailure = offlineChecks.observedTransportActionFacts("assessment-failed",
		diagnostics as any, audit as any, "read-only-assessor");
	assert.deepEqual(unrelatedFailure, { failedStage: "read-only-assessor" });
	const retryFailed = offlineChecks.observedTransportActionFacts("assessment-failed",
		[...diagnostics, { requestId: "reserved-retry" }] as any, audit as any, "read-only-assessor");
	assert.deepEqual(retryFailed, { failedStage: "read-only-assessor", transportFailure: true });
	const retryNotReceived = { ...audit, requests: [audit.requests[0],
		{ ...audit.requests[1], responseReceived: false, reportedUsage: null }] };
	assert.deepEqual(offlineChecks.observedTransportActionFacts("assessment-failed",
		diagnostics as any, retryNotReceived as any, "read-only-assessor"),
		{ failedStage: "read-only-assessor", transportFailure: true });
});

test("private campaign collects a recovered transport failure once per handle", async () => {
	const recovered = { version: 1, promptIndex: 1, phase: "response-body", httpStatus: 400,
		responseStarted: true, bytesRead: 120, abortSource: null, providerErrorCode: "invalid_request_error",
		providerErrorType: "invalid_request_error", providerErrorReasonClass: "context-window",
		providerRequestId: null, errorCodes: [] } as const;
	const rows = [recovered];
	const diagnostics: typeof recovered[] = [];
	let prompts = 0;
	const handle = { prompt: async () => {
		prompts++;
		return { text: `reply ${prompts}` };
	}, transportDiagnostics: () => [...rows] } as any;
	const observed = offlineChecks.observeTransport(handle, diagnostics as any);
	assert.deepEqual(await observed.prompt("first"), { text: "reply 1" });
	assert.deepEqual(diagnostics, [recovered]);
	assert.deepEqual(await observed.prompt("second"), { text: "reply 2" });
	assert.deepEqual(diagnostics, [recovered]);
});

test("host preflight violation becomes a concrete incomplete repair plan without request replay", () => {
	const diagnostic = { wholePromptNotIssued: true, requestContractViolation: "orphan-tool-result",
		requestContractMessageIndex: 3 } as any;
	const staticReason = offlineChecks.observedRequestContract(1, [{}, diagnostic] as any);
	assert.deepEqual(staticReason, { violation: "orphan-tool-result", messageIndex: 3 });
	assert.equal(offlineChecks.observedRequestContract(1, [{},
		{ ...diagnostic, wholePromptNotIssued: undefined }] as any), undefined);
	const archiveReason = offlineChecks.archivedRequestContract({ loopStopReason: "request-contract-invalid",
		controllerEvidence: { operationOutcomes: [{ status: "not-issued", requestContractNotIssued: {
			violation: "orphan-tool-result", messageIndex: 3 } }] } } as any);
	assert.deepEqual(archiveReason, staticReason);
	const contract = { version: 1 as const, kind: "original-objective" as const,
		id: "synthetic-contract", createdAt: "2030-01-01T00:00:00Z", goal: "Synthetic research goal",
		goalSource: "user-intent-summary" as const, inputNames: ["synthetic.txt"],
		obligations: [{ id: "quality", description: "Continue checking the result" }],
		closure: "open-ended" as const };
	const checkpoint = offlineChecks.campaignObjectiveProgress(contract, [], { boundedRuns: [],
		selectedArtifacts: ["candidate.cpp", "verification.json", "workflow-archive.json"],
		stopReason: "request-contract-invalid", pendingActionFacts: { requestContract: staticReason } });
	assert.equal(checkpoint.objectiveOutcome, "incomplete");
	assert.equal(checkpoint.continuation.pendingAction?.kind, "repair-request-contract");
	assert.equal(checkpoint.continuation.pendingAction?.humanRequired, undefined);
});

test("private history evidence distinguishes the sealed baseline from unquantified executed gaps", () => {
	const baseline = { source: { runId: "7001", runAttempt: 1, commit: "a".repeat(40) },
		resultArtifact: { immutableRef: "synthetic-baseline-result", digestScope: "github-artifact-archive",
			sha256: "b".repeat(64) } } as any;
	const gap = { source: { runId: "7002", runAttempt: 1, runNumber: 2, commit: "c".repeat(40) },
		resultArtifact: { repository: "synthetic/repository", runId: "7002", artifactId: "8002",
			artifactName: "synthetic-result", digestScope: "github-artifact-archive",
			archiveSha256: "d".repeat(64) } } as any;
	const acceptedNoRun = { version: 1 as const, kind: "unobserved-control-delivery" as const,
		controlCommit: "e".repeat(40), testedSourceCommit: "f".repeat(40),
		testedSourceTree: "1".repeat(40), previousControlParent: "2".repeat(40),
		admittedBy: { runId: "7003", runAttempt: 1, runNumber: 3, commit: "3".repeat(40) },
		observedRunsAtAdmission: 0 as const, effects: "unknown-unreconciled" as const,
		accounting: "unquantified" as const };
	const evidence = offlineChecks.historicalGapEvidence(baseline, [gap], true,
		[acceptedNoRun]) as any;
	assert.equal(evidence.baselineCarry.source.runId, "7001");
	assert.equal(evidence.baselineCarry.resultArtifact.immutableArtifactRef, "synthetic-baseline-result");
	assert.equal(evidence.opaqueExecutedRuns[0].source.runId, "7002");
	assert.match(evidence.opaqueExecutedRuns[0].resultArtifact.immutableArtifactRef, /\/runs\/7002\/artifacts\/8002\//);
	assert.equal(evidence.opaqueExecutedRuns[0].accounting, "unquantified");
	assert.equal(evidence.opaqueExecutedRuns[0].effectState, "unknown-unreconciled");
	assert.doesNotMatch(JSON.stringify(evidence.opaqueExecutedRuns[0]), /settledCny|chargedCny|effects.*reviewed/);
	assert.equal(evidence.unobservedControlDeliveries[0].controlCommit, acceptedNoRun.controlCommit);
	assert.equal(evidence.unobservedControlDeliveries[0].observedRunsAtAdmission, 0);
	assert.equal(evidence.unobservedControlDeliveries[0].accounting, "unquantified");
	assert.equal(evidence.unobservedControlDeliveries[0].effectState, "unknown-unreconciled");
	assert.equal(evidence.opaqueExecutedRuns.length, 1,
		"a missing Actions run is not an opaque executed-run fee observation");
	const expired = offlineChecks.historicalGapEvidence({ ...baseline,
		resultArtifact: undefined }, [gap], false) as any;
	assert.equal(expired.baselineCarry.resultArtifact.state, "expired-or-unavailable");
	assert.equal(expired.opaqueExecutedRuns[0].resultArtifact.artifactSha256, "d".repeat(64));
});

test("new campaign has no host time, call-count, iteration or round quota", async () => {
	const workflow = await readFile(new URL("../.github/workflows/manual-private-campaign.yml", import.meta.url), "utf8");
	assert.doesNotMatch(workflow, /timeout-minutes:/);
	const source = await readFile(new URL("../scripts/manual-private-campaign.ts", import.meta.url), "utf8");
	assert.doesNotMatch(source, /CAMPAIGN_MS|BUILDER_PHASE_MS|M04_PHASE_MS|MAX_PROVIDER_CALLS|BUILDER_ROUNDS|newPhaseAdmitted|executionDeadlineAt|maxProviderCallsPerPrompt|timeout:\s*[0-9]/);
	assert.match(source, /executionLoop: \{ mode: "until-ready" \}/);
});

test("driver checkpoint synchronization matches a generic reservation with a proved bare alias", async () => {
	const hash = (value: string) => createHash("sha256").update(value).digest("hex");
	const contract = { version: 1, kind: "original-objective", id: "synthetic-contract" };
	const checkpoint = { version: 1, kind: "original-objective-progress", contract,
		selectedArtifacts: ["candidate.cpp", "verification.json", "workflow-archive.json"],
		boundedRuns: [
			{ runId: "selected-goal", outcome: "fulfilled", selectedTaskId: "T001",
				acceptedTaskIds: ["T001"], unresolvedOperationIds: [] },
			{ runId: "old-goal", outcome: "active", unresolvedOperationIds: ["O002"] },
			{ runId: "new-goal", outcome: "active", unresolvedOperationIds: ["O001"] }],
		continuation: { unresolvedOperationIds: ["old-goal/O002", "O001", "new-goal/O001"],
			requiresOperationReconciliation: true } };
	const bundle = { "original-objective.json": JSON.stringify(contract),
		"objective-checkpoint.json": JSON.stringify(checkpoint), "candidate.cpp": "// selected synthetic source\n",
		"verification.json": JSON.stringify({ version: 1, status: "passed" }),
		"workflow-archive.json": JSON.stringify({ version: 1, taskId: "T001" }) };
	const facts = { source: { runId: "111", runAttempt: 1, commit: "a".repeat(40) },
		currentRun: { runId: "222", runAttempt: 1, commit: "b".repeat(40) },
		envelopeSha256: hash("prior-envelope"),
		privateBundleSha256: hash(JSON.stringify(Object.fromEntries(Object.entries(bundle).sort(([a], [b]) => a.localeCompare(b))))),
		terminal: { state: "terminal" as const, sourceRunId: "111", sourceRunAttempt: 1,
			observationDigest: hash("terminal"), observedAt: "2030-01-01T00:00:00Z" },
		resultArtifact: { immutableRef: "synthetic-artifact", digestScope: "github-artifact-archive",
			sha256: hash("encrypted-archive") }, committedNano: 1000, unknownHeldNano: 1 };
	const input = { authenticatedCarryProof: { fixture: true }, privateBundle: bundle,
		unobservedControlDeliveries: [],
		freshWorkspace: { workspaceId: "mulpis-private-campaign-synthetic", restartNonce: "nonce" },
		freshBoundary: { campaignRoot: "/tmp/mulpis-private-campaign-synthetic",
			workspaceRoot: "/tmp/mulpis-private-campaign-synthetic/workspace",
			storeRoot: "/tmp/mulpis-private-campaign-synthetic/workspace/.agent/knowledge",
			storeEmpty: true as const, sessionCensusEmpty: true as const,
			sessionMode: "no-prior-session-resume" as const,
			grantProfile: "private-confined-read-dir" as const,
			externalWriteTools: false as const, sharedStore: false as const,
			selectedRevalidated: true as const },
		failedHistory: { state: "unavailable" as const, reason: "Synthetic encrypted evidence gap",
			immutableArtifactRef: facts.resultArtifact.immutableRef, digestScope: facts.resultArtifact.digestScope,
			artifactSha256: facts.resultArtifact.sha256 } };
	const reservation = await reserveIndependentRestart(input, {
		authenticatedFacts: proof => proof === input.authenticatedCarryProof ? facts : undefined,
		reviewEffects: async (_facts, refs) => ({ sourceCommit: facts.source.commit,
			policyId: "synthetic-reviewed-policy", policySha256: hash("policy"),
			unobservedControlLineage: { priorSource: { ...facts.source },
				admissionSource: { ...facts.currentRun }, count: 0, sha256: hash(JSON.stringify([])) },
			operationAttestations: refs.map(operationRef => ({ operationRef,
				sourceCommit: facts.source.commit, evidenceSha256: hash(operationRef) })),
			effectClass: "historical-unknown-fresh-only", unknownBillingHeld: true,
			actorThirdPartyMutations: "unknown", hostTransport: "immutable-versioned-archive",
			accountingObservation: { historicalCommittedNano: facts.committedNano,
				historicalUnknownHeldNano: facts.unknownHeldNano, settledNano: 0,
				unknownObservedNano: 0, unpricedRequestCount: 0,
				opaqueUnquantifiedRunCount: 0 } }),
		revalidateSelection: async ({ tupleSha256 }) => ({ status: "passed", contractId: contract.id,
			selectedRunId: "selected-goal", selectedTaskId: "T001", tupleSha256,
			currentValidationSha256: hash("fresh-check") }),
		commitOneUse: async receipt => ({ receiptRef: "synthetic-only", receiptSha256: hash(JSON.stringify(receipt)),
			claim: { claimId: "claim", priorEnvelopeSha256: facts.envelopeSha256,
				currentRunId: facts.currentRun.runId, currentRunAttempt: 1,
				currentCommit: facts.currentRun.commit, currentJobId: "job" } }),
	});
	assert.deepEqual(offlineChecks.reservedCanonicalOperationRefs(checkpoint as any, reservation),
		["new-goal/O001", "old-goal/O002"]);
	assert.equal(checkpoint.continuation.unresolvedOperationIds.length, 3, "raw authenticated input stays intact");
});

test("failed experiment enters untrusted history while selected prior tuple remains coherent", async () => {
	const directory = await mkdtemp(path.join(os.tmpdir(), "mulpis-failed-continuation-fixture-"));
	try {
		const prior = {
			"candidate.cpp": "// accepted prior\n",
			"verification.json": JSON.stringify({ version: 1, status: "passed" }),
			"workflow-archive.json": JSON.stringify({ version: 1, kind: "m07-private-candidate-archive",
				goalRunId: "R001", taskId: "T001", controllerEvidence: { reviewStatus: "accepted" } }),
			"objective-checkpoint.json": JSON.stringify({ contract: { id: "synthetic-contract" },
				selectedArtifacts: ["candidate.cpp", "verification.json"],
				boundedRuns: [{ runId: "R001", selectedTaskId: "T001" }] }),
			"repair-state.json": "old synthetic repair telemetry",
		};
		await writeFile(path.join(directory, "candidate.cpp"), "// failed new attempt\n");
		await writeFile(path.join(directory, "verification.json"), JSON.stringify({ version: 1, status: "failed" }));
		await writeFile(path.join(directory, "experiment-plan.json"), JSON.stringify({ registeredStrategies: ["synthetic"] }));
		await writeFile(path.join(directory, "round-1-reviewer-feedback.txt"), "Synthetic gate failure\n");
		await writeFile(path.join(directory, "workflow-archive.json"), JSON.stringify({ version: 1,
			kind: "m07-private-candidate-archive", goalRunId: "R002", taskId: "T001",
			controllerEvidence: { reviewStatus: "unreviewed" } }));
		await writeFile(path.join(directory, "objective-checkpoint.json"), JSON.stringify({
			contract: { id: "synthetic-contract" }, selectedArtifacts: ["candidate.cpp", "verification.json"],
			boundedRuns: [{ runId: "R001", selectedTaskId: "T001" }, { runId: "R002", outcome: "active",
				unresolvedOperationIds: ["O001"] }],
		}));
		await writeFile(path.join(directory, "workflow-iteration-1-archive.json"), JSON.stringify({ version: 1,
			kind: "m07-private-candidate-archive", goalRunId: "R003", taskId: "T001",
			controllerEvidence: { reviewStatus: "unreviewed" } }));
		await writeFile(path.join(directory, "iteration-1-candidate.cpp"), "// failed later attempt\n");
		await writeFile(path.join(directory, "iteration-1-experiment-plan.json"), "{\"cases\":[]}");
		const transportCensus = JSON.stringify({ version: 1, kind: "host-transport-diagnostic-census",
			entries: [{ source: { runId: "1001", runAttempt: 1, commit: "a".repeat(40) },
				priorEnvelopeSha256: "b".repeat(64), rows: [{ requestId: "synthetic-unknown",
					availability: "unavailable" }] }] });
		await writeFile(path.join(directory, "transport-diagnostics.json"), transportCensus);
		await writeFile(path.join(directory, "repair-state.json"), "current synthetic repair telemetry");
		const fallbackPrefix = "fallback-aaaaaaaaaaaa-T003";
		await writeFile(path.join(directory, `workflow-${fallbackPrefix}-archive.json`), JSON.stringify({ version: 1,
			kind: "m07-private-candidate-archive", goalRunId: "R004", taskId: "T003",
			controllerEvidence: { reviewStatus: "unreviewed" } }));
		await writeFile(path.join(directory, `${fallbackPrefix}-candidate.cpp`), "// third task\n");
		await writeFile(path.join(directory, `${fallbackPrefix}-round-10-reviewer-feedback.txt`), "Later unselected feedback\n");
		const firstReservation = { version: 1, kind: "host-independent-goal-quarantine",
			reuseKey: "1".repeat(64), prior: { envelopeSha256: "a".repeat(64) },
			freshWorkspace: { workspaceId: "fresh-one" } };
		const firstClaim = { claimId: "b".repeat(64), priorEnvelopeSha256: "a".repeat(64),
			currentRunId: "1001", currentRunAttempt: 1, currentCommit: "e".repeat(40), currentJobId: "2001" };
		await offlineChecks.appendRestartReservation(directory, prior, firstReservation,
			firstClaim);
		const carried = await offlineChecks.collectContinuationBundle(directory, prior);
		assert.equal(carried?.["candidate.cpp"], prior["candidate.cpp"]);
		assert.equal(carried?.["verification.json"], prior["verification.json"]);
		assert.equal(carried?.["workflow-archive.json"], prior["workflow-archive.json"]);
		assert.equal(carried?.["objective-checkpoint.json"], await readFile(path.join(directory, "objective-checkpoint.json"), "utf8"));
		assert.equal(carried?.["transport-diagnostics.json"], transportCensus,
			"sanitized host observations travel separately from the selected research tuple");
		assert.equal(carried?.["repair-state.json"], "current synthetic repair telemetry");
		await rm(path.join(directory, "repair-state.json"));
		assert.equal((await offlineChecks.collectContinuationBundle(directory, prior))?.["repair-state.json"],
			undefined, "an older run's repair state cannot become this run's authority");
		const history = JSON.parse(carried?.["research-history.json"] ?? "null");
		const entry = history.entries.find((item: { goalRunId: string }) => item.goalRunId === "R002");
		assert.equal(entry.interpretation.includes("Unselected"), true);
		assert.equal(entry.files["candidate.cpp"], "// failed new attempt\n");
		assert.equal(entry.files["round-1-reviewer-feedback.txt"], "Synthetic gate failure\n");
		assert.ok(entry.files["experiment-plan.json"].includes("synthetic"));
		assert.equal(history.entries.find((item: { goalRunId: string }) => item.goalRunId === "R003")
			.files["candidate.cpp"], "// failed later attempt\n");
		assert.equal(history.entries.find((item: { goalRunId: string }) => item.goalRunId === "R004")
			.files["round-10-reviewer-feedback.txt"], "Later unselected feedback\n");
		assert.equal(JSON.parse(carried?.["independent-restart-quarantine.json"] ?? "null").entries.length, 1);
		assert.equal(carried?.["independent-restart-goal-binding.json"], undefined);
		const next = path.join(directory, "next");
		await mkdir(next);
		const secondReservation = { version: 1, kind: "host-independent-goal-quarantine",
			reuseKey: "2".repeat(64), prior: { envelopeSha256: "c".repeat(64) },
			freshWorkspace: { workspaceId: "fresh-two" } };
		const secondClaim = { claimId: "d".repeat(64), priorEnvelopeSha256: "c".repeat(64),
			currentRunId: "1002", currentRunAttempt: 1, currentCommit: "e".repeat(40), currentJobId: "2002" };
		await offlineChecks.appendRestartReservation(next, carried!, secondReservation,
			secondClaim);
		const digest = createHash("sha256").update(JSON.stringify(secondReservation)).digest("hex");
		await offlineChecks.appendRestartGoalBinding(next, carried!, { version: 1, kind: "host-independent-goal-binding",
			goalRunId: "R004", quarantineReceiptSha256: digest });
		const twice = await offlineChecks.collectContinuationBundle(next, carried);
		assert.equal(twice?.["transport-diagnostics.json"], transportCensus,
			"an older authenticated observation is not lost when no new diagnostic is written");
		assert.equal(JSON.parse(twice?.["independent-restart-quarantine.json"] ?? "null").entries.length, 2);
		assert.equal(JSON.parse(twice?.["independent-restart-goal-binding.json"] ?? "null").entries.length, 1);
		assert.equal(twice?.["candidate.cpp"], prior["candidate.cpp"]);
		const bad = path.join(directory, "bad");
		await mkdir(bad);
		const invalidPrior = { ...carried, "independent-restart-quarantine.json": JSON.stringify({ version: 1,
			kind: "host-independent-restart-reservations", entries: [{ receipt: firstReservation,
				claim: { ...firstClaim, priorEnvelopeSha256: "f".repeat(64) } }] }) };
		await assert.rejects(offlineChecks.appendRestartReservation(bad, invalidPrior,
			secondReservation, secondClaim),
			/reservation is invalid/);
	} finally { await rm(directory, { recursive: true, force: true }); }
});

test("same-task fallback cannot erase actual failed M04 proposal state in historical carry", async () => {
	const directory = await mkdtemp(path.join(os.tmpdir(), "mulpis-history-final-state-"));
	try {
		const prior = {
			"candidate.cpp": "// prior selected\n",
			"verification.json": JSON.stringify({ version: 1, status: "passed" }),
			"workflow-archive.json": JSON.stringify({ version: 1, kind: "m07-private-candidate-archive",
				goalRunId: "R001", taskId: "T001", controllerEvidence: { reviewStatus: "accepted" } }),
			"objective-checkpoint.json": JSON.stringify({ contract: { id: "synthetic-contract" },
				selectedArtifacts: ["candidate.cpp", "verification.json"], boundedRuns: [{ runId: "R001", selectedTaskId: "T001" }] }),
		};
		await writeFile(path.join(directory, "objective-checkpoint.json"), prior["objective-checkpoint.json"]);
		const goalRunId = "R002", taskId = "T003";
		const prefix = `fallback-${createHash("sha256").update(goalRunId).digest("hex").slice(0, 12)}-${taskId}`;
		const actual = { version: 1, kind: "m07-private-candidate-archive", goalRunId, taskId,
			controllerEvidence: { reviewStatus: "accepted" },
			m04: { state: "failed", runId: "M04-actual", proposalSubmitted: true, snapshotCreated: false } };
		const stale = { ...actual, m04: { state: "not-run", proposalSubmitted: false, snapshotCreated: false } };
		await writeFile(path.join(directory, "workflow-followon-archive.json"), JSON.stringify(actual));
		await writeFile(path.join(directory, "followon-candidate.cpp"), "// same candidate\n");
		await writeFile(path.join(directory, "followon-verification.json"), JSON.stringify({ status: "passed" }));
		await writeFile(path.join(directory, `workflow-${prefix}-archive.json`), JSON.stringify(stale));
		await writeFile(path.join(directory, `${prefix}-candidate.cpp`), "// same candidate\n");
		await writeFile(path.join(directory, `${prefix}-verification.json`), JSON.stringify({ status: "passed" }));
		const carried = await offlineChecks.collectContinuationBundle(directory, prior);
		const history = JSON.parse(carried?.["research-history.json"] ?? "null");
		const matches = history.entries.filter((entry: { goalRunId: string; taskId: string }) =>
			entry.goalRunId === goalRunId && entry.taskId === taskId);
		assert.equal(matches.length, 1);
		assert.deepEqual(JSON.parse(matches[0].files["workflow-archive.json"]).m04, actual.m04);
		const next = path.join(directory, "next"); await mkdir(next);
		await writeFile(path.join(next, "objective-checkpoint.json"), prior["objective-checkpoint.json"]);
		await writeFile(path.join(next, `workflow-${prefix}-archive.json`), JSON.stringify(stale));
		await writeFile(path.join(next, `${prefix}-candidate.cpp`), "// same candidate\n");
		await writeFile(path.join(next, `${prefix}-verification.json`), JSON.stringify({ status: "passed" }));
		const carriedAgain = await offlineChecks.collectContinuationBundle(next, carried);
		const retained = JSON.parse(carriedAgain?.["research-history.json"] ?? "null").entries.filter(
			(entry: { goalRunId: string; taskId: string }) => entry.goalRunId === goalRunId && entry.taskId === taskId);
		assert.equal(retained.length, 1);
		assert.deepEqual(JSON.parse(retained[0].files["workflow-archive.json"]).m04, actual.m04);
		const withTransaction = { ...actual,
			m04: { ...actual.m04, transaction: { file: "followon-m04-transaction.json",
				state: "rejected-draft" } } };
		await writeFile(path.join(directory, "workflow-followon-archive.json"), JSON.stringify(withTransaction));
		await writeFile(path.join(directory, "followon-m04-transaction.json"),
			'{"version":1,"kind":"m04-knowledge-transaction","state":"rejected-draft"}\n');
		const withReceipt = await offlineChecks.collectContinuationBundle(directory, prior);
		const receiptEntries = JSON.parse(withReceipt?.["research-history.json"] ?? "null").entries;
		const receiptEntry = receiptEntries.find((entry: { goalRunId: string; taskId: string }) =>
			entry.goalRunId === goalRunId && entry.taskId === taskId);
		assert.match(receiptEntry.files["m04-transaction.json"], /rejected-draft/);
		await writeFile(path.join(directory, `${prefix}-candidate.cpp`), "// conflicting candidate\n");
		await assert.rejects(offlineChecks.collectContinuationBundle(directory, prior), /archives disagree on candidate\.cpp/);
		await writeFile(path.join(directory, `${prefix}-candidate.cpp`), "// same candidate\n");
		await writeFile(path.join(directory, `${prefix}-verification.json`), JSON.stringify({ status: "failed" }));
		await assert.rejects(offlineChecks.collectContinuationBundle(directory, prior), /archives disagree on verification\.json/);
		await writeFile(path.join(directory, `${prefix}-verification.json`), JSON.stringify({ status: "passed" }));
		await writeFile(path.join(directory, `workflow-${prefix}-archive.json`), JSON.stringify({ ...stale,
			m04: { state: "completed", proposalSubmitted: false, snapshotCreated: true } }));
		await assert.rejects(offlineChecks.collectContinuationBundle(directory, prior), /historical M04 outcomes conflict/);
	} finally { await rm(directory, { recursive: true, force: true }); }
});

test("range-readable prior history partitions losslessly into fully enumerated bounded UTF-8 files", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "mulpis-history-parts-"));
	try {
		const history = JSON.stringify({ version: 1, kind: "untrusted-version-bound-research-history",
			entries: [{ goalRunId: "R001", taskId: "T001", files: { "candidate.cpp": "漢".repeat(340_000) } }] });
		const rendered = offlineChecks.rangeReadableHistory(history);
		assert.ok(Buffer.byteLength(rendered, "utf8") > 1_000_000);
		const staged = await offlineChecks.stageRangeReadableHistory(root, history);
		assert.equal(staged.partitioned, true);
		const index = JSON.parse(await readFile(path.join(root, "prior-research-history-index.json"), "utf8"));
		assert.equal(index.kind, "range-readable-history-part-index");
		assert.equal(index.totalBytes, Buffer.byteLength(rendered, "utf8"));
		assert.ok(index.parts.length > 1);
		assert.equal(index.interpretation, "untrusted-control-locator-only");
		assert.equal(index.entries.length, 1);
		assert.equal(index.entries[0].goalRunId, "R001");
		assert.equal(index.entries[0].taskId, "T001");
		assert.deepEqual(index.entries[0].fileNames, ["candidate.cpp"]);
		assert.deepEqual(staged.evidence.map(item => item.name), ["prior-research-history-index.json",
			...index.parts.map((part: { name: string }) => part.name)]);
		assert.deepEqual(staged.inputs, staged.evidence.map(item => `objective-seeds/${item.name}`));
		const parts: Buffer[] = [];
		for (const part of index.parts as Array<{ name: string; bytes: number }>) {
			const bytes = await readFile(path.join(root, part.name));
			assert.equal(bytes.length, part.bytes);
			assert.ok(bytes.length <= 1_000_000);
			assert.doesNotMatch(bytes.toString("utf8"), /\uFFFD/, "parts must not split UTF-8 characters");
			parts.push(bytes);
		}
		assert.deepEqual(Buffer.concat(parts), Buffer.from(rendered, "utf8"));
		const located = Buffer.concat(index.entries[0].parts.map((range: {
			name: string; startByte: number; endByte: number; startLine: number; endLine: number }) => {
			const at = index.parts.findIndex((part: { name: string }) => part.name === range.name);
			assert(at >= 0);
			assert(range.startLine >= 1 && range.endLine >= range.startLine);
			return parts[at]!.subarray(range.startByte, range.endByte);
		}));
		assert.equal(JSON.parse(located.toString("utf8")).goalRunId, "R001");
		assert.equal((await stat(path.join(root, "prior-research-history-index.json"))).size <= 1_000_000, true);
		assert.equal("sha256" in index, false, "index must not introduce a hash-manifest contract");
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("a large generic episode catalog stays in bounded locator parts without dropping entries", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "mulpis-history-catalog-"));
	try {
		const entries = Array.from({ length: 12_000 }, (_, index) => ({
			goalRunId: `G${index + 1}`, taskId: "T001", files: { "candidate.cpp": "x" } }));
		const history = JSON.stringify({ version: 1,
			kind: "untrusted-version-bound-research-history", entries });
		const staged = await offlineChecks.stageRangeReadableHistory(root, history);
		assert.equal(staged.partitioned, true);
		const index = JSON.parse(await readFile(path.join(root,
			"prior-research-history-index.json"), "utf8"));
		assert(index.catalogParts.length > 0);
		assert.equal(index.entries.length, 0);
		assert.equal(index.parts.reduce((sum: number, part: { bytes: number }) => sum + part.bytes, 0),
			Buffer.byteLength(offlineChecks.rangeReadableHistory(history), "utf8"));
		const catalog = (await Promise.all(index.catalogParts.map(async (part: {
			name: string; firstOrdinal: number; lastOrdinal: number }) => {
			const file = path.join(root, part.name);
			assert((await stat(file)).size <= 1_000_000);
			return JSON.parse(await readFile(file, "utf8")).entries as Array<{
				entryOrdinal: number; goalRunId: string; fileNames: string[] }>;
		}))).flat();
		assert.equal(catalog.length, entries.length);
		assert.equal(catalog[0]?.goalRunId, "G1");
		assert.equal(catalog.at(-1)?.goalRunId, `G${entries.length}`);
		assert.deepEqual(catalog.at(-1)?.fileNames, ["candidate.cpp"]);
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("rejected historical M04 draft is staged as complete read-only bounded evidence", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "mulpis-rejected-m04-evidence-"));
	try {
		const portable = JSON.stringify({ version: 1, kind: "m04-knowledge-transaction",
			m04RunId: "M04-synthetic", state: "rejected-draft",
			padding: "回".repeat(380_000) });
		const bundle = { "research-history.json": JSON.stringify({ entries: [{
			goalRunId: "G-synthetic", taskId: "T001", files: {
				"workflow-archive.json": JSON.stringify({ m04: { runId: "M04-synthetic" } }),
				"m04-transaction.json": portable,
			} }] }) };
		const names = await offlineChecks.stageHistoricalM04RejectionEvidence({ goalRoot: root,
			bundle, goalRunId: "G-synthetic", taskId: "T001" });
		assert.ok(names[0].endsWith("-index.json"));
		const index = JSON.parse(await readFile(path.join(root, names[0]), "utf8"));
		assert.deepEqual(index.parts.map((part: { name: string }) => part.name), names.slice(1));
		const parts = await Promise.all(names.slice(1).map(name => readFile(path.join(root, name))));
		assert.ok(parts.every(part => part.length <= 1_000_000));
		assert.equal(Buffer.concat(parts).toString("utf8"), portable);
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("small prior history retains the original single-file assessor path", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "mulpis-history-single-"));
	try {
		const history = JSON.stringify({ version: 1, kind: "untrusted-version-bound-research-history", entries: [] });
		const staged = await offlineChecks.stageRangeReadableHistory(root, history);
		assert.equal(staged.partitioned, false);
		assert.deepEqual(staged.evidence.map(item => item.name), ["prior-research-history.json"]);
		assert.deepEqual(staged.inputs, ["objective-seeds/prior-research-history.json"]);
		assert.equal(await readFile(path.join(root, "prior-research-history.json"), "utf8"),
			offlineChecks.rangeReadableHistory(history));
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("no accepted current candidate reports prior tuple retention without a performance claim", () => {
	const status = offlineChecks.initialHistoricalSelection("none", "passed");
	assert.equal(status.priorRetained, true);
	assert.equal(status.retentionReason, "no-new-accepted-candidate");
	assert.equal(status.selectedTupleProvenance, "authenticated-prior-carry");
	assert.equal(status.priorCurrentHostCorrectnessGuard, "passed");
	assert.equal(status.currentAttemptAcceptedTask, false);
	assert.equal(status.currentAttemptGainEstablished, false);
	assert.equal((status.comparison as { state: string }).state, "unavailable");
	assert.equal(status.comparisonPerformed, false);
});

test("settled terminal length remains an incomplete output-limit boundary end to end", async () => {
	assert.equal(offlineChecks.campaignObjectiveStop("output-limit"), "output-limit");
	const telemetry = await offlineChecks.taskTelemetry({ sessionsDir: "/tmp/synthetic-mulpis-sessions" } as any,
		{ taskId: "T001", status: "failed", loopStopReason: "output-limit",
			executionFailure: "provider length response received and settled; task remains incomplete",
			toolLog: [] }, "SYNTHETIC_KEY");
	assert.equal(telemetry.status, "failed");
	assert.equal(telemetry.loopStopReason, "output-limit");
	assert.equal(telemetry.failureCategory, "output-limit");
});

test("private tool telemetry keeps bounded read diagnostics and full-return evidence without content", () => {
	const key = "sk-SYNTHETIC_PRIVATE_TOKEN123";
	const failed = offlineChecks.privateToolTelemetry({ name: "read", ok: false,
		args: { path: "inputs/guide.txt", content: "DO_NOT_EXPORT" }, errorClass: "harness",
		errorCode: "runner.campaign-files",
		errorMessage: `File unavailable; Authorization: Bearer ${key}` }, 0, key);
	assert.equal(failed.name, "read");
	assert.equal(failed.errorClass, "harness");
	assert.equal(failed.errorCode, "runner.campaign-files");
	assert.equal(failed.requestedPath, "inputs/guide.txt");
	assert.doesNotMatch(JSON.stringify(failed), /SYNTHETIC_PRIVATE_TOKEN|DO_NOT_EXPORT/);
	const returned = offlineChecks.privateToolTelemetry({ name: "read", ok: true,
		resultMetadata: { kind: "confined-utf8-read", relativePath: "inputs/guide.txt",
			utf8Bytes: 123, truncated: false }, resultText: "DO_NOT_EXPORT" }, 1, key);
	assert.deepEqual(returned.returnedEvidence, { kind: "full-utf8-text",
		relativePath: "inputs/guide.txt", utf8Bytes: 123, truncated: false });
	assert.doesNotMatch(JSON.stringify(returned), /DO_NOT_EXPORT/);
	const untrusted = offlineChecks.privateToolTelemetry({ name: "custom_network", ok: true,
		resultMetadata: { kind: "confined-utf8-read", relativePath: "secret.txt",
			utf8Bytes: 3, truncated: false } }, 2, key);
	assert.equal(untrusted.name, "other");
	assert.equal(untrusted.returnedEvidence, undefined);
});

test("generic private campaign source-shape gate preserves non-target bodies", () => {
	const original = `static void baseline() { int x = 1; (void)x; }
// TODO first
static void targetA() { baseline(); }
// TODO second
static void targetB() { baseline(); }
static bool check() { return true; }
int main() { return check() ? 0 : 1; }
`;
	const candidate = original
		.replace("static void targetA() { baseline(); }", "static void targetA() {\n#pragma omp parallel\n { } }")
		.replace("static void targetB() { baseline(); }", "static void targetB() {\n#pragma omp parallel for\n for (int i = 0; i < 1; ++i) { } }");
	assert.equal(offlineChecks.sourceShape(original, candidate).ok, true);
	const conditional = candidate.replace("#pragma omp parallel", "#ifdef _OPENMP\n#pragma omp parallel\n#else\n (void)0;\n#endif");
	assert.equal(offlineChecks.sourceShape(original, conditional).ok, true);
	assert.equal(offlineChecks.sourceShape(original, conditional.replace("#endif", "")).ok, false);
	assert.equal(offlineChecks.sourceShape(original, conditional.replace("#ifdef _OPENMP", "#if 1")).ok, false);
	assert.equal(offlineChecks.sourceShape(original, candidate.replace("int x = 1", "int x = 2")).ok, false);
	assert.equal(offlineChecks.sourceShape(original, original).ok, false);
	assert.equal(offlineChecks.sourceShape(original, candidate.replace("#pragma omp parallel", "#define checker_run main\n#pragma omp parallel")).ok, false);
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

test("follow-on cannot promote byte-identical code on a noisy measured speedup", () => {
	const apparentGain = { state: "measured", medianRatio: 1.12, minRatio: 1.04 };
	assert.equal(offlineChecks.chooseFollowOnCandidate(true, true, false, apparentGain), false);
	assert.equal(offlineChecks.chooseFollowOnCandidate(true, true, true, apparentGain), true);
	assert.equal(offlineChecks.chooseFollowOnCandidate(true, false, true, apparentGain), false);
});

test("an unselected completed M04 with incomplete export permits the next independent assessment", async () => {
	const favorable = { state: "measured", medianRatio: 1.2, minRatio: 1.05 };
	const promoted = offlineChecks.chooseDurableFollowOnCandidate(true, true, false,
		favorable, "incomplete");
	assert.equal(promoted, false, "byte-identical work and incomplete knowledge cannot replace selection");
	assert.equal(offlineChecks.replaceSelectedM04AfterFollowOn(true, promoted, "completed"), false,
		"the known merged but unselected M04 cannot overwrite selected knowledge readiness");
	const priorRef = { storeId: "11111111-1111-4111-8111-111111111111",
		recordId: "K001", version: 1 };
	const selected = { status: "completed" as const, transactionState: "merged" as const,
		repairNeeded: false, evidenceReturned: true,
		knowledgeExport: { state: "complete" as const, file: "m04-adopted-knowledge.json" },
		reusableRefs: [priorRef], knowledgeFile: "prior-selected-m04-adopted-knowledge.json" };
	const unselected = { status: "completed" as const, transactionState: "merged" as const,
		repairNeeded: false, evidenceReturned: true,
		knowledgeExport: { state: "incomplete" as const,
			reason: "synthetic physical or graph export failure" },
		reusableRefs: [], knowledgeFile: undefined };
	const active = offlineChecks.selectedM04AfterFollowOn(selected, unselected, true, promoted);
	assert.deepEqual(active, selected,
		"production state transition keeps the selected export and pinned refs after unselected M04");
	const loop = await runOriginalObjectiveLoop({
		admission: () => active.status === "completed" && active.evidenceReturned &&
			active.knowledgeExport.state === "complete" ? "admitted" : "bounded-run-incomplete",
		step: async iteration => iteration === 1 ?
			{ advanced: true, stopReason: "objective-reassessment-pending" } :
			{ advanced: false, stopReason: "assessment-failed" },
	});
	assert.equal(loop.steps.length, 2, "a second assessor turn follows the unselected export failure");
	assert.equal(loop.stopReason, "assessment-failed");
	assert.equal(offlineChecks.chooseDurableFollowOnCandidate(true, true, true,
		favorable, "incomplete"), false,
		"even a faster changed source cannot promote without a safe knowledge export");
	assert.equal(offlineChecks.chooseDurableFollowOnCandidate(true, true, true,
		favorable, "complete"), true);
	const safeNew = { ...unselected, knowledgeExport: { state: "complete" as const },
		reusableRefs: [{ ...priorRef, recordId: "K002" }],
		knowledgeFile: "new-selected-m04-adopted-knowledge.json" };
	assert.deepEqual(offlineChecks.selectedM04AfterFollowOn(selected, safeNew, true, true), safeNew,
		"a promoted, fully exported candidate updates exactly its own pinned refs");
	assert.equal(offlineChecks.replaceSelectedM04AfterFollowOn(true, true, "completed"), true);
	assert.equal(offlineChecks.replaceSelectedM04AfterFollowOn(true, false, "failed"), true,
		"a failed M04 keeps its existing unresolved-effect repair gate");
	assert.equal(offlineChecks.selectedM04AfterFollowOn(selected,
		{ ...unselected, status: "failed" }, true, false).status, "failed");
	const blockedSelected = await runOriginalObjectiveLoop({
		admission: () => "bounded-run-incomplete", step: async () => {
			throw Error("a selected incomplete export must block before another model turn");
		} });
	assert.equal(blockedSelected.steps.length, 0);
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

test("a real fork with no accepted M07 winner cannot unlock a fulfilled follow-on", () => {
	assert.equal(offlineChecks.firstM07Accepted(false, "partial"), false);
	assert.equal(offlineChecks.firstM07Accepted(false, "fulfilled"), false);
	assert.equal(offlineChecks.firstM07Accepted(true, "partial"), false);
	assert.equal(offlineChecks.firstM07Accepted(true, "fulfilled"), true);
});

test("controller rejection after ready host pass remains repairable until actual acceptance", () => {
	const rejected = { status: "rejected", loopStopReason: "ready", review: { failures: ["invalid lesson delta"] } };
	const base = { winner: false, stopped: false, aborted: false, rejected,
		unresolvedOperationIds: [] as string[], unresolvedTaskIds: [] as string[] };
	assert.equal(offlineChecks.shouldRepairRejectedReview(base), true);
	assert.equal(offlineChecks.shouldRepairRejectedReview({ ...base, winner: true }), false);
	assert.equal(offlineChecks.shouldRepairRejectedReview({ ...base,
		rejected: { ...rejected, status: "accepted" } }), false);
	assert.equal(offlineChecks.shouldRepairRejectedReview({ ...base,
		rejected: { ...rejected, loopStopReason: "blocked" } }), false);
	assert.equal(offlineChecks.shouldRepairRejectedReview({ ...base, unresolvedOperationIds: ["O001"] }), false);
	assert.equal(offlineChecks.shouldRepairRejectedReview({ ...base, stopped: true }), false);
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

test("fork provenance requires a committed child receipt bound to the frozen parent leaf", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "mulpis-fork-receipt-fixture-"));
	try {
		const file = path.join(root, "lineage.json");
		const problemCopy = path.join(root, "problem-snapshot.md");
		const checkpoint = { id: "checkpoint-a", leafId: "leaf-a", sourceSessionId: "session-parent",
			manifestSnapshot: path.join(root, "manifest.json"), runId: "R001", taskId: "T001",
			model: "deepseek/deepseek-flash:low" } as any;
		await writeFile(checkpoint.manifestSnapshot, "{}\n");
		await writeFile(problemCopy, "frozen problem\n");
		const bindings = [
			{ status: "frozen-copy", path: checkpoint.manifestSnapshot, sourceVersion: checkpoint.id },
			{ status: "frozen-copy", path: problemCopy, sourceVersion: `${checkpoint.runId}/${checkpoint.taskId}` },
		];
		const receipt = { version: 1, state: "committed", intent: "branch-exploration", checkpoint,
			parent: { sessionId: "session-parent", leafId: "leaf-a" }, child: { sessionId: "session-child" },
			evidenceBindings: bindings,
			workspaceBinding: { version: 1, files: [{}] },
			inheritedUsageBilled: false };
		await writeFile(file, JSON.stringify(receipt));
		assert.equal(await offlineChecks.forkReceiptMatches(file, checkpoint, "session-child"), true);
		const summary = await offlineChecks.contextLineageSummary(file, checkpoint, "session-child", checkpoint.model, problemCopy);
		assert.equal(summary.state, "verified");
		assert.equal(summary.evidenceBindingCount, 2);
		assert.equal(summary.workspaceBindingFileCount, 1);
		assert.equal(JSON.stringify(summary).includes("sourcePath"), false);
		for (const changed of [
			[{ ...bindings[0], sourceVersion: "wrong" }, bindings[1]],
			[bindings[0], { ...bindings[1], sourceVersion: checkpoint.id }],
			[bindings[0], { ...bindings[1], path: checkpoint.manifestSnapshot }],
			[...bindings, { status: "frozen-copy", path: problemCopy, sourceVersion: "extra" }],
		]) {
			await writeFile(file, JSON.stringify({ ...receipt, evidenceBindings: changed }));
			assert.equal((await offlineChecks.contextLineageSummary(file, checkpoint, "session-child", checkpoint.model, problemCopy)).state,
				"unverified");
		}
		assert.equal(await offlineChecks.forkReceiptMatches(file, checkpoint, "session-other"), false);
		await writeFile(file, JSON.stringify({ ...receipt, intent: "causal-continuation" }));
		assert.equal(await offlineChecks.forkReceiptMatches(file, checkpoint, "session-child"), false);
		await writeFile(file, JSON.stringify({ ...receipt, parent: { ...receipt.parent, sessionId: "session-other" } }));
		assert.equal(await offlineChecks.forkReceiptMatches(file, checkpoint, "session-child"), false);
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("prefixed archive references its transported files and fallback keeps promoted canonical candidate", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "mulpis-flat-archive-fixture-"));
	const source = path.join(root, "source"), output = path.join(root, "output");
	try {
		await mkdir(source); await mkdir(output);
		await writeFile(path.join(source, "candidate.cpp"), "// second candidate\n");
		await writeFile(path.join(source, "round-1-candidate.cpp"), "// second round\n");
		await writeFile(path.join(source, "round-1-reviewer-feedback.txt"), "bounded feedback\n");
		await writeFile(path.join(source, "round-1-reviewer-report.md"), "bounded reviewer report\n");
		await writeFile(path.join(source, "round-10-reviewer-feedback.txt"), "later feedback\n");
		await writeFile(path.join(source, "review-decision.json"), "{}\n");
		await writeFile(path.join(source, "m04-adopted-knowledge.json"), "{}\n");
		await writeFile(path.join(source, "m04-transaction.json"), '{"version":1,"kind":"m04-knowledge-transaction","state":"merged"}\n');
		await writeFile(path.join(source, "workflow-archive.json"), JSON.stringify({
			files: [{ name: "candidate.cpp", status: "present" }],
			controllerEvidence: { rounds: [{ candidate: { file: "round-1-candidate.cpp" }, verification: { status: "missing" },
				feedbackFile: "round-1-reviewer-feedback.txt", reviewerReport: { file: "round-1-reviewer-report.md" } }],
				reviewDecision: { file: "review-decision.json" } },
			m04: { knowledgeExport: { state: "complete", file: "m04-adopted-knowledge.json" },
				transaction: { file: "m04-transaction.json", state: "merged" } },
		}));
		await offlineChecks.exportPrefixedArchive(source, output, "followon");
		const index = JSON.parse(await readFile(path.join(output, "workflow-followon-archive.json"), "utf8"));
		assert.equal(index.files[0].name, "followon-candidate.cpp");
		assert.equal(index.controllerEvidence.rounds[0].candidate.file, "followon-round-1-candidate.cpp");
		assert.equal(index.controllerEvidence.rounds[0].feedbackFile, "followon-round-1-reviewer-feedback.txt");
		assert.equal(index.controllerEvidence.rounds[0].reviewerReport.file, "followon-round-1-reviewer-report.md");
		assert.equal(index.controllerEvidence.reviewDecision.file, "followon-review-decision.json");
		assert.equal(await readFile(path.join(output, "followon-round-1-reviewer-feedback.txt"), "utf8"), "bounded feedback\n");
		assert.equal(await readFile(path.join(output, "followon-round-10-reviewer-feedback.txt"), "utf8"), "later feedback\n");
		await offlineChecks.exportPrefixedArchive(source, output, "iteration-65");
		assert.equal(await readFile(path.join(output, "iteration-65-round-10-reviewer-feedback.txt"), "utf8"), "later feedback\n");
		const available = await offlineChecks.availablePrivateArtifactNames(output);
		assert.ok(available.includes("iteration-65-round-10-reviewer-feedback.txt"));
		assert.ok(available.includes("workflow-iteration-65-archive.json"));
		await offlineChecks.exportPrefixedArchive(source, output, "initial");
		const initialIndex = JSON.parse(await readFile(path.join(output, "workflow-initial-archive.json"), "utf8"));
		assert.equal(initialIndex.m04.knowledgeExport.file, "initial-m04-adopted-knowledge.json");
		assert.equal(await readFile(path.join(output, "initial-m04-adopted-knowledge.json"), "utf8"), "{}\n");
		assert.equal(initialIndex.m04.transaction.file, "initial-m04-transaction.json");
		assert.match(await readFile(path.join(output, "initial-m04-transaction.json"), "utf8"), /"merged"/);
		assert.equal(index.transportLayout.defaultArchiveLoaderCompatible, false);
		await writeFile(path.join(output, "candidate.cpp"), "// promoted second candidate\n");
		await writeFile(path.join(output, "workflow-archive.json"), "{}\n");
		await offlineChecks.preserveCandidate({ runDir: () => path.join(root, "missing-goal") } as any, "R001", output);
		assert.equal(await readFile(path.join(output, "candidate.cpp"), "utf8"), "// promoted second candidate\n");
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("provenance import keeps lesson, review and M04 bytes as unselected history", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "mulpis-provenance-import-fixture-"));
	try {
		const source = path.join(root, "source"), output = path.join(root, "output");
		await mkdir(source); await mkdir(output);
		const sourceFiles = {
			"candidate.cpp": "// synthetic imported source\n",
			"verification.json": '{"version":1,"status":"passed"}\n',
			"lesson-delta.json": '{"version":1,"action":"propose","observation":"synthetic"}\n',
			"review-decision.json": '{"version":1,"status":"accepted"}\n',
			"m04-adopted-knowledge.json": '{"version":1,"state":"complete","synthetic":true}\n',
		};
		for (const [name, content] of Object.entries(sourceFiles))
			await writeFile(path.join(source, name), content);
		await writeFile(path.join(source, "workflow-archive.json"), JSON.stringify({
			version: 1, kind: "m07-private-candidate-archive", goalRunId: "R099", taskId: "T001",
			goalOutcome: "fulfilled", taskStatus: "accepted",
			files: Object.keys(sourceFiles).map(name => ({ name, status: "present" })),
			controllerEvidence: { reviewStatus: "accepted", reviewDecision: { file: "review-decision.json" } },
			m04: { state: "completed", knowledgeExport: { state: "complete", file: "m04-adopted-knowledge.json" } },
		}));
		await offlineChecks.exportPrefixedArchive(source, output, "provenance-import");
		const prefixed = JSON.parse(await readFile(path.join(output, "workflow-provenance-import-archive.json"), "utf8"));
		assert.equal(prefixed.controllerEvidence.reviewDecision.file, "provenance-import-review-decision.json");
		assert.equal(prefixed.m04.knowledgeExport.file, "provenance-import-m04-adopted-knowledge.json");
		for (const [name, content] of Object.entries(sourceFiles))
			assert.equal(await readFile(path.join(output, `provenance-import-${name}`), "utf8"), content);
		const prior = {
			"candidate.cpp": "// previously selected source\n",
			"verification.json": '{"version":1,"status":"passed","selection":"prior"}',
			"workflow-archive.json": JSON.stringify({ version: 1, kind: "m07-private-candidate-archive",
				goalRunId: "R001", taskId: "T001", controllerEvidence: { reviewStatus: "accepted" } }),
			"objective-checkpoint.json": JSON.stringify({ contract: { id: "synthetic-contract" },
				selectedArtifacts: ["candidate.cpp", "verification.json"],
				boundedRuns: [{ runId: "R001", selectedTaskId: "T001" }] }),
		};
		await writeFile(path.join(output, "objective-checkpoint.json"), JSON.stringify({
			contract: { id: "synthetic-contract" },
			selectedArtifacts: ["candidate.cpp", "verification.json"],
			boundedRuns: [{ runId: "R001", selectedTaskId: "T001" },
				{ runId: "R099", outcome: "fulfilled", selectedTaskId: "T001" }],
		}));
		const carried = await offlineChecks.collectContinuationBundle(output, prior);
		assert.equal(carried?.["candidate.cpp"], prior["candidate.cpp"]);
		assert.equal(carried?.["verification.json"], prior["verification.json"]);
		assert.equal(carried?.["workflow-archive.json"], prior["workflow-archive.json"]);
		const history = JSON.parse(carried?.["research-history.json"] ?? "null");
		const imported = history.entries.find((entry: { goalRunId: string }) => entry.goalRunId === "R099");
		assert.equal(imported.taskId, "T001");
		assert.match(imported.interpretation, /Unselected or unresolved experiment/);
		assert.equal(imported.files["workflow-archive.json"], await readFile(path.join(output,
			"workflow-provenance-import-archive.json"), "utf8"));
		for (const [name, content] of Object.entries(sourceFiles))
			assert.equal(imported.files[name], content);
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("fallback archive rejects repeated round identities but accepts later rounds", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "mulpis-fallback-archive-fixture-"));
	try {
		const workDir = path.join(root, "work"), output = path.join(root, "output");
		await mkdir(workDir); await mkdir(output);
		await writeFile(path.join(root, "goal.json"), JSON.stringify({ runId: "run-example", lifecycle: "active", tasks: [{
			taskId: "T001", mode: "execute", workDir, status: "returned",
			executionRounds: [...Array.from({ length: 9 }, (_, index) => ({ index: index + 1 })), { index: 9 }],
		}] }));
		await assert.rejects(offlineChecks.preserveCandidate({ runDir: () => root } as any, "run-example", output),
			/invalid execution round index/);
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("fallback archive retains every settled same-goal candidate file", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "mulpis-fallback-pair-fixture-"));
	try {
		const output = path.join(root, "output"); await mkdir(output);
		const tasks = [];
		for (const [index, text] of ["parent", "child", "later"].entries()) {
			const workDir = path.join(root, `work-${index}`); await mkdir(workDir);
			await writeFile(path.join(workDir, "candidate.cpp"), `// ${text} candidate\n`);
			tasks.push({ taskId: `T00${index + 1}`, mode: "execute", workDir, status: "returned" });
		}
		await writeFile(path.join(root, "goal.json"), JSON.stringify({ runId: "run-example", lifecycle: "active", tasks }));
		await offlineChecks.preserveCandidate({ runDir: () => root } as any, "run-example", output);
		assert.equal(await readFile(path.join(output, "candidate.cpp"), "utf8"), "// parent candidate\n");
		assert.equal(await readFile(path.join(output, "branch-child-candidate.cpp"), "utf8"), "// child candidate\n");
		const prefix = `fallback-${createHash("sha256").update("run-example").digest("hex").slice(0, 12)}-T003`;
		assert.equal(await readFile(path.join(output, `${prefix}-candidate.cpp`), "utf8"), "// later candidate\n");
		assert.equal((await offlineChecks.availablePrivateArtifactNames(output)).includes(`${prefix}-candidate.cpp`), true);
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("fallback finalizer recognizes an existing followon archive for the same task identity", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "mulpis-followon-no-duplicate-"));
	try {
		const output = path.join(root, "output"), workDir = path.join(root, "work");
		await mkdir(output); await mkdir(workDir);
		await writeFile(path.join(workDir, "candidate.cpp"), "// same candidate\n");
		await writeFile(path.join(root, "goal.json"), JSON.stringify({ runId: "R002", lifecycle: "active", tasks: [
			{ taskId: "T003", mode: "execute", workDir, status: "returned" }] }));
		const actual = { version: 1, kind: "m07-private-candidate-archive", goalRunId: "R002", taskId: "T003",
			m04: { state: "failed", runId: "M04-actual", proposalSubmitted: true, snapshotCreated: false } };
		await writeFile(path.join(output, "workflow-followon-archive.json"), JSON.stringify(actual));
		await offlineChecks.preserveCandidate({ runDir: () => root } as any, "R002", output);
		assert.deepEqual(JSON.parse(await readFile(path.join(output, "workflow-followon-archive.json"), "utf8")).m04, actual.m04);
		await assert.rejects(readFile(path.join(output, "workflow-archive.json")), /ENOENT/);
		const prefix = `fallback-${createHash("sha256").update("R002").digest("hex").slice(0, 12)}-T003`;
		await assert.rejects(readFile(path.join(output, `workflow-${prefix}-archive.json`)), /ENOENT/);
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("runtime benchmark cases derive bounded default, uniform and heavier shapes from private source text", () => {
	const text = `struct ToyParameters { int first = 100; int second = 500; int third = 8; int fourth = 4; int fifth = 100; int workers = 2; int loops = 10; };
	if (arg == "--alpha") { p.first = read_int_arg(argc, argv, i, arg); }
	if (arg == "--beta") { p.second = read_int_arg(argc, argv, i, arg); }
	if (arg == "--gamma") { p.third = read_int_arg(argc, argv, i, arg); }
	if (arg == "--delta") { p.fourth = read_int_arg(argc, argv, i, arg); }
	if (arg == "--epsilon") { p.fifth = read_int_arg(argc, argv, i, arg); }
	if (arg == "--worker-count") { p.workers = read_int_arg(argc, argv, i, arg); }
	if (arg == "--loop-count") { p.loops = read_int_arg(argc, argv, i, arg); }`;
	const cases = offlineChecks.deriveRuntimeCases(text);
	assert.equal(cases?.length, 9);
	assert.deepEqual(cases?.[0], ["--worker-count", "1", "--loop-count", "10"]);
	assert.ok(cases?.[3].includes("--delta") && cases[3].includes("0"));
	assert.ok(cases?.[6].includes("--beta") && cases[6].includes("1000"));
	assert.equal(offlineChecks.deriveRuntimeCases(text.replace('"--worker-count"', '"--removed"').replace('p.workers', 'p.missing')), undefined);
});

test("generic private campaign accepts only one C++ and two flat text inputs", async () => {
	const directory = await mkdtemp(path.join(os.tmpdir(), "mulpis-private-input-fixture-"));
	try {
		await writeFile(path.join(directory, "fixture.cpp"), "int main() { return 0; }\n");
		await writeFile(path.join(directory, "guide.md"), "fixture\n");
		await writeFile(path.join(directory, "notes.txt"), "fixture\n");
		assert.equal((await offlineChecks.inputs(directory)).files.length, 3);
		await mkdir(path.join(directory, "nested"));
		await assert.rejects(offlineChecks.inputs(directory));
	} finally { await rm(directory, { recursive: true, force: true }); }
});

test("isolation probe remains readable by the sandbox UID under umask 077", async () => {
	const directory = await mkdtemp(path.join(os.tmpdir(), "mulpis-private-probe-fixture-"));
	const previous = process.umask(0o077);
	try {
		await offlineChecks.stageProbe(directory);
		assert.equal((await stat(path.join(directory, "probe.cpp"))).mode & 0o777, 0o644);
	} finally {
		process.umask(previous);
		await rm(directory, { recursive: true, force: true });
	}
});

test("checker bind source is top-level temporary storage, not under private 0700 workspace", async () => {
	const scratch = await offlineChecks.verifierScratch("original");
	try {
		assert.equal(path.dirname(scratch), os.tmpdir());
		assert.equal((await stat(scratch)).mode & 0o777, 0o777);
	} finally { await rm(scratch, { recursive: true, force: true }); }
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

test("private diagnostic redacts a key crossing the 4000-character output boundary", () => {
	const key = "sk-SYNTHETICBOUNDARYSECRET123456";
	const message = "x".repeat(3995) + key + " trailing diagnostic";
	const redacted = offlineChecks.privateFailureMessage(message, key);
	assert.ok(redacted);
	assert.equal(redacted.length, 4000);
	assert.equal(redacted.includes(key), false);
	assert.equal(redacted.slice(-5).includes("sk-"), false);
});

test("encrypted provider reason keeps concrete text after credential redaction", () => {
	const key = "sk-SYNTHETIC_PROVIDER_SECRET123456";
	const field = offlineChecks.privateProviderErrorField(
		`Invalid reasoning_content at messages[3]; Authorization: Bearer ${key}\napi_key=othersecret&password=hiddenvalue`, key);
	assert.match(field ?? "", /Invalid reasoning_content at messages\[3\]/);
	assert.doesNotMatch(field ?? "", /SYNTHETIC_PROVIDER_SECRET|othersecret|hiddenvalue|Bearer sk-/);
	assert.match(field ?? "", /REDACTED_KEY/);
});

test("post-provider controller exceptions retain only encrypted redacted code and message", () => {
	const key = "sk-SYNTHETIC_EXCEPTION_SECRET123";
	const error = Object.assign(new Error(`fork cannot change review-loop obligations; Authorization: Bearer ${key}`),
		{ code: "m07.branch" });
	const diagnostic = offlineChecks.privateExceptionDiagnostic(error, key);
	assert.equal(diagnostic.code, "m07.branch");
	assert.equal(diagnostic.category, "unclassified");
	assert.match(diagnostic.message ?? "", /review-loop obligations/);
	assert.doesNotMatch(JSON.stringify(diagnostic), /SYNTHETIC_EXCEPTION_SECRET|Bearer sk-/);
	assert.equal(offlineChecks.privateExceptionDiagnostic(Object.assign(new Error("x"), { code: "unsafe code with spaces" }), key).code,
		"unavailable");
	assert.equal(offlineChecks.privateExceptionDiagnostic(Object.assign(new Error("x"), { code: key }), key).code,
		"unavailable");
	assert.equal(offlineChecks.privateExceptionDiagnostic(Object.assign(new Error("x"), { code: "sk-ANOTHERSECRET123456" }), key).code,
		"unavailable");
});

test("normal carry diagnostic retains the exact trusted static ledger invariant", () => {
	const diagnostic = offlineChecks.privateSealDiagnostic(new HarnessError(
		"runner.ledger-continuation", "new selected tuple lacks a completed authenticated transition"),
		"normal-continuation-seal");
	assert.equal(diagnostic.stage, "normal-continuation-seal");
	assert.equal(diagnostic.kind, "harness-invariant");
	assert.equal(diagnostic.code, "runner.ledger-continuation");
	assert.equal(diagnostic.invariantClass, "selected-transition");
	assert.equal(diagnostic.message, "new selected tuple lacks a completed authenticated transition");
	assert.equal(diagnostic.exceptionClass, "HarnessError");
	assert.equal(diagnostic.messageSha256, createHash("sha256").update(diagnostic.message!).digest("hex"));
});

test("carry diagnostic discards arbitrary errors and secret-containing forged invariants", () => {
	const secret = "private-task-and-credential-sk-SYNTHETICSECRET123";
	for (const error of [new Error(`normal failed ${secret}`),
		new HarnessError("runner.ledger-continuation", `current accounting-only carry is invalid: ${secret}`),
		new HarnessError(`runner.ledger-continuation.${secret}`, "current accounting-only carry is invalid")]) {
		const diagnostic = offlineChecks.privateSealDiagnostic(error, "normal-continuation-seal");
		assert.equal(diagnostic.stage, "normal-continuation-seal");
		assert.equal(diagnostic.kind, "unclassified-error");
		assert.equal(diagnostic.code, null);
		assert.equal(diagnostic.invariantClass, null);
		assert.equal(diagnostic.message, null);
		assert.match(diagnostic.messageSha256 ?? "", /^[0-9a-f]{64}$/);
		assert.equal(diagnostic.redactedMessage, null);
		assert.doesNotMatch(JSON.stringify(diagnostic), /private-task|SYNTHETICSECRET|sk-/);
	}
	assert.equal(offlineChecks.privateSealDiagnostic(new Error(secret), "emergency-continuation-seal").stage,
		"emergency-continuation-seal");
});

test("normal seal failure survives emergency success with its exact private invariant", () => {
	const sealed = sealCampaignCarry({
		sealCurrent: () => { throw new HarnessError("runner.ledger-continuation",
			"current selected tuple differs from authenticated transition"); },
		sealEmergencyCurrent: () => ({ envelopeB64: "synthetic-emergency", sidecars: {}, observedSettledCny: 0,
			observedUnknownHeldCny: 0, unpricedRequestCount: 0 }),
	}, { settledCny: 0, unknownObservedCny: 0, unpricedRequestCount: 0,
		requestAudit: { version: 3, kind: "accounting-only-request-audit", requests: [],
			settledCny: 0, unknownObservedCny: 0, unpricedRequestCount: 0 } } as any);
	assert.equal(sealed.mode, "emergency-effects-unreviewed");
	if (sealed.mode !== "emergency-effects-unreviewed") return;
	const status = offlineChecks.privateEmergencyStatusDiagnostics(undefined, sealed);
	assert.equal(status.archiveFailure, "normal-continuation-seal-failed-emergency-preserved");
	assert.equal("collectionFailure" in status, false);
	assert.equal(status.normalSealFailure?.message,
		"current selected tuple differs from authenticated transition");
	assert.equal(status.normalSealFailure?.stage, "normal-continuation-seal");
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

test("ordered finalizer failures retain earlier stages after later failures overwrite the summary", () => {
	const failures: Array<Parameters<typeof offlineChecks.recordFinalizationFailure>[1]> = [];
	let archiveFailure: string = offlineChecks.recordFinalizationFailure(failures,
		"objective-checkpoint-salvage-failed");
	archiveFailure = offlineChecks.recordFinalizationFailure(failures, "host-effect-census-unavailable");
	archiveFailure = offlineChecks.recordFinalizationFailure(failures,
		"research-continuation-collection-failed-prior-retained");
	archiveFailure = offlineChecks.recordFinalizationFailure(failures,
		"emergency-continuation-seal-failed");
	assert.equal(archiveFailure, "emergency-continuation-seal-failed");
	assert.deepEqual(failures, ["objective-checkpoint-salvage-failed", "host-effect-census-unavailable",
		"research-continuation-collection-failed-prior-retained", "emergency-continuation-seal-failed"]);
});

test("collection diagnostic omits arbitrary private task text and credentials", () => {
	const secret = "private-task-sk-SYNTHETICSECRET456";
	const diagnostic = offlineChecks.privateCollectionDiagnostic(
		new Error(`research continuation exceeds the authenticated carry capacity: ${secret}`));
	assert.equal(diagnostic.stage, "research-continuation-collection");
	assert.equal(diagnostic.kind, "unclassified-error");
	assert.equal(diagnostic.invariantClass, null);
	assert.equal(diagnostic.message, null);
	assert.match(diagnostic.messageSha256 ?? "", /^[0-9a-f]{64}$/);
	assert.doesNotMatch(JSON.stringify(diagnostic), /private-task|SYNTHETICSECRET|sk-/);
});

test("future unlisted seal errors retain redacted cause, safe code, and relative source", () => {
	const key = "sk-SYNTHETICFUTUREKEY999";
	const cause = new TypeError(`upstream Bearer ${key}`);
	const error = new HarnessError("runner.future-invariant",
		`Future seal invariant failed Authorization: Bearer ${key}`) as HarnessError & { cause?: Error };
	error.cause = cause;
	error.stack = `HarnessError: ${error.message}\n    at seal (file://${new URL("../scripts/manual-private-campaign.ts", import.meta.url).pathname}:812:19)`;
	const diagnostic = offlineChecks.privateSealDiagnostic(error, "normal-continuation-seal", key);
	assert.equal(diagnostic.kind, "unclassified-error");
	assert.equal(diagnostic.message, null);
	assert.equal(diagnostic.exceptionClass, "HarnessError");
	assert.equal(diagnostic.safeCode, "runner.future-invariant");
	assert.equal(diagnostic.source, "scripts/manual-private-campaign.ts:812:19");
	assert.equal(diagnostic.messageSha256, createHash("sha256").update(error.message).digest("hex"));
	assert.match(diagnostic.redactedMessage ?? "", /Future seal invariant failed/);
	assert.equal(diagnostic.causeChain.length, 1);
	assert.equal(diagnostic.causeChain[0].exceptionClass, "TypeError");
	assert.doesNotMatch(JSON.stringify(diagnostic), /SYNTHETICFUTUREKEY999|file:\/\/|\/workspace\//);
});

test("future collection error keeps bounded redacted text only in its private diagnostic", () => {
	const key = "sk-SYNTHETICCOLLECTIONKEY999";
	const error = new Error(`collector failed Bearer ${key}`);
	const diagnostic = offlineChecks.privateCollectionDiagnostic(error, key);
	assert.equal(diagnostic.kind, "unclassified-error");
	assert.equal(diagnostic.message, null);
	assert.equal(diagnostic.exceptionClass, "Error");
	assert.match(diagnostic.messageSha256 ?? "", /^[0-9a-f]{64}$/);
	assert.match(diagnostic.redactedMessage ?? "", /collector failed Bearer \[REDACTED_KEY\]/);
	assert.doesNotMatch(JSON.stringify(diagnostic), /SYNTHETICCOLLECTIONKEY999/);
});

test("synthetic 4.26 MiB continuation survives collection and compressed sidecar transport", async () => {
	const directory = await mkdtemp(path.join(os.tmpdir(), "mulpis-large-history-fixture-"));
	try {
		const prior = {
			"candidate.cpp": "C".repeat(1_020_000),
			"objective-checkpoint.json": JSON.stringify({ contract: { id: "synthetic" },
				padding: "P".repeat(900_000) }),
			"research-history.json": JSON.stringify({ version: 1,
				kind: "untrusted-version-bound-research-history",
				entries: [{ goalRunId: "R001", taskId: "T001",
					files: { "synthetic.txt": "H".repeat(2_600_000) } }] }),
		};
		const carried = await offlineChecks.collectContinuationBundle(directory, prior);
		assert.ok(carried);
		const plaintext = Buffer.from(JSON.stringify(carried), "utf8");
		assert.ok(plaintext.length > 4.26 * 1024 * 1024);
		const binding = { key: Buffer.alloc(32, 7), seedDigest: "a".repeat(64),
			parentDigest: "b".repeat(64), source: { runId: "7", runAttempt: 1,
				runNumber: 7, commit: "c".repeat(40) } };
		const encoded = encodeCarrySidecars({ ...binding, plaintext });
		assert.ok(encoded.sidecars.length >= 5);
		assert.ok(encoded.sidecars.reduce((sum, part) => sum + part.bytes.length, 0) < plaintext.length);
		const parts = new Map(encoded.sidecars.map(part => [part.name, part.bytes]));
		assert.deepEqual(decodeCarrySidecars({ ...binding, manifest: encoded.manifest,
			load: name => parts.get(name)! }), plaintext);
	} finally { await rm(directory, { recursive: true, force: true }); }
});

test("research history above 4 MiB retains exact bytes and full ordered range-readable parts", async () => {
	const directory = await mkdtemp(path.join(os.tmpdir(), "mulpis-large-history-part-fixture-"));
	try {
		const sourceText = "雪 and synthetic data 🌙".repeat(175_000);
		const history = JSON.stringify({ version: 1, kind: "untrusted-version-bound-research-history",
			entries: [{ goalRunId: "R001", taskId: "T001", files: { "synthetic.txt": sourceText } }] });
		assert.ok(Buffer.byteLength(history, "utf8") > 4 * 1024 * 1024);
		await writeFile(path.join(directory, "research-history.json"), history);
		const carried = await offlineChecks.collectContinuationBundle(directory,
			{ "candidate.cpp": "synthetic selected source" });
		assert.equal(carried?.["research-history.json"], history);
		const staged = await offlineChecks.stageRangeReadableHistory(directory, carried!["research-history.json"]!);
		assert.equal(staged.partitioned, true);
		const index = JSON.parse(await readFile(path.join(directory,
			"prior-research-history-index.json"), "utf8"));
		const contents = await Promise.all(index.parts.map((part: { name: string; bytes: number }) =>
			readFile(path.join(directory, part.name))));
		assert.ok(contents.every((part: Buffer) => part.length <= 1_000_000));
		assert.equal(Buffer.concat(contents).toString("utf8"), offlineChecks.rangeReadableHistory(history));
		const readable = JSON.parse(Buffer.concat(contents).toString("utf8"));
		assert.equal(readable.entries[0].files["synthetic.txt"].segments.join(""), sourceText);
	} finally { await rm(directory, { recursive: true, force: true }); }
});

test("driver persists canonical encrypted sidecars before publishing root carry", async () => {
	const data = Buffer.alloc(28, 11).toString("base64");
	const calls: string[] = [];
	const writer = { write: async (target: string, text: string,
		options: { mode: number; flag: "wx" }) => {
		assert.deepEqual(options, { mode: 0o600, flag: "wx" });
		const name = path.basename(target);
		calls.push(`write:${name}`);
		if (name.endsWith(".enc")) assert.equal(text, data);
	}, rename: async (source: string, destination: string) => {
		calls.push(`rename:${path.basename(source)}:${path.basename(destination)}`);
	} };
	const carry = { envelopeB64: "synthetic-root", sidecars: {
		"ledger-continuation.part-00000001.enc": data,
		"ledger-continuation.part-00000000.enc": data } };
	await offlineChecks.writeSealedCarryFiles("/synthetic-output", carry, writer);
	assert.deepEqual(calls, ["write:ledger-continuation.part-00000000.enc",
		"write:ledger-continuation.part-00000001.enc",
		`write:ledger-continuation.enc.json.${process.pid}.tmp`,
		`rename:ledger-continuation.enc.json.${process.pid}.tmp:ledger-continuation.enc.json`]);
	const partialCalls: string[] = [];
	await assert.rejects(offlineChecks.writeSealedCarryFiles("/synthetic-output", carry, {
		write: async target => { const name = path.basename(target); partialCalls.push(name);
			if (name === "ledger-continuation.part-00000001.enc") throw Error("synthetic write failure"); },
		rename: async () => { throw Error("root must not publish"); },
	}));
	assert.deepEqual(partialCalls, ["ledger-continuation.part-00000000.enc",
		"ledger-continuation.part-00000001.enc"]);
	const unsafeCalls: string[] = [];
	await assert.rejects(offlineChecks.writeSealedCarryFiles("/synthetic-output", {
		envelopeB64: "root", sidecars: { "../ledger-continuation.part-00000000.enc": data } }, {
		write: async target => { unsafeCalls.push(target); }, rename: async () => undefined }));
	assert.deepEqual(unsafeCalls, []);
	const nearLimit = Buffer.alloc(CARRY_SEGMENT_FILE_BYTES - 1, 13).toString("base64");
	let nearLimitWritten = false;
	await offlineChecks.writeSealedCarryFiles("/synthetic-output", { envelopeB64: "root", sidecars: {
		"ledger-continuation.part-00000000.enc": nearLimit } }, {
		write: async (target, content) => { if (target.endsWith(".enc")) {
			assert.equal(content, nearLimit); nearLimitWritten = true; } },
		rename: async () => undefined,
	});
	assert.equal(nearLimitWritten, true);
});

test("read-only credential probe uses one official model-list request and stores only status", async () => {
	let calls = 0;
	const mocked = (async (url: string | URL | Request, init?: RequestInit) => {
		calls++;
		assert.equal(String(url), "https://api.deepseek.com/models");
		assert.equal(init?.method, "GET");
		assert.equal(init?.redirect, "error");
		assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer sk-SYNTHETIC_TEST_KEY");
		return new Response(null, { status: 200 });
	}) as typeof fetch;
	assert.deepEqual(await offlineChecks.credentialProbe("sk-SYNTHETIC_TEST_KEY", mocked),
		{ httpStatus: 200, accepted: true });
	assert.equal(calls, 1);
	const rejected = (async () => new Response(null, { status: 401 })) as typeof fetch;
	assert.deepEqual(await offlineChecks.credentialProbe("sk-SYNTHETIC_TEST_KEY", rejected),
		{ httpStatus: 401, accepted: false });
});

test("private campaign uses only a live verified native-CNY peak profile for new requests", async () => {
	const request = (async (url: string | URL | Request, options?: RequestInit) => {
		assert.equal(String(url), "https://api.deepseek.com/user/balance");
		assert.equal(options?.method, "GET");
		return new Response(JSON.stringify({ is_available: true,
			balance_infos: [{ currency: "CNY", total_balance: "SYNTHETIC_PRIVATE_AMOUNT",
				granted_balance: "SYNTHETIC_PRIVATE_GRANT", topped_up_balance: "SYNTHETIC_PRIVATE_TOPUP" }] }),
			{ status: 200, headers: { "content-type": "application/json" } });
	}) as typeof fetch;
	const profile = await verifyDeepSeekCnyBilling({ apiKey: "SYNTHETIC_KEY", request,
		now: () => new Date("2026-10-06T11:00:00.000Z") });
	const providerOutputLimit = await verifyDeepSeekProviderOutputLimit({ apiKey: "SYNTHETIC_KEY",
		request: (async (url: string | URL | Request, options?: RequestInit) => {
			assert.equal(String(url), "https://api.deepseek.com/models");
			assert.equal(options?.method, "GET");
			return new Response(JSON.stringify({ object: "list", data: [{ id: "deepseek-flash",
				object: "model", name: "DeepSeek-V4.1-Flash", context_window: 1_048_576,
				max_output_tokens: 393_216 }] }), { status: 200 });
		}) as typeof fetch });
	const budget = offlineChecks.createPrivateCampaignBudget(profile, providerOutputLimit);
	assert.equal(budget.limits.estimatedInputCnyPerMillionTokens, 2);
	assert.equal(budget.limits.estimatedCacheReadCnyPerMillionTokens, 0.04);
	assert.equal(budget.limits.estimatedOutputCnyPerMillionTokens, 8);
	assert.equal(budget.limits.estimatedCnyPerUsd, undefined);
	assert.equal(budget.limits.maxOutputTokens, undefined);
	assert.equal(budget.limits.providerOutputLimit?.maxOutputTokens, 393_216);
	assert.equal(budget.snapshot().accountingMode, "observed-only");
	assert.equal(budget.limits.maxCny, undefined);
	assert.equal(budget.snapshot().pricingProfile?.currency, "CNY");
	assert.doesNotMatch(JSON.stringify(budget.requestAccountingAuditSnapshot()), /SYNTHETIC_PRIVATE_AMOUNT|SYNTHETIC_KEY/);
	const source = await readFile(new URL("../scripts/manual-private-campaign.ts", import.meta.url), "utf8");
	assert.ok(source.indexOf("await verifyDeepSeekProviderOutputLimit({ apiKey: runtimeKey })") <
		source.indexOf("const budget = createPrivateCampaignBudget(nativeCnyPricing"));
	assert.ok(source.indexOf("await verifyDeepSeekCnyBilling({ apiKey: runtimeKey })") <
		source.indexOf("const budget = createPrivateCampaignBudget(nativeCnyPricing"));
});

test("held campaign records a branded fresh availability observation before proceeding", async t => {
	const outputDir = await mkdtemp(path.join(os.tmpdir(), "mulpis-availability-"));
	t.after(() => rm(outputDir, { recursive: true, force: true }));
	let fetches = 0, appends = 0;
	const payload = JSON.stringify({ version: 1, kind: "provider-availability-observation",
		entries: [{ source: { runId: "47", runAttempt: 1, commit: "a".repeat(40) },
			priorEnvelopeSha256: "b".repeat(64), availability: "available" }] });
	const ledger = { priorProviderPaymentHold: true,
		appendProviderAvailabilityObservation(observation: unknown) {
			appends++;
			assert.equal(isVerifiedDeepSeekAvailability(observation), true);
			assert.deepEqual(observation, { availability: "available" });
			return payload;
		} } as Parameters<typeof offlineChecks.checkHeldProviderAvailability>[0]["ledger"];
	const checked = await offlineChecks.checkHeldProviderAvailability({ ledger,
		apiKey: "synthetic-secret", outputDir, request: async (url, init) => {
			fetches++;
			assert.equal(String(url), "https://api.deepseek.com/user/balance");
			assert.equal(init?.method, "GET");
			return new Response(JSON.stringify({ is_available: true, balance_infos: [{ currency: "USD",
				total_balance: "SECRET_AMOUNT", granted_balance: "SECRET_GRANT",
				topped_up_balance: "SECRET_TOPUP" }] }), { status: 200 });
		} });
	assert.equal(checked?.availability, "available");
	assert.equal(fetches, 1);
	assert.equal(appends, 1);
	const file = path.join(outputDir, "provider-availability-observation.json");
	assert.equal(await readFile(file, "utf8"), payload);
	assert.equal((await stat(file)).mode & 0o077, 0);
	assert.doesNotMatch(await readFile(file, "utf8"), /SECRET_|synthetic-secret/);
	const carried = await offlineChecks.collectContinuationBundle(outputDir,
		{ "candidate.cpp": "// retained selected source" });
	assert.equal(carried?.["provider-availability-observation.json"], payload);
});

test("held campaign records false and ambiguous results before blocking model work", async t => {
	const outputDir = await mkdtemp(path.join(os.tmpdir(), "mulpis-availability-"));
	t.after(() => rm(outputDir, { recursive: true, force: true }));
	for (const [label, response, expected] of [
		["false", new Response(JSON.stringify({ is_available: false, balance_infos: [] }),
			{ status: 200 }), "unavailable"],
		["http error", new Response("PRIVATE_BODY", { status: 402 }), "unknown"],
	] as const) {
		const target = path.join(outputDir, label);
		await mkdir(target);
		let recorded = "";
		const ledger = { priorProviderPaymentHold: true,
			appendProviderAvailabilityObservation(observation: unknown) {
				assert.equal(isVerifiedDeepSeekAvailability(observation), true);
				recorded = (observation as { availability: string }).availability;
				return JSON.stringify({ availability: recorded });
			} } as Parameters<typeof offlineChecks.checkHeldProviderAvailability>[0]["ledger"];
		await assert.rejects(offlineChecks.checkHeldProviderAvailability({ ledger,
			apiKey: "synthetic-secret", outputDir: target, request: async () => response }),
			/no model request is allowed/);
		assert.equal(recorded, expected, label);
		assert.equal(JSON.parse(await readFile(path.join(target,
			"provider-availability-observation.json"), "utf8")).availability, expected);
	}
});

test("campaign without an authenticated payment hold does not probe or emit a release", async t => {
	const outputDir = await mkdtemp(path.join(os.tmpdir(), "mulpis-no-availability-"));
	t.after(() => rm(outputDir, { recursive: true, force: true }));
	const ledger = { priorProviderPaymentHold: false,
		appendProviderAvailabilityObservation() { throw Error("unexpected append"); }
	} as Parameters<typeof offlineChecks.checkHeldProviderAvailability>[0]["ledger"];
	const checked = await offlineChecks.checkHeldProviderAvailability({ ledger, apiKey: "synthetic-secret",
		outputDir, request: async () => { throw Error("unexpected fetch"); } });
	assert.equal(checked, undefined);
	assert.deepEqual(await readFile(path.join(outputDir,
		"provider-availability-observation.json"), "utf8").catch(() => undefined), undefined);
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

test("selected M07 read requirement derives exact frozen review artifacts without guessing prefixes", () => {
	const root = path.join(os.tmpdir(), "synthetic-m07-read-root");
	const workDir = path.join(root, "tasks", "T002", "work");
	const names = ["candidate.cpp", "verification.json", "lesson-delta.json"];
	const artifacts = names.map((name, index) => ({ sourcePath: path.join(workDir, name),
		path: path.join(root, "tasks", "T002", "review-snapshot", `${String(index + 4).padStart(3, "0")}-${name}`) }));
	const task = { taskId: "T002", workDir, status: "accepted", review: { artifacts } } as any;
	assert.deepEqual(offlineChecks.selectedM07ReviewReadPaths(root, task),
		artifacts.map(item => path.relative(root, item.path)));
	assert.throws(() => offlineChecks.selectedM07ReviewReadPaths(root, { ...task,
		review: { artifacts: [{ ...artifacts[0], path: path.join(root, "tasks", "T001", "review-snapshot", "004-candidate.cpp") },
			...artifacts.slice(1)] } }), /outside the expected frozen task snapshot/);
	assert.throws(() => offlineChecks.selectedM07ReviewReadPaths(root, { ...task,
		review: { artifacts: artifacts.slice(1) } }), /missing or ambiguous/);
});

test("registered protocol accounts for startup, first call, warmups and every model-planned sample", () => {
	const metadata = { targets: ["synthetic_1", "synthetic_2"], baselines: { serial: "reference_one", stdThread: "reference_two" },
		timing: { cases: [{ id: "shape-a", rows: 4, cols: 8, normalNnz: 2, longRows: 1, longNnz: 5, seed: 7,
			threadCounts: [1], warmups: 1, repeats: 3 }] } } as unknown as Parameters<typeof offlineChecks.parseRegisteredCheckerOutput>[1];
	const line = (kind: string, target: number, name: string) => `CSR_TIMING case=shape-a kind=${kind} target=${target} name=${name} rows=4 cols=8 ordinary_nnz=2 heavy_rows=1 heavy_nnz=5 seed=7 threads=1 warmups=1 repeats=3 min_ns=3 median_ns=5 max_ns=7 startup_ns=11 cold_ns=9 warmup_samples_ns=8 samples_ns=3,5,7`;
	const output = [line("serial", 0, "reference_one"), line("std_thread", 0, "reference_two"),
		line("strategy", 1, "synthetic_1"), line("strategy", 2, "synthetic_2"), "CSR_CHECK_PASS"].join("\n");
	const result = offlineChecks.parseRegisteredCheckerOutput(output, metadata);
	assert.equal(result.status, "passed");
	assert.equal(result.timings.length, 4);
	assert.equal(result.timings[0].startupNs, 11);
	assert.equal(result.timings[0].coldNs, 9);
	assert.equal(result.timings[0].requestedThreads, 1);
	assert.equal(result.timings[0].actualThreads, "not_observed");
	assert.deepEqual(result.timings[0].warmupSamplesNs, [8]);
	for (const altered of [output.replace("startup_ns=11", "startup_ns=0"),
		output.replace("warmup_samples_ns=8", "warmup_samples_ns=8,8"), output.replace("median_ns=5", "median_ns=6"),
		output.replace("threads=1", "threads=2"), output.replace("strategy:2", "strategy:1") + "\nextra"]) {
		assert.equal(offlineChecks.parseRegisteredCheckerOutput(altered, metadata).status, "failed");
	}
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

test("measurement mounts evaluator and immutable reference workers read-only while preserving separate temporary scratch", () => {
	const work = "/tmp/synthetic-evaluator-work";
	const execute = offlineChecks.sandboxArguments("/work/registered-checker", ["--check"], work, true);
	const compile = offlineChecks.sandboxArguments("/usr/bin/g++", ["source.cpp", "-o", "worker"], work, false);
	const mount = execute.indexOf(work);
	assert.equal(execute[mount - 1], "--ro-bind");
	assert.equal(execute[mount + 1], "/work");
	assert.equal(compile[compile.indexOf(work) - 1], "--bind");
	assert.ok(execute.includes("--tmpfs") && execute[execute.indexOf("--tmpfs") + 1] === "/tmp");
	assert.ok(execute.includes("--unshare-net") && execute.includes("--clearenv"));
	assert.deepEqual(execute.slice(-3), ["--", "/work/registered-checker", "--check"]);
});

test("native worker sandbox arguments hide the trusted observer parent's proc and environment", () => {
	const args = offlineChecks.sandboxArguments("/work/probe-bin", [],
		"/tmp/synthetic-worker", true);
	const program = args.indexOf("--");
	const sandbox = args.slice(0, program);
	assert.ok(sandbox.includes("--unshare-pid"));
	assert.ok(sandbox.includes("--unshare-net"));
	assert.ok(sandbox.includes("--clearenv"));
	assert.deepEqual(sandbox.slice(sandbox.indexOf("--proc"), sandbox.indexOf("--proc") + 2),
		["--proc", "/proc"], "the worker gets its own proc mount");
	assert.ok(!sandbox.some((value, index) => value === "/proc" &&
		["--bind", "--ro-bind"].includes(sandbox[index - 1] ?? "")),
	"the trusted parent's proc tree must never be mounted into the worker");
	assert.ok(!sandbox.includes("MULPIS_SYNTHETIC_PARENT_SECRET_CANARY"));
});
