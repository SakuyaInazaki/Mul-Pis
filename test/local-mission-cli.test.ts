import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { main } from "../src/cli.ts";

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
	assert.equal(resumed.code, 0);
	assert.equal((JSON.parse(resumed.output) as { missionId: string }).missionId, missionId);
	assert.doesNotMatch(resumed.output, /Private original goal|Private acceptance|Private raw evidence|toolLog|nextTask/);
	const ran = await capture(() => main(["mission", "run", "--workspace", root,
		"--mission", missionId, "--runner", "fake"]));
	assert.equal(ran.code, 0);
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
