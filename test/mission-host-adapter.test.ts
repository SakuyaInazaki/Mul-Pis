import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createCipheriv, createDecipheriv, createHash, generateKeyPairSync, hkdfSync,
	randomBytes, sign, constants } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import test, { type TestContext } from "node:test";
import { deflateRawSync } from "node:zlib";
import { createOriginalObjective, objectiveProgress } from "../src/m07/objective-progress.ts";
import { prepareAuthenticatedResumeRequest } from "../src/runner/mission-host-adapter.ts";
import  {
	CARRY_ARTIFACT_NAME,
	CARRY_FILE_NAME,
	openLedgerContinuation,
	REUSABLE_RUN_REQUEST_MESSAGE,
	type CurrentMissionRun
}  from "../src/runner/ledger-continuation.ts";
import { workflowRepairState, type WorkflowRepairFailure, type WorkflowRepairStage,
	type WorkflowRepairStrategy } from "../src/runner/repair-liveness.ts";
import { decodeCarrySidecars } from "../src/runner/carry-sidecar-codec.ts";
import { MissionResumeJournal } from "../src/runner/mission-resume-journal.ts";
import { ARTIFACT_PARTITION_MANIFEST_FILE, finalizePartitionManifest,
	partitionEncryptedFiles, sealPartitionManifest } from
	"../src/runner/private-artifact-partition.ts";
import { MISSION_ID, MISSION_REPOSITORY, MISSION_TOTAL_CNY, MISSION_ARTIFACT } from
	"../src/runner/signed-mission-ledger.ts";
import { campaignSessionEffectId } from "../src/runner/deepseek-campaign.ts";

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
const canonicalForJournal = (value: unknown): string => {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(canonicalForJournal).join(",")}]`;
	return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
		.map(([key, part]) => `${JSON.stringify(key)}:${canonicalForJournal(part)}`).join(",")}}`;
};

type LiveState = {
	sourceTip: string;
	controlTip: string | null;
	ciHead: string;
	ciConclusion: string | null;
	ciStatus: string;
	ciRunAttempt: number;
	ciCount: number;
	ciRunId: number;
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
	oldControlSource?: string;
	largePayload?: boolean; multipartResearchBytes?: number; legacyV3?: boolean;
	repairStage?: WorkflowRepairStage; repairFailure?: WorkflowRepairFailure;
	repairActionStage?: WorkflowRepairStage; repairStrategy?: WorkflowRepairStrategy;
	omitRepairStage?: boolean; omitRepairEvidence?: boolean;
	resultOnlyRepair?: boolean;
	provider402?: boolean; fiveUnknownOperations?: boolean;
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
	const operationRefs = options.fiveUnknownOperations ?
		Array.from({ length: 5 }, (_, index) => `old-goal/O${String(index + 1).padStart(3, "0")}`) :
		options.unknownOperation ? ["old-goal/O001"] : [];
	const checkpoint = objectiveProgress(contract, {
		boundedRuns: operationRefs.length ? [{ runId: "old-goal", outcome: "active",
			unresolvedOperationIds: operationRefs.map(ref => ref.split("/")[1]!) }] : [],
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
		ciRunAttempt: 1, ciCount: 1, ciRunId: 9003, sourceTree: testedTree };
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
			data = address.includes(`head_sha=${priorControlCommit}`) ?
				{ total_count: 0, workflow_runs: [] } :
				{ total_count: 2, workflow_runs: [terminal ? done : running, anchor] };
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
		} else if (address.endsWith(`/git/commits/${priorControlCommit}`))
			data = { sha: priorControlCommit, tree: { sha: testedTree },
				message: REUSABLE_RUN_REQUEST_MESSAGE,
				parents: [{ sha: options.oldControlSource ?? sourceCommit }] };
		else if (address.includes("/git/commits/"))
			data = address.endsWith(`/git/commits/${requestCommit}`) ?
				{ sha: requestCommit, tree: { sha: testedTree },
					parents: [{ sha: sourceCommit }, { sha: priorControlCommit }] } :
				{ sha: live.commitReplySha ?? address.split("/git/commits/")[1],
					tree: { sha: address.endsWith(`/git/commits/${sourceCommit}`) ? testedTree : live.sourceTree }, parents: [] };
		else if (address.includes("/workflows/workflow-regression.yml/runs?"))
			data = address.includes(`head_sha=${priorControlCommit}`) ?
				{ total_count: 0, workflow_runs: [] } :
				options.oldControlSource && address.includes(`head_sha=${options.oldControlSource}`) ?
				{ total_count: 1, workflow_runs: [{ id: 9010, run_attempt: 1,
					head_sha: options.oldControlSource,
					head_branch: "improve/workflow-learning-reliability", event: "push",
					status: "completed", conclusion: "success" }] } :
				{ total_count: live.ciCount, workflow_runs: live.ciCount ? [{ id: live.ciRunId,
				run_attempt: live.ciRunAttempt, head_sha: live.ciHead,
				head_branch: "improve/workflow-learning-reliability", event: "push",
				status: live.ciStatus, conclusion: live.ciConclusion }] : [] };
		else throw new Error(`unexpected synthetic read: ${address}`);
		return new Response(JSON.stringify(data), { status: 200 });
	};
	const opening = await openLedgerContinuation({ seedEnvelopeB64, publicKeyFile,
		expectedSpkiSha256, githubToken: "synthetic-token", current: actualSource, request,
		loadCarryArtifact: async () => "unused" });
	const requestAudit = options.provider402 ? { version: 3 as const,
		kind: "accounting-only-request-audit" as const,
		requests: [{ requestId: "payment-rejected", sessionId: campaignSessionEffectId("payment-session"),
			inputPayloadBytes: 100, responseReceived: false, status: "unknown" as const,
			settledCny: null, unknownObservedCny: null, reportedUsage: null }],
		settledCny: 0, unknownObservedCny: 0, unpricedRequestCount: 1 } :
		{ version: 3 as const, kind: "accounting-only-request-audit" as const,
			requests: [], settledCny: 0, unknownObservedCny: 0, unpricedRequestCount: 0 };
	const diagnostic = options.provider402 ? opening.appendTransportDiagnosticCensus(requestAudit,
		[{ version: 1, promptIndex: 1, requestId: "payment-rejected", phase: "response-body",
			httpStatus: 402, responseStarted: true, bytesRead: 162, abortSource: null,
			providerErrorCode: "invalid_request_error", providerErrorType: null,
			providerErrorReasonClass: "insufficient-balance", providerRequestId: null,
			errorCodes: [] }]) : undefined;
	let sealed = opening.sealCurrent({ settledCny: 0, unknownObservedCny: 0,
		unpricedRequestCount: options.provider402 ? 1 : 0, requestAudit,
		...(options.provider402 || options.largePayload || options.multipartResearchBytes ?
			{ privateBundle: { ...bundle,
			...(diagnostic ? { "transport-diagnostics.json": diagnostic } : {}),
			...(options.largePayload ?
				{ "m04-export.json": randomBytes(1_250_000).toString("base64") } : {}),
			...(options.multipartResearchBytes ?
				{ "research-history.json": JSON.stringify({ syntheticPadding:
					randomBytes(options.multipartResearchBytes).toString("base64") }) } : {}) },
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


async function runStdioBridge(f: Awaited<ReturnType<typeof fixture>>,
	options: { wrongArtifactDigest?: boolean; readOnly?: boolean;
		outputPrivate?: string; recoverReserved?: boolean;
		repairPlanPrivateFile?: string;
		resultOnlyRepairReviewPrivateFile?: string;
		providerAvailabilityReceiptPrivateFile?: string;
		providerAvailabilityEnvelopeBytes?: Buffer;
		providerProbe?: { runId: string; artifactId: string; archiveSha256: string };
		wrongProviderArchiveEcho?: boolean;
		resultEnvelopeBytes?: Buffer; wrongResultArchiveEcho?: boolean;
		resultArchiveBytes?: Buffer; resultArtifactArchiveSha256?: string;
		wrongResultFileDigest?: boolean;
		interruptedSourceReviewPrivateFile?: string;
		terminalPrefixSourceReviewPrivateFile?: string;
		linkedUnknownDeliveryOldControlCommit?: string;
		unobservedControlSourceReviewPrivateFile?: string;
		request?: typeof fetch;
		prefixOnly?: { runId: string; artifactId: string; raw: string; archiveSha256: string };
		multipart?: { runId: string; rootArtifactId: string; rootArchiveSha256: string;
			indexRaw: string; parts: Array<{ artifactId: string; archiveSha256: string;
				artifactName: string; fileName: string; bytes: Buffer }>;
			partFault?: "changed-bytes" | "wrong-name" };
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
	const resultArchiveFile = options.resultArchiveBytes ? path.join(f.dir,
		"private-original-result.zip") : undefined;
	if (resultArchiveFile) await writeFile(resultArchiveFile, options.resultArchiveBytes!,
		{ mode: 0o600 });
	const providerEnvelopeFile = options.providerAvailabilityEnvelopeBytes ? path.join(f.dir,
		"provider-balance.enc.json") : undefined;
	if (providerEnvelopeFile)
		await writeFile(providerEnvelopeFile, options.providerAvailabilityEnvelopeBytes!, { mode: 0o600 });
	const prefixOnlyFile = options.prefixOnly ? path.join(f.dir, "prefix-only.json") : undefined;
	if (prefixOnlyFile) await writeFile(prefixOnlyFile, options.prefixOnly!.raw, { mode: 0o600 });
	const multipartIndexFile = options.multipart ? path.join(f.dir, "multipart-index.enc.json") : undefined;
	if (multipartIndexFile) await writeFile(multipartIndexFile, options.multipart!.indexRaw,
		{ mode: 0o600 });
	const multipartParts = options.multipart ? await Promise.all(options.multipart.parts.map(async (item, index) => {
		const file = path.join(f.dir, `multipart-part-${index}.bin`);
		const bytes = Buffer.from(item.bytes);
		if (options.multipart?.partFault === "changed-bytes" && index === 0) bytes[0] ^= 1;
		await writeFile(file, bytes, { mode: 0o600 });
		return { ...item, file, bytes };
	})) : [];
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
		...(options.providerAvailabilityReceiptPrivateFile ?
			["--provider-availability-receipt-private",
				options.providerAvailabilityReceiptPrivateFile] : []),
		...(options.interruptedSourceReviewPrivateFile ?
			["--interrupted-source-review-private", options.interruptedSourceReviewPrivateFile] : []),
		...(options.terminalPrefixSourceReviewPrivateFile ?
			["--terminal-prefix-source-review-private",
				options.terminalPrefixSourceReviewPrivateFile] : []),
		...(options.linkedUnknownDeliveryOldControlCommit ?
			["--linked-unknown-control-commit", options.linkedUnknownDeliveryOldControlCommit] : []),
		...(options.unobservedControlSourceReviewPrivateFile ?
			["--unobserved-control-source-review-private",
				options.unobservedControlSourceReviewPrivateFile] : []),
		...(options.readOnly ? ["--read-only"] : [])],
		{ cwd: path.dirname(path.dirname(script)), stdio: ["pipe", "pipe", "pipe"] });
	let stderr = "";
	child.stderr.setEncoding("utf8");
	child.stderr.on("data", chunk => { stderr += String(chunk); });
	const closed = once(child, "close");
	const lines: unknown[] = [];
	for await (const line of createInterface({ input: child.stdout, crlfDelay: Infinity })) {
		const row = JSON.parse(line) as { kind: string; id?: number; url?: string;
			runId?: string; artifactId?: string; expectedArchiveSha256?: string;
			expectedArtifactName?: string; name?: string };
		lines.push(row);
		if (row.kind === "github-get") {
			assert.equal(typeof row.url, "string");
			assert(row.url!.startsWith(`https://api.github.com/repos/${MISSION_REPOSITORY}/`));
			const response = await (options.request ?? f.request)(row.url!);
			child.stdin.write(`${JSON.stringify({ id: row.id, status: response.status,
				body: JSON.parse(await response.text()) })}\n`);
		} else if (row.kind === "artifact-file") {
			if (options.multipart && row.artifactId === options.multipart.rootArtifactId) {
				assert.equal(row.runId, options.multipart.runId);
				assert.equal(row.expectedArchiveSha256, options.multipart.rootArchiveSha256);
				child.stdin.write(`${JSON.stringify({ id: row.id,
					name: ARTIFACT_PARTITION_MANIFEST_FILE, file: multipartIndexFile,
					sha256: createHash("sha256").update(options.multipart.indexRaw).digest("hex"),
					archiveSha256: options.multipart.rootArchiveSha256 })}\n`);
				continue;
			}
			const part = multipartParts.find(item => item.artifactId === row.artifactId);
			if (part) {
				assert.equal(row.runId, options.multipart?.runId);
				assert.equal(row.expectedArtifactName, part.artifactName);
				assert.equal(row.expectedArchiveSha256, part.archiveSha256);
				assert.equal(row.name, part.fileName);
				child.stdin.write(`${JSON.stringify({ id: row.id,
					name: options.multipart?.partFault === "wrong-name" ?
						"private-artifact.part-99999999.bin" : part.fileName,
					file: part.file,
					sha256: createHash("sha256").update(part.bytes).digest("hex"),
					archiveSha256: part.archiveSha256 })}\n`);
				continue;
			}
			if (row.name === "provider-balance.enc.json") {
				assert.equal(row.artifactId, options.providerProbe?.artifactId ?? "9302");
				assert.equal(row.runId, options.providerProbe?.runId ?? "8002");
				assert.equal(row.expectedArchiveSha256,
					options.providerProbe?.archiveSha256 ?? "8".repeat(64));
				assert(providerEnvelopeFile && options.providerAvailabilityEnvelopeBytes);
				child.stdin.write(`${JSON.stringify({ id: row.id, name: "provider-balance.enc.json",
					file: providerEnvelopeFile,
					sha256: createHash("sha256").update(options.providerAvailabilityEnvelopeBytes).digest("hex"),
					archiveSha256: options.wrongProviderArchiveEcho ? "0".repeat(64) :
						options.providerProbe?.archiveSha256 ?? "8".repeat(64) })}\n`);
				continue;
			}
			if (row.artifactId === "9202") {
				assert.equal(row.runId, "7002");
				assert.equal(row.expectedArchiveSha256,
					options.resultArtifactArchiveSha256 ?? "9".repeat(64));
				assert(resultEnvelopeFile && options.resultEnvelopeBytes);
				child.stdin.write(`${JSON.stringify({ id: row.id,
					name: "private-campaign-outcome.enc.json", file: resultEnvelopeFile,
					sha256: options.wrongResultFileDigest ? "0".repeat(64) :
						createHash("sha256").update(options.resultEnvelopeBytes).digest("hex"),
					...(resultArchiveFile ? { archiveFile: resultArchiveFile } : {}),
					archiveSha256: options.wrongResultArchiveEcho ? "0".repeat(64) :
						options.resultArtifactArchiveSha256 ?? "9".repeat(64) })}\n`);
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


test("stdio bridge reconstructs authenticated multipart carry without exposing bytes", async t => {
	const f = await fixture(t, { unknownOperation: true,
		multipartResearchBytes: 17 * 1024 * 1024 });
	const seedBytes = Buffer.from(f.input.seedEnvelopeB64!, "base64");
	const seedDigest = createHash("sha256").update(seedBytes).digest("hex");
	const signed = JSON.parse(seedBytes.toString("utf8")) as { signature_b64: string };
	const missionKey = Buffer.from(hkdfSync("sha256", Buffer.from(signed.signature_b64, "base64"),
		Buffer.from(seedDigest, "hex"), "mul-pis-ledger-continuation-v1", 32));
	const rootArchiveSha256 = "a".repeat(64);
	const files = Object.fromEntries([
		[CARRY_FILE_NAME, Buffer.from(JSON.stringify({ envelopeB64: f.sealed.envelopeB64 }))],
		...Object.entries(f.sealed.sidecars).map(([name, content]) =>
			[name, Buffer.from(content)] as const)]) as Record<string, Buffer>;
	const prepared = partitionEncryptedFiles({ source: { repository: MISSION_REPOSITORY,
		runId: "7002", runAttempt: 1, commit: sourceCommit, event: "workflow_dispatch" },
		artifactName: CARRY_ARTIFACT_NAME, files });
	assert(prepared.chunks.length > 1, "the composed connector must fetch multiple real parts");
	const uploads = prepared.chunks.map((chunk, index) => ({ index: chunk.index,
		artifactId: String(9902 + index), archiveSha256: "b".repeat(64) }));
	const manifest = finalizePartitionManifest(prepared, uploads);
	const indexRaw = sealPartitionManifest({ manifest, missionKey, seedDigest });
	const multipart = { runId: "7002", rootArtifactId: "9002", rootArchiveSha256,
		indexRaw, parts: prepared.chunks.map((chunk, index) => ({
			artifactId: uploads[index]!.artifactId,
			archiveSha256: uploads[index]!.archiveSha256,
			artifactName: chunk.artifactName, fileName: chunk.fileName, bytes: chunk.bytes })) };
	const artifactRows = [{ id: 9002, name: CARRY_ARTIFACT_NAME, expired: false,
		digest: `sha256:${rootArchiveSha256}`,
		workflow_run: { id: 7002, head_sha: sourceCommit } },
		...manifest.chunks.map(chunk => ({ id: Number(chunk.artifactId),
			name: chunk.artifactName, expired: false, digest: `sha256:${chunk.archiveSha256}`,
			workflow_run: { id: 7002, head_sha: sourceCommit } }))];
	const request: typeof fetch = async (url, init) =>
		String(url).includes("/runs/7002/artifacts?") ?
			new Response(JSON.stringify({ total_count: artifactRows.length,
				artifacts: artifactRows })) : f.request(url, init);
	const accepted = await runStdioBridge(f, { readOnly: true, request, multipart });
	assert.equal(accepted.code, 0, accepted.stderr);
	assert.equal((accepted.lines.at(-1) as { kind: string }).kind, "planned-read-only");
	assert.equal(accepted.lines.filter(row => (row as { kind: string }).kind === "artifact-file")
		.length, 1 + manifest.chunks.length);
	assert(!accepted.stdout.includes(indexRaw));
	assert(!accepted.stdout.includes(f.sealed.envelopeB64));
	const changed = await runStdioBridge(f, { readOnly: true, request,
		multipart: { ...multipart, partFault: "changed-bytes" } });
	assert.equal(changed.code, 1);
	assert(!changed.stdout.includes("planned-read-only"));
	const wrongName = await runStdioBridge(f, { readOnly: true, request,
		multipart: { ...multipart, partFault: "wrong-name" } });
	assert.equal(wrongName.code, 1);
	assert(!wrongName.stdout.includes("planned-read-only"));
	const missingRequest: typeof fetch = async (url, init) =>
		String(url).includes("/runs/7002/artifacts?") ?
			new Response(JSON.stringify({ total_count: 1, artifacts: [artifactRows[0]] })) :
			f.request(url, init);
	const missing = await runStdioBridge(f, { readOnly: true, request: missingRequest,
		multipart });
	assert.equal(missing.code, 1);
	assert(!missing.stdout.includes("planned-read-only"));
	for (const invalidRows of [
		[...artifactRows, artifactRows[1]],
		artifactRows.map((row, index) => index === 1 ?
			{ ...row, workflow_run: { id: 7002, head_sha: sha40("0") } } : row),
		[...artifactRows, { id: 9999,
			name: `${CARRY_ARTIFACT_NAME}-part-00000001`, expired: false,
			digest: `sha256:${"c".repeat(64)}`,
			workflow_run: { id: 7002, head_sha: sourceCommit } }]
	]) {
		const invalidRequest: typeof fetch = async (url, init) =>
			String(url).includes("/runs/7002/artifacts?") ?
				new Response(JSON.stringify({ total_count: invalidRows.length,
					artifacts: invalidRows })) : f.request(url, init);
		const refused = await runStdioBridge(f, { readOnly: true,
			request: invalidRequest, multipart });
		assert.equal(refused.code, 1);
		assert(!refused.stdout.includes("planned-read-only"));
	}
});
