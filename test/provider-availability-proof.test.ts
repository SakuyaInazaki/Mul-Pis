import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { isVerifiedProviderAvailabilityProof, verifyProviderAvailabilityProof,
	type ProviderAvailabilityReviewReceiptV1 } from "../src/runner/provider-availability-proof.ts";

const hash = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const terminalSource = { runId: "7002", runAttempt: 1, commit: "b".repeat(40) };
const probeSource = { runId: "8002", runAttempt: 1, commit: "e".repeat(40) };
const testedSourceCommit = "c".repeat(40);
const terminalEnvelopeSha256 = "a".repeat(64);
const archiveSha256 = "d".repeat(64);
const requestNonce = "f".repeat(32);
const requestMessage = `Check provider availability\n\n` +
	`Terminal-Run-Id: ${terminalSource.runId}\n` +
	`Terminal-Run-Attempt: ${terminalSource.runAttempt}\n` +
	`Terminal-Commit: ${terminalSource.commit}\n` +
	`Terminal-Envelope-SHA256: ${terminalEnvelopeSha256}\n` +
	`Request-Nonce: ${requestNonce}\n`;

async function fixture(t: TestContext) {
	const dir = await mkdtemp(path.join(os.tmpdir(), "provider-availability-proof-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const file = path.join(dir, "receipt.json");
	const envelope = Buffer.from(JSON.stringify({
		format: "mul-pis-provider-balance-v1", key_wrap: "RSA-3072-OAEP-SHA256",
		content_cipher: "AES-256-GCM",
		recipient_spki_sha256: "095541a341d91f128aa9cd1f0c6d34f6b7291fc5d667365ef5a67efd42fd0d23",
		metadata: { repository: "SakuyaInazaki/Mul-Pis", run_id: probeSource.runId,
			run_attempt: "1", commit: probeSource.commit, event: "push" },
		wrapped_key_b64: Buffer.alloc(384, 5).toString("base64"),
		nonce_b64: Buffer.alloc(12, 6).toString("base64"),
		ciphertext_b64: Buffer.alloc(100, 7).toString("base64") }));
	const receipt: ProviderAvailabilityReviewReceiptV1 = {
		version: 1, kind: "host-reviewed-provider-availability",
		terminal: { source: terminalSource, envelopeSha256: terminalEnvelopeSha256 },
		probe: { source: probeSource, workflowId: "92", jobId: "8202", artifactId: "9202",
			archiveSha256, envelopeSha256: hash(envelope), envelopeFile: "provider-balance.enc.json",
			testedSourceCommit, requestNonce },
		verdict: { kind: "provider-balance-availability", version: 1,
			availability: "available" },
		review: { kind: "operator-rsa-decryption-review", conclusion: "exact-envelope-available" } };
	await writeFile(file, JSON.stringify(receipt), { mode: 0o600 });
	const rows: Record<string, object> = {
		"/actions/workflows/provider-balance-check.yml": { id: 92,
			name: "Confidential provider balance check",
			path: ".github/workflows/provider-balance-check.yml", state: "active" },
		"/git/ref/heads/run-requests/provider-balance-availability":
			{ object: { sha: probeSource.commit } },
		[`/git/commits/${probeSource.commit}`]: { sha: probeSource.commit,
			message: requestMessage, tree: { sha: "9".repeat(40) },
			parents: [{ sha: testedSourceCommit }] },
		[`/git/commits/${testedSourceCommit}`]: { sha: testedSourceCommit,
			tree: { sha: "9".repeat(40) } },
		[`/actions/runs/${terminalSource.runId}`]: { id: 7002, run_attempt: 1,
			workflow_id: 91, head_sha: terminalSource.commit, status: "completed" },
		"/actions/jobs/7202": { id: 7202, run_id: 7002, run_attempt: 1,
			head_sha: terminalSource.commit, name: "private-campaign",
			status: "completed", completed_at: "2026-10-08T00:01:00Z" },
		[`/actions/runs/${probeSource.runId}`]: { id: 8002, run_attempt: 1,
			workflow_id: 92, name: "Confidential provider balance check",
			display_title: "Confidential provider balance check",
			head_branch: "run-requests/provider-balance-availability",
			head_sha: probeSource.commit, event: "push", actor: { login: "SakuyaInazaki" },
			status: "completed", conclusion: "success", created_at: "2026-10-08T00:02:00Z" },
		[`/actions/runs/${probeSource.runId}/jobs?per_page=100`]: { total_count: 1, jobs: [
			{ id: 8202, run_id: 8002, run_attempt: 1, head_sha: probeSource.commit,
				name: "provider-balance-check", status: "completed", conclusion: "success",
				started_at: "2026-10-08T00:03:00Z", steps: [
					{ name: "Verify exact source and accepted offline CI", status: "completed", conclusion: "success" },
					{ name: "Check once and seal availability", status: "completed", conclusion: "success" },
					{ name: "Upload ciphertext only", status: "completed", conclusion: "success" } ] } ] },
		[`/actions/runs/${probeSource.runId}/artifacts?per_page=100`]: { total_count: 1,
			artifacts: [{ id: 9202, name: "confidential-provider-balance-envelope",
				expired: false, digest: `sha256:${archiveSha256}`,
				workflow_run: { id: 8002, head_sha: probeSource.commit } }] } };
	const request: typeof fetch = async url => {
		const suffix = String(url).replace("https://api.github.com/repos/SakuyaInazaki/Mul-Pis", "");
		return rows[suffix] ? new Response(JSON.stringify(rows[suffix])) : new Response("{}", { status: 404 });
	};
	const verify = () => verifyProviderAvailabilityProof({ privateReceiptFile: file,
		terminalSource, terminalEnvelopeSha256, terminalWorkflowId: "91", terminalJobId: "7202",
		testedSourceCommit, request, authenticatedHostRead: true,
		loadEncryptedEnvelope: async () => envelope });
	return { dir, file, envelope, receipt, rows, verify };
}

test("available verdict is branded only after fresh exact live source and private receipt", async t => {
	const f = await fixture(t);
	const proof = await f.verify();
	assert.equal(isVerifiedProviderAvailabilityProof(proof), true);
	assert.equal(isVerifiedProviderAvailabilityProof({ ...proof }), false);
	assert.deepEqual(proof.terminalSource, terminalSource);
	assert.equal(proof.terminalEnvelopeSha256, terminalEnvelopeSha256);
	assert.equal(proof.testedSourceCommit, testedSourceCommit);
	assert.equal(proof.availability, "available");
});

test("old or nonmatching probe cannot release a later held terminal", async t => {
	const f = await fixture(t);
	const probe = f.rows[`/actions/runs/${probeSource.runId}`] as Record<string, unknown>;
	probe.created_at = "2026-10-08T00:00:00Z";
	await assert.rejects(f.verify(), { code: "probe-not-fresh" });
	probe.created_at = "2026-10-08T00:02:00Z";
	const request = f.rows[`/git/commits/${probeSource.commit}`] as Record<string, unknown>;
	request.message = requestMessage.replace(terminalEnvelopeSha256, "0".repeat(64));
	await assert.rejects(f.verify(), { code: "live-source-invalid" });
});

test("duplicate, expired, or altered artifacts and envelope fail closed", async t => {
	const f = await fixture(t);
	const result = f.rows[`/actions/runs/${probeSource.runId}/artifacts?per_page=100`] as {
		total_count: number; artifacts: Array<Record<string, unknown>> };
	result.artifacts[0]!.expired = true;
	await assert.rejects(f.verify(), { code: "artifact-invalid" });
	result.artifacts[0]!.expired = false;
	result.total_count = 2;
	result.artifacts.push({ ...result.artifacts[0]! });
	await assert.rejects(f.verify(), { code: "artifact-invalid" });
	result.total_count = 1; result.artifacts.pop();
	await writeFile(f.file, JSON.stringify({ ...f.receipt, probe: {
		...f.receipt.probe, envelopeSha256: "0".repeat(64) } }));
	await assert.rejects(f.verify(), { code: "envelope-invalid" });
});

test("operator review must be private and exactly bound", async t => {
	const f = await fixture(t);
	await chmod(f.file, 0o644);
	await assert.rejects(f.verify(), { code: "invalid-receipt" });
	await chmod(f.file, 0o600);
	await writeFile(f.file, JSON.stringify({ ...f.receipt, verdict: {
		kind: "provider-balance-availability", version: 1,
		availability: "unknown" } }));
	await assert.rejects(f.verify(), { code: "invalid-receipt" });
});
