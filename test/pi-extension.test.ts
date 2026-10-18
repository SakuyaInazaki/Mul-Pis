import assert from "node:assert/strict";
import { mkdtemp, realpath, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { DefaultResourceLoader, SettingsManager, type ExtensionAPI, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createResearchExtension } from "../src/pi/extension.ts";
import { ResearchService } from "../src/pi/service.ts";
import { FakeSessionRunner } from "../src/runner/fake.ts";
import type { CurrentGoal } from "../src/m07/types.ts";
import { openSearchEventLog } from "../src/m07/search-state/index.ts";

function captureExtension(service: ResearchService, improvementServiceFactory?: (workspaceRoot: string) => any, researchImprovementServiceFactory?: (workspaceRoot: string) => any, continuation?: { workspace: string; goalRunId?: string }): { tools: Map<string, ToolDefinition>; commands: Map<string, { handler: (args: string, ctx: any) => Promise<void> }>; handlers: Map<string, Array<(event: any, ctx: any) => unknown>>; activeTools: () => string[] } {
	const tools = new Map<string, ToolDefinition>();
	const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
	const handlers = new Map<string, Array<(event: any, ctx: any) => unknown>>();
	let activeTools = ["read", "bash", "edit", "write"];
	const api = {
		on(name: string, handler: (event: any, ctx: any) => unknown) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
		registerTool(tool: ToolDefinition) { tools.set(tool.name, tool); activeTools.push(tool.name); },
		registerCommand(name: string, command: { handler: (args: string, ctx: any) => Promise<void> }) { commands.set(name, command); },
		getActiveTools() { return [...activeTools]; },
		setActiveTools(names: string[]) { activeTools = [...names]; },
	} as unknown as ExtensionAPI;
	createResearchExtension({ service, improvementServiceFactory, researchImprovementServiceFactory, continuation })(api);
	return { tools, commands, handlers, activeTools: () => [...activeTools] };
}

function toolContext(cwd: string): any { return { cwd }; }

test("research_mission routes local controls and returns only a compact status", async () => {
	const calls: string[] = [];
	const progress = { contract: { id: "local-id", goal: "private original goal" },
		objectiveOutcome: "incomplete", stopReason: "next-task-pending", boundedRuns: [],
		continuation: { unresolvedOperationIds: ["private-operation"],
			pendingAction: { kind: "reconcile-m07-operation", safety: "no-replay-until-reconciled" } } };
	const service = { missionStatus: async (id: string) => { calls.push(`status:${id}`); return progress; },
		missionStart: async () => { calls.push("start"); return progress; },
		missionAdvance: async (action: string, id: string) => { calls.push(`${action}:${id}`); return progress; } } as unknown as ResearchService;
	const tool = captureExtension(service).tools.get("research_mission")!;
	const status = JSON.stringify(await tool.execute("status", { action: "status", missionId: "local-id" },
		undefined, undefined, toolContext("/workspace")));
	assert.match(status, /reconcile-m07-operation/);
	assert.doesNotMatch(status, /private original goal|private-operation/);
	await tool.execute("step", { action: "step", missionId: "local-id" },
		undefined, undefined, toolContext("/workspace"));
	assert.deepEqual(calls, ["status:local-id", "step:local-id"]);
});

test("research_goal status pages every historical task while keeping the default response recent", async t => {
	const root = await realpath(await mkdtemp(path.join(tmpdir(), "goal-status-candidates-")));
	t.after(() => rm(root, { recursive: true, force: true }));
	for (let index = 0; index < 21; index++) {
		await mkdir(path.join(root, String(index)), { recursive: true });
		await Promise.all(["kernel.cpp", "result.json", "observation.json"].map(file => writeFile(path.join(root, String(index), file), "frozen")));
	}
	const tasks = Array.from({ length: 21 }, (_, index) => ({ taskId: `T${String(index + 1).padStart(3, "0")}`,
		status: "accepted", mode: "execute", objective: `Historical objective ${index + 1}`,
		workDir: path.join(root, String(index), "work"),
		subjectId: `subject:${index + 1}`,
		checks: [`Original task check ${index + 1}`],
		episode: { candidates: [{ id: "C001", intent: "solution", sourcePaths: ["kernel.cpp"], receiptPaths: ["result.json"],
			observationPath: path.join(root, String(index), "observation.json"), observation: { sourceBinding: "verified", correctness: "passed",
				verifier: { id: "offline", version: "1" },
				stage: "evaluated", metrics: [{ name: "score", unit: "points", basisId: `basis-${index}`, direction: "higher", value: index }],
				executionFacts: { evaluations: [{ externalId: `evaluation-${index}`, subjectId: `subject:${index + 1}`, terminal: true, diagnostics: [],
					cases: Array.from({ length: 4 }, (_, caseIndex) => ({ caseId: `case-${caseIndex}`, correctness: "passed", metrics: [{ name: "time", unit: "s", basisId: `basis-${index}`, direction: "lower", value: 1 }] })) }] },
				sourceFiles: [path.join(root, String(index), "kernel.cpp")], receiptFiles: [path.join(root, String(index), "result.json")] } }], incumbents: [] } }));
	const goal = { runId: "goal-history", lifecycle: "active", goal: "Original goal", constraints: ["Frozen constraint"],
		successCriteria: ["Original criterion"], tasks, decisions: [], branchSelections: [] } as unknown as CurrentGoal;
	const service = { goalStatus: async () => goal } as unknown as ResearchService;
	const tool = captureExtension(service).tools.get("research_goal")!;
	const read = async (args: Record<string, unknown>) => {
		const returned = await tool.execute("status", { action: "status", runId: goal.runId, ...args },
			undefined, undefined, toolContext("/workspace"));
		return JSON.parse((returned.content[0] as { text: string }).text) as {
			taskCount: number; tasks: Array<{ taskId: string; subjectId: string; checks: string[] }>; taskPage: { total: number; offset: number | null; nextOffset: number | null };
			taskDetail?: { objective: string; checks: string[] }; goal: string;
			candidateArchive: { bestObservedCount: number; bestObserved: unknown[]; bestNextOffset: number | null; unavailableCount: number;
				searchBrief: { focus: { subjectId: string; basisId?: string }; nextOffset: number | null;
					readLeads: { tool: string; args: Record<string, unknown> }; leads: Array<{ candidateRefs: string[] }>;
					repeatedSourceObservationCount: number; repeatedSourceObservations: Array<{ metric: { name: string }; count: number; min: number; median: number; max: number; candidateRefs: string[]; measurements?: unknown[] }>;
					readRepeatedSourceObservations: { tool: string; args: Record<string, unknown> } | null } };
		};
	};
	const first = await read({});
	assert.equal(first.goal, "Original goal");
	assert.equal(first.taskCount, 21);
	assert.equal(first.taskPage.total, 21);
	assert.equal(first.taskPage.nextOffset, 8);
	assert.equal(first.candidateArchive.bestObservedCount, 21);
	assert.equal(first.candidateArchive.bestObserved.length, 8);
	assert.equal(first.candidateArchive.bestNextOffset, 8);
	assert.deepEqual(first.candidateArchive.searchBrief.focus, { subjectId: "subject:21" });
	assert.deepEqual(first.candidateArchive.searchBrief.leads[0].candidateRefs, ["T021/C001"]);
	assert.equal(first.candidateArchive.searchBrief.nextOffset, 3);
	assert.equal(first.candidateArchive.searchBrief.readLeads.tool, "research_goal");
	const remainingLeads = await read(first.candidateArchive.searchBrief.readLeads.args);
	assert.equal(remainingLeads.candidateArchive.searchBrief.leads.length, 1);
	assert.equal(remainingLeads.candidateArchive.searchBrief.nextOffset, null);
	assert.deepEqual(first.tasks.map(task => task.taskId), tasks.slice(-8).reverse().map(task => task.taskId));
	assert.deepEqual(first.tasks[0]?.checks, tasks.at(-1)?.checks);
	assert.equal(first.tasks[0]?.subjectId, tasks.at(-1)?.subjectId);
	const second = await read({ taskOffset: first.taskPage.nextOffset });
	const third = await read({ taskOffset: second.taskPage.nextOffset });
	assert.equal(third.taskPage.nextOffset, null);
	assert.deepEqual([...first.tasks, ...second.tasks, ...third.tasks].map(task => task.taskId),
		tasks.slice().reverse().map(task => task.taskId));
	const exact = await read({ taskId: "T002" });
	assert.deepEqual(exact.tasks.map(task => task.taskId), ["T002"]);
	assert.equal(exact.taskDetail?.objective, "Historical objective 2");
	assert.deepEqual(exact.tasks[0]?.checks, tasks[1].checks);
	assert.equal(exact.tasks[0]?.subjectId, tasks[1].subjectId);
	assert.deepEqual(exact.taskDetail?.checks, tasks[1].checks);
	const lastBest = await read({ bestOffset: 16 });
	assert.equal(lastBest.candidateArchive.bestObserved.length, 5);
	assert.equal(lastBest.candidateArchive.bestNextOffset, null);
	const last = tasks.at(-1)!.episode.candidates[0];
	const repeatedCandidate = structuredClone(last);
	repeatedCandidate.id = "C002";
	repeatedCandidate.observation.metrics[0].value = 21;
	repeatedCandidate.observation.executionFacts.evaluations[0].externalId = "evaluation-20-repeat";
	for (const observedCase of repeatedCandidate.observation.executionFacts.evaluations[0].cases) observedCase.metrics[0].value = 2;
	tasks.at(-1)!.episode.candidates.push(repeatedCandidate);
	const repeatedStatus = await read({});
	assert.equal(repeatedStatus.candidateArchive.searchBrief.repeatedSourceObservationCount, 5);
	assert.equal(repeatedStatus.candidateArchive.searchBrief.repeatedSourceObservations.length, 3);
	assert.equal(repeatedStatus.candidateArchive.searchBrief.repeatedSourceObservations[0].measurements, undefined, "default status is a short summary");
	assert.deepEqual(repeatedStatus.candidateArchive.searchBrief.repeatedSourceObservations[0].candidateRefs, ["T021/C001", "T021/C002"]);
	const scoreSummary = repeatedStatus.candidateArchive.searchBrief.repeatedSourceObservations.find(item => item.metric.name === "score");
	assert.deepEqual(scoreSummary && [scoreSummary.min, scoreSummary.median, scoreSummary.max], [20, 20.5, 21]);
	assert.equal(repeatedStatus.candidateArchive.searchBrief.readRepeatedSourceObservations?.tool, "research_goal");
	const repeatedPage = await read({ section: "repeated-source", repeatedLimit: 2 }) as unknown as {
		section: string; total: number; nextOffset: number | null;
		repeatedSourceObservations: Array<{ count: number; min: number; median: number; max: number; measurements: Array<{ externalId: string }> }>;
		readNext: { args: Record<string, unknown> } | null;
	};
	assert.equal(repeatedPage.section, "repeated-source");
	assert.equal(repeatedPage.total, 5);
	assert.equal(repeatedPage.repeatedSourceObservations.length, 2);
	assert.equal(repeatedPage.repeatedSourceObservations[0].count, 2);
	assert.equal(repeatedPage.repeatedSourceObservations[0].measurements.length, 2);
	assert.equal(repeatedPage.nextOffset, 2);
	const repeatedNext = await read(repeatedPage.readNext!.args) as unknown as typeof repeatedPage;
	assert.equal(repeatedNext.repeatedSourceObservations.length, 2);
	const repeatedLast = await read(repeatedNext.readNext!.args) as unknown as typeof repeatedPage;
	assert.equal(repeatedLast.repeatedSourceObservations.length, 1);
	assert.equal(repeatedLast.nextOffset, null);
	await assert.rejects(read({ repeatedOffset: 1 }), /section=repeated-source/);
	await rm(path.join(root, "20", "kernel.cpp"));
	const unavailable = await read({});
	assert.equal(unavailable.candidateArchive.unavailableCount, 2);
	assert.equal(unavailable.candidateArchive.bestObservedCount, 20);
	assert.equal(unavailable.candidateArchive.searchBrief.leads.length, 0);
	assert.equal(unavailable.candidateArchive.searchBrief.repeatedSourceObservationCount, 0);
	await assert.rejects(read({ taskId: "T099" }), /not in this goal/);
});

test("research_delegate passes approved plan, versioned resources, bounded loop, and lesson output to M07", async () => {
	const seen: unknown[] = [];
	const service = { delegate: async (_runId: string, task: unknown) => { seen.push(task); return { taskId: "task-offline", status: "returned" }; } } as unknown as ResearchService;
	const tool = captureExtension(service).tools.get("research_delegate")!;
	await tool.execute("d", { runId: "goal-offline", objective: "execute approved plan", inputs: ["plan.md", "guide.md"], expectedOutputs: ["lesson.md"], checks: ["evidence recorded"], mode: "execute", planInput: "plan.md", resourceInputs: [{ id: "operator-guide", version: "v2", input: "guide.md" }], executionLoop: { mode: "until-ready" }, lessonDeltaOutput: "lesson.md" }, undefined, undefined, toolContext("/workspace"));
	assert.deepEqual(seen, [{ objective: "execute approved plan", inputs: ["plan.md", "guide.md"], expectedOutputs: ["lesson.md"], checks: ["evidence recorded"], mode: "execute", planInput: "plan.md", resourceInputs: [{ id: "operator-guide", version: "v2", input: "guide.md" }], executionLoop: { mode: "until-ready" }, lessonDeltaOutput: "lesson.md" }]);
});

test("main-session capability guard blocks side-effect tools from the start", async () => {
	const service = {
		status: async () => ({ workspace: "/workspace", stages: {} }),
		init: async () => ({ initialized: true }),
		goalAction: async () => ({ runId: "goal-1", lifecycle: "active" }),
	} as unknown as ResearchService;
	const registered = captureExtension(service);
	const hook = registered.handlers.get("tool_call")![0];
	const bash = { toolName: "bash", input: { command: "true" } };
	assert.equal(((await hook(bash, toolContext("/workspace"))) as { block?: boolean }).block, true);
	await registered.tools.get("research_status")!.execute("status", {}, undefined, undefined, toolContext("/workspace"));
	assert.equal(((await hook(bash, toolContext("/workspace"))) as { block?: boolean }).block, true);
	await registered.tools.get("research_stage")!.execute("init", { stage: "init", workspace: "/workspace" }, undefined, undefined, toolContext("/workspace"));
	assert.equal(((await hook(bash, toolContext("/workspace"))) as { block?: boolean }).block, true);
	await registered.tools.get("research_goal")!.execute("begin", { action: "begin", goal: "g", problemRelation: "p", constraints: [], successCriteria: [], plan: "p" }, undefined, undefined, toolContext("/workspace"));
	const blocked = await hook(bash, toolContext("/workspace")) as { block?: boolean; reason?: string };
	assert.equal(blocked.block, true);
	assert.match(blocked.reason ?? "", /M07/);
	// A blocked mutation remains recoverable: Pi may follow the reason and call a workflow tool next.
	assert.equal(await hook({ toolName: "research_delegate", input: {} }, toolContext("/workspace")), undefined);
	assert.equal(await hook({ toolName: "read", input: { path: "result.md" } }, toolContext("/workspace")), undefined);
	assert.equal(await hook({ toolName: "research_stage", input: {} }, toolContext("/workspace")), undefined);
	assert.equal((await hook({ toolName: "research_secret", input: {} }, toolContext("/workspace")) as { block: boolean }).block, true);
	assert.equal(((await hook(bash, toolContext("/different-cwd"))) as { block?: boolean }).block, true);
});

test("failed recovery initialization shuts down the prompt and blocks every tool", async () => {
	const previous = process.env.PRE_RSI_RECOVER_GOAL_RUN_ID;
	const previousDescriptor = process.env.PRE_RSI_RUN_DESCRIPTOR_FILE;
	const root = await realpath(await mkdtemp(path.join(tmpdir(), "pre-rsi-recovery-gate-")));
	const descriptorPath = path.join(root, "run-descriptor.json");
	await writeFile(descriptorPath, JSON.stringify({ version: 1, instanceId: "fresh-instance", attemptId: "A008",
		workspaceId: "workspace-id", goalRunId: "goal-recovery", codeRevision: "test-revision", controlDir: root,
		process: { hostId: "test-host", bootId: "test-boot", pid: 123, processStartToken: "test-start" } }));
	process.env.PRE_RSI_RECOVER_GOAL_RUN_ID = "goal-recovery";
	process.env.PRE_RSI_RUN_DESCRIPTOR_FILE = descriptorPath;
	try {
		const service = {
			goalStatus: async () => ({ executionState: { activeAttemptId: "A007", attempts: Array.from({ length: 7 }) } }),
			hostRecover: async () => { throw new Error("recovery rejected"); },
		} as unknown as ResearchService;
		const registered = captureExtension(service, undefined, undefined, { workspace: "/workspace", goalRunId: "goal-recovery" });
		let aborted = 0;
		let shutdown = 0;
		const ctx = { cwd: "/workspace", mode: "rpc", abort: () => { aborted++; }, shutdown: () => { shutdown++; } };
		await assert.rejects(async () => registered.handlers.get("session_start")![0]({}, ctx), /recovery rejected/);
		assert.deepEqual(registered.activeTools(), []);
		await registered.handlers.get("before_agent_start")![0]({ systemPrompt: "normal prompt" }, ctx);
		assert.equal(aborted, 1);
		assert.equal(shutdown, 1);
		for (const toolName of ["read", "research_goal", "bash"]) {
			const decision = await registered.handlers.get("tool_call")![0]({ toolName, toolCallId: toolName, input: {} }, ctx) as { block?: boolean; terminate?: boolean };
			assert.equal(decision.block, true);
			assert.equal(decision.terminate, true);
		}
	} finally {
		if (previous === undefined) delete process.env.PRE_RSI_RECOVER_GOAL_RUN_ID;
		else process.env.PRE_RSI_RECOVER_GOAL_RUN_ID = previous;
		if (previousDescriptor === undefined) delete process.env.PRE_RSI_RUN_DESCRIPTOR_FILE;
		else process.env.PRE_RSI_RUN_DESCRIPTOR_FILE = previousDescriptor;
	}
});

test("stage tool uses a fresh runner, reports progress, and preserves completion caveat", async () => {
	const root = await realpath(await mkdtemp(path.join(tmpdir(), "pre-rsi-stage-")));
	await mkdir(path.join(root, "problem", "raw"), { recursive: true });
	await writeFile(path.join(root, "problem", "problem.md"), "测试问题\n");
	await writeFile(path.join(root, "research.config.json"), `${JSON.stringify({ roles: { execution: "fake/model", research: "fake/research" }, concurrency: 1 })}\n`);
	const updates: string[] = [];
	const service = new ResearchService({
		defaultWorkspace: root,
		onProgress: (progress) => updates.push(progress.message),
		runnerFactory: () => new FakeSessionRunner(({ spec }) => ({ text: spec.label === "M04-research"
			? '核对后保留候选。\n\n```knowledge-proposals\n[{"op":"create","type":"Q","title":"待复核问题","body":"仍需更多证据","usageDecision":"candidate"}]\n```'
			: "离线结果", reads: [] })),
	});
	await service.init(root);
	const registered = captureExtension(service);
	const tool = registered.tools.get("research_stage")!;
	const result = await tool.execute("call-1", { stage: "M01", workspace: root }, undefined, undefined, toolContext(root));
	assert.match(JSON.stringify(result), /initial-understanding\.md/);
	const run = (await service.status(root)).stages.M01.latest!;
	assert.equal(run.status, "completed");
	assert.ok(updates.length > 0);
	const feedbackFile = path.join(root, "feedback.md");
	await writeFile(feedbackFile, "需要记录尚未解决的问题。\n");
	const m04 = await tool.execute("call-m04", { stage: "M04", workspace: root, feedbackFile, freshSession: true }, undefined, undefined, toolContext(root));
	const m04Summary = JSON.parse((m04.content[0] as { text: string }).text) as { proposalId?: string; snapshotId?: string; outputs?: Array<{ path: string }> };
	assert.equal(m04Summary.proposalId, "P0001");
	assert.equal(m04Summary.snapshotId, "G001");
	assert.ok(m04Summary.outputs?.some((item) => item.path.endsWith("/P0001.json")));
	assert.ok(m04Summary.outputs?.some((item) => item.path.endsWith("/merge.json")));
});

test("research_stage schema invokes the real M08 service path with explicit review inputs", async () => {
	const root = await realpath(await mkdtemp(path.join(tmpdir(), "pre-rsi-m08-extension-")));
	await mkdir(path.join(root, "problem", "raw"), { recursive: true });
	await writeFile(path.join(root, "problem", "problem.md"), "需要审查的原问题\n");
	const artifact = path.join(root, "result.md");
	await writeFile(artifact, "实际成果\n");
	await writeFile(path.join(root, "research.config.json"), `${JSON.stringify({ roles: { reviewer: "fake/reviewer" }, concurrency: 1 })}\n`);
	const service = new ResearchService({ defaultWorkspace: root, runnerFactory: () => new FakeSessionRunner(() => ({ text: "已按固定材料核验", reads: ["materials/001-成果/result.md"] })) });
	await service.init(root);
	const tool = captureExtension(service).tools.get("research_stage")!;
	const output = await tool.execute("m08", {
		stage: "M08", materials: [{ label: "成果", path: artifact, sourceCategory: "result", providedScope: "全文" }],
		selfChecks: [{ id: "scope", instruction: "核对目标与成果", mode: "read-only" }],
		reviewers: [{ id: "external", role: "reviewer", mode: "read-only" }],
		unprovidedScopes: ["未提供现实实验复核"],
	}, undefined, undefined, toolContext(root));
	assert.match(JSON.stringify(output), /review-bundle\.md/);
	assert.match(JSON.stringify(output), /scope/);
	assert.match(JSON.stringify(output), /external/);
	assert.match(JSON.stringify(output), /coverage/);
	const status = await service.status(root);
	assert.equal(status.stages.M08.latest?.status, "completed");
});

test("Pi DefaultResourceLoader loads the actual extensions/research.ts entrypoint", async () => {
	const root = await realpath(await mkdtemp(path.join(tmpdir(), "pre-rsi-file-loader-")));
	const agentDir = path.join(root, "agent");
	await mkdir(agentDir, { recursive: true });
	const loader = new DefaultResourceLoader({
		cwd: root, agentDir, settingsManager: SettingsManager.inMemory({}), noSkills: true,
		noPromptTemplates: true, noThemes: true, noContextFiles: true,
		additionalExtensionPaths: [path.resolve("extensions/research.ts")],
	});
	await loader.reload();
	const loaded = loader.getExtensions();
	assert.equal(loaded.errors.length, 0);
	assert.equal(loaded.extensions.length, 1);
	assert.deepEqual([...loaded.extensions[0].tools.keys()].sort(), ["research_delegate", "research_goal", "research_improve", "research_mission", "research_review", "research_stage", "research_status"]);
});

test("one improvement tool routes both tracks and refuses a cross-track action", async t => {
	const workspace = await mkdtemp(path.join(tmpdir(), "pre-rsi-improve-track-"));
	t.after(async () => { await rm(workspace, { recursive: true, force: true }); });
	const calls: string[] = [];
	const service = {
		status: async () => ({ workspace, stages: {} }),
	} as unknown as ResearchService;
	const registered = captureExtension(service, () => ({
		run: async () => { calls.push("budget-run"); return { runId: "B1" }; },
		status: async () => { calls.push("budget-status"); return { active: null }; },
		rollback: async () => ({}),
	}), () => ({
		runWorkflow: async () => { calls.push("method-workflow-run"); return { runId: "M1", status: "completed",
			developmentArms: [], protectedArms: [] }; },
		calibrateWorkflow: async () => { calls.push("method-calibrate"); return { runId: "M2", status: "completed",
			pairs: [] }; },
	}));
	const improve = registered.tools.get("research_improve")!;
	assert.equal(registered.tools.has("research_method_improve"), false);
	assert.equal(registered.tools.has("research_init"), false);

	await improve.execute("i1", { action: "status" }, undefined, undefined, toolContext(workspace));
	const plan = path.join(workspace, "plan.json");
	await writeFile(plan, JSON.stringify({ version: 1, kind: "m07-evidence-handoff-aa/v1" }));
	await improve.execute("i2", { track: "method", action: "workflow-run", planPath: plan }, undefined, undefined, toolContext(workspace));
	await improve.execute("i3", { track: "method", action: "workflow-calibrate", planPath: plan }, undefined, undefined, toolContext(workspace));
	assert.deepEqual(calls, ["budget-status", "method-workflow-run", "method-calibrate"]);
	// A method action on the budget track is refused rather than silently reinterpreted.
	await assert.rejects(improve.execute("i4", { action: "workflow-run", planPath: plan }, undefined, undefined, toolContext(workspace)),
		/belongs to track=method/);
	await assert.rejects(improve.execute("i5", { action: "status", methodsPath: plan }, undefined, undefined, toolContext(workspace)),
		/require track=method/);
});

test("research_status can list earlier runs' best candidates and never reuses another platform's number", async t => {
	const workspace = await mkdtemp(path.join(tmpdir(), "pre-rsi-prior-runs-"));
	t.after(async () => { await rm(workspace, { recursive: true, force: true }); });
	const runDir = path.join(workspace, "stages", "M07", "20261017T090000Z-aaaa");
	await mkdir(runDir, { recursive: true });
	const observation = { version: 1, kind: "candidate-observation", verifier: { id: "host:test", version: "1" },
		sourceBinding: "verified", correctness: "passed", stage: "measurement", checks: [], goalChecks: [],
		metrics: [{ name: "latency", value: 4, unit: "ms", basisId: "basis:gemm", direction: "lower" }],
		limitations: [], sourceFiles: ["/frozen/kernel.cpp"], receiptFiles: ["/frozen/receipt.json"],
		executionFacts: { evaluations: [{ externalId: "E1", subjectId: "gemm", status: "Completed", terminal: true,
			capturedAt: "2026-10-17T09:00:00.000Z", receiptIndex: 0, cases: [], diagnostics: [] }] } };
	await writeFile(path.join(runDir, "goal.json"), JSON.stringify({ version: 1, runId: "20261017T090000Z-aaaa",
		tasks: [{ taskId: "T001", status: "accepted", workDir: path.join(runDir, "work"), subjectId: "gemm",
			episode: { version: 1, incumbents: [], candidates: [{ id: "C001", intent: "solution",
				sourcePaths: ["kernel.cpp"], receiptPaths: ["receipt.json"], observation,
				observationPath: "/frozen/observation.json" }] } }] }));
	const log = openSearchEventLog(path.join(runDir, "search-events.jsonl"), { writer: "historic" });
	await log.append({ runId: "20261017T090000Z-aaaa", kind: "task-started", taskId: "T001",
		platform: { id: "device-a", chip: "Device A", toolchain: "Toolchain 8.3" } });

	const service = { status: async () => ({ workspace, stages: {} }) } as unknown as ResearchService;
	const registered = captureExtension(service);
	const status = registered.tools.get("research_status")!;
	const plain = JSON.parse(((await status.execute("s1", {}, undefined, undefined, toolContext(workspace))) as { content: Array<{ text: string }> }).content[0].text);
	assert.equal(plain.priorRuns, undefined);
	const matched = JSON.parse(((await status.execute("s2", { priorRuns: { subjectId: "gemm", chip: "Device A", toolchain: "Toolchain 8.3" } },
		undefined, undefined, toolContext(workspace))) as { content: Array<{ text: string }> }).content[0].text);
	assert.deepEqual(matched.priorRuns.leads.map((lead: { candidateRef: string; comparable: boolean }) => [lead.candidateRef, lead.comparable]),
		[["T001/C001", true]]);
	assert.match(matched.priorRuns.summary[0], /latency=4ms/);
	const other = JSON.parse(((await status.execute("s3", { priorRuns: { chip: "Device B", toolchain: "Toolchain 9.0" } },
		undefined, undefined, toolContext(workspace))) as { content: Array<{ text: string }> }).content[0].text);
	assert.deepEqual(other.priorRuns.leads, []);
	assert.equal(other.priorRuns.incomparableDropped, 1);
});
