import { existsSync } from "node:fs";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { createFileKnowledgeStore } from "../knowledge/store.ts";
import { createM07Controller } from "../m07/controller.ts";
import type { BeginGoalInput, CurrentGoal, DecisionInput, FinishInput, HostStopReasonKind, InterruptInput, TaskReviewInput, TaskSpecInput } from "../m07/types.ts";
import { summarizeGoalExecution } from "../m07/status.ts";
import type { RunDescriptorV1 } from "../runtime/run-descriptor.ts";
import { createPiSessionRunner } from "../runner/pi.ts";
import type { SessionHandle, SessionRunner, SessionSpec } from "../runner/types.ts";
import { runInit } from "../stages/init.ts";
import { runM01 } from "../stages/m01.ts";
import { runM02 } from "../stages/m02.ts";
import { runM03 } from "../stages/m03.ts";
import { runM04 } from "../stages/m04.ts";
import { runM05 } from "../stages/m05.ts";
import { runM06 } from "../stages/m06.ts";
import { runM08, type M08Options } from "../stages/m08.ts";
import { runM09, type M09Options } from "../stages/m09.ts";
import type { StageContext } from "../stages/context.ts";
import { HarnessError, type StageRunRecord } from "../types.ts";
import { failureSignature, RetryGuard, stageFingerprint, stageInputVersion, thrownSignature } from "./retry-guard.ts";
import { Workspace } from "../workspace.ts";
import { readTrustedPauseMs } from "../runtime/run-descriptor.ts";

export type ResearchStage = "M01" | "M02" | "M03" | "M04" | "M05" | "M06" | "M07" | "M08" | "M09";
export type RunnableStage = Exclude<ResearchStage, "M07">;

export interface ResearchProgress {
	phase: "session-create" | "session-created" | "prompt-start" | "prompt-heartbeat" | "prompt-observation" | "prompt-complete" | "stage-complete";
	stage?: ResearchStage;
	session?: string;
	message: string;
	/** A host timer firing is observable, but does not prove provider or task progress. */
	hostHeartbeatAt?: number;
	providerEventAt?: number;
	toolProgressAt?: number;
	durableProgressAt?: number;
}

export interface ResearchStatus {
	workspace: string;
	initialized: boolean;
	configPresent: boolean;
	knowledgeSnapshot?: string;
	activeLimits: number;
	stages: Record<ResearchStage, { count: number; latest?: { runId: string; status: string; failures: string[]; goalLifecycle?: CurrentGoal["lifecycle"]; attemptId?: string; attemptState?: ReturnType<typeof summarizeGoalExecution>["attemptState"]; unresolvedOperationIds?: string[]; unresolvedTaskIds?: string[]; goalStateError?: "unreadable" } }>;
	limitations: string[];
}

export interface StageRequest {
	stage: RunnableStage;
	workspace?: string;
	m01RunId?: string;
	m02RunId?: string;
	feedbackStage?: "M03" | "M06" | "M07" | "M08";
	feedbackRunId?: string;
	feedbackCheckpointId?: string;
	feedbackFile?: string;
	feedbackLabel?: string;
	freshSession?: boolean;
	goal?: string;
	noBrowser?: boolean;
	sources?: string[];
	fullText?: boolean;
	requirements?: string;
	processFeedback?: boolean;
	materials?: M08Options["materials"];
	selfChecks?: M08Options["selfChecks"];
	reviewers?: M08Options["reviewers"];
	unprovidedScopes?: string[];
	previousRunId?: string;
	changeSummary?: string;
	affectedScope?: string;
	m08RunId?: string;
	m04RunId?: string;
	recipient?: string;
	purpose?: string;
	deliveryScope?: M09Options["deliveryScope"];
	reproduction?: M09Options["reproduction"];
	closureRequested?: boolean;
}

export interface ResearchServiceOptions {
	defaultWorkspace: string;
	onProgress?: (progress: ResearchProgress) => void;
	/** Periodic progress updates while a model prompt is still running; 0 disables. */
	progressIntervalMs?: number;
	/** Overall wall-clock limit for one child prompt; 0 disables. */
	promptTimeoutMs?: number;
	/** Abort when no transcript or tool-log progress is observed for this long; 0 disables. */
	stallTimeoutMs?: number;
	/** How often to check for stalled prompts. */
	stallCheckMs?: number;
	/** Injectable for virtual-time watchdog tests. */
	watchdogNow?: () => number;
	trustedPauseMs?: (now: number) => number;
	watchdogTimers?: {
		setInterval(callback: () => void, ms: number): NodeJS.Timeout;
		setTimeout(callback: () => void, ms: number): NodeJS.Timeout;
		clearInterval(timer: NodeJS.Timeout): void;
		clearTimeout(timer: NodeJS.Timeout): void;
	};
	runnerFactory?: (signal: AbortSignal | undefined) => SessionRunner;
}

const activeMutations = new Set<string>();

class ProgressRunner implements SessionRunner {
	private readonly inner: SessionRunner;
	private readonly report: (progress: ResearchProgress) => void;
	private readonly stage: ResearchStage;
	private readonly heartbeatMs: number;
	private readonly promptTimeoutMs: number;
	private readonly stallTimeoutMs: number;
	private readonly stallCheckMs: number;
	private readonly now: () => number;
	private readonly pauseMs: (now: number) => number;
	private readonly timers: NonNullable<ResearchServiceOptions["watchdogTimers"]>;

	constructor(
		inner: SessionRunner,
		report: (progress: ResearchProgress) => void,
		stage: ResearchStage,
		heartbeatMs = 15_000,
		promptTimeoutMs = 60 * 60_000,
		stallTimeoutMs = 10 * 60_000,
		stallCheckMs = 30_000,
		now: () => number = Date.now,
		pauseMs: (now: number) => number = readTrustedPauseMs,
		timers: NonNullable<ResearchServiceOptions["watchdogTimers"]> = { setInterval, setTimeout, clearInterval, clearTimeout },
	) {
		this.inner = inner;
		this.report = report;
		this.stage = stage;
		this.heartbeatMs = heartbeatMs;
		this.promptTimeoutMs = promptTimeoutMs;
		this.stallTimeoutMs = stallTimeoutMs;
		this.stallCheckMs = stallCheckMs;
		this.now = now;
		this.pauseMs = pauseMs;
		this.timers = timers;
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
				const startedAt = this.now();
				const effectiveNow = (): number => { const now = this.now(); return now - this.pauseMs(now); };
				const effectiveStartedAt = effectiveNow();
				let heartbeat: NodeJS.Timeout | undefined;
				if (this.heartbeatMs > 0) {
					heartbeat = this.timers.setInterval(() => {
						const at = this.now();
						const elapsedSeconds = Math.max(1, Math.round((at - startedAt) / 1000));
						this.report({ phase: "prompt-heartbeat", stage: this.stage, session: handle.ref.label, hostHeartbeatAt: at, message: `${handle.ref.label}：心跳（不代表子会话有进展，已 ${elapsedSeconds}s）` });
					}, this.heartbeatMs);
					heartbeat.unref();
				}
				let timeoutTimer: NodeJS.Timeout | undefined;
				let stallTimer: NodeJS.Timeout | undefined;
				let lastProgressAt = effectiveStartedAt;
				let providerMarker = handle.transcript().filter((item) => item.role === "assistant").length;
				let toolMarker = handle.toolLog().length;
				let watchdogFailed = false;
				const watchdog = new Promise<never>((_resolve, reject) => {
					const fail = (error: HarnessError): void => {
						if (watchdogFailed) return;
						watchdogFailed = true;
						handle.dispose();
						reject(error);
					};
					if (this.promptTimeoutMs > 0) {
						const scheduleTimeout = (): void => {
							const remaining = this.promptTimeoutMs - (effectiveNow() - effectiveStartedAt);
							timeoutTimer = this.timers.setTimeout(() => {
								if (effectiveNow() - effectiveStartedAt >= this.promptTimeoutMs) fail(new HarnessError("runner.stop", `session ${handle.ref.label} exceeded prompt timeout (${Math.round(this.promptTimeoutMs / 1000)}s)`));
								else scheduleTimeout();
							}, Math.max(1, remaining));
							timeoutTimer.unref();
						};
						scheduleTimeout();
					}
					if (this.stallTimeoutMs > 0 && this.stallCheckMs > 0) {
  stallTimer = this.timers.setInterval(() => {
	const now = effectiveNow();
	const providerCount = handle.transcript().filter((item) => item.role === "assistant").length;
	const toolCount = handle.toolLog().length;
	if (providerCount === providerMarker && toolCount === toolMarker) {
      if (now - lastProgressAt > this.stallTimeoutMs) {
        fail(new HarnessError("runner.stop", `session ${handle.ref.label} made no progress for ${Math.round(this.stallTimeoutMs / 1000)}s`));
      }
      return;
    }
	const observedAt = this.now();
	this.report({ phase: "prompt-observation", stage: this.stage, session: handle.ref.label, message: `${handle.ref.label}：观察到子会话输出或工具记录`, ...(providerCount !== providerMarker ? { providerEventAt: observedAt } : {}), ...(toolCount !== toolMarker ? { toolProgressAt: observedAt } : {}) });
	providerMarker = providerCount;
	toolMarker = toolCount;
	lastProgressAt = now;
  }, this.stallCheckMs);
  stallTimer.unref();
}
				});
				try {
					const result = await Promise.race([handle.prompt(text), watchdog]);
					this.report({ phase: "prompt-complete", stage: this.stage, session: handle.ref.label, message: `${handle.ref.label}：执行完成` });
					return result;
				} finally {
					if (heartbeat) this.timers.clearInterval(heartbeat);
					if (timeoutTimer) this.timers.clearTimeout(timeoutTimer);
					if (stallTimer) this.timers.clearInterval(stallTimer);
				}
			},
		};
	}
}

export class ResearchService {
	private readonly options: ResearchServiceOptions;
	private readonly activeStageOperations = new Map<string, { root: string; runs: Array<{ stage: string; runId: string }> }>();
	private readonly activeGoalRuns = new Map<string, { root: string; runIds: Set<string> }>();

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
		for (const stage of ["M01", "M02", "M03", "M04", "M05", "M06", "M07", "M08", "M09"] as const) {
			const ids = await ws.listRuns(stage);
			const latest = ids.length ? await ws.readRun(stage, ids.at(-1)!) : undefined;
			stages[stage] = { count: ids.length, ...(latest ? { latest: summarizeRun(latest) } : {}) };
			if (stage === "M07" && latest) {
				try {
					const goal = JSON.parse(await readFile(path.join(ws.runDir("M07", latest.runId), "goal.json"), "utf8")) as CurrentGoal;
					Object.assign(stages.M07.latest!, { goalLifecycle: goal.lifecycle, ...summarizeGoalExecution(goal) });
				} catch { Object.assign(stages.M07.latest!, { goalStateError: "unreadable" as const }); }
			}
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
			limitations: [
				"断线或进程退出后的 running 任务不会自动重跑。",
				"取消会传给 Pi 会话；并非所有外部 HTTP 后端都支持即时取消。",
				"M08 completed 只表示整批成员均已返回，不表示科研结论通过或被 M04 采用。",
				"M09 不发布、不关闭 Pi，也不把 full-recomputation 请求表述为已完整复现。",
			],
		};
	}

	async runStage(request: StageRequest, signal?: AbortSignal): Promise<unknown> {
		const root = this.resolveWorkspace(request.workspace);
		return this.withMutation(root, async () => {
			const retryGuard = new RetryGuard(root);
			const fingerprint = stageFingerprint(request, await stageInputVersion(root, request));
			await retryGuard.assertAllowed(fingerprint);
			const ctx = await this.stageContext(root, request.stage, signal);
			let result: unknown;
			try { switch (request.stage) {
				case "M01": result = await runM01(ctx); break;
				case "M02": result = await runM02(ctx, { m01RunId: request.m01RunId }); break;
				case "M03": {
					const stage = await runM03(ctx, { m01RunId: request.m01RunId, m02RunId: request.m02RunId });
					result = request.processFeedback ? { stage, feedback: await runM04(ctx, { feedback: { kind: "M03", runId: stage.record.runId } }) } : stage;
					break;
				}
				case "M04": {
					if (request.feedbackCheckpointId !== undefined && (!request.feedbackCheckpointId || request.feedbackFile || request.feedbackStage !== "M07" || !request.feedbackRunId)) throw new HarnessError("m04.checkpoint", "feedbackCheckpointId 仅可与 M07 feedbackRunId 成对使用");
					const feedback = request.feedbackFile
						? { kind: "file" as const, label: request.feedbackLabel ?? path.basename(request.feedbackFile), path: path.resolve(root, request.feedbackFile) }
						: request.feedbackCheckpointId !== undefined
							? { kind: "M07Checkpoint" as const, runId: request.feedbackRunId!, checkpointId: request.feedbackCheckpointId }
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
				case "M08": {
					const stage = await runM08(ctx, {
						materials: request.materials ?? [], selfChecks: request.selfChecks ?? [], reviewers: request.reviewers ?? [],
						unprovidedScopes: request.unprovidedScopes, previousRunId: request.previousRunId,
						changeSummary: request.changeSummary, affectedScope: request.affectedScope,
					});
					if (request.processFeedback && (!stage.bundlePath || stage.record.status !== "completed")) throw new HarnessError("m08.feedback", "M08 审查批次未完整完成，不能转交 M04");
					result = request.processFeedback ? { stage, feedback: await runM04(ctx, { feedback: { kind: "M08", runId: stage.record.runId }, freshSession: true }) } : stage;
					break;
				}
				case "M09": {
					if (!request.m08RunId || !request.m04RunId || !request.recipient || !request.purpose || !request.deliveryScope || !request.reproduction) {
						throw new HarnessError("m09.input", "M09 需要明确 m08RunId、m04RunId、recipient、purpose、deliveryScope 与 reproduction");
					}
					result = await runM09(ctx, {
						m08RunId: request.m08RunId, m04RunId: request.m04RunId, recipient: request.recipient,
						purpose: request.purpose, deliveryScope: request.deliveryScope, reproduction: request.reproduction,
						closureRequested: request.closureRequested,
					});
					break;
				}
			} } catch (error) { await retryGuard.failure(fingerprint, thrownSignature(error)); throw error; }
			const signature = failureSignature(result);
			if (signature) await retryGuard.failure(fingerprint, signature); else await retryGuard.success(fingerprint);
			this.options.onProgress?.({ phase: "stage-complete", stage: request.stage, message: `${request.stage} 已完成；完成不等于科学判断已通过` });
			return result;
		}, request.stage);
	}

	/** Record a normal host shutdown only for the stage operation owned by this service instance. */
	async interruptActive(requested: string | undefined, reason: string): Promise<void> {
		const root = this.resolveWorkspace(requested);
		const key = await canonicalMutationKey(root);
		const active = this.activeStageOperations.get(key);
		if (!active) return;
		await this.interruptOwned(active, reason);
	}

	/** Interrupt every exact run registered by this service instance, regardless of Pi cwd. */
	async interruptAllActive(reason: string, includeActiveGoals = true): Promise<void> {
		for (const active of [...this.activeStageOperations.values()]) await this.interruptOwned(active, reason);
		if (includeActiveGoals === false) return;
		const goals = [...this.activeGoalRuns.values()];
		let firstError: unknown;
		for (const active of goals) {
			try { await this.interruptOwnedGoals(active, reason); }
			catch (error) { firstError ??= error; }
		}
		if (firstError) throw firstError;
	}

	private async interruptOwned(active: { root: string; runs: Array<{ stage: string; runId: string }> }, reason: string): Promise<void> {
		const ws = new Workspace(active.root);
		for (const owned of active.runs) {
			const run = await ws.readRun(owned.stage, owned.runId);
			if (run.status !== "running") continue;
			run.failures.push(`运行中断（host-shutdown）：${reason}`);
			run.remarks.push("由拥有本次活动操作的 Pi extension 依照已登记 runId 在正常 session_shutdown 路径记录；未自动重跑。SIGKILL 或进程崩溃不在此保证内。");
			await ws.finishRun(run, "failed");
			await ws.writeNote(run, "主 Pi 会话在阶段仍运行时正常关闭；harness 记录中断事实，没有把阶段标为完成，也没有自动重放。 ");
		}
	}

    private async interruptOwnedGoals(active: { root: string; runIds: Set<string> }, reason: string): Promise<void> {
        const ws = new Workspace(active.root);
        const controller = createM07Controller(await this.nonModelContext(active.root));
        let firstError: unknown;
        for (const runId of active.runIds) {
            try {
                const goal = await controller.status(runId);
                if (goal.executionState) await controller.hostSuspend(runId, { reasonKind: "session-shutdown" });
                else await controller.interrupt(runId, { reason, returnPath: "user" });
                await this.forgetActiveGoal(active.root, runId);
                if (goal.executionState) continue;
                try {
                    const archived = await ws.readRun("M07", runId);
                    const failure = "运行中断（host-shutdown）：" + reason;
                    if (archived.failures.includes(failure) === false) {
                        archived.failures.push(failure);
                        await ws.writeRun(archived);
                    }
                } catch {
                    // The controlled archive already closed the run; this is traceability only.
                }

            } catch (error) {
                firstError ??= error;
                // Never close only the run: that would leave an active goal paired with a failed run.
                // Keep this exact goal registered so a repair can inspect both persisted records.
            }
        }
        if (firstError) throw new HarnessError("m07.archive-repair-required", `M07 受控归档未完成；检查 goal.json 与 run.json 并修复后再继续：${firstError instanceof Error ? firstError.message : String(firstError)}`);
    }

    private async rememberActiveGoal(root: string, runId: string): Promise<void> {
        const key = await canonicalMutationKey(root);
        const active = this.activeGoalRuns.get(key) ?? { root: path.resolve(root), runIds: new Set<string>() };
        active.runIds.add(runId);
        this.activeGoalRuns.set(key, active);
    }

    private async forgetActiveGoal(root: string, runId: string): Promise<void> {
        const key = await canonicalMutationKey(root);
        const active = this.activeGoalRuns.get(key);
        if (active === undefined) return;
        active.runIds.delete(runId);
        if (active.runIds.size === 0) this.activeGoalRuns.delete(key);
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

	async goalAction(action: "begin" | "plan" | "checkpoint" | "decision" | "finish" | "interrupt", requested: string | undefined, input: BeginGoalInput | { runId: string; plan: string; refreshBaseline?: boolean; checkpointId?: string; m04RunId?: string } | { runId: string; taskIds?: string[] } | ({ runId: string } & DecisionInput) | ({ runId: string } & FinishInput) | ({ runId: string } & InterruptInput), signal?: AbortSignal, authority?: { executionContract: "continuous" }): Promise<unknown> {
		const root = this.resolveWorkspace(requested);
		return this.withMutation(root, async () => {
			const ctx = await this.nonModelContext(root);
			const controller = createM07Controller(ctx);
			if (action === "begin") {
				const value = await controller.begin(input as BeginGoalInput, authority);
				const runId = (value as { runId?: unknown } | undefined)?.runId;
				if (typeof runId === "string" && runId) await this.rememberActiveGoal(root, runId);
				return value;
			}
			if (action === "plan") { const value = input as { runId: string; plan: string; refreshBaseline?: boolean; checkpointId?: string; m04RunId?: string }; const result = await controller.plan(value.runId, value.plan, { refreshBaseline: value.refreshBaseline, checkpointId: value.checkpointId, m04RunId: value.m04RunId }); await this.rememberActiveGoal(root, value.runId); return result; }
			if (action === "checkpoint") { const value = input as { runId: string; taskIds?: string[] }; const result = await controller.checkpoint(value.runId, { taskIds: value.taskIds }); await this.rememberActiveGoal(root, value.runId); return result; }
			if (action === "decision") { const { runId, ...value } = input as { runId: string } & DecisionInput; const result = await controller.decision(runId, value); await this.rememberActiveGoal(root, runId); return result; }
			if (action === "interrupt") { const { runId, ...value } = input as { runId: string } & InterruptInput; const result = await controller.interrupt(runId, value); await this.forgetActiveGoal(root, runId); return result; }
			const { runId, ...value } = input as { runId: string } & FinishInput;
			const result = await controller.finish(runId, value);
			await this.forgetActiveGoal(root, runId);
			return result;
		});
	}

	/** Host-owned lifecycle stop. This is not registered as a model tool. */
	async hostInterrupt(input: { workspace: string; runId: string; reasonKind: HostStopReasonKind; sourceEventId?: string }): Promise<unknown> {
		const root = this.resolveWorkspace(input.workspace);
		return this.withMutation(root, async () => {
			const controller = createM07Controller(await this.nonModelContext(root));
			const result = await controller.hostInterrupt(input.runId, { reasonKind: input.reasonKind, sourceEventId: input.sourceEventId });
			await this.forgetActiveGoal(root, input.runId);
			return result;
		});
	}

	/** Host lifecycle suspension; the research goal and run remain open. */
	async hostSuspend(input: { workspace: string; runId: string; reasonKind: HostStopReasonKind; sourceEventId?: string }): Promise<unknown> {
		const root = this.resolveWorkspace(input.workspace);
		for (let attempt = 0; attempt < 100; attempt++) {
			try {
				return await this.withMutation(root, async () => {
					const controller = createM07Controller(await this.nonModelContext(root));
					const result = await controller.hostSuspend(input.runId, { reasonKind: input.reasonKind, sourceEventId: input.sourceEventId });
					await this.forgetActiveGoal(root, input.runId);
					return result;
				});
			} catch (error) {
				if (!(error instanceof HarnessError && error.code === "m07.busy")) throw error;
				await new Promise<void>((resolve) => setTimeout(resolve, 100));
			}
		}
		throw new HarnessError("m07.recovery", "宿主停止时仍有运行中 M07 操作；保留 active 状态，需由新实例核对旧进程与未决副作用");
	}

	/** Explicit fresh-Pi recovery; never resumes a prior child session. */
	async hostRecover(input: { workspace: string; runId: string; expectedAttemptId: string; runDescriptor: RunDescriptorV1 }): Promise<unknown> {
		const root = this.resolveWorkspace(input.workspace);
		return this.withMutation(root, async () => {
			const controller = createM07Controller(await this.nonModelContext(root));
			const result = await controller.hostRecover(input.runId, { expectedAttemptId: input.expectedAttemptId, runDescriptor: input.runDescriptor });
			await this.rememberActiveGoal(root, input.runId);
			return result;
		});
	}

	async delegate(runId: string, task: TaskSpecInput, requested?: string, signal?: AbortSignal): Promise<unknown> {
		const root = this.resolveWorkspace(requested);
		return this.withMutation(root, async () => {
			const value = await createM07Controller(await this.stageContext(root, "M07", signal)).delegate(runId, task);
			await this.rememberActiveGoal(root, runId);
			return value;
		});
	}

	async review(runId: string, review: TaskReviewInput, requested?: string, signal?: AbortSignal): Promise<unknown> {
		const root = this.resolveWorkspace(requested);
		return this.withMutation(root, async () => {
			const value = await createM07Controller(await this.nonModelContext(root)).review(runId, review);
			await this.rememberActiveGoal(root, runId);
			return value;
		});
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
		const originalStartRun = ws.startRun.bind(ws);
		ws.startRun = async (...args) => {
			const record = await originalStartRun(...args);
			const key = await canonicalMutationKey(root);
			this.activeStageOperations.get(key)?.runs.push({ stage: record.stage, runId: record.runId });
			return record;
		};
		if (!existsSync(ws.configFile)) throw new HarnessError("config.missing", `缺少 ${ws.configFile}；请明确配置各角色模型`);
		const store = createFileKnowledgeStore(ws.knowledgeDir);
		const base = this.options.runnerFactory?.(signal) ?? createPiSessionRunner({ signal });
		const runner = new ProgressRunner(base, (progress) => this.options.onProgress?.(progress), stage, this.options.progressIntervalMs ?? 15_000, this.options.promptTimeoutMs ?? 60 * 60_000, this.options.stallTimeoutMs ?? 10 * 60_000, this.options.stallCheckMs ?? 30_000, this.options.watchdogNow ?? Date.now, this.options.trustedPauseMs ?? readTrustedPauseMs, this.options.watchdogTimers);
		return { ws, store, runner, config: await ws.loadConfig() };
	}

	private async withMutation<T>(root: string, operation: () => Promise<T>, stage?: ResearchStage): Promise<T> {
		const key = await canonicalMutationKey(root);
		if (activeMutations.has(key)) throw new HarnessError("m07.busy", `工作区已有同步研究操作：${root}`);
		activeMutations.add(key);
		if (stage) this.activeStageOperations.set(key, { root: path.resolve(root), runs: [] });
		try { return await operation(); } finally { activeMutations.delete(key); this.activeStageOperations.delete(key); }
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
