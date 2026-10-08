import assert from "node:assert/strict";
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

test("synthetic action authenticates, uploads and downloads one ciphertext without passing runtime access to child", async () => {
	const temporary = await mkdtemp(path.join(os.tmpdir(), "mulpis-actions-smoke-test-"));
	const uploads: Array<{ name: string; text: string; retentionDays: number }> = [];
	try {
		const artifactClient = {
			async uploadArtifact(name: string, files: string[], root: string,
				options: { retentionDays: number }) {
				assert.ok(files[0]!.startsWith(root));
				uploads.push({ name, text: await readFile(files[0]!, "utf8"),
					retentionDays: options.retentionDays });
				return { id: 44, size: 500 };
			},
			async downloadArtifact(id: number, options: { path: string }) {
				assert.equal(id, 44);
				await mkdir(options.path, { recursive: true });
				await writeFile(path.join(options.path, `${uploads[0]!.name}.enc.json`),
					uploads[0]!.text);
				return { downloadPath: options.path };
			},
		};
		const result = await runSyntheticLiveObserverSmoke({ env: syntheticEnv(temporary),
			artifactClient });
		assert.deepEqual(result, { artifactName: "confidential-campaign-progress-12345678-1-1",
			artifactId: 44, driverExitCode: 23 });
		assert.equal(uploads.length, 1);
		assert.equal(uploads[0]!.retentionDays, 1);
		assert.ok(!uploads[0]!.text.includes("checkpointSha256"));
		assert.ok(!uploads[0]!.text.includes("requestCount"));
	} finally { await rm(temporary, { recursive: true, force: true }); }
});

test("synthetic action rejects altered downloaded ciphertext", async () => {
	const temporary = await mkdtemp(path.join(os.tmpdir(), "mulpis-actions-smoke-tamper-"));
	let uploaded = "";
	try {
		const artifactClient = {
			async uploadArtifact(_name: string, files: string[]) {
				uploaded = await readFile(files[0]!, "utf8");
				return { id: 45, size: 500 };
			},
			async downloadArtifact(_id: number, options: { path: string }) {
				const parsed = JSON.parse(uploaded);
				parsed.tagB64 = Buffer.alloc(16).toString("base64");
				await mkdir(options.path, { recursive: true });
				await writeFile(path.join(options.path,
					"confidential-campaign-progress-12345678-1-1.enc.json"),
					`${JSON.stringify(parsed)}\n`);
				return { downloadPath: options.path };
			},
		};
		await assert.rejects(runSyntheticLiveObserverSmoke({ env: syntheticEnv(temporary),
			artifactClient }), /downloaded ciphertext bytes differ/);
	} finally { await rm(temporary, { recursive: true, force: true }); }
});
