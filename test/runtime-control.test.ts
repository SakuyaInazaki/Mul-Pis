import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { readCurrentProcessIdentity, probeProcessIdentity } from "../src/runtime/process-identity.ts";
import { readTrustedPauseMs } from "../src/runtime/run-descriptor.ts";

const exec = promisify(execFile);
const script = path.resolve("scripts/workflow-control.ts");

test("process probe rejects changed birth token and other host", async () => {
	const identity = await readCurrentProcessIdentity();
	assert.deepEqual((await probeProcessIdentity(identity)).status, "alive");
	assert.equal((await probeProcessIdentity({ ...identity, processStartToken: "wrong" })).status, "unknown");
	assert.equal((await probeProcessIdentity({ ...identity, hostId: "other-host" })).status, "unknown");
});

test("repeated recovery decisions reuse this process's own identity instead of re-probing it", async () => {
	// Every recovery gate reads the current identity. When each read spawned a
	// helper process with a short timeout, a loaded machine could turn a live
	// owner into "unknown" and refuse a legitimate takeover. The answer cannot
	// change while this process runs, so it is read once.
	const started = Date.now();
	const identities = await Promise.all(Array.from({ length: 200 }, () => readCurrentProcessIdentity()));
	const probes = await Promise.all(identities.map(item => probeProcessIdentity(item)));
	assert.equal(new Set(identities.map(item => JSON.stringify(item))).size, 1,
		"one process has one identity; two different answers would make recovery decisions disagree");
	assert.deepEqual([...new Set(probes.map(item => `${item.status}:${item.reason}`))], ["alive:identity verified"]);
	assert.equal(identities[0].pid, process.pid);
	// Generous, but far below what 200 helper spawns would cost even unloaded.
	assert.ok(Date.now() - started < 10_000, `self identity took ${Date.now() - started} ms for 200 reads`);
});

test("an unreadable identity says which probe failed and why", async () => {
	// A pid that cannot exist: the birth-token probe must fail, and the failure
	// has to name itself. A bare "unavailable" is what made a timing flake
	// impossible to diagnose.
	await assert.rejects(readCurrentProcessIdentity(2_147_483_646), (error: Error) =>
		/process identity unavailable: birth token for pid 2147483646 failed \(.+\)/.test(error.message));
	await assert.rejects(readCurrentProcessIdentity(0), /invalid process pid/);
});

test("actual workflow-control reports stored declaration separately and refuses reused PID", async (t) => {
	const root = await mkdtemp(path.join(tmpdir(), "pre-rsi-control-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const identity = await readCurrentProcessIdentity();
	const descriptor = { version: 1, instanceId: "synthetic-instance", attemptId: "synthetic-attempt", workspaceId: "synthetic-workspace", codeRevision: "test", controlDir: root,
		processGroupId: identity.pid, process: identity };
	const descriptorFile = path.join(root, "run-descriptor.json");
	await writeFile(descriptorFile, JSON.stringify(descriptor));
	await writeFile(path.join(root, "control.json"), JSON.stringify({ version: 1, instanceId: "synthetic-instance", state: "running", pid: 123, totalPausedMs: 0 }));
	const { stdout } = await exec(process.execPath, [script, "status", "--descriptor", descriptorFile], { timeout: 5_000 });
	const status = JSON.parse(stdout);
	assert.equal(status.storedDeclaration.pid, 123);
	assert.equal(status.liveObservation.pid, identity.pid);
	assert.equal(status.identityMatch, true);
	await writeFile(descriptorFile, JSON.stringify({ ...descriptor, process: { ...identity, processStartToken: "reused" } }));
	await assert.rejects(exec(process.execPath, [script, "stop", "--descriptor", descriptorFile], { timeout: 5_000 }), /运行身份未验证/);
	await writeFile(path.join(root, ".control.lock"), "synthetic competing controller\n");
	await assert.rejects(exec(process.execPath, [script, "pause", "--descriptor", descriptorFile], { timeout: 5_000 }), /EEXIST/);
});

test("actual control script accounts only its own synthetic pause and resume", async (t) => {
	const root = await mkdtemp(path.join(tmpdir(), "pre-rsi-pause-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const worker = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { detached: true, stdio: "ignore" });
	try {
		const processIdentity = await readCurrentProcessIdentity(worker.pid!);
		const instanceId = "synthetic-pause";
		const descriptorFile = path.join(root, "run-descriptor.json");
		const stateFile = path.join(root, "control.json");
		await writeFile(descriptorFile, JSON.stringify({ version: 1, instanceId, attemptId: "A1", workspaceId: "test", codeRevision: "test", controlDir: root, processGroupId: worker.pid, process: processIdentity }));
		await writeFile(stateFile, JSON.stringify({ version: 1, instanceId, state: "running", updatedAt: new Date().toISOString(), totalPausedMs: 0 }));
		await exec(process.execPath, [script, "pause", "--descriptor", descriptorFile], { timeout: 5_000 });
		await new Promise((resolve) => setTimeout(resolve, 80));
		assert.ok(readTrustedPauseMs(Date.now(), stateFile, instanceId) >= 80);
		await exec(process.execPath, [script, "resume", "--descriptor", descriptorFile], { timeout: 5_000 });
		const resumed = JSON.parse(await readFile(stateFile, "utf8"));
		assert.equal(resumed.state, "running");
		assert.ok(resumed.totalPausedMs >= 80);
		assert.equal((await probeProcessIdentity(processIdentity)).status, "alive");
	} finally { try { process.kill(-worker.pid!, "SIGCONT"); } catch {} try { process.kill(-worker.pid!, "SIGTERM"); } catch {} }
});
