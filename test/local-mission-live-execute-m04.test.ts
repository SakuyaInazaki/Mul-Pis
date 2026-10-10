import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { createAgentSession, ModelRuntime, type CreateAgentSessionOptions } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { createFileKnowledgeStore } from "../src/knowledge/store.ts";
import { registerTrustedLocalMissionEvaluator } from "../src/m07/local-mission-evaluator.ts";
import { openDefaultLocalMission } from "../src/m07/local-mission.ts";
import { FakeSessionRunner } from "../src/runner/fake.ts";
import { PiSessionRunner } from "../src/runner/pi.ts";
import { readManagedBashReceipt } from "../src/runner/managed-bash.ts";
import type { ReadReturnEvent, SessionRunner } from "../src/runner/types.ts";
import { runInit } from "../src/stages/init.ts";
import { Workspace } from "../src/workspace.ts";

const model = { id: "offline-model", name: "Offline model", api: "anthropic-messages",
	provider: "offline", baseUrl: "https://invalid.example", reasoning: false,
	input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 100_000, maxTokens: 4_000 } as Model<"anthropic-messages">;
const modelRuntime = { getModels: () => [model] } as unknown as ModelRuntime;
const lineCount = (bytes: Buffer) => bytes.toString("utf8").split("\n").length -
	Number(bytes.toString("utf8").endsWith("\n"));

async function readEvents(root: string, toolName: string): Promise<ReadReturnEvent[]> {
	const events: ReadReturnEvent[] = [];
	async function visit(dir: string): Promise<void> {
		for (const name of await readdir(dir)) {
			const file = path.join(dir, name);
			if ((await stat(file)).isDirectory()) { await visit(file); continue; }
			const bytes = await readFile(file);
			if (bytes.length) events.push({ toolName, status: "returned",
				path: path.relative(root, file).replaceAll("\\", "/"), requested: {},
				returned: { kind: "text", startLine: 1, endLine: lineCount(bytes), truncated: false },
				at: new Date().toISOString() });
		}
	}
	await visit(root);
	return events;
}

async function activeGroupMembers(pgid: number): Promise<number[]> {
	const members: number[] = [];
	for (const name of await readdir("/proc")) {
		if (!/^\d+$/.test(name)) continue;
		let value: string;
		try { value = await readFile(path.join("/proc", name, "stat"), "utf8"); }
		catch (error) { if (["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) continue; throw error; }
		const fields = value.slice(value.lastIndexOf(")") + 2).trim().split(/\s+/);
		if (Number(fields[2]) === pgid && !["Z", "X", "x"].includes(fields[0]!))
			members.push(Number(name));
	}
	return members;
}

for (const scenario of ["foreground", "background", "unknown-operation", "result-before-call",
	"duplicate-call", "orphan-result", "ancestor-session"] as const)
test(`live returned execute task ${scenario} after failed M04`, async t => {
	const background = scenario === "background";
	const evaluatorId = `test:live-execute-m04-${scenario}`;
	registerTrustedLocalMissionEvaluator({ id: evaluatorId, version: "1",
		supportedObligationTypes: ["synthetic-open"],
		async preflight() { return { available: true }; },
		async evaluate({ contract, observationOutputDir }) {
			const name = "observation-execute.txt";
			await writeFile(path.join(observationOutputDir, name), "The bounded task did not close the original.\n",
				{ mode: 0o600 });
			return { checks: contract.obligations.map(item => ({ obligationId: item.id,
				result: "not_run" as const, evidenceRefs: [name], limitations: ["Unselected"] })),
				observations: [{ name, kind: "text" }], limitations: ["Unselected"] };
		} });
	const root = await mkdtemp(path.join(os.tmpdir(), "local-execute-m04-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	let backgroundGroup: number | undefined;
	t.after(async () => {
		if (!backgroundGroup) return;
		try { process.kill(-backgroundGroup, "SIGKILL"); }
		catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
		for (let attempt = 0; attempt < 100; attempt++) {
			if (!(await activeGroupMembers(backgroundGroup)).length) return;
			await delay(20);
		}
		assert.fail("managed Bash background process did not terminate after test cleanup");
	});
	const ws = new Workspace(root);
	await mkdir(path.dirname(ws.problemFile), { recursive: true });
	await writeFile(ws.problemFile, "Synthetic original question remains open.\n");
	await runInit(ws, createFileKnowledgeStore(ws.knowledgeDir));
	let missionId = "", assessorCalls = 0, builderCalls = 0, m04Calls = 0;
	let failedEvidence = "";
	const refs = [{ sourceId: "original-problem.txt", startLine: 1, endLine: 1 }];
	const issue = { id: "open-question", claim: "Original question remains open", status: "open",
		classification: "explicit-requirement", sourceRefs: refs,
		implication: "Another bounded task could supply distinct evidence" };
	const fake = new FakeSessionRunner(async ({ spec }) => {
		if (spec.label.startsWith("local-original-objective-")) {
			assessorCalls++;
			if (scenario === "foreground" && assessorCalls > 6)
				throw new DOMException("Synthetic stop after repeated blocked verdicts", "AbortError");
			assert.equal(spec.tools.kind, "read-dir");
			if (spec.tools.kind !== "read-dir") throw new Error("assessor lacks read grant");
			const iteration = Number(spec.label.match(/-(\d+)$/)?.[1]);
			if (iteration === 2) {
				failedEvidence = await readFile(path.join(spec.tools.root,
					"prior-run-1-m04-failure-1.txt"), "utf8");
				assert.match(failedEvidence, /synthetic M04 read failure/);
			}
			const decision = iteration <= 2 ? "continue" : "blocked";
			return { text: JSON.stringify({ version: 1, decision,
				rationale: "The original criterion remains open.",
				evidenceRefs: iteration === 1 ? ["original-problem.txt"] :
					[iteration === 2 ? "prior-run-1-m04-failure-1.txt" : "prior-run-2-feedback-1.txt"],
				unresolvedObligations: ["answer"], unresolvedDetails: [issue.claim],
				groundedAssessment: { version: 1, kind: "grounded-assessment-proposal",
					contractId: missionId, missionStatus: "open", issues: [issue],
					legacyOpenDetails: iteration === 1 ? [] : [issue.claim],
					...(decision === "continue" ? { nextTask: {
						objective: iteration === 1 ? "Test avenue one" : "Test avenue two",
						obligationIds: ["answer"], addresses: [issue.id], adapterScope: "local-m07-execute",
						decisionChangingHypothesis: iteration === 1 ? "Avenue one may answer" :
							"Avenue two may answer after the failed read",
						expectedEvidence: "A distinct reviewed local result", sourceRefs: refs } } : {}) } }),
				readReturns: await readEvents(spec.tools.root, "objective_evidence_read") };
		}
		if (spec.label === "M04-research") {
			m04Calls++;
			if (m04Calls === 1) {
				if (scenario === "unknown-operation") {
					const id = (await ws.listRuns("M07"))[0]!;
					const file = path.join(ws.runDir("M07", id), "goal.json");
					const goal = JSON.parse(await readFile(file, "utf8")) as {
					executionState: { operations: Array<{ status: string }> } };
					goal.executionState.operations[0]!.status = "unknown";
					await writeFile(file, `${JSON.stringify(goal, null, 2)}\n`);
				}
				if (["result-before-call", "duplicate-call", "orphan-result", "ancestor-session"]
					.includes(scenario)) {
					const id = (await ws.listRuns("M07"))[0]!;
					const goal = JSON.parse(await readFile(path.join(ws.runDir("M07", id),
						"goal.json"), "utf8")) as { tasks: Array<{ session?: { file?: string } }> };
					const sessionFile = goal.tasks[0]?.session?.file;
					assert(sessionFile);
					const rows = (await readFile(sessionFile, "utf8")).trimEnd().split("\n");
					if (scenario === "ancestor-session") {
						const header = JSON.parse(rows[0]!) as { parentSession?: string };
						header.parentSession = "synthetic-ancestor";
						rows[0] = JSON.stringify(header);
					} else {
						const callIndex = rows.findIndex(row => row.includes('"type":"toolCall"'));
						const resultIndex = rows.findIndex(row => row.includes('"role":"toolResult"'));
						assert(callIndex > 0 && resultIndex > callIndex);
						if (scenario === "result-before-call")
							[rows[callIndex], rows[resultIndex]] = [rows[resultIndex]!, rows[callIndex]!];
						else if (scenario === "duplicate-call") rows.splice(resultIndex, 0, rows[callIndex]!);
						else rows.splice(resultIndex, 0, JSON.stringify({ type: "message", message: {
							role: "toolResult", toolCallId: "synthetic-orphan", isError: false } }));
					}
					await writeFile(sessionFile, `${rows.join("\n")}\n`);
				}
				throw new Error("synthetic M04 read failure");
			}
			assert.equal(spec.tools.kind, "read-dir");
			if (spec.tools.kind !== "read-dir") throw new Error("M04 lacks read grant");
			return { text: "Second bounded result remained unselected; no proposal.",
				readReturns: await readEvents(spec.tools.root, "m07_evidence_read") };
		}
		throw new Error(`unexpected fake session ${spec.label}`);
	});
	const factory = (async (options: CreateAgentSessionOptions = {}) => {
		const manager = options.sessionManager!;
		const messages: unknown[] = [];
		const session = { sessionId: manager.getSessionId(), sessionFile: manager.getSessionFile(), messages,
			getActiveToolNames: () => [...(options.tools ?? [])],
			async prompt(message: string) {
				builderCalls++;
				const user = { role: "user", content: message, timestamp: Date.now() };
				messages.push(user); manager.appendMessage(user as never);
				const bash = options.customTools?.find(tool => tool.name === "bash");
				assert(bash);
				const compileRun = "mkdir -p deliverable && printf '#include <cstdio>\\nint main(){std::puts(\"offline result\");}\\n' > deliverable/program.cpp && c++ -std=c++17 deliverable/program.cpp -o deliverable/program && ./deliverable/program > deliverable/result.txt";
				const command = background ? `${compileRun}; sleep 30 &` : compileRun;
				const callId = `bash-call-${builderCalls}`;
				const call = { role: "assistant", content: [{ type: "toolCall", id: callId,
					name: "bash", arguments: { command } }], timestamp: Date.now() };
				messages.push(call); manager.appendMessage(call as never);
				const result = await bash.execute(callId, { command }, undefined, undefined,
					{ cwd: options.cwd } as never);
				const toolResult = { role: "toolResult", toolCallId: callId, toolName: "bash",
					isError: (result as { isError?: boolean }).isError === true,
					content: result.content, timestamp: Date.now() };
				messages.push(toolResult); manager.appendMessage(toolResult as never);
				const read = options.customTools?.find(tool => tool.name === "read");
				assert(read);
				const readId = `read-call-${builderCalls}`;
				const readCall = { role: "assistant", content: [{ type: "toolCall", id: readId,
					name: "read", arguments: { path: "deliverable/result.txt" } }], timestamp: Date.now() };
				messages.push(readCall); manager.appendMessage(readCall as never);
				const readResult = await read.execute(readId, { path: "deliverable/result.txt" },
					undefined, undefined, { cwd: options.cwd } as never);
				const readToolResult = { role: "toolResult", toolCallId: readId, toolName: "read",
					isError: (readResult as { isError?: boolean }).isError === true,
					content: readResult.content, timestamp: Date.now() };
				messages.push(readToolResult); manager.appendMessage(readToolResult as never);
				const answer = { role: "assistant", api: model.api, provider: model.provider,
					model: model.id, timestamp: Date.now(), stopReason: "stop",
					content: [{ type: "text", text: `Bounded report ${builderCalls}` }],
					usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
				messages.push(answer); manager.appendMessage(answer as never);
			}, abort() {}, dispose() {} };
		return { session } as unknown as Awaited<ReturnType<typeof createAgentSession>>;
	}) as typeof createAgentSession;
	const pi = new PiSessionRunner({ modelRuntime, createSession: factory });
	const runner: SessionRunner = { create: spec => spec.label.startsWith("M07-") ?
		pi.create(spec) : fake.create(spec),
		resume: ref => ref.label.startsWith("M07-") ? pi.resume(ref) : fake.resume(ref),
		capabilities: () => pi.capabilities(),
		checkpoint: (handle, envelope) => pi.checkpoint(handle, envelope),
		estimateMaxSdkCost: (modelRaw, caps) => fake.estimateMaxSdkCost(modelRaw, caps) };
	const mission = openDefaultLocalMission({ workspaceRoot: root, runner,
		config: { roles: { research: "offline/offline-model", execution: "offline/offline-model" },
			localMission: { evaluatorId, execution: "task-root-bash" },
			concurrency: 1, tools: {} } });
	const begun = await mission.begin({ version: 1, kind: "local-original-objective-request",
		goal: "Answer original question", goalSource: "verbatim-private-input",
		obligations: [{ id: "answer", description: "Resolve original question", type: "synthetic-open" }],
		closure: "open-ended" });
	missionId = begun.contract.id;
	if (scenario !== "foreground") {
		await assert.rejects(mission.run(missionId));
		const progress = await mission.status(missionId);
		assert.equal(progress.stopReason, "execution-interrupted");
		assert.equal(progress.boundedRuns.length, 0);
		assert.equal(builderCalls, 1);
		assert.equal(m04Calls, 1);
		assert.equal(assessorCalls, 1);
		const goal = JSON.parse(await readFile(path.join(ws.runDir("M07",
			(await ws.listRuns("M07"))[0]!), "goal.json"), "utf8")) as {
			tasks: Array<{ toolLog: Array<{ hostReceiptPath?: string }> }> };
		if (background) {
			const receipt = await readManagedBashReceipt(goal.tasks[0]!.toolLog[0]!.hostReceiptPath!);
			assert.equal(receipt.groupObservation, "members-observed");
			backgroundGroup = receipt.processGroupId ?? undefined;
			assert(backgroundGroup);
			assert((await activeGroupMembers(backgroundGroup)).length > 0);
		} else {
			if (scenario === "unknown-operation") {
				const goalState = JSON.parse(await readFile(path.join(ws.runDir("M07",
					(await ws.listRuns("M07"))[0]!), "goal.json"), "utf8")) as {
						executionState: { operations: Array<{ status: string }> } };
				assert.equal(goalState.executionState.operations[0]?.status, "unknown");
			}
		}
		assert.equal((await mission.step(missionId)).stopReason, "execution-interrupted");
		assert.equal(builderCalls, 1);
	} else {
		const progress = await mission.run(missionId);
		assert.equal(progress.stopReason, "cancelled");
		assert.equal(builderCalls, 2);
		assert.equal(m04Calls, 2);
		assert(assessorCalls >= 3);
		assert.equal(progress.boundedRuns.length, 2);
		assert(progress.boundedRuns[0]?.failedM04RunId);
		assert.notEqual(progress.boundedRuns[0]?.runId, progress.boundedRuns[1]?.runId);
		assert.deepEqual(progress.selectedArtifacts, []);
		assert.match(failedEvidence, /"selected": false/);
	}
});
