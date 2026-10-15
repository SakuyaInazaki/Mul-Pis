import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);


test("separate real Pi CLI invocations retain one auth-held mission through A003 without fetch", async t => {
	const root = await mkdtemp(path.join(os.tmpdir(), "local-mission-pi-no-auth-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const profile = path.join(root, "pi-profile"), fetchLog = path.join(root, "fetch.log");
	await mkdir(path.join(root, "problem"), { recursive: true });
	await mkdir(profile, { mode: 0o700 });
	await writeFile(path.join(root, "problem", "problem.md"), "Synthetic original objective\n");
	await writeFile(path.join(profile, "models.json"), JSON.stringify({ providers: { deepseek: { models: [{
		id: "deepseek-flash", name: "Offline DeepSeek", provider: "deepseek", api: "openai-completions",
		baseUrl: "https://invalid.example", reasoning: true, input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 10_000, maxTokens: 256,
		compat: { supportsStore: false, supportsDeveloperRole: false,
			maxTokensField: "max_tokens", thinkingFormat: "deepseek" },
	}] } } }));
	await writeFile(path.join(root, "research.config.json"), JSON.stringify({ roles: {
		research: "deepseek/deepseek-flash:low", execution: "deepseek/deepseek-flash:low" },
		localMission: { evaluatorId: "host:file-sha256" }, concurrency: 1, tools: {} }));
	const expected = createHash("sha256").update("Synthetic output\n").digest("hex");
	const original = path.join(root, "original.json");
	await writeFile(original, JSON.stringify({ version: 1, kind: "local-original-objective-request",
		goal: "Produce the synthetic output", goalSource: "verbatim-private-input",
		obligations: [{ id: "output", description: "Produce exact synthetic bytes",
			type: "file-sha256", expectedSha256: expected }], closure: "open-ended" }));
	const preload = path.join(root, "deny-fetch.mjs");
	await writeFile(preload, "import { appendFileSync } from 'node:fs'; globalThis.fetch = () => { appendFileSync(process.env.FETCH_LOG, 'fetch\\n'); throw new Error('offline fetch guard'); };\n");
	const cli = path.resolve(import.meta.dirname, "../src/cli.ts");
	const invoke = async (...args: string[]): Promise<{ output: string; code: number }> => {
		const options = { maxBuffer: 1024 * 1024, env: { ...process.env, PI_CODING_AGENT_DIR: profile,
			PI_OFFLINE: "1", DEEPSEEK_API_KEY: "", FETCH_LOG: fetchLog } };
		try { return { output: (await execFileAsync(process.execPath,
			["--import", preload, cli, ...args, "--workspace", root], options)).stdout, code: 0 }; }
		catch (error) { return { output: (error as { stdout: string }).stdout,
			code: (error as { code: number }).code }; }
	};
	assert.equal((await invoke("init")).code, 0);
	const started = await invoke("mission", "start", "--runner", "pi", "--original", original);
	assert.equal(started.code, 0);
	const missionId = (JSON.parse(started.output) as { missionId: string }).missionId;
	const missionRoot = path.join(root, ".agent", "missions", missionId);
	const originalBytes = await readFile(path.join(missionRoot, "original-contract.json"));
	for (const [action, attempt] of [["run", "A002"], ["resume", "A003"]] as const) {
		const result = await invoke("mission", action, "--runner", "pi", "--mission", missionId);
		assert.equal(result.code, 1, action);
		const status = JSON.parse(result.output) as { missionId: string; stopReason: string;
			pendingAction: { kind: string } };
		assert.equal(status.missionId, missionId);
		assert.equal(status.stopReason, "assessor-auth-unavailable");
		assert.equal(status.pendingAction.kind, "refresh-auth");
		assert.equal(JSON.parse(await readFile(path.join(missionRoot, "attempts", attempt,
			"final", "receipt.json"), "utf8")).transportOnly, true);
	}
	assert.deepEqual(await readFile(path.join(missionRoot, "original-contract.json")), originalBytes);
	assert.deepEqual(await readFile(fetchLog).catch(() => Buffer.alloc(0)), Buffer.alloc(0));
	assert.deepEqual(await readdir(path.join(missionRoot, "attempts", "A002", "operations")), []);
	assert.deepEqual(await readdir(path.join(missionRoot, "attempts", "A003", "operations")), []);
	assert.deepEqual(await readdir(path.join(root, "stages", "M07")).catch(error => {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [] as string[];
		throw error;
	}), []);
});
