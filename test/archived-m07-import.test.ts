import assert from "node:assert/strict";
import { constants, createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { historicalM04EvidenceIndex, stageArchivedM07Import,
	validateArchivedM07Import } from "../src/runner/archived-m07-import.ts";
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
		m04: { state: "failed", runId: "M04-NO-PROPOSAL", proposalSubmitted: false,
			snapshotCreated: false, transaction: { file: "m04-transaction.json", state: "no-proposal" } },
		knowledgeReuse: { trustedAdoption: false, adoptionPath: "M04", nextUse: "explicit-candidate-context-only" },
	};
	const history = { version: 1, kind: "untrusted-version-bound-research-history",
		entries: [{ originalContractId: contractId, goalRunId: originalRunId, taskId,
			files: { "candidate.cpp": candidate, "verification.json": verification,
				...(withPlan ? { "experiment-plan.json": plan } : {}),
				"m04-transaction.json": JSON.stringify({ version: 1, kind: "m04-knowledge-transaction",
					m04RunId: archive.m04.runId, state: "no-proposal", attempts: [],
					updatedAt: "2026-10-06T00:00:00.000Z" }),
				"workflow-archive.json": JSON.stringify(archive) } }] };
	return { "original-objective.json": JSON.stringify(original),
		"objective-checkpoint.json": JSON.stringify(checkpoint),
		"research-history.json": JSON.stringify(history),
		"candidate.cpp": "// earlier selected source\n",
		"verification.json": verification,
		"workflow-archive.json": JSON.stringify({ version: 1, kind: "m07-private-candidate-archive",
			goalRunId: "OLD", taskId: "T001", controllerEvidence: { reviewStatus: "accepted" } }) };
}

function bundleForRejectedM04Transaction(): PrivateContinuationBundle {
	const bundle = bundleForImport();
	const history = JSON.parse(bundle["research-history.json"]!);
	const files = history.entries[0].files;
	const archive = JSON.parse(files["workflow-archive.json"]);
	archive.m04 = { state: "failed", runId: "M04-REJECTED", proposalSubmitted: true,
		snapshotCreated: false, adoptedExperienceRefs: [], knowledgeExport: { state: "none" },
		transaction: { file: "m04-transaction.json", state: "rejected-draft" } };
	files["workflow-archive.json"] = JSON.stringify(archive);
	const proposalId = "P0001", proposalFile = `knowledge/proposals/${proposalId}.json`;
	const issues = [{ level: "error", message: "synthetic structural issue", opIndex: 0 }];
	files["m04-transaction.json"] = JSON.stringify({ version: 1, kind: "m04-knowledge-transaction",
		m04RunId: archive.m04.runId, state: "rejected-draft", currentProposalId: proposalId,
		attempts: [{ ordinal: 1, proposalId, proposalFile, receiptFile: "proposal-validation-0001.json",
			structurallyValid: false, issues, state: "rejected-draft",
			proposalDraftJson: JSON.stringify({ id: proposalId, stage: "M04", runId: archive.m04.runId,
				ops: [{ op: "create", type: "K", title: "", body: "" }] }),
			validationReceiptJson: JSON.stringify({ version: 1, kind: "m04-proposal-validation",
				m04RunId: archive.m04.runId, proposalId, proposalFile, structurallyValid: false, issues }) }],
		updatedAt: "2026-10-06T00:00:00.000Z" });
	bundle["research-history.json"] = JSON.stringify(history);
	return bundle;
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

test("failed M04 with no proposal still requires a matching no-proposal transaction", async t => {
	for (const state of ["missing", "merge-intent", "unknown", "rejected-draft"] as const) {
		const bundle = bundleForImport();
		const history = JSON.parse(bundle["research-history.json"]!);
		if (state === "missing") {
			delete history.entries[0].files["m04-transaction.json"];
			const archive = JSON.parse(history.entries[0].files["workflow-archive.json"]);
			delete archive.m04.transaction;
			history.entries[0].files["workflow-archive.json"] = JSON.stringify(archive);
		} else {
			const receipt = JSON.parse(history.entries[0].files["m04-transaction.json"]);
			receipt.state = state;
			history.entries[0].files["m04-transaction.json"] = JSON.stringify(receipt);
		}
		bundle["research-history.json"] = JSON.stringify(history);
		const f = await authenticatedFixture(t, bundle);
		assert.throws(() => validateArchivedM07Import({ proof: f.proof, bundle: f.bundle,
			contractId, goalRunId: originalRunId, taskId, expectedChecks: checks }), /archived M07 import:/, state);
	}
});

test("authenticated future rejected-draft transaction allows only fresh untrusted provenance import", async t => {
	const f = await authenticatedFixture(t, bundleForRejectedM04Transaction());
	const descriptor = validateArchivedM07Import({ proof: f.proof, bundle: f.bundle,
		contractId, goalRunId: originalRunId, taskId, expectedChecks: checks });
	assert.equal(descriptor.candidate.text, candidate);
	assert.equal(descriptor.historicalLessonAuthority, "unavailable");
	assert.equal(descriptor.historicalReviewSnapshotAuthority, "unavailable");
	const staged = await stageArchivedM07Import(descriptor, f.directory);
	assert.equal(await readFile(staged.candidatePath, "utf8"), candidate);
	assert.equal((await readFile(staged.provenancePath, "utf8")).includes("synthetic structural issue"), false,
		"rejected proposal details do not become trusted import context");
	const prefixed = bundleForRejectedM04Transaction();
	const prefixedHistory = JSON.parse(prefixed["research-history.json"]!);
	const prefixedArchive = JSON.parse(prefixedHistory.entries[0].files["workflow-archive.json"]);
	prefixedArchive.transportLayout = { kind: "prefixed-flat-index", prefix: "provenance-import",
		defaultArchiveLoaderCompatible: false };
	prefixedArchive.m04.transaction.file = "provenance-import-m04-transaction.json";
	prefixedHistory.entries[0].files["workflow-archive.json"] = JSON.stringify(prefixedArchive);
	prefixed["research-history.json"] = JSON.stringify(prefixedHistory);
	const prefixedBinding = await authenticatedFixture(t, prefixed);
	assert.equal(validateArchivedM07Import({ proof: prefixedBinding.proof, bundle: prefixedBinding.bundle,
		contractId, goalRunId: originalRunId, taskId, expectedChecks: checks }).candidate.text, candidate);
	const multi = bundleForRejectedM04Transaction();
	const history = JSON.parse(multi["research-history.json"]!);
	const tx = JSON.parse(history.entries[0].files["m04-transaction.json"]);
	const second = structuredClone(tx.attempts[0]);
	second.ordinal = 2; second.proposalId = "P0002";
	second.proposalFile = "knowledge/proposals/P0002.json";
	second.receiptFile = "proposal-validation-0002.json";
	const draft = JSON.parse(second.proposalDraftJson); draft.id = second.proposalId;
	second.proposalDraftJson = JSON.stringify(draft);
	const receipt = JSON.parse(second.validationReceiptJson);
	receipt.proposalId = second.proposalId; receipt.proposalFile = second.proposalFile;
	second.validationReceiptJson = JSON.stringify(receipt);
	tx.attempts.push(second); tx.currentProposalId = second.proposalId;
	history.entries[0].files["m04-transaction.json"] = JSON.stringify(tx);
	multi["research-history.json"] = JSON.stringify(history);
	const rebound = await authenticatedFixture(t, multi);
	assert.equal(validateArchivedM07Import({ proof: rebound.proof, bundle: rebound.bundle,
		contractId, goalRunId: originalRunId, taskId, expectedChecks: checks }).candidate.text, candidate,
		"multiple truly rejected drafts have no arbitrary attempt-count stop");
});

test("future M04 proposal import refuses missing, malformed, conflicting, or merge-possible receipts", async t => {
	const mutations: Array<[string, (bundle: PrivateContinuationBundle) => void]> = [
		["no transaction and no declaration stays pending reconciliation", bundle => {
			const h = JSON.parse(bundle["research-history.json"]!);
			const archive = JSON.parse(h.entries[0].files["workflow-archive.json"]);
			delete archive.m04.transaction;
			h.entries[0].files["workflow-archive.json"] = JSON.stringify(archive);
			delete h.entries[0].files["m04-transaction.json"];
			bundle["research-history.json"] = JSON.stringify(h);
		}],
		["undeclared transaction", bundle => { const h = JSON.parse(bundle["research-history.json"]!);
			const archive = JSON.parse(h.entries[0].files["workflow-archive.json"]);
			delete archive.m04.transaction; h.entries[0].files["workflow-archive.json"] = JSON.stringify(archive);
			bundle["research-history.json"] = JSON.stringify(h); }],
		["wrong transaction pointer", bundle => { const h = JSON.parse(bundle["research-history.json"]!);
			const archive = JSON.parse(h.entries[0].files["workflow-archive.json"]);
			archive.m04.transaction.file = "other-m04-transaction.json";
			h.entries[0].files["workflow-archive.json"] = JSON.stringify(archive);
			bundle["research-history.json"] = JSON.stringify(h); }],
		["wrong transaction declaration state", bundle => { const h = JSON.parse(bundle["research-history.json"]!);
			const archive = JSON.parse(h.entries[0].files["workflow-archive.json"]);
			archive.m04.transaction.state = "merge-intent";
			h.entries[0].files["workflow-archive.json"] = JSON.stringify(archive);
			bundle["research-history.json"] = JSON.stringify(h); }],
		["prefixed layout with unprefixed pointer", bundle => { const h = JSON.parse(bundle["research-history.json"]!);
			const archive = JSON.parse(h.entries[0].files["workflow-archive.json"]);
			archive.transportLayout = { kind: "prefixed-flat-index", prefix: "provenance-import" };
			h.entries[0].files["workflow-archive.json"] = JSON.stringify(archive);
			bundle["research-history.json"] = JSON.stringify(h); }],
		["missing matched transaction despite top-level copy", bundle => { const h = JSON.parse(bundle["research-history.json"]!);
			bundle["m04-transaction.json"] = h.entries[0].files["m04-transaction.json"];
			delete h.entries[0].files["m04-transaction.json"]; bundle["research-history.json"] = JSON.stringify(h); }],
		["malformed transaction", bundle => { const h = JSON.parse(bundle["research-history.json"]!);
			h.entries[0].files["m04-transaction.json"] = "{invalid"; bundle["research-history.json"] = JSON.stringify(h); }],
		["different M04 run", bundle => { const h = JSON.parse(bundle["research-history.json"]!);
			const tx = JSON.parse(h.entries[0].files["m04-transaction.json"]); tx.m04RunId = "M04-OTHER";
			h.entries[0].files["m04-transaction.json"] = JSON.stringify(tx); bundle["research-history.json"] = JSON.stringify(h); }],
		["merge intent", bundle => { const h = JSON.parse(bundle["research-history.json"]!);
			const tx = JSON.parse(h.entries[0].files["m04-transaction.json"]); tx.state = "merge-intent";
			h.entries[0].files["m04-transaction.json"] = JSON.stringify(tx); bundle["research-history.json"] = JSON.stringify(h); }],
		["unknown transaction", bundle => { const h = JSON.parse(bundle["research-history.json"]!);
			const tx = JSON.parse(h.entries[0].files["m04-transaction.json"]); tx.state = "unknown";
			h.entries[0].files["m04-transaction.json"] = JSON.stringify(tx); bundle["research-history.json"] = JSON.stringify(h); }],
		["earlier merged attempt", bundle => { const h = JSON.parse(bundle["research-history.json"]!);
			const tx = JSON.parse(h.entries[0].files["m04-transaction.json"]);
			tx.attempts.unshift({ ...tx.attempts[0], ordinal: 1, state: "merged" }); tx.attempts[1].ordinal = 2;
			h.entries[0].files["m04-transaction.json"] = JSON.stringify(tx); bundle["research-history.json"] = JSON.stringify(h); }],
		["proposal identity mismatch", bundle => { const h = JSON.parse(bundle["research-history.json"]!);
			const tx = JSON.parse(h.entries[0].files["m04-transaction.json"]);
			const draft = JSON.parse(tx.attempts[0].proposalDraftJson); draft.id = "P9999";
			tx.attempts[0].proposalDraftJson = JSON.stringify(draft);
			h.entries[0].files["m04-transaction.json"] = JSON.stringify(tx); bundle["research-history.json"] = JSON.stringify(h); }],
		["duplicate proposal identity", bundle => { const h = JSON.parse(bundle["research-history.json"]!);
			const tx = JSON.parse(h.entries[0].files["m04-transaction.json"]);
			tx.attempts.push({ ...tx.attempts[0], ordinal: 2, receiptFile: "proposal-validation-0002.json" });
			h.entries[0].files["m04-transaction.json"] = JSON.stringify(tx); bundle["research-history.json"] = JSON.stringify(h); }],
		["validation receipt mismatch", bundle => { const h = JSON.parse(bundle["research-history.json"]!);
			const tx = JSON.parse(h.entries[0].files["m04-transaction.json"]);
			const receipt = JSON.parse(tx.attempts[0].validationReceiptJson); receipt.proposalId = "P9999";
			tx.attempts[0].validationReceiptJson = JSON.stringify(receipt);
			h.entries[0].files["m04-transaction.json"] = JSON.stringify(tx); bundle["research-history.json"] = JSON.stringify(h); }],
		["no structural error", bundle => { const h = JSON.parse(bundle["research-history.json"]!);
			const tx = JSON.parse(h.entries[0].files["m04-transaction.json"]);
			tx.attempts[0].issues = [{ level: "warning", message: "not an error" }];
			h.entries[0].files["m04-transaction.json"] = JSON.stringify(tx); bundle["research-history.json"] = JSON.stringify(h); }],
		["archive snapshot conflict", bundle => { const h = JSON.parse(bundle["research-history.json"]!);
			const archive = JSON.parse(h.entries[0].files["workflow-archive.json"]); archive.m04.snapshotCreated = true;
			h.entries[0].files["workflow-archive.json"] = JSON.stringify(archive); bundle["research-history.json"] = JSON.stringify(h); }],
		["adopted refs", bundle => { const h = JSON.parse(bundle["research-history.json"]!);
			const archive = JSON.parse(h.entries[0].files["workflow-archive.json"]);
			archive.m04.adoptedExperienceRefs = [{ storeId: "S", recordId: "K001", version: 1 }];
			h.entries[0].files["workflow-archive.json"] = JSON.stringify(archive); bundle["research-history.json"] = JSON.stringify(h); }],
		["knowledge export", bundle => { const h = JSON.parse(bundle["research-history.json"]!);
			h.entries[0].files["m04-adopted-knowledge.json"] = "{}"; bundle["research-history.json"] = JSON.stringify(h); }],
		["ambiguous history", bundle => { const h = JSON.parse(bundle["research-history.json"]!);
			h.entries.push(structuredClone(h.entries[0])); bundle["research-history.json"] = JSON.stringify(h); }],
	];
	for (const [label, mutate] of mutations) {
		const bundle = bundleForRejectedM04Transaction(); mutate(bundle);
		const f = await authenticatedFixture(t, bundle);
		assert.throws(() => validateArchivedM07Import({ proof: f.proof, bundle: f.bundle,
			contractId, goalRunId: originalRunId, taskId, expectedChecks: checks }), /archived M07 import:/, label);
	}
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

test("authenticated completed provenance M04 is indexed as historical evidence without store activation", async t => {
	const bundle = bundleForImport();
	const checkpoint = JSON.parse(bundle["objective-checkpoint.json"]!);
	checkpoint.boundedRuns.push({ runId: "NEW-IMPORT", outcome: "fulfilled",
		acceptedTaskIds: ["T001"], unresolvedOperationIds: [] });
	bundle["objective-checkpoint.json"] = JSON.stringify(checkpoint);
	const history = JSON.parse(bundle["research-history.json"]!);
	const originalArchive = JSON.parse(history.entries[0].files["workflow-archive.json"]);
	const published = { version: 1, kind: "m04-published-knowledge-export",
		m04RunId: "M04-NEW", storeId: "synthetic-store", records: [{ synthetic: true }] };
	const completedArchive = { ...originalArchive, goalRunId: "NEW-IMPORT",
		transportLayout: { kind: "prefixed-flat-index", prefix: "provenance-import",
			defaultArchiveLoaderCompatible: false },
		m04: { state: "completed", runId: "M04-NEW", proposalSubmitted: true,
			snapshotCreated: true, knowledgeExport: { state: "complete",
				file: "provenance-import-m04-adopted-knowledge.json", recordCount: 1 } } };
	history.entries.push({ originalContractId: contractId, goalRunId: "NEW-IMPORT", taskId: "T001",
		files: { "workflow-archive.json": JSON.stringify(completedArchive),
			"m04-adopted-knowledge.json": JSON.stringify(published) } });
	bundle["research-history.json"] = JSON.stringify(history);
	const f = await authenticatedFixture(t, bundle);
	const index = historicalM04EvidenceIndex({ proof: f.proof, bundle: f.bundle });
	assert.equal(index?.sourceGoalRunId, "NEW-IMPORT");
	assert.equal(index?.sourceTaskId, "T001");
	assert.equal(index?.m04.runId, "M04-NEW");
	assert.equal(index?.m04.recordCount, 1);
	assert.equal(index?.historyLocation.entryIndex, 1);
	assert.equal(index?.historyLocation.knowledgeExportFileKey, "m04-adopted-knowledge.json");
	assert.equal(index?.interpretation, "historical-published-evidence-only-not-live-adopted-knowledge");
	assert.equal(JSON.stringify(index).includes("synthetic-store"), false,
		"index must not expose or auto-import archived record contents");
	const absent = structuredClone(bundle);
	const absentHistory = JSON.parse(absent["research-history.json"]!);
	delete absentHistory.entries[1].files["m04-adopted-knowledge.json"];
	absent["research-history.json"] = JSON.stringify(absentHistory);
	const missing = await authenticatedFixture(t, absent);
	assert.throws(() => historicalM04EvidenceIndex({ proof: missing.proof, bundle: missing.bundle }),
		/historical M04 knowledge export missing/);
	const mismatch = structuredClone(bundle);
	const mismatchHistory = JSON.parse(mismatch["research-history.json"]!);
	const badExport = JSON.parse(mismatchHistory.entries[1].files["m04-adopted-knowledge.json"]);
	badExport.m04RunId = "OTHER-M04";
	mismatchHistory.entries[1].files["m04-adopted-knowledge.json"] = JSON.stringify(badExport);
	mismatch["research-history.json"] = JSON.stringify(mismatchHistory);
	const wrong = await authenticatedFixture(t, mismatch);
	assert.throws(() => historicalM04EvidenceIndex({ proof: wrong.proof, bundle: wrong.bundle }),
		/historical M04 knowledge export and archive disagree/);
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

test("one-use restart binder binds first fresh goal and reuses its ownership for later same-run goals", async () => {
	const ids: string[] = [];
	const binder = offlineChecks.createOneUseRestartGoalBinder(async goalRunId => {
		ids.push(goalRunId);
		return { binding: { goalRunId }, syntheticReceipt: "one-use" };
	});
	const first = await binder("fresh-import-goal");
	const later = await binder("second-scientific-goal");
	assert.equal(first.newlyBound, true);
	assert.equal(later.newlyBound, false);
	assert.equal(later.firstBinding, first.firstBinding,
		"later goal reuses the actual first-goal binding object, not a new receipt");
	assert.deepEqual(ids, ["fresh-import-goal"]);
	const withoutImport: string[] = [];
	const ordinaryFirst = offlineChecks.createOneUseRestartGoalBinder(async goalRunId => {
		withoutImport.push(goalRunId);
		return { binding: { goalRunId } };
	});
	assert.equal((await ordinaryFirst("first-ordinary-goal")).newlyBound, true);
	assert.deepEqual(withoutImport, ["first-ordinary-goal"]);
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
	const restartBindCalls: string[] = [];
	const bindFirstGoal = offlineChecks.createOneUseRestartGoalBinder(async goalRunId => {
		restartBindCalls.push(goalRunId);
		return { binding: { goalRunId }, syntheticReceipt: "one-use" };
	});
	const initialBinding = await bindFirstGoal(goal.runId);
	assert.equal(initialBinding.newlyBound, true);
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
	let secondGoalId: string | undefined;
	const next = await assessAndAdvanceOriginalObjective({ contract, contractFile,
		runner: objectiveRunner, runRecord: objectiveRecord, persistReceipt: () => ws.writeRun(objectiveRecord),
		sessionSpec: { label: "synthetic-original-objective", role: "research", model: "fake/research",
			systemPrompt: "Assess original objective from frozen evidence", persistDir: ws.sessionsDir },
		evidenceRoot: path.join(f.directory, "objective-evidence"), evidence: objectiveEvidence,
		assessmentAdmission: "admitted", advanceAdmission: () => "admitted",
		supportedTaskScopes: ["registered-csr-experiment"],
		advance: async proposal => {
			nextStageScheduled = true;
			const secondGoal = await controller.begin({ goal: proposal.objective,
				problemRelation: "Fresh model-proposed next step under unchanged original objective",
				constraints: ["No automatic mission source replacement"], successCriteria: checks,
				plan: "Execute separately after provenance M04", exploratory: true });
			secondGoalId = secondGoal.runId;
			const reused = await bindFirstGoal(secondGoal.runId);
			assert.equal(reused.newlyBound, false);
			assert.equal(reused.firstBinding, initialBinding.firstBinding);
			const nextTask = await controller.delegate(secondGoal.runId, { mode: "execute",
				objective: "Execute the next model-proposed bounded task as an independent goal",
				inputs: [staged.candidatePath, staged.verificationPath, staged.provenancePath],
				expectedOutputs: ["candidate.cpp", "lesson-delta.json"],
				lessonDeltaOutput: "lesson-delta.json", checks });
			assert.equal(nextTask.status, "returned", nextTask.executionFailure ?? "second task did not execute");
		} });
	assert.equal(next.assessment?.decision, "continue");
	assert.equal(nextStageScheduled, true,
		"completed import M04 must hand back to the original-objective continuation");
	assert.ok(secondGoalId && secondGoalId !== goal.runId);
	assert.deepEqual(restartBindCalls, [goal.runId], "same-run second goal does not consume one-use reservation again");
	assert.equal(executionCalls, 2, "one provenance execution and one separately planned next-stage execution");
});

test("import M04 effect disposition only continues on known safe failure or completed stage", () => {
	assert.equal(offlineChecks.importM04EffectDisposition({ status: "failed",
		proposalSubmitted: false, snapshotCreated: false, threw: false }), "continue");
	assert.equal(offlineChecks.importM04EffectDisposition({ status: "failed",
		proposalSubmitted: false, snapshotCreated: false, transactionState: "no-proposal",
		threw: true }), "continue",
		"a durable preproposal failure cannot turn read-only M04 work into an unknown merge");
	assert.equal(offlineChecks.importM04EffectDisposition({ status: "failed",
		proposalSubmitted: true, snapshotCreated: false, threw: false }),
		"pending-merge-reconciliation");
	assert.equal(offlineChecks.importM04EffectDisposition({ status: "failed",
		proposalSubmitted: true, snapshotCreated: false, transactionState: "rejected-draft",
		threw: true }), "m04-draft-rejected",
		"a host-sealed rejected draft is known unmerged but still needs a fresh M04 judgment");
	assert.equal(offlineChecks.importM04EffectDisposition({ status: "failed",
		proposalSubmitted: true, snapshotCreated: undefined, transactionState: "merge-intent",
		threw: true }), "pending-merge-reconciliation");
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
	let m04Turns = 0;
	ctx.runner = new FakeSessionRunner(() => ++m04Turns === 1 ? malformedProposal :
		"No supported knowledge operation follows from the checked report; retain the rejected draft only as history.");
	const processed = await runM04(ctx, { feedback: { kind: "M07", runId: goal.runId },
		freshSession: true });
	assert.ok(processed.proposalId, "a proposal was actually submitted before failed validation");
	assert.equal(m04Turns, 2, "one correction turn resolves the rejected draft without a count stop");
	assert.equal(processed.record.status, "completed", "M04 returned after a safe no-proposal correction");
	assert.equal(processed.snapshotId, undefined, "the rejected draft was never merged");
	assert.equal(processed.proposalAttempts?.length, 1);
	assert.equal(processed.proposalAttempts?.[0].structurallyValid, false);
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
