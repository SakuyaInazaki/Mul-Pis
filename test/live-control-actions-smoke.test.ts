import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const smokeModule = new URL("../.github/actions/live-control-smoke/main.mjs", import.meta.url).href;
const { runSyntheticLiveObserverSmoke } = await import(smokeModule);

function syntheticEnv(temporary: string): NodeJS.ProcessEnv {
	return { PATH: process.env.PATH, HOME: process.env.HOME, GITHUB_ACTIONS: "true",
		GITHUB_REPOSITORY: "SakuyaInazaki/Mul-Pis", GITHUB_RUN_ID: "12345678",
		GITHUB_RUN_ATTEMPT: "1", GITHUB_SHA: "a".repeat(40),
		GITHUB_EVENT_NAME: "workflow_dispatch", RUNNER_TEMP: temporary,
		ACTIONS_RUNTIME_TOKEN: "synthetic-parent-runtime-token",
		ACTIONS_RESULTS_URL: "https://synthetic.invalid/results",
		ACTIONS_CACHE_URL: "https://synthetic.invalid/cache",
		ACTIONS_ID_TOKEN_REQUEST_TOKEN: "synthetic-parent-oidc-token",
		GITHUB_OUTPUT: path.join(temporary, "parent-github-output") };
}

test("synthetic action round-trips an authenticated committed prefix and status with isolated child env", async () => {
	const temporary = await mkdtemp(path.join(os.tmpdir(), "mulpis-actions-smoke-test-"));
	const uploads: Array<{ id: number; name: string; filename: string;
		bytes: Buffer; retentionDays: number }> = [];
	try {
		const artifactClient = {
			async uploadArtifact(name: string, files: string[], root: string,
				options: { retentionDays: number }) {
				assert.equal(files.length, 1);
				assert.ok(files[0]!.startsWith(root));
				const id = 44 + uploads.length;
			const bytes = await readFile(files[0]!);
			uploads.push({ id, name, filename: path.basename(files[0]!), bytes,
					retentionDays: options.retentionDays });
			return { id, size: bytes.length,
				digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}` };
			},
			async downloadArtifact(id: number, options: { path: string }) {
				const upload = uploads.find(row => row.id === id);
				assert.ok(upload);
				await mkdir(options.path, { recursive: true });
			await writeFile(path.join(options.path, upload.filename), upload.bytes);
				return { downloadPath: options.path };
			},
		};
		const result = await runSyntheticLiveObserverSmoke({ env: syntheticEnv(temporary),
			artifactClient });
		assert.equal(result.driverExitCode, 23);
		assert.equal(result.prefixArtifactName, "confidential-mission-prefix-12345678-1-1");
		assert.equal(uploads.length, 8);
		assert.ok(uploads.every(row => row.retentionDays === 1));
		const status = uploads.find(row => row.name === result.artifactName);
		const prefix = uploads.find(row => row.name === result.prefixArtifactName);
		assert.ok(status && prefix);
		assert.equal(status.id, result.artifactId);
		assert.equal(prefix.id, result.prefixArtifactId);
		assert.equal(prefix.filename, "incremental-control-prefix.json");
		assert.ok(!status.bytes.toString("utf8").includes("checkpointSha256"));
		assert.ok(!status.bytes.toString("utf8").includes("requestCount"));
		assert.ok(!prefix.bytes.toString("utf8").includes("requestAudit"));
	} finally { await rm(temporary, { recursive: true, force: true }); }
});

for (const altered of ["status", "prefix"] as const) test(
	`synthetic action rejects altered downloaded ${altered} ciphertext`, async () => {
	const temporary = await mkdtemp(path.join(os.tmpdir(), "mulpis-actions-smoke-tamper-"));
	const uploads: Array<{ id: number; name: string; filename: string; text: string }> = [];
	try {
		const artifactClient = {
			async uploadArtifact(name: string, files: string[]) {
				const id = 45 + uploads.length;
				uploads.push({ id, name, filename: path.basename(files[0]!),
					text: await readFile(files[0]!, "utf8") });
				return { id, size: 500 };
			},
			async downloadArtifact(id: number, options: { path: string }) {
				const upload = uploads.find(row => row.id === id);
				assert.ok(upload);
				let text = upload.text;
				if ((altered === "status" && upload.name.startsWith("confidential-campaign-progress-")) ||
					(altered === "prefix" && upload.name.startsWith("confidential-mission-prefix-"))) {
					const parsed = JSON.parse(text);
					if (altered === "status") parsed.tagB64 = Buffer.alloc(16).toString("base64");
					else parsed.incrementalControlEnvelope.tagB64 = Buffer.alloc(16).toString("base64");
					text = `${JSON.stringify(parsed)}\n`;
				}
				await mkdir(options.path, { recursive: true });
				await writeFile(path.join(options.path, upload.filename), text);
				return { downloadPath: options.path };
			},
		};
		await assert.rejects(runSyntheticLiveObserverSmoke({ env: syntheticEnv(temporary),
			artifactClient }), altered === "status" ? /downloaded ciphertext bytes differ/ :
			/downloaded prefix differs from committed bytes/);
	} finally { await rm(temporary, { recursive: true, force: true }); }
});
