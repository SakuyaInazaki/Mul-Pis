import { existsSync } from "node:fs";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { createFileKnowledgeStore } from "../knowledge/store.ts";
import { createM07Controller } from "../m07/controller.ts";
import type { BeginGoalInput, DecisionInput, FinishInput, TaskReviewInput, TaskSpecInput } from "../m07/types.ts";
import { createPiSessionRunner } from "../runner/pi.ts";
import type { SessionHandle, SessionRunner, SessionSpec } from "../runner/types.ts";
import { runInit } from "../stages/init.ts";
import { runM01 } from "../stages/m01.ts";
import { runM02 } from "../stages/m02.ts";
import { runM03 } from "../stages/m03.ts";
import { runM04 } from "../stages/m04.ts";
import { runM05 } from "../stages/m05.ts";
import { runM06 } from "../stages/m06.ts";
import type { StageContext } from "../stages/context.ts";
import { HarnessError, type StageRunRecord } from "../types.ts";
import { Workspace } from "../workspace.ts";

export type ResearchStage = "M01" | "M02" | "M03" | "M04" | "M05" | "M06" | "M07";
export type RunnableStage = Exclude<ResearchStage, "M07">;

export interface ResearchProgress {
	phase: "session-create" | "session-created" | "prompt-start" | "prompt-complete" | "stage-complete";
	stage?: ResearchStage;
	session?: string;
	message: string;
}

export interface ResearchStatus {
	workspace: string;
	initialized: boolean;
	configPresent: boolean;
	knowledgeSnapshot?: string;
	activeLimits: number;
	stages: Record<ResearchStage, { count: number; latest?: { runId: string; status: string; failures: string[] } }>;
	limitations: string[];
}

export interface StageRequest {
	stage: RunnableStage;
	workspace?: string;
	m01RunId?: string;
	m02RunId?: string;
	feedbackStage?: "M03" | "M06" | "M07";
	feedbackRunId?: string;
	feedbackFile?: string;
	feedbackLabel?: string;
	freshSession?: boolean;
	goal?: string;
	noBrowser?: boolean;
	sources?: string[];
	fullText?: boolean;
	requirements?: string;
	processFeedback?: boolean;
}

export interface ResearchServiceOptions {
	defaultWorkspace: string;
	onProgress?: (progress: ResearchProgress) => void;
	runnerFactory?: (signal: AbortSignal | undefined) => SessionRunner;
}

const activeMutations = new Set<string>();

class ProgressRunner implements SessionRunner {
	private readonly inner: SessionRunner;
	private readonly report: (progress: ResearchProgress) => void;
	private readonly stage: ResearchStage;

	constructor(
		inner: SessionRunner,
		report: (progress: ResearchProgress) => void,
		stage: ResearchStage,
	) {
		this.inner = inner;
		this.report = report;
		this.stage = stage;
	}

	async create(spec: SessionSpec): Promise<SessionHandle> {
		this.report({ phase: "session-create", stage: this.stage, session: spec.label, message: `${spec.label}：正在创建隔离会话` });
		return this.wrap(await this.inner.create(spec));
	}

	async resume(ref: Parameters<SessionRunner["resume"]>[0]): Promise<SessionHandle> {
		this.report({ phase: "session-create", stage: this.stage, session: ref.label, message: `${ref.label}：正在续接既有隔离会话` });
		return this.wrap(await this.inner.resume(ref));
	}

	private wrap(handle: SessionHandle): SessionHandle {
		this.report({ phase: "session-created", stage: this.stage, session: handle.ref.label, message: `${handle.ref.label}：会话已就绪` });
		return {
			...handle,
			prompt: async (text) => {
				this.report({ phase: "prompt-start", stage: this.stage, session: handle.ref.label, message: `${handle.ref.label}：正在执行` });
				const result = await handle.prompt(text);
				this.report({ phase: "prompt-complete", stage: this.stage, session: handle.ref.label, message: `${handle.ref.label}：执行完成` });
				return result;
			},
		};
	}
}

export class ResearchService {
	private readonly options: ResearchServiceOptions;

	constructor(options: ResearchServiceOptions) {
		this.options = options;
	}

	resolveWorkspace(requested?: string): string {
		return path.resolve(requested?.trim() || this.options.defaultWorkspace);
	}

	async init(requested?: string): Promise<unknown> {
		const root = this.resolveWorkspace(requested);
		return this.withMutation(root, async () => {
			const ws = new Workspace(root);
			return runInit(ws, createFileKnowledgeStore(ws.knowledgeDir));
		});
	}

	async status(requested?: string): Promise<ResearchStatus> {
		const root = this.resolveWorkspace(requested);
		const ws = new Workspace(root);
		const store = createFileKnowledgeStore(ws.knowledgeDir);
		const stages = {} as ResearchStatus["stages"];
		for (const stage of ["M01", "M02", "M03", "M04", "M05", "M06", "M07"] as const) {
			const ids = await ws.listRuns(stage);
			const latest = ids.length ? await ws.readRun(stage, ids.at(-1)!) : undefined;
			stages[stage] = { count: ids.length, ...(latest ? { latest: summarizeRun(latest) } : {}) };
		}
		const snapshot = existsSync(ws.knowledgeDir) ? await store.current() : undefined;
		const limits = existsSync(ws.knowledgeDir) ? (await store.limits()).filter((limit) => !limit.liftedAt) : [];
		return {
			workspace: root,
			initialized: existsSync(ws.agentDir),
			configPresent: existsSync(ws.configFile),
			knowledgeSnapshot: snapshot?.id,
			activeLimits: limits.length,
			stages,
			limitations: ["断线或进程退出后的 running 任务不会自动重跑。", "取消会传给 Pi 会话；并非所有外部 HTTP 后端都支持即时取消。"],
		};
	}

	async runStage(request: StageRequest, signal?: AbortSignal): Promise<unknown> {
		const root = this.resolveWorkspace(request.workspace);
		return this.withMutation(root, async () => {
			const ctx = await this.stageContext(root, request.stage, signal);
			let result: unknown;
			switch (request.stage) {
				case "M01": result = await runM01(ctx); break;
				case "M02": result = await runM02(ctx, { m01RunId: request.m01RunId }); break;
				case "M03": {
					const stage = await runM03(ctx, { m01RunId: request.m01RunId, m02RunId: request.m02RunId });
					result = request.processFeedback ? { stage, feedback: await runM04(ctx, { feedback: { kind: "M03", runId: stage.record.runId } }) } : stage;
					break;
				}
				case "M04": {
					const feedback = request.feedbackFile
						? { kind: "file" as const, label: request.feedbackLabel ?? path.basename(request.feedbackFile), path: path.resolve(root, request.feedbackFile) }
						: request.feedbackStage
							? { kind: request.feedbackStage, runId: request.feedbackRunId }
							: undefined;
					if (!feedback) throw new HarnessError("m07.stage", "M04 需要 feedbackStage 或 feedbackFile");
					result = await runM04(ctx, { feedback, freshSession: request.freshSession });
					break;
				}
				case "M05": result = await runM05(ctx, { goal: request.goal, noBrowser: request.noBrowser }); break;
				case "M06": {
					const stage = await runM06(ctx, { sources: request.sources, fullText: request.fullText, requirements: request.requirements });
					if (request.processFeedback && stage.groups.some((group) => group.status === "failed")) {
						throw new HarnessError("m07.feedback", "M06 存在失败资料组，整批未转交 M04");
					}
					result = request.processFeedback ? { stage, feedback: await runM04(ctx, { feedback: { kind: "M06", runId: stage.record.runId } }) } : stage;
					break;
				}
			}
			this.options.onProgress?.({ phase: "stage-complete", stage: request.stage, message: `${request.stage} 已完成；完成不等于科学判断已通过` });
			return result;
		});
	}

	async goalStatus(runId: string, requested?: string): Promise<unknown> {
		const root = this.resolveWorkspace(requested);
		const ws = new Workspace(root);
		const store = createFileKnowledgeStore(ws.knowledgeDir);
		const unavailable: SessionRunner = {
			create: async () => { throw new HarnessError("m07.runner", "status 不运行会话"); },
			resume: async () => { throw new HarnessError("m07.runner", "status 不运行会话"); },
		};
		return createM07Controller({ ws, store, runner: unavailable, config: { roles: {}, concurrency: 1, tools: {} } }).status(runId);
	}

	async goalAction(action: "begin" | "plan" | "decision" | "finish", requested: string | undefined, input: BeginGoalInput | { runId: string; plan: string; refreshBaseline?: boolean } | ({ runId: string } & DecisionInput) | ({ runId: string } & FinishInput), signal?: AbortSignal): Promise<unknown> {
		const root = this.resolveWorkspace(requested);
		return this.withMutation(root, async () => {
			const ctx = await this.nonModelContext(root);
			const controller = createM07Controller(ctx);
			if (action === "begin") return controller.begin(input as BeginGoalInput);
			if (action === "plan") { const value = input as { runId: string; plan: string; refreshBaseline?: boolean }; return controller.plan(value.runId, value.plan, { refreshBaseline: value.refreshBaseline }); }
			if (action === "decision") { const { runId, ...value } = input as { runId: string } & DecisionInput; return controller.decision(runId, value); }
			const { runId, ...value } = input as { runId: string } & FinishInput;
			return controller.finish(runId, value);
		});
	}

	async delegate(runId: string, task: TaskSpecInput, requested?: string, signal?: AbortSignal): Promise<unknown> {
		const root = this.resolveWorkspace(requested);
		return this.withMutation(root, async () => createM07Controller(await this.stageContext(root, "M07", signal)).delegate(runId, task));
	}

	async review(runId: string, review: TaskReviewInput, requested?: string, signal?: AbortSignal): Promise<unknown> {
		const root = this.resolveWorkspace(requested);
		return this.withMutation(root, async () => createM07Controller(await this.nonModelContext(root)).review(runId, review));
	}

	private async nonModelContext(root: string): Promise<StageContext> {
		const ws = new Workspace(root);
		const unavailable: SessionRunner = {
			create: async () => { throw new HarnessError("m07.runner", "该 M07 操作不运行会话"); },
			resume: async () => { throw new HarnessError("m07.runner", "该 M07 操作不运行会话"); },
		};
		return { ws, store: createFileKnowledgeStore(ws.knowledgeDir), runner: unavailable, config: { roles: {}, concurrency: 1, tools: {} } };
	}

	private async stageContext(root: string, stage: ResearchStage, signal?: AbortSignal): Promise<StageContext> {
		const ws = new Workspace(root);
		if (!existsSync(ws.configFile)) throw new HarnessError("config.missing", `缺少 ${ws.configFile}；请明确配置各角色模型`);
		const store = createFileKnowledgeStore(ws.knowledgeDir);
		const base = this.options.runnerFactory?.(signal) ?? createPiSessionRunner({ signal });
		const runner = new ProgressRunner(base, (progress) => this.options.onProgress?.(progress), stage);
		return { ws, store, runner, config: await ws.loadConfig() };
	}

	private async withMutation<T>(root: string, operation: () => Promise<T>): Promise<T> {
		const key = await canonicalMutationKey(root);
		if (activeMutations.has(key)) throw new HarnessError("m07.busy", `工作区已有同步研究操作：${root}`);
		activeMutations.add(key);
		try { return await operation(); } finally { activeMutations.delete(key); }
	}
}

async function canonicalMutationKey(root: string): Promise<string> {
	let existing = path.resolve(root);
	const suffix: string[] = [];
	while (!existsSync(existing)) {
		const parent = path.dirname(existing);
		if (parent === existing) break;
		suffix.unshift(path.basename(existing));
		existing = parent;
	}
	const canonical = await realpath(existing);
	return path.join(canonical, ...suffix);
}

function summarizeRun(run: StageRunRecord): { runId: string; status: string; failures: string[] } {
	return { runId: run.runId, status: run.status, failures: run.failures };
}
