import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createBashToolDefinition } from "@earendil-works/pi-coding-agent";
import { managedLocalBashOperations, observeManagedProcessGroup, prepareManagedBashCall,
	readManagedBashReceipt } from "../../src/runner/managed-bash.ts";

const error = (code: string): NodeJS.ErrnoException => Object.assign(new Error(code), { code });

test("Darwin-style group probe distinguishes empty, present and unavailable without procfs", async () => {
	const base = { platform: "darwin" as const };
	assert.equal(await observeManagedProcessGroup(321, {
		...base, signalGroup: () => { throw error("ESRCH"); } }), "none-observed");
	assert.equal(await observeManagedProcessGroup(321, {
		...base, signalGroup: () => undefined }), "members-observed");
	assert.equal(await observeManagedProcessGroup(321, {
		...base, signalGroup: () => { throw error("EPERM"); } }), "members-observed");
	assert.equal(await observeManagedProcessGroup(321, {
		...base, signalGroup: () => { throw error("ENOSYS"); } }), "unknown");
	assert.equal(await observeManagedProcessGroup(0, base), "unknown");
});

test("Linux positive group probe stays present when procfs hides a live member", async () => {
	// The host might list only a zombie while an unlisted child still holds the
	// process group. No procfs-only refinement may turn a positive kill probe
	// into a false empty result.
	assert.equal(await observeManagedProcessGroup(321, { platform: "linux",
		signalGroup: () => undefined }), "members-observed");
	assert.equal(await observeManagedProcessGroup(321, { platform: "linux",
		signalGroup: () => { throw error("EPERM"); } }), "members-observed");
	assert.equal(await observeManagedProcessGroup(321, { platform: "linux",
		signalGroup: () => { throw error("ESRCH"); } }), "none-observed");
});

test("external SIGTERM fails the Pi bash tool after draining output and records the real signal", {
	timeout: 10_000,
}, async t => {
	if (process.platform === "win32") return t.skip("managed POSIX bash only");
	const root = await mkdtemp(path.join(tmpdir(), "managed-bash-signal-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const command = "printf 'before-signal\\n'; exec sleep 30";
	const call = await prepareManagedBashCall(root, "signal-session", "signal-call", command, root);
	const updates: string[] = [];
	const bash = createBashToolDefinition(root, {
		operations: managedLocalBashOperations(() => call),
		exposeSessionEnvironment: false,
	});
	const running = bash.execute("signal-call", { command }, undefined,
		update => { updates.push(JSON.stringify(update.content)); }, { cwd: root } as never);
	let settled = false;
	void running.then(() => { settled = true; }, () => { settled = true; });
	try {
		const deadline = Date.now() + 5_000;
		while ((!call.receipt.pid || !updates.join(" ").includes("before-signal")) && Date.now() < deadline)
			await delay(10);
		assert(call.receipt.pid, "managed subprocess was not observed");
		assert.match(updates.join(" "), /before-signal/, "output should reach Pi before termination");
		process.kill(call.receipt.pid, "SIGTERM");
		await assert.rejects(running, /Command terminated by signal SIGTERM/);
		const receipt = await readManagedBashReceipt(call.file);
		assert.deepEqual(receipt.processExit && {
			exitCode: receipt.processExit.exitCode,
			signal: receipt.processExit.signal,
			abortSource: receipt.processExit.abortSource,
		}, { exitCode: null, signal: "SIGTERM", abortSource: "none" });
		assert(receipt.outputBytesAtExit && receipt.outputBytesAtExit >= "before-signal\n".length);
	} finally {
		if (!settled && call.receipt.pid) {
			try { process.kill(-call.receipt.pid, "SIGKILL"); } catch { /* process already exited */ }
		}
		await running.catch(() => undefined);
	}
});
