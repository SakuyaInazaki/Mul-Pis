import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { bindConsoleDescriptorToGoal, registerConsoleWorkflowBridge, type ConsoleWorkflowCancelResponse, type ConsoleWorkflowRequest, type ConsoleWorkflowResponse } from "../src/pi/console-bridge.ts";
import type { RunDescriptorV1 } from "../src/runtime/run-descriptor.ts";
import type { ResearchService } from "../src/pi/service.ts";

async function fixture(goalRunId?: string, overrideService: Partial<ResearchService> = {}) {
	const root = await mkdtemp(path.join(tmpdir(), "console-bridge-"));
	const controlDir = path.join(root, "control");
	await mkdir(controlDir, { mode: 0o700 });
	await mkdir(path.join(controlDir, "requests"), { mode: 0o700 });
	await mkdir(path.join(controlDir, "responses"), { mode: 0o700 });
	const identity = { hostId: "test-host", bootId: "test-boot", pid: process.pid, processStartToken: "test-start" };
	const descriptor: RunDescriptorV1 = { version: 1, instanceId: randomUUID(), attemptId: "A001", workspaceId: randomUUID(), ...(goalRunId ? { goalRunId } : {}), codeRevision: "test", controlDir, process: identity };
	const descriptorFile = path.join(controlDir, "run-descriptor.json");
	await writeFile(descriptorFile, JSON.stringify(descriptor), { mode: 0o600 });
	const calls: string[] = [];
	const signals: AbortSignal[] = [];
	const service = {
		runStage: async (request: { stage: string; workspace?: string }, signal: AbortSignal) => { signals.push(signal); calls.push(`stage:${request.stage}:${request.workspace}`); return { record: { runId: "stage-1", stage: request.stage, status: "completed", output: "sensitive body" } }; },
		status: async () => { calls.push("status"); return { stages: {} }; },
		goalStatus: async (runId: string) => { calls.push(`goalStatus:${runId}`); return { runId, lifecycle: "active", plan: "sensitive plan" }; },
		goalAction: async (kind: string, _workspace: string, input: { runId: string }, signal: AbortSignal) => { signals.push(signal); calls.push(`${kind}:${input.runId}`); return { runId: input.runId, lifecycle: "active", plan: "sensitive plan", id: "CP001", feedbackPath: "/evidence" }; },
		...overrideService,
	} as unknown as ResearchService;
	const commands = new Map<string, (args: string, ctx: any) => Promise<void>>();
	const pi = { registerCommand(name: string, command: { handler: (args: string, ctx: any) => Promise<void> }) { commands.set(name, command.handler); } } as unknown as ExtensionAPI;
	registerConsoleWorkflowBridge(pi, { service, getBoundGoalRunId: () => goalRunId, controlDir, descriptorFile, processIdentity: async () => identity });
	async function start(action: ConsoleWorkflowRequest["action"], overrides: Partial<ConsoleWorkflowRequest> = {}, idle = true) {
		const handler = commands.get("workflow-console"); assert.ok(handler);
		const requestId = randomUUID();
		const request: ConsoleWorkflowRequest = { version: 1, requestId, instanceId: descriptor.instanceId, workspaceId: descriptor.workspaceId, workspace: root, attemptId: "A001", ...(goalRunId ? { goalRunId } : {}), action, ...overrides };
		await writeFile(path.join(controlDir, "requests", `${requestId}.json`), JSON.stringify(request), { mode: 0o600 });
		return { requestId, finished: handler(requestId, { cwd: root, isIdle: () => idle }) };
	}
	async function invoke(action: ConsoleWorkflowRequest["action"], overrides: Partial<ConsoleWorkflowRequest> = {}, idle = true): Promise<ConsoleWorkflowResponse> {
		const { requestId, finished } = await start(action, overrides, idle);
		await finished;
		return JSON.parse(await readFile(path.join(controlDir, "responses", `${requestId}.json`), "utf8")) as ConsoleWorkflowResponse;
	}
	async function cancel(requestId: string): Promise<ConsoleWorkflowCancelResponse> {
		const handler = commands.get("workflow-console-cancel"); assert.ok(handler);
		await handler(requestId, { cwd: root, isIdle: () => true });
		return JSON.parse(await readFile(path.join(controlDir, "responses", `${requestId}.cancel.json`), "utf8")) as ConsoleWorkflowCancelResponse;
	}
	return { root, controlDir, descriptorFile, descriptor, identity, calls, signals, start, invoke, cancel, registered: commands.has("workflow-console") && commands.has("workflow-console-cancel") };
}

test("bridge is absent without a verified control directory", () => {
	let registered = false;
	registerConsoleWorkflowBridge({ registerCommand() { registered = true; } } as unknown as ExtensionAPI, { service: {} as ResearchService, getBoundGoalRunId: () => undefined, controlDir: "/missing", descriptorFile: "/missing/run-descriptor.json" });
	assert.equal(registered, false);
});

test("bridge executes a bounded stage and returns only metadata", async () => {
	const f = await fixture();
	assert.equal(f.registered, true);
	const receipt = await f.invoke({ kind: "stage", request: { stage: "M01" } });
	assert.equal(receipt.ok, true);
	assert.deepEqual(receipt.data, { kind: "stage", runId: "stage-1", stage: "M01", status: "completed" });
	assert.deepEqual(f.calls, [`stage:M01:${f.root}`]);
	const status = await f.invoke({ kind: "status", runId: "G-read-only" });
	assert.deepEqual(status.data, { kind: "status", runId: "G-read-only", lifecycle: "active" });
	assert.deepEqual(f.calls, [`stage:M01:${f.root}`, "goalStatus:G-read-only"]);
});

test("bridge rejects mismatched identities, busy execution, and forbidden actions", async () => {
	const f = await fixture("G1");
	assert.equal((await f.invoke({ kind: "checkpoint", runId: "G1" }, { attemptId: "A002" })).ok, false);
	assert.equal((await f.invoke({ kind: "stage", request: { stage: "M01" } }, {}, false)).ok, false);
	assert.equal((await f.invoke({ kind: "stage", request: { stage: "M07" } } as any)).ok, false);
	assert.equal((await f.invoke({ kind: "begin" } as any)).ok, false);
	assert.equal((await f.invoke({ kind: "stage", request: { stage: "M08", workspace: "/other" } as any })).ok, false);
	assert.equal((await f.invoke({ kind: "stage", request: { stage: "M08", reviewers: [{ id: "R1", role: "improver" }] } as any })).ok, false);
	assert.deepEqual(f.calls, []);
});

test("bridge accepts the structured M08 review parameters used by research_stage", async () => {
	const f = await fixture();
	const response = await f.invoke({ kind: "stage", request: {
		stage: "M08", materials: [{ label: "report", path: "report.md", sourceCategory: "result" }],
		selfChecks: [{ id: "S1", instruction: "check scope", mode: "read-only" }],
		reviewers: [{ id: "R1", role: "reviewer", mode: "read-only" }],
		unprovidedScopes: [], processFeedback: false,
	} });
	assert.equal(response.ok, true);
	assert.deepEqual(f.calls, [`stage:M08:${f.root}`]);
});

test("bridge binds goal changes and omits goal body from response", async () => {
	const f = await fixture("G1");
	const wrong = await f.invoke({ kind: "plan", runId: "G2", plan: "wrong" });
	assert.equal(wrong.ok, false);
	const receipt = await f.invoke({ kind: "plan", runId: "G1", plan: "next" });
	assert.deepEqual(receipt.data, { kind: "plan", runId: "G1", lifecycle: "active" });
	assert.deepEqual(f.calls, ["plan:G1"]);
	assert.equal(f.signals.length, 1);
	assert.equal(f.signals[0].aborted, false);
});

test("cancel command aborts the active stage signal and final workflow receipt records failure", async () => {
	let started!: () => void;
	const begun = new Promise<void>(resolve => { started = resolve; });
	let observedSignal: AbortSignal | undefined;
	const f = await fixture(undefined, { runStage: async (_request, signal) => {
		observedSignal = signal;
		started();
		return await new Promise<never>((_resolve, reject) => signal!.addEventListener("abort", () => reject(new Error("stage interrupted by signal")), { once: true }));
	} });
	const { requestId, finished } = await f.start({ kind: "stage", request: { stage: "M01" } });
	await begun;
	const cancel = await f.cancel(requestId);
	assert.deepEqual(cancel, { version: 1, requestId, ok: true, cancelled: true });
	assert.equal(observedSignal?.aborted, true);
	await finished;
	const final = JSON.parse(await readFile(path.join(f.controlDir, "responses", `${requestId}.json`), "utf8")) as ConsoleWorkflowResponse;
	assert.equal(final.ok, false);
	assert.match(final.error ?? "", /interrupted by signal/);
	assert.equal((await stat(path.join(f.controlDir, "responses", `${requestId}.cancel.json`))).mode & 0o777, 0o600);
});

test("new goal binding updates only the console descriptor after matching the process", async () => {
	const f = await fixture();
	const goal = { runId: "G1", executionState: { activeAttemptId: "A001", attempts: [{ id: "A001", runDescriptor: { ...f.descriptor, workspaceId: randomUUID(), goalRunId: "G1", controlDir: path.join(f.root, "stages", "M07", "G1") } }] } };
	await bindConsoleDescriptorToGoal(goal as any, { controlDir: f.controlDir, descriptorFile: f.descriptorFile, processIdentity: async () => f.identity });
	const updated = JSON.parse(await readFile(f.descriptorFile, "utf8")) as RunDescriptorV1;
	assert.equal(updated.goalRunId, "G1");
	assert.equal(updated.workspaceId, f.descriptor.workspaceId);
	assert.equal(updated.controlDir, f.controlDir);
	assert.equal((await stat(f.descriptorFile)).mode & 0o777, 0o600);
});
