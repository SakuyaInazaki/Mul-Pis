import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createBashToolDefinition } from "@earendil-works/pi-coding-agent";
import { managedLocalBashOperations, observeManagedProcessGroup, prepareManagedBashCall, readManagedBashReceipt } from "../../src/runner/managed-bash.ts";

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

const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

for (const cause of ["abort", "timeout"] as const) {
	test(`${cause} lets a managed bash process finish its SIGTERM cleanup`, { timeout: 10_000 }, async t => {
		if (process.platform === "win32") return t.skip("managed POSIX bash only");
		const root = await mkdtemp(path.join(tmpdir(), `managed-bash-${cause}-`));
		t.after(() => rm(root, { recursive: true, force: true }));
		const script = 'process.on("SIGTERM", () => { console.log("cleanup-started"); setTimeout(() => { console.log("cleanup-complete"); process.exit(0); }, 100); }); console.log("ready"); setInterval(() => {}, 1000);';
		const command = `exec ${shellQuote(process.execPath)} -e ${shellQuote(script)}`;
		const call = await prepareManagedBashCall(root, `${cause}-session`, `${cause}-call`, command, root);
		const controller = new AbortController();
		let output = "";
		const running = managedLocalBashOperations(() => call, { terminationGraceMs: 500 }).exec(command, root, {
			onData: data => { output += data.toString("utf8"); },
			signal: controller.signal, timeout: cause === "timeout" ? 2 : undefined,
		});
		let settled = false;
		void running.then(() => { settled = true; }, () => { settled = true; });
		try {
			const deadline = Date.now() + 5_000;
			while (!output.includes("ready") && Date.now() < deadline) await delay(10);
			assert.match(output, /ready/);
			if (cause === "abort") controller.abort();
			await assert.rejects(running, cause === "abort" ? /aborted/ : /timeout:2/);
			assert.match(output, /cleanup-complete/);
			const receipt = await readManagedBashReceipt(call.file);
			assert.deepEqual(receipt.processExit && {
				exitCode: receipt.processExit.exitCode,
				signal: receipt.processExit.signal,
				abortSource: receipt.processExit.abortSource,
			}, { exitCode: 0, signal: null, abortSource: cause === "abort" ? "signal" : "timeout" });
			assert.equal(receipt.groupObservation, "none-observed");
		} finally {
			if (!settled && call.receipt.pid) {
				try { process.kill(-call.receipt.pid, "SIGKILL"); } catch { /* process already exited */ }
			}
			await running.catch(() => undefined);
		}
	});
}

test("managed bash escalates an ignored SIGTERM after a bounded grace period", { timeout: 10_000 }, async t => {
	if (process.platform === "win32") return t.skip("managed POSIX bash only");
	const root = await mkdtemp(path.join(tmpdir(), "managed-bash-escalation-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const script = 'process.on("SIGTERM", () => { console.log("term-ignored"); }); console.log("ready"); setInterval(() => {}, 1000);';
	// The shell exits on TERM while its child remains in the process group.
	const command = `${shellQuote(process.execPath)} -e ${shellQuote(script)} & trap 'exit 0' TERM; wait`;
	const call = await prepareManagedBashCall(root, "escalation-session", "escalation-call", command, root);
	const controller = new AbortController();
	let output = "";
	const running = managedLocalBashOperations(() => call, { terminationGraceMs: 250 }).exec(command, root, {
		onData: data => { output += data.toString("utf8"); }, signal: controller.signal,
	});
	try {
		const deadline = Date.now() + 5_000;
		while (!output.includes("ready") && Date.now() < deadline) await delay(10);
		assert.match(output, /ready/);
		controller.abort();
		await assert.rejects(running, /aborted/);
		assert.match(output, /term-ignored/);
		const receipt = await readManagedBashReceipt(call.file);
		assert.equal(receipt.processExit?.exitCode, 0);
		assert.equal(receipt.processExit?.signal, null);
		assert.equal(receipt.processExit?.abortSource, "signal");
		assert(call.receipt.pid);
		const cleanupDeadline = Date.now() + 2_000;
		while (await observeManagedProcessGroup(call.receipt.pid) !== "none-observed" && Date.now() < cleanupDeadline)
			await delay(20);
		assert.equal(await observeManagedProcessGroup(call.receipt.pid), "none-observed");
	} finally {
		if (call.receipt.pid && await observeManagedProcessGroup(call.receipt.pid) !== "none-observed") {
			try { process.kill(-call.receipt.pid, "SIGKILL"); } catch { /* process already exited */ }
		}
		await running.catch(() => undefined);
	}
});
