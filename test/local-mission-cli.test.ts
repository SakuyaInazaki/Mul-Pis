import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { main } from "../src/cli.ts";
import { openDefaultLocalMission } from "../src/m07/local-mission.ts";
import { FakeSessionRunner } from "../src/runner/fake.ts";

const execFileAsync = promisify(execFile);

async function capture(action: () => Promise<number>): Promise<{ code: number; output: string }> {
	const lines: string[] = [];
	const original = console.log;
	console.log = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
	try { return { code: await action(), output: lines.join("\n") }; }
	finally { console.log = original; }
}

test("local mission CLI takes an explicit original objective and exposes only public control status", async t => {
	const root = await mkdtemp(path.join(os.tmpdir(), "local-mission-cli-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	await mkdir(path.join(root, "problem", "raw"), { recursive: true });
	await writeFile(path.join(root, "problem", "problem.md"), "Original private problem marker\n");
	await writeFile(path.join(root, "problem", "raw", "observations.txt"), "Private raw evidence marker\n");
	await writeFile(path.join(root, "research.config.json"), JSON.stringify({
		roles: { default: "fake/model" }, concurrency: 1
	}));
	await capture(() => main(["init", "--workspace", root]));
	const request = path.join(root, "original.json");
	await writeFile(request, JSON.stringify({ version: 1, kind: "local-original-objective-request",
		goal: "Private original goal marker", goalSource: "verbatim-private-input",
		obligations: [{ id: "O1", description: "Private acceptance criterion marker" }],
		closure: "finite-evidence" }));
	const started = await capture(() => main(["mission", "start", "--workspace", root,
		"--runner", "fake", "--original", request]));
	assert.equal(started.code, 0);
	const missionId = (JSON.parse(started.output) as { missionId: string }).missionId;
	assert.match(missionId, /^[0-9a-f-]{36}$/i);
	assert.doesNotMatch(started.output, /Private original goal|Private acceptance|Private raw evidence/);
	const contract = JSON.parse(await readFile(path.join(root, ".agent", "missions",
		missionId, "original-contract.json"), "utf8")) as {
		goal: string; goalSource: string; inputNames: string[];
		obligations: Array<{ id: string; description: string }>; closure: string };
	assert.equal(contract.goal, "Private original goal marker");
	assert.equal(contract.goalSource, "verbatim-private-input");
	assert.deepEqual(contract.inputNames, ["problem.md", "observations.txt"]);
	assert.deepEqual(contract.obligations, [{ id: "O1",
		description: "Private acceptance criterion marker" }]);
	assert.equal(contract.closure, "finite-evidence");
	await rm(path.join(root, "research.config.json"));
	const status = await capture(() => main(["mission", "status", "--workspace", root,
		"--mission", missionId]));
	assert.equal(status.code, 0);
	const publicStatus = JSON.parse(status.output) as { missionId: string };
	assert.equal(publicStatus.missionId, missionId);
	assert.doesNotMatch(status.output, /Private original goal|Private acceptance|Private raw evidence|toolLog|nextTask/);
	await assert.rejects(capture(() => main(["mission", "status", "--workspace", root,
		"--mission", "other-mission"])));
	await writeFile(path.join(root, "research.config.json"), JSON.stringify({
		roles: { default: "fake/model" }, concurrency: 1
	}));
	const resumed = await capture(() => main(["mission", "resume", "--workspace", root,
		"--mission", missionId, "--runner", "fake"]));
	assert.equal(resumed.code, 1);
	assert.equal((JSON.parse(resumed.output) as { missionId: string }).missionId, missionId);
	assert.doesNotMatch(resumed.output, /Private original goal|Private acceptance|Private raw evidence|toolLog|nextTask/);
	const ran = await capture(() => main(["mission", "run", "--workspace", root,
		"--mission", missionId, "--runner", "fake"]));
	assert.equal(ran.code, 1);
	assert.equal((JSON.parse(ran.output) as { missionId: string }).missionId, missionId);
	assert.doesNotMatch(ran.output, /Private original goal|Private acceptance|Private raw evidence|toolLog|nextTask/);
});

test("mission CLI rejects ambiguous flags and GitHub control arguments before loading a runner", async () => {
	const help = await capture(() => main(["help"]));
	assert.match(help.output, /mission start \[--original/);
	assert.match(help.output, /mission run\|resume\|status --mission/);
	for (const argv of [
		["mission", "start", "--mission", "x"],
		["mission", "run"],
		["mission", "resume", "--mission", "x", "--mission", "y"],
		["mission", "status", "--mission", "x", "--runner", "fake"],
		["mission", "start", "--original", "file.json", "--repository", "owner/repo"],
		["mission", "run", "--mission", "x", "--runner", "other"],
		["mission", "status", "--mission", "x", "extra"]
	]) await assert.rejects(capture(() => main(argv)), { code: "cli.mission" });
});

test("mission start can freeze the workspace's exact original problem without a JSON plan", async t => {
	const root = await mkdtemp(path.join(os.tmpdir(), "local-mission-plain-start-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const original = "User-authored complete original goal with its own constraints.\n";
	await mkdir(path.join(root, "problem"), { recursive: true });
	await writeFile(path.join(root, "problem", "problem.md"), original);
	await writeFile(path.join(root, "research.config.json"), JSON.stringify({ roles: {
		research: "fake/research", execution: "fake/execution" }, concurrency: 1 }));
	await capture(() => main(["init", "--workspace", root]));
	const result = await capture(() => main(["mission", "start", "--workspace", root,
		"--runner", "fake"]));
	assert.equal(result.code, 0);
	const id = (JSON.parse(result.output) as { missionId: string }).missionId;
	const contract = JSON.parse(await readFile(path.join(root, ".agent", "missions", id,
		"original-contract.json"), "utf8")) as { goal: string; goalSource: string;
		obligations: Array<{ description: string }>; closure: string };
	assert.equal(contract.goal, original);
	assert.equal(contract.goalSource, "verbatim-private-input");
	assert.deepEqual(contract.obligations.map(item => item.description), [original]);
	assert.equal(contract.closure, "open-ended");
	assert.doesNotMatch(result.output, /User-authored complete original goal/);
});

test("separate CLI start and resume processes hand off the initial owner without a model", async t => {
	const root = await mkdtemp(path.join(os.tmpdir(), "local-mission-cli-processes-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	await mkdir(path.join(root, "problem"), { recursive: true });
	await writeFile(path.join(root, "problem", "problem.md"), "Synthetic original objective\n");
	await writeFile(path.join(root, "research.config.json"), JSON.stringify({
		roles: { research: "fake/research", execution: "fake/execution" }, concurrency: 1 }));
	const cli = path.resolve(import.meta.dirname, "../src/cli.ts");
	const invoke = async (...args: string[]): Promise<{ output: string; code: number }> => {
		try { return { output: (await execFileAsync(process.execPath,
			[cli, ...args, "--workspace", root], { maxBuffer: 1024 * 1024 })).stdout, code: 0 }; }
		catch (error) { return { output: (error as { stdout: string }).stdout,
			code: (error as { code: number }).code }; }
	};
	await invoke("init");
	const started = JSON.parse((await invoke("mission", "start", "--runner", "fake")).output) as { missionId: string };
	const missionRoot = path.join(root, ".agent", "missions", started.missionId);
	const release = JSON.parse(await readFile(path.join(missionRoot, "clean-start-release.json"), "utf8")) as
		{ kind: string; source: { attemptId: string } };
	assert.equal(release.kind, "local-clean-start-release");
	assert.equal(release.source.attemptId, "A001");
	const result = await invoke("mission", "resume", "--runner", "fake", "--mission", started.missionId);
	assert.equal(result.code, 1);
	const resumed = JSON.parse(result.output) as { missionId: string; stopReason: string };
	assert.equal(resumed.missionId, started.missionId);
	assert.equal(resumed.stopReason, "next-task-needs-capability");
	const status = JSON.parse(await readFile(path.join(missionRoot, "attempts", "A002", "source.json"), "utf8")) as
		{ attemptId: string };
	assert.equal(status.attemptId, "A002");
});

test("released start-only facade refuses execution before a fake provider call", async t => {
	const root = await mkdtemp(path.join(os.tmpdir(), "local-mission-start-fence-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	await mkdir(path.join(root, "problem"), { recursive: true });
	await writeFile(path.join(root, "problem", "problem.md"), "Synthetic original objective\n");
	await capture(() => main(["init", "--workspace", root]));
	let calls = 0;
	const runner = new FakeSessionRunner(() => { calls++; return "synthetic response"; });
	const mission = openDefaultLocalMission({ workspaceRoot: root, runner,
		config: { roles: { research: "fake/research", execution: "fake/execution" },
			concurrency: 1, tools: {} }, startOnly: true });
	const started = await mission.begin({ version: 1, kind: "local-original-objective-request",
		goal: "Synthetic original objective", goalSource: "verbatim-private-input",
		obligations: [{ id: "check", description: "Check the synthetic task" }],
		closure: "open-ended" });
	await assert.rejects(mission.step(started.contract.id), /owner was released/);
	assert.equal(calls, 0);
});

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
