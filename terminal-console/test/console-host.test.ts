import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { parseConsoleRequest, type ConsoleRecord } from "../src/console/protocol.ts";
import { boundConsoleRecord } from "../src/console/host.ts";
import { recoveryIdentity, type PiBootstrap } from "../src/console/pi-process.ts";
import { resolveConsoleStartExtension } from "../src/console/client.ts";
import { parseConsoleArgs } from "../src/console/cli.ts";
import { resolveConsoleHostExtension } from "../src/console/source.ts";
import { acquireConsoleWorkspaceOwner } from "../../src/console/ownership.ts";
import { readCurrentProcessIdentity } from "../../src/runtime/process-identity.ts";

test("console protocol rejects arbitrary RPC and malformed targets", () => {
	assert.throws(() => parseConsoleRequest({ requestId: "x", instanceId: "i", command: "bash" }), /invalid console request/);
	assert.throws(() => parseConsoleRequest({ requestId: "x", instanceId: "i", command: "events", since: -1 }), /cursor/);
});

test("console record follows the verified descriptor attempt", () => {
	const record = { goalRunId: "goal", attemptId: "A001" } as ConsoleRecord;
	assert.equal(boundConsoleRecord(record, { goalRunId: "goal", attemptId: "A002" }).attemptId, "A002");
	assert.equal(boundConsoleRecord({ ...record, goalRunId: undefined, attemptId: undefined }, { attemptId: "A001" }).attemptId, "A001");
});

test("host extension CLI entry is canonical, source-bound and reused by console recovery", async (t) => {
	const workspace = await realpath(await mkdtemp(path.join(tmpdir(), "workflow-console-extension-")));
	t.after(() => rm(workspace, { recursive: true, force: true }));
	const standard = path.join(workspace, "extensions", "research.ts");
	const wrapper = path.join(workspace, "extensions", "local-wrapper.ts");
	const externalWrapper = path.join(workspace, "local-wrapper.ts");
	await mkdir(path.dirname(standard), { recursive: true });
	await writeFile(standard, "export {};\n");
	await writeFile(wrapper, "export {};\n");
	await writeFile(externalWrapper, "export {};\n");
	const source = { mode: "builtin" as const, root: workspace, revision: "f".repeat(40), dirty: false };
	assert.equal(parseConsoleArgs(["start", "--host-extension", wrapper]).flags.get("host-extension"), wrapper);
	assert.equal(await resolveConsoleStartExtension(workspace, source, wrapper), wrapper);
	assert.equal(await resolveConsoleStartExtension(workspace, source, externalWrapper), externalWrapper);
	const privateDescriptorFile = path.join(workspace, "old-private-descriptor.json");
	await writeFile(privateDescriptorFile, "{}\n");
	await assert.rejects(resolveConsoleStartExtension(workspace, source, externalWrapper, privateDescriptorFile), /outside the revision-bound source/);
	const instanceId = randomUUID();
	const controlDir = path.join(workspace, ".agent", "console", "instances", instanceId);
	const oldDescriptorFile = path.join(controlDir, "run-descriptor.json");
	await mkdir(controlDir, { recursive: true });
	await writeFile(oldDescriptorFile, "{}\n");
	await writeFile(path.join(controlDir, "instance.json"), JSON.stringify({ version: 1, instanceId, workspace,
		controlDir, descriptorFile: oldDescriptorFile, source, hostExtensionFile: wrapper }));
	assert.equal(await resolveConsoleStartExtension(workspace, source, undefined, oldDescriptorFile), wrapper);
	await assert.rejects(resolveConsoleStartExtension(workspace, source, standard, oldDescriptorFile), /reuse the old console host extension/);
	await assert.rejects(resolveConsoleHostExtension({ mode: "active-prepared", root: path.join(workspace, "prepared"), revision: "f".repeat(40) }, wrapper), /inside a verified source directory/);
});

test("recovery keeps the persisted workspace identity and rejects a changed code source", async (t) => {
	const identity = await readCurrentProcessIdentity().catch(() => undefined);
	if (!identity) { t.skip("precise process identity is unavailable"); return; }
	const workspace = await realpath(await mkdtemp(path.join(tmpdir(), "workflow-console-recovery-")));
	t.after(() => rm(workspace, { recursive: true, force: true }));
	const goalRunId = "20261014T000000Z-abcd";
	const goalDir = path.join(workspace, "stages", "M07", goalRunId);
	await mkdir(goalDir, { recursive: true });
	const revision = "f".repeat(40);
	const prior = { version: 1, instanceId: randomUUID(), attemptId: "A001", workspaceId: randomUUID(), goalRunId,
		codeRevision: `builtin:${revision}`, controlDir: goalDir, process: identity };
	await writeFile(path.join(goalDir, "goal.json"), JSON.stringify({ runId: goalRunId, lifecycle: "active",
		executionState: { activeAttemptId: "A001", attempts: [{ id: "A001", runDescriptor: prior }] } }));
	const oldDescriptorFile = path.join(workspace, "old-descriptor.json");
	await writeFile(oldDescriptorFile, JSON.stringify(prior));
	const config: PiBootstrap = { workspace, instanceId: randomUUID(), controlDir: goalDir, cliFile: "unused", extensionFile: "unused",
		model: "configured/model", source: { mode: "builtin", root: workspace, revision, dirty: false }, goalRunId, recover: true, oldDescriptorFile };
	const result = await recoveryIdentity(config);
	assert.equal(result.workspaceId, prior.workspaceId);
	assert.equal(result.attemptId, "A002");
	await assert.rejects(recoveryIdentity({ ...config, source: { ...config.source, revision: "e".repeat(40) } }), /source differs/);
	await assert.rejects(recoveryIdentity({ ...config, source: { ...config.source, dirty: true } }), /dirty builtin source/);
});

test("console owner rejects an active independent M07 attempt and an unversioned active goal", async (t) => {
	const identity = await readCurrentProcessIdentity().catch(() => undefined);
	if (!identity) { t.skip("precise process identity is unavailable"); return; }
	const workspace = await realpath(await mkdtemp(path.join(tmpdir(), "workflow-console-owner-")));
	t.after(() => rm(workspace, { recursive: true, force: true }));
	const goalDir = path.join(workspace, "stages", "M07", "goal");
	await mkdir(goalDir, { recursive: true });
	const file = path.join(goalDir, "goal.json");
	const descriptor = { version: 1, instanceId: randomUUID(), attemptId: "A001", workspaceId: randomUUID(), goalRunId: "goal",
		codeRevision: "test", controlDir: goalDir, process: identity };
	await writeFile(file, JSON.stringify({ lifecycle: "active", executionState: { activeAttemptId: "A001",
		attempts: [{ id: "A001", runDescriptor: descriptor }] } }));
	await assert.rejects(acquireConsoleWorkspaceOwner(workspace, randomUUID()), /running attempt/);
	await writeFile(file, JSON.stringify({ lifecycle: "active" }));
	await assert.rejects(acquireConsoleWorkspaceOwner(workspace, randomUUID()), /active legacy M07 goal/);
	await writeFile(file, JSON.stringify({ lifecycle: "finished" }));
	const release = await acquireConsoleWorkspaceOwner(workspace, randomUUID());
	await release();
});
