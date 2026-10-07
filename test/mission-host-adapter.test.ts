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
import { CARRY_ARTIFACT_NAME, openLedgerContinuation, REUSABLE_RUN_REQUEST_MESSAGE,
	type CurrentMissionRun } from "../src/runner/ledger-continuation.ts";
import { decodeCarrySidecars } from "../src/runner/carry-sidecar-codec.ts";
import { MissionResumeJournal } from "../src/runner/mission-resume-journal.ts";
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
	ciConclusion: string;
	ciStatus: string;
	ciRunAttempt: number;
	ciCount: number;
};

function run(id: number, number: number, status: string, commit: string,
	conclusion?: string): object {
	return { id, run_number: number, run_attempt: 1, workflow_id: 91, status,
		conclusion, head_branch: "improve/workflow-learning-reliability", head_sha: commit,
		event: "workflow_dispatch", actor: { login: "SakuyaInazaki" } };
}

async function fixture(t: TestContext, options: { carriedAction?: boolean;
	unknownOperation?: boolean; controlRequest?: boolean;
	largePayload?: boolean; legacyV3?: boolean;
	stopReason?: "bounded-run-incomplete" | "assessment-failed" } = {}) {
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
		...(options.carriedAction ? { pendingActionFacts: { unresolvedOperationRefs: operationRefs } } : {}),
	});
	const bundle = { "original-objective.json": JSON.stringify(contract),
		"objective-checkpoint.json": JSON.stringify(checkpoint),
		"candidate.cpp": "synthetic candidate", "verification.json": "{}",
		"workflow-archive.json": "{}" };
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
		ciRunAttempt: 1, ciCount: 1 };
	let terminal = false;
	const request: typeof fetch = async url => {
		const address = String(url);
		let data: unknown;
		if (address.includes("/workflows/manual-private-campaign.yml/runs?"))
			data = { total_count: 2, workflow_runs: [terminal ? done : running, anchor] };
		else if (address.endsWith("/runs/7002")) data = done;
		else if (address.endsWith("/runs/7002/artifacts?per_page=100"))
			data = { total_count: 1, artifacts: [{ id: 9002, name: CARRY_ARTIFACT_NAME,
				expired: false, workflow_run: { id: 7002 } }] };
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
		} else if (address.includes("/git/commits/"))
			data = address.endsWith(`/git/commits/${requestCommit}`) ?
				{ sha: requestCommit, tree: { sha: testedTree },
					parents: [{ sha: sourceCommit }, { sha: priorControlCommit }] } :
				{ sha: sourceCommit, tree: { sha: testedTree }, parents: [] };
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
	return { dir, journal, live, checkpoint, bundle, sealed, request,
		input: { source: actualSource, seedEnvelopeB64, publicKeyFile, expectedSpkiSha256,
			githubToken: "synthetic-token", request, journal,
			loadCarryArtifact: async () => options.legacyV3 ? sealed.envelopeB64 : sealed } };
}

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
	assert.equal(result.decision.intent.actionProvenance?.checkpointSha256,
		createHash("sha256").update(oldBytes).digest("hex"));
	assert.equal(f.bundle["objective-checkpoint.json"], oldBytes);
	assert.equal((await f.journal.get(result.journalKey!))?.intentBinding.actionProvenance?.checkpointSha256,
		result.decision.intent.actionProvenance?.checkpointSha256);
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

async function runStdioBridge(f: Awaited<ReturnType<typeof fixture>>,
	options: { wrongArtifactDigest?: boolean; readOnly?: boolean;
		sidecarFault?: "missing" | "duplicate" | "tamper" } = {}) {
	const sourceFile = path.join(f.dir, "source.json");
	const seedFile = path.join(f.dir, "seed.txt");
	const artifactFile = path.join(f.dir, "carry.json");
	const outputPrivate = path.join(f.dir, "prepared-private.json");
	await writeFile(sourceFile, JSON.stringify(f.input.source), { mode: 0o600 });
	await writeFile(seedFile, f.input.seedEnvelopeB64!, { mode: 0o600 });
	const artifactBytes = JSON.stringify({ envelopeB64: f.sealed.envelopeB64 });
	await writeFile(artifactFile, artifactBytes, { mode: 0o600 });
	const artifactSha256 = createHash("sha256").update(artifactBytes).digest("hex");
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
		...(options.readOnly ? ["--read-only"] : [])],
		{ cwd: path.dirname(path.dirname(script)), stdio: ["pipe", "pipe", "pipe"] });
	let stderr = "";
	child.stderr.setEncoding("utf8");
	child.stderr.on("data", chunk => { stderr += String(chunk); });
	const closed = once(child, "close");
	const lines: unknown[] = [];
	for await (const line of createInterface({ input: child.stdout, crlfDelay: Infinity })) {
		const row = JSON.parse(line) as { kind: string; id?: number; url?: string;
			runId?: string; artifactId?: string };
		lines.push(row);
		if (row.kind === "github-get") {
			assert.equal(typeof row.url, "string");
			assert(row.url!.startsWith(`https://api.github.com/repos/${MISSION_REPOSITORY}/`));
			const response = await f.request(row.url!);
			child.stdin.write(`${JSON.stringify({ id: row.id, status: response.status,
				body: JSON.parse(await response.text()) })}\n`);
		} else if (row.kind === "artifact-file") {
			assert.equal(row.runId, f.input.source.runId);
			assert.equal(row.artifactId, row.runId === "7003" ? "9003" : "9002");
			const sidecars = options.sidecarFault === "missing" ? sidecarReferences.slice(0, -1) :
				options.sidecarFault === "duplicate" ? [...sidecarReferences, sidecarReferences[0]!] :
				sidecarReferences;
			child.stdin.write(`${JSON.stringify({ id: row.id, file: artifactFile,
				sha256: options.wrongArtifactDigest ? "0".repeat(64) : artifactSha256,
				...(sidecarReferences.length ? { sidecars } : {}) })}\n`);
		} else assert(["prepared", "planned-read-only", "no-dispatch"].includes(row.kind));
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

test("stdio bridge refuses an artifact whose private digest changed", async t => {
	const f = await fixture(t, { carriedAction: true });
	const bridge = await runStdioBridge(f, { wrongArtifactDigest: true });
	assert.equal(bridge.code, 1);
	assert(bridge.lines.some(row => (row as { kind: string }).kind === "artifact-file"));
	assert(!bridge.lines.some(row => (row as { kind: string }).kind === "prepared"));
	await assert.rejects(readFile(bridge.outputPrivate), { code: "ENOENT" });
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
		await assert.rejects(readFile(bridge.outputPrivate), { code: "ENOENT" });
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
