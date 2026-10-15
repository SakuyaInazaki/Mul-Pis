import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { connectConsole, listConsoles } from "../src/console/client.ts";
import { parseConsoleRequest, type ConsoleRecord } from "../src/console/protocol.ts";
import { boundConsoleRecord, type ConsoleHostOptions } from "../src/console/host.ts";
import { recoveryIdentity } from "../src/console/pi-process.ts";
import { acquireConsoleWorkspaceOwner, withWorkspaceMutationOwnership } from "../src/console/ownership.ts";
import { readCurrentProcessIdentity } from "../src/runtime/process-identity.ts";

test("console protocol rejects arbitrary RPC and malformed target", () => {
	assert.throws(() => parseConsoleRequest({ requestId: "x", instanceId: "i", command: "bash" }), /invalid console request/);
	assert.throws(() => parseConsoleRequest({ requestId: "x", instanceId: "i", command: "events", since: -1 }), /cursor/);
});

test("console record follows the descriptor attempt even when the goal ID is unchanged", () => {
	const record = { version: 1, instanceId: randomUUID(), workspace: "/tmp/workspace", socketPath: "/tmp/socket", hostPid: 1, descriptorFile: "/tmp/descriptor", controlDir: "/tmp/control", startedAt: "now", state: "running", goalRunId: "goal", attemptId: "A001" } as ConsoleRecord;
	assert.equal(boundConsoleRecord(record, { goalRunId: "goal", attemptId: "A002" }).attemptId, "A002");
	assert.equal(boundConsoleRecord({ ...record, goalRunId: undefined, attemptId: undefined }, { attemptId: "A001" }).attemptId, "A001");
});

test("console client rejects a socket that closes without a response", async (t) => {
	const identity = await readCurrentProcessIdentity().catch(() => undefined);
	if (!identity) { t.skip("precise process identity is unavailable in this sandbox"); return; }
	const instanceId = randomUUID();
	const directory = path.join("/tmp", `prsi-console-${process.getuid?.() ?? "user"}-${instanceId}`);
	await mkdir(directory, { mode: 0o700 });
	t.after(() => rm(directory, { recursive: true, force: true }));
	const socketPath = path.join(directory, "rpc.sock");
	const server = createServer((socket) => socket.end());
	await new Promise<void>((resolve) => server.listen(socketPath, resolve));
	t.after(() => server.close());
	await (await import("node:fs/promises")).chmod(socketPath, 0o600);
	const controlDir = path.join(directory, ".agent", "console", "instances", instanceId);
	const record: ConsoleRecord = { version: 1, instanceId, workspace: directory, socketPath, hostPid: process.pid, hostProcess: identity, descriptorFile: path.join(controlDir, "run-descriptor.json"), controlDir, startedAt: new Date().toISOString(), state: "running" };
	await assert.rejects(connectConsole(record, { requestId: randomUUID(), instanceId, command: "status" }, 1_000), /closed before response/);
});

test("recovery uses the persisted M07 workspace identity, not an old console path", async (t) => {
	const identity = await readCurrentProcessIdentity().catch(() => undefined);
	if (!identity) { t.skip("precise process identity is unavailable in this sandbox"); return; }
	const workspace = await realpath(await mkdtemp(path.join(tmpdir(), "pre-rsi-recovery-test-")));
	t.after(() => rm(workspace, { recursive: true, force: true }));
	const goalRunId = "20261014T000000Z-abcd";
	const goalDir = path.join(workspace, "stages", "M07", goalRunId);
	await mkdir(goalDir, { recursive: true });
	const prior = { version: 1, instanceId: randomUUID(), attemptId: "A001", workspaceId: randomUUID(), goalRunId, codeRevision: "test", controlDir: goalDir, process: identity };
	await writeFile(path.join(goalDir, "goal.json"), JSON.stringify({ runId: goalRunId, lifecycle: "active", executionState: { activeAttemptId: "A001", attempts: [{ id: "A001", runDescriptor: prior }] } }));
	const oldFile = path.join(workspace, "old-descriptor.json");
	await writeFile(oldFile, JSON.stringify({ ...prior, workspaceId: workspace }));
	const result = await recoveryIdentity({ workspace, instanceId: randomUUID(), controlDir: goalDir, cliFile: "unused", extensionFile: "unused", piArgs: [], goalRunId, recover: true, oldDescriptorFile: oldFile });
	assert.equal(result.workspaceId, prior.workspaceId);
	assert.equal(result.attemptId, "A002");
});

test("console owner rejects an active external M07 attempt and an unversioned active goal", async (t) => {
	const identity = await readCurrentProcessIdentity().catch(() => undefined);
	if (!identity) { t.skip("precise process identity is unavailable in this sandbox"); return; }
	const workspace = await realpath(await mkdtemp(path.join(tmpdir(), "pre-rsi-owner-test-")));
	t.after(() => rm(workspace, { recursive: true, force: true }));
	const goalDir = path.join(workspace, "stages", "M07", "goal");
	await mkdir(goalDir, { recursive: true });
	const file = path.join(goalDir, "goal.json");
	const descriptor = { version: 1, instanceId: randomUUID(), attemptId: "A001", workspaceId: randomUUID(), goalRunId: "goal", codeRevision: "test", controlDir: goalDir, process: identity };
	await writeFile(file, JSON.stringify({ lifecycle: "active", executionState: { activeAttemptId: "A001", attempts: [{ id: "A001", runDescriptor: descriptor }] } }));
	await assert.rejects(acquireConsoleWorkspaceOwner(workspace, randomUUID()), /running attempt/);
	await writeFile(file, JSON.stringify({ lifecycle: "active" }));
	await assert.rejects(acquireConsoleWorkspaceOwner(workspace, randomUUID()), /active legacy M07 goal/);
	await writeFile(file, JSON.stringify({ lifecycle: "finished" }));
	const release = await acquireConsoleWorkspaceOwner(workspace, randomUUID());
	await release();
});

test("host refuses readiness when the workflow bridge command is missing", async (t) => {
	if (!await readCurrentProcessIdentity().catch(() => undefined)) { t.skip("precise process identity is unavailable in this sandbox"); return; }
	const workspace = await realpath(await mkdtemp(path.join(tmpdir(), "pre-rsi-bridge-test-")));
	t.after(() => rm(workspace, { recursive: true, force: true }));
	const instanceId = randomUUID();
	const controlDir = path.join(workspace, ".agent", "console", "instances", instanceId);
	const socketDir = path.join("/tmp", `prsi-console-${process.getuid?.() ?? "user"}-${instanceId}`);
	await mkdir(controlDir, { recursive: true });
	await mkdir(socketDir, { mode: 0o700 });
	t.after(() => rm(socketDir, { recursive: true, force: true }));
	const fakeCli = path.join(workspace, "missing-bridge.mjs");
	await writeFile(fakeCli, `let text=""; process.stdin.on("data", chunk=>{text+=chunk;let end;while((end=text.indexOf("\\n"))>=0){const item=JSON.parse(text.slice(0,end));text=text.slice(end+1);process.stdout.write(JSON.stringify({type:"response",id:item.id,command:item.type,success:true,data:{commands:[]}})+"\\n");}});`);
	const config: ConsoleHostOptions = { workspace, instanceId, controlDir, socketPath: path.join(socketDir, "rpc.sock"), recordFile: path.join(controlDir, "instance.json"), piCliFile: fakeCli };
	const configFile = path.join(controlDir, "host-options.json");
	await writeFile(configFile, JSON.stringify(config));
	const host = spawn(process.execPath, [fileURLToPath(new URL("../src/console/host.ts", import.meta.url)), configFile], { stdio: "ignore" });
	t.after(() => host.kill("SIGKILL"));
	await new Promise((resolve) => host.once("exit", resolve));
	const record = JSON.parse(await readFile(config.recordFile, "utf8")) as ConsoleRecord;
	assert.equal(record.state, "error");
	assert.match(record.error ?? "", /did not register/);
	await assert.rejects(readFile(path.join(workspace, ".agent", "console", "owner.lock")), /ENOENT/);
});

test("detached console host keeps a Pi RPC child alive across client disconnects", async (t) => {
	if (!await readCurrentProcessIdentity().catch(() => undefined)) { t.skip("precise process identity is unavailable in this sandbox"); return; }
	const workspace = await realpath(await mkdtemp(path.join(tmpdir(), "pre-rsi-console-test-")));
	const instanceId = randomUUID();
	const controlDir = path.join(workspace, ".agent", "console", "instances", instanceId);
	const socketDir = path.join("/tmp", `prsi-console-${process.getuid?.() ?? "user"}-${instanceId}`);
	await mkdir(controlDir, { recursive: true, mode: 0o700 });
	await mkdir(socketDir, { mode: 0o700 });
	const fakeCli = path.join(workspace, "fake-pi.mjs");
	await writeFile(fakeCli, `import { writeFileSync } from "node:fs"; import path from "node:path"; let buffer = ""; process.stdin.on("data", chunk => { buffer += chunk; let end; while ((end = buffer.indexOf("\\n")) >= 0) { const item = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1); const message = String(item.message ?? ""); if (message.startsWith("/workflow-console-cancel ")) { const id = message.split(" ")[1]; writeFileSync(path.join(process.env.MUL_PIS_CONSOLE_CONTROL_DIR, "responses", id + ".cancel.json"), JSON.stringify({version:1,requestId:id,ok:true,cancelled:true}), {mode:0o600}); process.stdout.write(JSON.stringify({type:"cancel-routed",requestId:id})+"\\n"); } if (!message.startsWith("/workflow-console ") || message.endsWith("dead")) process.stdout.write(JSON.stringify({ type: "response", id: item.id, command: item.type, success: !message.endsWith("dead"), error: message.endsWith("dead") ? "bridge rejected" : undefined, data: item.type === "get_state" ? { active: true } : item.type === "get_commands" ? { commands: [{name:"workflow-console",source:"extension"},{name:"workflow-console-cancel",source:"extension"}] } : undefined }) + "\\n"); if (item.type === "prompt" && !message.startsWith("/workflow-console")) { for (let i=0;i<10;i++) process.stdout.write(JSON.stringify({type:"message_update",assistantMessageEvent:{type:"text_delta",delta:"x".repeat(40000)}})+"\\n"); process.stdout.write(JSON.stringify({type:"message_update",assistantMessageEvent:{type:"thinking_delta",delta:"SECRET_THINKING"}})+"\\n"); } } });`);
	const config: ConsoleHostOptions = { workspace, instanceId, controlDir, socketPath: path.join(socketDir, "rpc.sock"), recordFile: path.join(controlDir, "instance.json"), piCliFile: fakeCli };
	const configFile = path.join(controlDir, "host-options.json");
	await writeFile(configFile, JSON.stringify(config));
	const host = spawn(process.execPath, [fileURLToPath(new URL("../src/console/host.ts", import.meta.url)), configFile], { stdio: ["ignore", "ignore", "pipe"] });
	let hostError = ""; host.stderr.on("data", (chunk: Buffer) => { hostError += chunk.toString("utf8"); });
	let piPid: number | undefined;
	t.after(async () => { if (piPid) { try { process.kill(-piPid, "SIGTERM"); } catch {} } host.kill("SIGKILL"); await rm(socketDir, { recursive: true, force: true }); await rm(workspace, { recursive: true, force: true }); });
	let record: ConsoleRecord | undefined;
	for (let i = 0; i < 100; i++) {
		try { const item = JSON.parse(await readFile(config.recordFile, "utf8")) as ConsoleRecord; if (item.state === "running") { await readFile(item.descriptorFile); record = item; break; } }
		catch {}
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	assert.ok(record, `host starts: ${hostError}`);
	assert.equal(record.attemptId, "A001", "ready record already includes the trusted Pi attempt");
	piPid = record.piPid;
	assert.ok(piPid && piPid !== record.hostPid);
	await assert.rejects(withWorkspaceMutationOwnership(workspace, async () => "unsafe"), /already owned/);
	const secondId = randomUUID();
	const secondDir = path.join(workspace, ".agent", "console", "instances", secondId);
	await mkdir(secondDir, { recursive: true, mode: 0o700 });
	const secondConfig = path.join(secondDir, "host-options.json");
	await writeFile(secondConfig, JSON.stringify({ ...config, instanceId: secondId, controlDir: secondDir, recordFile: path.join(secondDir, "instance.json"), socketPath: path.join("/tmp", `prsi-console-${process.getuid?.() ?? "user"}-${secondId}`, "rpc.sock") }));
	const secondHost = spawn(process.execPath, [fileURLToPath(new URL("../src/console/host.ts", import.meta.url)), secondConfig], { stdio: ["ignore", "ignore", "pipe"] });
	let secondError = ""; secondHost.stderr.on("data", (chunk: Buffer) => { secondError += chunk.toString("utf8"); });
	await new Promise((resolve) => secondHost.once("exit", resolve));
	assert.match(secondError, /already owned/);
	const socketMode = (await import("node:fs/promises")).stat(record.socketPath).then((value) => value.mode & 0o777);
	assert.equal(await socketMode, 0o600);
	const first = await connectConsole(record, { requestId: randomUUID(), instanceId, command: "prompt", message: "M01 workflow" });
	assert.equal(first.accepted, true);
	const second = await connectConsole(record, { requestId: randomUUID(), instanceId, command: "get_state" });
	assert.equal(second.ok, true);
	await new Promise((resolve) => setTimeout(resolve, 50));
	const events = await connectConsole(record, { requestId: randomUUID(), instanceId, command: "events" });
	const page = events.data as { events: { sequence: number; value: unknown }[]; nextCursor: number; latestEvent: number };
	assert.ok(page.events.length > 0 && page.events.length < 10);
	assert.ok(page.nextCursor < page.latestEvent);
	const nextPage = await connectConsole(record, { requestId: randomUUID(), instanceId, command: "events", since: page.nextCursor });
	assert.ok((nextPage.data as { events: unknown[] }).events.length > 0);
	assert.doesNotMatch(JSON.stringify(events.data) + JSON.stringify(nextPage.data), /SECRET_THINKING/);
	const wrong = await connectConsole(record, { requestId: randomUUID(), instanceId: randomUUID(), command: "abort" });
	assert.equal(wrong.ok, false);
	const workflowId = randomUUID();
	const submitted = await connectConsole(record, { requestId: workflowId, instanceId, command: "workflow", attemptId: "A001", action: { kind: "status" } });
	assert.equal(submitted.accepted, true);
	const queued = JSON.parse(await readFile(path.join(controlDir, "requests", `${workflowId}.json`), "utf8")) as { action: { kind: string }; workspace: string };
	assert.equal(queued.action.kind, "status");
	assert.equal(queued.workspace, workspace);
	const duplicate = await connectConsole(record, { requestId: workflowId, instanceId, command: "workflow", attemptId: "A001", action: { kind: "status" } });
	assert.deepEqual(duplicate, submitted);
	const changed = await connectConsole(record, { requestId: workflowId, instanceId, command: "workflow", attemptId: "A001", action: { kind: "stage", request: { stage: "M01" } } });
	assert.equal(changed.ok, false);
	const beforeCancellation = await connectConsole(record, { requestId: randomUUID(), instanceId, command: "status" });
	const beforeCancellationCursor = (beforeCancellation.data as { latestEvent: number }).latestEvent;
	const cancellation = await connectConsole(record, { requestId: randomUUID(), instanceId, command: "abort" });
	assert.equal(cancellation.accepted, true);
	assert.equal((JSON.parse(await readFile(path.join(controlDir, "responses", `${workflowId}.cancel.json`), "utf8")) as { cancelled: boolean }).cancelled, true);
	const routed = await connectConsole(record, { requestId: randomUUID(), instanceId, command: "events", since: beforeCancellationCursor });
	assert.match(JSON.stringify(routed.data), /cancel-routed/);
	await writeFile(path.join(controlDir, "responses", `${workflowId}.json`), JSON.stringify({ version: 1, requestId: workflowId, ok: true, data: { kind: "status" } }), { mode: 0o600 });
	const result = await connectConsole(record, { requestId: randomUUID(), instanceId, command: "workflow_result", workflowRequestId: workflowId });
	assert.equal((result.data as { complete: boolean }).complete, true);
	for (let i = 0; i < 20; i++) {
		const status = await connectConsole(record, { requestId: randomUUID(), instanceId, command: "status" });
		if (!(status.data as { busy: boolean }).busy) break;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	const rejectedId = "00000000-0000-4000-8000-00000000dead";
	const rejectedAck = await connectConsole(record, { requestId: rejectedId, instanceId, command: "workflow", attemptId: "A001", action: { kind: "status" } });
	assert.equal(rejectedAck.accepted, true, "socket reply only confirms write to Pi stdin");
	let rejectedResult: { complete?: boolean; result?: { error?: string } } = {};
	for (let i = 0; i < 30; i++) {
		const item = await connectConsole(record, { requestId: randomUUID(), instanceId, command: "workflow_result", workflowRequestId: rejectedId });
		rejectedResult = item.data as typeof rejectedResult;
		if (rejectedResult.complete) break;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	assert.match(rejectedResult.result?.error ?? "", /bridge rejected/);
	const afterRejection = await connectConsole(record, { requestId: randomUUID(), instanceId, command: "status" });
	assert.equal((afterRejection.data as { busy: boolean }).busy, false);
	assert.equal((await listConsoles(workspace))[0]?.instanceId, instanceId);
	process.kill(-piPid, "SIGTERM");
	await new Promise((resolve) => host.once("exit", resolve));
	assert.equal((await listConsoles(workspace))[0]?.state, "exited");
	const restarted = spawn(process.execPath, [fileURLToPath(new URL("../src/console/host.ts", import.meta.url)), secondConfig], { stdio: "ignore" });
	let restartedRecord: ConsoleRecord | undefined;
	for (let i = 0; i < 50; i++) {
		try { const item = JSON.parse(await readFile(path.join(secondDir, "instance.json"), "utf8")) as ConsoleRecord; if (item.state === "running") { restartedRecord = item; break; } } catch {}
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	assert.ok(restartedRecord?.piPid, "new host can start after Pi exit and owner release");
	process.kill(-restartedRecord.piPid, "SIGTERM");
	await new Promise((resolve) => restarted.once("exit", resolve));
	let releaseGate: (() => void) | undefined;
	const gate = new Promise<void>((resolve) => { releaseGate = resolve; });
	let entered: (() => void) | undefined;
	const started = new Promise<void>((resolve) => { entered = resolve; });
	const nestedPromise = withWorkspaceMutationOwnership(workspace, async () => {
		assert.equal(await withWorkspaceMutationOwnership(workspace, async () => "nested"), "nested");
		entered?.();
		await gate;
		return "outer";
	});
	await started;
	await assert.rejects(withWorkspaceMutationOwnership(workspace, async () => "parallel"), /already owned/);
	releaseGate?.();
	assert.equal(await nestedPromise, "outer");
});
