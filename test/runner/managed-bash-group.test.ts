import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createBashToolDefinition } from "@earendil-works/pi-coding-agent";
import { managedLocalBashOperations, prepareManagedBashCall, readManagedBashReceipt } from "../../src/runner/managed-bash.ts";

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
