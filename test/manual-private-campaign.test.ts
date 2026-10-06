import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir, stat, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import test from "node:test";
import { offlineChecks } from "../scripts/manual-private-campaign.ts";
import { reserveIndependentRestart } from "../src/m07/independent-restart.ts";
import { verifyDeepSeekCnyBilling } from "../src/runner/deepseek-cny-pricing.ts";
import { verifyDeepSeekProviderOutputLimit } from "../src/runner/deepseek-provider-limits.ts";
import { Workspace } from "../src/workspace.ts";

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
		freshWorkspace: { workspaceId: "fresh-workspace", restartNonce: "nonce" },
		failedHistory: { state: "unavailable" as const, reason: "Synthetic encrypted evidence gap",
			immutableArtifactRef: facts.resultArtifact.immutableRef, digestScope: facts.resultArtifact.digestScope,
			artifactSha256: facts.resultArtifact.sha256 } };
	const reservation = await reserveIndependentRestart(input, {
		authenticatedFacts: proof => proof === input.authenticatedCarryProof ? facts : undefined,
		reviewEffects: async (_facts, refs) => ({ sourceCommit: facts.source.commit,
			policyId: "synthetic-reviewed-policy", policySha256: hash("policy"),
			operationAttestations: refs.map(operationRef => ({ operationRef,
				sourceCommit: facts.source.commit, evidenceSha256: hash(operationRef) })),
			effectClass: "confined-ephemeral-local", unknownBillingHeld: true,
			actorThirdPartyMutations: "none", hostTransport: "immutable-versioned-archive" }),
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
		await writeFile(path.join(source, "workflow-archive.json"), JSON.stringify({
			files: [{ name: "candidate.cpp", status: "present" }],
			controllerEvidence: { rounds: [{ candidate: { file: "round-1-candidate.cpp" }, verification: { status: "missing" },
				feedbackFile: "round-1-reviewer-feedback.txt", reviewerReport: { file: "round-1-reviewer-report.md" } }],
				reviewDecision: { file: "review-decision.json" } },
			m04: { knowledgeExport: { state: "complete", file: "m04-adopted-knowledge.json" } },
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
