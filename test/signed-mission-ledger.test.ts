import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign, constants } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { MISSION_ARTIFACT, MISSION_ID, MISSION_REPOSITORY, MISSION_TOTAL_CNY,
	verifySignedMissionLedger } from "../src/runner/signed-mission-ledger.ts";

const historicalMessage = "Synthetic historical request";

const current = { repository: MISSION_REPOSITORY, runId: "8001004", runAttempt: "1",
	actor: "SakuyaInazaki", event: "workflow_dispatch", ref: "refs/heads/improve/workflow-learning-reliability",
	sha: "a".repeat(40), manualAuthorized: "true" };

async function fixture(t: TestContext) {
	const dir = await mkdtemp(path.join(os.tmpdir(), "signed-ledger-fixture-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
	const publicKeyFile = path.join(dir, "public.pem");
	await writeFile(publicKeyFile, publicKey.export({ type: "spki", format: "pem" }));
	const expectedSpkiSha256 = createHash("sha256").update(publicKey.export({ type: "spki", format: "der" })).digest("hex");
	const payload = { version: 1, kind: "mul-pis-private-mission-ledger", missionId: MISSION_ID,
		repository: MISSION_REPOSITORY, globalMaxCny: MISSION_TOTAL_CNY,
		priorCommittedCny: 7.25, revision: 1,
		previous: { runId: "8001001", runAttempt: 1, artifactId: "9002001",
			artifactName: MISSION_ARTIFACT } };
	const envelope = (value: object) => {
		const bytes = Buffer.from(JSON.stringify(value));
		const signature = sign("sha256", bytes, { key: privateKey, padding: constants.RSA_PKCS1_PSS_PADDING,
			saltLength: 32 });
		return Buffer.from(JSON.stringify({ payload_b64: bytes.toString("base64"),
			signature_b64: signature.toString("base64") })).toString("base64");
	};
	return { publicKeyFile, expectedSpkiSha256, payload, envelope };
}

function fakeGithub(options: { currentNumber?: number; skipped?: "skipped" | "success";
	artifactId?: number; event?: "workflow_dispatch" | "push"; message?: string;
	anchorEvent?: "workflow_dispatch" | "push" } = {}) {
	const calls: string[] = [];
	const request: typeof fetch = async (url) => {
		const address = String(url);
		calls.push(address);
		let data: unknown;
		if (address.endsWith("/workflows/manual-private-campaign.yml/runs?per_page=100&page=1")) {
			data = { total_count: options.currentNumber === 13 ? 3 : 2, workflow_runs: [
				{ id: Number(current.runId), run_number: options.currentNumber ?? 12, run_attempt: 1,
					workflow_id: 71, status: "in_progress", head_branch: "improve/workflow-learning-reliability",
					event: options.event ?? "workflow_dispatch", head_sha: current.sha,
					actor: { login: "SakuyaInazaki" }, head_commit: { message: options.message ?? historicalMessage } },
				...(options.currentNumber === 13 ? [{ id: 8001003, run_number: 12, run_attempt: 1,
					workflow_id: 71, status: "completed", head_sha: "b".repeat(40), head_branch: "improve/workflow-learning-reliability" }] : []),
				{ id: 8001001, run_number: 11, run_attempt: 1,
					workflow_id: 71, status: "completed", head_sha: "b".repeat(40), head_branch: "improve/workflow-learning-reliability",
					event: options.anchorEvent, head_commit: { message: historicalMessage } },
			] };
		} else if (address.endsWith("/runs/8001003/jobs?per_page=100")) {
			data = { total_count: 1, jobs: [{ name: "private-campaign", status: "completed",
				conclusion: options.skipped ?? "skipped", steps: [{ name: "Run bounded private campaign",
					status: "completed", conclusion: options.skipped ?? "skipped" }] }] };
		} else if (address.endsWith("/runs/8001001/artifacts?per_page=100")) {
			data = { total_count: 1, artifacts: [{ id: options.artifactId ?? 9002001, name: MISSION_ARTIFACT,
				expired: false, workflow_run: { id: 8001001 } }] };
		} else throw new Error("unexpected mock URL");
		return new Response(JSON.stringify(data), { status: 200 });
	};
	return { request, calls };
}

test("signed cumulative ledger admits the exact previous run and encrypted artifact", async (t) => {
	const f = await fixture(t), github = fakeGithub();
	const checked = await verifySignedMissionLedger({ envelopeB64: f.envelope(f.payload),
		publicKeyFile: f.publicKeyFile, expectedSpkiSha256: f.expectedSpkiSha256,
		githubToken: "synthetic-token", current, request: github.request });
	assert.equal(checked.globalMaxCny, 30);
	assert.equal(checked.priorCommittedCny, 7.25);
	assert.equal(github.calls.length, 2);
});

test("changed carry and missing ledger fail before the GitHub freshness request", async (t) => {
	const f = await fixture(t), github = fakeGithub();
	const valid = JSON.parse(Buffer.from(f.envelope(f.payload), "base64").toString("utf8"));
	valid.payload_b64 = Buffer.from(JSON.stringify({ ...f.payload, priorCommittedCny: 0 })).toString("base64");
	await assert.rejects(verifySignedMissionLedger({ envelopeB64: Buffer.from(JSON.stringify(valid)).toString("base64"),
		publicKeyFile: f.publicKeyFile, expectedSpkiSha256: f.expectedSpkiSha256,
		githubToken: "synthetic-token", current, request: github.request }), /authentication failed/);
	await assert.rejects(verifySignedMissionLedger({ envelopeB64: undefined,
		publicKeyFile: f.publicKeyFile, expectedSpkiSha256: f.expectedSpkiSha256,
		githubToken: "synthetic-token", current, request: github.request }), /encoding is invalid/);
	assert.equal(github.calls.length, 0);
});

test("freshness permits only proved skipped intervening jobs", async (t) => {
	const f = await fixture(t);
	const skipped = fakeGithub({ currentNumber: 13, skipped: "skipped" });
	await verifySignedMissionLedger({ envelopeB64: f.envelope(f.payload), publicKeyFile: f.publicKeyFile,
		expectedSpkiSha256: f.expectedSpkiSha256, githubToken: "synthetic-token", current,
		request: skipped.request });
	assert.equal(skipped.calls.length, 3);
	const paid = fakeGithub({ currentNumber: 13, skipped: "success" });
	await assert.rejects(verifySignedMissionLedger({ envelopeB64: f.envelope(f.payload),
		publicKeyFile: f.publicKeyFile, expectedSpkiSha256: f.expectedSpkiSha256,
		githubToken: "synthetic-token", current, request: paid.request }), /may have executed/);
	const preCampaignFailure = fakeGithub({ currentNumber: 13 });
	const noProviderRequest: typeof fetch = async (url, init) => String(url).endsWith("/runs/8001003/jobs?per_page=100") ?
		new Response(JSON.stringify({ total_count: 1, jobs: [{ name: "private-campaign", status: "completed", conclusion: "failure",
			steps: [{ name: "Run bounded private campaign", status: "completed", conclusion: "skipped" }] }] }),
			{ status: 200 }) : preCampaignFailure.request(url, init);
	await verifySignedMissionLedger({ envelopeB64: f.envelope(f.payload), publicKeyFile: f.publicKeyFile,
		expectedSpkiSha256: f.expectedSpkiSha256, githubToken: "synthetic-token", current,
		request: noProviderRequest });
	const wrongArtifact = fakeGithub({ artifactId: 9 });
	await assert.rejects(verifySignedMissionLedger({ envelopeB64: f.envelope(f.payload),
		publicKeyFile: f.publicKeyFile, expectedSpkiSha256: f.expectedSpkiSha256,
		githubToken: "synthetic-token", current, request: wrongArtifact.request }), /artifact is unavailable/);
});

test("a current push is rejected while historical push ancestry remains readable", async (t) => {
	const f = await fixture(t);
	const push = fakeGithub({ event: "push" });
	await assert.rejects(verifySignedMissionLedger({ envelopeB64: f.envelope(f.payload), publicKeyFile: f.publicKeyFile,
		expectedSpkiSha256: f.expectedSpkiSha256, githubToken: "synthetic-token",
		current: { ...current, event: "push", manualAuthorized: undefined }, request: push.request }),
		/current Actions identity/);
	assert.equal(push.calls.length, 0);
	const historicalPush = fakeGithub({ anchorEvent: "push" });
	await verifySignedMissionLedger({ envelopeB64: f.envelope(f.payload),
		publicKeyFile: f.publicKeyFile, expectedSpkiSha256: f.expectedSpkiSha256,
		githubToken: "synthetic-token", current, request: historicalPush.request });
	const manual = fakeGithub();
	await assert.rejects(verifySignedMissionLedger({ envelopeB64: f.envelope(f.payload),
		publicKeyFile: f.publicKeyFile, expectedSpkiSha256: f.expectedSpkiSha256,
		githubToken: "synthetic-token", current: { ...current, manualAuthorized: "false" },
		request: manual.request }), /current Actions identity/);
	assert.equal(manual.calls.length, 0);
});
