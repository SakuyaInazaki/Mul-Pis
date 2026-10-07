import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createCipheriv, createDecipheriv, createHash, generateKeyPairSync, hkdfSync,
	randomBytes, sign, constants } from "node:crypto";
import { once } from "node:events";
import { chmod, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import test, { type TestContext } from "node:test";
import { deflateRawSync } from "node:zlib";
import { createOriginalObjective, objectiveProgress } from "../src/m07/objective-progress.ts";
import { MissionHostPreparationError, prepareAuthenticatedResumeRequest,
	type HostReviewedWorkflowRepairPlanV1 } from "../src/runner/mission-host-adapter.ts";
import { privateHostPreparationDiagnostic } from "../scripts/prepare-authenticated-private-resume.ts";
import { authenticateLatestTerminalCarry, authenticatedSupervisorProjection,
	CARRY_ARTIFACT_NAME, openLedgerContinuation, REUSABLE_RUN_REQUEST_MESSAGE,
	type CurrentMissionRun } from "../src/runner/ledger-continuation.ts";
import { workflowRepairState, type WorkflowRepairFailure, type WorkflowRepairStage,
	type WorkflowRepairStrategy } from "../src/runner/repair-liveness.ts";
import { isVerifiedResultOnlyRepairState, readReviewedResultOnlyRepairState,
	type ResultOnlyRepairReviewReceiptV1 } from "../src/runner/result-only-repair-review.ts";
import { decodeCarrySidecars } from "../src/runner/carry-sidecar-codec.ts";
import { MissionResumeJournal } from "../src/runner/mission-resume-journal.ts";
import { IncrementalPrivateCheckpointJournal } from "../src/runner/incremental-private-checkpoint.ts";
import { MISSION_ID, MISSION_REPOSITORY, MISSION_TOTAL_CNY, MISSION_ARTIFACT } from
	"../src/runner/signed-mission-ledger.ts";

const sha40 = (letter: string): string => letter.repeat(40);
const sourceCommit = sha40("b");
const requestCommit = sha40("f");
const testedTree = sha40("c");
const priorControlCommit = sha40("d");
const sourceRef = "refs/heads/improve/workflow-learning-reliability";
const controlRef = "refs/heads/run-requests/workflow-learning-reliability";
const source: CurrentMissionRun = { repository: MISSION_REPOSITORY, runId: "7002",
	runAttempt: "1", actor: "SakuyaInazaki", event: "workflow_dispatch",
	ref: sourceRef, sha: sourceCommit, manualAuthorized: "true" };

type LiveState = {
	sourceTip: string;
	controlTip: string | null;
	ciHead: string;
	ciConclusion: string | null;
	ciStatus: string;
	ciRunAttempt: number;
	ciCount: number;
	sourceTree: string;
	commitReplySha?: string;
};
const reviewedCodePath = "src/stages/m04.ts";
const reviewedTestPath = "test/m04-required-m07-reads.test.ts";
const reviewedTestName = "reviewed fresh handoff reads all evidence";

function run(id: number, number: number, status: string, commit: string,
	conclusion?: string): object {
	return { id, run_number: number, run_attempt: 1, workflow_id: 91, status,
		conclusion, head_branch: "improve/workflow-learning-reliability", head_sha: commit,
		event: "workflow_dispatch", actor: { login: "SakuyaInazaki" } };
}

async function fixture(t: TestContext, options: { carriedAction?: boolean;
	unknownOperation?: boolean; controlRequest?: boolean;
	largePayload?: boolean; legacyV3?: boolean;
	repairStage?: WorkflowRepairStage; repairFailure?: WorkflowRepairFailure;
	repairActionStage?: WorkflowRepairStage; repairStrategy?: WorkflowRepairStrategy;
	omitRepairStage?: boolean; omitRepairEvidence?: boolean;
	resultOnlyRepair?: boolean;
	stopReason?: "bounded-run-incomplete" | "assessment-failed" | "workflow-repair-needed" } = {}) {
	const dir = await mkdtemp(path.join(os.tmpdir(), "mission-host-adapter-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
	const publicKeyFile = path.join(dir, "public.pem");
	await writeFile(publicKeyFile, publicKey.export({ type: "spki", format: "pem" }));
	const expectedSpkiSha256 = createHash("sha256")
		.update(publicKey.export({ type: "spki", format: "der" })).digest("hex");
	const contract = createOriginalObjective({ goal: "Synthetic original task",
		goalSource: "user-intent-summary", inputNames: ["input.txt"],
		obligations: [{ id: "O1", description: "Synthetic check" }], closure: "open-ended" });
	const operationRefs = options.unknownOperation ? ["old-goal/O001"] : [];
	const checkpoint = objectiveProgress(contract, {
		boundedRuns: options.unknownOperation ? [{ runId: "old-goal", outcome: "active",
			unresolvedOperationIds: ["O001"] }] : [],
		selectedArtifacts: ["candidate.cpp", "verification.json", "workflow-archive.json"],
		unresolvedOperationIds: operationRefs,
		stopReason: options.stopReason ?? "bounded-run-incomplete",
		...(options.carriedAction ? { pendingActionFacts: { unresolvedOperationRefs: operationRefs,
			...(options.stopReason === "workflow-repair-needed" ? {
				...(options.omitRepairStage ? {} : { failedStage: options.repairActionStage ?? options.repairStage ?? "m04-judgment" }),
				...(options.omitRepairEvidence ? {} : { evidenceRefs: ["repair-state.json"] }) } : {}) } } : {}),
	});
	const repairState = options.stopReason === "workflow-repair-needed" ? workflowRepairState({
		stage: options.repairStage ?? "m04-judgment", failure: options.repairFailure ??
			(options.repairStage === "objective-assessment" ? "unread-evidence" : "unread-m07-evidence"), evidenceFingerprint: "1".repeat(64),
		planFingerprint: "2".repeat(64), responseFingerprint: "3".repeat(64),
		strategy: options.repairStrategy ?? "workflow-repair-needed", sessionGeneration: 2 }) : undefined;
	const bundle = { "original-objective.json": JSON.stringify(contract),
		"objective-checkpoint.json": JSON.stringify(checkpoint),
		"candidate.cpp": "synthetic candidate", "verification.json": "{}",
		"workflow-archive.json": "{}",
		...(repairState && !options.resultOnlyRepair ?
			{ "repair-state.json": JSON.stringify(repairState) } : {}) };
	const payload = { version: 2, kind: "mul-pis-private-mission-ledger", missionId: MISSION_ID,
		repository: MISSION_REPOSITORY, globalMaxCny: MISSION_TOTAL_CNY,
		priorCommittedCny: 4.125, revision: 1,
		previous: { runId: "7001", runAttempt: 1, artifactId: "9001", artifactName: MISSION_ARTIFACT },
		rootReviewedAnchor: { commit: sha40("a"), artifactSha256: "e".repeat(64),
			digestScope: "encrypted-result-envelope" },
		bootstrap: { contractId: contract.id, sourceSha256: "f".repeat(64),
			format: "deflate-raw-json-v1",
			filesB64: deflateRawSync(JSON.stringify(bundle)).toString("base64") } };
	const bytes = Buffer.from(JSON.stringify(payload));
	const signature = sign("sha256", bytes, { key: privateKey,
		padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 });
	const seedEnvelopeB64 = Buffer.from(JSON.stringify({ payload_b64: bytes.toString("base64"),
		signature_b64: signature.toString("base64") })).toString("base64");
	const anchor = run(7001, 1, "completed", sha40("a"), "success");
	const actualSource: CurrentMissionRun = options.controlRequest ? {
		...source, event: "push", ref: controlRef, sha: requestCommit,
		before: priorControlCommit } : source;
	const currentRun = (status: string, conclusion?: string) => options.controlRequest ?
		{ ...run(7002, 2, status, requestCommit, conclusion),
			head_branch: "run-requests/workflow-learning-reliability", event: "push",
			head_commit: { message: REUSABLE_RUN_REQUEST_MESSAGE } } :
		run(7002, 2, status, sourceCommit, conclusion);
	const running = currentRun("in_progress");
	const done = currentRun("completed", "failure");
	const live: LiveState = { sourceTip: sourceCommit, controlTip: priorControlCommit,
		ciHead: sourceCommit, ciConclusion: "success", ciStatus: "completed",
		ciRunAttempt: 1, ciCount: 1, sourceTree: testedTree };
	const codePath = options.repairStage === "objective-assessment" ?
		"src/m07/objective-progress.ts" : reviewedCodePath;
	const testPath = options.repairStage === "objective-assessment" ?
		"test/m07-objective-progress.test.ts" : reviewedTestPath;
	const symbol = options.repairStage === "objective-assessment" ? "objectiveProgress" : "runM04";
	const reviewEvidence = { codePath, testPath, symbol, testName: reviewedTestName,
		sourceText: `export async function ${symbol}() { return 'reviewed-handoff'; }\n`,
		testText: `test(${JSON.stringify(reviewedTestName)}, async () => {});\n` };
	let terminal = false;
	const request: typeof fetch = async url => {
		const address = String(url);
		let data: unknown;
		if (address.includes("/workflows/manual-private-campaign.yml/runs?"))
			data = { total_count: 2, workflow_runs: [terminal ? done : running, anchor] };
		else if (address.endsWith("/runs/7002")) data = done;
		else if (address.endsWith("/runs/7002/artifacts?per_page=100"))
			data = { total_count: options.resultOnlyRepair ? 2 : 1, artifacts: [
				{ id: 9002, name: CARRY_ARTIFACT_NAME,
					expired: false, workflow_run: { id: 7002 } },
				...(options.resultOnlyRepair ? [{ id: 9202, name: MISSION_ARTIFACT,
					expired: false, digest: `sha256:${"9".repeat(64)}`,
					workflow_run: { id: 7002, head_sha: options.controlRequest ? requestCommit : sourceCommit } }] : [])] };
		else if (address.endsWith("/runs/7002/jobs?per_page=100"))
			data = { total_count: 1, jobs: [{ id: 6002, run_id: 7002,
				run_attempt: 1, head_sha: options.controlRequest ? requestCommit : sourceCommit,
				name: "private-campaign",
				status: "completed", conclusion: "failure",
				steps: [{ name: "Run bounded private campaign", status: "completed",
					conclusion: "success" }] }] };
		else if (address.includes("/git/ref/heads/improve/workflow-learning-reliability"))
			data = { ref: sourceRef, object: { type: "commit", sha: live.sourceTip } };
		else if (address.includes("/git/ref/heads/run-requests/workflow-learning-reliability")) {
			if (live.controlTip === null) return new Response(JSON.stringify({ message: "Not Found" }),
				{ status: 404 });
			data = { ref: controlRef, object: { type: "commit", sha: live.controlTip } };
		} else if (address.includes("/contents/")) {
			const parsed = new URL(address);
			const file = parsed.pathname.split("/contents/")[1]!;
			const content = file === reviewEvidence.codePath ? parsed.searchParams.get("ref") === sourceCommit ?
				`export async function ${symbol}() { return 'prior-handoff'; }\n` : reviewEvidence.sourceText :
				file === reviewEvidence.testPath ? reviewEvidence.testText : "";
			data = { type: "file", path: file, encoding: "base64", size: Buffer.byteLength(content),
				content: Buffer.from(content).toString("base64") };
		} else if (address.includes("/git/commits/"))
			data = address.endsWith(`/git/commits/${requestCommit}`) ?
				{ sha: requestCommit, tree: { sha: testedTree },
					parents: [{ sha: sourceCommit }, { sha: priorControlCommit }] } :
				{ sha: live.commitReplySha ?? address.split("/git/commits/")[1],
					tree: { sha: address.endsWith(`/git/commits/${sourceCommit}`) ? testedTree : live.sourceTree }, parents: [] };
		else if (address.includes("/workflows/workflow-regression.yml/runs?"))
			data = { total_count: live.ciCount, workflow_runs: live.ciCount ? [{ id: 9003,
				run_attempt: live.ciRunAttempt, head_sha: live.ciHead,
				head_branch: "improve/workflow-learning-reliability", event: "push",
				status: live.ciStatus, conclusion: live.ciConclusion }] : [] };
		else throw new Error(`unexpected synthetic read: ${address}`);
		return new Response(JSON.stringify(data), { status: 200 });
	};
	const opening = await openLedgerContinuation({ seedEnvelopeB64, publicKeyFile,
		expectedSpkiSha256, githubToken: "synthetic-token", current: actualSource, request,
		loadCarryArtifact: async () => "unused" });
	let sealed = opening.sealCurrent({ settledCny: 0, unknownObservedCny: 0,
		unpricedRequestCount: 0, requestAudit: { version: 3,
			kind: "accounting-only-request-audit", requests: [], settledCny: 0,
			unknownObservedCny: 0, unpricedRequestCount: 0 },
		...(options.largePayload ? { privateBundle: { ...bundle,
			"m04-export.json": randomBytes(1_250_000).toString("base64") },
			bootstrapBinding: opening.priorBootstrapBinding } : {}) });
	if (options.legacyV3) {
		const signed = JSON.parse(Buffer.from(seedEnvelopeB64, "base64").toString("utf8")) as {
			signature_b64: string };
		const seedDigest = createHash("sha256").update(Buffer.from(seedEnvelopeB64, "base64"))
			.digest("hex");
		const key = Buffer.from(hkdfSync("sha256", Buffer.from(signed.signature_b64, "base64"),
			Buffer.from(seedDigest, "hex"), "mul-pis-ledger-continuation-v1", 32));
		const v4 = JSON.parse(Buffer.from(sealed.envelopeB64, "base64").toString("utf8")) as {
			parentDigest: string; nonce: string; ciphertext: string; tag: string };
		const carrySource = { runId: "7002", runAttempt: 1, runNumber: 2,
			commit: options.controlRequest ? requestCommit : sourceCommit };
		const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(v4.nonce, "base64"));
		decipher.setAAD(Buffer.from(JSON.stringify([MISSION_ID, MISSION_REPOSITORY, seedDigest,
			4, v4.parentDigest, carrySource])));
		decipher.setAuthTag(Buffer.from(v4.tag, "base64"));
		const manifest = JSON.parse(Buffer.concat([decipher.update(Buffer.from(v4.ciphertext, "base64")),
			decipher.final()]).toString("utf8")) as unknown;
		const plaintext = decodeCarrySidecars({ manifest, key, seedDigest,
			parentDigest: v4.parentDigest, source: carrySource,
			load: name => Buffer.from(sealed.sidecars[name]!, "base64") });
		const nonce = randomBytes(12);
		const cipher = createCipheriv("aes-256-gcm", key, nonce);
		cipher.setAAD(Buffer.from(JSON.stringify([MISSION_ID, MISSION_REPOSITORY, seedDigest,
			3, v4.parentDigest, carrySource])));
		const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
		sealed = { ...sealed, sidecars: {}, envelopeB64: Buffer.from(JSON.stringify({
			version: 3, parentDigest: v4.parentDigest, nonce: nonce.toString("base64"),
			ciphertext: ciphertext.toString("base64"),
			tag: cipher.getAuthTag().toString("base64") })).toString("base64") };
	}
	terminal = true;
	const journal = new MissionResumeJournal(path.join(dir, "journal"));
	return { dir, journal, live, checkpoint, bundle, repairState, sealed, request, reviewEvidence,
		input: { source: actualSource, seedEnvelopeB64, publicKeyFile, expectedSpkiSha256,
			githubToken: "synthetic-token", request, journal,
			loadCarryArtifact: async () => options.legacyV3 ? sealed.envelopeB64 : sealed } };
}

async function repairFixture(t: TestContext, options: { unknownOperation?: boolean;
	repairStage?: WorkflowRepairStage; repairFailure?: WorkflowRepairFailure;
		repairActionStage?: WorkflowRepairStage; repairStrategy?: WorkflowRepairStrategy;
		omitRepairStage?: boolean; omitRepairEvidence?: boolean;
		resultOnlyRepair?: boolean } = {}) {
	const f = await fixture(t, { carriedAction: true, stopReason: "workflow-repair-needed", ...options });
	f.live.sourceTip = sha40("e");
	f.live.sourceTree = sha40("1");
	f.live.ciHead = f.live.sourceTip;
	const authenticated = await authenticateLatestTerminalCarry(f.input);
	const projected = authenticatedSupervisorProjection(authenticated.proof, authenticated.privateBundle)!;
	const carry = projected.terminalCarry;
	const bytes = f.bundle["repair-state.json"] ?? JSON.stringify(f.repairState);
	const plan: HostReviewedWorkflowRepairPlanV1 = {
		version: 1, kind: "host-reviewed-workflow-repair-plan",
		prior: { source: { runId: carry.source.runId, runAttempt: carry.source.runAttempt,
			commit: carry.source.commit }, sourceTree: testedTree,
			envelopeSha256: carry.envelopeSha256, checkpointSha256: carry.checkpointSha256!,
			contractId: carry.contractId, selectedTupleSha256: carry.selectedTupleSha256,
			pendingActionSha256: carry.pendingActionSha256! },
		repair: { stateSha256: createHash("sha256").update(bytes).digest("hex"), state: JSON.parse(bytes) },
		replacement: { testedSourceCommit: f.live.sourceTip, testedTree: f.live.sourceTree,
			successfulCi: { workflow: "workflow-regression.yml", runId: "9003", runAttempt: 1,
				headCommit: f.live.sourceTip, conclusion: "success" } },
		review: { kind: "operator-code-review", strategyClass: "evidence-read-handoff",
			codeEvidenceRefs: [{ path: f.reviewEvidence.codePath,
				symbol: f.reviewEvidence.symbol }],
			offlineTests: { command: "npm run typecheck && npm test", conclusion: "passed",
				sourceCommit: f.live.sourceTip, tree: f.live.sourceTree,
				testEvidenceRefs: [{ path: f.reviewEvidence.testPath,
					name: f.reviewEvidence.testName }] } },
		boundary: "new-isolated-workspace-no-prior-session-resume" };
	const repairPlanPrivateFile = path.join(f.dir, "operator-reviewed-repair.json");
	await writeFile(repairPlanPrivateFile, JSON.stringify(plan), { mode: 0o600 });
	return { ...f, plan, input: { ...f.input, repairPlanPrivateFile } };
}

async function resultOnlyRepairFixture(t: TestContext) {
	const f = await repairFixture(t, { unknownOperation: true,
		repairStage: "objective-assessment", repairFailure: "unread-evidence",
		resultOnlyRepair: true });
	assert.equal(f.bundle["repair-state.json"], undefined);
	const envelopeBytes = Buffer.from(JSON.stringify({
		format: "mul-pis-private-campaign-v1", key_wrap: "RSA-3072-OAEP-SHA256",
		content_cipher: "AES-256-GCM", recipient_spki_sha256: "8".repeat(64),
		metadata: { repository: MISSION_REPOSITORY, run_id: "7002", run_attempt: "1",
			commit: sourceCommit, event: "workflow_dispatch" },
		wrapped_key_b64: randomBytes(384).toString("base64"),
		nonce_b64: randomBytes(12).toString("base64"),
		ciphertext_b64: randomBytes(32).toString("base64"),
	}));
	const receipt: ResultOnlyRepairReviewReceiptV1 = {
		version: 1, kind: "host-reviewed-result-only-repair-state",
		prior: { source: f.plan.prior.source, sourceTree: f.plan.prior.sourceTree,
			carryEnvelopeSha256: f.plan.prior.envelopeSha256,
			checkpointSha256: f.plan.prior.checkpointSha256,
			contractId: f.plan.prior.contractId,
			selectedTupleSha256: f.plan.prior.selectedTupleSha256,
			pendingActionSha256: f.plan.prior.pendingActionSha256 },
		result: { artifactId: "9202", archiveSha256: "9".repeat(64),
			envelopeSha256: createHash("sha256").update(envelopeBytes).digest("hex"),
			envelopeFile: "private-campaign-outcome.enc.json" },
		repair: { file: "repair-state.json", bytesUtf8: JSON.stringify(f.repairState),
			sha256: createHash("sha256").update(JSON.stringify(f.repairState)).digest("hex") },
		review: { kind: "operator-rsa-decryption-review",
			conclusion: "control-only-repair-state-reviewed",
			researchResultUse: "untrusted-no-scientific-adoption" }
	};
	const resultOnlyRepairReviewPrivateFile = path.join(f.dir, "result-only-review.json");
	await writeFile(resultOnlyRepairReviewPrivateFile, JSON.stringify(receipt), { mode: 0o600 });
	return { ...f, receipt, envelopeBytes, resultOnlyRepairReviewPrivateFile,
		input: { ...f.input, resultOnlyRepairReviewPrivateFile,
			loadResultEnvelope: async () => envelopeBytes } };
}

async function interruptedFixture(t: TestContext) {
	const f = await fixture(t, { carriedAction: true, unknownOperation: true });
	const interruptedCommit = sha40("e");
	const reviewFile = path.join(f.dir, "interrupted-source-review.json");
	const priorDigest = createHash("sha256").update(Buffer.from(f.sealed.envelopeB64, "base64"))
		.digest("hex");
	const reviewFiles = new Map([
		["src/runner/confined-campaign-files.ts", "createConfinedCampaignFileTools"],
		["scripts/manual-private-campaign.ts",
			"read-only-assessor mkdtemp createFileKnowledgeStore sandboxArguments checkCandidate"],
		[".github/workflows/manual-private-campaign.yml", "Upload encrypted mission continuation"],
		["test/confined-campaign-evidence-read.test.ts", "confined local tools"],
		["test/manual-private-campaign.test.ts",
			"read only session fresh state measurement mounts evaluator and immutable reference workers read-only while preserving separate temporary scratch"],
		["test/private-campaign-workflow-manifest.test.ts", "ciphertext upload"]]);
	await writeFile(reviewFile, JSON.stringify({ version: 1,
		kind: "host-reviewed-interrupted-source-capability",
		prior: { source: { runId: "7003", runAttempt: 1, commit: interruptedCommit },
			sourceTree: testedTree,
			priorCarrySource: { runId: "7002", runAttempt: 1, commit: sourceCommit },
			priorCarryEnvelopeSha256: priorDigest,
			priorCheckpointSha256: createHash("sha256")
				.update(f.bundle["objective-checkpoint.json"]).digest("hex"),
			resultArtifactId: "9103", resultArchiveSha256: "9".repeat(64) },
		review: { kind: "operator-code-review", conclusion: "approved-for-fresh-only-execution",
			codeEvidenceRefs: [
				{ role: "m07-local-tool-confinement", path: "src/runner/confined-campaign-files.ts",
					symbol: "createConfinedCampaignFileTools" },
				{ role: "read-only-model-sessions", path: "scripts/manual-private-campaign.ts",
					symbol: "read-only-assessor" },
				{ role: "fresh-workspace-store", path: "scripts/manual-private-campaign.ts",
					symbol: "createFileKnowledgeStore" },
				{ role: "host-execution-confinement", path: "scripts/manual-private-campaign.ts",
					symbol: "sandboxArguments" },
				{ role: "host-execution-confinement", path: "scripts/manual-private-campaign.ts",
					symbol: "checkCandidate" },
				{ role: "encrypted-output-provider", path: ".github/workflows/manual-private-campaign.yml",
					symbol: "Upload encrypted mission continuation" }],
			testEvidenceRefs: [
				{ role: "m07-local-tool-confinement", path: "test/confined-campaign-evidence-read.test.ts",
					name: "confined local tools" },
				{ role: "read-only-model-sessions", path: "test/manual-private-campaign.test.ts",
					name: "read only session" },
				{ role: "fresh-workspace-store", path: "test/manual-private-campaign.test.ts",
					name: "fresh state" },
				{ role: "host-execution-confinement", path: "test/manual-private-campaign.test.ts",
					name: "measurement mounts evaluator and immutable reference workers read-only while preserving separate temporary scratch" },
				{ role: "encrypted-output-provider", path: "test/private-campaign-workflow-manifest.test.ts",
					name: "ciphertext upload" }] },
		grant: { mode: "fresh-only-confined-effects", oldResultUse: "untrusted-no-replay-no-adoption",
			m07Tools: "factory-confined-local", modelSessions: "read-only",
			state: "fresh-workspace-empty-store-no-resume", outputTransport: "encrypted-fixed",
			providerInference: "fixed-configured-provider" } }), { mode: 0o600 });
	const interruptedRun = { ...run(7003, 3, "completed", interruptedCommit, "cancelled") };
	const preceding = run(7002, 2, "completed", sourceCommit, "failure");
	const anchor = run(7001, 1, "completed", sha40("a"), "success");
	const request: typeof fetch = async (url, init) => {
		const address = String(url);
		if (address.includes("/contents/")) {
			const file = new URL(address).pathname.split("/contents/")[1]!;
			const body = reviewFiles.get(file);
			if (body !== undefined) return new Response(JSON.stringify({ type: "file", path: file,
				encoding: "base64", size: Buffer.byteLength(body),
				content: Buffer.from(body).toString("base64") }));
		}
		if (address.includes("/workflows/manual-private-campaign.yml/runs?"))
			return new Response(JSON.stringify({ total_count: 3,
				workflow_runs: [interruptedRun, preceding, anchor] }));
		if (address.endsWith("/runs/7003"))
			return new Response(JSON.stringify(interruptedRun));
		if (address.includes("/runs/7003/jobs?"))
			return new Response(JSON.stringify({ total_count: 1, jobs: [{ id: 6003,
				run_id: 7003, run_attempt: 1, head_sha: interruptedCommit,
				name: "private-campaign", status: "completed", conclusion: "cancelled",
				steps: [{ name: "Run private campaign", status: "completed",
					conclusion: "cancelled" }] }] }));
		if (address.includes("/runs/7003/artifacts?"))
			return new Response(JSON.stringify({ total_count: 1, artifacts: [{
				id: 9103, name: MISSION_ARTIFACT, expired: false,
				digest: `sha256:${"9".repeat(64)}`,
				workflow_run: { id: 7003, head_sha: interruptedCommit } }] }));
		return f.request(url, init);
	};
	return { ...f, request, reviewFile, input: { ...f.input, source: { ...source, runId: "7003",
		sha: interruptedCommit }, request,
		interruptedSourceReviewPrivateFile: reviewFile,
		loadCarryArtifact: async ({ runId, artifactId }: { runId: string; artifactId: string }) => {
			assert.equal(runId, "7002"); assert.equal(artifactId, "9002");
			return f.sealed;
		} } };
}

test("cancelled no-carry host bridge plans one fresh isolated request from authenticated prior state", async t => {
	const f = await interruptedFixture(t);
	const inspected = await prepareAuthenticatedResumeRequest({ ...f.input, readOnly: true });
	assert.equal(inspected.decision.kind, "dispatch");
	if (inspected.decision.kind !== "dispatch") return;
	assert.equal(inspected.decision.intent.source.runId, "7003");
	assert.equal(inspected.decision.intent.terminalInterruption?.resultArchiveSha256, "9".repeat(64));
	assert.equal(inspected.decision.intent.actionKind, "reconcile-interrupted-run");
	assert.equal(inspected.decision.intent.pendingAction.reasonCode, "execution-interrupted");
	assert.equal(inspected.decision.intent.actionProvenance?.kind, "current-host-interruption");
	assert.deepEqual(inspected.decision.intent.quarantinedOperationRefs, ["old-goal/O001"]);
	assert.equal(inspected.descriptor?.message, REUSABLE_RUN_REQUEST_MESSAGE);
	assert.equal(inspected.journalKey, undefined);
	const prepared = await prepareAuthenticatedResumeRequest(f.input);
	assert.equal(prepared.decision.kind, "dispatch");
	assert.equal(prepared.journalState, "reserved");
	assert.equal((await f.journal.get(prepared.journalKey!))?.intentBinding.terminalInterruption?.source.runId,
		"7003");
	const repeated = await prepareAuthenticatedResumeRequest(f.input);
	assert.deepEqual(repeated.decision, { kind: "wait", reason: "dispatch-reserved",
		idempotencyKey: prepared.journalKey });
	assert.equal(repeated.descriptor, undefined);
});

test("failed carry and interruption authentication retain both safe private causes", async t => {
	const f = await interruptedFixture(t);
	const request: typeof fetch = async (url, init) => {
		if (String(url).includes("/runs/7003/artifacts?"))
			return new Response(JSON.stringify({ total_count: 0, artifacts: [] }));
		return f.input.request(url, init);
	};
	await assert.rejects(prepareAuthenticatedResumeRequest({ ...f.input, request }), error => {
		const diagnostic = privateHostPreparationDiagnostic(error);
		assert.equal(diagnostic.code, "terminal-authentication-failed");
		assert.equal((diagnostic.attempts as unknown[]).length, 2);
		assert(!JSON.stringify(diagnostic).includes("Synthetic original task"));
		return true;
	});
});

test("an interrupted run requires a private review of its own immutable source before dispatch", async t => {
	const f = await interruptedFixture(t);
	const { interruptedSourceReviewPrivateFile: _review, ...unreviewed } = f.input;
	const waiting = await prepareAuthenticatedResumeRequest(unreviewed);
	assert.deepEqual(waiting.decision,
		{ kind: "wait", reason: "interruption-source-review-required" });
	assert.equal(waiting.descriptor, undefined);
	assert.equal(await f.journal.unresolvedForRef(controlRef), undefined);
	const raw = JSON.parse(await readFile(f.reviewFile, "utf8"));
	raw.prior.source.commit = sha40("1");
	await writeFile(f.reviewFile, JSON.stringify(raw), { mode: 0o600 });
	await assert.rejects(prepareAuthenticatedResumeRequest(f.input), error => {
		assert.equal(privateHostPreparationDiagnostic(error).code,
			"interruption-source-review-invalid");
		return true;
	});
	assert.equal(await f.journal.unresolvedForRef(controlRef), undefined);
});

test("reviewed workflow repair releases one tested descriptor and durable reservation", async t => {
	const f = await repairFixture(t);
	const first = await prepareAuthenticatedResumeRequest(f.input);
	assert.equal(first.decision.kind, "dispatch");
	assert.equal(first.descriptor?.message, REUSABLE_RUN_REQUEST_MESSAGE);
	assert.equal(first.descriptor?.sourceCommit, f.plan.replacement.testedSourceCommit);
	assert.equal(first.descriptor?.tree, f.plan.replacement.testedTree);
	assert.deepEqual(first.descriptor?.parents, [f.live.sourceTip, priorControlCommit]);
	assert(!JSON.stringify(first.descriptor).includes("repair"));
	assert(!JSON.stringify(first.descriptor).includes("Synthetic original task"));
	assert.equal((await f.journal.get(first.journalKey!))?.intentBinding.workflowRepair?.testedSourceCommit,
		f.plan.replacement.testedSourceCommit);
	const second = await prepareAuthenticatedResumeRequest({ ...f.input,
		journal: new MissionResumeJournal(f.journal.directory) });
	assert.deepEqual(second.decision, { kind: "wait", reason: "dispatch-reserved", idempotencyKey: first.journalKey });
	assert.equal(second.descriptor, undefined);
	assert.equal(second.journalKey, first.journalKey);
	await f.journal.markAttempted(first.journalKey!);
	const third = await prepareAuthenticatedResumeRequest(f.input);
	assert.deepEqual(third.decision, { kind: "wait", reason: "dispatch-delivery-unknown", idempotencyKey: first.journalKey });
});

test("workflow repair missing a private plan remains open without reservation", async t => {
	const f = await repairFixture(t);
	const { repairPlanPrivateFile: _file, ...input } = f.input;
	f.live.ciStatus = "in_progress";
	f.live.ciConclusion = null;
	assert.deepEqual(await prepareAuthenticatedResumeRequest(input),
		{ decision: { kind: "wait", reason: "workflow-repair-plan-required" } });
	await assert.rejects(stat(f.journal.directory), { code: "ENOENT" });
});

test("workflow repair refuses stale carry, action, receipt, source tree and CI identities", async t => {
	const changes: Array<(plan: HostReviewedWorkflowRepairPlanV1) => HostReviewedWorkflowRepairPlanV1> = [
		plan => ({ ...plan, prior: { ...plan.prior, source: { ...plan.prior.source, runAttempt: 2 } } }),
		plan => ({ ...plan, prior: { ...plan.prior, envelopeSha256: "4".repeat(64) } }),
		plan => ({ ...plan, prior: { ...plan.prior, checkpointSha256: "4".repeat(64) } }),
		plan => ({ ...plan, prior: { ...plan.prior, pendingActionSha256: "4".repeat(64) } }),
		plan => ({ ...plan, prior: { ...plan.prior, selectedTupleSha256: "4".repeat(64) } }),
		plan => ({ ...plan, repair: { ...plan.repair, stateSha256: "4".repeat(64) } }),
		plan => ({ ...plan, repair: { ...plan.repair, state: { ...plan.repair.state, planFingerprint: "4".repeat(64) } } }),
		plan => ({ ...plan, repair: { ...plan.repair, state: { ...plan.repair.state, stage: "objective-assessment" } } }),
		plan => ({ ...plan, prior: { ...plan.prior, sourceTree: sha40("2") } }),
		plan => ({ ...plan, replacement: { ...plan.replacement, testedTree: sha40("2") },
			review: { ...plan.review, offlineTests: { ...plan.review.offlineTests, tree: sha40("2") } } }),
		plan => ({ ...plan, replacement: { ...plan.replacement,
			successfulCi: { ...plan.replacement.successfulCi, runId: "9004" } } }),
	];
	for (const change of changes) {
		const f = await repairFixture(t);
		await writeFile(f.input.repairPlanPrivateFile, JSON.stringify(change(f.plan)));
		await assert.rejects(prepareAuthenticatedResumeRequest(f.input), error =>
			error instanceof MissionHostPreparationError && error.refusal.code === "workflow-repair-plan-stale");
		await assert.rejects(stat(f.journal.directory), { code: "ENOENT" });
	}
});

test("workflow repair refuses the same source or tree and unrelated review evidence", async t => {
	for (const bad of ["same-source", "same-tree", "same-code", "missing-symbol", "missing-test",
		"unrelated-code", "unrelated-test", "strategy-failure"] as const) {
		const f = await repairFixture(t);
		let plan = f.plan;
		if (bad === "same-source" || bad === "same-tree") {
			if (bad === "same-source") f.live.sourceTip = sourceCommit;
			f.live.sourceTree = testedTree;
			f.live.ciHead = f.live.sourceTip;
			plan = { ...plan, replacement: { testedSourceCommit: f.live.sourceTip, testedTree: testedTree,
				successfulCi: { ...plan.replacement.successfulCi, headCommit: f.live.sourceTip } },
				review: { ...plan.review, offlineTests: { ...plan.review.offlineTests,
					sourceCommit: f.live.sourceTip, tree: testedTree } } };
		} else if (bad === "same-code") f.reviewEvidence.sourceText = "export async function runM04() { return 'prior-handoff'; }\n";
		else if (bad === "missing-symbol") f.reviewEvidence.sourceText = "export async function unrelated() {}\n";
		else if (bad === "missing-test") f.reviewEvidence.testText = "test('unrelated', () => {});\n";
		else if (bad === "unrelated-code") plan = { ...plan, review: { ...plan.review,
			codeEvidenceRefs: [{ path: "src/runner/mission-host-adapter.ts", symbol: "prepareAuthenticatedResumeRequest" }] } };
		else if (bad === "unrelated-test") plan = { ...plan, review: { ...plan.review,
			offlineTests: { ...plan.review.offlineTests,
				testEvidenceRefs: [{ path: "test/mission-supervisor.test.ts", name: reviewedTestName }] } } };
		else plan = { ...plan, repair: { ...plan.repair,
			state: { ...plan.repair.state, failure: "invalid-assessment" } } };
		await writeFile(f.input.repairPlanPrivateFile, JSON.stringify(plan));
		await assert.rejects(prepareAuthenticatedResumeRequest(f.input), bad);
		await assert.rejects(stat(f.journal.directory), { code: "ENOENT" });
	}
});

test("workflow repair retains unknown effects and cannot reuse a changed review reservation", async t => {
	const unknown = await repairFixture(t, { unknownOperation: true });
	const preserving = await prepareAuthenticatedResumeRequest(unknown.input);
	assert.equal(preserving.decision.kind, "dispatch");
	if (preserving.decision.kind === "dispatch") {
		assert.equal(preserving.decision.intent.pendingAction.kind, "reconcile-m07-operation");
		assert.deepEqual(preserving.decision.intent.pendingAction.target?.operationRefs,
			["old-goal/O001"]);
	}
	const f = await repairFixture(t);
	const first = await prepareAuthenticatedResumeRequest(f.input);
	const changed = { ...f.plan, review: { ...f.plan.review, strategyClass: "fresh-context-handoff" } };
	await writeFile(f.input.repairPlanPrivateFile, JSON.stringify(changed));
	await assert.rejects(prepareAuthenticatedResumeRequest(f.input), error =>
		error instanceof MissionHostPreparationError && error.refusal.code === "control-request-delivery-uncertain");
	assert.equal((await f.journal.get(first.journalKey!))?.state, "reserved");
});

test("reviewed result-only repair state permits the carried reconcile action without changing AEAD science", async t => {
	const f = await resultOnlyRepairFixture(t);
	const authenticated = await authenticateLatestTerminalCarry(f.input);
	const branded = await readReviewedResultOnlyRepairState({
		privateReceiptFile: f.resultOnlyRepairReviewPrivateFile,
		terminalProof: authenticated.proof, privateBundle: authenticated.privateBundle,
		terminalSourceTree: testedTree, terminalEvent: "workflow_dispatch",
		encryptedEnvelopeBytes: f.envelopeBytes });
	assert.equal(isVerifiedResultOnlyRepairState(branded), true);
	assert.equal(isVerifiedResultOnlyRepairState({ ...branded }), false);
	assert.equal(authenticated.privateBundle["repair-state.json"], undefined);
	const prepared = await prepareAuthenticatedResumeRequest(f.input);
	assert.equal(prepared.decision.kind, "dispatch");
	assert.equal(prepared.descriptor?.sourceCommit, f.plan.replacement.testedSourceCommit);
	if (prepared.decision.kind === "dispatch") {
		assert.equal(prepared.decision.intent.pendingAction.kind, "reconcile-m07-operation");
		assert.deepEqual(prepared.decision.intent.pendingAction.target?.operationRefs,
			["old-goal/O001"]);
	}
	assert.equal((await f.journal.get(prepared.journalKey!))?.state, "reserved");
	assert(!JSON.stringify(prepared.descriptor).includes("repair-state"));
});

test("result-only review without a receipt waits, and altered artifact, repair and carry are refused", async t => {
	const f = await resultOnlyRepairFixture(t);
	const { resultOnlyRepairReviewPrivateFile: _review, ...withoutReview } = f.input;
	const waiting = await prepareAuthenticatedResumeRequest(withoutReview);
	assert.deepEqual(waiting.decision,
		{ kind: "wait", reason: "workflow-repair-plan-required" });
	assert.equal(waiting.descriptor, undefined);
	assert.equal(await f.journal.unresolvedForRef(controlRef), undefined);
	const changes: Array<(receipt: ResultOnlyRepairReviewReceiptV1) => ResultOnlyRepairReviewReceiptV1> = [
		receipt => ({ ...receipt, prior: { ...receipt.prior,
			sourceTree: sha40("0") } }),
		receipt => ({ ...receipt, prior: { ...receipt.prior,
			carryEnvelopeSha256: "0".repeat(64) } }),
		receipt => ({ ...receipt, prior: { ...receipt.prior,
			checkpointSha256: "0".repeat(64) } }),
		receipt => ({ ...receipt, prior: { ...receipt.prior,
			pendingActionSha256: "0".repeat(64) } }),
		receipt => ({ ...receipt, result: { ...receipt.result,
			artifactId: "9203" } }),
		receipt => ({ ...receipt, result: { ...receipt.result,
			archiveSha256: "0".repeat(64) } }),
		receipt => ({ ...receipt, result: { ...receipt.result,
			envelopeSha256: "0".repeat(64) } }),
		receipt => ({ ...receipt, repair: { ...receipt.repair,
			sha256: "0".repeat(64) } }),
		receipt => ({ ...receipt, repair: { ...receipt.repair,
			bytesUtf8: JSON.stringify({ ...f.repairState, stage: "m04-judgment" }) } }),
	];
	for (const change of changes) {
		await writeFile(f.resultOnlyRepairReviewPrivateFile, JSON.stringify(change(f.receipt)));
		await assert.rejects(prepareAuthenticatedResumeRequest(f.input), error =>
			error instanceof MissionHostPreparationError &&
			error.refusal.code === "result-only-repair-review-invalid");
		assert.equal(await f.journal.unresolvedForRef(controlRef), undefined);
	}
});

test("result-only repair requires one live, unexpired result artifact", async t => {
	for (const fault of ["missing", "expired", "duplicate"] as const) {
		const f = await resultOnlyRepairFixture(t);
		const request: typeof fetch = async (url, init) => {
			if (!String(url).endsWith("/runs/7002/artifacts?per_page=100"))
				return f.request(url, init);
			const carry = { id: 9002, name: CARRY_ARTIFACT_NAME,
				expired: false, workflow_run: { id: 7002 } };
			const result = { id: 9202, name: MISSION_ARTIFACT,
				expired: fault === "expired", digest: `sha256:${"9".repeat(64)}`,
				workflow_run: { id: 7002, head_sha: sourceCommit } };
			const artifacts = [carry, ...(fault === "missing" ? [] : [result]),
				...(fault === "duplicate" ? [{ ...result, id: 9203 }] : [])];
			return new Response(JSON.stringify({ total_count: artifacts.length, artifacts }));
		};
		await assert.rejects(prepareAuthenticatedResumeRequest({ ...f.input, request }), error =>
			error instanceof MissionHostPreparationError &&
			error.refusal.code === "result-only-repair-result-unavailable");
		assert.equal(await f.journal.unresolvedForRef(controlRef), undefined);
	}
});

test("a changed reviewed repair with its own updated hash cannot bypass the separately reviewed plan", async t => {
	const f = await resultOnlyRepairFixture(t);
	const changedBytes = JSON.stringify({ ...f.repairState,
		planFingerprint: "7".repeat(64) });
	await writeFile(f.resultOnlyRepairReviewPrivateFile, JSON.stringify({ ...f.receipt,
		repair: { ...f.receipt.repair, bytesUtf8: changedBytes,
			sha256: createHash("sha256").update(changedBytes).digest("hex") } }));
	await assert.rejects(prepareAuthenticatedResumeRequest(f.input), error =>
		error instanceof MissionHostPreparationError &&
		error.refusal.code === "workflow-repair-plan-stale");
	assert.equal(await f.journal.unresolvedForRef(controlRef), undefined);
});

test("result-only review rejects nonprivate, linked and repository-local receipts", async t => {
	for (const fault of ["mode", "symlink", "inside-repo"] as const) {
		const f = await resultOnlyRepairFixture(t);
		let receiptFile = f.resultOnlyRepairReviewPrivateFile;
		if (fault === "mode") await chmod(receiptFile, 0o644);
		else if (fault === "symlink") {
			const link = path.join(f.dir, "result-only-link.json");
			await symlink(receiptFile, link);
			receiptFile = link;
		} else receiptFile = path.resolve("src/runner/result-only-repair-review.ts");
		await assert.rejects(prepareAuthenticatedResumeRequest({ ...f.input,
			resultOnlyRepairReviewPrivateFile: receiptFile }), error =>
			error instanceof MissionHostPreparationError &&
			error.refusal.code === "result-only-repair-review-invalid");
		assert.equal(await f.journal.unresolvedForRef(controlRef), undefined);
	}
});

test("workflow repair rejects nonprivate, symlinked and expanded plan files", async t => {
	for (const fault of ["mode", "symlink", "inside-repo", "missing-field", "unknown-field", "model-review"] as const) {
		const f = await repairFixture(t);
		if (fault === "mode") await chmod(f.input.repairPlanPrivateFile, 0o644);
		else if (fault === "symlink") {
			const link = path.join(f.dir, "repair-link.json");
			await symlink(f.input.repairPlanPrivateFile, link);
			f.input.repairPlanPrivateFile = link;
		} else if (fault === "inside-repo") f.input.repairPlanPrivateFile = path.resolve("src/runner/mission-host-adapter.ts");
		else if (fault === "missing-field") {
			const { prior: _prior, ...partial } = f.plan;
			await writeFile(f.input.repairPlanPrivateFile, JSON.stringify(partial));
		} else await writeFile(f.input.repairPlanPrivateFile, JSON.stringify(fault === "unknown-field" ?
			{ ...f.plan, scientificTask: "not allowed" } :
			{ ...f.plan, review: { ...f.plan.review, kind: "model-reviewed" } }));
		await assert.rejects(prepareAuthenticatedResumeRequest(f.input), error =>
			error instanceof MissionHostPreparationError && error.refusal.code === "workflow-repair-plan-invalid");
		await assert.rejects(stat(f.journal.directory), { code: "ENOENT" });
	}
});

test("inherited repair telemetry cannot override a different current action stage or strategy", async t => {
	for (const option of [{ repairActionStage: "objective-assessment" as const },
		{ repairStrategy: "fresh-context" as const }]) {
		const f = await repairFixture(t, option);
		const plan = { ...f.plan, repair: { ...f.plan.repair,
			state: { ...f.plan.repair.state, strategy: "workflow-repair-needed" } } };
		await writeFile(f.input.repairPlanPrivateFile, JSON.stringify(plan));
		await assert.rejects(prepareAuthenticatedResumeRequest(f.input), error =>
			error instanceof MissionHostPreparationError && error.refusal.code === "workflow-repair-plan-stale");
		await assert.rejects(stat(f.journal.directory), { code: "ENOENT" });
	}
});

test("workflow repair receipt requires the authenticated action stage and evidence reference", async t => {
	for (const option of [{ omitRepairStage: true }, { omitRepairEvidence: true }]) {
		const f = await repairFixture(t, option);
		await assert.rejects(prepareAuthenticatedResumeRequest(f.input), error =>
			error instanceof MissionHostPreparationError && error.refusal.code === "workflow-repair-plan-stale");
		await assert.rejects(stat(f.journal.directory), { code: "ENOENT" });
	}
});

test("workflow repair review must fit the authenticated stage and failure", async t => {
	for (const failure of ["invalid-assessment", "malformed-proposal"] as const) {
		const f = await repairFixture(t, { repairFailure: failure });
		await assert.rejects(prepareAuthenticatedResumeRequest(f.input), error =>
			error instanceof MissionHostPreparationError && error.refusal.code === "workflow-repair-review-evidence-invalid");
		await assert.rejects(stat(f.journal.directory), { code: "ENOENT" });
	}
	const f = await repairFixture(t, { repairStage: "objective-assessment" });
	const plan = { ...f.plan, review: { ...f.plan.review,
		codeEvidenceRefs: [{ path: "src/m07/objective-progress.ts", symbol: "objectiveProgress" }],
		offlineTests: { ...f.plan.review.offlineTests,
			testEvidenceRefs: [{ path: "test/m07-objective-progress.test.ts", name: reviewedTestName }] } } };
	await writeFile(f.input.repairPlanPrivateFile, JSON.stringify(plan));
	const request: typeof fetch = async url => {
		const address = String(url);
		if (!address.includes("/contents/")) return f.request(url);
		const parsed = new URL(address);
		const file = parsed.pathname.split("/contents/")[1]!;
		const text = file.startsWith("src/") ?
			`export function objectiveProgress() { return '${parsed.searchParams.get("ref") === sourceCommit ? "prior" : "repaired"}'; }\n` :
			`test(${JSON.stringify(reviewedTestName)}, () => {});\n`;
		return new Response(JSON.stringify({ type: "file", path: file, encoding: "base64",
			size: Buffer.byteLength(text), content: Buffer.from(text).toString("base64") }));
	};
	assert.equal((await prepareAuthenticatedResumeRequest({ ...f.input, request })).decision.kind, "dispatch");
});

test("a physically bounded private repair review may cite more than sixteen relevant facts", async t => {
	const f = await repairFixture(t);
	const symbols = Array.from({ length: 17 }, (_, index) => `repairEvidence${index + 1}`);
	const testNames = Array.from({ length: 17 }, (_, index) => `repair evidence ${index + 1}`);
	f.reviewEvidence.sourceText += symbols.map(symbol => `export const ${symbol} = true;`).join("\n");
	f.reviewEvidence.testText += testNames.map(name =>
		`test(${JSON.stringify(name)}, () => {});`).join("\n");
	const plan: HostReviewedWorkflowRepairPlanV1 = { ...f.plan, review: { ...f.plan.review,
		codeEvidenceRefs: [
			...f.plan.review.codeEvidenceRefs,
			...symbols.map(symbol => ({ path: reviewedCodePath, symbol }))],
		offlineTests: { ...f.plan.review.offlineTests,
			testEvidenceRefs: [
				...f.plan.review.offlineTests.testEvidenceRefs,
				...testNames.map(name => ({ path: reviewedTestPath, name }))] } } };
	await writeFile(f.input.repairPlanPrivateFile, JSON.stringify(plan));
	const prepared = await prepareAuthenticatedResumeRequest({ ...f.input, readOnly: true });
	assert.equal(prepared.decision.kind, "dispatch");
	assert.equal(prepared.descriptor?.message, REUSABLE_RUN_REQUEST_MESSAGE);
});

test("live authenticated carried action reserves a constant-message empty-tree request", async t => {
	const f = await fixture(t, { carriedAction: true });
	const result = await prepareAuthenticatedResumeRequest(f.input);
	assert.equal(result.decision.kind, "dispatch");
	assert.equal(result.descriptor?.ref, controlRef);
	assert.equal(result.descriptor?.message, REUSABLE_RUN_REQUEST_MESSAGE);
	assert.equal(result.descriptor?.tree, testedTree);
	assert.deepEqual(Object.keys(result.descriptor!).sort(),
		["expectedBefore", "message", "parents", "previousControlCommit", "ref", "sourceCommit", "tree"]);
	assert.deepEqual(result.descriptor?.parents, [sourceCommit, priorControlCommit]);
	assert.equal(result.descriptor?.expectedBefore, priorControlCommit);
	assert.equal(result.journalKey, result.decision.kind === "dispatch" ?
		result.decision.intent.idempotencyKey : undefined);
	assert(!JSON.stringify(result.descriptor).includes("Synthetic original task"));
	assert(!JSON.stringify(result.descriptor).includes("pendingAction"));
	const stored = await new MissionResumeJournal(f.journal.directory).get(result.journalKey!);
	assert.equal(stored?.state, "reserved");
});

test("a legacy unknown operation gets a current host decision bound to the exact old checkpoint", async t => {
	const f = await fixture(t, { unknownOperation: true });
	const oldBytes = f.bundle["objective-checkpoint.json"];
	const result = await prepareAuthenticatedResumeRequest(f.input);
	assert.equal(result.decision.kind, "dispatch");
	if (result.decision.kind !== "dispatch") return;
	assert.deepEqual(result.decision.intent.quarantinedOperationRefs, ["old-goal/O001"]);
	assert.equal(result.decision.intent.actionKind, "reconcile-m07-operation");
	assert.equal(result.decision.intent.actionProvenance?.kind, "current-host-derived");
	assert.equal(result.decision.intent.actionProvenance?.kind === "current-host-derived" ?
		result.decision.intent.actionProvenance.checkpointSha256 : undefined,
		createHash("sha256").update(oldBytes).digest("hex"));
	assert.equal(f.bundle["objective-checkpoint.json"], oldBytes);
	const provenance = (await f.journal.get(result.journalKey!))?.intentBinding.actionProvenance;
	assert.equal(provenance?.kind === "current-host-derived" ? provenance.checkpointSha256 : undefined,
		result.decision.intent.actionProvenance?.kind === "current-host-derived" ?
			result.decision.intent.actionProvenance.checkpointSha256 : undefined);
});

test("authenticated read-only planning never creates a journal reservation", async t => {
	const f = await fixture(t, { unknownOperation: true, controlRequest: true });
	const result = await prepareAuthenticatedResumeRequest({ ...f.input, readOnly: true });
	assert.equal(result.decision.kind, "dispatch");
	assert.equal(result.descriptor?.message, REUSABLE_RUN_REQUEST_MESSAGE);
	assert.equal(result.journalKey, undefined);
	await assert.rejects(stat(f.journal.directory), { code: "ENOENT" });
});

test("a completed reusable control request authenticates before preparing its next descriptor", async t => {
	const f = await fixture(t, { unknownOperation: true, controlRequest: true });
	const result = await prepareAuthenticatedResumeRequest(f.input);
	assert.equal(result.decision.kind, "dispatch");
	if (result.decision.kind !== "dispatch") return;
	assert.equal(result.decision.intent.source.commit, requestCommit);
	assert.equal(result.descriptor?.sourceCommit, sourceCommit);
	assert.deepEqual(result.descriptor?.parents, [sourceCommit, priorControlCommit]);
	assert.deepEqual(result.decision.intent.quarantinedOperationRefs, ["old-goal/O001"]);
});

test("missing host reason leaves the carry without a dispatch reservation", async t => {
	const f = await fixture(t, { stopReason: "assessment-failed" });
	const result = await prepareAuthenticatedResumeRequest(f.input);
	assert.equal(result.decision.kind, "restore-evidence");
	assert.equal(result.descriptor, undefined);
	assert.equal(result.journalKey, undefined);
	assert.equal(await f.journal.unresolvedForRef(controlRef), undefined);
});

test("stale source and unsuccessful CI reads fail closed before a reservation", async t => {
	for (const alter of [
		(state: LiveState) => { state.sourceTip = sha40("e"); },
		(state: LiveState) => { state.ciHead = sha40("e"); },
		(state: LiveState) => { state.ciConclusion = "failure"; },
		(state: LiveState) => { state.ciStatus = "in_progress"; },
	]) {
		const f = await fixture(t, { carriedAction: true });
		alter(f.live);
		await assert.rejects(prepareAuthenticatedResumeRequest(f.input));
		assert.equal(await f.journal.unresolvedForRef(controlRef), undefined);
	}
});

test("host preparation retains fixed CI-pending, failed, and absent causes privately", async t => {
	for (const [alter, expected] of [
		[(state: LiveState) => { state.ciStatus = "in_progress"; state.ciConclusion = null; },
			"source-ci-pending"],
		[(state: LiveState) => { state.ciConclusion = "failure"; },
			"source-ci-completed-without-success"],
		[(state: LiveState) => { state.ciCount = 0; }, "source-ci-run-absent"],
	] as const) {
		const f = await fixture(t, { carriedAction: true });
		alter(f.live);
		await assert.rejects(prepareAuthenticatedResumeRequest(f.input), error => {
			assert(error instanceof MissionHostPreparationError);
			assert.equal(error.refusal.code, expected);
			const privateDiagnostic = privateHostPreparationDiagnostic(error);
			assert.equal(privateDiagnostic.code, expected);
			assert.equal(privateDiagnostic.stage, "tested-source-ci");
			if (expected === "source-ci-pending") {
				assert.equal(privateDiagnostic.ciStatus, "in_progress");
				assert.equal(privateDiagnostic.ciRunId, "9003");
				assert.equal(privateDiagnostic.ciConclusion, null);
			}
			if (expected === "source-ci-completed-without-success")
				assert.equal(privateDiagnostic.ciConclusion, "failure");
			assert.doesNotMatch(JSON.stringify(privateDiagnostic), /Synthetic original task|synthetic candidate/);
			return true;
		});
		assert.equal(await f.journal.unresolvedForRef(controlRef), undefined);
	}
});

test("an unbranded claim cannot replace live carry authentication", async t => {
	const f = await fixture(t, { carriedAction: true });
	const outer = JSON.parse(Buffer.from(f.sealed.envelopeB64, "base64").toString("utf8"));
	outer.tag = `${outer.tag[0] === "A" ? "B" : "A"}${outer.tag.slice(1)}`;
	const broken = Buffer.from(JSON.stringify(outer)).toString("base64");
	const forged = { ...f.input,
		proof: { kind: "authenticated-terminal-mission-carry" },
		privateBundle: f.bundle, loadCarryArtifact: async () => broken };
	await assert.rejects(prepareAuthenticatedResumeRequest(forged));
	assert.equal(await f.journal.unresolvedForRef(controlRef), undefined);
});

test("the live control ref and CI must still match a prior reservation", async t => {
	for (const alter of [
		(state: LiveState) => { state.controlTip = sha40("e"); },
		(state: LiveState) => { state.sourceTip = sha40("e"); state.ciHead = sha40("e"); },
	]) {
		const f = await fixture(t, { carriedAction: true });
		const first = await prepareAuthenticatedResumeRequest(f.input);
		assert.equal(first.journalState, "reserved");
		alter(f.live);
		await assert.rejects(prepareAuthenticatedResumeRequest(f.input));
		assert.equal((await f.journal.get(first.journalKey!))?.state, "reserved");
	}
});

test("a repeated request returns the durable reservation and never replaces an attempted update", async t => {
	const f = await fixture(t, { carriedAction: true });
	const first = await prepareAuthenticatedResumeRequest(f.input);
	assert.equal(first.decision.kind, "dispatch");
	const second = await prepareAuthenticatedResumeRequest(f.input);
	assert.equal(second.journalKey, first.journalKey);
	assert.deepEqual(second.decision, { kind: "wait", reason: "dispatch-reserved",
		idempotencyKey: first.journalKey });
	assert.equal(second.descriptor, undefined);
	assert.equal((await f.journal.get(first.journalKey!))?.state, "reserved");
	await f.journal.markAttempted(first.journalKey!);
	const third = await prepareAuthenticatedResumeRequest(f.input);
	assert.equal(third.descriptor, undefined);
	assert.deepEqual(third.decision, { kind: "wait", reason: "dispatch-delivery-unknown",
		idempotencyKey: first.journalKey });
	assert.equal((await f.journal.get(first.journalKey!))?.state, "ref-update-attempted");
	const stored = await readFile(path.join(f.journal.directory, `${first.journalKey}.json`), "utf8");
	assert(!stored.includes("Synthetic original task"));
});

test("reserved descriptor recovery requires the same authenticated journal state", async t => {
	const f = await fixture(t, { carriedAction: true });
	await assert.rejects(prepareAuthenticatedResumeRequest({ ...f.input,
		readOnly: true, recoverReservedDescriptor: true }), error =>
		privateHostPreparationDiagnostic(error).code === "reserved-descriptor-recovery-requires-journal");
	await assert.rejects(prepareAuthenticatedResumeRequest({ ...f.input,
		recoverReservedDescriptor: true }), error =>
		privateHostPreparationDiagnostic(error).code === "reserved-descriptor-missing");
	assert.equal(await f.journal.unresolvedForRef(controlRef), undefined);
	const first = await prepareAuthenticatedResumeRequest(f.input);
	const recovered = await prepareAuthenticatedResumeRequest({ ...f.input,
		recoverReservedDescriptor: true });
	assert.deepEqual(recovered.descriptor, first.descriptor);
	assert.deepEqual(recovered.decision, { kind: "wait", reason: "dispatch-reserved",
		idempotencyKey: first.journalKey });
	assert.equal((await f.journal.get(first.journalKey!))?.state, "reserved");
	await f.journal.markAttempted(first.journalKey!);
	const uncertain = await prepareAuthenticatedResumeRequest({ ...f.input,
		recoverReservedDescriptor: true });
	assert.equal(uncertain.descriptor, undefined);
	assert.equal(uncertain.decision.kind, "wait");
	assert.equal((await f.journal.get(first.journalKey!))?.state, "ref-update-attempted");
});

async function runStdioBridge(f: Awaited<ReturnType<typeof fixture>> |
	Awaited<ReturnType<typeof interruptedFixture>>,
	options: { wrongArtifactDigest?: boolean; readOnly?: boolean;
		outputPrivate?: string; recoverReserved?: boolean;
		repairPlanPrivateFile?: string;
		resultOnlyRepairReviewPrivateFile?: string;
		resultEnvelopeBytes?: Buffer; wrongResultArchiveEcho?: boolean;
		wrongResultFileDigest?: boolean;
		interruptedSourceReviewPrivateFile?: string;
		prefixOnly?: { runId: string; artifactId: string; raw: string; archiveSha256: string };
		prefixText?: string; archiveSha256?: string; wrongArchiveEcho?: boolean;
		sidecarFault?: "missing" | "duplicate" | "tamper" } = {}) {
	const sourceFile = path.join(f.dir, "source.json");
	const seedFile = path.join(f.dir, "seed.txt");
	const artifactFile = path.join(f.dir, "carry.json");
	const outputPrivate = options.outputPrivate ?? path.join(f.dir, "prepared-private.json");
	await writeFile(sourceFile, JSON.stringify(f.input.source), { mode: 0o600 });
	await writeFile(seedFile, f.input.seedEnvelopeB64!, { mode: 0o600 });
	const artifactBytes = JSON.stringify({ envelopeB64: f.sealed.envelopeB64 });
	await writeFile(artifactFile, artifactBytes, { mode: 0o600 });
	const artifactSha256 = createHash("sha256").update(artifactBytes).digest("hex");
	const resultEnvelopeFile = options.resultEnvelopeBytes ? path.join(f.dir,
		"private-campaign-outcome.enc.json") : undefined;
	if (resultEnvelopeFile) await writeFile(resultEnvelopeFile, options.resultEnvelopeBytes!, { mode: 0o600 });
	const prefixOnlyFile = options.prefixOnly ? path.join(f.dir, "prefix-only.json") : undefined;
	if (prefixOnlyFile) await writeFile(prefixOnlyFile, options.prefixOnly!.raw, { mode: 0o600 });
	let prefixReference: { name: string; file: string; sha256: string } | undefined;
	if (options.prefixText !== undefined) {
		const file = path.join(f.dir, "incremental-control-prefix.json");
		await writeFile(file, options.prefixText, { mode: 0o600 });
		prefixReference = { name: "incremental-control-prefix.json", file,
			sha256: createHash("sha256").update(options.prefixText).digest("hex") };
	}
	const sidecarReferences = await Promise.all(Object.entries(f.sealed.sidecars).map(async ([name, value]) => {
		const file = path.join(f.dir, name);
		await writeFile(file, value, { mode: 0o600 });
		return { name, file, sha256: createHash("sha256").update(value).digest("hex") };
	}));
	if (options.sidecarFault === "tamper" && sidecarReferences.length) {
		const first = sidecarReferences[0]!;
		const ciphertext = Buffer.from(f.sealed.sidecars[first.name]!, "base64");
		ciphertext[20] ^= 1;
		const tampered = ciphertext.toString("base64");
		await writeFile(first.file, tampered);
		first.sha256 = createHash("sha256").update(tampered).digest("hex");
	}
	const script = path.resolve("scripts/prepare-authenticated-private-resume.ts");
	const wrapper = `import { runPrivateResumeBridge } from ${JSON.stringify(pathToFileURL(script).href)};\n` +
		`runPrivateResumeBridge(process.argv.slice(1), { expectedSpkiSha256: ` +
		`${JSON.stringify(f.input.expectedSpkiSha256)} }).catch(() => { ` +
		`process.stderr.write("private resume preparation failed\\n"); process.exitCode = 1; });`;
	const child = spawn(process.execPath, ["--input-type=module", "-e", wrapper, "--",
		"--source", sourceFile, "--seed", seedFile,
		"--public-key", f.input.publicKeyFile, "--journal-dir", f.journal.directory,
		"--output-private", outputPrivate, "--connector-stdio",
		...(options.recoverReserved ? ["--recover-reserved"] : []),
		...(options.repairPlanPrivateFile ? ["--repair-plan-private", options.repairPlanPrivateFile] : []),
		...(options.resultOnlyRepairReviewPrivateFile ?
			["--result-only-repair-review-private", options.resultOnlyRepairReviewPrivateFile] : []),
		...(options.interruptedSourceReviewPrivateFile ?
			["--interrupted-source-review-private", options.interruptedSourceReviewPrivateFile] : []),
		...(options.readOnly ? ["--read-only"] : [])],
		{ cwd: path.dirname(path.dirname(script)), stdio: ["pipe", "pipe", "pipe"] });
	let stderr = "";
	child.stderr.setEncoding("utf8");
	child.stderr.on("data", chunk => { stderr += String(chunk); });
	const closed = once(child, "close");
	const lines: unknown[] = [];
	for await (const line of createInterface({ input: child.stdout, crlfDelay: Infinity })) {
		const row = JSON.parse(line) as { kind: string; id?: number; url?: string;
			runId?: string; artifactId?: string; expectedArchiveSha256?: string };
		lines.push(row);
		if (row.kind === "github-get") {
			assert.equal(typeof row.url, "string");
			assert(row.url!.startsWith(`https://api.github.com/repos/${MISSION_REPOSITORY}/`));
			const response = await f.request(row.url!);
			child.stdin.write(`${JSON.stringify({ id: row.id, status: response.status,
				body: JSON.parse(await response.text()) })}\n`);
		} else if (row.kind === "artifact-file") {
			if (row.artifactId === "9202") {
				assert.equal(row.runId, "7002");
				assert.equal(row.expectedArchiveSha256, "9".repeat(64));
				assert(resultEnvelopeFile && options.resultEnvelopeBytes);
				child.stdin.write(`${JSON.stringify({ id: row.id,
					name: "private-campaign-outcome.enc.json", file: resultEnvelopeFile,
					sha256: options.wrongResultFileDigest ? "0".repeat(64) :
						createHash("sha256").update(options.resultEnvelopeBytes).digest("hex"),
					archiveSha256: options.wrongResultArchiveEcho ? "0".repeat(64) :
						"9".repeat(64) })}\n`);
				continue;
			}
			if (options.prefixOnly && row.runId === options.prefixOnly.runId) {
				assert.equal(row.artifactId, options.prefixOnly.artifactId);
				assert.equal(row.expectedArchiveSha256, options.prefixOnly.archiveSha256);
				child.stdin.write(`${JSON.stringify({ id: row.id, name: "incremental-control-prefix.json",
					file: prefixOnlyFile,
					sha256: createHash("sha256").update(options.prefixOnly.raw).digest("hex"),
					archiveSha256: options.prefixOnly.archiveSha256 })}\n`);
				continue;
			}
			assert(row.runId === f.input.source.runId || options.prefixOnly && row.runId === "7002");
			assert.equal(row.artifactId, row.runId === "7003" ? "9003" : "9002");
			assert.equal(row.expectedArchiveSha256, options.archiveSha256);
			const sidecars = options.sidecarFault === "missing" ? sidecarReferences.slice(0, -1) :
				options.sidecarFault === "duplicate" ? [...sidecarReferences, sidecarReferences[0]!] :
				sidecarReferences;
			child.stdin.write(`${JSON.stringify({ id: row.id, file: artifactFile,
				sha256: options.wrongArtifactDigest ? "0".repeat(64) : artifactSha256,
				...(options.archiveSha256 ? { archiveSha256: options.wrongArchiveEcho ?
					"0".repeat(64) : options.archiveSha256 } : {}),
				...(prefixReference ? { prefix: prefixReference } : {}),
				...(sidecarReferences.length ? { sidecars } : {}) })}\n`);
		} else assert(["prepared", "planned-read-only", "recovered-reservation", "no-dispatch"].includes(row.kind));
	}
	const [code] = await closed;
	return { code, stderr, lines, stdout: lines.map(row => JSON.stringify(row)).join("\n"),
		outputPrivate };
}

async function twoCarryFixture(t: TestContext) {
	const first = await fixture(t, { carriedAction: true });
	const source3: CurrentMissionRun = { ...source, runId: "7003", sha: sha40("c") };
	const anchor = run(7001, 1, "completed", sha40("a"), "success");
	const done2 = run(7002, 2, "completed", sourceCommit, "failure");
	let terminal3 = false;
	const request3: typeof fetch = async url => {
		const address = String(url);
		if (address.includes("/workflows/manual-private-campaign.yml/runs?"))
			return new Response(JSON.stringify({ total_count: 3, workflow_runs: [
				run(7003, 3, terminal3 ? "completed" : "in_progress", sha40("c"),
					terminal3 ? "failure" : undefined), done2, anchor] }));
		if (address.endsWith("/runs/7003"))
			return new Response(JSON.stringify(run(7003, 3, "completed", sha40("c"), "failure")));
		if (address.endsWith("/runs/7003/artifacts?per_page=100"))
			return new Response(JSON.stringify({ total_count: 1, artifacts: [
				{ id: 9003, name: CARRY_ARTIFACT_NAME, expired: false,
					workflow_run: { id: 7003 } }] }));
		if (address.endsWith("/runs/7003/jobs?per_page=100"))
			return new Response(JSON.stringify({ total_count: 1, jobs: [{ id: 6003,
				run_id: 7003, run_attempt: 1, head_sha: sha40("c"), name: "private-campaign",
				status: "completed", conclusion: "failure",
				steps: [{ name: "Run bounded private campaign", status: "completed",
					conclusion: "success" }] }] }));
		return first.request(url);
	};
	const opening = await openLedgerContinuation({ seedEnvelopeB64: first.input.seedEnvelopeB64,
		publicKeyFile: first.input.publicKeyFile,
		expectedSpkiSha256: first.input.expectedSpkiSha256,
		githubToken: first.input.githubToken, current: source3, request: request3,
		loadCarryArtifact: async () => first.sealed });
	const sealed3 = opening.sealCurrent({ settledCny: 0, unknownObservedCny: 0,
		unpricedRequestCount: 0, requestAudit: { version: 3,
			kind: "accounting-only-request-audit", requests: [], settledCny: 0,
			unknownObservedCny: 0, unpricedRequestCount: 0 } });
	terminal3 = true;
	return { ...first, request: request3, sealed: sealed3,
		input: { ...first.input, source: source3, request: request3,
			loadCarryArtifact: async () => sealed3 } };
}

test("stdio bridge authenticates connector reads and prints only a public descriptor", async t => {
	const f = await fixture(t, { carriedAction: true });
	const bridge = await runStdioBridge(f);
	assert.equal(bridge.code, 0, bridge.stderr);
	const final = bridge.lines.at(-1) as { kind: string; descriptor: object };
	assert.equal(final.kind, "prepared");
	assert.deepEqual(Object.keys(final).sort(), ["descriptor", "kind"]);
	assert.deepEqual(Object.keys(final.descriptor).sort(),
		["expectedBefore", "message", "parents", "previousControlCommit", "ref", "sourceCommit", "tree"]);
	assert.equal((final.descriptor as { message: string }).message, REUSABLE_RUN_REQUEST_MESSAGE);
	assert(!bridge.stdout.includes(f.input.seedEnvelopeB64!));
	assert(!bridge.stdout.includes("synthetic-token"));
	assert(!bridge.stdout.includes("Synthetic original task"));
	assert(!bridge.stdout.includes("synthetic candidate"));
	assert(!bridge.stdout.includes("pendingAction"));
	const privateResult = JSON.parse(await readFile(bridge.outputPrivate, "utf8")) as {
		decision: { kind: string }; journalKey: string; descriptor: object };
	assert.equal(privateResult.decision.kind, "dispatch");
	assert.deepEqual(privateResult.descriptor, final.descriptor);
	assert.equal((await stat(bridge.outputPrivate)).mode & 0o077, 0);
	assert.equal((await new MissionResumeJournal(f.journal.directory)
		.get(privateResult.journalKey))?.state, "reserved");
});

test("private output collision is diagnosed before any connector read or journal reservation", async t => {
	const f = await fixture(t, { carriedAction: true });
	const outputPrivate = path.join(f.dir, "prepared-private.json");
	const firstFailure = '{"kind":"earlier-private-failure"}\n';
	await writeFile(outputPrivate, firstFailure, { mode: 0o600 });
	for (const expectedCount of [1, 2]) {
		const result = await runStdioBridge(f);
		assert.equal(result.code, 1);
		assert.deepEqual(result.lines, []);
		assert.equal(await readFile(outputPrivate, "utf8"), firstFailure);
		assert.equal(await f.journal.unresolvedForRef(controlRef), undefined);
		const names = (await readdir(f.dir)).filter(name =>
			/^\.prepared-private\.json\.attempt-[0-9a-f-]+\.failure\.json$/.test(name));
		assert.equal(names.length, expectedCount);
		for (const name of names) {
			const diagnostic = JSON.parse(await readFile(path.join(f.dir, name), "utf8"));
			assert.deepEqual(diagnostic, { version: 1,
				kind: "private-resume-preparation-diagnostic",
				code: "private-output-exists", osErrorCode: "EEXIST" });
			assert.equal((await stat(path.join(f.dir, name))).mode & 0o077, 0);
		}
	}
});

test("stdio bridge recovers a reserved descriptor only before any ref update attempt", async t => {
	const f = await fixture(t, { carriedAction: true });
	const prepared = await runStdioBridge(f);
	assert.equal(prepared.code, 0, prepared.stderr);
	const first = JSON.parse(await readFile(prepared.outputPrivate, "utf8")) as {
		journalKey: string; descriptor: object };
	const recovered = await runStdioBridge(f, { recoverReserved: true,
		outputPrivate: path.join(f.dir, "recovered-private.json") });
	assert.equal(recovered.code, 0, recovered.stderr);
	assert.deepEqual(recovered.lines.at(-1), { kind: "recovered-reservation",
		descriptor: first.descriptor });
	assert.equal((await f.journal.get(first.journalKey))?.state, "reserved");
	await f.journal.markAttempted(first.journalKey);
	const afterAttempt = await runStdioBridge(f, { recoverReserved: true,
		outputPrivate: path.join(f.dir, "after-attempt-private.json") });
	assert.equal(afterAttempt.code, 0, afterAttempt.stderr);
	assert.deepEqual(afterAttempt.lines.at(-1), { kind: "no-dispatch", decisionKind: "wait" });
});

test("stdio bridge accepts a combined final carry and prefix only with the expected ZIP digest", async t => {
	const f = await fixture(t, { carriedAction: true });
	const archiveSha256 = "8".repeat(64);
	const request = f.request;
	f.request = async (url, init) => {
		if (String(url).endsWith("/runs/7002/artifacts?per_page=100"))
			return new Response(JSON.stringify({ total_count: 1, artifacts: [{ id: 9002,
				name: CARRY_ARTIFACT_NAME, expired: false,
				digest: `sha256:${archiveSha256}`, workflow_run: { id: 7002, head_sha: sourceCommit } }] }));
		return request(url, init);
	};
	const result = await runStdioBridge(f, { prefixText: '{"status":"incomplete"}',
		archiveSha256, readOnly: true });
	assert.equal(result.code, 0, result.stderr);
	assert.equal((result.lines.at(-1) as { kind: string }).kind, "planned-read-only");
	const invalid = await runStdioBridge(f, { prefixText: '{"status":"incomplete"}',
		archiveSha256, wrongArchiveEcho: true, readOnly: true });
	assert.equal(invalid.code, 1);
});

test("stdio bridge authenticates a prefix-only interrupted artifact without adopting its research", async t => {
	const f = await interruptedFixture(t);
	const signed = JSON.parse(Buffer.from(f.input.seedEnvelopeB64!, "base64").toString("utf8")) as {
		signature_b64: string };
	const seedDigest = createHash("sha256")
		.update(Buffer.from(f.input.seedEnvelopeB64!, "base64")).digest("hex");
	const key = Buffer.from(hkdfSync("sha256", Buffer.from(signed.signature_b64, "base64"),
		Buffer.from(seedDigest, "hex"), "mul-pis-ledger-continuation-v1", 32));
	const priorEnvelopeSha256 = createHash("sha256")
		.update(Buffer.from(f.sealed.envelopeB64, "base64")).digest("hex");
	const source = { repository: MISSION_REPOSITORY, runId: "7003", runAttempt: 1,
		commit: sha40("e"), event: "workflow_dispatch" as const, priorEnvelopeSha256 };
	const incremental = new IncrementalPrivateCheckpointJournal({ source,
		outputDir: f.dir, authenticatedMissionKey: key });
	await incremental.record("initial", { requestAudit: { version: 3,
		kind: "accounting-only-request-audit", requests: [], settledCny: 0,
		unknownObservedCny: 0, unpricedRequestCount: 0 },
		hostEffects: { version: 1, kind: "host-effect-prefix-observation", complete: false,
			selectionAuthority: false, source: { runId: source.runId,
				runAttempt: source.runAttempt, commit: source.commit },
			priorEnvelopeSha256, historicalGoalRunIds: [], goals: [], sessions: [], requestIds: [] } });
	const raw = await readFile(path.join(f.dir, "incremental-control-prefix.json"), "utf8");
	const archiveSha256 = "8".repeat(64);
	const originalRequest = f.request;
	f.request = async (url, init) => {
		if (String(url).endsWith("/runs/7003/artifacts?per_page=100"))
			return new Response(JSON.stringify({ total_count: 2, artifacts: [{ id: 9103,
				name: MISSION_ARTIFACT, expired: false, digest: `sha256:${"9".repeat(64)}`,
				workflow_run: { id: 7003, head_sha: sha40("e") } }, { id: 9603,
				name: CARRY_ARTIFACT_NAME, expired: false, digest: `sha256:${archiveSha256}`,
				workflow_run: { id: 7003, head_sha: sha40("e") } }] }));
		return originalRequest(url, init);
	};
	const direct = await prepareAuthenticatedResumeRequest({ ...f.input, request: f.request,
		readOnly: true, loadCarryArtifact: async ({ runId }) => runId === "7003" ?
			{ incrementalControlPrefix: raw } : f.sealed });
	assert.equal(direct.decision.kind, "dispatch");
	const result = await runStdioBridge(f, { readOnly: true,
		interruptedSourceReviewPrivateFile: f.reviewFile,
		prefixOnly: { runId: "7003", artifactId: "9603", raw, archiveSha256 } });
	assert.equal(result.code, 0, `${result.stderr}\n${JSON.stringify(result.lines)}`);
	assert.equal((result.lines.at(-1) as { kind: string }).kind, "planned-read-only");
	assert(!result.stdout.includes("incrementalControlEnvelope"));
	assert(!result.stdout.includes("Synthetic original task"));
	const discarded = await runStdioBridge(f, {
		interruptedSourceReviewPrivateFile: f.reviewFile,
		prefixOnly: { runId: "7003", artifactId: "9603",
			raw: '{"status":"complete"}', archiveSha256 } });
	assert.equal(discarded.code, 0, discarded.stderr);
	assert.equal((discarded.lines.at(-1) as { kind: string }).kind, "prepared");
	const privateResult = JSON.parse(await readFile(discarded.outputPrivate, "utf8")) as {
		decision: { kind: string }; incrementalPrefixFailure: {
			stage: string; reason: string; category: string } };
	assert.equal(privateResult.decision.kind, "dispatch");
	assert.equal(privateResult.incrementalPrefixFailure.category,
		"decode-or-authentication-failed");
	assert.equal(privateResult.incrementalPrefixFailure.stage, "envelope");
	assert.equal(privateResult.incrementalPrefixFailure.reason, "invalid-format");
	assert(!discarded.stdout.includes("invalid-format"));
});

test("stdio bridge accepts a private reviewed repair without publishing its receipt", async t => {
	const f = await repairFixture(t);
	const bridge = await runStdioBridge(f, { repairPlanPrivateFile: f.input.repairPlanPrivateFile });
	assert.equal(bridge.code, 0, bridge.stderr);
	assert.equal((bridge.lines.at(-1) as { kind: string }).kind, "prepared");
	assert(!bridge.stdout.includes("operator-code-review"));
	assert(!bridge.stdout.includes("reviewedPlanSha256"));
	assert(!bridge.stdout.includes("repair-state.json"));
	assert(!bridge.stdout.includes(reviewedTestName));
	const repeated = await prepareAuthenticatedResumeRequest(f.input);
	assert.equal(repeated.decision.kind, "wait");
	assert.equal(repeated.descriptor, undefined);
});

test("stdio bridge binds a reviewed result-only repair to its separate encrypted result artifact", async t => {
	const f = await resultOnlyRepairFixture(t);
	const bridge = await runStdioBridge(f, {
		repairPlanPrivateFile: f.input.repairPlanPrivateFile,
		resultOnlyRepairReviewPrivateFile: f.resultOnlyRepairReviewPrivateFile,
		resultEnvelopeBytes: f.envelopeBytes });
	assert.equal(bridge.code, 0, bridge.stderr);
	assert.equal((bridge.lines.at(-1) as { kind: string }).kind, "prepared");
	assert(bridge.lines.some(row => (row as { artifactId?: string }).artifactId === "9202"));
	assert(!bridge.stdout.includes("bytesUtf8"));
	assert(!bridge.stdout.includes("operator-rsa-decryption-review"));
	assert(!bridge.stdout.includes("old-goal/O001"));
	const privateResult = JSON.parse(await readFile(bridge.outputPrivate, "utf8")) as {
		decision: { kind: string; intent: { pendingAction: { kind: string } } } };
	assert.equal(privateResult.decision.kind, "dispatch");
	assert.equal(privateResult.decision.intent.pendingAction.kind, "reconcile-m07-operation");
});

test("stdio bridge rejects a result artifact ZIP or encrypted envelope mismatch", async t => {
	for (const failure of ["archive", "file", "receipt-as-envelope"] as const) {
		const f = await resultOnlyRepairFixture(t);
		const bridge = await runStdioBridge(f, {
			repairPlanPrivateFile: f.input.repairPlanPrivateFile,
			resultOnlyRepairReviewPrivateFile: f.resultOnlyRepairReviewPrivateFile,
			resultEnvelopeBytes: failure === "receipt-as-envelope" ?
				Buffer.from(JSON.stringify(f.receipt)) : f.envelopeBytes,
			wrongResultArchiveEcho: failure === "archive",
			wrongResultFileDigest: failure === "file" });
		assert.equal(bridge.code, 1);
		assert(!bridge.lines.some(row => (row as { kind: string }).kind === "prepared"));
		const privateFailure = JSON.parse(await readFile(bridge.outputPrivate, "utf8"));
		assert.equal(privateFailure.kind, "private-resume-preparation-diagnostic");
		assert.equal(privateFailure.descriptor, undefined);
		assert.equal(await f.journal.unresolvedForRef(controlRef), undefined);
	}
});

test("stdio bridge refuses an artifact whose private digest changed", async t => {
	const f = await fixture(t, { carriedAction: true });
	const bridge = await runStdioBridge(f, { wrongArtifactDigest: true });
	assert.equal(bridge.code, 1);
	assert(bridge.lines.some(row => (row as { kind: string }).kind === "artifact-file"));
	assert(!bridge.lines.some(row => (row as { kind: string }).kind === "prepared"));
	const privateFailure = JSON.parse(await readFile(bridge.outputPrivate, "utf8"));
	assert.equal(privateFailure.kind, "private-resume-preparation-diagnostic");
	assert.equal(privateFailure.descriptor, undefined);
	assert.equal(await f.journal.unresolvedForRef(controlRef), undefined);
});

test("stdio bridge authenticates multiple near-limit ciphertext sidecars without exposing bytes", async t => {
	const f = await fixture(t, { carriedAction: true, largePayload: true });
	assert(Object.keys(f.sealed.sidecars).length >= 2);
	assert(Buffer.from(f.sealed.sidecars["ledger-continuation.part-00000000.enc"]!, "base64")
		.length > 700_000);
	const bridge = await runStdioBridge(f);
	assert.equal(bridge.code, 0, bridge.stderr);
	assert.equal((bridge.lines.at(-1) as { kind: string }).kind, "prepared");
	assert(!bridge.stdout.includes(f.sealed.envelopeB64));
	assert(!bridge.stdout.includes(f.sealed.sidecars["ledger-continuation.part-00000000.enc"]!));
	assert(!bridge.stderr.includes(f.sealed.sidecars["ledger-continuation.part-00000000.enc"]!));
});

test("stdio bridge rejects missing, duplicate and tampered ciphertext sidecars", async t => {
	for (const sidecarFault of ["missing", "duplicate", "tamper"] as const) {
		const f = await fixture(t, { carriedAction: true, largePayload: true });
		const bridge = await runStdioBridge(f, { sidecarFault });
		assert.equal(bridge.code, 1, sidecarFault);
		assert(!bridge.lines.some(row => (row as { kind: string }).kind === "prepared"));
		assert(!bridge.stderr.includes(f.sealed.sidecars["ledger-continuation.part-00000000.enc"]!));
		const privateFailure = JSON.parse(await readFile(bridge.outputPrivate, "utf8"));
		assert.equal(privateFailure.kind, "private-resume-preparation-diagnostic");
		assert.equal(privateFailure.descriptor, undefined);
		assert.equal(await f.journal.unresolvedForRef(controlRef), undefined);
	}
});

test("stdio bridge keeps the single-file v3 continuation route", async t => {
	const f = await fixture(t, { carriedAction: true, legacyV3: true });
	assert.equal(Object.keys(f.sealed.sidecars).length, 0);
	const bridge = await runStdioBridge(f);
	assert.equal(bridge.code, 0, bridge.stderr);
	assert.equal((bridge.lines.at(-1) as { kind: string }).kind, "prepared");
});

test("stdio bridge read-only smoke emits a public plan without local writes", async t => {
	const f = await fixture(t, { unknownOperation: true, controlRequest: true });
	const bridge = await runStdioBridge(f, { readOnly: true });
	assert.equal(bridge.code, 0, bridge.stderr);
	assert.equal((bridge.lines.at(-1) as { kind: string }).kind, "planned-read-only");
	await assert.rejects(stat(bridge.outputPrivate), { code: "ENOENT" });
	await assert.rejects(stat(f.journal.directory), { code: "ENOENT" });
});

test("stdio bridge authenticates the latest carry with two executed runs of ancestry", async t => {
	const f = await twoCarryFixture(t);
	const bridge = await runStdioBridge(f);
	assert.equal(bridge.code, 0, bridge.stderr);
	assert.deepEqual(bridge.lines.filter(row => (row as { kind: string }).kind === "artifact-file")
		.map(row => ({ runId: (row as { runId: string }).runId,
			artifactId: (row as { artifactId: string }).artifactId })),
		[{ runId: "7003", artifactId: "9003" }]);
	assert.equal((bridge.lines.at(-1) as { kind: string }).kind, "prepared");
	assert(!bridge.stdout.includes("Synthetic original task"));
	assert.equal((await stat(bridge.outputPrivate)).mode & 0o077, 0);
});
