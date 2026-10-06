import assert from "node:assert/strict";
import { constants, createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { stageArchivedM07Import, validateArchivedM07Import } from "../src/runner/archived-m07-import.ts";
import { createFileKnowledgeStore } from "../src/knowledge/store.ts";
import { createM07Controller } from "../src/m07/controller.ts";
import { assessAndAdvanceOriginalObjective, writeOriginalObjectiveContract,
	type OriginalObjectiveContractV1 } from "../src/m07/objective-progress.ts";
import { FakeSessionRunner } from "../src/runner/fake.ts";
import { runM04 } from "../src/stages/m04.ts";
import type { StageContext } from "../src/stages/context.ts";
import { Workspace } from "../src/workspace.ts";
import { archivePrivateM07Task, recordPrivateM04Outcome } from "../src/workflow-archive/m07-private.ts";
import { offlineChecks } from "../scripts/manual-private-campaign.ts";
import { CARRY_ARTIFACT_NAME, openLedgerContinuation, sealHistoricalCarryForOfflineTests,
	type PrivateContinuationBundle } from "../src/runner/ledger-continuation.ts";
import { MISSION_ARTIFACT, MISSION_ID, MISSION_REPOSITORY, MISSION_TOTAL_CNY } from
	"../src/runner/signed-mission-ledger.ts";

const originalRunId = "G001";
const taskId = "T001";
const contractId = "synthetic-contract";
const checks = ["original exact check", "independent host verification"];
const candidate = "// exact accepted source\n";
const verification = `${JSON.stringify({ version: 1, status: "passed", independent: { status: "passed" } })}\n`;

function bundleForImport(withPlan = false): PrivateContinuationBundle {
	const plan = '{"registeredStrategies":["SyntheticStrategy"],"cases":[]}\n';
	const original = { version: 1, kind: "original-objective", id: contractId,
		createdAt: "2026-10-06T00:00:00.000Z", goal: "Synthetic original objective",
		goalSource: "user-intent-summary", inputNames: ["original.cpp"],
		obligations: [{ id: "original-task", description: "Keep improving the original task" }],
		closure: "open-ended" };
	const checkpoint = { version: 1, kind: "original-objective-progress", contract: original,
		boundedRuns: [{ runId: "OLD", outcome: "fulfilled", selectedTaskId: "T001" },
			{ runId: originalRunId, outcome: "fulfilled", selectedTaskId: taskId,
			unresolvedOperationIds: [] }], continuation: { unresolvedOperationIds: [] } };
	const archive = { version: 1, kind: "m07-private-candidate-archive", goalRunId: originalRunId,
		taskId, goalOutcome: "fulfilled", taskStatus: "accepted",
		files: [
			{ name: "candidate.cpp", status: "present", bytes: Buffer.byteLength(candidate) },
			{ name: "verification.json", status: "present", bytes: Buffer.byteLength(verification) },
			{ name: "experiment-plan.json", status: withPlan ? "present" : "missing",
				...(withPlan ? { bytes: Buffer.byteLength(plan) } : {}) },
			{ name: "lesson-delta.json", status: "present", bytes: 57 },
		],
		controllerEvidence: { reviewStatus: "accepted", reviewChecks: checks.map(criterion =>
			({ criterion, result: "passed" })), reviewDecision: { file: "review-decision.json", bytes: 100 },
			operationOutcomes: [{ operationId: "O001", status: "response-received" }] },
		m04: { state: "failed", proposalSubmitted: false, snapshotCreated: false },
		knowledgeReuse: { trustedAdoption: false, adoptionPath: "M04", nextUse: "explicit-candidate-context-only" },
	};
	const history = { version: 1, kind: "untrusted-version-bound-research-history",
		entries: [{ originalContractId: contractId, goalRunId: originalRunId, taskId,
			files: { "candidate.cpp": candidate, "verification.json": verification,
				...(withPlan ? { "experiment-plan.json": plan } : {}),
				"workflow-archive.json": JSON.stringify(archive) } }] };
	return { "original-objective.json": JSON.stringify(original),
		"objective-checkpoint.json": JSON.stringify(checkpoint),
		"research-history.json": JSON.stringify(history),
		"candidate.cpp": "// earlier selected source\n",
		"verification.json": verification,
		"workflow-archive.json": JSON.stringify({ version: 1, kind: "m07-private-candidate-archive",
			goalRunId: "OLD", taskId: "T001", controllerEvidence: { reviewStatus: "accepted" } }) };
}

async function authenticatedFixture(t: TestContext, bundle: PrivateContinuationBundle) {
	const directory = await mkdtemp(path.join(tmpdir(), "archived-m07-import-"));
	t.after(async () => rm(directory, { recursive: true, force: true }));
	const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
	const publicKeyFile = path.join(directory, "public.pem");
	await writeFile(publicKeyFile, publicKey.export({ type: "spki", format: "pem" }));
	const expectedSpkiSha256 = createHash("sha256").update(publicKey.export({ type: "spki", format: "der" })).digest("hex");
	const payload = { version: 1, kind: "mul-pis-private-mission-ledger", missionId: MISSION_ID,
		repository: MISSION_REPOSITORY, globalMaxCny: MISSION_TOTAL_CNY, priorCommittedCny: 1,
		revision: 1, previous: { runId: "7001", runAttempt: 1, artifactId: "9001",
			artifactName: MISSION_ARTIFACT } };
	const bytes = Buffer.from(JSON.stringify(payload));
	const signature = sign("sha256", bytes, { key: privateKey,
		padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 });
	const seedEnvelopeB64 = Buffer.from(JSON.stringify({ payload_b64: bytes.toString("base64"),
		signature_b64: signature.toString("base64") })).toString("base64");
	const anchor = { id: 7001, run_number: 1, run_attempt: 1, workflow_id: 91,
		status: "completed", conclusion: "success", head_branch: "improve/workflow-learning-reliability",
		head_sha: "a".repeat(40), event: "workflow_dispatch", actor: { login: "SakuyaInazaki" } };
	const first = { ...anchor, id: 7002, run_number: 2, status: "in_progress",
		conclusion: undefined, head_sha: "b".repeat(40) };
	const second = { ...anchor, id: 7003, run_number: 3, status: "in_progress",
		conclusion: undefined, head_sha: "c".repeat(40) };
	let secondPhase = false;
	const request: typeof fetch = async url => {
		const at = String(url);
		let data: unknown;
		if (at.includes("/workflows/manual-private-campaign.yml/runs?"))
			data = secondPhase ? { total_count: 3,
				workflow_runs: [second, { ...first, status: "completed", conclusion: "failure" }, anchor] } :
				{ total_count: 2, workflow_runs: [first, anchor] };
		else if (at.endsWith("/runs/7001/artifacts?per_page=100"))
			data = { total_count: 1, artifacts: [{ id: 9001, name: MISSION_ARTIFACT,
				expired: false, workflow_run: { id: 7001 } }] };
		else if (at.endsWith("/runs/7002/artifacts?per_page=100"))
			data = { total_count: 1, artifacts: [{ id: 9002, name: CARRY_ARTIFACT_NAME,
				expired: false, workflow_run: { id: 7002 } }] };
		else if (at.endsWith("/runs/7002/jobs?per_page=100"))
			data = { total_count: 1, jobs: [{ id: 6002, run_id: 7002, run_attempt: 1,
				head_sha: "b".repeat(40), name: "private-campaign", status: "completed",
				conclusion: "failure", steps: [{ name: "Run bounded private campaign",
					status: "completed", conclusion: "success" }] }] };
		else throw Error(`unexpected synthetic request ${at}`);
		return new Response(JSON.stringify(data), { status: 200 });
	};
	const config = { seedEnvelopeB64, publicKeyFile, expectedSpkiSha256,
		githubToken: "synthetic-token", request };
	const firstOpened = await openLedgerContinuation({ ...config,
		current: { repository: MISSION_REPOSITORY, runId: "7002", runAttempt: "1",
			actor: "SakuyaInazaki", event: "workflow_dispatch",
			ref: "refs/heads/improve/workflow-learning-reliability", sha: "b".repeat(40),
			manualAuthorized: "true" },
		loadCarryArtifact: async () => "unused" });
	const sealed = sealHistoricalCarryForOfflineTests(firstOpened, { settledCny: 0,
		unknownOrInFlightCny: 0, requestAudit: { requests: [], settledCny: 0,
			unknownReservedCny: 0, inFlightReservedCny: 0, reservations: 0 },
		bootstrapBinding: { contractId, sourceSha256: "f".repeat(64) }, privateBundle: bundle });
	secondPhase = true;
	const opened = await openLedgerContinuation({ ...config,
		current: { repository: MISSION_REPOSITORY, runId: "7003", runAttempt: "1",
			actor: "SakuyaInazaki", event: "workflow_dispatch",
			ref: "refs/heads/improve/workflow-learning-reliability", sha: "c".repeat(40),
			manualAuthorized: "true" },
		loadCarryArtifact: async () => sealed.envelopeB64 });
	assert.ok(opened.priorCarryProof);
	assert.deepEqual(opened.priorPrivateBundle, bundle);
	return { directory, proof: opened.priorCarryProof, bundle: opened.priorPrivateBundle! };
}

test("authenticated archived accepted source stages exact untrusted inputs without resurrecting old review", async t => {
	const f = await authenticatedFixture(t, bundleForImport());
	const descriptor = validateArchivedM07Import({ proof: f.proof, bundle: f.bundle,
		contractId, goalRunId: originalRunId, taskId, expectedChecks: checks });
	assert.equal(descriptor.candidate.text, candidate);
	assert.equal(descriptor.historicalReviewClaim, "accepted-archive-claim-only");
	assert.equal(descriptor.historicalLessonAuthority, "unavailable");
	assert.equal(descriptor.historicalReviewSnapshotAuthority, "unavailable");
	const staged = await stageArchivedM07Import(descriptor, f.directory);
	assert.equal(await readFile(staged.candidatePath, "utf8"), candidate);
	assert.equal(await readFile(staged.verificationPath, "utf8"), verification);
	assert.equal(staged.planPath, undefined);
	const provenance = JSON.parse(await readFile(staged.provenancePath, "utf8"));
	assert.equal(provenance.candidateBytes, descriptor.candidate.bytes);
	assert.equal(provenance.historicalReviewSnapshotAuthority, "unavailable");
	const another = await stageArchivedM07Import(descriptor, f.directory);
	assert.notEqual(another.root, staged.root, "each import is staged in a fresh private directory");
});

test("registered historical plan stages exact bytes and missing declared plan is rejected", async t => {
	const f = await authenticatedFixture(t, bundleForImport(true));
	const descriptor = validateArchivedM07Import({ proof: f.proof, bundle: f.bundle,
		contractId, goalRunId: originalRunId, taskId, expectedChecks: checks });
	assert.ok(descriptor.plan);
	const staged = await stageArchivedM07Import(descriptor, f.directory);
	assert.equal(await readFile(staged.planPath!, "utf8"), descriptor.plan!.text);
	const altered = structuredClone(f.bundle);
	const history = JSON.parse(altered["research-history.json"]!);
	delete history.entries[0].files["experiment-plan.json"];
	altered["research-history.json"] = JSON.stringify(history);
	const rebound = await authenticatedFixture(t, altered);
	assert.throws(() => validateArchivedM07Import({ proof: rebound.proof, bundle: rebound.bundle,
		contractId, goalRunId: originalRunId, taskId, expectedChecks: checks }),
		/experiment-plan.json missing or invalid/);
});

test("archive import fails closed for forgery, changed bytes, wrong binding, unsafe state and missing source", async t => {
	const f = await authenticatedFixture(t, bundleForImport());
	const call = (bundle: PrivateContinuationBundle = f.bundle, proof: unknown = f.proof) =>
		validateArchivedM07Import({ proof, bundle, contractId, goalRunId: originalRunId,
			taskId, expectedChecks: checks });
	assert.throws(() => call(f.bundle, { ...f.proof }), /live authenticated carry binding/);
	const changed = { ...f.bundle, "candidate.cpp": "other selected tuple" };
	assert.throws(() => call(changed), /live authenticated carry binding/);
	assert.throws(() => validateArchivedM07Import({ proof: f.proof, bundle: f.bundle,
		contractId, goalRunId: "OTHER", taskId, expectedChecks: checks }), /historical selected run/);
	assert.throws(() => validateArchivedM07Import({ proof: f.proof, bundle: f.bundle,
		contractId, goalRunId: originalRunId, taskId, expectedChecks: ["weakened"] }), /archive is not/);
	const original = JSON.parse(f.bundle["original-objective.json"]!);
	const mutatedCases: Array<[string, RegExp, (bundle: PrivateContinuationBundle) => void]> = [
		["wrong contract", /original contract and checkpoint/, bundle => {
			bundle["original-objective.json"] = JSON.stringify({ ...original, id: "wrong" }); }],
		["missing source", /candidate.cpp missing or invalid/, bundle => { const history = JSON.parse(bundle["research-history.json"]!);
			delete history.entries[0].files["candidate.cpp"]; bundle["research-history.json"] = JSON.stringify(history); }],
		["source byte mismatch", /candidate.cpp differs from archived byte identity/, bundle => { const history = JSON.parse(bundle["research-history.json"]!);
			history.entries[0].files["candidate.cpp"] = "changed\n";
			bundle["research-history.json"] = JSON.stringify(history); }],
		["rejected archive", /archive is not/, bundle => { const history = JSON.parse(bundle["research-history.json"]!);
			const archive = JSON.parse(history.entries[0].files["workflow-archive.json"]);
			archive.controllerEvidence.reviewStatus = "rejected";
			history.entries[0].files["workflow-archive.json"] = JSON.stringify(archive);
			bundle["research-history.json"] = JSON.stringify(history); }],
		["missing proposal flag", /archive is not/, bundle => { const history = JSON.parse(bundle["research-history.json"]!);
			const archive = JSON.parse(history.entries[0].files["workflow-archive.json"]);
			delete archive.m04.proposalSubmitted;
			history.entries[0].files["workflow-archive.json"] = JSON.stringify(archive);
			bundle["research-history.json"] = JSON.stringify(history); }],
		["malformed snapshot flag", /archive is not/, bundle => { const history = JSON.parse(bundle["research-history.json"]!);
			const archive = JSON.parse(history.entries[0].files["workflow-archive.json"]);
			archive.m04.snapshotCreated = "false";
			history.entries[0].files["workflow-archive.json"] = JSON.stringify(archive);
			bundle["research-history.json"] = JSON.stringify(history); }],
		["missing operation census", /complete settled operation census/, bundle => {
			const history = JSON.parse(bundle["research-history.json"]!);
			const archive = JSON.parse(history.entries[0].files["workflow-archive.json"]);
			delete archive.controllerEvidence.operationOutcomes;
			history.entries[0].files["workflow-archive.json"] = JSON.stringify(archive);
			bundle["research-history.json"] = JSON.stringify(history); }],
		["duplicate operation", /complete settled operation census/, bundle => {
			const history = JSON.parse(bundle["research-history.json"]!);
			const archive = JSON.parse(history.entries[0].files["workflow-archive.json"]);
			archive.controllerEvidence.operationOutcomes.push({ operationId: "O001", status: "response-received" });
			history.entries[0].files["workflow-archive.json"] = JSON.stringify(archive);
			bundle["research-history.json"] = JSON.stringify(history); }],
		["issued operation", /complete settled operation census/, bundle => {
			const history = JSON.parse(bundle["research-history.json"]!);
			const archive = JSON.parse(history.entries[0].files["workflow-archive.json"]);
			archive.controllerEvidence.operationOutcomes[0].status = "issued";
			history.entries[0].files["workflow-archive.json"] = JSON.stringify(archive);
			bundle["research-history.json"] = JSON.stringify(history); }],
		["malformed census", /complete settled operation census/, bundle => {
			const history = JSON.parse(bundle["research-history.json"]!);
			const archive = JSON.parse(history.entries[0].files["workflow-archive.json"]);
			archive.controllerEvidence.operationOutcomes = { O001: "response-received" };
			history.entries[0].files["workflow-archive.json"] = JSON.stringify(archive);
			bundle["research-history.json"] = JSON.stringify(history); }],
		["unresolved target", /target or unqualified unresolved operation remains/, bundle => { const checkpoint = JSON.parse(bundle["objective-checkpoint.json"]!);
			checkpoint.continuation.unresolvedOperationIds = [`${originalRunId}/O001`];
			bundle["objective-checkpoint.json"] = JSON.stringify(checkpoint); }],
	];
	for (const [label, message, mutate] of mutatedCases) {
		const altered = structuredClone(f.bundle); mutate(altered);
		assert.throws(() => call(altered), /live authenticated carry binding/, label);
		const rebound = await authenticatedFixture(t, altered);
		assert.throws(() => call(rebound.bundle, rebound.proof), message, label);
	}
	await assert.rejects(stageArchivedM07Import({} as never, f.directory),
		/validated descriptor/);
});

test("import retry targets only newest failed-M04 accepted run; completion or partial yields to assessor", () => {
	const bundle = bundleForImport();
	const checkpoint = JSON.parse(bundle["objective-checkpoint.json"]!);
	const history = JSON.parse(bundle["research-history.json"]!);
	const priorArchive = JSON.parse(history.entries[0].files["workflow-archive.json"]);
	priorArchive.controllerEvidence.reviewChecks = offlineChecks.fixedPrivateChecks.diagnostic.map(criterion =>
		({ criterion, result: "passed" }));
	history.entries[0].files["workflow-archive.json"] = JSON.stringify(priorArchive);
	const update = () => {
		bundle["objective-checkpoint.json"] = JSON.stringify(checkpoint);
		bundle["research-history.json"] = JSON.stringify(history);
	};
	update();
	assert.deepEqual(offlineChecks.archivedM07ImportTarget(bundle), {
		goalRunId: originalRunId, taskId, checks: offlineChecks.fixedPrivateChecks.diagnostic,
		registered: false });
	checkpoint.boundedRuns.push({ runId: "G002", outcome: "fulfilled", selectedTaskId: "T001" });
	const newArchive = { ...priorArchive, goalRunId: "G002", m04: { ...priorArchive.m04, state: "failed" } };
	history.entries.push({ originalContractId: contractId, goalRunId: "G002", taskId: "T001",
		files: { ...history.entries[0].files,
			"workflow-archive.json": JSON.stringify(newArchive) } });
	update();
	assert.equal(offlineChecks.archivedM07ImportTarget(bundle)?.goalRunId, "G002",
		"a second failed M04 retries only the newest exact archived goal");
	newArchive.m04.state = "completed";
	history.entries[1].files["workflow-archive.json"] = JSON.stringify(newArchive);
	update();
	assert.equal(offlineChecks.archivedM07ImportTarget(bundle), undefined,
		"a completed newest M04 suppresses re-import of older failures");
	newArchive.m04.state = "failed";
	delete newArchive.m04.proposalSubmitted;
	history.entries[1].files["workflow-archive.json"] = JSON.stringify(newArchive);
	update();
	assert.throws(() => offlineChecks.archivedM07ImportTarget(bundle),
		/missing or malformed/, "missing proposal outcome requires integrity reconciliation");
	newArchive.m04.proposalSubmitted = false;
	newArchive.m04.snapshotCreated = "false";
	history.entries[1].files["workflow-archive.json"] = JSON.stringify(newArchive);
	update();
	assert.throws(() => offlineChecks.archivedM07ImportTarget(bundle),
		/missing or malformed/, "malformed snapshot outcome requires integrity reconciliation");
	newArchive.m04.snapshotCreated = true;
	history.entries[1].files["workflow-archive.json"] = JSON.stringify(newArchive);
	update();
	assert.throws(() => offlineChecks.archivedM07ImportTarget(bundle),
		/may already have submitted or merged/, "possible knowledge transaction requires reconciliation");
	newArchive.m04.snapshotCreated = false;
	newArchive.controllerEvidence.operationOutcomes = [];
	history.entries[1].files["workflow-archive.json"] = JSON.stringify(newArchive);
	update();
	assert.throws(() => offlineChecks.archivedM07ImportTarget(bundle),
		/complete settled operation census/, "missing accepted-operation census requires control reconciliation");
	newArchive.controllerEvidence.operationOutcomes = priorArchive.controllerEvidence.operationOutcomes;
	history.entries[1].files["workflow-archive.json"] = JSON.stringify(newArchive);
	checkpoint.boundedRuns.push({ runId: "G003", outcome: "partial" });
	update();
	assert.equal(offlineChecks.archivedM07ImportTarget(bundle), undefined,
		"a newer partial goal returns scientific next-step choice to the model assessor");
});

test("frozen archived source gets fresh M07 review, full-read M04 and continued original-objective assessment", async t => {
	const f = await authenticatedFixture(t, bundleForImport());
	const descriptor = validateArchivedM07Import({ proof: f.proof, bundle: f.bundle,
		contractId, goalRunId: originalRunId, taskId, expectedChecks: checks });
	const root = path.join(f.directory, "workspace");
	const ws = new Workspace(root);
	await writeFile(path.join(f.directory, "original-source.cpp"), "// original synthetic input\n");
	await mkdir(path.dirname(ws.problemFile), { recursive: true });
	await writeFile(ws.problemFile, "Synthetic original research task\n");
	const store = createFileKnowledgeStore(ws.knowledgeDir);
	await store.init();
	const baseline = await ws.startRun("M04", []);
	await ws.finishRun(baseline, "completed");
	const staged = await stageArchivedM07Import(descriptor, ws.root);
	const outputDir = path.join(f.directory, "output");
	await mkdir(outputDir);
	await writeFile(path.join(outputDir, "candidate.cpp"), f.bundle["candidate.cpp"]!);
	await writeFile(path.join(outputDir, "verification.json"), f.bundle["verification.json"]!);
	await writeFile(path.join(outputDir, "workflow-archive.json"), f.bundle["workflow-archive.json"]!);
	const selectedBefore = await readFile(path.join(outputDir, "candidate.cpp"), "utf8");
	let requiredM04Paths: string[] = [];
	let executionCalls = 0;
	const runner = new FakeSessionRunner(async ({ spec }) => {
		if (spec.tools.kind === "execution") {
			executionCalls++;
			const frozenInput = path.join(spec.tools.root, "inputs", "001-candidate.cpp");
			assert.equal(await readFile(frozenInput, "utf8"), candidate,
				"builder must inspect the declared archived input copy, not its own output");
			await writeFile(path.join(spec.tools.root, "candidate.cpp"), await readFile(frozenInput));
			await writeFile(path.join(spec.tools.root, "lesson-delta.json"),
				'{"version":1,"action":"none","evidencePaths":[]}\n');
			return "Copied exact imported source; no scientific improvement claimed.";
		}
		if (spec.label === "M04-research") {
			if (spec.tools.kind !== "read-dir") throw new Error("M04 lacks its read-only evidence grant");
			const evidenceRoot = spec.tools.root;
			const ranges = await Promise.all(requiredM04Paths.map(async relative => {
				const value = await readFile(path.join(evidenceRoot, relative), "utf8");
				const lines = value.split(/\r?\n/).length - (value.endsWith("\n") ? 1 : 0);
				return { toolName: "m07_evidence_read", status: "returned" as const, path: relative,
					requested: {}, returned: { kind: "text" as const, startLine: 1,
						endLine: lines, truncated: false }, at: new Date().toISOString() };
			}));
			return { text: "No supported transferable lesson from this limited recheck; no knowledge proposal.",
				readReturns: ranges };
		}
		return `${spec.label} returned`;
	});
	const originalCreate = runner.create.bind(runner);
	runner.create = async spec => {
		const handle = await originalCreate(spec);
		if (spec.tools.kind !== "execution") return handle;
		const workRoot = spec.tools.root;
		return { ...handle, prompt: async message => {
			const result = await handle.prompt(message);
			const copied = await readFile(path.join(workRoot, "candidate.cpp"), "utf8");
			assert.equal(copied, descriptor.candidate.text,
				"host-owned import check refuses source changes before verification");
			await writeFile(path.join(workRoot, "verification.json"), verification);
			return result;
		} };
	};
	const ctx: StageContext = { ws, store, runner, config: {
		roles: { execution: "fake/execution", reviewer: "fake/reviewer", research: "fake/research" },
		concurrency: 1, tools: {},
	} };
	const controller = createM07Controller(ctx);
	const goal = await controller.begin({ goal: "Revalidate archived candidate without replacement",
		problemRelation: `Fresh provenance check of ${originalRunId}/${taskId}`,
		constraints: ["Exact source copy only", "No historical lesson adoption"],
		successCriteria: checks, plan: "One exact-copy task, current host check, M04 adjudication",
		exploratory: true });
	const task = await controller.delegate(goal.runId, { mode: "execute",
		objective: "Read inputs/001-candidate.cpp and copy its bytes to candidate.cpp; no optimization.",
		inputs: [staged.candidatePath, staged.verificationPath, staged.provenancePath],
		expectedOutputs: ["candidate.cpp", "lesson-delta.json"], lessonDeltaOutput: "lesson-delta.json",
		checks });
	assert.equal(task.status, "returned", task.executionFailure ?? "import task did not return");
	assert.equal(await readFile(path.join(task.workDir, "candidate.cpp"), "utf8"), descriptor.candidate.text);
	assert.equal(executionCalls, 1);
	const output = path.join(task.workDir, "candidate.cpp");
	const newVerification = path.join(task.workDir, "verification.json");
	const newLesson = path.join(task.workDir, "lesson-delta.json");
	const reviewed = await controller.review(goal.runId, { taskId: task.taskId,
		checks: checks.map((criterion, index) => ({ criterion, result: "passed",
			evidence: [index === 0 ? output : newVerification] })),
		artifacts: [task.reportPath!, output, newVerification, newLesson] });
	assert.equal(reviewed.status, "accepted");
	const finished = await controller.finish(goal.runId, { outcome: "fulfilled",
		summary: "Source exact and independently rechecked; no mission replacement",
		returnPath: "M04", goalChecks: checks.map((criterion, index) => ({ criterion,
			result: "passed", evidence: [index === 0 ? output : newVerification] })) });
	assert.equal(finished.outcome, "fulfilled");
	assert.equal(finished.branchSelections?.length ?? 0, 0, "import is no optimization fork");
	const archiveDir = path.join(f.directory, "import-archive");
	await archivePrivateM07Task({ goal: finished, task: finished.tasks[0], destination: archiveDir });
	const reviewRoot = ws.runDir("M07", goal.runId);
	for (const name of ["candidate.cpp", "verification.json", "lesson-delta.json"]) {
		const evidence = reviewed.review!.artifacts.find(item => item.sourcePath === path.join(task.workDir, name));
		assert.ok(evidence, `fresh ${name} must have an actual controller-frozen review copy`);
		requiredM04Paths.push(path.relative(reviewRoot, evidence.path).replaceAll("\\", "/"));
	}
	const processed = await runM04(ctx, { feedback: { kind: "M07", runId: goal.runId },
		freshSession: true, requiredM07ReadPaths: requiredM04Paths });
	assert.equal(processed.record.status, "completed");
	assert.equal((await offlineChecks.m04EvidenceReturned(processed.record, task.taskId)).complete, true);
	assert.equal(processed.proposalId, undefined, "M04 may decide no adoption");
	await recordPrivateM04Outcome(archiveDir, { state: "completed", runId: processed.record.runId,
		proposalSubmitted: false, snapshotCreated: false, adoptedExperienceRefs: [] }, store);
	await offlineChecks.exportPrefixedArchive(archiveDir, outputDir, "provenance-import");
	await offlineChecks.preserveCandidate(ws, goal.runId, outputDir);
	assert.equal((await readdir(outputDir)).some(name => name.startsWith("workflow-fallback-")), false,
		"finalizer must not duplicate the import with a stale pre-M04 archive");
	assert.equal(await readFile(path.join(outputDir, "candidate.cpp"), "utf8"), selectedBefore,
		"current M07 acceptance and M04 handling must not replace selected mission source");
	assert.equal(JSON.parse(await readFile(path.join(outputDir, "workflow-provenance-import-archive.json"), "utf8"))
		.m04.state, "completed");
	const checkpoint = JSON.parse(f.bundle["objective-checkpoint.json"]!);
	checkpoint.boundedRuns.push({ runId: goal.runId, outcome: "fulfilled", selectedTaskId: task.taskId });
	await writeFile(path.join(outputDir, "objective-checkpoint.json"), JSON.stringify(checkpoint));
	const carry = await offlineChecks.collectContinuationBundle(outputDir, f.bundle);
	const history = JSON.parse(carry!["research-history.json"]!);
	const importedHistory = history.entries.filter((entry: { goalRunId: string; taskId: string }) =>
		entry.goalRunId === goal.runId && entry.taskId === task.taskId);
	assert.equal(importedHistory.length, 1);
	assert.equal(importedHistory[0].files["workflow-archive.json"],
		await readFile(path.join(outputDir, "workflow-provenance-import-archive.json"), "utf8"),
		"collector retains exact final prefixed archive bytes");
	const carriedM04 = JSON.parse(importedHistory[0].files["workflow-archive.json"]).m04;
	assert.equal(carriedM04.state, "completed",
		"authenticated carry must retain the final M04 result, not a stale archive");
	assert.equal(carriedM04.proposalSubmitted, false);
	assert.equal(carriedM04.snapshotCreated, false);
	const contract = JSON.parse(f.bundle["original-objective.json"]!) as OriginalObjectiveContractV1;
	const contractFile = path.join(f.directory, "original-objective.json");
	await writeOriginalObjectiveContract(contractFile, contract);
	const summaryFile = path.join(f.directory, "provenance-import-result.json");
	await writeFile(summaryFile, JSON.stringify({ version: 1, kind: "provenance-import-result",
		m07Outcome: finished.outcome, m04Status: processed.record.status,
		missionSelection: "unchanged-prior" }));
	const processing = processed.record.outputs.find(item => item.label === "处理结果");
	assert.ok(processing);
	const objectiveEvidence = [
		{ name: "candidate.cpp", file: path.join(outputDir, "candidate.cpp") },
		{ name: "provenance-import-result.json", file: summaryFile },
		{ name: "provenance-import-m04-processing.md", file: processing.path },
	];
	const objectiveRecord = await ws.startRun("M07Objective", []);
	let nextStageScheduled = false;
	const objectiveRunner = new FakeSessionRunner(async ({ spec }) => {
		if (spec.label !== "synthetic-original-objective") return "unused";
		const all = [{ name: "original-objective.json", file: contractFile }, ...objectiveEvidence];
		const readReturns = await Promise.all(all.map(async item => {
			const value = await readFile(item.file, "utf8");
			const lines = value.split(/\r?\n/).length - (value.endsWith("\n") ? 1 : 0);
			return { toolName: "objective_evidence_read", status: "returned" as const,
				path: item.name, requested: {}, returned: { kind: "text" as const,
					startLine: 1, endLine: lines, truncated: false }, at: new Date().toISOString() };
		}));
		return { text: JSON.stringify({ version: 1, decision: "continue",
			rationale: "M04 adjudication completed but the original open-ended objective remains",
			evidenceRefs: ["provenance-import-result.json"], unresolvedObligations: ["original-task"],
			unresolvedDetails: ["Further scientific work remains"], nextTask: {
				objective: "Plan next independent scientific step", addresses: ["original-task"],
				adapterScope: "registered-csr-experiment" } }), readReturns };
	});
	const next = await assessAndAdvanceOriginalObjective({ contract, contractFile,
		runner: objectiveRunner, runRecord: objectiveRecord, persistReceipt: () => ws.writeRun(objectiveRecord),
		sessionSpec: { label: "synthetic-original-objective", role: "research", model: "fake/research",
			systemPrompt: "Assess original objective from frozen evidence", persistDir: ws.sessionsDir },
		evidenceRoot: path.join(f.directory, "objective-evidence"), evidence: objectiveEvidence,
		assessmentAdmission: "admitted", advanceAdmission: () => "admitted",
		supportedTaskScopes: ["registered-csr-experiment"],
		advance: async () => { nextStageScheduled = true; } });
	assert.equal(next.assessment?.decision, "continue");
	assert.equal(nextStageScheduled, true,
		"completed import M04 must hand back to the original-objective continuation");
	assert.equal(executionCalls, 1, "recovery stage has no optimization restart or fork");
});

test("import M04 effect disposition only continues on known safe failure or completed stage", () => {
	assert.equal(offlineChecks.importM04EffectDisposition({ status: "failed",
		proposalSubmitted: false, snapshotCreated: false, threw: false }), "continue");
	assert.equal(offlineChecks.importM04EffectDisposition({ status: "failed",
		proposalSubmitted: true, snapshotCreated: false, threw: false }),
		"pending-merge-reconciliation");
	assert.equal(offlineChecks.importM04EffectDisposition({ status: "failed",
		proposalSubmitted: undefined, snapshotCreated: undefined, threw: true }),
		"m04-integrity-unknown");
	assert.equal(offlineChecks.importM04EffectDisposition({ status: "completed",
		proposalSubmitted: true, snapshotCreated: true, threw: false }), "continue",
		"a completed M04 may proceed with actually adjudicated knowledge");
});

test("failed M04 with a submitted proposal blocks assessor dispatch pending reconciliation", async t => {
	const root = await mkdtemp(path.join(tmpdir(), "m04-import-effects-"));
	t.after(async () => rm(root, { recursive: true, force: true }));
	const ws = new Workspace(root);
	await mkdir(path.dirname(ws.problemFile), { recursive: true });
	await writeFile(ws.problemFile, "Synthetic question\n");
	const store = createFileKnowledgeStore(ws.knowledgeDir);
	await store.init();
	const baseline = await ws.startRun("M04", []);
	await ws.finishRun(baseline, "completed");
	const setupRunner = new FakeSessionRunner(() => "Synthetic returned report");
	const ctx: StageContext = { ws, store, runner: setupRunner, config: {
		roles: { execution: "fake/execution", reviewer: "fake/reviewer", research: "fake/research" },
		concurrency: 1, tools: {},
	} };
	const controller = createM07Controller(ctx);
	const goal = await controller.begin({ goal: "Synthetic checked result", problemRelation: "Direct",
		constraints: ["Keep it checked"], successCriteria: ["Report checked"], plan: "Review once" });
	const task = await controller.delegate(goal.runId, { mode: "reason", objective: "Return report",
		inputs: [], expectedOutputs: [], checks: ["Report checked"] });
	const reviewed = await controller.review(goal.runId, { taskId: task.taskId,
		checks: [{ criterion: "Report checked", result: "passed", evidence: [task.reportPath!] }],
		artifacts: [task.reportPath!] });
	const finished = await controller.finish(goal.runId, { outcome: "fulfilled",
		summary: "Checked synthetic report", returnPath: "M04",
		goalChecks: [{ criterion: "Report checked", result: "passed",
			evidence: [reviewed.review!.frozenReportPath] }] });
	const archiveDir = path.join(root, "archive");
	await archivePrivateM07Task({ goal: finished, task: finished.tasks[0], destination: archiveDir });
	const malformedProposal = `\`\`\`knowledge-proposals\n${JSON.stringify([{
		op: "create", type: "K", title: "", body: "" }])}\n\`\`\``;
	ctx.runner = new FakeSessionRunner(() => malformedProposal);
	const processed = await runM04(ctx, { feedback: { kind: "M07", runId: goal.runId },
		freshSession: true });
	assert.ok(processed.proposalId, "a proposal was actually submitted before failed validation");
	assert.equal(processed.record.status, "completed",
		"the stage returned, but structural proposal failure still makes M04 incomplete");
	assert.ok(processed.record.failures.length);
	const disposition = offlineChecks.importM04EffectDisposition({ status: "failed",
		proposalSubmitted: Boolean(processed.proposalId), snapshotCreated: Boolean(processed.snapshotId),
		threw: false });
	assert.equal(disposition, "pending-merge-reconciliation");
	const archived = await recordPrivateM04Outcome(archiveDir, { state: "failed",
		runId: processed.record.runId, proposalSubmitted: true, snapshotCreated: false }, store);
	assert.equal(archived.m04?.proposalSubmitted, true);
	assert.notEqual(disposition, "continue", "assessor dispatch is gated on reconciliation");
});

test("throwing M04 leaves proposal effects unknown and fails the archived retry gate closed", async t => {
	const root = await mkdtemp(path.join(tmpdir(), "m04-import-throw-"));
	t.after(async () => rm(root, { recursive: true, force: true }));
	const ws = new Workspace(root);
	await mkdir(path.dirname(ws.problemFile), { recursive: true });
	await writeFile(ws.problemFile, "Synthetic question\n");
	const store = createFileKnowledgeStore(ws.knowledgeDir);
	await store.init();
	const baseline = await ws.startRun("M04", []);
	await ws.finishRun(baseline, "completed");
	const ctx: StageContext = { ws, store, runner: new FakeSessionRunner(() => "Synthetic returned report"),
		config: { roles: { execution: "fake/execution", reviewer: "fake/reviewer",
			research: "fake/research" }, concurrency: 1, tools: {} } };
	const controller = createM07Controller(ctx);
	const goal = await controller.begin({ goal: "Synthetic checked result", problemRelation: "Direct",
		constraints: ["Keep it checked"], successCriteria: ["Report checked"], plan: "Review once" });
	const task = await controller.delegate(goal.runId, { mode: "reason", objective: "Return report",
		inputs: [], expectedOutputs: [], checks: ["Report checked"] });
	const reviewed = await controller.review(goal.runId, { taskId: task.taskId,
		checks: [{ criterion: "Report checked", result: "passed", evidence: [task.reportPath!] }],
		artifacts: [task.reportPath!] });
	const finished = await controller.finish(goal.runId, { outcome: "fulfilled",
		summary: "Checked synthetic report", returnPath: "M04",
		goalChecks: [{ criterion: "Report checked", result: "passed",
			evidence: [reviewed.review!.frozenReportPath] }] });
	const archiveDir = path.join(root, "archive");
	await archivePrivateM07Task({ goal: finished, task: finished.tasks[0], destination: archiveDir });
	ctx.runner = new FakeSessionRunner(() => { throw new Error("synthetic M04 transport outcome unavailable"); });
	await assert.rejects(runM04(ctx, { feedback: { kind: "M07", runId: goal.runId },
		freshSession: true }), /outcome unavailable/);
	const disposition = offlineChecks.importM04EffectDisposition({ status: "failed",
		proposalSubmitted: undefined, snapshotCreated: undefined, threw: true });
	assert.equal(disposition, "m04-integrity-unknown");
	const archived = await recordPrivateM04Outcome(archiveDir, { state: "failed",
		proposalSubmitted: undefined, snapshotCreated: undefined }, store);
	assert.equal(Object.hasOwn(archived.m04!, "proposalSubmitted"), false);
	assert.equal(Object.hasOwn(archived.m04!, "snapshotCreated"), false);
	assert.notEqual(disposition, "continue", "unknown effect cannot reach assessor dispatch");
});
