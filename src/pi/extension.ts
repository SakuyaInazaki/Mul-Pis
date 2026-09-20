import { Type } from "@earendil-works/pi-ai";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadPrompt } from "../prompts.ts";
import { ResearchService, type StageRequest } from "./service.ts";

type ToolResult = AgentToolResult<Record<string, unknown>>;

function result(value: unknown): ToolResult {
	const summary = compact(value);
	return {
		content: [{ type: "text", text: JSON.stringify(summary, null, 2) }],
		details: { summary },
	};
}

function compact(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object") return { value };
	const item = value as Record<string, unknown>;
	if ("workspace" in item && "stages" in item) return item;
	if ("taskId" in item) return {
		taskId: item.taskId, status: item.status, workDir: item.workDir, reportPath: item.reportPath,
		expectedOutputPaths: item.expectedOutputPaths, executionFailure: item.executionFailure,
		failures: (item.review as Record<string, unknown> | undefined)?.failures,
		limitations: (item.review as Record<string, unknown> | undefined)?.limitations,
	};
	if ("runId" in item && "lifecycle" in item) return {
		runId: item.runId, lifecycle: item.lifecycle, outcome: item.outcome, returnPath: item.returnPath,
		feedbackPath: item.feedbackPath, taskCount: Array.isArray(item.tasks) ? item.tasks.length : undefined,
		openDecisions: Array.isArray(item.decisions) ? item.decisions.filter((entry) => (entry as { status?: string }).status === "open").length : undefined,
		limitations: item.limitations,
	};
	const record = item.record as Record<string, unknown> | undefined;
	if (record) return {
		stage: record.stage, runId: record.runId, status: record.status, outputs: record.outputs,
		failures: record.failures, remarks: record.remarks,
		...(item.feedback ? { feedback: compact(item.feedback) } : {}),
	};
	if ("stage" in item && item.stage && typeof item.stage === "object") return { stage: compact(item.stage), ...(item.feedback ? { feedback: compact(item.feedback) } : {}) };
	return { keys: Object.keys(item), note: "完整状态已持久化到工作区；使用 research_status 或主 Pi read 查看对应文件。" };
}

function strings(value: unknown): string[] | undefined {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : undefined;
}

export interface ResearchExtensionOptions {
	service?: ResearchService;
	defaultWorkspace?: string;
}

export function createResearchExtension(options: ResearchExtensionOptions = {}) {
	return function researchExtension(pi: ExtensionAPI): void {
		let researchActive = false;
		let activePiCwd: string | undefined;
		let activeUpdate: ((update: ToolResult) => void) | undefined;
		const service = options.service ?? new ResearchService({
			defaultWorkspace: options.defaultWorkspace ?? process.cwd(),
			onProgress: (progress) => activeUpdate?.(result(progress)),
		});

		pi.on("session_start", () => { researchActive = false; activePiCwd = undefined; });
		pi.on("before_agent_start", async (event, ctx) => {
			if (!researchActive || activePiCwd !== ctx.cwd) return;
			const p07 = await loadPrompt("P07");
			return {
				systemPrompt: `${event.systemPrompt}\n\n${p07}\n\n当前执行边界：通过 research_status 查看事实状态；阶段会话彼此按现有 M01–M06 规则隔离；M04 的科学判断留在研究会话。任务返回、外部意见和阶段完成都不自动等于通过或采用。`,
			};
		});

		pi.registerTool({
			name: "research_status",
			label: "Research Status",
			description: "Read the persisted M01–M07 research status for a workspace without starting or retrying work.",
			promptSnippet: "Inspect persisted research workflow status without rerunning tasks",
			promptGuidelines: ["Use research_status before deciding which research stage or M07 action is needed."],
			parameters: Type.Object({ workspace: Type.Optional(Type.String({ description: "Research workspace; defaults to the current Pi cwd" })) }),
			executionMode: "sequential",
			async execute(_id, params, _signal, _update, ctx) { return result(await service.status(params.workspace ?? ctx.cwd)); },
		});

		pi.registerTool({
			name: "research_init",
			label: "Initialize Research Workspace",
			description: "Initialize the explicit workspace layout. Does not create research.config.json or choose models.",
			promptSnippet: "Initialize an explicitly selected research workspace",
			promptGuidelines: ["Use research_init only when the user asked to initialize the selected research workspace."],
			parameters: Type.Object({ workspace: Type.String({ description: "Explicit research workspace path" }) }),
			executionMode: "sequential",
			async execute(_id, params, _signal, _update, ctx) { return result(await service.init(params.workspace ?? ctx.cwd)); },
		});

		pi.registerTool({
			name: "research_stage",
			label: "Run Research Stage",
			description: "Run one existing M01–M06 stage. M03/M06 feedback is transferred to M04 only when processFeedback is explicitly true; incomplete M06 batches are never transferred.",
			promptSnippet: "Run one isolated M01–M06 workflow stage and optionally transfer complete feedback",
			promptGuidelines: [
				"Use research_stage only after research_status confirms the requested stage inputs exist.",
				"Treat research_stage completion and returned opinions as artifacts to inspect, not automatic acceptance.",
			],
			parameters: Type.Object({
				stage: Type.Union([Type.Literal("M01"), Type.Literal("M02"), Type.Literal("M03"), Type.Literal("M04"), Type.Literal("M05"), Type.Literal("M06")]),
				workspace: Type.Optional(Type.String({ description: "Research workspace; defaults to current Pi cwd" })),
				m01RunId: Type.Optional(Type.String()),
				m02RunId: Type.Optional(Type.String()),
				feedbackStage: Type.Optional(Type.Union([Type.Literal("M03"), Type.Literal("M06"), Type.Literal("M07")])),
				feedbackRunId: Type.Optional(Type.String()),
				feedbackFile: Type.Optional(Type.String()),
				feedbackLabel: Type.Optional(Type.String()),
				freshSession: Type.Optional(Type.Boolean()),
				goal: Type.Optional(Type.String({ description: "M05 acquisition goal" })),
				noBrowser: Type.Optional(Type.Boolean()),
				sources: Type.Optional(Type.Array(Type.String())),
				fullText: Type.Optional(Type.Boolean()),
				requirements: Type.Optional(Type.String()),
				processFeedback: Type.Optional(Type.Boolean({ description: "After a complete M03/M06 result, explicitly transfer it to M04" })),
			}),
			executionMode: "sequential",
			async execute(_id, params, signal, onUpdate, ctx) {
				activeUpdate = onUpdate as typeof activeUpdate;
				try {
					const value = await service.runStage({ ...params, workspace: params.workspace ?? ctx.cwd, sources: strings(params.sources) } as StageRequest, signal);
					researchActive = true; activePiCwd = ctx.cwd;
					return result(value);
				} finally { activeUpdate = undefined; }
			},
		});

		pi.registerTool({
			name: "research_goal",
			label: "Manage Research Goal",
			description: "Begin, inspect, replan, record a user decision, or finish one persisted M07 goal. Finishing does not turn returned tasks into accepted work.",
			promptSnippet: "Manage one explicit M07 goal and its lifecycle",
			promptGuidelines: ["Use research_goal to keep the user's frozen goal, plan, decisions, outcome, and return path explicit."],
			parameters: Type.Object({
				action: Type.Union([Type.Literal("begin"), Type.Literal("status"), Type.Literal("plan"), Type.Literal("decision"), Type.Literal("finish")]),
				workspace: Type.Optional(Type.String()), runId: Type.Optional(Type.String()),
				goal: Type.Optional(Type.String()), problemRelation: Type.Optional(Type.String()), constraints: Type.Optional(Type.Array(Type.String())), successCriteria: Type.Optional(Type.Array(Type.String())), plan: Type.Optional(Type.String()), exploratory: Type.Optional(Type.Boolean()), refreshBaseline: Type.Optional(Type.Boolean()),
				decisionAction: Type.Optional(Type.Union([Type.Literal("request"), Type.Literal("resolve")])), question: Type.Optional(Type.String()), decision: Type.Optional(Type.String()), relatedTaskIds: Type.Optional(Type.Array(Type.String())),
				outcome: Type.Optional(Type.Union([Type.Literal("partial"), Type.Literal("blocked"), Type.Literal("fulfilled")])), summary: Type.Optional(Type.String()), returnPath: Type.Optional(Type.Union([Type.Literal("M04"), Type.Literal("M05"), Type.Literal("M06"), Type.Literal("M08"), Type.Literal("continue"), Type.Literal("user")])), limitations: Type.Optional(Type.Array(Type.String())),
				goalChecks: Type.Optional(Type.Array(Type.Object({ criterion: Type.String(), result: Type.Union([Type.Literal("passed"), Type.Literal("failed"), Type.Literal("not_run")]), evidence: Type.Array(Type.String()) }))),
			}),
			executionMode: "sequential",
			async execute(_id, params, signal, _update, ctx) {
				const workspace = params.workspace ?? ctx.cwd;
				if (params.action === "status") {
					if (!params.runId) throw new Error("research_goal status requires runId");
					return result(await service.goalStatus(params.runId, workspace));
				}
				let value: unknown;
				if (params.action === "begin") {
					value = await service.goalAction("begin", workspace, { goal: params.goal ?? "", problemRelation: params.problemRelation ?? "", constraints: params.constraints ?? [], successCriteria: params.successCriteria ?? [], plan: params.plan ?? "", exploratory: params.exploratory }, signal);
				} else {
					if (!params.runId) throw new Error(`research_goal ${params.action} requires runId`);
					if (params.action === "plan") value = await service.goalAction("plan", workspace, { runId: params.runId, plan: params.plan ?? "", refreshBaseline: params.refreshBaseline }, signal);
					if (params.action === "decision") value = await service.goalAction("decision", workspace, { runId: params.runId, action: params.decisionAction ?? "request", question: params.question, decision: params.decision, relatedTaskIds: params.relatedTaskIds ?? [] }, signal);
					if (params.action === "finish") value = await service.goalAction("finish", workspace, { runId: params.runId, outcome: params.outcome ?? "partial", summary: params.summary ?? "", returnPath: params.returnPath ?? "user", limitations: params.limitations, goalChecks: params.goalChecks ?? [] }, signal);
				}
				researchActive = true; activePiCwd = ctx.cwd;
				return result(value);
			},
		});

		pi.registerTool({
			name: "research_delegate",
			label: "Delegate Research Task",
			description: "Run one bounded M07 task in a fresh isolated session and record it as returned. The return is not accepted until research_review checks it.",
			promptSnippet: "Delegate one bounded M07 task with explicit inputs, outputs, and checks",
			promptGuidelines: ["Use research_delegate only for a bounded task under an existing M07 goal; never describe a returned task as accepted."],
			parameters: Type.Object({
				workspace: Type.Optional(Type.String()), runId: Type.String(), objective: Type.String(), inputs: Type.Array(Type.String()), expectedOutputs: Type.Array(Type.String()), checks: Type.Array(Type.String()), mode: Type.Union([Type.Literal("execute"), Type.Literal("check"), Type.Literal("reason")]), parentTaskId: Type.Optional(Type.String()), supersedesTaskId: Type.Optional(Type.String()), requireIndependentCheck: Type.Optional(Type.Boolean()), knowledgeIds: Type.Optional(Type.Array(Type.String())),
			}),
			executionMode: "sequential",
			async execute(_id, params, signal, onUpdate, ctx) {
				activeUpdate = onUpdate as typeof activeUpdate;
				try { const { workspace, runId, ...task } = params; const value = await service.delegate(runId, task, workspace ?? ctx.cwd, signal); researchActive = true; activePiCwd = ctx.cwd; return result(value); }
				finally { activeUpdate = undefined; }
			},
		});

		pi.registerTool({
			name: "research_review",
			label: "Review Research Task",
			description: "Review actual M07 task artifacts and every predefined check. Acceptance requires passed checks with file evidence and no failures or unexecuted items.",
			promptSnippet: "Review returned M07 task artifacts against predefined checks",
			promptGuidelines: ["Use research_review only after inspecting actual task artifacts; task reports and external opinions are not themselves acceptance."],
			parameters: Type.Object({
				workspace: Type.Optional(Type.String()), runId: Type.String(), taskId: Type.String(),
				checks: Type.Array(Type.Object({ criterion: Type.String(), result: Type.Union([Type.Literal("passed"), Type.Literal("failed"), Type.Literal("not_run")]), evidence: Type.Array(Type.String()) })),
				artifacts: Type.Array(Type.String()), failures: Type.Optional(Type.Array(Type.String())), unexecuted: Type.Optional(Type.Array(Type.String())), limitations: Type.Optional(Type.Array(Type.String())),
				independentCheckTaskId: Type.Optional(Type.String()), independentCheckReport: Type.Optional(Type.String()), independentCheckDisposition: Type.Optional(Type.String()),
			}),
			executionMode: "sequential",
			async execute(_id, params, signal, _update, ctx) {
				const value = await service.review(params.runId, { taskId: params.taskId, checks: params.checks, artifacts: params.artifacts, failures: params.failures, unexecuted: params.unexecuted, limitations: params.limitations, ...(params.independentCheckTaskId && params.independentCheckReport && params.independentCheckDisposition ? { independentCheck: { taskId: params.independentCheckTaskId, report: params.independentCheckReport, disposition: params.independentCheckDisposition } } : {}) }, params.workspace ?? ctx.cwd, signal);
				researchActive = true; activePiCwd = ctx.cwd;
				return result(value);
			},
		});

		pi.registerCommand("research", {
			description: "Research harness help/status/off: /research help | /research status [workspace] | /research off",
			handler: async (args, ctx) => {
				const [action = "help", ...rest] = args.trim().split(/\s+/).filter(Boolean);
				if (action === "help") {
					ctx.ui.notify("/research status [workspace] 查看状态；/research off 停止向当前主会话追加 P07。", "info");
					return;
				}
				if (action === "off") { researchActive = false; activePiCwd = undefined; ctx.ui.notify("当前主会话已退出研究指导状态。", "info"); return; }
				if (action !== "status") {
					ctx.ui.notify("未知子命令；使用 /research help", "error");
					return;
				}
				const status = await service.status(rest.length ? rest.join(" ") : ctx.cwd);
				ctx.ui.notify(JSON.stringify(status, null, 2), "info");
			},
		});
	};
}

export default createResearchExtension();
